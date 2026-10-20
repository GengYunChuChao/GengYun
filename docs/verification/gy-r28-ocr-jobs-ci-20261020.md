# GY-R28-S17 标签 OCR 域接进真库门禁（第 8 个 `-pg` 脚本，跑全链迁移 0001..0024）

- 切片：S17（R28 第四批「已在 main、却没有任何 workflow 跑过」的真库脚本接线）
- 分支：`test/gy-r28-ocr-jobs-ci`（based on `upstream/main = 412297636141562653ecbaa6b3fbbfecb05ecdd4`，
  即 `#327` 合入后的 HEAD）
- 日期：2026-10-20（本机实测时间）
- 环境：Windows / PowerShell 7 / Node **v24.16.0**（`package.json` engines `>=24.16.0 <25`）／
  PostgreSQL **17.11** 本机二进制（`E:\GengYunCommander\.pg17\pgsql\bin`）
- 集群：本片**自己起一个**，不碰本机既有集群（55460/55461 属他人）
  - **`:55617`**，datadir `E:\GengYunCommander\.pg17\data-r28s17`
    （`postgres.exe -D … -p 55617 -c listen_addresses=127.0.0.1 -c logging_collector=on`，
    由 `Invoke-CimMethod Win32_Process Create` 起，**没有**用 `pg_ctl start`）
  - 取证分两段：先 `trust` 集群跑出「能不能绿」（`postgres` 连），再**改成 scram 等价形态**重跑——
    `initdb` 之后把 `host all all 127.0.0.1/32` 改成 `scram-sha-256` 并 `pg_reload_conf()`，
    建超级用户 `gengyun_ci_owner` / `synthetic-ci-owner-only`（与 `real-pg-integration.yml` 的
    `POSTGRES_USER`／`POSTGRES_PASSWORD` **逐字一致**），空库由它属主 `CREATE DATABASE`
    ⇒ 这一份读数才与 `postgres:17.11` service 等价（下文第 2 节贴的就是这一份）
- 铁律（本片执行口径）：**先在本机真跑出 exit=0 才接线**；**没有**改被测脚本一个字节、
  **没有**动 `services/**`、**没有**加迁移、**没有**用 `--allow-skip`／`GY_ALLOW_SKIP` 把 77 洗成 0。

---

## 1 结论

一条：`tests/integration/ocr-jobs-pg.mjs` 是本片之前**唯一**「脚本在 main、却没有任何 job 跑过」的
真库脚本（另两个候选 `account-suspend-pg`／`backup-purge-pg` 已在 R28-S14 判「不接」并留证据）。
本片把它接成 `real-pg-integration.yml` 的**第 8 个真库脚本 step**
（该 job 里 `- run:` 一共 9 个：`L65 npm ci` ＋ 8 个真库脚本；本步是第 9 个 `- run:`，`L148`）。

| 项 | 事实 |
| --- | --- |
| 连接串来源 | **只认环境变量 `OCR_PG_TEST_URL`**（脚本 `:43`），无 argv 入口 ⇒ step 里必须用 `env:` |
| 库名 | 硬钉 `gengyun_ocr_jobs_test`（脚本 `:44/:73` 断言 `url.pathname === '/gengyun_ocr_jobs_test'`）⇒ step 先 `CREATE DATABASE` 该库 |
| 库前提 | **空库**（脚本自己断言 `public` 下 0 张表）⇒ 与既有 7 步同形：`psql -c 'CREATE DATABASE …' && node …` |
| 缺前置语义 | 未设 `OCR_PG_TEST_URL` ⇒ 打印 `SKIP` 并 **exit 77**（`:61-63`）⇒ **缺库必红**，不是通过 |
| 迁移面 | 跑**全链** `discoverMigrations()`（0001..0024），**不是子集**；本步因此顺带守住脚本 `[M0]` 的「迁移清单连续无缺号、`count === max`、末位 = `0024_ocr_persistence.sql`」 |
| 守卫 | `MANAGED_SCRIPTS`／`FROZEN_MANAGED_SCRIPTS` **7 → 8**，两处逐字同步 |

**注意本步与既有 `admin-accounts-read`／`admin-flags` 步的差别**：那两步依赖 R28-S14 在同一 job 里
先建好的运行时角色 `gengyun_api_runtime`；本步**不依赖任何角色**，只用一个 owner 连接串，
所以它的位置在末尾不影响任何前序 step 的假设（既有三步的既有顺序一字未动）。

---

## 2 真跑取证（scram 等价集群 + CI 同形凭据，exit 0）

命令与环境变量（⚠️ 刻意与 workflow 里那个 step 的 `env:` 同源）：

