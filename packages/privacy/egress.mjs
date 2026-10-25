/**
 * GY-I27 隐私模块 · 外发消费者（egress consumer）协议。
 *
 * ## 为什么需要「消费者」这一层
 * `ledger.mjs` 只提供**记账与授权边界**（reserve / markSent / guardWriteback），它自己
 * **不发起任何外发**。真实派发必须由一个**消费者**完成：消费者是唯一被允许「读账本记录 →
 * 实际发出数据」的组件，因此下列红线只能落在消费者这一层：
 *   - 无授权／错用途 ⇒ **零调用**（不是"发了再回滚"）；
 *   - 撤回／注销 ⇒ 新外发被拒、在途结果不得回写（由 `in-flight.mjs` + 账本提交边界保证）；
 *   - `real` 模式**未接真实依赖** ⇒ **fail-closed**（契约内 `PROVIDER_UNAVAILABLE`，503，
 *     `retryable: false`），**绝不**用内存/替身实现返回成功封套；
 *   - `stub` / `preset_demo` 的替身只允许出现在**明确标注**的模式下，并在回执与日志里如实标明。
 *
 * ## 与旧版的区别（本轮剩余项：真实外发消费者）
 * 上一片（PR #45）已交付账本与守卫，但**没有任何真实消费者**：`consent-pg.ts` / `grant-pg.ts`
 * 因此在有 jobs/media/exports/author_links 依赖时直接 `OBJECT_UNAVAILABLE`（"撤回消费者尚未接入"）。
 * 本模块交付该消费者及其**撤回/注销撤销在途**的接口（`createEgressRevoker`，见 in-flight.mjs），
 * 使接线方可以注入消费者后**撤掉**那条 fail-closed 兜底，而不是伪造取消成功。
 *
 * ## 派发顺序（为什么先 markSent 再 send）
 * `dispatch` 的第一跳是账本 `markSent`：它在**同一个同步临界区**内重读账号身份/auth_epoch、
 * 全部必需用途 epoch、接收方版本与训练/删除条款，全部一致才把 reserved→sent。
 * 因此「无授权／错用途／已撤回／已注销」的请求会在**任何网络动作之前**被拒 ⇒ 零外发。
 * 真正的外部请求发生在临界区之外（账本口径：派发 at-least-once，外部调用无法与本地事务绑定）。
 *
 * ## 本模块不做什么
 * - 不做 7／30 日删除集成（GY-I19）；
 * - 不注册 HTTP 路由（`/me/exports` 等 operationId 的装配属接线方）；
 * - 不实际连接任何第三方（本片未获真实外发授权）。
 */
import { EXPORT_OBJECT_ID_MAX, EXPORT_OBJECT_TYPES, EXPORT_STATES } from './constants.mjs';
import { PrivacyError } from './errors.mjs';
import { redactForLog } from './redact.mjs';

/** 契约 states.ExecutionMode（消费者模式与执行模式同集合）。 */
export const EGRESS_MODES = Object.freeze(['real', 'stub', 'preset_demo']);

/** 替身标签（必须出现在回执/日志里，避免被误读为真实外发）。 */
export const STUB_EGRESS_LABEL = '替身外发消费者（stub：不发起任何真实第三方请求）';
export const PRESET_DEMO_EGRESS_LABEL = '预设演示外发消费者（preset_demo：不发起任何真实第三方请求）';

/** real 模式未接真实适配器时的如实说明（进回执/日志，不含凭据）。 */
export const REAL_EGRESS_UNWIRED_NOTE =
  '真实外发适配器尚未接入：real 模式 fail-closed（PROVIDER_UNAVAILABLE / 503 / retryable=false），不回退替身';

/** real 模式启用真实外发的唯一开关（必须由接线方显式放行）。 */
export const REAL_EGRESS_APPROVAL_REQUIRED =
  'real 模式的真实外发须显式放行（realTransportApproved=true）并注入已审真实适配器';

function assertExecutionMode(executionMode) {
  if (!EGRESS_MODES.includes(executionMode)) {
    throw new Error(`未知执行模式：${executionMode}（允许 ${EGRESS_MODES.join(' / ')}）`);
  }
}

