# GY-I11 语音转写核对（可编辑 · 确认后发送）客户端切片 — 2026-10-16

范围：**仅 stub/preset_demo 局部实现**（派单口径）。基线 `main@cf2f5ed`，工作分支
`step/gy-i11-transcript-confirm-20261016`。写手：WorkBuddy Step（本地实现与自检，
未推送、未建 PR、未改 main）。

## 1. 本片做了什么

在已合并的转写服务端四端点（`POST /speech/transcriptions`、`GET`、`PATCH .../confirmation`、
`DELETE`）与问答轮次面（`POST /conversations/{id}/turns`，`SpeechTurnInput`）之上，补齐**客户端消费层**：

| 文件 | 改动 |
| --- | --- |
| `miniprogram/utils/speech-transcript.js` | 新增：四端点 + 建会话 + 发轮次的消费层；契约闭集校验（Transcription 七键／Job 九键／Ack／Conversation／TargetRef）；`If-Match` 与 `Idempotency-Key` 装配；**发送闸门** `evaluateSendGate`（纯函数）；尝试级幂等键 `stableKey`；逐码文案 |
| `miniprogram/pages/voice/voice.js` | 新增「④ 转写核对」区：受理→轮询→可编辑正文→核对并发送→取消；代次/epoch 守卫；迟到响应单调保护 |
| `miniprogram/pages/voice/voice.wxml` / `.wxss` | 同上区的界面与可编辑正文样式（文档流、无 fixed/absolute、触控下限与字号随令牌） |
| `tests/unit/miniprogram-transcript-confirm.test.mjs` | 新增 18 项回归（假 transport + 真实页面/模块代码） |
| `tests/integration/transcript-confirm-http.mjs` | 新增 5 组回环集成（真实 `buildApp` stub + loopback + 未经修改的原生客户端模块） |
| `tools/prepare-wechat.mjs` | 打包允许清单加入 `utils/speech-transcript.js` |
| `docs/ui-state-inventory.md` | 替身边界表「语音转写与播放」行更新为实测状态 |
| `package.json` | `test:integration:http` 链纳入新回环脚本（沿用 #216 先例，名单制非 glob） |

## 2. 三条红线如何落地

1. **可编辑 + 用户明确确认后才发送**：`PATCH .../confirmation`（`confirmation:
   'checked_and_sendable'`）是唯一写 `confirmed_text` 的入口；发送前必须过
   `evaluateSendGate`——未经本机一次成功确认、已取消、操作已作废、记录缺失、
   revision 不符、服务端记录未确认/正文不一致，一律**零请求**。
2. **取消/失败/迟到回调不得外发**：取消先本地永久关闭闸门再发 `DELETE`（删除失败也不重开）；
   迟到响应只允许**单调**更新展示（revision 只进不退），永远不写已确认快照；
   离页/切页经 `cancelAll()` 使在途回调整体失效。
3. **确认与发送都幂等**：同一次尝试（同正文、同 revision）的重试复用同一把
   `Idempotency-Key`（服务端同键回放）；双击被 `transcriptBusy` 守卫挡下。

## 3. 自查证据（本机实测）

| 检查 | 结果 |
| --- | --- |
| `node --test tests/unit/miniprogram-transcript-confirm.test.mjs` | 18 通过 / 0 失败 |
| `node --test tests/unit/miniprogram-voice-playback.test.mjs`（既有，页面新增区不破坏） | 58 通过 / 0 失败 |
| `node tests/integration/transcript-confirm-http.mjs` | 5 组全过 |
| `node tools/check-wechat-project.mjs` | PASS |
| `node tools/run-python.mjs tools/validate_development_docs.py` | PASS |
| `git diff --check` | clean |

**测试有效性（变异验证）**：临时把闸门的 `cancelled` 分支改为恒真 ⇒ 目标用例转红；
临时删掉迟到响应的 revision 单调保护 ⇒ 目标用例转红；恢复后均全绿。

集成侧关键读数（回环观察）：同键重放确认 ⇒ revision 仍为 2（无第二次写入）；
同键重放发送 ⇒ 轮次恰 1 条且 `input_text === confirmed_text`、
`transcription_ref = {type:'transcription', id, revision:2}`；未确认即发送 ⇒ 服务端
`INPUT_UNCERTAIN` 且零轮次；取消后发送 ⇒ `NOT_FOUND` 且零轮次；静默桶 ⇒ 任务
`uncertain/INPUT_UNCERTAIN`、记录 404、零新增会话/轮次。

## 4. 替身与边界（不得外推）

- 本地替身工程（`debug.localEnabled`）才可见两条**明确标注的替身录音引用**
  （固定 uuid，对应 stub 分桶 normal/silent）：不是真实上传、不读取任何录音字节、
  不构成真实请求号；`preset_demo` 下提供者返回固定演示句。
- **真实 ASR 未接线**：替身文本不构成任何识别效果或准确率证据；真实媒体引用只能来自
  real 模式的真实上传产物。
- **GY-I11 整项未完成**：主动录音授权交互细节、真实供应商适配与评估（GY-I21 的 50 段）、
  Android 实机、微信端原生渲染均未在本片验收；本片不关闭整项 issue。
- 回答任务只回报受理事实（job id/state），回答内容呈现属问答页后续切片。
