# R34 · `public.jobs` 死表下线（收窄授权 + 依赖判定去 jobs 臂 + 清单/测试同步）

- 树：`E:\GengYunCommander\wt-r34-jobs-retire`，分支 `feat/gy-r34-jobs-retire`，基线 `upstream/main` = `123ee4bd5a827f7d5cef1c9bb89abd905e178dc6`。
- 片范围：只做「无人读、无人授、清单不再分类它」；**不新增迁移、不 `DROP TABLE`**（理由见 §2）。
- 提交：功能提交 `7be2480a`（`feat(privacy): 下线 public.jobs 死表引用与授权（Refs #19, #22）`）+ 合并 `4b87e1d9`（`git merge --no-ff upstream/main`，吸收 `Reviewed PR #525`）+ 返修提交（本页所在提交，`fix(gy-r34-jobs-retire): 修复 doc 锚点与 90-assert 总数口径，补臂集合正控制（Refs #19, #22）`；oid 见片回报——本页不能自引自身 oid）。
- 本页 150 行（写定后按 `split('\n')` 实测长度 −1 复算；本轮修完所有改动后的真实值）。
- 本页全部读数均在上述工作树实跑；**PG 臂（`tests/integration/consent-grant-pg.mjs`）本地未执行**（本树无依赖、不许起集群），靠 CI。

## 0 裁定 3 与本片的立论口径

裁定 3：`public.jobs` 是死表。**准确的事实表述是三件事**（这是本片改动的全部依据）：

1. **无读者**：仓内没有任何生产读点读它（无 `FROM public.jobs`；`to_regclass('public.jobs')` 只出现在测试的 DOWN 断言里）。
2. **无入向外键**：没有任何表 `REFERENCES public.jobs`。
3. **无外发账本关联**：`egress_ledger` 侧不引用 jobs。

⇒ 撤销它的组授权与两条依赖判定分支，**不会产生任何需要级联清洗的下游**（没有 reader 要改、没有 FK 要跟着断、没有账本行要跟着清）。

⛔ **不能说成「零生产写入」**：存在**文档化的手工写入** —— 恢复演练的种子 SQL 就有 `INSERT INTO public.jobs (id, owner_id, kind, …)`（`docs/verification/gy-i24-restore-drill-local-20261018.md:81`，便携 PG 17.11 `:55631`，`SEED_EXIT=0`、`jobs=1`）；旧测试夹具也一直能插 jobs 行。写入能力从未被撤销，本片撤的是**授权面与判定臂**。

### 行为变更（如实记，零测试覆盖）

real 模式下，历史上真有 jobs 行的用户，撤回/授权变更会从 **409 `OBJECT_UNAVAILABLE`（旧：被判为「有资料/任务依赖」）** 变成 **200（放行）**。这是本片的**净语义变化**，而它**没有任何测试覆盖**：集成臂只覆盖 media / exports / author_links 三张活表，jobs 的历史行场景既没有夹具也没有断言。若后续要保留旧 409 语义，需要另开一条真库用例（见 §5）。

## 1 删了什么、为什么

### 1.1 功能提交 `7be2480a`（9 files, +136/−26）

| 文件 | 改动 | 理由 |
|---|---|---|
| `services/api/src/privacy/consent-pg.ts` | 四并查 → 三并查：删 `OR EXISTS(SELECT 1 FROM public.jobs …)`（现 :174 起，首臂 `public.media`） | jobs 零读者，把它算进「真实依赖」会让一个死表继续触发 fail-closed 409 |
| `services/api/src/privacy/grant-pg.ts` | 同形删 jobs 臂（现 :86-88；占位符恒为 `$1`，**未**改成 `$1::uuid`） | 同上；两文件不是同一段代码，未做「统一」 |
| `services/api/db/roles/auth_privacy.sql` | :39 `GRANT SELECT (owner_id) ON jobs,media` → `ON media` | 没有任何读点需要 `auth_privacy` 读 jobs 的属主列 |
| `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` | `external_manifest` 删 jobs 条目（原 :1506-1508，现留 R34 注释）；条数口径 17→16：:1454、:1458、:1471（其余 10 张）、:1586（其余 15 张）、:1706、:3104、:3171、:3173、:3195 | 断言必须与「已撤授权」的新事实一致，否则门禁会在真库上红 |
| `deploy/postgres-cvm/sql/20-login-roles.sql` | :1007 历史注引文 `GRANT … ON jobs,media` → `ON media` | 引文必须与 `auth_privacy.sql:39` 现状一致，否则是假陈述 |
| `deploy/postgres-cvm/roles-and-migration.md` | :42 授权面表格删 `jobs`；:67 改为「`media` 只授 `owner_id`」 | 参考文档=当前事实 |
| `tests/integration/consent-grant-pg.mjs` | :170 四表循环 → 三表；删 `INSERT INTO jobs(...)` 夹具；:182 `all four …` → `all three …` | 夹具不该再为一个已无授权面的表造依赖 |
| `tests/unit/consent-withdraw-dependency.test.mjs` | :75 注释「四臂」→ 三臂 | 注释与 SQL 形状一致 |
| `docs/verification/gy-r34-jobs-retire-20261024.md` | 新增（本页） | 证据 |

