# E2：#19「在线 7 日／备份 30 日」缺的那个执行者 —— 备份副本 30 日到期清除驱动（P0-4 / G9）

## 0. 本页性质与判定口径

| 项 | 读数 |
| --- | --- |
| 基点 | `3935c55`（`fix(i11): 语音输入四段盘点与必要接线（临时文件回收 / 403 不折叠 / 上传号成对复位） (#395)`） |
| 分支 | `feat/gy-r28-e2-backup-driver`（worktree `E:\GengYunCommander\wt-e2-backup-driver`） |
| 覆盖 issue | #19（GY-I19）的 **P0-4** 一项；旁及 #16/#17 的「30 日备份链」断点 |
| 是否改代码 | **是**：新增 5 个文件（含本页）+ 改 3 个既有文件（清单见 §2.4）。**未改**迁移、`packages/contracts/**`、`openapi.json`、`.github/workflows/**`、`services/api/src/messages/**` |
| 术语 | 「**组**」= `(request_id, user_id, module)` 三元组，即端口 `purge()` 的入参单位（一次清掉该三元组下所有到期 scope）；「**行**」= `user_backup_copies` 的一行 |
| 读数来源 | 本机真实 PostgreSQL **17.11**（自起临时集群，仅回环 127.0.0.1）；单测 + 真库臂 + CLI 端到端，原始输出见 §5/§6 |

---

## 1. 断点复述（三段，逐段独立成立）

前一片的盘点在 `docs/verification/gy-i16-i17-deletion-cascade-20261021.md` §4.1 里钉死过三段断点。本片先把它们逐条复核了一遍，再动手：

| # | 断点（原判） | 复核方式与本片读数 | 本片做了什么 | 没做什么（及理由） |
| --- | --- | --- | --- | --- |
| ① | **无调度**：清除端口只有「受理事务 + 处理器」两个调用方（`services/api/src/privacy/account-deletion.ts:225-228`），GET 回执不执行处理器 | 复核成立：全仓 `services/api/src` 仍**零** `setInterval`/scheduler/worker | 新增**运维命令** `tools/purge-expired-backup-copies.mjs`（可直接被外部 cron 驱动） | ⛔ **没有**加进程内定时器：本仓没有进程级调度基础设施，且常驻定时器会与 CI/真库抢同一批行、进程重启即失去语义 |
| ② | **再受理被确定性拒绝**：`0016_account_deletion_persistence.sql:112-114` 对 `state='deletion_pending'` 抛 `G0003` ⇒ 不能靠「再发一次注销」触发到期清除 | 复核成立（本片**未改**该函数） | 驱动**完全绕开**受理函数：只读 `user_backup_copies`、只调 `BackupPurgePort`，不发 HTTP、不碰 `deletion_requests` 状态（真库臂 [11] 实测：受理行 `state` 全部仍是 `requested`） | ⛔ 没动 `G0003` 这道门（它对「并发双受理」是正确的保护） |
| ③ | **没有可清的 scope**：`packages/privacy/backup-copies.mjs:38-41` 闭集只有 `favorite`/`history`，`:56-61` 未登记即抛 | 复核成立 | **一行未改** `BACKUP_COPY_SCOPES` | ⛔ 消息域纳入是另一片（C1b）在做，同时改会冲突。本驱动按 `module` 分组、**不按 scope 分支**，所以闭集未登记时它不会「猜一个 scope 出来」，只是把库里真实存在的行按三元组交给端口 |

**一句话**：本片补的是第 ③ 段之前那个「谁在 30 天后真的去清」的执行者（G9）。它不改变任何「哪些域进备份」的判断——那是 C1b/后续片的事。

---

## 2. 驱动形态与理由

### 2.1 结论：选 (A) 运维命令，不选 (B) 内部维护端点

