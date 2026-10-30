# GY-R71（G3）· 异步作业面：隐私类失败码不再折叠成「供应商挂了」（2026-10-30）

> 一句话：`settleCodeOf` 只认 `instanceof ApiError`，而问答外发口抛的是 `PrivacyError` ⇒
> 403 `CONSENT_REQUIRED`、409 `OBJECT_UNAVAILABLE`、400 `INVALID_REQUEST` 在作业面
> **统统落成** 503 `PROVIDER_UNAVAILABLE`。本片让这两个类携带的**闭集码**在作业面原样落地，
> 域外异常仍一律折叠（fail-closed 口径未放宽），并补 3 条用例 + 4 条负控制把这件事钉住。

**零契约改动**：`packages/contracts/**`、迁移、CI 全未动；作业封套仍是冻结的九键，
`retryable` **仍然不**进封套。改的是 `services/api/src/**` 的两处（1 处语义 + 1 处注释）
与其契约台账的行号漂移（见 §6.2）。

---

## 1 基线与口径

| 项 | 值 |
| --- | --- |
| `upstream/main` | `8b646ae1cf8c02a7a55a659cbe3b91f95fc5a7cc`（`git -C E:\GengYunCommander\GengYun_Agent2 rev-parse upstream/main` 与本片基线一致） |
| 工作树 | `E:\GengYunCommander\wt-r71-privcodes`，分支 `fix/gy-r71-async-privacy-codes` |
| 依赖 | `npm ci --prefer-offline --no-audit --no-fund --ignore-scripts --cache E:\GengYunCommander\.npm-cache`（exit 0，`added 103 packages in 4s`） |
| `TMP`/`TEMP` | 仓外 `E:\GengYunCommander\.pg17\tmp\r71-privcodes-tmp` |
| 运行时 | Windows / node v24.16.0 |

**本片没有**：真实模型调用、真实外发、真实资料库、真 PG、真实凭据。全部读数是合成夹具（回环 HTTP）。

---

## 2 缺陷取证：折叠发生在哪一行

折叠点是**一个函数、一行兜底**，但它的上游是一条完整的「外发守卫 → 回答器 → 任务 IIFE」链。

| # | 位置 | 代码事实 | 在本缺陷里的角色 |
| --- | --- | --- | --- |
| F1 | `services/api/src/conversations/service.ts:499` | `function settleCodeOf(error)`：`instanceof ApiError && isErrorCode(code)` ⇒ 保留，**否则** `return 'PROVIDER_UNAVAILABLE'` | **折叠点本身**（本片改的就是这一行的前置分支） |
| F2 | `services/api/src/conversations/service.ts:1154` | 任务 IIFE 的 `catch` 里 `const code = settleCodeOf(error)`，随后 `state = code === 'PROVIDER_TIMEOUT' ? 'timed_out' : 'failed'` | 唯一调用点（`git grep -n "settleCodeOf"` 只命中定义 + 这一处 + 1 条注释） |
| F3 | `services/api/src/privacy/task-egress.ts:289` | 非 `real` 模式 ⇒ `throw new PrivacyError('PROVIDER_UNAVAILABLE', …)` | 隐私域错误的**类**来源（`PrivacyError`，不是 `ApiError`） |
| F4 | `services/api/src/privacy/task-egress.ts:298` | `CHAT_OBJECT_KEY` 不匹配 ⇒ `PrivacyError('INVALID_REQUEST', …)` | 400 档被折叠的那条 |
| F5 | `services/api/src/privacy/task-egress.ts:313` / `:314` | `inFlight.assertExecutable(…)` / `ledger.markSent(…)` | 403/409 档被折叠的两条（由守卫与账本抛出） |
| F6 | `packages/privacy/in-flight.mjs:132` | 用途授权已撤回 ⇒ `PrivacyError('CONSENT_REQUIRED', …)` | 「去授权」类失败的真实抛点之一 |
| F7 | `packages/privacy/in-flight.mjs:151` | 外发已终态 ⇒ `PrivacyError('OBJECT_UNAVAILABLE', …)` | 「对象取不到」类失败的真实抛点之一 |
| F8 | `services/api/src/privacy/ledger-pg.ts:521` | 无唯一可用接收方 ⇒ `PrivacyError('CONSENT_REQUIRED', …)` | 同上（账本侧） |
| F9 | `services/api/src/ai/chat-live-adapter.ts:304` | `egress.send(…)` 的 `catch` 里 `throw error` —— **原样上抛**，不改写 | 证明 `PrivacyError` 能一路走到 F2，中间没有第二次包装 |
| F10 | `services/api/src/contract.ts:14` | `ERROR_STATUS_MAP`：`CONSENT_REQUIRED`→403、`OBJECT_UNAVAILABLE`→409、`INVALID_REQUEST`→400、`PROVIDER_UNAVAILABLE`→503 | 这四个码是**同一张契约表**的成员 ⇒ 保留原码不是新增暴露面 |

