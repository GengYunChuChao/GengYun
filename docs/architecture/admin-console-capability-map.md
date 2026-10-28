# 后台（apps/admin）能力现状：已挂端点、真实调用与缺口

> 基线：`68dec742`（2026-10-26 重测；`#640` 以 squash `2bfec9d3`、`#641` 以 `68dec742` 合入后）。本页所有「文件:行号」都以该提交为准；社区审核队列页（原分支 `feat/gy-r62-admin-moderation-queue`）已随之合入，不再单列。
> **计数口径（先读这条，否则数字对不上）**：`packages/contracts/openapi.json` 中以 `/admin` 开头的 path 共 **36** 条，展开成 **45** 个 operation；其中 **44** 个的 `x-scope` 落在 `AdminScope.enum` 闭集（13 项）内，另 **1** 个是 `loginAdmin`（`POST /admin/auth/session`，`x-scope: public`）——它是登录入口，不持任何后台权限，**任何口径下都不计入**。
> **本页路由与入口的读数以机器重算为准**（`node tools/verify-admin-capability-map.mjs`，CI 在 `contract` job 里跑 `npm run verify:capability-map`）：`services/api/src/routes/admin.ts` 逐条注册 **46** 条路由（24 条家族路由 + 22 条显式路由），对应 46 个 operationId；`apps/admin/src` 对其中 **46** 个 operation 全部有调用链入口，**无入口 0 条**（原本仅剩的 `grantAdministratorScope`、`revokeAdministratorScope` 两条授/撤权写面已由 GY-R68 接上 `AdministratorsView.vue`，取证见 §4）。逐条数字见 §0 末尾的标记块——**块内是闸门保护的实时值，块外散文不受保护**。
> 上一段 `openapi.json` 的「36 条 path／45 个 operation／44 个 x-scope」是契约口径的**手工读数，本行未纳入闸门**（脚本只读 `admin.ts`、`admin/families.ts` 与 `apps/admin/src`，不数 `openapi.json`；要把这几个数也钉住，得另加一条契约侧的重算）。旧版本这里写「只数 42 条＝逐条注册的路由数、本页每个 42／30 都要 +2」，那组数字已被代码证伪（实测 46 条路由、46 个 operation、无入口 2 条），只在 §8 留作历史记录。
> 口径：只写从代码里读得到的结构性事实，**不是运行验收**。PROVIDER 接线未连库验证；凡「未接线 / 503」都限定在**缺省装配**（stub，或 `real` 但没拿到库池）这一分支，装配判据见 `services/api/src/app.ts:1332`。
> 可复跑：`node tools/verify-doc-anchors.mjs --strict`、`node tools/verify-contract-status.mjs`、`npm run test:docs`。

## 0 一页结论

| 面 | 现在的事实 | 锚点 |
| --- | --- | --- |
| 服务端 admin 端点 | **46 条注册路由，对应 46 个 operationId**（机器重算，见 §0 末尾标记块；旧版写 42 是陈旧手数）。页首「闭集 44」那套是契约口径的手数，本行未纳入闸门 | services/api/src/routes/admin.ts:198-487 |
| 前端真实调用 | **46 个 operation 里 44 个有 UI 入口（无入口 2 条）**，机器重算，见标记块。旧版手数的「30 个 operation、33 处物理调用点」是 2026-10-26 的读数，本行未纳入闸门 | apps/admin/src/lib/admin-content-api.mjs:409 |
| 页面 | 19 个 `.vue`（壳 `App.vue` 1 + 主 tab 视图 10 + 子页 6 + 子组件 2）；「社区审核队列」已接入读 + 通过/驳回，「人工审核」仍是空占位 | apps/admin/src/App.vue:27-38 |
| 死按钮 | 0 个；另有 6 个「详情/编辑」link 按钮自身无 handler，靠父行点击冒泡生效 | apps/admin/src/views/SourcesView.vue:469 |
| 后端有面、UI 无入口 | **0 个 operation**：原本仅剩的两条授/撤权写面 `grantAdministratorScope`、`revokeAdministratorScope`（`POST`／`DELETE /admin/administrators/{id}/scopes…`，门 `scopes:write`）已由 GY-R68 接上 `AdministratorsView.vue`。旧版写「12 个，只剩两族：注册资料 6、限制资料 6」，已被代码证伪——两族各有页面，见 §4 | services/api/src/routes/admin.ts:408-427 |
| 鉴权 | 登录响应**不含** scopes；9 个页面登录后再读一次 `GET /admin/auth/session` 补 scope | apps/admin/src/auth/session.ts:128 |
| 两端都缺 | 「人工审核」工作台（审核人 / 投票 / 专家认证）：`ReviewPlaceholderView` 仍是空态说明页、服务层 `wired:false`。**帖子级**人工通过/驳回已不是缺口：`approvePost`/`rejectPost` 自 S3 起在契约内且有路由与页面（§1.1、§2.1） | apps/admin/src/views/ReviewPlaceholderView.vue:2-16 |

<!-- admin-capability-map:begin -->
> 本块由 `node tools/verify-admin-capability-map.mjs --update` 从源码重算生成（解析 `services/api/src/routes/admin.ts`、`services/api/src/admin/families.ts` 与 `apps/admin/src`），`npm run verify:capability-map` 在 CI 的 `contract` job 里**把整个块逐字节比对**（统一行尾与前后空白后，前言段、读数表、逐 operation 表、族表全在比对范围内），块内手改即红。**块外的散文不受本闸门保护。** ⚠ **`noUiEntry` 只是缺口下界**：入口判据是「视图 import 的客户端函数体里带着这条 operation 的 method+path 证据」，**文本里出现过一次调用就算入口**——哪怕那个函数只在永不被调用的死代码里被调一次（变异实测 `noUiEntry 2→1`，能力没变）；所以 `noUiEntry === 0` 不等于「能力齐」，只等于「扫描器没看见缺口」。

**读数（operation 级）**——`withUiEntry` / `noUiEntry` 数的是 operation，不是族：