| 维度 | (A) `tools/purge-expired-backup-copies.mjs`（**采纳**） | (B) 服务端内部维护入口（未采纳） |
| --- | --- | --- |
| 前置条件 | 只要能连库（**运行时角色即可**，零新增授权，见 §4） | 需服务在线 + `requireAdmin` + 新 scope 的审计链 + 服务部署 |
| 与现有失败面的关系 | 独立于 API 进程：注销面 `real` 模式整域 503（G10，`app.ts:1490-1495`）也不影响它 | 直接落在那个「整域 503」的服务里，多一层失败点 |
| 调度 | 由**外部 cron / systemd timer / 云定时任务**重复调用；`exit code` 就是判据 | 仍需外部 cron 来调这个端点（等于把 cron 藏进服务里） |
| 与 CI/真库冲突 | 无（一次性进程，跑完就退） | 常驻定时器会与 CI 真库臂抢行；本片明令禁止 `setInterval` |
| 可测性 | 纯逻辑（`runBackupPurgeBatch`）可单测，CLI 可端到端跑 | 需起 HTTP + 管理员会话，测试面更大 |
| 红线 | 本片不改 `.github/workflows/**` ⇒ 不往 CI 里塞东西，只在 `package.json` 加一条脚本 | 需要在 CI/部署里加 secret 与路由，越界 |

### 2.2 形状：`扫描 → 逐组清除 → 读数`

```text
tools/purge-expired-backup-copies.mjs            # 薄 CLI：参数 / 连接 / 退出码（172 行）
  ├─ SELECT now()                                # ① 一次取定 cutoff（库时钟，不信本机时钟）
  ├─ listDueBackupCopyGroups(pool, {cutoff,limit})   # ② 到期扫描（只读，走 0023 的部分索引）
  ├─ createPostgresBackupPurgePort({pool, now:()=>cutoff})  # ③ 既有端口，时钟钉在同一个 cutoff
  └─ runBackupPurgeBatch({...})                  # ④ 逐组编排 + 读数（纯逻辑）
       └─ formatBackupPurgeReport(report)        # ⑤ 人类可读 + 一行 SUMMARY（key=value）
```

核心在 `services/api/src/privacy/backup-purge-driver.ts`：

- 到期扫描 SQL：`:136`（`BACKUP_COPY_DUE_GROUPS_SQL`）、部分到期计数 `:172`（`BACKUP_COPY_MIXED_GROUPS_SQL`）；
- 显式重排 SQL：`:197`（`BACKUP_COPY_REQUEUE_FAILED_SQL`）；
- 读库入口：`listDueBackupCopyGroups()` `:250`、`requeueFailedBackupCopyGroup()` `:294`；
- 逐组编排（纯逻辑，不读库/不读时钟）：`runBackupPurgeBatch()` `:387`；
- 退出码：`backupPurgeExitCode()` `:539`；读数渲染：`formatBackupPurgeReport()` `:552`。

### 2.3 与既有端口的关系：**只复用，不重写**

清除动作本身仍由 `services/api/src/privacy/backup-copies-pg.ts` 的 `purge()` 完成（`:250-356`）：事务内 `UPDATE … WHERE state='pending_purge' AND retention_until <= $4`（`:74-82`）→ **同事务复核** → 才 `COMMIT` 并返回证据；失败则回滚 + 写 `failed`/`last_error_code`/`purge_attempts+1`（`:283-285`、`:339-349`）。本片**一行都没改**那个文件——驱动是「调用方」，不是第二套清除实现。

### 2.4 本片文件清单

| 文件 | 类型 | 作用 |
| --- | --- | --- |
| `services/api/src/privacy/backup-purge-driver.ts` | 新增 | 到期扫描 SQL + 显式重排 + 逐组编排（纯逻辑）+ 读数/退出码 |
| `tools/purge-expired-backup-copies.mjs` | 新增 | 运维命令（参数、连接、`SELECT now()`、调用、退出码） |
| `tests/unit/backup-purge-driver.test.mjs` | 新增 | 纯逻辑单测（17 条） |
| `tests/integration/backup-copies-purge-pg.mjs` | 新增 | 真库集成臂（14 条断言，缺 `GY_PG_BIN` ⇒ 77 跳过） |
| `package.json` | 修改 | `purge:backup-copies`、`test:integration:backup-copies-purge-pg` 两条脚本 |
| `tests/unit/sql-column-coverage.test.mjs` | 修改 | 把新 SQL 宿主登记进 `UNAUDITED_SQL_HOSTS`（理由+owner），并把「SQL 宿主 = 16 已审计 + 5 登记 / 21 个」更新为 6 / 22 |
| `tests/unit/ci-integration-chain-structure.test.mjs` | 修改 | 把新集成脚本登记进 `UNWIRED_DECLARATIONS`（同上：未接任何 workflow 的原因） |

