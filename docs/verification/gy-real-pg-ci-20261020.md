# GY 真库臂接入 CI：把两个「在 main、却没有任何 workflow 跑过」的真库脚本接进 GitHub Actions

- 日期：2026-10-20
- 分片：真库臂 CI 接线（派单 `.pg17/dispatch/real-pg-ci-wiring-20261020.md`）
- 分支：`test/gy-real-pg-ci-wiring`，基线 `upstream/main` = `df043a715e691019e14373181249a5cf51ec9da9`（短 `df043a7`，本片首次改动前实测）
- 环境：Windows（PowerShell 5.1，本机 PATH 无 `pwsh`）、Node v24.16.0、npm 11.13.0、`npm ci --offline --ignore-scripts`（103 packages）
- **沙箱口径（决定了本页一半的「未取得」）**：本会话是 confined（workspace-write）⇒ 任何**带管道 stdio 的子进程**都会 `EPERM`（§4.1 逐字读数）。所以本页凡是「跑不起来」的项一律写**未取得**并给出权威替代读数，⛔ 不写成通过。
- 本页所有数字都有可复跑命令；标「未取得」的一律**没有验证过**。

## 0 结论（先看这四条）

1. **缺口是真的**：`tests/integration/conversations-pg.mjs`（#313）与 `tests/integration/community-pg.mjs`（#296）都在 main 上，但把 11 个 workflow 逐个搜文件名是 **0 命中**——真库臂只存在于本机，CI 上这两个脚本坏成什么样都不会红（§1.1）。
2. **本片只做一件事**：新增 `.github/workflows/real-pg-integration.yml`（第 12 个 workflow），用官方 `postgres:17.11` 服务容器 + 各自建**专用空库**的方式真跑这两个脚本（§2）。
3. **把缺口变成会红的断言**：新增 `tests/unit/ci-real-pg-wiring.test.mjs`（6 个用例＝3 前向 + 3 反向控制）。三条反向控制除了在内存里变异，还**在磁盘上真的破坏过 workflow**：删 `run:` 行／加 `GY_ALLOW_SKIP`／把镜像降到 `postgres:16.4`，三次都让同一守卫变红，复原后 sha256 逐次核对一致（§4.3）。
4. **未取得（如实）**：workflow 的**真红/真绿**只能由 PR 自身 CI 的 run 证明——本机无容器运行环境、无 YAML 解析器（actionlint／PyYAML／js-yaml 全无）、且子进程 EPERM；`npm run test:integration:http` 本机跑到第 8 段时红在 `tests/integration/ocr-http.mjs` 的**子进程探针**上（`spawnSync … EPERM`，非本片缺陷，§4.5）。

## 1 缺口事实（逐条实测，不是推断）

### 1.1 两个脚本都在 main，但没有任何 workflow 跑它们

命令与读数（基线 `df043a7`，workdir 为任一含仓库的检出）：

```
git ls-tree --name-only upstream/main:tests/integration | Select-String 'conversations-pg|community-pg'
  → conversations-pg.mjs, community-pg.mjs            （两个文件都在）

git ls-tree --name-only upstream/main:.github/workflows      → 11 个 .yml
git grep -n "conversations-pg|community-pg" upstream/main -- .github/workflows
  → 0 命中（exit=1）
```

即：脚本写好了、证据页写了、也没有任何门禁会因此变红——这正是「静默缺口」的形状（与 #312 收口的 `tests/integration` 覆盖缺口同源，只是那条守卫的判类刻意把 `*-pg.mjs` 排除在外，见 `tests/unit/integration-script-coverage.test.mjs` 的判类注释）。

接线后的同一检索（本片工作树）：

```
Select-String -Path .github/workflows/*.yml -Pattern 'conversations-pg|community-pg'
  real-pg-integration.yml:2   ← 文件头注释（不算接线）
  real-pg-integration.yml:3   ← 文件头注释（不算接线）
  real-pg-integration.yml:61  - run: psql … && node tests/integration/conversations-pg.mjs
  real-pg-integration.yml:71  - run: psql … && node tests/integration/community-pg.mjs
```

守卫**只认命令文本、不认注释**——这一点被反向控制里的「注释里的 `run:` 不算接线」用例单独钉住（§3.3）。

### 1.2 为什么这两个脚本必须真库

两个脚本锁的都是**只有数据库能证明**的性质，内存库／替身证不了：

