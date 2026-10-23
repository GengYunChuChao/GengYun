# GY-I23 集成脚本覆盖：把「已在 main、却没有任何门禁执行」的脚本逐条摊开

- 日期：2026-10-20
- 分片：GY-I23（派单 `.pg17/dispatch/integration-script-coverage.md`）
- 分支：`test/gy-integration-script-coverage`，基线 `upstream/main` = `31a746d`
- 环境：Windows（PowerShell 5.1，本机无 `pwsh`）、Node v24.16.0、`npm ci --offline --ignore-scripts`（103 packages）、PostgreSQL 17.11 位于 `E:\GengYunCommander\.pg17\pgsql\bin`（**只**用于本片第 2 项的可行性验证，未进任何门禁）

## 0 结论（先看这三条）

1. `tests/integration/` 共 **45** 项：**13** 项被 npm 脚本引用、**10** 项被 `.github/workflows/*.yml` 引用（`profile-ui-http.test.mjs` 两边都有）、**23 项两边都没有**。全表见 §2。
2. 派单第 2 项（把 `tests/integration/user-chain-e2e.mjs` 接进 `test:integration:http`）：**未取得**。它需要真实 PostgreSQL 17；缺 PG 时只打印 3 行 SKIP 并**以 77 退出**（§3.1；改前 `2de2fc3` 是 `exit 0`＝假绿），接进无库的链会让整链失败，按派单「不改 CI 结构、落未取得并停止本项」处理。`package.json` **未改**。
3. 派单第 3 项：新增 `tests/unit/integration-script-coverage.test.mjs`，把「纯回环／E2E 类脚本必须被某个 `scripts.*` 引用」变成会红的结构断言；**只允许 1 条豁免**（就是第 2 项那个未接线脚本），豁免表冻结在测试里，新增豁免必须改测试，并自带反向控制证明「缺一个就红」。

一句话概括本片的取舍：**宁可让一个脚本红着被记成「未取得」，也不要让它以 SKIP 的形式混进门禁的绿灯里。**

## 1 缺口事实（逐条实测，不是推断）

### 1.1 没人引用的那个脚本

```
Select-String -Path package.json -Pattern 'user-chain-e2e' -Encoding UTF8      →  hits=0
Select-String -Path .github/workflows/*.yml -Pattern 'user-chain-e2e'          →  hits=0
```

即：`tests/integration/user-chain-e2e.mjs`（673 行）在 main 上**不被任何 npm 脚本、任何 CI step 执行**。

### 1.2 但它并不是「没人知道」

`tests/unit/ci-integration-chain-structure.test.mjs:163` 已经在白名单里登记了它：

```
line=148: path: 'tests/integration/user-chain-e2e.mjs',
```

该测试的第 4 条子用例要求「`tests/integration/*.mjs` 必须 `wired ∨ declared`」——**声明即放行**。所以现有门禁对这个缺口的态度是「已登记，永不变红」。

### 1.3 为什么「声明即放行」不够（本片动机）

`ci-integration-chain-structure.test.mjs` 是**宽口径**守卫：它管「每个文件至少被提到一次」，判的是『有没有登记』，不是『会不会被执行』。于是出现这种组合：

- 一个纯回环 HTTP/E2E 脚本，明明在本机可以跑、也能给出真读数；
- 因为它没进 `scripts.*`，`npm run test:integration:http` 永远不执行它；
- 结构守卫里它有一条白名单理由，于是门禁一直是绿的。

**绿的原因不是「它跑过了」，而是「它被登记过了」。** 这正是本片要堵的口子：新增的窄口径守卫只看 `scripts.*` 的实际引用，且只覆盖「纯回环／E2E」这一类（不含 `-pg.mjs`、不含 `*.ps1`、不含夹具），与既有宽口径守卫是分层关系，互不替代：

| 维度 | 既有 `ci-integration-chain-structure.test.mjs` | 新增 `integration-script-coverage.test.mjs` |
| --- | --- | --- |
| 扫描范围 | 全部 `tests/integration/*.mjs` | 仅纯回环／E2E（`*-http.mjs`、`*-http.test.mjs`、`*-e2e.mjs`） |
| 判定 | `wired ∨ declared`（声明即放行） | **必须在 `scripts.*` 里被引用**（声明不算） |
| 白名单 | 声明表，允许写理由豁免 | 冻结的 1 条豁免 + 反向控制 |
| 数字事实 | 冻结清单只有 8 条（链现在 13 条，`⊇` 允许追加） | 当前纯回环类 13 条＝12 条已接线 + 1 条冻结豁免 |

## 2 清单表（`tests/integration/` 全 45 项）

口径：`npm` 列 = 在 `package.json` **全部** `scripts.*` 文本里出现 `tests/integration/<文件名>`；`CI` 列 = 在 `.github/workflows/*.yml` 全文里出现该路径。本机实测（PowerShell 5.1 读 `package.json` 必须带 `-Encoding UTF8`，否则 `ConvertFrom-Json` 抛「传入的对象无效」、`NPM` 列会全空——这是踩过的坑，命令见 §0 注释）。

`test:integration:http` 的 13 段按 `package.json:24` 的顺序编号为「链内第 N 段」。

