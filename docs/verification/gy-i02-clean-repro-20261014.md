# GY-I02 工程壳 · 干净环境可复现启动与文档对齐证据（2026-10-14，**进行中**）

任务：GY-I02 / GitHub issue **#2**（**Refs #2，不关闭整项**）。
范围：§1 干净环境可复现、§2 微信工具 CLI／基础库／编译路径、§3 文档与事实对齐。
**本页状态：进行中**——已完成的命令原始输出见第 4 节；微信 `open`/`auto` 与文档逐处对照表在后续提交补齐（见第 8 节）。

## 0 分支、基线与工作区

| 项 | 值 |
| --- | --- |
| 独立 worktree | `E:\GengYunCommander\GengYun_W32`（自建，**未改指挥仓库** `GengYun_Agent2`，未切其分支） |
| 分支 | `feat/gy-i02-clean-repro` |
| 基线 `upstream/main` | `fcfa6de9d62aeaaa0489d3319f8f06911312af48`（短 `fcfa6de`，`git fetch upstream --prune` 后读取） |
| 起点工作区 | worktree 新建，`git status --short` 为空；`node_modules` 不存在 |
| **未 push** | 是（写手不持有 GitHub 凭据，提交由指挥推送） |

创建方式（原始命令）：

```powershell
cd E:\GengYunCommander\GengYun_Agent2
git fetch upstream --prune
git worktree add E:\GengYunCommander\GengYun_W32 -b feat/gy-i02-clean-repro upstream/main
```

**未使用** junction／symlink 指向别处 `node_modules`；安装直接用锁文件 `npm ci`。

## 1 运行环境（实测读数）

| 项 | 实测值 |
| --- | --- |
| OS | Microsoft Windows 11 家庭版 中文版，NT 10.0.26200.0，AMD64 |
| Node | `v24.16.0`（满足 `engines: >=24.16.0 <25`） |
| npm | `11.13.0`（满足 `engines: >=11.13.0`） |
| Python | `3.14.3`（`python3` 与 `python` 均解析到 `C:\msys64\ucrt64\...`；`$PYTHON` 未设置）⇒ 满足 README「Python 3.11+ 用于文档检查」 |
| 本 shell | **Windows PowerShell 5.1.26100.8875（Desktop 版）**，非 PowerShell 7 |
| 微信开发者工具 | `2.02.2608080`（Stable；从 `D:\微信web开发者工具\resources\app.asar.unpacked\package.json` 的 `version` 与 `window.title` 读得） |
| 微信工具 CLI | `D:\微信web开发者工具\cli.bat` |

### 1.1 本机环境限制（会影响复现，先如实列明）

1. **“干净机器”无法在本机完全模拟**：本机是长期使用的开发机，已存在大量与耕云无关的进程与全局状态（例如 **3000 端口被无关的另一个 node 服务占用**，见 §4.5）。本片只能做到「**干净安装**（无 `node_modules` 起点 + `npm ci` 锁文件安装）＋ 干净 worktree ＋ 干净工作区」，**不等于**全新操作系统／全新用户配置／全新网络环境。这一点不因命令通过而豁免。
2. 本机进程环境同时存在 **`HTTP_PROXY`/`http_proxy`、`NO_PROXY`/`no_proxy` 大小写重复项**；Windows PowerShell 5.1 会因此让 `Start-Process` 直接抛 `ArgumentException`（构造大小写不敏感环境字典失败）。本次取证的做法是**只删除小写重复项**（值相同，大写对保留，代理行为不变）。
3. 本机执行策略**禁止 dot-source 磁盘上的 `.ps1`**（未改系统策略）；取证脚本改用 `Invoke-Expression` 内联加载。
4. 本机 `HTTP_PROXY=http://127.0.0.1:7897` 生效。PowerShell 5.1 的 `Invoke-WebRequest` 会把**回环地址**也送进代理，导致对 `127.0.0.1:3000` 的探针返回**代理侧**的 404。本次对回环端点的取证改用 `HttpWebRequest` + `Proxy = $null` 显式绕过代理。

