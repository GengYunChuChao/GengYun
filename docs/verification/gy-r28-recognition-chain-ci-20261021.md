# R28-S65：识别端到端链路接真库 CI —— 第 13 个受管脚本，77 显式升级成硬失败

- 日期：2026-10-21
- 工作树：`E:\GengYunCommander\wt-r28-s65`，分支 `test/gy-r28-recognition-chain-ci`，base `aee9ecb145167fdeb63d2aa38721f52ec3c6d653`（本片 standalone）
- 本机：Windows 10 + PowerShell 5.1.26100.8875 + Node v24.16.0；本地 PG 17.11 二进制 `E:\GengYunCommander\.pg17\pgsql\bin`
- 日志（一次性本地目录，未入库）：`E:\GengYunCommander\.pg17\handoff\r28-s65-logs\`（`*.utf8.log` 是把 PS 5.1 的 UTF-16LE 重定向结果转成 UTF-8 的副本，正文逐字未改）

本片只做一件事：把 `tests/integration/recognition-chain-e2e.mjs`（仓内**唯一**的完整业务链路脚本）接进
`.github/workflows/real-pg-integration.yml` 的 job `real-pg-17-11`，并让它在 CI 里**不可能被悄悄跳过**。
被测脚本一个字节未改；`services/**`、`apps/**`、`packages/**`、迁移、角色 SQL、`deploy/**`、`deploy-sql-gate.yml`、
任何 `90-assert`／`contract-status.json` 全部未触碰。

## 0. 结论（一屏）

| 读数 | 接线前（`aee9ecb`） | 本片之后 |
| --- | --- | --- |
| `MANAGED_SCRIPTS` / `FROZEN_MANAGED_SCRIPTS` | 12 / 12 | **13 / 13**（逐字同集合；`REQUIRED_STEP_ORDER` 同步 13 项） |
| `real-pg-17-11` 的 step 数 | 16（2 `uses` + 1 `npm ci` + 13 `run`） | **17**（+1 真跑 step） |
| `real-pg-integration.yml` 行数 | 223 | **258**（+35 / −0） |
| 该脚本被哪个 workflow 真跑 | **无**（只有本机手工跑） | `real-pg-integration.yml:236-257` |
| 本机真库（**从 workflow 原样提取** run 块 + CI 同 env + `bash -e` 执行） | — | **exit 0**，`arm=pg PASS`，`合计 38 条证据行` |
| 负控制 A：step 的 env 丢 `RECOGNITION_CHAIN_PG_TEST_URL` | — | node **exit 77** + `arm=pg SKIP`；同一 run 块 ⇒ **exit 1** + `::error::…被跳过（exit 77）` |
| 负控制 B：库不存在 / 端口不通 | — | **exit 1**（非 0、非 77），`FAIL 断言失败（原始输出如下，未跳过、未吞错）` |
| 八道门禁 | — | **8/8 exit 0** |

一句话：**接线前它没有任何 CI 入口；接线后它在 CI 里只有两种结局 —— 真跑通过（exit 0）或红（exit 1），没有第三种。**
「被跳过」这个第三种结局，本 step 用 `rc==77 ⇒ ::error:: + exit 1` 显式掐掉了。

## 1. 立项依据

### 1.1 这个脚本是什么

`tests/integration/recognition-chain-e2e.mjs`（830 行）跑的是 GY-I06／I08／I09／I10 的**端到端**链路，
全程 **loopback 真 HTTP**（脚本内 `app.listen({ host: '127.0.0.1', port: 0 })`，监听端口每次现取）：

1. 上传识别（合成 `media_id` + 替身识别提供者）→ `202`；
2. 取结果（`queued → succeeded`）→ 可信度、理由、候选；
3. 结果读回 `GET /api/v1/recognitions/{id}`（`etag` 与 `job.result.value` **逐字段相等**）；
4. 加入识别历史（异步落库，有界等待）；
5. 历史列表（`created_at` 倒序、3 次读取顺序稳定）；
6. **越权隔离**（B 读 A 的识别／删 A 的历史 ⇒ `404`，与「不存在」同形）；
7. 删除历史 → 再读为空 → 同键重放幂等 → 换键再删 `404`；
8. 同分并列（`Top1=Top2` ⇒ 产品判 `uncertain`）与**正控制**（分数互不相同 ⇒ 判 `succeeded`）。

它有两个臂：`arm=memory`（内存 store，无外部依赖）与 `arm=pg`（真 PG 17）。真库臂只把**身份**（`0001`）
与**历史**（`0018`）落库，识别记录仍是替身 + 内存 store —— 仓内没有 PG 版识别 store。这个边界脚本自己
在日志里显式打印（`── 边界：本臂不落库 ──`），本页照抄，不夸大。

### 1.2 为什么此前不在 CI

三条硬前提没法在「无 PG 的回环链」里满足：

| 前提 | 具体约束 | 后果 |
| --- | --- | --- |
| 专用空库 | `preparePg()` 先数 `information_schema.tables` 里 `public` 下的表数，**必须为 0**（除非显式 `RECOGNITION_CHAIN_PG_RESET=1`） | 拿共享库跑会直接断言失败 |
| 硬钉库名 | `readPgUrl()` 断言 `protocol ∈ {postgres:,postgresql:}`、`url.search === ''`、`hostname ∈ {127.0.0.1,localhost,[::1]}`、`pathname === '/gengyun_recognition_chain_test'` | 连不上真库就没法跑 |
| 库 owner 身份 | 真库臂全程 `gengyun_ci_owner`（库属主），脚本自己**从不建角色**、也不用运行时角色 | 与其它受管脚本的角色编排零耦合 |

而 `npm run test:integration:http` 是**无 PG** 的回环链（`tests/unit/ci-integration-chain-structure.test.mjs`
守的就是它）：把本脚本挂进去，缺库时它只会打印 SKIP 并以 77 退出 ⇒ 整链显式失败。所以它在
`UNWIRED_DECLARATIONS` 里如实登记为「未接线」，声明**保留**（本片改的是 reason 的**事实描述**，不是删声明）。

### 1.3 `77` 的语义：未取得 ≠ 通过

脚本在缺 `RECOGNITION_CHAIN_PG_TEST_URL` 时**先跑内存臂**，然后打印
`arm=pg SKIP real PG17: … 本次运行**没有**验证真库持久化（不是通过，也不是失败）` 并以 **77** 退出
（POSIX 惯例 skipped）。77 只有在显式 `--allow-skip`／`GY_ALLOW_SKIP=1`（仅本机开发用）时才变 0。

在**本 workflow** 里这个 env 是我们自己传的 ⇒ 77 只可能意味着两件事之一：**env 传丢了**，或**脚本的跳过判据被改过**。
两者都是「本 step 悄悄没跑」，必须红。故 step 里 `rc == 77 ⇒ ::error:: + exit 1`。

## 2. 改动

全部改动落在 3 个文件（+ 本页）：`git diff --numstat` = `35 0` / `31 6` / `8 4`（插入 删除）。

### 2.1 workflow：新增一个 step（接在「备份副本域」之后，`.github/workflows/real-pg-integration.yml:236-257`）

```yaml
      - name: 识别端到端链路（上传→结果→历史→删除→读空）
        run: |
          set -euo pipefail
          psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_recognition_chain_test'
          rc=0
          node tests/integration/recognition-chain-e2e.mjs || rc=$?
          if [ "$rc" -eq 77 ]; then
            echo "::error::识别端到端链路的真库臂被跳过（exit 77）：连接串 env 传丢了，或脚本的跳过判据被改过。77 = 未取得，不是通过。"
            exit 1
          fi
          if [ "$rc" -ne 0 ]; then
            echo "::error::识别端到端链路失败（exit $rc）。"
            exit "$rc"
          fi
        env:
          PGHOST: 127.0.0.1
          PGPORT: '5432'
          PGUSER: gengyun_ci_owner
          PGPASSWORD: synthetic-ci-owner-only
          PGDATABASE: gengyun_ci_bootstrap
          RECOGNITION_CHAIN_PG_TEST_URL: postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:5432/gengyun_recognition_chain_test
          PGCLIENTENCODING: UTF8
```

四点设计意图：

1. `psql … CREATE DATABASE` 先建**专用空库**（与其余 12 个受管 step 同款），满足「空库」前提；
   `ON_ERROR_STOP=1` + `set -euo pipefail` ⇒ 建库失败立刻红，不会拿旧库凑。
2. `rc=0` + `|| rc=$?` 是**唯一**能同时分辨 77／非 0 的写法：`|| true` 会吞红（红线禁止），
   直接 `set -e` 又区分不了 77。
3. 77 分支 `exit 1`（不是 `exit 77`）：**不能让「跳过」以 77 的身份穿过 CI**——77 在 shell 里是「未取得」，
   但在这条 workflow 里它是「我们的 env 或判据坏了」，属于**故障**，必须以失败退出。
4. 非 77 的非 0 分支 `exit "$rc"`：真跑挂了就是红，且保留原始退出码。
   ⛔ 本 step 无 `continue-on-error`、无 `|| true`、无 `set +e`、无 `if: always()`（判据④扫的就是这四个）。

### 2.2 `tests/unit/ci-real-pg-wiring.test.mjs`：三处数组 + 一处识别口径

| 位置 | 改动 |
| --- | --- |
| `MANAGED_SCRIPTS` | 追加 `'tests/integration/recognition-chain-e2e.mjs'` ⇒ 13 条 |
| `FROZEN_MANAGED_SCRIPTS` | 同上（逐字同集合）⇒ 13 条 |
| `REQUIRED_STEP_ORDER` | 追加第 13 项（排在最后），配注释说明「空库／迁移子集／库 owner／为什么必须最后」 |
| `scriptsRunByWorkflow()` | 识别正则 `/node\s+(tests\/integration\/[A-Za-z0-9._-]+-pg\.mjs)/g` 放宽为 `…+ (?:-pg\|-e2e)\.mjs)/g` |

第四处**必须解释**：本脚本是受管清单里**唯一**文件名不叫 `-pg.mjs` 的（`-e2e.mjs`）。不给判据函数认这个后缀，
它永远进不了判据⑨的两侧；而一旦登记进 `MANAGED_SCRIPTS`，「workflow 侧拿不到它」就会变成**永久假红**。
放宽的是**被识别的脚本口径**，不是断言：判据⑨「双向相等」一个字没动，反向控制⑧ 的变异仍逐条判红
（单测 16/16 绿）。「前向⑦」的用例名与消息同步改成 `-pg.mjs`／`-e2e.mjs`，让报错点名的口径与实际一致。

### 2.3 `tests/unit/ci-integration-chain-structure.test.mjs:201-211`：把 reason 改成事实

`UNWIRED_DECLARATIONS` 里 `recognition-chain-e2e.mjs` 的 reason 由旧的「需 PG17 + 硬钉库名 + 只提
`npm run test:integration:recognition-chain-pg`」改写为**当班事实**：专用空库、真库臂只 apply `0001`+`0018`
两段并断言「恰好一次／重复 no-op」、全程库 owner、R28-S65 已接进 workflow 独立 step（受管脚本第 13 条，
自带 `CREATE DATABASE`，把缺 env 的 77 升级成硬失败），以及**为什么仍不进** `test:integration:http`（缺库即 77）。
声明**保留**（它确实仍不在回环链里）。

### 2.4 与派单的三处出入（如实）

| 派单原文 | 实测 | 处理 |
| --- | --- | --- |
| 「`MANAGED_SCRIPTS` 与 `FROZEN_MANAGED_SCRIPTS` 各 9→10」「`REQUIRED_STEP_ORDER` 第 10 项」 | base 实为 **12 条**（`account-suspend` 那条的注释被标成「10.」是旧编号残留） | 按实测做 **12→13**、第 **13** 项；不改任何既有条目 |
| 「真库臂自 apply **全链**迁移」 | 脚本只 filter `['0001','0018']` 并断言 `plan.applied` **恰好等于**这两段 | 证据页与 reason 统一写「两段子集」，并在 workflow 注释里写 ⛔「不要照抄成全链」 |
| §4 门禁 7：`tests/unit/deploy-sql-gate-forms.test.mjs` | 该文件在 base **不存在** | 派单已预判「不存在则跳过并注明」，见 §5 |

另外两处**实现层面**的自选动作（不是偏离，但值得记）：① 本机取证时把 step 的 `run:` 块
**用脚本从 YAML 里原样提取**成 `step-run.sh` 再 `bash -e` 执行，而不是手抄；② 本地建了与 CI 同名的
`gengyun_ci_owner` 角色与 `gengyun_ci_bootstrap` 靴库，让 env 与 service 容器 (`POSTGRES_USER`／`POSTGRES_DB`)
逐字对齐，避免「本地跑通、CI 身份不同」的假绿。

## 3. 本机真库读数

环境：`initdb -D E:\GengYunCommander\.pg17\data-r28s65 -U gengyun_cvm_owner --auth=trust -E UTF8 --locale=C`，
`port = 55662`、`listen_addresses = '127.0.0.1'`、`unix_socket_directories = ''`；
另建 `CREATE ROLE gengyun_ci_owner LOGIN SUPERUSER` 与 `CREATE DATABASE gengyun_ci_bootstrap OWNER gengyun_ci_owner`
（对齐 `postgres:17.11` service 的 `POSTGRES_USER`／`POSTGRES_DB`）。

执行方式：把 workflow 里该 step 的 `run: |` 块**原样**提取为 `step-run.sh`，环境变量与 step 的 `env:` **逐字一致**
（仅 `PGPORT` 由 `5432` 改为本机 `55662`），用 `bash -e step-run.sh` 跑 —— 即 GitHub Actions 在 Linux 上的默认 shell 行为。

| 读数 | 值 |
| --- | --- |
| step 整体退出码 | **0** |
| `psql … CREATE DATABASE gengyun_recognition_chain_test` | `CREATE DATABASE`（空库，`public` 下 0 张表） |
| 库属主 | `gengyun_recognition_chain_test` → `gengyun_ci_owner` |
| `SHOW server_version` | `17.11`（脚本断言 `/^17\./`） |
| 迁移 | `0001_initial_schema.sql + 0018_favorites_history.sql`（重复应用 no-op） |
| 真库臂 | `arm=pg PASS` |
| 证据行 | `合计 38 条证据行；耗时 770ms` |
| 末行 | `PASS recognition-chain-e2e (内存臂：loopback 真 HTTP；真库臂见上方 arm=pg 行)` |

逐段读数（`wf-equiv-positive-ci-env.utf8.log`，节选原文）：

```text
[GY-RECOG-E2E] real PostgreSQL patch: 17.11
[GY-RECOG-E2E] 迁移应用：0001_initial_schema.sql + 0018_favorites_history.sql（重复应用 no-op）
[GY-RECOG-E2E] arm=pg step=start loopback origin=http://127.0.0.1:55211 execution_mode=stub provider=substitute store=postgres(identity+history)/memory(recognition)
[GY-RECOG-E2E] arm=pg step=i06-upload status=202 job=3b5493a7-…-e202 recognition=5d6af54e-…-4af37 state=queued cache=no-store
[GY-RECOG-E2E] arm=pg step=i08-result job=3b5493a7-… state=succeeded elapsed=2ms model_version=stub-v1 candidates=[{"species_id":"synthetic_weed_a","rank":1,"model_score":0.64},{"species_id":"synthetic_weed_b","rank":2,"model_score":0.28}] reasons=[]
[GY-RECOG-E2E] arm=pg step=i08-readback GET /api/v1/recognitions/{id} ⇒ 200 etag="1" 与 job.result.value 逐字段相等
[GY-RECOG-E2E] arm=pg step=i09-history history=a8b66ac3-… rev=1 created_at=2026-10-21T07:41:36.226Z target={"type":"recognition","id":"5d6af54e-…","revision":1} job_state=succeeded reference_state=unavailable appeared_after_job=3ms
[GY-RECOG-E2E] arm=pg step=i09-replay 重放后该识别历史条数=1；提供者累计调用=2
[GY-RECOG-E2E] arm=pg step=i09-stable 3 次读取 id 顺序一致=["41eb895e-…","a8b66ac3-…"] created_at 倒序成立
[GY-RECOG-E2E] arm=pg step=pg-rows 直查 history：job_id=3b5493a7-… owner=78ca794f-… event_key=recognition:3b5493a7-… job_state=succeeded target=recognition:5d6af54e-…@1；users=2 行；他人历史=0；(owner,event_key) 唯一=1 行
[GY-RECOG-E2E] arm=pg step=i16-idor B 列表=空；B 读 A 识别=404（与不存在同形=true）；B 删 A 历史=404 NOT_FOUND；A 历史仍=2 条
[GY-RECOG-E2E] arm=pg step=i10-empty 全部删除后 GET /api/v1/history ⇒ {"items":[],"next_cursor":null}
[GY-RECOG-E2E] arm=pg step=pg-after-delete 直查 history 总行数=0（物理删除）；users 仍=2 行；history_idempotency=2 行（同键重放由真库台账裁决）
[GY-RECOG-E2E] arm=pg PASS
PASS recognition-chain-e2e (内存臂：loopback 真 HTTP；真库臂见上方 arm=pg 行)
```

注意 `users=2 行` 与 `他人历史=0` 是**真库直查**（`arm=pg step=pg-rows` / `pg-after-delete`）拿到的，
不是 HTTP 投影自证；删除后 `history 总行数=0` 也是物理删除的直查结果。

## 4. 两条负控制原文

### 4.1 负控制 A：`RECOGNITION_CHAIN_PG_TEST_URL` 丢了

A-1 直接跑脚本（不设 env）：**exit 77**，且打印 SKIP：

```text
[GY-RECOG-E2E] arm=pg SKIP real PG17: RECOGNITION_CHAIN_PG_TEST_URL 未设置 —— 本次运行**没有**验证真库持久化（不是通过，也不是失败）。
[GY-RECOG-E2E] EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0，⛔ 不得接进门禁）。
未取得 recognition-chain-e2e 完整链路：内存臂已通过，但真库持久化臂被跳过 —— 整体**不是**通过（见上方 arm=pg 行）。
```

（读数为 `NEG_A_NODE_EXIT=77`。若 77 能直接穿过 workflow，本步就会以「skipped」结绿。）

A-2 同一份 `step-run.sh`（其余 env 与 CI 逐字一致，只少 `RECOGNITION_CHAIN_PG_TEST_URL`）：**exit 1**，

```text
[GY-RECOG-E2E] arm=pg SKIP real PG17: RECOGNITION_CHAIN_PG_TEST_URL 未设置 —— 本次运行**没有**验证真库持久化（不是通过，也不是失败）。
::error::识别端到端链路的真库臂被跳过（exit 77）：连接串 env 传丢了，或脚本的跳过判据被改过。77 = 未取得，不是通过。
```

`NEG_A_SHELL_EXIT=1` ⇒ 「env 丢」在 CI 里是**红**，不是 skipped。

### 4.2 负控制 B：连不上真库（非 77 的非 0 必须原样红）

B-1 库不存在（URL 正确、端口可达，但 `gengyun_recognition_chain_test` 未建 —— 等价于有人删掉 `CREATE DATABASE` 那行）：**exit 1**

```text
[GY-RECOG-E2E] FAIL 断言失败（原始输出如下，未跳过、未吞错）：
error: database "gengyun_recognition_chain_test" does not exist
```

B-2 端口不通（`127.0.0.1:55999`，执行前 `Test-NetConnection` 已确认 closed）：**exit 1**，走的是**另一个** `::error::` 分支

```text
[GY-RECOG-E2E] FAIL 断言失败（原始输出如下，未跳过、未吞错）：
Error: connect ECONNREFUSED 127.0.0.1:55999
::error::识别端到端链路失败（exit 1）。
```

两条都**非 0、非 77** ⇒ 不会落进 77 分支被误读成「跳过」，也不会被吞成 0。

> 记账：B-2 第一次跑时误用了 `55663`，事后 `Test-NetConnection` 发现该端口上**另有**一个不属于本片的 PG 实例在听，
> 于是拿到的是服务端的 `role "gengyun_ci_owner" does not exist`（结论同样是 exit 1 + `::error::`，但错误性质不对题）。
> 已改用先确认 closed 的 `55999` 重跑，本页引用的是重跑后的原文。

## 5. 未取得

**没有在 GitHub 的 `ubuntu-24.04` runner 上真跑过。** 本片只做了本机 PG 17.11 取证 + 把 workflow 的 run 块原样提取执行；
「runner 上 `psql`／`npm ci`／`postgres:17.11` service 都在位」这件事由**既有** 12 条受管 step 的历史绿证明，
本 step 复用同一 job、同一 `PGUSER`／`PGDATABASE` 习俗，没有新增 runner 依赖。**首次真跑由 PR 的 CI 证明**，
本页不预先宣称它是绿的。

未覆盖（脚本自身已登记，本片不代它吹）：真实识别供应商（全程 `provider=substitute` + `execution_mode=stub`）、
真实图片上传（`media_id` 是合成的）、微信侧链路；识别记录的**持久化**仍是内存 store（真库臂只落身份与历史）。

`tests/unit/deploy-sql-gate-forms.test.mjs`（派单 §4 第 7 道门禁）：**本基线不存在该文件**，按派单预判跳过并在此注明。

## 6. 与 `recognitions-pg.mjs`（受管脚本第 9 条）的分工

两个脚本都碰「识别」，但**层次不同、互不替代**：

| | `tests/integration/recognitions-pg.mjs`（第 9 条，R28-S36 接） | `tests/integration/recognition-chain-e2e.mjs`（第 13 条，本片接） |
| --- | --- | --- |
| 层次 | **store 层 SQL 面**（直接打 PG） | **HTTP 端到端**（loopback 真 HTTP，逐接口） |
| 迁移 | 除 `0025` 外全部 → 再 `0025` | 只 `0001` + `0018`（断言恰好一次、重复 no-op） |
| 身份 | 建组角色 + 运行时角色（`gengyun_api_runtime`） | **只用库 owner**，从不建角色 |
| 库 | `gengyun_recognitions_test` | `gengyun_recognition_chain_test` |
| 验什么 | SQL 面：约束、索引、幂等台账、迁移可重放 | 业务面：上传→结果→可信度/理由→历史→读回→越权→删除→读空→重放→同分并列 |
| 失败面 | 迁移/约束/SQL 回归 | 接口契约、状态机、鉴权隔离、删除语义 |

一句话：**第 9 条证明「库里的识别数据面是对的」，本片证明「用户从上传到删空这一条路是通的」**。
两者都不覆盖真实供应商与真实图片，也都不进无 PG 的回环链。
