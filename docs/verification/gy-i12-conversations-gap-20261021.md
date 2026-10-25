# GY-I12 文字问答：stub → 真链路 · 现状盘点与接线方案（2026-10-21）

## 0. 结论与决策（先读这段）

**选定 A：只出接线方案，不动 `services/api/src/conversations/service.ts`，不加 migration，不改契约台账。**

理由（按权重排序）：

1. **B 已经过时**：对话持久化**早已合入 main**。`services/api/db/migrations/0013_conversations.sql` 在 `cf2f5ed`（`feat(GY-I12): 服务端问答闭环 … (Refs #12) (#214)`）里，建了 `conversations` / `conversation_turns` / `conversation_answers` 三张表；`services/api/src/conversations/store-pg.ts:181` 已有 `createPostgresConversationStore(`，`:215` 是 `persistent: true`。迁移总数已是 **26**、最大号 `0026_speech_persistence.sql`，不存在「需要补 0027 建表」这件事。派单里 B 的前提（「若 PG 持久化未合入」）不成立。
2. **C 的前提（「真跑通单测」）在本仓当前事实下不可能自证**：本片缺的不是「一个可以替换的 stub 函数」，而是**整个仓库里没有任何语言模型提供者、没有任何 LLM 外发通道、也没有可用的真实凭据**：
   - `services/api/src` 内 `provider.ts` 只有 `ocr` / `recognitions` / `speech` 三个，**没有** `conversations/provider.ts`；全目录对 `llm` / `DEEPSEEK` / `ai-config` 的引用只有两处注释（`tts/live-ports.ts:156`、`moderation/provider.ts:5`）。
   - LLM 端点确实存在，但**只给手工验证工具**：`tools/ai-config.mjs:10` 的 `llm` allowlist 条目（`https://api.deepseek.com/chat/completions` / `deepseek-flash` / `DEEPSEEK_API_KEY`），而 `tools/verify-llm-live.mjs:1` 头部逐字写着 "Manual synthetic-input LLM live verification only; never used by application consumers."。
   - 真实凭据文件 `docs/verification/config.local.json` 被 `.gitignore:42` 排除、仓内不存在 ⇒ 无法发起任何真实调用，也就无法产出「真链路可用」的证据。
   - 因此 C 若硬做，只能写出一个「恒 `PROVIDER_UNAVAILABLE`」的空壳适配器 —— 那是把 `ocr/provider.ts:168-182` 的 fail-closed 骨架搬到问答域，**不构成 GY-I12 的推进**，还会碰 `service.ts` 这一大改点与 `contract-status.json` 的语义边界（升级权限在监工）。
3. **A 才是当前缺口本身**：断点极度集中（唯一插入点是 `service.ts:1041` 一行 `composer.compose(...)`），而**接线方式、外发合规闸、版本串语义、测试改造**这四件事都必须先由监工裁决（尤其 §6 的 R-1/R-2/R-3），写手不宜先行落码。

**本文不宣称任何真实能力已接线。** real 模式的判定在本仓是 fail-closed 的（见 §3.2、§5.4），本文件不改变这一点，也不产出任何「real 已通过」的表述。

---

## 1. 口径声明与基线

- worktree：`E:\GengYunCommander\wt-b2-conv`，分支 `feat/gy-r28-b2-conversation-real`
- 基线：`upstream/main = f7155d5ac1329974b20a6128e332bb84c19c733d`
- 本文全部行号均在该基线上核对过一次；引用形态与 `docs/architecture/contract-status.json` 的锚点口径一致（`ANCHOR_TOLERANCE` 允许裁掉声明行后的空行/注释）。
- 本文**只读**了 `packages/contracts/openapi.json`，未做任何修改。
- 本文**未修改** `docs/architecture/contract-status.json`：7 条 operation 继续一律 `partial`（§2），其 `blocker` 文本与实测一致，无需订正；任何状态升级由监工决定。

---

## 2. 七个 operationId 的真实状态

`docs/architecture/contract-status.json` 的 `operations` 是数组，条目主键是 `id` 而非 operationId；下表按 operationId 列，status 取自台账原值。

| operationId | HTTP | route_mounted | 台账 status | 判据（为什么是这个状态） |
| --- | --- | --- | --- | --- |
| `createConversation` | `POST /conversations` | 是 | **partial** | 有真实代码路径与 PG 持久化，但回答永远由确定性回答器产出，三个版本串恒带 `unimplemented:no-real-` 前缀 ⇒ 属台账 `partial` 定义里的「存在已记录的契约偏差」 |
| `listConversations` | `GET /conversations` | 是 | **partial** | 读面本身可用（keyset 游标 + 签名），偏差同上：同域产物不自称真实模型 |
| `getConversation` | `GET /conversations/{id}` | 是 | **partial** | 同上 |
| `deleteConversation` | `DELETE /conversations/{id}` | 是 | **partial** | 同上；级联删除走 store 的 `ON DELETE CASCADE`（0013） |
| `createTurn` | `POST /conversations/{id}/turns` | 是 | **partial** | 202 + 作业源可用、风险筛查可用、引用守卫可用；**候选正文来自确定性回答器**（`service.ts:243`），非模型 |
| `listTurns` | `GET /conversations/{id}/turns` | 是 | **partial** | 同上 |
| `deleteTurn` | `DELETE /conversations/{id}/turns/{turnId}` | 是 | **partial** | 同上 |

台账 `status_definitions` 原值（逐字）：

