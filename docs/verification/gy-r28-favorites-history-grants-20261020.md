# R28-S26 运行时最小权限授权取证（favorites / history / conversations 七张表）

- 任务：CVM 部署里运行时 `gengyun_api_runtime`（LOGIN）对 `0018_favorites_history.sql` 的
  `favorites` / `history` / `favorites_idempotency` / `history_idempotency`、以及
  `0013_conversations.sql` 的 `conversations` / `conversation_turns` / `conversation_answers`
  **整张零授权** ⇒ 生产上收藏、历史、对话三个域的所有读写都会 `42501`
  （`services/api/src/favorites/store-pg.ts:45-52` 会把它折成 `PROVIDER_UNAVAILABLE` + `retryable:true`，
  所以线上看到的是「永久 503 且标可重试」，不是一眼可见的权限错）。
- 基线：`7168096`（分支 `fix/gy-r28-favorites-history-grants`，= S24 分支 tip）。
- 落地物：
  - [`deploy/postgres-cvm/sql/20-login-roles.sql`](../../deploy/postgres-cvm/sql/20-login-roles.sql)
    新增 `I` 段（`-- --- I. 运行时域（收藏／历史／对话）的列级授权（R28-S26 / 迁移 0013·0018）`）：
    七张表的列级 `SELECT`/`INSERT`/`UPDATE` + 六张表的表级 `DELETE` + 3 条 `\echo`。
  - [`deploy/postgres-cvm/sql/90-assert-least-privilege.sql`](../../deploy/postgres-cvm/sql/90-assert-least-privilege.sql)
    追加 35 条零行真执行探针、`domain_manifest` 8 行、`expected` 7 行、5 条新断言；
    并把第 7 条断言的允许清单从内联 `VALUES` 提成 CTE（**既有断言被扩展，见 §6/§7.2**）。
  - [`deploy/postgres-cvm/evidence/probe-runtime-grants.sql`](../../deploy/postgres-cvm/evidence/probe-runtime-grants.sql)
    新增第 5 节（七张表的零行真执行探针，改前/改后都能跑）。
- **取证范围声明**：全部读数来自**本机一次性 PG 17.11 集群**（`127.0.0.1:55640`）。
  **没有在真实 CVM 上演练，也没有在 GitHub runner 上跑过**；凡是没跑到的，第 12 节逐条写「未取得」。
  原始日志：`.pg17/handoff/r28-s26-logs/`（39 个文件，改前/改后/变异各一份）。

## 0. 结论摘要

| # | 结论 | 证据 |
| --- | --- | --- |
| 1 | 改前七张表**整张零授权**：表级权限矩阵 7 表 × 6 种权限全 `f`、`relacl` 里没有运行时、列级 ACL 0 条 | §3.1 |
| 2 | 改前 27 条真实语句形状（`SET ROLE gengyun_api_runtime`）→ **27 行 `42501`**，逐条一一对应、零成功 | §3.2 |
| 3 | 同一会话的对照臂照常可读（`feature_flags_rows=3`）⇒ 证明是「没授权」，不是「连不上」 | §3.3 |
| 4 | 改前 `90-assert` 在本机**输出 `FAIL`**（不是 S24 那种假绿，而是 `0025` 之后的继承红） | §3.4 / §8 |
| 5 | 改后同一批 27 条语句**全部成功且零行**（无一条 `42501`） | §5.1 |
| 6 | 改后 `90-assert` 末行 `ok`；实测**71 条断言全 ok、0 条红** | §5.2 / §6 |
| 7 | 6 条变异（多授/漏授/元断言/两条既有断言扩展）**全部判红**，逐条还原后回 `ok`，文件级变异给 `sha256` 相等 | §7 |
| 8 | `conversation_answers` 不需要 `DELETE`：`0013:105` 的 `ON DELETE CASCADE` + 实测「运行时删 turn ⇒ answers 归零」 | §4.5 |
| 9 | `SELECT … FOR UPDATE` / `FOR SHARE` 需要 `UPDATE` 权 ⇒ 三张表各给 `UPDATE (revision)`，**仅作行锁载体** | §4.3 |
| 10 | `recognition_selections`（迁移 `0025`）是**继承缺口**，本片只加 `forbidden` 行让断言可复跑，不修 | §8 |
| 11 | 反向控制（事务内阶梯）：撤光授权 ⇒ 4 条语句全 `42501`；逐条加回列级 `SELECT`／`INSERT`／`UPDATE (revision)`／表级 `DELETE` ⇒ 对应语句逐条通，`ROLLBACK` 后 ACL 与改前一致 | §7.5 |

## 1. 范围

**做了**：七张表的列级授权、六张表的表级 `DELETE` 例外、`90-assert` 的正向（真执行）与反向（`PUBLIC`）
断言、新域元断言、零行探针、6 条变异、部署顺序复现、门禁自跑。

**没做**（本片范围外，见 §12）：`services/**` 任何改动、迁移任何改动、`services/api/db/roles/*.sql`
任何改动、`tests/**` 任何改动、S24 证据页任何改动、`recognition_*` 四张表的授权（§8）、真实 CVM 演练、
GitHub runner 实跑。

## 2. 环境

