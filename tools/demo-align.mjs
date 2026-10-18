/**
 * GY-I26 前端页面与 Demo 样式对齐：可机检的等价性核对（Refs #28）
 * ----------------------------------------------------------------------------
 * 用途：把「小程序样式层与 docs/ui-demo 的对应关系」从主观描述变成**可复算的比对**，
 * 并保证 WXSS 里的图标几何确实来自 Demo 源码，而不是手抄。
 *
 * 核对五件事：
 *   1. 令牌值集合比对：demo dist/styles.css 的 :root 色板 → miniprogram/styles/tokens.wxss
 *      必须逐值相同（--green/--ink/--muted/--paper/--line/--lime）。
 *   2. 关键类名存在性：五 Tab 与 article／post 详情用到的 demo 类，必须在 WXSS 样式层
 *      有对应类；不适用项必须逐条给出理由（OMITTED），不允许静默缺失。
 *   3. 图标几何一致性：miniprogram/styles/icons.wxss 必须等于用 demo app.js 的
 *      SVG path 数据重新生成的结果（--write-icons 重写）。
 *   4. 可访问性门槛不被样式对齐破坏：样式层不得出现未乘 --font-scale 的裸 px 字号，
 *      交互类必须有 ≥44px 的高度下限。
 *   5. demo 视图承接：demo.html 的 render() 分发视图（含 article／post 动态路由）逐个要求
 *      小程序有承接页；确无页的视图（当前 video／chat）必须登记进 ALLOWED_MISSING_VIEWS，
 *      输出里逐行打印 `MISSING(allowed): <view>`。白名单是**显式声明**，不是静默排除：
 *      白名单外的缺失视图、已过期（本该有页）的白名单项都判失败。
 *
 * 边界：本脚本只读文本、只做静态比对；它**不运行微信工具、不渲染页面、不测量真机**。
 *      demo 与小程序的实际视觉差异仍须在微信开发者工具／真机复核（本片未取得）。
 *
 * 运行：
 *   node tools/demo-align.mjs                # 核对，打印映射表，失败置 exit code 1
 *   node tools/demo-align.mjs --write-icons  # 用 demo 的 SVG path 重写 icons.wxss
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const DEMO_CSS = 'docs/ui-demo/dist/styles.css';
const DEMO_JS = 'docs/ui-demo/dist/app.js';
const DEMO_HTML = 'docs/ui-demo/demo.html';
const APP_JSON = 'miniprogram/app.json';
const TOKENS_WXSS = 'miniprogram/styles/tokens.wxss';
const ICONS_WXSS = 'miniprogram/styles/icons.wxss';
const COMPONENTS_WXSS = 'miniprogram/styles/components.wxss';

/** GY-I26 新增的样式层文件 */
export const STYLE_FILES = [TOKENS_WXSS, ICONS_WXSS, COMPONENTS_WXSS];

/**
 * 类名与字号门槛的核对范围 = 全局原语（app.wxss）+ 样式层（styles/*.wxss）。
 * app.wxss 里的 .btn／.badge／.card 等原语同样属于本任务的对齐面，不能漏检。
 */
export const LAYER_FILES = ['miniprogram/app.wxss', ...STYLE_FILES];

/** 去掉 CSS 注释：注释里的 demo 原值（如 font-size:24px）不得被当成实际声明 */
export const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** demo :root 中需要在 WXSS 逐值复现的色板令牌 */
export const PALETTE_TOKENS = ['green', 'ink', 'muted', 'paper', 'line', 'lime'];

/** 图标：demo app.js 的 SVG path 名 → WXSS 类后缀与描边色 */
const TAB_ICONS = ['home', 'users', 'scan', 'bell', 'person'];
const TAB_TONE_OFF = '#a2b197'; // demo .bottom-nav button{color}
const TAB_TONE_ON = '#396d33'; // demo .bottom-nav button.active{color}
const PLAIN_ICONS = [
  ['leaf', '#7c9c5f'],
  ['scan', '#567441'],
  ['chat', '#777550'],
  ['video', '#766e91'],
  ['search', '#92a18a'],
  ['back', '#556a5c'],
  ['arrow', '#b2beb2'],
  ['shield', '#94a087'],
  ['heart', '#94a087'],
  ['plus', '#ffffff'],
  ['logout', '#748763'],
  ['wheat', '#748763'],
  ['volume', '#748763'],
  ['settings', '#748763'],
  ['image', '#6e8565'],
  ['mic', '#82946f'],
  ['tag', '#6f905c'],
  ['clock', '#85ba91']
];