| 脚本 | 硬钉库名 | 真库才能证明的性质（摘自脚本文档头） |
| --- | --- | --- |
| `tests/integration/conversations-pg.mjs` | `gengyun_conversations_test` | 迁移子集按序 apply 且二连跑 `applied.length === 0`；`catalog_read.current_knowledge` 真的带 `created_at`（缺 0012 就 `42703`）；引用只能取自本次检索集合在真 PG store 上成立 |
| `tests/integration/community-pg.mjs` | `gengyun_community_test` | 唯一键真的能裁决并发、外键真的挡孤儿行、枚举/CHECK 真的拒绝闭集外的值、迁移 `0022` 真能 apply → rollback → 再 apply、`buildApp` 有真库时真的开启社区域 |

两个脚本都**要求空库**（脚本开头断言 `public` 下没有任何表），且库名写死在源码里 ⇒ 不能共用一个库；而 `services.postgres` 只按 `POSTGRES_DB` 建一个库 ⇒ 必须每个 step 各自 `CREATE DATABASE`（§2）。

### 1.3 为什么缺库必须「红」而不是「跳过」

两个脚本在缺连接串时打印 `SKIP` 并**以 77 退出**（POSIX `skipped` ≠ 通过），只有显式 `--allow-skip`／环境开关才降级为 0。这是 `#312` 之后仓内的硬约定（口径文件 `.pg17/ruling-skip-exit-code-20261020.md`；机器守卫在 `tests/unit/integration-script-coverage.test.mjs` 的「整链跳过必须给 77」用例里，逐文件扫描 `tests/integration/*.mjs`）。

于是真库 workflow 的正确行为是：**真库没起来 ⇒ 脚本 77 ⇒ job 红**。那个红不是故障噪声，而是「这一轮没有验证真库臂」的**正确读数**。反过来，只要有人往 workflow 里塞一个放宽开关，就会把「0 条断言」读成绿——本片的第二条守卫专门拦这个（§3.1 判据②）。

## 2 接了什么

新增 `.github/workflows/real-pg-integration.yml`（78 行，第 12 个 workflow），形状照抄 `.github/workflows/consent-grant-postgres.yml`：

| 键 | 取值 | 为什么 |
| --- | --- | --- |
| `name` | `Real PostgreSQL integration gates` | 与其它 PG workflow 的命名同族 |
| `on` | `pull_request` + `push: branches: [main]` | 与 `consent-grant-postgres.yml` 一致；PR 与合并后都跑 |
| `permissions` | `contents: read` | 最小权限，本片不写任何东西 |
| job id | `real-pg-17-11` | GitHub 的 job id 只允许字母/数字/`-`/`_`，**不允许点号** |
| job `name` | `real-pg-17.11` | 派单要求的「job 名」按显示名落地，与 `consent-grant-postgres.yml`（id `consent-grant-pg`／name `consent-grant-postgres-17.11`）同构 |
| `runs-on` | `ubuntu-24.04` | 与仓内其余 workflow 一致 |
| `timeout-minutes` | `15` | 真库 job 卡住时会白烧 6 小时额度；15 分钟是仓内 `engineering-shell.yml` 的既有口径 |
| `services.postgres.image` | `postgres:17.11` | 两个脚本的文档头都写 PG 17.11 |
| `services.postgres.env` | `POSTGRES_DB/USER/PASSWORD` = `gengyun_ci_bootstrap` / `gengyun_ci_owner` / `synthetic-ci-owner-only` | **明显的合成值**，与其它 PG workflow 同值；不含任何真实凭据 |
| `services.postgres.ports` | `['5432:5432']` | 仅回环映射 |
| `services.postgres.options` | `pg_isready` + 5s/5s/10 次 | 逐字照抄 `consent-grant-postgres.yml` 的健康检查 |
| `actions/checkout` | `11bd71901bbe5b1630ceea73d27597364c9af683` | 仓内既有 workflow 的固定 SHA（§2 末行说明实读口径） |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | 同上；`node-version: '24.16.0'` + `cache: npm` 与其它 PG workflow 一致 |
| 说明 | 上两行的 SHA 是**实读** `.github/workflows` 全部 11 个文件后取的：每个 workflow 的 `uses:` 行都固定到这同一个 40 位值，没有浮标签 | 派单要求「到既有 workflow 实读，⛔ 不许写浮标签」 |

两个真跑 step（`&&` 串联，建库失败不会被吞成「脚本 77 也算跑过」）：

```
- run: psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_conversations_test' && node tests/integration/conversations-pg.mjs
  env: { CONVERSATIONS_PG_TEST_URL, PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE }
- run: psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_community_test' && node tests/integration/community-pg.mjs
  env: { COMMUNITY_PG_TEST_URL, PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE }
```

`psql` 在 `ubuntu-24.04` runner 上现成可用（`consent-grant-postgres.yml` 已在用同一手法先建库再跑脚本），本片沿用该范式、不引入新依赖。

