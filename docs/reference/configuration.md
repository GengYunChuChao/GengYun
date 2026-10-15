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
| OBJECT_STORAGE_ENDPOINT | real 必填 | 启动校验；媒体域装配点（`app.ts`）消费：四项齐备才接真实 S3/COS 适配器，**缺任一或非 https ⇒ 媒体域保持 fail-closed 503**；真实桶往返仍**未验证** |
| OBJECT_STORAGE_BUCKET | real 必填 | 同上 |
| OBJECT_STORAGE_ACCESS_KEY | real 必填、秘密 | 同上 |
| OBJECT_STORAGE_SECRET_KEY | real 必填、秘密 | 同上 |
| ADMIN_BOOTSTRAP_LOGIN_NAME | 可选，≤80 字符 | 与密码同时设置；空账号表时初始化 |
| ADMIN_BOOTSTRAP_PASSWORD | 可选，≥12 字符、秘密 | scrypt 摘要；启动脚本初始化失败时会记录但继续启动 |
| VITE_API_BASE_URL | /api/v1，公开变量 | 只用于后台，启动／构建时注入 |
| STAGING_PYTHON | Windows python，否则 python3 | 暂存导入 CLI 使用的既有解释器，不自动安装 |

缺失配置只报告字段，不输出值。真实文件被忽略，密钥由私密环境注入；不要以关闭 TLS 校验解决连接问题。

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
