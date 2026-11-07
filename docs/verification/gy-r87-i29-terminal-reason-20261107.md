# GY-R87 / #29：撤回导致的 job 终态原因可读（2026-11-07）

- 基线：`origin/main` = `040867a7`（2026-11-07 23:26:16 +0800）
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
| `services/api/src/contract.ts:17` | 403 档**行内**插入 `'CONSENT_WITHDRAWN'`（紧跟 `'CONSENT_REQUIRED'`）——不插行，保住该文件 20+ 处文档锚点 |
| `packages/contracts/states.json:118-123` | 403 组同序插入 `"CONSENT_WITHDRAWN"` |
| `packages/contracts/openapi.json:12772`（`ErrorCode.enum`）、`packages/contracts/openapi.json:20111`（`x-error-status-map."403"`）、`packages/contracts/openapi.json:19900`（`Error403.description`） | 前两处改成**同行并列**（`"CONSENT_REQUIRED", "CONSENT_WITHDRAWN",`）以保持零行位移；description 行内补串 |
| `packages/privacy/constants.mjs:107`、`packages/media/constants.mjs:108` | 403 行内追加（两个镜像逐档 deepEqual `states.json`） |
| `apps/admin/src/lib/admin-contract.mjs:31-59` | `ERROR_CODES` 插入 `'CONSENT_WITHDRAWN',` |
| `apps/admin/src/lib/admin-content-view-model.mjs:319` | `READ_FAILURE_CODE_LABELS` 增中文文案（该表要求与 `ERROR_CODES` 完全同集） |
| `tests/unit/contract-code-name-pairs.test.mjs:493`、`tests/unit/contract-code-name-pairs.test.mjs:530` | 28 → 29（两处硬编码计数钉子） |
| `docs/architecture/ai-ops-spec-status.md:61`、`docs/architecture/ai-ops-spec-status.md:107` | 「错误码单源 28 码」→ 29、「恰好 28 个错误码」→ 29 |
| `tests/unit/privacy-egress-ledger-error-code-closed-set.test.mjs:99` | `DOCUMENTED_EXCEPTIONS` 删掉 `'CONSENT_WITHDRAWN'`，只留 `['OBJECT_CANCELLED']`（该测要求例外表成员必须**不在**契约闭集） |

**契约影响**：`CONSENT_WITHDRAWN` 落在 **403** 档（撤回后继续处理是权限问题，与既有 `CONSENT_REQUIRED` 同档），与 `public.exports.error_code` 同名，便于逐行对账。`services/api/src/jobs/registry.ts:244-246` 的「failed/timed_out 必须带契约 `error_code`」约束因此可被合法满足（新码在闭集内）；数据库侧 `error_code` 列是 `varchar(80)` + 长度 CHECK，**无闭集约束，故无迁移**。

### 3.2 原因穿过服务层（`services/api/src/errors.ts`）

`services/api/src/errors.ts:12` 行内补 `isErrorCode` import；**文件末尾追加**（既有 143 行零位移，新函数在 `services/api/src/errors.ts:159-164`）：

```js
export function terminalFailureCodeOf(error: unknown): ErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !isErrorCode(code)) return 'PROVIDER_OUTCOME_UNKNOWN';
  if (code === 'CONSENT_REQUIRED' || code === 'CONSENT_WITHDRAWN') return 'CONSENT_WITHDRAWN';
  return 'PROVIDER_OUTCOME_UNKNOWN';
}
```

只认两个**契约闭集内**的码；`isErrorCode` 先兜一道，域外错误对象的任意 `{code}` 鸭子类型冒充不了契约码。

> 为什么不复用现成的 `failureCodeOf`：`services/api/src/privacy/ledger-pg.ts:1084-1088` 的 `failureCodeOf` 只认**账本摘要形状** `{kind:'failed', code}`，直接传抛出的 `PrivacyError` 必得 `null`（`services/api/src/privacy/task-egress.ts:443` 的注释也写明「不认 Error」）。`services/api/src/privacy/task-egress.ts:210-213` 的 `errorCodeOf` 认 `{code}` 但是模块私有、且会把任意闭集码原样放行（含 `OBJECT_UNAVAILABLE`）——用它会误标，故新写一个小函数。

### 3.3 三域保留错误对象并裁决原因

