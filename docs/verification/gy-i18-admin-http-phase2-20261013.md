# GY-I18 阶段 2 · 后台 34 个 operationId 的 HTTP 路由与产品装配（验证记录）

日期：2026-10-13。分支 `feat/gy-i18-admin-http`（fork `Yu0ry/GengYun_Write`）。**Refs #18，不关闭整项。**

- 基线（**每次推送前同步上游**）：开工时 `upstream/main = 54ed689c`；随后按序合并 `b1f6ab0e`（含 `#104` 标签 OCR）、`3e8f89b`（含 `#107` 产品装配事实源、`#108`/`#109`/`#113`/`#115`）、`769420a`（`#106` 跨 kind 作业读面/取消面）、`5c66f43`（`#116`/`#119`/`#120`）、`f7e0053`（轻量审查规范）。
- 本记录对应的分支 HEAD：本次返修提交（`app.ts` real⇒fail-closed + `admin/fail-closed-services.ts` + 2 条用例 + §10）；**由指挥推送**（本工作区账号无推送权限）。
- **不代替监工独立验收**；**不声称 CI 通过**（原因见下「CI 说明」）。

## 0. CI 说明（**归因更正**）

**CI 当前不可用：账号级 Actions 计费/支出限额限制（GitHub `Billing & plans`）⇒ runner 不启动；连 `upstream/main` 头同样全红；与任何 PR 无关。故本片不声称 CI 通过。**

已确证的实测事实：

- 失败 job 的**逐字注解**（经 API 取 `…/check-runs/<id>/annotations`）：
  `The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings`
- 该 job 的 `jobs` **无任何 step 记录**、日志 `BlobNotFound` ⇒ **runner 从未启动**；
- **`upstream/main` 头同样全红（13/13）** ⇒ 与任何 PR 的 diff 无关；更早的基 `b1f6ab0` 曾 **14/14 success** ⇒ 属**账号状态变化**。

（另有一件**独立**的事：fork PR 的 workflow 批准门——需在 PR 页面点 "Approve and run workflows"。**它不是本仓库 CI 未跑的原因**，本记录此前把它当作主因的写法已更正。）

> 本文件是**仓库内证据**：本片的三处联动（① `#107` 事实源同步、② 路由模板内联、③ 跨线修改 `#107` 测试 1 行）与 `evidence.lines` 修正都写在这里，供**代码侧读者**在看不到 PR 正文时核对。PR 正文亦有同内容章节。
>
> **合并 `769420a`（#106）时的冲突解决**：`services/api/src/app.ts` **仅 1 个 hunk** —— `#106` 的 `registerJobRoutes(...)` 块与本片 `registerAdminRoutes(...)` 落在**同一插入点**。解决方式：**两侧全保留、各就各位**，把 `#106` 的块留在 **upstream 原有的位置**（`registerOcrRoutes` 之后），本片 `registerAdminRoutes` 追加其后；**未重排、未删改任何既有行**（三点式 `git diff upstream/main...HEAD -- app.ts` 里，`registerJobRoutes`/`registerOcrRoutes`/`registerSynthesisRoutes` 及其 import 均为**上下文行**，唯一的 `+` 只属本片）。

## 1. 交付面

`services/api/src/routes/admin.ts` 暴露契约 **34 个 operationId**：阶段 1（`#96`）25 个（四类资料 × 6 + `listAuditEvents`）+ 阶段 1b（`#101`）9 个。`app.ts` **只追加**（唯一改动的既有行是 `buildApp` 形参解构末尾追加 `adminInjection`；未重排/格式化任何既有 import 或注册行）。

## 2. HTTP 实测映射表（**每行状态码来自真实请求**；出处＝`tests/integration/admin-http.mjs` 的 `probe()`）

运行：`node tests/integration/admin-http.mjs` → **映射表覆盖 34 / 34；PASS 组数=27，FAIL 组数=0**。

