# R34-I18 · 管理端内容/资料域改接 PostgreSQL 落点（Refs #18）

- 分支：`feat/gy-r34-i18-content-pg`；本片起点 `HEAD = 997e8e5f`（= `upstream/main`）。
- 采样时间：2026-10-24（Asia/Hong_Kong）。
- 口径来源：派单口径（0036 三表 + 授权 + 真库臂）＋ 裁定 `.pg17/ruling-r34-user-decisions-20261024.md` 的 §U-13（列级授权，`allow_table_dml` 不扩、断言 49–58 一句不改）。
- 本文**不写死行号**：需要定位的一律写符号名（本仓 `doc-anchors` 只认「路径:行号」且行号会腐）。

## 0. 合并顺序前提（先读这一节）

- 本片迁移号 **0036**。**前提是 0035 已先落 `main`**：0035 属「媒体行侧物理删除」片（分支 `feat/gy-r34-media-purge`，本片提交时在返修中），0037 由 #14 使用。
- 提交时实测指针（`git fetch upstream --prune` 之后）：`upstream/main` 的最大迁移号是 **0034**（`git ls-tree --name-only upstream/main -- services/api/db/migrations/` 的最后一条是 `0034_r34_owner_content_purge.sql`）；`feat/gy-r34-media-purge` 上游分支上确有 `0035_r34_media_row_purge.sql`（`git ls-tree` 实测）。
- 因此本分支树上出现「`0001..0034` + `0036`」的缺号形态，`node tools/verify-migrations-unique.mjs --strict` 的 `[gap]` 判据会点名 `0035` 并**以退出码 1 结束**。这是**合并顺序前提的诚实读数**，不是本片漏片：
  - ⛔ 没有在 `services/api/db/migration-reservations.json` 里登记 0035（保留项一落盘当天就会过期，`#525` / `#419` 两轮已踩过）；
  - ⛔ 没有在 `services/api/db/migrations/README.md` 给 0035 写「跳过 / 预留」依据（那会把「在途号尚未落盘」冻结成已裁定事实）。
- 若合流时 `main` 仍无 0035，**本片必须回来重取号**（改成当时的最大号 +1），并同步迁移文件名、回滚文件名、`migrations/README.md` 与本证据页；⛔ 不许靠保留台账消红。

## 1. 结论

1. 内容/资料域（`sources` / `knowledge` / `registrations` / `restrictions` 四族 × 6 操作 = 24 条路由）**不再依赖进程内 `Map`**：`real` 且拿到连接池时，服务层注入的是 `services/api/src/admin/ops/content-pg.ts` 的 `createPostgresAdminContentStore`（自述 `persistent: true`），读写落在迁移 `0036_r34_admin_content_persistence.sql` 的三张表上。
2. **无池仍然 fail-closed**：`real` + `pool === null` 时内容 store 仍是内存实现（`persistent: false`），`app.ts` 继续把 `adminContentService` 换成 `failClosed.content` ⇒ 25 条后台路由逐条 503 `PROVIDER_UNAVAILABLE`（`retryable: false`）。这条**没有被删掉**，并被新测试与既有测试双向钉住（§6）。
3. 授权走**列级** `SELECT / INSERT / UPDATE`，三张表**零** `DELETE`/`TRUNCATE`/`REFERENCES`/`TRIGGER`；`allow_table_dml` 保持 16 个三元组不变、`90-assert` 的断言 49–58 与既有表列清单**一字未动**。
4. 真库臂 `tests/integration/admin-content-pg.mjs` **本机实跑通过**：`EXITCODE=0`、10 组 `ALL PASS`（§6.4）。CI 侧仍是 77（无 `GY_PG_BIN`），已按仓内惯例登记进 `UNWIRED_DECLARATIONS` 并写明原因。
5. 契约台账 24 条**仍是 `partial`**、`route_mounted` 仍为 `true`；blocker 文案改成真实剩余缺口（真库臂与后台 UI 联调未取得、审计写面未落库）。

## 2. 改动面

