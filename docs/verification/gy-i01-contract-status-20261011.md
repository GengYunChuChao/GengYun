# GY-I01 契约实现状态对照 · 可复现启动与本机门禁证据（2026-10-11）

关联：`Refs #1`（**不关闭 #1**）。基线 `upstream/main = 2d562d5b6fb79896ef8935716b90939538f274c2`，分支 `feat/gy-i01-contract-status`。

本文件记录**实际执行过的命令与真实输出**。跑通的写通过，没跑的写未执行并说明缺什么条件；失败与原始报错原样保留。**CI 结果不当作本机实测**——本轮提交前该分支尚无 CI 运行记录，PR 建好后由监工独立核对。

对照表本身见 [契约实现状态对照](../architecture/contract-implementation-status.md)；机器可读副本 [contract-status.json](../architecture/contract-status.json)。

## 0 环境

| 项 | 实测值 |
| --- | --- |
| 平台 | Windows x64 |
| Node | v24.16.0 |
| npm | 11.13.0 |
| Python | 3.14.3 |
| 工作区 | `E:\GengYunCommander\GengYun_W1`（git worktree） |
| 起点 `git rev-parse HEAD` | `2d562d5b6fb79896ef8935716b90939538f274c2` |

依赖：本轮**未执行 `npm ci`**。理由是工作区在派发时已由指挥完成 `npm ci`（103 包）且 `node_modules` 存在（一级目录 82 个），重装不会产生新的判断信息，只增加网络依赖；因此下方门禁全部跑在既有 `node_modules` 上，`package-lock.json` 在本轮未被改动。若监工要求，可另跑一次干净安装对比。

## 1 stub API 真跑起来 + 真实请求/响应

命令（后台作业，`node --watch`，日志原文）：

```powershell
$env:APP_EXECUTION_MODE='stub'; $env:API_PORT='3117'; $env:LOG_LEVEL='info'; npm run dev:api
```

真实输出（节选启动段）：

```text
{"level":30,"time":1791717460290,"pid":50832,"hostname":"...","msg":"Server listening at http://127.0.0.1:3117"}
{"level":30,"time":1791717460336,"pid":50832,"hostname":"...","execution_mode":"stub","database_configured":false,"msg":"gengyun api 已启动（已装配认证与后台认证路由；其余业务路由未实现）"}
```

监听地址：`http://127.0.0.1:3117`。以下请求用 `curl.exe 8.21.0`（`-D` 取响应头、`-o` 取响应体、`-w '%{http_code}'` 取状态码）实际发出并记录。会话令牌与 `access_token` 值在记录时已替换为 `<REDACTED>`/`<TOKEN-n>`，请求体走临时文件（不使用 shell 引号拼接）。

### 1.1 成功路径

| 编号 | 请求 | 状态 | 关键响应 |
| --- | --- | --- | --- |
| 1 | GET /health | 200 | `{"status":"ok","checks":{"api":{"status":"ok"},"database":{"configured":false,"status":"not_configured"}},"meta":{"request_id":"817dd660-...","contract_version":"1.0.0","execution_mode":"stub"},"uptime_s":123}` |
| 3 | POST /api/v1/auth/wechat，`Idempotency-Key: demo-key-0001`，body `{"code":"demo-code-1"}` | 200 | 响应头 `cache-control: no-store`、`etag: "1"`；响应体 `{"data":{"access_token":"<REDACTED>","token_type":"Bearer","expires_at":"2026-10-18T11:17:57.608Z","audience":"user","revision":1},"meta":{...}}` |
| 4 | GET /api/v1/auth/session，`Authorization: Bearer <TOKEN-1>` | 200 | `{"data":{"audience":"user","expires_at":"2026-10-18T11:17:57.608Z","scopes":["user"],"revision":1},"meta":{...}}`，响应头 `etag: "1"` |
| 5 | 同 3 的同键同体重放 | 200 | 换发新令牌（`<TOKEN-2>`），`expires_at` 与首次一致（绝对时效以首次为准） |
| 7 | GET /api/v1/auth/session，`<TOKEN-2>` | 200 | 同上 |
| 16 | POST /api/v1/auth/logout，`<TOKEN-2>`，`Idempotency-Key: demo-key-out1` | 200 | `{"data":{"accepted":true},"meta":{...}}` |

