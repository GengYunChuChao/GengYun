/**
 * GY-R70 · 审核域真实接线的**生产入口批准通道**（有名启动开关，fail-closed）。
 *
 * 断点：`moderation/live-assembly.ts`（#777）已经有**唯一铸造点** `approveModerationLiveWiring()`
 * 与纯决定函数 `resolveModerationLiveWiring()`，`app.ts` 也已在装配点把它接上；但**全仓没有任何生产
 * 代码调用铸造点** ⇒ 今天 `real` 下审核域仍是整域 503，`#777` 的头注因此写着「本片**不**引入
 * `--approve-*` 启动开关（那属于生产入口 `server.ts` 的一次独立、可审查的变更）」。本文件补的就是那一步。
 *
 * 形状照既有先例 `media/real-ports.ts` 的 `resolveMediaRealPorts`（`server.ts` 里唯一的批准通道）：
 *   - 决定只在**启动参数**上做（`argv` 注入，纯函数）；
 *   - 通过则**在这里铸造**一次批准能力，失败则不铸造、不给默认值、不「尽力而为」。
 *
 * ⛔ 为什么 `policySource` / `bizType` **必须**从启动参数给，不能从 env 或配置文件给：
 *   `media/service.ts` 的 `RealMediaWiringApproval` 两轮对抗复审已经否掉过「配置即门控」这条路——
 *   环境变量在容器/CI 里极易被顺手带上并**长期生效**，门就退化成「环境里恰好有值」；而启动参数是
 *   一次性的、写进部署清单与进程列表就能被审出来。`tools/ai-config.mjs` 对 `moderation*` 的
 *   `policySelectionVerified` 恒 `false`、`executionAllowed` 恒 `false`，配置侧永远推不出授权。
 *   本文件因此**不读 `process.env`**（有结构用例钉住，见 `tests/unit/moderation-approval-flag.test.mjs`）。
 *
 * 四条前置**同时**成立才铸造（缺任一条 ⇒ 不铸造 ＋ 一行诊断 ＋ 调用方 `exit 1`，与
 * `--approve-real-media-wiring` 同口径：**不批准 ≠ 启动成功**）：
 *   ① 开关 `--approve-moderation-live-wiring` 给了（整串精确匹配某一项 argv）；
 *   ② 运维给的 `policySource` / `bizType` 齐备且形状合法；
 *   ③ 共享凭据齐备（`config.moderationLive.credentials`，仅 `real` 且 `TENCENTCLOUD_*` 成对时非 `null`）；
 *   ④ 配置合法（铸造后仍由 `#777` 的 `resolveModerationLiveWiring()` 复核一遍剖面/端点/超时）。
 *
 * 拒绝原因**只用 `#777` 的闭集** `MODERATION_LIVE_REFUSAL_REASONS`（`missing_approval` /
 * `missing_credentials` / `invalid_configuration`），本文件**不新造原因串**。
 *
 * ⛔ 本文件不含网络实现、不含凭据值、不读 `process.env`、不读文件、不写台账、不 `process.exit`。
 *   它只回答一个问题：这次启动要不要把一份**已铸造的**批准能力交给 `buildApp`。
 */
import {
  approveModerationLiveWiring,
  resolveModerationLiveWiring,
  type ModerationLiveRefusalReason,
  type ModerationLiveWiringApproval,
} from './live-assembly.ts';
import { MODERATION_BIZ_TYPE_PATTERN, type ModerationLiveCredentials } from './live-ports.ts';

// ---------------------------------------------------------------------------
// 1. 参数契约（闭集：一个开关 + 两个 `--name=value`）
// ---------------------------------------------------------------------------

/** 唯一的名批准开关（整串精确匹配 argv 的某一项；`--approve-moderation-live-wiring=true` 不算）。 */
export const MODERATION_LIVE_WIRING_FLAG = '--approve-moderation-live-wiring';

/** `policySource` 的参数前缀（策略**被独立核对过**的出处，非凭据；⛔ 不读 env）。 */
export const MODERATION_POLICY_SOURCE_PREFIX = '--moderation-policy-source=';

/** `bizType` 的参数前缀（**真实** BizType；⛔ 不读 env）。 */
export const MODERATION_BIZ_TYPE_PREFIX = '--moderation-biz-type=';

/**
 * `policySource` 的形状：3–120 位的策略标识（首字符字母/数字，其后字母/数字与 `._:/@+-`）。
 *
 * 上限 120 与 `live-ports.ts` 的 `assertModerationPolicyOpen`（`source.length > 120` 即构造硬拒）
 * **同口径**：这里先挡一次，免得铸出来的批准能力在构造期才被拒。
 * ⛔ 不做 `trim()`：`" x "` 这种带空白的手误必须被挡，而不是被静默修好。
 * ⚠️ 形状合法**不等于**「策略真的被独立核对过」——这只是一次可审查的运维声明（见证据页「没证明什么」）。
 */
