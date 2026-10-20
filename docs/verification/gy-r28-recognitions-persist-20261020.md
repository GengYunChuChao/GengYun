# GY-R28 S13 · 识别域 PostgreSQL 持久化（迁移 0025）— 证据页

- 写手：R28-S13（分支 `feat/gy-r28-recognitions-persist`，工作树 `E:\GengYunCommander\wt-r28-s13`）
- 本机真库：PostgreSQL **17.11**（`E:\GengYunCommander\.pg17\pgsql\bin`），`127.0.0.1:55613`，datadir `E:\GengYunCommander\.pg17\data-r28s13`
- 本页由**返修 1**（2026-10-20）新建：原片提交里没有这一页（`git cat-file -e origin/main:docs/verification/gy-r28-recognitions-persist-20261020.md` ⇒ exit 128），本节是返修 1 的取证记录。
- ⛔ CI **未重跑**（由指挥执行）；本文所有「绿/红」都是**本机同库同名同 env 复现**，不是 CI 结论。

---

## 本片对既有集成夹具的影响

### 1. 结论先说：两个脚本被点名，实测只有一个是真受影响

派单点名两个既有集成脚本「应当变红」，实测结果一个成立、一个不成立：

| 脚本 | 是否驱动识别写路径 | 装配与迁移 | 本片是否受影响 | 实测 |
| --- | --- | --- | --- | --- |
| `tests/integration/egress-ledger-pg.mjs` | **是**：`:192` `http('/recognitions', …)` 发 `POST /recognitions`，`:355`/`:388`/`:417`/`:477` 断言 202 | `:333` 装配 `executionMode:'real'` + `:280` 真连接池（受限 LOGIN，不注入 `recognitionStore`）⇒ 命中 `services/api/src/app.ts:952` 的 PG 分支；迁移清单 `:216` 是 0001/0003/0008/0009/0011 + `:222` 0014，**没有 0025** | **是**（已修，见 §3） | 改前 `EXIT=1`（503 ≠ 202）；改后 `EXIT=0`（`RESULT=PASS 12 组`） |
| `tests/integration/recognition-chain-e2e.mjs` | **否**：`buildArm()` 在 `:230` 写死 `APP_EXECUTION_MODE:'stub'`，并在 `:231` **显式注入** `recognitionStore: createMemoryRecognitionStore()` | 迁移清单 `:741` 是 `['0001','0018']`；`:743`–`:747` 断言「恰好应用 0001+0018」 | **否**（未改） | 改前/改后都 `EXIT=0`，两臂 PASS，共 38 条证据行；证据行自报 `execution_mode=stub provider=substitute store=postgres(identity+history)/memory(recognition)` |

**派单 §2.2 的前提（「`recognition-chain-e2e.mjs` 同样 real + 池驱动识别链 ⇒ 本地必红」）与实测不符**，我没有为了迎合派单去改它，理由与证据如下：

1. `app.ts:952` 的 PG 分支谓词是 `recognitionStore ?? (executionMode === 'real' && pool !== null ? PG : 内存)`。该脚本显式传了 `recognitionStore`，**又**把 `executionMode` 定成 `stub`——两个条件都不满足，PG 识别 store 在它里面是**不可达路径**。
2. 反向验证：我临时把 `0025` 加进 `:741` 的清单、并把 `:745` 的断言同步改成 `['0001','0018','0025']`，脚本**仍然** `EXIT=0`（38 条证据行不变，`store=…/memory(recognition)` 不变）；跑完后库里确实多出识别四表，但**识别记录一行都没写进 PG**（都落在内存 store）。⇒ 加 0025 只会在库里多建四张空表，不改变任何被测语义，反而会让读者误以为「该脚本覆盖了识别持久化」。
3. 因此该脚本**保持逐字节未改**（`sha256 233b9f1e3c46cd35fa0dce50130627c6fe87d335cd07a384eabcf2a62749714e`），改动面只有 `egress-ledger-pg.mjs` 一处。

> 附带发现（**未在本片修**，属文档与代码漂移）：该脚本 `:16`–`:17` 的头注释仍写「仓内**不存在** PG 识别 store（识别记录只活在进程内）」。`#333` 新增 `services/api/src/recognitions/store-pg.ts` 之后这句话已过期。本片只做夹具返修，不动该注释，避免在同一 PR 里混入与失效夹具无关的文本改动；建议由识别域下一片或 S24 一并订正。