| 项 | 值 |
| --- | --- |
| 服务端 | `PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit` |
| 客户端 | `psql (PostgreSQL) 17.11`（`E:\GengYunCommander\.pg17\pgsql\bin`） |
| 集群 | 本机一次性集群 `127.0.0.1:55640`，datadir `.pg17/data-r28s26`，`--auth-local=trust --auth-host=scram-sha-256`，`-E UTF8 --locale=C` |
| 引导身份 | `initdb -U gengyun_cvm_owner` ⇒ 集群属主**就是超级用户**（与 `deploy/postgres-cvm/install-postgres.sh:461` 一致；`provision-db.sh:384` 也写明「超级用户，仅运维使用」） |
| 库 | `gengyun`，属主 `gengyun_cvm_owner` |
| 迁移 | `npm run db:migrate --workspace @gengyun/api`（真 CLI，`DATABASE_URL` 指向本集群）⇒ `已应用：0001 … 0025`，`migrations=25`、`public_tables=66` |
| 角色文件 | `services/api/db/roles/` 的 8 个全部执行成功（含 `source_operator` / `staging_importer`） |
| 运行时 | `gengyun_api_runtime`（`LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`），成员：`gengyun_auth_privacy, gengyun_consent_granter, gengyun_knowledge_runtime, gengyun_preview_reader, gengyun_profile_runtime` |

一次性口令由本机脚本生成（48 位小写十六进制），只写进 `.pg17/tmp/r28-s26/*_pw.txt`，
**不打印、不入库、不提交**；本页不出现任何口令。集群与口令都与任何真实环境无关。

## 3. 改前必红（读数原文）

对象：**改前**的数据库 = 迁移 0001–0025 + 8 个组角色 + **改前的** `20-login-roles.sql`（只有 A–H 段）
+ 改前的 `90-assert`。原始日志 `.pg17/handoff/r28-s26-logs/`。

### 3.1 表级权限矩阵（改前）

查询：`has_table_privilege('gengyun_api_runtime', 'public.<t>', <priv>)` ×
`{SELECT, INSERT, UPDATE, DELETE, TRUNCATE}` + `has_any_column_privilege` + `relacl`/`attacl` 计数。
原始输出 `matrix-prefix.log`。

| 表 | SELECT | INSERT | UPDATE | DELETE | TRUNCATE | 任一列权限 | `relacl` 含运行时 | 有 ACL 的列数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `favorites` | f | f | f | f | f | f | f | 0 |
| `favorites_idempotency` | f | f | f | f | f | f | f | 0 |
| `history` | f | f | f | f | f | f | f | 0 |
| `history_idempotency` | f | f | f | f | f | f | f | 0 |
| `conversations` | f | f | f | f | f | f | f | 0 |
| `conversation_turns` | f | f | f | f | f | f | f | 0 |
| `conversation_answers` | f | f | f | f | f | f | f | 0 |

同一张矩阵里 S24 已修好的域恰好是另一种形状（对照：`messages` / `community_posts` / `ocr_jobs` /
`user_backup_copies` 均 `sel_tbl=f, sel_col=t, del=f`）⇒ 「列级已授、表级不可见」是**正常形态**，
七张表的「表级 f + 列级也 f」才是**整张零授权**。

### 3.2 真执行探针（`SET ROLE gengyun_api_runtime`，27 条真实语句形状，零行）

探针文件：`E:\GengYunCommander\.pg17\tmp\r28-s26\probe-phase1.sql`；原始输出
`.pg17/handoff/r28-s26-logs/phase1-prefix.log`（98 行）。每条语句都是 store 里**逐字**的形状，
只是把 `$n` 换成字面量、并加上 `WHERE false` 保证零行。`ON_ERROR_STOP=0` ⇒ 27 条**全部**跑到。

| # | 探针标签（原文） | 改前读数 |
| --- | --- | --- |
| 1 | favorites — SELECT 7 列（`FAVORITE_COLUMNS`, `favorites/store-pg.ts:68`） | `42501 permission denied for table favorites` |
| 2 | favorites — INSERT 7 列 … `ON CONFLICT DO NOTHING RETURNING id`（`store-pg.ts:187-190`） | 同上 |
| 3 | favorites — `DELETE … RETURNING id`（`store-pg.ts:167` / `:248`） | 同上 |
| 4 | favorites — `SELECT … FOR UPDATE`（`store-pg.ts:233`） | 同上 |
| 5 | favorites_idempotency — SELECT 4 列（`IDEMPOTENCY_COLUMNS`, `store-pg.ts:69` / `:286` / `:366`） | `42501 … for table favorites_idempotency` |
| 6 | favorites_idempotency — `INSERT … ON CONFLICT DO UPDATE RETURNING scope`（`store-pg.ts:316-324`） | 同上 |
| 7 | favorites_idempotency — `UPDATE … RETURNING scope`（`store-pg.ts:344-347`） | 同上 |
| 8 | favorites_idempotency — `DELETE …`（`store-pg.ts:171-175` / `:295` / `:356`） | 同上 |
| 9 | history — SELECT 11 列（`HISTORY_COLUMNS`, `history/store-pg.ts:63-65`） | `42501 … for table history` |
| 10 | history — INSERT 11 列 `ON CONFLICT DO NOTHING RETURNING id`（`store-pg.ts:176-181`） | 同上 |
| 11 | history — `DELETE … RETURNING id`（`store-pg.ts:155` / `:250-251`） | 同上 |
| 12 | history — `SELECT … FOR UPDATE`（`store-pg.ts:237`） | 同上 |
| 13 | history_idempotency — SELECT 4 列（`store-pg.ts:287` / `:362`） | `42501 … for table history_idempotency` |
| 14 | history_idempotency — `INSERT … ON CONFLICT DO UPDATE RETURNING scope`（`store-pg.ts:315-323`） | 同上 |
| 15 | history_idempotency — `UPDATE … RETURNING scope`（`store-pg.ts:342-345`） | 同上 |
| 16 | history_idempotency — `DELETE …`（`store-pg.ts:159-161` / `:295` / `:353`） | 同上 |
| 17 | conversations — SELECT 6 列（`CONVERSATION_COLUMNS`, `conversations/store-pg.ts:87`） | `42501 … for table conversations` |
| 18 | conversations — INSERT 6 列 `RETURNING` 6 列（`store-pg.ts:222-224`） | 同上 |
| 19 | conversations — `DELETE … RETURNING id`（`store-pg.ts:269` / `:432`） | 同上 |
| 20 | conversations — `SELECT … FOR UPDATE`（`store-pg.ts:260`） | 同上 |
| 21 | conversation_turns — SELECT 14 列（`TURN_COLUMNS`, `store-pg.ts:88-90`） | `42501 … for table conversation_turns` |
| 22 | conversation_turns — INSERT 13 列（无 `answer_id`）`RETURNING` 14 列（`store-pg.ts:282-286`） | 同上 |
| 23 | conversation_turns — `UPDATE (job_state, job_error_code, answer_id, revision, updated_at) RETURNING` 14 列（`store-pg.ts:361-364` / `:403-407`） | 同上 |
| 24 | conversation_turns — `DELETE … RETURNING id`（`store-pg.ts:351`） | 同上 |
| 25 | conversation_turns — SELECT 14 列 `FOR UPDATE`（`store-pg.ts:342-343`） | 同上 |
| 26 | conversation_answers — SELECT 14 列（`ANSWER_COLUMNS`, `store-pg.ts:91-93`） | `42501 … for table conversation_answers` |
| 27 | conversation_answers — INSERT 14 列 `RETURNING id`（`store-pg.ts:376-380`） | 同上 |

