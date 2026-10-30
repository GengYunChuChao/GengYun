# GY-R70 · 拍草识别（#9）真实适配器 + 字节端口接线（2026-10-30）

**一句话**：本片把六条真实能力里**唯一「未接线」**的一条 —— 草类识别 —— 从「`real` 下 `recognize()` 恒返回
`failed PROVIDER_UNAVAILABLE`、连适配器都不存在」推进到「**适配器在场、字节端口在场、装配在场**」，
并保持既有硬红线：**缺凭据 503 → 有凭据无字节端口 409 → 两者齐备才可能发包**，任何一步失败都
fail-closed、**绝不回退替身**、**绝不发明新错误码**。

**它证明的是「接线成立 + 失败语义可判定 + 零外呼可证」；它不证明「识别能力可用」**：
本基线没有已审识别供应商、本片**没有发起任何真实供应商调用**（一次都没有），因此
**不证明识别准确率、不证明任何一次真实调用成功**，也不证明任何厂商模型版本。

## 0 元信息

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-30（Asia/Hong_Kong） |
| 基线 sha | `53354fe7`（`test(privacy): exercise empty consent policies in PostgreSQL CI (#767)`）。⚠ 复核时 `upstream/main` 已是 `2bbb9e38`（比基线多 1 个 miniprogram 修复提交），本片按派单**固定从 `53354fe7` 切出**，未包含该提交 |
| 分支 / worktree | `feat/gy-r70-recognition-live` / `E:\GengYunCommander\wt-r70-recog` |
| 证据页性质 | 本页是该分支 HEAD 的**运行期读数**，不是能力验收 |

## 1 缺口（改前读数，逐条可复核）

1. `services/api/src/recognitions/provider.ts` 的 `createRealRecognitionProvider().recognize()` **恒**返回
   `{kind:'failed', code:'PROVIDER_UNAVAILABLE'}` —— `real` 下根本没有适配器（连 `fetch` 都没被调用过）。
2. `services/api/src/recognitions/media.ts` 的 `createRecognitionMediaPort('real')` **恒**为
   `createUnwiredMediaPort()`（`kind:'unwired'`，恒 `OBJECT_UNAVAILABLE`）⇒ 即使补了适配器，
   `POST /api/v1/recognitions` 的**受理前媒体校验**也会把它挡在 409。
3. `RECOGNITION_PROVIDER_URL` / `RECOGNITION_PROVIDER_KEY` 由 `services/api/src/app.ts` 直读
   `process.env`，是全仓**唯一**绕过 `config.ts` 的 AI 配置分支（本片**保持现状**，见 §10）。
4. 因此改前的真实失败序只有两步：**无凭据 503**；凭据齐备也**不会**有第三步（没有适配器 ⇒ 恒 `failed`）。

## 2 改了什么（逐文件职责）

