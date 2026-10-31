# GY-I22（#22）关闭材料：§5.1 复核与三条验收逐条证据（2026-10-18）

> **本页不构成关闭声明。** 本页只做两件事：①在**当前基线**上复核旧证据页 §5.1 的两个动作**今天到底是什么行为**；
> ②对 #22 三条验收逐条给「证据路径＋符号锚＋复现命令＋判定」。是否关闭 #22、以及缺陷"严重"与否的**定级权在监工**，
> 本页不代判、不写"缺陷已修复"之外未经实测的结论。

- **基线**：`5250520cdb4ceff9da4ef04e39d6aefecf621e32`（`git rev-parse upstream/main` 开工实测；`git log -1 --oneline` 逐字
  `5250520 docs(GY-I24): 部署备份恢复材料索引与跨平台离线门禁 (Refs #24) (#283)`）。基线未前进，未触发停手条件。
- **实测日期/环境**：2026-10-18（本机 CST）；Windows；Node `v24.16.0`；隔离 PostgreSQL **17.11**（`.pg17\pgsql\bin`）。
- **本页改动范围**：只新增本文件。`services/**`、`packages/**`、`tests/**`、`tools/**`、旧证据页
  `docs/verification/gy-i22-cross-module-security-e2e-20261027.md` **改动 0 字节**（`git status --short` 收工 0 行，见 §7）。

## 0 旧页 §5.1 原文摘录（逐字，限必要片段）

`docs/verification/gy-i22-cross-module-security-e2e-20261027.md:335-337`：

> - **现象（实测）**：`GET /api/v1/admin/accounts` 返回 **200 且 `items: []`**（出厂装配下**没有任何账号**）；
>   真实认证用户的 id **不在**该投影里；`POST /api/v1/admin/accounts/{真实认证用户 id}/suspend` ⇒ **404 `NOT_FOUND`**；
>   此后该用户的 `GET /api/v1/auth/session` **仍为 200**，认证存储里仍是 `{"state":"active","authEpoch":1}`。

该页写于旧基线；此后 main 并入 `204790b feat(GY-I22): 账号停用权威校验（迁移 0017）与真库证据读数分档 (Refs #22) (#271)`。
**§2 就是这三句话在 `5250520` 上的重新实测**。

## 1 隔离 PG 17.11 的起法与两处环境偏差（如实登记）

```powershell
# 1) 初始化（数据目录落在 .pg17\tmp\i22closure\pgdata）
.pg17\pgsql\bin\initdb.exe -D .pg17\tmp\i22closure\pgdata -U postgres -A trust --encoding=UTF8 --locale=C
# 2) 起集群（长驻）
.pg17\pgsql\bin\pg_ctl.exe -D .pg17\tmp\i22closure\pgdata -l .pg17\tmp\i22closure\server.log `
  -o "-p 58760 -c listen_addresses=127.0.0.1" -w start