---

## 3. 行为契约（不变量 → 实现 → 证据）

| 不变量 | 实现 | 证据（单测 / 真库） |
| --- | --- | --- |
| **未到期绝不清** | ① SQL：先只在**到期行**上找候选三元组（走 `0023:88-90` 的部分索引），再回到该三元组**全部未清行**上聚合，`HAVING max(retention_until) <= cutoff`；② runner 侧再复核一次 `retentionUntil <= cutoff`（`not_due` 跳过）；③ 边界取**闭区间**（相等即到期），与 `packages/privacy/backup-retention.mjs:219` 的 `nowMs >= untilMs` 同口径 | 单测「到期边界：恰好等于 cutoff ⇒ 清除；早 1 秒 ⇒ 清除；晚 1 秒 ⇒ 跳过且从不调 purge」；真库 [2][3]：晚 1 秒的组不在集合内、`payload` 原样 |
| **部分到期不清**（本片实测踩到的坑） | 朴素写法 `WHERE 到期 + HAVING max(...)` 会让未到期行**不参与分组**，`HAVING` 退化成空操作 ⇒ 部分到期的组被放进来，端口按 `backup-copies-pg.ts:309-315` 回滚并把未到期行标 `failed`。本片改成「先取候选三元组、再回到全部未清行聚合」，并把这类组**单独计数上报**（`mixed_groups`），只上报不处理 | 真库 [5]（端口直接调 ⇒ blocked + 该行 `failed`、`purge_attempts=1`）、[7]（驱动侧：该组**不进**待清集合、`mixedGroups=1`、退出码 1） |
| **失败不阻塞** | 单组 `blocked`/抛错只计入该组失败，循环继续；端口抛错折叠为 `DRIVER_EXCEPTION` | 单测「第 1 组 blocked、第 2 组抛错，第 3 组照样清除」；真库 [6]：注入一组 blocked，同批另一组照常 purged |
| **每个成功行都有清除证据** | 由端口写：`payload='null'` + `purged_at` + `evidence_ref`（`sha256:…`），库侧 CHECK 兜住（`0023:69-76`） | 真库 [3]：证据由行内 `payload_digest` 用 `purgeEvidenceRef()` **独立复算逐字相等** |
| **重复跑幂等** | 成功组变 `state='purged'` ⇒ 下次扫描（`state <> 'purged'`）取不到 | 单测「幂等重跑」；真库 [10]：第二次 `candidates=0 / processed=0`，已清行 `purged_at`/`purge_attempts`/`evidence_ref` 逐行不变 |
| **批量上限可配** | `--limit N`（默认 200、硬顶 5000，非法值**抛错不夹取**）；SQL `LIMIT` + runner 侧 `processed >= limit` 双闸；`total_due` 用窗口函数在 `LIMIT` 前算 ⇒ 一次给出「还剩多少」 | 单测「limit=2 只处理前 2 组、剩余 2」+ 校验 0/负/小数/超顶；真库 [4]：limit=2 两批清完 3 组 |
| **`failed` 行不被静默吞掉** | 默认**跳过**并计入 `failed_needs_requeue`（退出码 1）——因为端口对含 `failed` 行的组明确返回 `blocked`/`STORE_REJECTED`，重试不会自愈；显式 `--retry-failed` 才把**已到期**的 `failed` 行改回 `pending_purge`（保留 `last_error_code`/`purge_attempts` 作留痕） | 单测 3 条；真库 [8][9] |
| **不改回执、不改受理状态** | 驱动只读写 `user_backup_copies`（读 `request_id/user_id/module/state/retention_until`，写 `state/updated_at`） | 真库 [11]：`deletion_requests` 9 行、`users` 10 行原样，`state` 全部仍是 `requested` |
| **隐私口径：不打印主体** | 输出只含 `request_id`（不透明 uuid）+ `module` + 证据摘要 | 单测「输出不得含主体 id」 |

