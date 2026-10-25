# R28-S24 运行时最小权限授权取证（messages / community_* / ocr_*）

- 任务：CVM 部署里运行时 `gengyun_api_runtime`（LOGIN）对迁移 `0019` 的 `messages`、`0022` 的 6 张
  `community_*`、`0024` 的 3 张 `ocr_*` **没有任何权限** ⇒ 生产上这些域的读写会 `42501`。
- 基线：`4122976`（分支 `fix/gy-r28-least-privilege-grants`）。
- 落地物：
  - [`deploy/postgres-cvm/sql/20-login-roles.sql`](../../deploy/postgres-cvm/sql/20-login-roles.sql)
    新增 `#region gy-r28-runtime-domain-grants`（列级授权 + 三张表的表级 `DELETE`）。
  - [`deploy/postgres-cvm/sql/90-assert-least-privilege.sql`](../../deploy/postgres-cvm/sql/90-assert-least-privilege.sql)
    第 7 条收紧为结构化允许清单，并新增第 45–48 组断言（共 14 个标签）。
  - [`deploy/postgres-cvm/evidence/probe-runtime-grants.sql`](../../deploy/postgres-cvm/evidence/probe-runtime-grants.sql)
    零行真执行探针（改前/改后都能跑，用来复现「红 → 绿」）。
- **取证范围声明**：全部读数来自本机一次性 PG 17.11 集群。
  **没有在真实 CVM 上演练，也没有在 GitHub runner 上跑过**；凡是没跑到的，第 12 节逐条写「未取得」。

## 0. 结论摘要

| # | 结论 | 证据 |
| --- | --- | --- |
| 1 | 改前三域**完全不可用**：10 张表权限矩阵全 `f`，31 条真实语句形状 → 31 行 `42501`（逐条一一对应，零成功） | §3.1/§3.2 |
| 2 | 改前的 `90-assert` 在同一库**输出 `ok`**（假绿） | §3.4 |
| 3 | 改后同一套断言输出 `ok`；把授权全部 `REVOKE` 回改前 ⇒ **12 个标签判红** | §6 |
| 4 | 14 个新标签逐个有负控制证据（含独立验证者提的 3 条漏授变异） | §7 |
| 5 | 干净集群按部署顺序重放：8 步全 `exit=0`，末行 `ok` | §8 |
| 6 | `psql` 在输出 `FAIL: …` 时**退出码仍是 0**；判据必须是「最后一行是否恰为 `ok`」 | §9 |
| 7 | `recognition_*`（迁移 `0025`，本分支未合入）只给软守卫 + 草案，本分支**不引用**这三张表 | §10 |

## 1. 范围

**做了**：三域 10 张表的授权收敛（到列）、`DELETE` 例外的最小化、`90-assert` 的反向/正向断言、
元断言（新表必须被分类）、recognition 草案与取舍、部署顺序复现、门禁自跑。

**没做**（本片范围外，见 §12）：`favorites`/`favorites_idempotency`/`history`/`history_idempotency`/
`conversations`/`conversation_turns`/`conversation_answers` 这七张表**整张零授权**（与三域同一个病，
`SET ROLE` 实测全 `42501`，本片不修）、既有已授权表的列清单复核、`services/**` 任何改动、
`services/api/db/roles/*.sql` 任何改动、迁移任何改动、真实 CVM/CI 演练、`#333`（`0025`）合入后的
recognition 实际授权。

## 2. 环境

| 项 | 值 |
| --- | --- |
| 服务端 | `PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit` |
| 客户端 | `psql (PostgreSQL) 17.11` |
| 集群 | 本机一次性集群，`127.0.0.1:55630`，datadir `.pg17/data-r28s24`，`--auth-local=trust --auth-host=scram-sha-256` |
| 库/角色 | 库 `gengyun`（属主 `gengyun_cvm_owner`，超级用户）；运行时 `gengyun_api_runtime` 由 `20-login-roles.sql` 建 |
| 迁移 | `node services/api/src/db/migrate.ts up` ⇒ `已应用：0001 … 0024`（24 个，真 CLI，`schema_migrations` 台账在） |
| 角色文件 | `services/api/db/roles/` 的 5 个（`auth_privacy` / `catalog_readers` / `consent_granter` / `profile_runtime` / `knowledge_runtime`），与 `provision-db.sh` 的 `ROLE_GROUP_FILES` 一致 |

该集群只用密码认证的**本机合成口令**，下列口令都是本地临时值，与任何真实环境无关。

