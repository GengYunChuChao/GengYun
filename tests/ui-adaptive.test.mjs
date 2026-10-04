/**
 * GY-I26 界面可访问性与边界检查
 * ------------------------------------------------------------
 * 把任务书中能用脚本验证的部分固定下来：状态完整性、触控区尺寸、
 * 主题色、Tab 路由、录音与播放分离、游客拦截、替身边界。
 *
 * 不能由本文件覆盖的部分（需人工在微信开发者工具完成）：
 *   真机与模拟器编译、五 Tab 点击截图、系统大字���不遮挡走查。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const appJson = JSON.parse(read('miniprogram/app.json'));
const appWxss = read('miniprogram/app.wxss');
const stateJs = read('miniprogram/components/state-view/state-view.js');

/** 任务书要求的八种状态（ready 为正常态，不渲染状态视图） */
const REQUIRED_STATES = ['guest', 'empty', 'loading', 'error', 'cancelled', 'invalid', 'stub'];

/** 禁止出现的绝对化风险表述 */
const BANNED_PHRASES = ['绝对安全', '零风险', '保证无害', '百分百有效', '无副作用', '包治'];

const UI_FILES = [
  'miniprogram/app.wxss',
  'miniprogram/components/state-view/state-view.js',
  'miniprogram/components/state-view/state-view.wxml',
  'miniprogram/pages/home/home.wxml',
  'miniprogram/pages/identify/identify.wxml',
  'miniprogram/pages/community/community.wxml',
  'miniprogram/pages/messages/messages.wxml',
  'miniprogram/pages/profile/profile.wxml'
];

test('八种状态齐全，且每种都带图标、标题与说明', () => {
  const start = stateJs.indexOf('const PRESETS');
  const block = stateJs.slice(start, stateJs.indexOf('Component('));
  for (const status of REQUIRED_STATES) {
    const at = block.indexOf(`${status}: {`);
    assert.notEqual(at, -1, `缺少状态定义：${status}`);
    const segment = block.slice(at, block.indexOf('},', at));
    assert.ok(segment.includes('icon:'), `${status} 缺少图标`);
    assert.ok(segment.includes('title:'), `${status} 缺少标题`);
    assert.ok(segment.includes('desc:'), `${status} 缺少说明`);
  }
  assert.ok(block.includes('ready'), '缺少 ready 正常态定义');
});

