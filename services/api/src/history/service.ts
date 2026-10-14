/**
 * GY-I16（#16）· 历史子域服务层；HTTP 装配在 `routes/history.ts`，领域层不注册路由。
 *
 * 覆盖契约 operationId：`listHistory`（`GET /history`）、`deleteHistory`（`DELETE /history/{id}`）。
 * 另有**内部创建口** `appendHistory`（**不是**契约 operationId，**不注册**任何路由，
 * 沿用 #17 `messages.appendMessage` 的既有先例）。
 *
 * ## 为什么没有 `GET /history/{id}`
 * 契约里 `/history/{id}` **只有 `delete`**，没有 `get`。所以**详情**由客户端用第 7 项 `target_ref`
 * 指向的**已合并**契约面组合出来：`GET /recognitions/{id}`（#9）或 `GET /ocr/{id}`（#10）。
 * 本片**不新造**契约外路径，也**不复制**候选/选择/OCR 核对/来源版本到历史响应里
 * （那些字段历史契约里没有；自造字段就是编造契约）。
 *
 * ## 核心不变式
 *
 * 1. **归属**：读取/删除只看得到本人的历史。他人历史与"不存在"**同形**（`notFound()` 逐字节相同）。
 * 2. **失败状态真实可见**：`job_state` 是 `JobState` 闭集原值，**失败/超时/取消/不确定一律原样列出**
 *    （不隐藏、不折叠、不改成 `succeeded`）。读取时再经 `history/job.ts` 向已合并的
 *    `getJob` 核对实时状态（实时值优先，核不到退回入库值，**绝不凭空升级为成功**）。
 * 3. **可见性逐次重查**：`reference_state` 每次读取按目标**当前**可见性派生，**不入库、不缓存**。
 *    隐藏／失效／删除／注销之后，旧历史行**不会**因"曾经记录过"重新公开；
 *    列表项只表达"该目标当前不可用"，不带任何目标正文。
 * 4. **识别/收藏 ≠ 已使用**：`History` 投影**恰为契约的 7 个字段**
 *    （`HISTORY_PROJECTION_FIELDS`），其中**没有**任何 `used`/`usage`/`used_at` 形式的事实字段；
 *    写历史只表示"发生过一次任务"，本轮**不**产生"已使用"结论
 *    （`appendHistory` 不接受任何使用类字段，未知字段即 400）。
 * 5. **出口不可变**：所有返回给调用方的对象都是从存储**深拷贝**出来的自有数据。
 *
 * ## 未取得（如实声明，不得当作已完成）
 *
 * - 只有内存存储（进程重启即丢），**没有**数据库迁移；real 模式下历史域整体不可用（见 `app.ts`）。
 * - **任务状态端口默认未接线**、**可见性端口默认未接线** ⇒ 生产装配下历史行显示入库时的
 *   最后已知状态 + `reference_state: unavailable`。本片**不宣称**历史已端到端可用。
 * - **识别/OCR → 历史的写入接线属跨线**（要在 `recognitions/**`／`ocr/**` 里加一次调用），
 *   本片只交付内部口 `appendHistory` 与其测试；那一句由指挥另行派单。
 * - 契约对 `deleteHistory` 描述的"同时启动关联识别/OCR 私有结果/媒体和外发删除"同属跨线：
 *   本片只删除**历史行本身**，并通过 `history/cascade.ts` 的端口 + `X-GY-Cascade` 非契约
 *   披露头如实说明级联状态（`initiated`/`unwired`/`failed`），**不谎称级联已完成**。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { idempotencyKeyHashHex, idempotencyRequestHash, idempotencyScope } from '../auth/idempotency.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { cloneDeep } from '../targetref/immutable.ts';
import { deriveVisibility, type VisibilityPort } from '../targetref/visibility.ts';
import type { HistoryCascadePort } from './cascade.ts';
import { deriveJobState, type HistoryJobPort } from './job.ts';
import { compareHistoryDescending, type CascadeDisclosure, type HistoryRecord, type HistoryStore, type IdempotencyOutcome } from './store.ts';
import type { History, HistoryPage } from './types.ts';
import {
  parseListHistoryQuery,
  requireIdempotencyKey,
  requireIfMatch,
  requireUserActor,
  requireUuidParam,
  validateAppendHistoryInput,
} from './validate.ts';

/** 游标有效期（与知识/社区/消息/后台读口径一致：只服务翻页，不做长期令牌）。 */
export const CURSOR_TTL_MS = 15 * 60 * 1000;
/** 幂等重放窗口（契约参数描述：只覆盖客户端超时重试）。 */
export const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
/** 同键并发等待上界：超过即 409 REQUEST_IN_PROGRESS。 */
export const IDEMPOTENCY_WAIT_MS = 2000;

