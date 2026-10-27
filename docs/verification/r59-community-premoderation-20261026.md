# R59 · 社区「先审后发」现状口径与机读钉子（2026-10-26）

> **一句话结论**：「先审后发」目前是**同请求内两步的自动化审核链路**，不是人工审核。
> 内容先以 `private` / `pending` 落库，紧接着由审核域在**同一个请求**里 publish 成
> `published` / `approved`；而人工「通过 / 驳回」这个动作在**契约、服务层、后台三处都不存在**。
> 后台的人审入口是**结构性零**（一个请求都不发），作者侧也**没有**「已驳回」态。

| 项 | 值 |
| --- | --- |
| 仓库 | `GengYunChuChao/GengYun` |
| 基线 | `origin/main = f6c5866dd06683329ecfe96d9c489cd9a226502d`（2026-10-26 02:36:34 +0800） |
| 切片档位 | **A 档**：只动 `docs/**` 与 `tests/**`，零行为改动 |
| 机读钉子 | `tests/unit/community-premoderation-invariants.test.mjs`（6 条，`node:test`） |
| 取证方式 | **只读**源码 / 契约 / 既有单测；**未连真库、未跑集成用例**（见 §5） |
| 结论性质 | 钉的是**当前口径**；口径一变，钉子**应当红**（见 §4） |

## 1. 现状四档

### 1.1 已实现（有代码路径，且已被既有测试或本次钉子覆盖）

| 功能点 | 关键行号 | 说明 |
| --- | --- | --- |
| 状态闭集是 PG 枚举 | `services/api/db/migrations/0001_initial_schema.sql:25-26` | `visibility` 四值 / `audit_state` 四值；**不是 CHECK 约束**，所以闭合性由枚举类型保证，改值要写迁移 |
| `community_posts` 两列非空 | `services/api/db/migrations/0022_community_persistence.sql:62-78` | `visibility` / `audit_state` 均 `NOT NULL`，无默认值 ⇒ **每条写入都必须显式给状态** |
| 发帖两步（第一步：落待审） | `services/api/src/community/service.ts:1066-1067` | `visibility: awaitingPublish ... ? 'private' : 'published'`、`audit_state: ... ? 'pending' : 'approved'` |
| 发帖两步（第二步：同请求内 publish） | `services/api/src/community/service.ts:1081-1092` | 先 `store.insertPost`（`:1073-1077`），再 `link.publish(...)`，然后**回读**内容行当返回值 |
| 改帖两步（同口径，第二处落点） | `services/api/src/community/service.ts:1197-1198`、`:1203-1222` | 新 revision 必须重送审：先 `commitPostIfCurrent` 落待审，再 `link.publish` 这**个新 revision** |
| 投稿面路由级门 | `services/api/src/routes/community.ts:212-220` | `POST /community/posts` 的 `preHandler: postingPreHandlers(...)`（功能开关 + 投稿同意门）在**服务层之前** |
| 下架（发布后） | `services/api/src/routes/admin.ts:416-424` | `POST /admin/posts/:id/hide`，scope `sources:write`；服务层做可见性 CAS 到 `hidden` |
| 作者侧状态文案（小程序三页） | `miniprogram/pages/community/community.js:190-192`、`miniprogram/pages/communitydetail/communitydetail.js:173-176`、`miniprogram/pages/communitycreate/communitycreate.js:99-108` | 通过 ⇒ 空串或「已通过先行审核」；下架 ⇒「已下架（仅本人可见）」；**其余（含 `pending` 与 `rejected`）⇒「待审／未公开」** |

### 1.2 半落地（有代码，但离「先审后发」的完整语义还差一截）

| 功能点 | 关键行号 | 差在哪 |
| --- | --- | --- |
| 审核域联动注入 | `services/api/src/app.ts:1257-1271` | 默认装配会注入 `moderation` 端口；但**审核域自身未接线**时 `screen === null`，两步退化成一歩（直接 `published` / `approved`）。真正停在待审的现实路径只剩「带媒体且审核域仍有任务」 |
| 服务层兜底门 `gateCommunityService` | `services/api/src/admin/ops/flag-gate.ts:672`、`:684` | 装饰器写好了（返回 `Object.freeze` 副本），但**应用装配零调用** —— 当前投稿面只有**路由级**门，服务层没有第二道 |
| `audit_state.rejected` | `services/api/db/migrations/0001_initial_schema.sql:26` | 枚举里有这个值，但内容行上**永远不会出现**：驳回时内容行根本不落库（见 §3 ①），所以没有「一条被驳回的记录」这种东西 |

### 1.3 只有契约 / 只有定义

