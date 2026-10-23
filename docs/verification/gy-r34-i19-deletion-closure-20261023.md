# GY-R34-I19 注销闭集扩展证据页 · 2026-10-23

> **本文档不是关闭依据，也不产生关闭结论。** 它只做一件事：把「注销账号时删光用户数据」这个闭集**又扩了哪 7 张表 / 2 个模块**、**剩下哪 18 张表为什么不接**、以及**运行时角色到底有没有 DELETE 权限**，逐条落到可复现的读数上。所有命令都是本次实跑；没跑过的写「未取得」。

- 基线：`upstream/main` @ `af0fb36e`（`Reviewed PR #516`）
- 工作树：`E:\GengYunCommander\wt-r34-i19-closure2`，分支 `feat/gy-r34-i19-deletion-closure`
- 上游在途已前进到 `5a449305`（`Reviewed PR #518`），delta 只有 `tools/ai-config.mjs` / `tests/ai-config.test.mjs` / 一页 TTS 证据，与本片文件不重叠
- 前置页：`docs/verification/gy-r29-i19-closure-20261022.md`（八项检查清单与四域闭集的历史口径）

---

## 0. 方法与可复现命令

| 目的 | 命令 | 本次实跑结果 |
| --- | --- | --- |
| 类型检查 | `cd services/api; npx tsc -p tsconfig.json --noEmit` | exit 0（本片改动全部落盘后） |
| 全量单测 | `npm run test:unit`（根；`node --test "tests/unit/*.test.mjs" …`） | 见 §5.2 |
| 闭集覆盖棘轮 | `node --test "tests/unit/deletion-registration-coverage.test.mjs"` | `ℹ tests 6 · pass 6 · fail 0` |
| 新域闭集行为 | `node --test "tests/unit/user-data-deletion-recognitions-speech.test.mjs"` | `ℹ tests 3 · pass 3 · fail 0` |
| SQL 语句/列/授权棘轮 | `node --test "tests/unit/sql-column-coverage.test.mjs"` | `ℹ tests 17 · pass 17 · fail 0`（`duration_ms 5919`） |
| 真库臂（本片新增） | `$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'; $env:GY_R34_PG_ROOT='E:\GengYunCommander\.pg17\tmp'; node tests/integration/recognitions-speech-purge-pg.mjs` | `ALL PASS：9 条真库断言（exit code 0）`，PostgreSQL 17.11，端口 55853 |

**没真跑过的检查一律未写「通过」；没取得的写「未取得」。**

---

## 1. 本片接入：5 张归属表 + 2 张域内台账，分 2 个模块

| 模块 | 表 | 归属列 | 有 FK 指向它 | 删除顺序（先子后父） | 依据 |
| --- | --- | --- | --- | --- | --- |
| `recognitions` | `recognition_selections` | `owner_user_id` | 无 | ① 最先 | 引 `recognition_records.id`（`ON DELETE CASCADE`），必须先于父表 |
| `recognitions` | `recognition_jobs` | `owner_user_id` | 无 | ② | 引 `recognition_records`（`recognition_id`），与正文表无级联 |
| `recognitions` | `recognition_records` | `owner_user_id` | `recognition_selections`、`recognition_jobs` | ③ | 父表；上面两张先删完才轮到它 |
| `recognitions` | `recognition_idempotency` | 无主体列（`scope` 首段是主体 uuid） | 无 | ④ 最后 | 台账按 `left(scope, char_length($1::text) + 1) = $1::text \|\| chr(10)` 前缀删 |
| `speech` | `speech_jobs` | `owner_user_id` | 无 | ① 最先 | 引 `transcriptions.id`（`transcription_id`），先子后父 |
| `speech` | `transcriptions` | `owner_user_id` | `speech_jobs` | ② | 转写正文；与 `speech_jobs` 之间无 DB 级级联，顺序按业务语义定 |
| `speech` | `speech_idempotency` | 无主体列（`scope` 首段是主体 uuid） | 无 | ③ 最后 | 同识别域台账，按 scope 前缀删 |

于是生产装配下的闭集从 **5 项变 7 项**：`favorites` / `history` / `messages` / `conversations` / `community` / `recognitions` / `speech`。

### 1.1 模块名与顺序的代码位置

