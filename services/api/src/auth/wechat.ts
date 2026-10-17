/**
 * 微信登录身份换取（服务端唯一入口）。
 *
 * 契约 loginWechat：仅凭 `wx.login` 的 code 在服务端交换身份；
 * **不信客户端 openid/owner/role**（请求体 schema `additionalProperties:false`，多余字段 400 拒绝）。
 * 状态协议：微信 code 单次交换；不强制手机号。
 *
 * 两种模式：
 * - `real`：调用微信 `sns/jscode2session`，凭据只从服务端环境变量读取（WECHAT_APP_ID/SECRET）。
 * - `stub` / `preset_demo`：**合成**身份（把 code 派生为稳定 subject），不发起真实网络调用，
 *   用于无正式 AppID 环境下的接线与回归；响应 meta.execution_mode 如实标注，不当真实登录。
 *
 * 隐私：不保存可逆 openid。users.wechat_subject_lookup 存 HMAC-SHA256(密钥, appId:openid)，
 *       wechat_subject_cipher 本任务留空（不保留可逆凭据）。
 *
 * 未验证说明：`real` 分支的正式 AppID 实测**不在本 PR 声称完成**（属 GY-I25 凭据通道）。
 */
import { createHmac } from 'node:crypto';
import { ApiError } from '../errors.ts';
import type { ExecutionMode } from '../contract.ts';

export interface WechatExchangeResult {
  /** HMAC-SHA256 摘要（hex，32 字节）→ 映射 users.wechat_subject_lookup (bytea)。 */
  subjectLookupHex: string;
}

export interface WechatIdentityProvider {
  /** 用 code 换取服务端身份；失败抛出契约 ApiError。 */
  exchange(code: string): Promise<WechatExchangeResult>;
}

const WECHAT_CODE2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session';
const EXCHANGE_TIMEOUT_MS = 8000;

export interface WechatProviderOptions {
  executionMode: ExecutionMode;
  appId: string | null;
  appSecret: string | null;
  /** HMAC 密钥（来自 SESSION_SIGNING_KEY）；非 real 模式使用固定桩密钥。 */
  lookupKey: string;
  /** 可注入 fetch，便于测试；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export const STUB_LOOKUP_KEY = 'gengyun-stub-session-signing-key';

/**
 * 身份摘要：HMAC-SHA256(lookupKey, `${appId}\n${openid}`) hex。
 * 只存不可逆摘要（users.wechat_subject_lookup），不保留可逆 openid。
 * 导出以便回归按同一算法合成身份，不用于对外暴露。
 */
export function computeSubjectLookup(lookupKey: string, appId: string, openid: string): string {
  return createHmac('sha256', lookupKey).update(`${appId}\n${openid}`, 'utf8').digest('hex');
}

/** 合成模式下的固定 appId 标记（非真实 AppID）。 */
export const STUB_APP_ID = 'stub-app';

/** 合成模式下 code → 稳定 subject 的派生前缀。 */
export const STUB_OPENID_PREFIX = 'stub:';

function subjectLookup(lookupKey: string, appId: string, openid: string): string {
  return computeSubjectLookup(lookupKey, appId, openid);
}

export function createWechatIdentityProvider(options: WechatProviderOptions): WechatIdentityProvider {
  const fetchImpl = options.fetchImpl ?? fetch;

  if (options.executionMode !== 'real') {
    // 合成模式：code → 稳定 subject（同一 code 得到同一用户，便于回归；不代表真实身份）。
    return {
      async exchange(code: string): Promise<WechatExchangeResult> {
        return { subjectLookupHex: subjectLookup(options.lookupKey, STUB_APP_ID, `${STUB_OPENID_PREFIX}${code}`) };
      },
    };
  }

  return {
    async exchange(code: string): Promise<WechatExchangeResult> {
      const appId = options.appId;
      const appSecret = options.appSecret;
      if (appId === null || appSecret === null) {
        throw new ApiError('PROVIDER_UNAVAILABLE', '微信登录未配置（服务端缺少 AppID/AppSecret）', {
          // 未配置 AppID/AppSecret ＝未接线（需运维改配置）：retryable 必须为 false。
          retryable: false,
        });
      }

      const url =
        `${WECHAT_CODE2SESSION_URL}?appid=${encodeURIComponent(appId)}` +
        `&secret=${encodeURIComponent(appSecret)}` +
        `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
      let payload: unknown;
      try {
        const response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
        if (!response.ok) {
          throw new ApiError('PROVIDER_UNAVAILABLE', '微信登录服务不可用', { retryable: true });
        }
        payload = await response.json();
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (controller.signal.aborted) {
          throw new ApiError('PROVIDER_TIMEOUT', '微信登录服务超时', { retryable: true });
        }
        // 网络异常时无法确定对方是否已受理 → 不谎称失败可安全重试。
        throw new ApiError('PROVIDER_OUTCOME_UNKNOWN', '微信登录结果未知', { retryable: true });
      } finally {
        clearTimeout(timer);
      }

      const body = (payload ?? {}) as { openid?: unknown; errcode?: unknown; errmsg?: unknown };
      const openid = typeof body.openid === 'string' ? body.openid : null;

      if (openid === null) {
        const errcode = typeof body.errcode === 'number' ? body.errcode : null;
        // 45011：微信侧频率限制；40029：code 无效/已使用；-1：系统繁忙。
        if (errcode === 45011) {
          throw new ApiError('RATE_LIMITED', '微信登录请求过于频繁', { retryable: true });
        }
        if (errcode === 40029 || errcode === 40163) {
          throw new ApiError('INVALID_REQUEST', '微信登录凭证无效或已使用');
        }
        throw new ApiError('PROVIDER_OUTCOME_UNKNOWN', '微信登录未返回身份', { retryable: true });
      }

      return { subjectLookupHex: subjectLookup(options.lookupKey, appId, openid) };
    },
  };
}
