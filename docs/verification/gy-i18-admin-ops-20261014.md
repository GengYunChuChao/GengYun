# GY-I18 · 独立后台：资料、账号、AI 任务及功能开关（验证记录）

日期：2026-10-14。分支 `feat/gy-i18-admin-ops-r2`（自建 worktree `GengYun_W29`，**由指挥推送**）。

- 基线：`upstream/main = fcfa6de9d62aeaaa0489d3319f8f06911312af48`（开工即此 SHA，全程未变）。
- 本记录对应 HEAD：见本文件所在提交（`git rev-parse HEAD`）。**Refs #18，不关闭整项。**
- **不代替监工独立验收**；**不声称 CI 通过**（见 §0）。

## 0. CI 说明（**不要据"CI 全绿"推断本记录**）

- `tests/integration/**` **不在任何 CI glob 内**：根 `package.json` 的 `test:unit` 只收
  `tests/unit/*.test.mjs`、`tests/privacy/*`、`tests/media/*`、`tests/reference/*`。
  本片修改并运行的 `tests/integration/admin-http.mjs` 是**作者显式运行**的证据
  （命令与原始输出见 §7），**是否纳入 CI 由维护者裁定**。
- 本片不新开任何 CI 配置，也未取得任何 CI 运行结果；CI 状态与账号级 Actions 计费/限额等
  既有归因见 `docs/verification/gy-i18-admin-http-phase2-20261013.md` §0（未在本片复核）。

## 1. 本片解决的问题（逐条对上派单范围）

阶段 1b（已合并 `#101`）把 3 个开关**存起来**了，但**没有任何输出面消费它**：
`listFlags` 说"药剂输出已关闭"，`/herbicides` 照常产出 —— 开关是装饰性的。
本片把开关变成**真实生效**，并补齐来源引用失效、读取时重查、审计责任、人审空态四块缺口。

| 派单要求 | 实现落点 | 证据（用例名） |
| --- | --- | --- |
| 全局开关**跨端点真实生效**：关闭 ⇒ 拒绝且**不产出**可执行建议/用量卡 | `services/api/src/admin/ops/flag-gate.ts` + `app.ts` 装配 | `admin-flag-gate.test.mjs` C / E2 / E4 |
| **未识别取值 fail-closed** | 同上（`createStoreFlagReader` 把"不可识别"建模成 `null`） | B3 / B4 / E5 |
| 开关**不得改变适用判定结论**（只决定是否产出） | 闸门只做"调用前断言"，不参与判定 | D（开启时逐字节相同；关闭时是拒绝而非改过的结论） |
| 来源**修改/下架 ⇒ 引用同步失效**；下架后缓存与详情同步（不得复活，要有负例） | `services/api/src/admin/reference-integrity.ts` + `public-view.ts` + `service.ts` 发布门槛 | `admin-reference-invalidity.test.mjs` 1 / 2 / 3 / 4 / 5 / 6 |
| 后台**列表/详情在读取时重查**对象权限与当前可见性 | 既有 `resolveOwned`/投影 + 本片 `public-view` 读取时重算 | `admin-read-time-recheck.test.mjs` R1 / R2 / R2b / R3 |
| 关键修改（来源／版本／分类／限制规则）留**责任人与范围** | `service.ts` 四类 `edit` 审计 + 来源发布/撤回的范围字段 | `admin-ops-governance.test.mjs` G1a / G1b；`admin-reference-invalidity.test.mjs` 6 |
| **普通账号不能管理或绕过硬规则** | 既有 scope 门 + 本片用例；禁用类开关 key 显式拒绝 | G2 / G3 / G4 / G5 / G5b / G8 |
| **不把基础账号管理说成人工评审完成**；人审入口**空态** | `services/api/src/admin/human-review.ts`（空态声明 + 唯一入口一律拒绝） | G6a / G6b / G7 |

## 2. 全局开关闸门：装在哪、怎么跨端点生效

**新增** `services/api/src/admin/ops/flag-gate.ts`（**不改**任何受控面的实现文件）：

