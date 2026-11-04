# GY-R73 证据页：第三方删除的**写侧**接线（2026-11-03）

> 范围：把 `public.record_third_party_deletion` 从「库层有、运行面没有」补上唯一一条腿。
> 本页只记**读数与判定**，不重述 0044 的 SQL 语义（见 `docs/architecture/s4-data-traceability.md` §4 与迁移本身）。
> 本页刻意**不写行号锚点**：本次改动让 `services/api/src/privacy/user-data-deletion.ts` 前部新增 7 行，行号会继续漂移；这里只记符号名与原始输出。

## 1. 结论先说

| 问题 | 结论 |
| --- | --- |
| 写侧接上了吗 | 接上了：`services/api/src/privacy/third-party-deletion-dispatch.ts` 是 `subscribeThirdPartyDeletion()` 的唯一调用点，由注销链 `executeHandlers()` 在 coordinator 跑完之后调 |
| 生产今天会写吗 | **不会，一条也不写**。没有收件人来源、也没有第三方凭据 ⇒ 装配缺口如实上报，零写、零外发 |
| 为什么现在就要接 | 因为「能确定状态的时刻」在链上只有一处（§2）；不接，`third_party_deletions` 永远只有库层与真库臂，运行面永远不产生一行 |
| 回执会变吗 | 不会。`third_party_state` 仍由路由的投影给出；写侧的影响**只体现在持久行**上（`thirdPartyStateOf()` 读到的就是这些行） |

## 2. 时序侦察：哪一刻能确定状态

受理链（`POST /api/v1/me/account/deletion`）：

```
routes/account-deletion.ts  runIdempotent({ produce })
  → privacy/account-deletion.ts  service.request({ userId, receiptInput, readThirdPartyState })
      ① egressRevoker.onAccountSuspendedOrDeleted(...)          同步
      ② deletion.requestDeletionFor(userId, { receiptInput })   → requestId（本次受理的新 uuid）
      ③ await deletion.executeHandlers(requestId)               ★ 唯一异步点，主体/请求 id 都在手
      ④ receipts.issue(requestId)                                回执签发
      ⑤ projectReceipt(deletion.receipt(requestId), { thirdPartyState })
      ⑥ 202 { receipt_token, receipt_expires_at, deletion }
```

逐点判定：

| 链上位置 | 有 `request_id` | 有主体 | 能 await 外发 | 判定 |
| --- | --- | --- | --- | --- |
| ② `requestDeletionFor` | 有 | 有 | 否（同步，返回即要求回执可读） | 不可外发 |
| ③ `executeHandlers` | 有 | 有（`subjectByRequest`） | 是 | **唯一可用点** |
| ④ `receipts.issue` 之后 | 有 | 有 | 是 | 已晚：回执与 202 已按旧行投影 |
| 回执投影 / GET / replay | 有 | 有 | 只读 | 不可写 |

补充两条硬事实：

1. ③ 必须在 coordinator 跑完**之后**才写：`record_third_party_deletion` 对 `request_id` 有外键（`deletion_requests`），受理行在此之前还不存在，早调必 `G0002`。
2. 回执的 `third_party_state` 取自 handler 行（`packages/privacy/deletion.mjs` 建 handler 行时恒 `thirdPartyState: null`，没有任何代码写它）⇒ 写侧**不改**协议账本，只写持久表；两者不冲突，也不互相覆盖。

### 「这一刻向哪个 recipient 发」今天确定不了

全仓 `git grep -n recipient -- services/api/src packages/privacy` 除 `recipient_id` / `recipientId` / 常量名外零命中：**没有任何模块持有收件人清单**（第三方接收方既不在 `config.ts`，也不在用户档案里）。因此写侧把这件事实做成一个显式的注入点与一个显式的缺口读数，而不是编一份名单：

- `ThirdPartyDeletionRecipientSource.listRecipients({ requestId, userId })` —— 产品侧接谁由装配层决定，本片不自造。
- 未注入 ⇒ `reason: 'RECIPIENTS_UNWIRED'`，零写，一条 `third_party_deletion_dispatch_unwired` 事件（每个原因只报一次，避免刷日志）。

