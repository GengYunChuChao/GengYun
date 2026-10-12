/**
 * GY-I07 查询展示层 · 确定性结构化查询。
 *
 * 对应 F03（作物—杂草—除草方式导航及筛选）与 F04/F14（条件优先、来源可追溯）。
 *
 * 设计原则（issue #7 范围）：
 *   1) **结构化条件优先**：crop_id / region_code / species_id / use_scene 先做**确定性过滤**，
 *      关键词（q / registration_number）在其后收窄 —— **不默认要求向量数据库**。
 *   2) **不静默放宽条件**：条件不满足的记录不计入匹配；**未满足原因**逐条列出。
 *   3) **无结果有原因**：`match_state=no_match`/`insufficient` 时给出可读原因与重筛入口，
 *      绝不以空白或模型补写填充（AC02）。
 *   4) **下架/失效退出有效查询**：`hidden`/`deleted` 可见性与非 `valid` 有效期一律被排除，
 *      列表与详情**同源同判**（一致）。
 *   5) **模拟记录单列**：模拟来源不进入真实有效集合；仅在显式请求演示时返回并强标记。
 *
 * 纯 ESM，无第三方依赖。
 */

import {
  APPLICABILITY_DIMENSIONS,
  APPLICABILITY_RULE_VERSION,
  DEFAULT_LIMIT,
  EVIDENCE_KINDS,
  MAX_LIMIT,
  MAX_QUERY_LENGTH,
  QUERYABLE_VALIDITIES,
  QUERYABLE_VISIBILITIES,
  REGION_CODE_PATTERN,
  RESTRICTION_STATUSES,
  SOURCE_KINDS,
} from './constants.mjs';
import { normalizeText, resolveNavTerm } from './catalog.mjs';
import { ReferenceError, FieldError } from './errors.mjs';
import { deriveSourceVersion, parseIngredients } from './records.mjs';

/**
 * 规范化查询输入。
 * @param {object} input 原始查询参数（来自 HTTP query 或页面 data）
 * @param {object} catalog loadCatalog() 结果
 */
export function normalizeQuery(input = {}, catalog) {
  const details = [];
  const q = typeof input.q === 'string' ? input.q.trim() : '';
  if (q.length > MAX_QUERY_LENGTH) {
    details.push(new FieldError('q', `关键词长度不得超过 ${MAX_QUERY_LENGTH}`));
  }
  const rawLimit = input.limit;
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      details.push(new FieldError('limit', `limit 必须为 1..${MAX_LIMIT} 的整数`));
    } else {
      limit = n;
    }
  }

  // 导航术语解析（作物／杂草／地区的名称或 id）
  const cropTerm = resolveNavTerm(catalog, input.crop_id ?? input.crop ?? '');
  const speciesTerm = resolveNavTerm(catalog, input.species_id ?? input.species ?? '');

  const cropId = cropTerm.kind === 'crop' ? cropTerm.id : null;
  const cropUnknown = (input.crop_id ?? input.crop) && cropTerm.kind !== 'crop';
  if (cropUnknown) details.push(new FieldError('crop_id', '作物未在目录中登记'));

  const speciesId = speciesTerm.kind === 'species' ? speciesTerm.id : null;
  const speciesUnknown = (input.species_id ?? input.species) && speciesTerm.kind !== 'species';
  if (speciesUnknown) details.push(new FieldError('species_id', '杂草未在目录中登记'));

  const regionInput = input.region_code ?? input.region ?? '';
  const regionResolved = resolveNavTerm(catalog, regionInput);
  let regionCode = null;
  if (regionInput) {
    if (typeof regionInput === 'string' && REGION_CODE_PATTERN.test(regionInput)) regionCode = regionInput;
    else if (regionResolved.kind === 'region') regionCode = regionResolved.id;
    else details.push(new FieldError('region_code', '地区须为浙江 33 开头的 6 位地区码'));
  }

  if (details.length > 0) {
    throw new ReferenceError('INVALID_REQUEST', '查询参数不合法', { details });
  }

  return Object.freeze({
    q,
    normQ: normalizeText(q),
    crop_id: cropId,
    species_id: speciesId,
    region_code: regionCode,
    use_scene: typeof input.use_scene === 'string' && input.use_scene.trim() !== '' ? input.use_scene.trim() : null,
    growth_stage: typeof input.growth_stage === 'string' && input.growth_stage.trim() !== '' ? input.growth_stage.trim() : null,
    planting_method: typeof input.planting_method === 'string' && input.planting_method.trim() !== '' ? input.planting_method.trim() : null,
    registration_number: typeof input.registration_number === 'string' && input.registration_number.trim() !== '' ? input.registration_number.trim() : null,
    limit,
    cursor: typeof input.cursor === 'string' ? input.cursor : null,
    include_simulated: input.include_simulated === true, // 仅显式请求时才纳入模拟数据
  });
}

