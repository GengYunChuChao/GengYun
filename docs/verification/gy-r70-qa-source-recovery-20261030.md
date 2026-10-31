# GY-R70（#12 P1）· 文字问答 → 来源 → 失败恢复：取证与可执行钉子（2026-10-30）

> 一句话：**「来源」已经是硬判据并被钉成断言（Δ1）；「失败恢复」的四条腿各有明确错误码，
> 但作业封套不承载 `retryable`、隐私类失败码在异步面被折叠，且"完全没配模型"零信号（Δ2–Δ4）。**

本页只做两件事：把答问链路**从 HTTP 入口到回答落库**逐跳钉清；把三件"只能靠读代码相信"的
判断变成可执行断言（`tests/unit/conversation-qa-source-recovery.test.mjs`，23 条）。
**零产品代码改动**：`git diff --stat c609ce7f..HEAD` 只有 `tests/**` 与 `docs/**`（见 §9）。

---

## 1 基线与口径

| 项 | 值 |
| --- | --- |
| `upstream/main` | `c609ce7f2be6f5e0bfa3d30fd26ca95aa90067dd`（`git -C … rev-parse upstream/main` 与 `git log -1` 一致） |
| 工作树 | `E:\GengYunCommander\wt-r70-qa`，分支 `test/gy-r70-qa-source-recovery` |
| 依赖 | `npm ci --prefer-offline --no-audit --no-fund --ignore-scripts --cache …`（exit 0） |
| `TMP`/`TEMP` | 仓外 `E:\GengYunCommander\.pg17\tmp\gy-r70-qa` |
| 运行时 | Windows / node v24.16.0 / npm 11.13.0 |

**本片没有**：真实模型调用、真实资料库、真 PG、真实凭据。全部读数是合成夹具。

---

## 2 链路：HTTP 入口 → 回答落库（九跳）

| # | 跳 | 落点 | 做了什么 | 失败出口 |
| --- | --- | --- | --- | --- |
| 1 | 路由受理 | `services/api/src/routes/conversations.ts:161-172` | `POST /api/v1/conversations/{id}/turns` ⇒ `ready().createTurn(sessionOf(request), …)`；202 + 强 ETag | 服务层未接线 ⇒ 503 `PROVIDER_UNAVAILABLE`（`ready()` 内，`retryable:false`）；无 Bearer ⇒ 401 `SESSION_REQUIRED` |
| 2 | 会话捕获 | 同上（`sessionOf`） | 令牌与 `currentIdentity`（含 `sessionId`）在**受理时**捕获，随异步任务传下去 | 异步阶段**不重新鉴权、也不跳过鉴权**：读面拿不到令牌 ⇒ `SESSION_REQUIRED` ⇒ 轮次 `failed` |
| 3 | 服务层受理 | `services/api/src/conversations/service.ts:783-865` | 校验输入 → （语音）转写核对 → 幂等占位（202）→ 会话存在性/版本 → `insertTurn(job_state='queued', deadline=+30s)` → `scheduleAnswer` → 回 `Job{state:'queued', result:null}` | 404 `NOT_FOUND`（越权同形）/ 409 `REVISION_CONFLICT` / 428 `REVISION_REQUIRED` / 422 `INPUT_UNCERTAIN` / 409 `IDEMPOTENCY_CONFLICT` / 409 `REQUEST_IN_PROGRESS`(retryable) |
| 4 | 截止时间 | `services/api/src/conversations/service.ts:1003-1156`（`scheduleAnswer`） | `claimTurnJob`（只从 `queued` 起，重复受理 no-op）；`now > job_deadline_at` ⇒ 直接结算 | `timed_out` + `PROVIDER_TIMEOUT` |
| 5 | 问题侧筛查 | 同上 | `riskScreen.screenQuestion`：命中/无法判定 ⇒ 整轮拒答（不检索、不生成、不进守卫） | 回答行 `status='blocked'` + `check_state='blocked'` + 固定话术（**不是**错误码） |
| 6 | 检索集合 | 同上 + `services/api/src/conversations/retrieval.ts:178-224` | 与 `/knowledge` **同一个**读面实例；条目来源**逐字段**校验；`validity≠valid` / `review_status='rejected'` 出集合 | 来源字段缺失/非 uuid/来源 id≠条目 id ⇒ 503 `PROVIDER_UNAVAILABLE`(retryable:false)；读面缺令牌 ⇒ `SESSION_REQUIRED` |
| 7 | 生成（唯一生成点） | `services/api/src/ai/chat-wiring.ts:52-98` 选路 ⇒ 确定性回答器 或 `services/api/src/ai/chat-live-adapter.ts` | 四与门（见 §2.1）决定谁生成；真实模型路径必须先过 `services/api/src/privacy/task-egress.ts:286-339` 的 `reserve → assertExecutable → markSent → 外发 → saveResult` | 见 §4 失败矩阵 |
| 8 | 输出守卫 | `services/api/src/conversations/guard.ts`（引用核对 `services/api/src/conversations/guard.ts:254-267`、正文链接复核 `services/api/src/conversations/guard.ts:323-346`） | 引用必须**逐字段等于**集合内那条来源；正文里的 `[n]`/URL 越界 ⇒ 整条阻断（不洗白） | `status='blocked'` + 固定话术（不是错误码）；`answered` 的空正文 ⇒ `PROVIDER_UNAVAILABLE`(retryable:false) |
| 9 | 落库 + 读面 | `services/api/src/conversations/service.ts:976-1001`（**唯一盖章点**）→ `services/api/src/jobs/routes.ts:51-62` | 版本串在此写进回答行；作业投影 `services/api/src/conversations/job.ts:48-62`，出口由 `services/api/src/jobs/registry.ts:177` 按九键重建 | 形状闸门不过 ⇒ 503 `PROVIDER_UNAVAILABLE`(retryable:false)，**不落库** |

