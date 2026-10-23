/**
 * GY-I14（#14）· 真实**文本**审核端口（腾讯云 TMS `TextModeration`）。
 *
 * 这是 `provider.ts` 里点名的那类"真实适配器"的**文本**一份。它**只交付库件**：
 *   - `provider.ts` 的 `resolveModerationPorts` 未被改动 ⇒ `real` 仍恒 `ports: {}` / `fail_closed: true`；
 *   - `app.ts` / `server.ts` **不 import** 本文件 ⇒ 应用装配路径**没有**构造它的位置。
 * 真正打开真实外呼需要另一次显式、可审查的接线变更（改装配点 + 供应商付费授权）。
 *
 * 顺序（前两步是本地动作，**先于任何外呼**）：
 *   build(本地) → sign(TC3) → send(**恰好一次**，零重试) → 解析/失败分类。
 *
 * 三条硬约束：
 * 1. **凭据/fetch/时钟/超时/BizType/endpoint 全部由调用方显式注入**，本文件不读 `process.env`、
 *    不内置默认凭据、不读私密文件、不打印凭据。
 * 2. **失败绝不产出通过**：一切失败都抛 `ModerationPortError`（闭集类别 + 固定短标签），
 *    `Review` 与未知 `Suggestion` 一律 `unsure`。
 * 3. **回报只有闭集三键**（`label` / `reason_codes` / `summary`），控制类字段一个都出不去
 *    （白名单重建 + `nonbypass.ts` 的整条扫描；`provider.ts` 的 `guardModelPort` 是第二道）。
 */

import {
  MODERATION_VENDOR_ACTIONS,
  MODERATION_VENDOR_REGION,
  ModerationPortError,
  ModerationWiringError,
  assertModerationCredentials,
  assertModerationPolicyOpen,
  assertModerationTextProfile,
  type ModerationLivePort,
  type ModerationPortSeams,
  type ModerationVerdict,
  type RealModerationTextPorts,
} from './live-ports.ts';
import { resolveModerationVendorTarget, signModerationTc3Request } from './live-tc3.ts';
import {
  moderationFailureFromHttpStatus,
  moderationFailureFromThrown,
  moderationVerdictFromVendorPayload,
  requireModerationText,
} from './live-vendor.ts';

/**
 * 文本审核的固定请求字段（口径＝`tools/ai-config.mjs:prepareOfflineRequest()` 对
 * `moderationText` 的构造：`Content` 是 UTF-8 正文的 base64，`Type` 恒 `TEXT`，
 * `SourceLanguage` 恒 `zh`）。这三项**不开放注入**：它们不是授权面，而是供应商剖面的一部分。
 */
const TMS_REQUEST_TYPE = 'TEXT';
const TMS_SOURCE_LANGUAGE = 'zh';

/** 端口声明的模型版本（`Moderation.model_version` 的上界是 80 字符）。 */
export const LIVE_MODERATION_TEXT_MODEL_VERSION = 'tencent-textmoderation-2020-12-29';

/**
 * 构造真实文本审核端口。**唯一**能触达真实发送的构造器：
 * 策略未核验 / 配置不合法 / 缺凭据 / 端点不在白名单 —— 任一不成立即**构造硬拒**，
 * 拿不到端口对象也就发不出请求。
 */
export function createLiveModerationTextPort(ports: RealModerationTextPorts): ModerationLivePort {
  if (ports === null || typeof ports !== 'object') {
    throw new ModerationWiringError('真实文本审核端口缺失（真实分支默认关闭，应用装配路径必须显式给端口）');
  }
  // ① 策略闸门（硬拒）：两个标志都必须为 `true`，没有"先跑起来再说"的分支。
  const policy = assertModerationPolicyOpen(ports.policy);
  // ② 被校验配置快照（纵深防御；配置侧已挡一层）。
  const profile = assertModerationTextProfile(ports.profile);
  // ③ 端点审计（唯一允许的生产端点，或离线用例的回环端点）：形态不对就在这里硬拒。
  const target = resolveModerationVendorTarget(profile.endpoint, 'tms');
  // ④ 凭据三元组（只判存在，不读值出去）。
  const credentials = assertModerationCredentials(ports.credentials);
  const fetchImpl = ports.fetchImpl ?? globalThis.fetch;
  const now = ports.now ?? ((): number => Date.now());
  const seams: ModerationPortSeams = { fetchImpl, credentials, liveGate: policy, now };

  return {
    kind: 'tms',
    model_version: LIVE_MODERATION_TEXT_MODEL_VERSION,
    provider: {
      biz_type: profile.bizType,
      // 走到这里说明 `policySelectionVerified === true`（见 `assertModerationPolicyOpen`），
      // 合流层的 `MODEL_BIZTYPE_UNVERIFIED` 闸门因此只在"策略没核验"时触发。
      biz_type_selection_verified: true,
      synthetic: false,
      timeout_ms: profile.timeoutMs,
    },
    seams,
    async evaluate(request: unknown): Promise<ModerationVerdict> {
      // ① build（本地）——本地拒绝不产生任何外呼。
      const text = requireModerationText(request);
      const body = JSON.stringify({
        Content: Buffer.from(text, 'utf8').toString('base64'),
        BizType: profile.bizType,
        Type: TMS_REQUEST_TYPE,
        SourceLanguage: TMS_SOURCE_LANGUAGE,
      });
      const frozen = MODERATION_VENDOR_ACTIONS.tms;
      // ② sign：签名对象是**上面那串字节**，同一个字符串直接作为 `init.body`（不做二次序列化）。
      const headers = signModerationTc3Request({
        target,
        action: frozen.action,
        apiVersion: frozen.apiVersion,
        region: MODERATION_VENDOR_REGION,
        timestampSeconds: Math.floor(now() / 1000),
        body,
        credentials,
      });
      // ③ send：恰好一次，零重试；不跟随重定向（跟随会把待审内容送去另一个 host）。
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
      // ④ 解析：非 JSON / 缺 `Response` ⇒ port_error（"我们不知道" ≠ "没检出问题"）。
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ModerationPortError('port_error', 'bad_json', {
          httpStatus: response.status,
          resultMayHaveBeenProcessed: true,
        });
      }
      return moderationVerdictFromVendorPayload({ payload, httpStatus: response.status });
    },
  };
}
