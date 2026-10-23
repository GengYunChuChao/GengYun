# GY-R27 S10 · OCR 任务与记录的 PostgreSQL 持久化（迁移 `0024`）证据页（2026-10-20）

- 片号／角色：**R27 · S10（写手）**，域 **#10 标签 OCR**。
- 分支：`feat/gy-r27-ocr-persist`；worktree：`E:\GengYunCommander\wt-r27-s10`。
- 基线：**`upstream/main` = `13dd429a02db57953ad604e17951901ebbc9d2ab`**（`test(CI): 把 messages-pg 与 favorites-history-pg 接进真库 CI…(Refs #17, Refs #16) (#319)`）。
- 迁移号：**`0024`**（由指挥在 `.pg17/ruling-migration-order-20261019.md` 分配并登记；本片**未改号、未造占位迁移**）。
- 一句话结论：OCR 域此前**只有内存 store（进程重启即丢）**；本片补上 PostgreSQL 实现（`createPostgresOcrStore`，12 个方法逐条对齐）、
  迁移 `0024_ocr_persistence.sql` 与其 rollback，并在 `real` + 有连接池时接线。**真库实测：写入 → 关闭全部连接（后端进程归零）→
  新 Pool／新 store／新 app → 以及另一个新进程 → 任务与记录按指纹逐字节仍在**；`real + 无池` 仍如实用内存 store 并回报 `persistent=false`。
- 边界（先声明，后文逐项展开）：本片的证据在 **store 层 + 迁移层 + `app.ocrService` 读面**。HTTP 面的"重启不丢"**未取得**——
  `real` 模式真实 OCR 提供者/媒体端口未接线，`POST /ocr` 在受理前即 503，无法经 HTTP 建任务（见 §9）。

---

## 0. 交付物

| 类别 | 文件 | 说明 |
| --- | --- | --- |
| 迁移 | [`services/api/db/migrations/0024_ocr_persistence.sql`](../../services/api/db/migrations/0024_ocr_persistence.sql) | 三张表（`ocr_jobs` / `ocr_records` / `ocr_idempotency`）、三索引、`state` 7 值 CHECK、两条 `ON DELETE CASCADE` 外键 |
| 迁移回滚 | [`services/api/db/migrations/rollback/0024_ocr_persistence.down.sql`](../../services/api/db/migrations/rollback/0024_ocr_persistence.down.sql) | `DROP TABLE` 干净回滚（`0021` 那种形态） |
| 存储实现 | [`services/api/src/ocr/store-pg.ts`](../../services/api/src/ocr/store-pg.ts) | `createPostgresOcrStore({ pool })`，12 个方法逐条对齐内存实现 |
| 接线 | [`services/api/src/app.ts`](../../services/api/src/app.ts)（`ocrPersistencePool` ＋ 装配行）、[`services/api/src/routes/ocr.ts`](../../services/api/src/routes/ocr.ts)（域内按池选实现；**接线逐行等长**，见 §5.1） | `real` 且 `pool !== null` ⇒ PG；其余 ⇒ 内存（如实 `persistent=false`） |
| 真库脚本 | [`tests/integration/ocr-jobs-pg.mjs`](../../tests/integration/ocr-jobs-pg.mjs) | 迁移三连 + 12 方法 + 关连接重开 + 子进程重启 + 4 条负控制；缺 `OCR_PG_TEST_URL` ⇒ SKIP 且 **exit 77** |
| 单元测试（语义/语句形状） | [`tests/unit/ocr-store-pg.test.mjs`](../../tests/unit/ocr-store-pg.test.mjs) | 记录型假池：CAS 单条 UPDATE、`claimIdempotent` 单条语句、`commitTerminal` 事务序、purge 行数… |
| 单元测试（接线选择） | [`tests/unit/ocr-store-pg-wiring.test.mjs`](../../tests/unit/ocr-store-pg-wiring.test.mjs) | `real+池 ⇒ PG` / `real+无池 ⇒ 内存` / `stub·preset_demo ⇒ 内存` + 源码结构钉子 |
| 门禁登记 | [`tests/unit/ci-integration-chain-structure.test.mjs`](../../tests/unit/ci-integration-chain-structure.test.mjs) | `UNWIRED_DECLARATIONS` 加一条：新脚本**尚未进 CI**（原因如实） |
| 侧影响同步 | [`docs/verification/gy-i24-release-materials-index-20261017.md`](../../docs/verification/gy-i24-release-materials-index-20261017.md) | 迁移数 23／22／30 → **24／23／30**（`release-materials-index.test.mjs` 的派生判据要求同步） |
| 守护基线同步 | [`tests/integration/ocr-http.mjs`](../../tests/integration/ocr-http.mjs) | 运行期装载登记冻结基线 9 → **11** 条（新增的 2 条正是本片域内装配所必需，见 §5） |

---

## 1. 核心主张：改前「重启即丢」→ 改后「重启仍在」（原始输出对照）

### 1.1 改前（基线树 `13dd429`，**未改动**代码上实测）

基线树上 `services/api/src/ocr/` 只有 6 个文件（**没有** `store-pg.ts`），装配行只取内存实现：

```text
--- 基线 HEAD:
13dd429a02db57953ad604e17951901ebbc9d2ab
--- 基线 ocr 目录:
media.ts
provider.ts
reference.ts
service.ts
state.ts
store.ts
--- 基线 routes/ocr.ts 的 store 行:
196: const store = deps.store ?? createMemoryOcrStore();
```

同一序列（写任务 + 写记录 → **再建一个 store 实例**读回）在基线代码上的原始输出：

```text
BEFORE-store-persistent=false
BEFORE-同实例-getJob=命中
BEFORE-新实例(重启后)-getJob=null
BEFORE-新实例(重启后)-getOcr=null
```

复跑用的探针（临时文件，未入提交；`BASELINE` 指向基线 worktree）：

```js
const { createMemoryOcrStore } = await import('file:///E:/GengYunCommander/wt-r27-smoke/services/api/src/ocr/store.ts');
const store = createMemoryOcrStore();
await store.insertJob({ /* revision:1, kind:'ocr', state:'queued', … */ });
await store.insertOcr({ /* revision:1, rawFields/correctedFields/verification, … */ });
console.log(`BEFORE-store-persistent=${store.persistent}`);
const restarted = createMemoryOcrStore();
console.log(`BEFORE-新实例(重启后)-getJob=${JSON.stringify(await restarted.getJob(jobId))}`);
```

### 1.2 改后（真 PG 17.11 + 迁移 `0024`，`tests/integration/ocr-jobs-pg.mjs` 实跑）

> 运行环境：本机独立数据目录 `E:\GengYunCommander\.pg17\data-r27s10`、端口 `55460`（`postgres (PostgreSQL) 17.11`）、
> 库 `gengyun_ocr_jobs_test`（每轮 `dropdb` + `createdb` 取得空库）。`exit 0`，共 **27 条 PASS**。

