# GY-I15（#15）阶段 2 · 社区真实发帖/评论/点赞/筛选/举报 HTTP 面 · 验证证据

- 分支：`feat/gy-i15-community-http`
- HEAD（本记录所描述的**实现**）：`f8ad68af60cb063c7c1892d08d615add0706dac0`
  （其后如仅追加本证据页的更新，不再单独记录；最终 SHA 见分支 HEAD）
- 基线：`upstream/main = fcfa6de9d62aeaaa0489d3319f8f06911312af48`
- 差异：`31 files changed, +3706 / -139`（`git diff --shortstat upstream/main...HEAD`）
- 交付切片（本地提交，**未 push**）：`469882c`（服务层接线）、`1ccc0d6`（HTTP 用例 + 契约台账）、`240c394`（小程序）、`96bb2e0`+`c2017de`（证据页与集成脚本维护）、`f8ad68a`（**人工审核空态说明回归修复**，见 §2.10）
- 本记录**不关闭** #15；#15 的“真实端到端可发布”仍未取得（见 §6）。

## 1. 装配说明（改了什么、接在哪）

### 1.1 新增 HTTP 面（唯一注册点）

`services/api/src/routes/community.ts` 注册契约 **16** 条社区 operation：

| operationId | method | path | 头部要求 |
| --- | --- | --- | --- |
| `listPosts` | GET | `/posts` | `cursor`/`limit`/`crop_id`/`region_code`/`mine` |
| `createPost` | POST | `/posts` | `Idempotency-Key` |
| `getPost` | GET | `/posts/{id}` | — |
| `editPost` | PATCH | `/posts/{id}` | `Idempotency-Key` + `If-Match` |
| `deletePost` | DELETE | `/posts/{id}` | `Idempotency-Key` + `If-Match` |
| `listComments` | GET | `/posts/{id}/comments` | `cursor`/`limit` |
| `createComment` | POST | `/posts/{id}/comments` | `Idempotency-Key` + `If-Match`（父帖 revision） |
| `getComment` | GET | `/comments/{id}` | — |
| `editComment` | PATCH | `/comments/{id}` | `Idempotency-Key` + `If-Match` |
| `deleteComment` | DELETE | `/comments/{id}` | `Idempotency-Key` + `If-Match` |
| `likePosts`/`unlikePosts` | PUT/DELETE | `/posts/{id}/like` | `Idempotency-Key` + `If-Match` |
| `likeComments`/`unlikeComments` | PUT/DELETE | `/comments/{id}/like` | `Idempotency-Key` + `If-Match` |
| `createReport` | POST | `/reports` | `Idempotency-Key` |
| `getOwnReport` | GET | `/reports/{id}` | — |

- **不注册** `POST /admin/posts/{id}/hide`（属 #18，已由 `routes/admin.ts` 注册）。
- 鉴权一律 `guards.requireUser`；`onRequest` 钩子统一写 `Cache-Control: no-store`（成功与失败响应都带）。
- 强 ETag 只在**返回资源表示**的 200/201 上写（`"<revision>"`）；列表与 `Ack` 不写（列表契约明写「无此头」；`Ack` 不返回资源表示，删除后资源已不可读）。
- 头部语义**全部**由服务层判定（缺 `If-Match` ⇒ 428 `REVISION_REQUIRED`，缺 `Idempotency-Key` ⇒ 400 `IDEMPOTENCY_KEY_REQUIRED`），路由层只原样转发。

### 1.2 装配层（`services/api/src/app.ts`）

- 新增 `communityInjection`（全部可选）与 `app.communityService` 装饰；`registerCommunityRoutes` 在 `registerMessageRoutes` 之后注册。
- **real 模式整域 fail-closed**：`executionMode === 'real'` ⇒ `communityService = null` ⇒ 16 条路由一律 `503 PROVIDER_UNAVAILABLE`（`retryable:true`）。理由与 GY-I18/GY-I17 同口径：社区 store 是内存实现（`persistent:false`），在 real 下返回成功封套等于“真实模式下声称投稿成功、重启即丢”。将来接真实持久 store 必须在此**显式放行**。
- **下架同源**：交给后台 `hidePost` 的社区帖子端口 = `adminInjection.communityStore ?? withTakedownObserver(communityStore, …)`，即与社区读取面**同一份** store（否则“后台隐藏了帖子”在社区列表/详情侧不生效）。观察器只发通知，不改 visibility、不改错误映射。

