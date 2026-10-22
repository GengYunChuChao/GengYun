# GY-R30 · 社区 `public_posting` 用途闸：消费面复验与裁定材料（2026-10-22）

> **派单前提**：`public_posting` 这个 purpose 只登记、无人消费；没有路由在发帖/评论时校验它，因此需要在服务层补一道闸。
>
> **实测结论**：**前提不成立**。`public_posting` 有 **5 个真实消费点**（4 条投稿路由 + 1 条媒体上传的间接校验），闸早在 `f422ade4`（GY-R28 W10 / PR #406）就合入 `main` 并完成装配，且既有用例已有正/负两向断言。本片**不改产品代码**（再挂一层是与 `main` 逐字重复的第二套实现，违反 `AGENT.md` §3「严禁为凑工作量制造改动」），只交：
>
> ① 消费面逐条行号证据（§1）；② 现成可复用中间件的盘点（§1.4）；③ 我**自己跑**的正/负响应原文与负控制（§3–§4）；④ **仍然真实存在的那个缺口**——闸有牙，但真机上没有任何一条路能拿到这把钥匙——连同三个方案与代价交监工裁定（§5–§6）。

---

## 0 结论摘要

| 项 | 实测结果 | 证据位置 |
| --- | --- | --- |
| 派单前提（只登记未消费） | **不成立**：`services/` 下 14 处命中，其中 **4 条路由的 preHandler + 1 条媒体动态校验**是真校验 | §1.1 |
| 是否有现成中间件可复用 | 有，且**已经接上了**：`consent({ purpose }) → requireConsent`，PG 侧单事务读取口 | §1.4、§2 |
| 是否"接线即完事" | 接线早已完成；全仓**唯一**调用点带 `{ consent: consentGate }` | `services/api/src/app.ts:1967` |
| 闸是否真有牙 | **有**：摘掉 `community.ts:406` 那一行 ⇒ 3 条负控制全红；恢复后 `sha256` 逐字节一致 | §4 |
| 正控制 | 有授权 ⇒ 发帖 **201**、评论 **201**（响应原文见 §3） | §3 |
| 负控制 | 无授权 ⇒ 发帖 **403 `CONSENT_REQUIRED`**、评论 **403**，`message` 指名缺的那一码 | §3 |
| 门禁 | `community-*.test.mjs` 176/176 绿；`privacy-*.test.mjs` 23/23 绿；`verify-contract-status` 6 行 PASS | §7 |
| **残余缺口** | 闸已生效，但**三层同时缺**：① 生产库无 `consent_policies` 种子（授权面自己就 403）；② 契约无「用途政策」读取面；③ 客户端零授权入口 ⇒ 真机新用户发帖**必然** 403 且无路可走 | §5（**待裁定**） |
| 本片代码改动 | **0 行** | §10 |

---

## 1 侦察结论：`public_posting` 是**实现本体**，不是空登记

### 1.1 五个消费点（逐条读码核对）

| # | 位置 | 角色 | 是不是"真校验" |
| --- | --- | --- | --- |
| 1 | `services/api/src/routes/community.ts:406` | `deps.consent({ purpose: 'public_posting' })`——投稿面 preHandler 的**实际构造点** | ✅ **是**（本片负控制证明） |
| 2 | `services/api/src/routes/community.ts:386-391` | `PUBLIC_POSTING_GATED_ROUTES`：4 条被闸路由的清单，且被单测逐字锁定 | ✅ 是（清单即证据） |
| 3 | `services/api/src/privacy/consent-pg.ts:11` | `CONSENT_PURPOSES = [..., 'public_posting']`——PG 侧用途闭集 | ✅ 是（数据源） |
| 4 | `packages/privacy/constants.mjs:94` | `community_image: ['media_processing', 'public_posting', 'external_inference']`——**媒体上传**侧对 `public_posting` 的间接要求 | ✅ **是**（第 5 条消费路径，见 §1.3） |
| 5 | `services/api/src/privacy/grant-pg.ts:33` | 授予口校验 `purpose ∈ {…,'public_posting'}` | ✅ 是（写入侧） |

