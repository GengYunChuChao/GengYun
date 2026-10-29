# 本地受控环境运行手册（`local:up` / `local:down` / `local:status`）

一条命令起一套**本地受控环境**：真 PostgreSQL 17 + 独立簇 + 临时库 + 已应用迁移 + `stub` 执行模式的 API
＋ 6 个端点的可达性读数 ＋ 一段结构化摘要 JSON。目的是把「每一轮手搓一遍」固化成可重复的三步，
并且把反复踩的三个坑（端口被无关进程占着、PowerShell 执行策略挡 `. env.ps1`、相对路径按进程 cwd 解析）
变成**不可能发生**或**一眼可见**。

⛔ 本工具不修改任何产品代码、不新增迁移、不往 `consent_policies` 插行。
它也不是发布/真机/正式环境证据：数据库是真的，**微信身份与档案资料是合成夹件，AI 与供应商未接入**。

## 一、三步

| 步骤 | 命令 | 什么时候用 |
| --- | --- | --- |
| ① 起 | `npm run local:up` | 要跑真库联调 / 手动 smoke / 复现「只有真 PG 才现形」的问题时 |
| ② 用 | —（保持前台窗口不重要，API 与 PG 都在后台） | 用到什么时候都行；`npm run local:status` 随时看读数 |
| ③ 收 | `npm run local:down` | **收工前必须跑**（停 API 与 PG，数据保留在 state 目录） |

```powershell
npm run local:up        # 起来：打印 8 个阶段 + 6 个端点状态 + 摘要 JSON（同时写盘）
npm run local:status    # 只读：在跑/没跑 + 端口 + pid
npm run local:down      # 停：按 pid 文件停 API，再 pg_ctl stop；幂等（本来没起 ⇒ exit 0）
```

`up` 成功时最后一行是 `就绪：API http://127.0.0.1:3111；PG 127.0.0.1:5555；收工前请跑 npm run local:down。`。
失败时**不会**留下「半起」状态：本次运行自己启动的组件会被回滚，`local:down` 仍可安全重复执行。

### 退出码（`up`）

| 码 | 含义 | 下一步 |
| --- | --- | --- |
| 0 | 6 个端点全部符合预期 | 用；收工前 `local:down` |
| 1 | 用法/内部错误（未知参数、state-dir 落进仓库、PG 二进制缺失……） | 看 stderr 原文 |
| 2 | 端口被占且给了 `--strict-port`，或换号候选耗尽 | 点名了持有进程；去掉 `--strict-port` 可自动换号 |
| 3 | 服务起来了但**端点读数不符合预期**（摘要仍会写盘，如实记录） | 看 `<state-dir>/api.log`、`api-error.log` |
| 4 | `db:migrate` 失败（已回滚） | 看分类 + 脱敏证据 + `<state-dir>/migrate.log` |
| 5 | PG 建簇/启动/建库失败（已回滚） | 看 `<state-dir>/pg.log` |

`down` / `status` 只在「停止失败」或「端口仍有监听」时非 0；「本来就没起」是 **0**。

## 二、端口表

默认端口**刻意与历史默认错开**：同机多工作树并行时，照抄文档里的端口是最常见的撞车原因。

| 组件 | 本工具默认 | 历史默认（别照抄） | 说明 |
| --- | --- | --- | --- |
| PostgreSQL | **5555** | 5544（上一轮手搓）、55436（`tools/local-dev`） | 只绑 `127.0.0.1`，不绑 `0.0.0.0` |
| API | **3111** | 3100（README/`tools/local-dev`） | 本机 3100 常被无关进程（QQ 桥 `node src/bridge.js`）占着，任何路径回 401 |
| 回退策略 | 首选被占 ⇒ 试 `+1 … +20` | — | 每一跳都打印持有进程；`--strict-port` 下**不换号，直接失败** |
| API 与 PG 同号 | 禁止 | — | API 选号时把 PG 已选定的端口排除在外 |

## 三、三类已知坑的落地写法

### 坑 1：端口不能照抄 README

**症状**：`up` 看起来起好了，可每个请求都 401（或 `EADDRINUSE`），像是「鉴权写坏了」。
**真因**：3100 上坐着无关进程（本机实测是 QQ 桥），它对任何路径都回 401。

**本工具的写法**：起服务**之前**先跑一次
`Get-NetTCPConnection -State Listen`（一次取全表，再按候选端口筛；逐端口查会把探测拖到超时），
再用 `Get-CimInstance Win32_Process` 取每个持有进程的**命令行**，并用 TCP 连接探测交叉验证；
被占就打印 `pid + 进程名 + 命令行` 并换下一个号。

手工核对时等价的写法：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3100 |
  ForEach-Object { Get-CimInstance Win32_Process -Filter ("ProcessId=" + $_.OwningProcess) } |
  Select-Object ProcessId, Name, CommandLine
