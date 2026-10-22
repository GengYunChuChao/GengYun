# GY-I11（#11）语音输入 · D2 四段接线盘点与必要修复

- 任务：D2 / Refs #11（**不 Closes**；#11 的四条验收复选框仍由整套交付共同判定）
- 分支：`feat/gy-r28-d2-voice-input`，基点 `origin/main = 7d1a429`
- 说明：本文是**本机静态与合成读数**。真实 WeChat 开发者工具 / 真机 / 真实 ASR 供应商 / 真实对象存储与访问网关 / 真实 PG17 **均未取得**，一律记为「未取得」，不据此放宽任何验收。
- 口径：四段分别是 (a) 录音权限与 `wx.getRecorderManager` 生命周期、(b) 音频对象存储上传、(c) 转写任务与轮询/超时、(d) 转写文本进入问答的接线与「端侧临时态」在 B7 统一状态层的呈现。

## 1. 结论摘要（四段判定）

| 段 | 判定 | 一句话 |
| --- | --- | --- |
| (a) 录音权限与录音器生命周期 | **已通（本片补齐收尾）** | 授权先读 `scope.record`、拒绝即不调用平台 `start`；打断/自停/自报错不被吞；`onHide`/`onUnload` 真的停录并解绑监听；**本片补上离页/失败/取消时丢弃本机临时文件**（此前后端与端侧两侧都没人删） |
| (b) 音频对象存储上传 | **半通** | 客户端三段式（`POST /media/uploads` → 句柄 `PUT` → `/complete`）与契约 operation 齐备且真实调用；但**真实对象存储适配未接线**（real 下整域 503），且**音频分支没有元数据剥离、也不产生衍生对象**（`stripImageMetadata` 只覆盖 jpeg/png/webp） |
| (c) 转写任务与轮询/超时 | **已通（客户端）/ 服务端 stub 局部** | `POST /speech/transcriptions` → `GET .../{id}`（404 是正常中间态）→ `PATCH .../confirmation` → `POST /conversations/{id}/turns`；轮询以服务端 `deadline_at` + `POLL_MAX_TICKS` 双边界**必然结算**，超时如实落「未产出可核对记录」；真实 ASR 未接线时 real 下 503 |
| (d) 转写文本接入问答 + B7 端侧临时态 | **半通** | 发送闸门 fail-closed（未明确确认零外发）已通；但**「端侧临时态」没有进 B7 统一状态层**：语音页对 `utils/states.js`/`state-view` 零引用，`recordState`/`transcriptStage` 是页面私有 data，B7 的 `denied`（403）分档在本页拿不到渲染出口 |

## 2. (a) 录音权限与录音器生命周期

- 权限**只读不弹窗**：`miniprogram/utils/recorder-port.js:105-123`（`wx.getSetting` 读 `authSetting['scope.record']`；读不到一律 `unknown`，既不当已授权也不当拒绝）、`:126-137` `support()`（能力自述，不触发授权）。
- 拒绝授权**不调用平台 `start`**：`recorder-port.js:315-317`（`permission.state === 'denied'` ⇒ 直接 `{ok:false, code:'RECORD_AUTH_DENIED'}`）；页面归因在 `miniprogram/pages/voice/voice.js:667-703`（`started.ok !== true` 时落 `recordState:'failed'` + `voiceApi.recordUploadMessageFor({code})`）。
- 被系统打断：`recorder-port.js:269-272` `onInterruptionBegin` ⇒ `RECORD_INTERRUPTED`；`:263-267` `onError` 按 `isAuthDenial`(:140-144) 区分 `RECORD_AUTH_DENIED` / `RECORD_FAILED`。
- 平台**自行**停止/报错不被吞：`recorder-port.js:190-196` 的 `lastProduct` 槽 + `:363-372`「未录制但有产物 ⇒ 如实交出」（避免把「已录满」说成「没在录」）。
- 切后台/返回/切页必须停：`voice.js:125-128` `onHide` → `releaseRecorder('hide')` → `recorder-port.js:410-432` `release()`（`wasRecording` 时 `instance.stop()`，并逐个 `offStop/offError/offInterruptionBegin`）；`voice.js:130-136` `onUnload` 同构且先置 `_gone`。
- 时长上限单点收口：`recorder-port.js:305-308`（`duration = Math.min(requested, 60000)`）+ `voice.js:709-714`（本地计时到顶主动 `stopAndUpload()`，与平台自动停止收在同一出口）。
- **本片补齐（原先缺失）**：`voice.js:339-359` 新增 `discardRecordFile()`；`:300` 在 `releaseRecorder` 内调用（离页/门禁失效/切后台）；`:757` 登记平台交回的 `tempFilePath`；`:774/792/804/855/881/886` 在超限、摘要失败、非 real、上传成功、上传失败五类结局处调用。
- **仍未通**：被拒授权后**没有** `wx.openSetting` 入口（`recorder-port.js:293-295` 的注释承诺「由页面引导到设置页」，但 `miniprogram/**` 全树无 `openSetting` 引用）⇒ 用户只能自己翻微信设置。见 §8 待裁决 3。

