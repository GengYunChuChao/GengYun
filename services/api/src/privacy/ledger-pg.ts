/**
 * GY-I27（#29）· **持久**外发账本（PostgreSQL）与提交边界。
 *
 * ## 为什么不能复用内存账本的 commitGate
 * `packages/privacy/commit-gate.mjs` 的内存参考实现要求**同步**一致快照（`commit` 体内无 await），
 * 因为它的安全性来自"单线程同一 tick 内的不可分割临界区"。PostgreSQL 上不存在同步读取，
 * 因此部署义务是：**在同一事务内完成校验读取与实际写入**（见 `packages/privacy/README.md`
 * 「提交一致性契约」）。本文件就是该义务的实现：
 *
 *   BEGIN
 *     ... SELECT ... FOR SHARE   -- 账号身份(state, auth_epoch) + 全部必需用途(epoch, granted) + 接收方(版本/条款)
 *     （逐项与预留时冻结的快照比对；任一不符 ⇒ 抛契约错误、**不执行任何写入**）
 *     ... INSERT/UPDATE          -- 实际写入（状态迁移 / 结果回写），与校验**同事务**
 *   COMMIT
 *
 * 于是 `markSent`（派发）与 `guardWriteback`（结果回写）的**校验与写入不可分离**：
 * 撤回/注销/接收方变更只要与提交并发，就会被行锁串行化到校验之前或之后，不存在中间窗口。
 *
 * ## 与内存账本的语义一致性
 * 公开方法名、错误码、冻结快照维度、终态不可复活、取消墓碑只增不减，都与
 * `packages/privacy/ledger.mjs` / `in-flight.mjs` 同口径；差异只有一处**如实说明**：
 * 结果回写（`export_writebacks.result`）只落**结构分类**（`kind`/`code` 等短 token），
 * **不落私有正文/媒体/坐标/凭据** —— 结果本体仍在各业务域 store，账本不制造第二份私有数据副本。
 *
 * ## 依赖的库对象
 * 迁移 `0011_export_ledger.sql`（`exports` 增列 + `export_writebacks` 表）与最小权限组
 * `services/api/db/roles/egress_ledger.sql`。DDL 与角色由运维执行，运行时不建表、不改权限。
 */
import type { PoolClient } from 'pg';
import { PrivacyError } from '../../../../packages/privacy/errors.mjs';
import {
  EXPORT_OBJECT_TYPES,
  EXPORT_STATES,
  MEDIA_PURPOSES,
  requiredConsentsForDataType,
} from '../../../../packages/privacy/constants.mjs';
import { redactForLog } from '../../../../packages/privacy/redact.mjs';
import type { PgPool } from '../db/pool.ts';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_TOKEN = /^[a-z0-9_:-]{1,40}$/;
/**
 * 非媒体资料的对象键形状（0014 的 `exports.object_key`，1..80 字符）：
 * 首尾为小写字母或数字，中间允许小写字母/数字/`_`/`-`/`.`/`:`。
 * 长度上限 80 = 契约 `TargetRef.id` 的 `maxLength: 80`（`packages/contracts/openapi.json:11575`）：账本的 `object_key`
 * 会被 `/me/exports` 原样投影成 `object_ref.id`（本文件 `toRecord`）⇒ 写入侧与契约必须同一个上限，否则读面必 503。
 * 前 78 = 80 − 首尾各 1 个锚字符。原 128（「类型 ≤ 40 ＋ `:` ＋ 标识 ≤ 80」）随写入侧改写作废：类型不再编进键。
 * **不做截断**，超长一律拒绝（`INVALID_REQUEST`），避免静默改标识；DB 侧同口径 CHECK `{1,80}` 由迁移 0040 收紧。
 */
const OBJECT_KEY = /^[a-z0-9](?:[a-z0-9_.:-]{0,78}[a-z0-9])?$/;
const OBJECT_KEY_MAX = 80;
/**
 * 非媒体（文本键）行的 `object_id` 占位值（**全零 uuid 哨兵**）。
 *
 * `exports.object_id` 是 0003 就有的 `uuid NOT NULL` 列，本片**不放宽既有列**（不改类型、不去 NOT NULL）。
 * 因此文本键行必须在 `object_id` 里写这个哨兵，同时把真实标识写进 `object_key`；
 * 数据库侧 `exports_object_ident_xor` 约束只允许「object_key 为 NULL」或「object_id = 本哨兵」两种形态，
 * 从而在**库层**钉住「要么 uuid 标识、要么文本标识」，并保证既有（uuid）行逐字不变。
 * 该哨兵**不是**任何真实对象 id，读取侧一律以 `object_key` 为准（见 `toRecord`）。
 */
const OBJECT_KEY_SENTINEL_UUID = '00000000-0000-0000-0000-000000000000';

function int(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : -1;
}
function iso(value: unknown): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}
function safeReason(value: unknown): string {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : 'cancelled';
}

/**
 * PostgreSQL 错误 → 契约错误（不透出驱动原文）。按裁定逐类分档：
 * - 超时（57014 语句取消 / 55P03 拿不到锁）⇒ `PROVIDER_TIMEOUT`(retryable:true)；
 * - 连接层故障（08xxx）、管理员干预（53xxx / 57P0x）、串行化冲突与死锁（40001 / 40P01）
 *   ⇒ 瞬时故障，`PROVIDER_UNAVAILABLE`(retryable:true)：同一请求稍后重试**确实**可能成功；
 * - 配置/接线类（3D000 库不存在 / 28P01 凭据不匹配 / 42P01 表缺失 / 42501 权限不足）
 *   与无法归类的其余驱动错误 ⇒ 需运维改配置或修缺陷，**不是时间能解决的** ⇒ retryable:false
 *   （口径原文见 `services/api/src/errors.ts` 的 `ApiError` 注释）。
 */
