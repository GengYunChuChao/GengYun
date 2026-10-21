/**
 * 媒体域的 **PostgreSQL 实现**（`media` / `media_derivatives` / `community_media_grants` 全在
 * `services/api/db/migrations/0001_initial_schema.sql`，幂等台账复用 0008 的
 * `public.idempotency_keys`）—— **本片不需要新迁移号**。
 *
 * ## 逐列事实（不是猜的，见 0001）
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
import type { MediaIdempotencyEntry, MediaRecord, MediaStore } from './store.ts';

/** `pg` 连接池的最小形状（与 `db/pool.ts` 的 `PgPool` 结构兼容；各域自持一份，不跨域 import）。 */
export interface MediaSqlRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PostgresMediaStoreOptions {
  pool: MediaSqlRunner;
  /** 对象引用加解密器（键来自配置 `MEDIA_OBJECT_REF_KEY`；缺键时装配层不得走到这里）。 */
  cipher: ObjectRefCipher;
}

/** 衍生物种类：`stripImageMetadata` 的产物（服务层只有一个衍生物槽位，见文件头）。 */
export const MEDIA_DERIVATIVE_KIND_METADATA_STRIPPED = 'metadata_stripped';

/** 毫秒 → `timestamptz` 参数表达式（时间口径统一在 SQL 侧换算，不序列化 JS Date）。 */
const MS_PARAM = (index: number): string => `to_timestamp($${index}::bigint / 1000.0)`;
/** `timestamptz` → 毫秒（`bigint` 回到 JS 是字符串，`asNumber` 归一）。 */
const MS_SELECT = (column: string): string =>
  `(extract(epoch FROM ${column}) * 1000)::bigint AS ${column}`;

/** 读取投影：枚举列转文本（避免驱动给出 PG 侧枚举对象），时间列转毫秒。 */
const MEDIA_PROJECTION = [
  'id',
  'owner_id',
  'purpose::text AS purpose',
  'mime',
  'bytes',
  'duration_ms',
  'sha256',
  'state::text AS state',
  'failure_code',
  'object_ref_cipher',
  'revision',
  MS_SELECT('expires_at'),
  MS_SELECT('created_at'),
  MS_SELECT('updated_at'),
].join(', ');

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
             ${MS_PARAM(12)}, ${MS_PARAM(13)}, ${MS_PARAM(14)})`,
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
        const updated = await pool.query(
          `UPDATE public.media SET
             owner_id = $2, purpose = $3::media_purpose, mime = $4, bytes = $5, duration_ms = $6,
             sha256 = $7, state = $8::media_state, failure_code = $9, object_ref_cipher = $10,
             revision = $11, expires_at = ${MS_PARAM(12)}, updated_at = ${MS_PARAM(13)}
           WHERE id = $1 RETURNING id`,
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
          ],
        );
        if (updated.rows.length === 0) {
          throw new ApiError('NOT_FOUND', `媒体登记册不存在该 id（${record.id}）`);
        }
        await writeDerivative(record);
      } catch (error) {
        return classifyMediaDatabaseError(error);
      }
    },

    async getMedia(id) {
      try {
        const result = await pool.query(
          `SELECT ${MEDIA_PROJECTION} FROM public.media WHERE id = $1`,
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

    async listMediaByState(states) {
      if (states.length === 0) return [];
      try {
        const result = await pool.query(
          `SELECT ${MEDIA_PROJECTION} FROM public.media
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
           VALUES ($1, decode($2, 'hex'), $3, $4, NULL, ${MS_PARAM(5)})
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
        const updated = await pool.query(
          `UPDATE public.idempotency_keys
              SET response_status = $3, outcome = $4::jsonb, expires_at = ${MS_PARAM(5)}
            WHERE scope = $1 AND key_hash = decode($2, 'hex') AND outcome IS NULL
          RETURNING id`,
          [scope, keyHashHex, 202, JSON.stringify({ media_id: done.mediaId }), done.expiresAt],
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
  };
}