报错原文（三者逐字相同，只有表名不同）：

```
psql:E:/GengYunCommander/.pg17/tmp/r28-s26/probe-phase1.sql:16: ERROR:  42501: permission denied for table favorites
LOCATION:  aclcheck_error, aclchk.c:2845
```

`LOCATION` 恒为 `aclcheck_error, aclchk.c:2845`（PG 17.11 的 ACL 检查点）⇒ 是权限判定，不是语法或连接问题。

### 3.3 对照臂（同一角色、同一会话）

```
 user_backup_copies_rows      feature_flags_rows
-------------------------     --------------------
                       0                        3
```

`gengyun_api_runtime` 能连库、能读 S24 已授权的 `user_backup_copies`（0 行）与 `feature_flags`（3 行）
⇒ §3.2 的 27 行 `42501` 只可能是「这七张表没授权」。

### 3.4 改前的 `90-assert` 在本机是 `FAIL`（不是假绿）

改前的 `90-assert` 在**本片这个装到 0025 的库**上实跑（`assert-prefix.log`，439 B）：

```
提示：检测到 recognition_*（迁移 0025）表存在，但本分支的 sql/20-login-roles.sql 尚未为其授权，
      运行时访问这些表会 42501。授权草案与取舍见 docs/verification/gy-r28-least-privilege-grants-20261020.md。
FAIL: runtime_domain_tables_classified (运行时域的每张表必须进分类清单（granted/granted_external/forbidden）；新增表既不授权也不声明 forbidden ⇒ 失败)
```

两点必须说清：
1. 这条 `FAIL` **不是本片七张表引起的**（S24 的正则 `^(messages$|community_|ocr_|recognition_|user_backup_copies$|deletion_|third_party_deletions$)` 根本不含 `favorites|history|conversation`）——
   它是 `0025_recognitions_persistence.sql` 的 `recognition_selections` 造成的**继承红**（§8）。
2. 也就是说「改前 `90-assert` 输出 `ok`」这个说法在**装了 0025 的库**上不成立；S24 那次是假绿是因为它只装到 0024。

## 4. 授权设计（粒度与理由）

### 4.1 落点：为什么写在 `20-login-roles.sql` 而不是 `services/api/db/roles/*.sql`

`deploy/postgres-cvm/provision-db.sh` 只在 `pg_roles` 里**还没有**这些 NOLOGIN 组时才跑
`services/api/db/roles/*.sql`；而 `20-login-roles.sql` 每次部署都会跑。授权若写进 `roles/*.sql`，
对已存在的库永远不会生效。本段与既有的 G（`user_backup_copies`）、H（messages/community/ocr）段同一条理由。

授权对象是**登录角色本身**（`gengyun_api_runtime`），不经组角色：这些权限是运行时自己的域权限，
不该被其它组（如 `gengyun_auth_privacy`）的成员顺带继承。

### 4.2 七张表的授权清单（列级）

| 表 | SELECT（列） | INSERT（列） | UPDATE（列） | DELETE |
| --- | --- | --- | --- | --- |
| `favorites` | 7 = 全部 | 7 = 全部 | `revision`（仅行锁） | 表级 |
| `history` | 11 = 全部 | 11 = 全部 | `revision`（仅行锁） | 表级 |
| `conversations` | 6 = 全部 | 6 = 全部 | `revision`（仅行锁） | 表级 |
| `conversation_turns` | 14 = 全部 | 13（**不含 `answer_id`**，store 的 INSERT 从不写它） | 5 = `job_state, job_error_code, answer_id, revision, updated_at` | 表级 |
| `conversation_answers` | 14 = 全部 | 14 = 全部 | **无** | **无** |
| `favorites_idempotency` | 6 = 全部 | 6 = 全部 | 4 = `request_hash, response_status, outcome, expires_at` | 表级 |
| `history_idempotency` | 6 = 全部 | 6 = 全部 | 4 = 同上 | 表级 |

三档粒度的依据（每条都是实测，不是推断）：
- **读面按列**，且 `DELETE`/`UPDATE` 的 `WHERE`、`RETURNING` 引用列也必须有 `SELECT` 权。
  两张幂等台账的 `SELECT` 必须是**全部 6 列**：`ON CONFLICT (scope, key_hash) … WHERE … RETURNING scope`
  在只有 `SELECT(request_hash, response_status, outcome, expires_at)` 时直接 `42501`
  （`experiment-locking.sql:67`，实测）。
- **写面按列**：`INSERT`/`UPDATE` 只给真实语句出现过的列；`conversation_turns` 的 `INSERT`
  一个 `answer_id` 都不写，所以不给。