| 功能点 | 关键行号 | 说明 |
| --- | --- | --- |
| `/admin/posts` 下唯一 path | `packages/contracts/openapi.json:11584` | 全 spec 89 条 path 里，含 `/admin/posts` 的**只有** `/admin/posts/{id}/hide`（`operationId: hidePost`）；**没有**列表、没有通过、没有驳回 （⚠ 本行陈述与本版实测不符，见 docs/verification/gy-r68-aa-admin-disable-20261027.md §已知陈旧陈述）|
| 人审动作 operation | `services/api/src/admin/ops/service.ts:210-224` | 后台 operation 闭集 `OPS_OPERATION_IDS`（`:211-224`，注释 `:210` 自称「恰好 12 个」、实测共 **12 项**）里，**与社区内容相关的只有** `hidePost`（`:221`，第 10 项）；其后两项 `listAdministrators`／`listAdministratorScopes`（`:222-223`）是管理员权限读面，不碰内容。故「闭集只到 `hidePost`」的说法不准：它**不是末项**，而是末一个碰内容的项 —— **没有**通过／驳回／下架理由这类人审动作；`OPS_SCOPES`（`:227-241`）同理，`hidePost` 只映射到 `sources:write` |

> 「只有契约、没实现」这一档**本次核对为空**：社区人审相关的契约面只有一条已经实现的
> `/admin/posts/{id}/hide`，没有残留的「写了契约但没人接」的接口。真正空的是**相反方向** ——
> 实现与人审流程所需的读面/动作在契约里**根本不存在**（见 §1.4），所以后台连「拉队列」都无从下手。

### 1.4 完全没有

| 功能点 | 可核判据 | 后果 |
| --- | --- | --- |
| 人工「通过」operation | 契约 `/admin/posts` 只有 hide（§1.3）；`services/api/src/routes/admin.ts:416-424` 只有一个注册点 | 没有"人点头才发"的动作；放行只可能来自审核域自动判定 |
| 人工「驳回」operation | 同上；另 `services/api/src/community/service.ts` 的 `refusal(...)` 只在**落库前**用（`:1168-1171` 等），不是事后动作 | 不存在"把已发布内容驳回"的路径 |
| 后台审核列表 / 通过 / 驳回 UI | `apps/admin/src/views/ReviewPlaceholderView.vue:5-8`、`:92-96` | 占位页明写**不发起任何网络请求**；数据只来自 `apps/admin/src/lib/review-state.mjs` 的冻结常量 |
| 后台人审队列（服务端） | `services/api/src/moderation/nonbypass.ts:161-168` | `humanReviewQueue()` 恒 `items: []` |
| 人审目录（服务端） | `services/api/src/admin/human-review.ts:68-89` | 四个集合全 `Object.freeze([])`，`wired: false` |
| 作者可见的「已驳回」态 | 小程序三页全文（§1.1 末行）无 `已驳回` 文案、无 `audit_state === 'rejected'` 分支 | 被驳回时作者只看到「待审／未公开」——**不被告知被驳回**，也不会收到通知（内容行没落库，没有可通知的对象） |
| 收藏覆盖社区 | `services/api/src/favorites/types.ts:24`、`:74-76` | 闭集只有 `species` / `herbicide` / `scheme`；判定函数由该常量派生；收藏子域**不认识**帖子/评论 |

## 2. 本切片钉了什么（6 条，逐条可独立失败）

| # | 钉子 | 判据位置 | 什么改动会让它红 |
| --- | --- | --- | --- |
| 1 | `/admin/posts` 只有 hide 一条 path，`operationId` 是 `hidePost` | 数 `packages/contracts/openapi.json` 的 `paths` 键（**不是** grep 关键词） | 契约新增任何 `/admin/posts/...` 人审 path；改 hide 的名字或 method |
| 2 | 发帖/改帖**两处**都先落 `private` + `pending`，同请求内再 publish | `services/api/src/community/service.ts` 的 `:1052`/`:1066-1067`（createPost）与 `:1188`/`:1197-1198`（editPost）三行逐字 + 调用顺序 | 初始写入改回 `published`/`approved`；`awaitingPublish` 恒置 `false`；两步顺序颠倒；**只改一处** |
| 3 | 收藏闭集不含 `post` / `comment` | `services/api/src/favorites/types.ts:24` 逐字 + `:74-76` 派生关系 + 子域内无带引号字面量 | 把帖子/评论加进收藏闭集（哪怕只加在别处的字面量） |
| 4 | 后台人审占位页仍是**结构性零**（不发请求） | `apps/admin/src/views/ReviewPlaceholderView.vue` 全文，扫**真调用形态**而不是 `api.` 关键词 | **预期会红**：实现人审后台时这一页必然开始拉数据（见 §4） |
| 5 | 小程序三页仍写「待审／未公开」，且**没有**「已驳回」态 | 三个 `.js` 的具体行（`:192` / `:176` / `:106`）＋详情页 `:173` 的语序相反的公开侧标签 | 改写作者侧状态文案；**补上**「已驳回」独立态；行号漂移 |
| 6 | 服务层兜底门 `gateCommunityService` **未装配** | 扫 `services/api/src` 全树：引用它的文件恰好只有 `flag-gate.ts`；`services/api/src/app.ts` **零出现**；测试侧唯一调用点是 `tests/unit/admin-flag-gate.test.mjs` | 任何装配（app.ts import/调用、新 bootstrap、路由注入）；或把装饰器掏空成空壳 |

