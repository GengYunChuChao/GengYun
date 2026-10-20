# GY-R27 语音转写域取消能力：改前必红 / 改后实测 / 负控制

- 切片：S7（#11 语音转写域补 `cancelJob`，接上作业取消面 `POST /jobs/{id}/cancel`）
- 分支：`feat/gy-r27-speech-cancel`
- 基线：`upstream/main` 实测 **`13dd429a02db57953ad604e17951901ebbc9d2ab`**（派单原文写 `ba6ea9f`；指挥 2026-10-20 实测通知基线已前进到 `13dd429`，本片按通知以 `13dd429` 为父提交）。
  `git diff --stat ba6ea9fc73600b5b4696083bc38902396f7c0a5d 13dd429` 显示二者差异**只**在 CI workflow、四份 `docs/verification/*.md`、`tests/integration/{admin-accounts-read-pg,admin-flags-pg,recognition-chain-e2e}.mjs`、`tests/unit/{ci-integration-chain-structure,ci-real-pg-wiring}.test.mjs`；**未触碰** `services/api/src/speech/*` 与 `services/api/src/jobs/sources.ts` ⇒ 本页的「改前」读数对两个基线等价。
- 日期：2026-10-20（本机实测时间）
- 环境：Windows / PowerShell 7 / Node **v24.16.0**（`package.json` engines `>=24.16.0 <25`）/ PostgreSQL 17.11 本机可用（**本片未使用**，理由见「未取得项」）。
- 跑法降级（如实）：本会话沙箱下 `node --test <单文件>`（默认逐文件隔离）**必然** `spawn EPERM`（见 §7.1 报错原文），故全部单测读数用 **`node --test --test-isolation=none <单文件>`**；集成脚本用 `node <脚本>` 直接跑（不经 `npm run`）。

---

## 1 结论

1. `POST /api/v1/jobs/{id}/cancel` 对**转写作业**从 **503 `PROVIDER_UNAVAILABLE`「该作业所属能力尚未提供取消（未接线）」** 变为 **200 `cancelled`**，`revision` **恰好 +1**、`error_code` 清空、`result: null`。
2. 域内取消只走 `services/api/src/speech/state.ts` 既有迁移表（`canTransitionJob`），**未新增**任何迁移边、**未新增迁移文件**、**未新增契约字段**。
3. 终态（`succeeded`/`uncertain`/`failed`/`timed_out`/`cancelled`）再取消 ⇒ 域内 `OBJECT_UNAVAILABLE`，作业源**原样透出**（不再被注册表改写成 503）。
4. 取消**不产生转写记录**；取消后迟到的提供者结果按 revision CAS + 迁移校验落空，**不复活**作业。
5. 三条负控制全部**由绿变红**，且还原后逐字节回到原状（文件 sha256 与 `git diff` sha256 双双相同，`byte_exact_restore=true`）。

## 2 改动面

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `services/api/src/speech/service.ts` | +67 行 | 新增域内 `cancelJob`（复用既有 `runIdempotentWrite` 幂等骨架 + `store.updateJob` 单次 CAS）；返回对象追加 `cancelJob`；头部契约清单补一行 |
| `services/api/src/jobs/sources.ts` | +29 / -? 行 | 转写源补 `cancel`（`NOT_FOUND ⇒ null`，其余错误原样透出）；该源上方「本基线没有取消能力 ⇒ 省略 cancel ⇒ 503」注释同步改写 |
| `tests/unit/speech-cancel.test.mjs` | 新增 11 用例 | 域内取消语义：状态迁移 / revision 恰好 +1 / 幂等重放 / 并发 / 终态 / 越权同形 / 入参 fail-closed / 迁移边 |
| `tests/unit/jobs-registry.test.mjs` | 1 用例改写 | 旧断言「转写域不暴露 cancel」→ 新断言「已接线 + 注册表 200」（对应表见 §5） |
| `tests/integration/jobs-http.mjs` | 2 组改写 | `[9]` 转写域终态取消 503→409；`[14]` 请求头错误码钉子第三支 503→409（对应表见 §5） |
| `tests/integration/speech-http.mjs` | 新增 `[14]` 组 | 真实装配 + 回环 HTTP 的端到端：`running` 作业 `POST /jobs/{id}/cancel` ⇒ 200 `cancelled`，并覆盖同键重放、终态 409、迟到结果不复活、无转写记录 |

**未动**（红线）：`docs/architecture/contract-status.json`、任何 `services/api/db/migrations/**`、`services/api/src/speech/state.ts`、`services/api/src/speech/store.ts`、`services/api/src/jobs/sources.ts` 的 `createSynthesisJobSource`。

---

## 3 「改前必红」真实输出（基线 `13dd429`，真跑）

