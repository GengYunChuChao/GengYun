# GY-I02 工程壳 · 干净环境可复现启动与文档对齐证据（2026-10-14）

任务：GY-I02 / GitHub issue **#2**（**Refs #2，不关闭整项**）。
范围：§1 干净环境可复现、§2 微信工具 CLI／基础库／编译路径、§3 文档与事实对齐。
本页只做**可复现性与文档**收尾，**未改任何业务实现、未改 `packages/contracts/**`、未改任何冻结命令**。

## 0 分支、基线与工作区

| 项 | 值 |
| --- | --- |
| 独立 worktree | `E:\GengYunCommander\GengYun_W32`（自建；**未改指挥仓库** `GengYun_Agent2`，未切其分支） |
| 分支 | `feat/gy-i02-clean-repro` |
| 基线 `upstream/main` | `fcfa6de9d62aeaaa0489d3319f8f06911312af48`（短 `fcfa6de`；`git fetch upstream --prune` 后读取） |
| 起点工作区 | worktree 新建，`git status --short` 为空，`node_modules` 不存在 |
| **未 push** | 是（写手不持有 GitHub 凭据；提交由指挥推送） |

创建方式（原始命令）：

```powershell
cd E:\GengYunCommander\GengYun_Agent2
git fetch upstream --prune
git worktree add E:\GengYunCommander\GengYun_W32 -b feat/gy-i02-clean-repro upstream/main
```

**未使用** junction／symlink 指向别处 `node_modules`（本仓有因此递归删文件的事故）；安装直接用锁文件 `npm ci`。
删除 `node_modules` 前先核对 `IsReparsePoint: 0`，避免删到链接目标。

## 1 运行环境（实测读数）

| 项 | 实测值 |
| --- | --- |
| OS | Microsoft Windows 11 家庭版 中文版，NT 10.0.26200.0，AMD64 |
| Node | `v24.16.0`（满足 `engines: >=24.16.0 <25`） |
| npm | `11.13.0`（满足 `engines: >=11.13.0`） |
| Python | `3.14.3`（`python3` 与 `python` 均解析到 `C:\msys64\ucrt64\...`；`$PYTHON` 未设置）⇒ 满足 README「Python 3.11+ 用于文档检查」 |
| 取证 shell | **Windows PowerShell 5.1.26100.8875（Desktop）**，非 PowerShell 7 |
| 微信开发者工具 | `2.02.2608080`（Stable；读自 `D:\微信web开发者工具\resources\app.asar.unpacked\package.json` 的 `version` 与 `window.title`） |
| 微信工具 CLI | `D:\微信web开发者工具\cli.bat`（实测存在，与 README 记载一致） |
| 官方自动化 SDK | `miniprogram-automator@0.12.1`（本机既有隔离副本，仅作参数传入，**未加入业务依赖或锁文件**） |

### 1.1 本机环境限制（会影响复现，如实列明）

1. **“干净机器”在本机无法完全模拟**：本机是长期使用的开发机，存在与耕云无关的进程与全局状态（最典型的是 **3000 端口被无关的另一个 node 服务占用**，见 §4.7）。本片只能做到「**干净安装**（无 `node_modules` 起点 ＋ `npm ci` 锁文件安装）＋ 干净 worktree ＋ 干净工作区」，**不等于**全新操作系统／全新用户配置／全新网络环境。命令通过不豁免这一点。
2. 本机进程环境**同时存在** `HTTP_PROXY`/`http_proxy`、`NO_PROXY`/`no_proxy` 大小写重复项；Windows PowerShell 5.1 因此让 `Start-Process` 直接抛 `ArgumentException`。取证时的处理是**只删除小写重复项**（值完全相同，大写对保留，子进程代理行为不变）。
3. 本机执行策略**禁止 dot-source 磁盘上的 `.ps1`**（未改系统策略）；取证脚本改用 `Invoke-Expression` 内联加载。
4. 本机 `HTTP_PROXY=http://127.0.0.1:7897` 生效。PowerShell 5.1 的 `Invoke-WebRequest` 会把**回环地址也送进代理**，对 `127.0.0.1:*` 的探针曾返回**代理侧**的 404。对回环端点的取证改用 `HttpWebRequest` ＋ `Proxy = $null` 显式绕过代理。
5. 除 3000 外的候选端口无冲突：3001／3100／4318／5173 在取证时均为空闲。

