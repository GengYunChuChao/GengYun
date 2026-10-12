# 真实供应商适配器接线方案（GY-I10 OCR / GY-I11 ASR / GY-I13 TTS · 阶段 0）

- 分支：`chore/provider-adapter-live-prep`（worktree `E:\GengYunCommander\GengYun_W10`）
- 基线：`upstream/main = d5562923`（`git fetch upstream --prune` 后复核，与本地 HEAD 一致）
- 性质：**方案 + 骨架**。本阶段**零付费、零联网**，未向任何供应商发出请求。
- 口径声明：本文件**不宣布验收通过**，**不声称**任何能力"已接入真实供应商"或"已验收"。
  所有 `authenticationVerifiedThisRun` / `serviceActivationVerified` / `quotaVerified` /
  `capabilityVerified` / `policySelectionVerified` 仍为 `false`。

---

## 0. 前置事实核对（先纠正三处与派单描述不一致之处）

| 派单表述 | 实测事实 |
| --- | --- |
| 适配器在 `services/api/src/{ocr,speech,tts}/provider.ts` | **不在本基线**。`upstream/main` 的 `services/api/src/` 只有 auth/db/knowledge/privacy/profile/routes。三个适配器分别在**未合并**的在途分支：W5 `feat/gy-i10-label-ocr`、W7 `feat/gy-i11-speech-pipeline`、W8 `feat/gy-i13-synthesis`（均已 `git worktree` 占用） |
| "参考**已合并**同类：`services/api/src/recognitions/provider.ts`" | **未合并**。该文件在 W4 分支 `feat/gy-i09-identify-loop`，`upstream/main` 上不存在 |
| "不得接进 `npm test`" | 根 `package.json` **没有 `test` 脚本**；实际入口是 `test:unit` / `test:contract` / `test:evaluation` 等，CI 在 `.github/workflows/engineering-shell.yml` 与 `access-verification.yml` |

**由此产生的交付约束**：本分支上不存在 `{ocr,speech,tts}/provider.ts`，若在其路径新建文件会与 W5/W7/W8 的在途 PR 直接冲突，且会被 `engineering-shell.yml` 的 `build`（`tsc -p services/api/tsconfig.json`）与 `lint` 收集。因此本阶段把**骨架以代码块形式交付在本文件内**，不落到目标路径。理由与替代方案见 §7 与 §8。

---

## 1. 三个 `real` 分支的现状口径（保持不变的底线）

三个适配器当前一致实现 **fail-closed**，本方案**不放松**任何一条：

1. 缺 `endpoint`/`apiKey` ⇒ `available = false`，受理前即 503 `PROVIDER_UNAVAILABLE`，**不排队、不回退替身**。
2. 即使凭据齐备 ⇒ `extract`/`transcribe`/`synthesize` 仍返回 `PROVIDER_UNAVAILABLE`（没有已审真实适配器）。
3. 任何路径都不静默回退 stub / preset_demo（回退会污染证据口径）。
4. 提供者**只**产出原始载荷：不决定 `MatchState`（OCR）、不决定任务终态（ASR/TTS）、不产出用量卡。
5. 失败码闭集恒为 4 个契约码：`PROVIDER_TIMEOUT` / `PROVIDER_QUOTA_EXCEEDED` /
   `PROVIDER_OUTCOME_UNKNOWN` / `PROVIDER_UNAVAILABLE`（取自 `services/api/src/contract.ts`
   的 `ERROR_STATUS_MAP`：504 / 429 / 503 / 503）。**不得**把提供者失败写成 `succeeded`。

---

## 2. 共同接线骨架

### 2.1 依赖注入端口 —— "真实分支默认关闭"的机制

把真实分支的全部向外能力收进一个注入式端口对象。**应用装配路径永不提供该对象**，于是
`createOcrProvider({ executionMode: 'real' })` 的行为与今天**逐字节相同**（fail-closed）；
只有独立手工验证工具才构造端口。这样"默认关闭"不是靠一个容易忘的开关，而是靠**类型上就没有默认实现**。