## 3. 实现与改动面

| 文件 | 改动 |
| --- | --- |
| `services/api/src/privacy/third-party-deletion-dispatch.ts` | **新增**。状态机 + fail-open 写侧 + 读数。`writePortOf()` 用「有没有 `subscribeThirdPartyDeletion` 方法」探测写能力（真库端口读写同体；`unwired`／`unavailable` 端口没有写方法 ⇒ 如实判「写侧未接线」） |
| `services/api/src/privacy/user-data-deletion.ts` | 依赖加 `thirdPartyRecipients` / `thirdPartyWrite` / `thirdPartyLog`；注册表加 `thirdPartyWrites` / `lastThirdPartyDispatch()`；`executeHandlers()` 里 coordinator 之后 `await dispatch(...)` |
| `tests/unit/third-party-deletion-write.test.mjs` | **新增**。27 个用例，替身按 0044 语义写（不是「怎么方便怎么来」） |
| `tests/integration/third-party-deletion-pg.mjs` | 追加 `E-S4-P1-F`（⑨⑩两组）：写侧经**生产端口**真落库 + 库层 CHECK 兜底；既有 A..E 一组未改 |

`services/api/src/app.ts` **净 0 行改动**：写端口不新装配——真库臂下读写本来就是同一个端口对象，`writePortOf()` 直接认出来；`unwired`／`unavailable` 两臂没有写方法，于是「没有池」这件事自动变成 `WRITE_PORT_UNWIRED` 读数。

## 4. 写侧判定表（每条都对应一个用例）

| 现状（读 `list_third_party_deletions`） | 动作 |
| --- | --- |
| 无行 | 先写 `requested`（带 `requested_at`），写成功才外发 |
| `requested` | **不重发、不刷新 `requested_at`**（skip `already_requested`） |
| `failed` | 直接重发（⛔ 不把 `requested` 写回去盖掉 `failed`） |
| `confirmed` / `unsupported` | 终态，skip `terminal`（不撞 `G0003`） |
| 读失败 | `READ_FAILED`，**一条也不发**（宁可「可能已发过」，也不重复外发） |

外发结果 → 落库：

| 适配器结果 | 落库 |
| --- | --- |
| `confirmed` 且 `evidence_ref` 非空 | `confirmed` + 该 `evidence_ref` |
| `confirmed` 但证据为空（`null`／`''`／纯空白） | `failed` + `EVIDENCE_REQUIRED`（⛔ 没有证据就**不许**写 confirmed） |
| `unsupported` | `unsupported` |
| `failed` | `failed` + `error_code`（缺省 `THIRD_PARTY_FAILED`） |
| `unavailable` | `failed` + `OBJECT_UNAVAILABLE` |
| 抛错 | 折成 `failed` + `THIRD_PARTY_FAILED`，继续下一个收件人 |

fail-open：写失败**不抛、不回滚注销**。`readings.writeFailures` 计数 + 一条 `third_party_deletion_dispatch_*.write_failed` 事件；结果里每条收件人带 `writeFailed`，所以「账没记全」在回执侧与日志里都可诊断，不是静默。

## 5. 幂等与终态（与库层函数的对应）

- 同一 `(request_id, recipient_id, export_ref)` 永远一行（两套部分唯一索引 + `ON CONFLICT`），`requested_at` 冻结在首次；重复 `requested` 不刷新。
- 终态（任一面 `confirmed`／`unsupported`）不可回退；同内容重放返回既有快照，不同内容 `G0003`（端口映射成 `REVISION_CONFLICT` / 409）。
- **但每次受理都是新 `request_id`**（`createDeletionRequest` 每次 `randomUUID()`）：同一用户、同一收件人的第二次注销会**新增一行**——那是第二次受理的合法审计事实，不是重复记账。真库臂 ⑨ 明确测了这一条（同一收件人、两个请求 ⇒ 两行）。

## 6. 读数（原始）

### 6.1 单测（新增，先 commit 前跑过一轮）

