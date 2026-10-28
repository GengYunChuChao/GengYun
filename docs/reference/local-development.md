# 本地开发与故障排查

主路径见[开发指南](../development-guide.md)。本页补充本地联调的完整流程、端口与日志、共用机器与真机边界，以及常见故障。

## 现役本地联调（tools/local-dev）

现役流程是**真实 PostgreSQL + 受限 LOGIN 角色 + `stub` 执行模式的 API + 合成微信身份**：数据库是真的，微信身份和档案资料是合成夹具，AI 与供应商未接入。它不是发布版本，也不能当作真机或正式环境证据。

| 组成 | 作用 |
| --- | --- |
| `tools/local-dev/prepare.mjs` | 唯一 CLI 入口；校验共享配置，生成**被忽略的**一套隔离产物 |
| `tools/local-dev/start.ps1` | 建私密目录、初始化并启动 PG、建库跑迁移、隐藏窗口起 API、健康门禁 |
| `tools/local-dev/stop.ps1` | 只停本工具起的两类进程，**保留数据** |
| `tools/local-dev/api.mjs` | 产物内启动器：恒定 `stub`、恒定绑回环，另注册诊断路由 |
| `tools/local-dev/database.mjs` | 建库、跑迁移、建受限角色、引导合成夹具 |
| `tools/local-dev/profile-bootstrap.mjs` | 夹具幂等引导；已存在数据不一致时拒绝覆盖 |
| `tools/local-dev/smoke.mjs` | 产物内冒烟：合成 `wx` 替身 → 真 API → 真 PG（当前与 `api.mjs` 不一致，见下文） |

### 前提

| 项 | 要求 |
| --- | --- |
| Node | 24.16.0；`package.json` 的 engines 为 `>=24.16.0 <25` |
| npm | >= 11.13.0 |
| 系统 | Windows；脚本是 Windows PowerShell 5.1 语法 |
| PostgreSQL | 自备 PostgreSQL 17 的 `bin` 目录，必须**同时**含 `initdb.exe` 与 `pg_ctl.exe`；仓库不内置、也不通过 npm 提供，用官方 Windows 安装包的安装目录或解压版都行，不必加进 PATH |
| 权限 | 不需要管理员权限、不需要预先注册 PG 服务、不需要全局 `pg_ctl` 在 PATH |
| 目录 | 每人一套自己的检出与自己的 `.local/local-dev` |

`prepare.mjs` 拒绝不合格输入并在写任何产物前退出：端口必须是整数且落在 `1024..65535`、API 与 PG 端口必须不同、`--pg-bin` 必须先满足上面的两个 exe、共享 `project.config.json` 必须仍是 `compileType=miniprogram` + `miniprogramRoot=miniprogram/` + `setting.urlCheck=true`、共享 `miniprogram/config/runtime.js` 必须仍是禁用态原文、产物目录已存在即拒绝覆盖。

### 每人一套的完整流程

```powershell
npm ci
node tools/local-dev/prepare.mjs --pg-bin <PostgreSQL bin 目录>
powershell -NoProfile -ExecutionPolicy Bypass -File .\.local\local-dev\start.ps1
```

1. `npm ci`：迁移与 API 依赖仓库根 `node_modules`，必须先装。
2. `prepare.mjs`：成功后打印 `Prepared isolated local environment: <仓库根>\.local\local-dev`。
3. `start.ps1`：成功时以 `READY: API http://127.0.0.1:<api端口>; PG 127.0.0.1:<pg端口>; synthetic WeChat identity.` 与 `WeChat import directory: <仓库根>\.local\local-dev\wechat` 结束。
4. 微信开发者工具导入 `.local\local-dev\wechat`（**不是仓库根**）。产物带自己的 `project.config.json` 与 `project.private.config.json`（`urlCheck=false`），“不校验合法域名”只作用于这个被忽略副本。
5. 停服：`powershell -NoProfile -ExecutionPolicy Bypass -File .\.local\local-dev\stop.ps1`，输出 `Local API and owned PostgreSQL stopped; data retained.`。

首次运行会在 `.local/local-dev/private/` 生成随机口令（两个 48 位十六进制串）、`initdb` 数据目录并启动实例。口令**只落在这个被忽略目录**，不要复制到仓库、聊天或验证页。

