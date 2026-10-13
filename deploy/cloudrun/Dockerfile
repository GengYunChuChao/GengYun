# 耕云 API（Fastify 5）容器镜像 —— 微信云托管运行用。
#
# 权威说明、构建命令、平台配置项、验收与回滚：deploy/cloudrun/README.md
# 构建上下文必须是**仓库根**（本文件需要 COPY 仓库根的 workspace 清单）：
#   docker build -f deploy/cloudrun/Dockerfile -t gengyun-api:local .
#
# Node 版本与 .github/workflows/*.yml 的 node-version 一致：24.16.0（engines 亦为 >=24.16.0 <25）。
# 镜像内不含任何密钥、.env 或凭据；真实值一律由平台「服务设置-环境变量」注入（见 README 清单）。

# ---- 依赖层：与 CI 相同的确定性安装（npm ci + 仓库根 package-lock.json）----
FROM node:24.16.0-bookworm-slim AS deps
WORKDIR /app
# npm ci 按仓库根 workspace 清单解析锁文件；apps/admin 只复制清单以满足解析，
# 其源码与构建产物不进入镜像（API 不依赖它）。
COPY package.json package-lock.json ./
COPY services/api/package.json ./services/api/package.json
COPY apps/admin/package.json ./apps/admin/package.json
# --omit=dev：运行只需要 fastify 与 pg（typescript/@types 等仅构建与测试用）。
RUN npm ci --omit=dev --no-audit --no-fund

# ---- 运行层 ----
FROM node:24.16.0-bookworm-slim AS runtime
# API_HOST 必须是 0.0.0.0：源码默认 127.0.0.1（仅本机开发），容器内那样绑定会让
# 平台的就绪探测连不上端口（官方 FAQ「Readiness probe failed / 无法通过健康检查」）。
# API_PORT 默认 3000，必须与平台「端口」配置一致；平台会覆盖同名的服务环境变量。
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=3000 \
    LOG_LEVEL=info
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY services/api/package.json ./services/api/package.json
COPY apps/admin/package.json ./apps/admin/package.json
# 源码 + 迁移与角色 SQL：migrate.ts 以自身位置解析 services/api/db/migrations，
# 因此迁移可在容器内、经 VPC 私网访问数据库后执行（见 README「迁移与初始化」）。
COPY services/api/src ./services/api/src
COPY services/api/db ./services/api/db
# 非 root 运行；官方 node 镜像自带 uid 1000 的 node 用户。
# 也因此监听端口不能选 80（非 root 无法绑定特权端口），默认 3000。
USER node
# 仅作声明用途（不改变实际监听端口）：实际端口由 API_PORT 决定。
EXPOSE 3000
# 直接 exec node，不经 npm/shell：SIGTERM 直达 PID 1，
# services/api/src/server.ts 已注册 SIGTERM/SIGINT 优雅退出（关停 Fastify 再结束连接池）。
CMD ["node", "services/api/src/server.ts"]
