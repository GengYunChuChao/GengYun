# #11 语音问答：录音容器对齐冻结 ASR 档位（WAV）＋「拿不到 WAV 就不上传」

日期：2026-10-23（HKT）。基线：`upstream/main` = `765b6a31d993995e5dacbf6a3227ebcbb97fd8df`（开工 `git rev-parse upstream/main` 实测同值，未漂移）。
工作树：`E:\GengYunCommander\wt-r34-i11-voice`，分支 `fix/gy-r34-i11-voice-format`，起点＝上述基线。
工具链实测：`node v24.16.0`；本工作树 `npm ci --prefer-offline --no-audit --no-fund --ignore-scripts` 退出码 0，`package-lock.json` 零改动（§8）。
边界：本页不含任何凭据、未读私密目录、**未用真机**、**未做任何真实外呼**、未触及真实对象存储。

## 0 结论先行

1. **容器与档位此前必然不一致**：客户端录音请求写死 `format: 'aac'`（改前 `miniprogram/pages/voice/voice.js` 第 769 行、`miniprogram/utils/recorder-port.js` 第 70 行的默认值，均在基线 `765b6a31`），而转写档位**只有 WAV 一种载体**（`services/api/src/ai/asr-live-adapter.ts:37-50` 的 `LIVE_ASR_FROZEN_PROFILE`，其 `:43` 为 `voiceFormat: 'wav' as const`；`tools/ai-config.mjs:57` 的 asr 剖面校验同样钉死 `voiceFormat==='wav'`）⇒ **不是"可能失败"，是"一定在服务端本地被拒"**。
2. **采样率/声道此前已经对了**：端口一直是 `sampleRate: 16000` / `numberOfChannels: 1`（改前 `miniprogram/utils/recorder-port.js` 第 29、31 行），与档位同值 ⇒ 本片**只改容器**，不改采样率与声道。
3. **本片把容器改成 WAV**，并让页面**从档位常量取容器**（`miniprogram/pages/voice/voice.js:772` 用 `voiceApi.ASR_RECORD_FORMAT`），不再在页面里散落字面量。
4. **新增客户端收尾校验**：录音停止后，若端口回报的 `format`/`mime` 不是 WAV（含"平台没回传 format"）⇒ **零上传**、就地如实失败、并**点名 WAV**（`miniprogram/pages/voice/voice.js:847-863`、`miniprogram/utils/voice-api.js:407`、`:413`）。拦在客户端的理由见 §5：非 WAV 在服务端被拒后作业落 `failed` 且**不写**转写行，用户只剩 404。
5. **服务端未改**：契约 `Job.error_code` 是**闭集**（`packages/contracts/openapi.json:14969-14998` 的 `error_code` 为 `anyOf [ $ref ErrorCode, null ]`，`ErrorCode` 枚举在 `:10996-11047` 共 24 个取值），其中确有 `OBJECT_UNAVAILABLE` / `INVALID_REQUEST`；但把适配器的错误映射过去要动**另外两个切片**已冻结的断言，且**仍然拿不到"请上传 WAV"给用户** ⇒ 按派单"先查清再决定"的口径**不改**，在 §5 登记为缺陷。
6. **⛔ 未改**：ASR 档位（`LIVE_ASR_FROZEN_PROFILE`）、`packages/contracts/**`、媒体用途白名单（`packages/media/constants.mjs:48` 仍收 `audio/mpeg`/`audio/wav`/`audio/aac`）。

## 1 事实源（逐条实读，行号按本提交）

