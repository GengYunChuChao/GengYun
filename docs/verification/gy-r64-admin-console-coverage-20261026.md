# 后台控制台覆盖测绘（R64 · 基线 68dec742）

> **用途**：给后续切片当索引——一行一个 operation，「有没有 UI 入口 / 有没有 `admin-ui-*` 测试」直接查 §6，不必再回读整棵树。
> **基线**：`68dec742`（2026-10-26 实测；`#640`→`2bfec9d3`、`#641`→`68dec742` 合入后）。本页所有「文件:行号」都以该提交为准。
> **性质**：静态结构测绘，**不是运行验收**。判的是「代码里有没有这条调用链」，不是「点了有没有反应」；没启动服务、没连库、没跑 `vite build`。

## 0 四组读数

| # | 读数 | 值 |
| --- | --- | --- |
| ① | `/admin` 契约面 | path **36** 条 → operation **45** 个 |
| ② | `x-scope` ∈ `AdminScope.enum`（13 项闭集） | **44**；闭集外 **1** = `loginAdmin`（`POST /admin/auth/session`，`x-scope: public`） |
| ③ | UI 有入口 / 后端有面但 UI 无入口 | **32 / 12**（闭集 44 口径）。扣除 `session:read`+`session:logout` 两族后为 **30 / 12** |
| ④ | 有 UI 但**无任何** `admin-ui-*` 覆盖 | **7**；另有 **2** 条只有 render 间接驱动（无动作断言） |

③ 的 12 条缺口全部落在两族：`registrations` 6 条 + `restrictions` 6 条（`apps/admin/src` 全树对这两条前缀的引用数为 **0**）。

## 1 测量方法（可复现）

脚本只读仓库、不改任何文件；下为**实跑同源**版本（仓库外副本：`.pg17/tmp/r64-adminmap/verify-doc.mjs`，不入库）。

