# 数据保留策略表与清理执行器（GY-R34）

本片状态（2026-10-23）：**声明式策略表 + 幂等执行器 + 单测 + 真库臂已落地**（读数见
[证据页](../verification/gy-r34-retention-20261023.md)）。**调度接线**（`deploy/purge-schedule/` 的
`.service`/`.timer`）与 **CI 注册未做**，见 §8。

## 0. 一句话结论

仓里第一次有一张**跨表、声明式**的保留策略表：每张纳入的表都写明「按哪一列算年龄、留几天、依据是什么、
到期怎么处置」，并配一个**默认 dry-run**、按批提交、可反复重跑的执行器 `npm run purge:retention`；
到期数据按表处置（删除 / 匿名化 / 仅归档标记），未到期数据在任何一轮都不会被碰，第二轮删除 0 行。

## 1. 范围与边界

| 项 | 本片做法 | 理由 |
| --- | --- | --- |
| 纳入条件 | 有**日历年龄**语义（`created_at`/`expires_at`）、到期后不再有业务或凭据价值、且**有法律/产品/审计依据**可引用 | 没有依据的天数就是拍脑袋，评审无法复核 |
| 不纳入：注销态数据 | `transcriptions`、`conversations`、`messages`、`favorites`、`history` 等一律**保留至注销**，由注销闭集处理 | 需求 `docs/implementation-requirements.md:277` 与 `:380`「私有会话及音频按 F13 保留至注销」；按日历删私有内容等于提前销毁用户数据 |
| 不纳入：审计台账 | `public.admin_audit_events` 是 **append-only**（触发器 `admin_audit_events_append_only`，`services/api/db/migrations/0017_account_suspend_authority.sql:104-115`，SQLSTATE `G0006`/`AUDIT_IMMUTABLE`） | 库层就不许 UPDATE/DELETE；「保留策略」不能假装能改它，只能登记排除 |
| 与注销片的分工 | 本片**未改** `packages/privacy/deletion-modules.mjs`、`services/api/src/privacy/user-data-deletion.ts` | 那两份文件属并行切片「注销闭集扩展」领域，同时改会互相覆盖 |
| 迁移 | **不新增迁移** | 策略只读既有表与既有列；迁移号是全局唯一命名空间，本片不需要占号 |

## 2. 保留策略表（唯一事实来源：`packages/privacy/retention-policy.mjs`）

| 表 | 年龄列 | 保留天数 | 依据 | 依据出处 | 处置 | 目标列 | 为什么是这个天数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `public.idempotency_keys` | `expires_at` | 1 | 产品 | `services/api/src/auth/idempotency.ts:32-33` | `delete` | — | 幂等回执 TTL 是 24 小时，过期后重放不可能再命中；再留 1 天只作排障/对账余量 |
| `public.sessions` | `expires_at` | 30 | 审计留存 | `docs/implementation-requirements.md:281` | `delete` | — | 过期会话只留不可逆 `token_hash`，用途是安全事件回溯；窗口与「备份 30 日」对齐，超窗即整行删除 |
| `public.admin_sessions` | `expires_at` | 90 | 审计留存 | `docs/implementation-requirements.md:284` | `archive_marker` | `revoked_at` | 后台会话是审计线索，**不物理删除**；过期 90 天后 `revoked_at := expires_at`，让「已过期但未撤销」收敛为 0 |
| `public.community_reports` | `created_at` | 180 | 法务 | `docs/implementation-requirements.md:284` | `anonymize` | `detail` | 举报台账要留（状态/对象/理由码），但 `detail` 是举报人手写自由文本、可能含个人信息；180 天后只清该列 |

字段口径：

