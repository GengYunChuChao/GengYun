# R28-S52 · 跨 schema 关系面兜底清单 + 四条断言（补上非 public 9 个关系的授权面）

> 切片：R28-S52；分支 `test/gy-r28-cross-schema-surface`；基线 `8cb52a5`（PR #363 / R28-S51 返修 1 的 head，已含 main 与 S51 全部改动；本基线 90-assert 为 **107** 条断言）。
> 交付物：
> - `deploy/postgres-cvm/sql/90-assert-least-privilege.sql`：`cross_schema_manifest`（L1480-1490，9 行）+ 五个派生 CTE（L1495-1622）+ 四条 `runtime_cross_schema_*` 断言（L2834-2970）；
> - `deploy/postgres-cvm/evidence/probe-runtime-grants.sql`：段 [9]（L694-782）9 关系矩阵 + 五条真执行探针；
> - 本页；报告 `.pg17/handoff/r28-s52-report.md`。
> 一句话问题：`90-assert-least-privilege.sql` 里的三张「兜底清单」——`domain_manifest`（public 表 21 granted + 1 granted_external + 4 forbidden）、`external_manifest`（S43 的 18 张 public 表）、`function_surface_manifest`（S51 的 11 个函数）——**覆盖的全都只有 public**。可库里非 public 的 4 个 schema（`catalog_ops` / `catalog_read` / `knowledge_staging` / `staging_intake`）还有 **9 个关系**带组授权，其中只有 2 个被点名断言看住，其余 **7 个在 90-assert 全文里出现 0 次**（§1 表）。于是「往 `catalog_ops.operations` 多授一个组」「把 `catalog_read.registration_evidence` 授给运行时」这类改动，改前**不会让任何断言变红**。本片把「点过名的关系」升级为「必须分类的关系面」，并补上运行时的**有效**权限与 PUBLIC 面两道判据。

**取证范围声明**：本页读数来自**本机两个一次性 PG 17.11 集群**（`initdb -U gengyun_cvm_owner --auth=trust -E UTF8 --locale=C`），都没有在真实 CVM、没有在 GitHub Actions runner 上执行；`provision-db.sh` 本体未运行，按它的顺序手工复现 26 个迁移 → 角色文件 → `20-login-roles.sql` → 90-assert：

- 集群 A（**8 组形态** = `--with-cli-groups` 口径，本片主目标）：`127.0.0.1:55658`，datadir `E:\GengYunCommander\.pg17\data-r28s52`，26 个迁移 → **8** 个角色文件 → `20-login-roles.sql` → 90-assert，共 13 个角色（11 组 + `gengyun_cvm_owner` + `gengyun_api_runtime`）；
- 集群 B（**5 组形态** = CI / 默认部署口径）：`127.0.0.1:55659`，datadir `E:\GengYunCommander\.pg17\data-r28s52-5g`，26 个迁移 → **5** 个默认角色文件（`auth_privacy` / `catalog_readers` / `consent_granter` / `profile_runtime` / `knowledge_runtime`，即 `provision-db.sh:267-273` 的基础清单）→ `20-login-roles.sql` → 90-assert，共 8 个角色。
- 两个集群的属主 `gengyun_cvm_owner` 都是 `initdb` 创建的**超级用户**（`rolsuper = t`），这是 §7 第 4 条的限制来源；两个库都只有**同样 9 个**非 public 非系统关系，差异只在「组是否被创建、组授权是否物化」。
- `--with-cli-groups` 的两个组（`gengyun_source_operator` / `gengyun_staging_importer`）只在集群 A 存在；`source_operator.sql` / `staging_importer.sql` 也只在 A 执行（`provision-db.sh:54`、`86`、`274-279`）。

## 0. 结论摘要

| 项 | 改前（`8cb52a5`） | 改后 |
| --- | --- | --- |
| 90-assert 断言计数 `TOTAL/OK/BAD` | **`107/107/0`**（verdict `ok`、exit 0；8 组与 5 组同） | **`111/111/0`**（verdict `ok`、exit 0；**两形态都真跑**） |
| 跨 schema 关系清单 | **不存在**（三张清单只覆盖 public） | `cross_schema_manifest` 9 行，4 个 schema × 9 个关系 |
| 「新增非 public 关系未登记」检测 | 无；7/9 个关系在断言文件里出现 **0 次** | `runtime_cross_schema_relations_complete`：双向差集 + relkind 漂移 |
| 「多授 / 少授」检测 | 只有 `preview_reader_scope` / `knowledge_runtime_scope` 两条点名式 | `runtime_cross_schema_grantees_exact`：逐格精确比对（多授永远红；少授只对**真实存在**的角色追究） |
| 「运行时**有效**权限」检测 | 无（relacl 里看不到 `gengyun_api_runtime`，它靠组继承） | `runtime_cross_schema_effective_access`：`has_table_privilege` 枚举 7 个表级权限，白名单**封闭两项**、双向判红 |
| 「非 public 上 PUBLIC 零授权」检测 | 只有 public schema 的 PUBLIC 面（断言 11） | `runtime_cross_schema_no_public`：9 关系 relacl/attacl 的 `grantee=0` 行 + 非 public schema 的 PUBLIC USAGE/CREATE 全 false + `public` 上 PUBLIC USAGE 作为**已登记例外** |
| 真执行证明 | 无（跨 schema 面完全空白） | `probe-runtime-grants.sql` 段 [9]：`SET ROLE gengyun_api_runtime` 真跑 5 条，正向 2×`00000`、反向 3×`42501` |
| 变异 5 条 + 负控制 2 条 | — | 全部按预期判红；复原后逐条回到 `111/111/0`；每条前后 `sha256(90-assert)` 相等 |
| 门禁 6 项 + g7 两形态 + g8 | — | 全部 exit 0（§6） |

