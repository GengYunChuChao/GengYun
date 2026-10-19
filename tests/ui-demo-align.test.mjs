/**
 * GY-I26 前端页面与 Demo 样式对齐：可机检的等价性（Refs #28）
 * ----------------------------------------------------------------------------
 * 本文件把「与 docs/ui-demo 对齐」拆成可复算的断言：
 *   1. 令牌值集合：demo dist/styles.css 的 :root 与 styles/tokens.wxss 逐值一致；
 *   2. 关键类名：五 Tab 与 article／post 详情用到的 demo 类在样式层都有对应类；
 *   3. 图标几何：styles/icons.wxss 等于用 demo app.js 的 SVG path 重新生成的结果；
 *   4. 可访问性门槛未被对齐破坏：样式层无裸 px 字号，且每个「允许承载按钮语义」
 *      的 demo 组件类都声明了 ≥44px 的触控下限（按钮类白名单不是放松，而是换等价约束）；
 *   5. 打包允许清单随样式层同步：app.wxss 依赖 styles/*.wxss，漏打包会整站丢样式；
 *   6. demo 视图承接：demo.html render() 分发的 11 个视图逐个要有小程序承接页，
 *      白名单（ALLOWED_MISSING_VIEWS）只允许 video／chat，且白名单本身受反向校验
 *      （删项即红／过期项即红／掺入非 demo 视图即红），见本文件末三例。
 *
 * 边界：这是静态文本比对，**不是**微信工具编译或真机渲染。真机／模拟器／开发者工具
 * 截图在本环境未取得，见 docs/verification/gy-i26-demo-align-20261014.md。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check,
  LAYER_FILES,
  stripComments,
  PALETTE_TOKENS,
  ALLOWED_MISSING_VIEWS,
  VIEW_PAGES,
  readDemoViews
} from '../tools/demo-align.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const layerText = LAYER_FILES.map((f) => stripComments(read(f))).join('\n');

/** 取某个类选择器的声明块（跳过 .foo-bar 这类前缀相同的选择器） */
function ruleOf(classSelector) {
  const re = new RegExp('(^|\\})\\s*' + classSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(\\{|[,:])');
  const m = layerText.match(re);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  return layerText.slice(start, layerText.indexOf('}', start));
}

test('demo 对齐核对整体通过（令牌／类名／图标几何／门槛）', () => {
  const { problems } = check();
  assert.deepEqual(problems, [], problems.join('；'));
});

test('样式层逐值复现 demo 的 :root 色板令牌', () => {
  const tokens = read('miniprogram/styles/tokens.wxss');
  const expected = { green: '#176b50', ink: '#17352b', muted: '#7b8983', paper: '#f5f7f4', line: '#e5ebe5', lime: '#c6f17b' };
  for (const name of PALETTE_TOKENS) {
    assert.ok(new RegExp(`--${name}:\\s*${expected[name]}`, 'i').test(tokens), `令牌 --${name} 未采用 demo 值 ${expected[name]}`);
  }
  // app.json 的导航与 tabBar 也必须跟随同一色板，否则出现两种主题绿
  const appJson = JSON.parse(read('miniprogram/app.json'));
  assert.equal(appJson.window.navigationBarBackgroundColor, expected.green);
  assert.equal(appJson.tabBar.selectedColor, expected.green);
});

test('按钮类白名单不是放松：每个可点组件类都声明了 ≥44px 触控下限', () => {
  const TAPPABLE = [
    'btn', 'feature-card', 'info-row', 'tabs__item', 'chip', 'message-row', 'setting-row',
    'text-btn', 'topic', 'post-text', 'post-actions__item', 'stat', 'timeline-item'
  ];
  for (const name of TAPPABLE) {
    const rule = ruleOf('.' + name);
    assert.ok(rule, `样式层缺少可点组件类 .${name}`);
    const m = rule.match(/min-height:\s*([^;]+);/);
    assert.ok(m, `.${name} 未声明 min-height，按钮语义的高度无约束`);
    const value = m[1].trim();
    const okToken = /var\(--tap-min/.test(value);
    const px = value.match(/^(\d+(?:\.\d+)?)px$/);
    const okPx = px && Number(px[1]) >= 44;
    const okMax = /max\(\s*44px/.test(value);
    assert.ok(okToken || okPx || okMax, `.${name} 的 min-height（${value}）不满足 44px 触控门槛`);
  }
});

test('五个 Tab 页都使用 demo 的页头与面板形态，而非各写一套', () => {
  for (const page of ['home', 'identify', 'knowledge', 'community', 'messages', 'profile']) {
    const wxml = read(`miniprogram/pages/${page}/${page}.wxml`);
    // 页头：demo .page-heading（h1 + p）。资料库／详情沿用 GY-I07 已用真机证据验证过的
    // .page-title + .subtitle 组合——同一信息架构，字号与层级取自同一套令牌，故等价接受。
    const pageHeading = /class="[^"]*page-heading/.test(wxml);
    const titlePair = /class="[^"]*page-title/.test(wxml) && /class="[^"]*subtitle/.test(wxml);
    assert.ok(pageHeading || titlePair, `${page} 未使用 demo 的页头层级（.page-heading 或 .page-title + .subtitle）`);
    assert.ok(/class="[^"]*(panel|feature-card|article-card|profile-header)/.test(wxml), `${page} 未使用 demo 的容器形态类`);
  }
});

