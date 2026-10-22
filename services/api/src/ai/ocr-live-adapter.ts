/**
 * GY-R28-W1 · 标签 OCR 真实适配器（腾讯云 `GeneralAccurateOCR`）+ 配置→端口装配。
 *
 * 形状照抄样板 `services/api/src/tts/provider.ts` 的 `createLiveTtsProvider()`：
 * **build(本地) → reserve(闸门) → sign(TC3) → send(恰好一次) → settle(无论成败)**，
 * 端点断言、`redirect:'manual'`、`AbortSignal.timeout(...)`、零重试、证据不足即「结果未知」逐条相同。
 *
 * 三条本域特有的硬约束：
 * 1. **字节来自注入端口**，不来自 ambient env / 磁盘 / 对象存储的隐式默认（见 `live-ports.ts` 说明）。
 * 2. **绝不补造字段**：识别出的文本 → 四个契约字段的映射是**保守**的（找不到就 `null` / `[]`），
 *    因为契约 `LabelFields` 允许 nullable，而 `decideMatchState` 会把不全判成 `insufficient`；
 *    反过来「猜一个登记号」会让用药安全断言失效。
 * 3. 本地拒绝（取不到字节 / 图片超限 / 头部非法）**先于预留**：未发包、不占预算、不留台账。
 *
 * 证据口径：真实标签 OCR 样本为 **0**（`docs/evaluation/sample-gap-register.md`），
 * 因此本文件与全域**不产生、不声称任何识别准确率结论**；一次可达性调用既不构成样本，
 * 也不构成任何质量结论。
 */
import type { OcrProvider, ProviderOutcome } from '../ocr/provider.ts';
import {
  OcrLocalInputError,
  OcrWiringError,
  type LiveOcrCredentials,
  type LiveOcrObservation,
  type LiveOcrProfile,
  type OcrImageSource,
  type ProviderCallState,
  type RealOcrPorts,
} from './ocr-live-ports.ts';
import { providerErrorCodeToErrorCode } from './error-map.ts';
import { createProcessLiveGate, LIVE_UNIT_PRICES_CNY } from './live-gate.ts';
import { liveGateRefusalToErrorCode } from '../tts/live-ports.ts';
import { signTc3Request } from '../tts/tc3.ts';
import type { OcrProviderConfig } from '../config.ts';

/**
 * 冻结的 OCR 供应商剖面（口径＝`tools/ai-config.mjs` 的 `AI_ENDPOINTS.ocr` +
 * `configurationIssues()` 的固定要求）。适配器**构造期**逐项断言，任一项不符即拒绝构造。
 */
export const LIVE_OCR_FROZEN_PROFILE = Object.freeze({
  endpoint: 'https://ocr.tencentcloudapi.com',
  action: 'GeneralAccurateOCR',
  apiVersion: '2018-11-19',
  region: 'ap-shanghai',
  maxImageBytes: 2097152,
  mediaTransport: 'inlineBase64' as const,
  minTimeoutMs: 1000,
  maxTimeoutMs: 20000,
});

/** 构造期校验被校验配置快照（纵深防御；配置侧已挡一层）。 */
export function assertLiveOcrProfile(profile: LiveOcrProfile): LiveOcrProfile {
  const frozen = LIVE_OCR_FROZEN_PROFILE;
  const reject = (label: string): never => {
    throw new OcrWiringError(`真实 OCR 配置不合法：${label}（fail-closed，未发包）`);
  };
  if (profile === null || typeof profile !== 'object') reject('缺少被校验配置快照');
  if (profile.endpoint !== frozen.endpoint) reject('endpoint 不是白名单端点');
  if (profile.action !== frozen.action) reject('action 不是 GeneralAccurateOCR');
  if (profile.apiVersion !== frozen.apiVersion) reject('apiVersion 不是 2018-11-19');
  if (profile.region !== frozen.region) reject('region 不是被校验配置的固定区域');
  if (typeof profile.timeoutMs !== 'number' || !Number.isInteger(profile.timeoutMs) || profile.timeoutMs < frozen.minTimeoutMs || profile.timeoutMs > frozen.maxTimeoutMs) {
    reject(`timeoutMs 必须是被校验配置里的 ${frozen.minTimeoutMs}..${frozen.maxTimeoutMs} 整数`);
  }
  if (profile.maxRetries !== 0) reject('maxRetries 必须为 0（任何重发都是一次新的预留）');
  if (profile.maxImageBytes !== frozen.maxImageBytes) reject(`maxImageBytes 不是 ${frozen.maxImageBytes}`);
  if (profile.mediaTransport !== frozen.mediaTransport) reject('mediaTransport 不是 inlineBase64');
  return profile;
}

