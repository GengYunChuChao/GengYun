# GY-R28 W6 · 在线数据 7 日到期执行者 + 回执 `backupState` 接线（#19 / G5 · G11）

本页只登记**本片真的做了、真的跑过**的东西；没取得的一律进 §7，不拿「代码写了」当读数。

## §0 性质与口径

| 项 | 值 |
| --- | --- |
| 工作目录 | `E:\GengYunCommander\wt-w6-deletion-clock` |
| 分支 / 基点 | `feat/gy-r28-w6-deletion-clock` / `f5cca8b` |
| 覆盖 issue | #19 的两处缺口：**7 日在线数据到期执行**（原 G9 同族）与**回执 `backupState` 由真行推导**（B4 勘察页的 G5/G6/G11） |
| 是否改代码 | 是（新增 8 个代码/测试文件 + 本页；改 9 个文件，见 §2.2。返修轮新增 `online-purge-cursor` 模块与其单测） |
| 是否改迁移 | **否**。`0016` 一字未动，未新增任何迁移号（已知边界与下一片建议见 §8-D1） |
| 是否改授权面 | **否**。`deploy/postgres-cvm/sql/20-login-roles.sql`、`90-assert-least-privilege.sql`、`allow_table_dml`、`expected(tbl,…,del)` 全部未动（见 §4） |
| 是否改契约 | **否**（契约本体未动）。`packages/contracts/**`、`openapi.json`、`.github/workflows/**`、`deploy/**` 均未修改；**唯一例外**是按 D2 裁决更新了台账 `docs/architecture/contract-status.json` 里 `app.ts` 的锚点行号（`1775-1783` → `1798-1806`，同一 operation / 同一 symbol / 语义未变），并 `--write-doc` 重生成中文对照表的同一处 |
| 术语①「7 日在线到期」 | 受理时刻 + 7×24h 的**上限**（不是最短保留期）。库里对应列是 `public.deletion_requests.online_due_at`（`0003_privacy_consent.sql:146-163`，注释「受理 + 7×24 小时」；`0016` 只做 `ALTER`） |
| 术语②「`scheduled_purge_at`」 | **本仓不存在该列**（`docs,services,packages,tools,tests,apps` 全域 *.ts/*.mjs/*.sql/*.md/*.json 零命中）。派单里的「只处理 `scheduled_purge_at <= now()`」在本仓的等价物就是 `deletion_requests.online_due_at <= cutoff`。本页此后一律用真列名 |
| 术语③「证据」 | 在线侧每个成功行 = 一条 `sha256:` 摘要，口径 `gengyun/online-purge/v1`，可由 (request_id, module, removed, idempotency) 独立复算 |
| 读数来源 | 单测（node:test）、真库臂（本机临时集群 PG 17.11）、`npm run lint`。⛔ 无 CVM/生产读数 |

## §1 断点复述（本片开工时的事实）

1. **在线数据只有在「用户再请求」时才推进**：`executeHandlers()` 是唯一执行入口，它只被两处调用——
   受理路由（`services/api/src/privacy/account-deletion.ts:200-229` 里的 `request()`）与回执 replayed 分支。
   没有到期枚举器，没有维护端点，仓内零 `setInterval`/调度器。⇒ 到期这件事**没有任何按时间推进的力量**。
2. **回执 `backupState` 长期停在 `pending`**：`services/api/src/privacy/user-data-deletion.ts:392-442` 的处理器
   只在「这次执行恰好把副本清了」时才写 `completed`；而副本的到期日是受理 +30 日，受理当次必然 `waiting`。
   于是**即使 30 日已过、副本早就清干净了，只要没人重放 `executeHandlers()`，回执永远显示 `pending`**。
   既有真库臂 `tests/integration/backup-purge-pg.mjs` 的「四域全 `completed`」也正是靠**手工重放** `executeHandlers()` 拿到的，
   生产里没有那条重放路径。
3. **两处缺口共用同一根因**：`deletion_handlers` 表存在（`0003:146-163` 一带）但**运行时角色对它 `forbidden`**
   （`90-assert-least-privilege.sql:1068-1070` 分类 `forbidden` + `:2555-2560` 第 48 项反向控制），
   而 `admin_audit_events` 对运行时角色连 `SELECT` 都没有。⇒ 台账仍是纯进程内（G11），落库需要新迁移 + 新授权面。

## §2 交付形态与理由

### 2.1 为什么是「运维命令 + 驱动模块」，不是常驻定时器

与 E2（`docs/verification/gy-i19-backup-purge-driver-20261021.md` §2）同一套理由，逐条对本片成立：

| 理由 | 对本片的具体含义 |
| --- | --- |
| 仓内没有进程级调度设施 | 没有任何 job runner / queue / cron 封装；`setInterval` 会是全仓第一例 |
| `setInterval` 会与 CI/真库臂抢资源 | 常驻定时器只要被 `import` 就会跑，单测与真库臂无法关掉它 |
| 重启即丢语义 | 定时器活在进程里；多副本部署会**重复执行**，且没有任何「谁清到哪」的持久位 |
| 服务在 real 模式下自认 503 | `accountDeletion.available === false` ⇒ 注销 HTTP 面整域 503（G10），把执行者挂在它身上等于挂在不可用面上 |
| 退出码就是 cron 判据 | `0`/`1`/`2` 的语义可以直给外部 crontab / systemd timer，无需新增运维口径 |
| `.github/workflows/**` 本片红线 | 不能靠加 workflow 来获得调度 |

⇒ 形态：**一个薄 CLI**（`tools/purge-expired-online-data.mjs`，负责连库、取唯一 `cutoff`、跑、退出码）+ **一个可单测的驱动模块**
（`services/api/src/privacy/online-purge-driver.ts`，纯枚举/判定/报告）。调度留给外部（§6 给 crontab 例子）。

### 2.2 文件清单

新增（8）：

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `services/api/src/privacy/online-purge-driver.ts` | 743 | 7 日在线到期驱动：keyset 分页候选枚举、批次推进、批量上限、逐模块隔离、证据、报告、退出码 |
| `services/api/src/privacy/online-purge-cursor.ts` | 149 | 跨进程进度游标（**零 SQL**）：路径解析、读写、原子落盘；只存到期时刻 + 请求 id |
| `services/api/src/privacy/backup-state-derivation.ts` | 387 | 回执备份态**只读**推导：`user_backup_copies` 真行 → `completed`/`pending`/`blocked` + reason + 证据 |
| `tools/purge-expired-online-data.mjs` | 303 | 运维命令（`DATABASE_URL` + `--limit` + `--max-batches` + `--cursor-file` + `--no-cursor` + `--dry-run`） |
| `tests/unit/online-purge-driver.test.mjs` | 957 | 33 条：边界/幂等/批量/失败隔离/证据/报告口径/SQL 形状/Date 形状/**批次推进 [9]** |
| `tests/unit/online-purge-cursor.test.mjs` | 210 | 8 条：路径优先级、三态读取、往返归一、原子落盘、坏文件分类、写前归一 |
| `tests/unit/backup-state-derivation.test.mjs` | 360 | 19 条：六种行集合 → 三态映射、证据复算、聚合、端口形状 |
| `tests/integration/online-purge-pg.mjs` | 876 | 真库臂 12 组（临时集群 PG 17.11；含 [4b] 进程内推进、[4c] CLI 跨进程推进） |

行数是**本 HEAD 实测**（`git show :<file>` 的行数）；上一版表格里的旧数字这次一并按实测改了，
其中 `backup-state-derivation.ts` 与它的单测本片并未改动，只是旧数字本就不准。

修改（9）：`package.json`（+3/−1：两个脚本）、`services/api/src/app.ts`（+25/−2：装配只读推导端口 + `userDataDeletionInjection.backupStates` 注入面）、
`services/api/src/privacy/user-data-deletion.ts`（+222）、`services/api/src/routes/account-deletion.ts`（+5）、
`tests/unit/ci-integration-chain-structure.test.mjs`（+8，新真库脚本登记为未接线）、`tests/unit/sql-column-coverage.test.mjs`（+25/−2，两处新 SQL 宿主登记）、
`docs/architecture/contract-status.json`（±1 行：`services/api/src/app.ts` 的 `accountDeletionWired` 锚点 `1775-1783` → `1798-1806`）、
`docs/architecture/contract-implementation-status.md`（±1 行：同一处，由 `node tools/verify-contract-status.mjs --write-doc` 重生成）、
`.gitignore`（+4：跨轮游标文件与其临时文件，机器本地进度状态不入库）。

## §3 不变量 → 实现 → 证据

### 3.1 7 日在线到期执行者

| 不变量 | 实现 | 证据（真库臂组号） |
| --- | --- | --- |
| **只处理已到期请求** | `ONLINE_PURGE_DUE_SQL` 的 `WHERE online_due_at <= $1::timestamptz`（闭区间：等于即到期，口径同 `packages/privacy/backup-retention.mjs:219`）；批内再取一次 `instantMs` 复核 `dueMs > cutoffMs ⇒ skip not_due` | [2] 等于 cutoff、早 1 秒两主体四域共 8 行真被删；晚 1 秒主体四域各 1 行原样 |
| **按时间驱动（不靠用户再请求）** | CLI 里 `SELECT now() AS cutoff` 取**唯一**时钟快照，再枚举 `online_due_at <= cutoff`；与任何请求路径无关 | [2]/[4]：造数把 `online_due_at` 放在过去，命令一跑就清；`git grep setInterval` 仍为零 |
| **批量上限可配** | `--limit` 默认 200、硬顶 5000；`normalizeOnlinePurgeLimit` 非法/超顶**抛 RangeError**（不夹取）；批内 `processed >= limit ⇒ break` | [4] 3 个到期请求 + `--limit 2` ⇒ `processed=2`、`remaining=1`、第 3 个主体四域行原样；单测 [2]/[2b] |
| **批次会推进（后批不饿死）** | `ONLINE_PURGE_DUE_SQL` 加 keyset 游标谓词 `($3::timestamptz IS NULL OR (date_trunc('milliseconds', online_due_at), id) > ($3::timestamptz, $4::uuid))` 与**同序** `ORDER BY date_trunc('milliseconds', online_due_at), id`；`drainDueOnlineDeletions` 逐页推进并给出 `nextCursor`；`--max-batches` 默认 5、硬顶 200，只定单轮预算 | [4b] `--limit 2` + 5 个到期请求 + 每轮一页 ⇒ `processed=2/2/1` 全部清空；**同一 SQL 不传游标仍只返回队首 A/B**（= 旧口径的饿死反证）；[4c] 三个**独立 CLI 进程** + 磁盘游标同样 2/2/1；单测 [9b]/[9e]/[9h] |
| **进度不写库、不伪造完成** | 进度只落 `--cursor-file`（默认 `.gengyun-online-purge-cursor.json`，已 gitignore；内容仅 `{version, cursor:{afterDueAt, afterRequestId}, updatedAt}`，⛔ 不含 `user_id`）；走到队尾删除文件 ⇒ 下一轮从队首重扫一整轮；⛔ 不写 `deletion_requests.state`/`completed_at` | [4b]/[4c] 断言 5 行仍 `state !== 'completed'` 且 `completed_at IS NULL`；单测 [9b]/[9c]/[9i] |
| **失败行越过游标、下一整轮再试** | 游标按「本轮**已处理**的最后一行」推进（含 failed 行）⇒ 失败行不会每轮重占队首、拖住后面的请求；重试仍是逐行幂等 | [7] 注入 history 抛错仍清完其余主体；单测 [9d] A 失败后第二轮取的是 C/D |
| **幂等（重复跑 0 行）** | 不靠状态位（没有可写的在线状态位）：第二轮枚举到同一批请求，四域 `purgeOwnerData` 都返回 0 行/0 台账 ⇒ 该请求落 skip `already_purged`，证据**丢弃**（不谎称本次干了活） | [3] 同 cutoff 第二遍 ⇒ `rowsPurged=0`、证据 0 行、2 个已清主体落 `already_purged`、`exitCode=0` |
| **失败行不阻塞其他行** | 逐模块 `try/catch` 隔离：单模块抛错只把该行记 `failed`（错误码限定在 `SAFE_ERROR_CODES`，否则折叠 `DRIVER_EXCEPTION`），同请求其它模块照做，后续请求照做 | [7] 注入 history 抛 `STORE_UNREACHABLE` ⇒ 该请求 `failed` 且码原样；同请求 favorites 已删、history 行还在；另一请求四域全清；`exitCode=1` |
| **每个成功行写证据** | `onlinePurgeEvidenceRef()` 给出 `sha256:` 摘要（`gengyun/online-purge/v1\0requestId\0module\0removed\0idempotency`），一行一条进报告 | [9] 每成功 (request,module) 一行 `sha256:`、可用同一函数**独立复算逐字相等**、`evidence.length === succeeded×4` |
| **空跑不是成功，也不是失败** | `totalDue=0`/候选空 ⇒ `candidates=0`、`processed=0`、`exitCode=0`；`modules` 闭集为空 ⇒ `RangeError` | 单测 [8d]/[2c] |
| **cutoff 只接受带时区的时刻** | `instantMs` 只吃 `Date`/有限数/严格带时区 ISO；裸本地时间 ⇒ `TypeError` | 单测 [1c]/[8c]；[8e] 专门锁 `pg` 返回的 `Date` 形状（见 §5.5 的 bug-1） |

### 3.2 回执 `backupState`

| 不变量 | 实现 | 证据 |
| --- | --- | --- |
| **备份态由真实 `user_backup_copies` 行推导** | `createPostgresBackupStateReader().derive({requestId,userId,modules})` 每次**重读**（不缓存）一条只读 SELECT：`SELECT module, scope, state, retention_until, payload_digest, evidence_ref … WHERE request_id=$1 AND user_id=$2 ORDER BY module, scope`（一次快照取全四域） | [10]/[11]/[12]；单测 19 条 |
| **四域齐备 ⇒ `completed`**（⛔ 不是「副本已清」就读成 completed） | 每域走既有纯判定 `evaluateBackupPurge`：只有 `none/ALL_PURGED` **且**复核通过（每行 `state='purged'`、`evidence_ref` 非空白、且能用该域 `payload_digest` 复算出**同一个** `sha256:`）才算 `completed`；四域皆 `completed` ⇒ 整体 `completed` | [12] 真库：`refreshBackupStates` 后四域 `backup=completed`、`error_code=null`、证据带 `sha256:`，`receipt.state='completed'`、`completionStatus().completed=true` |
| **未到期 ⇒ `pending`（唯一正当的 pending）** | `wait/WAITING_RETENTION` ⇒ `pending` + reason `BACKUP_RETENTION_NOT_DUE` | [10] 受理后四域 `backup=pending`、`error_code=null`、整体非 completed |
| **到期未清 ⇒ `blocked`** | `purge/PURGE_DUE` ⇒ `blocked` + `STORE_REJECTED` + reason `BACKUP_PURGE_DUE_NOT_EXECUTED` | [11] +31 天后副本仍在 ⇒ 四域 `blocked`、`error_code=STORE_REJECTED`、整体 blocked |
| **缺清单行 ⇒ `blocked`（不是 pending）** | 该域 0 行 ⇒ `blocked` + `EVIDENCE_REQUIRED`（reason `BACKUP_MANIFEST_MISSING`）；`failed` 行 ⇒ `blocked` + `STORE_REJECTED`；行输入非法 ⇒ `POLICY_BLOCKED` | 单测 19 条逐类 |
| **不与在线侧抢结论** | `refreshBackupStates` 对 `onlineState !== 'completed'` 的模块**直接 skip**（不越过在线侧），只改备份列与备份证据段，在线证据段一字不动 | 单测；[12] 证据串形如 `favorites:online-purged:1;favorites:idempotency-purged:0;favorites:backup-purged:sha256:…` |
| **不自己宣布整体完成** | 刷新完仍调 `coordinator.completionStatus()` 让协议判；只把「上一次执行留下的过期 `blocked`」复位成 `processing`（`deletion.mjs:311` 要求 `state!=='blocked'` 才可能升 completed） | [12] 整体 `completed` 由协议给出（不是本模块写的） |
| **读不到 ≠ 清完了** | `derive()` 抛错 ⇒ 折叠 `unreadableBackupStates()`（四域 `blocked` + `STORE_UNREACHABLE`），⛔ 不返回 pending | 单测 |
| **回执可见性** | 刷新插在 `GET /account/deletions/:id` 取回执**之前**（`routes/account-deletion.ts:199` 之前一行）与 POST replay 之前 | 代码位置；HTTP 面读数未取得（§7） |

## §4 权限口径（零新增授权）

| 面 | 事实 | 证据 |
| --- | --- | --- |
| 四域在线清空 | 运行时角色**已有** `DELETE ON public.messages`（`20-login-roles.sql:566`）、`favorites`（`:755`）、`history`（`:765`）、`conversations`（`:792`），以及两张幂等台账（`:775`/`:784`） | 真库臂 [1]：`has_table_privilege(current_user,'public.<t>','DELETE')` 四域全 true |
| 清单读 | 只用 `gy-i19-backup-copies-grant` 已授的列（`20-login-roles.sql:361-382`）：`module/scope/state/retention_until/payload_digest/evidence_ref`；**不读 `payload`** | 真库臂 [1]：表级 SELECT=false、`evidence_ref` 列级 SELECT=true、`payload` 列级 SELECT=false |
| `deletion_requests` 读 | 运行时角色**没有**任何表级/列级权限（`90-assert-least-privilege.sql:1068-1070` 判 `forbidden`，`:2555-2560` 第 48 项反向控制） | 真库臂 [1]：实跑 `SELECT id FROM public.deletion_requests` ⇒ **SQLSTATE 42501** |
| ⇒ 命令用哪个角色 | 必须用**属主/运维角色**（`DATABASE_URL`，与 `npm run db:migrate` 同源）。这不是新增授权，而是**如实承认**「到期枚举读的是受保护表」。若要改成运行时角色，需新增 SECURITY DEFINER 函数 ⇒ 需新迁移 ⇒ 本片红线，见 §8-D1 | 同上 |
| 证据落库 | **未落库**：`deletion_handlers` 对运行时角色 `forbidden`，`admin_audit_events` 连 SELECT 都没有，且当前没有任何「在线证据」列 | §7-3 |

⇒ `20-login-roles.sql`、`90-assert-least-privilege.sql`、`allow_table_dml`、`expected(tbl,…,del)` **一处未改**。

## §5 自检真实输出

### 5.1 lint

```
> gengyun@0.0.0 lint
> node tools/lint-workspaces.mjs

PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
```

### 5.2 新单测

```
$ node --test tests/unit/online-purge-driver.test.mjs tests/unit/backup-state-derivation.test.mjs
ℹ tests 41
ℹ pass 41
ℹ fail 0
```

其中 `[8e]` 是**真库臂抓到的缺陷**的回归（见 5.5 bug-1）：`pg` 对 `timestamptz` 返回 `Date`，若把行直接 `String()`
化，会得到 `Wed Apr 01 2026 …` 这种不带时区的写法，于是每行都被判「到期时刻不可解析」⇒ 全 failed。
单测原本只喂 ISO 字符串，抓不到这条；补 `[8e]` 之后锁死。

**[P1] 返修轮（监工 2026-10-21 17:23 / 18:06：批量上限导致后批饿死）** 的单测读数，各自单跑：

```
$ node --test tests/unit/online-purge-driver.test.mjs
ℹ tests 33
ℹ pass 33
ℹ fail 0

$ node --test tests/unit/online-purge-cursor.test.mjs
ℹ tests 8
ℹ pass 8
ℹ fail 0

$ node --test tests/unit/sql-column-coverage.test.mjs tests/unit/ci-integration-chain-structure.test.mjs
ℹ tests 23
ℹ pass 23
ℹ fail 0
```

`online-purge-driver` 由 22 条扩到 **33** 条：原有 22 条**一条未删**（`[8]`/`[8b]` 是就地改断言：`ORDER BY` 的键
改成 `date_trunc('milliseconds', online_due_at), id`，并新增 `$3::timestamptz IS NULL` 与
`(date_trunc(...), id) > ($3::timestamptz, $4::uuid)` 两条 keyset 断言），新增 11 条（`[8f]` + `[9]`/`[9a]`–`[9i]`）。
其中 `[9b]` 是本轮的**主证据**：`limit=2`、5 个到期请求、`--max-batches 1` 连跑三轮 ⇒ `processed=2/2/1` 全处理、
`nextCursor` 逐轮 B→D→`null`、`drained` 第三轮才 `true`；同一段里还断言**不传游标连跑三轮只碰到 A/B**（饿死反证）。

`online-purge-cursor` 的 8 条锁「进度只存本地文件」：路径优先级（`--cursor-file` > `ONLINE_PURGE_CURSOR_FILE` > 缺省）、
无文件/合法/坏文件三态、写读往返归一（大写 UUID + `+08:00` ⇒ 毫秒 UTC ISO + 小写 id）、走到队尾删文件、
`EISDIR` 与版本不符都归 `invalid` 而不崩，且落盘内容**不含** `user_id`／连接串。

### 5.3 同域套件（`tests/unit/` 里 deletion / privacy / backup 命名的 9 个）

```
$ node --test tests/unit/{user-data-deletion,account-deletion-receipts,backup-copies-port-contract,
  backup-purge-driver,backup-retention,conversation-deletion,favorites-history-deletion-registration,
  messages-deletion-purge,privacy-consent-wiring}.test.mjs
ℹ tests 103
ℹ pass 103
ℹ fail 0
```

⇒ 我在 `user-data-deletion.ts` 里追加的 `refreshBackupStates`（可选方法）没有打碎任何既有协议用例。

### 5.4 全量 `npm run test:unit`（独占跑）

```
$ npm run test:unit          # 第 1 轮（改动未收敛时）
ℹ tests 3408
ℹ pass 3398
ℹ fail 9

$ npm run test:unit          # 第 2 轮（下面那条修掉之后，独占跑）
ℹ tests 3416
ℹ pass 3415
ℹ fail 0
```

第 1 轮的 9 条失败**全部**是「契约台账行号锚点」家族（`contract-status-anchors` / `contract-status-tool` /
`gy-i22-*` 经由同一台账工具）：`app.ts` 里的装配把 `accountDeletionWired` 从 `1775` 推到 `1798`，
超出台账锚点 `services/api/src/app.ts:1775-1783` 的 ±2 容差 —— **是本片改动引起的，不是 flake**
（同一批用例单独跑也红）。

修法（按 D2 裁决，沿用 `#397` 的判例）：**同一 operation、同一 symbol、同一结论，语义未变** ⇒
更新台账里的 `app.ts` 锚点行号（`1775-1783` → `1798-1806`，实测行号），再用
`node tools/verify-contract-status.mjs --write-doc` 重生成中文对照表。
⛔ 没有为凑行号把代码压成一行 spread，也没有砍掉 `userDataDeletionInjection.backupStates` 注入面。

```
$ node tools/verify-contract-status.mjs
PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
PASS: 语义可核 104 条区间 + 0 条片段；不可核 98 条区间 + 157 条片段（不可核不计入通过）
PASS: 证据锚点 409 条引用自带锚点（区间内 238 条 + 仅整文件 171 条）；无锚点不可核 0 条（纯行号 0 + 无行号源文件 0 + 无用例名 0），只计数不判红
PASS: 纯行号区间 238 条（有实质内容 238 条；整段仅空白/收尾行 0 条、区间首行为空行 2 条，只计可疑不判红）
PASS: 中文表格一致
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。
```

第 2 轮全量读数：`3416 tests / 3415 pass / 0 fail / exit 0`（多出的 1 条是既有跳过项，非本片新增）。

### 5.5 真库臂（本机临时集群 PG 17.11）

```
$ $env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'; $env:GY_I19_PG_ROOT='E:\GengYunCommander\.pg17\tmp'
$ node tests/integration/online-purge-pg.mjs
  - 临时集群：数据目录 E:\GengYunCommander\.pg17\tmp\gy-w6-online-purge-0b2369db，端口 55866（只监听 127.0.0.1）
  - PostgreSQL 17.11
PASS 1: 权限形状：四域 DELETE 运行时角色已有（零新增授权）；`deletion_requests` 读不了（42501）⇒ 到期枚举必须走运维/属主角色
PASS 2: 到期边界（cutoff=2026-04-01T00:00:00.000Z）：等于/早 1 秒的两主体四域共 8 行真的被删；晚 1 秒的主体四域各 1 行原样保留
PASS 3: 幂等：同一 cutoff 第二遍 ⇒ rowsPurged=0、证据 0 行、2 个已清主体落 already_purged、exitCode=0
PASS 4: 批量上限：3 个到期请求 + --limit 2 ⇒ processed=2、succeeded=2、remaining=1、第 3 个主体四域行原样
  - 批次推进：[4b] 三元组读数 processed=2/2/1、drained=false/false/true
PASS 5: 批次推进（[P1] 闭环，in-process）：limit=2、5 个到期请求、每轮一页 ⇒ 三轮处理 2/2/1 全部清空；同一 SQL 不传游标仍返回队首 A/B（饿死反证）；请求 state 全程未被写（不伪造 completed）
PASS 6: 批次推进（[P1] 闭环，CLI 跨进程）：3 个独立 node 进程 + 磁盘游标 ⇒ 5 个到期请求 2/2/1 全部清空，走到队尾时游标文件被删、--no-cursor 只跑一页；请求 state 仍非 completed
PASS 7: 失败不阻塞：注入 history 抛 STORE_UNREACHABLE ⇒ 该请求 failed（码原样），同请求 favorites 已删、history 行还在，另一请求四域全清
PASS 8: dry-run：rowsPurged=0、证据 0 行、dry_run 跳过 1 个请求，四域行原样
PASS 9: 证据：每个成功 (request, module) 一行 sha256 摘要、可独立复算；报告只给 request_id，不含 user_id
PASS 10: 回执（受理后）：四域 online=completed、backup=pending、error_code=null，整体非 completed（四域未齐）
PASS 11: 回执（30 日已过、副本仍在）：四域 backup=blocked + error_code=STORE_REJECTED、reason=PURGE_DUE_NOT_EXECUTED、整体 blocked
PASS 12: 回执（四域齐备）：refreshBackupStates 后四域 backup=completed、error_code=null、证据带 sha256 摘要，整体与 completionStatus 均为 completed
  - 回执证据：{"favorites":"favorites:online-purged:1;favorites:idempotency-purged:0;favorites:backup-purged:sha256:0a918da9…", …}
  - EXITCODE=0（共 12 组 PASS）
  - 迁移已应用：26 个（0001_initial_schema.sql … 0026_speech_persistence.sql）
```

组号变动（2026-10-22）：`[4b]`/`[4c]` 两臂插在批量上限之后 ⇒ 原先的 `[5]`–`[8]` 顺延为 `[7]`–`[12]`，
本页 §3、§5.6 的引用已按新编号核对过一遍。

`[4b]` 是这一轮的**主证据**：`--limit 2` + 5 个已到期请求 + 每轮只推一页，三轮读到 `processed=2/2/1`，
5 个主体的四域行逐个清空（`emptiedRequests` 断言 2→4→5），第三轮 `drained=true` 且 `nextCursor=null`；
紧接着的 `rushWrap`（`maxBatches=5`）从队首整轮重扫 ⇒ `batches=3`、`rowsPurged=0`、`evidence=0`、
`skipReasons.already_purged=5`、退出码 0。**饿死反证**是同一臂里的另一条断言：清完 A/B 之后**不传游标**
再查队首，返回的仍是 A/B —— 正是监工描述的那一幕，而现在游标让第二轮取到 C/D。

`[4c]` 把同一闭环搬到**生产入口**：`node tools/purge-expired-online-data.mjs --limit 2 --max-batches 1
--cursor-file <tmp>` 连跑三次（三个独立进程，模拟 cron），第一次 stdout 含 `游标已更新：下一轮从 request=`、
第二次含 `从 request=…（online_due_at=…)`、第三次含 `游标已清：本轮走到队尾`，游标文件也在第三次跑完后消失；
`--no-cursor` 则退回一页并落 `already_purged=2`。

第 11 组标签里的 `PURGE_DUE_NOT_EXECUTED` 是臂的**人读标签**；代码里断言的 reason **值**是
`BACKUP_PURGE_DUE_NOT_EXECUTED`（`BACKUP_STATE_REASONS.PURGE_DUE_NOT_EXECUTED`），两者指同一件事。

环境：临时集群 `initdb` 自建、随机 556xx 端口、只监听 `127.0.0.1`、26 个既有迁移逐一应用、按
`-- #region` 从 `20-login-roles.sql` 原文取出**涉及四域的 21 条 GRANT/REVOKE**（未新增授权）。
`GY_PG_BIN` 未设置 ⇒ 打印 SKIP 并 `exit 77`（未取得，⛔ 不是通过）。

最终复跑（`[P1]` 返修后的 HEAD）：数据目录 `E:\GengYunCommander\.pg17\tmp\gy-w6-online-purge-0b2369db`、
端口 `55866`，**12 组全 PASS / `EXITCODE=0`**；跑完 `pg_ctl -m immediate -w stop` + 删目录，`GY_I19_PG_ROOT`
下无 `gy-w6-online-purge-*` 残留。全量单测的 `3416 tests / 3415 pass / 0 fail / 1 skipped / exit 0` 是**返修前**
那一版 HEAD 的读数；本轮只单跑受影响子集（§5.2），⛔ 没有重跑全量。

**真库臂抓到并修掉的三个真缺陷**（都不是测试夹具问题）：

1. `listDueOnlineDeletions` 把 `timestamptz` 的 `Date` 写成 `String(row['online_due_at'])` ⇒ 全行「到期时刻不可解析」。
   改为 `raw instanceof Date ? raw : String(raw)`；补单测 `[8e]`。
2. `runOnlinePurgeBatch` 在**请求级结论之前**就把证据 push 进报告 ⇒ 「四域都 0 行」的幂等轮也产出证据。
   改为先攒 `evidenceThisRequest`，成功才并入、`already_purged` 时丢弃。
3. `refreshBackupStates` 只改账本行、没同步 `evidenceByRequest` ⇒ `evidenceOf()` 读不到刷新后的备份证据。
   补「changed 的模块把 `row.evidenceRef` 写回证据账本」。

### 5.6 判定

| 问题 | 读数 |
| --- | --- |
| 7 日到期是否**真按时钟**执行 | 是。命令取 `SELECT now()` 的单一 `cutoff`，候选 SQL 判 `online_due_at <= cutoff`；真库臂 [2] 用过去的 `online_due_at` 造数，命令一跑就真删了 8 行（四域各 1 行 × 2 主体），未来的 1 秒不动；[3] 复跑 0 行。⛔ 未接外部 cron（§7-2） |
| 回执 `backupState` 现在由什么推导 | `public.user_backup_copies` 的**真实行**（每域一或多行，按 `(request_id,user_id)` 一次快照读出，只读、不缓存），逐域走 `evaluateBackupPurge` 纯判定 + 证据复算 |
| 四域齐备时是否 `completed` | 是。真库臂 [12]：四域全 `completed` ⇒ 回执 `state='completed'`、`completionStatus().completed=true`；且路径上每一档都有反向读数（[10] pending、[11] blocked） |
| 后批会不会被前批饿死 | 不会（本轮 [P1] 闭环）。`[4b]`：`limit=2` + 5 个到期请求 + 每轮一页 ⇒ 三轮 `2/2/1` 清完、`drained` 才 `true`、`nextCursor` 逐轮前进；`[4c]`：同一件事由三个独立 CLI 进程 + 磁盘游标复现；同一 SQL **不传游标**时队首仍是 A/B（= 旧口径的饿死现场，现由游标绕开）。单测 `[9b]`/`[9d]`/`[9e]`/`[9h]` 锁推进/失败越行/预算截断/单轮单 cutoff |
| 幂等与边界 | 未到期不动（[2] 晚 1 秒原样）；重复跑 0 行（[3] `rowsPurged=0`、证据 0 行）；批量上限（[4] `processed=2/remaining=1`）；失败不阻塞（[7]）；dry-run 零删除（[8]） |

## §6 如何运维

前置：①库已 `npm run db:migrate`（需 `0003`/`0016`/`0023`）；②连接串用**属主/运维角色**（`DATABASE_URL`，与迁移同源）；
③确认没有第二个执行者在跑（命令不自带分布式锁；并发跑是安全的幂等，但会重复计数）；
④游标文件的目录**可写**（默认写在当前目录，见下）。

```bash
# 只看到期清单（不删任何数据；不读也不写游标）
npm run purge:online-data -- --dry-run

# 真的清：每页 50 个请求，单轮最多 5 页（默认 200/页 × 5 页）
npm run purge:online-data -- --limit 50

# 单轮想推得更远（默认 5 页，硬顶 200 页）
npm run purge:online-data -- --limit 50 --max-batches 20

# 明确「不落进度」：等价于 --max-batches 1 且不读不写游标（排查/一次性清用）
npm run purge:online-data -- --limit 50 --no-cursor

# 把进度放到别处（例如 systemd 的 StateDirectory）
npm run purge:online-data -- --cursor-file /var/lib/gengyun/online-purge-cursor.json
```

**跨轮进度（本轮 [P1] 闭环）**：每轮跑完把「这轮清到的最后一个请求」写进游标文件
（默认工作目录下的 `.gengyun-online-purge-cursor.json`，已 gitignore；也可用 `--cursor-file` 或
`ONLINE_PURGE_CURSOR_FILE` 指定），下一轮从它**之后**继续（keyset：`(online_due_at, id)` 严格大于）；
走到队尾就删掉文件 ⇒ 再下一轮从队首重扫一整轮（这一轮全是 `already_purged`，0 行删除）。
游标里只有 `{version, cursor:{afterDueAt, afterRequestId}, updatedAt}` —— **没有** `user_id`、没有连接串；
它记录的是「清到哪儿」，**不是**「这个请求完成了」，`deletion_requests.state` / `completed_at` 一个字都不写。

⚠️ 游标是**机器本地**文件：多机/多副本部署时每台机器一个文件（各推各的页，互不覆盖），或统一指向同一块共享盘；
文件损坏或版本不符时会在 stderr 说明原因并**从队首重扫**，不会假装已经跑过。

退出码：`0` 干净（含 0 个到期请求）／`1` 有失败行（`failed>0`，逐行给出 request_id + module + 原因码）／
`2` 配置或参数（缺 `DATABASE_URL`、`--limit`/`--max-batches` 非法或超顶、`--cursor-file` 与 `--no-cursor` 同时给、
游标目录不可写、`42P01` 迁移未跑、`42501` 缺权、连接类）。

外部调度示例（本片不落地，交给运维；`.github/workflows/**` 是红线）：

```cron
# 每 10 分钟扫一次到期请求；失败退出码 1 交给 cron 的 MAILTO
*/10 * * * * cd /srv/gengyun && DATABASE_URL="$(cat /run/secrets/db-owner-url)" npm run purge:online-data >> /var/log/gengyun/online-purge.log 2>&1
```

输出只含 `request_id` + module，**不含 `user_id`**（隐私口径，单测 [7b] 锁死）。

## §7 未取得

1. **真实 CVM/生产读数**：全部读数来自本机临时集群（PG 17.11、回环、临时数据目录）。生产库的
   `deletion_requests` 规模、锁竞争、`limit` 该取多少，未测。
2. **外部调度真的接上了**：命令有了、退出码有了，但仓内**没有** cron/systemd timer/workflow 接线（workflows 是红线）。
   ⇒ 「7 日到期按时间执行」在**代码与命令层面**成立且在真库上实测过，在**运维层面**仍待接线。
3. **在线证据落库**：证据只进报告，不落库。要落库需要一张可写的证据表（或给 `deletion_handlers` 开列级 DML），
   两者都要新迁移 + 新授权面 ⇒ 本片不做（见 §8-D1「已知边界 + 下一片建议」）。
4. **`deletion_requests` 的运行时读权限**：运行时角色读不了该表（42501，既有 least-privilege 反向控制要求如此）。
   ⇒ 命令必须用属主角色。若要改成运行时角色可跑，需新增 SECURITY DEFINER 枚举函数 ⇒ 新迁移（§8-D1）。
5. **HTTP 面的端到端读数**：真库臂直接驱动服务对象（`createUserDataDeletion` + 真实 PG store + 真实推导端口），
   **没有**起 Fastify 跑 `GET /account/deletions/:id`。HTTP 层只做了代码接线（一行 `await`），未取真库读数。
6. **7 日/30 日的真实墙钟**：真库臂用注入的 `cutoff`/脚本化时钟推进，不是等 7 天/31 天。
7. **社区域（community）**：仍无 scope、无清除原语（G7 未变），本片未碰。
8. **G11 的持久审计/回执台账**：`auditLog`/`evidenceByRequest`/`subjectByRequest` 仍是进程内 Map（重启即失），
   本片只让**备份态**可以按时间从真行刷新，没有把它们落表。
9. **大表性能**：候选 SQL 走 `deletion_requests.online_due_at`（无该列的单列索引；`0003` 只有主键与
   `receipt_hash` 唯一索引，`0016` 加的是 `(user_id, requested_at DESC, id DESC)`）。到期请求量大时是否需要索引，未测。
   keyset 谓词与 `ORDER BY` 用的是同一对键（`date_trunc('milliseconds', online_due_at), id`），**不会**比旧的
   固定序列扫描多扫一遍；但没有该表达式的索引 ⇒ 每轮仍是顺序扫 + 排序，这一点与旧口径同源，未取得实测。
10. **跨机游标协调**：游标是**机器本地**文件（默认工作目录、可用 `--cursor-file`/`ONLINE_PURGE_CURSOR_FILE` 改），
   本片**没有**做多机共享或加锁。多机同时跑时各推各的页（逐行幂等，不会删错），但两机会重复计数、
   且两台机器各自的"队尾"判定互相独立 ⇒ 生产多副本下要么每机一文件、要么指向同一块共享盘。未在真库上测过多机。

## §8 已知边界与下一片建议（D1）+ 已裁决事项（D2/D3/D4/D5）

### D1（**已裁决：本片不新增迁移**）——已知边界 + 下一片建议

本片交付的边界：运维命令用**属主/运维角色**（`DATABASE_URL`，与 `npm run db:migrate` 同源）枚举
`public.deletion_requests`，在线证据**只进报告**、不落库。这不是偷懒，是两条既有约束的结果：

- 运行时角色 `gengyun_api_runtime` 对 `deletion_requests` **零表级零列级权限**
  （`deploy/postgres-cvm/sql/90-assert-least-privilege.sql:1068-1070` 分类 `forbidden`，
  `:2555-2560` 第 48 项反向控制要求如此）⇒ 到期枚举拿不到授权面；
- 在线证据没有可写的落地表：`deletion_handlers` 对运行时角色 `forbidden`，`admin_audit_events`
  连 `SELECT` 都没有，当前也没有任何「在线证据」列。

**下一片建议（届时会是一整个新片的体量，本片不动手）**：

1. 新迁移号：`0027`（2026-10-22 实测，`services/api/db/migrations/` 现有最大为
   `0026_speech_persistence.sql`，`0027` 空闲）。
2. 内容：①`public.list_due_online_deletions(p_cutoff timestamptz, p_limit integer)`，`SECURITY DEFINER`
   + `SET search_path = pg_catalog`，只回 `id/user_id/online_due_at`，给运行时角色 `EXECUTE`；
   ②在线证据落地（新表或 `deletion_handlers` 的列级 DML）。
3. **授权面必须三处同改**，缺一处 `90-assert-least-privilege` 就红：
   - `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `GRANT …`（新函数 `EXECUTE` / 新表或列级 DML）；
   - `allow_table_dml`（该脚本里的允许清单）；
   - `expected(tbl, …, del)`（同一脚本的反向控制清单）。
