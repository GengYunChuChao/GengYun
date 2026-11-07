# GY-R87 / #29：撤回导致的 job 终态原因可读（2026-11-07）

- 基线：本片起点 `040867a7`（2026-11-07 23:26:16 +0800）；合并时 `origin/main` 已前进到 `1f623228`（#1059 的撤回作用域负控制、#1064 的注销文案已合入），本片以 **merge 提交**并入（不 rebase、不改写既有提交）
- 分支：`feat/gy-r87-i29-terminal-reason`
- 范围：只把「因撤回而终止」这条原因送到 `GET /api/v1/jobs/{id}` 的读面；**不**级联改 `public.jobs` 的 `state`，**不**动 `public.exports` 的取消列。
- 真库：本机隔离 PostgreSQL **17.11**，`127.0.0.1:55441`，库名 `gengyun_egress_test`；未发出任何对外/付费请求。

## 1. 缺口原状（改前，基线 `040867a7`）

撤回让「执行前重查」抛错，但错误对象在两处被抹平，最终读面只剩一个笼统码。

**执行前/保存前重查确实抛了**（改前）：

- `services/api/src/privacy/task-egress.ts:127`：`await inFlight.assertExecutable({ exportId: record.id, userId: record.userId });`
- `services/api/src/privacy/task-egress.ts:143-148`：`await inFlight.saveResult({ exportId: record.id, userId: sent.userId, objectVersion: sent.objectRevision, result: summarizeEgressOutcome(outcome) });`

**原因在服务层被丢掉**（改前，`services/api/src/recognitions/service.ts`）：

- `services/api/src/recognitions/service.ts:484-486`
  ```js
  if (outcome.kind === 'threw') {
    await commitTerminal(jobId, running, { state: 'failed', errorCode: 'PROVIDER_OUTCOME_UNKNOWN' }, null);
    return;
  ```
- `services/api/src/recognitions/service.ts:543`：`.catch(() => ({ kind: 'threw' as const }));` —— **错误对象在这一行被丢弃**，`outcome` 里只剩 `kind`。

同形存在于另两域（改前）：`services/api/src/ocr/service.ts:572`、`services/api/src/ocr/service.ts:635`；`services/api/src/speech/service.ts:541`、`services/api/src/speech/service.ts:620`。

**后果（读面无法自证）**：`GET /api/v1/jobs/{id}` 对「因撤回而终止」与「供应商超时/网络炸了」返回同一个 `failed / PROVIDER_OUTCOME_UNKNOWN`。撤回后无法自证「这次确实没继续处理」。缺口由 `docs/verification/gy-r83-i29-consent-negatives-20261107.md:89` 自陈：

> 「撤回是否终止已受理的 job」的读面仍无断言：撤回后只 `waitFor(() => terminalJobState(...))` 等「任意终态」，没有断言该终态的 `state`／`error_code`

## 2. 为什么「只把 `CONSENT_REQUIRED` 映射成撤回」不够（时序决定）

真库用例的时序是：`synthetic.hang()` → 等 export `state='sent'` → `DELETE /me/consents/external_inference` → `synthetic.release()`。

撤回提交发生在 `markSent` **之后**，于是 `ledger.revokeInFlight()`（`services/api/src/privacy/ledger-pg.ts:864-883`，本片未改）先把该 export 置 `state='failed', error_code='CONSENT_WITHDRAWN'`；等提供者结果真的回来时，守卫命中的是 `packages/privacy/in-flight.mjs:168-170` 的**终态分支**：

```js
throw new PrivacyError('OBJECT_UNAVAILABLE', `外发已终态（${record.state}），回写被阻断`);
```

也就是 `OBJECT_UNAVAILABLE`，**不是** `CONSENT_REQUIRED`。三条路的取舍：

| 方案 | 结果 | 判决 |
| --- | --- | --- |
| 把 `packages/privacy/in-flight.mjs:151` 与 `packages/privacy/in-flight.mjs:169` 的终态码改成 `CONSENT_REQUIRED` | 直接打红 `tests/integration/egress-revoke-race-pg.mjs:361-367`（断言晚到回调抛 `OBJECT_UNAVAILABLE`）与 `tests/unit/conversation-async-privacy-codes.test.mjs:218-222` | 否决：改的是通用守卫语义，牵连四个域 |
| 领域层把 `OBJECT_UNAVAILABLE` 一律当撤回 | 会把「取消墓碑（`OBJECT_CANCELLED`）」「无外发预留」「授权版本变化」都标成撤回 | 否决：造假证据 |
| **采纳**：外发层读账本终态原因，翻译成契约码 | 只有账本**自述** `state='failed'` 且 `error_code='CONSENT_WITHDRAWN'` 才翻译；其余原样上抛 | Picked |