| 脚本 | 分类 | 需要什么（前置） | npm | CI | 判定与理由 |
| --- | --- | --- | --- | --- | --- |
| `knowledge-consumer-http.mjs` | 纯回环 HTTP | 无（vm 加载真实 `miniprogram/utils/knowledge-api.js` + `knowledge-http-fixture.cjs` 棚造服务，`listen(0,'127.0.0.1')`） | `test:integration:http`（链内第 1 段） | — | 已接线 |
| `miniprogram-login-loop.mjs` | 纯回环 HTTP | 无（`buildApp` + `APP_EXECUTION_MODE:'stub'` 内存库；合成微信 code/身份） | `test:integration:http`（链内第 2 段） | — | 已接线 |
| `admin-http.mjs` | 纯回环 HTTP | 无（合成身份 + 内存 store；34 项 operationId 映射表） | `test:integration:http`（链内第 3 段） | — | 已接线 |
| `profile-ui-http.test.mjs` | 纯回环 HTTP | 无（缺省 PGlite＝进程内 WASM，见 `profile-ui-fixture.mjs:25`；native PG 只是可选覆写） | `test:integration:http`（链内第 4 段） | `local-wechat.yml` | 已接线（两边都有） |
| `recognitions-http.mjs` | 纯回环 HTTP | 无（合成身份 + 替身提供者 + 内存 store） | `test:integration:http`（链内第 5 段） | — | 已接线 |
| `jobs-http.mjs` | 纯回环 HTTP | 无（真实装配 `buildApp`；替身提供者） | `test:integration:http`（链内第 6 段） | — | 已接线 |
| `favorites-history-isolation-http.mjs` | 纯回环 HTTP | 无（合成身份 + 可控可见性替身） | `test:integration:http`（链内第 7 段） | — | 已接线 |
| `ocr-http.mjs` | 纯回环 HTTP | 无（真实装配 + 本机回环；未联网、未连库） | `test:integration:http`（链内第 8 段） | — | 已接线 |
| `account-deletion-http.mjs` | 纯回环 HTTP | 无（合成身份 + 内存 store + stub/real 两种接线） | `test:integration:http`（链内第 9 段） | — | 已接线 |
| `speech-http.mjs` | 纯回环 HTTP | 无（`buildApp` + 替身/脚本化注入提供者） | `test:integration:http`（链内第 10 段） | — | 已接线 |
| `tts-http.mjs` | 纯回环 HTTP | 无（替身提供者；产物只登记摘要、不落盘） | `test:integration:http`（链内第 11 段） | — | 已接线 |
| `rejections-http.mjs` | 纯回环 HTTP | 无（真实装配 + 合成审核/资料端口；14 个用例里 2 个是**显式 skip**，理由见 `rejections-http.mjs:628`、`:634`） | `test:integration:http`（链内第 12 段） | — | 已接线 |
| `transcript-confirm-http.mjs` | 纯回环 HTTP | 无（真实装配 + 替身转写；内存 store） | `test:integration:http`（链内第 13 段） | — | 已接线 |
| `user-chain-e2e.mjs` | 端到端 E2E（真实 PG17） | **真实 PostgreSQL 17**：`USER_CHAIN_PG_BIN`（含 `initdb.exe`）＋可写且不存在的 `USER_CHAIN_PG_DATADIR`（默认建在 `%TEMP%`，本机 ACL 可能拒绝，见 §3.3） | — | — | **本片唯一豁免**：实测 119 条断言通过；缺 PG17 时打印 3 行 SKIP 并以 **77 退出**（改前 `2de2fc3` 是 0＝假绿）⇒ 接进无库的链会整链失败，故按派单第 2 项落「未取得」并不改链（§3、§7、§8） |
| `account-deletion-pg.mjs` | 需真实 PG | 一次性集群 + 硬钉库名 `gengyun_deletion_test`（argv 自建自删；`I19_DELETION_TEST_DEBUG` 为调试开关） | — | — | `*-pg.mjs`：按派单第 1 项排除，理由＝需要 PG，不得算进窄口径守卫；无 npm/CI 引用，既有结构守卫已声明放行 |
| `account-suspend-pg.mjs` | 需真实 PG | 两段连接串 argv（管理员 URL + 运行时角色 URL）；`I22_KEEP_ROLES` 调试开关 | — | — | 同上 |
| `admin-flags-pg.mjs` | 需真实 PG | 一次性集群 + 硬钉库名 `gengyun_flags_test` | — | — | 同上 |
| `auth-privacy-pg.mjs` | 需真实 PG | `AUTH_PRIVACY_TEST_URL` | — | `auth-privacy-postgres.yml` | CI 有跑、npm 链不跑：这是「本地门禁缺一段」而非「无人执行」 |
| `catalog-pg.mjs` | 需真实 PG | `DATABASE_TEST_URL` | — | `catalog-postgres.yml` | 同上 |
| `consent-grant-pg.mjs` | 需真实 PG | `CONSENT_GRANT_TEST_URL` | — | `consent-grant-postgres.yml` | 同上 |
| `egress-ledger-pg.mjs` | 需真实 PG | `EGRESS_LEDGER_TEST_URL`、`EGRESS_LEDGER_KEEP` | — | `consent-grant-postgres.yml` | 同上（与下一项成对） |
| `egress-object-key-pg.mjs` | 需真实 PG | `EGRESS_LEDGER_TEST_URL`、`W116_PSQL`；须紧跟 `egress-ledger-pg.mjs` 且由其 `EGRESS_LEDGER_KEEP=1` 留下账本 | — | `consent-grant-postgres.yml` | 同上（顺序敏感，不能单独接） |
| `favorites-history-pg.mjs` | 需真实 PG | `FAVORITES_HISTORY_PG_TEST_URL`；未设则**显式 SKIP + exit 77**（仅 `--allow-skip`／`GY_ALLOW_SKIP=1` 才 0） | — | `real-pg-integration.yml` | `*-pg.mjs`：不进无 PG 的回环链（需 PG）；CI 侧由 `real-pg-integration.yml` 用独立测试集群真跑——本行原登记为「已声明、无门禁」，R27-S4 接线后订正（§9）；该脚本原先也是「缺环境就静默绿」的形状，本片第二个提交已改成 77（§8.3） |
| `messages-pg.mjs` | 需真实 PG | 一次性集群 + 硬钉库名 `gengyun_messages_test`（连接串走 argv，不走 env） | — | `real-pg-integration.yml` | `*-pg.mjs`：不进无 PG 的回环链（需 PG）；CI 侧由 `real-pg-integration.yml` 用独立测试集群真跑——本行原登记为「已声明、无门禁」，R27-S4 接线后订正（§9） |
| `migrations-negative-pg.mjs` | 需真实 PG | `MIGRATIONS_NEGATIVE_TEST_URL`；自建自删 3 个库 | — | `auth-privacy-postgres.yml` | 同上（CI 有跑） |
| `source-lifecycle-pg.mjs` | 需真实 PG | `DATABASE_TEST_URL`（argv 里 9 处调用） | — | `source-lifecycle-postgres.yml` | 同上（CI 有跑） |
| `staging-intake-pg.mjs` | 需真实 PG + Python | `DATABASE_URL`、`STAGING_INTAKE_TEST_URL`、`PYTHONPATH`、`STAGING_PYTHON`（argv 29 处） | — | `staging-intake-postgres.yml` | 同上（CI 有跑；依赖最重） |
| `workbook-staging-pg.mjs` | 需真实 PG + Python | `STAGING_PG_TEST_URL`、`PYTHON`、`GITHUB_STEP_SUMMARY` | — | `workbook-staging.yml` | 同上（CI 有跑） |
| `knowledge-native-pg.ps1` | 开发辅助脚本（PowerShell） | 本机 PG；手工起库辅助 | — | — | `.ps1` 不是 node 测试、无断言语义；仅 `docs/verification/local-knowledge-wiring-20261011.md:53,57` 引用 |
| `profile-ui-fixture.mjs` | 夹具（模块，非入口） | 被 `profile-ui-http.test.mjs` import；缺省 PGlite、可选 native PG | — | — | 无独立断言：不是脚本而是被 import 的模块（本身不可执行） |
| `knowledge-http-fixture.cjs` | 夹具（模块，非入口） | 被 `knowledge-consumer-http.mjs` `require` | — | — | 同上（`createFixture` 提供 `listen(0)` 棚造服务） |
| `favorites-history-isolation-http.reverse-control.mjs` | 反向控制运行器 | 故意**不**进门禁：它验证「把隔离拆掉后必须红」 | — | — | 设计如此：接入链会让整链变红；main 的声明理由即此 |
| `demo-reference.cjs` | 静态 Demo 服务 | 只读 `docs/ui-demo/demo.html`，`listen(3131)` | — | — | 不是测试：无断言、无 PASS/FAIL 语义，手工对照 UI Demo 用 |
| `knowledge-native-consumer.mjs` | 本机工具（组合演练） | 隔离的原生 PG + 外部「组合目录 / runtime 目录」参数 | — | — | 需本机目录参数与真实 PG：本片范围外；none 类清单里已按「本机工具」单列 |
| `local-knowledge-smoke.mjs` | 本机工具（组合演练） | 需先跑 `tools/local-dev` 生成 `.local/local-dev` | — | — | 同上（`tools/local-dev` 目录存在，但没有 npm 脚本编排它） |
| `local-dev-demo-align.cjs` | 本机工具（微信开发者工具） | 官方微信开发者工具 + 官方 `miniprogram-automator` + SDK 目录/输出目录 argv（`local-dev-demo-align.cjs:5,17,25`） | — | — | 需图形化模拟器与本机真机/开发者工具会话，进不了无头门禁；只被 `docs/verification/*.md` 引用 |
| `local-dev-detail-route.cjs` | 本机工具（微信开发者工具） | 同上（SDK 目录 + 输出目录 + 端口 argv） | — | — | 同上 |
| `local-dev-knowledge-geometry.cjs` | 本机工具（微信开发者工具） | 同上 | — | — | 同上 |
| `local-dev-knowledge-ui.cjs` | 本机工具（微信开发者工具） | 同上 | — | — | 同上 |
| `local-dev-login-detail.cjs` | 本机工具（微信开发者工具） | 同上 | — | — | 同上 |
| `local-dev-profile-location.cjs` | 本机工具（微信开发者工具） | 同上 | — | — | 同上 |
| `local-dev-profile-ui.cjs` | 本机工具（微信开发者工具） | 同上 | — | — | 同上 |
| `local-dev-ui.cjs` | 本机工具（微信开发者工具） | `node tests/integration/local-dev-ui.cjs <官方SDK目录> <输出目录> [宽度=320] [自动化端口=9422]` | — | — | 同上 |
| `local-dev-ui-controls.cjs` | 本机工具（微信开发者工具） | 同上 | — | — | 同上 |
| `local-dev-wechat.cjs` | 本机工具（微信开发者工具） | 同上 | — | — | 同上 |

