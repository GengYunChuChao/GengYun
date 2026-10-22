/**
 * GY-I26（issue #26）· AI 推荐排序：**确定性、可解释、纯函数**。
 *
 * 输入只用仓库里**已有的真实数据结构**，不自造数据：
 *   - `packages/knowledge/herbicides/records-2026.json` 的 `records[]`（登记记录；
 *     字段口径见 `packages/reference/records.mjs` 的契约投影）；
 *   - `packages/knowledge/catalog/crops.json` 的 `crops[]`（`id` / `name` / `aliases`）；
 *   - `packages/knowledge/catalog/species.json` 的 `species[]`（`group_name` / `canonical_name` / `aliases`）。
 *
 * 数据由调用方传入：本模块**不读文件、不读环境变量、不发网络请求、不看当前时间**，
 * 也不用 `localeCompare`／`Math.random`／对象键序，所以同样的入参必然给出逐字节相同的输出。
 *
 * 输出：带解释的有序列表。每条候选的 `score` **等于**它 `reasons[]` 里 `weight` 的整数和
 * （`score` 由 `reasons` 求和得出，不是另一条并行计算路径），因此「分数与理由不一致」
 * 在结构上就不可能出现。排序键：`score` 降序 → `id` 升序 → 输入次序（兜底），
 * 三者合起来是全序，所以同分序列稳定、且与 `records` 的传入顺序无关。
 *
 * 用药安全边界（`docs/architecture/state-contract.md` §「识别、来源、问答与播报」）：
 *   - 本模块**不产生剂量、不产生施用方法、不产生适用结论**；只对已有登记记录排序并说明理由；
 *   - 输入里若带剂量字段（**浅层**键名命中 `dose` / `dosage` / `用量` / `剂量`），值**整条丢弃**，
 *     记一条 `dosage_ignored`（weight 0），输出正文不出现剂量值；
 *     只扫浅层是有意的：`verification.not_collected` 里的「用药量（制剂量/亩）」是**缺项声明**，
 *     不是剂量输入，深层扫描会把它误判成剂量；
 *   - 结果级 `disclaimer` 逐字沿用仓内既有口径「不能作为用药依据」，
 *     并由测试用 `packages/reference/risk-wording.mjs` 的守卫逐条校验。
 *
 * 边界（本片**不做**的事，见证据页「边界裁定」）：不接线路由、不改 openapi、不加迁移、
 * 不碰 `docs/architecture/contract-status.json`。
 */

import { normalizeText } from '../../../../packages/reference/catalog.mjs';

/** 排序策略版本：权重或匹配口径变动时 bump，便于证据页按版本核对。 */
export const RECOMMENDATION_POLICY_VERSION = 'gy-r31-i26-rec/1.0.0';

/**
 * 结果级免责口径（**逐字**沿仓内既有说法「不能作为用药依据」，见
 * `miniprogram/pages/home/home.wxml:93` 与 `miniprogram/components/state-view/state-view.js:73`）。
 */
export const RECOMMENDATION_DISCLAIMER =
  '本列表只用于展示候选与排序理由，不含剂量、施用方法或适用结论，不能作为用药依据；实际用药请按登记标签与当地植保指导核对。';

/**
 * 权重表（**全整数**）：整数权重让「分数 = 理由加权和」是精确相等，
 * 不会出现浮点累加后 `0.1 + 0.2 !== 0.3` 那种「看起来一致、断言却红」的情况。
 */
export const RECOMMENDATION_WEIGHTS = Object.freeze({
  /** 查询作物与该记录登记作物一致。 */
  crop_match: 40,
  /** 查询症状（杂草）命中该记录登记的防治对象；按命中的杂草种类计，至多 2 种。 */
  symptom_match: 30,
  /** 查询关键词命中药名/成分/使用场所/防治对象/剂型；至多 3 个。 */
  keyword_match: 10,
  /** 查询症状不在 `catalog/species.json` 别名表内：**降权而不是抛错**；至多 2 个。 */
  unknown_symptom: -15,
  /** 来源状态 `valid` 的加分（失效来源拿不到这一分，而不是被扣成负数）。 */
  source_validity: 10,
  evidence_research: 6,
  evidence_mixed: 3,
  evidence_experience: 1,
  /** 核对状态 `unverified`：本批记录全部未逐字段复核，如实扣分而不是假装可信。 */
  review_unverified: -5,
});