## 2 “干净”在本片的精确含义

| 维度 | 本片做到 | 未做到 |
| --- | --- | --- |
| 源码 | 全新 worktree，`upstream/main` = `fcfa6de`，无本地改动 | —— |
| 依赖 | `node_modules` **先删除**再 `npm ci`（锁文件安装，非 `npm install`） | 未清理全局 npm 缓存／全局 npm 配置（`npm ci` 会从缓存取包） |
| 进程 | 每次取证为独立 shell 进程，环境变量不跨命令泄漏（已逐项确认 `APP_EXECUTION_MODE`/`DATABASE_URL` 等**均为 unset**） | 未重启操作系统 |
| 网络 | 全部命令只访问本机回环或 npm 注册表（安装） | 非隔离网络命名空间 |
| 目录 | 未使用 junction／symlink 复用他处依赖 | —— |

## 3 复现命令清单（照仓库文档）

```powershell
npm ci
$env:APP_EXECUTION_MODE = 'stub'
npm run dev:api
# 另开终端
npm run dev:admin
npm run lint
npm run test:unit
npm run test:contract
npm run build
npm run test:mini
```

## 4 逐条命令原始输出与退出码（已完成部分）

原始日志（UTF-8，含 `# command` / `# workdir` / `# EXITCODE` / `# duration_s` 行）保存在仓库外的
`E:\GengYunCommander\.w32-i02-raw\`。下列为**原文照录**（超长输出保留摘要行，并标明节选）。

### 4.1 `npm ci`（干净安装）

```
> npm ci
added 103 packages, and audited 106 packages in 3s
25 packages are looking for funding
  run `npm fund` for details
found 0 vulnerabilities
# EXITCODE: 0
# duration_s: 3.04
```

前提证据：该次运行前 `node_modules` 不存在（前一条输出 `node_modules exists = False`），且删除前已确认
`node_modules` **不是 reparse point**（`IsReparsePoint: 0`），避免历史递归删除事故。

### 4.2 `npm run lint`

```
> node tools/lint-workspaces.mjs
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
# EXITCODE: 0
```

### 4.3 `npm run test:docs`

```
> node tools/run-python.mjs tools/validate_development_docs.py
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
# EXITCODE: 0
```

### 4.4 `npm run test:contract`

```
> node --test "tests/contract/*.test.mjs"
✔ API 错误码与 HTTP 状态映射与契约 states.json 完全一致
✔ API ExecutionMode 与契约 states.json 一致
✔ API 错误码集合与 openapi ErrorCode 枚举一致
✔ 错误码在状态映射中不重复归属
✔ meta.contract_version 与契约 Meta 常量一致，且必填字段齐备
✔ Error / ErrorEnvelope 形状与契约一致
ℹ tests 6   ℹ pass 6   ℹ fail 0
# EXITCODE: 0
```

### 4.5 `npm run test:unit` / `build` / `test:mini`

```
# test:unit
ℹ tests 1800   ℹ pass 1799   ℹ fail 0   ℹ skipped 1   ℹ duration_ms 24804.7
  ﹣ native separate-connection withdrawal and account state changes at guarded read boundary # SKIP
# EXITCODE: 0

# build
> tsc -p tsconfig.json                       (@gengyun/api)
> vite build                                 (@gengyun/admin)
vite v7.3.6 building client environment for production...
✓ 12 modules transformed.
dist/index.html                  0.43 kB │ gzip:  0.33 kB
dist/assets/index-6zDqB1ll.css   0.37 kB │ gzip:  0.28 kB
dist/assets/index-X2oq-tG-.js   63.52 kB │ gzip: 25.61 kB
✓ built in 3.68s
# EXITCODE: 0

