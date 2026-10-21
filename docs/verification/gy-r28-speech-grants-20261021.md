# R28-S38 · 语音域运行时最小权限授权（迁移 0026 三表）

> 切片：R28-S38；分支 `fix/gy-r28-speech-grants`；基线 `fcb42e9`（= S20 语音持久化分支 head，含迁移 `0026_speech_persistence.sql`、`services/api/src/speech/store-pg.ts`、证据页 `gy-r28-speech-persist-20261021.md`）。
> 交付物：`deploy/postgres-cvm/sql/20-login-roles.sql` 段 K（L800-897）；`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 五处清单改动 + 两条新断言（#67/#68）；`deploy/postgres-cvm/evidence/probe-runtime-grants.sql` 第 [7] 节（L536-609）；本页。
> 问题一句话：迁移 0026 建了三张语音表，而 `20-login-roles.sql` 对 `speech_` / `transcriptions` 零命中 ⇒ 运行时角色 `gengyun_api_runtime` 对三表**整表零权限**，`store-pg.ts` 的每一次读/写都是 `42501`；90-assert 里这三张表既没有分类行、也没有探针，末行照样 `ok`（假绿）。

**取证范围声明**：本页所有读数来自**本机一次性 PG 17.11 集群**（`127.0.0.1:55648`，datadir `E:\GengYunCommander\.pg17\data-r28s38`），没有在真实 CVM、没有在 GitHub Actions runner 上跑过；`provision-db.sh` 本体没有执行（按它的顺序手工复现）。未取得项逐条列在 §12。

## 0. 结论摘要

| 项 | 改前（`fcb42e9` + 迁移 0026） | 改后（段 K） |
|---|---|---|
| 三张语音表的**表级** SELECT/INSERT/UPDATE/DELETE/TRUNCATE | 全 `f`（零权限） | 仍全 `f`；唯一例外是 `speech_idempotency` 的 `DELETE`（`t`） |
| 列级 `sel/ins/upd` 计数 | `0/0/0`、`0/0/0`、`0/0/0` | `12/12/5`、`13/13/8`、`6/6/2` |
| 14 条真语句形状（12 正向 + 2 禁止面） | 14 × `42501` | 12 条成功（零行或真行），2 条禁止面仍 `42501` |
| 90-assert 末行 | `ok`，但清单与探针里**根本没有这三张表**（假绿） | `ok`，前面多两条预期的 `42501`（禁止面） |
| 90-assert 断言数 | `78\|78\|0` | **`83\|83\|0`** |
| 缺 0026 时的部署行为 | 段 K 不存在 ⇒ 不报错 | 20-login-roles **exit 3**：`ERROR: 缺少语音域表：speech_idempotency（…）` |
| 变异 6 条（m1/m2/m3/m4/m5/m6） | — | 全部按预期判红；文件复原后 `sha256` 逐字节相等 |
| 门禁 5 道 | — | 全绿（§8） |

## 1. 范围

### 1.1 做了什么

1. `20-login-roles.sql` 追加段 K：缺表**硬前置**（`RAISE EXCEPTION`）→ `REVOKE ALL … FROM PUBLIC` → 三表逐列 `GRANT` → 表级 `GRANT DELETE`（仅 `speech_idempotency`）→ 三条摘要 `\echo`。
2. `90-assert-least-privilege.sql`：`domain_manifest` 加三行 `granted/true`；`expected` 加三行；`allow_table_dml` 加一行（12 → 13 个三元组）；#47 的元断言正则扩 `speech_` 与 `transcriptions$`；新增真执行探针块（15 条编号语句、账号内回滚）与两条断言 #67/#68。
3. `probe-runtime-grants.sql` 第 [7] 节：三表零行探针（12 条正向必须成功、2 条禁止面必须 `42501`）。
4. 本页 + 6 条变异实验 + 5 道门禁。

### 1.2 没做什么（边界）

- 没有改 `services/**`、`apps/**`、`packages/**`、迁移（含 0026）、`services/api/db/roles/*.sql`、`.github/workflows/*`、`tests/**`。
- 没有动 S24/S26/S28 的证据页与它们的授权段（H/I/J 段原样）。
- 没有删改任何既有断言：`expected` 与 `allow_table_dml` 只加行（末行补的尾逗号是机械改写，行内容不变），#47 的正则只扩不缩；#48 的 detail 本来就由 manifest 生成，无需改。
- 没有 push、没有打 tag、没有建 PR（指挥统一收口）。

## 2. 环境与取证方式

| 项 | 值 |
|---|---|
| 服务端 | PostgreSQL **17.11**（`E:\GengYunCommander\.pg17\pgsql\bin`） |
| 集群 | 一次性 `127.0.0.1:55648`，datadir `E:\GengYunCommander\.pg17\data-r28s38`，`initdb -U gengyun_cvm_owner -E UTF8 --locale=C --auth-host=scram-sha-256` |
| 引导身份 | `gengyun_cvm_owner`（`initdb -U` 建成 superuser；生产是 `CREATEROLE` 非 `SUPERUSER`，差异见 §12） |
| 起库方式 | `Invoke-CimMethod Win32_Process Create` 起 `postgres.exe`（不用 `pg_ctl start`、不用 `Start-Process -RedirectStandardOutput`） |
| 库 | `gengyun`，属主 `gengyun_cvm_owner` |
| 迁移 | `migrations=26`（0001…0026，末位 0026）；`node services/api/src/db/migrate.ts up` |
| 角色文件 | 按派单顺序应用五个：`auth_privacy`、`catalog_readers`、`consent_granter`、`profile_runtime`、`knowledge_runtime` |
| 运行时角色 | `gengyun_api_runtime`（属性与 SCRAM 口令由 90-assert #1/#2 校验通过） |
| 口令 | 一次性合成 48 位十六进制，只落 `.pg17/secrets-r28s38/db-credentials.env`；`20-login-roles.sql` 用 `\getenv` 从环境变量取，**不进 argv、不落在本页** |
| 客户端 | `psql` 17.11；`PGCLIENTENCODING=UTF8`；日志用 `ProcessStartInfo` 重定向并以 UTF-8（无 BOM）落盘 |

取证纪律：**真执行**（`SET LOCAL ROLE gengyun_api_runtime` 后发真语句），不靠 `has_table_privilege` 自证；写面探针要么零行、要么真行但整段 `ROLLBACK`（库里不留行）；`\set VERBOSITY verbose` 才带 SQLSTATE 与 `LOCATION`。

## 3. 改前

### 3.1 矩阵：三表整表零权限

把三表的运行时授权整表收回（复刻 `fcb42e9` 的零授权状态）后的读数（`matrix-zero-stdout.log`）：

| relation | sel_tbl | ins_tbl | upd_tbl | del_tbl | trunc_tbl | any_col | sel_n | ins_n | upd_n | public_tbl_acl | public_col_acl |
|---|---|---|---|---|---|---|---|---|---|---|---|
| public.speech_jobs | f | f | f | f | f | f | 0 | 0 | 0 | 0 | 0 |
| public.transcriptions | f | f | f | f | f | f | 0 | 0 | 0 | 0 | 0 |
| public.speech_idempotency | f | f | f | f | f | f | 0 | 0 | 0 | 0 | 0 |

列级明细三行全空（`sel_cols` / `ins_cols` / `upd_cols` 都是空串）。对照：同一矩阵里 S24/S26/S28 的二十一张表是「表级 `f` + 列级 `t`」——一眼能看出语音域**没被任何授权段覆盖**，而不是授权方式不同。

### 3.2 14 条真实语句形状逐条 `42501`

第 [7] 节的 14 条语句（12 正向 + 2 禁止面）在零授权状态下全部 `42501`（`probe-before-*`，行号是探针文件行号）：

| # | 语句 | 行 | 零授权下的结果 |
|---|---|---|---|
| 1 | `speech_jobs` SELECT 12 列 | 554 | `ERROR: 42501: permission denied for table speech_jobs` |
| 2 | `speech_jobs` INSERT 12 列 | 560 | 同上 |
| 3 | `speech_jobs` UPDATE 5 列 | 565 | 同上 |
| 4 | `speech_jobs` `SELECT … FOR UPDATE` | 566 | 同上 |
| 5 | `transcriptions` SELECT 13 列 | 571 | `… for table transcriptions` |
| 6 | `transcriptions` INSERT 13 列 | 577 | 同上 |
| 7 | `transcriptions` UPDATE 8 列 | 583 | 同上 |
| 8 | `speech_idempotency` SELECT 6 列 | 587 | `… for table speech_idempotency` |
| 9 | `speech_idempotency` 占位 INSERT | 591 | 同上 |
| 10 | `speech_idempotency` `ON CONFLICT DO NOTHING` | 595 | 同上 |
| 11 | `speech_idempotency` finalize UPDATE | 597 | 同上 |
| 12 | `speech_idempotency` release / purge 两条 DELETE | 600 | 同上 |
| 禁 1 | `speech_jobs` 整行 DELETE | 604 | 同上（此处不构成判据：它本来就该拒） |
| 禁 2 | `transcriptions` 整行 DELETE | 605 | 同上 |

合计 stderr 18 条：语音域 14 条 + S28 识别域禁止面 4 条（:527-530，与本片无关）。

### 3.3 改前 90-assert 是「假绿」

`assert-baseline-*`（在**尚未**写段 K、也**尚未**改 90-assert 时跑）：`SELECT 78` / 末行 `ok` / `ASSERT_TOTAL=78 ASSERT_OK=78`，stderr 只有 S28 的四条预期 `42501`。也就是说：**三张语音表整表零权限，78 条断言却全过**。原因是三层都没覆盖：

- `domain_manifest` 里没有 `speech_*` / `transcriptions` 行 ⇒ #47/#48/#66 都看不见它们；
- `expected` 里没有这三张表 ⇒ 数据驱动的 #49-58 不会生成 `runtime_grants_*`；
- 探针块只到 S28 识别域 ⇒ 没有一条语句会去碰语音表。

而 #47 的正则当时是 `^(messages$|community_|ocr_|recognition_|user_backup_copies$|deletion_|third_party_deletions$)`，连「表建了却没分类」这条元断言都点名不到语音域（`transcriptions` 更是不带 `speech_` 前缀）。这正是本片要堵的坑：**建表不授权、断言也看不见**。

### 3.4 4 列 vs 6 列：派单 §3 的矩阵在这张表上少了两列（实测）

派单 §3 给 `speech_idempotency` 的读面是 4 列（`request_hash, payload, pending, expires_at`）。按候选矩阵实测（`matrix-probe-A.sql` / `matrix-probe-B.sql`，单事务内授了再发语句）：

- **A 臂（SELECT 4 列）**：`speech_jobs` 与 `transcriptions` 全部通过，但 `speech_idempotency` 的**每一条**语句都 `42501`——`:143`（findIdempotent 的 SELECT）、`:154`（claim 的 INSERT）、`:170`、`:179`（finalize）、`:191`（release）、`:204`（purge）。
- **B 臂（SELECT 6 列）**：幂等台全部通过，唯一一条 stderr 是 `:170: error: no rows returned for \gset`——那是探针写法问题（`ON CONFLICT DO NOTHING RETURNING scope` 在**真冲突**分支返回 0 行，`\gset` 遇零行记一次 psql 错误），不是权限问题。

原因是三处都要 SELECT 权：`findIdempotent` 的 `WHERE scope = $1 AND key_hash = $2`、`claim` 的 `ON CONFLICT (scope, key_hash) … RETURNING scope`、`purge` 的 `WHERE expires_at <= … RETURNING scope`。**结论：SELECT 必须 6 列**（与 S28 的 `recognition_idempotency` 同形，见 `20-login-roles.sql:787-790` 的既有论断）。本页 §4.2 记录了对派单矩阵的这一处更正；不更正的话，本片防的正是它自己要犯的 `42501`。

## 4. 授权设计

### 4.1 列集从代码反推（不是从建表语句猜）

列清单逐列来自 `services/api/src/speech/store-pg.ts` 的真实语句：

| 表 | 读面（SELECT） | 写面（INSERT / UPDATE） | 依据 |
|---|---|---|---|
| `speech_jobs`（12 列） | 全部 12 列 | INSERT 12 列；UPDATE `revision, state, deadline_at, updated_at, error_code` | 列常量 `JOB_COLUMNS` :149-150；`INSERT_JOB` :154-156；`getJob` :460；`updateJob` 读回 :471、UPDATE :477-484；`commitTerminal` 的 `SELECT … FOR UPDATE` :496-499、UPDATE :517-523 |
| `transcriptions`（13 列） | 全部 13 列 | INSERT 13 列；UPDATE `revision, raw_text, uncertain_spans, confirmed_text, confirmed_at, model_version, updated_at, deleted` | 列常量 `RECORD_COLUMNS` :151-152；`INSERT_RECORD` :158-160；`getTranscription` :541；`updateTranscription` 读回 :553、UPDATE :566-576 |
| `speech_idempotency`（6 列） | 全部 6 列（见 §3.4/§4.2） | INSERT 6 列；UPDATE `payload, pending`；**表级 DELETE** | `findIdempotent` :601-604；`claimIdempotent` :627-631；`finalizeIdempotent` :641-645；`releaseIdempotent` :654；`purgeIdempotent` :660-662 |

`transcriptions` 的 UPDATE 是 8 列（含 `deleted` 软删与 `confirmed_*` 三列），比 `speech_jobs` 多——两张表的列集**不同**，不能照抄。

### 4.2 为什么 `speech_idempotency` 的 SELECT 是 6 列（对派单 §3 的更正）

派单 §3 写的是 4 列。§3.4 已实测：只授 4 列时，`findIdempotent`（`WHERE scope/key_hash`）、`claim`（`ON CONFLICT … RETURNING scope`）、`purge`（`WHERE expires_at … RETURNING scope`）全部 `42501`。PG 的规则是「语句里**读到的**列都要 SELECT 权」：`WHERE` 里的 `scope` / `key_hash`、`RETURNING` 里的 `scope` 都算。

因此段 K 授予 6 列，与同一张表在 S28 的同构兄弟 `recognition_idempotency` 完全同形（`20-login-roles.sql:787-790` 的注释写明了同样的理由）。这是本片**唯一**偏离派单矩阵的地方，已单列在报告里。

### 4.3 为什么 `SELECT … FOR UPDATE` 不另授 `UPDATE (revision)` 行锁载体

`commitTerminal` 在 `speech_jobs` 上发 `SELECT … FOR UPDATE`（:496-499），PG 要求「至少一列的 UPDATE 权」；而这张表本来就有**真实**的 UPDATE 列（`revision, state, deadline_at, updated_at, error_code`）⇒ 行锁由业务写权限满足，**不**另授 S26 那种 `UPDATE (revision)` 载体（性质不同，别照抄 I 段那句注释）。

`transcriptions` 上没有任何 `FOR UPDATE`（store 里只有普通 SELECT），因此它的 UPDATE 8 列纯粹是业务写面。

### 4.4 为什么 `DELETE` 只能给 `speech_idempotency`，而且必须是表级

PG 没有列级 `DELETE`。`store-pg.ts:654`（release，按 `(scope, key_hash)` 整行删）与 `:660-662`（purge，按 `expires_at` 批量删并 `RETURNING scope`）都是整行删除 ⇒ 只能表级授予。

`speech_jobs` / `transcriptions` **不授 DELETE**：账号注销走 `public.request_account_deletion()`（SECURITY DEFINER，以属主身份级联），两表的 `owner_user_id` 都是 `ON DELETE CASCADE`。

### 4.5 授权区形态（段 K，`20-login-roles.sql` L800-897）

- L801-840：注释块（为什么写在本文件而非 `roles/*.sql`；覆盖哪次迁移哪三张表；列清单的 `store-pg.ts` 行号；四档粒度 ①②③④）。
- L842：`\echo '--- K. 语音域（迁移 0026）列级授权（R28-S38）---'`。
- L846-857：缺表硬前置 `DO $$ … RAISE EXCEPTION '缺少语音域表：%（迁移 0026 未执行；顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。'`。
- L859-863：`REVOKE ALL ON TABLE public.speech_jobs, public.transcriptions, public.speech_idempotency FROM PUBLIC;`。
- L865-893：逐表 `GRANT SELECT/INSERT/UPDATE`（9 条）+ `GRANT DELETE ON public.speech_idempotency`（1 条）。
- L895-897：三条摘要 `\echo`（列级已授予 / DELETE 仅表级 / FOR UPDATE 与 SELECT 6 列的理由）。

### 4.6 刻意不授的六类

`TRUNCATE`、`REFERENCES`、`TRIGGER`、**表级** `SELECT`、**表级** `INSERT`/`UPDATE`、`speech_jobs`/`transcriptions` 的 `DELETE`。三表都对 `PUBLIC` 做了 `REVOKE ALL`。

## 5. 改后

### 5.1 `20-login-roles.sql` 执行

`apply20-final2-*`：exit=0，stdout 尾部是段 J 的三条摘要 + `--- K. 语音域（迁移 0026）列级授权（R28-S38）---` + 段 K 的三条摘要；stderr 只有 5 条 `NOTICE: role "gengyun_api_runtime" has already been granted membership in role …`（重复授予组角色，正常）。

### 5.2 矩阵（`matrix-final2-stdout.log`）：表级仍全 `f`，列级按设计

| relation | sel_tbl | ins_tbl | upd_tbl | del_tbl | trunc_tbl | any_col | sel_n | ins_n | upd_n | public_tbl_acl | public_col_acl |
|---|---|---|---|---|---|---|---|---|---|---|---|
| public.speech_idempotency | f | f | f | **t** | f | t | 6 | 6 | 2 | 0 | 0 |
| public.speech_jobs | f | f | f | f | f | t | 12 | 12 | 5 | 0 | 0 |
| public.transcriptions | f | f | f | f | f | t | 13 | 13 | 8 | 0 | 0 |

列级集合逐列展开（与 §4.1 的代码反推逐格一致）：

- `speech_jobs`：SELECT/INSERT = `id,revision,kind,owner_user_id,transcription_id,media_id,media_revision,state,deadline_at,created_at,updated_at,error_code`；UPDATE = `revision,state,deadline_at,updated_at,error_code`。
- `transcriptions`：SELECT/INSERT = `id,revision,owner_user_id,media_id,media_revision,raw_text,uncertain_spans,confirmed_text,confirmed_at,model_version,created_at,updated_at,deleted`；UPDATE = `revision,raw_text,uncertain_spans,confirmed_text,confirmed_at,model_version,updated_at,deleted`。
- `speech_idempotency`：SELECT/INSERT = `scope,key_hash,request_hash,payload,pending,expires_at`；UPDATE = `payload,pending`。

### 5.3 14 条形状（第 [7] 节）

`probe-after-*`：12 条正向语句**一条错误都没有**（零行结果即无输出），只剩 2 条禁止面：

```
psql:…/probe-runtime-grants.sql:604: ERROR:  42501: permission denied for table speech_jobs
psql:…/probe-runtime-grants.sql:605: ERROR:  42501: permission denied for table transcriptions
```

改前 18 条 → 改后 6 条（4 条 S28 + 本段 2 条），没有别的错误被吞掉。同一份文件在两次运行里 exit code 都是 0（`ON_ERROR_STOP=0` 是设计的一部分，判据是 stderr 的条数与内容）。

### 5.4 90-assert 实跑：末行 `ok`，83/83

`assert-final2-*`：

```
exit code     : 0
counted       : ASSERT_TOTAL=83 ASSERT_OK=83
verdict line  : ok
stderr lines  : 6
```

stderr 的 6 条是**预期**的禁止面 `42501`（S28 四条 :668/:674/:680/:686 + 本片两条 :910 `speech_jobs` / :916 `transcriptions`），不影响判决。

计数变体（把末段 `CASE` 换成 `count(*) FILTER (WHERE ok)` 汇总，源 `.pg17/r28s38-work/05-assert-count.ps1`，**不入库**）：`83|83|0`。78 → 83 的 +5 = `expected` 三行带来的三条数据驱动 `runtime_grants_speech_*` + 本片新增的 #67/#68。

### 5.5 判决块的容量读数

`stats-stdout.log`：`total=83 sum=2523 maxlen=50`（`sum(length(label)+2)`），远低于 `left(v_names, 4000)` 的截断上限。

## 6. 断言改动（`90-assert-least-privilege.sql`）

| # | 改动 | 位置 |
|---|---|---|
| E1 | `domain_manifest` 加三行 `('speech_jobs','granted',true)`、`('transcriptions','granted',true)`、`('speech_idempotency','granted',true)`（含「`transcriptions` 不带 `speech_` 前缀，所以 #47 的正则要同时加 `speech_` 与 `transcriptions$`」的注释） | L977-982 |
| E2 | `expected` 加三行：jobs `12/12/5`、transcriptions `13/13/8`、idempotency `6/6/2` + `del=true`；idempotency 那行上方注明「SELECT 是 6 列而不是 4 列」 | L1136-1161 |
| E3 | `allow_table_dml` 加 `('public','speech_idempotency','DELETE')`，12 → 13 个三元组 | L1183-1187 |
| E4 | #47 `runtime_domain_tables_classified` 的正则扩为 `^(messages$\|community_\|ocr_\|recognition_\|speech_\|transcriptions$\|user_backup_copies$\|deletion_\|third_party_deletions$)`；注释补「0026 的三张表必须被点名分类，否则旧坑复发」 | L1838-1851 |
| E5 | #49-58 头注释：从「S24 十表、S26 七表与本片四表」改成「含 S38 三表」 | #49-58 上方 |
| N1 | 新增真执行探针块（15 条编号语句：`speech_jobs` 5 条、`transcriptions` 3 条、`speech_idempotency` 5 条、禁止面 2 条；固定探针 UUID 前缀 `38a38a38-…`；整段 `BEGIN … ROLLBACK`） | L694-922 |
| N2 | **#67 `runtime_speech_dml_exec`**：17 个正向变量必须全是 `false` | L2092-2116 |
| N3 | **#68 `runtime_speech_forbidden_surface`**：2 个禁止面变量必须全是 `true` | L2118-2126 |

探针块的三个实现细节（都是踩过的坑）：

- **真行，不是零行**：0026 的 `CHECK`（`kind='transcription'`、`raw_text ≤ 8000`、`uncertain_spans` 是 jsonb 数组、`payload` 是 jsonb 对象）与外键只有在真行时才被求值；`ON CONFLICT … DO NOTHING` 也只有在**真冲突**时才走冲突分支。
- **`\gset` 只用在必然返回一行处**：`ON CONFLICT DO NOTHING RETURNING scope` 在冲突分支返回 0 行，`\gset` 会把 `:ERROR` 置 true（§3.4 的 B 臂实测）；因此 claim 与所有 SELECT 一律不用 `\gset`，只记 `\set v :ERROR`。
- **顺序有讲究**：幂等台的三段（seed → claim/finalize → release/purge）各自用独立键或过期行，保证 purge 只命中自己播种的那一行。

## 7. 变异实验

每条都走「施加 → 跑 → 判红原文 → 复原 → 复跑 `ok`」。文件基线（改后、变异前）：

- `20-login-roles.sql`：`F6CD0B877E92B3F5B3C180432E72D58C6FFAB0599CB18DC0BAC616C082B1BD38`（61 032 B / 897 行）
- `90-assert-least-privilege.sql`：`5A0FF287ACAECF5536A55461224EB7704DCF2FAF49C9EB8FB72183065216759D`（117 048 B / 2 160 行）
- `probe-runtime-grants.sql`：`6C9E95F4DA7DE46E24D2BE3B25A26452872629EBAB22D2D24454F3F699A0373A`（31 920 B / 611 行）

| 变异 | 施加 | 判红原文（`ERROR: 90-assert-least-privilege FAIL:` 后点名的断言） | 还原 |
|---|---|---|---|
| m1 | 库内 `REVOKE DELETE ON public.speech_idempotency FROM gengyun_api_runtime` | `2 条断言未通过：runtime_grants_speech_idempotency, runtime_speech_dml_exec` | `GRANT DELETE …` 复原 ⇒ `ok`（83/83） |
| m2 | 库内 `REVOKE UPDATE (deleted) ON public.transcriptions FROM gengyun_api_runtime` | `2 条断言未通过：runtime_grants_transcriptions, runtime_speech_dml_exec` | 复原 ⇒ `ok` |
| m3 | 文件：删 `domain_manifest` 的 `('speech_jobs','granted',true)` 行 | `1 条断言未通过：runtime_domain_tables_classified`（exit 3） | 从备份逐字节还原，`sha256` = `5A0FF2…759D`，`equal=true` ⇒ `ok` |
| m4 | 库内 `GRANT UPDATE ON public.speech_jobs TO gengyun_api_runtime`（表级） | `2 条断言未通过：runtime_grants_speech_jobs, table_dml_allowlist` | 见下方级联坑；复原后 ⇒ `ok` |
| m5 | 库内 `GRANT SELECT ON public.transcriptions TO PUBLIC` | `2 条断言未通过：knowledge_runtime_scope, public_no_privilege_domain_granted` | `REVOKE … FROM PUBLIC` ⇒ `ok` |
| m6 | 库内 `ALTER TABLE public.speech_idempotency RENAME TO speech_idempotency_r28tmp` 后跑 20-login-roles | **exit=3**：`ERROR: 缺少语音域表：speech_idempotency（迁移 0026 未执行；顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。` + `CONTEXT: PL/pgSQL function inline_code_block line 9 at RAISE` | 改回表名 ⇒ 20-login-roles exit=0 ⇒ `ok` |

**m4 的意外收获（值得写进下一次的教训）**：`REVOKE UPDATE ON public.speech_jobs FROM gengyun_api_runtime`（表级）会**连带撤掉列级 UPDATE 授权**（PG 把列级 ACL 存在 `pg_attribute.attacl`，表级 REVOKE 会同步处理它）。所以「施加 → REVOKE 表级」并不能把 m4 复原，第二次跑仍是 `runtime_grants_speech_jobs` 红；正确的复原方式是**重跑 20-login-roles.sql**（它按列重新 GRANT）。这也说明：授权段的幂等重跑是部署侧唯一的正确回滚手段。

m5 的附带红光 `knowledge_runtime_scope` 也是真的：`GRANT … TO PUBLIC` 会让**所有**角色（包括 `gengyun_knowledge_runtime`）可读该表，把「只应能读 `catalog_read.current_knowledge`」那条断言顶红。

## 8. 门禁

| 命令 | 退出码 | 末行/摘要 |
|---|---|---|
| `npm run lint` | 0 | `lint 通过（静态检查；不代表运行期或真实服务已通过）。`（tsc×2 + 仓库卫生扫描 PASS） |
| `node tools/verify-release-materials.mjs` | 0 | `15/15 项通过（离线文档核验；…）`（含「迁移 26 个（0001..0026），down 25 个」） |
| `npm run test:docs` | 0 | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住` + `PASS docs/research 结构校验` |
| `node tools/verify-contract-status.mjs` | 0 | `PASS: 语义可核 104 条区间 …` / `PASS: 纯行号区间 229 条 …` / `PASS: 中文表格一致`（另有 1 条 WARN：无锚点可疑引用 268 条，只计数不判红） |
| `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | `tests 6 / pass 6 / fail 0` |

## 9. 判红机制与 psql 退出码（继承自 #345）

- 全绿：判决行 `ok`，`DO` 块静默，psql **exit 0**。
- 有失败：判决行 `FAIL: <label> (<detail>); …`，随后 `DO` 块 `RAISE EXCEPTION '90-assert-least-privilege FAIL: % 条断言未通过：%'` ⇒ psql **exit 3**，stderr 里带 `FAIL` 与失败断言名。本片没有改这条机制（#345 已合入 main）。
- 探针段仍是 `ON_ERROR_STOP off` + `SAVEPOINT` + `\set v :ERROR` + `ROLLBACK TO SAVEPOINT`：正向语句的 `42501` 不会中断脚本，而是变成 #67 的一个 `true`。

## 10. 复现步骤（本机，不含口令）

```text
1) initdb -U gengyun_cvm_owner -E UTF8 --locale=C --auth-host=scram-sha-256
   （datadir 自定；postgresql.conf 里 port=55648、listen_addresses='127.0.0.1'）
2) 起库（Windows 用 Win32_Process Create，不用 pg_ctl start）
3) createdb gengyun（owner=gengyun_cvm_owner）
4) DATABASE_URL=… node services/api/src/db/migrate.ts up        # 已应用 0001…0026
5) 按顺序 psql -f services/api/db/roles/{auth_privacy,catalog_readers,consent_granter,
   profile_runtime,knowledge_runtime}.sql
6) GENGYUN_API_RUNTIME_PASSWORD=<48 位小写 hex> psql -f deploy/postgres-cvm/sql/20-login-roles.sql
   （口令走环境变量 + \getenv，绝不进 argv）
7) psql -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql    # 末行必须是 ok、exit 0
8) psql -f deploy/postgres-cvm/evidence/probe-runtime-grants.sql    # 只应有 6 条预期 42501
```

## 11. 为什么既有测试没发现

- `tests/integration/speech-pg.mjs` 连库用**库 owner** 身份，文件头自己写着「运行时角色直连会 42501；本脚本用库 owner 取证，只证明迁移与 store 语义，不证明线上角色已授权」。它证明的是「表在、CAS 语义对」，**不证明**「运行时角色能不能发这些语句」。
- 90-assert 之前对语音域**既没有分类行也没有探针**，`ok` 只能证明「已登记的域没问题」，不能证明「没登记的域不存在」。
- 仓内没有「以 `gengyun_api_runtime` 身份跑语音域真实语句」的测试；本片的 15 条探针 + #67/#68 就是补这个洞的最小可回归形态（不依赖 ASR/TTS 提供者与媒体端口）。

## 12. 未取得

1. **真实 CVM / 生产 PG 未跑**：本页所有读数来自本机一次性集群；没有部署、没有连接真实 CVM。
2. **GitHub Actions runner 未跑**：本片没有任何 CI 读数。
3. **`provision-db.sh` 本体未跑**：按其顺序手工复现（bash 脚本未在本机执行）。
4. **`tests/integration/speech-pg.mjs` 未跑**：它要另建空库 + `SPEECH_PG_TEST_URL`，且以 owner 身份执行、ACL 对它不生效；本片以 90-assert 的 `SET LOCAL ROLE` 探针替代（理由见 §11）。
5. **真并发锁争用未测**：只证明 `speech_jobs` 的 `SELECT … FOR UPDATE` 形状被授权；没有两个会话同时 `commitTerminal` 的行锁等待/超时读数。
6. **账号硬删除的级联未演练**：三表 `owner_user_id` 的 `ON DELETE CASCADE` 是结构声明，本片没做「删 `users` 行 ⇒ 三表行消失」的真删除演练。
7. **非超级用户 owner 引导未测**：本机 owner 是 `initdb -U` 的 superuser；生产 `CREATEROLE` 非 `SUPERUSER` 时，`REVOKE ALL … FROM PUBLIC` 与列级 `GRANT` 的属主前提未在本机复现。
8. **全量测试套件未跑**：只跑派单 §5 的五道门禁（本片不触碰 `services/**`）。
9. **PUBLIC 默认权限的真实差异未测**：本机 `public_tbl_acl`/`public_col_acl` 全 0；若生产开了 `ALTER DEFAULT PRIVILEGES`，本片的 `REVOKE ALL … FROM PUBLIC` 是唯一兜底，但本机无法覆盖那种差异。
10. **派单 §3 的 4 列矩阵未回写派单文件**：本片只在本页与段 K 注释里记录「改成 6 列」的理由（派单文件不在可改范围内）。
11. **`\gset` 零行行为的完整清单未做**：只在本片遇到的 `ON CONFLICT DO NOTHING` 上实测（§3.4），没有系统性枚举 store 里所有可能返回零行的语句。

## 13. 派单对应表

| 派单条目 | 落点 |
|---|---|
| §1 段 K（缺表硬守卫 → REVOKE PUBLIC → 逐列 GRANT → 摘要） | §4.5；文件 L800-897（m6 验证守卫） |
| §1 `90-assert` 五处清单改动 | §6 E1-E5 |
| §1 真行探针 + 断言 | §6 N1-N3；§5.3/§5.4 |
| §1 探针文件续号 | §5.3（第 [7] 节，L536-609） |
| §2 授权矩阵 | §4.1（逐列）；§5.2（实跑读数） |
| §3 矩阵与行号复核 | §3.4/§4.2（**一处更正：SELECT 4 → 6 列**）；§4.1（行号逐条重核） |
| §4 变异 5 条 | §7 m1-m5（另加 m6 守卫） |
| §5 门禁 5 道 | §8 |
| §6 证据页要求 | 本页 §0-§13 |
