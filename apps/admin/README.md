# 耕云独立后台（工程骨架）

Vue 3 + Vite 后台骨架。**只有独立鉴权入口占位，没有业务页面。**

## 运行与构建

```bash
# 在仓库根
npm run dev:admin      # 开发服务器 http://127.0.0.1:5173
npm run build          # 构建到 apps/admin/dist（不提交）
```

## 范围

- 后台与小程序端**分别鉴权**（契约 `audience=admin`，独立会话）；本骨架不产生任何可用凭据。
- 登录/登出占位显式抛错，不伪造“已登录”，不调用 `/admin/auth/session`。
- 分类、资料来源版本、药剂规则、账号、AI 状态与功能开关等由后续任务实现（F08 / F13 / GY-I18）。
- 前端只用公开变量 `VITE_API_BASE_URL`（默认 `/api/v1`）指向 API 基地址，不承载任何密钥。

详见 `docs/engineering-shell.md`。
