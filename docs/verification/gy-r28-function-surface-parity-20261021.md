# R28-S51 · 函数面兜底清单 + 四条断言（并修掉 `consent_policy_immutable()` 的 PUBLIC EXECUTE 漏网）

> 切片：R28-S51；分支 `test/gy-r28-function-surface-parity`；基线 `e1c0479`（PR #357 合入后的 main 快照；本基线 90-assert 为 103 条断言）。
> 交付物：
> - `deploy/postgres-cvm/sql/90-assert-least-privilege.sql`：R28-S51 真执行探针段（L924-961）、`function_surface_manifest` 与三个派生 CTE（L1414-1522）、四条 `runtime_function_*` 断言（L2576-2631）；
> - `deploy/postgres-cvm/sql/20-login-roles.sql`：段 L（标题 L900，`REVOKE` 在 L920）收回 `public.consent_policy_immutable()` 的 PUBLIC EXECUTE；
> - `deploy/postgres-cvm/evidence/probe-runtime-grants.sql`：段 [8]（L611-690）函数面逐函数读数 + 真执行探针；
> - 本页；报告 `.pg17/handoff/r28-s51-report.md`。
> 一句话问题：PostgreSQL 给**新建函数**默认 `GRANT EXECUTE … TO PUBLIC`（物化形态是 `pg_proc.proacl IS NULL`），而旧版 90-assert 只有 5 组**点名式**逐函数断言。于是「新增一个 SECURITY DEFINER 函数」或「某个函数忘了 REVOKE PUBLIC」都不会让任何断言变红——实测 `public.consent_policy_immutable()` 仍是 `proacl IS NULL`；本片把函数面从「点过名」升级为「必须分类」，并修掉这一处真实漏网。

**取证范围声明**：本页全部读数来自**本机一次性 PG 17.11 集群**（`127.0.0.1:55656`，datadir `E:\GengYunCommander\.pg17\data-r28s51`），没有在真实 CVM、没有在 GitHub Actions runner 上执行；`provision-db.sh` 本体未运行，按它的顺序手工复现（26 个迁移 → 8 个角色文件 → `20-login-roles.sql` → `90-assert-least-privilege.sql`）。未取得项逐条列在 §7。本集群的属主 `gengyun_cvm_owner` 是 `initdb` 创建的**超级用户**（`rolsuper = t`），这是 §7 第 2 条的限制来源。

## 0. 结论摘要

| 项 | 改前（`e1c0479`） | 改后 |
| --- | --- | --- |
| 90-assert 断言计数 `TOTAL/OK/BAD` | **`103/103/0`**（verdict `ok`、exit 0） | **`107/107/0`**（verdict `ok`、exit 0） |
| 函数面兜底清单 | **不存在** | `function_surface_manifest` 11 行：runtime 6 / internal 3 / trigger 2 |
| 「新增 SECURITY DEFINER 未登记」检测 | #？无（5 组断言只认点名的函数） | `runtime_function_manifest_complete`：三个 schema 的 `prosecdef` 双向差集 |
| 「新函数默认 PUBLIC 可执行」检测 | 只有点名的 `admin_audit_events_reject_mutation` 在 0017:335 收回，无通用检测 | `runtime_function_no_public_execute`：三个 schema 全函数 `has_function_privilege('public', oid, 'EXECUTE')` |
| 「多授/少授 EXECUTE」检测 | 个别点名的断言（如 `accounts_read_function_execute`） | `runtime_function_grantee_sets`：11 条清单函数除属主外的 grantee 集合**精确等于** `allowed_grantees` |
| 真执行证明 | 无（只看 ACL） | `runtime_function_exec_probe`：`SET LOCAL ROLE gengyun_api_runtime` 真跑 5 条，正向 2×`00000`、反向 3×`42501` |
| `public.consent_policy_immutable()` | `proacl IS NULL` ⇒ **PUBLIC 可执行**（真实漏网） | `{gengyun_cvm_owner=X/gengyun_cvm_owner}`，PUBLIC 不可执行 |
| 变异 5 条 | — | 全部按预期判红；复原后逐条回到 `107/107/0`；`20-login-roles.sql` 的 sha256 逐字节复原 |
| 门禁 7 项 | — | 全部 exit 0（§6） |