### 3.1 为什么需要「显式重排」而不是自动重试

端口对 `failed` 行的答案是**确定性的** `blocked`（`backup-copies-pg.ts:283-285`「已有清除失败行，需显式重排」）。自动重试会把「真因」冲掉（每次都 `purge_attempts+1` 而没人看），也会让运维误以为链路自愈。所以本驱动的默认口径是「看得见但不自动重试」，把「重排」做成一个**需要人说一句**的动作（`--retry-failed`）。

---

## 4. 权限口径：**零新增授权**（这是本片最容易被改坏的地方）

运行时角色 `gengyun_api_runtime` 对 `user_backup_copies` 拿的是**列级**权限（`services/api/src/db/roles/auth_privacy.sql:59-66` 与 `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-i19-backup-copies-grant` 区域各一份）。本驱动用到的列**全在授权清单内**：

- 读：`request_id`、`user_id`、`module`、`state`、`retention_until`（`auth_privacy.sql:59` 的 SELECT 列表里都有）；
- 写：`state`、`updated_at`（`:65` 的 UPDATE 列表里都有）。

因此 `20-login-roles.sql`、`90-assert-least-privilege.sql` 的 `table_dml_allowlist`、`expected(tbl,…,del)` **三处一处都没改**。真库臂用运行时角色实测了这条结论（不是引用注释）：

```text
表级 SELECT/INSERT/UPDATE = false，列级 SELECT = true，state 列 UPDATE = true，
payload 列 SELECT = false，DELETE FROM public.user_backup_copies ⇒ SQLSTATE 42501
```

---

## 5. 自检真实输出

### 5.1 静态检查

```text
> node tools/lint-workspaces.mjs
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
```

### 5.2 新单测（`tests/unit/backup-purge-driver.test.mjs`，17 条）

```text
✔ 到期边界：恰好等于 cutoff ⇒ 清除；早 1 秒 ⇒ 清除；晚 1 秒 ⇒ 跳过且从不调 purge
✔ 未到期不动：全部未到期时一个 purge 调用都没有，退出码仍是 0（不是失败）
✔ 批量上限：limit=2 时只处理前 2 组，剩余计入 remaining（下一轮再取）
✔ 批量上限校验：0／负数／小数／超硬顶一律抛错（不静默夹取）
✔ 失败不阻塞：第 1 组 blocked、第 2 组抛错，第 3 组照样清除
✔ 端口返回 waiting（复核后仍未到期）⇒ 计跳过，⛔ 不算成功
✔ 旧式返回值 {purged:false} 无 outcome ⇒ 按 blocked 计失败（不静默当跳过）
✔ 幂等重跑：成功清过的组从待清集合消失 ⇒ 第二轮 0 组、0 行、退出码 0
✔ failed 行：默认改跳过（不调 purge），退出码 1（链路还有清不掉的副本行）
✔ failed 行：--retry-failed 先重排再清除，重排计数如实报出
✔ failed 行：重排失败 ⇒ 该组失败（REQUEUE_FAILED）且不调 purge；未接重排实现 ⇒ REQUEUE_UNAVAILABLE
✔ --dry-run：到期的组全部计 dry_run，端口与重排一次都不被调用
✔ cutoff 不可解析 ⇒ 抛错（不猜时间、不静默跑空批）
✔ 读数：成功+跳过+失败 ≡ 处理组数；剩余 = 库内合计 − 处理；细节行不含主体 id
✔ 退出码：干净批次 0；有失败组 1；有「部分到期」组 1（不清但必须让人看见）
✔ 到期扫描 SQL：候选只在到期行上取，再对整组全部未清行做 max 判定（朴素 HAVING 会退化成空操作）
✔ 显式重排：改到行 ⇒ true；0 行且复核无 failed ⇒ true（并发者已重排）；0 行但仍有 failed ⇒ false

ℹ tests 17 / pass 17 / fail 0
```

### 5.3 同域既有套件（privacy / backup / deletion 命名）