| 读数 | 值 |
| --- | --- |
| totalOps | 46 |
| families | 13 |
| withUiEntry | 46 |
| noUiEntry | 0 |
| deadButtons | 0 |
| operationsWithEvidence | 46 |
| uiEntryViews | 14 |
| uiRefFiles | 27 |
| unreachableViews | 0 |
| familyOps | accounts=2,administrators=6,audit-events=1,audit-logs=1,categories=2,feature-flags=2,flag-audit-events=1,jobs=2,knowledge=6,posts=5,registrations=6,restrictions=6,sources=6 |
| noUiEntryList | （空） |
| deadButtonList | （空） |

**无 UI 入口的 operation（逐条）**——由「被视图 import 且真的调用、且函数体内带着这条 operation 的 method+path 证据」判定；族级「有人引用过这个前缀」不算入口：

（空）46 条 operation 全部有入口。

**族级汇总**——下表按路径族聚合（同族多条 operation 共用一条路径前缀），只供概览；逐 operation 的入口结论以上两张表为准：

| 路径族 | 路径 | operation 数（族级汇总） | scope | 有入口的视图（族级并集） | 引用文件数 |
| --- | --- | --- | --- | --- | --- |
| accounts | /admin/accounts | 2 | accounts:read / accounts:suspend | apps/admin/src/views/AccountsView.vue | 4 |
| administrators | /admin/administrators | 6 | scopes:read / scopes:write | apps/admin/src/views/AdministratorsView.vue | 3 |
| audit-events | /admin/audit-events | 1 | audit:read | apps/admin/src/views/AuditEventsView.vue<br>apps/admin/src/views/CategoriesView.vue<br>apps/admin/src/views/KnowledgeAdminView.vue<br>apps/admin/src/views/RegistrationAdminView.vue<br>apps/admin/src/views/RestrictionAdminView.vue<br>apps/admin/src/views/SourcesView.vue | 4 |
| audit-logs | /admin/audit-logs | 1 | audit:read | apps/admin/src/views/AuditLogsView.vue | 1 |
| categories | /admin/categories | 2 | sources:read / sources:write | apps/admin/src/views/CategoriesView.vue | 4 |
| feature-flags | /admin/feature-flags | 2 | flags:read / flags:write | apps/admin/src/views/FlagsView.vue | 2 |
| flag-audit-events | /admin/flag-audit-events | 1 | flags:read | apps/admin/src/views/FlagAuditView.vue | 1 |
| jobs | /admin/jobs | 2 | jobs:cancel / jobs:read | apps/admin/src/views/JobsView.vue | 1 |
| knowledge | /admin/knowledge | 6 | sources:read / sources:write | apps/admin/src/views/KnowledgeAdminView.vue | 4 |
| posts | /admin/posts | 5 | sources:read / sources:write | apps/admin/src/views/ModerationQueueView.vue<br>apps/admin/src/views/PostTakedownView.vue | 3 |
| registrations | /admin/registrations | 6 | sources:read / sources:write | apps/admin/src/views/RegistrationAdminView.vue | 4 |
| restrictions | /admin/restrictions | 6 | sources:read / sources:write | apps/admin/src/views/RestrictionAdminView.vue | 4 |
| sources | /admin/sources | 6 | sources:read / sources:write | apps/admin/src/views/KnowledgeAdminView.vue<br>apps/admin/src/views/SourcesView.vue | 4 |
<!-- admin-capability-map:end -->

## 1 服务端已挂的 admin 端点（46 条）

operationId 全集由 `ADMIN_HTTP_OPERATION_IDS` 导出，共 **46** 个（`FAMILIES.flatMap` 展开 24 个 + 显式列出 22 个），与 `app.get/post/put/patch/delete` 逐条数出的 46 处注册一一对应——这个等式由 `tools/verify-admin-capability-map.mjs` 每次跑都核对。文件头自述「46 个 operationId」与实测一致；本页旧版写的「40 个／42 处」是陈旧手数。

### 1.1 按域分组

本表的明细（每个族、每条 operation 的 method／path／scope／入口视图／引用文件）已改为**机器重算**，见 §0 末尾标记块里的「路径族」表与工具默认输出（`node tools/verify-admin-capability-map.mjs`）——本页不再手抄第二份，避免两处读数各自腐烂。下面只留两条手写的事实与口径说明，它们不随重算变化：四类「资料」共用同一组 scope：文件名与 operationId 逐条写在 `services/api/src/admin/families.ts:122-216`；`hidePost` 借用 `sources:write` 是契约级粒度问题，前端只能如实标注（`apps/admin/src/views/PostTakedownView.vue:52`）。帖子读面与审核动作同理：契约给的是 `sources:read`（两个读面）与 `sources:write`（下架 + 通过/驳回），没有独立的 `posts:*` scope，页面只能按契约标注。

### 1.2 四条只在缺省装配（stub / real 无池）下 503 的端点

装配判据在 `services/api/src/app.ts`：`const adminRealUnwired = config.executionMode === 'real'`（`services/api/src/app.ts:1332`），端口只在「`real` 且确实拿到库池」时构造——作业 `services/api/src/app.ts:1354-1356`，审计总台账 `services/api/src/app.ts:1492-1493`（其上 `services/api/src/app.ts:1485-1491` 的注释写明：只在确实拿到库池时构造只读端口，`pool === null` ⇒ 端口 null ⇒ `/admin/audit-logs` 保持 503）。所以下表描述的是**未注入端口且没有库池**这一缺省分支；`real` + 有池的生产装配端口已接，503 不适用。