| operationId | method | path | 实测状态码 |
| --- | --- | --- | --- |
| `createSourceDraft` | POST | `/admin/sources` | 201 |
| `getAdminSource` | GET | `/admin/sources/{id}` | 200 |
| `editSourceDraft` | PATCH | `/admin/sources/{id}` | 200 |
| `publishSource` | POST | `/admin/sources/{id}/publish` | 200 |
| `listAdminSources` | GET | `/admin/sources` | 200 |
| `withdrawSource` | POST | `/admin/sources/{id}/withdraw` | 200 |
| `createKnowledgeDraft` | POST | `/admin/knowledge` | 201 |
| `getAdminKnowledge` | GET | `/admin/knowledge/{id}` | 200 |
| `editKnowledgeDraft` | PATCH | `/admin/knowledge/{id}` | 200 |
| `publishKnowledge` | POST | `/admin/knowledge/{id}/publish` | 200 |
| `listAdminKnowledge` | GET | `/admin/knowledge` | 200 |
| `withdrawKnowledge` | POST | `/admin/knowledge/{id}/withdraw` | 200 |
| `createRegistrationDraft` | POST | `/admin/registrations` | 201 |
| `getAdminRegistration` | GET | `/admin/registrations/{id}` | 200 |
| `editRegistrationDraft` | PATCH | `/admin/registrations/{id}` | 200 |
| `publishRegistration` | POST | `/admin/registrations/{id}/publish` | 200 |
| `listAdminRegistration` | GET | `/admin/registrations` | 200 |
| `withdrawRegistration` | POST | `/admin/registrations/{id}/withdraw` | 200 |
| `createRestrictionDraft` | POST | `/admin/restrictions` | 201 |
| `getAdminRestriction` | GET | `/admin/restrictions/{id}` | 200 |
| `editRestrictionDraft` | PATCH | `/admin/restrictions/{id}` | 200 |
| `publishRestriction` | POST | `/admin/restrictions/{id}/publish` | 200 |
| `listAdminRestriction` | GET | `/admin/restrictions` | 200 |
| `withdrawRestriction` | POST | `/admin/restrictions/{id}/withdraw` | 200 |
| `listAdminCategories` | GET | `/admin/categories` | 200 |
| `editCategory` | PATCH | `/admin/categories/{id}` | 200 |
| `listAdminUsers` | GET | `/admin/accounts` | 200 |
| `suspendUser` | POST | `/admin/accounts/{id}/suspend` | 200 |
| `listAdminJobs` | GET | `/admin/jobs` | **503**（默认装配未接线）/ 200（注入参考端口） |
| `cancelAdminJob` | POST | `/admin/jobs/{id}/cancel` | **503**（未接线）/ 200（注入后）；终态 ⇒ 409 `OBJECT_UNAVAILABLE` |
| `listFlags` | GET | `/admin/feature-flags` | 200 |
| `setFlag` | PUT | `/admin/feature-flags/{key}` | 200 |
| `hidePost` | POST | `/admin/posts/{id}/hide` | 200（已接线）/ **503**（未接线） |
| `listAuditEvents` | GET | `/admin/audit-events` | 200 |

默认装配下的 `503 PROVIDER_UNAVAILABLE`（`retryable: true`，**响应无 `data`**）是**有意**的 fail-closed：**不返回空页**——空页会被读成"平台当前没有作业"，那是无法确认的结论，等于伪造平台状态。

## 3. 本片在**装配层**发现并修复的缺陷：双台账 ⇒ 审计漏记

阶段 1 与阶段 1b **各自在服务层内**建 `AdminRuntime`，单独看都对；**只有装配到一起**才暴露"两份审计台账"：`GET /admin/audit-events`（阶段 1 操作，读内容 store 的审计流）**读不到**分类/账号/作业/开关/隐藏帖子五类写操作的审计。