探针：`E:\GengYunCommander\.pg17\tmp-r27-s7\probe-cancel-http.mjs`（**仓外**，不进 git）。
做法：`buildApp` 真实装配 + 本机回环真实 HTTP；注入一个「闸门提供者」（`transcribe()` 挂在 Promise 上），使作业稳定停在 `running`；再 `POST /api/v1/jobs/{id}/cancel`。

复现命令（基线只读 worktree `E:\GengYunCommander\.pg17\wt-r27-s7-base`，`git rev-parse HEAD` = `13dd429a02db57953ad604e17951901ebbc9d2ab`）：

```powershell
cd E:\GengYunCommander
$env:PROBE_ROOT='../../.pg17/wt-r27-s7-base/services/api/src/'
node .pg17/tmp-r27-s7/probe-cancel-http.mjs
Remove-Item Env:\PROBE_ROOT
```

原始输出（全文，未删改）：

```text
ORIGIN http://127.0.0.1:53199
CREATE status=202 job=af0e5ddf-33eb-4470-bb91-d308dbe25b1c transcription=d7b60879-4d35-43b1-a765-ebc6215ba3eb
BEFORE status=200 etag="2" state=running revision=2
---- CANCEL RAW RESPONSE ----
HTTP 503
etag: null
cache-control: no-store
content-type: application/json; charset=utf-8
body: {"error":{"code":"PROVIDER_UNAVAILABLE","message":"该作业所属能力尚未提供取消（未接线）","retryable":false,"details":[]},"meta":{"request_id":"1d1ad2b7-8e05-43b1-9dc7-508511ced299","contract_version":"1.0.0","execution_mode":"stub"}}
---- AFTER LATE RESULT ----
GET /jobs/{id} HTTP 200 etag="3"
body: {"data":{"id":"af0e5ddf-33eb-4470-bb91-d308dbe25b1c","revision":3,"kind":"transcription","target_ref":{"type":"transcription","id":"d7b60879-4d35-43b1-a765-ebc6215ba3eb","revision":1},"state":"succeeded","deadline_at":"2026-10-20T07:27:22.660Z","created_at":"2026-10-20T07:26:52.660Z","error_code":null,"result":{"kind":"transcription","value":{"id":"d7b60879-4d35-43b1-a765-ebc6215ba3eb","revision":1,"raw_text":"替身示例·探针迟到结果（非真实录音）","uncertain_spans":[],"confirmed_text":null,"confirmed_at":null,"model_version":"stub-v1"}}},"meta":{"request_id":"0a732f39-557e-4775-9d20-b55cf3275912","contract_version":"1.0.0","execution_mode":"stub"}}
---- TRANSCRIPTION RECORD ----
GET /speech/transcriptions/{id} HTTP 200
body: {"data":{"id":"d7b60879-4d35-43b1-a765-ebc6215ba3eb","revision":1,"raw_text":"替身示例·探针迟到结果（非真实录音）","uncertain_spans":[],"confirmed_text":null,"confirmed_at":null,"model_version":"stub-v1"},"meta":{"request_id":"ff6f4787-3a29-4abe-ba1a-be4d2caa5de9","contract_version":"1.0.0","execution_mode":"stub"}}
```

**判据**：`HTTP 503` + `code=PROVIDER_UNAVAILABLE` + `retryable=false` + `etag: null`；作业状态**未被取消**（迟到结果把它写成 `succeeded`，并产出了转写记录，`GET /speech/transcriptions/{id} HTTP 200`）⇒ 「取消」在基线上**完全是空操作**。

---

## 4 「改后」真实输出（同一探针，同一现场，只换代码）

复现命令（改后分支，默认根）：

```powershell
cd E:\GengYunCommander
node .pg17/tmp-r27-s7/probe-cancel-http.mjs
```

原始输出（全文）：

