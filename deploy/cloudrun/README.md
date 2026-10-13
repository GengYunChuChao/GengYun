# 耕云 API 部署准备：微信云托管（API）＋ 上海 CVM（PostgreSQL）

**状态：本次只做部署准备物，未部署、未购买、未扩权、未改动既有资源。**
本文件是 Runbook（步骤、验收、回滚）。字段依据与官方链接见 [service-settings.md](service-settings.md)。

授权来源：用户 2026-10-12 直接授权「最终确定并落实部署路线」——微信云托管跑现有 Fastify API、
上海 CVM 跑 PostgreSQL，**保留独立 HTTP API 与现有 PostgreSQL 数据模型**，便于后续网页版共用。
**这不是 GitHub issue #1／#2／#3 的编号含义**，也不是全面迁移到云开发或单机 API 的授权。

## 1 基线与事实

| 项 | 值 | 来源 |
| --- | --- | --- |
| 基线 | `upstream/main` = `b1f6ab0e4dc304d2dd621d6a20852b31ccbfab3e`（2026-10-13） | 开工时 `git fetch upstream --prune` 后复核（与指挥核对值一致） |
| 分支 | `feat/deploy-cloudrun-api-prep` | 新建 worktree `GengYun_W17`，**不基于任何其它 PR 的分支头** |
| Node | `24.16.0`（本机 `node -v` 亦为 v24.16.0） | `.github/workflows/*.yml` 的 `node-version: '24.16.0'`；根 `package.json` `engines.node >=24.16.0 <25` |
| npm | `11.13.0` | 根 `package.json` `engines.npm >=11.13.0`；本机实测 |
| PostgreSQL | `17.11` | CI 使用 `postgres:17.11`；`docs/verification/database-run-handoff.md` 与开发指南均以 PG17.11 为目标 |
| 监听端口来源 | 环境变量 `API_HOST`／`API_PORT`（默认 `127.0.0.1:3000`） | `services/api/src/config.ts`、`services/api/src/server.ts` 的 `app.listen({host, port})`。**源码不读 `PORT`** |
| 健康检查 | `GET /health`（既有，未新造） | `services/api/src/routes/health.ts`：DB 可达或（非 real 且未配置）→ 200 `ok`；real 且 DB 不可达 → 503 `degraded` |
| 迁移入口 | `node services/api/src/db/migrate.ts {list\|status\|up}`（`npm run db:migrate`） | `services/api/src/db/migrate.ts` |

## 2 本次实测与未验证（先看这张表）

| 检查 | 结论 | 证据 |
| --- | --- | --- |
| `npm ci` 确定性安装 | **实测通过** | `added 103 packages`（本 worktree） |
| Dockerfile 的 COPY 列表是否足够 `npm ci` | **实测通过（以 `npm ci --dry-run` 代替）** | 只放 `package.json`／`package-lock.json`／`services/api/package.json`／`apps/admin/package.json` → `added 87 packages`，exit 0 |
| 容器启动命令 `node services/api/src/server.ts` | **实测通过（本机 Node 直跑，非容器）** | `/health` → `HTTP 200 {"status":"ok",...,"execution_mode":"stub"}`；监听 `0.0.0.0:3199` |
| real 模式缺配置时 fail-closed | **实测通过** | `APP_EXECUTION_MODE=real` 且其余未提供 → exit 1，逐条列出 9 个缺失字段 |
| real 模式 DB 不可达时 `/health` | **实测通过** | 503 `{"status":"degraded","checks":{"database":{"status":"error","category":"connection_failed"}}}` |
| 只读接口的最小验收是否可判别 | **实测通过（负例）** | DB 不可达时 `GET /api/v1/public/home` → 503 `PROVIDER_UNAVAILABLE`；stub 模式同样 503（该端点只在 real＋DB 下可用） |
| `local-check.ps1` 的 **[1/4] 依赖闭包检查**（不需要 Docker） | **实测通过（改前失败 / 改后通过）** | 改前（committed HEAD 的 COPY 清单）⇒ `ERR_MODULE_NOT_FOUND: packages/privacy/guard.mjs imported from services/api/src/privacy/consent-pg.ts`，exit 1；补 `COPY packages ./packages` 后 ⇒ `IMPORT_OK`。详见「变更 2」 |
| `local-check.ps1` 的 [2/4]／[3/4] 控制流与判定 | **实测通过（替身 docker + 真实 `/health` 应答）** | 用替身 `docker.cmd`（不构建任何镜像）跑通，`exit 0` / `PASS`；PS 5.1 语法解析无错误。**这不验证镜像** |
| **镜像真实构建、容器真实启动、容器内 `/health`** | **未验证**：本机**没有 Docker**（`docker` 不在 PATH），也没有平台环境 | 见 §8 的可执行自检脚本与期望输出 |
| 微信云托管控制台字段实际生效 | **未验证**：无环境、无账号操作 | 官方文档语义见 [service-settings.md](service-settings.md) |
| CVM 上的 PostgreSQL 17.11、库、角色、迁移 | **未验证**：无 CVM、无凭据、未部署 | 步骤见 §5 |
| 优雅退出（SIGTERM→关连接池） | **代码已读，未在运行时观测**：Windows 无法投递真实 SIGTERM，且无 Docker | `services/api/src/server.ts:41-50` 注册 SIGTERM/SIGINT → `app.close()` → `pool.end()` |