| 层 | 位置 | 原文要点 |
| --- | --- | --- |
| 冻结 ASR 档位 | `services/api/src/ai/asr-live-adapter.ts:37-50` | `model: '16k_zh'`、`voiceFormat: 'wav'`（`:43`）、`sampleRate: 16000`（`:44`）、`channels: 1`（`:45`）、`maxAudioSeconds: 60` | 
| 本地 WAV 硬校验 | `services/api/src/ai/asr-live-adapter.ts:81-124` `requireLiveAsrWav()` | RIFF/WAVE 头 + `size+8===length` + PCM + 单声道 + 16000Hz + **字节率 32000**（`:118`）+ 块对齐 2 + **位深 16**（`:120`）+ 时长 ≤60s；不符即 `AsrLocalInputError` |
| 配置侧剖面 | `tools/ai-config.mjs:57` | `p?.voiceFormat === 'wav' && p?.sampleRate === 16000 && p?.channels === 1 && p?.maxAudioSeconds === 60` |
| 配置侧 WAV 头 | `tools/ai-config.mjs:91` | `readUInt32LE(4) !== 16000`、`readUInt32LE(8) !== 32000`、`readUInt16LE(14) !== 16` ⇒ 与适配器同口径 |
| 上传用途白名单 | `packages/media/constants.mjs:48` | `voice_question: Object.freeze(['audio/mpeg', 'audio/wav', 'audio/aac'])`（**本片不改**：删条目＝改契约） |
| 契约上传枚举 | `packages/contracts/openapi.json:11274-11316` | `ErrorCode` 闭集（24 值），含 `OBJECT_UNAVAILABLE`、`INVALID_REQUEST`、`MEDIA_TYPE_UNSUPPORTED` |

⇒ 两侧口径并不对称：**上传**允许 mp3/wav/aac，**转写**只收 WAV（16k/单声道/16bit PCM）。客户端此前按上传白名单录 aac，等于必然撞上转写侧的本地闸。

## 2 改动清单

### 2.1 生产代码（3 个文件，均为 miniprogram）

| 文件 | 改动 | 位置 |
| --- | --- | --- |
| `miniprogram/pages/voice/voice.js` | 录音请求容器改为取档位常量：`port.start({ format: voiceApi.ASR_RECORD_FORMAT })` | `:772` |
| 同上 | **新增收尾校验**：非 WAV ⇒ 丢弃本机临时录音、`uploadErrorCode='RECORD_FORMAT_NOT_WAV'`、`recordStageNote` 点名 WAV、零上传 | `:847-863` |
| 同上 | 页内说明补一句"录音容器固定 WAV；拿不到 WAV 就如实失败、不上传" | `:51` |
| `miniprogram/utils/recorder-port.js` | 默认容器 `format: RECORD_FORMAT`（=`'wav'`），`RECORD_FORMAT` 常量的依据注释指向冻结档位与 `requireLiveAsrWav()` | `:47`、`:85` |
| 同上 | **WAV 会话不再传 `encodeBitRate`**（压缩编码才传，值未变 48000）；理由：WAV 是未压缩 PCM，字节率被 `16000×1×16bit` 钉死为 32000 B/s（`:118` 的同值） | `:359-367`、`:95` |
| 同上 | 导出 `RECORD_FORMAT`/`NUMBER_OF_CHANNELS`（供测试与页面同源核对） | `:468-469` |
| `miniprogram/utils/voice-api.js` | 新增 `ASR_RECORD_FORMAT`/`ASR_RECORD_MIME`、`isAsrWavRecording()`、`recordFormatMessageFor()` | `:398`、`:407`、`:413` |
| 同上 | 文案表新增 `RECORD_FORMAT_NOT_WAV`（点名 WAV/16kHz/16bit、明说"没有上传任何音频、不裁剪不转码、不谎报"） | `:440` |

设计边界（有意为之）：
- **端口不替页面做决定**：`recorder-port.js` 仍然**如实回传**平台给的 `format`/`mime`（`productOf` 原样返回，不谎报成 wav）；"非 WAV 就不上传"是**页面**的收尾校验。这样"平台没按请求给 WAV"这件事在层与层之间是**可观测**的，而不是被端口悄悄改写。
- **不改契约/白名单/档位**：容器对齐靠"客户端按档位录"，不是靠把 mp3/aac 从白名单删掉（那是改契约，明令禁止）。

### 2.2 测试（2 个文件）

