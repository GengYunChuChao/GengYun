# 迁移目录说明

本目录只放**正向迁移**（`NNNN_<name>.sql`）与 `rollback/NNNN_<name>.down.sql`。
机器可读的「保留号台账」在 `services/api/db/migration-reservations.json`；
`tools/verify-migrations-unique.mjs` 的 `[gap]` 判据要求缺号在**本目录的 `.md`** 里有一行依据。

## 当前状态（2026-10-25 · #538 解冲突合流 `upstream/main` = `1d65b7ee`：`0001..0039`，缺 `0037`）

`0001..0035` 已连续落盘（35 个正向；`0035_r34_media_row_purge.sql` 已随上游真实落盘，本片旧段里那条
`WARN[gap] 0035` 的前提随之作废）；上游 #553（#19 片B）落 `0038_r34_deletion_receipt_persistence.sql`、
#22 片C 落 `0039_r34_deletion_state_cancelled.sql`，本片 #538 落 `0036_r34_admin_content_persistence.sql`
⇒ 目录现为 **38 个正向 `.sql`** ＋ `rollback/` **37 个**（`0001` 无 down）；缺号只剩 `0037`，已登记在
`services/api/db/migration-reservations.json`（`count + 保留数 === max` ⇒ **38 + 1 === 39**），
`node tools/verify-migrations-unique.mjs --strict` 的 `[gap]` 判据对该缺号有依据（见下）。
（本段数字为实测：`git ls-tree -r --name-only HEAD -- services/api/db/migrations`
⇒ 正向 `.sql` 38 条、`rollback/` 37 条；合流树缺号恰为 `0037` 且已登记保留。）

- `0037` 预留：**#14** 人工复核（已裁定分配、尚无分支/文件；文件名待该片落定时核）。
- `0036_r34_admin_content_persistence.sql`（R34 · #18 后台内容/资料域落库 + **列级**授权，已随 #538 落盘）：
  接在 `0035` 之后。落盘 ⇒ 保留台账里那条 `version: 36`（`owner: #538`、`remove_when: #538 合入即删`）
  按它自己的 `remove_when` **删除**（保留项不许躺平：0036 一落盘 `reservedButPresent` 就会把它判红）。
  `tests/unit/migration-reservations.test.mjs` 的「当前仓库」快照同 commit 跟进：缺号由 `[36,37]` 收为 `[37]`、
  「不得出现 `0036_` 前缀文件」翻成「必须出现」（方向与落盘事实一致，⛔ 不是放宽判据）。
- `0038_r34_deletion_receipt_persistence.sql`（#19 片B，已随 #553 落盘）：回执 bearer 摘要落
  `deletion_requests.receipt_bearer_hash` ＋ 三条窄口径 SECURITY DEFINER 函数（set/resolve/count）；
  按它自己的 `remove_when`，保留台账里的 38 号条目已删除（保留项不许躺平）。
- `0039_r34_deletion_state_cancelled.sql`（#22 片C · 在途取消：`ALTER TYPE deletion_state ADD VALUE 'cancelled'`）接在
  `0038` 之后；裁定 `.pg17/ruling-r34-migration-0039-cancelled-20261024.md` 分配本号，
  其余保留号 `0037` 串行合入（迁移号互斥）。

- `0033_admin_audit_log_read.sql`（R34 · 后台审计日志查询面，Refs #18）接在 `0032` 之后：
  编号前核对过全部 refs 与在途 PR（`003[3-9]_` 零命中）⇒ 直接用最大号 +1，**台账仍为空数组**。
- `0034_r34_owner_content_purge.sql`（#19 注销闭集扩展 · 注销内容清理窄函数）接在 `0033` 之后：
  本片原取 0033，与 #525 的 `0033_admin_audit_log_read.sql` **撞号** ⇒ 裁定保留 #525 的 0033（更早成形、
  且不动本片这套跨文件 canary），本片整体让到 `0034`。**#525 已于 2026-10-24 合入 `origin/main`（`4b87e1d9`）**，
  该号已由真实文件占位 ⇒ 台账里那条 `version: 33` 条目（`owner: #525`，`remove_when: #525 合入即删`）按它自己的
  `remove_when` **删除**；本文件此前那行「该号待落盘、先挂保留台账」的当前状态表述**随之作废并删除**（保留项不许躺平：落盘即删），
  现本目录 `0001..0034` 连续、无缺号，`reservations` 为空数组。

- `0036_r34_admin_content_persistence.sql`（R34 · #18 后台内容/资料域落库 + **列级**授权）原定接在 `0034` 之后：
  `0035` 归在途的「媒体行侧物理删除」片、`0037` 由 `#14` 使用 ⇒ 本片取 `0036`，**前提是 `0035` 先落 `main`**。
  该前提已成立：`0035_r34_media_row_purge.sql` 随上游落盘、本片 0036 随 #538 合流落盘 ⇒ `0001..0036` 连成一段，
  缺号只剩保留中的 `0037`（见上面「当前状态」段）。
- `0031_online_purge_evidence.sql`（#19 片B · 在线清理证据落库）与
  `0032_community_report_reporter_ref.sql`（#15 去身份残留 · 举报者行级注销引用）按裁定
  `.pg17/ruling-r32-migration-0031-allocation.md` 的归属落位：**0031 属 #19、0032 属 #15**。
- 合流顺序上先落 0031、再落 0032（#494 → #492）⇒ `0031..0032` 自然连成一段、**全程无缺号**。
  反过来若先合 #492，则必须先登记 31 号保留条目，并在 0031 落盘那一刻删除它 ——
  本段原先写的正是这个「待落盘」条件；**#494 已合入、0031 已真实落盘 ⇒ 该条件成立，故上面那条
  31 号登记与本段的「缺 1 个号」表述一并作废**（保留项不许躺平）。

历史上本文件记过一行「0029 预留」：`0029_media_object_cleanup.sql` 当时只在 PR #419
（`feat/gy-r28-media-object-cleanup`）分支上，而 F13 行级作者注销引用片（迁移 `0030`）先要落地 ⇒
树上缺 29，保留台账登记 `owner: #419`。**#419 已合入 `origin/main`（`056cf424`）**，0029 真实落盘 ⇒
台账条目与那一行依据都已按 `remove_when` / 本文件的「届时一并删除」**删除**（否则
`reservedButPresent` 会立刻判红：保留项不许躺平）。同族的「0031 预留」一行依据，#494 合入后
已按同一条纪律删除（见上）。

## 编号约定

- `0030_community_author_ref.sql` 当时取的是 0028 之后的第一个空号（29 被 #419 占着），**不是随便跳号**。
- `0032_community_report_reporter_ref.sql` 接在 `0031_online_purge_evidence.sql` 之后（0031 属 #19，已落盘）。
- 后续迁移从最大号之后连续编号；确需跨 PR 缺号时，**同时**在保留台账登记并在本文件写一行依据。