- **修法只在装配层**：`app.ts` 建**唯一一个** `createAdminRuntime()` 注入两个 store 工厂；`services/api/src/admin/**` 服务层**一行未改**。
- **两条回归**：`[审计统一 · 回归] 五类新写操作的审计都必须可经 GET /admin/audit-events 读到（按目标核对）`、`[审计统一 · 回归] 装配后审计台账**唯一**（结构断言 + 默认装配实跑；防将来再加一个 runtime）`。
- **回退-复跑**：改回"各建一个" ⇒ 上述第二条失败（`默认装配：阶段 1 与阶段 1b 必须共用同一份审计台账`，`PASS 26 / FAIL 1`）；另有诊断在 HTTP 层复现原症状：`setFlag` 返回 **200** 且开关确实变化，但 `flag.set` **读不到**、审计条数 `0 → 0`；恢复后 `shared=true`、`0 → 1`。

## 4. 钉子用例

- `tests/unit/admin-routes-nail.test.mjs`：钉子 1 **两层分工**（非法 uuid ⇒ 400 `INVALID_REQUEST`，合法但不存在 ⇒ 404 `NOT_FOUND`，**不得混同**；与 #10/#106 的钉子同一口径）；钉子 2 **契约 34 项 method+path 逐条已注册**（读 `openapi.json` 原文核对）；钉子 2b `setFlag` 的 `key` **不**在 HTTP 层按闭集拦下（否则服务层的 `denied` 审计永远不会产生）。
- `tests/unit/admin-route-family-consistency.test.mjs`（**本次新增，钉住内联带来的双份来源**）：`FAMILIES` 的 `path` 必须与 `routes/admin.ts` 的**字面**注册路径一致（三条：字面出现、家族路径互不相同、运行时 `hasRoute` 六形态 × 四家族）。
  - **变异验证**：把 `families.ts` 的 sources `path` 改成 `/admin/source` ⇒ 该文件 **2/3 用例失败**（`routes/admin.ts 里必须字面出现 …`、`… 必须在 GET /api/v1/admin/source 上真实注册`）；还原后恢复 3/3。
  - 风险说明：内联后路径有**两处来源**——① `families.ts` 的 `descriptor.path`（**服务层仍用它构造幂等键域**）、② `routes/admin.ts` 的字面模板。只改 ① 会**静默换掉幂等键域而不改路由**，故必须钉住。

## 5. 与 main 合成的三处联动（**披露**）

### 5.1 跨线改动：`#107`（cxhhandsome）的测试删 1 行负例

`tests/unit/contract-status-tool.test.mjs:162` 原先**硬编码**断言 `get /admin/sources` 不得被装配；本片**正是装配它的 PR**，该期望因此**陈旧**。改动仅此 1 行：

