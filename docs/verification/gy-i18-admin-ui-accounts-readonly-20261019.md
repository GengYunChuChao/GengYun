# GY-I18 / 后台账号目录只读页（前端切片）

2026-10-19，写手。Refs #18、#2；不是整项验收，不关闭 issue。

## 这项切片做了什么

在既有的 `apps/admin`（Vue 3.5 + Vite 7，无 router、无状态库、无前端测试框架）里新增后台外壳与两个页面：

| 页面 | 内容 | 状态 |
| --- | --- | --- |
| 账号目录（只读） | 登录 → `GET /api/v1/admin/accounts` 游标分页列表 → 行内筛选 → 加载下一页 / 重新读取 | 已接入真实读面 |
| 人工审核（占位） | 入口说明与"为什么是占位" | **明确占位**，见下节 |

⛔ 本切片**没有**改动任何产品 API、契约、迁移、依赖清单：只消费已存在的读面 `GET /api/v1/admin/accounts`（`operationId: listAdminUsers`，scope `accounts:read`，见 [`openapi.json:9848-9932`](../../packages/contracts/openapi.json)）。停用/注销等写操作**未接线，页面上没有对应按钮**（不伪造不可用动作）。

## 分层：纯逻辑前置，SFC 只做渲染

| 文件 | 行数 | 出口（路径＋符号＋行号） |
| --- | --- | --- |
| `apps/admin/src/lib/admin-contract.mjs` | 189 | 契约常量 `ADMIN_API_BASE_DEFAULT`/`ACCOUNTS_PATH`/`ACCOUNTS_SCOPE`/`LIMIT_MIN`/`LIMIT_MAX`/`LIMIT_DEFAULT`/`CURSOR_MAX_LENGTH`/`ACCOUNT_STATES`/`ERROR_CODES`（:13-59）；`validateAccountView`(:78)、`validateAccountPage`(:124) 形状校验；`readErrorEnvelope`(:171)、`readPageEnvelope`(:184) 信封解包 |
| `apps/admin/src/lib/admin-api.mjs` | 235 | `normalizeBaseUrl`(:22)、`clampLimit`(:29)、`buildAccountsUrl`(:41)、`emptyCollection`(:56)、`appendPage`(:67)、`isRetriable`(:100)、`fetchAccountsPage`(:123)、`describeFailure`(:203) |
| `apps/admin/src/lib/view-model.mjs` | 280 | `STATE_LABELS`(:14)/`STATE_TONES`(:21)、`initialState`(:28)、`reduce`(:49)、`rowsOf`(:143)/`visibleRows`(:152)/`canLoadMore`(:160)、`describe`(:165)、`formatRow`(:242)/`visibleRowViews`(:255)、`summaryOf`(:265) |
| `apps/admin/src/views/AccountsView.vue` | 443 | 登录表单(:147-153)、筛选(:169)、重新读取(:172)、加载下一页(:173)、失败重试(:183) |
| `apps/admin/src/views/ReviewPlaceholderView.vue` | 161 | 占位徽标「未实现 · 占位」(:50) 与两段原因(:60/:70) |
| `apps/admin/src/App.vue`（改） | 152 | 页签(:10-11)、`nav aria-label`(:24)、`aria-pressed`(:31)、接口口径说明(:46/:49/:51) |

**为什么纯逻辑写成 `.mjs`**：`apps/admin/tsconfig.json` 的 `include` 只有 `src/**/*.ts`，`tsc -p tsconfig.json --noEmit` **既不检查 `.vue`，也不检查本节新增的 3 个 `.mjs`（704 行）**——新逻辑只靠 `node:test` 兜；仓内也没有 vitest/jsdom/msw。在"不加新依赖"约束下，把可判定的逻辑（URL/钳位/信封/分页合并/错误分类/视图归约）放进 `.mjs`，用 `node:test` 直接覆盖，SFC 只保留声明式渲染与事件绑定。代价见「未取得项」第 1 条。

## 契约对齐（逐项指到源文件行号）