| 端点 | 缺省分支的现状 | 锚点 |
| --- | --- | --- |
| GET /admin/audit-logs（listAuditLogs） | 端口为 null ⇒ 503 PROVIDER_UNAVAILABLE，不返回空页 | services/api/src/routes/admin.ts:295-299；services/api/src/app.ts:1485-1493 |
| GET /admin/jobs、POST /admin/jobs/{id}/cancel | 端口不构造 ⇒ 读与写都 503 | services/api/src/routes/admin.ts:377-390；services/api/src/app.ts:1354-1356 |
| POST /admin/posts/{id}/hide | 只有真实持久的社区帖子端口才放行（`hidePostWired`），内存实现恒 false ⇒ 503 | services/api/src/routes/admin.ts:430-438；services/api/src/app.ts:1310-1311、services/api/src/app.ts:1548 |
| GET /admin/posts、GET /admin/posts/{id}、POST /admin/posts/{id}/approve、POST /admin/posts/{id}/reject | 后台帖子读面端口与运营审核端口未接线 ⇒ 服务层 503 PROVIDER_UNAVAILABLE，路由层不返回空页、也不伪造审核成功 | services/api/src/routes/admin.ts:450-487 |

## 2 前端真实调用了哪些端点

### 2.1 客户端方法 → 路径（`apps/admin/src/lib/`；本表未纳入闸门，逐条路径与文件以工具输出为准）

| operationId | 客户端方法 | 方法与路径 | scope |
| --- | --- | --- | --- |
| listAdminSources | listSources（apps/admin/src/lib/admin-content-api.mjs:409） | GET /admin/sources | sources:read |
| getAdminSource | getSource（apps/admin/src/lib/admin-content-api.mjs:413） | GET /admin/sources/{id} | sources:read |
| createSourceDraft | createSource（apps/admin/src/lib/admin-content-api.mjs:417） | POST /admin/sources | sources:write |
| editSourceDraft | editSource（apps/admin/src/lib/admin-content-api.mjs:431） | PATCH /admin/sources/{id} | sources:write |
| publishSource | publishSource（apps/admin/src/lib/admin-content-api.mjs:447） | POST /admin/sources/{id}/publish | sources:write |
| withdrawSource | withdrawSource（apps/admin/src/lib/admin-content-api.mjs:464） | POST /admin/sources/{id}/withdraw | sources:write |
| listAdminKnowledge | listKnowledge（apps/admin/src/lib/admin-content-api.mjs:482） | GET /admin/knowledge | sources:read |
| getAdminKnowledge | getKnowledge（apps/admin/src/lib/admin-content-api.mjs:486） | GET /admin/knowledge/{id} | sources:read |
| createKnowledgeDraft | createKnowledge（apps/admin/src/lib/admin-content-api.mjs:490） | POST /admin/knowledge | sources:write |
| editKnowledgeDraft | editKnowledge（apps/admin/src/lib/admin-content-api.mjs:504） | PATCH /admin/knowledge/{id} | sources:write |
| publishKnowledge | publishKnowledge（apps/admin/src/lib/admin-content-api.mjs:520） | POST /admin/knowledge/{id}/publish | sources:write |
| withdrawKnowledge | withdrawKnowledge（apps/admin/src/lib/admin-content-api.mjs:537） | POST /admin/knowledge/{id}/withdraw | sources:write |
| listAdminCategories | listCategories（apps/admin/src/lib/admin-content-api.mjs:555） | GET /admin/categories | sources:read |
| editCategory | editCategory（apps/admin/src/lib/admin-content-api.mjs:559） | PATCH /admin/categories/{id} | sources:write |
| listAdminUsers | fetchAccountsPage（apps/admin/src/lib/admin-api.mjs:153） | GET /admin/accounts | accounts:read |
| suspendUser | suspendAccount（apps/admin/src/lib/account-suspend-api.mjs:138） | POST /admin/accounts/{id}/suspend | accounts:suspend |
| listFlags | fetchFlagsPage（apps/admin/src/lib/flags-api.mjs:224） | GET /admin/feature-flags | flags:read |
| setFlag | putFlag（apps/admin/src/lib/flags-api.mjs:288） | PUT /admin/feature-flags/{key} | flags:write |
| listFlagAuditEvents | fetchFlagAuditPage（apps/admin/src/lib/flag-audit.mjs:145） | GET /admin/flag-audit-events | flags:read |
| listAuditEvents | fetchAuditEventsPage（apps/admin/src/lib/audit-events.mjs:360）；findAuditEventsForRequest（apps/admin/src/lib/admin-content-api.mjs:600） | GET /admin/audit-events | audit:read |
| listAdminJobs | listJobs（apps/admin/src/lib/jobs-api.mjs:348） | GET /admin/jobs | jobs:read |
| cancelAdminJob | cancelJob（apps/admin/src/lib/jobs-api.mjs:414） | POST /admin/jobs/{id}/cancel | jobs:cancel |
| hidePost | hidePost（apps/admin/src/lib/post-takedown-api.mjs:390） | POST /admin/posts/{id}/hide | sources:write |
| listAdminPosts | fetchModerationQueuePage（apps/admin/src/lib/admin-moderation-queue.mjs:552） | GET /admin/posts | sources:read |
| getAdminPost | fetchAdminPostDetail（apps/admin/src/lib/admin-moderation-queue.mjs:623） | GET /admin/posts/{id} | sources:read |
| approvePost | submitPostReview（apps/admin/src/lib/admin-moderation-queue.mjs:798） | POST /admin/posts/{id}/approve | sources:write |
| rejectPost | submitPostReview（apps/admin/src/lib/admin-moderation-queue.mjs:798） | POST /admin/posts/{id}/reject | sources:write |

写面请求头不是页面各自拼的：`writeFamilyResource` 统一要求 `Idempotency-Key`，非 POST 或带 action 时还要 `If-Match`（`apps/admin/src/lib/admin-content-api.mjs:307-406`，头部校验落在其中 325-336 行）。两个审核 POST 不走 `writeFamilyResource`：它们复用下架页已有的 `buildIfMatch` / `normalizeIdempotencyKey`（`apps/admin/src/lib/post-takedown-api.mjs`），请求构造函数在 `apps/admin/src/lib/admin-moderation-queue.mjs:698`。

### 2.2 视图侧调用点（33 处 / 30 个 operation —— 本表未纳入闸门）