统计口径自检（**`31a746d` 快照**，本片当时实测）：45 行；`npm` 有引用 13 行；`CI` 有引用 10 行；两者都无 23 行（= 1 个 E2E + 5 个仅声明的 `-pg` + 4 个夹具/辅助 + 12 个本机工具 + 1 个 `.ps1`）。⚠ 两处后补（R27-S4，`ba6ea9f`）：`favorites-history-pg.mjs`／`messages-pg.mjs` 的 `CI` 列已改为 `real-pg-integration.yml`，故**按本表这 45 行的范围**，当下的 `CI` 列应是 **12** 行、两者都无 **21** 行、**表内**仅声明的 `-pg` **3** 行；其余数字（含「45 行」这个总数）仍是 `31a746d` 的原始快照，主仓库此后新增的文件（`conversations-pg.mjs`、`community-pg.mjs`、`admin-accounts-read-pg.mjs`、`backup-purge-pg.mjs`）未并入本表。⚠ **本表这 3 行不得读成绝对口径**：仓库在 `ba6ea9f` 实有 **18** 个 `-pg.mjs`，其中**既无 npm 也无 CI 的是 5 个**——`account-deletion-pg`／`account-suspend-pg`／`admin-accounts-read-pg`／`admin-flags-pg`／`backup-purge-pg`；本片接线后仍无门禁的仍是这 5 个。绝对口径的三档读数与取数命令见 §9。

**关于「需要什么＝无」这 13 行**：这是**实测结论**，不是推断——§6.3 的整链在本机（无 PG、无外网、仅回环端口）`exit 0` 跑完，而链里就是这 13 条。

## 3 `user-chain-e2e.mjs`：本机两侧读数（第 2 项判定的全部依据）

### 3.1 无 PG17 时：3 行 SKIP，**`exit 77`**（未取得）

**改后（HEAD，`eec7c06` 起）逐字**：

```
node tests/integration/user-chain-e2e.mjs
SKIP real PG17 user chain: 未找到 PostgreSQL 17 的 bin 目录（设 USER_CHAIN_PG_BIN，或把 initdb 放进 PATH）。
     本次运行没有起库、没有跑链路 —— 不是通过，也不是失败。
EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。
EXITCODE=77
```

第三行是脚本自己打印的「EXITCODE=77…」说明行（改前这一行是空行），第四行是 shell 读到的退出码；`--allow-skip`／`GY_ALLOW_SKIP=1` 时第三行换成 `EXITCODE=0（…已显式授权…）`、退出码 0。**跳过＝未取得，默认 77**（POSIX skipped 惯例）：77 不会被 `&&` 当成功，所以把它接进无库的链只会**整链失败**，而不是静默绿。

**改前（第一提交 `2de2fc3`）逐字——这就是当时被记成「静默绿灯」的假读数**：

```
node tests/integration/user-chain-e2e.mjs
SKIP real PG17 user chain: 未找到 PostgreSQL 17 的 bin 目录（设 USER_CHAIN_PG_BIN，或把 initdb 放进 PATH）。
     本次运行没有起库、没有跑链路 —— 不是通过，也不是失败。
EXITCODE=0
```

（改前第三行为空行，退出码 0。）**0 条断言、0 步、退出码 0**——若接进 `test:integration:http`，在没有 PG17 的开发机与 CI 上它会稳定打印两行 SKIP 并让整链继续绿。这一形状在本片第二个提交里被改成 77（§8），三条同类脚本（`favorites-history-pg.mjs`、`migrations-negative-pg.mjs`）一并改。

### 3.2 有 PG17 时：两遍确定性通过

第 1 遍（`USER_CHAIN_PG_BIN=E:\GengYunCommander\.pg17\pgsql\bin`，`USER_CHAIN_PG_DATADIR=<工作区外可写目录>`）：

```
[pg] server_version=17.11
[pg] migrations=20（重复应用 0 条）
[api] http://127.0.0.1:63541 execution_mode=real favorites_pg=true
PASS 用户链路端到端：119 条断言，6 步，耗时 8421 ms（PostgreSQL 17.11 / http://127.0.0.1:63541）
[pg] 一次性集群已停止，数据目录已逐个文件删除
EXITCODE=0
```

第 2 遍（全新数据目录）：`PASS 用户链路端到端：119 条断言，6 步，耗时 8293 ms（PostgreSQL 17.11 / http://127.0.0.1:64081）`，`EXITCODE=0`。

前提一条：`USER_CHAIN_PG_DATADIR` 必须显式给一个**工作区内、且尚不存在**的可写路径——缺省时 `initdb` 会把数据目录建在 `%TEMP%` 下，本机 ACL 会拒绝（§3.3）。两遍都给了它，才有上面的确定性通过。

6 步覆盖（逐字摘）：登录 200/令牌 43 字符；作物 `crop_rice`/水稻、地区 `330100`/杭州市@`mca-xzqh-2023`；`PUT` 后 `revision=2`；未覆盖地区 `→0`；`ETag="1"` 六字段 + `source` 一致、不存在 `→404 NOT_FOUND`；收藏 `201`→重复同 id→PG 1 行→他人 `404`→缺 `If-Match` `428`→取消 `200` 后 0 行；退出后 `/auth/session`、`/me/profile`、`/favorites`、`/knowledge/{id}`、`/catalog/crops` 全 `401 SESSION_EXPIRED` 且封套同形，不带令牌全 `401 SESSION_REQUIRED`。

结论：**脚本本身是好的**，不是「不该接」，而是「接进门禁的前提还不存在」。

### 3.3 顺带记录一个环境坑（不是脚本缺陷）

第一次带 `USER_CHAIN_PG_BIN` 直接跑，`initdb` 默认把数据目录建在 `%TEMP%` 下，逐字失败：

```
FAIL 用户链路端到端：Command failed: ...\initdb.exe -D C:\Users\MR\AppData\Local\Temp\gengyun-user-chain-pg-17348-mvffmwvf -U postgres -A trust -E UTF8 --locale=C
initdb: error: could not create directory "C:/Users/MR/AppData/Local/Temp/gengyun-user-chain-pg-17348-mvffmwvf": Permission denied
（已跑 0 条断言，126 ms）
```