**涉及的作业源**（`git grep -n "settleCodeOf\|PrivacyError"` 逐个走完）：

| 作业源（`Job.kind`） | 结算路径 | 经 `settleCodeOf`？ | 隐私类失败的落地形态 |
| --- | --- | --- | --- |
| `answer`（文字问答） | `conversations/service.ts` 的任务 IIFE（F2） | **是** | **折叠前**：全部 `PROVIDER_UNAVAILABLE`（503）+ `failed`。**折叠后**：保留闭集原码（本片） |
| `recognition` / `ocr` / `speech`（媒体三域） | 各域 `execute()` 的 `runProviderWithDeadline` | 否 | 自己的折叠：`provider` 抛错被 `.catch(() => ({ kind: 'threw' }))` 吞掉 ⇒ `failed` + `PROVIDER_OUTCOME_UNKNOWN`（`recognitions/service.ts:543`、`ocr/service.ts:635`、`speech/service.ts:620`）。**同族、不同码，本片未动**（见 §10） |
| `synthesis`（TTS） | `tts/service.ts` 自己的失败码闭集 | 否 | 闸门拒绝经 `liveGateRefusalToErrorCode`（`tts/live-ports.ts:122`）。其中 `AUTHORIZATION_REQUIRED` ⇒ `PROVIDER_UNAVAILABLE` 是**同类名不同义**：那是「授权串与闸门不一致＝未接线」（`ai/live-gate.ts:102`），不是用户用途授权 ⇒ **不属于本缺陷**，已核对 |

**被保住 / 被折叠的码（折叠前基线口径）**：

| 错误码 | 契约状态 | 由谁抛 | 折叠前作业面 | 折叠后作业面 |
| --- | --- | --- | --- | --- |
| `CONSENT_REQUIRED` | 403 | `PrivacyError`（F6/F8） | `failed` + `PROVIDER_UNAVAILABLE` ❌ | `failed` + `CONSENT_REQUIRED` ✅ |
| `OBJECT_UNAVAILABLE` | 409 | `PrivacyError`（F5/F7） | `failed` + `PROVIDER_UNAVAILABLE` ❌ | `failed` + `OBJECT_UNAVAILABLE` ✅ |
| `INVALID_REQUEST` | 400 | `PrivacyError`（F4） | `failed` + `PROVIDER_UNAVAILABLE` ❌ | `failed` + `INVALID_REQUEST` ✅ |
| `PROVIDER_UNAVAILABLE` | 503 | `PrivacyError`（F3）或 `ApiError` | `failed` + `PROVIDER_UNAVAILABLE` ✅ | **不变** ✅ |
| `PROVIDER_TIMEOUT` / `PROVIDER_QUOTA_EXCEEDED` / `PROVIDER_OUTCOME_UNKNOWN` | 504/429/503 | `ApiError` | 各自原码 | **不变**（`ApiError` 分支未改） |
| 域外异常（无 `code`，或带闭集码但**不是**这两个类） | — | 任意第三方 | `PROVIDER_UNAVAILABLE` | **不变**（fold 仍生效，见 §7 P3） |

> 注：`SESSION_REQUIRED`(401) / `ACCOUNT_INACTIVE`(403) 也由 `PrivacyError` 携带、也可能在同一路径抛出
> （`packages/privacy/in-flight.mjs:106,119,123`）。它们随同一条规则一并保留原码 —— 这是**同一个判据的自然结果**，
> 不是本片额外放开的例外；这两个码在同步面同样是原样下发的契约码。

---

## 3 折叠前后对照表（客户端视角）

