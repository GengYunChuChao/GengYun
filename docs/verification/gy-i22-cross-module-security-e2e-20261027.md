# GY-I22 跨模块权限/安全规则与首版端到端失败回归 · 可复现证据（2026-10-27）

- **Issue**：[#22](https://github.com/GengYunChuChao/GengYun/issues/22)（P0 / M4；`Refs #22`；**不关闭整项**）。
- **分支**：`feat/gy-i22-security-e2e`（独立 worktree `E:\GengYunCommander\GengYun_W40`；本地提交，**未 push**）。
- **基线**：`upstream/main` = `ddeb301d7fa308023ccbd19e46c0c26871cf75a3`（fetch 时为最新）。
- **提交链**（`git log --oneline upstream/main..HEAD`）：

  | SHA | 内容 |
  | --- | --- |
  | `b16a607` | 跨模块会话/角色在途变化失败回归（16 个受保护面矩阵 + 逐字节同形封套） |
  | `de8b06c` | 授权撤回/在途外发在 4 个真实 AI 受理面的跨模块失败回归（零外发、逐面必需用途） |
  | `7c6f12e` | 作业在途守卫（取消后晚到结果零写入）与识别线跨用户归属失败回归 |
  | `5c8f178` | 补第 5 个受控写面 `PATCH /recognitions/{id}/selection` 的授权与归属覆盖 |
  | `2c1866b` | 本证据页（含 CI glob 事实更正、4 处变异自证、2 项发现披露） |

- **`git diff --stat upstream/main...HEAD`**：

  ```
   docs/verification/gy-i22-cross-module-security-e2e-20261027.md | 468 +++++++++++++++++++++
   tests/unit/gy-i22-consent-withdrawal-inflight-http.test.mjs    | 413 ++++++++++++++++++
   tests/unit/gy-i22-job-inflight-guard-and-ownership.test.mjs    | 353 +++++++++++++++++
   tests/unit/gy-i22-session-inflight-cross-module.test.mjs       | 425 +++++++++++++++++++++
   4 files changed, 1659 insertions(+)
  ```

  （`HEAD` 以分支实际末端为准；本页为**新增文档**，无生产代码改动。）

- **环境**：Node `v24.16.0` / npm `11.13.0`；npm workspaces + 纯 ESM；`npm install`（**未使用** junction/symlink）。
- **实现者 = 写手；推送者 = 指挥**。本片**不持有任何 GitHub 凭据**、**未 push**。
- **未改动**：`packages/contracts/**`（0 字节改动）、任何他人已合并实现的语义、任何既有断言（只**新增**用例，无修改、无跳过）。

> **校订记录（2026-10-16，后于本片提交）**：本页 §0 有两处 CI glob 事实陈述**已实测证伪**，
> 由**后续**校订片逐条订正，订正内容见 **§0.1**；§0 原文与 §7 第 5 项括注均**保留不删**（不静默抹掉历史）。
> 该次校订是本页**首次**对已存在正文的改动：上表"提交链/`git diff --stat`"描述的是**本片当年**的提交链，
> 未包含该次校订；校订后的被测 HEAD 与新增节见提交信息与 §0.1（⛔ 不重写当年账目）。
> 校订时实测 `upstream/main` = `3bc745184c9a7c168ef01337b4db1297ea0cc72e`（2026-10-16 11:32:58 +0000，`git fetch upstream --prune` 后 `git rev-list --left-right --count HEAD...upstream/main` = `0 0`）。

---

## 0 事实更正：实际 CI glob 与派单书不一致（必须先读）

派单书写作 `tests/{unit,privacy,media,reference,moderation}/*.test.mjs`。**实测不符**：

```
package.json:
  "test:unit" = node --test "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs"
                          "tests/media/*.test.mjs" "tests/reference/*.test.mjs"
```

- `tests/moderation/**` **不在任何 npm script、也不在任何 workflow** ⇒ 只能由作者显式运行；
  > **2026-10-16 校订（本条为假，原文保留以存历史）**：见 §0.1。`tests/moderation/*.test.mjs` 已逐字写在
  > `package.json` 的 `test:unit` 里，并由 `engineering-shell.yml` 的 `unit-tests` job 执行 ⇒ 该断言**不成立**。
- `tests/integration/**` 只有 6 个具名 `*-pg.mjs` 由专用 workflow（带 postgres service）运行，
  `tests/integration/profile-ui-http.test.mjs` 由 `local-wechat.yml` 运行；**通用 `tests/integration/**` 不在任何 CI glob 内**。
  > **2026-10-16 校订（计数过期，原文保留）**：见 §0.1。实测由专用 workflow 按名运行的 `*-pg.mjs` 是 **7** 个（多出
  > `egress-ledger-pg.mjs`）；另有 `test:integration:http` 通过 `&&` 串联的 **9** 个非 PG 回环脚本同样在 CI 内。

### 0.1 后续订正：`tests/moderation/**` 确实在 CI 内（2026-10-16 实测）

本节由**后续**复核补写，不是本片当年的结论。⛔ 上方 §0 的原文**保留不动**，此处只登记"哪一条被证伪、证据是什么"，
不静默抹掉历史。

| 事实 | 逐字证据（2026-10-16 实测） |
| --- | --- |
| `test:unit` 的 glob 含 moderation | `package.json:20`：`"test:unit": "node --test \"tests/unit/*.test.mjs\" \"tests/privacy/*.test.mjs\" \"tests/media/*.test.mjs\" \"tests/reference/*.test.mjs\" \"tests/moderation/*.test.mjs\""` |
| 该 script 在 CI 内被原样执行 | `.github/workflows/engineering-shell.yml:58`：`- run: npm run test:unit`（job `unit-tests`） |
| 该目录确有可跑的用例 | `tests/moderation/` 下 **17** 个 `*.test.mjs`（另有 3 个 `_*fixtures.mjs` 夹具，非用例文件） |

⇒ §0 第 1 条「`tests/moderation/**` 不在任何 npm script、也不在任何 workflow」**不成立**；§7 第 5 项括注
「不在任何 CI glob」同属不成立（"本片未执行"这一事实本身仍成立）。该结论与审核域自己的记录一致：
`docs/verification/gy-i14-moderation-rules-20261011.md:49`、`docs/verification/gy-i14-moderation-model-20261012.md:467`、
`docs/verification/gy-i14-moderation-http-20261014.md:211` 均写明 `tests/moderation/*.test.mjs` 已在 `test:unit` glob 内。

§0 第 2 条只有**计数**过期（不改"夹带风险"这一论证方向）：实测 `tests/integration/**` 共 **34** 个 `*.mjs|*.cjs`
脚本，其中 **8** 个被 workflow 按名执行（7 个 `*-pg.mjs`＋`profile-ui-http.test.mjs`，后者由 `local-wechat.yml:62`
的 `node --test` 跑），另 **9** 个由 `test:integration:http`（`package.json:24`，`&&` 串联）在 CI 内执行——
两个集合的交集是 `profile-ui-http.test.mjs`（`test:integration:http` 的第 4 条即 `node tests/integration/profile-ui-http.test.mjs`）
⇒ **并集 16** 个有 CI 覆盖，**18** 个只由作者显式跑（含 `local-dev-*.cjs` 这类需微信工具的脚本）；
「通用 glob（`tests/integration/**` 通配）不进 CI」这一结论**仍成立**。

**性质与边界**：上述只说明这些用例**会在 CI 里被执行**，**不证明**审核域的真实模型、真实供应商或整项验收已通过
（审核域模型层用例显式声明是**合成夹具**上的确定性回归，见 `docs/verification/gy-i14-moderation-rules-20261011.md:187`）。
本页 §7 的"未取得"清单不因本节而放宽。§0 原文与本节并存，**以本节为准**。

⇒ 本片三个新文件全部落在 **`tests/unit/*.test.mjs`**，即 `npm run test:unit`（`engineering-shell.yml` 的 `unit-tests` job）**会执行**。
本片**没有**使用 `tests/integration/**`。

---

## 1 本片做了什么（一句话）

在**真实组合应用**（`buildApp` + `app.inject`）上，把**会话/授权/账号/归属/作业在途**这几条跨模块红线
做成**矩阵式负例**，使"**单模块自身通过、但整体会越权或放行**"的场景**必须失败**；
每条负例都用**变异自证**（临时改坏实现 → 确认变红 → 完整回退）证明它真能红（见 §4）。

三个文件（21 条用例）：

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `tests/unit/gy-i22-session-inflight-cross-module.test.mjs` | 9 | 游客/注销/账号版本前进/停用/过期/受众互用/后台权限在途降级，**16 个受保护面**统一拒绝 |
| `tests/unit/gy-i22-consent-withdrawal-inflight-http.test.mjs` | 8 | 4 个真实 AI 受理面 + 第 5 个受控写面（人工选择）的授权判定、在途撤回、账号在途变化、`real` 零外发 |
| `tests/unit/gy-i22-job-inflight-guard-and-ownership.test.mjs` | 4 | 取消后晚到结果零写入、取消幂等、识别线跨用户归属同形 404、跨任务隔离 |

---

## 2 回归清单（逐条：场景 → 期望拒绝/失败 → 可复核命令 → 原始输出）

**统一可复核命令**（三条各自独立、可直接复跑单条）：

```bash
cd E:\GengYunCommander\GengYun_W40
node --test tests/unit/gy-i22-session-inflight-cross-module.test.mjs
node --test tests/unit/gy-i22-consent-withdrawal-inflight-http.test.mjs
node --test tests/unit/gy-i22-job-inflight-guard-and-ownership.test.mjs
```

### 2.1 会话/角色在途变化 —— `gy-i22-session-inflight-cross-module.test.mjs`

矩阵 = **14 个读面**（`/auth/session`、`/me/profile`、`/me/consents`、`/favorites`、`/history`、`/messages`、
`/messages/unread-count`、`/posts`、`/knowledge`、`/herbicides`、`/recognitions/{id}`、`/ocr/{id}`、
`/speech/transcriptions/{id}`、`/jobs/{id}`）+ **2 个写面**（`POST /media/uploads`、`POST /posts`）= **16 面**；
后台另 4 面。所有请求**形状合法**（`preValidation` 先于 `preHandler`，形状不合法会先得 400 而掩盖鉴权结论）。

| # | 场景 | 期望 | 关键断言 |
| --- | --- | --- | --- |
| S1 | 游客（无令牌）访问 16 面 + 4 后台面 | **一致 401 `SESSION_REQUIRED`** | 每面必须 401（**同时证明该面确实挂了守卫**，非未注册兜底）；20 面错误封套**逐字节同形** |
| S2 | 同一枚有效令牌访问 16 面（**正控制**） | 不得 401/403 | 排除"整列恒 401"的空转 |
| S3 | `POST /auth/logout` 后旧令牌访问 16 面 | **一致 401 `SESSION_EXPIRED`** | 且另一用户的会话**不受连带撤销** |
| S4 | 旧令牌**重放注销请求本身** | **401**（不得重放旧 Ack） | 幂等重放必须先重新鉴权 |
| S5 | `auth_epoch` 前进后旧令牌访问 16 面 | **一致 403 `ACCOUNT_INACTIVE`** | 账号级变更不影响他人；旧令牌**不因后续操作复活** |
| S6 | 账号 `state=suspended` 后旧令牌访问 16 面 | **一致 403 `ACCOUNT_INACTIVE`** | 停用与版本前进是两条独立判据 |
| S7 | 会话绝对到期后旧令牌访问 16 面 | **一致 401 `SESSION_EXPIRED`** | — |
| S8 | **受众隔离**：用户令牌 → 4 个后台面；后台令牌 → 16 个用户面 | **403 `SCOPE_DENIED`** / **401 `SESSION_EXPIRED`** | 用户令牌在后台面是**明确的高权限拒绝**，不是 404；后台令牌可用作正控制 |
| S9 | **后台权限在途降级**：撤回 `flags:write` 后旧后台令牌写开关 | **403 `SCOPE_DENIED` + 零副作用** | 被拒写请求**不改变开关值、不推进 revision**；仍保留的 `flags:read` **继续可用** |

原始输出（exit 0）：

```
✔ 跨模块·游客矩阵：无令牌在全部 16 个受保护面一致 401 SESSION_REQUIRED，且错误封套逐字节同形
✔ 跨模块·正控制：同一枚有效用户令牌在全部面上都不被鉴权拒绝（排除整列恒 401 的空转）
✔ 跨模块·注销：POST /auth/logout 后同一枚旧令牌在全部 16 个面一致 401 SESSION_EXPIRED（不得有任何一面留用旧会话）
✔ 跨模块·会话撤销幂等且不可复活：旧令牌重放注销请求本身也必须 401（不得重放旧 Ack）
✔ 跨模块·账号版本前进：auth_epoch 前进后旧令牌在全部 16 个面一致 403 ACCOUNT_INACTIVE
✔ 跨模块·账号停用：state=suspended 后旧令牌在全部 16 个面一致 403 ACCOUNT_INACTIVE
✔ 跨模块·过期令牌：会话绝对到期后同一枚令牌在全部 16 个面一致 401 SESSION_EXPIRED
✔ 跨模块·受众隔离：用户令牌访问全部后台面一致 403 SCOPE_DENIED，后台令牌访问全部用户面一致 401 SESSION_EXPIRED
✔ 跨模块·后台权限在途降级：撤掉 flags:write 后旧后台令牌写面 403 SCOPE_DENIED，开关零变更，flags:read 仍可用
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

### 2.2 授权撤回 / 在途外发（4 个真实 AI 受理面）—— `gy-i22-consent-withdrawal-inflight-http.test.mjs`

**为什么是真空白**：`tests/unit/privacy-egress-http.test.mjs` 自己起的是**最小合成 Fastify 实例**
（`/synthetic/egress`），其文件头自陈"不改任何既有路由/装配文件：自己起一个最小 Fastify 实例"。
⇒ 「`app.ts` 把授权中间件挂到 **4 个真实 AI 受理面**、且每面按自己的 `dataType` 判定必需用途集合」
这条**装配事实**，此前在**真实组合应用**上**零覆盖**。
本文件用**已合并的真实实现**（`packages/privacy/guard.mjs` 的 `createPrivacyGuard` +
`consent.mjs` 的 `createConsentStore`），经 `createGuardConsentGate` 注入 `privacyInjection.consent`
（= 装配方真实接线方式）。

| # | 场景 | 期望 | 关键断言 |
| --- | --- | --- | --- |
| C1 | 未授予任何用途，访问 `POST /recognitions`、`POST /ocr`、`POST /speech/transcriptions`、`POST /speech/synthesis` | **4 面一致 403 `CONSENT_REQUIRED`** | 4 面错误封套**逐字节同形** |
| C2 | **部分授权**（给 `external_inference`+`recording`，缺 `media_processing`） | 3 个媒体面 **403 `CONSENT_REQUIRED`**；合成面放行 | 逐面按 `dataType` 的**必需用途集合**精确判定（缺哪一项被点名） |
| C3 | 用途齐全（**正控制**） | 4 面都到达业务处理 | 排除"整列 403"空转 |
| C4 | **在途撤回** `external_inference` | 同一请求**立即** 4 面一致 403；**读面不被连带关闭** | 撤回是**调用时重查**（不缓存）；`GET /recognitions/{id}` 仍 404 而非 403（不得妨碍取回/删除自己的数据）；**重新授权后恢复** |
| C5 | **隐私侧账号权威**：`state=deletion_pending`、`auth_epoch` 前进 | **4 面一致 403 `ACCOUNT_INACTIVE`** | 不得只采信认证会话存储里的旧结论 |
| C6 | 游客 / 伪造令牌（即使用途齐全） | **4 面一致 401**（`SESSION_REQUIRED` / `SESSION_EXPIRED`） | **鉴权先于授权**，授权状态不泄露给未鉴权调用方（口径未放宽） |
| C7 | **第 5 个受控写面** `PATCH /recognitions/{id}/selection` | 未授权 **403 `CONSENT_REQUIRED`**；授权齐全后 **404 `NOT_FOUND`** | 该写面挂的是同一 `consentGate`；授权放行后**归属判定**照旧生效 |
| C8 | `real` 未接真实依赖 | **4 面一致 503 `PROVIDER_UNAVAILABLE`** | **注入计数提供者 ⇒ 业务提供者零调用（零外发）**；不得返回成功封套；撤回后仍拒绝且仍零调用 |

原始输出（exit 0）：

```
✔ 跨模块·授权：未授予任何用途 ⇒ 4 个真实 AI 受理面一致 403 CONSENT_REQUIRED，且封套逐字节同形
✔ 跨模块·授权：缺 media_processing ⇒ 三个媒体面都被拒，只要求 external_inference 的合成面放行（按 dataType 精确判定）
✔ 跨模块·正控制：用途齐全 ⇒ 4 个真实受理面都不被授权中间件拒绝（排除整列 403 空转）
✔ 跨模块·在途撤回：撤回 external_inference 后 4 面立即一致 403 CONSENT_REQUIRED；读面不被一并关掉（GET 仍非 403）
✔ 跨模块·账号在途变化：隐私侧账号待删除/auth_epoch 前进 ⇒ 4 面一致 403 ACCOUNT_INACTIVE（不得只靠会话存储的旧结论放行）
✔ 跨模块·口径：游客与伪造令牌在受理面一律 401（鉴权先于授权，开关/授权状态不泄露给未鉴权调用方）
✔ 跨模块·授权：第 5 个受控写面 PATCH /recognitions/{id}/selection 未授权 403 CONSENT_REQUIRED；授权齐全后到达归属判定（404 而非 403）
✔ 跨模块·real 未接真实依赖：4 个真实受理面一致 503 PROVIDER_UNAVAILABLE(retryable)，且业务提供者零调用（零外发）
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

**关于"账本零新增"的如实边界**：`app.ts` 只在**配置了数据库且连接池具备 `connect()`/`query()`** 时装配持久外发账本
（`egressPoolUsable`）。本文件所有场景**不传连接池** ⇒ 组合应用里**根本没有账本被装配**，因此"账本零新增"在此**无从被证伪**
（不是"证明了零新增"）。组合应用侧的对应保证以**可证伪的形式**给出：`real` 未接真实依赖 ⇒ 一致 503
且**业务提供者零调用**（注入计数提供者）。协议层的"撤回/取消后回写阻断、账本零写入"由
`tests/privacy/ledger.test.mjs`（65 条）与 `tests/privacy/in-flight.test.mjs`（13 条）作为**既有证据引用**（本片**不重跑**）。

### 2.3 作业在途守卫与识别线跨用户归属 —— `gy-i22-job-inflight-guard-and-ownership.test.mjs`

**为什么是真空白**：`tests/unit/jobs-registry.test.mjs` 用**假作业源**、`tests/unit/admin-ops-job-integrity.test.mjs` 用
**合成作业端口**，验证的是注册表/后台层分派；本文件用**可控提供者**（按 `mediaId` 一次性挂起）把**真实服务**的
提供者调用**停在半途**、取消后**再放行** —— 这条接缝既有用例没有。识别线三个读/写面的越权同形此前也无组合应用级用例。

| # | 场景 | 期望 | 关键断言 |
| --- | --- | --- | --- |
| F1 | 作业取消后，在途提供者的**晚到成功结果**到达 | 作业**仍为 `cancelled`**、结果 `null`、版本不再推进；**识别记录零写入**（404） | 领域 store 不得被迟到结果写入 |
| F2 | 同键 + 同 `If-Match` **原样重试取消** | **200**，回放同一结论、**不推进版本** | 同键**异体**（`If-Match` 不同）⇒ **409 `IDEMPOTENCY_CONFLICT`**（不得静默当新请求执行） |
| F3 | 他人对 A 的作业/识别记录：读、取消、改选 | **一律 404 `NOT_FOUND`** | 与"不存在"**同形**（`deepEqual` 比较 `error` 对象）；A 的对象**版本与状态不变** |
| F4 | 取消后**同对象同版本**用新键再受理 | 被接受为**新任务**（如实登记的设计行为） | 但**旧任务的晚到结果不得写入新任务**：任务 1 仍 cancelled、其记录 404；任务 2 记录 200 且候选**完全来自任务 2 自己的提供者调用**；提供者**恰好被调用 2 次**，两次都指向同一 `(mediaId, mediaRevision)` |

原始输出（exit 0）：

```
✔ F1·在途守卫：取消后在途提供者的晚到成功结果不得复活作业、不得写入识别记录（域 store 零写入）
✔ F2·取消幂等：同键同 If-Match 原样重试回放已取消结果；同键异体 ⇒ 409 IDEMPOTENCY_CONFLICT
✔ F3·跨用户归属：他人作业/识别记录的读、取消、改选一律同形 404，且归属者对象状态不变
✔ F4·跨任务隔离：取消后同对象同版本再受理会成为**新任务**（如实登记设计行为），但旧任务的晚到结果不得写入新任务
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

> **关于 issue 原文括注"取消后同对象同版本不得再次受理"的如实说明**：实测**该实现里不存在**"取消后禁止再次受理同一对象同一版本"的全局守卫
> —— `POST /recognitions` 的重复受理只由**幂等键**约束（`scopeFor(userId,'POST','/recognitions')`），
> `ledger.reserve` 也不对 `(objectType, objectId, objectRevision)` 做唯一性约束。
> 本片**没有**把"再受理应当被拒"写成断言（那会红），而是：
> ① 断言**确实存在**的那条红线 —— **旧任务的晚到结果不得复活/写入**（F1、F4）；
> ② 把"取消不是持久禁令"作为**设计行为如实登记**（F4 标题与注释明写）。
> 是否要新增"取消后同对象同版本冷静期"属**新造业务语义**，超出本片"只做验证面"范围 ⇒ 留待裁定。

---

## 3 既有覆盖：引用不重跑（轻量规范）

以下场景经逐条核对**已由既有用例覆盖**，本片**不重复、不重跑**，仅在矩阵中作为**跨模块组合**重新组合：

| 既有覆盖 | 位置 | 本片为何不重复 |
| --- | --- | --- |
| 后台隐藏帖子 ⇒ 社区列表/详情同时消失、旧链接不复活 | `tests/unit/community-http.test.mjs` L364、L409 | 社区域内已覆盖；本片不做社区读面重测 |
| 来源下架后引用失效、缓存副本与旧链接不得复活 | `tests/unit/admin-reference-invalidity.test.mjs` L92 等 8 条 | 后台引用完整性已覆盖 |
| 收藏/历史可见性 fail-closed、读取时重查、注销后不复活 | `tests/unit/favorites-history-visibility.test.mjs` L63/L90/L119/L148 | 目标可见性端口语义已覆盖 |
| 媒体 7 面归属同形 404、短效句柄、审核上下文、社区取图整段、公开内容来源默认关闭 | `tests/unit/media-http-access.test.mjs`（含 L390/L530/L539） | 媒体域越权与取图已覆盖 |
| 全局开关跨端点生效、关闭 ⇒ 零产出、`real` 不启用开关门 | `tests/unit/admin-flag-gate.test.mjs` E1–E7 | 开关门已覆盖 |
| 消息域归属同形 404、引用 fail-closed、读取时重查 | `tests/unit/messages-security.test.mjs`、`messages-http.test.mjs` L88/L126 | 消息域已覆盖 |
| 协议层：撤回/取消后回写阻断、零写入、账本零新增、原子边界竞态 | `tests/privacy/ledger.test.mjs`（65）、`in-flight.test.mjs`（13）、`egress.test.mjs`（15） | 协议层证据充分；本片只补**组合应用层是否接上** |
| 授权中间件在**合成路由**上的 401/403/ACCOUNT_INACTIVE 与 real fail-closed | `tests/unit/privacy-egress-http.test.mjs` | 合成实例；本片补**真实 4 面装配** |
| 作业注册表分派、越权 ⇒ 同形 404、无取消能力 ⇒ 503 | `tests/unit/jobs-registry.test.mjs` L212/L260 | 注册表层；本片补**真实域的取消/晚到** |

---

## 4 负控制（变异自证）：临时改坏 → 确认变红 → 完整回退

**三处都真做了**，每次都用 `git checkout -- <文件>` 完整回退，回退后 `git status --porcelain` 只剩本片新增的测试文件。

### 4.1 拆掉**一个面**的鉴权守卫（模拟"单模块漏挂共享守卫"）

改动：`services/api/src/routes/favorites.ts:87` 的 `guards.requireUser` → 空 `preHandler`。

原始输出（节选）：

```
✖ 跨模块·游客矩阵：无令牌在全部 16 个受保护面一致 401 SESSION_REQUIRED，且错误封套逐字节同形
  AssertionError [ERR_ASSERTION]: 全部受保护面必须给出**逐字节同形**的错误封套；实际出现 2 种：
✖ 跨模块·注销：POST /auth/logout 后同一枚旧令牌在全部 16 个面一致 401 SESSION_EXPIRED
  AssertionError [ERR_ASSERTION]: 收藏 GET /favorites：期望错误码 SESSION_EXPIRED，实际 SESSION_REQUIRED
✖ 跨模块·账号版本前进：auth_epoch 前进后旧令牌在全部 16 个面一致 403 ACCOUNT_INACTIVE
  AssertionError [ERR_ASSERTION]: 收藏 GET /favorites：期望 403，实际 401 {"error":{"code":"SESSION_REQUIRED",...}}
ℹ tests 9 / ℹ pass 2 / ℹ fail 7
```

**意义**：该域**自己的用例仍全绿**，只有跨模块矩阵发现 —— 这正是 issue #22 的核心风险。

### 4.2 拆掉共享守卫里的 `auth_epoch` 判据

改动：`services/api/src/auth/middleware.ts` 的 `if (session.authEpoch !== user.authEpoch)` → `if (false && ...)`。

原始输出（节选）：

```
✔ 跨模块·游客矩阵 …  ✔ 跨模块·正控制 …  ✔ 跨模块·注销 …  ✔ 跨模块·会话撤销幂等 …
✖ 跨模块·账号版本前进：auth_epoch 前进后旧令牌在全部 16 个面一致 403 ACCOUNT_INACTIVE
  AssertionError [ERR_ASSERTION]: 认证 GET /auth/session：期望 403，实际 200 {"data":{"audience":"user",...}}
ℹ tests 9 / ℹ pass 8 / ℹ fail 1
```

**意义**：只有对应用例变红、且报出"旧令牌被放行 200" ⇒ 该用例真在测，非空转。

### 4.3 拆掉 **OCR 一个面**的授权中间件（模拟"AI 受理面漏挂授权"）

改动：`services/api/src/app.ts` 的 `registerOcrRoutes(app, config, { guards: gatedGuards, consent: consentGate, egress: ocrEgress })`
→ 去掉 `consent: consentGate`。

原始输出（节选）：

```
✖ 跨模块·授权：未授予任何用途 ⇒ 4 个真实 AI 受理面一致 403 CONSENT_REQUIRED …
  AssertionError [ERR_ASSERTION]: 图文受理 POST /ocr：期望 403，实际 202 {"data":{"id":"…","revision":1,
    "kind":"ocr","target_ref":{…},"state":"queued",…}}
✖ 跨模块·授权：缺 media_processing …      ✖ 跨模块·在途撤回 …
✖ 跨模块·账号在途变化 …                    ✖ 跨模块·real 未接真实依赖 …
ℹ tests 7 / ℹ pass 2 / ℹ fail 5
```

**意义**：报出**真实越权** —— 用户从未授予 / 已撤回 `external_inference` 时，`POST /ocr` 仍被受理并进入 `queued`。

### 4.4 拆掉作业终态提交的 CAS 与迁移守卫

改动：`services/api/src/recognitions/store.ts` 的 `commitTerminal` 中
`row.revision !== expectedRevision` 与 `!canTransitionJob(...)` 两个判据同时失效。

原始输出（节选）：

```
✖ F1·在途守卫：… AssertionError [ERR_ASSERTION]: 晚到结果不得把已取消作业复活为成功
✖ F2·取消幂等：…
✖ F4·跨任务隔离：… AssertionError [ERR_ASSERTION]: 任务 1 不得被自己的晚到结果复活
ℹ tests 4 / ℹ pass 1 / ℹ fail 3
```

### 4.5 一次**无效尝试**（如实披露）

本轮**没有**失败后放弃的变异尝试；唯一一次"先红后绿"的非变异调整是 F2 的**用例自身**：
最初版本先 `await settle()` 让作业落定成 `succeeded` 再取消，于是得到
`409 OBJECT_UNAVAILABLE "任务已处于终态 succeeded，不可取消"`（与在途/幂等语义无关的干扰）。
已改为**用可控提供者把作业确定地停在 `running`** 后再取消，之后稳定绿。这**不是**放宽断言，而是修正用例的前提。

---

## 5 发现与披露（本片**未修**）

### 5.1 管理端账号停用面与认证账号权威**完全脱钩** ⇒ 该能力在组合应用里"无对象可作用"（**订正版**）

> ⚠️ **订正说明（如实披露）**：本片初稿曾把此洞描述为"被停用账号的既有会话继续可用（越权/放行）"。
> 实测后**该描述不准确**，此处按**可观察事实**订正。原描述基于只读源码推断（`commitAccountIfCurrent`
> 只写后台自己的 store），订正依据是本页 §5.1 探针的**真实原始输出**。

- **现象（实测）**：`GET /api/v1/admin/accounts` 返回 **200 且 `items: []`**（出厂装配下**没有任何账号**）；
  真实认证用户的 id **不在**该投影里；`POST /api/v1/admin/accounts/{真实认证用户 id}/suspend` ⇒ **404 `NOT_FOUND`**；
  此后该用户的 `GET /api/v1/auth/session` **仍为 200**，认证存储里仍是 `{"state":"active","authEpoch":1}`。
- **机制**：`services/api/src/admin/ops/store.ts` 的 `accounts` 映射**只由测试注入** `accountSeed`
  （见 `tests/unit/admin-ops-operations.test.mjs`）；`app.ts` 的 `createAdminOpsStore({ runtime, flagSeed })`
  **不传账号权威**。`commitAccountIfCurrent` 写的是这份**私有内存投影**，没有任何代码读/写
  认证存储的 `users.state` / `users.auth_epoch`。
- **可复核命令**（**已实际运行**；探针脚本为**仓外临时脚本**，入库时按约定不提交）：
  把下述内容保存为**仓外**文件（例如 `E:\GengYunCommander\.w40-tmp\probe.mjs`）后 `node <该文件>`：

  ```js
  const WT = 'file:///E:/GengYunCommander/GengYun_W40';
  const { buildApp } = await import(`${WT}/services/api/src/app.ts`);
  const { loadConfig } = await import(`${WT}/services/api/src/config.ts`);
  const { createMemoryAuthStore } = await import(`${WT}/services/api/src/auth/store.ts`);
  const { hashToken } = await import(`${WT}/services/api/src/auth/tokens.ts`);

  const auth = createMemoryAuthStore();
  const user = await auth.createUser('a'.repeat(64));
  const userToken = 'synthetic-probe-user-token';
  await auth.createSession({ userId: user.id, tokenHashHex: hashToken(userToken), authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3600_000), audience: 'user' });
  const adminId = await auth.createAdmin({ loginName: 'synthetic-probe-admin',
    credentialHash: 'synthetic-not-a-real-hash', scopes: ['accounts:read', 'accounts:suspend'] });
  const adminToken = 'synthetic-probe-admin-token';
  await auth.createSession({ userId: adminId, tokenHashHex: hashToken(adminToken), authEpoch: 1,
    expiresAt: new Date(Date.now() + 3600_000), audience: 'admin' });

  const app = buildApp({ config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'stub' }, store: auth });
  const call = async (method, url, token, extra = {}) => {
    const res = await app.inject({ method, url,
      headers: { authorization: `Bearer ${token}`, ...(extra.headers ?? {}) },
      ...(extra.payload === undefined ? {} : { payload: extra.payload }) });
    return { status: res.statusCode, body: res.body };
  };

  const listed = await call('GET', '/api/v1/admin/accounts', adminToken);
  const accounts = JSON.parse(listed.body).data.items;
  console.log('1) GET /admin/accounts        →', listed.status, 'account ids:', accounts.map((a) => a.id));
  console.log('2) 真实认证用户 id            →', user.id, '（是否在后台列表：', accounts.some((a) => a.id === user.id), '）');
  const s1 = await call('POST', `/api/v1/admin/accounts/${user.id}/suspend`, adminToken,
    { headers: { 'content-type': 'application/json', 'idempotency-key': 'probe-suspend-real-0001', 'if-match': '"1"' },
      payload: { reason: 'synthetic probe' } });
  console.log('3) suspend(真实认证用户)      →', s1.status, s1.body);
  const s2 = await call('GET', '/api/v1/auth/session', userToken);
  console.log('4) 停用后 GET /auth/session   →', s2.status, s2.body);
  console.log('5) 认证存储里的用户状态        →', JSON.stringify(await auth.getUser(user.id)));
  await app.close();
  ```

- **真实原始输出（exit 0）**：

  ```
  1) GET /admin/accounts        → 200 seeded account ids: []
  2) 真实认证用户 id            → 84db03cb-0fea-455a-9dce-1659c1c44268 （是否出现在后台账号列表： false ）
  3) suspend(真实认证用户)      → 404 {"error":{"code":"NOT_FOUND","message":"账号不存在","retryable":false,"details":[]}, ...}
  4) suspend(后台种子账号)      → 无账号可停用（列表为空）
  5) 停用后 GET /auth/session   → 200 {"data":{"audience":"user","expires_at":"2026-10-14T17:26:01.281Z","scopes":["user"],"revision":1}, ...}
  6) 认证存储里的用户状态        → {"id":"84db03cb-…","state":"active","authEpoch":1,"revision":1}
  ```

- **影响范围与模式边界**：仅 `stub` / `preset_demo`（`real` 下后台域**整体 fail-closed**：34 条后台路由一律 503）。
- **定性（重要，不得误读）**：**这不是"越权/放行"** —— 它是**能力脱钩**，方向是**更保守**
  （真实账号根本无法被该接口停用）。本片**不**把它当作安全越权证据。
- **但它确实是一处口径不一致**（这才是值得登记的实质）：同一个装配里，**未接线的** `jobPort` / 社区端口
  按仓库自述原则返回 **503**（`app.ts` 原文："**不返回空页**：空页等于宣称「平台当前没有作业」，
  那是无法确认的结论"）；而**同样未接线的** `listAdminUsers` 却返回 **200 + 空页**，等于宣称
  "平台当前没有账号"。**同一条原则在两个面上取了相反口径。**
- **建议归属**：后台接线线（#18）。**最小修方向（二选一）**：① 把后台账号权威接到认证存储
  （`users.state` + `auth_epoch` 单一来源，`suspend` 与认证同源更新）；② 无权威时按既有原则
  **fail-closed 503**，而不是返回空页 + 404。
- **本片声明**：**未修**；**未**为其写"期望拒绝"的用例（那会红）；**未**改任何断言或跳过用例来掩盖。

### 5.2 同一错误码 `PROVIDER_UNAVAILABLE` 的 `retryable` 跨域不一致（次要，非安全越权）

- **现象**：`real` 未接真实依赖时，四域返回同一错误码 `PROVIDER_UNAVAILABLE`(503)，但 `retryable` 不同 ——
  `POST /recognitions` **true**、`POST /speech/synthesis` **true**、**`POST /ocr` false**、**`POST /speech/transcriptions` false**。
- **原始输出**（由用例打印的同形性失败信息得到，实测四份封套）：

  ```
  {"error":{"code":"PROVIDER_UNAVAILABLE","message":"合成：真实识别供应商未接入（fail-closed）","retryable":true, ...}}
  {"error":{"code":"PROVIDER_UNAVAILABLE","message":"缺少真实 OCR 供应商凭据（fail-closed，不回退替身）","retryable":false, ...}}
  {"error":{"code":"PROVIDER_UNAVAILABLE","message":"合成：真实 ASR 供应商未接入（fail-closed）","retryable":false, ...}}
  {"error":{"code":"PROVIDER_UNAVAILABLE","message":"合成：真实 TTS 供应商未接入（fail-closed）","retryable":true, ...}}
  ```

- **判据**：契约（`packages/contracts/states.json` → `error_status_map`）只约束「错误码 → HTTP 状态」，
  两者都**不违约**；但**同码不同可重试性**属跨域口径不一致，客户端可能因此**不重试**一次瞬时不可用。
- **处置**：**未修**、**未改实现**。用例把现状**显式钉住**（`assert.deepEqual(retryableByFace, {...})`），
  使任何一方将来改动都必须是有意为之，而不是无声漂移。**建议归属**：由维护者统一
  `PROVIDER_UNAVAILABLE` 的可重试性口径（或明确区分"缺凭据"与"临时不可用"两类原因码）。

### 5.3 `PROVIDER_UNAVAILABLE` 的 `message` 含"供应商/凭据"字样（**非**泄露，已核对）

四域在 `real` 下都把"未接真实依赖"的原因写进 `message`。已核对：**不含**频道/端点/密钥/账号等敏感原文，
只描述"未接入/缺凭据"。**不构成缺陷**，此处仅记录已核。

---

## 6 跑过的检查清单（命令 + 退出码 + 关键输出）

| 检查 | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 仓库 lint（tsc ×2 + 卫生扫描） | `npm run lint` | 0 | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描` |
| 文档校验 | `npm run test:docs` | 0 | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| 本片三个新文件（合并一条命令） | `node --test tests/unit/gy-i22-*.test.mjs` | 0 | `ℹ tests 21 / ℹ pass 21 / ℹ fail 0 / ℹ skipped 0` |
| CI 门（`unit-tests` job 的同一命令） | `npm run test:unit` | 0 | 见 §6.1 |
| 空白错误检查 | `git diff --check` | 0 | 无输出（仅 Git 的 LF→CRLF 提示，非空白错误） |
| 契约类未被改动 | `git diff --stat upstream/main...HEAD -- packages/contracts` | 0 | **空**（0 字节） |
| 工作树整洁 | `git status --porcelain` | 0 | 仅本片 3 个新增测试文件 + 本证据页 |