| 字段 | 含义 | 校验（`assertRetentionPolicy`） |
| --- | --- | --- |
| `table` | `schema.table` 限定名 | 必须 `public.` 前缀；不得重复；不得含 `;` 等非标识符字符 |
| `ageColumn` | 算「年龄」的列：`cutoff = now − retentionDays×24h`，`ageColumn < cutoff` 即到期（闭区间对侧） | 必须是标识符；必须真的在该表建表语句里 |
| `retentionDays` | 保留天数 | 正整数（`0`/小数/负数一律报错） |
| `basis` | `legal` / `product` / `audit` 三选一 | 必须在闭集内 |
| `basisRef` | 依据出处（`文件:行` 或需求条目） | 必填、非空白 |
| `disposition` | `delete` / `anonymize` / `archive_marker` | 三选一，且与 `targetColumn`/`markerSource` 的搭配必须自洽 |
| `targetColumn` | 匿名化或标记的列 | `delete` 必须为 `null`；`anonymize`/`archive_marker` 必须给 |
| `markerSource` | 标记值来源 | 仅 `archive_marker` 需要；当前只支持 `age_column`（`SET <target> = <ageColumn>`，**不读时钟**，重跑结果稳定） |

## 3. 排除清单（写进代码里的 `RETENTION_EXCLUSIONS`，不只是本文档）

| 表 | 为什么不纳入 | 归谁管 |
| --- | --- | --- |
| `public.admin_audit_events` | append-only 触发器拒绝 UPDATE/DELETE（`services/api/db/migrations/0017_account_suspend_authority.sql:104-115`） | 库层不可变；如需归档只能改表设计并单独评审 |
| `public.media_object_cleanup` | 是**对象清理 outbox**，删行会丢掉「还有对象没删」的可重试依据 | 由清理端消费，不是保留期对象 |
| `public.user_backup_copies` | 另有 30 日驱动（`packages/privacy/backup-retention.mjs` + `tools/purge-expired-backup-copies.mjs`），按 `retention_until` 逐用户判定 | 备份轴（GY-I19） |
| `deletion_requests` / `deletion_handlers` / `third_party_deletions` | 注销流程的状态机与第三方证据，删行＝删证据 | 注销闭集 |
| `exports` / `export_writebacks` | 外发台账是合规证据（谁、何时、给谁、依据哪版授权） | 隐私域，按需单独定策略 |
| `transcriptions` / `conversations` / `messages` / `favorites` / `history` | 需求要求**保留至注销**，不按日历删 | 注销闭集（F13） |

## 4. 执行方式

```bash
# 1) 先看：默认就是 dry-run，不写库、不开事务
DATABASE_URL=postgresql://… npm run purge:retention            # 等价于加 --dry-run
DATABASE_URL=postgresql://… npm run purge:retention -- --json   # 末行机读报告，供审计留档

# 2) 真执行：必须显式 --yes（手滑不会删数据）
DATABASE_URL=postgresql://… npm run purge:retention -- --yes --batch 500 --max-batches 10

# 3) 只跑某一张表（表名必须在策略表里，否则退出码 2）
DATABASE_URL=postgresql://… npm run purge:retention -- --yes --table public.sessions
```

| 参数 | 默认 | 语义 |
| --- | --- | --- |
| （不写） | dry-run | 只发 `SELECT count(*)`，**不 BEGIN、不写库** |
| `--dry-run` | — | 显式 dry-run；与 `--yes` 同给 ⇒ 退出码 2（不替调用方猜） |
| `--yes` | — | 真执行 |
| `--batch N` | 500 | 单批行数上限，**硬顶 500**；越界报错而不是静默截断 |
| `--max-batches N` | 10 | 单表单轮最多推几批（1..50）；用完仍满批 ⇒ 如实报「未吃完」，下一轮继续 |
| `--table T`（可多次） | 全部 | 只跑指定表；不在策略表内 ⇒ 退出码 2 |
| `--json` | 关 | 末尾输出机读报告（含 `cutoff`、逐表行数与失败码，**不含连接串**） |

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部表处理完成（**0 行也是 0**：重复执行第二次就长这样） |
| `1` | 至少一张表失败（`PERMISSION_DENIED` / `MISSING_TABLE` / `MISSING_COLUMN` / `AUDIT_IMMUTABLE` / `CONNECTION_FAILED` / `UNCLASSIFIED`），其余表照跑 |
| `2` | 参数/配置错误（缺 `DATABASE_URL`、连接串前缀不对、`--batch` 越界、未知表名…） |

