# GY-R28 W10 · 社区投稿面 `public_posting` 用途授权闸（2026-10-21）

> 前置文件：`docs/verification/gy-i04-login-chain-20261021.md` §1.3 裁决 5、§2.4(d)、§6.2 第 2 项；
> `docs/verification/gy-i14-community-chain-20261021.md` §2.10（E3-2）与 §6 的 E3-2 行。
> 本片只做一件事：把 `public_posting` 用途闸挂到**向公众发布**的社区写入口，并备好授权夹具，
> 保证既有社区用例不被误伤。**不**改契约、**不**新增错误码、**不**改迁移号。

## 0 结论摘要

| 项 | 结果 | 证据位置 |
| --- | --- | --- |
| 闸挂在哪 | **4 条投稿面**（见 §1），每条都在 `guards.requireUser` **之后** | `services/api/src/routes/community.ts:213,234,266,287` |
| 注入位置 | `buildApp` 把**已有的那一个** `consentGate` 传给社区域，只加这一处 | `services/api/src/app.ts:1792` |
| 无授权 ⇒ | 403 `CONSENT_REQUIRED`（`message` 指名 `public_posting`，`retryable=false`，`details=[]`，无成功封套，`no-store`）**且零内容写入** | §3.1 读数 |
| 有授权 ⇒ | 201/200（发帖/编辑/评论/编辑评论），强 ETag 与 revision 与未挂闸同形 | §3.2 读数 |
| 撤回后 ⇒ | 同 4 条面**再次 403**，已发布内容不被删除 | §3.3 读数 |
| 没挂的入口 | 12 条读/赞/举报/删除，无授权账号打过去**一条都不会**拿到 `CONSENT_REQUIRED` | §4 读数 |
| 既有社区用例 | 改动前（未备夹具）**12/12 全红**，改动后**189/189 全绿**；断言口径一字未改 | §2 读数 |
| 真库授权链 | **未取得**：本机无 `COMMUNITY_PG_TEST_URL` ⇒ 集成脚本 exit 77 | §6 |

## 1 挂了闸的端点（只有 4 条，全部是「向公众发布」）

| 契约 operation | 方法与路由 | 闸所在行 | 用途要求 |
| --- | --- | --- | --- |
| `createPost` | `POST /api/v1/posts` | `services/api/src/routes/community.ts:213` | `{ purpose: 'public_posting' }` |
| `editPost` | `PATCH /api/v1/posts/{id}` | `services/api/src/routes/community.ts:234` | 同上 |
| `createComment` | `POST /api/v1/posts/{id}/comments` | `services/api/src/routes/community.ts:266` | 同上 |
| `editComment` | `PATCH /api/v1/comments/{id}` | `services/api/src/routes/community.ts:287` | 同上 |

装配形态：`preHandler: postingPreHandlers(guards, deps)`（`services/api/src/routes/community.ts:401-407`）

- `deps.consent === undefined` ⇒ 返回**原样的** `guards.requireUser`（与接线前逐字同形，本地 stub／既有集成脚本不受影响）；
- 有端口 ⇒ 返回 `[guards.requireUser, deps.consent({ purpose: 'public_posting' })]`，**鉴权先于授权**：游客仍是 401 `SESSION_REQUIRED`，不是 403。

清单本身也是被断言的对象：`PUBLIC_POSTING_GATED_ROUTES`（`services/api/src/routes/community.ts:386`）被
`tests/unit/community-posting-consent.test.mjs` 的「闸清单」用例逐字锁定 —— 将来谁多挂一条或少挂一条都会红。

### 1.1 为什么**不**传 `dataType`

`packages/privacy/constants.mjs` 的 `MEDIA_PURPOSE_REQUIRED_CONSENTS` 把 `community_image` 绑成
`['media_processing', 'public_posting', 'external_inference']`。若社区文字帖也带 `dataType`，就会把媒体那套
附加码搬到纯文字投稿上，凭空多出两次授权拒绝。社区图片的 `public_posting` 已由
`POST /media/uploads`（`services/api/src/routes/media.ts:175-186`）按请求体资料类型问过 —— 两条入口各问各的，不叠加。

## 2 既有社区用例是怎么被保住的

### 2.1 先看「不备夹具就挂闸」会怎样（改动前读数，实测）

临时撤掉夹具里的授权补置后重跑（撤置只为取证，随后原样恢复）：

```
$ node --test tests/unit/community-http.test.mjs
ℹ tests 12
ℹ pass 0
ℹ fail 12
  AssertionError [ERR_ASSERTION]: {"error":{"code":"CONSENT_REQUIRED","message":"缺少用途授权：public_posting",
    "retryable":false,"details":[]},"meta":{...,"execution_mode":"stub"}}
  403 !== 201

$ node --test tests/unit/community-moderation-events-fail-closed.test.mjs
ℹ tests 6
ℹ pass 4
ℹ fail 2
  ✖ G6a. 【反例】real 未接真实供应商：整域 503 PROVIDER_UNAVAILABLE ...（实得 403 CONSENT_REQUIRED）
  ✖ G6c. 【对照】stub 下同一条投稿正常通过与留档 ...（实得 403 CONSENT_REQUIRED）
```