```powershell
$env:OCR_PG_TEST_URL = 'postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:55617/gengyun_ocr_jobs_test'
node tests/integration/ocr-jobs-pg.mjs
```

跑前空库确认（`gengyun_ocr_jobs_test`，属主 `gengyun_ci_owner`）：

```
     0
```

输出首行（`[M0]` 结构不变量，本步顺带守住的那条）：

```
PASS 1: [M0] 结构不变量：迁移 24 个（0001..0024），
       连续无缺号；count === max；末位 = 0024_ocr_persistence.sql
PASS 2: [M1] 0001..0023 已应用：ocr_* 三表全部不存在，users 在岗
PASS 3: [M2] UP：三表 + 三索引 + state CHECK 在岗 + 2 条 CASCADE 外键全部出现
```

输出末几行原文：

```
PASS 25: [N2] 负控制：同一序列在内存 store 上，新实例读不到任务与记录（改前"重启即丢"的缺陷本体，可复现）
PASS 26: [N3] 负控制：同一 revision 并发双写 ⇒ 恰好 1 次成功、库内 revision=2（若 CAS 退化为先查后写，本臂会出现 2 次成功）
PASS 27: [N4] 负控制：同 id 并发/重复写由主键裁决 ⇒ 行数恒为 1

共 27 条 PASS，耗时 2294ms
ALL PASS：OCR 域 PostgreSQL 持久化（迁移 0024 三连 / 12 方法语义 / 关连接重开逐字节仍在 / 4 条负控制）
未取得 HTTP 面的"重启不丢"：real 模式真实 OCR 提供者/媒体端口未接线 ⇒ POST /ocr 受理前即 503，无法经 HTTP 建任务；本片证据在 store 层 + 迁移层 + app.ocrService 读面
未取得 多进程并发写同一任务的压测：本片只做两路并发 CAS（恰好一次成功），未做 20+ 并发的吞吐/延迟读数
未取得 真实标签 OCR 模型输出落库：模型调用未接线；本片用契约合法的手工字段验证持久化，不伪造模型准确率
未取得 备份恢复演练：本片只验证单库迁移 UP/ROLLBACK/REPLAY 与关连接重开，未做 pg_dump/pg_restore 演练
```

- **`EXITCODE=0`**，`PASS` 计数 **27**（trust 集群首轮同为 27 条，耗时 1600ms）
- 同一条命令在**未设** `OCR_PG_TEST_URL` 时（本机实跑）：

```
SKIP real PG17: OCR_PG_TEST_URL 未设置 —— 本次运行没有验证真库持久化（不是通过，也不是失败）。
EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。
```

  **`EXITCODE=77`** ⇒ 这个 step 在 CI 上**缺库/漏传 env 一定是红的**，没有第二条出口。
- 原始输出落盘：`E:\GengYunCommander\.pg17\handoff\ocr-jobs-scram.log`（scram 等价）／
  `…\ocr-jobs-pre.log`（trust 首轮）

---

## 3 接线改动面

只动四类文件（派单允许的四类），共 4 个文件：

| 文件 | 改动 |
| --- | --- |
| `.github/workflows/real-pg-integration.yml` | 追加 1 个 step（`L143-155`：5 行注释 + 8 行 step，即 `run:`／`env:`／6 个 `KEY: value`）；顶部「缺前置 ⇒ 77」那句括号里补「标签 OCR 域」（`+14/−1`） |
| `tests/unit/ci-real-pg-wiring.test.mjs` | `MANAGED_SCRIPTS`／`FROZEN_MANAGED_SCRIPTS` 各 **+1**（7 → 8）；文档注释补第 8 条来源 |
| `tests/unit/ci-integration-chain-structure.test.mjs` | `ocr-jobs-pg` 的 `UNWIRED_DECLARATIONS` **reason 改成如实**（条目保留，未删） |
| `docs/verification/gy-r28-ocr-jobs-ci-20261020.md` | 本证据页 |

workflow 新增段原文（**照抄既有 step 的写法**：库名硬钉 `CREATE DATABASE` ＋ `&& node <脚本>`，
`env:` 只放 `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` 五行既有风格，连接串本身走脚本约定的 env）：

```yaml
      # 标签 OCR 域（#323 / I10，R28-S17）：库名硬钉 `gengyun_ocr_jobs_test`，脚本同样要求**空库**
      # （自己断言 `public` 下 0 张表），并用 `discoverMigrations()` 跑**全链迁移**（0001..0024，含本片的
      # 0024）而不是子集——因此它顺带守住「迁移清单连续无缺号、总数 === 最大版本号、0024 仍在末位」。
      # 连接串走 **env**（`OCR_PG_TEST_URL`）：未设时脚本打印 SKIP 并以 77 退出 ⇒ 缺库必红（77 不是通过）。
      # 本地取证（PG 17.11 + 空库）：exit=0，`共 27 条 PASS`（含关连接重开逐字节仍在 + 子进程重启臂）。
      - run: psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_ocr_jobs_test' && node tests/integration/ocr-jobs-pg.mjs
        env:
          PGHOST: 127.0.0.1
          PGPORT: '5432'
          PGUSER: gengyun_ci_owner
          PGPASSWORD: synthetic-ci-owner-only
          PGDATABASE: gengyun_ci_bootstrap
          OCR_PG_TEST_URL: postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:5432/gengyun_ocr_jobs_test
```

