# GY-R88 · 把 #1030 的真库 HTTP 端到端臂接进 CI（`real-pg-http-17.11`）

- 日期：2026-11-08（HKT）
- 分支：`ci/gy-r88-http-arm-wiring`，基线 `origin/main = c0e7dac0`（`git rev-parse origin/main` 实测；`git fetch` 本次遇 TLS `unexpected eof` 一次，但共享 refs 里 origin/main 已是 `#1079` 的 `c0e7dac0`）。两次 rebase：先落到 `3d59c863`（解 `docs/verification/gy-r87-i30-http-e2e-20261107.md` 一处冲突——main 侧重锚的 603/682/634/632/286 因本提交脚本净 +16 行再整体 +16 到 619/698/650/648/302，以 main 侧行号为准），再落到 `c0e7dac0`（`#1079` 已在 main 上把索引页那两条漂到空行的锚点连同 2 条登记一起修好 ⇒ 本支**丢弃自己那两条重复登记**、保留 main 的；索引页因此不再出现在本提交的改动面里）。
- 改动面：`.github/workflows/real-pg-integration.yml`（**只在文件末追加 1 个 job**，+125 行）、`tests/integration/post-media-attach-http-pg.mjs`（+39/−19：只加「外部连接串」入口，断言零改动）、三张登记表（+10/+1/0 行）、6 份既有证据页的行号同步（索引页那条已被 main 的 `#1079` 修好，本支不再改）、本页
- 一句话结论：`#1071` 合入的那条臂此前**没有任何 workflow 跑它**（`#1071` 的页自述「本脚本仍未接进 CI」）；本片给它一个与 `#1070` 的 `real-pg-ledger-17-11` 同款的 job——`services.postgres`（`postgres:17.11`）+ 同一 step 里先 `CREATE DATABASE` 再 `node <脚本> "postgres://…"`，77 显式升红、退 0 还要过 `[ALL PASS]` 末行闸与「组数 ≥ 11」读数闸。本机按 CI 形态复跑：**exit 0、11 组 PASS**（§4；末三组是 rebase 后 main 补进同一脚本的）。

## §1 接在哪（job 名 / 触发条件 / 关键行号）

新 job 的骨架与 `#1070` 合入的 ledger job（`.github/workflows/real-pg-integration.yml:1446`）逐段同款，只有「跑哪条脚本、库名、读数闸」不同：

| 位置 | 内容 |
| --- | --- |
| `.github/workflows/real-pg-integration.yml:1568` | job key `real-pg-http-17-11:`——**追加在文件最末**，前面 5 个 job（`real-pg-17-11` / `real-pg-admin-read` / `real-pg-admin-write` / `failmatrix-real` / `real-pg-ledger`）一个字节没动 |
| `.github/workflows/real-pg-integration.yml:1569` | `name: real-pg-http-17.11`（check 名；与 job key 只差 `-`↔`.`） |
| `.github/workflows/real-pg-integration.yml:1570` | `runs-on: ubuntu-24.04` |
| `.github/workflows/real-pg-integration.yml:1571` | `timeout-minutes: 45` = 封顶之和 35 + 前置余量 10（`tests/unit/ci-real-pg-step-timeouts.test.mjs` 判据②③；逐项分解写在 1563 起的注释块里） |
| `.github/workflows/real-pg-integration.yml:1574` | `image: postgres:17.11`（判据③ 只认主版本 17） |
| `.github/workflows/real-pg-integration.yml:1580` | `--health-cmd pg_isready`（5s 间隔 × 10 次） |
| `.github/workflows/real-pg-integration.yml:1600` | service 自证 step：`show server_version` 主版本必须 17、`pg_roles.rolsuper` 必须 `t`——把「真 17」与「这条臂要的超管连接」变成读数，而不是靠镜像名相信 |
| `.github/workflows/real-pg-integration.yml:1631` | `psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_post_media_http_test'`（**先建库**） |
| `.github/workflows/real-pg-integration.yml:1633` | `node tests/integration/post-media-attach-http-pg.mjs postgres://…/gengyun_post_media_http_test 2>&1 \| tee "$log" \|\| rc=$?`（连接串**只经 `argv[2]`**） |
| `.github/workflows/real-pg-integration.yml:1634` | `rc == 77` ⇒ `::error::` + `exit 1`（77 = 未取得，不是通过） |
| `.github/workflows/real-pg-integration.yml:1638` | 其它非 0 ⇒ 原样透出 `rc` |
| `.github/workflows/real-pg-integration.yml:1642` | 末行闸 `grep -Fq '[ALL PASS] 真库 HTTP 端到端'` |
| `.github/workflows/real-pg-integration.yml:1646` | 读数闸：从尾行抽「共 N 组 PASS」，`N ≥ 11`（只 grep 一道时，删掉整组断言仍会 exit 0 并打 pass） |