- `implemented` = 「main 上已装配 http 路由，且行为有可复核证据（源码路径+行 或 测试文件+可定位文本片段）」
- `partial` = 「有对应操作代码，但产品 HTTP 未装配、缺运行条件/分支，或存在已记录的契约偏差」
- `planned` = 「未取得对应操作的产品实现证据；可能已有相关领域库，但尚无此 HTTP 服务，不推断已完成」

**没有一条是 `planned`，也没有一条是 `implemented`。** 「HTTP 未装配」不是本域的问题；本域的问题是「已记录的契约偏差」这一支 —— 即 §3.2 的生成侧。

---

## 3. 断链定位：四段已通，唯一断点在「生成侧」

### 3.1 已通的四段（证据逐条可核）

| 段 | 状态 | 证据 |
| --- | --- | --- |
| 存储 | **已通（real 走 PG）** | `services/api/src/app.ts:1507-1511`：`real` + 有 `pool` ⇒ `createPostgresConversationStore(pool)`；非 `real` ⇒ 内存 store。`app.ts:1545-1550` 的 `conversationStore === null \|\| (config.executionMode === 'real' && !conversationStore.persistent) ? null : createConversationService({...})` 明确：**即使测试注入内存 store，real 下也不能绕过 fail-closed** |
| 检索 | **已接真实读面（但依赖 `DATABASE_URL`）** | `app.ts:1346-1350` 的 `knowledgeQueryFace`（与 `/knowledge` 同一实例）→ `app.ts:1522-1528` `createKnowledgeRetrievalPort({ face: knowledgeQueryFace })`；无库时退到 `guard.ts:78-89` 的 `createUnwiredRetrievalPort`（`available:false`、`read()` 恒 `null` ⇒ 一律 `insufficient`） |
| 风险/注入筛查 | **真实** | `services/api/src/conversations/screen.ts:170`（原记 :152） `createModerationRiskScreen(...)`，复用 `packages/moderation` 的 `evaluateHardRules`；规则版本由 `screen.ts:126` `RISK_RULE_VERSION = deriveRuleVersion(RISK_RULES, ...)` 派生；`app.ts:1666` 缺省启用（fail-closed） |
| 输出守卫 | **真实且唯一权威** | `services/api/src/conversations/guard.ts:250` `createAnswerGuard`，`:253` `check({ candidate, set, question, conditions })`；装配入口 `service.ts:1191`（原记 :1107） `createConversationGuard`（`app.ts:1568` 用它）。引用逐字段双相等、用量卡只走 `doseCardDescriptor`|

### 3.2 唯一断点：生成侧「没有模型」

派单里点名要核的三处，逐条回答：

**①「`service.ts:82` 的 `unimplemented:no-real-` 前缀具体指什么」**

`:81-84` 是注释块，**真正的常量在 `:85-86`**：

```ts
// services/api/src/conversations/service.ts:85-86
export const ANSWER_MODEL_VERSION = `${UNIMPLEMENTED_VERSION_PREFIX}model/text-qa-deterministic`;
export const ANSWER_PROMPT_VERSION = `${UNIMPLEMENTED_VERSION_PREFIX}prompt/citation-guard-only`;
```

前缀本身定义在 `services/api/src/conversations/types.ts:52`：

```ts
export const UNIMPLEMENTED_VERSION_PREFIX = 'unimplemented:no-real-';
```

三个版本串的**唯一落库点**是 `service.ts:926-951` 的 `answerRowOf`，`:946-948` 写死：

```ts
model_version: ANSWER_MODEL_VERSION,
prompt_version: ANSWER_PROMPT_VERSION,
rule_version: answerRuleVersion(doseRuleVersionOf(guard.dose)),   // service.ts:93-95，同样带前缀
```

也就是说：**这不是「模型调用失败」的标记，而是「本域从未有过模型」的显式声明**。它同时是机器可判据的红线 —— `tests/unit/conversation-answer-guard.test.mjs` 的 NC2 断言「替身自称真实模型 ⇒ 落库与读面仍必须是 `unimplemented:no-real-*`」，`versionProblems(answer)` 对三个串逐一要求 `value.startsWith(UNIMPLEMENTED_VERSION_PREFIX)`。

真正「生成回答」的那一步是 `service.ts:1041-1046`：

```ts
const candidate = composer.compose({
  question: claimed.input_text,
  conditions,
  set: safeSet,
  history: priorContext.turns,
});
```

而 `composer` 的实现是 `service.ts:243-279` 的 `createDeterministicAnswerComposer()`：`kind: 'deterministic_guard_only'`（`service.ts:245`），只按 `RELEVANCE_RULE = 'cjk-bigram+word-match/1'`（`service.ts:202`）做**字面重合**筛选，把命中条目的标题+摘录拼成骨架（`COMPOSER_MAX_CITATIONS = 3` 在 `:227`，`COMPOSER_EXCERPT_MAX = 400` 在 `:230`），正文里自带「（未接真实模型·确定性检索结果·规则 …）」字样，`dose_cards: []` 恒空。

**②「`retrieval.ts` 的检索源是 stub 还是 real」**

**real（接真 PG 读面），但有运行条件**。`services/api/src/conversations/retrieval.ts:261` 的 `createKnowledgeRetrievalPort({ face: KnowledgeReadFace })` 读的是 `app.ts:1346-1350` 那个与 `/knowledge` **同一个实例**的 `knowledgeQueryFace`（`RETRIEVAL_LIMIT = 50` 在 `retrieval.ts:60`）。缺 `DATABASE_URL` 时（`pool === null`）装配退成 `guard.ts:78-89` 的 `createUnwiredRetrievalPort`，此时 `read()` 恒返回 `null`，服务层如实判 `insufficient`，**不编造引用**。这属于「缺运行条件」，不是「检索源是假数据」。