4. 风险提示：这三处同改会同时动到「运行时角色能碰什么」的口径，风险高于普通功能片，
   建议单独一片 + 真库臂复核 `has_table_privilege` / `has_column_privilege` 形状。

### D2（**已裁决：允许改台账锚点，可读性优先**）

按 `#397`（C1b）的判例：`app.ts` 因功能需要变长 ⇒ 台账锚点跟着改行号 + `--write-doc` 重生成对照表，
前提是「同一 operation、同一 symbol、同一结论，语义未变」。本片据此：

- 装配保持**可读多行**（`backupStatesWiring` 常量 + 上方 6 行注释，与 `backupPurgeWiring` 同形）；
- `userDataDeletionInjection` **恢复支持注入 `backupStates`**（测试与故障注入可直接覆盖）；
- 锚点 `services/api/src/app.ts:1775-1783` → **`1798-1806`**（实测行号）；
- `node tools/verify-contract-status.mjs` 全 PASS（含「中文表格一致」）。

### D3（**已接受**）——真库臂登记为未接线

`tests/integration/online-purge-pg.mjs` 登记进 `tests/unit/ci-integration-chain-structure.test.mjs` 的
`UNWIRED_DECLARATIONS`，理由与 E2 一致：回环链里没有真 PG、脚本自建 initdb 临时集群、要跑四域 GRANT、
缺 `GY_PG_BIN` 时 `exit 77`。⛔ 本片**不**把它写成「已接线」；真库 job 接线属 E5 的在途分支（PR #400 那一族）。

