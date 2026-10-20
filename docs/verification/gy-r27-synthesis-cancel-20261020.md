# GY-R27 合成（TTS）域取消能力：改前必红 / 改后实测 / 负控制

- 切片：S9（#13 合成域补 `cancelJob`，接上作业取消面 `POST /api/v1/jobs/{id}/cancel`）
- 分支：`feat/gy-r27-synthesis-cancel`
- 基线：**`upstream/main = 3d72811ab67d133bae5ccd81098163aee9873f82`**（本片开工时是 `13dd429`；作业期间 `#320`→`4b401fc`、`#321`→`3d72811` 两张被合并 ⇒ 按派单 §7 的告警要求**先合流再重跑门禁**，实现按新基线 `git rebase` 过一次，父提交即 `3d72811`，分支仍是**单提交**）
- 合流处理（如实）：`rebase` **无冲突**；`services/api/src/jobs/sources.ts` 现同时含 `#321` 的**转写源** `cancel`（`:107-119`）与本片加的**合成源** `cancel`（`:153-165`），`#321` 的实现**一字未回退**（核对见 §2）；`#321` 新增的 `tests/unit/speech-cancel.test.mjs` 已纳入本页的相邻域回归
- 日期：2026-10-20（本机实测时间）
- 环境：Windows / PowerShell 7 / Node **v24.16.0**（`package.json` engines `>=24.16.0 <25`）/ PostgreSQL 本机可用但**本片未使用**（理由见 §10）
- 跑法（如实）：本会话**未出现** `spawn EPERM`，`node --test <单文件>`（默认逐文件隔离）可用 ⇒ **无跑法降级**（与 S7 证据页的降级口径不同，原因见 §10.1）；跨多文件一律加 `--test-concurrency=1`

---

## 1 结论

1. `POST /api/v1/jobs/{id}/cancel` 对**合成作业**从 **503 `PROVIDER_UNAVAILABLE`「该作业所属能力尚未提供取消（未接线）」** 变为 **200 `cancelled`**，`revision` **恰好 +1**、`error_code` 清空、`result: null`、`ETag` 同步为 `"<新 revision>"`。
2. 域内取消只走 `services/api/src/tts/state.ts` 既有迁移表（`canTransitionJob`），**未新增**任何迁移边、**未新增迁移文件**、**未新增契约字段**、**未改** `docs/architecture/contract-status.json`。
3. 终态（`succeeded`/`uncertain`/`failed`/`timed_out`/`cancelled`）再取消 ⇒ 域内 `OBJECT_UNAVAILABLE`（409），作业源**原样透出**（不再被注册表改写成 503）。
4. 取消**不产生**合成记录；取消后迟到的提供者结果按 revision CAS + 迁移校验落空，**不复活**作业。
5. 合流后取消能力覆盖 **4/6** 个 kind（识别、OCR、转写、合成）；仍无取消能力的是 **审核** 与 **文字问答**——它们的 503 支仍被钉住（§5 第 8 条）。
6. 四条负控制全部**由绿变红**，还原后文件 sha256 与 `git diff HEAD`（空）双双回到原状（`byte_exact_restore=true`）。

## 2 改动面（相对新基线 `3d72811`）

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `services/api/src/tts/service.ts` | +114 / -1 | 新增 `export function requireIfMatch`（与识别/OCR/转写域逐字同口径）＋域内 `cancelJob`（复用既有 `claimIdempotentScope`/`awaitPlaceholder`/`finalize`/`release` 幂等骨架 + `store.updateJob` **单次** CAS）；返回对象追加 `cancelJob`；头部契约清单与 fail-closed 清单各补一条 |
| `services/api/src/jobs/sources.ts` | +28 / -8 | **只动 `createSynthesisJobSource`**：补 `cancel`（域内 `NOT_FOUND ⇒ null`，其余错误原样透出）；该源与其上方 GY-I13 段落注释同步改写（原文「本基线没有取消能力 ⇒ 省略 cancel」已不成立）。合流后本文件同处还有 `#321` 的转写源 `cancel`（**本片未触碰**） |
| `services/api/src/app.ts` | +3 / -2 | **仅注释**：装配点原注释「`cancel` **不提供**（本基线无取消入口）⇒ … 503」已不成立，改为如实描述已接线；**未改任何装配实参**（`createSynthesisJobSource(synthesisService)` 一字未动、6 个源的顺序未动） |
| `tests/unit/tts-cancel.test.mjs` | 新增 17 用例（+565） | 域内取消语义（迁移/恰好 +1/幂等/并发/终态/越权同形/入参 fail-closed）＋`jobs/sources.ts` 适配层与 `jobs/registry.ts` 注册表级接线 |
| `tests/unit/tts-jobs-http.test.mjs` | +215 / -18 | 旧「无取消能力 ⇒ 503 / 缺头 400·428」两条用例按实际情况改写为已接线口径，并新增取消端到端 4 条（逐条对应表见 §6） |
| `docs/verification/gy-r27-synthesis-cancel-20261020.md` | 新增 | 本页 |

合流未回退 `#321` 的核对（实测）：`git grep -n "service.cancelJob" -- services/api/src/jobs/sources.ts` ⇒ **4 处**（`:68` 识别源的 `cancelled` 形态、`:109` **转写源**、`:155` **合成源**、`:211` OCR 源）；`git diff 3d72811 -- services/api/src/jobs/sources.ts` 只包含**合成源**的 hunk 与两处注释，转写源实现未出现在 diff 里。

**未动**（红线）：`docs/architecture/contract-status.json`、任何 `services/api/db/migrations/**`、`packages/contracts/**`、`services/api/src/tts/state.ts`、`services/api/src/tts/store.ts`、`services/api/src/jobs/registry.ts`、`services/api/src/jobs/routes.ts`，以及 `createTranscriptionJobSource`／`createOcrJobSource`／`createRecognitionJobSource` 的函数体。

---

## 3 「改前必红」真实输出（**新基线 `3d72811`**，真跑）

探针：`E:\GengYunCommander\.r27-s9-probe\probe-synthesis-cancel.mjs`（**仓外**，不进 git；不写任何文件）。
做法：`buildApp` 真实装配 + `app.inject` 回环 HTTP；注入一个「闸门替身提供者」（`synthesize()` 挂在 Promise 上），使作业稳定停在 `running`；再 `POST /api/v1/jobs/{id}/cancel`。

只读基线树：`git worktree add --detach E:\GengYunCommander\.r27-s9-probe\wt-base 3d72811…`（`git rev-parse HEAD` 实测=`3d72811ab67d133bae5ccd81098163aee9873f82`；`node_modules` 用目录联接指向可用装配）。

复现命令：

```powershell
cd E:\GengYunCommander\.r27-s9-probe
node probe-synthesis-cancel.mjs E:/GengYunCommander/.r27-s9-probe/wt-base "合流后基线 3d72811ab67d133bae5ccd81098163aee9873f82（改前）"
```

原始输出（全文，未删改）：