/** 证据类型的加分表（`evidence_kind` 冻结枚举之外一律 0，不猜）。 */
const EVIDENCE_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  research: RECOMMENDATION_WEIGHTS.evidence_research,
  mixed: RECOMMENDATION_WEIGHTS.evidence_mixed,
  experience: RECOMMENDATION_WEIGHTS.evidence_experience,
});

/** 证据类型的中文口径（只用于 `detail` 文案）。 */
const EVIDENCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  research: '科研',
  mixed: '混合',
  experience: '经验',
});

/** 单条输入文本上限（字符）：超长输入截断后参与匹配，不参与输出原文。 */
const MAX_TEXT = 200;
/** 查询里最多采纳的症状／关键词条数。 */
const MAX_TERMS = 8;
/** `detail` 里回显用户词的最长字符数（防止超长输入把输出撑大）。 */
const MAX_ECHO = 24;
/** 症状命中的杂草种类上限。 */
const MAX_SYMPTOM_HITS = 2;
/** 关键词命中上限。 */
const MAX_KEYWORD_HITS = 3;
/** 未知症状计罚上限。 */
const MAX_UNKNOWN_SYMPTOMS = 2;
/** 被跳过的记录在 notes 里最多列出几个下标。 */
const MAX_REJECTED_IN_NOTE = 5;

/** 控制字符与双向/零宽控制符：进入匹配前一律剥掉。 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/** 剂量字段的键名判据（**浅层**扫描；见文件头「只扫浅层」的理由）。 */
const DOSE_KEY_PATTERN = /dose|dosage|用量|剂量/i;

/** 理由因子闭集：新增因子时同步测试里的断言。 */
export type RecommendationFactor =
  | 'crop_match'
  | 'symptom_match'
  | 'keyword_match'
  | 'unknown_symptom'
  | 'unknown_crop'
  | 'source_validity'
  | 'evidence_kind'
  | 'review_status'
  | 'dosage_ignored';

/** 结构化理由：`weight` 就是它对 `score` 的**全部**贡献。 */
export interface RecommendationReason {
  readonly factor: RecommendationFactor;
  readonly weight: number;
  readonly detail: string;
}

/** 一条候选：`score` 恒等于 `reasons` 的 `weight` 之和。 */
export interface RecommendationItem {
  readonly id: string;
  readonly name: string;
  readonly registration_number: string | null;
  readonly score: number;
  readonly reasons: readonly RecommendationReason[];
}

/** 输入级说明（剂量被丢弃、输入被截断、记录被跳过等）。 */
export interface RecommendationNote {
  readonly code: 'dosage_ignored' | 'input_sanitized' | 'unknown_crop' | 'record_rejected' | 'duplicate_id';
  readonly detail: string;
}

/** 查询上下文（可选）。索引签名让调用方可以传额外键，本模块只读它认得的几个。 */
export interface RecommendationQuery {
  readonly crop_id?: string;
  readonly symptoms?: readonly string[];
  readonly keywords?: readonly string[];
  readonly [key: string]: unknown;
}

/** 入参：三段真实数据 + 可选查询。`records` 缺省/为空 ⇒ 返回空列表（不抛）。 */
export interface RecommendationInput {
  readonly records?: readonly unknown[];
  readonly crops?: readonly unknown[];
  readonly species?: readonly unknown[];
  readonly query?: RecommendationQuery;
}

/** 出参：有序候选 + 输入级说明 + 免责口径。 */
export interface RecommendationResult {
  readonly policy_version: string;
  readonly disclaimer: string;
  readonly items: readonly RecommendationItem[];
  readonly notes: readonly RecommendationNote[];
}

/** 对象守卫：数组与 `null` 都不算记录对象。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 取非空字符串（去首尾空白后仍非空才算有值），否则 `null`。 */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** 取字符串数组（非字符串元素直接丢掉，不抛）。 */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

interface SanitizedTerm {
  readonly text: string;
  /** 是否发生过剥离控制字符或截断（用于 `input_sanitized` 说明）。 */
  readonly changed: boolean;
}

/**
 * 输入消毒：剥控制字符、去首尾空白、超长截断。
 * 非字符串一律当空串（**不抛**）——越权输入不该让排序整体失败。
 */
