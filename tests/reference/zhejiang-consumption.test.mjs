// GY-I07 · 浙江首批真实资料的**如实消费**回归（来源：GY-I03 / PR #131 已合入清单）。
//
// 本文件只断言「已合入清单被真的消费」与「未核对/未发布/缺用量被如实呈现」两类事实，
// 不重跑 GY-I03 的抽取/校验工具（那是 #3 的证据面），也不访问数据库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadZhejiangKnowledge,
  loadZhejiangMaterials,
  zhejiangKnowledgeRecords,
  queryZhejiangKnowledge,
  doseCardDescriptor,
  assertNoForbiddenLabel,
  FORBIDDEN_LABELS,
  ZHEJIANG_SOURCE_URL_NOT_PUBLISHED,
  ZHEJIANG_REVIEW_STATUS,
  ZHEJIANG_VISIBILITY,
  ZHEJIANG_PROVINCE_CODE,
} from '../../packages/reference/index.mjs';

const contract = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../packages/contracts/openapi.json', import.meta.url)), 'utf8'),
);
const schemas = contract.components.schemas;
const knowledge = loadZhejiangKnowledge();
const items = [...knowledge.items];

/** 深拷贝清单，用于篡改负例（不污染真实清单）。 */
function cloneDoc() {
  return JSON.parse(JSON.stringify(loadZhejiangMaterials().doc));
}

/** 与装配层同一份品类目录（作物/杂草 id 解析）。 */
function knowledgeCatalogs() {
  return {
    crops: JSON.parse(readFileSync(fileURLToPath(new URL('../../packages/knowledge/catalog/crops.json', import.meta.url)), 'utf8')).crops,
    species: JSON.parse(readFileSync(fileURLToPath(new URL('../../packages/knowledge/catalog/species.json', import.meta.url)), 'utf8')).species,
  };
}

test('浙江首批真实资料被消费：119 杂草 + 5 防除时期 + 35 药剂适用 = 159 条', () => {
  assert.equal(knowledge.state.counts.weed, 119);
  assert.equal(knowledge.state.counts.control_timing, 5);
  assert.equal(knowledge.state.counts.herbicide_applicability, 35);
  assert.equal(knowledge.state.counts.total, 159);
  assert.equal(items.length, 159);
  // 条目类型与 build_seeds.py 的种子投影同口径（species / scheme / herbicide）。
  assert.deepEqual(
    [...new Set(items.map((i) => i.knowledge.type))].sort(),
    ['herbicide', 'scheme', 'species'],
  );
  // id 确定性（同一清单恒得同一 id，可复现）。
  const again = zhejiangKnowledgeRecords(loadZhejiangMaterials(), knowledgeCatalogs());
  assert.deepEqual(again.map((i) => i.knowledge.id), items.map((i) => i.knowledge.id));
  assert.equal(new Set(items.map((i) => i.knowledge.id)).size, items.length);
});