```text
===== 探针口径：合流后基线 3d72811ab67d133bae5ccd81098163aee9873f82（改前） =====
worktree: E:/GengYunCommander/.r27-s9-probe/wt-base

--- A1 受理合成作业 POST /api/v1/speech/synthesis
HTTP 202  ETag: "1"
{"data":{"id":"4fbdebad-612d-49a7-bce3-1d40b017694e","revision":1,"kind":"synthesis","target_ref":{"type":"answer","id":"answer-probe-approved","revision":3},"state":"queued","deadline_at":"2026-10-20T08:02:00.000Z","created_at":"2026-10-20T08:00:00.000Z","error_code":null,"result":null},"meta":{"request_id":"eb87ade5-5e6b-4f3a-8b45-18999121956f","contract_version":"1.0.0","execution_mode":"stub"}}

--- A2 作业进入 running（GET /api/v1/jobs/{id}）
HTTP 200  ETag: "2"
{"data":{"id":"4fbdebad-612d-49a7-bce3-1d40b017694e","revision":2,"kind":"synthesis","target_ref":{"type":"answer","id":"answer-probe-approved","revision":3},"state":"running","deadline_at":"2026-10-20T08:02:00.000Z","created_at":"2026-10-20T08:00:00.000Z","error_code":null,"result":null},"meta":{"request_id":"b1d9f1b6-9c63-458a-9c36-37ae0ef1c380","contract_version":"1.0.0","execution_mode":"stub"}}

--- A3 running 作业取消 POST /api/v1/jobs/{id}/cancel（If-Match="2"）
HTTP 503  ETag: null
{"error":{"code":"PROVIDER_UNAVAILABLE","message":"该作业所属能力尚未提供取消（未接线）","retryable":false,"details":[]},"meta":{"request_id":"bc85e0fc-150a-4937-87a3-7a38a8239327","contract_version":"1.0.0","execution_mode":"stub"}}

A3 摘要：status=503 code=PROVIDER_UNAVAILABLE state=(无 data) revision=(无)

--- B1 迟到结果放行后 GET /api/v1/jobs/{id}（取消后不得复活）
HTTP 200  ETag: "3"
{"data":{"id":"4fbdebad-612d-49a7-bce3-1d40b017694e","revision":3,"kind":"synthesis","target_ref":{"type":"answer","id":"answer-probe-approved","revision":3},"state":"succeeded","deadline_at":"2026-10-20T08:02:00.000Z","created_at":"2026-10-20T08:00:00.000Z","error_code":null,"result":{"kind":"synthesis","value":{"id":"536489bd-5840-4a17-bbc6-c77a782e5fcc","revision":1,"checked_content_ref":{"type":"answer","id":"answer-probe-approved","revision":3},"media_id":"00000000-0000-4000-8000-000000000001"}}},"meta":{"request_id":"cf33e31f-e05b-46bb-8a71-4cc1913568e2","contract_version":"1.0.0","execution_mode":"stub"}}

B1 摘要：state=succeeded revision=3 result=(非 null)

--- C1 第二条作业落终态（GET /api/v1/jobs/{id}）
HTTP 200  ETag: "3"
{"data":{"id":"215ca129-6043-4f1a-bb7a-c5e1b02e6f7b","revision":3,"kind":"synthesis","target_ref":{"type":"answer","id":"answer-probe-approved","revision":3},"state":"succeeded","deadline_at":"2026-10-20T08:02:00.000Z","created_at":"2026-10-20T08:00:00.000Z","error_code":null,"result":{"kind":"synthesis","value":{"id":"08acd381-705d-4a2a-bcd6-5ef4bd0fb37b","revision":1,"checked_content_ref":{"type":"answer","id":"answer-probe-approved","revision":3},"media_id":"00000000-0000-4000-8000-000000000002"}}},"meta":{"request_id":"55a1efaa-fcf6-4c60-8719-4366df779100","contract_version":"1.0.0","execution_mode":"stub"}}

--- C2 终态作业取消（If-Match="3"）
HTTP 503  ETag: null
{"error":{"code":"PROVIDER_UNAVAILABLE","message":"该作业所属能力尚未提供取消（未接线）","retryable":false,"details":[]},"meta":{"request_id":"c5912419-9dee-43e6-89da-3bcdc46c66a9","contract_version":"1.0.0","execution_mode":"stub"}}

C2 摘要：status=503 code=PROVIDER_UNAVAILABLE

--- D1 他人作业取消
HTTP 404
{"error":{"code":"NOT_FOUND","message":"作业不存在","retryable":false,"details":[]},"meta":{"request_id":"9a7473e1-b77f-4812-b51f-da216bfcb043","contract_version":"1.0.0","execution_mode":"stub"}}
```

**判据**：`HTTP 503` + `code=PROVIDER_UNAVAILABLE` + `retryable=false` + `etag: null` + 响应体**没有** `data` 投影；取消请求对作业**完全是空操作** —— 迟到结果随后把作业写成 `succeeded`（`B1`：`state=succeeded`、`revision=3`、`result` 非空）⇒ 基线上**没有任何**取消语义。**`#321` 合流后转写域已有取消能力，但合成域仍是 503**（本条即合流后的实测，不是合流前的旧读数）。

> 另：合流前在 `13dd429` 上跑同一探针得到的也是同形 503（`state=(无 data)`、`retryable=false`）；两次读数一致 ⇒ 本片的前提不因 `#320`/`#321` 合流而改变。

---

## 4 「改后」真实输出（同一探针，同一现场，只换代码）

复现命令：

```powershell
cd E:\GengYunCommander\.r27-s9-probe
node probe-synthesis-cancel.mjs E:/GengYunCommander/wt-r27-s9 "改后（feat/gy-r27-synthesis-cancel @ 2019154，父 3d72811）"
```

原始输出（全文，未删改）：