/**
 * `History` 响应投影的字段集（**恰好**等于契约 `History.properties` 的键）。
 * 测试据此断言"投影里没有 used/usage 这类事实字段"，也据此断言"候选/人工选择/OCR 核对/
 * 来源版本不在历史响应里"（它们属详情页的 `getRecognition`/`getOCR`）。
 */
export const HISTORY_PROJECTION_FIELDS = [
  'id',
  'revision',
  'kind',
  'target_ref',
  'job_state',
  'reference_state',
  'created_at',
] as const;

/** 契约强 ETag 的唯一构造口径：`ETag: "<revision>"`。 */
export function strongEtagOf(revision: number): string {
  return `"${revision}"`;
}

export interface HistoryServiceDeps {
  store: HistoryStore;
  /** 引用可用性端口（**必填**，见 `targetref/visibility.ts`）。 */
  visibility: VisibilityPort;
  /** 任务状态端口（**必填**，见 `history/job.ts`）。 */
  job: HistoryJobPort;
  /** 关联删除端口（**必填**，见 `history/cascade.ts`；未接线端口如实返回 `'unwired'`）。 */
  cascade: HistoryCascadePort;
  /** 签名密钥（游标签名 + 幂等请求摘要 HMAC）；只在内存使用，不落库、不入日志。 */
  signingKey: string;
  now?: () => Date;
  newId?: () => string;
  idempotencyTtlMs?: number;
  idempotencyWaitMs?: number;
}

export interface WriteOptions {
  idempotencyKey?: string;
  ifMatch?: string;
}

/** 内部创建口结果（内部形状，**不是**契约 schema）。 */
export interface AppendHistoryResult {
  /** 本次是否真的新建；`false` = 命中去重键，未重复创建。 */
  created: boolean;
  history: HistoryRecord;
}

/** `deleteHistory` 的服务层结果：契约 `Ack` + 级联披露（披露走响应头，不进 `data`）。 */
export interface DeleteHistoryResult {
  data: { accepted: true };
  cascade: CascadeDisclosure;
}

/** 契约 `404 NOT_FOUND`：他人历史与不存在**共用这一个**错误，形状逐字节相同。 */
function notFound(): ApiError {
  return new ApiError('NOT_FOUND', '历史记录不存在或不可用');
}

function commitRefusal(reason: 'NOT_FOUND' | 'OWNER_CHANGED' | 'REVISION_CHANGED'): ApiError {
  switch (reason) {
    case 'NOT_FOUND':
    case 'OWNER_CHANGED':
      return notFound();
    case 'REVISION_CHANGED':
      return new ApiError('REVISION_CONFLICT', '历史记录版本已变化，请刷新后重试');
  }
}