### 2. 为什么 `egress-ledger-pg.mjs` 会红：不是新缺陷，是 `#333` 的接线让一条旧成功路径变成了 fail-closed

`#333` 之前，该脚本在 `executionMode:'real'` + 真池下拿到的识别 store 是**内存实现**，`POST /recognitions` 返回 202。`#333` 之后同一装配（不注入 store）会走 `services/api/src/recognitions/store-pg.ts`：

- `store-pg.ts:169`–`:172` 的探测是 `SELECT to_regclass('public.recognition_jobs') IS NOT NULL AND …` —— 只看**表在不在**，不依赖表级权限；
- 探测为 `missing` 时，**写类**方法在 `:484` 的 `requireTables()` 处抛 `RecognitionTablesMissingError`：`code=PROVIDER_UNAVAILABLE`、`retryable=false`、message 点名 `0025_recognitions_persistence.sql` 与「拒绝写入，避免静默丢数据」（`:129`–`:130`）；
- 于是 `POST /recognitions` 变成 **503**，而脚本 `:355` 断言 **202** ⇒ `503 !== 202`。

改前本机原始报错（`EGRESS_LEDGER_TEST_URL=postgres://postgres@127.0.0.1:55613/gengyun_egress_test`，`EGRESS_LEDGER_KEEP=0`，`HEAD f71f501`）：

```
PASS 1: fresh native PG17.11：0001/0003/0008/0009/0011 up，0011 down 后表与列如实消失，再 up 成功
…
PASS 5: buildApp(real + 真 PG 池 + 注入的合成 real 传输) 启动（后台域 real 仍 fail-closed，与本片无关）

AssertionError [ERR_ASSERTION]: {"error":{"code":"PROVIDER_UNAVAILABLE","message":"识别持久化表未迁移（0025_recognitions_persistence.sql）：拒绝写入，避免静默丢数据","retryable":false,"details":[]},"meta":{…,"execution_mode":"real"}}

503 !== 202

    at file:///E:/GengYunCommander/wt-r28-s13/tests/integration/egress-ledger-pg.mjs:322:10
```

这与 CI run `39425382301` 的 `consent-grant-postgres-17.11` job 失败**同型**（同一条 message、同一条断言、同一行号 `:322:10`）。

### 3. 为什么 fail-closed 是设计，不是本片要修的缺陷

识别 store 的三态（`store-pg.ts`）与同仓 OCR 域（`services/api/src/ocr/store-pg.ts`）**同源**：

| 状态 | 读类（`getJob`/`getRecognition`/`listSelections`） | 写类（建任务/落记录/提交终态/选择/幂等台账） |
| --- | --- | --- |
| 表齐备 | 正常读 | 正常写 |
| 表未迁移 | 返回 `null` / `[]`（无数据可读，不假装有） | **拒绝写入**（`PROVIDER_UNAVAILABLE`、`retryable=false`、点名 0025） |
| 探测本身故障 | 按既有分类折叠超时/不可用 | 同左 |

「未迁移还让写继续成功」= 受理了识别任务却把它写进一个**不存在**的地方 = **静默丢数据**。所以写类必须拒，这正是 `#333` 的设计意图，也是 `recognitions-pg.mjs` 的 `[M1b]` 段（`:318`–`:352`）专门断言的三态。

**与 `#323` 的 OCR 真红性质相反**：`#323` 那次是**读**路径被错折成 503（用户看不到已存在的数据），属缺陷；这次是**写**路径按设计拒写（数据无处可落），属正确行为。两次都表现成 503，但一个是「该给却不给」，一个是「该拒才拒」。

⇒ 修法只能是**补迁移**（让表真的存在），不能回退 `app.ts:952` 的接线，也不能把 `requireTables()` 改成静默放行。

### 4. 为什么首轮本机门禁没有抓到（口径要改）

首轮（`#333` 原片）跑的门禁是「本域脚本」：`recognitions-pg.mjs` + 单测 + 静态检查。它们全绿，因为：

- `recognitions-pg.mjs` **自己**应用 0025（`MIGRATION='0025_recognitions_persistence.sql'`，`:306`–`:354` 先跑「除 0025 外全部迁移」，再应用 0025），且用 **owner（超级用户）池**——它永远看不到「别的脚本用子集迁移库 + 受限角色驱动识别写路径」这条路径；
- 单测用的是假池 / 内存 store，不经过真实迁移库。

