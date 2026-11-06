/**
 * GY-R82（#6 AC「每帖 ≤3 张」在 real 恒 503 的返修）· PG 图片槽位计数器。
 *
 * 为什么单独成文件：`services/api/src/media/service.ts` 被 `docs/**` 里大量行号锚点引用，本仓纪律是
 * 「改被大量锚定的源文件时优先行号中性」（见 `AGENTS.md` 的「契约台账锚点维护」段）。所以新实现放这里，
 * `service.ts` 只做**同长度**的表达式替换（净 0 行），避免整批文档锚点漂移。
 *
 * 口径如实标注：这是**按 owner 的保守口径**，权威「每帖」判定属 GY-I15 附件挂载，本端口不冒名顶替；
 * 并发「先数后写」之间仍有 TOCTOU 窗口（权威计数落在 GY-I15），不放宽契约，也不改用
 * `unwired ⇒ 503` 的 fail-closed 判据。
 */
import type { MediaStore } from './store.ts';
import type { CommunityAttachmentCounter } from './service.ts';

/**
 * **PG 计数器**（real 模式的可用装配）：计「该 owner 名下存活 `community_image` 记录数」，
 * 取自持久化登记册（`MediaStore.liveCommunityImageCount`，服务层读出来后经 `countFor` 的
 * `liveCommunityImages` 入参给出）。
 *
 * 只接受 `kind === 'postgres'` 的持久化端口（判据是端口 `kind`，不是自述布尔标志）；传入内存
 * 实现即**构造期抛错**——real 装配下「拿内存 Map 当计数事实源」与 unwired 一样是能力缺口，
 * 不得静默放行。
 *
 * 与 unwired 的差别在于事实源是 PG 登记册：`initiated` 记录过期会被 `expireInitiated` 转入
 * `rejected` 而释放槽位，不存在「传满 3 张即永久锁死」。
 */
export function createPostgresAttachmentCounter(store: MediaStore): CommunityAttachmentCounter {
  if (store.kind !== 'postgres') {
    throw new TypeError(
      'createPostgresAttachmentCounter 只接受 kind === \'postgres\' 的持久化端口'
        + '（内存实现在 real 装配下不得充当计数事实源，请改用 unwired 并 fail-closed）',
    );
  }
  return {
    kind: 'postgres',
    note:
      'PG 图片槽位计数器（real 装配）：按 PG 登记册中同一 owner 名下存活的 community_image 记录数计数；'
      + '口径与替身同为按 owner 的保守口径（权威每帖判定属 GY-I15 附件挂载），'
      + 'initiated 过期即释放槽位（expireInitiated → rejected），不存在传满锁死；并发先数后写仍有 TOCTOU 窗口。',
    countFor({ liveCommunityImages }) {
      return liveCommunityImages;
    },
  };
}
