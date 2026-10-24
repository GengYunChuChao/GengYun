/**
 * GY-I14（#14）· 真实审核端口**接线框架**（默认关闭，显式打开）。
 *
 * 这是 `live-ports.ts` 头部点名的「另一次显式、可审查的接线变更」的**框架部分**：
 * `provider.ts` 的 `resolveModerationPorts` 真实分支此前恒 `ports: {}` / `fail_closed: true`；
 * 本文件把 tms/ims live-adapter 以「凭据/fetch/时钟/BizType 注入点」的方式接进真实分支——
 * **无凭据 / 未显式打开 ⇒ 仍 fail-closed（永不回退替身）**，有凭据且策略显式打开 ⇒ 装配真实端口。
 *
 * 「默认关闭」不是运行期开关，而是类型上没有默认值：`ModerationLiveWiring` 的 `policy` /
 * `textProfile` / `imageProfile` / `credentials` 全部必填（fetch/now 除外），缺任一就构造不出来。
 * 策略闸门（`policySelectionVerified === true && executionAllowed === true`）与凭据三元组
 * 都由两个 live-adapter 在构造期再逐项硬拒一遍（纵深防御），本文件不做第二套判定。
 *
 * 图片字节来源（`imageSource`）默认取 `createUnwiredModerationImageSource`：图片端口的
 * 网络面是真实的，但字节拿不到 ⇒ 图片送审按「取不到待审图片」fail-closed，**绝不伪造字节**。
 *
 * ⛔ 本文件不含任何网络实现、不含任何凭据值、不读 `process.env`、不读文件、不写台账。
 *   凭据经 `ModerationLiveWiring.credentials` 注入（由 config/env 装配层提供，本片不落盘）。
 */

import { createUnwiredModerationImageSource } from './live-vendor.ts';
import {
  ModerationWiringError,
  type ModerationImageProfile,
  type ModerationImageSource,
  type ModerationLiveCredentials,
  type ModerationLiveObservation,
  type ModerationLivePort,
  type ModerationPolicySnapshot,
  type ModerationTextProfile,
} from './live-ports.ts';
import { createLiveModerationTextPort } from './tms-live-adapter.ts';
import { createLiveModerationImagePort } from './ims-live-adapter.ts';

/**
 * 真实审核接线的一次性注入点（字段全部必填，除 fetch/now/onObservation/imageSource）。
 *
 * 这些就是 `provider.ts` 真实分支的「凭据 / fetch / 时钟 / BizType 注入点」：
 * - `credentials`：TC3 凭据三元组（内存，来自 env/config，本片不读也不落盘）；
 * - `textProfile` / `imageProfile`：被校验配置快照（含真实 `BizType`，须调用方注入）；
 * - `fetchImpl` / `now`：网络与时钟 seam（缺省 `globalThis.fetch` / `Date.now`）；
 * - `imageSource`：图片字节来源（缺省未接线 ⇒ 图片 fail-closed）；
 * - `onObservation`：脱敏观测钩子（RequestId/耗时，绝不含密钥/明文）。
 */
export interface ModerationLiveWiring {
  readonly policy: ModerationPolicySnapshot;
  readonly textProfile: ModerationTextProfile;
  readonly imageProfile: ModerationImageProfile;
  readonly credentials: ModerationLiveCredentials;
  readonly imageSource?: ModerationImageSource;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly onObservation?: (observation: ModerationLiveObservation) => void;
}

/**
 * 由注入点装配一对真实审核端口（tms 文本 + ims 图片）。
 *
 * 返回 `null` = **默认关闭**：无凭据 / 策略未显式打开 / 配置不合法 / 端点不在白名单——
 * 任一不成立即返回 `null`（调用方据此整域 fail-closed 503），**绝不回退替身**。
 * 只有全部硬拒都通过才返回 `{ tms, ims }`（两者 `provider.synthetic === false`）。
 *
 * 构造失败只在 `ModerationWiringError` 时折算成 `null`（那是"没接线"而不是"接线坏了"）；
 * 其它异常（本片不该发生）原样抛出，不吞掉第一现场。
 */
export function createLiveModerationPortsFromWiring(
  wiring: ModerationLiveWiring | null | undefined,
): { tms: ModerationLivePort; ims: ModerationLivePort } | null {
  if (wiring === null || typeof wiring !== 'object') return null;
  try {
    const imageSource = wiring.imageSource ?? createUnwiredModerationImageSource('对象存储属媒体域，本片未接线');
    const tms = createLiveModerationTextPort({
      policy: wiring.policy,
      profile: wiring.textProfile,
      credentials: wiring.credentials,
      ...(wiring.fetchImpl === undefined ? {} : { fetchImpl: wiring.fetchImpl }),
      ...(wiring.now === undefined ? {} : { now: wiring.now }),
      ...(wiring.onObservation === undefined ? {} : { onObservation: wiring.onObservation }),
    });
    const ims = createLiveModerationImagePort({
      policy: wiring.policy,
      profile: wiring.imageProfile,
      credentials: wiring.credentials,
      imageSource,
      ...(wiring.fetchImpl === undefined ? {} : { fetchImpl: wiring.fetchImpl }),
      ...(wiring.now === undefined ? {} : { now: wiring.now }),
      ...(wiring.onObservation === undefined ? {} : { onObservation: wiring.onObservation }),
    });
    return { tms, ims };
  } catch (error) {
    if (error instanceof ModerationWiringError) return null;
    throw error;
  }
}
