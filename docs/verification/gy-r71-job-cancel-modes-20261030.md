# GY-R71 作业取消面补全（`moderation` / `answer`）· 证据页

- 日期：2026-10-30
- 分支 / 基线：`feat/gy-r71-job-cancel` 起于 `upstream/main` = **`8b646ae1`**（复核读数：`git rev-parse upstream/main` = `8b646ae1cf8c02a7a55a659cbe3b91f95fc5a7cc`；`git log --oneline -3 upstream/main` 顶部 = `8b646ae1 Add explicit moderation startup approval (#781)`、次条 `5044c18c Wire moderation derivative image source (#779)`）。
- 本片只碰：`services/api/src/jobs/`（未改）+ `services/api/src/moderation/{service,job-source}.ts`、`services/api/src/conversations/{service,store,store-pg,job}.ts`、`services/api/src/app.ts`、两处既有断言（`tests/moderation/http-jobs.test.mjs`、`tests/unit/conversation-http.test.mjs`）、`tests/unit/jobs-cancel-moderation-answer.test.mjs`（新）、`tests/unit/sql-column-coverage.test.mjs`（钉死读数）、`docs/architecture/contract-status.json`（台账）。

## 0 结论先说（不是"改完就好"）

1. **六源现在都能取消**，且**只用既有状态机与既有错误码**（`REVISION_REQUIRED` 428 / `INVALID_REQUEST` 400 / `IDEMPOTENCY_KEY_REQUIRED` 400 / `NOT_FOUND` 404 / `REVISION_CONFLICT` 409 / `OBJECT_UNAVAILABLE` 409），**没有新造码、没有新造状态**。
2. **"真取消"的判据是源表没有新增结论行**，两源各有一条直取存储的断言（§4），不是日志、不是状态字段自述。
3. **两处既有断言被订正**（`moderation`/`answer` 的取消**由 503 变 200**）：这是本片**有意**改变对外行为，改前/改后逐条登记在 §3。
4. **一条必须如实登记的边界**：`moderation` 的可取消窗口只在 `defer_model` 异步供应商路径上出现；**当前产品装配不产生 `queued` 审核任务**（社区发布走同步筛查）⇒ 生产上审核作业**一律已终态**，取消实际总是 409。见 §6.1（**需裁定**）。
5. **一条必须如实登记的边界**：取消**不能撤回已经发出去的外部请求**（真实模型/真实供应商路径下可能已有在途外呼）。本片只保证"取消后结论不再落库"，不宣称"已阻止外发"。见 §6.2。

## 1 六源取证表

取证命令（基线 `8b646ae1`，本片未改 `services/api/src/jobs/**`）：

```
git grep -n "cancel" 8b646ae1 -- services/api/src/jobs services/api/src/routes/jobs.ts
```

`services/api/src/jobs/sources.ts` 里恰有 **4 个** `cancel` 成员（`services/api/src/jobs/sources.ts:65` 识别、`services/api/src/jobs/sources.ts:107` 转写、`services/api/src/jobs/sources.ts:153` 合成、`services/api/src/jobs/sources.ts:208` OCR）；`moderation` 与 `answer` 的作业源里**没有** `cancel`（`services/api/src/moderation/job-source.ts`、`services/api/src/conversations/job.ts` 在基线里只有 `get`）。

| # | `kind` | 基线有无 `cancel` | 取消实现（本片后） | 缺 `cancel` 时走哪条路 → 返回什么码 |
| --- | --- | --- | --- | --- |
| 1 | `recognition` | **有** | `services/api/src/jobs/sources.ts:65` | —（已接线） |
| 2 | `transcription` | **有** | `services/api/src/jobs/sources.ts:107` | —（已接线） |
| 3 | `moderation` | **没有** | `services/api/src/moderation/job-source.ts:61` → 域内 `services/api/src/moderation/service.ts:1180` | 注册表 `cancel` 遍历到本源时 `source.cancel === undefined` ⇒ 先 `get` 确认作业存在（`services/api/src/jobs/registry.ts:286-293`）⇒ 存在则 **503 `PROVIDER_UNAVAILABLE`（`retryable:false`）「该作业所属能力尚未提供取消（未接线）」**（`services/api/src/jobs/registry.ts:294-306`）；不存在/越权则同形 **404 `NOT_FOUND`** |
| 4 | `synthesis` | **有** | `services/api/src/jobs/sources.ts:153` | —（已接线） |
| 5 | `ocr` | **有** | `services/api/src/jobs/sources.ts:208` | —（已接线） |
| 6 | `answer` | **没有** | `services/api/src/conversations/job.ts:87` → 域内 `services/api/src/conversations/service.ts:894` | 同 `moderation`：**503 `PROVIDER_UNAVAILABLE`（`retryable:false`）**，`get` 命不中则 **404 `NOT_FOUND`** |