- 模块名常量：`services/api/src/privacy/user-data-deletion.ts:132`（`RECOGNITIONS_DELETION_MODULE = 'recognitions'`）、`:140`（`SPEECH_DELETION_MODULE = 'speech'`）。
- 条件追加的机器可读清单：`:185` `CONDITIONAL_DELETION_MODULES`（顺序＝追加顺序＝回执 `handlers` 行顺序）；真实追加点在 `:525` 的 `conditionalStores` 表与 `:785` / `:796` 两个 `registerModule` 分支。
- 在线清除证据的落库门：`:694` `(ONLINE_EVIDENCE_MODULES as readonly string[]).includes(module)` —— 名单在 `:169`；社区域**故意不在内**（社区是脱敏/保留语义，不是「清空」）。
- 按主体清空的存储层原语：`services/api/src/recognitions/store-pg.ts:592` 与 `services/api/src/speech/store-pg.ts:478` 的 `async function purgeOwnerRows(ownerId)`，各在一个事务里按上表顺序删。

### 1.2 关键实现（删除顺序之所以唯一）

```ts
// services/api/src/recognitions/store-pg.ts:592（节选）
const selections = await sql.query(
  'DELETE FROM public.recognition_selections WHERE owner_user_id = $1::uuid RETURNING id', [ownerId]);
const jobs = await sql.query(
  'DELETE FROM public.recognition_jobs WHERE owner_user_id = $1::uuid RETURNING id', [ownerId]);
const records = await sql.query(
  'DELETE FROM public.recognition_records WHERE owner_user_id = $1::uuid RETURNING id', [ownerId]);
const idempotency = await sql.query(
  `DELETE FROM public.recognition_idempotency
    WHERE left(scope, char_length($1::text) + 1) = $1::text || chr(10)
    RETURNING scope`, [ownerId]);
```

```ts
// services/api/src/privacy/user-data-deletion.ts:525（节选）
const conditionalStores: ReadonlyArray<readonly [string, OwnerPurgeStore | undefined]> = [
  [COMMUNITY_DELETION_MODULE, input.communityStore],
  [RECOGNITIONS_DELETION_MODULE, input.recognitionsStore],
  [SPEECH_DELETION_MODULE, input.speechStore],
];
for (const [conditionalModule, conditionalStore] of conditionalStores) {
  if (conditionalStore !== undefined) requiredModules.push(conditionalModule);
}
```

**幂等台账为什么能按主体删**：`services/api/src/auth/idempotency.ts:129-131` 的 `idempotencyScope(subject, method, routePath)` 返回 `` `${subject}\n${METHOD}\n${routePath}` ``，`scope` 首段恒为主体 uuid；两条前提（首段是主体、主体不含换行）由 `tests/unit/idempotency-scope-grammar.test.mjs` 的负控制钉住。

### 1.3 端口接线：为什么从「已装配的服务」取原语，而不是另建 store

两新域的清理原语不在 store 的公开出口上（识别 store 的解析点是 `app.ts` 里内联的三段式三元表达式，语音 store 的解析点在 `routes/speech.ts`），**装配层也不允许 import 值实现**——`tests/unit/recognitions-store-pg-wiring.test.mjs` 与 `tests/unit/speech-store-pg-wiring.test.mjs` 把这两条钉成结构不变量（语音那条按纯文本 `includes('speech/store')` 计数，注释里出现该字样也会红）。

所以两个端口都在**调用期**从已装饰的服务上取原语：

| 域 | 服务装饰点 | 服务侧方法 | 注销端口 |
| --- | --- | --- | --- |
| 识别 | `app.ts` 的 `app.decorate('recognitionService', …)` | `recognitions/service.ts` 的 `purgeOwnerData(ownerId)` | `app.ts:1823` `recognitionsDeletionStore` |
| 语音 | `routes/speech.ts:145` 的 `app.decorate('speechService', service)` | `speech/service.ts` 的 `purgeOwnerData(ownerId)` | `app.ts:1829` `speechDeletionStore` |

为什么不能「另建一个 store 实例来清」：内存模式下那是**另一份空数据**，却照样会回「已清 N 行」——静默假账。缺原语时一律**抛错**（`识别域存储未实现按主体清空（purgeOwnerData）：拒绝假装清空` / 语音同形），由删除协议折叠成回执 `blocked` + `HANDLER_FAILED`，⛔ 不会把该域标成 `completed`；`tests/unit/user-data-deletion-recognitions-speech.test.mjs` 的反向控制即此。

---

## 2. 基线未接入的 23 张表：逐张判定

