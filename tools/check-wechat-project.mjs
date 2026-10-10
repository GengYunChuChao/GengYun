import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = file => JSON.parse(readFileSync(join(root, file), 'utf8'));

// 共享源码必须保持域名校验开启（urlCheck=true）、固定基础库版本、且使用已公开的 AppID。
// 断言对「字段缺失（undefined）」与「取值错误」都失败：先判 typeof，再判值。
// 字段缺失时 typeof !== 'boolean' / !== 'string'，断言即失败，不会被 undefined 宽松放过。
function assertSharedProjectConfig(label, project) {
  assert.equal(project.compileType, 'miniprogram', `${label}: compileType 必须为 miniprogram`);
  assert.equal(project.appid, 'wx4407a4b908a69a54', `${label}: 必须使用已公开的共享 AppID`);
  assert.equal(typeof project.setting?.urlCheck, 'boolean', `${label}: setting.urlCheck 必须显式声明为布尔值（缺失/undefined 视为失败）`);
  assert.equal(project.setting.urlCheck, true, `${label}: setting.urlCheck 必须为 true（共享源码不得关闭域名校验）`);
  assert.equal(typeof project.libVersion, 'string', `${label}: libVersion 必须显式声明（缺失/undefined 视为失败）`);
  assert.equal(project.libVersion, '3.17.3', `${label}: libVersion 必须固定为 3.17.3，避免导入目录不同导致版本漂移`);
}

// 仓库根入口：导入根含 project.config.json，miniprogramRoot 指向 miniprogram/。
const project = readJSON('project.config.json');
assertSharedProjectConfig('project.config.json', project);
assert.equal(project.miniprogramRoot, 'miniprogram/', 'project.config.json: 根入口 miniprogramRoot 必须为 miniprogram/');

// miniprogram/ 子目录入口：微信开发者工具在 miniprogram/ 内打开项目时生成的工程配置。
// 与根入口共享同一份源码，必须保持同一口径（urlCheck/libVersion/appid），不得出现配置漂移。
const subProject = readJSON('miniprogram/project.config.json');
assertSharedProjectConfig('miniprogram/project.config.json', subProject);
assert.equal(subProject.compileType, 'miniprogram', 'miniprogram/project.config.json: compileType 必须为 miniprogram');
const app = readJSON('miniprogram/app.json');
assert.deepEqual(app.tabBar.list.map(x => x.text), ['首页', '识别', '社区', '消息', '我的']);
// 五个 Tab 页必须存在且必须注册在 pages 中；pages 允许额外注册非 Tab 页（如登录页）。
const tabPages = app.tabBar.list.map(x => x.pagePath);
for (const page of tabPages) assert.ok(app.pages.includes(page), `Tab 页未注册：${page}`);
for (const page of app.pages) {
  assert.match(page, /^pages\/[a-z]+\/[a-z]+$/);
  for (const suffix of ['.js', '.json', '.wxml']) assert.ok(existsSync(join(root, 'miniprogram', page + suffix)));
  readJSON('miniprogram/' + page + '.json');
}
readJSON('miniprogram/' + app.sitemapLocation);
assert.deepEqual(readJSON('project.private.config.json.example').setting.urlCheck, true);
function checkJS(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) checkJS(path);
    else if (path.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
  }
}
checkJS(join(root, 'miniprogram'));
const runtime = readFileSync(join(root, 'miniprogram/config/runtime.js'), 'utf8');
assert.match(runtime, /mode: 'disabled', apiBaseUrl: ''/);
console.log('PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.');
