# R31 片 · 把三条「写了但没门禁」的真库臂接进 CI

- 日期：2026-10-22
- 分支：`feat/gy-r31-pg-arms`（工作树 `E:\GengYunCommander\wt-r31-pg-arms`）
- 基线：工作树原基于 `93eff4f1`。取证时 `git fetch origin --quiet` 得到 `origin/main = d2f6e356`；提交前 `origin/main` 又推进到 **`bf2f76f9`**（`93eff4f1..bf2f76f9` 共 11 个合入，主要是 `#462` 的「写死行号改实时定位 + line-anchor 守卫」、`#463`／`#465`／`#467` 的测试门禁、`#409` 的真实模型接线与 `#461` 的社区筛选下推），本分支已 rebase 到 `bf2f76f9` 之上，**矩阵与判据行在新 tip 上复算后结果不变**（仍是 28 臂 × 15 workflow，零命中仍是这 3 条）。接线改动全部落在本分支。
- 关联：`#9`（识别/作业台）、`#10`（OCR）、`#12`（问答）

## 一句话结论

三条臂（`admin-jobs-pg` / `ocr-corrections-pg` / `qa-citations-pg`）在 `origin/main` 上**确实无任何 workflow 门禁**（28 条 `*-pg.mjs` × 15 个 workflow 逐条检索，零命中的只有这 3 条）；已按现有范式在 `real-pg-integration.yml` 的 `real-pg-17.11` job 里各加一个**独立 step**（含库创建、77→硬失败升级、读数非空断言），并同步冻结受管清单三处 + 反向白名单的三条 `reason`；本地 PG 17.11 三条臂全部 exit=0（8 / 7 / 15 条读数），仓内静态守卫 `ci-real-pg-wiring` **18/18**、`ci-integration-chain-structure` **7/7**。**CI 上的实际执行未取得，需合入后观察。**

## 1. 复核：28 条臂 × 15 个 workflow

命令（`node` 脚本，逐条 `git show origin/main:<workflow>` 后 `line.includes(<臂 basename>)` 统计命中行号）：

```js
const arms = git('ls-tree','-r','--name-only','origin/main','tests/integration/')
  .split('\n').filter((p) => p.endsWith('-pg.mjs'));                    // 28
const workflows = git('ls-tree','--name-only','origin/main','.github/workflows/');  // 15
// 对每个 (arm, workflow)：git show origin/main:<wf> → 逐行 includes(arm basename) → 记命中行号
```

读数：`arms=28 workflows=15`，**零命中 = 3 条**：`admin-jobs-pg.mjs`、`ocr-corrections-pg.mjs`、`qa-citations-pg.mjs`。

| # | 臂（`tests/integration/`） | 命中 workflow | 命中行 |
|---|---|---|---|
| 1 | `account-deletion-pg.mjs` | `real-pg-integration.yml` | 121,124 |
| 2 | `account-suspend-pg.mjs` | `real-pg-integration.yml` | 192 |
| 3 | `admin-accounts-read-pg.mjs` | `real-pg-integration.yml` | 133,137 |
| 4 | `admin-flags-pg.mjs` | `real-pg-integration.yml` | 146,149 |
| 5 | `admin-jobs-pg.mjs` | **（无）** | — |
| 6 | `auth-privacy-pg.mjs` | `auth-privacy-postgres.yml` | 34 |
| 7 | `backup-copies-purge-pg.mjs` | `real-pg-integration.yml` | 6,259 |
| 8 | `backup-purge-pg.mjs` | `real-pg-integration.yml` | 243 |
| 9 | `catalog-pg.mjs` | `catalog-postgres.yml` | 34 |
| 10 | `community-filter-pg.mjs` | `real-pg-integration.yml` | 91 |
| 11 | `community-pg.mjs` | `real-pg-integration.yml` | 3,79 |
| 12 | `consent-grant-pg.mjs` | `consent-grant-postgres.yml` | 34 |
| 13 | `conversations-pg.mjs` | `real-pg-integration.yml` | 2,69 |
| 14 | `egress-ledger-pg.mjs` | `consent-grant-postgres.yml` | 37,42 |
| 15 | `egress-object-key-pg.mjs` | `consent-grant-postgres.yml` | 40,51,56 |
| 16 | `egress-revoke-race-pg.mjs` | `consent-grant-postgres.yml` | 65 |
| 17 | `favorites-history-pg.mjs` | `real-pg-integration.yml` | 5,111 |
| 18 | `messages-pg.mjs` | `real-pg-integration.yml` | 4,102 |
| 19 | `messages-purge-pg.mjs` | `real-pg-integration.yml` | 264,280 |
| 20 | `migrations-negative-pg.mjs` | `auth-privacy-postgres.yml` | 42 |
| 21 | `ocr-corrections-pg.mjs` | **（无）** | — |
| 22 | `ocr-jobs-pg.mjs` | `real-pg-integration.yml` | 161 |
| 23 | `qa-citations-pg.mjs` | **（无）** | — |
| 24 | `recognitions-pg.mjs` | `real-pg-integration.yml` | 175 |
| 25 | `source-lifecycle-pg.mjs` | `source-lifecycle-postgres.yml` | 34 |
| 26 | `speech-pg.mjs` | `real-pg-integration.yml` | 205 |
| 27 | `staging-intake-pg.mjs` | `staging-intake-postgres.yml` | 34 |
| 28 | `workbook-staging-pg.mjs` | `workbook-staging.yml` | 7,43 |

