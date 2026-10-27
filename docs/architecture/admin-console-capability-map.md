# 后台（apps/admin）能力现状：已挂端点、真实调用与缺口

> 基线：`68dec742`（2026-10-26 重测；`#640` 以 squash `2bfec9d3`、`#641` 以 `68dec742` 合入后）。本页所有「文件:行号」都以该提交为准；社区审核队列页（原分支 `feat/gy-r62-admin-moderation-queue`）已随之合入，不再单列。
> **计数口径（先读这条，否则数字对不上）**：`packages/contracts/openapi.json` 中以 `/admin` 开头的 path 共 **36** 条，展开成 **45** 个 operation；其中 **44** 个的 `x-scope` 落在 `AdminScope.enum` 闭集（13 项）内，另 **1** 个是 `loginAdmin`（`POST /admin/auth/session`，`x-scope: public`）——它是登录入口，不持任何后台权限，**任何口径下都不计入**。
> 本页沿用旧口径，**只数 42 条**：即 44 减去 `getAdminSession`（`session:read`）与 `logoutAdmin`（`session:logout`）这两条鉴权自省／登出操作。42 同时等于 `services/api/src/routes/admin.ts` 里逐条注册的路由数；另 3 条鉴权路由（`loginAdmin`、`getAdminSession`、`logoutAdmin`）注册在同族文件 `services/api/src/routes/admin-auth.ts:46`、`services/api/src/routes/admin-auth.ts:88`、`services/api/src/routes/admin-auth.ts:103`，42＋3＝45。**改用闭集全集口径时，本页每个「42／30」都要 +2（→44／32），缺口数不变（12）。**
> 口径：只写从代码里读得到的结构性事实，**不是运行验收**。PROVIDER 接线未连库验证；凡「未接线 / 503」都限定在**缺省装配**（stub，或 `real` 但没拿到库池）这一分支，装配判据见 `services/api/src/app.ts:1332`。
> 可复跑：`node tools/verify-doc-anchors.mjs --strict`、`node tools/verify-contract-status.mjs`、`npm run test:docs`。

## 0 一页结论

| 面 | 现在的事实 | 锚点 |
| --- | --- | --- |
| 服务端 admin 端点 | 42 条注册路由，对应契约 42 个 operationId（这个 42 是本页沿用的旧口径＝页首「闭集 44」减去 `getAdminSession`／`logoutAdmin` 两条鉴权自省／登出操作；按闭集全集口径就是页首那 44 条，两者不是矛盾的两套数）；13 个 admin scope 中实际有路使用的 12 个 | services/api/src/routes/admin.ts:198-487 |
| 前端真实调用 | 30 个 operation、33 处物理调用点（含「审计总台账」与「管理员权限读面」两页，各 1／2 个），全部落在契约内 | apps/admin/src/lib/admin-content-api.mjs:409 |
| 页面 | 17 个 `.vue`（壳 `App.vue` 1 + 主 tab 视图 10 + 子页 4 + 子组件 2）；「社区审核队列」已接入读 + 通过/驳回，「人工审核」仍是空占位 | apps/admin/src/App.vue:27-38 |
| 死按钮 | 0 个；另有 6 个「详情/编辑」link 按钮自身无 handler，靠父行点击冒泡生效 | apps/admin/src/views/SourcesView.vue:469 |
| 后端有面、UI 无入口 | 12 个 operation，只剩两族：注册资料 6、限制资料 6 | services/api/src/routes/admin.ts:238-255 |
| 鉴权 | 登录响应**不含** scopes；9 个页面登录后再读一次 `GET /admin/auth/session` 补 scope | apps/admin/src/auth/session.ts:128 |
| 两端都缺 | 「人工审核」工作台（审核人 / 投票 / 专家认证）：`ReviewPlaceholderView` 仍是空态说明页、服务层 `wired:false`。**帖子级**人工通过/驳回已不是缺口：`approvePost`/`rejectPost` 自 S3 起在契约内且有路由与页面（§1.1、§2.1） | apps/admin/src/views/ReviewPlaceholderView.vue:2-16 |

