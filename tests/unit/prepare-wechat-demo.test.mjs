/**
 * 守卫：`tools/prepare-wechat.mjs` 的本机演示旗标（`--no-urlcheck` / `--force`）与基址校验。
 *
 * 演示时的三段真实痛点（2026-11 实跑）：
 *   ① 副本继承 `urlCheck: true` ⇒ 开发者工具必然报「不在以下 request 合法域名列表」，只能手动勾；
 *   ② `apiBaseUrl` 漏写业务前缀 `/api/v1` ⇒ 客户端把请求打到 `/auth/wechat` 得 404，而脚本一声不响；
 *   ③ 目标目录已存在直接拒绝 ⇒ 想重来必须先手动删目录。
 *
 * 本文件逐条锁住四件事：旗标只改**副本**（源文件按字节比对）、`--force` 覆盖且旧文件不残留、
 * 缺前缀时的可读报错且不留半成品、以及「不加旗标时行为与改前一致」的回归。
 * 产物全部关在 tmpdir：仓库里不会因为跑测试出现 `.local`（也避开「已存在即拒绝」）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），⛔ 不用 process.cwd()。 */
const REPO = resolve(import.meta.dirname, '../..');
/** 演示基址：端口必须与配置里的 `port` 一致，否则 `readLocalConfig` 先一步拒绝。 */
const LOCAL_ORIGIN = 'http://127.0.0.1:4318';
const LOCAL_BASE = LOCAL_ORIGIN + '/api/v1';
/** 共享工程两份 project.config.json 与共享 runtime.js：本脚本对它们只有读权限。 */
const SOURCE_FILES = ['project.config.json', 'miniprogram/project.config.json', 'miniprogram/config/runtime.js'];
const scratch = [];

