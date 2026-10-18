/**
 * GY-I18 · 全局功能开关的**跨端点真实生效**层（`Refs #18`）。
 *
 * ## 这一层解决什么
 * 阶段 1b（#101）只把开关**存起来**（`store.ts` 的 `flags` 表 + `setFlag`），
 * 契约面能读能写，但**没有任何输出面消费它** —— 也就是说开关是装饰性的：
 * `listFlags` 说"药剂输出已关闭"，而 `/herbicides` 照常产出。
 * 本模块把开关变成**真实生效**：受控输出面在自己的请求路径上读**当前**开关状态，
 * 关闭即拒绝、且**不产出**任何可执行建议/用量卡。
 *
 * ## 三条口径（逐条对应派单要求）
 * 1. **关闭 ⇒ 拒绝且不产出**：判定发生在**调用被包装的产出方之前**（装饰器短路），
 *    因此关闭态下产出方一次都不会被调用（测试用调用计数器钉住"零产出"）。
 *    错误码取契约闭集里的 `OBJECT_UNAVAILABLE`(409)：这是**确定性的关闭**，不是暂时故障，
 *    所以 `retryable:false`，不给调用方"重试就会好"的错觉。
 * 2. **未识别取值 ⇒ fail-closed**：开关行缺失、`enabled` 不是布尔、`key` 不在契约闭集、
 *    或读取本身抛错，一律按"不可识别"处理 ⇒ `PROVIDER_UNAVAILABLE`(503, retryable) 拒绝。
 *    **绝不**把"读不到"当成"开着"（那才是 fail-open）。
 * 3. **开关不改变适用判定结论**：本层只决定"是否产出"，不参与、也不改写任何适用性/有效性
 *    判定；被包装的判定函数在开关**开着**时收到的入参与返回值逐字节不变
 *    （`tests/unit/admin-flag-gate.test.mjs` 的不变量用例）。
 *
 * ## 为什么用「装饰 + 守卫包装」而不是改别人的文件
 * 受控面分属不同线（`/herbicides` 属 #7、`/posts` 属 #15、识别/OCR/转写/合成属 #9/#10/#11/#13）。
 * 本片**不改**这些线的实现文件，只在**装配层**（`app.ts`）把它们的守卫链与产出方包一层：
 * - HTTP 面：`createFlagGatedGuards()` 包装 `AuthGuards.requireUser`，**先鉴权、后判开关**
 *   （顺序刻意如此：401/403 语义与错误码次序与接线前逐字相同，开关只在**已鉴权**后生效）。
 *   合并 `upstream/main`（#148 社区 HTTP 装配）后，投稿/评论两条 POST 也走同一条 HTTP 面
 *   （`app.ts` 把 `gatedGuards` 传给 `registerCommunityRoutes`）。
 * - 服务层兜底：`gateCommunityService()` 返回投稿面**装饰副本**（关闭时产出方零调用、零落库），
 *   供只在服务层消费社区服务的场景按同一口径判定。
 *
 * ## 如实声明的边界
 * - **real 执行模式**：后台域整体 fail-closed（`fail-closed-services.ts`），开关因此**没有权威来源**。
 *   本层在这种模式下 `armed:false`：**保持既有产出行为**，不拿一个未接线的开关去中断用户面。
 *   这是装配层的显式决定（见 `app.ts`），并作为"未取得项"记入证据页；
 *   一旦后台域接上真实持久存储并解除 fail-closed，开关在 real 模式下即为权威。
 * - **合并增量口径**：`upstream/main` 新装配的受控面按**同一原口径**纳入 ——
 *   判据是"该 operationId 是否已登记在本清单里"（清单＝契约镜像，早已含 `createPost`/`createComment`），
 *   并只把装配基线对齐到"该面真的在产出"；**不新增受控面、不改清单**。
 * - 受控面清单（`FLAG_GATED_SURFACES`）是契约的**镜像**，由
 *   `tests/unit/admin-flag-gate.test.mjs` 对着 `packages/contracts/operations.json` 逐条比对，防漂移。
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AuthGuards } from '../../auth/middleware.ts';
import { API_PREFIX } from '../../contract.ts';
import { ApiError } from '../../errors.ts';
import { CONTRACT_FLAG_KEYS } from './flags.ts';
import type { FlagKey } from './flags.ts';

/** 开关行的**可选**形状（来自 `ops/store.ts` 的 `getFlag`）。 */
export interface FlagRecordLike {
  key: string;
  enabled: boolean;
  revision: number;
}