export const MODERATION_POLICY_SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{2,119}$/;

/** 单个 `--name=value` 的读取结果（`absent` 与「给了但值不合法」是**两种**不同的拒绝）。 */
interface FlagValue {
  readonly state: 'absent' | 'invalid' | 'value';
  readonly value: string | null;
}

/**
 * 读一个 `--name=value`：只认**整串**前缀；同值重复出现视为一次；空串/异值重复/裸参数名 ⇒ `invalid`。
 *
 * 「裸参数名」（`--moderation-policy-source` 后面不带 `=`）按 `invalid` 处理而不是 `absent`：
 * 运维显然想给这个值，只是写法错了，静默当成"没给"会让人以为门是关着的那一边。
 */
function readFlagValue(argv: readonly string[], prefix: string): FlagValue {
  const bare = prefix.slice(0, -1);
  const values = argv.filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
  if (values.length === 0) return { state: argv.includes(bare) ? 'invalid' : 'absent', value: null };
  const unique = new Set(values);
  if (unique.size !== 1) return { state: 'invalid', value: null };
  const value = values[0];
  if (value === undefined || value === '') return { state: 'invalid', value: null };
  return { state: 'value', value };
}

/** 解析结果（纯读数；不判定"该不该铸造"，那在 {@link resolveModerationStartupApproval}）。 */
export interface ModerationStartupArgs {
  /** 开关是否给了（整串精确匹配）。 */
  readonly flagPresent: boolean;
  readonly policySource: FlagValue;
  readonly bizType: FlagValue;
}

/** 解析启动参数（**纯函数**：只读传入的 `argv`，不读 `process.argv`、不读 env、不碰网络）。 */
export function parseModerationStartupArgs(argv: readonly string[]): ModerationStartupArgs {
  return {
    flagPresent: argv.includes(MODERATION_LIVE_WIRING_FLAG),
    policySource: readFlagValue(argv, MODERATION_POLICY_SOURCE_PREFIX),
    bizType: readFlagValue(argv, MODERATION_BIZ_TYPE_PREFIX),
  };
}

// ---------------------------------------------------------------------------
// 2. 决定点（唯一铸造点：本文件内的 approveModerationLiveWiring 调用）
// ---------------------------------------------------------------------------

/** 启动期只需要配置面的两个事实（结构类型：不反向依赖 `config.ts`，与 `media/real-ports.ts` 同风格）。 */
export interface ModerationStartupConfig {
  readonly executionMode: string;
  /** `config.moderationLive`：仅 `real` 且共享凭据成对时非 `null`。 */
  readonly moderationLive?: { readonly credentials?: unknown } | null;
}

/** 决定读数。全部字段都是安全标量：不含凭据、不含异常文本、不含配置值。 */
export interface ModerationStartupApprovalPlan {
  /** 铸造出来的批准能力（身份由 `live-assembly.ts` 的 `WeakSet` 判定）；`null` ⇒ 一个都不传。 */
  readonly liveApproval: ModerationLiveWiringApproval | null;
  /** **是否真的调用过**铸造点（「不铸造」是可断言的读数，不是靠"没看见日志"推断的）。 */
  readonly minted: boolean;
  /** 闭集拒绝原因（`#777` 的 `MODERATION_LIVE_REFUSAL_REASONS`）；`null` = 没有拒绝。 */
  readonly reason: ModerationLiveRefusalReason | null;
  /**
   * **是否启动失败**（`server.ts` 据此 `exit 1`）。
   *
   * 口径与 `--approve-real-media-wiring` **一致**（先例实测是 `exit 1`）：**开关给了**但任何一条前置
   * 不成立 ⇒ `true`。「不批准」不是「悄悄把门关上」，而是「你这次启动要的东西没成立」——一条 warn 混在
   * 启动日志里等于没有，运维只会记住「批准开关一给，服务就该起不来」。
   *
   * 唯一为 `false` 的两支：**开关没给**（默认路径，与改前逐字相同），以及**四条全过**。
   */
  readonly fatal: boolean;
  /** 那一行诊断（stderr，含闭集原因 + 点名缺哪一项）；`null` = 无话可说（开关没给或全过）。 */
  readonly fatalLine: string | null;
}

/** 无话可说的一支：没给开关 ⇒ 与今天逐字相同的默认路径（不铸造、不发声、不退出）。 */
const SILENT_PLAN: ModerationStartupApprovalPlan = Object.freeze({
  liveApproval: null,
  minted: false,
  reason: null,
  fatal: false,
  fatalLine: null,
});

