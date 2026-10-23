# R28-S66 证据页：把 `services/api/src` 里剩下的 SQL 宿主纳入「列面 ↔ 授权面」守卫

- 切片：R28-S66（派单 `.pg17/dispatch/r28-s66-sql-column-coverage-all.md`）
- 分支：`test/gy-r28-sql-column-coverage-all`，基点 `upstream/main` = `6d7f2af`
- 改动：`tests/unit/sql-column-coverage.test.mjs`（**纯扩展**）＋ 本证据页
- 本片定性：**测试资产型**。`services/**`、`deploy/**`、`migrations/**`、`services/api/db/roles/**`、`.github/**`、`apps/**`、`packages/**` 一行未改；⛔ 没有新增/修改任何 `GRANT`/`REVOKE`。

## 0. 一句话结论

把 S61 只覆盖 8 个 `store-pg.ts` 的守卫，扩到 **16 个文件**（8 个 store ＋ 8 个新纳管 SQL 宿主）：**213** 条 SQL 字面量 → **39** 张表 → **1375** 条列权限要求，其中 **1321** 条命中现有授权面；剩余 **54 条语句级缺口（33 个唯一 `table.column.privilege` 键）全部落在 `services/api/src/privacy/ledger-pg.ts` 的 `public.exports` / `public.export_writebacks`**，属「`gengyun_egress_ledger` 组未部署、也未被运行时角色继承」这一个已知范畴，逐条登记进豁免表（条数钉死 33，`staleExemptions` 反查）。**ledger 之外的缺口 0 条。**

零缺口不可信，所以另给三组证据：文件集不变量（扫到的 21 个 SQL 宿主必须恰好等于 16 个已审计 ＋ 5 个显式登记）、NC5–NC9 五条负控制逐条变红并点名、行锁规则（`FOR UPDATE` ⇒ 额外要 UPDATE）在撤掉真实授权后精确点名两处站点。

## 1. 为什么扩

S61 的覆盖面是 `services/api/src/**/store-pg.ts`，8 个文件、1155 条要求、0 缺口。但 `services/api/src` 里还有别的 SQL：`profile/service.ts` 读写 `single_profiles`、`privacy/*` 读写 `consent_records`/`exports`、`admin/ops/*` 读写 `feature_flags`。**这些文件的列改名没有任何守卫**：改错列名只会在运行时炸 42703/42501，测试全绿。

更关键的是「覆盖面」本身没有不变量：S61 用写死的 8 个域名派生文件清单，**新增一个带 SQL 的 `.ts` 文件不会让守卫变红**。本片把这两件事一起补上：

1. 8 个新文件走**同一套** `parseGrantSources` / `extractRuntimeSql` / `evaluateCoverage` 管线（不另造判据）；
2. 「`services/api/src` 里有哪些 SQL 宿主」这件事本身成为断言；
3. ledger 的已知缺口进**显式**豁免表（`reason` + `owner`，条数钉死），不再靠「反正 S61 没扫它」。

## 2. 覆盖面与读数

### 2.1 16 个文件逐文件读数

| 文件（相对仓库根） | 字面量 | INSERT | UPDATE | SELECT | DELETE |
| --- | --- | --- | --- | --- | --- |
| `services/api/src/admin/ops/accounts-pg.ts` | 1 | 0 | 0 | 1 | 0 |
| `services/api/src/admin/ops/flags-pg.ts` | 4 | 0 | 0 | 4 | 0 |
| `services/api/src/community/store-pg.ts` | 28 | 7 | 3 | 14 | 4 |
| `services/api/src/conversations/store-pg.ts` | 16 | 3 | 2 | 8 | 3 |
| `services/api/src/favorites/store-pg.ts` | 15 | 2 | 1 | 7 | 5 |
| `services/api/src/history/store-pg.ts` | 16 | 2 | 1 | 8 | 5 |
| `services/api/src/knowledge/service.ts` | 4 | 0 | 0 | 4 | 0 |
| `services/api/src/messages/store-pg.ts` | 12 | 2 | 2 | 6 | 2 |
| `services/api/src/ocr/store-pg.ts` | 16 | 3 | 4 | 7 | 2 |
| `services/api/src/privacy/backup-copies-pg.ts` | 4 | 1 | 2 | 1 | 0 |
| `services/api/src/privacy/consent-pg.ts` | 14 | 1 | 2 | 10 | 1 |
| `services/api/src/privacy/grant-pg.ts` | 12 | 3 | 1 | 7 | 1 |
| `services/api/src/privacy/ledger-pg.ts` | 24 | 2 | 6 | 16 | 0 |
| `services/api/src/profile/service.ts` | 11 | 2 | 0 | 8 | 1 |
| `services/api/src/recognitions/store-pg.ts` | 20 | 5 | 4 | 9 | 2 |
| `services/api/src/speech/store-pg.ts` | 16 | 3 | 4 | 7 | 2 |
| **合计** | **213** | **36** | **32** | **117** | **28** |

