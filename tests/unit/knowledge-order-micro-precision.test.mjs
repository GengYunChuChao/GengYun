// GY-I07 / #7 · 排序键的**微秒**精度（比较器半边：纯单元，不连任何库）。
//
// 背景（已复现的缺陷，见 `docs/verification/gy-r33-contract-ledger-20261023.md` §3.6）：
//   PG 的 `timestamptz` 是**微秒**精度，而驱动（`pg` / PGlite）把它解成 JS `Date`（只有毫秒）。
//   旧比较器用 `getTime()` / `Date.parse()` 取毫秒 ⇒ 同毫秒内两条记录变「同刻」并退 `id DESC`，
//   与 SQL 的 `ORDER BY created_at DESC` **相反**。用户裁定「以 SQL 全精度为准」，故：
//     · 时间分量按**微秒**比（读语句投影的内部列 `created_at_micros` 优先，其次解析 `created_at`）；
//     · 只有**完全同刻**才退 `id DESC`，且 id 逐码元比较（不用 `localeCompare`）。
//
// 五条判据：
//   ① 0/1/3/6 位小数与 `Date` 指同一个时间点（同一 id 下比较必须为 0）；
//   ② 亚毫秒反序 tie：`.000500Z` 必须排在 `.000100Z` 之前，**尽管 id 顺序相反**（截到毫秒即变红）；
//   ③ 完全同刻才退 id，且是逐码元（用 `'A'`/`'a'` 证明不是 `localeCompare`）；
//   ④ NULL / 缺字段 / 不可解析 ⇒ `-Infinity` 确定性排最后（内部仍 `id DESC`），且**不抛错**；
//   ⑤ 内部列 `created_at_micros` 优先于毫秒 `created_at`；该列不可解析时回落，口径不退化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareKnowledgeRows } from '../../services/api/src/knowledge/service.ts';

const order = (rows) => [...rows].sort(compareKnowledgeRows).map((row) => row.id);
const cmp = (a, b) => compareKnowledgeRows(a, b);
const row = (id, created_at) => ({ id, created_at });

/** §3.6 的两行：X 的 micro 更新（`.000500Z`），但 id **低**于 Y（`aaaa…`）。 */
const X = { id: '11111111-1111-4111-8111-111111111111', created_at: '2026-10-20T12:00:00.000500Z' };
const Y = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', created_at: '2026-10-20T12:00:00.000100Z' };
const SAME = '2026-10-20T12:00:00.000000Z';

test('① 小数位：0/1/3/6 位与 Date 解析到同一时间点（同一 id 下必须为 0）', () => {
  const values = ['2026-10-20T12:00:00Z', '2026-10-20T12:00:00.0Z', '2026-10-20T12:00:00.000Z',
    '2026-10-20T12:00:00.000000Z', '2026-10-20T12:00:00.000000+00:00', new Date('2026-10-20T12:00:00Z')];
  for (const value of values) {
    assert.equal(cmp(row('same-id', value), row('same-id', SAME)), 0,
      `小数位不同但时间点相同 ⇒ 必须判同刻，实际输入：${String(value)}`);
  }
  // 6 位小数的分辨力：`.000001Z` 比 `.000000Z` 新（毫秒口径下两者同值 ⇒ 本条即变红）。
  assert.equal(cmp(row('a', '2026-10-20T12:00:00.000001Z'), row('a', SAME)), -1, '1 微秒之差必须分得出');
  assert.equal(cmp(row('a', SAME), row('a', '2026-10-20T12:00:00.000001Z')), 1, '反向比较必须对称');
});

test('② 亚毫秒反序 tie：时间新的在前，哪怕 id 顺序相反（截到毫秒即变红）', () => {
  assert.ok(X.id < Y.id, '夹具前提：X 的 id 逐码元低于 Y（id DESC 会把 Y 排前面）');
  assert.deepEqual(order([X, Y]), [X.id, Y.id], 'SQL 全精度序：X（.000500Z）在 Y（.000100Z）之前');
  assert.deepEqual(order([Y, X]), [X.id, Y.id], '与输入顺序无关（比较器必须自洽）');
  // 分辨力自证：把两者压到同一毫秒后，次序**必须**反过来 —— 证明本夹具能分辨「毫秒」与「微秒」两种实现。
  const flattened = [{ ...X, created_at: '2026-10-20T12:00:00.000Z' }, { ...Y, created_at: '2026-10-20T12:00:00.000Z' }];
  assert.deepEqual(order(flattened), [Y.id, X.id],
    '同毫秒下必须由 id DESC 决出相反次序（否则本夹具对"截到毫秒"无分辨力）');
});