**③「`screen.ts` 的安全检查是 stub 还是 real」**

**real**。`screen.ts:170`（原记 :152） 的 `createModerationRiskScreen` 调 `packages/moderation` 的真规则层（`RISK_SCREEN_CATEGORIES = ['dangerous_usage','prompt_injection']` 在 `screen.ts:34`，`RISK_BLOCK_TEXT` 在 `:49`，规则版本由 `:126` 派生），筛查发生在 `service.ts:1027-1031`（生成与守卫**之前**），污染条目从本次检索集合剔除后才有 `safeSet`。未被授权的模型输出**不可能**绕过它，因为筛查在候选产生之前。

**小结**：断链只有一处 —— **「谁产生候选正文」**。检索、筛查、守卫、存储、级联、幂等台账、注销清理都在位。

### 3.3 `store-pg.ts` 是否已合入 + 迁移号

| 项 | 事实 |
| --- | --- |
| 对话持久化 store | **已合入**：`services/api/src/conversations/store-pg.ts:181` `createPostgresConversationStore(`，`:215` `persistent: true` |
| 迁移文件 | `services/api/db/migrations/0013_conversations.sql`（commit `cf2f5ed`，PR #214） |
| 建了哪些表 | `conversations`、`conversation_turns`、`conversation_answers`；`conversation_turns.conversation_id → conversations(id) ON DELETE CASCADE`、`conversation_answers.turn_id → conversation_turns(id) ON DELETE CASCADE` |
| 关键约束 | `revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)`；`citations` 有 `jsonb_array_length(citations) <= 20`；`dose_cards <= 10`；`status IN ('answered','insufficient','blocked')`；`check_state IN ('passed','blocked')` |
| 迁移总数 / 最大号 | **26** 个，最大 `0026_speech_persistence.sql`（所以「0027」这个号在本片没有用途——除非将来为 LLM 外发账本新建表，见 §6 R-3） |
| 装配是否真用 PG | 是：`app.ts:1507-1511`，且 `app.ts:1549` 拒绝任何非 `persistent` store 在 real 下接手 |

---

## 4. 真实 LLM 接入的既有约定：三个样板，选最像的那个

本仓接真实提供者已经形成固定形态，**每域一个 `provider.ts`**：`services/api/src/ocr/provider.ts`、`services/api/src/recognitions/provider.ts`、`services/api/src/speech/provider.ts`。三个都不适合直接抄，原因如下表；**最像的样板是第 4 行**。

| # | 样板 | 形态 | 对问答域的适用性 |
| --- | --- | --- | --- |
| 1 | `services/api/src/ocr/provider.ts` | `PROVIDER_FAILURE_CODES`（`:21-27`）+ `OcrProvider{executionMode,modelVersion,available,unavailableReason,extract()}`（`:35-44`）+ `createRealOcrProvider`（`:168-182`，缺凭据 `available=false`、`extract()` 恒 `PROVIDER_UNAVAILABLE`）+ `createOcrProvider`（`:185-194` 按模式选） | **抄骨架（fail-closed 的形状）**，但它的真实分支是空壳：本片只需要它的「缺凭据一律不可用、绝不回退替身」这条纪律 |
| 2 | 受理前 fail-closed 动作 | `services/api/src/ocr/service.ts:459-463`：`if (!provider.available) throw new ApiError('PROVIDER_UNAVAILABLE', provider.unavailableReason ?? '…', { retryable: false })` | **必抄**：问答域对应位置是 `createTurn` 受理口（202 之前），不是异步执行体内 |
| 3 | `services/api/src/recognitions/provider.ts` + `services/api/src/privacy/task-egress.ts` | 域 provider + 外发包装器（`task-egress.ts:57-64` `createMediaJobEgress`，`:45` `provider<T>(inner, method: 'recognize' \| 'transcribe')`） | **抄外发合规链**，但 `method` 联合目前**不含** `answer`/`compose`（`task-egress.ts:45`），必须扩（§5.6） |
| 4 | **`services/api/src/tts/live-ports.ts`（最像）** | 240 行「注入式真实适配器」：`LiveCallGate{reserve,settle}`（`:90-98`，reserve-then-send）+ `LIVE_GATE_REFUSALS`（`:33-43`）+ `LIVE_GATE_ERROR_CODES`（`:107-112`）+ `LIVE_OBSERVATION_ERROR_CODES`（`:119`）+ `RealTtsPorts`（`:189-208`，字段**全必填、无默认值**） | **主样板**：它解决的正是问答域要解决的问题 —— 「真实发送能力如何在不污染应用装配路径的前提下存在」 |
| 5 | `tools/ai-config.mjs` allowlist | `:10` `llm: { endpoint:'https://api.deepseek.com/chat/completions', auth:'Bearer', model:'deepseek-flash', keyEnv:'DEEPSEEK_API_KEY' }`；`configurationIssues` 对 llm 要求 `model` 精确相等、`apiKeyEnv==='DEEPSEEK_API_KEY'`、`maxOutputTokens===128 && stream===false`、`thinking==='disabled'`、`timeoutMs∈[1000,20000]`、`maxRetries===0`、`maxVerificationCalls===2`、`env==='dev'`、`privacy.allowUserDataForTraining===false && privacy.sendRealUserDataBeforeConsent===false` | **配置快照的唯一合法来源**：`live-ports.ts:153-157` 的注释规定，真实适配器的 profile 必须先过 `configurationIssues(config,'llm')` 零 issue。但该 allowlist 目前只服务 `tools/`，**应用侧引用它需要监工裁决**（§6 R-1） |