### 2.2 总读数（全部钉死在断言里，改一个数就红）

| 读数 | 值 |
| --- | --- |
| 审计文件数 | 16（8 store ＋ 8 新纳管） |
| SQL 字面量 | 213 |
| 语句条数 | INSERT 36 / UPDATE 32 / SELECT 117 / DELETE 28 |
| `RETURNING` 子句 | 66 |
| `ON CONFLICT` 子句 | 21 |
| `SELECT *`（列面不可判，只计数不判权限） | 15（其中 `t.*` 4） |
| `FROM public.<fn>()`（函数调用，不是表访问） | 1 |
| 无顶层 `FROM` 的语句（就绪探针、`EXISTS` 子查询、`SELECT fn()`） | 10 |
| 行锁 | `FOR UPDATE` 19 处 / `FOR SHARE` 16 处 |
| 行锁要求 | 19 条（另 16 处 `FOR SHARE` 按派单 §2.5 不要求额外权限） |
| 引用到的表 | 39（含 1 个 `catalog_read` 视图） |
| 列权限要求 | 1375 |
| 已覆盖 | 1321（缺 54 条语句级 ⇒ 33 个唯一键，全部豁免） |
| 覆盖来源 | 列级精确命中 **1249** / 表级整表命中 **72** |
| 不可判插值 | 5（store 2 ＋ ledger 3，逐条 `file:line` 登记） |
| 新增量（8 个新文件自身） | 8 文件 74 条字面量 / 74 条语句 / 15 张表 / **220 条要求** / 零豁免时缺 54 条（33 个唯一键，全部落在 `privacy/ledger-pg.ts`）/ 行锁 9 条 |

基线（S61 的 8 个 store，零豁免）在本片**原样保留并通过**：1155 条要求、25 张表、`SELECT *` 0 处、不可判插值 2 条、逐文件字面量与 S61 钉死值逐字相同。新增的 8 个文件贡献 `1375 − 1155 = 220` 条要求，与基线可加。

## 3. 解析器这轮补掉的五个缺陷（每个都由新文件暴露）

| # | 缺陷 | 出处 | 症状 | 修法 |
| --- | --- | --- | --- | --- |
| 1 | 函数调用被当成表 | `services/api/src/admin/ops/accounts-pg.ts:46` `SELECT id, revision, state, display_name FROM public.list_admin_accounts()` | 造出 4 条假列要求（`id`/`revision`/`state`/`display_name`），是阶段一差集里**唯一**的非 ledger「缺口」 | 读到限定名后紧跟 `(` ⇒ 记 `functionCall`、`table = null`，不产生列要求；同时把 `functionCalls` 计数钉死（=1），防止悄悄变多 |
| 2 | 反引号常量没进常量表 | `services/api/src/privacy/consent-pg.ts:46-48` 的 `currentRecords` | `` `${currentRecords} WHERE …` ``（`:126`、`:140`、`:165`）三条语句**被整条静默丢弃**（S61 用「第一个 text chunk 是否像 SQL」预筛，而这仨的首 chunk 是插值），其中 `:165` 还带 `FOR UPDATE OF p` | `buildConstMap` 追加无插值反引号常量；`extractRuntimeSql` 改为**先代入常量拼出 sql、再判是不是 SQL**；不可判插值先攒进 `pending`，确认是 SQL 后才落盘 |
| 3 | 裸动词串被当成语句 | `consent-pg.ts:149` `idempotencyScope(..., 'DELETE', ...)` | `'DELETE'` 这个 HTTP 动词被计成 1 条 DELETE 语句 | `SQL_START` 要求动词后必须还有内容（动词后接 `\s+\S`）；否则 `'DELETE'` 这种裸动词串会被当成一条语句 |
| 4 | `t.*` 与中段 ` AS ` 造出假列 | `consent-pg.ts:46-48` 的 `c.*`、`p.state AS epoch_state` | 产生 `privacy_epochs.c`、`privacy_epochs.epoch_state` 两个不存在的列（被表级 SELECT 蒙住，所以不判红 —— 但会掩盖真缺口） | 逐项剥 ` AS alias`；`t.*` 记 `qualifiedStar` 并从列面里剔除（列面不可判，见 §7） |
| 5 | 逐文件键撞车 | 8 个新文件 | `extractRuntimeSql` 用 `file.split('/').slice(-2)[0]` 作 `byFile` 键 ⇒ 8 个新文件只产出 4 个键（`ops`/`knowledge`/`privacy`/`profile` 后写覆盖前写），逐文件读数会假绿 | `hostKey(file)`：`store-pg.ts` 仍用域名（保持 S61 读数），其余用 `services/api/src/` 之后的相对路径 |