红线复核：`consent-pg.ts:178` / `grant-pg.ts:90` 的「没有 revoker 就 throw」、`consent-pg.ts:185` / `grant-pg.ts:96` 的「消费者抛错继续 throw」、四句中文文案、`dependencies.rows[0]?.present` / `deps?.present` 判据方向——**逐字未改**。

### 1.2 返修提交（doc 锚点 + 总数口径 + 臂集合正控制）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `docs/architecture/contract-implementation-status.md` | :63 （原写 `grant-pg.ts` 的 `32-113`，越界——该文件只有 112 行）改为 `32-112`；:64 现状行改为「media/exports/author_links 存在依赖时仍 409」并加 R34 脚注 | 每文件删 1 行 ⇒ 原区间越界；现状句在删 jobs 臂后已成假陈述 |
| `docs/architecture/contract-status.json` | :364 `"lines": "32-113"` → `"32-112"`；:395 blocker 文案同步 | 台账 JSON 与 md 表格**成对**改（只改一边 = 假绿） |
| `docs/verification/gy-r28-contract-line-anchors-20261021.md` | :157 同一锚点 `32-113` → `32-112` | 同上 |
| `docs/verification/gy-r31-i29-withdraw-deps-20261014.md` | :96 （原写 `consent-pg.ts` 的 `:186`，删一行后该行现在是空收尾）改为 `:185` | 删一行后 catch-throw 上移一行 |
| `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` | 区间标签 `69-86` → `69-84`（:1544、:3104）；总数口径 :3605-3614：`117 条 → 116 条`、`sum 3693 → 3663`（含「静态扣减、真库待核」标注） | 18 个编号对应 16 行不符；总数必须随 −1 行/–30 字符自洽 |
| `tests/unit/consent-withdraw-dependency.test.mjs` | 新增两条**臂集合形状钉**（:217、:229）+ `readFileSync` 导入（:35）+ 头注第 7/8 点（:30-31） | 既有 :68 用 `sql.includes('AS present')` 把查询形状桩死，「把 jobs 臂加回去」原本全绿（复审 P1 实测） |

## 2 没做什么、为什么

- **没 `DROP TABLE`**：表仍在库里。理由两条已实测：①正向迁移里 `DROP TABLE` **零先例**（64 条全在 `rollback/*.down.sql`）；②三条在途树的最大迁移号是 0032/0033/0034，任何 ≤0034 的新号必撞车 ⇒ `DROP` 作为后续独立片，在 0033/0034 落定后取 **0035**。
- **没新增迁移**：同上（本片零 DDL）。
- **没改 fail-closed 语义**（红线 1）：判据方向、抛错条件、四句中文文案全部原样。
- **没碰识别/语音域**：`20-login-roles.sql` 的 admin-jobs / recognition / speech 段、`services/api/src/ocr/jobs-pg.ts` 一类命名都保留（本片只改与 `public.jobs` 的**授权面/判定臂**有关的东西）。
- **没删 `job_state` 枚举**：`0025`/`0026`/`0028` 仍在用。
- **没为门禁变绿改探针禁止面或 `expected_42501`**（红线 2）：`external_manifest` 与断言的 `expected` 侧成对演进，没有「只改一边」的假绿。

## 3 门禁读数（本树实跑，逐字尾部 + EXIT）

