/**
 * GY-I07 查询展示层 · 除草剂记录装载与契约投影。
 *
 * 输入：GY-I03 的 `packages/knowledge/herbicides/records-2026.json`（真实来源、非编造）。
 * 输出：契约形状的 `Herbicide` / `Knowledge` 投影 + 展示所需的「条件／来源／状态」明细。
 *
 * 三条硬约束（对应 #7 范围）：
 *   1) **不以模糊药名合并不同含量剂型**：制剂身份 = `registration_number + identity_hash`，
 *      其中 `identity_hash` 由「名称 + 剂型 + 有效成分含量文本」决定。名称相同但含量/剂型
 *      不同的记录**不合并**，各自成条。
 *   2) **来源可追溯**：每条记录携带 `source_version`（来源 id + 版本 + 内容哈希 + 抓取时间），
 *      列表与详情使用同一值。
 *   3) **不得作为用量依据**：`usable_as_dose` 恒 false（首批缺用量字段），
 *      `reference_state` 依来源有效期与可见性判定。
 *
 * 纯 ESM，无第三方依赖（仅用 node:crypto 计算身份/内容哈希）。
 */

import { createHash } from 'node:crypto';
import {
  CATALOG_PATHS,
  MATCH_STATES,
  QUERYABLE_VALIDITIES,
  QUERYABLE_VISIBILITIES,
  REFERENCE_STATES,
  SIMULATION_REGISTRATION_PREFIX,
  readJson,
} from './constants.mjs';
import { normalizeText } from './catalog.mjs';

/** sha256 十六进制（契约 content_hash / identity_hash 形如 ^[a-f0-9]{64}$）。 */
export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 制剂身份哈希：**名称 + 剂型 + 有效成分含量文本**。
 * 关键：把 `dosage_form` 与 `ingredients_text`（含含量）纳入哈希，
 * 使「同名不同含量或不同剂型」产生不同身份，从而**不被合并**。
 */
export function formulationIdentityHash(record) {
  const parts = [
    normalizeText(record.registered_name),
    normalizeText(record.dosage_form),
    normalizeText(record.ingredients_text),
  ];
  return sha256Hex(parts.join('|'));
}

/** 内容哈希：记录可追溯内容的稳定摘要（用于来源版本一致性与缓存键）。 */
export function recordContentHash(record) {
  const stable = JSON.stringify({
    registration_number: record.registration_number,
    registered_name: record.registered_name,
    producer: record.producer,
    dosage_form: record.dosage_form,
    ingredients_text: record.ingredients_text,
    toxicity: record.toxicity,
    use_scene: record.use_scene,
    target_original: record.target_original,
  });
  return sha256Hex(stable);
}

/**
 * 记录是否属于模拟来源。
 * 显式判据：登记号以 `SIM-` 前缀，或来源 source_kind === 'simulation'。
 * 二者任一成立即视为模拟 —— 模拟记录**绝不进入真实查询的有效集合**。
 */
export function isSimulated(record) {
  const prefix = String(record.registration_number ?? '').startsWith(SIMULATION_REGISTRATION_PREFIX);
  const kind = record?.source?.source_kind === 'simulation';
  return prefix || kind;
}

/**
 * 由记录派生 `source_version` 字符串（列表与详情**同源**）。
 * 形如 `<source_id>@<version或issue>#<hash12>`；版本缺失时以 issue 或抓取日期兜底，
 * 但**不编造**版本号：无任何可用版本信息时用 `retrieved_at`。
 */
export function deriveSourceVersion(record) {
  const s = record.source ?? {};
  const versionPart = s.version ?? s.issue ?? s.retrieved_at ?? 'unknown';
  const hash12 = (s.attachment_sha256 ?? s.content_hash ?? '').slice(0, 12);
  return `${s.source_id ?? 'unknown'}@${versionPart}${hash12 ? '#' + hash12 : ''}`;
}

/**
 * 派生参考可得性（ReferenceState）。
 * 仅当来源 validity 属于「可查询有效期」且记录具名时 available，否则 unavailable。
 */
export function deriveReferenceState(record) {
  const validity = record?.source?.source_validity ?? record?.source?.validity ?? 'unknown';
  const ok = QUERYABLE_VALIDITIES.includes(validity) && typeof record.registration_number === 'string' && record.registration_number !== '';
  return ok ? 'available' : 'unavailable';
}