### 1.2 受控拒绝路径（一并作为契约行为证据）

| 编号 | 请求 | 状态 | 原始响应体 |
| --- | --- | --- | --- |
| 6 | GET /api/v1/auth/session，旧 `<TOKEN-1>`（重放已换发） | 401 | `{"error":{"code":"SESSION_EXPIRED","message":"用户会话已过期或已失效","retryable":false,"details":[]},"meta":{...}}` |
| 8 | POST /api/v1/auth/wechat 同键异体 `{"code":"demo-code-2"}` | 409 | `{"error":{"code":"IDEMPOTENCY_CONFLICT","message":"同一 Idempotency-Key 已被不同请求体使用","retryable":false,"details":[]},"meta":{...}}` |
| 9 | POST /api/v1/auth/wechat 缺 `Idempotency-Key` | 400 | `{"error":{"code":"IDEMPOTENCY_KEY_REQUIRED","message":"缺少或非法的 Idempotency-Key 头（8..128 字符）","retryable":false,"details":[]},"meta":{...}}` |
| 10 | POST /api/v1/auth/wechat 夹带 `openid` | 400 | `{"error":{"code":"INVALID_REQUEST","message":"请求校验失败","retryable":false,"details":[{"field":"/","code":"must NOT have additional properties"}]},"meta":{...}}` |
| 14 | GET /api/v1/knowledge 无会话 | 401 | `{"error":{"code":"SESSION_REQUIRED","message":"需要用户会话","retryable":false,"details":[]},"meta":{...}}` |
| 17 | GET /api/v1/auth/session（退出后） | 401 | `{"error":{"code":"SESSION_EXPIRED",...}}` |
| 15 | GET /api/v1/jobs/{id} | 404 | `{"error":{"code":"NOT_FOUND","message":"未实现的路径：GET /api/v1/jobs/00000000-0000-0000-0000-000000000000","retryable":false,"details":[]},"meta":{...}}` |

### 1.3 stub 下需要数据库的端点如实拒绝（不是成功）

| 编号 | 请求 | 状态 | 原始响应体 |
| --- | --- | --- | --- |
| 2 | GET /api/v1/public/home | 503 | `{"error":{"code":"PROVIDER_UNAVAILABLE","message":"主页资料数据库尚未接入","retryable":false,"details":[]},"meta":{...}}`；响应头 `cache-control: no-store` |
| 11 | GET /api/v1/me/profile | 503 | `{"error":{"code":"PROVIDER_UNAVAILABLE","message":"档案数据库尚未配置","retryable":false,"details":[]},"meta":{...}}` |
| 12 | GET /api/v1/catalog/crops | 503 | `{"error":{"code":"PROVIDER_UNAVAILABLE","message":"档案数据库尚未配置",...}}` |
| 13 | GET /api/v1/me/consents | 503 | `{"error":{"code":"PROVIDER_UNAVAILABLE","message":"授权数据库未配置",...}}` |

这三条 503 是本对照表把 `getPublicHome` 记 `partial`、把 `/me/*` 与 `/catalog/*` 的**运行条件**写成「需 `DATABASE_URL`」的直接依据：它们**没有**返回数据，也没有用静态种子顶替。本机没有独立 PostgreSQL 17 服务器，因此这些端点的成功响应**本轮未取得**；它们在 `npm run test:unit` 中由内存 PostgreSQL 引擎（PGlite 0.5.8）承载的用例覆盖（见 §5）。

### 1.4 real 模式缺凭据时不半配置启动

```powershell
$env:APP_EXECUTION_MODE='real'; node services/api/src/server.ts
```

真实输出（stderr，exit code 1，原文保留）：