两处形态选择的理由（都有事实支撑，不是偏好）：

1. **连接串走 `env:` 而不是像 `messages/deletion/admin-*` 那样回显成 argv。** 那四个脚本的契约是
   `node <脚本> <ownerUrl> [runtimeUrl]`（argv[2]），所以它们的 step 必须把 URL 写在命令行上；
   `ocr-jobs-pg.mjs` 的契约**只读环境变量**（`:43 const ENV = 'OCR_PG_TEST_URL'`），写 argv 它不认。
   反过来，`conversations/community/favorites-history` 三个 step 的形态就是 `psql … && node <脚本>` 不带 URL，
   本步与它们**完全同形**，只是多一行 `OCR_PG_TEST_URL`。
2. **`run:` 用单行 `cmd && cmd` 而不是 `run: |` 多行。** 既有 7 步全是单行（`&&` 保证 `CREATE DATABASE`
   失败时不再跑 node）；`ci-real-pg-wiring.test.mjs` 的 `runCommandTextsOf()` 对 `run: |` 块体有专门口径
   （块内以 `#` 开头的行会被当成 shell 注释剔除），单行形态与其余 7 步一致，守卫口径无需任何放宽。

---

## 4 负控制（两条，都「由绿变红」，还原后 sha256 逐字节相等）

还原手段统一是 `git checkout -- <文件>`，两次都用 `Get-FileHash -Algorithm SHA256` 与变异前逐字节比对，
并用 `git status --porcelain` 的行数确认工作树干净。

变异前的基线：

| 文件 | sha256（变异前 = 还原后） |
| --- | --- |
| `.github/workflows/real-pg-integration.yml` | `AE5593D5D4EAB798DF7754E6EECFFA9168BD486CA7E1F6F690BF2D67230B075A` |
| `tests/unit/ci-real-pg-wiring.test.mjs` | `19E3F44A68D9A4AFFE22CCFA7C274B374F9EA0CAAA2B34A2FD7DDD88D2C71E2C` |

### 负控制 ①：删掉新 step 的 `run:`（`MANAGED_SCRIPTS` 仍含 `ocr-jobs-pg.mjs`）

变异：把

```
      - run: psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_ocr_jobs_test' && node tests/integration/ocr-jobs-pg.mjs
```

换成 `      - name: ocr-jobs-pg-nc1-run-removed`（该 step 只剩 `env:`，YAML 仍合法、step 仍在，
**不是**把整段删掉）⇒ 意图是「脚本还在清单里，但没人真跑它」。

`node --test --test-isolation=none tests/unit/ci-real-pg-wiring.test.mjs` ⇒ **`EXITCODE=1`**，
`tests 12 / pass 8 / fail 4`。第一条红的原文：

```
✖ 前向①：两个受管真库脚本都被某个 workflow 的 `run:` 真跑 (11.0809ms)
  AssertionError [ERR_ASSERTION]: 有受管真库脚本既没有被任何 workflow 的 `run:` 执行，也没有对应的真库臂——
  这类脚本坏了 CI 也不会红（「脚本在 main、但没人跑」的静默缺口）：
    · tests/integration/ocr-jobs-pg.mjs

  改法：在 `.github/workflows/real-pg-integration.yml`（或另一个带 `services.postgres` 的 workflow）里加一步
  `node <脚本>`，不要只写在注释里、也不要只写裸文件名。
  + actual - expected

  + [
  +   'tests/integration/ocr-jobs-pg.mjs'
  + ]
  - []

      at assertManagedScriptsWired (file:///E:/GengYunCommander/wt-r28-s17/tests/unit/ci-real-pg-wiring.test.mjs:298:10)
      at TestContext.<anonymous> (file:///E:/GengYunCommander/wt-r28-s17/tests/unit/ci-real-pg-wiring.test.mjs:512:3)
```

**如实登记**：这一次变异把该文件里另外 3 条**自带的**负控制（`反向控制①`／`反向控制①b`／`反向控制⑦`）
也一起带红了——它们在同一份 workflow 文本上断言「只点名被删的那一个」，而现在 `ocr-jobs-pg` 也缺线，
「只点名它」自然不成立。这是同一次变异的**级联**，不是独立缺陷；还原后全绿（第 5 节读数）。