关闭连接 + 重开 + 换 store / 换 app 的那一段原始输出（**提交后重跑的最终读数**；id 与指纹每次运行都不同，属正常）：

```text
PASS 20: [R1] 写入完成；关闭前 1 个后端进程，pool.end() 之后残留 0（连接真的全关了）
PASS 21: [R2] 重启（关连接→新 Pool→新 store）：任务指纹 849e82012808d203… 与记录指纹 f2770b93644cf66f… 与写入时逐字节相等
PASS 22: [R3] 新 app（real+新池）的 OCR 读面读到重启前的任务；他人读同一条记录仍 NOT_FOUND（归属不放宽）
  CHILD-PID=100004
  CHILD-JOB-FP=849e82012808d203cf2163ca39d5f9c5c85c7c683c7f596da2d4f0f5b41b18fa
  CHILD-RECORD-FP=f2770b93644cf66f4ae39b5bc88263d87397289c1bf100999e00dcbfa4a935f5
  CHILD-RESULT=PERSISTED（新进程、新连接池，按指纹逐字节相等）
PASS 23: [R4] 进程级重启臂：**新进程** + 新连接池按指纹逐字节相等 ⇒ exit 0（subprocess 原始输出见上）

共 27 条 PASS，耗时 1914ms
```

> 指纹 = 该行的规范化 JSON 的 sha256（`recordFingerprint` / `jobFingerprint`）。它覆盖 id、revision、归属、媒体引用、
> `raw_fields`/`corrected_fields`/`verification` 三列全文、`model_version`、三个时间戳与 `deleted` ⇒ 任一字段变化都会让指纹变
> （下一条负控制 `byte_exact_restore` 就是在验证这一点）。

两条臂的口径（不得混读）：

| 臂 | "重启"到底指什么 | 读数 |
| --- | --- | --- |
| `[R1]/[R2]` | 本进程把**所有**连接池 `pool.end()`（`pg_stat_activity` 里本库其它后端进程 **1 → 0**）后再 `new Pool()` ⇒ 新 TCP 连接 + 新后端 PID + 新 store 实例 | 任务/记录指纹逐字节相等（`849e8201…` / `f2770b93…`） |
| `[R3]` | 新 `buildApp`（`real` + 新池）的 `app.ocrService.getJob/getOcr` 读同一行 | 读得到；**他人**读同一条仍 `NOT_FOUND`（归属判定未因换 store 而放宽） |
| `[R4]` | **另一个 Node 进程**（`spawn` 本脚本 `--verify-after-restart`）开自己的池读同一行 | 子进程 `exit 0`，两条指纹与写入时逐字节相等 |
| 未测 | **PostgreSQL 服务器本身重启** | 本片未停/起集群验证（§9 未取得项） |

---

## 2. 迁移 `0024_ocr_persistence.sql`（结构读数，真库实测）

```text
PASS 2: [M1] 0001..0023 已应用：ocr_* 三表全部不存在，users 在岗
PASS 3: [M2] UP：三表 + 三索引 + state CHECK 在岗 + 2 条 CASCADE 外键全部出现
PASS 4: [M3] ROLLBACK：本片对象全部消失，users 与 0001 的 jobs 表逐字仍在
PASS 5: [M4] REPLAY：同一份 UP 再执行一次仍成功，ocr_jobs 再次出现
PASS 7: [M5] state 闭集行为验证：闭集外 state 'bogus_state' 被库侧 23514 拒绝，且不落行
```

| 对象 | 判据 | 读数 |
| --- | --- | --- |
| `ocr_jobs` | 任务行：`id uuid PK`、`revision integer NOT NULL CHECK (revision >= 1)`、`kind text CHECK (kind='ocr')`、`owner_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE`、`ocr_id uuid NOT NULL`、`media_id uuid`、`media_revision integer`、`state text NOT NULL CHECK (state IN (7 值))`、`deadline_at/created_at/updated_at timestamptz NOT NULL`、`error_code varchar(80)` | `to_regclass('public.ocr_jobs') = ocr_jobs` |
| `ocr_records` | 记录行：`raw_fields / corrected_fields / verification` **三列独立 jsonb**（各带 `jsonb_typeof = 'object'` CHECK）、`model_version text`、`deleted boolean NOT NULL` | 三列 JSON 逐字段往返相等（PASS 13） |
| `ocr_idempotency` | 幂等台账：`PRIMARY KEY (scope, key_hash)`、`payload jsonb NOT NULL`、`pending boolean NOT NULL`、`expires_at timestamptz` | 单条 `INSERT … ON CONFLICT … WHERE expires_at <= $at RETURNING` 决定 `claimed/exists`（PASS 15/17） |
| 索引 | `ocr_jobs_owner_created_idx`、`ocr_records_owner_created_idx`（均 `(owner_user_id, created_at DESC, id DESC)`）、`ocr_idempotency_expires_idx (expires_at)` | 三个索引 `to_regclass` 全部命中 |
| 外键 | 任务与记录各一条 `ON DELETE CASCADE`（注销级联） | `pg_constraint` 计数 = 2 |
| `state` 闭集 | 不是字符串比对，而是**行为**：插入 `state='bogus_state'` | 库侧 `23514` 拒绝，且不落行 |

**为什么另建三张表而不复用 0001 的 `jobs`**（迁移头注释同源）：`jobs` 要求 `target_type/target_id/entity_revision/input_hash/auth_epoch`，
`OcrJobRow` **没有**这些字段；`jobs.owner_id` 可空且无 `ON DELETE CASCADE`，`jobs.state` 是 `job_state` **枚举**而本域行是 `text` 形状的同一 7 值闭集。
硬写就得**发明接口里不存在的值**，故本域自建三表；0001 的 `jobs` 原样不动（M3 已实测仍在）。

**索引的诚实边界**：`OcrStore` 的 12 个方法里**没有**"按 owner 列列表"的查询（读面一律走主键）⇒ 两个 `owner_created` 索引**当前不被任何语句命中**；
它们按派单要求建立，服务归属域排查与将来的列表面，**不声称已被查询使用**。

---

## 3. `OcrStore` 12 个方法的逐条判据

判据来源：真库脚本（`ocr-jobs-pg.mjs` 的 PASS 编号）＋ 单元层假池契约测（`ocr-store-pg.test.mjs` 的用例名）。
两层的分工：真库证**只有数据库能证**的性质（约束/事务/重开仍在）；假池证**只有读源码才能判**的语句形状。

