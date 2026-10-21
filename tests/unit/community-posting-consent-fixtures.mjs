/**
 * GY-R28 W10 · `public_posting` 用途授权的**合成授权夹具**（非测试文件，不参与 `node --test` 发现）。
 *
 * 为什么需要它：社区投稿面（`POST /posts`、`PATCH /posts/:id`、`POST /posts/:id/comments`、
 * `PATCH /comments/:id`）挂上 `public_posting` 闸之后，**未授权 ⇒ 403 `CONSENT_REQUIRED`**。
 * 既有社区用例的断言口径（201/200、幂等、先审后发、下架、版本冲突……）不因为这条闸而改变，
 * 所以夹具在**请求之前**按真实实现 `consentStore.grant(...)` 把授权补齐 —— 不是把断言改成
 * 「403 也算过」。
 *
 * 授权是**账号维度**的（`privacy_epochs` 主键 `(user_id, purpose)`），因此每个用例都要一份
 * **全新** store：跨用例复用会让「撤回后必须再 403」的负控制变成假通过。
 *
 * 合成声明：账号、授权记录与条文版本都是合成值；本夹具**不**读真实 `.env`、不连真实库。
 */
import { createGuardConsentGate } from '../../services/api/src/privacy/egress.ts';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createPrivacyGuard } from '../../packages/privacy/guard.mjs';
import { createAccountProvider, VERIFIED_RECIPIENT } from '../privacy/_fixtures.mjs';

/** 与 `packages/privacy/constants.mjs` 无关的**合成**条文版本（只用于合成授权记录）。 */
export const SYNTHETIC_CONSENT_POLICY_VERSION = '2026-10-21';

/** 投稿面闸要的用途码（单一来源，避免用例里散落字面量）。 */
export const PUBLIC_POSTING_PURPOSE = 'public_posting';

/**
 * 一份**独立**的 `public_posting` 授权装配：内存授权账本 + `createPrivacyGuard` + 注入式闸。
 *
 * 返回的 `gate` 就是 `registerCommunityRoutes(..., { consent })` 要的那一个端口；
 * `grant/withdraw` 直接走真实实现（`consentStore.grant` / `consentStore.withdraw`），
 * 因此「授权 ⇒ 放行」「撤回 ⇒ 再拒」都是**真实链路**，不是桩。
 */
export function createPublicPostingConsent() {
  const account = createAccountProvider();
  const consentStore = createConsentStore();
  const gate = createGuardConsentGate(createPrivacyGuard({ account, consentStore }));

  return {
    account,
    consentStore,
    gate,
    /** 补齐授权（真实 `grant`：写授权记录并把当前 epoch 置 granted）。 */
    async grant(userId, purpose = PUBLIC_POSTING_PURPOSE) {
      await consentStore.grant({
        userId,
        purpose,
        policyVersion: SYNTHETIC_CONSENT_POLICY_VERSION,
        recipientIds: [VERIFIED_RECIPIENT.id],
      });
    },
    /** 撤回授权（真实 `withdraw`：当前行置 withdrawn 并递增 epoch，使在途外发失效）。 */
    async withdraw(userId, purpose = PUBLIC_POSTING_PURPOSE) {
      await consentStore.withdraw({ userId, purpose });
    },
    /** 当前是否有效授权（供断言用，不是旁路判定）。 */
    async isGranted(userId, purpose = PUBLIC_POSTING_PURPOSE) {
      return consentStore.isGranted({ userId, purpose });
    },
  };
}