口径：迁移目录（`services/api/db/migrations/`，33 个文件）里**带归属列**的表共 33 张（26 张 `user_id`/`owner_id`/`author_id`/`reporter_id`/… + 7 张 `owner_user_id`）。基线 `af0fb36e` 闭集覆盖其中 10 张 ⇒ **23 张未接入**。本片接入 5 张，另把 2 张无主体列的域内台账纳入模块覆盖；**其余 18 张保持排除**。

| # | 表 | 归属列 | 有 FK 指向它 | 删除顺序位置 | 判定与理由 |
| --- | --- | --- | --- | --- | --- |
| 1 | `recognition_selections` | `owner_user_id` | 无 | 最前 | **接入**（`recognitions` ①） |
| 2 | `recognition_jobs` | `owner_user_id` | 无 | 次 | **接入**（②） |
| 3 | `recognition_records` | `owner_user_id` | 2 张（selections、jobs） | 三 | **接入**（③，父表） |
| 4 | `speech_jobs` | `owner_user_id` | 无 | 最前 | **接入**（`speech` ①） |
| 5 | `transcriptions` | `owner_user_id` | `speech_jobs` | 次 | **接入**（②，正文） |
| 6 | `admin_scopes` | `admin_id` | 无 | — | **排除**：管理员身份域，主体是运维账号不是自然人；注销 API 从不接受 `admin_id`，删它会毁掉管理员权限的审计追溯 |
| 7 | `admin_sessions` | `admin_id` | 无 | — | **排除**：同上；管理员会话由安全运营流程轮换，不随用户注销 |
| 8 | `author_links` | `user_id` | 无 | — | **排除**：社区公开作者映射。注销时由社区域 `purgeOwnerData` 的 `authorRefsReplaced` 把帖子作者引用换成匿名引用，行本身保留以维持历史帖子可读（删行会让他人能看到的内容指向悬空作者） |
| 9 | `community_media_grants` | `requester_id` | 无（`media_id` 有 FK 到 `media`，`NO ACTION`） | 依附 `media` | **排除**：媒体访问授权，生命周期绑在媒体清理流程上；本片不清媒体本体，单独删会让历史内容引用的授权状态不一致 |
| 10 | `consent_records` | `user_id` | 无 | — | **排除**：法务留存。注销后仍需证明「哪条同意在何时生效/撤回」，删除等于销毁撤回证据 |
| 11 | `privacy_epochs` | `user_id` | 无 | — | **排除**：同上；`current_epoch` 是撤回生效的可验证凭据 |
| 12 | `user_training_consents` | `user_id` | 无 | — | **排除**：同上；训练同意/撤回记录属留存义务（`#19` 的「训练用途分开记录」口径） |
| 13 | `exports` | `user_id`/`recipient_id` | 2 张（`third_party_deletions`、`export_writebacks`，均 `NO ACTION`） | — | **排除**：导出请求台账，是「第三方到底收到过什么」的证据链头；删除会连带毁掉第三方删除证据 |
| 14 | `export_writebacks` | `user_id` | 无 | — | **排除**：同上（导出回写结果） |
| 15 | `third_party_deletions` | `recipient_id` | 无 | — | **排除**：第三方删除证据（在线/备份两态 + 证据引用），`#19` 的 30 日备份义务要靠它取证 |
| 16 | `jobs` | `owner_id`（`REFERENCES users (id)`，且有 `jobs_single_actor` 约束：`owner_id` 与 `actor_admin_id` 恰一） | 自引用（`retry_of` → `jobs`，`NO ACTION`） | — | **排除（死表，另开一片下线）**：`0001_initial_schema.sql:203-228` 的 `jobs` 是**通用作业台账**（`0001:202` 分节标题即「任务台账」，不是媒体专用队列）；生产代码零写入（全仓唯一 `INSERT INTO … jobs` 在 `tests/integration/consent-grant-pg.mjs:175` 测试 fixture，`admin/ops/jobs-pg.ts:6` 亦自述「没有任何代码向它 INSERT」），权限层 `90-assert-least-privilege.sql:1533-1535` 的 `t_sel`/`t_ins`/`t_upd`/`t_del` 四位全 `false`（列级只留 `sel = ARRAY['owner_id']`，与 `services/api/db/roles/auth_privacy.sql:39` 的 `GRANT SELECT (owner_id) ON jobs,media` 同源）；现存读面仅 `consent-pg.ts:174-177` 与 `grant-pg.ts:86-89` 两处四表并查。下线 = 先摘这两处 SELECT 再 `DROP TABLE`，另开一片，不在本片范围 |
| 17 | `media` | `owner_id` | 3 张（`media_derivatives` CASCADE、`content_media_refs` NO ACTION、`community_media_grants` NO ACTION） | — | **排除**：媒体本体是对象存储指针 + 状态机，真正的清理面是 `public.media_object_cleanup` 与桶确认；只删行会留下孤儿对象（比删不干净更糟），需要独立片 |
| 18 | `public.user_backup_copies` | `user_id` | 无 | — | **排除**：备份副本清单由备份清除端口在 30 日窗口处理（`backupPurge`），在线闭集不碰；本片两新域的 `backup_state` 如实停在 `pending` |
| 19 | `sessions` | `user_id` | 无 | — | **排除**：注销受理时由 `public.request_account_deletion()`（SECURITY DEFINER）置 `revoked_at`，行保留作登录审计；属于账号状态迁移而非删除 |
| 20 | `single_profiles` | `user_id` | 无 | — | **排除（下一片首选）**：单作物档案确实是用户数据，但存储层没有按主体清空原语，且删它要与目录/地区版本一致性同批审阅才安全；本片有意留给独立片 |
| 21 | `ocr_jobs` | `owner_user_id` | 无 | — | **排除（下一片）**：与识别域同形（迁移 0024），本片有意不接以控制批次规模；接法可照抄本片 |
| 22 | `ocr_records` | `owner_user_id` | `ocr_jobs` | — | **排除（下一片）**：同上（父表） |
| 23 | `public.admin_audit_events` | `actor_id` | 无 | — | **排除**：管理员审计流水，法定留存；`actor_id` 是操作者不是数据主体 |

