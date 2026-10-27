/**
 * 媒体域的 **PostgreSQL 实现**（`media` / `media_derivatives` / `community_media_grants` 全在
 * `services/api/db/migrations/0001_initial_schema.sql`，幂等台账复用 0008 的
 * `public.idempotency_keys`；**待清理对象台账**在 `0029_media_object_cleanup.sql` 的
 * `public.media_object_cleanup`）。
 *
 * ## 逐列事实（不是猜的，见 0001 与 0029）
 * - `public.media`（:171-190）：`id/owner_id/purpose/mime/bytes/duration_ms/sha256/state/failure_code/
 *   object_ref_cipher/revision/consent_epoch/expires_at/created_at/updated_at`。**没有** `metadata_removed`；
 *   **没有**幂等键列（幂等走共享台账）；`purpose`/`state` 是枚举，读取时 `::text`、写入时显式 cast。
 * - `public.media_derivatives`（:192-200）：`media_id/derivative_kind/object_ref_cipher/hash/state`，
 *   唯一索引 `(media_id, derivative_kind, hash)`。服务层只有**一个**衍生物槽位（`derivativeRef`），
 *   因此这里固定 `derivative_kind = 'metadata_stripped'`（EXIF 剥离产物，来自 `stripImageMetadata`）。
 * - `public.idempotency_keys`（0008:46-58）：`scope/key_hash bytea/request_hash/response_status/outcome
 *   jsonb/created_at/expires_at`，唯一索引 `(scope, key_hash)`；`outcome IS NULL` = 占位中。
 *   媒体域把 `{"media_id": "<uuid>"}` 存进 `outcome`；`response_status` 只是审计占位
 *   （真正的 201/202 由服务层按 outcome 回放，不从台账读状态码）。
 *
 * ## `object_ref_cipher` 是密文列
 * 对象键（桶 + 键）**不以明文入库**：`rawRef` ↔ `media.object_ref_cipher`，
 * `derivativeRef` ↔ `media_derivatives.object_ref_cipher`，由注入的 `ObjectRefCipher`
 * （AES-256-GCM，见 `./object-ref-cipher.ts`）加解密。`null`（对象已确认删除 / 尚未产生）编码为
 * **空明文的密文**（列是 `NOT NULL`），解密时空明文还原为 `null`；认证失败由 cipher 抛错，
 * 调用链据此 fail-closed，绝不退化成明文。
 *
 * ## 社区授权：本片**如实不落库**（有证据的缺口，不是偷懒）
 * `community_media_grants` 有几项服务层拿不到的事实：
 * `public_posting_epoch NOT NULL CHECK(>=1)`、`content_owner_epoch`、`author_ref REFERENCES public_authors(id)`、
 * `parent_post_id/parent_revision`。它们属于**社区域**（帖子发布 epoch、公开作者 id、父帖引用），
 * 而媒体域的内容来源端口（`./content-source.ts` 的 `PublishedContentSnapshot`）只给
 * `published/approved/authorRevision/media/avatarMedia`，**没有任何 epoch 或 `public_authors` 映射**。
 * 硬写 `public_posting_epoch = 1` 就是给安全判定喂假值（下架/审核 epoch 全部失真），故：
 *   - `createGrant` **明确拒绝**（`PROVIDER_UNAVAILABLE`，`retryable: false`），绝不伪造 epoch；
 *   - 其余授权方法按「写入路径被拒 ⇒ 行集恒为空」如实返回空/0，因此撤销与清理**不会**
 *     在 `delete`/`complete` 的失败路径上炸掉调用链。
 * 生产默认装配的公开内容来源是 `createClosedContentSource()`（社区取图一律 404），所以这条缺口
 * **不放行**任何越权读取；它只意味着「社区取图在真库模式下仍未接线」，记在报告 TODO 里。
 *
 * ## 错误折叠
 * `57014`（语句超时）/`55P03`（锁不可得）⇒ `PROVIDER_TIMEOUT`；其余 ⇒ `PROVIDER_UNAVAILABLE`
 * （`retryable` 取 `isTransientDatabaseError`）。与 `favorites/history/messages/store-pg.ts` 同口径。
 */