缺陷 1–4 是「阶段一差集」里唯一需要修的东西：修完后**非 ledger 缺口归零**，差集里剩下的 33 个唯一键与 ledger 的已知范畴逐条相等。

## 4. 文件集不变量的构造

### 4.1 派单 §1.2 的字面形式不可达（实测）

派单写的是「8 store ＋ 8 新文件恰好构成含 `public.` 限定 SQL 的文件集」。实测三种谓词：

| 谓词 | 命中 | 说明 |
| --- | --- | --- |
| 派单原本的 `git grep -l` 四条模式（`INSERT INTO public.` / `UPDATE public.` / `FROM public.` / `DELETE FROM public.`） | **12** | 8 个新文件 ＋ `messages`/`ocr`/`recognitions`/`speech` 4 个 store；另 4 个 store 的 SQL 不带 `public.` 限定 |
| 扫字面量后「解析出 ≥1 条带表或函数调用的语句」 | **21** | 16 个已审计 ＋ 5 个未纳管 |
| 扫 `services/api/src` 下所有 `.ts` | 36 | 其中 15 个文件没有可解析的 SQL（纯类型/工具） |

所以「恰好 16」只在「按 `public.` 限定 grep」这一种口径下接近成立，且它会把 4 个 store 漏掉、把 8 个新文件记住 —— 这不是不变量，只是巧合。本片取**最强且诚实**的形式：

```
discoverSqlHosts() 的结果  ==  16 个已审计文件  ∪  5 条 UNAUDITED_SQL_HOSTS 登记（file + reason + owner）
且：16 个已审计文件必须全部仍被扫到、每个至少 1 条 SQL；5 条登记必须全部仍被扫到
```

`discoverSqlHosts()` 的谓词是 `table !== null || functionCall !== null`。**必须含 `functionCall`**：`admin/ops/accounts-pg.ts` 的唯一语句是函数调用，只判 `table` 会让这个文件从宿主集里凭空消失（实测 `hosts=20` 而不是 21）。

### 4.2 21 个宿主的全清单

| 文件 | 处理 |
| --- | --- |
| `services/api/src/admin/ops/accounts-pg.ts` | **已审计**（1 条字面量，含函数调用） |
| `services/api/src/admin/ops/flags-pg.ts` | **已审计**（4 条字面量） |
| `services/api/src/app.ts` | 登记不审计：目录视图读取（SELECT * FROM catalog_read.current_knowledge） |
| `services/api/src/auth/idempotency.ts` | 登记不审计：public.idempotency_keys 的幂等回执读写 |
| `services/api/src/auth/store.ts` | 登记不审计：public.users / public.sessions / public.admin_* 的登录态读写 |
| `services/api/src/community/store-pg.ts` | **已审计**（28 条字面量） |
| `services/api/src/conversations/store-pg.ts` | **已审计**（16 条字面量） |
| `services/api/src/db/catalog.ts` | 登记不审计：catalog_read.* 目录视图读取 |
| `services/api/src/db/migrate.ts` | 登记不审计：public.schema_migrations（迁移执行器，部署期使用而非请求期）。 |
| `services/api/src/favorites/store-pg.ts` | **已审计**（15 条字面量） |
| `services/api/src/history/store-pg.ts` | **已审计**（16 条字面量） |
| `services/api/src/knowledge/service.ts` | **已审计**（4 条字面量） |
| `services/api/src/messages/store-pg.ts` | **已审计**（12 条字面量） |
| `services/api/src/ocr/store-pg.ts` | **已审计**（16 条字面量） |
| `services/api/src/privacy/backup-copies-pg.ts` | **已审计**（4 条字面量） |
| `services/api/src/privacy/consent-pg.ts` | **已审计**（14 条字面量） |
| `services/api/src/privacy/grant-pg.ts` | **已审计**（12 条字面量） |
| `services/api/src/privacy/ledger-pg.ts` | **已审计**（24 条字面量） |
| `services/api/src/profile/service.ts` | **已审计**（11 条字面量） |
| `services/api/src/recognitions/store-pg.ts` | **已审计**（20 条字面量） |
| `services/api/src/speech/store-pg.ts` | **已审计**（16 条字面量） |

