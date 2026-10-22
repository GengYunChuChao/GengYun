/**
 * 守卫：`tools/prepare-wechat.mjs` 生成的隔离工程里，**每一条** `usingComponents` 都必须解析到组件文件。
 *
 * 缺陷（GY-R32，2026-10 实测）：组件拷贝靠硬编码白名单，`components/fav-entry` 不在名单里，
 * `local` 产物缺该组件 ⇒ 微信开发者工具在项目级编译期报
 * `miniprogram/pages/identify/identify.json: ["usingComponents"]["fav-entry"]:
 * "/components/fav-entry/fav-entry"，在 <副本>/miniprogram/components/fav-entry/fav-entry 路径下未找到组件`
 * （throwError → innerCheckComponentPath → checkComponentPath → compilePageJSON）。
 * 错误指向组件缺失，很难联想到是打包脚本漏拷，因此这里**逐条核对副本里的引用**，不是只盯 fav-entry。
 *
 * 负控制分两层：
 *   ① 从已生成的副本里删掉 fav-entry ⇒ 本文件的断言必须红，并点名 identify 页与缺失文件；
 *   ② 源码里删掉 fav-entry.wxml ⇒ 脚本必须自己拒绝生成、点名组件，且不留下半成品目录。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），⛔ 不用 process.cwd()。 */
const REPO = resolve(import.meta.dirname, '../..');
/** 微信自定义组件的必需文件；`.wxss` 可选。 */
const REQUIRED_EXTS = ['.js', '.json', '.wxml'];
const scratch = [];

after(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

function compareReferences(left, right) {
  const a = left.from + '|' + left.name;
  const b = right.from + '|' + right.name;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 造一份**临时**工作副本（tools/ ＋ miniprogram/ ＋ project.config.json）。
 * 脚本产物固定写成 `<root>/.local/wechat-<mode>`，所以换 root 就能把产物关进 tmpdir，
 * 仓库里不会因为跑测试而出现 `.local`（也避开「已存在即拒绝」）。
 */
function scratchProject() {
  const directory = mkdtempSync(join(tmpdir(), 'gengyun-prepare-wechat-'));
  scratch.push(directory);
  cpSync(join(REPO, 'tools'), join(directory, 'tools'), { recursive: true });
  cpSync(join(REPO, 'miniprogram'), join(directory, 'miniprogram'), { recursive: true });
  cpSync(join(REPO, 'project.config.json'), join(directory, 'project.config.json'));
  return directory;
}

function localConfig(project) {
  const path = join(project, 'debug.local.json');
  writeFileSync(path, JSON.stringify({ mode: 'local', bindHost: '127.0.0.1', port: 4318, apiBaseUrl: 'http://127.0.0.1:4318' }));
  return path;
}

function prepare(project) {
  const result = spawnSync(process.execPath, [join(project, 'tools/prepare-wechat.mjs'), 'local', '--config', localConfig(project)], { encoding: 'utf8' });
  return { ...result, product: join(project, '.local/wechat-local'), copy: join(project, '.local/wechat-local/miniprogram') };
}

/**
 * 独立实现（刻意不复用 tools 里的函数）：扫出给定小程序目录里每一条 `usingComponents`。
 * `/` 开头相对小程序根，其余相对声明它的 JSON 所在目录（与微信同义）。
 */
function usingComponentReferences(miniprogramDirectory) {
  const references = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      const json = JSON.parse(readFileSync(path, 'utf8'));
      for (const [name, reference] of Object.entries(json.usingComponents ?? {})) {
        const base = reference.startsWith('/') ? resolve(miniprogramDirectory, reference.slice(1)) : resolve(dirname(path), reference);
        references.push({ from: relative(miniprogramDirectory, path).replaceAll('\\', '/'), name, reference, base });
      }
    }
  };
  visit(miniprogramDirectory);
  return references.sort(compareReferences);
}

/**
 * 断言：每一条引用都能解析到组件文件。逐条、逐必需文件累积缺口，
 * 失败文案点名「哪个页面 → 哪个组件 → 缺哪个文件」，不写成一句笼统的「组件缺失」。
 */
