# GY-R29 / S10：main 上 23 只真库臂的全量真实读数审计（2026-10-22）

- 分支：`feat/gy-r29-arms-audit`
- 基线（读数采集时的树）：`origin/main` = `a2ab0d9aff391a199142699038b01eda2f74d497`
- 合流后（CI 接线章节的读数来源）：`origin/main` = `5b631ecfb0d3ee58ae9cd82dbda40f6fe795657e`（含 `#415`／`be3dc97`「两只真库臂接进 real-pg-integration + 修 SELF_CLUSTERED_ROOT_KEY 假绿」）。**接线相关的每一句都按合流后的树复核过**；两处数字不同的地方都同时给了基线快照，避免把「当时」和「现在」混成一句
- 本页交付物：23 只 `tests/integration/*pg*.mjs` 真库臂的**逐只实跑读数**（退出码／断言计数／耗时／PG 版本／迁移数／清理）+ CI 接线三方对齐 + 失败分因 + 缺口清单
- 本页**不含**代码改动：不修产品代码、不改脚本、不改 workflow（越界项见 §5，交指挥派单）

**证据分层（必须按此读）**：本页所有读数都是**本机实测**——Windows 本机 `PostgreSQL 17.11` 二进制、`127.0.0.1` 回环、每只臂一套独立集群/独立库、串行执行。它**不是** GitHub Actions runner 的读数；CI 侧是否绿，要看 PR 上对应 job 的运行记录。本页能证明的是「脚本在当前 main 上、对着 17.11 真库，确实能跑出它的断言」，不能替代 CI 记录。

---

## 0. 五条直接回答

| # | 问题 | 读数 |
| --- | --- | --- |
| ① | 23 只都真跑了吗 | **是，23/23**。串行、逐只独立集群，全部 `exit 0`；**无 TIMEOUT**（最慢 14.8 s，预算 300 s/只）；**无「跳过」**：全 23 份日志里 `SKIP` 只出现 2 次，均非跳过（`skipped=0` 的计数域、`CLEANUP=skipped（EGRESS_LEDGER_KEEP=1）` 的刻意两段串联）；`77` 单独出现 0 次；`未取得` 的命中**全部**是脚本自陈的出范围声明（形如「未取得 <某读数>：本片只…」），没有一条是 `exit 77` 的静默跳过 |
| ② | 有红的吗 | **0 红、0 条 FAIL 行**。这些臂的主体是「PASS n：…」正向计数 + 断言抛错，没有独立 FAIL 行；「FAIL=0」的含义是**没有任何断言抛错**，并且 23/23 退出码 0（任何断言失败都会变成非 0） |
| ③ | 有几只没被 CI 接线 | **合流后：0 只，23/23 全部接线**。基线快照（`a2ab0d9`）上是 **1 只**（`messages-purge-pg`），已由 `#415` 接进 `real-pg-integration.yml:268`（`GY_W11_PG_ROOT` 走脚本自己读的键，`:271`），四数组随之 14/14/14/2 → **15/15/15/3**。派单里的「至少 9 只不在 CI 里跑」是**把 14 这个数字读成了全仓真库臂数**——14 只是 `real-pg-integration.yml` 一个 job 的受管清单，另外 9 只 pg 臂各接在自己的 workflow 里（见 §2） |
| ④ | 有没有真缺陷（类别 c） | **没有**。类别 (b) 脚本过期：**0**；类别 (a) 环境/权限：2 处，**都在本机夹具侧**（不是脚本缺陷），原文与解法见 §3 |
| ⑤ | 有没有留垃圾 | **没有**。7 个组集群 `pg_ctl stop` 后端口全部 `listening=false`、数据目录 `dirGone=true`；3 只自起集群臂（backup-purge / backup-copies-purge / messages-purge）端口 55929 / 55690 / 55762 现均无人监听、`gy-*` 数据目录零残留 |

一句话结论：**23 只真库臂在当前 main 上全部是「真绿」，不存在「库里有脚本但已经烂掉」的假证据；合流 `#415` 之后 23/23 也全部被 CI 接线。** 基线快照上唯一的「无人监护」是 `messages-purge-pg`（它是绿的，但当时没有任何 job 会因为它的断言变红而挡 PR），该缺口已随 `#415` 闭合——本页 §4 记的是它的闭合方式与合流后的复核判据。

---

## 1. 主表（23 行）

