/**
 * GY-R34 · **声明式数据保留策略表**（纯逻辑：只声明「哪张表、留多久、凭什么、怎么处理」，
 * 不连库、不删行、不读系统时钟）。
 *
 * ## 这个模块与既有两个 purge 命令的分工（为什么不合并）
 *
 * 仓里已有两条**域专用**的清除命令，它们各自绑定一个业务语义，**不在本表范围内**，
 * 本片既不重写也不改动它们：
 *
 * - `tools/purge-expired-online-data.mjs`（`npm run purge:online-data`）：注销**在线 7 日**到期，
 *   判据是 `deletion_requests.online_due_at`，属于「逐用户注销流程」，不是「表的日历保留期」；
 * - `tools/purge-expired-backup-copies.mjs`（`npm run purge:backup-copies`）：注销**备份 30 日**到期，
 *   判据是 `public.user_backup_copies` 的行状态，同理。
 *
 * 本模块补的是**第三类**：与注销无关、**按日历自然老化**的运维数据（幂等台账、会话、举报证据…）。
 * 这类数据此前没有任何声明式登记，删不删、留多久、凭什么，只散落在各域实现与口头约定里。
 * 保留判定与执行器分别在
 * `packages/privacy/retention-policy.mjs`（本文件）与 `tools/purge-retention-expired.mjs`（执行器）。
 *
 * ## 三条硬口径（每一条都对应单测）
 *
 * 1. **依据必填且来自闭集**：`basis` 只能是 `legal`（法务义务）／`product`（产品需要）／
 *    `audit`（审计与安全回溯）之一，另附 `basisRef`（引用到仓内文件:行或需求条目）——
 *    「我们觉得该删」不算依据。空依据的策略表在评审里是不可辩护的（`docs/implementation-requirements.md:284`
 *    「合法必要证据如有保留义务须单独限定目的、最小字段和时限」）。
 * 2. **天数必须是正整数，且语义唯一**：`retentionDays` 指「**年龄列的值**之后再过 N 天」。
 *    年龄列可以是 `created_at`（按创建时间老化），也可以是 `expires_at`（按过期时刻老化）——
 *    两种语义都在 `ageColumn` 里显式写出来，绝不由读者猜「7 天是从哪一刻算起」。
 * 3. **处理方式只有三种，且必须是可执行的**：
 *    - `delete`：整行物理删除（行本身无留存义务）；
 *    - `anonymize`：只把 `targetColumn` 置 `NULL`，行保留（审计/统计还要用，但内容已最小化）；
 *    - `archive_marker`：只把 `markerSource` 指向的列（本表就是年龄列 `expires_at`）抄进
 *      `targetColumn`，行保留（审计线索不得删，只把「已不可用」这件事显式化）。
 *    三种都**不读时钟**（`archive_marker` 抄的是行内既有值），因此重复执行天然幂等：
 *    第二次跑匹配 0 行。⛔ 不允许出现「未登记处理方式」的策略行 —— 执行器遇到未知值直接报错，不猜。
 *
 * ## 为什么表清单这么短（刻意不做的事）
 *
 * 只登记**用现有列就能真执行**的表。`RETENTION_EXCLUSIONS` 逐条写清被排除的表与理由，
 * 其中 `public.admin_audit_events` 是**最值得记的一条**：它在迁移 0017 里是 append-only
 * （`BEFORE UPDATE OR DELETE` 触发器直接 `RAISE EXCEPTION … 'AUDIT_IMMUTABLE'`），
 * 所以「审计行保留、擦掉身份提示」这种匿名化**在库层面根本做不到**，
 * 只能排除并另立机制，而不是在策略表里写一条跑不动的愿望。
 *
 * ## 时间口径
 *
 * 本模块不读系统时钟：`retentionCutoffIso({ now, retentionDays })` 的 `now` 必须由调用方给
 * （执行器取库时钟 `SELECT now()`，单测注入固定时刻）。到期取**闭区间**：
 * 年龄列的值 `<= cutoff` 即到期（`WHERE age_column < $1` 配合 `cutoff = now - N 天`
 * 与 `<=` 等价于「年龄 ≥ N 天」），与 `packages/privacy/backup-retention.mjs` 的
 * `now >= retentionUntil` 同口径。
 */

