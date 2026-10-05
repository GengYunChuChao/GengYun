# GY-I04 衔接说明（实现方交接用）

> **文档定位**：在 [GY-I04 实现微信登录、游客限制与服务端归属权限](https://github.com/Sek1ro-oka/GengYun/issues/4) 开工前，梳理「已就绪」与「待实现」的分界，避免重复造轮子或误改他人成果。
> **前置与领取条件**：GY-I04 的正式验收前置为 GY-I02（工程壳组件已合入，整项未验收）、GY-I25（局部已审合入、整项缺资源）、GY-I27（授权与外发守卫）。按 issue #4「接口冻结后可先用明确标注的替身并行开发；缺前置／真实调用证据不关闭整项」及 [development-order.md](development-order.md) 的口径，**组件就绪即可领取并并行实现**，本任务此前写成「GY-I27 未合入前不要领取」属自行收紧条件，现更正。需要与 GY-I27 协调的是 `miniprogram/utils/session.js` 的改动归属。
> **本文档不代表验收结论**，也不改变任何冻结契约；实现方如需改动契约，走既有变更流程。

---

## 1 已就绪的部分（不要重做）

GY-I02（PR #43）建立工程壳时已把本任务需要的骨架铺好：

| 层 | 位置 | 状态 |
| --- | --- | --- |
| 冻结契约 | `packages/contracts/operations.json` | 已定义 6 个鉴权操作，其中用户端 3 个 |
| 数据库 | `services/api/db/migrations/0001_initial_schema.sql` | `users`、`sessions`、`admin_accounts`、`admin_sessions`、`admin_scopes` 均已建表 |
| API 壳 | `services/api/src/app.ts`、`routes/health.ts` | 服务可启动，但**除 `/health` 外无业务路由** |
| 后台鉴权占位 | `apps/admin/src/auth/session.ts` | 明确占位，恒返回 `null`，与用户端会话**分离** |

### 1.1 用户端契约操作（3 个）

| 说明 | 方法与路径 | scope |
| --- | --- | --- |
| `loginWechat`：用微信一次性 code 换身份并建立会话 | `POST /auth/wechat` | `public` |
| 校验并返回当前会话 | `GET /auth/session` | 需认证 |
| 撤销当前会话 | `POST /auth/logout` | 需认证 |

### 1.2 后台端操作（3 个，**不属于本任务**）

`POST /admin/auth/session`、`GET /admin/auth/session`、`POST /admin/auth/logout`。

契约要求后台与用户端会话**分离**（`audience=admin`，独立 token）。`sessions` 表上还有一条硬约束：

```sql
CONSTRAINT sessions_audience_is_user CHECK (audience = 'user')
```

即**用户会话只能写 `sessions` 表，后台会话只能写 `admin_sessions` 表**，两者不可混用。`apps/admin/src/auth/session.ts` 已按此保持 `ADMIN_AUTH_IMPLEMENTED = false` 的诚实占位，**不要为了「看起来能用」而让它返回伪造会话**。

### 1.3 表结构已包含的安全设计

`users`：

| 字段 | 作用 |
| --- | --- |
| `wechat_subject_cipher` | 微信标识（openid）的**密文**存储 |
| `wechat_subject_lookup` | 查找用派生值，唯一索引；注销后擦除 |
| `auth_epoch` | 认证世代，用于**批量撤销**某用户全部会话 |
| `deletion_generation` | 注销世代 |

`sessions`：

| 字段 | 作用 |
| --- | --- |
| `token_hash` | 会话令牌**只存哈希**（`bytea`，唯一索引），不落明文 |
| `audience` | 恒为 `user`（见上） |
| `auth_epoch` | 与 `users.auth_epoch` 对齐，用于世代级失效 |
| `expires_at` / `revoked_at` | 过期与撤销；`revoked_at IS NULL` 表示有效 |

另有约束 `expires_at > created_at`。`admin_scopes` 表为后台最小权限 scope，**本任务不涉及**。

### 1.4 微信侧链路已实测

GY-I25 的实测记录（见 [continuation-evidence.md](verification/continuation-evidence.md)）已用**正式 AppID** 跑通最小鉴权：

- `stable_token`（服务端获取 access_token）→ HTTP 200
- 合成错误 secret → 业务错误码 `40125`，被正确拒绝
- 工具实际 `wx.login` 取得 code → `jscode2session` → HTTP 200，返回 `openid` 与 `session_key`

**结论**：`POST /auth/wechat` 所需的微信调用链**已验证可行**，本任务不必重新验证凭据可用性。`session_key`、`access_token` 等敏感值在该实测中**只存在于进程内存**，未落盘、未输出。

---

## 2 待实现的部分

### 2.1 服务端（`services/api`）

在 `src/routes/` 下新增三个路由，风格对齐现有 `health.ts`：

```
src/routes/auth-wechat.ts     对应 POST /auth/wechat
src/routes/auth-session.ts    对应 GET  /auth/session
src/routes/auth-logout.ts     对应 POST /auth/logout
```

**实现要点**

1. `POST /auth/wechat`
   - 入参只有微信临时登录 `code`（一次性、短时效）
   - 服务端用 `code` 调 `jscode2session` 取得 `openid`
   - `openid` **加密**后写入 `users.wechat_subject_cipher`，并派生 `wechat_subject_lookup` 供唯一索引查找
   - 不存在则建 `users` 记录
   - 生成随机会话令牌：**明文只在响应里返回一次**，数据库只存 `token_hash`
   - 写 `sessions`（`audience='user'`，`auth_epoch` 取自 `users`）
2. `GET /auth/session`
   - 按 `token_hash` 查 `sessions`，校验 `revoked_at IS NULL` 且 `expires_at > now()`
   - 同时校验 `sessions.auth_epoch == users.auth_epoch`；不等即视为失效
3. `POST /auth/logout`
   - 置 `revoked_at = now()`，**物理撤销**而非仅客户端清除
   - 验收要求「注销会话可立即撤销」，因此不接受任何客户端可绕过的延迟撤销设计

### 2.2 客户端（`miniprogram`）

GY-I26 在 `miniprogram/utils/session.js` 预留了开关：

```javascript
const SESSION_ENABLED = false;
function isGuest() {
  if (!SESSION_ENABLED) return true;   // 关闭时无条件游客
  return !read();
}
```

**接入方式**：

1. 置 `SESSION_ENABLED = true`
2. `read()` 补上真实来源：令牌写入 `wx.setStorageSync('gengyun_session', ...)`，读取时校验对象形态、非 `__devPreview`、含字符串 `token`
3. 令牌由 `GET /auth/session` 校验后才视为有效；**仅凭本地缓存不得判定为已登录**

**界面层无需改动**。五个页面的 `guest` 分支按 `isGuest()` 判定，开关一开即自动切换。GY-I26 已把游客态五 Tab 的走查证据留档。

> ⚠️ 改 `session.js` 前先 `git pull`。GY-I26 正在 `feature/gui-adaptive-pages` 上，该文件尚未合入 main；**GY-I27 也很可能触及同一文件**（用途授权与外发账本）。开工前务必确认该文件归属，避免与 GY-I26／GY-I27 冲突。

### 2.3 游客限制的落点

任务书要求「游客不能通过接口、分享链接或页面绕过访问限制」。因此限制**必须落在服务端**：

| 层 | 职责 |
| --- | --- |
| 页面层 | 仅控制入口**可见性**（已由 GY-I26 的 `isGuest()` 实现） |
| API 层 | 每个私有操作按会话受众与归属校验，缺会话一律 401 |
| 数据层 | 私有记录查询必须带 `user_id` 条件，不能先查全量再在应用层过滤 |

`GY-I05`（地区档案）、`GY-I06`（媒体上传）、`GY-I07`（科普查询）等 M2 任务都依赖本任务，届时各自接入服务端鉴权。**本任务应先把鉴权中间件形态定下来**，避免后续各任务各写一套。

---

## 3 验收条目对照

| 验收条目 | 对应实现 | 需要的证据 |
| --- | --- | --- |
| 正常微信登录可用；拒绝额外资料仍可用基础功能 | 2.1.1；不申请手机号、不强制授权资料 | 真机登录录屏 + `GET /auth/session` 返回 200 的实际响应 |
| 越权记录编号、直接 API、分享、会话撤销检查通过 | 2.1.3 + 2.3 | 构造他人 `user_id` 的请求被拒的实测记录；撤销后原令牌立即失败 |
| 不以客户端声称的角色/用户 ID 为最终权限依据；不泄露登录凭据 | 服务端只信 `sessions` 表；`token_hash` 不落明文 | 代码审查点 + 数据库中无明文令牌的实际查询结果 |
| 微信 code 经服务端换取身份；客户端不可指定 openid/角色；注销可立即撤销；**正式 AppID 实测** | 2.1.1；`POST /auth/wechat` 入参只接受 `code` | **必须真机 + 正式 AppID**，不得以测试号界面或模拟器结果替代 |

> 第四条括号内的要求是硬约束：`docs/verification/platform-checklist.md` 已记录正式 AppID 与最小鉴权实测，但**登录业务尚未验证**，两者不可互相替代。

---

## 4 安全红线（不可协商）

以下不是风格偏好，是契约与合规底线，实现时不得为了「先跑通」而绕过：

1. **客户端不得指定身份**。`openid`、角色、`user_id` 一律由服务端从会话推导；请求体中出现即拒绝。
2. **令牌不明文落库**。`sessions.token_hash` 只存哈希；明文仅在签发响应中出现一次。
3. **`session_key` 与 `access_token` 不进日志、不进仓库、不回客户端**。
4. **不伪造登录成功**。`apps/admin/src/auth/session.ts` 已给出诚实占位的范例（`ADMIN_AUTH_IMPLEMENTED = false`、登录直接抛错），用户端沿用同等标准：拿不到真实会话就保持游客态。
5. **权限判断只在服务端**。客户端的 `guest` 分支是展示逻辑，不构成任何访问控制。
6. **`openid` 等登录标识视为个人信息**，须纳入 GY-I19 的删除清单：注销后**在线数据 7 日内删除、备份 30 日内删除，并立即失效会话与外发**。本任务不实现 I19 的全部删除功能，但登录标识的纳入不得遗漏。

---

## 5 建议实施顺序

```
1. 确认 session.js 的改动归属（GY-I26／GY-I27／本任务三方），必要时以替身并行、待守卫合入后收口
2. 与监工确认是否需要先冻结「鉴权中间件」形态（建议先定，避免 M2 各任务重复实现）
3. 服务端：GET /auth/session → POST /auth/logout → POST /auth/wechat（由易到难）
4. 迁移验证：sessions 表约束（audience='user'、expires>created、token_hash 唯一）在真实 PostgreSQL 上生效
5. 客户端：session.js 置 SESSION_ENABLED=true，接 wx.login 与令牌存储
6. 真机走查：正式 AppID 下登录、游客受限、越权拒绝、撤销即时失效
7. 证据归档至 docs/verification/，PR 关联 #4
```

---

## 6 相关文档

- 任务台账：[development-progress.md](development-progress.md)
- 领取与并行口径：[development-order.md](development-order.md)
- 冻结契约校验：`python tools/validate_contracts.py`（112 操作）
- 平台核查与正式 AppID 实测：[verification/platform-checklist.md](verification/platform-checklist.md)
- 微信与供应商实测记录：[verification/continuation-evidence.md](verification/continuation-evidence.md)
- 任务书原文：[initial-issues.md](initial-issues.md) 中的 `GY-I04` 一节
- 需求与验收基线：[product-requirements.md](product-requirements.md)、[requirements.md](requirements.md)
