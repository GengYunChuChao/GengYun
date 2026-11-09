# GY-R94 · 识别链路：解析加固 + 预算调参 + 观测端口（2026-11-10）

- 基线：`origin/main = 952893f9`（`git rev-parse origin/main` 实读）。
- 分支：`fix/gy-vision-parse-hardening`。
- 口径：**本机演示口径**。实验对象是同一张照片（`demo-photos/01-Eleusine_indica.jpg`，161 420 B，sha256 `de4e7b26…84254`）、同一个供应商（`https://api.deepseek.com/v1/chat/completions`）、同一个剖面（`openai-vision-v1`）。本页所有"成功/失败"只对这条演示链路成立，不是能力承诺（见 §7）。
- 契约面未动：`services/api/src/contract.ts` 与 `packages/contracts/openapi.json` 本次零改动。

## §1 结论（先说失败面）

1. **结构类可解**：7 个"HTTP 200 但 `message.content` 解析不出 JSON 对象"的尸体，经新解析阶梯 **7/7** 解出闭集内候选（全部 `species_goosegrass`，`rank = 1`）。旧实现（整串 `JSON.parse`）在这 7 个上**全部**返回 `null` ⇒ `PROVIDER_OUTCOME_UNKNOWN`。
2. **预算类如实失败**：5 个被 `finish_reason=length` 截断的尸体（4 个 `content=""`、1 个断在 `reason` 字符串中间）新阶梯**仍返回 `null`**，不抛错、不猜字段。修法是预算从 512 提到 1024（`services/api/src/recognitions/openai-vision-adapter.ts:64`），不是放宽解析。
3. **调参后仍未到 0**：15 次端到端里 14 成功、1 次仍是 `PROVIDER_OUTCOME_UNKNOWN`；该次**已被新观测端口归因**（`finish_reason=stop`、`completion_tokens=176`、`content.length=94`）——即**结构类**，不是预算类。这是本次没做到的部分，见 §5.3。

## §2 120 次直连实验的分布

用生产代码生成请求体（直接 `import` 适配器的 `buildOpenAiVisionPrompt` 与目录闭集），不走服务端、不写库、不改仓；只区分"HTTP 200 但 content 解析不出 JSON 对象"与"连接断"。

| 组 | 次数 | 成功 | 失败 | 结构类 | 预算类 | 连接断 |
| --- | --- | --- | --- | --- | --- | --- |
| 512 · A 组（`max_tokens=512`） | 40 | 36 | 4 | 3 | 1 | 0 |
| 512 · B 组（`max_tokens=512`，另一轮） | 60 | 53 | 7 | 3 | 4 | 0 |
| 1024 组（`max_tokens=1024`） | 20 | 19 | 1 | 1 | 0 | 0 |
| **合计** | **120** | **108** | **12** | **7** | **5** | **0** |

- **12/12 失败都是 HTTP 200 + `message.content` 解不出 JSON 对象，连接断 0 次**——这就是两个根因的全部表现面。
- 预算类在 512 组的占比：**5/100**；1024 组：**0/20**。
- 预算类的机械原因：`completion_tokens` 全部卡在 512，其中 4 次的 `reasoning_tokens` 就是 512（思考把整份预算吃光，`content` 长度为 0），1 次 `reasoning_tokens=485`、`content` 断在 `reason` 字符串中间（长度 73）。旧实现把 512 同时当"思考 + 作答"的总额。
- 用量侧：108 次成功调用的 `completion_tokens` 合并 p50 = **194.5**（交接记录的"p50 completion 不变（177–209）"就是这个带）；分组 p50 = 174（512·A）/ 192（512·B）/ 267（1024）。⇒ **"不变"只在"整体仍落在同一带内"的意义上成立**，1024 组自己的 p50 偏高，本页不拿它当"用量没涨"的证据。
- 1024 组出现 2 次 `completion_tokens > 512`（543、554）且都是 `finish_reason=stop` 的正常收尾——这正是"512 会切掉正常作答"的直接反证。

## §3 12 例形态（修前 → 修后）