- **`DELETE` 在 PG 里没有列级形式** ⇒ 六张表只能表级给（§4.4）。

### 4.3 `UPDATE (revision)` 只是行锁载体（实验原文）

`favorites` / `history` / `conversations` 的 store 里**没有任何 `UPDATE` 语句**，但都有
`SELECT … FOR UPDATE`。而 PG 的行锁要求 `UPDATE` 权：

```
=== 实验 1：只有列级 SELECT（无任何 UPDATE）⇒ SELECT ... FOR UPDATE 能否过 ===
--- 1a 普通 SELECT（应成功）
(0 rows)
--- 1b SELECT ... FOR UPDATE（观察是否 42501）
psql:…/experiment-locking.sql:17: ERROR:  42501: permission denied for table favorites
--- 1c SELECT ... FOR SHARE（观察）
psql:…/experiment-locking.sql:21: ERROR:  42501: permission denied for table favorites

=== 实验 2：列级 SELECT + 列级 UPDATE(revision) ⇒ SELECT ... FOR UPDATE ===
--- 2a FOR UPDATE（列级 UPDATE 是否够）
(0 rows)          ← 成功
--- 2b FOR SHARE
(0 rows)          ← 成功
```

⇒ `FOR UPDATE` 与 `FOR SHARE` **都要 `UPDATE` 权**，而列级的 `UPDATE (revision)` 就够。
`has_column_privilege` 的前后读数与上面一致（`revision`/`UPDATE`：实验前 `f`、加授后 `t`）。
原始日志 `.pg17/handoff/r28-s26-logs/experiment-locking.log`。实验每块开头先 `REVOKE ALL` 归零，
所以结论与集群当时已授的权限无关；全程 `ROLLBACK`，不改集群。

**口径**：这三处写的是 `GRANT UPDATE (revision)`，注释里三次都写明「仅服务 `SELECT … FOR UPDATE/FOR SHARE`
行锁，不是业务写权限」；`90-assert` 的 `expected.upd` 里同样只有 `revision`（§6）。

### 4.4 六张表的表级 `DELETE`（每条都有代码出处）

| 表 | 代码出处（`DELETE FROM …` 原文所在行） |
| --- | --- |
| `favorites` | `favorites/store-pg.ts:167` `DELETE FROM favorites WHERE owner_id = $1::uuid RETURNING id`；`:248` `DELETE FROM favorites WHERE id = … AND owner_id = … AND revision = … RETURNING id`（CAS 删除，`0018` 的正文表是物理删除） |
| `favorites_idempotency` | `favorites/store-pg.ts:171`（按 `scope` 前缀清主体台账）、`:295`（过期清理）、`:356`（claim 释放） |
| `history` | `history/store-pg.ts:155`（注销清空）、`:250`（CAS 删除） |
| `history_idempotency` | `history/store-pg.ts:159`（按主体前缀清）、`:295`（过期清理）、`:353`（claim 释放） |
| `conversations` | `conversations/store-pg.ts:269`（CAS 删除）、`:432`（注销清空） |
| `conversation_turns` | `conversations/store-pg.ts:351`（CAS 删除） |

PG 没有列级 `DELETE`，所以这六张只能是表级；`TRUNCATE` / `REFERENCES` / `TRIGGER` 一律不给，
表级 `INSERT` / `UPDATE` 也一律不给（由断言第 7 条的结构化允许清单兜住，§6）。

### 4.5 `conversation_answers` 为什么**不需要** `DELETE`

约束原文（`services/api/db/migrations/0013_conversations.sql`）：

```
:105   turn_id  uuid  NOT NULL REFERENCES conversation_turns (id) ON DELETE CASCADE,
:64    conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
:128   FOREIGN KEY (answer_id) REFERENCES conversation_answers (id) ON DELETE SET NULL;
```

`answers` 的行只随 `conversation_turns` 的删除级联消失，级联由**外键属主**（`gengyun_cvm_owner`）执行，
运行时不需要 `answers` 的 `DELETE` 权。实测（`probe-cascade.sql`，日志 `cascade.log`，
真实行、单事务、末尾 `ROLLBACK`）：

```
users_before = 0
（夹具 user）→ 运行时 INSERT conversation / turn / answer：
 turns_before | answers_before
            1 |              1
运行时 DELETE FROM conversation_turns WHERE id = … RETURNING id      → 成功返回 id
 answers_after
             0                                                        ← 级联生效
反向控制：DELETE FROM public.conversation_answers WHERE false RETURNING id
 → psql:…/probe-cascade.sql:59: ERROR:  42501: permission denied for table conversation_answers
   LOCATION:  aclcheck_error, aclchk.c:2845
users_after = 0                                                       ← 事务回滚，零残留
```

### 4.6 授权区形态

`20-login-roles.sql` 的 I 段（661→686 行）依次是：
`DO $$ … to_regclass(NULL) ⇒ RAISE EXCEPTION '缺少运行时域表：%（迁移 0013 / 0018 未执行；顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。'`
→ `REVOKE ALL ON TABLE public.favorites, …, public.conversation_answers FROM PUBLIC`
→ 每表按 §4.2 的 `GRANT`（逐条带一行注释写清依据）
→ 3 条 `\echo`（列级摘要 / 表级 DELETE 摘要 / `UPDATE (revision)` 只是行锁载体）。

## 5. 改后绿读数

对象：同一集群，重跑改后的 `20-login-roles.sql`（`post-change-grant.log`，11 条 `\echo` 全部打印，
含新增 3 条；5 条 `NOTICE: role "gengyun_api_runtime" has already been granted membership in role …`
是既有 C 段的幂等提示）。

### 5.1 同一批 27 条语句形状：全部成功、零行