| 臂 | 读的变量 | 端口 | PG | 迁移（脚本读数） | 结果（脚本自报） | FAIL | exit | 秒 | CI 接线 | 清理 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `conversations-pg` | env `CONVERSATIONS_PG_TEST_URL` | 55820 | 17.11 | 子集 7（0001/0002/0005/0008/0010/0012/0013） | 12 条 | 0 | 0 | 2.9 | `real-pg-integration.yml:69` | 干净 |
| `community-pg` | env `COMMUNITY_PG_TEST_URL` | 55820 | 17.11 | 目录读数 26（应用 0001+0022） | 23 组 | 0 | 0 | 2.8 | `real-pg-integration.yml:79` | 干净 |
| `messages-pg` | argv[2] URL | 55820 | 17.11 | 清单 26（`[√] ALL PASS`） | ALL PASS | 0 | 0 | 2.8 | `real-pg-integration.yml:90` | 干净 |
| `favorites-history-pg` | env `FAVORITES_HISTORY_PG_TEST_URL` | 55820 | 17.11 | 0018 | 13 组 | 0 | 0 | 2.9 | `real-pg-integration.yml:99` | 干净 |
| `account-deletion-pg` | argv[2] URL | 55820 | 17.11 | 26（应用 25 + 0023 单跑） | 13 组 | 0 | 0 | 3.6 | `real-pg-integration.yml:112` | 干净 |
| `admin-accounts-read-pg` | argv[2] URL(+argv[3] 口令) | 55820 | 17.11 | 26（`[M]` 三连） | 15 组 `[M]`/`[H]` | 0 | 0 | 3.2 | `real-pg-integration.yml:125` | 干净 |
| `admin-flags-pg` | argv[2] URL | 55820 | 17.11 | 26（`[M]` 三连） | ①–⑥ + 行锁 + 探测 | 0 | 0 | 9.6 | `real-pg-integration.yml:137` | 干净 |
| `ocr-jobs-pg` | env `OCR_PG_TEST_URL` | 55820 | 17.11 | 0024 三连（全链 0001..0024） | ALL PASS | 0 | 0 | 4.9 | `real-pg-integration.yml:149` | 干净 |
| `recognitions-pg` | env `RECOGNITIONS_PG_TEST_URL` | 55820 | 17.11 | 0025 三连（全链 0001..0025） | ALL PASS | 0 | 0 | 4.3 | `real-pg-integration.yml:163` | 干净 |
| `account-suspend-pg` | argv[2] URL | 55820 | 17.11 | 26（apply 0001–0017 段） | ALL PASS | 0 | 0 | 2.4 | `real-pg-integration.yml:180` | 干净 |
| `speech-pg` | env `SPEECH_PG_TEST_URL` | 55820 | 17.11 | 0026 三连（全链 26 条） | ALL PASS | 0 | 0 | 4.6 | `real-pg-integration.yml:193` | 干净 |
| `backup-purge-pg` | `GY_I19_PG_ROOT`（自起集群） | 55929（自选） | 17.11 | 25 + 0023 = 26 | `RESULT=PASS 14 组` | 0 | 0 | 7.8 | `real-pg-integration.yml:231` | 干净（端口 free、数据目录已删） |
| `backup-copies-purge-pg` | `GY_I19_PG_ROOT`（自起集群） | 55690（自选） | 17.11 | 26 全链 | 14 条 | 0 | 0 | 8.7 | `real-pg-integration.yml:247` | 干净（端口 free、数据目录已删） |
| `auth-privacy-pg` | env `AUTH_PRIVACY_TEST_URL` | 55860 | 17.11 | 子集 0001/0003/0008 | 26 组 | 0 | 0 | 4.0 | `auth-privacy-postgres.yml:34` | 干净 |
| `migrations-negative-pg` | env `MIGRATIONS_NEGATIVE_TEST_URL` | 55860 | 17.11 | 26 台账（旁路 a/b/c 库） | 11 组 | 0 | 0 | 6.9 | `auth-privacy-postgres.yml:39` | 干净 |
| `catalog-pg` | env `DATABASE_TEST_URL` | 55880 | 17.11 | 脚本内 apply（未打印条数） | 6 条 | 0 | 0 | 7.0 | `catalog-postgres.yml:34` | 干净 |
| `consent-grant-pg` | env `CONSENT_GRANT_TEST_URL` | 55900 | 17.11 | 0009 up/down/up | 27 组 | 0 | 0 | 9.0 | `consent-grant-postgres.yml:34` | 干净 |
| `egress-ledger-pg` | env `EGRESS_LEDGER_TEST_URL`(+`EGRESS_LEDGER_KEEP=1`) | 55900 | 17.11 | 0001/0003/0008/0009/0011 | `RESULT=PASS 12 组` | 0 | 0 | 4.1 | `consent-grant-postgres.yml:42` | 干净（`CLEANUP=skipped` 属刻意两段串联，组集群整台销毁） |
| `egress-object-key-pg` | env `EGRESS_LEDGER_TEST_URL` + `W116_PSQL` | 55900 | 17.11 | 0014（只追加） | `RESULT=PASS 28 组` | 0 | 0 | 3.8 | `consent-grant-postgres.yml:56` | 干净 |
| `source-lifecycle-pg` | env `DATABASE_TEST_URL` | 55920 | 17.11 | 脚本内 apply（未打印条数） | 5 条 | 0 | 0 | 13.8 | `source-lifecycle-postgres.yml:34` | 干净 |
| `staging-intake-pg` | env `STAGING_INTAKE_TEST_URL` + `STAGING_PYTHON` | 55940 | 17.11 | 脚本内 apply（未打印条数） | 13 条 | 0 | 0 | 14.8 | `staging-intake-postgres.yml:34` | 干净 |
| `workbook-staging-pg` | env `STAGING_PG_TEST_URL` | 55960 | 17.11 | 脚本内 apply（未打印条数） | 1 条 | 0 | 0 | 1.1 | `workbook-staging.yml:43` | 干净 |
| `messages-purge-pg` | `GY_W11_PG_ROOT`（自起集群） | 55762（自选） | 17.11 | 26 全链 | 8 条 | 0 | 0 | 10.3（合流后复跑 7.9） | `real-pg-integration.yml:268`（`#415` 接入；基线快照上为**无**） | 干净（端口 free、数据目录已删） |