**六源共同口径（未改）**：注册表的 `cancel` 逐源遍历（`services/api/src/jobs/registry.ts:283-309`）；「不存在」「他人作业」「归不到任何源」**三者同形** `404 NOT_FOUND`；`If-Match` / `Idempotency-Key` 的前置校验由**第一个带 `cancel` 的源**代答（顺序依赖已在 `tests/integration/jobs-http.mjs` 的钉子用例里登记）。

## 2 两源实现要点

### 2.1 `moderation`（审核域）

- 接口与语义：`services/api/src/moderation/service.ts:273`（`ModerationService.cancelJob` 的声明与逐条口径）、实现 `services/api/src/moderation/service.ts:1180`；`real` 未接线时整域 fail-closed 的同名成员见 `services/api/src/moderation/service.ts:471`（走 `deny()`，即 503，不伪造取消）。
- 头校验：`services/api/src/moderation/service.ts:337` 的 `requireCancelIfMatch`（缺失 428、格式非法 400）与 `requireCancelIdempotencyKey`（缺失/长度不合 400）；`IF_MATCH_PATTERN` 与识别/转写/合成/OCR 四域**同形**（各域自持一份，本域是第五处，沿既有约定）。
- 状态跃迁：**只**从 `queued`/`running` 出发（`cancelled` 之外的六个状态全部 409 `OBJECT_UNAVAILABLE`，**含 `uncertain`/隔离**——隔离是已作出的判定，取消它等于抹掉隔离事实）；跃迁写 `state='cancelled'`、`job_revision+1`、`error_code=null`、`contract_value=null`，然后 `await flushLedger()`（**落不了库就不许对外声称已取消**，与域内其它写入点同口径）。
- 适配层：`services/api/src/moderation/job-source.ts:61` 先做归属（不存在/越权 ⇒ `null` ⇒ 同形 404，且**不消耗**调用方的 `If-Match`/幂等键），域内错误原样透出；读面与取消面共用**唯一**投影点 `services/api/src/moderation/job-source.ts:35`（否则两条路会长出两套形状）。
- **真取消的机制**：`state='cancelled'` 后，回调面 `callback.ts` 的 `isTerminalTaskState`（`succeeded`/`cancelled`）会在**验签通过之后、任何写入之前**拒收迟到回调（`CALLBACK_JOB_TERMINAL`）⇒ 审核结论**不会被补写**。取消不删记录、不改历史结论，只把"这条路"封死。

### 2.2 `answer`（文字问答域）

- 存储端口：`services/api/src/conversations/store.ts:150`（`cancelTurnJob` 声明）与内存实现 `services/api/src/conversations/store.ts:337`；PG 实现 `services/api/src/conversations/store-pg.ts:410`（**单条 CAS + 同事务台账写**：`UPDATE … WHERE id/owner_id AND job_state IN ('queued','running')`；`GY-R72`：取消也是终态迁移，`public.jobs` 必须同步落 `cancelled`，`writeJobLedger` 与轮次行同一事务）。
- **PG 结算次序修正（真取消的必要条件）**：`services/api/src/conversations/store-pg.ts:411` 的 `settleTurnJob` 从"先插回答行、再 CAS 轮次"改成"**先 CAS 抢状态、抢到才写回答行**"。基线形态在取消竞态下会留下一条**孤儿回答行**（轮次停在 `cancelled`、`answer_id` 为空，但 `conversation_answers` 已多一行）⇒ 那就是"取消只改了状态、结论照样落库"。次序不修，本片的核心判据必然假绿（见 §7 负控制 ①）。
- 服务层：`services/api/src/conversations/service.ts:894` 的 `cancelTurn`，复用域内**既有**的幂等台账与强 ETag 解析（`withIdempotency` 的入参类型收窄为 `Pick<ConversationActor,'userId'>`：作业面由 `guards.requireUser` 完成后到达，没有角色/epoch 可传，也**不伪造**一个 `authEpoch`）。
- 适配层：`services/api/src/conversations/job.ts:87`（`cancel`）；装配 `services/api/src/app.ts:2525`（`createAnswerJobSource` 的 `cancelJob` 调域内 `cancelTurn`；`app.conversationService === null` 时返回 `null` ⇒ 同形 404，不让 503 冒充）。
- **真取消的机制**：取消只写轮次行的作业快照，**不写回答**；此后迟到的生成/结算调 `settleTurnJob` 时状态谓词（`queued`/`running`）已不命中 ⇒ 回答行永远不会被插入。