```

### 坑 2：PowerShell 5.1 下 `. env.ps1` 会被执行策略挡住

**症状**：`UnauthorizedAccess`／「未进行数字签名」，而 `node` 照旧拿到空环境 ⇒ 报
`APP_EXECUTION_MODE [MISSING]`（看起来像代码问题，其实是环境没进去）。

**本工具的写法**：⛔ 不 dot-source 任何脚本。`up` 直接**内联**构造子进程环境
（`APP_EXECUTION_MODE=stub`、`API_PORT`、`DATABASE_URL`、两个临时密钥……），
PG 侧只用 `spawn` 调 `initdb.exe` / `pg_ctl.exe` / `psql.exe`，不经过 shell、也不经过 `.ps1`。

只有在必须跑 `.ps1`（例如既有的 `tools/local-dev/start.ps1`）时才用一次性的绕过：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.local\local-dev\start.ps1
```

### 坑 3：`git worktree` 之后，相对路径按**进程 cwd** 解析

**症状**：`git worktree add` 出来的工作树里跑 node 脚本，明明 `cd` 过去了，脚本却找不到 `services/api/src/server.ts`。

**本工具的写法**：所有路径都从**本文件的 URL** 推导（`new URL('../..', import.meta.url)` 量级），
`initdb`／`pg_ctl`／`psql`／迁移／日志／`--out` 全部用绝对路径，`buildInitdbArgs` 之类的拼装函数对相对路径**直接抛错**。
从哪个目录敲 `npm run local:up` 都一样。

## 四、state 目录、日志与密钥

state 目录默认在**仓库外**的兄弟目录：`<workspace>/.local-env/<repo-name>`（本机即
`E:\GengYunCommander\.local-env\wt-r69-localenv`）。用 `--state-dir` 或 `GY_LOCAL_ENV_STATE_DIR` 改；
指向仓库内部会直接报错。

| 路径 | 内容 |
| --- | --- |
| `pg-data/` | PostgreSQL 数据目录（`initdb` 产物，`-U postgres -A trust --locale=C --encoding=UTF8`） |
| `secrets.env` | **临时**的 `SESSION_SIGNING_KEY` / `DELETION_LEDGER_KEY`（32 字节 CSPRNG，base64url）。⛔ 不落进仓库 |
| `state.json` | 端口/pid/数据目录（`down` 与 `status` 读它） |
| `api.pid` | API 进程 id（`down` 按它停） |
| `api.log` / `api-error.log` | API 的 stdout/stderr |
| `pg.log` | `pg_ctl -l` 的 PG 日志 |
| `migrate.log` | `npm run db:migrate` 的完整输出（失败时看这里；打印出来的片段已脱敏） |
| `local-env-summary.json` | 摘要 JSON（默认 `--out` 位置，可用 `--out` 改） |

密钥的边界：只写进**子进程环境**与上面那个**仓外临时文件**；命令输出里只有
`SESSION_SIGNING_KEY: 已生成，长度满足=true` 这类读数，**⛔ 不打印任何密钥值**；
打印摘要前后还会各跑一次泄密断言（`assertNoSecretLeaks`），一旦文本里出现密钥值就抛错而不是打印。

## 五、摘要 JSON 的形状

`up` 结束时打印并落盘（默认 `<state-dir>/local-env-summary.json`）。键名排序、2 空格缩进、末尾换行 ⇒
同输入两次**逐字节相同**（`tests/unit/local-env.test.mjs` 钉住这条）。

```json
{
  "api": { "base_url": "http://127.0.0.1:3111", "execution_mode": "stub", "health": "ok", "pid": 51156, "port": 3111 },
  "checks": { "consent_policies_rows": 0 },
  "endpoints": [
    { "detail": null, "expected_status": 200, "method": "GET", "name": "health", "ok": true, "path": "/health", "status": 200 }
  ],
  "generated_at": "2026-10-29T00:23:41.334Z",
  "keys": {
    "DELETION_LEDGER_KEY": { "generated": true, "length": 43, "length_ok": true },
    "SESSION_SIGNING_KEY": { "generated": true, "length": 43, "length_ok": true },
    "storage": "<state-dir>/secrets.env"
  },
  "known_boundaries": [ { "detail": "consent_policies 0 行 ⇒ …", "id": "consent_policies_empty", "rows": 0 } ],
  "migrations": { "applied": ["0001", "…"], "applied_count": 48, "discovered": 48, "skipped_count": 0 },
  "ports": { "api": { "actual": 3111, "preferred": 3111, "skipped": [] }, "pg": { "actual": 5555, "preferred": 5555, "skipped": [] } },
  "postgres": { "data_dir": "<state-dir>/pg-data", "database": "gengyun", "host": "127.0.0.1", "port": 5555, "ready": true, "superuser": "postgres", "version": "17.11" },
  "repo_root": "<repo>",
  "schema": "gengyun.local-env/1",
  "state_dir": "<state-dir>",
  "summary_path": "<state-dir>/local-env-summary.json"
}
```