| 文件 | 职责（一句话） |
| --- | --- |
| `services/api/src/recognitions/live-ports.ts`（新） | 识别域真实调用的**端口接口**：凭据 / 被校验剖面 / 图片字节来源 / 预算闸门 / 安全观测 ＋ 两个错误类 ＋ 进程内闸门。复用 `tts/live-ports.ts` 的**拒绝闭集**（`LiveGateRefusedError`）与 `liveGateRefusalToErrorCode()`，**不**给共用 `LiveCapability` 闭集新增成员（识别域在本基线没有已审单价，塞一个数进去就是假账）。 |
| `services/api/src/recognitions/live-adapter.ts`（新） | **唯一**能触达真实发送的构造器 `createLiveRecognitionProvider()`：`build(本地) → reserve(闸门) → send(恰好一次) → settle(无论成败)`；`fetchImpl` 可注入、`redirect:'manual'`、`AbortSignal.timeout`、零重试、端点构造期＋发送前各断言一次（https／无凭据／无查询串／无片段）。`modelVersion` 写**协议版本** `gy-recognition-live-v1`（本基线没有已审厂商模型，不写模型名）。 |
| `services/api/src/recognitions/image-source.ts`（新） | 真实字节来源 `createObjectStoreRecognitionImageSource()`：按 `media_id` + `revision` 读媒体登记册（归属／版本／状态／用途／衍生件键）→ **只**从对象存储取**去元数据衍生件**（`derivativeRef`）→ 校验 `Content-Type`。与 `services/api/src/ai/ocr-image-source.ts`（#766）逐条同形，**唯一**刻意差异：端口用**取值器**晚绑定（见下）。 |
| `services/api/src/recognitions/media.ts`（改） | `real` 分支接上媒体域**既有**两个端口：新增 `createObjectStoreRecognitionMediaPort(resolvePorts)`（`kind:'wired'`），**复用同一份**字节来源做判定 ⇒ 受理前校验与适配器取字节看的是**同一行登记册、同一个衍生件对象、同一套拒绝理由**。`createRecognitionMediaPort(mode)` 单参调用形态**逐字不变**（`real` 仍 `unwired`、其余仍替身）。 |
| `services/api/src/recognitions/provider.ts`（改） | `real` 解析改成三段式：缺凭据 ⇒ `createRealRecognitionProvider`（`available:false` ⇒ 503）；齐备 ⇒ 尝试装配真实适配器；**装配失败/配置不合法 ⇒ 回落 fail-closed**（`available:false` ＋ 原因点名「装配失败」），⛔ 绝不回退 `stub`/`preset_demo`。`createRealRecognitionProvider` 只多一个**可选**的 `unavailableReasonOverride`（既有调用的字段逐字不变）。 |
| `services/api/src/app.ts`（改） | 装配点把媒体域**既有**的 `mediaStore` + `mediaObjectStore` 以**取值器**转发（`const recognitionMediaPorts = () => ({ objectStore: mediaObjectStore, mediaRecords: mediaStore })`），同一份取值器既交给 `createRecognitionProvider` 的 `imageSource`，也交给 `createRecognitionMediaPort(mode, …)`。**不新建存储、不读 env、不铸造批准能力**。改动**净 0 行**（4 插 4 删），因此不产生行号漂移、`docs/**` 里对 `app.ts` 的历史行号锚点全部保持原状。 |
| `tests/unit/recognitions-live-adapter.test.mjs`（新） | 15 条用例：适配器契约矩阵（正常／超时／配额／5xx／4xx／非法 JSON／缺 `request_id`／坏候选／坏分支／空候选）、字节端口矩阵（13 条坏输入 + 只读衍生件）、媒体端口收敛、零外呼绊线、等价性、失败序三步（产品装配 `buildApp`）、装配结构与源码自证。 |
| `tests/unit/{runtime-strings-truth,media-port-injection-wiring,media-real-mode-fail-closed}.test.mjs`（改） | 三处**既有结构钉子**按新事实登记（逐条见 §9）。前两处是「真值文案」与「端口注入」闸门，第三处是 `app.ts` 的端口溯源闸门（`objectStore` 实参 ×3 → ×4）。第三处**等长**（10/10，净值 0 行），所以 `docs/verification/gy-i06-media-real-provider-plan-20261021.md:120` 对它的行号引用仍落在原行。 |
| `docs/architecture/ai-ops-spec-status.md`（改） | N06「识别真实供应商适配器」由「未实现（P1）」改为「**部分实现（P1）**」并改准依据行号（原文那句「即使凭据齐备也没有已审适配器」已被本片推翻，属**必须**改的过期主张）。 |
| `docs/reference/configuration.md`（改） | `RECOGNITION_PROVIDER_*` 那一行同步改准（删掉「本仓当前没有已审识别适配器，作业仍以 failed 收尾」的过期主张，补上构造期断言与「协议级适配器 ≠ 已审供应商」的边界）。 |
| `tools/doc-anchors-orphan-baseline.json`（改） | N06 行里随过期句子一并删掉的旧裸锚点（该行第 165 行）走**写模式**登记（`--accept=0` ＋ 理由入账：新增 0 条、陈旧 1 条，属如实删除而非放宽判据）。 |