## 1. 缺口与因果链

### 1.1 9 个关系，7 个无人看（改前实测）

对 `8cb52a5` 版 90-assert 做全文件字面检索（`git show 8cb52a5:deploy/postgres-cvm/sql/90-assert-least-privilege.sql`），逐关系统计「`schema.关系名` 出现次数」：

| # | 关系 | 出现次数 | 被点名的断言 |
| --- | --- | --- | --- |
| 1 | `catalog_ops.operations` | **0** | （无） |
| 2 | `catalog_read.current_knowledge` | 5 | `knowledge_runtime_scope`（断言 14） |
| 3 | `catalog_read.current_verified_sources` | **0** | （无） |
| 4 | `catalog_read.home_species` | 4 | `preview_reader_scope`（断言 13） |
| 5 | `catalog_read.registration_evidence` | **0** | （无） |
| 6 | `knowledge_staging.workbook_batches` | **0** | （无） |
| 7 | `knowledge_staging.workbook_rows` | **0** | （无） |
| 8 | `staging_intake.batches` | **0** | （无） |
| 9 | `staging_intake.operations` | **0** | （无） |

因果链：迁移/角色文件给非 public 关系加一条 `GRANT` → 90-assert 里没有任何清单包含它、没有任何断言读它的 `relacl` → 全绿。旧版唯一的两条点名断言还只回答「**某一个**组能不能读」，不回答「除属主外**还有谁**有权限」，也不回答「运行时**实际**能碰到什么」。

### 1.2 9 个关系的真实授权面（两形态实测，`aclexplode` 非属主行）

`a=INSERT r=SELECT w=UPDATE d=DELETE D=TRUNCATE x=REFERENCES t=TRIGGER m=MAINTAIN`；属主 `arwdDxtm` 是 GRANT 后的默认投影，统计时用 `a.grantee <> c.relowner` 过滤（视图同上）。

| # | 关系 | kind | 属主 | 8 组形态（`55658`）非属主 ACL | 5 组形态（`55659`）非属主 ACL | 运行时有效权限（两形态同） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `catalog_ops.operations` | `r` | `gengyun_cvm_owner` | `gengyun_source_executor=ar` | （无） | （无） |
| 2 | `catalog_read.current_knowledge` | `v` | `gengyun_cvm_owner` | `gengyun_knowledge_runtime=r` | `gengyun_knowledge_runtime=r` | SELECT |
| 3 | `catalog_read.current_verified_sources` | `v` | `gengyun_cvm_owner` | （无） | （无） | （无） |
| 4 | `catalog_read.home_species` | `v` | `gengyun_cvm_owner` | `gengyun_preview_reader=r` | `gengyun_preview_reader=r` | SELECT |
| 5 | `catalog_read.registration_evidence` | `v` | `gengyun_cvm_owner` | `gengyun_evidence_reader=r` | `gengyun_evidence_reader=r` | （无） |
| 6 | `knowledge_staging.workbook_batches` | `r` | `gengyun_cvm_owner` | `gengyun_staging_executor=ard` | （无） | （无） |
| 7 | `knowledge_staging.workbook_rows` | `r` | `gengyun_cvm_owner` | `gengyun_staging_executor=ar` | （无） | （无） |
| 8 | `staging_intake.batches` | `r` | `gengyun_cvm_owner` | `gengyun_staging_executor=ar` | （无） | （无） |
| 9 | `staging_intake.operations` | `r` | `gengyun_cvm_owner` | `gengyun_staging_executor=ar` | （无） | （无） |

授权来源（逐条可核）：`services/api/db/roles/catalog_readers.sql:31`（`home_species` → `gengyun_preview_reader`）、`:32`（`registration_evidence` → `gengyun_evidence_reader`）、`knowledge_runtime.sql:16`（`current_knowledge` → `gengyun_knowledge_runtime`）、`source_operator.sql:25`（`catalog_ops.operations` → `gengyun_source_executor`）、`:30`（INSERT）、`staging_importer.sql:24`（两张 `knowledge_staging` 表 SELECT,INSERT）、`:25`（`workbook_batches` DELETE）、`:29`（两张 `staging_intake` 表 SELECT,INSERT）。`egress_ledger.sql` 对 9 个关系零授权——所以 9 行里没有它。

5 组形态的 5 个空行**不是缺陷**：`gengyun_source_executor` / `gengyun_staging_executor` 由 `source_operator.sql:16`、`staging_importer.sql:17-18` 创建，而这两个文件只在 `--with-cli-groups` 下应用；组不存在 ⇒ 授权语句不执行。这正是断言 94「少授只对真实存在的角色追究」的由来（照抄 S51 返修 1 的口径）。