## 3. 改法（逐文件逐处）

### 3.1 契约闭集（`ERROR_CODES` 28 → 29）

| 文件与行 | 改动 |
| --- | --- |
| `services/api/src/contract.ts:17` | 403 档**行内**插入 `'CONSENT_WITHDRAWN'`（紧跟 `'CONSENT_REQUIRED'`）——`1 +/− 1`，一行换一行，不插行，保住该文件 20+ 处文档锚点 |
| `packages/contracts/states.json:118-123` | 403 组同序插入 `"CONSENT_WITHDRAWN"`——**纯新增 1 行**（`@@ -118,6 +118,7 @@`，插在 403 组第 3 项），无既有行位移 |
| `packages/contracts/openapi.json:12772`（`ErrorCode.enum`）、`packages/contracts/openapi.json:20111`（`x-error-status-map."403"`）、`packages/contracts/openapi.json:19900`（`Error403.description`） | 前两处改成**同行并列**（`"CONSENT_REQUIRED", "CONSENT_WITHDRAWN",`），三处都只换行内文本（`3 +/− 3`）⇒ 无既有行位移 |
| `packages/privacy/constants.mjs:107`、`packages/media/constants.mjs:108` | 403 行内追加（两个镜像逐档 deepEqual `states.json`） |
| `apps/admin/src/lib/admin-contract.mjs:31-59` | `ERROR_CODES` 插入 `'CONSENT_WITHDRAWN',`——**纯新增 1 行**（`@@ -36,0 +37 @@`），无既有行位移 |
| `apps/admin/src/lib/admin-content-view-model.mjs:319` | `READ_FAILURE_CODE_LABELS` 增中文文案（该表要求与 `ERROR_CODES` 完全同集） |
| `tests/unit/contract-code-name-pairs.test.mjs:493`、`tests/unit/contract-code-name-pairs.test.mjs:530` | 28 → 29（两处硬编码计数钉子） |
| `docs/architecture/ai-ops-spec-status.md:61`、`docs/architecture/ai-ops-spec-status.md:107` | 「错误码单源 28 码」→ 29、「恰好 28 个错误码」→ 29 |
| `tests/unit/privacy-egress-ledger-error-code-closed-set.test.mjs:99` | `DOCUMENTED_EXCEPTIONS` 删掉 `'CONSENT_WITHDRAWN'`，只留 `['OBJECT_CANCELLED']`（该测要求例外表成员必须**不在**契约闭集） |

**契约影响**：`CONSENT_WITHDRAWN` 落在 **403** 档（撤回后继续处理是权限问题，与既有 `CONSENT_REQUIRED` 同档），与 `public.exports.error_code` 同名，便于逐行对账。`services/api/src/jobs/registry.ts:244-246` 的「failed/timed_out 必须带契约 `error_code`」约束因此可被合法满足（新码在闭集内）；数据库侧 `error_code` 列是 `varchar(80)` + 长度 CHECK，**无闭集约束，故无迁移**。

### 3.2 原因穿过服务层（`services/api/src/errors.ts`）

`services/api/src/errors.ts:12` 行内补 `isErrorCode` import、`services/api/src/errors.ts:14` 新增 `import { PrivacyError } from '../../../packages/privacy/errors.mjs';`（+1 行；文件 **164 → 175 行**，基线 `040867a7` 是 143 行）；**文件末尾追加**新函数（现 `services/api/src/errors.ts:166-175`）：

```js
export function terminalFailureCodeOf(error: unknown): ErrorCode {
  const code =
    error instanceof ApiError && isErrorCode(error.code)
      ? error.code
      : error instanceof PrivacyError && isErrorCode(error.code)
        ? error.code
        : null;
  if (code === 'CONSENT_REQUIRED' || code === 'CONSENT_WITHDRAWN') return 'CONSENT_WITHDRAWN';
  return 'PROVIDER_OUTCOME_UNKNOWN';
}
```

只认两个**契约闭集内**的码，且只认 `instanceof ApiError` / `instanceof PrivacyError` —— 与 `services/api/src/conversations/service.ts:499-503` 的 `settleCodeOf` **同一条口径**。