**刻意的三处「不做」**：

1. ⛔ **不设** `GY_ALLOW_SKIP`、⛔ **不传** `--allow-skip`：缺真库必须 77 ⇒ job 红。
2. ⛔ 不把两个脚本塞进 `package.json` 的 `test:integration:http` 链：那条链是**无库**回环链，接进去会让每个本地开发者天天红；真库臂的正确位置就是一个带 PG 的 workflow（与 `.pg17/ruling-skip-exit-code-20261020.md` 第 2 条同口径）。
3. ⛔ 不改任何既有 workflow、不改 `tests/integration/**`、不改 `package.json`（§8 改动面）。

## 3 守卫测试（`tests/unit/ci-real-pg-wiring.test.mjs`，409 行）

范式照 `tests/unit/integration-script-coverage.test.mjs`：**纯静态、只读 `.github/workflows/` 的文本、⛔ 不起服务/不连 PG/不联网/不写任何文件/不加依赖**；正向断言与反向控制**调用同一个函数**（所以「反向控制的红」证明的就是「真实缺口会红」）。

### 3.1 四条判据

| 判据 | 实现 | 拦的是什么 |
| --- | --- | --- |
| ① 受管脚本必须被某个 workflow 的 `run:` **命令文本**执行 | `runCommandTextsOf()` 取 `run:` 的内联值 + 其后缩进更深的块行，**跳过 `#` 注释行**；`missingManagedScripts()` 求差集 | 「脚本在 main、但没人跑」的静默缺口；也拦住「只写在注释里」的糊弄 |
| ② 任何 workflow 都不得含放宽跳过开关 | `escapeHatchHits()` 扫 `GY_ALLOW_SKIP` 与 `--allow-skip`，报 `文件:行号: 开关` | 为让 job 绿而把「未取得」改写成「通过」（假绿） |
| ③ `services.postgres` 必须存在且镜像主版本锚定 17 | `postgresServiceProblems()` 逐段查 `services:` → `postgres:` → `image:` → `postgres:(\d+)`，主版本必须 `17` | 镜像降级到 16（17 专有行为静默失真）／删掉 service（真库没了） |
| ④ workflow 的每个 `uses:` 必须固定到 40 位 SHA | `unpinnedUses()` 逐个 `uses:` 行比对 `@[0-9a-f]{40}$` | 浮标签（`@v4`）会让 CI 语义随上游发版改变 |

受管脚本清单是**冻结**的（`MANAGED_SCRIPTS` 与 `FROZEN_MANAGED_SCRIPTS` 双向比对）：增删受管脚本＝改门禁口径，必须同时改两处并更新本页，刻意留 diff。另有三条「反空转」断言：workflow 数 ≥ 11、`run:` 命令块数 ≥ 5、受管清单 ≥ 2——否则「什么都没扫」也会绿。

### 3.2 六个用例

1. **前向①**：两个受管脚本都被某个 workflow 的 `run:` 真跑（＋冻结清单比对＋受管脚本必须真实存在）。
2. **反向控制①**：删掉 `conversations-pg.mjs` 的 `run:` 行 ⇒ 必须红并**点名**该脚本；同时证明「只写进注释救不了」「真的写成 `run:` 就转绿」。
3. **前向②**：任何 workflow 都不得含放宽跳过开关。
4. **反向控制②**：往 workflow 追加 `GY_ALLOW_SKIP`／`--allow-skip` ⇒ 必须红，消息里出现该开关与文件名；反向不误伤（「不得放宽」这种反向措辞不算开关）。
5. **前向③**：`services.postgres` + 镜像主版本 17 + `uses:` 全固定 SHA（另断言该 workflow 真的用 `psql` 建库、真的 `npm ci`）。
6. **反向控制③**：镜像降 16／删 `services:` 段／把固定 SHA 换成 `@v4` ⇒ 三条各自必须红且消息点名。

### 3.3 三条反向控制的**落盘**自证（派单 §1 第三条的硬要求）

内存变异之外，还在一份**备份 + sha256 复核**的保护下真的破坏过磁盘上的 workflow（脚本 `.pg17/tmp/real-pg-ci/reverse-control-ondisk.ps1`，⛔ 不进仓库）：