## 3 镜像构建

```powershell
# 在仓库根执行；构建上下文必须是仓库根（Dockerfile 要 COPY 根的 workspace 清单）
docker build -f deploy/cloudrun/Dockerfile -t gengyun-api:local .
```

- **预期产物**：本地镜像 `gengyun-api:local`（linux/amd64；体积未在本机实测）。
- 平台侧不用手敲这条命令：流水线按「目标目录＝仓库根、DockerFile 路径＝`deploy/cloudrun/Dockerfile`」构建并推送镜像，
  再以该镜像发布版本；CLI 等价命令见 [service-settings.md](service-settings.md) §4 的 CLI 链接。
- 基础镜像 `node:24.16.0-bookworm-slim` 与 CI 的 Node 版本一致。该 tag **已在线确认存在**
  （Docker Hub 返回多架构 manifest；观察到的索引 digest 为
  `sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203`，需要更强可复现性时可写
  `node:24.16.0-bookworm-slim@sha256:2c87…` 固定；tag 被重新推送后 digest 会变）。
- 镜像内**没有**任何密钥、`.env` 或凭据：Dockerfile 只 `COPY` 显式列出的路径，不使用 `COPY . .`。
  **该清单是运行时 import 闭包**（依据与逐条推导见 [service-settings.md](service-settings.md) §5）：
  除 `services/api/{src,db}` 外**必须**包含 `packages/**`——`packages/privacy/*.mjs` 被
  `privacy/consent-pg.ts` 静态 import，`packages/knowledge/catalog/*.json` 被 `profile/service.ts`
  在模块顶层 `readFileSync` 读取。缺了它容器启动必然失败；本 PR 用 `local-check.ps1` 的 [1/4] 复现并修好
  （改前 `ERR_MODULE_NOT_FOUND: packages/privacy/guard.mjs` ⇒ 改后 `IMPORT_OK`）。
  `deploy/cloudrun/Dockerfile.dockerignore` 是同名忽略清单（BuildKit 用 `-f` 时优先读取
  `<Dockerfile>.dockerignore`）；若平台构建器不读取它，可复制到仓库根为 `.dockerignore`——
  它只影响构建上下文体积，**不影响密钥边界**。
- 运行身份是官方镜像自带的非 root `node`（uid 1000），因此**不能**监听 80 等特权端口，默认 `API_PORT=3000`。
- 日志走 stdout（Fastify/pino 默认），镜像不写日志文件；`HEALTHCHECK` 指令**故意不加**：
  平台的就绪探测是端口级 TCP 探测，加了会被误读为平台在用该指令（真实原因见
  [service-settings.md](service-settings.md) §1）。

## 4 平台服务配置

