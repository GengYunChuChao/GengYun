# GY-R28 / S50：纯行号证据补「符号锚点」

- 日期：2026-10-21　分支：`test/gy-r28-contract-line-anchors`　base：`c0217a4`　工作树：`wt-r28-s50`
- 范围：`docs/architecture/contract-status.json` 中 **229 条「纯行号」evidence 引用**（有 `lines`、无 `symbol`/`anchor`/`name`）逐条补 `"symbol"`，取值必须是**在该引用自己的行区间内真实出现**的代码符号（工具容差 ±2 行）。
- 本片不改语义：`status`、`summary`、`owner`、`test`、`kind`、`lines`、契约源一律原样；`docs/architecture/operations.json` 未动；141 条已有 `name` 锚点的引用未动。

## §0 结论

1. **229/229 全部写入，0 条留空**。`git diff --stat` 只有一行：`docs/architecture/contract-status.json | 229 +`（**229 insertions / 0 deletions**）；`git diff -U0` 的 229 处变化**全部且仅为**新增一行 `"symbol": "…",`（脚本复核：`non-symbol additions: 0`，`deletions: 0`），`git diff --check` 干净。
2. 工具读数前后对比（`node tools/verify-contract-status.mjs`，两次均 exit 0）：

| 读数 | 前（`c0217a4`） | 后（本片） |
| --- | --- | --- |
| 契约操作 / 装配 | 覆盖 112 条；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0；语义错误 0 | **完全相同** |
| 语义 | 语义可核 104 条区间 + 0 条片段；不可核 89 条区间 + 131 条片段 | **完全相同**（语义档只看区间内容，不看 `symbol`，见 §1） |
| **证据锚点** | **141 条引用自带锚点（区间内 0 条 + 仅整文件 141 条）**；无锚点不可核 **268** 条（纯行号 **229** + 无行号源文件 9 + 无用例名 30） | **370 条引用自带锚点（区间内 229 条 + 仅整文件 141 条）**；无锚点不可核 **39** 条（纯行号 **0** + 无行号源文件 9 + 无用例名 30） |
| 无锚点可疑前 5 | 前 5/268 条（`getPublicHome`×2、`loginWechat`×2、`loginAdmin`） | 前 5/39 条，仅剩 `tests/integration/ocr-http.mjs` 的 5 条无用例名引用 |
| 纯行号区间（内容度量） | 229 条（有实质内容 229；整段空白/收尾 0；首行空行 2） | **仍 229 条**——该行量的是「区间里有没有实质代码」，与是否带锚点无关，不能用它判断本片效果 |
| 中文表格 | 一致 | 一致 |

3. 增量为 **+229 条 in-range 锚点**：锚点层可核引用从 141 条（全部「仅整文件」）升到 370 条，其中 **229 条是「区间内命中」**；「无锚点不可核」从 268 条降到 39 条（纯行号 229 → 0）。
4. 229 条落在 **221 个不同的 `path|lines`** 上：有 **8 对**引用共用同一区间（同一次注册或同一段实现服务两条操作），共用同一 `symbol`，逐对列在 §3.4。
5. 两条变异（§4）分别证明了「锚点指到区间外 ⇒ 语义错误 exit 1」和「锚点根本不存在 ⇒ 形状错误 exit 1」，还原后 exit 0。

## §1 为什么（in-range 档恒 0 的后果）

工具 `checkAnchors` 把引用分三档：`referenced`（有 `symbol`/`anchor` 且文件里找得到）、`fileOnly`（没有 `lines`，只能证「文件里出现过」）、`inRange`（至少一处命中落在 `lines` 的 ±2 行内）。基线 `c0217a4` 的读数是：

- **141 条 `name` 锚点全部落在 `fileOnly`**——它们是无行号的用例名引用，只能证明「这个名字在这个文件里出现过」；
- **268 条完全没有锚点**（纯行号 229 + 无行号 9 + 无用例名 30）；
- 因此 **`inRange` 恒为 0**，锚点层对 409 条证据里的 268 条不产生任何可证伪性，对另外 141 条也只能证明「同名串存在于该文件」。

后果是具体的：一条 evidence 可以写着 `services/api/src/routes/admin.ts:316-324`，实际指向完全不相干的 300-324 行代码，工具全绿——因为没有任何文本被钉到区间里。本片补的 `symbol` 正是把「这个区间里必须出现这个符号」变成硬条件：符号被删、被改名、或区间漂到别处，`checkSemantics` 立刻报「不在引用行范围内」或「找不到锚点」。

同时必须说清两点，避免误读读数：

- **「语义可核 104 条」不会因本片变化**。该档由 `checkIntervalSemantics`/`checkSnippetSemantics` 计算（路由注册块归属、断言实参范围），与 `symbol` 无关；派单里「语义可核条数上升」的说法与实际代码不符，本片按实测记录。
- **「纯行号区间 229 条」也不会因本片变化**。它统计的是「有 `lines` 的区间里是否只有空白/收尾行」，是内容档而不是锚点档；基线 229 条全部「有实质内容」，本片改完仍是 229 条。

## §2 方法与自证规则

一次性脚本：`E:\GengYunCommander\.pg17\tmp\s50-anchors.mjs`（⛔ 未提交进仓；模式 `report` / `apply` / `verify` / `debug <path> <lines>`）。流程：

