# R28-S43 · 运行时角色「经组继承」的授权面纳入 90-assert

> 切片：R28-S43；分支 `test/gy-r28-runtime-surface-parity`；基线 `upstream/main = 4e93d7b`（含 PR #349 `e01dd67`、PR #352 语音域段 K）。
> 交付物：`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 新增快照 CTE `external_manifest`（L1207-1275）、明细 CTE `external_violations`（L1276-1374）、18 条 `runtime_grants_external_<tbl>`（L2320 起）与 2 条元断言（L2338 `runtime_surface_parity`、L2385 `runtime_surface_no_public_leak`）；本页；报告 `.pg17/handoff/r28-s43-report.md`。
> 一句话问题：`gengyun_api_runtime` 对 18 张 public 表的权限全部来自 `services/api/db/roles/*.sql` 授给 NOLOGIN 组的继承面，而 90-assert 的 49-58 号断言只遍历 `expected`（=`20-login-roles.sql` 的域段落），对这 18 张表**一条逐表断言都没有**；#47 元断言只认一条手写前缀正则、#62 只覆盖硬编码 7 张归档表、#66 只遍历 `domain_manifest` 行 ⇒ 这 18 张表「运行时可见但未断言」，改 `roles/*.sql` 加一列 GRANT 或新表授权，末行照样 `ok`（同类缺口的第 4 次）。

**取证范围声明**：本页全部读数来自**本机一次性 PG 17.11 集群**（`127.0.0.1:55652`，datadir `E:\GengYunCommander\.pg17\data-r28s43`），没有在真实 CVM、没有在 GitHub Actions runner 上执行；`provision-db.sh` 本体未运行，按它的顺序手工复现（26 个迁移 → 8 个角色文件 → `20-login-roles.sql`）。未取得项逐条列在 §7。

## 0. 结论摘要

| 项 | 改前（`4e93d7b`） | 改后 |
| --- | --- | --- |
| 90-assert 断言计数 `TOTAL/OK/BAD` | `83/83/0`（verdict `ok`、exit 0） | **`103/103/0`**（verdict `ok`、exit 0） |
| 18 张「组继承」表的逐表断言 | **0 条**（49-58 只遍历 `expected`，对它们全盲） | 18 条 `runtime_grants_external_<tbl>`：列级正向 + attacl 反向 + 4 个表级位 + 禁止面 |
| 「新表只授权、不登记」检测 | #47 只认手写域前缀正则 ⇒ 陌生表名漏 | `runtime_surface_parity`：public 下运行时有任何权限的关系必须分类 |
| 这 18 张表的 PUBLIC 泄漏检测 | #62/#66 都覆盖不到 | `runtime_surface_no_public_leak`：表级 relacl + 列级 attacl 双查 grantee=0 |
| 快照来源 | — | 本集群实测（表级位 + `pg_attribute.attacl` 直授 + 5 个组定位），**不是抄派单** |
| 变异 5 条（6 次执行，m3 含更正版） | — | 全部按预期判红或按预期 no-op；每条复原后 `103/103/0`；仓库文件 `sha256` 全程不变 |
| 门禁 8 项 | — | 全部 exit 0（§6） |

## 1. 背景与缺口

本机实测（26 迁移 + 8 角色文件 + `20-login-roles.sql` 全量应用后的干净库）：

| 读数 | 值 | 备注 |
| --- | --- | --- |
| `public` 下关系数 | **68** | `pg_class.relkind IN ('r','p','f')` 且属主非系统 |
| 运行时角色**有任何**表级/列级权限的关系 | **43** | 表级 `has_table_privilege` 或 `has_any_column_privilege` |
| `domain_manifest` 行数 | **29** | 24 granted + 1 granted_external + 4 forbidden |
| 上述 manifest 里运行时可见的行 | **25** | 24 granted + `user_backup_copies`(granted_external) |
| ⇒ manifest 未覆盖但运行时可见 | **18** | `43 − 25 = 18`，与派单 §2.1 的 18 张表**逐个同名** |

> 派单 §1 记的是「68 张表 / 40 张可见 / manifest 26 行」，本页是「68 / 43 / 29」：差值恰好是 #352 语音域 3 张表（`speech_jobs`、`transcriptions`、`speech_idempotency`），它们在 `4e93d7b` 里已进 manifest 与 `expected`。缺口表集合与派单一致，18 张不变。

因果链（这是 S24／S28／S38 同一病的第 4 次）：

1. `services/api/db/roles/*.sql` 把权限授给 5 个 NOLOGIN 组；`20-login-roles.sql` C 段再把组授给 `gengyun_api_runtime`，于是运行时**实际**继承了这些权限；
2. 90-assert 的 49-58 号逐表断言是 `FROM expected e` —— `expected` 只登记 `20-login-roles.sql` 各域段落的授权行；组继承面**不在其中**；
3. #47 元断言用一条**手写正则**判断「运行时域前缀」（`^(messages$|community_|ocr_|recognition_|user_backup_copies$|deletion_|third_party_deletions$)`），`roles/*.sql` 授的任意表名不在正则里；
4. #62 只判定硬编码 7 张归档表对 PUBLIC 零权限；#66 只遍历 `domain_manifest` 的 granted 行 ⇒ 这 18 张表的 PUBLIC 泄漏也没人管；
5. 结论：往 `roles/*.sql` 加一列 GRANT、或者新建表授权给运行时，90-assert **全绿**。本片把这条面的「逐列一致 + 分类完备 + PUBLIC 零权限」钉死。

## 2. 快照（18 行，本集群实测）

`sel/ins/upd` 的语义是 **`pg_attribute.attacl` 里的直接列级 ACL 条目**（谁被单独授过这一列），不是 `has_column_privilege` 的投影（见 §3.4）。`t_*` 是表级位。`source_group` 由「把 5 个组逐个 `has_table_privilege`/`has_any_column_privilege` 查一遍」定位，混源记 `A+B`，全不命中记 `direct`。

| # | 表 | source_group | t_sel | t_ins | t_upd | t_del | sel（直接列级 SELECT） | ins | upd |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `admin_accounts` | auth_privacy | f | f | f | f | id, login_name, credential_hash, state, auth_epoch, revision | — | — |
| 2 | `admin_scopes` | auth_privacy | f | f | f | f | admin_id, scope, revoked_at | — | — |
| 3 | `admin_sessions` | auth_privacy | f | f | f | f | id, admin_id, token_hash, audience, auth_epoch, expires_at, revoked_at | admin_id, token_hash, audience, auth_epoch, expires_at | token_hash, revoked_at |
| 4 | `author_links` | auth_privacy | f | f | f | f | user_id | — | — |
| 5 | `consent_policies` | consent_granter | **t** | f | f | f | **—（表级投影，空数组）** | — | updated_at |
| 6 | `consent_records` | auth_privacy+consent_granter | **t** | f | f | f | **—** | user_id, purpose, policy_version, recipient_ids, state, epoch, revision | state, withdrawn_at, revision |
| 7 | `crops` | profile_runtime | f | f | f | f | id, name, active | — | name |
| 8 | `exports` | auth_privacy | f | f | f | f | user_id | — | — |
| 9 | `feature_flags` | **direct** | **t** | f | f | f | **—** | — | — |
| 10 | `idempotency_keys` | auth_privacy | **t** | **t** | f | **t** | **—** | — | response_status, outcome |
| 11 | `jobs` | auth_privacy | f | f | f | f | owner_id | — | — |
| 12 | `media` | auth_privacy | f | f | f | f | owner_id | — | — |
| 13 | `privacy_epochs` | auth_privacy+consent_granter | **t** | f | f | f | **—** | user_id, purpose, current_epoch, state, revision | current_epoch, state, revision, updated_at |
| 14 | `recipients` | consent_granter | **t** | f | f | f | **—** | — | updated_at |
| 15 | `regions` | profile_runtime | f | f | f | f | code, parent_code, name, catalog_version, supported | — | name |
| 16 | `sessions` | auth_privacy | f | f | f | f | id, user_id, token_hash, audience, auth_epoch, expires_at, revoked_at | user_id, token_hash, audience, auth_epoch, expires_at | token_hash, revoked_at |
| 17 | `single_profiles` | profile_runtime | f | f | f | f | user_id, crop_id, region_code, region_catalog_version, revision | user_id, crop_id, region_code, region_catalog_version, revision | crop_id, region_code, region_catalog_version, revision, updated_at |
| 18 | `users` | auth_privacy | f | f | f | f | id, wechat_subject_lookup, state, auth_epoch, revision | wechat_subject_cipher, wechat_subject_lookup | updated_at |

读数汇总：表级 SELECT 只有 **6 张**（第 5、6、9、10、13、14 行），这 6 行的 `sel` 必须为空数组（「全列可读」由 `t_sel = true` 表达）；表级 INSERT/DELETE 只有 `idempotency_keys`（幂等台账，DELETE 已在既有 `allow_table_dml` 白名单里）；18 张表的表级 `UPDATE`/`TRUNCATE`/`REFERENCES`/`TRIGGER` **全为 f**；来源组分布 = auth_privacy 10 张、consent_granter 2 张、profile_runtime 3 张、混源 2 张、direct 1 张（`feature_flags` 的 relacl 直授运行时本体 SELECT，是本批唯一 `source_group = direct`）。

### 2.1 快照是「外部组的授权面」，必须随组文件同步

这张表**不是** 20-login-roles 域授权，而是 `services/api/db/roles/*.sql` 授给组、运行时再继承的面。因此：

- 任何人改 `roles/*.sql`（加列、加表、撤权），都必须同步重推本表；否则 `runtime_grants_external_<tbl>` 会按旧快照判红/漏判；
- 反方向的兜底由 `runtime_surface_parity` 负责：即使忘了同步快照，新授权的关系只要不在 `domain_manifest`/`external_manifest` 里就会判红；
- 重推命令留在 `.pg17/handoff/r28-s43-logs/probe3.sql`（列级 attacl 条目 + 表级 relacl + 组归属 + runtime 成员清单），不要手抄。

### 2.2 派单 §2.1 与实测的 4 处差异（已由指挥裁定，以实测为准）

| 表 | 派单原文 | 本集群实测 | 处理 |
| --- | --- | --- | --- |
| `idempotency_keys` | 表级 SELECT + DELETE | SELECT + **INSERT** + DELETE | 快照记 `t_ins = true`；与既有 `allow_table_dml` 的 `('public','idempotency_keys','INSERT')` 白名单一致，判定为派单笔误 |
| `users` | 列 INSERT 只有 `wechat_subject_cipher` | `wechat_subject_cipher` **+ `wechat_subject_lookup`** | 快照**如实**记两列；⛔ 不改授权（本片只加断言）。`wechat_subject_lookup` 的 INSERT 属「登录建号必须写该列」，**已由 R28-S45 裁定为设计所需**，见 §7 第 2 条 |
| `single_profiles` | 列 INSERT 只有 `user_id, crop_id` | `user_id, crop_id, region_code, region_catalog_version, revision`（5 列） | 快照记 5 列 |
| `privacy_epochs` | 列 SELECT 5 列（不含 `updated_at`） | `has_column_privilege` 对 6 列全真 | 这是**表级 SELECT 投影**，不是漂移：按 §3.4 语义 `sel = []`、`t_sel = true`，`updated_at` 不单列 |

## 3. 三条断言的做法与理由

### 3.1 ① `runtime_grants_external_<tbl>`（18 条，数据驱动）

断言本体很短（L2320）：`to_regclass('public.'||e.tbl) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM external_violations v WHERE v.tbl = e.tbl)`，detail 再把该表的违规明细 `string_agg` 出来。**ok 与 detail 共用同一份 `external_violations` 定义**，所以不会出现「判红但说不出哪一列」。

`external_violations(tbl, what)` 用 15 个 `UNION ALL` 分支，一条违规一行：

| 判据 | 实现 | 为什么 |
| --- | --- | --- |
| 正向：快照里的列必须真能读/写 | `LATERAL unnest(e.sel/ins/upd)` + `has_column_privilege('gengyun_api_runtime', …, 'SELECT'/'INSERT'/'UPDATE')`，全部带 `to_regclass(...) IS NOT NULL` 守卫 | 正向问的是**有效权限**（含表级投影）；缺表时 `has_table_privilege/has_column_privilege` 会直接 `ERROR: relation does not exist` 而不是判红，所以先守卫 |
| 反向：快照外的列不得有对应权限 | `pg_attribute a` × `aclexplode(a.attacl)`，`a.attname <> ALL(e.sel)` 且权限位命中 ⇒ 违规 | 必须读 **attacl 直授**；`has_column_privilege` 在表级 SELECT 的表上对每一列都返回 true，拿它做反向判据等于恒真（见 §3.4） |
| 反向的 REFERENCES | 同一 join，`privilege_type = 'REFERENCES'` **无条件算越界** | 派单要求「任何清单外列不得有对应权限（含 REFERENCES）」；本批 18 张表基线零 REFERENCES |
| 直授运行时本体 | `aclexplode(relacl/attacl)` 且 `grantee = 'gengyun_api_runtime'::regrole` ⇒ 除非 `e.source_group = 'direct'` 否则违规 | 组继承面里的表不该出现「单独又给运行时本体补一条」的影子授权；`feature_flags` 是唯一合法直授（`source_group='direct'`） |
| 表级 4 个位 | `has_table_privilege(...,'SELECT'/'INSERT'/'UPDATE'/'DELETE') IS DISTINCT FROM e.t_*` | 表级权限不是「多授一点无所谓」：它会改变整表的可读/可写边界 |
| 禁止面 | `TRUNCATE` / `REFERENCES` / `TRIGGER` 三连 `CROSS JOIN (VALUES …) AS p(priv)`，任一为真即违规 | 运行时角色不该有这三类表级权限 |
| 缺表 | `to_regclass` 对 `public.<tbl>` 返回 NULL ⇒ 违规「库中不存在」 | 快照行必须真实存在（与 ② 的反向检查互为双保险） |

反向判据的 grantee 门槛（**关键细节**）：`x.grantee = 0 OR pg_has_role('gengyun_api_runtime', x.grantee, 'MEMBER')`。本集群里 `gengyun_egress_ledger` 在 `consent_records`/`exports`/`privacy_epochs`/`recipients`/`users` 上有大量列级 SELECT，但它**不是**运行时成员；若按「凡 attacl 条目都算」判，会把这 5 张表整片误判越界。`pg_has_role('gengyun_api_runtime', 0::oid, 'MEMBER')` 实测返回 `false` 且不报错，所以 PUBLIC(0) 可以安全并入同一谓词（PUBLIC 泄漏同时会在 ③ 单独判红）。

### 3.2 ② `runtime_surface_parity`（L2338）

`public` 下凡 `relkind IN ('r','p','f')` 且运行时**表级或列级**持有 `SELECT/INSERT/UPDATE/DELETE/REFERENCES` 任一权限的关系，必须在 `domain_manifest`（任意分类）**或** `external_manifest` 里；反向再查 `external_manifest` 每行真实存在。detail 用 `string_agg` 列出越界表名（不手写表名）。

它是本片真正的兜底：#47 依赖「域前缀正则」，对 `roles/*.sql` 新授的任意表名是盲的；这条不依赖命名约定，**只要有人给运行时加了新授权而没登记，就红**。m4 就是它的负控制。

### 3.3 ③ `runtime_surface_no_public_leak`（L2385）

对 `external_manifest` 的 18 张表断言 `PUBLIC` 零权限：表级 `aclexplode(relacl)` 与列级 `aclexplode(attacl)` 两处都查 `grantee = 0`，detail 列出越界表名。

没有并入 #62：`#62` 是硬编码 7 张归档表（`public_no_privilege_favorites_history` 系列），并入会改变既有断言语义、也与在途 PR #352 冲突；独立一条能把「18 张组继承表」的 PUBLIC 面单独定位。m5 证明它与 ① 各自独立触发（PUBLIC 授权同时让 ① 的表级 SELECT 位不符、并连带既有 `knowledge_runtime_scope`）。

### 3.4 为什么数组必须取「直接列级 ACL」，而不是 `has_column_privilege`

设 `consent_records` 有表级 SELECT：`has_column_privilege` 对该表**每一列**都返回 true。若用它填 `sel`：

- 快照会写成 8 列全列，看上去「这 8 列是被单独授的」——信息失真；
- 反向判据若也用 `has_column_privilege`，则「不在数组里的列有 SELECT」永远为假，**恒真**，等于没写；
- 更糟的是：后来有人 `GRANT SELECT (some_col) ON consent_records TO runtime`（表级 SELECT 已覆盖，属冗余直授），投影口径下 `some_col` 早就在数组里，**查不出来**。

所以本片把两者分开：**正向用有效权限**（该读的必须读得到），**反向用 attacl 直授条目**（不该单独授的一列都不行）。6 张有表级 SELECT 的表因此 `sel = []`，「全列可读」只由 `t_sel = true` 表达。

m1 是这条语义的实证：`crops` 没有表级 SELECT，`id` 经 `profile_runtime` 的列级 GRANT 可读；再 `GRANT SELECT (id) … TO runtime` 并不改变有效权限（本来就 true），**只有 attacl 反向判据**能把这条影子直授揪出来，detail 点名 `id`。

### 3.5 为什么把明细拆成 `external_violations` CTE

18 条断言的 ok 与 detail 若各写一遍 15 个分支，既冗长又容易「ok 判红、detail 说无违规」。拆成 CTE 后一处定义、两处引用：ok 问「有没有违规行」，detail 把同一批行拼成人话。`external_violations` 只在这 18 条断言里被引用，不参与 ②/③。

## 4. 读数

| 口径 | 命令 | 读数 |
| --- | --- | --- |
| 改前总数 | `count.sql` 引用 HEAD 版抽取件 `pre-change-90.sql` | **`83/83/0`**（`count-pre.out`） |
| 改后总数 | `count.sql` 引用工作树版 | **`103/103/0`**，`sum(length(label)+2)=3239`、最长 label 50 |
| 改后合规态 | `psql -v ON_ERROR_STOP=1 -f 90-assert-least-privilege.sql` | exit **0**，输出 243 行，verdict 行 `ok`（倒数第二行；最后一行 `DO` 是收尾 DO 块的命令标签，HEAD 版同样如此） |

`count.sql` 的计数方式：`\set ON_ERROR_STOP 0` → `\i 90-assert…` → `SELECT count(*), count(*) FILTER (WHERE ok IS TRUE), count(*) FILTER (WHERE ok IS NOT TRUE), sum(length(label)+2), max(length(label)) FROM r28_assert_results;`。即 `TOTAL/OK/BAD` 全部取自脚本自己建的 `r28_assert_results` 临时表，不依赖终端里的 PASS/FAIL 文案。

18 条新断言 = 18 张表；2 条元断言；`83 + 18 + 2 = 103`，与读数一致。改前这 18 张表在 90-assert 里「可见但无逐表断言」，属于**假绿**：本页 §0 第一行就是改前改后的对照。

## 5. 变异（负控制，全部在库内做，仓库文件一字未改）

`sha256(90-assert-least-privilege.sql)` 在全部变异前后恒为 `656793BF6BC704991D9DCC5690C3193F4215ED559E746FDB8EF822B1315614CA`（变异只发 SQL 到库，不写文件）。每条 revert 后复跑 `103/103/0`。SQL 与输出在 `.pg17/handoff/r28-s43-logs/mut/final/`。

| 变异 | SQL（原文） | 预期 | 实测判红断言 | detail 关键片段 | 复原 |
| --- | --- | --- | --- | --- | --- |
| m1 | `GRANT SELECT (id) ON public.crops TO gengyun_api_runtime;` | 越出快照（干净列） | `runtime_grants_external_crops` | 「直授 runtime（列级 SELECT）：id」 | `REVOKE SELECT (id) … FROM …`，复跑 `103/103/0` |
| m2 | `GRANT SELECT ON public.crops TO gengyun_api_runtime;` | 表级越界 | `runtime_grants_external_crops` | 「直授 runtime（表级 SELECT）；表级 SELECT 位不符：快照 false，实际 true」 | `REVOKE SELECT ON …`，复跑 `103/103/0` |
| m3a | `REVOKE SELECT (name) ON public.regions FROM gengyun_api_runtime;` | 派单原文「少授」 | **无（no-op，仍 `103/103/0`）** | 权限在组上，从 runtime 本体撤不到任何东西；PG 只回 `REVOKE` | 无需复原（状态未变） |
| m3b | `REVOKE SELECT (name) ON public.regions FROM gengyun_profile_runtime;` | 真正少授（更正版） | `runtime_grants_external_regions` | 「缺列级 SELECT：name」 | `GRANT SELECT (name) … TO gengyun_profile_runtime`，复跑 `103/103/0` |
| m4 | `CREATE TABLE public.new_domain_probe(x text); GRANT SELECT (x) ON public.new_domain_probe TO gengyun_api_runtime;` | 新域只授权、不登记 | `runtime_surface_parity` | 「未分类、或清单里有而库里没有的：new_domain_probe」 | `DROP TABLE public.new_domain_probe`，复跑 `103/103/0` |
| m5 | `GRANT SELECT ON public.admin_sessions TO PUBLIC;` | PUBLIC 泄漏 | `runtime_surface_no_public_leak`（+ `runtime_grants_external_admin_sessions`，+ 既有 `knowledge_runtime_scope`） | 「越界表：admin_sessions」/「表级 SELECT 位不符」/ PUBLIC 让 knowledge_runtime 也看得见 admin_sessions | `REVOKE SELECT ON … FROM PUBLIC`，复跑 `103/103/0` |

m3 的说明：派单原文对一个**组继承**的权限执行「从运行时撤权」，物理上是空操作——权限条目挂在组上，`REVOKE … FROM gengyun_api_runtime` 撤不到继承面。本页按原文跑了一次并如实记录为 no-op，再用更正版（从 `gengyun_profile_runtime` 撤）证明 ① 的正向判据有牙齿。建议后续派单把「少授」类变异写成组级撤权。

m5 的三条红里，`knowledge_runtime_scope` 是既有断言：PUBLIC 授权让 `gengyun_knowledge_runtime` 也「看得见」`admin_sessions`，属连带失败，不是本片新增断言的误报；`runtime_surface_no_public_leak` 与 `runtime_grants_external_admin_sessions` 各自独立命中。

## 6. 门禁（8 项，全部 exit 0）

| # | 命令 | exit | 读数 |
| --- | --- | --- | --- |
| 1 | `npm run lint` | 0 | `PASS tsc --noEmit apps/admin/tsconfig.json`；`PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）`；`lint 通过` |
| 2 | `node tools/verify-release-materials.mjs` | 0 | `15/15 项通过` |
| 3 | `npm run test:docs` | 0 | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住`；`PASS docs/research 结构校验` |
| 4 | `node tools/verify-contract-status.mjs` | 0 | `PASS: 纯行号区间 229 条`；`PASS: 中文表格一致`；`PASS: 状态为人工判定` |
| 5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | `tests 6 / pass 6 / fail 0` |
| 6 | `node --test --test-concurrency=1 tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` | 0 | `tests 23 / pass 23 / fail 0` |
| 7 | `git diff --check`（工作树 + `upstream/main..HEAD`） | 0 / 0 | 两口径均无输出 |
| 8 | 真库 `90-assert-least-privilege.sql`（PG 17.11 @55652） | 0 | verdict 行 `ok`；`103/103/0` |

日志：`.pg17/handoff/r28-s43-logs/gates/g1…g6-*.txt`、`final-90.out`、`final-count.out`。

## 7. 未取得 / 待裁定

1. **真实 CVM 与 GitHub Actions runner 未跑**：本页全部读数来自本机一次性集群（55652），`provision-db.sh` 本体未执行。
2. **`users.wechat_subject_lookup` 的列级 INSERT：已裁定为设计所需（R28-S45，2026-10-21）**：结论是**不改授权**。代码出处：登录建号语句 `services/api/src/auth/store.ts:249-251`（`INSERT INTO users (wechat_subject_lookup, wechat_subject_cipher) VALUES (decode($1, 'hex'), NULL) RETURNING id, state, auth_epoch, revision`）必须写 lookup 列，cipher 列与它同处一句 INSERT 的列清单、实参传 `NULL`；建号前的查找 `services/api/src/auth/store.ts:235` 按 lookup 定位既有行。授权出处：`services/api/db/roles/auth_privacy.sql:11-12`（SELECT 5 列、INSERT 两列），列定义见 `services/api/db/migrations/0001_initial_schema.sql`（`wechat_subject_lookup bytea`、`wechat_subject_cipher text`、唯一索引 `users_subject_lookup_key`）。本机真库探针（本片 90-assert 新增第 104 条 `runtime_users_login_insert_path`，以 `gengyun_api_runtime` 身份真跑、每条 SAVEPOINT 内、整段 ROLLBACK 零残留）：① 建号 INSERT 两列 **成功**（SQLSTATE 00000）② 同形 INSERT 多写 `nickname` ⇒ **42501** ③ 按 lookup 读 5 列 **成功**（00000）④ 读 `nickname` ⇒ **42501** ⑤ 改 `nickname` ⇒ **42501**。边界：**本判定基于代码取证 + 本机真库探针，未在 CVM/生产验证**。详见 `docs/verification/gy-r28-users-insert-probe-20261021.md`。
3. **18 张表的业务语义未被验证**：本片只证明「当前授权面与快照逐列一致、无未分类表、无 PUBLIC 泄漏」，不证明这些权限在业务上仍然必要（例如 `idempotency_keys` 的表级 INSERT/DELETE、`sessions`/`admin_sessions` 的 5 列 INSERT 是否过宽）。
4. **PUBLIC 授权的跨角色影响只有一次实测**：m5 显示 `knowledge_runtime_scope` 会连带判红，说明 PUBLIC 泄漏会影响其他角色断言；本片未穷举「PUBLIC 授权对每个角色断言的影响矩阵」。
5. **`gengyun_egress_ledger` 的列级授权未被本片覆盖**：它不是运行时成员，不在 `external_manifest` 里；反向判据已按 membership 排除它，但它的授权面是否合规不在本片范围。
6. **`m3a` 的 no-op 是派单设计问题，不是断言能力问题**：已在 §5 记录，并用 m3b 补证；建议后续派单修正「少授」类变异的写法。
7. **组文件与 20-login-roles 未改**：本片是纯断言片；若后续要收紧任何一条授权，必须另开切片并同步本页快照（`users.wechat_subject_lookup` 的列级 INSERT 已被 R28-S45 裁定为登录建号设计所需，不再算收紧候选，见 §7 第 2 条）。
8. **集群状态**：一次性集群已在交付后 `pg_ctl -D E:\GengYunCommander\.pg17\data-r28s43 -m fast stop`（报告里记「已停」）。

## 8. 复现命令

```bash
# 1) 建库（26 迁移 → 8 角色文件 → 20-login-roles.sql，含一次性口令）
bash .pg17/handoff/r28-s43-logs/build-cluster.sh

# 2) 合规态 + 计数
psql -h 127.0.0.1 -p 55652 -U gengyun_cvm_owner -d gengyun -v ON_ERROR_STOP=1 \
  -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql
psql -h 127.0.0.1 -p 55652 -U gengyun_cvm_owner -d gengyun \
  -f .pg17/handoff/r28-s43-logs/count.sql     # 期望 103|103|0

# 3) 变异（在库内做，改完复原）
psql … -f .pg17/handoff/r28-s43-logs/mut/m1-apply.sql   # 期望 runtime_grants_external_crops 红
psql … -f .pg17/handoff/r28-s43-logs/mut/m1-revert.sql
```

门禁命令见 §6；`count.sql`、`pre-change-90.sql`、`mut/*` 与全部门禁输出都在 `.pg17/handoff/r28-s43-logs/`。

## 9. 返修：探针 [9b-3] 改为零行形态（监工 P2，2026-10-21）

监工批复指出：deploy/postgres-cvm/evidence/probe-runtime-grants.sql 的 [9b-3] 原用真实 INSERT ... VALUES，而全文件没有 BEGIN/ROLLBACK；若被测的错误授权**真的存在**，psql 默认 autocommit 会留下一行 s52-probe 批次，与本文件头「只读探针、零行写入、可对同一库复跑」的承诺直接冲突（不能靠「正确权限下必然 42501」来保证安全）。

返修改为本文件第 2 条纪律的既有形态 INSERT ... SELECT ... WHERE false：权限检查仍在执行器启动阶段发生（缺权必 42501），但零行 ⇒ 即使意外放行也不留数据。

真跑读数（127.0.0.1:55663、库 gengyun、26 迁移 + 5 组角色 + 20-login-roles.sql）：

`
-- [9b-3] INSERT INTO staging_intake.batches …：写面只授 staging_executor/staging_importer
psql:…/probe-runtime-grants.sql:779: ERROR:  42501: permission denied for schema staging_intake
--   → [9b-3] staging_intake.batches INSERT state = 42501
`

- 前后计数：SELECT count(*) FROM staging_intake.batches 探针前 **0**、探针后 **0**；
- 全文件 psql -v ON_ERROR_STOP=0 -f … exit 0，其余各节读数与 §7 一致；
- 边界：本机真库读数，未在 CVM/生产执行。