```
node --test tests/unit/third-party-deletion-write.test.mjs
tests 27 / pass 27 / fail 0
```

覆盖：四条装配缺口各一条（含「每个原因只报一次」）／无收件人／正常链 `requested → confirmed`（顺序、`requested_at` 冻结、`export_ref` 恒 `null`）／confirmed 无证据三种取值／明确失败／不支持／不可用／适配器抛错不拖累下一个收件人／终态不回退／`requested` 重放不刷新／`failed → confirmed` 只落一条（不重写 `requested`）／去重／两处写失败（`requested` 写不进 ⇒ 不外发；结论写不进 ⇒ 行停 `requested` 且 `dispatched` 仍计）／读失败不发／收件人来源抛错／日志出口抛错不影响／**写侧整体炸掉 ⇒ 注销与「完全没接第三方」那条臂逐字一致**／`writePortOf()` 探测／app 层（真 `buildApp` + `userDataDeletionInjection` ⇒ 202，`reason === 'RECIPIENTS_UNWIRED'`、零写）。

### 6.2 真库臂（追加 `E-S4-P1-F`）

```
PASS 14: ⑨ 写侧（真库）：生产端口 requested → confirmed 真落库（owner 视角复核 + 端口回读逐字一致）、
         终态回退 => 409 REVISION_CONFLICT 且行未动、缺证据 => 400 且零 SQL、同接收方两次受理 => 两行
PASS 15: ⑩ 库层兜底（真库）：绕过函数直写 confirmed 且 evidence_ref=null => 23514 third_party_confirmed_evidence，零行落库
RESULT=PASS 15 组；真实 PostgreSQL 17.11（本机隔离、仅回环）；未发出任何对外付费请求；发现迁移 52 个
CLEANUP=done
```

⑨ 的判据：一条写只发**一条** SQL（语句文本命中 `public.record_third_party_deletion`）；`requested` 面 `online_state`／`backup_state` 两列都是 `requested`、`requested_at` 逐字等于入参；`confirmed` 面两列都 `confirmed`、`evidence_ref` 与 `confirmed_at` 逐字、**`requested_at` 未被刷新**；再写 `requested` 得 `REVISION_CONFLICT`／409／`retryable:false` 且三列未动；端口层预检（`confirmed` + `evidenceRef: null`）⇒ `INVALID_REQUEST`／400 且 SQL 计数为零。

## 7. 负控制（原始红）

| # | 手法 | 期望 | 实测 |
| --- | --- | --- | --- |
| ① | 注释掉 `executeHandlers()` 里的 `await thirdPartyDispatch.dispatch(...)` | 新用例必须红 | 见 §7.1 |
| ② | `confirmed` 的 `evidence_ref` 传 `null` | 库层 CHECK 拦住 | `new row for relation "third_party_deletions" violates check constraint "third_party_confirmed_evidence"`（SQLSTATE `23514`，零行落库） |
| ③ | 让写侧整体抛错 | 注销主流程仍完成 | 见 §7.3 |

（§7.1／§7.3 的原始输出在提交信息与 PR 描述里逐字贴出。）

## 8. 诚实边界

**没证明的：**

- 没跑 `npm run build`：本机 Windows 上 esbuild 删临时文件被拒（`Access is denied`），是已知宿主限制，不是代码问题；构建从未在此机器上验过。
- 没有真实第三方：适配器在无凭据时 `available: false`、连 `fetch` 都不调；本片一次真实外发都没有，也没有第三方回执的真实样本。
- 没有真机、没有生产库：真库臂跑在本机隔离簇（`127.0.0.1`、非常用端口、`-c fsync=off`），库名硬钉测试库；与生产 CVM 的权限面只对齐到 `20-login-roles.sql` 的授权域与 `90-assert-least-privilege.sql` 的断言口径。
- 没有 CI 读数：本页所有读数都是本机结果。

**必须由产品口径决定的：**

