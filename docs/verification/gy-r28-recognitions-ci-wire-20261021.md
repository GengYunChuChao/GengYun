# GY-R28-S36 识别域持久化脚本接进真库门禁（第 9 个 `-pg` 脚本，空库 + 自跑「除 0025 外全部 → 0025」）

- 切片：S36（R28 第五批）。起因：监工在 `#347` 批复指出 `tests/integration/recognitions-pg.mjs` **不在任何 workflow**
  ⇒ 「16 项 CI 成功」**不能**证明它跑过真库。本片只做接线，不改脚本本体（脚本归 `#333`／`#336`）。
- 分支：`test/gy-r28-recognitions-ci-wire`；基线 `693af5d5bf7a102e1bf84d0704bf4e8fb5743419`（= `upstream/main` 顶端）。
- 日期：2026-10-21（本机实测时间）。
- 环境：Windows / **PowerShell 5.1** / Node **v24.16.0**（`package.json` engines `>=24.16.0 <25`）/
  PostgreSQL **17.11** 本机二进制（`PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit`，`E:\GengYunCommander\.pg17\pgsql\bin`）。
- 集群：本片**自己起一个**（不碰本机既有集群）：
  - `:55647`，datadir `E:\GengYunCommander\.pg17\data-r28s36`
  - `initdb -D … -U gengyun_ci_owner`（**超级用户就叫 `gengyun_ci_owner`**，与 `real-pg-integration.yml` 的 `POSTGRES_USER` 同名）
  - 用 `Invoke-CimMethod -ClassName Win32_Process -MethodName Create` 起 `postgres.exe -D … -p 55647 -c listen_addresses=127.0.0.1`
    ⇒ ⛔ **没有**用 `pg_ctl start`
  - `host all all 127.0.0.1/32 scram-sha-256`；口令 `synthetic-ci-owner-only`（与 workflow 的 `POSTGRES_PASSWORD` 逐字一致）。
    实证 scram 生效：同一 URL 换错口令 ⇒ `FATAL: password authentication failed for user "gengyun_ci_owner"`（psql exit 2）。
- 铁律（本片执行口径）：**先在本机真跑出 exit=0 才接线**；**没有**改脚本一个字节；**没有**动 `services/**`；**没有**加迁移；
  **没有**用 `--allow-skip`／`GY_ALLOW_SKIP` 把 77 洗成 0；**没有**加 `continue-on-error`／`if:`／`|| true`。

---

## 1 结论

一条：`tests/integration/recognitions-pg.mjs` 从「脚本在 main、却没有任何 job 跑过」变成 `real-pg-integration.yml`
里的**第 9 个真库脚本 step**（同一 job `real-pg-17-11` 内，`L162`；该 job 的 `- run:` 共 10 个：1 个 `npm ci` + 9 个真库脚本）。

| 项 | 事实 |
| --- | --- |
| 接线前 | `693af5d` 上 `git grep -n -i recogniti 693af5d -- .github/workflows` ⇒ **0 命中，exit 1**；该文件 `CREATE DATABASE` step 计数 **8** ⇒ 它在任何 workflow 里都没有被跑过 |
| 连接串来源 | **只认环境变量 `RECOGNITIONS_PG_TEST_URL`**（脚本 `:41`），无 argv 入口 ⇒ step 里必须用 `env:` |
| 库名 | 硬钉 `gengyun_recognitions_test`（脚本 `:42` `const DB`；`:63` 断言 `url.pathname === '/gengyun_recognitions_test'`）⇒ step 里 `CREATE DATABASE` 就是该库 |
| 库前摇 | **空库**：脚本 `:653-654` 自己断言 `public` 表数 = 0（非空库直接红并提示 `请先 createdb 一个干净的库`）⇒ 与既有 8 步同形：`psql -c 'CREATE DATABASE …' && node …` |
| 缺前置语义 | 未设 env ⇒ 打印 `SKIP real PG17 …` 并 **exit 77**（`:49-57`）⇒ **缺库必红**，77 不是通过 |
| 迁移面 | 脚本自己 `discoverMigrations()`（`:270`）后跑「除 `0025_recognitions_persistence.sql` 外全部迁移」，再应用 0025；并断言 `1..max` 连续无缺号（`:276`）、`count === max`、清单含 0025 ⇒ 本 step **顺带守住迁移清单不变量** |
| 角色面 | 脚本只用**一个 owner 连接串**，**从不 `CREATE ROLE`** ⇒ 本 step 既不建角色、也不需要额外角色（§5 把「裸集群失败」的根因钉死） |
| 守卫 | `tests/unit/ci-real-pg-wiring.test.mjs` 受管清单 **8 → 9**，`MANAGED_SCRIPTS`（`:61`）与 `FROZEN_MANAGED_SCRIPTS`（`:73`）两处逐字同步 |