### 1.3 新增两个接线端口（都在社区域自有目录内）

- `services/api/src/community/knowledge.ts`：杂草/药剂关联可用性端口（契约 `KnowledgeLink` 的唯一来源）。
  **默认未接线 ⇒ 一律 `unavailable`**；`createPost`/`editPost` 在“新增/替换引用”时直接 `409 OBJECT_UNAVAILABLE`（契约：「创建遗漏关联等于无关联」，静默丢弃会让客户端以为关联已保存）。
  只认**同时**满足下列条件的资料（比 `/knowledge` 列表更严）：`reference_state === 'available'` ∧ `source.validity === 'valid'` ∧ `source.review_status === 'verified'` ∧ `source.source_kind !== 'simulation'`，且 `id`/`type`/`revision` 与请求目标逐项一致。
- `services/api/src/community/events.ts`：审核结果/下架事件 → 消息域**公开创建口** `appendMessage`。
  只声明**结构性端口** `MessageAppendPort`（不 import 消息域，仓库既有分层：特征域不互相 import）；事件类型只用契约闭集 `moderation`；`event_key = community:<event>:<type>:<id>:r<rev>[:<decision|reason>]` 由消息域 `(owner_id, event_key)` 去重索引保证“同事件不产生第二条消息”。
- `services/api/src/community/takedown.ts`：装配层下架观察器（见 §1.2）。

### 1.4 服务层增补（`services/api/src/community/service.ts`，本 issue 自有模块，**追加式**）

- 可选依赖 `knowledge` / `events`；不注入时默认 fail-closed，既有 64 条阶段 1 用例全部保持通过。
- **契约编辑语义修正**（`PostInput` 逐字）：`编辑遗漏关联保留旧值，显式 null 解除关联。新增/替换引用需当前可用，原已保存失效引用可原样保留，但只输出不可用投影`。阶段 1 把“遗漏”当成 `null`（等于静默解除关联），本轮修正为契约语义。
- `projectPost.linked_knowledge` 改为**逐次现查**（不再恒为 `null`）。
- 审核结果事件在**已提交的 revision** 上投递（创建/编辑成功、重审降级）。被拒的写请求**不投递**：那条 revision 从未落库，投消息只会产生悬挂引用，而作者本人在同一请求里已拿到同步错误封套（含原因码）。此口径已写入代码注释。

### 1.5 小程序

- 新增 `miniprogram/utils/community-api.js`：契约消费层（封套/实体/闭集逐项核对；失败不伪造内容、不做离线成功回落）。
- `pages/community` 改造为真实列表（全部/我的 + 作物 `crop_id` + 地区 `region_code` 筛选、分页、下拉刷新）。
- 新增 `pages/communitycreate`（投稿表单；**不提供**图片上传并如实说明原因）、`pages/communitydetail`（详情/评论/点赞幂等/举报处理状态/本人内容编辑删除）。
- 复用 `styles/*`（tokens/components）、`components/gy-ui-button`、`components/gy-ui-chip`、`components/state-view`；**适老专项本轮不做**。
- 同批同步（缺一即失败）：`miniprogram/app.json` 的 `pages`、`miniprogram/utils/navigation.js` 的 `PAGES`（与 app.json 逐项相等）与详情页 uuid 白名单、`tools/prepare-wechat.mjs` 的页面/依赖允许清单、`tests/local-debug.test.mjs` 的页数断言（13 → 15）。

## 2. 门禁与测试：原始输出与退出码

### 2.1 `npm run lint`（exit 0）

```
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
```

### 2.2 `npm run test:unit`（exit 0）

```
ℹ tests 1818
ℹ suites 0
ℹ pass 1817
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 23907.744
```

### 2.3 新增 `tests/unit/community-http.test.mjs`（真实 loopback HTTP，exit 0）