```text
node --test tests/unit/backup-purge-driver.test.mjs tests/unit/backup-retention.test.mjs \
  tests/unit/backup-copies-port-contract.test.mjs tests/unit/user-data-deletion.test.mjs \
  tests/unit/account-deletion-receipts.test.mjs tests/unit/favorites-history-deletion-registration.test.mjs \
  tests/unit/conversation-deletion.test.mjs tests/unit/messages-deletion-purge.test.mjs tests/privacy/*.test.mjs
ℹ tests 294 / pass 294 / fail 0
```

### 5.4 全量单测（`npm run test:unit`）

```text
ℹ tests 3322 / pass 3321 / fail 0 / skipped 1 / todo 0        （exit code 0）
```

**如实说明抖动**：本机内存紧张，同一命令在本片实测里连跑 4 次，前 3 次各有 1–3 个**互不相同**的文件级失败
（`knowledge-api`、`knowledge-order-sql-direction`、`media-attachment-limit`、`contract-status-tool`），
第 4 次全绿。逐个单跑均通过（示例读数：`knowledge-order-sql-direction` + `media-attachment-limit`
⇒ `tests 11 / pass 11 / fail 0`；`contract-status-tool` ⇒ `tests 18 / pass 18 / fail 0`；
`knowledge-api` ⇒ `tests 10 / pass 9 / fail 0`）。**本片没有并行跑第二套全量**；上述失败与备份副本域无关
（新单测在 3 次红里都是绿的），判为机器负载抖动，不当作通过。

### 5.5 真库臂（本机实跑，exit code **0**）

```text
$env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'
$env:GY_I19_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp'
node tests/integration/backup-copies-purge-pg.mjs
```

```text
  - 临时集群：数据目录 …\tmp\gy-i19-purge-pg-cf1eea34，端口 55718（只监听 127.0.0.1）
  - PostgreSQL 17.11
  - 迁移已应用：26 个（0001_initial_schema.sql … 0026_speech_persistence.sql）
  - 已执行 20-login-roles.sql 的 gy-i19-backup-copies-grant 区域（列级 SELECT/INSERT/UPDATE；无表级 DML、无 DELETE）
PASS 1: 权限形状：运行时角色只有列级 SELECT/UPDATE（表级 DML=false、payload 不可读、DELETE=42501）⇒ 本驱动零新增授权
PASS 2: 到期扫描（cutoff=2026-10-21T00:00:00.000Z）：取到 2 组（恰好等于 cutoff、早 1 秒），晚 1 秒的组不在集合内；total_due=2
PASS 3: 到期清除：2 组 purged（payload=null、purged_at=cutoff、证据由 payload_digest 独立复算相等）；晚 1 秒组仍 pending_purge 且 payload 原样
PASS 4: 批量上限：limit=2 时第一批只清 2 组（剩余 1 组仍 pending_purge），第二批清掉最后 1 组
PASS 5: 真实端口的失败留痕：部分到期的组 ⇒ blocked，行置 failed（last_error_code=EVIDENCE_REQUIRED、purge_attempts=1），未到期行 payload 仍在
  - 失败不阻塞的那一轮读数：处理 2 组 / 成功 1 / 跳过 0 / 失败 1
PASS 6: 失败不阻塞：一组注入 blocked（退出码 1），同批的另一组照常清成 purged
PASS 7: 部分到期：mixed 组不进待清集合、mixedGroups=1、退出码 1（只上报不处理）
  - 已清理本脚本构造的「部分到期」组（仅测试库；产线不应出现这种形状）
PASS 8: failed 行默认口径：扫描能看到该组，但本轮不清（state 仍 failed、payload 仍在、purge_attempts 不变），退出码 1
PASS 9: --retry-failed：failed 行改回 pending_purge 后清成功（payload=null），last_error_code/purge_attempts 作为留痕保留
  - 幂等重跑的读数：candidates=0 processed=0 failed=0 remaining=0
PASS 10: 幂等重跑：第二次运行 0 组 / 0 行（已清 8 行的 purged_at/purge_attempts/evidence_ref 逐行不变），退出码 0
PASS 11: 边界外：deletion_requests(9 行) 与 users(10 行) 未被驱动改写（state 全部仍是 requested）
PASS 12: --dry-run：EXITCODE=0，看到到期组但一行未清（status 仍 pending_purge、payload 原样）
PASS 13: CLI 端到端：node tools/purge-expired-backup-copies.mjs --limit 50 ⇒ EXITCODE=0，到期行 purged、未到期行原样
  - CLI 第二次输出尾部：
[purge-expired-backup-copies] SUMMARY cutoff=2026-10-21T14:00:17.257Z limit=200 candidates=0 total_due=0 processed=0 succeeded=0 skipped=0 failed=0 requeued=0 rows_purged=0 remaining=0 mixed_groups=0 exit=0
[purge-expired-backup-copies] 没有到期的备份副本行（此前已清或 30 日窗口未到），本轮无需动作
PASS 14: CLI 幂等：第二次运行 exit=0 且打印「没有到期的备份副本行」（0 组）

ALL PASS：14 条真库断言（exit code 0）
```