### 1.3 schema USAGE（8 组形态 5 schema × 11 组角色，两形态同构）

| schema | 有 USAGE 的组 | CREATE | PUBLIC |
| --- | --- | --- | --- |
| `public` | 11 个组全部 | 全 `f` | **有 USAGE**（`=U/pg_database_owner`）、无 CREATE —— **已登记例外** |
| `catalog_ops` | `gengyun_source_executor`、`gengyun_source_operator` | 全 `f` | 无 USAGE / 无 CREATE |
| `catalog_read` | `gengyun_preview_reader`、`gengyun_evidence_reader`、`gengyun_knowledge_runtime` | 全 `f` | 无 / 无 |
| `knowledge_staging` | `gengyun_staging_executor` | 全 `f` | 无 / 无 |
| `staging_intake` | `gengyun_staging_executor`、`gengyun_staging_importer` | 全 `f` | 无 / 无 |

`public` 上 PUBLIC 的 USAGE 是 PG 默认投影，**不许收紧**（收紧会让 `pg_catalog` 的公开可读性、`SET ROLE`/`search_path` 行为都变），断言 96 因此把它写成「USAGE 必须为真、CREATE 必须为假」的**登记例外**。

## 2. 跨 schema 清单（9 行）

`cross_schema_manifest(schema_name, rel_name, relkind, grantee, privs)` 放在 `function_surface_manifest` 之后（L1480-1490），风格与它一致：一行一个关系、`grantee/privs` 写**除属主外唯一允许的 ACL 项**、无授权写 `NULL/NULL`。清单是「这 9 个关系必须被分类」的机制本身——新增关系不登记就由断言 93 判红，而不是悄悄落在盲区。

| # | schema | 关系 | relkind | `grantee` | `privs` |
| --- | --- | --- | --- | --- | --- |
| 1 | `catalog_ops` | `operations` | `r` | `gengyun_source_executor` | `ar` |
| 2 | `catalog_read` | `current_knowledge` | `v` | `gengyun_knowledge_runtime` | `r` |
| 3 | `catalog_read` | `current_verified_sources` | `v` | `NULL` | `NULL` |
| 4 | `catalog_read` | `home_species` | `v` | `gengyun_preview_reader` | `r` |
| 5 | `catalog_read` | `registration_evidence` | `v` | `gengyun_evidence_reader` | `r` |
| 6 | `knowledge_staging` | `workbook_batches` | `r` | `gengyun_staging_executor` | `ard` |
| 7 | `knowledge_staging` | `workbook_rows` | `r` | `gengyun_staging_executor` | `ar` |
| 8 | `staging_intake` | `batches` | `r` | `gengyun_staging_executor` | `ar` |
| 9 | `staging_intake` | `operations` | `r` | `gengyun_staging_executor` | `ar` |

**已知盲点（本片未覆盖，见 §7 第 2 条）**：列级授权不进 `relacl`。`staging_importer.sql:27`（`GRANT UPDATE(id) ON knowledge_staging.workbook_batches`）、`:28`（`UPDATE(excel_row) ON workbook_rows`）、`:30`（`UPDATE(generation,import_id,state) ON staging_intake.batches`）落在 `pg_attribute.attacl`；本清单与断言 94 只覆盖**表级** `relacl`。断言 96 的 PUBLIC 面**同时**看 `relacl` 与 `attacl`，所以「列级授给 PUBLIC」仍会被抓。

## 3. 四条断言（接现有最大编号 92，新增 93-96）