/** 策略表标识（写进每份执行报告的 `policy=` 字段，便于审计对照）。 */
export const RETENTION_POLICY_ID = 'GY-R34-RETENTION';

/** 保留依据闭集（法务 / 产品 / 审计留存）。 */
export const RETENTION_BASES = Object.freeze(['legal', 'product', 'audit']);

/** 处理方式闭集（删除 / 匿名化 / 仅归档标记）。 */
export const RETENTION_DISPOSITIONS = Object.freeze(['delete', 'anonymize', 'archive_marker']);

/**
 * `archive_marker` 的标记值来源闭集。
 *
 * 现在只有 `age_column` 一种：标记列拿**行内年龄列**的值（`revoked_at = expires_at`），
 * 不读时钟 ⇒ 重复执行匹配 0 行。要新增来源（例如 `now`）必须先证明它仍幂等。
 */
export const RETENTION_MARKER_SOURCES = Object.freeze(['age_column']);

/** 单批上限（硬顶）：一批最多处理 500 行，事务边界才不会被单批拖成大事务。 */
export const MAX_RETENTION_BATCH_LIMIT = 500;

/** 单批默认值（与硬顶相同：默认就是最激进的合法值，运维不必背另一套数字）。 */
export const DEFAULT_RETENTION_BATCH_LIMIT = 500;

/** 单表单轮默认最多推几批（防止一次运维把库跑满；跑不完下一轮继续）。 */
export const DEFAULT_RETENTION_MAX_BATCHES = 10;

/** 单表单轮批数硬顶。 */
export const MAX_RETENTION_MAX_BATCHES = 50;

/**
 * @typedef {object} RetentionPolicyEntry
 * @property {string} table                  形如 `public.idempotency_keys`（schema 必写，禁裸表名）
 * @property {string} ageColumn              年龄列（`created_at` / `expires_at` …）
 * @property {number} retentionDays          ≥ 1 的正整数；从**年龄列的值**起算
 * @property {'legal' | 'product' | 'audit'} basis
 * @property {string} basisRef               依据出处（仓内 `文件:行` 或需求条目），必填
 * @property {'delete' | 'anonymize' | 'archive_marker'} disposition
 * @property {string | null} targetColumn    `anonymize` / `archive_marker` 必填，`delete` 必须为 null
 * @property {'age_column' | null} markerSource `archive_marker` 必填，其余必须为 null
 * @property {string} why                    一句话说明「为什么是这个天数」（供评审与审计阅读）
 * @property {boolean} idempotent   `anonymize` / `archive_marker` 的实际实现是否靠「置 NULL /
 *                                           置非 NULL」自证幂等（三种都要求为 true）
 */

/**
 * 策略表本体（4 张表，覆盖三种处理方式）。
 *
 * 排序即执行顺序（无依赖，但保持稳定以便审计逐行对照）。
 *
 * @type {ReadonlyArray<Readonly<RetentionPolicyEntry>>}
 */
export const RETENTION_POLICY = Object.freeze([
  Object.freeze({
    table: 'public.idempotency_keys',
    ageColumn: 'expires_at',
    retentionDays: 1,
    basis: 'product',
    basisRef: 'services/api/src/auth/idempotency.ts:32-33',
    disposition: 'delete',
    targetColumn: null,
    markerSource: null,
    why:
      '幂等回执的 TTL 是 24 小时（IDEMPOTENCY_TTL_SECONDS），过期后重放不可能再命中；'
      + '再留 1 天只为排障/对账余量，之后该键既无凭据价值也无业务价值。',
    idempotent: true,
  }),
  Object.freeze({
    table: 'public.sessions',
    ageColumn: 'expires_at',
    retentionDays: 30,
    basis: 'audit',
    basisRef: 'docs/implementation-requirements.md:281',
    disposition: 'delete',
    targetColumn: null,
    markerSource: null,
    why:
      '过期会话只留不可逆 token_hash，用途是安全事件回溯；回溯窗口与「备份 30 日」对齐，'
      + '超窗后无保留义务，按最小化原则整行删除。',
    idempotent: true,
  }),
  Object.freeze({
    table: 'public.admin_sessions',
    ageColumn: 'expires_at',
    retentionDays: 90,
    basis: 'audit',
    basisRef: 'docs/implementation-requirements.md:284',
    disposition: 'archive_marker',
    targetColumn: 'revoked_at',
    markerSource: 'age_column',
    why:
      '后台会话是审计线索，**不物理删除**；过期 90 天后把 revoked_at 置为 expires_at，'
      + '让「已过期但未撤销」的后台会话收敛为 0（幂等：第二次跑匹配 0 行）。'
      + '运行时角色对该列有列级 UPDATE 授权（services/api/db/roles/auth_privacy.sql:31），无需新授权。',
    idempotent: true,
  }),
  Object.freeze({
    table: 'public.community_reports',
    ageColumn: 'created_at',
    retentionDays: 180,
    basis: 'legal',
    basisRef: 'docs/implementation-requirements.md:284',
    disposition: 'anonymize',
    targetColumn: 'detail',
    markerSource: null,
    why:
      '举报记录（状态/对象/理由码）要留作社区治理台账，但 `detail` 是举报人手写的自由文本，'
      + '可能含个人信息；180 天后只把该列置 NULL、行与其状态机保留，符合「保留台账但最小字段」。',
    idempotent: true,
  }),
]);

