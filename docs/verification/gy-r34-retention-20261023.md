# 证据页：数据保留策略表与清理执行器（GY-R34，2026-10-23）

**一句话结论**：跨表保留策略表（4 张表）＋幂等执行器 `npm run purge:retention` 已落地，
单测 **15/15 通过**，真库臂在 **PostgreSQL 17.11** 临时集群上 **7 个断言组全绿**：dry-run 一行未写、
真执行只删过期、未过期与贴边行一行未动、重复执行 **0 行**、受限角色 **fail-closed 且不整轮停摆**。
**未取得**：生产库读数、调度接线、CI 注册（见文末）。

## 1. 交付落点

| 文件 | 做了什么 | 复核方式 |
| --- | --- | --- |
| `packages/privacy/retention-policy.mjs` | 声明式策略表 `RETENTION_POLICY`（4 条）＋排除清单 `RETENTION_EXCLUSIONS`（6 条）＋14 个稳定错误码＋`assertRetentionPolicy`／`retentionCutoffIso`／`retentionDuePredicate`／`buildRetentionCountSql`／`buildRetentionMutationSql`／`normalizeRetentionBatchLimit`／`normalizeRetentionMaxBatches` | 纯逻辑、无 IO、不读时钟；`node --test tests/unit/retention-policy.test.mjs` |
| `tools/purge-retention-expired.mjs` | 幂等清理执行器：默认 dry-run、`--yes` 才写库、`--batch`（≤500 硬顶）、`--max-batches`、`--table`、`--json`；一批一事务、失败 `ROLLBACK`、单表失败不拖垮其它表、退出码 0/1/2 | 同上；真库臂 |
| `tests/unit/retention-policy.test.mjs` | §1 表级自洽（无重复表、天数>0、依据必填、处置与目标列搭配）／§2 与 migrations 实文对齐（正反两向）／§3 dry-run 只发 SELECT／§4 分批与事务／§5 幂等（第二轮 0 行）／§7 硬顶／§8 失败码与 CLI 闸门 | `node --test tests/unit/retention-policy.test.mjs` |
| `tests/integration/retention-purge-pg.mjs` | 真库臂：起临时集群→跑全链迁移→造过期/未过期/贴边数据→dry-run→真执行→复核→第二轮→受限角色 | 见 §3 命令 |
| `docs/architecture/gy-r34-retention-policy.md` | 策略表＋字段口径＋排除清单＋执行方式＋审计要求（表格化） | 文档评审 |
| `package.json` | 新增 `purge:retention`、`test:integration:retention-purge-pg` | `node tools/verify-purge-schedule.mjs` 仍绿 |

策略表（正式口径见架构文档 §2）：`idempotency_keys`（`expires_at`，1 天，产品，delete）、
`sessions`（`expires_at`，30 天，审计留存，delete）、`admin_sessions`（`expires_at`，90 天，审计留存，
archive_marker → `revoked_at`）、`community_reports`（`created_at`，180 天，法务，anonymize → `detail`）。

## 2. 读数一：单测

```
$ node --test tests/unit/retention-policy.test.mjs
ℹ tests 15   ℹ pass 15   ℹ fail 0   ℹ duration_ms 209.53
```

## 3. 读数二：真库臂（临时 PG 17.11，端口 55444）

```
$ GY_PG_BIN=E:\GengYunCommander\.pg17\pgsql\bin \
  GY_R34_PG_ROOT=E:\GengYunCommander\.pg17\tmp \
  GY_R34_PG_LOG=E:\GengYunCommander\.pg17\tmp\r34-pg.log \
  node tests/integration/retention-purge-pg.mjs
PASS 1: [0] 全链迁移 32 个已应用；策略表的 4 张表全部在岗
PASS 2: [1] 造数就位：idempotency 1200 过期/40 未过期/7 贴边；sessions 5/5/3；admin_sessions 4/4；reports 6 超期/4 未超期/2 早已匿名
PASS 3: [2] dry-run：报告 rows=1215 batches=0，库内计数与标记前后完全一致（一行未写）
PASS 4: [3] 真执行：删 1200+5 行、标记 4 行、匿名化 6 行；未过期与贴边行一行未动（keys=47 / sessions=8）
PASS 5: [4] 复核：过期行清零、后台会话标记值 = expires_at、超期举报的 detail 全部为 NULL
PASS 6: [5] 重复执行：rows=0（每表一次空批）exit=0，库内状态与上一轮完全一致
PASS 7: [6] 受限角色：sessions 报 PERMISSION_DENIED 且一行未动，其余三表照跑；exit=1
全绿：7 个断言组通过（临时集群端口 55444）
$ echo $?  ⇒ 0
```

