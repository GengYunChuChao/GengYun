# R34 · `public.jobs` 死表下线：收窄授权、删依赖判定里的 jobs 分支、同步清单与测试

- 采样时间：2026-10-24（UTC+8）
- 工作树：`E:\GengYunCommander\wt-r34-jobs-retire`｜分支 `feat/gy-r34-jobs-retire`
- 基线：`upstream/main = 123ee4bd5a827f7d5cef1c9bb89abd905e178dc6`。开工时 `git rev-parse HEAD` 与该基线同提交、`git status --porcelain -uall` = **0 行**（干净起手）。
- 本页读数全部来自本树实跑（未抄文档、未抄 commit message）；PG 臂未在本机执行，已在 §3 标明。

## 0 裁定与本片范围

**裁定 3（既定，本片不推翻也不「顺手改进」）**：`public.jobs` 是死表 —— 零生产写入、零入向外键、四份迁移的注释自述不读不写不删。因此它不构成任何真实依赖面：运行时不该持有它的任何授权，撤回/授权变更的依赖判定也不该把它算成「有资料」。

**本片做三件事**：

1. **收窄授权**：`gengyun_auth_privacy` 不再对 `jobs` 有列级 SELECT；
2. **删依赖判定里的 jobs 分支**：`consent-pg.ts` 与 `grant-pg.ts` 两处各自独立删一条 `EXISTS`；
3. **同步清单与断言面**：least-privilege 断言的 `external_manifest` 去掉 jobs 行并把计数改对、集成/单测夹具与消息同步、两处引用旧授权的注释按新事实改写。

**本片不做**：不新增迁移、不 `DROP TABLE`（理由见 §2）、不删 `job_state` 枚举（`0025`/`0026`/`0028` 仍在用）、不改任何 fail-closed 语义与中文文案、不动识别/语音域的 `recognition_jobs`／`speech_jobs`／`ocr_jobs` 表（那是另外三张活表）。

## 1 删了什么、为什么（逐处，行号为改后本树行号）

| # | 文件 | 改动 | 理由 |
| --- | --- | --- | --- |
| 1 | `services/api/src/privacy/consent-pg.ts:174` | 四并查删掉 `public.jobs` 那条 `EXISTS(... WHERE owner_id=$1::uuid)`，保留 `media`／`exports`／`author_links` 三臂（占位符仍是 `$1::uuid`） | 撤销时「有真实资料」的判据里，jobs 永远不会命中（零写入）⇒ 留着只是让人以为它还会命中 |
| 2 | `services/api/src/privacy/grant-pg.ts:86` | 同形四并查删 `public.jobs` 臂，保留三臂 | 同上。**这不是同一段代码**：这里占位符是 `$1`（不带 `::uuid`）、变量名 `deps`、已取 `.rows[0]`、两句文案也不同 —— 未统一、未改写 |
| 3 | `services/api/db/roles/auth_privacy.sql:39` | `GRANT SELECT (owner_id) ON jobs,media TO gengyun_auth_privacy;` ⇒ `GRANT SELECT (owner_id) ON media TO gengyun_auth_privacy;` | 收窄到仍被真实读取的 `media`；`:38` 的注释（仅存在性检查、不读内容、不改数据）对新授权面依然成立，未动 |
| 4 | `deploy/postgres-cvm/sql/90-assert-least-privilege.sql`（`external_manifest` CTE，现 16 条，`:1472-1543`） | 删掉 `('jobs', 'auth_privacy', false×4, ARRAY['owner_id'], …)` 这 3 行条目；在原位留 5 行 R34 注释说明移出与删表延后 | 清单冻结「经 NOLOGIN 组继承来的可见面」，正向判据要求**声明的列真的可读**；授权撤掉后这一行只会稳定判红 ⇒ 必须一起移出 |
| 5 | 同上 `:1454`、`:1458`、`:1470-1471`、`:1586`、`:1702`、`:3100`、`:3167-3169`、`:3191` | 清单条数 17⇒16（「其余 12 张表级全无」⇒「其余 10 张」、「其余 17 张表」⇒15、断言文案「16 张表」） | **成对改**：清单少一行，凡是描述这份清单条数的地方都得跟着改，否则读数自相矛盾 |
| 6 | 同上 `:1515-1516`（media 移出论证段） | 引文 `GRANT SELECT (owner_id) ON jobs,media` ⇒ `ON media` | 第 3 项改了角色文件后，这段引文会变成**假陈述**；论证本身（auth_privacy.sql 确实给组授过该表的 `owner_id`，故该行不能写成 `'direct'`）按新事实重新成立 |
| 7 | `deploy/postgres-cvm/sql/20-login-roles.sql:1007` | 同一条旧引文按新事实改写（只改这一行注释，`M` 段其它内容与识别/语音域段落一字未动） | 同上：不改就是假引文 |
| 8 | `deploy/postgres-cvm/roles-and-migration.md:42`、`:67` | §2.1 表格里 `auth_privacy.sql` 的授权对象去掉 `jobs`；§3.1 摘要「`jobs`、`media` 只授 `owner_id`」⇒「`media` 只授 `owner_id`」 | 这两行陈述的是**当前**授权面（参考文档，不是历史证据页） |
| 9 | `tests/integration/consent-grant-pg.mjs:170`、`:175`（删）、`:183` | 四表循环去掉 `'jobs'`；删掉 `INSERT INTO jobs(...)` 夹具；消息 `all four … classes` ⇒ `all three … classes` | 端到端臂要证明「每条真实依赖都 409」；删了判定分支后 jobs 夹具断言的语义不复存在。`randomUUID` 仍被 exports 夹具使用，import 未动 |
| 10 | `tests/unit/consent-withdraw-dependency.test.mjs:5`、`:67` | 头部块锚点 `consent-pg.ts:171-196` ⇒ `:171-195`（删了一行）；桩注释「jobs / media / exports / author_links 四臂」⇒「media / exports / author_links 三臂（R34 下线了 jobs 臂）」 | 两处都是**描述当前代码**的读数，不改就是假读数。该测试按 `sql.includes('AS present')` 认查询，不按臂数认 ⇒ 行为断言不变 |