## 2 “干净”在本片的精确含义

| 维度 | 本片做到 | 未做到 |
| --- | --- | --- |
| 源码 | 全新 worktree，`upstream/main` = `fcfa6de`，无本地改动 | —— |
| 依赖 | `node_modules` **先删除**再 `npm ci`（锁文件安装，非 `npm install`） | 未清理全局 npm 缓存／全局 npm 配置（`npm ci` 会从缓存取包） |
| 进程 | 每次取证为独立 shell 进程；已逐项确认 `APP_EXECUTION_MODE`/`DATABASE_URL`/`SESSION_SIGNING_KEY`/`DELETION_LEDGER_KEY`/`WECHAT_APP_ID`/`WECHAT_APP_SECRET`/`OBJECT_STORAGE_ENDPOINT`/`API_PORT` **均为 unset** | 未重启操作系统 |
| 网络 | 命令只访问本机回环，或安装时的 npm 注册表 | 非隔离网络命名空间 |
| 目录 | 未用 junction／symlink 复用他处依赖 | —— |

## 3 复现命令清单（照仓库文档）

```powershell
npm ci
$env:APP_EXECUTION_MODE = 'stub'
npm run dev:api                     # 本机默认 3000 被占用，见 §4.7，改用 API_PORT=3001 取证
npm run dev:admin                   # 另开终端
npm run lint
npm run test:unit
npm run test:contract
npm run test:reference
npm run test:evaluation
npm run build
npm run test:mini
```

## 4 逐条命令原始输出与退出码

原始日志（UTF-8，含 `# command` / `# workdir` / `# EXITCODE` / `# duration_s`）保存在**仓库外**
`E:\GengYunCommander\.w32-i02-raw\`。下列为**原文照录**；超长输出只保留关键行并标明节选。
机器名按仓库口径隐去（`docs/verification/wechat-compatibility-candidates.md`：机器名仅保存在忽略证据 JSON）。

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

前提证据：该次运行前输出 `node_modules exists = False`。

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
✔ API 错误码与 HTTP 状态映射与契约 states.json 完全一致
✔ API ExecutionMode 与契约 states.json 一致
✔ API 错误码集合与 openapi ErrorCode 枚举一致
✔ 错误码在状态映射中不重复归属
✔ meta.contract_version 与契约 Meta 常量一致，且必填字段齐备
✔ Error / ErrorEnvelope 形状与契约一致
ℹ tests 6   ℹ pass 6   ℹ fail 0
# EXITCODE: 0
```

### 4.5 `npm run test:unit` / `npm run build` / `npm run test:mini`

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

`test:unit` 唯一跳过项 `native separate-connection withdrawal and account state changes at guarded read boundary`（`# SKIP`）
需要**原生双连接数据库**环境，在本机无配置条件下不运行，**不计入通过**。

### 4.5b 文档命令表中的其余两层（`test:reference` / `test:evaluation`）

`docs/development-guide.md` §6 的命令表还列了这两条，`engineering-shell.yml` 的 CI 也各有一个 job，故一并复跑留档：

```
# test:reference
ℹ tests 276   ℹ pass 276   ℹ fail 0   # EXITCODE: 0

# test:evaluation
ℹ tests 84    ℹ pass 84    ℹ fail 0   # EXITCODE: 0
```

`test:evaluation` 按文档口径**不等于真实模型指标**（只用 Node 标准库与合成夹具，禁用真实外部调用），本页不据此声称任何能力达标。

### 4.6 缺配置必须明确失败（实测；**不把失败写成成功**）

| 场景 | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| `APP_EXECUTION_MODE` 未设 | `npm run dev:api` | 打印 `APP_EXECUTION_MODE [MISSING]`，**未启动任何服务** | **不退出**（见下） |
| `APP_EXECUTION_MODE=real`，其余 9 项全缺 | `npm run dev:api` | 一次性列出 9 个字段的 `[MISSING]` | **不退出**（见下） |
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

`real` 模式实测列出的 9 个必填字段（与 `.env.example` 的「real 必填」标记一致）：
`DATABASE_URL`、`SESSION_SIGNING_KEY`、`DELETION_LEDGER_KEY`、`WECHAT_APP_ID`、`WECHAT_APP_SECRET`、
`OBJECT_STORAGE_ENDPOINT`、`OBJECT_STORAGE_BUCKET`、`OBJECT_STORAGE_ACCESS_KEY`、`OBJECT_STORAGE_SECRET_KEY`。