# 3) 建硬钉库（脚本要求空库）
.pg17\pgsql\bin\createdb.exe -h 127.0.0.1 -p 58760 -U postgres gengyun_suspend_test
```

- **偏差一（端口）**：先按常识取 `55490`，`postgres` 起不来：`could not bind IPv4 address "127.0.0.1": Permission denied`
  （WSAEACCES 10013）。`netsh int ipv4 show excludedportrange protocol=tcp` 实测保留段含 **55394–55493**
  ⇒ 改 **58760**（先以 `TcpListener` 验证可绑，再起集群）。**不是代码问题，是 Windows 保留段。**
- **偏差二（监听地址）**：派单要求 `-c listen_addresses='*'`，实测 `could not bind IPv6 address "::"` 与
  `could not bind IPv4 address "0.0.0.0"` 均 `Permission denied`；改用 `127.0.0.1`。
  对读数**无影响**：`tests/integration/account-suspend-pg.mjs:53` 本身 `assert.equal(ownerUrl.hostname, '127.0.0.1', '本测试只允许回环地址')`。
- **`-A trust` 的后果（重要）**：argv[3] 的口令**不参与鉴权**。见 §6.3 的 scram 对照实测 —— 该形态**只**在本机 trust 回环集群成立。

## 2 §5.1 复核：两个动作在 `5250520` 上的真实行为

### 2.1 读数表（全部来自隔离 PG 17.11 真库；原始输出见 §5.3/§5.4）

| # | 动作（探针逐字路径） | 旧页 §5.1 断言 | **`5250520` 实测** |
|---|---|---|---|
| 1 | `GET /api/v1/admin/accounts?limit=5`（管理员 token，`accounts:read`） | 200 ＋ `items: []` | **503** `PROVIDER_UNAVAILABLE`，`retryable:false`，`message:"账号读/停用面尚未接线到认证权威"` |
| 2 | `POST /api/v1/admin/accounts/{真实认证用户 id}/suspend` | 404 `NOT_FOUND` | **200**，`data:{"state":"suspended","revision":2,"display_name":"耕云用户0AF6"}` |
| 3 | `GET /api/v1/auth/session`（**停用前**，该用户 token） | （旧页未测） | **200**，`data:{"audience":"user",…,"revision":1}` |
| 4 | `GET /api/v1/auth/session`（**停用后同一 token**） | 200 | **401** `SESSION_EXPIRED`（`retryable:false`） |

真库用例侧的**同一事实**另外取得（§5.3 逐字）：`[A] 停用 ⇒ 200，data.state=suspended，revision=2，display_name=耕云用户767E`；
`[B] 停用后同一 token ⇒ 401 SESSION_EXPIRED`；`[C] 停用后重新登录 ⇒ 403 ACCOUNT_INACTIVE`；
`[D] 恢复后重新登录 ⇒ 200；新 token ⇒ 200；**旧 token 仍 401**（未复活）`。

### 2.2 归因：**写面已由 `#271` 接权威；读面仍待 `#279` 合并**

以下符号锚全部绑定 `5250520`，**本页未改动这些文件**：

- `services/api/src/app.ts:1013-1043`（`if (adminRealUnwired)` 分支）—— real 模式后台域仍整体 fail-closed，
  但**唯一显式放行**是账号停用面；权威来源在 `:1022-1024`：
  `const realAccountAuthority = adminInjection?.accountAuthority ?? (pool === null ? null : createPostgresAccountAuthority({ pool }));`
  然后 `:1029` `adminOpsService = restrictAdminOpsToAccountsAuthority(…)`。⇒ **真实库池在，停用权威就在，与是否注入无关。**
- `services/api/src/admin/ops/accounts-only.ts:49-51` —— 放行名单只有一条：
  `listAdminUsers: reject,` / `suspendUser: inner.suspendUser,`。同文件 `:15` 注释逐字：
  「读面 `listAdminUsers` **刻意不保留**：账号读面仍按内存种子判定（`accountsWired`），real 下没有真实读后端 ⇒
  返回空页会把"本进程无权回答"说成"平台没有账号"（伪造结论）」。
- `services/api/src/admin/ops/service.ts:346-350` —— `requireWiredAccountAuthority()`：
  `throw new ApiError('PROVIDER_UNAVAILABLE', '账号读/停用面尚未接线到认证权威', { retryable: false });`
- `services/api/src/admin/ops/service.ts:352-356` —— `listAdminUsers` **先** `requireWiredAccountAuthority()` 再分页 ⇒ 读面 503。
- `services/api/db/migrations/0017_account_suspend_authority.sql`（**339 行 / 16448 B**，blob `099892fabe82f3b7e6aae8c55baf97f7fc704078`）—— 四步单事务权威：
  `public.suspend_account(uuid,uuid,uuid,integer,uuid)` / `public.restore_account(...)` + `admin_audit_events` + append-only 触发器。

⇒ **判读**：旧页 §5.1 的**三句话全部不再成立**（200 空页→503；404→200；停用后 200→401）。
其中「停用已接真实权威」是 `#271` 的成果（写面）；**「读面仍空」这一半的问题没有消失，只是换了形态**：
从「200 ＋ 空页」变成「503 ＋ 能力未接线」，方向上**更保守**，且这正是 `#279`（读面）未合并留下的缺口。
⚠️ 因此 §5.1 的**写面**可在本页判定为已接权威；**读面**必须写成「**待 `#279` 合并后复测**」，本页不预判其结果。

## 3 #22 三条验收：逐条（逐字引用审核表 → 证据 → 复现 → 判定）

审核表原文见 `.pg17/audit-issue-closure-20261018.md`（仓外本机件，从未入库，行号不可随库校验；本机实读原记 :320-330 即 `#22` 节）。