**本分支同时携带 `tests/integration/online-purge-pg.mjs`，`#407` 合入后可由 CI 接线片取用**：脚本自带
`GY_I19_PG_ROOT` / `GY_PG_BIN` 两个逃生口、自建 initdb 临时集群并在退出时 `pg_ctl -m immediate stop` + 删目录，
在 CI 里只要给 `GY_PG_BIN`（PG 17.x 二进制目录）即可直接当 job 用；数据目录根默认 `os.tmpdir()`，
在 Windows/受限权限环境需显式指到可写目录（本机实测 `os.tmpdir()` 会 `initdb: could not change permissions of directory`）。

### D4（**已接受**）——SQL 宿主登记，静态纳管待 R28-S66

`tests/unit/sql-column-coverage.test.mjs` 的 `UNAUDITED_SQL_HOSTS` 新增两条
（`services/api/src/privacy/online-purge-driver.ts`、`services/api/src/privacy/backup-state-derivation.ts`），
与 E2 的 `backup-purge-driver.ts` 同族：列面由真库臂**实测**（不是静态推断）。
**静态纳管待 R28-S66 重定「16 文件」整数读数（16 → N）**，本片没有重定，别当成已纳管。

### D5（**已裁决：进度用本地游标文件，不写 `deletion_requests`**）——[P1] 饿死的修法选择