`-ExecutionPolicy Bypass` 只作用于当次进程。若直接 `& .\.local\local-dev\start.ps1` 报“未对文件 … 进行数字签名”，就说明当前执行策略没有放行该位置，用上面的写法而不是去改系统策略。

### 端口、日志、重置

| 项 | 位置 / 默认值 |
| --- | --- |
| API 端口 | 默认 3100，`--api-port` 可改 |
| PostgreSQL 端口 | 默认 55436，`--pg-port` 可改 |
| 绑定地址 | 工具写死回环 `127.0.0.1`（API 与 PG 都是），不支持 `0.0.0.0` |
| 产物与仓库根对应关系 | `.local/local-dev/settings.json`（含 `repoRoot`/`postgresBin`/`nodePath`/两个端口） |
| 私密目录 | `.local/local-dev/private/`（口令、PG 数据、日志、`api.pid`） |
| 日志 | `start.ps1` 写 `private/init.log`（`initdb` 输出重定向）、`private/pg.log`（`pg_ctl -l`）、`private/pg-start.log`、`private/pg-start-error.log`（`pg_ctl start` 的 stdout/stderr 重定向）、`private/api.log`、`private/api-error.log`（API 进程的 stdout/stderr 重定向）；`stop.ps1` 写 `private/pg-stop.log`、`private/pg-stop-error.log`（`pg_ctl stop` 的 stdout/stderr 重定向） |
| 整棵树 | `.local/` 已被 git 忽略，永远不要把它的内容提交或贴进 issue |

- **换端口**：`prepare.mjs` 对已有产物直接拒绝（`Output exists; preserve it or use its existing start/stop scripts`）。改端口要先停服，再删掉整个 `.local/local-dev`，然后用新参数重跑 `prepare.mjs`。
- **重置数据**：停服后删除 `.local/local-dev/private/`，再重跑 `start.ps1`。这会**丢弃全部本地数据**，并重新生成口令与空库；删除前务必确认绝对路径就是自己的这一份。只想清数据、不想换端口时用这一条。
- **端口被占**：`start.ps1` 在启动前先探测端口，占用即失败。注意报错文案是**写死的默认端口**（见下文已知缺陷），用自定义端口时不要被字面数字误导。
- **迁移数量、夹具条数**（本机实测为 `13 applied`、`4 crops, 102 regions`）随版本变化，以自己那次运行的输出为准。

### 共用一台机器

同一台机器上多人开发时，各自检出 + 各自 `npm ci` + 各自 `.local/local-dev`，用 `--api-port` / `--pg-port` 把两套端口错开即可（自定义端口已实测可用）。不要共用同一个产出目录，也不要跨检出做 `node_modules` 链接。

手机／真机接入**没有受支持的路径**：`prepare.mjs` 把 `http://127.0.0.1:<api端口>` 写进产物 runtime，`api.mjs` 也把 `API_HOST` 固定为 `127.0.0.1`，`start.ps1` 的健康门禁同样只轮询回环。实测只改 `API_HOST` 为私网 IP 的后果是：PG 与迁移正常，但 `start.ps1` 以 `Local health check failed; inspect private logs locally` 失败，而手工起的 API 只监听该私网地址、回环反而不通。因此：

- ⛔ 不要把 API 或 PG 绑到 `0.0.0.0`。
- 真要做手机接入，只能手工改**被忽略副本**里的绑定，并自行承担“无健康门禁、`npm ci` 重装即丢”的代价；仓库脚本始终只支持回环。
- 只放行该端口，且只对防火墙的**专用网络**配置文件放行；不要为一次联调放开公用网络。
- 手机上的 `localhost` 指手机自己，不是电脑；必须用电脑的私网地址。
- 公司／校园网的 AP 隔离、VPN 与客户端防火墙会静默拦掉同网段访问，先排查这些再怀疑代码。

### 与正式环境的关系