触发条件：`on:` = `pull_request` + `push: branches: [main]`（`.github/workflows/real-pg-integration.yml:65-68`），权限 `contents: read`（`.github/workflows/real-pg-integration.yml:69-70`）；该 job **没有** `if:` / `needs:` ⇒ 每个 PR 与每次 main push 都跑。把它加进分支保护的 required checks 属于仓库设置，不在本片范围。

## §2 为什么必须是 `services.postgres` 形态（不能自起簇）

- `tests/unit/ci-real-pg-wiring.test.mjs` 判据③ 的作用域是「`run:` 里出现任一 `MANAGED_SCRIPTS` 脚本的 job」（`jobsRunningManagedScripts()`），对这类 job **强制** `services.postgres` 且主版本 17——**没有自起簇豁免**；
- 判据⑦⑧（`databaseGuardProblems()`）又要求「同一 step 里先 `CREATE DATABASE` 再 `node`，且建出来的库名与传给脚本的库名逐字一致」；而自起簇形态（`SELF_CLUSTERED_SCRIPTS`）的 step 一旦出现 `CREATE DATABASE` 就判红。
- 两条合起来只有一个解：**service 建库 → 连接串经 `argv[2]` 传进去**。这正是 `#1070` 已合入的形态。
- 库名为什么对得上：`stepDatabaseNames()` 只从三处抽库名（env `*_PG_TEST_URL`、`node <脚本>` 之后的 argv、脚本里的 `const DB = '…'`）。本脚本的连接串常量叫 `DB_NAME`（`tests/integration/post-media-attach-http-pg.mjs:140`，值是自起簇用的 `gengyun_r87_i30_http_test`）⇒ CI 侧可核对的名字只有 `CREATE DATABASE gengyun_post_media_http_test` 与 `argv[2]` 里那一个，两者逐字一致。
- ⛔ 坑写在明处：把连接串塞进一个**不叫** `*_PG_TEST_URL` 的 env（例如 `DATABASE_URL`）= 库名无从核对 ⇒ 判据⑧ 判红。

## §3 脚本侧只加入口（断言零改动）

| 入参 | 行为 |
| --- | --- |
| `argv[2]` 是 `postgres(ql)://…`（`tests/integration/post-media-attach-http-pg.mjs:159`） | `targetUrl = externalUrl`（`tests/integration/post-media-attach-http-pg.mjs:285`）：不起簇、不 `DROP`/`CREATE`，`finally` 里也不 `pg_ctl stop` |
| env `POST_MEDIA_HTTP_PG_TEST_URL` | 同上（CI 不用；留给本机或别的 runner） |
| 两者都没有 | 回落 `GY_PG_BIN` 自起一次性簇（`tests/integration/post-media-attach-http-pg.mjs:166`、`tests/integration/post-media-attach-http-pg.mjs:181`），跑完 stop + 删数据目录 |
| 三者都没有 | 打 `SKIP: 既没给外部连接串…`（`tests/integration/post-media-attach-http-pg.mjs:167-169`）+ `EXITCODE=77 表示未取得，不是通过`（`tests/integration/post-media-attach-http-pg.mjs:171`）+ `process.exit(77)` |

真正的改动只有这四条入口分支与 `finally` 的 `if (externalUrl === '')`（`tests/integration/post-media-attach-http-pg.mjs:942`）：11 组断言、SQL、信封指纹、`SHOW server_version` 校验（`tests/integration/post-media-attach-http-pg.mjs:290`）与迁移全链校验（`tests/integration/post-media-attach-http-pg.mjs:302-311`）**一行没动**。fresh 空库的语义也没弱化——在 job 刚建的空库上「全链 apply 等于全部版本」就是证据。

## §4 两次读数（本机，2026-11-08）

### 4.1 读数 A：CI 形态（service 建库 + `argv[2]`）