> **审查后修正（P2-1）**：初版是鸭子类型（`(error as { code?: unknown })?.code` + `isErrorCode`），并在注释里声称「域外错误对象的任意 `{code}` 鸭子类型冒充不了契约码」。**这句话是假的**：`terminalFailureCodeOf({ code: 'CONSENT_REQUIRED' })` 实测返回 `CONSENT_WITHDRAWN`。今天调用点只有各域自己的 threw 分支（对象必是这两类之一），所以不可达；但「不可达」不等于「某天不会变成假合规证据」（第三方 SDK 自带 `code` 字段就会冒充）。故改成 instanceof 口径，注释改成实话，并由 `tests/unit/job-terminal-reason-consent-withdrawn.test.mjs` 把这条负空间钉住：普通对象、`Object.assign(new Error(...), {code})`、连 `name: 'PrivacyError'` 一起改的，一律 `PROVIDER_OUTCOME_UNKNOWN`。

> 为什么不复用现成的 `failureCodeOf`：`services/api/src/privacy/ledger-pg.ts:1084-1088` 的 `failureCodeOf` 只认**账本摘要形状** `{kind:'failed', code}`，直接传抛出的 `PrivacyError` 必得 `null`（`services/api/src/privacy/task-egress.ts:443` 的注释也写明「不认 Error」）。`services/api/src/privacy/task-egress.ts:210-213` 的 `errorCodeOf` 认 `{code}` 但是模块私有、且会把任意闭集码原样放行（含 `OBJECT_UNAVAILABLE`）——用它会误标，故新写一个小函数。

### 3.3 各域保留错误对象并裁决原因（识别／OCR／语音／TTS）

| 域与文件 | 改动 |
| --- | --- |
| `services/api/src/recognitions/service.ts:29`、`:485`、`:532-533`、`:544` | import 加 `terminalFailureCodeOf`；threw 分支 `errorCode: terminalFailureCodeOf(outcome.error)`；联合 `{ kind: 'threw'; error: unknown }`；`.catch((error: unknown) => ({ kind: 'threw' as const, error }))` |
| `services/api/src/ocr/service.ts:33`、`:572`、`:620`、`:635` | 同上四式 |
| `services/api/src/speech/service.ts:52`、`:541`、`:606`、`:620` | 同上四式 |
| `services/api/src/tts/service.ts:77`、`:642-646`、`:645` | import 加 `terminalFailureCodeOf`；threw 分支由 `… : 'PROVIDER_OUTCOME_UNKNOWN'` 改成 `… : terminalFailureCodeOf(outcome.error)`（判定在 `services/api/src/tts/service.ts:645`）；联合类型 `services/api/src/tts/service.ts:698` 与 `.catch` 保留对象 `services/api/src/tts/service.ts:710` **早已是 threw 形态**，未动 |

TTS 的 `services/api/src/tts/service.ts:663` 的 `SynthesisArtifactError` 分支仍是 `PROVIDER_OUTCOME_UNKNOWN`——那是「替身声称真实音频」的协议违规，与撤回无关，**有意保留**。

识别／OCR／语音三文件行数零位移（识别 940 行、语音 936 行等），因为 `docs/architecture/contract-implementation-status.md:43`、`docs/verification/gy-r28-contract-line-anchors-20261021.md:361-362` 用符号引脚引它们的 `runProviderWithDeadline`（±2 容差，且语音的 `cancelJob` 在 `services/api/src/speech/service.ts:666` 是**无容差**引脚）。TTS 也是零位移（`3 +/− 3`：import 行、注释行、判决行各换一行），故 `docs/verification/gy-i13-synthesis-20261019.md` 等页引它的那两行（联合类型与 `.catch` 保留对象处）全部照旧成立。

### 3.4 外发层把「账本终态原因」翻译成契约码（`services/api/src/privacy/task-egress.ts`）

四处守卫调用点改成 try/catch 包装（媒体外发在 `services/api/src/privacy/task-egress.ts:127`、`services/api/src/privacy/task-egress.ts:143`；问答外发在 `services/api/src/privacy/task-egress.ts:424`、`services/api/src/privacy/task-egress.ts:475`），文件末尾（原 500 行）追加三个 helper（**`export`**，供合成域复用；行数零位移）：