/**
 * 派生可见性（Visibility）。首批资料无显式 visibility 字段：
 * 默认为 `published`（资料已由 GY-I03 交付），若记录显式给出 visibility 则采用之。
 */
export function deriveVisibility(record) {
  const v = record.visibility;
  return QUERYABLE_VISIBILITIES.includes(v) || v === 'hidden' || v === 'deleted' || v === 'private' ? v : 'published';
}

/**
 * 将一条 GY-I03 记录投影为契约 `Herbicide`（制剂 + 来源 + 风险 + 参考状态）。
 * `formulation.id` 用确定性 UUIDv5 风格占位（由 identity_hash 派生，稳定可复现）。
 */
export function toHerbicideContract(record) {
  const identityHash = formulationIdentityHash(record);
  const src = record.source ?? {};
  const validity = src.source_validity ?? src.validity ?? 'unknown';
  return {
    id: deterministicUuid(record.record_id),
    revision: 1,
    formulation: {
      id: deterministicUuid(identityHash),
      registration_number: record.registration_number,
      producer: record.producer,
      dosage_form: record.dosage_form,
      ingredients: parseIngredients(record.ingredients_text),
    },
    source: {
      id: deterministicUuid(src.source_id ?? 'unknown'),
      version: deriveSourceVersion(record),
      title: src.issue ?? src.publisher ?? '农药登记信息',
      // 契约要求 url 为 https 且 pattern ^https://，取 original_url 优先
      url: pickHttpsUrl(src),
      publisher: src.publisher ?? '农业农村部农药管理司',
      source_kind: src.source_kind ?? 'verified_seed',
      evidence_kind: src.evidence_kind ?? 'research',
      validity,
      review_status: record?.verification?.review_status ?? 'unverified',
      updated_at: toIsoDate(src.published_at ?? src.retrieved_at),
    },
    risk_text: buildRiskText(record),
    reference_state: deriveReferenceState(record),
  };
}

/**
 * 将一条记录投影为契约 `Knowledge`（type='herbicide'），供 /knowledge 消费。
 * body 为**拼装的可追溯描述**（不写用量建议，不出现禁用标签）。
 */
export function toKnowledgeContract(record) {
  const h = toHerbicideContract(record);
  return {
    id: deterministicUuid('knowledge:' + record.record_id),
    revision: 1,
    type: 'herbicide',
    title: record.registered_name,
    body: buildKnowledgeBody(record),
    source: h.source,
    conditions: {
      crop_id: (record.crop_ids ?? [])[0] ?? null,
      region_code: null,
      species_id: null,
      growth_stage: null,
      planting_method: null,
      use_scene: record.use_scene ?? null,
    },
    reference_state: h.reference_state,
    // 首批缺用量字段：不给 DoseCard（数组为空，不伪造条件完整卡）。
    dose_cards: [],
  };
}

/** 由 ingredients_text 解析有效成分（形如「唑草酮 40%」「吡氟酰草胺 2%、二甲戊灵 22%」）。 */
export function parseIngredients(text) {
  if (typeof text !== 'string' || text.trim() === '') return [{ name: '未标注', content_text: '未标注' }];
  return text
    .split(/[、,]/)
    .map((seg) => seg.trim())
    .filter((seg) => seg !== '')
    .map((seg) => {
      const m = seg.match(/^(.+?)\s*([\d.]+%?)\s*$/);
      if (m) return { name: m[1].trim(), content_text: m[2].trim() };
      return { name: seg, content_text: '未标注' };
    });
}

/** 组装风险提示文字（**不含**任何绝对安全/专家认证表述）。 */
export function buildRiskText(record) {
  const toxicity = record.toxicity ?? '未知';
  const missing = record?.verification?.not_collected ?? [];
  const missNote = missing.length > 0 ? `；本轮未采集：${missing.join('、')}` : '';
  return `毒性：${toxicity}。记录状态：${record.record_status ?? 'partial'}。来源为公开登记公告附表，未逐条复核标签原文${missNote}。不可作为用药量依据。`;
}

