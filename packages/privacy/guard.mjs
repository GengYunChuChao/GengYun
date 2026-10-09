/**
 * GY-I27 隐私模块 · 授权守卫（可注入身份上下文，不依赖微信真实登录）。
 *
 * 入口严格分为两类（修复轮 3：不得共用一个可省略 epoch 的入口）：
 *   1. `requireConsent` —— **已认证执行入口**（HTTP 层中间件，Fastify preHandler / Koa / Express
 *      均可适配）：**必须**携带正整数 `auth_epoch`，缺失/null/非正整数一律拒绝；核对账号状态
 *      与「当前 auth_epoch」一致后，再校验用途授权。
 *   2. `assertConsent` / `assertAccountActive` —— **纯只读核对**，不含执行授权语义：
 *      - `assertConsent` 供**纯用途查询**使用，不做身份版本核对；
 *      - `assertAccountActive(userId, { authEpoch })` 在显式传入 authEpoch 时核对版本。
 *      调用方**不得**把 `assertConsent` 当作已认证执行入口。
 *
 * 身份上下文由调用方注入：{ userId, authEpoch }。
 * 账号状态与当前 auth_epoch 通过注入的 account 提供者读取，单元测试注入合成账号即可，
 * 不与 GY-I04（微信登录）形成依赖循环。
 *
 * 关键口径：
 *   - 系统麦克风/定位权限 ≠ 用途授权（CONSENT_REQUIRED 不因系统权限已开而放行）。
 *   - 错用途（purpose 不属于 data_type 必需集合）→ SCOPE_DENIED。
 *   - 注销/停用/待删除账号 → ACCOUNT_INACTIVE。
 *   - 身份版本缺失/null → SESSION_REQUIRED；身份版本非正整数 → INVALID_REQUEST；
 *     身份版本与当前不一致（旧会话）→ ACCOUNT_INACTIVE。
 */
import { CONSENT_PURPOSES, MEDIA_PURPOSES, MEDIA_PURPOSE_REQUIRED_CONSENTS } from './constants.mjs';
import { PrivacyError } from './errors.mjs';

/**
 * @typedef {Object} AccountProvider
 * @property {(userId: string) => Promise<string>} stateOf 返回 'active'/'suspended'/'deletion_pending'/'deleted' 之一
 * @property {(userId: string) => Promise<number>} authEpochOf 返回当前 auth_epoch
 */

/**
 * @param {{
 *   account: AccountProvider,
 *   consentStore: object,
 *   now?: () => Date,
 * }} deps
 */