/**
 * 确定性替身传输（`stub` / `preset_demo`）。
 *
 * **不发起任何网络请求、不产生任何费用**：只在进程内登记派发元数据。
 * 登记内容刻意**不含私有负载**（正文/图片/音频/坐标一律不入登记，见 `send`）——
 * 替身本身也不得成为私有内容的落点。
 */
export function createStubEgressTransport({ executionMode = 'stub' } = {}) {
  if (executionMode !== 'stub' && executionMode !== 'preset_demo') {
    throw new Error(`替身传输只允许 stub / preset_demo，实际：${executionMode}`);
  }
  const isDemo = executionMode === 'preset_demo';
  /** @type {Array<object>} 只登记元数据，不含负载 */
  const deliveries = [];
  return Object.freeze({
    kind: executionMode,
    stub: true,
    available: true,
    label: isDemo ? PRESET_DEMO_EGRESS_LABEL : STUB_EGRESS_LABEL,
    note: '替身：仅在本进程内登记派发元数据，不发起任何真实第三方请求，不产生任何费用',
    unavailableReason: null,
    /** 断言「零调用」用的登记（内容为元数据，非私有负载）。 */
    deliveries,
    async send(entry) {
      deliveries.push(
        Object.freeze({
          exportId: entry.exportId,
          purpose: entry.purpose,
          recipientId: entry.recipientId,
          sourceVersion: entry.sourceVersion ?? null,
          objectRef: Object.freeze({ ...(entry.objectRef ?? {}) }),
        }),
      );
      return Object.freeze({
        outcome: 'delivered',
        transportRef: `stub-egress-${executionMode}-${deliveries.length}`,
        note: '替身外发回执：未发生真实第三方请求',
      });
    },
  });
}

/**
 * 真实传输（`real`）。**fail-closed**：
 * - 未注入已审适配器（或未显式放行）⇒ `available=false`，消费者在**任何账本变更之前**
 *   抛 `PROVIDER_UNAVAILABLE`（503、`retryable: false`（未接线＝能力未装配，需运维接线；口径见 services/api/src/errors.ts 的 ApiError 注释）），**不返回成功封套**；
 * - 即使注入了适配器，`createEgressConsumer` 仍要求 `transport.kind === 'real'` 且显式放行，
 *   替身**不可能**出现在 real 路径上（构造期即拒绝）。
 */
export function createRealEgressTransport({ adapter = null } = {}) {
  const wired = adapter !== null && adapter !== undefined && typeof adapter.send === 'function';
  return Object.freeze({
    kind: 'real',
    stub: false,
    available: wired,
    label: wired ? '真实外发消费者（真实适配器已注入并显式放行）' : '真实外发消费者（未接线）',
    note: wired ? '真实外发适配器已注入并显式放行' : REAL_EGRESS_UNWIRED_NOTE,
    unavailableReason: wired ? null : REAL_EGRESS_UNWIRED_NOTE,
    async send(entry) {
      if (!wired) {
        // 真实外发适配器／传输未接线：retryable 必须为 false（口径见 services/api/src/errors.ts 的 ApiError 注释）。
        throw new PrivacyError('PROVIDER_UNAVAILABLE', REAL_EGRESS_UNWIRED_NOTE, { retryable: false });
      }
      return adapter.send(entry);
    },
  });
}

/**
 * 按执行模式解析传输。
 *
 * - `real`：**只有**「显式放行 + 已注入真实传输」才使用真实适配器；否则返回 fail-closed 的真实
 *   占位（`available=false`）。**不存在**"real 模式回退替身"的分支。
 * - `stub` / `preset_demo`：返回明确标注的替身；注入真实传输一律**构造期拒绝**
 *   （避免以真实外发污染替身/演示证据）。
 */
