/**
 * GY-I27 隐私模块 · 授权守卫（可注入身份上下文，不依赖微信真实登录）。
 *
 * 提供两类入口：
 *   1. assertConsent / assertAccountActive —— 纯函数，供任务执行前/保存前重查。
 *   2. requireConsent —— 中间件形态，供 HTTP 层挂载（Fastify preHandler / Koa / Express 均可适配）。
 *
 * 身份上下文由调用方注入：{ userId, authEpoch }。
 * 账号状态与当前 auth_epoch 通过注入的 account 提供者读取，单元测试注入合成账号即可，
 * 不与 GY-I04（微信登录）形成依赖循环。
 *
 * 关键口径：
 *   - 系统麦克风/定位权限 ≠ 用途授权（CONSENT_REQUIRED 不因系统权限已开而放行）。
 *   - 错用途（purpose 不属于 data_type 必需集合）→ SCOPE_DENIED。
 *   - 注销/停用/待删除账号 → ACCOUNT_INACTIVE。
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
   * 重查账号状态；authEpoch 不一致视为账号已变更（注销/停用会递增 auth_epoch）。
   */
  async function assertAccountActive(userId, { authEpoch } = {}) {
    const state = await account.stateOf(userId);
    if (state !== 'active') {
      throw new PrivacyError('ACCOUNT_INACTIVE', `账号状态为 ${state}，禁止操作`);
    }
    if (authEpoch !== undefined) {
      const current = await account.authEpochOf(userId);
      if (current !== authEpoch) {
        throw new PrivacyError('ACCOUNT_INACTIVE', '账号状态已变更，请重新登录');
      }
    }
  }

  /**
   * 校验用途授权（含错用途判定与资料类型多用途完备性）。
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
   * 授权中间件：返回 async (requestContext) => consent 结果。
   * requestContext 可注入 { userId, authEpoch }；HTTP 适配层从会话/请求头提取后调用。
   */
  function requireConsent({ purpose, dataType } = {}) {
    return async function middleware(requestContext = {}) {
      const userId = requestContext.userId ?? requestContext.request?.userId ?? requestContext.user?.id;
      const authEpoch = requestContext.authEpoch ?? requestContext.request?.authEpoch;
      if (!userId) {
        throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
      }
      // 任务执行前 / 保存前重查账号状态与 auth_epoch。
      await assertAccountActive(userId, { authEpoch });
      return await assertConsent({ userId, purpose, dataType });
    };
  }

  return {
    assertAccountActive,
    assertConsent,
    requireConsent,
    _now: now,
  };
}