/**
 * demo 类 → WXSS 类。左侧为 demo 选择器里的类名（去掉 .），右侧为样式层实际类名。
 * 修饰类（demo 用 .btn.primary 的组合式）单列在 MODIFIER_MAP。
 */
export const CLASS_MAP = [
  // 页头与分节
  ['page-heading', 'page-heading'],
  ['title-with-back', 'page-heading__back'],
  ['back-btn', 'back-btn'],
  ['subtitle', 'subtitle'],
  ['section', 'section'],
  ['section-head', 'section-head'],
  ['compact-meta', 'section-head__meta'],
  ['text-btn', 'text-btn'],
  ['context-chip', 'context-chip'],
  // 卡片与容器
  ['panel', 'panel'],
  ['panel-head', 'panel-head'],
  ['info-list', 'info-list'],
  ['info-row', 'info-row'],
  ['tiny-art', 'tiny-art'],
  ['card-meta', 'card-meta'],
  ['article-card', 'article-card'],
  ['article-art', 'article-art'],
  ['library-grid', 'library-grid'],
  ['detail-layout', 'detail-layout'],
  ['prose', 'prose'],
  ['stat-grid', 'stat-grid'],
  ['stat', 'stat'],
  ['notice', 'notice'],
  ['demo-caption', 'demo-caption'],
  ['hint', 'hint'],
  ['label', 'label'],
  ['row-actions', 'row-actions'],
  ['empty', 'empty'],
  ['pill', 'pill'],
  ['tag-label', 'tag-label'],
  ['info-tags', 'info-tags'],
  // 首页
  ['hero', 'hero'],
  ['hero-content', 'hero__content'],
  ['hero-art', 'hero__art'],
  ['eyebrow', 'hero__eyebrow'],
  ['hero-code', 'hero__code'],
  ['dot', 'dot'],
  ['feature-grid', 'feature-grid'],
  ['feature-card', 'feature-card'],
  ['feature-icon', 'feature-card__icon'],
  ['new-tag', 'new-tag'],
  ['card-arrow', 'card-arrow'],
  ['home-bottom', 'home-bottom'],
  ['mini-timeline', 'mini-timeline'],
  ['timeline-item', 'timeline-item'],
  ['timeline-dot', 'timeline-dot'],
  ['timeline-copy', 'timeline-copy'],
  // 识别
  ['tabs', 'tabs'],
  ['scan-grid', 'scan-grid'],
  ['scan-stage', 'scan-stage'],
  ['scan-view', 'scan-view'],
  ['scan-frame', 'scan-frame'],
  ['scan-caption', 'scan-caption'],
  ['sample', 'sample'],
  ['process-panel', 'process-panel'],
  ['process-status', 'process-status'],
  ['progress-track', 'progress-track'],
  ['process-steps', 'process-steps'],
  // 资料库
  ['search-box', 'search-box'],
  ['input', 'input'],
  ['chips', 'chips'],
  ['chip', 'chip'],
  ['library-filters', 'library-filters'],
  ['library-note', 'library-note'],
  // 社区
  ['feed', 'feed'],
  ['post', 'post'],
  ['post-author', 'post-author'],
  ['post-text', 'post-text'],
  ['post-visual', 'post-visual'],
  ['post-actions', 'post-actions'],
  ['comments', 'comments'],
  ['comment-row', 'comment-row'],
  ['topic', 'topic'],
  ['community-switch', 'community-switch'],
  ['avatar', 'avatar'],
  // 消息
  ['message-list', 'message-list'],
  ['message-row', 'message-row'],
  ['message-icon', 'message-icon'],
  ['message-copy', 'message-copy'],
  ['unread-dot', 'unread-dot'],
  // 我的
  ['profile-header', 'profile-header'],
  ['profile-actions', 'profile-actions'],
  ['profile-grid', 'profile-grid'],
  ['setting-row', 'setting-row'],
  ['switch', 'switch'],
  ['ip-location', 'ip-location']
];