| 折叠前客户端看到的 | 折叠后客户端看到的 | 客户端该做什么 |
| --- | --- | --- |
| `state=failed` + `PROVIDER_UNAVAILABLE`（同意缺失、对象不可用、请求非法三种情形**完全同形**） | `state=failed` + `CONSENT_REQUIRED` | **让用户去授权**（这是用户动作，重试永远不会成功） |
| 同上 | `state=failed` + `OBJECT_UNAVAILABLE` | 该对象已撤回/取消/终态 ⇒ **刷新对象状态**，不要重试同一版本 |
| 同上 | `state=failed` + `INVALID_REQUEST` | 我们的请求或对象键非法 ⇒ **不要重试**，报缺陷 |
| `state=failed` + `PROVIDER_UNAVAILABLE` | **不变** | 供应商/装配问题 ⇒ 等一会儿重试或报运维 |

`state` 在四码上**全是** `failed`（只有 `PROVIDER_TIMEOUT` 落 `timed_out`，`conversations/service.ts:1155`），
所以**唯一的判据就是 `error_code`** —— 这正是本缺陷让客户端无法分流的原因，也是本片要修的东西。

---

## 4 修法：选 ①（放宽 `settleCodeOf`），不选 ②

| | ① 放宽 `settleCodeOf`（**采用**） | ② 让 `PrivacyError` 继承 `ApiError`（**放弃**） |
| --- | --- | --- |
| 改动面 | `services/api/src/conversations/service.ts` 一个函数 + 一行 import（净 +14 行，其中 12 行是注释） | `packages/privacy/errors.mjs` 的公共类型 + 跨包依赖 |
| 依赖方向 | 不变（`services/api` **本来就**依赖 `packages/privacy`：25 个文件里有 import，`task-egress.ts:25` 就是） | **反转**：`packages/privacy` 目前对 `services/api` **零依赖**（`git grep -n "ApiError" -- packages` 只有 4 处，全是注释引用，没有 import）；要继承就得让 `.mjs` 去 import 一个 `.ts` 的错误类 |
| 影响面实测 | 1 个函数、1 条调用链（`answer` 作业源） | `new PrivacyError` **198 处 / 14 个文件**；`instanceof ApiError` **47 处 / 43 个文件**——**每一处**都会因为「`PrivacyError` 突然也是 `ApiError`」而改变行为（典型：`if (error instanceof ApiError) throw error` 这类 store 层包装会把隐私错误**从折叠改成透传**，另有 `app.ts:2613` 的统一错误出口与 `retryAfterSecondsFor` 的 `Retry-After` 判定） |
| 语义风险 | 只在作业结算这一处生效；`retryable`、`details`、`status` 全不参与（`settleCodeOf` 只取 `code`） | 改变的是**所有**错误处理点的分类结果，需要逐点复核 47 处 `instanceof` 与 198 处抛点 |
| 契约面 | 零改动（九键不变，码都在既有闭集内） | 零契约改动，但**错误封套语义**全仓变宽（`toApiError`、`toErrorEnvelope`、`Retry-After`） |
| 结论 | **外科手术，代价 1 天以内** | 一个跨包重构，代价是「全仓错误分类复核」——与本缺陷的收益完全不成比例 |

**为什么 ① 的"放宽"没有违反 fail-closed**：`docs/architecture/acceptance-map.md` 对 ① 的原始描述是
「接受任意 `{code}` 形状」，那会把**任何**自带 `code` 的第三方错误当成契约码透出。本片**没有**那样做：
判据是 `instanceof PrivacyError`（与 `instanceof ApiError` 并列），**不做鸭子类型**。因此：

- 域外异常（含自带 `CONSENT_REQUIRED` 的第三方错误对象）**仍然**折成 `PROVIDER_UNAVAILABLE`（用例 P3 钉住）；
- `PrivacyError` 携带**闭集外**的码也仍然折叠（`isErrorCode` 守卫不动，用例 P3 第三行钉住）——
  否则 `GET /jobs/{id}` 的 `assertContractJob`（`services/api/src/jobs/registry.ts:139`）会把它变成 503；
- 这些码在**同步面**本来就原样交给客户端（`services/api/src/privacy/egress.ts:57` 的 `toApiError`
  把码与状态按同一张 `ERROR_STATUS_MAP` 转成 `ApiError`，`withPrivacyErrors`（同文件 `:164`）就挂在路由上）
  ⇒ 作业面保留原码**不新增任何暴露面**。

---

## 5 改了什么