| 类别 | 文件 | 动作 |
|---|---|---|
| 迁移 | `services/api/db/migrations/0036_r34_admin_content_persistence.sql` | 新建（三表 + CHECK + 索引；`BEGIN/COMMIT`） |
| 回滚 | `services/api/db/migrations/rollback/0036_r34_admin_content_persistence.down.sql` | 新建（倒序 `DROP TABLE IF EXISTS`；索引随表） |
| 台账 | `services/api/db/migrations/README.md` | 「当前状态」段按实测改写（35 正向 / 34 down / 末项 0036）+ 0036 一行依据；**未**给 0035 写豁免 |
| PG 实现 | `services/api/src/admin/ops/content-pg.ts` | 新建：`createPostgresAdminContentStore`（`AdminContentStoreLike` 的异步实现） |
| 存储接口 | `services/api/src/admin/store.ts` | 新增 `AdminContentStoreLike`（`persistent` 放宽为 `boolean`）与 `commitLifecycle`；内存实现与 `persistent: false` 原样保留 |
| 服务层 | `services/api/src/admin/service.ts` | 依赖类型改 `AdminContentStoreLike`；`resolveOwned` / `listFamily` / `getDraft` / `rangeHint` 异步化；发布/撤回改为 `await store.commitLifecycle(entity)` |
| 引用完整性 | `services/api/src/admin/reference-integrity.ts` | 抽出纯判定核心，新增异步孪生 `createAsyncReferenceIntegrity`；同步实现逐字保留（`public-view.ts` 与既有单测仍用它） |
| 幂等外壳 | `services/api/src/admin/idempotent-write.ts` | 台账能力放宽为 `Pick<AdminContentStoreLike, …>`，6 处台账调用加 `await` |
| 装配 | `services/api/src/app.ts` | 内容 store 三行范式（显式注入 ＞ `real` + 有池建 PG ＞ 内存）；real 分支按 `adminContentWired` 放行；`release` 计数改为按**路由条数**累计 |
| 公开读判定 | `services/api/src/knowledge/public-invalidation.ts`、`services/api/src/routes/knowledge.ts` | 保留同步入口（既有 4 条钉不变），新增 `decidePublicVisibilityAsync`；路由改用它并 `await` |
| 授权 | `deploy/postgres-cvm/sql/20-login-roles.sql` | 末尾新增 `#region gy-r34-content-grant`（+53 行：DO 前置断言 + 3 条 REVOKE + 8 条列级 GRANT + 2 条 `\echo`） |
| 断言 | `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` | `domain_manifest` +3 行、`expected` +3 行、断言计数注释 117 → 120；其余（含 `allow_table_dml`、49–58、`external_manifest`）未动 |
| 契约台账 | `docs/architecture/contract-status.json`、`docs/architecture/contract-implementation-status.md` | 24 条 blocker 改写 + 每条 3 个证据锚点；中文表格 `--write-doc` 重新生成 |
| 测试 | `tests/unit/{sql-column-coverage,ci-integration-chain-structure}.test.mjs`、`tools/doc-anchors-baseline.json` | 读数成对更新 / 新脚本登记 / 删 2 条已修好的陈旧基线条目 |
| 新增测试 | `tests/unit/admin-content-grant-parity.test.mjs`、`tests/unit/admin-content-pg-wiring.test.mjs`、`tests/integration/admin-content-pg.mjs` | 见 §6 |

## 3. 表结构

三张表都由 `0036` 建（`CREATE TABLE IF NOT EXISTS`，`BEGIN/COMMIT` 包裹，索引同语句块）：

**`public.admin_content_entities`（实体 + 三态生命周期）**

- `id uuid` 主键（领域身份，服务层 `randomUUID` 生成，不设 DEFAULT）；`family varchar(16)` 闭集 CHECK（`sources` / `knowledge` / `registrations` / `restrictions`）；`steward_id text` 非空（1..200 字符）；`lifecycle varchar(16)` 闭集 CHECK（`draft` / `published` / `withdrawn`）。
- 发布字段组：`published_revision` / `published_at` / `published_by_id` / `published_evidence_ref` / `published_reason`；撤回字段组：`withdrawn_at` / `withdrawn_by_id` / `withdrawn_reason`；`created_at` 非空。
- 两条 CHECK 把「同一事实的多个投影」钉成要么全空要么全有：`admin_content_entities_published_group`（三列同进同退）与 `admin_content_entities_withdrawn_group`（撤回态必须有撤回戳与撤回人）。半组字段只可能来自写路径 bug，让它在写的那一刻红。
- 两条索引对应两条真实读路径：`(family, steward_id, id)` 给后台列表页（游标按 id 升序），`(family, id)` 给引用完整性跨实体解析与公开视图投影。