原来的口径（R27 片落下的）是：**「新接 PG 持久化 ⇒ 补跑 CI 的 4 个真库脚本」**。这条口径**太窄**，它按「脚本名清单」判定覆盖面，而真正的判定维度是**驱动面**：谁在 `real` + 真池 + 子集迁移库的装配下**打到了本域**。

**改正后的口径（本片起适用）**：

> 凡是以 `executionMode:'real'` + 真连接池 + **子集迁移库**驱动本域（含跨域脚本顺带驱动本域）的集成脚本，都必须跑；不能只跑「本域命名的脚本」。

按此口径，`egress-ledger-pg.mjs` 的主题是外发账本（不是识别域），但它顺带 `POST /recognitions` ⇒ 必须跑。这就是首轮漏掉的那一类。

### 5. CI 侧真红记录（只记录事实；CI 未重跑）

- run：`39425382301`
- job：`consent-grant-postgres-17.11`
- 失败 step：`Run psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_egress_test' && node tests/integration/egress-ledger-pg.mjs`
- 失败原文（摘录，断言体与 §2 的本机复现逐字同型）：

```
AssertionError [ERR_ASSERTION]: {"error":{"code":"PROVIDER_UNAVAILABLE",
"message":"识别持久化表未迁移（0025_recognitions_persistence.sql）：拒绝写入，避免静默丢数据",
"retryable":false,"details":[]}, … "execution_mode":"real"}

503 !== 202

    at …/tests/integration/egress-ledger-pg.mjs:322:10
```

- 本机复现：`HEAD f71f501`、库 `gengyun_egress_test`、同一 env（`EGRESS_LEDGER_TEST_URL` / `EGRESS_LEDGER_KEEP=0`）⇒ `EXIT=1`，同上原文（§2）。
- **CI 未重跑**；「修后绿」仅为本机读数（§6）。是否真绿以指挥重跑的 CI 为准。

### 6. 修法与本机读数

两处改动（都在 `tests/integration/egress-ledger-pg.mjs`）：

1. `:241` 在**0011 重新 up 之后**应用 0025：

   ```js
   await owner.query(sqlFile('migrations/0025_recognitions_persistence.sql'));
   ```

   放在这里的理由：`:223`–`:233` 的 0011 up→down→up 演练与三条断言（`export_writebacks` 消失 / `exports.cancelled_at` 列数 0 / `exports.object_key` 列数 1）**逐字未改**，0025 不参与那次演练（它是纯新增四表，与 `exports` 的列无关）。