```ts
// services/api/src/live/ports.ts（新增，骨架）
import type { ErrorCode } from '../contract.ts';

/** 真实调用只允许这三个能力进入（本阶段范围）。 */
export type LiveCapability = 'ocr' | 'asr' | 'tts';

/** 闸门放行凭据。字段只含"已预留多少"，不含任何密钥。 */
export interface LiveCallTicket {
  readonly capability: LiveCapability;
  readonly authorization: string;
  readonly reservedCny: number;
  readonly attemptKey: string;
}

export type LiveGateRefusal =
  /** 未提供显式授权令牌，或令牌与台账不一致 ⇒ 真实分支等价于"未接线"。 */
  | 'AUTHORIZATION_REQUIRED'
  /** 台账文件/进程锁缺失或不可读 ⇒ 拒绝（绝不"先发了再记"）。 */
  | 'LEDGER_UNAVAILABLE'
  /** 超出总额/总次数/每能力次数上限。 */
  | 'BUDGET_OR_COUNT_EXCEEDED'
  /** 同一次尝试已预留过 ⇒ 拒绝重发（防重复计费）。 */
  | 'ATTEMPT_ALREADY_RESERVED';

export class LiveGateRefusedError extends Error {
  constructor(readonly refusal: LiveGateRefusal, message: string) {
    super(message);
    this.name = 'LiveGateRefusedError';
  }
}

/**
 * 预算/台账闸门。**每次调用前必过**，且必须在任何签名与建连之前。
 * reserve-then-send：先落账（含"结果未知"），再发包 —— 崩溃只会留下已预留记录，
 * 绝不会留下"扣了钱但没记账"的调用。
 */
export interface LiveCallGate {
  reserve(input: { capability: LiveCapability; authorization: string | null; attemptKey: string }): Promise<LiveCallTicket>;
  /** 无论成败都调用；`actualChargeCny` 未知时必须落 null，绝不猜一个数。 */
  settle(ticket: LiveCallTicket, outcome: {
    state: ProviderCallState;
    actualChargeCny: number | null;
    providerErrorCode: string | null;
    resultMayHaveBeenProcessed: boolean;
  }): Promise<void>;
}

/** 已入库媒体字节的读取端口。真实分支**只从**这里取字节，不接受任何客户端直传或远程 URL。 */
export interface MediaResolver {
  resolve(input: { mediaId: string; mediaRevision: number }): Promise<{ bytes: Uint8Array; contentType: string }>;
}

export interface RealProviderPorts {
  readonly liveGate: LiveCallGate;            // 必填：没有闸门就不构造真实分支
  readonly authorization: string;             // 显式授权令牌（与台账 authorization 常量逐字一致）
  readonly mediaResolver: MediaResolver;
  /** 仅手工验证工具注入（可注入假函数以证明"走到即将发送"）；应用装配永不注入。 */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}
```

### 2.2 调用顺序（**顺序本身是安全属性**）

```
build(本地)  →  reserve(闸门)  →  sign(TC3)  →  send(恰好一次)  →  settle(无论成败)
```

- **build 在 reserve 之前**：媒体校验与请求体序列化是纯本地操作。若先预留再发现媒体非法，
  就得"撤销预留"，而现有台账模型（`tools/verify-tencent-live.mjs` 的 `reserve()`）没有撤销语义，
  硬造一个会打开"少记账"的口子。放前面可让"拒绝了但没发"完全不留账。
- **reserve 在 sign/send 之前**：签名与建连之间崩溃，留下的必须是"已预留"而不是"已花钱"。
- **settle 必调**：失败路径同样落账，`state` 取实际观测，`actualChargeCny` 未知时落 `null`。
- **send 恰好一次**：`maxRetries` 契约锁定为 `0`。任何重发都是**一次新的预留**，需要新的授权与台账条目。

### 2.3 TC3 签名（沿用已被 `tests/tencent-live.test.mjs` 覆盖的既有实现）

签名算法与 `tools/verify-tencent-live.mjs:signRequest()` 完全一致（已审、已有离线回归）：