| 契约项 | 出处 | 客户端处理 |
| --- | --- | --- |
| `GET /admin/accounts`，`operationId: listAdminUsers` | [`openapi.json:9848-9851`](../../packages/contracts/openapi.json) | `buildAccountsUrl` 固定 `${base}/admin/accounts`，`ACCOUNTS_PATH` 常量单一来源 |
| `x-scope: accounts:read`，`x-version-required: false` | [`openapi.json:9931-9932`](../../packages/contracts/openapi.json) | 403/`SCOPE_DENIED` ⇒ `kind: 'forbidden'`（不可重试），文案直接写缺少的 scope |
| `cursor`（string，≤2048） | [`openapi.json:10898-10903`](../../packages/contracts/openapi.json) | `CURSOR_MAX_LENGTH` 越界 ⇒ `kind: 'invalid_cursor'`，不发请求 |
| `limit`（integer 1..50，默认 20） | [`openapi.json:10906-10913`](../../packages/contracts/openapi.json) | `clampLimit` 钳到 1..50，非整数回落到 20 |
| 200 ⇒ `AdminAccountViewPageEnvelope` | [`openapi.json:9875`](../../packages/contracts/openapi.json)、`:16169-16184` | 缺 `data`/`meta` ⇒ `kind: 'invalid_response'`（不把半截响应当成功） |
| `AdminAccountViewPage`：`items` ≤50、`next_cursor` string\|null（末页显式 null） | [`openapi.json:16140-16168`](../../packages/contracts/openapi.json) | `validateAccountPage` 校验后 `appendPage` 合并；缺 `next_cursor`／空串／超长 ⇒ error，`items` >50 只记 warning；`next_cursor === null` ⇒ 不再翻页 |
| `AdminAccountView`：`id` uuid、`revision` ≥1、`state` 闭集三值、`display_name` 1..80、`additionalProperties: false` | [`openapi.json:14397-14426`](../../packages/contracts/openapi.json) | 缺 `id`/`revision`/`state`/`display_name`、`revision` <1 或非整数、`state` 越界 ⇒ **error**（整页判 `invalid_response`）；uuid 形态不符、`display_name` >80、多余字段 ⇒ **warning**（行仍渲染，但 warning 不外显：多余字段直接丢弃、不推断含义，页面没有提示位——`warnings` 只留在函数返回值与单测断言里，是**静默忽略**，不是「显式标注」） |
| 错误码闭集 | [`openapi.json:11037-11065`](../../packages/contracts/openapi.json) | `readErrorEnvelope` 标 `inContract`；闭集外 code 原样保留并标 `false`，不猜语义 |
| 服务端实现（外包只换数据源） | [`service.ts:400-411`](../../services/api/src/admin/ops/service.ts)、[`admin.ts:286-292`](../../services/api/src/routes/admin.ts) | 客户端只依赖 `pageOf` 的封套/游标语义，不依赖数据来源 |

失败分类：`signed_out`(401/`SESSION_REQUIRED`/`SESSION_EXPIRED`)、`forbidden`(403/`SCOPE_DENIED`)、`invalid_cursor`(400/`INVALID_CURSOR`)、`rate_limited`(429，带 `retry-after`)、`unavailable`(5xx)、`http_error`(其余)。可重试仅 `rate_limited`/`unavailable`/`network_error`（`isRetriable`）；`invalid_response` **不可重试**（重试同一次请求不会改变响应形状，页面不给「必然失败」的重试按钮）。**未知错误不当成空列表**：页面区分「读取失败」与「暂无账号」。

已知口径瑕疵（本片未修，不假装）：任何 403 都套成「权限不足（缺少 accounts:read）」文案，但契约 `x-error-status-map` 的 403 还可能是 `ACCOUNT_INACTIVE`／`CONSENT_REQUIRED`（服务端 `requireAdmin` 在后台账号停用时会抛 403 `ACCOUNT_INACTIVE`），此时文案会指错方向——分类仍正确（`forbidden`、不重试），只是粒度粗。

## 权限与隐私（页面侧）

