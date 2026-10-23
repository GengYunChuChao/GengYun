# 数据保留策略表与清理执行器（GY-R34）

本片状态（2026-10-23）：**声明式策略表 + 幂等执行器 + 单测 + 真库臂已落地**（读数见
[证据页](../verification/gy-r34-retention-20261023.md)）。**调度接线**（`deploy/purge-schedule/` 的
`.service`/`.timer`）与 **CI 注册未做**，见 §8。

## 0. 一句话结论

仓里第一次有一张**跨表、声明式**的保留策略表：每张纳入的表都写明「按哪一列算年龄、留几天、依据是什么、
到期怎么处置」，并配一个**默认 dry-run**、按批提交、可反复重跑的执行器 `npm run purge:retention`；
到期数据按表处置（删除 / 匿名化 / 仅归档标记），未到期数据在任何一轮都不会被碰，第二轮删除 0 行。
**只登记有出处天数的两张表**——写不出「哪份文件哪一行写了这个天数」的表，一律进排除清单而不是进策略表。

## 1. 范围与边界

| 项 | 本片做法 | 理由 |
| --- | --- | --- |
| 纳入条件 | ① 有**日历年龄**语义（`created_at`/`expires_at`）；② 到期后不再有业务或凭据价值；③ 有**法律/产品/审计依据**，且该依据的原文里**真的写着这个天数或窗口** | 没有出处的天数就是拍脑袋：评审无法复核，法务也无法背书。③ 由单测 §1b 机械校验（解析 `basisRef` 并实读那一行） |
| 不纳入：注销态数据 | `transcriptions`、`conversations`、`messages`、`favorites`、`history` 等一律**保留至注销**，由注销闭集处理 | 需求 `docs/implementation-requirements.md:277` 与 `:380`「私有会话及音频按 F13 保留至注销」；按日历删私有内容等于提前销毁用户数据 |
| 不纳入：审计台账 | `public.admin_audit_events` 是 **append-only**（触发器 `admin_audit_events_append_only`，`services/api/db/migrations/0017_account_suspend_authority.sql:104-115`，SQLSTATE `G0006`/`AUDIT_IMMUTABLE`） | 库层就不许 UPDATE/DELETE；「保留策略」不能假装能改它，只能登记排除 |
| 不纳入：天数无出处 | `public.admin_sessions`（曾拟 90 天）、`public.community_reports`（曾拟 180 天）已从策略表**降级为排除项** | 全仓找不到任何写 90/180 天的原文；给它们编一个数字比不删更糟。处置**机制**（`anonymize` 必带 `revisionColumn`）仍在代码里并被单测/真库臂覆盖 |
| 与注销片的分工 | 本片**未改** `packages/privacy/deletion-modules.mjs`、`services/api/src/privacy/user-data-deletion.ts` | 那两份文件属并行切片「注销闭集扩展」领域，同时改会互相覆盖 |
| 迁移 | **不新增迁移** | 策略只读既有表与既有列；迁移号是全局唯一命名空间，本片不需要占号 |

## 2. 保留策略表（唯一事实来源：`packages/privacy/retention-policy.mjs`）

| 表 | 年龄列 | 保留天数 | 依据 | 依据出处 | 处置 | 目标列 | 为什么是这个天数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `public.idempotency_keys` | `expires_at` | 1 | 产品 | `services/api/src/auth/idempotency.ts:32-33` | `delete` | — | 幂等回执 TTL 是 24 小时（`IDEMPOTENCY_TTL_SECONDS`），过期后重放不可能再命中；再留 1 天只作排障/对账余量 |
| `public.sessions` | `expires_at` | 30 | 审计留存 | `docs/implementation-requirements.md:278` | `delete` | — | 依据原文：「在线个人数据／私有原媒体7日内删除，**备份30日内滚动清理**」（同句要求「注销立即撤会话和角色」）。过期会话只留不可逆 `token_hash`，用途是安全事件回溯；窗口与备份 30 日对齐，超窗即整行删除 |

两条都走 `delete`；`targetColumn` / `revisionColumn` / `markerSource` 均为 `null`。

字段口径：