`real-pg-integration.yml` 末尾新增（`L156`–`L169`，与 `ocr-jobs` step 同构）：

```yaml
      # 识别域持久化（#333 / I10，R28-S36）：库名硬钉 `gengyun_recognitions_test`，脚本同样要求**空库**
      # （第一步断言 `public` 下 0 张表）。它自己 `discoverMigrations()` 后先跑「除 0025 外全部迁移」再应用 0025，
      # 并断言迁移清单连续无缺号、总数 === 最大编号 ⇒ 顺带守住迁移清单不变量（与 ocr-jobs step 同构）。
      # 连接串只走 **env**（`RECOGNITIONS_PG_TEST_URL`，脚本按属主身份连库、自己从不建角色）：
      # 未设时脚本打印 SKIP 并以 77 退出 ⇒ 缺库必红（77 不是通过，也不加任何吞红开关）。
      # 本地取证（PG 17.11 + 空库 + `gengyun_ci_owner` 属主）：exit=0，`共 30 条 PASS，耗时 1777ms`。
      - run: psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_recognitions_test' && node tests/integration/recognitions-pg.mjs
        env:
          PGHOST: 127.0.0.1
          PGPORT: '5432'
          PGUSER: gengyun_ci_owner
          PGPASSWORD: synthetic-ci-owner-only
          PGDATABASE: gengyun_ci_bootstrap
          RECOGNITIONS_PG_TEST_URL: postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:5432/gengyun_recognitions_test
```

---

## 2 本机同形取证（真跑读数，exit 0）

**先建空库、再跑脚本**（CI 里是同一条 `&&` 链；本机 PowerShell 5.1 不支持 `&&`，故分两步，语义等价）：

```powershell
$psql = 'E:\GengYunCommander\.pg17\pgsql\bin\psql.exe'
$env:PGPASSWORD = 'synthetic-ci-owner-only'
& $psql -h 127.0.0.1 -p 55647 -U gengyun_ci_owner -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS gengyun_recognitions_test WITH (FORCE)'
& $psql -h 127.0.0.1 -p 55647 -U gengyun_ci_owner -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_recognitions_test'
# 空库读数（与脚本 :653 同一条 SQL）
& $psql -h 127.0.0.1 -p 55647 -U gengyun_ci_owner -d gengyun_recognitions_test -t -A -c "select count(*) from pg_tables where schemaname='public'"
$env:RECOGNITIONS_PG_TEST_URL = 'postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:55647/gengyun_recognitions_test'
node tests/integration/recognitions-pg.mjs
```

| 读数 | 值 |
| --- | --- |
| 空库断言（`pg_tables` where `schemaname='public'`） | **0** |
| 脚本自报 | `共 30 条 PASS，耗时 1777ms` + `ALL PASS：识别域 PostgreSQL 持久化（迁移 0025 三连 + 未迁移三态 / 13 方法语义 / 关连接重开逐字节仍在 / 4 条负控制）` + `EXITCODE=0` |
| 进程 exit code | **0**（`cmd /c` 直取；整轮 wall clock 2698ms，含 Node 启动） |
| PASS 条数 | **30**（含 `[M0]` 结构不变量、`:656` 迁移三连 UP/ROLLBACK/REPLAY、`[R1]-[R4]` 关连接重开＋子进程重启臂、`[N1]-[N4]` 负控制） |
| 日志 | `E:\GengYunCommander\.pg17\handoff\r28-s36-logs\06-local-realpg-recognitions.log` |

同一集群上另跑了一次「不设 env」的对照（证明 77 语义，不是静默绿）：

```
SKIP real PG17: RECOGNITIONS_PG_TEST_URL 未设置 —— 本次运行没有验证真库持久化（不是通过，也不是失败）。
EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；…）。
```

⇒ 进程 exit code = **77**（日志 `07-local-skip-77.log`）。CI 里库是先建好的，所以这个 77 只会在「库/step 被删」时出现，
即**缺库必红**。

---

## 3 「有 roles 的集群成功、裸集群报 `识别数据库暂不可用`」的根因（已实证，非推测）

**根因一句话**：差别不在脚本，也不在「有没有 roles」，而在**集群里有没有 `gengyun_ci_owner` 这个角色**。
`postgres:17.11` service 用 `POSTGRES_USER: gengyun_ci_owner` 会把该角色建成超级用户；而裸 `initdb`（不带 `-U`）只把
**当前 OS 用户**（本机 `MR`）建成超级用户，`gengyun_ci_owner` 根本不存在 ⇒ 脚本一连接就 `28000`。