结算口径（`services/api/src/conversations/service.ts:486-489`）：**只有 `ApiError`** 的 code 被原样透出，
域外异常一律折成 `PROVIDER_UNAVAILABLE`；随后 `state = code === 'PROVIDER_TIMEOUT' ? 'timed_out' : 'failed'`。
任何异常**绝不**落 `succeeded`，失败/超时一律零回答行（由既有 `conversation-failure-visibility` 钉住）。

### 2.1 四与门（顺序即优先级）

`services/api/src/ai/chat-wiring.ts:52-98`，纯函数、无 IO，装配点 `services/api/src/app.ts:2321-2336`：

1. **注入覆盖**（`injectedComposer`）⇒ `mode='injected'`，原样使用注入者、**不给**版本串；
2. **`chat === null`**（没配 `CHAT_LLM_*`）⇒ `deterministic`；
3. **账本或在途守卫缺一**（`egressLedger === null || privacyInFlight === null`）⇒ `deterministic` + **一条 warn**；
4. **`egress.engaged`**（仅 `executionMode === 'real'`）⇒ 否则 `deterministic`（**无** warn，演示模式不外发是正常结局）；
5. 四条全开 ⇒ `mode='live'`，`answerVersions = { model: 'model/<model>#live-1', prompt: 'prompt/citation-bind/1' }`。

配置侧：`CHAT_LLM_*` 三项**要么全配、要么全空**（`services/api/src/config.ts:478` 起的 `asChatProvider`）；
只配一半 ⇒ 启动 `ConfigError` + 进程 exit 1。⇒ **"静默降级"只在三项全空时发生**。

---

## 3 「来源」目前在响应里以什么形态出现

