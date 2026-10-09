/**
 * GY-I06 媒体模块 · 短效访问句柄签名。
 *
 * 硬红线（state-contract 第 13 行）：媒体 URL **只是短效授权访问句柄**，
 * 不能只依赖不可撤销的对象存储签名 URL；访问网关每次取图都重新核对
 * 账号、授权、媒体与内容当前版本。因此：
 *   - token 绝不放入 URL（放 access_token 字段）；
 *   - token 与**同一登录主体 + session + auth_epoch + 版本快照**绑定；
 *   - 服务端只存 token 的 hash（见 service.mjs）。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** 生成 token 摘要（服务端仅存 hash，不落明文 token）。 */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 创建 HMAC 签名令牌工厂。
 * @param {string} secret 注入的签名密钥（不得写入仓库/日志）
 */
export function createAccessTokenFactory(secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('必须注入长度 >= 16 的签名密钥');
  }
  return {
    /** payload -> token（base64url(payload).hmac）。 */
    issue(payload) {
      const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      const sig = createHmac('sha256', secret).update(body).digest('base64url');
      return `${body}.${sig}`;
    },
    /** token -> payload；签名不符/格式错误返回 null（不抛错）。 */
    verify(token) {
      if (typeof token !== 'string' || token.length > 4096) return null;
      const dot = token.indexOf('.');
      if (dot <= 0) return null;
      const body = token.slice(0, dot);
      const sig = token.slice(dot + 1);
      const expect = createHmac('sha256', secret).update(body).digest('base64url');
      const a = Buffer.from(sig);
      const b = Buffer.from(expect);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      try {
        return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
    },
    hash: hashToken,
  };
}
