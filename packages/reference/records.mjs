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
  EVIDENCE_KINDS,
  MATCH_STATES,
  QUERYABLE_VALIDITIES,
  QUERYABLE_VISIBILITIES,
  REFERENCE_STATES,
  SIMULATION_REGISTRATION_PREFIX,
  SOURCE_KINDS,
  readJson,
} from './constants.mjs';
import { normalizeText } from './catalog.mjs';

/** sha256 十六进制（契约 content_hash / identity_hash 形如 ^[a-f0-9]{64}$）。 */
export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 缺项显式标记（H1 同原则）。
 * 用于「契约必填但来源原文缺失」的字符串字段：以显式缺项文案占位，
 * **不编造**权威主体（如发布方）、来源类型、单位等来源没有的信息。
 *
 * 命名注意：与 `seed.mjs` 的 `NOT_COLLECTED` 语义不同（后者专指种子整理稿缺栏），
 * 故此处用 `MISSING_TEXT` 以避免 `index.mjs` 星号导出的名称冲突。
 */
export const MISSING_TEXT = '未采集';

/** 返回原值（字符串且非空）；否则返回显式缺项标记 `未采集`（不编造）。 */
function orNotCollected(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : MISSING_TEXT;
}

/**
 * H2 契约要点（**强枚举字段不得承载非枚举值**）。
 *
 * `SourceRef.source_kind` / `evidence_kind` 为 **$ref 冻结枚举**：
 *   - `SourceKind ∈ {database, verified_seed, simulation}`
 *   - `EvidenceKind ∈ {research, experience, mixed}`
 * 二者**均不含**「未采集」这类缺项文案。因此原文缺失时**绝不能**填 `未采集`
 * （会产出被 Ajv 拒绝的非法契约对象），也**不得**随便挑一个合法枚举（等于编造来源类型）。
 * 正确做法是 **fail-closed**：该记录不具备可对外发布的来源类型 → 在**投影/查询前**
 * 即判定为「来源元数据不满足契约必填枚举」，整体退出投影（见 `loadHerbicideRecords`），
 * 并给出可读原因；缺项说明落在**能表达缺项的位置**（详情 `unavailable_reason`、
 * 顶层 `eligibility_reason`、`body` 文本），而非强枚举字段。
 */
const OPAQUE_MISSING_ENUM = Symbol('missing-required-enum');

/**
 * 取值必须命中冻结枚举，否则返回缺项哨兵（**不填占位文案、不挑选合法值**）。
 * @param {unknown} value 原文取值
 * @param {readonly string[]} allowed 契约枚举
 */
function requireEnum(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : OPAQUE_MISSING_ENUM;
}

/**
 * 记录是否满足「来源必填枚举」契约前提。
 * `registration_number` 同为契约 `Formulation.required`，一并纳入（同族缺陷，一次性排查）。
 * 返回 `{ ok, missing }`，`missing` 为**可读缺项字段名列表**（供缺项说明，不塞进枚举字段）。
 */
export function checkSourceContractReadiness(record) {
  const src = record?.source ?? {};
  const missing = [];
  if (requireEnum(src.source_kind, SOURCE_KINDS) === OPAQUE_MISSING_ENUM) missing.push('来源类型（source_kind）');
  if (requireEnum(src.evidence_kind, EVIDENCE_KINDS) === OPAQUE_MISSING_ENUM) missing.push('证据类型（evidence_kind）');
  if (typeof record?.registration_number !== 'string' || record.registration_number === '') missing.push('登记证号（registration_number）');
  return { ok: missing.length === 0, missing };
}