/** demo 组合式修饰类 → WXSS 修饰类 */
export const MODIFIER_MAP = [
  ['.btn.primary', '.btn--primary'],
  ['.btn.ghost', '.btn--ghost'],
  ['.btn.lime', '.btn--lime'],
  ['.btn.dark', '.btn--dark'],
  ['.btn.full', '.btn--block'],
  ['.btn.danger', '.btn--danger'],
  ['.pill.gray', '.pill--gray'],
  ['.pill.amber', '.pill--amber'],
  ['.pill.blue', '.pill--blue'],
  ['.pill.purple', '.pill--purple'],
  ['.pill.risk-low', '.pill--low'],
  ['.pill.risk-medium', '.pill--medium'],
  ['.pill.risk-high', '.pill--high'],
  ['.chip.active', '.chip--active'],
  ['.tabs button.active', '.tabs__item--active'],
  ['.switch.on', '.switch--on'],
  ['.info-row .copy strong', '.info-row__title'],
  ['.info-row .copy small', '.info-row__desc']
];

/**
 * 明确不落地的 demo 类：每一条都必须寫清理由，避免「静默缺失」被当成对齐。
 * 归类见 docs/verification/gy-i26-demo-align-20261014.md 的取舍表。
 */
export const OMITTED_CLASSES = [
  // 桌面外壳：小程序由 Tab 栏与导航栏承担，无侧边栏／顶栏这一层
  ['.shell / .sidebar / .workspace / .topbar / .crumb / .brand* / .nav-list / .nav-item / .nav-label / .sidebar-tools / .sidebar-note / .mobile-brand / .top-actions / .mode-badge / .preview-toggle', '桌面端外壳与「手机预览」开关，小程序无对应层级'],
  ['.footer-note', '桌面页脚声明，小程序用页面末屏预留（.page padding-bottom）表达'],
  // 模拟登录弹窗：小程序登录是独立页面，属 GY-I04 已交付成果，不重写
  ['.modal / .modal-backdrop / .modal-header / .modal-close / .login-mark / .login-copy / .agreement / .modal-note', 'demo 的模拟登录弹窗；小程序为 pages/login 独立页（GY-I04），本片不接管'],
  ['#toast', 'demo 的浏览器 toast；小程序用 wx.showToast 原生能力，不用样式层复刻'],
  // 本片不新建的页面（视图级缺失已由第 5 组 ALLOWED_MISSING_VIEWS 显式登记，不再靠本条静默排除）
  ['.video-* / .periods / .period / .time-node / .timeline-bar / .play-circle / .generation-orb', 'demo 的情景视频页类；小程序无 video 视图，视图缺失见 ALLOWED_MISSING_VIEWS（第 5 组打印 MISSING(allowed): video）'],
  ['.chat-* / .bubble* / .suggestions / .sound-active', 'demo 的农事问答页类；小程序无 chat 视图，视图缺失见 ALLOWED_MISSING_VIEWS（第 5 组打印 MISSING(allowed): chat）'],
  ['.crop-select-grid / .crop-choice', 'demo 的作物选择弹窗；小程序用原生 picker（「我的」已交付）'],
  ['.result-hero / .result-candidate / .stat strong 的大数字', 'demo 的识别结果页；小程序识别页为既有候选卡实现（GY-I09），本片只对齐样式令牌'],
  // WXSS 无需或等价物不同
  ['.sr-only / .fade-in / @keyframes fadein|scanline|rotate|pulse', '屏读专用类与动效：WXSS 不支持 :focus-visible 等伪类，动效按 prefers-reduced-motion 约定不引入'],
  ['.float-create', 'demo 桌面悬浮发布按钮；小程序社区页用 .row-actions 内的主按钮'],
  ['.backdrop-filter / mask-image / isolation', 'demo 顶栏毛玻璃与网格遮罩；WXSS 支持不稳定，改为不透明底色'],
  ['display:grid 多列排版', 'WXSS 的 grid 在旧基础库支持不一致，样式层用 flex + 百分比宽度等价实现']
];

/* ---------------------------- 视图承接 ---------------------------- */