| # | label | 语义 | 实现要点 | 改前 → 改后 |
| --- | --- | --- | --- | --- |
| 93 | `runtime_cross_schema_relations_complete` | 非 public 非系统 schema 下每个关系（`relkind IN r/p/v/m/f`）都必须在清单；清单每条也必须真实存在；relkind 必须一致 | `cross_schema_relations` 用 `nspname !~ '^pg_'`（不用 `LIKE 'pg_%'`：`_` 是单字符通配符，会放过 `pgx_fake`）遍历；`cross_schema_manifest_gaps` 三段 `UNION ALL`（库有清单无 / 清单有库无 / relkind 漂移），第三段用 `concat` 而不是用竖线拼接（`text` 与 `"char"` 直接拼在 PG 17 上报 `operator is not unique`，实测踩过） | 无此断言 → 通过；m2 判红 |
| 94 | `runtime_cross_schema_grantees_exact` | 9 个关系除属主外的 ACL 必须**逐格精确等于**清单：多一个组、少一个权限都红；**少授只在角色真实存在时红** | `cross_schema_acl`：`aclexplode(c.relacl)` + `JOIN pg_roles` + 过滤 `grantee <> 0`（PUBLIC 归断言 96）且 `grantee <> c.relowner`（属主投影）；字母按 `position(ch IN 'arwdDxtm')` 排序，未知位映 `'?'` fail-closed；`cross_schema_grantee_violations` 用 `regexp_split_to_table(privs,'')` 算**字母级**差集：`多授 <role>：<多余字母>` / `少授 <role>：应有 <缺的字母> 实无`；少授侧 `m.grantee = 'PUBLIC' OR EXISTS (SELECT 1 FROM pg_roles rr WHERE rr.rolname = m.grantee)` | 无此断言；m1/m4/nc1/nc2 判红 |
| 95 | `runtime_cross_schema_effective_access` | 运行时（`gengyun_api_runtime`）在 9 个关系上的**有效**表级权限集合必须**恰好**是 `{catalog_read.current_knowledge=SELECT, catalog_read.home_species=SELECT}`：多一项红、两项任一读不到也红 | `cross_schema_effective` 对 7 个表级权限逐个 `has_table_privilege('gengyun_api_runtime', r.rel_oid, p.priv)`（运行时靠 `20-login-roles.sql:220-224` 继承 5 个组，`relacl` 里没有它的名字，只有 `has_table_privilege` 会沿成员关系求值）；断言侧 `NOT EXISTS (… NOT IN (VALUES 两项))` + 两条 `has_table_privilege(...) = true` | 无此断言；m1/nc1/nc2 判红（见 §3.1 偏差 1） |
| 96 | `runtime_cross_schema_no_public` | 9 个关系上 `PUBLIC` 零表级/列级权限；非 public 非系统 schema 上 PUBLIC 无 USAGE/CREATE；`public` 上 PUBLIC 有 USAGE、无 CREATE（**已登记例外**，⛔ 不是零 USAGE） | 四个条件 `AND`：`relacl` 的 `grantee=0` 行数 0、`attacl` 的 `grantee=0` 行数 0、非 public schema 上 `has_schema_privilege('public', oid, 'USAGE'/'CREATE')` 全 false、`has_schema_privilege('public','public','USAGE') = true AND CREATE = false`；detail 打印四个读数 | 无此断言；m3 判红；m5 **未覆盖**（§5） |

`has_table_privilege` 对**列级**授权不抬升为表级（PG 语义），所以断言 95 只问 7 个表级权限；`MAINTAIN`（PG 17 维护位）没有表级 `GRANT` 路径，不入枚举（CREATE TABLE 的属主隐式位，不在授权面）。

### 3.1 偏差 1（已登记）：白名单是**两项**，不是派单写的「恰好 `current_knowledge`」

派单 §2 断言③ 写「运行时**有效**权限集合恰为 `{catalog_read.current_knowledge SELECT}`」。**真库不是这样**，推导链逐条给行号：

1. `deploy/postgres-cvm/sql/20-login-roles.sql:221`：`GRANT gengyun_preview_reader  TO gengyun_api_runtime;  -- 公共科普投影 catalog_read.home_species`；
2. `services/api/db/roles/catalog_readers.sql:31`：`GRANT SELECT ON catalog_read.home_species TO gengyun_preview_reader;`；
3. ⇒ 由 1+2，运行时**继承**了 `catalog_read.home_species` 的 SELECT；实测 `has_table_privilege('gengyun_api_runtime','catalog_read.home_species','SELECT') = true`；
4. `20-login-roles.sql:224`（`GRANT gengyun_knowledge_runtime … -- catalog_read.current_knowledge 只读`）+ `knowledge_runtime.sql:16` ⇒ 同理得到 `current_knowledge` 的 SELECT。

所以基线真值是**两项**；照派单字面写「恰好 current_knowledge」会让断言 95 在**未变异**的干净库上直接判红（假红），而 CI 的 `deploy-sql-gate.yml` 也跑 5 组形态（同样两项），会 100% 失败。

处理：白名单写成**封闭两项**，且**双向**判红——多一项（越界）红、两项任一读不到（缺）红；这不是把判据放宽成「至少两项」，而是把真值钉死后仍然全封闭。**派单原要求「恰好 current_knowledge」与真库不符，本片按实测钉两项，属已登记偏差**（指挥 m00130 已确认接受）。同一偏差也写在探针段 [9] 的注释里（`probe-runtime-grants.sql:707-710`）。

## 4. 读数

### 4.1 断言计数（两形态都真跑）

| 口径 | 命令/日志 | 读数 |
| --- | --- | --- |
| 改前总数（两形态） | `.pg17/handoff/r28-s52-logs/00-baseline-5565{8,9}.log` | **`107/107/0`**，exit 0，verdict `ok`（与派单「改前 107」一致） |
| 改后 **8 组**（`55658`） | `01-new-55658.log`、`m-*-restored-8g.log` | **`COUNT 111\|111\|0`**，exit 0，末行 `ok` |
| 改后 **5 组**（`55659`，CI/默认口径） | `01-new-55659.log` | **`COUNT 111\|111\|0`**，exit 0，末行 `ok` |
| 标签统计 | `STAT sum=3520 max=50`（两形态同） | 已回写进 90-assert 末尾 DO 块注释（上限 4000） |
| 四条新断言 detail（绿态原文） | 同上 | 93 `（无差异）`；94 `（无差异）`；95 `实际 = catalog_read.current_knowledge=SELECT / catalog_read.home_species=SELECT`；96 `非 public 关系上 PUBLIC 权限行 relacl/attacl=0/0；非 public schema 上 PUBLIC 有 USAGE/CREATE 的：（无）；public schema 上 PUBLIC USAGE=true、CREATE=false（USAGE 为 =U/pg_database_owner 默认投影，已登记例外）` |