对照实验证明是本机对 `initdb` 写 `%TEMP%` 的 ACL/沙箱限制：`New-Item` 在 `%TEMP%` 建目录成功，`initdb -D <工作区内路径>` 成功（`EXIT_WS=0`），仅 `initdb -D <TEMP 下路径>` 失败（`EXIT_TEMP=1`）。脚本自身的 `finally` 即便失败也会 `pg_ctl stop` 并逐文件清理数据目录。**给 `USER_CHAIN_PG_DATADIR` 一个工作区外的可写路径即可**；数据目录必须**不存在**（脚本自建）。

## 4 npm 脚本：改前 ＝ 改后（本片没动 `package.json`）

改前与改后都为 `package.json:24` 的同一行（13 段）：

```
"test:integration:http": "node tests/integration/knowledge-consumer-http.mjs && node tests/integration/miniprogram-login-loop.mjs && node tests/integration/admin-http.mjs && node tests/integration/profile-ui-http.test.mjs && node tests/integration/recognitions-http.mjs && node tests/integration/jobs-http.mjs && node tests/integration/favorites-history-isolation-http.mjs && node tests/integration/ocr-http.mjs && node tests/integration/account-deletion-http.mjs && node tests/integration/speech-http.mjs && node tests/integration/tts-http.mjs && node tests/integration/rejections-http.mjs && node tests/integration/transcript-confirm-http.mjs"
```

派单第 2 项允许的「新增脚本段」为**空**——不是遗漏，是第 2 项落「未取得」（§3、§7）。本片对 `package.json` 零改动，`git diff --numstat upstream/main HEAD` 里能看到这一点（§6.5）。

## 5 守卫测试设计（`tests/unit/integration-script-coverage.test.mjs`）

### 5.1 判类口径（窄）与扫描范围

只扫「纯回环／E2E」这一档，判类函数 `isPureHttpOrE2e(fileName)`：

- `-http.mjs`、`-http.test.mjs`、`-e2e.mjs` ⇒ 入选（当前共 **13** 个候选 ＝ **12 个已接线 + 1 个冻结豁免**）；
- `-pg.mjs`、`.ps1`、`.cjs`、`*-fixture.*`、`local-dev-*`、`reverse-control`、`demo-reference` 等 ⇒ 一律**不入选**（派单第 1 项与第 3 项都要求「不许把 PG 扫进来」）。

引用判定：把 `package.json` 里**所有** `scripts.*` 的命令文本拼在一起，要求 `tests/integration/<文件名>` 这个**完整相对路径**出现。用完整路径而不是裸文件名，避免「`admin-http.mjs` 被 `admin-http.mjs.bak` 或注释里出现」这类假阳性。

### 5.2 两条出路：接线，或进冻结豁免表

- 默认出路：接进某个 `scripts.*`（派单只要「某个」脚本，本片不改链，故现有 12 条纯回环已满足）。
- 唯一豁免：`tests/integration/user-chain-e2e.mjs`（理由：需真实 PG17；缺 PG 时打印 SKIP 并**以 77 退出**＝未取得，接进无库链会让整链失败，故不改链；前置＝CI 提供 PG17 与可写数据目录，并单独开带 PG 的 workflow）。
- 豁免表被**冻结**（`FROZEN_EXEMPTION_PATHS`）+ 每条必须写 `reason`（≥60 字符、必须提到 PG/PostgreSQL、**必须含 `77` 与 `PG17` 关键词，且不得再写「以 0 退出」**），**新增豁免必须改测试**；豁免项若哪天被接线、被删除、或不再符合判类口径，测试同样会红（防白名单腐烂）。

### 5.3 六个用例（其中两个是反向控制）

1. **前向守卫**：读真实目录 + 真实 `package.json`，断言「未接线的纯回环类」集合为空；同时反空转（`pureScripts.length >= 12`），避免哪天正则失配导致「扫了个寂寞还全绿」。
2. **反向控制（接线口径）**：在内存里注入一个**不落盘**的假文件 `tests/integration/guard-probe-not-wired-http.mjs`——先断言它既不在磁盘上、也没被任何脚本引用，再断言守卫函数**抛出**且消息**点名**该文件；然后逐条证明「把它接进脚本 ⇒ 转绿」「加一条不相干脚本 ⇒ 救不了」「走豁免出口 ⇒ 也生效」。**不改 `package.json`、不写脏文件**。
3. **豁免表锁定**：冻结路径比对、豁免项必须真实存在、必须仍在判类口径内、必须**真的**没被引用、`reason` 长度与关键词，以及本片新加的三条事实锁（理由必须含 `77`、必须含 `PG17`、不得再写「以 0 退出」）。
4. **判类边界**：`-pg.mjs` 一律不入选（且数量 ≥12）、夹具/反向控制/`local-dev-*`/`demo-reference`/`.ps1` 不入选、链上那 12 条纯回环必须被扫到。
5. **整链跳过必须给 77**：扫全部 `tests/integration/*.mjs`，凡「脚本自己 `console.log/error` 打印 SKIP」却在其后窗口内没有**真的退出码语句**（`process.exit(77)`／`process.exitCode = 77`／`return 77;`）的一律红，消息逐个点名文件；`*-e2e.mjs` 还必须在输出里写明 `EXITCODE=77`。反空转：至少扫到 3 个有整链 SKIP 分支的脚本且其中必须有 `-e2e.mjs`。
6. **反向控制（跳过口径）**：零出口假脚本必红并点名、写明 77 的才绿、有 `exit(77)` 但缺 `EXITCODE=77` 文案的也红、用例级 `test(..., { skip })` 与完全没有 skip 的脚本都不得误伤。

真实输入与反向控制输入走**同一个**断言函数（`assertAllWired`），因此「反向控制的红」证明的就是「真实缺口会红」。

### 5.4 真实数据探针（证明豁免表不是遮羞布）

用临时探针脚本（工作区外，跑完即删）直接调用上面的导出函数跑到真目录：

```
PURE_COUNT=13            ← 13 = 12 条已接线 + 1 条豁免
MISSING_WITHOUT_EXEMPTIONS=[tests/integration/user-chain-e2e.mjs]
MISSING_WITH_EXEMPTIONS=[]
```

即：**把豁免表清空，真实世界里唯一会红的就是那一条**。豁免不是给多个脚本开后门。

## 6 门禁实跑读数（四条，全部本机实跑）

### 6.1 `git diff --check`

```
git add -A && git diff --check        → 无输出（0 行）
git diff --check HEAD                 → 无输出（0 行）
```

`git diff --check` 只查**工作区未暂存**内容：新文件在 `git add` 之后必须用 `git diff --check HEAD` 才算真的被查过（否则「新文件里有行尾空格」会被静默放过）。两条都是 0 行。

### 6.2 守卫测试

```
node --test tests/unit/integration-script-coverage.test.mjs
✔ 前向守卫：每个纯回环／E2E 集成脚本都被某个 npm 脚本引用，或已在豁免表登记 (2.2135ms)
✔ 反向控制：塞进一个未接线的纯脚本，同一断言必须红并点名它 (3.0604ms)
✔ 豁免表锁定：只能是被裁决过的文件，且理由必须写明所需前置 (1.1865ms)
✔ 判类口径边界：不扫 PG／夹具／本机工具脚本，但链上的纯回环必须被看见 (0.8797ms)
✔ 整链跳过必须给 77：打印 SKIP 却没给 77 出口的脚本一律红（点名文件） (16.7299ms)
✔ 反向控制：零出口的假 SKIP 脚本必须红，写明 77 的才绿，用例级 skip 不误伤 (1.1988ms)
ℹ tests 6
ℹ pass 6
ℹ fail 0
EXITCODE=0
```