/**
 * 单条记录的可见性/有效性判定（**列表与详情共用**，保证一致）。
 * 返回 { queryable, reason }。
 *
 * H2 口径（**契约合法性与 queryable 判定必须一致**）：
 * 契约 `SourceRef.source_kind`/`evidence_kind` 为冻结枚举、`Formulation.registration_number`
 * 为必填 —— 任一缺失即无法产出合法契约对象。此时若判 `queryable=true`，就会出现
 * 「Ajv 拒绝但可查询」的自相矛盾。故此处显式 fail-closed：**先判契约前提，再做可见性判定**。
 * （这类记录已在投影阶段被排除，不会出现在 `items` 中；此处保留兜底，防止绕过。）
 */
export function evaluateEligibility(item, { includeSimulated = false } = {}) {
  // 契约前提：来源枚举字段必须命中冻结枚举（不得为非枚举占位），登记证号必须存在。
  if (!SOURCE_KINDS.includes(item.source?.source_kind)) {
    return { queryable: false, reason: '来源类型缺失或非法枚举，无法满足契约必填（不编造来源类型）' };
  }
  if (!EVIDENCE_KINDS.includes(item.source?.evidence_kind)) {
    return { queryable: false, reason: '证据类型缺失或非法枚举，无法满足契约必填（不编造证据类型）' };
  }
  if (typeof item.registration_number !== 'string' || item.registration_number === '') {
    return { queryable: false, reason: '登记证号缺失，无法满足契约必填' };
  }

  if (item.visibility === 'hidden') return { queryable: false, reason: '该记录已下架' };
  if (item.visibility === 'deleted') return { queryable: false, reason: '该记录已删除' };
  if (!QUERYABLE_VISIBILITIES.includes(item.visibility)) return { queryable: false, reason: '该记录当前不可见' };

  const validity = item.source?.source_validity ?? item.source?.validity ?? 'unknown';
  if (!QUERYABLE_VALIDITIES.includes(validity)) {
    const map = { expired: '来源已过期', withdrawn: '来源已撤回', conflicting: '来源相互冲突', unknown: '来源有效期未知' };
    return { queryable: false, reason: map[validity] ?? '来源有效期不可用' };
  }

  if (item.simulated && !includeSimulated) {
    return { queryable: false, reason: '模拟演示记录（非真实资料）' };
  }
  return { queryable: true, reason: null };
}

/**
 * 对**已通过有效性判定**的记录做条件匹配，返回 { matched, reasons }。
 * reasons 列出**未满足的每一类条件**（AC02：缺项有原因）。
 */
