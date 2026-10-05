/**
 * 认证与会话服务（登录 / 会话 / 退出 / 后台登录 / 管理员初始化）。
 *
 * 硬约束（状态协议与契约）：
 * - 微信身份只在服务端用 `code` 换取；客户端**不可**声明 openid / 角色 / 用户 id。
 * - 会话令牌是服务端可撤销的不透明 bearer；服务端只存摘要。
 * - `auth_epoch` 由服务端权威维护；退出即撤销当前会话，账号停用/注销递增 epoch
 *   使既有会话**立即失效**。
 * - 私有归属只用服务端解析出的 `userId` 判定，绝不采信客户端声称的身份。
 *
 * 未验证说明：`real` 分支的正式 AppID 端到端实测**不在本 PR 声称完成**
 * （属 GY-I25 凭据通道）；本层只保证按契约接线与错误码。
 */
import { ApiError } from '../errors.ts';
import type { ExecutionMode } from '../contract.ts';
import type { AuthStore } from './store.ts';
import type { UserRecord } from './types.ts';
import type { WechatIdentityProvider } from './wechat.ts';
import type { IdempotencyStore } from './idempotency.ts';
import { hashPassword, verifyPassword } from './password.ts';
import {
  ADMIN_SESSION_TTL_SECONDS,
  USER_SESSION_TTL_SECONDS,
  hashToken,
  isPositiveInteger,
  mintOpaqueToken,
} from './tokens.ts';

/**
 * 后台初始管理员被授予的 scope：只覆盖本任务已契约化的后台会话操作
 * （openapi `x-scope`: session:read / session:logout）。最小权限，不预授其余能力；
 * 更细的后台账号与权限管理属 GY-I18。
 */
export const BOOTSTRAP_ADMIN_SCOPES: readonly string[] = ['session:logout', 'session:read'];

/** 登录/建立会话后的令牌视图（不含会话 id 等内部字段）。 */
export interface IssuedSession {
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt: Date;
  audience: 'user' | 'admin';
  revision: number;
}

export interface AuthServiceOptions {
  store: AuthStore;
  wechat: WechatIdentityProvider;
  idempotency: IdempotencyStore;
  executionMode: ExecutionMode;
  /** 可注入时钟，便于确定性回归。 */
  now?: () => Date;
  userSessionTtlSeconds?: number;
  adminSessionTtlSeconds?: number;
  idempotencyTtlSeconds?: number;
  bootstrap?: { loginName: string; password: string } | null;
  bootstrapScopes?: readonly string[];
}

export interface BootstrapOutcome {
  created: boolean;
  reason: 'created' | 'already_initialized' | 'not_configured';
  loginName?: string;
}

/** 未命中管理员时用于等时比较的假摘要（防止按登录名探测账号是否存在）。 */
const DUMMY_CREDENTIAL_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

export class AuthService {
  private readonly store: AuthStore;
  private readonly wechat: WechatIdentityProvider;
  private readonly idempotency: IdempotencyStore;
  private readonly executionMode: ExecutionMode;
  private readonly now: () => Date;
  private readonly userSessionTtlSeconds: number;
  private readonly adminSessionTtlSeconds: number;
  readonly idempotencyTtlSeconds: number;
  private readonly bootstrap: { loginName: string; password: string } | null;
  private readonly bootstrapScopes: readonly string[];

  constructor(options: AuthServiceOptions) {
    this.store = options.store;
    this.wechat = options.wechat;
    this.idempotency = options.idempotency;
    this.executionMode = options.executionMode;
    this.now = options.now ?? (() => new Date());
    this.userSessionTtlSeconds = options.userSessionTtlSeconds ?? USER_SESSION_TTL_SECONDS;
    this.adminSessionTtlSeconds = options.adminSessionTtlSeconds ?? ADMIN_SESSION_TTL_SECONDS;
    this.idempotencyTtlSeconds = options.idempotencyTtlSeconds ?? 5 * 60;
    this.bootstrap = options.bootstrap ?? null;
    this.bootstrapScopes = options.bootstrapScopes ?? BOOTSTRAP_ADMIN_SCOPES;
  }

  /** 存储是否为持久化实现（real 模式必须持久化，否则拒绝签发会话）。 */
  get sessionsPersistent(): boolean {
    return this.store.persistent;
  }

  // -------------------------------------------------------------------------
  // 幂等台账（供路由层使用；重放前鉴权由路由的 preHandler 保证）
  // -------------------------------------------------------------------------

  findIdempotent(scope: string, keyHashHex: string) {
    return this.idempotency.find(scope, keyHashHex);
  }

  saveIdempotent(scope: string, keyHashHex: string, record: Parameters<IdempotencyStore['save']>[2]) {
    return this.idempotency.save(scope, keyHashHex, record);
  }

  // -------------------------------------------------------------------------
  // 用户端
  // -------------------------------------------------------------------------