- `withdrawalAwareFailure(ledger, exportId, error)`（`services/api/src/privacy/task-egress.ts:522`）：
  - `code === 'CONSENT_REQUIRED'`（执行前重查直接抛）⇒ 立刻翻译成 `PrivacyError('CONSENT_WITHDRAWN', '外发因撤回同意而终止，结果不予写入')`；
  - `code !== 'OBJECT_UNAVAILABLE'` ⇒ 原样返回（**不碰**取消墓碑、无预留、版本变化）；
  - 否则读 `ledger.get(exportId)`（try/catch 包住，假账本可能没有 `get`），**仅当** `record.state === 'failed'` 且 `record.errorCode === 'CONSENT_WITHDRAWN'` 才翻译。
- `assertExecutableOrWithdrawn(...)`（`services/api/src/privacy/task-egress.ts:546`）、`saveResultOrWithdrawn(...)`（`services/api/src/privacy/task-egress.ts:559`）：薄包装，`throw await withdrawalAwareFailure(...)`。

合成（TTS）外发**同一层缺口、同一套修法**：`services/api/src/privacy/synthesis-egress.ts:40` import 这两个包装器，`services/api/src/privacy/synthesis-egress.ts:315`（`assertExecutable` 原裸调用）与 `services/api/src/privacy/synthesis-egress.ts:333`（`saveResult` 原裸调用）改成包装调用。此前这两处抛出的 `OBJECT_UNAVAILABLE` / `CONSENT_REQUIRED` 不翻译，一路撞 `packages/privacy/in-flight.mjs:168-170` 的终态分支，最终在 `services/api/src/tts/service.ts:645` 被折成 `PROVIDER_OUTCOME_UNKNOWN`——同一个坑，两处。**审查 P2-2 之前，本页 §4 把 TTS 写成「未改·本无缺口」，那是错的。**

`packages/privacy/in-flight.mjs` 与 `services/api/src/privacy/ledger-pg.ts:864-883` 的 SQL 一字未改。

### 3.5 小程序状态面（新错误码必须有状态可渲染）

加契约码不只影响 API：`miniprogram/utils/states.js` 的 `CODE_KIND` 是「错误码 → 页面状态 kind」的唯一映射，未登记的码会让页面**无状态可渲染**。本片同时补：

- `miniprogram/utils/states.js:38`：`CONSENT_WITHDRAWN: 'denied',`（插在 `CONSENT_REQUIRED` 之后，与 `services/api/src/contract.ts:17` 的 403 档同序）；
- 403 闭集注释同步四处：`miniprogram/utils/states.js:16`、`miniprogram/utils/auth.js:53`、`miniprogram/utils/auth.js:64`、`miniprogram/utils/auth.js:91`；
- `miniprogram/utils/auth.js:65-67` 的 `FORBIDDEN_CODES` 由 `states.CODE_KIND` 里 `kind === 'denied'` 反推，**自动跟随**，不需要改代码。

`node --test tests/ui-unified-states.test.mjs`：修前 10 tests / 9 pass / 1 fail、`EXIT=1`（`AssertionError [ERR_ASSERTION]: CONSENT_WITHDRAWN（HTTP 403）在 utils/states.js 里没有归类——该错误发生时页面将无状态可渲染`，`tests/ui-unified-states.test.mjs:90:12`）；修后 10/10 PASS、`EXIT=0`。该用例在 CI 里是**独立 step**（`.github/workflows/engineering-shell.yml:68-69`），不在 `npm run test:unit` 的 glob（`tests/{unit,privacy,media,reference,moderation}/*.test.mjs`）内——这正是作者自检全绿、CI 却会红的原因。

## 4. 各域的处置