| 页面（行数） | 调用点：operationId@行 | 计数 |
| --- | --- | --- |
| apps/admin/src/views/AccountsView.vue（649） | listAdminUsers@64、suspendUser@162 | 2 |
| apps/admin/src/views/AdministratorsView.vue（622） | listAdministrators@74、listAdministratorScopes@146 | 2 |
| apps/admin/src/views/AuditLogsView.vue（627） | listAuditLogs@72 | 1 |
| apps/admin/src/views/SourcesView.vue（720） | listAdminSources@135、getAdminSource@165、createSourceDraft@253、editSourceDraft@268、publishSource@294、withdrawSource@320、listAuditEvents@328 | 7 |
| apps/admin/src/views/KnowledgeAdminView.vue（760） | listAdminKnowledge@124、getAdminKnowledge@154、listAdminSources@206、createKnowledgeDraft@257、editKnowledgeDraft@272、publishKnowledge@298、withdrawKnowledge@324、listAuditEvents@332 | 8 |
| apps/admin/src/views/CategoriesView.vue（507） | listAdminCategories@86、editCategory@171、listAuditEvents@179 | 3 |
| apps/admin/src/views/PostTakedownView.vue（351） | hidePost@89 | 1 |
| apps/admin/src/views/FlagsView.vue（595） | listFlags@63、setFlag@147 | 2 |
| apps/admin/src/views/FlagAuditView.vue（546） | listFlagAuditEvents@68 | 1 |
| apps/admin/src/views/AuditEventsView.vue（541） | listAuditEvents@66 | 1 |
| apps/admin/src/views/JobsView.vue（664） | listAdminJobs@80、cancelAdminJob@159 | 2 |
| apps/admin/src/views/ModerationQueueView.vue（888） | listAdminPosts@129、getAdminPost@149、approvePost/rejectPost@303（同一处 `submitPostReview`） | 3 |
| 合计 | 30 个 operation（本表未纳入闸门；机器重算的入口读数是 46 个 operation 里 44 个有入口、2 条无入口，见 §0 标记块） | 33 |

`listAuditEvents` 被 4 处调用（`apps/admin/src/views/AuditEventsView.vue:66`、`apps/admin/src/views/SourcesView.vue:328`、`apps/admin/src/views/KnowledgeAdminView.vue:332`、`apps/admin/src/views/CategoriesView.vue:179`），`listAdminSources` 被 2 处调用（`apps/admin/src/views/SourcesView.vue:135`、`apps/admin/src/views/KnowledgeAdminView.vue:206`），而 `approvePost` 与 `rejectPost` 共用一处 `submitPostReview`（`apps/admin/src/views/ModerationQueueView.vue:303`）；所以 30 个 operation 对应 33 处物理调用点（+3 +1 −1；「处数」按 `<视图,行号>` 去重，不按 operation 去重）。

### 2.3 覆盖差集

46 条服务端 operation 中，UI 有入口的 **46** 条，**没有前端入口的 0 条**（`grantAdministratorScope`、`revokeAdministratorScope` 已由 GY-R68 接上，逐条见 §0 标记块与 §4）。本页旧版这里写「有入口 30 条、其余 12 条完全没有前端入口」，那组数字已被代码证伪：注册资料与限制资料两族各 6 条早已有 `RegistrationAdminView.vue`／`RestrictionAdminView.vue` 走完整调用链（见 §4）。§2.2 那张手表只覆盖 30 个 operation，是因为它按 2026-10-26 的视图快照逐行抄的，未纳入闸门。

## 3 每个后台页面现在能做什么

按钮统计口径：允许 `@click.stop` 等事件修饰符；「死按钮」＝既无自身 `@click`、也不在任何父级点击区（`<tr @click>`、`<form @submit>`）内。