**为什么 `live-ports.ts` 是最像的**（它的设计纪律值得逐条搬到问答域）：

- `live-ports.ts:11-16` 的机制说明：真实调用所需的**全部向外能力**（预算闸门、显式授权令牌、被校验配置快照、凭据、`fetchImpl`、时钟、观测回调）收进 `RealTtsPorts`，**应用装配路径（`createTtsProvider` / `createRealTtsProvider`）没有注入端口的位置** ⇒ `executionMode:'real'` 的行为逐字节不变（fail-closed）；只有 `createLiveTtsProvider(ports)` 能触达真实发送，而它由独立手工验证工具构造。「默认关闭」不是容易忘的开关，而是**类型上没有默认实现**（`ports` 无默认值、缺任一字段即构造失败）。
- `live-ports.ts:153-157`：profile 的 endpoint **只能**取 `AI_ENDPOINTS['tts'].endpoint`（不能由调用方随便传 URL）。
- `live-ports.ts:159-175`：`timeoutMs ∈ [1000,20000]`、`maxRetries` 必须 **0**（禁自动重发）。
- `live-ports.ts:100-106` 的拒绝映射闭集：`AUTHORIZATION_REQUIRED`/`LEDGER_UNAVAILABLE` ⇒ 503 `PROVIDER_UNAVAILABLE`；`BUDGET_OR_COUNT_EXCEEDED` ⇒ 429 `PROVIDER_QUOTA_EXCEEDED`；`ATTEMPT_ALREADY_RESERVED` ⇒ 503 `PROVIDER_OUTCOME_UNKNOWN`（**绝不自动重发**）。

---

## 5. 接线方案（A 的交付主体）

> 全部为**方案**，本轮不落码。下列文件:行号是按当前基线给出的**插入/改动位置**。

### 5.1 新增 `services/api/src/conversations/provider.ts`（形态抄 `ocr/provider.ts`）

```ts
// 新增文件
export interface AnswerModelProvider {
  readonly executionMode: ExecutionMode;
  readonly modelVersion: string;            // 写进 Answer.model_version
  readonly promptVersion: string;           // 写进 Answer.prompt_version
  readonly available: boolean;
  readonly unavailableReason: string | null;
  compose(input: { question: string; conditions: Conditions | null;
                   set: RetrievalSetLike; history: readonly ContextTurn[] }):
    Promise<{ kind: 'completed'; text: string; citations: readonly SourceRef[] }
           | { kind: 'failed'; code: ProviderFailureCode }>;
}
export function createDeterministicAnswerProvider(...): AnswerModelProvider;  // 包装现有 composer，modelVersion 保持带前缀
export function createRealAnswerProvider(credentials): AnswerModelProvider;   // 缺凭据 ⇒ available=false；有凭据 ⇒ 真实适配器（必须经 §5.2 的 ports）
export function createAnswerProvider({ executionMode, ... }): AnswerModelProvider;
```

要点：
- `createRealAnswerProvider` 的 `available` 只由凭据齐备决定，`compose()` 在无**已审真实适配器**时返回 `{ kind:'failed', code:'PROVIDER_UNAVAILABLE' }` —— 与 `ocr/provider.ts:168-182` 逐条同形，**不回退替身**。
- 提供者**不得**决定 `status` / `check_state` / 用量卡：那是 `guard.ts` 的唯一职权（对照 `ocr/provider.ts:13-15` 的边界声明）。

### 5.2 新增 `services/api/src/conversations/live-ports.ts`（形态抄 `tts/live-ports.ts`）

- `LiveCapability` 增加 `'llm'`（当前 `tts/live-ports.ts:23` 只有 `'tts' | 'ocr' | 'asr'`；问答域**不要**改 tts 那个文件，按「零共享文件」纪律在本域新建同名概念的端口）。
- `RealAnswerPorts` 字段**全必填**：`liveGate`、`authorization`、`profile`、`credentials`、`fetchImpl?`、`now?`、`onObservation?`。
- `AnswerProfile` 只允许：`endpoint === AI_ENDPOINTS['llm'].endpoint`、`model === 'deepseek-flash'`、`timeoutMs ∈ [1000,20000]`、`maxRetries === 0`、`stream === false`、`thinking === 'disabled'`、`maxOutputTokens === 128`。
- 拒绝映射闭集照 `live-ports.ts:107-112`：`AUTHORIZATION_REQUIRED`/`LEDGER_UNAVAILABLE` ⇒ `PROVIDER_UNAVAILABLE`；`BUDGET_OR_COUNT_EXCEEDED` ⇒ `PROVIDER_QUOTA_EXCEEDED`；`ATTEMPT_ALREADY_RESERVED` ⇒ `PROVIDER_OUTCOME_UNKNOWN`；超时 ⇒ `PROVIDER_TIMEOUT`。

### 5.3 扩 `AnswerComposer.kind`（必须动的类型改动）

`services/api/src/conversations/service.ts:173-188` 的 `kind` 是**单值字面量** `'deterministic_guard_only'`（`:175`），这是接 real 模型唯一必须改的类型边界：

```ts
export interface AnswerComposer {
  readonly kind: 'deterministic_guard_only' | 'model_backed';   // :175
  readonly note: string;
  compose(...): ComposedCandidate | Promise<ComposedCandidate>; // 见下
}
```

