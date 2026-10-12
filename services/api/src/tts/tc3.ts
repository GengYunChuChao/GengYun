/**
 * GY-I13 真实 TTS 适配器 · TC3-HMAC-SHA256 签名（服务层内的独立实现）。
 *
 * 算法与 `tools/verify-tencent-live.mjs:signRequest()` **完全一致**（那份实现已被
 * `tests/tencent-live.test.mjs` 离线覆盖、并在 2026-10-04 轮经过真实调用）。
 * 本域不能 import `tools/**`（`services/api` 的 tsconfig `rootDir: src`，且服务不得依赖工具目录），
 * 因此这里是一份同口径实现；`tests/unit/tts-live-adapter.test.mjs` 用独立复算证明
 * 「签名绑定的是**实际发出的那串字节**」。
 *
 * 三个坑（规范 §2.3，逐条落实）：
 * 1. **签名绑定实际发出的字节**：调用方必须先 `JSON.stringify` **一次**得到字符串，
 *    同一字符串既用于签名也作为 `init.body`；**绝不**让 HTTP 客户端二次序列化。
 * 2. **`X-TC-Region` 恒取被校验配置**（本域锁 `ap-shanghai`），不取调用方入参。
 * 3. **凭据三元组同源**：TTS 用共享配对；临时令牌与它同源，长期密钥显式为空串。
 */
import { createHash, createHmac } from 'node:crypto';
import type { LiveTtsCredentials } from './live-ports.ts';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** `https://tts.tencentcloudapi.com` → `tts`（TC3 的 service 名）。 */
export function tc3ServiceOfEndpoint(endpoint: string): string {
  const hostname = new URL(endpoint).hostname;
  const service = hostname.split('.')[0];
  if (typeof service !== 'string' || service === '') throw new Error('TC3_ENDPOINT_INVALID');
  return service;
}

/** `<service>.tencentcloudapi.com`。 */
export function tc3HostOfService(service: string): string {
  return `${service}.tencentcloudapi.com`;
}

export interface Tc3SignInput {
  readonly endpoint: string;
  readonly action: string;
  readonly apiVersion: string;
  readonly region: string;
  /** Unix 秒（整数）。 */
  readonly timestampSeconds: number;
  /** **将要发出的那串字节**（已序列化的请求体字符串）。 */
  readonly body: string;
  readonly credentials: LiveTtsCredentials;
}

/**
 * 产出请求头。**只**返回头部，不含任何凭据值的日志输出；`Authorization` 里含 SecretId，
 * 调用方绝不得打印该字段（工具只打印方案名、作用域与签名长度）。
 */
export function signTc3Request(input: Tc3SignInput): Record<string, string> {
  const service = tc3ServiceOfEndpoint(input.endpoint);
  const host = tc3HostOfService(service);
  const date = new Date(input.timestampSeconds * 1000).toISOString().slice(0, 10);
  const scope = `${date}/${service}/tc3_request`;
  const canonical =
    'POST\n/\n\n' +
    'content-type:application/json\n' +
    `host:${host}\n\n` +
    'content-type;host\n' +
    sha256Hex(input.body);
  const signingKey = createHmac('sha256', `TC3${input.credentials.secretKey}`)
    .update(date)
    .digest();
  const serviceKey = createHmac('sha256', signingKey).update(service).digest();
  const requestKey = createHmac('sha256', serviceKey).update('tc3_request').digest();
  const signature = createHmac('sha256', requestKey)
    .update(`TC3-HMAC-SHA256\n${input.timestampSeconds}\n${scope}\n${sha256Hex(canonical)}`)
    .digest('hex');
  return {
    'Content-Type': 'application/json',
    Host: host,
    Authorization:
      `TC3-HMAC-SHA256 Credential=${input.credentials.secretId}/${scope}, ` +
      `SignedHeaders=content-type;host, Signature=${signature}`,
    'X-TC-Action': input.action,
    'X-TC-Version': input.apiVersion,
    'X-TC-Region': input.region,
    'X-TC-Timestamp': String(input.timestampSeconds),
    ...(input.credentials.sessionToken ? { 'X-TC-Token': input.credentials.sessionToken } : {}),
  };
}
