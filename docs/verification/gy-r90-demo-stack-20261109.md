# 一条命令拉起本机演示栈（R90，2026-11-09）

> 读数快照：2026-11-09（Asia/Hong_Kong）。base `origin/main` `82c54574`——派单时是 `8dc192ca`，本轮开工后 `main` 又合入 «feat(privacy): 终止撤回/注销在途作业并加墓碑守卫»，分支已 `--ff-only` 跟上；分支从 `2261f92e` 起，工作树里带着上一位代理未提交的三个文件，本轮接管后逐行复核、修真 bug、补测试与手册。
> 改动面：`tools/demo-stack.mjs`（新增 `runPgCtlStart`、第 9 步失败文案）、`tools/lib/demo-stack.mjs`（BOM 容错、外部键计数订正、文案）、`tests/unit/demo-stack.test.mjs`（+1 用例）、`tests/unit/demo-stack-cli.test.mjs`（新，3 用例）、`docs/demo/本地演示-stack.md`（新）、本页（新）。
> 零新依赖：只用 `node:` 内置模块 + 既有的 `tools/lib/local-env.mjs` 里那批参数构造器。

## 一、改前：这件事只能靠人肉摸

同一个演示，改前要依次手工做九件事：找到 PG 的 bin 目录 → `initdb -D` 造簇 → `pg_ctl -o "-p …" start` → `createdb` → `psql -f` 跑迁移 → `psql -f` 灌两个种子 → 自己凑 9 个 env（其中两把签名钥匙得现造）→ 手动 `node … server.ts` 并把 stdout 重定向到文件 → 再用 `curl` 轮询健康检查。任何一步错，表现都一样：**首页 503 或一片空白**，没人告诉你错在第几步。

更费时间的是两个「没人写在纸上」的前提：

1. 健康检查在**根路径** `/health`（`services/api/src/routes/health.ts:11`），不在 `/api/v1` 下；照着业务前缀去 curl `/api/v1/health` 只会拿到 404，然后被误判成「服务没起来」。
2. 非 `real` 模式下首页**必然** 503（`services/api/src/db/catalog.ts:15` 的 `PROVIDER_UNAVAILABLE`）；把这条当故障去调，方向从一开始就是错的。

改后：一条 `up`（九个编号步骤）把上面九件事串起来，失败时按 13 类原因给「哪一步、为什么、怎么办」，并在超时/API 早退时自动打印 **API 日志最后 30 行**。

## 二、交付物与三个关键设计

| 文件 | 行数（交付时） | 职责 |
| --- | --- | --- |
| `tools/demo-stack.mjs` | 约 870 | 唯一的 IO/编排层：探测端口、起停进程、写 pid、跑迁移与种子、轮询健康 |
| `tools/lib/demo-stack.mjs` | 约 560 | 全纯函数：参数解析、env 组装、健康判定、失败分类、状态三行、路径与模板 |
| `tests/unit/demo-stack.test.mjs` | 约 400 | 25 条纯函数用例（**不起 PG、不碰端口**） |
| `tests/unit/demo-stack-cli.test.mjs` | 约 60 | 3 条真 CLI 用例（`--help` / 空状态 `status` / 未知参数与子命令），也不起 PG |
| `docs/demo/本地演示-stack.md` | 约 250 | 给非工程师的运行手册（四条命令、每步期望、12 条故障与修法、与 `prepare-wechat` 的衔接） |

**① 幂等靠三层证据，不靠「试试看」**：端口探测（谁占着、PID、命令行）→ `api.pid` 里的实例标记 → `state.json` 的 `seeded` 记录。已起着的再敲 `up` 会说「是本工具上一次起的实例」并直接复检健康；迁移与种子都记过账，第二次不再重跑（实测热启 3.5s）。

**② 进程必须可收、且只能收自己的**：API 以 `detached` 起，命令行带 `--gy-demo-stack-instance=<id>`；`down` 只杀「pid 文件里的 pid 且命令行含该标记」的进程，Windows 上再兜底 `taskkill /T /F`。别人的 `node` 恰好占着 3000 端口时，不会被误杀。

**③ 失败必须能自己对号**：13 个失败分类（`PORT_IN_USE` / `API_CONFIG_MISSING` / `AUTH_FAILED` / `DB_UNREACHABLE` / `MIGRATION_DRIFT` / `HEALTH_TIMEOUT` / `PG_INIT_FAILED` / `PG_START_FAILED` / `CREATEDB_FAILED` / `MIGRATE_FAILED` / `SEED_FAILED` / `API_EXITED` / `HEALTH_NOT_READY`），每类带一句「处理」；退出码与阶段一一对应（2 端口、3 PG、4 迁移、5 种子、6 API 早退、7 健康超时）。

## 三、自验三步（全部真跑，原文摘录）

环境：Windows + PowerShell 5.1、node `v24.16.0`、PG 17.11（`E:\GengYunCommander\.pg17\pgsql\bin`）、专用端口 API 38110 / PG 55510、env 文件 `E:\GengYunCommander\.pg17\tmp\demo-real.env`（6 个外部键，值不打印）。