**注意 `compose` 的返回值**：目前是同步的（`service.ts:247` 的实现、`:1041` 的调用点都没有 `await`）。接真实模型后必须是异步 ⇒ `service.ts:1041` 要改成 `const candidate = await composer.compose({...})`。这一行是唯一需要动的执行链语句，`guard.check`（`:1047-1052`）与 `settleAnswer`（`:1053`）不动。

### 5.4 版本串策略（fail-closed 的关键，必须由监工确认）

现状是「三个串恒带前缀」。接真模型后必须**分叉**，且分叉必须是**机器可判据**的：

| 情形 | `model_version` | `prompt_version` | `rule_version` |
| --- | --- | --- | --- |
| 确定性回答器（现状，所有非 real 模式 + real 无提供者） | `unimplemented:no-real-model/text-qa-deterministic`（`service.ts:85`） | `unimplemented:no-real-prompt/citation-guard-only`（`service.ts:86`） | `unimplemented:no-real-rule/...`（`service.ts:93-95`） |
| 真实模型成功产出候选 | `<provider.modelVersion>`（**不得**带 `unimplemented:no-real-` 前缀，也不得带任何 `stub`/`preset-demo` 字样） | `<provider.promptVersion>` | 仍取 `answerRuleVersion(doseRuleVersionOf(guard.dose))`，但前缀问题需裁决（§6 R-2） |
| 真实模型失败 | 该轮落 `failed`/`timed_out`（`service.ts:1054-1066`），**不产出 Answer 行** | — | — |

`answerRowOf`（`service.ts:926-951`）必须改成从 candidate/provider 取版本串，不能继续读模块级常量。**这条改动会直接触碰 `tests/unit/conversation-answer-guard.test.mjs` 的 NC2 判据**（见 §5.8）。

### 5.5 `app.ts` 装配（唯一装配点，`services/api/src/app.ts`）

| 位置 | 改动 |
| --- | --- |
| `app.ts:2102` | `const conversationComposer = conversationInjection?.composer ?? createDeterministicAnswerComposer();` ⇒ 改为按 `config.executionMode` 解析 provider；**注入缝保留**（测试仍可注入确定性 composer） |
| `app.ts` 新增 provider 解析 | 抄 `app.ts:944-950` 的形态（`process.env['ANSWER_PROVIDER_URL'] ?? null` / `ANSWER_PROVIDER_KEY`），但**必须**同时满足 §6 R-1 的裁决（是否允许应用侧直接读 LLM allowlist） |
| `app.ts:1545-1550` | 该处的 fail-closed 表达式**不改**：real 无持久 store ⇒ 整域 `null` |
| `app.ts` 末尾 import 区 | 新 import **必须追加在最后一行**：`app.ts` 行号是台账锚点，只能整体后移，不能中间插入（`tests/unit/recognitions-store-pg-wiring.test.mjs:117` 的注释明确过这一点） |

受理前 fail-closed（照 `ocr/service.ts:459-463`）：在 `createTurn` 的 202 之前加

```ts
if (!answerProvider.available) {
  throw new ApiError('PROVIDER_UNAVAILABLE', answerProvider.unavailableReason ?? '回答生成提供者不可用', { retryable: false });
}
```

**注意**：加在受理口会让**所有** real 模式请求在缺凭据时 503 —— 这正是 fail-closed 要的效果，但需要监工确认是否愿意在「确定性回答器仍可用」的过渡期接受这个语义跃变（§6 R-2）。

### 5.6 外发 / 同意闸（不接这一步，真实模型调用就是违规外发）

真实 LLM 调用 = `purpose: 'external_inference'`（`privacy/task-egress.ts:66`、`synthesis-egress.ts:122` 的缺省值即此）。现状缺口：

1. `services/api/src/privacy/task-egress.ts:45` 的 `provider<T>(inner, method: 'recognize' | 'transcribe')` **method 联合不含 `answer`/`compose`** ⇒ 必须扩联合，并在 `apps` 侧装配处（`app.ts:955-957` 是识别域的先例）把问答 provider 包一层。
2. `services/api/src/privacy/grant-pg.ts:68` 的接收方 capability 闭集**已含 `'llm'`**（`['weed','ocr','asr','tts','llm','moderation']`），`grant-pg.ts:60` 要求 `external_inference` 必须有已核验接收方（否则 `CONSENT_REQUIRED`）⇒ 数据模型侧不需要新迁移，但**运维侧必须登记一个 `capability='llm'` 的接收方**。
3. `task-egress.ts:84-108` 的 `reserveForAcceptance` 在 `!providerAvailable` 时**在任何账本变更之前**抛 `PROVIDER_UNAVAILABLE`（`retryable:false`）⇒ 这条现成的顺序（reserve → assertExecutable → markSent → 调用 → saveResult）问答域必须照抄，不能「先发了再记」。

### 5.7 需要的 env