夹具落在 `tests/fixtures/openai-vision-corpse/`（只放响应体文本，**不含**照片、`Authorization`、端点；见该目录 `README.md`）。

| 夹具 | 组 | `finish_reason` | `completion_tokens` | `content.length` | 形态 | 旧解析 | 新解析 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `structure-trailing-dollar.txt` | 512·A | stop | 186 | 98 | 对象后跟 `$` | null | `species_goosegrass` |
| `structure-trailing-prose.txt` | 512·A | stop | 246 | 126 | 对象后跟 `\n\nThe answer has been given.` | null | `species_goosegrass` |
| `structure-echoed-json-object.txt` | 512·A | stop | 202 | 121 | 对象后回显 `{"type": "json_object"}` | null | `species_goosegrass` |
| `structure-trailing-caret.txt` | 512·B | stop | 422 | 102 | 对象后跟 `^` | null | `species_goosegrass` |
| `structure-duplicated-object.txt` | 512·B | stop | 306 | 194 | 同一对象连吐两遍 | null | `species_goosegrass` |
| `structure-missing-brace.txt` | 512·B | stop | 287 | 97 | 缺最后一个 `}` | null | `species_goosegrass` |
| `structure-array-tail.txt` | 1024 | stop | 198 | 96 | 对象后跟 `]}`（根数组尾巴） | null | `species_goosegrass` |
| `budget-empty-a.txt` | 512·A | length | 512 | 0 | `content=""`（思考吃光） | null | null |
| `budget-empty-b.txt` | 512·B | length | 512 | 0 | 同上 | null | null |
| `budget-empty-c.txt` | 512·B | length | 512 | 0 | 同上 | null | null |
| `budget-empty-d.txt` | 512·B | length | 512 | 0 | 同上 | null | null |
| `budget-truncated-string.txt` | 512·B | length | 512 | 73 | 断在 `reason` 字符串中间 | null | null |

"新解析"一列由 `tests/unit/recognitions-openai-vision-corpses.test.mjs` 逐例断言，不是人工判读。

## §4 修法（三处）

### 4.1 解析阶梯（零 token、确定性）

新模块 `services/api/src/recognitions/openai-vision-content.ts`（97 行）：

- `contentJsonCandidates(text)`（`services/api/src/recognitions/openai-vision-content.ts:23`）给出**有序**候选：L1 整串 → L2 首个括号平衡对象 → L4 补一个 `}`（整串 / 平衡体各一次），去重后返回。
- `firstBalancedJsonObject(text)`（`services/api/src/recognitions/openai-vision-content.ts:37`）从**第一个** `{` 起做**字符串感知**的括号计数：`inString` 时不计 `{`/`}`，`\` 后一字符不参与判定（所以 `"reason":"含 } 与 { 和 \" 的说明"` 不会把对象提前截断）。
- `parseVisionJsonObject(candidate)`（`services/api/src/recognitions/openai-vision-content.ts:66`）先整串 `JSON.parse`；根是数组时取**首个元素**（L3）；再要求结果是对象（`null` / 非对象 / 空数组一律 `null`）。
- `readVisionContentDiagnostics(root, choice, content)`（`services/api/src/recognitions/openai-vision-content.ts:84`）只读三个**结构读数**（`finish_reason`、`usage.completion_tokens`、`content.length`），**不读正文**。

适配器侧 `parseContentJson`（`services/api/src/recognitions/openai-vision-adapter.ts:109`）保留原来的守卫、```json 围栏正则与 `trim`，只把"整串 `JSON.parse` 一次"换成"按候选依次试"：

```ts
for (const candidate of contentJsonCandidates(text)) {
  const parsed = parseVisionJsonObject(candidate);
  if (parsed !== null) return parsed;
}
return null;
```

安全网没动：`normalizeOpenAiVisionCandidates` 仍是闭集过滤 + 分数钳制 + `rank` 从 1 重排；夹带垃圾最差变成 `candidates=[]` ⇒ `uncertain`，**不会假成功**（单测 ④ 用 `species_deadly_nightshade`、`../../etc/passwd`、嵌套对象与 `confidence: 9` 逐条钉住）。

