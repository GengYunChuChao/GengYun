# 配置参考

依据 `services/api/src/config.ts`、`.env.example`、后台会话代码及数据库 CLI；2026-10-10。
API 只读进程环境。下面列变量名、默认值和条件，不列真实值。

| 变量 | 条件／默认 | 当前用途或限制 |
| --- | --- | --- |
| APP_EXECUTION_MODE | 必填 real／stub／preset_demo | 缺失或非法启动失败 |
| API_HOST | 127.0.0.1 | 默认不开放公网监听 |
| API_PORT | 3000；1–65535 | API 监听 |
| LOG_LEVEL | info | fatal／error／warn／info／debug／trace／silent |
| DATABASE_URL | real 必填 | postgres:// 或 postgresql://；迁移另要求注入 |
| DATABASE_HEALTH_TIMEOUT_MS | 2000；100–60000 | 健康检查超时 |
| SESSION_SIGNING_KEY | real 必填 | 微信身份与幂等 HMAC；模板建议至少 32 字符，当前 loader 仅检查非空 |
| DELETION_LEDGER_KEY | real 必填 | 当前启动检查；配置存在不证明独立删除账本已接线 |
| WECHAT_APP_ID | real 必填 | AppID 公开标识；服务端身份交换使用 |
| WECHAT_APP_SECRET | real 必填、秘密 | 不进客户端 |
| WECHAT_STUB_SUBJECT | 可选；仅非 real（stub／preset_demo）且有值 | 合成模式的**固定测试身份**：subject 由该固定串派生 ⇒ **该服务端进程的所有 stub 客户端共用一个账号**（便于证「退出→重登→数据仍在」）。⛔ **不要**在多人共用的 stub 服务上开这个开关：所有人共用一个账号、彼此看得到对方的数据。未设/空白 ⇒ 与今天逐字一致（按 code 派生，一次登录一个用户）；**real 模式下完全不生效**（设了也是 `null`，不报错）；值只能来自服务端环境，请求体/查询/header 无法影响；最长 128 字符、不含控制字符（否则启动报 `INVALID_VALUE`）。生效与否看启动日志的 `wechat_stub_subject_fixed`（只含空白时另标 `wechat_stub_subject_ignored`；两者都只打布尔，不打值） |
| MODERATION_DEMO_PORT | 可选；默认关闭；只接受 `pass`（`1`／`true`／`on` 等一律视为关闭）；**仅非 real 生效** | **审核域演示端口**：设成 `pass` 时装配层注入一条**合成**审核端口（`provider.synthetic === true`、结论恒 `pass`）。网络面**不夸大**：`fetchImpl` 一旦被调用就抛错，其余 3 个 seam（`credentials`／`liveGate`／`now`）是**惰性占位**；「零外呼」的判据是代码面实测（`services/api/src/moderation/demo-port.ts` 与 `packages/moderation/*.mjs` 里 `https?://`／`fetch(`／`node:http`／`axios`／`undici` 命中 **0 条**），**不是**靠那个抛错。效果：演示/替身环境下 `POST /posts` 从 422 `INPUT_UNCERTAIN`（内容行 0）变成 **201**（`published` + `approved`、内容行恰好 1）；审核台账与 `GET /jobs/{id}`（`kind=moderation`）的 `model_version` 带 `synthetic-demo-` 前缀、`evidence.provider.synthetic=true` ⇒ 复核者可分辨。不设/留空 ⇒ 与接线前**逐字一致**（422、内容行 0）。⛔ **规则层照旧独立拦截**：本端口只替代「模型层结论」，硬规则命中的内容仍 400 + 内容行 0（它不是「全放行」）。⛔ **real 模式下设了也不启用**（启动日志 `moderation_demo_port: refused`，审核域仍整域 fail-closed 503）；非 real 启用时启动日志写 `moderation_demo_port: synthetic`。⛔ 该端口是**合成的**，不是真实审核，不得被引用为审核能力／召回率／误隔离率证据；图片端口 `ims` 仍是替身（带媒体投稿照旧隔离／待审） |
| OBJECT_STORAGE_ENDPOINT | real 必填 | 仅**启动校验**。四项**不是**媒体域门控：装配点（`app.ts`）**不读也不传** ambient `process.env`，`resolveMediaObjectStore` 的 `env` 形参只供显式装配／测试使用；因此 real 下四项齐备时默认装配仍整域 fail-closed 503（`unwired`），真实适配器只允许经**显式注入** `BuildAppOptions.mediaObjectStore` 装配；真实桶往返仍**未验证** |
| OBJECT_STORAGE_BUCKET | real 必填 | 同上 |
| OBJECT_STORAGE_ACCESS_KEY | real 必填、秘密 | 同上 |
| OBJECT_STORAGE_SECRET_KEY | real 必填、秘密 | 同上 |
| MEDIA_OBJECT_REF_KEY | 非启动必填；`real` 且配了 `DATABASE_URL` 时**事实必填**（键材质：64 位十六进制／32 字节 base64／32 字节原串，秘密） | **媒体域**：`media.object_ref_cipher` 是 `NOT NULL` 密文列，存的是「这条媒体在对象存储里的对象键」经 AES-256-GCM 加密后的信封（明文对象键只在服务进程内出现）。缺键 ⇒ 装配层**不接 PG 存储**并整域 fail-closed：**503 `PROVIDER_UNAVAILABLE`（`retryable:false`）**，7 条媒体路由与语音受理（此时 **409 `OBJECT_UNAVAILABLE`**）一起不可用，绝不退回进程内 `Map` 去假装持久化；键材质非法 ⇒ 启动 `ConfigError`（`INVALID_VALUE`）。判据 `services/api/src/config.ts:509-525`，装配 `services/api/src/app.ts:1784-1804` |
| MEDIA_ACCESS_GRANT_ORIGIN | 可选；只接受 `https://<host>[:port]`（不带路径／查询／URL 内凭据） | **媒体域（取图句柄）**：`AccessGrant.url` 的 host 来自这里（`<origin>/api/v1/media/{id}/content`）。未配置 ⇒ 句柄指向不可解析的占位域 `https://media.placeholder.invalid`（本仓不提供该数据面）；带 `--approve-real-media-wiring` 启动时缺它 ⇒ **进程拒绝启动**（exit 1，`access_grant_origin_not_deployable`）；格式非法 ⇒ 启动 `ConfigError`（`INVALID_VALUE`）。判据 `services/api/src/config.ts:451-465`，启动期校验 `services/api/src/media/real-ports.ts:260-278` |
| RECOGNITION_PROVIDER_URL / RECOGNITION_PROVIDER_KEY | 可选；**real** 下两行成对；**不在 `config.ts` 校验**（装配处直读 `process.env`） | **识别域**：`real` 下缺任一 ⇒ 受理 `POST /api/v1/recognitions` 之前即 **503 `PROVIDER_UNAVAILABLE`（`retryable:false`）**，不回退替身；两者齐备（且端点通过 https／无查询串／无内嵌凭据等构造期断言）⇒ 装配**协议级**真实适配器（GY-R70：`services/api/src/recognitions/live-adapter.ts:153`），字节只从去元数据衍生件来（`services/api/src/recognitions/image-source.ts:158`）；**本仓仍没有已审识别供应商**，因此配齐只代表「可以受理并发包」，不代表任何一次真实调用成功或识别准确率。装配失败/配置不合法 ⇒ 回落 fail-closed（`available:false`，原因点名「装配失败」），⛔ 绝不回退替身。读取点 `services/api/src/app.ts:1116-1122`，拒绝 `services/api/src/recognitions/service.ts:397-400`，fail-closed 的 `recognize()` 仍返回 `PROVIDER_UNAVAILABLE`（`services/api/src/recognitions/provider.ts:171-174`） |
| CHAT_LLM_ENDPOINT / CHAT_LLM_MODEL / CHAT_LLM_API_KEY（或 `DEEPSEEK_API_KEY`） | 可选；三项**要么全配、要么全空**（端点须 `https://`、模型名 1..80、密钥 8..200） | **问答域**：三项全空 ⇒ 回答照常 200，但 `model_version`／`prompt_version` 带 `unimplemented:no-real-` 前缀（确定性摘录，不是真实模型，`services/api/src/conversations/service.ts:86-91`）；只配一半或值非法 ⇒ 启动 `ConfigError` 并列出字段名（进程 exit 1），**不**静默退回确定性回答器；三项齐备后仍要 `APP_EXECUTION_MODE=real` **且**外发账本可用（`DATABASE_URL`），否则继续走确定性回答器并记一条 warn（`services/api/src/ai/chat-wiring.ts:52-97`）。判据 `services/api/src/config.ts:275-367` |
| DEEPSEEK_API_KEY | 可选；`CHAT_LLM_API_KEY` 的同义替代 | 二选一；两者都给时以 `CHAT_LLM_API_KEY` 为准（`services/api/src/config.ts:253-262`） |
| CHAT_LLM_TIMEOUT_MS | 可选，默认 20000；1000–30000 | 问答域单次外发超时；缺省用默认值，不影响可用性；越界 ⇒ 启动 `ConfigError`（`INVALID_VALUE`） |
| CHAT_LLM_MAX_RETRIES | 可选，默认 1；0–2 | 传输层重试次数（只重试**未派发**的失败）；越界 ⇒ 同上 |
| ADMIN_BOOTSTRAP_LOGIN_NAME | 可选，≤80 字符 | 与密码同时设置；空账号表时初始化 |
| ADMIN_BOOTSTRAP_PASSWORD | 可选，≥12 字符、秘密 | scrypt 摘要；启动脚本初始化失败时会记录但继续启动 |
| VITE_API_BASE_URL | /api/v1，公开变量 | 只用于后台，启动／构建时注入 |
| STAGING_PYTHON | Windows python，否则 python3 | 暂存导入 CLI 使用的既有解释器，不自动安装 |