after(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

/**
 * 造一份**临时**工作副本（tools/ ＋ miniprogram/ ＋ project.config.json）。
 * 脚本的产品固定写成 `<root>/.local/wechat-<mode>`，换 root 就把产物关进 tmpdir。
 */
function scratchProject() {
  const directory = mkdtempSync(join(tmpdir(), 'gengyun-prepare-wechat-demo-'));
  scratch.push(directory);
  cpSync(join(REPO, 'tools'), join(directory, 'tools'), { recursive: true });
  cpSync(join(REPO, 'miniprogram'), join(directory, 'miniprogram'), { recursive: true });
  cpSync(join(REPO, 'project.config.json'), join(directory, 'project.config.json'));
  return directory;
}

function localConfig(project, apiBaseUrl = LOCAL_BASE) {
  const path = join(project, 'debug.local.json');
  writeFileSync(path, JSON.stringify({ mode: 'local', bindHost: '127.0.0.1', port: 4318, apiBaseUrl }));
  return path;
}

function run(project, args) {
  return spawnSync(process.execPath, [join(project, 'tools/prepare-wechat.mjs'), ...args], { encoding: 'utf8' });
}

const product = project => join(project, '.local/wechat-local');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
/** 源文件字节快照：按 Buffer 比对，避免编码转换把差异吞掉。 */
const snapshot = project => Object.fromEntries(SOURCE_FILES.map(file => [file, readFileSync(join(project, file))]));

test('--no-urlcheck 只改副本：urlCheck=false，源 project.config.json 与共享 runtime.js 字节不变', () => {
  const project = scratchProject();
  const before = snapshot(project);
  const result = run(project, ['local', '--config', localConfig(project), '--no-urlcheck', '--force']);
  assert.equal(result.status, 0, result.stderr);

  const copySetting = readJson(join(product(project), 'project.config.json')).setting;
  assert.equal(copySetting.urlCheck, false, '副本必须写入 setting.urlCheck=false（否则开发者工具仍拦合法域名）');
  // 只放松域名校验：其余 setting 键与源逐条相同，不顺手改别的开关。
  assert.deepEqual({ ...copySetting, urlCheck: true }, readJson(join(project, 'project.config.json')).setting);

  // 源文件零改动：字节级比对（不是「看起来一样」）。
  for (const [file, bytes] of Object.entries(before)) {
    assert.deepEqual(readFileSync(join(project, file)), bytes, '本脚本改动了源文件：' + file);
  }
  // 副本 runtime 仍是 local 模式 + 完整业务前缀（`--no-urlcheck` 不碰 runtime）；
  // devTools:false 是演示口径：首页那组开发自检按钮在副本里收起（见 utils/debug.js）。
  assert.equal(
    readFileSync(join(product(project), 'miniprogram/config/runtime.js'), 'utf8'),
    'module.exports = {"mode":"local","apiBaseUrl":"' + LOCAL_BASE + '","devTools":false}\n',
  );
  // 产物只许落在临时目录：本用例不得在仓库里留下 .local。
  assert.equal(relative(tmpdir(), product(project)).startsWith('..'), false, '产物落到了临时目录之外');
});

test('--force 覆盖已存在的副本：先删旧目录再生成，陈旧文件不残留', () => {
  const project = scratchProject();
  const config = localConfig(project);
  assert.equal(run(project, ['local', '--config', config]).status, 0);

  const stale = join(product(project), 'stale-marker.txt');
  writeFileSync(stale, 'old copy');
  // 回归：没有 --force 时仍必须拒绝覆盖（旧行为不变），且不得动旧目录。
  const refused = run(project, ['local', '--config', config]);
  assert.notEqual(refused.status, 0, '没有 --force 时必须继续拒绝覆盖');
  assert.match(refused.stderr, /already exists/i);
  assert.equal(existsSync(stale), true, '拒绝覆盖时不得改动旧副本');

  const forced = run(project, ['local', '--config', config, '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /已删除旧副本/, '覆盖时必须明说删了旧副本，不能静默重建');
  assert.equal(existsSync(stale), false, '--force 必须先删掉旧目录：陈旧文件不得残留进新副本');
  assert.equal(existsSync(join(product(project), 'project.config.json')), true, '重建后副本必须完整');
});

test('apiBaseUrl 缺 /api/v1 前缀：直接失败并给出应写的值，不静默补全、不留半成品', () => {
  const project = scratchProject();
  const result = run(project, ['local', '--config', localConfig(project, LOCAL_ORIGIN)]);
  assert.notEqual(result.status, 0, '缺业务前缀时必须失败（否则客户端打到 /auth/wechat 得 404）');
  assert.match(result.stderr, /\/api\/v1/, '报错必须点名业务前缀');
  assert.match(result.stderr, new RegExp(LOCAL_BASE.replaceAll('.', '\\.')), '报错必须给出应写的完整基址');
  assert.match(result.stderr, /未生成任何目录/, '报错必须说明没有留下半成品');
  assert.equal(existsSync(product(project)), false, '基址非法时不得创建副本目录');
  // 不静默补全：既不建目录，也不会写出一个「被修好」的 runtime.js。
  assert.equal(existsSync(join(project, '.local')), false, '基址非法时 .local 都不该出现');
});

test('回归：不加旗标时行为与改前一致（urlCheck=true、runtime 走 local、已存在即拒绝）', () => {
  const project = scratchProject();
  const config = localConfig(project);
  const result = run(project, ['local', '--config', config]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(join(product(project), 'project.config.json')).setting.urlCheck, true, '默认必须保持域名校验开启');
  assert.equal(
    readFileSync(join(product(project), 'miniprogram/config/runtime.js'), 'utf8'),
    'module.exports = {"mode":"local","apiBaseUrl":"' + LOCAL_BASE + '","devTools":false}\n',
  );
  const again = run(project, ['local', '--config', config]);
  assert.notEqual(again.status, 0, '默认仍拒绝复用已存在的目录');
});

test('旗标自身的边界：--help 不生成目录、release 拒绝 --no-urlcheck、旗标不接受取值', () => {
  const project = scratchProject();
  const help = run(project, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--no-urlcheck/);
  assert.match(help.stdout, /--force/);
  assert.match(help.stdout, /仅供本机演示/, '--help 必须写清「仅供本机演示/测试号」');
  assert.equal(existsSync(join(project, '.local')), false, '--help 不得产生任何目录');

  const release = run(project, ['release', '--no-urlcheck']);
  assert.notEqual(release.status, 0, 'release 副本必须保持 urlCheck=true');
  assert.match(release.stderr, /release 不接受 --no-urlcheck/);

  const equalForm = run(project, ['local', '--config', localConfig(project), '--no-urlcheck=true']);
  assert.notEqual(equalForm.status, 0);
  assert.match(equalForm.stderr, /不接受取值/);
});