**事实要点（不写成通过）**：文档命令 `npm run dev:api` = `node --watch src/server.ts`。配置校验**确实失败、确实打印字段名、确实不启动半配置服务**；但在 `--watch` 下 Node **不结束进程、也不返回非零退出码**（10 秒窗口结束时子进程仍存活，由取证脚本 `taskkill /T /F` 收尾）。**需要退出码的自动化入口应使用 `npm run start --workspace @gengyun/api`（实测 exit 1）。**
本片**未改 `dev:api` 脚本行为**（属 GY-I02 冻结命令，且改动属治理范围）；只做文档补充（§7 第 2 项），是否要求后续修正由监工裁定。

### 4.7 `npm run dev:api`（stub）启动与 `/health` 探针

**默认端口 3000 在本机不可信**：本机已有与耕云无关的 node 进程监听 3000，探针返回的是**另一站点**的 404 HTML。

```
port 3000 <- :: pid=41000 proc=node     # 无关项目
port 3001 : free ; port 3100 : free ; port 4318 : free ; port 5173 : free
```

我们的 API 仍能 `bind 127.0.0.1:3000`（Windows 上 `SO_REUSEADDR` 允许双绑），因此默认端口上的 `/health` 探针**实际打到了别人的服务**。因此**在空闲端口 `API_PORT=3001` 上取证**（属本机环境限制，不改仓库默认端口、不改文档默认值）：

服务启动原文（机器名已隐去）：

```
{"level":30,...,"msg":"Server listening at http://127.0.0.1:3001"}
{"level":30,...,"execution_mode":"stub","database_configured":false,"msg":"gengyun api 已启动（已装配认证与后台认证路由；其余业务路由未实现）"}
```

探针原文（直接回环、显式绕过代理）：

```
GET http://127.0.0.1:3001/health -> HTTP 200
{"status":"ok","checks":{"api":{"status":"ok"},"database":{"configured":false,"status":"not_configured"}},
 "meta":{"request_id":"…","contract_version":"1.0.0","execution_mode":"stub"},"uptime_s":1}

GET http://127.0.0.1:3001/api/v1/public/home -> HTTP 503
{"error":{"code":"PROVIDER_UNAVAILABLE","message":"主页资料数据库尚未接入","retryable":false,"details":[]},
 "meta":{"request_id":"…","contract_version":"1.0.0","execution_mode":"stub"}}

GET http://127.0.0.1:3001/api/v1/no-such-route -> HTTP 404
{"error":{"code":"NOT_FOUND","message":"未实现的路径：GET /api/v1/no-such-route","retryable":false,"details":[]},
 "meta":{"request_id":"…","contract_version":"1.0.0","execution_mode":"stub"}}
```

解读（**不夸大**）：`/health` 200 且 `status:"ok"` 是因为 stub 模式下 `database` 为 `not_configured` **属于预期状态**（`services/api/src/routes/health.ts`：`not_configured` 只在 `real` 下判降级）。**这不代表数据库可用**：`database.configured=false`。业务路由 `/api/v1/public/home` 在无数据库时返回 503 `PROVIDER_UNAVAILABLE`，**未通过**；未知路径返回契约错误封套 404，符合「契约列出的路径不等于已实现」。

### 4.8 `npm run dev:admin`

```
> vite
  VITE v7.3.6  ready in 1181 ms
  ➜  Local:   http://127.0.0.1:5173/

GET http://127.0.0.1:5173/ -> HTTP 200
<!doctype html> … <title>耕云 · 独立后台（骨架）</title> … <script type="module" src="/src/main.ts"></script>
```

与文档一致：后台默认 `127.0.0.1:5173`。**页面 HTTP 200 不证明鉴权／API 联调**（文档原有口径）。

### 4.9 `.env` 不自动加载（对照文档）

按文档口径「复制 .env 不会让 Node 自动读取」，实测：在仓库根写入只含 `APP_EXECUTION_MODE=stub` 的 `.env`，**进程环境不设置该变量**，执行非 watch 入口：