复现（另起一个裸集群，`:55648`，datadir `.pg17\data-r28s36-bare`，`initdb` **不带** `-U`，`trust` 认证）：

| 步骤 | 读数 |
| --- | --- |
| 裸集群超级用户 | `MR`（OS 用户）；`pg_roles` 里**没有** `gengyun_ci_owner` |
| 以 `gengyun_ci_owner` 连 | `psql: error: … FATAL: role "gengyun_ci_owner" does not exist` |
| 直连驱动码（探针 `pool.query('SELECT 1')`） | `RAW_QUERY_DRIVER_CODE=28000`，`RAW_QUERY_DRIVER_MESSAGE=role "gengyun_ci_owner" does not exist` |
| 走识别 store 读面（探针 `store.getJob(randomUUID())`） | `STORE_ERROR_NAME=ApiError`、`STORE_ERROR_CODE=PROVIDER_UNAVAILABLE`、`STORE_ERROR_MESSAGE=识别数据库暂不可用`、`STORE_ERROR_RETRYABLE=true` |
| 裸集群直接跑脚本本体 | exit **1**，未捕获的 `FATAL … role "gengyun_ci_owner" does not exist`（28000）——**loud fail，不是 skip** |
| 对照组：同形集群 `:55647` 跑同一探针 | `RAW_QUERY_OK rows=1`、`STORE_READ_OK value=null`（正常，读未命中） |

即：`识别数据库暂不可用` 是 `store-pg.ts` 的错误折叠把驱动错误（`28000`/`28P01`/`42501`/`3D000` 这类）
归类成 `PROVIDER_UNAVAILABLE` 的结果；触发条件是**集群角色/口令与 URL 不匹配**，不是脚本要 roles。
脚本自己从不建角色，也不需要 owner 之外的任何角色 ⇒ **CI 不需要补 roles 步骤**，本片也没有加。
探针文件在仓库外（`.pg17`），用完即删，未污染工作树；日志 `probe-bare.log` / `probe-cishape.log`。

---

## 4 负控制（由绿变红，恢复后 sha256 逐字节相等）

做法：把新 step 的 `run:` 里的 `node tests/integration/recognitions-pg.mjs` 换成一句不执行脚本的 `printf`，跑守卫，再还原。

| 项 | 读数 |
| --- | --- |
| 改动前 sha256 | `CC3F2439677B8CF2B608101021D1B2371B63C309602574EC114BF3605E2DC76A` |
| 守卫结果 | `✖ 前向①：两个受管真库脚本都被某个 workflow 的 run: 真跑` ⇒ **红**，点名 `tests/integration/recognitions-pg.mjs`；同轮 4 fail / 8 pass |
| 还原后 sha256 | `CC3F2439677B8CF2B608101021D1B2371B63C309602574EC114BF3605E2DC76A`（**与改动前逐字节相等**） |
| 还原后守卫 | **19/19 pass，exit 0** |

> 反方向（workflow 跑了但清单没登记 ⇒ 红）在基线版本里**没有**这条判据，只有 `#332` 的重写版加了「判据⑨双向相等」。
> 本片按 `#332` 的新结构做适配的位置见 §6。

---

## 5 门禁读数（本片收尾时实跑）

| 门禁 | exit | 读数 |
| --- | --- | --- |
| `npm run lint` | **0** | `PASS tsc --noEmit services/api/tsconfig.json`／`PASS tsc --noEmit apps/admin/tsconfig.json`／`PASS 仓库卫生扫描`／`lint 通过` |
| `npm run test:contract` | **0** | `tests 6 / pass 6 / fail 0` |
| `node --test --test-concurrency=1 tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` | **0** | `tests 19 / pass 19 / fail 0`（含结构门禁 6 条子测试 + 真库接线守卫前向①–④ 与 7 组反向控制） |
| `npm run test:docs` | **0** | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables`／`研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住`／`PASS docs/research 结构校验` |
| `node tools/verify-release-materials.mjs` | **0** | `15/15 项通过（离线文档核验；不代表部署、云端或运行期已验收）` |

日志：`.pg17\handoff\r28-s36-logs\01-lint.log`、`02-contract.log`、`03-unit-wiring-chain.log`、`04-docs.log`、`05-release-materials.log`。

---

## 6 与 `#332`（`tests/unit/ci-real-pg-wiring.test.mjs` 重写）的适配面

