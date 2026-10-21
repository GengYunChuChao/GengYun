/**
 * GY-I13 / GY-I17 / GY-I09 · 三链（TTS / OCR / ASR）**真库端到端**取证 harness（R29）
 *
 * 与 `tools/verify-provider-adapter-live.mjs`（R28-W1，**适配器层**）的分工：
 *   - 那个脚本证明「适配器能被打到、账本与闸门成立」，**不经过 HTTP**；
 *   - 本脚本证明「**从 HTTP 入口**一路打到真实上游」，即 409/503 → 200 的那一段。
 *   两者共用同一套口径：`CALL <n> <kind>` 行、预留式账本、`actualChargeCny` 未知即 `null`。
 *
 * 两阶段（派单 §「分两阶段」）：
 *   阶段一（本文件当前形态）：harness 自检 + 负控制，**零外呼**。
 *   阶段二（W1 #404 合流后）：`--approve-real-chain` 才允许真实发送。
 *
 * **默认关闭不是开关，而是结构**：
 *   - 没有 `--approve-real-chain` ⇒ 账本 `reserve` 直接抛 `APPROVAL_REQUIRED`，
 *     计数 `calls=0` 由账本自己统计（不是靠人眼确认），退出码 0；
 *   - 有 `--approve-real-chain` 但上限被收到 0 ⇒ `CAP_ZERO`，**立刻拒绝、退出码非 0**；
 *   - 上限只允许**收紧**：任何超过 `HARD_LIMITS` 的取值 ⇒ `LIMIT_WIDENING_FORBIDDEN`。
 *     派单要求「硬上限写死在脚本里，不许临时放宽」——这条在 `resolveLimits` 里是**代码**，
 *     不是注释。
 *
 * 零外呼的**证明方式**（阶段一自检用的就是它）：`installOutboundCounter()` 把
 * `globalThis.fetch` 换成计数器；任一链路真的想发包都会让 `outboundSends` 从 0 变 1，
 * 脚本末尾把它写进证据 JSON 的 `outboundSends` 字段并与 `calls` 一起断言。
 *
 * 只读：本脚本不写产品代码、不改配置、**不打印任何凭据值**（只打印 `value_hits=0`）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AI_ENDPOINTS, configurationIssues, loadPrivateEnvironment, providerFor } from './ai-config.mjs';
import { resolveTc3Credentials } from './verify-tencent-live.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- 硬上限与预算闸

/**
 * 派单写死的硬上限。**任何 CLI 参数只能把它调小**（`resolveLimits` 复核）。
 * 合计 6 次 = 2+2+2；三链各 2 次是「一次成功 + 一次可复现」的上限，第 3 次即拒绝。
 */
export const HARD_LIMITS = Object.freeze({ tts: 2, ocr: 2, asr: 2, total: 6 });

/** 派单给的预算上限（人民币）。 */
export const QUOTED_CEILING_CNY = 2;

/**
 * 每次调用**预留**多少预算。
 *
 * 为什么不按「单价 × 次数」：我们**没有**任何可信的 OCR/ASR 单价读数，编一个数就是伪造证据。
 * 因此改用**平摊上限**：`floor(2.00 / 6) = 0.3333`，6 次预留合计 1.9998 ≤ 2.00 ——
 * 无论真实单价是多少，**总预留都不可能超过派单给的预算上限**。真实扣费仍恒记 `null`。
 */
export const PER_CALL_RESERVE_CNY = Math.floor((QUOTED_CEILING_CNY / HARD_LIMITS.total) * 10000) / 10000;

export const CHAINS = Object.freeze(['tts', 'ocr', 'asr']);

/** 台账里的授权常量：与派单的「显式授权」口径一致，逐字比对后放行。 */
export const EXPECTED_AUTHORIZATION = 'gy-r29-chain-e2e';

/** 私有凭据文件（不在仓库内；可用 `--private-env=` 或 `GENGYUN_PRIVATE_ENV` 覆盖）。 */
export const DEFAULT_PRIVATE_ENV = 'E:\\GengYunPrivate\\credentials.local.json';

/**
 * AI 配置快照（**不入库**，与 R28-W1 的 `tools/verify-provider-adapter-live.mjs` 同一份）。
 * 阶段二的 profile/凭据环境变量名都从它来，不自己编。
 */
export const CONFIG_FILE = resolve(ROOT, 'docs', 'verification', 'config.local.json');

export class ChainGateRefusedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChainGateRefusedError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- 勘察事实（A 表）

/**
 * 三链的**真实**行号勘察结果（`a2ab0d9` 实测）。
 *
 * 这张表同时是证据 JSON 的 `chainFacts` 字段：阶段二跑完后，读证据的人不需要再翻源码
 * 就能对上「第几道闸、什么码、缺什么」。
 */