### 表注（读表前必须知道的四件事）

1. **端口列**：55820…55960 是本次我起的「组集群」端口（同组多只臂共用一台集群、各用各的库，等价于 CI 里 service 容器的角色）；`5432` 是 CI 的值，不是脚本的假设——脚本只吃 URL/argv，端口无关。三只自起集群臂（`backup-purge-pg` / `backup-copies-purge-pg` / `messages-purge-pg`）的端口是脚本自己随机的，列里是**本次实测值**。
2. **PG 列**：全部是同一台集群 `show server_version` 的实测 `17.11`。其中 **9 只脚本自己不打印版本**（`account-suspend` / `admin-accounts-read` / `admin-flags` / `community` / `messages` / `migrations-negative` / `ocr-jobs` / `recognitions` / `speech` 只打印「迁移清单 26 个」），列值取自 runner 对同一集群的读数 ⇒ 见 §5 F2。
3. **迁移列**：`子集` = 脚本只 apply 它需要的那几段（刻意，不是缺迁移）；`26` = 全链 0001..0026；`脚本内 apply（未打印条数）` = 脚本确实 apply 了迁移但**不打印条数**，本页不替它编数字 ⇒ 见 §5 F5。
4. **第 2 列就是「它吃哪一种入参」的分类，也是 F2 的根因**：**3 只**读 `*_PG_ROOT` 数据根键（`backup-purge-pg` / `backup-copies-purge-pg` 读 `GY_I19_PG_ROOT`，`messages-purge-pg` 读 **`GY_W11_PG_ROOT`**——**只有两个变量名，不是 23 个**）；**15 只**读 URL env（键名各不相同，逐行见第 2 列）；**5 只**吃 `argv[2]`（`messages` / `account-deletion` / `admin-accounts-read`〔另有 `argv[3]` 口令〕/ `admin-flags` / `account-suspend`）。⇒ 任何「凭 root 键判断脚本类别」的处方都会写错：root 键只有自起集群那 3 只才有，而且**键名必须按脚本映射**——`tests/unit/ci-real-pg-wiring.test.mjs:256` 的 `SELF_CLUSTERED_ROOT_KEY` 就是这张映射表（`#415` 之前它对全体硬编码 `GY_I19_PG_ROOT`，守卫绿而 `messages-purge-pg` 照样回落 `os.tmpdir()`）。

---

## 2. CI 接线三方对齐

### 2.1 四个数组的实读（`tests/unit/ci-real-pg-wiring.test.mjs`）

| 常量 | 位置（合流后） | 条数：基线 `a2ab0d9` → 合流 `5b631ec` | 成员变化 |
| --- | --- | --- | --- |
| `MANAGED_SCRIPTS` | `:92` | **14 → 15** | +`tests/integration/messages-purge-pg.mjs`；其余 14 条 = 13 只 `-pg` 臂 + `recognition-chain-e2e.mjs`（后者**不叫** `-pg`，不属于本页 23 只） |
| `FROZEN_MANAGED_SCRIPTS` | `:110` | **14 → 15** | 与上表逐条相同（冻结副本，改了要刻意留 diff） |
| `REQUIRED_STEP_ORDER` | `:150` | **14 → 15** | 同上，且**钉死执行顺序**（`messages-purge-pg` 插在 `recognition-chain-e2e` 之前；`account-deletion` 必须在 `admin-accounts-read` 之前等） |
| `SELF_CLUSTERED_SCRIPTS` | `:232` | **2 → 3** | +`messages-purge-pg.mjs`（判据⑦⑧ 换成「必须给 `GY_PG_BIN` + **它自己读的** `GY_*_PG_ROOT`、不得 `CREATE DATABASE`」） |
| `SELF_CLUSTERED_ROOT_KEY`（`#415` 新增） | `:256` | 不存在 → **3 条** | 键名**按脚本映射**：`backup-purge-pg`／`backup-copies-purge-pg` → `GY_I19_PG_ROOT`，`messages-purge-pg` → `GY_W11_PG_ROOT`。这张表不是唯一依据，`detectedRootKeys()` 会从脚本源码取真值交叉核对 |