/**
 * fail-closed 的**原因**：决定 503 的 `retryable`（口径原文见 `services/api/src/errors.ts` 的
 * `ApiError` 注释）。四类失败原先被折叠成同一个 `null` ⇒ 无法为 `retryable: true` 给出具体机制，
 * 故这里把原因显式建模出来（**additive**：不新增契约词表，`details.code` 仍是 `FLAG_UNRECOGNIZED`）。
 *
 * - `read_error`：开关存储的**读取本身抛错**（连接抖动 / 超时 / 存储短暂不可用）—— 没有任何人
 *   改过配置，同一请求稍后重试**可能**成功 ⇒ `retryable: true`（真瞬时，机制可命名）。
 * - `unrecognized`：读到的东西**形状不合法**（整行缺失 / `enabled` 非布尔 / `key` 不在契约闭集 /
 *   `revision` 非法）—— 这是配置或数据事故，**需运维修复**后同一请求才会成功 ⇒ `retryable: false`。
 */
export type FlagGateFailCause = 'read_error' | 'unrecognized';

/** 带原因的读取结果：`ok` ⇒ 记录；`fail` ⇒ 原因（**不丢原因**，供 `retryable` 判定）。 */
export type FlagReadOutcome =
  | { readonly kind: 'ok'; readonly record: FlagRecordLike }
  | { readonly kind: 'fail'; readonly cause: FlagGateFailCause };

/** 按原因取 `retryable`（唯一判据，勿在调用点各写一套）。 */
export function failClosedRetryableFor(cause: FlagGateFailCause): boolean {
  return cause === 'read_error';
}

/**
 * 开关读取口。`read()` 把"不可识别"显式建模成 `null`：
 * 调用方无法把 `null` 误当成 `false`（关闭）或 `true`（开启）——两者都必须经 `valueOf()` 判定。
 */
export interface FlagReader {
  /** 已识别 ⇒ 记录；缺失 / 形状非法 / key 越界 / 读取抛错 ⇒ `null`（fail-closed）。 */
  read(key: FlagKey): FlagRecordLike | null;
  /** 已识别 ⇒ 布尔值；不可识别 ⇒ `null`。 */
  valueOf(key: FlagKey): boolean | null;
  /**
   * **可选**：带原因读取（`read()` 的加强版，两者必须同源）。缺省时判定层按 `unrecognized`
   * 处理 —— 宁可声明"确定性故障"（不置 `retryable`），也不空口声称"稍后重试会成功"。
   */
  readWithCause?(key: FlagKey): FlagReadOutcome;
}

function recognizeOutcome(raw: unknown): FlagReadOutcome {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'fail', cause: 'unrecognized' };
  const record = raw as Record<string, unknown>;
  // key 必须是契约闭集成员（闭集外的行一律不认，避免"库里多了个键"被当成有效状态）。
  if (typeof record.key !== 'string' || !(CONTRACT_FLAG_KEYS as readonly string[]).includes(record.key)) {
    return { kind: 'fail', cause: 'unrecognized' };
  }
  if (typeof record.enabled !== 'boolean') return { kind: 'fail', cause: 'unrecognized' };
  if (!Number.isInteger(record.revision) || (record.revision as number) < 1) {
    return { kind: 'fail', cause: 'unrecognized' };
  }
  return { kind: 'ok', record: { key: record.key, enabled: record.enabled, revision: record.revision as number } };
}