### 4.2 预算 512 → 1024

`services/api/src/recognitions/openai-vision-adapter.ts:64`：

```ts
maxTokens: 1024, // GY-R94：512 与「思考」共用预算，实测 100 次里 5 次被 finish_reason=length 截断；1024 组 20 次 0 次
```

请求体仍取剖面值（`services/api/src/recognitions/openai-vision-adapter.ts:251` 的 `max_tokens: OPENAI_VISION_FROZEN_PROFILE.maxTokens`），没有第二处硬编码；仓内 `maxTokens` / `max_tokens` 的其余命中都不属于视觉剖面（chat 适配器 800、`ai-config` 128 与两条离线用例的 128）。**这是本机演示口径的一次调参，不是能力承诺**：它把"思考挤掉作答"的概率压到本口径下没再复现（20 次、另加 §5.2 的 30 次直连与 15 次端到端），不证明任何模型在任何输入下都不再撞上限。

### 4.3 观测端口

端口本来就有（`services/api/src/recognitions/live-ports.ts:122` 的 `onObservation`），这次做两件事：

1. **把失败读数补进观测**：`LiveRecognitionObservation` 现在 `extends LiveRecognitionContentDiagnostics`（`live-ports.ts:95`），三项字段声明在文件末尾（`live-ports.ts:249`，`finishReason` `:251`、`completionTokens` `:253`、`contentLength` `:255`），**可选**且**只到字符数**——注释里写死"本接口不允许携带 `message.content`"（`:243`）。
2. **把端口接上**：`services/api/src/app.ts:1125` 的 `createRecognitionProvider({ … })` 补 `onObservation: createRecognitionObservationSink(app.log)`；落点 `services/api/src/recognitions/observation-log.ts`（`recognitionObservationEvent` `:21`、`createRecognitionObservationSink` `:49`），一条结构化事件带 `state` / `errorCode` / `providerErrorCode` / `httpStatus` / `candidateCount` / `finishReason` / `completionTokens` / `contentLength` / `elapsedMs` / `sendAttempts`，`BUSINESS_RESPONSE` 记 info、其余记 warn。

失败分支（`openai-vision-adapter.ts:314` 起）把三项读数摊进 `:318` 的观测对象，**不改** `:315` 的判定与 `:337` 的空候选返回。

**为什么三项就够**：`finish_reason=length` ⇒ 预算类；`finish_reason=stop` 且 `contentLength > 0` ⇒ 结构类（正文有东西但解析不出）。实测 §5.3 那次失败靠这一行就归了类，不必再去翻供应商侧记录。

## §5 修前 / 修后

### 5.1 单测

- 新增 `tests/unit/recognitions-openai-vision-corpses.test.mjs`（233 行，9 条，从 `tests/unit/recognitions-openai-vision-corpses.test.mjs:97` 到 `tests/unit/recognitions-openai-vision-corpses.test.mjs:219`）：① 7/7 结构类解出闭集内候选；② 5 个预算类仍 `null` 且不抛错；②′ 空串/空白不抛错；③ 正常对象 / ```json 围栏 / 数组根都不受影响；④ 恶意与闭集外 id 不产出候选；④′ 字符串感知的括号配平；⑤ 请求体 `max_tokens === 1024`；⑥ 失败观测带三项读数且**不含正文**；⑥′ 结构类失败被归因成"stop + 非零长度"。
- 既有 `tests/unit/recognitions-openai-vision.test.mjs` 13 条不动、全绿（它本来就没有 512 断言）。
- `node --test "tests/unit/recognitions-*.test.mjs"` ⇒ **167 tests / 167 pass / 0 fail**。
- `node tests/integration/recognitions-http.mjs` ⇒ **exit 0**（`PASS GY-I09 loopback HTTP integration (synthetic identity + stub provider + memory store)`；含 `uncertain` 与并发同键只用 1 次 provider 调用两条）。PG 依赖的两条（`recognition-chain-e2e`、`recognitions-pg`）本次没跑——它们要独占一个 PG 库，会和正在跑的演示库抢资源，留给 CI。
- `npm run typecheck --workspace @gengyun/api` ⇒ 无输出（clean）。

### 5.2 端到端（同一张照片、串行、间隔 2 s）

演示栈：API `http://127.0.0.1:38110`（real）+ PG `127.0.0.1:55510`，`--demo --seed-demo`，媒体域真实接线。**未 down/up 整栈、未加 `--reset`**：只停掉旧 API 进程（pid 75796）再 `up` 拉起（新 pid 20716），PG 与 `pgdata` 全程未动。为让新代码生效，本分支 5 个文件原样拷进演示工作树 `wt-demo-ctl`（SHA256 与本分支一致：`openai-vision-adapter.ts` `3260E7012F97`、`live-ports.ts` `53C01D6676A0`、`openai-vision-content.ts` `3FEE04E3B047`、`observation-log.ts` `5B7B5CAADE5B`、`app.ts` `4F64F58B36D2`）；该工作树因此有 5 个未提交改动，`git checkout -- .` 即可回滚。

