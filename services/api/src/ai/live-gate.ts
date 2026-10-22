/**
 * GY-R28-W1 · 真实提供者预算闸门（**产品路径**的那一份实现）。
 *
 * 为什么在 `ai/` 下：闸门语义是**跨能力共用**的（tts/ocr/asr 同一套 reserve→send→settle、
 * 同一套拒绝闭集），实现只写一份；能力专属部分留在各域（`tts|ocr|speech/live-*`）。
 *
 * 口径来源（**不新造语义**）：`services/api/src/tts/live-ports.ts` 是这份形状的样板 ——
 * `LiveCallGate` / `LiveCallTicket` / `LiveCallOutcome` / `LIVE_GATE_REFUSALS` 与
 * `liveGateRefusalToErrorCode()` 全部来自那里（**同一类身份**，否则闸门拒绝到契约码的映射会因
 * 复制而漂移）。本文件只提供「进程内」实现，不做任何 IO。
 *
 * 两种闸门的分工（刻意分开，互不冒充）：
 * - **本文件 `createProcessLiveGate()`** = 产品路径。只在本进程内做「防重复计费」（同一
 *   `attemptKey` 第二次一律拒绝）与预留/结算台账（供诊断读数）。可选的每能力/总额上限由
 *   构造参数给出；产品装配**不设上限**（额度是运营侧配额，不是本地的 2 次取证上限）。
 * - **取证工具的 `createFileLiveGate()`**（`tools/verify-provider-live-r28.mjs` 内）=
 *   手工装置。落盘台账、进程锁、每端点 ≤2、ceiling ¥2；台账写失败 ⇒ **零发送**。
 *   把「付费调用的闸门」做成产品依赖会让服务可用性绑死在一个可写文件上，因此两者不共用实现。
 *
 * 顺序是安全属性：**本地 build → reserve（本文件）→ sign → send 恰好一次 → settle（本文件）**。
 */
import {
  LiveGateRefusedError,
  type LiveCallGate,
  type LiveCallOutcome,
  type LiveCallTicket,
  type LiveCapability,
} from '../tts/live-ports.ts';

/**
 * 保守预留单价（CNY/次）。**不是账单金额**：与 `docs/verification/gy-i27-live-ai-20261018.md`
 * §「计费依据」及 `tools/verify-tencent-live.mjs` 的 PRICES 同口径（保守取高）：
 * OCR 高精 ¥0.50/次；ASR ¥3.20/千次 ⇒ ¥0.0032/次；TTS 精品音色 ¥0.3/万字、每次按 100 字符 ⇒ ¥0.003。
 */
export const LIVE_UNIT_PRICES_CNY = Object.freeze({
  tts: 0.003,
  ocr: 0.5,
  asr: 0.0032,
} as const satisfies Record<LiveCapability, number>);

export interface ProcessLiveGateOptions {
  /** 授权串：与适配器端口里的 `authorization` **逐字一致**，否则 `AUTHORIZATION_REQUIRED`。 */
  readonly authorization: string;
  /** 每能力预留上限；`0`/省略 = 不限（产品默认）。 */
  readonly maxCallsPerCapability?: number;
  /** 预留总额上限（CNY）；`0`/省略 = 不限（产品默认）。 */
  readonly ceilingCny?: number;
  /** 覆盖预留单价（仅供诊断/测试；缺省 `LIVE_UNIT_PRICES_CNY`）。 */
  readonly prices?: Partial<Record<LiveCapability, number>>;
  /** 可注入时钟（毫秒）。 */
  readonly now?: () => number;
}

/** 一条进程内台账（**不含任何凭据**）。 */
export interface ProcessGateEntry {
  readonly capability: LiveCapability;
  readonly attemptKey: string;
  readonly reservedCny: number;
  readonly reservedAt: number;
  settled: boolean;
  state: string | null;
  providerErrorCode: string | null;
}

export interface ProcessLiveGate extends LiveCallGate {
  /** 只读快照（诊断/证据用；不含凭据、不含请求正文）。 */
  snapshot(): {
    readonly authorization: string;
    readonly reservedCny: number;
    readonly entries: readonly ProcessGateEntry[];
    readonly settleMisses: number;
  };
}