## 3. 改前必红（读数原文）

探针：[`deploy/postgres-cvm/evidence/probe-runtime-grants.sql`](../../deploy/postgres-cvm/evidence/probe-runtime-grants.sql)，
在**改前**的数据库（迁移 0001–0024 + 组角色 + 改前的 `20-login-roles.sql` + 改前的 `90-assert`）上跑。
原始输出：`.pg17/handoff/r28-s24-before-probe.raw.txt`（161 行）。

### 3.1 表级权限矩阵（改前）

```
               relation                | sel | ins | upd | del | trunc
---------------------------------------+-----+-----+-----+-----+-------
 public.messages                       | f   | f   | f   | f   | f
 public.community_posts                | f   | f   | f   | f   | f
 public.community_comments             | f   | f   | f   | f   | f
 public.community_likes                | f   | f   | f   | f   | f
 public.community_reports              | f   | f   | f   | f   | f
 public.community_moderation_decisions | f   | f   | f   | f   | f
 public.community_idempotency          | f   | f   | f   | f   | f
 public.ocr_jobs                       | f   | f   | f   | f   | f
 public.ocr_records                    | f   | f   | f   | f   | f
 public.ocr_idempotency                | f   | f   | f   | f   | f
(10 rows)
```

注意：这张矩阵**证明不了**「有列级授权」——`has_table_privilege` 对列级授权恒为 `false`
（对照组 `user_backup_copies` 明明可用，矩阵同样是 `f`）。所以判据必须是 §3.2 的 `SET ROLE` 真执行。

### 3.2 真执行探针（`SET ROLE gengyun_api_runtime`，零行语句）

31 条语句（每条都有 `-- [表] …` 注释标记，行号即探针文件行号；形状取自 `store-pg.ts` 的真实语句：
`SELECT` 授权列 / `INSERT … SELECT … WHERE false` / `UPDATE … WHERE false` / `DELETE … WHERE false` /
`SELECT … FOR UPDATE`），**全部**失败，且**每条只产生一行** `ERROR: 42501` ⇒ 31 条标记 ↔ 31 行拒绝。
原文摘录：

```
psql:deploy/postgres-cvm/evidence/probe-runtime-grants.sql:82: ERROR:  42501: permission denied for table messages
LOCATION:  aclcheck_error, aclchk.c:2845
psql:deploy/postgres-cvm/evidence/probe-runtime-grants.sql:92: ERROR:  42501: permission denied for table messages
psql:deploy/postgres-cvm/evidence/probe-runtime-grants.sql:97: ERROR:  42501: permission denied for table messages
psql:deploy/postgres-cvm/evidence/probe-runtime-grants.sql:104: ERROR:  42501: permission denied for table community_posts
psql:deploy/postgres-cvm/evidence/probe-runtime-grants.sql:114: ERROR:  42501: permission denied for table community_posts
psql:deploy/postgres-cvm/evidence/probe-runtime-grants.sql:122: ERROR:  42501: permission denied for table community_posts
psql:deploy/postgres-cvm/evidence/probe-runtime-grants.sql:127: ERROR:  42501: permission denied for table community_comments
```

按表统计被拒次数：`messages` 3、`community_posts` 3、`community_comments` 3、`community_likes` 3、
`community_reports` 2、`community_moderation_decisions` 2、`community_idempotency` 4、`ocr_jobs` 4、
`ocr_records` 3、`ocr_idempotency` 4（合计 31）；**三域探针成功次数 = 0**。

### 3.3 对照臂（同一角色、同一会话）

```
-- [control] public.user_backup_copies（列级授权在 gengyun_auth_privacy 组上）
 user_backup_copies_rows
-------------------------
                       0
(1 row)

-- [control] public.feature_flags：表级 SELECT（改前即有）
 feature_flags_rows
--------------------
                  3
(1 row)

-- [control] public.idempotency_keys：表级 SELECT/INSERT/UPDATE/DELETE（改前即有）
 idempotency_keys_rows
-----------------------
                     0
(1 row)
```

三条对照臂**全部成功** ⇒ 上面的 `42501` 是「没授权」，不是「连不上/角色不对」。

### 3.4 改前的 `90-assert` 是假绿

改前版本在同一库上：

```
$ psql -X -q -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql
exit=0
ok
```

即：三域整片不可用，部署闸门却放行。原始输出 `.pg17/handoff/r28-s24-before-assert.utf8.txt`（1 行 `ok`）。

