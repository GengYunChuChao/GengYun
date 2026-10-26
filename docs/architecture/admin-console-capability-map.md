# 后台（apps/admin）能力现状：已挂端点、真实调用与缺口

> 基线：`origin/main` = `f6c5866dd06683329ecfe96d9c489cd9a226502d`（2026-10-26 在 worktree `wt-r59-adminmap` 读取）。本页所有「文件:行号」都以该提交为准。
> 口径：只写从代码里读得到的结构性事实，**不是运行验收**。PROVIDER 接线未连库验证；凡「未接线 / 503」都限定在**缺省装配**（stub，或 `real` 但没拿到库池）这一分支，装配判据见 `services/api/src/app.ts:1332`。
> 可复跑：`node tools/verify-doc-anchors.mjs --strict`、`node tools/verify-contract-status.mjs`、`npm run test:docs`。

## 0 一页结论

| 面 | 现在的事实 | 锚点 |
| --- | --- | --- |
| 服务端 admin 端点 | 38 条路由，对应契约 38 个 operationId；13 个 admin scope 中实际有路使用的 12 个 | services/api/src/routes/admin.ts:4 |
| 前端真实调用 | 23 个 operation、27 处调用点，全部落在契约内 | apps/admin/src/lib/admin-content-api.mjs:409 |
| 页面 | 14 个 `.vue`（壳 `App.vue` 1 + 主 tab 视图 7 + 子页 4 + 子组件 2），「人工审核」是空占位 | apps/admin/src/App.vue:14-22 |
| 死按钮 | 0 个；另有 5 个「详情/编辑」link 按钮自身无 handler，靠父行点击冒泡生效 | apps/admin/src/views/SourcesView.vue:469 |
| 后端有面、UI 无入口 | 15 个 operation：注册资料 6、限制资料 6、审计总台账 1、管理员权限读面 2 | services/api/src/routes/admin.ts:225-242 |
| 鉴权 | 登录响应**不含** scopes；6 个页面登录后再读一次 `GET /admin/auth/session` 补 scope | apps/admin/src/auth/session.ts:128 |
| 两端都缺 | 人工审核工作台：契约里没有任何 review 写操作，服务层 `wired:false` | apps/admin/src/views/ReviewPlaceholderView.vue:2-16 |

## 1 服务端已挂的 admin 端点（38 条）

文件头自述覆盖 38 个 operationId（`services/api/src/routes/admin.ts:4`）；同一文件的注释仍写「注册 34 个后台路由」（`services/api/src/routes/admin.ts:147`），是陈旧计数，逐条数出 `app.get/post/patch/put` 注册 38 处，operationId 全集由 `ADMIN_HTTP_OPERATION_IDS` 导出（`services/api/src/routes/admin.ts:432-450`）。

### 1.1 按域分组

| 域 | 条数 | operation id | scope | 注册行 |
| --- | --- | --- | --- | --- |
| 资料来源 | 6 | listAdminSources、createSourceDraft、getAdminSource、editSourceDraft、publishSource、withdrawSource | sources:read / sources:write | services/api/src/routes/admin.ts:185-202 |
| 科普内容 | 6 | listAdminKnowledge、createKnowledgeDraft、getAdminKnowledge、editKnowledgeDraft、publishKnowledge、withdrawKnowledge | sources:read / sources:write | services/api/src/routes/admin.ts:205-222 |
| 注册资料 | 6 | listAdminRegistration、createRegistrationDraft、getAdminRegistration、editRegistrationDraft、publishRegistration、withdrawRegistration | sources:read / sources:write | services/api/src/routes/admin.ts:225-242 |
| 限制资料 | 6 | listAdminRestriction、createRestrictionDraft、getAdminRestriction、editRestrictionDraft、publishRestriction、withdrawRestriction | sources:read / sources:write | services/api/src/routes/admin.ts:245-262 |
| 分类 | 2 | listAdminCategories、editCategory | sources:read / sources:write | services/api/src/routes/admin.ts:294-308 |
| 账号 | 2 | listAdminUsers、suspendUser | accounts:read / accounts:suspend | services/api/src/routes/admin.ts:315-328 |
| 管理员 | 2 | listAdministrators、listAdministratorScopes | scopes:read | services/api/src/routes/admin.ts:341-354 |
| 作业 | 2 | listAdminJobs、cancelAdminJob | jobs:read / jobs:cancel | services/api/src/routes/admin.ts:364-377 |
| 功能开关 | 2 | listFlags、setFlag | flags:read / flags:write | services/api/src/routes/admin.ts:385-398 |
| 审计 | 2 | listAuditEvents、listAuditLogs | audit:read | services/api/src/routes/admin.ts:268-272、services/api/src/routes/admin.ts:282-286 |
| 开关留痕 | 1 | listFlagAuditEvents | flags:read | services/api/src/routes/admin.ts:405-409 |
| 社区帖子 | 1 | hidePost | sources:write | services/api/src/routes/admin.ts:417-425 |

