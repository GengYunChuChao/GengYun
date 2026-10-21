/**
 * 后台「资料管理」页面的展示状态机——纯 ESM，无 Vue／DOM 依赖。
 *
 * 与账号目录页（`view-model.mjs`）同一套纪律，钉住四条不下假的规则：
 *  1. 列表里的行**只能**来自服务端返回；本地不合成、不补默认行。
 *  2. 刷新失败时保留旧行但标 `stale`，不许把旧数据当新数据。
 *  3. 写操作回执（成功或失败）**必定**带 `request_id`／`If-Match`／`Idempotency-Key` 的原文，
 *     失败时还带错误码——页面没有「静默吞掉」这个分支。
 *  4. 审计台账查不到时只说「扫了多少条没找到」，不显示成「没有审计记录」。
 *
 * 术语提醒（写进页面文案，别让读者误会）：
 * 契约 `Visibility`（private/published/hidden/deleted）**不等于**服务层生命周期
 * （draft/published/withdrawn）：撤回后再次编辑，head 修订是 `private`，但生命周期仍是 `withdrawn`。
 * 本模块只翻译契约里**真实存在**的字段，不推断生命周期。
 */

import { REVIEW_STATUSES, SOURCE_KINDS, EVIDENCE_KINDS, KNOWLEDGE_TYPES, CATEGORY_TYPES, VISIBILITIES } from './admin-content-contract.mjs';

/** `Visibility` → 中文标签（一一对应，不合并状态）。 */
export const VISIBILITY_LABELS = Object.freeze({
  private: '草稿／未生效',
  published: '已发布',
  hidden: '已下架',
  deleted: '已删除',
});

export const VISIBILITY_TONES = Object.freeze({
  private: 'warn',
  published: 'ok',
  hidden: 'warn',
  deleted: 'danger',
});

export const REVIEW_LABELS = Object.freeze({
  unverified: '未核验',
  verified: '已核验',
  rejected: '已驳回',
});

export const REVIEW_TONES = Object.freeze({
  unverified: 'warn',
  verified: 'ok',
  rejected: 'danger',
});

export const SOURCE_KIND_LABELS = Object.freeze({
  database: '数据库',
  verified_seed: '人工核验种子',
  simulation: '情景模拟',
});

export const EVIDENCE_KIND_LABELS = Object.freeze({
  research: '研究',
  experience: '经验',
  mixed: '混合',
});

export const KNOWLEDGE_TYPE_LABELS = Object.freeze({
  species: '物种',
  herbicide: '除草剂',
  scheme: '方案',
  static_region: '地区常驻',
});

export const CATEGORY_TYPE_LABELS = Object.freeze({
  crop: '作物',
  species: '物种',
});

export const VALIDITY_LABELS = Object.freeze({
  valid: '有效',
  expired: '已过期',
  conflicting: '冲突',
  unknown: '未知',
  withdrawn: '已下架',
});

/** 页面固定说明：可见性 ≠ 生命周期（避免把 private 一律读成「草稿」）。 */
export const LIFECYCLE_NOTE =
  '状态列显示契约字段 visibility（private / published / hidden / deleted）。服务层生命周期（草稿 / 已发布 / 已撤回）不在契约读面里；撤回后再编辑会显示 private，但服务端仍记为「已撤回」，以服务端判定为准。';

/** 写操作回执上固定显示的审计口径说明。 */
export const AUDIT_SCOPE_NOTE =
  '契约写响应只有 data + meta，没有 audit event id。下面用 meta.request_id 关联审计台账，并显示本次真实发出的 If-Match / Idempotency-Key；审计事件本身不含操作者字段，页面不会伪造责任人姓名。';

function emptyCollection() {
  return { items: [], nextCursor: null, pages: 0, seenIds: [], duplicates: 0, cycle: false };
}

/** 初始态：未加载。 */
export function initialFamilyState() {
  return {
    phase: 'idle',
    collection: emptyCollection(),
    selectedId: null,
    detail: null,
    detailPhase: 'idle',
    detailFailure: null,
    failure: null,
    stale: false,
    busyWrite: false,
    write: null,
    auditLookup: null,
  };
}

