# GY-R94 · 识别链路：对「已发出但拿不到可用结果」自动重发一次（2026-11-10）

- 基线：`origin/main = b1b47383`（`git rev-parse origin/main` 实读）。
- 分支：`fix/gy-vision-retry`。
- 口径：**本机演示口径**，与 `docs/verification/gy-r94-vision-parse-hardening-20261110.md` 同一实验对象——同一张照片（`demo-photos/01-Eleusine_indica.jpg`，161 420 B，sha256 `de4e7b26…84254`）、同一个供应商剖面（`openai-vision-v1`）。本页所有读数只对这条演示链路成立，不是能力承诺（见 §7）。
- 契约面未动：`services/api/src/contract.ts` 与 `packages/contracts/openapi.json` 本次零改动；`POST /recognitions`、`GET /jobs/{id}` 的响应体与错误码不变（作业面九键未增删，重发是服务端内部行为）。

## §1 结论

1. **重发只覆盖一支**：「已发出、但拿不到可用结果」。落到代码上是三处 `retryable: true`——解析不出 JSON 对象（主目标，`services/api/src/recognitions/openai-vision-adapter.ts:331`）、回包整体不是 JSON（`:318`）、连接层失败且**非**超时（`:300`）。其它分支一律不标（§2）。
2. **最多多打一次**：总尝试 ≤ 2，第二次仍失败照旧落 `PROVIDER_OUTCOME_UNKNOWN`。闸门在 `services/api/src/privacy/task-egress.ts:238`（`attempt < MAX_DISPATCH_ATTEMPTS && redispatchable(outcome) && redispatchBudgetLeft(...)`）。
3. **账本每次尝试一行**：不合并。序号仍由 SQL 自己派生（`COALESCE(MAX(attempt),0)+1`，唯一键 `UNIQUE (export_id, attempt)`，`services/api/src/privacy/provider-call-ledger-pg.ts:107`），两行共用同一个 `export_id`——靠派发层把 `exportId` 下传（`services/api/src/privacy/media-call-accounting.ts:202`）。单测实测 `attempt = [1, 2]`。
4. **媒体不重传**：同一 `media_id` / `media_revision`，第二次请求体逐字节相同（单测逐字节比对）。
5. **30 次端到端 0 失败、0 次触发重发**：30/30 `succeeded`、`PROVIDER_OUTCOME_UNKNOWN` 0 次、`egress_retry` 事件 0 条、观测 `sendAttempts` 30 条全为 1、账本 30 单各一行 `attempt = 1`（§6）。所以**本次 30 次读数没有覆盖重发路径本身**——重发路径的举证全在单测（§5、§9）。

## §2 触发条件（哪些重发、哪些不重发）

适配器只对「已经打出去、但拿不到可用结果」标 `retryable: true`，其余分支不标；重发决定在看得到作业与截止点的那一层做。

| 情形 | 代码 | 重发 |
| --- | --- | --- |
| HTTP 200，`message.content` 解析不出 JSON 对象（结构类，本次主目标） | `services/api/src/recognitions/openai-vision-adapter.ts:331` | **是** |
| HTTP 200，但回包整体不是 JSON（`response.json()` 抛错） | `services/api/src/recognitions/openai-vision-adapter.ts:318` | **是** |
| 连接层失败（fetch 拒绝）且**不是**超时 | `services/api/src/recognitions/openai-vision-adapter.ts:300` | **是** |
| 超时（`AbortSignal.timeout(15000)` 到点） | `services/api/src/recognitions/openai-vision-adapter.ts:300` 的 `timedOut` 分支 | 否 |
| 非 2xx：4xx / 401 / 403 / 429 / ≥500（含媒体域 503） | `services/api/src/recognitions/openai-vision-adapter.ts:303` + `errorCodeForStatus`（`:102`） | 否 |
| 过闸门被拒（同一次尝试已预留、额度、未授权） | `services/api/src/recognitions/openai-vision-adapter.ts:270` | 否 |
| 图片读不出 / 不是活的识别图（一包都没发） | `services/api/src/recognitions/openai-vision-adapter.ts:245` | 否 |
| `CONSENT_REQUIRED`（内层抛错，含撤回同意） | 抛错路径：`services/api/src/privacy/task-egress.ts:221` 记一行后原样上抛 | 否 |
| `OBJECT_UNAVAILABLE`（无外发预留，未登记的外发被拒绝） | `services/api/src/privacy/task-egress.ts:190` 之前就抛 | 否 |

