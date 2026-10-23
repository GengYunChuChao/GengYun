# 证据页：数据保留策略表与清理执行器（GY-R34，2026-10-23）

**一句话结论**：跨表保留策略表（**2 张表**，只登记「有的出处天数」）＋幂等执行器 `npm run purge:retention` 已落地，
单测 **21/21 通过**，真库臂在 **PostgreSQL 17.11** 临时集群上 **8 个断言组全绿**：dry-run 一行未写、
真执行只删过期、未过期与贴边行一行未动、两张天数无出处而**降级**的表一行未动、重复执行 **0 行**、
机制臂（标记/匿名化 + `revision` 推进）可执行且第二轮 0 行、受限角色 **fail-closed 且不整轮停摆**。
**未取得**：生产库读数、调度接线、CI 注册（见文末）。

## 1. 交付落点

| 文件 | 做了什么 | 复核方式 |
| --- | --- | --- |
| `packages/privacy/retention-policy.mjs` | 声明式策略表 `RETENTION_POLICY`（**2** 条）＋排除清单 `RETENTION_EXCLUSIONS`（**9** 条）＋**14** 个稳定错误码＋`assertRetentionPolicy`／`retentionCutoffIso`／`retentionDuePredicate`／`buildRetentionCountSql`／`buildRetentionMutationSql`／`normalizeRetentionBatchLimit`／`normalizeRetentionMaxBatches`；`anonymize` 强制声明 `revisionColumn`（且**不得等于 `targetColumn`**），并在同一条 `UPDATE` 里 `revision = revision + 1` | 纯逻辑、无 IO、不读时钟；`node --test tests/unit/retention-policy.test.mjs` |
| `tools/purge-retention-expired.mjs` | 幂等清理执行器：默认 dry-run、`--yes` 才写库、`--batch`（≤500 硬顶）、`--max-batches`、`--table`、`--json`；一批一事务、失败 `ROLLBACK`、单表失败不拖垮其它表、退出码 0/1/2 | 同上；真库臂 |
| `tests/unit/retention-policy.test.mjs` | §1 表级自洽（无重复表、天数>0、依据必填、处置与目标列搭配、`revisionColumn` 必填且≠目标列）／**§1b 依据出处实读**（`basisRef` 指向的行必须真的写着该天数或窗口）／§2 与 migrations 实文对齐（正反两向）／§3 dry-run 只发 SELECT／§4 分批与事务／§5 幂等（第二轮 0 行、三种 SQL 形状、**最后一道闸**挡 `revisionColumn === targetColumn`）／§7 硬顶与表名两段解析／§8 失败码与 CLI 闸门 | `node --test tests/unit/retention-policy.test.mjs` |
| `tests/integration/retention-purge-pg.mjs` | 真库臂：起临时集群→跑全链迁移→造过期/未过期/贴边数据→dry-run→真执行→复核→第二轮→**机制臂（合成策略行）**→受限角色；`GY_PG_PORT` 可钉死端口 | 见 §3 命令 |
| `docs/architecture/gy-r34-retention-policy.md` | 策略表＋字段口径＋排除清单＋执行方式＋审计要求（表格化） | 文档评审 |
| `package.json` | 新增 `purge:retention`、`test:integration:retention-purge-pg` | `node tools/verify-purge-schedule.mjs` 仍绿 |

策略表（正式口径见架构文档 §2）：`idempotency_keys`（`expires_at`，1 天，产品，
`services/api/src/auth/idempotency.ts:32-33`，delete）、`sessions`（`expires_at`，30 天，审计留存，
`docs/implementation-requirements.md:278`，delete）。

**已降级为排除项**（原拟天数无任何出处）：`admin_sessions`（90 天，`archive_marker`）、
`community_reports`（180 天，`anonymize`）。两者的处置**机制**仍在代码里、由单测与真库臂机制臂覆盖，
但真实策略表里不再有它们的行 ⇒ 执行器不会碰它们（本页 §3 第 5 组读数就是「一行未动」）。

## 2. 读数一：单测

```
$ node --test tests/unit/retention-policy.test.mjs
✔ §1 策略表自洽：无重复表、天数>0、依据必填、处置与目标列搭配
…
ℹ tests 21   ℹ pass 21   ℹ fail 0   ℹ duration_ms 288.4313
```

（同一份代码多轮实测：`duration_ms` 229.4563 / 294.0028 / 1538.6355 时是 **20/20**；P3 复审后补了
「最后一道闸也挡 `revisionColumn === targetColumn`」一条，读数变为 **21/21**（两次 288.4313 与
1307.4588），差异都只是机器并行负载。）

## 3. 读数二：真库臂（临时 PG 17.11，端口 55435）

```
$ GY_PG_BIN=E:\GengYunCommander\.pg17\pgsql\bin \
  GY_R34_PG_ROOT=E:\GengYunCommander\.pg17\tmp \
  GY_R34_PG_LOG=E:\GengYunCommander\.pg17\tmp\r34-pg.log \
  GY_PG_PORT=55435 \
  node tests/integration/retention-purge-pg.mjs
PASS 1: [0] 全链迁移 32 个已应用；策略表 2 张表 + 机制臂 2 张表全部在岗
PASS 2: [1] 造数就位：idempotency 1200 过期/40 未过期/7 贴边；sessions 5/5/3；admin_sessions 4/4；reports 6 超期/4 未超期/2 早已匿名
PASS 3: [2] dry-run：报告 rows=1205 batches=0，库内计数与标记前后完全一致（一行未写）
PASS 4: [3] 真执行：删 1200+5 行；未过期与贴边行一行未动（keys=47 / sessions=8）；两张降级表零改动
PASS 5: [4] 复核：过期行清零；降级表一行未动（admin_sessions 4 行超期未标记 / community_reports 6 行 detail 非空，revision 全为 1）
PASS 6: [5] 重复执行：rows=0（2 张表各一次空批）exit=0，库内状态与上一轮完全一致
PASS 7: [6] 机制臂（合成策略行）：标记 4 行（值 = expires_at）、匿名化 6 行且 revision 1→2、早已匿名 2 行未再动、第二轮 0 行
PASS 8: [7] 受限角色：sessions 报 PERMISSION_DENIED 且一行未动，幂等台账照跑；exit=1

全绿：8 个断言组通过（临时集群端口 55438，日志 E:\GengYunCommander\.pg17\tmp\r34-pg.log）
$ echo $?  ⇒ 0
```