/** 由后台开关存储构造读取口（只依赖 `getFlag` 一个方法，便于测试注入畸形实现）。 */
export function createStoreFlagReader(source: { getFlag(key: FlagKey): unknown }): FlagReader {
  const readWithCause = (key: FlagKey): FlagReadOutcome => {
    try {
      return recognizeOutcome(source.getFlag(key));
    } catch {
      // 读取抛错 = 存储层**瞬时**故障（连接抖动/超时），fail-closed 但可重试：**不**当成开启。
      return { kind: 'fail', cause: 'read_error' };
    }
  };
  const read = (key: FlagKey): FlagRecordLike | null => {
    const outcome = readWithCause(key);
    return outcome.kind === 'ok' ? outcome.record : null;
  };
  return {
    read,
    readWithCause,
    valueOf(key) {
      const record = read(key);
      return record === null ? null : record.enabled;
    },
  };
}

/**
 * 真实 PG 端口读取口（GY-I18 接线）：**同步快照 + 判定前异步预取**。
 *
 * ## 为什么不是异步读取口
 * `FlagReader` 的读取/判定接口是**同步**的（`assertSurfaceOpen` 在既有单测里被同步直接调用，
 * 且守卫 `requireUser` 的语义要求"判定是纯内存操作"）。端口只有异步 `list()`，因此不在判定
 * 路径上等数据库，而是：`prepare()` 在**进入受控路由的守卫时**刷新一次快照，判定读快照。
 *
 * ## fail-closed 口径（与内存读取口逐字同源）
 * - 从未成功预取 ⇒ `unrecognized`（装配 bug，需修）；
 * - 预取抛错 ⇒ `read_error`（瞬时，可重试），且**丢掉旧快照**：库不可用时不拿过期的「开」放行；
 * - 行缺失 ⇒ `unrecognized`（缺行不是关，更不是开）；
 * - 形状非法（key 越界/非布尔/revision 非法）⇒ `unrecognized`；重复 key 同理。
 */
export interface PortFlagReader extends FlagReader {
  /** 重新从端口读一次快照；**不抛**（失败通过 `readWithCause` 的可重试原因体现）。 */
  refresh(): Promise<void>;
}

/** 由端口构造读取口（`list()` 每行按 `recognizeOutcome` 同一套形状规则校验）。 */
export function createPortFlagReader(port: {
  list(): Promise<readonly FlagRecordLike[]>;
}): PortFlagReader {
  let snapshot: ReadonlyMap<string, FlagRecordLike> | null = null;
  let lastFailure: FlagGateFailCause = 'unrecognized';
  let refreshed = false;

  async function refresh(): Promise<void> {
    try {
      const rows = await port.list();
      if (!Array.isArray(rows)) {
        snapshot = null;
        lastFailure = 'unrecognized';
        refreshed = true;
        return;
      }
      const next = new Map<string, FlagRecordLike>();
      let duplicate = false;
      for (const raw of rows) {
        const outcome = recognizeOutcome(raw);
        if (outcome.kind === 'fail') {
          snapshot = null;
          lastFailure = 'unrecognized';
          refreshed = true;
          return;
        }
        if (next.has(outcome.record.key)) duplicate = true;
        next.set(outcome.record.key, outcome.record);
      }
      if (duplicate) {
        snapshot = null;
        lastFailure = 'unrecognized';
        refreshed = true;
        return;
      }
      snapshot = next;
      lastFailure = 'unrecognized';
      refreshed = true;
    } catch {
      // 读取抛错 = 瞬时故障 ⇒ 可重试；同时**丢弃**旧快照（不拿过期状态放行）。
      snapshot = null;
      lastFailure = 'read_error';
      refreshed = true;
    }
  }

  const readWithCause = (key: FlagKey): FlagReadOutcome => {
    if (!refreshed) return { kind: 'fail', cause: 'unrecognized' };
    if (snapshot === null) return { kind: 'fail', cause: lastFailure };
    const record = snapshot.get(key);
    if (record === undefined) return { kind: 'fail', cause: 'unrecognized' };
    return { kind: 'ok', record };
  };
  const read = (key: FlagKey): FlagRecordLike | null => {
    const outcome = readWithCause(key);
    return outcome.kind === 'ok' ? outcome.record : null;
  };
  return {
    refresh,
    read,
    readWithCause,
    valueOf(key) {
      const record = read(key);
      return record === null ? null : record.enabled;
    },
  };
}