`#332` 的 head `714475b` 是「merge `upstream/main` 693af5d」后的重写版（1418 行），新增判据⑥⑦⑧⑨。
本片对**基线版**（964 行）只做最小改动：`MANAGED_SCRIPTS`（`:61`）＋`FROZEN_MANAGED_SCRIPTS`（`:73`）各追加一条，
外加 `:45`–`:46` 两行文档注释。若 `#332` 先合入，本条落到重写版上**只需再同步第三个数组**、不改结构：

| 位置（`714475b` 版） | 需要追加的内容 | 理由 |
| --- | --- | --- |
| `MANAGED_SCRIPTS`（`:65`） | `'tests/integration/recognitions-pg.mjs'` | 判据⑦⑨以它为准 |
| `FROZEN_MANAGED_SCRIPTS`（`:76`） | 同上 | 冻结清单与清单集合必须相等 |
| `REQUIRED_STEP_ORDER`（`:109`） | 同上，放在**末尾**（= workflow 里的执行顺序） | 判据⑤要求二者同集合且顺序等于 workflow 实际顺序 |

其余判据在**不改代码**的情况下自动满足：

- **判据⑦双向相等**：workflow 真跑的 `-pg.mjs` 集合 = 清单集合（9 = 9）。
- **判据⑧建库/库名三形态一致**：`run:` 里 `CREATE DATABASE gengyun_recognitions_test` 在 `node` **之前**；
  库名的三个来源同一：env `RECOGNITIONS_PG_TEST_URL` 的 path（`databaseNameOfUrl`）／argv（本 step 无）／
  脚本硬钉常量 `const DB = 'gengyun_recognitions_test'`（`recognitions-pg.mjs:42`，命中 `pinnedDatabaseNames` 的写法 ①）。
- **判据⑥顺序**：本 step 是 job 里最后一个真库 step，追加到 `REQUIRED_STEP_ORDER` 末尾即一致。

⇒ 冲突部位就是这三处数组（加上我那 2 行文档注释，可能因上下文行号变化产生 trivial hunk）。
rebase 口径：**保留 `#332` 的重写结构 + 追加本片这三条**，不把文件退回基线版。

**另一处必然冲突**：`tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS` 里
`recognitions-pg.mjs` 那条 `reason`（本片改在 `:190`–`:194`）——`#332` 也改了**同一条目的同一段文案**。
本片**保留**自己的文案改动（它是接线后的事实），因此：

- 若本片先合：`#332` rebase 时在这一段按「已接 `real-pg-integration.yml`、仍不进无 PG 回环链」合并即可；
- 若 `#332` 先合：本片需要一次**纯合流**（只解这一段文案冲突，不改任何断言、不改条目去留）。

条目**不能删**：`ci-integration-chain-structure.test.mjs` 断言 4 要求「`tests/integration` 下既未进 http 链的脚本必须显式声明」，
删条会让该门禁变红；这与 `ocr-jobs-pg.mjs` 的登记形态一致（接了真库 job，但仍如实登记为未进无 PG 回环链）。

---

## 7 我没做到的取证（如实登记）

1. **没在 GitHub runner 上跑过**：本机是 Windows + 本机 PG 17.11 二进制，不是 `ubuntu-latest` + 容器 `postgres:17.11`。
   本片**不宣称**「已在 GitHub runner 跑过」，也不宣称该 job 变绿；runner 上的首跑读数只能等推送后由 CI 给出（本片不 push、不建 PR）。
2. **没有本地 YAML 解析器核验**：仓库依赖里没有 `yaml`／`js-yaml`（`node -e require('yaml')` ⇒ `MODULE_NOT_FOUND`；
   `python -c import yaml` ⇒ `ModuleNotFoundError`），派单禁止新增依赖 ⇒ 我只能核对「无制表符、缩进与相邻 step 逐字同形、
   守卫测试能按文本判据找到该 step 及其 `env:`」；**整份 workflow 的 YAML 合法性未经本机解析器验证**，留给 CI 首次解析确认。
3. **反方向守卫**（workflow 跑了但受管清单没登记 ⇒ 红）本基线版没有，只有 `#332` 的判据⑨；本片**没有**为它另写断言（避免与 `#332` 抢同一文件）。
4. **没跑全量套件**：只跑派单 §5 的五道门禁；`test:unit`／`test:integration:http` 等未跑（本片不触碰 `services/**`，也不改 http 链）。
5. **脚本自身的「未取得」项**（HTTP 面重启不丢、多进程压测、真实模型落库、备份恢复、历史保留策略）仍是未取得，与本片无关；
   本片只把「它在真库上 exit 0」这件事变成 CI 每次都会重做一遍。