```
✔ HTTP 正控制：投稿、作物地区筛选、详情、评论、点赞幂等、举报与处理状态 (366.2982ms)
✔ HTTP 反例：游客/后台令牌/失效会话/越权（不泄露存在性，错误封套同形） (87.1689ms)
✔ HTTP 先审后发：规则先挡（危险文本不落内容行、不公开），干净文本 stub 对照通过 (70.8162ms)
✔ HTTP 编辑重审：旧版本审核结果不得套到新版本；被拒编辑不改动旧版本 (63.5549ms)
✔ HTTP 下架一致性：admin hidePost 生效后列表与详情同时消失，旧链接不复活 (54.8156ms)
✔ HTTP 读取时重查负例：隐藏/删除/失效不因缓存或旧链接复活 (57.1106ms)
✔ HTTP 消息事件：投稿/评论/下架投递到消息域公开端口，同键不产生第二条 (67.6886ms)
✔ HTTP real 模式：16 条社区路由一律 503 PROVIDER_UNAVAILABLE（不返回空页、不假成功） (88.7764ms)
✔ HTTP 知识关联：默认未接线 fail-closed；已接线只认已核对非模拟资料 (276.0973ms)
✔ HTTP 知识关联编辑语义：遗漏保留旧值、显式 null 解除、替换需当前可用 (54.0435ms)
✔ HTTP 严格输入：多余字段/长度/枚举/媒体清单/头部/游标一律契约错误码 (120.304ms)
✔ HTTP 图片帖：规则层媒体口径未覆盖 ⇒ fail-closed（绝不把未审图片当通过发布） (34.9563ms)
ℹ tests 12 / pass 12 / fail 0
```

### 2.4 新增 `tests/unit/miniprogram-community-api.test.mjs`（exit 0）

```
✔ 列表：查询串绑定筛选、GET 与授权头正确，空页与分页游标原样透传 (2.636ms)
✔ 成功封套：实体形状/闭集不符即 INVALID_RESPONSE（不"尽力解析"） (7.8299ms)
✔ 写路径头部：Idempotency-Key 合规、If-Match 为强 ETag 形态、方法与路径逐项正确 (2.1115ms)
✔ 错误封套：契约错误码与规则层原因码如实透传；未通过审核不得被当成成功 (3.3783ms)
✔ 会话：401/403 清本地会话并报 SESSION_REQUIRED；网络失败按 SESSION_CHANGED 折叠 (2.4785ms)
✔ 入参预检：非法 uuid / 非闭集举报原因 / 超长正文在本地即拒绝，不发请求 (1.0622ms)
ℹ tests 6 / pass 6 / fail 0
```

### 2.5 `npm run test:mini`（exit 0）

```
PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.
✔ missing, public, wildcard, credential, unsafe path and mismatched configs fail (18.9876ms)
✔ apiBaseUrl accepts origin or origin plus a client-append base path without widening rejections (15.992ms)
✔ actual HTTP service is synthetic, no-store and has no business routes (186.9209ms)
✔ client blocks trial/release/unknown environments and labels stub or failure (4.8192ms)
✔ isolated packaging excludes private files and rejects release overrides/stale output (7694.9368ms)
ℹ tests 5 / pass 5 / fail 0
```

### 2.6 `node --test tests/unit/miniprogram-login-return-to.test.mjs`（要求 `nav.PAGES` 与 `app.json.pages` 逐项相等，exit 0）

```
ℹ tests 41 / pass 41 / fail 0 / duration_ms 340.4922
```

### 2.7 `git diff --check upstream/main...HEAD`（exit 0，无输出）

### 2.8 显式运行的集成脚本（**不在任何 CI glob 内**）

```
$ node tests/integration/admin-http.mjs
映射表覆盖 operationId 数：34 / 34
PASS 组数=27，FAIL 组数=0
[exit 0]

$ node tests/integration/jobs-http.mjs
... （全部 PASS 组，末行为用例清单）
[exit 0]
```

`tests/integration/miniprogram-login-loop.mjs`：**预存在失败**（与本单无关，未修，见 §6.4）。

### 2.9 CI 覆盖面自查：`test:unit`/`test:mini` **不是** CI 的全部

首次交付时我漏跑了两个 **CI 专属**测试文件（它们既不在 `test:unit` 也不在 `test:mini` 的 glob 内），
由 `local-preparation` job（`.github/workflows/local-wechat.yml`）执行 ⇒ 其中一条抓到**真实回归**（见 §2.10）。
完整核对结果（`local-preparation` 共 10 步）：

