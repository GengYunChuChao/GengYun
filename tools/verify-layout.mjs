/**
 * GY-I26 布局静态核算（可核对证据）
 * ------------------------------------------------------------
 * 用途：在没有窄屏真机／无法截图的情况下，为「触控区 ≥44px、正文 ≥18px、
 * 末屏内容不被 tabBar 遮挡」提供**可复算的数字**，而不是主观描述。
 *
 * 重要边界：本脚本是**对 WXSS 声明值的静态推算**，不是真机测量。
 * 它不运行微信工具、不测量渲染结果、不替代 GY-I23 的真机验收。
 * 输出中的精确值来自样式声明；估算项为按字符宽度与容器宽度的近似推算。
 *
 * GY-I26 demo 对齐后的改动：
 *   1. 样式层拆到 miniprogram/styles/*.wxss，取值改为在合并后的样式层里查找；
 *   2. 底部 Tab 高度不再硬编码，而是按 custom-tab-bar/index.wxss 的实际声明复算，
 *      并在**微信字体设置最大档（--font-scale = system-font.MAX_FONT_SCALE）**下核对末屏预留——
 *      字号放大后 Tab 会变高，只在标准档通过不算通过；
 *   3. .page 的横向内距允许用 px（对齐 demo .main 的 23px 21px），并据此复算内容宽。
 *
 * 运行：node tools/verify-layout.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
/** 去掉注释：注释里的 demo 原值（例如 .tab 的图标尺寸说明带花括号）会截断选择器块 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const appWxss = stripComments(read('miniprogram/app.wxss'));
const tokensWxss = stripComments(read('miniprogram/styles/tokens.wxss'));
const componentsWxss = stripComments(read('miniprogram/styles/components.wxss'));
const tabWxss = stripComments(read('miniprogram/custom-tab-bar/index.wxss'));
const systemFont = read('miniprogram/utils/system-font.js');
/** 合并样式层：页面实际生效的声明集合（app.wxss 之后是它 @import 的三个文件） */
const styleLayer = appWxss + '\n' + tokensWxss + '\n' + componentsWxss;

/** 视口宽度（px）。750rpx == 视口宽度，这是 rpx 的定义 */
const VIEWPORTS = [
  { w: 320, label: '旧安卓 / SE 一代' },
  { w: 360, label: '主流安卓入门机' },
  { w: 375, label: 'iPhone 8 / X' },
  { w: 414, label: '主流安卓 / iPhone 11' },
  { w: 768, label: '平板' }
];

/** 微信字体设置的最大倍率：从实现里读取，避免与代码漂移 */
const maxScaleMatch = systemFont.match(/MAX_FONT_SCALE\s*=\s*([\d.]+)/);
const MAX_FONT_SCALE = maxScaleMatch ? Number(maxScaleMatch[1]) : null;

const rpx = (v, w) => (v / 750) * w;
const num = (n) => Number(n.toFixed(1));

/** 取选择器块（从 `\n<selector> {` 到配对的第一个 `}`） */
function block(css, selector) {
  const i = css.indexOf(selector + ' {');
  if (i < 0) return null;
  return css.slice(i, css.indexOf('}', i));
}

/** 按选择器块取 px 值；支持 calc(Npx * var(--font-scale, 1)) 的写法，返回 N 的裸值 */
function pxOf(css, selector, prop) {
  const b = block(css, selector);
  if (!b) return null;
  const calc = b.match(new RegExp(`${prop}:\\s*calc\\((\\d+(?:\\.\\d+)?)px`));
  if (calc) return Number(calc[1]);
  const m = b.match(new RegExp(`${prop}:\\s*(\\d+(?:\\.\\d+)?)px`));
  return m ? Number(m[1]) : null;
}

/** 取数值声明（px 单位） */
function numOf(css, selector, prop) {
  const b = block(css, selector);
  if (!b) return null;
  const m = b.match(new RegExp(`${prop}:\\s*(-?\\d+(?:\\.\\d+)?)px`));
  return m ? Number(m[1]) : null;
}

