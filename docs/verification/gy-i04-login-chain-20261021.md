# GY-I04 · 用户登录链路现状盘点与 401/403 归因接线

> 切片：GY-I04 登录链路盘点（D1）；分支 `feat/gy-r28-d1-login-chain`；基线 `origin/main = 7d1a429`，
> 已**合流** `origin/main = 93f336b`（合并提交见 §3.8）。
> 交付物：`miniprogram/utils/auth.js`（401/403 归因单一事实源 + `GET /auth/session` 非 401/403 不清会话）；
> 9 个适配层改为委托该归因；`tests/unit/miniprogram-auth-failure-attribution.test.mjs`；本页。
> 问题一句话：登录四段里 (a)(b) 已通、(c) 会话落地有一处「服务端 5xx 也当会话作废」、(d) 同意段客户端无授权入口；
> 更实的缺口是**传输层仍把 401 与 403 折叠成「登录失效」并顺手清掉仍然有效的会话**——B7 统一状态层
> 早已把 403 归入 `denied`，但它永远收不到 403 码。

**取证范围声明**：本页读数全部来自**本机** `E:\GengYunCommander\wt-d1-login`（Windows、Node v24.16.0、无 `node_modules` → 一次性
`npm install` 装 103 个包）。**没有**在微信开发者工具、真机、正式 AppID 或真实服务端上运行；`wx.*` 全部是合成替身。
真实微信登录能力（正式 AppID 实测）仍属 GY-I25／#27 的未取得项，本期不补偿、不冒充。
合流说明：本片先以 `7d1a429` 为基点提交，后按裁决 `git merge origin/main`（`93f336b`，+6 提交，含 #390／#392／#393／#394），
冲突与取舍见 §3.8；口径按 §1.3 的统一裁决执行。

## 0. 结论摘要

| 段 | 改前 | 改后 | 依据 |
|---|---|---|---|
| (a) `wx.login` 取 code | **通** | 通（未改） | `miniprogram/utils/auth.js:317-324` |
| (b) 小程序 → `POST /auth/wechat`（契约 operationId **`loginWechat`**，不是 `postAuthWechat`） | **通** | 通（未改） | `auth.js:325-329`；`services/api/src/routes/auth.ts:42-83` |
| (c) 会话落地（token 存储 / 过期 / 401 vs 403 vs 5xx） | **半通**：令牌存储与过期正确；但 7 个适配层把 403 折叠成登录失效并**误清会话**；`GET /auth/session` 收到 503 也清会话 | **通**（本页范围内） | 改前 `favorites-api.js:93`、`history-api.js:164`、`knowledge-api.js:73`、`voice-api.js:199`、`profile-api.js:22-24`、`messages-api.js:123-127`、`community-api.js:163-167`；`auth.js` 改前 183-185 → 改后 **261-279** |
| (d) 同意（consent）/ 隐私闸与登录的先后 | **半通**：服务端用途闸真实存在且挂在 5 个受理面；客户端**零授权入口**（全仓无 `me/consents` 调用），契约也无「读用途政策」面；社区投稿的 `public_posting` 闸未挂 | 未变（需裁决，见 §6） | `services/api/src/app.ts:939`、`:1640`、`:1641`、`:1642`、`:1660`、`:1711`；`routes/community.ts` 16 处 `preHandler` 只有 `guards.requireUser`；`app.ts:1735` |

### 0.1 归因修复前后（本期唯一的行为变更）

| 场景 | 改前 | 改后 |
|---|---|---|
| 401 `SESSION_REQUIRED` / `SESSION_EXPIRED` | 码 `SESSION_REQUIRED` + 清会话 | 码**统一归一到** `SESSION_REQUIRED` + 清会话（契约 401 只承载这两个码，二者对用户动作与 B7 状态层等价；保留 `SESSION_EXPIRED` 只会让各模块 `messageFor` 出现没有文案的码） |
| 403 `CONSENT_REQUIRED`（缺用途授权） | 码 `SESSION_REQUIRED` + **清会话** | 码 `CONSENT_REQUIRED` + **不清会话** |
| 403 `SCOPE_DENIED`（权限范围不足） | 码 `SESSION_REQUIRED` + **清会话** | 码 `SCOPE_DENIED` + **不清会话** |
| 403 `ACCOUNT_INACTIVE`（账号停用/注销、`auth_epoch` 前进） | 码 `SESSION_REQUIRED` + 清会话 | 码 `ACCOUNT_INACTIVE` + 清会话（令牌确已永久失效，但码不谎称「登录过期」） |
| 403 但响应无错误封套 | 码 `SESSION_REQUIRED` + 清会话 | 码 `SCOPE_DENIED` + 不清会话（服务端确实拒绝了，但没说原因——不假装是登录问题） |
| 403 但封套码不在契约 403 闭集内 | 码 `SESSION_REQUIRED` + 清会话 | 码 `SCOPE_DENIED` + 不清会话（状态码已说清「这是拒绝」） |
| `GET /auth/session` 返回 503 `PROVIDER_UNAVAILABLE` | **清会话**（一次瞬时故障毁掉有效登录） | 保留会话、门禁仍关闭（`serverVerified=false`） |
| `GET /auth/session` 返回 200 但契约形状/受众/时效不符 | 清会话 | 清会话（不变：服务端自相矛盾，不能当作已核实） |

## 1. 范围

### 1.1 做了什么

