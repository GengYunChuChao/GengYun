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
 * 运行：node tools/verify-layout.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const appWxss = read('miniprogram/app.wxss');
const homeWxss = read('miniprogram/pages/home/home.wxss');

/** 视口宽度（px）。750rpx == 视口宽度，这是 rpx 的定义 */
const VIEWPORTS = [
  { w: 320, label: '旧安卓 / SE 一代' },
  { w: 360, label: '主流安卓入门机' },
  { w: 375, label: 'iPhone 8 / X' },
  { w: 414, label: '主流安卓 / iPhone 11' },
  { w: 768, label: '平板' }
];

/** 微信原生 tabBar 高度为固定值，不随屏宽变化 */
const TABBAR_H = 50;

const rpx = (v, w) => (v / 750) * w;
const num = (n) => Number(n.toFixed(1));

function pxValue(css, prop) {
  const m = css.match(new RegExp(`${prop}:\\s*(\\d+(?:\\.\\d+)?)px`));
  return m ? Number(m[1]) : null;
}
/** 按选择器块精确取值，避免取到同文件其它选择器的字号 */
function pxOf(css, selector, prop) {
  const i = css.indexOf(`${selector} {`);
  if (i < 0) return null;
  const block = css.slice(i, css.indexOf('}', i));
  // 标准字号写在 calc(Npx * var(--font-scale, 1)) 中，此处取 N 的裸值
  const calc = block.match(new RegExp(`${prop}:\\s*calc\\((\\d+(?:\\.\\d+)?)px`));
  if (calc) return Number(calc[1]);
  const m = block.match(new RegExp(`${prop}:\\s*(\\d+(?:\\.\\d+)?)px`));
  return m ? Number(m[1]) : null;
}
function rpxValue(css, prop) {
  const m = css.match(new RegExp(`${prop}:\\s*(\\d+(?:\\.\\d+)?)rpx`));
  return m ? Number(m[1]) : null;
}

// --tap-min 写作 max(44px, 44px * var(--font-scale,1))，取其下限 44px
const tapMin = (() => {
  const m = appWxss.match(/--tap-min:\s*max\((\d+(?:\.\d+)?)px/);
  if (m) return Number(m[1]);
  return pxValue(appWxss, '--tap-min');
})();
const bodyFont = pxOf(appWxss, 'page', 'font-size');
const heroPadX = rpxValue(homeWxss, 'padding');
const titleFont = pxOf(homeWxss, '.hero__title', 'font-size');
const subFont = pxOf(homeWxss, '.hero__sub', 'font-size');
const entryDescFont = pxOf(homeWxss, '.entry__desc', 'font-size');
/** .page 的 padding-bottom 声明（不含 env()）：须支持 calc(Npx) 与 calc(Nrpx) */
const padBottomVal = (() => {
  const m = appWxss.match(/padding:\s*\d+rpx\s+\d+rpx\s+calc\((\d+)(px|rpx)/);
  return m ? { value: Number(m[1]), unit: m[2] } : null;
})();

const problems = [];
const rows = [];

// 解析失败必须显式失败：不得因取不到声明值而给出 PASS（避免缺验证的绿灯）
if (tapMin === null) problems.push('未能从 app.wxss 解析 --tap-min，触控区门槛未验证');
if (bodyFont === null) problems.push('未能从 app.wxss 解析正文字号，正文门槛未验证');
if (!padBottomVal) problems.push('未能从 app.wxss 解析 .page 的 padding-bottom，末屏预留门槛未验证');
if (titleFont === null) problems.push('未能定位 .hero__title 的字号，主标题换行估算未验证');
if (subFont === null) problems.push('未能定位 .hero__sub 的字号，副标题换行估算未验证');
if (entryDescFont === null) problems.push('未能定位 .entry__desc 的字号，入口描述换行估算未验证');
if (padBottomVal && padBottomVal.unit !== 'px') {
  problems.push(`末屏预留以 ${padBottomVal.unit} 声明（${padBottomVal.value}${padBottomVal.unit}），会随视口缩放，应改用 px`);
}

for (const { w, label } of VIEWPORTS) {
  const padX = num(rpx(28, w) * 2);
  const contentW = num(w - padX);
  const bottomPad = padBottomVal
    ? num(padBottomVal.unit === 'px' ? padBottomVal.value : rpx(padBottomVal.value, w))
    : NaN;
  const heroInner = num(contentW - rpx(heroPadX, w) * 2);

  if (tapMin !== null && tapMin < 44) problems.push(`${w}px 触控区 ${tapMin}px < 44px`);
  if (bodyFont !== null && bodyFont < 18) problems.push(`${w}px 正文 ${bodyFont}px < 18px`);
  if (Number.isNaN(bottomPad)) {
    problems.push(`${w}px 末屏预留无法计算，门槛未验证`);
  } else if (bottomPad < TABBAR_H) {
    problems.push(`${w}px 底部预留 ${bottomPad}px < tabBar ${TABBAR_H}px，末屏内容将被遮挡`);
  }

  // 估算项：1 汉字≈1em，ASCII≈0.5em
  const est = (text, fontPx, boxW) => {
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
    titleLines: est('识草查药，除草不求人', titleFont, heroInner),
    subLines: est('识草查药与除草科普社区', subFont, heroInner),
    entryDescLines: est('拍一张照片，识别田里的杂草', entryDescFont, contentW - rpx(24, w) * 2 - rpx(96, w))
  });
}

const pad = (s, n) => String(s).padEnd(n, ' ');
console.log('GY-I26 布局静态核算（对 WXSS 声明值的推算，非真机测量）');
console.log('');
console.log('视口     设备                内容宽  触控区  正文   底部预留  主标题 副标题 入口描述');
console.log('-'.repeat(88));
for (const r of rows) {
  const mark = r.bottomPad < TABBAR_H ? ' !' : '';
  console.log(
    `${pad(r.viewport, 8)} ${pad(r.device, 19)} ${pad(r.contentW, 6)} ${pad(r.tapH + 'px', 6)} ` +
    `${pad(r.bodyFont + 'px', 6)} ${pad(r.bottomPad + 'px' + mark, 8)} ${pad(r.titleLines, 6)} ${pad(r.subLines, 6)} ${r.entryDescLines}`
  );
}
console.log('-'.repeat(88));
console.log(`底部预留来源：.page 的 padding-bottom 声明为 calc(${padBottomVal ? padBottomVal.value + padBottomVal.unit : '解析失败'} + env(safe-area-inset-bottom))。`);
console.log(`末屏判定：预留需 ≥ tabBar ${TABBAR_H}px。px 为绝对值不随视口变化；rpx 会被缩放，故窄屏下不足。`);
console.log('换行数为估算：1 汉字≈1em，ASCII≈0.5em；实际换行取决于字体度量与两端对齐。');

if (problems.length) {
  console.log('');
  console.log(`FAIL: ${problems.length} 项不满足门槛`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log('');
  console.log('PASS: 五档视口下触控区、正文与末屏预留均满足门槛。');
}
