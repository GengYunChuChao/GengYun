# #15 消息域链路盘点与必要接线（D4）取证页

- 日期：2026-10-21（本地时区 Asia/Hong_Kong）
- 分支：`feat/gy-r28-d4-messages-chain`，基点 `origin/main = 7d1a429`；**已合流 `origin/main = 167fd45`（#396 D1 登录归因统一层）**，合并提交 `8af9ebd`
- 覆盖 issue：#15（GY-I15 社区，消息事件投递侧）、#17（GY-I17 应用内消息/未读/权限跳转）、#28（GY-I26 五 Tab 与统一失败状态 B7）
- 本页工作方式：静态证据（`文件:行`）+ **真跑**单测/负控制；**未起真 PG**，故本页不含真库读数
- 本片改动面：`miniprogram/` 三文件（客户端消息链路）+ 三个测试文件 + 本页；服务端、契约、迁移、CI、`deploy/**` **一字未改**
- 体例偏差（如实登记）：派单指定的同族体例 `docs/verification/gy-r28-c5-favorites-history-20261021.md` 在**本基点不存在**（`Get-ChildItem docs/verification -Filter '*c5*'` 零命中），本页改按既有 `docs/verification/gy-r28-*-20261021.md` 体例撰写

---

## 1. 一屏结论

| # | 段 | 改前 | 改后 | 依据 |
| --- | --- | --- | --- | --- |
| a | 会话列表与未读数 | **通**（读面 + 派生未读数 + 角标）；**半通**在并发：先发后到的旧读数覆盖新读数 | **通**：页面与角标都加世代号，只采纳最后一次发出的请求 | §3.1 |
| b | 消息分页（游标/版本语义） | 服务端**通**；客户端**半通**：失效游标留成死游标，只弹 toast 不回收 | **通**：`INVALID_CURSOR` ⇒ 清游标 + 从第一页重载 | §3.2 |
| c | 发送/写路径（幂等键、失败重试、乐观态） | **半通**：重试换新幂等键（响应丢失后必然 409）；409 后不重同步 | **通**：同 `(id, revision)` 复用同键、成功即释放；409 后重读列表 | §3.3 |
| d | 单条删除 / 会话删除 | **契约未通**（契约无任何 DELETE operation） | **仍未通**（本片不实现，理由见 §3.4） | §3.4 |
| e | 401/403 折叠 + B7 接入 | **未通**：403 被折叠成「请重新登录」，B7 的 denied 分支不可达，`SCOPE_DENIED` 文案是死字符串 | **通**：归因委托 `auth.attribution`（#396 统一层，本片自建实现已删）；401 走 guest、403 按真实码走 denied，写路径 403 也整页落 denied（端到端已验） | §3.5 |

一句话：**消息域的「读」早就通了**（`tests/unit/messages-*.test.mjs` 合流后共 89 条、CLI 三端点与游标签名/水位/幂等都有用例钉住）；本片补的是**客户端链路里「失败之后不能自愈」的残留**——死游标、幂等键不复用、版本冲突不重同步、未读数并发覆盖、写路径 403 只弹 toast；401/403 的**归因**已在合流时交给 #396 统一层（本片那份自建实现已删除），本片只留本域文案与页面收口。删除段如实标成**「契约未通」**而不是假装做了。

---

## 2. 五段逐条：做与没做

### 3.1 (a) 会话列表与未读数 —— 改前「通」，并发面「半通」，已补

| 面 | 位置 | 读数 | 判定 |
| --- | --- | --- | --- |
| 路由 | `services/api/src/routes/messages.ts:43-52`（`GET /messages`）、`:53-58`（`GET /messages/unread-count`） | `preHandler: guards.requireUser`；`noStore` 挂在 `onRequest`（`:21-23`），成功与失败都带 `Cache-Control: no-store` | 通 |
| 列表 | `services/api/src/messages/service.ts:303-347` | 只列本人（`store.listMessagesByOwner`）、`(created_at DESC, id DESC)` 稳定排序 | 通 |
| 未读数 | `service.ts:350-353` → `store.ts:205-211`（内存）/ `store-pg.ts:221-230`（`count(*)`） | **派生量**：每次现算 `read_at IS NULL` 的本人行数，没有计数器列 ⇒ 无漂移路径 | 通 |
| 页面 | `miniprogram/pages/messages/messages.js:116-140`（`reload`）、`:184-198`（`refreshUnread`）、`:199-204`（`_applyUnread`） | 每次进入重读；取不到时**不显示数字**（不显示 0、不保留过期值） | 通 |
| 角标 | `miniprogram/custom-tab-bar/index.js:46-57` | 只读展示，`>99` ⇒ `99+`（`messages-api.js:253-257`） | 通 |
| **并发覆盖（改前缺陷）** | 改前 `messages.js` 的 `refreshUnread` 与 `custom-tab-bar/index.js:39-47` 均**无在途保护** | 进入页读取、标记单条后读取、全部已读结束读取、Tab `show` 读取会同时在飞；响应次序≠请求次序 ⇒ 先发后到的**旧**读数覆盖新读数（典型：全部已读后角标弹回旧值） | **半通 → 已补** |