```text
ORIGIN http://127.0.0.1:62991
CREATE status=202 job=73bcc8a2-8ba3-40d2-8364-42a198d9f564 transcription=66c46787-2dba-480a-93b6-436ebec75fcf
BEFORE status=200 etag="2" state=running revision=2
---- CANCEL RAW RESPONSE ----
HTTP 200
etag: "3"
cache-control: no-store
content-type: application/json; charset=utf-8
body: {"data":{"id":"73bcc8a2-8ba3-40d2-8364-42a198d9f564","revision":3,"kind":"transcription","target_ref":{"type":"transcription","id":"66c46787-2dba-480a-93b6-436ebec75fcf","revision":1},"state":"cancelled","deadline_at":"2026-10-20T07:27:24.367Z","created_at":"2026-10-20T07:26:54.367Z","error_code":null,"result":null},"meta":{"request_id":"5f42c879-64ad-41fd-af16-42abcc665b98","contract_version":"1.0.0","execution_mode":"stub"}}
---- AFTER LATE RESULT ----
GET /jobs/{id} HTTP 200 etag="3"
body: {"data":{"id":"73bcc8a2-8ba3-40d2-8364-42a198d9f564","revision":3,"kind":"transcription","target_ref":{"type":"transcription","id":"66c46787-2dba-480a-93b6-436ebec75fcf","revision":1},"state":"cancelled","deadline_at":"2026-10-20T07:27:24.367Z","created_at":"2026-10-20T07:26:54.367Z","error_code":null,"result":null},"meta":{"request_id":"90a2a4d3-3b6c-4f67-82f0-e41e02f9d138","contract_version":"1.0.0","execution_mode":"stub"}}
---- TRANSCRIPTION RECORD ----
GET /speech/transcriptions/{id} HTTP 404
body: {"error":{"code":"NOT_FOUND","message":"转写记录不存在","retryable":false,"details":[]},"meta":{"request_id":"a01e6fd2-a89a-428f-9565-f41fe227203a","contract_version":"1.0.0","execution_mode":"stub"}}
```

**判据**：`HTTP 200` + `etag: "3"`（2 → 3，**恰好 +1**）+ `state:"cancelled"` + `error_code:null` + `result:null`；迟到结果放行后 `state` 仍 `cancelled`、`revision` 仍 3（**不复活、不再自增**）；转写记录 `HTTP 404 NOT_FOUND`（**取消不产生记录**）。

---

## 5 §4 七条语义：逐条机器判据与读数

装配层用例：`tests/unit/speech-cancel.test.mjs`（11 用例）与 `tests/integration/speech-http.mjs` 的 `[14]` 组。
命令：`node --test --test-isolation=none tests/unit/speech-cancel.test.mjs`（本页所有单测读数同此跑法）。

| # | 派单 §4 要求 | 判据（用例名） | 实测读数 |
| --- | --- | --- | --- |
| 1 | `queued`/`running` → `cancelled`，`revision` **恰好 +1** | `queued 作业取消 ⇒ cancelled，revision 恰好 +1…`；`running 作业取消后…`（断言 `revision === 2` / `=== 3`）；HTTP `[14]` 断言 `revision 3`、`etag "3"` | `ℹ tests 11 / pass 11 / fail 0`；HTTP：`[取消实测] POST /jobs/{id}/cancel → 200 state=cancelled revision=3 etag="3"` |
| 2 | 终态再取消 ⇒ `OBJECT_UNAVAILABLE`，作业源原样透出（不改写 503） | `五终态再取消 ⇒ OBJECT_UNAVAILABLE…`（逐一覆盖 5 个终态，并断言 `state`/`revision`/`errorCode` 不变）；`已 cancelled 再取消…`；`jobs-registry` 适配层断言 `OBJECT_UNAVAILABLE` 原样透出；HTTP：`jobs-http [9]`/`[14]` | 单测 11/11；`jobs-http`：`PASS [9] 转写域**已接线取消**（GY-R27）：已终态作业 cancel ⇒ 409 OBJECT_UNAVAILABLE（不再是 503「能力未接线」）` |
| 3 | 取消不产生转写记录 | `running 作业取消后…` 断言 `store.getTranscription(target_ref.id) === null`；HTTP `[14]` 断言记录 `404` | 单测绿；HTTP：`GET /speech/transcriptions/{id} HTTP 404` |
| 4 | 他人作业与不存在**同形 404** | `越权与不存在同形 NOT_FOUND（同码同文案…）`（他主/不存在/非 uuid 三种同文案）；HTTP `[14]` 断言他人取消 `404` | 单测断言 `new Set(messages).size === 1`；HTTP：`foreign.status === 404`、`code === 'NOT_FOUND'` |
| 5 | If-Match 不符 ⇒ 409；缺 If-Match 按 OCR 口径（428） | `If-Match 不符 ⇒ REVISION_CONFLICT…`；`缺 / 非法 Idempotency-Key 与 If-Match…`（`REVISION_REQUIRED`/`INVALID_REQUEST`）；HTTP `[14]` | 单测绿；HTTP：`noIfMatch.status === 428`、`noKey.status === 400`、`stale.status === 409` |
| 6 | 重复取消（已 cancelled）不 5xx、不再 +1 | `已 cancelled 再取消（换新键）…`（旧/新 If-Match 分别 409 `REVISION_CONFLICT` / 409 `OBJECT_UNAVAILABLE`，`revision` 仍 2）；`首次成功取消的原样重试…`（同键回放 `revision` 仍 2）；`同键并发取消…` | 单测绿（并发两方均 `revision === 2`）；HTTP：同键重放 `revision` 仍 3 |
| 7 | 取消后 `GET /jobs/:id` 读到 `cancelled`、`error_code` 清空 | `queued 作业取消 ⇒ cancelled…`（`readBack.state==='cancelled'`、`readBack.error_code===null`、`result===null`）；HTTP `[14]` 迟到结果后的 `GET /jobs/{id}` | 单测绿；HTTP/探针：`state=cancelled`、`error_code:null`、`result:null` |