1. **401/403 归因收敛为单一事实源**：`miniprogram/utils/auth.js` 新增 `SESSION_LOSS_CODES` / `FORBIDDEN_CODES`（**均由 `utils/states.js` 的 `CODE_KIND` 反推**，不另立码表）、`RETIRED_SESSION_CODES`、`errorCodeOf()`、`isSessionLossCode()`、`isForbiddenCode()`、`attribution()`（纯函数）、`failureFor()`（按归因清会话并构造错误对象，见 §1.3 口径决定）。
2. **9 个适配层改为委托该归因**：`favorites-api.js`、`history-api.js`、`knowledge-api.js`、`voice-api.js`、`profile-api.js`、`messages-api.js`、`community-api.js`、`identify-api.js`、`speech-transcript.js`。其中 `identify-api` / `speech-transcript` 原先各持一份 `forbiddenOrSessionLoss`（对 `ACCOUNT_INACTIVE` 处理**相反**），合流进来的 #393 又在 `favorites-api` / `history-api` 写了**第三份**——三份自持码表全部删除，改为委托。
3. **补齐 403 码的可见文案**（改前这些文案永远走不到，因为被折叠提前 return）：`favorites-api.js`、`history-api.js`（合流后沿用 #393 的更完整措辞「无权读写用户收藏」「缺少必要的授权同意」「账号当前不可用（已停用或已注销）」）、`messages-api.js:231-232`、`community-api.js:340-341`、`knowledge-api.js:214`、`pages/profile/profile.js:35-37`。
4. **`GET /auth/session` 区分「会话被判定失效」与「这次核实没做成」**：仅 401/403（以及 200-但-契约不符）清会话；408/429/5xx/未知状态只保持「未核实」。
5. **知识页 403 不再把门禁踢回登录**：`knowledge-api.js` 只在 `attribution().clearsSession` 为真时才丢弃翻页游标，会话本身由 `auth` 决定。
6. **如实措辞（裁决 6/7）**：`identify-api.js` 的 `RETRY_ACTION_LABELS.grant_consent` 由「去授权」改为「重试」（按钮实际只重试本次操作），`CONSENT_REQUIRED` 文案不再写「请先在『我的』中完成授权」；`pages/profile/profile.wxml` 隐私说明删掉「且可以随时撤回」，改为如实写明「授权入口尚未接入、不会默认替您授权」。
7. 新增 `tests/unit/miniprogram-auth-failure-attribution.test.mjs`（13 例）：归因表 10 行 × 4 个字段、与 `states.CODE_KIND` 的双闭集同源断言、9 个真实适配层的 403/401 四态、`GET /auth/session` 的 503/401/403 三态。
8. 更新**把旧折叠口径写进断言**的既有用例（逐条理由见 §3.4）：`tests/unit/miniprogram-community-api.test.mjs`（403 期望）、`tests/reference/knowledge-client.test.mjs:210-219`（403 清会话期望）、`tests/unit/miniprogram-favorites-history.test.mjs`（#393 的「403 无封套 ⇒ 会话失效」「ACCOUNT_INACTIVE 不清会话」两条按 §1.3 口径改写）、三处 vm 载入器的 `auth` 替身补 `attribution`/`failureFor`（委托**真实**实现，不在测试里另写码表）。

### 1.2 没做什么（边界）

- **没有改任何服务端代码**：`services/api/**` 一行未动（本期所有缺陷都在客户端可闭环）。
- **没有改冻结契约**：`packages/contracts/**`（含 `openapi.json`）、`.github/workflows/**`、`services/api/src/db/migrations/**`、`deploy/**` 均未触碰（`git status` 无命中，见 §3.7）。
- **没有动 `miniprogram/utils/session.js`**（GY-I26 遗留占位层，`isGuest()` 恒 true）：按裁决 4 本片不动，登记为待办（§6.2）。
- **没有给客户端加授权入口/授权页**：POST `/me/consents` 需要 `policy_version` + `recipient_ids`，而契约**没有**任何「读用途政策／候选接收方」的 operation（只有 `listConsents` / `grantConsent` / `withdrawConsent`），客户端无法合法组出请求体。要闭环必须加契约面 → §6.2。
- **没有把 `public_posting` 用途闸挂到社区投稿**：按裁决 5 本片不挂（挂了会让 GY-I15 全部社区 HTTP 用例先 403，需先备授权夹具），登记为独立片（§6.2）。
- **没有改识别页的跳转流程**：「重试」按钮仍然走既有 `onRetry()`；把 denied 动作改成跳「我的」页属行为变更，留作 §6.2 的可选后续。
- 没有 mock 任何真实调用：新增用例全部驱动**仓库里的真代码**（真实 `auth.js` + 真实适配层 + 合成 `wx` 替身），没有为让页面看起来通而替换业务逻辑。
- 没有 push、没有建 PR（指挥统一收口）。

### 1.3 口径决定（监工 2026-10-21 裁决，本片据此执行）

| # | 争议点 | 决定 | 理由 |
|---|---|---|---|
| 1 | 归因实现放在哪 | 以 `miniprogram/utils/auth.js` 的 `attribution` / `failureFor` 为**唯一**实现，各适配层**委托**它；删掉 `favorites-api` / `history-api`（#393）、`identify-api`、`speech-transcript`、`voice-api`（#395）里各自那份同形实现——合计**四份** | 收敛重复实现，不是放宽判据：`SESSION_LOSS_CODES` 与 `FORBIDDEN_CODES` 都由 B7 的 `states.CODE_KIND` 反推，改动只会来自契约码表本身 |
| 2 | 403 且**无错误封套**（网关/代理） | 归 `SCOPE_DENIED`，**不清会话** | 为一个网关 403 销毁仍然有效的令牌，正是本轮盘点要修的害处；状态码本身已说清「这是拒绝」，不该说成登录问题 |
| 2b | 403 且封套码**不在契约 403 闭集内** | 同上（归 `SCOPE_DENIED`，不清会话） | 同一理由；且不把未知码透给用户 |
| 2c | 403 里出现**会话类码**（越界实现） | 仍按会话失效处理并清会话 | 守卫不放宽 |
| 2d | 401 的封套码是 `SESSION_EXPIRED` | **归一到** `SESSION_REQUIRED`（清会话） | 契约 401 只承载 `SESSION_REQUIRED` / `SESSION_EXPIRED`，两者对用户动作与 B7（都是 `session` → `guest`）完全等价；保留原码会让各模块 `messageFor` 出现**没有文案**的码（`voice-api` 等表里只有 `SESSION_REQUIRED`/`SESSION_CHANGED`），改造前 `identify-api`/`speech-transcript` 也是折叠的 |
| 3 | 403 `ACCOUNT_INACTIVE` | 码**如实保留**（B7 = `denied`）+ **清会话** | 令牌已永久不可用（账号停用/注销、`auth_epoch` 前进），留死令牌只会让用户每次都被 403；清掉后下次进页面走重新登录，服务端会以同一码如实拒绝登录 |
| 4 | `miniprogram/utils/session.js` 占位层 | 本片**不动**，登记待办 | 要改两条既有守卫断言，收益低 |
| 5 | 社区 `public_posting` 用途闸 | 本片**不挂**，登记为独立片 | 挂了会让 GY-I15 全部社区 HTTP 用例先 403，需先备授权夹具 |
| 6 | 识别页「去授权」 | **只改文案**：按钮 →「重试」；`CONSENT_REQUIRED` 说明改成「授权入口尚未接入、未授权不外发」 | 不承诺不存在的能力；不改页面跳转流程 |
| 7 | `profile.wxml` 隐私说明 | **改文案**：删「且可以随时撤回」，改为「未授权时不会上传或外发」「授权与撤回入口尚未接入，本页暂不提供开关」 | 承诺必须与实现一致 |
| 8 | `gy-i28-unified-states-20261021.md:238` 结论 | 在该页加**边界注记**（403 不折叠当时只在呈现层成立，传输层缺口由本页补齐） | 历史读数不改写，补边界 |