- 令牌复用既有 `apps/admin/src/auth/session.ts`（`loadAdminSession`/`signInAdmin`/`signOutAdmin`，:86/:102/:141；令牌存 `sessionStorage` 键 `gengyun.admin.session`，:27），本片**没有**新造一套登录，也不把令牌放进 URL。
- 请求头只带 `authorization: Bearer`，`credentials: 'omit'`（[`admin-api.mjs:139-144`](../../apps/admin/src/lib/admin-api.mjs)）——不带 cookie，避免与产品域会话串号。
- **账号行数据**不落 `localStorage`/`sessionStorage`、不写日志、无埋点、无外链请求（只打同源 `/api/v1`）；`sessionStorage` 里只有上面那枚会话令牌，没有账号列表。
- `display_name` 只作文本插值；`apps/admin/src` 内 `v-html` 出现 **0** 次（grep 实测），账号昵称不会被当 HTML 执行。
- 权限不足不伪装成"暂无数据"：403 渲染 `权限不足（缺少 accounts:read）`。

## 实测读数（Windows PowerShell 5.1 / Node v24.16.0）

```text
npm run build（apps/admin）→ exit 0
  ✓ 20 modules transformed
  dist/index.html                 0.42 kB │ gzip:  0.32 kB
  dist/assets/index-*.css          5.48 kB │ gzip:  1.50 kB
  dist/assets/index-*.js          91.67 kB │ gzip: 36.07 kB
  ✓ built in 522ms
npm run typecheck（apps/admin）→ tsc -p tsconfig.json --noEmit，exit 0（无输出）
npm run lint（树根）→ PASS tsc services/api、PASS tsc apps/admin、PASS 仓库卫生扫描，exit 0
node --test "tests/unit/admin-ui-*.test.mjs" → tests 48 / pass 48 / fail 0
  admin-ui-contract.test.mjs 12、admin-ui-api.test.mjs 20、admin-ui-view-model.test.mjs 16
node --test "tests/unit/*.test.mjs" → tests 1794 / pass 1793 / fail 0 / cancelled 0 / skipped 1 / todo 0（80.6s），exit 0
  唯一 skipped = tests/unit/knowledge-api.test.mjs:102（`{skip: !f.native}`，需真库连接；既有，非本片）
node tools/verify-contract-status.mjs（含 --runtime）→ exit 0：112 条契约操作、已装配 108、implemented 13 / partial 95 / planned 4、形状错误 0、语义错误 0
python -B tools/validate_development_docs.py → PASS（27 initial tasks；acyclic；F/AC/Q 完整映射；链接与表格）
git diff upstream/main --check → 无输出，exit 0
```

测试覆盖到的判定：URL 拼装与前导斜杠归一、limit 钳位/默认、游标超长与空串、信封缺项、行形状（缺字段/`state` 越界/`revision` 0 ⇒ error；uuid 形态/超长显示名/多余字段 ⇒ warning）、页级多余键（如 `total`）记 warning 且不丢行、`next_cursor` 合并去重与终止、游标死循环保护（服务端把本次 cursor 原样回抛 ⇒ 停止续页并记账 `cycle`）、错误码→kind 分类（含闭集外未知码、`403` 但无 JSON 信封仍判 `forbidden`）、`retry-after` 解析、`describeFailure('invalid_response')` 不给重试入口（`retriable:false`／`action:'none'`，与 `isRetriable` 闭集一致）、视图归约（加载态/失败态/空态/行筛选/`canLoadMore`/`describe` 文案）。

## 回环探针：客户端解析器 × 真实装配的 API（一次性，非交付物）

`npm run build` 只证明编译通过，不能证明页面解析的是真实响应字节。为此跑了一个**不进仓**的探针（`E:\GengYunCommander\.pg17\tmp\hq\admin-ui-w1\probe.mjs`，收工已删除）：用 `buildApp` + `createAdminOpsStore({ accountSeed })` 装配**真实 Fastify app**、`listen` 到 `127.0.0.1:0`，再把 `fetchAccountsPage` 指过去。**内存 store、回环 HTTP、不出网、不连库**。