- 环境：本机自起 PostgreSQL **17.11**（端口 55440、只监听 127.0.0.1），`initdb … -U postgres --auth=trust`；先 `DROP DATABASE IF EXISTS` + `CREATE DATABASE gengyun_post_media_http_test`；
- 命令：`node tests/integration/post-media-attach-http-pg.mjs postgres://postgres@127.0.0.1:55440/gengyun_post_media_http_test`
- 读数（逐字）：`· 外部库（services.postgres，库由 job 先建）：postgres://***@127.0.0.1:55440/gengyun_post_media_http_test` / `· PostgreSQL 17.11` / `· 迁移：55 段全链 apply（最大号 0056），重跑 0 条` / `· 开关：public.feature_flags.submissions_enabled=true（revision=2，真实开关表）` / `· 计数端口：kind=postgres`，随后 11 组 `PASS n: …`，尾行 `[ALL PASS] 真库 HTTP 端到端：#1030 图片上限的「真 SQL → 路由 → 信封」链路＋待用池的 24h 自衰减 / state 四值矩阵 / complete 迁移，共 11 组 PASS`；
- 退出码 **0**（`ARM_EXIT=0`）；收尾 `pg_ctl -m fast -w stop` + 删数据目录（`CLEANUP=done`）。

### 4.2 读数 B：自起簇形态（`GY_PG_BIN`，本机兜底路径）

- `GY_PG_BIN=E:\GengYunCommander\.pg17\pgsql\bin`，无 `argv` ⇒ 自建一次性簇（端口 62358、只监听 127.0.0.1）；
- 读数：`· PostgreSQL 17.11`、`· 迁移：55 段全链 apply（最大号 0056），重跑 0 条`，11 组 PASS，尾行同为「共 11 组 PASS」，退出码 **0**。

两形态的尾行逐字相同，`PASS n` 都数到 11。这条「11 组」正是 job 里读数闸的下界（少于 11 组即 `::error::`）——rebase 到 `origin/main = 3d59c863` 后，main 已给同一脚本补了 PASS 9/10/11（待用池 24h 自衰减 / `state` 四值矩阵 / `/complete` 迁移），所以下界从最初的 8 改成 11。

### 4.3 11 组是什么（两形态同一份）

| 组 | 断言（缩） |
| --- | --- |
| 1 | 正控制：real + PG 装配下 A 连传 3 张 ⇒ 3× HTTP 201，`public.media` 恰 3 行，计数端口 `kind=postgres` |
| 2 | 上传侧上限：第 4 张 ⇒ 400 `INVALID_REQUEST` + `details[0]={"field":"/purpose","code":"post_image_limit"}` + `retryable=false`，库里仍 3 行（拒绝发生在写之前） |
| 3 | 挂载正控制：`POST /posts` 挂 1 张 ⇒ 201；`PATCH` 到 2、3 张 ⇒ 200/200；`post_media_attachments` 恰 3 行、`ordinal 1..3` |
| 4 | 「挂载即释放」+ owner 隔离：B 传满 3 张后第 4 张 400；A 的待用池已腾空 ⇒ 第 4 张 201（计的是待用池，不是 owner 累计） |
| 5 | 挂载侧上限（正控制）：一次 `PATCH` 4 个 `media_ids` ⇒ 400 `post_image_limit`（`#1057` 的 `preValidation` 抢先，不是 ajv 文案）；不存在的 post id 同信封 |
| 6 | 状态过滤：A 再传 2 张、`DELETE` 掉一张，再传 ⇒ 仍 201（已删的行不进待用池） |
| 7 | 每帖 ≠ 每用户累计：第 4 张挂到另一个新帖 ⇒ 201，两帖各自 3 张 / 1 张互不干扰 |
| 8 | fail-closed：real 模式摘掉 PG 计数端口 ⇒ 503 `PROVIDER_UNAVAILABLE` + `retryable=false` + `details[0]={field:/purpose,code:post_image_limit_unwired}`（文案逐字） |
| 9 | 24h 自衰减（时间穿越）：C 连传 3 张 ⇒ 池=3、第 4 张 400；把 3 行 `created_at` 拨到 25h 前 ⇒ 池读数 0、第 4 张 201；再改回 `now()` ⇒ 池读数 4、第 5 张 400（24h 只是「暂时」放过，不是永久释放） |
| 10 | `state` 四值矩阵：initiated/uploaded/processing/ready 各 1 张 ⇒ 池读数 4；再造 deleted + rejected 各 1 张 ⇒ 读数仍 4（不占位）；库里 6 行 ⇒ 第 5 张上传仍 400 |
| 11 | `/complete` 迁移：真 JPEG 种字节 → complete ⇒ 202 + `ETag "2"` + 库内 `state=ready`、`revision=2`（衍生件已去 GPS）⇒ 挂帖 201、待用池 1 → 0 |

## §5 登记表与文档同步（三处 + 行号位移）