| 域 | 处置 | 依据 |
| --- | --- | --- |
| 识别 | **改**（见 §3.3） | `.catch(() => ({ kind:'threw' }))` + `commitTerminal('PROVIDER_OUTCOME_UNKNOWN')` 同形 |
| OCR | **改** | 同形（`services/api/src/ocr/service.ts:571-574`、`services/api/src/ocr/service.ts:635`） |
| 语音 | **改** | 同形（`services/api/src/speech/service.ts:540-543`、`services/api/src/speech/service.ts:620`） |
| 会话 | **未改——该域无此问题** | `services/api/src/conversations/service.ts:499-503` 的 `settleCodeOf` 已经「`instanceof ApiError` / `instanceof PrivacyError` 且 `isErrorCode` ⇒ 保留原码」，唯一调用点 `services/api/src/conversations/service.ts:1298` 在异步任务 IIFE 的 catch 里，**不经过** `.catch(()=>({kind:'threw'}))` 折损。加契约码后它自动能写出 `CONSENT_WITHDRAWN` |
| TTS（合成） | **改**（见 §3.3 末行与 §3.4） | 缺口与三域同形、且更靠下一层：`services/api/src/privacy/synthesis-egress.ts:315` / `:333` 的两处守卫是**裸调用**，撤回时抛 `OBJECT_UNAVAILABLE` 不翻译；`services/api/src/tts/service.ts:645` 的 threw 分支再把它折成 `PROVIDER_OUTCOME_UNKNOWN`。本片补上包装器并让 threw 分支走 `terminalFailureCodeOf`；`services/api/src/tts/service.ts:698` 与 `services/api/src/tts/service.ts:710` 的 threw 形态本来就在，缺的只是「原因怎么裁决」 |

## 5. 实跑读数（真 PG 17.11，`127.0.0.1:55441`，库 `gengyun_egress_test`）

命令：`node tests/integration/egress-ledger-pg.mjs`（`EGRESS_LEDGER_TEST_URL=postgres://postgres@127.0.0.1:55441/gengyun_egress_test`，每次先 drop/create 空库）

### 5.1 正控制（读面）——`PASS 9`

```text
PASS 9: HTTP 撤回端到端（真 PG）：撤回 200 + 在途外发置 failed + 读面 error_code=CONSENT_WITHDRAWN + 晚到结果零写入 + 入口拒绝且不新增账本行
```

断言体（`tests/integration/egress-ledger-pg.mjs:555-565`）：`synthetic.release()` 后

```js
const terminalB = await waitFor(() => terminalJobReadout(b.token, createdB.body.data.id), 'B 任务终态');
assert.equal(terminalB.state, 'failed', '撤回导致的终态必须是 failed');
assert.equal(terminalB.errorCode, 'CONSENT_WITHDRAWN', `读面必须自证撤回：期望 CONSENT_WITHDRAWN，实际 ${terminalB.errorCode}（落成 PROVIDER_OUTCOME_UNKNOWN ＝ 仍然分不清撤回与供应商故障）`);
assert.equal(await writebackCount(sentB.id), 0, '撤回后晚到的提供者结果必须零写入');
```

原有的「零写入」断言（现 `tests/integration/egress-ledger-pg.mjs:565`）保留未动；只把「等任意终态」换成「等并断言具体值」。新增助手 `terminalJobReadout`（与 `terminalJobState` 并列，后者未改签名，避免牵动其它场景）。

### 5.2 负控制 A（撤回的作用域：跨用户／跨用途）——`PASS 14`（来自 `origin/main` 的 #1059）

```text
PASS 14: 撤回作用域负控制（真 PG）：A 走 HTTP 撤回只撤自己那一行（failed + CONSENT_WITHDRAWN + revision+1）；同用户另一用途行与 B 的 sent/reserved 两行逐字段不变；purpose=null 撤回恰撤 1 行且 B 仍逐字段不变
```

做法（`tests/integration/egress-ledger-pg.mjs:752-866` 第 12 节）：A 与 B 各两行（`weed_recognition` 的 `required_consents` = `{media_processing, external_inference}` 横跨两个用途；`checked_content` 只挂 `external_inference`），A 走**真实 HTTP 触发面** `DELETE /me/consents/media_processing` 撤回 ⇒ 断言 A 的目标行 `failed` + `CONSENT_WITHDRAWN` + `revision+1`，同用户另一用途行与 B 的 `sent`/`reserved` 两行 `SELECT *` 整行 deepEqual 不变；再补一次 `purpose=null`（注销级）撤回，计数恰为 1、B 仍不变。

> **合并说明（P1-2 去重）**：本节原是本片自带的「负控制 A」，与 `origin/main` 上 #1059 已合入的第 12 节**同题**、且 #1059 覆盖更广（多了 `purpose=null` 与 `sent`/`reserved` 两种状态、逐字段 deepEqual）。故按审查意见**删掉本片那一组**，只留 #1059 的；本节 PASS 号仍落在 14，本片的负控制 B／C 顺延为 `PASS 15` / `PASS 16`。第 12 节文本与 `origin/main` 逐行相同（合并时原样保留，未改一字）——判据不是「数行数」而是逐字段，这一点见该节注释 `tests/integration/egress-ledger-pg.mjs:759-765`。