另有 `FORBIDDEN_ESCAPE_HATCHES`（`:215`，`GY_ALLOW_SKIP` / `--allow-skip`）、`REQUIRED_POSTGRES_MAJOR = '17'`（`:218`）、`SELF_CLUSTERED_ROOT_KEY_PATTERN`（`:263`）、`SELF_CLUSTERED_ROOT_PATTERN`（`:266`，root 必须落在 `${{ runner.temp }}`）。

**⇒ 派单给的「14/14/14、自起集群 2」在基线快照上逐条为真；合流 `#415` 后已变成 15/15/15、自起集群 3。** 两种数字都要注意同一个语义：这几条清单描述的是**一个 job（`real-pg-integration.yml`）的受管集合**，不是「全仓真库臂总数」。

**合流后复核（本页已做）**：`node --test tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` ⇒ **25/25 pass、0 fail**（含「反向控制⑩：root 键按脚本映射——错映射／丢映射／装饰性 env／脚本改键，四种变异都必须红」）。

### 2.2 把 23 只按「接在哪」分堆

| 接在哪 | 只数 | 臂 |
| --- | --- | --- |
| `real-pg-integration.yml`（受管清单里的 14 只 `-pg` 臂） | 14 | conversations / community / messages / favorites-history / account-deletion / admin-accounts-read / admin-flags / ocr-jobs / recognitions / account-suspend / speech / backup-purge / backup-copies-purge / **messages-purge（`:268`，`#415` 接入）** |
| 各自的 workflow（不在四个数组里，但**确实跑**） | 9 | auth-privacy + migrations-negative（`auth-privacy-postgres.yml:34,39`）、consent-grant + egress-ledger + egress-object-key（`consent-grant-postgres.yml:34,42,56`）、catalog（`catalog-postgres.yml:34`）、source-lifecycle（`source-lifecycle-postgres.yml:34`）、staging-intake（`staging-intake-postgres.yml:34`）、workbook-staging（`workbook-staging.yml:43`） |
| 只出现在 `package.json` | 0 | — |
| **哪里都没有** | **0**（基线快照上 1，`messages-purge-pg`） | — |

⇒ **14 + 9 = 23，全覆盖**。基线快照上的唯一空洞是 `messages-purge-pg`，`#415`（`be3dc97`，2026-10-21T18:17Z 已合入 main）把它接进 `real-pg-integration.yml:252-271`：装包 step 复用（`:214` 的注释已把它写进「需要 initdb/pg_ctl」的名单）、`GY_PG_BIN` 指 `/usr/lib/postgresql/17/bin`、数据根键给的是**脚本自己读的** `GY_W11_PG_ROOT: ${{ runner.temp }}/gy-w11-pg`（`:271`）。⛔ 不要再另开一套 `messages-purge-postgres.yml` 的接线方案——那会与 `MANAGED_SCRIPTS` 的「双向相等」判据（判据⑨）直接冲突。

交叉核对手法：对 23 个臂名逐个在 `.github/workflows/*.yml` 里找 `run:` 行（`<臂名>.mjs` 字面命中），再和四个数组、`package.json` 的 `test:integration:*` 三方对比。

### 2.3 `package.json` 侧的真值（4 条 `test:integration*` 里只有 2 条指向本页的臂）

```
test:integration:conversations-pg      = node tests/integration/conversations-pg.mjs
test:integration:backup-copies-purge-pg = node tests/integration/backup-copies-purge-pg.mjs
test:integration:recognition-chain-pg  = node tests/integration/recognition-chain-e2e.mjs   ← 不是 -pg 臂
```

⇒ **21 只臂在本机没有任何 npm 入口**，本地要跑只能翻 workflow 抄 env（本次审计为此自带 runner，见 §6）。这不是红色缺陷，但是「库里有脚本没人跑」的现实土壤之一 ⇒ §5 F3。

### 2.4 有没有「接了线但红了也不拦」的开关

对 `.github/workflows/*.yml` 全量搜 `continue-on-error` / `|| true` / `set +e`：**零命中真开关**——5 处命中全是**注释**，且都是明令禁止它们的句子（`deploy-sql-gate.yml:193,336,337,447`、`real-pg-integration.yml:284`）。⇒ 23 只接了线的臂，红了就是真红，没有静默通道。

---

## 3. 失败分因

**结论：本次没有任何一只臂失败** ⇒ 类别 (b)「脚本已过期」= 0、类别 (c)「真产品缺陷」= 0。

为了让「下次谁跑会踩什么」可复现，把本轮**踩到过**的两处环境/权限问题按 (a) 记录（都是本机夹具侧，不是脚本缺陷、不是产品缺陷）：

### (a)-1 `workbook-staging-pg`：夹具重复建库 + Windows 目录句柄未释放

首轮（`full.log`）原文逐字：