### 2.3 幂等与终态口径（本片的**选择**，逐条说明）

| 场景 | `answer` | `moderation` | 与四源（识别/转写/合成/OCR）的关系 |
| --- | --- | --- | --- |
| 同一 `Idempotency-Key` + 同一 `If-Match` 原样重试 | **200**，回放首次结果（域内既有幂等台账） | **200**，返回当前视图（按 `state`+`If-Match` 判，**不**声称"按 Key 回放"） | 四源同为 200 回放；`moderation` 是**唯一**不做 Key 回放的一源 |
| 换新 Key、`If-Match` = **当前** revision（已 `cancelled`） | **200**，`revision` **不变**（no-op） | **200**，`revision` **不变**（no-op） | 四源此处是 409 `OBJECT_UNAVAILABLE`（本片**不改**四源） |
| 换新 Key、`If-Match` = **旧** revision | 409 `REVISION_CONFLICT` | 409 `REVISION_CONFLICT` | 同四源 |
| 已终态但**不是** `cancelled`（`succeeded`/`uncertain`/`failed`/`timed_out`） | 409 `OBJECT_UNAVAILABLE` | 409 `OBJECT_UNAVAILABLE` | 同四源 |

**为什么选"重复取消不报错"**：派单 §2 给了两个选项，本片取前者——取消是"把作业带到 `cancelled`"的动作，**目标状态已达成就是成功**（没有第二次副作用、`revision` 不再前进）。这不是"假装成功"：① 持旧 `If-Match` 的重放仍判 409；② 除 `cancelled` 之外的终态一律 409，不会把"已成功/已隔离/已失败"改写成"已取消"。

**与四源的差异如实登记**：四源对"已 `cancelled` 且 `If-Match` 为当前 revision"返回 409 `OBJECT_UNAVAILABLE`。本片**没有**去改它们（超出派单范围），因此同一个端点在"重复取消"这一格上**按 kind 分叉**。若监工要求六源一致，改四源即可对齐（改动只在各自 `cancelJob` 的终态判定前加一条 no-op 分支），**请裁定**。

**`moderation` 不做 Key 回放的理由（不掩盖）**：本域**没有幂等台账**（其写面只有筛查/回调，从来没有 `Idempotency-Key` 机制）；要支持回放，要么加一张非持久的内存表（进程重启即丢 ⇒ 在 `real` 模式下"声称幂等"就是假话），要么加迁移和列（`moderation_decisions` 的 INSERT/UPDATE 是显式列清单，加列即动冻结迁移面）。两者都不在本片范围。因此 `Idempotency-Key` 在本域**只按契约校验**（缺头 400，与其它五源同形），**不参与回放**。

## 3 五组用例读数（逐组：状态码 + 契约码）

用例文件：`tests/unit/jobs-cancel-moderation-answer.test.mjs`（真实回环 HTTP、动态空闲端口 `port: 0`、合成替身身份与端口；**零真实外呼**）。两源各五组，逐组读数为实测：

| 组 | `answer`（实测） | `moderation`（实测） |
| --- | --- | --- |
| ① 取消成功 | **200**，`state=cancelled`、`revision` 2→**3**、`result=null`、`ETag="3"` | **200**，`state=cancelled`、`job_revision` 1→**2**、`result=null`、`ETag="2"` |
| ② 重复取消 | 同键同 ETag ⇒ **200**（`revision` 仍 3）；新键 + 当前 ETag ⇒ **200**（仍 3）；旧 ETag ⇒ **409 `REVISION_CONFLICT`** | 当前 ETag ⇒ **200**（仍 2）；旧 ETag ⇒ **409 `REVISION_CONFLICT`** |
| ③ 取消已终态 | 已 `succeeded` ⇒ **409 `OBJECT_UNAVAILABLE`**（`retryable=false`），`state`/`revision` 不变 | 已 `succeeded` ⇒ **409 `OBJECT_UNAVAILABLE`**；已隔离 `uncertain` ⇒ **409 `OBJECT_UNAVAILABLE`**（隔离事实保留） |
| ④ 取消不存在 | 随机 uuid ⇒ **404 `NOT_FOUND`** | 随机 uuid ⇒ **404 `NOT_FOUND`** |
| ⑤ 取消他人作业 | 他人令牌 ⇒ **404 `NOT_FOUND`**，`error` 封套与 ④ **逐字段 `deepEqual`**，作业状态不变 | 同左（`deepEqual` + 作业保持 `queued`） |
| 附：缺头 | 缺 `Idempotency-Key` ⇒ **400 `IDEMPOTENCY_KEY_REQUIRED`**；缺 `If-Match` ⇒ **428 `REVISION_REQUIRED`** | 同左 |

