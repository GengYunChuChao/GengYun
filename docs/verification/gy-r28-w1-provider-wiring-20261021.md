# GY-R28-W1 · TTS / 标签 OCR / 普通话 ASR 真实提供者接线（证据页）

- 落盘时间：2026-10-21（Asia/Hong_Kong）
- 分支：`feat/gy-r28-w1-provider-wiring`，基点 `ee46eb1`（origin/main）
- 授权：用户 2026-10-21 口头授权「允许真实付费调用」（音色保持 `101001`；ASR 主/子账号随意）
- 本轮授权串：`gy-r28-w1-provider-20261021-cny2`（一次性轮次常量，不复用历史轮次）
- 口径边界：本页只写「已配置/未配置」与读数，**不写任何凭据值**；真实标签 OCR 样本 0、真实 ASR 样本 0
  ⇒ **不声称任何识别准确率、转写质量、音色或自然度结论**。

## 0. 一句话结论

三个域的**真实提供者**已经从「装配路径不可达」变成「配置齐备即可用」：提供者层真实调用全部返回
HTTP 200（TTS 8784 字节 MP3 / OCR 检出 2 行 6 字符 / ASR 回显 2000ms 音频时长）；
但**产品 HTTP 面仍不可用**——`real` 模式下域级媒体端口（对象存储，属媒体域）与 TTS 的
「已核对内容」端口仍是 unwired，受理会在**提供者闸门之后**以 `409 OBJECT_UNAVAILABLE` 拒绝。
断点前移了（503 `PROVIDER_UNAVAILABLE` → 409 `OBJECT_UNAVAILABLE`），但**没有**变成 200。
⛔ 不得把本页读成「三域已可用」。

## 1. 接线形状（文件级）

| 文件 | 角色 |
|---|---|
| `services/api/src/config.ts` | `AppConfig.aiProviders = { tts, ocr, asr }`（各域可 `null`）。剖面逐字段冻结，口径＝`tools/ai-config.mjs` 的 `AI_ENDPOINTS` 与 `configurationIssues()`；凭据只在内存，`toJSON()` 脱敏 |
| `services/api/src/ai/live-gate.ts` | **进程内**预算闸门（防重复计费 + 预留/结算台账；产品路径不设上限） |
| `services/api/src/ai/error-map.ts` | 供应商码 → 契约码的**唯一**映射表（三域共用；`tts/provider.ts` 改为转出） |
| `services/api/src/ai/ocr-live-ports.ts`、`ocr-live-adapter.ts` | `GeneralAccurateOCR` 适配器；必填端口 `OcrImageSource`；识别文本→`LabelFields` 的**保守**映射 |
| `services/api/src/ai/asr-live-ports.ts`、`asr-live-adapter.ts` | `SentenceRecognition` 适配器；必填端口 `AudioSource`；本地 WAV 剖面校验先于预留 |
| `services/api/src/tts/provider.ts` | 增 `createLiveTtsProviderFromConfig()`（端口装配）+ 三个域工厂接受可选 `aiProviders` |
| `services/api/src/{app.ts,routes/ocr.ts,routes/speech.ts}` | 装配点各**一行**（只传 `config.aiProviders.<域>`，零新增注入面） |
| `tools/verify-provider-live-r28.mjs` | 手工验证装置（默认离线 dry run；付费路径需轮次授权串 + 凭据路径 + 台账 + 进程锁） |

**默认关闭机制（沿用 `tts/live-ports.ts` 样板）**：端口字段全必填、无默认实现；`aiProviders` 缺省/`null`
⇒ 工厂返回接线前的 fail-closed 真实提供者（`available:false`）；`stub`/`preset_demo` 即使传了快照也无视。

**为什么 OCR/ASR 适配器放在 `ai/` 而不是 `ocr/`、`speech/`**：`tests/integration/ocr-http.mjs` 有一条
运行期模块图判据（「从 `app.ts` 可达的 OCR 域装载边，冻结基线之外一律红」，当前 11 条）。
把适配器放进 `ocr/**` 会新增 OCR 域边 ⇒ **必须**改那份基线。本片选择**不改护栏**：适配器作为
「供应商接入管道」与闸门/错误码同放 `ai/`，域内只保留 provider 接口与装配点
⇒ 实测「OCR 域装载边 = 11（基线之外 0 条）」，护栏保持满强度。

