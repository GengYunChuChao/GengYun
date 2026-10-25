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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const appJson = JSON.parse(read('miniprogram/app.json'));
// GY-I26 检查五 Tab；main 的独立登录页另由登录与门禁回归验证。
const TAB_PAGES = appJson.tabBar.list.map((item) => item.pagePath);
const appJs = read('miniprogram/app.js');
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

/**
 * GY-I26 demo 对齐后的样式层（app.wxss 通过 @import 引用）。
 * 门槛检查必须覆盖它们，否则把字号/触控区挪进样式层就能绕过断言。
 */
const STYLE_LAYER_FILES = [
  'miniprogram/styles/tokens.wxss',
  'miniprogram/styles/icons.wxss',
  'miniprogram/styles/components.wxss'
];
const styleLayer = STYLE_LAYER_FILES.map(read).join('\n');

/**
 * 允许承载按钮语义的样式层类。
 * demo 的 .feature-card／.info-row／.tabs button／.chip／.message-row／.setting-row／
 * .topic／.post-text／.post-actions button／.stat／.timeline-item 本身就是按钮，
 * 强制它们套 .btn 会破坏 demo 形态；改为要求「类在样式层声明了 ≥44px 触控下限」，
 * 由 tests/ui-demo-align.test.mjs 逐类核对 min-height，等价性不减。
 */
const TAPPABLE = [
  'btn', 'feature-card', 'info-row', 'tabs__item', 'chip', 'message-row', 'setting-row',
  'text-btn', 'topic', 'post-text', 'post-actions__item', 'stat', 'timeline-item'
];

/** 取出 <button ...> 的 class 列表 */
const buttonClasses = (tag) => {
  const m = tag.match(/class="([^"]*)"/);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
};
/** 按钮须带 .btn，或带一个已在样式层声明触控下限的 demo 组件类 */
const hasButtonStyle = (tag) => buttonClasses(tag).some((c) => TAPPABLE.includes(c));

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

