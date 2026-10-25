// GY-R35 · `/me/exports` 越枚举的「写入侧改写」· 契约口径双钉（读 + 写两侧）。
//
// 缺陷回顾：账本行被 `/me/exports` 原样投影成 `Export.object_ref`
// （`packages/privacy/egress.mjs:388`：`type: record.objectType, id: record.objectId`），
// 而契约 `TargetRef.type` 是 16 值闭集、`TargetRef.id` 是 `minLength: 1 / maxLength: 80`。
// 写入侧过去会写两个闭集外的类型（`conversation_turn` / `checked_content`），历史行由迁移
// `services/api/db/migrations/0040_export_object_key_contract_backfill.sql` 回填。
//
// 本文件钉的是**不变量**，逐条对应片自证要求：
//   ① 契约镜像双向逐字相等 —— `EXPORT_OBJECT_TYPES` ⇄ `TargetRef.type.enum`（手写镜像，无生成器）；
//   ② 长度上限同一个数 —— `EXPORT_OBJECT_ID_MAX` === `TargetRef.id.maxLength` === 写入侧 `OBJECT_KEY_MAX`；
//   ③ 两个**旧的越界类型**各一条负例（`conversation_turn`、`checked_content`）⇒ `PROVIDER_UNAVAILABLE`；
//   ④ 去前缀后的裸 id：80 字符通过 / 81 字符拒绝 / 空串拒绝（契约 `minLength`）；
//   ⑤ `media` 维行不受影响（`object_id` 真实 uuid、`object_key IS NULL` 的方言）—— 原样投影。
//   ⑥ 写入侧源码不再产出闭集外类型（`checked_content` 的**合法**用途只剩 `data_type` 维度）。
//
// 否定方案（不要"修"成这两样，实测都会让整页 503）：
//   · 扩契约枚举迁就账本（终态不允许，且账本会被反向绑死）；
//   · 投影 fail-closed 到"跳过坏行"（整页 `page.items.map(toContractExport)` 单条抛错即整页 503）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXPORT_OBJECT_ID_MAX, EXPORT_OBJECT_TYPES, EXPORT_STATES } from '../../packages/privacy/constants.mjs';
import { toContractExport } from '../../packages/privacy/egress.mjs';
import { PrivacyError } from '../../packages/privacy/errors.mjs';
import { SYNTHESIS_TARGET_TYPES } from '../../services/api/src/tts/state.ts';

const CONTRACT = JSON.parse(
  readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'),
);
const TARGET_REF = CONTRACT.components.schemas.TargetRef;
/** 契约 `TargetRef.type` 闭集（唯一权威：`packages/contracts/openapi.json`）。 */
const CONTRACT_TYPES = TARGET_REF.properties.type.enum;

const src = (relative) => readFileSync(new URL('../../services/api/src/privacy/' + relative, import.meta.url), 'utf8');
const LEDGER_PG = src('ledger-pg.ts');
const TASK_EGRESS = src('task-egress.ts');
const SYNTHESIS_EGRESS = src('synthesis-egress.ts');

/** 合法账本行（`media` 维：`object_id` 真实 uuid、`object_key` 为 NULL）。 */
const MEDIA_RECORD = Object.freeze({
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  objectType: 'media',
  objectId: '0f3b8c1e-0000-4000-8000-0000000000ab',
  objectRevision: 2,
  consentEpoch: 1,
  state: 'sent',
  recipientId: 'recipient-llm-1',
  purpose: 'media_processing',
  sentAt: '2026-10-25T00:00:00.000Z',
  deletionState: 'not_requested',
});
const unavailable = (err) => err instanceof PrivacyError && err.code === 'PROVIDER_UNAVAILABLE';

test('契约镜像①：EXPORT_OBJECT_TYPES 与 TargetRef.type 双向逐字相等（16 值，含顺序）', () => {
  assert.equal(CONTRACT_TYPES.length, 16, '契约 TargetRef.type 应是 16 值闭集');
  assert.deepEqual([...EXPORT_OBJECT_TYPES], [...CONTRACT_TYPES], '镜像必须逐字同序，多/少/改名都会让读面与契约脱节');
  // 反向逐值存在性：上面 deepEqual 已覆盖，这里再钉一次"不许有第 17 个值"。
  for (const type of EXPORT_OBJECT_TYPES) assert.ok(CONTRACT_TYPES.includes(type), `镜像里多出契约外取值：${type}`);
  assert.ok(Object.isFrozen(EXPORT_OBJECT_TYPES), '闭集必须冻结，防止运行期被塞进第 17 个值');
});

test('契约镜像②：id 上限 80 是同一个数（契约 maxLength === EXPORT_OBJECT_ID_MAX === 写入侧 OBJECT_KEY_MAX）', () => {
  assert.equal(TARGET_REF.properties.id.maxLength, 80);
  assert.equal(TARGET_REF.properties.id.minLength, 1);
  assert.equal(EXPORT_OBJECT_ID_MAX, 80, '读侧上限必须等于契约 TargetRef.id.maxLength');
  // 写入侧（PG 账本 + 合成外发）的键上限：与本常量同口径，不得各自漂移。
  assert.match(LEDGER_PG, /const OBJECT_KEY_MAX = 80;/);
  assert.match(SYNTHESIS_EGRESS, /const OBJECT_KEY_MAX = 80;/);
  // 形状正则的中间段 = 上限 − 首尾两个锚字符（80 − 2 = 78）。
  assert.match(LEDGER_PG, /\{0,78\}/);
  assert.match(SYNTHESIS_EGRESS, /\{0,78\}/);
  assert.match(TASK_EGRESS, /\{0,78\}/);
});