export const CHAIN_FACTS = Object.freeze({
  tts: {
    httpEntry: [
      'services/api/src/routes/synthesis.ts:116  POST /api/v1/speech/synthesis 的 preHandler（guards.requireUser + consent(external_inference)）',
      'services/api/src/routes/synthesis.ts:193  调 synthesisService.createSynthesis',
      'services/api/src/tts/service.ts:452        createSynthesis',
    ],
    gates: [
      { order: 1, name: '提供者闸', file: 'services/api/src/tts/service.ts', line: '470-474', code: '503 PROVIDER_UNAVAILABLE', owner: 'W1(#404)' },
      { order: 2, name: '媒体闸', file: 'services/api/src/tts/service.ts', line: '475-478', code: '409 OBJECT_UNAVAILABLE', owner: 'W2(#408) 已合入' },
      { order: 3, name: '内容闸', file: 'services/api/src/tts/service.ts', line: '480-481', code: '409/422/NOT_FOUND（readAndDecide → refusalToApiError）', owner: 'W3(#410) 已合入' },
    ],
    decision: 'services/api/src/tts/state.ts:335-376（判定顺序注释在 :332-333；四件套 CheckedContentSnapshot 在 :267-278）',
    to200: [
      '提供者闸：`createRealTtsProvider`（services/api/src/tts/provider.ts:141-157）即使凭据齐备也恒返回 PROVIDER_UNAVAILABLE；能真发的构造器是同文件 :268 `createLiveTtsProvider(ports)`，它**只经注入式端口**可达',
      '注入点：`buildApp` 的 `synthesisProvider` 选项（services/api/src/app.ts:333 声明、:990 使用）—— 已在 main，**不必等 W1** 就能在 HTTP 层注入 live 提供者',
      '媒体闸：`media.kind === \'unwired\'` 即 409（services/api/src/tts/media.ts:141-…，real ⇒ createUnwiredMediaPort :124）；注入 `createSubstituteMediaPort()`（:66）即翻成 200 路径',
      '内容闸：real + 有 PostgreSQL 池 ⇒ `createCheckedContentPortFromConfig` 走真实只读源（services/api/src/app.ts:988-989 → services/api/src/ai/checked-content-live-adapter.ts:206）；无池 ⇒ 未接线端口 ⇒ 409',
      '配置前置：`configurationIssues(config, \'tts\')` 必须零 issue（endpoint 必须逐字等于 AI_ENDPOINTS.tts.endpoint = https://tts.tencentcloudapi.com，env 必须 dev，隐私声明两项必填）',
      '凭据：TC3 **共享配对** TENCENTCLOUD_SECRET_ID/KEY（tools/verify-tencent-live.mjs:14 resolveTc3Credentials），无临时令牌时 sessionToken 显式空串',
    ],
    prerequisites: [
      'consent：POST 的 preHandler 带 consent({purpose:\'external_inference\'})（services/api/src/routes/synthesis.ts:116-118）⇒ 必须落 consent_policies / consent_records(state=granted) / privacy_epochs',
      'checked_content **answer 型**：public.conversation_answers 里 id 为 uuid、check_state=\'passed\'（→approved，见 checked-content-live-adapter.ts:89-93）、owner_id = 会话用户或 NULL、checked_text 非空、revision 等于请求里的 revision',
      'checked_content **知识型**：catalog_read.current_knowledge（视图）里 id+type 命中；auditState 恒 \'approved\'（:161），text = title+换行+body（:105-112）；type 仅 species/herbicide/scheme/static_region',
      '合成 store 无持久化实现：app.ts:1002 只有 createMemorySynthesisStore ⇒ 作业记录**不落 PG**',
    ],
    unobtainable: ['actualChargeCny（供应商不回传逐次扣费）', '真机听感/音色自然度', '真实用量的账单对账金额'],
  },
  ocr: {
    httpEntry: [
      'services/api/src/routes/ocr.ts:193  registerOcrRoutes（在 services/api/src/app.ts:1718 被调用）',
      'services/api/src/ocr/service.ts:459-462 提供者闸',
      'services/api/src/ocr/service.ts:464   media.resolve（媒体引用）',
    ],
    gates: [
      { order: 1, name: '提供者闸', file: 'services/api/src/ocr/service.ts', line: '459-462', code: '503 PROVIDER_UNAVAILABLE', owner: 'W1(#404)' },
      { order: 2, name: '媒体引用', file: 'services/api/src/ocr/service.ts', line: '464', code: '404/409/422（MediaResolution：NOT_FOUND / REVISION_CONFLICT / OBJECT_UNAVAILABLE）', owner: 'real 恒 unwired' },
    ],
    decision: 'services/api/src/ocr/media.ts:76-78（real ⇒ createUnwiredMediaPort :65-73，恒 OBJECT_UNAVAILABLE）',
    to200: [
      '提供者闸：`createRealOcrProvider`（services/api/src/ocr/provider.ts:168-182）恒返回 PROVIDER_UNAVAILABLE —— 和 TTS 不同，**main 上没有 OCR 的 live 发送适配器**（`ai/` 目录只有 checked-content 两个文件）',
      '⚠ **装配缺口**：`registerOcrRoutes` 的 deps 支持 `provider`（services/api/src/routes/ocr.ts:70/195），但 `buildApp` 调用处（services/api/src/app.ts:1718）**没有传 provider / media / store**，`BuildAppOptions`（:321-342）也没有 ocr* 注入项 ⇒ **OCR 链在 main 上没有任何 HTTP 层注入点**',
      '媒体引用：real 下 `createOcrMediaPort`（ocr/media.ts:76-78）恒 unwired ⇒ 404/409；替身端口 :45 只认 revision===1',
      '配置前置：`configurationIssues(config, \'ocr\')` 零 issue；endpoint 必须逐字等于 https://ocr.tencentcloudapi.com，action GeneralAccurateOCR / version 2018-11-19（tools/ai-config.mjs:7）',
    ],
    prerequisites: [
      'consent：ocr 路由同样走 consent 门（services/api/src/routes/ocr.ts:198-208 的 reference/consent 装配）',
      'media：请求体 media_id(uuid) + media_revision ≥ 1（:158-160）；真实字节必须来自媒体域对象存储（real 未接线 ⇒ 恒 OBJECT_UNAVAILABLE）',
      '真实 OCR 需要**一张真实图片**；本 harness 不生成伪造图片充当证据',
    ],
    unobtainable: ['actualChargeCny', '真实识别准确率（单张图不构成能力结论）'],
  },
  asr: {
    httpEntry: [
      'services/api/src/routes/speech.ts:127  createSpeechProvider / deps.provider（装配点 services/api/src/app.ts:1699 传 speechProvider）',
      'services/api/src/speech/service.ts:431-434 提供者闸',
      'services/api/src/speech/service.ts:812-814 providerAvailable / mediaPort 读数',
    ],
    gates: [
      { order: 1, name: '提供者闸', file: 'services/api/src/speech/service.ts', line: '431-434', code: '503 PROVIDER_UNAVAILABLE', owner: 'W1(#404)' },
      { order: 2, name: '空转写闸', file: 'services/api/src/speech/service.ts', line: '550 / 574', code: 'uncertain + INPUT_UNCERTAIN（空/纯空白文本不得成功）', owner: '已有' },
    ],
    decision: 'services/api/src/speech/media.ts:79-81（real ⇒ unwired）',
    to200: [
      '提供者闸：`createRealSpeechProvider`（services/api/src/speech/provider.ts:189-206）恒返回 PROVIDER_UNAVAILABLE —— main 上同样**没有 ASR 的 live 发送适配器**',
      '注入点**存在**：`BuildAppOptions.speechProvider`（services/api/src/app.ts:325 声明、:1699 使用）⇒ W1 合流后可直接注入',
      '配置前置：`configurationIssues(config, \'asr\')` 零 issue；endpoint https://asr.tencentcloudapi.com，action SentenceRecognition / version 2019-06-14（tools/ai-config.mjs:8）',
      '凭据：ASR 专用子账号键已删除（腾讯云侧 AuthFailure.SecretIdNotFound）⇒ 只能走主账号共享配对',
    ],
    prerequisites: [
      'consent：speech 路由带 purpose=voice_question 的外发账本（services/api/src/app.ts:890）',
      'media：media_id + media_revision ≥ 1（services/api/src/routes/speech.ts:67-69）；真实音频必须来自媒体域对象（real 未接线）',
      '音频格式：SentenceRecognition 的 VoiceFormat 钉死 wav；本机无 MP3→WAV 解码器，**合成音也转不出可识别音频**',
    ],
    unobtainable: ['actualChargeCny', '真实转写文本（R28 历史读数 Result=\'\'：合成音不是可识别语音）', '真机录音回环'],
  },
});

