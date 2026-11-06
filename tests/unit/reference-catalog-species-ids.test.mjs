/**
 * `assertSpeciesIds` 的负控制（`#1014`）。
 *
 * 为什么要有这个文件：`#1015` 给 `catalog.mjs` 加了「id 非空且唯一」的校验，但审查指出它**没有负控制**——
 * `loadCatalog()` 读固定路径、没有注入点，构造坏目录要么改真实 JSON、要么 mock fs。把校验抽成纯函数后，
 * 「缺 id / 重复 / 只有空格 / 非数组」这几种形态都能直接喂进去断言，而不必改动任何真实文件。
 *
 * 边界：本文件只测这一个纯函数；`loadCatalog()` 的完整装载行为仍由既有 `catalog-species-api` 等用例覆盖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { assertSpeciesIds } from '../../packages/reference/catalog.mjs';

const SPECIES_IDS = [
  'species_barnyardgrass',
  'species_foxtail',
  'species_nettle_group',
  'species_crabgrass',
  'species_goosegrass',
  'species_shortawn_foxtail',
  'species_lambsquarters',
  'species_alligatorweed',
];

const row = (id) => ({ id, coverage_state: 'planned' });

test('合法目录：原样返回 trim 后的 id，顺序不变', () => {
  const ids = assertSpeciesIds(SPECIES_IDS.map(row));
  assert.deepEqual(ids, SPECIES_IDS);
});

test('负控制：缺 id 必须抛错，且错误信息点出是「缺少 id」', () => {
  assert.throws(() => assertSpeciesIds([...SPECIES_IDS.slice(1).map(row), { coverage_state: 'planned' }]), /species 条目缺少 id/);
});

test('负控制：id 只有空白必须抛错', () => {
  assert.throws(() => assertSpeciesIds([row('   ')]), /species 条目缺少 id/);
});

test('负控制：id 非字符串必须抛错', () => {
  assert.throws(() => assertSpeciesIds([row(42)]), /species 条目缺少 id/);
});

test('负控制：重复 id 必须抛错，且信息里带出重复的那个 id', () => {
  assert.throws(
    () => assertSpeciesIds([row('species_barnyardgrass'), row('species_barnyardgrass')]),
    /species id 重复：species_barnyardgrass/,
  );
});

test('负控制：trim 后才相同的 id 也算重复（`" species_x"` 与 `"species_x"`）', () => {
  assert.throws(
    () => assertSpeciesIds([row('species_barnyardgrass'), row(' species_barnyardgrass ')]),
    /species id 重复：species_barnyardgrass/,
  );
});

test('负控制：入参不是数组必须抛错（防止把 undefined 当空目录静默接受）', () => {
  assert.throws(() => assertSpeciesIds(undefined), /species 列表不是数组/);
  assert.throws(() => assertSpeciesIds({ species: [] }), /species 列表不是数组/);
});

test('空数组是合法输入（闭集为空由装配侧 fail-closed 拒绝，不在这里抛）', () => {
  assert.deepEqual(assertSpeciesIds([]), []);
});