/**
 * 受控输出面（契约镜像）。
 *
 * `routePattern` 与 Fastify 的 `request.routeOptions.url` 同形（参数写 `:id`），
 * 与 `packages/contracts/openapi.json` 的 `paths` 一一对应（`{id}` ⇒ `:id`）。
 */
export interface FlagGatedSurface {
  readonly key: FlagKey;
  readonly operationId: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly routePattern: string;
  /** 人可读的输出面名称（出现在拒绝消息里，说明"是哪一面被关掉了"）。 */
  readonly surface: string;
}

export const FLAG_GATED_SURFACES: readonly FlagGatedSurface[] = Object.freeze([
  Object.freeze({
    key: 'specific_herbicide_output_enabled',
    operationId: 'listHerbicides',
    method: 'GET',
    routePattern: `${API_PREFIX}/herbicides`,
    surface: '除草剂登记制剂列表输出',
  }),
  Object.freeze({
    key: 'specific_herbicide_output_enabled',
    operationId: 'getHerbicide',
    method: 'GET',
    routePattern: `${API_PREFIX}/herbicides/:id`,
    surface: '除草剂制剂详情输出',
  }),
  Object.freeze({
    key: 'submissions_enabled',
    operationId: 'createPost',
    method: 'POST',
    routePattern: `${API_PREFIX}/posts`,
    surface: '社区投稿受理',
  }),
  Object.freeze({
    key: 'submissions_enabled',
    operationId: 'createComment',
    method: 'POST',
    routePattern: `${API_PREFIX}/posts/:id/comments`,
    surface: '社区评论投稿受理',
  }),
  Object.freeze({
    key: 'ai_enabled',
    operationId: 'createRecognition',
    method: 'POST',
    routePattern: `${API_PREFIX}/recognitions`,
    surface: '识别任务受理',
  }),
  Object.freeze({
    key: 'ai_enabled',
    operationId: 'createOCR',
    method: 'POST',
    routePattern: `${API_PREFIX}/ocr`,
    surface: '标签 OCR 任务受理',
  }),
  Object.freeze({
    key: 'ai_enabled',
    operationId: 'createTranscription',
    method: 'POST',
    routePattern: `${API_PREFIX}/speech/transcriptions`,
    surface: '语音转写任务受理',
  }),
  Object.freeze({
    key: 'ai_enabled',
    operationId: 'createSynthesis',
    method: 'POST',
    routePattern: `${API_PREFIX}/speech/synthesis`,
    surface: '语音合成任务受理',
  }),
]);

/**
 * 装配基线的**唯一来源**：把「开关」与「该输出面当前是否真的在产出」对齐。
 *
 * 为什么需要它：阶段 1b 的出厂默认是 3 键全 `false`（最严格一侧），而 `/herbicides`、
 * 识别/OCR/转写/合成受理面在当前装配下是**真实可用**的。若把"默认 false"直接接到门上，
 * 结果不是更安全，而是**接口自述与产出现实不一致**（`listFlags` 说关闭、`/herbicides` 照常产出），
 * 也就是开关根本没生效 —— 正是本片要修的问题。
 *
 * 因此装配层用本基线**显式播种**（`flagSeedFromBaseline()`），使：
 * - 开关的读取值与输出面的真实状态一致；
 * - 后台一旦用 `setFlag` 改变取值（revision ≥ 2），该值即为权威（关 ⇒ 拒绝，开 ⇒ 产出）；
 * - 服务层工厂 `createAdminOpsStore()`（不播种）的出厂默认**仍是全 false**，
 *   由单测钉住（那个默认用于"未接线的领域服务"，不用于本进程的输出面）。
 */