### C1（逐字）`NEEDS-FEATURE` 有限关键安全及权限用例全过，**未解决严重安全/权限缺陷 0**。

- **证据**：审核表 C1「差」栏点名的两处"未修"在 `5250520` 的现状 —— §5.1 写面已接权威（§2.2，真库真读数）；
  §5.2 四域 `retryable` 已统一（§4）。关键用例：本片三个文件 **21 通过 / 0 失败**（§5.1，exit 0）；
  真库端到端 **ALL PASS**（§5.3，exit 0，含迁移三连 / 最小权限 6 条 42501 / A–E / 失败注入回滚）。
- **复现命令**：§5.1 的 `node --test …` 与 §5.3 的两条命令（原样可跑）。
- **判定**：**可判真**（限本页取证范围）。**附注**：①"严重"的定级权在监工，本页不自行定级；
  ②本片**新登记**的是一处**取证可复现性缺口**（不是产品安全缺陷）：见 §6.1/§6.3 —— 派单原样的单参命令只得
  `PARTIAL`（exit 2），双参命令在 scram 集群直接 28P01。该缺口会削弱"别人照抄命令即得同样读数"，**建议归口径片处理，本片未修**。
- **不改断言的声明**：本页对 `tests/**` 改动 **0 字节**；`PARTIAL`（exit 2）与 `FAIL`（exit 1）都是脚本既有设计，**未为取绿改断言**。

### C2（逐字）`EVIDENCE` 实际接口状态及数据结果可核对，不能只交截图或实现同形测试。

- **证据（可核对形态）**：
  - 三个用例文件在 `5250520` 的 `git cat-file -s` 与行数：`tests/unit/gy-i22-session-inflight-cross-module.test.mjs`
    **21614 B / 425 行**、`tests/unit/gy-i22-consent-withdrawal-inflight-http.test.mjs` **22491 B / 418 行**、
    `tests/unit/gy-i22-job-inflight-guard-and-ownership.test.mjs` **17973 B / 353 行**；
    真库用例 `tests/integration/account-suspend-pg.mjs` **27634 B / 519 行**。
  - **真库读数**（不是同形测试）：真实 PG 17.11 上的迁移三连（UP/ROLLBACK/REPLAY）、最小权限反向控制
    （运行时角色 6 条直接写/读/DDL 全部 `42501`）、真实 HTTP 封套（§5.4 逐字）、并发双停用「恰好一次审计」、
    失败注入「四步整体回滚」，全部为**库侧可复核读数**。
  - **旧页边界已被部分关闭**：旧页 §7 第 2 项（`:475-476`）逐字「本片所有场景**不传连接池**，
    因此组合应用侧**没有**"账本零新增"的可证伪证据」。
    本轮 `account-suspend-pg.mjs` **传真池**，故**账号停用域**已有台账读数（§5.3 的 `[A–D] 审计台账：…accepted , …accepted`
    与 `[F] …审计 0 行`）。其他域仍按旧页原文，不在本页范围。
- **复现命令**：§5.3（两参形态）＋ §5.1（单测）。**注意**：§6.1/§6.3 的两处前置条件必须先读。
- **判定**：**可判真**。

### C3（逐字）`EVIDENCE` 任何处方混配换算、伪来源或未审内容公开均阻止发布。

- **证据路径＋符号锚**（绑定 `5250520`，本页未改）：
  - 剂量边界：`packages/reference/deterministic.mjs:511` `export function evaluateDoseBoundary(item, context = {}, opts = {})`；
    小程序侧同源实现 `miniprogram/utils/reference.js:1079`（原记 :1006） `function evaluateDoseBoundary(item, context, opts)`。
  - 公开可见性/未审内容：`services/api/src/knowledge/public-invalidation.ts:81`
    `export function decidePublicVisibility(query: PublicVisibilityQuery): PublicVisibilityDecision`；
    `services/api/src/moderation/visibility.ts:17` `export const VISIBILITY_REASON_CODES = Object.freeze([`、
    `:66 export function createReadCache(): ReadCache`、`:113 createSubstituteContentAuthority`、`:184 createUnwiredContentAuthority`。
  - 三域拒绝回归（含语音轮与用量卡注入正例）已在 main：`08e3dac test(GY-I22): 三域拒绝回归成对断言（含语音轮与用量卡注入正例） (#267)`。