**`public.admin_content_revisions`（逐 revision 不可变）**

- 主键 `(entity_id, revision)`；`revision` CHECK ≥ 1；`content jsonb` 非空（四个 family 的正文形状不同，不拆列）；`author_id text` 非空；`derived_from_revision` 可空 + CHECK「严格早于本次修订」；`created_at` 非空。
- 外键 `entity_id → admin_content_entities(id) ON DELETE CASCADE`：注销清理（属主身份执行的独立切片）删实体时一并带走版本行；运行时角色没有 DELETE，级联只在属主路径出现。
- 主键即「按实体取全部版本」的覆盖索引，不另建二级索引。

**`public.admin_content_idempotency`（本域幂等台账）**

- 逐列照 `0018` 的 `favorites_idempotency`：`scope varchar(200)`、`key_hash varchar(128)`、`request_hash varchar(128)`（三列都带 `char_length` CHECK）、`response_status smallint` CHECK 100..599、`outcome jsonb`（`NULL` = 已认领未完成）、`expires_at timestamptz` 非空；主键 `(scope, key_hash)`；`expires_at` 单列索引供过期扫描。
- `key_hash` 存 `idempotencyKeyHashHex()` 的 sha256 十六进制串（128 字符上限给换算法留余量）。

**为什么新建而不是复用既有表**（迁移头注逐条写了，摘录）：`sources` / `source_versions` 没有三态生命周期与 `published_*` 字段组；`knowledge_versions.visibility` 是**公开可见性**闭集、不是审核状态机；`registrations` / `restriction_rules` 带业务专属列，装不下四族共用正文；本域幂等需要自己的 scope 空间与 TTL。

## 4. 授权与成对

### 4.1 列级授权（`#region gy-r34-content-grant`）

三张表、8 条 GRANT：

| 表 | SELECT | INSERT | UPDATE |
|---|---|---|---|
| `admin_content_entities` | 13 列（全部列） | 5 列（`id, family, steward_id, lifecycle, created_at`） | 9 列（`lifecycle` + `published_revision/at/by_id/evidence_ref/reason` + `withdrawn_at/by_id/reason`） |
| `admin_content_revisions` | 6 列（全部列） | 6 列（全部列） | **无**（纯追加，永远不改写既有版本） |
| `admin_content_idempotency` | 6 列（全部列） | 6 列（全部列） | 4 列（`request_hash, response_status, outcome, expires_at`） |

- 每条 `GRANT` 前都有 `REVOKE ALL ON TABLE … FROM PUBLIC`（三表一条语句覆盖），并有 `DO $$ … to_regclass … $$` 前置断言：缺表即 `RAISE EXCEPTION`，绝不留「看似收敛、点开 503」的运行态。
- **UPDATE 列的取舍**：`entities` 的 9 列就是 `commitLifecycle` 那一条 `SET` 清单——发布与撤回**共用同一条** UPDATE（撤回不抹掉「曾经发布过」的 `published_*`，重新发布也不必先清 `withdrawn_*`），所以这 9 列是并集而非「逐动作一列」；`revisions` 的 UPDATE 是**空**（表本身设计成不可变）；`idempotency` 只改结果列与到期时刻。
- **为什么不授 DELETE**：撤回是 `lifecycle` 状态位，业务上没有「删一行内容」的操作；幂等台账的 `release` 用「把占位行到期时刻推成 `-infinity`」、`purge` 用「把过期已定型结果清回占位」达成与「删行」**可观测等价**的效果，两者都是 UPDATE。PG 也没有列级 DELETE，一旦授出就是整表可删、不可逆 —— 本域宁可不给。
- **为什么无表级 DML**：列级授权下 `has_table_privilege(…,'INSERT'/'UPDATE')` 恒为假，`90-assert` 的断言 49–58 那两句硬否定因此**仍为真**；`allow_table_dml` 保持 16 个三元组（一条没加）。