| 变量 | 现状 | 用途 | 备注 |
| --- | --- | --- | --- |
| `APP_EXECUTION_MODE` | 已存在，**必填**（`config.ts:158-168`，取值 `real`/`stub`/`preset_demo`） | 决定是否走真实提供者 | 缺省报配置错误，不静默取 `stub` |
| `DATABASE_URL` | 已存在（`config.ts:70`、`:220-228`，带 `isPostgresUrl` 校验） | real 下 PG store + 知识读面；缺则整域 `null` | 问答域要「真链路可用」**必须**有它 |
| `ANSWER_PROVIDER_URL` | **不存在**（新） | 真实回答提供者 endpoint | 命名照 `RECOGNITION_PROVIDER_URL`（`app.ts:969`）；**是否允许任意 URL 需 §6 R-1 裁决** |
| `ANSWER_PROVIDER_KEY` | **不存在**（新） | 真实回答提供者凭据 | 照 `app.ts:952`；凭据只在内存、不落日志 |
| `DEEPSEEK_API_KEY` | 存在于 `tools/ai-config.mjs` 的 `ENV_FIELDS`，**应用侧不读** | 若允许复用 allowlist 端点，则用它 | 关键裁决点：应用消费者能否读它（§6 R-1） |
| `APP_KNOWLEDGE_UNVERIFIED_SEED` | 已存在（`app.ts:1672`，real 下**强制关闭**） | 浙江首批未核验投影开关 | 与本片无关但会被检索集合影响：real 下它恒关 ⇒ 集合只含 `review_status=verified` 条目 |

### 5.8 需要的测试改造

| 文件 | 现状 | 需要加/改什么 |
| --- | --- | --- |
| `tests/unit/conversation-answer-guard.test.mjs` | **NC2 断言「替身自称真实模型 ⇒ 仍必须 `unimplemented:no-real-*`」**（`versionProblems` 逐串 `startsWith`） | 新增三条：① real + 无凭据 ⇒ 受理前 503 `PROVIDER_UNAVAILABLE`、**零写入**；② real + 有凭据但适配器未审 ⇒ 轮次 `failed` + `PROVIDER_UNAVAILABLE`，**不落 Answer 行**；③ 唯一允许「无前缀版本串」的分支是**真实成功**，且该分支必须能证明来源 |
| `tests/unit/conversation-http.test.mjs` | 覆盖 7 条 op 的 HTTP 面 | 加 real 模式的 fail-closed 用例（503 而不是 202） |
| `tests/unit/conversation-failure-visibility.test.mjs` | 已有失败可见性 | 加「提供者失败不写 `succeeded`」用例（对照 `service.ts:1054-1066`） |
| `tests/unit/conversation-retrieval-validity.test.mjs` | 已有集合外引用必须 `blocked` | 加「模型候选引用集合外条目 ⇒ 仍 `blocked`」：证明接了模型**也不放宽**守卫 |
| `tests/unit/conversation-store-pg.test.mjs` | 夹具里版本串写死 `unimplemented:no-real-*`（`:83-85`、`:270-271`、`:289-290`） | 若 `answerRowOf` 改为从 provider 取版本串，需补一组合法「真实」版本串样本**且**明确它不是默认值 |
| `tests/integration/conversations-pg.mjs` | 存在（根 `test:integration:conversations-pg`） | real 真库链路的 fail-closed 断言；真调用**不在 CI 跑**（无凭据） |
| `tests/unit/contract-status-anchors.test.mjs` | 校验台账 path+lines 锚点 | 若 §5.5 让 `app.ts` 行号整体后移，**必须**同步台账行号，否则此测试及 `tools/verify-contract-status.mjs` 会红 |

### 5.9 本轮明确**不做**的事（红线映射）

- 不改 `apps/**`、`miniprogram/**`、根 `README.md`、`.github/workflows/**`、`docs/requirements.md`（派单红线）。
- 不新增任何 npm 依赖（真实 LLM 走 `fetchImpl` 注入，`live-ports.ts` 的先例即是零依赖）。
- 不改 `packages/contracts/openapi.json`（只读）。
- 不把任何 `partial` 改成 `implemented`（升级权限在监工）；本轮台账**一行未动**。
- 不让 real 模式在缺凭据/缺持久 store 时产生「成功」：`app.ts:1549` 的表达式与 `ocr/service.ts:459-463` 的 `retryable:false` 语义都不放宽。

---

## 6. 未决问题（需监工裁决，写手不自裁）

| ID | 问题 | 为什么必须裁决 | 建议 |
| --- | --- | --- | --- |
| **R-1** | 应用侧（`services/api/src`）是否允许直接消费 `tools/ai-config.mjs` 的 `llm` allowlist / `DEEPSEEK_API_KEY`？ | 目前该 allowlist 的定位是「手工验证工具专用」，`verify-llm-live.mjs:1` 逐字写明 never used by application consumers；`live-ports.ts:156` 只是**注释**里提它，代码不 import。跨这条线是**合规决定**，不是实现细节 | 两条路：① 保持隔离，应用侧只认 `ANSWER_PROVIDER_*` 独立凭据；② 正式把 allowlist 升格为应用配置源，需同步改 `docs/verification/provider-adapter-live-wiring.md` 的口径段 |
| **R-2** | 接真模型后 `rule_version` 是否仍带 `unimplemented:no-real-` 前缀？ | `service.ts:93-95` 把「规则版本」和「无模型」绑在同一个前缀上。真模型接入后这个绑定失去意义，但改它会让 NC2 判据失效 —— 而 NC2 是当前唯一能防「假装 real 已通过」的机器闸门 | 建议保留前缀语义不动，另加一个正交字段/独立串（`rule_version` 只描述 GY-I08 规则版本），NC2 改判 `model_version`/`prompt_version` 两串；具体口径请监工定 |
| **R-3** | 真实 LLM 的外发账本落在哪？ | `exports` 表已有 `purpose='external_inference'` 分支（`privacy/ledger-pg.ts:322`、`:430`、`:509`），capability 闭集已含 `'llm'` ⇒ **不需要新迁移**；但如果需要独立的调用配额/计费表，就要 0027 | 建议复用现有 `exports` 账本，**不新增迁移** |
| **R-4** | 受理口 fail-closed 的时机 | 若把 `!provider.available` 的 503 加在 `createTurn` 受理口（照 `ocr/service.ts:459-463`），real 模式下「确定性回答器还不能用」的过渡期会让**所有**提问 503 | 建议加在受理口（这是唯一不说谎的位置）；若要过渡期可用，须显式引入「确定性回答器仍算合法回答」的配置开关，且版本串继续带前缀 |
| **R-5** | 上下文（`context.ts:29` `CONTEXT_MAX_TURNS = 5`）能否进 prompt？ | `service.ts:183-185` 明确「回答器只可用它如实标注这是追问，**不得**用它扩大引用集合」。真实模型会把 `history` 拼进 prompt ⇒ 用户上文的**真实内容**会外发，涉及 `external_inference` 同意范围与最小化原则 | 建议外发前对 `history` 做与 `question` 同级的风险筛查，或以「不带 history」为默认 |