还原校验：

```
restored sha256: AE5593D5D4EAB798DF7754E6EECFFA9168BD486CA7E1F6F690BF2D67230B075A
status lines: 0
```

### 负控制 ②：`MANAGED_SCRIPTS` 改回 7 条（`FROZEN_MANAGED_SCRIPTS` 仍 8 条）

变异：只删 `MANAGED_SCRIPTS` 数组末尾的 `  'tests/integration/ocr-jobs-pg.mjs',` 一行，
`FROZEN_MANAGED_SCRIPTS` 一字未动 ⇒ 意图是「接线守卫的清单缩回 7，漏掉本片这条」。

`node --test --test-isolation=none tests/unit/ci-real-pg-wiring.test.mjs` ⇒ **`EXITCODE=1`**，
`tests 12 / pass 11 / fail 1`。红的原文（尾部）：

```
✖ 前向①：两个受管真库脚本都被某个 workflow 的 `run:` 真跑 (10.6874ms)
  AssertionError [ERR_ASSERTION]: 受管脚本清单被改动但未同步冻结清单
  + actual - expected
  ... Skipped lines

    [
      'tests/integration/account-deletion-pg.mjs',
      'tests/integration/admin-accounts-read-pg.mjs',
      'tests/integration/admin-flags-pg.mjs',
      'tests/integration/community-pg.mjs',
  ...
      'tests/integration/messages-pg.mjs',
  -   'tests/integration/ocr-jobs-pg.mjs'
    ]

      at TestContext.<anonymous> (file:///E:/GengYunCommander/wt-r28-s17/tests/unit/ci-real-pg-wiring.test.mjs:521:10)
```

还原校验：

```
restored sha256: 19E3F44A68D9A4AFFE22CCFA7C274B374F9EA0CAAA2B34A2FD7DDD88D2C71E2C
workflow sha256: AE5593D5D4EAB798DF7754E6EECFFA9168BD486CA7E1F6F690BF2D67230B075A
status lines: 0
```

两次还原后 `git --no-pager diff --stat` 均为空输出、`git status --porcelain` 均为 **0 行**。

---

## 5 门禁读数（本片收尾时实跑，全部 `EXITCODE=0`）

| 门禁 | 命令 | `EXITCODE` | 尾部原文 |
| --- | --- | --- | --- |
| 静态 | `npm run lint` | **0** | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描…` / `lint 通过（静态检查；不代表运行期或真实服务已通过）。` |
| 契约 | `npm run test:contract` | **0** | `ℹ tests 6 / ℹ pass 6 / ℹ fail 0` |
| 两个守卫（隔离口径） | `node --test --test-isolation=none tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` | **0** | `ℹ tests 19 / ℹ pass 19 / ℹ fail 0` |
| 全 unit（串行） | `node --test --test-concurrency=1 "tests/unit/*.test.mjs"` | **0** | `ℹ tests 1975 / ℹ pass 1974 / ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 1 / ℹ duration_ms 241910.9991` |

全量 unit 的那 **1 条 skip 与本片无关**，是既有的「需要本机原生 PG 客户端」用例在无库时的
用例级 skip（`:1094   ﹣ native separate-connection withdrawal and account state changes at guarded
read boundary … # SKIP`）；`fail 0` 才是判据。完整输出另存
`E:\GengYunCommander\.pg17\handoff\r28s17-unit-full.log`。

---

## 6 我没做到的取证（如实登记）

- **没有**在 GitHub Actions 上实跑：本片⛔ 不 push、不开 PR，也没有 CI 凭据 ⇒ 这个 step 的
  「CI 侧第一次真红/真绿」要等 PR 运行；本页给的是**本机 scram 等价集群**上的等价读数
  （凭据、库名、库前提、连接串形态与 workflow 逐字一致）。
- **没有**独立验证 `postgres:17.11` 镜像本身的权限面（例如 `POSTGRES_USER` 在镜像里是超级用户、
  `pgcrypto` 是可信扩展因而非超级用户属主也能 `CREATE EXTENSION`）：这两点沿用既有 7 步已验的前提，
  本步**不引入任何新角色/新迁移**，因此没有新增该类风险。
- **没有**跑 `npm run test:integration:http` 这条无 PG 回环链：本步不进那条链（`UNWIRED_DECLARATIONS`
  的 reason 已如实写明），改动不触及那里的任何断言。
- **没有**量 8 步串行后的总墙钟时间：本步本身实测 1600ms（trust）／2294ms（scram），
  job 的 `timeout-minutes: 15` 未见紧张，但 8 步串行的总耗时本片未测。