| 字段 | 含义 | 校验（`assertRetentionPolicy`） |
| --- | --- | --- |
| `table` | `schema.table` 限定名 | 必须恰好两段、每段是合法标识符（无 schema 的 `sessions`、`public`、`public.sessions.extra` 一律拒绝，不会拼出 `"undefined"."x"`）；必须 `public.` 前缀；不得重复 |
| `ageColumn` | 算「年龄」的列：`cutoff = now − retentionDays×24h`，`ageColumn < cutoff` 即到期 | 必须是标识符；必须真的在该表建表语句里 |
| `retentionDays` | 保留天数 | 正整数（`0`/小数/负数一律报错） |
| `basis` | `legal` / `product` / `audit` 三选一 | 必须在闭集内 |
| `basisRef` | 依据出处，`文件:行` 或 `文件:起-止` | 必填、非空白；**且该行原文必须出现该天数或窗口词**（单测 §1b 实读校验；小时按 /24 折算） |
| `disposition` | `delete` / `anonymize` / `archive_marker` | 三选一，且与 `targetColumn`/`markerSource`/`revisionColumn` 的搭配必须自洽 |
| `targetColumn` | 匿名化或标记的列 | `delete` 必须为 `null`；`anonymize`/`archive_marker` 必须给 |
| `revisionColumn` | 匿名化时要一起推进的版本列 | **`anonymize` 必须声明**且不得等于 `targetColumn`；其它两种必须为 `null`。这道闸在**校验器与 SQL 生成器各查一次**（绕过 `assertRetentionPolicy` 直接拼 SQL 也会被拒），否则会拼出 `SET "detail" = NULL, "detail" = "detail" + 1` 到库才报 42601。口径对齐注销路径 `services/api/src/community/store-pg.ts:1005-1011`（`SET detail = NULL, revision = revision + 1`）：以 `revision` 做 CAS/失效判定的读者必须看得见这次变化 |
| `markerSource` | 标记值来源 | 仅 `archive_marker` 需要；当前只支持 `age_column`（`SET <target> = <ageColumn>`，**不读时钟**，重跑结果稳定） |

## 3. 排除清单（写进代码里的 `RETENTION_EXCLUSIONS`，不只是本文档）

| 表 | 为什么不纳入 | 归谁管 |
| --- | --- | --- |
| `public.admin_audit_events` | append-only 触发器拒绝 UPDATE/DELETE（`services/api/db/migrations/0017_account_suspend_authority.sql:104-115`） | 库层不可变；如需归档只能改表设计并单独评审 |
| `public.admin_sessions` | **拟过 90 天，但全仓无出处**（`docs/implementation-requirements.md:284` 只有「合法必要证据…单独限定目的、最小字段和时限」，没有数字）。本片**不销毁、也不做标记**；`archive_marker` 机制保留，将来口径定了直接启用 | 待口径立项（安全/审计） |
| `public.community_reports` | **拟过 180 天，同样无出处**。举报台账里 `detail` 是举报人手写自由文本，值得匿名化，但「几天后」没有依据。将来启用**必须** `revisionColumn: "revision"`（与注销路径同口径） | 待口径立项（法务/社区治理） |
| `public.media_object_cleanup` | 是**对象清理 outbox**，删行会丢掉「还有对象没删」的可重试依据 | 由清理端消费，不是保留期对象 |
| `public.user_backup_copies` | 另有 30 日驱动（`packages/privacy/backup-retention.mjs` + `tools/purge-expired-backup-copies.mjs`），按 `retention_until` 逐用户判定 | 备份轴（GY-I19） |
| `public.transcriptions` / `public.conversations` / `public.messages` | 需求要求**保留至注销**，不按日历删 | 注销闭集（F13） |
| `public.favorites` / `public.history` | 用户私有内容，没有独立的日历出处，随注销链处理：口径**类推**自 `docs/implementation-requirements.md:277`（「私有…识别记录原则保存至注销」，原文没有「收藏」二字），表语义见 `docs/architecture/data-dictionary.md:77-78`（`favorites`、`recognition_history` 两行） | 注销闭集 |
| 「注销证据」表（`docs/architecture/data-dictionary.md:89-91`）+ `deletion_tombstones` | 注销流程的状态机与第三方证据，删行＝删证据；tombstone 自带「保留期至少覆盖所有 30 日备份和恢复演练」（`docs/architecture/data-dictionary.md:92`） | 注销闭集 |
| `exports` / `export_writebacks` | 外发台账是合规证据（谁、何时、给谁、依据哪版授权） | 隐私域，按需单独定策略 |

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
| 幂等 | `delete`：行已不在即不再匹配；`anonymize`：额外 `AND target IS NOT NULL`，且同一条 `UPDATE` 里 `revision = revision + 1`；`archive_marker`：额外 `AND target IS NULL` 且标记值取自行内 `ageColumn` |
| 并发性质 | 同一批的 `ctid` 子查询与变更语句在**同一语句、同一快照**里求值；另有 `IS NOT NULL` 闸门兜住「别人已经处理过」的行 ⇒ **顺序重跑不会重复处理**（第二轮 0 行）；与注销路径/请求路径的 `UPDATE` 并发时，最坏情况只是该行**本轮跳过、下轮补上**。`anonymize` 的 `revision` 在 READ COMMITTED + HOT 更新下若与并发匿名化极端交错（对方在快照与 `UPDATE` 之间提交），外层 `ctid` 条件经 EPQ 重查后仍命中，`revision` 可能**多推进一次**（内容仍为 NULL，无实质破坏；本片未启用该处置） |
| 时刻源 | 唯一 `SELECT now()`（库时钟）；`cutoff` 逐表打印，dry-run 与真执行对得上 |
| 失败隔离 | 单表失败只记该表失败码，**不影响**其它表；有失败才返回 1 |

