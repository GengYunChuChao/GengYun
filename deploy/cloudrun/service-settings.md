# 微信云托管服务配置（耕云 API）

本文件记录**平台侧**需要配置的字段与依据。所有字段名与语义均来自官方文档或官方模板仓库（链接见 §4）；
凡未能确证的，明确标为「未确证」，不猜、不编造。

## 1 两条结论（先读）

1. **本仓库不使用 `container.config.json`。** 官方模板仓库里的该文件自带说明：仅配合「模板部署」为服务生成
   「服务设置」的初始值，模板部署结束后与服务发布无关，「复制模板代码自行开发请忽略本配置文件」。
   本路线是**自定义部署 / 绑定代码仓库（流水线）**，权威配置在控制台「服务设置」与「流水线」（或 CLI 参数），
   不在仓库文件里。`deploy/cloudrun/container.config.json.example` 只作字段对照留档，**不要复制启用**。
2. **官方文档中没有「HTTP 健康检查路径」字段；平台的就绪探测是对配置端口做 TCP 连通性探测。**
   官方排查文档把 `Readiness probe failed: dial tcp xx.xx.xx.xx:xxx: connect: connection refused` 解释为
   「无法通过健康检查/端口调用不通」，并把「端口填写错误」列为部署失败首因；Node 自定义部署示例也只是
   `app.listen(process.env.PORT || 80)`。因此本项目**不新造健康检查端点**，沿用既有 `GET /health`
   供人工与监控验收（其语义见 §3）。是否存在任何版本支持自定义 HTTP 健康检查路径：**未确证**；
   若控制台实际出现该字段，以控制台为准并回来更新本文件。

## 2 需要在控制台填写的字段

| 配置位置 | 字段／项 | 本路线建议值 | 依据与说明 |
| --- | --- | --- | --- |
| 服务管理 → 新建服务 | 服务名称 | `gengyun-api`（示例，创建后不可改） | 官方《快速开始-Node.JS》 |
| 服务管理 → 新建服务 | 允许公网访问 | 首次可**关闭**；开放网页后台／浏览器直连需开启公网并绑定 HTTPS 域名 | 小程序 `wx.cloud.callContainer` 走微信专线，**不受公网开关影响** |
| 服务设置 → 服务版本配置 | 容器规格（CPU/内存） | `0.5 核 / 1 GB` | 平台规格 CPU:内存 固定 1:2；最小 0.25 核 0.5 GB，最大 16 核 32 GB。0.25/0.5 是否够本项目（Fastify + pg 连接池）**未验证** |
| 服务设置 → 服务版本配置 | 实例副本数 最小/最大 | `1 / 2` | 最小值设 0 可「无流量不花钱」，但半小时缩容到 0，冷启动期请求报 `SERVICE_NOT_READY`/`connect ECONNREFUSED`；首次验收建议常驻 1 |
| 服务设置 → 服务版本配置 | 扩缩容条件 | CPU 80% 或 内存 80% | 官方提示：只看 CPU 会在内存先满时 OOM → 概率性 500 |
| 服务设置 → 服务版本配置 | 日志采集路径 | `stdout`（默认） | 采集 stdout/stderr；与 Dockerfile 的 volume 路径不得相同。容器不支持持久化存储 |
| 服务设置 → 环境变量 | Key-Value 或 JSON 导入 | 见 §3 清单；JSON 模板 `deploy/cloudrun/env.placeholder.json` | 平台环境变量对具备控制台权限者可见 |
| 服务设置 → 私有网络 | 启用 VPC 并选 VPC／子网 | 与上海 CVM 的 PostgreSQL **同一 VPC 与子网** | 保存后会发布新版本；之后可用私网 IP／内网域名访问 CVM 的 PG；子网需有足够空闲 IP |
| 服务设置 → 流水线 | 代码源／分支 | 绑定 GitHub（私有 Fork 或正式仓库）／`feat/deploy-cloudrun-api-prep` 或合并后的 `main` | 首次使用需授权仓库；平台会建 webhook，删掉即失效 |
| 服务设置 → 流水线 | 目标目录 | **仓库根** | Dockerfile 需 COPY 仓库根的 `package.json`／`package-lock.json`，构建上下文必须是根 |
| 服务设置 → 流水线 | 端口 | `3000` | 必须与容器内 `API_PORT` 一致；非 root 运行**不能**监听 80 |
| 服务设置 → 流水线 | DockerFile 路径 | `deploy/cloudrun/Dockerfile` | 官方说明「会以目标目录做根寻找」，故该相对路径相对目标目录（仓库根）。若平台不接受嵌套路径，把该文件复制到仓库根为 `Dockerfile` 后填 `Dockerfile` |
| 服务设置 → 流水线 | 推送触发 | 首次**关闭** | 开启会在 push/merge 时**全量发布现网** |
| 容器内时区 | — | 默认 UTC | 官方：容器默认 UTC；镜像**未安装 tzdata**，注入 `TZ` 是否生效未验证。本项目数据库用 `timestamptz`，无本地时区依赖 |

## 3 环境变量与机密清单

「注入位置」两列的含义：**平台环境变量**＝在微信云托管控制台填写、随版本下发；
**用户私密交接**＝不经过本仓库，由用户本人经私密渠道交给运维/自己保存。

