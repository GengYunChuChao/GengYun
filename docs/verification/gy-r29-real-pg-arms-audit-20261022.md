# GY-R29 / S10：main 上 23 只真库臂的全量真实读数审计（2026-10-22）

- 分支：`feat/gy-r29-arms-audit`
- 基线：`origin/main` = `a2ab0d9aff391a199142699038b01eda2f74d497`
- 本页交付物：23 只 `tests/integration/*pg*.mjs` 真库臂的**逐只实跑读数**（退出码／断言计数／耗时／PG 版本／迁移数／清理）+ CI 接线三方对齐 + 失败分因 + 缺口清单
- 本页**不含**代码改动：不修产品代码、不改脚本、不改 workflow（越界项见 §5，交指挥派单）

**证据分层（必须按此读）**：本页所有读数都是**本机实测**——Windows 本机 `PostgreSQL 17.11` 二进制、`127.0.0.1` 回环、每只臂一套独立集群/独立库、串行执行。它**不是** GitHub Actions runner 的读数；CI 侧是否绿，要看 PR 上对应 job 的运行记录。本页能证明的是「脚本在当前 main 上、对着 17.11 真库，确实能跑出它的断言」，不能替代 CI 记录。

---

## 0. 五条直接回答

| # | 问题 | 读数 |
| --- | --- | --- |
| ① | 23 只都真跑了吗 | **是，23/23**。串行、逐只独立集群，全部 `exit 0`；**无 TIMEOUT**（最慢 14.8 s，预算 300 s/只）；**无「跳过」**：全 23 份日志里 `SKIP` 只出现 2 次，均非跳过（`skipped=0` 的计数域、`CLEANUP=skipped（EGRESS_LEDGER_KEEP=1）` 的刻意两段串联）；`77` 单独出现 0 次；`未取得` 的命中**全部**是脚本自陈的出范围声明（形如「未取得 <某读数>：本片只…」），没有一条是 `exit 77` 的静默跳过 |
| ② | 有红的吗 | **0 红、0 条 FAIL 行**。这些臂的主体是「PASS n：…」正向计数 + 断言抛错，没有独立 FAIL 行；「FAIL=0」的含义是**没有任何断言抛错**，并且 23/23 退出码 0（任何断言失败都会变成非 0） |
| ③ | 有几只没被 CI 接线 | **只有 1 只**：`messages-purge-pg`。派单里的「至少 9 只不在 CI 里跑」是**把 14 这个数字读成了全仓真库臂数**——14 只是 `real-pg-integration.yml` 一个 job 的受管清单，另外 9 只 pg 臂各接在自己的 workflow 里（见 §2） |
| ④ | 有没有真缺陷（类别 c） | **没有**。类别 (b) 脚本过期：**0**；类别 (a) 环境/权限：2 处，**都在本机夹具侧**（不是脚本缺陷），原文与解法见 §3 |
| ⑤ | 有没有留垃圾 | **没有**。7 个组集群 `pg_ctl stop` 后端口全部 `listening=false`、数据目录 `dirGone=true`；3 只自起集群臂（backup-purge / backup-copies-purge / messages-purge）端口 55929 / 55690 / 55762 现均无人监听、`gy-*` 数据目录零残留 |

一句话结论：**23 只真库臂在当前 main 上全部是「真绿」，不存在「库里有脚本但已经烂掉」的假证据。真正的缺口只有一个：`messages-purge-pg` 没人跑（它是绿的，但没有任何东西保证它下次还绿）。**

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
| `messages-purge-pg` | `GY_W11_PG_ROOT`（自起集群） | 55762（自选） | 17.11 | 26 全链 | 8 条 | 0 | 0 | 10.3 | **无（未接线）** | 干净（端口 free、数据目录已删） |

### 表注（读表前必须知道的三件事）

1. **端口列**：55820…55960 是本次我起的「组集群」端口（同组多只臂共用一台集群、各用各的库，等价于 CI 里 service 容器的角色）；`5432` 是 CI 的值，不是脚本的假设——脚本只吃 URL/argv，端口无关。三只自起集群臂（`backup-purge-pg` / `backup-copies-purge-pg` / `messages-purge-pg`）的端口是脚本自己随机的，列里是**本次实测值**。
2. **PG 列**：全部是同一台集群 `show server_version` 的实测 `17.11`。其中 **9 只脚本自己不打印版本**（`account-suspend` / `admin-accounts-read` / `admin-flags` / `community` / `messages` / `migrations-negative` / `ocr-jobs` / `recognitions` / `speech` 只打印「迁移清单 26 个」），列值取自 runner 对同一集群的读数 ⇒ 见 §5 F2。
3. **迁移列**：`子集` = 脚本只 apply 它需要的那几段（刻意，不是缺迁移）；`26` = 全链 0001..0026；`脚本内 apply（未打印条数）` = 脚本确实 apply 了迁移但**不打印条数**，本页不替它编数字 ⇒ 见 §5 F5。