## 2. 四段盘点（逐段，带行号）

### 2.1 (a) `wx.login` 取 code —— 通

- `miniprogram/utils/auth.js:317` `wx.login({ success: function (loginResult) {...} })`；`:320` 取 `loginResult.code`；`:321-324` 非字符串或空串 ⇒ `finishError('微信未返回登录 code，请重试。')`，**不伪造 code、不写假令牌**。
- `wx.login` 的 `fail` 分支同样如实报错（`auth.js` 的 `fail:` 回调，`finishError('wx.login 调用失败，请重试。')`）。
- 守卫：`tests/unit/miniprogram-guest-gate.test.mjs` 断言 `auth.js` 源码必须含 `wx.login(`、`/auth/wechat`、`Idempotency-Key`，且**不得**出现 `openid:` / `role:` / `user_id:` / `app_secret`（本期改动后 6/6 仍通过）。
- 未取得：正式 AppID 的真机 `wx.login` 记录（属 GY-I25／#27）。

### 2.2 (b) 小程序 → `POST /auth/wechat` —— 通（operationId 为 `loginWechat`）

- 客户端：`miniprogram/utils/auth.js:325-329` —— `POST {apiBaseUrl}/auth/wechat`，`header` 带 `content-type` 与 `Idempotency-Key: newIdempotencyKey()`，`data: { code: code }`，**只发 code**。
- 契约：`packages/contracts/openapi.json` 的 `POST /auth/wechat` → **`operationId: loginWechat`**（同族：`getUserSession` / `logoutUser` / `listConsents` / `grantConsent` / `withdrawConsent` / `getProfile` / `putProfile`）。任务书里写的 `POST /auth/wechat` 是路径，不是 operationId。
- 服务端：`services/api/src/routes/auth.ts:24-31` 请求体 schema `additionalProperties:false` + `required:['code']`；`:42-83` 经 `runIdempotent`（subject 固定 `anonymous`，台账只存 `{sessionId, audience}`，不存令牌明文）。
- 客户端对响应的校验：`:339-348` 必须 `statusCode===200` 且 `data.access_token` 为字符串；`:344-348` 还要求 `meta.execution_mode` ∈ `['real','stub','preset_demo']`，否则「登录响应缺少可解释的执行模式，已拒绝」——**不接受无法解释的会话**。

### 2.3 (c) 会话落地 —— 半通 → 通（本页范围内）

已正确、本期未改的部分：
- 令牌只存服务端签发的**不透明**令牌：`auth.js:17` 的 `SESSION_KEY='gengyun.session'`、`setSession()`（写 `accessToken/audience/expiresAt/executionMode`，`:170-187`）、`getSession()` 本地预检（形状 + `audience==='user'` + `expiresAt` 未来 + 演示标记已知，`:146-168`）。
- 「读缓存 ≠ 认证」：`isLoggedIn()`（`:190-192`）必须 `serverVerified && getSession()!==null`；进程启动恒 false。
- 世代绑定：`generation` / `intentEpoch` / `navigation.isCurrent()`（`:29-35`、`:212-221`、`:234-239`）保证迟到的登录/核实/退出响应不复活旧会话、不覆盖更新的意图。
- 退出：`logout()` 仅当 `200 && data.accepted===true` 才报「服务端已撤销」，否则保留 `serverRevocationUnconfirmed`（`:391-436`）。

本期修掉的两处：
1. **403 被折叠成登录失效且误清会话**（改前原文，7 处同形）：
   ```js
   if (r.statusCode === 401 || r.statusCode === 403) { auth.clearSession(); reject(failure('SESSION_REQUIRED')); return }
   ```
   证据：`favorites-api.js:93`、`history-api.js:164`、`knowledge-api.js:73`、`voice-api.js:199`、`profile-api.js:22-24`、`messages-api.js:123-127`、`community-api.js:163-167`。反过来看，`favorites-api.js:182` / `history-api.js:426` 早就写好了 `SCOPE_DENIED` 的文案——**那两行在改前永远走不到**，这正是「文案按正确语义写、传输层提前折叠」的直接证据。
2. **`GET /auth/session` 的非 200 一律当会话作废**（改前 `auth.js:183-185`）：
   ```js
   // 服务端明确拒绝或返回异常：本地会话作废。
   clearSession()
   done(false)
   ```
   后果：`/auth/session` 若返回 503 `PROVIDER_UNAVAILABLE`（能力未装配）或 429，仍**有效**的令牌被销毁，用户被踢回登录页。改后按 `401/403` / `200-但-契约不符` / `其它状态` 三分（`auth.js:261-279`）。

401 vs 403 的契约语义（本期据此归因）：`services/api/src/contract.ts:14-18` 的 `ERROR_STATUS_MAP` —— **401 = `SESSION_REQUIRED`/`SESSION_EXPIRED`**；**403 = `SCOPE_DENIED`/`CONSENT_REQUIRED`/`ACCOUNT_INACTIVE`**；服务端实现见 `services/api/src/auth/middleware.ts:75-107`（无 Bearer → 401 `SESSION_REQUIRED`；会话缺失/撤销/过期 → 401 `SESSION_EXPIRED`；账号非 active 或 `auth_epoch` 不一致 → 403 `ACCOUNT_INACTIVE`；用户会话访后台 → 403 `SCOPE_DENIED`，`middleware.ts:110-120`）。