| 变量名 | 用途 | 是否机密 | 由谁提供 | 注入位置 |
| --- | --- | --- | --- | --- |
| `APP_EXECUTION_MODE` | 执行模式；本路线固定 `real`（real 才允许真实查询，也才强制校验全部服务端凭据） | 否 | 项目 | 平台环境变量 |
| `API_HOST` | 监听地址；镜像已内置 `0.0.0.0`（源码默认 127.0.0.1 会让平台探测连不上） | 否 | 镜像默认 | 镜像 ENV，可被平台覆盖 |
| `API_PORT` | 监听端口；**必须与平台「端口」一致** | 否 | 项目 | 平台环境变量（镜像默认 3000） |
| `LOG_LEVEL` | 日志级别 `fatal..trace`／`silent`；日志走 stdout | 否 | 项目 | 平台环境变量 |
| `DATABASE_HEALTH_TIMEOUT_MS` | `/health` 数据库探测超时（100..60000） | 否 | 项目 | 平台环境变量 |
| `DATABASE_URL` | API 与迁移运行器的 PG 连接串（上海 CVM 私网地址 + 专用运行 LOGIN） | **是** | 用户（CVM／PG 运维） | 平台环境变量；本地跑迁移时经私密渠道注入，**不进仓库** |
| `SESSION_SIGNING_KEY` | 会话令牌摘要、微信身份摘要（HMAC）与幂等请求摘要的密钥 | **是** | 用户 | 平台环境变量 |
| `DELETION_LEDGER_KEY` | real 模式启动必填。**当前无代码消费**（删除台账接线尚未实现，见 `services/api/src/config.ts` 的 `REQUIRED_WHEN_REAL`） | **是** | 用户 | 平台环境变量 |
| `WECHAT_APP_ID` | 正式小程序身份交换的 AppID（公开标识，但仅服务端持有） | 否（公开） | 用户 | 平台环境变量 |
| `WECHAT_APP_SECRET` | 微信服务端身份交换密钥 | **是** | 用户 | 平台环境变量；绝不进仓库、不下发客户端 |
| `OBJECT_STORAGE_ENDPOINT` | real 模式启动必填。**当前无代码消费**（识别/合成媒体端口在 real 下未接线、fail-closed） | 否 | 用户 | 平台环境变量 |
| `OBJECT_STORAGE_BUCKET` | 同上 | 否 | 用户 | 平台环境变量 |
| `OBJECT_STORAGE_ACCESS_KEY` | 同上 | **是** | 用户 | 平台环境变量 |
| `OBJECT_STORAGE_SECRET_KEY` | 同上 | **是** | 用户 | 平台环境变量 |
| `ADMIN_BOOTSTRAP_LOGIN_NAME` | 首次启动创建初始管理员（仅当 `admin_accounts` 为空，scope 仅 `session:read`/`session:logout`） | 否 | 用户 | 平台环境变量；**创建成功后建议移除** |
| `ADMIN_BOOTSTRAP_PASSWORD` | 同上；口令只以 scrypt 摘要入库 | **是** | 用户 | 平台环境变量；**创建成功后建议移除** |

补充说明：

- `RECOGNITION_PROVIDER_URL`／`RECOGNITION_PROVIDER_KEY` 由 `services/api/src/app.ts` 直接读 `process.env`，
  属可选；**不要**在平台留空字符串（源码用 `?? null`，空串不是 `null`），本次无需设置。
- 上述「对象存储」「删除台账」两类变量的真实值**只有在媒体/删除能力接线后才有用途**；当前它们仅通过启动校验。
  这不代表相关能力可用。
- 真实密钥只经私密渠道交接：**不写进仓库、PR、文档或聊天**。本仓库内只有变量名与空值。
- 平台环境变量对控制台可见者即明文可见；是否需要更严格的密钥管理（如外部 KMS）**未在本轮范围**，如需请单独授权。

## 4 官方依据

| 内容 | 链接 |
| --- | --- |
| 微信云托管产品简介与专线／公网开关语义 | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/basic/intro.html |
| 服务设置（容器规格、副本数、扩缩容、日志采集、环境变量、私有网络 VPC）与流水线（端口、目标目录、DockerFile、推送触发） | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/service/pipeline.html |
| 服务问题排查指引（就绪探测＝端口连通性；容器不持久化；默认 UTC） | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/service/faq.html |
| 快速开始-Node.JS 自定义部署（Dockerfile 与发布流程） | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/quickstart/custom/node.html |
| 资源互联调用腾讯云资源自查指南（VPC／对等连接、安全组入站） | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/scene/noun/vpc.html |
| CLI 工具（`run:deploy --containerPort/--targetDir/--dockerfile/--envParams`、`run:rollback`） | https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/cli/ |
| 官方模板仓库中 `container.config.json` 的文件头注释（仅模板部署使用） | https://raw.githubusercontent.com/WeixinCloud/wxcloudrun-express/master/container.config.json |

注：腾讯云开发 CloudBase 云托管（docs.cloudbase.net/run）是**另一个产品面**，本轮未采用；其「部署方式」页同样未见
仓库级 `container.config.json`，需要时另行核对。