计数方式：`count-asserts.sql` = `\pset tuples_only on` + `\pset format unaligned` → `\i 90-assert…` → `SELECT 'COUNT '||count(*)||'|'||count(*) FILTER (WHERE ok)||'|'||count(*) FILTER (WHERE NOT ok) FROM r28_assert_results;`。**注意**：90-assert 本体是 `CREATE TEMP TABLE r28_assert_results AS … SELECT … FROM checks`（CTAS），psql 只打印 `SELECT 111` 这个标签、**从不逐条打印 label 与 ok**，所以计数只能从会话临时表里查，不能数终端里的 PASS/FAIL 文案。`107 + 4 = 111`。

### 4.2 探针段 [9]（`probe-runtime-grants.sql:694-782`，两形态原文相同）

`SET ROLE gengyun_api_runtime` 之后的 9 关系矩阵（`02-probe-55658.log` / `02-probe-55659.log`；5 组形态只是 5 个 cell 变 `(none)`）：

```text
               relation                | kind |        non_owner_acl         | runtime_effective
---------------------------------------+------+------------------------------+-------------------
 catalog_ops.operations                | r    | gengyun_source_executor=ar   | (none)
 catalog_read.current_knowledge        | v    | gengyun_knowledge_runtime=r  | SELECT
 catalog_read.current_verified_sources | v    | (none)                       | (none)
 catalog_read.home_species             | v    | gengyun_preview_reader=r     | SELECT
 catalog_read.registration_evidence    | v    | gengyun_evidence_reader=r    | (none)
 knowledge_staging.workbook_batches    | r    | gengyun_staging_executor=ard | (none)
 knowledge_staging.workbook_rows       | r    | gengyun_staging_executor=ar  | (none)
 staging_intake.batches                | r    | gengyun_staging_executor=ar  | (none)
 staging_intake.operations             | r    | gengyun_staging_executor=ar  | (none)
(9 rows)
```

五条真执行（`\set … :ERROR` 取 SQLSTATE，与段 [8] 同风格；`ON_ERROR_STOP=0` 是设计的一部分）：

| 段 | 语句 | 期望 | 实测（两形态一致） |
| --- | --- | --- | --- |
| `[9a-1]` | `SELECT * FROM catalog_read.current_knowledge LIMIT 0` | `00000`、0 行 | `(0 rows)` → `state = 00000` |
| `[9a-2]` | `SELECT * FROM catalog_read.home_species LIMIT 0` | `00000`、0 行 | `(0 rows)` → `state = 00000` |
| `[9b-1]` | `SELECT * FROM catalog_read.registration_evidence LIMIT 0` | `42501` | `ERROR: 42501: permission denied for view registration_evidence` → `state = 42501` |
| `[9b-2]` | `SELECT * FROM catalog_ops.operations LIMIT 0` | `42501` | `ERROR: 42501: permission denied for schema catalog_ops` → `state = 42501` |
| `[9b-3]` | `INSERT INTO staging_intake.batches …` | `42501` | `ERROR: 42501: permission denied for schema staging_intake` → `state = 42501` |

**[9b-2]/[9b-3] 的层级说明（如实记录）**：两条都停在 **schema USAGE** 上（`permission denied for schema`），不是表级/列级拒绝——因为运行时对 `catalog_ops` / `staging_intake` 本来就没有 USAGE。它们证明的是「运行时摸不到这两个 schema 里的任何关系」，比表级拒绝更强，但没有单独证明「表级 SELECT 被收回」。段 [9] 的注释已注明这一点；断言 95 用的是 `has_table_privilege`（只看表级位，不受 schema USAGE 影响），所以判据本身不依赖这个层级。

## 5. 变异（m1-m5 按派单逐条做；另加两条负控制）

全部 7 条都是**库内**改动（`GRANT`/`REVOKE`/`CREATE VIEW`），仓库文件一字不动；每条「施加 → 跑 90-assert（`ON_ERROR_STOP=1`）→ 原路复原 → 再跑」；复原后都回到 `COUNT 111|111|0` + verdict `ok` + exit 0；每条前后 `sha256(90-assert-least-privilege.sql)` 相等（`shaSame=True`），复原后 9 个关系的 `relacl` 文本与 §1.2 的基线读数逐格相同（§5.3）。红态 exit 码都是 **3**（末尾 DO 块 `RAISE EXCEPTION`；`ON_ERROR_STOP=1` 下 psql 直接退出，只能从 `FAIL: …` 行取证）。

### 5.1 五条派单变异

