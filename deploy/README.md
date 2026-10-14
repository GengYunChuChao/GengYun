# deploy —— 部署准备物

**本目录只有部署准备物：没有部署、没有购买、没有扩权、没有改动既有资源。**

| 路径 | 内容 |
| --- | --- |
| [cloudrun/README.md](cloudrun/README.md) | 微信云托管（API）＋ 上海 CVM（PostgreSQL）Runbook：基线、构建、平台配置、迁移顺序、验收、回滚、未取得项 |
| [cloudrun/service-settings.md](cloudrun/service-settings.md) | 平台字段与依据、健康检查语义、环境变量/机密清单、官方链接 |
| [cloudrun/Dockerfile](cloudrun/Dockerfile) | API 镜像（Node 24.16.0 与 CI 一致、`npm ci --omit=dev`、非 root、仅 stdout、SIGTERM 优雅退出） |
| [cloudrun/Dockerfile.dockerignore](cloudrun/Dockerfile.dockerignore) | 与 Dockerfile 配套的构建忽略清单 |
| [cloudrun/env.placeholder.json](cloudrun/env.placeholder.json) | 平台「环境变量 JSON 导入」模板（**全部为空值／非机密**，无任何真实密钥） |
| [cloudrun/container.config.json.example](cloudrun/container.config.json.example) | 官方模板 `container.config.json` 字段对照；本路线**不使用**该文件 |
| [cloudrun/local-check.ps1](cloudrun/local-check.ps1) | 本地自检：构建镜像 + 容器内 `/health`（需本机 Docker） |

约定：

- 真实密钥只经**私密渠道**交接，不进仓库、PR、文档或聊天；本目录内只有变量名与空值。
- 部署路线为「微信云托管跑现有 Fastify API + 上海 CVM 跑 PostgreSQL」，保留独立 HTTP API 与现有 PostgreSQL 数据模型。
  「讨论云开发或单机 API」不等于已授权全面迁移。
- 本目录不改动 `packages/contracts/**`、现有 PostgreSQL 数据模型/迁移语义、`services/api/src/app.ts`、
  `miniprogram/**`、`apps/admin/**`，也不改根 `package.json`/lock 的依赖版本。
