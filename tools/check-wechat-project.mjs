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
assert.equal(project.libVersion, '3.17.3');
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