**为什么端口用「取值器」晚绑定**：`app.ts` 里识别域的装配点（`recognitionProviderResolved`，`services/api/src/app.ts:1116`）在媒体域端口
（`mediaStore` `services/api/src/app.ts:1299` / `mediaObjectStore` `services/api/src/app.ts:1799`）**之前**，而这两处解析点各有既有钉子不许挪动。
取值器在**受理/执行时**（`buildApp` 返回之后）才读一次，读到的是媒体域**既有**的那两个实例；
`createObjectStoreRecognitionImageSource()` 的**每一次** `read()` 都会重新取一次，因此不存在「先捕获空端口」的窗口。

## 3 什么被证明了

1. **适配器在场且只吃注入端口**（`A·正控制` / `A·构造期 fail-closed`）：`createLiveRecognitionProvider()` 没有端口
   对象就构造不出来（端点非 https／内嵌凭据／带查询串／超时越界／`maxRetries≠0`／字节上限不符／缺 `apiKey`／
   缺授权串／缺字节端口 —— 15 条构造期拒绝逐条断言）；成功路径里 `redirect:'manual'`、`Authorization: Bearer …`、
   `x-gy-protocol` 与请求体字节都逐项钉住。
2. **错误映射只用既有闭集**（`A·失败矩阵`，16 条）：超时 → `PROVIDER_TIMEOUT`；HTTP 429 → `PROVIDER_QUOTA_EXCEEDED`；
   HTTP 401/403/5xx → `PROVIDER_UNAVAILABLE`；HTTP 400／非 JSON／JSON 是数组／缺 `request_id`／候选非数组／候选 >3／
   分支不在闭集 → `PROVIDER_OUTCOME_UNKNOWN`；传输失败 → `PROVIDER_OUTCOME_UNKNOWN`（无法排除已处理）。
   每条都断言「码 ∈ `PROVIDER_FAILURE_CODES` 四值闭集」且「码 ∈ 契约 `ERROR_CODES`」，并断言**永不落 `succeeded`**。
3. **闸门三拒绝可判**（`A·闸门`）：授权串不一致 ⇒ `PROVIDER_UNAVAILABLE`、次数上限 ⇒ `PROVIDER_QUOTA_EXCEEDED`、
   同一尝试（`jobId:mediaId#revision`）第二次 ⇒ `PROVIDER_OUTCOME_UNKNOWN`（**绝不重发**）；每次都有「正控制」
   证明红不是因为「闸门永远拒」；结算在成败两侧都落账。
4. **只读去元数据衍生件**（`B·正控制` / `B·失败矩阵`）：对象存储端口被读的**唯一**键是 `derivativeRef`；
   原件键 `rawRef` **一次都没被读**（原件键里放了一份不同的字节，任何回退读原件都会让请求体变样）。
   13 条坏输入（记录不存在／越权同形／版本推进／未就绪／跨用途 `label_ocr`／跨用途 `community_image`／两键皆空／
   只有原件／对象不存在／空字节／`image/webp`／`Content-Type` 缺失）逐条 `null` ＋ 既有码 ＋ 原因不含对象键。
5. **失败序三步成立**（§5 实测表）：无凭据 503 → 有凭据无字节端口 409 → 两者齐备才 202 并恰好发包一次。
6. **零外呼可证**（§4）：`globalThis.fetch` 绊线在「缺凭据／缺字节端口／端口未配置／端点不合法」四条路径上
   计数 **0**；产品装配级同样 **0**。
7. **等价性**（`D·等价性`）：**只**缺凭据时，`executionMode`／`modelVersion`／`available`／`unavailableReason` 与
   `recognize()` 结局**逐字段**与改前相同（`real-unconfigured` / `available:false` / 同一句 503 文案 /
   `failed PROVIDER_UNAVAILABLE`）；非 `real` 分支仍是不带适配器的替身。
8. **装配点真的交了端口**（`F·两者齐备` / `G·装配结构`）：走**产品同一个** `buildApp`，真实模式下受理 202、
   任务落 `succeeded`、发送 **恰好 1 次**、请求体字节与衍生件**逐字节相同且不等于原件字节**、
   识别记录的 `model_version` 是协议版本；`app.ts` 的转发形状与「凭据仍从这两个 env 读」逐字钉住。