钉子的设计取舍（写在测试文件头注释里，此处复述要点）：

- **只用严格相等**（`assert.equal` / `assert.deepEqual`）。放宽成 `includes` / `>=` / 模糊正则，
  缺口钉子就退化成橡皮图章。
- **不 import 被测模块**：要测的是「文件还在、内容有没有被换掉」，import 式断言会跟着新实现一起绿。
- **第 6 条是白名单式文本判据，有四个已知盲区**（也写在测试注释里）：
  ① 只扫 `services/api/src`，从 `tools/` / `scripts/` / `apps/` / `deploy/` 侧装配会漏；
  ② 只把 `app.ts` 当唯一装配点，新建 bootstrap 模块会漏；
  ③ 符号改名即假红；
  ④ 拼字符串动态取用（`gate['gateCommunity' + 'Service']`）绕过文本扫描。
  它证明的是「**这个符号**在**这个目录**里没有被引用」，不是「投稿面绝对没有兜底门」。

## 3. 三处容易被说错的地方（本次核对后的更正）

1. **驳回时内容行**不落库**，因此没有「被驳回的记录」。** 驳回发生在落库**之前**：
   发帖在 `services/api/src/community/service.ts:1029-1030`、改帖在 `:1169-1170`，
   都是 `await recordRefusalVerdict(...)` 后立刻 `throw refusal(...)`（判定器定义在 `:359`），
   写库调用（`:1073` / `:1203`）在它们**后面**。所以 `community_posts` 里查不到
   `audit_state = 'rejected'` 的行；也**没有通知对象**可发。把「驳回」想成「先发出去、后被打回」是错的。
2. **`community.js` 里没有「已通过先行审核」这个字面量。** 列表页作者侧通过态是**空串**
   （`miniprogram/pages/community/community.js:190-192`）；该文案只出现在
   `miniprogram/pages/communitydetail/communitydetail.js:173`（公开侧 `publicLabel`）与
   `miniprogram/pages/communitycreate/communitycreate.js:106`（发帖 toast）。
   另注意详情页公开侧是「**未公开／待审**」，语序与作者侧「待审／未公开」**相反**。
3. **两步状态有第二处落点：改帖（`editPost`）。** 之前只登记了发帖；
   `services/api/src/community/service.ts:1188` 与 `:1197-1198` 是同一套三元组（新 revision 重送审）。
   只钉发帖会漏掉「发帖待审、改帖直接发」这条旁路 —— 所以钉 2 钉的是**两处**。
4. 顺带登一句**注释漂移**（不影响行为，但会误导后来人）：
   `miniprogram/pages/communitycreate/communitycreate.js:99-101` 的注释里写的交叉引用行号已过期
   （它指向 `communitydetail.js:105` / `:106-108` / `community.js:130-133`，实测分别在
   `:173` / `:174-176` / `:190-192`）。本切片**不改**小程序（A 档边界），只在此登记。

## 4. 什么时候会红（预期红，不是回归）

| 钉子 | 已知会红的改动 | 同一次改动里必须一起翻转的东西 |
| --- | --- | --- |
| 钉 4 | 任何「人审后台真的开始读队列」的实现 | 先加契约读面 + 服务层队列，再改本钉子的期望值；并翻转 `apps/admin/src/lib/review-state.mjs` 的 `REVIEW_COUNT` 与 `tests/unit/admin-ui-review-state.test.mjs:38-44` |
| 钉 1 | 新增 `GET /admin/posts`（队列读面）、`POST /admin/posts/{id}/approve` / `reject` | `packages/contracts/operations.json`、`services/api/src/admin/ops/service.ts:210-224` 的 operation 闭集、`apps/admin` 的「结构性零」自陈 |
| 钉 5 | 小程序补「已驳回」独立态 | 需先确认后端是否把结论告诉作者（当前：不告诉），否则 UI 无数据可显示 |
| 钉 2 / 3 / 6 | 真正实现人工审核、或把社区纳入收藏、或给服务层加兜底门 | 各自对应证据页章节与测试头注释里的「翻转提示」 |

## 5. 未验证 / 本页不覆盖（明确边界）

- **未跑真库**：`private`/`pending` → `published`/`approved` 的实际提交序列、事务边界、失败回滚，
  本页只有**源码级**证据（`:1073-1092` / `:1203-1222` 的调用顺序与回读），**没有数据库侧观测**。