## 2. 三个必答口径的读数

### 2.1 ① 三域在 `real` 下是否真的从 503 变可用？

**提供者层：是**（下表 §3 逐行读数）；**产品 HTTP 面：否**，但断点前移且原因不再是「提供者未接线」。

| 域 | `real` + 无 AI 配置（接线前形态） | `real` + 配置齐备 | HTTP 面首个拒绝点 |
|---|---|---|---|
| TTS | `available=false`，`real-unconfigured`，受理前 `503 PROVIDER_UNAVAILABLE` | `available=true`，`providerVersion=tencent-tts-2019-08-23-voicetype101001` | `409 OBJECT_UNAVAILABLE`（产物存储 `media.kind==='unwired'`，`tts/service.ts` 第 ④ 步） |
| OCR | `available=false`，`real-unconfigured`，受理前 503 | `available=true`，`modelVersion=tencent-generalaccurateocr-2018-11-19` | `409 OBJECT_UNAVAILABLE`（`media.resolve` 未接线；服务层先判 provider 再判 media） |
| ASR | `available=false`，`real-unconfigured`，受理前 503 | `available=true`，`modelVersion=tencent-sentencerecognition-2019-06-14` | `409 OBJECT_UNAVAILABLE`（同上） |

结构性证据（可复算）：`tests/unit/ai-live-provider-wiring.test.mjs` 的「产品链」三组用例
（`create{Tts,Ocr,Speech}Provider({ executionMode:'real', aiProviders })` ⇒ `available===true`，
且 OCR/ASR 因字节来源未接线而**零发包**、`failed PROVIDER_UNAVAILABLE`——`globalThis.fetch` 绊线读数 0）。

### 2.2 ② 凭据缺失时是否仍 fail-closed？

**是，且与接线前逐字节一致**（负控制）：

| 负控制 | 读数 |
|---|---|
| `createTtsProvider({executionMode:'real'})` | `available=false`、`providerVersion=real-unconfigured`、`synthesize` ⇒ `{kind:'failed',code:'PROVIDER_UNAVAILABLE'}` |
| `createOcrProvider({executionMode:'real'})` | `available=false`、`modelVersion=real-unconfigured`、`extract` ⇒ `failed PROVIDER_UNAVAILABLE` |
| `createSpeechProvider({executionMode:'real'})` | `available=false`、`modelVersion=real-unconfigured`、`transcribe` ⇒ `failed PROVIDER_UNAVAILABLE` |
| `stub`/`preset_demo` + 环境里有凭据 | 三域 `aiProviders` 仍全 `null`；工厂返回明确标注的替身（`stub-tts-v1` / `stub-v1`） |
| `real` 缺一对凭据中的任一 | 该域 `aiProviders.<域> = null`（不逐字段混配、不回退共享对给 TTS/OCR） |
| 现有测试 | `tts-live-adapter`（633 行）、`ocr-service`、`speech-service`、`tts-service`、`media-real-mode-fail-closed`、`media-consent-wiring`、`media-grant-origin-assembly` 共 **193 项全通过**；`tests/integration/{ocr,speech,tts}-http.mjs` 全绿 |

### 2.3 ③ 真实调用次数 / 耗时 / 费用粗估

台账：`.supervisor/w1-r28-live/ledger.json`（**已 gitignore，未提交**），`ceilingCny=2`、每能力 ≤2、
`actualChargeCny` 恒 `null`（供应商响应不含金额，**未取得账单**，绝不编造实扣）。

