/**
 * GY-I15（#15）切片 C1 · 社区域的 **PostgreSQL 实现**（迁移 `0022_community_persistence.sql`）。
 *
 * 与内存实现（`./store.ts`）**逐方法对齐**——同接口、同语义、同失败原因（这是本文件的验收
 * 口径，不是"大致等价"）：
 *   - `insertPost` / `insertComment`：内容行与审核结论**同一次事务**写入；同 `id` 已存在 ⇒
 *     不写入、返回 `false`（判定只由主键 `ON CONFLICT (id) DO NOTHING RETURNING` 给出，
 *     没有"先 SELECT 再 INSERT"的窗口）。`insertComment` 的 `requireParent` 校验与插入在
 *     同一事务内完成（父帖行加 `FOR SHARE`，父帖被并发删除/改版时不得插入孤儿评论）。
 *   - `commitPostIfCurrent` / `commitCommentIfCurrent`：**唯一**的更新原语，且是 CAS——
 *     `SELECT ... FOR UPDATE` 之后按内存实现的**同一顺序**逐项比较
 *     （不存在 → `NOT_FOUND`；已删除 → `DELETED`；作者不符 → `AUTHOR_CHANGED`；
 *     revision 不符 → `REVISION_CHANGED`；可见性不符 → `VISIBILITY_CHANGED`；
 *     审核状态不符 → `AUDIT_STATE_CHANGED`），全部通过才写回。**没有任何无条件覆盖的入口**。
 *     补丁里**不含** `revision` 时不动 revision（删除/重审只改 `visibility`/`audit_state`/
 *     `updated_at`），与内存实现的 `{ ...current, ...patch }` 同义。
 *   - `addLike` / `removeLike`：集合语义。重复 PUT 由唯一键
 *     `(user_id, target_type, target_id)` 裁决为 no-op（**不重复计数**），`removeLike` 未点赞
 *     为无操作，计数恒不为负；`countLikes` 是 `count(*)` 派生量，**没有**计数器列。
 *   - `putRefusalVerdict`：未提交内容的结论补录。同一 `(type, id, revision)` 已有结论 ⇒
 *     不覆盖（**保持首条**）；该 revision 的内容已存在 ⇒ 也不补录（它的结论必须由提交路径
 *     同原子写入）。两条判据与写入是**同一条语句**（`INSERT ... SELECT ... WHERE NOT EXISTS`
 *     + `ON CONFLICT DO NOTHING`），因此没有检查-写入窗口。
 *   - 幂等台账**真落库**（`community_idempotency`）：`claim` / `complete` / `release` 各是
 *     **一条**带条件的语句（`ON CONFLICT DO NOTHING RETURNING` / `UPDATE ... AND outcome IS NULL` /
 *     `DELETE ... AND outcome IS NULL`），`outcome IS NULL` = 已认领未完成；
 *     `awaitIdempotencySettled` 有界轮询（默认 25ms 间隔、总时长沿用 `waitMs`）**每次真读库**，
 *     不用进程内 Map 假装。
 *
 * 读取时重查可见性：本文件**不做任何跨请求缓存**，也不缓存"已发布"标记；`getPost` /
 * `getComment` / `listPosts` / `listComments` 每次都真读库，可见性由服务层 `effectiveState()`
 * 现查 `community_moderation_decisions` 并比对 `text_digest` 后判定。因此隐藏、失效、
 * 注销都不会因为存储层缓存而"复活"。
 *
 * 与内存实现**有意不同**的两点（都在迁移注释里写明，不是悄悄放宽）：
 *   1. `community_comments.post_id` 有外键到 `community_posts`。唯一调用方
 *      （`service.ts` 的建评论路径）总是传 `requireParent`，所以孤儿评论本来就不可能存在；
 *      外键是多一层网。若某个调用方不传 `requireParent` 且父帖不存在，本实现会得到
 *      `PROVIDER_UNAVAILABLE`（外键违反）而不是内存实现的 `true`——本片无此调用方。
 *   2. 举报表**没有**数据字典里的 `unique (reporter_id, target_type, target_id,
 *      target_revision)`：重复举报的去重由服务层 Idempotency-Key 裁决，`insertReport` 在接口上
 *      是按 `id` 覆盖的 `void`；加唯一约束会把"换个 Idempotency-Key 再举报一次"从"两行"
 *      变成 503，与接口语义冲突。
 *
 * 错误折叠：`57014`（语句超时）/ `55P03`（锁不可得）⇒ `PROVIDER_TIMEOUT`，其余数据库异常 ⇒
 * `PROVIDER_UNAVAILABLE`，与 `messages/store-pg.ts` / `favorites/store-pg.ts` 同口径。
 */
import { ApiError } from '../errors.ts';
import { isTransientDatabaseError } from '../db/pool.ts';
import type {
  CommentCommitExpectation,
  CommentCommitPatch,
  CommentRecord,
  CommitResult,
  CommunityOwnerPurgeCounts,
  CommunityStore,
  IdempotencyOutcome,
  IdempotencyRecord,
  ListPostsFilter,
  ModerationRecord,
  PostCommitExpectation,
  PostCommitPatch,
  PostRecord,
  ReportCommitExpectation,
  ReportCommitPatch,
  ReportRecord,
} from './store.ts';
import { AUTHOR_REFS_REMAINING_UNKNOWN, readAuthorRefsRemaining } from './store.ts';
import type { AuditState, KnowledgeTarget, ReportTarget, Visibility } from './types.ts';
import { redactPersonalInfo } from './personal-info.ts';
import { ANONYMIZED_AUTHOR_REF_PATTERN, createAnonymizedAuthorRef } from './authors.ts';

/** `pg` 连接池/连接的最小形状（与 `db/pool.ts` 的 `PgPool` 结构兼容；测试可传记录型假池）。 */
export interface SqlRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PgConnection extends SqlRunner {
  release(): void;
}

/** 带事务能力的连接池（`PgPool` 结构兼容）。CAS 必须走这里：比较与写入要在同一事务内。 */
export interface TransactionalPool extends SqlRunner {
  connect(): Promise<PgConnection>;
}

export interface PostgresCommunityStoreOptions {
  pool: TransactionalPool;
  /** 轮询幂等占位时的间隔（毫秒）；只为测试可注入，默认 25。 */
  settlePollMs?: number;
}