---

## 7. 附录 A：精确锚点清单（基线 `f7155d5`）

```
services/api/src/conversations/service.ts:85-86    ANSWER_MODEL_VERSION / ANSWER_PROMPT_VERSION（带前缀）
services/api/src/conversations/service.ts:93-95    answerRuleVersion（同前缀）
services/api/src/conversations/service.ts:173-188  interface AnswerComposer（kind 单值字面量在 :175）
services/api/src/conversations/service.ts:202      RELEVANCE_RULE = 'cjk-bigram+word-match/1'
services/api/src/conversations/service.ts:227      COMPOSER_MAX_CITATIONS = 3
services/api/src/conversations/service.ts:243-279  createDeterministicAnswerComposer
services/api/src/conversations/service.ts:926-951  answerRowOf（唯一构造回答行；:946-948 写死三串）
services/api/src/conversations/service.ts:1017-1022 retrieval.read
services/api/src/conversations/service.ts:1027-1031 riskScreen.screenSources（生成与守卫之前）
services/api/src/conversations/service.ts:1035-1039 context.read
services/api/src/conversations/service.ts:1041-1046 composer.compose（唯一插入点）
services/api/src/conversations/service.ts:1047-1052 guard.check
services/api/src/conversations/service.ts:1054-1066 catch ⇒ failed / timed_out（绝不 succeeded）
services/api/src/conversations/service.ts:1191    createConversationGuard（包装 createAnswerGuard；原记 :1107）
services/api/src/conversations/types.ts:52         UNIMPLEMENTED_VERSION_PREFIX = 'unimplemented:no-real-'
services/api/src/conversations/guard.ts:64-76      interface RetrievalPort
services/api/src/conversations/guard.ts:78-89      createUnwiredRetrievalPort
services/api/src/conversations/guard.ts:91-106     createWiredRetrievalPort
services/api/src/conversations/guard.ts:250        createAnswerGuard
services/api/src/conversations/guard.ts:253        check({candidate,set,question,conditions})
services/api/src/conversations/retrieval.ts:55     KnowledgeReadFace
services/api/src/conversations/retrieval.ts:60     RETRIEVAL_LIMIT = 50
services/api/src/conversations/retrieval.ts:261    createKnowledgeRetrievalPort
services/api/src/conversations/screen.ts:34        RISK_SCREEN_CATEGORIES
services/api/src/conversations/screen.ts:49        RISK_BLOCK_TEXT
services/api/src/conversations/screen.ts:126       RISK_RULE_VERSION
services/api/src/conversations/screen.ts:152       createModerationRiskScreen
services/api/src/conversations/store-pg.ts:181     createPostgresConversationStore
services/api/src/conversations/store-pg.ts:215     persistent: true
services/api/src/conversations/store.ts:90         interface ConversationStore
services/api/src/conversations/store.ts:185        createMemoryConversationStore（:184 persistent:false；原记 :156 / :174）
services/api/src/conversations/context.ts:29       CONTEXT_MAX_TURNS = 5
services/api/src/app.ts:944-950                    createRecognitionProvider（env 取法样板；:948/:949 是 env）
services/api/src/app.ts:1346-1350                  knowledgeQueryFace（与 /knowledge 同一实例）
services/api/src/app.ts:1507-1511                  conversationStore 解析（real ⇒ PG）
services/api/src/app.ts:1522-1528                  conversationRetrieval 解析（wired / unwired）
services/api/src/app.ts:1531                       conversationDose
services/api/src/app.ts:1568                       conversationGuard
services/api/src/app.ts:2102                       conversationComposer（接线改动点）
services/api/src/app.ts:1666                       conversationRiskScreen
services/api/src/app.ts:1545-1550                  real 下非持久 store ⇒ 整域 null（fail-closed）
services/api/src/config.ts:158-168                 APP_EXECUTION_MODE 必填
services/api/src/config.ts:220-228                 DATABASE_URL
services/api/src/ocr/provider.ts:21-27             PROVIDER_FAILURE_CODES
services/api/src/ocr/provider.ts:168-182           createRealOcrProvider（fail-closed 骨架）
services/api/src/ocr/provider.ts:185-194           createOcrProvider（按模式选）
services/api/src/ocr/service.ts:459-463            受理前 fail-closed（retryable:false）
services/api/src/tts/live-ports.ts:11-16           设计纪律：装配路径无注入端口 ⇒ real 行为不变
services/api/src/tts/live-ports.ts:90-98           LiveCallGate（reserve-then-send）
services/api/src/tts/live-ports.ts:100-112         闸门拒绝 → 契约码映射闭集
services/api/src/tts/live-ports.ts:119             LIVE_OBSERVATION_ERROR_CODES
services/api/src/tts/live-ports.ts:153-175         profile 校验（endpoint/timeout/retries）
services/api/src/tts/live-ports.ts:189-208         RealTtsPorts（全必填）
services/api/src/privacy/task-egress.ts:45         provider<T>(inner, method) —— 联合需扩
services/api/src/privacy/task-egress.ts:57-64      createMediaJobEgress
services/api/src/privacy/task-egress.ts:84-108     reserveForAcceptance（账本变更前 fail-closed）
services/api/src/privacy/grant-pg.ts:60            external_inference 需已核验接收方
services/api/src/privacy/grant-pg.ts:68            接收方 capability 闭集（含 'llm'）
tools/ai-config.mjs:10                             llm allowlist（endpoint/model/keyEnv）
tools/verify-llm-live.mjs:1                        "never used by application consumers"
services/api/db/migrations/0013_conversations.sql  三表 + 级联 + maxItems 约束
```