1. **受控面清单** `FLAG_GATED_SURFACES`（契约镜像，由 `admin-flag-gate.test.mjs` A 逐条对
   `packages/contracts/operations.json` 比对，防漂移）：

   | 开关 key | operationId | method + 路由模板 |
   | --- | --- | --- |
   | `specific_herbicide_output_enabled` | `listHerbicides` / `getHerbicide` | `GET /api/v1/herbicides` / `GET /api/v1/herbicides/:id` |
   | `submissions_enabled` | `createPost` / `createComment` | `POST /api/v1/posts` / `POST /api/v1/posts/:id/comments` |
   | `ai_enabled` | `createRecognition` / `createOCR` / `createTranscription` / `createSynthesis` | `POST /api/v1/recognitions` / `/ocr` / `/speech/transcriptions` / `/speech/synthesis` |

2. **跨端点接线方式（`app.ts` 装配，唯一改动点）**：
   `createFlagGatedGuards(guards, gate)` 包装 `AuthGuards.requireUser`，把包装后的 `guards` 传给
   `registerKnowledgeRoutes` / `registerRecognitionRoutes` / `registerSpeechRoutes` /
   `registerSynthesisRoutes` / `registerOcrRoutes`。**顺序刻意写死为"先鉴权、后判开关"**：
   未登录仍是 401、后台越权仍是 403（错误码次序与接线前逐字相同），开关状态**不泄露**给未鉴权调用方
   （用例 E3）。后台自身的 34 条路由**不接受**本层判定（`requireAdmin`/`requireScope` 原样透传，F2）。
3. **判定语义**：
   - 已配置 `enabled: false` ⇒ **`OBJECT_UNAVAILABLE`(409), retryable:false**（确定性关闭，不是暂时故障）；
   - 行缺失 / `enabled` 非布尔 / `key` 越出契约闭集 / 读取抛错 ⇒ **`PROVIDER_UNAVAILABLE`(503), retryable:true**（fail-closed，**绝不**把"读不到"当"开着"）；
   - **零产出**：关闭时被包装的产出方**一次都不会被调用**（用例 C 以调用计数＝0 钉住，而不是"产出后丢弃"）；
   - **不改判定结论**：用例 D 证明开启时经闸门与不经闸门**逐字节相同**、入参未被改写，关闭时**没有**任何新结论产生。
4. **装配基线（`FLAG_WIRING_BASELINE`）+ 播种**：`app.ts` **自建** ops store 时按基线播种
   （`specific_herbicide_output_enabled: true`、`ai_enabled: true`、`submissions_enabled: false`），
   使"接口自述"与"输出面是否真的在产出"一致。
   **理由**：该 3 键的工厂默认是 `false`（最严格一侧）；若直接接到门上，`/herbicides` 与 AI 受理面会
   在**默认装配**下不可用 —— 且这不是更安全，而是"接口说关闭、实际在产出"的另一种失真。
   服务层工厂 `createAdminOpsStore()`（不播种）的出厂默认**仍是全 `false`**，由既有单测继续钉住
   （`admin-ops-rejections.test.mjs` 等）；**注入 store 的实例不覆盖**（测试可自带状态做反例）。
5. **real 模式（后台域未接持久存储）**：`app.ts` 判 `executionMode === 'real'` ⇒ 后台域整体
   fail-closed（既有口径），此时开关**没有权威来源**，闸门 `armed:false`：**保持既有产出行为**，
   不拿一个未接线的开关去中断用户面。这是**装配层的显式决定**并如实登记为未取得项（§8），
   不是 `fail-open` 的静默回退；一旦后台域接上真实持久 store，开关在 real 即权威。

## 3. 来源修改/下架 ⇒ 引用同步失效（含负例）

**新增** `services/api/src/admin/reference-integrity.ts`。判定是**纯函数 + 每次读取重算**，
**不缓存、不落"失效标记"** ⇒ "缓存或旧链接把隐藏/失效内容复活"在结构上不可能发生。

| 情形 | 判定 | 消费方行为 |
| --- | --- | --- |
| 来源不在本存储（未接真实库，无法核对） | `unverifiable` | 公开读**保持既有可见性**、发布门槛**不拦**（**不谎称失效**，也不阻断既有链路） |
| 来源存在但未发布 | `unavailable` | 公开读 `null`；发布门槛 `SOURCE_CONFLICT`(422) |
| 来源已撤回（下架） | `unavailable` | 同上（**下架即失效**） |
| `source_version` ≠ 来源当前生效版本（改版） | `unavailable` | 同上（**改版即失效**，不是只有下架才失效） |
| 依赖行 `source_id`/`source_version` 缺或非字符串 | `unavailable` | 同上（fail-closed） |