补法（两处同口径）：每次刷新推进 `this._unreadEpoch`，回调只在世代未变时落地（`messages.js:186,189,193`、`custom-tab-bar/index.js:48,51,54`）。断言见 `tests/unit/miniprogram-ui-auth-integration.test.mjs`「并发读取未读数只采纳最后一次发出的结果」「未读角标（Tab 自读）：并发刷新…」，改前均为红（§5）。

### 3.2 (b) 消息分页 —— 服务端「通」，客户端「半通」，已补

**先纠字段身份**：本仓**没有** `read_version` 这个字段。`grep -R read_version packages/contracts/openapi.json miniprogram services/api tests` **零命中**。契约 `Message` 的版本字段名是 `revision`（键集恰 7 项：`id/revision/type/target_ref/reference_state/read_at/created_at`，见 `miniprogram/utils/messages-api.js:44`（`MESSAGE_FIELDS`，原记 :36）与 `services/api/src/messages/store.ts:29-45`）。游标的身份是**行身份 `(created_at, id)`**，不是任何版本字段——把「hunk 行号」或「read_version」当字段身份都会读错。

| 面 | 位置 | 读数 | 判定 |
| --- | --- | --- | --- |
| 游标载荷 | `service.ts:125-139` | `v/kind/subject/auth_epoch/watermark/route/filter/sort/after{created_at,id}/expires`；`after` 是**位置** | 通 |
| 签名/验签 | `service.ts:155`（HMAC `messages-list/v1`）、`:259-298`（逐项校验，任一不符 ⇒ 400 `INVALID_CURSOR`） | 客户端改不动、不能跨主体/跨 epoch 复用 | 通 |
| 水位为何不被「已读」打断 | `service.ts:313-314` | `watermark` 只由 `[id, created_at]` 组成；`markReadIfUnread` 只改 `read_at`/`revision`，**不改 `created_at`** ⇒ 读状态推进不会让翻页链失效（这正是 #17「读状态不改变水位」那条不变式） | 通 |
| 位置仍在集合内 | `service.ts:321-323` | 游标指向的行被删/不在了 ⇒ 400，不静默错位 | 通 |
| 同刻多条不漏不重 | `service.ts:326-333`（`created_at <` 或 `==` 且 `id <`） | 全序兜底 | 通 |
| 客户端参数面 | `messages-api.js:221-229` | 只发契约声明的 `cursor`/`limit`，`next_cursor` 原样带回 | 通 |
| **失效游标不回收（改前缺陷）** | 改前 `messages.js:155-159` | `INVALID_CURSOR` 只弹一句 toast，`nextCursor` 不清、不重载 ⇒ 这条游标**永远不会再成功**（15 分钟 TTL 到期、期间有新消息改变水位、主体/`auth_epoch` 变化），用户反复点「加载更多」只会看到同一句报错 | **半通 → 已补** |

补法：`messages.js:165-170` —— 命中 `INVALID_CURSOR` 时先清 `nextCursor`，再 `reload()` 从第一页重载，并如实提示「列表已过期，已重新载入」。

### 3.3 (c) 发送 / 写路径 —— 契约无「发送」，唯一写口是标记已读；改前「半通」，已补

**先纠一个前提**：消息域**没有客户端「发送」入口，也没有 create operation**。服务端的创建口是内部方法 `appendMessage`（`service.ts:422-444`），不注册任何路由、`owner_id`/`event_key` 只由服务端调用方给出（客户端若能指定就等于允许伪造他人消息）。真实生产路径只有一条：审核域经 `createMessagesCommunityEventsPort` 投递（`services/api/src/app.ts:1040-1042`）。因此本段「发送」= **客户端唯一的写操作 `PUT /messages/{id}/read`**。