## 1. 缺口与因果链

本机实测（26 迁移 + 8 角色文件 + `20-login-roles.sql` 后的干净库）：

| 读数 | 值 | 备注 |
| --- | --- | --- |
| 三个 schema 的函数总数（`prokind='f'`） | **48** | `public` 8 / `catalog_ops` 1 / `staging_intake` 39 |
| 其中 `SECURITY DEFINER` | **8** | 5 个 public 账号/权限函数 + 2 个 staging_internal + 1 个 catalog_ops |
| 其中 `pgcrypto` 扩展自带 | **36** | 全在 `staging_intake`（extension 安装时落在当前 schema） |
| 清单登记的 11 条之外的非扩展函数 | **1** | `staging_intake.python_json(jsonb)`（0007:31 建、0007:45 已 REVOKE PUBLIC） |
| `proacl IS NULL`（= PUBLIC 可执行）的函数 | **1** | 只有 `public.consent_policy_immutable()` |
| 三个 schema 的序列数 / 全库序列数 | **0 / 0** | 本片没有序列面工作（派单 §1 的「sequences 0」实测成立） |

旧版的检测方式（`e1c0479`）：

1. 逐个函数点名断言：`accounts_read_function_execute`（`public.list_admin_accounts()`）、`suspend_function_execute`（`public.suspend_account(...)`）等 5 组，只认**写死在断言里**的函数；
2. 对 PUBLIC 面只有两处定点检查：`public.admin_audit_events_reject_mutation()` 在 `0017_account_suspend_authority.sql:335` 显式 `REVOKE`，没有遍历；
3. 对函数 grantee 集合没有任何「等于预期」的判据；
4. 于是因果链是：迁移新增一个 `SECURITY DEFINER` 函数 → 没有任何断言知道它存在 → 90-assert 全绿；若这个函数还是「新建后默认 PUBLIC 可执行」且没人补 REVOKE，则任何角色（含 `gengyun_api_runtime`）都能显式调用它，从而以属主身份**绕过前面所有表级 REVOKE**；
5. `public.consent_policy_immutable()` 正是这条链上的实例：它是 `services/api/db/migrations/0009_consent_policy.sql:39` 建在 `consent_policies` 上的 `BEFORE UPDATE OR DELETE` 触发器函数（`prosecdef = false`），建后从未 REVOKE，`proacl` 一直是 NULL。改前直接 `SET ROLE gengyun_api_runtime; SELECT public.consent_policy_immutable();` 会走到 `0A000 trigger functions can only be called as triggers`（说明权限检查已通过），改后必须是 `42501`。

本片做的事：把「点过名的函数」升级成「必须分类的函数面」（清单 + 双向完备性），把 PUBLIC 面做成全函数遍历，把 grantee 集合做成精确匹配，再用 `SET ROLE` 真执行证明「ACL 正确 ≠ 运行时真能用/真不能用」。

## 2. 函数面清单（11 行，本集群实测）

`allowed_grantees` 记的是**非属主**的 ACL 项，不是「函数归属组」。属主权限是隐式的、不出现在 `proacl` 里——这一点与派单 §1 的表格不同，见下方说明。