| # | CI 步骤 | 本地实测 | 退出码 |
|---|---|---|---|
| 1 | `npm ci` | `npm install`（`package.json` 未改动） | 0 |
| 2 | `node tools/check-wechat-project.mjs` | `PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax.` | 0 |
| 3 | `node --check tools/smoke-wechat.cjs` | 无输出 | 0 |
| 4 | `node --test tests/local-debug.test.mjs` | `tests 5 / pass 5 / fail 0` | 0 |
| 5 | `node --test tests/ui-adaptive.test.mjs` | `tests 26 / pass 26 / fail 0` | 0 |
| 6 | `node --test tests/ui-demo-align.test.mjs` | `tests 7 / pass 7 / fail 0` | 0 |
| 7 | `node tools/demo-align.mjs` | `PASS: 令牌逐值一致、关键类齐全、图标几何与 demo 一致、门槛未被破坏。` | 0 |
| 8 | `node tools/verify-layout.mjs` | `PASS: 五档视口下触控区、正文与末屏预留（含最大字号档）均满足门槛。` | 0 |
| 9 | `node --test tests/unit/miniprogram-profile.test.mjs tests/integration/profile-ui-http.test.mjs` | `tests 25 / pass 25 / fail 0` | 0 |
| 10 | 两条 `git check-ignore` 断言 | 4 个私有/生成物被忽略；3 个 `.example` 未被忽略 | 0 / 1（如预期） |

`engineering-shell` job（也由本单路径触发）的 12 步同样逐条跑过：

```
python3 tools/validate_development_docs.py   -> PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
python3 tools/validate_contracts.py          -> PASS: 112 operations; contract consistency; 29 fixtures; 30 media traces; 8 knowledge roundtrips
python3 tools/test_contracts.py              -> Ran 8 tests in 0.354s / OK
npm run lint                                 -> lint 通过
npm run test:unit                            -> tests 1818 / pass 1817 / fail 0 / skipped 1
npm run test:contract                        -> tests 6 / pass 6 / fail 0
npm run test:evaluation                      -> tests 84 / pass 84 / fail 0
npm run build                                -> ✓ built in 720ms（产物在 .gitignore 的 dist/ 内，未入库）
```

#### 本地 Windows checkout 的 CRLF 假失败（如实标注，非仓库缺陷）

在**本机 CRLF 工作树**里 `node tools/demo-align.mjs` 与 `tests/ui-demo-align.test.mjs` 的第 1 组会报
`miniprogram/styles/icons.wxss 与 demo SVG path 生成结果不一致`：该判据是**整文件逐字节相等**
（`expectIcons === actualIcons`），而本机 checkout 为 `i/lf, w/crlf`（`git ls-files --eol` 可查），
生成结果恒为 LF ⇒ 必然不等。
**复核方式**：用 LF 物化的工作树重跑，同一 HEAD 下该判据通过：
```
$ git -c core.autocrlf=false -c core.eol=lf worktree add --detach <tmp> HEAD
$ node -e "console.log(require('fs').readFileSync('miniprogram/styles/icons.wxss').includes(13))"   -> false
$ node tools/demo-align.mjs          -> PASS: 令牌逐值一致、关键类齐全、图标几何与 demo 一致、门槛未被破坏。 [exit 0]
$ node --test tests/ui-demo-align.test.mjs   -> tests 7 / pass 7 / fail 0 [exit 0]
```
CI 跑在 `ubuntu-24.04`（LF 检出）⇒ 该判据在 CI 上成立。因此 §2.9 表中第 6/7 步的实测值取自 **LF 工作树**；
其余步骤在两种检出下均一致（已分别复跑）。

### 2.10 真实回归的发现与修复：社区页丢掉「人工审核空态说明」

- **现象（CI）**：`local-preparation → node --test tests/ui-adaptive.test.mjs` 失败
  `✖ 人工审核仅保留空入口，不展示任何已审核内容 / AssertionError: 缺少人工审核说明`（26 项中 1 项红）。
- **性质**：**真实回归**。`tests/ui-adaptive.test.mjs:257-262` 是该能力的**既有断言**，三条判据要求
  `community.wxml`：① 含「人工审核」；② 命中 `建设中|尚未开放|不提供人工审核`；③ **不得**出现 `已审核通过|审核员|专家认证`。
  我重写社区页时删掉了阶段 1 的「人工审核／内容安全」说明面板 ⇒ ① ② 不再成立。
  该断言对应本仓红线：**人审入口保持空态、不得造假任务/审核人/投票/专家认证**。