```text
===== 探针口径：改后（feat/gy-r27-synthesis-cancel @ 2019154，父 3d72811） =====
worktree: E:/GengYunCommander/wt-r27-s9

--- A1 受理合成作业 POST /api/v1/speech/synthesis
HTTP 202  ETag: "1"
{"data":{"id":"826d01f5-7c8b-43fa-a934-0ca4685aa21d","revision":1,"kind":"synthesis","target_ref":{"type":"answer","id":"answer-probe-approved","revision":3},"state":"queued","deadline_at":"2026-10-20T08:02:00.000Z","created_at":"2026-10-20T08:00:00.000Z","error_code":null,"result":null},"meta":{"request_id":"99e6ddd6-51a2-418c-82e9-08b64a6635b5","contract_version":"1.0.0","execution_mode":"stub"}}

--- A2 作业进入 running（GET /api/v1/jobs/{id}）
HTTP 200  ETag: "2"
{"data":{"id":"826d01f5-7c8b-43fa-a934-0ca4685aa21d","revision":2,"kind":"synthesis","target_ref":{"type":"answer","id":"answer-probe-approved","revision":3},"state":"running","deadline_at":"2026-10-20T08:02:00.000Z","created_at":"2026-10-20T08:00:00.000Z","error_code":null,"result":null},"meta":{"request_id":"ee21c5ac-c737-44ef-aa40-abd0e3c2c485","contract_version":"1.0.0","execution_mode":"stub"}}

--- A3 running 作业取消 POST /api/v1/jobs/{id}/cancel（If-Match="2"）
HTTP 200  ETag: "3"
{"data":{"id":"826d01f5-7c8b-43fa-a934-0ca4685aa21d","revision":3,"kind":"synthesis","target_ref":{"type":"answer","id":"answer-probe-approved","revision":3},"state":"cancelled","deadline_at":"2026-10-20T08:02:00.000Z","created_at":"2026-10-20T08:00:00.000Z","error_code":null,"result":null},"meta":{"request_id":"8fb5a08b-52da-4464-abaa-b2a7788ac1f4","contract_version":"1.0.0","execution_mode":"stub"}}

A3 摘要：status=200 code=(无 error) state=cancelled revision=3

--- B1 迟到结果放行后 GET /api/v1/jobs/{id}（取消后不得复活）
HTTP 200  ETag: "3"
{"data":{"id":"826d01f5-7c8b-43fa-a934-0ca4685aa21d","revision":3,"kind":"synthesis","target_ref":{"type":"answer","id":"answer-probe-approved","revision":3},"state":"cancelled","deadline_at":"2026-10-20T08:02:00.000Z","created_at":"2026-10-20T08:00:00.000Z","error_code":null,"result":null},"meta":{"request_id":"fe2c6f04-47c0-424c-ae30-064f2245c216","contract_version":"1.0.0","execution_mode":"stub"}}

B1 摘要：state=cancelled revision=3 result=null

--- C1 第二条作业落终态（GET /api/v1/jobs/{id}）
HTTP 200  ETag: "3"
{"data":{"id":"cb15446b-081d-4a57-a5e0-15a953446246","revision":3,"kind":"synthesis","target_ref":{"type":"answer","id":"answer-probe-approved","revision":3},"state":"succeeded","deadline_at":"2026-10-20T08:02:00.000Z","created_at":"2026-10-20T08:00:00.000Z","error_code":null,"result":{"kind":"synthesis","value":{"id":"8d7e8ec5-77d4-4374-a8eb-ec85e8f71653","revision":1,"checked_content_ref":{"type":"answer","id":"answer-probe-approved","revision":3},"media_id":"00000000-0000-4000-8000-000000000002"}}},"meta":{"request_id":"4fca04a7-0af4-42df-b8a8-96264ef4adc9","contract_version":"1.0.0","execution_mode":"stub"}}

--- C2 终态作业取消（If-Match="3"）
HTTP 409  ETag: null
{"error":{"code":"OBJECT_UNAVAILABLE","message":"作业已处于终态 succeeded，不可取消","retryable":false,"details":[]},"meta":{"request_id":"823298fa-a0dd-486c-9cae-94741d2ca3f1","contract_version":"1.0.0","execution_mode":"stub"}}

C2 摘要：status=409 code=OBJECT_UNAVAILABLE

--- D1 他人作业取消
HTTP 404
{"error":{"code":"NOT_FOUND","message":"作业不存在","retryable":false,"details":[]},"meta":{"request_id":"5c45cd4c-a825-4c44-bc7a-a69608bf21b6","contract_version":"1.0.0","execution_mode":"stub"}}
```

**判据**：`HTTP 200` + `etag: "3"`（2 → 3，**恰好 +1**）+ `state:"cancelled"` + `error_code:null` + `result:null`；迟到结果放行后 `state` 仍 `cancelled`、`revision` 仍 3（**不复活、不再自增**）；终态再取消 ⇒ `409 OBJECT_UNAVAILABLE`（**不是** 503）；他人作业仍 `404 NOT_FOUND`（与「不存在」同形）。

> 探针标签里的 `2019154` 是**取证当时**的提交；随后为把本页定稿纳入同一提交做过一次 `--amend`（当前 HEAD 见交付回报）。两次提交的**产品代码逐字相同**（§11 的 blob hash 可复核），故标签保留原样、不追改。

---

## 5 §4 八条语义：逐条机器判据与读数

装配层用例：`tests/unit/tts-cancel.test.mjs`（17 用例）与 `tests/unit/tts-jobs-http.test.mjs`（14 用例，真实 `buildApp` 装配 + 回环 HTTP）。
命令：`node --test tests/unit/tts-cancel.test.mjs`、`node --test tests/unit/tts-jobs-http.test.mjs`（**默认隔离，无降级**）。