补充：`queued 作业取消…` 用例把作业行**预置**为 `errorCode:'PROVIDER_QUOTA_EXCEEDED'` 再取消（若取消只做「不清空」的写法会红），从而让第 7 条不是空断言。

---

## 6 前→后断言对应表（红线 ⑤：**逐条**给出每条旧断言的下场）

被本片改写的既有断言共 **3 处、19 条**。下表按「旧断言 → 去向」逐条列出，**不做一句话概括**；去向分四类：**逐字保留**／**同主体强化**（同一条断言的对象不变，只把被本片改变的期望值换掉，并加反向断言）／**保护点迁移**（该断言随 503 语义一起失效，但等价断言仍存在于别处且实测绿）／**语义翻转**（旧断言钉的正是本片要改的行为）。

### 6.1 `tests/unit/jobs-registry.test.mjs`（用例：适配层·转写源；旧标题「…无取消能力的域不暴露 cancel」）

| # | 旧断言（原文） | 去向 | 新断言 / 替代保护点 |
| --- | --- | --- | --- |
| 1 | `assert.equal(transcription.cancel, undefined, '转写域本基线无取消能力 ⇒ 不暴露 cancel')` | **语义翻转**（本片目的就是让该域具备取消能力） | `assert.equal(typeof transcription.cancel, 'function', '转写域已接线取消能力 ⇒ 必须暴露 cancel')` |
| 2 | `assert.equal(await transcription.get({ userId:'u', jobId:'missing' }), null)` | **逐字保留** | 同左（同形 404 路径仍被钉） |
| 3 | `assert.equal((await transcription.get({ userId:'u', jobId:JOB_ID })).id, JOB_ID)` | **逐字保留** | 同左 |
| 4 | `assert.equal(calls.get, 2)` | **逐字保留** | 同左（读取次数不变 ⇒ 适配层没有偷偷加读） |
| 新增 5 条 | — | — | ① `cancel({jobId:'missing'}) === null`（**同形 404 在取消面也被钉**）；② 域内 `OBJECT_UNAVAILABLE` **必须原样透出**（`assert.rejects` 判 `code`，注释写明不得改写成 503）；③ 成功路径 `state==='cancelled'` 且 `revision === job.revision + 1`；④ 注册表级 `createJobRegistry([transcription]).cancel(...)` ⇒ `state==='cancelled'` 且 `result===null`（**503→200 的注册表级证据**）；⑤ `calls.cancel === 3`（每条分支都真调到域内 `cancelJob`，防「加了 cancel 却不接线」的空实现） |

该用例后半段（识别源）**一字未改**。

### 6.2 `tests/integration/jobs-http.mjs` 组 `[9]`（HTTP 反例：转写域 cancel）

| # | 旧断言（原文） | 去向 | 新断言 / 替代保护点 |
| --- | --- | --- | --- |
| 1 | `assert.equal(before.state, 'succeeded')` | **逐字保留** | 同左 |
| 2 | `assert.equal(rejected.status, 503, JSON.stringify(rejected.body))` | **同主体强化**（主体不变=转写作业 cancel 的状态码；期望值随本片改变） | `assert.equal(rejected.status, 409, …)` |
| 3 | `assert.equal(rejected.body.error.code, 'PROVIDER_UNAVAILABLE', '不得假装取消成功，也不得冒充对象不可用')` | **同主体强化** | `assert.equal(..., 'OBJECT_UNAVAILABLE', '终态不可取消 ⇒ 对象状态不允许，不是能力未接线')` **＋** `assert.notEqual(..., 'PROVIDER_UNAVAILABLE', '不得再以「能力未接线」的 503 形态回应')` |
| 4 | `assert.equal(rejected.body.error.retryable, false, '能力未接线属"需运维改配置"…不得标为可重试')` | **保护点迁移**（409 响应体没有 `retryable` 字段；该断言钉的是「503 未接线响应必须 `retryable:false`」） | 等价断言仍在 5 处且实测绿：`tests/unit/jobs-registry.test.mjs:275`、`:525`、`:587`（三条均 `assert.equal(error?.retryable, false, …)`）、`tests/unit/tts-jobs-http.test.mjs:242`、`tests/moderation/http-jobs.test.mjs:174` |
| 5 | `assert.equal(after.state, before.state, '不得伪造 cancelled')` | **逐字保留** | 同左 |
| 6 | `assert.equal(after.revision, before.revision)` | **逐字保留** | 同左（被拒的取消不得推进 revision） |