export function matchConditions(item, query) {
  const reasons = [];

  if (query.crop_id && !(item.crop_ids ?? []).includes(query.crop_id)) {
    reasons.push(`作物不符（记录未覆盖该作物）`);
  }
  // 地区：首批资料无逐条地区码字段（GY-I03 gap 已声明）。有则匹配，无则**标注未标注**而非伪造匹配。
  if (query.region_code) {
    const recRegions = item.region_codes ?? null;
    if (Array.isArray(recRegions) && recRegions.length > 0) {
      if (!recRegions.includes(query.region_code)) reasons.push('适用地区不符');
    } else {
      reasons.push('记录未标注适用地区，无法确认是否适用该地区');
    }
  }
  if (query.species_id) {
    const recSpecies = item.species_ids ?? null;
    if (Array.isArray(recSpecies) && recSpecies.length > 0) {
      if (!recSpecies.includes(query.species_id)) reasons.push('防治对象与所选杂草不符');
    } else {
      reasons.push('记录未结构化标注杂草对象，无法按所选杂草确认');
    }
  }
  if (query.use_scene) {
    const scene = normalizeText(item.use_scene ?? '');
    if (!scene.includes(normalizeText(query.use_scene))) reasons.push('使用场景不符');
  }
  if (query.growth_stage || query.planting_method) {
    reasons.push('记录未采集生育期／种植方式条件');
  }

  if (query.registration_number) {
    if (normalizeText(item.registration_number) !== normalizeText(query.registration_number)) {
      reasons.push('登记证号不符');
    }
  }
  if (query.normQ) {
    const hay = [item.norm.name, item.norm.producer, item.norm.registration, item.norm.ingredients, item.norm.use_scene, item.norm.target].join(' ');
    if (!hay.includes(query.normQ)) reasons.push('关键词不匹配');
  }

  return { matched: reasons.length === 0, reasons };
}

/**
 * GY-I08 药剂适用过滤（确定性、fail-closed）。
 *
 * 给定一条记录与用户/场景上下文，逐维度检查「是否可进入可执行建议或问答用量卡片」。
 * 任一安全性维度缺失即如实说明，**不静默放宽**（AC13：未核对／不适用／禁用不进入可执行
 * 建议；规格：缺条件说明原因）。
 *
 * 维度（顺序同 `APPLICABILITY_DIMENSIONS`）：
 *   valid_source      —— 复用 evaluateEligibility（来源枚举/有效期/可见性/模拟）。
 *   banned_restricted —— 禁限用状态；banned 必阻断，restricted 默认阻断（除非显式 allow_restricted），
 *                       unknown（未采集）按 fail-closed：无法确认非禁用 → 阻断。
 *   crop              —— 记录 crop_ids 含上下文作物。
 *   growth_stage      —— 记录未采集该字段 → 标注无法确认（不阻断其它维度匹配）。
 *   region            —— 记录未标注地区码 → 标注无法确认。
 *   dosage_form       —— 上下文指定剂型时比对（含量剂型维度）。
 *   ingredient_content—— 上下文指定有效成分（名称±含量）时，比对 ingredients_text 解析结果。
 *   use_scene         —— 上下文使用场景做子串比对。
 *
 * @returns {{ applicable: boolean, blocked: string[], reasons: string[], rule_version: string }}
 *   applicable：是否可进入可执行建议/用量卡片（安全性维度全部通过）。
 *   blocked：被阻断的维度。
 *   reasons：每个未满足或未采集维度的可读原因（AC02：缺项有原因）。
 */