## 1 服务端已挂的 admin 端点（42 条）

文件头自述覆盖 40 个 operationId（`services/api/src/routes/admin.ts:4`），同一文件的注释又写「注册 40 个后台路由」（`services/api/src/routes/admin.ts:160`）——两处都漏掉 S3 落地的 `approvePost`/`rejectPost`；逐条数出 `app.get/post/patch/put` 注册 **42** 处，operationId 全集由 `ADMIN_HTTP_OPERATION_IDS` 导出（`services/api/src/routes/admin.ts:494-518`：`FAMILIES.flatMap` 展开 24 个 + 显式列出 18 个）。

### 1.1 按域分组

| 域 | 条数 | operation id | scope | 注册行 |
| --- | --- | --- | --- | --- |
| 资料来源 | 6 | listAdminSources、createSourceDraft、getAdminSource、editSourceDraft、publishSource、withdrawSource | sources:read / sources:write | services/api/src/routes/admin.ts:198-215 |
| 科普内容 | 6 | listAdminKnowledge、createKnowledgeDraft、getAdminKnowledge、editKnowledgeDraft、publishKnowledge、withdrawKnowledge | sources:read / sources:write | services/api/src/routes/admin.ts:218-235 |
| 注册资料 | 6 | listAdminRegistration、createRegistrationDraft、getAdminRegistration、editRegistrationDraft、publishRegistration、withdrawRegistration | sources:read / sources:write | services/api/src/routes/admin.ts:238-255 |
| 限制资料 | 6 | listAdminRestriction、createRestrictionDraft、getAdminRestriction、editRestrictionDraft、publishRestriction、withdrawRestriction | sources:read / sources:write | services/api/src/routes/admin.ts:258-275 |
| 分类 | 2 | listAdminCategories、editCategory | sources:read / sources:write | services/api/src/routes/admin.ts:307-321 |
| 账号 | 2 | listAdminUsers、suspendUser | accounts:read / accounts:suspend | services/api/src/routes/admin.ts:328-341 |
| 管理员 | 2 | listAdministrators、listAdministratorScopes | scopes:read | services/api/src/routes/admin.ts:354-367 |
| 作业 | 2 | listAdminJobs、cancelAdminJob | jobs:read / jobs:cancel | services/api/src/routes/admin.ts:377-390 |
| 功能开关 | 2 | listFlags、setFlag | flags:read / flags:write | services/api/src/routes/admin.ts:398-411 |
| 审计 | 2 | listAuditEvents、listAuditLogs | audit:read | services/api/src/routes/admin.ts:281-285、services/api/src/routes/admin.ts:295-299 |
| 开关留痕 | 1 | listFlagAuditEvents | flags:read | services/api/src/routes/admin.ts:418-422 |
| 社区帖子 | 5 | hidePost、listAdminPosts、getAdminPost、approvePost、rejectPost | sources:write / sources:read | services/api/src/routes/admin.ts:430-438、services/api/src/routes/admin.ts:450-460、services/api/src/routes/admin.ts:468-476、services/api/src/routes/admin.ts:479-487 |

合计 6+6+6+6+2+2+2+2+2+2+1+5 ＝ 42。四类「资料」共用同一组 scope：文件名与 operationId 逐条写在 `services/api/src/admin/families.ts:122-216`；`hidePost` 借用 `sources:write` 是契约级粒度问题，前端只能如实标注（`apps/admin/src/views/PostTakedownView.vue:52`）。帖子读面与审核动作同理：契约给的是 `sources:read`（两个读面）与 `sources:write`（下架 + 通过/驳回），没有独立的 `posts:*` scope，页面只能按契约标注。

### 1.2 四条只在缺省装配（stub / real 无池）下 503 的端点