| 域与文件 | 四处改动 |
| --- | --- |
| `services/api/src/recognitions/service.ts:29`、`:485`、`:532-533`、`:544` | import 加 `terminalFailureCodeOf`；threw 分支 `errorCode: terminalFailureCodeOf(outcome.error)`；联合 `{ kind: 'threw'; error: unknown }`；`.catch((error: unknown) => ({ kind: 'threw' as const, error }))` |
| `services/api/src/ocr/service.ts:33`、`:572`、`:620`、`:635` | 同上四式 |
| `services/api/src/speech/service.ts:52`、`:541`、`:606`、`:620` | 同上四式 |

三文件行数均零位移（识别 940 行、语音 936 行等），因为 `docs/architecture/contract-implementation-status.md:43`、`docs/verification/gy-r28-contract-line-anchors-20261021.md:361-362` 用符号引脚引它们的 `runProviderWithDeadline`（±2 容差，且语音的 `cancelJob` 在 `services/api/src/speech/service.ts:666` 是**无容差**引脚）。

### 3.4 外发层把「账本终态原因」翻译成契约码（`services/api/src/privacy/task-egress.ts`）

四处守卫调用点改成 try/catch 包装（媒体外发在 `services/api/src/privacy/task-egress.ts:127`、`services/api/src/privacy/task-egress.ts:143`；问答外发在 `services/api/src/privacy/task-egress.ts:424`、`services/api/src/privacy/task-egress.ts:475`），文件末尾（原 500 行）追加三个 helper：

- `withdrawalAwareFailure(ledger, exportId, error)`：
  - `code === 'CONSENT_REQUIRED'`（执行前重查直接抛）⇒ 立刻翻译成 `PrivacyError('CONSENT_WITHDRAWN', '外发因撤回同意而终止，结果不予写入')`；
  - `code !== 'OBJECT_UNAVAILABLE'` ⇒ 原样返回（**不碰**取消墓碑、无预留、版本变化）；
  - 否则读 `ledger.get(exportId)`（try/catch 包住，假账本可能没有 `get`），**仅当** `record.state === 'failed'` 且 `record.errorCode === 'CONSENT_WITHDRAWN'` 才翻译。
- `assertExecutableOrWithdrawn(...)`、`saveResultOrWithdrawn(...)`：薄包装，`throw await withdrawalAwareFailure(...)`。

`packages/privacy/in-flight.mjs` 与 `services/api/src/privacy/ledger-pg.ts:864-883` 的 SQL 一字未改。

## 4. 四个域的处置

| 域 | 处置 | 依据 |
| --- | --- | --- |
| 识别 | **改**（见 §3.3） | `.catch(() => ({ kind:'threw' }))` + `commitTerminal('PROVIDER_OUTCOME_UNKNOWN')` 同形 |
| OCR | **改** | 同形（`services/api/src/ocr/service.ts:571-574`、`services/api/src/ocr/service.ts:635`） |
| 语音 | **改** | 同形（`services/api/src/speech/service.ts:540-543`、`services/api/src/speech/service.ts:620`） |
| 会话 | **未改——该域无此问题** | `services/api/src/conversations/service.ts:499-503` 的 `settleCodeOf` 已经「`instanceof ApiError` / `instanceof PrivacyError` 且 `isErrorCode` ⇒ 保留原码」，唯一调用点 `services/api/src/conversations/service.ts:1298` 在异步任务 IIFE 的 catch 里，**不经过** `.catch(()=>({kind:'threw'}))` 折损。加契约码后它自动能写出 `CONSENT_WITHDRAWN` |
| （参照）TTS | **未改** | `services/api/src/tts/service.ts:698` 与 `services/api/src/tts/service.ts:710` 早已是 `{ kind:'threw'; error: unknown }` 形态，本无缺口 |

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

### 5.2 负控制 A（不误伤其它用途/其它用户）——`PASS 14`

```text
PASS 14: 负控制 A（真 PG）：撤回只圈「该用户 × 该用途」——同行被置 failed/CONSENT_WITHDRAWN，同用户另一用途行与另一用户行仍为 sent
```

做法：同一用户三条行（`media/weed_recognition` 真 `reserve`+`markSent`；`answer/checked_content` 真 `reserve`+`markSent` 后把 `required_consents` 改成只留 `model_improvement` 一项（epoch 1）；另一用户 `media/weed_recognition`）⇒ 只撤回该用户的 `external_inference` ⇒ 行 1 `failed/CONSENT_WITHDRAWN`，行 2、行 3 仍 `sent`。

