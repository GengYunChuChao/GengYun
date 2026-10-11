import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
function accessible(wxml, css) {
  for (const tag of wxml.matchAll(/<button\b[^>]*>/g)) if (!/class="[^"]*\bbtn\b/.test(tag[0])) return false;
  for (const selector of ['.knowledge-page .btn', '.knowledge-page .back-button']) {
    const rule = css.slice(css.indexOf(selector + ' {')).split('}')[0];
    if (!/font-size:\s*inherit\s*;/.test(rule) || !/min-height:\s*max\(44px, 44px \* var\(--font-scale, 1\)\)/.test(rule)) return false;
  }
  return true;
}
const detail = read('miniprogram/pages/knowledgedetail/knowledgedetail.wxml');
const css = read('miniprogram/pages/knowledgedetail/knowledgedetail.wxss');
test('knowledge controls retain shared font and scaled touch target', () => {
  assert.ok(accessible(detail, css));
  assert.match(read('miniprogram/app.wxss'), /font-size:\s*calc\(18px \* var\(--font-scale, 1\)\)/);
});
test('negative controls reject lost btn, lost inherited font and shrunken touch target', () => {
  assert.equal(accessible(detail.replace('btn btn--ghost back-button', 'back-button'), css), false);
  assert.equal(accessible(detail, css.replaceAll('font-size: inherit;', 'font-size: 12px;')), false);
  assert.equal(accessible(detail, css.replaceAll('min-height: max(44px, 44px * var(--font-scale, 1))', 'min-height: 32px')), false);
});
test('Demo visual assets are packaged; source stats and safe wrapping remain', () => {
  const packing = read('tools/prepare-wechat.mjs');
  for (const name of ['leaf', 'search', 'back']) {
    assert.ok(packing.includes('assets/knowledge/' + name + '.png'));
    assert.equal(readFileSync(new URL('../../miniprogram/assets/knowledge/' + name + '.png', import.meta.url)).subarray(1,4).toString(), 'PNG');
  }
  assert.match(detail, /stat-grid/); assert.match(css, /word-break:\s*break-all/);
});