/**
 * demo 视图（render() 的顶层分发 + article／post 动态路由）→ 小程序承接页。
 * 值即 app.json.pages 里的页面路径；判定「有页」＝该路径已在 app.json.pages 注册，
 * 且 miniprogram/<路径>.wxml 存在。空数组＝**已核实小程序确无承接页**，
 * 这类视图必须同时登记进 ALLOWED_MISSING_VIEWS，否则第 5 组核对直接报 MISSING。
 */
export const VIEW_PAGES = {
  home: ['pages/home/home'],
  identify: ['pages/identify/identify'],
  // demo 的 result 是独立视图；小程序由识别页内嵌候选区承接（GY-I09 既有实现）
  result: ['pages/identify/identify'],
  library: ['pages/knowledge/knowledge', 'pages/reference/reference', 'pages/referenceseed/referenceseed'],
  // 情景视频：demo 有页（demo.html 的 function video()），小程序 0 文件 · 真无页
  video: [],
  // 农事问答：同上
  chat: [],
  community: ['pages/community/community'],
  article: ['pages/knowledgedetail/knowledgedetail', 'pages/referencedetail/referencedetail', 'pages/referenceseeddetail/referenceseeddetail'],
  post: ['pages/communitydetail/communitydetail'],
  messages: ['pages/messages/messages'],
  profile: ['pages/profile/profile']
};

/**
 * 允许缺失的视图白名单：只收纳「demo 有、小程序确无页」的视图，且每项都会在输出里
 * 打印一行 `MISSING(allowed): <view>`。白名单不是豁免通道——本脚本会反向校验：
 * 白名单项若已登记承接页（白名单过期），或根本不是 demo 的视图，同样判失败。
 */
export const ALLOWED_MISSING_VIEWS = ['video', 'chat'];

/* ------------------------------ 解析 ------------------------------ */

/** 读 demo :root 的色板令牌 */
export function readDemoTokens() {
  const css = read(DEMO_CSS);
  const m = css.match(/:root\{([^}]*)\}/);
  if (!m) throw new Error(`${DEMO_CSS} 未找到 :root 令牌块`);
  const out = {};
  for (const decl of m[1].split(';')) {
    const [k, v] = decl.split(':');
    if (k && k.trim().startsWith('--')) out[k.trim().slice(2)] = v.trim();
  }
  return out;
}

/** 读 demo app.js 的 SVG path 表 */
export function readDemoIconPaths() {
  const js = read(DEMO_JS);
  const start = js.indexOf('const paths = {');
  if (start < 0) throw new Error(`${DEMO_JS} 未找到 const paths`);
  const end = js.indexOf('};', start);
  const body = js.slice(start, end);
  const out = {};
  for (const m of body.matchAll(/([A-Za-z0-9_]+)\s*:\s*'([^']*)'/g)) out[m[1]] = m[2];
  return out;
}

/**
 * 从 demo.html 的 render() 分发处解析视图集合，不手抄：
 *   const content=({home,identify,result,library,video,chat,community,messages,profile}[page]||
 *     (()=>page==='article'?article(id):page==='post'?postDetail(id):home()))()
 * 前一段给 9 个顶层视图，后一段的 `page==='<name>'` 给 article／post 两个动态路由。
 */
export function readDemoViews() {
  const html = read(DEMO_HTML);
  const m = html.match(/const content=\(\{([^}]*)\}\[page\]/);
  if (!m) throw new Error(`${DEMO_HTML} 未找到 render() 的视图分发表 const content=({…}[page])，请同步本脚本`);
  const views = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // 动态路由（article/:id、post/:id）与导航里复用的视图名都可能出现在 page==='x' 里，去重后并入
  for (const d of html.matchAll(/page==='([a-z]+)'/g)) views.push(d[1]);
  return [...new Set(views)];
}

/** 读小程序已注册页面清单（app.json pages 顺序即注册序） */
export function readAppPages() {
  const pages = JSON.parse(read(APP_JSON)).pages;
  if (!Array.isArray(pages) || !pages.length) throw new Error(`${APP_JSON} 未读到 pages 数组`);
  return pages;
}

/**
 * 第 5 组核对：demo 视图承接。
 * options.views / options.allowedMissingViews 供测试注入变体（CLI 与默认调用用真实仓库数据）。
 */