## 3. (b) 音频对象存储上传

- 客户端走**既有私有媒体链路**，与识草/OCR 图同一落盘路径：`miniprogram/utils/identify-api.js:650-714` `uploadPrivateMedia`（`POST /media/uploads` 201+grant → `wx.getFileSystemManager().readFile` → `PUT grant.upload.url` → `POST /media/uploads/{id}/complete` 202 且 `state==='ready'`）。
- 音频与图片的**唯一差别**由契约定死：`identify-api.js:656-658`（图片**不得**带 `duration_ms`、音频**必须**带；否则本地 `INVALID_INPUT`）、`:662-663` 声明四/五键、`:739-746` `uploadVoiceQuestion`（`mime ∈ audio/mpeg|audio/wav|audio/aac`、`bytes ≤ 10 MiB`、`durationMs ≤ 60000`）。用途常量 `:50` `VOICE_MEDIA_PURPOSE = 'voice_question'`。
- 401/403 在上传链路是**分档**的：`:671` `reject(forbiddenOrSessionLoss(r.statusCode, r.data))`（不折叠）。
- 服务端落盘：`services/api/src/media/service.ts:906-943`。`kindOf(record.purpose) === 'image'` 才走 `stripImageMetadata` + `putObject(derivativeRef, …)`（`:927-937`）；**音频走 else 分支**（`:938-942`），只做「以真实时长覆盖声明值（B2 口径）」，**不剥离容器元数据、不产生 `derivativeRef`**。
- 剥元数据函数的真实覆盖面：`packages/media/exif.mjs:432-440`（只分派 jpeg/png/webp，其它 mime 原字节返回 `{ok:true, changed:false}`）。任务书问的「`putObject`/`stripImageMetadata` 只处理图，音频走哪条路」——**如实答**：音频不经过这两个函数，`putObject` 只在图片分支写衍生件；音频的**唯一**对象是 `rawRef`。
- 为什么判「半通」：`services/api/src/speech/media.ts:7-22` 与 `services/api/src/media/object-store.ts`（`createUnwiredObjectStore`）记录 real 模式下**媒体域 7 条路由整域 503 `PROVIDER_UNAVAILABLE`**，真开需 `app.ts` 注入 `mediaObjectStore` + `approveRealMediaWiring()` 显式批准。⇒ 真实字节能否落盘取决于部署期接线，本机不具备。
- 客户端对「未接线」是**如实**的：`voice.js:855-861`（非 real 模式 ⇒ `recordState:'stopped'`，文案含「真实对象存储未接线…没有 media_id」，不伪造 id）。

## 4. (c) 转写任务与轮询/超时

