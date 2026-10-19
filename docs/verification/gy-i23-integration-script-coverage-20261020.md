# GY-I23 集成脚本覆盖：把「已在 main、却没有任何门禁执行」的脚本逐条摊开

- 日期：2026-10-20
- 分片：GY-I23（派单 `.pg17/dispatch/integration-script-coverage.md`）
- 分支：`test/gy-integration-script-coverage`，基线 `upstream/main` = `31a746d`
- 环境：Windows（PowerShell 5.1，本机无 `pwsh`）、Node v24.16.0、`npm ci --offline --ignore-scripts`（103 packages）、PostgreSQL 17.11 位于 `E:\GengYunCommander\.pg17\pgsql\bin`（**只**用于本片第 2 项的可行性验证，未进任何门禁）

## 0 结论（先看这三条）

1. `tests/integration/` 共 **45** 项：**13** 项被 npm 脚本引用、**10** 项被 `.github/workflows/*.yml` 引用（`profile-ui-http.test.mjs` 两边都有）、**23 项两边都没有**。全表见 §2。
2. 派单第 2 项（把 `tests/integration/user-chain-e2e.mjs` 接进 `test:integration:http`）：**未取得**。它需要真实 PostgreSQL 17；缺 PG 时只打印 3 行 SKIP 并 `exit 0`（§3.1），接进无 PG 的链就是「绿但没测」。`package.json` **未改**。
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

`tests/unit/ci-integration-chain-structure.test.mjs:148` 已经在白名单里登记了它：

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
| 数字事实 | 冻结清单只有 8 条（链现在 13 条，`⊇` 允许追加） | 当前纯回环类 13 条，全部已接线 |

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
| `user-chain-e2e.mjs` | 端到端 E2E（真实 PG17） | **真实 PostgreSQL 17**：`USER_CHAIN_PG_BIN`（含 `initdb.exe`）＋可写且不存在的 `USER_CHAIN_PG_DATADIR` | — | — | **本片唯一豁免**：实测 119 条断言通过，但缺 PG17 时只打印 3 行 SKIP 并 `exit 0` ⇒ 接进无 PG 的链＝静默绿灯；按派单第 2 项落「未取得」（§3、§7） |
| `account-deletion-pg.mjs` | 需真实 PG | 一次性集群 + 硬钉库名 `gengyun_deletion_test`（argv 自建自删；`I19_DELETION_TEST_DEBUG` 为调试开关） | — | — | `*-pg.mjs`：按派单第 1 项排除，理由＝需要 PG，不得算进窄口径守卫；无 npm/CI 引用，既有结构守卫已声明放行 |
| `account-suspend-pg.mjs` | 需真实 PG | 两段连接串 argv（管理员 URL + 运行时角色 URL）；`I22_KEEP_ROLES` 调试开关 | — | — | 同上 |
| `admin-flags-pg.mjs` | 需真实 PG | 一次性集群 + 硬钉库名 `gengyun_flags_test` | — | — | 同上 |
| `auth-privacy-pg.mjs` | 需真实 PG | `AUTH_PRIVACY_TEST_URL` | — | `auth-privacy-postgres.yml` | CI 有跑、npm 链不跑：这是「本地门禁缺一段」而非「无人执行」 |
| `catalog-pg.mjs` | 需真实 PG | `DATABASE_TEST_URL` | — | `catalog-postgres.yml` | 同上 |
| `consent-grant-pg.mjs` | 需真实 PG | `CONSENT_GRANT_TEST_URL` | — | `consent-grant-postgres.yml` | 同上 |
| `egress-ledger-pg.mjs` | 需真实 PG | `EGRESS_LEDGER_TEST_URL`、`EGRESS_LEDGER_KEEP` | — | `consent-grant-postgres.yml` | 同上（与下一项成对） |
| `egress-object-key-pg.mjs` | 需真实 PG | `EGRESS_LEDGER_TEST_URL`、`W116_PSQL`；须紧跟 `egress-ledger-pg.mjs` 且由其 `EGRESS_LEDGER_KEEP=1` 留下账本 | — | `consent-grant-postgres.yml` | 同上（顺序敏感，不能单独接） |
| `favorites-history-pg.mjs` | 需真实 PG | `FAVORITES_HISTORY_PG_TEST_URL`；未设则**显式 SKIP + exit 0** | — | — | 同上；注意它自己也是「缺环境就静默绿」的形状 |
| `messages-pg.mjs` | 需真实 PG | 一次性集群 + 硬钉库名 `gengyun_messages_test` | — | — | 同上 |
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