/**
 * 本地图片校验（**先于预留**）：PNG/JPEG 头 + 字节上限。
 * 头部口径与 `tools/ai-config.mjs:imageInfo()` 一致（只做头部嗅探，不做完整解码，也不剥 EXIF）。
 */
export function requireLiveOcrImage(raw: unknown, maxImageBytes: number): Uint8Array {
  if (!(raw instanceof Uint8Array) || raw.length === 0) {
    throw new OcrLocalInputError('OBJECT_UNAVAILABLE', '取不到待识别图片字节（fail-closed，未发包）');
  }
  if (raw.length > maxImageBytes) {
    throw new OcrLocalInputError('OBJECT_UNAVAILABLE', `图片 ${raw.length} 字节超过供应商上限 ${maxImageBytes}（不压缩、不裁剪，fail-closed）`);
  }
  const png =
    raw.length >= 24 &&
    Buffer.from(raw.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    Buffer.from(raw.subarray(12, 16)).toString('ascii') === 'IHDR' &&
    Buffer.from(raw).readUInt32BE(16) > 0 &&
    Buffer.from(raw).readUInt32BE(20) > 0;
  const jpeg = raw.length >= 4 && raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff && raw[raw.length - 2] === 0xff && raw[raw.length - 1] === 0xd9;
  if (!png && !jpeg) throw new OcrLocalInputError('OBJECT_UNAVAILABLE', '图片头部不是 PNG/JPEG（fail-closed，未发包）');
  return raw;
}

/** 契约 `LabelFields` 的文本上限（`packages/contracts/openapi.json` 的 `maxLength: 80`）。 */
const MAX_LABEL_TEXT = 80;
/** 契约 `ingredients` 的条数上限（`maxItems: 20`）。 */
const MAX_INGREDIENTS = 20;

/** 剂型闭集（只认这些；**不做同义词推断**，认不出就 `null`）。 */
const DOSAGE_FORMS = [
  '水剂',
  '乳油',
  '悬浮剂',
  '可湿性粉剂',
  '水分散粒剂',
  '微乳剂',
  '可溶液剂',
  '颗粒剂',
  '悬乳剂',
  '微囊悬浮剂',
  '种子处理悬浮剂',
  '水乳剂',
  '粉剂',
  '油悬浮剂',
  '烟剂',
  '饵剂',
] as const;

/**
 * 匹配顺序：**长名优先**。短名不得吞掉包含它的完整剂型——
 * 「悬浮剂」是「微囊悬浮剂／种子处理悬浮剂／油悬浮剂」的子串、「粉剂」是「可湿性粉剂」的子串，
 * 若按 `DOSAGE_FORMS` 的字面顺序用 `includes` 首命中即返回，独立剂型会被改写成短名
 * （监工 1021-1703 / 1021-1806 [P2]）。长度降序只是第一道保险，真正的消歧见 `dosageFormFromText`。
 */
const DOSAGE_FORMS_LONGEST_FIRST: readonly string[] = [...DOSAGE_FORMS].sort((a, b) => b.length - a.length);

const REGISTRATION_WITH_MARKER = /(?:农药登记证号|农药登记证|登记证号|登记号)\s*[:：]?\s*(PD\d{8}[A-Z]?)/;
const REGISTRATION_BARE = /\b(PD\d{8}[A-Z]?)\b/;
const NAME_WITH_MARKER = /(?:农药名称|商品名称|产品名称)\s*[:：]\s*(.+)/;
const INGREDIENT_LINE = /有效成分(?:及含量)?\s*[:：]?\s*(.+)/;
const INGREDIENT_ITEM = /^(.+?)\s*(\d+(?:\.\d+)?)\s*([%％]|克\/升|g\/L|克\/千克|g\/kg)$/u;

/** 只接受 1..80 字符的文本；超长**不做截断**（截断会改变登记号/成分含义），一律判为不可用。 */
function nullableText(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_TEXT) return null;
  return trimmed;
}