合计 6+6+6+6+2+2+2+2+2+2+1+1 ＝ 38。四类「资料」共用同一组 scope：文件名与 operationId 逐条写在 `services/api/src/admin/families.ts:122-216`；`hidePost` 借用 `sources:write` 是契约级粒度问题，前端只能如实标注（`apps/admin/src/views/PostTakedownView.vue:52`）。

### 1.2 三条只在缺省装配（stub / real 无池）下 503 的端点

装配判据在 `services/api/src/app.ts`：`const adminRealUnwired = config.executionMode === 'real'`（`services/api/src/app.ts:1332`），端口只在「`real` 且确实拿到库池」时构造——作业 `services/api/src/app.ts:1354-1356`，审计总台账 `services/api/src/app.ts:1492-1493`（其上 `services/api/src/app.ts:1485-1491` 的注释写明：只在确实拿到库池时构造只读端口，`pool === null` ⇒ 端口 null ⇒ `/admin/audit-logs` 保持 503）。所以下表描述的是**未注入端口且没有库池**这一缺省分支；`real` + 有池的生产装配端口已接，503 不适用。

| 端点 | 缺省分支的现状 | 锚点 |
| --- | --- | --- |
| GET /admin/audit-logs（listAuditLogs） | 端口为 null ⇒ 503 PROVIDER_UNAVAILABLE，不返回空页 | services/api/src/routes/admin.ts:275-286；services/api/src/app.ts:1485-1493 |
| GET /admin/jobs、POST /admin/jobs/{id}/cancel | 端口不构造 ⇒ 读与写都 503 | services/api/src/routes/admin.ts:356-377；services/api/src/app.ts:1354-1356 |
| POST /admin/posts/{id}/hide | 只有真实持久的社区帖子端口才放行（`hidePostWired`），内存实现恒 false ⇒ 503 | services/api/src/routes/admin.ts:411-425；services/api/src/app.ts:1310-1311、services/api/src/app.ts:1548 |

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
| listAdminUsers | fetchAccountsPage（apps/admin/src/lib/admin-api.mjs:123） | GET /admin/accounts | accounts:read |
| suspendUser | suspendAccount（apps/admin/src/lib/account-suspend-api.mjs:138） | POST /admin/accounts/{id}/suspend | accounts:suspend |
| listFlags | fetchFlagsPage（apps/admin/src/lib/flags-api.mjs:224） | GET /admin/feature-flags | flags:read |
| setFlag | putFlag（apps/admin/src/lib/flags-api.mjs:288） | PUT /admin/feature-flags/{key} | flags:write |
| listFlagAuditEvents | fetchFlagAuditPage（apps/admin/src/lib/flag-audit.mjs:145） | GET /admin/flag-audit-events | flags:read |
| listAuditEvents | fetchAuditEventsPage（apps/admin/src/lib/audit-events.mjs:360）；findAuditEventsForRequest（apps/admin/src/lib/admin-content-api.mjs:600） | GET /admin/audit-events | audit:read |
| listAdminJobs | listJobs（apps/admin/src/lib/jobs-api.mjs:348） | GET /admin/jobs | jobs:read |
| cancelAdminJob | cancelJob（apps/admin/src/lib/jobs-api.mjs:414） | POST /admin/jobs/{id}/cancel | jobs:cancel |
| hidePost | hidePost（apps/admin/src/lib/post-takedown-api.mjs:390） | POST /admin/posts/{id}/hide | sources:write |