### 6.3 `tests/integration/jobs-http.mjs` 组 `[14]`（「cancel 请求头错误码」钉子；旧标题「无取消能力 kind 的 cancel 错误码」）

| # | 旧断言（原文） | 去向 | 新断言 / 替代保护点 |
| --- | --- | --- | --- |
| 1 | `assert.equal(neither.status, 400, …)` | **逐字保留** | 同左 |
| 2 | `assert.equal(neither.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED')` | **逐字保留** | 同左 |
| 3 | `assert.equal(keyOnly.status, 428, …)` | **逐字保留** | 同左 |
| 4 | `assert.equal(keyOnly.body.error.code, 'REVISION_REQUIRED')` | **逐字保留** | 同左 |
| 5 | `assert.equal(bothHeaders.status, 503, '两头齐备应 503（该 kind 无取消能力）…')` | **同主体强化**（主体不变=两头齐备的 cancel；期望值随本片改变） | `assert.equal(bothHeaders.status, 409, '两头齐备应 409（已终态不可取消）…')` |
| 6 | `assert.equal(bothHeaders.body.error.code, 'PROVIDER_UNAVAILABLE')` | **同主体强化** | `assert.equal(..., 'OBJECT_UNAVAILABLE')` **＋** `assert.notEqual(..., 'PROVIDER_UNAVAILABLE', '转写域已接线 ⇒ 不得再以 503「能力未接线」回应')` |
| 7 | `assert.equal(bothHeaders.body.error.retryable, false, '该 kind 无取消能力（未接线）⇒ 不得标为可重试')` | **保护点迁移**（同上：409 无 `retryable`） | 同 6.2 #4 的 5 处等价断言（实测绿） |
| 8 | `assert.equal(after.state, before.state, '三次失败调用都不得改动作业状态')` | **逐字保留** | 同左 |
| 9 | `assert.equal(after.revision, before.revision)` | **逐字保留** | 同左 |

### 6.4 汇总

- 旧断言 19 条：**逐字保留 12 条**（6.1#2-4、6.2#1/5/6、6.3#1-4/8/9）、**同主体强化 5 条**（6.1#1 与 6.2#2-3、6.3#5-6）、**保护点迁移 2 条**（6.2#4、6.3#7，等价断言仍在 5 处并实测绿）。
- **新增断言 7 条**（6.1 新增 5 条 + 6.2/6.3 各 1 条 `assert.notEqual(..., 'PROVIDER_UNAVAILABLE')`）。
- 没有一条旧断言被**静默删除**：2 条迁移项都在表里点名了替代位置，并附「5 处等价断言实测绿」的读数（§7.2）。
- 「无取消能力 ⇒ 503（`retryable:false`）」这一分支**仍被钉住**，载体改成真正未接线的 kind / 自造源：`tests/unit/jobs-registry.test.mjs`（`fakeSource({withoutCancel:true})`，`:262` 用例）、`tests/unit/tts-jobs-http.test.mjs`（合成域，真实装配）、`tests/moderation/http-jobs.test.mjs`（审核域，真实装配）——三者本片**未改一字**且实测绿（§7.2）。

未发现其它既有断言因本改动变红（§7.2 相邻域单测全绿）。

---

## 7 「必须真跑」读数

### 7.1 跑法限制（未取得项之一）

```text
$ node --test tests/unit/speech-cancel.test.mjs
✖ tests\unit\speech-cancel.test.mjs (2.8391ms)
  Error: spawn EPERM
      at ChildProcess.spawn (node:internal/child_process:441:11)
      at spawn (node:child_process:796:9)
      at TestContext.<anonymous> (node:internal/test_runner/runner:454:19)
      at FileTest.runInAsyncScope (node:internal/test_runner/runner:533:37)
    errno: -4048, code: 'EPERM', syscall: 'spawn'
```

未改动的 `tests/unit/speech-service.test.mjs` 在同一跑法下**同样**报 `spawn EPERM` ⇒ 与本次改动无关，是会话沙箱限制。

### 7.2 单文件读数（本片相关 + 相邻域回归）

命令：`node --test --test-isolation=none <文件>`