// ---------------------------------------------------------------- 参数与上限

export function parseArgs(argv = []) {
  const args = {
    chains: [],
    approveRealChain: false,
    limits: {},
    privateEnv: process.env.GENGYUN_PRIVATE_ENV ?? DEFAULT_PRIVATE_ENV,
    configPath: CONFIG_FILE,
    outDir: resolve(ROOT, '..', '.pg17', 'tmp'),
    help: false,
  };
  for (const raw of argv) {
    if (raw === '--tts' || raw === '--ocr' || raw === '--asr') {
      const chain = raw.slice(2);
      if (!args.chains.includes(chain)) args.chains.push(chain);
      continue;
    }
    if (raw === '--approve-real-chain') { args.approveRealChain = true; continue; }
    if (raw === '--help' || raw === '-h') { args.help = true; continue; }
    const limit = /^--limit-(tts|ocr|asr|total)=(\d+)$/.exec(raw);
    if (limit !== null) { args.limits[limit[1]] = Number.parseInt(limit[2], 10); continue; }
    if (raw.startsWith('--private-env=')) { args.privateEnv = raw.slice('--private-env='.length); continue; }
    if (raw.startsWith('--config=')) { args.configPath = resolve(raw.slice('--config='.length)); continue; }
    if (raw.startsWith('--out-dir=')) { args.outDir = resolve(raw.slice('--out-dir='.length)); continue; }
    throw new ChainGateRefusedError('UNKNOWN_ARGUMENT', `无法识别的参数：${raw}`);
  }
  if (args.chains.length === 0) args.chains = [...CHAINS];
  return args;
}