### 4.2 `90-assert` 的成对增量（只有三类）

1. `domain_manifest` **34 → 37 行**：三表各一行 `('…', 'granted', true)`（`required = true` ⇒ 缺表即判红）。
2. `expected` **29 → 32 行**：三表各一行，`sel/ins/upd` 三个数组与本页 §4.1 的列清单**逐字同序**，`del = false`。`revisions` 的 `upd` 是 `ARRAY[]::text[]`。
3. 计数注释：断言总数 **117 → 120**、`sum(length(label)+2)` **3693 → 3814**（+121 = 三条新标签 39+42+40），并新增一行历史记录说明「列级授权下三表都没有表级 INSERT/UPDATE/DELETE」。

**没动的三处（逐条说明）**：

- `allow_table_dml` 16 个三元组**一条未加**：本域没有任何表级 DML。若将来有人给这三张表发表级 INSERT/UPDATE，断言 7 与 49–58 会同时红。
- 断言 49–58（`runtime_grants_<tbl>`）**一句未改**：它那两句 `NOT has_table_privilege(…, 'INSERT'/'UPDATE')` 是全局硬不变量（注释逐字「表级 INSERT/UPDATE 仍处处禁止（它们都有列级替代）」）。为让本片过而把它改成数据驱动豁免，等于把安全不变量降级——裁定明确不点头。
- `external_manifest` **未加**：它是「经 5 个 NOLOGIN 组继承来的授权面」快照，而这三张表是 `20-login-roles.sql` 的**直授**面；塞进去会让判定 (c)（非 `direct` 行不得有直授 runtime 的权限）立刻红。

### 4.3 自证：列集合、摘要、禁止面三向一致

新增 `tests/unit/admin-content-grant-parity.test.mjs`（5 条用例，全绿）：

1. `20-login-roles.sql` 的列级 GRANT 与 `90-assert` 的 `expected.sel/ins/upd` **双向逐列相等**（含顺序）；
2. 三表 `expected.del` 必须是 `false`，且两个文件里都不允许出现针对它们的 `GRANT DELETE/TRUNCATE/REFERENCES/TRIGGER`；
3. 三表必须各有一条 `REVOKE ALL ON TABLE … FROM PUBLIC`；
4. `domain_manifest` 三行 `('granted', true)`；`allow_table_dml` 与 `external_manifest` 里**一条都没有**；
5. `\echo` 摘要里的「13/5/9」「6/6/0」「6/6/4」读数必须等于**实际解析出来的列数**（摘要不许谎报）。

## 5. Wiring（装配）

- `services/api/src/app.ts` 的内容 store 与 `flagsPort` / `jobPort` / `auditLogPort` **同一门**：显式注入优先；否则 `adminRealUnwired && pool !== null` 才建 PG store，其余一律内存 store。判据只看**能力位**（`persistent === true`）与**库池是否存在**，不看任何自述标志。
- `real` 分支里 `adminContentService` 二分：`adminContentWired ? createAdminContentService({ store: adminContentStore, … }) : failClosed.content`。⛔ fail-closed 分支与它上面的整段注释都保留。
- 两处日志口径同步改成按**路由条数**累计（内容域 25 条按 `ADMIN_CONTENT_OPERATION_IDS.length` 计入 `released`），避免「内容域已放行、日志仍说 36 条全 503」的谎报。
- 公开读侧：`registerKnowledgeRoutes` 注入的解析器换成 `createAsyncReferenceIntegrity(adminContentStore).resolve`；`decidePublicVisibility` 仍是**同步**入口（既有 4 条钉一行未改），路由改用新加的 `decidePublicVisibilityAsync`（两个入口共用同一张 `VISIBLE_BY_STATE` 映射，不存在第二套口径）。
- `createReferenceIntegrity`（同步）**保留不动**：`services/api/src/admin/public-view.ts` 与 5 个内容域单测仍以同步形态使用它，`getEntity` 在内存 store 上是同步的。

## 6. 测试与变异自证

### 6.1 既有测试：**没有一条被放宽**