| 变异 | 改动（8 组形态 `55658`） | 预期 | 实测原文（`FAIL:` 行） |
| --- | --- | --- | --- |
| m1 | `GRANT SELECT ON catalog_read.current_verified_sources TO gengyun_api_runtime;` | 断言 94 + 95 红 | `FAIL: runtime_cross_schema_effective_access (实际 = catalog_read.current_knowledge=SELECT / catalog_read.current_verified_sources=SELECT / catalog_read.home_species=SELECT；越界 catalog_read.current_verified_sources=SELECT); runtime_cross_schema_grantees_exact (catalog_read.current_verified_sources（多授 gengyun_api_runtime：r）)` |
| m2 | `CREATE VIEW catalog_read.s52_probe AS SELECT 1 AS x;`（不登记清单） | 断言 93 红并点名 | `FAIL: runtime_cross_schema_relations_complete (catalog_read.s52_probe：库中存在，但清单未登记（新关系必须显式分类）)` |
| m3 | `GRANT SELECT ON catalog_read.home_species TO PUBLIC;` | 断言 96 红（连带 14/94 也可如实记） | `FAIL: knowledge_runtime_scope (gengyun_knowledge_runtime 只应能读 catalog_read.current_knowledge); runtime_cross_schema_no_public (非 public 关系上 PUBLIC 权限行 relacl/attacl=1/0；… )` |
| m4 | `REVOKE SELECT ON knowledge_staging.workbook_batches FROM gengyun_staging_executor;`（8 组） | 断言 94 红（少授）、断言 93 不红 | `FAIL: runtime_cross_schema_grantees_exact (knowledge_staging.workbook_batches（少授 gengyun_staging_executor：应有 r 实无）)` |
| m5 | `GRANT USAGE ON SCHEMA staging_intake TO gengyun_consent_granter;` | 由实测决定 | **exit 0，无 FAIL**：`COUNT 111\|111\|0`、verdict `ok` ⇒ **本片未覆盖**「schema USAGE 的组多授」（§5.2） |

m3 的连带红：`knowledge_runtime_scope`（既有断言 14）也红了，因为 `gengyun_knowledge_runtime` 同样是 `home_species` 的 PUBLIC 可读者，它「只应能读 `current_knowledge`」的判据被 PUBLIC 授权打破。这是既有断言的正确行为，不是本片改坏。

### 5.2 m5：如实写「本片未覆盖」，不写成恒真断言

m5 施加后 90-assert 仍 `111/111/0` —— 说明**断言 96 不检查「schema USAGE 的组多授」**。原因在判据形状：断言 96 对非 public schema 只查 `has_schema_privilege('public', …)`（PUBLIC 伪角色），没有查「组成员是否越界」；schema USAGE 的组级白名单（§1.3 的 5 schema × 11 组矩阵）本片**只测不锁**。

这是**已登记的已知盲点，不是「m5 证明断言 96 恒真」**：m3 已经证明断言 96 的 PUBLIC 面会真红（`relacl/attacl=1/0`），m5 只说明它的覆盖面止于 PUBLIC。**建议后续片补**：在 `cross_schema_manifest` 上加一张 `schema_usage_manifest`（schema → 允许的 USAGE 组集合），再补一条 `runtime_cross_schema_schema_usage_exact`；本片的边界是关系面，未扩到 schema 面。

### 5.3 两条负控制（证明「少授」没被改聋、白名单双向都判红）

| 控制 | 改动 | 实测原文 | 复原 |
| --- | --- | --- | --- |
| NC1（8 组） | `GRANT SELECT ON TABLE catalog_ops.operations TO gengyun_api_runtime;` | `FAIL: runtime_cross_schema_effective_access (实际 = catalog_ops.operations=SELECT / catalog_read.current_knowledge=SELECT / catalog_read.home_species=SELECT；越界 catalog_ops.operations=SELECT); runtime_cross_schema_grantees_exact (catalog_ops.operations（多授 gengyun_api_runtime：r）)` | `REVOKE` → `111/111/0`、`ok`、exit 0 |
| NC2（8 组） | `REVOKE SELECT ON TABLE catalog_read.home_species FROM gengyun_preview_reader;` | `FAIL: preview_reader_scope (gengyun_preview_reader 只能读 catalog_read.home_species); runtime_cross_schema_effective_access (实际 = catalog_read.current_knowledge=SELECT；缺 catalog_read.home_species 的 SELECT); runtime_cross_schema_grantees_exact (catalog_read.home_species（少授 gengyun_preview_reader：应有 r 实无）)` | `GRANT` → `111/111/0`、`ok`、exit 0 |

NC1 证明白名单「多一项」必红且**点名越界的那个关系**；NC2 证明「白名单项读不到」必红且点名缺的那一项——两条合起来把断言 95 的**双向**封闭性钉住，也顺带证明断言 94 的「少授」在角色**存在**时仍然判红（5 组形态不会假红的原因不是它聋了，而是角色不存在）。

复原证据（`after-acl-5565{8,9}.txt`，7 条变异全部跑完后再取一次）：

