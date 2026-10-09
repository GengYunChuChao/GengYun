/**
 * 独立后台鉴权客户端（GY-I04）。
 *
 * 约束（ADR-001 / 契约）：
 * - 后台会话与用户端会话分离（audience=admin，独立令牌表），令牌不可互用。
 * - 令牌只保存在 sessionStorage，不写日志、不放进 URL；不承载任何密钥。
 * - 契约：POST/GET `/admin/auth/session`、POST `/admin/auth/logout`（Idempotency-Key 必填）。
 *
 * 状态：**服务端**后台鉴权接口已实现并有回归（见 services/api/src/routes/admin-auth.ts）；
 * 控制台业务页面（账号、资料来源、功能开关等）属 GY-I18，本骨架仍无业务页面。
 * 未登录不伪造“已登录”：任何失败如实抛错或返回 null。
 */

export interface AdminSession {
  accessToken: string;
  expiresAt: string;
  /** GET /admin/auth/session 返回的 scope；登录响应不含 scope，需再次读取。 */
  scopes: string[];
}

/** 后台鉴权接口（服务端）已实现；控制台业务页面未实现。 */
export const ADMIN_AUTH_API_IMPLEMENTED = true;

/** API 基地址来自公开构建变量；不承载任何密钥。 */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

const STORAGE_KEY = 'gengyun.admin.session';

// Login/logout share one intent sequence. Advance when the intent starts, before any await.
let sessionIntent = 0;

function isCurrentRequest(intent: number, token: string | null): boolean {
  return intent === sessionIntent && readToken() === token;
}

/** 幂等键（>=8 字符，契约要求）；不含身份信息。 */
function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `admin-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function readToken(): string | null {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY);
    return value === null || value === '' ? null : value;
  } catch {
    return null;
  }
}

function writeToken(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // 存储不可用时视为未登录：loadAdminSession 会返回 null，不谎称已登录。
  }
}

function clearToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}

interface SessionInfoBody {
  data?: { expires_at?: unknown; scopes?: unknown };
}

async function fetchSession(token: string): Promise<AdminSession | null> {
  const response = await fetch(`${API_BASE_URL}/admin/auth/session`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'omit',
  });
  if (!response.ok) return null;
  const body = (await response.json()) as SessionInfoBody;
  const data = body.data;
  if (data === undefined || typeof data.expires_at !== 'string') return null;
  const scopes = Array.isArray(data.scopes) ? data.scopes.filter((s): s is string => typeof s === 'string') : [];
  return { accessToken: token, expiresAt: data.expires_at, scopes };
}

/** 读取当前后台会话：无令牌或服务端判定失效 → null（不猜测、不伪造）。 */
export async function loadAdminSession(): Promise<AdminSession | null> {
  const intent = sessionIntent;
  const token = readToken();
  if (token === null) return null;
  try {
    const session = await fetchSession(token);
    // Also check after JSON parsing: an old success must not return an obsolete session.
    if (!isCurrentRequest(intent, token)) return null;
    if (session === null) clearToken();
    return session;
  } catch {
    return null;
  }
}

/** 后台登录：login_name + password；失败如实抛错，不返回假会话。 */
export async function signInAdmin(credentials: { loginName: string; password: string }): Promise<AdminSession> {
  const intent = ++sessionIntent;
  const token = readToken();
  const ensureCurrent = (): void => {
    if (!isCurrentRequest(intent, token)) throw new Error('后台登录请求已失效');
  };
  try {
    const response = await fetch(`${API_BASE_URL}/admin/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': newIdempotencyKey() },
      credentials: 'omit',
      body: JSON.stringify({ login_name: credentials.loginName, password: credentials.password }),
    });
    const body = (await response.json().catch(() => null)) as
      | { data?: { access_token?: unknown; expires_at?: unknown }; error?: { code?: unknown } }
      | null;
    ensureCurrent();
    const data = body?.data;
    if (!response.ok || data === undefined || typeof data.access_token !== 'string') {
      const code = body?.error !== undefined && typeof body.error.code === 'string' ? body.error.code : `HTTP ${response.status}`;
      throw new Error(`后台登录失败：${code}`);
    }
    writeToken(data.access_token);
    return {
      accessToken: data.access_token,
      expiresAt: typeof data.expires_at === 'string' ? data.expires_at : '',
      scopes: [],
    };
  } catch (error) {
    // A late failure also belongs to the superseded request, not the current login.
    ensureCurrent();
    throw error;
  }
}

/**
 * 后台退出：先清本地令牌，再请求服务端撤销。
 * 服务端请求失败时本地已登出，但**不谎称服务端会话已撤销**（无返回值即未确认）。
 */
export async function signOutAdmin(): Promise<void> {
  ++sessionIntent;
  const token = readToken();
  clearToken();
  if (token === null) return;
  try {
    await fetch(`${API_BASE_URL}/admin/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': newIdempotencyKey() },
      credentials: 'omit',
    });
  } catch {
    // 本地已清除；服务端会话是否撤销未确认。
  }
}