派单预判会翻的三条，实测**都不需要改**，因为它们的判据都恰好是「内存 store」/「无池」两臂：

| 文件 | 钉住的东西 | 实测 |
|---|---|---|
| `tests/unit/admin-contract-conformance.test.mjs` | `store.persistent === false`（内存 store 自述） | 6/6 通过，断言未改（内存实现仍 `persistent: false`） |
| `tests/unit/admin-real-mode-fail-closed.test.mjs` | `real` + 无池 ⇒ 36 条后台路由一律 503、零内存副作用 | 2/2 通过，断言未改（无池臂未变） |
| `tests/unit/admin-routes-nail.test.mjs` | 36 个 operationId 逐条注册、路径/方法不变 | 3/3 通过，断言未改（本片不改路由） |

内容域既有单测同样全绿且未改：`admin-content-lifecycle`（6）、`admin-content-concurrency`（11）、`admin-content-immutability`（7）、`admin-idempotency-expiry`（11）、`admin-content-rejections`（14）、`admin-read-time-recheck`（4）、`admin-reference-invalidity`（8）、`knowledge-public-invalidation`（4）、`tests/integration/admin-http.mjs`（1）。

真正改过的既有测试只有两类，都是**读数/登记**而非判据放宽：

- `tests/unit/sql-column-coverage.test.mjs`：把新宿主 `admin/ops/content-pg.ts` 纳入真审计（`ADDITIONAL_SQL_HOST_FILES`）并成对刷新读数——审计文件 19 → **20**、字面量 268 → **283**、INSERT 42 → **45**、UPDATE 47 → **51**、SELECT 143 → **151**、RETURNING 82 → **88**、ON CONFLICT 26 → **28**、`FOR UPDATE` 25 → **26**、行锁要求 41 → **42**、引用表 44 → **47**、列要求 1720 → **1845**、已覆盖 1666 → **1791**（**缺口仍 0**）；**`DELETE` 36 与表级覆盖 120 两条读数一字未变**——这正是「新域没有整表 DELETE、也没有任何表级 DML」的机器证据。
- `tests/unit/ci-integration-chain-structure.test.mjs`：把 `tests/integration/admin-content-pg.mjs` 登记进 `UNWIRED_DECLARATIONS` 并写明原因（自起集群、缺 `GY_PG_BIN` 时 exit 77、本片未接 `.github/workflows/**`）。
- `tools/doc-anchors-baseline.json`：删掉 **2 条**已不再命中的陈旧 SUSPECT 条目（其 `reference` 均指向 `docs/architecture/contract-status.json` 的旧行号）；基线 103 → **101**，**没有新增任何条目**。

### 6.2 新增测试

- `tests/unit/admin-content-grant-parity.test.mjs`（5 条，见 §4.3）。
- `tests/unit/admin-content-pg-wiring.test.mjs`（1 条）：桩池注入 `buildApp({ config: real, pool })` ⇒ `adminContentService.store.persistent === true`、四族 list 全 200 且 `items: []`、按 id 读 404 `NOT_FOUND`（不是 503）、SQL 真打 `public.admin_content_entities` 且 `family` 作为参数传下去；同一文件还钉住**成对反面**：同配置不传池 ⇒ 同路由 503 且 `persistent === false`。
- `tests/integration/admin-content-pg.mjs`：自起一次性 PG 17.11 集群（`GY_PG_BIN` / `GY_I18_PG_ROOT`；端口 55600–55699 先探活、硬挡 55436/55437；`pg_ctl -o` 传单字符串；子进程输出重定向到文件），跑全链迁移 + `gy-r34-content-grant` + real 装配真库池的 10 组断言。缺 `GY_PG_BIN` 时打印 3 行 SKIP 并 **exit 77**，且 `pg` 依赖在闸门**之后**才 `await import`（防「静态 import 被提升 ⇒ 把跳过报成失败」）。

### 6.3 变异自证（逐条实跑，改完即恢复并复跑确认绿）