## 4. 授权设计（粒度与理由）

### 4.1 给谁

**直接授给 `gengyun_api_runtime`**，不新建 `NOLOGIN` 组。

理由：
1. 这三域的**唯一**消费者就是运行时进程（`services/api/src/{messages,community,ocr}/store-pg.ts`）；
   没有第二个消费者，拆组只会增加一层没人用的间接。
2. 组的权威定义在 `services/api/db/roles/*.sql`，本片**禁止改动**；把列级授权塞进那些文件会让
   「角色文件 = 组口径」的既有约定失真。`20-login-roles.sql` 里 `feature_flags` 的直接授权
   （`GRANT SELECT ON TABLE public.feature_flags TO gengyun_api_runtime`）就是既有先例。
3. `provision-db.sh` 只在**组不存在**时才跑 `roles/*.sql`，而 `20-login-roles.sql` **每次部署都执行**；
   授权放在后者才能对「已经装过库、只升级代码」的环境收敛（这一点是 `user_backup_copies` 段
   注释里已经写明的部署事实）。

### 4.2 为什么列级（而不是表级）

- `90-assert` 的元不变量是「表级 `INSERT`/`UPDATE` 处处禁止」——它们都存在列级替代，表级授权会让
  「运行时能写哪些列」不可断言。
- 列级让授权清单与 `store-pg.ts` 的真实语句**逐列对齐**（注释里带 `file:line`），漂移会被
  `runtime_grants_<表>` 抓住。
- `SELECT` 也按列授：真实语句只读这些列；`SELECT count(*)`、`SELECT … FOR UPDATE` 在列级 `SELECT`
  下可用（本集群实测，见 §7 的探针）。

### 4.3 三张表的表级 `DELETE`（唯一的表级例外）

PostgreSQL **没有列级 `DELETE`**，而这三处是**物理删除**（集合语义），无法改成软删：

| 表 | 出处 | 语义 |
| --- | --- | --- |
| `community_likes` | `community/store-pg.ts:703` | 取消点赞：唯一键 `(user_id,target_type,target_id)` 就是「点过没点过」 |
| `community_idempotency` | `community/store-pg.ts:1104/1133/1162` | 过期占位清理、放弃认领 |
| `ocr_idempotency` | `ocr/store-pg.ts:745/752` | 释放认领、过期清理 |

因此 `90-assert` 第 7 条从「按表名豁免（该表全部写类型放开）」收紧成
**`(schema, 表, 权限类型)` 结构化允许清单**：

```
idempotency_keys{INSERT,DELETE}、community_likes{DELETE}、
community_idempotency{DELETE}、ocr_idempotency{DELETE}
```

清单外的表或类型一律失败（例：`GRANT UPDATE ON community_likes` ⇒ 红）。这比改前**更严**：
改前 `idempotency_keys` 的 6 种写权限全被豁免，现在只豁免它真有的两种。

`messages` / `community_posts` / `community_comments` / `community_reports` /
`community_moderation_decisions` **完全没有 `DELETE`**（删除是 `visibility`/`audit_state` 的软转换）。
任何表都没有 `TRUNCATE`/`REFERENCES`/`TRIGGER`。

### 4.4 授权的完整清单（与段 H 逐行一致）

| 表 | SELECT（列） | INSERT（列） | UPDATE（列） | 表级 DELETE |
| --- | --- | --- | --- | --- |
| `messages` | 8/8 全列 | 8/8 全列 | `read_at,revision` | 否 |
| `community_posts` | 15/15 全列 | 15/15 全列 | 除 `id,author_id,created_at` 的 12 列 | 否 |
| `community_comments` | 8/8 全列 | 8/8 全列 | `revision,body,visibility,audit_state` | 否 |
| `community_likes` | `target_type,target_id,user_id`（不授 `created_at`） | 同左 3 列 | 无 | **是** |
| `community_reports` | 10/10 全列 | 10/10 全列 | 除 `id` 的 9 列 | 否 |
| `community_moderation_decisions` | 12/12 全列 | 12/12 全列 | 除主键 3 列的 9 列 | 否 |
| `community_idempotency` | 6/6 全列 | 6/6 全列 | `response_status,outcome` | **是** |
| `ocr_jobs` | 12/12 全列 | 12/12 全列 | `revision,state,deadline_at,updated_at,error_code` | 否 |
| `ocr_records` | 12/12 全列 | 12/12 全列 | `revision,raw_fields,corrected_fields,verification,model_version,updated_at,deleted` | 否 |
| `ocr_idempotency` | 6/6 全列 | 6/6 全列 | `request_hash,payload,pending,expires_at` | **是** |

