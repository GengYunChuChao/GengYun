# GY-R72 断言域可见性：87 号元断言的域从「运行时可见表」扩到「public 下所有普通表」（2026-11-02）

> 一句话结论：`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的 87 号元断言原来拿 `has_table_privilege` / `has_any_column_privilege` **反查**要检查哪些表，于是「迁移建了表、运行时代码真写、却零 GRANT」这一类关系对它天然隐形；本片把域改成「`public` 下所有普通表」并给「显式未接线」开一张带出处的字面量清单（21 行），扩域**新暴露 21 张表**，其中 0 张是「真该补授权却无人登记」的缺口。

| 项 | 值 |
| --- | --- |
| 仓库 / 工作树 | `E:\GengYunCommander\GengYun_Agent2` → `E:\GengYunCommander\wt-r72-assertdomain` |
| 分支 / 基线 | `feat/gy-r72-assert-domain-visibility` / `1b85e693` |
| 切片档位 | SQL 断言 + 离线钉子 + 文档；只提交、不推送 |
| 行为改动 | 断言域扩展（CI 真库臂上会多判 21 张表）；**零**运行时行为改动 |
| 零改动面 | 零新 GRANT、零迁移、零新错误码、零新 scope；`services/api/src/**`、`packages/contracts/**`、`tools/doc-anchors-*.json`、`tests/unit/doc-anchor-relocations.json` 全部未碰 |
| 契约台账 | `docs/architecture/contract-status.json` 未动 |

## 1 缺陷机制

87 号（改前行号段 3605–3646，本片插入与替换后整体下移）的判据长这样：`FROM pg_class c WHERE n.nspname = 'public' AND c.relkind IN ('r','p','f') AND (has_table_privilege('gengyun_api_runtime', c.oid, …) OR has_any_column_privilege(…))`，再对每张命中表要求它出现在 `domain_manifest` 或 `external_manifest` 里。

问题就在 `AND (has_table_privilege(…) OR has_any_column_privilege(…))` 这一句：**「要检查哪些表」是从「谁被授过权」反查出来的**。于是一条完整的因果链断在最前面：

1. 迁移建了一张表（`services/api/db/migrations/*.sql`）；
2. 运行时代码真的读写它（`services/api/src/**` 里有 `INSERT INTO public.<t>`）；
3. 但 `deploy/postgres-cvm/sql/20-login-roles.sql` 里一条 GRANT 都没有（漏授权，而不是有意冻结）。

第 3 步让这张表**不进 87 号的域**，因此 87 号从不要求它被分类；`domain_manifest` 是手写字面量清单，同样只覆盖「有人想起来登记」的表。两端都是「谁记得」驱动 ⇒ 「建表但忘了授权」整类缺口 CI 恒绿。

实证（本片立项时复核）：`public.provider_invocations` 由 `services/api/db/migrations/0050_provider_invocations.sql:147` 建表，写入点在 `services/api/src/privacy/ledger-pg.ts:954`（另有 `services/api/src/privacy/task-egress.ts:442`），而 `20-login-roles.sql` 对它零 GRANT 零 REVOKE、扩域之前本文件对 `provider_` 前缀 0 命中。

## 2 改了什么

| 改动 | 位置（改后行号） | 内容 |
| --- | --- | --- |
| 新增顶层 CTE | `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2374` | `unwired_manifest(tbl, why, source) AS (VALUES …)`，21 行，每行「表名 + 理由 + `migrations/`/`docs/` 出处」 |
| 扩 87 号（就地） | `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:3765` 起 | 标签仍是 `runtime_surface_parity`：原来的 (i)(ii) 保留，追加 (iii) 全表归类、`(iv-a)` 清单行必须是普通表、`(iv-b)` 清单行对 runtime 零权限、`(v)` 三清单两两不相交 |
| 新增离线钉子 | `tests/unit/assert-domain-visibility.test.mjs` | 4 条纯文本断言，不连库（见 §6） |
| 新增证据页 | 本文件 | — |

为什么是「就地扩 87 号」而不是新增标签：`checks` 的静态断言条数是文件尾注释里登记的口径值（改前 128 条），新增一个 `UNION ALL` 分支会让那个数漂移，而就地扩只改判据不改条数。清单本身必须是**顶层 CTE**（该文件所有清单都是顶层 CTE，`domain_manifest` / `external_manifest` / `expected` / `allow_table_dml` 皆然），因此插在 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2402` 的 `checks(label, ok, detail) AS (` 之前。

三条新谓词的分工：

- **(iii)** `c.relkind = 'r'` 取「普通表」，并排除 `pg_inherits` 子表（随父表分类）与 `pg_depend.deptype = 'e'` 的扩展成员表（由扩展建删，不归迁移面）。这是本片的**扩域本体**：零授权的关系从此也进域。
- **(iv-a)+(iv-b)** 是反向控制：清单行只要库里存在，就必须是 `public` 普通表，且对 `gengyun_api_runtime` 零表级零列级权限。所以「把一张已接线的表塞进未接线清单把断言弄绿」会被当场判红，不靠人看注释。
- **(v)** 三张清单两两不相交。

`(iv-a)` 特意写成「**若存在**」而不是「必须存在」：本文件开头的软前置注释（改前行号段 56–61）把 `public.schema_migrations` 台账定为**软**前置（用 `psql -f` 应用迁移、但不跑 `migrate.ts` 的等价复跑环境里它确实不存在），权威判定点在 `deploy/postgres-cvm/provision-db.sh` 与 `deploy/postgres-cvm/verify-cvm-postgres.sh`。表名真假由离线钉子比对「`migrations/*.sql` 的 `CREATE TABLE` + `services/api/src/db/migrate.ts:205`」来兜，不塞进 SQL 的强断言。

## 3 扩展域前后的可见表数（静态口径）

| 口径 | 改前 | 改后 |
| --- | --- | --- |
| 87 号的域（会被要求分类的表） | **53** = `domain_manifest` 40 − 4 张 forbidden 行 + `external_manifest` 17 | **78** = 57 已分类 + 21 未接线清单 |
| 域外、永不判红的 public 普通表 | **21**（20 张迁移建表 + `schema_migrations`） | **0** |
| 迁移建表的 public 普通表总数 | 77（`migrations/*.sql` 里 82 处 `CREATE TABLE`，其中 5 处落 `knowledge_staging` / `catalog_ops` / `staging_intake`） | 77 |
| 加 `services/api/src/db/migrate.ts:205` 的台账 | 78 | 78 |

改前的 53 与 78 的差就是本片的意义：**旧域从来看不见那 21 张表**。`domain_manifest` 里 4 张 forbidden 行（`community_media_grants` / `deletion_requests` / `deletion_handlers` / `third_party_deletions`）对 runtime 零权限，旧域同样看不见 ⇒ 53 = 57 − 4。

## 4 清单 21 行逐行理由（与 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2374` 起逐行对应）

21 张表对 `gengyun_api_runtime` 的**静态权限状态**已逐条核对：运行时闭包 = `gengyun_api_runtime` + 5 个组（`gengyun_auth_privacy` / `gengyun_consent_granter` / `gengyun_knowledge_runtime` / `gengyun_preview_reader` / `gengyun_profile_runtime`）；`gengyun_egress_ledger` 与 `gengyun_source_executor` 都**不在**闭包内。全库没有 `GRANT … ON ALL TABLES IN SCHEMA public`。

| # | 表 | 建表 | 运行时不接线的理由 | 出处 |
| --- | --- | --- | --- | --- |
| 1 | `sources` | `services/api/db/migrations/0001_initial_schema.sql:131` | 读面是 0005 的 `catalog_read` 视图；写面只授 `gengyun_source_executor`（不在运行时链上） | `services/api/db/migrations/0005_catalog_read_views.sql:9` 的 `current_verified_sources` 视图、`services/api/db/roles/source_operator.sql:25` |
| 2 | `source_versions` | `services/api/db/migrations/0001_initial_schema.sql:143` | 同上，CLI 侧只授 `UPDATE(validity)` | `services/api/db/migrations/0005_catalog_read_views.sql:9`、`services/api/db/roles/source_operator.sql:27` |
| 3 | `formulations` | `services/api/db/migrations/0002_knowledge_catalog.sql:42` | 读面 = 0005 `registration_evidence` 视图（JOIN 本表） | `services/api/db/migrations/0005_catalog_read_views.sql:44` |
| 4 | `registrations` | `services/api/db/migrations/0002_knowledge_catalog.sql:53` | 同 3 | `services/api/db/migrations/0005_catalog_read_views.sql:43` |
| 5 | `applicability` | `services/api/db/migrations/0002_knowledge_catalog.sql:68` | 适用判定走 `packages/reference` 纯函数；`dose-cards` 里的 `applicability` 只是门 id 字符串 | `services/api/db/migrations/0002_knowledge_catalog.sql:34`、`services/api/src/knowledge/dose-cards.ts:53` |
| 6 | `restriction_rules` | `services/api/db/migrations/0002_knowledge_catalog.sql:100` | 规则由目录/种子侧落库；后台内容域另建 0036 专用表 | `services/api/db/migrations/0036_r34_admin_content_persistence.sql:28` |
| 7 | `knowledge_versions` | `services/api/db/migrations/0002_knowledge_catalog.sql:120` | 读面 = 0005 / 0010 的 `catalog_read` 视图 | `services/api/db/migrations/0005_catalog_read_views.sql:26`、`services/api/db/migrations/0010_knowledge_read_views.sql:12` |
| 8 | `knowledge_dataset_modes` | `services/api/db/migrations/0002_knowledge_catalog.sql:140` | 只经 0005 视图取模式门 | `services/api/db/migrations/0005_catalog_read_views.sql:11` |
| 9 | `knowledge_dataset_config` | `services/api/db/migrations/0002_knowledge_catalog.sql:156` | 只经 0005 视图取 `active_mode` / `database_connected` | `services/api/db/migrations/0005_catalog_read_views.sql:12` |
| 10 | `catalog_import_runs` | `services/api/db/migrations/0002_knowledge_catalog.sql:163` | 批次由种子/CLI 侧落库（`tools/knowledge/build_seeds.py`），API 侧无写入点 | `services/api/db/migrations/0012_knowledge_created_at.sql:52` |
| 11 | `catalog_import_conflicts` | `services/api/db/migrations/0002_knowledge_catalog.sql:179` | 读面 = 0005 视图；写入同 10 | `services/api/db/migrations/0005_catalog_read_views.sql:55` |
| 12 | `catalog_source_update_events` | `services/api/db/migrations/0002_knowledge_catalog.sql:193` | 写入只经 0006 的 SECURITY DEFINER 函数；表级位只授 `gengyun_source_executor` | `services/api/db/migrations/0006_source_lifecycle.sql:96`（`catalog_source_update_events` 的 INSERT）、`services/api/db/roles/source_operator.sql:28` |
| 13 | `public_authors` | `services/api/db/migrations/0001_initial_schema.sql:233` | 作者域推迟到阶段 2（GY-I04/GY-I05），授权面从未开 | `services/api/db/migrations/0030_community_author_ref.sql:15`、`services/api/src/community/authors.ts:7` |
| 14 | `posts` | `services/api/db/migrations/0001_initial_schema.sql:259` | 0001 的公开作者投影表；社区域实际落 0022 的 `community_*` | `services/api/db/migrations/0022_community_persistence.sql:12` |
| 15 | `post_versions` | `services/api/db/migrations/0001_initial_schema.sql:270` | 同 14 | `services/api/db/migrations/0022_community_persistence.sql:12` |
| 16 | `content_media_refs` | `services/api/db/migrations/0001_initial_schema.sql:294` | 媒体仓储当前无写入方；社区取图另走 `community_media_grants` | `services/api/src/media/content-source.ts:114`（`content_media_refs` 至今无写入方的注释） |
| 17 | `user_training_consents` | `services/api/db/migrations/0003_privacy_consent.sql:221` | 首版训练开关关闭（`training_enabled` 默认 false） | `services/api/db/migrations/0003_privacy_consent.sql:18` |
| 18 | `admin_audit_events` | `services/api/db/migrations/0017_account_suspend_authority.sql:72` | 写面只经 SECURITY DEFINER 函数；运行时连 SELECT 都没有（`20-login-roles.sql` 对该表只有 `REVOKE ALL … FROM PUBLIC`） | `services/api/db/migrations/0020_feature_flags.sql:11`、`services/api/src/admin/audit/pg.ts:5` |
| 19 | `export_writebacks` | `services/api/db/migrations/0011_export_ledger.sql:50` | 外发账本随 `egress_ledger` 组冻结：该组两种部署形态都不执行，运行时对账本恒未就绪（**冻结，不是缺陷**） | `docs/architecture/contract-implementation-status.md:67`、`services/api/db/roles/egress_ledger.sql:48` |
| 20 | `provider_invocations` | `services/api/db/migrations/0050_provider_invocations.sql:147` | 写入点已在（`ledger-pg.ts` / `task-egress.ts`），但 0050 自述「默认部署下对运行时零权限，写入会以 42501 失败」——授权是有意冻结 | `services/api/db/migrations/0050_provider_invocations.sql:106`、`docs/architecture/ai-ops-spec-status.md:135` |
| 21 | `schema_migrations` | `services/api/src/db/migrate.ts:205` | 迁移台账由 `migrate.ts` 维护（admin 侧）；运行时零权限，且本文件把它定为软前置（等价复跑环境可以不存在） | `docs/verification/gy-i02-migrations-negative-20261017.md:24` |

逐张判定结论：**21 张全部是「有意不接线且已有文字登记」**，0 张属于「真该补授权却无人登记」。（第 20 行是唯一「代码有写入点却没授权」的组合，而它的「零权限」正是 0050 迁移自己逐字登记的口径；第 19 行同型，冻结口径登记在 `docs/architecture/contract-implementation-status.md:67`，`ledger_readiness_state` 上方那段注释则把「默认部署从不执行 egress_ledger 组」写成前置事实。）

## 5 为什么本片不补 GRANT

`provider_invocations` 与 `export_writebacks` 是**有意冻结**，不是遗漏：0050 的迁移注释逐字写了「零权限、写入会以 42501 失败」，产品侧 `docs/architecture/ai-ops-spec-status.md:135` 把 N05 记为「仍缺 HTTP 读面、运行时授权（该组不在运行时 5 组内）」，账本侧则把「恒未就绪」定为冻结而非缺陷。补 GRANT 会同时改变三个面的语义：

1. 授权面（`20-login-roles.sql` 的 5 组 / 7 组形态都变），
2. `90-assert` 的 `expected` 逐表逐列口径（补了就要求配套的 allowlist 与探针），
3. 账本就绪态（`ledger_readiness_state` 从「未就绪」翻成「就绪」，93 号及其下游语义跟着动）。

那是另一片（接线）的活，而且「冻结」与「漏授权」在 SQL 层长得一模一样——本片只做**让它们长得不一样**这件事：漏授权的表现在会以「未归类」红，冻结的表必须点名登记、带出处、并对零权限做反向校验。清单是**声明**，不是修复。

## 6 离线钉子与三条负控制

`tests/unit/assert-domain-visibility.test.mjs`（纯文本，不连库）四条断言：

1. **域是「public 下所有普通表」**：按 `'runtime_surface_parity',` 定位 87 号、以 `\n\n  UNION ALL` 为结束锚点切出整段，再切到 detail 之前的 ok 表达式；要求出现 `unwired_manifest`、`c.relkind = 'r'`、`pg_inherits`、`d.deptype = 'e'`、`R72-ASSERT-DOMAIN` 标记、以及 `public 下(所有|每张)普通表` 的措辞，并要求 `has_table_privilege('gengyun_api_runtime'` 至少出现两次（一处旧域、一处清单反向校验）。
2. **清单每行有出处**：`unwired_manifest` 块必须 21 行、每行 `('tbl', 'why', 'source')`、理由 ≥12 字、出处含 `migrations/` 或 `docs/` 且带行号引用；表名唯一；集合与冻结的 21 张全等（含 `provider_invocations`）。
3. **与已授权表不相交**：解析 `deploy/postgres-cvm/sql/20-login-roles.sql`（剥 `--` 注释、按 `;` 切语句、跳过 `GRANT EXECUTE ON FUNCTION`），得到对 runtime 授过权的表集合（实测 37 张），与清单求交必须为空。
4. **口径闭合**：`domain_manifest` 40 + `external_manifest` 17 + `unwired_manifest` 21 = 78，两两不相交；`78` 必须等于「`migrations/*.sql` 的 `CREATE TABLE`（去掉 5 张非 public）」77 加 `migrate.ts` 的 `schema_migrations`，即无未分类、无幽灵表。

三条负控制（改 → 跑 → 还原 → 核 sha256）在交付报告里给读数。

## 7 行号漂移核对（0 处改数字）

`docs/**` 里引用 `90-assert-least-privilege.sql` 的行号共 26 处，插入点在旧行 2334、扩域块把 87 号从旧行 3600–3645 推到新行 3662 起，因此只有大于 2334 的 4 处可能受影响：

| 位置 | 引用的行号 | 结论 |
| --- | --- | --- |
| `docs/verification/gy-r28-function-surface-parity-20261021.md:231` | 行 2667 | 在「CI 现场原文」的 ```text 代码块里，是当日 psql 报错的**逐字日志**（旧行 2667 = 「25. owner_purge_function_execute」那条的 `AND NOT EXISTS (`）⇒ verbatim 记录，改数字等于伪造 |
| `docs/verification/gy-r34-jobs-retire-20261024.md:51` | 行 3605–3617 | 「返修提交 64323db6」的历史改动表单元格 ⇒ 历史记录 |
| `docs/verification/gy-r34-jobs-retire-20261024.md:60` | 行 3608–3613 | 同上 |
| `docs/verification/gy-r34-jobs-retire-20261024.md:158` | 行 3608–3617 | 改前指向的「静态值 115 条 / 3632」注释就已不在该区间（旧行 3608–3617 = 87 号的 (i) 块）⇒ **改前已陈旧**，非本片造成 |

`tools/doc-anchors-*.json` 与 `tests/unit/doc-anchor-relocations.json` 里没有任何 `90-assert-least-privilege.sql` 的行号登记 ⇒ 锚点基线不因漂移而红（且该 JSON 本片禁止改动，事实也无需改）。`docs/architecture/*.md` 没有「90-assert 覆盖所有表」这类说法（4 处提及分别是按列授权、函数面、forbidden 行与 s4 文档漏写），故本片只新增本页，不订正架构叙述。

## 8 诚实边界

- **SQL 侧只有 CI 真库臂能真跑**：本机没有 `psql` / `docker` / `pg_ctl`，`90-assert-least-privilege.sql` 又含 `\pset` / `\if` / `\gset` 元命令，不是纯 SQL 文件。本片能给出的是：①静态结构检查（括号平衡、无 BOM、无 CR、清单行数、标签唯一性）；②把 87 号新增的四条谓词原文抽出来，用 PG17（`@electric-sql/pglite` WASM）在桩清单上跑 7 个场景（全绿 / 新增未归类表 / 已授权表塞清单 / 清单与 domain 重叠 / 清单写不存在的名字 / 视图冒充表 / 列级授权塞清单），确认谓词方向正确；③CI 的 `deploy-sql-17-11` 与 `deploy-sql-17-11-cli-groups` 两个 job 会以 `psql -v ON_ERROR_STOP=1` 真跑本文件（步骤名 `90-assert-least-privilege.sql（末行 ok 且退出码 0）`）。端到端结论以 CI 为准。
- **清单是「声明」不是「修复」**：它不改变任何授权事实，只把「这张表有意不接线」从隐含约定变成可核对的字面量。表如果哪天接线了，`(iv-b)` 会立刻红，提醒把这行删掉——这是它该有的行为。
- **静态口径 vs 真库口径**：§3 的 78 / 57 / 21 都是静态计数（迁移文件 + 清单），真库若多出扩展成员表或分区子表，(iii) 已按 `relkind = 'r'` + `pg_inherits` + `deptype = 'e'` 排除；迁移里当前 grep 不到 `PARTITION BY` / `INHERITS`。
- **未被本片覆盖的同类缺口**：`(iii)` 只认 `public` schema 的普通表；`knowledge_staging` / `catalog_ops` / `staging_intake` 里的 5 张表仍不在 87 号域内。