function sanitizeTerm(value: unknown): SanitizedTerm {
  if (typeof value !== 'string') return { text: '', changed: false };
  const stripped = value.replace(CONTROL_CHARS, '');
  const trimmed = stripped.trim();
  const text = trimmed.length > MAX_TEXT ? trimmed.slice(0, MAX_TEXT) : trimmed;
  return { text, changed: stripped !== value || text !== trimmed };
}

/** `detail` 里回显用户/来源文本时的截断（避免超长输入把输出撑大）。 */
function echo(text: string): string {
  return text.length > MAX_ECHO ? `${text.slice(0, MAX_ECHO)}…` : text;
}

/**
 * 名字里带 `dosage` 但**不是剂量**的目录字段：`dosage_form` 是「剂型」（悬浮剂/乳油…），
 * 属于登记数据本身，误判会让全部真实记录都背上一条 `dosage_ignored`。
 */
const NON_DOSE_KEYS: ReadonlySet<string> = new Set(['dosage_form', 'dose_form', 'dosageform']);

/** 浅层找出「带值的剂量字段」键名；只回键名，**永不回值**。 */
function doseKeys(value: unknown): string[] {
  const record = asRecord(value);
  if (record === null) return [];
  const keys: string[] = [];
  for (const key of Object.keys(record)) {
    if (NON_DOSE_KEYS.has(key.toLowerCase())) continue;
    if (!DOSE_KEY_PATTERN.test(key)) continue;
    const raw = record[key];
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'string' && raw.trim() === '') continue;
    keys.push(key);
  }
  return keys.sort();
}

interface SpeciesHit {
  readonly id: string;
  /** 归一化后的全部名称（`group_name` / `canonical_name` / `aliases`），用于在防治对象原文里找命中。 */
  readonly names: readonly string[];
}

interface ReferenceIndex {
  readonly speciesByAlias: ReadonlyMap<string, SpeciesHit>;
  readonly cropNames: ReadonlyMap<string, string>;
  readonly cropIds: ReadonlySet<string>;
  readonly hasCrops: boolean;
}

/** 用 `catalog/crops.json` + `catalog/species.json` 建索引（别名归一化沿用 `packages/reference` 的 `normalizeText`）。 */
function buildIndex(input: RecommendationInput): ReferenceIndex {
  const speciesByAlias = new Map<string, SpeciesHit>();
  for (const raw of Array.isArray(input.species) ? input.species : []) {
    const entry = asRecord(raw);
    if (entry === null) continue;
    const id = asString(entry['id']);
    if (id === null) continue;
    const names: string[] = [];
    for (const field of ['group_name', 'canonical_name'] as const) {
      const value = asString(entry[field]);
      if (value !== null) names.push(value);
    }
    for (const alias of stringArray(entry['aliases'])) names.push(alias);
    const normalized = [...new Set(names.map((name) => normalizeText(name)).filter((name) => name !== ''))];
    if (normalized.length === 0) continue;
    const hit: SpeciesHit = Object.freeze({ id, names: Object.freeze(normalized) });
    for (const name of normalized) {
      // 同一别名被多条记录占用时**先到先得**：目录顺序固定 ⇒ 结果仍是确定的。
      if (!speciesByAlias.has(name)) speciesByAlias.set(name, hit);
    }
  }

  const cropNames = new Map<string, string>();
  const cropIds = new Set<string>();
  for (const raw of Array.isArray(input.crops) ? input.crops : []) {
    const entry = asRecord(raw);
    if (entry === null) continue;
    const id = asString(entry['id']);
    if (id === null) continue;
    cropIds.add(id);
    const name = asString(entry['name']);
    if (name !== null) cropNames.set(id, name);
  }

  return {
    speciesByAlias,
    cropNames,
    cropIds,
    hasCrops: cropIds.size > 0,
  };
}

interface RankingContext {
  readonly index: ReferenceIndex;
  readonly cropId: string | null;
  readonly cropName: string | null;
  /** 传了作物名录、但查询的 `crop_id` 不在名录里 ⇒ 不做作物匹配，并留一条说明。 */
  readonly cropUnknown: boolean;
  readonly symptomHits: readonly { readonly term: string; readonly hit: SpeciesHit }[];
  readonly unknownSymptoms: readonly string[];
  readonly keywords: readonly string[];
  readonly queryDoseKeys: readonly string[];
  readonly notes: readonly RecommendationNote[];
}