- `tests/unit/ci-real-pg-wiring.test.mjs`：`MANAGED_SCRIPTS`（`tests/unit/ci-real-pg-wiring.test.mjs:135`）末尾 +1（第 243 行）、`FROZEN_MANAGED_SCRIPTS`（`tests/unit/ci-real-pg-wiring.test.mjs:246`）同位置 +1（第 304 行）、`REQUIRED_STEP_ORDER`（`tests/unit/ci-real-pg-wiring.test.mjs:333`）末尾 +1（第 26 条，第 601 行）——三张表 +10 行。口径不同，缺一处就红：`MANAGED_SCRIPTS` 决定「哪些 job 必须有 service」（判据③），`FROZEN_MANAGED_SCRIPTS` 是只增不减的冻结清单，`REQUIRED_STEP_ORDER` 要求 workflow 的 step 顺序与表逐条一致。
- `tests/unit/ci-integration-chain-structure.test.mjs:97-98`：该条白名单条目（UNWIRED_DECLARATIONS 表）的 reason 从「未接线（真缺口）：…」改成「已接线（workflow）：`…real-pg-integration.yml#real-pg-http-17-11` 的臂 step 真跑它…」。条目**留在**白名单里——判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链，真库 job 不算接线（单行替换，文件行数不变 ⇒ 该文件里的锚点零位移）。
- `tests/unit/ci-unwired-declaration-reasons.test.mjs:34`：`ENTRY_COUNT` **58 → 58 不变**。接线只改 reason 前缀、不删白名单条目；该测按前缀把条目分成「已接线／未接线（真缺口）／非门禁入口／不需要真库」四类，再与真实 workflow 的 `run:` 对账，第 33 行的注释补了 GY-R88 那句。
- 行号位移（§8.3 口径：**纯位移只改文档里的数字，不往 `doc-anchor-relocations.json` 加条**）：+10 行把 5 份文档里的锚点整体推后——713→723 与 539→545（`docs/verification/gy-r29-real-pg-arms-audit-20261022.md:60`、`docs/verification/gy-r29-real-pg-arms-audit-20261022.md:210`）、460-473→466-479（`docs/verification/gy-r66-wire-audit-logs-arm-20261027.md:148`）、239→243 与 322→328（`docs/verification/gy-r67-c-wiring-20261027.md:20`）、646→656 与 713→723（`docs/verification/gy-r67-c-wiring-20261027.md:21`）、2462→2472（`docs/verification/gy-r67-c-wiring-20261027.md:90`，`kind:"correction"` 既有条目）、1209-1222→1219-1232 与 2096-2098→2106-2108（`docs/verification/gy-r67-d01-unwired-reasons-20261027.md:129`）、603→619 与 682→698 与 634→650 与 632→648（`docs/verification/gy-r87-i30-http-e2e-20261107.md:128`、`docs/verification/gy-r87-i30-http-e2e-20261107.md:129`、`docs/verification/gy-r87-i30-http-e2e-20261107.md:130`、`docs/verification/gy-r87-i30-http-e2e-20261107.md:131`——main 侧 `docs/verification/gy-r87-i30-http-e2e-20261107.md:137` 的重锚段已把 509/588/540/538 推到 603/682/634/632，本提交脚本净 +16 行 ⇒ 再整体 +16）、286→302（`docs/verification/gy-r87-i30-http-e2e-20261107.md:167`）。另一批是 rebase 后才成立的位移：`docs/verification/gy-r88-i30-pool-decay-20261108.md` 里三条指本脚本的锚点 804→820、813→829、886→902（本提交脚本净 +16 行，同页三处一起跟位，仍不给登记表加条）。索引页 `docs/verification/gy-r88-open-issue-acceptance-index-20261108.md:66` 的两条（159→161 与 161→163）本支**不再改**：`#1079` 已在 main 上按同一目标值修好并登记（见下一条），索引页因此不在本提交的改动面里。
- `tests/unit/doc-anchor-relocations.json`：3 条**既有**条目的 `to`（723 / 2472 / 328）跟到新行号、reason 末尾续一句 GY-R88 的落点；索引页那两条登记**沿用 main 的 `#1079`**（`cebb0f17` / `1b618a04`，缺省 `kind`、无 `symbol`），本支在第二次 rebase 时丢掉了自己写的同义重复条目 ⇒ 最终 **611 条**，与 `origin/main` 只在这 3 行上不同（判据：以 main 侧为基底替换这 3 行，`JSON.parse` 得 611、`index:66` 恰 2 条）。做法是逐行编辑（只改 3 行），⛔ 没有 `JSON.parse`+`JSON.stringify` 整体重写。
- `docs/verification/gy-r87-i30-http-e2e-20261107.md:166`：原文断言「**本脚本仍未接进 CI**」已失效 ⇒ 换成「**已接进 CI（2026-11-08 · GY-R88）**」并指向本页（只换这一行，文件 168 行不变）。
- 锚点闸门：`.github/workflows/real-pg-integration.yml:1281`（被 `docs/verification/gy-r87-failmatrix-real-arm-rerun-20261107.md:5` 锚着的那行）仍是实质代码行；新 job 只追加在原第 1530 行之后，不存在把被锚行改成空行的路径——`node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` exit 0。