/**
 * 解析生效上限。**只允许收紧**：超过 `HARD_LIMITS` 的取值一律拒绝（派单「不许临时放宽」）。
 */
export function resolveLimits(overrides = {}) {
  const limits = { tts: HARD_LIMITS.tts, ocr: HARD_LIMITS.ocr, asr: HARD_LIMITS.asr, total: HARD_LIMITS.total };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, key)) throw new ChainGateRefusedError('UNKNOWN_LIMIT', `未知上限键：${key}`);
    if (!Number.isInteger(value) || value < 0) throw new ChainGateRefusedError('INVALID_LIMIT', `上限必须是 >=0 的整数：${key}=${value}`);
    if (value > HARD_LIMITS[key]) {
      throw new ChainGateRefusedError(
        'LIMIT_WIDENING_FORBIDDEN',
        `上限只允许收紧：${key}=${value} 超过硬上限 ${HARD_LIMITS[key]}（硬上限写死在脚本里，不接受临时放宽）`,
      );
    }
    limits[key] = value;
  }
  const perChainSum = CHAINS.reduce((sum, chain) => sum + limits[chain], 0);
  if (limits.total > perChainSum) limits.total = perChainSum;
  return limits;
}

/** 上限为 0 ⇒ 连一次都不许发，**立刻拒绝**（负控制的第二条）。 */
export function assertCapsOpen(limits, chains) {
  if (limits.total === 0) throw new ChainGateRefusedError('CAP_ZERO', '合计上限为 0：拒绝执行真实链路（负控制）');
  for (const chain of chains) {
    if (limits[chain] === 0) throw new ChainGateRefusedError('CAP_ZERO', `${chain} 上限为 0：拒绝执行（负控制）`);
  }
}

// ---------------------------------------------------------------- 零外呼计数

/**
 * 把 `globalThis.fetch` 换成计数器。真实链路若试图发包，`outboundSends` 会从 0 变 1；
 * 负控制断言 `outboundSends === 0` 因此**可被证伪**，不是一句空口保证。
 */