```json
page1        { ok: true, status: 200, items: 2, nextCursor: "<cursor>", warnings: [],
               keys: ["display_name", "id", "revision", "state"], states: ["active", "suspended"] }
page2        { ok: true, items: 1, nextCursor: null }
forbidden    { ok: false, kind: "forbidden",     status: 403, code: "SCOPE_DENIED" }
unknownToken { ok: false, kind: "signed_out",    status: 401, code: "SESSION_EXPIRED" }
badCursor    { ok: false, kind: "invalid_cursor", status: 400, code: "INVALID_CURSOR" }
noToken      { ok: false, kind: "signed_out",     status: null }
```

读数意义：真实响应的行字段恰好 `{id, revision, state, display_name}` 四列（本片把多余字段记 warning 而非 error，但真实响应 `warnings: []`，没有契约外列）；`limit=2` 两页取回 3 行且无重复、第二页 `next_cursor=null`；三条负控制（缺 scope / 失效令牌 / 非法游标）各自落到对应 `kind`。**这条探针不在 CI、不是真实库读数**，只用来钉住"客户端 ↔ 真实装配"的接口形状。

## 明确占位（不是假装）

人工审核页标「未实现 · 占位」，理由取自仓内现状而非猜测：服务端 `humanReviewQueue()` 恒返回 `{ human_review_state: 'under_construction', voting: 'disabled', items: [] }`（[`nonbypass.ts:159-165`](../../services/api/src/moderation/nonbypass.ts)），[`docs/moderation/http-layer.md:130-131`](../../docs/moderation/http-layer.md) 写明首版没有人审队列/审核人/专家认证，且 [`state-contract.md:95`](../../docs/architecture/state-contract.md) 明确"没有人工审核放行兜底"；[`docs/requirements.md:20`](../../docs/requirements.md) 的必交范围内该项是"人工审核只空入口"。页面**不渲染**任何队列条目、审核人或投票控件。

## 未取得项

1. **组件级渲染测试**：仓内无 vitest/jsdom/`@vue/test-utils`，本片未新增依赖。现有覆盖是 `tsc`（`include` 只有 `src/**/*.ts`，**既不含 `.vue` 也不含新增的 3 个 `.mjs`**）+ `vite build`（模板编译）+ 纯逻辑单测；**没有**断言过 DOM 结构、点击流、样式或真实浏览器渲染，`warnings` 也没有 UI 出口（页面不显示「已忽略 N 个契约外字段」）。
2. **真机/真实浏览器**：没有在浏览器里打开过这个后台页面，也没有截图或交互录像；Demo 手机预览样式未比对。
3. **真实登录链路联调**：页面令牌来自既有 `session.ts`，本片**没有**跑通"微信/口令换取 → 后台会话 → 列表"的端到端；探针用的是合成会话。
4. **真实 PG 目录**：读面数据在探针里是内存种子；真实 `public.list_admin_accounts()` 的读数见[账号读面证据](gy-i18-admin-accounts-read-20261018.md)，**那份证据的"未取得项"第 1 条正是后台 UI 联调**，本片只是补上了页面侧的解析与错误分类，两边合起来仍不等于联调。
5. **写操作**：停用/恢复/注销未接线（本片按派单只读），页面上没有入口，因此也没有对应测试。
6. **大数据量**：列表一次一页、翻页靠 `next_cursor`，未压测上万账号；服务端目录本身仍是一次全表读 + 服务层切片（见账号读面证据页「残余限制」）。
7. **无障碍**：只做了 `aria-label`/`aria-pressed`/表单 `label` 与键盘可达的原生控件；**没有**跑 axe/读屏实测。

## 回滚

纯新增 + `App.vue` 一处改动：删 `apps/admin/src/lib/{admin-contract,admin-api,view-model}.mjs`、`apps/admin/src/views/{AccountsView,ReviewPlaceholderView}.vue`、三个 `tests/unit/admin-ui-*.test.mjs`，并 `git checkout apps/admin/src/App.vue`。无迁移、无契约、无依赖变更，回滚不影响服务端读面。