各步的执行器读数（同一轮，由 `--json` 报告解析并被真库臂逐条断言，`drained` 是「处理完的**表数**」不是批数）：

| 步骤 | 命令 | `totals.rows` | `totals.batches` | `totals.drained` | `totals.failures` | 退出码 |
| --- | --- | --- | --- | --- | --- | --- |
| dry-run | `--dry-run --json` | 1215（到期行数，不写库） | 0（不开批次） | 0 | 0 | 0 |
| 真执行 | `--yes --batch 500 --max-batches 10 --json` | 1215 | 6（幂等台账 500/500/200 三批 + 其余三表各 1 批） | 4 | 0 | 0 |
| 重复执行 | `--yes --json` | **0** | 4（每表一次空批即 drained） | 4 | 0 | 0 |
| 受限角色 | `--yes --json` | 3（三张有授权的表各 1 行） | — | — | 1 | **1** |

## 4. 读数三：门禁

| 门禁 | 命令 | 读数 |
| --- | --- | --- |
| 调度层判据 | `node tools/verify-purge-schedule.mjs` | `PASS：10 项判据全部满足`（scripts 24 条、必需覆盖 2/2、`setInterval(` 命中 0、`.service`/`.timer` 各 2） |
| 布局 | `node tools/verify-layout.mjs` | `PASS`（五档视口触控区、正文、末屏预留含最大字号档） |
| 文档锚点 | `node tools/verify-doc-anchors.mjs --strict` | `PASS: --strict 下没有基线之外的新增`（扫 267 份、引用 4810 条；基线登记 103 条、本次命中 103 条、**基线外新增 0**、陈旧 0） |

## 5. 复现注意（踩过的坑，写给下一个人）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `initdb` 在 `%TEMP%` 下 `Permission denied` | 先 `mkdir` 再 `initdb` 会让它去 `chmod` 一个已存在的目录；不收权限的沙箱里 `chmod` 直接失败 | 只建父目录（`GY_R34_PG_ROOT`），数据目录交给 `initdb` 自己建 |
| `pg_ctl start` 报 `could not bind IPv4 address "127.0.0.1": Permission denied`（WSAEACCES） | 同机并行片太多：端口在本脚本 bind 探活通过之后、postgres 以 `SO_EXCLUSIVEADDRUSE` 独占绑定之前被别人抢走 | 真库臂已内置**换端口重试 6 次**（只在 `could not bind` 时重试，不重跑 `initdb`） |
| 端口 55432 上常驻别的集群 | 那是另一条片的 `login-ready/pgdata`，不属本片 | 不要 `kill`；`pickPort()` 会跳过被占端口 |

## 6. 未取得项

| 项 | 说明 |
| --- | --- |
| 生产库读数 | 只在临时集群取得读数；生产到期行数与耗时未测 |
| 调度接线 | `deploy/purge-schedule/` 未加 `.service`/`.timer`，`purge:retention` 未进 `REQUIRED_NPM_SCRIPTS` |
| CI 注册 | 真库臂只在本地跑过；CI 无 `GY_PG_BIN` 时按既有约定 `exit 77` 跳过 |
| 运行时角色授权 | `sessions`/`community_reports` 的 `DELETE`/`UPDATE` 未加给 `gengyun_auth_privacy`，跑法是属主/运维连接串 |
| `admin_audit_events` 归档 | append-only 触发器挡住 UPDATE/DELETE，要归档必须先改表设计 |