- 本地 API 恒定 `stub` 执行模式（`api.mjs` 显式注入 `APP_EXECUTION_MODE=stub`），供应商与 AI 一律未接入。
- 档案与目录来自**合成夹具**，不是已核准的真实资料；夹具初始化只建表、不种任何已核准知识记录。
- `GET /api/v1/public/home` 在非 `real` 模式下按设计返回 503 `PROVIDER_UNAVAILABLE`（“主页资料数据库尚未接入”），这是契约内行为，不是缺陷；未带令牌访问 `/api/v1/auth/session`、`/api/v1/catalog/*`、`/api/v1/knowledge` 一律 401。
- 公网／正式环境需要**已备案的 HTTPS 域名**，并在小程序后台配置服务器域名；本地 HTTP 与“不校验合法域名”只是隔离副本的个人工具开关，不能当正式 HTTPS、备案或真机资格证据。
- 发布仍走[开发指南](../development-guide.md)的部署顺序；本地跑通不等于可以上传。

## 旧的诊断替身（历史旁路，仍在仓库）

`tools/prepare-wechat.mjs`（`local --config <文件>` / `release`）、`tools/local-debug-server.mjs`、`config/debug.local.json.example`、`.local/wechat-local` 仍保留可用，但只提供**不带数据库、不带业务 API** 的合成状态替身（`GET /__local__/status`，未知路径 404），适合只验证“打包副本 + 网络开关”这一层：

```powershell
if (!(Test-Path config/debug.local.json)) { Copy-Item config/debug.local.json.example config/debug.local.json }
node tools/prepare-wechat.mjs local --config config/debug.local.json
node tools/local-debug-server.mjs --config config/debug.local.json
```

- 导入 `.local/wechat-local`；诊断替身默认 `http://127.0.0.1:4318`，`apiBaseUrl` 是**客户端拼接基址**（客户端自行拼 `/auth/…`、`/me/profile`），所以接真实本地 API 时必须写成 `http://127.0.0.1:<api端口>/api/v1`，否则登录会打到 `/auth/wechat` 而 404。
- 输出已存在时拒绝覆盖；终端 Ctrl+C 停。`release` 生成关闭网络的安全准备副本，不能直接用于比赛。
- 本页已改为以现役 `tools/local-dev/*` 为主路径；旧替身**不是**“本地开发”的等价替代。工具／手机与历史兼容记录见[原微信调试记录](../archive/development-2026-10-10/docs/local-wechat-debug.md)；仓库其它位置（`README.md`、`docs/development-guide.md`、`docs/archive/`、`docs/ui-demo/`、`.github/workflows/local-wechat.yml`）仍按旧替身叙述，未在本页范围内同步。

## 已知不一致与缺陷

| 现象 | 事实与影响 |
| --- | --- |
| `smoke.mjs` 在干净环境必然失败 | 它断言 `/api/v1/knowledge` 默认返回空列表，而 `api.mjs` 硬设 `APP_KNOWLEDGE_UNVERIFIED_SEED=1` 会放行未核对条目，于是断言失败。两者同批产物却对不上；冒烟前先知道这条，不要据此判断环境坏了 |
| 端口占用报错文案写死 | 实际用 `--api-port`/`--pg-port` 时，仍未占用也会报 `Port 3100 belongs to another service` / `Port 55436 belongs to another service`，数字是默认值不是你的配置值 |
| PowerShell 5.1 环境变量大小写冲突 | 环境里同时存在 `no_proxy`/`NO_PROXY` 等大小写重复键时，`Start-Process` 重定向会报 `Item has already been added`，`start.ps1` 首次失败；当次进程内清掉小写变量后即可通过，不必改系统或仓库 |

## 常见问题