反向控制的「红」读数（同一测试内，逐字断言）：注入 `tests/integration/guard-probe-not-wired-http.mjs` 后 `assertAllWired` 抛出的消息里必须出现该路径；未接线状态下 `unreferencedPureScripts` 返回 `['tests/integration/guard-probe-not-wired-http.mjs']`；把它写进脚本文本后返回 `[]`。

第三个用例里另有**理由事实锁**的反向控制（第三个提交新增）：把豁免理由换回旧事实「以 0 退出 ⇒ 静默绿灯」→ `assertExemptionReason` 抛错且消息点名 `guard-probe-stale-reason-e2e.mjs`；换成一版根本不提 77 的理由 → 抛错且点名 `guard-probe-noseven-reason-e2e.mjs`。两条都红，说明「理由必须含 77 与 PG17、且不得再写『以 0 退出』」这三条锁真的会拦人，不是摆设。

### 6.3 `npm run test:integration:http`（核心门槛，真跑）

```
> gengyun@0.0.0 test:integration:http
> node tests/integration/knowledge-consumer-http.mjs && ... && node tests/integration/transcript-confirm-http.mjs
（13 段顺序执行，330 行日志）
EXITCODE=0
Select-String -Path <日志> -Pattern 'user-chain'  →  0 命中
```

13 段各自的关键 PASS 行（逐字，按链内顺序）：

| 段 | 脚本 | 关键 PASS 行（逐字） |
| --- | --- | --- |
| 1 | `knowledge-consumer-http.mjs` | `PASS 9 loopback HTTP groups; actual client; synthetic identity/data/server; no production API or PG claim` |
| 2 | `miniprogram-login-loop.mjs` | `PASS 11 groups; source_kind=synthetic; memory store; not WeChat/device/native PG evidence` |
| 3 | `admin-http.mjs` | `PASS 组数=30，FAIL 组数=0`（另附 34 项 operationId 映射表：「映射表覆盖 operationId 数：34 / 34」） |
| 4 | `profile-ui-http.test.mjs` | `PASS PGlite, serialized limited SET ROLE; synthetic identity/catalog fixture; real loopback HTTP and actual frontend modules; no suppliers` |
| 5 | `recognitions-http.mjs` | `PASS GY-I09 loopback HTTP integration (synthetic identity + stub provider + memory store)` |
| 6 | `jobs-http.mjs` | `PASS 15 loopback HTTP groups; real assembly (recognition + transcription job sources); synthetic identity; stub providers (替身); loopback only, no supplier, no PG, no real sample` |
| 7 | `favorites-history-isolation-http.mjs` | `PASS favorites-history-isolation-http; synthetic identities + controllable visibility substitute; real loopback HTTP; no PG, no supplier, no WeChat devtools` |
| 8 | `ocr-http.mjs` | `PASS 14 组：经真实装配的 app（buildApp）+ 本机回环 HTTP；合成身份/替身提供者/内存 store；未联网、未连库、未调真实供应商` |
| 9 | `account-deletion-http.mjs` | `PASS GY-I19 account-deletion loopback HTTP integration (synthetic identities + memory stores + stub/real wiring arms)` |
| 10 | `speech-http.mjs` | `PASS 14 loopback HTTP groups; real assembly via buildApp (app.ts 仅追加注入项，默认零端口注入); ... no real ASR sample` |
| 11 | `tts-http.mjs` | `CHECKS pass=42 fail=0` + `RESULT=PASS 真实产品装配（buildApp）+ 本机回环 HTTP；合成身份 + 替身提供者 + 内存 store；未发出任何对外/付费请求` |
| 12 | `rejections-http.mjs` | `ℹ tests 14 / ℹ pass 12 / ℹ fail 0 / ℹ skipped 2`（skip 为 `rejections-http.mjs:628`、`:634` 两个显式「未取得」声明，整段仍 `exit 0`） |
| 13 | `transcript-confirm-http.mjs` | `PASS 6 groups; loopback only, stub substitute ASR, no database, no external network` |

**新增脚本段：无**（第 2 项未取得，链未改）。补一句现在的事实：`user-chain-e2e.mjs` 缺 PG17 时以 **77** 退出（§3.1、§8），所以「强行接进链」的结果不是静默绿，而是**无库环境整链失败**——这正是本片不改 `test:integration:http` 的理由：它需要的是 PG，不是被跳过。

### 6.4 全量单测

```
node --test "tests/unit/*.test.mjs"
ℹ tests 1739
ℹ suites 0
ℹ pass 1738
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 76206.3609
EXITCODE=0
```

唯一 skip 是**既有**的 `native separate-connection withdrawal and account state changes at guarded read boundary # SKIP`（native 分支用例，与本片无关）；本片新增的 6 个用例计入 1738 个 pass 之内。

### 6.5 改动量（累计 `31a746d..HEAD`，含三个提交）

```
git diff --numstat 31a746d HEAD
526	0	docs/verification/gy-i23-integration-script-coverage-20261020.md
10	2	tests/integration/favorites-history-pg.mjs
9	2	tests/integration/migrations-negative-pg.mjs
17	1	tests/integration/user-chain-e2e.mjs
4	2	tests/unit/ci-integration-chain-structure.test.mjs
395	0	tests/unit/integration-script-coverage.test.mjs
（另：6 files changed, 961 insertions(+), 7 deletions(-)）
```

`package.json`、`services/**`、`packages/**`、`apps/**`、`miniprogram/**`、迁移、契约、`.github/workflows/**` 全部 **0 行改动**——本片没有为了让门禁变绿而改任何产品代码或 CI 结构；`test:integration:http` 一行未动（§4 逐字即现状）。

### 6.6 收工状态

```
git status --porcelain      → 0 行（三个提交都已落地，工作树干净）
```

## 7 未取得项（如实登记，不伪造通过）

| 项 | 内容 | 现状 | 所需前置 | 为什么本片不解决 |
| --- | --- | --- | --- | --- |
| 第 2 项 | 把 `tests/integration/user-chain-e2e.mjs` 接进 `test:integration:http` | **未取得**：本机可跑通（§3.2），但需要真实 PG17；缺 PG 时 3 行 SKIP + **`exit 77`**（改前 `2de2fc3` 是 0）⇒ 接进无库链会整链失败 | ① CI/开发机提供 PostgreSQL 17 的 bin（`USER_CHAIN_PG_BIN`）与可写数据目录（`USER_CHAIN_PG_DATADIR`）；② 单独开带 PG 的 workflow 或带 PG 的 npm 脚本（`test:integration:user-chain`），**不要**塞进无 PG 的 `test:integration:http` | 派单第 2 项明令「若它需要 PG／网络则不改 CI 结构、落未取得并停止本项」；且 `ci-integration-chain-structure.test.mjs` 的冻结链与 `.github/workflows/*.yml` 的 job 结构本片都不许动 |
| 第 1 项（衍生） | 本片登记的 **5** 个「既无 npm 也无 CI 引用」的 `-pg.mjs`（`account-deletion-pg`、`account-suspend-pg`、`admin-flags-pg`、`favorites-history-pg`、`messages-pg`） | 当时为「已声明、无门禁」；**R27-S4 接线后（`ba6ea9f`）**：`favorites-history-pg`／`messages-pg` 已由 `real-pg-integration.yml` 真跑。⚠ **绝对口径**（仓库全部 `-pg.mjs`，不是「本片登记的 5 个」这个范围）：`-pg.mjs` 共 **18** 个，接线后**仍无门禁的是 5 个**——`account-deletion-pg`、`account-suspend-pg`、`admin-accounts-read-pg`、`admin-flags-pg`、`backup-purge-pg`（本片登记的 5 个里剩下 3 个未接；差额 2 个＝`admin-accounts-read-pg`／`backup-purge-pg`，它们是本片之后才新增的文件）。三档读数与取数命令见 §9 | 与上一条同源：需要 PG 环境 | 接线由后续片（R27-S4）在 `real-pg-integration.yml` 内完成，未改本片的链与判类；本片只被允许改 `package.json` 脚本与新增测试/文档 |
| 第 1 项（衍生） | 12 个本机工具（10 个 `local-dev-*.cjs` + `knowledge-native-consumer.mjs` + `local-knowledge-smoke.mjs`）不进任何无头门禁 | 设计如此 | 微信开发者工具 + `miniprogram-automator` + 本机 `.local/local-dev` 目录 | 图形化模拟器会话无法在无头 CI 里稳定复现；本片只登记理由不硬接 |