/** 把查询归一成「一次调用只算一次」的上下文（每条记录复用，仍然与输入一一对应）。 */
function buildContext(input: RecommendationInput): RankingContext {
  const index = buildIndex(input);
  const query = asRecord(input.query);
  const notes: RecommendationNote[] = [];
  let sanitized = false;

  const crop = sanitizeTerm(query?.['crop_id']);
  sanitized = sanitized || crop.changed;
  const cropId = crop.text === '' ? null : crop.text;
  const cropKnown = cropId === null ? true : !index.hasCrops || index.cropIds.has(cropId);
  const cropName = cropId === null ? null : index.cropNames.get(cropId) ?? null;
  if (cropId !== null && !cropKnown) {
    notes.push({
      code: 'unknown_crop',
      detail: `查询作物「${echo(cropId)}」不在 catalog/crops.json 名录内，本次不做作物匹配（不猜作物）。`,
    });
  }

  const terms = (raw: unknown): string[] => {
    const out: string[] = [];
    for (const value of stringArray(raw)) {
      const term = sanitizeTerm(value);
      sanitized = sanitized || term.changed;
      if (term.text === '' || out.includes(term.text)) continue;
      if (out.length >= MAX_TERMS) break;
      out.push(term.text);
    }
    return out;
  };

  const symptoms = terms(query?.['symptoms']);
  const keywords = terms(query?.['keywords']);

  const symptomHits: { term: string; hit: SpeciesHit }[] = [];
  const seenSpecies = new Set<string>();
  const unknownSymptoms: string[] = [];
  for (const symptom of symptoms) {
    const hit = index.speciesByAlias.get(normalizeText(symptom));
    if (hit === undefined) {
      if (unknownSymptoms.length < MAX_UNKNOWN_SYMPTOMS) unknownSymptoms.push(symptom);
      continue;
    }
    if (seenSpecies.has(hit.id)) continue;
    if (symptomHits.length >= MAX_SYMPTOM_HITS) continue;
    seenSpecies.add(hit.id);
    symptomHits.push({ term: symptom, hit });
  }

  const queryDoseKeys = doseKeys(query);
  if (queryDoseKeys.length > 0) {
    notes.push({
      code: 'dosage_ignored',
      detail: `查询上下文含剂量字段（${queryDoseKeys.map((key) => echo(key)).join('、')}），已整条丢弃：不参与排序、不出现在输出正文。`,
    });
  }
  if (sanitized) {
    notes.push({
      code: 'input_sanitized',
      detail: `查询文本含控制字符或超过 ${MAX_TEXT} 字符，已剥离/截断后再参与匹配。`,
    });
  }

  return {
    index,
    cropId,
    cropName,
    cropUnknown: cropId !== null && !cropKnown,
    symptomHits,
    unknownSymptoms,
    keywords,
    queryDoseKeys,
    notes,
  };
}

/** 关键词匹配用的文本域（全部是记录自身的登记字段，不引入外部文本）。 */
const KEYWORD_FIELDS = ['registered_name', 'ingredients_text', 'use_scene', 'target_original', 'dosage_form'] as const;

function keywordHaystack(record: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const field of KEYWORD_FIELDS) {
    const value = asString(record[field]);
    if (value !== null) parts.push(value);
  }
  return normalizeText(parts.join('|'));
}

interface ScoredItem {
  readonly item: RecommendationItem;
  readonly inputIndex: number;
}