| # | 函数 | kind | 属主（实测） | 非属主 EXECUTE grantee（实测） | `allowed_grantees` |
| --- | --- | --- | --- | --- | --- |
| 1 | `public.list_admin_accounts()` | runtime | `gengyun_cvm_owner` | `gengyun_api_runtime` | `['gengyun_api_runtime']` |
| 2 | `public.request_account_deletion(...)` | runtime | `gengyun_cvm_owner` | `gengyun_api_runtime` | `['gengyun_api_runtime']` |
| 3 | `public.restore_account(...)` | runtime | `gengyun_cvm_owner` | `gengyun_api_runtime` | `['gengyun_api_runtime']` |
| 4 | `public.set_feature_flag(...)` | runtime | `gengyun_cvm_owner` | `gengyun_api_runtime` | `['gengyun_api_runtime']` |
| 5 | `public.suspend_account(...)` | runtime | `gengyun_cvm_owner` | `gengyun_api_runtime` | `['gengyun_api_runtime']` |
| 6 | `public.admin_account_display_name(text, uuid)` | runtime | `gengyun_cvm_owner` | `gengyun_api_runtime` | `['gengyun_api_runtime']` |
| 7 | `catalog_ops.apply_source_operation(uuid, text, uuid, uuid, integer, text, text, uuid)` | internal | **`gengyun_source_executor`** | `gengyun_source_operator` | `['gengyun_source_operator']` |
| 8 | `staging_intake.apply_import(uuid, jsonb, uuid)` | internal | **`gengyun_staging_executor`** | `gengyun_staging_importer` | `['gengyun_staging_importer']` |
| 9 | `staging_intake.rollback_import(uuid, uuid, uuid, text)` | internal | **`gengyun_staging_executor`** | `gengyun_staging_importer` | `['gengyun_staging_importer']` |
| 10 | `public.consent_policy_immutable()` | trigger | `gengyun_cvm_owner` | （无） | `[]` |
| 11 | `public.admin_audit_events_reject_mutation()` | trigger | `gengyun_cvm_owner` | （无） | `[]` |

分类口径：

- **runtime**：`gengyun_api_runtime` 必须能执行（`admin_account_display_name` 是唯一非 `SECURITY DEFINER` 的 runtime 函数：纯计算、不碰表）；
- **internal**：只给运维/导入组用，运行时必须 42501；
- **trigger**：触发器函数，除属主外谁都不许有 EXECUTE（PUBLIC 也不行）。触发器由 PostgreSQL 在触发语句里以函数属主语义调用，**不检查调用者的 EXECUTE**，所以收回 PUBLIC 不影响触发器本体。

> **与派单 §1 的差异（实测为准）**：派单写 `apply_source_operation`「非属主授予：`gengyun_source_executor` + `gengyun_source_operator`」，写两条 staging 函数「`gengyun_staging_executor` + `gengyun_staging_importer`」。实测 `gengyun_source_executor` / `gengyun_staging_executor` 是**属主**（`source_operator.sql:16`、`staging_importer.sql:17-18` 的 `ALTER FUNCTION … OWNER TO`），不是被 GRANT 的 grantee；把它们写进 `allowed_grantees` 会让断言 3 在基线就判「少授 executor」。清单只列 `gengyun_source_operator` / `gengyun_staging_importer`。另外派单 §2.2 写「§1 的 9 条」，但同一段枚举是 6 + 3 + 2 = 11 条，实现按 11 条。
>
> `staging_intake.python_json(jsonb)` 不在清单里：它是 0007 建的普通（非 `SECURITY DEFINER`）辅助函数，只授 `gengyun_staging_executor`、0007:45 已 REVOKE PUBLIC，不属于派单 §1 的 runtime/internal/trigger 三类。断言 2 对它的 PUBLIC 面仍有兜底；断言 3 不覆盖它（见 §7 第 3 条）。

## 3. 四条断言

四条断言都在 `checks` CTE 末尾新增，label 前缀统一 `runtime_function_`：