/**
 * 明确**不纳入**本策略表的表及理由（评审要求：排除也要给依据，不能靠「没写」表示不做）。
 *
 * @type {ReadonlyArray<Readonly<{ table: string, reason: string }>>}
 */
export const RETENTION_EXCLUSIONS = Object.freeze([
  Object.freeze({
    table: 'public.admin_audit_events',
    reason:
      'append-only：迁移 0017 的 BEFORE UPDATE OR DELETE 触发器抛 AUDIT_IMMUTABLE，'
      + '在库层面无法匿名化或删除；擦除归档需另立机制（本片不伪造一个跑不动的策略行）。',
  }),
  Object.freeze({
    table: 'public.transcriptions / public.conversations / public.messages / public.favorites / public.history',
    reason: '私有会话与识别记录按 F13 保留至注销（docs/implementation-requirements.md:380），不走日历保留。',
  }),
  Object.freeze({
    table: 'public.user_backup_copies',
    reason: '30 日窗口由 `npm run purge:backup-copies` 与 packages/privacy/backup-retention.mjs 管，本片不重复实现。',
  }),
  Object.freeze({
    table: 'public.media_object_cleanup',
    reason: '这是「待清理对象」的可重试 outbox：删行等于丢重试依据，只能由清理链自身收敛，不得按日历删。',
  }),
  Object.freeze({
    table: 'public.deletion_requests / public.deletion_handlers / public.third_party_deletions',
    reason: '注销工单与完成证据，保留期须覆盖 30 日备份与恢复演练（data-dictionary:92），归 #19 口径，不并入日历策略。',
  }),
  Object.freeze({
    table: 'public.exports / public.export_writebacks',
    reason: '外发台账是 F13 取证材料（docs/implementation-requirements.md:281），随注销去身份而非按日历删除。',
  }),
]);

/** 策略自洽校验的失败码（稳定、可断言）。 */
export const RETENTION_POLICY_ERROR_CODES = Object.freeze({
  NOT_ARRAY: 'RETENTION_POLICY_NOT_ARRAY',
  ENTRY_NOT_OBJECT: 'RETENTION_ENTRY_NOT_OBJECT',
  TABLE_NAME: 'RETENTION_TABLE_NAME_INVALID',
  TABLE_DUPLICATE: 'RETENTION_TABLE_DUPLICATE',
  COLUMN_NAME: 'RETENTION_COLUMN_NAME_INVALID',
  DAYS: 'RETENTION_DAYS_INVALID',
  BASIS: 'RETENTION_BASIS_INVALID',
  BASIS_REF: 'RETENTION_BASIS_REF_MISSING',
  DISPOSITION: 'RETENTION_DISPOSITION_INVALID',
  TARGET_COLUMN: 'RETENTION_TARGET_COLUMN_INVALID',
  MARKER_SOURCE: 'RETENTION_MARKER_SOURCE_INVALID',
  WHY: 'RETENTION_WHY_MISSING',
  IDEMPOTENCE: 'RETENTION_IDEMPOTENCE_NOT_DECLARED',
});