统计口径自检：45 行；`npm` 有引用 13 行；`CI` 有引用 10 行；两者都无 23 行（= 1 个 E2E + 5 个仅声明的 `-pg` + 4 个夹具/辅助 + 12 个本机工具 + 1 个 `.ps1`）。

**关于「需要什么＝无」这 13 行**：这是**实测结论**，不是推断——§6.3 的整链在本机（无 PG、无外网、仅回环端口）`exit 0` 跑完，而链里就是这 13 条。

## 3 `user-chain-e2e.mjs`：本机两侧读数（第 2 项判定的全部依据）

### 3.1 无 PG17 时：3 行 SKIP，`exit 0`

```
node tests/integration/user-chain-e2e.mjs
SKIP real PG17 user chain: 未找到 PostgreSQL 17 的 bin 目录（设 USER_CHAIN_PG_BIN，或把 initdb 放进 PATH）。
     本次运行没有起库、没有跑链路 —— 不是通过，也不是失败。
EXITCODE=0
```

第三行为空行。**这就是「静默绿灯」的字面证据**：0 条断言、0 步、退出码 0。若把它接进 `test:integration:http`，在没有 PG17 的开发机与 CI 上它会稳定打印上面两行并让整链继续绿。

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

- `-http.mjs`、`-http.test.mjs`、`-e2e.mjs` ⇒ 入选（当前 13 个 + 1 个豁免 = 14 个候选里，13 个在链上、1 个豁免）；
- `-pg.mjs`、`.ps1`、`.cjs`、`*-fixture.*`、`local-dev-*`、`reverse-control`、`demo-reference` 等 ⇒ 一律**不入选**（派单第 1 项与第 3 项都要求「不许把 PG 扫进来」）。

引用判定：把 `package.json` 里**所有** `scripts.*` 的命令文本拼在一起，要求 `tests/integration/<文件名>` 这个**完整相对路径**出现。用完整路径而不是裸文件名，避免「`admin-http.mjs` 被 `admin-http.mjs.bak` 或注释里出现」这类假阳性。

### 5.2 两条出路：接线，或进冻结豁免表

- 默认出路：接进某个 `scripts.*`（派单只要「某个」脚本，本片不改链，故现有 13 条已满足）。
- 唯一豁免：`tests/integration/user-chain-e2e.mjs`（理由：需真实 PG17，缺 PG 时 3 行 SKIP + `exit 0`，接进无 PG 链＝静默绿灯；前置＝CI 提供 PG17 并单独开带 PG 的 workflow）。
- 豁免表被**冻结**（`FROZEN_EXEMPTION_PATHS`）+ 每条必须写 `reason`（≥60 字符且必须提到 PG/PostgreSQL），**新增豁免必须改测试**；豁免项若哪天被接线、被删除、或不再符合判类口径，测试同样会红（防白名单腐烂）。

### 5.3 四个用例（其中一个是反向控制）

1. **前向守卫**：读真实目录 + 真实 `package.json`，断言「未接线的纯回环类」集合为空；同时反空转（`pureScripts.length >= 12`），避免哪天正则失配导致「扫了个寂寞还全绿」。
2. **反向控制**：在内存里注入一个**不落盘**的假文件 `tests/integration/guard-probe-not-wired-http.mjs`——先断言它既不在磁盘上、也没被任何脚本引用，再断言守卫函数**抛出**且消息**点名**该文件；然后逐条证明「把它接进脚本 ⇒ 转绿」「加一条不相干脚本 ⇒ 救不了」「走豁免出口 ⇒ 也生效」。**不改 `package.json`、不写脏文件**。
3. **豁免表锁定**：冻结路径比对、豁免项必须真实存在、必须仍在判类口径内、必须**真的**没被引用、`reason` 长度与关键词。
4. **判类边界**：`-pg.mjs` 一律不入选（且数量 ≥12）、夹具/反向控制/`local-dev-*`/`demo-reference`/`.ps1` 不入选、链上那 13 条必须被扫到。

真实输入与反向控制输入走**同一个**断言函数（`assertAllWired`），因此「反向控制的红」证明的就是「真实缺口会红」。

### 5.4 真实数据探针（证明豁免表不是遮羞布）

用临时探针脚本（工作区外，跑完即删）直接调用上面的导出函数跑到真目录：