export function evaluateApplicability(item, context = {}, { ruleVersion = APPLICABILITY_RULE_VERSION } = {}) {
  const reasons = [];
  const blocked = [];

  // 1) 有效来源（复用既有 eligibility）。
  const elig = evaluateEligibility(item, { includeSimulated: context.include_simulated === true });
  if (!elig.queryable) {
    blocked.push('valid_source');
    reasons.push(`来源不可用：${elig.reason ?? '不满足契约必填或可查询条件'}`);
  }

  // 2) 禁限用（fail-closed：未知即不得确认为安全）。
  const restriction = readRestrictionStatus(item);
  if (restriction === 'banned') {
    blocked.push('banned_restricted');
    reasons.push('该药剂为禁用状态，不得进入用量建议');
  } else if (restriction === 'restricted') {
    if (context.allow_restricted === true) {
      reasons.push('该药剂为限用状态，已按上下文显式确认');
    } else {
      blocked.push('banned_restricted');
      reasons.push('该药剂为限用状态，需额外确认后方可进入用量建议');
    }
  } else if (restriction === 'unknown') {
    blocked.push('banned_restricted');
    reasons.push('未采集禁限用状态，无法确认非禁用，不得进入用量建议');
  }

  // 3) 作物。
  if (context.crop_id) {
    if (!(item.crop_ids ?? []).includes(context.crop_id)) {
      blocked.push('crop');
      reasons.push('作物不符（记录未覆盖该作物）');
    }
  }

  // 4) 生育期（记录未采集 → 标注无法确认，不阻断其它维度匹配）。
  if (context.growth_stage) {
    const gs = item.growth_stage ?? item.verification?.growth_stage;
    if (typeof gs === 'string' && gs.trim() !== '') {
      if (!normalizeText(gs).includes(normalizeText(context.growth_stage))) {
        reasons.push('生育期不符');
      }
    } else {
      reasons.push('记录未采集生育期条件，无法确认是否适用该生育期');
    }
  }

  // 5) 地区（记录未标注地区码 → 标注无法确认）。
  if (context.region_code) {
    const rc = Array.isArray(item.region_codes) ? item.region_codes : (typeof item.region_code === 'string' ? [item.region_code] : []);
    if (rc.length > 0) {
      if (!rc.includes(context.region_code)) {
        blocked.push('region');
        reasons.push('适用地区不符');
      }
    } else {
      reasons.push('记录未标注适用地区，无法确认是否适用该地区');
    }
  }

  // 6) 制剂（剂型）。
  if (context.dosage_form) {
    if (normalizeText(item.dosage_form ?? '') !== normalizeText(context.dosage_form)) {
      blocked.push('dosage_form');
      reasons.push('制剂（剂型）不符');
    }
  }

  // 7) 含量剂型（有效成分）。
  if (context.ingredient_content) {
    const want = normalizeText(context.ingredient_content);
    const parsed = item.verification?.parsed_ingredients ?? parseIngredients(item.ingredients_text);
    const hit = parsed.some((ing) => normalizeText(ing.name).includes(want) || normalizeText(ing.content_text).includes(want));
    if (!hit) {
      blocked.push('ingredient_content');
      reasons.push('有效成分/含量与所选不符');
    }
  }

  // 8) 使用场景。
  if (context.use_scene) {
    if (!normalizeText(item.use_scene ?? '').includes(normalizeText(context.use_scene))) {
      blocked.push('use_scene');
      reasons.push('使用场景不符');
    }
  }

  return Object.freeze({
    applicable: blocked.length === 0,
    blocked: Object.freeze(blocked),
    reasons: Object.freeze(reasons),
    rule_version: ruleVersion,
  });
}

/** 读取记录的禁限用状态（来源未给出时回退 unknown，绝不默认 unrestricted）。 */
function readRestrictionStatus(item) {
  const raw = item?.verification?.restriction_status ?? item?.source?.restriction_status ?? item?.restriction_status;
  if (typeof raw === 'string' && RESTRICTION_STATUSES.includes(raw)) return raw;
  return 'unknown';
}

/**
 * 执行查询。返回契约友好的结果对象：
 *   {
 *     match_state, items, next_cursor, total, reasons, unmatched_reasons, simulated_excluded, query
 *   }
 * 关键：`match_state` 区分 no_match（有条件但无命中）与 insufficient（条件缺项导致无法确认）。
 */