- **修法（最小、只加文案）**：在 `miniprogram/pages/community/community.wxml` 恢复一个
  `.panel` 空态说明块（标题「人工审核」+ `pill--gray`「建设中」+ 说明），并**始终渲染**（游客与登录用户都可见，
  避免“看不到入口就以为审核已开放”）；文案显式声明不展示人工审核任务、复核人员、投票或资质信息。
- **连带修正**：`tests/ui-demo-align.test.mjs` 要求五个 Tab 页使用 demo 容器形态类
  （`panel|feature-card|article-card|profile-header`）。新社区页只有 `post`/`feed` 等类，故此前**也**不满足该断言；
  恢复的空态块采用样式层的 `.panel` 一并满足（同一条改动修两处，未新增任何页面级样式）。
- **一次自我纠正（留痕）**：首次尝试把「不得造假任务/审核人/投票/专家认证」这句**写进了 WXML 注释**，
  被同一断言的第三条判据（扫描原始文件文本）当场抓到 ⇒ 已从**注释与文案**中一并清除相关字样。
  结论：该断言扫描的是文件原文（含注释），说明**不得**用“引述禁止词”的方式解释。
- **实测（LF 工作树，HEAD `f8ad68a`）**：
  ```
  $ node --test tests/ui-adaptive.test.mjs
  ℹ tests 26 / pass 26 / fail 0   [exit 0]
  $ node --test tests/ui-demo-align.test.mjs
  ℹ tests 7 / pass 7 / fail 0     [exit 0]
  $ node --test tests/local-debug.test.mjs
  ℹ tests 5 / pass 5 / fail 0     [exit 0]
  $ node tools/check-wechat-project.mjs
  PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.   [exit 0]
  ```
- **纪律**：**未**修改 `tests/ui-adaptive.test.mjs` 的任何判定、**未**删除该断言、**未**放宽门槛；
  只补齐被丢掉的产品说明文案。

## 3. 负例与 fail-closed 对照（逐条对应派单验收）

| 验收点 | 用例 | 实测结论 |
| --- | --- | --- |
| 点赞幂等 | `community-http.test.mjs` 用例 1 | 同键重放 + 不同键重复 `PUT` 后 `countLikes('post', id) === 1`；点赞不改内容 revision（ETag 仍为 `"1"`）；`unlike` 重复后计数为 0 |
| 游客/越权 | 用例 2 | 无令牌 6 条路径全 401 `SESSION_REQUIRED`；后台令牌 → 401 `SESSION_EXPIRED`；他人编辑/删除与不存在**逐字节同形** 404 |
| 规则先挡 | 用例 3 | 危险文本 `decision=rejected` ⇒ 400 `INVALID_REQUEST` + `reason_codes: DANGEROUS_MIX / NOT_PUBLISHABLE`；`posts==0`（不落内容行），`moderation==1`（拒审结论如实留档）；干净文本对照 201 |
| 未通过内容不公开 | 用例 3 | 本人与他人 feed 均 `{items:[],next_cursor:null}` |
| 编辑重审 + 旧结论不套新版本 | 用例 4 | 被拒编辑：ETag 仍 `"1"`、正文未变；通过的重审：ETag `"2"`，`rev1.text_digest !== rev2.text_digest`，`getModeration(…,3) === null` |
| 下架后引用一致 | 用例 5 | 公开 feed 空、他人详情 404、评论列表 404；作者详情显式 `visibility='hidden'`（不复投影成 published）；`mine=true` 与公开 feed 口径分离且不矛盾；旧链接重复访问结论不变 |
| 读取时重查负例 | 用例 6 | 站点外 `commitPostIfCurrent` 置 `hidden` 后，他人读立即 404、列表立即空；旧 ETag `"1"` 写入 ⇒ 409 `REVISION_CONFLICT`；删除后 `visibility='deleted'` ⇒ 详情 404、写入 409 `OBJECT_UNAVAILABLE`、`reReviewContent` 返回 `re_reviewed:false / visibility:'deleted'`（**不复活**） |
| 消息事件 | 用例 7 | 投稿 → 作者收到 `moderation:post:1`；评论 → 评论作者收到 `moderation:comment:1`（不串投）；下架 → `takedown` 事件落 `moderation:post:2`，`reference_state='unavailable'`；同一事件重复投递 `created:false` 且消息数不变、读状态不重置 |
| real fail-closed + stub 对照 | 用例 8 / 全量 | real：16 条路由全 503 `PROVIDER_UNAVAILABLE`（`retryable:true`，无 `data`），游客仍先 401，`snapshotCounts()` 全 0（零内存副作用）；stub：同一批路径按用例 1–7 正常работ（对照成立） |
| 杂草/药剂关联 | 用例 9/10 | 默认未接线 ⇒ `409 OBJECT_UNAVAILABLE` 且 `posts==0`；已接线正例 ⇒ `linked_knowledge.summary.title` + `reference_state='available'`；**模拟资料 / 未核对 / 已失效 / 版本不符 / 类型不符**五类反例全部 `409` 且不落内容行；编辑语义三种分支（遗漏保留、显式 null 解除、替换需可用）逐条断言 |
| 图片帖 | 用例 12 | 合法 uuid 的 1 张附件 ⇒ `422 INPUT_UNCERTAIN`，`posts==0`，公开 feed 空（**不把未审图片当通过**） |
| 严格输入 | 用例 11 | 多余字段/缺 required/超长/地区模式/关联枚举/媒体 >3/媒体重复/媒体非 uuid ⇒ 400；缺 `Idempotency-Key` ⇒ 400；缺 `If-Match` ⇒ 428；`If-Match: *` ⇒ 400；`limit=0`/`limit=51`/`mine=maybe`/未知查询字段 ⇒ 400；游标篡改/跨主体 ⇒ 400 `INVALID_CURSOR` |