function sameSelection(state) {
  if (state.selectedId === null) return null;
  return state.collection.items.some((row) => row.id === state.selectedId) ? state.selectedId : null;
}

/** 纯 reducer：不合法的事件原样返回旧状态（例如未加载完成就收到写回执）。 */
export function reduceFamily(state, action) {
  switch (action?.type) {
    case 'LOAD_START': {
      const reset = action.reset === true;
      return {
        ...state,
        phase: reset ? 'loading' : state.phase === 'ready' ? 'ready' : 'loading',
        failure: reset ? null : state.failure,
        stale: reset ? false : state.stale,
        collection: reset ? emptyCollection() : state.collection,
        selectedId: reset ? null : state.selectedId,
        detail: reset ? null : state.detail,
        detailPhase: reset ? 'idle' : state.detailPhase,
        detailFailure: reset ? null : state.detailFailure,
      };
    }

    case 'LOAD_OK': {
      const previous = state.collection;
      const seen = new Set(previous.seenIds);
      const items = previous.items.slice();
      let duplicates = previous.duplicates;
      for (const row of action.page.items) {
        if (seen.has(row.id)) {
          duplicates += 1;
          continue;
        }
        seen.add(row.id);
        items.push(row);
      }
      const nextCursor = action.page.nextCursor ?? null;
      const cycle = nextCursor !== null && action.cursor !== null && nextCursor === action.cursor;
      const collection = {
        items,
        nextCursor: cycle ? null : nextCursor,
        pages: previous.pages + 1,
        seenIds: Array.from(seen),
        duplicates,
        cycle,
      };
      const next = {
        ...state,
        collection,
        failure: null,
        stale: false,
        phase: items.length === 0 ? 'empty' : 'ready',
        selectedId: sameSelection({ ...state, collection }),
      };
      return next;
    }

    case 'LOAD_FAIL':
      return {
        ...state,
        phase: state.collection.items.length > 0 ? 'ready' : 'error',
        failure: action.failure ?? null,
        stale: state.collection.items.length > 0,
      };

    case 'SELECT':
      return action.id === null
        ? { ...state, selectedId: null, detail: null, detailPhase: 'idle', detailFailure: null, auditLookup: null }
        : { ...state, selectedId: action.id, detail: null, detailPhase: 'idle', detailFailure: null, auditLookup: null };

    /**
     * 用**服务端写响应**里返回的资源替换／插入列表行（新建草稿时插到最前）。
     * 行仍然只来自服务端：本 action 不接受页面自己拼的行，也不改别的行。
     */
    case 'ROW_UPSERT': {
      const item = action.item;
      if (item === null || typeof item !== 'object' || typeof item.id !== 'string') return state;
      const existing = state.collection.items.findIndex((row) => row.id === item.id);
      const items = state.collection.items.slice();
      if (existing >= 0) items[existing] = item;
      else items.unshift(item);
      const seenIds = existing >= 0 ? state.collection.seenIds : Array.from(new Set([...state.collection.seenIds, item.id]));
      return {
        ...state,
        collection: { ...state.collection, items, seenIds },
        phase: 'ready',
      };
    }

    case 'DETAIL_START':
      return { ...state, detailPhase: 'loading', detailFailure: null };

    case 'DETAIL_OK':
      return { ...state, detail: action.item, detailPhase: 'ready', detailFailure: null };

    case 'DETAIL_FAIL':
      return { ...state, detailPhase: 'error', detailFailure: action.failure ?? null, detail: null };

    case 'WRITE_START':
      return { ...state, busyWrite: true, write: { phase: 'pending', label: action.label ?? '' } };

    case 'WRITE_SETTLED':
      return { ...state, busyWrite: false, write: action.receipt, auditLookup: null };

    case 'AUDIT_START':
      return { ...state, auditLookup: { phase: 'loading' } };

    case 'AUDIT_OK':
      return {
        ...state,
        auditLookup: {
          phase: 'ready',
          events: action.events ?? [],
          scanned: action.scanned ?? 0,
          truncated: action.truncated === true,
        },
      };

    case 'AUDIT_FAIL':
      return { ...state, auditLookup: { phase: 'error', failure: action.failure ?? null } };

    case 'AUDIT_CLEAR':
      return { ...state, auditLookup: null };

    case 'WRITE_CLEAR':
      return { ...state, write: null, auditLookup: null };

    default:
      return state;
  }
}