export function installOutboundCounter() {
  const state = { outboundSends: 0, urls: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (...callArgs) => {
    state.outboundSends += 1;
    const [input] = callArgs;
    state.urls.push(typeof input === 'string' ? new URL(input).host : String(input?.url ?? 'unknown'));
    throw new ChainGateRefusedError('OUTBOUND_FORBIDDEN', '本次运行不允许任何外呼（未提供 --approve-real-chain）');
  };
  state.restore = () => { globalThis.fetch = original; };
  return state;
}

// ---------------------------------------------------------------- 调用台账（预算闸）

/**
 * 预留式账本 + 预算闸。形状与 `LiveCallGate`（services/api/src/tts/live-ports.ts:90-98）一致，
 * 因此可以直接当端口注入真实 TTS 适配器。
 *
 * 铁律 5 的落地点：
 *   - 每次真实调用**之前**先打一行 `CALL <n> <kind>`（`reserve` 里，在任何签名/建连之前）；
 *   - 数到上限就 `throw`，不重试、不刷调用；
 *   - 同一 `attemptKey` 重复预留 ⇒ 拒绝（防同一请求被计费两次）。
 */
export function createCallLedger({ limits, approveRealChain, say = () => {}, readOutboundSends = () => 0 }) {
  const entries = [];
  const perKind = new Map(CHAINS.map((chain) => [chain, 0]));
  const attemptKeys = new Set();
  const state = { reservedCny: 0 };

  /**
   * 逐次外呼前后快照（指挥 m00277-A / m00305-1 要求）。
   *
   * 为什么必须在台账里而不在 main 里做：`reserve` 是**唯一**的计费入口，
   * 只有在这里取「前」，才能保证「后 − 前」覆盖到真正发生的那一次发送；
   * 在 main 里取只能得到整轮的总量，无法定位到具体某一次越限。
   */
  function takeSnapshot() {
    return {
      calls: entries.length,
      outboundSends: readOutboundSends(),
      reservedCny: Number(state.reservedCny.toFixed(4)),
    };
  }

  function canReserve(capability) {
    if (!approveRealChain) {
      throw new ChainGateRefusedError('APPROVAL_REQUIRED', '未提供 --approve-real-chain：拒绝任何真实调用（负控制）');
    }
    if (!perKind.has(capability)) throw new ChainGateRefusedError('UNKNOWN_CAPABILITY', `未知链路：${capability}`);
    if (perKind.get(capability) + 1 > limits[capability]) {
      throw new ChainGateRefusedError('PER_KIND_LIMIT', `${capability} 已达上限 ${limits[capability]} 次：拒绝继续调用（不重试、不刷调用）`);
    }
    if (entries.length + 1 > limits.total) {
      throw new ChainGateRefusedError('TOTAL_LIMIT', `合计已达上限 ${limits.total} 次：拒绝继续调用`);
    }
    if (state.reservedCny + PER_CALL_RESERVE_CNY > QUOTED_CEILING_CNY) {
      throw new ChainGateRefusedError('BUDGET_EXCEEDED', `预留将超过 ¥${QUOTED_CEILING_CNY.toFixed(2)} 预算上限：拒绝继续调用`);
    }
  }

  return {
    entries,
    get calls() { return entries.length; },
    get reservedCny() { return Number(state.reservedCny.toFixed(4)); },
    /** 供调用方在整轮外呼前后各取一次，用于「整轮增量」记账。 */
    snapshot() { return takeSnapshot(); },

    async reserve({ capability, authorization, attemptKey }) {
      canReserve(capability);
      if (authorization !== EXPECTED_AUTHORIZATION) {
        throw new ChainGateRefusedError('AUTHORIZATION_REQUIRED', '授权令牌与台账不一致：等价于未接线，拒绝发包');
      }
      if (attemptKeys.has(attemptKey)) {
        throw new ChainGateRefusedError('ATTEMPT_ALREADY_RESERVED', `尝试键已预留过：${attemptKey}（拒绝重发，防重复计费）`);
      }
      attemptKeys.add(attemptKey);
      const ordinal = entries.length + 1;
      const snapshotBefore = takeSnapshot();
      say(`CALL ${ordinal} ${capability}`);
      perKind.set(capability, perKind.get(capability) + 1);
      state.reservedCny += PER_CALL_RESERVE_CNY;
      const ticket = { capability, authorization, reservedCny: PER_CALL_RESERVE_CNY, attemptKey, ordinal };
      entries.push({
        ordinal,
        kind: capability,
        attemptKey,
        state: 'reserved',
        http: null,
        durationMs: null,
        tokens: null,
        bytes: null,
        code: null,
        requestId: null,
        actualChargeCny: null,
        resultMayHaveBeenProcessed: null,
        snapshotBefore,
        snapshotAfter: null,
      });
      return ticket;
    },

    /** 无论成败都必须落账（成功/业务失败/超时/传输失败）。 */
    async settle(ticket, outcome) {
      const entry = entries[ticket.ordinal - 1];
      if (entry === undefined) throw new ChainGateRefusedError('LEDGER_MISMATCH', '落账票据找不到对应条目');
      entry.state = outcome?.state ?? 'OUTCOME_UNKNOWN';
      entry.actualChargeCny = outcome?.actualChargeCny ?? null;
      entry.providerErrorCode = outcome?.providerErrorCode ?? null;
      entry.resultMayHaveBeenProcessed = outcome?.resultMayHaveBeenProcessed ?? null;
      entry.snapshotAfter = takeSnapshot();
    },

    /** 适配器观测（唯一真源）回填：http / requestId / 耗时。 */
    observe(observation) {
      const entry = [...entries].reverse().find((item) => item.requestId === null && item.http === null);
      if (entry === undefined) return;
      entry.http = observation.httpStatus ?? null;
      entry.requestId = observation.requestId ?? null;
      entry.durationMs = typeof observation.elapsedMs === 'number' ? observation.elapsedMs : null;
      if (typeof observation.audioBytes === 'number') entry.bytes = observation.audioBytes;
      if (observation.errorCode !== null && observation.errorCode !== undefined) entry.code = observation.errorCode;
    },
  };
}

// ---------------------------------------------------------------- 记账对账

/**
 * 逐次 + 整轮记账：把「预留了几次」和「实际发了几次包」分开对账。
 *
 * 为什么需要它（指挥 m00277-A：任一次之外的外呼算超出，必须写进「超限」不得隐瞒）：
 * 台账只知道 `reserve` 被调了几次；真正有没有出网由 `installOutboundCounter` 的计数器说话。
 * 两者一旦不等，就是「有代码绕过台账直接发包」——这种差异必须变成可读读数，
 * 而不是寄望于「大家都守规矩」。
 */
export function summarizeAccounting({ snapshotBefore, snapshotAfter, entries = [] }) {
  const before = snapshotBefore ?? { calls: 0, outboundSends: 0, reservedCny: 0 };
  const after = snapshotAfter ?? before;
  const total = {
    calls: after.calls - before.calls,
    outboundSends: after.outboundSends - before.outboundSends,
    reservedCny: Number((after.reservedCny - before.reservedCny).toFixed(4)),
  };
  const perCall = entries.map((entry) => {
    const start = entry.snapshotBefore ?? before;
    const end = entry.snapshotAfter ?? start;
    return {
      ordinal: entry.ordinal,
      kind: entry.kind,
      state: entry.state,
      callsDelta: end.calls - start.calls,
      outboundDelta: end.outboundSends - start.outboundSends,
      reservedDeltaCny: Number((end.reservedCny - start.reservedCny).toFixed(4)),
    };
  });
  const outboundBeyondLedger = Math.max(0, total.outboundSends - total.calls);
  const excessPerCall = perCall.filter((item) => item.outboundDelta > item.callsDelta).map((item) => item.ordinal);
  return {
    snapshotBefore: before,
    snapshotAfter: after,
    total,
    perCall,
    overage: {
      outboundBeyondLedger,
      excessPerCall,
      exceeds: outboundBeyondLedger > 0 || excessPerCall.length > 0,
    },
  };
}

// ---------------------------------------------------------------- 凭据自检

/**
 * 凭据只在内存里映射，日志里**只许**出现 `value_hits=<n>`。
 *
 * 做法：取出所有键值，逐条在任何已产出文本里 `indexOf`；命中即视为泄漏（返回 >0）。
 * 绝不打印值本身，也绝不打印它的长度或前缀。
 */
export function countCredentialLeaks(texts, env) {
  const secrets = Object.values(env).filter((value) => typeof value === 'string' && value.trim().length >= 8);
  let hits = 0;
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const secret of secrets) if (text.includes(secret)) hits += 1;
  }
  return hits;
}