## 4. 契约台账同步（真实状态，不是文档粉饰）

- `docs/architecture/contract-status.json`：16 条社区 operation 的 `route_mounted` 由 `false` 改为 `true`，证据补 `services/api/src/routes/community.ts:<行>` 与 `tests/unit/community-http.test.mjs`，`blocker` 改写为**真实剩余缺口**（见 §6）。
- `docs/architecture/contract-implementation-status.md`：由 `node tools/verify-contract-status.mjs --write-doc` 生成（仅 16 行社区表格变化，18+/18−）。
- `node tools/verify-contract-status.mjs`（exit 0）：
  ```
  PASS: 覆盖 112 条契约操作；已装配 94 条；implemented 13 / partial 81 / planned 18；横切维度 8 条；中文表格一致
  PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。
  ```
- 台账类既有断言随之更新（**必要维护，非绕过**）：
  - `tests/unit/contract-status-tool.test.mjs`：注册清单断言由「社区未注册」改为「社区 16 条已接线」；
  - `tests/integration/admin-http.mjs`：`hidePost` 默认装配由「社区存储未接线 ⇒ 503」改为「已接线 ⇒ 未知帖子 404」（行为变更见 §1.2，real 模式 503 由 `tests/unit/admin-real-mode-fail-closed.test.mjs` 覆盖）；
  - `tests/local-debug.test.mjs`：页数断言 13 → 15；打包依赖新增 `utils/community-api.js`。

## 5. 跨线纪律自查

- **未改**：`packages/contracts/**`、`packages/moderation/**`、`services/api/src/messages/**`、`services/api/src/admin/**`、`services/api/src/media/**`、`services/api/src/knowledge/**`、`services/api/src/routes/admin.ts`、`services/api/src/routes/messages.ts`、`services/api/src/routes/media.ts`。
- 与消息域只经**结构性端口**（`MessageAppendPort`）交互，未 import 其实现。
- 未新增契约外路径/字段/错误码；未解除任何既有守卫。

## 6. 未取得 / 未验证（严禁读成已完成）