另有登记/注释类命中（不构成校验）：`services/api/db/migrations/0001_initial_schema.sql:239,321`（`public_posting_epoch` 列）、`0003_privacy_consent.sql:35`（`consent_purpose` 枚举值）、`services/api/src/app.ts:1966`、`services/api/src/routes/media.ts:153,169`（注释）、`services/api/src/routes/community.ts:364,371,385,394,399`（注释）。

### 1.2 挂载点：16 条社区路由里只有 4 条挂闸

`services/api/src/routes/community.ts` 共 **16** 条路由（`app.get|post|patch|delete|put` 各注册点行号：201/211/223/232/241/251/264/276/285/294/305/314/323/332/341/353）。其中：

| 契约 operation | 方法与路由 | 注册行 | preHandler | 挂闸 |
| --- | --- | --- | --- | --- |
| `createPost` | `POST /posts` | `:211` | `postingPreHandlers(...)` `:213` | ✅ |
| `editPost` | `PATCH /posts/{id}` | `:232` | `:234` | ✅ |
| `createComment` | `POST /posts/{id}/comments` | `:264` | `:266` | ✅ |
| `editComment` | `PATCH /comments/{id}` | `:285` | `:287` | ✅ |
| 其余 12 条（读列表/读详情/删帖/读评论/读评论详情/删评论/赞×2/评论赞×2/举报/读举报） | — | `:201,223,241,251,276,294,305,314,323,332,341,353` | `guards.requireUser` | ❌（**刻意不挂**） |

构造点（`services/api/src/routes/community.ts:401-407`，原文）：

```ts
function postingPreHandlers(
  guards: AuthGuards,
  deps: { consent?: CommunityConsentPort },
) {
  if (deps.consent === undefined) return guards.requireUser;          // :405
  return [guards.requireUser, deps.consent({ purpose: 'public_posting' })];  // :406
}
```

三点读法：

1. **鉴权先于授权**：数组顺序是 `[requireUser, 用途闸]` ⇒ 游客仍拿 **401 `SESSION_REQUIRED`**，不会把"没登录"误报成"没授权"（§3 场景 F 实测）。
2. **不挂 `dataType`**（`:396-399` 注释）：挂了会把社区图片那套附加码搬到纯文字帖上，凭空多一次拒绝。
3. **边界正确**：读/赞/举报/删自己的内容不发布新内容，挂上去只会让既有用例凭空 403（§3 场景 G 实测：无授权账号读列表 **200**）。

### 1.3 第 5 个消费点：媒体上传按 `community_image` 间接校验 `public_posting`

`services/api/src/routes/media.ts:175-191` 的 `uploadConsentPreHandler` 按 `request.body.purpose` 取 `dataType`，再以 `{ purpose: 'media_processing', dataType }` 交给授权端口 —— **其余必需码由端口按 `dataType` 逐条补齐**，`community_image` 的那一条里就有 `public_posting`（`packages/privacy/constants.mjs:94`）。且取不到 `dataType` 时**显式拒绝**而非放行（`media.ts:180-183`，fail-closed）。

⇒ 即使把 4 条投稿路由全摘掉，发社区图片仍会因 `public_posting` 被拦。这是"闸只有一道"这一先验假设的第二个反例。

### 1.4 现成可复用中间件（派单问的 `requireConsent` 就是它）