function mapPgError(error: unknown): never {
  if (error instanceof PrivacyError) throw error;
  const code = (error as { code?: unknown })?.code;
  if (code === '57014' || code === '55P03') {
    throw new PrivacyError('PROVIDER_TIMEOUT', '外发账本事务超时', { retryable: true });
  }
  if (typeof code === 'string' && /^(08|53|57P0|40001|40P01)/.test(code)) {
    // 瞬时：连接层故障 / 管理员干预 / 串行化冲突、死锁 ⇒ 同一请求稍后重试可能成功。
    throw new PrivacyError('PROVIDER_UNAVAILABLE', '外发账本暂不可用', { retryable: true });
  }
  if (typeof code === 'string' && /^(3D000|28P01|42P01|42501)/.test(code)) {
    // 未配置/未接线（库不存在、凭据不匹配、表缺失、权限不足）⇒ 需运维改配置 ⇒ 不可重试。
    throw new PrivacyError('PROVIDER_UNAVAILABLE', '外发账本暂不可用（数据库配置/权限不满足）', { retryable: false });
  }
  // 无法归类的数据库错误 ⇒ 确定性缺陷，重试不会改善。
  throw new PrivacyError('PROVIDER_UNAVAILABLE', '外发账本暂不可用', { retryable: false });
}

/** 账本行 → 账本记录（与 `packages/privacy/ledger.mjs` 的内部记录同形，供 egress.mjs 投影）。 */
function toRecord(row: Row) {
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    objectType: String(row['object_type']),
    // 对象标识：**媒体维走 `object_id`(uuid)**；**非媒体维走 `object_key`(text)**，并在 `object_id`
    // 写全零哨兵（`object_id` 仍是 0003 的 `uuid NOT NULL`，本片不放宽既有列）。两者恰好给一个：
    // 不得都缺、不得都给（数据库侧 `exports_object_ident_xor` 同口径兜底）。
    // 读取侧以 `object_key` 优先（见 `toRecord`），因此哨兵不会被误当成真实对象 id。
    objectId: row['object_key'] === null || row['object_key'] === undefined
      ? String(row['object_id'])
      : String(row['object_key']),
    objectRevision: int(row['object_revision']),
    purpose: String(row['purpose']),
    consentEpoch: int(row['consent_epoch']),
    requiredConsents: (row['required_consents'] ?? {}) as Record<string, number>,
    recipientId: String(row['recipient_id']),
    recipientConfigVersion: String(row['recipient_config_version']),
    sourceVersion: row['source_version'] === null || row['source_version'] === undefined ? null : String(row['source_version']),
    state: String(row['state']),
    revision: int(row['revision']),
    errorCode: row['error_code'] === null || row['error_code'] === undefined ? null : String(row['error_code']),
    jobId: row['job_id'] === null || row['job_id'] === undefined ? null : String(row['job_id']),
    cancelledAt: iso(row['cancelled_at']),
    cancellationReason: row['cancellation_reason'] === null || row['cancellation_reason'] === undefined
      ? null
      : String(row['cancellation_reason']),
    deletionState: String(row['deletion_state']),
    authEpoch: int(row['auth_epoch']),
    requestedAt: iso(row['requested_at']),
    sentAt: iso(row['sent_at']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  };
}

export type ExportRecord = ReturnType<typeof toRecord>;

export interface PostgresExportLedger {
  reserve(input: {
    userId: string;
    authEpoch: number;
    objectType: string;
    /** 媒体资料（`MEDIA_PURPOSES`）的对象标识，必须是 uuid；非媒体资料必须**不传**。 */
    objectId?: string;
    /** 非媒体资料的对象标识（0014 的 `object_key`，文本型 1..128）；媒体资料必须**不传**。 */
    objectKey?: string;
    objectRevision: number;
    dataType: string;
    purpose: string;
    recipientId: string;
    sourceVersion?: string | null;
  }): Promise<ExportRecord>;
  get(id: string): Promise<ExportRecord | null>;
  list(input: { userId: string; limit?: number; cursor?: string | null }): Promise<{ items: ExportRecord[]; nextCursor: string | null }>;
  resolveRecipient(input: { userId: string; purpose: string; capability: string }): Promise<string>;
  findReservedByObject(input: {
    objectType: string;
    /** 媒体维：uuid 标识（与 `objectKey` 恰好给一个）。 */
    objectId?: string;
    /** 非媒体维：文本型标识（与 `objectId` 恰好给一个）。 */
    objectKey?: string;
    objectRevision: number;
    /**
     * 传入时按属主过滤（防止跨用户命中他人的预留行）；不传保持既有「不按用户过滤」口径。
     * **传了就必须是合法 uuid**：非法值直接抛 `SESSION_REQUIRED`（不落库、不退回全局最新行）。
     */
    userId?: string;
  }): Promise<ExportRecord | null>;
  linkJob(input: { exportId: string; jobId: string }): Promise<void>;
  markSent(id: string): Promise<ExportRecord>;
  markFailed(id: string, options?: { errorCode?: string | null }): Promise<ExportRecord>;
  markOutcomeUnknown(id: string, options?: { errorCode?: string | null }): Promise<ExportRecord>;
  guardWriteback(input: { exportId: string; userId: string; result: unknown }): Promise<{ written: boolean; exportId: string }>;
  getWriteback(exportId: string): Promise<Row | null>;
  cancelVersion(input: { exportId: string; userId: string; objectVersion: number; reason?: string }): Promise<{ cancelled: boolean; alreadyCancelled: boolean; cancelledCount: number }>;
  cancelForJob(input: { jobId: string; userId: string; reason?: string }): Promise<{ cancelled: number }>;
  revokeInFlight(input: { userId: string; purpose?: string | null }): Promise<number>;
}

