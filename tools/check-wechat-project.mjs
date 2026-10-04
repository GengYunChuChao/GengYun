import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = file => JSON.parse(readFileSync(join(root, file), 'utf8'));
const project = readJSON('project.config.json');
assert.equal(project.compileType, 'miniprogram');
assert.equal(project.miniprogramRoot, 'miniprogram/');
assert.equal(project.appid, 'wx4407a4b908a69a54');
assert.equal(project.setting.urlCheck, true);
// 基础库锁定值须为开发者工具「详情 → 本地设置 → 调试基础库」中实际存在的版本。
// 原值 3.5.5 不在该列表内（工具 2.02.2609231 实测仅提供 3.6.6 / 3.6.2 / 3.5.8 / 3.5.2 /
// 3.4.10 / 3.4.3 / 3.3.5 / 3.2.5），锁定在不可选版本上会使任何编译验证都无法进行。
// 现取 3.5.x 系列唯一的非灰度正式版 3.5.8；实际模拟器运行版本为 3.17.3，
// 兼容起点仍待 GY-I02／GY-I25 以真机与双平台实测冻结，不以本断言替代兼容性结论。
assert.equal(project.libVersion, '3.5.8');
const app = readJSON('miniprogram/app.json');
assert.deepEqual(app.tabBar.list.map(x => x.text), ['首页', '识别', '社区', '消息', '我的']);
assert.deepEqual(app.pages, app.tabBar.list.map(x => x.pagePath));
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