| # | 方法 | 语义判据（与内存实现逐条对齐） | PG 实现（语句形状） | 真库读数 | 单元层读数 |
| --- | --- | --- | --- | --- | --- |
| 1 | `insertJob` | 同 `id` 再写 ⇒ 抛错（**文案与内存实现逐字相同**：`任务 id 冲突`） | 单条 `INSERT … RETURNING id`；`23505` ⇒ `OcrStoreConflictError('任务 id 冲突')` | PASS 9：落库 1 行；重复写由主键裁决抛错 | `[1]` 单条 INSERT / `23505` 同文案 |
| 2 | `getJob` | 不存在 ⇒ `null`；字段逐项往返（含毫秒级时间） | 单条 `SELECT … WHERE id = $1::uuid` | PASS 10：命中逐字段相等；不存在 ⇒ `null` | `[2]` 行映射 + `null` |
| 3 | `updateJob`（CAS） | `revision` 不匹配 ⇒ `null`，**不覆盖他人并发写** | **单条** `UPDATE … WHERE id=$1 AND revision=$2 RETURNING …`（读只用于算 `mutate` 的结果，**判定权在 WHERE**） | PASS 11：失败 ⇒ `null` 且库内 `revision` 不变；命中 ⇒ `running`/`revision=2` | `[3]`：(a) 不匹配时**不发** UPDATE；(c) UPDATE 0 行 ⇒ `null` |
| 4 | `commitTerminal` | 同一临界区校验 CAS + 合法迁移；CAS 失败 ⇒ `null` 且**不写任何记录**；记录 id 冲突 ⇒ 抛错且任务行不改；终态/取消后迟到结果写不进去 | `BEGIN` → `SELECT … FOR UPDATE` → `INSERT ocr_records`（可空）→ `UPDATE ocr_jobs SET … revision = revision + 1` → `COMMIT`；状态机仍只由 `state.ts` 的 `canTransitionJob` 判定 | PASS 12：四种失败面（CAS 失败/非法迁移/终态后迟到/取消后迟到）+ 记录冲突回滚全部实测 | `[4]`：事务语句序列、CAS 失败无 INSERT/UPDATE、记录冲突 `ROLLBACK` 且不 `COMMIT` |
| 5 | `insertOcr` | 同 `id` 再写 ⇒ 抛错（`OCR 记录 id 冲突`） | 单条 `INSERT … RETURNING id` | PASS 13：落库 1 行；重复写抛错 | `[5]` 同文案冲突 |
| 6 | `getOcr` | 不存在 ⇒ `null`；`raw_fields`/`corrected_fields`/`verification` 逐项往返 | 单条 `SELECT … WHERE id = $1::uuid`；读出时逐字段重建（坏行 ⇒ `PROVIDER_UNAVAILABLE`，不静默降级） | PASS 13：三列 JSON 逐字段相等 | `[5][6]` 含坏行守卫 |
| 7 | `updateOcr`（CAS） | `revision` 不匹配 ⇒ `null`；**校正不得改写 `raw_fields`** | 单条 `UPDATE … SET revision/raw_fields/corrected_fields/verification/model_version/updated_at/deleted WHERE id=$1 AND revision=$2` | PASS 14：校正落库、`raw_fields` 逐字不变 | `[7]` 白名单列 + CAS 谓词 |
| 8 | `findIdempotent` | 未占位 ⇒ `null`；返回 `requestHash/expiresAt/payload/pending`；**不按过期过滤**（与内存逐条一致） | 单条 `SELECT request_hash, payload, pending, expires_at WHERE scope=$1 AND key_hash=$2` | PASS 15：占位期 `pending=true`、`payload={job_id}` | `[8]` 断言 SQL **不含** `expires_at >` |
| 9 | `claimIdempotent` | 同键未到期 ⇒ `'exists'`；不存在/已到期 ⇒ `'claimed'`；**只有一个调用方能拿到 `claimed`** | **单条** `INSERT … ON CONFLICT (scope,key_hash) DO UPDATE … WHERE public.ocr_idempotency.expires_at <= $7 RETURNING scope` | PASS 15/17：首次 `claimed`、同键 `exists`、到期后重新 `claimed` 且 payload 换新 | `[9]` 断言**一条**语句 + 冲突目标 + WHERE 子句 |
| 10 | `finalizeIdempotent` | 行存在 ⇒ `payload` 换成最终引用、`pending=false`；行不存在 ⇒ 空操作 | 单条 `UPDATE … SET payload=$3::jsonb, pending=false WHERE scope=$1 AND key_hash=$2` | PASS 16：`pending=false`、`request_hash`/`expires_at` 不动（不续期） | `[10]` 0 行也是空操作 |
| 11 | `releaseIdempotent` | 占位者放弃 ⇒ **无条件删除**（内存实现就是 `Map.delete`），同键可重新占位 | 单条 `DELETE … WHERE scope=$1 AND key_hash=$2` | PASS 18：释放后查不到、同键可重新 `claimed` | `[11]` 无完成态条件 |
| 12 | `purgeIdempotent` | 物理删除**已到期**条目，返回**删除行数** | 单条 `DELETE … WHERE expires_at <= $1 RETURNING scope` ⇒ `rows.length` | PASS 19：删 1 行、未到期行保留、再跑一次 0 | `[12]` 返回行数 |

补充（同样真库实测）：错误折叠 `57014/55P03 ⇒ PROVIDER_TIMEOUT`、其它 ⇒ `PROVIDER_UNAVAILABLE`（单元层）；`store.persistent` 为 `true`（内存实现为 `false`）。

---

## 4. 接线判据（`real` + 池 ⇒ PG；其余 ⇒ 内存，且如实标注不持久）

实现：`app.ts` 在装配点算出 `ocrPersistencePool = config.executionMode === 'real' ? pool : null`，作为**位置实参**交给
`registerOcrRoutes(app, config, deps, persistencePool)`；`routes/ocr.ts` 内部按 `deps.store ?? (persistencePool === null ? 内存 : PG)` 选实现。
存储实现在**域内**选定，装配点不接触任何 OCR 适配器模块（`app.ts` 的 import 面**逐字未变**）。

| 场景 | 判据 | 读数（真库脚本 PASS 8 / 单元 `ocr-store-pg-wiring.test.mjs`） |
| --- | --- | --- |
| `real` + 池 | `describe().storePersistent === true` | 真库：`true`；单元（假池）：`true` |
| `real` + 无池 | **不得**回退内存冒充持久 ⇒ `false` | 真库：`false`；单元：`false` |
| `stub` + 池 | 不换实现 ⇒ `false` | 单元：`false`（并断言**未发出任何查询**） |
| `preset_demo` + 池 | 同上 ⇒ `false` | 单元：`false` |
| 构造期 | PG store 构造**不发查询**（接线不是"启动先查库"） | 单元：`pool.queries.length === 0` |

结构钉子（单元层源码级，全部实跑绿）：装配行仍**恰四个键** `consent/egress/guards/history`；`app.ts` 仍不含
`ocr/provider`、`ocr/store`、`ocr/media`、`ocr/reference` 任一子串；`real ? pool : null` 判定表达式在岗；第 4 个实参是 `ocrPersistencePool`。

---

## 5. 既有断言 前 → 后（逐条，附"不弱于旧断言"的证明）