| 问 | 答（按代码） |
| --- | --- |
| 引用字段名 | `Answer.citations`（数组，`maxItems 20`），元素是契约 `SourceRef` **十键全必填**：`id` / `version` / `title` / `url` / `publisher` / `source_kind` / `evidence_kind` / `validity` / `review_status` / `updated_at`；`additionalProperties:false`。**没有**"单个来源 URL 字段"，指向只能通过这十键表达 |
| 指向什么 | 必须**逐字段等于本次检索集合里 `id` 相同那条条目自带的 `source` 对象**（`guard.ts` 的 `sameSourceRef`）；集合外 id、被改写任一字段、契约表达不了的来源（`http://`／枚举外）一律拒绝并 `blocked` |
| 集合从哪来 | 与 `/knowledge` **同一个** `createKnowledgeService` 实例（`app.ts` 装配），条目来源逐字段校验（`retrieval.ts` 的 `retrievalItemOf`），来源 id ≠ 条目 id 直接 503 |
| 正文里的编号 | 真实模型只能按送入的编号 `[n]` 指认来源（上限 6 条），适配器把 `[n]` 映射回 `set.items[n-1].source` **原对象**；正文里出现越界编号、未被集合背书的链接或未被集合背书的登记证号 ⇒ **整条正文不交付**（回空正文 + `text_violations` ⇒ 守卫阻断） |
| `citation-bind` 版本号从哪来 | `CHAT_PROMPT_VERSION = 'prompt/citation-bind/1'`（`services/api/src/ai/chat-live-adapter.ts:59-60`；同处的 `CHAT_MODEL_VERSION_PREFIX='model/'` 与 `chatModelVersion()` 在 `services/api/src/ai/chat-live-adapter.ts:68-70`）⇒ 装配层写进 `answerVersions.prompt`（`services/api/src/ai/chat-wiring.ts:94`）⇒ 落到 `Answer.prompt_version`（`services/api/src/conversations/service.ts:997`）。**只在 live 侧出现**；确定性侧的 `prompt_version` 是 `unimplemented:no-real-prompt/citation-guard-only`（`services/api/src/conversations/service.ts:91`） |
| 三个版本串的关系 | `model_version`/`prompt_version` 只在 live 结局换成装配层的串；`rule_version` **任何**结局都带 `unimplemented:no-real-`（它描述引用/用量判定规则，永不含模型成分） |

**结论**：引用不是空壳 —— 它没有"自由填一个 URL"的表达方式，只能指向本次检索集合里的实体条目。
本片把它钉成 C1/C2 三条，并用 C3 的三条负控制证明"改写一个字段 / 集合外 id / 纯 `https://` 空壳"
都进不了 `answered`。

---

## 4 「失败恢复」矩阵

**先给一条结构事实，否则"状态码"会被读错**：问答的失败**不经过 HTTP 错误封套**。受理是 202，
之后的失败写在作业上 —— `GET /jobs/{id}` 仍然 **200**，`state` + `error_code` 是全部可判据字段
（`result` 为 `null`）。所以"状态码"有两层：

- **作业面**：恒 **200**（`services/api/src/jobs/routes.ts:51-62`）。
- **该错误码自身的契约状态码**：只在该失败被**同步**抛出（例如整域未接线）时才会出现在响应状态行上。
  权威表是 `services/api/src/contract.ts` 的 `ERROR_STATUS_MAP`（本页数值由用例现读断言，不手抄）。

| # | 失败 | 适配器 `error.code` | `retryable` | 作业 `state` | 作业 `error_code` | 该码的契约状态码 | 客户端能否区分 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **超时**（`AbortError`/`ETIMEDOUT`/408） | `PROVIDER_TIMEOUT` | **true**（可能已在供应商侧计费） | `timed_out` | `PROVIDER_TIMEOUT` | 504 | **能**：`timed_out` 只对应这一条 |
| 2 | **配额/限流**（429） | `PROVIDER_QUOTA_EXCEEDED` | **true** | `failed` | `PROVIDER_QUOTA_EXCEEDED` | 429 | **能**：码原样透出，不折成"不可用" |
| 3 | **协议违规**（200 但空正文 / 非 JSON） | `PROVIDER_OUTCOME_UNKNOWN` | **false** | `failed` | `PROVIDER_OUTCOME_UNKNOWN` | 503 | **能** |
| 4a | **账本不可用（运行期）** | `PROVIDER_UNAVAILABLE` | **false** | `failed` | `PROVIDER_UNAVAILABLE` | 503 | **不能**：与"供应商挂了"同码（缺口 G3） |
| 4b | **账本/凭据不可用（装配期）** | —— **没有错误码** | —— | **`succeeded`** | **`null`** | —— | **只能看版本串前缀**（缺口 G1） |