### 6.1 `npm run test:unit`（`engineering-shell.yml` 的 `unit-tests` job 逐步同命令）

```
> gengyun@0.0.0 test:unit
> node --test "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs" "tests/media/*.test.mjs" "tests/reference/*.test.mjs"
ℹ tests 1983
ℹ suites 0
ℹ pass 1982
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 31273.1099
test:unit-exit=0
```

- 含本片新增 **21** 条（1983 总数里包含它们）；**退出码 0**。
- **`skipped 1` 是既有跳过，不是本片**：来源为 `tests/unit/knowledge-api.test.mjs` 的
  `native separate-connection withdrawal and account state changes at guarded read boundary`（`{skip: !f.native}`，需原生 PG）。
  单跑该文件可复核：`node --test tests/unit/knowledge-api.test.mjs` → `ℹ tests 10 / pass 9 / skipped 1`，输出行含 `# SKIP`。
  本片三个文件**不含任何** `test.skip` / `{ skip: ... }`（已在仓库内检索确认无匹配）。
- 该命令在 `engineering-shell.yml` 的 `unit-tests` job 内原样执行 ⇒ 本片用例**在 CI 会跑**。

---

## 7 未取得 / 未验证项（如实列出）

1. **真实供应商：零调用**。全部场景使用替身/可控测试提供者；`real` 模式未接真实依赖时按 **fail-closed** 处理（一致 503）。
   本片**没有**也没有权限发起任何付费或真实第三方调用。