**两处既有断言的订正（改前 → 改后，必须逐条登记）**：

| 断言 | 改前 | 改后 | 为什么 |
| --- | --- | --- | --- |
| `tests/moderation/http-jobs.test.mjs:163` | 审核作业取消 ⇒ **503 `PROVIDER_UNAVAILABLE`(retryable=false)**「不提供取消」 | 已出结论（`succeeded`）的审核作业取消 ⇒ **409 `OBJECT_UNAVAILABLE`**，且断言 `state`/`revision`/`result` 不变 | 本片把 `cancel` 接上后，"能力未接线"这一支对审核域不再可达；可取消窗口只有 `queued`/`running`，该用例的作业已 `succeeded` ⇒ 落到既有终态语义 |
| `tests/unit/conversation-http.test.mjs:363` | `answer` 作业取消 ⇒ **503 `PROVIDER_UNAVAILABLE`**「不伪造取消」 | 已 `succeeded` 的 `answer` 作业取消 ⇒ **409 `OBJECT_UNAVAILABLE`**，并断言 `state`/`revision` 不变 | 同上 |

**结构断言订正一处**：`tests/unit/sql-column-coverage.test.mjs` 的钉死读数（`conversations/store-pg.ts` 多了 2 条语句、列要求 +19 且全部已覆盖）。改前 → 改后：8 文件块 字面量 164→**166** / UPDATE 29→**31** / RETURNING 65→**67** / 列要求 1250→**1269** / 逐文件 `conversations` 17→**19**；21 文件块 字面量 301→**303** / UPDATE 54→**56** / RETURNING 93→**95** / 列要求 1909→**1928** / 已覆盖 1855→**1874**（缺 0 条）。**未放宽**任何判据：新增的正是本片真加的语句，逐条来历写在 `tests/unit/sql-column-coverage.test.mjs:525-541` 的改动日志里。

## 4 "真取消"的判据与证明（本片核心）

判据一句话：**取消之后，该作业不得再在源表里产生任何对外可见的结论行**。两源各有一个**直取存储**的断言，不经过状态字段自述、不读日志：

| 源 | 判据动作 | 断言 | 用例 |
| --- | --- | --- | --- |
| `answer` | 取消（作业停在 `running`）→ **放行被阻塞的回答器** → `drain()` 等在途任务全部结算 | `conversationStore.snapshot().answers.length` **不变**（取消前后都是 0）；`findTurnByJobId(jobId, owner).answer === null`；`GET /jobs/{id}` 仍 `cancelled` 且 `revision` 不再前进 | `tests/unit/jobs-cancel-moderation-answer.test.mjs:182` |
| `moderation` | 取消（作业停在 `queued`）→ 投递一条**逐字段合法、签名有效**的供应商回调 | `accepted === false` 且 `reason_codes === ['CALLBACK_JOB_TERMINAL']`；`ledger.history(target)` **行数不变**；该行 `state` 仍 `cancelled`、`job_revision` 仍 2、`decision` 仍 `pending`、`contract_value` 仍 `null` | `tests/unit/jobs-cancel-moderation-answer.test.mjs:323` |

**判据不是"我拒了一个坏信封"**——`moderation·④⑤` 里还有一条**正向对照**：**同一份**回调信封投给一个未取消的同形任务，被接受并落出契约结论（`state=succeeded`、`contract_value` 为对象）。两次唯一差别就是"取消过/没取消过"⇒ 拒收的原因是取消，不是信封不合规。

`answer` 侧的判据同样不是空断言：`answer·③` 证明未取消时同一路径**确实会**落一行回答（`snapshot().answers.length` 从 0 变 1），所以"取消后仍为 0"有判别力。