export const FLAG_WIRING_BASELINE: Readonly<Record<FlagKey, boolean>> = Object.freeze({
  /**
   * 社区投稿/评论面（`POST /posts`、`POST /posts/:id/comments`）**已由 #148 装配真实路由**
   * （合并 `upstream/main` 后复核：`registerCommunityRoutes` 是唯一注册点）⇒ 该输出面当前**真实可用**，
   * 基线因此为开启；后台一键关闭即拒绝新投稿（且不落任何内容行）。
   * 合并口径：新装配的受控面**按同一原口径纳入**（清单里的 `createPost`/`createComment` 早已登记，
   * 无需改清单、也未新增受控面），只把基线对齐到"该面真的在产出"。
   */
  submissions_enabled: true,
  /** 药剂/制剂输出面（`/herbicides`）当前真实可用（#7 已合并）⇒ 基线开启，可由后台一键收紧。 */
  specific_herbicide_output_enabled: true,
  /** AI 任务受理面（识别/OCR/转写/合成）当前真实可用 ⇒ 基线开启，可由后台一键收紧。 */
  ai_enabled: true,
});

/** 基线 → `createAdminOpsStore({ flagSeed })` 接受的形状（revision 从 1 起，与出厂状态同构）。 */
export function flagSeedFromBaseline(
  baseline: Readonly<Record<FlagKey, boolean>> = FLAG_WIRING_BASELINE,
): { key: FlagKey; enabled: boolean; revision: number }[] {
  return CONTRACT_FLAG_KEYS.map((key) => ({ key, enabled: baseline[key], revision: 1 }));
}

/** 判定结果（**可机读**，供证据页与测试直接核对，而不是靠解析错误消息）。 */
export interface FlagGateVerdict {
  readonly state: 'open' | 'closed' | 'fail_closed';
  readonly key: FlagKey;
  readonly surface: string;
  /** 判定依据：已配置的存储值 / 无权威来源（未接线或不可识别）。 */
  readonly decidedBy: 'configured' | 'unavailable';
  readonly revision: number | null;
  /** 仅 `state === 'fail_closed'` 时给出：fail-closed 的原因（决定 503 的 `retryable`）。 */
  readonly cause?: FlagGateFailCause;
}

export interface FeatureFlagGate {
  /** `false` ⇒ 本进程不判开关（real 模式后台域未接线或开关表未就绪，见文件头边界说明）。 */
  readonly armed: boolean;
  /**
   * **可选**：判定前的异步预取（真实 PG 读取口用；内存读取口不需要）。
   * 只有 `createFlagGatedGuards` 在命中受控面且守卫通过后调用它。
   */
  readonly prepare?: () => Promise<void>;
  verdictFor(key: FlagKey, surface: string): FlagGateVerdict;
  /** 开关关闭 / 不可识别 ⇒ 抛契约错误；开启 ⇒ 静默返回。 */
  assertOpen(key: FlagKey, surface: string): void;
  /** 路由级断言：命中受控面才判（未命中的路由行为逐字节不变）。 */
  assertSurfaceOpen(method: string, routePattern: string): void;
  /** 直接对某个受控面（operationId）断言，供服务层装饰器使用。 */
  assertOperationOpen(operationId: string): void;
  /** 本层控制的全部输出面（只读副本）。 */
  surfaces(): readonly FlagGatedSurface[];
}

// 两条分流的 `retryable` 口径复核结论（依据 `services/api/src/errors.ts` 的口径原文；两者语义不同类，不得合并）：
//   · 409 `OBJECT_UNAVAILABLE`（`closedError`）= "**已识别的确定性状态**"：管理员**明确**把开关设成
//     `false` ⇒ 对象当前不可用是**有意的确定状态**，同一请求重试不会变 ⇒ `retryable: false`
//     （保留现状，省略即 false，且 `:14-15` 的注释已给出同一理由）。
//   · 503 `PROVIDER_UNAVAILABLE`（`failClosedError`）= "**当前读不出来**"：消息逐字含"**当前**取值
//     不可识别"，与"能力未装配／未接线"不同类，故不受四域统一为 false 的影响；但**四类失败不都是
//     瞬时的**，故按 `FlagGateFailCause` 拆分（扩展派单要求"真瞬时必须给出具体机制"）：
//       - `read_error`（读取抛错：存储抖动/超时）⇒ 真瞬时 ⇒ `retryable: true`；
//       - `unrecognized`（行缺失/`enabled` 非布尔/`key` 越界/`revision` 非法）= 配置或数据事故，
//         **需运维修复**后同一请求才会成功 ⇒ `retryable: false`。
function closedError(surface: string, key: FlagKey): ApiError {
  return new ApiError('OBJECT_UNAVAILABLE', `「${surface}」已被全局开关关闭（${key}=false），本输出面拒绝产出`, {
    details: [{ field: 'feature_flag', code: 'FLAG_CLOSED' }],
  });
}