缺失配置只报告字段，不输出值。真实文件被忽略，密钥由私密环境注入；不要以关闭 TLS 校验解决连接问题。

## 启动必填 ≠ 链路可用（四组域内必填字段）

`real` 下的启动门只强制 9 项（`REQUIRED_WHEN_REAL`，`services/api/src/config.ts:147-157`）。上表新增的 `MEDIA_OBJECT_REF_KEY`、`MEDIA_ACCESS_GRANT_ORIGIN`、`RECOGNITION_PROVIDER_URL`／`_KEY` **不在**其中：进程照常起来，但对应域按域拒绝或降级，是「配了但没生效」的高发点。**`CHAT_LLM_*` 是例外——它参与启动校验**：`asChatProvider(env, issues)` 在只配一半或值非法时 `issues.push`，`loadConfig` 随即抛 `ConfigError`、进程 **exit 1**（与本文件 `:27` 的表格行同口径；实跑见 `node services/api/src/server.ts` 只设 `CHAT_LLM_ENDPOINT` 的形态）。

- **媒体域**：缺 `MEDIA_OBJECT_REF_KEY` ⇒ 7 条媒体路由 503 `PROVIDER_UNAVAILABLE`、语音受理 409 `OBJECT_UNAVAILABLE`（**前提是 ASR 凭据齐备**：`services/api/src/speech/service.ts:437` 的 503 闸门在 `:442` 的 `media.resolve` 之前，凭据也缺时先回 503）；即便对象存储四键与 `MEDIA_OBJECT_REF_KEY` 都齐备，只要没有启动参数 `--approve-real-media-wiring`（`services/api/src/server.ts:29-51` 是批准能力的唯一铸造点）仍是整域 503。
- **问答域**：缺 `CHAT_LLM_*` 不报错，只是继续用确定性回答器——判据看回答的 `model_version` 是否带 `unimplemented:no-real-`。
- **识别域**：缺 `RECOGNITION_PROVIDER_*` ⇒ 受理 503；**配齐这两个 env 也仍然是 409 `OBJECT_UNAVAILABLE`**（`real` 下适配器根本不存在 ⇒ `available` 通过后立刻在媒体解析处被拒），**任务建不出来**、不产生候选；「能受理、随后作业 failed」那条路径在当前代码里不可达。
- **部署模板的关系**：`deploy/cloudrun/env.placeholder.json` 的键集判据只取 `REQUIRED_WHEN_REAL` 与 `config.ts` 里 `trimmed(env, '…')` 的字面量（`tools/verify-release-materials.mjs:351-372`），因此 `MEDIA_*` 两项已在模板中，而 `RECOGNITION_PROVIDER_*`／`CHAT_LLM_*` 不在、也不该为过门禁而加进去（模板「无多余键」同样判红）。