不授 `created_at` 的写：它由列默认值产生；不授 `likes.created_at` 的读：`store-pg.ts` 不读它。
`ON CONFLICT … DO UPDATE` 的写面与 `INSERT` 列同源（PostgreSQL 要求 `UPDATE` 权限覆盖 `SET` 的列），
所以幂等台账的 `UPDATE` 列里包含 `request_hash/expires_at`。

### 4.5 其它收敛动作

- 段 H 先用一个 `DO` 块聚合检查 10 张表存在（`to_regclass`），缺迁移就 `RAISE EXCEPTION`
  并点名「顺序必须是 migrate.ts up ⇒ 20-login-roles.sql」——**不**允许「看起来装好了但写不进去」。
- 对 10 张表 `REVOKE ALL … FROM PUBLIC`（幂等；即便将来有人给 `PUBLIC` 授权也会被收掉）。
- 追加 3 行 `\echo` 如实声明「授了什么 / `DELETE` 只在哪三张表」。

## 5. `90-assert` 改前 / 改后对照

既有 44 条断言的**语义一条未动**，只改了第 7 条的判定表达式（裁定允许的那一处），其余全是新增。

| 断言 | 改前 | 改后 | 钉什么 | 负控制 |
| --- | --- | --- | --- | --- |
| 7 `table_dml_allowlist` | 按表名豁免 `idempotency_keys`（6 种写权限全放开） | **(schema,表,权限) 允许清单**，清单外一律红 | 表级写权限的精确形状 | NC1/NC2/NC6b |
| 45 `runtime_domain_delete_exec` | 无 | 新增：`SET LOCAL ROLE` 后 4 张白名单表 `DELETE … WHERE false` 必须成功 | 表级 `DELETE` 真的可用（`has_table_privilege` 回答不了语句形状） | NC3 |
| 46 `runtime_domain_select_exec` | 无 | 新增：10 张表按授权列 `SELECT … LIMIT 0` 必须成功 | 列级读面真的可用 | M1/M2/M3 |
| 47 `runtime_domain_tables_classified` | 无 | 新增：运行时域每张表必须在 `domain_manifest` 里被分类（`granted`/`granted_external`/`forbidden`） | **防「下一个域又被漏」** | NC5 |
| 48 `runtime_domain_forbidden_tables_untouched` | 无 | 新增：`forbidden` 分类的表零表级、零列级权限 | 注销三表 `deletion_*`/`third_party_deletions`、`community_media_grants`、将来存在的 `recognition_*` | NC6a/NC6b |
| `runtime_grants_<表>` ×10 | 无 | 新增（数据驱动 `expected` CTE）：清单内列必须有该权限、清单外列必须没有、表级 `INSERT/UPDATE/TRUNCATE/REFERENCES/TRIGGER` 全为 `f`、`DELETE` 与声明一致 | 授权与清单逐列一致（正向 + 反向） | NC1/NC2/NC3/NC4/M1/M2/M3 |

`domain_manifest` 覆盖：`messages`、6 张 `community_*`、3 张 `ocr_*`（`granted`）、
`user_backup_copies`（`granted_external`，列形状由 `tests/integration/backup-purge-pg.mjs` 覆盖）、
`deletion_requests`/`deletion_handlers`/`third_party_deletions`/`community_media_grants`（`forbidden`）、
`recognition_jobs`/`recognition_records`/`recognition_idempotency`（`forbidden`，`required=false`）。
`expected` CTE 是授权清单的**独立复述**：与 `20-login-roles.sql` 是同一事实的两次写法，
任一处漂移都会被抓住（有意重复，不是从授权结果反推）。

新增段落只增不删；`90-assert` 的删行统计是 7 行（`WITH checks(` 一行 + 第 7 条的 6 行），
其余 `-` 行都在同一处替换内。

## 6. 三段判决：改前 `ok` → 改后 `ok` → 回改前必红

| 阶段 | 库状态 | `90-assert` 末行 | 退出码 |
| --- | --- | --- | --- |
| A 改前 | 改前文件 + 改前授权 | `ok` | 0 |
| B 改后 | 新文件 + 段 H 授权 | `ok` | 0 |
| C 把三域 10 张表全部 `REVOKE`（= 回改前） | 新文件 + 改前授权 | `FAIL: …`（12 个标签） | 0 |
| D 重跑 `20-login-roles.sql` 复原 | 新文件 + 段 H 授权 | `ok` | 0 |

