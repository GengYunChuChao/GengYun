# GY-I04 · 用户登录链路现状盘点与 401/403 归因接线

> 切片：GY-I04 登录链路盘点（D1）；分支 `feat/gy-r28-d1-login-chain`；基线 `origin/main = 7d1a429`。
> 交付物：`miniprogram/utils/auth.js`（401/403 归因单一事实源 + `GET /auth/session` 非 401/403 不清会话）；
> 9 个适配层改为委托该归因；`tests/unit/miniprogram-auth-failure-attribution.test.mjs`；本页。
> 问题一句话：登录四段里 (a)(b) 已通、(c) 会话落地有一处「服务端 5xx 也当会话作废」、(d) 同意段客户端无授权入口；
> 更实的缺口是**传输层仍把 401 与 403 折叠成「登录失效」并顺手清掉仍然有效的会话**——B7 统一状态层
> 早已把 403 归入 `denied`，但它永远收不到 403 码。

**取证范围声明**：本页读数全部来自**本机** `E:\GengYunCommander\wt-d1-login`（Windows、Node v24.16.0、无 `node_modules` → 一次性
`npm install` 装 103 个包）。**没有**在微信开发者工具、真机、正式 AppID 或真实服务端上运行；`wx.*` 全部是合成替身。
真实微信登录能力（正式 AppID 实测）仍属 GY-I25／#27 的未取得项，本期不补偿、不冒充。
基点说明：本期按派发要求以 `7d1a429` 为基点，**未 rebase**；工作期间 `origin/main` 已前进到 `93f336b`（+6 提交，含与本页
重叠的 #393／C5 切片），重叠与分歧见 §6 第 7 项。

## 0. 结论摘要

| 段 | 改前 | 改后 | 依据 |
|---|---|---|---|
| (a) `wx.login` 取 code | **通** | 通（未改） | `miniprogram/utils/auth.js:317-324` |
| (b) 小程序 → `POST /auth/wechat`（契约 operationId **`loginWechat`**，不是 `postAuthWechat`） | **通** | 通（未改） | `auth.js:325-329`；`services/api/src/routes/auth.ts:42-83` |
| (c) 会话落地（token 存储 / 过期 / 401 vs 403 vs 5xx） | **半通**：令牌存储与过期正确；但 7 个适配层把 403 折叠成登录失效并**误清会话**；`GET /auth/session` 收到 503 也清会话 | **通**（本页范围内） | 改前 `favorites-api.js:93`、`history-api.js:164`、`knowledge-api.js:73`、`voice-api.js:199`、`profile-api.js:22-24`、`messages-api.js:123-127`、`community-api.js:163-167`；`auth.js` 改前 183-185 → 改后 **261-279** |
| (d) 同意（consent）/ 隐私闸与登录的先后 | **半通**：服务端用途闸真实存在且挂在 5 个受理面；客户端**零授权入口**（全仓无 `me/consents` 调用），契约也无「读用途政策」面；社区投稿的 `public_posting` 闸未挂 | 未变（需裁决，见 §6） | `services/api/src/app.ts:850`、`:1640`、`:1641`、`:1642`、`:1660`、`:1711`；`routes/community.ts` 16 处 `preHandler` 只有 `guards.requireUser`；`app.ts:1735` |

### 0.1 归因修复前后（本期唯一的行为变更）

| 场景 | 改前 | 改后 |
|---|---|---|
| 401 `SESSION_REQUIRED` / `SESSION_EXPIRED` | 码 `SESSION_REQUIRED` + 清会话 | 码**原样保留**（`SESSION_EXPIRED` 不再被改写）+ 清会话 |
| 403 `CONSENT_REQUIRED`（缺用途授权） | 码 `SESSION_REQUIRED` + **清会话** | 码 `CONSENT_REQUIRED` + **不清会话** |
| 403 `SCOPE_DENIED`（权限范围不足） | 码 `SESSION_REQUIRED` + **清会话** | 码 `SCOPE_DENIED` + **不清会话** |
| 403 `ACCOUNT_INACTIVE`（账号停用/注销、`auth_epoch` 前进） | 码 `SESSION_REQUIRED` + 清会话 | 码 `ACCOUNT_INACTIVE` + 清会话（令牌确已永久失效，但码不谎称「登录过期」） |
| 403 但响应无错误封套 | 码 `SESSION_REQUIRED` + 清会话 | 码 `SCOPE_DENIED` + 不清会话（服务端确实拒绝了，但没说原因——不假装是登录问题） |
| `GET /auth/session` 返回 503 `PROVIDER_UNAVAILABLE` | **清会话**（一次瞬时故障毁掉有效登录） | 保留会话、门禁仍关闭（`serverVerified=false`） |
| `GET /auth/session` 返回 200 但契约形状/受众/时效不符 | 清会话 | 清会话（不变：服务端自相矛盾，不能当作已核实） |