test('逐条如实标注未核对（unverified）与来源版本，绝不写成已核对', () => {
  for (const item of items) {
    assert.equal(item.review_status, 'unverified');
    assert.equal(item.knowledge.source.review_status, 'unverified');
    assert.equal(item.knowledge.source.validity, 'valid');
    assert.equal(item.knowledge.source.version.length > 0, true);
    assert.equal(item.visibility, ZHEJIANG_VISIBILITY);
    assert.equal(item.visibility, 'private');
    assert.equal(knowledge.state.published, false);
    assert.match(item.knowledge.body, /未核对（unverified）/);
    // 同一来源版本的列表/详情同源字符串。
    assert.match(item.source_version, /^src_[\w-]+@[\w.\-]+#[0-9a-f]{12}$/);
  }
  assert.equal(ZHEJIANG_REVIEW_STATUS, 'unverified');
});

test('负例·用量缺项不得被补齐：无 dose_text、usable_as_dose/card_ready=false、dose_cards=[]、conditions=null', () => {
  for (const item of items) {
    assert.equal(item.dose_text, null);
    assert.equal(item.usable_as_dose, false);
    assert.equal(item.card_ready, false);
    assert.deepEqual(item.knowledge.dose_cards, []);
    assert.equal(item.knowledge.conditions, null);
    // 响应里**不得**出现任何「可用用量」字段（契约 Knowledge 允许的键之外不得有 DoseCard）。
    assert.equal(Object.hasOwn(item.knowledge, 'dose_card'), false);
    assert.equal(Object.hasOwn(item.knowledge, 'usable_as_dose'), false);
    assert.equal(Object.hasOwn(item.knowledge, 'dose_text'), false);
    assert.match(item.knowledge.body, /不生成用量卡片/);
  }
  // 清单自身也声明了三类用量字段缺项。
  assert.equal(knowledge.doc.dosage_policy.dose_text, 'absent_in_source');
  assert.equal(knowledge.doc.dosage_policy.application_method_text, 'absent_in_source');
  assert.equal(knowledge.doc.dosage_policy.precautions_text, 'absent_in_source');
  assert.deepEqual(knowledge.state.dose, { dose_text: null, usable_as_dose: false, card_ready: false, dose_cards: 0 });
});

test('负例·DoseCard 恒不可渲染（未采集用量），功能开关打开也不能放行', () => {
  for (const item of items) {
    const off = doseCardDescriptor(item, { doseCardEnabled: false });
    assert.equal(off.renderable, false);
    assert.equal(off.closed, true);
    const on = doseCardDescriptor(item, { doseCardEnabled: true });
    assert.equal(on.renderable, false);
    assert.equal(on.closed, false);
    assert.equal(on.reason, '本记录未采集可用作依据的用量字段，不提供用量信息');
    // 即便给出「宽松上下文」也不得放行（未采集用量是硬阻断）。
    const permissive = doseCardDescriptor(item, {
      doseCardEnabled: true,
      context: { crop_id: item.crop_ids[0], region_code: ZHEJIANG_PROVINCE_CODE, allow_restricted: true },
    });
    assert.equal(permissive.renderable, false);
  }
});

test('负例·篡改清单即拒绝消费（补造用量 / 提升为已核对 / 改剂量策略）', () => {
  const catalogs = { crops: [], species: [] };

  const withDose = cloneDoc();
  withDose.weed_items[0].dose_text = '40% 唑草酮 30 克/亩';
  assert.throws(() => zhejiangKnowledgeRecords(withDose, catalogs), /用量族字段 dose_text|补造/);

  const withUsable = cloneDoc();
  withUsable.herbicide_items[0].usable_as_dose = true;
  assert.throws(() => zhejiangKnowledgeRecords(withUsable, catalogs), /usable_as_dose 必须为 false/);

  const withCardReady = cloneDoc();
  withCardReady.herbicide_items[0].card_ready = true;
  assert.throws(() => zhejiangKnowledgeRecords(withCardReady, catalogs), /card_ready 必须为 false/);

  const promoted = cloneDoc();
  promoted.sources[0].review_status = 'verified';
  assert.throws(() => zhejiangKnowledgeRecords(promoted, catalogs), /review_status 非 unverified/);

  const policy = cloneDoc();
  policy.dosage_policy.dose_text = 'present';
  assert.throws(() => zhejiangKnowledgeRecords(policy, catalogs), /dosage_policy/);

  const unknownSource = cloneDoc();
  unknownSource.weed_items[0].source.source_id = 'src_not_registered';
  assert.throws(() => zhejiangKnowledgeRecords(unknownSource, catalogs), /未登记的来源/);
});

test('来源 URL 策略：全批零 https，使用 RFC 2606 不可解析占位，满足契约 ^https:// 而不伪造真实机构', () => {
  assert.equal(knowledge.state.https_source_urls, 0, '清单中没有 https 来源地址');
  assert.deepEqual(knowledge.state.source_kind, ['verified_seed', 'verified_seed']);
  for (const item of items) {
    const url = item.knowledge.source.url;
    assert.equal(url, ZHEJIANG_SOURCE_URL_NOT_PUBLISHED);
    assert.match(url, /^https:\/\//, '契约 SourceRef.url pattern ^https://');
    assert.match(url, /^https:\/\/example\.invalid\//, 'RFC 2606 保留域：永不解析，不冒充真实机构');
    assert.doesNotMatch(url, /(?:moa|gov|agri|cnipa)\./i);
  }
  assert.equal(knowledge.state.source_url_policy.resolvable, false);
  // 真实来源定位改由 body 承载（见下一条），URL 只作不可解析占位。
  assert.match(items[0].knowledge.body, /来源定位（可复核）/);
});

test('可追溯来源：逐条 body 含真实 locator + 行指纹 + 原文件 sha256（不以 URL 冒充来源）', () => {
  for (const item of items) {
    const body = item.knowledge.body;
    const raw = item.raw.source;
    assert.match(body, new RegExp(escapeRegExp(raw.locator)), `body 必须含 locator：${item.item_id}`);
    assert.match(body, new RegExp(escapeRegExp(raw.row_sha256)), `body 必须含行指纹：${item.item_id}`);
    assert.match(body, new RegExp(escapeRegExp(raw.file_sha256)), `body 必须含原文件 sha256：${item.item_id}`);
    assert.equal(item.content_hash, raw.row_sha256);
    assert.equal(raw.sheet.length > 0, true);
    assert.equal(Number.isInteger(raw.excel_row) && raw.excel_row >= 1, true);
    assert.match(raw.cell_range, /^[A-Z]+\d+:[A-Z]+\d+$/);
  }
});

const KNOWLEDGE_REQUIRED = ['id', 'revision', 'type', 'title', 'body', 'source', 'conditions', 'reference_state', 'dose_cards'];
const SOURCE_REQUIRED = ['id', 'version', 'title', 'url', 'publisher', 'source_kind', 'evidence_kind', 'validity', 'review_status', 'updated_at'];

test('契约形状严格对齐：Knowledge/SourceRef 必填键齐全、无额外键、枚举与格式命中冻结契约', () => {
  // 先用契约自身核对本测试的「必填清单」没有漂移。
  assert.deepEqual([...schemas.Knowledge.required].sort(), [...KNOWLEDGE_REQUIRED].sort());
  assert.equal(schemas.Knowledge.additionalProperties, false);
  assert.deepEqual([...schemas.SourceRef.required].sort(), [...SOURCE_REQUIRED].sort());
  assert.equal(schemas.SourceRef.additionalProperties, false);

  const typeEnum = schemas.Knowledge.properties.type.enum;
  const reviewEnum = schemas.SourceRef.properties.review_status.enum;
  const validityEnum = schemas.SourceRef.properties.validity.enum;
  const sourceKindEnum = schemas.SourceKind.enum;
  const evidenceKindEnum = schemas.EvidenceKind.enum;
  const urlPattern = new RegExp(schemas.SourceRef.properties.url.pattern);

  for (const item of items) {
    const k = item.knowledge;
    assert.deepEqual(Object.keys(k).sort(), [...KNOWLEDGE_REQUIRED].sort(), `额外/缺失键：${item.item_id}`);
    assert.equal(typeEnum.includes(k.type), true);
    assert.match(k.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(Number.isInteger(k.revision) && k.revision >= 1, true);
    assert.equal(typeof k.title === 'string' && k.title.length >= 1 && k.title.length <= 200, true);
    assert.equal(k.body.length >= 1 && k.body.length <= 20000, true, `body 超长：${item.item_id}`);
    assert.equal(schemas.ReferenceState.enum.includes(k.reference_state), true);
    assert.equal(k.reference_state, 'available');

    const s = k.source;
    assert.deepEqual(Object.keys(s).sort(), [...SOURCE_REQUIRED].sort(), `来源额外/缺失键：${item.item_id}`);
    assert.equal(sourceKindEnum.includes(s.source_kind), true);
    assert.equal(evidenceKindEnum.includes(s.evidence_kind), true);
    assert.equal(validityEnum.includes(s.validity), true);
    assert.equal(reviewEnum.includes(s.review_status), true);
    assert.match(s.url, urlPattern);
    assert.equal(s.updated_at, new Date(s.updated_at).toISOString());
    assert.equal(s.title.length >= 1 && s.title.length <= 200, true);
    assert.equal(s.publisher.length >= 1 && s.publisher.length <= 200, true);
  }
});

test('查询语义：省级证据不猜县区；未采集条件不静默放宽；无结果如实为空', () => {
  // 省级登记码命中全部；县区码**不**命中（不猜测层级归属）。
  assert.equal(queryZhejiangKnowledge(items, { region_code: '330000' }).items.length, 159);
  const district = queryZhejiangKnowledge(items, { region_code: '330102' });
  assert.equal(district.items.length, 0);
  assert.equal(district.match_state, 'no_match');

  // 结构化条件（清单里确有的作物/杂草）命中。
  assert.equal(queryZhejiangKnowledge(items, { crop_id: 'crop_rice' }).items.length > 0, true);
  assert.equal(queryZhejiangKnowledge(items, { species_id: 'species_barnyardgrass' }).items.length, 1);

  // 未采集的条件：不返回结果、也不丢弃条件继续展示。
  for (const cond of [{ growth_stage: '幼苗期' }, { planting_method: '移栽' }, { use_scene: '水稻田' }]) {
    const r = queryZhejiangKnowledge(items, cond);
    assert.equal(r.items.length, 0);
    assert.equal(r.match_state, 'insufficient');
    assert.match(r.reasons.join(''), /未结构化采集/);
  }

  // 关键词无结果 → 空数组（不是伪造结果，也不是错误）。
  const none = queryZhejiangKnowledge(items, { q: '不存在的杂草xyz' });
  assert.equal(none.items.length, 0);
  assert.equal(none.match_state, 'no_match');

  // 关键字命中（中文药名/杂草名）。
  assert.equal(queryZhejiangKnowledge(items, { q: '稗' }).items.length > 0, true);
  // 全量查询（无条件）也逐条标注未核对。
  const all = queryZhejiangKnowledge(items, {});
  assert.equal(all.items.length, 159);
  for (const item of all.items) assert.equal(item.review_status, 'unverified');
});

test('负例·禁用标签与数值用量扫描：标题/正文不得出现禁用词或剂量式表述', () => {
  const doseLike = /\d+(?:\.\d+)?\s*(?:毫升|克|千克|公斤|mg|ml|g|kg|L)\s*\/\s*(?:亩|公顷|hm2|ha)/i;
  for (const item of items) {
    const texts = [item.knowledge.title, item.knowledge.body];
    for (const t of texts) {
      assert.equal(assertNoForbiddenLabel(t), t);
      for (const word of FORBIDDEN_LABELS) assert.equal(t.includes(word), false, `出现禁用标签「${word}」`);
      assert.doesNotMatch(t, doseLike, `正文出现剂量式表述：${item.item_id}`);
      assert.doesNotMatch(t, /兑水|稀释倍数|亩用量|用量为/, `正文出现用量建议：${item.item_id}`);
    }
  }
});

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