/** 列表状态 → 文案（加载中／空／筛选空／就绪／过期／失败，各用各的话）。 */
export function describeFamily(state, options = {}) {
  const label = options.label ?? '资料';
  const total = state.collection.items.length;
  if (state.phase === 'idle') {
    return { phase: 'idle', tone: 'empty', title: `尚未读取${label}`, detail: '点「重新读取」按契约分页拉取。', canRetry: false };
  }
  if (state.phase === 'loading') {
    return { phase: 'loading', tone: 'empty', title: `正在读取${label}…`, detail: '按 limit／cursor 分页请求；不使用缓存行。', canRetry: false };
  }
  if (state.phase === 'error') {
    return {
      phase: 'error',
      tone: 'error',
      title: '读取失败',
      detail: state.failure === null ? '未知错误' : `${state.failure.code ?? '无错误码'}（HTTP ${state.failure.status ?? '—'}）${state.failure.message ?? ''}`,
      canRetry: true,
    };
  }
  if (state.stale) {
    return {
      phase: 'stale',
      tone: 'stale',
      title: '刷新失败，显示的是上次读到的行',
      detail: `共 ${total} 行（旧数据，未更新）· ${state.failure?.code ?? '无错误码'}（HTTP ${state.failure?.status ?? '—'}）`,
      canRetry: true,
    };
  }
  if (state.phase === 'empty') {
    return {
      phase: 'empty',
      tone: 'empty',
      title: '接口返回 0 行',
      detail: '服务端确实没有这类资料（不是筛选结果，也不是加载失败）。',
      canRetry: false,
    };
  }
  return {
    phase: 'ready',
    tone: 'ready',
    title: `已读取 ${total} 行`,
    detail: `已翻 ${state.collection.pages} 页${state.collection.nextCursor === null ? '，已到末页' : '，还有下一页'}`,
    canRetry: false,
  };
}