## 1. 范围

### 1.1 做了什么

1. **401/403 归因收敛为单一事实源**：`miniprogram/utils/auth.js` 新增 `SESSION_LOSS_CODES`（**由 `utils/states.js` 的 `CODE_KIND` 反推**，不另立码表）、`RETIRED_SESSION_CODES`、`errorCodeOf()`、`isSessionLossCode()`、`attribution()`（纯函数）、`failureFor()`（按归因清会话并构造错误对象）。见 `auth.js:48-118`。
2. **9 个适配层改为委托该归因**：`favorites-api.js:93`、`history-api.js:164`、`knowledge-api.js:75-76`、`voice-api.js:199`、`profile-api.js:23`、`messages-api.js:124`、`community-api.js:164`、`identify-api.js:267`、`speech-transcript.js:239`（后两处原先各有一份 `forbiddenOrSessionLoss`，且**对 `ACCOUNT_INACTIVE` 处理相反**，现两份都删除自持码表）。
3. **补齐 403 码的可见文案**（改前这些文案永远走不到，因为被折叠提前 return）：`favorites-api.js:183-184`、`history-api.js:427-428`、`messages-api.js:231-232`、`community-api.js:340-341`、`knowledge-api.js:214`、`pages/profile/profile.js:35-37`。
4. **`GET /auth/session` 区分「会话被判定失效」与「这次核实没做成」**：仅 401/403（以及 200-但-契约不符）清会话；408/429/5xx/未知状态只保持「未核实」。见 `auth.js:261-279`。
5. **知识页 403 不再把门禁踢回登录**：`knowledge-api.js:75` 只在 `attribution().clearsSession` 为真时才丢弃翻页游标，会话本身由 `auth` 决定。
6. 新增 `tests/unit/miniprogram-auth-failure-attribution.test.mjs`（13 例）：归因表 9 行 × 4 个字段、与 `states.CODE_KIND` 的同源断言、9 个真实适配层的 403/401 三态、`GET /auth/session` 的 503/401/403 三态。
7. 更新三条**把旧折叠口径写进断言**的既有用例（见 §3.4 的逐条理由）：`tests/unit/miniprogram-community-api.test.mjs`（403 期望）、`tests/reference/knowledge-client.test.mjs:210-219`（403 清会话期望）、三处 vm 载入器的 `auth` 替身补 `attribution`/`failureFor`（委托**真实**实现，不在测试里另写码表）。

### 1.2 没做什么（边界）

- **没有改任何服务端代码**：`services/api/**` 一行未动（本期所有缺陷都在客户端可闭环）。
- **没有改冻结契约**：`packages/contracts/**`（含 `openapi.json`）、`.github/workflows/**`、`services/api/src/db/migrations/**`、`deploy/**` 均未触碰（`git status` 无命中，见 §5.1）。
- **没有动 `miniprogram/utils/session.js`**（GY-I26 遗留占位层，`isGuest()` 恒 true）：它无任何生产消费者，删它要同时改 `tests/ui-adaptive.test.mjs:274,285` 两条**既有守卫断言**；属「移除历史占位 + 换守卫」的决策，列 §6 待裁决，不自行处置。
- **没有给客户端加「去授权」入口**：POST `/me/consents` 需要 `policy_version` + `recipient_ids`，而契约**没有**任何「读用途政策／候选接收方」的 operation（只有 `listConsents` / `grantConsent` / `withdrawConsent`），客户端无法合法组出请求体。要闭环必须加契约面 → §6。
- **没有把 `public_posting` 用途闸挂到社区投稿**：需要改 `registerCommunityRoutes` 签名 + `app.ts:1735` 装配，且会让 GY-I15 全部社区 HTTP 用例先 403（blast radius 跨域），超出本切片 → §6。
- **没有修正 `pages/profile/profile.wxml:162-172` 的隐私说明文案**（静态宣称「拍摄照片、录音和位置信息都需要您单独授权，且可以随时撤回」，但入口不存在）：文案与 Demo 走查口径、隐私承诺一并裁决，避免单方面改承诺 → §6。
- 没有 mock 任何真实调用：新增用例全部驱动**仓库里的真代码**（真实 `auth.js` + 真实适配层 + 合成 `wx` 替身），没有为让页面看起来通而替换业务逻辑。
- 没有 push、没有建 PR（指挥统一收口）。

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