/**
 * 从识别文本里取剂型：**只认闭集里的完整名**，认不出就 `null`。
 *
 * 消歧规则（**不改写成另一个剂型**）：
 *   1. 收集闭集里每个名字的全部命中（允许同一名字多次出现）；
 *   2. 丢掉被**更长命中完整覆盖**的短名命中——「微囊悬浮剂」里的「悬浮剂」不是独立剂型；
 *   3. 剩下的命中若只指向一个名字，就取它；指向两个以上互不覆盖的独立剂型 ⇒ 判为不确定，保留缺项。
 */
function dosageFormFromText(text: string): string | null {
  const hits: Array<{ form: string; start: number; end: number }> = [];
  for (const form of DOSAGE_FORMS_LONGEST_FIRST) {
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
      hits.push({ form, start: at, end: at + form.length });
    }
  }
  const standalone = hits.filter(
    (hit) => !hits.some((other) => other.form.length > hit.form.length && other.start <= hit.start && other.end >= hit.end),
  );
  const distinct = [...new Set(standalone.map((hit) => hit.form))];
  if (distinct.length !== 1) return null;
  const [only] = distinct;
  return only ?? null;
}

/**
 * 把 OCR 检出的文本行映射成契约 `LabelFields`（**保守**，认不出即空）。
 * 四个键**必须全部出现**（`normalizeLabelFields` 要求），因此这里显式给 `null` / `[]`。
 */
export function labelFieldsFromDetections(detections: readonly string[]): {
  registration_number: string | null;
  name: string | null;
  ingredients: Array<{ name: string; content_text: string; unit_text: string }>;
  dosage_form: string | null;
} {
  const text = detections.join('\n');
  let registration: string | null = null;
  const withMarker = REGISTRATION_WITH_MARKER.exec(text);
  if (withMarker !== null) registration = nullableText(withMarker[1]);
  if (registration === null) {
    const bare = REGISTRATION_BARE.exec(text);
    if (bare !== null) registration = nullableText(bare[1]);
  }

  let name: string | null = null;
  const nameLine = NAME_WITH_MARKER.exec(text);
  if (nameLine !== null) name = nullableText(nameLine[1]);

  const ingredients: Array<{ name: string; content_text: string; unit_text: string }> = [];
  const ingredientLine = INGREDIENT_LINE.exec(text);
  const ingredientText = ingredientLine === null ? undefined : ingredientLine[1];
  if (ingredientText !== undefined) {
    for (const rawItem of ingredientText.split(/[、,，;；]/)) {
      const item = INGREDIENT_ITEM.exec(rawItem.trim());
      if (item === null) continue;
      const ingredientName = nullableText(item[1]);
      const contentText = nullableText(item[2]);
      const rawUnit = item[3];
      const unitText = rawUnit === undefined ? null : nullableText(rawUnit.replace('％', '%'));
      if (ingredientName === null || contentText === null || unitText === null) continue;
      // 名称与含量不得互相粘连（例如把「草甘膦41」当成名称）：名称里不允许出现结尾数字。
      if (/\d$/.test(ingredientName)) continue;
      ingredients.push({ name: ingredientName, content_text: contentText, unit_text: unitText });
      if (ingredients.length >= MAX_INGREDIENTS) break;
    }
  }

  // 剂型：长名优先 + 覆盖消歧（短名不得吞掉「微囊悬浮剂」这类完整剂型，监工 1021-1806 [P2]）。
  const dosageForm = dosageFormFromText(text);

  return { registration_number: registration, name, ingredients, dosage_form: dosageForm };
}

/**
 * 真实 OCR 提供者。**唯一**能触达真实发送的构造器：没有端口对象就构造不出来
 * （`RealOcrPorts` 字段全部必填，且本函数没有默认实现）。
 */