/** 给单条记录打分；`null` 表示这条记录不可用作候选（缺 id）。 */
function scoreRecord(record: Record<string, unknown>, inputIndex: number, ctx: RankingContext): ScoredItem | null {
  const recordId = asString(record['record_id']);
  const registrationNumber = asString(record['registration_number']);
  const id = recordId ?? registrationNumber;
  if (id === null) return null;

  const reasons: RecommendationReason[] = [];

  // 1) 作物：命中 +40；不命中记一条 weight 0 的说明（为什么这条分低要看得见）。
  //    查询作物不在名录内时**不做作物匹配**（不猜作物），只留一条 weight 0 说明。
  if (ctx.cropId !== null && !ctx.cropUnknown) {
    const cropIds = stringArray(record['crop_ids']);
    const matches = cropIds.includes(ctx.cropId);
    const cropLabel = ctx.cropName === null ? echo(ctx.cropId) : `${echo(ctx.cropName)}（${echo(ctx.cropId)}）`;
    if (matches) {
      reasons.push({
        factor: 'crop_match',
        weight: RECOMMENDATION_WEIGHTS.crop_match,
        detail: `登记作物与查询作物一致：${cropLabel}。`,
      });
    } else {
      const registered = cropIds.length === 0 ? '未登记作物' : cropIds.map((cropId) => echo(cropId)).join('、');
      reasons.push({
        factor: 'crop_match',
        weight: 0,
        detail: `登记作物与查询作物不一致（查询 ${cropLabel}，登记 ${registered}），不加作物分。`,
      });
    }
  } else if (ctx.cropUnknown) {
    reasons.push({
      factor: 'unknown_crop',
      weight: 0,
      detail: '查询作物不在名录内，本次不参与作物匹配（不猜作物）。',
    });
  }

  // 2) 症状：命中的杂草种类与该记录「防治对象」原文对得上才加分。
  const targetText = normalizeText(asString(record['target_original']) ?? '');
  const targetLabel = echo(asString(record['target_original']) ?? '未采集');
  for (const { term, hit } of ctx.symptomHits) {
    const matched = hit.names.some((name) => targetText.includes(name));
    if (matched) {
      reasons.push({
        factor: 'symptom_match',
        weight: RECOMMENDATION_WEIGHTS.symptom_match,
        detail: `症状「${echo(term)}」命中记录防治对象（${targetLabel}）。`,
      });
    }
  }

  // 3) 未知症状：**降权而非抛错**，每条记录都带上同一条说明，保证分数与理由可对账。
  for (const symptom of ctx.unknownSymptoms) {
    reasons.push({
      factor: 'unknown_symptom',
      weight: RECOMMENDATION_WEIGHTS.unknown_symptom,
      detail: `症状「${echo(symptom)}」不在 catalog/species.json 别名表内，按未知症状降权（不崩、不猜匹配）。`,
    });
  }

  // 4) 关键词：至多 3 个，逐个计分。
  const haystack = keywordHaystack(record);
  let keywordHits = 0;
  for (const keyword of ctx.keywords) {
    if (keywordHits >= MAX_KEYWORD_HITS) break;
    const needle = normalizeText(keyword);
    if (needle === '' || !haystack.includes(needle)) continue;
    keywordHits += 1;
    reasons.push({
      factor: 'keyword_match',
      weight: RECOMMENDATION_WEIGHTS.keyword_match,
      detail: `关键词「${echo(keyword)}」命中该记录的药名/成分/使用场所/防治对象/剂型。`,
    });
  }

  // 5) 来源状态：有效才加分；无效记一条 weight 0 的说明。
  const source = asRecord(record['source']);
  const validity = source === null ? null : asString(source['source_validity']);
  const sourceId = source === null ? null : asString(source['source_id']);
  if (validity === 'valid') {
    reasons.push({
      factor: 'source_validity',
      weight: RECOMMENDATION_WEIGHTS.source_validity,
      detail: `来源状态有效（valid${sourceId === null ? '' : `，${echo(sourceId)}`}）。`,
    });
  } else {
    reasons.push({
      factor: 'source_validity',
      weight: 0,
      detail: `来源状态为 ${validity === null ? '未采集' : echo(validity)}，拿不到来源有效性加分（不改成扣分，也不当作已失效结论）。`,
    });
  }

  // 6) 证据类型：只认冻结枚举，枚举外一律 0，不猜。
  const evidenceKind = source === null ? null : asString(source['evidence_kind']);
  const evidenceWeight = evidenceKind === null ? 0 : EVIDENCE_WEIGHTS[evidenceKind] ?? 0;
  reasons.push({
    factor: 'evidence_kind',
    weight: evidenceWeight,
    detail: `证据类型 ${evidenceKind === null ? '未采集' : `${echo(evidenceKind)}（${EVIDENCE_LABELS[evidenceKind] ?? '未列名'}）`}。`,
  });

  // 7) 核对状态：unverified 如实扣分。
  const verification = asRecord(record['verification']);
  const reviewStatus = verification === null ? null : asString(verification['review_status']);
  if (reviewStatus === 'unverified') {
    reasons.push({
      factor: 'review_status',
      weight: RECOMMENDATION_WEIGHTS.review_unverified,
      detail: '核对状态 unverified：字段未逐条复核，排序结果不构成可用性结论。',
    });
  } else if (reviewStatus !== null && reviewStatus !== 'verified') {
    reasons.push({
      factor: 'review_status',
      weight: 0,
      detail: `核对状态 ${echo(reviewStatus)}：非 verified，不计核对加分。`,
    });
  }

  // 8) 剂量：记录自身带剂量字段 ⇒ 不采纳，记一条 weight 0 的理由（值不回显）。
  const recordDoseKeys = doseKeys(record);
  if (recordDoseKeys.length > 0) {
    reasons.push({
      factor: 'dosage_ignored',
      weight: 0,
      detail: `该记录含剂量字段（${recordDoseKeys.map((key) => echo(key)).join('、')}），已整条丢弃：不参与排序、不输出剂量数字。`,
    });
  }
  // 查询上下文带剂量 ⇒ 每条候选都要能解释「为什么输入里的剂量没起作用」。
  if (ctx.queryDoseKeys.length > 0) {
    reasons.push({
      factor: 'dosage_ignored',
      weight: 0,
      detail: `查询上下文含剂量字段（${ctx.queryDoseKeys.map((key) => echo(key)).join('、')}），已整条丢弃：不参与排序、不输出剂量数字。`,
    });
  }

  // score 由 reasons 求和得出：这是「分数 = 理由加权和」的**结构性**保证。
  let score = 0;
  for (const reason of reasons) score += reason.weight;

  const name = asString(record['registered_name']) ?? '未采集';
  const item: RecommendationItem = Object.freeze({
    id,
    name: echo(sanitizeTerm(name).text),
    registration_number: registrationNumber,
    score,
    reasons: Object.freeze(reasons.map((reason) => Object.freeze({ ...reason }))),
  });
  return { item, inputIndex };
}