| 文件 | exit | 读数 |
| --- | --- | --- |
| `tests/unit/speech-cancel.test.mjs`（新增） | 0 | `ℹ tests 11 / pass 11 / fail 0` |
| `tests/unit/jobs-registry.test.mjs`（改写） | 0 | `ℹ tests 14 / pass 14 / fail 0` |
| `tests/unit/speech-service.test.mjs`（未改） | 0 | `ℹ tests 47 / pass 47 / fail 0` |
| `tests/unit/speech-state.test.mjs`（未改） | 0 | `ℹ tests 17 / pass 17 / fail 0` |
| `tests/unit/jobs-result-shape.test.mjs`（未改） | 0 | `ℹ tests 8 / pass 8 / fail 0` |
| `tests/unit/tts-jobs-http.test.mjs`（未改，仍钉「无取消能力 ⇒ 503」） | 0 | `ℹ tests 11 / pass 11 / fail 0` |
| `tests/moderation/http-jobs.test.mjs`（未改，仍钉「无取消能力 ⇒ 503」） | 0 | `ℹ tests 5 / pass 5 / fail 0` |
| `tests/unit/ocr-cancel.test.mjs`（未改，同族参照） | 0 | `ℹ tests 9 / pass 9 / fail 0` |

### 7.3 集成脚本读数（`node <脚本>`）

| 脚本 | 读数 |
| --- | --- |
| `tests/integration/jobs-http.mjs` | `PASS 15 loopback HTTP groups`（exit 0）；原始行：`[cancel 请求头错误码钉子] 缺两头=400 IDEMPOTENCY_KEY_REQUIRED ｜ 有 Key 缺 If-Match=428 REVISION_REQUIRED ｜ 两头齐备=409 OBJECT_UNAVAILABLE`；`PASS [9] 转写域**已接线取消**（GY-R27）…`；`[并发实测·cancel 同键 2 次] statuses=[200,200] 迁移前 revision=2 → 迁移后 3` |
| `tests/integration/speech-http.mjs` | `PASS 15 loopback HTTP groups`（exit 0，含新增 `[14]`）；原始行：`[取消实测] POST /jobs/{id}/cancel → 200 state=cancelled revision=3 etag="3"`；`PASS [14] 取消（GY-R27）：running 作业经 POST /jobs/{id}/cancel ⇒ 200 cancelled（基线 13dd429 为 503 PROVIDER_UNAVAILABLE）；revision 恰好 +1、error_code 清空、迟到结果不复活、不产生转写记录` |

### 7.4 全量单测

**本片不声称全量读数（未取得）**：本会话沙箱禁止 `spawn`（§7.1），而全量里有一批用例经 `spawnSync` 起子进程（`contract-status-tool`、`release-materials-index`、`research-records-gate`、`staging-intake`、`source-lifecycle`、`local-dev-package`、`miniprogram-reference-parse` 等），在本会话里必然假红；另按指挥 2026-10-20 指令暂停大跑（本机空闲内存约 1.6 GB，并发全量会产生 `VirtualAlloc failed` 类假红）。本页只对「本片改动文件 + 相邻域文件」负责（§7.2）。

**权威全量读（指挥侧、串行、同一基线 `13dd429` 取得；本页仅转述，不冒充自己跑过）**：`tests/unit|privacy|media|reference` 共 **2562 条 / 2561 pass / 0 fail / 1 skip，exit=0**；另 `test:contract` 6/6、`test:reference` 317/317、`test:evaluation` 119/119、`test:docs` exit=0 ⇒ 基线主干全绿。

**本会话假红的形态（佐证，不是仓库缺陷）**：在同一会话里对 `13dd429` 的干净只读树实测 `node --test --test-isolation=none tests/unit/contract-status-tool.test.mjs` ⇒ `tests 18 / pass 4 / fail 14`；`tests/unit/staging-intake.test.mjs` ⇒ `tests 4 / pass 3 / fail 1`（失败形态为 `null !== 1`，即 `spawnSync` 拿不到子进程状态码）。同一批文件在指挥侧串行全量中全绿 ⇒ 属**会话沙箱假红**，与本片改动无关（这些文件均未被本片改动）。

---

## 8 负控制（3 条，含 `byte_exact_restore` 证据）

统一手法：
1. 变异前把文件与 `git diff` 各存一份到仓外（`.pg17\tmp-r27-s7\service.ts.orig`、`diff-before.txt`）并取 sha256；
2. 施加**单点变异**；
3. 跑用例 ⇒ 必须变红（贴原始失败行）；
4. `Copy-Item <orig> <目标> -Force` 还原；
5. 复核：文件 sha256 与 `git diff` sha256 **均与变异前逐字相同**，并重跑用例复绿。

- 变异前 `services/api/src/speech/service.ts` sha256：`836E2A6EC04D3C98B20651F5F3D04F4C9BFD1C913CEAA3627A51948C9CF66A87`
- 变异前 `git diff`（工作区相对 `13dd429`）sha256：`D3398CCA25D4C922C4C9002DE199290D1C8EFFE0B94258E95F1600EF6B3C0505`