C 段原文（`.pg17/handoff/r28-s24-nc/A-revert-to-before-then-new-assert.log`）：

```
FAIL: runtime_domain_delete_exec (SET LOCAL ROLE gengyun_api_runtime 后，四张白名单表的 DELETE … WHERE false 必须成功；任一 42501 即失败);
runtime_domain_select_exec (十张表按授权列清单 SELECT … LIMIT 0 必须成功（列级授权下 has_table_privilege 恒为 false，不能当判据）);
runtime_grants_community_comments (…); runtime_grants_community_idempotency (…); runtime_grants_community_likes (…);
runtime_grants_community_moderation_decisions (…); runtime_grants_community_posts (…); runtime_grants_community_reports (…);
runtime_grants_messages (…); runtime_grants_ocr_idempotency (…); runtime_grants_ocr_jobs (…); runtime_grants_ocr_records (…)
```

⇒ 「改前的 `ok` 是假的」得到实证：同一份新断言在改前状态**必红**，补齐授权后回绿。

## 7. 负控制（每条都「变异 → 断言 → 还原 → 复核 `ok`」）

### 7.1 多授（必须红）

| 编号 | 变异 | 结果（末行） |
| --- | --- | --- |
| NC1 | `GRANT UPDATE ON public.community_likes` | `FAIL: runtime_grants_community_likes (…); table_dml_allowlist (…)` |
| NC2 | `GRANT TRUNCATE ON public.community_idempotency` | `FAIL: runtime_grants_community_idempotency (…); table_dml_allowlist (…)` |
| NC6b | `GRANT INSERT ON public.third_party_deletions` | `FAIL: runtime_domain_forbidden_tables_untouched (…); table_dml_allowlist (…)` |

`⚠ 口径更正`：早期派单把 `GRANT DELETE ON community_likes` 当「多授」探针，但在新允许清单下
**它本来就是合法授权**（`community_likes{DELETE}` 在清单里）。本页不再使用该探针，多授探针统一用
`GRANT UPDATE ON community_likes` / `GRANT TRUNCATE ON community_idempotency`。

### 7.2 漏授（必须红）

| 编号 | 变异 | 结果（末行） |
| --- | --- | --- |
| NC3 | `REVOKE DELETE ON public.community_likes` | `FAIL: runtime_domain_delete_exec (…); runtime_grants_community_likes (…)` |
| NC4 | `REVOKE INSERT (id) ON public.messages` | `FAIL: runtime_grants_messages (…)` |
| NC6a | `GRANT SELECT (id) ON public.deletion_requests` | `FAIL: runtime_domain_forbidden_tables_untouched (…)` |

### 7.3 元断言（必须红）

| 编号 | 变异 | 结果（末行） |
| --- | --- | --- |
| NC5 | `CREATE TABLE public.community_experiment_unclassified (id int primary key)` | `FAIL: runtime_domain_tables_classified (运行时域的每张表必须进分类清单…)` |

### 7.4 独立验证者提的 3 条漏授变异（对提交态复跑）

独立只读验证者在其自建集群上对**提交 2**（`8ed7893`，正向断言尚未落地）跑了这三条并得到 `ok`；
在**提交 3**（含正向断言与真执行探针）上复跑，三条全部转红，逐条还原后回 `ok`：

| 编号 | 变异 | 提交 3 末行 |
| --- | --- | --- |
| M1 | `REVOKE SELECT (type, target_ref), INSERT (target_ref) ON public.messages` | `FAIL: runtime_domain_select_exec (…); runtime_grants_messages (…)` |
| M2 | `REVOKE ALL ON TABLE public.ocr_records` | `FAIL: runtime_domain_select_exec (…); runtime_grants_ocr_records (…)` |
| M3 | `REVOKE ALL ON TABLE public.ocr_jobs` | `FAIL: runtime_domain_select_exec (…); runtime_grants_ocr_jobs (…)` |

日志：`.pg17/handoff/r28-s24-logs/under-M{1,2,3}*.assert.txt`，还原臂分别为 `ok`。

### 7.5 一次汇总