- `service = new URL(endpoint).hostname.split('.')[0]`；`host = <service>.tencentcloudapi.com`
- 规范请求：`POST\n/\n\ncontent-type:application/json\nhost:<host>\n\ncontent-type;host\n<sha256(body)>`
- `scope = <UTCDate>/<service>/tc3_request`
- 待签串：`TC3-HMAC-SHA256\n<timestamp>\n<scope>\n<sha256(canonical)>`
- `signingKey = HMAC(HMAC(HMAC('TC3'+SecretKey, date), service), 'tc3_request')`
- 请求头：`Content-Type` / `Host` / `Authorization: TC3-HMAC-SHA256 Credential=<SecretId>/<scope>, SignedHeaders=content-type;host, Signature=<hex>` / `X-TC-Action` / `X-TC-Version` / `X-TC-Region` / `X-TC-Timestamp`，临时凭据再带 `X-TC-Token`

**接线必须点明的三个坑**：

1. **签名绑定的是实际发出的那串字节**。因此适配器必须**先序列化一次得到字符串**，
   同一字符串既用于签名也用于 `init.body`；**绝不允许** HTTP 客户端二次 `JSON.stringify`（键序/空格会变，签名即失效）。
2. **`X-TC-Region` 恒为 `ap-shanghai`**，取自被校验过的配置（`configurationIssues` 已锁 `region === 'ap-shanghai'`），不取调用方入参。
3. **凭据三元组同源**。ASR 使用**专用**配对 `TENCENTCLOUD_ASR_SECRET_ID` / `TENCENTCLOUD_ASR_SECRET_KEY`，
   只读 `TENCENTCLOUD_ASR_SESSION_TOKEN`；其余 TC3 端点用共享配对，只读 `TENCENTCLOUD_SESSION_TOKEN`。
   **不逐字段混配、不回退**（与 `resolveTc3Credentials()` 的既有口径一致；长期专用密钥无 token 时明确为空，不继承共享 token）。

### 2.4 端点白名单与重定向

- 目标 URL **只**取自 `tools/ai-config.mjs` 的 `AI_ENDPOINTS[key].endpoint`，并在发送前再断言
  `new URL(url).host === expectedHost && url === spec.endpoint`（无 query、无附加 path）。
- `redirect: 'manual'`：**禁止**跟随任何重定向，否则签过名的请求（含 `Authorization`）会被送到白名单外的主机。
- 配置侧 `configurationIssues()` 的 `ENDPOINT_NOT_ALLOWLISTED` 已挡一层；适配器再挡一层（纵深防御）。

### 2.5 超时与零重试

- `signal: AbortSignal.timeout(provider.timeoutMs)`，取值来自被校验过的配置（`1000..20000`），
  **不采用调用方传入的超时**。
- 不实现任何退避、重试、幂等重发。`maxRetries !== 0` 时适配器应拒绝构造（配置侧已判 `AUTOMATIC_RETRIES_DISABLED_REQUIRED`）。

### 2.6 错误码 → 契约 `ErrorCode` 映射

`ProviderCallState` 为适配器内部观测态；右侧是**唯一允许**的契约码（闭集 4 个失败码 + 本地入参码）。