### 5.0 先看一条**没有**被动过的既有判据：行号钉（`docs/architecture/contract-status.json`）

`docs/architecture/contract-status.json` 把 `services/api/src/routes/ocr.ts` 的 5 个路由注册块**行号范围**当证据钉住
（`224-257` / `259-272` / `274-290` / `292-308` / `310-328`），而该 JSON 在本片是**禁改项**（派单红线 1）。
第一版接线在注册块之前插入了说明与 import ⇒ 语义校验判红（原始输出）：

```text
AssertionError [ERR_ASSERTION]: ERROR: 语义错误 · getOCR: services/api/src/routes/ocr.ts:259-272 区间落在 post /ocr 的注册块内，未覆盖任何本操作注册块，与 get /ocr/{id} 不符
FAIL: 契约实现状态对照校验未通过（1 项）[形状错误 0 / 语义错误 1 / 表格漂移 0]
```

修法**不是**改那个 JSON，而是让接线**逐行等长**（`git diff` 只有 2 行）：

| 改动点 | 前（1 行） | 后（仍 1 行） |
| --- | --- | --- |
| 函数签名 | `export function registerOcrRoutes(app, config, deps): OcrService {` | 同一行追加 `persistencePool: TransactionalPool \| null = null` |
| 存储选择 | `const store = deps.store ?? createMemoryOcrStore();` | `const store = deps.store ?? (persistencePool === null ? createMemoryOcrStore() : createPostgresOcrStore({ pool: persistencePool }));` |
| import 与说明 | （无） | 放**文件末尾**（ESM import 声明提升，与放顶部语义等价），实测 `app.post`/`app.get`/`app.patch`/`app.post`/`app.delete` 仍在 **224/259/274/292/310** 行 |

修后实跑（契约实现状态校验器，直接跑工具本体）：

```text
PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
PASS: 语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段（不可核不计入通过）
PASS: 中文表格一致
EXIT_CS=0
```

> 这是本片"不让门禁变绿、只让实现变对"的一处具体代价：域内注释与 import 被挤到文件末尾，
> 换来 `contract-status.json` **一字未改**且行号证据仍然成立。

### 5.1 唯一被改动的既有结构断言（`ocr-http.mjs` 的运行期装载登记基线）

本片只改动了**一处**既有结构断言（`tests/integration/ocr-http.mjs` 的运行期装载登记基线）。改它的原因不是"让它变绿"，
而是该护栏自己的设计口径：*"基线是当前事实的冻结记录；合法装配若变化，本判据会判红并**要求显式更新此表**"*。
接线必然新增 2 条 OCR 域装载边（`routes/ocr.ts → '../ocr/store-pg.ts'`、`store-pg.ts → './state.ts'`），实测判红原文：

```text
AssertionError [ERR_ASSERTION]: OCRREGISTRY: 受护文件引用图装载完成后（早于自测与回环 HTTP 回归） —— 运行期装载登记抓到 2 条判红项
（其中「基线之外的 OCR 域装载边」2 条 ＋「域无关的 fail-closed 解析命中」0 条；r7 ＋ r8 两条判据）：
  · 经 app.ts → ./routes/ocr.ts（装载者 services/api/src/routes/ocr.ts）装载了 '../ocr/store-pg.ts' → …/services/api/src/ocr/store-pg.ts（注意：该边**不在** r7 冻结基线的 9 条合法边内）
  · 经 app.ts → ./routes/ocr.ts → ../ocr/store-pg.ts（装载者 services/api/src/ocr/store-pg.ts）装载了 './state.ts' → …/services/api/src/ocr/state.ts（注意：该边**不在** r7 冻结基线的 9 条合法边内）
```

| 断言 | 前 | 后 | 为什么不弱 |
| --- | --- | --- | --- |
| `OCR_REGISTRY_BASELINE_EDGES`（冻结基线表） | 9 条 | **11 条**（＋`routes/ocr.ts → '../ocr/store-pg.ts'`、＋`store-pg.ts → './state.ts'`，逐条带注释说明来由） | 判据口径未变：**基线之外任何 OCR 域边一律判红**（fail-closed）。新增的 2 条是域内装配的**最小必要边**；`app.ts` 自身没有新增任何 OCR 域 import（仍只有 `./ocr/service.ts` 的一个值符号），因此"装配路径不得接触适配器"这一更强性质**照旧成立**（同一次实跑里 AST 判据亦绿，见下） |
| `assert.equal(OCR_REGISTRY_BASELINE_EDGES.length, 9, …)` | 字面量 `9` | 字面量 **`11`**（判词同步改） | 该断言的作用是"防止有人把基线表缩成空集/删条来制造假绿"。**条数仍被字面量钉死**（空表/少条 ⇒ 红），且另一条 `baselineEdges === 基线条数` 与 `基线集合 − 命中集合 = ∅` 两条断言**未改**（少一条基线边照样点名判红） |
| `ocrInjectedKeys`（装配行恰四键） | `['consent','egress','guards','history']` | **未改**（仍四键） | 本片用**位置实参**传池，没有往 `deps` 加键 ⇒ 该断言逐字未动、实跑仍绿 |
| `appText.includes('ocr/store'\|'ocr/provider'\|'ocr/media'\|'ocr/reference') === false` | 禁 4 项 | **未改** | 存储实现放在域内 `routes/ocr.ts`，`app.ts` 仍不出现这些子串（实跑绿） |
| `evaluateOcrImports`（`app.ts` 对 `ocr/service.ts` 只允许 1 个值符号） | 1 个 | **未改** | `app.ts` 的 import 面逐字未变（实跑绿，输出见下） |

同一次实跑（`test:integration:http` 链内的 `ocr-http.mjs`）的关键行：

```text
PASS 8) 产品装配 real：受理前 503 PROVIDER_UNAVAILABLE、providerCalls=0、不回退替身（real-unconfigured）；+ 结构证据（app.ts 经 TS AST 核对：OCR 域只引用 service.ts 的 createUnwiredOcrTerminalHistoryPort；不 import store/provider/media/reference；provider.ts 无网络客户端；real 分支无替身回退）
PASS r7 主判据·运行期装载登记：resolve=1049 load=401；从受护文件可达的 OCR 域装载边=11（冻结基线命中 11 条；基线之外 0 条）；r8 fail-closed 命中 0 条（幂等重解析对 5 对，只计数不判红）；正控制 `node:os` 已在登记集合中
PASS 14 组：经真实装配的 app（buildApp）+ 本机回环 HTTP；合成身份/替身提供者/内存 store；未联网、未连库、未调真实供应商
```

---

## 6. 负控制表（每条都验证"能红"，不是只有正向读数）