遗留（非本期）：`miniprogram/utils/session.js` 这套占位会话层（`SESSION_ENABLED=false`、`isGuest()` 恒 true，`session.js:22,38-42`）与真实的 `auth.js` 并存；它已无生产消费者（20 个消费点全走 `utils/auth.js`），见 §6 第 3 项。

### 2.4 (d) 同意（consent）与隐私闸，相对登录的先后 —— 半通

顺序本身是对的，且服务端强制：
- `POST /auth/wechat` **不要求**任何用途授权（`routes/auth.ts:42-83` 无 consent preHandler）——合理：用途授权按「用途 × 资料类型」逐项授予，必须先有身份才能授予。
- 用途闸挂在**外发/媒体受理面**，且都在 `guards.requireUser` **之后**（先用会话建立 `req.userId`/`req.authEpoch`，再查授权）：`services/api/src/app.ts:850-854` 装配 `consentGate`；`:1640` recognitions、`:1641` speech、`:1642` synthesis、`:1660` ocr、`:1711` media。
- 用途闭集：`recording` / `media_processing` / `external_inference` / `public_posting`（`services/api/src/privacy/consent-pg.ts` 的 `CONSENT_PURPOSES`）。
- 拒绝语义：缺授权 403 `CONSENT_REQUIRED`、错用途 403 `SCOPE_DENIED`（`services/api/src/privacy/egress.ts:80-105`）。

未通的部分（都需裁决，见 §6）：
1. **客户端没有授权入口**：全仓 `miniprogram/**` 对 `me/consents` **零调用**（`grep` 无命中）。识别页在 403 时给出 `retryAction: 'grant_consent'` → 按钮文案「去授权」（`identify-api.js:162`、`:203`），但 `pages/identify/identify.wxml:320-330` 的 `bind:action="onRetry"` 最终只做状态复位并**重跑同一个必然 403 的请求**（`pages/identify/identify.js:881`）——一个指向空处的按钮。
2. **契约缺「读用途政策」面**：`POST /me/consents` 的请求体要求 `purpose` + `policy_version` + `recipient_ids`（`routes/consents.ts:28-32`），而 `openapi.json` 只有 `listConsents` / `grantConsent` / `withdrawConsent`，没有任何「当前生效政策版本 / 已核验接收方」的读取面 ⇒ 客户端**无法**合法组出请求体。
3. **社区投稿的 `public_posting` 闸未挂**：`services/api/src/privacy/egress.ts:11-19` 的挂载表明确要求「社区投稿入口」挂 `createConsentPreHandler`，但 `routes/community.ts` 的 16 处 `preHandler`（`:203,213,225,234,243,253,266,278,287,296,307,316,325,334,343,355`）**全部只有 `guards.requireUser`**，`app.ts:1735` 也未注入 `consentGate`。
4. **隐私说明说了做不到的事**：`pages/profile/profile.wxml:162-172` 静态宣称「拍摄照片、录音和位置信息都需要您单独授权，且可以随时撤回」，但授权与撤回都没有入口。

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

### 3.3 相邻回归：`tests/unit/` 里 auth／session／login／consent／profile 命名的 22 个套件（逐个单跑）