| 面 | 位置 | 读数 | 判定 |
| --- | --- | --- | --- |
| 事件去重（服务端） | `store.ts:180-188`（内存，`(owner_id,event_key)` 索引）、`store-pg.ts:144-163`（`INSERT … ON CONFLICT DO NOTHING RETURNING id`） | 重复调度只建一条，命中不重置读状态 | 通 |
| 写幂等（服务端） | `service.ts:161-207` | 先原子占位 → produce → 写回；失败释放占位（`:196`）；同键异体 409（`:174`）；等待超时 409 `REQUEST_IN_PROGRESS`（`:187`） | 通 |
| `If-Match` 语义 | `service.ts:369,383-385`、`store.ts:161-175`、`store-pg.ts:191-219` | 缺失 428、不匹配 409、不做 last-write-wins；首次读转换 `revision` 恰好 +1 | 通 |
| **重试换新幂等键（改前缺陷）** | 改前 `messages-api.js:164-166` + `:190-192` | 每次调用都 `newIdempotencyKey()`。若首发已落库但响应丢失（`NETWORK_UNCERTAIN`），重试带**旧的** `If-Match` 再打一次 ⇒ 服务端 `revision` 已 +1 ⇒ 409 `REVISION_CONFLICT`；用户看到「消息状态已更新」，事实却是**这条早就标记成功了** | **半通 → 已补** |
| **409 不重同步（改前缺陷）** | 改前 `messages.js:285-288` | 409 后只弹 toast，本地 `revision` 仍是旧的 ⇒ 后续每次点击继续 409，页面无法自愈，只能整页重进 | **半通 → 已补** |
| 乐观更新与回滚 | `messages.js:268-294`（`_markReadOne`） | **本页没有乐观更新**：只在服务端返回后改写 `revision/unread/readAt`，`markingId` 在成功（`:272`）与失败（`:291`）两路都回收。⇒ 派单里「乐观态不回收」在本域**不成立**，本片**不做假的修复**（改成先本地翻转再回滚只会更差） | 不适用（已核） |

补法两条：
1. `messages-api.js:182-219` + `:240-251`：同一 `(id, revision)` 的重试**复用**同一幂等键（窗口 5 分钟、容量 32 条，与 `service.ts:57` 的 `IDEMPOTENCY_TTL_MS` 同量级），**成功即释放**（`:247-248`；下一次标记是另一版本、另一件事，必须新键）。
2. `messages.js:306-322`（单条：403 系 `:306-314` 落 denied，409 `:315-322` 重同步）与 `:357-366`（全部已读：同样两分支，保留「标记了几条、停在哪」的原话术）。

### 3.4 (d) 单条删除 / 会话删除 —— **契约未通**（本片不实现）

| 检查 | 读数 | 结论 |
| --- | --- | --- |
| 契约 operation | `packages/contracts/openapi.json:7083`（`GET /messages`）、`:7165`（`GET /messages/unread-count`）、`:7240`（`PUT /messages/{id}/read`） | messages 只有**这 3 条**；全文件**没有任何** `DELETE` 路径或 `deleteMessages` 类 operationId ⇒ **面向用户的删除仍「契约未通」** |
| HTTP 面 | `services/api/src/routes/messages.ts`（全文 71 行） | 只有 `app.get`×2 + `app.put`×1；无 `app.delete` |
| store 原语（**合流后状态**） | `services/api/src/messages/store.ts:103-105`（`PurgeableMessagesStore`：`deleteAllByOwner`/`purgeOwnerData`）、`:290-297`（内存实现）、`store-pg.ts:414-421`（PG 真删） | **已有注销清理原语**（C1 片随 main 合入，**不是本片**）；但**未注册进注销闭集**：`services/api/src/privacy/user-data-deletion.ts:68` 的 `USER_DATA_DELETION_MODULES` 仍只有 `favorites`/`history` ⇒ B4 页的 **G1 已补、G2 仍在** |
| 客户端 | `messages.wxml`（151 行）、`messages-api.js`（导出 12 项） | 无删除入口、无 delete 方法 —— 与契约一致，**不是漏做 UI** |
| 与 #17 的关系 | `docs/verification/gy-i16-i17-deletion-cascade-20261021.md` §3/§5 的 G1/G2/G3 | 注销时点的消息清理属**另一片（C1）**；本片按派单**不碰** `PurgeableMessagesStore`/`purgeOwnerData`/`withTransaction`（合流保留 main 版，未改一行） |

判定：**(d) 面向用户的「单条删除 / 会话删除」仍是「契约未通」**。要做到它，先得契约片新增 operation（本片 `openapi.json` 只读、`contracts/**` 禁改），再定义软删/硬删、`revision` 如何推进、已删消息在分页水位里如何表现，最后才有客户端入口。**本片不写死代码、不放开 UI**，把它列进 §6（D2/D4）。
注意区分：合流带来的 `purgeOwnerData` 是**注销清理**（按主体整域删除，服务端内部），**不是**用户可见的单条删除；两者不要互相冒充。

复核（只读；第 2 条的期望已随合流变化，见上表）：