运行身份与权限（重要）：

| 表 | 需要的权限 | 现状 |
| --- | --- | --- |
| `public.idempotency_keys` | `DELETE` | 运行时角色 `gengyun_auth_privacy` 已有表级 `DELETE`（`services/api/db/roles/auth_privacy.sql:33`） |
| `public.sessions` | `DELETE` | **没有**（`services/api/db/roles/auth_privacy.sql:24-26` 只有列级 SELECT/INSERT/UPDATE）⇒ 该表必须用**库属主/运维角色**跑；本片**没有**给运行时角色加 `DELETE`（加授权会动到既有授权断言，属另一件事） |
| （已移出策略表）`public.community_reports.detail` | `UPDATE (detail)` | 运行时角色 `gengyun_api_runtime` **有**该列授权（`deploy/postgres-cvm/sql/20-login-roles.sql:566-568`），注销路径 `services/api/src/community/store-pg.ts:1005-1011` 就是用它写的；本片不登记该表，故与本片无关 |
| （已移出策略表）`public.admin_sessions.revoked_at` | `UPDATE (revoked_at)` | 运行时角色已有列级 `UPDATE`（`services/api/db/roles/auth_privacy.sql:31`）；本片不登记该表 |

⇒ 现实跑法：**用属主/运维连接串**跑（`DATABASE_URL` 只从环境变量读，不接受命令行明文，也不回显）。
`sessions` 是当前唯一「要删但运行时角色删不了」的表。权限不足时不会「装作成功」：真库臂里专门有一个
受限角色用例，`public.sessions` 报 `PERMISSION_DENIED`、该表一行未动、`public.idempotency_keys` 照跑、退出码 1。

调度建议（本片未接线）：

| 事项 | 现状 | 说明 |
| --- | --- | --- |
| 接线方式 | **未做** | 若要接 `deploy/purge-schedule/`，需同时补 `.service`（`ExecStart` 绝对路径 + `GY-SCHEDULE: npm-script=purge:retention`）与 `.timer`，并把 `purge:retention` 加进 `tools/verify-purge-schedule.mjs` 的 `REQUIRED_NPM_SCRIPTS`（**当前没加**：还没有对应 `.service`，加了会直接红） |
| **日级频率冲突** | **需先解决** | `tools/verify-purge-schedule.mjs` 的 `[calendar]` 判据要求每个 `.timer` 的 `OnCalendar` 展开间隔 **≤60 分钟**。保留策略天生是**日级**任务（1 天/30 天尺度的清理），按现有判据接线会直接红 ⇒ 要么先给该门禁开「日级例外」并写清判据，要么明确声明 `purge:retention` **仅手工/运维单次执行**、不进 timer 家族。在那之前按手工执行 |

## 5. 审计要求

每次运行（含 dry-run）都必须能回答「删了什么、按哪条依据、谁批的天数」。落盘要求：

| # | 要留什么 | 怎么留 | 为什么 |
| --- | --- | --- | --- |
| 1 | 运行时刻、模式（`dry-run`/`execute`）、`--batch`/`--max-batches` | 报告首行 `policy=GY-R34-RETENTION mode=… batch=… max-batches=…` | 事后要能复算「这一轮该删多少」 |
| 2 | 逐表：表名、处置、保留天数、依据、`basisRef`、`cutoff`、批数、行数、是否吃完、失败码（含 `revision_column`） | `--json` 报告保存原件（逐表一条 `entry`） | 只有行数没有 `cutoff` 等于无法复核 |
| 3 | 汇总：`tables/batches/rows/drained/failures` | 报告 `SUMMARY` 行 | 告警与看板的最小口径 |
| 4 | 失败表与其失败码（不记驱动原文） | `FAIL table=… code=…` | 原文可能含连接串/对象名；固定码足够定位 |
| 5 | 连接串与口令 | **任何输出都不得出现**（真库臂里有断言：输出不含 `postgresql://`、不含口令） | 日志是长期留存物 |

流程要求：