`phase1-postfix.log`（152 行）：27 个探针全部成功，没有任何 `ERROR`/`42501` 行，每条都是 `(0 rows)` /
`INSERT 0 0` / `UPDATE 0` / `DELETE 0`。对照臂不变（`user_backup_copies_rows=0`、`feature_flags_rows=3`）。

### 5.2 `90-assert`：末行 `ok`

```
提示：检测到 recognition_*（迁移 0025）表存在，但本分支的 sql/20-login-roles.sql 尚未为其授权，
      运行时访问这些表会 42501。授权草案与取舍见 docs/verification/gy-r28-least-privilege-grants-20261020.md。
ok
```

（`assert-postfix.log`。识别域那条是 S24 的**软守卫**，不是失败；§8 说明为什么保留。）

点数（把收尾的 `SELECT CASE … FROM checks` 换成计数查询后实跑，`assert-count.log`）：

```
 total_checks | ok_checks | bad_checks
            71 |        71 |          0
```

### 5.3 库内表级 DML 清单（改后）

`probe-runtime-grants.sql` 第 4 节（`RESET ROLE` 后全库扫描）现在正好 10 行，
与允许清单 11 个三元组一致（`idempotency_keys` 同时有 `INSERT` 与 `DELETE`）：

```
 community_idempotency | ins=f upd=f del=t
 community_likes       | ins=f upd=f del=t
 conversation_turns    | ins=f upd=f del=t
 conversations         | ins=f upd=f del=t
 favorites             | ins=f upd=f del=t
 favorites_idempotency | ins=f upd=f del=t
 history               | ins=f upd=f del=t
 history_idempotency   | ins=f upd=f del=t
 idempotency_keys      | ins=t upd=f del=t
 ocr_idempotency       | ins=f upd=f del=t
```

## 6. 断言改动：既有断言被扩展 2 处 + 新增 5 条

### 6.1 既有断言被扩展（指挥裁决后必须单列）

| # | 断言 | 改前 | 改后 | 为什么必须改 |
| --- | --- | --- | --- | --- |
| E1 | 第 7 条 `table_dml_allowlist`（`:391-416`） | 内联 `FROM (VALUES …5 个三元组…) AS allow(sch,tbl,priv)`，`detail` 是一句手写中文 | 三元组提成 CTE `allow_table_dml(sch, tbl, priv) AS (VALUES …11 行…)`，内层 `FROM allow_table_dml allow`，`detail` 改成 `'表级写权限只允许 ' \|\| string_agg(format('%s{%s}', a.tbl, a.priv), '、' ORDER BY a.tbl, a.priv) \|\| '；清单外的表或类型一律失败（其余全部按列授予）'` | 本片新增 6 个表级 `DELETE`；手写 `detail` 会与清单漂移，改成从同一份 `VALUES` 生成 ⇒ 提示永远列全 |
| E2 | `domain_manifest`（`:224-247`） | 18 行（10 granted + 1 granted_external + 4 forbidden + 3 recognition forbidden） | 26 行（18 + 7 张本片表 granted + `recognition_selections` forbidden） | 新表必须被分类（第 47 条元断言的语义）；`recognition_selections` 见 §8 |

`git diff --stat` 的 10 个删除行里，真正的语义改动只有 2 处「行尾补逗号」
（`('recognition_idempotency', …)` 与 `     true)`（`ocr_idempotency` 行）），其余是插入块替换锚点的 diff 噪声。

### 6.2 新增 5 条断言

| 断言 | 检什么 |
| --- | --- |
| `runtime_favorites_dml_exec` | `SET LOCAL ROLE` 后 favorites 域 8 条零行语句（SELECT / INSERT…ON CONFLICT / FOR UPDATE / DELETE / 幂等台账 4 条）全部成功 |
| `runtime_history_dml_exec` | 同上，history 域 8 条 |
| `runtime_conversations_dml_exec` | 同上，对话域 12 条（含两次 `UPDATE … RETURNING` 与 `FOR UPDATE`） |
| `public_no_privilege_favorites_history` | 七张表的 `relacl` **与** `attacl` 里都不许出现 `grantee = 0`（`PUBLIC`）——只看 `has_table_privilege` 看不见列级 ACL |
| `runtime_domain_tables_classified_favorites_history` | `^(favorites\|history\|conversation)` 前缀的 `public` 关系必须进 `domain_manifest`，且 `granted` 的必须在 `expected` 里有独立列清单 |

外加数据驱动部分：`expected` 新增 7 行 ⇒ 自动多出 7 条 `runtime_grants_<tbl>`（逐列正/反检查）。
断言总数从 59 变成 **71**（都是实跑 `SELECT label FROM checks` 数出来的：改前 59 条、改后 71 条；
新增 12 条 = 5 条固定断言 + 7 条数据驱动；数据驱动部分一共 17 条，来自 `expected` 的 17 行）。

## 7. 变异 / 负控制（6 条；每条都「变异 → 断言 → 还原 → 复核 `ok`」）

### 7.1 汇总