| 文件 | 改动 | 行数 |
| --- | --- | --- |
| `services/api/src/conversations/service.ts` | `settleCodeOf` 增加一条 `instanceof PrivacyError && isErrorCode(code)` 分支；补 import；补 12 行注释（为什么、以及为什么不做鸭子类型） | +15 −1 |
| `services/api/src/ai/error-map.ts` | **只改注释**：原文说「`settleCodeOf` 只认 `ApiError.code`，非 `ApiError` 一律兜底」，本片后不再成立，改成「只保留 `ApiError` / `PrivacyError` 携带的闭集码，其余兜底」 | +2 −2（等长替换，无行号漂移） |
| `tests/unit/conversation-async-privacy-codes.test.mjs` | 新增 3 条用例（见 §6） | 新增 |
| `docs/verification/gy-r71-async-privacy-codes-20261030.md` | 本页 | 新增 |
| `docs/architecture/acceptance-map.md` | **文件末尾追加**一节，把 G3 从「缺口」改成「已修」（⛔ 未在中段插行） | 追加 |
| `docs/architecture/contract-implementation-status.md` / `docs/architecture/contract-status.json` | 契约台账重锚（§5.1）＋「超时」横切行里 7 个 `conversations/service.ts` 行号按 +1／+14 平移（同一处漂移的连带修正，JSON 是事实源、md 表由它派生） | +3 −3 / +3 −3 |
| `tools/doc-anchors-orphan-baseline.json` | 孤儿册重登记：1 条键随行号平移（新增 `service.ts:945`、陈旧 `service.ts:1107`，**不改写历史取证页数字**，理由进 accept 账本） | +7 −1 |
| `tests/unit/doc-anchor-relocations.json` | 新增 1 条 `kind: "correction"`（`createConversation` 的旧区间本来就短 2 行，本次按符号改正）；**另修好一条基线遗留的失效登记**（见 §5.2） | +12 −1 |
| `docs/verification/gy-i06-media-real-provider-plan-20261021.md` | 第 77 行的 `services/api/src/server.ts:62` → `:68`（**被基线提交 #781 挪走的行号**，见 §5.2；这是那条失效登记的唯一正确落点） | +1 −1 |

### 5.1 契约台账重锚（`node tools/verify-contract-status.mjs`）

`--reanchor` dry-run 报 **2 条**候选（都是纯行号漂移，锚点文本命中位置一致）：

| 操作 | 旧 lines | 新 lines | 漂移 |
| --- | --- | --- | --- |
| `createConversation` | `services/api/src/conversations/service.ts:636-679` | `695-738` | 锚点行 681 → 695 = **+14**（全部来自本片）。注：旧区间上界 679 与基线锚点行 681 本来就差 2 行（靠 ±2 容差通过），即**基线已有存量偏差**，本片只是把它一次性推到了明显位置。正因为「旧行窗口里根本没有这个符号」，`tests/unit/doc-anchor-relocation-identity.test.mjs` 只接受它走 `kind: "correction"` 登记（机械的 +14 平移会让锚点落在 `650-693`、反而指错） |
| `getConversation` | `services/api/src/conversations/service.ts:746-751` | `760-765` | +14（全部来自本片；旧窗口本身就含该符号，属纯位移，无需登记） |

已 `--reanchor --write-doc` 落盘并复跑至 exit 0；`docs/architecture/contract-implementation-status.md` 的两行
只有行号变化（逐字 diff 已核）。**接受漂移并在此登记**，未压注释保行号。

### 5.2 顺带修好的一条**基线遗留失效登记**（不是本片引入）

跑提交后的全量 `test:unit` 时，`doc-anchor-relocation-identity` 先红了 2 条，其中 1 条与本片无关：

- 登记表第 81 条（`docs/verification/gy-i06-media-real-provider-plan-20261021.md:77` → `services/api/src/server.ts` `:27 → :62`，`kind: correction`，`symbol: "buildApp("`）**在基线提交 `8b646ae1` 上就已经失效**：`8b646ae1`（#781「explicit moderation startup approval」）在同一行 `buildApp({...})` 里补了一项装配参数，把该调用从第 62 行推到**第 68 行**。于是「新行里必须能找到 `symbol`」这一条验真在任何 `base != HEAD` 的运行上都会红（`base == HEAD` 时整条用例短路，所以提交前看不出来）。
- 处理：把该登记与它指向的那一行**同时改到真实的第 68 行**（`from: 27` 与 `symbol` 一字未动），并在 `reason` 里写明是 #781 挪的行。**这不是本片的行为改动**，是把一条已经在红的判据恢复成可判。
- 影响面：`services/api/src/server.ts` 本片未改动；`docs/verification/gy-i06-…md` 只改这一个行号（锚点数不变，`ANCHOR-COUNT` 不变）。
- **报告里如实登记**：这属于「本片顺手修了别人的门禁债」，请裁定是否接受（若不接受，替代做法是让本片与那条遗留红共存，但那样九条门禁无法全绿）。