```text
55658  catalog_ops.operations                | r | {gengyun_cvm_owner=arwdDxtm/gengyun_cvm_owner,gengyun_source_executor=ar/gengyun_cvm_owner}
55658  catalog_read.current_knowledge         | v | {gengyun_cvm_owner=arwdDxtm/gengyun_cvm_owner,gengyun_knowledge_runtime=r/gengyun_cvm_owner}
55658  catalog_read.current_verified_sources  | v | {gengyun_cvm_owner=arwdDxtm/gengyun_cvm_owner}
55658  catalog_read.home_species              | v | {gengyun_cvm_owner=arwdDxtm/gengyun_cvm_owner,gengyun_preview_reader=r/gengyun_cvm_owner}
55658  catalog_read.registration_evidence     | v | {gengyun_cvm_owner=arwdDxtm/gengyun_cvm_owner,gengyun_evidence_reader=r/gengyun_cvm_owner}
55658  knowledge_staging.workbook_batches      | r | {gengyun_cvm_owner=arwdDxtm/gengyun_cvm_owner,gengyun_staging_executor=ard/gengyun_cvm_owner}
55658  knowledge_staging.workbook_rows         | r | {gengyun_cvm_owner=arwdDxtm/gengyun_cvm_owner,gengyun_staging_executor=ar/gengyun_cvm_owner}
55658  staging_intake.batches                 | r | {gengyun_cvm_owner=arwdDxtm/gengyun_cvm_owner,gengyun_staging_executor=ar/gengyun_cvm_owner}
55658  staging_intake.operations              | r | {gengyun_cvm_owner=arwdDxtm/gengyun_cvm_owner,gengyun_staging_executor=ar/gengyun_cvm_owner}
（55659 同形，只是 5 行只剩属主 arwdDxtm 投影）
```

## 6. 门禁（6 项 + 两形态真库 + git status，全部 exit 0）

| # | 命令 | exit | 读数 |
| --- | --- | --- | --- |
| g1 | `npm run lint` | **0** | `PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、`PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）`、`lint 通过` |
| g2 | `node tools/verify-release-materials.mjs` | **0** | `PASS 回滚 down 脚本覆盖 0002..N 且无 0001 — 迁移 26 个（0001..0026），down 25 个（0002..0026），无 0001`；`15/15 项通过` |
| g3 | `npm run test:docs` | **0** | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住`；`PASS docs/research 结构校验：…` |
| g4 | `node tools/verify-contract-status.mjs` | **0** | `PASS: 覆盖 112 条契约操作；已装配 108 条`；`PASS: 中文表格一致`；`PASS: 状态为人工判定`（`WARN: 无锚点可疑引用 前 5/39 条`，只计数不判红） |
| g5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | **0** | `tests 6 / pass 6 / fail 0` |
| g6 | `git diff --check` | **0** | 无输出 |
| g7a | `psql -q -v ON_ERROR_STOP=1 -f 90-assert…`（**8 组** `55658`） | **0** | 末个非空行 `ok`（`-q` 口径 = `deploy-sql-gate.yml:145-162` 的判据）；`COUNT 111\|111\|0`；红态对照 exit 3 |
| g7b | `psql -q -v ON_ERROR_STOP=1 -f 90-assert…`（**5 组** `55659`） | **0** | 末个非空行 `ok`；`COUNT 111\|111\|0` |
| g8 | `git status --porcelain` | **0** | 只有页首列出的 3 个交付文件（未提交/已提交各记一次，无其它脏文件） |

日志：`.pg17/handoff/r28-s52-logs/gates-final/`（`g{1..6}.log`、`g7q-5565{8,9}.log`、`summary.txt`）；真库读数与变异在 `.pg17/handoff/r28-s52-logs/{00,01,02,m-*}-*.log`。

> **g7 的「末行 ok」口径**：CI 用 `psql -X -q … > out`（`deploy-sql-gate.yml:145-162`），`-q` 会吞掉 `SELECT 111`、`ROLLBACK`、`DO` 这些命令标签，所以末个非空行正好是 `ok`。本机不加 `-q` 跑时尾部会多出 `SELECT 111` 与末行 `DO`（DO 块的命令标签），**这不是判据变化**：两种口径的 verdict 行都是 `ok`、exit 都是 0，§6 表里记的是与 CI 等价的 `-q` 读数；红态下 `-q` 与不加 `-q` 都一样是 exit 3，`FAIL: …` 行在 stdout 里。

## 7. 未取得 / 待裁定