export function runQuery(items, query, catalog) {
  const eligible = [];
  let simulatedExcluded = 0;
  for (const item of items) {
    const verdict = evaluateEligibility(item, { includeSimulated: query.include_simulated });
    if (verdict.queryable) eligible.push(item);
    else if (item.simulated) simulatedExcluded += 1;
  }

  const matched = [];
  const perItemReasons = [];
  for (const item of eligible) {
    const r = matchConditions(item, query);
    if (r.matched) matched.push(item);
    else perItemReasons.push({ record_id: item.record_id, reasons: r.reasons });
  }

  // 稳定排序：登记号升序（确定性，便于分页与快照对比）。
  matched.sort((a, b) => (a.registration_number < b.registration_number ? -1 : a.registration_number > b.registration_number ? 1 : 0));

  // 判定 match_state
  const hasAnyCondition = Boolean(
    query.crop_id || query.species_id || query.region_code || query.use_scene || query.normQ || query.registration_number || query.growth_stage || query.planting_method,
  );
  let matchState;
  const reasons = [];
  if (matched.length > 0) {
    matchState = 'matched';
  } else if (eligible.length === 0) {
    matchState = hasAnyCondition ? 'no_match' : 'no_match';
    reasons.push(hasAnyCondition ? '当前条件下没有可用资料' : '资料集合为空');
  } else if (!hasAnyCondition) {
    // 无任何条件却无命中：属数据缺失（insufficient）。
    matchState = 'insufficient';
    reasons.push('资料集合为空，无法返回结果');
  } else {
    // 有条件但全部未命中：区分「条件不足（未标注）」与「确实不适用」。
    const anyInsufficient = perItemReasons.some((p) => p.reasons.some((x) => x.includes('未标注') || x.includes('未采集')));
    matchState = anyInsufficient ? 'insufficient' : 'no_match';
    reasons.push(anyInsufficient ? '部分条件在资料中未标注，无法确认适用性' : '现有资料均不满足所选条件');
  }

  const page = paginate(matched, query.limit, query.cursor);

  return Object.freeze({
    match_state: matchState,
    // 扁平投影（保持既有消费者与测试口径不变）。
    items: page.items.map(toListItem),
    // 原始内部条目（供 service 层投影为**纯契约对象**；不对外泄漏）。
    matched_items: Object.freeze(page.items.slice()),
    next_cursor: page.next_cursor,
    total: matched.length,
    reasons,
    unmatched_reasons: perItemReasons.slice(0, 10),
    simulated_excluded: simulatedExcluded,
    query: Object.freeze({
      q: query.q,
      crop_id: query.crop_id,
      species_id: query.species_id,
      region_code: query.region_code,
      use_scene: query.use_scene,
      registration_number: query.registration_number,
      limit: query.limit,
    }),
  });
}

/** 列表项投影（列表与详情同源：均取 item.contract，附 source_version 便于一致性核对）。 */
export function toListItem(item) {
  return Object.freeze({
    id: item.contract.id,
    registration_number: item.registration_number,
    registered_name: item.registered_name,
    dosage_form: item.dosage_form,
    ingredients_text: item.ingredients_text,
    toxicity: item.toxicity,
    use_scene: item.use_scene,
    crop_ids: item.crop_ids,
    source_version: item.source_version,
    record_status: item.record_status,
    reference_state: item.reference_state,
    simulated: item.simulated,
    source: item.contract.source,
  });
}

/**
 * 详情投影。**强制携带与列表相同的 source_version**；下架/失效在此**同样受控**
 * （详情与列表一致：不可见即 404 语义由上层转 NOT_FOUND）。
 */
export function toDetail(item, catalog) {
  const verdict = evaluateEligibility(item, { includeSimulated: true });
  return Object.freeze({
    contract: item.contract,
    knowledge: item.knowledge,
    registration_number: item.registration_number,
    registered_name: item.registered_name,
    producer: item.producer,
    dosage_form: item.dosage_form,
    ingredients_text: item.ingredients_text,
    toxicity: item.toxicity,
    use_scene: item.use_scene,
    target_original: item.target_original,
    crop_ids: item.crop_ids,
    record_status: item.record_status,
    reference_state: item.reference_state,
    simulated: item.simulated,
    queryable: verdict.queryable,
    unavailable_reason: verdict.reason,
    source_version: item.source_version,
    content_hash: item.content_hash,
    confidence_note: item.verification?.note ?? null,
    verified_scope: item.verification?.source_checked_scope ?? [],
    not_collected: item.verification?.not_collected ?? [],
    source: item.contract.source,
  });
}

/** 分页：cursor 为「上一页最后一条 registration_number」。非法游标抛 INVALID_CURSOR。 */
export function paginate(list, limit, cursor) {
  let start = 0;
  if (cursor !== null && cursor !== undefined && cursor !== '') {
    const idx = list.findIndex((x) => x.registration_number === cursor);
    if (idx === -1) throw new ReferenceError('INVALID_CURSOR', '游标无效或已过期', { details: [new FieldError('cursor', '游标指向的记录不存在')] });
    start = idx + 1;
  }
  const slice = list.slice(start, start + limit);
  const next = start + limit < list.length ? slice[slice.length - 1]?.registration_number ?? null : null;
  return { items: slice, next_cursor: next };
}