| 套件 | pass | fail |
|---|---|---|
| account-authority-pg | 8 | 0 |
| admin-account-authority-fail-closed | 5 | 0 |
| admin-accounts-authority-shell | 5 | 0 |
| admin-session-client | 26 | 0 |
| auth-guards | 7 | 0 |
| auth-routes | 30 | 0 |
| auth-store-pg | 7 | 0 |
| consent-pagination | 7 | 0 |
| consent-pagination-http | 1 | 0 |
| gy-i22-consent-withdrawal-inflight-http | 8 | 0 |
| gy-i22-session-inflight-cross-module | 9 | 0 |
| local-profile-bootstrap | 3 | 0 |
| media-consent-wiring | 8 | 0 |
| miniprogram-auth-failure-attribution（新） | 13 | 0 |
| miniprogram-auth-runtime | 22 | 0 |
| miniprogram-login-return-to | 66 | 0 |
| miniprogram-profile | 28 | 0 |
| miniprogram-ui-auth-integration | 26 | 0 |
| privacy-consent-wiring | 10 | 0 |
| profile-api | 15 | 0 |
| profile-log-redaction | 4 | 0 |
| profile-pagination | 7 | 0 |
| **合计** | **315** | **0** |

另有（不匹配上述命名但直接相关、单独跑过）：`miniprogram-guest-gate` 6/6、`miniprogram-community-api` 24/24、`miniprogram-favorites-history` 17/17、`miniprogram-identify` 31/31、`miniprogram-transcript-confirm` 25/25、`miniprogram-voice-playback` 58/58、`miniprogram-herbicides-client` 13/13、`miniprogram-ocr-correction` 7/7、`tests/reference/knowledge-client` 51/51。

### 3.4 `npm run test:unit`（全量，跑了三次，读数逐次如实列出）

**第一次**（改码后、未改知识页用例）：
```
ℹ tests 3245   ℹ pass 3243   ℹ fail 1   ℹ skipped 1   ℹ duration_ms 82111.56   exit=1
✖ old 401 cannot clear a newer identity; current 403 invalidates session and page
   at tests/reference/knowledge-client.test.mjs:210  →  断言「403 之后 getSession() 必须为 null」
```
这**不是**并行抖动，而是既有用例把旧折叠口径写成了断言（403 ⇒ 清会话）。按 §0.1 的新口径更新为「403 保留会话 + 门禁不关闭 + 文案说『没有权限』」，并同步给 `knowledge-api.js:214` 补 403 三码文案（原先 403 会落到「资料服务暂不可用…请重试」，既错因又诱导无效重试）。

**第二次**（改完该用例后）：
```
ℹ tests 3245   ℹ suites 0   ℹ pass 3244   ℹ fail 0   ℹ cancelled 0   ℹ skipped 1   ℹ duration_ms 86038.02   exit=0
```

**第三次**（加完本证据页后复跑）：
```
ℹ tests 3244   ℹ pass 3242   ℹ fail 1   ℹ skipped 1   ℹ duration_ms 76567.06   exit=1
✖ tests\unit\local-profile-bootstrap.test.mjs (8249.85ms)
  # Fatal process out of memory: Zone   ← 子进程 V8 OOM，非断言失败
```
单跑证伪：`node --test tests/unit/local-profile-bootstrap.test.mjs` → `tests 3 / pass 3 / fail 0 / duration_ms 3624.05`。
即第三次的 1 fail 是**并行负载抖动**（该套件起真实 PostgreSQL 引导，两例各约 1.3–2.2s，并行时子进程 OOM），与本期改动无关；
本页结论以 3244/3245 那次的 0 fail 为基线，并如实保留这次抖动读数。
（`skipped 1` 为既有跳过项，非本期新增。）

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

### 3.7 改动面（代码与测试 18 文件，+458/−45；另有本页为新增文档）

本页自身的 +/− 会随本页修订浮动，故下表**只列代码与测试**（`git show --numstat HEAD` 中除本页外的全部行）：

```
  6   0  miniprogram/pages/profile/profile.js
103   3  miniprogram/utils/auth.js
  3   2  miniprogram/utils/community-api.js
  3   1  miniprogram/utils/favorites-api.js
  3   1  miniprogram/utils/history-api.js
  4  10  miniprogram/utils/identify-api.js
  6   2  miniprogram/utils/knowledge-api.js
  3   2  miniprogram/utils/messages-api.js
  1   1  miniprogram/utils/profile-api.js
  6  10  miniprogram/utils/speech-transcript.js
  1   1  miniprogram/utils/voice-api.js
  8   2  tests/reference/knowledge-client.test.mjs
258   0  tests/unit/miniprogram-auth-failure-attribution.test.mjs
  3   0  tests/unit/miniprogram-auth-runtime.test.mjs
 31   7  tests/unit/miniprogram-community-api.test.mjs
  3   1  tests/unit/miniprogram-login-return-to.test.mjs
  8   1  tests/unit/miniprogram-transcript-confirm.test.mjs
  8   1  tests/unit/miniprogram-voice-playback.test.mjs
```
`git status --porcelain` 对 `contracts/`、`.github/`、`migrations/`、`deploy/`、`openapi` **无命中**。
本期只做本地提交：`feat/gy-r28-d1-login-chain` 领先 `origin/main`（`7d1a429`）1 个提交，**未 push、未开 PR**。