| # | label | 语义 | 实现要点 | 改前 → 改后 |
| --- | --- | --- | --- | --- |
| 1 | `runtime_function_manifest_complete` | 三个 schema 下每个 `SECURITY DEFINER` 函数都必须在清单里；清单每条也必须真实存在 | `function_manifest_gaps` 双向差集：正向按 `prosecdef` + `schema/名称` 反查清单，反向按清单查 `pg_proc`（`prokind='f'`）；detail 用 `string_agg` 把「函数名：差异说明」用 ` / ` 拼接 | 无此断言 → `107` 里通过 |
| 2 | `runtime_function_no_public_execute` | 三个 schema 下**任何**函数都不得对 PUBLIC 可执行 | 全量遍历 `pg_proc`（不限于清单），`has_function_privilege('public', p.oid, 'EXECUTE')` 必须全 false；detail 列 `schema.name` | 无此断言；改前在未修库上跑本片新版**实测判红**（§4） |
| 3 | `runtime_function_grantee_sets` | 每条清单函数除属主外的 EXECUTE grantee 集合**恰好等于** `allowed_grantees`（多授/少授都红） | `function_manifest_grantee_sets` 用 `aclexplode(p.proacl)` 取 `privilege_type='EXECUTE'` 且 `a.grantee <> p.proowner`，`COALESCE(r.rolname,'PUBLIC')`；`proacl IS NULL` ⇒ `aclexplode` 无行 ⇒ 空数组；`function_manifest_grantee_violations` 用 `CROSS JOIN LATERAL` 算 `extra`/`missing`，排序后再比较，detail `多授 …`/`少授 …` | 无此断言 → 通过 |
| 4 | `runtime_function_exec_probe` | ACL 正确不等于运行时真能用/真不能用 | 上方探针段（L924-961）以 `SET LOCAL ROLE gengyun_api_runtime` 真跑 5 条，每条套 `SAVEPOINT`，读 `:SQLSTATE`（不是 `:ERROR`）；断言比对 5 个 psql 变量：`00000/00000/42501/42501/42501` | 无此断言 → 通过 |

`has_function_privilege('public', oid, 'EXECUTE')` 在 PG 17.11 实测可用（`'public'` 映射到 ACL 的 grantee 0），与「`aclexplode` 里查 `grantee = 0`」等价；`proacl IS NULL` 时它返回 true，正是默认 PUBLIC 授权的物化形态。

探针的 5 条语句（与 `probe-runtime-grants.sql` 段 [8] 同形）：

```sql
SELECT count(*) FROM public.list_admin_accounts();                          -- 正向：00000（空表 0 行）
SELECT public.admin_account_display_name('探测', gen_random_uuid());        -- 正向：00000（返回「探测」）
SELECT catalog_ops.apply_source_operation(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL); -- 反向：42501
SELECT staging_intake.apply_import(NULL,NULL,NULL);                         -- 反向：42501
SELECT staging_intake.rollback_import(NULL,NULL,NULL,NULL);                 -- 反向：42501
```

反向三条在权限检查阶段就被拒，函数体不执行，所以全 NULL 实参安全。**注意**：实测 `catalog_ops` / `staging_intake` 的拒权先落在 **schema USAGE** 上（`ERROR: permission denied for schema catalog_ops`），SQLSTATE 仍是 42501——断言 4 只看 SQLSTATE，所以判红/判绿都成立；这也意味着「函数级 EXECUTE 被收回」与「schema 不可见」在本集群读数上不可区分（§7 第 5 条）。

## 4. 读数

| 口径 | 命令/日志 | 读数 |
| --- | --- | --- |
| 改前总数 | `E:\GengYunCommander\.pg17\handoff\r28-s51-logs\05-baseline-assert.log`（未改版 90-assert） | **`103/103/0`**，psql exit 0；`sum(length(label)+2)=3239`、最长 label 50（改前 DO 注释里的 S43 实测值） |
| 改后总数 | `08-after-fix-assert.log`（`count-asserts.sql`） | **`107/107/0`**，psql exit 0 |
| 改后统计 | `09-assert-stats.log`（`stats.sql`） | `sum(length(label)+2)=3371`、最长 label 50（已回写进 DO 注释） |
| 改后合规态 | `08-after-fix-assert.log`（`psql -v ON_ERROR_STOP=1`，含 90-assert 全量输出） | exit 0，verdict 行 `ok` |
| 新增断言的红证据（改前库、新版脚本） | `06-prefix-red-on-unfixed-db.log` | `FAIL: runtime_function_no_public_execute (PUBLIC 可执行：public.consent_policy_immutable)` |
| 修完 20-login 后同库复跑 | `07-login-roles-rerun.log` → `08` | `107/107/0` |