test('触控区不小于 88rpx 等效 44px', () => {
  assert.ok(/--tap-min:\s*88rpx/.test(appWxss), '未定义 88rpx 触控区令牌');
  const btn = appWxss.slice(appWxss.indexOf('.btn {'), appWxss.indexOf('.btn--block'));
  assert.ok(/min-height:\s*var\(--tap-min/.test(btn), '.btn 未使用触控区令牌');
  const homeWxss = read('miniprogram/pages/home/home.wxss');
  assert.ok(/min-height:\s*var\(--tap-min/.test(homeWxss), '首页入口触控区不足');
});

test('主题绿为 #1F7A45，正文优先 18px 等效 36rpx', () => {
  assert.ok(/--color-primary:\s*#1F7A45/i.test(appWxss), '主题绿未使用 #1F7A45');
  assert.ok(/font-size:\s*36rpx/.test(appWxss), '正文字号未使用 36rpx');
  assert.equal(appJson.window.navigationBarBackgroundColor, '#1F7A45');
  assert.equal(appJson.tabBar.selectedColor, '#1F7A45');
});

test('五个 Tab 注册完整且均在页面列表中', () => {
  assert.equal(appJson.tabBar.list.length, 5);
  const names = appJson.tabBar.list.map((i) => i.text);
  assert.deepEqual(names, ['首页', '识别', '社区', '消息', '我的']);
  for (const item of appJson.tabBar.list) {
    assert.ok(appJson.pages.includes(item.pagePath), `${item.pagePath} 未注册为页面`);
  }
});

test('五个页面均注册统一状态组件', () => {
  for (const page of appJson.pages) {
    const cfg = JSON.parse(read(`miniprogram/${page}.json`));
    assert.ok(cfg.usingComponents && cfg.usingComponents['state-view'], `${page} 未注册 state-view`);
  }
});

test('录音与播放为两个独立按钮，播放需先有录音', () => {
  const wxml = read('miniprogram/pages/identify/identify.wxml');
  assert.ok(/bindtap="onRecord"/.test(wxml), '缺少独立录音按钮');
  assert.ok(/bindtap="onPlay"/.test(wxml), '缺少独立播放按钮');
  assert.ok(/disabled="\{\{guest \|\| !hasRecording\}\}"/.test(wxml), '播放按钮未在无录音时禁用');
  const js = read('miniprogram/pages/identify/identify.js');
  assert.ok(!/getRecorderManager|createInnerAudioContext/.test(js), '不应在未接入时调用录音或播放能力');
});

test('界面文案不含绝对化风险表述', () => {
  // 只扫描用户可见文案：WXML 去掉注释，状态文案取 PRESETS 块。
  // 样式表与代码注释里可以说明"禁止哪些词"，不作为文案检查对象。
  const visible = UI_FILES.filter((f) => f.endsWith('.wxml'))
    .map((f) => read(f).replace(/<!--[\s\S]*?-->/g, ''))
    .concat([stateJs.slice(stateJs.indexOf('const PRESETS'), stateJs.indexOf('Component('))])
    .join('\n');
  for (const phrase of BANNED_PHRASES) {
    assert.ok(!visible.includes(phrase), `界面文案出现禁止表述：${phrase}`);
  }
});

test('游客仅首页完全开放，其余页面拦截并提示登录', () => {
  const home = read('miniprogram/pages/home/home.wxml');
  assert.ok(home.includes('guest'), '首页未标识游客状态');
  for (const page of ['community', 'messages']) {
    const wxml = read(`miniprogram/pages/${page}/${page}.wxml`);
    assert.ok(/status="guest"/.test(wxml), `${page} 缺少游客拦截`);
  }
  for (const page of ['community', 'messages', 'profile']) {
    const js = read(`miniprogram/pages/${page}/${page}.js`);
    assert.ok(js.includes("utils/session"), `${page} 未按会话状态控制入口`);
  }
});

test('人工审核仅保留空入口，不展示任何已审核内容', () => {
  const wxml = read('miniprogram/pages/community/community.wxml');
  assert.ok(wxml.includes('人工审核'), '缺少人工审核说明');
  assert.ok(/建设中|尚未开放|不提供人工审核/.test(wxml), '未明确标注人工审核尚未开放');
  assert.ok(!/已审核通过|审核员|专家认证/.test(wxml), '不得出现已审核或专家认证的假内容');
});

test('替身边界：共享源码保持禁用网络', () => {
  const runtime = read('miniprogram/config/runtime.js');
  assert.ok(runtime.includes("mode: 'disabled'"), 'runtime 模式必须保持 disabled');
  assert.ok(runtime.includes("apiBaseUrl: ''"), '共享源码不得内置服务地址');
  const session = read('miniprogram/utils/session.js');
  assert.ok(!/wx\.login|getPhoneNumber/.test(session), '会话占位不得调用登录或手机号能力');
});

test('本任务未改动冻结契约与本地配置隔离规则', () => {
  let changed = [];
  try {
    changed = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    return; // 无远端基线时跳过，不影响其他断言
  }
  assert.ok(!changed.some((f) => f.startsWith('packages/contracts/')), '不得修改冻结契约');
  assert.ok(!changed.includes('miniprogram/config/runtime.js'), '不得修改共享运行配置');
  const ignore = read('.gitignore');
  assert.ok(ignore.includes('config.local.json'), '本地配置未被忽略');
});