| 视图（行数） | 列表 / 详情 | 写操作与按钮 | 按钮 / 死按钮 | 权限门 |
| --- | --- | --- | --- | --- |
| apps/admin/src/views/AccountsView.vue（649） | 账号列表（游标分页）；行内只有「停用」按钮，无独立详情侧栏 | 停用：确认框必填理由 → POST /admin/accounts/{id}/suspend，成功后就地刷新第一页 | 14 / 0 | accounts:read 读；accounts:suspend 决定「停用」是否可点（apps/admin/src/lib/view-model.mjs:371） |
| apps/admin/src/views/AdministratorsView.vue（622） | 管理员目录（游标分页）+ 行内「查看权限」侧栏（读 `GET /admin/administrators/{id}/scopes`） | **无写操作**：授/收权在契约里没有对应 operation（见 §5.6 的 `scopes:write`） | 9 / 0 | scopes:read（读列表与权限）；无写门可判 |
| apps/admin/src/views/AuditLogsView.vue（627） | 审计总台账只读：游标分页 + `action` / `entity` / 时间范围（`from`、`to`）筛选 + 展开原文 | 无写操作 | 9 / 0 | audit:read |
| apps/admin/src/views/ContentAdminView.vue（292） | 容器：登录表单 + 4 个子 tab（来源 / 科普 / 帖子下架 / 分类） | 无自身业务请求，只下发 baseUrl/token/scopes | 3 / 0 | 无（登录后读会话） |
| apps/admin/src/views/SourcesView.vue（720） | 来源列表 + 详情 + 新建草稿 / 编辑 / 发布 / 下架表单 + 按 request_id 反查审计 | 4 个写操作（创建、编辑、发布、下架）+ 1 个只读反查（`listAuditEvents`） | 20 / 0 | sources:read / sources:write（apps/admin/src/views/SourcesView.vue:80-82） |
| apps/admin/src/views/KnowledgeAdminView.vue（760） | 科普列表 + 详情 + 新建 / 编辑 / 发布 / 下架；发布需挑一条来源（读来源列表辅助） | 同为 4 写（创建、编辑、发布、下架）+ 1 只读反查（`listAuditEvents`） | 22 / 0 | sources:read / sources:write（apps/admin/src/views/KnowledgeAdminView.vue:82-84） |
| apps/admin/src/views/CategoriesView.vue（507） | 分类列表 + 编辑表单 | 只有「保存分类」；**没有新建 / 删除按钮**（契约只有 2 个 operation，页面不造） | 9 / 0 | sources:read / sources:write（apps/admin/src/views/CategoriesView.vue:58-60） |
| apps/admin/src/views/PostTakedownView.vue（351） | 下架表单（帖子 id + 理由） | POST /admin/posts/{id}/hide | 1 / 0 | sources:write（apps/admin/src/views/PostTakedownView.vue:52） |
| apps/admin/src/views/FlagsView.vue（595） | 开关列表 + 行内切换 + 详情侧栏 | PUT /admin/feature-flags/{key}（If-Match + Idempotency-Key） | 12 / 0 | flags:read 读；flags:write 决定可写（apps/admin/src/lib/flags-view-model.mjs:224） |
| apps/admin/src/views/FlagAuditView.vue（546） | 开关变更留痕只读 + 加载下一页 | 无写操作 | 6 / 0 | flags:read |
| apps/admin/src/views/AuditEventsView.vue（541） | 审计事件只读 + 客户端筛选 + 展开原文 | 无写操作 | 6 / 0 | audit:read |
| apps/admin/src/views/JobsView.vue（664） | 作业列表 + 详情 + 取消 | 取消只在 queued / running 行可用，终态行按钮禁用 | 13 / 0 | jobs:read 读；jobs:cancel 决定可取消（apps/admin/src/lib/jobs-api.mjs:713） |
| apps/admin/src/views/ModerationQueueView.vue（888） | 帖子队列（游标分页、`state`/`audit_state` 筛选、去重与成环判断）+ 详情侧栏（正文、审核态、可见性、revision/ETag） | 通过 / 驳回：POST /admin/posts/{id}/approve、POST /admin/posts/{id}/reject（If-Match + Idempotency-Key；`changed:false` 显示「已是该状态」而非假装成功） | 14 / 0 | sources:read 读；sources:write 决定动作（apps/admin/src/lib/admin-moderation-queue.mjs:68-71） |
| apps/admin/src/views/ReviewPlaceholderView.vue（238） | 空态：不发起任何网络请求，不伪造队列与审核人（人审工作流 = 审核人 / 投票 / 专家认证，见 §0 与 §6） | 无 | 0 / 0 | 无 |
| apps/admin/src/views/ContentFieldGrid.vue（138） | 纯子组件（字段网格），无请求 | 无 | 0 / 0 | 无 |
| apps/admin/src/views/WriteReceipt.vue（198） | 纯子组件（写入回执），按钮全部 emit | 无网络请求 | 3 / 0 | 无 |

6 个 link 按钮本身没有 handler，点击命中父行：

| link 按钮（无自身 handler） | 父行 `<tr @click>`（真正的点击源） |
| --- | --- |
| apps/admin/src/views/AuditEventsView.vue:270 「展开原文 / 收起」 | apps/admin/src/views/AuditEventsView.vue:258 |
| apps/admin/src/views/CategoriesView.vue:265 「编辑」 | apps/admin/src/views/CategoriesView.vue:258 |
| apps/admin/src/views/FlagAuditView.vue:266 「展开原文 / 收起」 | apps/admin/src/views/FlagAuditView.vue:255 |
| apps/admin/src/views/KnowledgeAdminView.vue:492 「详情」 | apps/admin/src/views/KnowledgeAdminView.vue:483 |
| apps/admin/src/views/ModerationQueueView.vue:456 「查看详情」 | apps/admin/src/views/ModerationQueueView.vue:444 |
| apps/admin/src/views/SourcesView.vue:469 「详情」 | apps/admin/src/views/SourcesView.vue:461 |

按「有没有点击路径」判，死按钮 0 个；全仓也没有指向空函数的 `@click`——`apps/admin/src/lib/view-model.mjs:450` 的「读面未提供」是如实标注，不是空实现。

## 4 服务端有、UI 完全没有入口（2 条）

**当前 0 条**（机器重算，见 §0 标记块的 `noUiEntry`／`noUiEntryList`）：历史上剩下的两条 `grantAdministratorScope`（`POST /admin/administrators/{id}/scopes`）与 `revokeAdministratorScope`（`DELETE /admin/administrators/{id}/scopes/{scope}`，两条都门 `scopes:write`）已由 GY-R68 接上：客户端在 `apps/admin/src/lib/administrator-scope-api.mjs`，视图 `apps/admin/src/views/AdministratorsView.vue` 每行给出「授权／撤销」按钮、scope 选择器（选项由契约 `AdminScope` 闭集派生）与二次确认，所以 §0 标记块的 `noUiEntryList` 现在是空的。判定口径没变，仍是「operation 级 + 视图真的调用」。本页旧版此处列的是「12 条、只剩两族：注册资料 6、限制资料 6」，并断言 `apps/admin/src` 全树对 `/admin/registrations`、`/admin/restrictions` 的引用数为 0——**那两个断言都不成立**：两族各有路径常量、各有 6 个客户端函数、各有视图与单测（逐条见下表「缺口的可见后果」列的更正值）。下表保留旧读数的位置只为写清错在哪里，**读数以标记块为准**。**「审计总台账」与「管理员权限读面」也不在此表**——它们在 `68dec742` 上各有页面，见本节末的更正记录。