| # | 派单 §4 要求 | 判据（用例位置） | 实测读数 |
| --- | --- | --- | --- |
| 1 | `queued`/`running` → `cancelled`，`revision` **恰好 +1**（单次 CAS，不得 +2） | `tts-cancel.test.mjs:132`（用例起点；`:145` 断言 `revision===2`）、`:164`（用例起点；`:188` 断言 `queued→running` 已占一次递增、`:206` 断言 `revision===3`）；`tts-jobs-http.test.mjs:261`（用例起点：`:278` 200、`:284` `cancelled`、`:285` `revision===3`、`:286` `etag==='"3"'`） | `ℹ tests 17 / pass 17 / fail 0`；HTTP `ℹ tests 14 / pass 14 / fail 0`；探针 A3：`status=200 state=cancelled revision=3` |
| 2 | 任一终态再取消 ⇒ 域内 `OBJECT_UNAVAILABLE`，作业源**原样透出**（不得被改写成 503） | `tts-cancel.test.mjs:222`（用例起点；逐态断言 `state`/`revision`/`errorCode` 不变在 `:239-242`）、`:249`（用例起点；`:257` 断言 `status===409`）、`:492`（用例起点；`:506` 断言 `typeof source.cancel==='function'`、`:519` 断言 `status===409`）、`:529`（用例起点；`:537` 断言 `revision===3`、`:548-552` 终态再取消仍 `OBJECT_UNAVAILABLE`）；`tts-jobs-http.test.mjs:317`（用例起点：`:326` 409、`:327` `OBJECT_UNAVAILABLE`、`:328` `notEqual(...,'PROVIDER_UNAVAILABLE')`、`:309-311` 重复取消 409 + `retryable=false`） | 全绿；探针 C2：`status=409 code=OBJECT_UNAVAILABLE`（改前为 503） |
| 3 | 取消**不产出**合成产物记录；迟到提供者结果**不复活**作业 | `tts-cancel.test.mjs:164`（用例起点；`:210` 迟到后 `revision` 仍 3、`:217` `store.getSynthesis(...)` 仍为 `null`）；`tts-jobs-http.test.mjs:336`（用例起点：`:384` `revision===3`、`:388` 仍 3、`:389-393` `result===null` / `error_code===null` / 无合成记录（断言 `:393`）） | 全绿；探针 B1：放行迟到结果后 `state=cancelled revision=3 result=null` |
| 4 | 他人作业与不存在**同形 404**（不得泄露存在性） | `tts-cancel.test.mjs:415`（用例起点；`:450` 断言 `new Set(messages).size===1`、`:453-454` 状态/版本未变）、`:457`（用例起点；`:468-469` 越权不消耗幂等键）；`tts-jobs-http.test.mjs:212`（**未改**用例：`:242-243` 越权取消 404 `NOT_FOUND`）；`tts-cancel.test.mjs:529`（注册表级：`:555-562` 不存在/越权均 `NOT_FOUND`） | 全绿；探针 D1：`HTTP 404 NOT_FOUND`（与不存在同形） |
| 5 | `If-Match` 不符 ⇒ 409；缺 ⇒ 域内既有口径（照 `#321`）即 428；非法 ⇒ 400 | `tts-cancel.test.mjs:346`（用例起点；`:353` 断言 `REVISION_CONFLICT`）、`:366`（用例起点；`:372`/`:377` `IDEMPOTENCY_KEY_REQUIRED`、`:382` `REVISION_REQUIRED`、`:388` `INVALID_REQUEST`）、`:398`（用例起点；`:404-405` 缺失 ⇒ 428 `REVISION_REQUIRED`、`:409-410` 非法 ⇒ 400 `INVALID_REQUEST`）；`tts-jobs-http.test.mjs:427`（用例起点：`:432` 400、`:433` 缺 Key 码、`:436` 428、`:437` 码、`:442` 非法 400） | 全绿 |
| 6 | 重复取消不得 5xx、不得再 +1 revision | `tts-cancel.test.mjs:263`（用例起点；旧 revision ⇒ 409 `REVISION_CONFLICT`、新 revision ⇒ 409 `OBJECT_UNAVAILABLE`，`:291` 断言 `revision` 仍 2）、`:294`（用例起点；`:304` 回放仍 2）、`:311`（用例起点；`:325` 同键异体不改 revision）、`:328`（用例起点；`:337-338` 两方均 2）；`tts-jobs-http.test.mjs:396`（用例起点：`:404`/`:412` 两次 200、`:406`/`:414` `revision` 仍 2、`:420-421` 换键 409 `OBJECT_UNAVAILABLE`） | 全绿（无 5xx：全部为 200/400/409/428） |
| 7 | 取消后 `GET /jobs/{id}` 读到 `state:"cancelled"`、`error_code` 清空 | `tts-cancel.test.mjs:132`（用例起点；`:158-161` `inspectJob` 读回 `cancelled` / `error_code===null` / `result===null`）；`tts-jobs-http.test.mjs:261`（取消后 `:298-303` 再 `GET /jobs/{id}`：`cancelled`、`revision` 3、`error_code:null`、`result:null`） | 全绿；探针 B1：`GET /jobs/{id}` ⇒ `state=cancelled`、`error_code:null` |
| 8 | 合成域既有 503 支**仍被钉住**；审核域 503 钉子不得删 | ① `tests/moderation/http-jobs.test.mjs:163`（用例起点；`:171-176` 断言 503 + `PROVIDER_UNAVAILABLE` + `retryable:false`（`:174`）；本片**一字未改**，单测 `5/5` 绿）；② `tests/unit/jobs-registry.test.mjs:262`（**自造的无取消能力源**独立用例；`:273-275` 断言 503/码/`retryable:false`）与 `:504-526`（OCR 用例内「同一注册表摘掉取消能力源」段；`:523-525` 断言）——本片**未改该文件**，`14/14` 绿；③ `tests/integration/jobs-http.mjs` 组 `[13]`（嵌套 `result.value` 守卫 ⇒ 503 `PROVIDER_UNAVAILABLE`，与「能力未接线」无关，`PASS`）；④ 合成域旧「无取消能力 ⇒ 503」用例按实际情况改为 200（§6 逐条给出前→后），该 503 分支本身另由负控制 D 证明**仍会真的返回**（摘掉合成源 `cancel` ⇒ 同一 HTTP 用例回落到 503） | 全绿（见 §7.2 逐条 exit code） |

> 合流带来的口径变化（如实）：`#321` 已把**转写域**接线，因此 `tests/integration/jobs-http.mjs` 的 `[9]`/`[14]` 在合流后钉的是 **409 `OBJECT_UNAVAILABLE`**（不再是 503）；审核域（`tests/moderation/http-jobs.test.mjs`）与注册表自造源（`jobs-registry.test.mjs`）的 503 钉子**未受影响**，仍是「无取消能力 ⇒ 503」的唯一真实装配载体。

---

## 6 前→后断言对应表（红线 ⑤：**逐条**给出每条旧断言的下场）

被本片改写的既有断言共 **2 个用例、12 条断言**，全部位于 `tests/unit/tts-jobs-http.test.mjs`（旧基线 `13dd429` 的 `:232-248`、`:250-268`；合流未改该文件，故行号不变）。下表逐条列出，**不做一句话概括**。去向四类：**逐字保留**／**同主体强化**（对象不变，只把被本片改变的期望值换掉并追加反向断言）／**保护点迁移**（该断言随 503 语义失效，等价断言仍在别处且实测绿）／**语义翻转**（旧断言钉的正是本片要改的行为）。

### 6.1 旧用例「状态流转·无取消能力：cancel 如实 503 `PROVIDER_UNAVAILABLE`(retryable)，**不伪造 cancelled**、状态与 revision 不变」（旧 `:232-248`）

新用例拆成两条（职责更清楚）：`:261`「取消已接线：running ⇒ 200 cancelled…」与 `:317`「终态（succeeded）作业 cancel ⇒ 409 `OBJECT_UNAVAILABLE`…」。

| # | 旧断言（原文） | 去向 | 新断言 / 替代保护点 |
| --- | --- | --- | --- |
| 1 | `assert.equal(cancelled.status, 503)` | **语义翻转** | `assert.equal(cancelled.status, 200, '取消应 200…')`（`tts-jobs-http.test.mjs:278`） |
| 2 | `assert.equal(cancelled.data.error.code, 'PROVIDER_UNAVAILABLE')` | **语义翻转** | `assert.notEqual(cancelled.data.error?.code, 'PROVIDER_UNAVAILABLE', '取消已接线 ⇒ 绝不得再回「…尚未提供取消」的 503')`（`:279-283`）**＋** `assert.equal(cancelled.data.data.state, 'cancelled')`（`:284`） |
| 3 | `assert.equal(cancelled.data.error.retryable, false, '合成域无取消能力（未接线）⇒ 同一请求重试不会成功…')` | **保护点迁移**（409 响应体同样带 `retryable:false`，故在新断言上重建；503 未接线的 `retryable:false` 仍由审核域／注册表自造源钉住） | `assert.equal(again.data.error.retryable, false)`（`:311`，重复取消 409）＋ 未改一字不动的 `tests/moderation/http-jobs.test.mjs:174`（503 时 `retryable:false`，断言体在 `:173-176`）与 `tests/unit/jobs-registry.test.mjs:275`（`PROVIDER_UNAVAILABLE`/`503` 断言在 `:273-275`；同一口径亦见 `:523-525`，两处实测绿） |
| 4 | `assert.equal(after.state, before.state, '取消能力缺失 ⇒ 状态不得被改动（没有伪造 cancelled）')` | **同主体强化** | 终态用例 `assert.equal(after.state, before.state)`（`:331`，`before=succeeded`，**逐字同一保护**）；另加「成功取消必须恰好改成 cancelled」：`assert.equal(cancelled.data.data.state, 'cancelled')`（`:284`）＋ 缺头用例 `assert.equal(untouched.state, 'queued')`（`:455`，被拒的取消不得改状态） |
| 5 | `assert.equal(after.revision, before.revision, 'revision 不得因失败的取消而递增')` | **同主体强化** | 终态用例 `assert.equal(after.revision, before.revision)`（`:332`，逐字同一保护）＋ 缺头用例 `assert.equal(untouched.revision, 2)`（`:456`）＋ 成功路径的**精确**期望 `assert.equal(cancelled.data.data.revision, 3, 'revision 必须恰好 +1')`（`:285`，比「不变」更强） |
| 6 | `assert.deepEqual(after.result, before.result)` | **逐字保留**（迁入终态用例） | `assert.deepEqual(after.result, before.result, '终态取消不得改动既有结果')`（`:333`） |