| workflow | 引用的 `-pg.mjs` 臂数 |
|---|---|
| `real-pg-integration.yml` | 15（+ `recognition-chain-e2e.mjs`，非 `-pg` 后缀） |
| `consent-grant-postgres.yml` | 4 |
| `auth-privacy-postgres.yml` | 2 |
| `catalog-postgres.yml` / `source-lifecycle-postgres.yml` / `staging-intake-postgres.yml` / `workbook-staging.yml` | 各 1 |
| `access-verification` / `deploy-sql-gate` / `development-docs` / `engineering-shell` / `evaluation-chain` / `failmatrix` / `local-wechat` / `migrations-guard` | 0 |

补充检索（防「只在注释/文档里被提到」的误判）：`git grep <basename> origin/main -- . ':(exclude)tests/integration/'` ⇒ 这 3 条除自身与 `tests/unit/ci-integration-chain-structure.test.mjs`（未接线白名单，见 §4）外，只在 `docs/` 与 deploy SQL 注释里出现，**没有任何 workflow 真跑它们**。

> ⚠ 只看 `real-pg-integration.yml` 会得出「12 条无门禁」的假结论——`auth-privacy-pg`／`catalog-pg`／`consent-grant-pg`／`egress-*`／`migrations-negative-pg`／`source-lifecycle-pg`／`staging-intake-pg`／`workbook-staging-pg` 各有专用 workflow（上表第 6/9/12/14/15/16/20/25/27/28 行）。本片复核与派单结论一致。

## 2. 三条臂的判据行（逐条抄）

### 2.1 env / argv / 77 判据

| 臂 | 怎么连库 | 未设时 | 判据行 |
|---|---|---|---|
| `admin-jobs-pg.mjs` | **argv[2]**（argv[3] 可选＝既有运行时 URL） | **无 77 分支**（回落到 `postgres://postgres@127.0.0.1:5432/<DB>`，连不上即非 0） | `:50 const ownerUrl = new URL(process.argv[2] ?? \`postgres://postgres@127.0.0.1:5432/${DB}\`)`；`:51-52` 断言 hostname `127.0.0.1` / pathname `/${DB}`；`:53 const runtimeArg = process.argv[3]` |
| `ocr-corrections-pg.mjs` | **env `OCR_PG_TEST_URL`** | `:38-42` 未设/空 ⇒ 打印 `SKIP real PG17: …` + `process.exit(77)` | `:36 const ENV = 'OCR_PG_TEST_URL'`；`:37 const DB = 'gengyun_ocr_corrections_test'`；`:43-47` 断言 protocol、`assert.equal(url.search, '')`（URL **不得带查询串**）、hostname 回环、pathname `/${DB}` |
| `qa-citations-pg.mjs` | **env `QA_CITATIONS_PG_TEST_URL`** | `:68-79` 未设 ⇒ SKIP + `process.exit(77)`（仅 `--allow-skip` / `GY_ALLOW_SKIP=1` 才 0） | `:54 const DB = 'gengyun_qa_citations_test'`；`:55 const ENV = 'QA_CITATIONS_PG_TEST_URL'`；`:66 ALLOW_SKIP = process.argv.includes('--allow-skip') \|\| process.env.GY_ALLOW_SKIP === '1'` |