```
> @gengyun/api@0.0.0 start
> node src/server.ts

启动失败：配置校验未通过。
  - APP_EXECUTION_MODE [MISSING] 必须显式设置，取值为 real | stub | preset_demo
npm error Lifecycle script `start` failed with error:
npm error code 1
# EXITCODE: 1
```

⇒ **`.env` 确实不生效**，与 `docs/development-guide.md` §4 及 `.env.example` 的说明一致。
测完已删除该 `.env`（`exists=False`），`git status --short` 仍为空；`.env` 本就被 `.gitignore` 忽略，**未入库**。

### 4.10 微信工具 CLI：登录、隔离工程、导入编译、实际基础库

**CLI 路径与登录**（README 记载路径实测一致）：

```powershell
& "D:\微信web开发者工具\cli.bat" islogin
```

```
√ IDE server has started, listening on http://127.0.0.1:41195
{"login":true}
√ islogin
# EXITCODE: 0
```

**隔离工程生成**（未改动 IDE 中已打开的其它工程目录）：

```powershell
Copy-Item config/debug.local.json.example config/debug.local.json
node tools/prepare-wechat.mjs local --config config/debug.local.json
```

```
LOCAL import root: E:\GengYunCommander\GengYun_W32\.local\wechat-local
Local client base (runtime.apiBaseUrl): http://127.0.0.1:4318 ; diagnostic stub only; …
# EXITCODE: 0
```

**导入并编译**——相对路径**失败**，绝对路径**成功**（这是本片发现的文档不一致，见 §7 第 1 项）：

```
# 相对路径：& cli.bat open --project .\.local\wechat-local
- preparing
× preparing
[error] { code: 10, message: 'Error: 错误 Error: 项目路径不存在 (code 10)…' }
# EXITCODE: 0        ← 注意：出错仍返回 0，不能用退出码判断成败

# 绝对路径：& cli.bat open --project 'E:\GengYunCommander\GengYun_W32\.local\wechat-local'
- preparing
√ open
# EXITCODE: 0   # duration_s: 2.86

# 与文档改法一致的写法：& cli.bat open --project "$PWD\.local\wechat-local"
√ open
# EXITCODE: 0   # duration_s: 1.9
```

**自动化会话与实际基础库版本**：

```powershell
& "D:\微信web开发者工具\cli.bat" auto --project 'E:\GengYunCommander\GengYun_W32\.local\wechat-local' --auto-port 9421
# 启动阶段
- Fetching AppID () permissions
√ Using AppID: wx4407a4b908a69a54
√ auto
```

随后由官方 `miniprogram-automator@0.12.1` 连接 `ws://127.0.0.1:9421` **只读**读取（不点击、不登录、不上传、不读用户数据）：

```
stage: connected
systemInfo: {"platform":"devtools","SDKVersion":"3.17.3","version":"8.0.5","model":"iPhone 12/13 (Pro)",
             "system":"iOS 10.0.1","windowWidth":390,"windowHeight":753,"pixelRatio":3}
getAppBaseInfo: UNAVAILABLE (Error)
currentPage: {"path":"pages/home/home"}
pageStack: ["pages/home/home"]
RESULT: OK
```

⇒ **实际基础库 `SDKVersion` = `3.17.3`**，与 `project.config.json` 的 `libVersion: "3.17.3"` 目标一致；隔离工程**编译并渲染出首页**（`pages/home/home`）。
**不冒称**：`platform` 为 `devtools`（模拟器），**不是真机**；`getAppBaseInfo` 这条读取路径本次不可用（已在结果中标注），`SDKVersion` 取自 `systemInfo`。

一次重试记录：首个 `cli auto` 会话（`--auto-port 9420`，项目刚 `open` 后 12 秒）连接后 `callWxMethod` 超时（`timeout waiting for automator response`）；换**新端口 9421** 并等 25 秒后成功。历史证据也记过同类「端口卡死需换新 `--auto-port`」。

**未执行 `cli close`**：它会关掉工具服务／工程窗口，可能影响 IDE 中其它工程（本次 IDE 原本就开着用户自己的工程）。本片只用 `taskkill /T /F` 结束自己启动的 `cli auto` 进程。
**副作用如实说明**：本次 `open/auto` 后，IDE 中除用户原有工程外会多出「`E:\GengYunCommander\GengYun_W32\.local\wechat-local`」这个隔离工程窗口；未删除、未改动 IDE 中已打开的其它工程目录。