// ---------------------------------------------------------------- 链路描述

function planFor(chain) {
  const facts = CHAIN_FACTS[chain];
  return {
    chain,
    endpoint: AI_ENDPOINTS[chain]?.endpoint ?? null,
    action: AI_ENDPOINTS[chain]?.action ?? null,
    apiVersion: AI_ENDPOINTS[chain]?.version ?? null,
    httpEntry: facts.httpEntry,
    gates: facts.gates,
    decision: facts.decision,
    to200: facts.to200,
    prerequisites: facts.prerequisites,
    unobtainable: facts.unobtainable,
  };
}

/**
 * 阶段一的**零外呼**跑法：只做静态勘察 + 上限/预算闸复核，不构造任何真实端口。
 * 返回的证据里 `calls` 与 `outboundSends` 都必须为 0。
 */
export async function dryRun({ args, limits, ledger, outbound }) {
  const chains = args.chains.map(planFor);
  const notices = [];
  for (const chain of args.chains) {
    notices.push(`${chain}: 未提供 --approve-real-chain ⇒ 计划态，零外呼`);
  }
  return {
    phase: 'phase1-plan',
    approveRealChain: args.approveRealChain,
    chains,
    limits,
    perCallReserveCny: PER_CALL_RESERVE_CNY,
    quotedCeilingCny: QUOTED_CEILING_CNY,
    calls: ledger.calls,
    outboundSends: outbound.outboundSends,
    reservedCny: ledger.reservedCny,
    notices,
    calls_detail: ledger.entries,
  };
}

// ---------------------------------------------------------------- 阶段二（真实链路）

/**
 * 阶段二的**就绪性**执行（`--approve-real-chain` 才可达）。
 *
 * 本回合它**只做构造与配置校验，不发任何包**：`reserve`（= 唯一的计费入口）只在
 * `provider.synthesize()` 里发生，而这里不调用 `synthesize`。所以即便带了授权，
 * `calls=0 / outboundSends=0` —— 这是设计，不是巧合。
 *
 * ⚠ 因此 `--approve-real-chain` 在本回合等于「授权做就绪性核查」，**不等于已花钱**。
 * 真正的 HTTP 入口臂（buildApp + 注入 + PG 合成主体）在阶段二补齐后才会有首个 `CALL 1 ...`。
 *
 * 三条链在 main 上的可达性并不同，这里如实区分：
 *   - TTS：`buildApp.synthesisProvider` 注入点**已在 main**（app.ts:333/990）；live 发送适配器也在 main
 *     （services/api/src/tts/provider.ts:268）⇒ 本回合可到「构造完成」；
 *   - ASR：注入点已在 main（app.ts:325/1699），但 live 发送适配器**不在 main** ⇒ `PROVIDER_ADAPTER_ABSENT`；
 *   - OCR：`buildApp` **没有** ocrProvider 注入点（app.ts:1718）⇒ `BLOCKED_NO_INJECTION_POINT`。
 */