/**
 * 全序比较：`score` 降序 → `id` 升序 → 输入次序。
 * 不用 `localeCompare`（依赖 ICU 语言环境），直接比 UTF-16 码元，跨机器一致。
 */
function compareScored(a: ScoredItem, b: ScoredItem): number {
  if (a.item.score !== b.item.score) return b.item.score - a.item.score;
  if (a.item.id !== b.item.id) return a.item.id < b.item.id ? -1 : 1;
  return a.inputIndex - b.inputIndex;
}

/**
 * 推荐排序主入口：纯函数，不抛异常。
 *
 * @param input 真实记录 + 目录 + 可选查询；缺省即空输入
 * @returns 有序候选（含 `score` 与 `reasons`）、输入级说明、免责口径
 */
export function rankRecommendations(input?: RecommendationInput | null): RecommendationResult {
  const source = input ?? {};
  const records = Array.isArray(source.records) ? source.records : [];
  const ctx = buildContext(source);
  const notes: RecommendationNote[] = [...ctx.notes];

  const scored: ScoredItem[] = [];
  const rejectedIndexes: number[] = [];
  records.forEach((raw, index) => {
    const record = asRecord(raw);
    if (record === null) {
      rejectedIndexes.push(index);
      return;
    }
    const result = scoreRecord(record, index, ctx);
    if (result === null) {
      rejectedIndexes.push(index);
      return;
    }
    scored.push(result);
  });

  if (rejectedIndexes.length > 0) {
    const listed = rejectedIndexes.slice(0, MAX_REJECTED_IN_NOTE).join('、');
    const more = rejectedIndexes.length > MAX_REJECTED_IN_NOTE ? ' 等' : '';
    notes.push({
      code: 'record_rejected',
      detail: `跳过 ${rejectedIndexes.length} 条记录（下标 ${listed}${more}）：缺少 record_id 与 registration_number，或不是对象。`,
    });
  }

  const sorted = scored.slice().sort(compareScored);

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of sorted) {
    if (seen.has(entry.item.id)) duplicates.add(entry.item.id);
    seen.add(entry.item.id);
  }
  if (duplicates.size > 0) {
    notes.push({
      code: 'duplicate_id',
      detail: `有 ${duplicates.size} 个 id 在输入里重复（${[...duplicates].slice(0, MAX_REJECTED_IN_NOTE).map((id) => echo(id)).join('、')}），已按输入次序兜底排序。`,
    });
  }

  return Object.freeze({
    policy_version: RECOMMENDATION_POLICY_VERSION,
    disclaimer: RECOMMENDATION_DISCLAIMER,
    items: Object.freeze(sorted.map((entry) => entry.item)),
    notes: Object.freeze(notes.map((note) => Object.freeze({ ...note }))),
  });
}
