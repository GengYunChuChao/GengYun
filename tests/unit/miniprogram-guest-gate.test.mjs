import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 用户端游客门禁的静态回归（Node 检查，**不是**微信编译器或真机验证）。
 * 五 Tab 骨架属 GY-I26；本项只加登录页与门禁接线。
 */
const root = resolve(import.meta.dirname, '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const app = JSON.parse(read('miniprogram/app.json'));

const TAB_PAGES = [
  'pages/home/home',
  'pages/identify/identify',
  'pages/community/community',
  'pages/messages/messages',
  'pages/profile/profile',
];

test('app.json：五个 Tab 页保留且已注册，登录页作为非 Tab 页注册', () => {
  assert.deepEqual(app.tabBar.list.map((x) => x.pagePath), TAB_PAGES);
  for (const page of TAB_PAGES) assert.ok(app.pages.includes(page), `Tab 页未注册：${page}`);
  assert.ok(app.pages.includes('pages/login/login'), '登录页应注册在 pages');
  assert.ok(!TAB_PAGES.includes('pages/login/login'), '登录页不应成为 Tab');
  assert.equal(app.pages[0], 'pages/home/home', '首页仍为入口（游客可预览）');
});

test('游客门禁：识别/社区/消息/我的接入 requireLogin，首页不拦截', () => {
  for (const page of ['identify', 'community', 'messages', 'profile']) {
    const source = read(`miniprogram/pages/${page}/${page}.js`);
    assert.match(source, /requireLogin\(\)/, `${page} 应调用 requireLogin()`);
  }
  assert.ok(!read('miniprogram/pages/home/home.js').includes('requireLogin()'), '首页不应拦截游客');
});

test('登录页齐备，且登录只走 wx.login + 服务端 /auth/wechat（客户端不声明身份）', () => {
  for (const suffix of ['.js', '.json', '.wxml']) {
    assert.ok(read(`miniprogram/pages/login/login${suffix}`).length > 0, `登录页缺少 ${suffix}`);
  }
  const auth = read('miniprogram/utils/auth.js');
  assert.match(auth, /wx\.login\(/);
  assert.match(auth, /\/auth\/wechat/);
  assert.match(auth, /Idempotency-Key/);
  assert.ok(!/openid\s*:/.test(auth), 'auth.js 不得向服务端声明 openid');
  assert.ok(!/\brole\s*:/.test(auth), 'auth.js 不得向服务端声明 role');
  assert.ok(!/user_id\s*:/.test(auth), 'auth.js 不得向服务端声明 user_id');
  assert.ok(!/app_secret|AppSecret/i.test(auth), 'auth.js 不得持有任何密钥');
});

test('共享源码联网未启用时不伪造登录（如实失败，不写假令牌）', () => {
  assert.match(read('miniprogram/config/runtime.js'), /mode: 'disabled'/);
  const auth = read('miniprogram/utils/auth.js');
  assert.match(auth, /networkEnabled/);
  assert.match(auth, /当前未启用联网/);
});