```powershell
Select-String -Path services/api/src/routes/messages.ts -Pattern 'app\.delete'          # 预期：0 命中
Select-String -Path services/api/src/messages/*.ts -Pattern 'DELETE FROM messages'      # 预期：有命中（store-pg 的注销清理原语，C1 片）
Select-String -Path services/api/src/privacy/user-data-deletion.ts -Pattern 'USER_DATA_DELETION_MODULES ='   # 预期：只有 favorites/history
Select-String -Path miniprogram/pages/messages/*,miniprogram/utils/messages-api.js -Pattern 'deleteMessage|删除'  # 预期：0 命中
```

### 3.5 (e) 401/403 折叠与 B7 —— 改前「未通」；归因已由 #396 统一层收敛，本域只消费

> **合并说明（2026-10-21 晚）**：本片第一版在 `messages-api.js` 里自建过 401/403 判定（403 码表 + 两处兜底）。
> `#396`（D1）把 401/403 归因收敛到 `miniprogram/utils/auth.js` 的 `attribution()` / `failureFor()`
> 作为**单一事实源**（码表由 `utils/states.js` 的 `CODE_KIND` 反推）。合流后本片**删掉了那份自建实现**
> 与两处已不可达的 403 兜底，只保留**本域措辞**（`MESSAGES` 的 403 三码文案，与 main 逐字同一条，不重复）。

| 面 | 位置 | 读数 |
| --- | --- | --- |
| 改前缺陷 | `miniprogram/utils/messages-api.js:123-127`（改前行号） | `if (statusCode === 401 \|\| 403) { auth.clearSession(); reject('SESSION_REQUIRED') }` |
| 后果 ① | 同上 | 403 把**会话清掉**。403 的三码（`contract.ts:17`：`SCOPE_DENIED`/`CONSENT_REQUIRED`/`ACCOUNT_INACTIVE`）都是「登录了但不给」，清完会话用户只会被反复踢去登录 |
| 后果 ② | `messages-api.js:231`（改前行号，`SCOPE_DENIED: '当前会话无权访问消息。'`） | 这行文案**永不执行**（死字符串）——403 进不到错误封套解析那一支 |
| 后果 ③ | `miniprogram/utils/states.js:150`（`denied` ⇒ `STATUS.DENIED`）、`components/state-view/state-view.js:153` | B7 的 `denied` 分支**不可达**：页面拿到的码永远是 `SESSION_REQUIRED` ⇒ 走 guest「请先登录」 |
| 服务端真的会返 403 | `services/api/src/auth/middleware.ts:88-93`（账号非 `active` / `auth_epoch` 失配 ⇒ `ACCOUNT_INACTIVE`） | 不是假想情形：注销待处理、被停用、全局登出后的旧令牌都命中这一支 |
| 统一口径（#396，**不属于本片**） | `miniprogram/utils/auth.js` 的 `attribution()`（`SESSION_LOSS_CODES` / `FORBIDDEN_CODES` / `RETIRED_SESSION_CODES`） | 401 ⇒ `SESSION_REQUIRED` + 清会话；403 ⇒ 三码原样带出，其中 **`ACCOUNT_INACTIVE` 例外：码保留 + 清会话**；403 无封套 ⇒ `SCOPE_DENIED` 且不清会话 |
| 本域改法 | `miniprogram/utils/messages-api.js:131-136`（委托 `auth.failureFor(failure, statusCode, response.data)`）；原 `:146`/`:163` 两处「403 兜底」**已删除**（委托后不可达，留着就是第二份口径） | 本模块**不再有**任何 401/403 判定分支 |
| 文案 | `messages-api.js:289-291` | 三码各有本域句子，不落「消息服务暂不可用」兜底（与 main 版逐字一致） |
| 页面收口 | `messages.js:103-113`（`_fail` 统一生成 `status/errorText/errorCode/stateTitle/stateDesc`）、`:306-314`（**写路径** 403 系 ⇒ 整页 denied，而不是一句 toast）、`:357-366`（「全部已读」同口径） | `errorCode` 透传给 `state-view` 的 `error-code`（`messages.wxml:58`）——已核对确实落在该参数上 |

端到端断言（真实页面 + 真实适配层 + 真实 `states.js` + 真实 `state-view` 组件，非替身）：
- **读路径**：`tests/unit/miniprogram-ui-auth-integration.test.mjs`「消息页：列表 403 SCOPE_DENIED ⇒ 不清会话、落 denied 态」——断言 ①`auth.isLoggedIn()` 仍 true ②`launches` 为空 ③`errorCode === 'SCOPE_DENIED'` ④`state-view` 的 `effectiveStatus === 'denied'`、`actionSuppressed === true`、`kindTag === '没有权限'`。
- **写路径**：同文件「消息页：写路径遇 403 ACCOUNT_INACTIVE ⇒ 整页落 denied（不是一句 toast 掩过去）」——断言 `status === 'error'`、`errorCode === 'ACCOUNT_INACTIVE'`、`guest === false`、会话按统一层口径被清、`state-view` 呈现 denied。
- **适配层**：`tests/unit/messages-chain-client.test.mjs`「消息域 403 ⇒ 码原样带出；SCOPE_DENIED/CONSENT_REQUIRED 不清会话，ACCOUNT_INACTIVE 按统一层清会话」——清不清会话的期望**直接读 `auth.attribution()`**，不在测试里另写一份口径（口径变了会立刻红）。

