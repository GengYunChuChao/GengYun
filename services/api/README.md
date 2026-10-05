# 耕云 API（工程骨架）

Fastify 5 + TypeScript 模块化单体骨架。**只有启动、`/health`、契约错误封套与迁移运行器；业务路由未实现。**

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

未实现的业务路径返回契约 `NOT_FOUND` 错误封套。

## 数据库迁移

```bash
DATABASE_URL=postgresql://... node src/db/migrate.ts up      # 应用
DATABASE_URL=postgresql://... node src/db/migrate.ts status  # 查看
node src/db/migrate.ts list                                  # 仅列出（无需数据库）
```

无 `DATABASE_URL` 时 `up`/`status` 明确失败（exit 1），不假装迁移成功。`db/migrations/0001_initial_schema.sql` 是数据字典的最小 coherent 子集，不是完整实现。

## 测试与构建

根目录统一命令：`npm run lint`、`npm run test:unit`、`npm run test:contract`。API 类型检查 `npm run typecheck --workspace @gengyun/api`。

## 边界

真实微信登录、会话、业务路由、供应商适配与对象存储均未接入；`packages/contracts/*` 只读消费。详见 `docs/engineering-shell.md`。