### 6.2 旧用例「状态流转·取消能力缺失时缺请求头仍按既有口径：缺 `Idempotency-Key` ⇒ 400；缺 `If-Match` ⇒ 428」（旧 `:250-268`）

新用例：`:427`「取消已接线后，缺/非法请求头仍按既有口径…」。

| # | 旧断言（原文） | 去向 | 新断言 / 替代保护点 |
| --- | --- | --- | --- |
| 1 | `assert.equal(noKey.status, 400)` | **逐字保留** | 同左（`:432`，同一主体同一期望） |
| 2 | `assert.equal(noKey.data.error.code, 'IDEMPOTENCY_KEY_REQUIRED')` | **逐字保留** | 同左（`:433`） |
| 3 | `assert.equal(noVersion.status, 428)` | **逐字保留** | 同左（`:436`） |
| 4 | `assert.equal(noVersion.data.error.code, 'REVISION_REQUIRED')` | **逐字保留** | 同左（`:437`） |
| 5 | `assert.equal(both.status, 503)` | **同主体强化**（主体＝两头齐备的取消；期望值随本片改变） | `assert.equal(stale.status, 409, '旧 revision 应 409…')`（`:449`）＋ 末尾新增正控制 `assert.equal(ok.status, 200)`（`:462`，正确凭据 ⇒ 200 `cancelled`、`:464` `revision===3`） |
| 6 | `assert.equal(both.data.error.code, 'PROVIDER_UNAVAILABLE')` | **同主体强化** | `assert.equal(stale.data.error.code, 'REVISION_CONFLICT')`（`:450`）**＋** `assert.notEqual(stale.data.error.code, 'PROVIDER_UNAVAILABLE')`（`:451`） |

### 6.3 汇总

- 旧断言 12 条：**逐字保留 5 条**（6.1#6、6.2#1-4）、**同主体强化 4 条**（6.1#4、#5，6.2#5、#6）、**语义翻转 2 条**（6.1#1、#2）、**保护点迁移 1 条**（6.1#3，等价断言仍在 3 处并实测绿）。
- **新增断言 4 组**（8 条以上）：终态 409 用例（`:317`）、迟到结果不复活 HTTP 用例（`:336`）、同键回放用例（`:396`）、缺头用例中的「非法 If-Match ⇒ 400」与「被拒请求不改状态/revision」。
- 没有一条旧断言被静默删除：唯一「迁移」项在表里点名了替代位置。
- 「无取消能力 ⇒ 503（`retryable:false`）」这一分支**仍被钉住**，载体是本片**未改一字**的两处真实装配（`tests/moderation/http-jobs.test.mjs`、`tests/unit/jobs-registry.test.mjs` 的自造源）＋负控制 D；`tests/integration/jobs-http.mjs` 的 `[13]` 另钉「坏投影 ⇒ 503」这条**不同**的 503 路径。

---

## 7 「必须真跑」读数

### 7.1 跑法（未降级，如实）

| 项 | 读数 |
| --- | --- |
| `node --test tests/unit/tts-cancel.test.mjs`（**默认隔离**） | 可用，**无** `spawn EPERM`（无需 `--test-isolation=none`） |
| 跨多文件跑法 | 一律 `node --test --test-concurrency=1 <globs>`（本机空闲内存约 2 GB，不加会出 V8 `VirtualAlloc failed` 假红） |

### 7.2 门禁逐条 exit code（合流后重跑）