- 契约 operation（`packages/contracts/openapi.json`，只读）：`POST /speech/transcriptions` `createTranscription` 202、`GET /speech/transcriptions/{id}` `getTranscription` 200、`PATCH /speech/transcriptions/{id}/confirmation` `confirmTranscription` 200、`DELETE /speech/transcriptions/{id}` `deleteTranscription` 202。**没有**「取消转写任务」的 operation（DELETE 删的是记录）。
- 客户端消费层：`miniprogram/utils/speech-transcript.js:320-332`（受理，202 + `Job[kind=transcription]`）、`:341-347`（读取，404＝正常中间态）、`:355-372`（确认）、`:381-392`（删除/取消）、`:395-402`（会话）、`:413-432`（语音轮次 202 + `Job[kind=answer]`）。
- 轮询与**必然结算**：`voice.js:1026-1048`（每秒一拍；`ticks > POLL_MAX_TICKS || (deadlineMs>0 && Date.now() >= deadlineMs)` ⇒ 停表 + `:1038-1044` 落 `transcriptErrorCode:'TRANSCRIPT_NOT_PRODUCED'`）；边界取自 202 回传的 `deadline_at`（`voice.js:1090`）。`refreshTranscript`（`:1062-1102`）对 404 **不当作故障**，且 `revision` 只进不退（`:1083`）。
- 「超时永不结算」在这条链上**不成立**：双边界（拍数 + 截止时间）任一到达即结算，页面不会停在 `pending`。**但**超时/失败后**不**发 `DELETE /speech/transcriptions/{id}`（UI 已结算，服务端任务留给其自身过期）——见 §8 待裁决 5。
- 服务端：`services/api/src/speech/service.ts`（状态机）+ `services/api/src/speech/media.ts:29-81`（媒体引用端口：`substitute` 仅 stub/preset_demo；`unwired` 在 real 下一律 `OBJECT_UNAVAILABLE`）。real 下 `provider.available` 判定先于 `media.resolve` ⇒ 缺真实 ASR 时先得 503。

## 5. (d) 转写文本进入问答 + 端侧临时态的 B7 呈现

- 确认 → 发送两段式：`voice.js:1106-1248` `onConfirmAndSend`（先 `PATCH` 确认，再 `evaluateSendGate`，最后 `POST /conversations` + `POST /conversations/{id}/turns`）；闸门是纯函数 `speech-transcript.js:452-481`（取消/作废/未确认/记录缺失/版本不符/服务端未确认，六条 fail-closed）。
- 回答内容**不在本页呈现**（只回报 `job id/state`），这对 #11 是「已接线到受理」，不是「已交付问答结果」——如实登记。
- B7 统一状态层：`miniprogram/utils/states.js:1-13`（五态 + 「`denied` 与 `guest` 必须分开」）、`:25-63` `CODE_KIND`（`SCOPE_DENIED`/`CONSENT_REQUIRED`/`ACCOUNT_INACTIVE → denied`；`SESSION_* → session`）、`:123-129` `statusForCode`、`:145-156` `resolve`。
- **端侧临时态现状**：`miniprogram/pages/voice/*` 对 `states` / `state-view` **零引用**（grep 命中数 0）。录音/上传/转写阶段全是页面私有 data（`voice.js:138-226` 的 `recordState`/`recordLabel`/`recordStageNote`/`transcriptStage`/`transcriptBusy`/`exitNote`），失败文案走各域 `messageFor`/`recordUploadMessageFor` 的**逐码文案表**而非 B7 的 `code → kind → status`。
  ⇒ 判定「半通」：错误码归因**语义**与 B7 一致（401 走会话、403 原样带出且文案各不相同），但**呈现**未统一；B7 为 `denied` 预留的渲染出口对语音域是死代码。
- 契约侧依据：`docs/architecture/state-contract.md:64`（「同一页同一版本自动播报一次，离页/隐藏停止，**取消录音丢弃临时文件并解绑监听**；录音状态与播放状态由 GY-I11/13/26 客户端实现」）、`:62`（ASR 原转写保存、用户经 `PATCH confirmed_text` 明确确认、确认前不得问模型）、`:43`（`voice_question`：mp3/wav/aac、≤10MiB、≤60 秒）。

## 6. 本次实施内容（D2）

### 6.1 修：`voice-api.js` 把 403 折叠成 401，并顺手清掉会话（「401/403 折叠」类断点）

- 修复前：`miniprogram/utils/voice-api.js:199`（旧行号）
  `if (response.statusCode === 401 || response.statusCode === 403) { auth.clearSession(); reject(failure('SESSION_REQUIRED')); return }`
- 后果（都可观测）：
  1. 该文件自己的文案表早已写好 `SCOPE_DENIED`/`CONSENT_REQUIRED`/`ACCOUNT_INACTIVE` 三条（旧 `:399-401`，现 `:429-431`），却**永不可达**；
  2. 403 被说成「登录已失效」，并**静默清会话** ⇒ 用户按提示反复登录仍然失败，连「去授权」所需的会话都被清掉；
  3. 与本文件 `:378-382`（现 `:408`）自述的红线直接矛盾，也与同族已修好的 `identify-api.js` / `speech-transcript.js` 不一致。