```
BASELINE_SHA256=395a9a7a97171626c51ef12f85c5079197e0de6dfa3e29a266e4de04a2bffe71
--- MUTATION 1-delete-run-line : EXITCODE=1 ---      删掉 `node …/conversations-pg.mjs` 那一行
RESTORED_SHA256=395a9a7a…bffe71 MATCH=True
--- MUTATION 2-add-allow-skip : EXITCODE=1 ---        追加一行 `# GY_ALLOW_SKIP=1`
RESTORED_SHA256=395a9a7a…bffe71 MATCH=True
--- MUTATION 3-postgres-16 : EXITCODE=1 ---           镜像改 `postgres:16.4`
RESTORED_SHA256=395a9a7a…bffe71 MATCH=True
FINAL_SHA256=395a9a7a…bffe71 MATCH=True
FINAL_EXITCODE=0
```

三次的失败面**各是前向 + 对应反向控制这一对**（其余用例保持绿），逐次读数：

| 变异 | 退出码 | 变红的用例（逐字） | 断言原文（逐字摘） |
| --- | --- | --- | --- |
| 删 `run:` 行 | 1 | `tests 6 / pass 4 / fail 2`：前向① + 反向控制① | `有受管真库脚本既没有被任何 workflow 的 run: 执行…` → `· tests/integration/conversations-pg.mjs` |
| 加 `GY_ALLOW_SKIP` | 1 | `tests 6 / pass 4 / fail 2`：前向② + 反向控制② | `有 workflow 含「放宽跳过」的开关…` → `· .github/workflows/real-pg-integration.yml:79: GY_ALLOW_SKIP` |
| 镜像改 16 | 1 | `tests 6 / pass 4 / fail 2`：前向③ + 反向控制③ | `` 真库 workflow … 的 services.postgres 不合格：`` → `` `services.postgres.image` 主版本是 16，要求 17：postgres:16.4 `` |

一条如实记录的副作用：变异 1 里**反向控制①**自己先红在 `变异必须真的改到文本（否则反向控制是空转）`——因为「把 run 行删掉」这个变异在已被删过的文件上不再改变文本。它不是误报（该用例本来就要求变异非空转），但读日志的人会先看到这条消息；真正的定位消息来自**前向①**（同一日志里紧邻的一条）。复原后 6/6 全绿（§4.3）。

## 4 门禁实跑读数

### 4.1 沙箱前置读数（决定了下面哪些项只能记未取得）

```
node -e "const cp=require('node:child_process'); const r=cp.spawnSync(process.execPath,['-e','console.log(42)'],{encoding:'utf8'}); console.log('status',r.status,'out',JSON.stringify(r.stdout),'err',String(r.error&&r.error.code));"
status null out undefined err EPERM

node --test tests/unit/ci-real-pg-wiring.test.mjs      （＝默认隔离，逐文件起子进程）
✖ Error: spawn EPERM  at ChildProcess.spawn (node:internal/child_process:441:11)
    at runTestFile (node:internal/test_runner/runner:536:32)      → EXITCODE=1
```

⇒ **默认隔离的跑法在本机不可用**（不是本片缺陷，与错误类 61／`commander-session-20261018-side-wxlogin.md` §4 第 1 条同源）。故单测走**降级跑法**并逐条声明（§4.4）。

### 4.2 聚焦守卫（6/6 绿）

```
node --test --test-isolation=none tests/unit/ci-real-pg-wiring.test.mjs
✔ 前向①：两个受管真库脚本都被某个 workflow 的 `run:` 真跑
✔ 反向控制①：删掉某脚本的 `run:` 行，同一断言必须红并点名它
✔ 前向②：任何 workflow 都不得含「放宽跳过」开关
✔ 反向控制②：往 workflow 里加 `GY_ALLOW_SKIP` 或 `--allow-skip`，同一断言必须红并点名文件
✔ 前向③：真库 workflow 有 `services.postgres`，镜像主版本锚定 17，且 `uses:` 全部固定 SHA
✔ 反向控制③：镜像降到 16 / 删掉 services / 换成浮标签，同一断言必须红
ℹ tests 6   ℹ pass 6   ℹ fail 0   ℹ skipped 0   ℹ duration_ms 54.1964   EXITCODE=0
```

### 4.3 三条反向控制的落盘自证

见 §3.3 的逐字读数（三次 `EXITCODE=1`、每次 `pass 4 / fail 2`、复原 sha256 三次全 MATCH、终检 `FINAL_EXITCODE=0` 且 6/6 绿）。

### 4.4 全量单测（**跑法降级**，四条声明）

#### 4.4.1 声明①：跑法降级——非默认隔离

```
node --test --test-isolation=none "tests/unit/*.test.mjs"
ℹ tests 1836   ℹ suites 0   ℹ pass 1766   ℹ fail 69   ℹ cancelled 0   ℹ skipped 1   ℹ todo 0
ℹ duration_ms 151363.74        EXITCODE=1
```

用的是 **`--test-isolation=none`**（口径 40 的许可分支；本机在默认隔离下必 `spawn EPERM`，无法取得默认隔离读数）。**本读数不得当作基线，也不得单独当作「是否本片引入」的判据**。

#### 4.4.2 声明②③：判据＝「受影响文件与失败集合**同名同数**」，且**与 pristine baseline 逐条比对**

为了归因而不是猜测，另建了一棵**基线检出**（`git worktree add --detach … df043a7`，独立 `npm ci`，⛔ 无任何 `node_modules` 联接），在同一台机、同一跑法下复跑同一命令：

| 读数 | 本片工作树（含 3 个新文件） | 基线 `df043a7`（pristine） | 差 |
| --- | --- | --- | --- |
| `tests` | 1836 | 1830 | +6（＝本片新增的 6 个用例） |
| `pass` | 1766 | 1760 | +6 |
| `fail` | 69 | 69 | 0 |
| `skipped` | 1 | 1 | 0 |

失败集合逐条比对（剥掉 `(..ms)` 计时后缀后按名去重）：

```
mine_unique=69  baseline_unique=69
diff_count=0
IDENTICAL_FAILURE_SET (timing stripped)
```

⇒ **同一批 69 条，名字与条数完全相同**；本片新增的 6 个用例全部计入 pass。没有任何一条是「本片引入的新红」。

#### 4.4.3 声明②的补充：这 69 条不是口径 40 记的 8 条 `knowledge-*` 假红，而是 `spawnSync … EPERM` 族

同一次运行的签名计数与逐字样本：

```
actual_null_occurrences=18      expected_(0|1|2)=18     ← 子进程没有退出码
EPERM_occurrences=138

