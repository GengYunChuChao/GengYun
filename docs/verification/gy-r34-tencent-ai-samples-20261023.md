# GY-R34 · 腾讯云 AI 五类真实调用取证（TMS / IMS / OCR / TTS / ASR）

**这是供应商连通性与策略证据，不等于产品能力验收。** 一次可达性调用既不是样本，也不产生任何
准确率、召回率、误放行率或策略正确性结论。

- 基线 `upstream/main` = **`f3a5f24d7427f5c2e40b9c8278312aa4827157ca`**（开工与收工两次实测，无漂移）。
- 工作树 `wt-r34-real-ai`，分支 `test/gy-r34-real-ai-samples`，起点 = 上述基线。
- 取证时间：**2026-10-23 16:15:50 → 16:15:52（Asia/Shanghai，UTC+8）**，单次运行，6 次真实外呼，2.37 s 内完成。
- 调用量：TMS 2 / IMS 1 / OCR 1 / TTS 1 / ASR 1 —— 上限用尽，**零重试、零循环、零压测**。
  报告 `budget` 拆成两栏：`reserved`（发送前预留/计费计数）= 6、`sent`（真实发出的 HTTP 次数）= 6；
  `sent` **不是成功数**（成功只算 `BUSINESS_RESPONSE`：本次 5 条，ASR 未取得），口径见 §3.6。
- 相关单：`Refs #10 #11 #13 #14`（`#14` 审核：TMS/IMS；`#13` 媒体：TTS；`#11` 语音：ASR；`#10` OCR）。

---

## 0 结论摘要

1. **四类取得真实业务响应**（TMS×2 / IMS / OCR / TTS），**ASR 未取得**（凭据被供应商拒绝，见 §2）。
2. **TMS 受控违规样本未被拦截**：`Suggestion=Pass`、`Label=Normal`、`Score=0`
   （样本＝「加微信引流 ＋ 出售 ＋ 私聊低价」形状的**合成**文本）。
   结论限定在 **n=1**：**本样本未被拦截，不能外推为整类无判定力；策略有效性仍未证**。
   这是本页最重要的读数：**连通性与鉴权已证，策略有效性未证**。⛔ 不得据此认为审核链路"能拦住违规"。
3. **OCR 逐字识别正确**：合成样张「除草剂使用说明」被原样检出，`Confidence=100`（单行）。
4. **TTS 以 `Codec=wav` 拿到音频**（101,804 B，`SessionId` 原样回显），音频剖面通过仓内
   `requireLiveAsrWav()` 的 16k/单声道/16bit 校验 ⇒ **TTS→ASR 环回的"音频侧"已打通**；
   ASR 侧因凭据被拒未取得，**没有伪造任何转写**。
5. **一处凭据结构硬伤**：`credentials.local.json` 现为 **JSONC**（含行尾 `//` 注释），
   `tools/ai-config.mjs:loadPrivateEnvironment()` 按严格 JSON 解析 ⇒ 当前**不可用**
   （抛 `PRIVATE_FILE_UNAVAILABLE`）。本脚本因此自带只读的 JSONC 容错解析，**未改动私密区原文件**。

---

## 1 逐类读数

时间为本地 `Asia/Shanghai`；Region 恒 `ap-shanghai`；`RequestId` 为供应商返回的追踪号
（不含任何账号标识；6 条全部满足仓内适配器的严格口径 `^[a-fA-F0-9-]{16,64}$`）。

| 类别 | 动作 · Version | 时间 | RequestId | 结论（供应商读数） | 耗时 | 费用估算 |
| --- | --- | --- | --- | --- | --- | --- |
| TMS ① 正常文本 | `TextModeration` 2020-12-29 | 16:15:50.023 | `bb7b04ce-a834-4944-92b9-b77e3a1f000e` | `Pass` / `Normal` / `Score 0` → 闭集 `pass` | 326 ms | 未取得账单 |
| TMS ② 受控违规 | `TextModeration` 2020-12-29 | 16:15:50.350 | `b307f819-d457-4e0a-93b6-dec15362fe97` | **`Pass` / `Normal` / `Score 0`（未拦截）** | 109 ms | 未取得账单 |
| IMS | `ImageModeration` 2020-12-29 | 16:15:50.460 | `d1f98ea5-8448-48a9-8604-c42ee8b929d2` | `Pass` / `Normal` / `Score 0` → 闭集 `pass` | 470 ms | 未取得账单 |
| OCR | `GeneralAccurateOCR` 2018-11-19 | 16:15:50.931 | `53149d47-c629-44ff-ab2f-222a4845773b` | 检出 1 行：`除草剂使用说明`，置信区间 **100–100** | 421 ms | ¥0.5（预留单价） |
| TTS | `TextToVoice` 2019-08-23 | 16:15:51.352 | `1fe26fb3-181c-4731-a5b7-d7e58f51b6f8` | `Codec=wav`，音频 **101,804 B**，`SessionId` 回显 ✔ | 838 ms | ¥0.003（预留单价） |
| ASR | `SentenceRecognition` 2019-06-14 | 16:15:52.231 | `35448ac5-3a4c-4022-a748-d35acd504e55` | **`AuthFailure.SecretIdNotFound`** | 160 ms | 0（未产生成功计费调用） |