---

## 4. 改后交付（逐文件）

| 文件 | 合流后行数 | `origin/main..HEAD` +/− | 改了什么 |
| --- | --- | --- | --- |
| `miniprogram/utils/messages-api.js` | 315 | +62 −3 | **401/403 委托 `auth.failureFor`**（`:131-136`，本片自建码表与两处 403 兜底已删）；403 三码文案（`:289-291`，与 main 同条不重复）；重试幂等键复用（`:203-213`）与成功释放（`:246`）；头部纪律第 5 条改为「委托统一层」 |
| `miniprogram/pages/messages/messages.js` | 371 | +50 −9 | `_fail` 统一失败收口（`:103-113`）；`reload` 复用 `_fail`（`:137`）；`INVALID_CURSOR` 清游标 + 重载（`:165-170`）；未读数世代号（`:186,189,193`）；写路径 403 系落 denied、409 重同步（`:306-314`、`:315-322`、`:357-366`） |
| `miniprogram/custom-tab-bar/index.js` | 64 | +10 −0 | 角标刷新世代号（`:46-57`） |
| `tests/unit/messages-chain-client.test.mjs` | 259 | +259 | 新文件，13 条：401/403（清会话口径**直接读 `auth.attribution`**，不另写一份）、403 三码与 B7 归类、封套不可解析兜底、幂等键复用/隔离、请求头、分页参数、伪字段拒绝、`unreadText` |
| `tests/unit/miniprogram-ui-auth-integration.test.mjs` | 543 | +142 −0 | 新增 **6** 条页面级：列表 403 denied 端到端、写路径 403 ACCOUNT_INACTIVE 落 denied、`INVALID_CURSOR` 重载、未读数并发、Tab 角标并发、409 重同步。**既有断言一条未改**（只追加） |
| `tests/unit/miniprogram-community-api.test.mjs` | 663 | +16 −3 | **改了一条既有断言（加强，不是放宽）**：原「403 ⇒ `SESSION_REQUIRED` 且 `cleared.count === 1`」改为「403 ⇒ `SCOPE_DENIED`、`cleared.count === 0`」，并新增「403 文案不得是『登录已失效』」「401 仍必须清会话」「`ACCOUNT_INACTIVE` 码保留 + 清会话」三条。文件头口径同步订正 |
| `docs/verification/gy-i15-messages-chain-20261021.md` | 本页 | — | 证据 |

**关于那条既有断言的改动（按要求单列说明）**：`tests/unit/miniprogram-community-api.test.mjs` 的「消息：…401/403 清会话」用例把**旧缺陷写成了期望**（403 也清会话 + 折叠成 `SESSION_REQUIRED`）。合流时 main 也独立改过同一条（断言等价、措辞略简），本片按「覆盖更全、断言更强」取**本片版**并再补一条 `ACCOUNT_INACTIVE` 例外断言：403 必须透出契约真实码、`SCOPE_DENIED`/`CONSENT_REQUIRED` 必须**不**清会话、`ACCOUNT_INACTIVE` 必须清会话、文案不得谎称登录失效，同时**保留并显式化** 401 的「必须清会话」。断言从「一种状态」变成「多种状态各自成立且可区分」，没有任何一条被删除或放宽。

**没有改**：`packages/contracts/**`、`openapi.json`、`.github/workflows/**`、`services/api/db/migrations/**`、`deploy/**`、`services/api/src/messages/store*.ts`、`services/api/src/routes/messages.ts`、`services/api/src/privacy/**`、`contracts` 相关工具。用 `git status --short` 可直证（只有上面 5 个文件 + 本页 + 新测试文件）。

---

## 5. 自检（真实读数）

命令与读数（本机 PowerShell，Node v24.16.0 / npm 11.13.0；`npm install` 只跑一次：`added 103 packages`）：

