# R28-S58 · 身份/权限管线的四条断言与外发账本就绪态双条件

> 切片：R28-S58；分支 `test/gy-r28-identity-and-ledger`；基线 `upstream/main = 76b0e86`（PR #360 之后）。
> 交付物：`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 新增快照 CTE `secdef_audit`（L1382-1408）、`ledger_readiness_state`（L1415 起）与 5 条断言（L2496 `runtime_membership_exact`、L2534 `no_default_acl_entries`、L2558 `role_attribute_matrix`、L2604 `secdef_search_path_pinned`、L2627 `runtime_ledger_readiness_biconditional`）；`deploy/postgres-cvm/evidence/probe-runtime-grants.sql` 新增 [10]（L612-640）与 [11]（L643-677）两节；本页；报告 `.pg17/handoff/r28-s58-report.md`。
> 一句话问题：身份管线里「成员资格恰好是哪 5 条」「会不会用 `ALTER DEFAULT PRIVILEGES` 给将来的对象开后门」「整个 `gengyun_*` 命名空间的属性横切面」「`SECURITY DEFINER` 函数是否逐个固定了 `search_path`」这四件事，改前 103 条断言一条都没管全；而外发账本的就绪条件在服务端是 `ledger-pg.ts:229-233` 的双条件 fail-closed（表存在 **且** 两列 UPDATE 都到位），在 SQL 侧却零断言 —— 更关键的是 `provision-db.sh:267-279` 从不执行 `roles/egress_ledger.sql`，于是「半接通」（只授一列、只建角色不授组、全接通但账本表没进审计清单）在整条链路上都是静默的。

**取证范围声明**：本页全部读数来自**本机一次性 PG 17.11 集群**（`127.0.0.1:55660`，datadir `E:\GengYunCommander\.pg17\data-r28s58`），没有在真实 CVM、没有在 GitHub Actions runner 上执行；`provision-db.sh` 本体未运行，按它的顺序手工复现（26 个迁移 → **只跑默认 5 个组文件** → `20-login-roles.sql` → `90-assert`），即 CI 口径的 5 组形态。未取得项逐条列在 §8。

## 0. 结论摘要

| 项 | 改前（`76b0e86`） | 改后 |
| --- | --- | --- |
| 90-assert 断言计数 `TOTAL/OK/BAD` | `103/103/0`（verdict `ok`、exit 0） | **`108/108/0`**（verdict `ok`、exit 0） |
| `pg_auth_members` 里的运行时成员资格 | **0 条断言**（全文件零处 `pg_auth_members`；#3 只单向要求「这 5 条都在」，#4 只看链上是否混进特权/可登录角色） | `runtime_membership_exact`：集合恰为 5 条基组（可多一条待接通的 `gengyun_egress_ledger`）、全部 `admin_option=false`、被授组全部 NOLOGIN |
| `pg_default_acl` | **0 条断言**（全文件零处） | `no_default_acl_entries`：必须零行，非零列出前 5 行 |
| 角色属性矩阵 | #1 只盯 `gengyun_api_runtime`；#4 只沿运行时的成员链 | `role_attribute_matrix`：整个 `gengyun_*` 命名空间（实测 8 个角色）逐角色收敛 |
| `SECURITY DEFINER` 的 `search_path` | 只对 6 个**点名**函数比对 `proconfig`（#16-29 的几条 `proconfig @> ARRAY[…]`）；**新增**一个不写 `SET` 的 secdef 函数无人发现 | `secdef_search_path_pinned`：三 schema 下**枚举**全部 `prosecdef` 函数（实测 8 个），逐个要求固定、查不到也算红 |
| 外发账本就绪条件 | **0 条断言** | `runtime_ledger_readiness_biconditional`：整块未就绪 / 整块就绪，半接通判红 |
| 探针禁止面 | [0]–[7] | 新增 [10] `exports` 写位与两列连读必须 42501、[11] 运行时 `GRANT` 组 / `CREATE TABLE` 必须 42501 |
| 变异 7 条（9 次执行，含 m7b/m7c） | — | 全部按预期判红或按预期 no-op；每次复原后数据库指纹与基线**逐字节相同** |
| 门禁 8 项 | — | 全部 exit 0（§6） |

## 1. 背景与缺口

本集群实测（26 迁移 + 5 组文件 + `20-login-roles.sql` 全量应用后的干净库）：

| 读数 | 值 |
| --- | --- |
| `gengyun_*` 角色数 | **8** |
| 其中 `rolcanlogin = true` | **2**（`gengyun_api_runtime`、`gengyun_cvm_owner`） |
| 其中 `rolsuper = true` | **1**（`gengyun_cvm_owner`） |
| `pg_auth_members` 里运行时的成员资格 | **5** 条，全部 `admin_option = false` |
| `pg_default_acl` 行数 | **0** |
| `public`/`catalog_ops`/`staging_intake` 下的 `prosecdef` 函数 | **8** 个，全部已固定 `search_path` |
| `public` 下 `relkind='S'` 序列 | **0** |

缺口不是「没有断言」，而是**断言的覆盖形状不对**，逐个说：

1. **成员资格只查了单向**。#3 `required_memberships` 用 5 个 `pg_has_role(…, 'MEMBER')` 要求「这 5 条都在」，多授一条 NOLOGIN 组它照样绿；#4 `chain_least_privilege` 只在被授角色**是特权角色或可登录**时才红。于是 `GRANT <无害的 NOLOGIN 组> TO gengyun_api_runtime` 这一条「给运行时整包扩权」最省事的路，改前可以静默通过（m2 证明：改前 1 红都没有，改后只对我的 89 号红）。
2. **`pg_default_acl` 从头到尾没人看**。本文件其余 100 多条断言读的都是 `pg_class.relacl` / `pg_attribute.attacl` / `pg_proc.proconfig` —— 全是「现在有什么」；`ALTER DEFAULT PRIVILEGES` 改的是「**以后**建出来的对象自带什么权限」，一条语句就能给未来所有表开一条继承通道，而 90-assert 全绿（m3 证明）。
3. **属性矩阵是点状而非横切**。#1 只覆盖 `gengyun_api_runtime` 一个角色；#4 只沿运行时的成员链。不在链上的角色（本集群实测有 `gengyun_evidence_reader`：`catalog_readers.sql` 建出、`provision-db.sh` 只确认存在、不授予运行时）完全在审计面外 —— 把它改成 `CREATEDB` 或 `LOGIN`，改前也是绿的。
4. **SECDEF 的 `search_path` 只按名字点名**。#16-29 那几段对 `request_account_deletion` / `suspend_account` / `restore_account` / `set_feature_flag` / `staging_intake.*` 的 `proconfig` 做了 `@> ARRAY['search_path=pg_catalog', …]` 比对，但**没有任何一条断言枚举「库里现有几个 secdef 函数」**。新增一个 `SECURITY DEFINER` 却不写 `SET search_path` 的函数，等于给调用者留了一条「用只读运行时换函数属主权限」的劫持路径，而改前 90-assert 静默（m4 证明）。
5. **外发账本的就绪条件是双条件，SQL 侧零断言**。服务端 `services/api/src/privacy/ledger-pg.ts:228-233` 的探测是：`to_regclass('public.export_writebacks')` 非空 **且** `has_column_privilege(current_user,'public.exports','revision','UPDATE')` **且** 同一判断对 `cancelled_at` 成立；任一不成立即 `PrivacyError('OBJECT_UNAVAILABLE')`（409 fail-closed）。而部署侧 `deploy/postgres-cvm/provision-db.sh:267-279` 的组清单**只有 5 个**（`--with-cli-groups` 才加另外两个），从不执行 `services/api/db/roles/egress_ledger.sql` ⇒ 在 CI 口径下 `gengyun_egress_ledger` 角色根本不存在，账本**恒为未就绪**。这正是需要一条断言的原因：将来谁要接通账本，必须同时动三处（`roles/egress_ledger.sql` 授列写位、`20-login-roles.sql` 授组、本文件的可见面清单），漏一处就是「半接通」——服务端继续 409，运维却以为已经接上了。

## 2. 身份真值表（5 组形态，本集群实测）

`pg_auth_members`（运行时视角，`grantor` 全部是 `gengyun_cvm_owner`）：

| # | 被授组 | `admin_option` | 组自身 `rolcanlogin` |
| --- | --- | --- | --- |
| 1 | `gengyun_auth_privacy` | false | false |
| 2 | `gengyun_consent_granter` | false | false |
| 3 | `gengyun_knowledge_runtime` | false | false |
| 4 | `gengyun_preview_reader` | false | false |
| 5 | `gengyun_profile_runtime` | false | false |

`pg_roles` 里 `rolname LIKE 'gengyun\_%'` 的全部 8 个角色（`super/login/db/role/repl/bypass/inherit/conn`）：

| 角色 | super | login | db | role | repl | bypass | inherit | conn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `gengyun_api_runtime` | f | **t** | f | f | f | f | t | -1 |
| `gengyun_auth_privacy` | f | f | f | f | f | f | t | -1 |
| `gengyun_consent_granter` | f | f | f | f | f | f | t | -1 |
| `gengyun_cvm_owner` | **t** | **t** | **t** | **t** | **t** | **t** | t | -1 |
| `gengyun_evidence_reader` | f | f | f | f | f | f | t | -1 |
| `gengyun_knowledge_runtime` | f | f | f | f | f | f | t | -1 |
| `gengyun_preview_reader` | f | f | f | f | f | f | t | -1 |
| `gengyun_profile_runtime` | f | f | f | f | f | f | t | -1 |

`SECURITY DEFINER` 函数与 `proconfig`（8 个，全部已固定）：

| 函数 | `proconfig` |
| --- | --- |
| `catalog_ops.apply_source_operation(uuid,text,uuid,uuid,integer,text,text,uuid)` | `search_path=pg_catalog; TimeZone=UTC` |
| `list_admin_accounts()` | `search_path=pg_catalog` |
| `request_account_deletion(uuid,uuid,text,…)` | `search_path=pg_catalog; TimeZone=UTC` |
| `restore_account(uuid,uuid,uuid,integer,uuid)` | `search_path=pg_catalog; TimeZone=UTC` |
| `set_feature_flag(text,integer,boolean,uuid,uuid,uuid,text,text)` | `search_path=pg_catalog; TimeZone=UTC` |
| `staging_intake.apply_import(uuid,jsonb,uuid)` | `search_path=pg_catalog; TimeZone=UTC` |
| `staging_intake.rollback_import(uuid,uuid,uuid,text)` | `search_path=pg_catalog; TimeZone=UTC` |
| `suspend_account(uuid,uuid,uuid,integer,uuid)` | `search_path=pg_catalog; TimeZone=UTC` |

> `gengyun_cvm_owner` 的四位特权为 `t` 是**超级用户蕴含**（`rolsuper` 为真时 PostgreSQL 允许且实际表现为 CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS 均可用），不是有人手改过。断言据此把它整族豁免，见 §7 偏差 1。

## 3. 账本双条件真值表（5 组形态，本集群实测）

| 条件 | 服务端语义 | 本集群实测 |
| --- | --- | --- |
| `export_writebacks_present` | `to_regclass('public.export_writebacks')` 非空（0011 迁移建表） | **true** |
| `exports.revision` 列级 UPDATE | `has_column_privilege(…,'revision','UPDATE')` | **false** |
| `exports.cancelled_at` 列级 UPDATE | `has_column_privilege(…,'cancelled_at','UPDATE')` | **false** |
| `egress_role_present` | `pg_roles` 里有 `gengyun_egress_ledger` | **false** |
| `egress_granted` | `pg_auth_members` 里 `gengyun_egress_ledger → gengyun_api_runtime` | **false** |
| `writebacks_listed` | `export_writebacks` 是否已进 90-assert 的可见面清单 | **false** |

`exports` 共 **26** 列，运行时的列级权限只有 `SELECT(user_id)`，**零列 UPDATE** ⇒ 服务端 `assertProvisioned()` 必抛 409。断言把两个形态穷尽：

| 形态 | 判据 | 服务端行为 | 本片实测 |
| --- | --- | --- | --- |
| A 未就绪 | 两列 UPDATE 都没授 **且** 无 egress 角色 **且** 未授予运行时（`writebacks_present` 允许 true） | 409 fail-closed（预期） | **命中**（`false/false/false/false/true/false`） |
| B 就绪 | 两列 UPDATE 都有 **且** 角色存在 **且** 已授予运行时 **且** `export_writebacks` 存在并已进清单 | 账本可用 | 用文件变体 + 真库全接通态验证为绿（§4.5） |
| 其余 | — | 409，但「看起来接了一半」 | **红**（m6/m7b/m7c 三条覆盖三种半接通） |

## 4. 五条断言的做法与理由

### 4.1 `runtime_membership_exact`（L2496）

判据：`count(*) BETWEEN 5 AND 6` **且** 不存在 `admin_option` / 被授组 `rolcanlogin` / 组名不在白名单的行。白名单 = 5 条基组 + `gengyun_egress_ledger`。detail 逐条打印 `组→admin_option/login=`。

为什么是 5 或 6 而不是 5：#93 的就绪臂**必须**能同时为真，而它就要求 `gengyun_egress_ledger` 被授予运行时（写位经组继承）。若这里把集合钉死成 5，两条断言互相矛盾，就绪形态永远不可达 —— 这是实测跑就绪臂时发现的（§7 偏差 2）。除 `gengyun_egress_ledger` 以外多授任何一条都红。

### 4.2 `no_default_acl_entries`（L2534）

判据：`(SELECT count(*) FROM pg_default_acl) = 0`。detail 列前 5 行 `角色 @ schema objtype = acl`。

为什么判定「零行」而不是「零行指向运行时」：部署形态（`provision-db.sh` + `20-login-roles.sql` + `roles/*.sql`）全程不使用 `ALTER DEFAULT PRIVILEGES`，任何一行都是「有人绕过本文件改权限」的信号，与具体授给谁无关。这条断言的价值不在「runtime 有没有多拿」，而在「将来的对象有没有被预置权限」—— 这是本文件其余断言结构上看不见的维度。

### 4.3 `role_attribute_matrix`（L2558）

判据：至少存在 1 个 `gengyun_*` 角色（防审计面整体失效），且不存在以下任一：`rolsuper` 且非 owner；非 owner 却带 CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS；`NOT rolinherit`；`rolconnlimit <> -1`；`rolcanlogin` 且非 `gengyun_api_runtime`/`gengyun_cvm_owner`。detail 逐角色打印八元组。

为什么豁免 owner：超级用户位天然蕴含那四位（实测全 `t`），若按派单字面「四位全 false」套到 owner 上，基线就自红 —— 断言必须描述真实形态，不能把「超级用户」写成缺陷。为什么范围是整个命名空间而不是运行时：不在运行时成员链上的角色同样能登录、同样能建库，点状覆盖（#1/#4）看不见它们。

### 4.4 `secdef_search_path_pinned`（L2604）

判据：`secdef_audit` 行数 > 0 **且** 不存在 `pinned = false` 的行。`pinned` 的定义：`proconfig` 里存在以 `search_path=` 开头的项，其值非空，且按逗号拆开后每个元素（去引号去空白）都属于 `{pg_catalog, pg_temp}`。detail 带 secdef 总数与未固定清单（`函数 → proconfig`）。

为什么查不到函数也判红：枚举为空意味着「审计面本身失效」（比如 schema 改名），此时全绿是假绿。为什么允许 `pg_temp`：`pg_temp` 永远最后解析，攻击者无法用它在 `pg_catalog` 之前抢占名字，是 PostgreSQL 官方推荐的固定形态之一；本集群实测 8 个函数都只写 `pg_catalog`。

### 4.5 `runtime_ledger_readiness_biconditional`（L2627）

CTE `ledger_readiness_state` 一次算齐六项（§3 表），断言判 `A OR B`，其余一切为假。

为什么不用「两列 AND」直接当未就绪判据：派单 m6 是 `GRANT UPDATE (revision)` 单列。若未就绪臂写成 `NOT (revision_upd AND cancelled_upd) AND …`，单列授权仍落在未就绪臂 ⇒ 判绿，半接通就从判决里消失。三形态穷尽后，m6 落在「其余」⇒ 红，与派单预期一致。

就绪臂的正向控制：本集群的 5 组形态永远进不了 B（`provision-db.sh` 不建 egress 角色），所以用**文件变体**验证可达性 —— 变体做两处编辑（`domain_manifest` 加 `('export_writebacks','granted',true)`；`external_manifest` 的 exports 行改成 `auth_privacy+egress_ledger` 且 upd 补 `revision,cancelled_at`），数据库侧用**组**授写位（`GRANT UPDATE (revision, cancelled_at) … TO gengyun_egress_ledger` + `GRANT gengyun_egress_ledger TO gengyun_api_runtime`）。实测 `108/108/0`、exit 0，复原后指纹回到基线。这顺带证明了「接通账本必须三处同改」不是猜测：**直授 runtime** 会被 `runtime_grants_external_exports` 判红（列级 ACL 越界 + 直授），走组继承才成立。

### 4.6 探针读数（`probe-runtime-grants.sql` [10]/[11]，本集群实测）

探针纪律：`ON_ERROR_STOP=0`、`\set` 捕获 `:SQLSTATE` 原样打印、判定留给读者。实测输出（节选）：

```
--   [10a] SELECT revision, cancelled_at FROM public.exports ⇒ SQLSTATE= 42501 （期望 42501；ERROR= true ）
--   [10b] UPDATE public.exports SET revision = revision ⇒ SQLSTATE= 42501 （期望 42501；ERROR= true ）
--   [10c] 账本就绪探测的三项现状（应 revision_upd=f / cancelled_upd=f / writebacks_present=t）
 f            | f             | t                         | f        ← revision_upd / cancelled_upd / writebacks_present / egress_ledger_role_present
--   [11a] GRANT gengyun_preview_reader TO gengyun_api_runtime ⇒ SQLSTATE= 42501 （期望 42501；ERROR= true ）
--   [11b] CREATE TABLE public.r28_s58_probe(id integer) ⇒ SQLSTATE= 42501 （期望 42501；ERROR= true ）
 r28_s58_probe_table_left
(0 rows)                                                              ← 建表没落地
 r28_s58_runtime_memberships
                           5                                          ← 成员资格仍为 5
```

两个探针节的意义：[10] 把「未就绪」从「服务端会 409」坐实到**动作层**——运行时连这两列的 `SELECT` 都拿不到（`42501`），不是「拿到了但业务不写」；[11] 证明运行时**不能自己扩权**（既不能 `GRANT` 组，也不能在 `public` 建表），与 89 号的静态快照互为事后/当场两侧。

## 5. 变异（逐条真跑）

执行方式：`mut\m*-apply.sql` → 跑 `90-assert`（`-v ON_ERROR_STOP=1`，脚本内取 `$LASTEXITCODE`）→ `mut\m*-restore.sql` → 重算指纹。指纹口径见 `mut\fingerprint.sql`：`pg_roles`（`gengyun_*` 全属性 + `rolconfig`）、`pg_auth_members`（运行时）、`pg_default_acl`、三 schema 的 `relacl`/`attacl`/`proconfig`、`pg_database.datacl`、三 schema 的 `nspacl`。基线指纹 `DF57E21E7940E0375B0581BB84B7FAA02B6C369C21A40465379435B8EB2F91EC`。

| # | 变异 SQL（原文） | 预期 | apply rc | gate rc | 红 | 判红断言 | 关键 detail 片段 | 复原 | 指纹 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| m1 | `ALTER ROLE gengyun_preview_reader LOGIN;` | 身份断言 3 红 | 0 | **3** | 3 | `chain_least_privilege`、`role_attribute_matrix`、`runtime_membership_exact` | `gengyun_preview_reader(super=false,login=true,db=false,role=false,repl=false,bypass=false,inherit=true,conn=-1)` | 0 | 同 |
| m2 | `CREATE ROLE gengyun_r28s58_probe NOLOGIN;` + `GRANT gengyun_r28s58_probe TO gengyun_api_runtime;` | 身份断言 1 红（多一条关系） | 0 | **3** | 1 | `runtime_membership_exact` | 实测 6 条成员资格，多出 `gengyun_r28s58_probe` | 0 | 同 |
| m3 | `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO gengyun_api_runtime;` | 身份断言 2 红（派单口径，实测 1 红） | 0 | **3** | 1 | `no_default_acl_entries` | `gengyun_cvm_owner @ public r = {gengyun_api_runtime=r/gengyun_cvm_owner}` | 0 | 同 |
| m4 | `CREATE FUNCTION public.r28_s58_secdef() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';` | 身份断言 4 红并点名 | 0 | **3** | 1 | `secdef_search_path_pinned` | 实测 9 个 secdef 函数（0 个也判红）；未固定：`r28_s58_secdef() → (未设置 proconfig)` | 0 | 同 |
| m5 | `ALTER ROLE gengyun_api_runtime CREATEDB;` | 身份断言 3 红 | 0 | **3** | 3 | `role_attribute_matrix`、`runtime_login_props`、`chain_least_privilege` | `gengyun_api_runtime(…,db=true,…)` | 0 | 同 |
| m6 | `GRANT UPDATE (revision) ON public.exports TO gengyun_api_runtime;` | 账本断言红（`revision_upd=true` 但 egress 全缺） | 0 | **3** | 2 | `runtime_ledger_readiness_biconditional`、`runtime_grants_external_exports` | 六元组 `true/false/false/false/true/false`；另有「直授 runtime（列级 UPDATE）：revision」 | 0 | 同 |
| m7 | `CREATE TABLE public.export_writebacks (id uuid PRIMARY KEY DEFAULT gen_random_uuid());` | 账本断言红（present=true 其余不全） | **3** | 0 | 0 | —（见右栏） | `ERROR: relation "export_writebacks" already exists`（SQLSTATE 42P07）——0011 迁移已建表，原文变异在本集群是 **no-op** | 无需（无可复原对象） | 同 |
| m7b | `CREATE ROLE gengyun_egress_ledger NOLOGIN;` + `GRANT gengyun_egress_ledger TO gengyun_api_runtime;` | 只接角色不接写位 ⇒ 未就绪臂失效 | 0 | **3** | 2 | `runtime_ledger_readiness_biconditional`、`runtime_membership_exact` | 六元组 `false/false/true/true/true/false` | 0 | 同 |
| m7c | m7b + `GRANT UPDATE (revision, cancelled_at) ON public.exports TO gengyun_api_runtime;`（直授 runtime） | 全接通但表未进清单 ⇒ 红 | 0 | **3** | 3 | `runtime_ledger_readiness_biconditional`、`runtime_grants_external_exports`、`runtime_membership_exact` | 六元组 `true/true/true/true/true/false` | 0 | 同 |

关于 m7：派单给的原文在本集群**必然失败**，因为 `public.export_writebacks` 已由 `0011_export_ledger.sql` 建出。如实记录为「不能执行的 no-op」并补了 m7b/m7c 两个真变异来覆盖「半接通」的三种形态（只接角色、全接通但未进清单）。`m7-restore.sql` 因此**只有注释** —— 绝不能写 `DROP TABLE IF EXISTS`，那会把真实账本表删掉（§7 偏差 3）。

每次复原后指纹与基线相同（`fp_match=True`），九次执行结束后再算一次 `FINAL_FP` 仍等于基线 ⇒ `RESTORED_CLEAN=True`；仓库文件全程 `sha256` 不变（变异只动数据库）。

## 6. 门禁（最终状态，逐条退出码）

| # | 门禁 | 命令 | 退出码 | 读数 |
| --- | --- | --- | --- | --- |
| 1 | 真库 5 组形态跑 90-assert | `psql … -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql` | **0** | 末行 `ok`；`108/108/0`（基线 103 + 本片 5）；stderr 里 6 条 `ERROR: permission denied for table …` 是**探针的预期报错**（识别域禁止面 L668/674/680/686 + 语音域 L910/916），不是断言失败 |
| 2 | m1–m7 逐条读数 | `powershell -NoProfile -File run-mutations.ps1` + `run-ready-arm.ps1` | 见 §5 | 7 条按预期判红/no-op；m7b/m7c 补足半接通 |
| 3 | 契约测试 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | **0** | 全绿 |
| 4 | Lint | `npm run lint` | **0** | 全绿 |
| 5 | 文档核验 | `npm run test:docs` | **0** | 全绿 |
| 6 | 发布材料 | `node tools/verify-release-materials.mjs` | **0** | `15/15 项通过（离线文档核验）` |
| 7 | 空白字符 | `git diff --check` | **0** | 无输出 |
| 8 | 工作树 | `git status --short` | **0** | 提交后干净（无未跟踪/未提交） |

## 7. 偏差记录

1. **`role_attribute_matrix` 对 `gengyun_cvm_owner` 整族豁免特权位**。派单字面要求「`rolsuper` 唯一例外 owner，其余四位全 false」，但实测 owner 的 `rolcreatedb`/`rolcreaterole`/`rolreplication`/`rolbypassrls` **全为 `t`**（超级用户蕴含）。若按字面实现，基线第一条就红。以实测为准：owner 只要求 `rolsuper` 成立且继承/连接数正常，其余角色四位全 false。理由写进断言注释（L2552-2555）。
2. **`runtime_membership_exact` 从 `= 5` 改成 `BETWEEN 5 AND 6`**，白名单补 `gengyun_egress_ledger`。原因见 §4.1：不改则与 93 号就绪臂互斥。这条是跑正向控制时暴露的，不是设计时就想到的 —— 也正是「断言之间必须能同时为真」这条约束的价值。
3. **m7 原文是 no-op（42P07）**，用 m7b/m7c 覆盖派单想表达的语义；`m7-restore.sql` 只写注释，绝不能 `DROP TABLE`。
4. **账本断言是三形态而非两形态**（A 未就绪 / B 就绪 / 其余红）。派单写「双条件」，实现上是「两个合法形态 + 一个兜底红」，这样才能让 m6 单列授权判红（§4.5）。
5. **就绪臂用文件变体 + 组授权验证**，没有把变体提交进仓库：5 组形态下就绪臂不可达是**部署事实**（`provision-db.sh` 不跑 egress 组），变体只是证明断言可达，不能反过来改仓库去迎合它。

## 8. 未取得·待裁定

1. **未在真实 CVM 部署**：本页全部读数来自本机一次性集群；`provision-db.sh` 本体未运行（手工按其顺序复现），socket 路径、`pg_hba`、systemd 单元均未参与。
2. **未验证「真接通」的业务流程**：就绪臂只证明了「权限与清单到位时断言为绿」，没有让 `services/api` 真正写出 `export_writebacks` 行（那需要跑 API 集成测试 + 真实外发链路，超出本片红线）。
3. **`roles/egress_ledger.sql` 的实际内容未审计**：本片按要求不改 `roles/**`，所以「接通账本时该授哪些列/哪些表」只是从 `external_manifest` 的反向判据推导出来的必要形态（`revision`、`cancelled_at` 两列 UPDATE 经组继承），不是从该文件读出来的权威清单。
4. **非 5 组形态（`--with-cli-groups` 的 7 组）未实跑**：CI 口径是 5 组，7 组形态下 `runtime_membership_exact` 的白名单是否仍然正确，本片没有取证。

## 9. 复现

```bash
# 1) 一次性集群（Windows 上不要用 pg_ctl -o "-p …"：PS 5.1 会拆参挂死）
#    port / listen_addresses 写进 postgresql.conf，然后用 Win32_Process 起进程
initdb -D E:\GengYunCommander\.pg17\data-r28s58 -U gengyun_cvm_owner --auth=trust -E UTF8 --locale=C
# postgresql.conf: port = 55660 / listen_addresses = '127.0.0.1'

# 2) 建库 + 26 个迁移 + 只跑默认 5 个组文件（= provision-db.sh 的 CI 口径）
psql -X -q -h 127.0.0.1 -p 55660 -U gengyun_cvm_owner -d postgres -c "CREATE DATABASE gengyun OWNER gengyun_cvm_owner"
for f in services/api/db/migrations/*.sql; do psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55660 -U gengyun_cvm_owner -d gengyun -f "$f"; done
for g in auth_privacy catalog_readers consent_granter profile_runtime knowledge_runtime; do
  psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55660 -U gengyun_cvm_owner -d gengyun -f "services/api/db/roles/$g.sql"
done

# 3) 20-login-roles.sql：口令必须恰好 48 位小写 hex
PGCLIENTENCODING=UTF8 GENGYUN_API_RUNTIME_PASSWORD=<48hex> \
  psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55660 -U gengyun_cvm_owner -d gengyun \
       -f deploy/postgres-cvm/sql/20-login-roles.sql

# 4) 断言（末行判决 + 退出码）
psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55660 -U gengyun_cvm_owner -d gengyun \
     -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql

# 5) 探针（ON_ERROR_STOP=0 是设计的一部分，exit 码无意义）
psql -X -q -h 127.0.0.1 -p 55660 -U gengyun_cvm_owner -d gengyun \
     -v ON_ERROR_STOP=0 -f deploy/postgres-cvm/evidence/probe-runtime-grants.sql

# 6) 变异（本机脚本，不进仓库）
powershell -NoProfile -File E:\GengYunCommander\.pg17\handoff\r28-s58-logs\run-mutations.ps1
powershell -NoProfile -File E:\GengYunCommander\.pg17\handoff\r28-s58-logs\run-ready-arm.ps1
```