| 现象 | 先查什么 |
| --- | --- |
| `prepare.mjs` 报缺 `--pg-bin` 或目录不合格 | 传入的目录要同时含 `initdb.exe` 与 `pg_ctl.exe`；不要指向 PATH 或安装器的 `data` 目录 |
| `prepare.mjs` 报共享配置被改 | `project.config.json` 的 `urlCheck` 必须是 `true`，共享 `miniprogram/config/runtime.js` 必须是禁用态原文；本地化只发生在被忽略副本里 |
| `start.ps1` 报端口被占 | 先看上面的“写死文案”说明；确认后换端口或停掉占用者，不要改脚本 |
| 健康门禁失败 | 看 `private/api.log`、`private/api-error.log`、`private/pg.log`；这些日志属私密目录，不要外贴 |
| API 启动提示缺配置 | 是否把变量注入进程；单纯复制 .env 不生效；real 要求完整配置 |
| 后台页面打开但鉴权请求失败 | VITE_API_BASE_URL、同源代理、Cookie 与服务端鉴权；页面 HTTP200 不证明 API 联调 |
| 小程序页面能打开但无业务请求 | 确认导入的是 `.local\local-dev\wechat` 且其 runtime 为 `local`；旧诊断替身不是业务 API；准备工具未包含新的页面依赖 |
| 迁移发现旧校验和不同 | 停止改写旧迁移，核对版本；不用删除台账掩盖 drift |
| 数据库 CLI 拒绝连接 | 两种来源／暂存 CLI 有独立本机库、角色和 URL 约束；不改用管理员绕过 |
| 模拟／种子能展示但无法产用量卡 | 合格来源、制剂、条件、原文缺项；不是靠强行开启按钮修复 |

如果已有本机代理地址为 127.0.0.1:7897，可只对本次安装配置，保持 TLS：

```powershell
npm ci --proxy=http://127.0.0.1:7897 --https-proxy=http://127.0.0.1:7897
```

## 未验证项

以下均**未在本页写作环境完成验证**，不要当成已通过的事实：

1. **微信开发者工具导入、编译与真机预览**：本页只验证到产物目录与 runtime 内容，未做 GUI 导入／编译；步骤 4 的按钮路径以本机工具版本为准。
2. **手机／真机接入**：现役工具不支持（上文的失败读数是唯一实测结论），没有可推荐的完整命令序列。
3. **基础库版本与 AppID 归属**：产物沿用共享工程配置，未核对本机工具实际使用的基础库版本与账号权限；例外是旧替身 `tools/prepare-wechat.mjs local --appid wx…` 会用测试号／自有 AppID 覆盖**生成副本**的 appid（共享工程不变），该路径同样未做工具内核对。
4. **公网 HTTPS、备案与后台服务器域名**：未部署、未验证；相关要求只作方向引用。
5. **执行策略**：只知道本机直接运行 `.ps1` 会被签名策略拒绝、`-ExecutionPolicy Bypass` 可用；更严格的机器级策略未验证。
6. **私密目录 ACL**：`start.ps1` 调用 `icacls` 收紧权限且当次成功，未独立复核 ACL 读数。
7. **`prepare.mjs` 的拒绝分支**：端口、缺 exe、共享配置被改、输出已存在四条已实测；“拒绝符号链接”与超长／非 ASCII 路径只读源码，未构造用例。
8. **多套实例并行**：只验证过单套；两套同时运行未验证。
9. **`stop.ps1` 的异常路径**：正常停服与“数据保留”已实测；API 进程被外部结束后再停、以及 `api.pid` 被替换的拒绝分支未实测。

其余具体故障按对应固定 SHA 验证页排查；不把历史测试数量／截图当当前证据。

## 本地为什么发不出帖（用途授权层）

一句话：本地库 `consent_policies` 是 **0 行**，`POST /me/consents` 因为「没有可用的已核验用途政策」被 403，`POST /posts` 在**授权闸**就被 403；审核层（含任何演示／替身审核端口）根本没有被调用。读面不受影响。这不是缺陷，是授权层的正确 fail-closed。

### 实测现象（本机，2026-10-29，基线 `719e4267`）

环境：`APP_EXECUTION_MODE=stub`、`API_PORT=3102`、`DATABASE_URL` 指向本机 PG（`127.0.0.1:5544`，库 `gengyun`，该集群唯一角色是 `postgres`）、`APP_KNOWLEDGE_UNVERIFIED_SEED=1`、`WECHAT_STUB_SUBJECT=qa-dev-1`；先用 `POST /api/v1/auth/wechat`（`{"code":"qa-dev-1"}`）拿用户会话。