## 5 未取得项（如实列出；含原因与复核命令）

| 项 | 状态 | 原因 | 复核命令／入口 |
| --- | --- | --- | --- |
| **前置 GY-I01 的全部验收** | **未取得** | 属 issue #1，不在本片范围；本片不代替其验收 | `docs/architecture/acceptance-map.md` 与 #1 台账 |
| **Android 真机** | **未取得** | 属 #23；本片 `platform=devtools`，**不出具真机结论** | `docs/verification/platform-checklist.md` |
| 真实供应商能力 | **未取得** | 需用户单独授权的付费调用，本片不发起 | `docs/verification/provider-matrix.md` |
| 域名／网关／CDN／正式发布 | **未取得** | 本片不做；属发布与 #24 | `deploy/cloudrun/README.md` |
| 默认端口 3000 的 `/health` 可信证据 | **未取得 + 原因** | 本机 3000 被无关 node 进程（pid 41000）占用，探针打到他人服务 | 见 §4.7；空闲端口复现：`$env:API_PORT='3001'; $env:APP_EXECUTION_MODE='stub'; npm run dev:api` |
| 业务路由实际可用 | **未取得** | 无数据库，`/api/v1/public/home` 返回 503 `PROVIDER_UNAVAILABLE` | 需 `DATABASE_URL` ＋ 迁移后复跑 |
| `npm run test:unit` 跳过项 | **未取得 + 原因** | 需原生双连接数据库（`# SKIP`） | 配置原生库后复跑 `npm run test:unit` |
| 原生库迁移负例（半截失败／重放／回滚三臂） | **已取得** | 真 PG17.11 三臂读数与负控制见新证据页；本片只加测试与文档，未改迁移器 | `docs/verification/gy-i02-migrations-negative-20261017.md` |
| **OpenAPI 2020-12 与 Fastify 适配实测** | **已取得，见新证据页** | 2026-10-17 补记：运行时校验器切到 `Ajv2020`，正/反例、draft-07 双向对照与反向控制均实跑（本页其余读数保持 2026-10-14 原样） | [gy-i02-openapi-2020-fastify-20261017.md](gy-i02-openapi-2020-fastify-20261017.md) |
| 真机 `SDKVersion`／真机渲染 | **未取得** | 本片只到模拟器；真机通道历史上对 AppService 调用超时 | 见 `docs/verification/gy-i26-demo-align-20261014.md` 第 11.6 节 |

## 6 构建产物与忽略规则核对

`git check-ignore -v` 逐条确认（**全部命中忽略，不会入库**）：

```
.gitignore:22:dist/                → apps/admin/dist, services/api/dist
.gitignore:44:/.local/             → .local/wechat-local
.gitignore:45:/config/*.local.json → config/debug.local.json
.gitignore:17:node_modules/        → node_modules
.gitignore:11:.env                 → .env
```

`git status --short` 在构建、生成隔离工程、跑完上述命令后仍为空 ⇒ 构建产物与本地配置**均未进入提交**。

### 6.1 轻量门禁执行结果（含一个已定位的**非本改动引入**的误报）

| 门禁 | 命令 | 退出码 | 说明 |
| --- | --- | --- | --- |
| 静态检查 | `npm run lint` | **0** | 见 §4.2 |
| 文档检查 | `npm run test:docs` | **0** | 见 §4.3（在改完本文档后复跑） |
| 空白检查 | `git diff HEAD --check` | **2** | 6 条 `trailing whitespace`，**全部落在 `README.md` 的新增行**，含一条**新增空行**也被判为 trailing whitespace ⇒ 判的是行尾的 **CR**，不是真实尾随空格 |
| 空白检查（排除 CR） | `git -c core.whitespace=cr-at-eol diff HEAD --check` | **0** | 证明新增内容**没有真实尾随空格**；`docs/verification/gy-i02-clean-repro-20261014.md` 与 `docs/development-guide.md` 两项均在两种口径下都干净 |

原因已定位（**属仓库既有状态，非本改动引入**）：`README.md` 与 `AGENTS.md` 的 HEAD blob **本身就以 CRLF 存储**（实测 `README.md` blob：`CR=113 LF=113`），而 `docs/development-guide.md`、`package.json`、`docs/verification/README.md` 等是 LF（`CR=0`）。git 在 `core.autocrlf=true` 下对「index 副本已含 CRLF」的文件**跳过行尾归一化**，因此任何对 `README.md` 的新增行都会带着 CR 进入 diff，被默认 `core.whitespace`（不含 `cr-at-eol`）判成尾随空格。