1. **图片帖子（文字＋图片）未取得**。契约允许每帖 ≤3 图，但 `packages/moderation/merge.mjs` 明确声明：规则层对**带媒体**目标一律不判通过（`MEDIA_NOT_EVALUATED_BY_RULE_LAYER`，硬规则一条都没跑，`hard_rule_passed=false`），合流层**不可能**把它抬成 `approved`；“要让图片目标真正可达 `approved`，必须改规则层的覆盖／媒体口径 → **跨片依赖**”。本单因此**拒绝**带媒体投稿（`422 INPUT_UNCERTAIN`，HTTP 用例 12 钉住），**不**提供图片上传入口。复核命令：`node --test tests/unit/community-http.test.mjs`（用例「HTTP 图片帖」）；依据行：`packages/moderation/merge.mjs:26-31`。
2. **真实 AI 图文审核未授权付费/未接线**。本装配只接**确定性硬规则层**（`packages/moderation` 规则层，经 `community/moderation-gate.ts`）；模型层合流组件（`mergeModeration`）**未接入社区装配**，因此不产出 `model_version`/`prompt_version`（`ModerationRecord.contract_complete === false`），也不得声称任何准确率/召回率（真实样本各为 0）。`real` 模式因**真实持久存储未交付**整域 503（而不仅是审核供应商缺失）。
3. **真实持久存储未交付**：社区 store 仍是内存实现（`persistent:false`），无数据库迁移；`real` 下整域 fail-closed。
4. **真实资料读取口未接线**：`knowledge.ts` 端口真实接线需要把**请求会话身份**（`knowledge/service.ts` 的 `Identity`：user id + authEpoch + 会话 id + 原始令牌，且在同一事务内复核账号/会话有效期）带入社区服务，属对社区 actor 契约的跨线决定 ⇒ 本单**未接线**，默认 fail-closed（新增/替换引用一律 `409 OBJECT_UNAVAILABLE`）。HTTP 用例注入受控端口验证闸门与投影；**不**代表真实资料查询已可用。
5. **消息跳转目标读取端口未接线**：消息域 `createUnwiredReferencePort` 保持默认 ⇒ 社区相关消息的 `reference_state` 恒为 `unavailable`（未注入社区目标读取实现，属跨线接线）。
6. **正式微信身份/真机未取得**：小程序未在微信开发者工具/真机编译运行过；本单只跑通 `node tools/check-wechat-project.mjs`（原生 JSON/路由/共享配置/JS 语法自检）+ `tests/local-debug.test.mjs` 的隔离打包回归。`real` 模式未做真机联调。
7. **正式发布环境未取得**：未做域名/网关/CDN，未发起任何付费调用，未提交密钥/真实 `.env`/个人原始媒体/构建产物。
8. **公开内容取图来源仍未接线**：`media/content-source.ts` 的 `PublishedContentSource` 是**同步**接口（`getPublishedContent` 返回快照而非 Promise），而社区 store 是异步读取；装配层接线需要给媒体域一个同步可用或异步化的端口 —— 属跨线接口决定，本单**未接线**（社区取图维持统一 404 fail-closed）。

### 6.4 预存在的集成脚本失败（如实记录，未修）

```
$ node tests/integration/miniprogram-login-loop.mjs
PASS synthetic HTTP: direct API guest rejected
PASS synthetic HTTP: client openid/role rejected
PASS synthetic HTTP: actual client code establishes synthetic server session and returns once
PASS synthetic HTTP: returned page requires actual GET session verification
Error: Unexpected page dependency
    at require (…/tests/integration/miniprogram-login-loop.mjs:79:15)
[exit -1073740791]
```

原因与归属（已核验，**与本单改动无关**）：该脚本第 73–80 行的页面 `require` 白名单只映射 `font-scale`/`auth`/`page-gate`/`reference`，而
`miniprogram/pages/referencedetail/referencedetail.js:26` 自 `b1f6ab0`（GY-I08 / 承接 #82，**早于基线 `fcfa6de`**）起就 `require('../../utils/profile-api')`。
证据：`git diff --name-only upstream/main...HEAD -- tests/integration/miniprogram-login-loop.mjs miniprogram/pages/referencedetail miniprogram/utils/profile-api.js` 输出为空（本单未触碰这三处）。
该脚本**不在任何 CI glob 内**（`test:unit`/`test:mini` 均不包含 `tests/integration/**`）。修复它属于参考/档案线（GY-I04/I05/I07/I08）的跨线改动，**按派单 §5 停下报告**，未修改。

## 7. 复现命令清单

```bash
cd E:/GengYunCommander/GengYun_W33
npm install
npm run lint
npm run test:unit
npm run test:mini
node --test tests/unit/community-http.test.mjs
node --test tests/unit/miniprogram-community-api.test.mjs
node --test tests/unit/miniprogram-login-return-to.test.mjs
node tools/verify-contract-status.mjs
git diff --check upstream/main...HEAD
node tests/integration/admin-http.mjs        # 不在 CI glob，需显式运行
node tests/integration/jobs-http.mjs         # 不在 CI glob，需显式运行
```

## 8. PR 正文可粘贴段落