- **公开读口径**（`public-view.ts`，非契约路径、无路由）：依赖不可用 ⇒ `readPublished` 返回 `null`
  且 `isPubliclyVisible` 为 `false`（与"不存在"同形，不泄露存在性）；
  新增 `availabilityOf()` 返回**机读原因**供举证。
- **发布门槛**（`service.ts` 的 `publishDraft`）：只拦**确认失效**（`unavailable`）⇒
  `SOURCE_CONFLICT`(422，契约闭集内)，**先判后写、不部分发布**，并留一条 `denied` 审计。
- **负例（必须）**：用例 2 —— 失效前拿到的公开读副本被改写后，旧链接（同一 id）仍为 `null`，
  存储侧不被副本污染；用例 3 —— 来源改版到新版本后，仍引用旧版本的依赖继续失效（不会因"来源又发布了"而复活）。
- **可恢复**：用例 4 —— 依赖改引新版本并发布 ⇒ 重新可用（失效是**判定**，不是不可逆标记）；
  未重新校验的另两类依赖仍各自失效（逐条判定，不"一刀切恢复"）。
- **`/knowledge`、`/herbicides` 公开路由本身**属 #7 线（读 PG 视图 / 真实公告附表），
  本片**不改**它们；上面的公开读口径是**服务层读面**（`public-view.ts`），
  未接入实际 HTTP 路由 —— 如实登记为未取得项（§8）。

## 4. 读取时重查权限与可见性

- **权限**：`resolveOwned` 在**每次读取**时从存储取 `stewardId` 与请求主体比对；管辖外 ⇒ `NOT_FOUND`
  （与"不存在"同形），列表 ⇒ 空集合（不泄露存在性）。用例 R2 / R2b：把存储里的管辖主体换人后，
  **原主体立刻 404、新主体 200、列表随之切换**（证明没有任何写时快照/缓存）。
- **可见性**：`visibility` / `review_status` 由**当前** `lifecycle` + `publishedRevision` 在读取时投影。
  用例 R1（`private → published → hidden → published`，且失效前的响应副本改写不影响下一次读）
  与 R3（同一次列表里已撤回项 `hidden`、草稿项 `private`；新增草稿后下一次读立刻多出一项）。

## 5. 审计与责任

- **新增**：四类资料的**版本修改**（`editSourceDraft` / `editKnowledgeDraft` /
  `editRegistrationDraft` / `editRestrictionDraft`）此前**不写任何审计** ⇒ 事后无法追责。
  本片补齐 `<noun>.edit` 审计（`reason_code: revision_appended`），并留下：
  - **责任人** = `actor_id`（服务端权威主体；契约 `AuditEvent` 没有主体字段，属既有契约缺口，
    只在内部记录，见 `audit.ts` 说明）；
  - **范围** = `scope`（实际行使的权限）+ `target_ref`（含**新修订号**）+ 内部 `target_hint`
    （来源类：`live=`/`refs=`/`invalidated=`；依赖类：`source=<id>@<version>:state=<判定>`）。
- **来源发布/撤回**的既有审计现在带上**影响范围**（引用了该来源的依赖条数、其中失效条数），
  不新增事件类型、不改变既有事件条数语义。用例：G1a（分类）、G1b（四类编辑）、
  `admin-reference-invalidity.test.mjs` 6（来源撤回范围）。
- **契约投影不变**：`projectAuditEvent` 仍严格只输出合同 8 字段，内部 `actor_id` / `target_hint`
  **不外泄**（G1b / G7 逐条核对键集合）。
- **必须同步的既有断言**（本片新增审计事件的直接后果，改动**只限我这一线的测试**）：
  `admin-content-concurrency.test.mjs` 与 `admin-content-immutability.test.mjs` 各 1 处
  期望序列加入编辑事件（并**加强**断言：主体、scope、内部范围字段、投影不外泄内部字段）。
  另有 `admin-real-mode-fail-closed.test.mjs` 与 `tests/integration/admin-http.mjs` 因**装配基线播种**
  而必须改的取值断言（同值 `setFlag` 按既有幂等语义不迁移、不记审计）。