监工两轮要求「让后续批次可继续推进」且「不要把只清在线四域直接标整笔 `completed`」。三个候选里选了第三个：

| 候选 | 为什么不选 / 为什么选 |
| --- | --- |
| ① 清完就把 `state` 写成 `completed` | **直接违反监工原话**，也与既有语义冲突：在线四域只是整笔注销的一环，30 日备份副本还在等，整笔完成由 `deletion_handlers` 协调器判（`deletion.mjs:311`），命令侧无权代它下结论 |
| ② 每轮把已清的请求"藏起来"（例如写一个新状态 `online_purged`） | 要 **新迁移 + 新授权面**（`deletion_state` 枚举、`20-login-roles.sql`、`90-assert-least-privilege.sql` 三处同改），与本片「不新增迁移」的裁决（D1）直接冲突；而且把"清到哪儿"和"这笔注销到哪一步"混成同一个状态位，后续协调器更难判 |
| ③ keyset 游标 + 机器本地游标文件（**选中**） | 不改迁移、不改授权面、不碰请求状态；`(online_due_at, id)` 严格大于就能保证"下一页一定是没选过的行"，天然幂等、天然可重放；走到队尾删文件 ⇒ 下一轮从队首重扫一整轮，把所有 `already_purged` 重新核一遍。代价只是"进度跟着机器走"（§7-10） |