写面请求头不是页面各自拼的：`writeFamilyResource` 统一要求 `Idempotency-Key`，非 POST 或带 action 时还要 `If-Match`（`apps/admin/src/lib/admin-content-api.mjs:307-406`，头部校验落在其中 325-336 行）。

### 2.2 视图侧调用点（27 处 / 23 个 operation）

| 页面（行数） | 调用点：operationId@行 | 计数 |
| --- | --- | --- |
| apps/admin/src/views/AccountsView.vue（649） | listAdminUsers@64、suspendUser@162 | 2 |
| apps/admin/src/views/SourcesView.vue（720） | listAdminSources@135、getAdminSource@165、createSourceDraft@253、editSourceDraft@268、publishSource@294、withdrawSource@320、listAuditEvents@328 | 7 |
| apps/admin/src/views/KnowledgeAdminView.vue（760） | listAdminKnowledge@124、getAdminKnowledge@154、listAdminSources@206、createKnowledgeDraft@257、editKnowledgeDraft@272、publishKnowledge@298、withdrawKnowledge@324、listAuditEvents@332 | 8 |
| apps/admin/src/views/CategoriesView.vue（507） | listAdminCategories@86、editCategory@171、listAuditEvents@179 | 3 |
| apps/admin/src/views/PostTakedownView.vue（351） | hidePost@89 | 1 |
| apps/admin/src/views/FlagsView.vue（595） | listFlags@63、setFlag@147 | 2 |
| apps/admin/src/views/FlagAuditView.vue（546） | listFlagAuditEvents@68 | 1 |
| apps/admin/src/views/AuditEventsView.vue（541） | listAuditEvents@66 | 1 |
| apps/admin/src/views/JobsView.vue（664） | listAdminJobs@80、cancelAdminJob@159 | 2 |
| 合计 | 23 个 operation | 27 |

`listAuditEvents` 被 4 处调用（`apps/admin/src/views/AuditEventsView.vue:66`、`apps/admin/src/views/SourcesView.vue:328`、`apps/admin/src/views/KnowledgeAdminView.vue:332`、`apps/admin/src/views/CategoriesView.vue:179`），`listAdminSources` 被 2 处调用（`apps/admin/src/views/SourcesView.vue:135`、`apps/admin/src/views/KnowledgeAdminView.vue:206`），所以调用点数比 operation 数多 4。

### 2.3 覆盖差集

38 条服务端 operation 中，UI 有入口的 23 条；**其余 15 条完全没有前端入口**（逐条见 §4）。

## 3 每个后台页面现在能做什么

按钮统计口径：允许 `@click.stop` 等事件修饰符；「死按钮」＝既无自身 `@click`、也不在任何父级点击区（`<tr @click>`、`<form @submit>`）内。