export function resolveEgressTransport({ executionMode, realTransport = null, realTransportApproved = false } = {}) {
  assertExecutionMode(executionMode);
  if (executionMode === 'real') {
    if (realTransportApproved === true && realTransport) return realTransport;
    return createRealEgressTransport();
  }
  if (realTransportApproved === true || realTransport) {
    throw new Error(`非 real 模式（${executionMode}）不得注入真实外发传输：${REAL_EGRESS_APPROVAL_REQUIRED}`);
  }
  return createStubEgressTransport({ executionMode });
}

function assertTransport(transport, executionMode) {
  if (!transport || typeof transport !== 'object') {
    throw new Error('createEgressConsumer 需要注入外发传输（transport）');
  }
  if (typeof transport.send !== 'function') {
    throw new Error('外发传输必须实现 send(entry)');
  }
  if (transport.kind !== executionMode) {
    throw new Error(
      `外发传输模式与执行模式不一致：transport.kind=${transport.kind}，executionMode=${executionMode}` +
        '（替身不得冒充真实，真实不得出现在替身/演示模式）',
    );
  }
  if (typeof transport.label !== 'string' || transport.label.trim().length === 0) {
    throw new Error('外发传输必须带非空 label（如实标注真实/替身）');
  }
  if (typeof transport.available !== 'boolean') {
    throw new Error('外发传输必须显式声明 available（布尔），不得靠缺省推断');
  }
}

/**
 * 创建外发消费者。
 *
 * @param {{
 *   ledger: object,
 *   transport: object,
 *   executionMode: 'real'|'stub'|'preset_demo',
 *   logSink?: ((entry: object) => void) | null,
 *   now?: () => Date,
 * }} deps
 */
