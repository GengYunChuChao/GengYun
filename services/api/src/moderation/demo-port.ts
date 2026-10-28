/**
 * GY-R68 · **演示审核端口**（显式合成 `pass`，仅 `APP_EXECUTION_MODE != real` 可用）。
 *
 * ## 它解决什么（用户裁决）
 * 默认装配下社区发不出帖：审核域没有真实 `tms`/`ims` 供应商（未授权付费、`BizType` 未核验），
 * 出厂替身一律回报 `unsure` ⇒ `quarantined` ⇒ `POST /posts` 恒 422 `INPUT_UNCERTAIN` +
 * `MODEL_NOT_EVALUATED`、内容行 0 行（负控制读面：`tests/unit/community-moderation-negative-control.test.mjs`
 * 与 `docs/verification/gy-r68-moderation-gate-20261028.md`）。演示环境要能发帖 ⇒ 需要一个
 * **显式开启、明确标注合成、结论恒 `pass`** 的端口。
 *
 * ## 五条硬口径（逐条可断言）
 *  1. **只在非 real 可用**：`APP_EXECUTION_MODE === 'real'` ⇒ 本模块**恒不产出端口**
 *     （`resolveDemoModerationPorts` 的 `enabled` 恒 `false`、`refused` 恒 `true`），
 *     哪怕环境开关设了也一样。real 的 fail-closed 语义一个字都没动：`createModerationService`
 *     在 real 下**根本不看** 注入端口（`service.ts` 的 real 分支），没有真实接线就整域 503。
 *  2. **默认关闭**：只有 `MODERATION_DEMO_PORT` 的取值**逐字**为 `pass` 才启用（大小写不敏感、
 *     去首尾空白）。未设、空白、`1`/`true`/`on` 之类一律视为**关闭** ⇒ 行为与今天逐字一致。
 *  3. **明确标注合成**：端口的 `provider.synthetic === true`（既有负控制与社区联动
 *     `moderation-link.ts` 就是按这个键判"这不是真实审核"），`model_version` 以
 *     `synthetic-demo-` 开头 ⇒ 审核台账 / `GET /jobs/{id}` 读面都能看出是合成结论。
 *  4. **结论恒 `pass`**：`evaluate` 不联网、不读凭据、不看内容，只回 `{label:'pass'}`。
 *  5. **启动可见**：启用时启动日志出现一行 `moderation_demo_port: synthetic`；real 下设了开关
 *     则出现 `moderation_demo_port: refused`（明说拒绝）。运维不会在不知情的情况下用假审核。
 *
 * ## 边界（不得误读）
 *  - 本端口**不是**真实审核：它不构成"真实 tms/ims 已接通"、也不得被引用为召回率／误隔离率成绩
 *    （`docs/evaluation/sample-gap-register.md`：真实样本各 0）。演示放行 ≠ 内容已审。
 *  - **只有文本端口 `tms`**：图片端口 `ims` 仍是出厂替身 ⇒ 带媒体投稿仍走隔离/待审，
 *    演示端口**不**顺手放宽图片链路。
 *  - 网络 seam 四个全部"持有即抛错/占位"，与出厂替身同形（`packages/moderation` 从不调用它们）。
 */
import type { ModerationPortLike, PortKind } from './provider.ts';

/** 环境变量字段名（见 `.env.example` 与 `docs/reference/configuration.md`）。 */
export const DEMO_PORT_ENV_FIELD = 'MODERATION_DEMO_PORT';

/** 唯一认可的开启取值（**不是** `1`/`true`/`on`：避免"随手设了个真值"就把假审核打开）。 */
export const DEMO_PORT_ENV_PASS = 'pass';

/** 合成演示端口的版本前缀（出现在端口 `model_version` 与审核台账证据里）。 */
export const DEMO_PORT_MARKER = 'synthetic-demo';

/** 启用时的启动日志行（逐字，供运维与用例检索）。 */
export const DEMO_PORT_LOG_ENABLED = 'moderation_demo_port: synthetic';

/** real 下设了开关时的启动日志行（逐字，明说拒绝）。 */
export const DEMO_PORT_LOG_REFUSED = 'moderation_demo_port: refused';

/** 端口的 `model_version`（`synthetic-demo-` 前缀让结论一眼可辨）。 */
export function demoPortModelVersion(kind: PortKind): string {
  return `${DEMO_PORT_MARKER}-pass-${kind}@0.0.0`;
}

/** 环境里是否**显式**要求启用演示端口（只看取值，不看执行模式）。 */
export function demoPortRequested(env: Record<string, string | undefined>): boolean {
  const raw = env[DEMO_PORT_ENV_FIELD];
  if (typeof raw !== 'string') return false;
  return raw.trim().toLowerCase() === DEMO_PORT_ENV_PASS;
}

/**
 * 构造演示端口：`provider.synthetic === true` + 结论恒 `pass`，无网络、无凭据、无环境读取。
 *
 * ⛔ 本函数**不**判断执行模式：调用方必须经 {@link resolveDemoModerationPorts} 拿端口，
 * 那里才有"real 恒不启用"的闸门（以及 `createModerationService` 的 real 分支这第二道闸）。
 */