1. **recipient 从哪来**：现在没有任何权威来源。是「用户授权过的第三方清单」「运营配置」「外部注册表回调」，还是「按数据流登记的对象存储/转写供应商」？这决定 `ThirdPartyDeletionRecipientSource` 的真实实现，也决定要不要为每个收件人建独立的重试队列。
2. **`evidence_ref` 由谁签**：第三方回执单号、我方外发流水、还是签署过的删除证明文件？证据的**可复核性**决定 `confirmed` 能不能被审计采信；本片只保证「没有证据就不写 confirmed」。
3. **`failed` 之后谁来重试**：本片的重试只在「下一次同一 `request_id` 的 `executeHandlers`」发生，而一次注销通常只执行一次。要不要一个按收件人扫描 `failed` 行的补偿作业（以及它与 30 日备份保留期、7 日在线期的先后）？
4. **「不支持」要不要对外解释**：`unsupported` 是终态，但用户看到的是回执里的 `third_party_state`；要不要在回执文案里区分「对方不支持删除 API」与「我方还没接」？

## 9. 可推范围

本次**只**动：`services/api/src/privacy/`（两个文件）、`tests/`（单测新增、真库臂追加）、`docs/`（本页 + 三处「写侧零调用者」的订正 + 行号位移同步）。
**不动**：`deploy/**`、迁移（无新增、无修改）、`packages/contracts/openapi.json`。

## 13. 取消交叠（P1 返修）

> 本节按返修任务书要求改用 `文件:行号` 锚点（仅本节）；行号以本次改动后的工作树为准，写完后逐条核过。

### 13.1 缺陷现象（监工复现，原文读数）

`services/api/src/privacy/user-data-deletion.ts:1543` 在 `executeHandlers()` 里 `await …dispatch(...)`，而派发器内部有多段 await 窗口：`third-party-deletion-dispatch.ts:512` 的 `listRecipients()`、`third-party-deletion-dispatch.ts:528` 的 `listThirdPartyDeletions()`、`third-party-deletion-dispatch.ts:601` 写 `requested`、`third-party-deletion-dispatch.ts:632` 的适配器 `dispatch()`。用户在这些窗口里取消，`cancelDeletion(userId)` 会成功返回 `state=cancelled`，但**已经在飞的派发继续走完**：

```
before: cancel_state=cancelled, adapter_calls=0, writes=0
after:  receipt_state=cancelled, adapter_calls=1, writes=[requested, confirmed]
assert(adapter_calls === 0): FAIL (actual 1)
```

本轮要求的语义：请求一旦进入 `cancelled`，此后不得再为该 requestId 写 `requested`、不得再触发任何新的第三方外发；已经发生的写入是既成审计事实，**不伪造回滚、不删行**；取消成功的本次回执仍显示 `cancelled`。

### 13.2 四个检查点（每一处都查，只在入口查一次不够）

判据是 `dispatch()` 输入里的可选 `isRequestCancelled`（`third-party-deletion-dispatch.ts:184`），类型是**活判据**而非布尔快照（`third-party-deletion-dispatch.ts:169` 的类型声明，注释写明 await 窗口里状态会变）。四个检查点：

| # | 位置 | 行 | 命中取消后的动作 |
| --- | --- | --- | --- |
| 1 | `listRecipients()` 返回、归一之后 | `third-party-deletion-dispatch.ts:521` | `stopCancelled(targets)` ⇒ 后面一条都不写、不发 |
| 2 | `listThirdPartyDeletions()` 返回之后 | `third-party-deletion-dispatch.ts:534` | 同上（连 `requested` 都不写） |
| 3 | 每个接收方写 `requested` **之前** | `third-party-deletion-dispatch.ts:585` | 停掉当前及后续接收方 |
| 4 | 每个接收方调 `adapter.dispatch()` **之前** | `third-party-deletion-dispatch.ts:617` | 已写的 `requested` 如实留着，但绝不再外发 |

检查点 1/2 走 `cancellationOf()`（`third-party-deletion-dispatch.ts:409`，可 await 异步判据）；检查点 3/4 走**同步**的 `readCancellationNow()`（`third-party-deletion-dispatch.ts:432`），理由见 13.7。