| 断言 | 负控制 |
| --- | --- |
| `table_dml_allowlist` | NC1、NC2、NC6b |
| `runtime_domain_delete_exec` | NC3 |
| `runtime_domain_select_exec` | M1、M2、M3 |
| `runtime_grants_<表>` ×10 | NC1、NC2、NC3、NC4、M1、M2、M3 |
| `runtime_domain_tables_classified` | NC5 |
| `runtime_domain_forbidden_tables_untouched` | NC6a、NC6b |

所有变异都是**数据库侧**动作（`GRANT`/`REVOKE`/`CREATE TABLE`），不改文件字节；每个变异后立刻还原，
并以「末行 = `ok`」复核。两个 SQL 文件的 sha256 见 §8.3。

## 8. 部署顺序复现（干净集群路径）

### 8.1 8 步读数（`.pg17/handoff/r28-s24-replay2/REPLAY.txt`）

```
psql：psql (PostgreSQL) 17.11
server：PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit
clean drop-owned exit=0
drop database exit=0
create database exit=0
drop roles exit=0
roles left: gengyun_cvm_owner
1 migrate.ts up exit=0
   applied: 已应用：0001, 0002, …, 0024
2 role/auth_privacy.sql exit=0
3 role/catalog_readers.sql exit=0
4 role/consent_granter.sql exit=0
5 role/profile_runtime.sql exit=0
6 role/knowledge_runtime.sql exit=0
7 sql/20-login-roles.sql exit=0
8 sql/90-assert-least-privilege.sql exit=0
8 verdict(last non-empty line)=ok
8 verdict_is_ok=True
```

### 8.2 `roles/*.sql` 不幂等（复现时必须从干净集群起）

`services/api/db/roles/*.sql` 用的是 `CREATE ROLE`（没有 `IF NOT EXISTS`）：

```
psql:services/api/db/roles/auth_privacy.sql:5: ERROR:  role "gengyun_auth_privacy" already exists
```

`provision-db.sh` 只在组**不存在**时才跑它们，所以线上不会撞；但**手工复现**时若集群里已有这些角色，
必须先清掉（否则后面的 `20-login-roles.sql` 会因「5 个组不齐」而按设计 `RAISE EXCEPTION`）。
本次复现的清理动作（本机一次性集群）：

```sql
DROP OWNED BY gengyun_auth_privacy, gengyun_preview_reader, gengyun_evidence_reader,
              gengyun_consent_granter, gengyun_profile_runtime, gengyun_knowledge_runtime,
              gengyun_api_runtime;
DROP DATABASE gengyun;
CREATE DATABASE gengyun OWNER gengyun_cvm_owner;
DROP ROLE gengyun_api_runtime, gengyun_auth_privacy, gengyun_preview_reader,
         gengyun_evidence_reader, gengyun_consent_granter, gengyun_profile_runtime,
         gengyun_knowledge_runtime;
```

### 8.3 复现命令

```bash
cd wt-r28-s24
export DATABASE_URL='postgres://gengyun_cvm_owner:<local-pw>@127.0.0.1:55630/gengyun'
node services/api/src/db/migrate.ts up                       # 1) 0001–0024
psql -X -q -v ON_ERROR_STOP=1 -f services/api/db/roles/auth_privacy.sql        # 2)–6)
psql -X -q -v ON_ERROR_STOP=1 -f services/api/db/roles/catalog_readers.sql
psql -X -q -v ON_ERROR_STOP=1 -f services/api/db/roles/consent_granter.sql
psql -X -q -v ON_ERROR_STOP=1 -f services/api/db/roles/profile_runtime.sql
psql -X -q -v ON_ERROR_STOP=1 -f services/api/db/roles/knowledge_runtime.sql
GENGYUN_API_RUNTIME_PASSWORD=<48 hex> GENGYUN_ROTATE_RUNTIME_PASSWORD=0 \
  psql -X -q -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/20-login-roles.sql   # 7)
psql -X -q -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql | tail -n1  # 8) 必须 ok
```

改前/改后的对比探针：

```bash
psql -X -q -v ON_ERROR_STOP=0 -f deploy/postgres-cvm/evidence/probe-runtime-grants.sql
```

文件指纹（本次提交态）：

```
799f3a023ed82a2a666581938369bade8fa59a9ff2aeb2e9c458299c857bf242  20-login-roles.sql
05e7256aec0156bbd6bb783a331896bed8497792d7cc1c62d6628a5d1b31c78b  90-assert-least-privilege.sql
6060902002c2ed81cd2df536436bd094f21e9208b0554b223946ae54ea1b199a  evidence/probe-runtime-grants.sql
```