## 4 「零外呼」怎么证的（三条互不替代的证据）

1. **绊线计数**：`tests/unit/recognitions-live-adapter.test.mjs` 的 `C·零外呼` 与 `E·失败序①/②` 在**构造任何应用之前**
   把 `globalThis.fetch` 换成绊线（被调用即抛错并自增计数），跑完断言计数 **0**。适配器在构造期捕获
   `ports.fetchImpl ?? globalThis.fetch`，因此「谁在何时装配」都被这套绊线覆盖。
2. **注入即隔离**：所有**发包成功**路径都用注入的假 `fetchImpl`（`captureFetch`），端点域名是 `.invalid`
   （DNS 不可解析，即使漏注入也不可能连上任何真实主机）；测试文件**没有**任何真实端点、任何凭据值。
3. **结构自证**：`G·装配结构` 直接读源码断言 —— `live-adapter.ts` 与 `image-source.ts` 都**不含** `process.env`／
   `node:fs`／`process.cwd`；`image-source.ts` 连 `fetch(` 都不出现（字节来源不发包，只有适配器发）。

**没有做的事**（与本片同一条红线）：没有真实凭据、没有一次真实供应商调用、没有 `gh`、没有 push、没有读取或打印任何凭据值。

## 5 失败序实测表（产品装配 `buildApp`，全离线）

| # | 条件 | 读点 | 实测读数 | 外呼 |
| --- | --- | --- | --- | --- |
| ① | `real`、**无凭据**（两个 env 均不存在） | `POST /api/v1/recognitions` | `503` `PROVIDER_UNAVAILABLE`，message `缺少真实识别供应商凭据（fail-closed，不回退替身）`，`retryable:false`；`describe()`：`providerAvailable:false`、`modelVersion:real-unconfigured` | **0** |
| ② | `real`、**凭据齐备**、对象存储 `unwired`（真实默认装配） | 同上 | `409` `OBJECT_UNAVAILABLE`（`媒体引用不可用`），`retryable:false`；`describe()`：`providerAvailable:true`、`mediaPort:wired` | **0** |
| ③ | `real`、凭据齐备、媒体登记册有 `ready` 的 `weed_recognition` 记录、对象存储里有**衍生件** | 同上 → `GET /api/v1/jobs/{id}` | `202` → `state:succeeded`；`fetch` **恰好 1 次**；请求体 base64 解码后与衍生件**逐字节相同**、**不等于**原件字节 | **1（假 fetch）** |

即：**「有凭据」本身不产生任何外呼** —— 第 ①→② 步把「凭据齐备」这一新事实单独读了出来（改前恒 503，
现在 `providerAvailable:true` 且失败点后移到媒体校验），而真正发包仍需第 ③ 步的字节齐备。

## 6 错误映射表（适配器内部，全部是既有契约码）