- **复现命令**（本轮**未重跑**该域，理由：不在本片必跑清单；只给命令，供监工复核）：
  ```bash
  node --test tests/reference/i08-dose-guard-negatives.test.mjs tests/reference/i08-dose-empty-vacuous-guard.test.mjs
  ```
- **判定**：**可判真（沿用既有代码锚，未在本轮重跑该域用例）** —— 本页不把"未重跑"写成"已通过"。

## 4 §5.2 现状：`retryable` 跨域不一致是否仍存在

- 旧页 §5.2 断言：四域同码 `PROVIDER_UNAVAILABLE`(503) 但 `retryable` 不同 —— 识别 **true**、合成 **true**、OCR **false**、ASR **false**。
- **`5250520` 现状：该处不一致已不存在。** 用例把它从"钉住现状"改成"钉住统一口径"：
  `tests/unit/gy-i22-consent-withdrawal-inflight-http.test.mjs:388-410` 逐域断言
  `result.body.error.retryable === false`，并 `assert.deepEqual(retryableByFace, { '识别受理 POST /recognitions': false,
  '图文受理 POST /ocr': false, '转写受理 POST /speech/transcriptions': false, '合成受理 POST /speech/synthesis': false })`；
  同文件 `:383-387` 注释逐字「跨域观察（**口径已统一，此前不一致**）… 统一前识别/合成标 `true`、OCR/ASR 标 `false`」。
  本轮该用例通过（§5.1 逐字 `✔ 跨模块·real 未接真实依赖：4 个真实受理面一致 503 PROVIDER_UNAVAILABLE(retryable)…`）。
  收敛提交：`1cb6c9e fix(GY-I22): 合成域缺真实 TTS 凭据的 503 改 retryable=false（Refs #22） (#255)`。
- **残余形态（语义不同类，不属旧页所指那处）**：仍标 `retryable: true` 的 `PROVIDER_UNAVAILABLE` 只剩"依赖**瞬时**不可用"类 ——
  `services/api/src/db/catalog.ts:25`、`:44`（资料/登记资料数据库暂不可用）、
  `services/api/src/conversations/store-pg.ts:62`、`:65`（`PROVIDER_TIMEOUT` / 问答数据库暂不可用）、
  `services/api/src/auth/wechat.ts:100`（微信登录服务不可用）。这些是"等一会儿可能就好"，与"能力未装配"不同类；
  本页**只登记行号，不做口径裁定**。
- **与开放 PR `#256`（`fix/gy-i22-retryable-sweep-residual`）的关系**：**待其合并后复测**。本页不预判其内容或结果。

## 5 本轮实测读数（原始输出，逐字）

### 5.1 三个 gy-i22 用例（`node --test`，exit **0**）