遗留（非本期）：`miniprogram/utils/session.js` 这套占位会话层（`SESSION_ENABLED=false`、`isGuest()` 恒 true，`session.js:22,38-42`）与真实的 `auth.js` 并存；它已无生产消费者（20 个消费点全走 `utils/auth.js`），见 §6.2 第 1 项。

### 2.4 (d) 同意（consent）与隐私闸，相对登录的先后 —— 半通

顺序本身是对的，且服务端强制：
- `POST /auth/wechat` **不要求**任何用途授权（`routes/auth.ts:42-83` 无 consent preHandler）——合理：用途授权按「用途 × 资料类型」逐项授予，必须先有身份才能授予。
- 用途闸挂在**外发/媒体受理面**，且都在 `guards.requireUser` **之后**（先用会话建立 `req.userId`/`req.authEpoch`，再查授权）：`services/api/src/app.ts:850-854` 装配 `consentGate`；`:1640` recognitions、`:1641` speech、`:1642` synthesis、`:1660` ocr、`:1711` media。
- 用途闭集：`recording` / `media_processing` / `external_inference` / `public_posting`（`services/api/src/privacy/consent-pg.ts` 的 `CONSENT_PURPOSES`）。
- 拒绝语义：缺授权 403 `CONSENT_REQUIRED`、错用途 403 `SCOPE_DENIED`（`services/api/src/privacy/egress.ts:80-105`）。

未通的四点（1/2/3/4 的处置见 §1.3 裁决与 §6.2）：
1. **客户端没有授权入口**：全仓 `miniprogram/**` 对 `me/consents` **零调用**（`grep` 无命中）。识别页在 403 时给出 `retryAction: 'grant_consent'`，改前按钮文案是「去授权」，但 `pages/identify/identify.wxml` 的 `bind:action="onRetry"` 最终只做状态复位并**重跑同一个必然 403 的请求**（`pages/identify/identify.js:881`）——一个指向空处的按钮。本片按裁决 6 只改文案：按钮 →「重试」，说明句改为「应用内授权入口尚未接入，暂时只能由服务端预置授权」。
2. **契约缺「读用途政策」面**：`POST /me/consents` 的请求体要求 `purpose` + `policy_version` + `recipient_ids`（`routes/consents.ts:28-32`），而 `openapi.json` 只有 `listConsents` / `grantConsent` / `withdrawConsent`，没有任何「当前生效政策版本 / 已核验接收方」的读取面 ⇒ 客户端**无法**合法组出请求体。
3. **社区投稿的 `public_posting` 闸未挂**：`services/api/src/privacy/egress.ts:11-19` 的挂载表明确要求「社区投稿入口」挂 `createConsentPreHandler`，但 `routes/community.ts` 的 16 处 `preHandler`（`:203,213,225,234,243,253,266,278,287,296,307,316,325,334,343,355`）**全部只有 `guards.requireUser`**，`app.ts:1735` 也未注入 `consentGate`。
4. **隐私说明曾说了做不到的事**：`pages/profile/profile.wxml` 原写「拍摄照片、录音和位置信息都需要您单独授权，且可以随时撤回」，但授权与撤回都没有入口 → 本片按裁决 7 改为如实措辞（删「随时撤回」，明写「入口尚未接入、不会默认替您授权」）。

## 3. 验证命令与真实读数

环境：Windows；`node v24.16.0`；`E:\GengYunCommander\wt-d1-login`（worktree，`.git` 是文件）；`node_modules` 原来**不存在**，本切片一次性 `npm install --no-audit --no-fund` → `added 103 packages in 1m`。

### 3.1 `npm run lint`

```
> gengyun@0.0.0 lint
> node tools/lint-workspaces.mjs

PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
```
`exit=0`。（本期没改 `services/**`／`apps/**`，两条 tsc 与改动无关，列出以证明未回归。）

### 3.2 新用例 `node --test tests/unit/miniprogram-auth-failure-attribution.test.mjs`

```
✔ 归因表：401 恒为会话失效；403 按契约码原样带出，只有 ACCOUNT_INACTIVE 清会话 (1.9ms)
✔ 同源：会话失效闭集直接取自 B7 统一状态层（states.CODE_KIND），不另立第二份码表 (10.2ms)
✔ favorites-api：403 CONSENT_REQUIRED 原样带出且不清会话；403 ACCOUNT_INACTIVE 清会话但码不变；401 仍会话失效 (177.1ms)
✔ history-api：…（同上四态） (165.0ms)
✔ knowledge-api：… (117.0ms)
✔ voice-api：… (64.3ms)
✔ speech-transcript：… (171.8ms)
✔ profile-api：… (140.8ms)
✔ messages-api：… (113.2ms)
✔ community-api：… (298.7ms)
✔ identify-api：… (66.3ms)
✔ GET /auth/session 的 503 不作废本地会话（一次瞬时故障不该毁掉有效登录），但门禁仍关闭 (20.3ms)
✔ GET /auth/session 的 401 与 403 都作废本地会话（这两类才是「这份令牌不能再用」） (34.1ms)
ℹ tests 13   ℹ pass 13   ℹ fail 0   ℹ duration_ms 1953.97
```

### 3.3 相邻回归：auth／session／login／consent／profile／voice／speech／transcript／knowledge／favorites／history／messages／community 命名的套件（逐个单跑）

**合流后（最终读数）**：`75` 个套件、**`926 / 926` 通过、0 失败**（含合流进来的
`miniprogram-i11-voice-input` 10、`miniprogram-favorites-history` 24、`miniprogram-speech-autoplay` 12、
`messages-deletion-purge` 10、`profile-region-catalog-source` 4 等）。逐套件读数见下表（合流前的一轮 22 个套件 315/315 一并保留作对照）：