/** 标识符字面量规则（schema/table/column 都走它；策略表里只允许这种形态，杜绝拼 SQL 的空间）。 */
const TABLE_PATTERN = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const COLUMN_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * 严格 ISO-8601（必须带 `Z` 或 `±HH:MM`）。与 `packages/privacy/backup-retention.mjs:92`
 * 及 `services/api/src/privacy/deletion-aging.ts` 的 `ISO_8601_STRICT` 逐字相同：
 * 裸本地时间不接受。
 */
const ISO_8601_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** 一天的毫秒数。 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 把入参时刻解析成 epoch 毫秒；不可信返回 `null`（调用方 fail closed）。
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function parseInstant(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    if (!ISO_8601_STRICT.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * 策略自洽校验：任何一条不合格就抛 `TypeError`（带稳定 `code`），**不放行部分策略**。
 *
 * 判据（逐条对应单测）：
 *   - 策略是数组且非空；每行是对象；
 *   - `table` 形如 `schema.table`（小写标识符），且**全表唯一**（无重复表）；
 *   - `retentionDays` 是 ≥ 1 的整数（「天数>0」；`0` 与 `1.5` 都拒绝 —— 抽样口径不猜）；
 *   - `basis` 在闭集内 **且** `basisRef` 非空（依据必填）；
 *   - `disposition` 在闭集内；`delete` 不得带 `targetColumn`/`markerSource`，
 *     `anonymize` 必须带 `targetColumn`、不得带 `markerSource` 以外的值，
 *     `archive_marker` 必须同时带 `targetColumn` 与 `markerSource`；
 *   - `why` 非空（评审要能读到理由）；
 *   - `idempotent` 必须显式为 `true`（不允许「大概幂等」）。
 *
 * @param {unknown} policy
 * @returns {ReadonlyArray<RetentionPolicyEntry>} 原样返回（不复制，调用方只读）
 */
export function assertRetentionPolicy(policy = RETENTION_POLICY) {
  if (!Array.isArray(policy) || policy.length === 0) {
    throw policyError(RETENTION_POLICY_ERROR_CODES.NOT_ARRAY, '保留策略必须是**非空**数组');
  }

  const seen = new Set();
  for (const [index, entry] of policy.entries()) {
    const at = `策略表第 ${index + 1} 行`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw policyError(RETENTION_POLICY_ERROR_CODES.ENTRY_NOT_OBJECT, `${at}不是对象`);
    }

    if (typeof entry.table !== 'string' || !TABLE_PATTERN.test(entry.table)) {
      throw policyError(
        RETENTION_POLICY_ERROR_CODES.TABLE_NAME,
        `${at}的 table 必须是「schema.table」形式的小写标识符（收到 ${JSON.stringify(entry.table)}）`,
      );
    }
    if (seen.has(entry.table)) {
      throw policyError(RETENTION_POLICY_ERROR_CODES.TABLE_DUPLICATE, `${at}重复登记了 ${entry.table}`);
    }
    seen.add(entry.table);

    if (typeof entry.ageColumn !== 'string' || !COLUMN_PATTERN.test(entry.ageColumn)) {
      throw policyError(
        RETENTION_POLICY_ERROR_CODES.COLUMN_NAME,
        `${at}（${entry.table}）的 ageColumn 必须是合法列名（收到 ${JSON.stringify(entry.ageColumn)}）`,
      );
    }

    if (!Number.isInteger(entry.retentionDays) || entry.retentionDays < 1) {
      throw policyError(
        RETENTION_POLICY_ERROR_CODES.DAYS,
        `${at}（${entry.table}）的 retentionDays 必须是 ≥1 的整数（收到 ${JSON.stringify(entry.retentionDays)}）`,
      );
    }

    if (!RETENTION_BASES.includes(entry.basis)) {
      throw policyError(
        RETENTION_POLICY_ERROR_CODES.BASIS,
        `${at}（${entry.table}）的 basis 必须在 ${RETENTION_BASES.join('/')} 内（收到 ${JSON.stringify(entry.basis)}）`,
      );
    }
    if (typeof entry.basisRef !== 'string' || entry.basisRef.trim() === '') {
      throw policyError(
        RETENTION_POLICY_ERROR_CODES.BASIS_REF,
        `${at}（${entry.table}）缺 basisRef：依据必须引用到仓内文件:行或需求条目`,
      );
    }

    if (!RETENTION_DISPOSITIONS.includes(entry.disposition)) {
      throw policyError(
        RETENTION_POLICY_ERROR_CODES.DISPOSITION,
        `${at}（${entry.table}）的 disposition 必须在 ${RETENTION_DISPOSITIONS.join('/')} 内`
          + `（收到 ${JSON.stringify(entry.disposition)}）`,
      );
    }

    const hasTarget = entry.targetColumn !== null && entry.targetColumn !== undefined;
    if (hasTarget && (typeof entry.targetColumn !== 'string' || !COLUMN_PATTERN.test(entry.targetColumn))) {
      throw policyError(
        RETENTION_POLICY_ERROR_CODES.TARGET_COLUMN,
        `${at}（${entry.table}）的 targetColumn 必须是合法列名（收到 ${JSON.stringify(entry.targetColumn)}）`,
      );
    }
    if (entry.disposition === 'delete' && hasTarget) {
      throw policyError(
        RETENTION_POLICY_ERROR_CODES.TARGET_COLUMN,
        `${at}（${entry.table}）的 disposition=delete 不得声明 targetColumn`,
      );
    }
    if (entry.disposition !== 'delete' && !hasTarget) {
      throw policyError(
        RETENTION_POLICY_ERROR_CODES.TARGET_COLUMN,
        `${at}（${entry.table}）的 disposition=${entry.disposition} 必须声明 targetColumn`,
      );
    }

    const markerSource = entry.markerSource ?? null;
    if (entry.disposition === 'archive_marker') {
      if (!RETENTION_MARKER_SOURCES.includes(markerSource)) {
        throw policyError(
          RETENTION_POLICY_ERROR_CODES.MARKER_SOURCE,
          `${at}（${entry.table}）的 markerSource 必须在 ${RETENTION_MARKER_SOURCES.join('/')} 内`
            + `（收到 ${JSON.stringify(entry.markerSource)}）`,
        );
      }
    } else if (markerSource !== null) {
      throw policyError(
        RETENTION_POLICY_ERROR_CODES.MARKER_SOURCE,
        `${at}（${entry.table}）的 disposition=${entry.disposition} 不得声明 markerSource`,
      );
    }

    if (typeof entry.why !== 'string' || entry.why.trim() === '') {
      throw policyError(RETENTION_POLICY_ERROR_CODES.WHY, `${at}（${entry.table}）缺 why：天数要能解释`);
    }
    if (entry.idempotent !== true) {
      throw policyError(
        RETENTION_POLICY_ERROR_CODES.IDEMPOTENCE,
        `${at}（${entry.table}）必须显式声明 idempotent: true`,
      );
    }
  }

  return policy;
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {TypeError}
 */
function policyError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

/**
 * 保留截止时刻：`now - retentionDays × 24h`，返回 UTC ISO-8601。
 *
 * 语义（必须与 `ageColumn` 一起读）：年龄列的值 `<= 本截止时刻` ⇒ 该行已过保留期。
 * 因此 `ageColumn = 'expires_at'` + `retentionDays = 30` 读作「过期后再留 30 天」。
 *
 * @param {{ now: string | number | Date, retentionDays: number }} input
 * @returns {string} UTC ISO-8601
 */
export function retentionCutoffIso({ now, retentionDays } = {}) {
  const nowMs = parseInstant(now);
  if (nowMs === null) {
    throw new TypeError(
      'now 必须是 Date／epoch 毫秒／带时区的 ISO-8601 字符串（不接受裸本地时间与空值）',
    );
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new TypeError(`retentionDays 必须是 ≥1 的整数（收到 ${JSON.stringify(retentionDays)}）`);
  }
  return new Date(nowMs - retentionDays * MS_PER_DAY).toISOString();
}

/**
 * 到期行的 WHERE 子句（不含 `LIMIT`），供计数与变更两条 SQL 共用**同一个**判据。
 *
 * @param {RetentionPolicyEntry} entry
 * @returns {string}
 */
export function retentionDuePredicate(entry) {
  const { table, ageColumn, disposition, targetColumn } = entry;
  assertPolicyEntryForSql(entry);
  const base = `"${table.split('.')[0]}"."${table.split('.')[1]}" WHERE "${ageColumn}" < $1`;
  if (disposition === 'delete') return base;
  // 匿名化/标记：只处理「还没被处理过」的行 —— 幂等判据的第二半（第一半是 WHERE 条件本身会消失）。
  return `${base} AND "${targetColumn}" IS ${disposition === 'anonymize' ? 'NOT NULL' : 'NULL'}`;
}

/**
 * 计数 SQL（dry-run 唯一会发的语句）：只读，不写库。
 *
 * @param {RetentionPolicyEntry} entry
 * @returns {string}
 */
export function buildRetentionCountSql(entry) {
  return `SELECT count(*)::bigint AS due FROM ${retentionDuePredicate(entry)}`;
}

/**
 * 变更 SQL（每批一条语句；`LIMIT` 由调用方作为第二个参数传入）。
 *
 * - `delete`：`DELETE … WHERE ctid IN (SELECT ctid … ORDER BY age LIMIT $2)`；
 * - `anonymize`：`UPDATE … SET target = NULL …`；
 * - `archive_marker`：`UPDATE … SET target = age_column …`（标记值来自行内，不读时钟）。
 *
 * 三条都返回受影响行数（`rowCount`），执行器据此判断「这批吃完没」。
 *
 * @param {RetentionPolicyEntry} entry
 * @returns {string}
 */
export function buildRetentionMutationSql(entry) {
  assertPolicyEntryForSql(entry);
  const predicate = retentionDuePredicate(entry);
  const { table, ageColumn, disposition, targetColumn } = entry;
  const inner = `SELECT ctid FROM ${predicate} ORDER BY "${ageColumn}" ASC LIMIT $2`;
  if (disposition === 'delete') {
    return `DELETE FROM "${table.split('.')[0]}"."${table.split('.')[1]}" WHERE ctid IN (${inner})`;
  }
  const value = disposition === 'anonymize' ? 'NULL' : `"${ageColumn}"`;
  return `UPDATE "${table.split('.')[0]}"."${table.split('.')[1]}" SET "${targetColumn}" = ${value} WHERE ctid IN (${inner})`;
}

/**
 * 拼 SQL 前的最后一道闸：表名/列名必须仍是合法小写标识符（防未来有人往策略表塞拼接串）。
 *
 * @param {RetentionPolicyEntry} entry
 */
function assertPolicyEntryForSql(entry) {
  if (entry === null || typeof entry !== 'object') {
    throw policyError(RETENTION_POLICY_ERROR_CODES.ENTRY_NOT_OBJECT, '策略行必须是对象');
  }
  if (typeof entry.table !== 'string' || !TABLE_PATTERN.test(entry.table)) {
    throw policyError(RETENTION_POLICY_ERROR_CODES.TABLE_NAME, `非法表名：${JSON.stringify(entry.table)}`);
  }
  for (const column of [entry.ageColumn, entry.targetColumn]) {
    if (column === null || column === undefined) continue;
    if (typeof column !== 'string' || !COLUMN_PATTERN.test(column)) {
      throw policyError(RETENTION_POLICY_ERROR_CODES.COLUMN_NAME, `非法列名：${JSON.stringify(column)}`);
    }
  }
}

/**
 * 批大小归一化：只接受 1..500 的整数（超出硬顶就报错，不静默截断 —— 静默截断会让
 * 运维以为「--batch 5000 生效了」，而真实事务边界仍是 500）。
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeRetentionBatchLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RETENTION_BATCH_LIMIT) {
    throw new RangeError(
      `批大小必须是 1..${MAX_RETENTION_BATCH_LIMIT} 的整数（收到 ${JSON.stringify(value)}）`,
    );
  }
  return value;
}

/**
 * 单轮批数上限归一化：1..50 的整数。
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeRetentionMaxBatches(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RETENTION_MAX_BATCHES) {
    throw new RangeError(
      `批数上限必须是 1..${MAX_RETENTION_MAX_BATCHES} 的整数（收到 ${JSON.stringify(value)}）`,
    );
  }
  return value;
}