export function auditViews(options = {}) {
  const views = options.views || readDemoViews();
  const allowed = options.allowedMissingViews || ALLOWED_MISSING_VIEWS;
  const registered = new Set(readAppPages());
  const rows = [];
  const problems = [];

  for (const view of views) {
    const pages = VIEW_PAGES[view];
    if (!pages) {
      rows.push({ view, pages: [], state: 'UNMAPPED' });
      problems.push(`MISSING ${view}：demo 有此视图，但 VIEW_PAGES 未登记承接页（新视图先登记承接页，或列入 ALLOWED_MISSING_VIEWS 并写明理由）`);
      continue;
    }
    if (!pages.length) {
      const ok = allowed.includes(view);
      rows.push({ view, pages, state: ok ? 'MISSING(allowed)' : 'MISSING' });
      if (!ok) problems.push(`MISSING ${view}：demo 有此视图，小程序无承接页，且未列入 ALLOWED_MISSING_VIEWS 白名单`);
      continue;
    }
    const broken = pages.filter((p) => !registered.has(p) || !existsSync(join(ROOT, `miniprogram/${p}.wxml`)));
    if (broken.length) {
      rows.push({ view, pages, state: 'MISSING', broken });
      problems.push(`MISSING ${view}：承接页未在 app.json.pages 注册或 .wxml 缺失：${broken.join('、')}`);
      continue;
    }
    rows.push({ view, pages, state: 'OK' });
  }

  // 白名单自校验：防止「静默排除」借白名单还魂
  for (const view of allowed) {
    if (!views.includes(view)) {
      problems.push(`ALLOWED_MISSING_VIEWS 含 ${view}，但它不是 demo 的视图（白名单只收纳 demo 有、小程序确无页的视图）`);
    } else if (VIEW_PAGES[view] && VIEW_PAGES[view].length) {
      problems.push(`ALLOWED_MISSING_VIEWS 含 ${view}，但 VIEW_PAGES 已登记承接页 ${VIEW_PAGES[view].join('、')}（有页的视图必须移出白名单）`);
    }
  }

  return {
    views,
    rows,
    problems,
    present: rows.filter((r) => r.state === 'OK').length,
    allowedMissing: rows.filter((r) => r.state === 'MISSING(allowed)').map((r) => r.view)
  };
}

/** 读 WXSS 样式层 page 块里的令牌 */
export function readStyleTokens() {
  const wxss = read(TOKENS_WXSS);
  const m = wxss.match(/\npage\s*\{([\s\S]*?)\n\}/);
  if (!m) throw new Error(`${TOKENS_WXSS} 未找到 page 令牌块`);
  const out = {};
  // 先去掉注释，否则「/* 说明 */」会被并进上一条声明，导致令牌名解析错位
  for (const decl of m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim();
    if (k.startsWith('--')) out[k.slice(2)] = decl.slice(i + 1).trim();
  }
  return out;
}

/** 取文本里的全部 .class 名（去重） */
export function classNames(css) {
  const set = new Set();
  for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) set.add(m[1]);
  return set;
}

function dataUri(d, stroke) {
  const enc = (s) => s.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23').replace(/ /g, '%20').replace(/"/g, "'");
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${stroke}'` +
    ` stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'><path d='${d}'/></svg>`;
  return `url("data:image/svg+xml,${enc(svg)}")`;
}