```text
启动失败：配置校验未通过。
  - DATABASE_URL [MISSING] 真实模式（APP_EXECUTION_MODE=real）必须提供该服务端配置
  - SESSION_SIGNING_KEY [MISSING] 真实模式（APP_EXECUTION_MODE=real）必须提供该服务端配置
  - DELETION_LEDGER_KEY [MISSING] 真实模式（APP_EXECUTION_MODE=real）必须提供该服务端配置
  - WECHAT_APP_ID [MISSING] 真实模式（APP_EXECUTION_MODE=real）必须提供该服务端配置
  - WECHAT_APP_SECRET [MISSING] 真实模式（APP_EXECUTION_MODE=real）必须提供该服务端配置
  - OBJECT_STORAGE_ENDPOINT [MISSING] 真实模式（APP_EXECUTION_MODE=real）必须提供该服务端配置
  - OBJECT_STORAGE_BUCKET [MISSING] 真实模式（APP_EXECUTION_MODE=real）必须提供该服务端配置
  - OBJECT_STORAGE_ACCESS_KEY [MISSING] 真实模式（APP_EXECUTION_MODE=real）必须提供该服务端配置
  - OBJECT_STORAGE_SECRET_KEY [MISSING] 真实模式（APP_EXECUTION_MODE=real）必须提供该服务端配置
参考 .env.example；真实密钥只放在服务端安全配置，不提交仓库。
```

（PowerShell 会把 stderr 包成 `NativeCommandError` 显示，退出码为 1；上表已按原文本摘出。）返回 `[exit code: 1]`。

## 2 后台（apps/admin）构建与启动

```powershell
npm run build
```

真实输出（exit 0）：

```text
> gengyun@0.0.0 build
> npm run build --workspace @gengyun/api && npm run build --workspace @gengyun/admin

> @gengyun/api@0.0.0 build
> tsc -p tsconfig.json

> @gengyun/admin@0.0.0 build
> vite build

vite v7.3.6 building client environment for production...
transforming...
✓ 12 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                  0.43 kB │ gzip:  0.33 kB
dist/assets/index-6zDqB1ll.css   0.37 kB │ gzip:  0.28 kB
dist/assets/index-X2oq-tG-.js   63.52 kB │ gzip: 25.61 kB
✓ built in 565ms
```

```powershell
npm run dev:admin
```

真实输出：

```text
  VITE v7.3.6  ready in 594 ms

  ➜  Local:   http://127.0.0.1:5173/
```

实际请求 `curl.exe -s -o body -w "%{http_code} %{size_download} %{content_type}" http://127.0.0.1:5173/`：

```text
HTTP 200  bytes=391  content_type=text/html
```

响应体确认是 Vite 开发入口（`<title>耕云 · 独立后台（骨架）</title>`、`<script type="module" src="/src/main.ts">`）。

**边界**：后台只有鉴权入口占位、无业务页，`apps/admin/src` 下只有 `App.vue`、`main.ts`、`env.d.ts`、`auth/session.ts` 四个文件。构建与启动成功只证明工程壳可运行，**不代表任何后台业务功能完成**，也不代表 `dev:admin` 之外的部署形态可用。

## 3 小程序侧

```powershell
node tools/check-wechat-project.mjs
```

真实输出（exit 0）：

```text
PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.
```

```powershell
npm run test:mini
```

真实输出（exit 0，4/4 通过）：