<ref *1> Error: spawnSync C:\Program Files\nodejs\node.exe EPERM
<ref *1> Error: spawnSync git EPERM
AssertionError [ERR_ASSERTION]: 子进程未启动：spawnSync C:\Program Files\nodejs\node.exe EPERM
AssertionError [ERR_ASSERTION]: 镜像内门禁未能启动：spawnSync C:\Program Files\nodejs\node.exe EPERM
```

即：这 69 条**全部**是「测试自己要起子进程」的用例（CLI 退出码测试、镜像门禁测试、`--check` 解析测试…），在本沙箱里子进程起不来。归因**明确**：沙箱 `spawn EPERM`，与本片无关（且与 pristine baseline 同名同数，§4.4.2）。

#### 4.4.4 声明④：失败集合超出口径 40 的已知 8 条 ⇒ 逐条列出（69 条，按名排序）

```text
40 位 commit SHA 作来源版本 ⇒ exit 0
CLI 正例及反例：陈旧路由/文档失败，错误时不写表格，显式同步后通过
HTML 注释里的字段与来源不算数 ⇒ exit 1
Windows local password generator works with Framework RNG and retains independent 192-bit outputs
Windows redirected child exit codes survive waiting in both start and stop
`来源版本或提交：1048576` 这种裸 7 位十六进制不算版本 ⇒ exit 1
actual source CLI rejects pg overrides before any socket connection
allowlist 登记了已不存在的文件 ⇒ exit 1（白名单不得腐烂）
allowlist 登记非 gy-i03-* 的新文件（my-notes.md）⇒ exit 1
legacy 文件登记且未改动 ⇒ exit 0，并计入 legacy（CRLF 检出也认）
legacy 文件被改一个字节 ⇒ exit 1（哈希不一致）
miniprogram/utils/reference.js parses cleanly under ESM --check (no duplicate declarations)
staging own database profile rejects source DB and any pg URL options before sockets
「未取得」是 README 允许的取值，不作失败 ⇒ exit 0
两条 URL 只差 fragment（`#a`／`#b`）⇒ 算 1 条，exit 1
仓库真实 docs/research ⇒ exit 0（不许把既有记录打红）
反例1：删掉表格专用行（§4 正文/交叉引用仍写着该路径）⇒ 未索引 点名
反例2：覆盖计数被改（29/30、28/28）⇒ 计数不符
反例3：行内去掉 ✅ ⇒ 未索引 点名
反例4：把路径写成另一个在册文件 ⇒ 缺行 点名原路径
反例5：✅ 挪到该行中间列、核验列写 ❌ 未核验 ⇒ 未索引 点名
反向回归·索引页少一行在册记录 ⇒ 门禁转红并点名未索引（同一镜像不改则全绿）
合格的最短记录 ⇒ exit 0，并逐条打印 PASS 与统计
围栏代码块里的字段不算数 ⇒ exit 1（藏在 ``` 里不能免责）
围栏里藏额外来源、正文只有 1 条 ⇒ exit 1（来源不能靠围栏凑数）
多余参数 ⇒ exit 2（口径不明时不猜目录）
完整记录·七项写成列表形态 ⇒ exit 0
完整记录·七项写成表格且字段在第 2 列（`| # | 项 | 内容 |`）⇒ exit 0
完整记录·列表形态的七项全删 ⇒ exit 1（不得静默降级成最短记录）
完整记录·字段表在第 2 列且缺「引入成本」⇒ exit 1 且点名该字段
完整记录·技术段的七项与「检索来源」子标题一起删掉 ⇒ exit 1（不得降级成最短记录）
完整记录内「## 2 Fastify 检索证据」无字段 ⇒ exit 1（豁免词不得作子串命中）
实际 buildApp 注册清单与当前契约表一致；消息与社区均已接线
带「技术」列的总览表不参与按行来源计数 ⇒ exit 0
技术段标题恰好是「## 1 检索」且无字段 ⇒ exit 1（豁免只认整体等于结构性小节名）
技术段混入非七项字段名 ⇒ exit 1
按项来源：一项独占 4 条、另三项 0 条 ⇒ exit 1
按项来源：两项各 2 条、另两项 0 条 ⇒ exit 1（只报空的两项）
按项来源：四项技术各 1 条 URL（记录级总数 4）⇒ exit 1
文件名日期不是真实日历日期 ⇒ exit 1
文件名日期与正文检索日期不一致 ⇒ exit 1
最短记录的决定没有理由 ⇒ exit 1
最短记录缺「决定」⇒ exit 1
有 README 但一条记录都没有 ⇒ exit 2
未在 allowlist 登记的历史文件 ⇒ exit 1
正控制：镜像一字不改 ⇒ 门禁全绿，且计数确实被读到
段外独立的 `| 字段 | 含义 |` 表（七项齐全）⇒ exit 0
照抄 README §7 范例 ⇒ exit 0（范例必须真能过门禁）
目标目录不存在 ⇒ exit 2
空目录 ⇒ exit 2（路径写错不能静默通过）
索引·当前读数与文件系统一致（迁移/down/deploy 文件数）
紧邻 `commit` 标签的短 SHA 作来源版本 ⇒ exit 0
编号带点分隔符「## 1. Fastify」且无字段 ⇒ exit 1（不得因编号形状漏判）
缺少记录级字段「检索方式」⇒ exit 1
缺少记录级字段「检索日期」⇒ exit 1 且点名该字段
证据不得读取仓库外、私有目录、环境文件或指向外部的 junction
证据项指向真实存在的目录时必须受控失败（不得崩溃），改为常规文件后通过
语义正控制：夹具台账两臂通过，可核与不可核分开计数
语义正控制：真实台账 --write-doc 臂不改写文档
语义正控制：真实台账 plain 臂通过且零误报
语义负控制：两条操作区间互换，两臂都失败且不写盘
语义负控制：区间从上一操作起跨越两个注册块，两臂都失败且不写盘
语义负控制：区间指向同文件另一操作的注册块，两臂都失败且不写盘
语义负控制：区间放宽到整文件，两臂都失败且不写盘
语义负控制：区间落在另一操作的注册块内但未覆盖整块，两臂都失败且不写盘
语义负控制：片段换成同文件另一操作的断言原文，两臂都失败且不写盘
运行时清除继承配置/凭据与 NODE_OPTIONS；实际注册与静态不一致时不会假通过
门禁·离线核验工具实跑通过（退出码 0、无 FAIL）
页面·记录就绪前与空草稿 ⇒ 零 PATCH、零轮次请求（未明确确认不外发）
```

### 4.5 `npm run test:integration:http`（**未取得**，权威替代＝PR 自身 CI）

```
npm run test:integration:http        （1 次尝试，不重试）
… 第 1–8 段顺序执行 …
PASS 9 loopback HTTP groups; actual client; synthetic identity/data/server; no production API or PG claim
PASS 11 groups; source_kind=synthetic; memory store; not WeChat/device/native PG evidence
PASS 组数=30，FAIL 组数=0
PASS PGlite, serialized limited SET ROLE; …
PASS GY-I09 loopback HTTP integration (synthetic identity + stub provider + memory store)
PASS 15 loopback HTTP groups; …
PASS favorites-history-isolation-http; …
== GY-I10 阶段 2b 真实装配 + 回环 HTTP 集成回归 ==
  PASS 1) createOCR 202 + JobEnvelope/Job 形状 + … （ocr-http 自身 11 条 PASS 全部打印）