本片**未改任何仓库配置**（`git config` 全局／共享值均未动），只在复核时用**命令行参数** `-c core.whitespace=cr-at-eol`。另实测：**CI 没有任何 workflow 运行 `git diff --check`**（`select-string 'diff --check' .github/workflows/*.yml` 零命中），故该误报不阻塞 CI。是否要在仓库层处理 `README.md` 的 CRLF 存储，属工程治理，**由监工裁定**；本片不擅自把 `README.md` 整文件转换为 LF（那会产生 113 行的全文件 diff，违反「只做最小文档修正」）。


## 7 文档与事实对照（逐处：文档原文 → 实测 → 改法）

| # | 文档原文（位置） | 实测 | 改法（纯文档，不改行为） |
| --- | --- | --- | --- |
| 1 | `README.md`「本地调试地址与微信工具 CLI」：`& "D:\微信web开发者工具\cli.bat" open --project .\.local\wechat-local`（`auto` 同） | **相对路径失败**：`code 10 项目路径不存在`——CLI 在自己的工作目录解析 `--project`；且**该错误下退出码仍为 0**。绝对路径与 `"$PWD\.local\wechat-local"` 均实测 `√ open` | 两条命令改为 `--project "$PWD\.local\wechat-local"`；并在代码块下加一句：必须传绝对路径、`code 10` 时退出码仍为 0，成败看是否出现 `√ open` |
| 2 | `README.md` §开发环境与开始方式 与 `docs/development-guide.md` §4 只写了 `npm run dev:api` 的启动方式 | 缺配置时该命令**打印缺失字段名但不退出、不返回非零退出码**（`node --watch` 常驻）；非 watch 入口 `npm run start --workspace @gengyun/api` 实测 **exit 1** | 两处各加一句：`dev:api` 为 `node --watch` 常驻，缺配置不退出；需要退出码判定用 `npm run start --workspace @gengyun/api`。**未改 `dev:api` 脚本**（属冻结命令，是否要求后续修正由监工裁定） |
| 3 | `README.md`：`& "D:\微信web开发者工具\cli.bat" close   # 关闭工程／IDE 服务` | 原文描述准确；但 `close` 会关掉工具服务，本次 IDE 中另有用户工程，故**本片故意未执行** | 仅补括注「会关掉工具服务，请确认没有其它工程在用」（提示，不纠错） |

以下逐条核对**未发现不一致**，故**未改**：CLI 路径 `D:\微信web开发者工具\cli.bat`；诊断服务地址 `http://127.0.0.1:4318`（与 `config/debug.local.json.example` 一致，其行为由已通过的 `npm run test:mini` 中 `tests/local-debug.test.mjs`「actual HTTP service is synthetic, no-store and has no business routes」覆盖）；API 默认 `127.0.0.1:3000`（`services/api/src/config.ts`：`let port = 3000`）；后台默认 `127.0.0.1:5173`（实测 Vite `Local: http://127.0.0.1:5173/`）；基础库目标 `3.17.3`（实测 `SDKVersion=3.17.3`）；`Python 3.11+`（实测 3.14.3）；Node/npm 版本；`.gitignore` 规则。
`README.md` 提到的「本机实测 3100 端口的本地替身 API」与 `npm run dev:api` 默认 3000 **不矛盾**：3100 是 `tools/local-dev/prepare.mjs` 的默认 `apiPort=3100`，而 3000 是 API 进程自身默认端口，README 该处本就写作 `<api端口>`。

## 8 本片结论与边界

- 工程壳的**安装、静态检查、单元／契约／小程序静态检查、构建**与**两个开发入口的启动**在本独立 worktree 上可复现，退出码与原始输出已留档。
- **缺配置明确失败**成立（字段名齐备、不启动半配置服务），但 `dev:api` 的退出码行为已在文档中写明并单独列为待监工裁定项。
- 微信工具链**已登录、可导入编译隔离工程、实际基础库 `3.17.3`**；**真机不在本片**（属 #23）。
- **前置 GY-I01、Android 真机、真实供应商、域名／正式发布一律未取得**，本页不据此关闭 #2 整项。