| 层 | 位置 | 形态 |
| --- | --- | --- |
| 语义实现（纯函数，可注入） | `packages/privacy/guard.mjs:116,124` | 缺授权 ⇒ `PrivacyError('CONSENT_REQUIRED', '缺少用途授权：<purpose>')`；资料型多用途逐个补齐 |
| PG 实现（生产） | `services/api/src/privacy/consent-pg.ts:138-146` | 单事务读 `privacy_epochs ⨝ consent_records`（`:140-141`），再交 `referenceGuard(...).requireConsent(requirement)`（`:144`）——**与 stub 路径同一份语义代码** |
| API 适配（把 `identity` 版包成 Fastify preHandler） | `services/api/src/privacy/egress.ts:137-155` | 缺 bearer ⇒ `SESSION_REQUIRED`；否则 `service.requireConsent(...)`；`ApiError` 原样透出 |
| 社区域端口类型 | `services/api/src/routes/community.ts:383` | `CommunityConsentPort`（结构同形，避免在文件头新增 import 行） |
| 装配 | `services/api/src/app.ts:896-901` → `:1967` | `privacyInjection.consent ?? (pool === null ? undefined : createPostgresConsentGate(...))` |

---

## 2 为什么本片**不改**产品代码（三条，缺一不可）

1. **没有"接线"这件事可做**：`registerCommunityRoutes` 全仓只有一个调用点（`services/api/src/app.ts:1967`），且**已经**传了 `{ consent: consentGate }`。再改就是改动一个已正确接好的调用。
2. **派单点名要的正/负测试已经存在**，并且覆盖比派单要求更全：负控制①（无授权投稿 403 + 零写入）、①-补（无授权发评论 403）、②（撤回后再 403）、③（12 条非投稿入口不得 403）、正控制（201/200）、闸清单（4 条逐字）。见 `tests/unit/community-posting-consent.test.mjs:120,133,157,179,214,262`。**重写一遍是第二套实现。**
3. **真正剩下的洞不是"少一道闸"，而是"闸有牙、钥匙不存在"**——要补它必然牵动①契约 schema（新只读 operation 或改 `ConsentPage` 形状）、②生产库政策数据（运维导入，非代码）、③客户端 UI。前两项正是本片红线（⛔ 不改契约 schema、⛔ 不新增迁移）。按派单第 2 条后半句，**放弃改动，只出裁定材料**。

⇒ 本片的行事准则是：**证明闸是真闸（负控制），把闸的上游缺口说清（§5），把方案与代价摆出来（§6），不替监工拍板。**

---

## 3 正/负响应原文（本片实测，逐字）

探针：`buildApp` + `privacyInjection: { consent: <合成闸> }` + `communityInjection`（内存 store、合成 pass 端口），`APP_EXECUTION_MODE=stub`。走的就是 `app.ts:1967` 那一条真实装配路径（合流当前 main 后的行号；本片测量时在 `:1808`）。**探针跑完即删，不入库**（`git status` 无残留，见 §10）。

### A. 无授权发帖 ⇒ 403

```
HTTP 403
{"error":{"code":"CONSENT_REQUIRED","message":"缺少用途授权：public_posting","retryable":false,"details":[]},"meta":{"request_id":"a6a3b1c6-…","contract_version":"1.0.0","execution_mode":"stub"}}
```

读法：`message` **指名**缺的是 `public_posting`（不是泛泛的"无权限"）；`retryable:false`（重试无用）；无 `data` 成功封套。

### B. `grant(public_posting)` 之后发帖 ⇒ 201

```
HTTP 201
{"data":{"id":"<post-id>","revision":1,"author":{…},"title":"稗草防除经验交流","visibility":"published","audit_state":"approved",…},"meta":{…}}
```

### C. 无授权发评论（帖子已存在，帖子作者不是他）⇒ 403

```
HTTP 403
{"error":{"code":"CONSENT_REQUIRED","message":"缺少用途授权：public_posting","retryable":false,"details":[]},"meta":{…}}
```

### D. `grant` 之后发评论 ⇒ 201

```
HTTP 201
{"data":{"id":"<comment-id>","revision":1,"post_id":"…","body":"…","visibility":"published","audit_state":"approved",…},"meta":{…}}
```

（第一次跑 D 时我漏了 `If-Match`，拿到 **428 `REVISION_REQUIRED`**——这本身也是一条读数：**闸已放行**才会走到版本守卫，说明 403 与 428 的次序是"授权 → 版本"，不是"版本 → 授权"。）