---

## 6 新增断言清单（`tests/unit/conversation-async-privacy-codes.test.mjs`）

| 用例 | 断言什么 | 条数 |
| --- | --- | --- |
| **P1** 四码矩阵 | ① 四码（`CONSENT_REQUIRED` / `OBJECT_UNAVAILABLE` / `INVALID_REQUEST` / `PROVIDER_UNAVAILABLE`）在作业面 `state=failed` + `error_code` **保留原码**；② `PROVIDER_UNAVAILABLE` 的两个载体（`PrivacyError` 经非 real 外发口、`ApiError` 直抛）都仍是该码；③ 每码的契约状态码逐行 403/409/400/503/503；④ 四码互不相同且**同 state**（⇒ 分流判据只能是 `error_code`）；⑤ 三个投影点各自**恰好九键**且 `hasOwnProperty('retryable') === false`（`createTurn` 的 202 封套 / `jobViewOf` / `projectTurnJob`）；⑥ **正向对照**：`CONSENT_REQUIRED` 发生在 `resolveRecipient`（零预留零外发）、`OBJECT_UNAVAILABLE` 发生在 `markSent`（预留→执行前重查→授权边界，且**不**被写回成 `markFailed`）、`INVALID_REQUEST` 挡在任何账本调用之前（`calls` 为空） | 1 条用例（19 个断言） |
| **P3** 折叠口径未放宽 | 普通 `Error`、**自带闭集码的第三方错误对象**、`PrivacyError` 携带**闭集外**码 —— 三者仍一律 `failed` + `PROVIDER_UNAVAILABLE` | 1 条用例（9 个断言） |
| **P4** `ApiError` 分支不变 | `ApiError('PROVIDER_UNAVAILABLE')` 仍是该码；`ApiError('PROVIDER_TIMEOUT')` 仍落 `timed_out`（不是 `failed`） | 1 条用例（7 个断言） |

**为什么 P1 不是"测试替身随手抛一个码"**：前三行走的是**生产同一个** `createChatEgress(...).send`
（`services/api/src/privacy/task-egress.ts`），失败点在**与生产同一行**的位置（`resolveRecipient` / `markSent` /
对象键校验），抛的是**同一条** `PrivacyError`（码与文案逐字对齐 F6/F7/F8 的源码行）。
`calls` 记账那是正向对照：证明码是从守卫路径出来的。

---

## 7 负控制（四条，逐条实际打红、恢复后复绿）

| # | 变异 | 红点（实测） | 恢复 |
| --- | --- | --- | --- |
| NC① | `settleCodeOf` 里把 `PrivacyError` 的码**再折回** `PROVIDER_UNAVAILABLE`（＝本片前的基线行为） | `✖ P1 … AssertionError: CONSENT_REQUIRED（同意缺失）：作业面必须保留原码`（`expected 'CONSENT_REQUIRED'`，实得 `PROVIDER_UNAVAILABLE`）；P3/P4 仍绿 | 复绿 ✅ |
| NC② | 只让 `INVALID_REQUEST` 也折（`error.code === 'INVALID_REQUEST'` ⇒ `PROVIDER_UNAVAILABLE`） | `✖ P1 … AssertionError: INVALID_REQUEST（对象键非法）：作业面必须保留原码`；同一次运行里前两行（`CONSENT_REQUIRED`/`OBJECT_UNAVAILABLE`）**通过**，`conversation-qa-source-recovery.test.mjs` 23 条全绿（无附带损伤） | 复绿 ✅ |
| NC③ | 让 `PROVIDER_UNAVAILABLE` 被误改成别的码（`PrivacyError` 携带的 503 ⇒ `PROVIDER_OUTCOME_UNKNOWN`） | `✖ P1 … AssertionError: PROVIDER_UNAVAILABLE（PrivacyError 载体，非 real 模式 fail-closed）：作业面必须保留原码`，`actual: 'PROVIDER_OUTCOME_UNKNOWN'` | 复绿 ✅ |
| NC④ | 顺带把 `retryable` 塞进作业封套（`conversations/job.ts` 的 `projectTurnJob` 多一个键） | `✖ P1/P3/P4 … AssertionError: Job 键集必须恰好是契约声明的九键`，diff 里直接列出多出的 `+ 'retryable'`；**同时** `GET /jobs/{id}` 被 `registry.assertContractJob` 判 503 并回显「键集合必须恰好是 [九键]」——冻结在两个层次上都拦住（证明冻结仍有效） | 复绿 ✅ |