| 编号 | 变异 | 判红断言（末行原文节选） | 还原 | 日志 |
| --- | --- | --- | --- | --- |
| NC1 | `REVOKE INSERT (created_at) ON public.favorites` | `runtime_favorites_dml_exec (…); runtime_grants_favorites (…)` | 重跑 `20-login-roles.sql` ⇒ `ok` | `mut-m1-*.log` |
| NC2 | `REVOKE ALL ON public.conversation_turns` + `GRANT SELECT ON public.conversation_turns`（只给表级 SELECT） | `runtime_conversations_dml_exec (…); runtime_grants_conversation_turns (…)` | 重跑授权文件 ⇒ `ok` | `mut-m2-*.log` |
| NC3 | `CREATE TABLE public.favorites_probe (id integer)` | `runtime_domain_tables_classified_favorites_history (…前缀的新表必须进 domain_manifest…)` | `DROP TABLE` ⇒ `ok` | `mut-m3-*.log` |
| NC4 | 文件级：从 `allow_table_dml` 里删 `('public','favorites','DELETE')` | `table_dml_allowlist (…)`（`detail` 里只剩 10 个三元组，`favorites{DELETE}` 消失） | 复原 ⇒ `sha256` 相等 ⇒ `ok` | `mut-m4-assert.log` |
| NC5 | 文件级：从 `domain_manifest` 里删 `('recognition_selections','forbidden',false)` | **改前的原话**：`runtime_domain_tables_classified (运行时域的每张表必须进分类清单…)` | 复原 ⇒ `sha256` 相等 ⇒ `ok` | `mut-m5-assert.log` |
| NC6 | `GRANT UPDATE ON public.favorites`（表级，清单外） | `runtime_grants_favorites (…); table_dml_allowlist (…)` | 见 §7.4 | `mut-m6b-*.log` |

`sha256`（文件级变异，都是先备份再逐字节复原）：

| 文件 | 变异后 `sha256` | 复原后 `sha256` | 相等 |
| --- | --- | --- | --- |
| `90-assert-least-privilege.sql`（NC4） | `75841452df2d0eee8deb41d627fa296be8357f126ef7fcd9d98cf73b16476779` | `b561435af28c1fb7ebb77fb5eecaeb7ac08ca86e6a42030782ca7b08942d3026` | ✅ |
| `90-assert-least-privilege.sql`（NC5） | `9e843cdac076d1c42200a8ea177735636beb22c2477384608578a0e7e7956200` | 同上 `b561435a…42d3026` | ✅ |

（变异基线 `sha256` = `b561435af28c1fb7ebb77fb5eecaeb7ac08ca86e6a42030782ca7b08942d3026`；
复原后每次复核都回 `ok`。）

### 7.2 两条既有断言扩展的变异原文

**E1（允许清单）**——NC4 的 `detail` 是扩表后**第一次**由 CTE 生成的提示，正好验证「列全」：

```
FAIL: table_dml_allowlist (表级写权限只允许 community_idempotency{DELETE}、community_likes{DELETE}、
conversation_turns{DELETE}、conversations{DELETE}、favorites_idempotency{DELETE}、history{DELETE}、
history_idempotency{DELETE}、idempotency_keys{DELETE}、idempotency_keys{INSERT}、ocr_idempotency{DELETE}；
清单外的表或类型一律失败（其余全部按列授予）)
```

**NC6**（多授、非清单类型）的同一 `detail` 完整列出 **11 个**三元组
（`community_idempotency{DELETE}`、`community_likes{DELETE}`、`conversation_turns{DELETE}`、
`conversations{DELETE}`、`favorites{DELETE}`、`favorites_idempotency{DELETE}`、`history{DELETE}`、
`history_idempotency{DELETE}`、`idempotency_keys{DELETE}`、`idempotency_keys{INSERT}`、
`ocr_idempotency{DELETE}`）⇒ 扩表后提示确实列全 11 条（`mut-m6b-assert.log`）。

**E2（清单行）**——NC5 复现的正是改前的原话，见 §8。

### 7.3 为什么 `favorites_probe` 到本片才被抓到

S24 第 47 条元断言的正则 `^(messages$|community_|ocr_|recognition_|user_backup_copies$|deletion_|third_party_deletions$)`
不含 `favorites`/`history`/`conversation` 前缀（S24 独立验证者已指出这个盲区），所以 `CREATE TABLE public.favorites_probe`
在**改前**是绿的。本片按「不改既有断言」的约束**不改正则**，改为新增 63 号断言用新前缀兜住同一件事；
NC3 证明它现在判红。

### 7.4 表级 `GRANT` / `REVOKE` 的连带效应（恢复路径必须知道）

NC6 的还原过程暴露了一个 PG 行为，值得写进运维口径（实验 `experiment-revoke.sql`，日志
`experiment-revoke.log`；事务内观察、`ROLLBACK`）：

```
 阶段                        tbl_upd   col(revision)_upd
 0 初始（只有列级授权）        f         t
 1 GRANT UPDATE（表级）后      t         t
 2 REVOKE UPDATE（表级）后     f         f        ← 列级条目也没了
```

原因：表级 `GRANT` 会把同类型（`UPDATE`）的列级条目**合并/覆盖**，之后表级 `REVOKE` 只能撤掉表级条目，
**列级授权无法靠 `REVOKE` 还原**（`attacl` 里 `revision` 的 `w` 位已经消失，见同一日志的 ACL 原文）。
⇒ 误授之后的正解是**重跑 `20-login-roles.sql`**（本片两次还原都这么做，`mut-m1-regrant.log` / `mut-m6b-regrant.log`）。
NC6 的中间态因此也是红的（`runtime_favorites_dml_exec` + `runtime_grants_favorites`），重跑授权文件后才回 `ok`。

### 7.5 反向控制：撤一条权限，坏一条语句

派单要求的反向控制是「临时 `GRANT SELECT,INSERT ON favorites` ⇒ 同一批语句成功 ⇒ `REVOKE` 并验证复原」。
本机做得更细（`probe-reverse-control.sql`，日志 `reverse-control.log`）：在**一个事务**里先把授权
`REVOKE ALL` 掉、再一条条加回来，末尾 `ROLLBACK` ⇒ 集群的部署状态从头到尾没有被改动。
日志是 `psql -X -P pager=off`（**不带 `-q`**），所以 `INSERT 0 0` / `DELETE 0` 这些命令标签可见：