| 观测 | 映射 | HTTP | 理由 / 落账 |
| --- | --- | --- | --- |
| 闸门拒绝：`AUTHORIZATION_REQUIRED` / `LEDGER_UNAVAILABLE` | `PROVIDER_UNAVAILABLE` | 503 | 等价于"未接线"。**未发包，不占预算**，不落账 |
| 闸门拒绝：`BUDGET_OR_COUNT_EXCEEDED` | `PROVIDER_QUOTA_EXCEEDED` | 429 | 本地额度闸门，与供应商配额同语义码 |
| 闸门拒绝：`ATTEMPT_ALREADY_RESERVED` | `PROVIDER_OUTCOME_UNKNOWN` | 503 | 结果不可判定；**绝不自动重发** |
| 本地媒体校验失败（图像头/尺寸/WAV 规格/文本上限） | 不入失败码；由 service 落 `INVALID_REQUEST` / `MEDIA_TOO_LARGE` / `MEDIA_TYPE_UNSUPPORTED` | 400/413/415 | 是我们自己的入参问题，不是供应商故障；**未发包，不占预算** |
| `AbortError` / 超时 | `PROVIDER_TIMEOUT` | 504 | 落账 `actualChargeCny: null` + `resultMayHaveBeenProcessed: true`（超时不等于未计费） |
| 传输层失败（DNS/TLS/连接重置/无响应） | `PROVIDER_OUTCOME_UNKNOWN` | 503 | 无法判定是否已被处理 ⇒ 不声称"干净失败" |
| HTTP 5xx | `PROVIDER_OUTCOME_UNKNOWN` | 503 | 同上 |
| HTTP 200 但 `Response.Error.Code` = `ResourceUnavailable.ResourcePackageRunOut` / `UnsupportedOperation.PkgExhausted` / `RequestLimitExceeded*` / `LimitExceeded*` | `PROVIDER_QUOTA_EXCEEDED` | 429 | 配额/限流类 |
| `Response.Error.Code` = `AuthFailure.*` / `UnauthorizedOperation.*` / `InvalidCredential` / `FailedOperation.UnOpenError` / `FailedOperation.UserNotRegistered` | `PROVIDER_UNAVAILABLE` | 503 | 账号/服务/凭据不可用；**对外不区分是哪一种**（避免泄露账号状态） |
| `Response.Error.Code` = `InvalidParameter*` / `MissingParameter` | `PROVIDER_OUTCOME_UNKNOWN` | 503 | **判断依据**：适配器的 body 由服务端从已校验媒体构造，参数错说明是**我们的适配器缺陷**，把它映射成 400 会把责任错误地推给客户端。故按"结果不可判定"处理并留内部诊断（**待监工裁定**，见 §8-4） |
| `Response.Error.Code` = `InternalError*` / `FailedOperation.ServiceIsolate` / 未知码 | `PROVIDER_OUTCOME_UNKNOWN` | 503 | 未知即不声称可用，也不声称是干净失败 |
| HTTP 200 但 payload 形状非法 / `RequestId` 缺失 | `PROVIDER_OUTCOME_UNKNOWN` | 503 | **供应商确实干活了（可能已计费）却没给出可用证据** ⇒ 必须落"结果未知"，不得当成功 |

### 2.7 证据口径（不得越界声称）

真实适配器上线后，**仍然**不产出、不声称：

- OCR：`MatchState`、剂量卡、准确率。真实标签样本数仍为 0（`docs/evaluation/sample-gap-register.md`）。
- ASR：识别准确率、说话人结论。真实语音样本数为 0。
- TTS：音色质量、自然度、听感结论。真实 TTS 样本数为 0；**不生成任何个人处方、混配或自动剂量换算**。

---

## 3. 逐适配器接线

### 3.1 OCR（`feat/gy-i10-label-ocr:services/api/src/ocr/provider.ts`）

**输入**：`extract({ jobId, mediaId, mediaRevision })` —— 无字节入参，必须经 `MediaResolver` 取。
**调用**：`GeneralAccurateOCR` / `2018-11-19`（TC3，共享凭据对，`region=ap-shanghai`，`timeoutMs=8000`）。
**响应**：`Response.RequestId` + `Response.TextDetections[].DetectedText`（**纯文本行**）。

**关键缺口（必须由指挥/监工决策，不能由写手私自补）**：
`OcrProvider.extract` 的产出是结构化 `fields = { registration_number, name, ingredients[], dosage_form }`，
而 `GeneralAccurateOCR` 只给**文本行**。二者之间需要一个新的 **标签字段抽取层**（规则式或 LLM 式），
该组件在阶段 1 不存在（阶段 1 的替身是**直接编造** `fields`，不是从文本解析）。所以：

- OCR 的"真实接线"**不是**接一个 HTTP 客户端就完事，它依赖一个**新的、尚未验证的解析组件**；
- 该解析组件**不得**决定 `MatchState`（那是 `ocr/state.ts` 的 `decideMatchState` 的职责），只产出候选字段，由 service 校验；
- 若走 LLM 抽取，会额外引入 DeepSeek 端点与它自己的预算闸门（**本阶段不申请**）。

**骨架**（局部；`real` 分支默认关闭的写法见 §2.1）：