### E. 撤回后再发帖 ⇒ 403（回到 A）

```
HTTP 403
{"error":{"code":"CONSENT_REQUIRED","message":"缺少用途授权：public_posting","retryable":false,"details":[]},"meta":{…}}
```

### F. 游客（无 bearer）发帖 ⇒ 401（**不是** 403）

```
HTTP 401
{"error":{"code":"SESSION_REQUIRED","message":"需要用户会话","retryable":false,"details":[]},"meta":{…}}
```

⇒ 鉴权先于授权，派单担心的"把未登录误报成未授权"不存在。

### G. 无授权账号读列表 ⇒ 200（不挂闸）

```
HTTP 200
{"data":{"items":[{"id":"…","revision":1,"author":{…}…}]},"meta":{…}}
```

⇒ 用途闸的**边界**是"发布"，不是"读"。这条必须绿，否则闸挂错了地方。

---

## 4 负控制：摘掉闸那一行，三条负控制立刻红（本片亲自跑）

只把 `services/api/src/routes/community.ts:406` 换成 `return guards.requireUser;`，其余一字不动：

```
sha256_before=301F4DC91BA94EDB5A91EFA9DD6ABC39678D28DBA62A436870346DAE9416D7AC
sha256_mutated=778BBE74ECCEE37CD038AB6408D67D8A8F2384E487B3B8D4C6DDE0872549FCEE

✔ 闸清单：`public_posting` 恰挂在 4 个投稿面
✖ 负控制①：无授权投稿 ⇒ 403 CONSENT_REQUIRED，且帖子/评论/审核/幂等账本零写入
✖ 负控制①-补：无授权发评论 ⇒ 403，且评论行不落库
✔ 正控制：有授权 ⇒ 发帖 201、编辑 200、评论 201、编辑评论 200
✖ 负控制②：撤回 `public_posting` ⇒ 发帖/评论/编辑三条面同时再 403
✔ 负控制③：无授权账号打读/赞/举报/删除 12 条入口 ⇒ 无一条 403 CONSENT_REQUIRED
ℹ tests 6   ℹ pass 3   ℹ fail 3
```

恢复（`ReadAllText`/`WriteAllText` 原样回写，不经我手重建内容）：

```
sha256_after=301F4DC91BA94EDB5A91EFA9DD6ABC39678D28DBA62A436870346DAE9416D7AC
identical=True
git_dirty_lines=0
```

**两条必须一起读的结论**：

1. 红的**全是负控制**，正的（正控制、闸清单、负控制③）仍绿 ⇒ 红是"闸被摘掉"造成的，不是环境坏了。
2. 摘闸后"有授权 ⇒ 201"**照样绿** ⇒ **正控制单独不能证明闸存在**，只有负控制能。这正是"`public_posting` 到底有没有人消费"这个问题的唯一判决性实验——答案是**有**。

---

## 5 待裁定：闸有牙，但真机上拿不到钥匙（三层同时缺）

### 5.1 三层缺口（这是本片真正要交的东西）

```
第①层 生产库无政策行  →  POST /me/consents 自己就 403（连授予都做不了）
第②层 契约无政策读取面 →  客户端拿不到正确的 policy_version（不知道要授予什么版本）
第③层 客户端零授权入口 →  用户没有任何按钮可点，403 文案是死胡同
```