命中后的收尾统一走 `stopCancelled()`（`third-party-deletion-dispatch.ts:476`）：`readings.skippedCancelled += remaining.length`（第 480 行，字段声明 第 108 行、初值 第 303 行），记一条 `third_party_deletion_skipped_cancelled` 事件（只含 `request_id` / `recipient_id` / `skipped_reason`，不记凭据与正文，第 486 行），`finish('CANCELLED_AFTER_ACCEPT')`（第 488 行，reason 加入联合类型 第 132 行）。`skippedCancelled` 与幂等读数 `skipped` 分开：后者是「终态/已请求」，前者是「取消之后本就不该再发」。

### 13.3 判据抛错 ⇒ 按取消处理（fail-closed 到「不发」）

`cancellationOf()` 的 `catch`（`third-party-deletion-dispatch.ts:414`）把判据异常折叠成 `probe_failed`，与 `request_cancelled` 一样停止派发；同步取值那一侧的同一个取向在 `third-party-deletion-dispatch.ts:432`（`try/catch` 在判据调用上）。取向写在 `third-party-deletion-dispatch.ts:398` 起的注释里：这不是对称取舍——把「取消已受理」误判成未取消，代价是一次**不可撤回**的第三方外发；把未取消误判成已取消，代价只是这次少发、留下一个待补的审计缺口。前者不可接受，所以判据坏了也**不放行**。

取消判据本身：`services/api/src/privacy/user-data-deletion.ts:1543` 传 `(id) => coordinator.requestState(id) === 'cancelled'`；`requestState()` 是 `packages/privacy/deletion.mjs:295` 新增的**无副作用**只读取值器（查不到返回 `null`，`⛔` 不调会推进状态的 `completionStatus()`），经 `packages/privacy/deletion-modules.mjs:250` 的协调器封套透出，类型见 `services/api/src/privacy/egress-reference.d.ts:109`。读的是协调器里**同一个**请求对象的当前状态，不是回执投影、不是本层缓存的快照。

### 13.4 回归用例效果（`tests/unit/third-party-deletion-write.test.mjs`）

| 用例 | 构造 | 实测 |
| --- | --- | --- |
| T-P1-a（`tests/unit/third-party-deletion-write.test.mjs:891`） | 真实 `createUserDataDeletion` + 合成写端口 + 可用适配器 + 异步 `listRecipients`（闸门）；进入查询后 `cancelDeletion` | 取消时 `state=cancelled`、`adapter_calls=0`、`writes=0`；放行并等 `executeHandlers` 落定后仍 `adapter_calls=0`、`writes=[]`、回执 `cancelled`、`lastResult().reason='CANCELLED_AFTER_ACCEPT'`、`skippedCancelled=1`。**红转绿** |
| T-P1-b（`tests/unit/third-party-deletion-write.test.mjs:926`） | 同一链，闸门分别放在 `listRecipients` / `listThirdPartyDeletions` 之后 | 两处取消后均 `adapter_calls=0`、`writes=0`、reason 同上、`skippedCancelled=1` |
| T-P1-c（`tests/unit/third-party-deletion-write.test.mjs:959`） | 同一条链**不取消**（正向对照） | `adapter_calls=1`、`writes=[requested, confirmed]`、reason `OK`、`skippedCancelled=0`（判据没把正常路径一起关掉） |
| T-P1-d（`tests/unit/third-party-deletion-write.test.mjs:978`） | `isRequestCancelled` 抛错 | `adapter_calls=0`、`writes=0`、reason `CANCELLED_AFTER_ACCEPT`、事件 `skipped_reason='probe_failed'`、`writeFailures=0` |

**负控制 N5**：把 `cancellationOf()` 临时改成恒 `null`（等于退回到「只在入口看一眼」的旧行为）⇒ T-P1-a / T-P1-b / T-P1-d 三条变红（`tests 31 / pass 28 / fail 3`），T-P1-c 仍绿；还原后 `31 / 31` 全绿。这与监工给出的 `assert(adapter_calls === 0): FAIL (actual 1)` 是同一现象。

