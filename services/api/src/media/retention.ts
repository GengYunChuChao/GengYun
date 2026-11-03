/**
 * 媒体行保留期限的**唯一真源**：服务层（`media/service.ts`）、仓储（`media/store-pg.ts`）与
 * 清扫驱动（`media/purge-driver.ts`）都只从这里取数，⛔ 不许在别处再写一遍天数。
 *
 * ## 成文依据（逐字，⛔ 不许改数）
 * - `docs/implementation-requirements.md:278`：「注销立即撤会话和角色、停新外发／训练，生成分对象删除任务。
 *   在线个人数据／私有原媒体7日内删除，备份30日内滚动清理，恢复时重放删除清单。」
 * - `docs/implementation-requirements.md:277`：「私有定位、照片、音频、识别记录原则保存至注销，支持单条删除及撤回用途；
 *   不为了保留政策额外采集未用音频或坐标。」
 * - `docs/product-requirements.md:216`：「注销立即停用登录会话、角色、外发和新的训练用途；在线个人记录及原始私有媒体
 *   7日内删除，备份30日内滚动清理，恢复时重放删除清单。」
 * - `docs/architecture/state-contract.md:38`：「…初始化24小时未完成可过期回收。ready表示可处理，不等于公开。
 *   私有媒体可单条删除，引用内容即时隐藏并重审。」
 * - `docs/architecture/state-contract.md:109`：在线删除截止 = 注销受理时刻 + 7×24 小时。
 *
 * ## 为什么这里**只有**「注销后 7 日」，没有「活跃账号 N 天」
 * 仓内没有任何「活跃账号的 ready 媒体按日历老化 N 天」的成文数字
 * （`git grep -E "媒体[^。]{0,40}[0-9]+ ?天|[0-9]+ ?天[^。]{0,40}媒体" -- docs packages services`
 * 零命中）；#6 只要求回收「失败／取消的孤立文件」（`docs/initial-issues.md:191`），并未给成功上传的媒体
 * 定日历寿命，而 `:277` 明确「原则保存至注销」。⇒ 本片**不发明**活跃账号的天数：
 * 活账号的私有媒体 `media.expires_at = NULL`（无日历到期），只有注销受理时由
 * `MediaStore.purgeOwnedMedia` 把 `expires_at` 写成 `now + 7×24h`，此后由清扫链在到期后回收。
 *
 * ## 与其它模块的同源约束（不是「各写一遍」）
 * 天数**不在这里重新写**：它直接取自 `services/api/src/privacy/deletion-aging.ts` 的
 * `ONLINE_RETENTION_DAYS` / `ONLINE_RETENTION_MS`（那份文件已把自己的口径钉到
 * `packages/privacy/deletion.mjs` 的 `ONLINE_HOURS = 7 * 24`）。因此媒体域与注销链共用同一个数，
 * 不存在「改一处忘另一处」；`tests/unit/media-retention-policy.test.mjs` 仍逐条比对三处，防反向漂移。
 *
 * ## 为什么不做成 `retention-policy.mjs` 的条目
 * `packages/privacy/retention-policy.mjs` 的 `retentionDays` 语义是「**年龄列之后**再过 N 天」
 * （`created_at` + N 才是截止）。媒体的截止时刻是一条**绝对时刻列**（`expires_at`），
 * 塞进那张表就必须再发明一个「再过 N 天」的宽限期数——那正是本片拒绝做的事。
 * 媒体行的到期因此由 `media.expires_at` 直接表达，不进 `RETENTION_POLICY`。
 */
import { ONLINE_RETENTION_DAYS, ONLINE_RETENTION_MS } from '../privacy/deletion-aging.ts';

/** 注销受理后在线私有原媒体的删除期限（天）。依据 `docs/implementation-requirements.md:278`。 */
export const MEDIA_ONLINE_RETENTION_DAYS = ONLINE_RETENTION_DAYS;

/** 同上，毫秒（7 × 24h）。 */
export const MEDIA_ONLINE_RETENTION_MS = ONLINE_RETENTION_MS;

/**
 * `media.failure_code` 的闭集值：该行是被「保留期限到期」扫掉的回收，**不是**上传失败
 * （`expired`）、也不是用户删除（`owner_delete`）。清扫读数按它分账
 * 「过期回收」与「孤儿重试」，两笔不许混成一个数。
 */
export const MEDIA_RETENTION_EXPIRED = 'retention_expired';

/** 注销受理时刻 → 该行对象的保留截止时刻（epoch ms）。 */
export function mediaRetentionDeadline(atMs: number): number {
  return atMs + MEDIA_ONLINE_RETENTION_MS;
}
