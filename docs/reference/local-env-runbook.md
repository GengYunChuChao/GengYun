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
| ③ 收 | `npm run local:down` | **收工前必须跑**（先核实 API 归属，再停 API 与 PG；数据保留在 state 目录） |

```powershell
npm run local:up        # 起来：打印 8 个阶段 + 6 个端点状态 + 摘要 JSON（同时写盘）
npm run local:status    # 只读：在跑 / 已复用（不属本工具）/ 已退出 + 端口 + pid + 判据读数
npm run local:down      # 停：**先核实归属**（不属本工具 ⇒ 不杀、只提示），再停 API 与 PG；幂等（本来没起 ⇒ exit 0）
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
`down` 遇到「归属核实没通过」时**不发任何终止信号**：API 端口已空 ⇒ 照样 exit 0（PG 正常收尾）；
API 端口仍在听 ⇒ exit **5**，并把「那个端口上是谁」指出来（见第五节）。

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
| `state.json` | 端口/pid/**实例身份**（`instanceToken` / 启动时刻 / 工作树根）；`down` 与 `status` 读它（`api.pid` 缺失时兜底） |
| `api.pid` | API 的**结构化身份记录**（pid + `instanceToken` + 启动时刻 + 工作树根 + 端口，schema `gengyun.local-env.api-pid/2`）。`down` **核实归属之后**才据此发终止信号；旧格式（纯数字）只能降级成「不可核实 ⇒ 不杀」（见第五节） |
| `api.log` / `api-error.log` | API 的 stdout/stderr |
| `pg.log` | `pg_ctl -l` 的 PG 日志 |
| `migrate.log` | `npm run db:migrate` 的完整输出（失败时看这里；打印出来的片段已脱敏） |
| `local-env-summary.json` | 摘要 JSON（默认 `--out` 位置，可用 `--out` 改） |

密钥的边界：只写进**子进程环境**与上面那个**仓外临时文件**；命令输出里只有
`SESSION_SIGNING_KEY: 已生成，长度满足=true` 这类读数，**⛔ 不打印任何密钥值**；
打印摘要前后还会各跑一次泄密断言（`assertNoSecretLeaks`），一旦文本里出现密钥值就抛错而不是打印。

## 五、停止前的归属核实（`local:down` / `local:status`）

### 为什么「pid 活着」「端口在听」都不够

`api.pid` 里记的是一个**数字**。API 自己退出（崩溃、被任务管理器结束、Ctrl+C）之后，这个数字会留在文件里，
而 Windows 会**继续把同一个 pid 发给新进程**。下一次 `local:down` 看到「pid 还在」就发终止信号——
被结束的是另一个程序（编辑器、构建、别的服务），**它没保存过的工作会一起丢**。

「端口在听」同样不能当判据：监听者可能是另一个实例、别人的工具、任何 HTTP 服务；
「`/health` 回了 200」也一样——健康检查这件事，任何 Fastify 服务都能满足。

所以判据必须是**可核实的身份**，而不是「活着」或「可达」。

### 判据表（每条都要成立；任一不成立 ⇒ ⛔ 不杀）

| 侧 | 判据 | 问的问题 | 不成立时 |
| --- | --- | --- | --- |
| PID | 实例标识 `instance_marker` | 进程**命令行**里有 `--gy-local-env-instance=<本次实例的 UUID>` 和 `--gy-local-env-root=<工作树绝对路径>` 吗？ | 打印「PID 已复用 / 归属不符，已跳过」，**零**终止信号 |
| PID | 启动时间 `start_time` | 进程的真实启动时间**不早于** `api.pid` 的写入时间吗？（容差 2 秒，吸收秒级取整） | 同上 |
| PID | 工作树根 `work_tree` | `api.pid` 记的工作树根就是**当前这个 checkout** 吗？ | 同上 |
| 端口 | 端口 ↔ pid 绑定 `port_owner` | **监听套接字**是不是由上面认出来的那个 pid 持有？（⛔ 不是「端口在听」） | 同上 |
| 端口 | 身份回显 `instance_echo` | `/health` 的响应者是不是这个实例：`instance_token` 回显一致，或 `uptime_s` 反推的启动时刻与这个 pid 的 OS 启动时刻一致（±5 秒）？ | 同上 |

两条 PID 判据盖的是**相反的两个复用方向**，缺一条就留一个洞：

- 我们的 API 退出后 pid 被**更新的**进程复用 ⇒ 新进程不可能带着我们刚生成的 UUID ⇒ `instance_marker` 判红；
- pid 文件是旧的、pid 上坐着**更老的**进程 ⇒ 它启动得比文件还早 ⇒ `start_time` 判红。

判据**全部**来自 OS 与实例自己（`Win32_Process.CommandLine` / `CreationDate`、`Get-NetTCPConnection` 的
`OwningProcess`、`/health` 的 `uptime_s`），**没有一条**是「进程存在」或「状态码等于某个值」。

### 三态读数

`local:status` 与 `local:down` 走**同一条**核实路径（同一个纯函数），读数只有这几种：

| 读数 | 含义 | `local:down` 的行为 |
| --- | --- | --- |
| `在跑` | 判据全过：pid 上的进程就是本工具的 API，端口与 `/health` 都属于它 | 发**一次**终止信号，随后清掉 `api.pid` |
| `已复用（不属本工具）` | pid 上的进程不是我们起的（命令行 / 启动时间 / 端口 / 回显任一不符） | ⛔ 不杀；打印未通过的判据与现场核对命令 |
| `已退出` | pid 不在了，或根本没有 pid 记录 | 没有要停的东西（顺手清掉陈旧 `api.pid`） |
| `无法核实（旧格式 pid 文件）` | 读到的是 v1 纯数字格式：没有 token、没有启动时间、没有工作树根 | ⛔ 不杀；提示怎么迁移到 v2 |

`已复用` 与 `无法核实` 都**保留** `api.pid` 不删：它是「这个 pid 被谁占了」的证据，删掉等于把现场抹掉。

`local:up` 的「要不要复用上一次那个 API」也走**同一条**核实：判据全过才复用；否则按「没有正在运行的 API」
处理——不复用、⛔ 不杀（端口被占会自动换号）。⛔ 历史上「pid 还活着就复用」的写法会把复用来的 pid
写进 `state.json`，于是收工时必然误杀。

### `api.pid` 的新格式（v2）与向后兼容

```json
{
  "schema": "gengyun.local-env.api-pid/2",
  "pid": 87412,
  "instanceToken": "b032512a-6108-44d5-9cb8-40f2a2e65e39",
  "startedAt": "2026-10-30T06:53:37.720Z",
  "workTreeRoot": "E:\\GengYunCommander\\wt-r69-localenv",
  "apiPort": 3111
}
```

- `instanceToken` 每次 `up` 现生成（UUID），**同时注入两处**：进程命令行（`--gy-local-env-instance=…`，OS 可读回）
  与环境变量 `GY_LOCAL_ENV_INSTANCE`。为什么以命令行为准：Windows 上**读不到别的进程的环境块**
  （`Win32_Process` 只给 `CommandLine`），而命令行是 OS 记的、pid 复用时一定跟着换人。
- **向后兼容**：纯数字（v1）读成 `legacy` ⇒ 只降级成「不可核实 ⇒ 不杀 + 提示」，⛔ 绝不因为「格式旧」就当它能杀；
  空文件 / 坏 JSON / v2 形状缺字段一律 `invalid`；`state.json` 里只有 `pid` 的旧记录同样按 `legacy` 处理。
- 只写身份读数（pid / token / 写入时刻 / 工作树根 / 端口）：⛔ 不写密钥、⛔ 不写会话令牌。

### 自己核对现场

```powershell
# 这个 pid 到底是谁（命令行里有没有本实例的 UUID？启动时间是什么时候？）
Get-CimInstance Win32_Process -Filter "ProcessId=87412" | Select-Object ProcessId, CreationDate, CommandLine
# 端口上坐着谁
Get-NetTCPConnection -State Listen -LocalPort 3111 | Select-Object LocalPort, OwningProcess
```

### 这条判据当前的边界（照实说）

`/health` 回显 `instance_token` 是**可选能力**：本工具不改 `services/api/**`，当前 API 不返回该字段，
所以端口侧实际走的是 `uptime_s` 反推启动时刻这条**等价**判据（同一个进程才对得上）。
一旦 API 侧回显 `meta.instance_token`，判据自动升级成 token 比对——逻辑已经在纯函数里，
用例也覆盖了「回显了别人的 token ⇒ 不杀」。

另一个已知边界：端口在听、但 `/health` 完全不响应（进程卡死）时，`instance_echo` 判红 ⇒ **不杀**。
这是刻意的（⛔ 不「尽力而为」）：确认是本工具的实例后，手动结束进程并删掉 `api.pid`，再跑一次 `local:up`。

## 六、摘要 JSON 的形状

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

## 七、已知边界：`consent_policies` 0 行 ⇒ 发帖 403

`up` 会把这条**作为自检项打出来**（摘要里也在 `known_boundaries`）：

```
已知边界：consent_policies 0 行 ⇒ 社区发帖在授权层被 403 挡掉；需要单独的导入工具，本工具⛔不往库里插任何政策行。
```

含义：迁移建了 `consent_policies` 表，但**没有任何政策行**，所以「授权 → 发帖」在授权层就被挡住。
这是数据缺口，不是代码缺陷；修它需要单独的政策导入工具。

⛔ 本工具**不**插假政策行、**不**改授权判定。**不要**把「发帖 403」当成 `local:up` 失败来排查。

## 八、负控制（怎么证明这些坑真的被挡住了）

| # | 控制 | 怎么跑 | 应当看到 |
| --- | --- | --- | --- |
| ① | 端口被占 + `--strict-port` | `npm run local:up -- --pg-port 3100 --strict-port`（3100 有无关进程时） | exit **2**，输出点名 `pid … (node.exe, node src/bridge.js)`，且**没有**建簇/起服务 |
| ② | `db:migrate` 失败 | `npm run local:up -- --database-url postgres://postgres@127.0.0.1:1/gengyun` | exit **4**，分类 `CONNECTION_REFUSED`，已起的 PG 被回滚；随后 `npm run local:down` 仍 exit 0 |
| ③ | 摘要泄密 | `node --test tests/unit/local-env.test.mjs`（泄密回归用例） | 往摘要里塞哨兵密钥 ⇒ 用例抓住并点名路径；真实摘要里一个都搜不到 |
| ④ | 只判 PID 存活（历史写法） | 把 `assessApiOwnership` 改成「`alive` 即放行」（负控制，看完立刻改回） | 「pid 存在但命令行不含实例标识」「启动时间更早」两组用例立刻红；改回复绿 |
| ⑤ | 不判启动时间 | 去掉 `start_time` 判据 | 「进程启动时间早于 pid 文件写入」用例红 |
| ⑥ | 不校验 `instanceToken` | 去掉 `instance_echo` 的 token 比对 | 「`/health` 回显别人的 token」用例红 |
| ⑦ | 旧格式直接杀 | 让 `legacy` 也返回 `killAllowed: true` | 「旧格式 pid 文件 ⇒ 不杀」用例红 |
| ⑧ | 实测·pid 被无关进程复用 | 造一份 v2 `api.pid` 指向一个**命令行不含实例标识**的无关进程，跑 `local:down` | 打印「PID 已复用 / 归属不符，已跳过」；那个进程**仍在跑**（实测存活），exit 0 |
| ⑨ | 实测·旧格式 pid 文件 | 把 `api.pid` 写成纯数字后跑 `local:down` | 读数「无法核实（旧格式 pid 文件）」；进程仍存活，exit 0 |

单测**不**起 PG、**不**起服务、**不**真杀进程（`kill` 是注入的假函数，只记调用次数），因此可以进 CI。

## 九、与 `docs/reference/local-development.md` 的分工

| 文档 | 管什么 | 什么时候看 |
| --- | --- | --- |
| [本地开发与故障排查](local-development.md) | 完整本地联调流程、`tools/local-dev/**` 那套「每人一套隔离产物」的工具链（`prepare.mjs` + `start.ps1` + `stop.ps1`，产物在仓内 `.local/local-dev`，含合成档案引导与微信导入目录）、端口/日志/重置、共用一台机器、常见故障、`/knowledge` 为空的成因判别 | 要**长期**的本地联调环境、要微信开发者工具导入、要排查本地数据缺口时 |
| 本页（`local-env-runbook.md`） | 一条命令的 `local:up` / `local:down` / `local:status`：端口探测与回退、临时密钥、6 端点自检、结构化摘要 JSON、三类环境坑的落地写法、**停止前的归属核实**（判据表 / 三态 / `api.pid` v2） | 只想**快速**起一套能打端点的受控环境、要一份可复制的读数时 |

两者互不替代：`local:up` 是「起一套能打端点的最小受控环境」，`tools/local-dev` 是「一套可长期复用、
带合成档案与微信导入目录的本地联调产物」。同时跑要给两套不同的端口（例：`local:up --pg-port 5555 --api-port 3111`
与 `local-dev --pg-port 55436 --api-port 3100`）。

## 十、常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `✗ 端口 3100 已被占用：pid … （--strict-port ⇒ 直接失败）` | 首选端口被无关进程占着 | 去掉 `--strict-port` 让它换号，或 `--pg-port/--api-port` 换一段 |
| `✗ /health 未就绪：… checks.database.status=error（database.category=connection_failed）` | PG 没起来或连错端口 | `npm run local:status`；看 `<state-dir>/pg.log` |
| `✗ db:migrate 失败（… 分类 CONNECTION_REFUSED …）` | 连接串指向了没人监听的端口 | 默认自动用本次的 `DATABASE_URL`；只有显式 `--database-url` 覆盖时才会这样 |
| `✗ initdb 失败` / `PG 二进制缺失` | `--pg-bin` 指错，或本机没装 PG 17 | `--pg-bin <PostgreSQL 17 bin 目录>` 或设 `GY_PG_BIN` |
| `--state-dir 必须落在仓库外` | 把密钥/数据指进了仓库 | 用默认的 `<workspace>/.local-env/<repo-name>` |
| `down` 说「本来就没起」 | 上一轮已收干净 | 正常（exit 0），不需要反复 down |
| `API … 已复用（不属本工具）` | `api.pid` 里的 pid 已被系统发给了别的进程（API 自己退过） | ⛔ 别手改数字去凑。先核对：`Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"`；确认不是本工具的实例后删掉 `api.pid`，重跑 `local:up`（会写 v2） |
| `API … 无法核实（旧格式 pid 文件）` | 读到的是早期版本写的**纯数字** `api.pid` | 确认没有残留的 `local:up` 进程后删掉 `api.pid`，重跑 `local:up`；之后 `down` 就能核实了 |
| `local:down` 打印「已跳过」且 exit **5** | 归属核实没通过 ⇒ 不发终止信号；而那个端口上确实有人在听 | 按提示看 `Get-NetTCPConnection -State Listen -LocalPort <端口>` 的 `OwningProcess`；是无关进程就别动它 |
| 想换端口/重建数据 | 端口与簇都记在 `state.json`/`pg-data` | 先 `local:down`，再删 `<state-dir>`（**会丢本地数据**），然后重跑 `local:up --pg-port … --api-port …` |