| 请求 | 读数 |
| --- | --- |
| `POST /api/v1/me/consents`（`{"purpose":"public_posting","policy_version":"v1","recipient_ids":[]}`） | **403** `CONSENT_REQUIRED`「没有可用的已核验用途政策」，`retryable:false` |
| `POST /api/v1/posts`（`{"title":"…","body":"…","media_ids":[]}`） | **403** `CONSENT_REQUIRED`「当前身份或用途授权不满足要求」，`retryable:false` |
| `GET /api/v1/posts` | **200** `{"items":[],"next_cursor":null}` |
| `GET /api/v1/me/consents` | **200** `{"items":[],"next_cursor":null}` |
| `GET /api/v1/me/privacy-policy` | **200** `{"version":"unpublished","purposes":[],"recipients":[],"training_enabled":false}` |

库侧同期读数：`consent_policies` **0**、`consent_records` **0**、`privacy_epochs` **0**、`community_posts` **0**；两条写请求之后这四个数字仍是 0（被拒的请求没有落任何内容行）。

两条写请求都要带 `Idempotency-Key`（8..128 字符），缺了先得 400 `IDEMPOTENCY_KEY_REQUIRED`（`services/api/src/community/validate.ts:93-99`）；未登录则是 401——**鉴权先于授权**，403 只发给已认证的会话。

### 链路（读码核实）

| 步骤 | 位置 |
| --- | --- |
| `POST /me/consents` 注册与入参（`purpose` 闭集四用途、版本 1..80、`recipient_ids`≤30 且去重） | `services/api/src/routes/consents.ts:38-53` |
| 授予在单事务里：先锁账号与会话、核对 `auth_epoch` | `services/api/src/privacy/consent-pg.ts:66-89` |
| **政策解析**：`SELECT * FROM consent_policies WHERE purpose=$1 AND enabled AND reviewed_at<=clock_timestamp() AND valid_from<=clock_timestamp() AND valid_until>clock_timestamp()` | `services/api/src/privacy/grant-pg.ts:47-48` |
| **0 行 ⇒ 显式 403**（不是 500） | `services/api/src/privacy/grant-pg.ts:49` |
| 来源／证据／`content_sha256`／请求版本核验 | `services/api/src/privacy/grant-pg.ts:50-54` |
| 接收方绑定与 `recipients` 表双向一致（仅 `recipient_ids` 非空时） | `services/api/src/privacy/grant-pg.ts:59-70` |
| `POST /posts`：`preHandler` 先跑用途闸，handler 才落内容 | `services/api/src/routes/community.ts:212-222` |
| 闸的装配：有授权端口 ⇒ `[requireUser, consent({purpose:'public_posting'})]` | `services/api/src/routes/community.ts:417-422` |
| 授权闸**只在配了数据库时**装配；无 `DATABASE_URL` ⇒ 端口缺失 ⇒ 直通 | `services/api/src/app.ts:995-999` |
| 闸内部：单事务读 `privacy_epochs` + `consent_records` 并核对两者一致 | `services/api/src/privacy/consent-pg.ts:138-146` |
| 读不到该用途的授予 ⇒ `CONSENT_REQUIRED` | `packages/privacy/guard.mjs:112-117` |
| 该错误在事务出口按错误码映射成固定文案「当前身份或用途授权不满足要求」 | `services/api/src/privacy/consent-pg.ts:94-95` |
| 错误码 → HTTP 403（`CONSENT_REQUIRED` 属 403 闭集） | `services/api/src/contract.ts:17`、`services/api/src/errors.ts:78` |
| 读面无此闸：`GET /posts` 只挂 `requireUser` | `services/api/src/routes/community.ts:202-210` |
| 审核层在**handler 内部**、任何内容行落库之前才被问 | `services/api/src/community/service.ts:1013`、`services/api/src/community/moderation-link.ts:467` |

为什么 0 行政策是 403 而不是 500：`/me/consents` 是我们亲手 `throw` 的**语义化拒绝**（`services/api/src/privacy/grant-pg.ts:49`），`/posts` 是授权闸按错误码映射出的 403（`services/api/src/privacy/consent-pg.ts:94-95`）。真正的服务端故障另有其码：表缺失、权限不足一类走 `services/api/src/privacy/consent-pg.ts:97` 的 503 `PROVIDER_UNAVAILABLE`（**只读码判断，本页未构造该故障实测**）。

### 「怎么才算有政策」：判据与「仓内没有任何种子」