---

## 8 九条门禁读数（+ CI-exact anchors + 额外两条）

| 门禁 | 读数 | exit |
| --- | --- | --- |
| `npm run test:unit` | **提交后**：`tests 5855 / pass 5852 / fail 0 / cancelled 0 / skipped 1 / todo 2`（含本片新增 3 条；`doc-anchor-relocation-identity` 在本 HEAD 上是**绿**的 —— 它此前红过两次，都不是本片的行为红，见 §5.2 与 §8.1） | 0 |
| `npm run verify:anchors` | `verify-contract-status` PASS（覆盖 126 条契约操作；已装配 126；implemented 18 / partial 108 / planned 0；形状错误 0、语义错误 0；行号区间 313 条）；`verify-doc-anchors --strict` PASS（结构四判据、`ANCHOR_DRIFT`、`BARE_ORPHAN`、`ANCHOR-COUNT` 全部只计数不判红：`BASELINE` 37/37、`BARE-ORPHAN-OUTSIDE` 134 登记 / 命中 121 / 基线外新增 0 / 陈旧 0） | 0 |
| **CI-exact** `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | `SYMBOL-STRICT` 基线 31 条全命中、基线外新增 **0**；`ANCHOR-COUNT` 6554 条 / 237 份（清册 6287 / 227，下降 **0** 份、上升 15 份）；`BARE-ORPHAN` 3543/3543（新增 0、陈旧 0）；`outsideRed` 134/134（命中 134、新增 0、陈旧 0）；`PASS: --strict 下没有基线之外的新增` | 0 |
| `npm run verify:parity` | `extra []` / `missing []` / `ledgerDrift []` | 0 |
| `npm run verify:capability-map` | `totalOps=46，有入口=46，无入口=0，死按钮=0`；「文档标记块与重算一致」 | 0 |
| `npm run test:docs` | 研究记录 `5 通过 / 0 失败 / 4 legacy 已钉住`；`docs/research` 结构校验 PASS | 0 |
| `npm run lint` | `tsc --noEmit` services/api PASS、apps/admin PASS；仓库卫生扫描 PASS | 0 |
| `npm run test:contract` | `tests 17 / pass 17 / fail 0` | 0 |
| `npm run build` | api（`tsc -p`）+ admin（`vite build`）均 built；**build 后已删除** `services/api/dist` 与 `apps/admin/dist`，再跑 unit。注：第一次调用因命令管道把 stdout 提前关闭而让 `vite build` 报 `npm error`（非代码问题），改为整段重定向到文件后复跑 exit 0 | 0 |
| `npm run test:failmatrix` | `矩阵合计 249 条：PASS 249 / FAIL 0` | 0 |
| 额外·`node tools/verify-contract-status.mjs --reanchor`（dry-run） | **2 条**候选（`createConversation` / `getConversation` 的纯行号漂移，见 §5.1）⇒ `--reanchor --write-doc` ⇒ 复跑 exit 0 | 0 |
| 额外·`node tools/verify-doc-anchors.mjs --scan docs --write-orphan-baseline --accept=1 --why=…` | 本片 +14 行漂移使历史页 `docs/verification/gy-i12-conversations-gap-20261021.md` 的两条裸锚点键（含行号）平移：新增 `service.ts:945`、陈旧 `service.ts:1107`（都是 `SUSPECT`、都仍在册）。**按仓规不改写取证页数字**，理由已落进 `tools/doc-anchors-orphan-baseline.json` 的 accept 账本 | 0 |

### 8.1 提交前后 `test:unit` 的差异（不是代码红）

本仓的 `doc-anchor-relocation-identity` 在**未提交**时（`base == HEAD`）没有判定面，会刻意硬红以自保；
因此 `test:unit` 的读数必须在**提交后**取。§8 表里给的是提交后的读数；负控制都是在提交前的单文件
`node --test tests/unit/conversation-async-privacy-codes.test.mjs` 上打的红（不需要全量套件）。

这条用例在本片里共有三次读数，**逐次如实登记**（两次红都不是产品行为红）：

| 次序 | 读数 | 红点 | 处置 |
| --- | --- | --- | --- |
| 第 1 次（提交后） | `tests 5855 / pass 5851 / fail 1` | 2 条：① 本片台账重锚被要求走 `kind: "correction"` 登记；② **基线遗留**的第 81 条失效登记（§5.2） | 加登记 ①；修 ② 的 `to` 与它指向的历史页行号 |
| 第 2 次（提交后） | 同上，`fail 1` | 1 条：第 81 条的 `from` 必须取文档**现值** `62`（登记表按「文档现值 → 新值」配对，写 `27` 配不上） | 把该条改成 `62 → 68`，历史沿革写进 `reason` |
| 第 3 次（最终 HEAD） | `tests 5855 / pass 5852 / fail 0`（`skipped 1 / todo 2`） | — | 绿 |

---

## 9 证明了什么 / 没证明什么

### 9.1 证明了

1. **折叠点只有一个**：`settleCodeOf`（`services/api/src/conversations/service.ts:499`），唯一调用点是任务 IIFE 的
   `catch`（同文件 `:1154`）；`git grep -n "settleCodeOf"` 全仓只命中这两处 + 1 条注释。
2. **四个码在作业面可分流**：`state` 全为 `failed`，`error_code` 四值互不相同，且每个码的 HTTP 语义与契约表一致。
3. **折叠口径没有被放宽**：域外异常与「自带闭集码的第三方对象」仍折叠，`PrivacyError` 的闭集外码也仍折叠。
4. **契约冻结仍有效**：三个投影点各恰好九键；`retryable` 不在封套里（NC④ 在 `assertContractJob` 与本地断言两处同时打红）。
5. **没有附带损伤**：`conversation-qa-source-recovery.test.mjs`（23 条）、`conversation-http`、`conversation-failure-visibility`
   等既有问答用例在改后全绿；全量 `test:unit` 读数见 §8。

### 9.2 没证明 / 不在本片范围

1. **产品 HTTP 路径上的一次真实隐私类失败**：本片全部读数是合成夹具（替身外发口 / 替身账本）。真 PG 账本 +
   真 `inFlight` 守卫抛出的 `CONSENT_REQUIRED` **没有**在真实部署上取过读数（与本域既有片的诚实边界一致）。
2. **媒体三域的同类折叠未修**：`recognition`/`ocr`/`speech` 把 provider 抛错折成 `PROVIDER_OUTCOME_UNKNOWN`
   （§2 表），那是**另一处折叠、另一套码**，属相邻面。改它要动三域各自的「提供者失败码闭集」设计 ⇒ 需裁定（§10）。
3. **`SESSION_REQUIRED` / `ACCOUNT_INACTIVE` 的行为变化未单独建用例**：它们随同一条规则保留原码（§2 注），
   本片只对派单点名的四码建断言。
4. **不做 `{code}` 鸭子类型**是有意的取舍：若将来要支持跨 realm（同码不同类）的 `PrivacyError`，
   需要另立判据（`name === 'PrivacyError'` + `isErrorCode`），本片**不**预埋。
5. **客户端分流未做**：本片只保证服务端给出可分流的判据；小程序/后台是否按 `error_code` 分流到
   「去授权」还是「重试」，不在本片。

---

## 10 需裁定点

1. **媒体三域要不要同口径修**：`recognitions`/`ocr`/`speech` 的 `PROVIDER_OUTCOME_UNKNOWN` 折叠要不要也保留
   隐私原码？它们各自的提供者失败码是**四值闭集**（`PROVIDER_UNAVAILABLE`/`QUOTA`/`OUTCOME_UNKNOWN`/`TIMEOUT`），
   把 `CONSENT_REQUIRED` 等加进去等于改三域契约外的失败码集合 ⇒ 需产品/契约裁定。
2. **`ACCOUNT_INACTIVE`(403) 在作业面出现时，客户端动作是「重新登录」**：这个码在作业面落地后语义清晰，
   但它同时是**账号状态**信号 —— 是否需要同步给 `/health` 或告警，属 G1（运维可见性）的范围。
3. **契约台账的存量漂移**：`createConversation` 的锚点在基线上就已偏移 2 行（靠 ±2 容差通过），本片只是把它
   一次性推到了明显位置。是否要加一条「锚点必须零漂移」的 CI 断言，属 CI 口径问题。