function failClosedError(surface: string, key: FlagKey, cause: FlagGateFailCause): ApiError {
  // `retryable` 由原因决定，不写死：见 `FlagGateFailCause` 与上方复核结论。
  const hint =
    cause === 'read_error'
      ? '（开关存储读取失败：连接抖动/超时，稍后重试可能成功）'
      : '（开关配置或数据形状非法，需运维修复后重试才会成功）';
  return new ApiError(
    'PROVIDER_UNAVAILABLE',
    `全局开关 ${key} 的当前取值不可识别（缺失/非布尔/越界）${hint}，「${surface}」按 fail-closed 拒绝产出`,
    { retryable: failClosedRetryableFor(cause), details: [{ field: 'feature_flag', code: 'FLAG_UNRECOGNIZED' }] },
  );
}

export interface FeatureFlagGateOptions {
  readonly reader: FlagReader;
  /**
   * 是否启用开关判定。缺省 `true`。
   * 装配层在"后台域整体 fail-closed（real 未接持久存储）"时传 `false`：
   * 那时开关没有权威来源，**不**以未接线的开关拒绝用户面产出（如实声明，见文件头）。
   */
  readonly armed?: boolean;
  /**
   * **可选**：武装前的只读就绪探测（真实 PG 端口用 `featureFlagsTableReady`）。
   *
   * 语义（T-R12-08R）：`real` 且拿到池**不等于**开关可用 —— 集成测试会只应用迁移子集，
   * 库里根本没有 `public.feature_flags`。这种库上若照样武装，首个受控面请求的预取会失败并
   * 503，把与开关无关的既有面打红。因此：探测只跑一次（首次 `prepare`），返回 `true` 才继续
   * 预取与判定；返回 `false` 或抛错 ⇒ `armed` 永久降级为 `false`（行为与接线前逐字相同：
   * 不判开关、不预取、不 503）。探测错误**绝不**抛给请求路径。
   */
  readonly armingProbe?: () => Promise<boolean>;
  /**
   * **可选**：判定前的异步预取。真实 PG 读取口（`createPortFlagReader`）在这里刷新快照；
   * 内存读取口不传 ⇒ 判定路径与接线前逐字相同（纯同步）。
   */
  readonly prepare?: () => Promise<void>;
}