```text
> npm run lint
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。

> git grep -n "^<<<<<<< \|^>>>>>>> " -- 'miniprogram/**' 'tests/**'      # 冲突标记
exit=1（0 命中）

> node --test "tests/unit/messages-*.test.mjs"        # 含新文件
ℹ tests 89   ℹ pass 89   ℹ fail 0

> node --test tests/unit/messages-chain-client.test.mjs   # 新测试单跑
ℹ tests 13   ℹ pass 13   ℹ fail 0

> node --test tests/unit/miniprogram-ui-auth-integration.test.mjs
ℹ tests 32   ℹ pass 32   ℹ fail 0

> node --test tests/unit/miniprogram-ui-auth-integration.test.mjs tests/unit/miniprogram-community-api.test.mjs
ℹ tests 56   ℹ pass 56   ℹ fail 0        # 32 + 24

> npm run test:unit        # 全量（独占运行，未与其他 Node 套件并发）
ℹ tests 3337   ℹ suites 0   ℹ pass 3336   ℹ fail 0   ℹ cancelled 0   ℹ skipped 1
ℹ todo 0       ℹ duration_ms 75515.386
exit=0

> npm run test:mini
PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.
ℹ tests 6   ℹ pass 6   ℹ fail 0   ℹ duration_ms 6107.9236

> npm run test:docs
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住
PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住
```

**负控制（证明本片剩余断言不是空转）**：把本片改过的三个源文件临时换回 **`origin/main` 版**（`git checkout origin/main -- …`），只留本片测试，再跑两个测试文件：

```text
ℹ tests 45   ℹ pass 39   ℹ fail 6
✖ markMessageRead 失败重试：同一 (id, revision) 复用同一幂等键，成功后才换新键
✖ 未读角标（Tab 自读）：并发刷新只采纳最后一次发出的结果，旧读数不得覆盖新读数
✖ 消息页：加载更多遇 INVALID_CURSOR ⇒ 清掉死游标并从第一页重载
✖ 消息页：并发读取未读数只采纳最后一次发出的结果（旧读数不得覆盖新读数）
✖ 消息页：标记已读 409 REVISION_CONFLICT ⇒ 重新读取列表，拿当前 revision 再试
✖ 消息页：写路径遇 403 ACCOUNT_INACTIVE ⇒ 整页落 denied（不是一句 toast 掩过去）
```

负控制后已把三个源文件恢复（`git status --short` 干净、`git diff --numstat origin/main..HEAD` 与 §4 一致），恢复后全绿（读数见上）。

**这里必须说清一件事**：合流后，「**读路径** 403 落 denied」那条页面断言在 `origin/main` 版代码上**也是绿的**——因为 #396 已把 `auth.failureFor` 接进 `messages-api`，而页面本来就把 `error.code` 透给 `error-code`。所以它现在是**回归护栏**（防止将来有人把 403 折回 `SESSION_REQUIRED`），不再算本片的新行为；本片在 (e) 段真正新增的行为只剩「**写路径** 403 整页落 denied」（见负控制最后一条）。这 6 条红全部是本片声称修掉的行为，没有一条靠放宽断言变绿。

### 5.1 全量 `npm run test:unit` 的两次异常（如实说明，不改断言）

| 现象 | 真实读数与归因 | 处置 |
| --- | --- | --- |
| 历史第 1 次（合流前）：`tests/unit/release-materials-index-strict.test.mjs` 报 `工具自身异常: Error: Command failed: git cat-file blob HEAD:deploy/postgres-cvm/install-postgres.sh`（该用例在 `os.tmpdir()` 里铺镜像仓再跑门禁工具） | **单跑该文件 6/6 通过**；同一次全量里其余 3248 条通过 ⇒ 判定为**并发下的抖动**（该用例在临时目录反复 `git init/commit/cat-file` 并 shell out），**本页未定位到根因**，也未改动该用例任何断言 | 单跑复核 + 独占重跑 |
| 历史第 2 次（合流前）：跑到审核域（`/jobs/{id}` 与 moderation 段）后 **~13 分钟无新输出**，runner 进程累计 CPU 733 s（热循环而非阻塞），日志停在 228 行 | 当时我**并行**跑着另外几个 Node 套件（`test:mini`、单文件测试），本机先是出现过 `VirtualAlloc failed`（内存不足导致 `test:mini` 以 V8 OOM 崩），随后出现这次长跑 ⇒ 归因为**并发资源压力**，与代码无关；终止后独占重跑 74.6 s 走完 | 终止 → 改为**串行独占**重跑 |
| 历史第 3 次（合流前最终读数） | `tests 3250 / pass 3249 / fail 0 / skipped 1 / duration_ms 74633`，`exit=0` | 采用 |
| **合流后（本页最终读数）** | `tests 3337 / pass 3336 / fail 0 / skipped 1 / duration_ms 75515`，`exit=0`；**一次跑完，未复现上述两种抖动** | 采用 |

（`npm run test:mini` 合流前首次也因同样原因报 `AssertionError: [low_level_alloc.cc : 554] … VirtualAlloc failed`；此后两次独占运行均 **6/6 通过**，读数见上。）

---

## 6. 待裁决（编号列表，本片不做）