| # | 能力 | 凭据对 | HTTP | 业务状态 | 耗时 ms | 关键字段 | 预留 CNY |
|---|---|---|---|---|---|---|---|
| 1 | TTS `TextToVoice` | 共享对 | 200 | `BUSINESS_RESPONSE` | 352（墙钟 358） | `audioBytes=8784`、`hasMpegHeader=true`、`sessionEchoOk=true`、`RequestId=d6ac51b9-360d-4be2-a54b-59e2bd4c6a0d` | 0.003 |
| 2 | OCR `GeneralAccurateOCR` | 共享对 | 200 | `BUSINESS_RESPONSE` | 214（墙钟 220） | `imageBytes=632`、`detectionCount=2`、`detectedCharacters=6`、`RequestId=c3635872-c0f5-4034-bf31-b89441994951` | 0.5 |
| 3 | ASR `SentenceRecognition` | **专用子账号对** | 200 | `SERVICE_ERROR` | 150 | `providerErrorCode=AuthFailure.SecretIdNotFound`、`RequestId=e6721d65-51d5-4ae9-9404-380ec1f6b095` | 0.0032 |
| 4 | ASR `SentenceRecognition` | **共享对**（回退组合） | 200 | `BUSINESS_RESPONSE` | 304（墙钟 310） | `audioBytes=64044`、`audioDurationMs=2000`、`providerAudioDurationMs=2000`、`transcriptCharacters=0` ⇒ `uncertain`、`RequestId=b7a4b058-1088-4dde-bebd-7e6e900c6e82` | 0.0032 |
| 5 | ASR 第 3 次尝试 | 共享对 | — | 闸门拒绝 | 2 | `BUDGET_OR_COUNT_EXCEEDED` ⇒ 契约 `PROVIDER_QUOTA_EXCEEDED`，**零发送、零记账** | 0 |

- **发送次数**：4 次真实发送（TTS 1 / OCR 1 / ASR 2，其中 1 次是凭据侧业务失败被如实计账）。
  **成功发送**：TTS 1 / OCR 1 / ASR 1 —— 每端点均 ≤2（上限由台账闸门强制，见 #5 的拒绝读数）。
- **费用粗估**：预留合计 **¥0.5094**（OCR 0.5 + TTS 0.003 + ASR 0.0032×2）。
  真实扣费未取得（`actualChargeCny=null`）；按官方国内公开价保守取高（OCR 高精 ¥0.50/次、
  ASR ¥3.20/千次、TTS 精品音色 ¥0.3/万字 ×100 字符），实际不会高于该预留。
  #3 的 `AuthFailure.SecretIdNotFound` 属鉴权失败，通常不计费，但**未取得账单，不作断言**。
- **响应正文**：一律不回显（只记录字节数、检出字符数、`RequestId`、状态与耗时）。

### 2.4 ④ 还有哪些未取得

1. **产品 HTTP 面未打通**：媒体端口（真实对象存储）与 TTS「已核对内容」端口未接线 ⇒ `real` 模式下
   三域受理最终落在 `409 OBJECT_UNAVAILABLE`。这是**媒体域/内容域**的断点，本片刻意不动。
2. **ASR 真实语音转写文本未取得**：本机无 MP3→WAV 转码器（仓内无 ffmpeg、无音频解码依赖），
   而 `VoiceFormat` 被 `configurationIssues()` 钉死为 `wav` ⇒ 只能用**合成音**（2s 440Hz，非语音）；
   供应商返回 `Result=''`（`AudioDuration=2000` 证明音频真被解析）⇒ 适配器落 `uncertain`，
   **不编造转写**。「转写出文本」这条正向读数本轮**未取得**。历史轮次
   `docs/verification/gy-i27-live-ai-20261018.md` 用真实短句取得过 `Result` 与期望文本一致
   （相似度 1.0），但那**不是本轮的读数**，不得据它声称本片 ASR 已验收。
3. **ASR 专用子账号凭据不可用**：`TENCENTCLOUD_ASR_SECRET_ID/_KEY` 在账号中不存在
   （`AuthFailure.SecretIdNotFound`）。产品配置按「专用对优先」装配 ⇒ 生产 `real` 模式下 ASR 会以
   `PROVIDER_UNAVAILABLE` 失败。**待裁决**：删掉这两个环境变量（回退共享对）或换成有效子账号密钥。
   ⛔ 本片不改 `config.ts` 的优先规则（静默改用共享对会掩盖配置错误）。