## 8. 附录 B：派单 / README 与实测不一致处（**只记录，本轮不改**）

| 位置 | 表述 | 实测 |
| --- | --- | --- |
| 派单 / [根 README 历史快照（本页基点 f7155d5）](https://github.com/GengYunChuChao/GengYun/blob/f7155d5ac1329974b20a6128e332bb84c19c733d/README.md#L217) | `services/api/src/conversations/service.ts:82`、`:945` 是前缀标记处 | `:82` 与 `:945` 都是**注释行**；常量在 `:85-86`、落库在 `:946-948` |
| [根 README 历史快照（本页基点 f7155d5）](https://github.com/GengYunChuChao/GengYun/blob/f7155d5ac1329974b20a6128e332bb84c19c733d/README.md#L238) | 「main 现有 24 个迁移、最大号 `0024_ocr_persistence.sql`」 | 实测 **26** 个、最大 `0026_speech_persistence.sql` |
| 派单自检项 | `npm run test:unit --workspace @gengyun/api` | `@gengyun/api` 的 scripts 只有 `dev/start/build/typecheck/db:migrate/db:status`，**没有 test 脚本**；根 `package.json` 也无 `test`。实际入口是根 `npm run test:unit` |
| 派单自检项 | 「若加了 migration：`tests/migrations/` 下相关守卫通过」 | 本仓**没有** `tests/migrations/` 目录；迁移相关守卫在 `tests/unit/*-store-pg*.test.mjs` 与 `tests/integration/*.mjs` |

以上四处均为**文档/派单口径偏差**，其中两处在根 `README.md`（派单红线，本代理无权修改）。

## 9. 本轮自检结果（如实记录，含未跑通项）

本轮改动**只有本文件一个新增 markdown**（`git status --porcelain` 仅一行 `?? docs/verification/gy-i12-conversations-gap-20261021.md`），`HEAD = f7155d5`，无任何源码/台账/契约改动。

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `tsc -p services/api/tsconfig.json --noEmit` | **exit 0** | 等价于 `npm run lint` 里的 api 类型检查项 |
| `tsc -p apps/admin/tsconfig.json --noEmit` | **exit 0** | 等价于 admin 类型检查项 |
| `tsc -p services/api/tsconfig.json`（build） | **exit 0** | 产物在 `dist/`（`.gitignore:22`） |
| `tsc -p apps/admin/tsconfig.json`（build） | **exit 0** | 无新文件落进版本控制 |
| `npm run lint` 的卫生扫描项 | **PASS** | 「仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）」 |
| `npm run lint`（整体） | **本机跑不通（非代码问题）** | 该脚本用 `spawnSync(..., {encoding:'utf8'})` 捕获 `tsc` 输出；本会话沙箱禁止 piped stdio 的子进程（`spawnSync` 返回 `error.code === 'EPERM'`，`status === null`）⇒ 脚本误报「类型检查失败」。已改用直接执行 `tsc` 逐项复核（上表两行 exit 0） |
| `node --test "tests/unit/*.test.mjs"`（即 `npm run test:unit`） | **同上受限** | `node --test` 会为每个测试文件 spawn 子进程，同样撞 `EPERM`。改为**逐文件直接执行**（`node tests/unit/x.test.mjs`，同 `node:test` 内核、进程内运行） |
| 逐文件执行 247 个用例文件（`tests/unit` + `privacy` + `media` + `reference` + `moderation`） | **235 绿 / 12 红** | 12 个红文件与问答域无关：11 个因 `spawnSync` 被沙箱拒（`EPERM`）而失败，1 个（`miniprogram-transcript-confirm.test.mjs`，`TypeError: releaseGet is not a function`）是**该基线上已存在的失败**。**对照实验**：在未改动的同基线 worktree（`E:\GengYunCommander\wt-b1-flags` @ `f7155d5`）上重跑这 12 个文件，**失败集合与失败原因完全一致** ⇒ 与本轮改动无关 |
| 问答域 8 个用例文件 | **全绿（66 个 test）** | `conversation-answer-guard`(8) / `conversation-deletion`(5) / `conversation-failure-visibility`(7) / `conversation-followup-context`(9) / `conversation-http`(13) / `conversation-retrieval-validity`(7) / `conversation-risk-screen`(11) / `conversation-store-pg`(6) |
| `node tools/verify-contract-status.mjs` | **exit 0，全 PASS** | 「覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；…形状错误 0 项；语义错误 0 项」⇒ 台账未动、锚点自洽 |

**口径**：上述「绿」只证明**静态与离线口径**成立，**不**证明任何真实模型链路可用；real 模式的 fail-closed 语义本轮一字未改。