`tests/unit/miniprogram-voice-playback.test.mjs`
- **改钉断言**：`:1164` 由 `start.format === 'aac'` 改为 `=== 'wav'`（判据不变：仍是"请求容器的精确值"，只换期望值；说明文字改为"容器必须是冻结 ASR 档位要求的 WAV（非 WAV 一律不上传）"）。
- **夹具随容器改**（语义不变，只换字符串常量）：`:1214` 请求 `format:'wav'`、`:1221` 产物路径 `.wav`、`:1222` 声明 `mime:'audio/wav'`、`:1422` 请求 `format:'wav'`、`:1440` 声明 `mime:'audio/wav'`。
- **探针更贴近平台**：`observableRecorderManager` 的产物 `format` 改为**回显 `start()` 请求的容器**（临时文件扩展名随容器走）；显式 `format` override 仍可构造"平台没按请求给 WAV"的反例。
- **harness 新增注入点**：`options.recorderPort` 可换成假端口模块（真端口对"缺 format"的产物根本产不出 `ok:true`，只能用假端口把这种产物喂给页面）。
- **新增 3 条离线用例**（零发包、零麦克风）：`容器①` `:1531`（假端口回 `wav` ⇒ 上传恰一次、声明 `audio/wav`）、`容器②` `:1553`（假端口回 `aac`/`mp3`/缺 `format` ⇒ **零请求**、失败码 `RECORD_FORMAT_NOT_WAV`、提示点名 WAV/16kHz/16bit 且**如实带出实际容器**）、`容器③` `:1586`（录音请求的 `format`/`sampleRate`/`numberOfChannels`/`duration` 逐项与 `LIVE_ASR_FROZEN_PROFILE` 比对，并断言 WAV 会话**不带** `encodeBitRate`）。

`tests/unit/miniprogram-i11-voice-input.test.mjs`（同一页面的另一片回归，夹具随容器过期）
- 假端口默认产物由 `aac`/`audio/mp4` 改为 `wav`/`audio/wav`（`:158`）；4 条 `unlinks` 断言的路径常量同步改 WAV（`:259`、`:277`、`:296`、`:312`）。
- **断言条数与语义未变**：只换字符串常量；"非 WAV ⇒ 零上传"由上面 3 条新用例覆盖。

### 2.3 断言增减机械读数（语义级口径）
- `test(` 条数：**61 → 64**（+3，全为新增用例；无删除、无改名、无 `skip/only/todo`）。
- `assert.*` 计数（改前 → 改后）：`equal` **377 → 408**、`ok` **67 → 69**、`deepEqual` **19 → 19**、`notEqual` **5 → 5** ⇒ **无任何断言类型减少**。
- 改动的断言均为**字符串常量替换**（`'aac'`→`'wav'`、`audio/aac`→`audio/wav`、`.aac`→`.wav`），判据与条数均不变：本文件 4 处（`:1164`、`:1221`、`:1222`、`:1440`），邻接文件 4 处（`:259`、`:277`、`:296`、`:312`）；另有 3 处是**夹具**本身（本文件 `:1214`、`:1422`，邻接文件 `:158`），不是断言。

### 2.4 非生产文件的连带改动（1 个）
- `tools/doc-anchors-baseline.json`：由 `node tools/verify-doc-anchors.mjs --write-baseline` **重新生成**（非手改）：**删 2 条已陈旧**的 SUSPECT 豁免，另把 1 条既有条目挪回生成器排序位置（纯位移，内容未变）；未新增任何条目。原因与读数见 §3 说明 2。

## 3 门禁读数（全部实跑，含退出码）

| # | 命令 | 读数 | 退出码 |
| --- | --- | --- | --- |
| 1 | `node --test tests/unit/miniprogram-voice-playback.test.mjs` | tests 64 / pass 64 / fail 0 / todo 0 | 0 |
| 2 | `node --test tests/unit/miniprogram-i11-voice-input.test.mjs tests/unit/miniprogram-identify.test.mjs tests/unit/miniprogram-transcript-confirm.test.mjs tests/unit/miniprogram-auth-failure-attribution.test.mjs tests/unit/miniprogram-speech-autoplay.test.mjs tests/local-debug.test.mjs` | tests 97 / pass 97 / fail 0 | 0 |
| 3 | `node --test tests/unit/i11-audio-mp3-wav-guard.test.mjs` | tests 5 / pass 3 / todo 2 / fail 0（**与改前同读数**：服务端未改，缺口本体仍是 todo） | 0 |
| 4 | `node --test tests/unit/ai-live-provider-wiring.test.mjs` | tests 16 / pass 16 / fail 0 | 0 |
| 5 | `node tools/verify-doc-anchors.mjs --strict` | 文档 257 份；引用 4782 条；BROKEN 33 / OUT_OF_RANGE 6 / SUSPECT 64（全部落在基线内）；基线外新增 **0**、陈旧 **0** | 0 |
| 6 | `node --test tests/unit/doc-anchors-guard.test.mjs` | tests 10 / pass 10 / fail 0（本片改行号后必需：见下） | 0 |
| 7 | `node tools/verify-contract-status.mjs` | PASS（覆盖 113 条契约操作；形状错误 0、语义错误 0；中文表格一致） | 0 |