## 加载方式与联调

纯替身开发直接设置 APP_EXECUTION_MODE；已有真实配置可让 Node 显式加载文件。
以下复制仅在 .env 不存在时执行，之后在本机安全填写：

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
node --env-file=.env services/api/src/server.ts
```

数据库迁移单独进程也需要环境；检查目标获准后再执行：

```powershell
node --env-file=.env services/api/src/db/migrate.ts status
```

Vite 的项目根在 apps/admin，不自动读取仓库根 .env；从终端注入公开值后启动／构建，或使用后台本机忽略配置。
开发服务器无代理，默认 /api/v1 会请求后台自身。跨域 API_URL 不自动解决 Cookie／CORS；同源转发与鉴权策略需实现并验证。

集成测试使用独立测试库变量，各入口、库名与角色前置见[数据库交接](../verification/database-run-handoff.md)及[鉴权验证](../verification/gy-i04-27-auth-consent-pg.md)。
供应商验证配置另见[资源交接](../verification/resource-handoff.md)，没有接入的能力不能凭填变量写成可用。

## 启动参数：审核域真实接线的批准开关（GY-R70）

审核域的真实供应商端口**不是配置项**，是一次显式运维动作。它由三个**命令行**参数决定（⛔ 不接受环境变量、不接受配置文件：那等于「配置即门控」，媒体域两轮对抗复审已否掉这条路；本模块去注释后 `process.env` 命中 0 条）：

| 参数 | 形状 | 作用 |
| --- | --- | --- |
| `--approve-moderation-live-wiring` | 整串精确匹配 | 唯一的批准开关；`--approve-moderation-live-wiring=true` 之类的写法**不算**给了 |
| `--moderation-policy-source=<标识>` | 3–120 位，字母/数字与 `._:/@+-`，不得含空白 | 策略**被独立核对过**的出处（非凭据）；形状合法不等于核对过 |
| `--moderation-biz-type=<BizType>` | 正则与 `services/api/src/moderation/live-ports.ts` 的 `MODERATION_BIZ_TYPE_PATTERN` 同源 | **真实** BizType（`tools/ai-config.mjs` 里的那份是自描述占位值，不能拿来开户） |

判定在 `services/api/src/moderation/startup-approval.ts` 的 `resolveModerationStartupApproval()`（纯函数：只吃 `config` 与 `argv`，不读 env、不碰网络），铸造点是 `services/api/src/moderation/live-assembly.ts` 的 `approveModerationLiveWiring()`（唯一，`WeakSet` 对象身份），生产入口只转发：`services/api/src/server.ts:61` 取装配片段，第 62–66 行是「有致命诊断就 `exit 1`」那一段，`services/api/src/server.ts:68` 才是 `buildApp(...)`。

**四条前置同时成立才铸造**：① 开关给了；② 两个值齐备且形状合法；③ 共享凭据齐备（`TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` 成对，且 `APP_EXECUTION_MODE=real`）；④ 配置合法（铸造后仍由同一模块的 `resolveModerationLiveWiring()` 复核剖面/端点/超时）。任一条不成立 ⇒ **不铸造**、不传任何默认值，并打**一行** `stderr` 点名缺的是哪一条（原因只用既有闭集 `missing_approval` / `missing_credentials` / `invalid_configuration`）⇒ **进程 `exit 1`，服务不会起来**；`real` 下审核域保持既有整域 503 `PROVIDER_UNAVAILABLE`（`retryable:false`），非 `real` 下仍是替身端口。

**与 `--approve-real-media-wiring` 的口径一致（2026-10-30 裁定，实跑读数见 [GY-R70 证据页](../verification/gy-r70-moderation-approval-20261030.md)）**：两个批准开关都是「开关给了但前置不满足 ⇒ **启动失败**（`exit 1`）」。理由：要防的不是「审核没开」（那本来就是 fail-closed 503），而是「**运维以为自己把审核开了**」——一行 warn 混在启动日志里等于没有。唯一保留的静默路径是**开关完全没给**（默认路径，与改前逐字相同）。
