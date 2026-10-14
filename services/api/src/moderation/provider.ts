/**
 * GY-I14（#14）审核 HTTP 装配片 · **端口解析与执行模式**（派单 §3 的 fail-closed 口径）。
 *
 * 口径（与本仓既有约定一致，**不新造**）：
 *   - 真实 `tms`/`ims` 供应商**未授权付费**（`tools/ai-config.mjs` 的
 *     `policySelectionVerified` 恒为 `false`，BizType 是自描述占位值），因此本片**不内置任何真实端口**，
 *     也不读环境变量、不发网络请求。
 *   - `execution_mode === 'real'`：**永不回退替身**；缺真实端口即 fail-closed
 *     （服务边界抛契约 503 `PROVIDER_UNAVAILABLE` + `retryable: true`）。
 *   - `stub` / `preset_demo`：使用**明确标注的替身**端口；替身对任何内容一律回报 `unsure`
 *     （**无结论**）⇒ 合流层按 fail-closed 判 `quarantined`。
 *     **替身不会放行任何内容**：它只能用来跑通链路与隔离回归，不能用来产出"审核通过"。
 *     要验证"通过"路径必须由调用方**显式注入**合成端口（仅测试/演示，`provider.synthetic === true`）。
 */
import { MODEL_PORT_SEAMS } from '../../../../packages/moderation/model-ports.mjs';
import type { ModerationExecutionMode } from './types.ts';

/** 替身标识（出现在端口 `model_version` 与结论证据里，**不得**被读成真实供应商）。 */
export const SUBSTITUTE_MARKER = 'synthetic-substitute';

/** 端口类别与用途一致（tms 只承担文本、ims 只承担图片；串端口由合流层拒绝）。 */
export type PortKind = 'tms' | 'ims';

/** 明确标注的替身端口：网络 seam 全部由注入方持有（此处是"调用即抛错"的替身，本片从不调用）。 */
export interface ModerationPortLike {
  kind: PortKind;
  model_version: string;
  evaluate: (request: unknown) => unknown;
  seams: Record<string, unknown>;
  provider: Record<string, unknown>;
}

/**
 * 构造**替身**端口：无结论（`unsure`），永不联网。
 *
 * 为什么替身回报 `unsure` 而不是 `pass`：
 *   审核是"不得误放行"的能力。替身如果能回报 `pass`，任何一次误接线都等于把
 *   未经真实筛查的内容放出去；`unsure` 在合流层被记为 `MODEL_NOT_EVALUATED` ⇒ `quarantined`，
 *   即"替身跑通链路但**绝不发布**内容"。这是本片对 §3「不得以内存/替身返回成功封套」的落实。
 */
export function createSubstituteModerationPort(kind: PortKind): ModerationPortLike {
  return {
    kind,
    model_version: `${SUBSTITUTE_MARKER}-${kind}@0.0.0`,
    // 只回报闭集标签与计量字段；不带任何控制类字段（见 nonbypass.ts）。
    evaluate: (): unknown => ({
      label: 'unsure',
      reason_codes: [`${SUBSTITUTE_MARKER.toUpperCase().replace(/-/g, '_')}_NO_CONCLUSION`],
      summary: 'substitute port: no conclusion (fail-closed)',
    }),
    // 四个网络 seam 全部"持有但不可用"：本片从不调用它们，用例会断言这一点。
    seams: {
      fetchImpl: (): never => {
        throw new Error('substitute seam must never be called by services/api moderation');
      },
      credentials: { kind: 'synthetic-placeholder-not-a-secret' },
      liveGate: { open: false },
      now: (): number => 0,
    },
    provider: {
      biz_type: 'synthetic-substitute-placeholder',
      // 替身不发真实请求，BizType 与它无关；置 true 只表示"替身自身声明完整"。
      biz_type_selection_verified: true,
      synthetic: true,
      timeout_ms: 1000,
    },
  };
}

/** 端口解析结果。 */
export interface ResolvedModerationPorts {
  execution_mode: ModerationExecutionMode;
  /** 交给合流层的端口表（**real 下恒为空对象**：绝不用替身冒充真实端口）。 */
  ports: { tms?: unknown; ims?: unknown };
  /** 本次实际是替身的端口类别（evidence 里据此标注 `origin: 'substitute'`）。 */
  substitutes: PortKind[];
  /** real 且调用方未注入任何端口 ⇒ 整域 fail-closed（服务边界抛 503）。 */
  fail_closed: boolean;
}

/**
 * 按执行模式解析端口。
 *
 * `injected` 只应出现在**测试/演示**装配路径（生产 `server.ts` 从不注入）；
 * real 模式下即使注入端口也会被本函数**忽略**（真实端口必须由真实适配器提供并经显式接线变更）。
 */
export function resolveModerationPorts(options: {
  executionMode: ModerationExecutionMode;
  injected?: { tms?: unknown; ims?: unknown };
}): ResolvedModerationPorts {
  const injected = options.injected ?? {};
  if (options.executionMode === 'real') {
    // real：**忽略**调用方注入的任何端口（那些只可能是合成替身），也**永不**回退替身；
    // 真实端口必须由真实适配器 + 一次显式、可审查的接线变更提供（本阶段不存在这样的适配器）
    // ⇒ 恒 fail-closed。注入与否不改变 real 的行为（这正是"不靠自述标志放行"的口径）。
    return { execution_mode: 'real', ports: {}, substitutes: [], fail_closed: true };
  }
  const ports: { tms?: unknown; ims?: unknown } = {};
  const substitutes: PortKind[] = [];
  for (const kind of ['tms', 'ims'] as const) {
    const provided = injected[kind];
    if (provided === undefined || provided === null) {
      ports[kind] = createSubstituteModerationPort(kind);
      substitutes.push(kind);
    } else {
      ports[kind] = provided;
    }
  }
  return { execution_mode: options.executionMode, ports, substitutes, fail_closed: false };
}

/** 端口声明的模型版本（读不到就返回 `null`，**不填占位**）。 */
export function declaredModelVersion(port: unknown): string | null {
  if (typeof port !== 'object' || port === null) return null;
  const value = (port as Record<string, unknown>)['model_version'];
  return typeof value === 'string' && value.length >= 1 && value.length <= 80 ? value : null;
}

/** 端口声明的 provider 信息（供证据登记；只取闭集字段，不带凭据）。 */
export function declaredProvider(port: unknown): { biz_type: string | null; synthetic: boolean } {
  if (typeof port !== 'object' || port === null) return { biz_type: null, synthetic: false };
  const provider = (port as Record<string, unknown>)['provider'];
  if (typeof provider !== 'object' || provider === null) return { biz_type: null, synthetic: false };
  const bizType = (provider as Record<string, unknown>)['biz_type'];
  const synthetic = (provider as Record<string, unknown>)['synthetic'];
  return {
    biz_type: typeof bizType === 'string' ? bizType : null,
    synthetic: synthetic === true,
  };
}

/** 供用例断言"本片不依赖任何网络 seam 的默认实现"。 */
export const MODERATION_PORT_SEAMS: readonly string[] = MODEL_PORT_SEAMS;