```text
$ node --test tests/unit/gy-i22-session-inflight-cross-module.test.mjs tests/unit/gy-i22-consent-withdrawal-inflight-http.test.mjs tests/unit/gy-i22-job-inflight-guard-and-ownership.test.mjs
✔ 跨模块·授权：未授予任何用途 ⇒ 4 个真实 AI 受理面一致 403 CONSENT_REQUIRED，且封套逐字节同形 (236.8952ms)
✔ 跨模块·授权：缺 media_processing ⇒ 三个媒体面都被拒，只要求 external_inference 的合成面放行（按 dataType 精确判定） (105.0889ms)
✔ 跨模块·正控制：用途齐全 ⇒ 4 个真实受理面都不被授权中间件拒绝（排除整列 403 空转） (87.8294ms)
✔ 跨模块·在途撤回：撤回 external_inference 后 4 面立即一致 403 CONSENT_REQUIRED；读面不被一并关掉（GET 仍非 403） (138.4148ms)
✔ 跨模块·账号在途变化：隐私侧账号待删除/auth_epoch 前进 ⇒ 4 面一致 403 ACCOUNT_INACTIVE（不得只靠会话存储的旧结论放行） (104.6819ms)
✔ 跨模块·口径：游客与伪造令牌在受理面一律 401（鉴权先于授权，开关/授权状态不泄露给未鉴权调用方） (77.7845ms)
✔ 跨模块·授权：第 5 个受控写面 PATCH /recognitions/{id}/selection 未授权 403 CONSENT_REQUIRED；授权齐全后到达归属判定（404 而非 403） (89.6647ms)
✔ 跨模块·real 未接真实依赖：4 个真实受理面一致 503 PROVIDER_UNAVAILABLE(retryable)，且业务提供者零调用（零外发） (86.7654ms)
✔ F1·在途守卫：取消后在途提供者的晚到成功结果不得复活作业、不得写入识别记录（域 store 零写入） (245.7127ms)
✔ F2·取消幂等：同键同 If-Match 原样重试回放已取消结果；同键异体 ⇒ 409 IDEMPOTENCY_CONFLICT (92.3667ms)
✔ F3·跨用户归属：他人作业/识别记录的读、取消、改选一律同形 404，且归属者对象状态不变 (102.6759ms)
✔ F4·跨任务隔离：取消后同对象同版本再受理会成为**新任务**（如实登记设计行为），但旧任务的晚到结果不得写入新任务 (141.131ms)
✔ 跨模块·游客矩阵：无令牌在全部 16 个受保护面一致 401 SESSION_REQUIRED，且错误封套逐字节同形 (245.436ms)
✔ 跨模块·正控制：同一枚有效用户令牌在全部面上都不被鉴权拒绝（排除整列恒 401 的空转） (137.7694ms)
✔ 跨模块·注销：POST /auth/logout 后同一枚旧令牌在全部 16 个面一致 401 SESSION_EXPIRED（不得有任何一面留用旧会话） (113.3407ms)
✔ 跨模块·会话撤销幂等且不可复活：旧令牌重放注销请求本身也必须 401（不得重放旧 Ack） (148.7631ms)
✔ 跨模块·账号版本前进：auth_epoch 前进后旧令牌在全部 16 个面一致 403 ACCOUNT_INACTIVE (88.0087ms)
✔ 跨模块·账号停用：state=suspended 后旧令牌在全部 16 个面一致 403 ACCOUNT_INACTIVE (94.4941ms)
✔ 跨模块·过期令牌：会话绝对到期后同一枚令牌在全部 16 个面一致 401 SESSION_EXPIRED (86.9465ms)
✔ 跨模块·受众隔离：用户令牌访问全部后台面一致 403 SCOPE_DENIED，后台令牌访问全部用户面一致 401 SESSION_EXPIRED (75.6065ms)
✔ 跨模块·后台权限在途降级：撤掉 flags:write 后旧后台令牌写面 403 SCOPE_DENIED，开关零变更，flags:read 仍可用 (59.5116ms)
ℹ tests 21
ℹ suites 0
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1858.6285
```

### 5.2 真库用例·**单参形态**（派单原样命令）⇒ exit **2**，`PARTIAL`（**不得读成通过**）

```text
$ node tests/integration/account-suspend-pg.mjs "postgres://postgres@127.0.0.1:58760/gengyun_suspend_test"
[M] 迁移清单 17 个，版本号无重复，最大号 0017
[M] UP：suspend_account / restore_account / admin_audit_events / append-only 触发器 全部出现
[M] ROLLBACK：三个对象与触发器全部消失，users/sessions 仍在（回滚不越界）
[M] REPLAY：对象与触发器再次全部出现（迁移可重放）
[P] 已按出厂区域 gy-i22-suspend-grant 授予 EXECUTE（恰好 3 条：suspend/restore/display_name）
未取得 [P] 最小权限反向控制：未提供运行时角色 URL（argv[3]）
未取得 [A][B][C][D] HTTP 手臂：未提供运行时角色 URL（argv[3]），无法以最小权限跑真实 HTTP
未取得 [E][F] 并发与失败注入：未提供运行时角色 URL（argv[3]）
[S] 90-assert-least-privilege.sql 含 psql 元命令 ⇒ 由 `psql -f` 单独执行（本脚本不代跑）
清理：删除本脚本新建的 7 个角色（gengyun_auth_privacy,gengyun_preview_reader,gengyun_evidence_reader,gengyun_consent_granter,gengyun_profile_runtime,gengyun_knowledge_runtime,gengyun_api_runtime）
PARTIAL：未取得真库读数 —— 未提供运行时角色 URL（argv[3]），仅库侧 [M] 为真；[P]/[A]–[F] 未取得
未取得项：未取得 [P] 最小权限反向控制：未提供运行时角色 URL（argv[3]）
未取得项：未取得 [A][B][C][D] HTTP 手臂：未提供运行时角色 URL（argv[3]），无法以最小权限跑真实 HTTP
未取得项：未取得 [E][F] 并发与失败注入：未提供运行时角色 URL（argv[3]）
```