**请在控制台按 [service-settings.md](service-settings.md) §2 逐项填写**（端口、容器规格、实例副本数、
扩缩容条件、日志采集路径、环境变量、私有网络 VPC、流水线目标目录与 Dockerfile 路径）。

- 本仓库**不使用** `container.config.json`（官方模板文件自述仅模板部署使用）；
  `container.config.json.example` 只是字段对照留档，**不要**复制启用。
- 环境变量与机密清单（变量名／用途／是否机密／由谁提供／注入位置）见
  [service-settings.md](service-settings.md) §3；可直接导入的空值模板是 `env.placeholder.json`。
  **空值是刻意的**：导入但未填值时进程会 fail-closed 并列出字段名，不会静默用默认值顶替。
- **真实密钥只经私密渠道交接**：不写进仓库、PR、文档或聊天。本目录内只有变量名与空值。

## 5 迁移与初始化

### 5.1 事实（读代码确认）

- **API 启动时不会自动执行迁移。** `services/api/src/server.ts` 只加载配置、建连接池、装配应用，
  然后调用 `app.authService.ensureBootstrapAdmin()`（仅当 `admin_accounts` 为空且配置了 bootstrap 凭据时建管理员）。
  它**不调用** `applyMigrations`。因此首次部署必须**先迁移，再启动 API**；否则业务查询会因缺表/缺视图失败。
- `services/api/src/db/migrate.ts` 的能力：发现 `services/api/db/migrations/NNNN_name.sql`（升序；
  `rollback/` 子目录因 `isFile()` 过滤而不会被扫描）；台账 `schema_migrations(version,name,checksum,applied_at)`；
  `pg_advisory_lock(767149023178247)` 串行化并发迁移；**校验和 drift 即拒绝继续**；重复版本号在应用前拒绝；
  每个迁移各自独立事务；缺 `DATABASE_URL` 时明确失败（exit 1）。
- **幂等性**：重复执行 `up` 时已应用且校验和一致的迁移进入 `skipped`，只应用缺失项（`applied` 为空即无变化）。
  台账缺失时先 `CREATE TABLE IF NOT EXISTS`。
- **已知限制（沿用既有文档，本次不改语义）**：多个迁移自带 `BEGIN/COMMIT`（`0002`／`0003`／`0004`／`0008`／`0009`），
  与运行器的外层事务嵌套，不能把局部成功证据当成「所有迁移失败都整体原子回滚」
  （见 `docs/verification/database-run-handoff.md`「迁移与重放入口」与 `docs/development-guide.md` §7）。
- `0007_staging_intake.sql` 会自行 `CREATE EXTENSION pgcrypto WITH SCHEMA staging_intake`：
  库中**若已存在** pgcrypto（任意 schema）会失败，**不要预先安装**；迁移身份需具备创建该扩展的权限
  （PG13+ 起 pgcrypto 属 trusted 扩展，库 owner 可建；该点**未在本项目实测**）。
- **角色由谁创建**：`services/api/db/roles/*.sql` 是**运维手工引导**，不在迁移扫描内（文件头写明
  `Operator-only ... NOT a migration`），由数据库管理员用 owner 身份经 `psql` 执行。
- **角色必须在迁移之后执行**：`catalog_readers.sql` 授权 `catalog_read.view home_species`／`registration_evidence`（迁移 0005 创建），
  `knowledge_runtime.sql` 授权 `catalog_read.current_knowledge`（迁移 0010 创建）。
  代码依据：`services/api/db/roles/catalog_readers.sql:15-16`、`knowledge_runtime.sql:7`、
  `tools/local-dev/database.mjs:20-24`（先 `applyMigrations`，后建组）。**指挥给的「建库⇒建角色⇒迁移」顺序按此更正。**
- 被 API 运行身份需要的组（与本地 stub 装配一致的最小集合）：`gengyun_auth_privacy`、`gengyun_preview_reader`、
  `gengyun_consent_granter`、`gengyun_profile_runtime`、`gengyun_knowledge_runtime`
  （依据 `tools/local-dev/database.mjs:21-28` 与 `tools/local-dev/profile-bootstrap.mjs:35,54-55`）。
  `gengyun_evidence_reader` 只被内部登记证据查询 `readRegistrationEvidence` 需要，而该函数当前**没有任何 HTTP 路由消费**
  （仅测试调用，`services/api/src/db/catalog.ts:30`），因此对本次 API 运行不是必需，按需再加。
  **不要**给 API 运行身份 `gengyun_source_operator`／`gengyun_staging_importer`（那是来源/暂存 CLI 专用）。