```
PURE_COUNT=13
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
✔ 纯回环／E2E 集成脚本都必须被某个 npm 脚本引用 (3.6441ms)
✔ 反向控制：注入未接线的假文件必须红，且消息点名该文件 (3.9610ms)
✔ 豁免表锁定：只允许冻结的那一条，且必须仍真实未接线 (0.9713ms)
✔ 判类边界：PG／夹具／本机工具不得混进纯回环口径 (1.2833ms)
# pass 4
# fail 0
EXITCODE=0
```

反向控制的「红」读数（同一测试内，逐字断言）：注入 `tests/integration/guard-probe-not-wired-http.mjs` 后 `assertAllWired` 抛出的消息里必须出现该路径；未接线状态下 `unreferencedPureScripts` 返回 `['tests/integration/guard-probe-not-wired-http.mjs']`；把它写进脚本文本后返回 `[]`。

### 6.3 `npm run test:integration:http`（核心门槛，真跑）

```
> gengyun@0.0.0 test:integration:http
> node tests/integration/knowledge-consumer-http.mjs && ... && node tests/integration/transcript-confirm-http.mjs
（13 段顺序执行，330 行日志）
EXITCODE=0
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

**新增脚本段：无**（第 2 项未取得）。若强行追加 `user-chain-e2e.mjs`，本机无 PG17 时会插入 §3.1 那 3 行 SKIP 且整链仍 `exit 0`——这正是本片拒绝接线的理由：一条能在缺环境时「绿着什么都不做」的脚本，放进门的价值是负的。

### 6.4 全量单测

```
node --test "tests/unit/*.test.mjs"
ℹ tests 1737
ℹ suites 0
ℹ pass 1736
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 72192.9908
EXITCODE=0
```

唯一 skip 是**既有**的 `native separate-connection withdrawal and account state changes at guarded read boundary # SKIP`（native 分支用例，与本片无关）；本片新增的 4 个用例在 1736 个 pass 之内。

### 6.5 改动量

```
git diff --numstat upstream/main HEAD
301	0	docs/verification/gy-i23-integration-script-coverage-20261020.md
218	0	tests/unit/integration-script-coverage.test.mjs
```

只新增这两个文件。`package.json`、`services/**`、`packages/**`、`apps/**`、`miniprogram/**`、迁移、契约、`.github/workflows/**` 全部 **0 行改动**——本片没有为了让门禁变绿而改任何产品代码或 CI 结构。

### 6.6 收工状态

```
git status --porcelain      → 0 行（两文件已提交，工作树干净）
```

## 7 未取得项（如实登记，不伪造通过）

| 项 | 内容 | 现状 | 所需前置 | 为什么本片不解决 |
| --- | --- | --- | --- | --- |
| 第 2 项 | 把 `tests/integration/user-chain-e2e.mjs` 接进 `test:integration:http` | **未取得**：本机可跑通（§3.2），但需要真实 PG17；缺 PG 时 3 行 SKIP + `exit 0` | ① CI/开发机提供 PostgreSQL 17 的 bin（`USER_CHAIN_PG_BIN`）与可写数据目录（`USER_CHAIN_PG_DATADIR`）；② 单独开带 PG 的 workflow 或带 PG 的 npm 脚本（`test:integration:user-chain`），**不要**塞进无 PG 的 `test:integration:http` | 派单第 2 项明令「若它需要 PG／网络则不改 CI 结构、落未取得并停止本项」；且 `ci-integration-chain-structure.test.mjs` 的冻结链与 `.github/workflows/*.yml` 的 job 结构本片都不许动 |
| 第 1 项（衍生） | 5 个 `-pg.mjs`（`account-deletion-pg`、`account-suspend-pg`、`admin-flags-pg`、`favorites-history-pg`、`messages-pg`）既无 npm 也无 CI 引用 | 已声明、无门禁 | 与上一条同源：需要 PG 环境 | 同上；且本片只被允许改 `package.json` 脚本与新增测试/文档 |
| 第 1 项（衍生） | 12 个本机工具（10 个 `local-dev-*.cjs` + `knowledge-native-consumer.mjs` + `local-knowledge-smoke.mjs`）不进任何无头门禁 | 设计如此 | 微信开发者工具 + `miniprogram-automator` + 本机 `.local/local-dev` 目录 | 图形化模拟器会话无法在无头 CI 里稳定复现；本片只登记理由不硬接 |

补充：本片**不**主张「所有 45 项都该进 `test:integration:http`」。正确的分层是——纯回环／E2E 必须被 `scripts.*` 真的执行（本片已把它变成会红的断言）；需要 PG/Python/图形模拟器的那些，靠各自的 workflow（已有 7 个 workflow 覆盖 10 个脚本）与本机手工证据页承担。