1. **真实 CVM 与 GitHub Actions runner 未跑**：本页全部读数来自本机两个一次性集群（55658 / 55659），`provision-db.sh` 与 `deploy-sql-gate.yml` 本体都没有在本机执行；CI 现场只在 S51 返修时引用过 run 39547572436 的日志。5 组形态是**照 `provision-db.sh:267-279` 的基础清单手工复现**的 CI 口径。
2. **列级授权（`attacl`）不在断言 94 的覆盖面**：`staging_importer.sql:27/28/30` 的三条 `GRANT UPDATE(col)` 落在 `pg_attribute.attacl`，清单与断言 94 只比表级 `relacl`。本片**未覆盖**「列级 UPDATE 的多授/少授」；断言 96 只看列级上的 PUBLIC 面。（§2 末段已注明。）
3. **schema USAGE 的组多授未覆盖**：m5 实测不红（§5.2），本片**未覆盖**；建议后续片加 `schema_usage_manifest` + 一条精确集合断言。
4. **非超管属主未验证**：两集群的 `gengyun_cvm_owner` 都是 `initdb` 超级用户（`rolsuper = t`）；「属主不是超级用户时 `aclexplode` / `has_table_privilege` / 清单查询仍成立」未取实测（90-assert 头部本身还要求能读 `pg_authid`）。
5. **`[9b-2]/[9b-3]` 的拒权层级是 schema USAGE，不是表级**（§4.2）：要严格证明「表级 SELECT 被收回」，需要先临时 `GRANT USAGE ON SCHEMA`——本片没有为了测试而改授权面，故只到「运行时摸不到该 schema」这一层。
6. **「运行时有效权限」依赖组成员关系，不是静态 ACL**：断言 95 用 `has_table_privilege` 沿继承求值，因此「把 `gengyun_preview_reader` 从 `gengyun_api_runtime` 里移出」这类**成员关系**改动会让断言 95 判红（这在语义上正确，但它测的是有效权限，不是 `relacl` 本身）；两者的分工已写在 §3 表内。
7. **只锁 4 个 schema**：断言 93 的关系枚举是「非 public 非系统 schema 全量」，所以新增第 5 个 schema 的关系**也会**被判红——这是本片与 S51（只锁三个 schema）的差别；但也意味着任何新 schema 都必须先登记清单才能过门禁（预期行为）。
8. **集群状态**：两个一次性集群在交付后以 `pg_ctl -D <datadir> -m fast -w stop` 停止，数据目录保留、不删除（`data-r28s52` / `data-r28s52-5g`）。

## 8. 与 S43/S51 的分工、复现命令

| 切片 | 覆盖对象 | 判据 | 本基线是否已在 |
| --- | --- | --- | --- |
| R28-S43 | 18 张「经组继承」的 **public 表**（`relacl` / `attacl`） | `external_manifest` 快照 + 逐表断言 | 在（`8cb52a5`） |
| R28-S51 | `public` / `catalog_ops` / `staging_intake` 的**函数**（`pg_proc.proacl`） | `function_surface_manifest` 11 行 + 四条 `runtime_function_*` | 在（`8cb52a5`，107 条） |
| **R28-S52（本片）** | **非 public 的 9 个关系**（`pg_class.relacl`） | `cross_schema_manifest` 9 行 + 四条 `runtime_cross_schema_*`（完备性 / grantee 精确 / 有效权限 / PUBLIC 面） | 本片新增，`107 → 111` |

三者的对象集合分别是「public 表」「函数」「非 public 的表与视图」，没有一条断言重叠；S52 的清单与 S43/S51 的两张清单同构（都是「必须分类的对象面」），合起来把 `relacl`（public 表 + 非 public 关系）与 `proacl`（函数）三条面都盖上。

复现（本机 PowerShell 5.1，PostgreSQL 17.11；端口等配置写进 `postgresql.conf`，**不要**把 `-o "-p …"` 传给 `pg_ctl`）：

```powershell
# 1) 集群：initdb -U gengyun_cvm_owner --auth=trust -E UTF8 --locale=C
#    postgresql.conf 追加 port / listen_addresses='127.0.0.1' / unix_socket_directories='' /
#    logging_collector=on / log_directory=<数据目录之外>；用 Win32_Process Create 起 postgres.exe
# 2) 26 个迁移按文件名顺序 → 8 个（或 5 个）角色文件 → 20-login-roles.sql
#    （GENGYUN_API_RUNTIME_PASSWORD 必须恰好 48 位小写十六进制）
# 3) 合规态（期望末行 ok、exit 0）
& 'E:\GengYunCommander\.pg17\pgsql\bin\psql.exe' -X -h 127.0.0.1 -p 55658 -U gengyun_cvm_owner -d gengyun `
  -v ON_ERROR_STOP=1 -f 'E:\GengYunCommander\wt-r28-s52\deploy\postgres-cvm\sql\90-assert-least-privilege.sql'
# 4) 计数（期望 COUNT 111|111|0；55659 同）
& 'E:\GengYunCommander\.pg17\pgsql\bin\psql.exe' -X -h 127.0.0.1 -p 55658 -U gengyun_cvm_owner -d gengyun `
  -f 'E:\GengYunCommander\.pg17\tmp\r28-s52\count-asserts.sql'
# 5) 跨 schema 面原始读数（段 [9]；42501 行是设计的一部分）
& 'E:\GengYunCommander\.pg17\pgsql\bin\psql.exe' -X -h 127.0.0.1 -p 55658 -U gengyun_cvm_owner -d gengyun `
  -f 'E:\GengYunCommander\wt-r28-s52\deploy\postgres-cvm\evidence\probe-runtime-grants.sql'
# 6) 7 条变异/负控制：.pg17\tmp\r28-s52\run-mutations.ps1 -Port 55658 -Tag 8g
```

`PSQL` 环境变量：`PGCLIENTENCODING=UTF8`（否则中文 detail 会按 GBK 写出乱码）；`count-asserts.sql`、`run-mutations.ps1`、`baseline-acl.sql`、`provision.ps1` 与全部日志都在 `.pg17\tmp\r28-s52\`（一次性脚本，不提交）与 `.pg17\handoff\r28-s52-logs\`（日志，不提交）。