/**
 * 进程内闸门。**reserve-then-send**：先占条目再返回票据；适配器拿到票据才会签名与发包。
 * 拒绝只走 `LIVE_GATE_REFUSALS` 闭集（由 `liveGateRefusalToErrorCode()` 映射到契约码）。
 */
export function createProcessLiveGate(options: ProcessLiveGateOptions): ProcessLiveGate {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createProcessLiveGate 需要选项对象（没有闸门就不构造真实分支）');
  }
  if (typeof options.authorization !== 'string' || options.authorization.trim() === '') {
    throw new TypeError('createProcessLiveGate 需要非空授权串（与适配器端口逐字一致）');
  }
  const authorization = options.authorization;
  const maxCalls = options.maxCallsPerCapability ?? 0;
  const ceiling = options.ceilingCny ?? 0;
  const prices: Record<LiveCapability, number> = {
    tts: options.prices?.tts ?? LIVE_UNIT_PRICES_CNY.tts,
    ocr: options.prices?.ocr ?? LIVE_UNIT_PRICES_CNY.ocr,
    asr: options.prices?.asr ?? LIVE_UNIT_PRICES_CNY.asr,
  };
  const now = options.now ?? ((): number => Date.now());
  const entries: ProcessGateEntry[] = [];
  let reservedCny = 0;
  let settleMisses = 0;

  return {
    async reserve(input) {
      if (typeof input?.authorization !== 'string' || input.authorization !== authorization) {
        throw new LiveGateRefusedError('AUTHORIZATION_REQUIRED', '授权串与闸门不一致（等价未接线，未发包）');
      }
      if (typeof input.attemptKey !== 'string' || input.attemptKey.trim() === '') {
        throw new LiveGateRefusedError('LEDGER_UNAVAILABLE', '缺少尝试键：无法防重复计费（未发包）');
      }
      if (entries.some((entry) => entry.attemptKey === input.attemptKey)) {
        throw new LiveGateRefusedError('ATTEMPT_ALREADY_RESERVED', '同一次尝试已预留过（绝不重发）');
      }
      const unit = prices[input.capability];
      if (typeof unit !== 'number' || !Number.isFinite(unit) || unit < 0) {
        throw new LiveGateRefusedError('LEDGER_UNAVAILABLE', '该能力的预留单价未定义（未发包）');
      }
      const capabilityCount = entries.filter((entry) => entry.capability === input.capability).length;
      if ((maxCalls > 0 && capabilityCount >= maxCalls) || (ceiling > 0 && reservedCny + unit > ceiling + 1e-9)) {
        throw new LiveGateRefusedError('BUDGET_OR_COUNT_EXCEEDED', '超出本地预留额度/次数上限（未发包）');
      }
      entries.push({
        capability: input.capability,
        attemptKey: input.attemptKey,
        reservedCny: unit,
        reservedAt: now(),
        settled: false,
        state: null,
        providerErrorCode: null,
      });
      reservedCny = Number((reservedCny + unit).toFixed(6));
      return { capability: input.capability, authorization, reservedCny: unit, attemptKey: input.attemptKey };
    },
    async settle(ticket, outcome) {
      // **无论成败都必须落账**；这里永不抛错（抛错会把「已发包」吞成未处理异常）。
      const entry = entries.find((item) => item.attemptKey === ticket?.attemptKey);
      if (entry === undefined) {
        settleMisses += 1;
        return;
      }
      entry.settled = true;
      entry.state = typeof outcome?.state === 'string' ? outcome.state : null;
      entry.providerErrorCode = typeof outcome?.providerErrorCode === 'string' ? outcome.providerErrorCode : null;
    },
    snapshot() {
      return {
        authorization,
        reservedCny,
        entries: entries.map((entry) => ({ ...entry })),
        settleMisses,
      };
    },
  };
}

/** 产品路径的授权串（**不是密钥**）：只用于断言「闸门被显式接入」这件事。 */
export const PRODUCT_GATE_AUTHORIZATION = 'gy-r28-w1-product-live-v1';