## 2 没做什么（以及为什么）

- **表仍在库里**：`public.jobs` 及 `jobs_lease_idx`／`jobs_owner_created_idx`（`0001_initial_schema.sql:229-230`）原样保留。本片只让「无人读、无人授、清单不再分类它」成立。
- **`DROP TABLE` 延后到 0035，本片不新增迁移**，两条实测理由：
  1. **零先例**：`services/api/db/migrations/` 的正向迁移里 `drop table` 命中 **0** 次；64 次全部在 `rollback/*.down.sql`（20 个文件）。正向迁移首次引入 `DROP TABLE` 属于新形态，得单独裁定。
  2. **撞号**：本树最大迁移号是 **0032**；main／#525／#528 三条在途树已占到 0032/0033/0034，任何 ≤0034 的新号必撞车 ⇒ 等 0033/0034 落定后取 0035。
- **fail-closed 语义一个字没动**：`dependencies.rows[0]?.present` 判据方向、`if (!serviceOptions.egressRevoker) throw new ApiError('OBJECT_UNAVAILABLE', …)`、`try/catch` 内继续 throw，以及四句中文文案全部原样（`grant-pg.ts` 的两句与 `consent-pg.ts` 的两句仍各不相同）。
- **没改 `job_state` 枚举**：`0025`/`0026`/`0028` 仍在用。
- **没动识别/语音/OCR 域**：`ocr_jobs`、`recognition_jobs`、`speech_jobs` 是活表，相关授权面与探针禁止面（`expected_42501` 等）一律未碰。

## 3 门禁读数（真实尾部输出）

| 门禁 | 读数（尾部） | EXIT |
| --- | --- | --- |
| `node --test tests/unit/ci-integration-chain-structure.test.mjs` | `tests 7 / pass 7 / fail 0` | 0 |
| `node --test tests/unit/migration-reservations.test.mjs` | `tests 8 / pass 8 / fail 0` | 0 |
| `node tools/verify-migrations-unique.mjs --strict` | `PASS：5 项判据全部满足（surface / runner / dup / coexist / rollback）；31 条配对 + 1 条登记允许缺省 = 32 条正向迁移逐条有交代。` | 0 |
| `node --test tests/unit/deploy-sql-gate-probe.test.mjs` | `tests 7 / pass 7 / fail 0`（含「⑥ expected_42501 必须等于从探针源码数出来的禁止面条数」） | 0 |
| `node --test tests/unit/sql-column-coverage.test.mjs` | `tests 17 / pass 17 / fail 0` | 0 |
| `node --test tests/unit/deletion-registration-coverage.test.mjs` | `tests 5 / pass 5 / fail 0` | 0 |
| `node --test tests/unit/gy-i22-secmatrix.test.mjs`（见 §3.1） | **未取得** | 1（环境） |
| `node --check tests/integration/consent-grant-pg.mjs` / `tests/unit/consent-withdraw-dependency.test.mjs` | 无输出 | 0 / 0 |
| 附加：`tests/unit/consent-withdraw-dependency.test.mjs` | `tests 5 / pass 5 / fail 0`（含「有依赖 + 未注入消费者 ⇒ 409 OBJECT_UNAVAILABLE 且不留回执」「消费者抛错 ⇒ 仍是 409，不得退化成 503」） | 0 |
| 附加：`tests/unit/roles-file-disposition.test.mjs` | `tests 11 / pass 11 / fail 0`（文档计数门禁，本片改了 `roles-and-migration.md` 的对象清单） | 0 |
| 附加：`tests/unit/deploy-sql-gate-recovery.test.mjs` | `tests 8 / pass 8 / fail 0` | 0 |
| 附加：`tests/unit/ci-real-pg-wiring.test.mjs` | `tests 18 / pass 18 / fail 0` | 0 |
| `git merge-tree --write-tree upstream/main HEAD` | 提交后复验，读数见 §3.3 | — |

### 3.1 `gy-i22-secmatrix` 为何「未取得」（不是本片改红）