/** 数据库异常的契约化折叠（与 `messages/store-pg.ts` 逐条同口径）。 */
export function classifyCommunityDatabaseError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ['57014', '55P03'].includes(code)) {
    throw new ApiError('PROVIDER_TIMEOUT', '社区数据库响应超时', { retryable: true });
  }
  if (error instanceof ApiError) throw error;
  // `retryable` 分档（口径原文见 `../errors.ts` 的 `ApiError` 注释）：连接层故障（08xxx）、管理员干预
  // （53xxx / 57P0x）、串行化冲突（40001）、死锁（40P01）⇒ 同一请求稍后重试**确实**可能成功 ⇒ true；
  // 权限不足（42501）、库/表/凭据缺失（3D000 / 28P01 / 42P01）、函数缺失（42883）与无法归类的其余
  // 驱动错误 ⇒ 需运维改配置或修缺陷，重试永远不会好 ⇒ false（⛔ 恒 true 会把权限缺失伪装成下游抖动）。
  throw new ApiError('PROVIDER_UNAVAILABLE', '社区数据库暂不可用', { retryable: isTransientDatabaseError(error) });
}

/** `awaitIdempotencySettled` 的轮询间隔（与内存实现的有界等待同口径：25ms、不忙等）。 */
const SETTLE_POLL_INTERVAL_MS = 25;

// `anonymized_author_ref` 属迁移 0030：读路径要用它投影注销作者（`author_id ?? anonymized_author_ref`），
// 因此必须在列清单里（列级 SELECT 授权同步在 `20-login-roles.sql` / `90-assert-least-privilege.sql`）。
const POST_COLUMNS =
  'id, revision, author_id, anonymized_author_ref, title, body, crop_id, region_code, media_ids,'
  + ' linked_knowledge_type, linked_knowledge_id, linked_knowledge_revision, visibility, audit_state,'
  + ' created_at, updated_at';
const COMMENT_COLUMNS =
  'id, revision, post_id, author_id, anonymized_author_ref, body, visibility, audit_state, created_at';
const REPORT_COLUMNS =
  'id, revision, reporter_id, target_type, target_id, target_revision, state, reason_code, detail, created_at';
const MODERATION_COLUMNS =
  'id, target_type, target_id, target_revision, decision, reason_codes, hard_rule_passed, rule_version,'
  + ' text_digest, contract_complete, missing_contract_fields, created_at';

/** 闭集（与 `types.ts` 逐值一致）：读出时不在闭集内 ⇒ 内部不变式违反，**不静默降级**。 */
const VISIBILITY_VALUES: readonly Visibility[] = ['private', 'published', 'hidden', 'deleted'];
const AUDIT_STATE_VALUES: readonly AuditState[] = ['pending', 'approved', 'rejected', 'quarantined'];
const TARGET_TYPE_VALUES: readonly ReportTarget['type'][] = ['post', 'comment'];
const REPORT_STATE_VALUES: readonly ReportRecord['state'][] = ['received', 'isolated', 'closed'];
const KNOWLEDGE_TYPE_VALUES: readonly KnowledgeTarget['type'][] = ['species', 'herbicide', 'scheme'];
const OUTCOME_KINDS: readonly IdempotencyOutcome['kind'][] = ['post', 'comment', 'report', 'ack'];

function closedValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `社区${label}不在契约闭集内（内部不变式违反）`, { retryable: false });
  }
  return value as T;
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function asTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  throw new ApiError('PROVIDER_UNAVAILABLE', '社区媒体引用形状不合约定（内部不变式违反）', { retryable: false });
}

function asLinkedKnowledge(row: Record<string, unknown>): KnowledgeTarget | null {
  const type = row.linked_knowledge_type;
  if (type === null || type === undefined) return null;
  const id = row.linked_knowledge_id;
  const revision = row.linked_knowledge_revision;
  if (typeof id !== 'string' || typeof revision !== 'number') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '社区知识关联形状不合约定（内部不变式违反）', { retryable: false });
  }
  return { type: closedValue(type, KNOWLEDGE_TYPE_VALUES, '知识关联类型'), id, revision };
}

/**
 * 可空的内部作者指针。
 *
 * **这是 0030 之前的一个真坑**：旧写法 `String(row.author_id)` 把 SQL NULL 变成字符串 `'null'`，
 * 于是 `service.ts` 会拿 `'null'` 去 `authors.resolve()` 投影出一个"耕云用户xxxx"的活跃假名 ——
 * 已注销内容看起来仍有作者，且 `scope='mine'` 的 `record.author_id === user.userId` 恒为 false
 * （这部分"碰巧正确"）。现在显式保留 NULL，让"没有作者 id"与"作者 id 恰好叫 null"不可能混淆。
 */
function nullableUuid(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** 行内注销引用（迁移 0030）；NULL = 未注销行。形状由库侧 CHECK 保证，这里只做类型归一。 */
function nullableAnonRef(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** 数据库行 → 帖子记录（字段名与记录一致；未知闭集值按内部不变式违反处理）。 */
export function postRecordFromRow(row: Record<string, unknown>): PostRecord {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    author_id: nullableUuid(row.author_id),
    anonymized_author_ref: nullableAnonRef(row.anonymized_author_ref),
    title: String(row.title),
    body: String(row.body),
    crop_id: row.crop_id === null || row.crop_id === undefined ? null : String(row.crop_id),
    region_code: row.region_code === null || row.region_code === undefined ? null : String(row.region_code),
    media_ids: asTextArray(row.media_ids),
    linked_knowledge_ref: asLinkedKnowledge(row),
    visibility: closedValue(row.visibility, VISIBILITY_VALUES, '可见性'),
    audit_state: closedValue(row.audit_state, AUDIT_STATE_VALUES, '审核状态'),
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
  };
}

export function commentRecordFromRow(row: Record<string, unknown>): CommentRecord {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    post_id: String(row.post_id),
    author_id: nullableUuid(row.author_id),
    anonymized_author_ref: nullableAnonRef(row.anonymized_author_ref),
    body: String(row.body),
    visibility: closedValue(row.visibility, VISIBILITY_VALUES, '可见性'),
    audit_state: closedValue(row.audit_state, AUDIT_STATE_VALUES, '审核状态'),
    created_at: asIso(row.created_at),
  };
}

export function reportRecordFromRow(row: Record<string, unknown>): ReportRecord {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    reporter_id: String(row.reporter_id),
    target_ref: {
      type: closedValue(row.target_type, TARGET_TYPE_VALUES, '目标类型'),
      id: String(row.target_id),
      revision: Number(row.target_revision),
    },
    state: closedValue(row.state, REPORT_STATE_VALUES, '举报状态'),
    reason_code: String(row.reason_code),
    detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
    created_at: asIso(row.created_at),
  };
}

function asJsonArray(value: unknown, label: string): string[] {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `社区${label}形状不合约定（内部不变式违反）`, { retryable: false });
  }
  return parsed.map((item) => String(item));
}