### 13.5 原始读数

```
node --test tests/unit/third-party-deletion-write.test.mjs      tests 31 / pass 31 / fail 0（第一轮；第二轮追加 T-P1-e/f 后 33 / 33，见 13.7）
node --test tests/unit/s4-data-gap-pins.test.mjs                tests  6 / pass  6 / fail 0
node --test "tests/privacy/*.test.mjs"                          tests 221 / pass 221 / fail 0
node --test （5 个相邻注销域单测，见 HANDOFF）                    tests 57 / pass 57 / fail 0
npx tsc -p services/api --noEmit                                exit 0
```

### 13.6 如实边界

- **生产默认没有真实接收方来源**（未注入 `thirdPartyRecipients` ⇒ `RECIPIENTS_UNWIRED`，零写零发）。因此本条是**注入式路径**（有收件人来源 + 可用适配器）上的缺陷：生产今天不触发，不等于该路径安全；一旦产品定下接收方来源，这条链就会走到。
- **未重跑真库臂**（`tests/integration/third-party-deletion-pg.mjs` 的 `E-S4-P1-F`）与**未上真机**：本轮只跑进程内单测（无网络、无 PG），真库侧取消交叠没有数据库级证据。
- **既有 27 条用例未覆盖此交叠**：它们都在 `listRecipients` / 适配器同步返回的路径上跑，没有在 await 窗口里取消，所以此前 27/27 全绿并不代表没有这个缺陷。
- **跨进程/多实例**：`requestState()` 读的是本进程协调器里的请求对象；多实例共享库、或取消走另一个进程时，本判据看不到对方的状态（本轮不证明分布式可见性）。
- 取消之后停在 `requested` 的接收方行不会被回滚、删除，也不会自动补 `confirmed`/`failed`；补偿作业不在本轮范围。

### 13.7 最后一米同步读取（第二轮 P1）

监工第二轮驳回的要点：`cancellationOf()`（`services/api/src/privacy/third-party-deletion-dispatch.ts:409`）是 `async`，判据调用被 `await`（第 413 行）；检查点 4 又 `await` 它一次，于是「读到未取消」与「实际调用 `adapter.dispatch()`」之间还隔着一个微任务。取消恰好在这个让位点被受理，后面的分支就拿着已经过时的 `null` 继续外发。

监工给的反例读数（真实 `createUserDataDeletion` + 真实同步判据，只换端口/接收方/适配器）：

```
write requested: receipt=blocked
cancelAccepted: state=cancelled, adapter_calls=0
adapterCalled: receipt=cancelled
write confirmed: receipt=cancelled
final: adapter_calls=1, receipt=cancelled, lastResult.reason=OK
assert adapter_calls===0: FAIL, actual 1
```

本轮在本机用同一条链复读，数字与之一致（T-P1-e 的前置构造；改动前）：

```
[port] requested written, schedule 3-level microtask
[cancel] accepted at cancelled adapter_calls=0 writes=['requested']
[adapter] called, receipt=cancelled writes=['requested']
final adapter_calls=1 writes=['requested','confirmed'] state=cancelled reason=OK
```

**缺陷本体**：判据本来就是同步的（`services/api/src/privacy/user-data-deletion.ts:1627` 的 `(id) => coordinator.requestState(id) === 'cancelled'`）。把它包成 `async` 再 `await`，等于在「读到未取消」和副作用之间插了一个**微任务让位点**：同步判据不需要这个让位点，它只贡献窗口、不贡献信息。

**改动**：