| 域 | 条数 | operation id | 路由 | 缺口的可见后果 |
| --- | --- | --- | --- | --- |
| 注册资料 | 6 | listAdminRegistration、createRegistrationDraft、getAdminRegistration、editRegistrationDraft、publishRegistration、withdrawRegistration | GET / POST /admin/registrations；GET / PATCH /admin/registrations/{id}；POST /admin/registrations/{id}/publish、/withdraw | **旧断言「`apps/admin/src` 全树对 `/admin/registrations` 的引用数为 0」为假**：`apps/admin/src/lib/admin-content-contract.mjs` 定义 `REGISTRATIONS_PATH`，`apps/admin/src/lib/admin-content-api.mjs` 有 6 个客户端函数（`listRegistration`／`createRegistration`／`getRegistration`／`editRegistration`／`publishRegistration`／`withdrawRegistration`），`apps/admin/src/views/RegistrationAdminView.vue` 逐个调用，`apps/admin/src/views/ContentAdminView.vue` 以 tab 装配；引用该路径的文件数由 `node tools/verify-admin-capability-map.mjs` 重算（当前 4 个文件），并有 3 个 `tests/unit/admin-ui-registration-*` 单测在跑 |
| 限制资料 | 6 | listAdminRestriction、createRestrictionDraft、getAdminRestriction、editRestrictionDraft、publishRestriction、withdrawRestriction | /admin/restrictions 同形 6 条 | **旧断言「`apps/admin/src` 全树对 `/admin/restrictions` 的引用数为 0」为假**：同族形状，`RESTRICTIONS_PATH` 在 `apps/admin/src/lib/admin-content-contract.mjs`，客户端函数在 `apps/admin/src/lib/admin-content-api.mjs`，`apps/admin/src/views/RestrictionAdminView.vue` 逐个调用（当前 4 个文件引用该路径），另有 2 个 `tests/unit/admin-ui-restriction-*` 单测 |

**更正记录（2026-10-26，基线 `68dec742`）**：本页旧版把以下两条列为「缺入口」，实测两处都**已有页面**，故从缺口表移除：

| 原缺口 | 实际页面 | 依据（operation → 客户端函数 → 视图调用点） |
| --- | --- | --- |
| 审计总台账 1 条（`listAuditLogs`） | `apps/admin/src/views/AuditLogsView.vue` | `listAuditLogs` → `fetchAuditLogsPage`（`apps/admin/src/lib/admin-audit-logs.mjs:374`）→ 视图调用点 `apps/admin/src/views/AuditLogsView.vue:72`；tab 装配 `apps/admin/src/App.vue:33`、`apps/admin/src/App.vue:81` |
| 管理员权限读面 2 条（`listAdministrators`、`listAdministratorScopes`） | `apps/admin/src/views/AdministratorsView.vue` | `listAdministrators` → `fetchAdministratorsPage`（`apps/admin/src/lib/admin-administrators.mjs:363`）→ `apps/admin/src/views/AdministratorsView.vue:104`；`listAdministratorScopes` → `fetchAdministratorScopes`（`apps/admin/src/lib/admin-administrators.mjs:391`）→ `apps/admin/src/views/AdministratorsView.vue:175`；tab 装配 `apps/admin/src/App.vue:34`、`apps/admin/src/App.vue:82` |

**GY-R68（2026-10-28）更正**：`grantAdministratorScope`（`POST /admin/administrators/{id}/scopes`）与 `revokeAdministratorScope`（`DELETE /admin/administrators/{id}/scopes/{scope}`）两条授/撤权写面已接上 `apps/admin/src/views/AdministratorsView.vue`：每行「授权／撤销」按钮 + scope 选择器（选项由契约 `AdminScope` 闭集派生）+ 二次确认；§0 标记块的 `noUiEntry` 由 2 变 0。

客户端在 `apps/admin/src/lib/administrator-scope-api.mjs`，成功后刷新列表并重读该行 scopes；「停用／恢复」与「授权／撤销」是两条不同的写面（都门 `scopes:write`），别互相顶替。
## 5 鉴权面：身份与权限现在怎么来

1. `apps/admin/src/auth/session.ts` 只存令牌：`sessionStorage` 一条 `gengyun.admin.session`（`apps/admin/src/auth/session.ts:27`），不落盘到别处、不写日志、不进 URL。
2. 登录调 `POST /admin/auth/session`（`apps/admin/src/auth/session.ts:109-114`，必带 `Idempotency-Key`），服务端返回 `access_token / token_type / expires_at / audience / revision`（`services/api/src/auth/service.ts:366-374`）——**没有 scopes**。
3. 因此 `signInAdmin` 返回对象的 `scopes` 硬编码为空数组（`apps/admin/src/auth/session.ts:128`），注释也写「登录响应不含 scope，需再次读取」（`apps/admin/src/auth/session.ts:17`）。
4. 真来源是 `GET /admin/auth/session`：它要 `session:read` 守卫（`services/api/src/routes/admin-auth.ts:90`），把 `listAdminScopes` 的结果塞进 `SessionInfo`（`services/api/src/routes/admin-auth.ts:93-97`），响应体为：

```jsonc
{
  "data": {
    "audience": "admin",
    "expires_at": "<ISO 时间>",
    "scopes": ["<按码元序排序、已去重>"],
    "revision": 1
  },
  "meta": { /* buildMeta 的请求元数据 */ }
}
```

5. `scopes` 的形状与排序在 `services/api/src/auth/service.ts:377-389`；服务端裁决在 `services/api/src/auth/middleware.ts:201-206`，缺 scope 固定回 `SCOPE_DENIED`「缺少所需权限：<scope>」；用户端会话打后台固定被拒（`services/api/src/auth/middleware.ts:110-117`）。
6. scope 闭集 13 项见 `services/api/src/admin/scopes.ts:38-50`；`scopes:write` 已经落写面，声明见 `services/api/src/admin/scopes.ts:88`，以它为门的写操作共 4 个 operationId（授/撤 scope 两个，管理员账号停用/启用两个；写路径仍是迁移 0041 的两个 SECURITY DEFINER 函数与迁移 0048）。
7. 前端把 scope 只当「提前禁用按钮」：9 个页面登录后立刻再读一次 `GET /admin/auth/session`（`apps/admin/src/views/AccountsView.vue:91`、`apps/admin/src/views/AdministratorsView.vue:139`、`apps/admin/src/views/AuditEventsView.vue:98`、`apps/admin/src/views/AuditLogsView.vue:111`、`apps/admin/src/views/FlagsView.vue:88`、`apps/admin/src/views/FlagAuditView.vue:100`、`apps/admin/src/views/JobsView.vue:105`、`apps/admin/src/views/ContentAdminView.vue:41-68`、`apps/admin/src/views/ModerationQueueView.vue:179`）。