> 端口先**探活再 initdb**：本片开发时就撞到过 55613 已被别的临时集群占用（`could not create any TCP/IP sockets`），
> 所以脚本取 556xx 后会先用 `net.createServer().listen` 探一次空闲再起集群（并避开 55436）。

### 5.6 判定：本片自检结论

| 项 | 读数 |
| --- | --- |
| `npm run lint` | **通过**（tsc ×2 + 仓库卫生扫描） |
| 新单测 | **17 / 17 通过** |
| 同域既有套件 | **294 / 294 通过** |
| `npm run test:unit` 全量 | **3322 tests / 0 fail**（第 4 次；前 3 次抖动已逐文件单跑证伪，见 §5.4） |
| 真库集成 | **14 / 14 通过，exit code 0** |
| 未取得 | 见 §7（真实 CVM、真实 cron、回执 `backupState` 接线） |

---

## 6. 如何运维（一条命令 + 期望输出）

### 6.1 前置

- 一个**能连库**的连接串（运行时角色 `gengyun_api_runtime` 即可，⛔ 不需要属主、⛔ 不需要新授权）；
- 迁移 `0023_user_backup_copies.sql` 已执行（否则命令会以退出码 2 明说「迁移未执行」）；
- 连接串**只从环境变量** `DATABASE_URL` 读（⛔ 不接受命令行明文；命令也不回显 DSN）。

### 6.2 命令

```bash
# 常规一轮（默认每批 200 组）
DATABASE_URL='postgresql://<role>:<pass>@<host>:5432/<db>' npm run purge:backup-copies

# 只看不清（核对到期面）
DATABASE_URL='…' npm run purge:backup-copies -- --dry-run

# 有 failed 行需要显式重排时
DATABASE_URL='…' npm run purge:backup-copies -- --retry-failed

# 限流（每轮最多处理 50 组，剩下的下一轮再取）
DATABASE_URL='…' npm run purge:backup-copies -- --limit 50
```

等价的直接调用：`node tools/purge-expired-backup-copies.mjs --limit 50`。

### 6.3 期望输出（同一格式化函数的真实产出；此样例为注入假端口所得，非真库读数）

```text
[purge-expired-backup-copies] cutoff=2026-10-21T00:00:00.000Z limit=200 retry-failed=false dry-run=false
[purge-expired-backup-copies] 到期组：本批取到 4 组（库内合计 4 组）
[purge-expired-backup-copies] 处理 4 组 / 成功 2（置 purged 2 行） / 跳过 2 / 失败 0
[purge-expired-backup-copies] 跳过明细：failed_needs_requeue=1 not_due=1
[purge-expired-backup-copies] 剩余未处理 0 组（下一轮再取）
[purge-expired-backup-copies] SUMMARY cutoff=… limit=200 candidates=4 total_due=4 processed=4 succeeded=2 skipped=2 failed=0 requeued=0 rows_purged=2 remaining=0 mixed_groups=0 exit=1
```

失败行会各占一行（便于 `grep FAIL`）：

```text
[purge-expired-backup-copies] FAIL request=<uuid> module=favorites error=STORE_UNREACHABLE reason=清除事务失败
```