export function moderationRecordFromRow(row: Record<string, unknown>): ModerationRecord {
  return {
    id: String(row.id),
    target_ref: {
      type: closedValue(row.target_type, TARGET_TYPE_VALUES, '目标类型'),
      id: String(row.target_id),
      revision: Number(row.target_revision),
    },
    decision: closedValue(row.decision, AUDIT_STATE_VALUES, '审核结论'),
    reason_codes: asJsonArray(row.reason_codes, '结论原因码'),
    hard_rule_passed: row.hard_rule_passed === true,
    rule_version: row.rule_version === null || row.rule_version === undefined ? null : String(row.rule_version),
    text_digest: String(row.text_digest),
    // 台账只存"契约是否完整"这一个布尔；本片恒定 false（模型层版本未取得）。
    contract_complete: false,
    missing_contract_fields: asJsonArray(row.missing_contract_fields, '缺失契约字段'),
    created_at: asIso(row.created_at),
  };
}

/** 台账 `outcome` → 结果引用；形状不符按内部不变式违反处理（绝不回放别人的结果）。 */
function outcomeFromRow(value: unknown): IdempotencyOutcome {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  const candidate = (parsed ?? {}) as Partial<IdempotencyOutcome>;
  if (typeof candidate.id !== 'string' || typeof candidate.revision !== 'number') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '幂等台账结果引用不可解析（内部不变式违反）', { retryable: false });
  }
  return {
    kind: closedValue(candidate.kind, OUTCOME_KINDS, '幂等结果类型'),
    id: candidate.id,
    revision: candidate.revision,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  // 不因等待者而拖住进程退出（与内存实现的 `unref` 同口径）。
  if (typeof timer.unref === 'function') timer.unref();
});

/** 事务包裹：`BEGIN` → `SET LOCAL lock_timeout` → 业务 → `COMMIT`；异常折叠为契约错误。 */
async function withTransaction<T>(pool: TransactionalPool, run: (sql: SqlRunner) => Promise<T>): Promise<T> {
  let connection: PgConnection | null = null;
  try {
    connection = await pool.connect();
    await connection.query('BEGIN');
    await connection.query("SET LOCAL lock_timeout = '4s'");
    const result = await run(connection);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    if (connection !== null) {
      try {
        await connection.query('ROLLBACK');
      } catch {
        // 回滚失败不覆盖原始异常：原始异常才是可诊断的原因。
      }
    }
    return classifyCommunityDatabaseError(error);
  } finally {
    connection?.release();
  }
}

/** 审核结论写入（提交路径专用：同键**覆盖**，与内存实现的 `Map.set` 同义）。 */
async function writeModeration(
  sql: SqlRunner,
  kind: ReportTarget['type'],
  id: string,
  revision: number,
  record: ModerationRecord,
): Promise<void> {
  await sql.query(
    `INSERT INTO community_moderation_decisions
       (target_type, target_id, target_revision, id, decision, reason_codes, hard_rule_passed,
        rule_version, text_digest, contract_complete, missing_contract_fields, created_at)
     VALUES ($1::text, $2::uuid, $3, $4::uuid, $5::audit_state, $6::jsonb, $7, $8, $9, $10, $11::jsonb,
             $12::timestamptz)
     ON CONFLICT (target_type, target_id, target_revision) DO UPDATE
       SET id = EXCLUDED.id,
           decision = EXCLUDED.decision,
           reason_codes = EXCLUDED.reason_codes,
           hard_rule_passed = EXCLUDED.hard_rule_passed,
           rule_version = EXCLUDED.rule_version,
           text_digest = EXCLUDED.text_digest,
           contract_complete = EXCLUDED.contract_complete,
           missing_contract_fields = EXCLUDED.missing_contract_fields,
           created_at = EXCLUDED.created_at`,
    [
      kind,
      id,
      revision,
      record.id,
      record.decision,
      JSON.stringify(record.reason_codes),
      record.hard_rule_passed,
      record.rule_version,
      record.text_digest,
      record.contract_complete,
      JSON.stringify(record.missing_contract_fields),
      record.created_at,
    ],
  );
}

/** 帖子补丁合并：只应用**显式给出**（`!== undefined`）的键，与内存实现的浅合并同义。 */
function mergePostPatch(current: PostRecord, patch: PostCommitPatch): PostRecord {
  const next: PostRecord = { ...current };
  if (patch.revision !== undefined) next.revision = patch.revision;
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.body !== undefined) next.body = patch.body;
  if (patch.crop_id !== undefined) next.crop_id = patch.crop_id;
  if (patch.region_code !== undefined) next.region_code = patch.region_code;
  if (patch.media_ids !== undefined) next.media_ids = [...patch.media_ids];
  if (patch.linked_knowledge_ref !== undefined) {
    next.linked_knowledge_ref =
      patch.linked_knowledge_ref === null ? null : { ...patch.linked_knowledge_ref };
  }
  if (patch.visibility !== undefined) next.visibility = patch.visibility;
  if (patch.audit_state !== undefined) next.audit_state = patch.audit_state;
  if (patch.updated_at !== undefined) next.updated_at = patch.updated_at;
  return next;
}

function mergeCommentPatch(current: CommentRecord, patch: CommentCommitPatch): CommentRecord {
  const next: CommentRecord = { ...current };
  if (patch.revision !== undefined) next.revision = patch.revision;
  if (patch.body !== undefined) next.body = patch.body;
  if (patch.visibility !== undefined) next.visibility = patch.visibility;
  if (patch.audit_state !== undefined) next.audit_state = patch.audit_state;
  return next;
}

export interface CommunitySnapshotCounts {
  posts: number;
  comments: number;
  reports: number;
  moderation: number;
}

/** PG 社区存储：在 `CommunityStore` 之上多一个**真读库**的行数快照（与内存实现的同名助手对齐）。 */
export interface PgCommunityStore extends CommunityStore {
  snapshotCounts(): Promise<CommunitySnapshotCounts>;
}