| 视图（行数） | 列表 / 详情 | 写操作与按钮 | 按钮 / 死按钮 | 权限门 |
| --- | --- | --- | --- | --- |
| apps/admin/src/views/AccountsView.vue（649） | 账号列表（游标分页）；行内只有「停用」按钮，无独立详情侧栏 | 停用：确认框必填理由 → POST /admin/accounts/{id}/suspend，成功后就地刷新第一页 | 14 / 0 | accounts:read 读；accounts:suspend 决定「停用」是否可点（apps/admin/src/lib/view-model.mjs:371） |
| apps/admin/src/views/ContentAdminView.vue（292） | 容器：登录表单 + 4 个子 tab（来源 / 科普 / 帖子下架 / 分类） | 无自身业务请求，只下发 baseUrl/token/scopes | 3 / 0 | 无（登录后读会话） |
| apps/admin/src/views/SourcesView.vue（720） | 来源列表 + 详情 + 新建草稿 / 编辑 / 发布 / 下架表单 + 按 request_id 反查审计 | 4 个写操作（创建、编辑、发布、下架）+ 1 个只读反查（`listAuditEvents`） | 20 / 0 | sources:read / sources:write（apps/admin/src/views/SourcesView.vue:80-82） |
| apps/admin/src/views/KnowledgeAdminView.vue（760） | 科普列表 + 详情 + 新建 / 编辑 / 发布 / 下架；发布需挑一条来源（读来源列表辅助） | 同为 4 写（创建、编辑、发布、下架）+ 1 只读反查（`listAuditEvents`） | 22 / 0 | sources:read / sources:write（apps/admin/src/views/KnowledgeAdminView.vue:82-84） |
| apps/admin/src/views/CategoriesView.vue（507） | 分类列表 + 编辑表单 | 只有「保存分类」；**没有新建 / 删除按钮**（契约只有 2 个 operation，页面不造） | 9 / 0 | sources:read / sources:write（apps/admin/src/views/CategoriesView.vue:58-60） |
| apps/admin/src/views/PostTakedownView.vue（351） | 下架表单（帖子 id + 理由） | POST /admin/posts/{id}/hide | 1 / 0 | sources:write（apps/admin/src/views/PostTakedownView.vue:52） |
| apps/admin/src/views/FlagsView.vue（595） | 开关列表 + 行内切换 + 详情侧栏 | PUT /admin/feature-flags/{key}（If-Match + Idempotency-Key） | 12 / 0 | flags:read 读；flags:write 决定可写（apps/admin/src/lib/flags-view-model.mjs:224） |
| apps/admin/src/views/FlagAuditView.vue（546） | 开关变更留痕只读 + 加载下一页 | 无写操作 | 6 / 0 | flags:read |
| apps/admin/src/views/AuditEventsView.vue（541） | 审计事件只读 + 客户端筛选 + 展开原文 | 无写操作 | 6 / 0 | audit:read |
| apps/admin/src/views/JobsView.vue（664） | 作业列表 + 详情 + 取消 | 取消只在 queued / running 行可用，终态行按钮禁用 | 13 / 0 | jobs:read 读；jobs:cancel 决定可取消（apps/admin/src/lib/jobs-api.mjs:713） |
| apps/admin/src/views/ReviewPlaceholderView.vue（238） | 空态：不发起任何网络请求，不伪造队列与审核人 | 无 | 0 / 0 | 无 |
| apps/admin/src/views/ContentFieldGrid.vue（138） | 纯子组件（字段网格），无请求 | 无 | 0 / 0 | 无 |
| apps/admin/src/views/WriteReceipt.vue（198） | 纯子组件（写入回执），按钮全部 emit | 无网络请求 | 3 / 0 | 无 |

5 个 link 按钮本身没有 handler，点击命中父行：

| link 按钮（无自身 handler） | 父行 `<tr @click>`（真正的点击源） |
| --- | --- |
| apps/admin/src/views/AuditEventsView.vue:270 「展开原文 / 收起」 | apps/admin/src/views/AuditEventsView.vue:258 |
| apps/admin/src/views/CategoriesView.vue:265 「编辑」 | apps/admin/src/views/CategoriesView.vue:258 |
| apps/admin/src/views/FlagAuditView.vue:266 「展开原文 / 收起」 | apps/admin/src/views/FlagAuditView.vue:255 |
| apps/admin/src/views/KnowledgeAdminView.vue:492 「详情」 | apps/admin/src/views/KnowledgeAdminView.vue:483 |
| apps/admin/src/views/SourcesView.vue:469 「详情」 | apps/admin/src/views/SourcesView.vue:461 |