`count-asserts.sql` 的计数方式：`\pset tuples_only on` + `\pset format unaligned` → `\i 90-assert…` → `SELECT 'COUNT ' || count(*) || '|' || count(*) FILTER (WHERE ok) || '|' || count(*) FILTER (WHERE NOT ok) FROM r28_assert_results;`，`TOTAL/OK/BAD` 全部取自脚本自己建的会话级临时表，不数终端里的 PASS/FAIL 文案。`103 + 4 = 107`，与读数一致。

`probe-runtime-grants.sql` 段 [8] 的实测（`10-probe-after.log`）：

- 逐函数矩阵 11 行，与 §2 表逐行一致：`secdef` 8 个 t、`acl_is_null` 全 f、`public_exec` 全 f；
- 每个 schema 的「函数总数 / PUBLIC 可执行」：`catalog_ops 1/0`、`public 8/0`、`staging_intake 39/0`；
- `[8a]` 两行正常结果：`admin_accounts_rows = 0`（空表）、`display_name = 探测`；
- `[8b]/[8c]` 五条各一行 `ERROR: 42501`（8c 的 `consent_policy_immutable` 与 `admin_audit_events_reject_mutation` 是 `permission denied for function`，8b 的两条 staging + 一条 catalog_ops 是 `permission denied for schema`，SQLSTATE 均 42501）；
- 探针是**只读**的：不写任何表，正向两条要么零行、要么纯计算。

> 日志里 psql 的 stderr（42501 行）可能排在 stdout 末尾而不是紧跟在语句位置（重定向把两个流分开缓冲），以 `ERROR: 42501` 文本和 SQLSTATE 为准，不是探针顺序错。

## 5. 变异（5 条，全部「红 → 复原 → 绿」）

5 条按派单 §2.3 逐条做，日志在 `.pg17/handoff/r28-s51-logs/11-*`、`14-m4-*`。除 m4 外都在库内做、仓库文件不动；m4 必须改 `20-login-roles.sql` 字节，复原后 `sha256` 逐字节相等。

| 变异 | 改动 | 预期 | 实测（判红断言与关键 detail） | 复原 → 绿 |
| --- | --- | --- | --- | --- |
| m1 | `CREATE FUNCTION public.r28_s51_m1_probe() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';` | 断言 1 红（未登记的 SECURITY DEFINER） | `COUNT 107\|105\|2`：`runtime_function_manifest_complete`（`public.r28_s51_m1_probe：pg_proc 中是 SECURITY DEFINER，但清单未登记`）+ `runtime_function_no_public_execute`（`PUBLIC 可执行：public.r28_s51_m1_probe`） | `DROP FUNCTION public.r28_s51_m1_probe();` → `107/107/0` |
| m2 | `GRANT EXECUTE ON FUNCTION public.list_admin_accounts() TO PUBLIC;` | 断言 2 红（PUBLIC 面） | `107\|104\|3`：`runtime_function_no_public_execute`、`runtime_function_grantee_sets`（`public.list_admin_accounts（多授 PUBLIC）`），连带既有 `accounts_read_function_execute` | `REVOKE EXECUTE … FROM PUBLIC;` → `107/107/0` |
| m3 | `GRANT EXECUTE ON FUNCTION public.suspend_account(uuid,uuid,uuid,integer,uuid) TO gengyun_consent_granter;` | 断言 3 红（多授） | `107\|105\|2`：`runtime_function_grantee_sets`（`public.suspend_account（多授 gengyun_consent_granter）`），连带既有 `suspend_function_execute` | `REVOKE EXECUTE … FROM gengyun_consent_granter;` → `107/107/0` |
| m4 | 在 `20-login-roles.sql` 的 `REVOKE ALL ON FUNCTION public.consent_policy_immutable() FROM PUBLIC;` 前插 `-- `（注释掉），重建库后跑 90-assert | 断言 2 红（`proacl IS NULL` ⇒ PUBLIC 可执行） | `COUNT 107\|106\|1`：唯一红是 `runtime_function_no_public_execute`（`PUBLIC 可执行：public.consent_policy_immutable`），`proacl = <NULL>` | 复原文件字节（`sha256` 相等）→ 重跑修好的 20-login → `107/107/0` |
| m5 | `GRANT USAGE ON SCHEMA staging_intake TO gengyun_api_runtime;` + `GRANT EXECUTE ON FUNCTION staging_intake.apply_import(uuid,jsonb,uuid) TO gengyun_api_runtime;` | 断言 4 红（反向探针拿到 00000） | `107\|105\|2`：`runtime_function_exec_probe`（`…apply_import=G0001…`）+ `runtime_function_grantee_sets`（`staging_intake.apply_import（多授 gengyun_api_runtime）`） | 两条 `REVOKE` → `107/107/0` |