| # | 负控制 | 变异/输入 | 期望（能红的条件） | 实测 |
| --- | --- | --- | --- | --- |
| **NC-1** | **`byte_exact_restore`** | 把 `ocr_records.corrected_fields.name` 改成 `被篡改的名字`，再按**原 jsonb 文本**写回 | 篡改后指纹**必须变**（否则"重启前后逐字节相等"没有牙齿）；写回后指纹与 `::text` 双双重现 | **PASS 24**：篡改 ⇒ 指纹 ≠ 写入时；写回后指纹 = 写入时、`corrected_fields::text` 逐字节相等 |
| NC-2 | 内存 store 同序列 | 同一序列写内存 store，再建**新实例**读 | 必须读不到（改前缺陷本体，可复现） | **PASS 25**：`getJob=null`、`getOcr=null`，`persistent=false` |
| NC-3 | CAS 并发双写 | 同一 `revision=1` 两路**并发** `updateJob` | 恰好 1 次成功、库内 `revision=2`（若退化成"先查后写"，会出现 2 次成功 / `revision=3`） | **PASS 26**：1 成功、1 `null`、库内 `revision=2` |
| NC-4 | 主键裁决重复写 | 同 `id` 再 `insertJob` | 抛「任务 id 冲突」且行数恒 1（无检查-写入窗口） | **PASS 27**（真库）＋ 单元 `[1]` |
| NC-5 | `state` 闭集 CHECK | 直接 `INSERT … state='bogus_state'` | 库侧 `23514` 拒绝且不落行 | **PASS 7** |
| NC-6 | CAS 失败不写记录 | `commitTerminal` 用错 `revision` | 返回 `null`、`ocr_records` 仍 0 行、任务 `state` 不变 | **PASS 12**（真库）＋ 单元 `[4]`（断言**未发** INSERT/UPDATE） |
| NC-7 | 记录冲突整事务回滚 | `commitTerminal` 的记录 id 已存在 | 抛「OCR 记录 id 冲突」且任务行 `state/revision` 原样（不留半成品） | **PASS 12**（真库）＋ 单元 `[4]`（`ROLLBACK` 出现、`COMMIT` 不出现） |
| NC-8 | 契约不可达的坏行 | 库里 `verification` 为 `null` 再 `getOcr` | 抛 `PROVIDER_UNAVAILABLE(retryable=false)`，不静默返回空对象 | 单元 `[5][6]` 坏行守卫 |

---

## 7. 门禁 exit code（逐条实跑）

| 门禁 | 命令（本机实跑） | exit code | 读数 |
| --- | --- | --- | --- |
| 静态检查 | `npm run lint` | **0** | `PASS tsc --noEmit services/api/tsconfig.json` / `apps/admin/tsconfig.json` / 仓库卫生扫描 |
| 真库脚本（本片核心） | `OCR_PG_TEST_URL=… node tests/integration/ocr-jobs-pg.mjs` | **0** | 27 条 PASS（§1/§3/§6） |
| 单元·语句形状（新增） | `node --test tests/unit/ocr-store-pg.test.mjs` | **0** | 14/14 |
| 单元·接线选择（新增） | `node --test tests/unit/ocr-store-pg-wiring.test.mjs` | **0** | 4/4 |
| 链结构门禁 | `node --test tests/unit/ci-integration-chain-structure.test.mjs` | **0** | 7/7（含新声明的未接线脚本） |
| 契约实现状态（行号证据） | `node tools/verify-contract-status.mjs` | **0** | `形状错误 0 项；语义错误 0 项`；`contract-status.json` **一字未改**（见 §5.0） |
| 交付材料索引 | `node --test tests/unit/release-materials-index.test.mjs` | **0** | 5/5（含"索引读数 = 文件系统事实"与反向回归） |
| 回环 HTTP 全链 | `npm run test:integration:http` | **0** | 13 个脚本依次通过（含 `ocr-http.mjs` 的 14 组 + r7/r8 装载登记 11／11／0） |
| 迁移器三臂（真库） | `MIGRATIONS_NEGATIVE_TEST_URL=… node tests/integration/migrations-negative-pg.mjs` | **0** | 11 条 PASS（见 §8） |
| 单元全量 | `node --test --test-concurrency=1 "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs" "tests/media/*.test.mjs" "tests/reference/*.test.mjs" "tests/moderation/*.test.mjs"` | **0** | 见 §7.1（本机内存紧 ⇒ 必须 `--test-concurrency=1`；不加会 `VirtualAlloc failed` 假红） |

> 沙箱：本会话默认隔离可正常 spawn（真库脚本的 `[R4]` 子进程臂与 `node --test` 的默认隔离都跑通了），
> 因此**未使用** `--test-isolation=none`。

### 7.1 单元全量读数

```text
ℹ tests 2888
ℹ suites 0
ℹ pass 2887
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 335075.9273
EXIT_UNIT=0
```

唯一的 `skipped 1` 是**既有**条件跳过（`tests/unit/knowledge-api.test.mjs` 的 `{ skip: !f.native }`，本片未改该文件）；
本片新增的两个测试文件**没有** `skip` / `only` / `todo`。

---

## 8. 迁移结构不变量的实跑读数（`0024` 之后仍绿）

`tests/integration/migrations-negative-pg.mjs` 的两条结构不变量（"1..max 连续无缺号"与"count === maxVersion"）在新增 `0024` 之后的原始读数：

```text
PASS 1: A0 基线：空库 `up` 依次应用 0001–0024，台账 24 行（三臂的前提现场可复现）
PASS 8: B1 重放：退出码 0，`已应用：（无）`＋`已存在跳过：0001…0024`，台账指纹/对象数/哨兵行完全不变
ALL 11 migration negative groups passed against native PG17.11; …
```

本片真库脚本里另有一次**独立复算**（不依赖上面那个文件）：

```text
PASS 1: [M0] 结构不变量：迁移 24 个（0001..0024），连续无缺号；count === max；末位 = 0024_ocr_persistence.sql
```

---

## 9. 未取得项（如实登记，不得读成"已验收"）

1. **HTTP 面的"重启不丢"未取得**：`real` 模式下真实 OCR 提供者/媒体端口未接线 ⇒ `POST /ocr` 在受理前就 503，
   无法经 HTTP 建出 PG 任务。本片证据在 **store 层 + 迁移层 + `app.ocrService` 读面**（`[R3]`）。要取得 HTTP 面读数，需先接真实提供者与媒体端口。
2. **PostgreSQL 服务器重启未测**：本片"重启"指 API 侧连接全关 + 新 Pool/新进程（实测后端进程 1→0）；未停/起集群验证崩溃恢复（WAL）。
3. **多进程/高并发压测未做**：只做两路并发 CAS（恰好一次成功）；未做 20+ 并发吞吐／延迟读数，也未做多实例（多个 API 进程）争抢同一任务的读面。
4. **备份恢复演练未做**：只验证单库迁移 UP/ROLLBACK/REPLAY 与关连接重开，未做 `pg_dump`/`pg_restore`。
5. **真实标签 OCR 模型输出落库未取得**：模型调用未接线；用契约合法的手工字段验证持久化语义，**不伪造**模型准确率，`dose_cards` 恒 `[]` 的口径未动。
6. **CI 接线未做**（本片按派单要求留给后续片）：新脚本 `tests/integration/ocr-jobs-pg.mjs` 已在
   `tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS` 里**如实声明**——
   未接进 `test:integration:http`（无 PG 的回环链），**也未改任何 `.github/workflows/**`**，`ci-real-pg-wiring.test.mjs` 的受管清单原样未动。