| # | 变异 | 结果（哪些闸门红） | 结论 |
|---|---|---|---|
| M1 | 从 `20-login-roles.sql` 的实体表 SELECT 列表删掉一列（`published_reason`） | `admin-content-grant-parity` **3/5**（用例①「列级授权与 expected 逐列相等」+ 用例⑤「`\echo` 摘要读数」双红）；`least-privilege-expected-parity` 仍 5/5 | 列集合的**唯一**守卫是新加的三方一致性测试；旧的 parity 测试只比 DELETE 位，对这一列的变化**看不见**（这正是补它的理由） |
| M2 | 把 `app.ts` 内容 store 的池判据写反（`pool !== null` → `pool === null`） | `admin-content-pg-wiring` **1 红**（有池时 `persistent` 不是 true）；`admin-real-mode-fail-closed` **1 红**（无池臂反而去建 PG，36 条 503 的形态被破坏） | 「有池 ⇒ PG」「无池 ⇒ 503」两条**同时**有守卫，且既有的 fail-closed 钉会在判据写反时立刻红 |
| M3a | 在**迁移文件**末尾加一条 `GRANT DELETE ON TABLE public.admin_content_entities TO gengyun_api_runtime;` | 静态闸门**全绿**（`verify-migrations-unique` / `deploy-sql-gate-probe` / `deploy-sql-gate-forms` / `least-privilege-expected-parity` / `admin-content-grant-parity` 均未红）；真库臂 **EXITCODE=1**（迁移阶段即报错：迁移执行时 `gengyun_api_runtime` 还不存在，`42704`） | **盲区如实登记**：迁移文件里的 `GRANT` 不被任何**静态**闸门检查（静态面只读 `20-login-roles.sql` 与 `90-assert`）。真库臂能红，但红因是「迁移期内角色不存在」，**不是**「DELETE 被授出去了」。⇒ 若要防「迁移里偷发运行时授权」，需要一个读 migrations 目录的静态守卫（本片未做，登记为后续缺口） |
| M3b | 把同一条 `GRANT DELETE` 放进 `20-login-roles.sql` 的 `gy-r34-content-grant` 段内 | `admin-content-grant-parity` **4/5**（用例②「三张表零 DELETE/TRUNCATE/REFERENCES/TRIGGER」红）；`deploy-sql-gate-forms` 仍 10/10 | 授权侧的禁止面由新加的三方一致性测试守住；`deploy-sql-gate-forms` 的负控制**不**覆盖「内容域多授一条表级 DELETE」 |

### 6.4 真库臂读数（本机实测）

`node tests/integration/admin-content-pg.mjs`（`GY_PG_BIN` 指向本机 PG 17.11，`GY_I18_PG_ROOT` 与 `TEMP`/`TMP` 都指向仓库内目录）：

```
PASS 1: [0] 全链迁移 35 个（含 0036_r34_admin_content_persistence.sql）；三张内容表在岗
PASS 2: [1] 角色/授权：gengyun_api_runtime 已按列拿到内容域 SELECT/INSERT/UPDATE（区域 gy-r34-content-grant）
PASS 3: [2] 授权读数：列级 SELECT/INSERT/UPDATE 为真；表级 DELETE/TRUNCATE/REFERENCES/TRIGGER 全为假（三张表）
PASS 4: [3] 建草稿 201 + 幂等重放逐字一致（PG 台账 1 行，不是内存 Map）
PASS 5: [4] 列表 200 / 读 200 / 改 200（revision 1 → 2，ETag 与 If-Match 守卫生效）
PASS 6: [5] 发布 200（published）→ 撤回 200（withdrawn）—— 状态位真的写进了 PG
PASS 7: [6] 库内真值：实体 1 行（lifecycle=withdrawn，published_revision=2）、版本 2 行、台账 1 行
PASS 8: [7] 归属隔离：他人列表为空、他人按 id 读 404（steward_id 过滤在 SQL 谓词里）
PASS 9: [8] 负控制：运行时 DELETE/TRUNCATE/改未授权列一律 42501；改已授权列成功（说明授权是列级精确的）
PASS 10: [9] 回滚：rollback/0036_r34_admin_content_persistence.down.sql 把三张表删净（to_regclass 全为 NULL）
ALL PASS：10 组（内容域 PG 落点 · 真实 PostgreSQL 17）
EXITCODE=0
```

（脚本自带 `assert.equal(passed, 10, …)`：以后谁删掉一组证据或把它降级成 `note`，这里会立刻红。）