| # | 命令 | 尾部（逐字） | EXIT |
|---|---|---|---|
| 1 | `node --test tests/unit/ci-integration-chain-structure.test.mjs` | `ℹ tests 7 / ℹ pass 7 / ℹ fail 0` | 0 |
| 2 | `node --test tests/unit/migration-reservations.test.mjs` | `ℹ tests 8 / ℹ pass 8 / ℹ fail 0` | 0 |
| 3 | `node tools/verify-migrations-unique.mjs --strict` | `PASS：5 项判据全部满足（surface / runner / dup / coexist / rollback）；32 条配对 + 1 条登记允许缺省 = 33 条正向迁移逐条有交代。` | 0 |
| 4 | `node --test tests/unit/deploy-sql-gate-probe.test.mjs` | `ℹ tests 7 / ℹ pass 7 / ℹ fail 0` | 0 |
| 5 | `node --test tests/unit/sql-column-coverage.test.mjs` | `ℹ tests 17 / ℹ pass 17 / ℹ fail 0` | 0 |
| 6 | `node --test tests/unit/deletion-registration-coverage.test.mjs` | `ℹ tests 5 / ℹ pass 5 / ℹ fail 0` | 0 |
| 7 | `node --test tests/unit/consent-withdraw-dependency.test.mjs` | `ℹ tests 7 / ℹ pass 7 / ℹ fail 0` | 0 |
| 8 | `node --test tests/unit/roles-file-disposition.test.mjs` | `ℹ tests 11 / ℹ pass 11 / ℹ fail 0` | 0 |
| 9 | `node --test tests/unit/deploy-sql-gate-recovery.test.mjs` | `ℹ tests 8 / ℹ pass 8 / ℹ fail 0` | 0 |
| 10 | `node --test tests/unit/ci-real-pg-wiring.test.mjs` | `ℹ tests 18 / ℹ pass 18 / ℹ fail 0` | 0 |
| 11 | `node --test tests/unit/doc-closing-keywords.test.mjs` | `ℹ tests 5 / ℹ pass 5 / ℹ fail 0` | 0 |
| 12 | `node --test tests/unit/doc-anchors-guard.test.mjs` | `ℹ tests 10 / ℹ pass 10 / ℹ fail 0` | 0 |
| 13 | `node tools/verify-doc-anchors.mjs --strict` | `COUNT: BROKEN 33 / OUT_OF_RANGE 6 / SUSPECT 64` / `BASELINE … 基线内命中 103 / 基线外新增 0` | 0 |
| 14 | `node tools/verify-contract-status.mjs` | `PASS: 中文表格一致` / `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` | 0 |
| 15 | `node --check services/api/src/privacy/consent-pg.ts`、`node --check services/api/src/privacy/grant-pg.ts` | 无输出 | 0 |
| 16 | `git merge-tree --write-tree upstream/main HEAD`（提交后） | 单行树 OID，无 `CONFLICT` / 无冲突文件行 | 0 |

### 3.1 `gy-i22-secmatrix.test.mjs`：未取得（环境缺失，非本片回归）

`node --test tests/unit/gy-i22-secmatrix.test.mjs` → **EXIT=1**，栈为：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'fastify' imported from
  …/tests/unit/gy-i22-secmatrix.test.mjs