装配判据在 `services/api/src/app.ts`：`const adminRealUnwired = config.executionMode === 'real'`（`services/api/src/app.ts:1332`），端口只在「`real` 且确实拿到库池」时构造——作业 `services/api/src/app.ts:1354-1356`，审计总台账 `services/api/src/app.ts:1492-1493`（其上 `services/api/src/app.ts:1485-1491` 的注释写明：只在确实拿到库池时构造只读端口，`pool === null` ⇒ 端口 null ⇒ `/admin/audit-logs` 保持 503）。所以下表描述的是**未注入端口且没有库池**这一缺省分支；`real` + 有池的生产装配端口已接，503 不适用。

| 端点 | 缺省分支的现状 | 锚点 |
| --- | --- | --- |
| GET /admin/audit-logs（listAuditLogs） | 端口为 null ⇒ 503 PROVIDER_UNAVAILABLE，不返回空页 | services/api/src/routes/admin.ts:295-299；services/api/src/app.ts:1485-1493 |
| GET /admin/jobs、POST /admin/jobs/{id}/cancel | 端口不构造 ⇒ 读与写都 503 | services/api/src/routes/admin.ts:377-390；services/api/src/app.ts:1354-1356 |
| POST /admin/posts/{id}/hide | 只有真实持久的社区帖子端口才放行（`hidePostWired`），内存实现恒 false ⇒ 503 | services/api/src/routes/admin.ts:430-438；services/api/src/app.ts:1310-1311、services/api/src/app.ts:1548 |
| GET /admin/posts、GET /admin/posts/{id}、POST /admin/posts/{id}/approve、POST /admin/posts/{id}/reject | 后台帖子读面端口与运营审核端口未接线 ⇒ 服务层 503 PROVIDER_UNAVAILABLE，路由层不返回空页、也不伪造审核成功 | services/api/src/routes/admin.ts:450-487 |

## 2 前端真实调用了哪些端点

### 2.1 客户端方法 → 路径（`apps/admin/src/lib/`）

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

### 2.2 视图侧调用点（33 处 / 30 个 operation）

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
| 合计 | 30 个 operation | 33 |

`listAuditEvents` 被 4 处调用（`apps/admin/src/views/AuditEventsView.vue:66`、`apps/admin/src/views/SourcesView.vue:328`、`apps/admin/src/views/KnowledgeAdminView.vue:332`、`apps/admin/src/views/CategoriesView.vue:179`），`listAdminSources` 被 2 处调用（`apps/admin/src/views/SourcesView.vue:135`、`apps/admin/src/views/KnowledgeAdminView.vue:206`），而 `approvePost` 与 `rejectPost` 共用一处 `submitPostReview`（`apps/admin/src/views/ModerationQueueView.vue:303`）；所以 30 个 operation 对应 33 处物理调用点（+3 +1 −1；「处数」按 `<视图,行号>` 去重，不按 operation 去重）。

### 2.3 覆盖差集

42 条服务端 operation 中，UI 有入口的 **30** 条；**其余 12 条完全没有前端入口**（逐条见 §4）。

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

## 4 服务端有、UI 完全没有入口（12 条）

只剩两族。**「审计总台账」与「管理员权限读面」已不在此表**——它们在 `68dec742` 上各有页面，见本节末的更正记录。

| 域 | 条数 | operation id | 路由 | 缺口的可见后果 |
| --- | --- | --- | --- | --- |
| 注册资料 | 6 | listAdminRegistration、createRegistrationDraft、getAdminRegistration、editRegistrationDraft、publishRegistration、withdrawRegistration | GET / POST /admin/registrations；GET / PATCH /admin/registrations/{id}；POST /admin/registrations/{id}/publish、/withdraw | 「资料管理」只覆盖 4 族里的 2 族，登记类资料在后台不可维护；`apps/admin/src` 全树对 `/admin/registrations` 的引用数为 0 |
| 限制资料 | 6 | listAdminRestriction、createRestrictionDraft、getAdminRestriction、editRestrictionDraft、publishRestriction、withdrawRestriction | /admin/restrictions 同形 6 条 | 同上；`apps/admin/src` 全树对 `/admin/restrictions` 的引用数为 0 |

