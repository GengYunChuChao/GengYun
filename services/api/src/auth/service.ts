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
import type { AuthStore, AdminCredentialRecord } from './store.ts';
import type { StoredSession, UserRecord } from './types.ts';
import type { WechatIdentityProvider } from './wechat.ts';
import type {
  IdempotencyClaim,
  IdempotencyRecord,
  IdempotencyStore,
  LoginOutcomeReference,
} from './idempotency.ts';
import { idempotencyRequestHash } from './idempotency.ts';
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

/**
 * 非 real 模式的固定请求摘要密钥（stub/preset_demo 无真实密钥；不构成真实安全边界）。
 * real 模式必须用 `SESSION_SIGNING_KEY`（只经 process.env，不入库）。
 */
export const STUB_IDEMPOTENCY_HMAC_KEY = 'gengyun-stub-idempotency-hmac-key';

/** 登录/建立会话后的令牌视图（不含会话 id 等内部字段）。 */
export interface IssuedSession {
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt: Date;
  audience: 'user' | 'admin';
  revision: number;
  /** 会话 id：仅服务端内部结果引用（幂等重放核验用），**不进入响应**。 */
  sessionId: string;
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
  /** 幂等请求摘要的 HMAC 密钥（来自服务端 env，不入库）；缺省用固定桩密钥。 */
  idempotencyHmacKey?: string;
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
  private readonly idempotencyHmacKey: string;
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
    this.idempotencyHmacKey = options.idempotencyHmacKey ?? STUB_IDEMPOTENCY_HMAC_KEY;
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

  /** 读取**已完成**的幂等台账记录（占位中 / 不存在 → null）。 */
  findIdempotent(scope: string, keyHashHex: string) {
    return this.idempotency.find(scope, keyHashHex);
  }

  /** 原子占位（同键并发收敛）：true = 本次请求可执行 produce，其余同键请求需等待重放。 */
  claimIdempotent(scope: string, keyHashHex: string, claim: IdempotencyClaim): Promise<boolean> {
    return this.idempotency.claim(scope, keyHashHex, claim);
  }

  /** 占位者写入最终结果（仅当该行仍是未完成占位时成功）。 */
  completeIdempotent(scope: string, keyHashHex: string, record: IdempotencyRecord): Promise<boolean> {
    return this.idempotency.complete(scope, keyHashHex, record);
  }

  /** 放弃占位（produce 失败）：只删除未完成的占位行，使后续同键请求可重新尝试。 */
  releaseIdempotent(scope: string, keyHashHex: string): Promise<void> {
    return this.idempotency.release(scope, keyHashHex);
  }

  /** 请求摘要：HMAC-SHA256(服务端密钥, [请求体, If-Match])。密钥不入库。 */
  hashIdempotencyRequest(body: unknown, ifMatch: string | string[] | undefined): string {
    return idempotencyRequestHash(body, ifMatch, this.idempotencyHmacKey);
  }