| 触发条件 | 观测态 `state` | 对外契约码 |
| --- | --- | --- |
| 取不到字节／字节非 PNG/JPEG／超字节上限 | 未发包（本地拒绝先于预留） | `PROVIDER_UNAVAILABLE` |
| 闸门：授权串不一致／台账不可用 | `reserve` 拒绝 | `PROVIDER_UNAVAILABLE` |
| 闸门：次数上限 | `reserve` 拒绝 | `PROVIDER_QUOTA_EXCEEDED` |
| 闸门：同一尝试已预留（绝不重发） | `reserve` 拒绝 | `PROVIDER_OUTCOME_UNKNOWN` |
| `AbortSignal.timeout`（`TimeoutError`/`AbortError`） | `TIMEOUT` | `PROVIDER_TIMEOUT` |
| 其它传输失败（DNS／连接重置／TLS） | `OUTCOME_UNKNOWN` | `PROVIDER_OUTCOME_UNKNOWN` |
| HTTP 429 | `HTTP_ERROR` | `PROVIDER_QUOTA_EXCEEDED` |
| HTTP 401／403／5xx | `HTTP_ERROR` | `PROVIDER_UNAVAILABLE` |
| 其它非 2xx（400／404／409／422…） | `HTTP_ERROR` | `PROVIDER_OUTCOME_UNKNOWN` |
| 响应体不是 JSON／JSON 不是对象 | `OUTCOME_UNKNOWN` / `RESPONSE_EVIDENCE_INCOMPLETE` | `PROVIDER_OUTCOME_UNKNOWN` |
| 缺 `request_id`（无法追溯，绝不当事成功） | `RESPONSE_EVIDENCE_INCOMPLETE` | `PROVIDER_OUTCOME_UNKNOWN` |
| 候选不是数组／超过 3 条／分支不在六类闭集 | `RESPONSE_EVIDENCE_INCOMPLETE` | `PROVIDER_OUTCOME_UNKNOWN` |
| 候选字段语义非法（rank 重复／缺字段／分数越界） | 交给 `decideOutcome`（**唯一**校验点） | 服务层落 `failed` + `PROVIDER_OUTCOME_UNKNOWN` |
| 空候选（正常调用但没结果） | `BUSINESS_RESPONSE` | 不是失败：`completed` + 分支 `no_result` ⇒ `uncertain` |

**不发明新码**：本文件只可能返回 `PROVIDER_FAILURE_CODES` 的四个成员（测试逐条断言 ⊆ 契约 `ERROR_CODES`）。

## 7 门禁读数（本片自跑）