## 6. 人审入口空态 / 普通账号 / 硬规则

- **新增** `services/api/src/admin/human-review.ts`：`wired:false` + 四个集合
  (`tasks`/`reviewers`/`votes`/`expert_certifications`) **恒为空且冻结**，并给出"为什么是空的"；
  `assertNoReviewClaim()` 是唯一"登记评审结论"入口且**一律拒绝**（`OBJECT_UNAVAILABLE`）。
  装配层 `app.decorate('humanReviewDirectory', …)`，可在回归里直接核对。
- **抗伪造扫描**（G6b）：把**全部后台 operation** 的响应 schema 递归展开，断言**没有任何**
  `reviewer|review_task|reviewed_by|vote|expert|certification` 类字段；并带反向控制
  （扫到的字段数与 schema 数必须 > 阈值，防"什么都没扫到"的假通过）。
- **普通账号不能管理**（G2）：`role=user` 对 **9 个后台操作**一律 403 `SCOPE_DENIED`，
  且**零副作用、零审计**、开关/账号状态不变；G3：只读管理员缺写 scope 同样 403 且状态不变；
  G8：**经 HTTP**（普通用户会话）访问 5 个后台读端点一律 403（不泄露后台资源是否存在）。
- **不能绕过硬规则**（G4）：`hard_rules_enabled`/`moderation_enabled`/`auto_approve`/
  `skip_review`/`fail_closed`/`bypass_hard_rules` 一律 400 `INVALID_REQUEST`
  （`details: SAFETY_CRITICAL_KEY`）+ **每次尝试留一条 `denied` 审计**（含责任人），
  且**不得**因此多出一个开关行；G5：语义分类表出现任何"放宽 fail-closed"条目即**拒绝接线**；
  G5b：引用已失效内容的发布被硬门槛拦下，与任何开关无关。
- **不把基础账号管理说成人工评审完成**（G7）：`suspendUser` 的 action/reason_code 是账号管理语义，
  正则上不含 `review/approv/expert/vote`；账号视图只投影契约 4 字段；审计投影只有合同 8 字段。

## 7. 作者自检清单（命令 + 退出码 + 关键输出）