| 事项 | 要求 |
| --- | --- |
| 天数变更 | 改 `RETENTION_POLICY` 必须同时改本文档表格与单测；只改代码不改文档 ⇒ 评审直接打回 |
| 新增表 | 必须给出 `basis` + `basisRef`，且**`basisRef` 指向的那一行原文里要能读出这个天数或窗口**（单测 §1b 会实读校验）；并确认该表**没有** append-only 触发器 |
| 排除表 | 必须写进 `RETENTION_EXCLUSIONS` 并给理由；「没写」不等于「不做」 |
| 报告留存 | 建议按天留 `--json` 原件（与 `verify:purge-schedule` 的调度日志同源），留存期不短于被删对象的审计需要 |
| 删除不可逆 | 本执行器**不做**软删：`delete` 就是 `DELETE`；带「标记」语义的只有 `archive_marker`（当前无表启用）；`anonymize` 一定同时推进 `revisionColumn`，治理台账靠它看见变化 |

## 6. 与既有清扫/外发命令的边界

| 命令 | 域 | 判据 | 与本片的关系 |
| --- | --- | --- | --- |
| `npm run purge:online-data` | 注销主体的在线数据（按主体/表枚举，keyset 游标） | 注销受理 + 在线 7 日 | 不重叠：那是**按主体**删，本片是**按日历**删 |
| `npm run purge:backup-copies` | 逐用户备份副本（`retention_until`） | 备份 30 日 | 不重叠：备份轴另有驱动，且 `user_backup_copies` 已进排除清单 |
| 请求路径的即时清扫（`services/api/src/auth/idempotency.ts:233-236` 的 `purge`、`:261` 的 `claim`） | 幂等回执 | `expires_at <= now()`，同判据 | **重叠但不冲突**：请求路径顺手清（`claim` 时清同键过期行、`purge` 按时刻批量清），本命令是**离线兜底**（请求路径没跑到、或某段时间没有请求）。两边谁先删都一样：`delete` 幂等，不会「复活」行，也不会因为本命令而丢请求语义 |
| `npm run purge:retention`（本片） | 到期即无价值的通用台账/会话 | 表级 `ageColumn + retentionDays` | 与前两条**同构**（连接串只走 `DATABASE_URL`、dry-run 优先、退出码 0/1/2），不替代它们 |

## 7. 读数（2026-10-23，本 worktree 实测）

| 臂 | 命令 | 读数 |
| --- | --- | --- |
| 单测 | `node --test tests/unit/retention-policy.test.mjs` | **21/21 通过，0 失败**（`duration_ms` 288.4313，同代码另一次 1307.4588；P3 复审后补了「最后一道闸也挡 `revisionColumn === targetColumn`」一条，此前 20/20） |
| 真库臂 | `GY_PG_PORT=55435 node tests/integration/retention-purge-pg.mjs`（PG 17.11） | **8 个断言组全绿**；dry-run `rows=1205 batches=0`；真执行 `rows=1205`（删 1200+5）、`batches=4`；降级两表**一行未动**；第二轮 `rows=0`（2 次空批）`exit=0`；机制臂标记 4 行 / 匿名化 6 行且 `revision` 1→2、第二轮 0 行；受限角色 `exit=1`（`public.sessions` = `PERMISSION_DENIED`）。此前在 55438 / 55439 上复跑同样 8 组全绿 |
| 门禁 | `node tools/verify-purge-schedule.mjs` / `verify-layout.mjs` / `verify-doc-anchors.mjs --strict` | 三者均 `PASS` |

## 8. 未做项（如实登记）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 调度接线 | **未做** | 没往 `deploy/purge-schedule/` 加 `.service`/`.timer`；**且**现有 `[calendar]` ≤60 分钟判据与日级保留任务天然冲突，接线前需先定日级例外（见 §4 调度建议表） |
| CI 注册 | **未做** | `test:integration:retention-purge-pg` 只在本地跑过；CI 里没有 `GY_PG_BIN` 时该臂按既有约定 `exit 77` 跳过 |
| `admin_sessions` / `community_reports` 的处置 | **未启用（刻意）** | 90/180 天无出处 ⇒ 只进排除清单；`archive_marker` 与 `anonymize + revisionColumn` 的机制已在单测与真库臂覆盖，口径定了即可启用 |
| 运行时角色授权 | **未做（刻意）** | `public.sessions` 的 `DELETE` 没给运行时角色，跑法是用属主/运维连接串；要不要开权限属独立评审 |
| 归档表设计 | **未做** | `admin_audit_events` 需要归档时得先改表（加归档列或分区），append-only 触发器下无从下手 |
| 真实生产读数 | **未取得** | 只在本机临时集群（PG 17.11）取得读数，生产库上的行数与耗时未测 |