export function canLoadMoreFamily(state) {
  return state.phase === 'ready' && state.collection.nextCursor !== null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** RFC 3339 → `YYYY-MM-DD HH:MM`（本地时区）；不可解析时原样返回，不猜时间。 */
export function formatDateTime(value) {
  if (typeof value !== 'string' || value === '') return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())} ${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`;
}

export function shortId(id) {
  return typeof id === 'string' && id.length > 12 ? id.slice(0, 8) : String(id ?? '');
}

function label(map, value) {
  return map[value] ?? `未知(${String(value)})`;
}

function tone(map, value) {
  return map[value] ?? 'warn';
}

/** `SourceDraft` → 表格行（列与派单要求的 title / version / status / 时间对齐；`updated_at` 是唯一时间字段）。 */
export function sourceRow(item) {
  return {
    id: item.id,
    revision: item.revision,
    revisionLabel: `"${item.revision}"`,
    title: item.source.title,
    versionLabel: item.source.version,
    statusLabel: label(VISIBILITY_LABELS, item.visibility),
    statusTone: tone(VISIBILITY_TONES, item.visibility),
    reviewLabel: label(REVIEW_LABELS, item.source.review_status),
    reviewTone: tone(REVIEW_TONES, item.source.review_status),
    validityLabel: label(VALIDITY_LABELS, item.source.validity),
    kindLabel: label(SOURCE_KIND_LABELS, item.source.source_kind),
    evidenceLabel: label(EVIDENCE_KIND_LABELS, item.source.evidence_kind),
    updatedLabel: formatDateTime(item.source.updated_at),
    shortId: shortId(item.id),
  };
}

/** `KnowledgeDraft` → 表格行（契约读面没有 `updated_at`，时间列如实显示「契约未提供」）。 */
export function knowledgeRow(item) {
  return {
    id: item.id,
    revision: item.revision,
    revisionLabel: `"${item.revision}"`,
    title: item.content.title,
    versionLabel: item.content.source_version,
    statusLabel: label(VISIBILITY_LABELS, item.visibility),
    statusTone: tone(VISIBILITY_TONES, item.visibility),
    reviewLabel: label(REVIEW_LABELS, item.review_status),
    reviewTone: tone(REVIEW_TONES, item.review_status),
    typeLabel: label(KNOWLEDGE_TYPE_LABELS, item.content.type),
    updatedLabel: '契约未提供',
    shortId: shortId(item.id),
  };
}

/** `Category` → 表格行。 */
export function categoryRow(item) {
  return {
    id: item.id,
    revision: item.revision,
    revisionLabel: `"${item.revision}"`,
    title: item.name,
    versionLabel: label(CATEGORY_TYPE_LABELS, item.type),
    statusLabel: item.active ? '启用' : '停用',
    statusTone: item.active ? 'ok' : 'warn',
    reviewLabel: '—',
    reviewTone: 'warn',
    description: item.description,
    shortId: shortId(item.id),
  };
}

/**
 * 详情摘要（点开一行后展示）。
 *
 * `missing` 明确列出**读面不返回**、因此页面不能显示的字段：不补、不猜。
 */
export function sourceDetailView(item) {
  const source = item.source;
  return {
    id: item.id,
    revision: item.revision,
    etag: `"${item.revision}"`,
    title: source.title,
    fields: [
      { label: '来源 ID', value: item.id },
      { label: '版本', value: source.version },
      { label: '标题', value: source.title },
      { label: '发布方', value: source.publisher },
      { label: '链接', value: source.url },
      { label: '来源类型', value: label(SOURCE_KIND_LABELS, source.source_kind) },
      { label: '证据类型', value: label(EVIDENCE_KIND_LABELS, source.evidence_kind) },
      { label: '有效期判定', value: label(VALIDITY_LABELS, source.validity) },
      { label: '核验状态', value: label(REVIEW_LABELS, source.review_status) },
      { label: '可见性', value: label(VISIBILITY_LABELS, item.visibility) },
      { label: '更新时间', value: formatDateTime(source.updated_at) },
      { label: '当前修订（If-Match）', value: `"${item.revision}"` },
    ],
    missing: ['content_hash', 'locator', 'valid_from', 'valid_to', '创建时间', '操作者'],
    note: '编辑本来源时必须重新填写内容指纹、定位串与有效期：读面 SourceRef 不返回这四项，页面不会用旧值冒充。',
  };
}

export function knowledgeDetailView(item) {
  const content = item.content;
  const conditions = content.conditions === null ? '无（null）' : Object.entries(content.conditions).map(([k, v]) => `${k}=${String(v)}`).join('，');
  return {
    id: item.id,
    revision: item.revision,
    etag: `"${item.revision}"`,
    title: content.title,
    fields: [
      { label: '内容 ID', value: item.id },
      { label: '类型', value: label(KNOWLEDGE_TYPE_LABELS, content.type) },
      { label: '标题', value: content.title },
      { label: '正文', value: content.body },
      { label: '来源 ID', value: content.source_id },
      { label: '来源版本', value: content.source_version },
      { label: '条件', value: conditions },
      { label: '制剂 ID', value: content.formulation_id ?? '无（null）' },
      { label: '可见性', value: label(VISIBILITY_LABELS, item.visibility) },
      { label: '核验状态', value: label(REVIEW_LABELS, item.review_status) },
      { label: '当前修订（If-Match）', value: `"${item.revision}"` },
    ],
    missing: ['创建时间', '更新时间', '操作者', '发布过的修订号'],
    note: '契约 KnowledgeDraft 只有上述字段；本页不显示发布过的历史修订，也不显示操作者。',
  };
}

export function categoryDetailView(item) {
  return {
    id: item.id,
    revision: item.revision,
    etag: `"${item.revision}"`,
    title: item.name,
    fields: [
      { label: '分类 ID', value: item.id },
      { label: '类型', value: label(CATEGORY_TYPE_LABELS, item.type) },
      { label: '名称', value: item.name },
      { label: '说明', value: item.description },
      { label: '启用', value: item.active ? '是' : '否' },
      { label: '当前修订（If-Match）', value: `"${item.revision}"` },
    ],
    missing: ['创建时间', '更新时间', '操作者'],
    note: '契约 CategoryInput 没有 type 字段：PATCH 只能改名称／说明／启用状态，分类类型不可改。',
  };
}

/**
 * 写操作回执 → 展示行。
 *
 * 成功与失败都返回**同样的字段集**（失败多一条错误码），页面因此没有「静默成功」的分支。
 */
export function receiptLines(write) {
  if (write === null || write === undefined) return [];
  if (write.phase === 'pending') return [{ label: '进行中', value: write.label ?? '' }];
  const lines = [];
  lines.push({ label: '操作', value: write.label ?? '' });
  lines.push({ label: '结果', value: write.ok === true ? `成功（HTTP ${write.status}）` : `失败（HTTP ${write.status ?? '—'}）` });
  if (write.ok !== true) {
    lines.push({ label: '错误码', value: write.code === null || write.code === undefined ? '服务端未返回错误码' : `${write.code}${write.inContract === false ? '（契约外码）' : ''}` });
    if (write.message !== undefined && write.message !== '') lines.push({ label: '服务端说明', value: write.message });
  }
  lines.push({ label: '请求 URL', value: write.requestUrl ?? '—' });
  lines.push({ label: 'request_id（审计关联键）', value: write.requestId ?? '服务端未返回' });
  if (write.ok === true) lines.push({ label: '响应 ETag', value: write.etag ?? '未返回' });
  const sent = write.sentHeaders ?? {};
  lines.push({ label: '发出的 If-Match', value: sent['if-match'] ?? '未发（本操作不需要 If-Match）' });
  lines.push({ label: '发出的 Idempotency-Key', value: sent['idempotency-key'] ?? '未发（不应发生）' });
  return lines;
}

/** 审计台账查找结果 → 文案（找不到时只说扫了多少条）。 */
export function describeAuditLookup(lookup) {
  if (lookup === null || lookup === undefined) return null;
  if (lookup.phase === 'loading') return { tone: 'empty', title: '正在读取审计台账…', detail: 'GET /admin/audit-events（scope audit:read）。' };
  if (lookup.phase === 'error') {
    return {
      tone: 'error',
      title: '审计台账读取失败',
      detail: `${lookup.failure?.code ?? '无错误码'}（HTTP ${lookup.failure?.status ?? '—'}）${lookup.failure?.message ?? ''}`,
    };
  }
  if (lookup.events.length > 0) {
    return { tone: 'ready', title: `找到 ${lookup.events.length} 条审计事件`, detail: `本次扫描 ${lookup.scanned} 条，按 request_id 匹配。` };
  }
  return {
    tone: 'stale',
    title: '本次扫描的审计台账里没有匹配 request_id 的事件',
    detail: `已扫描最近 ${lookup.scanned} 条${lookup.truncated ? '（达到扫描上限，更早的记录未检查）' : '（已到末页）'}。这不等于「没有审计记录」，只是这一次没扫到。`,
  };
}

/** 兜底：确认契约枚举与标签表一一对应（改契约后这里会先坏，而不是页面显示「未知」）。 */
export function selfCheckLabelCoverage() {
  const problems = [];
  if (Object.keys(VISIBILITY_LABELS).length !== VISIBILITIES.length) problems.push('Visibility 标签缺项');
  if (Object.keys(REVIEW_LABELS).length !== REVIEW_STATUSES.length) problems.push('review_status 标签缺项');
  if (Object.keys(SOURCE_KIND_LABELS).length !== SOURCE_KINDS.length) problems.push('SourceKind 标签缺项');
  if (Object.keys(EVIDENCE_KIND_LABELS).length !== EVIDENCE_KINDS.length) problems.push('EvidenceKind 标签缺项');
  if (Object.keys(KNOWLEDGE_TYPE_LABELS).length !== KNOWLEDGE_TYPES.length) problems.push('KnowledgeDraftInput.type 标签缺项');
  if (Object.keys(CATEGORY_TYPE_LABELS).length !== CATEGORY_TYPES.length) problems.push('Category.type 标签缺项');
  return problems;
}