4. **真实标签图片/真人录音**：按规定一律不用。本片只用 `--init-fixtures` 生成的合成 PNG
   （`GY 2026` 点阵，632 B）与合成 WAV（2 s 440 Hz，64044 B），SHA-256 记在
   `.supervisor/w1-r28-live/synthetic-manifest.json`。
5. **并发/配额上限**：供应商侧 QPS/日配额未探测（本轮刻意只发 4 次）；本地闸门只做防重复计费，
   产品路径不设上限（额度＝运营侧配额）。
6. **内容安全 `bizType` 是否开通**：属信任与安全域（`tms`/`ims`），本片不涉及、未验证。
7. **真机/微信端到端**：未取得（小程序页面链、媒体上传链未在本片范围）。
8. **`deploy/cloudrun/env.placeholder.json` 未登记 AI 凭据键**：`deploy/**` 是本片禁改项；
   `tools/verify-release-materials.mjs` 的「环境变量模板 ⊇ 配置面」判据只扫描
   `trimmed(env,'KEY')` 字面量，因此本片的动态键读取没有被该判据拦下——
   **这是模板的缺口，不是判据的豁免**，建议另开一单把 6 个 AI 键补进部署模板。

## 3. 负控制（真跑，含工具自身的缺陷记录）

| 负控制 | 预期 | 实测读数 |
|---|---|---|
| 台账 `reservedCny` 与条目求和不一致 | 拒绝、零发送 | `REFUSED LEDGER_INTEGRITY_REQUIRED`；台账 `entries=4` 不变、`sha256` 前后相同 |
| 台账**可读不可写**（`attrib +R`） | 拒绝、零发送 | `result: kind=failed code=PROVIDER_UNAVAILABLE`（闸门 `LEDGER_WRITE_FAILED` ⇒ `LEDGER_UNAVAILABLE`）；无 `observation` 行 ⇒ 未发包；台账不变 |
| 每端点第 3 次 | 闸门拒绝、零发送 | `PROVIDER_QUOTA_EXCEEDED`、`wallClockMs=2`、台账 `entries` 仍 4 |
| 同一 `attemptKey` 重放 | `ATTEMPT_ALREADY_RESERVED` | 实跑撞到过（见下「工具缺陷」），闸门按预期拒绝，零发送、零记账 |
| 授权串不符 | `MANUAL_AUTHORIZATION_REQUIRED` | 工具在任何网络动作前中止（`--manual-authorization` 逐字比对） |
| 离线默认（无 `--live`） | 零外呼、零台账写入 | `reserves=3 settles=3 tripwire_calls=3 ledger_written=false`（绊线被调用 ⇒ 三次都走到了「即将发送」） |
| `app.ts` S01 断言负控制①：删掉 `aiProviders` 实参 | S01 必须红 | `FAIL S01 … app.ts 必须用 createTtsProvider({ executionMode, aiProviders: config.aiProviders?.tts ?? null }) 装配（配置快照，不是端口）`；`CHECKS pass=41 fail=1` |
| `app.ts` S01 断言负控制②：再插一处 `createTtsProvider(` | 计数断言必须红 | `FAIL S01 … createTtsProvider 装配点必须恰好一处`；`CHECKS pass=41 fail=1` |
| 恢复核对 | 逐字节相同 | `sha256_before=cf024974…0743 56f`（全文见下）= `sha256_after`；`git diff -- app.ts` 只剩本片那一行改动 |

> 恢复核对原值：`sha256_before=cf024974723a561e2d78904fdd1e7c98d8439f4b7a94c64b158b480b2074356f`，
> `sha256_after` 与它**逐字相同**；`git diff --stat -- services/api/src/app.ts` = `1 file changed, 1 insertion(+), 1 deletion(-)`。