- 角色脚本会执行 `REVOKE CREATE ON SCHEMA public FROM PUBLIC` 与
  `REVOKE CREATE, TEMPORARY ON DATABASE ... FROM PUBLIC`，因此**只能在全新专用库**上引导；
  库里已有其他使用者时先停下评估，不要接管或删除他人角色。
- 种子（`db/seeds/*.sql`）与脱敏样例**不在本次最少步骤内**：不做则 `/api/v1/public/home` 返回空数组（正常）。
  需要非空科普预览属于资料准备，另行授权。
- 连接串细节：API 的 `DATABASE_URL` 与迁移运行器都把连接串整体交给 `pg`，
  因此可以带 `?sslmode=...`；来源／暂存 CLI 会拒绝带 query 的连接串（见 database-run-handoff），**不要复用同一条串**。

### 5.2 首次部署执行顺序（修正后）

1. **CVM（上海）**：安装并启动 **PostgreSQL 17.11**；安全组/防火墙**只允许 VPC 私网**访问 5432，
   不对公网开放；`listen_addresses` 与 `pg_hba.conf` 按私网来源配置。
2. **建库 + 建迁移 owner**：新建**专用空库**（例 `gengyun`）与迁移管理员身份（与 API 运行身份分离）。
3. **迁移**（owner 身份，私密注入 `DATABASE_URL`）：
   `node services/api/src/db/migrate.ts status` 先看计划，再 `node services/api/src/db/migrate.ts up`。
   也可在云托管实例的 Webshell 里、经 VPC 用同一命令执行（镜像已包含迁移文件）。
4. **角色组**（owner 身份，迁移之后）：
   `psql -f services/api/db/roles/auth_privacy.sql`、`catalog_readers.sql`、`consent_granter.sql`、
   `profile_runtime.sql`、`knowledge_runtime.sql`。
5. **运行 LOGIN**：用私密渠道生成的高强度口令建 `LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
   NOREPLICATION NOBYPASSRLS` 身份（例 `gengyun_api_login`），并 `GRANT` 第 4 步的 5 个组。
   该身份的口令只经私密渠道交接，最终以 `DATABASE_URL` 注入平台。
6. **平台注入**环境变量与密钥（§4），绑定 VPC 后触发构建与发布。
7. **验收**（§6）。

## 6 部署与最小验收

### 6.1 由用户本人在控制台完成（**单列一节**）

1. 确认微信云托管环境（控制台登录、环境创建/选择，主体为对应小程序）。
2. **新建服务**（服务名、是否允许公网访问）。
3. **服务设置-基础信息**：容器规格、实例副本数、扩缩容条件、日志采集路径 `stdout`。
4. **服务设置-私有网络**：启用 VPC 并选择与上海 CVM **同一 VPC/子网**（保存后会发布新版本）。
5. **服务设置-环境变量**：按 [service-settings.md](service-settings.md) §3 填写（含全部机密值）。
6. **服务设置-流水线**：授权代码源、选分支、目标目录＝仓库根、端口＝`3000`、
   DockerFile 路径＝`deploy/cloudrun/Dockerfile`、推送触发先关闭。
7. **触发构建与发布**（首次建议全量发布到测试/灰度，或先发一个版本再验收）。
8. **CVM 侧**：PG 17.11 安装、专用库、迁移 owner、迁移、角色、运行 LOGIN、私网与安全组（§5.2 第 1–5 步）。
9. 记录验收结果与未通过项。
10. 若失败：按 §7 回滚并从「服务日志」（stdout）取证据。

**以上控制台/数据库操作只由用户本人（或其运维）执行；本 PR 不代替、不自动化、不索取账号。**

### 6.2 由 CI／命令完成