  /**
   * 微信登录：仅凭一次性 code 在服务端换取身份。
   * 不强制手机号；不读取请求体里的任何身份字段（路由 schema 已 additionalProperties:false 拒绝）。
   */
  async loginWechat(code: string): Promise<IssuedSession> {
    this.assertPersistentSessions('微信登录');
    const { subjectLookupHex } = await this.wechat.exchange(code);
    const existing = await this.store.findUserBySubject(subjectLookupHex);
    const user = existing ?? (await this.store.createUser(subjectLookupHex));
    this.assertUserActive(user);
    return this.issueSession(user.id, 'user', user.authEpoch, user.revision, this.userSessionTtlSeconds);
  }

  /** 退出（用户端）：撤销当前会话，令牌立即失效。 */
  async logoutUser(sessionId: string): Promise<{ accepted: boolean }> {
    await this.store.revokeSession(sessionId, 'user');
    return { accepted: true };
  }

  // -------------------------------------------------------------------------
  // 后台
  // -------------------------------------------------------------------------

  /** 后台登录：login_name + password，独立于用户端会话。 */
  async loginAdmin(loginName: string, password: string): Promise<IssuedSession> {
    this.assertPersistentSessions('后台登录');
    const admin = await this.store.findAdminByLoginName(loginName);
    if (admin === null) {
      // 等时比较后再拒绝：不因“账号不存在”与“口令错误”产生可区分耗时。
      verifyPassword(password, DUMMY_CREDENTIAL_HASH);
      throw new ApiError('SESSION_REQUIRED', '登录名或口令不正确');
    }
    if (!verifyPassword(password, admin.credentialHash)) {
      throw new ApiError('SESSION_REQUIRED', '登录名或口令不正确');
    }
    if (admin.state !== 'active') {
      throw new ApiError('ACCOUNT_INACTIVE', '后台账号不可用');
    }
    if (!isPositiveInteger(admin.authEpoch)) {
      throw new ApiError('INVALID_REQUEST', '后台账号 authEpoch 非正整数');
    }
    return this.issueSession(admin.id, 'admin', admin.authEpoch, admin.revision, this.adminSessionTtlSeconds);
  }

  /** 退出（后台）：撤销当前后台会话。 */
  async logoutAdmin(sessionId: string): Promise<{ accepted: boolean }> {
    await this.store.revokeSession(sessionId, 'admin');
    return { accepted: true };
  }

  /** 后台 scope 列表（会话响应 SessionInfo.scopes）。 */
  async listAdminScopes(adminId: string): Promise<string[]> {
    return this.store.listAdminScopes(adminId);
  }

  // -------------------------------------------------------------------------
  // 管理员初始化
  // -------------------------------------------------------------------------

  /**
   * 初始管理员：仅在后台账号表为空且配置了 bootstrap 凭据时创建。
   * 口令只以 scrypt 摘要入库；返回值不含口令，日志亦不得打印。
   */
  async ensureBootstrapAdmin(): Promise<BootstrapOutcome> {
    if (this.bootstrap === null) return { created: false, reason: 'not_configured' };
    const existing = await this.store.countAdmins();
    if (existing > 0) return { created: false, reason: 'already_initialized' };
    await this.store.createAdmin({
      loginName: this.bootstrap.loginName,
      credentialHash: hashPassword(this.bootstrap.password),
      scopes: [...this.bootstrapScopes],
    });
    return { created: true, reason: 'created', loginName: this.bootstrap.loginName };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async issueSession(
    subjectId: string,
    audience: 'user' | 'admin',
    authEpoch: number,
    revision: number,
    ttlSeconds: number,
  ): Promise<IssuedSession> {
    const token = mintOpaqueToken();
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000);
    await this.store.createSession({
      userId: subjectId,
      tokenHashHex: hashToken(token),
      authEpoch,
      expiresAt,
      audience,
    });
    return { accessToken: token, tokenType: 'Bearer', expiresAt, audience, revision };
  }

  private assertUserActive(user: UserRecord): void {
    if (!isPositiveInteger(user.authEpoch)) {
      throw new ApiError('INVALID_REQUEST', '账号 authEpoch 非正整数');
    }
    if (user.state !== 'active') {
      throw new ApiError('ACCOUNT_INACTIVE', '账号不可用');
    }
  }

  private assertPersistentSessions(operation: string): void {
    if (this.executionMode === 'real' && !this.store.persistent) {
      // real 模式不得以进程内存储冒充持久会话：如实拒绝，不签发不可撤销的令牌。
      throw new ApiError('PROVIDER_UNAVAILABLE', `${operation}需要持久化会话存储（数据库未配置或不可用）`, {
        retryable: true,
      });
    }
  }
}

/** 会话响应形状（openapi Session）；admin 会话的 scopes 走 SessionInfo。 */
export function issuedSessionToSession(issued: IssuedSession): Record<string, unknown> {
  return {
    access_token: issued.accessToken,
    token_type: issued.tokenType,
    expires_at: issued.expiresAt.toISOString(),
    audience: issued.audience,
    revision: issued.revision,
  };
}

/** 会话信息（openapi SessionInfo）。 */
export function sessionInfo(input: {
  audience: 'user' | 'admin';
  expiresAt: Date;
  scopes: string[];
  revision: number;
}): Record<string, unknown> {
  return {
    audience: input.audience,
    expires_at: input.expiresAt.toISOString(),
    scopes: input.scopes,
    revision: input.revision,
  };
}