## 4. 改法（逐文件）

### 4.1 `miniprogram/utils/auth.js`（+103/−3）

- `:15` 新增 `const states = require('./states')`（`states.js` 无任何 `require`，纯码表）。
- `:45-118` 新增归因层：
  - `SESSION_LOSS_CODES`（`:61`）= `Object.keys(states.CODE_KIND).filter(kind === 'session')` ⇒ 当前为 `SESSION_REQUIRED`/`SESSION_EXPIRED`/`SESSION_CHANGED`。**不写死第二份码表**。
  - `RETIRED_SESSION_CODES = ['ACCOUNT_INACTIVE']`（`:65`）：令牌永久失效、必须清会话，但码不折叠。
  - `attribution(statusCode, payload)`（`:87-105`）：401 → 会话类码或保守 `SESSION_REQUIRED`；403 → 封套码原样，读不到则 `SCOPE_DENIED`；返回 `{code,status,retryable,sessionLost,clearsSession}`。
  - `failureFor(makeFailure, statusCode, payload)`（`:111-118`）：仅当 `clearsSession` 才 `clearSession()`，再用调用方自己的 `failure()` 构造错误（不替各模块发明错误形状），只补 `status`/`retryable`。
- `:206-292` `verifySession` 的三分（`:261-279`，见 §2.3）。
- `:480-485` 导出 `SESSION_LOSS_CODES` / `RETIRED_SESSION_CODES` / `isSessionLossCode` / `attribution` / `failureFor`。

### 4.2 9 个适配层

| 文件 | 位置 | 改法 |
|---|---|---|
| `favorites-api.js` | `:93` | `reject(auth.failureFor(failure, r.statusCode, r.data))`（删除 `clearSession` + `failure('SESSION_REQUIRED')`） |
| `history-api.js` | `:164` | 同上 |
| `knowledge-api.js` | `:75-76` | 同上；游标只在 `attribution().clearsSession` 时丢弃 |
| `voice-api.js` | `:199` | 同上 |
| `profile-api.js` | `:23` | 同上 |
| `messages-api.js` | `:124` | 同上 |
| `community-api.js` | `:164` | 同上 |
| `identify-api.js` | `:267` | 原 `forbiddenOrSessionLoss` 改为 `return auth.failureFor(failure, statusCode, payload)`；删除自持的 `SESSION_LOSS_CODES`（原 `:41`） |
| `speech-transcript.js` | `:239` | 同上；删除自持的 `SESSION_LOSS_CODES`（原 `:229`，**与 identify 那份口径相反**） |

### 4.3 403 文案（原先走不到的码）

`favorites-api.js:183-184`、`history-api.js:427-428`、`messages-api.js:231-232`、`community-api.js:340-341`、`knowledge-api.js:214`、`pages/profile/profile.js:35-37`（`readFailure` 增加 `SCOPE_DENIED`/`CONSENT_REQUIRED`/`ACCOUNT_INACTIVE` 三分支，且不再说「请重试」——403 重试不会变好）。

### 4.4 测试

- 新增 `tests/unit/miniprogram-auth-failure-attribution.test.mjs`：真实 `auth.js` + 真实 9 个适配层，合成 `wx`，只喂 401/403/503 响应。
- `tests/unit/miniprogram-community-api.test.mjs`：两处 403 期望由 `SESSION_REQUIRED`+`cleared.count===1` 改为 `SCOPE_DENIED`+`cleared.count===0`，并新增「403 无封套 ⇒ `SCOPE_DENIED` 且不清会话」一例；文件头注释与两条用例标题同步。
- `tests/reference/knowledge-client.test.mjs:210-219`：见 §3.4。
- 三处 vm 载入器的 `auth` 替身（`miniprogram-community-api:81-89`、`miniprogram-transcript-confirm:158-168`、`miniprogram-voice-playback:546-556`）补 `attribution`/`failureFor`，**委托真实实现**（`createRequire` 载入 `miniprogram/utils/auth.js`），只有「清会话计数」用替身计数器——不在测试里重写码表。
- `miniprogram-auth-runtime.test.mjs` / `miniprogram-login-return-to.test.mjs`：临时目录复制清单各加 `utils/states.js`。