export function createLiveOcrProvider(ports: RealOcrPorts): OcrProvider {
  if (ports === null || typeof ports !== 'object') {
    throw new OcrWiringError('真实 OCR 端口缺失：真实分支默认关闭（应用装配路径必须显式给端口）');
  }
  const profile = assertLiveOcrProfile(ports.profile);
  const credentials = ports.credentials;
  if (credentials === null || typeof credentials !== 'object') throw new OcrWiringError('真实 OCR 缺少凭据三元组');
  if (typeof credentials.secretId !== 'string' || credentials.secretId.trim() === '') {
    throw new OcrWiringError('真实 OCR 缺少 secretId（同源配对，不逐字段混配、不回退）');
  }
  if (typeof credentials.secretKey !== 'string' || credentials.secretKey.trim() === '') {
    throw new OcrWiringError('真实 OCR 缺少 secretKey（同源配对，不逐字段混配、不回退）');
  }
  if (typeof credentials.sessionToken !== 'string') {
    throw new OcrWiringError('真实 OCR 临时令牌必须是字符串（长期密钥显式空串，不继承其它 token）');
  }
  if (typeof ports.authorization !== 'string' || ports.authorization.trim() === '') {
    throw new OcrWiringError('真实 OCR 缺少显式授权令牌（与闸门授权串逐字一致）');
  }
  const liveGate = ports.liveGate;
  if (liveGate === null || typeof liveGate !== 'object' || typeof liveGate.reserve !== 'function' || typeof liveGate.settle !== 'function') {
    throw new OcrWiringError('真实 OCR 缺少预算闸门（没有闸门就不构造真实分支）');
  }
  const imageSource = ports.imageSource;
  if (imageSource === null || typeof imageSource !== 'object' || typeof imageSource.read !== 'function') {
    throw new OcrWiringError('真实 OCR 缺少图片字节来源端口（没有它就拿不到要识别的图）');
  }
  const fetchImpl = ports.fetchImpl ?? globalThis.fetch;
  const now = ports.now ?? ((): number => Date.now());
  const onObservation = ports.onObservation;

  return {
    executionMode: 'real',
    modelVersion: `tencent-generalaccurateocr-${profile.apiVersion}`,
    available: true,
    unavailableReason: null,
    async extract({ jobId, mediaId, mediaRevision }) {
      // ① build（本地）——必须在 reserve 之前：本地拒绝**不占预算、不留账**。
      let image: Uint8Array;
      try {
        const raw = await imageSource.read({ jobId, mediaId, mediaRevision });
        image = requireLiveOcrImage(raw, profile.maxImageBytes);
      } catch (error) {
        // 取不到/图片不合法：不打供应商，也不把它说成供应商故障。
        return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
      }
      const body = JSON.stringify({ ImageBase64: Buffer.from(image).toString('base64') });
      const attemptKey = `${jobId}:${mediaId}#${mediaRevision}`;

      // ② reserve（闸门，必须在签名与建连之前）。
      let ticket;
      try {
        ticket = await liveGate.reserve({ capability: 'ocr', authorization: ports.authorization, attemptKey });
      } catch (error) {
        return { kind: 'failed', code: liveGateRefusalToErrorCode(error) };
      }

      // ③ sign ④ send（恰好一次）⑤ settle（无论成败）。
      const outcome = await sendLiveOcrOnce({
        endpoint: profile.endpoint,
        action: profile.action,
        apiVersion: profile.apiVersion,
        region: profile.region,
        timeoutMs: profile.timeoutMs,
        body,
        imageBytes: image.length,
        credentials,
        fetchImpl,
        now,
      });
      const observed = outcome.observation;
      await liveGate.settle(ticket, {
        state: observed.state,
        // 未取得账单 ⇒ 恒为 null，绝不猜一个数。
        actualChargeCny: null,
        providerErrorCode: observed.providerErrorCode,
        resultMayHaveBeenProcessed: observed.resultMayHaveBeenProcessed,
      });
      onObservation?.(observed);
      if (observed.state !== 'BUSINESS_RESPONSE' || outcome.detections === null) {
        return { kind: 'failed', code: observed.errorCode ?? 'PROVIDER_OUTCOME_UNKNOWN' };
      }
      return { kind: 'completed', fields: labelFieldsFromDetections(outcome.detections) };
    },
  };
}

interface LiveOcrSendResult {
  observation: LiveOcrObservation;
  /** 检出的文本行（**只在成功时**给出；内容不进观测/台账）。 */
  detections: string[] | null;
}

const REQUEST_ID_PATTERN = /^[a-fA-F0-9-]{16,64}$/;
/** 检出文本行上限（防畸形载荷撑爆内存；正常标签远小于此）。 */
const MAX_DETECTIONS = 200;