m4 的完整过程（派单原文「注释掉 → 重跑 → 红」在已有库上不成立：`REVOKE` 已经物化进 `proacl`，删掉语句不会让 ACL 回到 `NULL`）：

1. 备份 `20-login-roles.sql`，sha256 = `0249C2F4EA9B2C647D6E3CBF9DC15A1A9432A326C328E50F19D7D1C2E8FFAF0A`（62680 字节）；
2. 在 `REVOKE` 行前插入 `-- `（3 字节），sha256 = `6480E96A8950A8C35387E35192833F65655423DB355F629CF15F3E0F51C3DFCF`（62683 字节）；
3. `dropdb -f gengyun` → `createdb gengyun` → 重放 26 个迁移 + 8 个角色文件 + 被改坏的 20-login（日志 `14-m4-reapply.log`，全 exit 0）→ 90-assert = `107/106/1`，红的是断言 2（`14-m4-red.log`）；
4. 用备份覆盖回原文件，sha256 再次等于 `0249C2…F0A`（Equal=True）；重跑修好的 20-login → `proacl = {gengyun_cvm_owner=X/gengyun_cvm_owner}` → `107/107/0`（`14-m4-green.log`）。

两条实现层面的更正（如实记录）：

- **m1 用持久函数而不是临时对象**：派单写「temp/测试事务内」，但 (a) 90-assert 自己用 `BEGIN … ROLLBACK` 包住探针段，`CREATE TEMP` 在它自己的会话里根本活不到 checks 求值；(b) 清单只遍历 `public/catalog_ops/staging_intake` 三个 schema，`pg_temp` 不在其中，临时函数不会进断言 1。所以只能持久建、跑、删，库内复原。
- **m5 必须先授 schema USAGE**：`gengyun_api_runtime` 对 `staging_intake` 没有 USAGE，单授函数 EXECUTE 时探针仍停在 schema 层（42501），断言 4 不会红。加上 `GRANT USAGE ON SCHEMA` 后探针走到函数级、拿到 `00000`，断言 4 才判红。这说明断言 4 的「反向」在本集群上实际测的是「运行时拿不到这条函数」，而不是严格的「函数级 EXECUTE 被收回」。

## 6. 门禁（7 项，全部 exit 0）