test('③ 完全同刻才退 id，且逐码元（不用 localeCompare）', () => {
  // 字节序：'A'(0x41) < 'a'(0x61)；ICU 的 localeCompare 给相反结果 ⇒ 两种实现可分辨。
  const lower = row('00000000-0000-4000-8000-00000000000a', SAME);
  const upper = row('00000000-0000-4000-8000-00000000000A', SAME);
  assert.equal('a' < 'A', false, '口径自证：逐码元比较里 a(0x61) > A(0x41)');
  assert.ok('a'.localeCompare('A') < 0, '口径自证：本机 ICU 排序与逐码元相反（故本条能分辨两种实现）');
  assert.deepEqual(order([upper, lower]), [lower.id, upper.id], 'id DESC 必须按码元降序：小写 a 在前');
  assert.deepEqual(order([lower, upper]), [lower.id, upper.id], '输入顺序不得影响结果');
  // 完全相等（同 id 同刻）必须返回 0，比较器才满足全序要求。
  assert.equal(cmp(row('same', SAME), row('same', SAME)), 0);
});

test('④ NULL / 缺字段 / 不可解析 ⇒ -Infinity 确定性排最后，且不抛错', () => {
  const rows = [
    { id: 'n1', created_at: null },
    { id: 'n2' },
    { id: 'n3', created_at: 'not-a-date' },
    { id: 'n4', created_at: {} },
    { id: 'v1', created_at: '2026-10-19T00:00:00Z' },
  ];
  assert.doesNotThrow(() => order(rows), '不可解析值不得抛错（既有口径：确定性排最后）');
  assert.deepEqual(order(rows), ['v1', 'n4', 'n3', 'n2', 'n1'],
    '可解析行在前；不可解析组一律 -Infinity，组内仍按 id DESC 逐码元');
  // 不可解析行的相对次序必须与输入顺序无关（确定性）。
  assert.deepEqual(order([...rows].reverse()), ['v1', 'n4', 'n3', 'n2', 'n1']);
  // 微秒新行必须排在「不可解析组」之前，哪怕该行的 id 最低。
  assert.deepEqual(order([{ id: 'zzz', created_at: '2026-10-19T00:00:00.000001Z' }, { id: 'n1', created_at: null }]),
    ['zzz', 'n1']);
});

test('⑤ 内部列 created_at_micros 优先于毫秒 created_at；坏值回落不退化', () => {
  // 两行的 created_at 已被驱动截到同一毫秒，只有内部列分得出先后。
  const p = { id: 'p', created_at: '2026-10-20T12:00:00.000Z', created_at_micros: '1792497600000100' };
  const q = { id: 'q', created_at: '2026-10-20T12:00:00.000Z', created_at_micros: '1792497600000500' };
  assert.deepEqual(order([p, q]), ['q', 'p'], '内部列（微秒）必须压过毫秒 created_at');
  assert.deepEqual(order([q, p]), ['q', 'p']);
  assert.equal(cmp({ ...p, created_at_micros: 1792497600000100 }, { ...p, created_at_micros: '1792497600000100' }), 0,
    '同一微秒时数值与十进制文本必须等价');
  // 内部列不可解析 ⇒ 回落到 created_at（而不是把整行当 -Infinity，也不是抛错）。
  const fallback = { id: 'r', created_at: '2026-10-20T12:00:00Z', created_at_micros: 'oops' };
  assert.deepEqual(order([fallback, { id: 's', created_at: '2026-10-19T00:00:00Z' }]), ['r', 's']);
  // 内部列超出安全整数 ⇒ 同样回落，不产生 NaN 静默改序。
  const unsafe = { id: 't', created_at: '2026-10-18T00:00:00Z', created_at_micros: '99999999999999999' };
  assert.deepEqual(order([unsafe, { id: 'u', created_at: '2026-10-19T00:00:00Z' }]), ['u', 't']);
});