7. **`docs/architecture/contract-status.json` 未改**（派单红线）：其中 OCR 五端点的 `blocker` 文字仍描述"内存任务…待验收/持久链待验收"口径，
   与本片新增的持久化能力**存在表述滞后**。这是**已知缺口**，留给有权限同步该文件的那一片。
8. **`services/api/src/ocr/store.ts` 的头注释仍写着"本片只提供内存实现…持久化实现属后续任务"**：本片**未改**该文件（派单未要求、改动会牵动其他断言），
   现状是"注释滞后于代码"。已在 `store-pg.ts` 头注释里写明实现关系与迁移号，此处如实登记这份滞后。
9. **`real` + 池时的首次请求延迟/连接占用**未测量（只在构造期证明"不发查询"）。

---

## 10. 回退方式（可整片回退）

1. 迁移：执行 `services/api/db/migrations/rollback/0024_ocr_persistence.down.sql`（三张表干净删除，不触碰 `users` 与 0001 的 `jobs`）。
2. 接线：删掉 `app.ts` 里的 `ocrPersistencePool` 与第 4 个实参（回到"域内永远内存"），并删 `routes/ocr.ts` 的 `persistencePool` 形参与
   `createPostgresOcrStore` 分支 ⇒ 行为与接线前逐字一致（`stub`／`preset_demo`／`real+无池` 本来就未变）。
3. 文件：删 `ocr/store-pg.ts`、`tests/integration/ocr-jobs-pg.mjs`、两个 unit 测试；撤回 `UNWIRED_DECLARATIONS` 的一条与
   `ocr-http.mjs` 基线的 2 条边（9 → 11 的字面量一并回退）。

---

## 11. 复跑指令（照抄即可）

```powershell
# 1) 起独立 PG 17.11（未占用端口 + 一次性数据目录）
$BIN='E:\GengYunCommander\.pg17\pgsql\bin'
$DATA='E:\GengYunCommander\.pg17\data-r27s10'
& "$BIN\initdb.exe" -D $DATA -U postgres --locale=C --encoding=UTF8 -A trust
& "$BIN\postgres.exe" -D $DATA -p 55460 -c listen_addresses=127.0.0.1   # 前台跑；另开一个终端做下面几步
& "$BIN\createdb.exe" -h 127.0.0.1 -p 55460 -U postgres gengyun_ocr_jobs_test

# 2) 真库证据（本片核心）
$env:OCR_PG_TEST_URL='postgres://postgres@127.0.0.1:55460/gengyun_ocr_jobs_test'
node tests/integration/ocr-jobs-pg.mjs           # 期望 exit 0；缺 env ⇒ SKIP + exit 77

# 3) 迁移器三臂 + 单元 + 回环全链
$env:MIGRATIONS_NEGATIVE_TEST_URL='postgres://postgres@127.0.0.1:55460/postgres'
node tests/integration/migrations-negative-pg.mjs
node --test tests/unit/ocr-store-pg.test.mjs
node --test tests/unit/ocr-store-pg-wiring.test.mjs
node --test --test-concurrency=1 "tests/unit/*.test.mjs"
npm run test:integration:http

# 4) 收尾：停库并删数据目录
& "$BIN\pg_ctl.exe" -D $DATA -m fast stop
Remove-Item -Recurse -Force $DATA
```

> 本机复跑注意：`node --test` 跨多文件**必须** `--test-concurrency=1`（内存紧，否则 `VirtualAlloc failed` 假红）；
> 真库脚本要求**空库**（先断言 `public` 下 0 张表），重复跑请先 `dropdb` + `createdb`。

---

## 12. R27-S10-r1 返修：`42P01`「表未迁移」不得折成「数据库暂不可用」

> 本节记录首轮交付（PR #323 的既有 HEAD）在 CI 上暴露的**真回归**、机制、首轮本机门禁为何没抓到，
> 以及返修的判据与逐条读数。验证对象：`9c1ce37`（`ocr/store-pg.ts` 分化修复）＋ `56b2e98`（三层单测）；
> 本节作为整理提交交付，`git log -1 -- docs/verification/gy-r27-ocr-persist-20261020.md` 即其 SHA。

### 12.1 CI 失败现场（原始断言，未改写）

失败 step：

```text
… CREATE DATABASE gengyun_conversations_test && node tests/integration/conversations-pg.mjs
```

原始报错：

```text
AssertionError: {"error":{"code":"PROVIDER_UNAVAILABLE","message":"OCR 数据库暂不可用","retryable":true,…}}
```

CI 里 `conversations-pg.mjs:57` 只应用**子集迁移** `['0001','0002','0005','0008','0010','0012','0013']`，
该库因此**没有** `ocr_jobs` / `ocr_records` / `ocr_idempotency` 三张表（`0024` 未应用）。
脚本随后用 `executionMode:'real'` + 真 `pool` 建 app；接线把 OCR store 接成「real + 池 ⇒ PG」，
于是 `GET /api/v1/jobs/{id}` 的读路径打到缺表（`42P01`），被折成 `503 PROVIDER_UNAVAILABLE`。
本该是 `200`（命中会话作业源）或 `404`（真的不存在）。

### 12.2 机制链（逐环，按代码位置）

1. `services/api/src/routes/ocr.ts:193-196`：`real` + 有池 ⇒ `createPostgresOcrStore({ pool })`（不再退回内存）。
2. `services/api/src/app.ts:1946` 计算 `ocrPersistencePool`，`:1794` 把 OCR 源登记进 `jobs` 注册表（顺序：recognition → transcription → moderation → synthesis → **OCR** → answer）。
3. `services/api/src/jobs/routes.ts` 的 `GET /jobs/:id` 直接调 `registry.get`；`services/api/src/jobs/registry.ts:275-282` 按登记顺序逐个源取，**只有全部为 `null` 才**抛 `NOT_FOUND`。
4. `services/api/src/jobs/sources.ts` 的 OCR 源只把 `isNotFound(error)` 折成 `null`，**其它错误原样上抛**。
5. 旧 `store-pg.ts` 的读类没有「表未迁移」分支：`42P01` 被 `classifyOcrDatabaseError` 折成 `PROVIDER_UNAVAILABLE`（`retryable:true`，"OCR 数据库暂不可用"）。
6. ⇒ 注册表在第 5 步就抛出 503，后面的 answer 源根本没机会命中；`GET /jobs/{id}` 被 OCR 持久化故障污染。