| # | 命令 | exit | 读数 |
| --- | --- | --- | --- |
| 1 | `npm run lint` | 0 | `PASS tsc --noEmit services/api/tsconfig.json`；`PASS tsc --noEmit apps/admin/tsconfig.json`；`PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）`；`lint 通过` |
| 2 | `node tools/verify-release-materials.mjs` | 0 | `PASS 回滚 down 脚本覆盖 0002..N 且无 0001 — 迁移 26 个（0001..0026），down 25 个（0002..0026），无 0001`；`15/15 项通过` |
| 3 | `npm run test:docs` | 0 | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住`；`PASS docs/research 结构校验：…` |
| 4 | `node tools/verify-contract-status.mjs` | 0 | `PASS: 纯行号区间 229 条`；`PASS: 中文表格一致`；`PASS: 状态为人工判定`（另有 5/268 条无锚点可疑引用的 WARN，不判红） |
| 5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | `tests 6 / pass 6 / fail 0` |
| 6 | `git diff --check` | 0 | 无输出 |
| 7 | `node --test --test-concurrency=1 "tests/unit/release-materials-index.test.mjs" "tests/unit/release-materials-index-strict.test.mjs"` | 0 | `tests 11 / pass 11 / fail 0` |

日志：`.pg17/handoff/r28-s51-logs/gates/g1…g7-*.log`、`gates/summary.txt`；真库读数在 `05`、`06`、`08`、`09`、`10`、`11-*`、`14-m4-*`。

## 7. 未取得 / 待裁定

1. **真实 CVM 与 GitHub Actions runner 未跑**：本页全部读数来自本机一次性集群（55656），`provision-db.sh` 本体未执行；生产库上「新建函数默认 PUBLIC EXECUTE」的同一缺口未被实证（但它是 PostgreSQL 文档语义，不依赖环境）。
2. **非超管属主未验证**：本集群 `gengyun_cvm_owner` 是 `initdb` 创建的超级用户（`rolsuper = t`），所以「属主不是超级用户时，清单查询、`aclexplode`、`has_function_privilege` 仍成立」未取得实测；90-assert 头部本身还要求能读 `pg_authid`（只有超级用户可读），生产上这一前提也可能不成立。
3. **扩展函数未穷举**：`staging_intake` 下 36 条 `pgcrypto` 函数只被断言 2（PUBLIC 不可执行）覆盖；它们不在清单里，所以断言 3 不检查其 grantee 集合，也未验证 extension 升级后新增函数的行为。`staging_intake.python_json(jsonb)`（非扩展、非 secdef、只授 staging_executor）同理：PUBLIC 面有兜底，grantee 集合不在本片范围。
4. **触发器本体行为未验**：本片只证明 `consent_policy_immutable()` 的 ACL 被收回、直接调用 42501；没有跑一次真实的 `UPDATE/DELETE public.consent_policies` 来证明触发器仍然拦截。语义上触发器调用不检查调用者 EXECUTE（PG 文档），但本集群未实测这一条。
5. **反向探针的层级不可区分**：m5 暴露了「schema USAGE 拒权」与「函数级 EXECUTE 拒权」都返回 42501；断言 4 的 detail 只记 SQLSTATE，无法区分二者。若要严格证明函数级，需要在探针里先 `GRANT USAGE ON SCHEMA`（本片没有为了测试而改授权）。
6. **清单按 schema + 名称匹配，不比对参数签名**：同名重载会被当作「已登记」；三个 schema 当前没有重载，所以本集群不受影响，但这是清单的已知盲点。
7. **只锁三个 schema**：若未来出现第四个 schema 的 `SECURITY DEFINER` 函数，断言 1/2 都不会看见它；本片按派单范围只锁 `public/catalog_ops/staging_intake`。
8. **m1/m4/m5 的偏差**：见 §5 末两条与 §5 的 m4 过程——m1 用持久函数、m4 必须重建库、m5 必须先授 schema USAGE，均与派单字面写法不同，已在报告里逐条记录。
9. **`roles/*.sql` 的 `CREATE ROLE` 非幂等**：m4 重建库时第一次重放报 `role "gengyun_auth_privacy" already exists`（角色是 cluster 级对象），最终用「注释掉 `CREATE ROLE` 行」的**字节保留临时副本**重放（`roles-nocreate/`，仓库文件未改）。这是复现路径的限制，不是交付文件的问题；生产重放需要用可重复执行的 provisioning 路径。
10. **集群状态**：一次性集群在交付后以 `pg_ctl -D E:\GengYunCommander\.pg17\data-r28s51 -m fast -w stop` 停止，`pg_isready` 不再接受连接；数据目录保留、不删除。

## 8. 与 S43/S45 的分工、复现命令

分工（同一轮「最小权限断言」的三条互补的面，互不重叠）：

| 切片 | 覆盖对象 | 判据 | 本基线是否已在 |
| --- | --- | --- | --- |
| R28-S43 | 18 张「经组继承」的**表**（`pg_class.relacl` / `pg_attribute.attacl`） | `external_manifest` 快照 + 18 条逐表断言 + `runtime_surface_parity` / `runtime_surface_no_public_leak` | 在（`e1c0479` = PR #357，90-assert 103 条） |
| R28-S45 | `public.users` 的 INSERT 登录路径（表级/列级写面 + `runtime_users_login_insert_path` 探针） | 表级 INSERT 位 + 列级 INSERT 集合 | **不在**本基线（S45 页记 104 条，本基线 103 条；S45 是另一条分支的增量） |
| **R28-S51（本片）** | 三个 schema 的**函数**（`pg_proc` + `proacl`） | 11 行清单 + 四条 `runtime_function_*`（完备性 / PUBLIC / grantee 集合 / 真执行） | 本片新增，`103 → 107` |

三者的对象集合分别是 `pg_class/attacl`、`users` 一表、`pg_proc`，没有一条断言重叠。S43 的 `external_manifest` 与 S51 的 `function_surface_manifest` 是同构的两个兜底清单：一个管「运行时可见的表必须被分类」，一个管「可执行的函数必须被分类」。

复现（本机 PowerShell，PostgreSQL 17.11）：

```powershell
# 1) 集群：initdb（-U gengyun_cvm_owner，SCRAM，UTF8，locale=C），用 Win32_Process Create 起 postgres.exe
#    -D E:\GengYunCommander\.pg17\data-r28s51 -p 55656，日志 .pg17\handoff\r28-s51-logs\postgres.log
# 2) 26 个迁移按文件名顺序应用；8 个角色文件；20-login-roles.sql（GENGYUN_API_RUNTIME_PASSWORD 为 48 位小写十六进制）
# 3) 合规态 + 计数（期望 107|107|0）
& 'E:\GengYunCommander\.pg17\pgsql\bin\psql.exe' -X -h 127.0.0.1 -p 55656 -U gengyun_cvm_owner -d gengyun `
  -v ON_ERROR_STOP=1 -f 'E:\GengYunCommander\wt-r28-s51\deploy\postgres-cvm\sql\90-assert-least-privilege.sql'
& 'E:\GengYunCommander\.pg17\pgsql\bin\psql.exe' -X -h 127.0.0.1 -p 55656 -U gengyun_cvm_owner -d gengyun `
  -f 'E:\GengYunCommander\.pg17\tmp\r28-s51\count-asserts.sql'
# 4) 函数面原始读数（段 [8]；42501 行是设计的一部分）
& 'E:\GengYunCommander\.pg17\pgsql\bin\psql.exe' -X -h 127.0.0.1 -p 55656 -U gengyun_cvm_owner -d gengyun `
  -f 'E:\GengYunCommander\wt-r28-s51\deploy\postgres-cvm\evidence\probe-runtime-grants.sql'
# 5) 变异：.pg17\tmp\r28-s51\run-mutations.ps1（m1/m2/m3/m5）、run-m4b.ps1（m4，含重建库）
```

门禁命令见 §6；`count-asserts.sql`、`roles-nocreate/`、`run-mutations.ps1`、`run-m4b.ps1` 与全部门禁/变异输出都在 `E:\GengYunCommander\.pg17\handoff\r28-s51-logs\`（日志）与 `.pg17\tmp\r28-s51\`（一次性脚本，不提交）。