test('触控区为 44px 且使用 px 单位，320px 窄屏下仍成立', () => {
  assert.ok(/--tap-min:\s*max\(44px/.test(appWxss), '触控区令牌必须为 max(44px, ...) 形式');
  // rpx 为屏宽 750 等分：88rpx 仅在 375px 视口等于 44px，320px 视口只有约 37.55px，不满足门槛
  assert.ok(!/--tap-min:\s*[\d.]+rpx/.test(appWxss), '触控区不得使用 rpx，窄屏会缩水至 44px以下');
  const btn = appWxss.slice(appWxss.indexOf('.btn {'), appWxss.indexOf('.btn--block'));
  assert.ok(/min-height:\s*var\(--tap-min\)/.test(btn), '.btn 未使用触控区令牌');
  // .btn 需保留上下内边距：字号放大后文字可能换行，min-height 只作下限。
  // 具体数值取 demo .btn 的 11px 18px（不锁死常量，只要求纵向内边距为正）。
  const btnPad = btn.match(/padding:\s*(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px/);
  assert.ok(btnPad && Number(btnPad[1]) > 0, '.btn 缺纵向内边距，字号放大后文字换行会溢出门面');
  assert.ok(!/padding:\s*0\s+16rpx/.test(read('miniprogram/pages/identify/identify.wxss')), 'voice-btn 覆盖了 .btn 的上下内边距');
  // 首页入口与样式层的可点组件必须在样式层声明触控下限（页面样式文件不再各写一套）
  assert.ok(/min-height:\s*var\(--tap-min/.test(styleLayer), '样式层可点组件缺少触控区令牌');
  assert.ok(!/var\(--tap-min,\s*[\d.]+rpx\)/.test(styleLayer), '触控区令牌 fallback 不得为 rpx');
});

test('正文为 18px 且不随屏宽缩放', () => {
  const root = appWxss.slice(0, appWxss.indexOf('/* ============================ 布局'));
  assert.ok(/font-size:\s*calc\(18px\s*\*\s*var\(--font-scale/.test(root), '正文未使用 18px 且未乘字体缩放');
  // 36rpx 在 375px 视口等于 18px，但 320px 视口只有 15.36px，低于 18px 正文门槛
  assert.ok(!/font-size:\s*36rpx/.test(root), '正文不得使用 36rpx，窄屏会缩至 18px 以下');
});

test('主题色采用 docs/ui-demo 的设计令牌（色板冲突已披露，待监工裁定）', () => {
  // 【冲突披露】docs/implementation-requirements.md:402 写「主题绿 #1F7A45，知识类绿 #2E9E5B」，
  // 而 docs/ui-demo/dist/styles.css:1 的 :root 写 --green:#176b50。用户 2026-10-14 指令
  // 「前端页面务必先做到 demo.html 所演示的样式，优先做好」，故本片采用 demo 值，
  // 冲突交由监工裁定：若判回 #1F7A45，只需改 styles/tokens.wxss 的 --green/--color-primary
  // 与 app.json 的两处颜色，本断言随之回退。
  const tokensWxss = read('miniprogram/styles/tokens.wxss');
  const demoGreen = /--green:\s*#176b50/i.test(tokensWxss);
  assert.ok(demoGreen, '样式层未采用 demo 的主题绿 #176b50');
  assert.ok(/--color-primary:\s*#176b50/i.test(tokensWxss), '--color-primary 别名未指向 demo 主题绿');
  assert.equal(appJson.window.navigationBarBackgroundColor, '#176b50');
  assert.equal(appJson.tabBar.selectedColor, '#176b50');
});

test('样式层逐值复现 demo 的 :root 色板', () => {
  // 与 tools/demo-align.mjs 的机检同源：这里锁住不依赖工具的独立断言
  const tokensWxss = read('miniprogram/styles/tokens.wxss');
  for (const token of ['--green: #176b50', '--ink: #17352b', '--muted: #7b8983', '--paper: #f5f7f4', '--line: #e5ebe5', '--lime: #c6f17b']) {
    assert.ok(tokensWxss.toLowerCase().includes(token), `样式层缺少 demo 令牌 ${token}`);
  }
});

test('五个 Tab 注册完整且均在页面列表中', () => {
  assert.equal(appJson.tabBar.list.length, 5);
  const names = appJson.tabBar.list.map((i) => i.text);
  assert.deepEqual(names, ['首页', '社区', '识别', '消息', '我的']);
  for (const item of appJson.tabBar.list) {
    assert.ok(appJson.pages.includes(item.pagePath), `${item.pagePath} 未注册为页面`);
  }
});

test('字号适配：微信设置回落、应用内开关、标签容器不溢出', () => {
  // 标签类容器：文字在字号放大后会换行，须能自然撑高而不溢出圆角
  const heroWxss = read('miniprogram/pages/home/home.wxss');
  const heroBadge = heroWxss.slice(heroWxss.indexOf('.hero__badge'), heroWxss.indexOf('}', heroWxss.indexOf('.hero__badge')));
  assert.ok(/min-height:\s*calc\(26px\s*\*\s*var\(--font-scale/.test(heroBadge), '.hero__badge 高度未随字体放大');
  assert.ok(!/padding:\s*0\s+22rpx/.test(heroBadge), '.hero__badge 上下无内边距，换行会溢出圆角框');

  // 普通视口回归：右侧装饰不能把 eyebrow 压成孤字；游客标记增高后，
  // 英文口号仍须在文档流中跟随主按钮，不能绝对定位叠到按钮上。
  const heroContent = heroWxss.slice(heroWxss.indexOf('.hero__content'), heroWxss.indexOf('}', heroWxss.indexOf('.hero__content')));
  assert.match(heroContent, /width:\s*100%/, '首页 Hero 正文仍被右侧装饰压缩，eyebrow 会出现孤字');
  const heroCode = heroWxss.slice(heroWxss.indexOf('.hero__code'), heroWxss.indexOf('}', heroWxss.indexOf('.hero__code')));
  assert.match(heroCode, /position:\s*static/, '英文口号必须留在文档流中，避免覆盖主按钮');
  assert.match(heroCode, /margin-top:\s*16px/, '英文口号与主按钮之间缺少稳定间距');
  assert.doesNotMatch(heroCode, /(?:right|bottom):/, '英文口号不得再用绝对定位坐标参与布局');

  const badgeStart = appWxss.indexOf(String.fromCharCode(10) + '.badge {');
  const badge = appWxss.slice(badgeStart, appWxss.indexOf('}', badgeStart));
  assert.ok(/min-height:\s*calc\(24px\s*\*\s*var\(--font-scale/.test(badge), '.badge 高度未随字体放大');
  assert.ok(!/padding:\s*0\s+20rpx/.test(badge), '.badge 上下无内边距，换行会溢出');

  // 字号来源：只跟随微信设置，需求未要求应用内开关
  const fs = read('miniprogram/utils/font-scale.js');
  assert.ok(/function applyFontScale/.test(fs), 'font-scale.js 缺少注入能力');
  assert.ok(/function currentFontScale/.test(fs), 'font-scale.js 缺少读取能力');
  assert.ok(
    /function readFontScale\(\)\s*\{\s*return systemFont\.readSystemScale\(\)/.test(appJs),
    'app.js 必须直接采用微信设置换算结果'
  );

  const profileJs = read('miniprogram/pages/profile/profile.js');
  const profileWxml = read('miniprogram/pages/profile/profile.wxml');
  assert.ok(/fontScale\.applyFontScale\(this\)/.test(profileJs), '我的页面未刷新字号');
  assert.ok(!/font-choice/.test(profileWxml), '不得残留应用内档位 UI');

  // 切换页面后字号必须立即生效：页面复用时 onLoad 不再执行，须由 onShow 刷新
  for (const page of TAB_PAGES) {
    const js = read('miniprogram/' + page + '.js');
    assert.ok(/onShow/.test(js), page + ' 缺少 onShow，无法在切页时刷新字号');
    assert.ok(/currentFontScale|applyFontScale/.test(js), page + ' 的 onShow 未刷新字号，切页会回退');
  }

  for (const page of TAB_PAGES) {
    const cfg = JSON.parse(read(`miniprogram/${page}.json`));
    assert.ok(cfg.usingComponents && cfg.usingComponents['state-view'], `${page} 未注册 state-view`);
  }
});

test('五个页面均注册统一状态组件', () => {
  for (const page of TAB_PAGES) {
    const cfg = JSON.parse(read('miniprogram/' + page + '.json'));
    assert.ok(cfg.usingComponents && cfg.usingComponents['state-view'], page + ' 未注册 state-view');
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

test('适配微信字体设置：读取 fontSizeSetting 并封顶，页面根节点注入缩放变量', () => {
  const appJs = read('miniprogram/app.js');
  const sysFont = read('miniprogram/utils/system-font.js');
  // 字段读取与换算已抽到 utils/system-font.js（设置界面需绕过存储强制走该路径）
  assert.ok(/fontSizeSetting/.test(sysFont), 'system-font.js 未读取 fontSizeSetting');
  assert.ok(/fontSizeScaleFactor/.test(sysFont), '未优先读取 fontSizeScaleFactor 比例字段');
  assert.ok(/BASE_FONT_SIZE_PX\s*=\s*16/.test(sysFont), 'px 换算基准应为 16');
  assert.ok(/MAX_FONT_SCALE\s*=\s*1\.3/.test(sysFont), '缩放系数未封顶 1.3');
  assert.ok(/systemFont\.MAX_FONT_SCALE/.test(appJs), 'app.js 未复用 system-font 的封顶值');
  assert.ok(/globalData[\s\S]*fontScale/.test(appJs), 'globalData 未暴露 fontScale');

  // 字号必须乘以缩放变量，否则微信字体设置对 px 无效（需求 4.1）。
  // 检查范围含 GY-I26 新增的 styles/*.wxss，避免把字号挪出 app.wxss 就绕过断言。
  // 注释里引用的 demo 原值不算实际声明，先剥掉 CSS 注释再匹配。
  const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const file of ['miniprogram/app.wxss', ...STYLE_LAYER_FILES]) {
    const sizes = stripComments(read(file)).match(/font-size:\s*(\d+)px/g) || [];
    assert.equal(sizes.length, 0, `${file} 仍有未乘缩放系数的 px 字号：${sizes.join(', ')}`);
  }
  assert.ok(/font-size:\s*calc\(\d+px\s*\*\s*var\(--font-scale/.test(appWxss), '正文字号未乘 --font-scale');
  assert.ok(/--font-scale:\s*1/.test(appWxss), '未定义 --font-scale 默认值');
  assert.ok(/--tap-min:\s*max\(44px/.test(appWxss), '触控区未随字体放大且保持 44px 下限');

  for (const page of TAB_PAGES) {
    const wxml = read(`miniprogram/${page}.wxml`);
    const js = read(`miniprogram/${page}.js`);
    for (const button of wxml.matchAll(/<button\b[^>]*>/g)) {
      assert.ok(hasButtonStyle(button[0]), `${page} 按钮缺少字号与高度样式：${button[0]}`);
    }
    assert.ok(wxml.includes('--font-scale: {{fontScale}}'), `${page} 根节点未注入 --font-scale`);
    assert.ok(js.includes('fontScale'), `${page} 未引入 font-scale`);
    assert.ok(/onLoad/.test(js), `${page} 缺少 onLoad 调用 applyFontScale`);
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
    assert.ok(js.includes("utils/auth"), `${page} 未复用 main 的会话门禁`);
    assert.ok(js.includes("pageGate.start("), `${page} 未核实服务端会话`);
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

test('未接入真实会话前恒为游客：任意缓存值不得进入登录态', () => {
  const sessionSrc = read('miniprogram/utils/session.js');
  assert.ok(/const SESSION_ENABLED = false/.test(sessionSrc), 'SESSION_ENABLED 必须为 false');
  assert.ok(!/wx\.login|getPhoneNumber/.test(sessionSrc), '会话占位不得调用登录或手机号能力');

  // 行为回归：以合成 wx 实际加载模块，逐个喂入监工复现的越界取值
  const cases = ['占位字符串', { demo: true }, '', { token: '' }, { __devPreview: true }, 0, 1, [], true, { token: 'real-looking' }];
  let reads = 0;
  globalThis.wx = { getStorageSync: () => cases[reads++] };
  const session = createRequire(import.meta.url)('../miniprogram/utils/session.js');
  for (let i = 0; i < cases.length; i += 1) {
    assert.equal(session.isGuest(), true, `缓存值 ${JSON.stringify(cases[i])} 不得被当成登录态`);
  }
  assert.equal(reads, 0, 'SESSION_ENABLED 关闭时不应读取存储，否则 isGuest 会受缓存影响');
  assert.equal(session.read(), null, '关闭状态下不得返回任何会话对象');
  delete globalThis.wx;
});

test('首页副标题与消息范围不把后置能力写成本版目标', () => {
  const home = read('miniprogram/pages/home/home.wxml');
  assert.ok(home.includes('识草查药与除草科普社区'), '首页副标题须为已确认文案');
  assert.ok(!home.includes('用药提醒'), '首版副标题不得出现 2027-02 后置的用药提醒');

  const messages = read('miniprogram/pages/messages/messages.wxml');
  assert.ok(!messages.includes('用药提醒'), '消息页不得把后置的用药提醒列为本版消息类型');
  for (const kind of ['评论与点赞', '内容审核结果', '系统通知']) {
    assert.ok(messages.includes(kind), `首版消息类型缺失：${kind}`);
  }
  assert.ok(!/<text class="desc">/.test(messages), '消息描述类名应与 kind__desc 一致');
});

test('本任务未改动冻结契约与本地配置隔离规则', (t) => {
  let changed = [];
  try {
    changed = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    const detail = `${err.stderr || ''}${err.message || ''}`;
    // 仅在确实没有远端基线时显式跳过；其余失败（权限、仓库损坏等）必须暴露为失败，
    // 不能静默 return 让 node:test 把未验证的检查记成 PASS
    if (/unknown revision|bad revision|ambiguous argument/i.test(detail)) {
      t.skip(`无 origin/main 基线，冻结契约未验证：${detail.trim().split('\n')[0]}`);
      return;
    }
    throw err;
  }
  assert.ok(!changed.some((f) => f.startsWith('packages/contracts/')), '不得修改冻结契约');
  assert.ok(!changed.includes('miniprogram/config/runtime.js'), '不得修改共享运行配置');
  const ignore = read('.gitignore');
  assert.ok(ignore.includes('config.local.json'), '本地配置未被忽略');
});

/**
 * 以合成 wx 加载 app.js 并在 wx 存在期间执行 fn。
 * 每次清理模块缓存后重新加载，避免模块级状态串味；
 * fn 必须在此函数内部调用被测函数，否则 wx 已被清理、读不到字段。
 */
function withApp(wxOverrides, fn) {
  const req = createRequire(import.meta.url);
  // app.js 现依赖 utils/auth.js（GY-I04 会话），一并清缓存以便注入合成实现
  for (const p of ['../miniprogram/app.js', '../miniprogram/utils/auth.js', '../miniprogram/utils/session.js', '../miniprogram/utils/system-font.js']) {
    delete req.cache[req.resolve(p)];
  }
  globalThis.App = () => {};
  globalThis.wx = Object.assign(
    {
      getStorageSync: () => '',
      removeStorageSync: () => {},
      getSystemInfoSync: () => ({}),
      getAppBaseInfo: undefined,
      getFontSizeManager: undefined
    },
    wxOverrides
  );
  try {
    return fn(req('../miniprogram/app.js'));
  } finally {
    delete globalThis.App;
    delete globalThis.wx;
  }
}

test('官方比例路径：getAppBaseInfo 必须接入（监工 2026-10-09 反例）', () => {
  const sysFont = read('miniprogram/utils/system-font.js');
  assert.ok(/getAppBaseInfo/.test(sysFont), 'system-font.js 未接入 wx.getAppBaseInfo()');

  // 反例一：官方比例 1.25，旧接口全部抛错 → 应为 1.25，不得回落 1
  withApp(
    {
      getFontSizeManager: () => {
        throw new Error('unsupported');
      },
      getAppBaseInfo: () => ({ fontSizeSetting: 20, fontSizeScaleFactor: 1.25 }),
      getSystemInfoSync: () => {
        throw new Error('deprecated');
      }
    },
    (app) => {
      assert.equal(app.readFontScale(), 1.25, 'getAppBaseInfo 的比例字段应生效，不得回落 1');
    }
  );

  // 反例二：官方比例 1.15，旧接口 px=18 → 应为 1.15，不得取 18÷16=1.125
  withApp(
    {
      getFontSizeManager: undefined,
      getAppBaseInfo: () => ({ fontSizeSetting: 20, fontSizeScaleFactor: 1.15 }),
      getSystemInfoSync: () => ({ fontSizeSetting: 18 })
    },
    (app) => {
      assert.equal(app.readFontScale(), 1.15, '官方比例应优先于旧接口的 px 换算，不得取 1.125');
    }
  );

  // getAppBaseInfo 只有 px 无比例时，才轮到 px 换算
  withApp(
    { getFontSizeManager: undefined, getAppBaseInfo: () => ({ fontSizeSetting: 18 }) },
    (app) => {
      assert.equal(app.readFontScale(), 1.125, '无比例字段时按 getAppBaseInfo 的 px 换算');
    }
  );

  // getAppBaseInfo 抛错须继续下探到 getSystemInfoSync
  withApp(
    {
      getFontSizeManager: undefined,
      getAppBaseInfo: () => {
        throw new Error('unsupported');
      },
      getSystemInfoSync: () => ({ fontSizeSetting: 26 })
    },
    (app) => {
      assert.equal(app.readFontScale(), 1.3, 'getAppBaseInfo 抛错时应下探到 getSystemInfoSync');
    }
  );
});

test('每个页面（含 GY-I04 的登录页）都注入 --font-scale', () => {
  // login 页由 main 的 GY-I04 新增，需求 4.1 的适老化是全局要求，不应漏
  for (const page of appJson.pages) {
    const wxml = read(`miniprogram/${page}.wxml`);
    const js = read(`miniprogram/${page}.js`);
    for (const button of wxml.matchAll(/<button\b[^>]*>/g)) {
      assert.ok(hasButtonStyle(button[0]), `${page} 按钮缺少字号与高度样式：${button[0]}`);
    }
    assert.ok(wxml.includes('--font-scale: {{fontScale}}'), `${page} 根节点未注入 --font-scale`);
    assert.ok(/applyFontScale|currentFontScale/.test(js), `${page} 未引入 font-scale`);
  }
});

test('fontSizeSetting 的 px 值按 16px 基准换算，微信三档字号可区分', () => {
  // 回归监工指出的缺陷：fontSizeSetting 单位为 px，早期实现直接当倍率传给 clampScale，
  // 使 16/18/20 三档全部被截断到 1.3（标准档被强制放大 30%）。
  const cases = [
    { px: 16, expected: 1 },
    { px: 18, expected: 1.125 },
    { px: 20, expected: 1.25 }
  ];
  for (const { px, expected } of cases) {
    withApp({ getSystemInfoSync: () => ({ fontSizeSetting: px }) }, (app) => {
      assert.equal(app.readFontScale(), expected, `fontSizeSetting=${px}px 应换算为 ${expected}`);
    });
  }
});

test('优先读取 fontSizeScaleFactor 比例字段，不受 fontSizeSetting 的 px 值干扰', () => {
  withApp({ getFontSizeManager: () => ({ fontSizeSetting: 20, fontSizeScaleFactor: 1.25 }) }, (app) => {
    assert.equal(app.readFontScale(), 1.25, 'getFontSizeManager 的比例字段应生效');
  });

  withApp({ getSystemInfoSync: () => ({ fontSizeSetting: 20, fontSizeScaleFactor: 1.25 }) }, (app) => {
    assert.equal(app.readFontScale(), 1.25, '系统信息上的比例字段应生效');
  });

  // getFontSizeManager 抛错时须继续下探，不得整体失败回落到 1
  withApp(
    {
      getFontSizeManager: () => {
        throw new Error('unsupported');
      },
      getSystemInfoSync: () => ({ fontSizeSetting: 20 })
    },
    (app) => {
      assert.equal(app.readFontScale(), 1.25, '比例 API 不可用时应回落到 px 换算');
    }
  );
});

test('字号只跟随微信字段，不读应用内存储；非法与缺失值一律回落标准', () => {
  // 需求未要求应用内开关，故即使存储中残留旧档位也不得采用
  withApp(
    { getStorageSync: () => 1.15, setStorageSync: () => {}, getSystemInfoSync: () => ({ fontSizeSetting: 20 }) },
    (app) => {
      assert.equal(app.readFontScale(), 1.25, '应按微信设置换算，忽略存储中的旧档位');
    }
  );

  withApp({ getStorageSync: () => '' }, (app) => {
    assert.ok(!('readSavedScale' in app), '不得导出 readSavedScale');
  });

  withApp({ getSystemInfoSync: () => ({}) }, (app) => {
    assert.equal(app.readFontScale(), 1, '微信字段缺失应回落 1');
  });

  for (const bad of [0, -1, NaN, '20', null, undefined, {}]) {
    withApp({ getSystemInfoSync: () => ({ fontSizeSetting: bad }) }, (app) => {
      assert.equal(app.readFontScale(), 1, `fontSizeSetting=${String(bad)} 应回落为 1`);
    });
  }
});

test('源码不得把 fontSizeSetting 的 px 值直接当倍率，并锁定基准与比例字段', () => {
  const src = read('miniprogram/utils/system-font.js');
  assert.ok(
    !/clampScale\((?:info\s*&&\s*info\.)?fontSizeSetting\)/.test(src),
    'fontSizeSetting 是 px，不得直接作为倍率传入 clampScale'
  );
  assert.ok(/fontSizeScaleFactor/.test(src), '必须读取 fontSizeScaleFactor 比例字段');
  assert.ok(/BASE_FONT_SIZE_PX\s*=\s*16/.test(src), 'px 换算基准应为 16');
  // app.js 与 font-scale.js 均不得绕过该模块自行读取字段（注释中提及历史缺陷不计）
  for (const p of ['miniprogram/app.js', 'miniprogram/utils/font-scale.js']) {
    const body = read(p)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/fontSizeSetting/.test(body), `${p} 代码中不得直接处理 fontSizeSetting，应委托 system-font.js`);
    assert.ok(!/getSystemInfoSync/.test(body), `${p} 不得自行读取系统信息中的字体字段`);
  }
  withApp({}, (app) => {
    assert.equal(app.BASE_FONT_SIZE_PX, 16, '导出的基准字号应为 16px');
  });
});

test('界面文案不得声称读不到微信字体设置（真机已实测可读）', () => {
  // 真机实测：微信标准档 fontSizeSetting=16 → 系数 1；特大档 26 → 1.625 封顶 1.3。
  // 早期文案称「读不到该设置」，与实测相反，会误导老年用户放弃系统级放大。
  // 该文案随应用内字号开关一并移除，此断言保留以防任何页面再写回错误说法。
  for (const page of ['home', 'identify', 'community', 'messages', 'profile']) {
    const wxml = read(`miniprogram/pages/${page}/${page}.wxml`);
    assert.ok(!/读不到该设置|不会改变本应用字号/.test(wxml), `${page} 不得声称读不到微信字体设置`);
  }
});

test('需求未要求应用内字号开关，故不得存在档位 UI 与本地存储', () => {
  // 需求第 4.1 节只写「适配微信字体设置」；三处需求出处均无应用内开关要求。
  // 早期实现自加了「标准／大／特大」档位，反而会遮蔽微信设置（用户已选「标准」时
  // 微信放大被忽略），且对老人是多余负担，故整块移除，只保留跟随微信。
  const profileWxml = read('miniprogram/pages/profile/profile.wxml');
  assert.ok(!/显示与字号/.test(profileWxml), '不得保留应用内字号区块');
  assert.ok(!/font-choice/.test(profileWxml), '不得保留档位选择 UI');
  assert.ok(!/font-choices/.test(read('miniprogram/pages/profile/profile.wxss')), '不得残留档位样式');

  const profileJs = read('miniprogram/pages/profile/profile.js');
  assert.ok(!/onFontScaleTap/.test(profileJs), '不得保留档位点击处理');

  const appJs = read('miniprogram/app.js');
  assert.ok(!/FONT_SCALE_KEY|gengyun_font_scale/.test(appJs), '不得保留应用内字号存储键');
  assert.ok(!/readSavedScale/.test(appJs), '不得保留应用内档位读取');
  assert.ok(!/setStorageSync|removeStorageSync/.test(appJs), 'app.js 不得读写字号存储');

  const fontScale = read('miniprogram/utils/font-scale.js');
  for (const gone of ['FONT_SCALE_CHOICES', 'setFontScale', 'savedScaleValue', 'buildChoices', 'labelOf', 'getStorageSync', 'setStorageSync']) {
    assert.ok(!new RegExp(`\\b${gone}\\b`).test(fontScale), `font-scale.js 不得保留 ${gone}`);
  }
  // 只保留注入所需的能力
  assert.ok(/function applyFontScale/.test(fontScale), '须保留 applyFontScale');
  assert.ok(/function currentFontScale/.test(fontScale), '须保留 currentFontScale');
});

test('字体变量在页面根节点计算，使普通正文继承实际微信倍率', () => {
  const block = appWxss.slice(appWxss.indexOf('.page {'), appWxss.indexOf('}', appWxss.indexOf('.page {')));
  assert.match(block, /font-size:\s*calc\(18px\s*\*\s*var\(--font-scale/);
});