**全量单测发现并已修的一处兼容性问题（如实记录）**：`config.aiProviders` 初版是**必填**字段，
`tests/unit/api-health.test.mjs` 用**手工字面量**构造 `AppConfig`（`realConfig()`，不带该字段）
⇒ `buildApp` 读 `config.aiProviders.tts` 抛 `TypeError: Cannot read properties of undefined (reading 'tts')`，
4 条 `/health` 用例变红。修法：字段改为**可选**（`aiProviders?:`），三处装配点用
`config.aiProviders?.<域> ?? null`（缺省 ⇒ 未配置 ⇒ 接线前行为）。改后 `/health` 6/6 通过。
`loadConfig()` 永远给出该字段，`undefined` 只会来自手工构造的配置对象。

**工具缺陷（实跑发现并已修）**：① 初版 `attemptKeys()` 让 TTS/OCR/ASR 共用同一 `jobId`，
ASR 的 `attemptKey` 与 OCR 撞车 ⇒ 闸门以 `ATTEMPT_ALREADY_RESERVED` 正当拒绝（零发送、零记账）。
已改为按 `能力+轮次` 派生互不相同的 jobId/mediaId。② 初版把 `readLedger()` 放在 `try` 之外，
台账完整性检查抛错时**不释放** `process.lock`，后续尝试全部 `PROCESS_LOCK_HELD`。
已把锁的释放覆盖到整段；崩溃工件按纪律**不自动清理**，本轮手工删除并记录在此。

## 4. 既有断言变更（1 条，只加强）

`tests/integration/tts-http.mjs` 的 S01（装配点结构串）：

- 原判据：`/createTtsProvider\(\{ executionMode: config\.executionMode \}\)/` 存在。
- 本片实参变化（加了 `aiProviders: config.aiProviders?.tts ?? null`）⇒ 该精确串必然失效。
- 改为：① 钉住**完整实参**（含 `aiProviders: config.aiProviders?.tts ?? null`）；
  ② **新增**「`createTtsProvider(` 在 `app.ts` 全文件恰好 1 次」的计数断言；
  ③ 同块既有的「`app.ts` 不得出现 `createLiveTtsProvider` / `live-ports` / `RealTtsPorts`」三条**原样保留**。
- 该断言**历史上第三次**因实参变化失效，三次原因：
  1. `guards` → `gatedGuards`（#145，旗标门包装，槽位与签名未变）；
  2. 增加第 6 个实参 `synthesisEgress`（#227，`registerSynthesisRoutes` 的 egress 端口）；
  3. 本次：`createTtsProvider` 增加 `aiProviders: config.aiProviders.tts`（R28-W1 真实提供者接线）。
  ⇒ 建议后续把这条锚点换成「解析 AST 取该调用实参集合」而不是整串正则，可避免第四次失效。

## 4.5 自检读数（真跑，2026-10-21 23:0x–23:5x）

| 命令 | 读数 |
|---|---|
| `npm run lint` | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描` / `lint 通过` |
| `node --test tests/unit/{tts-live-adapter,tts-service,ocr-service,speech-service,media-real-mode-fail-closed,media-consent-wiring,media-grant-origin-assembly}.test.mjs` | `tests 193 / pass 193 / fail 0` |
| `node --test --test-concurrency=1 "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs" "tests/media/*.test.mjs" "tests/reference/*.test.mjs" "tests/moderation/*.test.mjs"` | **`tests 3363 / pass 3362 / fail 0 / skipped 1`**（独占串行跑） |
| `node tests/integration/ocr-http.mjs` | `PASS 14 组`；OCR 域装载边 **11**（基线命中 11、基线之外 **0**、r8 fail-closed 命中 0） |
| `node tests/integration/speech-http.mjs` | `PASS 15 loopback HTTP groups; real assembly via buildApp（默认零端口注入）` |
| `node tests/integration/tts-http.mjs` | `CHECKS pass=42 fail=0`、`RESULT=PASS` |
| `npm run test:contract` | `tests 6 / pass 6 / fail 0` |
| `node tools/verify-contract-status.mjs` | 形状错误 0 / 语义错误 0 / 表格一致；`loadConfig` 锚点仍在 `config.ts:155-283` 区间内 |
| `npm run test:docs` | 27 项台账 + Markdown/表格 + 研究记录 5 通过 / 0 失败（4 legacy 钉住） |
| 凭据泄漏自检（进程内映射后扫描受版本控制的文件） | `tracked_files=1492 credential_keys_present=8 value_hits=0`；工作区改动文件 `value_hits=0` |
| `node tools/verify-provider-live-r28.mjs`（离线） | `reserves=3 settles=3 tripwire_calls=3 ledger_written=false` |

**抖动记录（如实）**：全量单测第一次串行跑出现 **8 项红**，全部集中在
`tests/unit/release-materials-index.test.mjs` 的「环境变量模板覆盖配置面」——原因是本片早期的
`AI_PROVIDER_TIMEOUT_MS` 配置键未进 `deploy/cloudrun/env.placeholder.json`（禁改项）。
把超时改为冻结常量后该门禁转绿（不是"抖动"，是**真实回归**，已修）。
第二次跑出现 5 项红：4 条 `/health`（`aiProviders` 必填导致手工配置字面量崩，已修为可选字段）
+ 1 条 `miniprogram-transcript-confirm`（**单独跑 25/25 通过、全量跑串行复跑也通过** ⇒ 判为抖动，
如实记录）。第三次串行全量跑 **0 失败**。

## 5. 复现命令

```bash
# 离线（默认）：不读凭据、不发包、不写台账
node tools/verify-provider-live-r28.mjs