```ts
/** 从 OCR 文本行抽取标签候选字段。产出**未校验**的候选，绝不决定 MatchState。 */
export interface LabelFieldExtractor {
  extract(input: { lines: readonly string[]; jobId: string }): Promise<unknown>;
}

export function createRealOcrProvider(ports: RealProviderPorts | null, extractor: LabelFieldExtractor | null = null): OcrProvider {
  if (ports === null || extractor === null) {
    // 与今天逐字节相同：无端口/无抽取层 ⇒ fail-closed，且 available=false 只在缺 endpoint/apiKey 时
    return unconfiguredRealOcrProvider();
  }
  const endpoint = AI_ENDPOINTS.ocr.endpoint; // 白名单唯一来源
  return {
    executionMode: 'real',
    modelVersion: 'ocr-generalaccurate-2018-11-19',
    available: true,
    unavailableReason: null,
    async extract({ jobId, mediaId, mediaRevision }) {
      // ① build（本地）
      const { bytes } = await ports.mediaResolver.resolve({ mediaId, mediaRevision });
      assertImageHeaderAndSize(bytes);                    // 复用 ai-config.mjs 的 imageInfo 口径
      const body = JSON.stringify({ ImageBase64: Buffer.from(bytes).toString('base64') });
      // ② reserve（闸门，必须在签名/建连之前）
      let ticket;
      try {
        ticket = await ports.liveGate.reserve({ capability: 'ocr', authorization: ports.authorization, attemptKey: `${jobId}:${mediaRevision}` });
      } catch (err) {
        return { kind: 'failed', code: gateRefusalToErrorCode(err) }; // 见 §2.6 表
      }
      // ③ sign ④ send（恰好一次）⑤ settle
      const result = await sendOnce(ports, { endpoint, action: 'GeneralAccurateOCR', apiVersion: '2018-11-19', body, timeoutMs: 8000, service: 'ocr' });
      await ports.liveGate.settle(ticket, toLedgerOutcome(result));
      if (result.state !== 'BUSINESS_RESPONSE') return { kind: 'failed', code: mapCallState(result) };
      // 如实上报：只把文本行交给抽取层；抽取层产出候选，MatchState 由 state.ts 判
      return { kind: 'completed', fields: await extractor.extract({ lines: result.detectedTexts, jobId }) };
    },
  };
}
```

### 3.2 ASR（`feat/gy-i11-speech-pipeline:services/api/src/speech/provider.ts`）

**输入**：`transcribe({ jobId, mediaId, mediaRevision })`。
**调用**：`SentenceRecognition` / `2019-06-14` / `EngSerViceType='16k_zh'` / `SourceType=1` / `VoiceFormat='wav'`，
**专用凭据对**（`TENCENTCLOUD_ASR_SECRET_ID` / `_KEY`），`timeoutMs=10000`。
**响应**：`Response.RequestId` + `Response.Result`（带标点的整句）。

**必过的本地校验**（与离线口径逐项相同，直接复用 `ai-config.mjs` 的 `checkedWav`）：
PCM(1) / 单声道 / 16000 Hz / 16-bit / `dataLength` 偶数 / `≤60s` / Base64 ≤ 3 MiB（`4*ceil(n/3) ≤ 3145728`）。
**不得隐式转码**：不符合规格即 fail-closed，不重采样、不转码（转码会改变证据含义）。

**产出映射**：

| 观测 | 产出 |
| --- | --- |
| `Result` 非空 | `{ kind:'completed', transcript:{ text: Result, uncertain_spans: [] } }` |
| `Result` 空 / 只有空白 | `{ kind:'uncertain', reason:'供应商标注无可识别语音' }` —— **不编造文本** |
| 失败（见 §2.6） | `{ kind:'failed', code }` |

> **语义张力（须裁定，见 §8-3）**：阶段 1 的适配层约定要求 `text` 与 `uncertain_spans` **两键都显式出现**，
> 且"不得补造"。但 `SentenceRecognition` **不返回**任何 span 级置信度。写 `uncertain_spans: []`
> 等于声称"没有不确定区间"，而供应商其实**没有提供**这个信息。两种候选口径：
> (a) `[]` + 在 `note`/内部记录里写明"空数组表示供应商未提供区间置信度，不代表不存在"；
> (b) 供应商未提供置信度时返回 `{ kind:'uncertain' }`——但这会把**正常可用**的转写判成不确定态，过度保守。
> 本方案**不预选**，交由指挥/监工按证据口径裁定。