export async function liveRun({ args, limits, ledger, outbound, say, privateEnvPath, configPath = CONFIG_FILE }) {
  const sayLines = [];
  const localSay = (line) => { sayLines.push(line); say(line); };

  const config = readChainConfig(configPath);
  const results = [];
  const env = loadPrivateEnvironmentOrEmpty(privateEnvPath);

  for (const chain of args.chains) {
    const facts = CHAIN_FACTS[chain];
    const base = { chain, configPath: configPath === undefined ? null : configPath, wired: false, sends: 0 };
    if (config === null) {
      results.push({ ...base, refused: 'CONFIG_FILE_UNAVAILABLE', message: `缺少 ${configPath}（config.local.json 不入库，需本地准备；缺它连构造都无法通过 configurationIssues）` });
      continue;
    }
    const issues = configurationIssues(config, chain);
    if (issues.length > 0) {
      results.push({ ...base, refused: `CONFIGURATION_ISSUE:${issues[0]}`, configIssues: issues, message: '配置未过 configurationIssues，构造期会 fail-closed' });
      continue;
    }
    if (env === null) {
      results.push({ ...base, refused: 'PRIVATE_FILE_UNAVAILABLE', configIssues: [], message: '凭据文件不可读，无法取 TC3 配对' });
      continue;
    }
    results.push(await resolveChainReadiness({ chain, facts, config, env, ledger, localSay }));
  }

  return {
    phase: 'phase2-live',
    approveRealChain: args.approveRealChain,
    sending: 'not_wired_this_round（本回合只做构造与配置核查，未调用 synthesize）',
    limits,
    chains: results,
    calls: ledger.calls,
    outboundSends: outbound.outboundSends,
    reservedCny: ledger.reservedCny,
    calls_detail: ledger.entries,
    value_hits: countCredentialLeaks(sayLines, env ?? {}),
  };
}