### 6.5 门禁逐条读数（提交前实跑）

| 命令 | 读数 |
|---|---|
| `node tools/verify-migrations-unique.mjs --strict` | **退出码 1**：唯一问题 `WARN[gap] 0035`（合并顺序前提，见 §0）；0036 已被识别为正向迁移且回滚配对 OK |
| `node --test tests/unit/deploy-sql-gate-probe.test.mjs` | 7/7 通过 |
| `node --test tests/unit/deploy-sql-gate-forms.test.mjs` | 10/10 通过 |
| `node --test tests/unit/least-privilege-expected-parity.test.mjs` | 5/5 通过 |
| `node --test tests/unit/sql-column-coverage.test.mjs` | 17/17 通过（读数见 §6.1） |
| `node --test tests/unit/deletion-registration-coverage.test.mjs` | 6/6 通过 |
| `node --test tests/unit/ci-integration-chain-structure.test.mjs` | 7/7 通过 |
| `node --test tests/unit/doc-anchors-guard.test.mjs` | 10/10 通过 |
| `node tools/verify-doc-anchors.mjs --strict` | 基线外新增 **0** / 陈旧 **0**；`COUNT: BROKEN 33 / OUT_OF_RANGE 6 / SUSPECT 68`；基线 101 条全部命中 |
| `node tools/verify-contract-status.mjs` | 退出码 0：覆盖 114 条操作、已装配 111 条、`implemented 17 / partial 93 / planned 4`、横切维度 8 条、形状错误 0、语义错误 0、中文表格一致、无锚点不可核 0 条 |
| `npm run test:docs` | 退出码 0（结构校验与研究记录各段 PASS） |
| `git diff --check` | 退出码 0（无行尾空白） |
| `node --check`（5 个改动/新增 `.mjs`） | 全部退出码 0；`.ts` 用 `npx tsc -p services/api/tsconfig.json --noEmit`，退出码 0 |
| 全量单测 `npm run test:unit` | 见 §6.6 |

### 6.6 回归面补充

除上述定向门禁外，另跑了全量 `npm run test:unit` 以确认「store 接口异步化 + 公开读判定拆同步/异步」没有波及既有域（读数见提交说明与回报）。内容域相关的 HTTP 集成 `tests/integration/admin-http.mjs` 通过。

## 7. 未取得 / 如实登记

1. **审计写面仍未落库**：内容域的 `store.audit.append` 仍落 `createAuditLog()` 的进程内台账（`listAuditEvents` 的记录重启即丢）。原因不是偷懒：`public.admin_audit_events` 对运行时角色**零权限**（0017/0020/0027，写入只能走独立的窄 `SECURITY DEFINER` 函数），而本片的口径明确「不新建窄函数」。⇒ 真库臂里审计断言只到「路由可达 + 状态位落库」，**没有**「审计行落库」的读数。
2. **幂等台账只增不删**：无 DELETE 权限下，`purgeExpiredIdempotent` 只把过期已定型行清成占位（对重放方不可见），物理保留需要 DELETE 或窄函数 ⇒ 属独立的保留期清理切片。本片**未**交付物理清理，表行数会单调增长。
3. **CI 未接线真库臂**：`.github/workflows/**` 不在本片授权范围；接线会连带改 `ci-real-pg-wiring.test.mjs` 的三张清单与证据页，属独立门禁变更 ⇒ 已在 `UNWIRED_DECLARATIONS` 如实登记（CI 里该脚本恒 77）。**本机已跑通**（§6.4），两者都写、不互相冒充。
4. **后台 UI 联调未取得**：`apps/admin/` 的页面没有在本片跑过端到端联调；24 条契约操作的 `blocker` 文案保留这一项。
5. **未做**「迁移里偷发 GRANT」的静态守卫（M3a 暴露的盲区）；也**未**给三张表加 `updated_at`（本域的时间语义由 `created_at` + 修订行的 `created_at` 承担，契约也没有 `updated_at` 字段）。
6. **跨分支前提未消解**：0035 是否先落 `main` 不由本片决定（§0）；本片能做的只是把前提写清、并在缺号时如实让 `--strict` 红。