---

## 2. CI 接线三方对齐

### 2.1 四个数组的实读（`tests/unit/ci-real-pg-wiring.test.mjs`）

| 常量 | 位置 | 条数 | 成员 |
| --- | --- | --- | --- |
| `MANAGED_SCRIPTS` | `:91` | **14** | 13 只 `-pg` 臂 + `recognition-chain-e2e.mjs`（后者**不叫** `-pg`，不属于本页 23 只） |
| `FROZEN_MANAGED_SCRIPTS` | `:108` | **14** | 与上表逐条相同（冻结副本，改了要刻意留 diff） |
| `REQUIRED_STEP_ORDER` | `:147` | **14** | 同上，且**钉死执行顺序**（顺序有状态依赖：`account-deletion` 必须在 `admin-accounts-read` 之前、`admin-flags` 排最后等） |
| `SELF_CLUSTERED_SCRIPTS` | `:216` | **2** | `backup-purge-pg.mjs`、`backup-copies-purge-pg.mjs`（判据⑦⑧ 换成「必须给 `GY_PG_BIN`+`GY_I19_PG_ROOT`、不得 `CREATE DATABASE`」） |

另有 `FORBIDDEN_ESCAPE_HATCHES`（`:202`，`GY_ALLOW_SKIP` / `--allow-skip`）、`REQUIRED_POSTGRES_MAJOR = '17'`（`:205`）、`SELF_CLUSTERED_ENV`（`:228`，`GY_PG_BIN` 必须 `/bin$`、`GY_I19_PG_ROOT` 必须落在 `${{ runner.temp }}`）。

**⇒ 派单给的 14/14/14/2 逐条复核为真**，但要注意它的语义：这 14 条是**一个 job（`real-pg-integration.yml`）的受管清单**，不是「全仓真库臂总数」。

### 2.2 把 23 只按「接在哪」分堆

| 接在哪 | 只数 | 臂 |
| --- | --- | --- |
| `real-pg-integration.yml`（受管清单 13 只） | 13 | conversations / community / messages / favorites-history / account-deletion / admin-accounts-read / admin-flags / ocr-jobs / recognitions / account-suspend / speech / backup-purge / backup-copies-purge |
| 各自的 workflow（不在四个数组里，但**确实跑**） | 9 | auth-privacy + migrations-negative（`auth-privacy-postgres.yml:34,39`）、consent-grant + egress-ledger + egress-object-key（`consent-grant-postgres.yml:34,42,56`）、catalog（`catalog-postgres.yml:34`）、source-lifecycle（`source-lifecycle-postgres.yml:34`）、staging-intake（`staging-intake-postgres.yml:34`）、workbook-staging（`workbook-staging.yml:43`） |
| 只出现在 `package.json` | 0 | — |
| **哪里都没有** | **1** | **`messages-purge-pg`** |

交叉核对手法：对 23 个臂名逐个在 `.github/workflows/*.yml` 里找 `run:` 行（`<臂名>.mjs` 字面命中），再和四个数组、`package.json` 的 `test:integration:*` 三方对比。

### 2.3 `package.json` 侧的真值（4 条 `test:integration*` 里只有 2 条指向本页的臂）

```
test:integration:conversations-pg      = node tests/integration/conversations-pg.mjs
test:integration:backup-copies-purge-pg = node tests/integration/backup-copies-purge-pg.mjs
test:integration:recognition-chain-pg  = node tests/integration/recognition-chain-e2e.mjs   ← 不是 -pg 臂
```

⇒ **21 只臂在本机没有任何 npm 入口**，本地要跑只能翻 workflow 抄 env（本次审计为此自带 runner，见 §6）。这不是红色缺陷，但是「库里有脚本没人跑」的现实土壤之一 ⇒ §5 F3。

### 2.4 有没有「接了线但红了也不拦」的开关

对 `.github/workflows/*.yml` 全量搜 `continue-on-error` / `|| true` / `set +e`：**零命中**（唯一命中都是 `deploy-sql-gate.yml` 与 `real-pg-integration.yml:263` 里**明令禁止**它们的注释）。⇒ 22 只接了线的臂，红了就是真红，没有静默通道。

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