**本质**：「表不存在」（部署/迁移未完成，**确定结论**）与「数据库故障」（连接/权限/超时，**状态未知**）不是一回事，必须分化。

### 12.3 首轮门禁为何没抓到

首轮本机只跑了这三类：

- `tests/integration/ocr-jobs-pg.mjs`：库是**全集迁移**（含 `0024`），永远走 `ready`，`42P01` 路径不存在；
- 单元测试：假池按脚本应答，**没有任何一条用例响应就绪探测**，也没模拟「子集迁移库」；
- `ocr-http.mjs` 等回环脚本：不接真库（或 `stub` 模式），OCR store 根本不落到 PG。

也就是说，首轮本机**从未运行过「`real` + 真池 + 子集迁移库」这个组合**——而这正是 CI 的
`conversations-pg` / `community-pg` / `messages-pg` / `favorites-history-pg` 四个脚本所处的环境。
四个脚本当时只在 CI 上跑过（其中 `conversations-pg` 是唯一把 OCR 源与 `GET /jobs/{id}` 串起来的），
本机没跑 ⇒ 回归漏检不是偶发，是覆盖缺口。

### 12.4 返修判据（12 个方法逐个分化）

| 方法 | 类别 | 表未迁移（探测 `missing`，或语句撞 `42P01`） | 真库故障（非 `42P01`） |
| --- | --- | --- | --- |
| `insertJob` / `updateJob` / `commitTerminal` / `insertOcr` / `updateOcr` / `claimIdempotent` / `finalizeIdempotent` / `releaseIdempotent` / `purgeIdempotent` | 写（9） | `requireTables()` 前置 ⇒ **`OcrTablesMissingError`**（`code=PROVIDER_UNAVAILABLE`、`retryable:false`、文案点名 `0024_ocr_persistence.sql`）；**一条业务 SQL 都不发**，不建连接 | 原分类保留（`PROVIDER_UNAVAILABLE`；`57014`/`55P03` ⇒ `PROVIDER_TIMEOUT`） |
| `getJob` / `getOcr` / `findIdempotent` | 读（3） | **`null`**（＝"没有已持久化的 OCR 作业"；与接线前内存 store 的对外行为一致），不抛、不 503 | 照旧抛（`readOrMissing` 只吞 `OcrTablesMissingError`） |
| 就绪探测本身失败／应答形状读不懂 | — | `unknown` ⇒ **抛** `PROVIDER_UNAVAILABLE retryable:true`（fail-closed，**不**当 `missing`）；`unknown` **不入缓存** | 原因仍按既有分类（`57014`/`55P03` ⇒ `PROVIDER_TIMEOUT`，不被 `instanceof ApiError` 前移吞掉） |

补充：缓存只存**确定结论**（`ready`/`missing`）；任何业务语句或事务撞 `42P01` 都先 `tables = null` 失效缓存，
本次按「未迁移」报告，下一次调用重新探测（表被回滚/补迁移都能收敛）。`OcrTablesMissingError extends ApiError`，
经 `classifyOcrDatabaseError` 时**原样透出**（单元测试断言 `error === original`）。

HTTP 面差异（有意的）：写类撞「表未迁移」时是 `PROVIDER_UNAVAILABLE` ⇒ `contract.ts:25` 的
`503: ['PROVIDER_UNAVAILABLE', …]` ⇒ **503 + `retryable:false`**（明确要求补迁移，不伪装成 404、也不诱导客户端重试）；
读类（`/jobs/{id}`）则照常 200/404。写失败必须让调用方看见，不能被读语义吞掉。

### 12.5 三层单测（新增文件，全部通过）

`tests/unit/ocr-store-pg-tables-missing.test.mjs`（**新增 13 条**；既有 `tests/unit/ocr-store-pg.test.mjs` 14 条；
两文件合计 **27 条**，即下方 `ℹ tests 27 / pass 27` 的读数）：

- **[A] 读类**：探测 `missing` ⇒ `getJob`/`getOcr`/`findIdempotent` 全部 `null`、零业务 SQL、只探测一次（含缓存命中）；
- **[B] 写类**：9 个方法全部抛 `OcrTablesMissingError`，断言 `instanceof`（含 `ApiError`）、`code`、`retryable === false`、文案匹配 `/0024_ocr_persistence\.sql/` 与 `/未迁移/`、**零业务 SQL**、`connects()===0`；
- **[C] 探测失败**：`pool.query` 在探测语句上抛 `ECONNREFUSED` ⇒ `unknown` ⇒ 读类 **fail-closed 抛**（不是返回 `null`）；断言 `unknown` 未入缓存（第二次调用重新探测）；`57014`/`55P03` 仍为 `PROVIDER_TIMEOUT`；形状读不懂（无 `ready` 列）同样 fail-closed。

原始读数：

```text
$ node --test tests/unit/ocr-store-pg.test.mjs tests/unit/ocr-store-pg-tables-missing.test.mjs
ℹ tests 27
ℹ pass 27
ℹ fail 0
ℹ skipped 0

$ node --test tests/unit/ocr-store-pg-wiring.test.mjs
ℹ pass 4
ℹ fail 0
```

既有 `ocr-store-pg.test.mjs` 的 **14 条用例**（含语句位置/条数断言）**逐条未动**；只把假池改成把探测语句分流到独立
`probes` 流（默认 `ready`），因此老断言不因新增探测而失效。

### 12.6 三条负控制（每条实测变红 + 逐字节还原）

工具在仓外（`.pg17/negctl.mjs`）：突变 → 跑三层单测 → 用原文恢复 → 比对 sha256。store 文件基线
sha256 = `486BA5A880783070A1133302275C8510DFF67DF93BC446C5F7DC1F828C893041`。

| # | 改了什么 | 哪条断言红（原始） | 还原 |
| --- | --- | --- | --- |
| NC-R1 | `requireTables()` 的 `missing` 分支改为 `return;`（写类放行到业务语句） | `AssertionError [ERR_ASSERTION]: Missing expected rejection (assertTablesMissing): insertJob 必须 fail-closed`；`pass=9 fail=4`，另 3 条 [B] 同红 | `RESTORED=true`；sha256 前后一致 |
| NC-R2 | `tablesReady()` 的 `unknown` 分支整块改为 `return 'missing';`（未知当未迁移） | `AssertionError [ERR_ASSERTION]: getJob 探测失败必须抛 ApiError`；`pass=9 fail=4`，[C] 4 条同红 | `RESTORED=true`；sha256 前后一致 |
| NC-R3 | 删掉全部 3 处 `tables = null;`（`42P01` 后不失效缓存） | `AssertionError [ERR_ASSERTION]: 42P01 之后必须失效缓存并重新探测（负控制③：去掉失效 ⇒ 本断言红）`；`pass=11 fail=2` | `RESTORED=true`；sha256 前后一致 |