test('契约镜像③：六个正文类型（checked_content 的真实含义）全在枚举内', () => {
  // `checked_content` 是**资料维度**名，回填时改写成该条正文的真实内容类型（六值闭集）。
  // 六值必须全部落在契约枚举里，否则回填就是把闭集外的值换成另一个闭集外的值。
  assert.deepEqual([...SYNTHESIS_TARGET_TYPES], ['answer', 'scheme', 'herbicide', 'species', 'static_region', 'dose_card']);
  for (const type of SYNTHESIS_TARGET_TYPES) {
    assert.ok(EXPORT_OBJECT_TYPES.includes(type), `正文类型 ${type} 不在契约 TargetRef.type 闭集内`);
  }
});

test('投影①：media 行原样投影，不受本片改写影响', () => {
  const exported = toContractExport({ ...MEDIA_RECORD });
  assert.deepEqual(exported.object_ref, { type: 'media', id: MEDIA_RECORD.objectId, revision: 2 });
  assert.equal(exported.state, 'sent');
  assert.equal(exported.object_ref.id, MEDIA_RECORD.objectId, 'media 维的 id 就是 object_id（不走 object_key）');
});

test('投影②：conversation_turn 是闭集外取值 ⇒ PROVIDER_UNAVAILABLE（不许原样透传）', () => {
  assert.ok(!EXPORT_OBJECT_TYPES.includes('conversation_turn'));
  assert.throws(() => toContractExport({ ...MEDIA_RECORD, objectType: 'conversation_turn' }), unavailable);
});

test('投影③：checked_content 是闭集外取值 ⇒ PROVIDER_UNAVAILABLE（它是 data_type，不是对象类型）', () => {
  assert.ok(!EXPORT_OBJECT_TYPES.includes('checked_content'));
  assert.throws(() => toContractExport({ ...MEDIA_RECORD, objectType: 'checked_content' }), unavailable);
});

test('投影④：裸 id 的 80 字符通过、81 字符拒绝（契约 maxLength=80，前缀不得再占 id 预算）', () => {
  const id80 = 'a'.repeat(80);
  const past = toContractExport({ ...MEDIA_RECORD, objectType: 'answer', objectId: id80 });
  assert.equal(past.object_ref.id, id80);
  assert.equal(past.object_ref.id.length, 80);

  const id81 = 'a'.repeat(81);
  assert.throws(() => toContractExport({ ...MEDIA_RECORD, objectType: 'answer', objectId: id81 }), unavailable);
});

test('投影⑤：空 id / 非字符串 id / 非字符串 type 一律拒绝（契约 minLength=1）', () => {
  assert.throws(() => toContractExport({ ...MEDIA_RECORD, objectId: '' }), unavailable);
  assert.throws(() => toContractExport({ ...MEDIA_RECORD, objectId: null }), unavailable);
  assert.throws(() => toContractExport({ ...MEDIA_RECORD, objectType: null }), unavailable);
  // 已有判据不许被本次改动放松：状态闭集照旧。
  assert.ok(!EXPORT_STATES.includes('succeeded'));
  assert.throws(() => toContractExport({ ...MEDIA_RECORD, state: 'succeeded' }), unavailable);
});

test('写入侧①：task-egress 写 conversation + 裸 id（不再有 conversation_turn / turn: 前缀）', () => {
  assert.match(TASK_EGRESS, /export const CHAT_EGRESS_OBJECT_TYPE = 'conversation';/);
  // 判据只看**代码**（注释里保留 `conversation_turn` / `turn:` 是在解释"为什么不用它们"，不算产出）。
  assert.ok(!/=\s*'conversation_turn'/.test(TASK_EGRESS), '写入侧不得再写闭集外的 conversation_turn');
  assert.ok(!/`turn:\$\{/.test(TASK_EGRESS), '键不得再带 turn: 前缀（它白占 id 预算，读侧会原样当 object_ref.id）');
  assert.match(TASK_EGRESS, /const objectKey = String\(input\.objectId\)\.toLowerCase\(\);/);
});

test('写入侧②：synthesis-egress 的 object_type 取真实内容类型（不再硬编码 checked_content）', () => {
  assert.ok(
    !SYNTHESIS_EGRESS.includes('SYNTHESIS_LEDGER_OBJECT_TYPE'),
    'object_type 必须来自快照的真实类型；旧常量已删',
  );
  assert.ok(!/objectType:\s*SYNTHESIS_LEDGER_OBJECT_TYPE/.test(SYNTHESIS_EGRESS));
  assert.ok(!/objectType:\s*'checked_content'/.test(SYNTHESIS_EGRESS));
  assert.match(SYNTHESIS_EGRESS, /objectType:\s*snapshot\.objectType/, 'reserveFor 必须用快照里的真实类型');
  // `checked_content` 在**资料维度**上仍然合法（`exports.data_type`），所以只能断言对象类型维度的用法消失。
  assert.match(SYNTHESIS_EGRESS, /const SYNTHESIS_LEDGER_DATA_TYPE = 'checked_content';/);
});