| # | 命令 | 退出码 | 关键输出（原始） |
| --- | --- | --- | --- |
| 1 | `npm run test:unit` | **0** | `ℹ tests 1840 / ℹ pass 1839 / ℹ fail 0 / ℹ skipped 1`（1 条跳过为既有用例；**含**本片 40 条新用例） |
| 2 | `node --test tests/unit/admin-flag-gate.test.mjs tests/unit/admin-reference-invalidity.test.mjs tests/unit/admin-ops-governance.test.mjs tests/unit/admin-read-time-recheck.test.mjs tests/unit/admin-real-mode-fail-closed.test.mjs` | **0** | `ℹ tests 42 / ℹ pass 42 / ℹ fail 0`（逐条见 §7.1） |
| 3 | `node tests/integration/admin-http.mjs`（**CI 不执行，见 §0**） | **0** | `映射表覆盖 operationId 数：34 / 34` + `PASS 组数=27，FAIL 组数=0` |
| 4 | `npm run lint` | **0** | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）` / `lint 通过（静态检查；不代表运行期或真实服务已通过）。` |
| 5 | `npm run test:docs` | **0** | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| 6 | `node tools/verify-contract-status.mjs --runtime` | **0** | `PASS: 覆盖 112 条契约操作；已装配 78 条；implemented 13 / partial 81 / planned 18；横切维度 8 条；中文表格一致` + `PASS: 无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致（不监听 / 不请求服务）。` + `PASS: 状态为人工判定；…` |
| 7 | `git diff --check` | **0** | 无输出（干净） |
| 8 | `npm run typecheck --workspace @gengyun/api` | **0** | 无输出（`tsc -p tsconfig.json --noEmit`） |

> 上表**没有**列出的检查一律视为**未运行**：本片未跑多 PG 集群、压力/变异测试、真机、后台页面联调。
> 需要说明的一处**自查发现并修复**的真实失败（不是功能缺陷）：
> 在加入编辑/范围审计后，`admin-http.mjs` 有 3 组断言**曾失败**（`3 !== 4`、`0 !== 1`），
> 根因是这些断言把审计端点的**第一页**当成全部（`listAuditEvents` 默认 `limit=20` 且分页）。
> 修法是给该集成脚本加 `allAuditItems(fetch, token)` 按 `next_cursor` 翻完所有页（`?limit=50`）再断言，
> **只改我这一线的测试脚本，产品代码未动**；修复后即上表第 3 行的结果（`PASS 组数=27，FAIL 组数=0` / exit 0）。

### 7.1 本片用例逐条原始输出（含负例）

```
✔ A. 受控面清单逐条对上契约（operationId / method / path），且只覆盖闭集内的 3 个开关
✔ B1. 已配置「开」⇒ 放行，判据是存储值（decidedBy=configured）
✔ B2. 已配置「关」⇒ 409 OBJECT_UNAVAILABLE（确定关闭，retryable 必须为 false）
✔ B3. 未识别取值 ⇒ 一律 fail-closed 503（绝不把"读不到"当成"开着"）
✔ B4. 读取本身抛错 ⇒ 同样 fail-closed（不是 500，也不是放行）
✔ B5. `armed:false`（real 未接线）⇒ 不判开关、不拒绝用户面产出（如实声明，非 fail-open 静默）
✔ C. 关闭 ⇒ 被包装的产出方**一次都不会被调用**（零产出，不是"产出后被丢弃"）
✔ D. 开关**不改变适用判定结论**：开启时结果与不加闸门逐字节相同；关闭时是拒绝而非"改过的结论"
✔ B6. 未命中受控面的路由/操作不被判定（不得因"没查到"而拒绝别人）
✔ F. submissions_enabled 关闭 ⇒ createPost 拒绝且**一条内容都没落库**；开启 ⇒ 正常发布
✔ F2. `createFlagGatedGuards` 只包裹 requireUser：后台守卫原样透传（不重复判权限）
✔ E1. 装配基线：3 个开关与各自输出面的真实状态一致（否则开关等于没生效）
✔ E2. 跨端点：关闭「药剂输出」⇒ /herbicides 列表与详情**拒绝且不产出任何制剂/用量数据**
✔ E3. 断言顺序：未登录访问受控面仍是 401（开关状态不泄露给未鉴权调用方）
✔ E4. 跨端点：关闭 ai_enabled ⇒ AI 任务受理面拒绝；未受控的 AI 读面不受影响
✔ E5. 端到端 fail-closed：开关行被写坏（enabled 非布尔）⇒ 受控面 503 而不是放行
✔ E6. real 模式（后台域未接线）⇒ 开关门不启用：不拿未接线的开关中断用户面（如实声明）
✔ G1a. 分类修改留责任人与范围（action/scope/主体/目标提示）
✔ G1b. 四类资料的「版本修改」逐类留审计（此前不写 ⇒ 事后无法追责）
✔ G2. 普通账号（role=user）对 9 个后台操作一律 SCOPE_DENIED，且零副作用零审计
✔ G3. 只读管理员缺写 scope ⇒ SCOPE_DENIED；状态与审计都不变（权限按调用点重查）
✔ G4. 语义上"关硬规则/跳过审核/放行未核对"的开关一律显式拒绝，并留 denied 审计
✔ G5. 语义表的结构性不变量：任何"放宽 fail-closed"的分类都拒绝接线
✔ G5b. 开关**不能**用来放行"引用已失效"的内容：硬门槛与开关无关
✔ G6a. 人审入口空态：四个集合恒空且冻结、未接线、"声称已评审"的入口一律拒绝
✔ G6b. 抗伪造扫描：全部后台 operation 的响应 schema 里没有任何评审人/投票/专家认证字段
✔ G7. 不把基础账号管理说成人工评审已完成（动作/原因码/投影字段逐条核对）
✔ G8. HTTP：普通用户会话访问后台 ⇒ 403 SCOPE_DENIED（不泄露后台资源是否存在）
✔ R1. 详情读取时重算可见性：发布 published → 撤回 hidden（写时结论不被复用）
✔ R2. 读取时重查对象权限：管辖外主体的详情读取 404（与"不存在"同形），列表为空
✔ R2b. 管辖按读时判定：把存储里的管辖主体换人后，原主体 404、新主体 200、列表也随之切换
✔ R3. 列表逐项重算：同一份列表里已撤回项为 hidden、草稿项为 private
✔ 1. 引用同一来源的三类依赖在来源下架后**同时**失效（读取时重算，不是清缓存动作）
✔ 2. 负例：失效前拿到的缓存副本与旧链接都不得让内容复活
✔ 3. 改版即失效：来源发新版本后，仍引用旧版本的依赖失效（不是只有下架才算失效）
✔ 4. 重新校验后恢复：依赖改引新版本并发布 ⇒ 重新可用（失效是判定，不是不可逆标记）
✔ 5. 发布门槛：引用已下架来源的依赖发布 ⇒ 422 SOURCE_CONFLICT，且**不部分发布**、留 denied 审计
✔ 6. 审计责任人与范围：来源撤回记录受影响引用范围（refs / invalidated）
✔ 7. 读取时重查权限：别的后台主体读同一 id ⇒ NOT_FOUND（与不存在同形）
✔ 8. 不越界：引用库外来源（未接真实库无法核对）⇒ 不谎称失效、也不阻断既有发布链路
✔ real 默认装配反例：34 条后台路由一律 fail-closed（503 PROVIDER_UNAVAILABLE），零成功封套、零内存副作用
✔ stub 默认装配行为不变（内存实现仍可用且确会写内存）——改动只对 real 拒绝
ℹ tests 42 / ℹ pass 42 / ℹ fail 0 / ℹ skipped 0
```

### 7.2 跨端点开关的实测响应（HTTP，`app.inject`，只本机、无外网）

```
关闭 specific_herbicide_output_enabled（PUT /api/v1/admin/feature-flags/... , if-match "1"） -> 200 {enabled:false, revision:2}
GET /api/v1/herbicides          -> 409 {error:{code:"OBJECT_UNAVAILABLE", retryable:false, details:[{field:"feature_flag",code:"FLAG_CLOSED"}]}, data: undefined}
GET /api/v1/herbicides/{id}     -> 409 同上；响应体不含 formulation / registration_number / dosage_form / ingredient / dose_card / risk_text / producer
GET /api/v1/knowledge（未受控）  -> 503 {code:"PROVIDER_UNAVAILABLE", details:[]}（它自己的"未配数据库"，**不是**开关的 409）
GET /health（未受控）            -> 200
重新开启                         -> 200 {enabled:true, revision:3}；GET /api/v1/herbicides -> 200（无"负缓存"把关闭态粘住）
未登录访问受控面（关闭态下）      -> 401 SESSION_REQUIRED（开关判定在鉴权之后）
开关行被写坏（enabled 非布尔）    -> GET /api/v1/herbicides -> 503 PROVIDER_UNAVAILABLE(retryable:true)
关闭 ai_enabled                 -> POST /recognitions | /ocr | /speech/transcriptions | /speech/synthesis -> 409（均无成功封套）
```

## 8. 未取得 / 未验证（**不得外推**）

1. **真实持久存储未接**：后台四类资料与运营/开关仍是**进程内内存** store
   （`persistent:false`，重启即回到装配基线）。因此 `real` 执行模式下**后台域整体 fail-closed**
   （34 条路由一律 503 `PROVIDER_UNAVAILABLE`，既有口径未改动）⇒ 本片**不声称**开关在 real 有权威状态
   （闸门 `armed:false`，§2.5）。
2. **投稿（`submissions_enabled`）只有服务层证据**：社区 HTTP 路由由 #15 阶段 2 装配，当前**未装配**
   ⇒ `/posts` 仍是 404；本片提供的是**装饰式受理门**（`gateCommunityService`）与"零落库"用例（F），
   **不是** HTTP 级证据。`/posts`、`/posts/{id}/comments` 两条受控面已登记在清单里，路由装配后即生效。
3. **公开路由未接引用失效判定**：`/knowledge`、`/herbicides`（#7 线，读 PG 视图/公告附表）**未改**；
   引用失效目前生效在**服务层公开读口径** `public-view.ts`（无路由、不被产品响应消费）。
   把该判定接到实际公开读路径属跨线接线，**需指挥/监工裁定**。
4. **后台 UI 未联调**：`apps/admin/**` 仍是工程骨架（无控制台业务页面）⇒ 开关/分类/账号/作业/资料
   在页面上**没有**可视入口；本片全部证据是服务层与 HTTP（`app.inject` / 本机回环）。
5. **真实部署形态未验证**：未做域名/网关/CDN、未起替换服务、未接生产库、未接真实作业端口
   （`AdminJobPort` 与社区帖子端口仍**未接线** ⇒ `listAdminJobs`/`cancelAdminJob`/`hidePost`
   按服务层 fail-closed 返回 503）；未发起任何付费调用；未使用任何真实凭据。
6. **人审**：本片只声明**空态**（没有评审任务/评审人/投票/专家认证，也没有持久表）；
   任何"人工评审已完成""评审准确率"类结论都**未取得**。
7. **真实供应商能力**：AI 开关只控制"是否受理"，不代表任何真实模型能力；真实供应商、
   识别/OCR/转写/合成质量与准确率均**未取得**（属 GY-I21/GY-I25 等）。
8. **CI**：见 §0 —— 本片不声称 CI 通过；集成脚本不在任何 CI glob 内。

## 9. PR 正文可粘贴段落（`Refs #18`，**不关闭整项**）

> **本片（GY-I18 增量）**：把后台 3 个功能开关从"可读可写的装饰"变成**跨端点真实生效**，
> 并补齐来源引用失效、读取时重查、关键修改审计责任、人审空态四块缺口。
> **装配说明**：新增 `services/api/src/admin/ops/flag-gate.ts`（契约镜像的受控面清单 + fail-closed 开关门
> + 守卫包装器 + 投稿面装饰器），在 `app.ts` **唯一改动点**把包装后的 `guards` 传给
> knowledge/recognition/speech/synthesis/ocr 五个注册点（**先鉴权、后判开关**，401/403 次序不变），
> 并按 `FLAG_WIRING_BASELINE` 播种使"开关状态＝输出面真实状态"；real（后台域未接线）下闸门不启用并如实登记。
> 关闭 ⇒ `OBJECT_UNAVAILABLE`(409, retryable:false) 且**产出方零调用**；取值不可识别 ⇒
> `PROVIDER_UNAVAILABLE`(503, retryable:true)；开关**不改变**任何适用判定结论。
> **引用失效**：新增 `reference-integrity.ts`，来源下架/改版/未发布 ⇒ 依赖（knowledge/registrations/restrictions）
> 在**读取时重算**判定并退出公开读（`null`），发布门槛拒以 `SOURCE_CONFLICT`(422) 且不部分发布；
> 负例证明失效前拿到的缓存副本与旧链接都不能复活内容，改引新版本后可恢复。
> **审计与责任**：四类资料的版本修改此前不写审计，本片补齐 `<noun>.edit`（责任人＝actor_id，
> 范围＝scope + target_ref(revision) + 内部 target_hint 的引用条数/失效条数）；契约投影仍只输出合同 8 字段。
> **人审空态**：新增 `human-review.ts`（四集合恒空且冻结、未接线、"登记评审结论"入口一律拒绝），
> 并有抗伪造扫描断言后台响应 schema 不含评审人/投票/专家认证字段。
> **作者自检**（CI glob 说明：`tests/integration/**` **不在任何 CI glob 内**，下条为作者显式运行；
> 是否纳入 CI 由维护者裁定，**请勿据"CI 全绿"推断该脚本已被执行**）：
> `npm run test:unit` → 1840 tests / 1839 pass / 0 fail / 1 skipped（exit 0）；
> `node tests/integration/admin-http.mjs` → `映射表覆盖 operationId 数：34 / 34`、`PASS 组数=27，FAIL 组数=0`（exit 0）；
> `npm run lint` / `npm run test:docs` / `node tools/verify-contract-status.mjs --runtime` / `git diff --check` 全部 exit 0。
> **未取得**：真实持久存储（real 后台域 fail-closed）、投稿的 HTTP 级门（社区路由属 #15 阶段 2）、
> 公开路由上的引用失效接线（属 #7 线）、后台页面联调、真实部署形态、人工评审、真实供应商能力。