**更正记录（2026-10-26，基线 `68dec742`）**：本页旧版把以下两条列为「缺入口」，实测两处都**已有页面**，故从缺口表移除：

| 原缺口 | 实际页面 | 依据（operation → 客户端函数 → 视图调用点） |
| --- | --- | --- |
| 审计总台账 1 条（`listAuditLogs`） | `apps/admin/src/views/AuditLogsView.vue` | `listAuditLogs` → `fetchAuditLogsPage`（`apps/admin/src/lib/admin-audit-logs.mjs:374`）→ 视图调用点 `apps/admin/src/views/AuditLogsView.vue:72`；tab 装配 `apps/admin/src/App.vue:33`、`apps/admin/src/App.vue:81` |
| 管理员权限读面 2 条（`listAdministrators`、`listAdministratorScopes`） | `apps/admin/src/views/AdministratorsView.vue` | `listAdministrators` → `fetchAdministratorsPage`（`apps/admin/src/lib/admin-administrators.mjs:397`）→ `apps/admin/src/views/AdministratorsView.vue:92`；`listAdministratorScopes` → `fetchAdministratorScopes`（`apps/admin/src/lib/admin-administrators.mjs:425`）→ `apps/admin/src/views/AdministratorsView.vue:164`；tab 装配 `apps/admin/src/App.vue:34`、`apps/admin/src/App.vue:82` |

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
7. 前端把 scope 只当「提前禁用按钮」：9 个页面登录后立刻再读一次 `GET /admin/auth/session`（`apps/admin/src/views/AccountsView.vue:91`、`apps/admin/src/views/AdministratorsView.vue:109`、`apps/admin/src/views/AuditEventsView.vue:98`、`apps/admin/src/views/AuditLogsView.vue:111`、`apps/admin/src/views/FlagsView.vue:88`、`apps/admin/src/views/FlagAuditView.vue:100`、`apps/admin/src/views/JobsView.vue:105`、`apps/admin/src/views/ContentAdminView.vue:41-68`、`apps/admin/src/views/ModerationQueueView.vue:179`）。

缺 scope 的三种可见后果：

| 情形 | 页面表现 | 锚点 |
| --- | --- | --- |
| 账号没有 session:read | 登录成功后读会话 403 ⇒ `loadAdminSession` 返回 null 并清本地令牌，页面停在未登录态报「登录后未能读到会话详情」 | apps/admin/src/auth/session.ts:94；apps/admin/src/views/AccountsView.vue:92-97 |
| 有 session:read、缺业务读 scope | 列表请求 403 SCOPE_DENIED，页面显示服务端错误码原文，不伪造空列表 | services/api/src/auth/middleware.ts:204；apps/admin/src/views/SourcesView.vue:14 |
| 缺业务写 scope | 写按钮禁用 + 页内警示条；服务端仍是最终裁决方 | apps/admin/src/views/SourcesView.vue:366；apps/admin/src/views/PostTakedownView.vue:128 |

## 6 三档结论

| 档 | 判定标准 | 条目 |
| --- | --- | --- |
| 已可用 | 前端有入口 + 服务端有路由，且失败路径如实显示 | 资料来源 6、科普内容 6、分类 2、账号 2（读 + 停用）、功能开关 2、开关留痕 1、审计事件 1、审计总台账 1、作业 2（读 + 取消）、管理员权限读面 2（仅读）、帖子下架 1、帖子读面与审核动作 4（两个读面 + 通过/驳回）＝ 30 |
| 后端有余、UI 缺入口 | 服务端有 operation，前端零调用点 | 注册资料 6、限制资料 6 ＝ 12 |
| 两端都缺 | 契约里本就没有写操作；或只在缺省装配（stub / real 无池）下服务层未接线 | 「人工审核」工作台（审核人 / 投票 / 专家认证）仍缺：`ReviewPlaceholderView` 是空态说明页、服务层 `wired:false`（apps/admin/src/views/ReviewPlaceholderView.vue:38-60、services/api/src/admin/human-review.ts:40）；但**帖子级**通过/驳回已随 S3 进契约并有路由与页面（§1.1、§2.1），不再算「两端都缺」；审计总台账与作业的 503 只出现在缺省装配，`real` + 有库池时端口已构造（services/api/src/app.ts:1354-1356、services/api/src/app.ts:1492-1493） |