两条边界：**超时不算**（已经被 15 s 预算切断，再打一次只会把作业预算吃光）；**非 2xx 不算**（4xx/429/5xx 的语义是「这一发不该再发」，尤其 503 是能力不可用，重试不会变好，且撤回同意必须立刻停）。

## §3 落点与三道闸

- **为什么不在适配器里做循环**：适配器的冻结剖面把 `maxRetries` 锁成 `0`（任何非零重试在构造期就被 `assertLive*Profile` 拒掉，口径原文「任何重发都是一次新的预留」）。硬在适配器里循环会撞这条剖面和 `attemptKey` 的「同一次尝试已预留过（绝不重发）」——那不是重发，是绕过闸门。
- **为什么在 egress 层**：`services/api/src/privacy/task-egress.ts` 的 `provider()` 是唯一同时看得见「外发预留行」「作业 id」「作业截止点」的地方。重发放在 `markSent` 之后、终态写入之前 ⇒ 预留行在两次派发的整个窗口里保持 `sent`，**终态只写一次**，`public.exports` 的状态机（`reserved → sent → failed|outcome_unknown`）一个字没改。
- **三道闸**：
  1. 次数：`MAX_DISPATCH_ATTEMPTS = 2`（`services/api/src/privacy/task-egress.ts:68`）；
  2. 资格：只认 `outcome.kind === 'failed' && outcome.retryable === true`（`services/api/src/privacy/task-egress.ts:77`）；
  3. 预算：作业层整体上限 `REDISPATCH_TOTAL_BUDGET_MS = 35_000`（从首次派发起算，`services/api/src/privacy/task-egress.ts:66`），并用第一次的实际耗时预估第二次；作业截止点再留 500 ms 余量（`services/api/src/privacy/task-egress.ts:87` 的 `redispatchBudgetLeft`）。任一不满足 ⇒ 不重发、直接落失败。
- **可见性**：重发时发一条 `egress_retry` 事件（`services/api/src/privacy/task-egress.ts:240`），`egress_sent` / `egress_saved` / `egress_failed` 都带 `attempt`；观测侧 `sendAttempts` 第二次是 `2`（`services/api/src/recognitions/openai-vision-adapter.ts:235`），第二次派发的 `attemptKey` 带 `#2` 后缀（`services/api/src/recognitions/openai-vision-adapter.ts:270`），与第一次不同。

## §4 账本为什么是两行、怎么是两行

- 记账层从 egress 的**外层**挪到了**内层**（`services/api/src/app.ts:1133`）：`egress.provider(withProviderCallAccounting(inner, …), 'recognize')`。挪的理由很直白——只有内层才会被调用两次。行数不变，但顺序变了，注释同步改了。
- 第二次派发时 exports 行已是 `sent`，`findReservedByObject`（谓词 `state='reserved'`）必然查不到 ⇒ 记账层改成**优先用派发层下传的 `exportId`**（`services/api/src/privacy/media-call-accounting.ts:202`），回查只做兜底（非重发路径行为不变）。
- 序号仍由 SQL 派生（`services/api/src/privacy/provider-call-ledger-pg.ts:107`），`UNIQUE (export_id, attempt)` 是唯一裁决者；调用方**不**自报 `attempt`。
- 单测实测（`tests/unit/recognitions-vision-retry.test.mjs`）：第一次 `invocation_state='send_failed'` / `attempt=1`，第二次 `sent` / `attempt=2`（两次都失败时两行都是 `send_failed`）；`UNIQUE (export_id, attempt)` 没有撞过，`readings.failed === 0`。

## §5 单测与闸门读数（本机，2026-11-10）

新增 `tests/unit/recognitions-vision-retry.test.mjs`，8 条，全部走**真**装配：真 `createMediaJobEgress` × 真 `withProviderCallAccounting` × 真 `createOpenAiVisionRecognitionProvider`（只换 `fetchImpl` / `liveGate`）× 真 `createRecognitionService`（内存 store）。