> `ocr_idempotency` 等 4 本 `*_idempotency` 台账**无主体列**，不参与上述计数：随各自域一起按 scope 前缀清（`recognitions`/`speech` 两本已在本片覆盖内，`ocr_idempotency` 待 OCR 域接入时并入）。

---

## 3. 授权面：本片最重的坑（也是本片唯一的部署文件改动）

**事实**：`deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r28-runtime-domain-grants` 段此前对识别/语音域**只授列级 SELECT/INSERT/UPDATE**，表级 `DELETE` 仅 `recognition_idempotency` 与 `speech_idempotency` 两条。段内原注释写「jobs / records / selections 不授 DELETE，账号注销经 `request_account_deletion()` 的属主级联」——**这句话是错的**：

- `public.request_account_deletion()`（`services/api/db/migrations/0016_account_deletion_persistence.sql:68-170`）只做四件事：入参自检、`SELECT … FOR UPDATE` 锁 `users` 行、`UPDATE users SET state='deletion_pending', auth_epoch=auth_epoch+1`、撤 `sessions`、插 `deletion_requests`。
- 全仓（`services/api/db/migrations/`、`deploy/`、`tools/`、`services/`）**没有任何 `DELETE FROM public.users`**，也没有 `DELETE FROM public.recognition_*` / `public.speech_*`。
- ⇒ `owner_user_id … ON DELETE CASCADE` **永不触发**：识别/语音域的用户数据在基线版本里一条都不会被删。

**改动（成对，缺一即红）**：

| 文件 | 改动 |
| --- | --- |
| `deploy/postgres-cvm/sql/20-login-roles.sql` | 识别段加 `GRANT DELETE ON public.recognition_jobs, public.recognition_records, public.recognition_selections TO gengyun_api_runtime;`；语音段加 `GRANT DELETE ON public.speech_jobs, public.transcriptions TO gengyun_api_runtime;`；两段 ④ 号说明块与 `\echo` 逐字重写（把「级联」错误说法换成上面这段事实） |
| `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` | 识别/语音探针段原本把这三条/两条 `DELETE` 当作**禁止面**（必须 42501）；改为「按主体 DELETE 必须成功」的 `[16]` 块，禁止面只剩 `recognition_selections` 的 `SELECT … FOR UPDATE`；断言块相应改名（`runtime_recognition_owner_purge_delete`、`runtime_speech_forbidden_surface_withdrawn`）；表级写授权白名单补 5 条三元组，计数 16 → 21；`expected` 清单里这 5 张表的 `del` 由 `false` 改 `true`（`recognition_jobs` / `recognition_records` / `recognition_selections` / `speech_jobs` / `transcriptions`），判据在 `AND has_table_privilege('gengyun_api_runtime', 'public.'\|\|e.tbl, 'DELETE') = e.del` |