即 `gy-i14` §2.10 预判的「整片先 403」**被实测确认**（12 + 2 条）。

### 2.2 夹具怎么备（补授权，不改断言）

新增 `tests/unit/community-posting-consent-fixtures.mjs`（非测试文件，不参与 `node --test` 发现）：

- `createPublicPostingConsent()` 组装**一份新的**内存授权账本：`createConsentStore()` + `createPrivacyGuard({account, consentStore})` + `createGuardConsentGate(...)`（与 `tests/unit/media-consent-wiring.test.mjs:135-138` 同一套真实实现）；
- `grant(userId)` / `withdraw(userId)` 直接调 `consentStore.grant(...)` / `consentStore.withdraw(...)`，**不是桩**；
- 每个用例一份全新账本（授权是账号维度的 `privacy_epochs` 行，跨用例复用会让「撤回后再拒」变成假通过）。

三处接入点（都只是「先补授权」，**没有**把任何断言改成「403 也算过」）：

| 文件 | 改了什么 | 行 |
| --- | --- | --- |
| `tests/unit/community-http.test.mjs` | `fixture()` 注入 `privacyInjection: { consent }`；`user()` 里 `await publicPosting.grant(created.id)`；harness 暴露 `publicPosting` | `:61-66`、`:104`、`:152` |
| `tests/unit/community-moderation-fixtures.mjs` | `makeHarness()` 注入同一端口；`session()` 里补授权；harness 暴露 `publicPosting` | `:228-233`、`:254`、`:277` |
| `tests/integration/community-pg.mjs` | stub 与 real 两个 `buildApp` 都注入授权闸，并对测试账号 `grant` | `:30-33`、`:486-497`、`:569` |

`community-pg.mjs` 的注入理由写在文件头：该脚本验证的是**社区内容真落库**（不是 PG 授权读取口，后者已有 `consent-pg` 的既有脚本覆盖）；不注入就会让真库用例在授权闸上先 403，与它要证明的性质无关。

### 2.3 改动后读数

```
$ node --test "tests/unit/*community*.test.mjs"
ℹ tests 189
ℹ pass 189
ℹ fail 0        # 183 条既有 + 6 条新增
```

## 3 三条负控制读数（`tests/unit/community-posting-consent.test.mjs`，6/6 通过）

### 3.1 ① 无授权 ⇒ 403 `CONSENT_REQUIRED`，且零写入

同一份装配里，从未授权的账号投稿：

- 状态 403，码 `CONSENT_REQUIRED`，`message` = `缺少用途授权：public_posting`，`retryable=false`，`details=[]`；
- 响应**无** `data` 成功封套，`Cache-Control: no-store`；
- `community.listPosts()` = 0（无帖子行）、`community.countModeration()` = 0（无审核行）；
- **可判据的零写入证明**：补授权后用**同一个** `Idempotency-Key` 提交**不同**请求体 ⇒ 201（若被拒那一次落过幂等账本，这里会是 409 `IDEMPOTENCY_CONFLICT`）；
- 评论同理：他人已发布帖子下，未授权账号评论 ⇒ 403，且 `listComments(postId)` = 0。

### 3.2 ② 有授权 ⇒ 201/200

`consentStore.grant()` 之后同一条链路：

| 请求 | 读数 |
| --- | --- |
| `POST /posts` | 201，`visibility=published`、`audit_state=approved` |
| `PATCH /posts/{id}`（`If-Match: "1"`） | 200，`revision=2` |
| `POST /posts/{id}/comments`（`If-Match: "2"`＝父帖当前 revision） | 201 |
| `PATCH /comments/{id}`（`If-Match: "1"`） | 200 |

### 3.3 ③ 撤回授权 ⇒ 再 403

`consentStore.withdraw()` 之后（撤回前这 4 条都是 201/200）：

| 请求 | 撤回前 | 撤回后 |
| --- | --- | --- |
| `POST /posts` | 201 | **403 `CONSENT_REQUIRED`** |
| `PATCH /posts/{id}` | 200 | **403 `CONSENT_REQUIRED`** |
| `POST /posts/{id}/comments` | 201 | **403 `CONSENT_REQUIRED`** |
| `PATCH /comments/{id}` | 200 | **403 `CONSENT_REQUIRED`** |
| `community.listPosts()` | 1 | 1（撤回**不**删已发布内容） |

## 4 故意没挂的入口（12 条）与理由

| 路由 | 为什么**不**挂 |
| --- | --- |
| `GET /posts`、`GET /posts/{id}`、`GET /posts/{id}/comments`、`GET /comments/{id}` | 读不是发布；挂上去等于「没同意就不能看社区」，与用途语义无关 |
| `PUT/DELETE /posts/{id}/like`、`PUT/DELETE /comments/{id}/like` | 点赞不产生可公开检索的新内容（`Ack`，不改内容 revision） |
| `POST /reports`、`GET /reports/{id}` | 举报是治理动作，举报人本就只在私有视图里出现；要求「公开投稿授权」反而会压住举报 |
| `DELETE /posts/{id}`、`DELETE /comments/{id}` | 撤下自己的内容不需要「同意公开发布」；撤回授权后仍必须能删（否则撤回=内容锁死） |