### 5.3 真库用例·**双参形态**（trust 回环集群）⇒ exit **0**，`ALL PASS`

```text
$ node tests/integration/account-suspend-pg.mjs \
    "postgres://postgres@127.0.0.1:58760/gengyun_suspend_test" \
    "postgres://gengyun_api_runtime:local-trust-loopback@127.0.0.1:58760/gengyun_suspend_test"
[M] 迁移清单 17 个，版本号无重复，最大号 0017
[M] UP：suspend_account / restore_account / admin_audit_events / append-only 触发器 全部出现
[M] ROLLBACK：三个对象与触发器全部消失，users/sessions 仍在（回滚不越界）
[M] REPLAY：对象与触发器再次全部出现（迁移可重放）
[P] 已按出厂区域 gy-i22-suspend-grant 授予 EXECUTE（恰好 3 条：suspend/restore/display_name）
[P] 运行时角色 6 条直接写入/读取/DDL 全部 42501（users.state/auth_epoch/revision、审计台账读写、DDL）
[A] 停用前用户 token 调 /auth/session ⇒ 200
[A] 停用 ⇒ 200，data.state=suspended，revision=2，display_name=耕云用户767E
[B] 停用后同一 token ⇒ 401 SESSION_EXPIRED（用户会话已过期或已失效）
[C] 停用后重新登录 ⇒ 403 ACCOUNT_INACTIVE（账号不可用）
[D] 恢复 ⇒ state=active，auth_epoch=3，revoked_sessions=0
[D] 恢复后重新登录 ⇒ 200；新 token ⇒ 200；**旧 token 仍 401**（未复活）
[A–D] 审计台账：account.suspend/account_suspended/accepted , account.restore/account_restored/accepted
[E] 并发双停用 ⇒ changed=false/true，auth_epoch 1→2（恰好 +1），审计恰好 1 行
[F] 第 4 步（写审计，23505）失败 ⇒ PROVIDER_UNAVAILABLE；state/auth_epoch/revision 逐字未变 {"state":"active","auth_epoch":"1","revision":1}；已撤会话 0→0；审计 0 行
[S] 90-assert-least-privilege.sql 含 psql 元命令 ⇒ 由 `psql -f` 单独执行（本脚本不代跑）
清理：删除本脚本新建的 7 个角色（gengyun_auth_privacy,gengyun_preview_reader,gengyun_evidence_reader,gengyun_consent_granter,gengyun_profile_runtime,gengyun_knowledge_runtime,gengyun_api_runtime）
ALL PASS：迁移三连 / 最小权限 / A–E / 失败注入 全部取得真库读数
```

### 5.4 §5.1 探针（真实 HTTP 封套；脚本为**仓外临时脚本**，按约定不提交）

探针形态与出厂测试同构：`buildApp({ config: loadConfig({ APP_EXECUTION_MODE:'stub' })…, pool, adminInjection:{ accountAuthority: createPostgresAccountAuthority({ pool }) } })`，
真实 PG 池 + 真实账号权威。退出码 **0**，逐字：

```text
GET /api/v1/auth/session（停用前，用户 token）⇒ 200 {"data":{"audience":"user","expires_at":"2026-10-18T08:33:57.631Z","scopes":["user"],"revision":1},"meta":{"request_id":"acd9ff7e-…","contract_version":"1.0.0","execution_mode":"stub"}}
GET /api/v1/admin/accounts（管理员 token，accounts:read）⇒ 503 {"error":{"code":"PROVIDER_UNAVAILABLE","message":"账号读/停用面尚未接线到认证权威","retryable":false,"details":[]},"meta":{"request_id":"9d6230e7-…","contract_version":"1.0.0","execution_mode":"stub"}}
POST /api/v1/admin/accounts/{id}/suspend ⇒ 200 {"data":{"id":"e895d311-f378-4cf9-8b01-6b21c7d17278","revision":2,"state":"suspended","display_name":"耕云用户0AF6"},"meta":{"request_id":"6951ffc0-…","contract_version":"1.0.0","execution_mode":"stub"}}
GET /api/v1/auth/session（停用后，同一 token）⇒ 401 {"error":{"code":"SESSION_EXPIRED","message":"用户会话已过期或已失效","retryable":false,"details":[]},"meta":{"request_id":"9c1ad885-…","contract_version":"1.0.0","execution_mode":"stub"}}
GET /api/v1/admin/accounts（未注入 authority 的独立实例）⇒ 503 {"error":{"code":"PROVIDER_UNAVAILABLE","message":"账号读/停用面尚未接线到认证权威","retryable":false,"details":[]},"meta":{"request_id":"533facdb-…","contract_version":"1.0.0","execution_mode":"stub"}}
```