### 5.3 负控制 B（不复活）——`PASS 15`

```text
PASS 15: 负控制 B（真 PG）：撤回后晚到回调 ⇒ guardWriteback/saveResult 均 OBJECT_UNAVAILABLE + export_writebacks 0 行 + error_code 仍 CONSENT_WITHDRAWN
```

`ledger.guardWriteback(...)` 与 `inFlight.saveResult(...)` 都必须 reject `OBJECT_UNAVAILABLE`（message 匹配 `/回写被阻断|已终态/`），`export_writebacks` 0 行，且 `exports.error_code` 仍是 `CONSENT_WITHDRAWN`（晚到回调不得把原因改写回别的码）。

### 5.4 负控制 C（不误伤正常失败）——`PASS 16`

```text
PASS 16: 负控制 C（真 PG）：真超时 ⇒ timed_out/PROVIDER_TIMEOUT；提供者抛未知错 ⇒ failed/PROVIDER_OUTCOME_UNKNOWN（撤回分支不误伤）
```

真超时用第二个 app 实例（同池、同传输、`recognitionJobDeadlineMs: 500`）驱动，不必等 30 秒默认截止；提供者抛未知错用 `synthetic.boom()`（`recognize()` 直接 `throw new Error('synthetic provider exploded')`）。

### 5.5 汇总

```text
RESULT=PASS 16 组；真实 PostgreSQL 17.11（本机隔离、仅回环）；未发出任何对外/付费请求
EXIT=0
```

stderr 有一行既有噪音 `GY-I16 识别终态历史写入失败（端口=wired…）： relation "history" does not exist`——本用例库只应用 0011 系列迁移，历史表未建；**改前同样存在**，不属本片。

## 6. 变异自证

| 变异 | 改什么 | 读数 | 结论 |
| --- | --- | --- | --- |
| A | `services/api/src/errors.ts:173` 的 `CONSENT_WITHDRAWN` 分支改回 `PROVIDER_OUTCOME_UNKNOWN`（＝本片之前的旧行为） | `AssertionError [ERR_ASSERTION]: ApiError(CONSENT_REQUIRED)：执行前重查发现授权已撤回 必须落 CONSENT_WITHDRAWN`；`AssertionError [ERR_ASSERTION]: 翻译结果必须一路走到作业终态码`；`AssertionError [ERR_ASSERTION]: 撤回原因必须写进 job.error_code（否则读面分不清「因撤回终止」与「供应商炸了」）`；`tests 58 / pass 54 / fail 4`、`EXIT=1` | **正控制必红**：映射一旦退回，`terminalFailureCodeOf` 的 4 条断言与 TTS 的两条反例一起红 |
| B | `miniprogram/utils/states.js:38` 删掉 `CONSENT_WITHDRAWN: 'denied',` | `AssertionError [ERR_ASSERTION]: CONSENT_WITHDRAWN（HTTP 403）在 utils/states.js 里没有归类——该错误发生时页面将无状态可渲染`；`tests 10 / pass 9 / fail 1`、`EXIT=1` | **状态面必红**：这条就是审查 P0-1 的原症状，可复现 |
| C | `services/api/src/tts/service.ts:645` 的 `terminalFailureCodeOf(outcome.error)` 改回 `'PROVIDER_OUTCOME_UNKNOWN'` | `AssertionError [ERR_ASSERTION]: 撤回原因必须写进 job.error_code（否则读面分不清「因撤回终止」与「供应商炸了」）`；`AssertionError [ERR_ASSERTION]: CONSENT_REQUIRED 必须与 CONSENT_WITHDRAWN 落同一个终态码`；`tests 50 / pass 48 / fail 2`、`EXIT=1` | **TTS 缺口必红**：只改 thrown 分支的裁决就足以让两条反例红，说明 P2-2 的洞是真的 |

三次变异都在运行后**立即还原**（用文件副本还原，不走 `git checkout`，避免误伤本片未提交改动）：还原后分别复跑 `58/58`、`10/10`、`50/50` 全绿、`EXIT=0`；`git status --porcelain` 只含本片自己的文件。

> 真库层面的同形变异（把映射改回后 `PASS 9` 的读面断言转红）由作者在合并前已在真 PG 上跑过一次；本次审查修复后的复跑只做到单元／UI 层（见 §8 的真库读数）。