按「有没有点击路径」判，死按钮 0 个；全仓也没有指向空函数的 `@click`——`apps/admin/src/lib/view-model.mjs:450` 的「读面未提供」是如实标注，不是空实现。

## 4 服务端有、UI 完全没有入口（15 条）

| 域 | 条数 | operation id | 路由 | 缺口的可见后果 |
| --- | --- | --- | --- | --- |
| 注册资料 | 6 | listAdminRegistration、createRegistrationDraft、getAdminRegistration、editRegistrationDraft、publishRegistration、withdrawRegistration | GET / POST /admin/registrations；GET / PATCH /admin/registrations/{id}；POST /admin/registrations/{id}/publish、/withdraw | 「资料管理」只覆盖 4 族里的 2 族，登记类资料在后台不可维护 |
| 限制资料 | 6 | listAdminRestriction、createRestrictionDraft、getAdminRestriction、editRestrictionDraft、publishRestriction、withdrawRestriction | /admin/restrictions 同形 6 条 | 同上 |
| 审计总台账 | 1 | listAuditLogs | GET /admin/audit-logs | 页面只有 events，没有 logs；且该端点在缺省装配（stub / real 无池）下 503 |
| 管理员权限读面 | 2 | listAdministrators、listAdministratorScopes | GET /admin/administrators、GET /admin/administrators/{id}/scopes | 后台看不见「谁能做什么」，排 scope 问题只能查库或看迁移 |

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
6. scope 闭集 13 项见 `services/api/src/admin/scopes.ts:35-49`；`scopes:write` 只在常量里声明、没有任何路由以它为门（`services/api/src/admin/scopes.ts:65-69`），授/撤 scope 现状只有迁移 0041 的 SECURITY DEFINER 函数。
7. 前端把 scope 只当「提前禁用按钮」：六个页面登录后立刻再读一次 `GET /admin/auth/session`（`apps/admin/src/views/AccountsView.vue:88-100`、`apps/admin/src/views/FlagsView.vue:88`、`apps/admin/src/views/FlagAuditView.vue:100`、`apps/admin/src/views/AuditEventsView.vue:98`、`apps/admin/src/views/JobsView.vue:105`、`apps/admin/src/views/ContentAdminView.vue:41-68`）。

缺 scope 的三种可见后果：

| 情形 | 页面表现 | 锚点 |
| --- | --- | --- |
| 账号没有 session:read | 登录成功后读会话 403 ⇒ `loadAdminSession` 返回 null 并清本地令牌，页面停在未登录态报「登录后未能读到会话详情」 | apps/admin/src/auth/session.ts:94；apps/admin/src/views/AccountsView.vue:92-97 |
| 有 session:read、缺业务读 scope | 列表请求 403 SCOPE_DENIED，页面显示服务端错误码原文，不伪造空列表 | services/api/src/auth/middleware.ts:204；apps/admin/src/views/SourcesView.vue:14 |
| 缺业务写 scope | 写按钮禁用 + 页内警示条；服务端仍是最终裁决方 | apps/admin/src/views/SourcesView.vue:366；apps/admin/src/views/PostTakedownView.vue:128 |

## 6 三档结论

| 档 | 判定标准 | 条目 |
| --- | --- | --- |
| 已可用 | 前端有入口 + 服务端有路由，且失败路径如实显示 | 资料来源 6、科普内容 6、分类 2、账号 2（读 + 停用）、功能开关 2、开关留痕 1、审计事件 1、作业 2（读 + 取消）、帖子下架 1 ＝ 23 |
| 后端有余、UI 缺入口 | 服务端有 operation，前端零调用点 | 注册资料 6、限制资料 6、审计总台账 1、管理员权限读面 2 ＝ 15 |
| 两端都缺 | 契约里本就没有写操作；或只在缺省装配（stub / real 无池）下服务层未接线 | 人工审核（无 review 写操作、`HUMAN_REVIEW_STATE` 为 `under_construction`：apps/admin/src/views/ReviewPlaceholderView.vue:38-60）；审计总台账与作业的 503 只出现在缺省装配，`real` + 有库池时端口已构造（services/api/src/app.ts:1354-1356、services/api/src/app.ts:1492-1493） |