### 5.2 事实链（全部实测/读码，逐条给位置）

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | 迁移**明确不提供**生产政策种子：「GY-I27 operator-reviewed grant authority. **No production policy or recipient seeds.**」 | `services/api/db/migrations/0009_consent_policy.sql:1`；表建于 `:4-23`；`enabled` 默认 `false`（`:17`） |
| 2 | 授予时若该用途没有启用的政策行 ⇒ **403 `CONSENT_REQUIRED`「没有可用的已核验用途政策」** | `services/api/src/privacy/grant-pg.ts:47-49` |
| 3 | 授予还要求客户端**自己带上** `policy_version`，且必须与服务端政策行**逐字相等** | `grant-pg.ts:54`（不等 ⇒ `REVISION_CONFLICT`）；契约必填：`packages/contracts/openapi.json:12362-12366`（`purpose`/`policy_version`/`recipient_ids` 三个 required）；入参校验 `services/api/src/routes/consents.ts:28-32` |
| 4 | 契约里只有 3 个 consent operation，**没有**"有哪些用途 / 各自政策版本与文案"的读取面 | `packages/contracts/operations.json:95-115`（`listConsents` / `grantConsent` / `withdrawConsent`，仅此三条） |
| 5 | `listConsents` 的响应只回**已存在**的授权记录（含 `policy_version`）；从未授予过的用途**没有记录** ⇒ 拿不到版本号 | `packages/contracts/openapi.json:12368-12399`（`Consent` 形状）；`services/api/src/routes/consents.ts:40-49` |
| 6 | 闸的判定读的是 `privacy_epochs`（`current_epoch>0`）；该类行**只有授予路径才会创建**，注册/登录不预置 | `services/api/src/privacy/consent-pg.ts:140-146`；全仓唯一写入点 `services/api/src/privacy/grant-pg.ts:106`（排除测试后 `INSERT INTO privacy_epochs` 仅此一处） |
| 7 | 客户端对 `/me/consents` **零调用**（全仓仅注释引用） | `miniprogram/utils/identify-api.js:202`；`miniprogram/pages/profile/profile.wxml:162-165` |
| 8 | 客户端 403 文案已写好，但**没有动作可给** | `miniprogram/utils/community-api.js:366`（"社区公开发布需要「公开发布」用途授权，未授权时不会发布"——只陈述，不给路径） |
| 9 | 客户端自承"契约缺用途政策读取面"，且刻意不写"去授权"以免指向不存在的功能 | `miniprogram/utils/identify-api.js:960-961`、`:202-205`、`profile.wxml:162-165` |
| 10 | 契约台账**已经**把 `grantConsent` 记为 `partial`，理由正是"该 purpose 的已核验可用政策行须先落入 `consent_policies`，否则 403" | `docs/architecture/contract-implementation-status.md:61`（另 `:60` 记 `listConsents` 为 partial） |

**推论（读码，不是真机实测）**：真库上，一个从未被服务端预置授权的用户，在社区发帖会稳定拿到 §3-A 那个 403；而他能走的三条补救路全部断在第①/②/③层——`POST /me/consents` 因无政策行先 403，即使有政策行客户端也不知道 `policy_version`，而客户端根本没有入口。

### 5.3 顺带发现：客户端两处用户可见文案**互相打架**

| 位置 | 原文 | 含义 |
| --- | --- | --- |
| `miniprogram/pages/profile/profile.wxml:176` | 「应用内的授权与撤回入口尚未接入，因此本页暂不提供授权开关；**在入口接入前不会默认替您授权**。」 | 承诺**不会**默认授权 |
| `miniprogram/utils/identify-api.js:962` | 「应用内授权入口尚未接入，**暂时只能由服务端预置授权**；未获得授权时不会外发照片…」 | 承诺**会**由服务端预置 |

这两句不可能同时为真。它直接影响 §6 里方案 B/C 的措辞口径——**无论选哪个方案，这两句必须一并对齐**，否则是"把不存在的功能写成承诺"（`profile.wxml:162-165` 自己定的红线）。

---

## 6 三个方案与代价（⛔ 本片不选，交监工裁定）

> 前置条件（三案共同，且**必须先做**）：运维以「已核验政策」身份向 `public.consent_policies` 导入一行 `purpose='public_posting'`（`policy_version` / `source_kind='verified'` / `source_ref` / `content_sha256` / `review_evidence_ref` / 有效期 / `reviewed_by`+`reviewed_at` / `enabled=true`）。没有这一行，**A/B/C 全部无效**——`grant-pg.ts:49` 会先拒。该动作是数据运维，不在任何 PR 里。

