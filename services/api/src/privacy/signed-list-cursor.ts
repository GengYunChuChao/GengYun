/**
 * 私有列表的**签名游标**引擎（唯一实现）。
 *
 * ## 为什么单独一个文件
 * 本仓此前有四个逐字同形的游标实现（`privacy/consent-pagination.ts`、`profile/pagination.ts`、
 * `knowledge/pagination.ts`、以及各域 service 内的私有 `sign()`）。本片新增 `GET /me/exports`
 * 时**不新造第二套分页**：把 `consent-pagination.ts` 里的签名/解码核**原样**抽到这里，
 * 由 `consent-pagination.ts`（授权列表）与本片的外发清单共用，两侧行为逐字不变。
 *
 * ## 保证（每一处改动都必须继续成立）
 * - **域分隔**：签名输入是 `${domain}\n${value}` ⇒ 别的接口签出的游标在此**不可复用**；
 * - **主体绑定**：载荷里钉 `user` / `auth_epoch` / `kind` / `sort` / `filter`，解码时逐项比对；
 * - **固定形状**：载荷恒为 9 个键（`LIST_CURSOR_KEYS`），缺键/多键一律拒绝（防"加字段即加能力"）；
 * - **有效期**：`expires` 携带在载荷里，翻页**不延长**原游标有效期；
 * - **恒定时比较**：签名用 `timingSafeEqual`，长度/编码不符先拒绝。
 *
 * 本模块**不做**分页切片：快照切片属各域（授权列表按快照水位、外发清单按账本 keyset）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors.ts';

/** 游标有效期（与既有两个列表域逐字一致：15 分钟）。 */
export const LIST_CURSOR_TTL_MS = 15 * 60 * 1000;

/** 游标载荷的**固定**键集合（顺序即编码顺序，改动会改变签名输入）。 */
export const LIST_CURSOR_KEYS = ['v', 'kind', 'user', 'auth_epoch', 'filter', 'sort', 'watermark', 'after', 'expires'] as const;

/** 游标长度上限（契约 `components.parameters.Cursor` 的 maxLength）。 */
const CURSOR_MAX_LENGTH = 2048;

/** 一个列表域的绑定上下文（哪本账、哪个主体、哪个排序口径、用哪把钥匙签名）。 */
export interface ListCursorBinding {
  /** HMAC 域前缀（如 `consent-list/v1`）—— 域分隔的唯一来源。 */
  domain: string;
  /** 列表域标识，写进载荷并校验（如 `consents` / `exports`）。 */
  kind: string;
  /** 排序口径标识，写进载荷并校验（如 `granted_at_desc_id_desc`）。 */
  sort: string;
  /** 服务端解析出的主体（只来自会话存储，绝不来自请求体/查询）。 */
  userId: string;
  /** 会话身份版本；换登录版本后旧游标一律失效。 */
  authEpoch: number;
  /** 签名密钥；空值 ⇒ 调用方必须先判 `PROVIDER_UNAVAILABLE`（未配置签名能力）。 */
  hmacKey: string;
  /** 过滤维度；无过滤维度的列表恒为 `null`（与授权列表现状一致）。 */
  filter?: string | null;
}

/** 编码时写入载荷的三项调用方数据。 */
export interface ListCursorPayload {
  /** 翻页锚点。语义由各域定：授权列表是快照内记录 id，外发清单是账本 keyset 游标。 */
  after: string;
  /** 快照水位签名；**无快照**的 keyset 列表传 `null`（键仍在，形状不变）。 */
  watermark: string | null;
  /** 绝对到期时刻（毫秒）。 */
  expires: number;
}

/** 契约 `INVALID_CURSOR`(400)：游标不可解析/过期/主体不符/水位失效，一律同一个错误。 */
export function invalidListCursor(message: string): ApiError {
  return new ApiError('INVALID_CURSOR', message);
}

/** `${domain}\n${value}` 的 HMAC-SHA256 base64url —— 全仓唯一的签名口径。 */
export function signCursorValue(binding: ListCursorBinding, value: string): string {
  return createHmac('sha256', binding.hmacKey).update(`${binding.domain}\n${value}`).digest('base64url');
}

/** 载荷 → `base64url(payload).signature`。键顺序见 `LIST_CURSOR_KEYS`。 */
export function encodeListCursor(binding: ListCursorBinding, payload: ListCursorPayload): string {
  const encoded = Buffer.from(
    JSON.stringify({
      v: 1,
      kind: binding.kind,
      user: binding.userId,
      auth_epoch: binding.authEpoch,
      filter: binding.filter ?? null,
      sort: binding.sort,
      watermark: payload.watermark,
      after: payload.after,
      expires: payload.expires,
    }),
  ).toString('base64url');
  return `${encoded}.${signCursorValue(binding, encoded)}`;
}

/**
 * 解码并校验游标。
 *
 * @param expected.watermark 期望的快照水位签名（无快照的列表传 `null`）。
 * @param expected.afterPattern 锚点字符串的形状（授权列表是 uuid，外发清单是账本游标）。
 * @throws ApiError `INVALID_CURSOR` —— 任何一处不符都收敛到同一个错误，不泄露判定细节。
 */
export function decodeListCursor(
  binding: ListCursorBinding,
  cursor: string,
  expected: { now: number; watermark: string | null; afterPattern: RegExp; message: string },
): { after: string; expires: number } {
  const invalid = () => invalidListCursor(expected.message);
  try {
    if (typeof cursor !== 'string' || cursor.length > CURSOR_MAX_LENGTH) throw invalid();
    const [encoded, signature, extra] = cursor.split('.');
    if (!encoded || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encoded)
      || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw invalid();
    const expectedSignature = Buffer.from(signCursorValue(binding, encoded), 'base64url');
    const received = Buffer.from(signature, 'base64url');
    if (received.length !== expectedSignature.length || received.toString('base64url') !== signature
      || !timingSafeEqual(expectedSignature, received)) throw invalid();
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw invalid();
    const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).length !== LIST_CURSOR_KEYS.length
      || LIST_CURSOR_KEYS.some((key) => !Object.hasOwn(value, key))
      || value['v'] !== 1 || value['kind'] !== binding.kind || value['user'] !== binding.userId
      || value['auth_epoch'] !== binding.authEpoch || value['filter'] !== (binding.filter ?? null)
      || value['sort'] !== binding.sort || value['watermark'] !== expected.watermark
      || !Number.isSafeInteger(value['expires']) || (value['expires'] as number) <= expected.now
      || typeof value['after'] !== 'string' || !expected.afterPattern.test(value['after'])) throw invalid();
    return { after: value['after'] as string, expires: value['expires'] as number };
  } catch {
    throw invalid();
  }
}