export function createEgressConsumer({ ledger, transport, executionMode, logSink = null, now = () => new Date() } = {}) {
  assertExecutionMode(executionMode);
  for (const method of ['reserve', 'get', 'markSent', 'markFailed', 'markOutcomeUnknown']) {
    if (!ledger || typeof ledger[method] !== 'function') {
      throw new Error(`createEgressConsumer 需要账本提供 ${method}()`);
    }
  }
  assertTransport(transport, executionMode);
  if (logSink !== null && typeof logSink !== 'function') {
    throw new Error('logSink 必须为函数或 null');
  }

  /** @type {Array<object>} 审计轨迹（已脱敏；不含私有负载） */
  const auditEntries = [];
  /** 同步重入保护：同一 exportId 在派发过程中不得被并发派发两次。 */
  const dispatching = new Set();

  function recordAudit(entry) {
    const safe = Object.freeze(
      redactForLog({
        at: now().toISOString(),
        exportId: entry.exportId ?? null,
        userId: entry.userId ?? null,
        purpose: entry.purpose ?? null,
        recipientId: entry.recipientId ?? null,
        sourceVersion: entry.sourceVersion ?? null,
        state: entry.state ?? null,
        errorCode: entry.errorCode ?? null,
      }),
    );
    auditEntries.push(safe);
    if (logSink) logSink(safe);
    return safe;
  }

  /** fail-closed：未接真实依赖时在**任何账本变更之前**拒绝。 */
  function assertTransportAvailable() {
    if (transport.available !== true) {
      throw new PrivacyError(
        'PROVIDER_UNAVAILABLE',
        transport.unavailableReason ?? REAL_EGRESS_UNWIRED_NOTE,
        // 真实外发适配器／传输未接线：retryable 必须为 false（口径见 services/api/src/errors.ts 的 ApiError 注释）。
        { retryable: false },
      );
    }
  }

  /** 预留外发（授权/用途/账号/接收方不满足即在账本处被拒，不产生任何外发）。 */
  function reserve(input) {
    return ledger.reserve(input);
  }

  /**
   * 预留并派发（真实消费者入口）。
   *
   * `transport.available !== true`（real 未接真实依赖）⇒ `PROVIDER_UNAVAILABLE`(503, retryable)，
   * **连预留都不发生**（零账本变更、零外发）。
   * 无授权／错用途／缺身份版本 ⇒ 在 `reserve` 即被拒（**零外发**）；
   * 授权通过但派发前被撤回/注销 ⇒ 在 `markSent` 的原子临界区被拒（**零外发**）。
   */
  async function send({ identity, payload, ...rest } = {}) {
    if (!identity || typeof identity.userId !== 'string' || identity.userId.length === 0) {
      throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
    }
    // fail-closed 前置：未接真实依赖时**连预留都不做**（零账本变更、零外发）。
    assertTransportAvailable();
    const record = await ledger.reserve({ ...rest, userId: identity.userId, authEpoch: identity.authEpoch });
    return dispatch({ exportId: record.id, userId: identity.userId, payload });
  }

  /**
   * 派发一条**已预留**的外发记录。
   *
   * 顺序即安全保证：
   *  1. `transport.available !== true` ⇒ `PROVIDER_UNAVAILABLE`(503, retryable)，**账本零变更、零外发**；
   *  2. 记录必须为 `reserved` 且归属相符（`sent`/`failed`/`outcome_unknown` ⇒ 拒绝，杜绝重复外发）；
   *  3. `ledger.markSent` —— 唯一的权威授权边界（同步原子重查身份/用途/接收方）；被拒 ⇒ **零外发**；
   *  4. `transport.send` —— 真正的外部请求（临界区之外）；
   *  5. 外部失败 ⇒ 账本落 `failed` / `outcome_unknown`，**绝不**写成成功，并按契约抛错。
   */
  async function dispatch({ exportId, userId, payload } = {}) {
    if (typeof exportId !== 'string' || exportId.length === 0) {
      throw new PrivacyError('INVALID_REQUEST', 'exportId 缺失');
    }
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
    }
    assertTransportAvailable();
    if (dispatching.has(exportId)) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '该外发正在派发中，禁止重复外发');
    }
    // 账本读取统一 await：内存账本的 get 是同步的（await 非 Promise 值即原值），
    // PostgreSQL 账本的 get 返回 Promise —— 二者行为一致，守卫/消费者只需一套实现。
    const record = await ledger.get(exportId);
    if (!record || record.userId !== userId) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '外发记录不存在或归属不符');
    }
    if (record.state !== 'reserved') {
      throw new PrivacyError('OBJECT_UNAVAILABLE', `外发记录非预留态（${record.state}），禁止重复外发`);
    }

    dispatching.add(exportId);
    try {
      // 权威授权边界：撤回/注销/接收方变化都在此处被同步重读捕获（零外发）。
      const sent = await ledger.markSent(exportId);

      let receipt;
      try {
        receipt = await transport.send({
          exportId,
          userId,
          purpose: sent.purpose,
          recipientId: sent.recipientId,
          sourceVersion: sent.sourceVersion ?? null,
          objectRef: { type: sent.objectType, id: sent.objectId, revision: sent.objectRevision },
          payload,
        });
      } catch (error) {
        const outcomeUnknown = error instanceof PrivacyError && error.code === 'PROVIDER_OUTCOME_UNKNOWN';
        const code = outcomeUnknown ? 'PROVIDER_OUTCOME_UNKNOWN' : 'PROVIDER_UNAVAILABLE';
        try {
          if (outcomeUnknown) await ledger.markOutcomeUnknown(exportId, { errorCode: code });
          else await ledger.markFailed(exportId, { errorCode: code });
        } catch {
          // 记录已是终态（例如派发期间被撤回）：不覆盖既有结论。
        }
        recordAudit({
          exportId,
          userId,
          purpose: sent.purpose,
          recipientId: sent.recipientId,
          sourceVersion: sent.sourceVersion ?? null,
          state: outcomeUnknown ? 'outcome_unknown' : 'failed',
          errorCode: code,
        });
        throw new PrivacyError(code, '外发未取得可确认的成功结果', { retryable: !outcomeUnknown });
      }

      recordAudit({
        exportId,
        userId,
        purpose: sent.purpose,
        recipientId: sent.recipientId,
        sourceVersion: sent.sourceVersion ?? null,
        state: 'sent',
      });
      return Object.freeze({
        exportId,
        userId,
        state: 'sent',
        sentAt: sent.sentAt,
        egress: Object.freeze({
          kind: transport.kind,
          stub: transport.stub === true,
          label: transport.label,
          transportRef: receipt?.transportRef ?? null,
        }),
        note: receipt?.note ?? transport.note ?? null,
      });
    } finally {
      dispatching.delete(exportId);
    }
  }

  return Object.freeze({
    executionMode,
    transportKind: transport.kind,
    available: transport.available === true,
    label: transport.label,
    note: transport.note ?? null,
    unavailableReason: transport.unavailableReason ?? null,
    reserve,
    send,
    dispatch,
    /** 审计轨迹（只读副本；已脱敏、不含私有负载）。 */
    audit: () => auditEntries.map((entry) => ({ ...entry })),
  });
}