/** 组装知识正文（可追溯描述，无用量建议）。 */
export function buildKnowledgeBody(record) {
  const crops = (record.crop_ids ?? []).join('、') || '未标注';
  return [
    `登记证号：${record.registration_number}`,
    `登记名称：${record.registered_name}`,
    `剂型：${record.dosage_form}`,
    `有效成分及其含量：${record.ingredients_text}`,
    `作物条目：${crops}`,
    `使用场景：${record.use_scene}`,
    `防治对象（原文）：${record.target_original}`,
    `来源：${record?.source?.publisher ?? '农业农村部农药管理司'}（${record?.source?.issue ?? '公告附表'}）`,
    '说明：字段取自公开公告附表，未采集用药量／施用方法／禁限用状态，不可作为用药量依据。',
  ].join('\n');
}

/** 取 https URL（契约 SourceRef.url 必须 https）。 */
function pickHttpsUrl(src) {
  const candidates = [src.original_url, src.attachment_url, src.index_url, src.url];
  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('https://')) return c;
  }
  // 契约要求 https：若仅有 http，则**不伪造** https，退回一个显式占位域名（example.invalid 不可解析）
  return 'https://example.invalid/gengyun/source-not-published';
}

/** 日期/时间 → ISO（date-time 或仅日期均可被 Date 解析；失败返回 epoch 占位但不编造内容）。 */
function toIsoDate(value) {
  if (typeof value === 'string' && value !== '') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return new Date(0).toISOString();
}

/** 由任意字符串派生**确定性 UUID**（形如 uuid，稳定可复现；不是随机 uuid）。 */
export function deterministicUuid(seed) {
  const h = sha256Hex(String(seed));
  const a = h.slice(0, 8);
  const b = h.slice(8, 12);
  const c = '5' + h.slice(13, 16); // version 5 区段
  const d = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20); // variant
  const e = h.slice(20, 32);
  return `${a}-${b}-${c}-${d}-${e}`;
}

/**
 * 装载全部除草剂记录并投影。
 * 返回 { raw, items }，items 为增强后的内部条目（含契约投影与检索所需的规范化字段）。
 */
export function loadHerbicideRecords() {
  const doc = readJson(CATALOG_PATHS.herbicides);
  const raw = doc.records ?? [];
  const items = raw.map((record, index) => {
    const identityHash = formulationIdentityHash(record);
    const sourceVersion = deriveSourceVersion(record);
    const visibility = deriveVisibility(record);
    const referenceState = deriveReferenceState(record);
    const simulated = isSimulated(record);
    return Object.freeze({
      index,
      record_id: record.record_id,
      registration_number: record.registration_number,
      registered_name: record.registered_name,
      producer: record.producer,
      dosage_form: record.dosage_form,
      toxicity: record.toxicity,
      ingredients_text: record.ingredients_text,
      use_scene: record.use_scene ?? null,
      target_original: record.target_original ?? null,
      crop_ids: record.crop_ids ?? [],
      record_status: record.record_status ?? 'partial',
      // 身份与来源版本（列表/详情同源）
      identity_hash: identityHash,
      identity_key: `${record.registration_number}::${identityHash}`,
      source_version: sourceVersion,
      content_hash: recordContentHash(record),
      visibility,
      reference_state: referenceState,
      simulated,
      source: record.source ?? {},
      verification: record.verification ?? {},
      // 检索用规范字段
      norm: Object.freeze({
        name: normalizeText(record.registered_name),
        producer: normalizeText(record.producer),
        registration: normalizeText(record.registration_number),
        ingredients: normalizeText(record.ingredients_text),
        use_scene: normalizeText(record.use_scene ?? ''),
        target: normalizeText(record.target_original ?? ''),
      }),
      contract: Object.freeze(toHerbicideContract(record)),
      knowledge: Object.freeze(toKnowledgeContract(record)),
    });
  });
  return Object.freeze({
    docMeta: Object.freeze({
      schema: doc.schema,
      retrieved_at: doc.retrieved_at,
      target: doc.target,
      achieved: doc.achieved,
      gap: doc.gap,
      missing_registration_numbers: doc.missing_registration_numbers ?? [],
    }),
    items: Object.freeze(items),
  });
}

/** 供上层断言使用的参考状态集合（避免拼写漂移）。 */
export const STATES = Object.freeze({
  MATCH: MATCH_STATES,
  REFERENCE: REFERENCE_STATES,
});