（改前基线 `bec9631d…` / `dfe2e450…` 见 `.pg17/handoff/r28-s24-sha-before.txt`；本次是**有意修改**，
不是「还原后应逐字节相等」的场景。所有负控制都是 DB 侧动作，不涉及文件字节还原。）

## 9. 判据口径：`FAIL` 时 `psql` 退出码仍是 0

实测（§7 每条变异）：输出 `FAIL: …` 时 `exit=0`。因为 `90-assert` 通篇是 `SELECT`，`psql` 没有
「断言失败」的概念。所以：

- 判据**必须**是「最后一行非空输出是否恰为 `ok`」；`provision-db.sh:362-370` 就是这么做的
  （`sed '/^[[:space:]]*$/d' | tail -n1`，非 `ok` 即 `fail`）。
- 本片**没有**改退出码语义（属于行为变更，且会让调用方的「`|| true` + 末行」判法之外出现非预期
  非零）。全部调用方都按「末行」判：`provision-db.sh:362-370`（`sed … | tail -n1`，非 `ok` 即 `fail`）、
  `verify-cvm-postgres.sh:259-267`（`|| true` 后取 `tail -n1`，再 `report_eq 'least_privilege_assert' 'ok'`）、
  `tests/integration/account-suspend-pg.mjs:444` 与 `admin-accounts-read-pg.mjs:264`（检测到 psql
  元命令就跳过，不依赖退出码）、文档里的手工命令都用 `| tail -n1`。
- 副作用：`\echo` 信息行排在判决**之前**，因此不影响末行判据；正常（`recognition_*` 不存在）时
  输出仍然只有一行 `ok`。

## 10. `recognition_*`（迁移 `0025`）草案与取舍

本分支基线 `4122976` **没有** `0025`（它随未合入的 `#333`）；`20-login-roles.sql` 段 H
**不引用**这三张表，`90-assert` 只用 `to_regclass` 软守卫（不存在时零输出）：

```sql
SELECT (to_regclass('public.recognition_jobs') IS NOT NULL
        OR to_regclass('public.recognition_records') IS NOT NULL
        OR to_regclass('public.recognition_idempotency') IS NOT NULL) AS r28_recognition_present \gset
\if :r28_recognition_present
  \echo '提示：检测到 recognition_*（迁移 0025）表存在，但本分支的 sql/20-login-roles.sql 尚未为其授权，'
  \echo '      运行时访问这些表会 42501。授权草案与取舍见本页 §10。'
\endif
```

### 方案 A（软守卫，允许 `0025` 未合入）

```sql
-- 追加到 20-login-roles.sql 段 H 之后；表不存在时只提示、不失败。
DO $$
BEGIN
  IF to_regclass('public.recognition_jobs') IS NULL THEN
    RAISE NOTICE '未检测到 recognition_*（迁移 0025 未执行）：跳过其运行时授权。';
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON TABLE public.recognition_jobs, public.recognition_records,
                              public.recognition_idempotency FROM PUBLIC';
  EXECUTE 'GRANT SELECT (…), INSERT (…), UPDATE (…) ON public.recognition_jobs TO gengyun_api_runtime';
  -- recognition_records / recognition_idempotency 同形；DELETE 仅 idempotency（同 §4.3 理由）
END
$$;
```

```sql
-- 90-assert：manifest 里 required=false + expected 里列清单；
-- 未合入时「不存在 ⇒ 跳过」，合入后「存在 ⇒ 必须逐列符合」。
('recognition_jobs', 'granted', false)
```

### 方案 B（硬断言，要求 `0025` 必须先装）

```sql
DO $$
BEGIN
  IF to_regclass('public.recognition_jobs') IS NULL THEN
    RAISE EXCEPTION '缺少 public.recognition_jobs：迁移 0025 未执行或顺序错误（migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END
$$;
```

`90-assert` 对应把 manifest 的 `required` 改 `true`，并去掉软守卫 `\if`。

### 取舍

| 维度 | A 软守卫 | B 硬断言 |
| --- | --- | --- |
| 未合入 `0025` 的库 | 可正常装机（跳过） | 直接装机失败 |
| 合入后漏授权 | 只有一行提示，`ok` 仍会通过 ⇒ 可能静默 | 立刻红 |
| 顺序耦合 | 无 | 强（必须迁移先于授权） |