执行形状（幂等与可重入的关键）：

| 约束 | 实现 |
| --- | --- |
| 批次 | 每批一条 `DELETE`/`UPDATE … WHERE ctid IN (SELECT ctid … ORDER BY <ageColumn> LIMIT $2)` |
| 事务边界 | **一批一个事务**：`BEGIN` → 一条变更 → `COMMIT`；异常 `ROLLBACK` 后把原始错误抛出去（回滚失败不掩盖原错） |
| 失败可重入 | 判据只依赖「年龄 < cutoff」与「尚未处理」两个条件，不依赖游标文件；中断后重跑自动接着删剩下的 |
| 幂等 | `delete`：行已不在即不再匹配；`anonymize`：额外 `AND target IS NOT NULL`；`archive_marker`：额外 `AND target IS NULL` 且标记值取自行内 `ageColumn` |
| 时刻源 | 唯一 `SELECT now()`（库时钟）；`cutoff` 逐表打印，dry-run 与真执行对得上 |
| 失败隔离 | 单表失败只记该表失败码，**不影响**其它表；有失败才返回 1 |

运行身份与权限（重要）：

| 表 | 需要的权限 | 现状 |
| --- | --- | --- |
| `public.idempotency_keys` | `DELETE` | 运行时角色 `gengyun_auth_privacy` 已有表级 `DELETE`（`services/api/db/roles/auth_privacy.sql:33`） |
| `public.admin_sessions` | `UPDATE (revoked_at)` | 已有列级 `UPDATE`（`services/api/db/roles/auth_privacy.sql:31`） |
| `public.sessions` | `DELETE` | **没有**（`services/api/db/roles/auth_privacy.sql:24-26` 只有列级 SELECT/INSERT/UPDATE）⇒ 该表必须用**库属主/运维角色**跑，因此本片**没有**给运行时角色加 `DELETE`（加授权会动到 `table_dml_allowlist` 与既有授权断言，属另一件事） |
| `public.community_reports` | `UPDATE (detail)` | 运行时角色无此列授权 ⇒ 同上，走属主/运维角色 |

⇒ 现实跑法：**用属主/运维连接串**跑（`DATABASE_URL` 只从环境变量读，不接受命令行明文，也不回显）。
权限不足时不会「装作成功」：真库臂里专门有一个受限角色用例，`public.sessions` 报 `PERMISSION_DENIED`、该表一行未动、其余三表照跑、退出码 1。

调度建议（本片未接线）：保留策略是**低频**清理，`--max-batches` 用默认值即可；若要接 `deploy/purge-schedule/`，
需同时补 `.service`（`ExecStart` 绝对路径 + `GY-SCHEDULE: npm-script=purge:retention`）与 `.timer`，并把 `purge:retention`
加进 `tools/verify-purge-schedule.mjs` 的 `REQUIRED_NPM_SCRIPTS`（**当前没加**，因为还没有对应 `.service`，加了会直接红）。

## 5. 审计要求

每次运行（含 dry-run）都必须能回答「删了什么、按哪条依据、谁批的天数」。落盘要求：