| # | 门禁（CI job 名） | 命令（本机实跑） | exit | 读数 |
| --- | --- | --- | --- | --- |
| 1 | `unit-tests` | `node --test --test-concurrency=1 "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs" "tests/media/*.test.mjs" "tests/reference/*.test.mjs" "tests/moderation/*.test.mjs"` | **1**（**1 条与本片无关的既有负载敏感假红**，见 §10.2） | `ℹ tests 2912 / pass 2910 / fail 1 / skipped 1`；唯一失败＝`tests/unit/miniprogram-transcript-confirm.test.mjs:422`「页面·记录就绪前与空草稿…」`TypeError: releaseGet is not a function`（该文件本片未改、单独跑 `25/25` 全绿、同一命令在基线树上同样复现） |
| 1b | `unit-tests`（对照：同一命令在只读基线树 `wt-base`=`3d72811`） | 同上（cwd 指向基线树） | **1** | `ℹ tests 2892 / pass 2890 / fail 1 / skipped 1`，唯一失败**同为** `tests/unit/miniprogram-transcript-confirm.test.mjs:422` 的同一 `TypeError` ⇒ 该假红与本片无关（§10.2 基线对照原文） |
| 2 | `unit-tests`（本片新增文件，默认隔离） | `node --test tests/unit/tts-cancel.test.mjs` | **0** | `ℹ tests 17 / pass 17 / fail 0` |
| 3 | `unit-tests`（本片改写文件，默认隔离） | `node --test tests/unit/tts-jobs-http.test.mjs` | **0** | `ℹ tests 14 / pass 14 / fail 0` |
| 4 | `unit-tests`（相邻域回归：`#321` 新增） | `node --test tests/unit/speech-cancel.test.mjs` | **0** | `ℹ tests 11 / pass 11 / fail 0` |
| 5 | `integration-http` | `node tests/integration/jobs-http.mjs` | **0** | `PASS 15 loopback HTTP groups`；含 `PASS [9] 转写域**已接线取消**（GY-R27）：已终态作业 cancel ⇒ 409 OBJECT_UNAVAILABLE`、`PASS [14] …两头齐备 ⇒ 409 OBJECT_UNAVAILABLE`、`PASS [13] …嵌套 result.value ⇒ 经路由 503` |
| 6 | `integration-http` | `node tests/integration/tts-http.mjs` | **0** | `CHECKS pass=42 fail=0`、`RESULT=PASS 真实产品装配（buildApp）+ 本机回环 HTTP` |
| 7 | `integration-http`（相邻域回归） | `node tests/integration/speech-http.mjs` | **0** | `PASS 15 loopback HTTP groups`（转写域既有行为未变） |
| 8 | `contract-tests` | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | **0** | `ℹ tests 6 / pass 6 / fail 0` |
| 9 | `static-check` | `node tools/lint-workspaces.mjs` | **0** | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描` / `lint 通过` |
| 10 | `build`（类型检查面） | `npx tsc -p services/api/tsconfig.json --noEmit` | **0** | 无输出（0 诊断） |
| 11 | `docs` | `node tools/run-python.mjs tools/validate_development_docs.py` | **0** | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| 12 | `docs` | `node tools/run-python.mjs tools/validate_contracts.py` | **0** | `PASS: 112 operations; contract consistency; …` |
| 13 | `docs` | `node tools/run-python.mjs tools/test_contracts.py` | **0** | `Ran 8 tests … OK` |

> 未跑 `npm run <script>` 形态（该形态经 npm 子进程包装）：本会话下 `node <脚本>` / `node --test` 直跑等价且更少噪声；CI 侧仍是同一批命令（见 `.github/workflows/engineering-shell.yml`）。

---

## 8 负控制（4 条，含 `byte_exact_restore` 证据；**在合流后的树上重做**）

统一手法：
1. 变异前把两个产品文件与 `git diff HEAD`（此时应为**空**，因为改动已提交）各存一份到仓外（`.r27-s9-probe\negctl\`），取 sha256；
2. 施加**单点变异**；
3. 跑用例（默认隔离）⇒ 必须变红，贴原始失败行；
4. `Copy-Item <orig> <目标> -Force` 还原；
5. 复核：文件 sha256 与 `git diff HEAD`**双双**回到变异前读数（后者应为空），并重跑复绿。

- 变异前 `services/api/src/tts/service.ts` sha256：`EBA9F578A0530BE3A5273B248305C737B0B4518A5F874C3B838F8DF8A7FC6398`
- 变异前 `services/api/src/jobs/sources.ts` sha256：`2E49A41F1C53B450F803B3B728A106440DB62417FF0BBB91DD823FF92B086A7B`
- 变异前 `git diff HEAD` sha256：`E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855`（即**空 diff**）

| # | 变异点 | 变红输出（原始） | 还原证据 |
| --- | --- | --- | --- |
| A | `tts/service.ts`：`revision: current.revision + 1` → **`+ 2`**（取消多推一次版本） | `tts-cancel`：`ℹ tests 17 / pass 8 / fail 9`，exit **1**；原始行：`AssertionError [ERR_ASSERTION]: revision 必须从 1 恰好递增到 2`；`AssertionError [ERR_ASSERTION]: revision 必须从 2 恰好递增到 3（单次 CAS，不得 +2）`；另 7 条同因变红 | `restored-sha256=EBA9F578…398`（＝变异前）、`git diff HEAD` 恢复为**空**（`diff-after-A.txt` 长度 0）⇒ `byte_exact_restore=true`；重跑 `ℹ tests 17 / pass 17 / fail 0`、exit 0 |
| B | `tts/service.ts`：**整体删除两道 guard**（`isTerminalJobState(row.state)` 与 `canTransitionJob(row.state,'cancelled')` 的 `OBJECT_UNAVAILABLE` 分支） | 域内：`ℹ tests 17 / pass 13 / fail 4`，exit **1**：`Missing expected rejection.`（五终态）、`终态取消必须抛错`、`Missing expected rejection.`（已 cancelled 再取消 / 注册表级终态再取消）。HTTP：`ℹ tests 14 / pass 11 / fail 3`，exit **1**：`重复取消必须 409（对象当前不可取消），实际 200`；`终态取消应 409，实际 200：{"data":{…,"revision":4,…,"state":"cancelled",…}}`（终态作业被**真的第二次取消**，`revision` 3→4） | `restored-sha256=EBA9F578…398`、`git diff HEAD` 恢复为空 ⇒ `byte_exact_restore=true`；重跑 17/17 与 14/14 绿。**注意**：只删其中**一处**不会变红（两道 guard 互为冗余：`canTransitionJob` 对终态一律返回 false）⇒ 终态不可取消有**两道**机器判据 |
| C | `tts/service.ts`：取消时**不清空** `error_code`（`errorCode: null` → `errorCode: current.errorCode`） | 域内：`ℹ tests 17 / pass 16 / fail 1`，exit **1**：`AssertionError [ERR_ASSERTION]: 取消不是错误，必须清空 error_code`。HTTP：`ℹ tests 14 / pass 13 / fail 1`，exit **1**：`AssertionError [ERR_ASSERTION]: 取消不是错误 ⇒ error_code 必须清空` | 同上（`byte_exact_restore=true`）；重跑 17/17 绿 |
| D | `jobs/sources.ts`：把 `createSynthesisJobSource` 的 `cancel` **整段摘掉**（回到接线前形态） | HTTP：`ℹ tests 14 / pass 9 / fail 5`，exit **1**：`取消应 200，实际 503：{"error":{"code":"PROVIDER_UNAVAILABLE","message":"该作业所属能力尚未提供取消（未接线）","retryable":false,"details":[]},…}`（本片 4 条 HTTP 用例同形态复现）＋`终态取消应 409，实际 503`＋`旧 revision 应 409，实际 503`。域内：`ℹ tests 17 / pass 15 / fail 2`（适配层/注册表级两条），exit **1** | `restored-sha256=2E49A41F…A7B`（＝变异前）、`git diff HEAD` 恢复为空 ⇒ `byte_exact_restore=true`；重跑 14/14 与 17/17 绿 |

三次改 `tts/service.ts` 的变异（A/B/C）都还原到同一 sha256 `EBA9F578…398`；唯一改 `jobs/sources.ts` 的变异（D）还原到 `2E49A41F…A7B`；四次还原后的 `git diff HEAD` **均为空**（逐次记录在仓外 `diff-after-{A,B,C,D}.txt`）。

负控制原始输出文件（仓外）：`.r27-s9-probe\negctl\negctl-A.txt`、`negctl-B-domain.txt`、`negctl-B-http.txt`、`negctl-C-domain.txt`、`negctl-C-http.txt`、`negctl-D-http.txt`、`negctl-D-domain.txt`。

---

## 9 迁移 / 契约 / 持久化

- **不需要新增迁移**（派单 §2 已核，本片复核一致）：`job_state` 枚举早已含 `cancelled`（`services/api/db/migrations/0001_initial_schema.sql:24`）；本片**未新增/未改**任何迁移文件（提交里没有任何 `services/api/db/migrations/**` 路径）。
- 契约：`POST /jobs/{id}/cancel` 早已存在（`services/api/src/jobs/routes.ts:64-80`），本片只补域内实现与作业源接线，**未新增契约字段**、未改 `packages/contracts/**`。
- 状态机：取消迁移**只**走 `services/api/src/tts/state.ts` 的 `canTransitionJob`（`queued: [...,'cancelled']`、`running: [...,'cancelled']`、`cancelled: []`）；`state.ts` 本片**一字未改**。
- 持久化：合成任务与记录在本基线是**内存 store**（`services/api/src/tts/store.ts` 的 `createMemorySynthesisStore()`，`persistent: false`）⇒ 本片的取消语义**不涉及 PG 读写**，因此没有 PG 读数（见 §10）。

## 10 未取得项（如实）

1. **跑法降级：未发生**（与 S7 证据页相反）：本会话 `node --test <单文件>`（默认隔离）实测可用 ⇒ 全部单测读数都是默认跑法。S7 的 `spawn EPERM` 属其会话沙箱，本会话未复现 ⇒ 本片**不需要**登记降级。
2. **全量单测**：**已取得，但含 1 条与本片无关的既有负载敏感假红**（可复现，且有基线对照）：
   - 本片 HEAD（`2019154`）：`ℹ tests 2912 / pass 2910 / fail 1 / skipped 1`，exit **1**；唯一失败 `tests/unit/miniprogram-transcript-confirm.test.mjs:422` ⇒ `TypeError: releaseGet is not a function`（该用例把记录 GET 扣成未 resolve 的 promise，再假设「2 次微任务冲刷后」`releaseGet` 已被赋值；本机负载高时轮询尚未发出，`releaseGet` 仍为 `null`）。
   - 该文件**本片未改**（`git log -1 -- tests/unit/miniprogram-transcript-confirm.test.mjs` ⇒ `16e19cf`，`#294`），单独跑 `ℹ tests 25 / pass 25 / fail 0`。
   - **基线对照**：同一命令在只读基线树 `wt-base`（`3d72811`）上同样复现同一失败 ⇒ 属**既有负载敏感用例**，非本片引入（原始读数见下方「基线对照」）。
   - 唯一 `skipped 1` 为既有 PG 用例（`native separate-connection withdrawal…`），非本片。
3. **真实 PostgreSQL 读数**：**未取得**，且判定**本片不需要**（无迁移；合成 store 为内存实现 `persistent: false`）。未做任何「已接入 PG」的声称。
4. **真实 TTS 音频 / 真机 / 听感**：**未取得**（本片不涉及；所有提供者均为**明确标注的替身或闸门替身**，产物 MIME 为 `application/x-gengyun-tts-substitute`，不构成任何音质/自然度证据）。
5. **CI 读数**：**未取得**（按派单要求不推送、不开 PR，只交代码与证据）。
6. **合流后基线前进**：已发生并被处理（`13dd429` → `3d72811`，见页首）；`rebase` 后**单提交**，父提交＝`3d72811`。收工前 `git rev-parse upstream/main` 实测仍为 `3d72811`（未再前进）。
7. **遗留（不在本片权限内，点名位置，供批次统一收口）**：两处架构文档仍写着「合成域无取消入口」，本片**未改**（派单红线只豁免 `contract-status.json`，且本批按「统一收口」口径不擅动同批他人可能同时改的文档）：
   - `docs/architecture/contract-implementation-status.md:17`：「取消仅识别；转写/合成/OCR 取消503 `PROVIDER_UNAVAILABLE`」
   - `docs/architecture/contract-implementation-status.md:89`（`createSynthesis` 行）：「**取消**仍未接线（合成域无取消入口）」
   - `docs/architecture/contract-status.json`（`cancelJob` 条目）按派单红线条**未动**。

**基线对照**（§10.2 第 3 点的实测依据）：

```text
# A) 本片 HEAD（含本片全部改动）
$ cd E:\GengYunCommander\wt-r27-s9
$ node --test --test-concurrency=1 "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs" "tests/media/*.test.mjs" "tests/reference/*.test.mjs" "tests/moderation/*.test.mjs"
ℹ tests 2912
ℹ pass 2910
ℹ fail 1
ℹ cancelled 0
ℹ skipped 1
✖ failing tests:
test at tests\unit\miniprogram-transcript-confirm.test.mjs:422:1
✖ 页面·记录就绪前与空草稿 ⇒ 零 PATCH、零轮次请求（未明确确认不外发）
  TypeError: releaseGet is not a function

# B) 只读基线树 wt-base（3d72811，无本片任何改动），同一命令
$ cd E:\GengYunCommander\.r27-s9-probe\wt-base
$ node --test --test-concurrency=1 "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs" "tests/media/*.test.mjs" "tests/reference/*.test.mjs" "tests/moderation/*.test.mjs"
ℹ tests 2892
ℹ pass 2890
ℹ fail 1
ℹ cancelled 0
ℹ skipped 1
✖ failing tests:
test at tests\unit\miniprogram-transcript-confirm.test.mjs:422:1
✖ 页面·记录就绪前与空草稿 ⇒ 零 PATCH、零轮次请求（未明确确认不外发）
  TypeError: releaseGet is not a function
```

**对照结论**：基线（2892 条）与本片 HEAD（2912 条，+20 条＝本片新增 17 条＋改写文件净增 3 条）**同样是这 1 条失败、同一个 `TypeError`** ⇒ 该假红与本片无关，是既有用例在**本机高负载**下的竞态；本片自身新增/改写的 31 条用例全绿。

## 11 复现命令与冻结指纹

```powershell
# 1) 单文件（默认隔离，未降级）
cd E:\GengYunCommander\wt-r27-s9
node --test tests/unit/tts-cancel.test.mjs
node --test tests/unit/tts-jobs-http.test.mjs
node --test tests/unit/speech-cancel.test.mjs

# 2) 全量单测（必加 --test-concurrency=1）
node --test --test-concurrency=1 "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs" "tests/media/*.test.mjs" "tests/reference/*.test.mjs" "tests/moderation/*.test.mjs"

# 3) 集成与静态门禁
node tests/integration/jobs-http.mjs
node tests/integration/tts-http.mjs
node tests/integration/speech-http.mjs
node --test --test-concurrency=1 "tests/contract/*.test.mjs"
node tools/lint-workspaces.mjs
npx tsc -p services/api/tsconfig.json --noEmit
node tools/run-python.mjs tools/validate_development_docs.py
node tools/run-python.mjs tools/validate_contracts.py
node tools/run-python.mjs tools/test_contracts.py

# 4) 改前/改后探针（仓外脚本）
cd E:\GengYunCommander\.r27-s9-probe
node probe-synthesis-cancel.mjs E:/GengYunCommander/wt-r27-s9 "改后"
# 改前（基线只读树；本页取证用的那棵在交付前删除，重建方式见下）
cd E:\GengYunCommander\wt-r27-s9
git worktree add --detach E:\GengYunCommander\.r27-s9-probe\wt-base 3d72811ab67d133bae5ccd81098163aee9873f82
cmd /c mklink /J E:\GengYunCommander\.r27-s9-probe\wt-base\node_modules E:\GengYunCommander\wt-r27-smoke\node_modules
cd E:\GengYunCommander\.r27-s9-probe
node probe-synthesis-cancel.mjs E:/GengYunCommander/.r27-s9-probe/wt-base "基线"
# 用完删除：先枚举重解析点并逐个 `cmd /c rmdir` 摘链（⛔ 联接存在时不得 --force），再 git worktree remove
```

跨平台可复现的冻结指纹（**blob hash，不是工作区 sha256**；LF 归一化由 git 完成）：

| 文件 | `git hash-object -- <path>`（提交后实测） |
| --- | --- |
| `services/api/src/tts/service.ts` | `c85b516790e0fa35e6b142daee5611c53a5e216f` |
| `services/api/src/jobs/sources.ts` | `6d2b9339dbe9b1195f59b40a20e5c10e24250ae6` |
| `services/api/src/app.ts` | `ddde97b49b5d87d90fa4c0d54297b57b1445fd25` |
| `tests/unit/tts-cancel.test.mjs` | `79ca75f7575ce6d4c66a12789299c8cd0e2558d3` |
| `tests/unit/tts-jobs-http.test.mjs` | `d54997447fd4d0682d0ccae6be997281aa0adbdb` |
| `docs/verification/gy-r27-synthesis-cancel-20261020.md` | 本页定稿后由 `git hash-object` 现取，写在交付回报里 |

> 逐字复核方式：`git rev-parse HEAD:<path>` 必须与上表同一行**逐字相同**（交付时已复核，结果写在回报里）。

## 12 清理清单

- 保留（随提交入库）：本证据页、2 个产品文件、1 个装配点注释、1 个新增测试文件、1 个改写测试文件。
- 仓外临时物（**不进仓库、不影响 `git status`**）：`E:\GengYunCommander\.r27-s9-probe\`（探针脚本 1 个、改前/改后原始输出 2 份、负控制输出 7 份、`*.orig` 快照 2 份、`diff-*.txt` 5 份、全量单测日志 3 份、基线对照日志 1 份）。
- worktree `E:\GengYunCommander\wt-r27-s9` 里有一条 **`node_modules` 目录联接**指向 `E:\GengYunCommander\wt-r27-smoke\node_modules`（本会话无网、无法 `npm ci`；联接不是仓库内容，`git status --porcelain` 为 0 行）。**删除该 worktree 前必须先** `cmd /c rmdir node_modules` 摘链（⛔ 联接存在时不得 `git worktree remove --force`）。
- 基线只读树 `E:\GengYunCommander\.r27-s9-probe\wt-base`（`3d72811`，仅用于改前取证与基线对照）：使用后按上述顺序摘链删除。

## 13 行号引用复核记录（返修 r1：**仅文档改动，零代码改动**）

本页所有 `file:line` 引用都按下面这条命令重新算过一遍，**不沿用任何早先读数**（早先那批是在新增 2 个适配层用例与「闸门 try/finally」之前取的，因此尾部整体偏移）：

```powershell
# 取出**已提交**版本（不是工作区），逐条打印被引用行与 test() 起点
cd E:\GengYunCommander\wt-r27-s9
git show HEAD:tests/unit/tts-cancel.test.mjs      > $env:TEMP\s9-cancel.mjs
git show HEAD:tests/unit/tts-jobs-http.test.mjs   > $env:TEMP\s9-http.mjs
git show HEAD:tests/unit/jobs-registry.test.mjs   > $env:TEMP\s9-reg.mjs
git show HEAD:tests/moderation/http-jobs.test.mjs > $env:TEMP\s9-mod.mjs
# 「旧基线」那两处范围必须用 13dd429 取，不能用 HEAD
git show 13dd429:tests/unit/tts-jobs-http.test.mjs > $env:TEMP\s9-http-base.mjs
# 然后对每个引用行号 n：$l[$n-1].Trim()；并枚举 `^test\(` 取得用例边界
```

复核读数（**含本节复核表在内**的最终页面）：页内 `file:line` 引用共 **172 处**（131 处带显式文件名 + 41 处同一行内省略文件名的 `:N`），去重后 **102 组**（文件, 行/范围）；**全部可在 `HEAD`（旧基线两处为 `13dd429`）当场核到同一语义**。

订正 **9 组**（旧 → 新），其中 6 组为审查指出、3 组为本页自审发现：

| # | 位置 | 旧引用（错在） | 新引用（实测） | 实测依据（该行原文） |
| --- | --- | --- | --- | --- |
| 1 | §5 第 4 条 | `tts-cancel.test.mjs:398`（那是「缺 If-Match ⇒ 428／非法 ⇒ 400」用例） | **`:415`**（`:450` 断言） | `test('越权与不存在同形 NOT_FOUND（同码同文案…` / `assert.equal(new Set(messages).size, 1, …)` |
| 2 | §5 第 4 条 | `:415`（同形 404 用例） | **`:457`**（`:468-469` 断言） | `test('越权请求不消耗 Idempotency-Key：属主随后用同一键可以正常取消'` |
| 3 | §5 第 5 条 | `:474`（那是「只走契约既有迁移边」用例） | **`:398`**（`:404-405`/`:409-410` 断言） | `test('缺 If-Match 的 HTTP 状态是 428、非法是 400（与识别/OCR/转写域同一口径）'` |
| 4 | §5 第 8 条 | `jobs-registry.test.mjs:477-499`（那段是 **OCR 已接线**用例，断言 200/409/404 —— **相反语义**） | **`:504-526`**（`:523-525` 断言 503/码/`retryable:false`） | `// 原用例语义改由**无取消能力**的合成源承载…` / `assert.equal(error?.code, 'PROVIDER_UNAVAILABLE');` |
| 5 | §6.1 第 3 条 | `jobs-registry.test.mjs:498`（那是「作业不存在 ⇒ 404」注释 —— **相反语义**） | **`:275`**（另见 `:523-525`） | `assert.equal(error?.retryable, false, '能力未接线属"需运维改配置"…')` |
| 6 | §5 第 6 条 | `tts-jobs-http.test.mjs:405`/`:413`（那是 `state==='cancelled'`）、`:421`（那是错误码行） | **`:404`/`:412`**（200）、**`:406`/`:414`**（`revision===2`）、**`:420-421`**（409 + `OBJECT_UNAVAILABLE`） | `assert.equal(first.status, 200);` / `assert.equal(first.data.data.revision, 2);` / `assert.equal(again.status, 409);` |
| 7 | §5 第 3 条（审查的非阻塞项） | `:389-391`（末尾落在注释行） | **`:389-393`**（断言在 `:393`） | `assert.equal(await h.store.getSynthesis(row.synthesisId), null, '取消后不得写入合成记录');` |
| 8 | §5 第 8 条 ① | `http-jobs.test.mjs:163-175`（`:175` 落在多行断言体内，范围端点不准） | **`:163`** + **`:171-176`**（`:174`） | `assert.equal(cancelled.status, 503);` … `cancelled.data.error.retryable,` / `false,` |
| 9 | §5 第 2 条 | `tts-cancel.test.mjs:555-562`（那是该用例的 **404 段**） | **`:548-552`**（`OBJECT_UNAVAILABLE` 段） | `await assertApiError(` / `registry.cancel({… jobId: job.id, ifMatch: '"3"' …})` / `'OBJECT_UNAVAILABLE',` |

另有 1 处**歧义消解**（非错行）：§5 第 4 条末尾原先的裸 `:529` 已写明文件为 `tts-cancel.test.mjs:529`（该用例的注册表级 404 段在 `:555-562`）。

同时把「用例起点」与「断言所在行」分开标注（例如 `:492`（用例起点；`:506`/`:519` 断言）），使复核者不必再猜哪一行才是断言。