| 编号 | 事项 | 为什么本片不做 | 建议归属 |
| --- | --- | --- | --- |
| D1 | ~~`community-api.js:163-167` 同族 403 折叠~~ **已由 #396（D1 统一层）解决**：main 的 community-api 已改 `auth.failureFor`，本片合流后消息与社区两域都走同一归因 | 无需本片再做；本片只保证消息那条既有期望被加强（见 §4）并新增 `ACCOUNT_INACTIVE` 例外断言 | 已关闭（#396） |
| D2 | 消息域注销清理：**合流后 G1 已落地**（`messages/store.ts:103-105`、`store-pg.ts:414-421` 的真删原语，C1 片）；**G2/G3 仍在**——未注册进 `USER_DATA_DELETION_MODULES`（`privacy/user-data-deletion.ts:68` 只有 favorites/history）、幂等台账按主体清理未接 | 派单明令：本片不动 C1 的 `PurgeableMessagesStore`/`purgeOwnerData`/`withTransaction`；注册属注销闭集那一侧 | C1 |
| D3 | `0019_messages_persistence.sql:24-25` 头注释宣称的「注销时消息随 `ON DELETE CASCADE` 级联」永不触发（B4 页 G4） | 迁移文件属禁改面 | 迁移/文档订正片 |
| D4 | 契约是否新增「单条删除 / 会话删除」operation（含软删/硬删、`revision` 推进、删除行在分页水位中的表现） | `openapi.json`/`contracts/**` 只读；契约先行是硬前提 | 契约片 |
| D5 | 服务端游标**不绑定 `limit`**（`service.ts:125-139` 的 `filter`/`sort` 都进了签名，`limit` 没进） | 契约未要求；客户端目前固定 20，换 `limit` 的调用方会得到页大小不同的同一条链。**判定：非缺口**，但若要"页大小可复现"则需服务端扩展 | 契约/服务端（低优先） |
| D6 | `store.getMessage(id)` 无 owner 形参，归属判定在服务层（`store-pg.ts:22-24` 注释自陈） | 改签名属停手条件；当前语义正确（非本人 ⇒ 与不存在同形 404） | 记录，不改 |
| D7 | `real` 模式下消息域现在的形态：`pool !== null` ⇒ 接 PG（`app.ts:755-762`），`pool === null` ⇒ 503 | 接线属另一片；本页只登记现状（与 B4 页 G10 的措辞已不一致，见 §7） | 记录 |
| D8 | 首版「评论/点赞」两类消息**无服务端生产路径**（`miniprogram/utils/messages-api.js:27-28` 与 `messages.wxml:148` 都如实写明） | 需社区事件端口扩产，属 #15/#17 交汇的另一片 | #15 事件投递片 |

---

## 7. 文档/行号漂移登记（只登记，本片不改）

| 位置 | 现措辞/旧读数 | 与本页读数的关系 |
| --- | --- | --- |
| 派单指定的体例页 `docs/verification/gy-r28-c5-favorites-history-20261021.md` | 派单称其为同族体例；本片开工时**在基点 7d1a429 上不存在**（零命中），合流 `167fd45` 后该文件已随 main 出现 | 本页仍是按 `gy-r28-*-20261021` 体例写的；**不重写**（重写只增加 diff，不增加证据）。此处如实记：早前「不存在」的读数是**基点事实**，不是笔误 |
| `docs/verification/gy-i16-i17-deletion-cascade-20261021.md` §3 矩阵（消息行）/ G1 | 「`messages` 一行不删、无原语」 | **合流后部分漂移**：`messages/store.ts:103-105` + `store-pg.ts:414-421` 已有 `purgeOwnerData`/`deleteAllByOwner`（C1 落地）⇒ G1 已补；**G2（未注册进闭集）仍准确**（`user-data-deletion.ts:68`） |
| 同上 §3 矩阵「HTTP 面无任何 `DELETE` 方法（`routes/messages.ts:43,53,59`）」 | 仍准确 | 该文件接口 71 行，三条路由正在 43/53/59；`app.delete` 仍 0 命中 |
| 同上 G10 与 §1 第 6 条 | 「`real` 模式注销 HTTP 面整域 503」＋「消息域 real 全文 503」的口径 | **口径已漂移**：`app.ts:752-769` 现在是 `real` 且 `pool !== null` ⇒ `createPostgresMessagesStore`（真库）；只有 `pool === null` 才 503。注销面（G10）不在本片范围，未复核 |
| `miniprogram/utils/messages-api.js` 旧行号 `:123`（403 折叠，本片第一版曾改成自建分支） | 两代旧读数 | 合流后该处**只剩一行委托**：`:131-136` 调 `auth.failureFor`；原「401 分支 / 两处 403 兜底」全部删除。引用请用 `:131-136` |
| `miniprogram/utils/messages-api.js` 旧行号 `:231`（`SCOPE_DENIED` 死字符串） | 旧读数 | 合流后文案在 `:289-291`（与 main 同条），且**已可达**（不再是死字符串） |