**expected 与 GRANT 必须同口径（本片第二次返修新增的护栏）**：`tests/unit/least-privilege-expected-parity.test.mjs`（新增）解析两份 SQL 做**双向**核对 —— `GRANT DELETE … ON … <表>` 里出现的每张表，`90-assert` 的 `expected` 必须 `del=true`；反过来说 `del=true` 的表必须真有 `GRANT`。正向 `ℹ tests 3 · pass 3 · fail 0`；把 `recognition_jobs` 的 `true),` 临时改回 `false),` ⇒ `ℹ tests 3 · pass 1 · fail 2`，红字逐字 `这些表在 20-login-roles.sql 里授了表级 DELETE，但 90-assert 的 expected 仍写 del=false（deploy-sql-gate 会判红）：recognition_jobs`；还原后回到 3/3。

**为什么必须成对**：`tests/unit/sql-column-coverage.test.mjs` 把 8 个 store-pg 里每条 `DELETE` 折算成「整表 DELETE」需求，再拿 `20-login-roles.sql` 的真实授权文本核对（`const TABLE_WIDE_COLUMN = '*';` :494；`if (statement.verb === 'DELETE') add(statement, TABLE_WIDE_COLUMN, 'DELETE', 'DELETE 整表（PG 无列级 DELETE）');` :1573）。只改 store 不改授权 ⇒ 5 条红字（实测原文：`services/api/src/recognitions/store-pg.ts:596 → public.recognition_selections（整表） 缺 DELETE（DELETE 整表（PG 无列级 DELETE））；授权面现状：该表该权限未授任何列`）。这套棘轮正是为「表建了、运行时零授权」这个历史坑设的。

**另一个坑（真库臂实测才暴露）**：`20-login-roles.sql` 的 `-- #region gy-r28-runtime-domain-grants` 在 **:625 就 endregion 了**，识别段（J 段，`:765` 起）与语音段（K 段）**不在任何 region 内** ⇒ 任何「只抽这个 region 建角色」的测试都拿不到新授权，跑出来 `DELETE=false`。整份文件也不能直接执行（文件头用 `:'api_password'` 与 `\gset`，直接喂给驱动会 `syntax error at or near ":"`，code 42601）。

---

## 4. 真库臂：`tests/integration/recognitions-speech-purge-pg.mjs`

九段断言（`GY_PG_BIN` 缺省时打印 SKIP 并 exit 77，不伪造读数）：

| # | 断言 | 本次实测读数 |
| --- | --- | --- |
| 1 | 全链迁移 + 表在岗 | `32 个已应用；识别域四表 + 语音域三表 + users 共查 8 张真实表，全部在岗` |
| 2 | 生产身份授权实测 | `recognition_selections/jobs/records、speech_jobs、transcriptions DELETE=true；users DELETE=false` |
| 3 | 清理前读数 | `A 识别域 2/2/2 行 + 台账 2 行；A 语音域 2/2 行 + 台账 2 行` |
| 4 | 闭集清单 | `favorites / history / messages / conversations / recognitions / speech`（`missingRegistrations` 为空） |
| 5 | 证据串 | `recognitions:online-purged:6;recognitions:idempotency-purged:2`、`speech:online-purged:4;speech:idempotency-purged:2` |
| 6 | 正控制 | 本主体七表注销后全 0 行；**A 的 `users` 行仍在**（⇒ 不是外键级联的副作用）；他人 B 的七表逐字原样 |
| 7 | 负控制 | 未清理主体 C 识别域 1/1/1 行、语音域 1/1 行、台账 1/1 行；两本台账整表 4/4 → 2/2 行 |
| 8 | 重放幂等 | 同一主体第二次清理 = 四个计数全 0 |
| 9 | 回执 | `recognitions` / `speech` 的 `online_state = completed`；`backup_state = pending`（未接备份源，不谎称完成） |

命令：`$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'; $env:GY_R34_PG_ROOT='E:\GengYunCommander\.pg17\tmp'; node tests/integration/recognitions-speech-purge-pg.mjs`

读数：`ALL PASS：9 条真库断言（exit code 0）`，`EXITCODE=0`，集群 PostgreSQL 17.11（临时端口 55883，`initdb` 于 `E:\GengYunCommander\.pg17\pgsql\bin`；rebase 到 `5a449305` 后重跑，读数逐条一致）。

---

## 5. 测试读数

### 5.1 新增/改动的单测

