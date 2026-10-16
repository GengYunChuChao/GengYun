import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

function component(name) {
  let definition;
  const source = readFileSync(join('miniprogram', 'components', name, `${name}.js`), 'utf8');
  vm.runInNewContext(source, { Component(value) { definition = value; } }, { filename: name });
  return definition;
}

function instance(definition, data) {
  const emitted = [];
  const context = { data, triggerEvent(name, detail) { emitted.push({ name, detail }); } };
  return { context, emitted, methods: definition.methods };
}

test('button and chip do not emit while disabled or loading', () => {
  const button = component('gy-ui-button');
  const chip = component('gy-ui-chip');
  const b = instance(button, { disabled: false, loading: false });
  b.methods.onTap.call(b.context);
  b.context.data.loading = true;
  b.methods.onTap.call(b.context);
  b.context.data.loading = false;
  b.context.data.disabled = true;
  b.methods.onTap.call(b.context);
  assert.deepEqual(b.emitted.map(event => event.name), ['tap']);
  const c = instance(chip, { disabled: false, value: 'all', selected: false });
  c.methods.onTap.call(c.context);
  c.context.data.disabled = true;
  c.methods.onTap.call(c.context);
  assert.equal(c.emitted.length, 1);
  assert.equal(c.emitted[0].detail.value, 'all');
  assert.equal(c.emitted[0].detail.selected, true);
});

test('search emits controlled input, keyboard confirmation and clear', () => {
  const search = component('gy-ui-search');
  const s = instance(search, { disabled: false });
  s.methods.onInput.call(s.context, { detail: { value: '草' } });
  s.methods.onConfirm.call(s.context, { detail: { value: '草' } });
  s.methods.onClear.call(s.context);
  assert.deepEqual(s.emitted.map(event => event.name), ['input', 'confirm', 'clear']);
  assert.deepEqual(s.emitted.map(event => event.detail.value), ['草', '草', '']);
  s.context.data.disabled = true;
  s.methods.onInput.call(s.context, { detail: { value: 'x' } });
  s.methods.onConfirm.call(s.context, { detail: { value: 'x' } });
  s.methods.onClear.call(s.context);
  assert.equal(s.emitted.length, 3);
});

test('specimen host writes back search confirmation and chip selection', () => {
  let page;
  // 兜底说明：`miniprogram/pages/specimen/specimen.js` 只 require `../../utils/font-scale` 与
  // `../../utils/debug` 两条，这里各给一个**最小壳**（`{}`，**非真实模块**）—— 本用例只验
  // onKitConfirm/onKitSelect/onKitClear 的受控回写，不验字号与本地诊断。
  // 改前是 `require() { return {}; }` 的 blanket：specimen.js 将来新增任何 require 都会被静默喂成空壳。
  // 现在按**完整说明符**登记，未登记 ⇒ 显式失败并带依赖名（已登记项的取值与改前逐字相同）。
  const specimenDependencies = new Map([
    ['../../utils/font-scale', {}],
    ['../../utils/debug', {}],
  ]);
  vm.runInNewContext(readFileSync('miniprogram/pages/specimen/specimen.js', 'utf8'), {
    require(id) { if (!specimenDependencies.has(id)) throw Error('Unexpected page dependency ' + id); return specimenDependencies.get(id); },
    Page(value) { page = value; }
  });
  const data = {};
  const host = { setData(value) { Object.assign(data, value); } };
  page.onKitConfirm.call(host, { detail: { value: '草' } });
  assert.equal(data.kitQuery, '草');
  assert.equal(data.kitStatus, 'loading');
  page.onKitSelect.call(host, { detail: { value: '科普', selected: true } });
  assert.equal(data.kitSelected, '科普');
  page.onKitClear.call(host);
  assert.equal(data.kitQuery, '');
});