| 套件组 | 合流前 | 合流后 |
|---|---|---|
| auth / session / login（auth-guards、auth-routes、auth-store-pg、miniprogram-auth-runtime、miniprogram-login-return-to、miniprogram-ui-auth-integration、admin-session-client、gy-i22-session-inflight-cross-module、account-authority-pg 等） | 22 套件 315/0 | 全部通过 |
| consent / privacy（consent-pagination、consent-pagination-http、media-consent-wiring、privacy-consent-wiring、gy-i22-consent-withdrawal-inflight-http） | 34/0 | 全部通过 |
| profile（profile-api、profile-log-redaction、profile-pagination、miniprogram-profile、local-profile-bootstrap、profile-region-catalog-source） | 77/0 | 全部通过 |
| 小程序适配层（community/favorites/history/knowledge/messages/voice/speech/transcript 各 `*-api`、`*-http`、`*-contract`） | 见 §3.3 旧表 | 全部通过 |
| **合计** | 315/0 | **926/0** |

另有（不匹配上述命名但直接相关）：`miniprogram-guest-gate` 6/6、`miniprogram-herbicides-client` 13/13、`miniprogram-ocr-correction` 7/7、`tests/reference/knowledge-client` 51/51、`tests/ui-unified-states` 9/9、`tests/ui-adaptive` 26/26。

### 3.4 `npm run test:unit`（全量；合流前后共五次，读数逐次如实列出）

**合流前 · 第一次**（改码后、未改知识页用例）：
```
ℹ tests 3245   ℹ pass 3243   ℹ fail 1   ℹ skipped 1   ℹ duration_ms 82111.56   exit=1
✖ old 401 cannot clear a newer identity; current 403 invalidates session and page
   at tests/reference/knowledge-client.test.mjs:210  →  断言「403 之后 getSession() 必须为 null」
```
这**不是**并行抖动，而是既有用例把旧折叠口径写成了断言（403 ⇒ 清会话）。按 §0.1 的新口径更新为「403 保留会话 + 门禁不关闭 + 文案说『没有权限』」，并同步给 `knowledge-api.js` 补 403 三码文案（原先 403 会落到「资料服务暂不可用…请重试」，既错因又诱导无效重试）。

**合流前 · 第二次**：
```
ℹ tests 3245   ℹ suites 0   ℹ pass 3244   ℹ fail 0   ℹ cancelled 0   ℹ skipped 1   ℹ duration_ms 86038.02   exit=0
```

**合流前 · 第三次**（加完本证据页后复跑）：
```
ℹ tests 3244   ℹ pass 3242   ℹ fail 1   ℹ skipped 1   ℹ duration_ms 76567.06   exit=1
✖ tests\unit\local-profile-bootstrap.test.mjs (8249.85ms)
  # Fatal process out of memory: Zone   ← 子进程 V8 OOM，非断言失败
```
单跑证伪：`node --test tests/unit/local-profile-bootstrap.test.mjs` → `tests 3 / pass 3 / fail 0 / duration_ms 3624.05`。
即这次的 1 fail 是**并行负载抖动**（该套件起真实 PostgreSQL 引导，两例各约 1.3–2.2s，并行时子进程 OOM），与本片改动无关。

**合流 #394/#393 后 · 第四次**：
```
ℹ tests 3308   ℹ suites 0   ℹ pass 3307   ℹ fail 0   ℹ cancelled 0   ℹ skipped 1   ℹ duration_ms 69603.84   exit=0
```

**合流 #395 后 · 第五次（最终）**：
```
ℹ tests 3318   ℹ suites 0   ℹ pass 3317   ℹ fail 0   ℹ cancelled 0   ℹ skipped 1   ℹ duration_ms 111075.99   exit=0
```
（`skipped 1` 为既有跳过项，非本期新增。本轮**没有**再出现抖动。）
### 3.5 `npm run test:mini`（小程序侧改动必跑）

```
> node tools/check-wechat-project.mjs && node --test tests/local-debug.test.mjs
PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.
✔ missing, public, wildcard, credential, unsafe path and mismatched configs fail
✔ apiBaseUrl accepts origin or origin plus a client-append base path without widening rejections
✔ actual HTTP service is synthetic, no-store and has no business routes
✔ client blocks trial/release/unknown environments and labels stub or failure
✔ isolated packaging excludes private files and rejects release overrides/stale output
✔ local --appid overrides only the generated copy and rejects illegal ids without leftovers
ℹ tests 6   ℹ pass 6   ℹ fail 0   exit=0
```
注：`auth.js` 新增 `require('./states')` 后，两条**把 `auth.js` 复制到临时目录**载入的用例（`miniprogram-auth-runtime`、`miniprogram-login-return-to`）已同步复制 `utils/states.js`；`local-debug.test.mjs` 的「缺 navigation 依赖必须硬失败」负控制仍报 `MODULE_NOT_FOUND … navigation`（`require` 顺序为 runtime → navigation → states，错误文本不变）。

### 3.6 不在 `test:unit` glob 内、但与本期直接相关的三组

| 命令 | 读数 |
|---|---|
| `node --test tests/ui-unified-states.test.mjs`（B7 统一状态层） | `tests 9 / pass 9 / fail 0` |
| `node --test tests/ui-adaptive.test.mjs`（含 `session.js` 占位层守卫、冻结契约未改判定） | `tests 26 / pass 26 / fail 0` |
| `npm run test:docs`（新增证据页后的文档/研究记录校验） | `exit=0`；`PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables`；`研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住` |

### 3.7 改动面（相对合流后的 `origin/main`：代码与测试 24 文件 **+586 / −136**；另有本页为新增文档 407 行，合计 25 文件 +993/−136）

本页自身的 +/− 会随本页修订浮动，故下表用 **`git diff --numstat origin/main..HEAD`**（合流后与本片的净差）：