2. `:267`–`:279` 给**本脚本的测试 LOGIN** 条件补四表 DML：

   ```js
   const recognitionTablesReady = (await owner.query(`SELECT to_regclass('public.recognition_jobs') IS NOT NULL AND …`)).rows[0].ok;
   if (recognitionTablesReady) {
     await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON recognition_jobs,recognition_records,recognition_selections,recognition_idempotency TO ${loginName}`);
   }
   ```

   这一处不是「给断言让路」，是**补上部署侧缺失的授权前提**：`services/api/db/roles/*.sql` 没有识别域角色文件，`deploy/postgres-cvm/sql/20-login-roles.sql` 也没有识别域 grant region（该文件只授 5 个 NOLOGIN 组 + 若干按域 region），而 `requireTables()` 的 `to_regclass` 探测**不依赖表级权限** ⇒ 表在、权限缺时真写语句以 **42501** 失败，被 `store-pg.ts:145` 折成 `PROVIDER_UNAVAILABLE`「识别数据库暂不可用」`retryable=true`（看起来像可重试的基础设施故障）。补授权的归属是 **S24**（部署授权区缺口，同型还有 messages / community / ocr 三域）；本片只让夹具等价于「部署时把识别四表授给 API 运行时角色」，并在注释里写明 **S24 落地后本行应删除**。

`if` 条件化**不是**静默放行：0025 若未落库，`GRANT … ON recognition_jobs` 会以 `42P01` 抢跑，把「未迁移」这条诊断掩盖成一条无关的角色授权错误；真正的诊断点在下面的 `POST /recognitions` ⇒ 503。故缺表时跳过授权，让下游断言如实变红——NC1 正是靠这一点仍报「识别持久化表未迁移」。

本机读数（同库同名同 env，PG 17.11 @ 55613）：

| 阶段 | 改动 | 读数 |
| --- | --- | --- |
| 改前（`HEAD f71f501`，文件 `sha256 43e947f5171aa5f127a1873110018da4b6a8017e39a656c49404f4fc47166f7f`，31194 B） | 无 | `PASS 1`–`PASS 5` 后 `EXIT=1`：503 `PROVIDER_UNAVAILABLE`「识别持久化表未迁移（0025…）：拒绝写入，避免静默丢数据」`retryable=false`；`503 !== 202` at `:322:10` |
| 中间读数（只加 0025，临时副本 `_tmp-nogrant-egress.mjs`） | `:241` 一行 | 仍 `EXIT=1`：503 `PROVIDER_UNAVAILABLE`「识别数据库暂不可用」`retryable=true`；`503 !== 202` at `:329:10`（受限 LOGIN 对四表零权限 ⇒ 42501） |
| 改后（最终字节 `sha256 f0f2206b03d22500958cef6479c8a1088a03df4266c51229631bdbf574f4d263`，34049 B） | `:241` + `:267`–`:279` | `PASS 1`–`PASS 12`，`RESULT=PASS 12 组；真实 PostgreSQL 17.11（本机隔离、仅回环）；未发出任何对外/付费请求`，`CLEANUP=done`，**`EXIT=0`** |

`0011` 回滚演练的三条断言（`:224`–`:233`）与 `PASS 1` 的 `say()` 文案逐字未改。脚本现有 **12** 个 `say()` 组（本机 `RESULT=PASS 12 组`）；旧证据页 `docs/verification/gy-i27-egress-ledger-pg-20261014.md:76` 记的是 `RESULT=PASS 11 组`（那是它当时的读数，本片未新增/删除任何 `say()` 组，也未去改那张旧页）。

### 7. 反证（临时篡改 ⇒ 必须重新变红，且逐字节还原）

**NC1（删掉应用 0025 的那一行）**——在**最终字节**上做（`sha256 f0f2206b…`，34049 B）：

- 补丁后：33971 B，`sha256 279b5fc539508cf072587400292b8bc1621e80441c0371a412d1de3ec887c636`（只少 `:241` 那一行）；
- 运行：`EXIT=1`；`PASS 1`–`PASS 5` 后
  `AssertionError … {"code":"PROVIDER_UNAVAILABLE","message":"识别持久化表未迁移（0025_recognitions_persistence.sql）：拒绝写入，避免静默丢数据","retryable":false,…,"execution_mode":"real"}` / `503 !== 202` / `at …/egress-ledger-pg.mjs:354:10`；
- 逐字节还原：`sha256 f0f2206b03d22500958cef6479c8a1088a03df4266c51229631bdbf574f4d263`（34049 B）⇒ **与改前相等**。

> 同一反证在注释改写前的版本（`sha256 c7e7f7d2…`，34298 B）也做过一次：同样 `EXIT=1`、同一条 message、`503 !== 202` at `:356:10`，还原后 `sha256 c7e7f7d2…` 相等。注释改写后重做，结论不变。

**NC2（把 0025 换成 `0024_ocr_persistence.sql`）**——同样在最终字节上：

- 补丁：`:241` 换成 `await owner.query(sqlFile('migrations/0024_ocr_persistence.sql'));`；
- 运行：**仍红**（`EXIT=1`；断言失败同一条 message「识别持久化表未迁移（0025_recognitions_persistence.sql）…」、`503 !== 202` at `:355:10`；进程随后在 libuv 收尾阶段另报 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`——这是 Node 在未捕获断言后关闭连接池的收尾崩溃，不影响断言结论）；
- 逐字节还原：`sha256 f0f2206b03d22500958cef6479c8a1088a03df4266c51229631bdbf574f4d263` ⇒ **与改前相等**。

两条反证的含义：变红**依赖**于「真的应用了 0025 这张迁移」，不是任意 `.sql` 都能让脚本变绿。

### 8. 影响面扫描：CI 里全部 16 个 `node tests/integration/*.mjs`

扫描方式：程序化抽取 `.github/workflows/*.yml` 里所有 `node tests/integration/<name>.mjs` 调用（去重 ⇒ **TOTAL_SCRIPTS=16**，与派单给的 16 一致），再对每个脚本读三类事实：① 是否出现 `/recognitions` 的 POST；② 装配里是否 `executionMode:'real'`；③ 是否拿到真池；④ 脚本内字面出现的迁移清单（对「应用全部迁移减自身」的脚本，清单列的是它显式点名/排除的那几张）。

| # | 脚本 | workflow | 驱动识别写路径 | 真池 + real | 应用的迁移（脚本内字面） | 本片是否受影响 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `auth-privacy-pg.mjs` | `auth-privacy-postgres.yml` | 否 | 是 | 0001、0003、0008 | 否 |
| 2 | `migrations-negative-pg.mjs` | `auth-privacy-postgres.yml` | 否 | 否（只驱动迁移器） | 合成迁移（0001_tampered / 0099 / 0100） | 否 |
| 3 | `catalog-pg.mjs` | `catalog-postgres.yml` | 否 | 是 | 0001、0002、0004、0005 | 否 |
| 4 | `consent-grant-pg.mjs` | `consent-grant-postgres.yml` | 否 | 是 | 0001、0003、0008、0009 | 否 |
| 5 | **`egress-ledger-pg.mjs`** | `consent-grant-postgres.yml` | **是**（`:192` POST，`:355` 断言 202） | **是** | 0001、0003、0008、0009、0011、0014、**0025（本片新增）** | **是（已修）** |
| 6 | `egress-object-key-pg.mjs` | `consent-grant-postgres.yml` | 否（只 `POST /synthesis`） | 是 | 0014、0015（并自复位到 0014-only） | 否 |
| 7 | `account-deletion-pg.mjs` | `real-pg-integration.yml` | 否 | 是 | 0016 | 否 |
| 8 | `admin-accounts-read-pg.mjs` | `real-pg-integration.yml` | 否 | 是 | 0021 | 否 |
| 9 | `admin-flags-pg.mjs` | `real-pg-integration.yml` | 否 | 是 | 0001、0003、0008、0009、0011、0020 | 否 |
| 10 | `conversations-pg.mjs` | `real-pg-integration.yml` | 否 | 是 | 0001、0002、0005、0008、0010、0012、0013 | 否 |
| 11 | `community-pg.mjs` | `real-pg-integration.yml` | 否 | 是 | 0020、0021、0001、0022 | 否 |
| 12 | `messages-pg.mjs` | `real-pg-integration.yml` | 否 | 是 | 0019 | 否 |
| 13 | `favorites-history-pg.mjs` | `real-pg-integration.yml` | 否 | 是 | 0001、0018 | 否 |
| 14 | `source-lifecycle-pg.mjs` | `source-lifecycle-postgres.yml` | 否 | 是 | 0001、0002、0004、0005、0006 | 否 |
| 15 | `staging-intake-pg.mjs` | `staging-intake-postgres.yml` | 否 | 是 | 0001、0002、0004、0005、0007 | 否 |
| 16 | `workbook-staging-pg.mjs` | `workbook-staging.yml` | 否 | 是 | 0001、0002、0004 | 否 |

独立复核结论：**16 个里只有 `egress-ledger-pg.mjs` 命中**（`recogPOST` 计数 6，其余 15 个全为 0），与指挥初判一致，没有第二个需要一并修的脚本。

补充事实（避免「为什么没扫到 `recognitions-pg.mjs`」的误读）：

- `.github/workflows/**` 里**没有任何** `recogniti*` 字样（程序化 grep 0 命中）⇒ `recognitions-pg.mjs` **未接进任何 workflow**；它在 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS` 里被如实登记为「本片仅落地脚本，CI 接线留后续片」。
- 仓内还有几个会 `POST /recognitions` 的集成脚本，但都**不在**这 16 个里，且不满足「real + 真池」：`recognitions-http.mjs` / `jobs-http.mjs` / `favorites-history-isolation-http.mjs` 显式注入内存识别 store；`ocr-http.mjs` 的 real 实例 `buildApp({config, store: 内存})` **不传池** ⇒ `app.ts:952` 走内存分支；`recognitions-pg.mjs` 自己应用 0025 且用 owner 超级用户池。它们都不是本片的失效面。

### 9. 本机门禁读数（全部为 `EXIT` 码；CI 未重跑）

| # | 门禁 | 读数 |
| --- | --- | --- |
| 1 | `npm run lint` | `EXIT=0`（两个 `tsc --noEmit` PASS + 仓库卫生扫描 PASS） |
| 2 | `npm run test:contract` | `EXIT=0`（tests 6 / pass 6 / fail 0） |
| 3 | `node --test --test-isolation=none tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` | `EXIT=0`（tests 19 / pass 19 / fail 0） |
| 4 | 全量串行单测 `node --test --test-concurrency=1 "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs" "tests/media/*.test.mjs" "tests/reference/*.test.mjs" "tests/moderation/*.test.mjs"` | `EXIT=0`（tests 2974 / pass 2973 / fail 0 / skipped 1 / duration 285325.9ms；skip 的是 `native separate-connection withdrawal and account state changes at guarded read boundary`，`# SKIP`，与本片无关） |
| 5 | `conversations-pg.mjs` | `EXIT=0`（12 条读数全部通过） |
| 6 | `community-pg.mjs` | `EXIT=0`（23 组） |
| 7 | `messages-pg.mjs` | `EXIT=0`（`ALL PASS`） |
| 8 | `favorites-history-pg.mjs` | `EXIT=0`（`ALL PASS (13 groups)`） |
| 9 | `recognitions-pg.mjs` | `EXIT=0`（30 条 PASS，2334ms） |
| 10 | `migrations-negative-pg.mjs` | `EXIT=0`（11 组；A0 基线 `0001–0025` 25 行台账） |
| 11 | `egress-ledger-pg.mjs`（本片修改的脚本） | `EXIT=0`（`RESULT=PASS 12 组`，`CLEANUP=done`） |
| 12 | `recognition-chain-e2e.mjs` | `EXIT=0`（两臂 PASS，38 条证据行，936ms） |

> 第 11 项第一次跑曾 `EXIT=1`，报 `4 !== 0` at `:212`：原因是前一步「CI 链路等价」用 `EGRESS_LEDGER_KEEP=1` 保留了角色与表，直接重跑时开场「`public` 表数=0」断言如实变红——是**库状态污染**，不是代码缺陷。按脚本约定先删角色、复位空库后重跑即 `EXIT=0`（上表读数）。

### 10. CI 链路等价（按 `consent-grant-postgres.yml` 的顺序连跑）

`consent-grant-postgres.yml` 的 job 顺序是：`consent-grant-pg.mjs` → 建 `gengyun_egress_test` 并跑 `egress-ledger-pg.mjs`（`EGRESS_LEDGER_KEEP=1`）→ `egress-object-key-pg.mjs`（同库、同一 URL）。本机按同顺序、同 env（`W116_PSQL` 指向本机 psql）复现后两项：

| 步骤 | 读数 |
| --- | --- |
| `EGRESS_LEDGER_KEEP=1` + `EGRESS_LEDGER_TEST_URL=…/gengyun_egress_test` 跑 `egress-ledger-pg.mjs` | `RESULT=PASS 12 组`；`CLEANUP=skipped（EGRESS_LEDGER_KEEP=1：角色/表/夹具行按要求保留…）`；`EXIT=0` |
| 同一 URL 接跑 `egress-object-key-pg.mjs` | `RESULT=PASS 28 组`；`CLEANUP=done`；**`EXIT=0`**（其中 PASS 10/18 是撤列级授权 ⇒ 42501 ⇒ 503 的故障注入，属预期） |

⇒ 本片补的 0025 与条件授权对后继脚本**无副作用**：`egress-object-key-pg.mjs` 在同一库上仍全绿。

### 11. 未取得 / 没做到

- **CI 未重跑**：run `39425382301` 的结论仍是红；本页所有绿均为本机读数。是否真绿以指挥重跑为准。
- **生产侧识别域授权未补**：`services/api/db/roles/` 与 `deploy/postgres-cvm/sql/20-login-roles.sql` 仍没有识别域角色/grant region（归 S24）；本片夹具自授只是等价化，不代表生产已可运行。
- **未在受限运行时角色下跑识别 store 的全套方法**：只验证了 `POST /recognitions` 这一条链（外加脚本原有的 12 组账本断言），没有逐一验证 `recognition_*` 四表的 UPDATE/SELECT 权限边界。
- **未逐个真跑 16 个脚本**：本片跑了派单列的 6 个真库脚本 + 修改脚本 + `recognition-chain-e2e.mjs`；其余 9 个只做了静态扫描判定（`recogPOST=0` 且不满足 real+池+本域写路径），没有为「不受影响」另跑一遍。
- **`recognition-chain-e2e.mjs` 未改**：派单 §2.2 与实测冲突，已按实测执行并在此如实记录；其头注释 `:16`–`:17` 的过期表述未订正。