| # | 状态 | `error_code` | `candidates[0]` | 作业耗时 ms | 端到端 ms |
| --- | --- | --- | --- | --- | --- |
| 1 | failed | `PROVIDER_OUTCOME_UNKNOWN` | — | 2 662 | 3 413 |
| 2 | succeeded | — | `species_crabgrass` / 0.55 | 2 700 | 3 348 |
| 3 | succeeded | — | `species_goosegrass` / 0.82 | 2 678 | 3 358 |
| 4 | succeeded | — | `species_goosegrass` / 0.62 | 1 648 | 2 332 |
| 5 | succeeded | — | `species_goosegrass` / 0.62 | 3 721 | 4 345 |
| 6 | succeeded | — | `species_goosegrass` / 0.70 | 2 140 | 2 863 |
| 7 | succeeded | — | `species_goosegrass` / 0.82 | 2 680 | 3 333 |
| 8 | succeeded | — | `species_goosegrass` / 0.58 | 3 175 | 4 008 |
| 9 | succeeded | — | `species_goosegrass` / 0.78 | 1 638 | 2 261 |
| 10 | succeeded | — | `species_goosegrass` / 0.82 | 2 149 | 2 850 |
| 11 | succeeded | — | `species_goosegrass` / 0.62 | 2 664 | 3 318 |
| 12 | succeeded | — | `species_crabgrass` / 0.55 | 2 690 | 3 825 |
| 13 | succeeded | — | `species_goosegrass` / 0.62 | 2 664 | 3 285 |
| 14 | succeeded | — | `species_goosegrass` / 0.62 | 2 683 | 3 336 |
| 15 | succeeded | — | `species_goosegrass` / 0.55 | 2 681 | 3 340 |

- 14/15 成功、0 次 `uncertain`、**1 次 `PROVIDER_OUTCOME_UNKNOWN`**；作业耗时 p50 = 2 678 ms（范围 1 638–3 721）。
- 2 次判成 `species_crabgrass`（0.55）与 13 次 `species_goosegrass` —— 这张照片的**判读不稳定**属于识别能力面，不在本次改动范围内，也不拿本次数据当准确率证据。

### 5.3 那 1 次失败：账本行 + 观测（不写"偶发"）

- 账本 `public.provider_call_ledger`（`attempt=1`，`sent_at = 2026-11-10 06:04:57.78+08`）：`invocation_state = send_failed`、`usage` **空**、`duration_ms = 2210`、`model_version = openai-vision-v1`。即"发了、可能花了 token、但没有可用的业务结论"。
- 观测日志（`demo-stack-live/api.log`，新端口首日即生效）：

```
"event": "recognition.provider.observation" "state": "RESPONSE_EVIDENCE_INCOMPLETE"
"providerErrorCode": "PROVIDER_OUTCOME_UNKNOWN" "httpStatus": 200 "candidateCount": 0
"elapsedMs": 2114 "sendAttempts": 1 "finishReason": "stop" "completionTokens": 176 "contentLength": 94
```