**请求形状**（字段名照抄仓内既有实现；⛔ 本页不记任何凭据、签名、BizType 值）：

| 类别 | 请求体字段 | 复用来源 |
| --- | --- | --- |
| TMS | `Content`（正文 UTF-8 的 base64）、`BizType`、`Type=TEXT`、`SourceLanguage=zh` | `tools/ai-config.mjs:prepareOfflineRequest()` / `tms-live-adapter.ts` |
| IMS | `FileContent`（PNG 的 base64）、`BizType` | 同上（`ims-live-adapter.ts`） |
| OCR | `ImageBase64` | 同上（`ocr-live-adapter.ts`） |
| TTS | `Text`、`SessionId`、`ModelType=1`、`PrimaryLanguage=1`、`VoiceType=101001`、`SampleRate=16000`、`Codec=wav`、`Speed=0`、`Volume=0` | `tts/provider.ts` 的 payload，仅 `Codec` 由 `mp3` 改为 `wav` |
| ASR | `ProjectId=0`、`SubServiceType=2`、`EngSerViceType=16k_zh`、`SourceType=1`、`VoiceFormat=wav`、`Data`、`DataLen`、`UsrAudioKey` | `asr-live-adapter.ts` |

### 1.1 关于 `Codec=wav` 的口径差异（如实记录）

仓内产品剖面把 TTS 冻结在 `codec='mp3'`（`tts/provider.ts:LIVE_TTS_FROZEN_PROFILE`）。本次取证**故意**
用 `Codec=wav`，理由与依据：

- 官方参数页写明 `Codec` 可取值 **`wav`（默认）、`mp3`、`pcm`**，`SampleRate` 支持 `16000`；
- ASR 环回要求 16 kHz / 单声道 / 16 bit WAV，`mp3` 需要解码器，本次没有解码器也**不新增依赖**。

因此这是**取证参数**与**产品参数**的差异，不改变产品配置，也不代表产品应改成 wav。

### 1.2 TTS → ASR 环回的实际状态

| 环节 | 读数 | 结论 |
| --- | --- | --- |
| TTS 产出音频 | 101,804 B，`sha256=b7c6ca7c…c706`（只留长度与哈希，音频**不落库**） | ✔ 取得 |
| 音频剖面校验 | 通过 `requireLiveAsrWav()`：PCM / 单声道 / 16000 Hz / 16 bit / 时长 3,180 ms | ✔ 合规 |
| 同一段音频送 ASR | `35448ac5-3a4c-4022-a748-d35acd504e55` → `AuthFailure.SecretIdNotFound` | ✘ 未取得 |

⇒ **链路在"音频侧"闭合，在"鉴权侧"断开**。断开原因见 §2，不是音频格式问题。

### 1.3 合成样张（IMS 与 OCR 共用同一张）

| 项 | 值 |
| --- | --- |
| 生成方式 | `tools/evidence/make-sample-image.py`（Pillow 12.3.0，SimHei 104 px） |
| 内容 | 纯白底 ＋ 黑色印刷体单行「除草剂使用说明」（**合成图，无真人、无个人媒体、无真实标签**） |
| 尺寸 / 字节 | 1080 × 720 / 21,741 B（远低于供应商 2 MiB 上限） |
| SHA-256 | `83b57b88a362d2ecca8e4cabaf20605784af847658dcc96a936cea93e4ffb834` |
| 是否入库 | ⛔ 不入库：PNG 写在仓库外，仓库里只提交生成脚本 |

样张文本是通用农事说明，不含任何个人数据；IMS 判 `Pass/Normal`、OCR 逐字识别正确，
说明"这张图对该供应商是可用的输入"，**不说明**它对真实农药标签的识别质量。

---

## 2 未取得项（单列）