```
407   0  docs/verification/gy-i04-login-chain-20261021.md   ← 本页（新增）
  8   0  docs/verification/gy-i28-unified-states-20261021.md
 10   0  docs/verification/gy-r28-c5-favorites-history-20261021.md
  5   2  miniprogram/pages/identify/identify.wxml
  6   0  miniprogram/pages/profile/profile.js
  8   1  miniprogram/pages/profile/profile.wxml
118   3  miniprogram/utils/auth.js
  3   2  miniprogram/utils/community-api.js
  7  22  miniprogram/utils/favorites-api.js
  7  20  miniprogram/utils/history-api.js
 16  13  miniprogram/utils/identify-api.js
  6   2  miniprogram/utils/knowledge-api.js
  3   2  miniprogram/utils/messages-api.js
  1   1  miniprogram/utils/profile-api.js
  6  10  miniprogram/utils/speech-transcript.js
  9  25  miniprogram/utils/voice-api.js
  8   2  tests/reference/knowledge-client.test.mjs
267   0  tests/unit/miniprogram-auth-failure-attribution.test.mjs
  3   0  tests/unit/miniprogram-auth-runtime.test.mjs
 31   7  tests/unit/miniprogram-community-api.test.mjs
 29  20  tests/unit/miniprogram-favorites-history.test.mjs
 16   1  tests/unit/miniprogram-i11-voice-input.test.mjs
  3   1  tests/unit/miniprogram-login-return-to.test.mjs
  8   1  tests/unit/miniprogram-transcript-confirm.test.mjs
  8   1  tests/unit/miniprogram-voice-playback.test.mjs
```
> 说明：`favorites-api` / `history-api` / `voice-api` / `identify-api` 的删除行多于新增行，是**删掉各自那份重复归因实现**的结果；
> `~/…/pages/voice/voice.js` 与 `docs/verification/gy-i11-voice-input-20261021.md` 属 #394／#395，本片净差为 0，故不在上表。

`git status --porcelain` 对 `contracts/`、`.github/`、`migrations/`、`deploy/`、`openapi` **无命中**。
本期只做本地提交：**未 push、未开 PR**（本分支相对 `origin/main` ahead 3：切片提交 + 两次合并提交）。

### 3.8 合流 `origin/main`（`93f336b`）的冲突与取舍

`git fetch origin main` 后 `git merge origin/main --no-edit`，**只有两个文件冲突**（其余 main 侧改动 auto-merge）：

| 冲突文件 | 处 | 取舍 | 理由 |
|---|---|---|---|
| `miniprogram/utils/favorites-api.js` | 调用点 | 取本片 `reject(auth.failureFor(failure, r.statusCode, r.data))` | 裁决 1：归因收敛到 `auth.js`，不再保留 #393 那份 `forbiddenOrSessionLoss` |
| 同上 | 403 文案 3 行 | 取 main（#393）措辞：「无权读写用户收藏（收藏只对用户会话开放）」「缺少必要的授权同意…」「账号当前不可用（已停用或已注销）…」 | main 的措辞信息量更大且覆盖读/写两侧，语义与本片一致 |
| 同上 | 非冲突但重复 | 删除 main 带进来的 `FORBIDDEN_CODES` / `errorCodeOf` / `forbiddenOrSessionLoss`（**第三份**同形实现） | 裁决 1（收敛重复实现） |
| `miniprogram/utils/history-api.js` | 调用点 + 文案 2 行 | 同上（调用点取本片；文案取 main 的「读取或删除识别历史」措辞） | 同上 |
| 同上 | 非冲突但重复 | 删除 main 带进来的同名三件套 | 同上 |

自动合并、逐项核对过的：
- `miniprogram/pages/voice/voice.js`（#394 C6 自动播报）新增 `require('../../utils/speech-autoplay')`；两个 vm 载入器（`miniprogram-transcript-confirm`、`miniprogram-voice-playback`）的**闭集 require 白名单**已由 main 按真实实现登记 `speech-autoplay`，本片没有把它写回桩。
- `miniprogram/utils/location-region.js`、`reference.js`、`packages/reference/**`、`services/api/src/messages/**`、`deploy/**`（#390／#392／#393 侧）均 auto-merge 到位，本片未改其内容。
- 合流后**必须按新口径改写**的既有断言（都来自 #393）：`tests/unit/miniprogram-favorites-history.test.mjs` 三条（见 §4.4）。

合流后**没有**再做 rebase / squash；本片三次本地提交（切片提交 + 两次合并提交，见 `git log --oneline -3`）。

### 3.9 第二次合流：`3935c55` / PR #395（语音输入）——同一模式再出现一次

第一次合并完成后 `origin/main` 又前进到 `3935c55`（PR #395「语音输入四段盘点与必要接线（临时文件回收 / 403 不折叠 / 上传号成对复位）」），
它给 `voice-api.js` 加了**第四份** `SESSION_LOSS_CODES` + `errorCodeOf` + `forbiddenOrSessionLoss`。再次 `git merge origin/main`：

| 冲突文件 | 取舍 | 理由 |
|---|---|---|
| `miniprogram/utils/voice-api.js` | 调用点取本片 `auth.failureFor(...)`；删除 #395 那份 `SESSION_LOSS_CODES` / `errorCodeOf` / `forbiddenOrSessionLoss`（保留其注释里「403 不得折叠」的红线说明，但指向统一实现） | 裁决 1 |
| `tests/unit/miniprogram-i11-voice-input.test.mjs`（#395 新增） | 其注入的 `auth` 替身补 `attribution` / `failureFor`，**委托真实实现**，只把「清会话」换成本文件的探针计数 | 该文件真实断言的「403 不清会话 / 401 才清会话」由真实判定驱动，不在测试里重写码表 |
| 同上，`401 SESSION_EXPIRED` 的期望 | 期望码 `SESSION_REQUIRED` 保持**不变**（本片为此把 401 归一，见 §1.3 第 2d 条） | #395 的期望与「归一」口径一致；本片反而据此修正了自己先前「原样保留 `SESSION_EXPIRED`」的选择 |

其余（`miniprogram/pages/voice/voice.js` 的临时文件回收、`docs/verification/gy-i11-voice-input-20261021.md`）auto-merge，本片未改其内容。

## 4. 改法（逐文件）

### 4.1 `miniprogram/utils/auth.js`

- 新增 `const states = require('./states')`（`states.js` 无任何 `require`，纯码表）。
- 新增归因层：
  - `RETIRED_SESSION_CODES = ['ACCOUNT_INACTIVE']`：令牌永久失效、必须清会话，但码不折叠。
  - `FORBIDDEN_CODES`：契约 403 闭集，同样由 `states.CODE_KIND`（kind === 'denied'）反推。
  - `attribution(statusCode, payload)`（纯函数）：401 → 会话类码或保守 `SESSION_REQUIRED`；403 → 会话类码/403 闭集码原样，其余（无封套、闭集外码）→ `SCOPE_DENIED`；返回 `{code,status,retryable,sessionLost,clearsSession}`（口径见 §1.3）。
  - `failureFor(makeFailure, statusCode, payload)`：仅当 `clearsSession` 才 `clearSession()`，再用调用方自己的 `failure()` 构造错误（不替各模块发明错误形状），只补 `status`/`retryable`。