| 文件 | 内容 | 读数 |
| --- | --- | --- |
| `tests/unit/user-data-deletion-recognitions-speech.test.mjs`（新增） | ① 三种注入形态下的闭集（四域/五域/六域）；② 正控制：只清本主体的任务/记录/人工选择/转写与两本台账，他人行原样，证据按表分列；③ 反向控制：store 缺原语 ⇒ 处理器调用即抛、回执折叠 `blocked` + `HANDLER_FAILED`（⛔ 不静默算完成） | `ℹ tests 3 · pass 3 · fail 0` |
| `tests/unit/deletion-registration-coverage.test.mjs`（改） | 覆盖表清单加两域 7 张表；`DECLARED_UNREGISTERED` 去掉已接入的 5 张；`declaredConditionalModules()` 改为读 `CONDITIONAL_DELETION_MODULES` 并核对真实追加点；新增「证据名单含识别/语音、不含社区」断言 | `ℹ tests 6 · pass 6 · fail 0` |
| `tests/unit/sql-column-coverage.test.mjs`（改钉死读数） | `sqlLiterals 157→164`、`DELETE 29→36`、`returningClauses 62→69`、`columnRequirements 1241→1255`、`recognitions 20→24`、`speech 16→19`；扩展侧 `sqlLiterals 266→273`、`DELETE 36→43`、`returningClauses 82→89`、`columnRequirements 1720→1734`、`coveredRequirements 1666→1680` | `ℹ tests 17 · pass 17 · fail 0`（5919ms） |
| `tests/unit/favorites-history-deletion-registration.test.mjs` + `tests/unit/favorites-history-fixtures.mjs`（改） | 闭集断言 5 项 → 7 项；新增 `PG_MIGRATIONS_WITH_DELETION_DOMAINS`（在 `PG_MIGRATIONS_WITH_COMMUNITY` 之后追加 `0025`/`0026`）；`removed` 映射与 `audit` 主体数组扩到七项；证据串加两域（均为 0） | `ℹ tests 2 · pass 2 · fail 0`（5940ms） |
| `tests/unit/gy-i22-secmatrix.test.mjs`（改） | C4「会话与注销」的回执 `handlers` 钉死值 5 项 → 7 项 | `ℹ tests 6 · pass 6 · fail 0` |
| `tests/unit/recognitions-store-pg-wiring.test.mjs` / `speech-store-pg-wiring.test.mjs`（未改，被本片打红后返修代码） | 两条结构钉子要求「装配行保持内联三段式」「装配层只允许 `import type` 语音存储、且只 1 行」 | `ℹ tests 10 · pass 10 · fail 0` |
| `tests/unit/ci-integration-chain-structure.test.mjs`（改） | 新真库臂登记进 `UNWIRED_DECLARATIONS`（含数据根键 `GY_R34_PG_ROOT` 的真值说明） | `ℹ tests 7 · pass 7 · fail 0` |
| `tests/unit/doc-anchors-guard.test.mjs`（未改，被本片打红后改文档） | 7 处文档行号锚点随本片代码下移，逐处重取并注明新旧行号 | `ℹ tests 10 · pass 10 · fail 0` |
| `tests/unit/least-privilege-expected-parity.test.mjs`（新增） | ① 双向成对：`20-login-roles.sql` 的 `GRANT DELETE` 表集 == `90-assert` 的 `expected … del=true` 表集；② 解析器自检（`flags.size ≥ 29`、`granted.size ≥ 9`、本片五张表两侧都在）；③ 常驻反向控制（合成 SQL 两侧都能点名） | 正向 `ℹ tests 3 · pass 3 · fail 0`；把一行 `expected` 改回 `false` ⇒ `ℹ tests 3 · pass 1 · fail 2`（红字点名 `recognition_jobs`） |

### 5.2 全量 `npm run test:unit`（根目录，命令见 §0）

`ℹ tests 4281 · pass 4264 · fail 14 · cancelled 0 · skipped 1 · todo 2`，exit 1。

> 读数稳定性说明（如实）：加护栏后第一次全量跑报过 `fail 15`，该次同时有 5 个临时集群在跑；随后两次独立跑（全量一次、`tests/unit` 单独一次）都是 `14` 红，且逐条都是下表这三个文件，另外三个目录（`tests/privacy` `tests/media` `tests/reference` `tests/moderation`，共 1063 条）全绿。判定那 1 条为并发负载下的抖动，未在本片复现，故不登记为本片缺陷。

**14 条失败全部是**上游既有**（与本片改动无关），逐文件实测归因（在 detach 到 `upstream/main`=`5a449305` 的干净 worktree 里复跑同一批文件）：