**PG 臂另有一条不需要真库的钉法**（`tests/unit/jobs-cancel-moderation-answer.test.mjs:482`）：用**记录型假池**驱动 `createPostgresConversationStore(pool).settleTurnJob`——CAS 返回 0 行（= 已取消）时**一条 `INSERT INTO conversation_answers` 都不发**；CAS 返回 1 行时才发，且断言 `INSERT` 发生在 CAS **之后**（次序判据）。这样"先 CAS 再插回答"这条修正也在九条门禁内被判住，而不是只靠读代码。

## 5 证明了什么 / 没证明什么

**证明了**

1. 六源里 `moderation`/`answer` 在基线缺 `cancel`，缺的那条路**确实**是 `services/api/src/jobs/registry.ts:286-306` 的 `existsWithoutCancel` 分支 ⇒ **503 `PROVIDER_UNAVAILABLE`(retryable=false)**（本片前，两条真实装配用例逐字钉着这个读数）。
2. 两源取消后：`200` + `state=cancelled` + `revision`/`job_revision` **恰好 +1** + `result=null`，且**读面与取消面同源**（`GET /jobs/{id}` 读到同一版本）。
3. **取消后源表没有新增结论行**（两源各一条直取存储的断言 + 各一条正向对照）——这是"真取消"，不是"改了个状态字段"。
4. 越权与不存在**逐字段同形** 404（`deepEqual` 比较整个 `error` 封套），且被拒绝的请求**不改变归属者的作业**。
5. 已终态（含 `uncertain`/隔离）取消 ⇒ 409 `OBJECT_UNAVAILABLE`，结论与 `revision` 原样保留。
6. 契约头口径与四源同形：缺 `Idempotency-Key` 400、缺 `If-Match` 428。
7. PG 结算次序修正由记录型假池断言（取消后零 `INSERT`）。

**没证明**

1. **没有真实供应商/真实模型参与**：`moderation` 用的是 `provider.synthetic === true` 的合成端口；`answer` 的回答器是测试注入的替身。⇒ 本页**不得**被引用为任何审核准确率、模型质量或真实可用性证据。
2. **没有真库读数**：`real` 模式下 `conversation_turns` / `conversation_answers` 的真实 PostgreSQL 行为**未在本机实测**（本机无 `DATABASE_URL`、5432 无监听）。PG 臂只有记录型假池 + 代码路径，真库那一臂在 `tests/integration/conversations-pg.mjs`（不在九条门禁内）。
3. **没有跨进程/多副本语义**：单进程内存台账与单连接池下的 CAS；多副本并发取消（两个进程同时取消同一作业）未实测。
4. **没有测"取消后重启"**：`moderation` 的取消在持久台账上是 `flush` 落库的，但"落库后重启、再投迟到回调"这条跨重启链未实测（`ledger-pg.ts` 自己声明不做 hydrate）。
5. **没有测 `real` 模式整域 fail-closed 下的取消**：`real` 无凭据时审核域读面恒空 ⇒ 取消只会得到 404（`cancelJob` 的 `deny()` 分支不可达）。
6. **没有测前端/小程序侧**：本片只有服务端与用例。

## 6 诚实边界（三条硬边界，不许含糊）

### 6.1 `moderation` 的可取消窗口在当前产品装配下**不可达**

`queued` 审核任务只由 `submitScreening({ defer_model: true })` 产生（`services/api/src/moderation/service.ts` 的 `screen` 分支）。全仓 `defer_model: true` 的调用点**只存在于测试/夹具**（`tests/moderation/*`、`tests/unit/community-moderation-fixtures.mjs`）；**社区发布走同步筛查**（`services/api/src/community/moderation-link.ts:467` 的 `submitScreening` 不带 `defer_model`）⇒ 产品路径上审核作业**受理即终态**。

因此：**生产上对审核作业调取消，实际总是 409 `OBJECT_UNAVAILABLE`**（"已出结论"）。本片交付的是"异步供应商路径一旦启用即正确的取消语义"，**不是**"生产用户现在能取消审核作业"。⛔ 不把"接线完成"说成"功能可用"。

**这是本片最需要裁定的一条**（§9-1）：要么接受"审核域取消只在异步路径生效、当前产品不可达"，要么另开一片把社区发布改成 `defer_model` + 回调（那会改变发布时序与用户可见的"待审"窗口，超出取消片范围）。