### 2.2 非空证明（「exit 0 但没跑」不可变绿）

| 臂 | 输出证明 |
|---|---|
| `admin-jobs-pg.mjs` | `note()`（`:65-68`）只 `console.log`，**不打 `PASS `**；读数形如 `[M] …`／`[P] …`／`[J] …`，末行 `:939 note('[ALL PASS] …')` |
| `ocr-corrections-pg.mjs` | 每条 `:52 console.log(\`PASS ${passed}: ${message}\`)`；末行 `:256 OK ${passed} 项真库读数全部通过（数据库 ${DB}）。` |
| `qa-citations-pg.mjs` | 每条 `:91 console.log(\`PASS ${line}\`)`；末行 `:521 qa-citations-pg：${passes} 条读数全部通过（真 PostgreSQL ${version}）` |

### 2.3 三条臂各自的前置条件（决定接线形态）

- `admin-jobs-pg.mjs`：`:252 preflightRuntimeRole()` —— 给了 argv[3] 就要求 `gengyun_api_runtime` **已存在**；**没给 argv[3] 而角色已存在则抛错拒绝运行**（不得接管既有角色）。`:276 provisionRoles()` 自己 `CREATE ROLE` + 生成口令 + 派生运行时 URL；`:859 cleanup()` 按开跑时快照差集 `DROP OWNED BY` + `DROP ROLE` 复原。⇒ **唯一自洽调用形态：只传 argv[2]，且集群里没有该角色。**
- `ocr-corrections-pg.mjs` 与 `qa-citations-pg.mjs`：都要求**空库**，自己 `applyMigrations`（后者只 apply `:60` 的七段子集并断言二连跑幂等），全程只用库 owner 连接、不建组角色 ⇒ 对前后脚本零耦合。

## 3. 接线（最小改动，照现有范式）

### 3.1 新增 3 个 step（`real-pg-integration.yml`）

全部塞进既有单 job `real-pg-17-11`（**不新建 job、不新增 service、不动既有 step 顺序**），形状与既有臂一致：`psql -c 'CREATE DATABASE <db>'` + `node tests/integration/<arm>` + step 级 env（`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` + 该臂自己的 URL）；带 77 的两条照抄 `recognition-chain-e2e` 的 `rc` 升级块，并额外用 `tee` + `awk` 断言读数 > 0。

| 位置 | 臂 | 库 | 关键断言（step 内） |
|---|---|---|---|
| 第 4 步（紧随社区域） | `qa-citations-pg.mjs` | `gengyun_qa_citations_test` | 77 ⇒ `::error::` + exit 1；`^PASS ` 计数 < 1 ⇒ exit 1 |
| 第 8 步（`account-deletion` 与 `admin-accounts-read` 之间） | `admin-jobs-pg.mjs` | `gengyun_admin_jobs_test` | 非 0 ⇒ exit；`^\[[A-Z]\]` 计数 < 1 或缺 `[ALL PASS]` ⇒ exit 1（**只传 argv[2]**） |
| 第 12 步（紧随 `ocr-jobs`） | `ocr-corrections-pg.mjs` | `gengyun_ocr_corrections_test` | 77 ⇒ `::error::` + exit 1；`^PASS ` 计数 < 1 ⇒ exit 1 |

`timeout-minutes: 15 → 20`（job 从 16 步增到 19 步；本地三条臂合计 5.3s，20 分钟仍宽松）。顶部臂清单注释补 3 行。

为什么 `admin-jobs` 必须夹在中间：它要求集群里**没有** `gengyun_api_runtime`，而它前一步 `account-deletion` 的收尾正是「按 `pg_roles` 快照差集 DROP 并复核为空」；它自己 `cleanup()` 也会把角色清回 0，故后一步 `admin-accounts-read`（本来就先 `DROP IF EXISTS` 再重建）依然自洽。⛔ 挪到 `admin-accounts-read` 之后会撞「角色已存在」的拒绝接管分支。

### 3.2 diff 摘要