2. **多 PostgreSQL 实库**：**未跑**。`app.ts` 只在连接池可用时装配持久外发账本；本片所有场景**不传连接池**，
   因此组合应用侧**没有**"账本零新增"的可证伪证据（见 §2.2 边界说明）。
   PG 侧证据**引用既有**：`tests/integration/auth-privacy-pg.mjs`、`consent-grant-pg.mjs`（由各自 workflow 运行），本片**不重跑**。
3. **真机 / 微信开发者工具 / 多机型字体矩阵**：**未跑**，属 **#23**，不在本片。
4. **部署、域名、网关、CDN**：**未做**。
5. **`tests/moderation/**`**：**未执行**（原文括注"不在任何 CI glob"**已证伪**，见 §0.1；"本片未执行"仍成立）。本片未改动审核域，也未引用其结论。
6. **`real` 模式下 4 个 AI 受理面的真实外发链路**：**未验证**（未接真实供应商 ⇒ 按设计 fail-closed）。
   即"撤回后不再外发"在 `real` 下**只验证到 fail-closed 边界**；真实传输接入后的行为属后续接线验收。
7. **新增"取消后同对象同版本冷静期"**：**未做**（新造业务语义，见 §2.3 说明），留待裁定。
8. **§5.1 / §5.2 两个发现**：**未修**，仅登记披露。