…
AssertionError [ERR_ASSERTION]: 经 direct 真装载 OCR 域模块 ⇒ r7 主判据必须判红（exit=1），实际 null；null !== 1
    at file:///…/tests/integration/ocr-http.mjs:1846:14
  actual: null   expected: 1   operator: 'strictEqual'
EXITCODE=1（199 行日志）
```

**失败点与根因（逐字核对源码）**：`tests/integration/ocr-http.mjs:1828` 是

```
const probe = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--registry-probe=${form.id}`], { encoding: 'utf8' });
```

——`encoding: 'utf8'` 即管道 stdio ⇒ 本沙箱 `EPERM` ⇒ `probe.status === null` ⇒ `:1846` 的 `assert.equal(probe.status, 1, …)` 红。该行是**上游既有代码**，本片对 `tests/integration/**` 零改动（§8）⇒ 与本片无关。

**权威替代读数**：`npm run test:integration:http` 的真红/真绿以本片 PR push 后 GitHub Actions 上 `engineering-shell.yml` 的 `integration-http` job 为准（本机不再重试）。

### 4.6 文档校验

```
python tools/validate_development_docs.py
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
```

（直跑 `python`：`node tools/run-python.mjs` 在本机经子进程 ⇒ `EPERM`，故不走它。）

### 4.7 YAML 自检（**未取得解析级校验**）