**读数**：同一批无授权账号（一个从未 grant，一个先 grant 后 withdraw）打这 12 条入口：

```
GET /posts → 200        GET /posts/{id} → 200                GET /posts/{id}/comments → 200
GET /comments/{id} → 200  PUT /posts/{id}/like → 200          DELETE /posts/{id}/like → 200
PUT /comments/{id}/like → 200  DELETE /comments/{id}/like → 200
POST /reports → 201     GET /reports/{id} → 200
DELETE /comments/{id} → 200（本人内容）   DELETE /posts/{id} → 200（本人内容）
```

逐条断言里额外加了一道反向兜底：这 12 条的响应**不得**出现 `CONSENT_REQUIRED`（防止将来有人给读路径也挂上）。

## 5 接口/装配纪律遵守情况

- `registerCommunityRoutes` 新增第 5 个参数 `deps: { consent?: CommunityConsentPort } = {}`（`services/api/src/routes/community.ts:189`，**同一行内**改动，不改行号）。
- `services/api/src/app.ts:1792` 只把**已存在的** `consentGate`（`app.ts:853-857`）传给社区域；`app.ts` 里既有的闸装配顺序**未动**。
- 社区 16 条路由的 `preHandler` 行号**保持不变**：`:203,213,225,234,243,253,266,278,287,296,307,316,325,334,343,355`（`git diff --numstat` = `5 5`，逐行原位替换）。原因写在文件末尾的注释里 —— `docs` 侧台账把这份文件的行号当锚点，而它是本片不可改的红线文件，所以新增的类型/清单/组装函数**一律追加在文件末尾**（函数声明会提升）。
- 不新增错误码：拒绝复用既有 403 `CONSENT_REQUIRED`。
- 台账锚点回归：`node --test tests/unit/contract-status-anchors.test.mjs` ⇒ 11/11 通过。

## 6 未取得项（如实登记）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| PG 真库授权读取链（`consent-pg.requireConsent` 走真实库）在看到社区投稿 403 | **未取得** | 本机无 `COMMUNITY_PG_TEST_URL`，`node tests/integration/community-pg.mjs` ⇒ `EXIT=77`（未取得，不是通过）；且脚本按 §2.2 注入内存授权账本，本身不验证 PG 授权行 |
| 客户端「同意/撤回公开发布」入口 | **未取得（仍缺）** | 全仓仍无 `me/consents` 调用，契约也没有「读用途政策」面 —— 这是 `gy-i04` §2.4(d)、§6.2 第 3 项的既有缺口，本片不补 |
| 撤回授权后的在途外发撤销 | **未在本片验证** | 社区投稿是同步写入，不产生外发任务；`EgressRevoker` 的覆盖由 `gy-i22` 既有用例持有 |
| 真实供应商审核下的投稿放行 | **未取得** | `real` 模式社区写路径仍被未接线的审核域 fail-closed（503），本片零真实调用 |
| 编辑评论是否也该算「投稿」 | **本片取「算」** | `gy-i14` §2.10 只枚举了 3 条写入口（未细分评论编辑）；本片按「编辑=向公众发布修订内容」把 `PATCH /comments/{id}` 一并纳入，与 `PATCH /posts/{id}` 对称。若监工裁定不算，删掉那一条即可（清单与用例都在同一处） |

## 7 自检命令与读数（本 worktree，基点 `f5cca8b`）

```
$ npm run lint
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。

$ node --test "tests/unit/*community*.test.mjs"
ℹ tests 189   ℹ pass 189   ℹ fail 0

$ node tests/integration/community-pg.mjs
SKIP real PG17: COMMUNITY_PG_TEST_URL 未设置 —— 本次运行没有验证真库持久化（不是通过，也不是失败）。
EXIT=77

$ npm run test:unit          # 独占跑
ℹ tests 3381   ℹ pass 3380   ℹ fail 0   ℹ skipped 1

$ npm run test:mini
ℹ tests 6      ℹ pass 6      ℹ fail 0
```

> 说明：全量首轮曾有 8 条失败（`contract-status-anchors` 3 条 + `gy-i22-session-inflight-cross-module`、
> `history-http`、`knowledge-order-created-at`、`knowledge-public-invalidation`、`local-profile-bootstrap`）。
> 前 3 条是本片把实现写进路由文件中部造成 `community.ts` 行号位移、撞到期台账锚点，已按 §5 的
> 「追加在文件末尾」方案修掉；其余 5 条是并行负载抖动的既有 flake（单文件独跑 9/17/6/4/3 全过），
> 二轮全量已全绿。

## 8 红线遵守

- 未改 `packages/contracts/**`、`openapi.json`、`contract-status.json`、`.github/workflows/**`、`deploy/**`、迁移号；
- 未新增 ErrorCode（复用 `CONSENT_REQUIRED`）；
- 未改 `app.ts` 既有闸装配顺序（只加一处 community 注入）；
- 未 push、未开 PR、未读 `E:\GengYunPrivate\`；未在别的 worktree 上操作。
