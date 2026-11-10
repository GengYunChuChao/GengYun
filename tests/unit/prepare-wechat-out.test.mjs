/**
 * 守卫：`tools/prepare-wechat.mjs` 的 `--out`（副本生成到仓库外）与**整树复制**。
 *
 * 两件事在这里被钉死：
 *   ① 输出位置。默认仍是 `<root>/.local/wechat-<mode>`；`--out` 只换根、目录名不变；
 *      落在仓库树内必须 exit 2 且一个目录都不建——副本里的 `miniprogram/**` 与仓库同名文件并存，
 *      `verify-doc-anchors --strict --scan docs` 会把单义锚点判成多义（本机实测过一次假红）。
 *   ② 复制完整性。清单不再是复制计划：2026-11 实测清单漏了 `utils/time-format.js` 与
 *      `utils/session.js`（GY-R92 新增），科普/社区/消息/收藏/识别历史五条动线在副本里
 *      `MODULE_NOT_FOUND`，又被 `knowledge-api.js` 吞成「资料服务暂不可用，已清空，请重试。」。
 *      现在整树复制，清单只做「必须存在」断言 ⇒ 新增 utils 文件不会再漏。
 *
 * 夹具沿用 `prepare-wechat-components.test.mjs` 的办法：把 tools/ ＋ miniprogram/ ＋
 * project.config.json 复制进 tmpdir 再跑脚本（root 由脚本自身位置推出），
 * 所以默认产物天然落在临时目录里，仓库不会出现 `.local`。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），⛔ 不用 process.cwd()。 */
const REPO = resolve(import.meta.dirname, '../..');
/** 真仓那份脚本：用于「`--out` 落在真仓库树内」这一条（拒绝发生在读源工程之前，不需要夹具）。 */
const TOOL = join(REPO, 'tools/prepare-wechat.mjs');
/** 整树复制会跳过的目录名（与脚本里的 COPY_EXCLUDED_DIRS 同义；这里是独立实现，不 import 被测代码）。 */
const SKIPPED_DIRS = new Set(['.local', 'node_modules']);
const scratch = [];

after(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

function scratchDir(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

/** 造一份临时工程：脚本按自身位置找 root，于是 `<tmp>/.local/wechat-local` 就是默认产物。 */
function scratchProject() {
  const directory = scratchDir('gengyun-prepare-out-');
  cpSync(join(REPO, 'tools'), join(directory, 'tools'), { recursive: true });
  cpSync(join(REPO, 'miniprogram'), join(directory, 'miniprogram'), { recursive: true });
  cpSync(join(REPO, 'project.config.json'), join(directory, 'project.config.json'));
  return directory;
}

function localConfig(project) {
  const path = join(project, 'debug.local.json');
  writeFileSync(path, JSON.stringify({ mode: 'local', bindHost: '127.0.0.1', port: 38110, apiBaseUrl: 'http://127.0.0.1:38110/api/v1' }));
  return path;
}

function run(tool, project, extra = []) {
  return spawnSync(process.execPath, [tool, 'local', '--config', localConfig(project), ...extra], { encoding: 'utf8' });
}

/** 脚本会把绝对路径原样打在 `LOCAL import root: ` 之后；按行比对，别拿正则去拼 Windows 反斜杠。 */
function importRootLine(stdout) {
  const line = stdout.split(/\r?\n/u).reverse().find(candidate => candidate.startsWith('LOCAL import root: '));
  return line === undefined ? null : line.slice('LOCAL import root: '.length).trim();
}

/** 扫一棵树的相对路径集合（`/` 分隔），跳过 SKIPPED_DIRS 与 `*.local.json`——与脚本同一口径。 */
function listFiles(directory) {
  const files = new Set();
  const visit = relativeDir => {
    for (const entry of readdirSync(join(directory, relativeDir), { withFileTypes: true })) {
      const path = relativeDir === '' ? entry.name : join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) visit(path);
        continue;
      }
      if (entry.name.endsWith('.local.json')) continue;
      files.add(path.split(sep).join('/'));
    }
  };
  visit('');
  return files;
}

test('默认位置不变：不加 --out 时产物仍是 <root>/.local/wechat-local', () => {
  const project = scratchProject();
  const result = run(join(project, 'tools/prepare-wechat.mjs'), project);
  assert.equal(result.status, 0, result.stderr);
  const product = join(project, '.local/wechat-local');
  assert.equal(importRootLine(result.stdout), product, 'LOCAL import root 必须就是产物目录');
  assert.equal(existsSync(join(product, 'miniprogram/app.js')), true);
});

test('--out 让副本落在仓库外，并原样打印真实路径', () => {
  const project = scratchProject();
  const outside = join(scratchDir('gengyun-out-root-'), 'demo-project');
  const result = run(join(project, 'tools/prepare-wechat.mjs'), project, ['--out', outside]);
  assert.equal(result.status, 0, result.stderr);
  const product = join(outside, 'wechat-local');
  assert.equal(importRootLine(result.stdout), product, '打印的必须是 --out 下的真实路径，不是默认路径');
  assert.equal(existsSync(join(product, 'miniprogram/app.js')), true);
  assert.equal(existsSync(join(project, '.local/wechat-local')), false, '给了 --out 就不该再往 <root>/.local 写');
});