# test:mini
PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.
ℹ tests 5   ℹ pass 5   ℹ fail 0
# EXITCODE: 0
```

`test:unit` 唯一跳过项 `native separate-connection withdrawal and account state changes at guarded read boundary`
（`# SKIP`）需要**原生双连接数据库**环境，不在本机无配置条件下运行；**不计入通过**。

### 4.6 缺配置必须明确失败（实测）

| 场景 | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| `APP_EXECUTION_MODE` 未设 | `npm run dev:api` | 打印 `APP_EXECUTION_MODE [MISSING] 必须显式设置，取值为 real \| stub \| preset_demo`，**未启动任何服务** | **不退出**（见下） |
| `APP_EXECUTION_MODE=real`，其余 9 项全缺 | `npm run dev:api` | 一次性列出 `DATABASE_URL` / `SESSION_SIGNING_KEY` / `DELETION_LEDGER_KEY` / `WECHAT_APP_ID` / `WECHAT_APP_SECRET` / `OBJECT_STORAGE_ENDPOINT` / `OBJECT_STORAGE_BUCKET` / `OBJECT_STORAGE_ACCESS_KEY` / `OBJECT_STORAGE_SECRET_KEY` 九项 `[MISSING]` | **不退出**（见下） |
| `APP_EXECUTION_MODE` 未设 | `npm run start --workspace @gengyun/api` | 同上缺少 `APP_EXECUTION_MODE` 的报错；`npm error code 1` | **1** ✅ |

原文（`dev:api`，stderr）：

```
启动失败：配置校验未通过。
  - APP_EXECUTION_MODE [MISSING] 必须显式设置，取值为 real | stub | preset_demo
参考 .env.example；真实密钥只放在服务端安全配置，不提交仓库。
```

原文（`dev:api`，stdout）：

```
> @gengyun/api@0.0.0 dev
> node --watch src/server.ts

Failed running 'src/server.ts'. Waiting for file changes before restarting...
```

**事实要点（不写成通过）**：文档命令 `npm run dev:api` = `node --watch src/server.ts`。配置校验**确实失败并打印字段名、也确实不启动半配置服务**；但在 `--watch` 下 Node **不会结束进程、也不返回非零退出码**，10 秒探针窗口结束时子进程仍存活（由本次取证强制 `taskkill /T /F` 收尾）。需要退出码的自动化入口应使用 `npm run start --workspace @gengyun/api`（实测 exit 1）。该项与文档的差异处理见第 7 节。

### 4.7 `npm run dev:api`（stub）启动与 `/health` 探针

服务确实以 `stub` 启动（原文，机器名已隐去）：

```
{"level":30,...,"msg":"Server listening at http://127.0.0.1:3000"}
{"level":30,...,"execution_mode":"stub","database_configured":false,"msg":"gengyun api 已启动（已装配认证与后台认证路由；其余业务路由未实现）"}
```

**但默认端口 3000 上的 `/health` 探针在本机不可信**：本机已有**与耕云无关**的进程占用 3000。

```
port 3000 <- :: pid=41000 proc=node     # 无关项目（返回的是"浙江农林大学电脑医院"Next.js 站点 HTML 的 404）
port 3001 : free ; port 3100 : free ; port 4318 : free ; port 5173 : free
```

我们的 API 仍能 `bind 127.0.0.1:3000`（Windows 上 `SO_REUSEADDR` 允许双绑），因此**探针实际打到了别人的服务**（返回该站点 HTML，而非 Fastify 契约错误封套）。**默认端口上的 `/health` 证据在本机无法取得可信结论**，改用空闲端口 `API_PORT=3001` 重新取证（结果在后续提交补齐）。

### 4.8 微信开发者工具 CLI（已完成部分）

```powershell
& "D:\微信web开发者工具\cli.bat" islogin
```

```
√ IDE server has started, listening on http://127.0.0.1:41195
{"login":true}
√ islogin
# EXITCODE: 0
```

隔离工程生成（未改动 IDE 中已打开的其它工程）：