/**
 * 创建持久外发账本。
 *
 * 所有写路径都在**单个事务**内完成"校验读取 + 实际写入"；任一校验不通过 ⇒ 抛契约错误并回滚
 * ⇒ **零写入**。
 */
export function createPostgresExportLedger({ pool }: { pool: PgPool }): PostgresExportLedger {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new Error('createPostgresExportLedger 需要 pg 连接池');
  }

  async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '4s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return mapPgError(error);
    } finally {
      client?.release();
    }
  }

  /**
   * 账本**是否已就绪**（懒探测 + 缓存）：需要 0011 迁移（`export_writebacks` 与 `exports` 新列）
   * **且**运行时角色具备 `gengyun_egress_ledger` 的写权限。
   *
   * 为什么需要它（真 PG workflow 回归的修法）：授权路径会在"已有业务依赖"时调用撤回消费者；
   * 若部署尚未施加 0011/角色，第一条 `UPDATE public.exports` 会以驱动错误（42501/42703）失败，
   * 被笼统映射成 **503 `PROVIDER_UNAVAILABLE`**，把「如实拒绝的部分撤回」变成「授权服务不可用」。
   * 这里把它变成**契约内的明确拒绝**（409 `OBJECT_UNAVAILABLE`），由授权服务如实拒绝部分撤回 ——
   * 方向仍然是 fail-closed：**要么真的撤销在途外发，要么拒绝**，绝不伪造取消成功。
   */
  let provisioned: boolean | null = null;
  async function assertProvisioned(): Promise<void> {
    if (provisioned === true) return;
    if (provisioned === false) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '外发账本未就绪（缺 0011 迁移或 egress_ledger 角色）');
    }
    try {
      const row = (
        await pool.query(
          `SELECT to_regclass('public.export_writebacks') AS wb,
                  has_column_privilege(current_user, 'public.exports', 'revision', 'UPDATE') AS upd,
                  has_column_privilege(current_user, 'public.exports', 'cancelled_at', 'UPDATE') AS upd_cancel`,
        )
      ).rows[0] as Row | undefined;
      provisioned = row?.['wb'] !== null && row?.['wb'] !== undefined && row['upd'] === true && row['upd_cancel'] === true;
    } catch {
      provisioned = false;
    }
    if (!provisioned) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '外发账本未就绪（缺 0011 迁移或 egress_ledger 角色）');
    }
  }

  async function lockExport(client: PoolClient, id: string): Promise<Row | null> {
    if (!UUID.test(id)) throw new PrivacyError('INVALID_REQUEST', '外发记录 id 非法');
    const rows = (await client.query('SELECT * FROM public.exports WHERE id=$1::uuid FOR UPDATE', [id])).rows;
    return (rows[0] as Row | undefined) ?? null;
  }

  /** 账号身份（状态 + 单调 auth_epoch）在同一事务内一致快照；FOR SHARE 与状态迁移串行化。 */
  async function assertAccount(client: PoolClient, userId: string, authEpoch: number): Promise<void> {
    const rows = (await client.query('SELECT id,state,auth_epoch FROM public.users WHERE id=$1::uuid FOR SHARE', [userId])).rows;
    const user = rows[0] as Row | undefined;
    if (!user || user['state'] !== 'active') {
      throw new PrivacyError('ACCOUNT_INACTIVE', `账号状态为 ${String(user?.['state'] ?? 'unknown')}，禁止外发`);
    }
    const current = int(user['auth_epoch']);
    if (current < 1 || current !== authEpoch) {
      throw new PrivacyError('ACCOUNT_INACTIVE', '账号状态已变更，禁止外发');
    }
  }

  /** 某用途的当前授权快照（epoch + granted + 绑定接收方），在同一事务内一致读取。 */
  async function loadConsent(client: PoolClient, userId: string, purpose: string) {
    const epochRow = (
      await client.query(
        'SELECT current_epoch,state FROM public.privacy_epochs WHERE user_id=$1::uuid AND purpose=$2::consent_purpose FOR SHARE',
        [userId, purpose],
      )
    ).rows[0] as Row | undefined;
    if (!epochRow || epochRow['state'] !== 'granted') return { granted: false, epoch: int(epochRow?.['current_epoch']), record: null as Row | null };
    const epoch = int(epochRow['current_epoch']);
    if (epoch < 1) return { granted: false, epoch, record: null as Row | null };
    const record = (
      await client.query(
        `SELECT id,state,epoch,recipient_ids,policy_version FROM public.consent_records
          WHERE user_id=$1::uuid AND purpose=$2::consent_purpose AND epoch=$3 FOR SHARE`,
        [userId, purpose, epoch],
      )
    ).rows[0] as Row | undefined;
    if (!record || record['state'] !== 'granted' || int(record['epoch']) !== epoch) {
      return { granted: false, epoch, record: null as Row | null };
    }
    return { granted: true, epoch, record };
  }

  async function assertRecipient(
    client: PoolClient,
    recipientId: string,
    expectedConfigVersion: string,
    requireIntegrity: boolean,
  ): Promise<void> {
    const row = (
      await client.query(
        `SELECT id,enabled,config_version,no_training_verified,deletion_verified
           FROM public.recipients WHERE id=$1 FOR SHARE`,
        [recipientId],
      )
    ).rows[0] as Row | undefined;
    if (!row || row['enabled'] !== true) throw new PrivacyError('OBJECT_UNAVAILABLE', `接收方不可用：${recipientId}`);
    if (row['config_version'] !== expectedConfigVersion) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', `接收方 ${recipientId} 版本已变化，需重新同意`);
    }
    if (requireIntegrity) {
      if (row['no_training_verified'] !== true) throw new PrivacyError('SCOPE_DENIED', `接收方 ${recipientId} 未验证禁止擅自训练`);
      if (row['deletion_verified'] !== true) throw new PrivacyError('SCOPE_DENIED', `接收方 ${recipientId} 未验证删除确认能力`);
    }
  }

  /** 提交边界的一致性校验：账号 + 全部必需用途 + 接收方，逐项与预留快照比对。 */
  async function verifySnapshot(client: PoolClient, record: ExportRecord): Promise<void> {
    await assertAccount(client, record.userId, record.authEpoch);
    for (const [purpose, epoch] of Object.entries(record.requiredConsents ?? {})) {
      const snapshot = await loadConsent(client, record.userId, purpose);
      if (!snapshot.granted) throw new PrivacyError('OBJECT_UNAVAILABLE', `授权 ${purpose} 已撤回，禁止外发`);
      if (snapshot.epoch !== Number(epoch)) {
        throw new PrivacyError('OBJECT_UNAVAILABLE', `授权 ${purpose} 版本已变化，禁止外发`);
      }
    }
    await assertRecipient(
      client,
      record.recipientId,
      record.recipientConfigVersion,
      record.purpose === 'external_inference',
    );
  }

  function encodeCursor(record: ExportRecord): string {
    return Buffer.from(JSON.stringify({ t: record.createdAt, id: record.id }), 'utf8').toString('base64url');
  }
  function decodeCursor(cursor: string): { at: string; id: string } {
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 2048) {
      throw new PrivacyError('INVALID_CURSOR', '游标非法');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw new PrivacyError('INVALID_CURSOR', '游标不可解析');
    }
    const value = parsed as { t?: unknown; id?: unknown };
    if (typeof value?.t !== 'string' || typeof value?.id !== 'string') {
      throw new PrivacyError('INVALID_CURSOR', '游标非法');
    }
    return { at: value.t, id: value.id };
  }

  async function reserve(input: Parameters<PostgresExportLedger['reserve']>[0]): Promise<ExportRecord> {
    const { userId, authEpoch, objectType, objectId, objectKey, objectRevision, dataType, purpose, recipientId, sourceVersion = null } = input ?? {};
    if (!objectType || typeof objectType !== 'string' || objectType.length > 40) {
      throw new PrivacyError('INVALID_REQUEST', 'object_type 缺失或过长');
    }
    // N1：`object_type` 是契约 `TargetRef.type` 的**闭集**（17 值，`EXPORT_OBJECT_TYPES` 逐项镜像）。
    // 库层 `exports.object_type` 只是 `varchar(40)`（0040 明确未加枚举 CHECK），因此必须在
    // **任何 SQL 之前**拒绝闭集外的值：否则非法值会写进账本，读面 `/me/exports` 整页 503。
    if (!EXPORT_OBJECT_TYPES.includes(objectType)) {
      throw new PrivacyError('INVALID_REQUEST', 'object_type 不在契约 TargetRef.type 闭集内');
    }
    if (!Number.isInteger(objectRevision) || objectRevision < 1) throw new PrivacyError('INVALID_REQUEST', 'object_revision 非法');
    if (!Number.isInteger(authEpoch) || authEpoch < 1) throw new PrivacyError('SESSION_REQUIRED', '缺少身份版本（auth_epoch）');
    if (typeof userId !== 'string' || !UUID.test(userId)) throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
    if (typeof recipientId !== 'string' || recipientId.length < 1 || recipientId.length > 80) {
      throw new PrivacyError('INVALID_REQUEST', 'recipient_id 非法');
    }
    if (sourceVersion !== null && (typeof sourceVersion !== 'string' || sourceVersion.length > 40)) {
      throw new PrivacyError('INVALID_REQUEST', 'source_version 非法');
    }
    // 资料类型判定 = **媒体维 ∪ 非媒体维**（GY-I27 第三片）：未知类型仍逐字拒 SCOPE_DENIED。
    const requiredPurposes = requiredConsentsForDataType(dataType);
    if (requiredPurposes === null) throw new PrivacyError('SCOPE_DENIED', `未知资料类型：${dataType}`);
    if (!requiredPurposes.includes(purpose)) {
      throw new PrivacyError('SCOPE_DENIED', `用途 ${purpose} 与资料类型 ${dataType} 不匹配（错用途）`);
    }
    // 对象标识：**媒体维必须 uuid**（既有口径逐字不变）；**非媒体维必须是文本型键** ——
    // 两者恰好给一个，不得都缺、不得都给（数据库侧另有 `exports_object_ident_xor` 同口径兜底）。
    const expectsTextKey = !MEDIA_PURPOSES.includes(dataType);
    const hasObjectId = typeof objectId === 'string' && objectId.length > 0;
    const hasObjectKey = typeof objectKey === 'string' && objectKey.length > 0;
    if (expectsTextKey) {
      if (objectId !== undefined && objectId !== null) {
        throw new PrivacyError('INVALID_REQUEST', '非媒体资料的对象标识用 object_key，不得传 object_id');
      }
      if (!hasObjectKey || !OBJECT_KEY.test(objectKey as string) || (objectKey as string).length > OBJECT_KEY_MAX) {
        throw new PrivacyError('INVALID_REQUEST', 'object_key 缺失或非法（1..80 小写字母/数字/_-.:）');
      }
    } else {
      if (objectKey !== undefined && objectKey !== null) {
        throw new PrivacyError('INVALID_REQUEST', '媒体资料的对象标识用 object_id，不得传 object_key');
      }
      if (!hasObjectId || !UUID.test(objectId as string)) throw new PrivacyError('INVALID_REQUEST', 'object_id 缺失或非 uuid');
    }
    const objectKeyValue: string | null = expectsTextKey ? (objectKey as string) : null;
    const objectIdValue: string | null = expectsTextKey ? null : (objectId as string);
    // 供「取消墓碑」等按维度分支的查询使用（与 `objectIdValue`/`objectKeyValue` 同源，恰一个非 null）。
    const keyValue = expectsTextKey ? objectKeyValue : objectIdValue;

    await assertProvisioned();
    return withTransaction(async (client) => {
      await assertAccount(client, userId, authEpoch);
      // 取消墓碑：同一 (user, object, revision) 一旦取消，**不得再次预留**（不可复活）。
      // 对象标识按维度分支：媒体维 `object_id=$3::uuid`，非媒体维 `object_key=$3`（两者互斥，恰一个非空）。
      const tombstone = (
        await client.query(
          `SELECT id FROM public.exports
            WHERE user_id=$1::uuid AND object_type=$2 AND object_revision=$4
              AND cancelled_at IS NOT NULL
              AND ${expectsTextKey ? 'object_key=$3' : 'object_id=$3::uuid'} LIMIT 1`,
          [userId, objectType, keyValue, objectRevision],
        )
      ).rows[0];
      if (tombstone) throw new PrivacyError('OBJECT_UNAVAILABLE', '该对象版本已取消，禁止再次外发');

      const requiredConsents: Record<string, number> = {};
      let consentId: string | null = null;
      let primaryRecipientIds: string[] = [];
      for (const p of requiredPurposes) {
        const snapshot = await loadConsent(client, userId, p);
        if (!snapshot.granted || snapshot.record === null) throw new PrivacyError('CONSENT_REQUIRED', `缺少用途授权：${p}`);
        const ids = Array.isArray(snapshot.record['recipient_ids'])
          ? (snapshot.record['recipient_ids'] as unknown[]).map(String)
          : [];
        if (!ids.includes(recipientId)) throw new PrivacyError('CONSENT_REQUIRED', `用途 ${p} 未绑定接收方 ${recipientId}`);
        requiredConsents[p] = snapshot.epoch;
        if (p === purpose) {
          consentId = String(snapshot.record['id']);
          primaryRecipientIds = ids;
        }
      }
      if (consentId === null) throw new PrivacyError('CONSENT_REQUIRED', `缺少用途授权：${purpose}`);
      void primaryRecipientIds;

      const recipient = (
        await client.query('SELECT * FROM public.recipients WHERE id=$1', [recipientId])
      ).rows[0] as Row | undefined;
      if (!recipient) throw new PrivacyError('OBJECT_UNAVAILABLE', `接收方不可用：${recipientId}`);
      if (recipient['enabled'] !== true) throw new PrivacyError('OBJECT_UNAVAILABLE', `接收方未启用：${recipientId}`);
      const configVersion = String(recipient['config_version']);
      if (purpose === 'external_inference') {
        if (recipient['no_training_verified'] !== true) {
          throw new PrivacyError('SCOPE_DENIED', `接收方 ${recipientId} 未验证禁止擅自训练`);
        }
        if (recipient['deletion_verified'] !== true) {
          throw new PrivacyError('SCOPE_DENIED', `接收方 ${recipientId} 未验证删除确认能力`);
        }
      }

      // 插入：两列**都写**。媒体维 `object_id` = 真实 uuid、`object_key` = NULL；
      // 非媒体维 `object_id` = 全零哨兵、`object_key` = 文本键 ⇒ 满足
      // `exports_object_ident_xor`（`object_key IS NULL OR object_id = 哨兵`）。
      const inserted = await client.query(
        `INSERT INTO public.exports(user_id,object_type,object_id,object_key,object_revision,purpose,consent_id,
            consent_epoch,required_consents,recipient_id,recipient_config_version,source_version,state,auth_epoch,revision)
          VALUES($1::uuid,$2,$3::uuid,$4,$5,$6::consent_purpose,$7::uuid,$8,$9::jsonb,$10,$11,$12,'reserved',$13,1)
          RETURNING *`,
        [
          userId, objectType, objectIdValue ?? OBJECT_KEY_SENTINEL_UUID, objectKeyValue, objectRevision,
          purpose, consentId, requiredConsents[purpose], JSON.stringify(requiredConsents), recipientId,
          configVersion, sourceVersion, authEpoch,
        ],
      );
      return toRecord(inserted.rows[0] as Row);
    });
  }

  async function get(id: string): Promise<ExportRecord | null> {
    try {
      if (!UUID.test(id)) return null;
      const rows = (await pool.query('SELECT * FROM public.exports WHERE id=$1::uuid', [id])).rows;
      return rows[0] ? toRecord(rows[0] as Row) : null;
    } catch (error) {
      return mapPgError(error);
    }
  }

  async function list(input: { userId: string; limit?: number; cursor?: string | null }) {
    const { userId, limit = 50, cursor = null } = input ?? {};
    if (typeof userId !== 'string' || !UUID.test(userId)) throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new PrivacyError('INVALID_REQUEST', 'limit 必须是 1..50 的整数');
    }
    const after = cursor === null || cursor === undefined ? null : decodeCursor(cursor);
    try {
      const rows = (
        await pool.query(
          `SELECT * FROM public.exports
            WHERE user_id=$1::uuid
              AND ($2::timestamptz IS NULL OR (created_at,id) < ($2::timestamptz,$3::uuid))
            ORDER BY created_at DESC, id DESC
            LIMIT $4`,
          [userId, after?.at ?? null, after?.id ?? null, limit + 1],
        )
      ).rows.map((row) => toRecord(row as Row));
      const page = rows.slice(0, limit);
      return { items: page, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null };
    } catch (error) {
      return mapPgError(error);
    }
  }

  /** 从**用户当前授权绑定**里解析该能力唯一可用的接收方；不存在或不唯一 ⇒ fail-closed。 */
  async function resolveRecipient(input: { userId: string; purpose: string; capability: string }): Promise<string> {
    const { userId, purpose, capability } = input ?? {};
    if (typeof userId !== 'string' || !UUID.test(userId)) throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
    try {
      const rows = (
        await pool.query(
          `SELECT r.id
             FROM public.privacy_epochs p
             JOIN public.consent_records c
               ON c.user_id=p.user_id AND c.purpose=p.purpose AND c.epoch=p.current_epoch
             JOIN public.recipients r
               ON r.id = ANY (SELECT jsonb_array_elements_text(c.recipient_ids))
            WHERE p.user_id=$1::uuid AND p.purpose=$2::consent_purpose AND p.state='granted'
              AND c.state='granted' AND r.enabled AND r.capability=$3
              AND ($4::boolean IS FALSE OR (r.no_training_verified AND r.deletion_verified))
            ORDER BY r.id`,
          [userId, purpose, capability, purpose === 'external_inference'],
        )
      ).rows as Row[];
      if (rows.length !== 1) {
        throw new PrivacyError('CONSENT_REQUIRED', '当前用途授权没有唯一可用接收方（或尚未核验）');
      }
      return String(rows[0]!['id']);
    } catch (error) {
      return mapPgError(error);
    }
  }

  async function findReservedByObject(input: {
    objectType: string;
    objectId?: string;
    objectKey?: string;
    objectRevision: number;
    userId?: string;
  }) {
    const { objectType, objectId, objectKey, objectRevision, userId } = input ?? {};
    // 维度分支：给了 objectKey 走文本列（非媒体维，0014），否则走 uuid 列（媒体维，既有口径）。
    const byKey = typeof objectKey === 'string' && objectKey.length > 0;
    if (byKey) {
      if (!OBJECT_KEY.test(objectKey as string) || (objectKey as string).length > OBJECT_KEY_MAX) return null;
    } else if (typeof objectId !== 'string' || !UUID.test(objectId)) {
      return null;
    }
    // `userId` 可选：**未提供**（`undefined`）时保持既有口径（不筛属主，如媒体维 `task-egress`）；
    // **一旦提供**就必须是合法 uuid —— 非法值一律抛错，**绝不**静默退回「全局最新 reserved」：
    // 那会把别人的预留行当成自己的（跨用户串行 / 越权外发），比直接拒绝更坏的失败方式。
    // 错误码与消息同 `reserve`/`list`/`resolveRecipient` 对同一字段的既有口径（不含任何用户数据）。
    if (userId !== undefined && (typeof userId !== 'string' || !UUID.test(userId))) {
      throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
    }
    const scoped = userId !== undefined;
    try {
      const rows = (
        await pool.query(
          `SELECT * FROM public.exports
            WHERE object_type=$1 AND object_revision=$3
              AND ${byKey ? 'object_key=$2' : 'object_id=$2::uuid'}
              ${scoped ? 'AND user_id=$4::uuid' : ''}
              AND state='reserved' AND cancelled_at IS NULL
            ORDER BY created_at DESC LIMIT 1`,
          scoped
            ? [objectType, byKey ? objectKey : objectId, objectRevision, userId]
            : [objectType, byKey ? objectKey : objectId, objectRevision],
        )
      ).rows;
      return rows[0] ? toRecord(rows[0] as Row) : null;
    } catch (error) {
      return mapPgError(error);
    }
  }

  async function linkJob(input: { exportId: string; jobId: string }): Promise<void> {
    const { exportId, jobId } = input ?? {};
    if (!UUID.test(String(jobId))) throw new PrivacyError('INVALID_REQUEST', 'job_id 非法');
    await assertProvisioned();
    try {
      await pool.query(
        'UPDATE public.exports SET job_id=$2::uuid, updated_at=now() WHERE id=$1::uuid AND job_id IS NULL',
        [exportId, jobId],
      );
    } catch (error) {
      return mapPgError(error);
    }
  }

  async function markSent(id: string): Promise<ExportRecord> {
    await assertProvisioned();
    return withTransaction(async (client) => {
      const row = await lockExport(client, id);
      if (!row) throw new PrivacyError('NOT_FOUND', '外发记录不存在');
      const record = toRecord(row);
      if (record.state !== 'reserved') {
        throw new PrivacyError('OBJECT_UNAVAILABLE', `外发记录非预留态（${record.state}），禁止派发`);
      }
      if (row['cancelled_at'] !== null) throw new PrivacyError('OBJECT_UNAVAILABLE', '该对象版本已取消，禁止派发');
      await verifySnapshot(client, record);
      const updated = (
        await client.query(
          `UPDATE public.exports SET state='sent', sent_at=now(), updated_at=now(), revision=revision+1
            WHERE id=$1::uuid AND revision=$2 RETURNING *`,
          [id, record.revision],
        )
      ).rows[0];
      if (!updated) throw new PrivacyError('OBJECT_UNAVAILABLE', '外发记录版本已变化，禁止派发');
      return toRecord(updated as Row);
    });
  }

  async function markTerminal(id: string, state: 'failed' | 'outcome_unknown', errorCode: string | null): Promise<ExportRecord> {
    await assertProvisioned();
    return withTransaction(async (client) => {
      const row = await lockExport(client, id);
      if (!row) throw new PrivacyError('NOT_FOUND', '外发记录不存在');
      const current = String(row['state']);
      if (current !== 'reserved' && current !== 'sent') {
        throw new PrivacyError('OBJECT_UNAVAILABLE', `外发已终态（${current}），不可变更`);
      }
      const updated = (
        await client.query(
          `UPDATE public.exports SET state=$2::export_state, error_code=$3, updated_at=now(), revision=revision+1
            WHERE id=$1::uuid AND revision=$4 RETURNING *`,
          [id, state, errorCode, int(row['revision'])],
        )
      ).rows[0];
      if (!updated) throw new PrivacyError('OBJECT_UNAVAILABLE', '外发记录版本已变化');
      return toRecord(updated as Row);
    });
  }

  /**
   * 结果回写：**校验与写入同一事务**。被拒 ⇒ 抛契约错误并回滚 ⇒ `export_writebacks` **零写入**。
   * 结果只落结构分类（调用方保证），本方法不写任何私有负载。
   */
  async function guardWriteback(input: { exportId: string; userId: string; result: unknown }) {
    const { exportId, userId, result } = input ?? {};
    if (typeof userId !== 'string' || !UUID.test(userId)) throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
    await assertProvisioned();
    return withTransaction(async (client) => {
      const row = await lockExport(client, exportId);
      if (!row || String(row['user_id']) !== userId) {
        throw new PrivacyError('OBJECT_UNAVAILABLE', '外发记录不存在或归属不符');
      }
      const record = toRecord(row);
      if (EXPORT_STATES.includes(record.state) && record.state !== 'sent' && record.state !== 'reserved') {
        throw new PrivacyError('OBJECT_UNAVAILABLE', `外发已终态（${record.state}），回写被阻断`);
      }
      if (row['cancelled_at'] !== null) throw new PrivacyError('OBJECT_UNAVAILABLE', '该对象版本已取消，回调不得复活');
      await verifySnapshot(client, record);
      const inserted = await client.query(
        `INSERT INTO public.export_writebacks(export_id,user_id,revision,result)
          VALUES($1::uuid,$2::uuid,$3,$4::jsonb)
          ON CONFLICT (export_id) DO NOTHING`,
        [exportId, userId, record.revision, JSON.stringify(result ?? {})],
      );
      // 只认真正落库的那一次：ON CONFLICT DO NOTHING 命中已有回写时 rowCount=0，
      // 此时**没有新行**，不得声称 written:true，也不得覆盖第一次的载荷。
      if ((inserted?.rowCount ?? 0) === 0) return { written: false, replay: true, exportId };
      return { written: true, exportId };
    });
  }

  async function getWriteback(exportId: string): Promise<Row | null> {
    try {
      const rows = (
        await pool.query(
          'SELECT export_id,user_id,revision,result,committed_at FROM public.export_writebacks WHERE export_id=$1::uuid',
          [exportId],
        )
      ).rows;
      return rows[0] ? (rows[0] as Row) : null;
    } catch (error) {
      return mapPgError(error);
    }
  }

  /** 取消一个版本：**只增不减**的墓碑 + 在途置 failed（终态记录同样置墓碑 ⇒ 晚到回调不可复活）。 */
  async function cancelVersion(input: { exportId: string; userId: string; objectVersion: number; reason?: string }) {
    const { exportId, userId, objectVersion, reason = 'cancelled' } = input ?? {};
    if (!Number.isInteger(objectVersion) || objectVersion < 1) {
      throw new PrivacyError('INVALID_REQUEST', 'object_version 非法');
    }
    await assertProvisioned();
    return withTransaction(async (client) => {
      const row = await lockExport(client, exportId);
      if (!row || String(row['user_id']) !== userId) {
        throw new PrivacyError('OBJECT_UNAVAILABLE', '外发记录不存在或归属不符');
      }
      if (int(row['object_revision']) !== objectVersion) {
        throw new PrivacyError('OBJECT_UNAVAILABLE', '取消版本与预留版本不一致');
      }
      const already = row['cancelled_at'] !== null;
      const current = String(row['state']);
      const updated = (
        await client.query(
          `UPDATE public.exports
              SET cancelled_at = COALESCE(cancelled_at, now()),
                  cancellation_reason = COALESCE(cancellation_reason, $2),
                  state = CASE WHEN state IN ('reserved','sent') THEN 'failed'::export_state ELSE state END,
                  error_code = CASE WHEN state IN ('reserved','sent') THEN 'OBJECT_CANCELLED' ELSE error_code END,
                  updated_at = now(), revision = revision+1
            WHERE id=$1::uuid RETURNING *`,
          [exportId, safeReason(reason)],
        )
      ).rows[0];
      if (!updated) throw new PrivacyError('OBJECT_UNAVAILABLE', '取消失败');
      void current;
      return { cancelled: true, alreadyCancelled: already, cancelledCount: 1 };
    });
  }

  async function cancelForJob(input: { jobId: string; userId: string; reason?: string }) {
    const { jobId, userId, reason = 'job_cancelled' } = input ?? {};
    if (!UUID.test(String(jobId))) throw new PrivacyError('INVALID_REQUEST', 'job_id 非法');
    await assertProvisioned();
    return withTransaction(async (client) => {
      const rows = (
        await client.query(
          `UPDATE public.exports
              SET cancelled_at = COALESCE(cancelled_at, now()),
                  cancellation_reason = COALESCE(cancellation_reason, $3),
                  state = CASE WHEN state IN ('reserved','sent') THEN 'failed'::export_state ELSE state END,
                  error_code = CASE WHEN state IN ('reserved','sent') THEN 'OBJECT_CANCELLED' ELSE error_code END,
                  updated_at = now(), revision = revision+1
            WHERE job_id=$1::uuid AND user_id=$2::uuid
            RETURNING id`,
          [jobId, userId, safeReason(reason)],
        )
      ).rows as Row[];
      return { cancelled: rows.length };
    });
  }

  /** 撤回/注销：把在途外发置 failed（幂等；撤回时可由 `required_consents` 精确到用途）。 */
  async function revokeInFlight(input: { userId: string; purpose?: string | null }): Promise<number> {
    const { userId, purpose = null } = input ?? {};
    await assertProvisioned();
    try {
      const rows = (
        await pool.query(
          `UPDATE public.exports
              SET state='failed', error_code='CONSENT_WITHDRAWN', updated_at=now(), revision=revision+1
            WHERE user_id=$1::uuid AND state IN ('reserved','sent')
              AND ($2::text IS NULL OR required_consents ? $2::text)
            RETURNING id`,
          [userId, purpose],
        )
      ).rows as Row[];
      return rows.length;
    } catch (error) {
      return mapPgError(error);
    }
  }

  return {
    reserve,
    get,
    list,
    resolveRecipient,
    findReservedByObject,
    linkJob,
    markSent,
    markFailed: (id, options = {}) => markTerminal(id, 'failed', options.errorCode ?? null),
    markOutcomeUnknown: (id, options = {}) => markTerminal(id, 'outcome_unknown', options.errorCode ?? null),
    guardWriteback,
    getWriteback,
    cancelVersion,
    cancelForJob,
    revokeInFlight,
  };
}