- 仓库级检查：`npm run lint`、`npm run test:unit`、`npm run test:contract`、`npm run test:docs`（CI 门禁，本 PR 已跑，见 PR 正文）。
- 镜像：`docker build -f deploy/cloudrun/Dockerfile -t gengyun-api:local .`（本地）或平台流水线（构建+推送）。
- 迁移：`node services/api/src/db/migrate.ts status|up`（需私密 `DATABASE_URL`）。
- 可选 CLI 部署（需用户先在控制台生成 CLI 密钥）：
  `wxcloud run:deploy --envId <env> --serviceName gengyun-api --targetDir=. --dockerfile=deploy/cloudrun/Dockerfile --containerPort=3000`。

### 6.3 最小验收（部署后）

```powershell
# 1) 健康检查：需要 200，且 meta.execution_mode=real、checks.database.status=ok
Invoke-RestMethod https://<服务域名>/health

# 2) 一次只读接口：游客可用，不需鉴权；空库时 data.previews 为空数组也算通过
Invoke-RestMethod https://<服务域名>/api/v1/public/home
```

预期：

| 检查 | 通过条件 | 说明 |
| --- | --- | --- |
| `GET /health` | HTTP 200，`status = ok`，`meta.execution_mode = real`，`checks.database.status = ok` | real 模式下 DB 不可达会得到 503 `degraded`（本机已实测），因此这条同时验证了容器→CVM PG 的 VPC 链路 |
| `GET /api/v1/public/home` | HTTP 200，`meta.execution_mode = real`，`data.previews` 为数组（可空） | 该端点需要运行身份具备 `gengyun_preview_reader`；权限缺失会被映射为 503 `PROVIDER_UNAVAILABLE` |

其他可选只读确认：`GET /health` 连续两次（排除冷启动偶发）、服务日志中无 `database health check failed`。
**不要**用「能打开域名」代替上述两条；也不要把 stub 模式下的 503 当失败（stub 下 `/api/v1/public/home` 必然 503，本机已实测）。

## 7 回滚

| 场景 | 动作 | 依据 |
| --- | --- | --- |
| 新版本有问题 | 控制台「部署发布」把线上版本切回上一版本；或 CLI `wxcloud run:rollback -v <version>` | 官方 CLI 文档 `run:rollback` |
| 改错了服务设置／环境变量 | 服务设置改动会发布新版本；把线上版本切回改动前的版本，再在服务设置里改回 | 官方《服务设置》：配置变更只影响之后的版本 |
| 迁移本身出错 | 运行器为每个迁移开事务并在失败时 `ROLLBACK`；但多个迁移自带 `BEGIN/COMMIT`（0002/0003/0004/0008/0009）与外层事务嵌套，**不能**推定台账与结构一定整体原子回滚——先停 API、读日志、按对应验证页处理 | migrate.ts；database-run-handoff |
| 需要结构级回退 | 人工执行 `services/api/db/migrations/rollback/*.down.sql`（运行器不扫描；保留审计时 0006/0007 的 down 可能拒绝并保留对象） | db/README.md、database-run-handoff |
| 种子数据回退 | 人工执行 `db/seeds/rollback_seed.sql` | db/README.md |
| 需要立即停止对外服务 | 实例副本数最小值设 0（无流量即缩容）；彻底下线＝删除服务（**会永久删除该服务的版本、流水线、镜像**） | 官方《服务设置》 |

数据库侧**没有**本轮新增的回滚语义；本 PR 未修改任何迁移或角色文件。

## 8 本地自检（可执行）

```powershell
pwsh -File deploy/cloudrun/local-check.ps1
```