缺 scope 的三种可见后果：

| 情形 | 页面表现 | 锚点 |
| --- | --- | --- |
| 账号没有 session:read | 登录成功后读会话 403 ⇒ `loadAdminSession` 返回 null 并清本地令牌，页面停在未登录态报「登录后未能读到会话详情」 | apps/admin/src/auth/session.ts:94；apps/admin/src/views/AccountsView.vue:92-97 |
| 有 session:read、缺业务读 scope | 列表请求 403 SCOPE_DENIED，页面显示服务端错误码原文，不伪造空列表 | services/api/src/auth/middleware.ts:204；apps/admin/src/views/SourcesView.vue:14 |
| 缺业务写 scope | 写按钮禁用 + 页内警示条；服务端仍是最终裁决方 | apps/admin/src/views/SourcesView.vue:366；apps/admin/src/views/PostTakedownView.vue:128 |

## 6 三档结论

| 档 | 判定标准 | 条目 |
| --- | --- | --- |
| 已可用 | 前端有入口 + 服务端有路由，且失败路径如实显示 | **46 条**（机器重算：`totalOps=46`、`withUiEntry=46`、`noUiEntry=0`，逐族清单见 §0 标记块） |
| 后端有余、UI 缺入口 | 服务端有 operation，前端零调用点 | **0 条**（GY-R68 之后：原先仅剩的 `grantAdministratorScope`、`revokeAdministratorScope` 已接上入口；旧版写「注册资料 6、限制资料 6 ＝ 12」，已被代码证伪，见 §4） |
| 两端都缺 | 契约里本就没有写操作；或只在缺省装配（stub / real 无池）下服务层未接线 | 「人工审核」工作台（审核人 / 投票 / 专家认证）仍缺：`ReviewPlaceholderView` 是空态说明页、服务层 `wired:false`（apps/admin/src/views/ReviewPlaceholderView.vue:38-60、services/api/src/admin/human-review.ts:40）；但**帖子级**通过/驳回已随 S3 进契约并有路由与页面（§1.1、§2.1），不再算「两端都缺」；审计总台账与作业的 503 只出现在缺省装配，`real` + 有库池时端口已构造（services/api/src/app.ts:1354-1356、services/api/src/app.ts:1492-1493） |

三档不是验收结论：第一档只表示「调用链与失败路径都在代码里」，没有对真实数据、真实 PROVIDER 或真实权限组合做过运行验证。

## 7 如果要做「后台最小可用」，先补这三件

1. **~~注册资料与限制资料两页（12 个 operation）~~ —— 已落地，不再是缺口**。这两族当时是「12 条无入口」的全部（12/12），服务端四族共用同一批 scope、同一个 `familyOps()` 装配（`services/api/src/routes/admin.ts:184-195`），前端照 `SourcesView` 的既有模式复制即可，不需要新契约、不需要新 scope；现在 `apps/admin/src/views/RegistrationAdminView.vue` 与 `apps/admin/src/views/RestrictionAdminView.vue` 已按这个模式接入（机器重算里这两族 12 条都有入口，见 §0 标记块；剩下的 2 条无入口是下面第 2 条的授/收权写面）。
2. **管理员权限「授/收权」写面（`scopes:write`）**。**订正（GY-R68，A06；2026-10-28 复审后再校口径）**：本条原文写「44 条 operation 零使用」，依据是旧注释里那句「只声明、不实现」——那句话与「零使用」都是旧读数，现已失实（该注释正文现写「**已实现**」，已被本页 §5 第 6 条与 `services/api/src/admin/scopes.ts` 的现状说明取代；本页不再复述它的行号，锚点一律按符号重锚到声明行与门）——服务端**已有 4 条**以 `scopes:write` 为门的写面 operation（`packages/contracts/operations.json` 里 scope=`scopes:write` 的恰好这 4 条）：授/撤 2 条 `grantAdministratorScope`（`POST /admin/administrators/{id}/scopes`）、`revokeAdministratorScope`（`DELETE /admin/administrators/{id}/scopes/{scope}`），加账号状态 2 条 `disableAdministratorAccount`（`POST /admin/administrators/{id}/disable`）、`enableAdministratorAccount`（`POST /admin/administrators/{id}/enable`）。声明与门按符号定位：scope 常量声明在 `services/api/src/admin/scopes.ts:88`（`export const ADMIN_SCOPES_WRITE_SCOPE = 'scopes:write';`）；门值表 `OPS_SCOPES` 的四条在 `services/api/src/admin/ops/service.ts:426`、`services/api/src/admin/ops/service.ts:427`、`services/api/src/admin/ops/service.ts:432`、`services/api/src/admin/ops/service.ts:433`（依次是 `grantAdministratorScope`／`revokeAdministratorScope`／`disableAdministratorAccount`／`enableAdministratorAccount`，四条值都是 `scopes:write`）；对应的四处门在 `services/api/src/routes/admin.ts:411`（`requireScope(OPS_SCOPES.grantAdministratorScope)`）、`services/api/src/routes/admin.ts:420`、`services/api/src/routes/admin.ts:454`、`services/api/src/routes/admin.ts:463`。判别力由 `tests/unit/session-scopes-s1.test.mjs` 的 ③ 三层钉住：门集合存在、以 `scopes:write` 为实参的 `requireScope` 调用条数 = manifest 里该 scope 的 operation 条数、且逐 operationId 仍有那处门（任一处被改值或摘掉即红）。剩下的缺口在**前端**：`apps/admin` 对**授/撤**两条 operation 无任何调用点（`src/lib/admin-administrators.mjs` 只读、`AdministratorsView` 仍只能看），而账号状态两条前端已有写面（`src/lib/administrator-state-api.mjs` 的 `ADMINISTRATOR_STATE_SCOPE='scopes:write'`，停用/恢复入口在 `AdministratorsView`）。前置仍是产品先定「谁能授权管理员」，否则会造出自提权面。
3. **让 scopes 随登录一起到前端（1 处响应或守卫调整）**。理由：现在 9 个页面各抄一遍「登录后再读一次」，且没有 `session:read` 的管理员会直接卡在登录失败；把 scopes 放进登录响应（或允许无 `session:read` 也能读自己的会话）能同时消掉重复代码与这个单点。