补充：本片**不**主张「所有 45 项都该进 `test:integration:http`」。正确的分层是——纯回环／E2E 必须被 `scripts.*` 真的执行（本片已把它变成会红的断言）；需要 PG/Python/图形模拟器的那些，靠各自的 workflow（已有 7 个 workflow 覆盖 10 个脚本）与本机手工证据页承担。

## 8 追加：跳过即未取得——整链跳过必须给 77

### 8.0 假绿是怎么发生的

§7 第 2 项把 `user-chain-e2e.mjs` 登记为「未取得」，但那个「未取得」在**退出码上是隐形的**：缺 PG17 时脚本打印 3 行 SKIP 后 `exit 0`。任何 `&&` 串联、`npm run` 链、CI 的 `run:` 行都会把这次运行读成**通过**——一条需要真库的链路在缺库时「绿着什么都没跑」。

这不是 `user-chain-e2e.mjs` 一家的毛病。`tests/integration/` 里凡「缺前置 ⇒ 打印 SKIP ⇒ `exit 0`」的脚本都有同一个病；反过来，`node:test` 的**用例级** `{ skip }` 只是少跑一两个用例、同段其余用例照跑、段仍 `exit 0`，语义不同，不算假绿（见 §8.3）。

本片把判据收紧成一条：**跳过即未取得，退出码 77**（POSIX「skipped」惯例）。默认 77，只有显式 `--allow-skip`／`GY_ALLOW_SKIP=1` 才降级为 0（本机开发用，⛔ 不得进门禁）；真跑通过仍 0、真失败仍非 0。

### 8.1 改前读数（逐字）

无 PG17（不设 `USER_CHAIN_PG_BIN`，PATH 里也没有 `initdb`）：

```
$ node tests/integration/user-chain-e2e.mjs
SKIP real PG17 user chain: 未找到 PostgreSQL 17 的 bin 目录（设 USER_CHAIN_PG_BIN，或把 initdb 放进 PATH）。
     本次运行没有起库、没有跑链路 —— 不是通过，也不是失败。

$ echo $LASTEXITCODE
0
```

第三行是空行（脚本原文如此）。**问题就是最后那个 0。**

同形状的两处（改前，均 `exit 0`）：`favorites-history-pg.mjs` 在 `FAVORITES_HISTORY_PG_TEST_URL` 未设置时打印 `SKIP real PG17: …（不是通过，也不是失败）。` 后 `process.exit(0)`；`migrations-negative-pg.mjs` 在 `MIGRATIONS_NEGATIVE_TEST_URL` 未设置时打印 3 行 SKIP 后 `process.exit(0)`——文件头当时还明写「退出码 0，绝不静默绿」（原文第 8 行），「绝不静默绿」只兑现在**日志**上，退出码上没有兑现。

### 8.2 改后读数（逐字）

```diff
--- a/tests/integration/user-chain-e2e.mjs
+++ b/tests/integration/user-chain-e2e.mjs
@@ 缺 PG17 的分支 @@
     console.log('SKIP real PG17 user chain: 未找到 PostgreSQL 17 的 bin 目录（设 USER_CHAIN_PG_BIN，或把 initdb 放进 PATH）。');
     console.log('     本次运行没有起库、没有跑链路 —— 不是通过，也不是失败。');
-    return 0;
+    if (ALLOW_SKIP) {
+      console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
+      return 0;
+    }
+    console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。');
+    return 77;
   }
```

`ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1'`；文件头补「退出码」段（0／77／非 0 三档＋开关说明）。`favorites-history-pg.mjs`、`migrations-negative-pg.mjs` 同形状改（`process.exit(0)` → `process.exit(77)`，各留 `--allow-skip` 出口），后者第 8 行「退出码 0」改为「退出码 77＝未取得」。

改后逐字（同机、同无 PG 条件）：

```
$ node tests/integration/user-chain-e2e.mjs
SKIP real PG17 user chain: 未找到 PostgreSQL 17 的 bin 目录（设 USER_CHAIN_PG_BIN，或把 initdb 放进 PATH）。
     本次运行没有起库、没有跑链路 —— 不是通过，也不是失败。
EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。
EXITCODE=77
```

```
$ node tests/integration/user-chain-e2e.mjs --allow-skip
SKIP real PG17 user chain: 未找到 PostgreSQL 17 的 bin 目录（设 USER_CHAIN_PG_BIN，或把 initdb 放进 PATH）。
     本次运行没有起库、没有跑链路 —— 不是通过，也不是失败。
EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。
EXITCODE=0
```

`GY_ALLOW_SKIP=1` 与 `--allow-skip` 同读数（三行、`EXITCODE=0`）。

```
$ node tests/integration/favorites-history-pg.mjs
SKIP real PG17: FAVORITES_HISTORY_PG_TEST_URL 未设置 —— 本次运行没有验证真库持久化（不是通过，也不是失败）。
     运行方式：FAVORITES_HISTORY_PG_TEST_URL=postgres://postgres@127.0.0.1:5432/gengyun_favorites_history_test node tests/integration/favorites-history-pg.mjs
EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。
EXITCODE=77
```

```
$ node tests/integration/migrations-negative-pg.mjs
SKIP migrations-negative-pg：MIGRATIONS_NEGATIVE_TEST_URL 未设置，三臂 A/B/C 均未执行（不算通过）。
  原因：半截失败／重放／回滚必须对真实 PostgreSQL 17.11 取证，无库时不伪造读数，也不静默绿。
  启用：MIGRATIONS_NEGATIVE_TEST_URL=postgres://<user>@127.0.0.1:<port>/<test_db>（维护连接须可 CREATE/DROP DATABASE）。
EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。
EXITCODE=77
```

有 PG17 时行为不变（§3.2 那两遍 `PASS … 119 条断言，6 步` 仍 `exit 0`；`catch` 分支仍 `return 1`）。真跑的前提是 `USER_CHAIN_PG_BIN` 指向含 `initdb.exe` 的目录，并给 `USER_CHAIN_PG_DATADIR` 一个**尚不存在**的可写路径（缺省落 `%TEMP%`，受本机 ACL 限制会 `Permission denied`，见 §3.3）。

### 8.3 同类扫描：谁在「整链跳过却 exit 0」

判据：`Select-String -Path tests/integration/*.mjs -Pattern 'SKIP '` ＋ 逐个读跳过分支的退出路径。