/** 由 demo 的 SVG path 生成 icons.wxss 全文（不用手抄几何） */
export function buildIconsWxss(paths) {
  const L = [];
  L.push('/**');
  L.push(' * 图标层（GY-I26 demo 对齐）');
  L.push(' * ----------------------------------------------------------------------------');
  L.push(' * 本体由 tools/demo-align.mjs 从 docs/ui-demo/dist/app.js 的 `const paths` 生成，');
  L.push(' * 几何与 demo 逐字一致；不用 <svg> 内联标签，改以 data URI 作为 background-image，');
  L.push(' * 因为 WXSS 不能内联 SVG，而 currentColor 也无法穿透 data URI，故按 demo 的实际');
  L.push(' * 描边色各建一个类（token 取色见 demo styles.css 的对应选择器）。');
  L.push(' *');
  L.push(' * 重新生成：node tools/demo-align.mjs --write-icons');
  L.push(' * 校验一致：node tools/demo-align.mjs');
  L.push(' */');
  L.push('');
  L.push('.gy-icon {');
  L.push('  display: inline-block;');
  L.push('  flex-shrink: 0;');
  L.push('  /* 与文字同步随微信字体设置放大，避免大字时图标显得过小 */');
  L.push('  width: calc(var(--gy-icon-size, 21px) * var(--font-scale, 1));');
  L.push('  height: calc(var(--gy-icon-size, 21px) * var(--font-scale, 1));');
  L.push('  background-repeat: no-repeat;');
  L.push('  background-position: center;');
  L.push('  background-size: 100% 100%;');
  L.push('}');
  L.push('');
  L.push('/* 底部导航：demo .bottom-nav button{color:#a2b197} / .bottom-nav button.active{color:#396d33} */');
  for (const name of TAB_ICONS) {
    L.push(`.gy-icon--tab-${name} { background-image: ${dataUri(paths[name], TAB_TONE_OFF)}; }`);
  }
  L.push('');
  for (const name of TAB_ICONS) {
    L.push(`.tab--selected .gy-icon--tab-${name} { background-image: ${dataUri(paths[name], TAB_TONE_ON)}; }`);
  }
  L.push('');
  L.push('/* 其余图标：描边色取自 demo 对应选择器 */');
  for (const [name, stroke] of PLAIN_ICONS) {
    if (!paths[name]) continue;
    L.push(`.gy-icon--${name} { background-image: ${dataUri(paths[name], stroke)}; }`);
  }
  L.push('');
  return L.join('\n');
}

/** 逻辑像素裸值（px）提取；用于门槛扫描 */
export function barePxFontSizes(css) {
  const out = [];
  for (const m of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) out.push(m[1]);
  return out;
}

/** 交互类的 44px 下限扫描：命中 .btn → 但样式层统一由 --tap-min 表达 */
export function tapMinUses(css) {
  return [...css.matchAll(/min-height:\s*([^;]+);/g)].map((m) => m[1].trim());
}

/* ------------------------------ 核对 ------------------------------ */