本机**没有** YAML 解析器，逐个确认：

```
python -c "import yaml"                    → ModuleNotFoundError: No module named 'yaml'
Get-Command actionlint / yamllint / ruby    → 全部为空
node -e "require('yaml') / require('js-yaml')" → MODULE_NOT_FOUND
```

⇒ 记「**未取得（无 YAML 解析器）**」。替代做法两条，**都不声称是解析级校验**：

1. **人工逐行核对**：78 行全文按缩进逐行读过（`name/on/permissions/jobs/services/steps` 层级、`options: >-` 折行块、`ports` 行内数组、`env` 块、注释行不破坏缩进）。
2. **文本级形状检查**（`.pg17/tmp/real-pg-ci/yaml-shape-check.mjs`，⛔ 不进仓库）：断言 16 个关键键逐字存在（`image: postgres:17.11`、`ports: ['5432:5432']`、`--health-cmd pg_isready`、两个 `actions/*@<40 位 SHA>`、两条 `psql … && node …`）、无 tab、缩进全为 2 的倍数、无行尾空格、单换行结尾、无 `U+FFFD`：

```
PASS .github/workflows/real-pg-integration.yml: 关键键齐全 / 无 tab / 缩进全为 2 的倍数 / 无行尾空格 / 单换行结尾
（文本级形状检查，非解析级校验：本机无 actionlint、无 PyYAML、无 js-yaml）
```

### 4.8 `git diff --check` 与 `git status`

```
git add -A
git diff --check HEAD      → 0 行输出，EXITCODE=0（只查本片 3 个新文件；README 的 168 行存量噪声不在其中）
git status --porcelain     → 0 行（提交后）
git diff --stat HEAD       → 3 files changed（见 §8）
```

`git diff --check` 必须对 **`HEAD`**（已暂存）跑：只跑未暂存的 `git diff --check` 会**静默放过一个新文件里的行尾空格**。

### 4.9 串行锁（**未取得**）

`.pg17/tmp/hq/gate.lock`（目录，`owner.txt` 只有一行 `2026-10-20T08:41:08`）在开工前已被**另一执行者**持有；本片按追加指令最多等 6 分钟、每 20 秒重试：

```
attempts=18 acquired=False at=2026-10-20 08:55:02
```

⇒ 记「**未取得（未获串行锁，等锁 6 分钟）**」。⛔ 未删除他人锁。开工前后台 `Get-Process node` 计数为 **0**（确认没有别人在跑端口型门禁）⇒ §4.4 的降级单测与 §4.5 的集成链**都是在「未持锁」状态下跑的**，读数旁已标注。

## 5 未取得项（如实登记，不伪造通过）