| 脚本 | 跳过形态 | 改前退出码 | 本片处置 |
| --- | --- | --- | --- |
| `tests/integration/user-chain-e2e.mjs` | 整链：缺 PG17 二进制，一条断言都不跑 | **0（假绿）** | **改**：默认 77，`--allow-skip`／`GY_ALLOW_SKIP=1` 取 0 |
| `tests/integration/favorites-history-pg.mjs` | 整链：`FAVORITES_HISTORY_PG_TEST_URL` 未设 | **0（假绿）** | **改**：同上 |
| `tests/integration/migrations-negative-pg.mjs` | 整链：`MIGRATIONS_NEGATIVE_TEST_URL` 未设，三臂 A/B/C 全不跑 | **0（假绿）** | **改**：同上（CI 在 `.github/workflows/auth-privacy-postgres.yml:39-41` 恒设该 env，跳过路径不会在 CI 触发 ⇒ 不改 CI 行为） |
| `tests/integration/rejections-http.mjs` | **用例级**：`test('SKIP AC08/AC16 …', {skip})`（:628）、`test('SKIP AC29 …', {skip})`（:634） | 0（段内其余用例真跑，`tests 14 / pass 12 / skipped 2`） | **不改**：只少跑两个需要真实供应商的用例，其余断言照跑，不是「整链未取得」；把它也算 77 会让「部分未取得」与「完全没跑」混为一谈 |
| `tests/integration/speech-http.mjs` | 无 SKIP 分支（缺前置是真失败） | — | 不改（无病） |
| `tests/integration/transcript-confirm-http.mjs` | 无 SKIP 分支 | — | 不改（无病） |
| `tests/integration/ocr-http.mjs` | 无 SKIP 分支 | — | 不改（无病） |
| `tests/integration/tts-http.mjs` | 无 SKIP 分支 | — | 不改（无病） |
| 其余 `tests/integration/*-pg.mjs`（account-deletion／account-suspend／admin-flags／auth-privacy／catalog／consent-grant／egress-ledger／egress-object-key／messages／source-lifecycle／staging-intake／workbook-staging） | 无 SKIP 分支：缺连接串时直接断言失败 | 非 0 | 不改（本就非 0，不假绿） |
| `local-dev-*.cjs`、`demo-reference.cjs`、两个夹具、`knowledge-native-pg.ps1` | 无空跑分支（本机工具／夹具，缺参数即报错） | — | 不改 |

结论：**只有 3 个脚本**是「整链跳过却 exit 0」，全部已改；其余要么没有跳过形态，要么是**用例级** skip，刻意不动。

### 8.4 守卫测试新增用例

`tests/unit/integration-script-coverage.test.mjs` 追加两个用例（导出纯函数，输入可注入）：