/**
 * 那**一行**诊断（闭集原因 + 具体缺哪一项）。开关给了却不成立时进 stderr，进程随即 `exit 1`。
 *
 * ⛔ 不含任何配置值/凭据值/异常文本：`detail` 只允许本文件里的固定短语。
 */
function refusalLine(reason: ModerationLiveRefusalReason, detail: string): string {
  return (
    `GY-R70 审核域真实接线未获批准：reason=${reason}（${detail}）`
    + ` ⇒ 本次启动**不铸造**批准能力、不给 moderationInjection.liveApproval 任何默认值，`
    + 'real 下审核域保持既有整域 fail-closed 503（PROVIDER_UNAVAILABLE，retryable=false）'
    + `；补齐 ${MODERATION_LIVE_WIRING_FLAG} 与 ${MODERATION_POLICY_SOURCE_PREFIX}<策略来源标识>`
    + ` / ${MODERATION_BIZ_TYPE_PREFIX}<真实 BizType> 及共享凭据后重启`
  );
}

/** 凭据"齐备"的判定：只看存在与形状，**绝不读值出去**、绝不出现在任何消息里。 */
function hasCredentials(value: unknown): value is ModerationLiveCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const secretId = record['secretId'];
  const secretKey = record['secretKey'];
  const sessionToken = record['sessionToken'];
  return (
    typeof secretId === 'string'
    && secretId.trim() !== ''
    && typeof secretKey === 'string'
    && secretKey.trim() !== ''
    && typeof sessionToken === 'string'
  );
}

/**
 * **生产入口的唯一决定点**：这次启动要不要铸造一份审核域真实接线的批准能力。
 *
 * 拒绝顺序固定（便于判据逐条断言）：模式 → 输入齐备 → 输入形状 → 共享凭据 → 铸造 → 剖面复核。
 * 任一条不过 ⇒ `liveApproval === null`、`minted === false`（唯一例外：剖面复核失败时已铸造但**丢弃**，
 * 见下）、`fatal === true` ＋ 一行诊断：调用方据此**一个字段都不传**并 `exit 1`——审核域不会带着
 * 「以为自己已经开了」的假象留在线上。
 *
 * ⚠️ 剖面复核（`resolveModerationLiveWiring`）必须发生在铸造**之后**：它判的是「这份批准能力交给真实
 * 端点能不能构造出端口」。但**先判形状再铸造**（`MODERATION_BIZ_TYPE_PATTERN` 等）保证了这一支在现实中
 * 只可能由冻结常量漂移触发；真触发时**丢弃铸件**（不进装配）＋ 致命诊断 ⇒ 门仍关着且进程起不来。
 */