test('--out 落在仓库树内 ⇒ exit 2 且不建任何目录', () => {
  const before = existsSync(join(REPO, '.local/wechat-local'));
  // 真仓那份脚本 + 真仓路径：拒绝发生在读源工程之前，所以不需要夹具、也不会留下半成品。
  const result = spawnSync(process.execPath, [TOOL, 'local', '--config', join(REPO, 'config/debug.local.json.example'), '--out', join(REPO, '.local')], { encoding: 'utf8' });
  assert.equal(result.status, 2, '仓库内路径是参数错误，退出码必须是 2（与解析/缺键同一档），不是 1');
  assert.match(result.stderr, /副本留在仓库树内会让文档锚点闸门把重复的 miniprogram 当目标（假红）/, '报错要点名后果，否则下一个人只会觉得是洁癖');
  assert.match(result.stderr, /未生成任何目录/);
  assert.equal(existsSync(join(REPO, '.local/wechat-local')), before, '被拒绝时一个目录都不许建');

  // 夹具内也一样：判据是「在 root 之内」，与是否真仓库无关。
  const project = scratchProject();
  const inside = run(join(project, 'tools/prepare-wechat.mjs'), project, ['--out', join(project, 'demo-project')]);
  assert.equal(inside.status, 2, inside.stderr);
  assert.equal(existsSync(join(project, 'demo-project')), false);
});

test('目标已存在 ⇒ 拒绝覆盖；--force 才重建（只删这一个目录）', () => {
  const project = scratchProject();
  const outside = join(scratchDir('gengyun-out-force-'), 'demo-project');
  const tool = join(project, 'tools/prepare-wechat.mjs');
  assert.equal(run(tool, project, ['--out', outside]).status, 0);
  const kept = join(outside, 'wechat-local', 'miniprogram/app.js');
  writeFileSync(kept, '// 旧副本的痕迹：没加 --force 时不许被清掉\n');

  const second = run(tool, project, ['--out', outside]);
  assert.equal(second.status, 1, '已存在时必须是失败退出，不能静默重建');
  assert.match(second.stderr, /Output already exists/);
  assert.equal(readFileSync(kept, 'utf8'), '// 旧副本的痕迹：没加 --force 时不许被清掉\n', '被拒绝时旧副本一个字节都不许动');

  const forced = run(tool, project, ['--out', outside, '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /已删除旧副本/, '覆盖时必须明说删了旧副本');
  assert.doesNotMatch(readFileSync(kept, 'utf8'), /旧副本的痕迹/, '--force 之后必须是重新生成的干净副本');
});

test('--dry-run 只说会生成到哪，不建目录、不落盘', () => {
  const project = scratchProject();
  const outside = join(scratchDir('gengyun-out-dry-'), 'demo-project');
  const result = run(join(project, 'tools/prepare-wechat.mjs'), project, ['--out', outside, '--dry-run']);
  assert.equal(result.status, 0, '校验通过就是 0：dry-run 不是失败');
  assert.equal(importRootLine(result.stdout), join(outside, 'wechat-local'));
  assert.equal(existsSync(outside), false, 'dry-run 连根目录都不许建');
  // 仓内路径在 dry-run 下同样要拒（先判位置，再谈别的）。
  const rejected = run(join(project, 'tools/prepare-wechat.mjs'), project, ['--out', join(project, 'inner'), '--dry-run']);
  assert.equal(rejected.status, 2, rejected.stderr);
});

test('整树复制：源码每个文件都进副本（清单漏项不再可能）', () => {
  const project = scratchProject();
  const outside = join(scratchDir('gengyun-out-tree-'), 'demo-project');
  const result = run(join(project, 'tools/prepare-wechat.mjs'), project, ['--out', outside]);
  assert.equal(result.status, 0, result.stderr);
  const copy = join(outside, 'wechat-local', 'miniprogram');
  const source = listFiles(join(project, 'miniprogram'));
  const packed = listFiles(copy);
  const missing = [...source].filter(file => !packed.has(file)).sort();
  assert.deepEqual(missing, [], '副本必须与源码逐文件对齐：漏一个就是运行时 MODULE_NOT_FOUND');
  // 本缺陷的直接读数：这两个 2026-11 新增的 utils 文件曾在清单外，五条动线因此全挂。
  for (const file of ['utils/time-format.js', 'utils/session.js']) {
    assert.equal(source.has(file), true, file + ' 不在源码里了 ⇒ 这条回归的射程要重新评估，不能静默缩小');
    assert.equal(packed.has(file), true, '副本缺 ' + file + '：科普/社区/消息/收藏/识别历史会一起 MODULE_NOT_FOUND');
  }
  // 副本是「隔离工程」而不是源码镜像：runtime.js 必须被改写成 local（否则客户端根本没接本地 API）。
  const runtime = JSON.parse(readFileSync(join(copy, 'config/runtime.js'), 'utf8').split('= ')[1]);
  assert.equal(runtime.mode, 'local');
  assert.equal(runtime.apiBaseUrl, 'http://127.0.0.1:38110/api/v1');
  // 产物整体还在仓库外（相对路径不含 `..` 才是仓库内）。
  assert.equal(relative(tmpdir(), copy).startsWith('..'), false);
});