## §6 变异自证（三条，均本机跑、跑完还原）

| # | 变异 | 期望 | 实测 |
| --- | --- | --- | --- |
| ① | 把 `.github/workflows/real-pg-integration.yml:1633` 那步 `node …` 注释掉 | `ci-real-pg-wiring` 红 | fail 10/20、exit 1 |
| ② | 把 `tests/unit/ci-integration-chain-structure.test.mjs:98` 的 reason 前缀改回「未接线（真缺口）：」 | `ci-unwired-declaration-reasons` 红 | fail 1/1、exit 1 |
| ③ | 把 `tests/unit/ci-unwired-declaration-reasons.test.mjs:34` 的 `ENTRY_COUNT` 改成 59 | 同上红 | fail 1/1、exit 1 |

红原文（逐字摘）：

- ① `AssertionError [ERR_ASSERTION]: 有受管真库脚本既没有被任何 workflow 的 run: 执行，也没有对应的真库臂——`，随后点名 `· tests/integration/post-media-attach-http-pg.mjs`，并给改法「在 `.github/workflows/real-pg-integration.yml`（或另一个带 `services.postgres` 的 workflow）里加一步 `node <脚本>`，不要只写在注释里、也不要只写裸文件名。」——同一次还有判据⑥⑦⑧⑨ 三条一并红，正是「注释掉 = 没接线」。
- ② `白名单理由与事实不符：` + `- tests/integration/post-media-attach-http-pg.mjs（第 97 行）：说的是「未接线（真缺口）：」，但 .github/workflows/real-pg-integration.yml#real-pg-http-17-11 真在跑它` + `- 已接线条数 52 ≠ 真被 workflow run: 跑到的白名单脚本数 53`。
- ③ `白名单理由与事实不符：` + `- 白名单条目数 58 ≠ 59`。

## §7 已知限制（不声称的部分）

- **需要 `services.postgres`**：PG 服务端来自 service 容器（`postgres:17.11`），不是 runner 上的自起簇 ⇒ 本 job 只能在带 service 的环境里跑；脚本自身的 `GY_PG_BIN` 路径仍保留给本机（§4.2）。
- **24h 衰减：覆盖「时间穿越」，不覆盖挂钟等待**：rebase 后 main 给同一脚本补了 PASS 9（把 `created_at` 拨到 25h 前、再改回 `now()`），本 job 因此顺带覆盖了这条口径；仍未覆盖的是真等 24 小时、以及时钟漂移下的边界（既有记录见 `docs/verification/gy-r87-i06-i15-ac-evidence-20261108.md:129`）。
- **不覆盖同帖并发**：互斥在迁移 0056 的 `UNIQUE(post_id, ordinal)` 与 `claimPostMedia` 的 advisory lock 上，覆盖在既有 `tests/integration/post-media-attachments-pg.mjs`，本臂不重复。
- **`/media_ids` 的 `post_image_limit` 只证到路由层**：`#1057` 的 `preValidation` 抢先抛，store 侧 `postImageLimitError()` 经 HTTP 不可达（PASS 5 已把这点写成断言与注释）。
- **不声称 CI 已跑过**：§4 两次读数都是本机（Windows + 一次性 17.11 簇）实测；本片未 push、未开 PR，job 的第一次真实 CI 读数要等 PR 跑起来。
- **不把 job 绿当产品验收**：它只证「这条链路在 CI 里真跑且 11 组断言都过」，不替代 `#1030` 的业务验收。

## §8 复跑手册

- CI：开 PR 即跑（`on: pull_request`）；`push: [main]` 时同样跑。
- 本机（CI 形态）：`initdb` 一次性簇 → `pg_ctl -w start`（端口 55440-55499 自选、只听 127.0.0.1）→ `psql -c 'CREATE DATABASE gengyun_post_media_http_test'` → `node tests/integration/post-media-attach-http-pg.mjs "postgres://…/gengyun_post_media_http_test"` → 跑完 `pg_ctl -m fast -w stop` + 删数据目录。
- 本机（自起簇形态）：`$env:GY_PG_BIN='…\pgsql\bin'; node tests/integration/post-media-attach-http-pg.mjs`。
- 守卫：`node --test tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-unwired-declaration-reasons.test.mjs tests/unit/ci-integration-chain-structure.test.mjs tests/unit/ci-real-pg-step-timeouts.test.mjs`。