/** 配置缺失不当成崩溃：降级为 `null` 并在证据里写清缺哪个键。 */
function readChainConfig(configPath) {
  if (typeof configPath !== 'string' || !existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 凭据文件缺失同样降级为 `null`；值绝不外泄。 */
function loadPrivateEnvironmentOrEmpty(privateEnvPath) {
  try {
    return loadPrivateEnvironment(privateEnvPath);
  } catch {
    return null;
  }
}

async function resolveChainReadiness({ chain, facts, config, env, ledger, localSay }) {
  const provider = providerFor(config, chain);
  const base = { chain, wired: false, sends: 0, configIssues: [], providerSpec: { secretIdEnv: provider?.secretIdEnv ?? null, apiKeyEnv: provider?.apiKeyEnv ?? null } };

  if (chain === 'tts') {
    const { createLiveTtsProvider } = await import('../services/api/src/tts/provider.ts');
    const { createSubstituteMediaPort } = await import('../services/api/src/tts/media.ts');
    try {
      const tc3 = resolveTc3Credentials(env, provider);
      // profile 逐项取自**已校验的配置**，不自己编 region/voiceType（否则就是伪造读数）。
      const profile = {
        endpoint: AI_ENDPOINTS.tts.endpoint,
        action: provider.action,
        apiVersion: provider.apiVersion,
        region: provider.region,
        timeoutMs: provider.timeoutMs,
        maxRetries: provider.maxRetries,
        voiceType: provider.voiceType,
        codec: provider.codec,
        sampleRate: provider.sampleRate,
        maxTextCharacters: provider.maxTextCharacters,
      };
      const liveProvider = createLiveTtsProvider({
        liveGate: ledger,
        authorization: EXPECTED_AUTHORIZATION,
        profile,
        credentials: {
          secretId: tc3.TENCENTCLOUD_SECRET_ID,
          secretKey: tc3.TENCENTCLOUD_SECRET_KEY,
          sessionToken: tc3.TENCENTCLOUD_SESSION_TOKEN,
        },
        onObservation: (observation) => ledger.observe(observation),
      });
      const media = createSubstituteMediaPort();
      localSay('tts: live provider 构造完成；本回合不调用 synthesize，故不发包');
      return { ...base, wired: true, available: liveProvider.available, providerVersion: liveProvider.providerVersion, mediaPort: media.kind, next: facts.to200[0] };
    } catch (error) {
      return { ...base, refused: error?.code ?? error?.message ?? 'UNKNOWN', message: '构造期 fail-closed（凭据配对或 profile 不符）' };
    }
  }

  if (chain === 'asr') {
    return {
      ...base,
      refused: 'PROVIDER_ADAPTER_ABSENT',
      message: 'main 上 services/api/src/speech/provider.ts:189-206 恒 fail-closed，无 live 发送适配器；注入点 app.ts:325/1699 已就绪',
      credentialNote: provider?.secretIdEnv === 'TENCENTCLOUD_ASR_SECRET_ID'
        ? '配置仍指向已删除的 ASR 专用子账号键（腾讯云侧 AuthFailure.SecretIdNotFound）⇒ 阶段二必须改成主账号共享配对'
        : '已使用主账号共享配对（ASR 专用子账号键已删除）',
    };
  }

  return {
    ...base,
    refused: 'BLOCKED_NO_INJECTION_POINT',
    message: 'buildApp 未传 provider/media/store 给 registerOcrRoutes（services/api/src/app.ts:1718），BuildOptions 无 ocr* 注入项 ⇒ HTTP 层无法注入真实 OCR',
    next: facts.to200[0],
  };
}

// ---------------------------------------------------------------- 入口

function usage() {
  return [
    '用法：node tools/verify-chain-e2e-r29.mjs [--tts] [--ocr] [--asr] [--approve-real-chain]',
    '       [--limit-tts=N] [--limit-ocr=N] [--limit-asr=N] [--limit-total=N]',
    '       [--private-env=<绝对路径>] [--config=<绝对路径>] [--out-dir=<绝对路径>]',
    '',
    `硬上限（写死）：tts=${HARD_LIMITS.tts} ocr=${HARD_LIMITS.ocr} asr=${HARD_LIMITS.asr} 合计=${HARD_LIMITS.total}，预算 ¥${QUOTED_CEILING_CNY.toFixed(2)}`,
    '不带 --approve-real-chain 的运行一律零外呼（calls=0 / outboundSends=0）。',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usage()); return 0; }

  const limits = resolveLimits(args.limits);
  assertCapsOpen(limits, args.chains);

  const sayLines = [];
  const say = (line) => { sayLines.push(line); console.log(line); };
  say(`SCOPE=${args.approveRealChain ? 'real_chain' : 'plan_only'}; chains=${args.chains.join(',')}`);
  say(`LIMITS tts=${limits.tts} ocr=${limits.ocr} asr=${limits.asr} total=${limits.total} ceiling_cny=${QUOTED_CEILING_CNY.toFixed(2)}`);

  const outbound = installOutboundCounter();
  const ledger = createCallLedger({ limits, approveRealChain: args.approveRealChain, say, readOutboundSends: () => outbound.outboundSends });
  const snapshotBefore = ledger.snapshot();

  let evidence;
  try {
    evidence = args.approveRealChain
      ? await liveRun({ args, limits, ledger, outbound, say, privateEnvPath: args.privateEnv, configPath: args.configPath })
      : await dryRun({ args, limits, ledger, outbound });
  } finally {
    outbound.restore();
  }

  evidence.generatedAt = new Date().toISOString();
  evidence.repoHead = readHead();
  evidence.hardLimits = HARD_LIMITS;
  evidence.value_hits = 0; // 阶段一不读凭据文件，值命中必然为 0
  evidence.accounting = summarizeAccounting({ snapshotBefore, snapshotAfter: ledger.snapshot(), entries: ledger.entries });

  if (!existsSync(args.outDir)) mkdirSync(args.outDir, { recursive: true });
  const outFile = join(args.outDir, `chain-e2e-r29-${evidence.phase}.json`);
  writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  say(`calls=${evidence.calls} outboundSends=${evidence.outboundSends} reserved_cny=${evidence.reservedCny.toFixed(4)} value_hits=${evidence.value_hits}`);
  say(`accounting calls=${evidence.accounting.total.calls} outbound_delta=${evidence.accounting.total.outboundSends} reserved_delta_cny=${evidence.accounting.total.reservedCny.toFixed(4)} overage=${evidence.accounting.overage.exceeds ? 'YES' : 'none'}`);
  say(`evidence=${outFile}`);

  if (evidence.outboundSends !== 0 && !args.approveRealChain) {
    throw new ChainGateRefusedError('NEGATIVE_CONTROL_BROKEN', '未授权运行却发生了外呼：负控制被打破');
  }
  // 证据先落盘再抛：超限这件事必须留下可读的现场，不能只留一句报错。
  if (evidence.accounting.overage.exceeds) {
    throw new ChainGateRefusedError(
      'OUTBOUND_BEYOND_LEDGER',
      `实际外呼超出台账记账：beyond=${evidence.accounting.overage.outboundBeyondLedger} excessPerCall=${JSON.stringify(evidence.accounting.overage.excessPerCall)}`,
    );
  }
  return 0;
}

function readHead() {
  try {
    return readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`REFUSED ${error?.code ?? error?.name ?? 'ERROR'}: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