---

## 8. 复现命令（全部只读，本机 PowerShell）

```powershell
# 1) 契约只有 3 条 messages operation，且没有任何 DELETE（预期：3 条路径命中、0 条 delete）
Select-String -Path packages/contracts/openapi.json -Pattern '"/(messages|messages/unread-count|messages/\{id\}/read)"'
Select-String -Path packages/contracts/openapi.json -Pattern '"delete"' -Context 0,1 | Select-String -Pattern 'messages'

# 2) 路由层没有 delete（预期：0 命中）
Select-String -Path services/api/src/routes/messages.ts -Pattern 'app\.delete'

# 3) 消息 store 的原语现状（合流后：**有** purgeOwnerData/deleteAllByOwner，属 C1；但未注册进注销闭集）
Select-String -Path services/api/src/messages/store.ts,services/api/src/messages/store-pg.ts -Pattern 'DELETE FROM messages|purgeOwnerData|deleteAllByOwner'
Select-String -Path services/api/src/privacy/user-data-deletion.ts -Pattern 'USER_DATA_DELETION_MODULES ='

# 4) 本仓没有 read_version 字段（预期：0 命中）
Select-String -Path packages/contracts/openapi.json,miniprogram/**/*.js,services/api/src/**/*.ts,tests/**/*.mjs -Pattern 'read_version'

# 5) 401/403 归因只有一处事实源：本模块只剩一行委托（预期：messages-api 里 0 处自建判定）
Select-String -Path miniprogram/utils/messages-api.js -Pattern 'statusCode === 40[13]|failureFor'
Select-String -Path miniprogram/utils/auth.js -Pattern 'function attribution|function failureFor|RETIRED_SESSION_CODES'

# 6) B7 denied 归类（预期：SCOPE_DENIED/CONSENT_REQUIRED/ACCOUNT_INACTIVE ⇒ denied）
Select-String -Path miniprogram/utils/states.js -Pattern "SCOPE_DENIED|CONSENT_REQUIRED|ACCOUNT_INACTIVE"

# 7) 冲突标记（预期：0 命中）
git grep -n "^<<<<<<< \|^>>>>>>> " -- 'miniprogram/**' 'tests/**'

# 8) 自检
npm run lint
node --test "tests/unit/messages-*.test.mjs"
node --test tests/unit/messages-chain-client.test.mjs
node --test tests/unit/miniprogram-ui-auth-integration.test.mjs tests/unit/miniprogram-community-api.test.mjs
npm run test:mini
npm run test:docs
npm run test:unit
```

---

## 9. 未取得（不得据以推断已通过）

- **真机 / 微信开发者工具**：本页所有客户端读数来自 Node + 合成 `wx`（只记录请求，不外发）。**不是**微信编译器或真机证据；`npm run test:mini` 的 `PASS` 只是 JSON/路由/语法检查，脚本自己就写着「Not a WeChat compiler or device test」。
- **真 PG**：本页未起 `pg17`，`messages/store-pg.ts` 的 SQL 形状只有静态与既有单测（`tests/unit/messages-store-pg-contract.test.mjs`）支撑，本片不重跑真库臂。
- **删除链路**：契约没有 operation，故**面向用户的**「单条/会话删除」**没有任何实现与证据**。合流带来的 `purgeOwnerData` 是**注销清理**原语（服务端内部、按主体整域删），且**尚未注册进注销闭集**（G2），本页**不**把它当成用户删除或注销清理已完成的证据。
- **`comment`/`like` 两类消息**：服务端无生产路径（无真实互动事件投递），本页不声称消息中心已覆盖全部四类。
- **403 的真实触发**：本页证明的是「若服务端返 403，客户端按统一层口径归因、页面落 denied」，**未**在真机/真环境构造出 `ACCOUNT_INACTIVE`（注销待处理账号）端到端场景——那需要真实注销受理与真库，属 C1/注销片。
- **全量 `test:unit` 的稳定性**：合流后**一次独占运行**即 `3337/3336 pass / 0 fail / 1 skipped / 75.5 s / exit 0`；但合流前出现过的两处异常（release-materials 用例 `git cat-file` 工具自身异常、审核域后长时间无输出）**根因仍未定位**，本页因此**不声称**「全量任何时候必绿」，也不据此改动任何断言。
- **本片对 (e) 段的贡献边界**：合流后 401/403 的**归因**是 #396 的交付，本片只剩「写路径 403 整页落 denied」这一条新行为 + 文案 + 回归护栏；本页**不把** #396 的成果算成本片成果。