> 诚实性说明（已写进用例注释）：产品流程里造不出「同用户另一用途」的外发行——`packages/privacy/constants.mjs` 的 `requiredConsentsForDataType` 对所有已知资料类型都要求 `external_inference`。这一条因此是**直接钉撤回 SQL 的谓词**（`services/api/src/privacy/ledger-pg.ts:864-883` 的 `required_consents ? $2`），不是端到端产品路径。

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
| A | `services/api/src/errors.ts:162` 的 `CONSENT_WITHDRAWN` 分支改回 `PROVIDER_OUTCOME_UNKNOWN` | `AssertionError [ERR_ASSERTION]: 读面必须自证撤回：期望 CONSENT_WITHDRAWN，实际 PROVIDER_OUTCOME_UNKNOWN（落成 PROVIDER_OUTCOME_UNKNOWN ＝ 仍然分不清撤回与供应商故障）`；`EXIT=1` | **正控制必红**，说明读面断言真的钉在这条分支上 |
| B | 同函数改成**一律**返回 `CONSENT_WITHDRAWN` | `AssertionError [ERR_ASSERTION]: 提供者炸了绝不能被标成撤回：实际 CONSENT_WITHDRAWN`；`EXIT=1` | **负控制 C 必红**，说明断言能抓「把所有失败标成撤回」的假绿 |

两次变异都在运行后立即还原；还原后复跑 `RESULT=PASS 16 组`、`EXIT=0`，`git status` 只含本提交的文件。

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

`packages/contracts/openapi.json` 的两处数组插入改成同行并列，正是为了**不让** ≥12780 的 10 条文档锚点整体 +2（改前该写法会让 `docs/architecture/state-contract.md:138`、`docs/architecture/acceptance-map.md:209` 等 10 条落到空行）。

未跟的两处（**历史页，未改**，留待审查裁定）：

- `docs/verification/gy-i29-closure-20261018.md:11` 引该测试文件的第 44 / 211 / 566-573 / 578 行（描述当次运行时的环境断言与清理行为）；
- `docs/verification/gy-r28-roles-file-disposition-20261021.md:86` 与 `docs/verification/gy-r28-favorites-history-grants-20261020.md:463` 引第 245 / 255-256 行；`docs/verification/gy-r28-recognitions-persist-20261020.md:48`、`docs/verification/gy-r28-recognitions-persist-20261020.md:98`、`docs/verification/gy-r28-recognitions-persist-20261020.md:144` 引的是**历史 stack trace 原文**（改数字等于篡改当次输出）。

## 8. 闸门读数

| 闸门 | 结果 |
| --- | --- |
| `node tests/integration/egress-ledger-pg.mjs` | `RESULT=PASS 16 组`，EXIT=0 |
| `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | EXIT=0（`BASELINE: 登记 56 条；本次命中 56 条、基线外新增 0 条`） |
| `node tools/verify-contract-status.mjs` | EXIT=0（`PASS: 中文表格一致` 等 7 条） |
| `npm run test:unit` | 见提交报告（含 `tests/unit/doc-anchor-relocation-identity.test.mjs`，它在 `HEAD === origin/main` 时会主动判红「没有判定面」，需在提交后复跑） |
| `npm run test:contract` | EXIT=0（22 pass） |
| `node tools/lint-workspaces.mjs` | EXIT=0 |

## 9. 本页不声称什么

- **不声称 B1 已完成**：没有跨域 `UPDATE public.jobs` 把 job 级联置 `cancelled`；`services/api/src/privacy/ledger-pg.ts:864-883` 仍然只动 `public.exports`。
- **不声称 jobs 被置 `cancelled`**：本片只让 `failed` 的原因可读；`state` 仍是 `failed`，不是 `cancelled`。
- **不声称供应商侧被物理取消**：`docs/architecture/state-contract.md:48` 明确「不承诺供应商物理取消」，本片也未触达供应商控制面。
- **不声称 `public.exports.cancelled_at` / `cancellation_reason` 在撤回时被写**：产品口径未定，本片未动（要动是另一张单）。
- **不声称 OCR／语音／会话三域有真库端到端用例**：三域改动只有 `tsc --noEmit` + 既有单测 + 静态闭集测（`tests/unit/privacy-egress-ledger-error-code-closed-set.test.mjs`）覆盖；真库四类用例只落在识别域。
- **不声称两页历史陈述已回填**：`docs/architecture/acceptance-map.md:299`（「媒体三域把 provider 抛出的任何异常吞成 `PROVIDER_OUTCOME_UNKNOWN`」）与 `docs/verification/gy-r71-async-privacy-codes-20261030.md:50`（「同族、不同码，本片未动」）在本片之后**内容已过时**，但两页属历史/台账页，本片未改，留待审查裁定是否回填。