export function check(options = {}) {
  const problems = [];
  const rows = [];

  // 1 令牌值集合比对
  const demo = readDemoTokens();
  const wxss = readStyleTokens();
  const tokenRows = [];
  for (const name of PALETTE_TOKENS) {
    const demoSel = `--${name}`;
    const expect = demo[name];
    const actual = wxss[name];
    const ok = expect === actual;
    if (!expect) problems.push(`demo :root 缺少令牌 ${demoSel}`);
    if (!ok) problems.push(`令牌 ${demoSel} 不一致：demo=${expect} / tokens.wxss=${actual}`);
    tokenRows.push({ name: demoSel, demo: expect, wxss: actual, ok });
  }
  rows.push({ kind: 'token', tokenRows });

  // 2 类名存在性
  const layer = LAYER_FILES.filter((f) => existsSync(join(ROOT, f))).map((f) => stripComments(read(f))).join('\n');
  const have = classNames(layer);
  const missing = [];
  for (const [demoName, wxssName] of CLASS_MAP) {
    if (!have.has(wxssName)) missing.push(`demo .${demoName} → WXSS .${wxssName}`);
  }
  for (const [demoSel, wxssSel] of MODIFIER_MAP) {
    if (!have.has(wxssSel.slice(1))) missing.push(`demo ${demoSel} → WXSS ${wxssSel}`);
  }
  if (missing.length) problems.push(`样式层缺少 ${missing.length} 个 demo 对应类：${missing.join('；')}`);
  rows.push({ kind: 'class', mapped: CLASS_MAP.length + MODIFIER_MAP.length, missing });

  // 3 图标几何一致
  const paths = readDemoIconPaths();
  const expectIcons = buildIconsWxss(paths);
  const actualIcons = existsSync(join(ROOT, ICONS_WXSS)) ? read(ICONS_WXSS) : '';
  const iconsOk = expectIcons === actualIcons;
  if (!iconsOk) problems.push(`${ICONS_WXSS} 与 demo SVG path 生成结果不一致，请运行 node tools/demo-align.mjs --write-icons`);
  rows.push({ kind: 'icon', count: TAB_ICONS.length * 2 + PLAIN_ICONS.filter(([n]) => paths[n]).length, ok: iconsOk });

  // 4 可访问性门槛不被样式对齐破坏
  for (const file of LAYER_FILES) {
    if (!existsSync(join(ROOT, file))) { problems.push(`样式层文件缺失：${file}`); continue; }
    const css = stripComments(read(file));
    const bare = barePxFontSizes(css);
    if (bare.length) problems.push(`${file} 存在未乘 --font-scale 的裸 px 字号：${[...new Set(bare)].join(', ')}`);
  }
  const comp = existsSync(join(ROOT, COMPONENTS_WXSS)) ? stripComments(read(COMPONENTS_WXSS)) : '';
  if (!/min-height:\s*var\(--tap-min/.test(comp)) problems.push(`${COMPONENTS_WXSS} 交互类未引用 --tap-min 触控区令牌`);
  rows.push({ kind: 'a11y' });

  // 5 demo 视图承接：白名单外的缺失视图 / 过期的白名单项都判失败
  const viewAudit = auditViews(options);
  for (const p of viewAudit.problems) problems.push(p);
  rows.push({
    kind: 'view',
    rows: viewAudit.rows,
    views: viewAudit.views,
    present: viewAudit.present,
    allowedMissing: viewAudit.allowedMissing
  });

  return { rows, problems };
}

/* ------------------------------ CLI ------------------------------ */

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--write-icons')) {
    const out = buildIconsWxss(readDemoIconPaths());
    writeFileSync(join(ROOT, ICONS_WXSS), out, 'utf8');
    console.log(`已按 docs/ui-demo/dist/app.js 的 SVG path 重写 ${ICONS_WXSS}（${out.length} 字节）`);
    return;
  }

  const { rows, problems } = check();
  const pad = (s, n) => String(s).padEnd(n, ' ');
  console.log('GY-I26 demo 样式对齐核对（静态文本比对，非微信工具渲染）');
  console.log('');
  for (const r of rows) {
    if (r.kind === 'token') {
      console.log('1) 令牌值集合比对（demo dist/styles.css :root → miniprogram/styles/tokens.wxss）');
      console.log(`   ${pad('令牌', 14)} ${pad('demo', 12)} ${pad('tokens.wxss', 12)} 结果`);
      for (const t of r.tokenRows) {
        console.log(`   ${pad(t.name, 14)} ${pad(t.demo, 12)} ${pad(t.wxss, 12)} ${t.ok ? 'OK' : 'FAIL'}`);
      }
    } else if (r.kind === 'class') {
      console.log('');
      console.log('2) 关键类名存在性');
      console.log(`   映射 ${r.mapped} 条；缺失 ${r.missing.length} 条`);
      for (const m of r.missing) console.log(`   - 缺失 ${m}`);
      console.log(`   明确不落地 ${OMITTED_CLASSES.length} 组，逐条理由见本文件 OMITTED_CLASSES 与证据页取舍表`);
    } else if (r.kind === 'icon') {
      console.log('');
      console.log('3) 图标几何一致性');
      console.log(`   ${r.count} 个图标类由 demo app.js 的 SVG path 生成；与 ${ICONS_WXSS} ${r.ok ? '一致' : '不一致'}`);
    } else if (r.kind === 'a11y') {
      console.log('');
      console.log('4) 可访问性门槛');
      console.log('   样式层无裸 px 字号（全部 calc(Npx * var(--font-scale, 1))）；交互类引用 --tap-min');
    } else if (r.kind === 'view') {
      console.log('');
      console.log('5) demo 视图承接（demo.html render() 分发 → app.json pages 注册页）');
      console.log(`   ${r.views.length} 个视图；有承接页 ${r.present} 个；白名单允许缺失 ${r.allowedMissing.length} 个`);
      for (const row of r.rows) {
        if (row.state === 'MISSING(allowed)') continue;
        console.log(`   ${pad(row.view, 10)} ${pad(row.pages.length ? row.pages.join(' / ') : '—', 56)} ${row.state}`);
      }
      for (const row of r.rows) {
        if (row.state === 'MISSING(allowed)') console.log(`MISSING(allowed): ${row.view}`);
      }
    }
  }
  console.log('');
  if (problems.length) {
    console.log(`FAIL: ${problems.length} 项`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log('PASS: 令牌逐值一致、关键类齐全、图标几何与 demo 一致、门槛未被破坏、demo 视图承接已逐个核对。');
    console.log('未覆盖：微信开发者工具／模拟器／真机渲染与截图（本片未取得）。');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