code: 'ERR_MODULE_NOT_FOUND'
```

本工作树按派单**无 `node_modules`**（且不许装）。该测试 import 生产依赖 ⇒ 本地无法执行，靠 CI。

### 3.2 PG 臂：未本地执行，靠 CI

`tests/integration/consent-grant-pg.mjs`（现 251 行）本树无依赖、且不许起 PG 集群 ⇒ **未执行**。改动可静态核对：`:170` 循环改为 `['media','exports','author_links']`；原 jobs 的 `INSERT INTO jobs(...)` 夹具整块删除；`:182` 消息串改为 `all three unimplemented business dependency classes refuse initial/replacement authorization without fake cancellation`。`randomUUID` 仍被 exports 夹具使用，导入保留。

### 3.3 doc 锚点：修复前红、修复后绿（红要如实记）

- 修复前（复审在 `9157e032` 上实跑）：`COUNT: BROKEN 33 / OUT_OF_RANGE 8 / SUSPECT 65`，**基线外新增 3 条** ⇒ EXIT=1。
- 修复三处后（本树）：`COUNT: BROKEN 33 / OUT_OF_RANGE 6 / SUSPECT 64`，**基线外新增 0** ⇒ EXIT=0。差值 −2 OUT_OF_RANGE、−1 SUSPECT 与「两个 `32-113` 越界 + 一个 `:186` 行错」逐条对上。
- `verify-contract-status.mjs` 本轮**先红后绿**：首次 EXIT=1（`FAIL: 表格漂移 1` —— md 现状句已改、台账 JSON 未同步），成对改 `contract-status.json:395` 后 EXIT=0（`PASS: 中文表格一致`）。这条正是「只改一边 = 假绿」的实例，故在此留档。

### 3.4 臂集合正控制（关掉复审 P1 盲区）

新增的两条形状钉读源码文本、不连库：

- `consent-withdraw-dependency.test.mjs:217` 断言 consent-pg 依赖查询**不含** `public.jobs`、三臂齐全（media/exports/author_links）、占位符仍是 `$1::uuid`。
- `consent-withdraw-dependency.test.mjs:229` 断言 grant-pg 同形三臂、占位符保持 `$1`、且**不含** `$1::uuid`（防「统一」）。

变异验证（改完即还原，文件字节恢复）：

| 变异 | 期望 | 实测 |
|---|---|---|
| `consent-pg.ts` 把 jobs 臂加回 | 转红 | 红：`public.jobs 已下线（零读者死表），不得回到依赖判定臂里` |
| `grant-pg.ts` 把 `$1` 改成 `$1::uuid` | 转红 | 红：`grant-pg 的占位符保持 $1（不许"统一"成 consent-pg 的 $1::uuid）` |
| 还原后 | 复绿 | `ℹ tests 7 / ℹ pass 7 / ℹ fail 0` |

### 3.5 没跑的与原因（不含糊）

- `tests/unit/*.test.mjs` **全量**：派单明令禁跑（只跑定向门禁）；`--test-isolation=none` 亦按要求未用。
- 真库臂（psql 跑 `90-assert`、`expected/expected_42501` 实际比对）：本树无依赖、不许起集群 ⇒ 未跑。故 §1.2 里 `3663` 是**静态扣减值**（`3693 − (28+2)`），非真库读数，需 CI/真库确认。
- `tests/unit/privacy-consent-wiring.test.mjs`：同 §3.1 的 `fastify` 缺失原因未跑（同一环境证据已由 secmatrix 给出）。

## 4 判过、但不改（附理由）

| 位置 | 判据 | 结论 |
|---|---|---|
| `tests/integration/ocr-jobs-pg.mjs`、`recognitions-pg.mjs`、`speech-pg.mjs` 的 `jobsTable: to_regclass('public.jobs')` + `DOWN 不得触碰 0001 的共享 jobs 表` | 断的是**回滚不得删 0001 的共享表** | **不改**：本片不删表，改它反而是错 |
| `services/api/src/admin/ops/jobs-pg.ts` 内注释 | 提到「与 0001 的共享 jobs 表对齐」 | 不改：属后台运维作业表，与本片授权面无关 |
| 历史证据页的「四类依赖 / four classes / `ON jobs,media`」引文（`gy-r31-i29-withdraw-deps-20261014.md`、`gy-i27-egress-ledger-pg-20261014.md`、`gy-i27-consent-grant-pg.md`、`gy-r31-closure-matrix-20261022.md`、`gy-r28-sql-column-coverage-20261021.md`、`gy-r28-w12-media-persistence-20261022.md`） | 均为当时读数/当时建议/逐字引用 | 不改：历史证据页记录的是「当时」；本页登记现状 |
| `gy-r31-i29-withdraw-deps-20261014.md:96` 行内另一处 `consent-pg.ts:179`（缺消费者分支） | 删一行后该分支实际在 :178 | **残留一行偏移**，未改：属历史页读数，不在本轮三处锚点修复的裁定范围；`--strict` 不判红（该行有实质文本），在此如实登记 |
| `90-assert` 里与清单无关的「17」（PostgreSQL 17 / `#16/#17 清理链` / `PG 17.11` / `staging_importer.sql:17-18` / `17. 必须真的是 SECURITY DEFINER`） | 与 manifest 条数无关 | 不改：只改描述该清单条数的那几处 |
| `tests/unit/least-privilege-expected-parity.test.mjs` | 在 #528 上，本树不存在 | 跳过（未造文件） |
| `job_state` 枚举 | 0025/0026/0028 在用 | 不删 |

## 5 剩余项

1. **谁在什么条件下可以删表**：`DROP TABLE public.jobs` 作为独立片，前置 ①在途 0033/0034 落定后可取 0035；②正向迁移里先建立该动作的先例写法（全仓 `DROP TABLE` 目前只在 rollback）；③确认没有运维脚本再向它 seed（`gy-i24-restore-drill-local-20261018.md:81` 那份种子脚本必须先改，否则删表后演练会红）。
2. **行为变更需要补覆盖**：若产品要继续「历史 jobs 行 ⇒ 409」的旧语义，必须补一条真库臂用例（当前为零覆盖，见 §0）。
3. **真库确认**：`90-assert:3605-3614` 的 `116 条 / 3663` 需真库跑一次 `SELECT count(*) … label` 类核对（静态估算留了标注）。

## 6 提交与工作树读数

- 功能提交：`7be2480a feat(privacy): 下线 public.jobs 死表引用与授权（Refs #19, #22）`（父 `123ee4bd`）。
- 合并：`git merge --no-ff upstream/main` ⇒ `4b87e1d9`（`Reviewed PR #525`），EXIT=0、无冲突。
- 返修提交：`fix(gy-r34-jobs-retire): 修复 doc 锚点与 90-assert 总数口径，补臂集合正控制（Refs #19, #22）`（本页所在提交）。
- 收工：`git status --porcelain -uall` 0 行；`git rev-parse HEAD` 的实测值见片回报（本页无法自引自身 oid）。
