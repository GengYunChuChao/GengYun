# 耕云独立后台（工程骨架）

Vue 3 + Vite 后台骨架。**后台鉴权接口已实现（GY-I04），但没有业务页面与控制台登录界面。**

## 运行与构建

```bash
# 在仓库根
npm run dev:admin      # 开发服务器 http://127.0.0.1:5173
npm run build          # 构建到 apps/admin/dist（不提交）
```

## 范围

- 后台与小程序端**分别鉴权**（契约 `audience=admin`，独立会话与令牌表）。
- 服务端接口：`POST|GET /admin/auth/session`、`POST /admin/auth/logout`（需 `Idempotency-Key`）；
  scope `session:read` / `session:logout` 缺一即 `403 SCOPE_DENIED`。
- 客户端能力在 `src/auth/session.ts`（`loadAdminSession` / `signInAdmin` / `signOutAdmin`），
  令牌只存 sessionStorage，不写日志、不承载密钥；未登录不伪造“已登录”。
- 控制台业务页面（分类、资料来源版本、药剂规则、账号、AI 状态与功能开关）属 GY-I18。
- 前端只用公开变量 `VITE_API_BASE_URL`（默认 `/api/v1`）指向 API 基地址。

详见 `docs/engineering-shell.md`。