export function createDemoModerationPort(kind: PortKind = 'tms'): ModerationPortLike {
  return {
    kind,
    model_version: demoPortModelVersion(kind),
    // 结论恒 pass：不看正文、不看媒体、不联网。summary 写明是合成，落进台账也不会被读成真实审核。
    evaluate: (): unknown => ({
      label: 'pass',
      reason_codes: [],
      summary: 'synthetic demo port: fixed pass (not a real moderation verdict)',
    }),
    // 四个网络 seam 与出厂替身同形：持有但不可用，`packages/moderation` 从不调用。
    seams: {
      fetchImpl: (): never => {
        throw new Error('demo moderation port seam must never be called (no network in the demo port)');
      },
      credentials: { kind: 'synthetic-placeholder-not-a-secret' },
      liveGate: { open: false },
      now: (): number => 0,
    },
    provider: {
      biz_type: 'synthetic-demo-placeholder',
      // 合成端口不发真实请求 ⇒ BizType 与它无关；置 true 只表示"本端口自述完整"。
      biz_type_selection_verified: true,
      synthetic: true,
      timeout_ms: 1000,
    },
  };
}

/** 端口解析结果（纯数据，便于用例逐字段断言）。 */
export interface DemoPortDecision {
  /** 环境里是否显式要求启用（`MODERATION_DEMO_PORT=pass`）。 */
  requested: boolean;
  /** 本次是否**真的**装上了演示端口（`requested && executionMode !== 'real'`）。 */
  enabled: boolean;
  /** 环境要求启用、却因 real 被拒绝（供启动日志与用例钉住）。 */
  refused: boolean;
  /** 要注入的端口（未启用时为 `{}`；**永远不会**在 real 下非空）。 */
  ports: { tms?: unknown; ims?: unknown };
}

/**
 * 按执行模式解析演示端口。**real ⇒ 恒空**（`refused` 为 `true`），不管环境怎么设。
 *
 * @param options.executionMode 被测进程的执行模式（`config.executionMode`）。
 * @param options.env 进程环境（装配层传 `process.env`；用例可传字面量对象）。
 */
export function resolveDemoModerationPorts(options: {
  executionMode: string;
  env: Record<string, string | undefined>;
}): DemoPortDecision {
  const requested = demoPortRequested(options.env);
  if (!requested) return { requested: false, enabled: false, refused: false, ports: {} };
  if (options.executionMode === 'real') {
    // ⛔ real：绝不启用。演示端口在 real 下会等于"用合成 pass 冒充真实审核"，直接拒绝。
    return { requested: true, enabled: false, refused: true, ports: {} };
  }
  return { requested: true, enabled: true, refused: false, ports: { tms: createDemoModerationPort('tms') } };
}

/**
 * 装配层用的**单点**入口：返回可直接展开进 `createModerationService({...})` 的片段。
 *
 * 形状与既有装配逐字兼容（未启用 ⇒ `{}`，等价于"这个键不出现"）：
 *  - 演示端口关闭 ⇒ 注入端口原样透传（对象**同一引用**，行为零变化）；
 *  - 演示端口启用 ⇒ 与注入端口**逐键合并**，且**显式注入优先**（测试/已核验接线不会被环境变量顶掉）；
 *  - 任何情况下 real 都不会拿到演示端口（`resolveDemoModerationPorts` 已拦）。
 *
 * @param options.log 启动日志出口（装配层传 `(line) => app.log.warn(line)`）；不传则不记。
 * @param options.env 环境表（装配层按名读**一个**键后传进来）。为什么由装配层读、而不是本模块读
 *   `process.env`：`services/api/src/app.ts` 受 GY-I06 1-A 的 ambient-env 审计约束（只许**按名**读
 *   逐字白名单里的键，见 `tests/unit/media-real-mode-fail-closed.test.mjs`），因此这里的读取方式是
 *   「单键、字面量、按名」并把该键列进那张白名单 —— 不新增整表读取、也不新增动态取键。
 */
export function demoAwareModerationPorts(options: {
  injected: { tms?: unknown; ims?: unknown } | undefined;
  executionMode: string;
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
}): { ports?: { tms?: unknown; ims?: unknown } } {
  const decision = resolveDemoModerationPorts({ executionMode: options.executionMode, env: options.env });
  if (decision.refused) {
    options.log?.(
      `GY-I14 审核域：${DEMO_PORT_LOG_REFUSED} —— APP_EXECUTION_MODE=real 拒绝启用演示审核端口`
        + `（${DEMO_PORT_ENV_FIELD}=${DEMO_PORT_ENV_PASS} 被忽略），审核域保持 fail-closed（无真实端口即 503）`,
    );
  } else if (decision.enabled) {
    options.log?.(
      `GY-I14 审核域：${DEMO_PORT_LOG_ENABLED} —— 演示审核端口已启用（仅非 real；结论恒 pass；`
        + '合成的，不是真实审核结论，不得当作审核能力证据）',
    );
  }
  if (decision.enabled) {
    return { ports: { ...decision.ports, ...(options.injected ?? {}) } };
  }
  return options.injected === undefined ? {} : { ports: options.injected };
}