`SUMMARY` 那一行是给 cron/日志抓的：`key=value` 固定顺序，含 `remaining`（库内还剩几组）与 `mixed_groups`。

### 6.4 退出码（cron 的唯一判据）

| 退出码 | 含义 | 期望动作 |
| --- | --- | --- |
| `0` | 本轮没有失败组、没有待重排的 `failed` 行、没有「部分到期」的组（**含 0 组可做**：重复跑第二次就是 0 组） | 无事 |
| `1` | 有失败组 / 有 `failed_needs_requeue` / 有 `mixed_groups > 0` | 看 `FAIL` 行与 `mixed_groups`；必要时 `--retry-failed` 或人工处置 |
| `2` | 参数/配置/连接类错误（缺 `DATABASE_URL`、`--limit` 非法、缺表 `42P01`、缺列级授权 `42501`…） | 修配置/迁移/授权，**不要**重试到天亮 |

### 6.5 外部调度（示例，**不在本仓**）

```cron
# 每天 03:17 UTC 跑一轮；失败会以非 0 退出码进 mail/cron 日志
17 3 * * * cd /srv/gengyun && DATABASE_URL="$(cat /etc/gengyun/db.url)" \
  node tools/purge-expired-backup-copies.mjs --limit 500 >> /var/log/gengyun/purge-backup-copies.log 2>&1
```

systemd timer 同理。**本片没有**往 `.github/workflows/**` 里加任何东西（红线），也没有提交任何真实 cron 配置。

---

## 7. 未取得（本页不得据以推断已通过）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| **真实 CVM 上的运行读数** | **未取得** | 本页所有真库读数都来自本机自起的临时集群（PostgreSQL 17.11，仅回环）。`deploy/postgres-cvm` 那套（`20-login-roles.sql` 全量 + `90-assert-least-privilege.sql`）**没有**在真实 CVM 上跑过本命令 |
| **真实外部 cron / systemd timer 接线** | **未取得** | 命令是「可被 cron 调用」的形态，但仓库内没有任何调度器接线；`crontab` 不在仓库内，`.github/workflows/**` 本片禁改 ⇒ 真正的定时触发**尚未发生** |
| **回执 `backupState: 'completed'`** | **本片不负责，仍未取得** | 本驱动只清副本行 + 写证据（`user_backup_copies.state='purged'`）。进程内回执的 `backupState` 只有在协调器 `executeHandlers()` 里才会被改写（G5/G11 是另一片）。**不要**把「副本已清」读成「回执已 completed」 |
| **真实 31 天等待** | 未做（也不该在 CI 做） | 边界臂用**注入固定 cutoff**（`2026-10-21T00:00:00.000Z`）+ 真库；CLI 臂用库自己的 `now()` 但夹具是「过去 5 天到期」。真实 30 日墙钟等待没有发生 |
| **消息域 / 会话域 / 社群域的副本行** | 无 | 闭集仍只有 `favorite`/`history`（本片未改，C1b 在做消息域）；这些域**没有副本清单行**，所以本驱动对它们「无对象可清」，不是「已清干净」 |
| **大表性能 / 长跑** | 未测 | 扫描走 `0023:88-90` 的部分索引（`state <> 'purged'`），但 `mixed_groups` 那条计数在极端数据量下的耗时未测；`--limit` 与「反复调用」是当前唯一的容量手段 |
| **`real` 模式注销面放开（G10）** | 未做 | `app.ts:1490-1495` 仍整域 503；本驱动独立于该面运行，不解决它 |

---

## 8. 待裁决（编号列表，供指挥排期）

