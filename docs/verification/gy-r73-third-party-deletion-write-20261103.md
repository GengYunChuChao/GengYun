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

`services/api/src/privacy/user-data-deletion.ts:1543` 在 `executeHandlers()` 里 `await …dispatch(...)`，而派发器内部有多段 await 窗口：`third-party-deletion-dispatch.ts:420` 的 `listRecipients()`、第 436 行 的 `listThirdPartyDeletions()`、第 499 行 写 `requested`、第 523 行 适配器 `dispatch()`。用户在这些窗口里取消，`cancelDeletion(userId)` 会成功返回 `state=cancelled`，但**已经在飞的派发继续走完**：

```
before: cancel_state=cancelled, adapter_calls=0, writes=0
after:  receipt_state=cancelled, adapter_calls=1, writes=[requested, confirmed]
assert(adapter_calls === 0): FAIL (actual 1)
```

本轮要求的语义：请求一旦进入 `cancelled`，此后不得再为该 requestId 写 `requested`、不得再触发任何新的第三方外发；已经发生的写入是既成审计事实，**不伪造回滚、不删行**；取消成功的本次回执仍显示 `cancelled`。

### 13.2 四个检查点（每一处都查，只在入口查一次不够）

判据是 `dispatch()` 输入里的可选 `isRequestCancelled`（`third-party-deletion-dispatch.ts:178`），类型是**活判据**而非布尔快照（第 161–168 行 的注释：await 窗口里状态会变）。四个检查点全部调用 `cancellationOf()`（第 367 行）：

| # | 位置 | 行 | 命中取消后的动作 |
| --- | --- | --- | --- |
| 1 | `listRecipients()` 返回、归一之后 | `third-party-deletion-dispatch.ts:429` | `stopCancelled(targets)` ⇒ 后面一条都不写、不发 |
| 2 | `listThirdPartyDeletions()` 返回之后 | `third-party-deletion-dispatch.ts:442` | 同上（连 `requested` 都不写） |
| 3 | 每个接收方写 `requested` **之前** | `third-party-deletion-dispatch.ts:494` | 停掉当前及后续接收方 |
| 4 | 每个接收方调 `adapter.dispatch()` **之前** | `third-party-deletion-dispatch.ts:517` | 已写的 `requested` 如实留着，但绝不再外发 |

命中后的收尾统一走 `stopCancelled()`（第 384–397 行）：`readings.skippedCancelled += remaining.length`（第 388 行，字段声明 第 108 行、初值 第 264 行），记一条 `third_party_deletion_skipped_cancelled` 事件（只含 `request_id` / `recipient_id` / `skipped_reason`，不记凭据与正文），`finish('CANCELLED_AFTER_ACCEPT')`（第 396 行，reason 加入联合类型 第 132 行）。`skippedCancelled` 与幂等读数 `skipped` 分开：后者是「终态/已请求」，前者是「取消之后本就不该再发」。

### 13.3 判据抛错 ⇒ 按取消处理（fail-closed 到「不发」）

`cancellationOf()` 的 `catch`（第 372–375 行）把判据异常折叠成 `probe_failed`，与 `request_cancelled` 一样停止派发。取向写在 第 359–366 行：这不是对称取舍——把「取消已受理」误判成未取消，代价是一次**不可撤回**的第三方外发；把未取消误判成已取消，代价只是这次少发、留下一个待补的审计缺口。前者不可接受，所以判据坏了也**不放行**。

取消判据本身：`services/api/src/privacy/user-data-deletion.ts:1543` 传 `(id) => coordinator.requestState(id) === 'cancelled'`；`requestState()` 是 `packages/privacy/deletion.mjs:295` 新增的**无副作用**只读取值器（查不到返回 `null`，`⛔` 不调会推进状态的 `completionStatus()`），经 `packages/privacy/deletion-modules.mjs:250` 的协调器封套透出，类型见 `services/api/src/privacy/egress-reference.d.ts:109`。读的是协调器里**同一个**请求对象的当前状态，不是回执投影、不是本层缓存的快照。

### 13.4 回归用例效果（`tests/unit/third-party-deletion-write.test.mjs`）

| 用例 | 构造 | 实测 |
| --- | --- | --- |
| T-P1-a（第 861 行） | 真实 `createUserDataDeletion` + 合成写端口 + 可用适配器 + 异步 `listRecipients`（闸门）；进入查询后 `cancelDeletion` | 取消时 `state=cancelled`、`adapter_calls=0`、`writes=0`；放行并等 `executeHandlers` 落定后仍 `adapter_calls=0`、`writes=[]`、回执 `cancelled`、`lastResult().reason='CANCELLED_AFTER_ACCEPT'`、`skippedCancelled=1`。**红转绿** |
| T-P1-b（第 896 行） | 同一链，闸门分别放在 `listRecipients` / `listThirdPartyDeletions` 之后 | 两处取消后均 `adapter_calls=0`、`writes=0`、reason 同上、`skippedCancelled=1` |
| T-P1-c（第 929 行） | 同一条链**不取消**（正向对照） | `adapter_calls=1`、`writes=[requested, confirmed]`、reason `OK`、`skippedCancelled=0`（判据没把正常路径一起关掉） |
| T-P1-d（第 948 行） | `isRequestCancelled` 抛错 | `adapter_calls=0`、`writes=0`、reason `CANCELLED_AFTER_ACCEPT`、事件 `skipped_reason='probe_failed'`、`writeFailures=0` |

**负控制 N5**：把 `cancellationOf()` 临时改成恒 `null`（等于退回到「只在入口看一眼」的旧行为）⇒ T-P1-a / T-P1-b / T-P1-d 三条变红（`tests 31 / pass 28 / fail 3`），T-P1-c 仍绿；还原后 `31 / 31` 全绿。这与监工给出的 `assert(adapter_calls === 0): FAIL (actual 1)` 是同一现象。

### 13.5 原始读数

```
node --test tests/unit/third-party-deletion-write.test.mjs      tests 31 / pass 31 / fail 0
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