```js
// 用法：node verify-min.mjs <repoRoot>
import fs from 'node:fs'
import path from 'node:path'
const ROOT = process.argv[2]
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// ① 契约面
const spec = JSON.parse(read('packages/contracts/openapi.json'))
const M = ['get', 'post', 'put', 'patch', 'delete']
const paths = Object.keys(spec.paths).filter((p) => p.startsWith('/admin'))
const CLOSED = new Set(spec.components.schemas.AdminScope.enum)
const ops = []
for (const p of paths) for (const m of Object.keys(spec.paths[p])) {
  if (M.includes(m)) ops.push({ id: spec.paths[p][m].operationId, method: m.toUpperCase(), path: p, scope: spec.paths[p][m]['x-scope'] })
}
const inside = ops.filter((o) => CLOSED.has(o.scope))
console.log(`① paths=${paths.length} ops=${ops.length} inClosed=${inside.length} outside=${ops.filter((o) => !CLOSED.has(o.scope)).map((o) => o.id + ':' + o.scope)}`)

// ② 路由注册
const reg = (f) => [...read(f).matchAll(/app\.(get|post|put|patch|delete)\(/g)].length
console.log(`② routes/admin.ts=${reg('services/api/src/routes/admin.ts')} routes/admin-auth.ts=${reg('services/api/src/routes/admin-auth.ts')}`)

// ③ UI 入口：operation ← 客户端导出函数（逐条由代码读出，脚本校验函数确实存在）
const CLIENT = [
  ['listAdminSources', 'admin-content-api.mjs', 'listSources'], ['getAdminSource', 'admin-content-api.mjs', 'getSource'],
  ['createSourceDraft', 'admin-content-api.mjs', 'createSource'], ['editSourceDraft', 'admin-content-api.mjs', 'editSource'],
  ['publishSource', 'admin-content-api.mjs', 'publishSource'], ['withdrawSource', 'admin-content-api.mjs', 'withdrawSource'],
  ['listAdminKnowledge', 'admin-content-api.mjs', 'listKnowledge'], ['getAdminKnowledge', 'admin-content-api.mjs', 'getKnowledge'],
  ['createKnowledgeDraft', 'admin-content-api.mjs', 'createKnowledge'], ['editKnowledgeDraft', 'admin-content-api.mjs', 'editKnowledge'],
  ['publishKnowledge', 'admin-content-api.mjs', 'publishKnowledge'], ['withdrawKnowledge', 'admin-content-api.mjs', 'withdrawKnowledge'],
  ['listAdminCategories', 'admin-content-api.mjs', 'listCategories'], ['editCategory', 'admin-content-api.mjs', 'editCategory'],
  ['listAuditEvents', 'audit-events.mjs', 'fetchAuditEventsPage'], ['listAuditEvents', 'admin-content-api.mjs', 'findAuditEventsForRequest'],
  ['listAuditLogs', 'admin-audit-logs.mjs', 'fetchAuditLogsPage'], ['listAdminUsers', 'admin-api.mjs', 'fetchAccountsPage'],
  ['suspendUser', 'account-suspend-api.mjs', 'suspendAccount'], ['listAdministrators', 'admin-administrators.mjs', 'fetchAdministratorsPage'],
  ['listAdministratorScopes', 'admin-administrators.mjs', 'fetchAdministratorScopes'], ['listFlags', 'flags-api.mjs', 'fetchFlagsPage'],
  ['setFlag', 'flags-api.mjs', 'putFlag'], ['listFlagAuditEvents', 'flag-audit.mjs', 'fetchFlagAuditPage'],
  ['listAdminJobs', 'jobs-api.mjs', 'listJobs'], ['cancelAdminJob', 'jobs-api.mjs', 'cancelJob'],
  ['hidePost', 'post-takedown-api.mjs', 'hidePost'], ['listAdminPosts', 'admin-moderation-queue.mjs', 'fetchModerationQueuePage'],
  ['getAdminPost', 'admin-moderation-queue.mjs', 'fetchAdminPostDetail'], ['approvePost', 'admin-moderation-queue.mjs', 'submitPostReview'],
  ['rejectPost', 'admin-moderation-queue.mjs', 'submitPostReview'], ['getAdminSession', 'auth/session.ts', 'fetchSession'],
  ['logoutAdmin', 'auth/session.ts', 'signOutAdmin'],
].map(([id, f, fn]) => [id, (f.startsWith('auth/') ? 'apps/admin/src/' : 'apps/admin/src/lib/') + f, fn])
const views = fs.readdirSync(path.join(ROOT, 'apps/admin/src/views')).filter((f) => f.endsWith('.vue')).map((f) => 'apps/admin/src/views/' + f)
const viewLines = new Map(views.map((v) => [v, read(v).split('\n')]))
const sitesOf = (fn) => {
  const hits = []
  for (const v of views) viewLines.get(v).forEach((ln, i) => { if (new RegExp(`\\b${fn}\\s*\\(`).test(ln)) hits.push(`${v}:${i + 1}`) })
  return hits
}
const missing = CLIENT.filter(([, f, fn]) => !new RegExp(`function ${fn}\\b`).test(read(f)))
const uiOps = new Set(); const sites = new Map()
const sessionIds = new Set(inside.filter((o) => o.scope.startsWith('session:')).map((o) => o.id))
for (const [id, , fn] of CLIENT) for (const s of sitesOf(fn)) { uiOps.add(id); if (!sessionIds.has(id)) sites.set(s, id) }
for (const [id, wrap] of [['getAdminSession', 'loadAdminSession'], ['logoutAdmin', 'signOutAdmin']]) {
  if (views.some((v) => new RegExp(`\\b${wrap}\\s*\\(`).test(read(v)))) uiOps.add(id)
}
const noUi = inside.filter((o) => !uiOps.has(o.id)).map((o) => o.id)
console.log(`③ UI入口=${uiOps.size} 函数缺失=${missing.length} 物理调用点=${sites.size} 无入口=${noUi.length} => ${noUi.join(',')}`)

// ④ admin-ui 测试：✓ 显式断言 / ~ 仅 render 间接 / ✗ 无
const tests = fs.readdirSync(path.join(ROOT, 'tests/unit')).filter((f) => /^admin-ui-.*\.test\.mjs$/.test(f))
const tText = new Map(tests.map((f) => [f, read('tests/unit/' + f)]))
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const urlRe = (p) => new RegExp('admin' + esc(p.slice(6)).replace(/\\\{[^}]*\\\}/g, '[^/?\\s]+') + "(?=[?'\"`\\s)$]|$)")
const st = { '✓': [], '~': [], '✗': [] }
for (const o of inside) {
  const cs = CLIENT.filter(([id]) => id === o.id)
  let s = '✗'
  for (const [, , fn] of cs) for (const f of tests) {
    const t = tText.get(f)
    if (new RegExp(`\\b${fn}\\s*\\(`).test(t) && (urlRe(o.path).test(t) || t.includes(`init.method, '${o.method}'`))) s = '✓'
  }
  if (s === '✗') for (const [, file] of cs) {
    if (!file.includes('/lib/')) continue
    for (const f of tests) {
      if (!/-render\.test\.mjs$/.test(f)) continue
      const t = tText.get(f)
      if (cs.some(([, , fn]) => sitesOf(fn).some((x) => t.includes(x.split('/').pop().split(':')[0]))) && t.includes(file.split('/').pop())) s = '~'
    }
  }
  st[s].push(o.id)
}
console.log(`④ 显式=${st['✓'].length} 仅render=${st['~'].length}(${st['~']}) 无=${st['✗'].length} 其中有UI的=${st['✗'].filter((x) => !noUi.includes(x)).length}(${st['✗'].filter((x) => !noUi.includes(x))})`)
```

实跑输出（`node verify-min.mjs E:\GengYunCommander\wt-r64-adminmap`）：

```text
① paths=36 ops=45 inClosed=44 outside=loginAdmin:public
② routes/admin.ts=42 routes/admin-auth.ts=3
③ UI入口=32 函数缺失=0 物理调用点=33 无入口=12 => listAdminRegistration,createRegistrationDraft,getAdminRegistration,editRegistrationDraft,publishRegistration,withdrawRegistration,listAdminRestriction,createRestrictionDraft,getAdminRestriction,editRestrictionDraft,publishRestriction,withdrawRestriction
④ 显式=23 仅render=2(listAdminJobs,cancelAdminJob) 无=19 其中有UI的=7(getAdminSession,logoutAdmin,createKnowledgeDraft,getAdminKnowledge,withdrawKnowledge,listFlags,setFlag)
```

补充三条单命令旁证：

```text
# 缺口族在后台前端零引用（应为 0）
grep -rl "/admin/registrations\|/admin/restrictions" apps/admin/src | wc -l   →  0
# 页面调不存在的端点（幻影）：唯一的非契约前缀是注释里的反例，不是调用
grep -rn "/admin/admin-categories" apps/admin/src   →  admin-content-api.mjs 的注释「不造 /admin/admin-categories 之类不存在的路径」
# admin-ui 测试文件数
ls tests/unit/admin-ui-*.test.mjs | wc -l   →  21
```

## 2 读数一：契约面（36 path / 45 operation）

| 项 | 值 | 说明 |
| --- | --- | --- |
| `/admin` 开头的 path | 36 | `packages/contracts/openapi.json`；同一 path 可挂多个方法，故 path 数 ≠ operation 数 |
| 展开后的 operation | 45 | 方法 ∈ {get,post,put,patch,delete} |
| `x-scope` ∈ `AdminScope.enum` | 44 | 闭集 13 项，定义在 `packages/contracts/openapi.json` 的 `components.schemas.AdminScope`（与 `services/api/src/admin/scopes.ts:35-49` 同源） |
| `x-scope` ∉ 闭集 | 1 | `loginAdmin` = `POST /admin/auth/session`，`x-scope: public`——登录入口，不持后台权限；**任何口径都不计入** |
| 读面 / 写面（闭集内） | 20 / 24 | 读面 = GET |
| 闭集里零使用的 scope | 1 | `scopes:write`（44 条 operation 零引用；`services/api/src/admin/scopes.ts:65-69` 的注释明写「只声明、不实现」） |

按 scope 计数（闭集内 44 条）：`sources:write`=20、`sources:read`=11、`audit:read`=2、`flags:read`=2、`scopes:read`=2、`accounts:read`=1、`accounts:suspend`=1、`flags:write`=1、`jobs:cancel`=1、`jobs:read`=1、`session:logout`=1、`session:read`=1、`scopes:write`=0。

**两套口径（后续切片务必声明用哪套）**：

| 口径 | 条数 | UI 有入口 | 缺口 | 适用 |
| --- | --- | --- | --- | --- |
| A：闭集全集 | 44 | 32 | 12 | 本页与契约对齐时用 |
| B：扣掉 `session:read` / `session:logout` | 42 | 30 | 12 | `docs/architecture/admin-console-capability-map.md` 现行口径（42 也等于 `routes/admin.ts` 的注册数） |

## 3 读数二：路由与装配

| 项 | 值 | 依据 |
| --- | --- | --- |
| `routes/admin.ts` 注册条数 | 42 | 逐条数 `app.get/post/patch/put(`；文件头 `services/api/src/routes/admin.ts:4` 仍自述「40 个 operationId」、`services/api/src/routes/admin.ts:160` 仍写「注册 40 个后台路由」 ⇒ **陈旧文案，未改（B 档）** |
| `routes/admin-auth.ts` 注册条数 | 3 | `loginAdmin` `services/api/src/routes/admin-auth.ts:46`、`getAdminSession` `services/api/src/routes/admin-auth.ts:88`、`logoutAdmin` `services/api/src/routes/admin-auth.ts:103`；42＋3＝45 |
| 契约有、服务端未装配 | 0 | 44 条逐条能在 `services/api/src/routes/*.ts` 找到注册 |
| 页面调不存在的端点（幻影） | 0 | `apps/admin/src` 里出现的非契约 `/admin` 前缀只有 1 处，且是注释里的反例 |

## 4 读数三：UI 覆盖 vs 缺口

| 族 | operation 数 | 有 UI 入口 | 无入口 | 无入口的 operationId |
| --- | --- | --- | --- | --- |
| `sources` | 6 | 6 | 0 | — |
| `knowledge` | 6 | 6 | 0 | — |
| `registrations` | 6 | 0 | **6** | listAdminRegistration、createRegistrationDraft、getAdminRegistration、editRegistrationDraft、publishRegistration、withdrawRegistration |
| `restrictions` | 6 | 0 | **6** | listAdminRestriction、createRestrictionDraft、getAdminRestriction、editRestrictionDraft、publishRestriction、withdrawRestriction |
| `categories` | 2 | 2 | 0 | — |
| `accounts` | 2 | 2 | 0 | — |
| `administrators` | 2 | 2 | 0 | — |
| `jobs` | 2 | 2 | 0 | — |
| `feature-flags` | 2 | 2 | 0 | — |
| `flag-audit-events` | 1 | 1 | 0 | — |
| `audit-events` | 1 | 1 | 0 | — |
| `audit-logs` | 1 | 1 | 0 | — |
| `posts` | 5 | 5 | 0 | — |
| `auth`（session/logout） | 2 | 2 | 0 | — |
| 合计 | 44 | 32 | **12** | |

- 「有 UI 入口」判据：该 operation 有对应客户端导出函数，且该函数在 `apps/admin/src/views/*.vue` 里被调用（鉴权两族例外——它们没有 `.vue` 承载，由 `loadAdminSession` / `signOutAdmin` 被视图引用判定）。
- 物理调用点 **33**（按 `<视图,行号>` 去重；`approvePost`/`rejectPost` 共用 `apps/admin/src/views/ModerationQueueView.vue:303` 一处）。
- 两处曾被误报为缺口的页面（**此处只是记录，供索引对齐**）：审计总台账 `apps/admin/src/views/AuditLogsView.vue:72`、管理员权限读面 `apps/admin/src/views/AdministratorsView.vue:74` 与 `apps/admin/src/views/AdministratorsView.vue:146`。

## 5 读数四：admin-ui 测试覆盖

判据（三态，`tests/unit/admin-ui-*.test.mjs`，共 21 个文件）：

- **✓ 显式**：同一测试文件既**调用**该客户端函数（`fn(`），又出现该 operation 的 URL 形态或 `init.method, '<METHOD>'` 断言。
- **△ 仅 render**：某个 `admin-ui-*-render.test.mjs` 同时加载承载视图与该客户端 lib（间接驱动），但**没有**对该 operation 的动作/URL 断言。
- **✗ 无**：以上都不成立。

| 判定 | 条数 | operationId |
| --- | --- | --- |
| ✓ 显式断言 | 23 | 见 §6 末列 |
| △ 仅 render | 2 | `listAdminJobs`、`cancelAdminJob` |
| ✗ 无覆盖（**有 UI 的**） | **7** | `getAdminSession`、`logoutAdmin`、`createKnowledgeDraft`、`getAdminKnowledge`、`withdrawKnowledge`、`listFlags`、`setFlag` |
| ✗ 无覆盖（无 UI 的缺口） | 12 | 即 §4 的 12 条 |

注：`signOutAdmin` / `loadAdminSession` 在多份 render 测试里被**换成桩**调用，但那些文件里既没有 `/admin/auth/logout` 也没有 `/admin/auth/session` 字样 ⇒ 真实登出/读会话路径未被断言，故记 ✗。

## 6 全表（44 条 · 一行一个 operation）

`UI 入口` 列给的是**客户端函数被调用**的视图行（多个调用点用「、」分隔）；鉴权两族给的是实际发请求的行。

| operationId | 方法 路径 | x-scope | UI 入口（视图:行） | admin-ui 测试 |
| --- | --- | --- | --- | --- |
| `listAdminSources` | GET /admin/sources | `sources:read` | apps/admin/src/views/KnowledgeAdminView.vue:206、apps/admin/src/views/SourcesView.vue:135 | ✓ admin-ui-content-api.test.mjs |
| `createSourceDraft` | POST /admin/sources | `sources:write` | apps/admin/src/views/SourcesView.vue:253 | ✓ admin-ui-content-api.test.mjs |
| `getAdminSource` | GET /admin/sources/{id} | `sources:read` | apps/admin/src/views/SourcesView.vue:165 | ✓ admin-ui-content-api.test.mjs |
| `editSourceDraft` | PATCH /admin/sources/{id} | `sources:write` | apps/admin/src/views/SourcesView.vue:268 | ✓ admin-ui-content-api.test.mjs |
| `publishSource` | POST /admin/sources/{id}/publish | `sources:write` | apps/admin/src/views/SourcesView.vue:294 | ✓ admin-ui-content-api.test.mjs |
| `withdrawSource` | POST /admin/sources/{id}/withdraw | `sources:write` | apps/admin/src/views/SourcesView.vue:320 | ✓ admin-ui-content-api.test.mjs |
| `listAdminKnowledge` | GET /admin/knowledge | `sources:read` | apps/admin/src/views/KnowledgeAdminView.vue:124 | ✓ admin-ui-content-api.test.mjs |
| `createKnowledgeDraft` | POST /admin/knowledge | `sources:write` | apps/admin/src/views/KnowledgeAdminView.vue:257 | ✗ 无 |
| `getAdminKnowledge` | GET /admin/knowledge/{id} | `sources:read` | apps/admin/src/views/KnowledgeAdminView.vue:154 | ✗ 无 |
| `editKnowledgeDraft` | PATCH /admin/knowledge/{id} | `sources:write` | apps/admin/src/views/KnowledgeAdminView.vue:272 | ✓ admin-ui-content-api.test.mjs |
| `publishKnowledge` | POST /admin/knowledge/{id}/publish | `sources:write` | apps/admin/src/views/KnowledgeAdminView.vue:298 | ✓ admin-ui-content-api.test.mjs |
| `withdrawKnowledge` | POST /admin/knowledge/{id}/withdraw | `sources:write` | apps/admin/src/views/KnowledgeAdminView.vue:324 | ✗ 无 |
| `listAdminRegistration` | GET /admin/registrations | `sources:read` | **无（缺口）** | ✗ 无 |
| `createRegistrationDraft` | POST /admin/registrations | `sources:write` | **无（缺口）** | ✗ 无 |
| `getAdminRegistration` | GET /admin/registrations/{id} | `sources:read` | **无（缺口）** | ✗ 无 |
| `editRegistrationDraft` | PATCH /admin/registrations/{id} | `sources:write` | **无（缺口）** | ✗ 无 |
| `publishRegistration` | POST /admin/registrations/{id}/publish | `sources:write` | **无（缺口）** | ✗ 无 |
| `withdrawRegistration` | POST /admin/registrations/{id}/withdraw | `sources:write` | **无（缺口）** | ✗ 无 |
| `listAdminRestriction` | GET /admin/restrictions | `sources:read` | **无（缺口）** | ✗ 无 |
| `createRestrictionDraft` | POST /admin/restrictions | `sources:write` | **无（缺口）** | ✗ 无 |
| `getAdminRestriction` | GET /admin/restrictions/{id} | `sources:read` | **无（缺口）** | ✗ 无 |
| `editRestrictionDraft` | PATCH /admin/restrictions/{id} | `sources:write` | **无（缺口）** | ✗ 无 |
| `publishRestriction` | POST /admin/restrictions/{id}/publish | `sources:write` | **无（缺口）** | ✗ 无 |
| `withdrawRestriction` | POST /admin/restrictions/{id}/withdraw | `sources:write` | **无（缺口）** | ✗ 无 |
| `listAdminCategories` | GET /admin/categories | `sources:read` | apps/admin/src/views/CategoriesView.vue:86 | ✓ admin-ui-content-api.test.mjs |
| `editCategory` | PATCH /admin/categories/{id} | `sources:write` | apps/admin/src/views/CategoriesView.vue:171 | ✓ admin-ui-content-api.test.mjs |
| `listAdminUsers` | GET /admin/accounts | `accounts:read` | apps/admin/src/views/AccountsView.vue:64 | ✓ admin-ui-api.test.mjs |
| `suspendUser` | POST /admin/accounts/{id}/suspend | `accounts:suspend` | apps/admin/src/views/AccountsView.vue:162 | ✓ admin-ui-suspend-api.test.mjs |
| `listAdministrators` | GET /admin/administrators | `scopes:read` | apps/admin/src/views/AdministratorsView.vue:74 | ✓ admin-ui-administrators.test.mjs |
| `listAdministratorScopes` | GET /admin/administrators/{id}/scopes | `scopes:read` | apps/admin/src/views/AdministratorsView.vue:146 | ✓ admin-ui-administrators.test.mjs |
| `listAdminJobs` | GET /admin/jobs | `jobs:read` | apps/admin/src/views/JobsView.vue:80 | △ 仅 render：admin-ui-jobs-render.test.mjs |
| `cancelAdminJob` | POST /admin/jobs/{id}/cancel | `jobs:cancel` | apps/admin/src/views/JobsView.vue:159 | △ 仅 render：admin-ui-jobs-render.test.mjs |
| `listFlags` | GET /admin/feature-flags | `flags:read` | apps/admin/src/views/FlagsView.vue:63 | ✗ 无 |
| `setFlag` | PUT /admin/feature-flags/{key} | `flags:write` | apps/admin/src/views/FlagsView.vue:147 | ✗ 无 |
| `listFlagAuditEvents` | GET /admin/flag-audit-events | `flags:read` | apps/admin/src/views/FlagAuditView.vue:68 | ✓ admin-ui-flag-audit.test.mjs |
| `listAuditEvents` | GET /admin/audit-events | `audit:read` | apps/admin/src/views/AuditEventsView.vue:66、apps/admin/src/views/CategoriesView.vue:179、apps/admin/src/views/KnowledgeAdminView.vue:332、apps/admin/src/views/SourcesView.vue:328 | ✓ admin-ui-audit-events.test.mjs |
| `listAuditLogs` | GET /admin/audit-logs | `audit:read` | apps/admin/src/views/AuditLogsView.vue:72 | ✓ admin-ui-audit-logs.test.mjs |
| `listAdminPosts` | GET /admin/posts | `sources:read` | apps/admin/src/views/ModerationQueueView.vue:129 | ✓ admin-ui-moderation-queue.test.mjs |
| `getAdminPost` | GET /admin/posts/{id} | `sources:read` | apps/admin/src/views/ModerationQueueView.vue:149 | ✓ admin-ui-moderation-queue.test.mjs |
| `approvePost` | POST /admin/posts/{id}/approve | `sources:write` | apps/admin/src/views/ModerationQueueView.vue:303 | ✓ admin-ui-moderation-queue.test.mjs |
| `rejectPost` | POST /admin/posts/{id}/reject | `sources:write` | apps/admin/src/views/ModerationQueueView.vue:303 | ✓ admin-ui-moderation-queue.test.mjs |
| `hidePost` | POST /admin/posts/{id}/hide | `sources:write` | apps/admin/src/views/PostTakedownView.vue:89 | ✓ admin-ui-post-takedown.test.mjs |
| `logoutAdmin` | POST /admin/auth/logout | `session:logout` | apps/admin/src/auth/session.ts:147 | ✗ 无 |
| `getAdminSession` | GET /admin/auth/session | `session:read` | apps/admin/src/auth/session.ts:73 | ✗ 无 |

## 7 边界与未做

- **未审** 14 个业务视图的样式、无障碍与文案质量；本页只判「有没有入口、调了哪个端点」。
- **未运行**任何测试/构建：§5 的覆盖判定是**静态引用判定**（函数被调用 + 断言形态出现），不是执行结果；「✓」不等于该用例当前是绿的。
- **测试列 ✗ 的含义**是「没有 `admin-ui-*` 层的覆盖」，不代表服务端无覆盖——例如 `cancelAdminJob` 的 lib 有 `tests/unit/admin-jobs-api.test.mjs`，`getAdminSession` 契约级有 `tests/unit/auth-routes.test.mjs` 等。
- 页首口径两套（44 / 42）；本页 §6 给全 44 条，能力地图本页按 42 条口径叙述。改动任何计数前先确认分母。
- **门禁盲区（实测）**：`tools/verify-doc-anchors.mjs` 的 `ANCHOR_EXTENSIONS` 不含 `vue`（只认 `mjs/cjs/js/jsx/ts/tsx/json/jsonc/sql/md/yml/yaml/css/html/py/sh/ps1/toml`）⇒ 本页 §6「UI 入口」列的 `*.vue:行` **不受该门禁校验**，门禁变绿不能证明这些行号对。这些行号由 §1 脚本逐条从文件里算出（`fn(` 命中行）；同页的 `.ts` 锚点则受校验（负控制：把 `services/api/src/routes/admin.ts:4` 改成 `:99999` 会新增 1 条 OUT_OF_RANGE 并 exit 1）。