```text
> gengyun@0.0.0 test:mini
> node tools/check-wechat-project.mjs && node --test tests/local-debug.test.mjs

PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.
✔ missing, public, wildcard, credential and mismatched configs fail (17.5279ms)
✔ actual HTTP service is synthetic, no-store and has no business routes (47.8872ms)
✔ client blocks trial/release/unknown environments and labels stub or failure (2.5719ms)
✔ isolated packaging excludes private files and rejects release overrides/stale output (1929.6237ms)
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

**边界（如实写）**：`check-wechat-project.mjs` 自己就声明了它**不是**微信编译器或真机测试。本机没有微信开发者工具号、没有真机，因此小程序**未在开发者工具中编译、未真机运行、未联网校验合法域名**。这两条命令只证明原生工程配置一致与页面脚本语法可解析。

## 4 仓库门禁（逐条，不合并）

| 门禁 | 命令行 | 结果 | 关键输出 |
| --- | --- | --- | --- |
| 文档台账 | `npm run test:docs` | **通过**（exit 0） | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| 契约一致性 | `npm run test:contract` | **通过**（exit 0） | `ℹ tests 6 / pass 6 / fail 0`，六个用例全绿，例如 `✔ API 错误码集合与 openapi ErrorCode 枚举一致 (0.2181ms)` |
| 静态检查 | `npm run lint` | **通过**（exit 0） | `PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、`PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）`、`lint 通过（静态检查；不代表运行期或真实服务已通过）。` |
| 单元与领域回归 | `npm run test:unit` | **通过**（exit 0） | `ℹ tests 683 / pass 682 / fail 0 / skipped 1 / duration_ms 16541.7952` |

`test:unit` 里那 1 条 skip 的原始行：

```text
﹣ native separate-connection withdrawal and account state changes at guarded read boundary (0.1692ms) # SKIP
```

这是用例自身针对「独立连接下的撤回/账号状态」设的跳过分支（需要额外的独立连接前置），不是失败，也不代表该场景通过。

**未执行的门禁**：本轮没有跑 `npm run test:reference`、`npm run test:evaluation` 等未列入派单 §3.2 的脚本；它们不在本对照表需要的证据范围内，因此不写「通过」。

**CI**：本分支在提交前**没有** CI 运行记录，PR 建好后由监工核对。`action_required`、`queued` 或未运行的检查一律**不算通过**。

## 5 对照表自身的可回归校验

```powershell
node tools/verify-contract-status.mjs
```

真实输出（exit 0）：

```text
PASS: 对照表覆盖 112 条契约操作（112 条一致）；已装配路由 16 条与源码扫描一致；implemented 12 / partial 4 / planned 96；横切维度 8 条（implemented 2 / partial 5 / planned 1）
PASS: 状态为人工判定；本脚本只校验覆盖性、装配一致性与证据可复核，不证明实现的语义正确。
```

**三条负例**（证明它不是恒过的空检查；每次改完都用备份还原，实测后 `git status` 仅剩两个新增未跟踪文件）：

| 负例 | 构造方式 | 实测结果 |
| --- | --- | --- |
| A | 把未装配的 `cancelJob` 改成 `route_mounted=true` | exit 1：`ERROR: post /jobs/{id}/cancel: 对照表声明 route_mounted=true，源码扫描结果=false` |
| B | 把 `loginWechat` 的证据用例名改成不存在的字符串 | exit 1：`ERROR: loginWechat: tests/unit/auth-routes.test.mjs 中找不到用例名「不存在的用例名XYZ」` |
| C | 临时注释掉 `app.ts` 里的 `registerKnowledgeRoutes(...)`（随后 `git checkout -- services/api/src/app.ts` 还原） | exit 1：`ERROR: get /knowledge: 对照表声明 route_mounted=true，源码扫描结果=false`、`ERROR: get /knowledge/{id}: ...` |

负例 C 是「契约里有定义 ≠ 已实现」的机器化：只要 `app.ts` 不再装配某个 `register*`，对应操作就会立刻被判为未挂载而校验失败。

**这个脚本没有接进 CI 或 `npm run test:*`**：本轮约束是「只碰 `docs/` 与校验脚本」，改根 `package.json` 超出范围，因此只提供命令与文档，是否纳管由监工决定。脚本本身用正则扫 TypeScript 路由声明，只覆盖「已装配/未装配」与「证据存在性」，不判断语义正确。

## 6 未取得项与阻塞（不得写成已取得）