| 方案 | 做法 | 牵动面 | 代价 / 风险 | 是否触碰本片红线 |
| --- | --- | --- | --- | --- |
| **A. 契约新增只读「用途政策」面** | 新 operation（如 `listConsentPurposes` / `GET /me/consent-purposes`）：回每用途的 `policy_version`、文案引用、当前是否已授予；客户端据此渲染开关，授予/撤回复用既有 `POST`/`DELETE /me/consents` | `packages/contracts/{operations,openapi,examples,states}.json`；`services/api/src/routes/consents.ts`；`docs/architecture/contract-status.json`（operation 计数 113 → 114、证据锚点）；`miniprogram` 授权 UI | **最干净、单一真相源**；但 operation 计数变化会牵动既有台账与 `verify-contract-status` 的锚点，须独立一片；客户端 UI 再一片 | ⛔ **是**（改契约 schema）⇒ 必须另派 |
| **B. 扩充既有 `listConsents` 响应（不新增 operation）** | 在 `ConsentPage` 上加一个只读数组（如 `available[]`：用途 / 当前 `policy_version` / 是否已授予），客户端复用既有读取 | `packages/contracts/openapi.json`（`ConsentPage`）+ `examples.json`；`consents` 路由与 PG 读取；客户端 UI | 契约**operation 计数不变**（113 仍是 113），台账锚点改动面小于 A；但语义变浑（"我的授权列表"携带"目录/政策"数据），且 `listConsents` 现状是 `partial`（`contract-implementation-status.md:60`），叠加改动会混淆两件事的验收 | ⛔ **是**（改契约 schema，虽不加 operation）⇒ 必须另派 |
| **C. 服务端在注册/首登时预置 `public_posting` 授权** | 写入 `consent_records` + `privacy_epochs`（`state='granted'`）；撤回走既有 `DELETE /me/consents/:purpose` | 服务端登录/注册链路 + `grant-pg` 复用 + 隐私文案 | 契约**零改动**、无迁移；但这是"默认同意"，与 `profile.wxml:176` 的公开承诺直接冲突，也与 `0009` 的"operator-reviewed"授权哲学冲突；且仍需 §6 前置的政策行；此外它把"授权"变成"注册副作用"，撤回后再次发帖仍会 403（届时又回到"没有入口"的原点） | ⛔ 否（不碰契约、不碰迁移）——但**这是产品/隐私裁定，不是本片能拍板的** |

**建议（仅供监工参考，本片不执行）**

1. **先做 §6 前置（导入政策行）**，否则 A/B/C 都空转。
2. 若要"用户能自己授权"，**A 优于 B**：语义单一、不把目录数据塞进"我的授权"，长期不留债；operation 计数从 113 变 114 是**可见的、一次性的**代价，比 B 的"形状悄悄变宽"更容易审计。
3. **C 不建议作为终局**：它只把 403 推迟到"撤回之后"，并把默认同意写进注册链路，与仓库既有隐私口径冲突。若确实需要"上线即可用"的过渡，正确形式是**显式决定的版本开关 + 明确的用户可见说明**，而不是让用户在 403 文案前无路可走。
4. 无论选哪个，§5.3 那两句客户端文案必须同批对齐。

---

## 7 门禁读数（本片实测）

| 命令 | 读数 | 退出码 |
| --- | --- | --- |
| `node --test tests/unit/community-posting-consent.test.mjs` | `tests 6` / `pass 6` / `fail 0` / `duration_ms 10189.8` | 0 |
| `node --test "tests/unit/community-*.test.mjs"` | `tests 176` / `pass 176` / `fail 0` / `duration_ms 9250.2` | 0 |
| `node --test "tests/unit/privacy-*.test.mjs"` | `tests 23` / `pass 23` / `fail 0` | 0 |
| `node tools/verify-contract-status.mjs` | 6 行 `PASS`：覆盖 113 条契约操作；已装配 109；implemented 13 / partial 96 / planned 4；横切维度 8；形状错误 0；语义错误 0；证据锚点 412 条带锚点、无锚点不可核 0 | 0 |

