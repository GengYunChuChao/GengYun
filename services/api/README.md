# 耕云 API（工程骨架 + 认证会话层）

Fastify 5 + TypeScript 模块化单体。**已实现：启动、`/health`、契约错误封套、迁移运行器、微信登录/会话/退出与独立后台鉴权；其余业务路由未实现。**

## 运行

```bash
# 在仓库根安装（npm workspaces）
npm install                 # 直连受限时按 docs/engineering-shell.md 加 --proxy
APP_EXECUTION_MODE=stub npm run dev:api
```

或在本目录：

```bash
APP_EXECUTION_MODE=stub node src/server.ts
```

- 缺 `APP_EXECUTION_MODE` 或 `real` 模式缺服务端配置时，进程 exit 1 并列出缺失字段名（见根 `.env.example`）。
- 监听地址默认 `127.0.0.1:3000`（不默认绑定 `0.0.0.0`）。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 运营健康检查；含 `meta`（`request_id`/`contract_version`/`execution_mode`）与 `checks.database`。数据库未配置/不可达如实报告，不假记成功。 |
| POST | `/api/v1/auth/wechat` | 微信登录：仅凭 `wx.login` code 在服务端换取身份；`Idempotency-Key` 必填。 |
| GET | `/api/v1/auth/session` | 当前用户会话信息（`SessionInfo`）；需用户会话。 |
| POST | `/api/v1/auth/logout` | 退出并撤销当前会话；`Idempotency-Key` 必填。 |
| POST | `/api/v1/admin/auth/session` | 后台登录（`login_name`+`password`）；独立 `audience=admin`；`Idempotency-Key` 必填。 |
| GET | `/api/v1/admin/auth/session` | 后台会话信息；需 scope `session:read`。 |
| POST | `/api/v1/admin/auth/logout` | 后台退出；需 scope `session:logout`；`Idempotency-Key` 必填。 |

错误码严格取自 `packages/contracts/states.json#error_status_map`（401 `SESSION_REQUIRED`/`SESSION_EXPIRED`，403 `SCOPE_DENIED`/`CONSENT_REQUIRED`/`ACCOUNT_INACTIVE` 等）。其余未实现路径返回契约 `NOT_FOUND` 错误封套。

`Idempotency-Key` 语义：在「主体/方法/路径」键域内，同键同体在重放窗口（默认 5 分钟）内**收敛到同一可撤销的登录结果**——台账只记录**不含凭据的结果引用**（登录类为会话 id + 受众，退出类为成功标记，**绝不**存 access token 明文），命中时按该引用在**同一会话上换发新令牌**（保持首次的绝对到期时刻），不新建互不关联的会话；该会话被撤销/过期或账号状态变更即拒绝旧重放。并发同键以原子占位收敛，未占位者等待结果后重放，超时返回 `409 REQUEST_IN_PROGRESS`；同键异体返回 `409 IDEMPOTENCY_CONFLICT`。

会话层把服务端权威 `userId` / `authEpoch`（正整数）/ `role` 填到请求上，供 GY-I27 的 `requireConsent` 消费（接口缝见 `src/auth/middleware.ts`）；`packages/privacy/**` 归 GY-I27，本层不修改。

## 数据库迁移

```bash
DATABASE_URL=postgresql://... node src/db/migrate.ts up      # 应用
DATABASE_URL=postgresql://... node src/db/migrate.ts status  # 查看
node src/db/migrate.ts list                                  # 仅列出（无需数据库）
```

无 `DATABASE_URL` 时 `up`/`status` 明确失败（exit 1），不假装迁移成功。`db/migrations/0001_initial_schema.sql` 是数据字典的最小 coherent 子集，不是完整实现。`0008_auth_session.sql` 只新增幂等键台账 `idempotency_keys`（回滚脚本在 `db/migrations/rollback/`），不引用 `0003` 的对象，也不引用 #51–#55 的 `0004~0007` 对象（版本号原为 `0004`，rebase 到新 main 后重编号为 `0008` 以避开 Codex #51–#55 已占用的 `0004~0007`）。

## 测试与构建

根目录统一命令：`npm run lint`、`npm run test:unit`、`npm run test:contract`。API 类型检查 `npm run typecheck --workspace @gengyun/api`。

认证回归：`tests/unit/auth-routes.test.mjs`（登录/退出/游客拦截/越权/会话撤销/后台高权限拒绝/幂等/客户端不可声明身份）、`tests/unit/auth-guards.test.mjs`（接口缝语义）、`tests/unit/auth-store-pg.test.mjs`（迁移 `0008` 与 SQL 存储，PGlite 内存引擎，**非目标 PG17.11 实库验收**）。

## 边界

真实微信 AppID 端到端实测、目标 PostgreSQL 17.11 实库迁移/回滚、其余业务路由、供应商适配与对象存储均未接入；`packages/contracts/*` 只读消费，`packages/privacy/**` 归 GY-I27。详见 `docs/engineering-shell.md`。
