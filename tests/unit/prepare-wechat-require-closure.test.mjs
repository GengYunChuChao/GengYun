/**
 * 守卫：`tools/prepare-wechat.mjs` 生成的副本里不能有悬空的相对 require。
 *
 * 背景（2026-11 实测）：`utils/time-format.js` 被 9 个页面与 `utils/history-api.js` 共 12 处 require，
 * 却不在 `files` 逐项清单里。复制阶段一声不响，副本在开发者工具里才 `MODULE_NOT_FOUND`；
 * 页面侧又用 try/catch 吞掉，最终只表现为「时间不显示」或「页面数据没装载」。
 *
 * 四条用例分别锁住：正向闭合、漏登记时当场失败、非相对 specifier 不误报、清单不被改回去。
 * 产物全部关在 tmpdir：仓库里不会因为跑测试出现 `.local`。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertRequireClosure } from '../../tools/lib/require-closure.mjs';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），⛔ 不用 process.cwd()。 */
const REPO = resolve(import.meta.dirname, '../..');
/** 演示基址：端口必须与配置里的 `port` 一致，否则 `readLocalConfig` 先一步拒绝。 */
const LOCAL_BASE = 'http://127.0.0.1:4318/api/v1';
const scratch = [];

after(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

/** 造一份临时工作副本：脚本产物固定写成 `<root>/.local/wechat-<mode>`，换 root 就关进 tmpdir。 */
function scratchProject() {
  const directory = mkdtempSync(join(tmpdir(), 'gengyun-prepare-wechat-closure-'));
  scratch.push(directory);
  cpSync(join(REPO, 'tools'), join(directory, 'tools'), { recursive: true });
  cpSync(join(REPO, 'miniprogram'), join(directory, 'miniprogram'), { recursive: true });
  cpSync(join(REPO, 'project.config.json'), join(directory, 'project.config.json'));
  return directory;
}

function localConfig(project) {
  const path = join(project, 'debug.local.json');
  writeFileSync(path, JSON.stringify({ mode: 'local', bindHost: '127.0.0.1', port: 4318, apiBaseUrl: LOCAL_BASE }));
  return path;
}

function run(project, args) {
  return spawnSync(process.execPath, [join(project, 'tools/prepare-wechat.mjs'), ...args], { encoding: 'utf8' });
}

const product = project => join(project, '.local/wechat-local');

/**
 * 测试自己的扫描器（刻意不复用 tools 里的实现）：递归所有 `.js`，只认 `./`／`../` 开头的
 * specifier，按 `base`、`base + '.js'`、`base/index.js` 三种候选判断是否存在。
 */
function scanRequires(copyRoot) {
  const files = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
    }
  };
  visit(copyRoot);

  const dangling = [];
  let requires = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      const specifier = match[2];
      if (!/^\.\.?\//.test(specifier)) continue;
      requires += 1;
      const base = resolve(dirname(file), specifier);
      if ([base, base + '.js', join(base, 'index.js')].some(existsSync)) continue;
      dangling.push({ file: relative(copyRoot, file).replaceAll('\\', '/'), specifier, resolved: base });
    }
  }
  return { scannedFiles: files.length, requires, dangling };
}

test('正向：生成副本相对 require 闭合，time-format.js 确实在副本里', () => {
  const project = scratchProject();
  const result = run(project, ['local', '--config', localConfig(project), '--no-urlcheck']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /相对 require 闭合/, '成功输出必须报告闭合检查结果');

  const copyRoot = product(project);
  assert.equal(existsSync(join(copyRoot, 'miniprogram/utils/time-format.js')), true, 'time-format.js 必须进入副本');
  const scan = scanRequires(copyRoot);
  assert.ok(scan.scannedFiles > 0, '扫描器必须真的扫到文件');
  assert.ok(scan.requires > 0, '扫描器必须真的扫到相对 require');
  assert.deepEqual(scan.dangling, [], '副本里不得有悬空的相对 require：' + JSON.stringify(scan.dangling));
});

test('负控制：源码树缺 time-format.js 时，生成当场失败并点名缺的文件', () => {
  const project = scratchProject();
  // 整树复制之后清单只做「这些必须在产物里」的断言、不再充当复制计划，
  // 所以负控制必须打真正的缺口：把源文件拿掉，让产物缺文件。
  // 只改临时工作副本；仓库里的 miniprogram/ 一个字都不动。
  const victim = join(project, 'miniprogram/utils/time-format.js');
  assert.equal(existsSync(victim), true, '临时副本里没有 time-format.js，负控制无法成立');
  rmSync(victim, { force: true });

  const result = run(project, ['local', '--config', localConfig(project), '--no-urlcheck']);
  assert.notEqual(result.status, 0, '源码树缺 time-format.js 时必须失败，而不是生成一个运行期才炸的副本');
  const output = result.stdout + result.stderr;
  assert.match(output, /打包清单里的文件没有进副本/, '报错必须点明「清单里的文件没有进副本」');
  assert.match(output, /utils\/time-format\.js/, '报错必须点名缺的那个文件');
});

test('不误报：非相对 specifier（wx、包名）不产生 dangling', () => {
  const project = scratchProject();
  const fixture = join(project, 'fixture');
  mkdirSync(fixture);
  writeFileSync(join(fixture, 'fixture.js'), [
    "const wx = require('wx');",
    "const packageName = require('some-package');",
    "const present = require('./present');",
    'module.exports = { wx, packageName, present };',
    '',
  ].join('\n'));
  writeFileSync(join(fixture, 'present.js'), 'module.exports = {};\n');

  const result = assertRequireClosure({ copyRoot: fixture, entries: ['fixture.js', 'present.js'] });
  assert.equal(result.scannedFiles, 2);
  assert.equal(result.requires, 1, '只应统计 ./present 这一条相对 require');
  assert.deepEqual(result.dangling, [], 'wx／包名不是相对 require，不得被误判为悬空');

  const scan = scanRequires(fixture);
  assert.equal(scan.requires, 1);
  assert.deepEqual(scan.dangling, [], '测试扫描器也必须跳过非相对 specifier');
});

test('清单一致性：仓库脚本仍登记 utils/time-format.js', () => {
  const source = readFileSync(join(REPO, 'tools/prepare-wechat.mjs'), 'utf8');
  assert.match(source, /'utils\/time-format\.js'/, '有人把 time-format 从 files 清单删回去了');
  assert.ok(
    source.indexOf("'utils/time-format.js'") > source.indexOf("'data/seed-control-timing.js'"),
    'time-format 应追加在既有清单末尾，避免牵动被文档锚点引用的行号',
  );
});