1. **取件**：读台账，只挑「有 `lines`、无 `symbol`、无 `anchor`、无 `name`」的引用（恰好 229 条），按 `path|lines` 去重成 221 个待解区间。
2. **切窗**：读被引用文件，切 `[from-2, to+2]` 作为候选窗口（声明常常写在区间上一两行，例如 `export function paginateConsentRecords…` 在区间首行的前一行）。
3. **抽候选**（9 类，按可信度定档）：

   | kind | 取值样子 | 例子 |
   | --- | --- | --- |
   | `route-verb` | 单行注册连动词 | ``app.get(`${API_PREFIX}/me/profile` `` |
   | `route-literal` | 多行注册里的路径字面量 | `` `${API_PREFIX}/admin/auth/session` `` |
   | `op-key` | 对象表里一个操作一个键 | `listAdminSources`、`withdrawRestriction` |
   | `qualified-call` | 带动词的限定调用 | `ready().getPost(`、`service.listAdminScopes(` |
   | `signature` | 整行声明头（裸名太通用时用） | `async put(input: Identity, body: ProfileInput, ifMatch: string, idempotencyKey: string) {` |
   | `method-head` | 多行方法头（参数跨行） | `createComment(` |
   | `function`/`class`/`const`/`type`/`method` | 声明名 | `paginateKnowledge`、`persistConsentGrant` |
   | `error-code` | 引号内错误码 | `REVISION_REQUIRED` |
   | `constant`/`call`/`method-call` | 常量、裸调用、`x.y(` | `IDEMPOTENCY_TTL_SECONDS`、`runIdempotent` |

4. **资格门槛**（防「通用词冒充锚点」）：裸标识符必须长度 ≥8、含驼峰、不在语言关键字表与封禁表（`return`/`const`/`async`/`export`/`request`/`reply`/`query`/`row`/`scope`/`API_PREFIX`/`requireUser`… 共 100+ 词）；SCREAMING 常量必须 `A_B` 形态且不在 SQL 词表；路径字面量必须带引号且以 `${API_PREFIX}` 或 `/` 开头；`signature`/`route-verb`/`qualified-call`/`op-key` 这四类派生值不受裸名门槛限制。
5. **排序**：`rank = [opMatch, head, priority, inRange>0?0:1, distance, hits===1?0:1, -len]`。
   - `opMatch`：候选字符串是否为该操作自己的名字（`ready().deleteConversation(` 之于 `deleteConversation`）；只对声明级/调用级候选生效，裸 identifier 不享受。
   - `head`：候选行是否 ≤ 区间首行**且**属于声明类（`route-verb`/`signature`/`op-key`/`function`/`const`/… ）——错误码或裸调用落在区间上一行时属于前一条语句，不算 head（否则 `IDEMPOTENCY_KEY_REQUIRED`@36 会抢走 `routes/profile.ts:37-41` 的 If-Match 分支）。
   - `priority`：`block(0) < call(1) < routeLiteral(2) < local(3) < constant(4) < loose(5)`。
6. **撞车消歧**（同一文件、**不相交**区间不许共用同一 anchor；重叠区间可以共用，因为它们本来就该指向同一段实现）：按 `from` 升序单趟贪心，已被不相交区间占用的候选跳过，取下一个合格候选；跑完复查 `residual ambiguity` 必须为空（本次为空）。
7. **自证**（逐条，不凭印象）：`text.includes(value)` 必须为真；命中行号由 `indexOf` 循环算；至少一处命中落在 `[from,to]`（严格区间）或 ±2 容差内，否则该候选弃用；最终 **221 个区间全部拿到 in-range 命中（`inRange≥1`）**，无一例只靠容差落点。
8. **写盘**：把 `"symbol": "…",` 插在 `"lines"` 行的**正前方**（不是之后）——因为插在之后就得给原 `"lines"` 行补逗号，那会改动既有行，违反「每处变化只能是一行新增」；插在前面时 diff 恰好只有 `+` 行、不需要碰任何既有字节。插入用逆序 `indexOf` 定位，缩进取该行前导空白，路径由插入点前的 `"path"` 反查。
9. **人工覆盖 3 条**（脚本内 `OVERRIDES` 表，覆盖后仍走同一套自证）：`services/api/src/auth/password.ts|1-40 → hashPassword`（自动取到 `SCRYPT_N`@9，只是 scrypt 参数）、`services/api/src/app.ts|828-834 → idempotencyStore`（自动取到 `createAuthGuards`@836，落在容差外）、`services/api/src/privacy/consent-pg.ts|109-120 → consentStore`（自动取到区间末行的相邻方法 `async grant(...)`；109-116 是 `referenceGuard` 返回的 `consentStore` 对象，`list` 就挂在该对象上）。
10. **自检汇总**（脚本 `verify` 模式，与工具同源逻辑 + 更严的越界统计）：
    `verify: referenced=229 inRange=229 fileOnly=0 lineOnlyLeft=0 bad=0`，另有 84 条 `outside-hits` 附注（同一串在文件别处也出现，例如 `getMedia` 在 `media/service.ts` 里被 7 处引用；工具只要求区间内至少一次）。

## §3 逐条统计与取不到清单

### §3.1 写入 / 取不到

- 纯行号引用 **229 条** → 写入 **229 条**，**取不到 0 条**（没有留空条目，所以「取不到清单」为空）。
- 去重后 **221 个区间**，落在 **56 个文件**；条目最多的文件：`services/api/src/routes/admin.ts` 35、`services/api/src/admin/service.ts` 25、`services/api/src/routes/community.ts` 16、`services/api/src/community/service.ts` 16、`services/api/src/admin/ops/service.ts` 9、`services/api/src/routes/media.ts` 7、`services/api/src/media/service.ts` 7、`services/api/src/routes/conversations.ts` 7。

### §3.2 按锚点类型（221 个区间）

| kind | 条数 | 说明 |
| --- | --- | --- |
| `qualified-call` | 48 | `ready().<op>(` / `service.<op>(`，唯一命名操作 |
| `route-verb` | 39 | 单行注册 `app.<verb>(\`${API_PREFIX}/…\`` |
| `function` | 31 | `function foo(` / `export function foo(` |
| `op-key` | 25 | admin 服务表一个操作一个键 |
| `method` | 20 | 类/对象方法声明 |
| `const` | 20 | `const foo = …` |
| `route-literal` | 19 | 多行注册里的路径字面量 |
| `signature` | 8 | 整行声明头（裸名太通用时） |
| `override` | 3 | 人工覆盖（§2.9） |
| `error-code` | 2 | `REVISION_REQUIRED` |
| `type` | 2 | `type`/`interface` 声明 |
| `method-head` | 1 | 多行方法头 `createComment(` |
| `class` | 1 | 类声明 |
| `constant` | 1 | `IDEMPOTENCY_TTL_SECONDS` |
| `method-call` | 1 | `x.y(` 方法调用 |

其中 **127/221 条全文唯一命中**（`hits===1`），其余是「声明在区间内、但同名字符串在文件里被多处引用」（如 `getMedia` 7 次、`grantMediaAccess` 7 次、`grantCommunityMediaAccess` 6 次、`readCommunityMediaContent` 6 次，声明行都在区间内）。

### §3.3 仅靠 ±2 容差落点的 10 个区间（12 条引用）

这些锚点写在区间**上一行或下一行**（多数是「声明头在区间首行的前一行」这种既有写法），工具按 ±2 容差接受；列出来供复核：

| 引用 | symbol | 命中行 |
| --- | --- | --- |
| `services/api/src/profile/service.ts:66-71`（getProfile） | `async get(input: Identity) {` | 65（区间上一行） |
| `services/api/src/profile/service.ts:72-104`（putProfile） | `async put(input: Identity, body: ProfileInput, ifMatch: string, idempotencyKey: string) {` | 71（上一行） |
| `services/api/src/profile/service.ts:57-64`（listCrops、listRegions） | `async function directory(client: PoolClient, kind: 'crops' \| 'regions'): Promise<CatalogItem[]> {` | 56（上一行） |
| `services/api/src/privacy/consent-pagination.ts:24-65`（listConsents、dimension pagination） | `paginateConsentRecords` | 23（上一行） |
| `services/api/src/profile/pagination.ts:24-65`（dimension pagination） | `paginateCatalog` | 22（上一行） |
| `services/api/src/routes/conversations.ts:136-140`（getConversation） | `ready().getConversation(` | 141（下一行） |
| `services/api/src/routes/conversations.ts:148-152`（deleteConversation） | `ready().deleteConversation(` | 153（下一行） |
| `services/api/src/routes/conversations.ts:161-165`（createTurn） | `ready().createTurn(` | 166（下一行） |
| `services/api/src/routes/conversations.ts:174-178`（listTurns） | `ready().listTurns(` | 179（下一行） |
| `services/api/src/routes/conversations.ts:184-188`（deleteTurn） | `ready().deleteTurn(` | 189（下一行） |

### §3.4 8 对共用同一区间的引用（同一区间 → 同一 symbol）

| 区间 | 两条引用 | 共用 symbol |
| --- | --- | --- |
| `services/api/src/routes/profile.ts:43-53` | listCrops / listRegions | ``app.get(`${API_PREFIX}/catalog/${kind}` `` |
| `services/api/src/profile/service.ts:57-64` | listCrops / listRegions | `async function directory(…) {` |
| `services/api/src/privacy/consent-pagination.ts:24-65` | listConsents / dimension pagination | `paginateConsentRecords` |
| `services/api/src/moderation/job-source.ts:1-33` | 两条审核作业源引用 | `createModerationJobSource` |
| `services/api/src/jobs/routes.ts:64-80` | 两条作业取消引用 | `` `${API_PREFIX}/jobs/:id/cancel` `` |
| `services/api/src/knowledge/pagination.ts:30-72` | 两条知识分页引用 | `paginateKnowledge` |
| `services/api/src/routes/knowledge.ts:193-199` | 两条知识详情引用 | ``app.get(`${API_PREFIX}/knowledge/:id` `` |
| `services/api/src/routes/admin.ts:316-324` | 两条后台作业取消引用 | `` `${API_PREFIX}/admin/jobs/:id/cancel` `` |

### §3.5 逐条明细（229 条，顺序与台账一致）

| # | 操作 / 维度 | 引用位置 | 新增 symbol | 全文命中 / 区间内命中 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 001 | getPublicHome | services/api/src/routes/public-home.ts:9-16 | 「app.get('/api/v1/public/home'」 | 1 / 1 |  |
| 002 | getPublicHome | services/api/src/db/catalog.ts:14-32 | 「readHomePreviews」 | 2 / 1 |  |
| 003 | loginWechat | services/api/src/routes/auth.ts:42-83 | 「service.loginWechat(」 | 1 / 1 |  |
| 004 | loginWechat | services/api/src/auth/wechat.ts:66-132 | 「createWechatIdentityProvider」 | 1 / 1 |  |
| 005 | loginAdmin | services/api/src/routes/admin-auth.ts:46-86 | 「service.loginAdmin(」 | 1 / 1 |  |
| 006 | loginAdmin | services/api/src/auth/password.ts:1-40 | 「hashPassword」 | 1 / 1 |  |
| 007 | getAdminSession | services/api/src/routes/admin-auth.ts:88-101 | 「`${API_PREFIX}/admin/auth/session`」 | 2 / 1 |  |
| 008 | getUserSession | services/api/src/routes/auth.ts:85-99 | 「app.get(`${API_PREFIX}/auth/session`」 | 1 / 1 |  |
| 009 | logoutUser | services/api/src/routes/auth.ts:101-122 | 「service.logoutUser(」 | 1 / 1 |  |
| 010 | logoutAdmin | services/api/src/routes/admin-auth.ts:103-127 | 「service.logoutAdmin(」 | 1 / 1 |  |
| 011 | getProfile | services/api/src/routes/profile.ts:25-28 | 「app.get(`${API_PREFIX}/me/profile`」 | 1 / 1 |  |
| 012 | getProfile | services/api/src/profile/service.ts:66-71 | 「async get(input: Identity) {」 | 1 / 0（±2 内 1） |  |
| 013 | putProfile | services/api/src/routes/profile.ts:29-42 | 「app.put(`${API_PREFIX}/me/profile`」 | 1 / 1 |  |
| 014 | putProfile | services/api/src/profile/service.ts:72-104 | 「async put(input: Identity, body: ProfileInput, ifMatch: string, idempotencyKey: string) {」 | 1 / 0（±2 内 1） |  |
| 015 | listCrops | services/api/src/routes/profile.ts:43-53 | 「app.get(`${API_PREFIX}/catalog/${kind}`」 | 1 / 1 | 同区间共用 2 条 |
| 016 | listCrops | services/api/src/profile/service.ts:57-64 | 「async function directory(client: PoolClient, kind: 'crops' \| 'regions'): Promise<CatalogItem[]> {」 | 1 / 0（±2 内 1） | 同区间共用 2 条 |
| 017 | listRegions | services/api/src/routes/profile.ts:43-53 | 「app.get(`${API_PREFIX}/catalog/${kind}`」 | 1 / 1 | 同区间共用 2 条 |
| 018 | listRegions | services/api/src/profile/service.ts:57-64 | 「async function directory(client: PoolClient, kind: 'crops' \| 'regions'): Promise<CatalogItem[]> {」 | 1 / 0（±2 内 1） | 同区间共用 2 条 |
| 019 | listConsents | services/api/src/routes/consents.ts:40-49 | 「app.get(`${API_PREFIX}/me/consents`」 | 1 / 1 |  |
| 020 | listConsents | services/api/src/privacy/consent-pg.ts:109-120 | 「consentStore」 | 1 / 1 |  |
| 021 | listConsents | services/api/src/privacy/consent-pagination.ts:24-65 | 「paginateConsentRecords」 | 1 / 0（±2 内 1） | 同区间共用 2 条 |
| 022 | grantConsent | services/api/src/routes/consents.ts:24-39 | 「app.post(`${API_PREFIX}/me/consents`」 | 1 / 1 |  |
| 023 | grantConsent | services/api/src/privacy/grant-pg.ts:32-112 | 「persistConsentGrant」 | 1 / 1 |  |
| 024 | withdrawConsent | services/api/src/routes/consents.ts:50-64 | 「app.delete(`${API_PREFIX}/me/consents/:purpose`」 | 1 / 1 |  |
| 025 | withdrawConsent | services/api/src/privacy/consent-pg.ts:135-179 | 「requireConsent」 | 2 / 2 |  |
| 026 | requestAccountDeletion | services/api/src/routes/account-deletion.ts:128-181 | 「`${API_PREFIX}/me/account/deletion`」 | 2 / 1 |  |
| 027 | requestAccountDeletion | services/api/src/privacy/account-deletion.ts:200-229 | 「createAccountDeletionRequestService」 | 2 / 1 |  |
| 028 | requestAccountDeletion | services/api/src/app.ts:1722-1729 | 「accountDeletionWired」 | 4 / 3（±2 内 4） |  |
| 029 | getDeletionReceipt | services/api/src/routes/account-deletion.ts:183-205 | 「`${API_PREFIX}/account/deletions/:id`」 | 1 / 1 |  |
| 030 | getDeletionReceipt | services/api/src/privacy/account-deletion.ts:120-165 | 「createDeletionReceiptRegistry」 | 2 / 1 |  |
| 031 | getDeletionReceipt | services/api/src/privacy/account-deletion.ts:242-299 | 「projectReceipt」 | 3 / 1 |  |
| 032 | createUpload | services/api/src/routes/media.ts:218-233 | 「`${API_PREFIX}/media/uploads`」 | 1 / 1 |  |
| 033 | createUpload | services/api/src/media/service.ts:807-874 | 「initiateUploadUnclaimed」 | 3 / 3 |  |
| 034 | completeUpload | services/api/src/routes/media.ts:236-257 | 「service.completeUpload(」 | 1 / 1 |  |
| 035 | completeUpload | services/api/src/media/service.ts:876-953 | 「completeUploadUnclaimed」 | 3 / 1 |  |
| 036 | getMedia | services/api/src/routes/media.ts:260-275 | 「service.getMedia(」 | 1 / 1 |  |
| 037 | getMedia | services/api/src/media/service.ts:975-978 | 「getMedia」 | 7 / 2 |  |
| 038 | deleteMedia | services/api/src/routes/media.ts:278-295 | 「service.deleteMedia(」 | 1 / 1 |  |
| 039 | deleteMedia | services/api/src/media/service.ts:980-1009 | 「deleteMediaUnclaimed」 | 3 / 1 |  |
| 040 | grantMediaAccess | services/api/src/routes/media.ts:298-315 | 「service.grantMediaAccess(」 | 1 / 1 |  |
| 041 | grantMediaAccess | services/api/src/media/service.ts:1021-1052 | 「grantMediaAccess」 | 7 / 2 |  |
| 042 | getJob | services/api/src/jobs/routes.ts:51-62 | 「`${API_PREFIX}/jobs/:id`」 | 1 / 1 |  |
| 043 | getJob | services/api/src/moderation/job-source.ts:1-33 | 「createModerationJobSource」 | 1 / 1 | 同区间共用 2 条 |
| 044 | cancelJob | services/api/src/jobs/routes.ts:64-80 | 「`${API_PREFIX}/jobs/:id/cancel`」 | 1 / 1 | 同区间共用 2 条 |
| 045 | cancelJob | services/api/src/moderation/job-source.ts:1-33 | 「createModerationJobSource」 | 1 / 1 | 同区间共用 2 条 |
| 046 | listKnowledge | services/api/src/routes/knowledge.ts:188-192 | 「app.get(`${API_PREFIX}/knowledge`」 | 1 / 1 |  |
| 047 | listKnowledge | services/api/src/knowledge/service.ts:56-123 | 「createKnowledgeService」 | 1 / 1 |  |
| 048 | listKnowledge | services/api/src/knowledge/pagination.ts:30-72 | 「paginateKnowledge」 | 1 / 1 | 同区间共用 2 条 |
| 049 | getKnowledge | services/api/src/routes/knowledge.ts:193-199 | 「app.get(`${API_PREFIX}/knowledge/:id`」 | 1 / 1 | 同区间共用 2 条 |
| 050 | getKnowledge | services/api/src/knowledge/service.ts:57-121 | 「async function read(input: Identity, query: KnowledgeQuery, id?: string) {」 | 1 / 1 |  |
| 051 | listHerbicides | services/api/src/routes/knowledge.ts:201-207 | 「reference.listHerbicides(」 | 1 / 1 |  |
| 052 | listHerbicides | services/api/src/knowledge/reference-query.ts:168-176 | 「listHerbicides」 | 3 / 2 |  |
| 053 | listHerbicides | packages/reference/zhejiang.mjs:97-160 | 「assertZhejiangDiscipline」 | 4 / 1 |  |
| 054 | getHerbicide | services/api/src/routes/knowledge.ts:208-216 | 「reference.getHerbicide(」 | 1 / 1 |  |
| 055 | getHerbicide | services/api/src/knowledge/reference-query.ts:177-185 | 「getHerbicide」 | 3 / 2（±2 内 3） |  |
| 056 | createRecognition | services/api/src/routes/recognitions.ts:79-116 | 「service.createRecognition(」 | 1 / 1 |  |
| 057 | getRecognition | services/api/src/routes/recognitions.ts:118-128 | 「service.getRecognition(」 | 1 / 1 |  |
| 058 | deleteRecognition | services/api/src/routes/recognitions.ts:148-160 | 「service.deleteRecognition(」 | 1 / 1 |  |
| 059 | selectSpecies | services/api/src/routes/recognitions.ts:130-146 | 「service.selectSpecies(」 | 1 / 1 |  |
| 060 | createOCR | services/api/src/routes/ocr.ts:224-257 | 「service.createOcr(」 | 1 / 1 |  |
| 061 | getOCR | services/api/src/routes/ocr.ts:259-272 | 「`${API_PREFIX}/ocr/:id`」 | 2 / 1 |  |
| 062 | deleteOCR | services/api/src/routes/ocr.ts:310-328 | 「service.deleteOcrWithRevision(」 | 1 / 1 |  |
| 063 | correctOCR | services/api/src/routes/ocr.ts:274-290 | 「service.correctOcr(」 | 1 / 1 |  |
| 064 | verifyOCR | services/api/src/routes/ocr.ts:292-308 | 「service.verifyOcrWithRevision(」 | 1 / 1 |  |
| 065 | createTranscription | services/api/src/routes/speech.ts:160-194 | 「service.createTranscription(」 | 1 / 1 |  |
| 066 | getTranscription | services/api/src/routes/speech.ts:196-208 | 「service.getTranscription(」 | 1 / 1 |  |
| 067 | deleteTranscription | services/api/src/routes/speech.ts:210-228 | 「service.deleteTranscription(」 | 1 / 1 |  |
| 068 | confirmTranscription | services/api/src/routes/speech.ts:230-248 | 「service.confirmTranscription(」 | 1 / 1 |  |
| 069 | createSynthesis | services/api/src/routes/synthesis.ts:112-177 | 「service.createSynthesis(」 | 1 / 1 |  |
| 070 | createConversation | services/api/src/routes/conversations.ts:115-119 | 「ready().createConversation(」 | 1 / 1 |  |
| 071 | listConversations | services/api/src/routes/conversations.ts:126-130 | 「ready().listConversations(」 | 1 / 1 |  |
| 072 | getConversation | services/api/src/routes/conversations.ts:136-140 | 「ready().getConversation(」 | 1 / 0（±2 内 1） |  |
| 073 | deleteConversation | services/api/src/routes/conversations.ts:148-152 | 「ready().deleteConversation(」 | 1 / 0（±2 内 1） |  |
| 074 | createTurn | services/api/src/routes/conversations.ts:161-165 | 「ready().createTurn(」 | 1 / 0（±2 内 1） |  |
| 075 | listTurns | services/api/src/routes/conversations.ts:174-178 | 「ready().listTurns(」 | 1 / 0（±2 内 1） |  |
| 076 | deleteTurn | services/api/src/routes/conversations.ts:184-188 | 「ready().deleteTurn(」 | 1 / 0（±2 内 1） |  |
| 077 | listPosts | services/api/src/routes/community.ts:201-209 | 「ready().listPosts(」 | 1 / 1 |  |
| 078 | listPosts | services/api/src/community/service.ts:748-753 | 「listPosts」 | 4 / 1（±2 内 2） |  |
| 079 | createPost | services/api/src/routes/community.ts:211-221 | 「ready().createPost(」 | 1 / 1 |  |
| 080 | createPost | services/api/src/community/service.ts:820-825 | 「createPost」 | 5 / 1 |  |
| 081 | getPost | services/api/src/routes/community.ts:223-230 | 「`${API_PREFIX}/posts/:id`」 | 3 / 1 |  |
| 082 | getPost | services/api/src/community/service.ts:908-913 | 「async getPost(actor: unknown, id: unknown): Promise<Post> {」 | 1 / 1 |  |
| 083 | editPost | services/api/src/routes/community.ts:232-239 | 「ready().editPost(」 | 1 / 1 |  |
| 084 | editPost | services/api/src/community/service.ts:915-920 | 「editPost」 | 5 / 1（±2 内 2） |  |
| 085 | deletePost | services/api/src/routes/community.ts:241-249 | 「ready().deletePost(」 | 1 / 1 |  |
| 086 | deletePost | services/api/src/community/service.ts:1028-1033 | 「deletePost」 | 3 / 1（±2 内 2） |  |
| 087 | listComments | services/api/src/routes/community.ts:251-262 | 「ready().listComments(」 | 1 / 1 |  |
| 088 | listComments | services/api/src/community/service.ts:1063-1068 | 「listComments」 | 4 / 1（±2 内 2） |  |
| 089 | createComment | services/api/src/routes/community.ts:264-274 | 「ready().createComment(」 | 1 / 1 |  |
| 090 | createComment | services/api/src/community/service.ts:1116-1121 | 「createComment」 | 3 / 1（±2 内 2） |  |
| 091 | getComment | services/api/src/routes/community.ts:276-283 | 「ready().getComment(」 | 1 / 1 |  |
| 092 | getComment | services/api/src/community/service.ts:1208-1213 | 「getComment」 | 11 / 1（±2 内 2） |  |
| 093 | editComment | services/api/src/routes/community.ts:285-292 | 「ready().editComment(」 | 1 / 1 |  |
| 094 | editComment | services/api/src/community/service.ts:1215-1220 | 「editComment」 | 3 / 1（±2 内 2） |  |
| 095 | deleteComment | services/api/src/routes/community.ts:294-301 | 「ready().deleteComment(」 | 1 / 1 |  |
| 096 | deleteComment | services/api/src/community/service.ts:1295-1300 | 「deleteComment」 | 3 / 1（±2 内 2） |  |
| 097 | likePosts | services/api/src/routes/community.ts:305-312 | 「ready().likePosts(」 | 1 / 1 |  |
| 098 | likePosts | services/api/src/community/service.ts:1329-1334 | 「likePosts」 | 6 / 3（±2 内 4） |  |
| 099 | unlikePosts | services/api/src/routes/community.ts:314-321 | 「ready().unlikePosts(」 | 1 / 1 |  |
| 100 | unlikePosts | services/api/src/community/service.ts:1333-1338 | 「unlikePosts」 | 3 / 1（±2 内 2） |  |
| 101 | likeComments | services/api/src/routes/community.ts:323-330 | 「ready().likeComments(」 | 1 / 1 |  |
| 102 | likeComments | services/api/src/community/service.ts:1337-1342 | 「likeComments」 | 6 / 3（±2 内 4） |  |
| 103 | unlikeComments | services/api/src/routes/community.ts:332-339 | 「ready().unlikeComments(」 | 1 / 1 |  |
| 104 | unlikeComments | services/api/src/community/service.ts:1341-1346 | 「unlikeComments」 | 3 / 1（±2 内 2） |  |
| 105 | createReport | services/api/src/routes/community.ts:341-351 | 「ready().createReport(」 | 1 / 1 |  |
| 106 | createReport | services/api/src/community/service.ts:1346-1351 | 「createReport」 | 3 / 1（±2 内 2） |  |
| 107 | getOwnReport | services/api/src/routes/community.ts:353-360 | 「ready().getOwnReport(」 | 1 / 1 |  |
| 108 | getOwnReport | services/api/src/community/service.ts:1386-1391 | 「getOwnReport」 | 3 / 1（±2 内 2） |  |
| 109 | listFavorites | services/api/src/routes/favorites.ts:89-92 | 「app.get(`${API_PREFIX}/favorites`」 | 1 / 1 |  |
| 110 | listFavorites | services/api/src/favorites/service.ts:305-347 | 「listFavorites」 | 4 / 3 |  |
| 111 | createFavorite | services/api/src/routes/favorites.ts:94-107 | 「`${API_PREFIX}/favorites`」 | 2 / 1 |  |
| 112 | createFavorite | services/api/src/favorites/service.ts:359-415 | 「createFavorite」 | 5 / 1 |  |
| 113 | deleteFavorite | services/api/src/routes/favorites.ts:109-119 | 「`${API_PREFIX}/favorites/:id`」 | 1 / 1 |  |
| 114 | deleteFavorite | services/api/src/favorites/service.ts:426-466 | 「deleteFavorite」 | 4 / 2 |  |
| 115 | listHistory | services/api/src/routes/history.ts:80-83 | 「app.get(`${API_PREFIX}/history`」 | 1 / 1 |  |
| 116 | listHistory | services/api/src/history/service.ts:318-358 | 「listHistory」 | 4 / 3 |  |
| 117 | deleteHistory | services/api/src/routes/history.ts:85-98 | 「`${API_PREFIX}/history/:id`」 | 1 / 1 |  |
| 118 | deleteHistory | services/api/src/history/service.ts:369-404 | 「deleteHistory」 | 6 / 2 |  |
| 119 | listMessages | services/api/src/routes/messages.ts:43-52 | 「app.get(`${API_PREFIX}/messages`」 | 1 / 1 |  |
| 120 | getUnreadCount | services/api/src/routes/messages.ts:53-58 | 「app.get(`${API_PREFIX}/messages/unread-count`」 | 1 / 1 |  |
| 121 | markMessageRead | services/api/src/routes/messages.ts:59-70 | 「app.put(`${API_PREFIX}/messages/:id/read`」 | 1 / 1 |  |
| 122 | listAdminSources | services/api/src/routes/admin.ts:172-174 | 「app.get(`${API_PREFIX}/admin/sources`」 | 1 / 1 |  |
| 123 | listAdminSources | services/api/src/admin/service.ts:574-579 | 「listAdminSources」 | 2 / 1 |  |
| 124 | createSourceDraft | services/api/src/routes/admin.ts:175-177 | 「app.post(`${API_PREFIX}/admin/sources`」 | 1 / 1 |  |
| 125 | createSourceDraft | services/api/src/admin/service.ts:575-580 | 「createSourceDraft」 | 2 / 1 |  |
| 126 | getAdminSource | services/api/src/routes/admin.ts:178-180 | 「app.get(`${API_PREFIX}/admin/sources/:id`」 | 1 / 1 |  |
| 127 | getAdminSource | services/api/src/admin/service.ts:576-581 | 「getAdminSource」 | 2 / 1 |  |
| 128 | editSourceDraft | services/api/src/routes/admin.ts:207-209 | 「app.patch(`${API_PREFIX}/admin/sources/:id`」 | 1 / 1 |  |
| 129 | editSourceDraft | services/api/src/admin/service.ts:577-582 | 「editSourceDraft」 | 2 / 1 |  |
| 130 | publishSource | services/api/src/routes/admin.ts:184-186 | 「app.post(`${API_PREFIX}/admin/sources/:id/publish`」 | 1 / 1 |  |
| 131 | publishSource | services/api/src/admin/service.ts:578-583 | 「publishSource」 | 2 / 1 |  |
| 132 | withdrawSource | services/api/src/routes/admin.ts:187-189 | 「app.post(`${API_PREFIX}/admin/sources/:id/withdraw`」 | 1 / 1 |  |
| 133 | withdrawSource | services/api/src/admin/service.ts:579-584 | 「withdrawSource」 | 2 / 1 |  |
| 134 | listAdminKnowledge | services/api/src/routes/admin.ts:192-194 | 「app.get(`${API_PREFIX}/admin/knowledge`」 | 1 / 1 |  |
| 135 | listAdminKnowledge | services/api/src/admin/service.ts:581-586 | 「listAdminKnowledge」 | 2 / 1 |  |
| 136 | createKnowledgeDraft | services/api/src/routes/admin.ts:195-197 | 「app.post(`${API_PREFIX}/admin/knowledge`」 | 1 / 1 |  |
| 137 | createKnowledgeDraft | services/api/src/admin/service.ts:582-587 | 「createKnowledgeDraft」 | 2 / 1 |  |
| 138 | getAdminKnowledge | services/api/src/routes/admin.ts:198-200 | 「app.get(`${API_PREFIX}/admin/knowledge/:id`」 | 1 / 1 |  |
| 139 | getAdminKnowledge | services/api/src/admin/service.ts:583-588 | 「getAdminKnowledge」 | 2 / 1 |  |
| 140 | editKnowledgeDraft | services/api/src/routes/admin.ts:201-203 | 「app.patch(`${API_PREFIX}/admin/knowledge/:id`」 | 1 / 1 |  |
| 141 | editKnowledgeDraft | services/api/src/admin/service.ts:584-589 | 「editKnowledgeDraft」 | 2 / 1 |  |
| 142 | publishKnowledge | services/api/src/routes/admin.ts:204-206 | 「app.post(`${API_PREFIX}/admin/knowledge/:id/publish`」 | 1 / 1 |  |
| 143 | publishKnowledge | services/api/src/admin/service.ts:585-590 | 「publishKnowledge」 | 2 / 1 |  |
| 144 | withdrawKnowledge | services/api/src/routes/admin.ts:207-209 | 「app.post(`${API_PREFIX}/admin/knowledge/:id/withdraw`」 | 1 / 1 |  |
| 145 | withdrawKnowledge | services/api/src/admin/service.ts:586-591 | 「withdrawKnowledge」 | 2 / 1 |  |
| 146 | listAdminRegistration | services/api/src/routes/admin.ts:212-214 | 「app.get(`${API_PREFIX}/admin/registrations`」 | 1 / 1 |  |
| 147 | listAdminRegistration | services/api/src/admin/service.ts:588-593 | 「listAdminRegistration」 | 2 / 1 |  |
| 148 | createRegistrationDraft | services/api/src/routes/admin.ts:215-217 | 「app.post(`${API_PREFIX}/admin/registrations`」 | 1 / 1 |  |
| 149 | createRegistrationDraft | services/api/src/admin/service.ts:589-594 | 「createRegistrationDraft」 | 2 / 1 |  |
| 150 | getAdminRegistration | services/api/src/routes/admin.ts:218-220 | 「app.get(`${API_PREFIX}/admin/registrations/:id`」 | 1 / 1 |  |
| 151 | getAdminRegistration | services/api/src/admin/service.ts:590-595 | 「getAdminRegistration」 | 2 / 1 |  |
| 152 | editRegistrationDraft | services/api/src/routes/admin.ts:221-223 | 「app.patch(`${API_PREFIX}/admin/registrations/:id`」 | 1 / 1 |  |
| 153 | editRegistrationDraft | services/api/src/admin/service.ts:591-596 | 「editRegistrationDraft」 | 2 / 1 |  |
| 154 | publishRegistration | services/api/src/routes/admin.ts:224-226 | 「app.post(`${API_PREFIX}/admin/registrations/:id/publish`」 | 1 / 1 |  |
| 155 | publishRegistration | services/api/src/admin/service.ts:592-597 | 「publishRegistration」 | 2 / 1 |  |
| 156 | withdrawRegistration | services/api/src/routes/admin.ts:227-229 | 「app.post(`${API_PREFIX}/admin/registrations/:id/withdraw`」 | 1 / 1 |  |
| 157 | withdrawRegistration | services/api/src/admin/service.ts:593-598 | 「withdrawRegistration」 | 2 / 1 |  |
| 158 | listAdminRestriction | services/api/src/routes/admin.ts:232-234 | 「app.get(`${API_PREFIX}/admin/restrictions`」 | 1 / 1 |  |
| 159 | listAdminRestriction | services/api/src/admin/service.ts:595-600 | 「listAdminRestriction」 | 2 / 1 |  |
| 160 | createRestrictionDraft | services/api/src/routes/admin.ts:235-237 | 「app.post(`${API_PREFIX}/admin/restrictions`」 | 1 / 1 |  |
| 161 | createRestrictionDraft | services/api/src/admin/service.ts:596-601 | 「createRestrictionDraft」 | 2 / 1 |  |
| 162 | getAdminRestriction | services/api/src/routes/admin.ts:238-240 | 「app.get(`${API_PREFIX}/admin/restrictions/:id`」 | 1 / 1 |  |
| 163 | getAdminRestriction | services/api/src/admin/service.ts:597-602 | 「getAdminRestriction」 | 2 / 1 |  |
| 164 | editRestrictionDraft | services/api/src/routes/admin.ts:241-243 | 「app.patch(`${API_PREFIX}/admin/restrictions/:id`」 | 1 / 1 |  |
| 165 | editRestrictionDraft | services/api/src/admin/service.ts:598-603 | 「editRestrictionDraft」 | 2 / 1 |  |
| 166 | publishRestriction | services/api/src/routes/admin.ts:244-246 | 「app.post(`${API_PREFIX}/admin/restrictions/:id/publish`」 | 1 / 1 |  |
| 167 | publishRestriction | services/api/src/admin/service.ts:599-604 | 「publishRestriction」 | 2 / 1 |  |
| 168 | withdrawRestriction | services/api/src/routes/admin.ts:247-249 | 「app.post(`${API_PREFIX}/admin/restrictions/:id/withdraw`」 | 1 / 1 |  |
| 169 | withdrawRestriction | services/api/src/admin/service.ts:600-605 | 「withdrawRestriction」 | 2 / 1 |  |
| 170 | listAdminCategories | services/api/src/routes/admin.ts:267-271 | 「`${API_PREFIX}/admin/categories`」 | 1 / 1 |  |
| 171 | listAdminCategories | services/api/src/admin/ops/service.ts:314-319 | 「listAdminCategories」 | 6 / 2 |  |
| 172 | editCategory | services/api/src/routes/admin.ts:272-281 | 「`${API_PREFIX}/admin/categories/:id`」 | 1 / 1 |  |
| 173 | editCategory | services/api/src/admin/ops/service.ts:319-324 | 「editCategory」 | 7 / 2 |  |
| 174 | listAdminUsers | services/api/src/routes/admin.ts:288-292 | 「`${API_PREFIX}/admin/accounts`」 | 1 / 1 |  |
| 175 | listAdminUsers | services/api/src/admin/ops/service.ts:400-411 | 「listAdminUsers」 | 10 / 2 |  |
| 176 | suspendUser | services/api/src/routes/admin.ts:293-301 | 「`${API_PREFIX}/admin/accounts/:id/suspend`」 | 1 / 1 |  |
| 177 | suspendUser | services/api/src/admin/ops/service.ts:413-418 | 「suspendUser」 | 10 / 2 |  |
| 178 | listAdminJobs | services/api/src/routes/admin.ts:311-315 | 「`${API_PREFIX}/admin/jobs`」 | 1 / 1 |  |
| 179 | listAdminJobs | services/api/src/admin/ops/service.ts:508-513 | 「listAdminJobs」 | 6 / 2 |  |
| 180 | cancelAdminJob | services/api/src/routes/admin.ts:316-324 | 「`${API_PREFIX}/admin/jobs/:id/cancel`」 | 1 / 1 | 同区间共用 2 条 |
| 181 | cancelAdminJob | services/api/src/admin/ops/service.ts:515-520 | 「cancelAdminJob」 | 7 / 2 |  |
| 182 | listFlags | services/api/src/routes/admin.ts:332-336 | 「listFlags」 | 6 / 2（±2 内 4） |  |
| 183 | listFlags | services/api/src/admin/ops/service.ts:707-711 | 「listFlags」 | 8 / 3 |  |
| 184 | setFlag | services/api/src/routes/admin.ts:337-345 | 「`${API_PREFIX}/admin/feature-flags/:key`」 | 1 / 1 |  |
| 185 | setFlag | services/api/src/admin/ops/service.ts:713-718 | 「async function setFlag(ctx: AdminCallContext, key: string, body: unknown) {」 | 1 / 1 |  |
| 186 | hidePost | services/api/src/routes/admin.ts:353-361 | 「hidePost」 | 6 / 2（±2 内 4） |  |
| 187 | hidePost | services/api/src/admin/ops/service.ts:785-790 | 「hidePost」 | 8 / 2 |  |
| 188 | listAuditEvents | services/api/src/routes/admin.ts:255-259 | 「`${API_PREFIX}/admin/audit-events`」 | 1 / 1 |  |
| 189 | listAuditEvents | services/api/src/admin/service.ts:602-607 | 「listAuditEvents」 | 3 / 1 |  |
| 190 | grantCommunityMediaAccess | services/api/src/routes/media.ts:318-334 | 「service.grantCommunityMediaAccess(」 | 1 / 1 |  |
| 191 | grantCommunityMediaAccess | services/api/src/media/service.ts:1056-1174 | 「grantCommunityMediaAccess」 | 6 / 2 |  |
| 192 | readCommunityMediaContent | services/api/src/routes/media.ts:337-362 | 「service.readCommunityMediaContent(」 | 1 / 1 |  |
| 193 | readCommunityMediaContent | services/api/src/media/service.ts:1176-1222 | 「readCommunityMediaContent」 | 6 / 2 |  |
| 194 | dimension error_codes | services/api/src/contract.ts:14-58 | 「ERROR_STATUS_MAP」 | 3 / 3 |  |
| 195 | dimension error_codes | services/api/src/errors.ts:42-76 | 「ApiError」 | 3 / 3 |  |
| 196 | dimension pagination | services/api/src/knowledge/pagination.ts:30-72 | 「paginateKnowledge」 | 1 / 1 | 同区间共用 2 条 |
| 197 | dimension pagination | services/api/src/profile/service.ts:104-113 | 「async list(input: Identity, kind: 'crops' \| 'regions', options: {cursor?: string; limit: number; parent_code?: string}) {」 | 1 / 1 |  |
| 198 | dimension pagination | services/api/src/privacy/consent-pagination.ts:24-65 | 「paginateConsentRecords」 | 1 / 0（±2 内 1） | 同区间共用 2 条 |
| 199 | dimension pagination | services/api/src/profile/pagination.ts:24-65 | 「paginateCatalog」 | 1 / 0（±2 内 1） |  |
| 200 | dimension versioning | services/api/src/routes/profile.ts:37-41 | 「REVISION_REQUIRED」 | 1 / 1 |  |
| 201 | dimension versioning | services/api/src/routes/consents.ts:59-63 | 「REVISION_REQUIRED」 | 1 / 1 |  |
| 202 | dimension versioning | services/api/src/routes/knowledge.ts:193-199 | 「app.get(`${API_PREFIX}/knowledge/:id`」 | 1 / 1 | 同区间共用 2 条 |
| 203 | dimension versioning | services/api/src/profile/service.ts:86-87 | 「cropItems」 | 2 / 1（±2 内 2） |  |
| 204 | dimension idempotency | services/api/src/routes/support.ts:80-148 | 「runIdempotent」 | 1 / 1 |  |
| 205 | dimension idempotency | services/api/src/app.ts:828-834 | 「idempotencyStore」 | 2 / 1 |  |
| 206 | dimension idempotency | services/api/src/auth/idempotency.ts:31-33 | 「IDEMPOTENCY_TTL_SECONDS」 | 1 / 1 |  |
| 207 | dimension idempotency | services/api/src/auth/service.ts:104-107 | 「USER_SESSION_TTL_SECONDS」 | 2 / 1 |  |
| 208 | dimension idempotency | services/api/src/admin/identity.ts:23-26 | 「IDEMPOTENCY_KEY_MIN」 | 3 / 1 |  |
| 209 | dimension idempotency | services/api/src/admin/idempotent-write.ts:55-72 | 「issuedAt」 | 4 / 3（±2 内 4） |  |
| 210 | dimension source_kind | services/api/src/db/catalog.ts:5-22 | 「HomePreview」 | 5 / 4 |  |
| 211 | dimension source_kind | services/api/src/knowledge/service.ts:102-104 | 「toISOString」 | 1 / 1 |  |
| 212 | dimension source_kind | packages/reference/constants.mjs:1-60 | 「CONTRACT_VERSION」 | 1 / 1 |  |
| 213 | dimension source_kind | services/api/src/ocr/reference.ts:35-49 | 「SUBSTITUTE_MARK」 | 5 / 3 |  |
| 214 | dimension source_kind | services/api/src/ocr/reference.ts:223-245 | 「createUnwiredDosePort」 | 2 / 2 |  |
| 215 | dimension execution_modes | services/api/src/contract.ts:9-11 | 「EXECUTION_MODES」 | 2 / 2 |  |
| 216 | dimension execution_modes | services/api/src/config.ts:155-283 | 「loadConfig」 | 1 / 1 |  |
| 217 | dimension execution_modes | services/api/src/auth/wechat.ts:66-76 | 「createWechatIdentityProvider」 | 1 / 1 |  |
| 218 | dimension cancel | services/api/src/recognitions/service.ts:757-797 | 「cancelJob」 | 3 / 1 |  |
| 219 | dimension cancel | services/api/src/jobs/routes.ts:64-80 | 「`${API_PREFIX}/jobs/:id/cancel`」 | 1 / 1 | 同区间共用 2 条 |
| 220 | dimension cancel | services/api/src/jobs/registry.ts:283-309 | 「async cancel(input) {」 | 1 / 1 |  |
| 221 | dimension cancel | services/api/src/routes/admin.ts:316-324 | 「`${API_PREFIX}/admin/jobs/:id/cancel`」 | 1 / 1 | 同区间共用 2 条 |
| 222 | dimension timeout | services/api/src/db/pool.ts:27-53 | 「createPool」 | 1 / 1 |  |
| 223 | dimension timeout | services/api/src/auth/wechat.ts:32-33 | 「WECHAT_CODE2SESSION_URL」 | 2 / 1 |  |
| 224 | dimension timeout | services/api/src/knowledge/service.ts:86-89 | 「q.toLocaleLowerCase(」 | 1 / 1 |  |
| 225 | dimension timeout | services/api/src/recognitions/service.ts:525-542 | 「runProviderWithDeadline」 | 2 / 1 |  |
| 226 | dimension timeout | services/api/src/recognitions/service.ts:525-544 | 「runProviderWithDeadline」 | 2 / 1 |  |
| 227 | dimension timeout | services/api/src/ocr/service.ts:53-59 | 「DEFAULT_JOB_DEADLINE_MS」 | 2 / 1 |  |
| 228 | dimension timeout | services/api/src/speech/service.ts:598-616 | 「runProviderWithDeadline」 | 3 / 1 |  |
| 229 | dimension timeout | services/api/src/tts/service.ts:819-842 | 「SynthesisService」 | 8 / 3 |  |

## §4 两条变异原文

两次都直接改已落盘的 JSON，跑工具，再按 `.pg17/tmp/s50-status-applied.json` 备份逐字节还原（还原后 `git diff --stat` 回到 `229 +`）。

### §4.1 变异一：把一条新锚点改成「只在区间外出现」的串 ⇒ 必须 exit 1

- 目标：`listCrops` 的 `services/api/src/routes/profile.ts:43-53`（原 symbol：``app.get(`${API_PREFIX}/catalog/${kind}` ``）。
- 改成：`` `${API_PREFIX}/me/profile` `` —— 该串在 `routes/profile.ts` 里真实存在，但只出现在第 **25**、**29** 行（`app.get`/`app.put` 的 `/me/profile` 注册），距区间 43-53 远超 ±2。
- 命令：`node E:\GengYunCommander\.pg17\tmp\s50-mutate.mjs services/api/src/routes/profile.ts 43-53 '`${API_PREFIX}/me/profile`'` → `mutated services/api/src/routes/profile.ts:43-53`，随后 `node tools/verify-contract-status.mjs`：

```
ERROR: 语义错误 · listCrops: services/api/src/routes/profile.ts:43-53 的锚点「`${API_PREFIX}/me/profile`」不在引用行范围内（容差 ±2 行；实际出现在第 25、29 行）
FAIL: 契约实现状态对照校验未通过（1 项）[形状错误 0 / 语义错误 1 / 表格漂移 0]
```

exit code = **1**（期望）。还原后 `node tools/verify-contract-status.mjs` exit **0**、`git diff --stat` 回到 `229 +`。

### §4.2 变异二：把一条新锚点改成文件里不存在的串 ⇒ 必须 exit 1

- 目标：`loginAdmin` 的 `services/api/src/auth/password.ts:1-40`（原 symbol：`hashPassword`）。
- 改成：`noSuchAnchorForMutation`（文件中不存在）。
- 命令：`node E:\GengYunCommander\.pg17\tmp\s50-mutate.mjs services/api/src/auth/password.ts 1-40 noSuchAnchorForMutation` → `mutated services/api/src/auth/password.ts:1-40`，随后：

```
ERROR: 形状错误 · post /admin/auth/session: services/api/src/auth/password.ts 中找不到锚点「noSuchAnchorForMutation」
FAIL: 契约实现状态对照校验未通过（1 项）[形状错误 1 / 语义错误 0 / 表格漂移 0]
```

exit code = **1**（期望）。还原后 exit **0**。

## §5 门禁（逐条 exit 0）

| # | 命令 | exit | 关键读数 |
| --- | --- | --- | --- |
| 1 | `npm run lint` | 0 | `tsc --noEmit services/api/tsconfig.json`、`apps/admin/tsconfig.json` 与仓库卫生扫描全 PASS，`lint 通过` |
| 2 | `node tools/verify-release-materials.mjs` | 0 | `15/15 项通过`（离线文档核验） |
| 3 | `npm run test:docs` | 0 | 研究记录 `5 通过 / 0 失败 / 4 legacy 已钉住`；`docs/research 结构校验` PASS |
| 4 | `node tools/verify-contract-status.mjs` | 0 | 6 条 PASS（含「证据锚点 370 条（区间内 229 + 仅整文件 141）」），无形状/语义错误 |
| 5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | `tests 6 / pass 6 / fail 0` |
| 6 | `node --test tests/unit/contract-status-anchors.test.mjs tests/unit/contract-status-tool.test.mjs` | 0 | `tests 29 / pass 29 / fail 0`（含「真实台账 `--write-doc` 臂不改写文档」） |
| 7 | `git diff --check` | 0 | 无空白/行尾问题 |

`docs/architecture/contract-implementation-status.md`：跑了官方 `node tools/verify-contract-status.mjs --write-doc`，**没有产生任何文档变更**（`git status` 仍只有 `contract-status.json`），因此本片没有重生成文档、也没有手改文档。

## §6 未取得

- **取不到符号的条目：0 条**。229 条都拿到了可在区间内自证的符号，没有硬凑、也没有留空条目。
- **符号语义仍由人判**：工具只证明「这个串在该区间里出现过」，不证明它确实指向这条证据要说明的行为。本片能做到的是把「文件里出现过」收紧成「区间里必须出现」，语义对应关系依旧要 reviewer 抽查；风险最高的部分已单列——§3.3 的 10 个 ±2 容差区间、§2.9 的 3 条人工覆盖、以及 94 条非全文唯一命中。
- **141 条 `name` 锚点引用（无行号）本片未动**：它们没有 `lines`，工具只能记 `fileOnly`；要让它们也进入 `in-range` 档，需要先给这些引用补行区间，属于另一片工作。
- **`docs/architecture/contract-implementation-status.md` 第 23 行的旧叙述已过时**（「基线 `56042f7` 实测 …`symbol`/`anchor` 命中 0 条 … 故锚点层目前只计数、尚无可核样本」）。按派单「不手改文档」，本片未改；建议后续文档片按本页读数更新该段。
- 变更只在 `docs/architecture/contract-status.json`；未碰 `operations.json`、`services/**`、`apps/**`、`packages/**`、`migrations/**`、`tests/integration/**`、`deploy/**`、`.github/**`。

## §7 风险

1. **符号会随重构失效，而且这是有意的硬失败**：229 条里 127 条全文唯一，一旦函数改名、`const` 被内联、路由字面量改拼接方式，工具会立刻报「找不到锚点」或「不在引用行范围内」——这正是本片想要的效果，但意味着后续重构 PR 需要同步更新台账锚点，不能指望它自动跟随。
2. **`signature`/`method-head` 类锚点对参数列表敏感**：整行声明头里包含参数类型（如 `async put(input: Identity, body: ProfileInput, ifMatch: string, idempotencyKey: string) {`），参数增删改都会失配；这类共 8 + 1 条，需要时改回裸名。
3. **共用区间的 8 对引用**：一条 symbol 服务两条操作，若其中一条证据被移到别处，锚点要重新取；工具只按「同文件不相交区间不得共用」判冲突，重叠区间共用是允许的。
4. **容差 ±2 是折中**：基线实测「声明在区间起点前 1-2 行」的情况占多数，取 0 会误判大量既有写法；本片有 10 个区间落在容差里（§3.3），复核时应优先看这些。
5. **区间漂移不会报错**：工具只要求「区间内出现该串一次」，如果代码整体上下移动但符号仍在区间内，锚点不会失效也不会提示——它证明的是「指得到」，不是「指得准」。