- 本片**没有**改 workflow ⇒ 未跑 `tests/unit/ci-real-pg-wiring.test.mjs`（派单口径：动 workflow 才需要）。
- 依赖：工作树自带 `node_modules`（`node v24.16.0`），**未**做任何跨工作树联接。
- 契约台账 `docs/architecture/contract-status.json` **未被本片修改**（四张在飞 PR 占用）。

---

## 8 不证明什么

- **不证明真库授权链**：§3 的闸走的是注入的合成端口（`privacyInjection.consent`），不是 `createPostgresConsentGate` 的真 PG 读取。社区 × 真 PG 授权的组合仍未被任何脚本覆盖；`tests/integration/community-pg.mjs` 自己写明它验的是"内容真落库"而非"PG 授权读取口"，且本机无 `COMMUNITY_PG_TEST_URL` ⇒ 该脚本按设计未执行（**未取得**）。
- **不证明生产环境一定 403**：§5 的"新用户必 403"是**读码推论**（§5.2 #2/#6 + §3-A 的判定代码同源），不是真机实测。若运维已向某环境导入政策行并预置授权，该环境不会 403。
- **不证明客户端行为**：§5 的客户端结论全部来自源码 grep 与注释，**没有真机跑**。
- **不证明审核/发布语义**：`visibility` / `audit_state` 由确定性硬规则 + 合成 pass 端口给出，`real` 审核供应商未接。
- **不证明 `consent_policies` 的生产导入流程**：本片只读码确认"迁移不带种子"，没有查任何真实环境的表内容。
- **不证明**这 4 条之外没有别的"看起来实现了、实际有洞"的发布入口——只证了 `public_posting` 这一条**不缺闸**。

---

## 9 与既往页面的差异（行号漂移与记注复验）

| 记注 | 原文 | 本次实测 | 结论 |
| --- | --- | --- | --- |
| `docs/verification/gy-r28-w10-posting-consent-20261021.md:13` | 注入位置 `services/api/src/app.ts:1792` | 现为 `:1967` | **行号漂移**（后续合入推移；本片测量时在 `:1808`），结论不变 |
| `docs/verification/gy-i14-community-chain-20261021.md:190` | 「`registerCommunityRoutes(...)`（`app.ts:1789`）**也不收** consent 参数」 | 现 `app.ts:1967` **收** `{ consent: consentGate }` | **已不成立**：该页记的是 #406 之前的状态 |
| 本工作树草稿 `gy-r30-public-posting-gate-20261022.md`（上个代理，未跟踪） | §5.1 引 `profile.wxml:163`、`:162-176` | 实际注释在 `profile.wxml:162-165`，用户可见那句在 `:176` | **行号修正**；并补两处草稿未列的事实：`0009` 无生产种子（§5.2 #1）、`consent_policies` 缺行使授予自身 403（§5.2 #2）、`privacy_epochs` 只在授予路径创建（§5.2 #6）、以及 §5.3 的文案互斥 |
| `docs/verification/gy-i04-login-chain-20261021.md` 的「口径决定」第 6 条 | 契约无用途政策读取面 | 仍然成立（`operations.json:95-115` 只有 3 条） | 未漂移 |

---

## 10 本片的交付边界

- **代码改动：0 行**。`git diff --stat` 只有本页。
- 唯一动过产品文件的动作：§4 的负控制（摘闸 → 跑 → 原样回写 → `sha256` 逐字节一致 → `git status` 0 行脏）。
- §3 的探针脚本为临时文件，跑完即删，未入库。
- 待裁定：§6 的 A/B/C，等监工裁定后再派实现片；在此之前**不**动 `packages/contracts`、**不**新增迁移、**不**改 `docs/architecture/contract-status.json`、**不**改 consent 语义。