配套的两条口径：游标按**已处理**的最后一行推进（含 failed 行 ⇒ 失败不占队首、下一整轮再试）；
`--max-batches` 只是单轮**预算**（默认 5），不影响正确性，只影响"一轮走多远"。

## §9 文档/行号漂移登记

| 位置 | 现象 | 处理 |
| --- | --- | --- |
| `services/api/src/app.ts` 行号 | 本片装配把 `accountDeletionWired` 从 `1775` 推到 `1798`（+23 行） | **改台账锚点**（按 `#397` 判例）：`contract-status.json` 的 `1775-1783` → `1798-1806`，并用 `--write-doc` 重生成 `contract-implementation-status.md` 的同一处；两文件各 ±1 行，语义未变 |
| `docs/verification/gy-i16-i17-deletion-cascade-20261021.md` §状态更新 | 该页把 `real` 模式注销面的门写在 `app.ts:1775-1783`（= 旧行号） | 历史页不回改（它写的是当时的读数）；**当前**行号以 §5.4 与台账为准：`1798-1806` |
| `services/api/src/privacy/user-data-deletion.ts:24` | 头注释里「7/30 日到期执行」仍登记为缺口 | 本片补的是**7 日在线的到期执行**与**回执备份态推导**；30 日备份执行已由 E2 提供。头注释留待后续片统一订正（本片不动它，避免把行号锚点再推一遍） |
| `docs/verification/gy-i19-backup-purge-driver-20261021.md` §7/D5 | 明写「回执 `backupState:'completed'` 不属该片，别把副本已清读成回执已 completed」 | 本片正是那一项；口径沿用：只有**四域齐 + 证据可复算**才 `completed` |