### 4.3 为什么那 5 个只登记、不审计

把它们纳入审计会多出 **21 个唯一缺口键**，其中：

- **真实缺口 2 条**：`public.users.auth_epoch|UPDATE`、`public.users.revision|UPDATE`（`services/api/src/auth/store.ts`）—— 不属 ledger 范畴，按派单 §5 必须停下交指挥裁定，**本片无权自定豁免**；
- **解析噪声 19 条**：`auth/store.ts` 有表名位插值（`` `… FROM public.${table}` `` 之类），解析退化成 `public.where.*`、`public.set.revoked_at` 这类假表假列。

因此本片不扩审计面，只把「新宿主一定会红」这件事钉死（NC7）。这 5 个文件与本片发现的 2 条真实缺口都写进 §9 未取得项。

## 5. 豁免表：33 条列级 ＋ 1 条行锁 ＋ 3 条不可判插值

### 5.1 依据（为什么这算「已知」而不是「本片引入」）

`public.exports` / `public.export_writebacks` 的列授权**写在仓库里**：`services/api/db/roles/egress_ledger.sql:34-48`（`exports` 的 SELECT/INSERT/UPDATE 列清单、`export_writebacks` 的 `GRANT SELECT,INSERT`）。缺的不是授权文本，是**接线**：

1. `egress_ledger.sql` **不被任何部署脚本执行** —— `deploy/postgres-cvm/provision-db.sh:285` 明确「默认 5 个组，`egress_ledger.sql` 当前不被本脚本执行」；`deploy/postgres-cvm/README.md:440` 同口径并注明「是否需要授权属产品/安全待裁定」。
2. 即使执行了，`gengyun_egress_ledger` 也**不在运行时角色的成员闭包内**：`deploy/postgres-cvm/sql/20-login-roles.sql:221-225` 只把 5 个组授给 `gengyun_api_runtime`；`:54` 原文「**本文件只授其中 5 个组**（C 段）；`egress_ledger.sql` 当前不被任何部署脚本执行，故 `gengyun_egress_ledger` 不在本文件的授权面内」。

而代码是**接上的**：`services/api/src/app.ts:107` import `createPostgresExportLedger`、`:863` 只要连接池可用就装配。也就是说：**运行时一旦走到外发账本路径，这 33 条要求就会以 42501 的形式炸出来**（被 `mapPgError` 笼统映射成 503）。这正是本片必须把它登记为「已知缺口」而不是「解析噪声」的理由；是否接线（专用 LOGIN 继承 `gengyun_egress_ledger`，或另开片补授权）属产品/安全裁定。

### 5.2 33 条列级豁免（条数钉死，逐条 `reason` + `owner`）

| `table.column` | 权限 | SQL 站点（`privacy/ledger-pg.ts`） |
| --- | --- | --- |
| `public.export_writebacks.committed_at` | SELECT | 655 |
| `public.export_writebacks.export_id` | INSERT | 642 |
| `public.export_writebacks.export_id` | SELECT | 642、655 |
| `public.export_writebacks.result` | INSERT | 642 |
| `public.export_writebacks.result` | SELECT | 655 |
| `public.export_writebacks.revision` | INSERT | 642 |
| `public.export_writebacks.revision` | SELECT | 655 |
| `public.export_writebacks.user_id` | INSERT | 642 |
| `public.export_writebacks.user_id` | SELECT | 655 |
| `public.exports.auth_epoch` | INSERT | 443 |
| `public.exports.cancellation_reason` | UPDATE | 684、707 |
| `public.exports.cancelled_at` | UPDATE | 684、707 |
| `public.exports.consent_epoch` | INSERT | 443 |
| `public.exports.consent_id` | INSERT | 443 |
| `public.exports.error_code` | UPDATE | 612、684、707、729 |
| `public.exports.id` | SELECT | 396、707、729 |
| `public.exports.job_id` | UPDATE | 570 |
| `public.exports.object_id` | INSERT | 443 |
| `public.exports.object_key` | INSERT | 443 |
| `public.exports.object_revision` | INSERT | 443 |
| `public.exports.object_type` | INSERT | 443 |
| `public.exports.purpose` | INSERT | 443 |
| `public.exports.recipient_config_version` | INSERT | 443 |
| `public.exports.recipient_id` | INSERT | 443 |
| `public.exports.required_consents` | INSERT | 443 |
| `public.exports.revision` | INSERT | 443 |
| `public.exports.revision` | UPDATE | 591、612、684、707、729 |
| `public.exports.sent_at` | UPDATE | 591 |
| `public.exports.source_version` | INSERT | 443 |
| `public.exports.state` | INSERT | 443 |
| `public.exports.state` | UPDATE | 591、612、684、707、729 |
| `public.exports.updated_at` | UPDATE | 570、591、612、684、707、729 |
| `public.exports.user_id` | INSERT | 443 |