### 5.5 门禁（串行，持 `.pg17\tmp\hq\gate.lock` 目录锁；一次只跑一条）

```text
$ node tools/verify-contract-status.mjs                ⇒ exit 0
PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
PASS: 语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段（不可核不计入通过）
PASS: 中文表格一致
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。
```

```text
$ npm run lint                                        ⇒ exit 0
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
```

```text
$ npm run test:docs                                   ⇒ exit 0
> node tools/run-python.mjs tools/validate_development_docs.py && node tools/verify-research-records.mjs
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
PASS 2026-10-18-contract-evidence-gate.md
PASS 2026-10-18-evaluation-readout-structured.md
PASS 2026-10-18-research-records-gate.md
PASS 2026-10-18-stack-reuse-decision.md
PASS gy-i03-label-evidence-increment-20261011.json（legacy 已钉住）
PASS gy-i03-label-evidence-increment-20261011.md（legacy 已钉住）
PASS gy-i03-public-label-index-20261011.json（legacy 已钉住）
PASS gy-i03-public-source-audit-20261011.md（legacy 已钉住）
研究记录校验：4 通过 / 0 失败 / 4 legacy 已钉住
PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住
```

```text
$ git diff --check                                    ⇒ exit 0，无输出（无空白错误）
$ git diff --check upstream/main                      ⇒ exit 0，无输出（新增文件亦无行尾空白/制表符）
$ git merge-tree --write-tree upstream/main HEAD       ⇒ exit 0，输出仅一行合并树 oid，无 CONFLICT 段
```

> 说明：上述三条 git 检查在**待提交树**与**提交后**各执行一次，结论相同（`git add -A` 后 `git diff --check --cached` 亦 exit 0）；
> 本页嵌入的读数为写入本页之后的最后一次执行结果，避免"读数随正文改动而失效"。

### 5.6 停集群与端口归零

```text
$ .pg17\pgsql\bin\pg_ctl.exe -D .pg17\tmp\i22closure\pgdata -m fast -w stop
waiting for server to shut down..... done
server stopped                                                     ⇒ exit 0
$ @(Get-NetTCPConnection -LocalPort 58760 -State Listen).Count       ⇒ 0
$ @(Get-Process postgres).Count                                      ⇒ 0（无残留后端进程）
```

## 6 未取得 / 未验证项（如实列出）

1. **单参形态下的 `[P]`/`[A]`–`[F]` 未取得**：派单原样命令只跑出库侧 `[M]`，脚本按设计打印 `PARTIAL` 并 exit 2（§5.2 逐字）。
   §2 的写面读数**不来自**这条命令，而来自 §5.3 双参形态与 §5.4 探针。