补充口径（逐条按代码，不是按想像）：

- **超时不重试**：重试只在「供应商明确拒绝且未产出 token」（429 / 5xx）时发生；超时与传输中断
  可能已计费 ⇒ **不重试**。实测：`timeoutMs=20, maxRetries=2` 仍只发 **1** 次（断言 D1）。
- **配额可重试但只在适配器内**：重试次数由 `CHAT_LLM_MAX_RETRIES`（0–2，默认 1）决定；重试耗尽后的
  终态仍是 `failed` + `PROVIDER_QUOTA_EXCEEDED`（既有用例与 D2 都钉住）。
- **协议违规两形态同码**：`choices: []`（无可用正文）与"响应体不是 JSON"都归到 `bad_response`
  ⇒ `PROVIDER_OUTCOME_UNKNOWN`（不可重试）。另有一条"200 但正文含集合外编号/未检索链接"不走错误码，
  走**整条阻断**（`blocked`），语义不同不可混。
- **`retryable` 到不了客户端**：它只写在 `ApiError` 上（`services/api/src/ai/error-map.ts:115-120`），
  而作业封套是契约九键（`services/api/src/jobs/registry.ts:50-61`）、**没有**这个键。
  D6 直接断言 `hasOwnProperty('retryable') === false`，并把"客户端只有 `state` + `error_code`"写成事实。
- **401/403 映射**：`auth` 形态 ⇒ `PROVIDER_UNAVAILABLE` + `retryable:false`（本仓库侧凭据问题，
  不伪装成临时故障）；400/404/413/415/422 ⇒ `bad_request` ⇒ 同样 `PROVIDER_UNAVAILABLE` + false。
- **408** 单独映射成 `timeout`（而不是 `bad_request`），故它是"可重试"那一档。

---

## 5 客户端能否区分「模型答的」与「摘录答的」

**能 —— 在回答载荷上，有三条互相独立的判据**（C4 逐条断言，两条路互斥且穷尽）：

1. `model_version`：真实模型是 `model/<model>#live-1`；摘录是 `unimplemented:no-real-model/text-qa-deterministic`
   （`services/api/src/conversations/service.ts:90-91`）。
2. `prompt_version`：真实模型是 `prompt/citation-bind/1`；摘录侧**不含** `citation-bind`。
3. 正文首行：确定性回答器自带 `（未接真实模型·确定性检索结果·规则 …）` 字样 ——
   **即便客户端只渲染正文**，也不会把摘录读成模型输出。

**不能 —— 在运维面上**：`GET /health` 只查 `api` 与 `database`（`services/api/src/routes/health.ts:11-34`），
没有任何问答/AI 接线读数。"配了模型却接不上账本"有**一条 warn**；**"完全没配 `CHAT_LLM_*`"一条都没有**
（那条 warn 只在 `chat !== null` 且账本/在途守卫缺一时才产生）。⇒ 一个忘了配模型的 `real` 部署，
`/health` 报 `ok`、每次问答都静默走摘录、日志零告警。这是缺口 **G1**。

---

## 6 新增断言（23 条）与"怎么证明它们有牙齿"

文件：`tests/unit/conversation-qa-source-recovery.test.mjs`（全离线；`TMP` 仓外；无 `\\` 分隔符 hack、
无 `process.cwd()` 兜底、无 `process.platform` 分支、不依赖未清环境变量）。