- ⛔ 未跑全量单测（派单禁止），⛔ 未用 `--test-isolation=none`。
- 说明 1：本片未改 `services/api/**`，故未触发 `--reanchor`；`verify-contract-status` 仅作"未被本片带红"的读数。
- 说明 2：**本片改了 `tools/doc-anchors-baseline.json`**（删 2 条陈旧豁免，文件由 `node tools/verify-doc-anchors.mjs --write-baseline` 重新生成，非手改）。原因：`voice.js` 与 `tests/unit/miniprogram-voice-playback.test.mjs` 的行号因本片新增代码整体后移，原先登记的两条 SUSPECT 豁免（`miniprogram/pages/voice/voice.js` 第 1009 行、`tests/unit/miniprogram-voice-playback.test.mjs` 第 907 行）已不再命中——**改前**这两行分别是孤立的收尾花括号（`  },` 与 `  }`，属"无实质内容"），**改后**落到了真实内容上（`voice.js` 是转写流程文档注释里的一行解释、测试文件是 `jobFixture` 里的 `kind: 'synthesis'`）⇒ 豁免失效。`doc-anchors-guard` 会点名要求删除（`--strict` 同时报 `STALE: 2`）。删除后 `--strict` 与 guard 均绿（上表 5、6）。
  ⚠ 如实登记：这两条**文档引用本身仍然指错位置**（`docs/verification/gy-i11-voice-input-20261021.md` 第 42 行、`docs/verification/gy-i13-synthesis-jobs-20261014.md` 第 207 行各自的行号已随代码漂移）；`verify-doc-anchors` 只判结构性事实（路径/行号存在、区间有内容），现在它们恰好落在注释/代码上而不再判红。**本片未改这两份文档**（属另两片的证据页），此处只如实登记，不声称"已修好"。另：`--write-baseline` 顺带把一条既有条目（`tests/integration/ocr-jobs-pg.mjs` 的第 848 行那条 SUSPECT 豁免）挪回生成器的排序位置，条目内容未变（diff 中体现为 6 删 6 增的纯位移）。
- 说明 3（本机已知假红，非本片引入）：`tests/unit/release-materials-index.test.mjs`（5 条：2 fail）与 `tests/unit/release-materials-index-strict.test.mjs`（6 条：6 fail）在本机恒红——本机 `bash` 是 WSL 存根（`C:\Users\MR\AppData\Local\Microsoft\WindowsApps\bash.exe`，`bash --version` 退出码 1），`tools/verify-release-materials.mjs` 实测 **14/16**，红的 2 项是 bash 依赖项。**同一组命令在与本片无关的 `wt-r34-i14-adapter`（`9a84cc1a`）工作树上得到逐条相同的失败用例名与计数** ⇒ 与本片改动无关。`tests/unit/ci-contract-status-gate.test.mjs` 在两棵树上均 5/5 通过。

## 4 未取得（如实，不得当成已验收）

1. **微信 `RecorderManager` 对 `format: 'wav'` 的真机实证：无。** 仓内零依据：`git grep -n "RecorderManager" HEAD -- miniprogram` 只命中 `wx.getRecorderManager` 的调用与注释，**无一处**说明 `format` 的合法取值；`git log --oneline -S "format: 'wav'" -- miniprogram` ⇒ **零提交**。平台能力属**外部文档、未实测**（本会话禁真机）。
2. **真实 ASR 转写：无。** 全程零外呼、零凭据、零付费；本页所有结论都是本地码读 + 离线单测。
3. **真机位深/声道读数：无。** 即使平台接受 `format:'wav'`，其 WAV 是否真是 16kHz/单声道/16bit（`services/api/src/ai/asr-live-adapter.ts:118`、`:120` 的判据）未取到现场读数。
4. **平台对 WAV 会话是否忽略/校验 `encodeBitRate`：未实测。** 本片的处理是"WAV 会话不传该参数"（不依赖平台是否忽略它）。
5. **端到端 200：无。** 需要真实对象存储 + 真实 ASR + 真机录音三者同时就位，均不在本片授权内。