1. 新增同步取值 `readCancellationNow()`（`third-party-deletion-dispatch.ts:432`）：直接调判据，只认 `true` / `false`；拿到 thenable 返回 `'unconfirmable'`，判据抛错返回 `'probe_failed'`（仍按取消处理）。
2. **紧贴副作用的两处**（检查点 3 写 `requested` 之前 = `third-party-deletion-dispatch.ts:585` 起；检查点 4 外发之前 = `third-party-deletion-dispatch.ts:617` 起）只认这个同步读数：读到取消就 `stopCancelled()`；读到未取消就**紧接着同步**调 `writeState()`（第 601 行）/ `adapter.dispatch()`（第 632 行），两步之间**零 `await`**。
3. 离副作用远的两个检查点（`third-party-deletion-dispatch.ts:521` / `third-party-deletion-dispatch.ts:534`）继续走可 await 的 `cancellationOf()`：那里多让一个微任务无害，进循环后每一轮都会重新同步取值。
4. 每一轮在取最后一读**之前**先让出一拍（第 590 行 / 第 621 行各一次 `await Promise.resolve()`）：把已经排队的取消放进来再读。让位在读**之前**，读与外发之间仍是零 `await`；⛔ 不许把它挪到读之后当「第二次检查」——那只是把让位点换个位置。

**异步判据取向（fail-closed）**：签名保留 `(requestId: string) => boolean | Promise<boolean>`（`third-party-deletion-dispatch.ts:169`）。同步返回布尔值就地用；返回 thenable ⇒ 补问一次（`awaitAsyncProbe()`，`third-party-deletion-dispatch.ts:462`），随后**在调用方这一层**再同步读一次（第 595 行 / 第 625 行）——补问的结论不作数：async 函数返回值要经过一次 promise 解析，本身又是一个让位点，不能拿它当最终依据。第二次仍读到 thenable ⇒ `'unconfirmable'` ⇒ 当作已取消，**不写不发**：异步判据在最后一米无法同步确认，宁可少发不可多发。事件里 `skipped_reason='unconfirmable'`，与判据抛错的 `'probe_failed'` 分开记。

**用例效果**（`tests/unit/third-party-deletion-write.test.mjs`）：

| 用例 | 构造 | 实测 |
| --- | --- | --- |
| T-P1-e（`tests/unit/third-party-deletion-write.test.mjs:1007`） | 真实 `createUserDataDeletion` + 真实协调器 + 真实同步判据；合成写端口在 `requested` 写完那一刻用三级嵌套 `queueMicrotask` 排一次真实 `cancelDeletion()` | 取消受理时 `state=cancelled`、`adapter_calls=0`；落定后 `adapter_calls=0`、`writes=['requested']`（没有 `confirmed`）、回执 `cancelled`、`lastResult().reason='CANCELLED_AFTER_ACCEPT'`、`skippedCancelled=1`。**红转绿**（改前 `adapter_calls=1`、`writes=['requested','confirmed']`、reason `OK`） |
| T-P1-f（`tests/unit/third-party-deletion-write.test.mjs:1040`） | `isRequestCancelled` 返回永远 resolve 成 `false` 的 Promise | `adapter_calls=0`、`writes=[]`、reason `CANCELLED_AFTER_ACCEPT`、事件 `skipped_reason='unconfirmable'`（不是静默外发） |

**负控制 N6**：把检查点 4 的同步读取那一行临时改成恒「未取消」（等价于退回「读到的值可能过期」的口径）⇒ T-P1-e 变红（`actual 1`、`expected 0`），还原后 `33 / 33` 全绿。另把检查点 3、4 临时退回第一轮的 `await cancellationOf()` 形态复跑，T-P1-e 同样红（`actual 1`）——与本小节开头的监工读数一致。

**本轮原始读数**：

```
node --test tests/unit/third-party-deletion-write.test.mjs      tests 33 / pass 33 / fail 0
node --test tests/unit/s4-data-gap-pins.test.mjs                tests  6 / pass  6 / fail 0
npx tsc -p services/api --noEmit                                exit 0
node tools/verify-contract-status.mjs                           exit 0（无「表格漂移」）
```

**如实边界**：最后一读之前的那一拍是**一个**微任务（一次 `await Promise.resolve()`），不是「清空整个队列」；比它更深的排队取消仍可能落在读之后——那种情况的语义是「取消在读之后才被受理」，此时外发已经同步开始，不在本层能力范围内（本轮不承诺回滚，也不承诺跨进程/跨宏任务的取消可见性）。