### 5.3 行锁豁免与不可判插值

| 类型 | 条目 | 理由 |
| --- | --- | --- |
| 行锁 | `public.exports` 的 `UPDATE`，站点 `services/api/src/privacy/ledger-pg.ts:244` | 与上面 33 条同一范畴：`exports` 对运行时角色无任何 UPDATE 授权 |
| 不可判插值 | `services/api/src/privacy/ledger-pg.ts:399` | 三元选择 `object_key=$3` / `object_id=$3::uuid`，两列都已在列面里 |
| 不可判插值 | `services/api/src/privacy/ledger-pg.ts:549` | `byKey` 决定锁 `object_key` 还是 `object_id` |
| 不可判插值 | `services/api/src/privacy/ledger-pg.ts:550` | `scoped` 时追加 `AND user_id=$4::uuid`，`user_id` 已在列面里 |

行锁豁免比列级豁免多一个 `ref: file:line`：行锁要求没有列名，若只按表豁免，同表上**新增**的 `FOR UPDATE` 语句会被一起放行（躺平）。反向核对：登记了却对不上任何行锁要求 ⇒ `staleExemptions` 判红（NC8 走一遍）。

## 6. 行锁规则（判据与出处）

| 锁 | 是否额外要求 UPDATE | 出处／依据 |
| --- | --- | --- |
| `FOR UPDATE` / `FOR NO KEY UPDATE` | **是** | PG 文档「must have `UPDATE` … for at least one column of each table so selected」；本仓用列级单列 `UPDATE`（如 `UPDATE (revision)`）作行锁载体，见下表「授权载体」列 |
| `FOR SHARE` / `FOR KEY SHARE` | **否** | 派单 §2.5 明确「不需要额外权限」，本片按此判定 |

**与仓库既有注释的差异（必须写清）**：`services/api/db/roles/consent_granter.sql:17` 与 `profile_runtime.sql:20-22` 的注释按「`FOR SHARE` 也需要 UPDATE」的旧口径多授了 `UPDATE(updated_at)` / `UPDATE(name)`。本片按派单口径判定，并做了**敏感性核对**：16 处 `FOR SHARE` 落在 9 张表上（`public.community_posts`、`public.consent_policies`、`public.consent_records`、`public.crops`、`public.privacy_epochs`、`public.recipients`、`public.regions`、`public.sessions`、`public.users`）。逐表核对「该表对运行时角色是否有任何 UPDATE 授权」：**没有任何一张表缺 UPDATE 授权（0 张）**。也就是说若按仓库注释的旧口径（`FOR SHARE` 也要 UPDATE）判定，会多出 0 条红字，与派单口径结论完全一致。

19 条行锁要求逐条：