| 文件 | 失败条数 | 基线复跑 | 根因（与 Windows 宿主相关） |
| --- | --- | --- | --- |
| `tests/unit/release-materials-index.test.mjs` | 2 | 同样 2 红 | `tools/verify-release-materials.mjs` 的「被索引文件全部非空」把 `deploy/purge-schedule/`（**目录**）读成 0 字节 |
| `tests/unit/release-materials-index-strict.test.mjs` | 6 | 同样 6 红 | 同上（镜像正控制 + 5 条反例都依赖该判据全绿） |
| `tests/unit/release-runbook-guard.test.mjs` | 6 | 同样 6 红 | 该文件与 `docs/release/runbook-20261022.md` 的既有不一致（`expectRunbookRed` 反例计数 `actual 2, expected 1`） |
| 合计 | **14** | **14** | 基线 14 = 本树 14，逐条对上 |

基线复跑命令（干净 worktree 内，`npm ci` 后）：`node --test tests/unit/release-materials-index.test.mjs tests/unit/release-runbook-guard.test.mjs` ⇒ `ℹ tests 14 · pass 6 · fail 8`；`node --test tests/unit/release-materials-index-strict.test.mjs` ⇒ `ℹ tests 6 · pass 0 · fail 6`。合计 14 红，与本树逐条同名。

### 5.3 `90-assert-least-privilege.sql` 本机真库实跑（按 deploy gate 配方）

配方取自 `.github/workflows/deploy-sql-gate.yml` 的 job `deploy-sql-17-11`（`postgres:17.11` 服务容器、`POSTGRES_DB=gengyun`、`POSTGRES_USER=gengyun_cvm_owner`），本机以临时集群逐字复刻：

| 步 | 命令（工作树根目录执行） | 前置条件 |
| --- | --- | --- |
| 0 | `initdb -D <tmp> --no-sync --encoding=UTF8 --locale=C -U gengyun_cvm_owner --auth=trust`；端口/监听地址/`max_connections=64` 写进 `postgresql.conf` 后 `pg_ctl -w start` | 端口取 **55436 之后**的空闲口（本机 55432–55435 已被占；本次用 55438） |
| 1 | `psql -X -q -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun OWNER gengyun_cvm_owner'` | `20-login-roles.sql:94` 断言 `current_database() = 'gengyun'` |
| 2 | `node services/api/src/db/migrate.ts up`（env `DATABASE_URL=postgres://gengyun_cvm_owner:…@127.0.0.1:<port>/gengyun`） | `migrate.ts` 只认 `DATABASE_URL` |
| 3 | 5 个组角色按 `provision-db.sh:267-273` 顺序：`auth_privacy` → `catalog_readers` → `consent_granter` → `profile_runtime` → `knowledge_runtime`，各 `psql -X -q -v ON_ERROR_STOP=1 -f services/api/db/roles/<f>` | 组角色必须**先**存在（`20-login-roles.sql` 只校验不代建） |
| 4 | `psql -X -q -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/20-login-roles.sql`（env `GENGYUN_API_RUNTIME_PASSWORD` = 48 位小写十六进制合成值） | 文件头 `\getenv` + 口令形状校验；库名/owner 校验 |
| 5 | `psql -X -q -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql` | 需要超级用户（读 `pg_authid`） |

实测读数：`STEP2_MIGRATE_EXIT=0`（`已应用：0001…0032`）、`STEP3_*` 五个角色文件均 `exit 0`、`STEP5_90ASSERT_EXIT=0`、输出非空行 22 行、**末行逐字 `ok`** ⇒ 判据（退出码 0 **且** 末行 `ok`）双双满足。日志里可见的 `ERROR: permission denied for table recognition_selections`（`:743`）与 `permission denied for schema catalog_ops/staging_intake` 是脚本**设计内的** 42501 探针，不改退出码。

配套的直接读数（同一集群，库属主视角）：

| 表 | `has_table_privilege('gengyun_api_runtime','public.'\|\|tbl,'DELETE')` |
| --- | --- |
| `recognition_jobs` / `recognition_records` / `recognition_selections` | `t` / `t` / `t` |
| `speech_jobs` / `transcriptions` | `t` / `t` |
| `recognition_idempotency` / `speech_idempotency` | `t` / `t` |
| `users` / `media` / `deletion_requests` | `f` / `f` / `f` |