| # | 变异点（`services/api/src/speech/service.ts` 内 `cancelJob`） | 变红输出（原始） | 还原证据 |
| --- | --- | --- | --- |
| A | `revision: current.revision + 1` → **`+ 2`**（取消多推一次版本） | `ℹ tests 11 / pass 5 / fail 6`；`✖ queued 作业取消 ⇒ cancelled，revision 恰好 +1…`：`AssertionError: revision 必须从 1 恰好递增到 2` / `actual: 3, expected: 2`；`✖ running 作业取消后…`：`revision 必须从 2 恰好递增到 3（单次 CAS，不得 +2）` / `actual: 4, expected: 3`；另 4 条（重复取消、回放、并发、If-Match 重试）同因变红 | 还原后 `restored-sha256=836E2A6E…A87`（与变异前相同）、`diff-sha256=D3398CCA…505`（与变异前相同）、`byte_exact_restore=true`；重跑 `ℹ tests 11 / pass 11 / fail 0` |
| B | **删除终态判定与迁移判定两处 guard**（`isTerminalJobState(row.state)` 与 `canTransitionJob(row.state,'cancelled')` 的 `OBJECT_UNAVAILABLE` 分支整体移除） | `ℹ tests 11 / pass 9 / fail 2`；`✖ 五终态再取消 ⇒ OBJECT_UNAVAILABLE…`：`AssertionError [ERR_ASSERTION]: Missing expected rejection.`（`actual: undefined, expected: [Function (anonymous)]`）；`✖ 已 cancelled 再取消（换新键）…` 同上 | 同上（文件/`git diff` 双 sha256 相同，`byte_exact_restore=true`）；重跑 `ℹ tests 11 / pass 11 / fail 0`。**注意**：只删其中**一处**不会变红（两道 guard 互为冗余：`canTransitionJob` 对终态一律返回 false），故变异 B 按「终态判据整体删除」取证——这正说明终态不可取消有**两道**机器判据。 |
| C | 取消成功后**仍写入一条转写记录**（`store.insertTranscription({ id: updated.transcriptionId, … })`） | 单测：`ℹ tests 11 / pass 10 / fail 1`，`✖ running 作业取消后，迟到的提供者结果不复活作业、不写入转写记录` ⇒ `AssertionError: 取消后不得写入转写记录（cancelled 不产生记录）` / `actual: [Object], expected: null`；HTTP 层：`FAIL [14] 取消（GY-R27）…: 取消不产生转写记录` ⇒ `actual: 200, expected: 404`（`tests/integration/speech-http.mjs` exit 1） | 同上（文件/`git diff` 双 sha256 相同，`byte_exact_restore=true`）；还原后 `ℹ tests 11 / pass 11 / fail 0` 且 `PASS 15 loopback HTTP groups` |

三次变异的红/绿原始输出文件（仓外）：`.pg17\tmp-r27-s7\negctl-A.txt`、`negctl-B.txt`、`negctl-C.txt`、`negctl-C-http.txt`。

---

## 9 迁移 / 契约 / 持久化

- **不需要新增迁移**（派单 §2 已核）：`job_state` 枚举早已含 `cancelled`（`services/api/db/migrations/0001_initial_schema.sql`），本片**未新增/未改**任何迁移文件。
- 契约：`POST /jobs/{id}/cancel` 早已存在（`services/api/src/jobs/routes.ts`），本片只补域内实现与作业源接线，**未新增契约字段**、未改 `packages/contracts/**`。
- 持久化：转写任务与记录在本基线是**内存 store**（`services/api/src/speech/store.ts` 的 `createMemorySpeechStore()`，`persistent: false`）⇒ 本片的取消语义**不涉及 PG 读写**，因此没有 PG 读数（见 §10）。

## 10 未取得项（如实）

1. **默认逐文件隔离跑法**（`node --test <单文件>`）：**未取得**。本会话沙箱下必然 `spawn EPERM`（§7.1 原文），全部单测读数改用 `--test-isolation=none`。**原因已由指挥实测定案**：全权沙箱只作用于指挥会话，不回溯已创建的子代理（仓内错误类 65／裁定 R26-04「沙箱模式对指挥与子代理不同步」）⇒ 这是环境不对称，不是本片缺陷，无需返工。
2. **全量单测权威读数**：**未取得**（按指挥指令暂停，避免与指挥的串行全量并发造成内存假红）；本页只对「本片改动文件 + 相邻域文件」负责。
3. **真实 PostgreSQL 读数**：**未取得**，且判定为**本片不需要**（无迁移；转写 store 为内存实现，`persistent: false`）。未做任何「已接入 PG」的声称。
4. **真实 ASR / 真机**：**未取得**（本片不涉及；所有提供者均为**明确标注的替身/闸门提供者**，输出文本带「替身示例」「合成用例」前缀，不构成任何准确率或转写质量证据）。
5. **`npm run lint` / `npm run build`**：**未取得**（非本片派单门禁；且 `npm run` 在本会话沙箱下会经子进程 ⇒ 与 `spawn EPERM` 同源）。
6. **CI 读数**：**未取得**（本片不推送、不开 PR，按派单要求只交代码与证据）。

