/**
 * GY-I14（#14）· 真实审核供应商的 **TC3-HMAC-SHA256 签名**（`tms` 与 `ims` 共用这一份）。
 *
 * 三个坑（与 `services/api/src/tts/tc3.ts` 同口径，逐条落实）：
 * 1. **签名绑定实际发出的字节**：调用方必须先 `JSON.stringify` **一次**得到字符串，
 *    同一字符串既用于签名也作为 `init.body`；**绝不**让 HTTP 客户端二次序列化。
 * 2. **`X-TC-Region` 恒取被校验配置**（本片锁 `ap-shanghai`），不取调用方运行期入参。
 * 3. **凭据三元组同源**：审核用共享配对；临时令牌与它同源，长期密钥显式空串。
 *
 * 为什么这里是一份**独立的**实现，而不是 `import { signTc3Request } from '../tts/tc3.ts'`：
 * 那份实现把 TC3 的 service 名从端点主机名的第一段取（`tms.tencentcloudapi.com` → `tms`），
 * 这对生产端点是对的，但**无法表达 loopback 端点**——离线用例必须让请求真的落到
 * `127.0.0.1:<随机端口>` 上的假服务器（那是本片唯一能证明"签名绑定实际字节"的办法），
 * 而 `127.0.0.1` 的第一段是 `127`，会得到 `127.tencentcloudapi.com` 这个既不是生产、也不是
 * 实际 Host 的值。本片因此显式把 **service 名与 host 分开**：service 由端口类别决定、
 * host 由端点实际主机决定。生产口径与 `tts/tc3.ts` **逐字节一致**（有用例逐字比对）。
 *
 * ⛔ 本文件只用 `node:crypto`（不新增任何依赖）、不含任何凭据值、不打印任何头部值。
 */

import { createHash, createHmac } from 'node:crypto';

import { MODERATION_VENDOR_ENDPOINTS, ModerationWiringError, type ModerationVendorKind } from './live-ports.ts';

/** 唯一允许的签名算法（Tencent Cloud API v3）。 */
export const MODERATION_TC3_ALGORITHM = 'TC3-HMAC-SHA256';

/** 参与签名的头部（顺序即 `SignedHeaders` 的值，**必须**小写且有序）。 */
export const MODERATION_TC3_SIGNED_HEADERS = 'content-type;host';

/** 唯一的请求体内容类型。 */
export const MODERATION_TC3_CONTENT_TYPE = 'application/json';

/** 端点审计结论的分类。 */
export type ModerationEndpointKind = 'production' | 'loopback';

/** 一次请求的 TC3 目标（service 与 host 分开，见文件头注释）。 */
export interface ModerationVendorTarget {
  /** 实际请求地址（逐字等于被校验配置给的端点）。 */
  readonly endpoint: string;
  /** TC3 签名作用域里的 service（= 端口类别）。 */
  readonly service: ModerationVendorKind;
  /** `host` 头部与 canonical request 里的 host。 */
  readonly host: string;
  readonly kind: ModerationEndpointKind;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * loopback 端点只认这一种字面形态：`http://127.0.0.1:<1024..65535>`（无路径/查询/片段）。
 *
 * 端口段以 `[1-9]` 开头 ⇒ **任何前导零写法一律拒绝**（`01024`、`041234`、`000080` 都不匹配）。
 * 不能只靠 `Number()` 落区间：`Number('01024') === 1024` 会让"唯一字面形态"名不副实。
 */
const LOOPBACK_ENDPOINT_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})$/;

/**
 * **端点审计**：只允许两种端点。
 *
 * 1. `https://<service>.tencentcloudapi.com`（`service` 必须是本端口的类别，逐字比对
 *    `MODERATION_VENDOR_ENDPOINTS`）——生产唯一形态；
 * 2. `http://127.0.0.1:<port>`——**仅离线性**：回环目的地不可能把待审内容外泄给第三方，
 *    因此允许它是安全的；它存在的唯一理由是让离线用例能把请求打到本地假服务器上，
 *    从而真正校验"签名的对象是实际发出的那串字节"。生产装配**不会**注入它。
 *
 * 其余任何形态（别的协议、别的回环写法、带路径/查询、端口不在区间内）一律拒绝构造/发送。
 */