- 修复后：新增 `SESSION_LOSS_CODES`（`:186`）、`errorCodeOf`（`:189`）、`forbiddenOrSessionLoss`（`:202-209`）；传输层 `:229` 改为 `reject(forbiddenOrSessionLoss(response.statusCode, response.data))`。
  口径与既有先例逐条对齐：401 ⇒ 清会话 + `SESSION_REQUIRED`；403 **且**码 ∈ 契约 403 集 ⇒ 原样带出该码、`status=403`、`retryable` 取自封套、**不清会话**；403 但无错误体/码不在集合内 ⇒ 仍按会话失效处理（保守，不臆测）。

### 6.2 修：本机录音临时文件从不回收（「临时文件不清理」类断点）

- 修复前：`miniprogram/**` 全树无 `removeSavedFile` / `FileSystemManager.unlink` 引用；`wx.getRecorderManager().onStop` 交回的临时文件在**上传成功 / 上传失败 / 取消 / 离页**四种结局下都不被删。`docs/architecture/state-contract.md:64` 早已要求「取消录音丢弃临时文件并解绑监听」。
- 修复后：`voice.js:339-359` `discardRecordFile()`——读 `_recTempFilePath` → **先清空再删**（幂等，不重复尝试）→ 能力探测：`wx.getFileSystemManager().unlink({filePath, fail})` 优先，退化 `wx.removeSavedFile`，两者皆无或抛错则静默返回 `false`；`onLoad` `:78-79` 初始化 `_recTempFilePath`。
- 调用点（`voice.js`）：`:300`（`releaseRecorder`，覆盖返回/切页/切后台/门禁失效）、`:757`（登记产物）、`:774`（时长超限）、`:792`（摘要读不出）、`:804`（字节超限）、`:855`（非 real 模式）、`:881`（**上传成功**）、`:886`（上传失败）；另有 7 处「在途资格失效」守卫（`:761/790/802/836/850/869/884`）也一并丢弃。
- 文案纪律：**不**在任何 `recordStageNote` 里宣称「已清理」；删不掉不改 UI、不当业务失败。

### 6.3 修：上传号只复位一半，导致 `transcriptMediaRef` 拼出 `media_id: null` 的伪引用（「录音态泄漏」类）

- 修复前：`voice.js:193`（旧 `:191`）`uploadedMediaId` 初值 `null`，而 `transcriptMediaRef`（旧 `:879-889`）判据是 `this.data.uploadedMediaId !== ''`——对 `null` **恒真**；同时 10 处把 `uploadedMediaId` 复位成 `null` 的 patch 都**没有**复位 `uploadedMediaRevision`（只在上传成功时 `:874` 赋 `media.mediaRevision`）。
  ⇒ 一次成功上传后再失败/离页，`uploadedMediaRevision` 仍是旧值，`transcriptMediaRef()` 返回 `{media_id: null, media_revision: N}`；`POST /speech/transcriptions` 在本地 uuid 校验处以 `INVALID_INPUT` 失败（用户看到「本地参数不合法」），而**正确**行为是「没有可用的录音引用」（不发请求）。
- 修复后：`data.uploadedMediaRevision: 0` 显式声明（`:195`，带「成对存在」注释）；10 处复位点成对写 `uploadedMediaId: null, uploadedMediaRevision: 0`；`transcriptMediaRef`（`:936-951`）判据收紧为 `typeof uploadedMediaId === 'string' && uploadedMediaId !== '' && uploadedMediaRevision >= 1`。

### 6.4 新增测试（`tests/unit/miniprogram-i11-voice-input.test.mjs`，+354 行 / 10 个 test）

被测对象是**仓库真代码**（页面与 `voice-api.js` 经 vm 加载），只替换平台与其它域的边界（`wx`、门禁、鉴权、`identify-api`、录音端口）。正例与反例成对：