```
Refs #15（不关闭整项）

## 交付
GY-I15 阶段 2：社区 HTTP 面 + 复用既有服务层与审核硬规则层。

- **HTTP 面（16 条契约 operation）**：`services/api/src/routes/community.ts` —— 投稿/评论（文字）、作物地区筛选、
  点赞幂等、编辑/删除自己的内容、举报与处理状态；`Idempotency-Key`/`If-Match`/强 ETag/no-store 逐项按契约。
  不注册 `POST /admin/posts/{id}/hide`（属 #18）。
- **先审后发与隔离**：规则先挡 ⇒ 未通过内容**不落内容行**（列表/详情/他人引用均不可见）；编辑生成新版本必须重审，
  结论绑定 `TargetRef{(type,id,revision)}` + 正文摘要，**旧版本结论不套新版本**；下架后列表/详情/评论列表引用一致。
- **读取时重查**：每次读取重算可见性；隐藏/删除/失效不因缓存或旧链接复活（负例含旧 ETag 写入 409、删除后重审 `re_ reviewed:false`）。
- **消息事件**：审核结果/下架事件投递到已合并消息域的**公开创建口** `appendMessage`（结构性端口，未改 `messages/**`），
  同 `event_key` 不产生第二条消息；下架事件由装配层观察器补齐（后台 `hidePost` 与社区读取面**同一份 store**）。
- **小程序**：列表改造 + 新增投稿页与详情页（复用 `styles/*`、`gy-ui-button`/`gy-ui-chip`/`state-view`），
  `app.json`/`navigation.js` PAGES/`prepare-wechat.mjs` 允许清单**同批同步**；适老专项本轮不做。
- **real 模式整域 fail-closed**：真实持久存储未交付 ⇒ 16 条路由一律 `503 PROVIDER_UNAVAILABLE`（不返回空页、不假成功）。

## 测试（原始输出见 docs/verification/gy-i15-community-http-20261020.md）
`npm run lint`、`npm run test:unit`（1817 pass / 0 fail）、`npm run test:mini`、`git diff --check` 全绿；
新增 `tests/unit/community-http.test.mjs`（12 组真实 loopback HTTP，含负例与 real fail-closed 对照）、
`tests/unit/miniprogram-community-api.test.mjs`（6 组适配层回归）。
显式运行（**不在 CI glob**）：`node tests/integration/admin-http.mjs`（27/27 PASS）、`node tests/integration/jobs-http.mjs`。
CI 两个受影响 job 逐条复跑：`local-preparation` 10/10 步、`engineering-shell` 的 12 步（`test:contract` 6/6、
`test:evaluation` 84/84、`build` 成功）全绿。

## 回归修复（既有断言抓到，非改断言）
`local-preparation → tests/ui-adaptive.test.mjs` 曾报 `缺少人工审核说明`：重写社区页时丢掉了
「人工审核仅保留空入口 + 明确说明」的**既有**文案（对应本仓红线：人审入口保持空态、不得造假任务/审核人/投票/专家认证）。
已在 `miniprogram/pages/community/community.wxml` 恢复 `.panel` 空态说明块（对游客与登录用户都可见），
并同时满足 `tests/ui-demo-align.test.mjs` 对 demo 容器形态类的要求。**未改任何断言、未删断言、未放宽门槛。**

## 未取得（不得读成已完成）
1. **图片帖子未取得**：规则层对带媒体目标一律不判通过（`packages/moderation/merge.mjs:26-31` 声明为跨片依赖），
   本单因此拒绝带媒体投稿且不提供上传入口；需改规则层媒体口径（跨线）。
2. **真实 AI 图文审核未授权付费**：只接确定性硬规则层，未接模型层合流，不声称准确率；`real` 未接真实供应商即 fail-closed。
3. 真实持久存储未交付（无迁移，内存 store）；真实资料关联读取口未接线（默认 fail-closed，需把请求会话身份带入社区服务，属跨线）；
   消息跳转目标读取端口未接线；正式微信身份/真机、正式发布环境未取得。
4. **预存在失败（未修）**：`tests/integration/miniprogram-login-loop.mjs` 因 `referencedetail.js` 自 `b1f6ab0` 起
   `require ../../utils/profile-api` 而该脚本白名单未同步（基线 `fcfa6de` 上即失败）；该脚本不在 CI glob，属参考/档案线跨线改动。
```