## 7. 锚点跟位移

改 `services/api/src/**` 与两个测试文件后，跟到新读数的文档锚点（逐条旧 → 新，均按**内容**定位，非按差值平移）：

| 文档位置 | 旧读数 | 新读数 | 依据 |
| --- | --- | --- | --- |
| `docs/verification/gy-r72-jobs-owner-select-20261102.md:111` | `tests/integration/egress-ledger-pg.mjs` 第 379 行 | `tests/integration/egress-ledger-pg.mjs:402` | `SELECT: [ … 'owner_id' ]` 读数数组所在行 |
| `docs/verification/gy-r72-jobs-owner-select-20261102.md:112` | 第 391 行 | `tests/integration/egress-ledger-pg.mjs:414` | `assert.equal(ledgerReadings.length, 27, …)` 所在行 |
| `docs/verification/gy-r72-jobs-owner-select-20261102.md:180` | 第 379 行 | `tests/integration/egress-ledger-pg.mjs:402` | 同上 |
| `docs/verification/gy-r83-i29-consent-negatives-20261107.md:19` | 第 535 / 537 行 | `tests/integration/egress-ledger-pg.mjs:567` / `tests/integration/egress-ledger-pg.mjs:569` | 403 断言行 / `countExports` 断言行 |
| `docs/verification/gy-r83-i29-consent-negatives-20261107.md:21` | 第 514 / 522 / 530 行 | `tests/integration/egress-ledger-pg.mjs:537` / `tests/integration/egress-ledger-pg.mjs:545` / `tests/integration/egress-ledger-pg.mjs:553` | `synthetic.hang()` / `DELETE` 调用 / `error_code` 断言 |
| `docs/verification/gy-r83-i29-consent-negatives-20261107.md:22` | 第 533 行 | `tests/integration/egress-ledger-pg.mjs:565` | `writebackCount === 0` 断言 |
| `docs/verification/gy-r71-comment-strip-20261030.md:143`、`docs/verification/gy-r71-comment-strip-20261030.md:152` | 第 162 行 | `tests/unit/privacy-egress-ledger-error-code-closed-set.test.mjs:168` | 去注释正则（带 `://` 前缀豁免）所在行 |
| `docs/verification/gy-i15-messages-chain-20261021.md:108` | `miniprogram/utils/states.js` 第 150 行 | `miniprogram/utils/states.js:151` | 机械 +1（本片在 `miniprogram/utils/states.js:38` 插了一行 `CONSENT_WITHDRAWN` 登记），旧 150 与现 151 同为 `/**` 行 |
| `docs/verification/gy-r82-i29-ac3-code-evidence-20261106.md:28` | `services/api/src/errors.ts` 第 126 行 | `services/api/src/errors.ts:127` | 机械 +1（本片在 `services/api/src/errors.ts:14` 插了一行 `PrivacyError` import），旧 126 与现 127 同为 `export function buildErrorEnvelope(` |

这两条按 `tests/unit/doc-anchor-relocation-identity.test.mjs` 的机械位移口径处理（目标行内容前后一致 ⇒ 断言 `new === map(old)`，**不需要**在 `tests/unit/doc-anchor-relocations.json` 登记）；跑 `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` ⇒ 37/37 pass。

本片**新增**文件没有按行引用它的既有文档锚点：`tests/unit/job-terminal-reason-consent-withdrawn.test.mjs` 是本片新建；`tests/unit/tts-service.test.mjs` 只在**文件末尾**追加 45 行（`45 +/− 0`），既有行号零位移。

`packages/contracts/openapi.json` 的两处数组插入改成同行并列，正是为了**不让** ≥12780 的 10 条文档锚点整体 +2（改前该写法会让 `docs/architecture/state-contract.md:138`、`docs/architecture/acceptance-map.md:209` 等 10 条落到空行）。

未跟的两处（**历史页，未改**，留待审查裁定）：

- `docs/verification/gy-i29-closure-20261018.md:11` 引该测试文件的第 44 / 211 / 566-573 / 578 行（描述当次运行时的环境断言与清理行为）；
- `docs/verification/gy-r28-roles-file-disposition-20261021.md:86` 与 `docs/verification/gy-r28-favorites-history-grants-20261020.md:463` 引第 245 / 255-256 行；`docs/verification/gy-r28-recognitions-persist-20261020.md:48`、`docs/verification/gy-r28-recognitions-persist-20261020.md:98`、`docs/verification/gy-r28-recognitions-persist-20261020.md:144` 引的是**历史 stack trace 原文**（改数字等于篡改当次输出）。