```
 .github/workflows/real-pg-integration.yml          | 116 +++++++++++++++++++++
 tests/unit/ci-real-pg-wiring.test.mjs              |  23 ++++
 tests/unit/ci-integration-chain-structure.test.mjs |  20 ++--
 3 files changed, 151 insertions(+), 8 deletions(-)
```

- `real-pg-integration.yml`：+3 行顶部清单、+3 个 step（含注释）、`timeout-minutes` 15→20。**既有 16 个 step 的文本一字未改**。
- `ci-real-pg-wiring.test.mjs`：`MANAGED_SCRIPTS` / `FROZEN_MANAGED_SCRIPTS` / `REQUIRED_STEP_ORDER` 三处同步插入（保持 `[0]=conversations`、`[1]=community`，`recognition-chain-e2e` 仍在末尾），并给 `REQUIRED_STEP_ORDER` 的新条目补「为什么排这里」的注释。
- `ci-integration-chain-structure.test.mjs`：三条 `UNWIRED_DECLARATIONS` 的 `reason` 从「尚未接进任何 workflow」改成「已接线 `real-pg-17.11` job、但仍不进无 PG 回环链」（**条目本身保留**，因为 `test:integration:http` 回环链仍不含它们）。

> 这两处登记表都**必须**改，否则 `ci-real-pg-wiring` 的判据⑨（集合双向相等）与 `ci-integration-chain-structure` 的「白名单不得腐烂」会各自变红——不是可选清理。

## 4. 本地真库读数（PG 17.11 / 127.0.0.1:55725）

启动方式（按派单要求，**不用 `Start-Process`**）：

```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = 'cmd.exe /c "E:\GengYunCommander\.pg17\pgsql\bin\postgres.exe -D E:\GengYunCommander\.pg17\tmp\r31-wiring-pg-55725 -p 55725 -c logging_collector=on -c log_directory=log -c listen_addresses=127.0.0.1"'
}
# pg_isready → accepting connections；select version() → PostgreSQL 17.11 on x86_64-windows
```

三条臂各一空库、跑完即止（URL 形如 `postgres://postgres@127.0.0.1:55725/<db>`）：

| 臂 | exit | 耗时 | 行数 | 读数 |
|---|---|---|---|---|
| `qa-citations-pg.mjs` | 0 | 2.1s | 11 | `PASS ` × **8**，末行 `qa-citations-pg：8 条读数全部通过（真 PostgreSQL 17.11）` |
| `ocr-corrections-pg.mjs` | 0 | 1.1s | 9 | `PASS ` × **7**，末行 `OK 7 项真库读数全部通过（数据库 gengyun_ocr_corrections_test）。` |
| `admin-jobs-pg.mjs` | 0 | 2.1s | 17 | `[A-Z]` × **15**，末行 `[ALL PASS] R29-S5 真库臂 ①开关真实生效 ②作业/错误可见 ③变更留痕 A→B ④最小权限 全部取得` |

原文摘录（`admin-jobs-pg`，注意它不打 `PASS `）：

```
[M] 0001→0027 全量应用（真 PG）…
[P] 新建运行时角色 gengyun_api_runtime（口令只在本进程内存里；收尾按 pg_roles 差集 DROP 回原状）
…
[ALL PASS] R29-S5 真库臂 ①开关真实生效 ②作业/错误可见 ③变更留痕 A→B ④最小权限 全部取得
```

`qa-citations-pg` 原文摘录：

```
Real PostgreSQL server_version: 17.11
PASS [M] 真库 17.11：迁移子集 0001/0002/0005/0008/0010/0012/0013 按序应用，二连跑 applied=[]
PASS [A] 读面准入：2 条 verified+valid 进行；rejected 与 expired 两行 0 行可见
…
qa-citations-pg：8 条读数全部通过（真 PostgreSQL 17.11）
```

### 4.1 前置条件取证（`admin-jobs` 排位的两端）

| 场景 | 命令要点 | exit | 跑后 `gengyun_api_runtime` 计数 |
|---|---|---|---|
| 角色**不存在**（起点为空集群） | `node tests/integration/admin-jobs-pg.mjs <owner-url>` | **0** | **0**（自己建又自己 DROP） |
| 角色**已存在**（负控制） | 先让 `admin-accounts-read-pg` 建出角色，再跑 `admin-jobs-pg` | **1** | 1（拒绝接管，未动别人的角色） |
| 其后 `admin-accounts-read-pg` | `<owner-url> <runtime-url>` | **0** | 1（它按设计不清理） |