### 3.3 TTS（`feat/gy-i13-synthesis:services/api/src/tts/provider.ts`）

**输入**：`synthesize({ jobId, text, locale, targetRef })` —— `text` 是服务端从**已核对（auditState='approved'）**
内容读出的正文（`tts/state.ts:decideCheckedContent` 已判），提供者**不接受任何客户端文本**。
**调用**：`TextToVoice` / `2019-08-23` / `VoiceType=101001` / `Codec='mp3'` / `SampleRate=16000`，
共享凭据对，`timeoutMs=8000`。
**响应**：`Response.RequestId` + `Response.SessionId`（回显请求的 `SessionId`）+ `Response.Audio`（base64 mp3）。

**产出映射**：
- 先校验 `result.SessionId === request.body.SessionId`（沿用既有手工工具的口径），否则
  `{ kind:'failed', code:'PROVIDER_OUTCOME_UNKNOWN' }`（供应商确实合成了，但证据不完整 ⇒ 不声称成功）。
- `Audio` 非空且是合法 base64（`/^[A-Za-z0-9+/]+={0,2}$/`、长度有界）⇒
  `{ kind:'completed', artifact:{ contentType:'audio/mpeg', body: Buffer.from(Audio,'base64'), substitute:false } }`。
  - `substitute:false` + `audio/*` 可**合法**通过 `requireSynthesisArtifact()` 的"替身不得伪装成真实音频"检查
    （该检查只在 `substitute===true` 时禁止 `audio/*`）。
  - `Buffer` 是 `Uint8Array` 子类，满足 `body instanceof Uint8Array`。
- **建议硬化（超出冻结校验器，需指挥同意）**：对解出的字节再查 MPEG/ID3 头（`ID3` 或 `0xFF 0xEx`），
  避免把一段错误 JSON/HTML 当音频落库。`requireSynthesisArtifact` 目前**不**校验载荷是否为真音频。
- **文本上限**：契约**没有**规定可合成文本长度（`tts/state.ts` 已如实登记为契约缺口）。
  配置侧锁定 `maxTextCharacters: 100`（供应商侧口径）。适配器据此**fail-closed**：超限即
  `INVALID_REQUEST`，**不截断**（截断会改变要朗读的正文含义）。
- **配额风险**：`VoiceType=101001` 是精品音色，依赖资源包或后付费。上一轮先遇
  `UnsupportedOperation.PkgExhausted`，用户确认后第二次才成功。真实调用**可能再次**返回配额类错误。

---

## 4. 在独立手工验证工具里预留执行入口

**不改动** `tools/verify-tencent-live.mjs`（它是上一轮已审、且被 `access-verification.yml`
`node --check` + `tests/tencent-live.test.mjs` 覆盖的付费路径装置）。预留方式：

新增**独立**工具 `tools/verify-provider-adapter-live.mjs`（阶段 1 落地，本阶段只留设计）：

- **默认（无 `--manual-authorization`）= 纯离线 dry run**：
  用 §2.1 的端口构造真实适配器，`fetchImpl` 注入**假函数** + `globalThis.fetch` 换成绊线，
  断言"走到即将发送且未发送"。**不读凭据、不发包、不落账**。
- **付费路径只在此工具、且需三件同时具备**：`--manual-authorization <令牌>` + 与台账逐字一致的
  `authorization` 常量 + 已存在的 `ledger.json`。缺一即 `MANUAL_AUTHORIZATION_REQUIRED`。
- 复用既有台账模型：ceiling ¥2 / ≤11 条 / 每能力 ≤2 次（`weedRecognition` ≤1）/ reserve-then-send /
  进程锁 / 不自动重试 / 只用 `.supervisor/gy25-live/` 固定合成夹具（manifest 三字段 + 双 SHA-256 核对）。