| # | 站点 | 表 | 锁 | 授权载体（现状） |
| --- | --- | --- | --- | --- |
| 1 | `services/api/src/community/store-pg.ts:414` | `public.community_posts` | `FOR UPDATE` | 列级 `UPDATE (audit_state, body, crop_id, linked_knowledge_id, linked_knowledge_revision, linked_knowledge_type, media_ids, region_code, revision, title, updated_at, visibility)` |
| 2 | `services/api/src/community/store-pg.ts:470` | `public.community_comments` | `FOR UPDATE` | 列级 `UPDATE (audit_state, body, revision, visibility)` |
| 3 | `services/api/src/conversations/store-pg.ts:260` | `public.conversations` | `FOR UPDATE` | 列级 `UPDATE (revision)` |
| 4 | `services/api/src/conversations/store-pg.ts:342` | `public.conversation_turns` | `FOR UPDATE` | 列级 `UPDATE (answer_id, job_error_code, job_state, revision, updated_at)` |
| 5 | `services/api/src/favorites/store-pg.ts:238` | `public.favorites` | `FOR UPDATE` | 列级 `UPDATE (revision)` |
| 6 | `services/api/src/history/store-pg.ts:242` | `public.history` | `FOR UPDATE` | 列级 `UPDATE (revision)` |
| 7 | `services/api/src/ocr/store-pg.ts:545` | `public.ocr_jobs` | `FOR UPDATE` | 列级 `UPDATE (deadline_at, error_code, revision, state, updated_at)` |
| 8 | `services/api/src/recognitions/store-pg.ts:668` | `public.recognition_jobs` | `FOR UPDATE` | 列级 `UPDATE (deadline_at, error_code, revision, state, updated_at)` |
| 9 | `services/api/src/recognitions/store-pg.ts:763` | `public.recognition_records` | `FOR UPDATE` | 列级 `UPDATE (candidates, deleted, model_version, revision, selected_species_id, uncertainty_reasons, updated_at)` |
| 10 | `services/api/src/speech/store-pg.ts:550` | `public.speech_jobs` | `FOR UPDATE` | 列级 `UPDATE (deadline_at, error_code, revision, state, updated_at)` |
| 11 | `services/api/src/privacy/consent-pg.ts:75` | `public.users` | `FOR UPDATE` | 列级 `UPDATE (updated_at)` |
| 12 | `services/api/src/privacy/consent-pg.ts:165` | `public.privacy_epochs` | `FOR UPDATE` | 列级 `UPDATE (current_epoch, revision, state, updated_at)` |
| 13 | `services/api/src/privacy/grant-pg.ts:44` | `public.idempotency_keys` | `FOR UPDATE` | 列级 `UPDATE (outcome, response_status)` |
| 14 | `services/api/src/privacy/grant-pg.ts:71` | `public.privacy_epochs` | `FOR UPDATE` | 列级 `UPDATE (current_epoch, revision, state, updated_at)` |
| 15 | `services/api/src/privacy/grant-pg.ts:74` | `public.consent_records` | `FOR UPDATE` | 列级 `UPDATE (revision, state, withdrawn_at)` |
| 16 | `services/api/src/privacy/ledger-pg.ts:244` | `public.exports` | `FOR UPDATE` | **未授** |
| 17 | `services/api/src/profile/service.ts:35` | `public.users` | `FOR UPDATE` | 列级 `UPDATE (updated_at)` |
| 18 | `services/api/src/profile/service.ts:77` | `public.idempotency_keys` | `FOR UPDATE` | 列级 `UPDATE (outcome, response_status)` |
| 19 | `services/api/src/profile/service.ts:84` | `public.single_profiles` | `FOR UPDATE` | 列级 `UPDATE (crop_id, region_catalog_version, region_code, revision, updated_at)` |

## 7. 五条负控制的红字原文（NC5–NC9）

### 7.1 NC5 新纳管文件里多一列未授权列 ⇒ 红并点名

变异：把 `services/api/src/profile/service.ts:35` 的 `SELECT state,auth_epoch FROM public.users … FOR UPDATE` 改成 `SELECT state,auth_epoch,email …`（只改内存字符串，不动仓库文件）。

```
services/api/src/profile/service.ts:35 → public.users.email 缺 SELECT（SELECT 列清单）；授权面现状：只授了 [id, state, auth_epoch, revision, wechat_subject_lookup]
```

同时断言「除 email 外不许有别的红字」，证明豁免表没有顺带吞掉别的缺口。

### 7.2 NC6 真实授权文本少授一列 ⇒ 红并点名（复原回绿）

变异：从 `services/api/db/roles/profile_runtime.sql:18` 的 `GRANT SELECT (code,name,parent_code,catalog_version,supported) ON public.regions` 里删掉 `name`。

```
services/api/src/profile/service.ts:61 → public.regions.name 缺 SELECT（SELECT 列清单）；授权面现状：只授了 [code, parent_code, catalog_version, supported]
```

复原后 `coverage.problems.length === 0`。

### 7.3 NC7 往 `services/api/src` 临时加一个 SQL 宿主 ⇒ 文件集不变量红

临时文件 `services/api/src/nc7-temp-sql-host.ts`，内容 `export const NC7_SQL = 'SELECT count(*) FROM public.favorites';`，跑完在 `finally` 里删除。

```
services/api/src/nc7-temp-sql-host.ts 是 SQL 宿主，但既不在 16 个已审计文件里，也没有 UNAUDITED_SQL_HOSTS 登记
```

删除后 `findHostSetProblems(...) === []`。

### 7.4 NC8 豁免表登记源码里不存在的缺口 ⇒ 判陈旧

```
COVERAGE_EXEMPT 里登记的 public.exports.no_such_column（SELECT）已不再缺失（运行时 SQL 已不再引用该列） —— 陈旧例外，删掉它
```

```
ROW_LOCK_EXEMPT 登记的 services/api/src/privacy/ledger-pg.ts:99999 → public.exports 缺 UPDATE 在源码里已不成立（陈旧登记，删掉它以免守卫躺平）
```

### 7.5 NC9 撤掉 `FOR UPDATE` 需要的 UPDATE 授权 ⇒ 行锁规则点名两处站点

变异：从 `services/api/db/roles/auth_privacy.sql:23` 删掉 `GRANT UPDATE (updated_at) ON users TO gengyun_auth_privacy;`。