## 5. 外部前提缺口（未取得，不冒充）

| 项 | 状态 | 影响 |
|---|---|---|
| 正式 AppID 真机 `wx.login` + code 换会话 | **未取得**（属 GY-I25／#27） | (a)(b) 只有合成 `wx` 与本地临时 runtime 证据；不能声称「微信登录真机可用」 |
| 微信开发者工具编译 | **未取得**（`test:mini` 只做原生 JSON/路由/语法与打包隔离检查，自述「Not a WeChat compiler or device test」） | 页面级 WXML/WXSS 改动（本期仅 `profile.js` 的 JS 文案函数，未动 WXML）没有工具侧证据 |
| 真实服务端联调（`POST /auth/wechat` 真实响应） | **未取得** | 本期只在 Node 里以合成封套驱动真实客户端代码 |
| 真实用途政策 / 接收方清单（`policy_version`、`recipient_ids`） | **契约无读取面** | 客户端无法完成授权（§6 第 1 项） |
| 真实对象存储 / 审核 / ASR / TTS 提供者 | **未取得**（既有证据页已列） | 403 `CONSENT_REQUIRED` 的真实触发路径无法端到端复现 |

## 6. 待裁决（编号）

1. **同意授权入口 + 契约读取面**：客户端零 `me/consents` 调用，「去授权」（`identify-api.js:162,203` → `identify.wxml:320-330` → `identify.js:881`）是死按钮。要么 (a) 服务端增补「当前生效用途政策 + 已核验接收方」读取 operation（属契约变更，需监工裁决），要么 (b) 先把「去授权」按钮改成如实文案（"授权入口尚未接入，未授权时不会外发"）。本期未动，因为 (a) 越界、(b) 涉及页面承诺与既有 `ui-unified-states.test.mjs:206-209`、`recognitions-candidates-selection.test.mjs:389` 的断言口径。
2. **社区投稿 `public_posting` 用途闸未挂**（`routes/community.ts` 16 处 preHandler 只有 `requireUser`；`app.ts:1735` 未注入 `consentGate`，而 `privacy/egress.ts:11-19` 的挂载表要求挂）。是否本期就挂？挂了会让 GY-I15 全部社区 HTTP 用例先 403（需一并准备授权夹具），跨域 blast radius 大。
3. **`miniprogram/utils/session.js` 生死**：GY-I26 占位层（`SESSION_ENABLED=false`、`isGuest()` 恒 true）在 GY-I04 真实会话层（`auth.js`）落地后已无生产消费者，但 `tests/ui-adaptive.test.mjs:274,285` 仍以源码字面量守着它。删文件 / 改成委托 `auth.js` / 保留现状，三种都要动那条守卫——请裁决口径（本期保留现状，并在本页记录它是死代码）。
4. **`ACCOUNT_INACTIVE` 的呈现口径**：本期按「码如实保留（B7 = `denied`）+ 清会话」。改前两份实现相反（`identify-api` 原样带出不清会话、`speech-transcript` 折叠成登录失效并清会话）。若产品口径是「账号不可用应显示为登录页提示」，则需回到折叠——请确认。
5. **`pages/profile/profile.wxml:162-172` 隐私说明文案**：「可以随时撤回」目前无入口，属承诺与实现不一致；是否本期改文案（会与 `gy-i28-demo-parity-20261018.md` 的逐条对照口径牵连）。
6. **`docs/verification/gy-i28-unified-states-20261021.md` 的结论需要补一句边界**：`:238` 写「403 不再被折叠成「请先登录」」，但在本期之前该结论只在**页面呈现层**成立，传输层 7 个模块仍在折叠。本期已把传输层补齐；历史页未改（保留其当时结论），是否加 superseded 注记请裁决。
7. **与已合并的 #393（`8e8584e`，Refs #16）重叠，须监工定处置**：该提交在 `favorites-api.js`/`history-api.js` 里**又写了一份** `forbiddenOrSessionLoss`（第三份），并改了收藏/历史三个页面把 `errorCode` 交给 `state-view`。本期把同一处改成委托 `auth.failureFor`，并覆盖其余 7 个适配层。两者在 `miniprogram/utils/favorites-api.js`、`miniprogram/utils/history-api.js`、`tests/unit/miniprogram-favorites-history.test.mjs` 上**会冲突**。仓库纪律要求不在本 worktree 内 rebase，故未合并；请裁决：(a) 本期作为「统一层」先行、#393 的页面侧改动叠加其上，或 (b) 先把 #393 的适配层实现回退成委托 `auth.attribution`。
   附一处**语义分歧**：403 响应**没有**错误封套时——#393 保守折叠为 `SESSION_REQUIRED` 并清会话；本期归为 `SCOPE_DENIED` 且**不清**会话（理由：无封套通常来自网关而非本 API，为一个网关 403 销毁有效令牌正是本期要修的害处；且「登录了但不给」比「请重新登录」更接近事实）。两种都自洽，需统一口径。