/**
 * 在途守卫所需的**只读**端口（账号身份 + 授权快照）。与内存夹具同形，
 * 因此 `packages/privacy/in-flight.mjs` 的 `createInFlightGuard` 可**原样复用**。
 */
export function createPostgresPrivacyPorts({ pool }: { pool: PgPool }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createPostgresPrivacyPorts 需要 pg 连接池');
  async function stateOf(userId: string): Promise<string> {
    const rows = (await pool.query('SELECT state FROM public.users WHERE id=$1::uuid', [userId])).rows as Row[];
    return rows[0] ? String(rows[0]['state']) : 'deleted';
  }
  async function authEpochOf(userId: string): Promise<number> {
    const rows = (await pool.query('SELECT auth_epoch FROM public.users WHERE id=$1::uuid', [userId])).rows as Row[];
    return rows[0] ? int(rows[0]['auth_epoch']) : 0;
  }
  async function snapshot(userId: string, purpose: string): Promise<{ granted: boolean; epoch: number }> {
    const rows = (
      await pool.query('SELECT current_epoch,state FROM public.privacy_epochs WHERE user_id=$1::uuid AND purpose=$2::consent_purpose', [
        userId,
        purpose,
      ])
    ).rows as Row[];
    const row = rows[0];
    if (!row || row['state'] !== 'granted') return { granted: false, epoch: int(row?.['current_epoch']) };
    return { granted: true, epoch: int(row['current_epoch']) };
  }
  return {
    account: { stateOf, authEpochOf },
    consentStore: {
      async isGranted({ userId, purpose }: { userId: string; purpose: string }) {
        return (await snapshot(userId, purpose)).granted;
      },
      async currentEpoch({ userId, purpose }: { userId: string; purpose: string }) {
        return (await snapshot(userId, purpose)).epoch;
      },
    },
  };
}