  /** 实际删除已到期幂等条目（不只是写 TTL 字段）。 */
  purgeExpiredIdempotent(now: Date): Promise<number> {
    return this.idempotency.purgeExpired(now);
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

  /**
   * 幂等重放（用户端登录）：**不重新消耗一次性微信 code**（real 模式下 code 已被首次交换占用）。
   * 先核验台账锚定的关联会话未被撤销/未过期，且账号当前为 active 且 authEpoch 与建会话时一致；
   * 任一不满足即拒绝——**不恢复旧会话、不把失效登录包当成功**。
   * 通过后在**同一会话**上换发新令牌（保持原绝对时效），使同键重试收敛为同一可撤销的登录结果：
   * 该会话一旦被撤销（含退出），旧 code/key 重放即被拒绝，不再签发可用凭据。
   */
  async replayUserLogin(reference: LoginOutcomeReference): Promise<IssuedSession> {
    this.assertPersistentSessions('微信登录');
    if (reference.audience !== 'user') {
      throw new ApiError('SESSION_REQUIRED', '幂等结果引用与用户会话不匹配');
    }
    const { session, user } = await this.loadReplaySession(reference.sessionId, 'user');
    return this.rotateSession(session, user.revision);
  }

  // -------------------------------------------------------------------------
  // 后台
  // -------------------------------------------------------------------------

  /** 后台登录：login_name + password，独立于用户端会话。 */
  async loginAdmin(loginName: string, password: string): Promise<IssuedSession> {
    this.assertPersistentSessions('后台登录');
    const admin = await this.verifyAdminCredentials(loginName, password);
    return this.issueSession(admin.id, 'admin', admin.authEpoch, admin.revision, this.adminSessionTtlSeconds);
  }

  /**
   * 幂等重放（后台登录）：除关联会话与账号当前状态外，**必须重新校验当前凭据有效**
   * （口令已轮换/停用即拒绝），再在**同一会话**上换发新令牌（保持原绝对时效）。
   * 会话被撤销/过期或账号 epoch 变更 → 拒绝旧 code/key 重放。
   */
  async replayAdminLogin(reference: LoginOutcomeReference, loginName: string, password: string): Promise<IssuedSession> {
    this.assertPersistentSessions('后台登录');
    if (reference.audience !== 'admin') {
      throw new ApiError('SESSION_REQUIRED', '幂等结果引用与后台会话不匹配');
    }
    const session = await this.loadLiveSession(reference.sessionId, 'admin');
    const admin = await this.verifyAdminCredentials(loginName, password);
    if (admin.id !== session.userId) {
      // 结果引用被篡改或账号被替换：拒绝，不签发。
      throw new ApiError('SESSION_EXPIRED', '关联会话与当前凭据归属不一致');
    }
    if (session.authEpoch !== admin.authEpoch) {
      throw new ApiError('ACCOUNT_INACTIVE', '会话已因账号变更失效');
    }
    return this.rotateSession(session, admin.revision);
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
    const sessionId = await this.store.createSession({
      userId: subjectId,
      tokenHashHex: hashToken(token),
      authEpoch,
      expiresAt,
      audience,
    });
    return { accessToken: token, tokenType: 'Bearer', expiresAt, audience, revision, sessionId };
  }

  /** 后台凭据校验（口令错误与账号不存在等时比较后返回同一码）。 */
  private async verifyAdminCredentials(loginName: string, password: string): Promise<AdminCredentialRecord> {
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
    return admin;
  }

  /** 取会话并核验其未撤销、未过期（不核验账号）。 */
  private async loadLiveSession(sessionId: string, audience: 'user' | 'admin'): Promise<StoredSession> {
    const session = await this.store.findSessionById(sessionId, audience);
    if (session === null) throw new ApiError('SESSION_EXPIRED', '关联会话不存在');
    if (session.revokedAt !== null) throw new ApiError('SESSION_EXPIRED', '关联会话已撤销');
    if (session.expiresAt.getTime() <= this.now().getTime()) throw new ApiError('SESSION_EXPIRED', '关联会话已过期');
    return session;
  }

  /**
   * 重放核验（用户端）：会话未撤销/未过期 + 账号 active + authEpoch 与建会话时一致。
   * 任一不满足即拒绝，绝不恢复旧会话。
   */
  private async loadReplaySession(
    sessionId: string,
    audience: 'user',
  ): Promise<{ session: StoredSession; user: UserRecord }> {
    const session = await this.loadLiveSession(sessionId, audience);
    const user = await this.store.getUser(session.userId);
    if (user === null) throw new ApiError('SESSION_EXPIRED', '关联账号不存在');
    this.assertUserActive(user);
    if (session.authEpoch !== user.authEpoch) {
      throw new ApiError('ACCOUNT_INACTIVE', '会话已因账号变更失效');
    }
    return { session, user };
  }

  /**
   * 在同一会话上换发新令牌（幂等重放收敛）：会话 id 与**绝对到期时刻**保持不变，
   * 只替换服务端保存的令牌摘要；旧令牌随之失效（同一会话只保留一个可用令牌）。
   * 若会话在核验与换发之间被撤销 → 拒绝，不签发不可撤销的凭据。
   */
  private async rotateSession(session: StoredSession, revision: number): Promise<IssuedSession> {
    const token = mintOpaqueToken();
    const rotated = await this.store.rotateSessionToken(session.id, hashToken(token), session.audience);
    if (!rotated) {
      throw new ApiError('SESSION_EXPIRED', '关联会话已撤销，拒绝重复签发');
    }
    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresAt: session.expiresAt,
      audience: session.audience,
      revision,
      sessionId: session.id,
    };
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