export function createFeatureFlagGate(options: FeatureFlagGateOptions): FeatureFlagGate {
  const reader = options.reader;
  // 武装是**运行时**状态（不再是构造期常量）：real 模式下先等只读探测，探测失败就永久未武装。
  // stub / 未接端口时没有探测，取值与构造参数逐字相同。
  let armed = options.armed ?? true;
  const armingProbe = options.armingProbe;
  const refresh = options.prepare;
  let probed = false;
  let tableReady = false;

  /**
   * 就绪探测（只跑一次）+ 预取（每次判前都刷新）。
   *
   * 探测只缓存**结果**而不是整个 promise：失败后不重试（表要么由迁移建好、要么不该本进程反复探），
   * 而预取必须逐次重试 —— 存储抖动是瞬时的，缓存一次 `read_error` 会让门永久 503。
   */
  async function ensureReady(): Promise<void> {
    if (armingProbe !== undefined && !probed) {
      try {
        tableReady = (await armingProbe()) === true;
      } catch {
        tableReady = false;
      }
      probed = true;
    }
    if (armingProbe !== undefined && !tableReady) {
      // 表不存在 ⇒ 本进程没有权威开关来源 ⇒ 退回未武装（不预取、不判、不 503）。
      armed = false;
      return;
    }
    if (refresh !== undefined) await refresh();
  }

  const prepare =
    armingProbe === undefined && refresh === undefined ? undefined : ensureReady;

  /** 带原因读取：优先用读取口的 `readWithCause`；没有则退回 `read()`（见下方注释）。 */
  function readOutcomeFor(key: FlagKey): FlagReadOutcome {
    if (typeof reader.readWithCause === 'function') return reader.readWithCause(key);
    // 自定义注入的读取口可能只有 `read()`：此时 `null` 无法区分原因 ⇒ 按 `unrecognized` 处理
    // （宁可声明"需运维修复"，也不空口声称"稍后重试会成功"）。
    const record = reader.read(key);
    return record === null ? { kind: 'fail', cause: 'unrecognized' } : { kind: 'ok', record };
  }

  function verdictFor(key: FlagKey, surface: string): FlagGateVerdict {
    if (!armed) {
      // 未接线：不判（保持既有产出）。state 仍如实报 `open`，但 decidedBy 说明"没有权威来源"。
      return { state: 'open', key, surface, decidedBy: 'unavailable', revision: null };
    }
    const outcome = readOutcomeFor(key);
    if (outcome.kind === 'fail') {
      // 原因一并带出（决定 503 的 retryable），供证据页/测试直接核对而无需解析消息。
      return {
        state: 'fail_closed',
        key,
        surface,
        decidedBy: 'unavailable',
        revision: null,
        cause: outcome.cause,
      };
    }
    const record = outcome.record;
    return {
      state: record.enabled ? 'open' : 'closed',
      key,
      surface,
      decidedBy: 'configured',
      revision: record.revision,
    };
  }

  function assertOpen(key: FlagKey, surface: string): void {
    const verdict = verdictFor(key, surface);
    if (verdict.state === 'closed') throw closedError(surface, key);
    if (verdict.state === 'fail_closed') throw failClosedError(surface, key, verdict.cause ?? 'unrecognized');
  }

  const byRoute = new Map<string, FlagGatedSurface>();
  for (const entry of FLAG_GATED_SURFACES) byRoute.set(`${entry.method} ${entry.routePattern}`, entry);
  const byOperation = new Map<string, FlagGatedSurface>();
  for (const entry of FLAG_GATED_SURFACES) byOperation.set(entry.operationId, entry);

  return {
    // 取值器而非快照：`armingProbe` 可在 `prepare()` 里把武装降级为 false，调用方（含测试与
    // 证据页）读到的必须是最新状态，否则「已降级」这件事对断言不可见。
    get armed(): boolean {
      return armed;
    },
    ...(prepare === undefined ? {} : { prepare }),
    verdictFor,
    assertOpen,
    assertSurfaceOpen(method, routePattern) {
      const entry = byRoute.get(`${method.toUpperCase()} ${routePattern}`);
      // 未命中受控面 ⇒ 不做任何判定（不得因为"没查到"而拒绝别人的路由）。
      if (entry === undefined) return;
      assertOpen(entry.key, entry.surface);
    },
    assertOperationOpen(operationId) {
      const entry = byOperation.get(operationId);
      if (entry === undefined) {
        // 未声明的 operationId 用错就是接线 bug：装配期/测试期就应暴露，不静默放行。
        throw new Error(`operationId 未在受控面清单里：${operationId}`);
      }
      assertOpen(entry.key, entry.surface);
    },
    surfaces: () => FLAG_GATED_SURFACES,
  };
}

/**
 * 把开关门接到 `AuthGuards.requireUser` 上（**不改受控面的实现文件**）。
 *
 * 顺序是这一层的安全语义，刻意写死：
 *   1. 先跑原守卫 ⇒ 未登录 401 / 会话失效 401 / 账号不可用 403 **与接线前逐字相同**；
 *   2. 守卫通过（或抛错终止）之后，才判开关 ⇒ 开关状态不会泄露给未鉴权调用方。
 *
 * `requireAdmin` / `requireScope` **原样透传**：后台自己的路由不接受本层判定。
 */