| 项 | 内容 | 现状 | 所需前置 | 为什么本片不解决 |
| --- | --- | --- | --- | --- |
| 真库 workflow 的真红/真绿 | `real-pg-integration.yml` 在 GitHub Actions 上真的起 PG17.11、真的跑通两个脚本 | **未取得**：本机无容器运行环境（无 Docker），且子进程 EPERM | 把本片推到 PR，读该 PR 的 Actions run | 派单已把此项划给「PR 自身 CI 读数」；本机只做静态断言与 YAML 自检 |
| YAML 解析级校验 | actionlint / PyYAML / js-yaml 三者皆无 | **未取得（无 YAML 解析器）** | 装任一解析器或 actionlint | 派单 §3.5 明确「如实登记未取得」；已用人工逐行 + 文本级形状检查替代并标注 |
| 全量单测的默认隔离跑法 | `node --test "tests/unit/*.test.mjs"`（逐文件子进程） | **未取得（沙箱 spawn EPERM）** | danger-full-access 沙箱或非 confined 环境 | 沙箱口径所限；已用降级跑法 + pristine baseline 逐条比对归因（§4.4） |
| `npm run test:integration:http` | 13 段全绿 | **未取得（第 8 段在 `ocr-http.mjs:1846` 的子进程探针上 EPERM）** | 同上 | 同上；权威替代＝PR 的 CI 读数 |
| 串行门禁锁 | `.pg17/tmp/hq/gate.lock` | **未取得（未获串行锁，等锁 6 分钟，18 次尝试）** | 等持有者释放 | ⛔ 不得删他人锁；已在读数旁标注「未持锁」 |

## 6 与 `#312` 口径的衔接

`#312`（`607c03c`）做了两件事：① `tests/unit/integration-script-coverage.test.mjs` 的「整链跳过必须给 77」守卫；② 判类**刻意收窄**，把 `*-pg.mjs` 排除在「必接线集合」之外（理由：需要真实 PG，进了无库链只会永红）。本片是把那条**被收窄掉的边界补上**的一条：

- `#312` 说「`*-pg.mjs` 不该进**无库**链」——本片同意，并且**没有**把它们塞进 `test:integration:http`；
- 但「不进无库链」不等于「可以没有门禁」。本片给这两条脚本单开了一个**带库**的 workflow，并用第三条判据把「真库 service 必须存在且是 17」钉住；
- 也就是说：`#312` 管「跳过不许冒充通过」，本片管「真库臂必须真的被跑、且缺库时必须红」——两条是**同一方向上的相邻门禁**，不互相替代。

顺带一条**如实记录的文档陈旧**（本片按派单红线**未改**）：`tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS` 里，`community-pg.mjs` 与 `conversations-pg.mjs` 两条 `reason` 仍写着「本片未新增对应 CI workflow（如实登记为未取得项）」。本片落地后这句话**已经过时**（现在有 workflow 了），但派单明令「⛔ 不动 `FROZEN_CHAIN`／`UNWIRED_DECLARATIONS`／既有守卫断言」，故留作后续片的最小改动项（只改 reason 文本，不动任何断言）。

## 7 遗留（非阻塞，供下一片取）

1. **两条 `reason` 文本更新**（§6 末段）：`ci-integration-chain-structure.test.mjs` 里那两行 `reason` 改成「由 `.github/workflows/real-pg-integration.yml` 用独立测试集群运行」。属于文案，不涉及断言。
2. **其它 `-pg.mjs` 的真库臂**：`account-deletion-pg`／`account-suspend-pg`／`admin-flags-pg`／`favorites-history-pg`／`messages-pg` 目前同样「无 npm、无 CI」（见 `docs/verification/gy-i23-integration-script-coverage-20261020.md` §7）。本片的 workflow 是**可复制的范式**：加一条脚本＝在 `MANAGED_SCRIPTS`／`FROZEN_MANAGED_SCRIPTS` 各加一行 + 加一个「建专用空库 + 真跑」step。
3. **`e2e-*`／`user-chain-e2e.mjs`**：它自建一次性 `initdb` 集群，需要 PG 二进制而不是 service 容器，属于另一种接线形状，不在本片判类内。

## 8 改动面（本片只新增 3 个文件）

```
git diff --stat df043a7 HEAD  （提交后实测，逐字）
 .github/workflows/real-pg-integration.yml   |  78 +++++
 docs/verification/gy-real-pg-ci-20261020.md | 427 ++++++++++++++++++++++++++++
 tests/unit/ci-real-pg-wiring.test.mjs       | 409 ++++++++++++++++++++++++++
 3 files changed, 914 insertions(+)

git status --porcelain        → 0 行
```

`services/**`、`packages/**`、`apps/**`、`miniprogram/**`、`tests/integration/**`、`package.json`、`README.md`、既有 `.github/workflows/*.yml`、迁移、契约 —— **全部 0 行改动**。

**零残留自证**：所有临时物只落在仓外 `.pg17/tmp/real-pg-ci/`（workflow 备份与变异脚本、基线检出、三份日志、YAML 形状检查器），⛔ 一件都没进仓库；本片未在工作树内递归删除任何东西，也未创建任何 `node_modules` 联接（基线检出是独立 `npm ci`）。
