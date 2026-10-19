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
import type {
  CommentCommitExpectation,
  CommentCommitPatch,
  CommentRecord,
  CommitResult,
  CommunityStore,
  IdempotencyOutcome,
  IdempotencyRecord,
  ModerationRecord,
  PostCommitExpectation,
  PostCommitPatch,
  PostRecord,
  ReportRecord,
} from './store.ts';
import type { AuditState, KnowledgeTarget, ReportTarget, Visibility } from './types.ts';

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
  throw new ApiError('PROVIDER_UNAVAILABLE', '社区数据库暂不可用', { retryable: true });
}

/** `awaitIdempotencySettled` 的轮询间隔（与内存实现的有界等待同口径：25ms、不忙等）。 */
const SETTLE_POLL_INTERVAL_MS = 25;

const POST_COLUMNS =
  'id, revision, author_id, title, body, crop_id, region_code, media_ids, linked_knowledge_type,'
  + ' linked_knowledge_id, linked_knowledge_revision, visibility, audit_state, created_at, updated_at';
const COMMENT_COLUMNS = 'id, revision, post_id, author_id, body, visibility, audit_state, created_at';
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

/** 数据库行 → 帖子记录（字段名与记录一致；未知闭集值按内部不变式违反处理）。 */
export function postRecordFromRow(row: Record<string, unknown>): PostRecord {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    author_id: String(row.author_id),
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
    author_id: String(row.author_id),
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

    async listPosts() {
      // 排序与内存实现的 `compareCreatedAtDescending` 同义：created_at DESC, id DESC。
      const rows = await run(
        `SELECT ${POST_COLUMNS} FROM community_posts ORDER BY created_at DESC, id DESC`,
      );
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