| 类别 | 状态 | RequestId | 脱敏错误码 | 原因 | 后续动作 |
| --- | --- | --- | --- | --- | --- |
| ASR（`SentenceRecognition`） | `SERVICE_ERROR` | `35448ac5-3a4c-4022-a748-d35acd504e55` | **`AuthFailure.SecretIdNotFound`** | 私密 TXT 里的 `API ASR` 段落给出了专用 `SecretId`/`SecretKey`，供应商判定**该 SecretId 不存在**（已撤销／已轮换／不属于该账号） | 在 CAM 重新生成 ASR 专用密钥并按现有形态写回私密文件；⛔ 本次**没有**回落到共享配对重试（那会突破 ASR 1 次上限），也**没有**伪造转写 |

补充口径：

- 该失败是**供应商业务错误**（HTTP 200 ＋ `Response.Error`），**不是**网络不可达；
- 仓内 `live-vendor.ts:moderationFailureFromVendorErrorCode()` 会把 `AuthFailure*` 归到 `auth_failed`，
  本次记录沿用了同一套分类语义；
- 按派单"单次失败即记为未取得"，ASR 到此为止，**未重试**。

---

## 3 口径与边界（为什么这不是能力验收）

1. **样本量 = 1**：每类一次可达性调用。没有任何统计意义，也不能外推为"识别准确率"。
2. **文本/图片全为合成数据**：TMS 的 2 条文本由脚本生成，其中"违规"样本用的是**明显假的联系方式**
   （`abc123`），不含任何真实号码、微信号或链接。
3. **不构成策略验收**：TMS 受控违规样本返回 `Pass`，只能说明"当前 BizType 的策略没拦住这一条"，
   既不能推出"策略永远拦不住"，也不能推出"策略没问题"。**策略选择从未被独立核对**
   （`tools/ai-config.mjs:auditAIConfiguration()` 对 `moderation*` 恒 `policySelectionVerified=false`）。
4. **不碰产品装配**：本次没有修改任何 `services/api/src/**`、`apps/**` 或配置文件；真实审核端口的
   接入仍是另一次显式、可审查的接线变更（见 `docs/verification/gy-r34-i14-live-adapter-20261023.md`）。
5. **费用是估算不是账单**：单价取仓内预算预留口径 `services/api/src/ai/live-gate.ts:LIVE_UNIT_PRICES_CNY`
   （`ocr 0.5` / `tts 0.003` / `asr 0.0032` 元/次），这是**保守上限**，通常显著高于实际目录价；
   TMS/IMS 在仓内**没有**预留单价，本次也**没有取到账单**，因此不填数字。
   合计（预留口径）：**¥0.503** ＝ OCR 0.5 ＋ TTS 0.003；ASR 未计费；**账单口径：未取得**。
6. **两个计数分开记（`reserved` / `sent`）**：`reserved` 是**发送前**的预留/计费计数（本地 fail-closed
   未送达的调用也算预留），`sent` 是 `fetch` **真实被调用**的次数（含超时、HTTP 错误、响应不可解析）。
   ⛔ `sent` **不是成功数**：成功数只由 `calls[*].status === 'BUSINESS_RESPONSE'` 判定。本次真实运行
   `reserved = { tms:2, ims:1, ocr:1, tts:1, asr:1 }`、`sent` 同值（6 次全部真的发出），而
   `BUSINESS_RESPONSE` 为 **5 条**（ASR 是 `SERVICE_ERROR`）。旧口径把预留计数直接叫 `used`，
   零外呼时也会报 `tms:2/ims:1/…`，容易被读成"发了这么多次"，因此拆开。

---

## 4 凭据与脱敏自证

- 凭据来源 = **env 或显式传入的私密文件路径，均在进程内使用**（与 `docs/verification/README.md:52`
  的「`--credentials <私密文件>` 仅在进程内映射环境变量」同一口径）：环境变量，或 `--private-env <私密 JSON>` /
  `--tencent-txt <私密 txt>` 两个路径入参（BizType 与 ASR 专用配对不同源）。本次以路径传入：
  `E:\GengYunPrivate\credentials.local.json`（JSONC）与 `E:\GengYunPrivate\腾讯云.txt`（两个 BizType ＋ ASR 专用配对）。
  脚本源码里**只有环境变量名**
  （`TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` / `TENCENTCLOUD_ASR_SECRET_ID` /
  `TENCENTCLOUD_ASR_SECRET_KEY` / `TENCENTCLOUD_SESSION_TOKEN` / `TENCENTCLOUD_ASR_SESSION_TOKEN`），
  **没有任何值**，启动时用 `assertEnvNamesMatchAiConfig()` 与 `tools/ai-config.mjs:ENV_FIELDS` 逐名比对（防漂移）。