/**
 * 结果回写的**结构化摘要**：只保留 `kind` / `code` / `substitute` 等短 token，
 * 并显式标注 `content_class: 'structural_only'`。
 *
 * 硬红线落实：账本**不落**私有正文/图片/音频/精确坐标/凭据（结果本体在各业务域 store）。
 * 即使调用方误传整份提供者载荷，本函数也只会取出**枚举形状**，其余一律丢弃。
 */
export function summarizeEgressOutcome(value: unknown): Record<string, unknown> {
  const source = (value ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof source['kind'] === 'string' && /^[a-z_]{1,32}$/.test(source['kind'])) out['kind'] = source['kind'];
  if (typeof source['code'] === 'string' && /^[A-Z_]{1,64}$/.test(source['code'])) out['code'] = source['code'];
  if (typeof source['substitute'] === 'boolean') out['substitute'] = source['substitute'];
  out['content_class'] = 'structural_only';
  return redactForLog(out) as Record<string, unknown>;
}

/** 提供者结局是否为**失败**（失败不写回写表，只落终态 + 安全错误码）。 */
export function failureCodeOf(value: unknown): string | null {
  const source = (value ?? {}) as Record<string, unknown>;
  if (source['kind'] !== 'failed') return null;
  return typeof source['code'] === 'string' && /^[A-Z_]{1,64}$/.test(source['code']) ? source['code'] : 'PROVIDER_UNAVAILABLE';
}