2. **`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的整体 verdict 未取得**：该文件含 psql 元命令，
   脚本自述「由 `psql -f` 单独执行（本脚本不代跑）」（`tests/integration/account-suspend-pg.mjs:442` 附近同类口径），
   本轮**未跑** `psql -f`，故无该文件 `verdict` 读数。最小权限结论只来自脚本内 6 条 42501 反向控制。
3. **scram 集群下双参形态不可用（实测，非推断；本轮按对抗性审查订正为两个变体）**：同一隔离集群上把
   `pg_hba.conf` **首行插入**一条 scram 规则再 `pg_ctl reload`，两种钉法的**首条错误不同**——以下均为
   2026-10-18 本人复跑的原始输出（同一 `gengyun_suspend_test`；改 hba **之前**先用 trust 连接重建空库，
   避免 `dropdb`/`createdb` 在 scram 规则下等口令输入）：

   - **变体 A（规则钉到全体回环）**：首行 `host all all 127.0.0.1/32 scram-sha-256`
     ⇒ `node tests/integration/account-suspend-pg.mjs <owner> <runtime>` **exit 1**，首个错误发生在
     **owner 连接**上，`[M]` 一行都还没打印（日志 23 行，全部是错误栈与 PowerShell 的
     `NativeCommandError` 包装，无任何 `[M]`/`[P]` 行）：
     ```
     Error: SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string
         at Object.continueSession (...\node_modules\pg\lib\crypto\sasl.js:67:11)
     ```
     （`[M]` 在 `Client.connect` 之后才打印，故该变体**连库侧读数都取不到**。上一行栈帧里的 `sasl.js` 属本机 `node_modules/pg` 的第三方运行时文件，不是仓内锚点，故保留报文原样、不按仓内行号锚点核对。）
   - **变体 B（规则钉到运行时角色）**：首行 `host all gengyun_api_runtime 127.0.0.1/32 scram-sha-256`
     ⇒ 同一命令 **exit 1**；owner 走 trust 正常，`[M]` 四行与 `[P]` 一行照常打印，随后首个错误逐字：
     ```
     首个失败读数：password authentication failed for user "gengyun_api_runtime"
     FAIL：有运行时 URL 但读数未全部通过 —— 首个失败：password authentication failed for user "gengyun_api_runtime"
     ```
     （`code: '28P01'`、`routine: 'auth_failed'`。）
   - **订正声明**：初版 §6.3 把「`host all all …` 变体」与上述 28P01 两行写在一起 ——**该 28P01 只在变体 B 成立**；
     变体 A 根本取不到这两行（owner 先被 SASL 拦下）。两变体的共同机制不变：
     `tests/integration/account-suspend-pg.mjs:167`
     `CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${randomBytes(24).toString('hex')}'`
     —— 口令**运行时随机生成且不回显**，argv[3] 的口令只可能在 `trust` 集群上"对得上"。
     **本页不据此断言任何产品缺陷**，只登记「该用例的可复现性依赖 trust 回环集群」（建议归口径片）。
4. **`#279`（`feat/gy-i18-admin-accounts-read`）未合并 ⇒ 读面的真实可用读数未取得**：本页只有"503 未接线"的读数，
   没有"读面已接线后的真实分页读数"。**待 `#279` 合并后复测。**
5. **`#256`（`fix/gy-i22-retryable-sweep-residual`）未合并 ⇒ 残余扫尾未复测**（§4）。
6. **real 模式端到端未取得**：本轮 HTTP 读数为 `stub` 装配 + 真实库池/真实权威（与出厂用例同构）；
   `real` 模式下 `services/api/src/app.ts:1013-1043` 的装配只做了**代码读数**，未起真实微信/真实前端联调。
7. **`-c listen_addresses='*'` 未取得**：本机沙箱/保留段下 `0.0.0.0`/`::` bind 被拒（§1），只跑通 `127.0.0.1`。

## 7 本页改动与收工核对

- 改动文件：**仅** `docs/verification/gy-i22-closure-gap-20261018.md`（新增）。
  `git diff --stat upstream/main` 对 `services/**`、`packages/**`、`tests/**`、`tools/**` 与旧证据页均为**空**。
- 复现命令（本页全部读数）：§5.1–§5.6 各命令块；临时物只在 `.pg17\tmp\i22closure\`。
- `git diff --check`（工作树 / `upstream/main` 两点 / 三点）与 `git merge-tree --write-tree upstream/main HEAD` 读数见 §5.5；
  收工 `git status --short` **0 行**；集群已停、58760 监听归零（§5.6）。
- **本轮订正（按对抗性审查 2 条必改；只改文字，不动结论方向与证据链）**：
  ① §2.2 `services/api/db/migrations/0017_account_suspend_authority.sql` 行数 `311` → **`339`**。
  错因实测：`git cat-file blob 5250520:<path> | Measure-Object -Line` **只数非空行**（总 339 / 非空 311 / 空行 28）；
  已改用逐字节 `ReadAllLines` 口径，并同时钉 blob `099892fabe82f3b7e6aae8c55baf97f7fc704078` / 16448 B。
  ② §6.3 scram 步骤拆成**变体 A（`host all all`）/ 变体 B（钉到 `gengyun_api_runtime`）**并各自复跑贴首条错误，
  明确「初版所记 `28P01` 只在变体 B 成立」（见 §6.3 订正声明）。
