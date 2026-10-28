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
| `smoke.mjs` 在干净环境必然失败 | 它断言 `/api/v1/knowledge` 默认返回空列表，而 `api.mjs` 硬设 `APP_KNOWLEDGE_UNVERIFIED_SEED=1` 会放行未核对条目，于是断言失败。两者同批产物却对不上；冒烟前先知道这条，不要据此判断环境坏了。`/knowledge` 在本地为空的成因与判别见文末「本地 `/knowledge` 为空的三条成因与判别」 |
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

## 本地 `/knowledge` 为空的三条成因与判别

`GET /api/v1/knowledge` 在本地「恒返回空」是**读面准入**的结果，不是没导数据，也不是 `card_ready` 没开：本机库里 `knowledge_versions` 有 **159 行**，而读视图 `catalog_read.current_knowledge` 是 **0 行**，差值全部来自准入闸。下面三层按「先查哪一层」排序。

### 第一层：`card_ready` 不在这条链上

| 事实 | 证据 |
| --- | --- |
| `/knowledge` 的唯一取数点是 `catalog_read.current_knowledge`；该视图**不 JOIN `applicability`**，整条链路没有一处读 `card_ready` | `services/api/db/migrations/0012_knowledge_created_at.sql:87-117`、`services/api/src/knowledge/service.ts:76` |
| `card_ready` 只影响用量卡视图 `v_knowledge_applicability`，而该视图在 `services/api/src` 里**零消费者**（全目录 grep 0 处引用） | `services/api/db/migrations/0002_knowledge_catalog.sql:227-231` |
| `/knowledge` 的 `dose_cards` 恒 `[]`、`conditions` 恒 `null` 是投影层写死的，与数据、与 `card_ready` 都无关 | `services/api/src/knowledge/service.ts:98-106` |
| 现库 22 行 `applicability` 里**0 行**满足 `card_ready=true` 的 CHECK（9 个字段全非空才允许），直接 `UPDATE … SET card_ready=true` 会 23514 报错 | `services/api/db/migrations/0002_knowledge_catalog.sql:85-98`；本机实测 `applicability` 22 行、满足该 CHECK 0 行 |

⇒ **开 `card_ready` 不是解法**：它不会让列表多出一行；在现库上连开都开不动（`v_knowledge_applicability` 也没有任何 HTTP 消费点，行数变化不影响 `/knowledge`）。

### 第二层：真因是 9 道准入闸里有 5 道不过

`/knowledge` 的数据库侧要穿过 `catalog_read.current_verified_sources`（`services/api/db/migrations/0005_catalog_read_views.sql:6-21`）再穿`current_knowledge` 自己的条件（`services/api/db/migrations/0012_knowledge_created_at.sql:87-117`）。把两道视图的条件合起来是 9 道闸，本机 159 行数据逐条过后是「5 道不过」：

| # | 闸 | 判据位置 | 本机实测（分母 159 行） |
| --- | --- | --- | --- |
| 1 | 知识行已发布 | `0012` 的 `k.visibility='published'` | **0 / 159**（全 `private`）✗ |
| 2 | 来源版本已核对 | `0005` 的 `sv.review_status='verified'` | **0 / 159**（全 `unverified`）✗ |
| 3 | 核对人与核对时间非空 | `0005` 的 `sv.reviewed_by IS NOT NULL`、`sv.reviewed_at IS NOT NULL` | **0 / 159**（两边全 NULL）✗ |
| 4 | 来源 URL 是 https | `0012` 的 `s.canonical_url ~ '^https://…'` | **0 / 159**（这 159 行挂的 2 个来源全是 `repo-external://…`；库内另有 3 个 https 来源，但没有知识行挂它们）✗ |
| 5 | 数据集配置闸 | `0005` 的 `mode='real'` + `active_mode='real'` + `database_connected='true'` | `active_mode=stub`、`database_connected=false` ✗ |
| 6 | 来源版本有效 | `0005` 的 `sv.validity='valid'` | 159 / 159 ✓ |
| 7 | 来源当前版本 | `0005` 的 `s.current_version_id = sv.id` | 159 / 159 ✓ |
| 8 | 形状闸（标题/正文/发布者长度、`sv.version` 1..80、`isfinite(retrieved_at)`、三个 id 是 jsonb 数组） | `0012` 的长度与 jsonb 条件 | 159 / 159 ✓ |
| 9 | 有效期窗 | `0005` 的 `valid_from <= now()`、`valid_to` 空或未过期 | 159 / 159 ✓ |

所以「数据在库里、列表却是空」是这 5 道闸的必然结果，**不是导入失败**，也不是有人在某处 `WHERE 1=0`。第 5 道是配置而不是数据：本地 API 恒定 `stub` 执行模式（`tools/local-dev/api.mjs` 显式注入 `APP_EXECUTION_MODE=stub`），`knowledge_dataset_config` 的 `active_mode` 就停在 `stub`，`database_connected` 停在 `false`。

### 第三层：本地有一套既有的「非 real 演示数据」开关