三档不是验收结论：第一档只表示「调用链与失败路径都在代码里」，没有对真实数据、真实 PROVIDER 或真实权限组合做过运行验证。

## 7 如果要做「后台最小可用」，先补这三件

1. **注册资料与限制资料两页（12 个 operation）**。理由：这是 12 条无入口里的**全部**（12/12），且服务端四族共用同一批 scope、同一个 `familyOps()` 装配（`services/api/src/routes/admin.ts:184-195`），前端照 `SourcesView` 的既有模式复制即可，不需要新契约、不需要新 scope。
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
| 「15 个 operation 无 UI 入口」（本页旧版自己的结论） | **已过时**：`68dec742` 上实测 **12 条**；旧版的 15 把「审计总台账 1」「管理员权限读面 2」算了进去，而这两条都已有页面（依据见 §4 更正记录）。取证报告在 `1a583e1d` 上给出的缺口 16 条同理——它多算了帖子族 4 条，而那 4 条随 `#640` 合入已经有页 | §4；§2.2 全表 |
| 代码内陈旧文案（一） | `apps/admin/src/App.vue:28` 写「账号目录（只读）」、`apps/admin/src/App.vue:95` 写「停用/注销等写操作不在本片」，与实有的停用写面矛盾；`apps/admin/src/auth/session.ts:21` 写「控制台业务页面未实现」，实际 `apps/admin/src/views/` 已有 16 个 `.vue`；`services/api/src/routes/admin.ts:160` 写「注册 40 个后台路由」，实际 42 条（文件头 `services/api/src/routes/admin.ts:4` 的「40 个 operationId」同样漏了 S3 的 `approvePost`/`rejectPost`） | 同行号 |
| 代码内陈旧文案（二）：「契约里没有帖子读面／没有任何帖子读面」（`apps/admin/src/views/PostTakedownView.vue:6`、`apps/admin/src/lib/post-takedown-api.mjs:8`、`apps/admin/src/lib/post-takedown-form.mjs:7-8`） | **已不成立**（措辞与事实相反）：契约有 `GET /admin/posts`、`GET /admin/posts/{id}`，路由在 `services/api/src/routes/admin.ts:450`、`services/api/src/routes/admin.ts:455`；页面在 `apps/admin/src/views/ModerationQueueView.vue:129`、`apps/admin/src/views/ModerationQueueView.vue:149`。**本页只记录，不改代码**（属 B 档） | 同行号 |
| 代码内陈旧文案（三）：「契约里根本没有审核队列的读面（path 含 `review` 的数量为 0），`routes/` 也没有任何 review 路由」（`apps/admin/src/views/ReviewPlaceholderView.vue:5-6`、`apps/admin/src/lib/review-state.mjs:9`、`apps/admin/src/lib/review-state.mjs:37`） | **字面断言仍成立、结论已过时**：实测契约中 path 含 `review` 的确实为 0，路由里也没有名字带 review 的路径；但「没有审核面」的结论已被 `GET /admin/posts`（读面）与 `approvePost`/`rejectPost`（动作面）推翻——它们只是不叫 review。**本页只记录，不改代码**（属 B 档） | 同行号；`packages/contracts/openapi.json` |

## 9 这份现状页没有做的事

- 没有启动任何服务、没有连库、没有跑 `vite build`：`§1.2` 的缺省装配 503、「已可用」都不含运行证据。
- 没有核对 `packages/contracts/openapi.json` 与实现逐字段一致（那由 `node tools/verify-contract-status.mjs` 与 `npm run test:contract` 负责）。
- 没有审这 14 个业务视图（`apps/admin/src/views/` 的 16 个 `.vue` 去掉 2 个子组件）的样式、无障碍与文案质量；本页只判「有没有入口、调了哪个端点、点了会不会有反应」。