Windows PowerShell 若策略受限（报 `cannot be loaded ... is not digitally signed`），改用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/cloudrun/local-check.ps1
```

脚本做四件事：**[1/4] 依赖闭包检查（不需要 Docker）**——解析 Dockerfile 的 COPY 清单、把「镜像根」复刻到临时目录
（`node_modules` 用 junction 指向仓库现有安装）并以容器根视角 import 入口依赖链 → 构建镜像 →
检查镜像内**没有** `.env` 且以非 root 运行 → 以 `APP_EXECUTION_MODE=stub` 启动容器并轮询 `/health` → 清理。
期望输出（脚本内打印）：

```
[1/4] 依赖闭包检查（容器根视角，不需要 Docker）… IMPORT_OK
[2/4] docker build -f deploy/cloudrun/Dockerfile -t gengyun-api:local .
[2/4] 镜像静态检查：uid=1000；未发现 /app/.env 或 /app/.env.*
[3/4] GET http://127.0.0.1:3199/health -> HTTP 200 status=ok execution_mode=stub
[4/4] PASS
```

退出码：`0` = 全部通过；`1` = 有检查失败；`2` = 环境不可用（找不到仓库根／Dockerfile／依赖未安装）；
`3` = **仅依赖闭包检查通过（本机无 Docker）**——即在没有 Docker 的机器上，脚本仍然能挡住
「COPY 清单缺文件 ⇒ 容器启动必然失败」这一类缺陷，其余镜像层检查如实留作未验证。

**本机（开发机）没有安装 Docker**：本 PR 在本机跑过的是 **[1/4] 依赖闭包检查**（改前失败、改后 `IMPORT_OK`，
原始输出见 PR 正文「变更 2」）；[2/4] 镜像静态检查与 [3/4] 容器 `/health` **没有跑过**，脚本会以 `exit 3`
报告「部分通过」，第 2 张表也把「镜像真实构建、容器真实启动」标为未验证。有 Docker 的机器上请直接执行上面的命令；
也可以用等价的纯命令序列：

```powershell
docker build -f deploy/cloudrun/Dockerfile -t gengyun-api:local .
docker run --rm -d --name gengyun-api-check -p 3199:3199 `
  -e APP_EXECUTION_MODE=stub -e API_HOST=0.0.0.0 -e API_PORT=3199 gengyun-api:local
Invoke-RestMethod http://127.0.0.1:3199/health     # 期望 200 / status=ok / execution_mode=stub
docker rm -f gengyun-api-check
```

## 9 未部署声明与未取得项

**本次未部署。** 没有创建服务、没有绑定 VPC、没有构建或发布镜像、没有发布数据库、没有产生任何费用。

未取得项（都需要用户提供或授权，本轮**没有**索取、也没有尝试获取）：

- 微信云托管**环境 ID 与服务**（控制台创建）。
- 与上海 CVM **同一 VPC/子网**的私有网络配置。
- **上海 CVM 上的 PostgreSQL 17.11 实例**（安装、专用库、迁移 owner、运行 LOGIN）。
- `DATABASE_URL`／`SESSION_SIGNING_KEY`／`DELETION_LEDGER_KEY`／`WECHAT_APP_SECRET`／`OBJECT_STORAGE_*` 的**真实值**。
- 微信云托管 **CLI 密钥**（需账号管理员扫码生成）。
- 自定义域名与 HTTPS／备案（小程序 `callContainer` 可先不依赖；网页后台直连需要）。
- 本机 **Docker**（因此镜像层未实测）。
- 迁移／角色／数据库的**真实执行证据**（需 3、4 项就绪）。

## 10 关联文件

| 文件 | 用途 |
| --- | --- |
| `deploy/cloudrun/Dockerfile` | API 镜像定义（Node 24.16.0、`npm ci --omit=dev`、非 root、仅 stdout、优雅退出） |
| `deploy/cloudrun/Dockerfile.dockerignore` | 与 Dockerfile 配套的构建忽略清单 |
| `deploy/cloudrun/service-settings.md` | 平台字段、健康检查语义、环境变量/机密清单、官方依据 |
| `deploy/cloudrun/container.config.json.example` | 官方模板 `container.config.json` 字段对照（本路线**不使用**） |
| `deploy/cloudrun/env.placeholder.json` | 平台「环境变量 JSON 导入」的空值模板（无任何真实值） |
| `deploy/cloudrun/local-check.ps1` | 本地自检：[1/4] 依赖闭包检查（**不需要 Docker**）+ [2/4] 镜像静态检查 + [3/4] 容器内 `/health`（后两项需 Docker） |