1. 403 `CONSENT_REQUIRED` ⇒ 码原样带出、`status=403`、**会话未清**；
2. 403 `SCOPE_DENIED` ⇒ 同上（两类 403 不同码，不折叠）；
3. **反例**：401 `SESSION_EXPIRED` ⇒ 仍归 `SESSION_REQUIRED` 且**清会话**（既有语义不回归）；
4. 上传成功 ⇒ 本机临时文件被删且 `_recTempFilePath` 清空；
5. 上传失败（503 `PROVIDER_UNAVAILABLE`）⇒ 同样删临时文件，且 `uploadedMediaRevision` 复位为 0；
6. 非 real 模式（`stub`）⇒ **零上传请求**、不发明 `media_id`、仍删临时文件；
7. 时长超限（61000ms）⇒ **零上传请求**、`uploadErrorCode='INVALID_INPUT'`、删临时文件；
8. 录音中离页 ⇒ 端口 `release` 被调用、上传号成对复位、已登记的临时文件被删；
9. 平台无文件系统能力 ⇒ `discardRecordFile()` 返回 `false`、**不抛**、路径仍清空、零删除调用；
10. `transcriptMediaRef` 在 `uploadedMediaId:null` + `revision:3` 时返回 `null`（旧缺陷现场），真实引用时正常返回两键。

**负控制（真跑）**：把 `miniprogram/pages/voice/voice.js` 与 `miniprogram/utils/voice-api.js` 暂存回未修版本后，本套 10 个用例 **10 red**；恢复后 **10 green**（读数见 §9）。

## 7. 拒绝做 / 未做（附理由）