/**
 * 账本记录 → 契约 `Export`（openapi.json components.schemas.Export）。
 *
 * 形状不符（枚举/编号/时间非法）⇒ `PROVIDER_UNAVAILABLE`：宁可报服务不可用，
 * 也不输出一个**自相矛盾**的账本条目（与 services/api 的 PG 读取层同口径）。
 *
 * `object_ref` 的判据（GY-R35）：`objectType` 必须落在 `EXPORT_OBJECT_TYPES`（= 契约
 * `TargetRef.type` 的 16 值闭集）、`objectId` 长度为 `1..EXPORT_OBJECT_ID_MAX`（= `TargetRef.id`
 * 的 `minLength`/`maxLength`）。这两条是**读面最后一道闸门**：写入侧已改成只产出契约取值
 * （`conversation` / 六值正文类型，键为裸 id ≤ 80），历史行由迁移 0040 回填；这里若放行
 * 闭集外的值，`/me/exports` 就会继续吐出契约校验不过的条目。
 */
export function toContractExport(record) {
  if (!record || typeof record !== 'object') {
    throw new PrivacyError('PROVIDER_UNAVAILABLE', '外发账本记录不可用');
  }
  const revision = Number(record.objectRevision);
  const consentEpoch = Number(record.consentEpoch);
  const state = String(record.state);
  const sentAt = record.sentAt === null || record.sentAt === undefined ? null : new Date(record.sentAt);
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    typeof record.objectType !== 'string' ||
    !EXPORT_OBJECT_TYPES.includes(record.objectType) ||
    typeof record.objectId !== 'string' ||
    record.objectId.length < 1 ||
    record.objectId.length > EXPORT_OBJECT_ID_MAX ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isSafeInteger(consentEpoch) ||
    consentEpoch < 1 ||
    !EXPORT_STATES.includes(state) ||
    typeof record.recipientId !== 'string' ||
    record.recipientId.length < 1 ||
    record.recipientId.length > 80 ||
    (sentAt !== null && !Number.isFinite(sentAt.getTime()))
  ) {
    throw new PrivacyError('PROVIDER_UNAVAILABLE', '外发账本记录不可用');
  }
  return {
    id: record.id,
    object_ref: { type: record.objectType, id: record.objectId, revision },
    purpose: String(record.purpose),
    recipient_id: record.recipientId,
    consent_epoch: consentEpoch,
    state,
    sent_at: sentAt === null ? null : sentAt.toISOString(),
    deletion_state: String(record.deletionState ?? 'not_requested'),
  };
}

/**
 * 可查、可追溯的账本读面（契约 `ExportPage`：`{ items, next_cursor }`）。
 * 只读、按用户隔离；游标由账本 `list()` 提供（越界/畸形游标 ⇒ `INVALID_CURSOR`）。
 */
export async function listExportsForUser(ledger, { userId, limit = 50, cursor = null } = {}) {
  if (!ledger || typeof ledger.list !== 'function') {
    throw new Error('账本未提供 list 查询能力：账本读面不可用（不得静默返回空页）');
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
  }
  // 同 `dispatch`：账本访问统一 await（同步实现零成本，持久实现正确等待）。
  const page = await ledger.list({ userId, limit, cursor });
  return {
    items: page.items.map(toContractExport),
    next_cursor: page.nextCursor ?? null,
  };
}