export function createFlagGatedGuards(guards: AuthGuards, gate: FeatureFlagGate): AuthGuards {
  // Fastify 的 `preHandlerHookHandler` 类型带第三个 `done` 形参（历史重载），
  // 而本仓所有守卫都是 async 且不使用 `done`：这里显式收窄成两参调用，避免把 `done` 误传。
  const innerRequireUser = guards.requireUser as unknown as (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void> | void;
  const requireUser: preHandlerHookHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    await innerRequireUser(request, reply);
    // Fastify 5：`routeOptions.url` 是已注册的路由模板（含前缀与 `:param`）。
    const route = request.routeOptions?.url ?? '';
    const method = request.method.toUpperCase();
    // 只对**受控面**预取：未命中的路由不多打一次数据库（行为与接线前逐字相同）。
    if (gate.prepare !== undefined) {
      const gated = gate.surfaces().some((entry) => entry.method === method && entry.routePattern === route);
      if (gated) await gate.prepare();
    }
    gate.assertSurfaceOpen(request.method, route);
  };
  return {
    requireUser,
    requireAdmin: guards.requireAdmin,
    requireScope: guards.requireScope,
  };
}

/** 投稿面里需要判开关的方法（`createPost` / `createComment`）。 */
export const SUBMISSION_METHODS = Object.freeze(['createPost', 'createComment'] as const);

const SUBMISSION_SURFACE: Readonly<Record<string, string>> = Object.freeze({
  createPost: '社区投稿受理',
  createComment: '社区评论投稿受理',
});

/**
 * 社区服务的**投稿面装饰副本**：只拦 `createPost` / `createComment`，其余方法原样透传。
 *
 * 为什么是装饰而不是改 `community/service.ts`：投稿面属 #15 线，本片不改其实现；
 * 同时装饰副本让"开关关闭 ⇒ 投稿**零落库**"成为可判定事实（产出方根本没被调用）。
 * 生效范围（**已更新**）：社区路由**早已装配**（app.ts 内 `registerCommunityRoutes(app,
 * config, gatedGuards, communityService)` 是唯一装配点，`routes/community.ts` 注册 16 条），
 * 投稿面因此**已经过 HTTP 闸门**——`gatedGuards` 按 (method, 路由模板) 命中本文件
 * `FLAG_GATED_SURFACES` 内两条 `submissions_enabled` 受控面（`createPost` ⇒
 * `POST /posts`、`createComment` ⇒ `POST /posts/:id/comments`），与开关 key 同源。
 * 本装饰器是**服务层**兜底：给不经 HTTP 直接调用社区服务的消费方同一口径判定；应用装配
 * 当前未调用它（装配级调用点只有 `tests/unit/admin-flag-gate.test.mjs`）—— 如实记入"未取得项"。
 */
export function gateCommunityService<T extends object>(service: T, gate: FeatureFlagGate): T {
  const source = service as unknown as Record<string, unknown>;
  const wrapped: Record<string, unknown> = { ...source };
  for (const name of SUBMISSION_METHODS) {
    const original = source[name];
    if (typeof original !== 'function') continue;
    const surface = SUBMISSION_SURFACE[name] ?? name;
    wrapped[name] = async (...args: unknown[]): Promise<unknown> => {
      gate.assertOpen('submissions_enabled', surface);
      return await (original as (...inner: unknown[]) => Promise<unknown>).apply(service, args);
    };
  }
  return Object.freeze(wrapped) as T;
}

/**
 * 产出面装饰器（通用形式）：开关关闭时**产出方一次都不会被调用**（零产出）。
 *
 * 与 `gateCommunityService` 的分工：那个是"某个社区服务的投稿方法"专用副本，
 * 这个是任意"产出方 + 显式开关 key"的通用形式，供
 * 「路由层守卫 + 服务层产出」两处都要证明"关闭 ⇒ 零产出"的场景使用。
 */
export function gateProducer<T extends object, K extends keyof T & string>(
  owner: T,
  method: K,
  gate: FeatureFlagGate,
  key: FlagKey,
  surface: string,
): T {
  const source = owner as unknown as Record<string, unknown>;
  const original = source[method];
  if (typeof original !== 'function') throw new Error(`产出面方法不存在：${method}`);
  const wrapped: Record<string, unknown> = { ...source };
  wrapped[method] = async (...args: unknown[]): Promise<unknown> => {
    gate.assertOpen(key, surface);
    return await (original as (...inner: unknown[]) => Promise<unknown>).apply(owner, args);
  };
  return Object.freeze(wrapped) as T;
}