export function resolveModerationStartupApproval(input: {
  config: ModerationStartupConfig;
  argv: readonly string[];
}): ModerationStartupApprovalPlan {
  const args = parseModerationStartupArgs(input.argv);
  // ① 开关没给 ⇒ 与今天逐字相同：不铸造、不发声、不退出（real 下 app.ts 的装配决定点仍会各打一行）。
  if (!args.flagPresent) return SILENT_PLAN;

  // ② 模式：真实审核接线只在 real 下有意义。闭集里最贴近的是 invalid_configuration
  //   （「这条启动参数与当前执行模式的组合不合法」）；`#777` 的闭集没有 execution_mode_not_real，
  //   本片**不新造**原因串（见证据页「需要裁定的点」）。
  if (input.config.executionMode !== 'real') {
    return Object.freeze({
      liveApproval: null,
      minted: false,
      reason: 'invalid_configuration' as const,
      fatal: true,
      fatalLine: refusalLine(
        'invalid_configuration',
        `执行模式是 ${JSON.stringify(input.config.executionMode)}，真实审核接线只在 real 下成立`,
      ),
    });
  }

  // ③ 输入齐备：缺哪一项就点名哪一项，但原因仍走闭集（没有批准能力 ⇒ missing_approval）。
  for (const [label, flag, value] of [
    ['策略来源标识', MODERATION_POLICY_SOURCE_PREFIX, args.policySource],
    ['真实 BizType', MODERATION_BIZ_TYPE_PREFIX, args.bizType],
  ] as const) {
    if (value.state === 'absent') {
      return Object.freeze({
        liveApproval: null,
        minted: false,
        reason: 'missing_approval' as const,
        fatal: true,
      fatalLine: refusalLine('missing_approval', `缺少 ${flag}<${label}>，必须由运维在启动命令行给出`),
      });
    }
  }

  // ④ 输入形状：未知值／空串／明显不是策略标识的串 ⇒ 不铸造 ＋ 致命诊断（与媒体域同口径：exit 1）。
  const policySource = args.policySource.state === 'value' ? args.policySource.value : null;
  if (policySource === null || !MODERATION_POLICY_SOURCE_PATTERN.test(policySource)) {
    return Object.freeze({
      liveApproval: null,
      minted: false,
      reason: 'invalid_configuration' as const,
      fatal: true,
      fatalLine: refusalLine('invalid_configuration', `${MODERATION_POLICY_SOURCE_PREFIX} 的值不是合法的策略标识`),
    });
  }
  const bizType = args.bizType.state === 'value' ? args.bizType.value : null;
  if (bizType === null || !MODERATION_BIZ_TYPE_PATTERN.test(bizType)) {
    return Object.freeze({
      liveApproval: null,
      minted: false,
      reason: 'invalid_configuration' as const,
      fatal: true,
      fatalLine: refusalLine('invalid_configuration', `${MODERATION_BIZ_TYPE_PREFIX} 的值不是合法的 BizType`),
    });
  }

  // ⑤ 共享凭据齐备（判据与 `live-assembly.ts` 的 `hasCredentials` 逐项相同；本片**必须**先判凭据再决定
  //   是否铸造，因为 `#777` 的 resolve 把凭据判定放在批准之后 ⇒ 这一份是前置镜像，铸造后还会被复核一次，
  //   两处若漂移会在复核处变成 invalid_configuration，不会静默分叉）。
  const credentials = input.config.moderationLive?.credentials ?? null;
  if (!hasCredentials(credentials)) {
    return Object.freeze({
      liveApproval: null,
      minted: false,
      reason: 'missing_credentials' as const,
      fatal: true,
      fatalLine: refusalLine(
        'missing_credentials',
        '共享凭据不齐备：TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY 未成对配置，或执行模式不是 real',
      ),
    });
  }

  // ⑥ 铸造（唯一铸造点；本片给它的**唯一**生产调用点，就在这一行）。
  //   `reason` 只写「这是一次显式运维动作」——不写任何配置值；`approvedAt` 由铸造点自己取时钟。
  const approval = approveModerationLiveWiring({
    reason: `${MODERATION_LIVE_WIRING_FLAG}（生产入口显式运维动作）`,
    policySource,
    bizType,
  });

  // ⑦ 剖面复核：用 `#777` 的纯决定函数确认「这份批准能力真的能构造出真实端口」。
  const plan = resolveModerationLiveWiring({
    executionMode: input.config.executionMode,
    approval,
    credentials,
  });
  if (plan.wiring === null) {
    return Object.freeze({
      liveApproval: null,
      minted: true,
      reason: plan.refusal?.reason ?? 'invalid_configuration',
      fatal: true,
      fatalLine: refusalLine(
        plan.refusal?.reason ?? 'invalid_configuration',
        '批准能力已按启动参数铸造，但剖面/端点/超时复核未通过 ⇒ 铸件已丢弃，不进装配',
      ),
    });
  }

  return Object.freeze({ liveApproval: approval, minted: true, reason: null, fatal: false, fatalLine: null });
}

// ---------------------------------------------------------------------------
// 3. 装配层入口（`server.ts` 只转发这一段：铸造成功就只多一个键，拒绝就只剩一行 stderr）
// ---------------------------------------------------------------------------

/**
 * `buildApp` 的审核域装配片段 ＋ 一行致命诊断。
 *
 * - 铸造成功：只有 `moderationInjection` 一个键（`{ liveApproval }`），`fatalLine === null`；
 * - 前置不成立：**一个装配键都不给**，`fatalLine` 是要打到 stderr 的那一行（调用方据此 `exit 1`）；
 * - 开关没给：同上但 `fatalLine === null`（静默，与改前逐字相同）。
 */
export interface ModerationStartupAssemblyOptions {
  readonly moderationInjection?: { readonly liveApproval: ModerationLiveWiringApproval };
  readonly fatalLine: string | null;
}

/**
 * 把决定折算成 `buildApp` 的装配片段。
 *
 * ⛔ 没铸造成功就不给任何装配键：不传 `liveApproval`、不传替身端口、不传 `service`——审核域的既有
 *   fail-closed 由 `app.ts` 的装配决定点兜住，本文件不碰它；同时把那一行诊断交回调用方（它负责 `exit 1`）。
 */
export function moderationStartupAssemblyOptions(input: {
  config: ModerationStartupConfig;
  argv: readonly string[];
}): ModerationStartupAssemblyOptions {
  const plan = resolveModerationStartupApproval({ config: input.config, argv: input.argv });
  return plan.liveApproval === null
    ? { fatalLine: plan.fatalLine }
    : { moderationInjection: { liveApproval: plan.liveApproval }, fatalLine: null };
}
