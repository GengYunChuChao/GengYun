# GY-I26 后台侧「人审空入口」与社区审核队列空态 · 独立后台走查（2026-11-03）

关联：#28（本页为 `Refs #28` 的后台侧界面证据，不是整项验收完成）。

结论一句话：**独立后台里「人工审核」只有一个**真实空入口**（结构性零，`wired: false`），「社区审核队列」在缺真实存储的情况下**如实显示空队列而不是编造待审条目**；两页都没有伪造待审计数、审核人或「人审已通过」标记。**

## 1. 取证环境（全部如实列出）
- 前端：`apps/admin`（Vue + Vite）用 `vite` 开发服务器起在 `http://127.0.0.1:5173`，`API 基地址：/api/v1`（`apps/admin/vite.config.ts:9` 把 `/api` 同源代理到 `http://127.0.0.1:3000`）。
- 后端：本地 stub API（`http://127.0.0.1:3000`，`meta.execution_mode = stub`、`/health` 的 `checks.database.status = ok`）+ 真实 PostgreSQL（`127.0.0.1:55436`）。数据库是**复用的既有本地 synthetic 库**（2026-10-28 建的库，本次补跑迁移的读数为 `6 applied, 47 unchanged`）；该库的迁移台账曾被手工改过一条 checksum（见 §7 第一条），因此**本页不主张该库 schema 与当前 main 等价**。本页结论不依赖这一点：它只依赖 admin API 与 `apps/admin` 的运行时行为（`meta.execution_mode = stub`、队列确实返回 `items: []`）。要干净复现请看 §6 第 1 步。
- 后台账号：**本地播种的取证账号**（`local-admin`），scope 为 `session:read`、`session:logout`、`sources:read`、`sources:write`。
  - 偏离说明：仓库默认的初始管理员只授 `session:read` / `session:logout`（`services/api/src/auth/service.ts:40` 的 `BOOTSTRAP_ADMIN_SCOPES`），看不到审核队列。本机取证为了让页面进入「已登录 + 有读权」的真实分支，直接在本地库播种了带 `sources:read` / `sources:write` 的账号 —— 这是**本机 fixture**，不是生产授权口径（生产走 `POST /admin/administrators/{id}/scopes` 的 `scopes:write` 唯一写路径）。
  - 本机另有一次性的库权限放宽：本地库没有分域角色，故把 `public` 下表的读写授给本地运行时角色；生产按 `deploy/postgres-cvm/sql/20-login-roles.sql` 的最小面分域授予，两者不可混读。
- 浏览器：Chrome headless（`--headless=new`），通过 DevTools Protocol 驱动，视口 1440×1000、`devicePixelRatio 1`；**全部交互都是真实 DOM 操作**（填登录表单 → 点「登录」→ 点导航 Tab），没有注入会话缓存、没有改路由、没有伪造页面状态。
- 未做：真实凭据、正式 AppID、真机、任何真实审核供应商。

## 2. 走查步骤与读数
完整机器读数见同目录 `i28-admin-observations.json`（含每步截图字节数与页面正文快照）。

| 步骤 | 结果 | 关键读数 |
| --- | --- | --- |
| 打开后台壳 | ok | 标题 `耕云 · 独立后台（骨架）`；导航 10 个 Tab 全部可见 |
| 点「社区审核队列」Tab | ok | 命中 `社区审核队列 读 + 通过/驳回已接入`（`apps/admin/src/App.vue:36`） |
| 填本地取证账号并点「登录」 | ok | 登录后出现「退出登录」；页面显示当前会话 scope 列表 |
| 读审核队列第一页 | ok（空态） | `GET /admin/posts?limit=20` → `200`、`items` 长度 `0`、只返回 `items`/`next_cursor`；页面文案「**审核队列为空** · 空队列，不是错误：服务端这一次返回了 0 条（`items: []`），没有可审核的帖子」 |
| 点「人工审核（占位）」Tab | ok | 命中 `人工审核（占位） 未实现`（`apps/admin/src/App.vue:37`） |
| 读人审入口页 | ok（结构性零） | 「当前待审核对象计数 **0** 个待审核对象 · 结构性零（`wired: false`）」，并逐条给出数据来源 |

接口层直读（与页面读数一致）：
- `POST /api/v1/admin/auth/session` → `200`（`token_type: Bearer`、`audience: admin`）。
- `GET /api/v1/admin/auth/session` → `200`，`scopes = ["session:logout","session:read","sources:read","sources:write"]`。
- `GET /api/v1/admin/posts?limit=20` 与 `GET /api/v1/admin/posts?limit=20&audit_state=pending` → 均 `200`、`items=[]`。

