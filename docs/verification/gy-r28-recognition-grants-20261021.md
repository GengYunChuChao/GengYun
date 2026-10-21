# R28-S28 · 识别域运行时最小权限授权（迁移 0025 四表）与 S24 软守卫收敛

> 切片：R28-S28；分支 `fix/gy-r28-recognition-grants`；基线 `c06d232`（= `upstream/main`，含 #340 S26、#333 迁移 0025）。
> 交付物：`deploy/postgres-cvm/sql/20-login-roles.sql` 段 J；`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 七处改动 + 三条新断言；`deploy/postgres-cvm/evidence/probe-runtime-grants.sql` 第 [6] 节；本页。
> 问题一句话：迁移 0025 建了四张识别表，`20-login-roles.sql` 对 `recognition_` 零命中 ⇒ 运行时角色 `gengyun_api_runtime` 对四表整表零权限，识别域的每一次读/写都是 `42501`；而 S24 的软守卫在 90-assert 里只打印两行提示，末行仍然是 `ok`（假绿）。

**取证范围声明**：本页所有读数来自**本机一次性 PG 17.11 集群**（`127.0.0.1:55641`，datadir `E:\GengYunCommander\.pg17\data-r28s28`），没有在真实 CVM、没有在 GitHub Actions runner 上跑过；`provision-db.sh` 本体也没有执行（按它的顺序手工复现）。未取得项逐条列在 §12。

## 0. 结论摘要

| 项 | 改前 | 改后 |
|---|---|---|
| 四张识别表的表级 SELECT/INSERT/UPDATE/DELETE/TRUNCATE | 全 `f`（零权限） | 仍全 `f`，但列级 `sel/ins/upd` = 12/12/5、12/12/7、8/8/0、6/6/4 |
| `recognition_idempotency` 表级 DELETE | `f` | **`t`**（唯一新增的表级写授权） |
| 19 条真实语句形状（15 正向 + 4 禁止面） | 19 × `42501` | 15 条成功（`0 rows`），4 条禁止面仍 `42501` |
| 90-assert 末行 | `ok`，**前面只有软守卫两行提示**（假绿） | `ok`，前面是四条**预期**的 `42501`（禁止面探针） |
| 90-assert 断言数 | 71 | **78**（`78\|78\|0`） |
| 缺 0025 时的部署行为 | 90-assert 打印提示，仍然 `ok` | 20-login-roles **exit 3**，`ERROR: 缺少识别域表：recognition_jobs…` |
| 变异 7 条（m1/m2/m3/m3b/m4/m5/m6） | — | 全部按预期判红，复原后文件 `sha256` 逐字节相等 |
| 门禁 5 道 + `recognitions-pg.mjs` | — | 全绿（§8） |

## 1. 范围

### 1.1 做了什么

1. `20-login-roles.sql` 追加段 J：缺表**硬前置**（方案 B）→ `REVOKE ALL … FROM PUBLIC` → 四表逐列 `GRANT` → 三条摘要 `\echo`。
2. `90-assert-least-privilege.sql`：删软守卫整块与头部「信息行只用一处」一句；manifest 四行翻成 `granted/true`；expected 加四行；allow_table_dml 11→12；#48 的 detail 改为由清单生成；新增真执行探针块（21 条语句、账号内回滚）与三条断言（#64/#65/#66）。
3. `probe-runtime-grants.sql` 第 [6] 节：四表零行探针（正向 0 行 + 四条禁止面必须 `42501`）。
4. 本页 + 变异实验 + 门禁。

### 1.2 没做什么（边界）

- 没有改 `services/**`、`apps/**`、`packages/**`、迁移（含 0025）、`services/api/db/roles/*.sql`、`.github/workflows/*`、`tests/**`。
- 没有动 S24/S26 的证据页与它们的授权段（H/I 段原样）。
- 没有删改 90-assert 既有断言，除了派单 §4 明确要求的「软守卫整块」与三处文案（头注释一句、manifest 两处注释、#48 detail、#49-58 头注释）。
- 没有 push、没有打 tag、没有建 PR（指挥统一收口）。

## 2. 环境与取证方式

| 项 | 值 |
|---|---|
| 服务端 | PostgreSQL **17.11**（`E:\GengYunCommander\.pg17\pgsql\bin`） |
| 集群 | 一次性 `127.0.0.1:55641`，datadir `E:\GengYunCommander\.pg17\data-r28s28`，`initdb -E UTF8 --locale=C --auth-host=scram-sha-256 --auth-local=trust` |
| 引导身份 | `gengyun_cvm_owner`（本机由 `initdb -U` 建成 **superuser**；生产是 `CREATEROLE` 非 `SUPERUSER`，差异见 §12） |
| 库 | `gengyun`，属主 `gengyun_cvm_owner`；`public` 下 66 张表、属主全部是 `gengyun_cvm_owner` |
| 迁移 | `migrations=25`（0001…0025，末位 0025） |
| 角色文件 | `services/api/db/roles/` 八个按依赖顺序全部应用（auth_privacy → catalog_readers → consent_granter → egress_ledger → profile_runtime → knowledge_runtime → source_operator → staging_importer） |
| 运行时角色 | `gengyun_api_runtime`：`super=false, createrole=false, createdb=false, bypassrls=false`；组成员 5 个（`gengyun_auth_privacy`,`gengyun_consent_granter`,`gengyun_knowledge_runtime`,`gengyun_preview_reader`,`gengyun_profile_runtime`） |
| 口令 | 一次性合成，只落 `.pg17/tmp/r28-s28/*_pw.txt`，**不进 argv、不落在本页**（`20-login-roles.sql` 用 `\getenv` 从环境变量取） |
| 客户端 | `psql` 17.11；`PGCLIENTENCODING=UTF8`；日志由 `cmd /c … > log 2>&1` 产出 UTF-8（无 BOM） |

取证纪律：**真执行**（`SET ROLE` 后发真语句），不靠 `has_table_privilege` 自证；写入探针一律零行或事务内回滚（库里不留行）；`\set VERBOSITY verbose` 才带 SQLSTATE 与 `LOCATION`。

## 3. 改前

### 3.1 表级与列级矩阵：四表整表零权限

`matrix-prefix.log`（四表，`SET ROLE` 前后的 `has_table_privilege` / `aclexplode` 读数）：

| relation | sel_tbl | ins_tbl | upd_tbl | del_tbl | trunc_tbl | any_col | relacl_runtime | cols_with_acl | public_tbl_acl | public_col_acl |
|---|---|---|---|---|---|---|---|---|---|---|
| public.recognition_jobs | f | f | f | f | f | f | f | 0 | 0 | 0 |
| public.recognition_records | f | f | f | f | f | f | f | 0 | 0 | 0 |
| public.recognition_selections | f | f | f | f | f | f | f | 0 | 0 | 0 |
| public.recognition_idempotency | f | f | f | f | f | f | f | 0 | 0 | 0 |

列级明细（`sel_n/ins_n/upd_n` 全 0，列清单为空）。对照：同一矩阵里 S24/S26 的十张表是表级 `f` + 列级 `t` —— 也就是说这张表一眼能看出「识别域根本没被授权段覆盖」，而不是「授权方式不同」。

### 3.2 19 条真实语句形状逐条 `42501`

探针源 `.pg17/tmp/r28-s28/probe-phase1.sql`（`\set VERBOSITY verbose` + `SET ROLE gengyun_api_runtime`，全部零行/零改动，`BEGIN … ROLLBACK`）。日志 `phase1-prefix.log`（57 行 = 19 标签 + 19 错误 + 19 LOCATION）。错误原文的格式**逐字相同**，只有表名与探针行号不同：

```
psql:E:/GengYunCommander/.pg17/tmp/r28-s28/probe-phase1.sql:12: ERROR:  42501: permission denied for table recognition_jobs
LOCATION:  aclcheck_error, aclchk.c:2845
psql:E:/GengYunCommander/.pg17/tmp/r28-s28/probe-phase1.sql:21: ERROR:  42501: permission denied for table recognition_jobs
LOCATION:  aclcheck_error, aclchk.c:2845
```

逐条（19/19，`probe-phase1.sql` 行号 → 表）：

| # | 语句形状（代码出处，`services/api/src/recognitions/store-pg.ts`） | 错误表 |
|---|---|---|
| 1 | jobs `SELECT` 12 列（:576 / :587，`JOB_COLUMNS`） | recognition_jobs |
| 2 | jobs `INSERT` 12 列 `RETURNING id`（:184-186） | recognition_jobs |
| 3 | jobs `UPDATE` 5 列 `WHERE id AND revision RETURNING` 12 列（:592-601） | recognition_jobs |
| 4 | jobs `SELECT … FOR UPDATE`（:612-614） | recognition_jobs |
| 5 | records `SELECT` 12 列（:656-658，`RECORD_COLUMNS`） | recognition_records |
| 6 | records `INSERT` 12 列 `RETURNING id`（:188-190） | recognition_records |
| 7 | records `UPDATE` 7 列 `WHERE id AND revision`（:676-698 / :730-751） | recognition_records |
| 8 | records `SELECT … FOR UPDATE`（:707-709） | recognition_records |
| 9 | selections `SELECT` 8 列（:762-767，`SELECTION_COLUMNS`） | recognition_selections |
| 10 | selections `INSERT` 8 列 `RETURNING` 8 列（:192-194） | recognition_selections |
| 11 | idempotency `SELECT` 4 列（:216-218） | recognition_idempotency |
| 12 | idempotency claim：`INSERT` 6 列 + `ON CONFLICT DO UPDATE` 4 列 + `WHERE expires_at`（:206-214） | recognition_idempotency |
| 13 | idempotency complete：同上、`pending=false`（:221-227） | recognition_idempotency |
| 14 | idempotency release：`DELETE … WHERE scope AND key_hash AND pending`（:819-823） | recognition_idempotency |
| 15 | idempotency purge：`DELETE … WHERE expires_at <= $1 RETURNING scope`（:829-834） | recognition_idempotency |
| 16 | **禁止面** selections `SELECT … FOR UPDATE`（store 不用；无 UPDATE 授权） | recognition_selections |
| 17 | **禁止面** jobs `DELETE`（注销走属主级联，运行时不该能删） | recognition_jobs |
| 18 | **禁止面** records `DELETE`（同上） | recognition_records |
| 19 | **禁止面** selections `DELETE`（同上） | recognition_selections |

说明：16–19 是**本来就该失败**的四条；改前它们也 `42501`，只说明「零权限」这一事实对正反两面同时成立。改后这四条必须**继续** `42501`（§5.3），这才是有信息量的读数。

### 3.3 反向控制：同一 `DELETE` 在授权前 / 临时授权后 / 撤销后

`reverse-control.log`（脚本 `.pg17/tmp/r28-s28/reverse-control.sql`）：

```
=== A. 授权前：DELETE 同一行（期望 ERROR 42501，行明明存在）===
psql:…/reverse-control.sql:29: ERROR:  42501: permission denied for table recognition_jobs
LOCATION:  aclcheck_error, aclchk.c:2845
=== A2. 同角色：列级授权覆盖的 INSERT（期望成功，不需要表级 INSERT）===
a2_affected_rows=1
=== 临时只授予表级 DELETE ===
 del_after_grant
-----------------
 t
=== B. 授权后：同一条 DELETE（期望成功，DELETE 1）===
b_affected_rows=1
=== 撤销表级授权 ===
=== C. 撤销后：同一条 DELETE（期望再次 ERROR 42501）===
psql:…/reverse-control.sql:67: ERROR:  42501: permission denied for table recognition_jobs
LOCATION:  aclcheck_error, aclchk.c:2845
=== 复原核验：表级 DELETE 必须为 f，relacl 里不得有运行时角色（新语句，事务外）===
 del | trunc | relacl_runtime_rows
-----+-------+---------------------
 f   | f     |                   0
```

两条方法学结论（都写进代码注释与 §12）：

- **不能用列清单 `INSERT`/`SELECT`/`UPDATE` 当对照臂**：PG 允许语句里点名的列由**列级**授权满足，段 J 已逐列授权，这些语句本来就该成功。只有 `DELETE` / `TRUNCATE` 是纯表级动作，才能证明 `42501` 来自「权限缺失」而不是「语句写错」。
- `42501` 会中止当前子事务，对照臂每条都必须包 `SAVEPOINT`，否则后续全是 `25P02 current transaction is aborted`。

### 3.4 改前 90-assert 是「假绿」

`pre-change-assert.log` 全文（只有三行）：

```
提示：检测到 recognition_*（迁移 0025）表存在，但本分支的 sql/20-login-roles.sql 尚未为其授权，
      运行时访问这些表会 42501。授权草案与取舍见 docs/verification/gy-r28-least-privilege-grants-20261020.md。
ok
```

S24 当时没有 0025，软守卫（`to_regclass` 三表任一存在 ⇒ `\if` 里 `\echo` 两行）是合理的临时口子；0025 合入后它变成了「部署顺序错了也报 ok」的漏洞：`provision-db.sh` 只读最后一行判 `ok`，于是 `20-login-roles.sql` 漏跑、识别域整表零权限，也能通过发布门禁。

## 4. 授权设计

### 4.1 列集从代码反推（不是从建表语句猜）

以 `store-pg.ts` 的**真实语句**逐列反推，行号按该文件 node 行号：

- 列常量：`JOB_COLUMNS` :177-178、`RECORD_COLUMNS` :179-180、`SELECTION_COLUMNS` :181-182。
- 写入：`INSERT_JOB` :184-186（12 列）、`INSERT_RECORD` :188-190（12 列）、`INSERT_SELECTION` :192-194（8 列）。
- 读回：`getJob` :576、`updateJob` 的 `SELECT` :587、`commitTerminal` 的 `SELECT … FOR UPDATE` :612-614、`getRecognition` :656-658、`updateRecognition` 的 `SELECT` :668-670、`commitSelection` 的 `SELECT … FOR UPDATE` :707-709、`listSelections` :762-767。
- 更新：`updateJob` :592-601（`SET revision, state, deadline_at, updated_at, error_code`）、`updateRecognition` :676-698（7 列）、`commitTerminal` :632-641（jobs 5 列）、`commitSelection` :730-751（records 7 列）。
- 幂等台账：claim :206-214、select :216-218、complete :221-227、release :819-823、purge :829-834。
- 就绪探测 `TABLES_READY_SQL` :168-172 用 `to_regclass`，**不需要表权限**，所以「表在不在」的判定与授权无关。

最终列集（与段 J 的 `GRANT` 一一对应）：

| 表 | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `recognition_jobs` | 12 列 | 12 列 | `revision, state, deadline_at, updated_at, error_code`（5） | ✗ |
| `recognition_records` | 12 列 | 12 列 | `revision, candidates, uncertainty_reasons, selected_species_id, model_version, updated_at, deleted`（7） | ✗ |
| `recognition_selections` | 8 列 | 8 列 | ✗（追加型） | ✗ |
| `recognition_idempotency` | 6 列 | 6 列 | `request_hash, payload, pending, expires_at`（4） | **表级** |

### 4.2 为什么 `recognition_idempotency` 需要**表级** `DELETE`

PG 没有列级 `DELETE`，而 store 有两条整行删除：

```sql
-- releaseIdempotent :819-823
DELETE FROM public.recognition_idempotency
 WHERE scope = $1 AND key_hash = $2 AND pending;

-- purgeIdempotent :829-834
DELETE FROM public.recognition_idempotency
 WHERE expires_at <= $1::timestamptz
RETURNING scope;
```

所以只能表级授权；它是本片**唯一**新增的表级写授权，与 S24/S26 的五张幂等台账（`idempotency_keys`、`community_idempotency`、`ocr_idempotency`、`favorites_idempotency`、`history_idempotency`）同性质 —— 那些表的 `DELETE` 早就在 `allow_table_dml` 里。`allow_table_dml` 因此 11 → **12**，`expected` 里 `recognition_idempotency` 的 `del` 为 `true`，其余三表 `false`。

### 4.3 为什么 `SELECT … FOR UPDATE` **不**另授 `UPDATE (revision)` 行锁载体

`FOR UPDATE` 需要目标表上至少**一列**的 `UPDATE` 权（行锁载体），而两张表的行锁都出现在「本来就要写这张表」的语句里：

| 位置 | 语句 | 同一语句随后做的写 |
|---|---|---|
| `commitTerminal` :612-614 | `SELECT ${JOB_COLUMNS} FROM public.recognition_jobs WHERE id = $1::uuid FOR UPDATE` | `UPDATE … SET state, error_code, revision, updated_at`（:632-641，5 列） |
| `commitSelection` :707-709 | `SELECT ${RECORD_COLUMNS} FROM public.recognition_records WHERE id = $1::uuid FOR UPDATE` | `UPDATE … SET revision, candidates, uncertainty_reasons, selected_species_id, model_version, updated_at, deleted`（:730-751，7 列） |

⇒ 行锁由这 5 列 / 7 列 `UPDATE` 授权**顺带**满足，不需要 S26 的 `UPDATE (revision)` 那种「只为行锁而授」的载体（S26 的 `conversations`/`conversation_turns` 没有真实 `UPDATE` 列，才必须补载体）。**性质不同，别照抄 I 段那句注释**。

`recognition_selections` 不授任何 `UPDATE`，因此它对 `FOR UPDATE` 仍然 `42501`（探针 [16]）；store 从不在 selections 上开锁 —— 选中结果的写入落在 `recognition_records.selected_species_id` 上。

### 4.4 `ON CONFLICT DO UPDATE` 的列需求

```sql
-- CLAIM_IDEMPOTENT :206-214
INSERT INTO public.recognition_idempotency (scope, key_hash, request_hash, payload, pending, expires_at)
     VALUES ($1, $2, $3, '{}'::jsonb, true, $4::timestamptz)
ON CONFLICT (scope, key_hash) DO UPDATE
        SET request_hash = EXCLUDED.request_hash,
            payload = EXCLUDED.payload,
            pending = EXCLUDED.pending,
            expires_at = EXCLUDED.expires_at
      WHERE public.recognition_idempotency.expires_at <= $5::timestamptz
  RETURNING scope;
```

- `SET` 的 4 列就是 `UPDATE` 的 4 列；`scope`/`key_hash` 是冲突目标，**不**在 `SET` 里，所以不需要它们的 UPDATE 权。
- 冲突推断 `(scope, key_hash)`、`EXCLUDED.*`、`WHERE expires_at`、`RETURNING scope`、`DO UPDATE` 的 `WHERE` 全都要读 ⇒ 这 6 列的 `SELECT` 一列不能少（`completeIdempotent` :221-227 同形，`pending=false`）。
- 探针 [12]/[13] 走的是**真冲突**（先插一行 `expires_at = now() - 1h` 的种子行，再 claim 触发 `DO UPDATE`），不是「只解析不执行」。

### 4.5 授权区形态（段 J，`20-login-roles.sql` L688-799）

与 H 段 / I 段同构的四步，缺一步都可能让「漏表」变成静默失败：

1. **缺表硬前置**（方案 B，S24 证据页 §10 的裁决）：

```sql
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO missing
    FROM unnest(ARRAY['recognition_jobs', 'recognition_records',
                      'recognition_idempotency', 'recognition_selections']) AS t(name)
   WHERE to_regclass('public.' || t.name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '缺少识别域表：%（迁移 0025 未执行；顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。', missing;
  END IF;
END;
$$;
```

   实测：把 `recognition_jobs` 改名后跑本文件 ⇒ `psql:…:747: ERROR:  缺少识别域表：recognition_jobs（迁移 0025 未执行；顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。` + `CONTEXT:  PL/pgSQL function inline_code_block line 10 at RAISE`，**exit=3**（§7 m6）。

2. **`REVOKE ALL … FROM PUBLIC`**（四表一次性列举；PUBLIC 默认不进任何授权，见 §7 m5）。
3. **逐表逐列 `GRANT`**（注释里写清该表的粒度与代码出处；`recognition_idempotency` 多一行表级 `GRANT DELETE`）。
4. **三条摘要 `\echo`**（列级摘要 / DELETE 摘要 / FOR UPDATE 性质）—— 它们出现在部署日志里，是本段「跑到了」的证据，但**判决仍只由 90-assert 的末行给**。

### 4.6 刻意不授的四类

- `TRUNCATE` / `REFERENCES` / `TRIGGER`：一律不给（表级结构动作，运行时不需要）。
- 表级 `INSERT` / `UPDATE`：一律不给（`has_table_privilege` 读数为 `f`，由 #49-58 钉死）。
- `recognition_selections` 的 `UPDATE`：不给（追加型；改选落在 records 上）。
- `jobs` / `records` / `selections` 的 `DELETE`：不给。注销路径是 `public.request_account_deletion()`（`0016_account_deletion_persistence.sql:68`，`SECURITY DEFINER`，属主是迁移管理员，运行时只有 EXECUTE），它改的是 `users.state`；四表的 `owner_user_id` 都是 `ON DELETE CASCADE`，真到硬删 `users` 行时由属主身份级联清理，**不经过运行时角色**（仓内目前没有 `DELETE FROM public.users` 的迁移；本片也没做硬删除演练，见 §12）。

## 5. 改后

### 5.1 `20-login-roles.sql` 执行

`post-change-grant.log`：exit=0，末四行是段 J 的 `--- J. 运行时域（识别）列级授权（R28-S28，迁移 0025）---` + 三条摘要。日志里另有 S26 的 `NOTICE: role "gengyun_api_runtime" has already been granted membership in role …`（重复授予组角色，正常）。

### 5.2 矩阵（`matrix-post.log`）：表级仍全 `f`，列级按设计

| relation | sel_tbl | ins_tbl | upd_tbl | del_tbl | trunc_tbl | any_col | relacl_runtime | cols_with_acl | public_tbl_acl | public_col_acl |
|---|---|---|---|---|---|---|---|---|---|---|
| public.recognition_jobs | f | f | f | f | f | t | f | 12 | 0 | 0 |
| public.recognition_records | f | f | f | f | f | t | f | 12 | 0 | 0 |
| public.recognition_selections | f | f | f | f | f | t | f | 8 | 0 | 0 |
| public.recognition_idempotency | f | f | f | **t** | f | t | **t** | 6 | 0 | 0 |

列级明细（`sel_cols` / `ins_cols` / `upd_cols` 逐列展开后计数）：`12/12/5`、`12/12/7`、`8/8/0`、`6/6/4` —— 与派单 §9 的指挥预验证矩阵**逐格一致**，也与 §4.1 的代码反推一致。

### 5.3 19 条形状（`phase1-post.log`）

- [1]–[15]：全部成功，且都是 `(0 rows)`（零行探针，库里没有任何行被写）。
- [16]–[19]（禁止面）：`ERROR:  42501: permission denied for table recognition_selections|jobs|records|selections` + `LOCATION:  aclcheck_error, aclchk.c:2845` —— 与改前同一条错误，说明「该拒的仍然拒」。

### 5.4 90-assert 实跑：末行 `ok`

`post-change-assert.log` 全文（5 行）：

```
psql:…/90-assert-least-privilege.sql:663: ERROR:  permission denied for table recognition_selections
psql:…/90-assert-least-privilege.sql:669: ERROR:  permission denied for table recognition_jobs
psql:…/90-assert-least-privilege.sql:675: ERROR:  permission denied for table recognition_records
psql:…/90-assert-least-privilege.sql:681: ERROR:  permission denied for table recognition_selections
ok
```

这 4 行是禁止面探针**预期**的 `42501`（psql 在 `ON_ERROR_STOP off` 段里把错误打到 stderr，不影响判决）；判决只看末行。

计数变体（把末段 `CASE` 换成 `count(*) FILTER (WHERE ok)` 汇总，源 `.pg17/tmp/r28-s28/90-assert-count.sql`，**不入库**）：`assert-count.log` 末行 **`78|78|0`**（total|ok|bad）。S26 时是 71：+4 来自 `expected` 的四行（数据驱动断言 #49-58 每张表一条），+3 是本片新增的 #64/#65/#66。

### 5.5 `probe-runtime-grants.sql` 第 [6] 节

`probe-runtime-grants-post.log` 尾部（节选）：

```
-- [recognition_selections] SELECT 8 列 / INSERT 8 列（追加型、无 UPDATE；故 FOR UPDATE 属于禁止面）
 id | revision | recognition_id | owner_user_id | species_id | provenance | decided_at | linkage
----+----------+----------------+---------------+------------+------------+------------+---------
(0 rows)
-- 以下是禁止面：四表 DELETE 与 selections 的 FOR UPDATE 必须全部 42501
psql:…/probe-runtime-grants.sql:527: ERROR:  42501: permission denied for table recognition_jobs
LOCATION:  aclcheck_error, aclchk.c:2845
…
-- [6] 识别域探针结束（正向行成功即无输出；上面四条禁止面各应有一行 ERROR: 42501 …）
### 探针结束（exit 码无意义：ON_ERROR_STOP=0 是设计的一部分）
```

整个文件实跑下来**只有 4 条 ERROR**，全部是这四条预期拒绝；没有别的错误被吞掉。

## 6. 断言改动（`90-assert-least-privilege.sql`）

| # | 改动 | 位置/形态 |
|---|---|---|
| E1 | 头部注释删「信息行只用一处：S24 软守卫」，改成「软守卫已收敛为硬前置；唯一约定是**最后一行是判决**」 | 头注释 |
| E2 | **删软守卫整块**（注释 + `to_regclass` 三表 OR 的 `\gset` + `\if` + 两条 `\echo` + `\endif`） | 原 L94-105 |
| E3 | manifest 三行 `recognition_*` 由 `forbidden,false` 翻成 `granted,true`；`recognition_selections` 的「权宜快照」注释删掉、行翻成 `granted,true`；注释改成「0025 已随 #333 合入 main（341ad8c），本片按 S24 证据页 §10 的方案 B 硬前置」 | manifest，现 L712-728 |
| E4 | `expected` 加四行（jobs/records 12 列 + 5/7 列 UPDATE、`del=false`；selections 8 列 + `ARRAY[]::text[]` + `false`；idempotency 6 列 + 4 列 + **`true`**） | 现 L853-881 |
| E5 | `allow_table_dml` 加 `('public','recognition_idempotency','DELETE')`，11→12 | 现 L903 |
| E6 | #48 `runtime_domain_forbidden_tables_untouched` 的 detail 改为**由清单生成**（SQL 里用 `string_agg` 从 manifest 的 forbidden 集合拼出表名，不再手写） | 现 #48 |
| E7 | #49-58 头注释由「只有 likes / 两张幂等台账为 true」改成「DELETE 必须恰好等于 del 列声明；本片起含 recognition_idempotency」 | 现 #49-58 上方 |
| N1 | 新增真执行探针块（21 条语句：角色 1 + 正向 17 + 禁止面 4；事务内回滚，含一行探针 `users`） | 插在 S26 探针结束之后 |
| N2 | **#64 `runtime_recognition_dml_exec`**：17 个正向变量必须全是 `false`（`ERROR` 为空） | 断言区 |
| N3 | **#65 `runtime_recognition_forbidden_surface`**：4 个禁止面变量必须全是 `true` | 断言区 |
| N4 | **#66 `public_no_privilege_domain_granted`**：遍历 manifest 里所有 `granted`/`granted_external` 行，表级 `relacl` 与列级 `attacl` 两处 `aclexplode` 查 `grantee = 0`，命中数必须为 0（自动覆盖 S24 十表 + S26 七表 + 本片四表） | 断言区（既有 #62 保留不动） |

探针块的三个实现细节（都是踩过的坑）：

- **固定探针 UUID**（`28a28a28-…-0001/0002/0003`），不靠 `\gset` 回读：某条 INSERT 失败时，后续 UPDATE/FOR UPDATE/DELETE 仍是合法 SQL，不会变成语法错。
- 真行语句用 `SAVEPOINT; 语句; \set v :ERROR; \if :v ROLLBACK TO SAVEPOINT / \else RELEASE SAVEPOINT`；纯零行语句用 `SAVEPOINT; 语句; \set v :ERROR; ROLLBACK TO SAVEPOINT`。
- 幂等台的三条语句必须**按 order 排**：先 purge（`expires_at <= now()` 且只命中一行），再 claim/complete（真冲突），否则 purge 会命中多行，`\gset` 报 `more than one row returned for \gset` 并把 `:ERROR` 置 true（已实测）。

## 7. 变异实验

每条都走「施加 → 跑 → 逐字节还原 → `sha256` 相等 → 复原授权 → 复跑 `ok`」。文件基线（改后、变异前）：

- `20-login-roles.sql`：`65B6A00B27C46A1FBDF8F5A2F564B289D79C56EC4B2B84DC81E859F0AB8489C7`（53 792 B）
- `90-assert-least-privilege.sql`：`8F46C113996F990E5DFFA6AD6CB05455DD767A7CBE4B62529CA8BBD76885AB28`（98 597 B）
- `probe-runtime-grants.sql`：`1F32FBBD1039BBA27C6FF5EC792BFB1E9C7029B4F1DE31B8ACD780E47F8ED4A6`（27 477 B）

| 变异 | 施加 | 判红原文（FAIL 里点名的断言） | 还原 |
|---|---|---|---|
| m1 | 段 J 的 selections `INSERT` 摘掉 `decided_at` 一列 | `FAIL: runtime_grants_recognition_selections (…); runtime_recognition_dml_exec (…十七种真实语句形状必须全部成功…)` + 4 条 `ERROR: permission denied for table recognition_*` | 文件 `sha256` = 基线，`equal=true`；复位后 `ok` |
| m2 | 段 J 给 records 追加表级 `GRANT UPDATE` | `FAIL: runtime_grants_recognition_records (…); table_dml_allowlist (表级写权限只允许 …recognition_idempotency{DELETE}；清单外的表或类型一律失败…)` | `equal=true`；复位后 `ok` |
| m3 | 删 manifest 的 `('recognition_jobs', 'granted', true)` 行 | `FAIL: runtime_domain_tables_classified (运行时域的每张表必须进分类清单…)` | `equal=true` |
| m3b | 删 manifest 的 selections 行（**连上一行尾逗号**；首次只删行 ⇒ 语法错 `LINE 36: ),`，不是断言红，故改补丁） | `FAIL: runtime_domain_tables_classified (…)`；**加回该行 ⇒ `ok`** | `equal=true` |
| m4 | `expected` 里 `recognition_idempotency` 的 `true)` → `false)`（锚点必须从该行行首起算，否则先命中 `ocr_idempotency`） | `FAIL: runtime_grants_recognition_idempotency (列级 SELECT/INSERT/UPDATE 必须与清单逐列一致…；表级只允许 del=true 的表有 DELETE…)` | `equal=true` |
| m5 | 库内 `GRANT SELECT ON public.recognition_jobs TO PUBLIC`（`public_acl_rows_before=0` → `after=1`、`public_can_select=t`） | `FAIL: knowledge_runtime_scope (…); public_no_privilege_domain_granted (manifest 里 granted / granted_external 的表对 PUBLIC 必须零权限…)` | `REVOKE` ⇒ `public_acl_rows=0`、`public_can_select=f`；复跑 `ok` |
| m6 | 库内 `ALTER TABLE public.recognition_jobs RENAME TO recognition_jobs_r28tmp` 后跑 20-login-roles | **exit=3**：`ERROR:  缺少识别域表：recognition_jobs（…）` + `CONTEXT: PL/pgSQL function inline_code_block line 10 at RAISE` | 改回名 ⇒ 20-login-roles exit=0，复跑 `ok` |

m3b 的两段原文（派单 §1 要求「删掉该行 ⇒ FAIL / 加回 ⇒ ok」）：

```
FAIL: runtime_domain_tables_classified (运行时域的每张表必须进分类清单（granted/granted_external/forbidden）；新增表既不授权也不声明 forbidden ⇒ 失败)
```

```
ok
```

## 8. 门禁

| 命令 | 退出码 | 末行/摘要 |
|---|---|---|
| `npm run lint` | 0 | `lint 通过（静态检查；不代表运行期或真实服务已通过）。`（tsc×2 + 仓库卫生扫描 PASS） |
| `node tools/verify-release-materials.mjs` | 0 | `15/15 项通过（离线文档核验；不代表部署、云端或运行期已验收）` |
| `npm run test:docs` | 0 | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住` + `PASS docs/research 结构校验` |
| `node tools/verify-contract-status.mjs` | 0 | `PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；…形状错误 0 项；语义错误 0 项` |
| `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | `tests 6 / pass 6 / fail 0` |
| `node tests/integration/recognitions-pg.mjs`（新库 + `RECOGNITIONS_PG_TEST_URL`） | 0 | `共 30 条 PASS，耗时 1691ms` + `ALL PASS` + `EXITCODE=0` |

`recognitions-pg.mjs` 用**全新空库**（脚本第一步断言 `public` 表数 = 0），以属主身份跑迁移三连与 13 个方法语义；它的 `PASS 1: [M0] … 0025_recognitions_persistence.sql 是末位` **没有红** —— 本机 25 片集群上「0025 末位」仍然成立（派单预告它可能红，实际未发生；将来 0026 落地后这条 pin 会红，归 #336）。

## 9. 继承缺口与 psql 退出码

- **90-assert 失败时 psql 退出码仍是 0**：判决是一个 `SELECT`，不是 psql 错误。发布链只靠 `provision-db.sh` 读「最后一行非空输出」判 `ok`；这是既有设计，本片没有改（也不在授权范围）。
- 因此 **N1 的探针块必须自己判**：每条形如 `\set v :ERROR`，最终由 #64/#65 把「17 个 `false` + 4 个 `true`」变成一条会出现在末行的 `FAIL`。只 `\echo` 提示的方案（S24 软守卫）已被本片删除。
- 探针块在 `BEGIN … ROLLBACK` 内，库里不留行；插入的探针 `users` 行也随 `ROLLBACK` 消失（这也是它能无条件 `ON CONFLICT (id) DO NOTHING` 的原因）。

## 10. 复现步骤（本机，不含口令）

```text
1) initdb -U gengyun_cvm_owner -E UTF8 --locale=C --auth-host=scram-sha-256 --auth-local=trust
   （datadir 自定；postgresql.conf 里 port=55641、listen_addresses='127.0.0.1'）
2) 起库（Windows 用 Win32_Process Create，不用 pg_ctl start）；给 owner 设口令后把 pg_hba 改回 scram
3) createdb gengyun（owner=gengyun_cvm_owner）
4) DATABASE_URL=… node services/api/db/migrate.ts up         # 已应用 0001…0025
5) 按顺序 psql -f services/api/db/roles/{auth_privacy,catalog_readers,consent_granter,egress_ledger,
   profile_runtime,knowledge_runtime,source_operator,staging_importer}.sql
6) GENGYUN_API_RUNTIME_PASSWORD=<48 位小写 hex> psql -f deploy/postgres-cvm/sql/20-login-roles.sql
   （口令走环境变量 + \getenv，绝不进 argv）
7) psql -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql    # 末行必须是 ok
8) psql -f deploy/postgres-cvm/evidence/probe-runtime-grants.sql    # 只应有 4 条预期 42501
9) node tests/integration/recognitions-pg.mjs（另建空库 + RECOGNITIONS_PG_TEST_URL）
```

## 11. 为什么既有测试没发现

- `tests/integration/recognitions-pg.mjs` 连库用**属主**身份（superuser/owner），ACL 对它不生效；它证明的是「数据在库里还在、CAS 语义对」，**不证明**「运行时角色能不能发这些语句」。
- 90-assert 之前对 recognition 只有软守卫 + 三行 `forbidden,false` 分类，末行永远是 `ok`；`forbidden` 断言只看「有没有表级/列级权限落在运行时角色上」，而当时是**零权限**，所以那条断言是真绿 —— 它证明的是「没多给」，不是「给够了」。
- 仓内没有「以 `gengyun_api_runtime` 身份跑识别域真实语句」的测试；本片的 21 条探针就是补这个洞的最小可回归形态（不依赖识别提供者/媒体端口）。

## 12. 未取得

1. **真实 CVM / 生产 PG 未跑**：本页所有读数来自本机一次性集群；没有部署、没有连接真实 CVM。
2. **GitHub Actions runner 未跑**：本片没有任何 CI 读数。
3. **`provision-db.sh` 本体未跑**：按其顺序手工复现（bash 脚本未在本机执行）。
4. **PUBLIC 默认权限的真实差异未测**：本机 `public_tbl_acl`/`public_col_acl` 全 0；若生产 PG 的 `ALTER DEFAULT PRIVILEGES`/`PUBLIC` 默认与此不同，#66 会在部署时红 —— 这正是它该做的事，但本机无法覆盖。
5. **真并发锁争用未测**：只证明 `FOR UPDATE` 形状被授权；没有两个会话同时 `commitTerminal` 的行锁等待/超时读数。
6. **账号硬删除的级联未演练**：仓内没有 `DELETE FROM public.users` 的迁移；四表 `ON DELETE CASCADE` 是结构声明，本片没做「删 users 行 ⇒ 四表行消失」的真删除演练。
7. **非超级用户 owner 引导未测**：本机 owner 是 `initdb -U` 的 superuser；生产 `CREATEROLE` 非 `SUPERUSER` 时，`REVOKE ALL … FROM PUBLIC` 与列级 `GRANT` 的属主前提未在本机复现。
8. **全量测试套件未跑**：只跑派单 §5 的五道门禁 + `recognitions-pg.mjs`；`test:unit`、`test:integration:http` 等未跑（本片不触碰 `services/**`）。
9. **90-assert 在 FAIL 时退出码仍 0**（§9）：未改，也不在本片授权范围；依赖 `provision-db.sh` 读末行。
10. **selections「store 从不用 FOR UPDATE」是代码阅读结论**：依据是 `commitSelection` 只在 records 上开锁；本机没有用真实流量验证这一点。
11. **迁移末位 pin**：本机 25 片通过；新增 0026 后 `recognitions-pg.mjs` 的 `[M0]` 会红（归 #336），与本片无关。
12. **PUBLIC 授权后的跨角色影响**：m5 只核到 `knowledge_runtime_scope` 与 #66 两条断言变红；没有枚举「PUBLIC 授权会让哪些其它角色也读到该表」的完整清单。

## 13. 派单对应表

| 派单条目 | 落点 |
|---|---|
| §1 四表列集、`store-pg.ts` 真实语句 | §4.1（逐列 + 行号）；§3.2（19 条形状） |
| §2 反向控制 | §3.3（同一 `DELETE` 三态 + 方法学两条） |
| §3 硬前置守卫、表级 DELETE、FOR UPDATE 不另授 | §4.5 / §4.2 / §4.3 |
| §4 七处改动 + 三条新断言 | §6（E1-E7、N1-N4） |
| §5 变异 | §7（m1/m2/m3/m3b/m4/m5/m6） |
| §5 门禁 + `recognitions-pg.mjs` | §8 |
| §7 证据页要求 | 本页 §0-§13 |
| §9 指挥预验证矩阵 | §5.2（逐格一致） |