表定义（`0009`，无种子）：`services/api/db/migrations/0009_consent_policy.sql:4-23`。

- 列：`purpose`（闭集 `consent_purpose`）、`policy_version`（1..80）、`source_kind ∈ ('verified','synthetic')`、`source_ref`、`content_sha256`（`^[0-9a-f]{64}$`）、`review_evidence_ref`、`recipient_bindings`（jsonb 对象）、`valid_from`／`valid_until`、`reviewed_by`／`reviewed_at`、`enabled`。
- 表级约束：`valid_until > valid_from`；`reviewed_by` 与 `reviewed_at` 同空同非空；**`enabled` ⇒ `reviewed_at` 非空**；`UNIQUE(purpose,policy_version)`；每个用途至多一个 `enabled` 行：`services/api/db/migrations/0009_consent_policy.sql:19-24`。
- 已审内容**不可改、不可删**（`reviewed_at` 非空后只允许改 `enabled`／`updated_at`）：`services/api/db/migrations/0009_consent_policy.sql:25-40`。

「已核验」是**四层同时成立**，缺一层仍然 403：

1. 行存在、`enabled=true`、`reviewed_at<=now`、`valid_from<=now<valid_until`（已审且在有效期内）——`services/api/src/privacy/grant-pg.ts:47-48`；
2. `source_kind='verified'`（生产），或 `'synthetic'`（**只有测试显式注入 `allowSyntheticGrantPolicy` 才放行**，正常装配一律拒绝）——`services/api/src/privacy/grant-pg.ts:50-53`；
3. `source_ref` 与 `review_evidence_ref` 必须是 `https://` 且不带用户名口令（synthetic 用 `fixture://`），`content_sha256` 必须是 64 位小写十六进制——`services/api/src/privacy/grant-pg.ts:20-25`、`services/api/src/privacy/grant-pg.ts:50-53`；
4. 请求里的 `policy_version` 必须等于该生效行的版本（不等 ⇒ 409 `REVISION_CONFLICT`）；`recipient_ids` 非空时每个接收方都要在 `recipient_bindings` 与 `recipients` 表双向一致（含免训练／删除证据与留存上限）——`services/api/src/privacy/grant-pg.ts:54`、`services/api/src/privacy/grant-pg.ts:59-70`。

仓内**没有**插入政策行的东西：

- `0009` 文件头写明「No production policy or recipient seeds」；`services/api/db/migrations/**` 里除 `CREATE TABLE` 外没有任何政策 `INSERT`。
- `db/seeds/**` 全是资料／知识种子（`seed_reference.sql`、`seed_herbicides_verified.sql` 等），`grep -i consent db/seeds` **0 命中**。
- 全仓唯一写 `consent_policies` 的地方是测试里的 owner 级 `INSERT`（如 `tests/integration/consent-grant-pg.mjs:67`），且都是 `source_kind='synthetic'` 并依赖测试注入。
- API 侧**没有**政策的写面：`services/api/src/**` 对 `consent_policies` 只有 `SELECT`（`services/api/src/privacy/grant-pg.ts:47`、`services/api/src/privacy/privacy-policy.ts:91`）。
- 运行时角色也**没有**写权限：`consent_granter` 只拿到 `SELECT` 与 `UPDATE(updated_at)`，`INSERT` 只授给 `consent_records`／`privacy_epochs`——`services/api/db/roles/consent_granter.sql:15-19`。

所以在 `tools/local-dev` 那条现役路径上同样发不出帖：`api.mjs` 注入了真 `DATABASE_URL`（`tools/local-dev/api.mjs:12-14`），授权闸因此装配（`services/api/src/app.ts:995-999`），而它的库里同样没有政策行。

### 合法做法（两条），以及不要做什么

1. **由用户／管理员在受控环境导入真实政策行**：由拥有表写权限的发布／运维身份导入，管理员账号进 `reviewed_by`／`reviewed_at`，`source_ref`／`review_evidence_ref` 放真实 `https` 来源与审查证据，`content_sha256` 由真实条款正文算出，并给出明确有效期。这是数据运维动作，不属于任何 PR、脚本或本地工具；本页**不提供**「能直接粘贴出一行可用政策」的模板。
2. **如实承认本地无法演示发布**：0 行政策下的 403 是**正确的 fail-closed**，不是缺陷、不需要开关绕开。本地能演示的边界是「读面可用 + 写面被拒」（见上表）；要端到端演示发布，必须先有第 1 条的真实政策行（或由测试注入 synthetic 政策——那只属于组件级证据，不是本地演示）。