仓内已有把浙江首批资料接进 `/knowledge` 读面的**既有接线**（`v_queryable_seed_version` 的既有口径：无真实库时的有来源种子联调，消费方必须逐条标注未核对）：

| 环节 | 位置 | 行为 |
| --- | --- | --- |
| 开关读取 | `services/api/src/routes/knowledge.ts:171` | `APP_KNOWLEDGE_UNVERIFIED_SEED` 取 `1`/`true` 才为真 |
| 模式硬闸 | `services/api/src/routes/knowledge.ts:175`、`services/api/src/app.ts:1872-1873` | `executionMode !== 'real'` 才生效；`real` 模式装配层硬拒，开关设了也没用 |
| 投影面 | `services/api/src/knowledge/reference-query.ts:138-141` | 开关关闭时 `seedRows()` 恒返回 `[]`，不会静默放行 |
| 并入读面 | `services/api/src/knowledge/service.ts:81-84` | 种子行与数据库投影行按 `id` 去重后并进**同一份快照**，再走同一套过滤/分页/投影 |
| 本地 harness | `tools/local-dev/api.mjs:6` | `tools/local-dev/api.mjs` 启动器**硬设**该开关为 `1` |

这是**既有的非 real 演示数据开关**，不是「即将支持」，也不是临时绕过：默认关闭，打开必须是一次可审查的接线决定，且在 `real` 模式下一律失效。

### 判别步骤（按顺序，别跳）

1. **先看开关有没有设**。没设时，数据库侧本来就该是 0 条：

   ```powershell
   echo $env:APP_KNOWLEDGE_UNVERIFIED_SEED   # 需要 1 或 true；空/0 就解释了空列表
   ```

   同时确认执行模式非 `real`（`real` 下开关无效，见上表）。
2. **再看连的是哪个库**。`tools/local-dev/api.mjs:12` 连的是 `gengyun_local_dev`（裸迁移 + 合成夹具，**不含任何 seed 知识记录**），不是你手工灌过 seed 的 `gengyun`。用你实际连上的库查一次分母：

   ```sql
   SELECT count(*) FROM knowledge_versions;   -- 0 ⇒ 库不对或没灌 seed
   ```
3. **再逐条数那 5 道闸**（一条 SQL 全出，分母就是上一句的计数）：

   ```sql
   SELECT count(*) AS rows,
          count(*) FILTER (WHERE k.visibility = 'published')     AS g_published,
          count(*) FILTER (WHERE sv.review_status = 'verified')  AS g_verified,
          count(*) FILTER (WHERE sv.reviewed_by IS NOT NULL
                             AND sv.reviewed_at IS NOT NULL)     AS g_reviewed,
          count(*) FILTER (WHERE s.canonical_url ~ '^https://')  AS g_https
   FROM knowledge_versions k
   JOIN source_versions sv ON sv.id = k.source_version_id
   JOIN sources s ON s.id = sv.source_id;

   SELECT key, value, mode FROM knowledge_dataset_config ORDER BY key;  -- 配置闸
   ```
4. **再看视图自己**（`/knowledge` 的数据库侧唯一来源）：

   ```sql
   SELECT count(*) FROM catalog_read.current_knowledge;
   ```
5. **最后才怀疑数据**。本机 159 行的分布是 119 species / 35 herbicide / 5 scheme；三个数都缺才是数据问题，只有一两个缺也是准入问题，不是导入问题。

另：未带令牌访问 `/api/v1/knowledge` 一律 401，**401 和「空列表」是两件事**，先排除鉴权再看上面五步。

### 设开关后应当看到什么

`APP_KNOWLEDGE_UNVERIFIED_SEED=1` + 非 `real` 模式下，`/knowledge` 立刻是 **159 条：119 species + 35 herbicide + 5 scheme**，来自 `packages/knowledge/zhejiang/materials-zhejiang-v1.json` 的投影。这 159 条**逐行**是：

- `source.review_status = 'unverified'`（如实呈现，不会被统一改写成 `verified`）；
- `dose_cards = []`、`conditions = null`（投影层写死，见 `services/api/src/knowledge/service.ts:98-106`）；
- 库内 `knowledge_versions` 的 159 行分布与种子投影一致（119 / 35 / 5），两个取数口报的是同一批素材。

**这 159 条「逐行标未核对、无剂量卡片」是正确行为**，不是缺陷：未核对内容可以出现在演示查询面，但不得冒充已核对，也不得带出用量卡（用量卡的合格来源、制剂、条件、原文缺项，见上表「模拟／种子能展示但无法产用量卡」一行）。

读数来源：本机实测 `catalog_read.current_knowledge` = 0 行、`catalog_read.current_verified_sources` = 0 行、`v_active_source_version` = 0 行、`v_knowledge_applicability` = 0 行、`knowledge_versions` = 159 行、`applicability` = 22 行；种子面用 `createReferenceQueryService({includeUnverifiedSeed: true}).seedRows()` 实跑得 159 行（119 / 35 / 5、`review_status` 全 `unverified`）。两者相加即读面 159 条——本页未起完整 HTTP 链路，故不把这一条写成端到端验收。