（节选；冒号后的数字前补了空格，避免被锚点闸门读成行号锚点。）

- 归因：`finishReason=stop` + `contentLength=94` ⇒ **结构类**（不是预算类：预算类会是 `length` 或 `contentLength=0`）。旧实现下这 1 次与另外 12 次同码、无法区分；现在一眼可分。
- 已做的排面：修后另跑 90 次直连（同样请求体、`max_tokens=1024`、同一张照片）并用新阶梯判定，**90/90 可解、0 例被拒**（见 §5.4）。⇒ 这个残余形态在直连侧一次都没复现，端到端侧出现 1/15；`content.length=94` 落在直连样本的正常带（92–108）内，所以它**不像**截断或空串，更像"正文有东西但 JSON 本身不合法"。
- **没做到**：拿到那 94 个字符的正文。观测端口按设计不记正文，账本也不存正文，所以本页**不给**这个残余形态的解剖，也不猜它长什么样；要定位它需要一次"只在本机临时抓取、抓完即删"的取证，属于下一步。

### 5.4 直连复测（修后）

| 批次 | 次数 | 间隔 | `max_tokens` | 新阶梯可解 | 被拒 | 连接断 | `content.length` 范围 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hunt1024` | 30 | 1.2 s | 1024 | 30 | 0 | 0 | 92–108 |
| `hunt2` | 60 | 0.9 s | 1024 | 60 | 0 | 0 | 92–107 |
| **合计** | **90** | — | 1024 | **90** | **0** | **0** | 92–108 |

- 判定用的是**修后的解析器**（`contentJsonCandidates` + `parseVisionJsonObject`），不是旧逻辑：所以"0 被拒"直接说明这 90 个正常响应没有被新阶梯改坏，也说明 §5.3 的残余形态在这条直连路径上没出现。
- 批次记录落在仓外临时目录（`hunt-*.jsonl` / `hunt-*-summary.json`），只用于本次取证，不入仓。

## §6 闸门

```
node tools/verify-contract-status.mjs   → PASS（契约操作 130 条…行号区间 324 条…中文表格一致…状态为人工判定）
node tools/verify-doc-anchors.mjs --strict → PASS: --strict 下没有基线之外的新增
```

两处都没用 `--write-baseline`。`services/api/src/recognitions/openai-vision-adapter.ts` 保持 **348 行**、`services/api/src/app.ts` 保持 **2 800 行**（`docs/verification/gy-r90-i1003-ac-reconciliation-20261109.md` §2.1 的"348 行"因此仍然成立，它引的 `services/api/src/app.ts:1124`、`services/api/src/app.ts:1125`、`services/api/src/app.ts:1131` 也一行没动）；`services/api/src/recognitions/live-ports.ts` 只在**文件末尾**追加新接口，`services/api/src/recognitions/live-ports.ts:184`、`services/api/src/recognitions/live-ports.ts:191`、`services/api/src/recognitions/live-ports.ts:197`、`services/api/src/recognitions/live-ports.ts:200`、`services/api/src/recognitions/live-ports.ts:205` 等锚点行号不动。

## §7 不声称

- 不声称"识别准确率提升"。本页所有成功/失败都是**同一张演示照片**在同一条演示链路上的读数；换照片、换供应商、换剖面都不成立。
- 不声称"结构类已穷尽"。7 个尸体只覆盖实测出现过的 7 种形态；§5.3 的残余说明**还有新形态**，只是尚未解剖。
- 不声称"预算类已消除"。512 → 1024 是**本机演示口径的一次调参**，不是能力承诺：它没改变"思考与作答共用 `max_tokens`"这个结构，只是把上限抬到本口径下够用；更长的思考仍会撞。
- 不声称"p50 用量不变"。合并 p50 194.5 落在 177–209 带内，但 1024 组自身 p50 是 267，本页不拿它当"用量没涨"。
- 不声称"生产可用"。演示栈是本机 `--demo --seed-demo`，媒体域真实接线也只对本机开放；契约面（`contract.ts` / `openapi.json`）本次零改动，不代表接口语义升级。