| # | 要留什么 | 怎么留 | 为什么 |
| --- | --- | --- | --- |
| 1 | 运行时刻、模式（`dry-run`/`execute`）、`--batch`/`--max-batches` | 报告首行 `policy=GY-R34-RETENTION mode=… batch=… max-batches=…` | 事后要能复算「这一轮该删多少」 |
| 2 | 逐表：表名、处置、保留天数、依据、`basisRef`、`cutoff`、批数、行数、是否吃完、失败码 | `--json` 报告保存原件（逐表一条 `entry`） | 只有行数没有 `cutoff` 等于无法复核 |
| 3 | 汇总：`tables/batches/rows/drained/failures` | 报告 `SUMMARY` 行 | 告警与看板的最小口径 |
| 4 | 失败表与其失败码（不记驱动原文） | `FAIL table=… code=…` | 原文可能含连接串/对象名；固定码足够定位 |
| 5 | 连接串与口令 | **任何输出都不得出现**（真库臂里有断言：输出不含 `postgresql://`、不含口令） | 日志是长期留存物 |

流程要求：

| 事项 | 要求 |
| --- | --- |
| 天数变更 | 改 `RETENTION_POLICY` 必须同时改本文档表格与单测；只改代码不改文档 ⇒ 评审直接打回 |
| 新增表 | 必须给出 `basis` + `basisRef`（可引用需求条目/迁移/契约），并确认该表**没有** append-only 触发器 |
| 排除表 | 必须写进 `RETENTION_EXCLUSIONS` 并给理由；「没写」不等于「不做」 |
| 报告留存 | 建议按天留 `--json` 原件（与 `verify:purge-schedule` 的调度日志同源），留存期不短于被删对象的审计需要 |
| 删除不可逆 | 本执行器**不做**软删：`delete` 就是 `DELETE`；唯一带「标记」语义的是 `archive_marker`（后台会话） |

## 6. 与既有两条 purge 命令的边界

| 命令 | 域 | 判据 | 与本片的关系 |
| --- | --- | --- | --- |
| `npm run purge:online-data` | 注销主体的在线数据（按主体/表枚举，keyset 游标） | 注销受理 + 在线 7 日 | 不重叠：那是**按主体**删，本片是**按日历**删 |
| `npm run purge:backup-copies` | 逐用户备份副本（`retention_until`） | 备份 30 日 | 不重叠：备份轴另有驱动，且 `user_backup_copies` 已进排除清单 |
| `npm run purge:retention`（本片） | 到期即无价值的通用台账/会话/举报明细 | 表级 `ageColumn + retentionDays` | 与前两条**同构**（连接串只走 `DATABASE_URL`、dry-run 优先、退出码 0/1/2），不替代它们 |

## 7. 读数（2026-10-23，本 worktree 实测）

| 臂 | 命令 | 读数 |
| --- | --- | --- |
| 单测 | `node --test tests/unit/retention-policy.test.mjs` | **15/15 通过，0 失败** |
| 真库臂 | `npm run test:integration:retention-purge-pg`（PG 17.11，端口 55444） | **7 个断言组全绿**；dry-run `rows=1215 batches=0`；真执行 `rows=1215`；第二轮 `rows=0`；受限角色臂 `exit=1` |
| 门禁 | `node tools/verify-purge-schedule.mjs` / `verify-layout.mjs` / `verify-doc-anchors.mjs --strict` | 三者均 `PASS` |

## 8. 未做项（如实登记）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 调度接线 | **未做** | 没往 `deploy/purge-schedule/` 加 `.service`/`.timer`，也没把 `purge:retention` 加进 `REQUIRED_NPM_SCRIPTS`（加了会因缺 `.service` 直接红） |
| CI 注册 | **未做** | `test:integration:retention-purge-pg` 只在本地跑过；CI 里没有 `GY_PG_BIN` 时该臂按既有约定 `exit 77` 跳过 |
| 运行时角色授权 | **未做（刻意）** | `sessions`/`community_reports` 的 `DELETE`/`UPDATE` 授权没动，跑法是用属主/运维连接串；要不要给运行时角色开权限属独立评审 |
| 归档表设计 | **未做** | `admin_audit_events` 需要归档时得先改表（加归档列或分区），append-only 触发器下无从下手 |
| 真实生产读数 | **未取得** | 只在本机临时集群（PG 17.11）取得读数，生产库上的行数与耗时未测 |