| 组 | 条数 | 断言什么 |
| --- | --- | --- |
| A（版本串分区） | 2 | 四与门 **32 组全交叉**（注入 × 模型 × 账本 × 在途守卫 × 执行模式）逐组断言 `live ⇔ 四门全开`；两种禁止情形逐条判零 |
| B（落库面双射） | 6 | 确定性路径逐字节等于确定性回答器且零外呼；live 路径恰好外发一次；live+空集合只允许 `insufficient`；出处分类器三形态；注入缝的**已知欠报**单独立案；汇总台账 |
| C（来源不得为空壳） | 4 | 十键逐字段等于集合内来源、`[n]` 可回指；摘录侧同样非空壳；三条空壳负控制全阻断；摘录与真实在三处判据上都不同 |
| D（失败恢复矩阵） | 7 | `D0` 逐行按表断言 12 个 HTTP 状态与 8 个失败形态的 (code, retryable)；`D1`–`D4` 作业面四行；`D5` "无错误码"形状；`D6` 封套无 `retryable` |
| E（零外呼） | 4 | 无凭据 / 有模型无账本 / 适配器自身"无依据不外发"三条都是非回环外呼 **0**，外加一条**正控制**证明绊线会响 |

### 6.1 零外呼绊线的实现（与 `ai-live-provider-wiring` 同一手法，唯一差异写明理由）

`tests/unit/ai-live-provider-wiring.test.mjs` 的 `tripwireFetch` 是"一切外呼都抛"。本片要真起
**回环** HTTP 夹具（夹具自己的 `fetch` 也走 `globalThis.fetch`），所以绊线按"**只拦非回环**"实现：
放行 `127.0.0.1`/`localhost`/`[::1]`，其余一切计数并抛错。

一个必须写明的顺序硬要求：适配器在**构造期**捕获 `globalThis.fetch`
（`services/api/src/ai/chat-live-adapter.ts` 的 `const doFetch = deps.fetchImpl ?? globalThis.fetch`），
所以绊线要先装、再构造回答器。因此 E3/E4 用**不注入 `fetchImpl`** 的适配器（否则计数恒 0，
测不到"删掉无依据短路"这种改动 —— 这条是实测出来的：第一次写 E4 时它没有牙齿）。

### 6.2 负控制（五条，逐条实际打红、恢复后复绿）

| # | 改哪一行（临时，全部已 `git checkout` 还原） | 红在哪（逐字） | 恢复后 |
| --- | --- | --- | --- |
| ① | `ai/chat-wiring.ts` 的账本与门 `if (input.egressLedger === null \|\| …)` ⇒ `if (false)` | `A1`：`装配结局与四与门不一致：injected=false chat=true ledger=false inflight=false mode=real（实得 live）`；连带 `A2`、`B6`、`D5`、`E2` | 23/23 绿 |
| ② | `conversations/service.ts` 去掉确定性正文里的 `（未接真实模型·确定性检索结果·规则 …）` | `B1`、`B4`、`C4`、`D5` 红（`excerptMarker` 判据） | 23/23 绿 |
| ③ | `conversations/guard.ts` 跳过 `sameSourceRef` 逐字段核对 | `C3` 红（三条空壳来源全部被放行成 `answered`） | 23/23 绿 |
| ④ | `ai/error-map.ts` 把 `rate_limited` 的码改成 `PROVIDER_UNAVAILABLE` | `D0`（`HTTP 429 的契约码`）、`D2`、`D6` 红 | 23/23 绿 |
| ⑤ | `ai/chat-live-adapter.ts` 去掉"检索集合为空 ⇒ 不外发"短路 | `B3`（`检索集合为空时不得为了"问一句"而外发`）、`E4`（`无依据时不得花钱问模型"知不知道"`）红 | 23/23 绿 |

---