## 4. 未接线臂清单（1 只）

### `tests/integration/messages-purge-pg.mjs`

三重证据：

1. `tests/unit/ci-real-pg-wiring.test.mjs` 的四个数组（`MANAGED_SCRIPTS` / `FROZEN_MANAGED_SCRIPTS` / `REQUIRED_STEP_ORDER` / `SELF_CLUSTERED_SCRIPTS`）**都不含**它。
2. `.github/workflows/**` 里**没有任何** `run:` 提到它（对 23 个臂名做字面命中的全量扫描，只有它 0 命中）。
3. 它自己的原因条目就写在白名单里 —— `tests/unit/ci-integration-chain-structure.test.mjs:182-187`（数组 `UNWIRED_DECLARATIONS`，定义在 `:67`）逐字：

```
path: 'tests/integration/messages-purge-pg.mjs',
reason: '需真实 PG 17.11：自己用 `GY_PG_BIN`（含 `initdb`/`pg_ctl`）起临时集群、跑全链迁移与运行时角色授权，'
  + '再经真实 `purgeOwnerData` 取「本主体 messages 行数 → 0／他人行原样」的注销行数读数；未设 `GY_PG_BIN` 时'
  + '**显式打印「未取得，不是通过」并以 77 退出**（不提供 `--allow-skip`），故不进无 PG 的回环链。'
  + 'R28-W11 只交付脚本与证据，**尚未接进任何 workflow**（`.github/workflows/**` 不在本片范围内，CI 接线另开一单）。',
```

它的证据页 `docs/verification/gy-r28-w11-messages-purge-pg-20261021.md` §0④ 也如实自陈「没有被 CI 执行」。

**本次实测它是绿的**（8 条断言、10.3 s、端口 55762 收尾 free、数据目录已删）⇒ 风险不是「已经烂了」，而是**无人监护**：没有 job 会因为它的断言变红而挡住任何 PR。

---

## 5. 发现但未修（F1–F6）

本片红线：不修产品代码、不改脚本、不改 workflow。以下只列证据与建议，等指挥派单。

| # | 缺口 | 证据 | 建议（不在本片做） |
| --- | --- | --- | --- |
| F1 | **1 只真库臂完全未接线**（`messages-purge-pg`） | §4 三重证据；本次实测 8/8 绿 | 单开一单接线：要么进 `real-pg-integration.yml`（它是自起集群脚本，需同时进 `MANAGED_SCRIPTS`+`SELF_CLUSTERED_SCRIPTS`+`REQUIRED_STEP_ORDER`，并复用已有的装包 step），要么单开一个 `messages-purge-postgres.yml` |
| F2 | **9 只臂不打印 PG 版本** ⇒ 日志无法自证「跑在 17 而不是 16」 | §1 表注 2；`ci-real-pg-wiring.test.mjs:205` 只在 CI 侧钉了 `REQUIRED_POSTGRES_MAJOR='17'`，是**静态**判据，不是运行时读数 | 给这些脚本补一行 `show server_version` 输出（1 行改动 × 9 只，但要动脚本 ⇒ 不在本片） |
| F3 | **21 只臂没有 npm 入口** | §2.3：`package.json` 只有 3 条 pg 相关 `test:integration:*` | 本机复现成本高，容易演变成「没人跑」。可考虑补 `test:integration:real-pg` 聚合脚本，但要注意它必须能自起集群（否则本机仍跑不了） |
| F4 | **2 只臂收尾不打印 CLEANUP** | `backup-purge-pg` 打印 `CLEANUP=done（临时集群已停、数据目录已删…）`；`backup-copies-purge-pg` 与 `messages-purge-pg` **无此行**（实测端口/目录都干净，但日志里没有自证） | 补一行 `CLEANUP=done`（与 `backup-purge-pg` 同口径） |
| F5 | **4 只臂不打印迁移条数** | `catalog-pg` / `source-lifecycle-pg` / `staging-intake-pg` / `workbook-staging-pg` 的日志只有 PASS 行，无「迁移 N 个」 | 想在日志里判断它们是否真 apply 了全链 26 条，目前只能读源码 |
| F6 | **两只臂共用同一个库**（隐式顺序前提） | `auth-privacy-pg` 与 `migrations-negative-pg` 都用 `gengyun_auth_privacy_test`（CI 里也是同一个 URL 前缀，`auth-privacy-postgres.yml:36,41`） | 串行没问题；若将来并行跑这些 job，会互踩。建议各自独立库名 |

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

  `*_PG_ROOT` 只有这 3 只读（`backup-copies-purge-pg.mjs:97`、`backup-purge-pg.mjs:89`、`messages-purge-pg.mjs:92`）；**其余 20 只不读任何 root 变量**，它们吃 URL env 或 argv[2]（具体键名见 §1 表第 2 列）。
- **其余 20 只**：先起一台 17.11 集群（`initdb -U gengyun_ci_owner --pwfile` + `pg_ctl start`），再按表里第 2 列给 env（或 argv[2]）指向该集群里的专用库。
- 本次分组与端口（一只组内多臂共用集群、各用各库）：`55820`（13 只受管臂）、`55860`（auth-privacy + migrations-negative）、`55880`（catalog）、`55900`（consent-grant + egress×2）、`55920`（source-lifecycle）、`55940`（staging-intake）、`55960`（workbook-staging）。
- 串行总墙钟 ≈ **2 分 15 秒**（23 只读数之和 135.3 s；含集群起停与收尾约 4 min）。
- 收尾核对口径（本页每只都做过）：`Get-NetTCPConnection -LocalPort <port> -State Listen` 为空 + `<root>` 下除日志外无 `gy-*` 数据目录。

---

## 7. 「事实 vs 派单」逐条对照

| 派单说法 | 实测 | 结论 |
| --- | --- | --- |
| `tests/integration/` 下有 **23 个** `*pg*.mjs`，名单如派单 | 逐个 `readdirSync` + 名单比对：**恰好 23 只，名单与派单逐字一致**（无多、无少） | ✅ 派单正确 |
| CI 侧 `MANAGED_SCRIPTS` / `FROZEN_MANAGED_SCRIPTS` / `REQUIRED_STEP_ORDER` 各 **14** 条，`SELF_CLUSTERED_SCRIPTS` **2** 条 | `:91` 14 / `:108` 14 / `:147` 14 / `:216` 2 | ✅ 数字正确 |
| 「⇒ 23 只臂里**至少 9 只不在 CI 里跑**」 | 四个数组只覆盖 `real-pg-integration.yml` 一个 job；另外 **9 只在各自的 workflow 里跑**（§2.2）；真正未接线的**只有 1 只**（`messages-purge-pg`） | ❌ **推断不成立**：9 这个数字对得上「不在那 14 条里」，但对不上「不在 CI 里跑」 |
| 「每只脚本的 `*_PG_ROOT` 变量名不一样，去脚本里 grep `PG_ROOT` 确认」 | 只有 **3 只**读 `*_PG_ROOT`（2 只 `GY_I19_PG_ROOT` + 1 只 `GY_W11_PG_ROOT`）；其余 20 只读 URL env 或 argv，**完全不读 root** | ⚠️ 部分不成立（3 只而不是 23 只，且只有 2 个变量名） |
| 「真库臂默认数据目录根是 `os.tmpdir()`，本机 `initdb` 会 Permission denied」 | 对那 3 只自起集群臂成立（`:89 / :92 / :97` 都是 `?? tmpdir()`）；其余 20 只不起集群、与 `initdb` 无关 | ✅ 对 3 只成立 |
| 「`pg_ctl` 不能直接 `-o "-p 55688"`（pwsh 拆参），脚本内部 `spawnSync` 数组传参所以脚本自己能跑通」 | 逐条复现：手敲 `pg_ctl ... -o "-p N"` 确实被拆参；脚本内部全是数组传参 ⇒ 不受影响 | ✅ 正确 |
| 「产物：最大风险是 9 只可能已经烂掉但没人发现的假证据」 | 9 只全部实跑、全部绿（且 9 只全部接在各自 workflow 里）；真正的「无人监护」只有 `messages-purge-pg` | ⚠️ 风险方向对，对象错了 |

---

## 8. 本次审计的运行器（不进仓，仅供复核）

审计脚本与逐臂日志落在 worktree 之外的暂存目录 `E:\GengYunCommander\.pg17\tmp\arms-audit\`：

- `run.mjs`：按组起 17.11 集群 → 逐只串行跑 → 记录 `exit/ms/stdout` → 停集群、删数据目录、探活端口、列残留
- `_results/<臂名>.log`：每只臂的完整输出（含 `exit=` 头两行），23 份齐
- `_results/_cluster-<组>.json`：7 个组集群的 `{port, listening:false, dirGone:true, version:"17.11"}`

（这些文件**不提交**；本页只提交读数与本页本身。）