负控制跑完 `git status --porcelain` = 0 行。

### 12.7 端到端复现：把 store 换回 `0fa9250` 版本，真库实测

复现库 `gengyun_conversations_test`（父代理预置，7 条子集迁移，`to_regclass` 三表全 `NULL`，**未改动**）。
用 `git show 0fa92502…:services/api/src/ocr/store-pg.ts` 临时覆盖工作树文件后实测（随即还原，sha256 一致）：

```text
STORE getJob(<random>) THREW: name=ApiError code=PROVIDER_UNAVAILABLE retryable=true message=OCR 数据库暂不可用
STORE findIdempotent THREW: name=ApiError code=PROVIDER_UNAVAILABLE retryable=true message=OCR 数据库暂不可用
STORE purgeIdempotent THREW: name=ApiError code=PROVIDER_UNAVAILABLE retryable=true message=OCR 数据库暂不可用
HTTP GET /api/v1/jobs/<uuid> => 503 {"error":{"code":"PROVIDER_UNAVAILABLE","message":"OCR 数据库暂不可用","retryable":true,"details":[]},…}
```

与 CI 的 `AssertionError` 逐字同型。返修后同一脚本、同一库：

```text
STORE getJob(<random>) => null
STORE findIdempotent => null
STORE purgeIdempotent(write) THREW: name=OcrTablesMissingError code=PROVIDER_UNAVAILABLE retryable=false message=OCR 持久化表未迁移（0024_ocr_persistence.sql）：拒绝写入，避免静默丢数据
HTTP GET /api/v1/jobs/<uuid> => 404 {"error":{"code":"NOT_FOUND","message":"作业不存在","retryable":false,"details":[]},…}
```

### 12.8 本机补跑 CI 那 4 个真库脚本（原始读数）

| 脚本 | 库 / 端口 | exit | 原始读数 |
| --- | --- | --- | --- |
| `tests/integration/conversations-pg.mjs` | `gengyun_conversations_test` @ 55461 | **0** | `conversations-pg：12 条读数全部通过（真 PostgreSQL 17.11）`；含 `[M]` 子集迁移三连、`[G] store.persistent=true`、`[S]` 的 `GET /jobs/{id}` 200、`[R]` 重启读回、`[F1]/[F2]/[W]/[E]/[N]/[P]` |
| `tests/integration/community-pg.mjs` | `gengyun_community_test` @ 55460 | **0** | `全部 23 组真库断言通过。` |
| `tests/integration/messages-pg.mjs` | `gengyun_messages_test` @ 55460 | **0** | `[√] ALL PASS：消息域 PostgreSQL 持久化端到端（迁移/重复/已读/归属/并发/派生计数/分页）` |
| `tests/integration/favorites-history-pg.mjs` | `gengyun_favorites_history_test` @ 55460 | **0** | `ALL PASS (13 groups) — real PG17 17.11` |

执行环境备注（如实记录，含与派单口径的偏差）：

- 这四个脚本**都不自建库**：库名硬钉、连接串必须指向同名库，且脚本开头断言 `public` 下 0 张表。
  因此本机先 `CREATE DATABASE` 建了三个空库（`gengyun_community_test`/`gengyun_messages_test`/`gengyun_favorites_history_test`，未删除）。
- `conversations-pg` 的库名硬钉为 `gengyun_conversations_test`，而 55460 上的同名库是**父代理的复现库**
  （7 条子集迁移，不可改、不可删）⇒ 另起一次性集群：`initdb -D .pg17\data-r27s10-conv`（`-A trust -E UTF8 --locale=C`）→
  `postgres.exe -D … -p 55461 -c listen_addresses=127.0.0.1` → 建空库 → 用 `CONVERSATIONS_PG_TEST_URL` 指向 55461 实跑。
  两个集群都是本机 PG 17.11，脚本自己的 `server_version` 读数一致。

### 12.9 返修后门禁读数（逐条实跑）

| 门禁 | 命令 | exit | 读数 |
| --- | --- | --- | --- |
| 静态检查 | `npm run lint` | **0** | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描` |
| OCR 真库（全集迁移） | `OCR_PG_TEST_URL=… node tests/integration/ocr-jobs-pg.mjs` | **0** | `共 27 条 PASS，耗时 1578ms`；`ALL PASS：…（迁移 0024 三连 / 12 方法语义 / 关连接重开逐字节仍在 / 4 条负控制）` |
| 迁移器三臂 | `MIGRATIONS_NEGATIVE_TEST_URL=… node tests/integration/migrations-negative-pg.mjs` | **0** | 11 组全 PASS；`PASS 1: A0 基线：空库 up 依次应用 0001–0024，台账 24 行`；`ALL 11 migration negative groups passed against native PG17.11` |
| 契约实现状态 | `node tools/verify-contract-status.mjs` | **0** | `覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项` |
| 交付文档 | `npm run test:docs` | **0** | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住` |
| 单元全量 | `node --test --test-concurrency=1 "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs" "tests/media/*.test.mjs" "tests/reference/*.test.mjs" "tests/moderation/*.test.mjs"` | **0** | `tests 2923 / pass 2922 / fail 0 / skipped 1`（`skipped 1` 是既有条件跳过 `knowledge-api.test.mjs` 的 `{ skip: !f.native }`）；两次实跑读数见下 |

单元全量的两次实跑（如实记录，不隐去）：

```text
# 第一次：与 tsc/lint/契约校验**并发**执行，机器负载高
ℹ tests 2923 / pass 2921 / fail 1 / skipped 1
✖ tests/unit/miniprogram-transcript-confirm.test.mjs:422
  TypeError: releaseGet is not a function  (…:437:3)

# 第二次：不再并发其它重任务
ℹ tests 2923 / pass 2922 / fail 0 / skipped 1
EXIT=0
```

第一次唯一的红灯与本片改动无关：`miniprogram-transcript-confirm.test.mjs` 的页面用例依赖 HTTP 替身的
微任务/定时器时序（在记录响应"在途"时断言零外发），高负载下 `releaseGet` 尚未被赋值即被调用；
单跑该文件 25/25 全绿，本片也没有改 `miniprogram/` 任何文件。第二次干净负载下全绿。

### 12.10 未取得／边界（不得读成已验收）

- **CI 复跑**：写手不 push、不合并 PR；本节只给本机读数，CI 复跑由监工触发。
- **真实 OCR 提供者/媒体端口**仍未接线：`POST /ocr` 受理前即 503，本片 HTTP 证据只到读路径与作业注册表。
- 三个新建空库（§12.8）未删除，留给复核；两个 PG 集群仍在运行（55460 / 55461）。
- `docs/architecture/contract-status.json`、迁移文件、`.github/workflows/*`、`services/api/src/jobs/sources.ts` 本次**一字未改**；
  既有断言**未削弱/未删除**，无 `skip`/`only`/`todo`。