`endpoints` 固定 6 条、顺序固定：`/health`、`POST /api/v1/auth/wechat`、`/api/v1/me/profile`、
`/api/v1/knowledge`、`/api/v1/catalog/crops`、`/api/v1/herbicides`。
后四条带 `Authorization: Bearer …`，令牌来自前一条登录响应（**不落盘、不进摘要**）。
`ok` 为 `false` 时 `detail` 给响应片段（已脱敏），退出码为 3 —— 不把 401/503 当成功。

## 六、已知边界：`consent_policies` 0 行 ⇒ 发帖 403

`up` 会把这条**作为自检项打出来**（摘要里也在 `known_boundaries`）：

```
已知边界：consent_policies 0 行 ⇒ 社区发帖在授权层被 403 挡掉；需要单独的导入工具，本工具⛔不往库里插任何政策行。
```

含义：迁移建了 `consent_policies` 表，但**没有任何政策行**，所以「授权 → 发帖」在授权层就被挡住。
这是数据缺口，不是代码缺陷；修它需要单独的政策导入工具。

⛔ 本工具**不**插假政策行、**不**改授权判定。**不要**把「发帖 403」当成 `local:up` 失败来排查。

## 七、负控制（怎么证明这些坑真的被挡住了）

| # | 控制 | 怎么跑 | 应当看到 |
| --- | --- | --- | --- |
| ① | 端口被占 + `--strict-port` | `npm run local:up -- --pg-port 3100 --strict-port`（3100 有无关进程时） | exit **2**，输出点名 `pid … (node.exe, node src/bridge.js)`，且**没有**建簇/起服务 |
| ② | `db:migrate` 失败 | `npm run local:up -- --database-url postgres://postgres@127.0.0.1:1/gengyun` | exit **4**，分类 `CONNECTION_REFUSED`，已起的 PG 被回滚；随后 `npm run local:down` 仍 exit 0 |
| ③ | 摘要泄密 | `node --test tests/unit/local-env.test.mjs`（泄密回归用例） | 往摘要里塞哨兵密钥 ⇒ 用例抓住并点名路径；真实摘要里一个都搜不到 |

单测**不**起 PG、**不**起服务（那些只在手动 smoke 里做），因此可以进 CI。

## 八、与 `docs/reference/local-development.md` 的分工

| 文档 | 管什么 | 什么时候看 |
| --- | --- | --- |
| [本地开发与故障排查](local-development.md) | 完整本地联调流程、`tools/local-dev/**` 那套「每人一套隔离产物」的工具链（`prepare.mjs` + `start.ps1` + `stop.ps1`，产物在仓内 `.local/local-dev`，含合成档案引导与微信导入目录）、端口/日志/重置、共用一台机器、常见故障、`/knowledge` 为空的成因判别 | 要**长期**的本地联调环境、要微信开发者工具导入、要排查本地数据缺口时 |
| 本页（`local-env-runbook.md`） | 一条命令的 `local:up` / `local:down` / `local:status`：端口探测与回退、临时密钥、6 端点自检、结构化摘要 JSON、三类环境坑的落地写法 | 只想**快速**起一套能打端点的受控环境、要一份可复制的读数时 |

两者互不替代：`local:up` 是「起一套能打端点的最小受控环境」，`tools/local-dev` 是「一套可长期复用、
带合成档案与微信导入目录的本地联调产物」。同时跑要给两套不同的端口（例：`local:up --pg-port 5555 --api-port 3111`
与 `local-dev --pg-port 55436 --api-port 3100`）。

## 九、常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `✗ 端口 3100 已被占用：pid … （--strict-port ⇒ 直接失败）` | 首选端口被无关进程占着 | 去掉 `--strict-port` 让它换号，或 `--pg-port/--api-port` 换一段 |
| `✗ /health 未就绪：… checks.database.status=error（database.category=connection_failed）` | PG 没起来或连错端口 | `npm run local:status`；看 `<state-dir>/pg.log` |
| `✗ db:migrate 失败（… 分类 CONNECTION_REFUSED …）` | 连接串指向了没人监听的端口 | 默认自动用本次的 `DATABASE_URL`；只有显式 `--database-url` 覆盖时才会这样 |
| `✗ initdb 失败` / `PG 二进制缺失` | `--pg-bin` 指错，或本机没装 PG 17 | `--pg-bin <PostgreSQL 17 bin 目录>` 或设 `GY_PG_BIN` |
| `--state-dir 必须落在仓库外` | 把密钥/数据指进了仓库 | 用默认的 `<workspace>/.local-env/<repo-name>` |
| `down` 说「本来就没起」 | 上一轮已收干净 | 正常（exit 0），不需要反复 down |
| 想换端口/重建数据 | 端口与簇都记在 `state.json`/`pg-data` | 先 `local:down`，再删 `<state-dir>`（**会丢本地数据**），然后重跑 `local:up --pg-port … --api-port …` |