## 5 现存缺陷（**本片未改**，登记请裁定）

- **位置**：`services/api/src/ai/asr-live-adapter.ts:175-181`（`createLiveSpeechProvider()` 返回的 `transcribe()` 的 build 段与裸 `catch`）。
- **现象**：`requireLiveAsrWav()` 抛出的 `AsrLocalInputError('OBJECT_UNAVAILABLE', …)`（`:83`、`:87`）被 `:178-181` 的 `catch` 一律改写成 `{ kind: 'failed', code: 'PROVIDER_UNAVAILABLE' }`；而 `:179` 的注释写着"取不到/音频不合法：不打供应商，**也不把它说成供应商故障**"——**注释与返回值自相矛盾**。
- **后果链**：`services/api/src/speech/service.ts:541-546` 把该码落成 `failed` + `error_code`；`:596` **只在 `succeeded`** 时才写转写行 ⇒ `:402-412` 的 `getOwnedTranscription` 一律 `NOT_FOUND`（`:404`、`:409`）。客户端把 404 当**正常中间态**（`miniprogram/utils/speech-transcript.js:333-335`），到 `deadline_at` 才停轮询并如实报「未产出可核对记录」⇒ **用户仍然看不到"请上传 WAV"**。
- **复现命令**（离线、零发包、零数据库；本页实跑输出见下一行）：

```
cd E:\GengYunCommander\wt-r34-i11-voice
node --input-type=module -e "import {createLiveSpeechProvider} from './services/api/src/ai/asr-live-adapter.ts'; import {mp3Bytes} from './tests/media/_fixtures.mjs'; const gate={reserve:async()=>({t:1}),settle:async()=>{}}; const p=createLiveSpeechProvider({liveGate:gate,authorization:'offline-repro',profile:{endpoint:'https://asr.tencentcloudapi.com',action:'SentenceRecognition',apiVersion:'2019-06-14',region:'ap-shanghai',timeoutMs:8000,maxRetries:0,model:'16k_zh',voiceFormat:'wav',sampleRate:16000,channels:1,maxAudioSeconds:60,maxAudioBase64Bytes:3145728},credentials:{secretId:'synthetic',secretKey:'synthetic',sessionToken:''},audioSource:{kind:'wired',note:'mp3 fixture',read:async()=>mp3Bytes({frames:5})},fetchImpl:async()=>{throw new Error('should-not-send')}}); console.log('OUTCOME=' + JSON.stringify(await p.transcribe({jobId:'11111111-2222-4333-8444-555555555555',mediaId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',mediaRevision:1})));"
```

实测输出（退出码 0，`fetchImpl` 一次都没被调用）：

```
OUTCOME={"kind":"failed","code":"PROVIDER_UNAVAILABLE"}
```

- **为什么本片不改（"先查清再决定"）**：
  1. **闭集条件成立**：`Job.error_code` 是闭集（`packages/contracts/openapi.json:14969-14998`），且 `AsrLocalInputError.code` 的取值域是 `'INVALID_REQUEST' | 'OBJECT_UNAVAILABLE'`（`services/api/src/ai/asr-live-ports.ts:118-126`），**两个都在闭集内** ⇒ 技术上**不需要**新增取值。
  2. **但改它要同时改另外两个切片的冻结断言**：`tests/unit/i11-audio-mp3-wav-guard.test.mjs:159`（`deepEqual(outcome, { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' })`）、`tests/unit/ai-live-provider-wiring.test.mjs:238`、`:255`（产品链"字节来源未接线 ⇒ `PROVIDER_UNAVAILABLE`"）。这三条都不在本片被授权改动的断言清单内（本片只被授权改 `miniprogram-voice-playback.test.mjs` 里那条 `'aac'`）。
  3. **且收益到不了用户**：即便映射成 `OBJECT_UNAVAILABLE` / `INVALID_REQUEST`，作业仍是 `failed`、仍不写转写行、转写照旧 404 —— 用户还是拿不到"请上传 WAV"。要把那句话送出去，必须让**受理期**读到真实容器（`SpeechMediaPort.resolve` 回 mime，属**端口形状变更**）或由客户端拦住半程（本片已做客户端这一半）。
  ⇒ **建议**：由指挥裁定是否单开一片做"受理期读对象头部/回 mime"，并把上述三条断言的授权一并写进派单。