---

## 8 逐处披露与回退（本片对既有文件的改动 = **零**）

- **生产代码（`services/api/**`、`apps/**`、`miniprogram/**`、`packages/**`）：本片改动 = 0 字节。**
  4 处变异自证（§4.1–§4.4）均为**临时**改动，且**全部已用 `git checkout --` 完整回退**，
  回退后 `git status --porcelain` 只剩本片新增文件。
- `packages/contracts/**`：**0 字节**改动（约束遵守）。
- 既有测试文件：**0 字节**改动（只新增 3 个文件；无修改、无跳过、无放宽断言）。
- **唯一**对已存在文件的改动：本证据页（新增）+ 本片自己的 `tests/unit/gy-i22-consent-withdrawal-inflight-http.test.mjs`
  追加了第 5 个受控写面的用例（**追加式**，`+48 / -1`，净新增；回退 = 删除该用例块与 `selection()` 助手）。

## 9 结论（供监工/指挥裁定）

- 本片在**真实组合应用**上补齐了 issue #22 要求的"**单模块通过、整体越权/放行**"类失败回归：
  **21 条**用例、**4 处**变异自证（每处都确认真能红、且已完整回退）、**2 处**跨模块真实越权被矩阵捕获
  （§4.1 漏挂守卫、§4.3 漏挂授权）。
- **未**放宽权限 / 隐私 / 用药安全任何门槛；**未**改实现语义；**未**改断言或跳过用例。
- **如实登记但未修**：§5.1（管理端账号面与认证权威脱钩 —— **订正后定性为口径不一致 / 能力脱钩，不是越权**）、
  §5.2（同一错误码 `PROVIDER_UNAVAILABLE` 的可重试性跨域不一致）。
- **副作用提示（供指挥/监工知悉）**：本证据页位于 `docs/verification/**`，按 `access-verification.yml` 的
  `paths` 过滤器**会触发该 workflow**（它运行账号/实时守卫类测试，设计为无凭据也可通过，且本片未新增其触发文件）。
  该 workflow 与本片用例无关，但 PR 上会多一个检查项，属预期行为。
- `Refs #22`；**不关闭整项**（还有 `real` 真实传输接线、真机 #23、以及 §5 的裁定）。