| 阶段 | 事务内授权 | 普通 SELECT | `FOR UPDATE` | INSERT | DELETE |
| --- | --- | --- | --- | --- | --- |
| A | `REVOKE ALL` | `42501` | `42501` | `42501` | `42501` |
| B1 | `SELECT`（7 列） | 通过 | `42501`（`:47`） | `42501`（`:52`） | 未试 |
| B2 | ＋ `INSERT`（7 列） | 通过 | `42501` | 通过（`INSERT 0 0`） | 未试 |
| B3 | ＋ `UPDATE (revision)` | 通过 | 通过（`FOR SHARE` 同） | 通过 | `42501`（`:81`） |
| B4 | ＋ 表级 `DELETE` | 通过 | 通过 | 通过 | 通过（`DELETE 0`） |

原文节选：

```
--- A1 plain SELECT must be 42501 ---
psql:…probe-reverse-control.sql:19: ERROR:  42501: permission denied for table favorites
LOCATION:  aclcheck_error, aclchk.c:2845
...
--- B1c INSERT must still be 42501 ---
psql:…probe-reverse-control.sql:52: ERROR:  42501: permission denied for table favorites
...
INSERT 0 0                    ← B2：补上列级 INSERT 后，同一条 INSERT 就通了
...
--- B3c DELETE must still be 42501 (DELETE has no column form) ---
psql:…probe-reverse-control.sql:81: ERROR:  42501: permission denied for table favorites
...
DELETE 0                      ← B4：补上表级 DELETE 后，同一条 DELETE 就通了
```

`ROLLBACK` 后的残留检查（日志 §C/§D）与改前完全一致，证明实验没有改动部署状态：

```
tbl_select f | tbl_insert f | tbl_update f | tbl_delete t
col_select_revision t | col_update_revision t
favorites relacl = {gengyun_cvm_owner=arwdDxtm/gengyun_cvm_owner,gengyun_api_runtime=d/gengyun_cvm_owner}
```

⇒ 每条语句的 `42501` 与「成功」都只由**它真正需要的那一条授权**决定；
`SELECT … FOR UPDATE/FOR SHARE` 要 `UPDATE (revision)`（§4.3），`DELETE` 只能表级（§4.4），两点都有独立读数。

## 8. 继承缺口：`recognition_selections`（迁移 `0025`，本片**不修**）

三件事实，写死在这里：

1. `0025_recognitions_persistence.sql` 已经在 `main`（`341ad8c`）里，它新增 `recognition_selections`
   （外加 `recognition_jobs` / `recognition_records` / `recognition_idempotency`）。这四张表对
   `gengyun_api_runtime` 是**整张零授权**——`deploy/postgres-cvm/sql/20-login-roles.sql` 至今没有任何
   `recognition_*` 授权区（S24 的分支只对它们做了软守卫）。
2. 运行时**真的会写**这几张表（`services/api/src/recognitions/store-pg.ts:820` / `:830` 的
   `DELETE FROM public.recognition_idempotency` 等）⇒ 真部署上必然 `42501`。S13 的
   `tests/integration/egress-ledger-pg.mjs:255-256` 已经把这个缺口写在注释里并因此红过。
3. S24 的 `domain_manifest` 里那四行 `'forbidden', false` 是**权宜快照**（「当下确实没给」，不是
   「设计上不给」）。**下一片（S27）必须把它们翻成 `granted`，并补 `20-login-roles.sql` 的授权区与
   `expected` 行**；本片只加了 `('recognition_selections','forbidden',false)` 一行，让装了 0025 的库上
   断言能复跑（否则第 47 条恒红，本片的七张表改动无法被判绿）。

两个对照读数（都进本页）：

| 状态 | `90-assert` 末行 |
| --- | --- |
| 去掉 `recognition_selections` 那一行（NC5） | `FAIL: runtime_domain_tables_classified (运行时域的每张表必须进分类清单（granted/granted_external/forbidden）；新增表既不授权也不声明 forbidden ⇒ 失败)` |
| 加上该行（提交态） | `ok` |

## 9. 判据口径：`FAIL` 时 `psql` 退出码仍是 0

`90-assert` 的判决是**最后一行文本**（`ok` / `FAIL: …`），不是退出码：`SELECT CASE …` 永远成功，
`psql` 因此恒返回 0。`provision-db.sh:364-365` 正是取最后一行非空输出
（`sed '/^[[:space:]]*$/d' | tail -n1`）与 `ok` 比对。本片所有「判红」都以**末行原文**为准（§7）。
同理 `probe-runtime-grants.sql` 用 `\set ON_ERROR_STOP 0` 是设计的一部分：它要跑完每一条再让人读输出。

## 10. 部署顺序复现（本机）

```
1) initdb -D .pg17/data-r28s26 -U gengyun_cvm_owner --pwfile=owner_pw.txt \
          --auth-host=scram-sha-256 --auth-local=trust -E UTF8 --locale=C
2) 起进程（Invoke-CimMethod Win32_Process ⇒ postgres.exe -D … -p 55640 -c listen_addresses=127.0.0.1）
3) CREATE DATABASE gengyun OWNER gengyun_cvm_owner
4) DATABASE_URL=postgres://gengyun_cvm_owner:…@127.0.0.1:55640/gengyun npm run db:migrate --workspace @gengyun/api
   ⇒ 已应用 0001…0025（25 个）
5) services/api/db/roles/*.sql 八个（顺序：auth_privacy, catalog_readers, consent_granter,
   profile_runtime, knowledge_runtime, source_operator, staging_importer；egress_ledger 在 catalog_readers 之后）
6) GENGYUN_API_RUNTIME_PASSWORD=<48 位小写十六进制> psql -f deploy/postgres-cvm/sql/20-login-roles.sql
7) psql -f deploy/postgres-cvm/evidence/probe-runtime-grants.sql   （读输出，不看退出码）
8) psql -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql    （末行必须恰为 ok）
```