- **审核域联动是否在线**未在运行时验证：`screen === null` 的降级分支依赖审核域自身的接线状态，
  本页只能引用装配点（`services/api/src/app.ts:1257-1271`），不能断言生产默认值。
- **带媒体帖真能停在 `pending`** 未端到端验证：小程序的图片上传被刻意关掉
  （`miniprogram/pages/communitycreate/communitycreate.wxml:65` 自陈「本页不提供图片上传」），
  所以这条「唯一能停在待审」的现实路径在**当前客户端**上几乎到不了。
- **未逐文件通读** `apps/admin/**` 与小程序 WXML 全集；本页只核了与本主题相关的视图与三个页面。
- **未实测** `effectiveState` / `domainWithholdingOf` 的运行时降级行为（本轮只读代码）。
- **下架的审计落点未逐行核实**：`services/api/src/admin/ops/service.ts:1028` 的注释自陈
  「内存台账照旧记一行…库内审计由端口在**同事务**写入」，但端口侧实现本轮没读到 ——
  所以本页**不主张**下架理由到底是只进内存台账、还是也落库。
- 本页所有行号以基线 `f6c5866d` 为准（**该提交至今被钉文件未变，故对立项基线同样有效**）。
  验证（2026-10-26 实测）：`git diff --stat f6c5866d HEAD -- services/ apps/ miniprogram/ packages/`
  **输出为空** —— 服务端、后台、小程序、契约四处自 `f6c5866d` 以来零改动，
  故 §1 / §3 的行号在 `f6c5866d` 与合入时 main（`2a647fe4`）上指向同一段文字。
  钉子文件自带行号漂移断言，但**本页正文**的行号靠人工核对，
  没有自动化守护 —— 改上面那些文件时请顺手核对 §1 / §3 的行号。

## 6. 复现

```bash
# 1. 六条钉子（单跑）
node --test tests/unit/community-premoderation-invariants.test.mjs

# 2. 本页行号引用仍可解析（--strict：不允许基线之外的新增）
node tools/verify-doc-anchors.mjs --strict

# 3. 契约台账锚点与中文对照表
node tools/verify-contract-status.mjs

# 4. 文档结构（链接、表格列数、U+FFFD、研究记录）
npm run test:docs
```

四条命令在本切片完成时均 **exit 0**；逐行实测输出记录在本次交付报告里（仓外，
`E:\GengYunCommander\.pg17\tmp\deliver-community-premod-pins.md`）。本页只钉**判据**，
不复制那四份输出 —— 避免同一段文字两处维护、各自过期。

### 6.1 门禁读数的口径（2026-10-26 补注）

命令 2 的 `SCAN:` 行是 `node tools/verify-doc-anchors.mjs` 的**全仓累计值**（文档份数 / 抽出引用条数），
随提交单调变化；真正要钉的是「**同一提交上 exit 0**」，份数与条数只是旁证。四个提交各有一份读数，
**不可混成一个**：

| 树 | `SCAN:` 读数 |
| --- | --- |
| `f6c5866d`（本页基线） | 文档 290 份 / 引用 5218 条 |
| `f6c5866d` + 本页（＝仓外报告实测的那棵树） | 文档 291 份 / 引用 5250 条 |
| `78c12c4e`（本页合入前一刻的 `origin/main`，本页不在其上） | 文档 **292 份 / 5362 条** |
| `2a647fe4`（本页合入后） | 文档 **293 份 / 5394 条** |

故本页的读数是「**加入前 292 份 / 5362 条 → 加入后 293 份 / 5394 条**」，差值 **+1 份 / +32 条就是本页自身**
（`git diff --stat 78c12c4e 2a647fe4 -- docs/` 显示该区间只新增本页 150 行）。
「291 份 / 5250 条」是「**旧树 + 本页**」的读数：它比 292 份 / 5362 条少 1 份 / 少 112 条，
少的是 `f6c5866d..78c12c4e` 之间合入的其它文档页与其引用 —— 它既不是「本页加入前」的数，也不是今天的数。
评审记录里若还见到「292 份 / 5334 条」：**本页未复现该数**（同一份数、条数差 28），按上表它只能来自另一棵基线，
与本页的加入前/后**不是**同一对。
⛔ 三个口径互不替代：新增一页文档会让**份数 +1**，新增一条完整「路径:行号」引用会让**条数 +1**
（两者都实测过：把本页从 `f6c5866d` 树里加进去就是 +1 份 / +32 条），所以这行数字必然随 PR 漂移 —— 复算请跑命令。
复现：在对应提交的干净树上跑同一条命令即可（本机实测用 `git worktree add --detach` 各起一棵树）：

```bash
node tools/verify-doc-anchors.mjs        # 不带 --strict，会打印 SCAN: 行
```