### 3.1 冷启：`reset --yes` 之后从零 `up`

```text
node tools/demo-stack.mjs reset --yes
→ exit 0（2263ms）：API 已停（pid 26316）／PG 已停（fast）／已删除 …\demo-stack

node tools/demo-stack.mjs up --mode real --port 38110 --pg-port 55510 --env-file …\demo-real.env
→ exit 0（13.4s）
  [5/9] 没有簇：initdb → …\pgdata（trust / locale=C / UTF8）        ✓ initdb 完成
  [6/9] ✓ 已启动（日志 …\pg.log）
  [7/9] ✓ 已建库 gengyun     ✓ 迁移完成：应用 56 个
  [8/9] ✓ seed_reference.sql  ✓ seed_herbicides_verified.sql
  [9/9] 已启动：pid 45100
        ✓ /health → 200 ok（database=ok, mode=real）（1956ms，探测 4 次）
```

冷启构成：initdb 约 1s、起簇 <1s、建库 + 56 个迁移约 3s、两个种子 <1s、API 启动到 200 约 2s，其余是进程启动与轮询间隔。

### 3.2 三个端点（状态码 + 耗时）

| 命令 | 状态码 | 耗时 |
| --- | --- | --- |
| `curl http://127.0.0.1:38110/health` | **200** | 0.0025s |
| `curl http://127.0.0.1:38110/api/v1/health` | **404**（契约：健康检查在根路径） | 0.0030s |
| `curl http://127.0.0.1:38110/api/v1/public/home` | **200** | 0.0164s |

```text
{"status":"ok","checks":{"api":{"status":"ok"},"database":{"configured":true,"status":"ok","latency_ms": 1}},
 "meta":{"request_id":"02a8f15d-…","contract_version":"1.0.0","execution_mode":"real"},"uptime_s": 9}

{"data":{"previews":[],"human_review_state":"under_construction"},"meta":{…,"execution_mode":"real"}}
```

首页 200 但 `previews` 为空是**资料侧事实**，不是栈故障：真库里 `select count(*) from catalog_read.home_species` = 0（`source_versions` 5 行、`review_status` 全为 `unverified`）。手册第 7 节专门写了这条，并在工具的成功尾行里也点了一句，避免下一个看的人把它当 bug 修。

### 3.3 状态三行

```text
node tools/demo-stack.mjs status --port 38110 --pg-port 55510   → exit 0
进程：API 在跑（pid 45100，mode=real）
端口：TCP 127.0.0.1:38110 被占用（pid 45100，node.exe）
健康：GET /health → 200 ok（database=ok, mode=real）
  PG 簇：在运行（127.0.0.1:55510，数据 …\demo-stack\pgdata）
  日志：…\demo-stack\api.log
```

### 3.4 收工：`down` 与收尾核对

```text
node tools/demo-stack.mjs down --port 38110 --pg-port 55510     → exit 0（3.8s）
  API：已停（pid 45100）
  PG：已停（fast）
  数据目录保留（下次 up 直接复用；要重来用 reset --yes）
  复核：API 端口 38110 已释放；PG 端口 55510 已释放

Get-NetTCPConnection -LocalPort 38110,55510 -State Listen        → 无监听
(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | ? CommandLine -like '*demo-stack*').Count → 0
Test-Path …\demo-stack\pgdata                                     → True（数据保留）
```

## 四、故障路径（同样真跑，不是推演）

| 注入 | 结果 | 关键输出 |
| --- | --- | --- |
| env 里 `OBJECT_STORAGE_ENDPOINT` 写成 `http://` | **exit 6**，9.2s | `✗ API_EXITED：API 进程退出了（exit=1）`，随后打印 API 日志尾 30 行，其中 `- OBJECT_STORAGE_ENDPOINT [INVALID_VALUE] 必须是 https:// 开头的 endpoint（明文 http 不接受）` |
| `--timeout-ms 1000`（API 来不及就绪） | **exit 7** | `✗ HEALTH_TIMEOUT：API 没在 1000ms 内返回 200`、`进程仍在跑（pid …），只是没到 200`，并打印 API 日志尾 30 行 |
| 外部进程先占 38299 端口 | **exit 2** | `✗ API 端口 38299 已被占用：pid 27376（node.exe）` + 该进程命令行 + 处理建议 |
| `--timeout-ms 300`（越界） | **exit 1** | `✗ --timeout-ms 必须是 1000..3600000 的整数，收到「300」` |
| 未知参数 / 未知子命令 | **exit 1** | `✗ 未知参数「--nope」；跑 node tools/demo-stack.mjs --help 看可用参数` / `✗ 未知子命令「restart」；可用：up / down / status / logs / reset` |
| `stub` 模式起来后访问首页 | 健康 200、首页 **503** | 与 `services/api/src/db/catalog.ts:15` 的既有契约一致；工具不兜底、不造假 |