```js
const SKIP_OUTPUT_RE = /console\.(?:log|error)\(\s*[`'"][^`'"]*SKIP/g;
const EXIT_77_RE = /process\.exit\(\s*77\s*\)|process\.exitCode\s*=\s*77\b|return\s+77\s*;/;
export function wholeChainSkipWithout77({ fileName, source })      // 打印整链 SKIP 但附近没有 77 退出码语句 ⇒ true
export function e2eSkipExitCodeTextMissing({ fileName, source })   // *-e2e.mjs 缺「EXITCODE=77」说明 ⇒ true
```

设计要点：

1. **只认脚本自己打印的 SKIP**（`console.log/error` 里的 `SKIP` 字样）。`test('SKIP …', {skip})` 这种用例级 skip 天然不入判据——§8.3 里「不要动 rejections-http」这条人工判断因此被编码成规则，而不是靠人记。
2. **必须是真的退出码语句**（`process.exit(77)`／`process.exitCode = 77`／`return 77;`），不是输出里出现「77」两个字。这条是返修来的：第一版用 `/\b77\b/` 扫窗口，探针立刻抓到漏洞——把真脚本的 `return 77;` 改成 `return 0;` 后，下一行的 `EXITCODE=77 表示未取得…` 文案仍在，守卫**照样绿**。收紧成 `EXIT_77_RE` 后同一变异立刻变红（见下）。
3. 扫全部 `tests/integration/*.mjs`（不止 `-e2e.mjs`），因为另两个假绿脚本是 `-pg.mjs`；`-e2e.mjs` 额外要求写明 `EXITCODE=77` 文案。
4. 反空转：至少扫到 3 个「有整链 SKIP 分支」的脚本，且其中必须有 `-e2e.mjs`。

反向控制读数（`node --test tests/unit/integration-script-coverage.test.mjs`）：

```
✔ 前向守卫：每个纯回环／E2E 集成脚本都被某个 npm 脚本引用，或已在豁免表登记 (2.2249ms)
✔ 反向控制：塞进一个未接线的纯脚本，同一断言必须红并点名它 (3.4211ms)
✔ 豁免表锁定：只能是被裁决过的文件，且理由必须写明所需前置 (0.8808ms)
✔ 判类口径边界：不扫 PG／夹具／本机工具脚本，但链上的纯回环必须被看见 (0.7789ms)
✔ 整链跳过必须给 77：打印 SKIP 却没给 77 出口的脚本一律红（点名文件） (14.0897ms)
✔ 反向控制：零出口的假 SKIP 脚本必须红，写明 77 的才绿，用例级 skip 不误伤 (1.3671ms)
ℹ tests 6   ℹ pass 6   ℹ fail 0   EXITCODE=0
```

用例内的红读数（`assert.throws` 通过＝守卫确实红，且消息点名文件）：

- 零出口假脚本 `guard-probe-skip-zero-e2e.mjs` → `wholeChainSkipWithout77=true`，`assertSkipUses77` 抛错且消息含该文件名。
- 写明 77 的 `guard-probe-skip-honest-e2e.mjs`（`return 77` ＋ `EXITCODE=77`）→ 两条判据均 false，守卫绿。
- 有 `process.exit(77)` 但缺「EXITCODE=77」文案 → `e2eSkipExitCodeTextMissing=true`，守卫红并点名 `guard-probe-skip-silent-e2e.mjs`。
- 用例级 `test('SKIP AC08 …', {skip})` → `skipOutputIndexes` 命中 0 个，守卫不红（不误伤）。
- 完全没有 skip 分支的脚本 → 守卫不红。

对**真文件**做变异探针（不改盘，内存里替换，证明判据对真实源码敏感）：

```
PROBE REAL_VIOLATION=false                     ← 现状（已修）不违规
PROBE MUTATED_CHANGED=true                     ← 把 user-chain-e2e.mjs 的 '    return 77;' 换成 '    return 0;'
PROBE MUTATED_VIOLATION=true                   ← 同一守卫立刻红：这条缺口现在会自己叫
PROBE NOTEKST_VIOLATION=false TEXTMISSING=true ← 只把「EXITCODE=77 表示未取得」文案改掉，文案判据也红
```

（探针经 `node --input-type=module -` 从 stdin 运行，不落盘。）

### 8.5 未改项与理由

| 项 | 为什么不动 |
| --- | --- |
| `package.json` 的 `test:integration:http` 链 | 派单明令不动。链里没有 `user-chain-e2e.mjs`；加入后在无 PG 环境会以 77 断链——那是**正确**的红，但会让本片「门禁全绿」不成立，也违背「不改 CI 结构」。等有带 PG 的 workflow 时再单独接线 |
| `.github/workflows/**` | ⛔ 硬约束。3 个 77 化脚本里只有 `migrations-negative-pg.mjs` 被 CI 引用，而它在 `auth-privacy-postgres.yml:41` 恒有 `MIGRATIONS_NEGATIVE_TEST_URL`，跳过路径不会被 CI 走到 ⇒ 改退出码对 CI 无行为变化 |
| `rejections-http.mjs` 的两个用例级 skip | 用例级、段仍跑完其余用例，语义是「部分未取得」不是「整链未取得」；改成 77 会让两种未取得混为一谈 |
| 其余 `-pg.mjs` 的缺连接串路径 | 它们不缺前置就跳过，而是直接断言失败（非 0），本就不假绿 |
| `node:test` 的 `ℹ skipped` 计数 | 由 node 自己管；全量单测里唯一 skip 仍是既有的 native 用例 |

### 8.6 复跑读数（四项，第三个提交后的状态）

```
$ node tests/integration/user-chain-e2e.mjs        → EXITCODE=77（见 §8.2）

$ node --test tests/unit/integration-script-coverage.test.mjs
ℹ tests 6   ℹ pass 6   ℹ fail 0   EXITCODE=0
（6 个用例实名见 §6.2；其中第三个用例内还含「理由事实锁」的两条反向控制红读数）

$ node --test "tests/unit/*.test.mjs"
ℹ tests 1739
ℹ suites 0
ℹ pass 1738
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 76206.3609
EXITCODE=0

$ npm run test:integration:http
> node tests/integration/knowledge-consumer-http.mjs && … && node tests/integration/transcript-confirm-http.mjs   ← 13 段，逐字同 §6.3
…
PASS 6 groups; loopback only, stub substitute ASR, no database, no external network
EXITCODE=0（330 行日志）
```

集成链没有任何变化是可以预期的：`test:integration:http` 里没有 `user-chain-e2e.mjs`（本片刻意不加），故链上 13 段的 PASS 行与 §6.3 逐字一致；对本次日志跑 `Select-String -Pattern 'user-chain'` → **0 命中**，证明这条 77 化的脚本确实不在门禁链里（它现在的 77 只会打到**显式运行它**的人和将来的 PG workflow 上）。

全量单测的唯一 `skipped 1` 仍是既有的 native 用例；本片新增的 6 个用例全部计入 1738 个 pass。

**一次需要如实记录的抖动**：本页第一次跑全量单测时出现 1 红——`tests/unit/media-real-mode-fail-closed.test.mjs` 报的是 **runner 层**的 `Error: Unable to deserialize cloned data due to invalid or unsupported version.`（`node:internal/test_runner/runner` 反序列化子进程消息失败，耗时 9901 ms），不是断言失败；当时同一台机上另有一套重活（集成链）正在跑。隔离后：单跑该文件 `tests 20 / pass 20 / fail 0`；单独重跑全量 `tests 1739 / pass 1738 / fail 0 / EXITCODE=0`。判定为并发压力下的 runner IPC 抖动，与本片改动无关——两个读数都留在这里，便于日后复核是不是同一个抖动。

## 9 后续片订正（R27-S4，2026-10-20）：两条 `-pg.mjs` 已接线

- 测量 SHA 与时点：`upstream/main` = `ba6ea9fc73600b5b4696083bc38902396f7c0a5d`（短 `ba6ea9f`），2026-10-20 12:32 实测；本页 §0–§8 的基线是 `31a746d`，两轮读数**并存、不改写历史**。
- 变更：R27-S4 把 `tests/integration/messages-pg.mjs` 与 `tests/integration/favorites-history-pg.mjs` 接进 `.github/workflows/real-pg-integration.yml`（各自 `CREATE DATABASE` 专用空库 + 真跑），并在 `tests/unit/ci-real-pg-wiring.test.mjs` 的 `MANAGED_SCRIPTS`／`FROZEN_MANAGED_SCRIPTS` 各加一条。本页的判类口径、冻结豁免表、`test:integration:http` 链**均未改**。
- 因此本页三处表述按事实收窄（都只涉及上面两条）：§2 表那两行的 `CI` 列、§2 末尾的统计口径自检、§7 第 1 项（衍生）。
- 现状读数（口径同 §2：`tests/integration/<文件名>` 全路径分别出现在 `package.json` 与 `.github/workflows/*.yml` 里）：

| 读数 | `31a746d`（本页原始快照） | `ba6ea9f` 接线前 | `ba6ea9f` ＋ R27-S4 |
| --- | --- | --- | --- |
| `tests/integration/` 条目总数 | 45 | 50 | 50 |
| 被 npm 脚本引用 | 13 | 15 | 15 |
| 被 CI workflow 引用 | 10 | 12 | **14** |
| 两边都有 | 1 | 2 | 2 |
| 两边都没有 | 23 | 25 | **23** |
| 引用 `tests/integration/` 的 workflow 数 | 7 | 9 | 9 |
| **绝对口径**：`-pg.mjs` 总数 | 14 | 18 | 18 |
| 其中：由 `real-pg-integration.yml` 跑 | 0 | 2 | **4** |
| 其中：由其它 workflow 或 `package.json` 跑 | 9 | 9 | 9 |
| 其中：**既无 npm 也无 CI** | 5 | 7 | **5** |
| 三档之和校验 | 0＋9＋5＝14 ✓ | 2＋9＋7＝18 ✓ | 4＋9＋5＝18 ✓ |

（`ba6ea9f` 这一列的 50／15／12 是在**接线前**实测的；右列只多出本片接的两条 ⇒ `CI 12 → 14`、`两边都没有 25 → 23`。其余数字的漂移来自本页之后的其它片，与本片无关。）

⚠ **`31a746d` 列「既无 npm 也无 CI」＝5，不是 7**：该提交里 `-pg.mjs` 只有 **14** 个（`admin-accounts-read-pg.mjs`、`backup-purge-pg.mjs` 那时还不存在，`conversations-pg.mjs`／`community-pg.mjs` 也还没有），其中无门禁的正好 5 个。到 `ba6ea9f` 文件增至 18 个，新增的 4 个里 2 个进本 workflow（conversations／community）、2 个仍无门禁（admin-accounts-read／backup-purge）⇒ 无门禁从 5 涨到 **7**；本片接线 `messages-pg`／`favorites-history-pg` 后回到 **5**。⛔ 不要把这一列也写成 7。

取数命令（任一检出内可复跑；口径＝`tests/integration/<全路径>` 是否出现在某个 `.github/workflows/*.yml` 或 `package.json` 里）：

```
# 总数：bash / pwsh 各一行
git ls-tree --name-only HEAD:tests/integration | grep -E -- '-pg\.mjs$' | wc -l
git ls-tree --name-only HEAD:tests/integration | Select-String -Pattern '-pg\.mjs$' | Measure-Object | Select-Object -ExpandProperty Count
# 分档：对每个 tests/integration/<name> 依次查 package.json 与 12 个 .github/workflows/*.yml
#   命中 real-pg-integration.yml ⇒ A；只命中其它 workflow 或 package.json ⇒ B；一处都不命中 ⇒ C
```

原始输出（本机 pwsh 实测，`Get-Date` ⇒ 2026-10-20 13:20–13:25；同一脚本对三个 rev 依次跑）：

```
REV 31a746d  workflows_in_tree=11  -pg_total=14
  A(real-pg-integration.yml)=0  B(other workflow or npm)=9  C(neither)=5   SUM=14
REV ba6ea9f  workflows_in_tree=12  -pg_total=18
  A(real-pg-integration.yml)=2  B(other workflow or npm)=9  C(neither)=7   SUM=18
  C list: account-deletion, account-suspend, admin-accounts-read, admin-flags, backup-purge, favorites-history, messages
REV c37070a  workflows_in_tree=12  -pg_total=18
  A(real-pg-integration.yml)=4  B(other workflow or npm)=9  C(neither)=5   SUM=18
  C list: account-deletion, account-suspend, admin-accounts-read, admin-flags, backup-purge
```