| 项 | 状态 | 为什么 |
| --- | --- | --- |
| 独立 PostgreSQL 17 服务器 | **未取得** | 本机没有可用实例；相关用例跑在 PGlite 0.5.8（内存 PostgreSQL 引擎）上。`/knowledge`、`/me/profile`、`/catalog/*`、`/me/consents` 的**真实库成功响应本轮未取得** |
| `consent_policies` / `recipients` 已核验数据 | **未取得** | 迁移 0009 不提供管理 API 或生产种子（[gy-i27 记录](gy-i27-consent-grant-pg.md):9）；`POST /me/consents` 在本机无该前置数据，只能得到 403 `CONSENT_REQUIRED`（如实拒绝）。该接口的 PostgreSQL 集成用例需 `CONSENT_GRANT_TEST_URL`，本轮**未执行** |
| 正式 AppID / AppSecret 下的真实微信登录 | **未取得** | 本机实测走的是 stub 合成身份；`real` 分支的 `sns/jscode2session` 调用本轮未发生 |
| 微信开发者工具编译 / 真机 / 双平台 | **未取得** | `check-wechat-project.mjs` 自身声明不是编译器或真机测试；本机无工具号与真机 |
| AI 供应商联网与额度 | **未取得** | 属 GY-I25；本轮与对照表不触发任何外发 |
| 对象存储 | **未取得** | 属 GY-I25；媒体路由本身也未装配（**半句已校订，见本表下方第 2 条**） |
| 部署 | **未取得** | 本轮只在本机 loopback 上验证 |
| CI | **未运行** | 提交前该分支无 CI 记录；不把 `action_required` 当通过 |

**本表后续校订（2026-10-16 实测；测量基线 `3bc7451`；只订正被证伪的半句，⛔ 其余行与"未取得"结论一字未动）：**

1. "对象存储"行括注的**「媒体路由本身也未装配」已过期**。实测 `services/api/src/app.ts:1354` `registerMediaRoutes(app, config, guards, mediaService);`，
   媒体域 **7** 条路由全部已注册（`services/api/src/routes/media.ts:158/176/200/218/238/258/277`）。
   （行号绑基线 `3bc7451`；对照读数：测量时 `upstream/main` = `1480aab3383b16daf7a5b5088c3e21cc12c422d3`，同一调用在 `services/api/src/app.ts:1374`。）
2. **该行的"未取得"结论仍成立，且理由更精确**：未取得的是**真实对象存储适配器**。装配点 `resolveMediaObjectStore`
   （`services/api/src/media/object-store.ts:447`）在 `real` 模式下于此返回未接线端口——同文件 `:450`：`if (config === null) return createUnwiredObjectStore();`；
   被调函数 `createUnwiredObjectStore`（同文件 `:143`）的默认理由常量 `UNWIRED_OBJECT_STORE_REASON`（同文件 `:136-137`）为
   「真实对象存储（S3/COS 兼容）尚未接线：媒体域不可用，拒绝以内存/替身存储返回成功封套」⇒ 每次对象操作 503 `PROVIDER_UNAVAILABLE`（fail-closed），
   **不是** HTTP 路由未装配。两者在本文档写作时被并成一句，现拆开登记。

## 7 本轮改动范围自查

- 只新增文档与校验脚本：`docs/architecture/README.md`、`docs/architecture/contract-implementation-status.md`、`docs/architecture/contract-status.json`、`docs/verification/gy-i01-contract-status-20261011.md`、`tools/verify-contract-status.mjs`，以及在 `docs/development-guide.md` 增加一处索引链接。
- 未改 `services/api/**`、`apps/admin/**`、`miniprogram/**` 的任何内容。为负例 C 曾临时注释 `services/api/src/app.ts` 一行，**已用 `git checkout -- services/api/src/app.ts` 还原**，提交前 `git status` 逐条确认该文件不在变更集中。
- 未删除、未注释任何既有测试；未改弱任何断言。
- 仓库内没有令牌、`.env`、AppSecret 或真实 openid；上文出现的会话令牌均已脱敏。
- 未改全局 git 配置，未 force-push，未合并任何 PR。