export function createPrivacyGuard({ account, consentStore, now = () => new Date() } = {}) {
  // 强制要求「身份版本」能力：缺少 authEpochOf 的适配器无法核对账号版本，
  // 会让注销/停用（auth_epoch 前进）后的旧会话继续放行。此处直接拒绝构造。
  if (!account || typeof account.stateOf !== 'function' || typeof account.authEpochOf !== 'function') {
    throw new Error('createPrivacyGuard 需要注入带 stateOf 与 authEpochOf 的 account 提供者');
  }
  if (!consentStore || typeof consentStore.isGranted !== 'function') {
    throw new Error('createPrivacyGuard 需要注入 consentStore');
  }

  /**
   * 身份版本（auth_epoch）格式校验：缺失/null → SESSION_REQUIRED；非正整数 → INVALID_REQUEST。
   * 供已认证执行入口在核对当前版本前先做格式拒绝（不允许省略后静默放行）。
   */
  function assertIdentityVersion(authEpoch) {
    if (authEpoch === undefined || authEpoch === null) {
      throw new PrivacyError('SESSION_REQUIRED', '缺少身份版本（auth_epoch）');
    }
    if (!Number.isInteger(authEpoch) || authEpoch < 1) {
      throw new PrivacyError('INVALID_REQUEST', '身份版本（auth_epoch）非法');
    }
  }

  /**
   * 重查账号状态；显式传入 authEpoch 时核对当前版本
   * （注销/停用会递增 auth_epoch，旧会话即不匹配 → ACCOUNT_INACTIVE）。
   */
  async function assertAccountActive(userId, { authEpoch } = {}) {
    const state = await account.stateOf(userId);
    if (state !== 'active') {
      throw new PrivacyError('ACCOUNT_INACTIVE', `账号状态为 ${state}，禁止操作`);
    }
    if (authEpoch !== undefined && authEpoch !== null) {
      assertIdentityVersion(authEpoch);
      const current = await account.authEpochOf(userId);
      if (!Number.isInteger(current) || current < 1) {
        throw new PrivacyError('ACCOUNT_INACTIVE', '身份版本不可用，禁止操作');
      }
      if (current !== authEpoch) {
        throw new PrivacyError('ACCOUNT_INACTIVE', '账号状态已变更，请重新登录');
      }
    }
  }

  /**
   * **纯用途查询**（非执行授权入口）：校验用途/资料类型合法性与是否已授予用途授权，
   * 只核对账号状态（active），**不做身份版本核对**。
   * 需要「已认证执行」语义时请改用 `requireConsent`（强制要求 auth_epoch）。
   * @param {{ userId: string, purpose: string, dataType?: string }} input
   * @returns {Promise<{userId:string, purpose:string, consentEpoch:number}>}
   */
  async function assertConsent({ userId, purpose, dataType } = {}) {
    if (!userId) throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
    if (!CONSENT_PURPOSES.includes(purpose)) {
      throw new PrivacyError('SCOPE_DENIED', `未知用途：${purpose}`);
    }

    if (dataType !== undefined && dataType !== null) {
      if (!MEDIA_PURPOSES.includes(dataType)) {
        throw new PrivacyError('SCOPE_DENIED', `未知资料类型：${dataType}`);
      }
      const required = MEDIA_PURPOSE_REQUIRED_CONSENTS[dataType];
      if (!required.includes(purpose)) {
        throw new PrivacyError(
          'SCOPE_DENIED',
          `用途 ${purpose} 与资料类型 ${dataType} 不匹配（错用途）`,
        );
      }
    }

    await assertAccountActive(userId);

    const granted = await consentStore.isGranted({ userId, purpose });
    if (!granted) {
      throw new PrivacyError('CONSENT_REQUIRED', `缺少用途授权：${purpose}`);
    }
    const consentEpoch = await consentStore.currentEpoch({ userId, purpose });

    // 资料类型需要多用途时，逐个补齐校验（缺任一即 CONSENT_REQUIRED）。
    if (dataType !== undefined && dataType !== null) {
      for (const p of MEDIA_PURPOSE_REQUIRED_CONSENTS[dataType]) {
        if (!(await consentStore.isGranted({ userId, purpose: p }))) {
          throw new PrivacyError('CONSENT_REQUIRED', `缺少用途授权：${p}`);
        }
      }
    }

    return { userId, purpose, consentEpoch };
  }

  /**
   * **已认证执行入口**（HTTP 中间件）：返回 async (requestContext) => consent 结果。
   * requestContext 注入 { userId, authEpoch }；HTTP 适配层从会话/请求头提取后调用。
   *
   * 与 `assertConsent`（纯用途查询）分开：本入口**强制**要求正整数 auth_epoch，
   * 缺失/null → SESSION_REQUIRED，非正整数 → INVALID_REQUEST，旧版本 → ACCOUNT_INACTIVE；
   * 核对通过后才做用途授权校验。不接受省略 epoch 的调用。
   */
  function requireConsent({ purpose, dataType } = {}) {
    return async function middleware(requestContext = {}) {
      const userId = requestContext.userId ?? requestContext.request?.userId ?? requestContext.user?.id;
      const authEpoch = requestContext.authEpoch ?? requestContext.request?.authEpoch;
      if (!userId) {
        throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
      }
      // 已认证执行入口：先强制身份版本格式，再核对账号状态与当前 auth_epoch。
      assertIdentityVersion(authEpoch);
      await assertAccountActive(userId, { authEpoch });
      return await assertConsent({ userId, purpose, dataType });
    };
  }

  return {
    assertIdentityVersion,
    assertAccountActive,
    assertConsent,
    requireConsent,
    _now: now,
  };
}