```diff
-  for (const key of ['get /posts', 'get /messages', 'get /admin/sources']) assert.equal(mounted.has(key), false, key);
+  // GY-I18 阶段 2（Refs #18）：原 `'get /admin/sources'` 负例已删除 —— 后台 34 条路由已装配
+  // （`services/api/src/routes/admin.ts`），该期望被新事实推翻；`/admin/**` 现已**无**未装配的
+  // 代表路由（37 条全部装配），故无法替换为其它 admin 负例。社区/消息的负例完整保留。
+  for (const key of ['get /posts', 'get /messages']) assert.equal(mounted.has(key), false, key);
```

`get /posts`、`get /messages` 两个负例**完整保留**，本用例 `:159`/`:160` 主校验未动，**未放宽任何语义**。**"替换为其它未装配 admin 负例"不可行**：实测扫描器输出，契约 `/admin/**` 操作 **37 条、未装配 = 0**（静态扫描 mounted 总数 66）。**若需回退，回退这一行即可**，本变更其余部分与之独立。**请监工确认**（该文件属 #107）。

### 5.2 同步 `#107` 建立的产品装配事实源（只改 docs）

`docs/architecture/contract-status.json`：本片 34 条 `route_mounted: false → true`；`evidence` 前置 `services/api/src/routes/admin.ts`（**逐操作**行区间，见 §5.4）与 `tests/integration/admin-http.mjs`（用例名取脚本内原文——校验器以 `text.includes(name)` 核对）；`blocker` **只**去掉"未装配此业务路由"从句；**`status` 保守保持 `partial`**；**非本片条目零改动**（未增删任何 `id`/`method`/`path`；`route_mounted=false` 由 80 条降为 46 条）。

`docs/verification/gy-i01-contract-status-refresh-20261013.md`：**追加**一条带日期与署名的「修订」（不改写 #107 原结论），更正装配计数 **32/80 → 66/46**。

### 5.3 路由模板内联（**与项目既有机制对齐，不是绕过校验**）

静态路由清单工具 `tools/contract-status-core.mjs` 的 `scanMountedRoutes` **只原生支持** `${API_PREFIX}` 与 `${kind}` 两种模板变量；原先的 `const base = \`${API_PREFIX}${descriptor.path}\`` 再 `app.get(base, …)` 属**两步拼接**，被判 `Unresolved route template: services/api/src/routes/admin.ts`（既让 `tools/verify-contract-status.mjs` 报错，也让 **CI 的 `test:unit`** 失败）。故把 24 条家族路由逐条内联为 `` `${API_PREFIX}/admin/sources` `` 等字面模板。注册点数量不变（`app.<method>(` **34 处**、`registerAdminRoutes` **1 个调用点**）；路径/方法/operationId/scope/行为一律不变；未改服务层与其它文件。

### 5.4 修正 `evidence.lines`（预审 P1）

内联使 `routes/admin.ts` 行号整体位移，而首版 `evidence.lines` 取自内联**之前** ⇒ 26/34 条指向错误行，且 24 条家族条目**共用**一个大区间（非逐操作锚点）。已按**当前提交**逐条重取，**每条只覆盖它自己的注册块**：

```
check-evidence HEAD: checked=34  ok=34  MISMATCH=0  区间独占性违规=0
```

（判据：JSON `lines` 必须**恰好**等于该 method+path 在 `git show <rev>:services/api/src/routes/admin.ts` 里的注册块区间；并额外断言该区间内**只有 1 个** `app.<method>(` 起手行 = 区间独占。检查脚本为临时脚本，未入仓；若监工认为该判据应常驻，可再单独提案入 `tools/`——那属于改动 #107 的工具面，需单列披露。）

## 6. 门禁与既有域（本机实跑）

```
$ npm run lint          → PASS tsc(api) / PASS tsc(admin) / PASS 仓库卫生扫描
$ npm run test:unit     → ℹ tests 1651 / pass 1650 / fail 0 / skipped 1      （含本片钉子与返修用例）
$ npm run test:contract → ℹ tests 6 / pass 6 / fail 0
$ npm run test:docs     → PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
$ git diff --check      → (无输出)
$ node tests/integration/admin-http.mjs → 映射表覆盖 34 / 34；PASS 组数=27，FAIL 组数=0
$ node tests/integration/jobs-http.mjs  → 15 组 PASS，exit=0（#106 已在 main）
$ node tests/integration/recognitions-http.mjs → exit=0
$ node tests/integration/speech-http.mjs       → exit=0（返修后复跑：我的注释曾打破其结构性断言，见 §10.4）
$ node tests/integration/tts-http.mjs          → exit=0
$ node tests/integration/ocr-http.mjs          → exit=0
```

## 7. 既有失败归因（**非本片引入，未修改**）

`node tools/verify-contract-status.mjs` 在**纯 `upstream/main`（`769420a`，不含本片任何文件）**上同样 `exit=1`、**5 项**：

```
ERROR: delete /me/consents/{purpose}: services/api/src/privacy/consent-pg.ts lines=140-183 越界
ERROR: post /jobs/{id}/cancel: services/api/src/routes/recognitions.ts lines=130-134 越界
ERROR: get /knowledge: services/api/src/knowledge/service.ts lines=14-80 越界
ERROR: get /knowledge/{id}: services/api/src/knowledge/service.ts lines=60-69 越界
ERROR: dimension timeout: services/api/src/knowledge/service.ts lines=74-78 越界
FAIL: 契约实现状态对照校验未通过（5 项）
```

在 `3e8f89b` 上是 **4 项**；合并 `769420a`（`#106` 把 `/jobs/{id}/cancel` 的注册从 `routes/recognitions.ts` 迁到 `jobs/routes.ts`）后**新增第 5 项**——状态表里该条 `evidence.lines` 仍指向 `recognitions.ts:130-134`，已越界。该项**由 #106 引入**，在纯 main 上同样存在，**不属本片**。

复现方式：`git worktree add --detach <tmp> upstream/main` + 软链 `node_modules` 后直接运行该工具。⇒ 本片合并后该工具**恰好只剩这 5 项**（本片新增 0 项），且**未修改**它们（不属本片范围）。

## 8. 未取得（如实登记，不得外推）

真实 PostgreSQL 持久化（全内存 store，重启即丢，无迁移）；**真实平台作业端口**（`AdminJobPort` 默认未接线，读/写都 503，已接线路径只用内存参考端口验证）；后台页面（`apps/admin/**` 不在本单）；全局开关/账号停用与业务链路联调；社区路由未装配（`hidePost` 的"公开读不可见/作者仍可见"用**社区服务层**在同一 store 上断言）；真机。

### 8.1 已知后续项：`/admin/jobs` 与 `#106` 作业注册表的关系（**本片不动手**）

`#106`（`769420a`）已为**用户面** `/jobs/{id}` 与 `/jobs/{id}/cancel` 提供真实作业注册表（`services/api/src/jobs/registry.ts`，按 kind 分派识别域 + 转写域）；而本片的后台面 `/admin/jobs`（`listAdminJobs`/`cancelAdminJob`）仍走 `AdminJobPort` 且**默认未接线 ⇒ 503**。

- 两者**形状与受众不同**：`#106` 是按 id 的读/取消（`JobEnvelope`，用户 scope）；`listAdminJobs` 是**平台级跨 kind 列表**（`AdminJob`，含 `kind`/`state`/`revision`，后台 scope）——注册表面向"按 id 取源"，不提供列表面。
- `AdminJobPort` 的形状与"未接线 ⇒ 503、**不返回空页**"是**阶段 1b 派单的裁定语义**；复用需改端口契约 ⇒ 超出本片"只读复用服务层"的边界。
- **正确做法（后续单）**：在 `AdminJobPort` **之下**加一个"基于该作业注册表"的适配器，把 `/admin/jobs` 接真（届时 503 应变为真实列表）。本片**不改端口契约、不加适配器**。

## 9. 自查

- 只用 `Refs #18`，**不使用关闭关键字**；不声称验收通过、不声称 CI 通过。
- `app.ts` 只追加；未触碰 `packages/**`、契约、`db/**`、`apps/admin/**`、`miniprogram/**`、`tools/prepare-wechat.mjs`、根 `package.json`/lock、`.github/**`、他人路由文件、`services/api/src/jobs/**`；`services/api/src/admin/**` 服务层未改。
- 未放宽/删除任何**安全语义**断言；跨线改动（#107 测试 1 行）已在此处与 PR 正文显著披露，且一行可回退。

## 10. 返修记录 · 监工批复 P1：**real 默认装配必须运行时 fail-closed**

**批复原文（监工 `gengyun-supervisor[bot]`，CHANGES_REQUESTED）**：

> **P1仍在 services/api/src/app.ts 后台装配：默认内存 content/ops store 却传入 real executionMode，真实模式写操作可能以成功封套修改易失内存**；当前全绿CI不能证明未接持久端口的真实业务可用。**请在未接真实存储时明确 fail-closed 或准确限制替身模式，并验证 real 默认装配反例。**

### 10.1 缺陷（已复现，含量化）
`executionMode === 'real'` 时，`app.ts` 把 `config.executionMode` 原样交给后台服务，而 store 仍是**内存**实现（`persistent === false`）：写操作返回**成功封套**（`data` + `meta.execution_mode='real'`），落点只是**易失内存**——"真实模式"下声称成功、重启即丢。

**改前量化探针**（real + 默认内存 store，19 次调用）：**13 次返回成功封套（<400）**，其中含 4 条 `create*`（201）与 `setFlag`（200）；其余为 `404`（默认无种子）与端口级 `503`。

### 10.2 修法（沿用本仓既有口径）
- 新增 `services/api/src/admin/fail-closed-services.ts`：后台域的**整体 fail-closed 替身**——方法名 = 契约 operationId（25 + 9，逐条显式列出，非 Proxy），每次调用抛 `ApiError('PROVIDER_UNAVAILABLE', …, { retryable: true })`，由 `app.ts` 的 errorHandler 映射为契约内的 **503 `ErrorEnvelope`**；**不写审计、不定型幂等、无任何内存副作用**。
- `services/api/src/app.ts`：判定条件为 **`config.executionMode === 'real'`** ⇒ 使用该替身（并在装配期 `app.log.warn` 记日志）；否则照旧构造真实服务。
- **34 条路由保持注册**（契约面不缩水；静态清单工具与既有回归不受影响），只是运行时一律拒绝。
- **依据**：本仓对"real 模式没有真实后端"的一贯口径就是 **real 永远走 fail-closed 实现、严禁静默回退替身**（同 `auth` 侧"real 必须持久化存储，否则拒绝签发会话"）。
- **刻意不依赖任何"自述持久化"的布尔标志**：将来后台域接上真实持久后端时，必须在 `app.ts` **显式放行**（一次可审查的接线变更），而不是靠替身自称真实就自动启用 —— 否则"把替身记为真实成功"仍可能发生（按更新后的审查规范，该情形**仍属阻塞**）。

### 10.3 测试（验收重点，最小必要）
新增 `tests/unit/admin-real-mode-fail-closed.test.mjs`（2 条，全过）：
1. **【监工要求的反例】** `real 默认装配反例：34 条后台路由一律 fail-closed（503 PROVIDER_UNAVAILABLE），零成功封套、零内存副作用`
   —— 覆盖**全部 34 个 operationId**；断言状态码 503、`error.code='PROVIDER_UNAVAILABLE'`、`retryable=true`、**无 `data`**；断言 34 条路由**仍注册**；断言两本审计台账**均为空**（零内存副作用）。
2. `stub 默认装配行为不变（内存实现仍可用且确会写内存）——改动只对 real 拒绝`
   —— stub 下 `listFlags` 200（3 键默认全 false）、`setFlag` 200、`createSourceDraft` 201，且**确有**内存审计写入；端口级 503（作业端口未接线）仍成立。说明改动**只对外拒绝 real**，未改变 stub 语义。

**改前失败 → 改后通过**（同一用例，临时还原 `app.ts` 到 HEAD 后复跑，跑完即刻恢复）：

```
改前：✖ real 默认装配反例…  AssertionError: GET /api/v1/admin/sources 在 real 默认装配下必须 503，实际 200
      ℹ tests 2 / pass 1 / fail 1
改后：✔ real 默认装配反例…  ℹ tests 2 / pass 2 / fail 0
```
同一探针改前/改后：**13/19 → 0/19 成功封套**。

### 10.4 顺带发现并修掉的一处**自身回归**（如实记录）
修 P1 时我在 `app.ts` 注释里写了"见 `speech/provider.ts` 的 `createSpeechProvider`…"，**该注释文本**触发了 `tests/integration/speech-http.mjs` 的结构性 default-off 断言（它要求 `app.ts` 里出现 `speech/{store,provider,media}` 的**每一行**都只能是 `import type`，运行时擦除）⇒ `speech-http.mjs` **exit=1**。已把该文件提及从 `app.ts` 注释中删去（口径说明改写在本文档 §10.2），复跑 `speech-http.mjs` **exit=0**。教训：**跨域结构性断言会扫描注释文本**，注释里不要引用他人模块路径。

### 10.5 剩余阻塞（**不得**用 `contract-status=partial` 替代运行时 fail-closed）
**未接真实持久存储**（`packages` 侧无后台 PG store）仍是本片的**剩余阻塞**：`real` 下后台业务**不可用**（503），`stub`/`preset_demo` 下才是可用的内存实现。**#18 整体仍开放、整项未验收**；本记录如实登记，不把任何未接端口写成可用。