⇒ `admin-jobs` 只在「角色不存在」的集群上绿，且跑完把角色清回 0，正好落在 `account-deletion`（收尾复核为空）与 `admin-accounts-read`（先 DROP 再建）之间，两端都自洽。

> 如实记录一处与本片无关的本地异常：在同一集群串行复跑时 `account-deletion-pg` 打完 `CLEANUP=done（…已清理并复核为空…）` 之后有一条断言 `actual: 5, expected: 0` 失败（exit=1）。它是 `origin/main` 上的既有受管臂，本片**未改它一行**；本机是 `postgres` 超级用户 + `--auth=trust` 集群，与 CI 的 `gengyun_ci_owner`（官方镜像里也是超级用户）+ scram 存在环境差异。故「`admin-jobs` 排在它之后」这一前提**没有**用它的本地绿来支撑，而用了上表的三种独立取证（起点为空、负控制、以及它自己的 cleanup 语义）。

## 5. YAML 校验读数

- `actionlint`：**本机没有**（`Get-Command actionlint` 为空），按派单「没有就跳过并说明」——未执行，不计为通过。
- 替代校验 ①（结构自检，`node`，不解析 YAML 只查结构事实）：

```json
{ "lines": 436, "steps": 23, "createDatabaseLines": 20, "servicesPinPostgres17": true, "problems": [] }
```

（`problems` 为空：无 TAB、末尾有换行、每个 `- run:`/`- name:`/`- uses:` 缩进都是 6、每个 step 的子键只出现 `run/name/env/uses` 之类。）
- 替代校验 ②（仓内静态守卫真解析 workflow）：`node --test tests/unit/ci-real-pg-wiring.test.mjs` ⇒ `ℹ tests 18 / pass 18 / fail 0`，其中判据③④⑤⑥⑦⑧⑨与 3 条反向控制全绿（这等于用仓里自己的解析器确认了新 step 的库名、顺序、`CREATE DATABASE` 先后、无 `if:`／`continue-on-error`／`|| true`）。rebase 到 `bf2f76f9` 后与另一条守卫合并复跑：`ℹ pass 25 / fail 0`。
- 替代校验 ③：`node --test tests/unit/ci-integration-chain-structure.test.mjs` ⇒ `ℹ pass 7 / fail 0`（含「白名单不得腐烂」）。
- 替代校验 ④（`#462` 新加的 line-anchor 守卫，本片 rebase 后必须复验）：`node --test tests/unit/test-line-anchors-guard.test.mjs` ⇒ `ℹ pass 7 / fail 0`。本片在 workflow 注释、测试注释与证据页里引用的 `文件:行` 都属「注释/失败文案」侧，按该守卫自己的判据不拦；断言侧未新增任何写死行号。

## 6. 未取得项

- **CI 上的实际执行未取得，需合入后观察**：本机跑不了 GitHub Actions，`real-pg-17.11` 里三个新 step 的真实运行结果（尤其 `postgres:17.11` service 容器内的角色/权限行为、以及 20 分钟超时是否够）只有合入后第一次 run 才能证实。
- `actionlint` 未执行（工具缺失）。
- `account-deletion-pg` 的本地异常（见 §4.1 末段）未追根因——不在本片范围，仅记录。
- 未开 PR、未合并、未 approve、未推 main（按硬约束）。

## 7. 复现命令

```powershell
# 矩阵
node <matrix script>            # git ls-tree origin/main 取 28 臂 + 15 workflow，逐 wf git show 后 includes 命中
# 三条臂（本机 PG 17.11 :55725）
node tests/integration/qa-citations-pg.mjs                       # env QA_CITATIONS_PG_TEST_URL
node tests/integration/ocr-corrections-pg.mjs                    # env OCR_PG_TEST_URL
node tests/integration/admin-jobs-pg.mjs postgres://…/gengyun_admin_jobs_test
# 校验
node --test tests/unit/ci-real-pg-wiring.test.mjs
node --test tests/unit/ci-integration-chain-structure.test.mjs
```