### 6.2 取消**不能**撤回在途外呼

- `answer`：真实模型路径下 `composer.compose` 可能已经把请求发给上游（`ChatEgress` 的 reserve-then-send 在 `compose` 内部完成）。取消发生在 `compose` **之后**时，外部请求**已经发出且无法撤回**；本片保证的是"结果回来也不落库"（`settleTurnJob` 的状态谓词），**不是**"请求没发出去"。
- `moderation`：真实 `tms`/`ims` 供应商路径同理——取消只封住"结论落库"，**封不住**已经发给供应商的求值请求（也不保证供应商侧不继续计费）。

⇒ 本页全文**不**使用"已阻止外发"这类表述；本片的能力边界是 **"取消 ⇒ 不再产生对外可见的副作用（不落库结论）"**。

### 6.3 `flush` 失败时的中间态

`moderation` 的取消是"先改内存台账、再 `flush` 落库"；`flush` 拒绝时对外**返回 503**（`PROVIDER_UNAVAILABLE`，与域内其它写入点同口径），但**内存里已是 `cancelled`**。⇒ 若同一进程继续服务，读面会看到 `cancelled` 而库里仍是旧状态；重启后回到旧状态、迟到回调仍可能落结论。本片**没有**为此加"回滚内存"补偿（那会引入第二种真值来源），只按既有 fail-closed 口径如实报 503。此边界与域内 `screen`/`publish` 的 `flush` 语义**完全一致**，不是本片新增的风险。

## 7 负控制（四条，逐条打红 → 恢复复绿）

每条都用**提交后的工作树**改一行、跑本片用例、再从备份还原（`Get-FileHash` 校验 SHA256 与改前**逐字节相同**），然后复跑到 10/10 绿。

| # | 怎么打的（改哪一行） | 红在哪（逐字摘录） | 恢复后 |
| --- | --- | --- | --- |
| ① | **取消只改状态、仍然落结论**：`services/api/src/conversations/store.ts` 的内存 `settleTurnJob` 去掉「只有 `queued`/`running` 可结算」的状态谓词 | `answer·①` 红：`AssertionError: 取消后源表（conversation_answers）不得新增结论行` ⇒ **核心判据真的有牙齿** | 10/10 绿 |
| ② | **重复取消返回错误**：`services/api/src/moderation/service.ts` 去掉「已 `cancelled` ⇒ 200 no-op」分支（`if (false && record.state === 'cancelled')`） | `moderation·②` 红：收到 `{"code":"OBJECT_UNAVAILABLE","message":"作业已处于终态 cancelled，不可取消"}`，而不是 200 | 复绿 |
| ③ | **取消他人作业不鉴权**：`services/api/src/moderation/job-source.ts:61` 去掉归属检查、且 `services/api/src/moderation/service.ts:1191` 的 `submitted_by` 校验短路 | `moderation·④⑤` 红：`AssertionError: 他人作业不可取消（与不存在同形，不泄露存在性）` ⇒ 越权者拿到了 200 | 复绿 |
| ④ | **取消已终态作业返回成功**：`services/api/src/moderation/service.ts` 的终态判定短路（`if (false && …)`） | `moderation·③` 红：`200 !== 409`，响应体里 `state:"cancelled"`、`revision:2` —— 一条**已 `succeeded`** 的作业被"取消"了 | 复绿 |

**复跑说明**：①②③④ 首次打红时本片用例是 9 条（PG 次序那条当时尚未加入）。随后按**最终字节**复跑了核心判据 ①：仍红在同一行 `AssertionError: 取消后源表（conversation_answers）不得新增结论行`，恢复后 10/10 绿（`Get-FileHash` 与改前逐字节相同）。②③④ 未复跑的理由是**可判据的**而非省略：被它们改动的三个文件（`services/api/src/conversations/store.ts`、`services/api/src/moderation/service.ts`、`services/api/src/moderation/job-source.ts`）在本片后续提交里**一个字节都没再动**（备份 SHA256 与打红前完全相同：`79619476…`／`7C8AAFFF…`／`BE633705…`），因此三条读数对最终字节同样成立。

**一条如实结论**：①②④ 打在 `moderation`/`answer` 各自的判据上，各自只红对应用例（其余全绿）——说明五组用例**不是**同一条断言复读；③ 同时红在"同形 404"与"状态不变"两处，因为它破坏的是归属面。

## 8 门禁读数（九条 + CI-exact anchors，全部 exit 0）