⛔ **不要**在本地库手插一条 `policy_version='v1'` 的假政策：

- 它把「已核验政策」这条隐私红线变成**可自助绕过**；
- 要让它生效必须 `enabled=true`，而表约束要求 `reviewed_at` 非空；一旦如此，这行就**永久不可改、不可删**（`services/api/db/migrations/0009_consent_policy.sql:19-40`），本地库从此带着一条伪造的「已审条款」；
- 测试注入（`allowSyntheticGrantPolicy`）是**测试装配参数**，不是产品开关，不能当本地绿通道。

### 与「审核」这一层的关系（含 `MODERATION_DEMO_PORT`）

- 授权闸是 `preHandler`（`services/api/src/routes/community.ts:212-222`），审核在 handler 内部（`services/api/src/community/service.ts:1013`、`services/api/src/community/moderation-link.ts:467`）。**闸拒 ⇒ 审核代码根本不会执行**，所以「演示审核端口」改变不了这一层的 403。
- 它解决的是另一格：**不配数据库**时授权闸不装配（`services/api/src/app.ts:995-999`），`POST /posts` 才会走到审核层、并因模型层未接线被拒——本机实测该组合是 **422 `INPUT_UNCERTAIN`**（`details[0].code=MODEL_NOT_EVALUATED`、`model_layer=not_wired`），不是 403。
- 截至本页写作（2026-10-29，基线 `719e4267`），`MODERATION_DEMO_PORT` 在本仓 **0 命中**（`git grep MODERATION_DEMO_PORT` 无结果，`services/api/src/moderation/` 下也没有 `demo-port.ts`），该键当前只在未合并分支上。即：在本页基线上把它设成 `pass` 也不会有任何装配效果；而即便它合并且真的装配了合成审核端口，**配了数据库 + 0 行政策**的本地库仍然是先被授权闸 403。这就是「本地发不出帖」与「审核演示」两件事不能互相替代的原因。

### 复现命令（本机实测，可重复）

```powershell
# 1) 起 stub API（PG 用本机 5544 上的 gengyun 库；连接串账号口令按你本机实际，本页不写口令）
$env:APP_EXECUTION_MODE='stub'; $env:API_PORT='3102'; $env:APP_KNOWLEDGE_UNVERIFIED_SEED='1'; $env:WECHAT_STUB_SUBJECT='qa-dev-1'
$env:DATABASE_URL='postgresql://<用户>:<口令>@127.0.0.1:5544/gengyun'
node services/api/src/server.ts

# 2) 合成身份登录：POST /api/v1/auth/wechat  {"code":"qa-dev-1"}，取返回的 access_token 作 Bearer
# 3) 两条写请求（都要带 8..128 字符的 Idempotency-Key）
#    POST /api/v1/me/consents  {"purpose":"public_posting","policy_version":"v1","recipient_ids":[]}
#    POST /api/v1/posts        {"title":"…","body":"…","media_ids":[]}
# 4) 读面：GET /api/v1/posts ／ GET /api/v1/me/consents ／ GET /api/v1/me/privacy-policy
```

注意事项（本机踩到／未覆盖的）：

- `Start-Process` 做重定向时，如果环境里同时存在 `HTTP_PROXY` 与 `http_proxy` 这类大小写重复键，会报 `Item has already been added`；当次进程内删掉小写那几个即可（与上文「已知不一致与缺陷」表同一条）。
- 登录会为合成身份新建 1 行 `users`（实测 12→13）；它是身份行，不是政策行，也不写 `consent_*`。
- 本页实测用的连接账号是该集群里唯一的 `postgres`（超级用户），**不是**主路径里的受限角色 `gengyun_local_runtime`。两条写请求的 403 发生在授权闸的错误码分支、与角色无关，但「受限角色下是否同样 403」本页未单独实测。