- 报告（脱敏 JSON）只含：类别 / 动作 / Version / Region / 端点 / 时间 / **RequestId** / 结论字段
  （`Suggestion` `Label` `Score`，或 OCR 文本与置信区间，或音频字节数与哈希）/ 耗时 / 错误码。
  ⛔ 不含 `Authorization`、`SecretId`、`SecretKey`、`SessionToken`、BizType、账号 UIN、`database-url`、
  原始响应全文、图片或音频字节。
- 脚本结尾做一次 `assertNoSecretLeak()` 自检：把 6 个凭据值与 2 个 BizType 逐个在序列化后的报告里查找，
  命中即 `REDACTION_FAILED` 并中止；本次自检**通过**。比对有显式阈值 `MIN_SECRET_LENGTH = 8`
  （短于 8 字符的值会被跳过，理由见脚本注释；本例两个 BizType 为 13 / 12 字符，**均被覆盖**）。
- **过程披露（如实写）**：调试阶段有一条本地诊断命令把私密 TXT 的**行首 40 字符**原样打到了本机 stdout，
  其中含两个 BizType 的部分字符。该输出**未写入仓库、未进本页、未进提交**；随后的诊断改为只输出布尔量，
  不再输出任何行内容。**建议在控制台重置这两个 BizType**（成本为零，且它们未被任何仓内配置引用）。
  该教训已固化为脚本头注释第 6 条：私密文件内容**一律不得以任何长度前缀**进入 stdout / stderr / 日志；
  需要比对时只输出「行号 + 字段名 + 长度 + 正则布尔」或 `sha256(行)[:8]`。
- 本条之外的凭据使用记录：无。没有 push、没有开 PR、没有动 GitHub 凭据。

---

## 5 复现

```powershell
# 1) 生成合成样张（写到仓库外；不给 --out 之外的任何凭据）
python tools/evidence/make-sample-image.py --out "$env:TEMP\gy-r34-sample.png"

# 2) 一次运行跑完五类（每类至多一次、零重试）
node tools/evidence/tencent-ai-samples.mjs `
  --private-env  'E:\GengYunPrivate\credentials.local.json' `
  --tencent-txt  'E:\GengYunPrivate\腾讯云.txt' `
  --image        "$env:TEMP\gy-r34-sample.png" `
  --out          "$env:TEMP\gy-r34-tencent-ai-samples.json" `
  --git-head     f3a5f24d7427f5c2e40b9c8278312aa4827157ca
```

- 脚本直接 `import` 仓内 `.ts` 实现（`live-tc3.ts` / `tts/tc3.ts` / `live-vendor.ts` /
  `ocr-live-adapter.ts` / `asr-live-adapter.ts`），因此需要 **Node ≥ 22.18**（默认开启 `.ts` 类型擦除）。
  ⛔ **没有**第二套签名器：TMS/IMS 走 `live-tc3.ts:signModerationTc3Request()`（按其注入契约喂 `target`），
  OCR/ASR/TTS 走 `tts/tc3.ts:signTc3Request()`。
- **退出码（「空集 ≠ 成功」）**：`0` ＝ 至少 1 条 `BUSINESS_RESPONSE`；`77` ＝ **0 条 `BUSINESS_RESPONSE`
  （全部 `notObtained`）⇒ 未取得，不是通过**，同时在 stderr 打一行缺失清单（**只列字段名/开关名**，
  不含任何值或前缀）；`1` ＝ 脚本自身失败。无凭据时**不再 exit 0**（"零外呼却报成功"的形状已消除）。
- **`--out` 必须在仓库外**：指向仓库内会被 `OUT_INSIDE_REPO` 拒绝并 `exit 1`（不写文件、不外呼），
  与 `tools/evidence/make-sample-image.py` 的同一守卫。
- 复跑会产生新的付费调用；除本页记录的一次运行外**不要重跑**。

---

## 6 本次未做

- 未使用任何真实用户媒体、真人照片或真实农药标签扫描件（合成样张除外）。
- 未修改私密区任何文件（不改名、不加注释、不重排）。
- 未改产品装配路径，未新增依赖，未动 `package.json`。
- 未重试、未循环、未压测；未做 STS/身份查询（避免取到账号 UIN）。
- 未取得：ASR 转写（§2）、TMS/IMS 账单金额、TMS 策略有效性（受控违规未被拦）。