function ocrObservation(partial: Partial<LiveOcrObservation> & { state: ProviderCallState }): LiveOcrObservation {
  return {
    capability: 'ocr',
    errorCode: null,
    providerErrorCode: null,
    httpStatus: null,
    requestId: null,
    detectionCount: null,
    detectedCharacters: null,
    imageBytes: null,
    resultMayHaveBeenProcessed: true,
    elapsedMs: 0,
    endpointAsserted: false,
    sendAttempts: 0,
    ...partial,
  };
}

/**
 * **sign + send（恰好一次）+ 解析**。返回安全观测，**永不抛错**（任何异常都落成「结果不可判定」），
 * 因此调用方总能在 `finally` 语义下完成 `settle`。
 */
async function sendLiveOcrOnce(input: {
  endpoint: string;
  action: string;
  apiVersion: string;
  region: string;
  timeoutMs: number;
  body: string;
  imageBytes: number;
  credentials: LiveOcrCredentials;
  fetchImpl: typeof fetch;
  now: () => number;
}): Promise<LiveOcrSendResult> {
  const startedAt = input.now();
  const failed = (partial: Partial<LiveOcrObservation> & { state: ProviderCallState }): LiveOcrSendResult => ({
    observation: ocrObservation(partial),
    detections: null,
  });

  // 发送前的端点再断言（纵深防御；配置侧已有一层）。
  try {
    const parsed = new URL(input.endpoint);
    const expectedHost = `${parsed.hostname.split('.')[0]}.tencentcloudapi.com`;
    const allowlisted =
      input.endpoint === LIVE_OCR_FROZEN_PROFILE.endpoint &&
      parsed.host === expectedHost &&
      parsed.search === '' &&
      parsed.pathname === '/';
    if (!allowlisted) return failed({ state: 'OUTCOME_UNKNOWN', sendAttempts: 0, elapsedMs: input.now() - startedAt });
  } catch {
    return failed({ state: 'OUTCOME_UNKNOWN', sendAttempts: 0, elapsedMs: input.now() - startedAt });
  }

  const headers = signTc3Request({
    endpoint: input.endpoint,
    action: input.action,
    apiVersion: input.apiVersion,
    region: input.region,
    timestampSeconds: Math.floor(startedAt / 1000),
    body: input.body,
    credentials: input.credentials,
  });

  let response: Response;
  let sendAttempts = 0;
  try {
    sendAttempts = 1;
    response = await input.fetchImpl(input.endpoint, {
      method: 'POST',
      body: input.body,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return failed({
      state: timedOut ? 'TIMEOUT' : 'OUTCOME_UNKNOWN',
      errorCode: timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_OUTCOME_UNKNOWN',
      endpointAsserted: true,
      sendAttempts,
      imageBytes: input.imageBytes,
      elapsedMs: input.now() - startedAt,
    });
  }

  if (!response.ok) {
    return failed({
      state: 'HTTP_ERROR',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      endpointAsserted: true,
      sendAttempts,
      imageBytes: input.imageBytes,
      elapsedMs: input.now() - startedAt,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return failed({
      state: 'OUTCOME_UNKNOWN',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      endpointAsserted: true,
      sendAttempts,
      imageBytes: input.imageBytes,
      elapsedMs: input.now() - startedAt,
    });
  }
  const result = (payload as { Response?: unknown } | null)?.Response;
  if (result === null || typeof result !== 'object') {
    return failed({
      state: 'OUTCOME_UNKNOWN',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      endpointAsserted: true,
      sendAttempts,
      imageBytes: input.imageBytes,
      elapsedMs: input.now() - startedAt,
    });
  }
  const fields = result as Record<string, unknown>;
  const rawRequestId = fields['RequestId'];
  const requestId = typeof rawRequestId === 'string' && REQUEST_ID_PATTERN.test(rawRequestId) ? rawRequestId : null;

  // 供应商业务错误：**原样保留**原始错误码（先于 RequestId 判定，避免丢掉分类）。
  const errorObject = fields['Error'] as { Code?: unknown } | null | undefined;
  const rawCode = errorObject?.Code;
  if (typeof rawCode === 'string' && rawCode !== '') {
    const safeCode = /^[A-Za-z0-9.]{1,100}$/.test(rawCode) ? rawCode : 'UNRECOGNIZED_ERROR';
    return failed({
      state: 'SERVICE_ERROR',
      errorCode: providerErrorCodeToErrorCode(safeCode),
      providerErrorCode: safeCode,
      httpStatus: response.status,
      requestId,
      endpointAsserted: true,
      sendAttempts,
      imageBytes: input.imageBytes,
      elapsedMs: input.now() - startedAt,
    });
  }

  if (requestId === null) {
    // 供应商确实干活了（可能已计费）却没给出可追溯凭据 ⇒ 结果未知，绝不当成功。
    return failed({
      state: 'RESPONSE_EVIDENCE_INCOMPLETE',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      endpointAsserted: true,
      sendAttempts,
      imageBytes: input.imageBytes,
      elapsedMs: input.now() - startedAt,
    });
  }

  const rawDetections = fields['TextDetections'];
  if (!Array.isArray(rawDetections) || rawDetections.length > MAX_DETECTIONS) {
    return failed({
      state: 'RESPONSE_EVIDENCE_INCOMPLETE',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      requestId,
      endpointAsserted: true,
      sendAttempts,
      imageBytes: input.imageBytes,
      elapsedMs: input.now() - startedAt,
    });
  }
  const detections: string[] = [];
  for (const item of rawDetections) {
    const detected = (item as { DetectedText?: unknown } | null)?.DetectedText;
    if (typeof detected !== 'string') continue;
    const trimmed = detected.trim();
    if (trimmed !== '') detections.push(trimmed);
  }
  const detectedCharacters = detections.reduce((total, line) => total + [...line].length, 0);

  return {
    observation: ocrObservation({
      state: 'BUSINESS_RESPONSE',
      httpStatus: response.status,
      requestId,
      detectionCount: detections.length,
      detectedCharacters,
      imageBytes: input.imageBytes,
      resultMayHaveBeenProcessed: true,
      endpointAsserted: true,
      sendAttempts,
      elapsedMs: input.now() - startedAt,
    }),
    detections,
  };
}

// ---------------------------------------------------------------------------
// 装配：被校验配置 → 端口。产品装配唯一入口（`createOcrProvider` 内部调用）。
// ---------------------------------------------------------------------------

/**
 * **明确未接线**的图片字节来源：对象存储属媒体域，本片未接线。
 * 它诚实返回 `null`（而不是伪造字节、也不是读本地磁盘）⇒ 适配器按「取不到字节」fail-closed。
 */
export function createUnwiredImageSource(reason: string): OcrImageSource {
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed，不伪造字节）`,
    async read() {
      return null;
    },
  };
}

/**
 * 由 `config.aiProviders.ocr`（`loadConfig` 的产物）构造真实 OCR 提供者。
 *
 * - 端口在这一处**一次性**装配：被校验配置快照、内存凭据、进程内预算闸门、字节来源；
 * - `imageSource` 由调用方注入（产品路径＝未接线来源；取证工具＝合成样张）；
 * - 构造失败（配置不合法/缺字段）**不**抛到请求期：调用方（`createOcrProvider`）据此回落到
 *   接线前的 fail-closed 真实提供者，绝不降级成替身。
 */
export function createLiveOcrProviderFromConfig(
  config: OcrProviderConfig,
  options: {
    imageSource: OcrImageSource;
    authorization: string;
    liveGate?: RealOcrPorts['liveGate'];
    fetchImpl?: typeof fetch;
    now?: () => number;
    onObservation?: (observation: LiveOcrObservation) => void;
  },
): OcrProvider {
  return createLiveOcrProvider({
    liveGate:
      options.liveGate ??
      createProcessGateForOcr(options.authorization),
    authorization: options.authorization,
    profile: {
      endpoint: config.endpoint,
      action: config.action,
      apiVersion: config.apiVersion,
      region: config.region,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      maxImageBytes: config.maxImageBytes,
      mediaTransport: config.mediaTransport,
    },
    credentials: config.credentials,
    imageSource: options.imageSource,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onObservation === undefined ? {} : { onObservation: options.onObservation }),
  });
}

/** 兜底闸门（同能力单价来自 `LIVE_UNIT_PRICES_CNY`，产品路径不设上限）。 */
function createProcessGateForOcr(authorization: string) {
  return createProcessLiveGate({
    authorization,
    prices: { ocr: LIVE_UNIT_PRICES_CNY.ocr },
  });
}