本机 8 步全绿；日志在 `.pg17/handoff/r28-s26-logs/`（`post-change-grant.log` / `probe-runtime-postfix.log` /
`assert-postfix.log`）。`roles/*.sql` 不幂等（组已存在时 `provision-db.sh` 会跳过），复现必须从干净集群起。

## 11. 为什么既有测试没发现

- `tests/integration/favorites-history-pg.mjs` 与 `tests/integration/conversations-pg.mjs` 都以
  **迁移属主（超级用户）** 连库，结构上看不见「运行时角色没被授权」这件事。两个脚本里
  `ROLE|privilege|role` 的搜索结果：`conversations-pg.mjs` 只有 `role: 'user'`（`:325`，与权限无关），
  `favorites-history-pg.mjs` **零命中**，也**零** `42501` 断言 ⇒ 它们不可能红。
- 唯一写过这件事的是 `tests/integration/egress-ledger-pg.mjs:255-256`（识别域，不是收藏/历史/对话）。
- 所以本片的判据只能是「部署侧 `SET ROLE` 真执行」+ `90-assert`，也就是本页与探针文件。

## 12. 没做到 / 未取得

1. **未在真实 CVM 执行**：没有 SSH 到 CVM、没有跑 `provision-db.sh`、没有在 CVM 的 PG 上验过这七张表。
   全部读数来自本机 PG 17.11 一次性集群（同构：同样的迁移、同样的 `roles/*.sql`、同样的
   `20-login-roles.sql` / `90-assert`）。
2. **未在 GitHub runner 上跑过**：`real-pg-17.11` 这类 job 没有本片的新断言日志。
   （另：`main` 上该 job 现在本来就有一条继承红——`tests/integration/ocr-jobs-pg.mjs:256:10`
   「本片迁移必须是当前末位（现场 0025_recognitions_persistence.sql）」，与本片无关。）
3. **未取得 `provision-db.sh` 端到端输出**：本机按 §10 的手工顺序等价重放，**没有**跑那个 shell 脚本
   本体（Windows 上没有 bash 版的 provisioning 夹具）。
4. **未取得 `roles/*.sql` 之外的 CLI 组**：`gengyun_evidence_reader` / `gengyun_source_operator` /
   `gengyun_staging_importer` 都没有授予运行时，也没有测它们的权限面（不在本片范围）。
5. **未取得 `recognition_*` 的授权读数**：本片没给它们授权（§8），只取证了「零授权 + 断言恒红」。
6. **未取得真实并发下的锁行为**：`FOR UPDATE` 只验证了「权限够、语句能过、零行」，没有做两会话并发
   争锁/超时的实测（`lock_timeout='4s'` 的路径未触发）。
7. **未取得 CVM 上的 `PUBLIC` 行为差异**：本机库由 `initdb -U gengyun_cvm_owner` 建，属主即超级用户；
   与 CVM 的 bootstrap 身份一致（`install-postgres.sh:461`），但**没有**在 CVM 上复核 `REVOKE ALL … FROM PUBLIC` 的效果。
8. **未跑全量测试**：只跑了派单点名的五道门禁（§5 之外的门禁记录见报告）与两个集成脚本，
   没有跑 `npm test` 全量、也没有跑 `tests/unit/**`；`tests/` 下只有 `tests/integration/*-pg.mjs`
   提到这三个 deploy 文件名（已 `grep` 核实），本片没有引入新的单元测试面。
9. **未在非超管 bootstrap 的 owner 上复跑**：本机按 `install-postgres.sh:461` 的
   `initdb -U gengyun_cvm_owner` 同构（owner 即集群超级用户）。早期用非超管 owner 搭夹具时，
   `20-login-roles.sql:199` 的 `ALTER ROLE … NOSUPERUSER` 被 PG 16+ 拒绝
   （`ERROR: permission denied to alter role`）——那个分支本片**没有**取得读数，也**不**据此声称
   产品支持非超管 owner（`provision-db.sh:384` 明写 owner 是超级用户、仅运维使用）。
10. **未改动**：`services/**`、`apps/**`、`packages/**`、迁移、`services/api/db/roles/*.sql`、
    `.github/workflows/*`、`tests/**`、S24 证据页、索引页计数（本片没有新增 deploy 文件，
    `probe-runtime-grants.sql` 已在册，`verify-release-materials` 覆盖计数不变）。

## 13. 与派单 / 裁定的对应

| 派单项 | 落点 |
| --- | --- |
| 阶段一：七张表改前逐条 `42501` | §3.1 / §3.2（27 条，日志 `phase1-prefix.log`） |
| 阶段一：控制臂 | §3.3 |
| 阶段二：`20-login-roles.sql` 授权区 | §4（I 段，686 行） |
| 阶段二：`domain_manifest` 7 行 | §6.1 E2 |
| 阶段二：双向断言（正面 DML + 反面 `PUBLIC`） | §6.2（3 条 exec + 1 条 `PUBLIC` + 1 条元断言） |
| 阶段二：不得改既有断言 | 只扩展第 7 条与 `domain_manifest`（§6.1，两条都给了变异与 `sha256`） |
| 阶段三：7 个零行探针 | `probe-runtime-grants.sql` 第 5 节（+126 行，443 行总计） |
| 阶段三：≥3 条变异 | §7（6 条，含两条既有断言扩展的变异） |
| 阶段三：复跑两个集成脚本 | §11（并解释为什么它们不可能红） |
| 裁决 2：11 个三元组 + 代码出处 + `answers` 无 DELETE + `detail` 自动生成 | §4.4 / §4.5 / §7.2 |
| 裁决 3：`recognition_selections` + 两个对照读数 | §8 |
| 裁决 4：`UPDATE (revision)` 仅行锁载体 + 实验原文 | §4.3 |
| 红线：不声称真实 CVM / 不编造读数 | §12（逐条「未取得」） |