三档不是验收结论：第一档只表示「调用链与失败路径都在代码里」，没有对真实数据、真实 PROVIDER 或真实权限组合做过运行验证。

## 7 如果要做「后台最小可用」，先补这三件

1. **注册资料与限制资料两页（12 个 operation）**。理由：这是 15 条无入口里最大的缺口（占 12/15），且服务端四族共用同一批 scope、同一个 `familyOps()` 装配（`services/api/src/routes/admin.ts:171-182`），前端照 `SourcesView` 的既有模式复制即可，不需要新契约、不需要新 scope。
2. **管理员权限读面（2 个 operation）**。理由：纯读、门是 `scopes:read`、实现量最小；但没有它，第 1 件落地后「为什么某人的按钮是灰的」在后台无从查证，只能查库。
3. **让 scopes 随登录一起到前端（1 处响应或守卫调整）**。理由：现在 6 个页面各抄一遍「登录后再读一次」，且没有 `session:read` 的管理员会直接卡在登录失败；把 scopes 放进登录响应（或允许无 `session:read` 也能读自己的会话）能同时消掉重复代码与这个单点。

排第四的是审计总台账（`listAuditLogs`）：缺的是 **UI 入口**，不是 provider——`real` + 有库池时只读端口已构造（`services/api/src/app.ts:1485-1493`）；只有缺省装配（stub / real 无池）才会 503，所以补页前先确认目标环境的运行模式。

## 8 与既有取证、代码注释的差异

| 说法（来源） | 本页复核结果 | 依据 |
| --- | --- | --- |
| 「26 处调用点」（另一份只读取证，未入库；本文以本仓 `apps/admin/src` 的逐行计数为口径） | 本页逐行枚举是 **27 处**、23 个 operation | §2.2 全表 |
| 「AccountsView 有一个无 handler 的死按钮」（同上） | 现基线不成立：该处已是 `</td>`，停用按钮带 `@click.stop="beginSuspend(row)"`，全仓死按钮 0 个 | apps/admin/src/views/AccountsView.vue:356-365 |
| 「登录后 scopes 恒为空导致写入按钮全灭」（同上） | 半过时：`scopes: []` 仍在，但 6 个页面登录后立刻再读会话，按钮不会全灭；真正会全灭的是缺 `session:read` 的账号 | apps/admin/src/auth/session.ts:128；apps/admin/src/views/AccountsView.vue:88-100 |
| 「15 个 operation 无 UI 入口」「登录响应不含 scope」 | 复核成立 | §4；services/api/src/auth/service.ts:366-374 |
| 代码内陈旧文案 | `apps/admin/src/App.vue:15` 写「账号目录（只读）」、`apps/admin/src/App.vue:63-64` 写「停用/注销等写操作不在本片」，与实有的停用写面矛盾；`apps/admin/src/auth/session.ts:21` 写「控制台业务页面未实现」，实际已有 13 个视图；`services/api/src/routes/admin.ts:147` 写「注册 34 个后台路由」，实际 38 条 | 同行号 |

## 9 这份现状页没有做的事

- 没有启动任何服务、没有连库、没有跑 `vite build`：`§1.2` 的缺省装配 503、「已可用」都不含运行证据。
- 没有核对 `packages/contracts/openapi.json` 与实现逐字段一致（那由 `node tools/verify-contract-status.mjs` 与 `npm run test:contract` 负责）。
- 没有审 13 个页面之外的样式、无障碍与文案质量；本页只判「有没有入口、调了哪个端点、点了会不会有反应」。