该文件在本树**无法执行，与本片改动无关**：它 `import { buildApp } from '../../services/api/src/app.ts'`，而 `app.ts` 在基线提交上第 2 行就是 `import Fastify from 'fastify'`；本树按约定**没有 `node_modules`**，ESM 又不认 `NODE_PATH` ⇒

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'fastify' imported from
E:\GengYunCommander\wt-r34-jobs-retire\services\api\src\app.ts
```

⇒ 该门禁靠 CI 执行。同因（`import app.ts`）无法本地执行的还有 `tests/unit/privacy-consent-wiring.test.mjs`；两者都不是本片改动引起。

### 3.2 PG 臂未本地执行

`tests/integration/consent-grant-pg.mjs`（端到端：四类依赖 ⇒ 三类依赖 + 撤回臂）**未在本机执行**（本树无依赖、且按约定不起 PG 集群）⇒ 靠 CI 的 `test:integration` 臂。改动只有 3 处、全在 `:170`／`:175`（删）／`:183`，静态可核。

### 3.3 提交后复验

`git merge-tree --write-tree upstream/main HEAD`（只在提交后跑，比的是提交树）：

```
（读数在提交后补入本节）
```

## 4 判过但不改（附理由）

| 位置 | 为什么不动 |
| --- | --- |
| `tests/integration/ocr-jobs-pg.mjs:297`、`recognitions-pg.mjs:316`、`speech-pg.mjs:277` 的 `jobsTable: to_regclass('public.jobs')` + `assert.equal(state.jobsTable,'jobs','DOWN 不得触碰 0001 的共享 jobs 表')` | 它们断言的是「**回滚不得删** 0001 的共享 jobs 表」；本片不删表 ⇒ 断言仍然为真，改它反而是错（删表那一片才必须改） |
| `services/api/src/admin/ops/jobs-pg.ts:4-9` 的注释「为什么读三张域内作业表，而不是 `public.jobs`」 | 陈述仍为真（表还在、仍无写入者），且它是「为什么不读」的论证，不是「表已删」的读数 |
| `docs/verification/gy-r31-i29-withdraw-deps-20261014.md`、`gy-i27-egress-ledger-pg-20261014.md`、`gy-i27-consent-grant-pg.md`、`gy-r31-closure-matrix-20261022.md`、`gy-r28-sql-column-coverage-20261021.md`、`gy-r28-w12-media-persistence-20261022.md` 里的「四类依赖」「四臂」「`GRANT … ON jobs,media`」引文 | 都是**带日期的历史证据页**（当时读数、当时 SQL、当时测试串）⇒ 按「纯历史叙述不改」处理；本页即为其后的订正入口 |
| `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的断言编号区间标签 `69-86`／`49-58` | 编号是粗粒度文档约定（`domain_manifest` 有 26 行却写「与 49-58 同形」）⇒ 区间≠行数，改标签只会制造假精度 |
| 其它「17」：`PG 17`／`PG 17.11`／`#16/#17 清理链`／`staging_importer.sql:17-18`／`17. 必须真的是 SECURITY DEFINER` | 与 `external_manifest` 条数无关，改它就是把无关读数改坏 |
| `tests/unit/least-privilege-expected-parity.test.mjs` | 本树**不存在**（#528 新增的文件不在 main 上）⇒ 按派单跳过，不造文件 |

## 5 剩余项：谁在什么条件下可以删表

`DROP TABLE public.jobs` 是独立后续片，进入条件与步骤：

1. **前提**：在途的 0033／0034 先在 main 落定（本片提交时 main 最大号 0032）。
2. **取号**：0035（`tools/verify-migrations-unique.mjs --strict` 与 `tests/unit/migration-reservations.test.mjs` 同时改台账）。
3. **裁定**：正向迁移**首次**出现 `DROP TABLE`（现 0 先例、64 次全在 rollback）⇒ 需要监工先给形态裁定；两种写法都要在派单里定死：①在 0035 里 `DROP TABLE public.jobs;`、0001 不动；②改 0001（不推荐，等于改历史迁移）。
4. **回滚配套**：`rollback/0035_*.down.sql` 必须建回表结构、两个索引（`jobs_lease_idx`／`jobs_owner_created_idx`）与 `job_state` 依赖关系；`job_state` 枚举本身不删（`0025`/`0026`/`0028` 仍在用）。
5. **同片必改**：`tests/integration/{ocr-jobs-pg,recognitions-pg,speech-pg}.mjs` 三处 `to_regclass('public.jobs')` 断言（现在断「DOWN 不碰共享表」，删表后必须翻成「不存在」或改断别的共享表）。
6. **删表之前的风险**：0 生产写入 + 本片已撤掉唯一授权面 ⇒ 表不再承载任何读写路径；剩下的只是磁盘占用与「看起来像在用的表」这一认知负担。

## 6 提交

- 单提交：`feat(privacy): 下线 public.jobs 死表引用与授权（Refs #19, #22）`（只用 `Refs`，不用 `Closes`）。
- 收工读数：`git status --porcelain -uall` = 0 行；HEAD 见回报。
