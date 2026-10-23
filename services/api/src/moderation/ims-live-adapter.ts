/**
 * GY-I14（#14）· 真实**图片**审核端口（腾讯云 IMS `ImageModeration`）。
 *
 * 与 `tms-live-adapter.ts` 同一套骨架、**复用同一份 TC3 签名**（`live-tc3.ts`）与同一套回报映射
 * （`live-vendor.ts`），只多一件本域特有的事：**图片字节来自注入端口**。
 *
 * 为什么字节必须注入：合流层给图片端口的请求里**只有不透明引用**（`media_id` /
 * `media_revision` / `mime`，见 `packages/moderation/model-ports.mjs` 的图片引用归一器），
 * 没有字节。让适配器自己去读对象存储/磁盘会把"读哪张图"变成隐式行为，因此字节来源由调用方注入；
 * 本片产品侧**尚未接线**（`createUnwiredModerationImageSource` 诚实返回 `null` ⇒ fail-closed）。
 *
 * 本域特有的三条约束：
 * 1. **2 MiB 上限按 `tools/ai-config.mjs`**（`maxImageBytes: 2097152`）：超限 fail-closed，
 *    **不压缩、不裁剪**（压缩会改变被审内容，"审过"就不再等于"发出去的那张"）。
 * 2. **多图不得"只审一张就放行"**：逐张各发一次请求，任一 `Block` ⇒ `block`，
 *    全 `Pass` 才 `pass`，其余（含 `Review`）⇒ `unsure`；张数超上界整条 fail-closed。
 * 3. 传输形态恒 `inlineBase64`（`FileContent`），与 `configurationIssues()` 的
 *    `IMAGE_LIMIT_OR_TRANSPORT_MISMATCH` 同口径。
 *
 * ⛔ 本文件不读 `process.env`、不内置默认凭据、不读文件、不打印凭据或图片字节。
 */

import {
  MODERATION_VENDOR_ACTIONS,
  MODERATION_VENDOR_REGION,
  ModerationPortError,
  ModerationWiringError,
  assertModerationCredentials,
  assertModerationImageProfile,
  assertModerationPolicyOpen,
  moderationPortRedactedView,
  snapshotModerationRecord,
  type ModerationLivePort,
  type ModerationPortSeams,
  type ModerationVerdict,
  type RealModerationImagePorts,
} from './live-ports.ts';
import { resolveModerationVendorTarget, signModerationTc3Request } from './live-tc3.ts';
import {
  imageSampleFromVendorPayload,
  moderationFailureFromHttpStatus,
  moderationFailureFromThrown,
  moderationVerdictFromImageSamples,
  requireModerationImageBytes,
  requireModerationMediaRefs,
  type ModerationMediaRefInput,
  type VendorSample,
} from './live-vendor.ts';

/** 端口声明的模型版本（`Moderation.model_version` 的上界是 80 字符）。 */
export const LIVE_MODERATION_IMAGE_MODEL_VERSION = 'tencent-imagemoderation-2020-12-29';

/**
 * 构造真实图片审核端口。与文本端口同样的**构造硬拒**：
 * 策略未核验 / 配置不合法 / 缺凭据 / 缺字节来源 / 端点不在白名单 —— 任一不成立就拿不到端口。
 */
export function createLiveModerationImagePort(ports: RealModerationImagePorts): ModerationLivePort {
  if (ports === null || typeof ports !== 'object') {
    throw new ModerationWiringError('真实图片审核端口缺失（真实分支默认关闭，应用装配路径必须显式给端口）');
  }
  const policy = assertModerationPolicyOpen(ports.policy);
  // 复制＋冻结：构造后改调用方的 profile/credentials 不再影响线上字节或超时。
  const profile = snapshotModerationRecord(assertModerationImageProfile(ports.profile));
  const target = resolveModerationVendorTarget(profile.endpoint, 'ims');
  const credentials = snapshotModerationRecord(assertModerationCredentials(ports.credentials));
  const imageSource = ports.imageSource;
  if (imageSource === null || typeof imageSource !== 'object' || typeof imageSource.read !== 'function') {
    throw new ModerationWiringError('真实图片审核缺少图片字节来源端口（没有它就拿不到要审的图）');
  }
  const fetchImpl = ports.fetchImpl ?? globalThis.fetch;
  const now = ports.now ?? ((): number => Date.now());
  const seams: ModerationPortSeams = { fetchImpl, credentials, liveGate: policy, now };
  const provider = Object.freeze({
    biz_type: profile.bizType,
    biz_type_selection_verified: true as const,
    synthetic: false as const,
    timeout_ms: profile.timeoutMs,
  });

  /**
   * 取一张图的字节并送审一次。**恰好一次**：不重试、不跟随重定向。
   * 返回该图的供应商结论摘要（只含三档字面 + 令牌 + 分数）。
   */
  async function evaluateOne(ref: ModerationMediaRefInput) {
    let raw: Uint8Array | null;
    try {
      raw = await imageSource.read({ mediaId: ref.mediaId, mediaRevision: ref.mediaRevision });
    } catch {
      throw new ModerationPortError('payload_invalid', 'image_source_threw', { resultMayHaveBeenProcessed: false });
    }
    // 取不到字节 / 超 2 MiB / 头部不是 PNG/JPEG ⇒ 本地 fail-closed，**不压缩、不裁剪**、不外呼。
    const bytes = requireModerationImageBytes(raw, profile.maxImageBytes);
    const body = JSON.stringify({
      FileContent: Buffer.from(bytes).toString('base64'),
      BizType: profile.bizType,
    });
    const frozen = MODERATION_VENDOR_ACTIONS.ims;
    const headers = signModerationTc3Request({
      target,
      action: frozen.action,
      apiVersion: frozen.apiVersion,
      region: MODERATION_VENDOR_REGION,
      timestampSeconds: Math.floor(now() / 1000),
      body,
      credentials,
    });
    let response: Response;
    try {
      response = await fetchImpl(target.endpoint, {
        method: 'POST',
        body,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(profile.timeoutMs),
      });
    } catch (error) {
      throw new ModerationPortError(moderationFailureFromThrown(error), 'send_threw', {
        resultMayHaveBeenProcessed: true,
      });
    }
    if (!response.ok) {
      throw new ModerationPortError(moderationFailureFromHttpStatus(response.status), 'http_status', {
        httpStatus: response.status,
        resultMayHaveBeenProcessed: true,
      });
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ModerationPortError('port_error', 'bad_json', {
        httpStatus: response.status,
        resultMayHaveBeenProcessed: true,
      });
    }
    return imageSampleFromVendorPayload({ payload, httpStatus: response.status });
  }

  return {
    kind: 'ims',
    model_version: LIVE_MODERATION_IMAGE_MODEL_VERSION,
    provider,
    seams,
    toJSON() {
      return moderationPortRedactedView({
        kind: 'ims',
        modelVersion: LIVE_MODERATION_IMAGE_MODEL_VERSION,
        provider,
        liveGate: policy,
      });
    },
    async evaluate(request: unknown): Promise<ModerationVerdict> {
      const refs = requireModerationMediaRefs(request);
      const samples: VendorSample[] = [];
      for (const ref of refs) {
        samples.push(await evaluateOne(ref));
      }
      return moderationVerdictFromImageSamples(samples);
    },
  };
}