| 编号 | 待裁决项 | 本片立场 |
| --- | --- | --- |
| **D1** | 是否把 `tests/integration/backup-copies-purge-pg.mjs` 接进 `.github/workflows/real-pg-integration.yml`（与 `backup-purge-pg.mjs` 同一套 `GY_PG_BIN` 步骤） | 本片红线禁止改 workflows ⇒ 已在 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS` 如实登记「未接线 + 原因」。**建议接**（它是这条链唯一的真库读数来源） |
| **D2** | `privacy/backup-purge-driver.ts` 是否纳入 `tests/unit/sql-column-coverage.test.mjs` 的「16 文件」静态列面管线 | 纳入需重定该片 `auditedFiles 16→17` 等钉死读数（属 R28-S66 的读数），故本片只登记进 `UNAUDITED_SQL_HOSTS`（理由+owner），列面另有**真库实测**背书（§4）。**建议**由 R28-S66 统一收口 |
| **D3** | `mixed_groups`（部分到期）是否要进告警/监控 | 本片让它进 `SUMMARY` 并影响退出码 `1`；产线不应出现该形状（同一受理的所有副本行 `retention_until` 恒等于 `backup_due_at`）。是否要单独告警阈值需指挥/运维定 |
| **D4** | `failed` 组的「自动重试上限」是否需要 | 本片**不做自动重试**：端口对 `failed` 明确返回 `blocked`（重试不会自愈），自动重试会掩盖真因。若后续要自动重试，建议先定「最多 N 次 + 退避 + 到顶后必须人工」 |
| **D5** | 订阅/回执侧的 `backupState` 何时接上本驱动 | 属 G5/G11（会话域编排 + 持久审计）；本片只清副本行。**不要**把两者合并成一片做（那会同时动审计落表与回执 TTL） |
| **D6** | `--limit` 的默认值 200 是否合适 | 本片取 200（单轮 200 组 ≈ 几百行）；真实库量级未测，等 CVM 读数再定 |

> **状态更新（后续，2026-10-21 补注；上表原文不改）**
>
> - **D1 已按「建议接」落实**：另有在飞 PR（分支 `test/gy-r28-e5-backup-driver-ci`，PR #400，**尚未合入**）
>   把 `tests/integration/backup-copies-purge-pg.mjs` 接进 `.github/workflows/real-pg-integration.yml`（受管脚本第 14 条，自起集群形态）。
>   因此本表 D1 的「本片红线禁止改 workflows ⇒ 未接线」只是本片的当时状态，**不是现行状态**；未合入前也不得记作「已接线」。
> - **§1 第 ③ 条与 §7「消息域／会话域／社群域的副本行」的读数已过期**：`#397` 已把 `BACKUP_COPY_SCOPES` 扩到四域
>   （`packages/privacy/backup-copies.mjs:42-47`：`favorite`／`history`／`message`／`conversation`），消息域与会话域**都有**副本清单行；
>   只有社群域仍无 scope。本页 §1／§7 原文保留为 `3935c55` 基点的读数。
> - 逐句对照见 [E4 过期口径订正](gy-r28-e4-stale-claims-20261021.md) §1、§2 R1／R10。

---

## 9. 文档/行号漂移登记（只登记，本片不改）

| 位置 | 现措辞 | 与本页读数的关系 |
| --- | --- | --- |
| `README.md:224`（#19 行） | 「仍缺 7／30 日到期的**真实执行**」 | 部分已变：**备份侧的执行者现在有了**（本片），但**真实 cron/CVM 读数仍未取得**（§7）。建议后续片改成「备份 30 日清除有了可重复执行的驱动；真实调度与 CVM 读数待取得」 |
| `docs/verification/gy-i16-i17-deletion-cascade-20261021.md` §4.1 第 3 条 / §5 G9 / §7 P0-4 | 「无到期驱动者」「形态需指挥定」 | 本片已定形态（运维命令，§2.1）并落地。该页 `backup-copies-pg.ts:250-338` 的行号**仍准**（本片未改那个文件，实测 `purge()` 在 `:250-356`，结论不变） |
| `docs/verification/gy-r28-backup-purge-ci-20261021.md` | （CI 真库臂说明） | 本片新增的集成脚本**未接** workflow（§7/D1），与该页描述的既有真库臂并列时不要混读 |
| `tests/unit/sql-column-coverage.test.mjs` 的「16 已审计 + 5 登记 / 21 个宿主」 | 已更新为「16 已审计 + 6 登记 / 22 个宿主」 | 本片新增 1 个 SQL 宿主（§2.4），读数按实测更新，不是放宽 |