```powershell
Copy-Item config/debug.local.json.example config/debug.local.json   # 已存在则保留
node tools/prepare-wechat.mjs local --config config/debug.local.json
```

```
LOCAL import root: E:\GengYunCommander\GengYun_W32\.local\wechat-local
Local client base (runtime.apiBaseUrl): http://127.0.0.1:4318 ; diagnostic stub only; enable the personal domain exception only in this isolated project if needed.
# EXITCODE: 0
```

`cli.bat open --project .\.local\wechat-local`（导入并编译）、`auto`／实际 `SDKVersion` 基础库读数：**待补**（第 8 节）。

### 4.9 `npm run dev:admin`：**待补**

## 5 未取得项（截至本次提交）

| 项 | 状态 | 原因 | 复核命令（后续可执行） |
| --- | --- | --- | --- |
| **前置 GY-I01 的全部验收** | **未取得** | 属 issue #1，不在本片范围；本片不代替其验收 | 按 `docs/architecture/acceptance-map.md` 与 #1 台账执行 |
| **Android 真机** | **未取得** | 属 #23（真机属该 issue）；本片不出具真机结论 | 见 `docs/verification/platform-checklist.md` |
| 真实供应商能力 | **未取得** | 需用户单独授权的付费调用，本片不发起 | 见 `docs/verification/provider-matrix.md` |
| 域名／网关／CDN／正式发布 | **未取得** | 本片不做；属发布与 #24 | 见 `deploy/cloudrun/README.md` |
| 默认端口 3000 上的 `/health` 可信证据 | **未取得**（本机不可信） | 本机 3000 已被无关进程占用，探针打到他人服务 | 改用 `API_PORT=3001` 复跑（本片进行中） |
| `cli.bat open --project` 编译结果、实际基础库 `SDKVersion` | **待补** | 本页首次提交时尚未执行 | `& "D:\微信web开发者工具\cli.bat" open --project .\.local\wechat-local` |
| `npm run dev:admin` 实证 | **待补** | 本页首次提交时尚未执行 | `npm run dev:admin`（默认 `127.0.0.1:5173`） |
| 原生库迁移负例、OpenAPI 2020-12 与 Fastify 适配实测 | **未取得** | 属 GY-I02 验收表其余项，需数据库/独立工作，本片不冒称 | `docs/architecture/acceptance-map.md` GY-I02 行 |

**不冒称**：本机微信模拟器编译成功不等于真机通过；`npm run test:mini` 明确自述「Not a WeChat compiler or device test」；本片全部结果均**未**覆盖真机、真实身份、真实数据库与供应商。

## 6 构建产物与忽略规则核对

`git check-ignore -v` 逐条确认（**全部命中忽略，不会入库**）：

```
.gitignore:22:dist/            → apps/admin/dist, services/api/dist
.gitignore:44:/.local/         → .local/wechat-local
.gitignore:45:/config/*.local.json → config/debug.local.json
.gitignore:17:node_modules/    → node_modules
.gitignore:11:.env             → .env
```

`git status --short` 在构建与准备隔离工程之后仍为空。

## 7 文档与事实对照（逐处）

| # | 文档原文（位置） | 实测 | 处理 |
| --- | --- | --- | --- |
| （待补） | | | |

## 8 后续提交待补清单

1. `npm run dev:api`（stub，`API_PORT=3001`）＋ `/health` 原始响应与退出码；
2. `npm run dev:admin` 启动与默认地址实证；
3. `.env` 不自动加载的实证（对照 `docs/development-guide.md` §4 与 `docs/reference/local-development.md`「常见问题」）；
4. 微信 `cli.bat open --project .\.local\wechat-local` 编译结果、`auto` 连接与实际基础库版本；
5. 第 7 节逐处「文档原文 → 实测 → 改法」对照表；
6. `git diff --stat upstream/main...HEAD` 与 HEAD SHA 回传。