## 11 复现命令与冻结指纹

```powershell
# 1) 单测（本页跑法）
cd E:\GengYunCommander\wt-r27-s7
node --test --test-isolation=none tests/unit/speech-cancel.test.mjs
node --test --test-isolation=none tests/unit/jobs-registry.test.mjs

# 2) 集成脚本
node tests/integration/jobs-http.mjs
node tests/integration/speech-http.mjs

# 3) 改后探针（仓外脚本）
cd E:\GengYunCommander
node .pg17/tmp-r27-s7/probe-cancel-http.mjs

# 4) 改前探针（需临时重建基线只读树；本片取证用的那棵已在交付前删除）
cd E:\GengYunCommander\GengYun_Agent2
git worktree add --detach E:\GengYunCommander\.pg17\wt-r27-s7-base 13dd429a02db57953ad604e17951901ebbc9d2ab
cd E:\GengYunCommander\.pg17\wt-r27-s7-base; npm ci --offline --no-audit --no-fund --ignore-scripts
cd E:\GengYunCommander
$env:PROBE_ROOT='../../.pg17/wt-r27-s7-base/services/api/src/'; node .pg17/tmp-r27-s7/probe-cancel-http.mjs; Remove-Item Env:\PROBE_ROOT
# 用完删除：先枚举重解析点并逐个 `cmd /c rmdir` 摘链，再 git worktree remove（⛔ 联接存在时不得 --force）
```

跨平台可复现的冻结指纹（**blob hash，不是工作区 sha256**；LF 归一化由 git 完成）：

```powershell
cd E:\GengYunCommander\wt-r27-s7
git hash-object -- services/api/src/speech/service.ts
```

| 文件 | `git hash-object`（提交前实测） |
| --- | --- |
| `services/api/src/speech/service.ts` | `8496c2a714cefc2fab3d634e7588e5460c69f8ed` |
| `services/api/src/jobs/sources.ts` | `65a69e7452fc9e0ea48d6c4ca8dbf9afd0befd89` |
| `tests/unit/speech-cancel.test.mjs` | `b761b4f4400215695c75aad15773eb35270d56a0` |
| `tests/unit/jobs-registry.test.mjs` | `8359db1aed0949e3cffc4e2890740284220d458b` |
| `tests/integration/jobs-http.mjs` | `b61a5812d0512f465c6c5aeccd9e25d0970ed62a` |
| `tests/integration/speech-http.mjs` | `6c9a495bfcb4535c7d57240668b1f3be2436aae1` |

提交后复核（实测）：对上述六个路径逐一跑 `git rev-parse HEAD:<path>`，读数与「提交前实测」列**逐字相同**（例：`git rev-parse HEAD:services/api/src/speech/service.ts` ⇒ `8496c2a714cefc2fab3d634e7588e5460c69f8ed`）。⇒ 本节指纹可直接用于跨平台复算，不依赖工作区 `core.autocrlf`。

## 12 清理清单

- 保留：本证据页；仓库内的 4 个改动文件 + 1 个新增测试文件（均随提交入库）。
- 仓外临时物（**不进仓库、不影响 `git status`**，位于 `E:\GengYunCommander\.pg17\tmp-r27-s7\`）：探针脚本 `probe-cancel-http.mjs`、探针原始输出 2 份、负控制输出 4 份、`service.ts.orig`/`sources.ts.orig` 快照、`diff-*.txt`。按「证据优先内联进报告」的口径，关键读数已内联本页。
- 基线只读 worktree `E:\GengYunCommander\.pg17\wt-r27-s7-base`（`13dd429`，仅用于「改前」取证与本会话假红对照）：**已删除**（实测流程：枚举重解析点 **2** 个（`node_modules\@gengyun\{api,admin}`）→ 逐个 `cmd /c rmdir` 摘链并 `Test-Path=False` 复核 → 再次枚举读数 **0** → 删 `node_modules` → `git worktree remove`（exit 0）→ `Test-Path=False`）。⛔ 全程未在联接存在时执行 `git worktree remove --force`。`git worktree list` 现只剩 `E:/GengYunCommander/wt-r27-s7`。