## 6 门禁盲区登记（本片不改）

`tests/media/contract.test.mjs:47-52` 只断言**子集**：`for (const m of list) assert.ok(enumMime.includes(m), …)` —— 即"每用途允许的 MIME ⊆ `UploadInput.mime` 枚举"，**不要求相等**。
⇒ 把 `voice_question` 从 `['audio/mpeg','audio/wav','audio/aac']`（`packages/media/constants.mjs:48`）收窄成 `['audio/wav']`，该门禁**仍是绿的**，而 openapi 仍对客户端声称收 mp3/aac ⇒ **契约与实现脱节没有任何机器门禁**。改它＝改门禁口径，需裁定，本片**不动**。

## 7 复核侦察结论（逐条；含被本片推翻/修正的）

| # | 侦察原话 | 复核结果 |
| --- | --- | --- |
| 1 | 客户端录音端口请求 `format:'aac'`，且已设 16kHz／单声道 | **成立**（改前 `voice.js` 第 769 行、`recorder-port.js` 第 29/31/70 行） |
| 2 | `recorder-port.js` 里 wav 已映射、也在媒体白名单内 | **成立**（`FORMAT_MIME` 有 `wav: 'audio/wav'`、`ALLOWED_FORMATS` 含 `'wav'`） |
| 3 | 真实 ASR 适配器只收 16kHz/单声道/16bit PCM WAV | **成立**（`asr-live-adapter.ts:81-124`，`:118` 字节率 32000、`:120` 位深 16） |
| 4 | 该拒绝被裸 `catch` 改写成 `PROVIDER_UNAVAILABLE` | **成立**（`:178-181`） |
| 5 | 作业落 `failed` 不写转写行 ⇒ 用户 `GET /speech/transcriptions/{id}` 只见 404，"永远看不到请上传 WAV" | **成立，但措辞需修正**：客户端不会"卡在 404"——它把 404 当正常中间态（`miniprogram/utils/speech-transcript.js:333-335`），到 `deadline_at` 停轮询并报「未产出可核对记录」。**"只见 404"是服务端 API 事实，不是用户界面事实**；用户界面上是一句**不含 WAV 的通用文案**。结论方向不变。 |
| 6 | 最小改动面：只有 `voice.js` 一处生产代码，`recorder-port` **不需改** | **推翻**：`recorder-port.js` 必须改（默认容器 + `encodeBitRate` 归属）；且本片还新增了页面收尾校验与 `voice-api` 的判定/文案；测试面也不止一条断言（`miniprogram-voice-playback` 的 5 处夹具 + 另一片 `miniprogram-i11-voice-input` 的 5 处夹具）。 |
| 7 | 侦察给的行号（`voice.js:769`、`recorder-port.js:29/31/42/50/70`、`asr-live-adapter.ts:87/89-91/178-181`、`tools/ai-config.mjs:57`） | **逐一核对成立**；两处小偏差：`services/api/src/speech/service.ts` 的 `NOT_FOUND` 实测在 `:404` 与 `:409`（侦察写 `:402-408`），提交终态在 `:541-546`（侦察写 `:541-545`）。 |
| 8 | 微信 `RecorderManager` 是否支持 `format:'wav'`：仓内零依据，属外部文档未实测 | **成立**（§4 的两条命令复跑；本片仍**未能**取得真机证据） |

## 8 复现与自检命令

```
cd E:\GengYunCommander\wt-r34-i11-voice
git rev-parse upstream/main          # 期望 765b6a31d993995e5dacbf6a3227ebcbb97fd8df
git status --short package-lock.json # 期望空（npm ci 未改 lockfile）
node --test tests/unit/miniprogram-voice-playback.test.mjs
node --test tests/unit/i11-audio-mp3-wav-guard.test.mjs
node tools/verify-doc-anchors.mjs --strict
node --test tests/unit/doc-anchors-guard.test.mjs
node tools/verify-contract-status.mjs
```

- 本页引用的所有"改前"行号一律按基线 `765b6a31` 读取（`git show 765b6a31:<path>`），"改后"行号按本分支提交读取。
- 复核口径：本页只声称**代码事实 + 离线单测读数**；任何"真机上能录到合法 WAV"的说法都在 §4 明确列为**未取得**。