提交后在干净树上复跑过一次（`GY_PG_PORT=55439`）：同样 **8 个断言组全绿、`exit 0`**（PASS 文案逐字相同，只有端口不同）。

各步的执行器读数（同一轮，由 `--json` 报告解析并被真库臂逐条断言，`drained` 是「处理完的**表数**」不是批数）：

| 步骤 | 命令 | `totals.rows` | `totals.batches` | `totals.drained` | `totals.failures` | 退出码 |
| --- | --- | --- | --- | --- | --- | --- |
| dry-run | `--dry-run --json` | 1205（到期行数，不写库） | 0（不开批次） | 0 | 0 | 0 |
| 真执行 | `--yes --batch 500 --max-batches 10 --json` | 1205 | 4（幂等台账 500/500/200 三批 + 会话 1 批） | 2 | 0 | 0 |
| 重复执行 | `--yes --json` | **0** | 2（每表一次空批即 drained） | 2 | 0 | 0 |
| 机制臂 | in-process `runRetentionPurge`（合成 `archive_marker` 90 天 + `anonymize` 180 天含 `revisionColumn`） | 10（标记 4 + 匿名化 6） | — | — | 0 | — |
| 受限角色 | `--yes --json` | 1（只有幂等台账有 DELETE） | — | — | 1 | **1** |

## 4. 读数三：门禁

| 门禁 | 命令 | 读数 |
| --- | --- | --- |
| 调度层判据 | `node tools/verify-purge-schedule.mjs` | `PASS：10 项判据全部满足`（scripts 24 条、必需覆盖 2/2、`setInterval(` 命中 0、`.service`/`.timer` 各 2） |
| 布局 | `node tools/verify-layout.mjs` | `PASS`（五档视口触控区、正文、末屏预留含最大字号档） |
| 文档锚点 | `node tools/verify-doc-anchors.mjs --strict` | `PASS: --strict 下没有基线之外的新增`（扫 267 份、引用 4816 条；基线登记 103 条、本次命中 103 条、**基线外新增 0**、陈旧 0） |

## 5. 复现注意（踩过的坑，写给下一个人）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `initdb` 在 `%TEMP%` 下 `Permission denied` | 先 `mkdir` 再 `initdb` 会让它去 `chmod` 一个已存在的目录；不收权限的沙箱里 `chmod` 直接失败 | 只建父目录（`GY_R34_PG_ROOT`），数据目录交给 `initdb` 自己建 |
| `pg_ctl start` 报 `could not bind IPv4 address "127.0.0.1": Permission denied`（WSAEACCES） | 同机并行片太多：端口在本脚本 bind 探活通过之后、postgres 以 `SO_EXCLUSIVEADDRUSE` 独占绑定之前被别人抢走 | 真库臂已内置**换端口重试 6 次**（只在 `could not bind` 时重试，不重跑 `initdb`）；也可用 **`GY_PG_PORT`** 直接钉死一个空闲端口 |
| `AssertionError: GY_PG_PORT=… 已被占用` | 钉死的端口恰好被别的片占着 | 换一个；本机 55432–55467 往往只剩少数空闲（实测同一时刻只有 55433/55434/55436/55437–55440 空闲） |
| 端口 55432/55433/55434 与 55436 | 55432 是别的片常驻集群；另两个是并行片占用区；55436 有遗留集群 | 不要 `kill`；`pickPort()` 会跳过被占端口，它们也不在本片的取端口范围里 |
| `TypeError: 策略表第 1 行（…）必须显式声明 idempotent: true` | 合成策略行的 `idempotent` 必须是布尔 `true`，不是说明文字 | 说明写进 `why`，`idempotent` 给 `true` |

## 6. 未取得项

| 项 | 说明 |
| --- | --- |
| 生产库读数 | 只在临时集群取得读数；生产到期行数与耗时未测 |
| 调度接线 | `deploy/purge-schedule/` 未加 `.service`/`.timer`，`purge:retention` 未进 `REQUIRED_NPM_SCRIPTS`；且现有 `[calendar]` ≤60 分钟判据与日级保留任务冲突，接线前需先定日级例外（或声明仅手工执行） |
| CI 注册 | 真库臂只在本地跑过；CI 无 `GY_PG_BIN` 时按既有约定 `exit 77` 跳过 |
| `admin_sessions` / `community_reports` 的实际处置 | 90/180 天无出处 ⇒ 未启用（只在排除清单里）；机制已覆盖，口径定了即可启用 |
| 运行时角色授权 | `public.sessions` 的 `DELETE` 未加给运行时角色，跑法是属主/运维连接串 |
| `admin_audit_events` 归档 | append-only 触发器挡住 UPDATE/DELETE，要归档必须先改表设计 |