### 13.8 无人 await 的 thenable 不许漏成 unhandled rejection（第三轮 P2 / #860）

**审查反例的机制**：`readCancellationNow()` 是同步函数（这是 13.7 的硬约束：紧贴副作用的读与写之间零 `await`）。判据返回 thenable 时它拿不到布尔值，只返回 `'unconfirmable'`；改动前那份 Promise **被直接丢弃**。若前两次探测都返回 `Promise.resolve(false)`（两个远端检查点通过），紧贴副作用的那一次返回 `Promise.reject(...)`，被丢弃的那份 Promise 就没人消费 ⇒ Node 默认按 unhandled rejection 处理 ⇒ **进程 `exit 1`**。这正好击穿本派发器「任何异常不穿透、注销照常」的承诺。

**改动（只动这一处收尾）**：

1. `services/api/src/privacy/third-party-deletion-dispatch.ts:260` 新增 `settleDetachedThenable(value)`：`Promise.resolve(value).then(noop, noop)`，只消费失败分支；`noop` 在同文件第 249 行。
2. `services/api/src/privacy/third-party-deletion-dispatch.ts:445-450`：`isThenable(verdict)` 为真时，先对**这一份** Promise 调 `settleDetachedThenable(verdict)`，再照旧返回 `'unconfirmable'`。没有改成丢弃，没有加全局 `unhandledRejection` 监听器，结论语义不变（仍 fail-closed 到「不发」；`true` 才算取消的口径未动）。
3. 顺带核对补问路径：`awaitAsyncProbe()`（同文件第 462–468 行）自身 `await` 判据、异常就地 `catch`，不产生第二份无人消费的 thenable；两个「补问分支」（第 592–596 行 / 第 622–626 行）在补问后的第二次同步读仍走 `readCancellationNow()`，由第 2 条同一处收尾。没有发现第三份。
4. 安全边界保持：最终同步读到 `writeState` / `adapter.dispatch` 之间仍然**零 `await`**（本轮未新增任何 await）。

**回归 T-P1-g**（`tests/unit/third-party-deletion-write.test.mjs:1065`）：判据前两次 `Promise.resolve(false)`，第三次起 `Promise.reject(new Error('SYNTHETIC_PROBE_OFFLINE'))`。实测：用例正常结束（临时挂的取证监听器记录到 `unhandledRejection` 次数为 **0**）、`adapter.calls.length=0`、`port.writes=[]`、`readings.dispatched=0`、`readings.skippedCancelled=1`、`result.reason='CANCELLED_AFTER_ACCEPT'`（既有 fail-closed 分支，未为凑测试改产品语义）。既有 33 条断言未改、未放宽。

**负控制**：临时把 `settleDetachedThenable(verdict)` 那一行注掉，只跑 T-P1-g ⇒ 变红并复现审查反例：

```
✖ R73-P1 T-P1-g … (5.1759ms)
  Error: SYNTHETIC_PROBE_OFFLINE
      at isRequestCancelled (tests/unit/third-party-deletion-write.test.mjs:1088)
      at readCancellationNow (services/api/src/privacy/third-party-deletion-dispatch.ts:437)
[exit code: 1]
```

还原后复跑全绿。

**本轮原始读数**：

```
node --test tests/unit/third-party-deletion-write.test.mjs tests/unit/s4-data-gap-pins.test.mjs
    tests 40 / pass 40 / fail 0
npx tsc -p services/api --noEmit     exit 0
npm run lint                         exit 0（PASS services/api + apps/admin + 仓库卫生扫描）
```

**如实边界**：本次只保证「被丢弃的 thenable 不再把 rejection 泄漏成进程退出」，**不是**跨进程取消保证，也没有改变「取消在读之后才被受理」的既有时序边界（见 13.6 / 13.7）。补问本身仍是一次真实判据调用，判据若长期异步，行为仍是 fail-closed 少发。未重跑真库臂与真机；`awaitAsyncProbe()` 之外若将来新增调用点，仍需各自遵守「谁生成 thenable，谁收尾」。