本轮修掉的两个真 bug（都是靠上面这些真跑才暴露的）：

1. **每次 `up` 必卡 90 秒**：`spawnSync` 用管道接 `pg_ctl` 输出，`postmaster` 继承了管道句柄，`pg_ctl` 明明 0.3s 就 ready，`spawnSync` 仍等满 `timeoutMs` 并返回 `{status:0, error:ETIMEDOUT}`——**被当成成功**。探针实测 `elapsedMs:5012, status:0, err:"ETIMEDOUT"`。修法：`runPgCtlStart` 把 stdio 改成 `['ignore', fd, fd]`（`tools/demo-stack.mjs:323` 的 `runPgCtlStart`（`stdio` 在第 330 行）），并把 `result.error` 也算失败。修前 stub `up` 93s、real 冷启 103s；修后 5.7s / 13.4s。
2. **健康失败路径自己抛 `ReferenceError`**：`const classified = failWith({…}, [\`  处理：${classified.hint}\`])` 自引用（TDZ），把「该打印日志尾 30 行」的路径变成 `✗ 未预期的错误` + exit 1。修法：删掉自引用，改由 `failWith` 内部先分类再打印（第 86 行），并在第 724 行补 `const headline = …` 让首行直接说清是「进程退出了」还是「超时」。

## 五、闸门（改动落地后逐条真跑）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | **exit 0** |
| 2 | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | **exit 0**（36 pass / 1 skip） |
| 3 | `npm run test:docs` | **exit 0** |
| 4 | `node tools/verify-verification-comment-anchors.mjs` | **exit 0** |
| 5 | `node --test tests/unit/demo-stack.test.mjs tests/unit/demo-stack-cli.test.mjs` | **exit 0**（28 pass） |
| 6 | `node tools/lint-workspaces.mjs`（仓内 typecheck 入口；仓根没有 `tsconfig.json`，`npx tsc --noEmit -p .` 无从谈起） | **exit 0** |

尾行原文：

```text
1) PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）
2) ﹣ 文档锚点位移恒等 … # SKIP: 82c54574aff8..79c1888a44bd 本次文档提交只有新增行，没有锚点位移面（2 个纯新增 hunk）   ℹ tests 37 / pass 36 / fail 0 / skipped 1
3) PASS: 识别 5 页 / 跳过 372 页（扫描面 377 页：docs/verification）——读数七条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字 ⑦同页副本一致）
4) VERIFICATION-COMMENT-ANCHOR-PASS: 基线内 1419 条注释锚点只告警，没有基线外新增
5) ℹ tests 28 / ℹ pass 28 / ℹ fail 0
6) PASS tsc --noEmit services/api/tsconfig.json ／ PASS tsc --noEmit apps/admin/tsconfig.json ／ PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
```

第 2 项的 SKIP 不是「没跑」：用例先解析 `git merge-base HEAD origin/main`（= `82c54574`，本轮期间 `main` 从派单时的 `8dc192ca` 前进到它），再看 `base..HEAD` 的文档改动面——本提交只**新增**两篇文档、没有改写既有行，于是按纯新增 SKIP（这条行为本身有 A1 夹具守着：只要出现一处未登记的旧行改写就硬红）。

本页自身也被第 1、4 道闸门审：写页时踩到两次并已修——`health.ts` 的单行锚点原本指到第 9 行（那里是空行，真声明在第 11 行），被判 SUSPECT；示例 JSON 里 `latency_ms` 与 `uptime_s` 的冒号后紧跟数字，被当成裸锚点，在孤儿册里成「基线外新增 2 条」。前者改成真声明行，后者在冒号后补一个空格，两道闸门才转绿。
## 六、还差什么才能让非工程师照着手册点起来

分工上已经只剩三件事，且都不在代码里：

1. **一次性的 env 文件**：6 个真实凭据在管理员手里（`E:\GengYunPrivate\credentials.local.json`）。手册第 2 节给了一段复制即用的 PowerShell（GBK 读 JSONC、只写文件、屏幕不打印值），但这**必须由有权读那份文件的人跑一次**；跑完把 `E:\GengYunPrivate\demo-real.env` 的路径交给使用者即可。
2. **微信开发者工具的两步手工操作**：导入 `LOCAL import root` 目录、在该隔离副本里勾「不校验合法域名」。CLI 无法代勾（这是 IDE 的本地设置），手册第 8 节写成了点选路径。
3. **演示内容**：首页目前是 200 + 空列表（已核对来源 0 条）。要「点开有东西」，需要资料侧先落一条 `verified` 来源——这属于资料接入，不是本栈能补的；手册与工具尾行都已明说，避免演示当天现场解释。

除此之外，使用者只需要：装好 Node 24、确认 `pg_ctl.exe` 在手册写的路径、端口没被占（手册第 1 节三项检查各一条命令），然后照 §0 那张四行表敲。`--help` 与全部报错文案都是简体中文，且每条故障都给「怎么修」。
