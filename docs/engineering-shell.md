# 工程壳：API、后台、toolchain 与分层 CI（GY-I02）

- 任务：GY-I02 / issue [#2](https://github.com/Sek1ro-oka/GengYun/issues/2)（本项为**局部交付**，issue 保持 open）
- base：`main` = `9743a122edb7ac1c55a68cbdceb77a64928029d9`
- 分支：`feature/gy-i02-engineering-shell`
- 状态：工程壳可安装/构建/启动并通过静态、单元、契约与构建检查；**业务路由、真实登录、真实数据库、供应商与用户端页面均未实现**。

本文件记录本项交付的范围、实际运行版本、命令行为、已运行与未运行的检查，以及阻塞项。未运行的检查不写“通过”。

## 1 交付物

| 交付物 | 位置 | 状态 |
| --- | --- | --- |
| Fastify 5 API 骨架（启动、`/health`、配置校验、契约错误码、迁移运行器） | `services/api/` | 已实现并本机运行 |
| 数据库迁移 `0001`（骨架子集） | `services/api/db/migrations/0001_initial_schema.sql` | 已编写；**未对真实 PostgreSQL 执行** |
| Vue 3 + Vite 独立后台骨架（仅鉴权入口占位） | `apps/admin/` | 已实现并可构建 |
| 根 toolchain（npm workspaces + 统一脚本） | 根 `package.json` | 已实现 |
| 配置模板（无密钥）+ 配置校验 | `.env.example`、`services/api/src/config.ts` | 已实现 |
| 冻结运行版本 + 锁文件 | `package.json`（精确版本）、`package-lock.json` | 已生成并通过干净安装 |
| 分层 CI | `.github/workflows/engineering-shell.yml` | 已提交；**是否实际触发见 PR 的 CI 链接** |
| README 修正 | `README.md` | 已修正 |

## 2 实际运行版本（已实测）

本机实测：Node `v24.16.0`（`C:\Program Files\nodejs\node.exe`）、npm `11.13.0`。安装后读取 `package-lock.json` 的实际解析版本：

| 包 | 候选（runtime-baseline.json） | 锁文件实际 | 是否与候选一致 |
| --- | --- | --- | --- |
| fastify | 5.12.5 | 5.12.5 | 是 |
| typescript | 5.9.3 | 5.9.3 | 是 |
| vue | 3.5.43 | 3.5.43 | 是 |
| @vue/compiler-sfc | 3.5.43 | 3.5.43 | 是（与 vue 同补丁版本） |
| vite | 7.3.6 | 7.3.6 | 是 |
| @vitejs/plugin-vue | 6.0.9 | 6.0.9 | 是 |
| pg | 8.23.1 | 8.23.1 | 是 |
| @types/node | 候选未列 | 24.19.1 | 新增开发依赖（见下） |
| @types/pg | 候选未列 | 8.23.1 | 新增开发依赖（见下） |
| postgresql | 17.11 | 未安装/未连接 | **未验证** |

说明：

- `@types/node`、`@types/pg` 是 TypeScript 编译所需的开发依赖，不在 `runtime-baseline.json` 候选清单内；本项按精确版本加入锁文件并在本报告如实标注。
- PostgreSQL 候选 `17.11` **未在本机安装**，未连接、未迁移，因此**不能写成已冻结的运行数据库版本**；数据库运行版本仍待接入环境后确认（GY-I25 / 后续）。
- `packages/contracts/runtime-baseline.json` 的 `verification.clean_install` 仍为 `pending`。该文件属 GY-I01 契约内容，本项**只读不改**，需由指挥转 GY-I01 侧按本报告结论更新。

## 3 第一优先阻塞：候选依赖干净安装

- 复现结论：**`CERT_HAS_EXPIRED` 未复现**。根因是 npm 未走代理、直连超时，而不是证书过期。
- 本机探测（与本轮一致）：`npm config get proxy/https-proxy` 均为 `null`、`strict-ssl=true`；`curl --noproxy '*' -I https://registry.npmjs.org/` 20 秒超时；`curl -x http://127.0.0.1:7897 -I https://registry.npmjs.org/` 返回 HTTP 200。
- 采用的命令（未改全局配置、未关闭 TLS 校验、未换非官方源）：

  ```bash
  node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" install \
    --proxy=http://127.0.0.1:7897 --https-proxy=http://127.0.0.1:7897 \
    --fetch-timeout=60000 --fetch-retries=2 --no-audit --no-fund
  ```

- 结果：`added 101 packages`，生成 `package-lock.json`（lockfileVersion 3）。全部候选包均以 HTTPS + 证书校验从 `registry.npmjs.org` 获取。
- 锁文件驱动的干净安装复验：在**全新目录**按同一 `package.json` + `package-lock.json` 运行 `npm ci`，`added 102 packages`，重新读取到的 fastify/typescript/vue/@vue/compiler-sfc/vite/@vitejs/plugin-vue/pg/@types/node/@types/pg 版本与锁文件完全一致。
- 干净环境复现：CI 使用 `actions/setup-node@24.16.0` + `npm ci`（见第 6 节），CI runner 直连官方源，不需要代理。

## 4 命令与行为

根目录统一脚本（`npm run <script>`）：

| 脚本 | 行为 | 本机实际结果 |
| --- | --- | --- |
| `dev:api` | `node --watch src/server.ts` 启动 API（缺配置立即失败） | 缺配置时 exit 1 且列出字段名 |
| `dev:admin` | `vite` 启动后台开发服务器（127.0.0.1:5173） | 已验证：VITE v7.3.6 ready，`GET /` 返回 HTTP 200 |
| `build` | `tsc` 编译 API 到 `services/api/dist` + `vite build` 后台到 `apps/admin/dist` | PASS（`dist/` 产物不提交） |
| `lint` | API/后台 `tsc --noEmit` + 仓库卫生扫描（禁用 TLS 写法、疑似硬编码密钥、真实 `.env`） | PASS |
| `test:unit` | `node --test "tests/unit/*.test.mjs"`（配置校验、健康检查、迁移运行器逻辑） | PASS 17 |
| `test:contract` | `node --test "tests/contract/*.test.mjs"`（API 常量与 `packages/contracts/*` 逐项比对） | PASS 6 |
| `test:mini` | `node tools/check-wechat-project.mjs` + `tests/local-debug.test.mjs`；**仅 Node 静态检查，不是微信编译器或真机** | PASS（工程静态 + 4 组局部诊断测试） |
| `test:docs` | `tools/run-python.mjs tools/validate_development_docs.py` | PASS（27 项任务/链接/依赖） |
| `db:migrate` | `services/api` 的迁移运行器 `up`；无 `DATABASE_URL` 时 exit 1 | 无凭据时 exit 1（如实失败） |

API 子命令：`node services/api/src/db/migrate.ts up|status|list`。

## 5 配置、健康检查与数据库

### 5.1 配置校验（缺失即失败）

`services/api/src/config.ts` 从环境变量加载配置：

- 必填：`APP_EXECUTION_MODE`（`real` | `stub` | `preset_demo`）。
- `real` 模式必须齐备：`DATABASE_URL`、`SESSION_SIGNING_KEY`、`DELETION_LEDGER_KEY`、`WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`OBJECT_STORAGE_ENDPOINT`、`OBJECT_STORAGE_BUCKET`、`OBJECT_STORAGE_ACCESS_KEY`、`OBJECT_STORAGE_SECRET_KEY`。
- 可选带默认值：`API_HOST`(127.0.0.1)、`API_PORT`(3000)、`LOG_LEVEL`(info)、`DATABASE_HEALTH_TIMEOUT_MS`(2000)。
- 缺任意字段时一次性列出全部字段名并以 exit 1 退出，不静默用默认值顶替；不回显敏感值。

`.env.example` 不含任何真实密钥，可提交；真实 `.env` 被 `.gitignore` 忽略。

### 5.2 健康检查（不假记连接成功）

`GET /health`（运营端点，不属于 `/api/v1` 业务契约）：

- `stub`/`preset_demo`：数据库未配置如实返回 `database.status = not_configured`，HTTP 200。
- `real`：数据库不可达或未配置返回 `degraded` + HTTP 503；可达返回 `ok`。
- 响应含契约 `meta`（`request_id`、`contract_version=1.0.0`、`execution_mode`）。
- **本机没有 PostgreSQL，因此真实连接、迁移执行、`/health` 数据库成功分支均未对真实数据库验证**；相关单元测试仅用内存替身验证控制流。

### 5.3 迁移运行器与 `0001`

- 运行器：`services/api/src/db/migrate.ts`。台账表 `schema_migrations(version, name, checksum, applied_at)`；每个迁移在独立事务执行；已应用迁移的校验和变化判为 drift 并拒绝继续；重复版本号在应用前失败；用 `pg_advisory_lock` 串行化并发迁移。
- `0001_initial_schema.sql` 是数据字典的**最小 coherent 子集**：身份/后台会话、基础资料与来源版本、私有媒体、任务台账、社区内容与媒体授权（含 ADR-001 修订2 要求的 `content_media_refs.media_revision`、`public_authors.avatar_media_revision`、`post_versions.linked_target_*`、`community_media_grants`）。**不是数据字典的完整实现**，其余表在后续迁移按同一契约补齐。
- 已验证：发现/排序/校验和、重复版本拒绝、drift 拒绝、幂等重复执行、无 `DATABASE_URL` 时明确失败（`tests/unit/migrations.test.mjs`）。
- **未验证**：真实空库迁移、约束负例、回滚演练——本机无 PostgreSQL。数据字典要求 GY-I02 运行“空库迁移、重复执行版本拒绝、约束负例与回滚演练”，其中重复执行版本拒绝已在运行器逻辑层验证，其余三项因缺数据库未执行。

## 6 分层 CI

`.github/workflows/engineering-shell.yml`，`permissions: contents: read`，checkout 设 `persist-credentials: false`，不使用任何生产密钥。固定检查名：

| 检查名 | 内容 |
| --- | --- |
| `docs` | `python3 tools/validate_development_docs.py` / `validate_contracts.py` / `test_contracts.py` |
| `static-check` | `npm ci` + `npm run lint` |
| `unit-tests` | `npm ci` + `npm run test:unit` |
| `contract-tests` | `npm ci` + `npm run test:contract` |
| `build` | `npm ci` + `npm run build` |

- 触发：所有 `pull_request` 与 `push` 到 `main`（不加路径过滤，保证后续 PR 有稳定检查名）。
- 微信开发者工具编译与真机是**本机任务**，不在本 CI；`test:mini` 只做 Node 静态检查，不冒充微信真机通过。既有 `.github/workflows/local-wechat.yml` 继续覆盖本机调试准备。
- 本 workflow 是否实际触发并通过，以本 PR 的 CI 链接为准，不在此预写“通过”。

## 7 边界与未完成范围

- 业务 HTTP 路由（`/api/v1/*`）**未实现**；未实现路径返回契约 `NOT_FOUND` 错误封套。
- 真实微信登录、会话、闭包、独立后台鉴权**未实现**；后台仅有占位页，占位登录/登出显式抛错，不伪造登录成功。
- 用户端五 Tab 页面与适老视觉属 **GY-I26（#28）**，本项不改 `miniprogram/pages/**`。
- `packages/contracts/*` 只读消费，未修改。
- 供应商（识别/OCR/ASR/TTS/LLM/审核）、私有对象存储、真实数据库未接入。

### 契约缺口（报告指挥）

`packages/contracts/states.json` 的 `error_status_map` 与 `openapi.json` 均**未定义 500 / `INTERNAL_ERROR`**（响应状态码仅覆盖 200/201/202/400/401/403/404/409/413/415/422/428/429/503/504，无 `default`）。为保证“不伪造契约错误码”，API 对未捕获异常返回 HTTP 500 且响应体显式带 `contract_gap: "NO_CONTRACT_CODE_FOR_500"`，不使用任何契约错误码。该缺口需 GY-I01 侧决策（新增错误码或规定 500 语义）。

## 8 已知限制与阻塞

- 无 PostgreSQL：真实迁移、`/health` 数据库成功分支、约束负例与回滚演练未执行。
- `runtime-baseline.json` 的 `clean_install: pending` 未由本项直接更新（属 GY-I01 契约文件）。
- `contract_version` 常量在 API 内镜像自契约；一致性由 `test:contract` 保证，契约变更须同步。
- 本机沙箱注入了批量删除守卫（WorkBuddy `node-safe-delete-shim`），会拦截 `npm ci` 对 `node_modules` 的清理与 `vite` 的 `emptyOutDir`。这只影响本机重复执行，**不影响项目代码与 CI**；复核 CI（`npm ci` + `vite build`）在干净 runner 上不受该守卫影响。