interface CursorPayload {
  v: 1;
  kind: 'history';
  subject: string;
  auth_epoch: number;
  watermark: string;
  route: 'history';
  filter: Record<string, string>;
  sort: 'created_at_desc';
  after: { created_at: string; id: string };
  expires: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 定长比较（避免把签名长度差异暴露成时序差异）；不引入额外依赖。 */
function timingSafeEqualBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

export function createHistoryService(deps: HistoryServiceDeps) {
  const store = deps.store;
  const visibility = deps.visibility;
  const job = deps.job;
  const cascade = deps.cascade;
  const signingKey = deps.signingKey;
  const clock = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const idempotencyTtlMs = deps.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
  const idempotencyWaitMs = deps.idempotencyWaitMs ?? IDEMPOTENCY_WAIT_MS;

  const nowIso = (): string => clock().toISOString();
  const sign = (value: string): string =>
    createHmac('sha256', signingKey).update('history-list/v1\n').update(value).digest('base64url');

  async function withIdempotency<T>(
    scope: string,
    keyHash: string,
    requestDigest: string,
    responseStatus: number,
    produce: () => Promise<{ outcome: IdempotencyOutcome; result: T }>,
    replay: (ref: IdempotencyOutcome) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await store.findIdempotency(scope, keyHash);
      if (existing !== null) {
        if (existing.request_hash !== requestDigest) {
          throw new ApiError('IDEMPOTENCY_CONFLICT', '同键请求内容不一致');
        }
        return replay(existing.outcome);
      }
      const claimed = await store.claimIdempotency(scope, keyHash, {
        request_hash: requestDigest,
        response_status: responseStatus,
        expires_at: clock().getTime() + idempotencyTtlMs,
      });
      if (!claimed) {
        const settled = await store.awaitIdempotencySettled(scope, keyHash, idempotencyWaitMs);
        if (settled === 'timeout') {
          throw new ApiError('REQUEST_IN_PROGRESS', '同键请求正在处理中，请稍后重试', { retryable: true });
        }
        continue;
      }
      let produced: { outcome: IdempotencyOutcome; result: T };
      try {
        produced = await produce();
      } catch (error) {
        await store.releaseIdempotency(scope, keyHash);
        throw error;
      }
      const saved = await store.completeIdempotency(scope, keyHash, {
        response_status: responseStatus,
        outcome: produced.outcome,
      });
      if (saved) return produced.result;
    }
    throw new ApiError('REQUEST_IN_PROGRESS', '同键请求正在处理中，请稍后重试', { retryable: true });
  }

  /**
   * 契约 `History` 投影。字段顺序与契约一致；`target_ref` 深拷贝；
   * `job_state` 实时优先/退回入库值；`reference_state` 逐次重查（不做缓存）。
   */
  async function project(record: HistoryRecord, userId: string): Promise<History> {
    const liveJobState = await deriveJobState(job, record.job_state, {
      kind: record.kind,
      jobId: record.job_id,
      userId,
    });
    const verdict = await deriveVisibility(visibility, { target_ref: cloneDeep(record.target_ref), userId });
    return {
      id: record.id,
      revision: record.revision,
      kind: record.kind,
      target_ref: cloneDeep(record.target_ref),
      job_state: liveJobState,
      reference_state: verdict.state,
      created_at: record.created_at,
    };
  }