# 生成合成样张 / 初始化台账（各一次）
node tools/verify-provider-live-r28.mjs --init-fixtures
node tools/verify-provider-live-r28.mjs --init-ledger

# 付费（每端点 ≤2；缺任一件即拒绝）
node tools/verify-provider-live-r28.mjs --live --capability tts \
  --manual-authorization gy-r28-w1-provider-20261021-cny2 \
  --credentials <私密凭据文件路径> --attempt 1
# ASR 两组合法凭据分别取证：默认专用对；--asr-credentials shared 走共享对
```

## 6. 任务书与代码的出入（复核结论）

1. 任务书 §1 说「`app.ts` 对这三域是零端口注入 ⇒ `real` 仍恒 503」——**对**；但它没点明
   「接好提供者也不会变 200」：`real` 下域级媒体端口（`ocr/media.ts`、`speech/media.ts`、
   `tts/media.ts`）与 TTS 的 `content.ts` 都是 unwired，且 OCR/ASR 的媒体校验在 provider 闸门**之后**
   ⇒ 只能到 `409 OBJECT_UNAVAILABLE`。
2. 任务书 §2 第二步说「`app.ts` 装配点把 real 端口注入 tts/ocr/speech 三域」——**代码不允许在 `app.ts` 注入**：
   `tests/integration/ocr-http.mjs` 的运行期模块图判据、`speech-http.mjs` 的「注册行只许这些键 +
   `import type` 才算数」判据、`tts-http.mjs` S01 都钉住了装配点形状。实际做法是：**域内按配置解析**
   （`routes/ocr.ts` / `routes/speech.ts` / `app.ts` 各一行只传配置快照），`app.ts` 仍不接触端口。
3. 任务书 §2 第一步建议 `aiProviders` 含 `timeoutMs` 配置项——`deploy/**` 禁改 ⇒ 不能新增
   `*_MS` 环境变量（会被 `verify-release-materials` 的模板覆盖判据判红），故超时取**冻结常量 8000**。
4. 任务书 §0 的凭据现状表与实读一致（4 个 AI 键 PRESENT、两个 SESSION_TOKEN MISSING），
   仅补充一条：`TENCENTCLOUD_ASR_*` 虽然 PRESENT，但该 SecretId 在账号中**不存在**（§2.4 第 3 条）。
5. 任务书说「端点口径唯一事实源＝`AI_ENDPOINTS` 与 `configurationIssues()`」——**对**，但
   `configurationIssues()` 还要求 `config.env==='dev'`、`privacy.*` 与 `budget.*`，那是**离线审计**的口径，
   产品侧不读这些键；本片按「参数剖面逐项对齐」落实，并在
   `tests/unit/ai-provider-config.test.mjs` 用「把产品配置映射回 `configurationIssues()` 输入并断言零 issue」
   反向核对（三域各零 issue）。