```
[PREP-FAIL] workbook-staging-pg: psql.exe -h 127.0.0.1 -p 55960 -U gengyun_ci_owner -d postgres -v ON_ERROR_STOP=1 -c CREATE DATABASE gengyun_staging_test => 1

ERROR:  database "gengyun_staging_test" already exists
```

随后收尾 `rmSync` 在 Windows 上炸：

```
Error: EPERM, Permission denied: \\?\E:\GengYunCommander\.pg17\tmp\arms-audit\_cluster-workbookstaging
    at rmSync (node:fs:1222:18)
  errno: 1,
  code: 'EPERM',
```

- 因：`workbook-staging-pg` 的库名是**硬钉的** `gengyun_staging_test`（`workbook-staging.yml:43` 的 `STAGING_PG_TEST_URL` 写死该库名），我夹具的通用「建库」逻辑在它自己的 `pre` 建库之后又建了一次。
- 另一个坑：`pg_ctl stop` 返回时，被 detach 的 `postgres` 进程还持有 `data` 目录句柄 ⇒ 紧接着 `rmSync` 必 `EPERM`。
- 解法（夹具侧，不进仓）：给该臂 `create:false` 走自己的 `pre`；`rmSync` 加 `{ maxRetries: 5, retryDelay: 250 }`。改后 `workbook-staging-pg` 1.1 s 通过。

### (a)-2 角色权限：`staging_test` 必须是超级用户

`workbook-staging.yml:24` 的 `POSTGRES_USER: staging_test` 在 docker 官方镜像里会被建成**超级用户**；我首轮按普通 LOGIN 建它，脚本内部建角色/建库时被拒（psql 提示 `Only roles with the CREATEROLE attribute may create roles.`；此条为首次尝试的复述，非逐字归档）。改成本机 SUPERUSER 后通过。
⇒ 这条对 CI 无害（CI 本来就是超级用户），但**本机复现者容易踩**，写在这里。

### (a)-3 `pg_ctl -o "-p 55688"` 在 pwsh 下拆参

`pwsh` 会把 `-o "-p 55688"` 拆成两个参数导致 `pg_ctl` 启动失败；脚本内部一律 `spawnSync(pg_ctl, [ ... ])` 数组传参 ⇒ **脚本自己不受影响**，只有手敲命令的人会踩。本次 runner 同样用数组传参。

---

## 4. 未接线臂清单（合流后 **0 只**；基线快照 1 只，已闭合）

### 基线快照 `a2ab0d9` 上的唯一空洞：`tests/integration/messages-purge-pg.mjs`

以下三重证据记的是**当时（`a2ab0d9`）为什么判定它没人跑**，保留原文以便复核这条判断本身有没有错：

三重证据：

1. `tests/unit/ci-real-pg-wiring.test.mjs` 的四个数组（`MANAGED_SCRIPTS` / `FROZEN_MANAGED_SCRIPTS` / `REQUIRED_STEP_ORDER` / `SELF_CLUSTERED_SCRIPTS`）**都不含**它。
2. `.github/workflows/**` 里**没有任何** `run:` 提到它（对 23 个臂名做字面命中的全量扫描，只有它 0 命中）。
3. 它自己的原因条目就写在白名单里 —— `tests/unit/ci-integration-chain-structure.test.mjs:197-202`（数组 `UNWIRED_DECLARATIONS`，定义在 `:67`）逐字：