- **没有**改 `packages/contracts/**`（含 `openapi.json`）、`.github/workflows/**`、迁移号、`deploy/**`。契约仍是既有 13 个 speech/media/conversation operation。
- **没有**新增 ErrorCode、没有新增页面、没有改 `voice.wxml`/`voice.wxss`（因此也没有加「去微信设置」按钮，见 §8-3）。
- **没有**碰 `miniprogram/utils/speech-autoplay.js`（派单要求「不要改它的语义」）；实际上该文件**在本基点不存在**（只在未合并的 TTS 分支），本片对播报链路零改动：`voice.js` 的合成/播放段（`:425-653`）未被编辑。
- **没有**改 `recorder-port.js`（端口行为已足够；本片只在页面侧补收尾），因此「唯一引用 `wx.getRecorderManager` 的文件」这条不变量继续成立（既有静态断言仍在跑）。
- **没有**把任何失败折叠成成功：非 real 模式、摘要读不出、超限、上传失败、转写超时、发送闸门不通过，全部零伪造、零「已回答」。
- **没有** push / 开 PR / 关 issue / 动 GitHub 凭据 / 动 `E:\GengYunPrivate\`。
- **没有**做真机与真实供应商验证（本机不具备，见 §9 末尾）。

## 8. 待裁决与风险（编号）

1. **音频容器元数据无剥离路径**：`services/api/src/media/service.ts:927-942` 只对图片剥离并写衍生件，音频原样存 `rawRef`；`packages/media/exif.mjs:432-440` 也不覆盖音频容器（ID3/其它 tags 保留）。是否要求音频同样「去元数据」需契约/服务端裁决（可能涉及新增用途约束或音频专用剥离器）。
2. **音频取不到字节**：音频分支 `derivativeRef` 恒 `null`，而读面（`services/api/src/media/service.ts:1218` 社区内容读面、`POST /media/{id}/access` 只回句柄）只读衍生件 ⇒ 即使将来放开客户端音频出口，**录音字节仍不可读**。若产品需要「听自己刚录的那条」，需先补契约与读面。
3. **被拒授权后的设置页入口未接线**：`recorder-port.js:293-295` 的注释承诺「由页面引导到设置页」，但页面无 `wx.openSetting`。补齐要改 `voice.wxml`（新按钮 + 无障碍/44px 令牌约束），属可见 UI 变更，本片未擅自扩范围。
4. **B7 统一状态层未接入语音页**：`voice.js` 走自造 `recordState`/`transcriptStage` 与逐码文案，`states.js` 的 `denied` 分支在本域不可达。若要统一，需要把「端侧临时态」定义成页面阶段词表并映射到 `state-view`（跨页改动，建议单独一片）。
5. **转写超时/失败后的服务端记录回收**：UI 已结算，但不发 `DELETE /speech/transcriptions/{id}`（契约里它是「删记录」而非「取消任务」）。是否需要「超时后清记录」需产品口径。
6. **未取得（不得当通过）**：真实微信开发者工具/真机录音与权限弹窗、真实 ASR 供应商、真实对象存储与访问网关、真实 PG17、GitHub CI（本机未跑远端流水线）。#11 的四条验收复选框（真实 ASR 可追溯 / 关键字段核对 / 私有保存与外发授权接 F13 / 第 6 节评估）**本片一条也不能判过**。
7. **既有套件抖动（如实登记）**：全量 `npm run test:unit` 两次出现**不同**的失败集（一次 4 个 `tests/media/*` 整文件崩、一次 `knowledge-order-sql-direction` + `local-dev-package`），单跑全部通过；同时本机 `npm install` 期间出现 `ENOMEM`/写入失败并导致 `node_modules/fastify` 一度损坏（重装该包后恢复）。⇒ 判定为**本机资源压力导致的环境抖动**，不是本片改动引起（本片只动 miniprogram 两个文件 + 一个新测试文件）。

## 9. 自检真实输出（本机实跑）

```
$ npm run lint
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。

$ node --test tests/unit/miniprogram-i11-voice-input.test.mjs
tests 10 / pass 10 / fail 0 / duration_ms ≈ 131

# 负控制：暂存回未修的 voice.js + voice-api.js 后同一套用例
✖ 10 条全红（10 fail）→ 恢复后 10 pass（见上）

$ node --test tests/unit/miniprogram-i11-voice-input.test.mjs \
    tests/unit/miniprogram-voice-hardening.test.mjs tests/unit/miniprogram-voice-playback.test.mjs \
    tests/unit/miniprogram-transcript-confirm.test.mjs tests/unit/miniprogram-identify.test.mjs \
    tests/unit/speech-cancel.test.mjs tests/unit/speech-service.test.mjs tests/unit/speech-state.test.mjs
tests 229 / pass 229 / fail 0

$ npm run test:unit        # 第 1 次
tests 3148 / pass 3143 / fail 4 / skipped 1
✖ tests/media/access.test.mjs、tests/media/audio.test.mjs、
  tests/media/chunk-transform-boundaries.test.mjs、tests/media/detect-exif.test.mjs（均为整文件崩，未计内部用例）

$ npm run test:unit        # 第 2 次（同一工作树、无代码改动）
tests 3238 / pass 3234 / fail 3 / skipped 1
✖ knowledge-order-sql-direction.test.mjs、local-dev-package.test.mjs（"Windows local password generator …"）

# 抖动证伪：上述失败集单独跑
$ node --test tests/media/access.test.mjs tests/media/audio.test.mjs \
    tests/media/chunk-transform-boundaries.test.mjs tests/media/detect-exif.test.mjs
tests 98 / pass 98 / fail 0
$ node --test tests/unit/knowledge-order-sql-direction.test.mjs
tests 5 / pass 5 / fail 0
$ node --test tests/unit/local-dev-package.test.mjs
tests 4 / pass 4 / fail 0

$ npm run test:mini
PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.
tests 6 / pass 6 / fail 0
```

以上全部为本机读数；`npm run test:mini` 不接触真实微信工具（其输出自带「Not a WeChat compiler or device test」），测试里的平台侧一律是探针。

## 10. 文档行号漂移（本片改动导致）

本片在 `voice.js` 增约 90 行（`onLoad` +2、`releaseRecorder` 内 +2、新增 `discardRecordFile` 约 21 行、各结局 +若干），在 `voice-api.js` 增约 29 行（`request()` 之前插入归因助手）。据此需要更新的既有引用：

| 文件 | 旧引用 | 现状 |
| --- | --- | --- |
| `docs/verification/gy-i02-stale-claims-20261016.md:62` | `miniprogram/pages/voice/voice.js:770`（「真实对象存储未接线」） | 现为 `voice.js:859` |
| `docs/verification/gy-i13-tts-http-20261012.md:223` | `miniprogram/pages/voice/voice.js:491`（自动播放失败出口） | 已重取 `:491`（原 `:392` 已漂移；该断言内容仍成立） |

其余同族证据页（`gy-i11-speech-http-20261012.md`、`gy-i11-transcript-confirm-20261016.md`、`gy-r27-speech-cancel-20261020.md`、`gy-r28-speech-*.md`）引用的是**服务端**文件与契约，本片未触碰，行号不受影响。