```
services/api/src/privacy/consent-pg.ts:75 → public.users 缺 UPDATE（行锁 FOR UPDATE，PG 对 FOR UPDATE/FOR NO KEY UPDATE 除 SELECT 外还要求 UPDATE 权限）；授权面现状：该表该权限未授任何列
services/api/src/profile/service.ts:35 → public.users 缺 UPDATE（行锁 FOR UPDATE，PG 对 FOR UPDATE/FOR NO KEY UPDATE 除 SELECT 外还要求 UPDATE 权限）；授权面现状：该表该权限未授任何列
```

关键读数：`coverage.problems.length === 0`（行锁**不占用列面**：删掉 `UPDATE(updated_at)` 不会造出列级缺口）+ `rowLocks.problems.length === 2`（`profile/service.ts:35`、`privacy/consent-pg.ts:75`）。登记两条行锁豁免后 `problems` 与 `staleExemptions` 都回到 0。

## 8. 门禁（逐条命令 + 退出码）

| # | 门禁命令 | exit | 末行／计数行 |
| --- | --- | --- | --- |
| 1 | `npm run lint` | 0 | `PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、`PASS 仓库卫生扫描`（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）⏎ `lint 通过（静态检查；不代表运行期或真实服务已通过）。` |
| 2 | `node tools/verify-release-materials.mjs` | 0 | `15/15 项通过（离线文档核验；不代表部署、云端或运行期已验收）` |
| 3 | `npm run test:docs` | 0 | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住` ⏎ `PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住` |
| 4 | `node tools/verify-contract-status.mjs` | 0 | `PASS: 中文表格一致` ⏎ `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` |
| 5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | `tests 6 / pass 6 / fail 0 / skipped 0` |
| 6 | `node --test --test-concurrency=1 tests/unit/sql-column-coverage.test.mjs` | 0 | `tests 15 / pass 15 / fail 0 / skipped 0` |
| 7 | `npm run test:unit` | 0 | `tests 3123 / pass 3122 / fail 0 / skipped 1` |
| 8 | `git diff --check`（工作树）＋ `git diff --cached --check`（暂存区，逐行核对新增行的空白）＋提交后 `git diff --check upstream/main...HEAD` | 0 | 三条均无输出 |
| 9 | 自检 `git status --porcelain` | 0 | 提交前只出现 `tests/unit/sql-column-coverage.test.mjs` 与 `docs/verification/gy-r28-sql-column-coverage-all-20261021.md` 两项；提交后为空（工作树干净）。`E:\GengYunCommander\.pg17\`（派单与交接目录）不在仓库内，不出现在 status |

计数是硬证据，时长只是参考：同一批命令在连续两轮里测得 gate 5 `144 / 414 ms`、gate 6 `4061 / 18970 ms`、gate 7 `66134 / 111531 ms`（机器负载不同），`pass/fail/skipped` 计数两轮完全一致。

门禁 2 的末行是一次 WSL 网络提示（工具探测 localhost 时的无害告警），真正的结论行是它上一行 `15/15 项通过（离线文档核验；不代表部署、云端或运行期已验收）`。

## 9. 未取得（明确的能力边界）

1. **不证明运行期可达性**：静态列面 ⊆ 授权面只说明「若这段 SQL 执行，权限够」，不说明它真的会被执行、也不说明部署脚本真的跑过。ledger 的 33 条缺口就是反例：授权文本存在、代码已接线、但角色组没部署。
2. **`SELECT *` 的列面不可判**：15 条语句（含 4 条 `t.*`）只计数、不产生列要求 —— 授权够不够看不出来。若把这些改成显式列清单，本守卫立刻能核对。逐条清单（`*` ＝ 裸星号，`t.*` ＝ 表别名星号）：

   ```
   services/api/src/knowledge/service.ts:76    *
   services/api/src/privacy/consent-pg.ts:46   t.*
   services/api/src/privacy/consent-pg.ts:126  t.*
   services/api/src/privacy/consent-pg.ts:140  t.*
   services/api/src/privacy/consent-pg.ts:160  *
   services/api/src/privacy/consent-pg.ts:165  t.*
   services/api/src/privacy/grant-pg.ts:47     *
   services/api/src/privacy/grant-pg.ts:64     *
   services/api/src/privacy/grant-pg.ts:71     *
   services/api/src/privacy/grant-pg.ts:74     *
   services/api/src/privacy/ledger-pg.ts:244   *
   services/api/src/privacy/ledger-pg.ts:425   *
   services/api/src/privacy/ledger-pg.ts:460   *
   services/api/src/privacy/ledger-pg.ts:477   *
   services/api/src/privacy/ledger-pg.ts:547   *
   ```


3. **`FOR UPDATE` 的「任列 UPDATE 即可」只对本仓已验证形态成立**：本守卫判「表级 UPDATE 或该表任意列 UPDATE 存在」即通过；PG 是否接受某个具体的列集合作锁载体（例如权限来自 `WITH GRANT OPTION` 的间接授权、或行级安全策略叠加）未在真实库上逐一验证。
4. **不覆盖 PL/pgSQL 函数体与数据库侧触发器**：`public.list_admin_accounts()` 的函数体里读什么列，本守卫看不见（只判「函数调用不是表访问」）。
5. **不覆盖 5 个既有 SQL 宿主**：`app.ts`、`auth/idempotency.ts`、`auth/store.ts`、`db/catalog.ts`、`db/migrate.ts` 只登记不审计（理由见 §4.3）。其中 `auth/store.ts` 已实测出 **2 条真实缺口**（`public.users.auth_epoch|UPDATE`、`public.users.revision|UPDATE`），**不属 ledger 范畴，按派单 §5 留给指挥裁定**（补授权另开片 or 静态豁免）。
6. **`catalog_read` 视图按表名当对象**：`catalog_read.current_knowledge` 只核对「整表 SELECT 已授」，不展开视图定义里的基表列。
7. **不连数据库**：不与真实 PG 的 `information_schema.role_column_grants` 比对，也不验证 `20-login-roles.sql` 是否真的被部署执行过。

## 10. 复现

```
cd E:\GengYunCommander\wt-r28-s66
node --test --test-concurrency=1 tests/unit/sql-column-coverage.test.mjs
```

测试输出逐行打印 §2 的全部读数（含逐文件字面量）、§5.2 的豁免条数、§7 五条负控制的红字原文。

## 11. 更正注记（`#379` 遗留修复后追加，2026-10-22）