```
path: 'tests/integration/messages-purge-pg.mjs',
reason: '需真实 PG 17.11：自己用 `GY_PG_BIN`（含 `initdb`/`pg_ctl`）起临时集群、跑全链迁移与运行时角色授权，'
  + '再经真实 `purgeOwnerData` 取「本主体 messages 行数 → 0／他人行原样」的注销行数读数；未设 `GY_PG_BIN` 时'
  + '**显式打印「未取得，不是通过」并以 77 退出**（不提供 `--allow-skip`），故不进无 PG 的回环链。'
  + 'R28-W11 只交付脚本与证据，**尚未接进任何 workflow**（`.github/workflows/**` 不在本片范围内，CI 接线另开一单）。',
```

它的证据页 `docs/verification/gy-r28-w11-messages-purge-pg-20261021.md` §0④ 也如实自陈「没有被 CI 执行」。

**当时实测它是绿的**（8 条断言、10.3 s、端口 55762 收尾 free、数据目录已删）⇒ 风险不是「已经烂了」，而是**无人监护**：没有 job 会因为它的断言变红而挡住任何 PR。

### 闭合方式：`#415`／`be3dc97`（已合入 main，`2026-10-21T18:17:02Z`）

`#415`（S5，分支 `feat/gy-r29-w13-ci-arms`，标题「两只真库臂接进 real-pg-integration + 修 SELF_CLUSTERED_ROOT_KEY 假绿」）把它接进了 `real-pg-integration.yml`。**本页按合流后的树逐条复核**：

| 项 | 合流后实读 |
| --- | --- |
| step | `real-pg-integration.yml:252-271`，`run: node tests/integration/messages-purge-pg.mjs`（`:268`） |
| `GY_PG_BIN` | `/usr/lib/postgresql/17/bin`（复用 `:214` 那条装包 step 的产物，⛔ 不重复装） |
| 数据根键 | `GY_W11_PG_ROOT: ${{ runner.temp }}/gy-w11-pg`（`:271`）——**脚本 `:92` 真读的键**，不是 `GY_I19_PG_ROOT` |
| 四个数组 | `MANAGED_SCRIPTS` 15 / `FROZEN` 15 / `REQUIRED_STEP_ORDER` 15 / `SELF_CLUSTERED_SCRIPTS` 3 + 新增 `SELF_CLUSTERED_ROOT_KEY`（`:256`，3 条按脚本映射） |
| 守卫 | `node --test tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` ⇒ **25/25 pass**（含「反向控制⑩」：错映射／丢映射／装饰性 env／脚本改键，四种变异都必须红） |
| 臂本身 | 合流后复跑：**exit 0、8 条断言、7.9 s**、端口 55762 收尾 free、root 目录零残留 |

`#415` 同时修掉了一个**假绿通道**：接线前守卫对所有自起集群脚本硬编码「必须给 `GY_I19_PG_ROOT`」，而本脚本读 `GY_W11_PG_ROOT` ⇒ 守卫绿、脚本照样回落 `os.tmpdir()`。这正是本页表注 4 要说的那件事：**root 键必须按脚本映射，不能凭脚本名/字段名猜。**

### 合流后复核判据（下次动这组文件时按四条验，任一不成立就该重开一单）

1. 四数组 **15/15/15**、`SELF_CLUSTERED_SCRIPTS` **3**、`SELF_CLUSTERED_ROOT_KEY` **3 条**；
2. `messages-purge-pg` 的 root 键仍是 `GY_W11_PG_ROOT`（脚本 `:92`）——**源码真值优先**于 `SELF_CLUSTERED_ROOT_KEY` 的声明，两者必须一致；
3. 它的 step 里仍有 `GY_PG_BIN`，且**不得**出现 `CREATE DATABASE`（自起集群脚本连的是自己临时集群里的库，CI 建库只会造假象）；
4. `node --test tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` 25/25 pass。

⛔ **不要再另开一套 `messages-purge-postgres.yml` 的接线方案**：判据⑨要求「workflow 真跑的脚本集合与 `MANAGED_SCRIPTS` 双向相等」，单开一个 workflow 会让同一条脚本出现在两处、并把 `REQUIRED_STEP_ORDER` 的顺序判据架空。

---

## 5. 发现但未修（F1–F6）

本片红线：不修产品代码、不改脚本、不改 workflow。以下只列证据与**可执行处方**（文件:行 / 改什么 / 判据），等指挥派单。

**为什么 F2–F5 只给处方不在本片动**：F2 要动 9 只脚本的打印行，撞 `FROZEN_MANAGED_SCRIPTS` 的冻结面，也和 `#415` 正在改的同一文件家族相邻；F3 是 `package.json`，加 21 条入口会与「CI 走 workflow」形成双入口，需要先定口径。⇒ 处方写清、由指挥统一派单，避免两片同时改同一批文件互相踩。

| # | 缺口 | 证据 | 可执行处方（文件:行 → 改什么 → 判据） | 状态 |
| --- | --- | --- | --- | --- |
| F1 | 1 只真库臂未接线（`messages-purge-pg`，基线快照） | §4 三重证据 | **已闭环，无需再改**：`#415`／`be3dc97` 已合入，step 在 `real-pg-integration.yml:252-271`，四数组 15/15/15、自起集群 3；复核判据见 §4 末四条 | ✅ **已闭合** |
| F2 | **9 只臂不打印 PG 版本** ⇒ 日志无法自证「跑在 17 而不是 16」 | §1 表注 2；CI 侧只有**静态**判据 `REQUIRED_POSTGRES_MAJOR='17'`（`ci-real-pg-wiring.test.mjs:218`），没有运行时读数 | **两只已经有变量、只差打印**：`community-pg.mjs:123`（`SELECT current_setting('server_version')` 已取 `version`）、`migrations-negative-pg.mjs:198`（`SHOW server_version` 已取 `version`）→ 在下一行加 `note('PG ' + version)`。**七只要在各自 `[M] 迁移清单` 旁补一条**：`account-suspend-pg.mjs:119`、`admin-accounts-read-pg.mjs:92`、`admin-flags-pg.mjs:160`、`messages-pg.mjs:109`、`ocr-jobs-pg.mjs:255`、`speech-pg.mjs:248`、`recognitions-pg.mjs`（同形 `names.includes(MIGRATION)` 处）→ 各加 `note('PG ' + (await owner.query('SHOW server_version')).rows[0].server_version)`。**判据**：该臂日志里出现 `^17\.` 且与 runner 的 `postgres:17.11` 一致；⛔ 不许写死字符串 | 处方待派 |
| F3 | **21 只臂没有 npm 入口** | §2.3：`package.json` 只有 3 条 pg 相关 `test:integration:*`，其中 2 条指向本页的臂 | `package.json` 的 `scripts` 加 21 条 `"test:integration:<臂名>": "node tests/integration/<臂名>.mjs"`（自起集群那 3 只额外要 `GY_PG_BIN`／对应 `*_PG_ROOT`，见 §6）。**判据**：`npm run` 列表覆盖 23/23；**⛔ 不要把 npm 脚本再接进 workflow**（CI 已有 step，双入口会让「谁是真的门禁」变模糊） | 处方待派 |
| F4 | **2 只臂收尾不打印 CLEANUP**（实测都干净，但日志无自证） | `backup-purge-pg.mjs:829` 打印 `CLEANUP=done（临时集群已停、数据目录已删；未触碰工作树与既有库）`；`backup-copies-purge-pg.mjs:632`（`finally { … stopCluster(); rmSync(cliLog…)}`）与 `messages-purge-pg.mjs:529`（`finally { … stopCluster(); }`）**没有这一行** | 在两处 `stopCluster()` 之后各加一行、**与 `backup-purge-pg.mjs:829` 逐字同口径**；失败分支保留 `CLEANUP=FAILED` 语义。**判据**：日志末尾出现 `CLEANUP=` 且值不是 `FAILED`；同时在 `finally` 里——⛔ 不许只在成功路径打印 | 处方待派 |
| F5 | **4 只臂不打印迁移条数** | `catalog-pg.mjs` / `source-lifecycle-pg.mjs` / `staging-intake-pg.mjs` / `workbook-staging-pg.mjs` 的日志只有 PASS 行 | 条数在源码里本来就有，只差打印：`catalog-pg.mjs:48`（`applyMigrations(...).applied` 断言为 4 条）、`source-lifecycle-pg.mjs:42`（filter 5 项）、`staging-intake-pg.mjs:38`（filter 5 项）、`workbook-staging-pg.mjs:23`（循环 3 个 SQL：`0001`/`0002`/`0004`）→ 各加一行 `迁移 N 个（本条：…）`，N 取**运行时的 `applied.length` / filter 长度 / 循环长度**。**判据**：日志的 N 与实际 apply 集合相等；⛔ 不许硬编码字面量，否则将来 filter 变了日志会撒谎 | 处方待派 |
| F6 | **两只臂共用同一个库**（隐式顺序前提，隔离风险） | `auth-privacy-pg` 与 `migrations-negative-pg` 都用 `gengyun_auth_privacy_test`（CI 里也是同一 URL 前缀，`auth-privacy-postgres.yml:36,41`） | 见下方「F6 单片口径」：各起独立库 + 收尾断言（库内表数/角色数归零）+ 真红负控制（故意共用一库 ⇒ 断言必须红或输出差异）；分支 `test/gy-r29-arms-isolation` | 🔜 下一片（单片） |

### F6 单片口径（下一片只做这一条）

- **为什么值得单独一片**：一端残留会掩掉另一端的失败——`migrations-negative-pg` 的 a/b/c 旁路库与 `auth-privacy-pg` 的 26 组断言共用一个库时，「上一步没清干净」与「本步真缺陷」在日志里长得一样；串行跑没事，但这是**隐式顺序前提**，一旦并行或调序就变成假绿/假红。
- **要做三件事**：① 各起独立库（`migrations-negative` 用 `gengyun_migrations_negative_test`，`auth-privacy` 保持 `gengyun_auth_privacy_test`），两处 URL env 与 workflow 同步；② 收尾断言「库内表数/角色数归零」，把「清干净」变成读数而不是习惯；③ **真红负控制**：故意让两只共用一库 ⇒ 断言必须红（或输出差异），证明新判据不是恒真。
- **不在这一片做**：F2/F3/F4/F5（理由见上）。

---

## 6. 本机怎么复现（照抄即可）

- PG 二进制：`E:\GengYunCommander\.pg17\pgsql\bin`（含 `initdb` / `pg_ctl` / `psql`），实测 `17.11`。
- **3 只自起集群臂**（`backup-purge-pg` / `backup-copies-purge-pg` / `messages-purge-pg`）：脚本自己 `initdb`，数据目录根**默认 `os.tmpdir()`**，本机 `initdb` 会 `Permission denied` ⇒ 必须显式给 root：

  ```powershell
  $env:GY_PG_BIN      = 'E:\GengYunCommander\.pg17\pgsql\bin'
  $env:GY_I19_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp\arms-audit\backup-purge-pg'    # backup-purge / backup-copies-purge 读这个
  $env:GY_W11_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp\arms-audit\messages-purge-pg'  # messages-purge 读这个（变量名不同！）
  node tests/integration/backup-purge-pg.mjs
  ```

  `*_PG_ROOT` 只有这 3 只读（`backup-copies-purge-pg.mjs:97`、`backup-purge-pg.mjs:89`、`messages-purge-pg.mjs:92`）；**其余 20 只不读任何 root 变量**——其中 **15 只吃 URL env**、**5 只吃 `argv[2]`**（具体键名见 §1 第 2 列）。
- **其余 20 只**：先起一台 17.11 集群（`initdb -U gengyun_ci_owner --pwfile` + `pg_ctl start`），再按表里第 2 列给 env（或 argv[2]）指向该集群里的专用库。
- 本次分组与端口（一只组内多臂共用集群、各用各库）：`55820`（13 只受管臂）、`55860`（auth-privacy + migrations-negative）、`55880`（catalog）、`55900`（consent-grant + egress×2）、`55920`（source-lifecycle）、`55940`（staging-intake）、`55960`（workbook-staging）。
- 串行总墙钟 ≈ **2 分 15 秒**（23 只读数之和 135.3 s；含集群起停与收尾约 4 min）。
- 收尾核对口径（本页每只都做过）：`Get-NetTCPConnection -LocalPort <port> -State Listen` 为空 + `<root>` 下除日志外无 `gy-*` 数据目录。

---

## 7. 「事实 vs 派单」逐条对照

| 派单说法 | 实测 | 结论 |
| --- | --- | --- |
| `tests/integration/` 下有 **23 个** `*pg*.mjs`，名单如派单 | 逐个 `readdirSync` + 名单比对：**恰好 23 只，名单与派单逐字一致**（无多、无少） | ✅ 派单正确 |
| CI 侧 `MANAGED_SCRIPTS` / `FROZEN_MANAGED_SCRIPTS` / `REQUIRED_STEP_ORDER` 各 **14** 条，`SELF_CLUSTERED_SCRIPTS` **2** 条 | 基线 `a2ab0d9`：`:91` 14 / `:108` 14 / `:147` 14 / `:216` 2 ⇒ **数字正确**；合流 `#415`（`5b631ec`）后：`:92` 15 / `:110` 15 / `:150` 15 / `:232` 3 + 新增 `SELF_CLUSTERED_ROOT_KEY:256` | ✅ 基线正确，且**已在合流后更新为 15/15/15/3** |
| 「⇒ 23 只臂里**至少 9 只不在 CI 里跑**」 | 四个数组只覆盖 `real-pg-integration.yml` 一个 job；另外 **9 只在各自的 workflow 里跑**（§2.2）；基线快照上真正未接线的**只有 1 只**（`messages-purge-pg`），已由 `#415` 接进 `real-pg-integration.yml:268` ⇒ 合流后 **23/23 全部接线** | ❌ **推断不成立**：9 这个数字对得上「不在那 14 条里」，但对不上「不在 CI 里跑」 |
| 「每只脚本的 `*_PG_ROOT` 变量名不一样，去脚本里 grep `PG_ROOT` 确认」 | 只有 **3 只**读 `*_PG_ROOT`（2 只 `GY_I19_PG_ROOT` + 1 只 `GY_W11_PG_ROOT`）；其余 20 只读 URL env 或 argv，**完全不读 root** | ⚠️ 部分不成立（3 只而不是 23 只，且只有 2 个变量名） |
| 「真库臂默认数据目录根是 `os.tmpdir()`，本机 `initdb` 会 Permission denied」 | 对那 3 只自起集群臂成立（`:89 / :92 / :97` 都是 `?? tmpdir()`）；其余 20 只不起集群、与 `initdb` 无关 | ✅ 对 3 只成立 |
| 「`pg_ctl` 不能直接 `-o "-p 55688"`（pwsh 拆参），脚本内部 `spawnSync` 数组传参所以脚本自己能跑通」 | 逐条复现：手敲 `pg_ctl ... -o "-p N"` 确实被拆参；脚本内部全是数组传参 ⇒ 不受影响 | ✅ 正确 |
| 「产物：最大风险是 9 只可能已经烂掉但没人发现的假证据」 | 9 只全部实跑、全部绿（且 9 只全部接在各自 workflow 里）；基线快照上「无人监护」只有 `messages-purge-pg`（已由 `#415` 闭合）⇒ **合流后没有一个真库臂是「无监护」的** | ⚠️ 风险方向对，对象错了 |

---

## 8. 本次审计的运行器（不进仓，仅供复核）

审计脚本与逐臂日志落在 worktree 之外的暂存目录 `E:\GengYunCommander\.pg17\tmp\arms-audit\`：

- `run.mjs`：按组起 17.11 集群 → 逐只串行跑 → 记录 `exit/ms/stdout` → 停集群、删数据目录、探活端口、列残留
- `_results/<臂名>.log`：每只臂的完整输出（含 `exit=` 头两行），23 份齐
- `_results/_cluster-<组>.json`：7 个组集群的 `{port, listening:false, dirGone:true, version:"17.11"}`

（这些文件**不提交**；本页只提交读数与本页本身。）