## 8. 闸门读数

| 闸门 | 结果 |
| --- | --- |
| `node --test tests/ui-unified-states.test.mjs` | **10 tests / 10 pass / 0 fail**，EXIT=0（修前 `EXIT=1`：10 tests / 9 pass / 1 fail，见 §3.5） |
| `node tests/integration/egress-ledger-pg.mjs`（真 PG 17.11，`127.0.0.1:55441`） | `RESULT=PASS 16 组`，EXIT=0；`PASS 14` 是 #1059 的作用域负控制，`PASS 15`/`PASS 16` 是本片的负控制 B／C |
| `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | **37 tests / 37 pass / 0 fail**，EXIT=0 |
| `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | EXIT=0（`COUNT: BROKEN 4 / OUT_OF_RANGE 1 / SUSPECT 43 / NOT_SYMBOL_LINE 8`；`PASS: --strict 下没有基线之外的新增`） |
| `node tools/verify-contract-status.mjs` | EXIT=0（7 条 PASS：覆盖 130 条契约操作、语义可核 124 条区间、证据锚点 593 条、中文表格一致等） |
| `npm run test:docs` | EXIT=0（`PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables`；研究记录 `5 通过 / 0 失败 / 4 legacy 已钉住`） |
| `npm run test:contract` | EXIT=0（`tests 22 / pass 22 / fail 0`） |
| `node --test "tests/unit/*.test.mjs"`（`GY_BASH=D:\Git\bin\bash.exe`） | 见下方「单元全量」一行 |
| `node tools/lint-workspaces.mjs` | EXIT=0（`tsc --noEmit` 服务端 + 管理端、仓库卫生扫描三条 PASS） |
| `git merge-tree --write-tree --name-only origin/main HEAD` | EXIT=0（合并后无冲突标记） |

单元全量：`node --test "tests/unit/*.test.mjs"` ⇒ **tests 5660 / pass 5658 / fail 0 / skipped 2**，`EXIT=0`（含本片新增的 `tests/unit/job-terminal-reason-consent-withdrawn.test.mjs` 8 条与 `tests/unit/tts-service.test.mjs` 的 50 条）。

## 9. 本页不声称什么

- **不声称 B1 已完成**：没有跨域 `UPDATE public.jobs` 把 job 级联置 `cancelled`；`services/api/src/privacy/ledger-pg.ts:864-883` 仍然只动 `public.exports`。
- **不声称 jobs 被置 `cancelled`**：本片只让 `failed` 的原因可读；`state` 仍是 `failed`，不是 `cancelled`。
- **不声称供应商侧被物理取消**：`docs/architecture/state-contract.md:48` 明确「不承诺供应商物理取消」，本片也未触达供应商控制面。
- **不声称 `public.exports.cancelled_at` / `cancellation_reason` 在撤回时被写**：产品口径未定，本片未动（要动是另一张单）。
- **不声称 OCR／语音／会话／TTS 有真库端到端撤回用例**：这几域的改动只有 `tsc --noEmit` + 既有单测 + 静态闭集测（`tests/unit/privacy-egress-ledger-error-code-closed-set.test.mjs`）覆盖；真库四类用例只落在识别域。TTS 另有两层单元锚点——`tests/unit/job-terminal-reason-consent-withdrawn.test.mjs` 的三条「接缝」直接咬 `services/api/src/privacy/synthesis-egress.ts:315` 与 `services/api/src/privacy/synthesis-egress.ts:333`（假账本 + 假守卫，不连库），`tests/unit/tts-service.test.mjs` 末尾两条反例 + 一条负控制咬 thrown 分支的裁决。`tests/integration/tts-http.mjs`（42 checks / `RESULT=PASS`）走 stub/preset，`real` 模式仍 503（P05）——**它不覆盖撤回路径**。
- **不声称两页历史陈述已回填**：`docs/architecture/acceptance-map.md:299`（「媒体三域把 provider 抛出的任何异常吞成 `PROVIDER_OUTCOME_UNKNOWN`」）与 `docs/verification/gy-r71-async-privacy-codes-20261030.md:50`（「同族、不同码，本片未动」）在本片之后**内容已过时**，但两页属历史/台账页，本片未改，留待审查裁定是否回填。