- `verifySession` 的三分（见 §2.3）。
- 导出 `SESSION_LOSS_CODES` / `FORBIDDEN_CODES` / `RETIRED_SESSION_CODES` / `isSessionLossCode` / `isForbiddenCode` / `attribution` / `failureFor`。（合流会移动行号，故本小节按符号定位；精确行号见 `grep -n` 或 §7 的锚点行。）

### 4.2 9 个适配层

| 文件 | 改法 |
|---|---|
| `favorites-api.js` | 调用点 `reject(auth.failureFor(failure, r.statusCode, r.data))`；合流时删除 #393 那份 `FORBIDDEN_CODES`/`errorCodeOf`/`forbiddenOrSessionLoss`（第三份），文案沿用 #393 的措辞 |
| `history-api.js` | 同上（合流时同样删掉自持码表） |
| `knowledge-api.js` | 同上；游标只在 `attribution().clearsSession` 时丢弃 |
| `voice-api.js` | 同上；合流 #395 时删除它那份 `SESSION_LOSS_CODES`/`errorCodeOf`/`forbiddenOrSessionLoss`（第四份），保留其「403 不得折叠」红线注释并改指向统一实现 |
| `profile-api.js` | 同上 |
| `messages-api.js` | 同上 |
| `community-api.js` | 同上 |
| `identify-api.js` | 原 `forbiddenOrSessionLoss` 改为 `return auth.failureFor(failure, statusCode, payload)`；删除自持的 `SESSION_LOSS_CODES`（**与 speech 那份口径相反**） |
| `speech-transcript.js` | 同上；删除自持的 `SESSION_LOSS_CODES`（那份曾把 `ACCOUNT_INACTIVE` 折叠成登录失效） |

### 4.3 403 文案（原先走不到的码）

`favorites-api.js`、`history-api.js`（合流后沿用 #393 措辞）、`messages-api.js`、`community-api.js`、`knowledge-api.js` 的 `message`/`messageFor`，以及 `pages/profile/profile.js` 的 `readFailure`（增加 `SCOPE_DENIED`/`CONSENT_REQUIRED`/`ACCOUNT_INACTIVE` 三分支，且不再说「请重试」——403 重试不会变好）。

### 4.4 测试

- 新增 `tests/unit/miniprogram-auth-failure-attribution.test.mjs`：真实 `auth.js` + 真实 9 个适配层，合成 `wx`，只喂 401/403/503 响应。
- `tests/unit/miniprogram-community-api.test.mjs`：两处 403 期望由 `SESSION_REQUIRED`+`cleared.count===1` 改为 `SCOPE_DENIED`+`cleared.count===0`，并新增「403 无封套 ⇒ `SCOPE_DENIED` 且不清会话」一例；文件头注释与两条用例标题同步。
- `tests/reference/knowledge-client.test.mjs`（原 `:210-219`）：见 §3.4。
- `tests/unit/miniprogram-favorites-history.test.mjs`（#393 合流进来的 8 个用例）：按 §1.3 改了 3 条断言——「403 无封套/闭集外码」由「会话失效」改为「`SCOPE_DENIED` 且不清会话」；「ACCOUNT_INACTIVE 不清会话」改为「清会话但码保留」；历史页那条 `isLoggedIn()` 期望同步（页面的 `errorCode`/文案仍如实带出）。
- 四处 vm 载入器的 `auth` 替身（`miniprogram-community-api`、`miniprogram-transcript-confirm`、`miniprogram-voice-playback`、`miniprogram-i11-voice-input`）补 `attribution`/`failureFor`，**委托真实实现**（`createRequire` 载入 `miniprogram/utils/auth.js`），只有「清会话计数」用替身计数器——不在测试里重写码表。
- `miniprogram-auth-runtime.test.mjs` / `miniprogram-login-return-to.test.mjs`：临时目录复制清单各加 `utils/states.js`。
- 合流后确认：`miniprogram-transcript-confirm` / `miniprogram-voice-playback` 两个 vm 载入器的**闭集 require 白名单**已由 main 按真实实现登记 `speech-autoplay`（`transcript-confirm:211`、`voice-playback:656`），本片没有把它写回桩。

## 5. 外部前提缺口（未取得，不冒充）

| 项 | 状态 | 影响 |
|---|---|---|
| 正式 AppID 真机 `wx.login` + code 换会话 | **未取得**（属 GY-I25／#27） | (a)(b) 只有合成 `wx` 与本地临时 runtime 证据；不能声称「微信登录真机可用」 |
| 微信开发者工具编译 | **未取得**（`test:mini` 只做原生 JSON/路由/语法与打包隔离检查，自述「Not a WeChat compiler or device test」） | 本片动了 `pages/profile/profile.wxml`（隐私说明文案）与 `pages/identify/identify.wxml`（注释），**没有**工具侧编译/渲染证据 |
| 真实服务端联调（`POST /auth/wechat` 真实响应） | **未取得** | 本期只在 Node 里以合成封套驱动真实客户端代码 |
| 真实用途政策 / 接收方清单（`policy_version`、`recipient_ids`） | **契约无读取面** | 客户端无法完成授权（§6.2 第 3 项） |
| 真实对象存储 / 审核 / ASR / TTS 提供者 | **未取得**（既有证据页已列） | 403 `CONSENT_REQUIRED` 的真实触发路径无法端到端复现 |

## 6. 裁决状态

### 6.1 已裁决并由本片执行（2026-10-21 监工；口径见 §1.3）