复跑脚本：本机一次性脚本 `E:\GengYunCommander\.pg17\tmp\i19closure2\run-deploy-sql-gate.ps1`（**不入库**；仓库内可复现的是上面 6 步命令）。Windows PowerShell 5.1 上有两个坑，写在这里免得下一个人再踩：① `pg_ctl` 的输出**不能**重定向/进管道——它启动的 `postgres` 会继承句柄，PowerShell 会等到 EOF 卡死；② 直接 `& pg_ctl … -t 60 -w start` 会被 5.1 的原生参数传递弄坏（实测 pg_ctl 报 `unrecognized operation mode "60"`），`cmd /c` 拼引号又会把 `-o` 吃掉（postgres 退回 5432）——最终用 `System.Diagnostics.Process` 逐参数传 argv，并把端口写进 `postgresql.conf`。

---

## 6. 未做 / 风险 / 建议

### 6.1 未做（如实）

1. **OCR 域不接**：`ocr_jobs` / `ocr_records` / `ocr_idempotency` 与识别域同形（迁移 0024），本片有意不接，以免一次改动横跨三个域、审阅面过大。
2. **`single_profiles` 不接**：确属用户数据，但存储层无清空原语，且与目录/地区版本一致性耦合，留给独立片。
3. **媒体本体不接**：`media` / `media_derivatives` / `content_media_refs` / `community_media_grants` 的删除必须与对象存储清理（`media_object_cleanup`）同批做，只删行会留孤儿对象。
4. **备份列仍是 `pending`**：`recognitions` / `speech` 没有 `user_backup_copies` 的写入源，`refreshBackupStates` 仍只推导四域（否则会凭空 `blocked`）。30 日备份义务对这两域**尚无取证路径**。
5. **`90-assert` 已在本机真库跑过，但不是 CI 本体**：按 §5.3 的 gate 配方用临时集群 + 生产身份实跑，读数 `exit 0`、末行 `ok`、五张表 `DELETE=true`/`users=false`；差别在于本机是 Windows + 自建集群（`postgres:17.11` 二进制相同），**没有**跑 gate 的另外三个 job（`--with-cli-groups` 形态、42501 探针 job、恢复演练 job）。

### 6.2 风险

1. **条件注入仍会静默缩小闭集**：`recognitionsStore` / `speechStore` 不注入 ⇒ `requiredModules` 少两项、回执少两行，与「已清完」在回执上无法区分。这是既有 `community` 折中的延续（`#19` 待裁定项）。本片把三者收进 `CONDITIONAL_DELETION_MODULES` 并用棘轮测试核对**真实追加点**，但**没有**改成「缺失即抛」——那会破坏内存装配与既有测试。
2. **两新域都靠「调用期取原语」，装配结构因此多了两处隐式依赖**：识别/语音端口都从 `app.recognitionService` / `app.speechService` 上取 `purgeOwnerData`（见 §1.3），依赖「注销请求必然发生在装配完成之后」。这一点被装配结构钉住（两域服务都在 `buildApp` 内 `decorate`），但**不是类型系统保证**：若将来有人在 `buildApp` 之外构造删除协调器，拿不到服务就抛 `…拒绝假装清空`（fail-closed，回执 `blocked`），不会静默算完成。实跑 `node tools/verify-contract-status.mjs` ⇒ exit 0（`PASS: 行号区间 240 条…`、`PASS: 中文表格一致`），**未触发重锚**；若后续再动 `app.ts` 行数需复跑同一命令。
3. **装配层的结构钉子会拦住"顺手重构"**：`recognitions-store-pg-wiring.test.mjs` 要求装配行保持内联三段式三元表达式、且 `app.ts` 末尾那行 `import { createPostgresRecognitionStore }` 是文件最后一行；`speech-store-pg-wiring.test.mjs` 要求 `app.ts` 里引用 `speech/store` 的行**恰好 1 行**且是 `import type`。本片第一版把 store 上提成常量 + 追加两个值 import，两条钉子都红了，只能改走 §1.3 的调用期取法。

### 6.3 建议（未执行）

1. 下一片接 OCR 域（照抄识别域四表模式，含两处部署授权与 90-assert 白名单）。
2. `single_profiles` 需要先定「档案数据在注销后是否允许保留用于统计」的口径，再决定是删还是脱敏。
3. 媒体域应单独立项：`media_object_cleanup` + 桶确认 + `content_media_refs` 的一致性，不是一个批次能收口的。
4. 若要消除风险 1，可把 `CONDITIONAL_DELETION_MODULES` 的注入改成「生产装配下缺失即抛、测试装配显式声明」——但那要先改全部既有测试的装配方式，属于独立重构。