| 门禁 | 读数 | exit |
| --- | --- | --- |
| `npm run test:unit` | `tests 5862 / pass 5859 / fail 0 / skipped 1 / todo 2` | 0 |
| `npm run verify:anchors` | `verify-contract-status` PASS（覆盖 126 条操作；语义可核 105 条区间 + 4 条片段；行号区间 313 条有实质内容）+ `verify-doc-anchors --strict` PASS（基线外新增 0） | 0 |
| **CI-exact**：`node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | `PASS: --strict 下没有基线之外的新增`；`SYMBOL-STRICT-BASELINE` 登记 31 / 命中 31 / 新增 0 / 陈旧 0；`BARE-ORPHAN` 3543 命中 3543；`BARE-ORPHAN-OUTSIDE` 134 命中 134；`ANCHOR-COUNT` 计数下降 0 份 | 0 |
| `npm run verify:parity` | `"extra": []` / `"missing": []` / `"ledgerDrift": []` | 0 |
| `npm run verify:capability-map` | `totalOps=46，有入口=46，无入口=0，死按钮=0`；标记块与重算一致 | 0 |
| `npm run test:docs` | 研究记录校验 `5 通过 / 0 失败 / 4 legacy 已钉住`；`docs/research` 结构校验 PASS | 0 |
| `npm run lint` | `tsc --noEmit` services/api PASS、apps/admin PASS；仓库卫生扫描 PASS | 0 |
| `npm run test:contract` | `tests 17 / pass 17 / fail 0` | 0 |
| `npm run build` | api + admin 均 `built`（`TMP`/`TEMP` 指向仓外 `E:\GengYunCommander\.pg17\tmp\r71cancel`；build 后已删 `services/api/dist` 与 `apps/admin/dist`） | 0 |
| `npm run test:failmatrix` | `矩阵合计 249 条：PASS 249 / FAIL 0`（B5 批次「异步 AI 域（识别 / OCR / 转写 / 合成 / 作业 / 会话）的游客面与归属面」62 条全绿） | 0 |

**行号与台账**：`node tools/verify-contract-status.mjs --reanchor` 报 4 条候选（`services/api/src/moderation/job-source.ts` 的 `getJob`/`cancelJob` → `services/api/src/moderation/job-source.ts:51-75`；`services/api/src/conversations/service.ts` 的 `createConversation` → `services/api/src/conversations/service.ts:686-729`、`listTurns` → `services/api/src/conversations/service.ts:950-969`）。`--reanchor --write-doc` 在写盘前的**字节保真自检**上判 `UNSAFE`（工具自身拒绝写盘），因此把那 4 个**由工具算出**的区间值手工落到台账与中文对照表，再跑 `node tools/verify-contract-status.mjs --write-doc`（同步表格）与 `verify-contract-status.mjs` 到 exit 0。⛔ 没有手工"凑容差"：落盘的就是工具打印的 `归属块` 起止行。

**文档行号面**：本片改动推移了 6 处既有取证页的行号引用（`app.ts`、`conversations/service.ts`、`moderation/service.ts` 各若干），逐条按内容重新定位后复跑；`tools/doc-anchors-baseline.json` 基线外新增 **0** 条。裸锚点孤儿册按工具规定的方式重生成（`--write-orphan-baseline --accept=1 --why=…`），理由已写进该册的 accept 账本：**`tests/moderation/http-jobs.test.mjs` 的取消断言由 503 改为 409**，而 `docs/verification/gy-r27-synthesis-cancel-20261020.md:413` 是对旧断言行的**历史逐字引用**（该裸锚点指向旧用例里 `503` 那条断言行），补回路径等于篡改历史读数。

## 8.5 文档行号位移：本片做了什么、为什么不是「凑绿」

改 `services/api/src/**` 会推移**既有取证页/台账**里指向这些文件的行号。`tests/unit/doc-anchor-relocation-identity.test.mjs`（`npm run test:unit` 的一条）把纪律钉得很死：目标文件本提交有改动 ⇒ 每条手写锚点都要落到它自己的**端点映射**上，且**旧行原文 === 新行原文**；目标文件没改却被改号 ⇒ 必须在 `tests/unit/doc-anchor-relocations.json` 里登记（含 `reason`／`symbol`）。本片按这条纪律逐条处理：

| 类别 | 数量 | 做法 |
| --- | --- | --- |
| 目标文件被本片改动、锚点按**内容**位移 | 20 处 | 用测试给出的端点映射改号（例：`services/api/src/conversations/service.ts` 的 `798→803`、`911→994`、`959-967→1042-1050`；`services/api/src/moderation/service.ts` 的 `623→682`；`services/api/src/app.ts` 的 `2649→2661`），旧行原文与新行原文逐字相同 |
| 两侧本来就指错的锚点 ⇒ `kind: "correction"` 登记 | 3 条 | ① `docs/verification/gy-i06-media-real-provider-plan-20261021.md` 的两处 `services/api/src/server.ts:62`（base 上指的是 `moderationAssembly.fatalLine` 判断，不是 `buildApp(` 调用行）⇒ 按符号改指 `services/api/src/server.ts:68`；② 台账 `createConversation` 的 `636-679`（base 上该函数从 681 起，旧区间落在它前面的 `validateTurnInput` 里）⇒ 按符号改指归属块 `686-729` |
| 基线册里已陈旧的条目 | 1 条 | `tools/doc-anchors-baseline.json` 的 `services/api/src/app.ts:2573` 已不再命中 ⇒ 按工具要求**删掉该行**（陈旧条目会把基线变成免罚名单） |
| 台账 evidence 区间 | 1 条 | `services/api/src/conversations/job.ts` 的 `48-61` → 最终 `63-76`（`job.ts` 因新增 `ApiError` 判断多 1 行；纯偏移会少一行，故按端点映射取 `63-76`） |
| 裸锚点孤儿册 | `accept=1` | `gy-r27` 取证页对旧断言行（`tests/moderation/http-jobs.test.mjs` 里已由 503 改为 409）的**历史逐字引用**无法在不篡改历史读数的前提下补回路径 ⇒ 按工具规定重生成并写明理由（理由已进该册 accept 账本） |

⛔ **没有**把任何 `lines` 手工改小到「凑容差」，也**没有**为了变绿去改被引用的注释：`createConversation` 那一条是 `node tools/verify-contract-status.mjs --reanchor` 自己算出的归属块，本片只是把工具的输出落到台账并按符号登记。

**一处工具限制如实登记**：`node tools/verify-contract-status.mjs --reanchor --write-doc` 在**写盘前的字节保真自检**上判 `UNSAFE`（工具拒绝写盘）。因此那 4 个**由工具自身算出**的区间值（`services/api/src/moderation/job-source.ts` → `services/api/src/moderation/job-source.ts:51-75`；`services/api/src/conversations/service.ts` → `services/api/src/conversations/service.ts:686-729` 与 `services/api/src/conversations/service.ts:950-969`）是手工落到台账与中文对照表的，随后用 `--write-doc` 同步表格并复跑到 exit 0。落盘值等于工具打印值，不是人工猜测。

## 8.6 端口与进程：本片没有常驻监听

- 本片用例一律用**动态空闲端口**（`app.listen({ host: '127.0.0.1', port: 0 })`），每条用例 `t.after` 关闭；文件末尾另有一条**实测**：`close()` 之后对同一 origin 的 `fetch` 必须**拒连**（`tests/unit/jobs-cancel-moderation-answer.test.mjs:581`）⇒ 端口释放是被断言住的，不是「应该会关」。
- 全套门禁跑完后复查：本片**没有**留下常驻进程/监听端口。宿主机上仍在 127.0.0.1 监听的 node 进程用 `Get-CimInstance Win32_Process` 逐个核过命令行 —— 是 `opencli` daemon、`billion-context`、MCP 桥接（与本片无关，也不是本片启动的）。

## 9 需裁定点（三条）

1. **`moderation` 取消在当前产品装配下不可达**（§6.1）：接受"只在异步供应商路径生效"，还是另开一片把社区发布改成 `defer_model` + 回调？本片**没有**为让"取消可用"而改动发布时序。
2. **重复取消的跨 kind 分叉**（§2.3）：本片让 `answer`/`moderation` 在"已 `cancelled` + 当前 `If-Match`"上返回 200 no-op，四源仍是 409。是否要求六源统一？统一只需在四源的终态判定前各加一条 no-op 分支（不改契约、不改码表）。
3. **`moderation` 不做 `Idempotency-Key` 回放**（§2.3）：接受"只校验、不回放"（本片现状，如实登记），还是补一张**持久**幂等表（需迁移列 + `ledger-pg.ts` 的 INSERT/UPDATE 列清单同步）？