## 7 与既有用例的分工（不重复）

| 既有 | 已盖 | 本片补的 |
| --- | --- | --- |
| `tests/unit/conversation-chat-live.test.mjs` | 四与门**四头**（各自缺一）、适配器请求形状/引用回填/失败映射表/`reserve-then-send` 顺序、注入路径端到端 | 四与门的**全交叉闭式**（32 组，含 `privacyInFlight` 单独缺一）；版本串的**双方向**禁止情形；`citation-bind` 的归属；作业封套 `retryable` 缺位；"装配期账本不可用 ⇒ **无**错误码" |
| `tests/unit/conversation-failure-visibility.test.mjs` | 配额/超时/空正文在作业面的可见性（用**注入 throw 的替身**） | 用**真适配器**重跑（码来自 `error-map` 的翻译点而非用例自己 throw 的码）；补协议违规两形态与账本拒绝一行；补"无前缀"方向的出处判定 |
| `tests/unit/conversation-answer-guard.test.mjs` | NC1/NC2/NC3（集合外引用、替身不得自封真实模型、级联删除） | 不给守卫换替身，改为断言**生产守卫**下"空壳来源"三条负控制 |

---

## 8 九条门禁读数（+ CI-exact anchors + 额外两条，全部 exit 0）

| 门禁 | 读数 | exit |
| --- | --- | --- |
| `npm run test:unit` | **提交后**：`tests 5821 / pass 5817 / fail 0 / cancelled 0 / skipped 2 / todo 2`；**提交前**同一命令是 `tests 5821 / pass 5817 / fail 1 / skipped 1`，唯一红是 `doc-anchor-relocation-identity`（`base == HEAD` 没有判定面，它刻意自我保护，见 §8.1） | 0 |
| `npm run verify:anchors` | `verify-contract-status` PASS（覆盖 126 条契约操作；已装配 126；implemented 18 / partial 108 / planned 0；形状错误 0、语义错误 0；行号区间 313 条）；`verify-doc-anchors --strict` PASS（`BARE_ORPHAN` 本次命中 3479 条、基线外新增 **0**、陈旧 **0**；`ANCHOR-COUNT` 6221 条 / 223 份、下降 **0** 份、上升 8 份） | 0 |
| **CI-exact** `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | `SYMBOL-STRICT` 基线 31 条全命中、基线外新增 **0**；`ANCHOR-COUNT` 6475 条 / 233 份、下降 **0** 份、上升 11 份；`ANCHOR_DRIFT` 15 条全在基线内；`BARE-ORPHAN` 3543 条全在基线内（作用域外 134 条亦全在基线内）；`PASS: --strict 下没有基线之外的新增` | 0 |
| `npm run verify:parity` | `extra []` / `missing []` / `ledgerDrift []` | 0 |
| `npm run verify:capability-map` | `totalOps=46，有入口=46，无入口=0，死按钮=0` | 0 |
| `npm run test:docs` | 研究记录 `5 通过 / 0 失败 / 4 legacy 已钉住`；`docs/research` 结构校验 PASS | 0 |
| `npm run lint` | `tsc --noEmit` services/api PASS、apps/admin PASS；仓库卫生扫描 PASS | 0 |
| `npm run test:contract` | `tests 17 / pass 17 / fail 0` | 0 |
| `npm run build` | api + admin `built`；build 后已删除 `services/api/dist` 与 `apps/admin/dist` | 0 |
| `npm run test:failmatrix` | `矩阵合计 249 条：PASS 249 / FAIL 0` | 0 |
| 额外·`node --test tests/unit/conversation-qa-source-recovery.test.mjs` | `tests 23 / pass 23 / fail 0` | 0 |
| 额外·`node tools/verify-contract-status.mjs --reanchor`（dry-run） | `REANCHOR: 无可重定位项（带锚点且带行号的引用 302 条，锚点都在 ±2 行容差内；符号形态 11 条按运行时解析，不写盘）` ⇒ 台账未改、**无需** `--write-doc`（本片未改任何被台账引用的源码行） | 0 |

### 8.1 提交前后 `test:unit` 的差异（不是代码红）

`doc-anchor-relocation-identity` 的判据是 `git merge-base HEAD origin/main`；**未提交**时
`base == HEAD`、没有判定面，它按设计硬红（报错原文：
`base 与 HEAD 同一提交…本用例没有判定面却也不是 CI 浅克隆`）。提交后复跑即 `fail 0`，
`skipped` 由 1 变 2（那条自我保护的 skip 路径回到正常档）。本条在派单里已被预先点名，
不是本片引入的缺陷 —— 两次读数都记在上面那张表里，**没有把"提交前红"改写成"一直绿"**。

---

## 9 缺口（详见 `docs/architecture/acceptance-map.md` 的「#12 问答：已知缺口与判据」）

| ID | 缺口 | 一句话 |
| --- | --- | --- |
| G1 | **无运维可见性** | `/health` 不报问答接线；"完全没配 `CHAT_LLM_*`"在 `real` 下零信号（无码、无 warn、无健康位）⇒ 只能事后看回答的版本串 |
| G2 | **作业封套不承载 `retryable`** | `retryable` 只在 `ApiError` 上；客户端拿到的是 `state` + `error_code`，需要自己按 `errors.ts` 的口径重算"要不要重试" |
| G3 | **隐私类失败码在异步面被折叠** | `PrivacyError` 不是 `ApiError` ⇒ `settleCodeOf` 一律折成 `PROVIDER_UNAVAILABLE`：同意缺失（`CONSENT_REQUIRED`）、对象不可用（`OBJECT_UNAVAILABLE`）等与"供应商挂了"同码，客户端无法分流（用户授权 vs 运维/重试） |
| G4 | **版本串描述"装配结局"而不是"这份正文的出处"** | live 装配但本轮零外发（检索集合为空）时 `model_version` 仍写 `model/…`；反向（注入缝）前缀仍在但正文确实来自模型。前者已收窄到"不伴随 `answered`"（B3），后者是 NC2 有意的欠报（B1b） |
| G5 | **真实外发的 HTTP 级读数仍未取得** | `mode==='live'` 在 HTTP 夹具里要求"真 PG 账本 + 持久会话 store"，本机无 PG ⇒ live 判据落在服务层（`answerVersions` 的唯一注入缝），与生产同一行盖章代码 |

---

## 10 诚实边界 / 未取得项

1. **没有任何真实模型调用**。所有 "外发" 都是 `fetchImpl` 替身或抛错的绊线；"恰好 1 次"计的是
   替身被调用次数，不证明真实网络行为。E3 的绊线响一次是**唯一**触及"真 `globalThis.fetch`"的路径，
   且它抛错、不发包。
2. **HTTP 面的 live 结局未读数**（G5）。B2/B3 用的是服务层直构（`createConversationService`），
   与 `app.ts` 组装的是同一个函数、同一行盖章代码，但**没有**经过 fastify 封套与鉴权中间件。
3. **失败矩阵的"状态码"是该码在契约里的状态码**（`ERROR_STATUS_MAP` 现读），不是作业响应码
   （作业面恒 200）。真实供应商的错误形状（是否 429/5xx）未在本片取得。
4. **真 PG 未跑**：`conversations-pg` 集成臂不在本片门禁内，也未在本机取得读数。
5. **`CHAT_LLM_*` 半配置 = 启动失败** 这一条来自 `config.ts` 的既有实现与既有用例，本片只复用结论，
   没有新增它的覆盖。
6. 门禁读数取本机（Windows / node v24.16.0）；CI 上的数值可能因平台差异略有不同，
   **同一条判据的红/绿不会不同**（本片所有断言都与平台无关：无路径分隔符、无 `process.platform`、
   无墙钟依赖）。