import { createHash } from 'node:crypto';
import { ApiError } from '../errors.ts';
import { isTransientDatabaseError } from '../db/pool.ts';
import type { ObjectRefCipher } from './object-ref-cipher.ts';
import { requirePurgeOwnerId } from './store.ts';
import type {
  MediaIdempotencyEntry,
  MediaRecord,
  MediaStore,
  MediaWritePrecondition,
  PurgeOwnedMediaResult,
} from './store.ts';

/** `pg` 连接池的最小形状（与 `db/pool.ts` 的 `PgPool` 结构兼容；各域自持一份，不跨域 import）。 */
export interface MediaSqlRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * 事务连接的最小形状（`pg.PoolClient` 的结构子集）：`purgeOwnedMedia` 要单事务，
 * 而 {@link MediaSqlRunner} 只有 `query`——在池上直接 `query` 就是每条语句各自自动提交。
 */
export interface MediaTransactionClient extends MediaSqlRunner {
  release(): void;
}

export interface PostgresMediaStoreOptions {
  pool: MediaSqlRunner;
  /** 对象引用加解密器（键来自配置 `MEDIA_OBJECT_REF_KEY`；缺键时装配层不得走到这里）。 */
  cipher: ObjectRefCipher;
  /**
   * 事务连接工厂（传 `pg.Pool` 自己的 `connect` 即可）。**只有 `purgeOwnedMedia` 用它**。
   *
   * 缺省时该原语 **fail-closed**（`PROVIDER_UNAVAILABLE`、`retryable: false`）：把「软隐藏 + 登记
   * 清理意图 + 清引用」拆成几条各自自动提交的语句，中途失败会留下「图已隐藏、台账没写、对象没人删」
   * 的半清，且没有任何凭据能重放。宁可在注销回执里如实 `blocked`，也不做伪事务。
   */
  connect?: () => Promise<MediaTransactionClient>;
}

/** 衍生物种类：`stripImageMetadata` 的产物（服务层只有一个衍生物槽位，见文件头）。 */
export const MEDIA_DERIVATIVE_KIND_METADATA_STRIPPED = 'metadata_stripped';

/**
 * 时间口径统一在 SQL 侧换算（不序列化 JS Date）：写用 `to_timestamp($n::bigint / 1000.0)`，
 * 读用 `(extract(epoch FROM col) * 1000)::bigint`。
 *
 * 为什么这些表达式**逐条写全**、不做成 `MS_PARAM(i)` / 投影数组之类的拼接：
 * `tests/unit/sql-column-coverage.test.mjs` 的列权限审计只看 SQL 字面量里的列名，
 * 拼接出来的投影会让 `media` 那 14 列脱离逐列判定（审计里会退化成「不可判插值」）。
 * 本文件因此刻意重复两份 14 列投影：多几行，但每一列都被静态审计看见。
 */

/** 数据库异常的契约化折叠（与 `messages/store-pg.ts:80-91` 逐条同口径）。 */
export function classifyMediaDatabaseError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ['57014', '55P03'].includes(code)) {
    throw new ApiError('PROVIDER_TIMEOUT', '媒体数据库响应超时', { retryable: true });
  }
  if (error instanceof ApiError) throw error;
  throw new ApiError('PROVIDER_UNAVAILABLE', '媒体数据库暂不可用', { retryable: isTransientDatabaseError(error) });
}

function shapeError(): never {
  throw new ApiError('PROVIDER_UNAVAILABLE', '媒体数据库返回了非预期的字段形状', { retryable: false });
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  return shapeError();
}

function asOptionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : asText(value);
}

function asNumber(value: unknown): number {
  if (value === null || value === undefined) shapeError();
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) shapeError();
  return parsed;
}

function asOptionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function derivativeHash(objectRef: string): string {
  return createHash('sha256').update(objectRef, 'utf8').digest('hex');
}

/**
 * 对象键摘要（明文键的 sha256，hex）。
 *
 * 为什么清理台账除了密文列还要这一列：`object_ref_cipher` 是 AES-256-GCM（每次加密都换 nonce），
 * 同一个明文键两次加密得到**不同**密文 ⇒ 靠密文去重/按对象删行是不可能的。摘要列承担两件事：
 * ① 唯一索引 `(object_ref_digest)` 让「同一对象重复登记」收敛成一行；
 * ② `deleteObjectCleanup` 按摘要定位要删的那一行。摘要不可逆，不泄露对象键。
 */
function objectRefDigest(objectRef: string): string {
  return createHash('sha256').update(objectRef, 'utf8').digest('hex');
}

function rowToRecord(row: Record<string, unknown>, cipher: ObjectRefCipher): Omit<MediaRecord, 'derivativeRef'> {
  return {
    id: asText(row.id),
    ownerId: asText(row.owner_id),
    revision: asNumber(row.revision),
    purpose: asText(row.purpose),
    mime: asText(row.mime),
    bytes: asNumber(row.bytes),
    duration_ms: asOptionalNumber(row.duration_ms),
    sha256: asText(row.sha256).trim(),
    state: asText(row.state),
    failure_code: asOptionalText(row.failure_code),
    rawRef: cipher.decryptObjectRef(asText(row.object_ref_cipher)),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
    expiresAt: asNumber(row.expires_at),
  };
}

/**
 * 建立 Postgres 版媒体仓储。
 *
 * 入参只有 `pool` 与 `cipher`：**不读 ambient env**（媒体链路审计禁止 `process.env`），
 * 连接与键都由装配层注入。
 */