test('统一失败态：可失败页面都接 components/state-view', () => {
  for (const page of ['home', 'identify', 'knowledge', 'knowledgedetail', 'community', 'messages', 'profile', 'specimen']) {
    const cfg = JSON.parse(read(`miniprogram/pages/${page}/${page}.json`));
    assert.ok(cfg.usingComponents && cfg.usingComponents['state-view'], `${page} 未注册 state-view，失败态不统一`);
    assert.ok(/<state-view/.test(read(`miniprogram/pages/${page}/${page}.wxml`)), `${page} 未使用 state-view`);
  }
  // 状态组件八态齐全，且每态都有图标／标题／说明
  const stateJs = read('miniprogram/components/state-view/state-view.js');
  for (const status of ['guest', 'empty', 'loading', 'error', 'cancelled', 'invalid', 'stub']) {
    assert.ok(new RegExp(`${status}: \\{`).test(stateJs), `state-view 缺少状态 ${status}`);
  }
});

test('打包允许清单随样式层同步：漏打包 styles/*.wxss 会让隔离工程整站丢样式', () => {
  const packing = read('tools/prepare-wechat.mjs');
  for (const file of ['styles/tokens.wxss', 'styles/icons.wxss', 'styles/components.wxss']) {
    assert.ok(packing.includes(file), `prepare-wechat.mjs 允许清单缺少 ${file}`);
  }
  // 页面允许清单必须与 app.json 逐项一致（prepare-wechat.mjs 自身也会断言）
  const appJson = JSON.parse(read('miniprogram/app.json'));
  const listed = packing.slice(packing.indexOf('const pages = ['), packing.indexOf('];', packing.indexOf('const pages = [')));
  for (const page of appJson.pages) {
    assert.ok(listed.includes(`'${page}'`), `prepare-wechat.mjs 页面允许清单缺少 ${page}`);
  }
});

test('样式层文件存在于仓库且非空', () => {
  for (const file of LAYER_FILES) {
    assert.ok(read(file).length > 200, `${file} 内容异常`);
  }
});

// ---------------------------------------------------------------------------
// demo 视图承接（第 5 组）：白名单是显式声明，不是静默排除。以下三例互为「牙齿」。
// ---------------------------------------------------------------------------

test('demo 视图白名单删项即红：白名单外的缺失视图必须报 MISSING（exit 1 的来源）', () => {
  const { problems } = check({ allowedMissingViews: [] });
  for (const view of ['video', 'chat']) {
    assert.ok(
      problems.some((p) => p.startsWith(`MISSING ${view}：`)),
      `删掉 ALLOWED_MISSING_VIEWS 里的 ${view} 后未报 MISSING，白名单退化成静默排除；实际 problems=${JSON.stringify(problems)}`
    );
  }
});

test('demo 视图白名单不能豁免已过期项或非 demo 视图项', () => {
  // ① 白名单过期：library 已有承接页，仍被塞进白名单 ⇒ 必须红
  const stale = check({ allowedMissingViews: [...ALLOWED_MISSING_VIEWS, 'library'] });
  assert.ok(
    stale.problems.some((p) => p.startsWith('ALLOWED_MISSING_VIEWS 含 library') && p.includes('已登记承接页')),
    `把有页的 library 塞进白名单后未报错；实际 problems=${JSON.stringify(stale.problems)}`
  );
  // ② 掺入不是 demo 视图的名字（小程序有同名页也不算数）⇒ 必须红
  const bogus = check({ allowedMissingViews: [...ALLOWED_MISSING_VIEWS, 'favorites'] });
  assert.ok(
    bogus.problems.some((p) => p.includes('ALLOWED_MISSING_VIEWS 含 favorites') && p.includes('不是 demo 的视图')),
    `把非 demo 视图 favorites 塞进白名单后未报错；实际 problems=${JSON.stringify(bogus.problems)}`
  );
  // ③ demo 新增视图但小程序无页、又没登记白名单 ⇒ 必须红（新视图不会白嫖通过）
  const added = check({ views: [...readDemoViews(), 'records'] });
  assert.ok(
    added.problems.some((p) => p.startsWith('MISSING records：')),
    `demo 新增未承接视图 records 后未报 MISSING；实际 problems=${JSON.stringify(added.problems)}`
  );
});

test('demo 视图承接现状：11 个视图／9 个有承接页／白名单只留 video、chat', () => {
  const { rows, problems } = check();
  assert.deepEqual(problems, []);

  // 视图清单从 demo.html 的 render() 分发处解析，不手抄
  assert.deepEqual(readDemoViews(), [
    'home',
    'identify',
    'result',
    'library',
    'video',
    'chat',
    'community',
    'messages',
    'profile',
    'article',
    'post'
  ]);
  assert.deepEqual(ALLOWED_MISSING_VIEWS, ['video', 'chat']);
  // 白名单项在 VIEW_PAGES 里必须「零承接页」，否则这行断言就把白名单过期变成红灯
  for (const view of ALLOWED_MISSING_VIEWS) {
    assert.deepEqual(VIEW_PAGES[view], [], `${view} 已登记承接页，必须移出 ALLOWED_MISSING_VIEWS`);
  }

  const group = rows.find((r) => r.kind === 'view');
  assert.ok(group, 'check() 未输出第 5 组 demo 视图承接');
  assert.equal(group.views.length, 11);
  assert.equal(group.present, 9);
  assert.deepEqual(group.allowedMissing, ['video', 'chat']);
  // 有承接页的视图必须逐个 OK，且承接页都在 app.json.pages 里注册过
  const registered = new Set(JSON.parse(read('miniprogram/app.json')).pages);
  for (const row of group.rows) {
    if (row.state !== 'OK') continue;
    assert.ok(row.pages.length > 0, `${row.view} 判定有页却没列承接页`);
    for (const page of row.pages) assert.ok(registered.has(page), `${row.view} 的承接页 ${page} 未在 app.json.pages 注册`);
  }
});