**建议**：`0025` 合入后**一次性改成 B**（`required=true` + 无条件 `GRANT` + 硬前置），
因为它与 `user_backup_copies` 的形态不同——后者有列级断言兜底，前者没有。
在那之前保持 A + §10 的 `\echo` 提示，避免本分支引用未存在的表。
**不得**声称「识别域已可部署」：本分支既没有 `0025`，也没有 recognition 的实际授权。

## 11. 为什么原本的 `90-assert` 没发现

> 原来的 `90-assert-least-privilege.sql` 只断言**已经枚举过**的对象：它把 5 个组、运行时角色、
> 若干函数、`users`/`sessions`/`deletion_requests`/`idempotency_keys`/`user_backup_copies` 等
> 逐条钉死，但对「**迁移新建的运行时域表**」没有任何兜底——既没有「这张表必须被授权」的正向清单，
> 也没有「运行时域的表出现却没人分类」的元断言。第 7 条只约束「不得有表级写权限」，而缺授权
> 的方向恰好是「没有权限」，不触发；`has_table_privilege` 对列级授权又恒为 `false`，于是
> 三域整片不可用时，闸门仍然输出 `ok`。R28-S24 补的正是这条元不变量：`domain_manifest` 要求
> 运行时域每张表被**显式分类**（`granted` / `granted_external` / `forbidden`），既不授权也不
> 声明禁访的新表一律判红（NC5 实证），配合 10 条逐表正向+反向列断言与两条零行真执行探针。

## 12. 没做到 / 未取得

1. **真实 CVM 演练：未取得**。全部读数来自本机一次性集群；`install-postgres.sh` / `provision-db.sh`
   的完整链路没有在真实主机上跑过（`provision-db.sh` 的判据逻辑是读代码确认的，不是跑出来的）。
2. **GitHub runner：未取得**。`real-pg-integration.yml` 没有触发过；本次门禁只跑 `lint` /
   `test:contract` / `test:docs` / `verify-contract-status.mjs` 四条本地命令。
3. **`#333`（迁移 `0025`）未合入**：recognition 只有草案与软守卫，**没有**实际授权、**没有**断言。
4. **域外同类缺口：未修、未验**。`favorites`/`favorites_idempotency`/`history`/`history_idempotency`/
   `conversations`/`conversation_turns`/`conversation_answers` 七张表迁移建了、`20-login-roles.sql`
   从没授权过、本片元断言的数据域也没覆盖，`SET ROLE` 实测全部 `42501`
   （`favorites/store-pg.ts:45-52` 会把它折成可重试的 `PROVIDER_UNAVAILABLE`，监控里像下游抖动，
   不像权限缺失）。这与 messages/community/ocr 是**同一类缺口**，本片不修。另，既有
   `users`/`sessions` 等**已授权（列级）**表的列清单也没有复核是否仍与 `store-pg.ts` 一致。
5. **`psql` 退出码语义未改**（§9）：`FAIL` 时仍 `exit=0`。这是有意保留（避免改动既有调用方行为），
   但如果将来有人用 `psql … && echo ok` 当门禁，会假绿。
6. **`community_media_grants`** 在 `domain_manifest` 里分类为 `forbidden`（运行时零权限）——
   这是本片按「运行时域命名前缀」推断出的分类，代码里确实没有对它做任何写/读（`grep` 只命中迁移），
   但如果将来社区媒体授权要落库，需要重新分类。
7. **没改** `deploy/postgres-cvm/README.md`（派单要求先回报）：因此 README 的
   「90-assert 15 项断言 / 已由外部真实 PG 执行通过」等描述仍是旧数字，需要另行更新。

## 13. 与派单/裁定的对应

| 裁定条件 | 落点 |
| --- | --- |
| 1 结构化允许清单 | §4.3、§5、NC1/NC2 |
| 2 逐表范围断言（正反） | §5 `runtime_grants_<表>` ×10 |
| 3 四条负控制 | §7.1/§7.2（NC1–NC4） |
| 4 避免假红（零行探针） | §5 第 45/46 条、§3.2 探针设计 |
| 5 元断言 + 一次变异 | §5 第 47 条、NC5 |
| 6 recognition 软守卫 + `\echo` | §10 |
| 7 禁改面 | 仅改 `20-login-roles.sql`、`90-assert`、`evidence/probe-runtime-grants.sql`、本页 |
| 8 断言改前/改后对照 | §5 |
| 9 「为什么没发现」定稿 | §11 |
| A 三段判决证明 | §6 |
| B（父级）「psql 退出码」告警 | §9 |