export function createPostgresMediaStore(options: PostgresMediaStoreOptions): MediaStore {
  const { pool, cipher } = options;

  const loadDerivativeRef = async (mediaId: string): Promise<string | null> => {
    const result = await pool.query(
      `SELECT object_ref_cipher FROM public.media_derivatives
        WHERE media_id = $1 AND derivative_kind = $2
        ORDER BY id LIMIT 1`,
      [mediaId, MEDIA_DERIVATIVE_KIND_METADATA_STRIPPED],
    );
    if (result.rows.length === 0) return null;
    return cipher.decryptObjectRef(asText(result.rows[0]?.object_ref_cipher));
  };

  const hydrate = async (row: Record<string, unknown>): Promise<MediaRecord> => {
    const base = rowToRecord(row, cipher);
    return { ...base, derivativeRef: await loadDerivativeRef(base.id) };
  };

  /** 衍生物跟随父行状态；无衍生物就删掉旧行（引用被清空 ⇒ 旧密文不得留下）。 */
  const writeDerivative = async (record: MediaRecord): Promise<void> => {
    if (record.derivativeRef === null) {
      await pool.query('DELETE FROM public.media_derivatives WHERE media_id = $1', [record.id]);
      return;
    }
    await pool.query(
      `INSERT INTO public.media_derivatives (media_id, derivative_kind, object_ref_cipher, hash, state)
       VALUES ($1, $2, $3, $4, $5::media_state)
       ON CONFLICT (media_id, derivative_kind, hash)
       DO UPDATE SET object_ref_cipher = EXCLUDED.object_ref_cipher, state = EXCLUDED.state`,
      [
        record.id,
        MEDIA_DERIVATIVE_KIND_METADATA_STRIPPED,
        cipher.encryptObjectRef(record.derivativeRef),
        derivativeHash(record.derivativeRef),
        record.state,
      ],
    );
  };

  /**
   * 媒体行写入：`saveMedia`（无条件）与 `saveMediaIfCurrent`（条件）共用同一条 SET 列表，
   * 差别只在 `WHERE`。返回 `UPDATE … RETURNING id` 的行数。
   *
   * `expected` 给定时把 `revision` 与 `state` 一起放进 `WHERE` —— 这是「快照过期」的判据：
   * 0 行 ⇒ 这一行在我们读快照之后被推进过（`delete`/`expire`/另一个 `complete`），
   * 本次写入**没有落库**，调用方据此给出可判定的失败，绝不整行覆写回去。
   */
  const writeMediaRow = async (
    record: MediaRecord,
    expected?: MediaWritePrecondition,
  ): Promise<number> => {
    const updated = await pool.query(
      expected === undefined
        ? `UPDATE public.media SET
             owner_id = $2, purpose = $3::media_purpose, mime = $4, bytes = $5, duration_ms = $6,
             sha256 = $7, state = $8::media_state, failure_code = $9, object_ref_cipher = $10,
             revision = $11, expires_at = to_timestamp($12::bigint / 1000.0),
             updated_at = to_timestamp($13::bigint / 1000.0)
           WHERE id = $1 RETURNING id`
        : `UPDATE public.media SET
             owner_id = $2, purpose = $3::media_purpose, mime = $4, bytes = $5, duration_ms = $6,
             sha256 = $7, state = $8::media_state, failure_code = $9, object_ref_cipher = $10,
             revision = $11, expires_at = to_timestamp($12::bigint / 1000.0),
             updated_at = to_timestamp($13::bigint / 1000.0)
           WHERE id = $1 AND revision = $14 AND state = $15::media_state RETURNING id`,
      [
        record.id,
        record.ownerId,
        record.purpose,
        record.mime,
        record.bytes,
        record.duration_ms,
        record.sha256,
        record.state,
        record.failure_code,
        cipher.encryptObjectRef(record.rawRef ?? ''),
        record.revision,
        record.expiresAt,
        record.updatedAt,
        ...(expected === undefined ? [] : [expected.revision, expected.state]),
      ],
    );
    return updated.rows.length;
  };

  return {
    persistent: true,
    kind: 'postgres',

    async createMedia(record) {
      try {
        await pool.query(
          `INSERT INTO public.media (
             id, owner_id, purpose, mime, bytes, duration_ms, sha256, state, failure_code,
             object_ref_cipher, revision, expires_at, created_at, updated_at)
           VALUES ($1, $2, $3::media_purpose, $4, $5, $6, $7, $8::media_state, $9, $10, $11,
             to_timestamp($12::bigint / 1000.0), to_timestamp($13::bigint / 1000.0),
             to_timestamp($14::bigint / 1000.0))`,
          [
            record.id,
            record.ownerId,
            record.purpose,
            record.mime,
            record.bytes,
            record.duration_ms,
            record.sha256,
            record.state,
            record.failure_code,
            // 列是 NOT NULL：无对象键时写「空明文的密文」，解密时空明文还原为 null。
            cipher.encryptObjectRef(record.rawRef ?? ''),
            record.revision,
            record.expiresAt,
            record.createdAt,
            record.updatedAt,
          ],
        );
        await writeDerivative(record);
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },

    async saveMedia(record) {
      try {
        if ((await writeMediaRow(record)) === 0) {
          throw new ApiError('NOT_FOUND', `媒体登记册不存在该 id（${record.id}）`);
        }
        await writeDerivative(record);
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },

    /**
     * 条件写（监工 1927 轮 P1）：`WHERE id = $1 AND revision = $14 AND state = $15`。
     *
     * 之前只有 `WHERE id = $1`，于是「读快照 → 生成衍生件（await）→ 整行写回」这段窗口里
     * 落地的 `delete` 会被这条 UPDATE 整行盖回 `ready`，已删除的媒体就此复活。
     * 现在 0 行既不写父行也不写衍生件，把竞态收敛成一次**可判定**的失败。
     */
    async saveMediaIfCurrent(record, expected) {
      try {
        if ((await writeMediaRow(record, expected)) === 0) return 0;
        await writeDerivative(record);
        return 1;
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },

    async getMedia(id) {
      try {
        const result = await pool.query(
          `SELECT id, owner_id, purpose::text AS purpose, mime, bytes, duration_ms, sha256,
                  state::text AS state, failure_code, object_ref_cipher, revision,
                  (extract(epoch FROM expires_at) * 1000)::bigint AS expires_at,
                  (extract(epoch FROM created_at) * 1000)::bigint AS created_at,
                  (extract(epoch FROM updated_at) * 1000)::bigint AS updated_at
             FROM public.media WHERE id = $1`,
          [id],
        );
        if (result.rows.length === 0) return null;
        return await hydrate(result.rows[0] as Record<string, unknown>);
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },

    async liveCommunityImageCount(ownerId) {
      try {
        const result = await pool.query(
          `SELECT count(*) AS count FROM public.media
            WHERE owner_id = $1 AND purpose = 'community_image'
              AND state NOT IN ('deleted', 'rejected')`,
          [ownerId],
        );
        return asNumber(result.rows[0]?.count);
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },

    /**
     * 按主体清理媒体（注销闭集用）——**单事务**，顺序：软隐藏 ⇒ 登记清理意图 ⇒ 清引用 ⇒ 删衍生物。
     *
     * ## 为什么不用 0035 那个按主体删媒体行的窄函数
     * 它只删 `rejected`/`deleted` 两种状态的 `media` 行，**且要求台账意图先存在**
     * （否则 `G0007` 整批中止），与本原语「先软隐藏、再动对象」的顺序相反；它也不软隐藏
     * `ready` 状态的社区图片（那正是要挡在公开面之前的那一类）。因此这里走本域自己的语句。
     *
     * ## 授权面
     * 只用 `deploy/postgres-cvm/sql/20-login-roles.sql` 段 M 已授权的列（`media` 的列级
     * SELECT/UPDATE、`media_derivatives` 与 `media_object_cleanup` 的整表授权）⇒ **不需要新迁移**。
     * 每条语句都按 `owner_id`（关联表按该 owner 的媒体 id）收窄，不删别人的数据。
     */
    async purgeOwnedMedia(ownerId) {
      const owner = requirePurgeOwnerId(ownerId);
      const connect = options.connect;
      if (typeof connect !== 'function') {
        throw new ApiError('PROVIDER_UNAVAILABLE', '媒体清理需要事务连接（装配层未注入 connect）', {
          retryable: false,
        });
      }
      let client: MediaTransactionClient | null = null;
      try {
        client = await connect();
        await client.query('BEGIN');
        const readMedia = await client.query(
          `SELECT id, purpose::text AS purpose, state::text AS state, object_ref_cipher
             FROM public.media WHERE owner_id = $1 ORDER BY id`,
          [owner],
        );
        const rows = readMedia.rows.map((row) => ({
          id: asText(row.id),
          purpose: asText(row.purpose),
          state: asText(row.state),
          rawRef: cipher.decryptObjectRef(asText(row.object_ref_cipher)),
        }));
        const mediaIds = rows.map((row) => row.id);
        const derivativeRefs = new Map<string, string[]>();
        if (mediaIds.length > 0) {
          const readDerivatives = await client.query(
            `SELECT media_id, object_ref_cipher FROM public.media_derivatives
              WHERE media_id = ANY($1::uuid[]) ORDER BY media_id, object_ref_cipher`,
            [mediaIds],
          );
          for (const row of readDerivatives.rows) {
            const objectRef = cipher.decryptObjectRef(asText(row.object_ref_cipher));
            if (objectRef === null || objectRef === '') continue;
            const mediaId = asText(row.media_id);
            const refs = derivativeRefs.get(mediaId) ?? [];
            refs.push(objectRef);
            derivativeRefs.set(mediaId, refs);
          }
        }
        /** 空明文的密文：列是 `NOT NULL`，清引用写它，解密时还原为 `null`（与 `store.ts` 文件头同口径）。 */
        const emptyRef = cipher.encryptObjectRef('');
        // ① **先软隐藏**（判据与 `liveCommunityImageCount` 一致）：社区图片先离开公开面，
        //    同一语句清掉对象引用——仍在同一事务内，下面立刻登记台账，没有「键已丢、意图没写」的窗口。
        const liveCommunityImageIds = rows
          .filter((row) => row.purpose === 'community_image'
            && row.state !== 'deleted'
            && row.state !== 'rejected')
          .map((row) => row.id);
        let softHidden = 0;
        if (liveCommunityImageIds.length > 0) {
          const hidden = await client.query(
            `UPDATE public.media SET
               state = 'deleted'::media_state, object_ref_cipher = $3,
               revision = revision + 1, updated_at = now()
             WHERE owner_id = $1 AND id = ANY($2::uuid[]) RETURNING id`,
            [owner, liveCommunityImageIds, emptyRef],
          );
          softHidden = hidden.rows.length;
        }
        // ② **再动对象**：先把每个对象键登记进清理台账（真桶删除由台账重试器按行做，
        //    本原语不直接打桶——否则「登记」与「删除」之间没有可重放的凭据）。
        const registered = new Set<string>();
        const pending: Array<{ mediaId: string; objectRef: string }> = [];
        for (const row of rows) {
          const candidates = [row.rawRef ?? '', ...(derivativeRefs.get(row.id) ?? [])];
          for (const objectRef of candidates) {
            if (objectRef === '' || registered.has(objectRef)) continue;
            registered.add(objectRef);
            pending.push({ mediaId: row.id, objectRef });
          }
        }
        for (const intent of pending) {
          await client.query(
            `INSERT INTO public.media_object_cleanup
               (media_id, object_ref_cipher, object_ref_digest, reason, attempts, created_at, updated_at)
             VALUES ($1, $2, $3, 'owner_delete', 1, now(), now())
             ON CONFLICT (object_ref_digest) DO UPDATE SET
               media_id = EXCLUDED.media_id,
               reason = EXCLUDED.reason,
               attempts = public.media_object_cleanup.attempts + 1,
               updated_at = EXCLUDED.updated_at`,
            [intent.mediaId, cipher.encryptObjectRef(intent.objectRef), objectRefDigest(intent.objectRef)],
          );
        }
        // ③ 非社区图片行的引用在这里清（社区图片已在 ① 里清过，不重复推进 `revision`）。
        const clearOtherIds = rows
          .filter((row) => row.rawRef !== null && row.rawRef !== '' && !liveCommunityImageIds.includes(row.id))
          .map((row) => row.id);
        if (clearOtherIds.length > 0) {
          await client.query(
            `UPDATE public.media SET object_ref_cipher = $3, revision = revision + 1, updated_at = now()
              WHERE owner_id = $1 AND id = ANY($2::uuid[])`,
            [owner, clearOtherIds, emptyRef],
          );
        }
        // ④ 衍生物行随引用一起删（对象键已在 ② 登记，删行不会丢线索）。
        if (mediaIds.length > 0) {
          await client.query(
            `DELETE FROM public.media_derivatives WHERE media_id = ANY($1::uuid[])`,
            [mediaIds],
          );
        }
        await client.query('COMMIT');
        // 读数只说「已登记待删」：本原语不持有对象存储客户端、`deleteObject` 一次都没调，
        // 真删在 `media/service.ts` 的 `cleanupOrphans` 第二循环（该清理器今天无生产调用者）。
        const purged: PurgeOwnedMediaResult = {
          softHidden,
          objectsRegistered: registered.size,
        };
        return purged;
      } catch (error) {
        if (client !== null) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // 回滚本身失败不覆盖原始错误：原始错误才是注销回执要报的那一个。
          }
        }
        return classifyMediaDatabaseError(error);
      } finally {
        client?.release();
      }
    },

    async listMediaByState(states) {
      if (states.length === 0) return [];
      try {
        const result = await pool.query(
          `SELECT id, owner_id, purpose::text AS purpose, mime, bytes, duration_ms, sha256,
                  state::text AS state, failure_code, object_ref_cipher, revision,
                  (extract(epoch FROM expires_at) * 1000)::bigint AS expires_at,
                  (extract(epoch FROM created_at) * 1000)::bigint AS created_at,
                  (extract(epoch FROM updated_at) * 1000)::bigint AS updated_at
             FROM public.media
            WHERE state = ANY($1::media_state[]) ORDER BY created_at, id`,
          [states],
        );
        const records: MediaRecord[] = [];
        for (const row of result.rows) records.push(await hydrate(row));
        return records;
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },

    async countMedia() {
      try {
        const result = await pool.query('SELECT count(*) AS count FROM public.media');
        return asNumber(result.rows[0]?.count);
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },

    async createGrant() {
      // 见文件头「社区授权：本片如实不落库」：缺 public_posting_epoch / author_ref 等社区域事实，
      // 伪造 epoch 会让下架/审核判定失真，因此显式拒绝而不是写半真行。
      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        '社区媒体取图授权需要社区域的 publish/author epoch（community_media_grants.public_posting_epoch / author_ref），本片未接线',
        { retryable: false },
      );
    },
    async getGrant() {
      return null;
    },
    async revokeGrantsForMedia() {
      // 写入路径被拒 ⇒ 行集恒为空（见 createGrant），撤销如实返回 0，不打断 delete/complete 失败路径。
      return 0;
    },
    async listStaleGrants() {
      return [];
    },
    async deleteGrant() {
      // 同上：没有本域写入的授权行可删。
    },
    async countGrants() {
      return 0;
    },

    async findIdempotency(scope, keyHashHex) {
      try {
        const result = await pool.query(
          `SELECT request_hash, outcome FROM public.idempotency_keys
            WHERE scope = $1 AND key_hash = decode($2, 'hex') AND expires_at > now()`,
          [scope, keyHashHex],
        );
        if (result.rows.length === 0) return null;
        const row = result.rows[0] as Record<string, unknown>;
        const outcome = row.outcome as { media_id?: unknown } | null;
        const mediaId = outcome !== null && typeof outcome === 'object' && typeof outcome.media_id === 'string'
          ? outcome.media_id
          : null;
        const entry: MediaIdempotencyEntry = { requestHash: asText(row.request_hash), mediaId };
        return entry;
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },

    async claimIdempotency(scope, keyHashHex, claim) {
      try {
        // 先删过期行：否则过期占位会被唯一索引挡住（与 messages/store-pg.ts:374-389 同口径）。
        await pool.query(
          `DELETE FROM public.idempotency_keys
            WHERE scope = $1 AND key_hash = decode($2, 'hex') AND expires_at <= now()`,
          [scope, keyHashHex],
        );
        const inserted = await pool.query(
          `INSERT INTO public.idempotency_keys (scope, key_hash, request_hash, response_status, outcome, expires_at)
           VALUES ($1, decode($2, 'hex'), $3, $4, NULL, to_timestamp($5::bigint / 1000.0))
           ON CONFLICT (scope, key_hash) DO NOTHING
           RETURNING id`,
          [scope, keyHashHex, claim.requestHash, 503, claim.expiresAt],
        );
        return inserted.rows.length > 0;
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },

    async settleIdempotency(scope, keyHashHex, done) {
      try {
        // 为什么不是 `UPDATE … SET response_status, outcome, expires_at`：
        // 0008 台账对运行时的授权来自 auth_privacy 组（services/api/db/roles/auth_privacy.sql），
        // 列级/表级面里**没有** `expires_at` 的 UPDATE（见 deploy/postgres-cvm/sql/90-assert-least-privilege.sql
        // 的 idempotency_keys 行：upd = response_status, outcome）。又因为认领期必须短（崩溃可回收）、
        // 结果期必须长（同一幂等键 24h 内重试要能回放），所以这里用一条语句「删掉占位行 + 插入结果行」：
        // 只用已授权的表级 INSERT/DELETE，不新增任何列权限，且在单语句内原子完成。
        const updated = await pool.query(
          `WITH claimed AS (
             DELETE FROM public.idempotency_keys
              WHERE scope = $1 AND key_hash = decode($2, 'hex') AND outcome IS NULL
            RETURNING scope, key_hash)
           INSERT INTO public.idempotency_keys
             (scope, key_hash, request_hash, response_status, outcome, expires_at)
           SELECT claimed.scope, claimed.key_hash, $3, $4, $5::jsonb, to_timestamp($6::bigint / 1000.0)
             FROM claimed
           RETURNING id`,
          [scope, keyHashHex, done.requestHash, 202, JSON.stringify({ media_id: done.mediaId }), done.expiresAt],
        );
        return updated.rows.length > 0;
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },

    async releaseIdempotency(scope, keyHashHex) {
      try {
        await pool.query(
          `DELETE FROM public.idempotency_keys
            WHERE scope = $1 AND key_hash = decode($2, 'hex') AND outcome IS NULL`,
          [scope, keyHashHex],
        );
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },

    /**
     * 待清理意图的落库（迁移 0029 的 `public.media_object_cleanup`）。
     *
     * `ON CONFLICT (object_ref_digest) DO UPDATE` 而不是 `DO NOTHING`：重试器要能从 `attempts`
     * 看出「这个对象已经试过几轮还清不掉」。注意 PostgreSQL 对 `ON CONFLICT DO UPDATE`
     * 要求被读到的列（arbiter 列与 SET 右侧的旧值）也有 SELECT 权 —— 授权面因此在
     * `deploy/postgres-cvm/sql/20-login-roles.sql` 段 M 里是整表列级 SELECT。
     */
    async saveObjectCleanup(intent, atMs) {
      try {
        await pool.query(
          `INSERT INTO public.media_object_cleanup
             (media_id, object_ref_cipher, object_ref_digest, reason, attempts, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 1, to_timestamp($5::bigint / 1000.0), to_timestamp($5::bigint / 1000.0))
           ON CONFLICT (object_ref_digest) DO UPDATE SET
             media_id = EXCLUDED.media_id,
             reason = EXCLUDED.reason,
             attempts = public.media_object_cleanup.attempts + 1,
             updated_at = EXCLUDED.updated_at`,
          [
            intent.mediaId,
            cipher.encryptObjectRef(intent.objectRef),
            objectRefDigest(intent.objectRef),
            intent.reason,
            atMs,
          ],
        );
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },

    async listObjectCleanup() {
      try {
        const result = await pool.query(
          `SELECT media_id, object_ref_cipher, reason, attempts
             FROM public.media_object_cleanup ORDER BY created_at, object_ref_digest`,
        );
        return result.rows.map((row) => {
          const objectRef = cipher.decryptObjectRef(asText(row.object_ref_cipher));
          // 空明文只可能来自「写了一条没有键的行」——那是数据损坏，不能静默跳过（跳过等于丢线索）。
          if (objectRef === null || objectRef === '') shapeError();
          return {
            mediaId: asText(row.media_id),
            objectRef,
            reason: asText(row.reason),
            attempts: asNumber(row.attempts),
          };
        });
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },

    async deleteObjectCleanup(objectRef) {
      try {
        const deleted = await pool.query(
          `DELETE FROM public.media_object_cleanup
            WHERE object_ref_digest = $1 RETURNING object_ref_digest`,
          [objectRefDigest(objectRef)],
        );
        return deleted.rows.length;
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },
  };
}