| # | 用例 | 断言要点 |
| --- | --- | --- |
| ① | 第一次「200 但解析不出」、第二次成功 | 作业 `succeeded`；账本两行 `attempt 1/2`；观测 `sendAttempts = 1,2`；两次请求体逐字节相同 |
| ② | 两次都解析不出 | 作业 `failed` + `PROVIDER_OUTCOME_UNKNOWN`；账本两行，**不合并** |
| ③ | 422（4xx） | 只打一包、只记一行 |
| ③ | 媒体域 503 | 只打一包、只记一行（`PROVIDER_UNAVAILABLE`） |
| ③ | 内层抛 `CONSENT_REQUIRED` | 只记一行、原样上抛（不重发） |
| ④ | 第一次就成功 | 只打一包、只记一行、`sendAttempts = 1` |
| ⑤ | 重发不被「绝不重发」挡住 | 两次派发的 `attemptKey` 不同（第二包带 `#2`） |
| ⑥ | 作业截止点太近 | 不重发、只一行（余量 500 ms 生效） |

五道闸门（工作树 `E:\GengYunCommander\.pg17\wt-vision-retry`，全部 exit 0）：

| 闸门 | 尾行读数 |
| --- | --- |
| `node --test "tests/unit/recognitions-*.test.mjs"` | `tests 175 / pass 175 / fail 0`（原 167 + 新增 8） |
| `node tests/integration/recognitions-http.mjs` | `PASS`；`concurrent same-key: provider_calls=1`、`concurrent different-body: statuses=[202,409]`、`cancel=3; same-key replay -> 200 cancelled revision=3` |
| `npm run typecheck --workspace @gengyun/api` | `tsc -p tsconfig.json --noEmit`，无输出 |
| `node tools/verify-contract-status.mjs` | `PASS: 覆盖 130 条契约操作；已装配 130 条；implemented 19 / partial 111 / planned 0`、`中文表格一致` |
| `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | `PASS: --strict 下没有基线之外的新增`；`SYMBOL-COVERAGE-VERIFICATION: 可判 1084 条——OK 1040、符号不在区间 44`（基线 44 / 264 / 1338） |

另有 `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` ⇒ `tests 37 / pass 37 / fail 0`（本次文档跟位 17 份、锚点改写 91 处、新增 3 条 `kind: "correction"` 登记）。

## §6 30 次端到端（本机演示栈，real 模式）

做法：`E:\GengYunCommander\.pg17\tmp\e2e15.mjs` 原脚本（`E2E_N=30`、间隔 2 s、串行），全程只走公开 HTTP 契约：`POST /media/uploads` → `PUT` 预签名 → `POST …/complete`（`If-Match`）→ `POST /recognitions` → 每 500 ms 轮询 `GET /jobs/{id}`。栈是既有那套（API `127.0.0.1:38110`、PG `55510`），只换 API 进程（旧进程 `pid 20716` 起于 06:03:56，新进程 `pid 51684`），**没有** `down`/`--reset`、没有重建库。

| 读数 | 值 |
| --- | --- |
| 次数 | 30 |
| `succeeded` | **30** |
| 最终失败（`failed` / `timed_out`） | **0** |
| `uncertain` | 0 |
| `PROVIDER_OUTCOME_UNKNOWN` | **0** |
| 触发重发（`egress_retry` 事件） | **0** |
| 观测 `sendAttempts=1` / `=2` | 30 / 0 |
| 账本行数 | 30 单 × 1 行，`attempt = 1`，`invocation_state = sent` |
| 单次作业耗时 | min 1 706 ms / p50 2 680 ms / max 6 220 ms（30 次合计 90.3 s） |
| 首候选分布 | `species_goosegrass` 28、`species_crabgrass` 2 |

逐次读数（`state` / `error_code` / `jobMs`）：

| # | state | error_code | jobMs | # | state | error_code | jobMs | # | state | error_code | jobMs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | succeeded | – | 3 232 | 11 | succeeded | – | 2 670 | 21 | succeeded | – | 3 221 |
| 2 | succeeded | – | 3 190 | 12 | succeeded | – | 3 675 | 22 | succeeded | – | 4 687 |
| 3 | succeeded | – | 2 683 | 13 | succeeded | – | 2 679 | 23 | succeeded | – | 1 706 |
| 4 | succeeded | – | 2 158 | 14 | succeeded | – | 2 680 | 24 | succeeded | – | 2 670 |
| 5 | succeeded | – | 2 143 | 15 | succeeded | – | 2 637 | 25 | succeeded | – | 2 679 |
| 6 | succeeded | – | 2 651 | 16 | succeeded | – | 3 641 | 26 | succeeded | – | 6 220 |
| 7 | succeeded | – | 2 133 | 17 | succeeded | – | 4 189 | 27 | succeeded | – | 3 171 |
| 8 | succeeded | – | 3 232 | 18 | succeeded | – | 2 139 | 28 | succeeded | – | 2 170 |
| 9 | succeeded | – | 3 168 | 19 | succeeded | – | 3 196 | 29 | succeeded | – | 2 676 |
| 10 | succeeded | – | 3 159 | 20 | succeeded | – | 2 162 | 30 | succeeded | – | 3 712 |

因为 30 单一次都没进重发分支，**「失败单的账本两行」在本次端到端里没有样本**；两行的举证来自 §5 的单测（①、②）。这一点是本页最需要被复核的地方，也是 §9 明列的边界。

## §7 不声称

- 不声称重发能把残余失败率压到某个具体数：30 次里 0 次触发重发，本页对「3% → 千分之一」**没有任何读数支撑**；那是「单次失败率独立同分布」的推算，不是实测。
- 不声称重发能救所有残余失败：只覆盖「已发出但拿不到可用结果」；两次都拿不到就照旧 `PROVIDER_OUTCOME_UNKNOWN`，不再打第三次。
- 不声称供应商不会为第二发计费：这是**客户端**上限 ≤ 2，第二次是真实一次调用；账本两行就是给对账用的，不是免单凭据。
- 不声称适配器放宽了「零重试」剖面：`maxRetries` 仍是 0，重发是作业层第二次**独立派发**（新的 `attemptKey`、新的 `settle`）。
- 不声称公开契约新增了字段：`ProviderOutcome.retryable` 是服务端内部字段，不出现在任何 HTTP 响应里；`/recognitions` 的错误码闭集不变。
- 不声称这是生产观测：全部读数是本机演示栈（单机、real 模式、同一张照片、同一供应商），不是线上容量或可用性证据。

## §8 与既有「零重试」文档口径的差异（要说清）

以下四处正文本次**未改**，但它们与本片的行为存在张力，必须点名：

- `docs/architecture/state-contract.md:50`：「供应商最多一次未知结果调用；仅其明确幂等且有安全账本时有限重试。」
- `docs/architecture/state-contract.md:50`（同段）：「单识别/ASR/问答阶段硬截止30秒」——本片的重发预算 35 s **不**突破它：作业截止点前 500 ms 就不再重发，作业层仍由既有的 `deadline_at` 收口。
- `docs/architecture/adr-001-initial-architecture.md:62`：「无供应商幂等时，不自动重试结果未知的计费调用，记录 `provider_outcome_unknown` 待核对。」
- `docs/architecture/adr-002-recognition-provider-route.md:21`：「`build(本地) → reserve(闸门) → send(恰好一次) → settle(无论成败)`……零重试」。

本片的定位是**一处有界的例外**，不是把「零重试」整体推翻：只对「已发出但拿不到可用结果」这一支、只多一次、每次一行账、35 s 总预算、其余分支（4xx/429/5xx、超时、闸门拒绝、媒体读不出、撤回同意、无预留）全部保持零重试。上一段列的四句正文该不该改写、要不要另起一条 ADR 记这次取舍，本片没有动——见 §9。

## §9 没做到的 / 留给下一片

1. **ADR 与 `state-contract.md` 正文未改**（§8 已点名）。要正式化，需要另一片改 ADR 文本或补一条「有限重发」的决策记录；本片只交证据页，不越过 ADR。
2. **端到端没有覆盖到重发路径**：30 次 0 触发，所以「真供应商第二次能成功」这条只有单测（假 `fetch`）举证。要拿真实读数，得等到线上/演示栈真撞上一次解析失败（本机这 30 次没撞上）。
3. **只做了识别域**：ASR / OCR / TTS / 问答的同类「已发出但拿不到可用结果」没有一起改，各自的重发策略仍是零重试（各自的冻结剖面各说各话）。
4. **没有做退避**：两次派发之间不 sleep。理由是这一支的失败与「立刻再试」无关（上一次已经换了新的 `attemptKey`），加退避只会吃掉 35 s 预算；如果后续观测显示需要退避，那是另一片的事。