/** 登记证号是否为非空字符串（契约 Formulation.registration_number 必填）。 */
function hasRegistrationNumber(record) {
  return typeof record?.registration_number === 'string' && record.registration_number !== '';
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
 *
 * H2 同族：`registration_number` 为契约 `Formulation` 必填 —— 缺失的记录**不可作为
 * 可查询资料**（据此与 `evaluateEligibility` 的 `queryable` 判定保持一致）。
 */
export function deriveReferenceState(record) {
  const validity = record?.source?.source_validity ?? record?.source?.validity ?? 'unknown';
  const ok = QUERYABLE_VALIDITIES.includes(validity) && hasRegistrationNumber(record);
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
 *
 * H2 契约要点：`source.source_kind` / `evidence_kind` 为**冻结枚举**，缺失时
 * **不得**填 `未采集`（非法枚举）、也**不得**挑合法值（编造）→ 取 `requireEnum`，
 * 命中枚举才写入（见 `checkSourceContractReadiness`：不满足前提的记录在
 * `loadHerbicideRecords` 中已**整体退出投影**，故此处命中路径恒成立）。
 * `registration_number` 同为必填 → 缺失时以**空串**保证「字段存在 + 类型 string」，
 * 该记录同样已被 fail-closed 拦在查询集合之外。
 */
export function toHerbicideContract(record) {
  const identityHash = formulationIdentityHash(record);
  const src = record.source ?? {};
  const validity = src.source_validity ?? src.validity ?? 'unknown';
  const sourceKind = requireEnum(src.source_kind, SOURCE_KINDS);
  const evidenceKind = requireEnum(src.evidence_kind, EVIDENCE_KINDS);
  const source = {
    id: deterministicUuid(src.source_id ?? 'unknown'),
    version: deriveSourceVersion(record),
    title: orNotCollected(src.issue ?? src.publisher),
    // 契约要求 url 为 https 且 pattern ^https://，取 original_url 优先
    url: pickHttpsUrl(src),
    // H1 同原则：**不编造**权威发布方 —— 原文缺失即显式标「未采集」。
    // （publisher 为普通 string 字段，缺项文案合法；枚举字段见下。）
    publisher: orNotCollected(src.publisher),
    validity,
    review_status: record?.verification?.review_status ?? 'unverified',
    updated_at: toIsoDate(src.published_at ?? src.retrieved_at),
  };
  // H2：强枚举字段**只写命中冻结枚举的值**；未命中即**不写该字段**
  // （绝不填「未采集」这类非枚举值、也绝不挑一个合法值来编造来源类型）。
  // 该类记录已在 `loadHerbicideRecords` 的契约前提门禁处 fail-closed 排除，
  // 不会进入任何对外契约封套；此处保证「即使被直接调用，也不会产出非法枚举值」。
  if (sourceKind !== OPAQUE_MISSING_ENUM) source.source_kind = sourceKind;
  if (evidenceKind !== OPAQUE_MISSING_ENUM) source.evidence_kind = evidenceKind;
  return {
    id: deterministicUuid(record.record_id),
    revision: 1,
    formulation: {
      id: deterministicUuid(identityHash),
      // 必填 string：缺失登记证号时以空串占位（**不编造**一个看似合法的证号）。
      registration_number: hasRegistrationNumber(record) ? record.registration_number : '',
      // H1 同原则：必填但原文缺失时，用显式缺项标记，**不编造**持有人/剂型。
      producer: orNotCollected(record.producer),
      dosage_form: orNotCollected(record.dosage_form),
      ingredients: parseIngredients(record.ingredients_text),
    },
    source,
    risk_text: buildRiskText(record),
    reference_state: deriveReferenceState(record),
  };
}

/**
 * 将一条记录投影为契约 `Knowledge`（type='herbicide'），供 /knowledge 消费。
 * body 为**拼装的可追溯描述**（不写用量建议，不出现禁用标签）。
 *
 * G1 契约要点（冻结 schema `Conditions`，`additionalProperties:false`）：
 *   - `crop_id`/`region_code` 为 **required**，类型 `string`；
 *   - `region_code`/`species_id`/`growth_stage`/`planting_method`/`use_scene` 类型均为
 *     `string`（**非 nullable**）；
 *   - `Knowledge.conditions` 允许**整体**为 `null`，但**不能**把其内部非 nullable 属性设 `null`。
 * 因此：仅当 `crop_id` 与 `region_code` 两个必填项**都真实具备**时才给出 `conditions` 对象，
 * 否则整体置 `null`（缺失情况已在 `body` 文本中如实说明——不编造条件填满必填）。
 */
export function toKnowledgeContract(record) {
  const h = toHerbicideContract(record);
  return {
    id: deterministicUuid('knowledge:' + record.record_id),
    revision: 1,
    type: 'herbicide',
    // H2 同族：`title` 为必填 string(minLength 1) —— 缺失时以显式缺项标记占位（**不编造**药名）。
    title: orNotCollected(record.registered_name),
    body: buildKnowledgeBody(record),
    source: h.source,
    conditions: buildConditions(record),
    reference_state: h.reference_state,
    // 首批缺用量字段：不给 DoseCard（数组为空，不伪造条件完整卡）。
    dose_cards: [],
  };
}

/**
 * 组装契约 `Conditions`。
 * 首批资料（GY-I03 gap 已声明）**无地区码**，故必填 `region_code` 无法真实满足 →
 * 返回 `null`（契约允许），**不编造**地区/生育期/种植方式以凑满必填。
 */
export function buildConditions(record) {
  const cropId = (record.crop_ids ?? [])[0];
  if (typeof cropId !== 'string' || cropId === '') return null;
  const regionCode = typeof record.region_code === 'string' && /^33[0-9]{4}$/.test(record.region_code)
    ? record.region_code
    : null;
  // region_code 为 required 且类型 string：缺失即整体不可表达 → null（不伪造）。
  if (regionCode === null) return null;
  const out = { crop_id: cropId, region_code: regionCode };
  const optional = { species_id: record.species_id, growth_stage: record.growth_stage, planting_method: record.planting_method, use_scene: record.use_scene };
  for (const [k, v] of Object.entries(optional)) {
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

/**
 * 由 ingredients_text 解析有效成分（形如「唑草酮 40%」「吡氟酰草胺 2%、二甲戊灵 22%」）。
 *
 * H1 契约要点（冻结 schema `Ingredient`，`required: [name, content_text, unit_text]`）：
 * `unit_text` 为必填 `string`。**原文含显式单位**（如 `40%` / `200 g/L`）时，按原文如实给出
 * 该单位；**原文只给数值、未给单位**（如 `唑草酮 40`）时，**不得**补成 `%` 或任何量纲 ——
 * 否则等于给来源没有的信息补了单位，违反「缺项如实标记 / 不编造来源条件」。
 * 此时 `content_text` 保留原文数值本身，`unit_text` 显式标为 `未采集`。
 * 完全无法解析出名值对时，整体标 `未标注` / `未采集`。
 */
export function parseIngredients(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return [{ name: MISSING_TEXT, content_text: MISSING_TEXT, unit_text: MISSING_TEXT }];
  }
  return text
    // H1 同原则（不编造）：分隔符为顿号；半角逗号仅在**后接非数字**时才作分隔符 ——
    // 否则「2,4-滴异辛酯」这类名称内的逗号会被误切，凭空产生 `2` 这样的假成分。
    .split(/、|,(?![0-9])/)
    .map((seg) => seg.trim())
    .filter((seg) => seg !== '')
    .map((seg) => {
      const m = seg.match(/^(.+?)\s*([\d.]+)\s*(%|g\/L|g\/kg|mg\/kg|g|ml\/L|ml|mg|kg|L|克\/升|克\/公斤|毫升\/升|克|毫克|毫升|升|公斤)?\s*$/);
      if (m) {
        const name = m[1].trim();
        const value = m[2].trim();
        const explicitUnit = (m[3] ?? '').trim();
        // H1：仅当原文出现显式单位时才写入；缺单位时**保留原文数值**、单位标「未采集」（不补 `%`）。
        if (explicitUnit === '') {
          return { name, content_text: value, unit_text: MISSING_TEXT };
        }
        return { name, content_text: `${value}${explicitUnit}`, unit_text: explicitUnit };
      }
      return { name: seg, content_text: MISSING_TEXT, unit_text: MISSING_TEXT };
    });
}

/** 组装风险提示文字（**不含**任何绝对安全/专家认证表述）。 */
export function buildRiskText(record) {
  const toxicity = orNotCollected(record.toxicity);
  const missing = record?.verification?.not_collected ?? [];
  const missNote = missing.length > 0 ? `；本轮未采集：${missing.join('、')}` : '';
  return `毒性：${toxicity}。记录状态：${record.record_status ?? 'partial'}。来源为公开登记公告附表，未逐条复核标签原文${missNote}。不可作为用药量依据。`;
}

/** 组装知识正文（可追溯描述，无用量建议）。 */
export function buildKnowledgeBody(record) {
  const crops = (record.crop_ids ?? []).join('、') || MISSING_TEXT;
  return [
    `登记证号：${orNotCollected(record.registration_number)}`,
    `登记名称：${orNotCollected(record.registered_name)}`,
    `剂型：${orNotCollected(record.dosage_form)}`,
    `有效成分及其含量：${orNotCollected(record.ingredients_text)}`,
    `作物条目：${crops}`,
    `使用场景：${orNotCollected(record.use_scene)}`,
    `防治对象（原文）：${orNotCollected(record.target_original)}`,
    // H1 同原则：**不编造**发布方 —— 原文缺失即显式标「未采集」。
    `来源：${orNotCollected(record?.source?.publisher)}（${orNotCollected(record?.source?.issue)}）`,
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
 * 返回 `{ raw, items, skipped }`：
 *   - `items` 为满足契约必填枚举前提、可对外投影的内部条目；
 *   - `skipped` 为**在投影/查询前**被 fail-closed 排除的记录（附可读缺项原因），
 *     使「不可发布的记录」既不进入契约封套、也不进入有效查询集合。
 *
 * H2 口径：`source_kind`/`evidence_kind` 为冻结枚举、`registration_number` 为必填 ——
 * 任一缺失即**不满足契约前提** → 携带缺项说明退出投影（**不编造枚举、不填非法占位**）。
 */
export function loadHerbicideRecords() {
  return projectHerbicideRecords(readJson(CATALOG_PATHS.herbicides));
}

/**
 * 纯投影：由**已解析的记录文档**产出 `{ docMeta, items, skipped }` —— **不读盘、不写盘**。
 *
 * 为何单独导出：「读真实资料文件」与「按契约前提投影」是两件事。要检验「缺枚举字段的记录
 * 在投影前被 fail-closed 排除」，需要一份**变体文档**；变体若靠就地改写
 * `packages/knowledge/herbicides/records-2026.json` 造出来，就会与同一批 `node --test` 中
 * 并发读该文件的用例抢跑（PR #237 的 CI 实测逐字红点：
 * `test at tests/reference/i08-scenarios-100.test.mjs:525:1` /
 * `AssertionError [ERR_ASSERTION]: 应有≥20 条真实记录，实际 19`）。
 * 因此把投影暴露为纯函数：变体只存在于内存，真实资料文件**零写入**。
 */
export function projectHerbicideRecords(doc) {
  const raw = doc.records ?? [];
  const skipped = [];
  const items = [];
  raw.forEach((record, index) => {
    const readiness = checkSourceContractReadiness(record);
    if (!readiness.ok) {
      skipped.push(
        Object.freeze({
          index,
          record_id: record.record_id ?? null,
          registration_number: record.registration_number ?? null,
          registered_name: record.registered_name ?? null,
          missing: Object.freeze(readiness.missing.slice()),
          reason: `来源元数据缺项，无法满足契约必填：${readiness.missing.join('、')}（不编造枚举值，已退出投影）`,
        }),
      );
      return;
    }
    const identityHash = formulationIdentityHash(record);
    const sourceVersion = deriveSourceVersion(record);
    const visibility = deriveVisibility(record);
    const referenceState = deriveReferenceState(record);
    const simulated = isSimulated(record);
    items.push(
      Object.freeze({
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
      }),
    );
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
    /** H2：被 fail-closed 排除的记录（缺项说明落在此处，不塞进契约枚举字段）。 */
    skipped: Object.freeze(skipped),
  });
}

/** 供上层断言使用的参考状态集合（避免拼写漂移）。 */
export const STATES = Object.freeze({
  MATCH: MATCH_STATES,
  REFERENCE: REFERENCE_STATES,
});