- **CI 隔离**：本工具**不得**被任何 workflow 引用，也**不得**进 `test:*` 套件；将来若纳入
  `access-verification.yml`，只允许加 `node --check` 与离线 dry-run 两组，**禁止**任何带凭据的执行步骤。

本阶段已用**等价离线自检**验证了该入口的形状（注入假 fetch + 绊线，6/6 端点走到"即将发送"），
脚本位于忽略目录 `.supervisor/gy25-live/offline-selfcheck.mjs`。

---

## 5. 建议每能力调用次数

约束（配置侧已锁）：每端点 `maxVerificationCalls = 2`；台账 ceiling ¥2、总条数 ≤11、非识草 ≤10、每能力 ≤2。

| 能力 | 正常 1 次 | 受控失败 1 次 | 能力小计 | 说明 |
| --- | --- | --- | --- | --- |
| ASR（#11） | 1 | 1 | **2** | 最小成本，先跑通"重建 WAV + 专用凭据 + 签名" |
| TTS（#13） | 1 | 1 | **2** | 精品音色配额状态未知，正常这次同时验配额 |
| OCR（#10） | 1 | 1 | **2** | 单价最高；且**真实字段抽取层未决**，本次只验到 `TextDetections` |
| 合计 | 3 | 3 | **6** | 未申请 `llm` / `weedRecognition` / `moderation*` |

**标注**：受控失败用例（`--controlled-failure`：OCR 塞非法 base64、ASR 塞非法 `VoiceFormat`、TTS 塞空 `Text`）
仍按满额预留计账（`tools/verify-tencent-live.mjs` 的 `PRICES` 口径），因为被拒的请求不保证零计费。

---

## 6. 待批准的真实调用清单

**单价来源必须说明**：下表单价来自 `tools/verify-tencent-live.mjs` 的 `PRICES` 常量，是**保守预留额**，
**不是**已核实的供应商目录价，也不是实际账单金额（`actualChargeCny` 在既有台账中恒为 `null`）。

| # | 能力 | 次数 | 预留单价 (CNY) | 预留小计 (CNY) | 合成输入 | 期望观测 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | ASR 正常 | 1 | 0.0032 | 0.0032 | `synthetic-speech.wav`（16k 单声道 PCM16，3.055 s，「你好，这是语音测试。」），SHA-256 `1f4952f2…` | HTTP 200；无 `Response.Error`；`RequestId` 存在且格式合法；`Result` 去空白/标点后 === `你好这是语音测试` |
| 2 | ASR 受控失败 | 1 | 0.0032 | 0.0032 | 同上但 `VoiceFormat` 改为非法值 | HTTP 200 + `Response.Error.Code` ∈ 参数/非法请求类；**必须不是** `BUSINESS_RESPONSE` |
| 3 | TTS 正常 | 1 | 0.0030 | 0.0030 | 固定合成短句（≤100 码点，非个人）`SessionId='gy25-offline'` | HTTP 200；`SessionId` 回显一致；`Audio` 非空合法 base64；解出字节 > 0 且有 MPEG/ID3 头 |
| 4 | TTS 受控失败 | 1 | 0.0030 | 0.0030 | 同上但 `Text` 置空 | HTTP 200 + `Response.Error.Code`（参数类）；不得产出音频 |
| 5 | OCR 正常 | 1 | 0.5000 | 0.5000 | `synthetic.png`（480×240 白底 msyhbd 绘制），SHA-256 `fc4c1594…` | HTTP 200；无 `Error`；`RequestId` 合法；`TextDetections` ≥ 1；`DetectedText` 拼接归一化后 === `合成测试你好编号12345` |
| 6 | OCR 受控失败 | 1 | 0.5000 | 0.5000 | 同上但 `ImageBase64` 替换为非法串 | HTTP 200 + `Response.Error.Code`（图像/参数类）；不得返回 `TextDetections` |
| | **合计** | **6** | | **1.0124** | | 全部使用 `.supervisor/gy25-live/` 内固定合成夹具，无任何真实个人媒体 |