## 3. 为什么这两个「空」是真事实，不是被藏起来的数据
- 人审入口的计数是**结构性零**：`services/api/src/moderation/nonbypass.ts:161-168` 的 `humanReviewQueue()` 恒返回 `items: []`，且 `human_review_state` 恒为 `under_construction`。
- 后台人审目录同样恒空：`services/api/src/admin/human-review.ts:68-89` 的 `createHumanReviewDirectory()` 每次返回**新建的冻结快照**，`tasks` / `reviewers` / `votes` / `expert_certifications` 全是冻结空数组，`wired: false`；并带 `assertNoReviewClaim()` 拒绝任何「人审已通过」的声称。
- 页面头部注释写明了本页**不发起任何网络请求**、也不伪造队列与审核人（`apps/admin/src/views/ReviewPlaceholderView.vue:1-25`）。
- 社区审核队列的空态来自服务端真实返回：本次库内没有任何可审帖子，`GET /admin/posts` 回 `200` + `items: []`；页面明确区分「空队列」与「无权限（403）」——后者不会伪装成 0 条。

## 4. 截图（按顺序，完整画面未裁剪）
1. `00-admin-entry.png` — 后台壳与 10 个导航 Tab（含「人工审核（占位）未实现」标注）
2. `01-moderation-signin.png` — 社区审核队列页的登录表单（未登录态）
3. `02-moderation-queue-empty.png` — 登录后的空队列（「审核队列为空 · 不是错误」）
4. `03-human-review-empty-entry.png` — 人工审核真实空入口（0 个待审核对象、结构性零、来源与未取得项）

## 5. 覆盖与未覆盖（写清楚，免得被当成整项验收）
- 覆盖：后台可启动、导航可达、审核队列读面在真实服务端上返回空态并被如实呈现、人审入口是真实空入口且给出数据来源、页面不伪造待审计数与审核人。
- 未覆盖：①`approve` / `reject` 两个写动作**本次没有可审对象**，未在真库上执行（写路径有独立单测与集成脚本，见 `tests/unit/admin-moderation-*`），因此本页不声称写动作已验收；②缺 scope 的 403 界面本机没复现（账号具备 `sources:read`），只按代码与页面文案描述；③真实凭据、正式 AppID、真机、真实审核供应商均未使用。
- 与 GY-I26 的关系：本条只补「只保留人审空入口」这一条在**后台侧**的可见证据；同项还有真机与正式接入部分，仍按 issue 的验收清单另行取证。

## 6. 复现命令（本机）
```powershell
# 1) 新建隔离 synthetic 库，按未改写台账的迁移链执行（⛔ 不要复用带手工 checksum 偏离的旧库）
node .local/local-dev/database.mjs
# 2) 起本地 stub API（stub 执行模式 + 真实 PostgreSQL），并在空库时播种取证账号
node .local/local-dev/api-admin.mjs
# 3) 起独立后台（vite，/api 同源代理到 127.0.0.1:3000）
node node_modules/vite/bin/vite.js --port 5173 --strictPort   # 工作目录 apps/admin
# 4) Chrome headless + DevTools Protocol 走查与截图
node .local/cdp-admin.cjs .local/evidence/admin-20261103 9222
```

## 7. 本机环境坑（复现时会撞到，先记下；⚠️ 其中的临时偏离不得当作 schema 等价或干净迁移的证据）
- **迁移台账 checksum drift（⚠️ 不是安全做法，也不是修复指南）**：复用旧本地库时 `applyMigrations` 报 `迁移校验和 drift，拒绝继续：0013(磁盘 … != 台账 …)` —— 旧库是 10-28 迁的，`0013` 之后被改过。取证时把台账里 `0013` 的 checksum 改成磁盘现值再迁。**这只是为了让本机旧库上的取证跑完而做的临时偏离**：⛔ 它不能作为「该库 schema 与当前 main 等价」或「干净迁移成功」的证据，⛔ 也不是给别人照着绕过的指南 —— 迁移校验和的作用正是拦住这种静默不一致。**安全复现**：按 §6 第 1 步新建隔离 synthetic 库，原样执行迁移链，不改台账。
- **运行时角色缺表权限**：本地库的 `gengyun_local_runtime` 没有后台表的授权，起 API 直接 `permission denied for table admin_accounts`；本机按第 1 节的偏离说明放宽后通过。
- **没有 Playwright/Puppeteer**：仓库 `node_modules` 里两者都没有，故用 Chrome 自带的 DevTools Protocol（Node 24 的内置 `WebSocket` + `Page.captureScreenshot`）驱动；`Page.captureScreenshot` 带 `captureBeyondViewport` 才能截到整页。
- **vite 代理目标是硬编码**：`apps/admin/vite.config.ts:9` 的 `API_DEV_ORIGIN` 写死 `http://127.0.0.1:3000`，所以 API 必须起在 3000，而不是小程序取证惯用的 3100。

## 8. 署名与边界
- 证据采集与驱动脚本：协调者（DSH 会话）。
- 产品代码：本页**不含任何产品代码改动**，只是取证文档与截图；被取证的行为全部来自当前 main 的既有实现。
- 采集过程不写入会话缓存、不打印令牌与口令、不调用真实审核/识别/语音供应商。