| 原编号 | 议题 | 结论 → 本片动作 |
|---|---|---|
| 7 | 与 #393 重叠、三份 `forbiddenOrSessionLoss` | 采纳「统一归因层」：`favorites-api` / `history-api`（#393 那份）与 `identify-api` / `speech-transcript` 的自持码表**全部删除**，改委托 `auth.failureFor`；合流后 #393 的页面侧（`errorCode` → `state-view`）**保留**，只把两条与统一口径冲突的断言改写 |
| 7 续 | 同一模式第二次出现（#395，`3935c55`） | `voice-api.js` 的**第四份**同形实现同样删除、改委托；#395 新增的 `miniprogram-i11-voice-input.test.mjs` 只改注入替身（委托真实实现），其断言口径保留 |
| 7 附 | 403 无封套 / 闭集外码 | 归 `SCOPE_DENIED`、**不清会话**（原 #393 的「保守折叠成会话失效」作废）；已在 `gy-r28-c5-favorites-history-20261021.md` 加 superseded 边界 |
| 4 | `ACCOUNT_INACTIVE` | 码如实保留（B7 = `denied`）+ **清会话**；#393 那条「ACCOUNT_INACTIVE 不清会话」的断言按此改写 |
| 3 | `miniprogram/utils/session.js` 占位层 | 本片**不动**，登记为待办（见 §6.2 第 1 项） |
| 2 | 社区 `public_posting` 用途闸 | 本片**不挂**，登记为独立片（见 §6.2 第 2 项） |
| 1（部分） | 「去授权」死按钮 | **只改文案**：按钮「去授权」→「重试」；`CONSENT_REQUIRED` 说明改成「应用内授权入口尚未接入」 |
| 5 | `profile.wxml` 隐私说明 | **改文案**：删「且可以随时撤回」，明写「未授权时不会上传或外发」「入口尚未接入、不会默认替您授权」 |
| 6 | `gy-i28-unified-states-20261021.md:238` | 已在该页加**边界注记**（历史结论保留不改写） |

### 6.2 仍未决（需后续切片）

1. **`miniprogram/utils/session.js` 生死**：GY-I26 占位层（`SESSION_ENABLED=false`、`isGuest()` 恒 true）在 `auth.js` 落地后已无生产消费者，但 `tests/ui-adaptive.test.mjs:274,285` 仍以源码字面量守着它。删文件 / 改成委托 `auth.js` / 保留现状，三者都要动那条守卫。
2. **社区投稿 `public_posting` 用途闸**（`routes/community.ts` 16 处 `preHandler` 只有 `requireUser`；`app.ts:1735` 未注入 `consentGate`，而 `privacy/egress.ts:11-19` 的挂载表要求挂）。挂之前要先准备授权夹具，否则 GY-I15 全部社区 HTTP 用例会先 403。
3. **同意授权入口 + 契约读取面**（裁决 1 只解决了措辞）：服务端需增补「当前生效用途政策 + 已核验接收方」读取 operation（属契约变更），客户端才能合法组出 `POST /me/consents`。
4. **denied 动作是否改为跳「我的」页**：本片把按钮改成「重试」且不改跳转；若产品希望 denied 动作真正可用，可改为 `switchTab('/pages/profile/profile')` 并在 `ui-unified-states.test.mjs:206-209` 上按**加强**方式改写（仍禁止「能授权/能撤回」这类失实承诺）。
8. **「去授权」死按钮**的另一条低成本出口：若短期不加契约读取面，可把识别页 `permission_denied` 分支的动作从「去授权」改为「查看隐私说明」（`pages/profile/profile.wxml:162-172`），并同步把该段文案改成「授权入口尚未接入」。这会动 `ui-unified-states.test.mjs:206-209` 的断言，故列为裁决项而非本期实施。

## 7. 复核出的文档行号漂移

| 派发/文档说法 | 实际（`7d1a429`） | 说明 |
|---|---|---|
| 任务书：`AGENT.md`（仓库根，169 行） | 根目录**没有** `AGENT.md`，只有 `AGENTS.md`（**39 行**，5026 字节） | 文件名与行数都不符 |
| 任务书：`docs/verification/gy-i05-locate-timeout-20261021.md` | **在本期基点 `7d1a429` 上不存在**；它由**更新后的** `origin/main`（`93f336b`，PR #392）引入 | 不是文件写错，而是派发时基点较旧；本期未 rebase（纪律要求），故按同族体例另择参照 |
| 任务书：`docs/verification/gy-r28-c5-favorites-history-20261021.md` | **在本期基点 `7d1a429` 上不存在**；它由 `origin/main` 的 `8e8584e`（PR #393，C5 切片）引入，同一提交也改了 `favorites-api.js`/`history-api.js` | 已按裁决收敛，见 §6.1 第 7 行 |
| 任务书：`POST /auth/wechat` 的 operationId | 真实 operationId 是 **`loginWechat`**（`openapi.json`）；`/auth/wechat` 是路径 | 已按契约纠正 |
| `miniprogram/utils/session.js:5` 注释「真实会话由 GY-I04 服务端签发后替换本文件」 | 替换实际发生在 `utils/auth.js`，本文件未替换也未删除 | 死代码 + 注释过期 |
| `docs/verification/gy-i28-unified-states-20261021.md:26-28,238`「403 不再被折叠」 | 改前只在呈现层成立；传输层 7 个 `*-api.js` 仍在折叠 | 本期补齐并已在该页加边界注记（见 §6.1 第 6 行） |
| `miniprogram/utils/identify-api.js:41` 与 `speech-transcript.js:229` 注释「同口径」 | 两份码表实际**不同**（前者不含 `ACCOUNT_INACTIVE`，后者含），对同一响应给出相反结论 | 已收敛到 `auth.attribution`，两处自持码表删除 |
| `services/api/src/privacy/egress.ts:11-19` 挂载表含「社区投稿入口」 | `routes/community.ts` 16 处 preHandler 均未挂用途闸 | 见 §6.2 第 2 项 |
| `services/api/src/auth/middleware.ts:7` 注释「供 GY-I27 的 requireConsent 直接消费」 | 核对为**准确**（`app.ts:939` 起已消费） | 非漂移，记录以证明已核 |

## 8. 不证明什么

- 不证明真机／开发者工具下的登录可用；不证明正式 AppID 的 code 交换；不证明任何 403 的真实触发链路端到端可达（真实提供者未接线）。
- 不证明「同意段」已通：授权入口与契约读取面都缺（§6.2 第 3 项）。
- 不把 `stub` / `preset_demo` 的执行模式当作真实能力；本期没有新增任何替身成功路径，也没有把 403 说成成功。
- 本页所有「通」都限定为：**在同一份真代码 + 合成 `wx` 响应下，判定与文案符合契约语义**。