| 门禁 | 读数 | exit |
| --- | --- | --- |
| `npm run test:unit` | `tests 5789 / pass 5786 / fail 0 / cancelled 0 / skipped 1`（另 2 条既有 `todo`） | 0 |
| `npm run verify:anchors` | `verify-contract-status` PASS（126 条操作；行号区间 313 条；中文表格一致）；`verify-doc-anchors --strict` PASS（基线外新增 0、陈旧 0） | 0 |
| **CI-exact** `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | PASS（结构四判据 + `ANCHOR_DRIFT` + `BARE_ORPHAN` + `ANCHOR-COUNT` + `COMMENT_ANCHOR` 均无基线外新增） | 0 |
| `npm run verify:parity` | `extra []` / `missing []` / `ledgerDrift []` | 0 |
| `npm run verify:capability-map` | `totalOps=46，有入口=46，无入口=0，死按钮=0`，标记块与重算一致 | 0 |
| `npm run test:docs` | 研究记录 5 通过 / 0 失败 / 4 legacy 已钉住；`docs/research` 结构校验 PASS | 0 |
| `npm run lint` | `tsc --noEmit` services/api PASS、apps/admin PASS；仓库卫生扫描 PASS | 0 |
| `npm run test:contract` | `tests 17 / pass 17 / fail 0` | 0 |
| `npm run build` | api + admin 均 built（`TMP`/`TEMP` 指向仓外，见下方环境注记）；**构建产物已在 `test:unit` 前删除** | 0 |
| `npm run test:failmatrix` | `矩阵合计 249 条：PASS 249 / FAIL 0` | 0 |

> 环境注记（与本片代码无关，如实登记）：`npm run build` 在本机**默认**用户 `TEMP` 下会在
> `apps/admin` 的 esbuild 阶段报 `remove …\esbuild-…: Access is denied`；把 `TMP`/`TEMP` 指到仓外可写目录后
> 同一条命令 exit 0（本页读数即该口径）。另：`services/api/dist` 一旦存在，`tests/moderation/model-ports.test.mjs`
> 的「文书边界」会把构建产物算作模型合流消费者而判红 ⇒ 本片在 `test:unit` 前删掉 `services/api/dist` 与 `apps/admin/dist`。

## 8 负控制（逐条实际打出并记录红在哪 → 恢复后复绿）

| # | 怎么打的 | 红在哪（逐字摘录） | 恢复后 |
| --- | --- | --- | --- |
| ① | `live-adapter.ts`：把「非 `BUSINESS_RESPONSE` ⇒ `failed`」改成返回一条高分候选（`completed` / `model_score: 0.99`） | `A·失败矩阵` 红（14/15）：首个断言 `超时（AbortSignal.timeout）` 期望 `{kind:'failed',code:'PROVIDER_TIMEOUT'}`，实际 `{kind:'completed',candidates:[{species_id:'synthetic_neg_control',…}]}` —— 即**失败被写成了成功** | 15/15 绿 |
| ② | `live-adapter.ts`：把超时映射由 `PROVIDER_TIMEOUT` 改成 `PROVIDER_UNAVAILABLE`（码被抹平） | `A·失败矩阵` 红（14/15）：`AssertionError: 超时（AbortSignal.timeout）`，实际码 `PROVIDER_UNAVAILABLE`（同一用例里的 `AbortError（等价超时）` 一并被这条抹平覆盖） | 15/15 绿 |
| ③ | `image-source.ts`：把取字节的键由 `record.derivativeRef` 改成 `record.rawRef ?? record.derivativeRef`（回退读含 EXIF/GPS 的原件） | 三红（12/15）：`B·正控制`（`只允许读衍生件键` 失败 —— 实际读到 `media-raw/synthetic-r70-original-with-exif-0001`）、`B·媒体引用端口`、`F·两者齐备`（请求体字节变成原件那 4 字节） | 15/15 绿 |
| ④ | `provider.ts`：`createRealRecognitionProvider` 把 `available` 恒置 `true`（「无凭据」不再 503） | 三红（12/15）：`E·失败序①`（`503` → `409`：`expected 503, actual 409`）、`C·零外呼`（`available` 期望 `false`）、`D·等价性`（同上） | 15/15 绿 |

恢复方式：每次用负控制前的副本覆盖回源文件，并核对 SHA256 与本片 HEAD 一致 ——
`live-adapter.ts` = `E9551FC430E97647…`、`image-source.ts` = `5A61594727C9ABD5…`、`provider.ts` = `7C6CB70AF4BE7910…`；
恢复后复跑本片用例到 `15/15`。§7 的 `test:unit` 读数（`5789 / 5786 / 0 / 1`）是在这**同一份字节**上取得的。

## 9 既有断言 前 → 后（为什么改别人的钉子）

| 位置 | 改前 | 改后 | 为什么这是**变准**而不是放宽 |
| --- | --- | --- | --- |
| `tests/unit/runtime-strings-truth.test.mjs`（默认 `real` 装配的 `describe()`） | 识别域 `mediaPort:'unwired'` + 未接线文案 | 识别域 `mediaPort:'wired'` + 新文案（逐字常量） | 该域媒体端口**确实**已接媒体域两个端口；判据强度不变（仍**逐字相等**），同一用例继续断言 `providerAvailable:false`。默认装配拿到的是**未接线对象存储** ⇒ `POST` 仍是 409（由本片失败序②实测） |
| `tests/unit/media-port-injection-wiring.test.mjs` ② | 三域「零注入 + real」都期望 `unwired` | 识别域期望 `wired` + 新文案；OCR/语音不变 | 同上；`REAL_PROVIDER_REFUSALS` 的 503 文案逐字未动（无凭据仍是 503） |
| `tests/unit/media-real-mode-fail-closed.test.mjs`（`app.ts` 端口溯源） | `objectStore` 实参 **×3**（媒体服务 + 语音 + OCR） | **×4**（+ 识别域同形转发），并逐行钉死 `const recognitionMediaPorts = ` 那一行 | 这是**收紧**的同形断言：新增的第四处也被逐行钉死「只允许原样转发既有端口」。文件**等长**（10/10，净值 0 行），`docs/**` 对该文件的行号引用不变 |
| `docs/architecture/ai-ops-spec-status.md` N06 | 「未实现（P1）」「即使凭据齐备也没有已审适配器」 | 「部分实现（P1）」+ 新依据行号 + 「协议级适配器 ≠ 已审供应商」 | 原句已被本片推翻，属**必须**改的过期主张；判定仍是**未**完成（没有已审供应商） |
| `docs/reference/configuration.md` `RECOGNITION_PROVIDER_*` 行 | 「配齐也不会发包」 | 「配齐即可受理并发包；仍无已审供应商」 | 同上 |
| `tools/doc-anchors-orphan-baseline.json` | `ai-ops-spec-status.md` 里第 165 行那条裸锚点 | 删除（`--accept=0` + 理由入账） | 该裸锚点随过期句子一并删除；**未**新增任何免罚条目 |

## 10 需要裁定的一点（本片**没有**动 `config.ts`）

`RECOGNITION_PROVIDER_URL` / `RECOGNITION_PROVIDER_KEY` 仍是 `app.ts` 直读 `process.env`（全仓唯一绕过
`config.ts` 的 AI 配置分支）。**本片选择不动**，理由是可核的：

- 把它们收进 `config.ts` 会引入**启动校验口径变化**（`REQUIRED_WHEN_REAL` 是否新增必填、非法值是否 `ConfigError`
  让进程 exit 1）。派单明写「若会导致启动校验口径变化（新增必填）就⛔ 不要动，宁可留现状并登记」。
- 现状的失败语义已经**够用且可核**：缺凭据 ⇒ 域内 503（不排队、不建任务、零外呼），非法端点 ⇒ 构造期拒绝并回落
  fail-closed（`available:false`，原因点名「装配失败」），两者都不会静默降级。
- 现有 `tools/verify-real-capability-config.mjs` 已把这两个键纳入「能力组三态」自检（`recognition` 组、
  `https-url` 形态），也就是说**运维侧已有可复跑的读数**，只是不在启动校验里。

⇒ **待裁定**：要不要另起一片把识别配置收进 `config.ts`（并把 `tools/lib/real-capability-config.mjs` 的
`recognition` 组与启动校验对齐）？若收，需同时决定「非法端点 ⇒ 启动 exit 1 还是域内 503」——这是**行为变更**，
不宜夹在本片里做。

## 11 什么**没有**被证明（不得外推）

1. **不证明识别准确率**：真实样本 0（见 [样本缺口登记](../evaluation/sample-gap-register.md)）；本片所有图片都是
   24 字节**合成 PNG 头**，所有候选都是合成占位串。
2. **不证明任何一次真实供应商调用成功**：**零**真实调用、**零**真实响应；端点域名是 `.invalid`；没有任何凭据。
3. **不证明「已审供应商」**：本基线没有已审识别供应商，`model_version` 只写协议版本 `gy-recognition-live-v1`，
   线上协议（`POST <endpoint>` + `{protocol, media:{content_type, bytes_base64}, media_revision}` +
   `{request_id, candidates, uncertainty_reasons, branch}`）是**本片声明的协议**，不是任何厂商的既成 API。
   ⇒ 若要接真实供应商，必须另起一片做「厂商字段映射 + 已审凭据 + 真实样本」，**不得**把本页当成那份证据。
4. **不证明真实对象存储可用**：`getObject` 全部走仓内替身/假端口，**零**真实网络往返；`s3_compatible` 适配器的
   真实签名与桶策略未在本片验收；也未走 `approveRealMediaWiring()`（本片只**转发**既有端口，不铸造批准能力）。
5. **不证明 EXIF 清除的实际效果**：只证明「读的是衍生件键」这一结构事实，未用真实相机原图验证衍生件里确实没有 EXIF。
6. **不证明衍生件的字节身份**：登记册的 `bytes`/`sha256` 描述的是**原件**，衍生件没有可比对摘要 ⇒ 本端口只校验
   「对象存在 + 非空 + `Content-Type` 可接受」（与 OCR 侧同一处已知弱点，如实登记）。
7. **不证明受理侧零成本**：受理时的媒体校验会**真的读一遍**衍生件字节（用来确认「配齐且真有字节」才受理），
   执行时适配器**再读一次**。刻意**不缓存**：把图片字节留进进程是一个新的数据留存面。这条成本如实登记，
   真实部署下的对象存储流量需另测。
8. **不证明 `describe()` 之外的任何对外字段变化**：`mediaPort` / `mediaNote` 两字字段的变化见 §9，其余对外字段未动。