// --tap-min 写作 max(44px, 44px * var(--font-scale,1))，取其下限 44px
const tapMin = (() => {
  const m = appWxss.match(/--tap-min:\s*max\((\d+(?:\.\d+)?)px/);
  return m ? Number(m[1]) : null;
})();
const bodyFont = pxOf(appWxss, 'page', 'font-size');

/** .page 的 padding 三段：横向内距与底部预留（单位各自保留） */
const pagePadding = (() => {
  const b = block(appWxss, '.page');
  if (!b) return null;
  const m = b.match(/padding:\s*(\d+(?:\.\d+)?)(px|rpx)\s+(\d+(?:\.\d+)?)(px|rpx)\s+calc\((\d+(?:\.\d+)?)(px|rpx)/);
  if (!m) return null;
  return {
    padY: { value: Number(m[1]), unit: m[2] },
    padX: { value: Number(m[3]), unit: m[4] },
    padBottom: { value: Number(m[5]), unit: m[6] }
  };
})();

/** 底部五 Tab 的实际声明（custom-tab-bar/index.wxss），用于复算末屏预留 */
const tabBar = (() => {
  const barBlock = block(tabWxss, '.tab-bar');
  const tabBlock = block(tabWxss, '\n.tab');
  const textBlock = block(tabWxss, '.tab__text');
  const identifyBlock = block(tabWxss, '.tab--identify');
  if (!barBlock || !tabBlock || !textBlock || !identifyBlock) return null;
  const barPad = barBlock.match(/padding:\s*(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px\s+calc\((\d+(?:\.\d+)?)px/);
  // 纵向内距取 padding 的第一个值；横向在窄屏为 0 或省略单位，不做解析
  const tabPad = tabBlock.match(/padding:\s*(\d+(?:\.\d+)?)px/);
  const gap = tabBlock.match(/gap:\s*(\d+(?:\.\d+)?)px/);
  const icon = tabBlock.match(/--gy-icon-size:\s*(\d+(?:\.\d+)?)px/);
  const idPad = identifyBlock.match(/padding:\s*(\d+(?:\.\d+)?)px/);
  const idIcon = identifyBlock.match(/--gy-icon-size:\s*(\d+(?:\.\d+)?)px/);
  const idLift = identifyBlock.match(/margin-top:\s*(-?\d+(?:\.\d+)?)px/);
  const labelFont = textBlock.match(/font-size:\s*calc\((\d+(?:\.\d+)?)px/);
  const labelLine = textBlock.match(/line-height:\s*([\d.]+)/);
  if (!barPad || !tabPad || !gap || !icon || !idPad || !idIcon || !idLift || !labelFont || !labelLine) return null;
  return {
    padY: Number(barPad[1]),
    padBottom: Number(barPad[3]),
    tabPadY: Number(tabPad[1]),
    gap: Number(gap[1]),
    icon: Number(icon[1]),
    idPadY: Number(idPad[1]),
    idIcon: Number(idIcon[1]),
    idLift: Math.abs(Number(idLift[1])),
    labelFont: Number(labelFont[1]),
    labelLine: Number(labelLine[1])
  };
})();

/** 标准档与微信最大档下的 Tab 高度（px）。字号随 --font-scale 放大，图标同样放大。 */
function tabBarHeight(scale) {
  const label = tabBar.labelFont * scale * tabBar.labelLine;
  const floor = Math.max(tapMin, tapMin * scale);
  const tabH = Math.max(floor, tabBar.icon * scale + tabBar.gap + label + tabBar.tabPadY * 2);
  const idH = Math.max(floor, tabBar.idIcon * scale + tabBar.gap + label + tabBar.idPadY * 2) - tabBar.idLift;
  return num(tabBar.padY + tabBar.padBottom + Math.max(tabH, idH));
}

const problems = [];
const rows = [];

// 解析失败必须显式失败：不得因取不到声明值而给出 PASS（避免缺验证的绿灯）
if (tapMin === null) problems.push('未能从 app.wxss 解析 --tap-min，触控区门槛未验证');
if (bodyFont === null) problems.push('未能从 app.wxss 解析正文字号，正文门槛未验证');
if (!pagePadding) problems.push('未能从 app.wxss 解析 .page 的 padding 三段，末屏与内容宽门槛未验证');
if (pagePadding && pagePadding.padBottom.unit !== 'px') {
  problems.push(`末屏预留以 ${pagePadding.padBottom.unit} 声明（${pagePadding.padBottom.value}${pagePadding.padBottom.unit}），会随视口缩放，应改用 px`);
}
if (!tabBar) problems.push('未能从 custom-tab-bar/index.wxss 解析底部 Tab 的尺寸声明，末屏预留门槛未验证');
if (MAX_FONT_SCALE === null) problems.push('未能从 utils/system-font.js 解析 MAX_FONT_SCALE，最大字号档的末屏预留未验证');

const heroTitleFont = pxOf(styleLayer, '\n.hero__title', 'font-size') ?? pxOf(styleLayer, '.hero__title', 'font-size');
const heroSubFont = pxOf(styleLayer, '\n.hero__sub', 'font-size') ?? pxOf(styleLayer, '.hero__sub', 'font-size');
const cardDescFont = pxOf(styleLayer, '\n.feature-card__desc', 'font-size') ?? pxOf(styleLayer, '.feature-card__desc', 'font-size');
const heroPadX = (() => {
  const b = block(styleLayer, '\n.hero') || block(styleLayer, '.hero');
  if (!b) return null;
  const m = b.match(/padding:\s*(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px/);
  return m ? Number(m[2]) : null;
})();
if (heroTitleFont === null) problems.push('未能定位 .hero__title 的字号，主标题换行估算未验证');
if (heroSubFont === null) problems.push('未能定位 .hero__sub 的字号，副标题换行估算未验证');
if (cardDescFont === null) problems.push('未能定位 .feature-card__desc 的字号，首页入口描述换行估算未验证');
if (heroPadX === null) problems.push('未能定位 .hero 的横向内距，主标题换行估算未验证');

const tabH1 = tabBar ? tabBarHeight(1) : NaN;
const tabHMax = tabBar && MAX_FONT_SCALE !== null ? tabBarHeight(MAX_FONT_SCALE) : NaN;

for (const { w, label } of VIEWPORTS) {
  const padXValue = pagePadding ? (pagePadding.padX.unit === 'px' ? pagePadding.padX.value : rpx(pagePadding.padX.value, w)) : NaN;
  const contentW = num(w - padXValue * 2);
  const bottomPad = pagePadding
    ? num(pagePadding.padBottom.unit === 'px' ? pagePadding.padBottom.value : rpx(pagePadding.padBottom.value, w))
    : NaN;
  const heroInner = heroPadX === null ? NaN : num(contentW - heroPadX * 2);

  if (tapMin !== null && tapMin < 44) problems.push(`${w}px 触控区 ${tapMin}px < 44px`);
  if (bodyFont !== null && bodyFont < 18) problems.push(`${w}px 正文 ${bodyFont}px < 18px`);
  if (Number.isNaN(bottomPad)) {
    problems.push(`${w}px 末屏预留无法计算，门槛未验证`);
  } else if (!Number.isNaN(tabHMax) && bottomPad < tabHMax) {
    problems.push(`${w}px 底部预留 ${bottomPad}px < 最大字号档 tabBar ${tabHMax}px，末屏内容将被遮挡`);
  }

  // 估算项：1 汉字≈1em，ASCII≈0.5em
  const est = (text, fontPx, boxW) => {
    if (Number.isNaN(boxW) || !fontPx) return NaN;
    let em = 0;
    for (const ch of text) em += /[\x00-\xff]/.test(ch) ? 0.5 : 1;
    return Math.max(1, Math.ceil((em * fontPx) / boxW));
  };

  rows.push({
    viewport: `${w}px`,
    device: label,
    contentW,
    heroInnerW: heroInner,
    tapH: tapMin,
    bodyFont,
    bottomPad,
    titleLines: est('识草查药，除草不求人', heroTitleFont, heroInner),
    subLines: est('识草查药与除草科普社区', heroSubFont, heroInner),
    descLines: est('拍一张照片，识别田里的杂草', cardDescFont, contentW - 24 * 2 - 60)
  });
}

const pad = (s, n) => String(s).padEnd(n, ' ');
console.log('GY-I26 布局静态核算（对 WXSS 声明值的推算，非真机测量）');
console.log('');
console.log('视口     设备                内容宽  触控区  正文   底部预留  主标题 副标题 入口描述');
console.log('-'.repeat(88));
for (const r of rows) {
  const mark = Number.isNaN(tabHMax) ? '' : r.bottomPad < tabHMax ? ' !' : '';
  console.log(
    `${pad(r.viewport, 8)} ${pad(r.device, 19)} ${pad(r.contentW, 6)} ${pad(r.tapH + 'px', 6)} ` +
    `${pad(r.bodyFont + 'px', 6)} ${pad(r.bottomPad + 'px' + mark, 8)} ${pad(r.titleLines, 6)} ${pad(r.subLines, 6)} ${r.descLines}`
  );
}
console.log('-'.repeat(88));
if (pagePadding) {
  console.log(`底部预留来源：.page 的 padding-bottom 声明为 calc(${pagePadding.padBottom.value}${pagePadding.padBottom.unit} + env(safe-area-inset-bottom))。`);
  console.log(`横向内距：${pagePadding.padX.value}${pagePadding.padX.unit}（对齐 demo .main 的 21px）。`);
}
if (tabBar) {
  console.log(`底部 Tab 高度（按声明复算）：标准档 ${tabH1}px；最大字号档 ${MAX_FONT_SCALE} 倍 → ${tabHMax}px。`);
  console.log(`  组成：Tab 容器上下内距 ${tabBar.padY}+${tabBar.padBottom}px；图标 ${tabBar.icon}px（识别 ${tabBar.idIcon}px，上移 ${tabBar.idLift}px）；`);
  console.log(`        标签 ${tabBar.labelFont}px × 行高 ${tabBar.labelLine}；间距 ${tabBar.gap}px；触控下限 ${tapMin}px。`);
}
console.log(`末屏判定：预留需 ≥ **最大字号档** tabBar ${tabHMax}px（字号放大后 Tab 变高，只在标准档通过不算通过）。`);
console.log('换行数为估算：1 汉字≈1em，ASCII≈0.5em；实际换行取决于字体度量与两端对齐。');

if (problems.length) {
  console.log('');
  console.log(`FAIL: ${problems.length} 项不满足门槛`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log('');
  console.log('PASS: 五档视口下触控区、正文与末屏预留（含最大字号档）均满足门槛。');
}
