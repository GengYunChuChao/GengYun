# GY-I13 真实 TTS 适配器接线与本轮真实调用证据（2026-10-12）

- 上游 issue：[GengYunChuChao/GengYun#13](https://github.com/GengYunChuChao/GengYun/issues/13)（`stage:initial` / `priority:P1` / `phase:M2`，**保持 open**）
- worktree：`E:\GengYunCommander\GengYun_W8`；分支：`feat/gy-i13-synthesis`
- 基线：`upstream/main = d55629237b38931edc7a1c05c6745c490838e600`（`git fetch upstream --prune` 后复核，未前进）
- 接线方案依据：另一位写手的 `E:\GengYunCommander\GengYun_W10\docs\verification\provider-adapter-live-wiring.md`（§2.1–§2.7、§3.3；该文件在**另一个 worktree**，不在本分支）
- 接线代码提交：`f5c5960`（真实适配器接线 + 手工装置 + 14 条离线回归）；阶段 1 服务层提交：`30632fe`
- 口径：**本文件不宣布验收通过**，**不声称** TTS 能力"已验收"、**不声称任何音色／自然度／听感结论**。
  `authenticationVerifiedThisRun` 为**本轮真实响应**所证；`capabilityVerified` / 音色适用性 / 长期额度 / 真实样本量**均未取得**。

---

## 1. 本轮范围与红线遵守

| 项 | 本轮实际 |
| --- | --- |
| 放行调用 | **恰好 1 次** TTS 正常调用（`TextToVoice`，合成短句，非个人） |
| 其它付费／联网请求 | **0**。未运行 `verify-tencent-live.mjs` / `verify-tokenhub.mjs` / `verify-deepseek.cjs` 的任何联网路径；未调用 `verify-tencent-identity.cjs` |
| 自动重试 | **0**（适配器 `maxRetries=0`，任何重发都需要新的授权与台账条目） |
| 凭据用法 | 只以**路径**出现；未 `cat`/`type`/`Get-Content` 该文件；证据中无任何令牌／密钥／AppSecret |
| 音频落盘 | **无**。产物字节只在内存中返回给调用方，本工具不写任何音频文件（替身路径也不产出音频） |
| 真实对象存储 | **未接线**（未链接，替身存储拒绝真实产物，见 §5.2） |
| 小程序／路由／`app.ts` | **未触碰**（`app.ts` 与 `routes/**` 仍属他人的阶段 2 接线） |

---

## 2. 交付物

| 文件 | 作用 |
| --- | --- |
| [live-ports.ts](../../services/api/src/tts/live-ports.ts) | 注入式端口：闸门、授权令牌、被校验配置快照、凭据三元组、fetch、时钟、取证钩子；「默认关闭」的机制 |
| [tc3.ts](../../services/api/src/tts/tc3.ts) | TC3-HMAC-SHA256 签名（与既有已审工具同口径的服务层独立实现） |
| [provider.ts](../../services/api/src/tts/provider.ts) | 真实分支：`createLiveTtsProvider(ports)`，顺序 build→reserve→sign→send→settle |
| [media.ts](../../services/api/src/tts/media.ts) | 替身存储拒绝 `substitute=false` 的真实产物；导出 MPEG/ID3 头嗅探 |
| [service.ts](../../services/api/src/tts/service.ts) | 本地入参拒绝（文本超限）落 `failed` + `INVALID_REQUEST`；其余语义不变 |
| [verify-provider-adapter-live.mjs](../../tools/verify-provider-adapter-live.mjs) | 手工装置：默认离线 dry run；付费路径三件齐备 + 台账护栏 |
| [tts-live-adapter.test.mjs](../../tests/unit/tts-live-adapter.test.mjs) | 14 条离线回归（默认关闭、剖面、顺序、签名绑定、错误映射、超时零重试、媒体硬化） |

---

## 3. 「默认关闭」如何成立（不是开关，是类型）

- 真实调用的全部向外能力收进 `RealTtsPorts`，**字段全部必填**（`fetchImpl`/`now`/`onObservation` 除外）。
- **应用装配路径没有端口参数**：`createRealTtsProvider(credentials)` 与
  `createTtsProvider({ executionMode: 'real' })` 的签名与实现**未改变**——
  缺凭据 ⇒ `available=false` ⇒ 受理前 503；凭据齐备 ⇒ `synthesize()` 仍返回 `PROVIDER_UNAVAILABLE`。
- 唯一入口 `createLiveTtsProvider(ports)` 只在手工装置里被调用；离线回归逐条断言上述等价性
  （`默认关闭·应用装配路径没有端口位置` 用例）。
- 构造期再做一层：剖面任一项不符（端点／超时 1000..20000／`maxRetries` ≠ 0／区域／音色／编码／
  采样率／文本上限）或凭据三元组不完整 ⇒ `TtsWiringError`，**绝不带着坏配置发包**。

---

## 4. 离线 dry run（零网络、零凭据、零账本）

命令与原始输出（`node tools/verify-provider-adapter-live.mjs --capability tts`）：

```
=== GY-I13 真实 TTS 适配器 · 离线 dry run（零网络、零凭据、零账本） ===
round_authorization=gy-adapter-round-20261012-cny2  mode=OFFLINE_DRY_RUN
config=/E:/GengYunCommander/GengYun_W8/docs/verification/config.local.json  configuration_issues=[]
fixtures: image_bytes=10053 wav_bytes=97804 image_sha_matched=true wav_sha_matched=true
fixtures_round=gy25-20261004-cny2  nonpersonal_synthetic=true（沿用 2026-10-04 轮合成夹具；TTS 只需合成文本）
adapter_providerVersion=tencent-tts-2019-08-23-voicetype101001  executionMode=real  available=true
profile: endpoint=https://tts.tencentcloudapi.com action=TextToVoice apiVersion=2019-08-23 region=ap-shanghai timeoutMs=8000 maxRetries=0 voiceType=101001 codec=mp3 sampleRate=16000 maxTextCharacters=100
--- 场景 [canned-success]（响应由**注入的假 JSON** 产生，不是任何真实供应商结果）---
  send_boundary_calls=1 method=POST redirect=manual bodyIsString=true bodyJsonParses=true signalIsAbortSignal=true
  url_literal_equal_allowlist_endpoint=true  encodedBodyBytes=192
  requestFields=["Codec","ModelType","PrimaryLanguage","SampleRate","SessionId","Speed","Text","VoiceType","Volume"]
  authorization_header_present=true scheme=TC3-HMAC-SHA256 tc3_scope=2023-11-14/tts/tc3_request signature_hex_len=64 credential_value_printed=false
  X-TC-Action=TextToVoice X-TC-Version=2019-08-23 X-TC-Region=ap-shanghai X-TC-Timestamp_is_integer=true x_tc_token_present=false
  observed: state=BUSINESS_RESPONSE httpStatus=200 requestId=4f1a2b3c-5d6e-7f80-9a0b-1c2d3e4f5061 providerErrorCode=null sessionEchoOk=true audioBytes=10 hasMpegHeader=true endpointAsserted=true sendAttempts=1
  mapped: kind=completed contentType=audio/mpeg substitute=false bytes=10
--- 场景 [canned-quota-error]（响应由**注入的假 JSON** 产生，不是任何真实供应商结果）---
  send_boundary_calls=1 method=POST redirect=manual bodyIsString=true bodyJsonParses=true signalIsAbortSignal=true
  url_literal_equal_allowlist_endpoint=true  encodedBodyBytes=192
  requestFields=["Codec","ModelType","PrimaryLanguage","SampleRate","SessionId","Speed","Text","VoiceType","Volume"]
  authorization_header_present=true scheme=TC3-HMAC-SHA256 tc3_scope=2023-11-14/tts/tc3_request signature_hex_len=64 credential_value_printed=false
  X-TC-Action=TextToVoice X-TC-Version=2019-08-23 X-TC-Region=ap-shanghai X-TC-Timestamp_is_integer=true x_tc_token_present=false
  observed: state=SERVICE_ERROR httpStatus=200 requestId=4f1a2b3c-5d6e-7f80-9a0b-1c2d3e4f5061 providerErrorCode=UnsupportedOperation.PkgExhausted sessionEchoOk=null audioBytes=null hasMpegHeader=null endpointAsserted=true sendAttempts=1
  mapped: kind=failed code=PROVIDER_QUOTA_EXCEEDED
--- 场景 [canned-session-mismatch]（响应由**注入的假 JSON** 产生，不是任何真实供应商结果）---
  send_boundary_calls=1 method=POST redirect=manual bodyIsString=true bodyJsonParses=true signalIsAbortSignal=true
  url_literal_equal_allowlist_endpoint=true  encodedBodyBytes=192
  requestFields=["Codec","ModelType","PrimaryLanguage","SampleRate","SessionId","Speed","Text","VoiceType","Volume"]
  authorization_header_present=true scheme=TC3-HMAC-SHA256 tc3_scope=2023-11-14/tts/tc3_request signature_hex_len=64 credential_value_printed=false
  X-TC-Action=TextToVoice X-TC-Version=2019-08-23 X-TC-Region=ap-shanghai X-TC-Timestamp_is_integer=true x_tc_token_present=false
  observed: state=RESPONSE_EVIDENCE_INCOMPLETE httpStatus=200 requestId=4f1a2b3c-5d6e-7f80-9a0b-1c2d3e4f5061 providerErrorCode=null sessionEchoOk=false audioBytes=10 hasMpegHeader=true endpointAsserted=true sendAttempts=1
  mapped: kind=failed code=PROVIDER_OUTCOME_UNKNOWN
--- 网络与台账断言 ---
scenarios=3 send_boundary_calls=3 reserves=3 settles=3
ledger_written=false fixtures_only_local=true
global_fetch_tripwire_triggered=false  (false = 全程未发出任何真实网络调用)
--- 结论 ---
DRY_RUN_RESULT=PASS  （装置可走到「即将发送」，全部断言成立；未发送、未读凭据、未写账本）
SCOPE=offline_only; no supplier was contacted; no budget consumed; no ledger written
```

**注**：`tc3_scope` 里的日期是注入的固定时钟（`1700000000`）对应的 UTC 日期，不是本轮真实日期；
三个场景的 `state`/`requestId`/`audioBytes` 全部来自**注入的假 JSON**，不是任何真实供应商结果。

---

## 5. 真实调用（**恰好 1 次**）

### 5.1 命令

```powershell
node tools/verify-provider-adapter-live.mjs --capability tts --manual-authorization gy-adapter-round-20261012-cny2 --credentials E:\GengYunPrivate\credentials.local.json
```

### 5.2 原始输出（打码；已确认不含任何凭据值）

```
=== GY-I13 真实 TTS 适配器 · 手工真实调用（恰好 1 次） ===
mode=MANUAL_LIVE round_authorization=gy-adapter-round-20261012-cny2
credentials_path=E:\GengYunPrivate\credentials.local.json  (仅路径；未读取打印任何值)
credential_fields_present: secretId=true secretKey=true sessionToken=false
config=/E:/GengYunCommander/GengYun_W8/docs/verification/config.local.json  configuration_issues=[]
fixtures: image_sha_matched=true wav_sha_matched=true nonpersonal_synthetic=true
ledger=/E:/GengYunCommander/GengYun_W8/.supervisor/provider-adapter-live/ledger.json  ceilingCny=2  entries_before=0  reservedCny_before=0
synthetic_text_code_points=10  locale=zh-CN  target_ref=answer/synthetic-live-probe#1
adapter_providerVersion=tencent-tts-2019-08-23-voicetype101001  available=true
--- 打码观测（真实响应）---
  state=BUSINESS_RESPONSE
  httpStatus=200
  requestId=2263d145-cec7-4f2e-ab92-04767a7cbbdf
  providerErrorCode=null
  sessionEchoOk=true
  audioBytes=8784
  hasMpegHeader=true
  resultMayHaveBeenProcessed=true
  elapsedMs=790
  endpointAsserted=true  sendAttempts=1
  mapped: kind=completed contentType=audio/mpeg substitute=false audited_not_saved=true
--- 台账 ---
  entries=1  reservedCny_total=0.003
  entry: capability=tts attemptKey=00000000-0000-4000-8000-00000000liv1:answer/synthetic-live-probe#1 reservedCny=0.003 state=BUSINESS_RESPONSE actualChargeCny=null providerErrorCode=null
  platformHardCapVerified=false  taskVerified=false  qualityEvidence=false
=== exit code: 0 ===
```

- `audited_not_saved=true` 的含义：产物字节只在内存中返回给调用方，**未落盘、未入对象存储**；
  本工具没有任何保存音频的代码路径。
- `sendAttempts=1` 由适配器自己计数（真实注入的是 `globalThis.fetch`，**无假 fetch、无绊线**）；
  进程锁在本轮结束后已释放（`.supervisor/provider-adapter-live/process.lock` 不存在）。

### 5.3 台账条目原文（`.supervisor/provider-adapter-live/ledger.json`，**gitignored**）

```json
{
  "authorization": "gy-adapter-round-20261012-cny2",
  "authorizationVersion": "1",
  "ceilingCny": 2,
  "currency": "CNY",
  "reservedCny": 0.003,
  "entries": [
    {
      "capability": "tts",
      "attemptKey": "00000000-0000-4000-8000-00000000liv1:answer/synthetic-live-probe#1",
      "reservedCny": 0.003,
      "reservedAt": "2026-10-12T06:53:37.543Z",
      "state": "BUSINESS_RESPONSE",
      "actualChargeCny": null,
      "providerErrorCode": null,
      "resultMayHaveBeenProcessed": true,
      "settledAt": "2026-10-12T06:53:38.335Z"
    }
  ]
}
```

- 台账护栏：ceiling **¥2**、条目 **≤11**、每能力 **≤2**、reserve-then-send、进程锁（`wx`，崩溃留锁不自动恢复）、
  **不自动重试**、`actualChargeCny: null`（未取得账单，不编造金额）。
- 本轮使用**新台账 + 新常量** `gy-adapter-round-20261012-cny2`；**未复用** 2026-10-04 轮的
  `gy25-20261004-cny2` 系列标签。

---

## 6. 本轮观测到的安全属性（逐条与实现对应）

| 属性 | 证据 |
| --- | --- |
| 端点唯一来源 + 发送前再断言 | dry run `url_literal_equal_allowlist_endpoint=true`；真实响应 `endpointAsserted=true` |
| 签名绑定实际发出的字节 | 假 fetch 捕获的 `body` 字符串被测试侧**独立复算**的 TC3 签名逐字匹配；`bodyIsString=true`（无二次序列化） |
| 区域恒取被校验配置 | `X-TC-Region=ap-shanghai`（dry run 与真实调用一致） |
| 禁止跟随重定向 | `redirect=manual` |
| 超时取被校验配置 + 零重试 | `AbortSignal.timeout(timeoutMs)`；离线用例在 1000ms 上证明超时确实生效，且 `sendAttempts=1` |
| 供应商原始错误码原样落账 | 映射用例 15 个码逐个断言 `providerErrorCode` 原文保留；供应商消息**不进**落账内容 |
| 证据不完整不得当成功 | SessionId 不匹配 / RequestId 缺失或格式非法 / Audio 非 MPEG 头 ⇒ `OUTCOME_UNKNOWN`，不落 succeeded |
| 本地拒绝不占预算 | 文本 101 码点 ⇒ 适配器抛 `TtsLocalInputError('INVALID_REQUEST')`，**reserve 0 次、fetch 0 次** |
| 真实产物不得伪装成替身 | 替身存储对 `substitute=false` 返回 `OBJECT_UNAVAILABLE`；真实调用返回 `substitute=false` + `audio/mpeg` |

---

## 7. 明确**未验证**项（不得外推）

1. **不验证音色、自然度、听感、适老性、方言/多音字读法**：真实 TTS 样本数为 **0**
   （[样本缺口登记](../evaluation/sample-gap-register.md) 要求 30 段），本轮 1 次可达性调用**不是样本**，
   也不构成任何质量结论；`humanPlaybackVerified=false`，未在真机或任何播放器上播放过该音频。
2. **不验证数字／单位／否定词／条件的读法正确性**（TTS 六项判定全部**未测**）。
3. **不验证 ASR／OCR／文本与图片审核／LLM**：本轮未调用其中任何一项。
4. **不验证长期额度、资源包适用音色、有效期、后付费状态**：只观测到本次调用被接受
   （`BUSINESS_RESPONSE`，无 `Response.Error`）；**一次成功不能证明额度充足或计费方式**。
5. **不验证账单**：`actualChargeCny=null`（¥0.003 是本装置的**保守预留额**，不是账单金额）。
6. **不验证应用端到端**：适配器接线**未**接入 `app.ts`／路由／小程序；
   `createSynthesisService` 的 real 模式仍需真实对象存储与真实已核对内容源，本片两者均未接线。
7. **不验证并发／配额边界在真实供应商侧的行为**：本轮只有 1 次调用。

### 与 2026-10-04 轮的关系（如实区分）

真实可达性**在 2026-10-04 轮已由独立装置取得**（[真实调用证据](tencent-live-evidence.md)：
`TextToVoice` 返回 `Audio`/`SessionId`/`RequestId`，8784 字节，本地解码为 16 kHz 单声道 PCM）。
**本轮是首次经「我们自己的适配器」取得**：签名、端点断言、超时、零重试、回显校验、
MPEG 头硬化校验与预算闸门全部由本分支的代码路径完成，且由本文件给出原始输出。
两次的字节数相同（8784）属**同音色 + 同合成短句**的常见结果，**不作**任何等价性或质量推断。

---

## 8. 未取得项 / 需裁定

1. `docs/verification/config.local.json` 与 `.supervisor/**` 均**本机忽略、不入仓**：换机器复现需要重新交接
   本地配置与合成夹具；本文件记录的是**本轮这台机器**的结果。
2. 方案 §2.6 表中 `InvalidParameter*` / `MissingParameter` 映射到 `PROVIDER_OUTCOME_UNKNOWN`（而非 400）是
   方案作者的判断，本实现照做；**待监工裁定**。
3. 方案建议的 MPEG/ID3 头硬化校验已实现（超出现有 `requireSynthesisArtifact` 的冻结校验范围），
   属**加强**而非契约要求，请一并复核。
4. 真实调用**未**经过 service 的「只播报经核对内容」判定（手工装置直接调用适配器，输入为固定合成短句）：
   这是装置定位，不是产品路径；产品路径的端到端接线属阶段 2。
5. 契约没有 TTS 文本上限；`maxTextCharacters=100` 来自被校验配置（供应商侧口径），不是契约条文。
6. 本轮未接真实对象存储，因此**即使真实合成成功也不会落库**；`Synthesis.media_id` 的真实存储语义仍未取得。

---

## 9. 门禁（最终 HEAD 上实跑，原始输出见 PR/汇报）

- `npm run lint`：PASS（`tsc --noEmit` 两个 workspace + 仓库卫生扫描）
- `npm run test:unit`、`npm run test:contract`、`npm run test:docs`：见本轮汇报的原始输出
- `node --test "tests/unit/tts*.test.mjs"`：88 条全绿（既有 74 条不受影响 + 新增 14 条）

本文件**不宣布验收通过**，也不关闭整项 #13。