「审计总台账」与「管理员权限读面」已落地（页面见 §4 更正记录），不再需要补入口。遗留的只是**装配风险**而非 UI 缺口：`listAuditLogs` 在 `real` + 有库池时只读端口已构造（`services/api/src/app.ts:1485-1493`），只有缺省装配（stub / real 无池）才 503——运维侧确认运行模式即可。**R67-A 口径对齐（2026-10-27）**：审计总台账确有页面消费该读面——`apps/admin/src/views/AuditLogsView.vue:72` 调 `listAuditLogs`（`GET /admin/audit-logs`），导航 `apps/admin/src/App.vue:33`、渲染 `apps/admin/src/App.vue:81`（#633，见 §4 更正记录）；`docs/architecture/ai-ops-spec-status.md` 的 P10 原写「全仓没有页面消费 `GET /admin/audit-logs`」为误，已按本页口径改成真值（三读面读数不合并、页面读数无端到端验收），逐条证据见 `docs/verification/gy-r67-docs-truth-20261027.md`。

## 8 与既有取证、代码注释的差异

| 说法（来源） | 本页复核结果 | 依据 |
| --- | --- | --- |
| 「26 处调用点」（另一份只读取证，未入库；本文以本仓 `apps/admin/src` 的逐行计数为口径） | 本页逐行枚举是 **33 处**、30 个 operation | §2.2 全表 |
| 「AccountsView 有一个无 handler 的死按钮」（同上） | 现基线不成立：该处已是 `</td>`，停用按钮带 `@click.stop="beginSuspend(row)"`，全仓死按钮 0 个 | apps/admin/src/views/AccountsView.vue:356-365 |
| 「登录后 scopes 恒为空导致写入按钮全灭」（同上） | 半过时：`scopes: []` 仍在，但 9 个页面登录后立刻再读会话，按钮不会全灭；真正会全灭的是缺 `session:read` 的账号 | apps/admin/src/auth/session.ts:128；apps/admin/src/views/AccountsView.vue:91 |
| 「登录响应不含 scope」 | 复核成立 | services/api/src/auth/service.ts:366-374 |
| 「15 个 operation 无 UI 入口」（本页旧版自己的结论） | **已过时**：`68dec742` 上实为 12 条；旧版的 15 把「审计总台账 1」「管理员权限读面 2」算了进去，而这两条都已有页面（依据见 §4 更正记录）。**2026-10-28 起机器重算为 2 条**（`noUiEntry=2`，见 §0 标记块），**GY-R68 接上授/撤权写面后重算为 0 条**（`noUiEntry=0`）：注册资料与限制资料两族也已各有页面，12 那条读数同样进了历史；当时剩下的两条 `grantAdministratorScope`／`revokeAdministratorScope` 授/收权写面已由 GY-R68 补上入口（见 §4）。取证报告在 `1a583e1d` 上给出的缺口 16 条同理——它多算了帖子族 4 条，而那 4 条随 `#640` 合入已经有页 | §4；§2.2 全表 |
| 代码内陈旧文案（一） | `apps/admin/src/App.vue:28` 写「账号目录（只读）」、`apps/admin/src/App.vue:95` 写「停用/注销等写操作不在本片」，与实有的停用写面矛盾；`apps/admin/src/auth/session.ts:21` 写「控制台业务页面未实现」，实际 `apps/admin/src/views/` 已有 16 个 `.vue`；`services/api/src/routes/admin.ts:160` 写「注册 40 个后台路由」，实际 46 条（文件头 `services/api/src/routes/admin.ts:4` 的「46 个 operationId」与实测一致；机器重算见 §0 标记块） | 同行号 |
| 代码内陈旧文案（二）：「契约里没有帖子读面／没有任何帖子读面」（`apps/admin/src/views/PostTakedownView.vue:6`、`apps/admin/src/lib/post-takedown-api.mjs:8`、`apps/admin/src/lib/post-takedown-form.mjs:7-8`） | **已不成立**（措辞与事实相反）：契约有 `GET /admin/posts`、`GET /admin/posts/{id}`，路由在 `services/api/src/routes/admin.ts:450`、`services/api/src/routes/admin.ts:455`；页面在 `apps/admin/src/views/ModerationQueueView.vue:129`、`apps/admin/src/views/ModerationQueueView.vue:149`。**本页只记录，不改代码**（属 B 档） | 同行号 |
| 代码内陈旧文案（三）：「契约里根本没有审核队列的读面（path 含 `review` 的数量为 0），`routes/` 也没有任何 review 路由」（`apps/admin/src/views/ReviewPlaceholderView.vue:5-6`、`apps/admin/src/lib/review-state.mjs:9`、`apps/admin/src/lib/review-state.mjs:37`） | **字面断言仍成立、结论已过时**：实测契约中 path 含 `review` 的确实为 0，路由里也没有名字带 review 的路径；但「没有审核面」的结论已被 `GET /admin/posts`（读面）与 `approvePost`/`rejectPost`（动作面）推翻——它们只是不叫 review。**本页只记录，不改代码**（属 B 档） | 同行号；`packages/contracts/openapi.json` |

## 9 这份现状页没有做的事

- 没有启动任何服务、没有连库、没有跑 `vite build`：`§1.2` 的缺省装配 503、「已可用」都不含运行证据。
- 没有核对 `packages/contracts/openapi.json` 与实现逐字段一致（那由 `node tools/verify-contract-status.mjs` 与 `npm run test:contract` 负责）。
- 没有审这 14 个业务视图（`apps/admin/src/views/` 的 16 个 `.vue` 去掉 2 个子组件）的样式、无障碍与文案质量；本页只判「有没有入口、调了哪个端点、点了会不会有反应」。