export function createPostgresCommunityStore(options: PostgresCommunityStoreOptions): PgCommunityStore {
  const { pool } = options;
  const settlePollMs = options.settlePollMs ?? SETTLE_POLL_INTERVAL_MS;

  async function run(text: string, values?: unknown[]): Promise<Array<Record<string, unknown>>> {
    try {
      const result = await pool.query(text, values);
      return result.rows;
    } catch (error) {
      classifyCommunityDatabaseError(error);
    }
  }

  async function readPost(id: string): Promise<PostRecord | null> {
    const rows = await run(`SELECT ${POST_COLUMNS} FROM community_posts WHERE id = $1::uuid`, [id]);
    const row = rows[0];
    return row === undefined ? null : postRecordFromRow(row);
  }

  async function readComment(id: string): Promise<CommentRecord | null> {
    const rows = await run(`SELECT ${COMMENT_COLUMNS} FROM community_comments WHERE id = $1::uuid`, [id]);
    const row = rows[0];
    return row === undefined ? null : commentRecordFromRow(row);
  }

  async function commitPost(
    id: string,
    expected: PostCommitExpectation,
    patch: PostCommitPatch,
    moderation: ModerationRecord | null,
  ): Promise<CommitResult<PostRecord>> {
    return withTransaction<CommitResult<PostRecord>>(pool, async (sql) => {
      const current = (await sql.query(
        `SELECT ${POST_COLUMNS} FROM community_posts WHERE id = $1::uuid FOR UPDATE`,
        [id],
      )).rows[0];
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' };
      const before = postRecordFromRow(current);
      // 判定顺序与内存实现**逐条一致**（顺序本身是语义：删除是单向门，先于归属判定）。
      if (before.visibility === 'deleted') return { ok: false, reason: 'DELETED' };
      if (expected.author_id !== undefined && before.author_id !== expected.author_id) {
        return { ok: false, reason: 'AUTHOR_CHANGED' };
      }
      if (before.revision !== expected.revision) return { ok: false, reason: 'REVISION_CHANGED' };
      if (expected.visibility !== undefined && before.visibility !== expected.visibility) {
        return { ok: false, reason: 'VISIBILITY_CHANGED' };
      }
      if (expected.audit_state !== undefined && before.audit_state !== expected.audit_state) {
        return { ok: false, reason: 'AUDIT_STATE_CHANGED' };
      }
      const next = mergePostPatch(before, patch);
      const linked = next.linked_knowledge_ref;
      await sql.query(
        `UPDATE community_posts
            SET revision = $2, title = $3, body = $4, crop_id = $5, region_code = $6, media_ids = $7::text[],
                linked_knowledge_type = $8::linked_target_type, linked_knowledge_id = $9,
                linked_knowledge_revision = $10, visibility = $11::visibility, audit_state = $12::audit_state,
                updated_at = $13::timestamptz
          WHERE id = $1::uuid`,
        [
          id,
          next.revision,
          next.title,
          next.body,
          next.crop_id,
          next.region_code,
          next.media_ids,
          linked === null ? null : linked.type,
          linked === null ? null : linked.id,
          linked === null ? null : linked.revision,
          next.visibility,
          next.audit_state,
          next.updated_at,
        ],
      );
      // 结论绑定到**写入后的 revision**（与内存实现 `moderationComposite(..., next.revision)` 同义）。
      if (moderation !== null) await writeModeration(sql, 'post', id, next.revision, moderation);
      return { ok: true, record: next };
    });
  }

  async function commitComment(
    id: string,
    expected: CommentCommitExpectation,
    patch: CommentCommitPatch,
    moderation: ModerationRecord | null,
  ): Promise<CommitResult<CommentRecord>> {
    return withTransaction<CommitResult<CommentRecord>>(pool, async (sql) => {
      const current = (await sql.query(
        `SELECT ${COMMENT_COLUMNS} FROM community_comments WHERE id = $1::uuid FOR UPDATE`,
        [id],
      )).rows[0];
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' };
      const before = commentRecordFromRow(current);
      if (before.visibility === 'deleted') return { ok: false, reason: 'DELETED' };
      if (expected.author_id !== undefined && before.author_id !== expected.author_id) {
        return { ok: false, reason: 'AUTHOR_CHANGED' };
      }
      if (before.revision !== expected.revision) return { ok: false, reason: 'REVISION_CHANGED' };
      if (expected.visibility !== undefined && before.visibility !== expected.visibility) {
        return { ok: false, reason: 'VISIBILITY_CHANGED' };
      }
      if (expected.audit_state !== undefined && before.audit_state !== expected.audit_state) {
        return { ok: false, reason: 'AUDIT_STATE_CHANGED' };
      }
      const next = mergeCommentPatch(before, patch);
      await sql.query(
        `UPDATE community_comments
            SET revision = $2, body = $3, visibility = $4::visibility, audit_state = $5::audit_state
          WHERE id = $1::uuid`,
        [id, next.revision, next.body, next.visibility, next.audit_state],
      );
      if (moderation !== null) await writeModeration(sql, 'comment', id, next.revision, moderation);
      return { ok: true, record: next };
    });
  }

  /**
   * 举报状态推进（CAS）。
   *
   * 只写 `revision`/`state` 两列：`20-login-roles.sql:521-523` 对 `community_reports` 的
   * UPDATE 是列级的，这里用到的两列都在授权清单里，不需要新增 GRANT。
   */
  async function commitReport(
    id: string,
    expected: ReportCommitExpectation,
    patch: ReportCommitPatch,
  ): Promise<CommitResult<ReportRecord>> {
    return withTransaction<CommitResult<ReportRecord>>(pool, async (sql) => {
      const current = (await sql.query(
        `SELECT ${REPORT_COLUMNS} FROM community_reports WHERE id = $1::uuid FOR UPDATE`,
        [id],
      )).rows[0];
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' };
      const before = reportRecordFromRow(current);
      // 判定顺序与内存实现逐条一致：先版本、再状态（版本是"重读再试"，状态是"路线分叉"）。
      if (before.revision !== expected.revision) return { ok: false, reason: 'REVISION_CHANGED' };
      if (expected.state !== undefined && before.state !== expected.state) {
        return { ok: false, reason: 'STATE_CHANGED' };
      }
      const next: ReportRecord = {
        ...before,
        revision: patch.revision ?? before.revision,
        state: patch.state ?? before.state,
      };
      await sql.query(
        `UPDATE community_reports
            SET revision = $2, state = $3::text
          WHERE id = $1::uuid`,
        [id, next.revision, next.state],
      );
      return { ok: true, record: next };
    });
  }

  return {
    persistent: true,

    async insertPost(record, moderation) {
      return withTransaction<boolean>(pool, async (sql) => {
        const linked = record.linked_knowledge_ref;
        const rows = (await sql.query(
          `INSERT INTO community_posts
             (id, author_id, revision, title, body, crop_id, region_code, media_ids, linked_knowledge_type,
              linked_knowledge_id, linked_knowledge_revision, visibility, audit_state, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::text[], $9::linked_target_type, $10, $11,
                   $12::visibility, $13::audit_state, $14::timestamptz, $15::timestamptz)
           ON CONFLICT (id) DO NOTHING
             RETURNING id`,
          [
            record.id,
            record.author_id,
            record.revision,
            record.title,
            record.body,
            record.crop_id,
            record.region_code,
            record.media_ids,
            linked === null ? null : linked.type,
            linked === null ? null : linked.id,
            linked === null ? null : linked.revision,
            record.visibility,
            record.audit_state,
            record.created_at,
            record.updated_at,
          ],
        )).rows;
        // 内容没写进去 ⇒ 结论也不写（同一次提交，与内存实现的顺序一致）。
        if (rows.length === 0) return false;
        if (moderation !== null) await writeModeration(sql, 'post', record.id, record.revision, moderation);
        return true;
      });
    },

    async getPost(id) {
      return readPost(id);
    },

    async commitPostIfCurrent(id, expected, patch, moderation) {
      return commitPost(id, expected, patch, moderation);
    },

    async listPosts(filter = { scope: 'all' }) {
      // 筛选**下推**（#444 §S5）：crop_id / region_code / author / 可见性候选集 / keyset / LIMIT
      // 全部写进 SQL。旧实现是 `SELECT … ORDER BY …` 全表读回内存再筛，数据量一上来就是
      // 全表 Seq Scan，且 `LIMIT` 落在过滤之前 ⇒ 页内缺行、游标跳行。
      const values: unknown[] = [];
      const bind = (value: unknown): string => {
        values.push(value);
        return `$${values.length}`;
      };
      const conditions: string[] = [];
      const authorId = filter.authorId ?? null;
      if (filter.scope === 'mine' && authorId === null) {
        throw new Error('listPosts: scope=mine 必须给出 authorId（存储层不接受隐式主体）');
      }
      if (filter.scope === 'public') {
        // 公开列表的**候选集**：`effectiveState()` 只有在行本身是 published 时才可能报 published，
        // 所以「非 published 一律不可能公开」是等价收窄，不是口径改动；规则版本/摘要复核仍在服务层。
        conditions.push("visibility = 'published'");
      } else if (filter.scope === 'mine') {
        conditions.push("visibility <> 'deleted'");
        conditions.push(`author_id = ${bind(authorId)}::uuid`);
      }
      const cropId = filter.cropId ?? null;
      if (cropId !== null) conditions.push(`crop_id = ${bind(cropId)}`);
      const regionCode = filter.regionCode ?? null;
      if (regionCode !== null) conditions.push(`region_code = ${bind(regionCode)}`);
      const after = filter.after ?? null;
      if (after !== null) {
        // keyset：与 `ORDER BY created_at DESC, id DESC` 同序；行比较在
        // `community_posts_feed_idx` / `community_posts_visibility_created_idx` /
        // `community_posts_author_created_idx` 的排序列上可以直接作为索引边界。
        conditions.push(`(created_at, id) < (${bind(after.createdAt)}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const limit = filter.limit ?? null;
      // 排序与内存实现的 `compareCreatedAtDescending` 同义：created_at DESC, id DESC
      // （`id` 是确定性 tie-breaker，缺了它同秒内容翻页会重复/漏行）。
      const sql = [
        `SELECT ${POST_COLUMNS} FROM community_posts`,
        conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`,
        'ORDER BY created_at DESC, id DESC',
        limit === null ? '' : `LIMIT ${bind(limit)}::int`,
      ].filter((part) => part !== '').join(' ');
      const rows = await run(sql, values);
      return rows.map(postRecordFromRow);
    },

    async insertComment(record, moderation, requireParent) {
      return withTransaction<boolean>(pool, async (sql) => {
        if (requireParent !== undefined) {
          // 父帖校验与插入同一临界区：对父帖行加 `FOR SHARE`，并发删除/改版必须排队。
          const parent = (await sql.query(
            'SELECT visibility, revision FROM community_posts WHERE id = $1::uuid FOR SHARE',
            [requireParent.id],
          )).rows[0];
          if (parent === undefined) return false;
          if (parent.visibility === 'deleted') return false;
          if (Number(parent.revision) !== requireParent.revision) return false;
        }
        const rows = (await sql.query(
          `INSERT INTO community_comments
             (id, post_id, author_id, revision, body, visibility, audit_state, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::visibility, $7::audit_state, $8::timestamptz)
           ON CONFLICT (id) DO NOTHING
             RETURNING id`,
          [
            record.id,
            record.post_id,
            record.author_id,
            record.revision,
            record.body,
            record.visibility,
            record.audit_state,
            record.created_at,
          ],
        )).rows;
        if (rows.length === 0) return false;
        if (moderation !== null) await writeModeration(sql, 'comment', record.id, record.revision, moderation);
        return true;
      });
    },

    async getComment(id) {
      return readComment(id);
    },

    async commitCommentIfCurrent(id, expected, patch, moderation) {
      return commitComment(id, expected, patch, moderation);
    },

    async listComments(postId) {
      // 排序与内存实现的 `compareCreatedAtAscending` 同义：created_at ASC, id ASC。
      const rows = await run(
        `SELECT ${COMMENT_COLUMNS} FROM community_comments
          WHERE post_id = $1::uuid
          ORDER BY created_at ASC, id ASC`,
        [postId],
      );
      return rows.map(commentRecordFromRow);
    },

    async addLike(kind, targetId, userId) {
      // 重复点赞由唯一键 `(user_id, target_type, target_id)` 裁决为 no-op；返回"是否真的新增"。
      const rows = await run(
        `INSERT INTO community_likes (target_type, target_id, user_id)
              VALUES ($1::text, $2::uuid, $3::uuid)
         ON CONFLICT (user_id, target_type, target_id) DO NOTHING
           RETURNING target_id`,
        [kind, targetId, userId],
      );
      return rows.length > 0;
    },

    async removeLike(kind, targetId, userId) {
      // 未点赞即无操作（删除 0 行），计数不会变负。
      const rows = await run(
        `DELETE FROM community_likes
          WHERE target_type = $1::text AND target_id = $2::uuid AND user_id = $3::uuid
          RETURNING target_id`,
        [kind, targetId, userId],
      );
      return rows.length > 0;
    },

    async countLikes(kind, targetId) {
      // 派生量：每次现算（没有计数器列，因此不存在计数漂移）。
      const rows = await run(
        `SELECT count(*)::int AS count FROM community_likes
          WHERE target_type = $1::text AND target_id = $2::uuid`,
        [kind, targetId],
      );
      const row = rows[0];
      return row === undefined ? 0 : Number(row.count);
    },

    async putRefusalVerdict(record) {
      // 三条判据与写入是**同一条语句**：同键已有结论 ⇒ 不覆盖；该 revision 的内容已存在 ⇒ 不补录。
      const rows = await run(
        `INSERT INTO community_moderation_decisions
           (target_type, target_id, target_revision, id, decision, reason_codes, hard_rule_passed,
            rule_version, text_digest, contract_complete, missing_contract_fields, created_at)
         SELECT $1::text, $2::uuid, $3, $4::uuid, $5::audit_state, $6::jsonb, $7, $8, $9, $10, $11::jsonb,
                $12::timestamptz
          WHERE NOT EXISTS (
                  SELECT 1 FROM community_moderation_decisions
                   WHERE target_type = $1::text AND target_id = $2::uuid AND target_revision = $3)
            AND NOT EXISTS (
                  SELECT 1 FROM community_posts
                   WHERE $1::text = 'post' AND id = $2::uuid AND revision = $3)
            AND NOT EXISTS (
                  SELECT 1 FROM community_comments
                   WHERE $1::text = 'comment' AND id = $2::uuid AND revision = $3)
         ON CONFLICT (target_type, target_id, target_revision) DO NOTHING
           RETURNING target_id`,
        [
          record.target_ref.type,
          record.target_ref.id,
          record.target_ref.revision,
          record.id,
          record.decision,
          JSON.stringify(record.reason_codes),
          record.hard_rule_passed,
          record.rule_version,
          record.text_digest,
          record.contract_complete,
          JSON.stringify(record.missing_contract_fields),
          record.created_at,
        ],
      );
      return rows.length > 0;
    },

    async getModeration(kind, id, revision) {
      const rows = await run(
        `SELECT ${MODERATION_COLUMNS} FROM community_moderation_decisions
          WHERE target_type = $1::text AND target_id = $2::uuid AND target_revision = $3`,
        [kind, id, revision],
      );
      const row = rows[0];
      return row === undefined ? null : moderationRecordFromRow(row);
    },

    async countModeration() {
      const rows = await run('SELECT count(*)::int AS count FROM community_moderation_decisions');
      const row = rows[0];
      return row === undefined ? 0 : Number(row.count);
    },

    async insertReport(record) {
      // 按 `id` 覆盖（与内存实现的 `Map.set` 同义）；重复举报的去重在服务层 Idempotency-Key。
      await run(
        `INSERT INTO community_reports
           (id, revision, reporter_id, target_type, target_id, target_revision, state, reason_code, detail,
            created_at)
         VALUES ($1::uuid, $2, $3::uuid, $4::text, $5::uuid, $6, $7::text, $8, $9, $10::timestamptz)
         ON CONFLICT (id) DO UPDATE
           SET revision = EXCLUDED.revision,
               reporter_id = EXCLUDED.reporter_id,
               target_type = EXCLUDED.target_type,
               target_id = EXCLUDED.target_id,
               target_revision = EXCLUDED.target_revision,
               state = EXCLUDED.state,
               reason_code = EXCLUDED.reason_code,
               detail = EXCLUDED.detail,
               created_at = EXCLUDED.created_at`,
        [
          record.id,
          record.revision,
          record.reporter_id,
          record.target_ref.type,
          record.target_ref.id,
          record.target_ref.revision,
          record.state,
          record.reason_code,
          record.detail,
          record.created_at,
        ],
      );
    },

    async getReport(id) {
      const rows = await run(`SELECT ${REPORT_COLUMNS} FROM community_reports WHERE id = $1::uuid`, [id]);
      const row = rows[0];
      return row === undefined ? null : reportRecordFromRow(row);
    },

    async commitReportIfCurrent(id, expected, patch) {
      return commitReport(id, expected, patch);
    },

    /**
     * 注销清理（GY-I15 · R31-S6 / **F13 保留规则**，P2 返修）。
     *
     * 口径逐条对齐 `docs/implementation-requirements.md` F13（第 279–280 行）与内存实现：
     *
     * 1. **帖子/评论保留**（⛔ 不再无条件 `visibility='deleted'`）。已审核、无个人信息的安全正文
     *    不因注销改变可见性；作者投影由 `AuthorDirectory.anonymize` 换成注销引用。
     *    **不推进 revision**：审核结论按 `(type,id,revision)` + 正文摘要绑定（`service.ts`
     *    的 `effectiveState`），为"标记"升版本会让安全正文因查不到结论而整条消失，
     *    与 F13「保留正文」相悖。
     * 2. **个人信息清除**：正文命中联系方式/精确门牌（`redactPersonalInfo`）⇒ 改写正文并
     *    `revision+1`。旧摘要不再匹配 ⇒ 读取时自动降级为"待重审"（退出公开面、行仍在库），
     *    与"先审后发"一致。**不**复制旧审核结论去放行新文本（那等于绕过重审）。
     * 3. **不能可靠脱敏的媒体 ⇒ 移除引用**（`media_ids='{}'`）。社区存储没有媒体去标识的证据面
     *    （媒体投影未接线），按 F13"不能可靠脱敏的媒体隐藏／移除"处理；正文照旧保留。
     *    仅移除媒体时**不推进 revision**（正文摘要未变 ⇒ 旧审核结论仍有效、内容继续可见）。
     * 4. **作者主动删除（`visibility='deleted'`）的行：内容与可见性原样保留**（不复活、不脱敏、
     *    不推进 revision、不改 `updated_at`），但**作者关联照样清除**——「保留作者的删除语义」
     *    与「删除账号映射」不冲突（P2 返修：监工 PR #483 指出旧实现把这类行整行跳过，
     *    导致同主体「普通行 + 已软删行」时普通行替换成功、软删行仍以原 `author_id` 关联账户，
     *    而回执已报 completed）。
     * 5. **点赞 ⇒ 物理删**（集合语义、行为痕迹）；**举报 ⇒ 只清 `detail`**（行与 state 保留，
     *    处置轨迹是审核域留痕）；**本域幂等台账**按 `scope` 前缀清空。
     * 6. **行级作者指针替换（迁移 0030）**：同一事务内把命中行的 `author_id` 置 NULL、写入随机
     *    注销引用 `anonymized_author_ref`（全行共用一串，逐主体独立）。这是 F13「内部作者换
     *    不可反查的注销引用、删除账号映射」的落地点：引用**落在行上** ⇒ 重启/多副本读同一行得
     *    同一串（不再依赖 `authors.ts` 的进程内 Map），也不再有"删账号级联删内容"的风险
     *    （`author_id = NULL` 不参与 `ON DELETE CASCADE`）。命中集 = 该主体名下**全部**行，
     *    **含** `visibility='deleted'` 行（见第 4 条）。
     * 7. **剩余读数**：写入完成后用一条只读查询**重新测量**「仍以原 `author_id` 关联本主体的
     *    行数」（帖 + 评、含软删行）⇒ `authorRefsRemaining`。端口（`purge.ts`）只认这个数判
     *    blocked：⛔ 不再以 `authorRefsReplaced > 0` 冒充"账号映射已清干净"。读数不可读时
     *    （计数行列数不对 / 值不可信）报 `AUTHOR_REFS_REMAINING_UNKNOWN`，⛔ 不得折成 0 ——
     *    端口据此 fail-closed 判 `blocked`（监工 PR #483 的残留 fail-open）。
     *
     * 计数（见 `CommunityOwnerPurgeCounts`）：`records` 是**真实改动/删除**的行数，
     * `retained`/`redacted`/`hiddenMedia` 分列保留与隐藏，`authorRefsReplaced` 单列"作者指针
     * 替换了几行"（⛔ 三者不混算，也不用一个合计数字冒充"保留也完成了"），`authorRefsRemaining`
     * 单列"还剩几行仍指向该账户"。
     */
    async purgeOwnerData(ownerId, options = {}) {
      return withTransaction<CommunityOwnerPurgeCounts>(pool, async (sql) => {
        const stamp = new Date().toISOString();
        let records = 0;
        let retained = 0;
        let redacted = 0;
        let hiddenMedia = 0;
        let authorRefsReplaced = 0;
        /**
         * 注销引用（全行共用）。三态见 `CommunityOwnerPurgeOptions`：
         *   · `undefined`（调用方没表态）⇒ 兜底生成（同一个纯函数）—— 只要要写
         *     `author_id = NULL`，就**必须**同时写入合法引用，否则撞迁移 0030 的
         *     `num_nonnulls(author_id, anonymized_author_ref) = 1`；
         *   · `null`（调用方明确说拿不到引用）⇒ **不替换**行级作者，由端口如实 blocked；
         *   · 字符串 ⇒ 必须形状合法，否则直接抛错（不静默换串：那会让引用分叉）。
         */
        const providedRef = options.anonymizedAuthorRef;
        const replaceAuthorRefs = providedRef !== null;
        if (typeof providedRef === 'string' && !ANONYMIZED_AUTHOR_REF_PATTERN.test(providedRef)) {
          throw new Error('注销引用形状不合约定（拒绝写入：迁移 0030 的 CHECK 会拒绝它）');
        }
        // 先锁住本主体的内容行再逐行判定：清除规则在 JS 里（纯函数），
        // 同一事务内完成"读 → 判 → 写"，不产生检查-写入窗口。
        // ⚠️ 命中集**不**排除 `visibility='deleted'`：软删行的内容不动，但作者关联也要清
        // （P2 返修；见方法注释第 4 条）。因此 SELECT 也把 `visibility` 读出来。
        const posts = (await sql.query(
          `SELECT id, revision, title, body, media_ids, visibility
             FROM community_posts
            WHERE author_id = $1::uuid
            FOR UPDATE`,
          [ownerId],
        )).rows;
        // 命中行 id：事务末尾**一条** UPDATE 统一换作者指针（见下方 `author_ids` 段）。
        const postIds: string[] = [];
        for (const row of posts) {
          const id = String(row.id);
          postIds.push(id);
          // 作者主动删除的行：正文/媒体/版本/updated_at 一律不动，作者指针由末尾那条统一替换。
          if (row.visibility === 'deleted') continue;
          const title = redactPersonalInfo(String(row.title));
          const body = redactPersonalInfo(String(row.body));
          const media = asTextArray(row.media_ids);
          if (title.removed + body.removed > 0) {
            await sql.query(
              `UPDATE community_posts
                  SET title = $2, body = $3, media_ids = '{}'::text[], revision = revision + 1,
                      updated_at = $4::timestamptz
                WHERE id = $1::uuid`,
              [id, title.text, body.text, stamp],
            );
            records += 1;
            redacted += 1;
            hiddenMedia += media.length;
          } else if (media.length > 0) {
            await sql.query(
              `UPDATE community_posts
                  SET media_ids = '{}'::text[], updated_at = $2::timestamptz
                WHERE id = $1::uuid`,
              [id, stamp],
            );
            records += 1;
            retained += 1;
            hiddenMedia += media.length;
          } else {
            retained += 1;
          }
        }
        const comments = (await sql.query(
          `SELECT id, revision, body, visibility
             FROM community_comments
            WHERE author_id = $1::uuid
            FOR UPDATE`,
          [ownerId],
        )).rows;
        const commentIds: string[] = [];
        for (const row of comments) {
          const id = String(row.id);
          commentIds.push(id);
          // 同帖子口径：软删评论的内容不动，作者指针由末尾那条统一替换。
          if (row.visibility === 'deleted') continue;
          const body = redactPersonalInfo(String(row.body));
          if (body.removed > 0) {
            await sql.query(
              `UPDATE community_comments
                  SET body = $2, revision = revision + 1
                WHERE id = $1::uuid`,
              [id, body.text],
            );
            records += 1;
            redacted += 1;
          } else {
            retained += 1;
          }
        }
        // ---- 行级作者指针替换（迁移 0030 / F13「内部作者换注销引用、删除账号映射」）----
        //
        // 与上面"逐行脱敏"分开成**每表一条**语句，理由（设计 §3）：
        //   · 一条 `WHERE id = ANY($1)` 就走一次索引扫描，比"每行再发一条 UPDATE"便宜；
        //   · 引用只生成一次、全行共用 ⇒ 同一主体绝不分叉成两个引用（F13「不混为一个账号」的镜像要求）；
        //   · 幂等：`WHERE author_id = <主体>` 命中 0 行 ⇒ 重放不会把新生成的引用写进去。
        // ⚠️ 不进 `records`：替换作者指针不是"改动/删除正文"，单列 `authorRefsReplaced`。
        // ⚠️ `postIds`/`commentIds` **含** `visibility='deleted'` 的行（上面两个 SELECT 不再按
        //    可见性过滤）：软删行只是**内容**不动，作者关联必须一起清 —— 否则同主体
        //    「普通行 + 已软删行」时普通行替换成功、`authorRefsReplaced > 0`，回执就误判 completed，
        //    而软删行仍以原 `author_id` 直接关联账户（监工 PR #483 [P2] 的缺陷面）。
        if (replaceAuthorRefs && (postIds.length > 0 || commentIds.length > 0)) {
          const ref = providedRef ?? createAnonymizedAuthorRef();
          if (postIds.length > 0) {
            const replacedPosts = (await sql.query(
              `UPDATE community_posts
                  SET author_id = NULL, anonymized_author_ref = $2
                WHERE id = ANY($1::uuid[])
                RETURNING id`,
              [postIds, ref],
            )).rows;
            authorRefsReplaced += replacedPosts.length;
          }
          if (commentIds.length > 0) {
            const replacedComments = (await sql.query(
              `UPDATE community_comments
                  SET author_id = NULL, anonymized_author_ref = $2
                WHERE id = ANY($1::uuid[])
                RETURNING id`,
              [commentIds, ref],
            )).rows;
            authorRefsReplaced += replacedComments.length;
          }
        }
        const reports = (await sql.query(
          `UPDATE community_reports
              SET detail = NULL, revision = revision + 1
            WHERE reporter_id = $1::uuid AND detail IS NOT NULL
            RETURNING id`,
          [ownerId],
        )).rows;
        records += reports.length;
        const likes = (await sql.query(
          `DELETE FROM community_likes WHERE user_id = $1::uuid RETURNING target_id`,
          [ownerId],
        )).rows;
        records += likes.length;
        // `scope` 形如 `<subject>\n<METHOD>\n<path>`（`auth/idempotency.ts:111-113`），
        // 主体是首段 ⇒ 前缀匹配 `ownerId + '\n'`。用 LIKE 而不是 =，因为一条请求不会有多个 scope。
        const idempotency = (await sql.query(
          `DELETE FROM community_idempotency WHERE scope LIKE $1::text RETURNING scope`,
          [`${ownerId}\n%`],
        )).rows;
        // ---- 剩余 owner 引用：写入完成后**重新测量**（P2 返修）----
        //
        // 为什么不用 `authorRefsReplaced` 倒推：那个数只说"写了几行"，说不出"还剩几行"。
        // 同主体「普通行 + 已软删行」的缺陷正是"`authorRefsReplaced > 0`"掩盖了"软删行仍指向
        // 该账户"。这里按**结果**量：两表里仍以该主体的 `author_id` 关联的行数（**含**软删行）。
        // 只读查询，且与上面的写入同一事务 ⇒ 读到的是本次清理之后的事实。
        //
        // ⚠️ 读数必须**可证明**：这条 UNION 查询恒有两个分支（帖 + 评），因此必须恰好收到 2 行、
        // 且每行都是可信的非负安全整数；少一行 / `null` / 字符串 / 负数 / 非整数 / 非有限值
        // ⇒ 报 {@link AUTHOR_REFS_REMAINING_UNKNOWN}（NaN），由端口 fail-closed 判 `blocked`。
        // ⛔ 不要写回 `Number(row.remaining ?? 0)`：那会把"没读到"折成 0，等于替存储撒谎说
        // "已清干净"（监工 PR #483 的残留 fail-open 正是从这类兜底长出来的）。
        const remainingRows = (await sql.query(
          `SELECT count(*)::int AS remaining
             FROM community_posts
            WHERE author_id = $1::uuid
           UNION ALL
           SELECT count(*)::int AS remaining
             FROM community_comments
            WHERE author_id = $1::uuid`,
          [ownerId],
        )).rows;
        const readings = remainingRows.map((row) => readAuthorRefsRemaining(row['remaining']));
        const [postRemaining, commentRemaining] = readings;
        const authorRefsRemaining = readings.length === 2
          && typeof postRemaining === 'number'
          && typeof commentRemaining === 'number'
          ? postRemaining + commentRemaining
          : AUTHOR_REFS_REMAINING_UNKNOWN;
        return {
          records,
          idempotency: idempotency.length,
          retained,
          redacted,
          hiddenMedia,
          authorRefsReplaced,
          authorRefsRemaining,
        };
      });
    },

    // ---- 幂等台账（`community_idempotency`；`scope` 已编码主体） ----

    async findIdempotency(scope, keyHash) {
      // 过期即物理清掉（与 `favorites`/`history`/`auth` 台账逐条同口径）：否则每个只被重放一次
      // 的请求都会永久留下一行过期记录，表只增不减。清理按主键三元组定位，代价是一次索引查。
      await run(
        `DELETE FROM community_idempotency
          WHERE scope = $1 AND key_hash = decode($2, 'hex') AND expires_at <= now()`,
        [scope, keyHash],
      );
      const rows = await run(
        `SELECT request_hash,
                response_status,
                outcome,
                (extract(epoch FROM expires_at) * 1000)::bigint AS expires_at_ms
           FROM community_idempotency
          WHERE scope = $1 AND key_hash = decode($2, 'hex') AND expires_at > now()`,
        [scope, keyHash],
      );
      const row = rows[0];
      // 到期即视为不存在（与内存实现的惰性淘汰同义）；未完成的占位（outcome IS NULL）也视为不存在。
      if (row === undefined) return null;
      if (row.outcome === null || row.outcome === undefined) return null;
      const record: IdempotencyRecord = {
        request_hash: String(row.request_hash).trim(),
        response_status: Number(row.response_status),
        outcome: outcomeFromRow(row.outcome),
        expires_at: Number(row.expires_at_ms),
      };
      return record;
    },

    async claimIdempotency(scope, keyHash, claim) {
      // 先清掉已到期的残留占位（与 auth 的 Postgres 台账逐条同口径），再原子占位。
      await run(
        `DELETE FROM community_idempotency
          WHERE scope = $1 AND key_hash = decode($2, 'hex') AND expires_at <= now()`,
        [scope, keyHash],
      );
      const rows = await run(
        `INSERT INTO community_idempotency (scope, key_hash, request_hash, response_status, outcome, expires_at)
              VALUES ($1, decode($2, 'hex'), $3, $4, NULL, to_timestamp($5::bigint / 1000.0))
         ON CONFLICT (scope, key_hash) DO NOTHING
           RETURNING scope`,
        [scope, keyHash, claim.request_hash, claim.response_status, claim.expires_at],
      );
      return rows.length > 0;
    },

    async completeIdempotency(scope, keyHash, done) {
      // 只允许"占位中"的行被完成：已完成的结论不因一次重试被覆盖。
      const rows = await run(
        `UPDATE community_idempotency
            SET response_status = $3, outcome = $4::jsonb
          WHERE scope = $1 AND key_hash = decode($2, 'hex') AND outcome IS NULL
          RETURNING scope`,
        [scope, keyHash, done.response_status, JSON.stringify(done.outcome)],
      );
      return rows.length > 0;
    },

    async releaseIdempotency(scope, keyHash) {
      // 只释放"占位中"的行：已完成的结果不因一次失败重试被抹掉。
      await run(
        `DELETE FROM community_idempotency
          WHERE scope = $1 AND key_hash = decode($2, 'hex') AND outcome IS NULL`,
        [scope, keyHash],
      );
    },

    async awaitIdempotencySettled(scope, keyHash, waitMs) {
      const deadline = Date.now() + Math.max(0, waitMs);
      for (;;) {
        const rows = await run(
          'SELECT outcome FROM community_idempotency WHERE scope = $1 AND key_hash = decode($2, \'hex\')',
          [scope, keyHash],
        );
        const row = rows[0];
        if (row === undefined) return 'settled';
        if (row.outcome !== null && row.outcome !== undefined) return 'settled';
        const remaining = deadline - Date.now();
        if (remaining <= 0) return 'timeout';
        await sleep(Math.min(settlePollMs, remaining));
      }
    },

    async snapshotCounts() {
      // 真读库的四表行数（与内存实现的同名助手同名同形，便于同一条断言跑两种实现）。
      const rows = await run(
        `SELECT (SELECT count(*) FROM community_posts)::int AS posts,
                (SELECT count(*) FROM community_comments)::int AS comments,
                (SELECT count(*) FROM community_reports)::int AS reports,
                (SELECT count(*) FROM community_moderation_decisions)::int AS moderation`,
      );
      const row = rows[0] ?? {};
      return {
        posts: Number(row.posts ?? 0),
        comments: Number(row.comments ?? 0),
        reports: Number(row.reports ?? 0),
        moderation: Number(row.moderation ?? 0),
      };
    },
  };
}