function assertEveryComponentResolvable(miniprogramDirectory) {
  const references = usingComponentReferences(miniprogramDirectory);
  assert.ok(references.length > 0, '副本里一条 usingComponents 都没扫到 ⇒ 扫描口径失效，逐条断言会空转');
  const gaps = [];
  for (const reference of references) {
    for (const ext of REQUIRED_EXTS) {
      if (!existsSync(reference.base + ext)) gaps.push(reference.from + ' -> ' + reference.name + '（' + reference.reference + '）缺 ' + ext);
    }
  }
  assert.deepEqual(gaps, [], '副本里每一条 usingComponents 都必须解析到组件文件');
  return references;
}

test('local 产物逐条解析 usingComponents，且与源码引用逐条同数', () => {
  const project = scratchProject();
  const repoProductBefore = existsSync(join(REPO, '.local/wechat-local'));
  const result = prepare(project);
  assert.equal(result.status, 0, result.stderr);
  const references = assertEveryComponentResolvable(result.copy);
  // 非空转：副本里的引用必须与源码逐条同数同项（漏拷页面 JSON 也会让这里红，不会被「文件少所以引用少」蒙混）。
  const sourceReferences = usingComponentReferences(join(project, 'miniprogram'));
  assert.deepEqual(
    references.map(reference => reference.from + ' ' + reference.name + ' ' + reference.reference),
    sourceReferences.map(reference => reference.from + ' ' + reference.name + ' ' + reference.reference),
    '副本里的 usingComponents 引用与源码清单不一致',
  );
  // 本缺陷的直接读数：identify 页引用的 fav-entry 四件套都在副本里。
  assert.ok(references.some(reference => reference.name === 'fav-entry'), 'fav-entry 引用消失了 ⇒ 本守卫的射程要重新评估，不能静默缩小');
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    assert.equal(existsSync(join(result.copy, 'components', 'fav-entry', 'fav-entry' + ext)), true, '副本缺 components/fav-entry/fav-entry' + ext);
  }
  // 产物只许落在临时目录：本用例不得在仓库里留下 .local。
  assert.equal(relative(tmpdir(), result.product).startsWith('..'), false, '产物落到了临时目录之外');
  assert.equal(existsSync(join(REPO, '.local/wechat-local')), repoProductBefore, '测试把副本落进了仓库');
});

test('负控制：副本里删掉 fav-entry ⇒ 逐条断言必须红并点名 identify 页与缺失文件', () => {
  const project = scratchProject();
  const result = prepare(project);
  assert.equal(result.status, 0, result.stderr);
  // 先证明守卫此刻是绿的：否则下面的红不能归因于「删掉了组件」。
  assertEveryComponentResolvable(result.copy);
  rmSync(join(result.copy, 'components/fav-entry'), { recursive: true, force: true });
  assert.throws(() => assertEveryComponentResolvable(result.copy), error => {
    assert.match(error.message, /pages\/identify\/identify\.json/, '失败文案必须点名引用页');
    assert.match(error.message, /fav-entry/, '失败文案必须点名缺失组件');
    assert.match(error.message, /缺 \.wxml/, '失败文案必须点名缺失文件');
    return true;
  });
});

test('负控制：源码缺 fav-entry.wxml ⇒ 脚本拒绝生成并点名，且不留下半成品目录', () => {
  const project = scratchProject();
  rmSync(join(project, 'miniprogram/components/fav-entry/fav-entry.wxml'));
  const result = prepare(project);
  assert.notEqual(result.status, 0, '组件不完整时不得生成副本');
  assert.match(result.stderr, /pages\/identify\/identify\.json/, '报错必须点名引用页');
  assert.match(result.stderr, /fav-entry/, '报错必须点名缺失组件');
  assert.match(result.stderr, /\.wxml/, '报错必须点名缺失文件');
  assert.equal(existsSync(join(project, '.local/wechat-local')), false, '组件校验必须在创建目录之前完成');
});