**本清单明确不申请**：
- `weedRecognition`（TokenHub 视觉，属 #27/#25 另一条线）；
- `llm`（DeepSeek）、`moderationText` / `moderationImage`（**后者被真实 BizType 缺失阻塞**，见 §8-1）；
- 任何真机、任何用户媒体、任何重试、任何超出 2 次/能力的追加。

**建议分批**：先放行 #1–#3（≈¥0.5062），核验台账与实际观测后再决定是否放行 #4–#6；
不建议一次放行全部 6 次（OCR 单价是 ASR 的 156 倍）。

**放行前指挥需确认的三件事**：
1. 轮次预算与上表 6 次/¥1.0124 是否一致；
2. OCR 的"真实字段抽取层"是否纳入本轮（不纳入则 #5/#6 只验到 `TextDetections`，不构成 OCR 能力证据）；
3. `uncertain_spans: []` 与 BizType 占位值两处口径（§8-1、§8-3）如何裁定。

---

## 7. 本阶段已交付 / 未交付

**已交付（本分支，本地 commit）**
- `docs/verification/config.local.json`（**gitignored，不入仓**）：逐项对齐 `configurationIssues()` 全部要求。
- 本文档：三适配器接线方案 + 骨架 + 错误码映射 + 待批准调用清单。
- 离线审计实跑（7/7 端点 `parameterConfigurationComplete` 且 `credentialPresent`，`budgetLocked:true`，exit 0）。
- `.supervisor/gy25-live/`（**gitignored**）：`synthetic.png`、`synthetic-speech.wav`、`synthetic-manifest.json`、
  `fixture-text.json`、`offline-selfcheck.mjs`。

**未交付（及原因）**
- 未把骨架落到 `services/api/src/{ocr,speech,tts}/provider.ts`：本分支不存在这些文件，且在途 PR（W5/W7/W8）占用其路径；新建会冲突，且会被 `build`/`lint` 收集。需指挥决定落地分支。
- 未做任何真实调用（本阶段红线）。
- 未解决 OCR 字段抽取层与 `uncertain_spans` 语义。

---

## 8. 未解缺口 / 需要决策的问题

1. **真实 BizType 缺失（阻塞 moderation 真实调用）**：`E:\GengYunPrivate\credentials.local.json`
   的字段仅为 `appid / appsecret / deepseekApiKey / tencentAsrSecretId / tencentAsrSecretKey /
   tencentSecretId / tencentSecretKey / tokenhubApiKey`——**没有 BizType 字段**；`E:\GengYunPrivate\腾讯云.txt`
   只有凭据与服务器信息，**也没有** BizType；全机扫描仅找到两份**先于交接**的
   `config.local.json` 快照（`E:\COC\.supervisor\review-42-fixed-20261004\` 与 `review-pr-42\`），
   两份的 `moderation.bizType` 与 `moderation.image.bizType` **均为空串**。
   而 `docs/verification/ai-configuration-evidence.md` 记载上一轮曾在**真实 BizType** 写入本机忽略配置后达到 exit 0。
   ⇒ 本轮 `config.local.json` 的两个 `bizType` 填的是**合成占位值 `SYNTH_PLACEHOLDER_NOT_REAL`**
   （仅满足 `/^[A-Za-z0-9_-]{1,32}$/` 的格式校验）。`policySelectionVerified` 仍为 `false`。
   **在任何真实审核调用之前，必须由用户重新交接两个真实 BizType。**
2. **OCR 字段抽取层不存在**（§3.1），是 OCR"真实接线"的真实前置件，本阶段未实现。
3. **`uncertain_spans: []` 的语义**（§3.2）需按证据口径裁定。
4. **`InvalidParameter*` 映射到 `PROVIDER_OUTCOME_UNKNOWN` 而非 400**（§2.6）是我的判断，需监工裁定。
5. 契约**没有** TTS 文本上限、**没有** `JobState`↔`ErrorCode` 对应关系的明文（既有实现已按 `timed_out`/`failed` 口径处理）。
6. 阶段 1 适配器全部在**未合并**分支上；本文档的所有行内引用锚定的是**在途分支**的当前内容，
   合并顺序变化会使引用漂移，落地时需重新核对。