8. **「去授权」死按钮**的另一条低成本出口：若短期不加契约读取面，可把识别页 `permission_denied` 分支的动作从「去授权」改为「查看隐私说明」（`pages/profile/profile.wxml:162-172`），并同步把该段文案改成「授权入口尚未接入」。这会动 `ui-unified-states.test.mjs:206-209` 的断言，故列为裁决项而非本期实施。

## 7. 复核出的文档行号漂移

| 派发/文档说法 | 实际（`7d1a429`） | 说明 |
|---|---|---|
| 任务书：`AGENT.md`（仓库根，169 行） | 根目录**没有** `AGENT.md`，只有 `AGENTS.md`（**39 行**，5026 字节） | 文件名与行数都不符 |
| 任务书：`docs/verification/gy-i05-locate-timeout-20261021.md` | **在本期基点 `7d1a429` 上不存在**；它由**更新后的** `origin/main`（`93f336b`，PR #392）引入 | 不是文件写错，而是派发时基点较旧；本期未 rebase（纪律要求），故按同族体例另择参照 |
| 任务书：`docs/verification/gy-r28-c5-favorites-history-20261021.md` | **在本期基点 `7d1a429` 上不存在**；它由 `origin/main` 的 `8e8584e`（PR #393，C5 切片）引入，同一提交也改了 `favorites-api.js`/`history-api.js` | 与本期重叠，见 §6 第 7 项 |
| 任务书：`POST /auth/wechat` 的 operationId | 真实 operationId 是 **`loginWechat`**（`openapi.json`）；`/auth/wechat` 是路径 | 已按契约纠正 |
| `miniprogram/utils/session.js:5` 注释「真实会话由 GY-I04 服务端签发后替换本文件」 | 替换实际发生在 `utils/auth.js`，本文件未替换也未删除 | 死代码 + 注释过期 |
| `docs/verification/gy-i28-unified-states-20261021.md:26-28,238`「403 不再被折叠」 | 改前只在呈现层成立；传输层 7 个 `*-api.js` 仍在折叠 | 本期补齐；历史页不改，见 §6 第 6 项 |
| `miniprogram/utils/identify-api.js:41` 与 `speech-transcript.js:229` 注释「同口径」 | 两份码表实际**不同**（前者不含 `ACCOUNT_INACTIVE`，后者含），对同一响应给出相反结论 | 已收敛到 `auth.attribution`，两处自持码表删除 |
| `services/api/src/privacy/egress.ts:11-19` 挂载表含「社区投稿入口」 | `routes/community.ts` 16 处 preHandler 均未挂用途闸 | 见 §6 第 2 项 |
| `services/api/src/auth/middleware.ts:7` 注释「供 GY-I27 的 requireConsent 直接消费」 | 核对为**准确**（`app.ts:850` 起已消费） | 非漂移，记录以证明已核 |

## 8. 不证明什么

- 不证明真机／开发者工具下的登录可用；不证明正式 AppID 的 code 交换；不证明任何 403 的真实触发链路端到端可达（真实提供者未接线）。
- 不证明「同意段」已通：授权入口与契约读取面都缺（§6 第 1 项）。
- 不把 `stub` / `preset_demo` 的执行模式当作真实能力；本期没有新增任何替身成功路径，也没有把 403 说成成功。
- 本页所有「通」都限定为：**在同一份真代码 + 合成 `wx` 响应下，判定与文案符合契约语义**。