  function encodeCursor(payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${sign(body)}`;
  }

  function decodeCursor(
    cursor: string | null,
    expected: Omit<CursorPayload, 'after' | 'expires'>,
  ): Pick<CursorPayload, 'after' | 'expires'> | null {
    if (cursor === null) return null;
    try {
      const parts = cursor.split('.');
      if (parts.length !== 2) throw new Error('shape');
      const body = parts[0];
      const signature = parts[1];
      if (typeof body !== 'string' || typeof signature !== 'string' || body.length === 0) throw new Error('shape');
      const decoded = Buffer.from(body, 'base64url');
      if (decoded.toString('base64url') !== body || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new Error('encoding');
      const expectedSignature = Buffer.from(sign(body), 'base64url');
      const received = Buffer.from(signature, 'base64url');
      if (received.toString('base64url') !== signature) throw new Error('encoding');
      if (received.length !== expectedSignature.length || !timingSafeEqualBytes(expectedSignature, received)) {
        throw new Error('signature');
      }
      const value: unknown = JSON.parse(decoded.toString('utf8'));
      const keys = ['v', 'kind', 'subject', 'auth_epoch', 'watermark', 'route', 'filter', 'sort', 'after', 'expires'];
      if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
        throw new Error('fields');
      }
      if (value['v'] !== 1 || value['auth_epoch'] !== expected.auth_epoch || value['watermark'] !== expected.watermark) {
        throw new Error('version');
      }
      if (value['kind'] !== expected.kind || value['route'] !== expected.route) throw new Error('scope');
      if (value['subject'] !== expected.subject) throw new Error('subject');
      if (value['sort'] !== expected.sort) throw new Error('sort');
      if (JSON.stringify(value['filter']) !== JSON.stringify(expected.filter)) throw new Error('filter');
      const expires = value['expires'];
      if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= clock().getTime()) {
        throw new Error('expired');
      }
      const after = value['after'];
      if (!isRecord(after) || Object.keys(after).length !== 2 || !Object.hasOwn(after, 'created_at') || !Object.hasOwn(after, 'id')) {
        throw new Error('after');
      }
      if (typeof after['created_at'] !== 'string' || typeof after['id'] !== 'string') throw new Error('after');
      return { after: { created_at: after['created_at'], id: after['id'] }, expires };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('INVALID_CURSOR', '游标无效或已失效');
    }
  }

  /**
   * 启动关联删除；**绝不向上抛**（历史行已删除这一事实不因级联失败而回滚或改口）。
   * 未接线 ⇒ `'unwired'`；抛错 ⇒ `'failed'`；成功 ⇒ `'initiated'`。
   */
  async function initiateCascade(record: HistoryRecord, userId: string): Promise<CascadeDisclosure> {
    try {
      const outcome = await cascade.initiate({
        userId,
        historyId: record.id,
        kind: record.kind,
        target_ref: cloneDeep(record.target_ref),
        jobId: record.job_id,
        jobState: record.job_state,
      });
      return outcome === 'initiated' ? 'initiated' : outcome;
    } catch {
      return 'failed';
    }
  }

  return {
    /** `listHistory`：`GET /history`。只列本人历史；`(created_at DESC, id DESC)` 稳定排序。 */
    async listHistory(actor: unknown, query: unknown = {}): Promise<HistoryPage> {
      const user = requireUserActor(actor);
      const { cursor, limit } = parseListHistoryQuery(query);
      const rows = await store.listHistoryByOwner(user.userId);
      const sorted = [...rows].sort(compareHistoryDescending);
      const expected: Omit<CursorPayload, 'after' | 'expires'> = {
        v: 1,
        kind: 'history',
        subject: user.userId,
        auth_epoch: user.authEpoch,
        watermark: createHmac('sha256', signingKey)
          .update('history-watermark/v1\n')
          .update(JSON.stringify(sorted.map((row) => [row.id, row.created_at])))
          .digest('base64url'),
        route: 'history',
        filter: {},
        sort: 'created_at_desc',
      };
      const chain = decodeCursor(cursor, expected);
      const after = chain?.after ?? null;
      if (after !== null && !sorted.some((row) => row.id === after.id && row.created_at === after.created_at)) {
        throw new ApiError('INVALID_CURSOR', '游标位置已失效，请重新读取首页');
      }
      const expires = chain?.expires ?? clock().getTime() + CURSOR_TTL_MS;
      const remaining =
        after === null
          ? sorted
          : sorted.filter(
              (row) => row.created_at < after.created_at || (row.created_at === after.created_at && row.id < after.id),
            );
      const page = remaining.slice(0, limit);
      const last = page[page.length - 1];
      const next_cursor =
        remaining.length > limit && last !== undefined
          ? encodeCursor({ ...expected, after: { created_at: last.created_at, id: last.id }, expires })
          : null;
      const items: History[] = [];
      for (const row of page) items.push(await project(row, user.userId));
      return { items, next_cursor };
    },

    /**
     * `deleteHistory`：`DELETE /history/{id}`。
     *
     * - 归属：非本人（含不存在）一律 404 `NOT_FOUND`，同形；
     * - `If-Match`：缺失 428、形状非法 400、**与目标当前 `revision` 不符 409**；
     * - 物理删除历史行（CAS，同一同步临界区内完成）；
     * - 删除成功后**启动**关联删除（端口未接线即如实披露 `unwired`；**不**谎称已完成）；
     * - 幂等重放按结果引用重新鉴权，并**回放同一份级联披露**（不重复触发第二次级联删除）。
     */
    async deleteHistory(actor: unknown, id: unknown, options: WriteOptions = {}): Promise<DeleteHistoryResult> {
      const user = requireUserActor(actor);
      const historyId = requireUuidParam(id, 'id');
      const key = requireIdempotencyKey(options.idempotencyKey);
      const ifMatch = requireIfMatch(options.ifMatch);
      const scope = idempotencyScope(user.userId, 'DELETE', `${API_PREFIX}/history/${historyId}`);
      const keyHash = idempotencyKeyHashHex(scope, key);
      const digest = idempotencyRequestHash(null, options.ifMatch, signingKey);
      return withIdempotency(
        scope,
        keyHash,
        digest,
        200,
        async () => {
          const record = await store.getHistory(historyId);
          // 归属与"不存在"同形：非本人**不得**得到 409。
          if (record === null || record.owner_id !== user.userId) throw notFound();
          if (record.revision !== ifMatch.revision) {
            throw new ApiError('REVISION_CONFLICT', '历史记录版本已变化，请刷新后重试');
          }
          const committed = await store.deleteHistory(historyId, { revision: record.revision, owner_id: user.userId });
          if (!committed.ok) throw commitRefusal(committed.reason);
          const disclosure = await initiateCascade(committed.record, user.userId);
          return {
            outcome: { kind: 'history' as const, id: historyId, revision: committed.record.revision, cascade: disclosure },
            result: { data: { accepted: true as const }, cascade: disclosure },
          };
        },
        async (ref) => {
          const record = await store.getHistory(historyId);
          if (record !== null && record.owner_id !== user.userId) throw notFound();
          const disclosure: CascadeDisclosure = ref.cascade ?? (cascade.available ? 'initiated' : 'unwired');
          return { data: { accepted: true as const }, cascade: disclosure };
        },
      );
    },

    // -----------------------------------------------------------------------
    // 内部操作（**不是**契约 operationId；无 HTTP 入口）
    // -----------------------------------------------------------------------

    /**
     * 内部创建口：由**服务端**域代码（识别/OCR 创建任务处）调用，把一个任务落成用户的一条历史。
     *
     * - **不注册路由**、不进契约；`owner_id`/`job_id`/`event_key` 由服务端调用方给出，
     *   绝不来自客户端（否则等于允许伪造他人历史）；
     * - 入参里的 `id`/`revision`/`reference_state`/`created_at` 一律被拒（`UNKNOWN_FIELD`）；
     * - 同 `(owner_id, event_key)` 只存在一条历史行：重复调度返回既有记录；
     * - **只记"发生过一次任务"**：`job_state` 原样落库（含 `failed`/`timed_out`/`cancelled`），
     *   不产生任何"已使用"事实，也不写收藏。
     *
     * > 稳定签名（供后续一行接线）：
     * > `app.historyService.appendHistory({ owner_id, kind, target_ref: { type, id, revision },
     * >   job_id, job_state, event_key })` ⇒ `Promise<{ created: boolean; history: HistoryRecord }>`
     * > （无 `await` 之外的依赖；抛 `ApiError('INVALID_REQUEST')` 表示入参不合约）。
     * > **接线属跨线**：那一句调用要加在 `recognitions/**`／`ocr/**` 里，本片不改那些文件。
     */
    async appendHistory(input: unknown): Promise<AppendHistoryResult> {
      const body = validateAppendHistoryInput(input);
      const existing = await store.findByEventKey(body.owner_id, body.event_key);
      if (existing !== null) return { created: false, history: existing };
      const record: HistoryRecord = {
        id: newId(),
        revision: 1,
        owner_id: body.owner_id,
        kind: body.kind,
        target_ref: cloneDeep(body.target_ref),
        job_id: body.job_id,
        job_state: body.job_state,
        created_at: nowIso(),
        event_key: body.event_key,
      };
      const inserted = await store.insertHistory(record);
      if (inserted === 'inserted') return { created: true, history: cloneDeep(record) };
      // 并发同键/同目标：另一次插入先赢，回读既有记录（不产生第二条历史）。
      const raced =
        (await store.findByEventKey(body.owner_id, body.event_key)) ??
        (await store.findByTarget(body.owner_id, body.kind, body.target_ref.id));
      if (raced === null) {
        throw new ApiError('PROVIDER_UNAVAILABLE', '历史去重索引不一致（内部不变式违反）');
      }
      return { created: false, history: raced };
    },
  };
}

export type HistoryService = ReturnType<typeof createHistoryService>;
