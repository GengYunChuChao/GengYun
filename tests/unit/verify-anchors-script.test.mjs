/**
 * 本地校验入口 `npm run verify:anchors` 的守卫。
 *
 * 缺口（为什么需要这个文件）：`tools/verify-contract-status.mjs`（台账锚点 + 中文对照表）与
 * `tools/verify-doc-anchors.mjs`（文档手写行号）各自都能跑，但**没有一条命令同时跑它们**。
 * 于是「改完 `services/api/src/**`、写完证据页之后该跑什么」只活在口头约定里，实际结果是
 * 只剩 CI 上那一步 `node tools/verify-contract-status.mjs`，文档行号永远没人跑。
 *
 * 本文件只做**静态**断言：读 `package.json` 文本 + 断言工具文件存在非空。
 * ⛔ 刻意不 `spawn`：单测里跑子进程会把 `npm run test:unit` 拖慢（两次冷启动 + 台账 159KB 解析），
 * 而这里要钉的是「入口是否接线正确」，不是工具本身的行为——后者由
 * `tests/unit/doc-anchors-guard.test.mjs`（直接调 `main()`）与 CI 上的真实执行覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（tests/unit/ → ../..），⛔ 不用 `process.cwd()`（与仓内其它守卫同口径）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT_NAME = 'verify:anchors';
const CONTRACT_TOOL = 'tools/verify-contract-status.mjs';
const DOC_TOOL = 'tools/verify-doc-anchors.mjs';
const DEVELOPMENT_GUIDE = 'docs/development-guide.md';

/**
 * 本片之前就存在的脚本名（冻结，防止「新增一个」顺手删掉/改名某个既有入口）。
 * 只冻名字不冻内容：改命令文本是各 PR 的正常工作，删入口／改名才会让别处的 `npm run x` 断掉。
 */
const FROZEN_SCRIPT_NAMES = Object.freeze([
  'dev:api', 'dev:admin', 'build', 'lint', 'test:unit', 'test:contract', 'test:reference',
  'test:evaluation', 'test:integration:http', 'test:integration:recognition-chain-pg',
  'test:integration:conversations-pg', 'test:mini', 'test:docs', 'db:migrate',
  'purge:backup-copies', 'test:integration:backup-copies-purge-pg',
]);

function readPackageJson() {
  const absolute = join(REPO_ROOT, 'package.json');
  assert.ok(existsSync(absolute), `找不到 package.json（仓库根解析为 ${REPO_ROOT}）`);
  return JSON.parse(readFileSync(absolute, 'utf8'));
}

test('`verify:anchors` 存在，且串的就是那两个工具（台账不红 + 文档行号不新增）', () => {
  const script = readPackageJson().scripts?.[SCRIPT_NAME];
  assert.equal(typeof script, 'string', `package.json 缺 ${SCRIPT_NAME}：改完代码／证据页没有一条本地命令能自查`);
  assert.ok(script.includes(`node ${CONTRACT_TOOL}`), `${SCRIPT_NAME} 必须调用 ${CONTRACT_TOOL}（台账锚点与中文对照表）`);
  assert.ok(script.includes(`node ${DOC_TOOL} --strict`), `${SCRIPT_NAME} 必须以 --strict 调用 ${DOC_TOOL}（否则新增的文档假引用不会红）`);

  // 顺序：先台账后文档——台账覆盖面广且能给出改写建议，先跑它，文档行号的 diff 才容易读。
  assert.ok(
    script.indexOf(CONTRACT_TOOL) < script.indexOf(DOC_TOOL),
    `${SCRIPT_NAME} 里台账校验应排在文档行号之前，否则失败时先看到的是一堆行号漂移`,
  );
});

test('串联必须真串联：用 `&&`，不得用 `;`／`|| true`／`|` 把失败吞掉', () => {
  const script = readPackageJson().scripts?.[SCRIPT_NAME];
  assert.ok(script.includes('&&'), `${SCRIPT_NAME} 必须用 && 串联：用 ; 的话前一条红了后一条照跑，退出码只反映最后一条`);
  assert.doesNotMatch(script, /\|\||\|\s|;\s|^\s*;/, `${SCRIPT_NAME} 不得出现 || / 管道 / ;——那会把失败改成「通过」`);
  // 两个工具都不接受「无条件通过」开关，这条闸门也不许自带。
  for (const forbidden of ['--force', '--skip', '--allow-', '|| true', 'exit 0']) {
    assert.ok(!script.includes(forbidden), `${SCRIPT_NAME} 不得包含 ${forbidden}（会把未取得改写成通过）`);
  }
});

test('被调用的两个工具真实存在且非空', () => {
  for (const tool of [CONTRACT_TOOL, DOC_TOOL]) {
    const absolute = join(REPO_ROOT, tool);
    assert.ok(existsSync(absolute), `找不到 ${tool}`);
    assert.ok(statSync(absolute).size > 2000, `${tool} 小得可疑（${statSync(absolute).size} 字节）`);
  }
});

test('既有脚本一个都没少：本片只新增 `verify:anchors`', () => {
  const scripts = readPackageJson().scripts ?? {};
  const missing = FROZEN_SCRIPT_NAMES.filter(name => typeof scripts[name] !== 'string');
  assert.deepEqual(missing, [], '以下既有 npm 脚本不见了／被改名：只许新增 verify:anchors，不许动其它入口');
  assert.ok(Object.keys(scripts).length >= FROZEN_SCRIPT_NAMES.length + 1, '脚本总数对不上：新增入口被删或被合并');
});

test('开发指南里写明了这条入口（不然没人知道该跑它）', () => {
  const guide = readFileSync(join(REPO_ROOT, DEVELOPMENT_GUIDE), 'utf8');
  assert.ok(guide.includes(`npm run ${SCRIPT_NAME}`), `${DEVELOPMENT_GUIDE} 必须提到 npm run ${SCRIPT_NAME}，否则入口只活在本测试里`);
  // 口径一致：AGENTS.md 的台账锚点小节是流程的**唯一**长文，开发指南只做指针，不复制一遍。
  assert.match(guide, /AGENTS\.md/, `${DEVELOPMENT_GUIDE} 的说明应当指向 AGENTS.md 的台账锚点小节，而不是自说一套`);
});