**本页 §2「行锁要求」与 §5.2 里「`FOR SHARE` / `FOR KEY SHARE` 不需要额外权限」的旧口径已作废，请勿据此改守卫。**

旧表述的来源是当时的派单 §2.5，并据此把 16 处共享锁语句排除在行锁要求之外。**该口径与 PostgreSQL 17 手册不符。**PG 17 手册 SELECT 语句的 Description 一节对锁定子句写明：除 `SELECT` 之外，还需要目标表**至少一列**的 `UPDATE` 特权，且这句话同时适用于 `FOR NO KEY UPDATE`、`FOR UPDATE`、`FOR SHARE`、`FOR KEY SHARE` 四种强度。出处：<https://www.postgresql.org/docs/17/sql-select.html>（SELECT → Description，锁定子句那一段）。

更正后的判定：

| 行锁强度 | 除 `SELECT` 外是否要求 `UPDATE`（至少一列） |
| --- | --- |
| `FOR UPDATE` | **是** |
| `FOR NO KEY UPDATE` | **是** |
| `FOR SHARE` | **是**（原文写「否」，作废） |
| `FOR KEY SHARE` | **是**（原文写「否」，作废） |

影响面（合流树实测）：行锁要求 25 → **41**（+16 ＝ 树内 `FOR SHARE` 16 条、`FOR KEY SHARE` 0 条，落在 9 张表上）；`rowLocks` 分桶统计（25 `FOR UPDATE` / 16 `FOR SHARE`）与**列面读数不变**（行锁不占用列面）。真实授权面本来就给这 9 张表授了 `UPDATE`，所以真实基线的行锁缺口仍为 **0**。

要强调的是：这里改的是**判据变严**，不是读数变松 —— 旧口径下谁把 `UPDATE` 收回去，守卫看不见；现在会被逐条点名。不得为了让计数回到 25 而删除断言、放宽成「大于等于」或加豁免。

真库实证：本机 PostgreSQL 17.11 临时集群上，只授 `SELECT` 时 `FOR UPDATE` / `FOR SHARE` / `FOR KEY SHARE` 三种语句全部报 `42501`（`permission denied`）；补一条列级 `GRANT UPDATE (revision)` 后三种全部通过。

**当前口径以 `tests/unit/sql-column-coverage.test.mjs` 的行锁判定与 PG 17 官方文档为准**：本页 §2 的「行锁要求 19 条（另 16 处 `FOR SHARE` 按派单 §2.5 不要求额外权限）」以及 §5.2 表格中两行「否」，均不再代表现行守卫行为。

本注记只作追加更正，**未改动本页既有正文的任何一行**（避免漂动其他文档对它的行号引用）。