export function resolveModerationVendorTarget(endpoint: unknown, service: ModerationVendorKind): ModerationVendorTarget {
  if (typeof endpoint !== 'string' || endpoint === '') {
    throw new ModerationWiringError('真实审核端口缺少 endpoint（fail-closed，未发包）');
  }
  const production = MODERATION_VENDOR_ENDPOINTS[service];
  if (endpoint === production) {
    return { endpoint, service, host: `${service}.tencentcloudapi.com`, kind: 'production' };
  }
  const loopback = LOOPBACK_ENDPOINT_PATTERN.exec(endpoint);
  if (loopback !== null) {
    const port = Number(loopback[1]);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
      return { endpoint, service, host: `127.0.0.1:${port}`, kind: 'loopback' };
    }
  }
  throw new ModerationWiringError(
    `真实审核端点的 endpoint 不在白名单（只允许 ${production} 或 http://127.0.0.1:<1024..65535>，端口不得有前导零）⇒ fail-closed，未发包`,
  );
}

/**
 * TC3 canonical request（**先算它，再算待签串**）。
 *
 * 形状固定为 `POST /` + 空查询串 + 两个签名头（`content-type;host`）+ 请求体的 sha256。
 * 返回的字符串**不含任何凭据**，可以直接在用例里逐字比对。
 */
export function buildModerationCanonicalRequest(input: { host: string; body: string }): string {
  return (
    'POST\n' +
    '/\n' +
    '\n' +
    `content-type:${MODERATION_TC3_CONTENT_TYPE}\n` +
    `host:${input.host}\n` +
    '\n' +
    MODERATION_TC3_SIGNED_HEADERS +
    '\n' +
    sha256Hex(input.body)
  );
}

/** 待签串（`TC3-HMAC-SHA256\n<timestamp>\n<scope>\n<sha256(canonicalRequest)>`）。 */
export function buildModerationStringToSign(input: {
  timestampSeconds: number;
  date: string;
  service: ModerationVendorKind;
  canonicalRequest: string;
}): string {
  return (
    `${MODERATION_TC3_ALGORITHM}\n` +
    `${input.timestampSeconds}\n` +
    `${input.date}/${input.service}/tc3_request\n` +
    sha256Hex(input.canonicalRequest)
  );
}

export interface ModerationTc3SignInput {
  readonly target: ModerationVendorTarget;
  readonly action: string;
  readonly apiVersion: string;
  readonly region: string;
  /** Unix 秒（整数）。 */
  readonly timestampSeconds: number;
  /** **将要发出的那串字节**（已序列化的请求体字符串）。 */
  readonly body: string;
  readonly credentials: { readonly secretId: string; readonly secretKey: string; readonly sessionToken: string };
}

/**
 * 产出请求头。**只**返回头部，不含任何日志输出。
 *
 * `Authorization` 里含 SecretId ⇒ 调用方绝不得打印该字段，也不得把它写进证据页
 * （用例只断言它的**结构**与**签名**，且用独立第二实现复算）。
 */
export function signModerationTc3Request(input: ModerationTc3SignInput): Record<string, string> {
  const { target } = input;
  const date = new Date(input.timestampSeconds * 1000).toISOString().slice(0, 10);
  const scope = `${date}/${target.service}/tc3_request`;
  const canonicalRequest = buildModerationCanonicalRequest({ host: target.host, body: input.body });
  const stringToSign = buildModerationStringToSign({
    timestampSeconds: input.timestampSeconds,
    date,
    service: target.service,
    canonicalRequest,
  });
  const secretDate = createHmac('sha256', `TC3${input.credentials.secretKey}`).update(date).digest();
  const secretService = createHmac('sha256', secretDate).update(target.service).digest();
  const secretSigning = createHmac('sha256', secretService).update('tc3_request').digest();
  const signature = createHmac('sha256', secretSigning).update(stringToSign).digest('hex');

  return {
    'Content-Type': MODERATION_TC3_CONTENT_TYPE,
    Host: target.host,
    Authorization:
      `${MODERATION_TC3_ALGORITHM} Credential=${input.credentials.secretId}/${scope}, ` +
      `SignedHeaders=${MODERATION_TC3_SIGNED_HEADERS}, Signature=${signature}`,
    'X-TC-Action': input.action,
    'X-TC-Version': input.apiVersion,
    'X-TC-Region': input.region,
    'X-TC-Timestamp': String(input.timestampSeconds),
    ...(input.credentials.sessionToken === '' ? {} : { 'X-TC-Token': input.credentials.sessionToken }),
  };
}
