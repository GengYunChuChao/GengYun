# GY-I11 语音转写核对（可编辑 · 确认后发送）客户端切片 — 2026-10-16

范围：**仅 stub/preset_demo 局部实现**（派单口径）。实现基线 `main@cf2f5ed`，工作分支
`step/gy-i11-transcript-confirm-20261016`。写手：WorkBuddy Step（本地实现与自检）；
由指挥侧推送并提交 PR，未直接改 main。

分支现有两个本地提交：`d99a093`（切片主体）与随后的完善提交（受理幂等、受理在途取消、
版本冲突重读三项加固及回归）。两者均可由指挥 squash 后建 PR。

## 1. 本片做了什么

在已合并的转写服务端四端点（`POST /speech/transcriptions`、`GET`、`PATCH .../confirmation`、
`DELETE`）与问答轮次面（`POST /conversations/{id}/turns`，`SpeechTurnInput`）之上，补齐**客户端消费层**：

| 文件 | 改动 |
| --- | --- |
| `miniprogram/utils/speech-transcript.js` | 新增：四端点 + 建会话 + 发轮次的消费层；契约闭集校验（Transcription 七键／Job 九键／Ack／Conversation／TargetRef）；`If-Match` 与 `Idempotency-Key` 装配；**发送闸门** `evaluateSendGate`（纯函数）；尝试级幂等键 `stableKey`；逐码文案 |
| `miniprogram/pages/voice/voice.js` | 新增「④ 转写核对」区：受理→轮询→可编辑正文→核对并发送→取消；代次/epoch 守卫；迟到响应单调保护；冲突重读出口 |
| `miniprogram/pages/voice/voice.wxml` / `.wxss` | 同上区的界面与可编辑正文样式（文档流、无 fixed/absolute、触控下限与字号随令牌） |
| `tests/unit/miniprogram-transcript-confirm.test.mjs` | 新增 21 项回归（假 transport + 真实页面/模块代码） |
| `tests/integration/transcript-confirm-http.mjs` | 新增 5 组回环集成（真实 `buildApp` stub + loopback + 未经修改的原生客户端模块） |
| `tools/prepare-wechat.mjs` | 打包允许清单加入 `utils/speech-transcript.js` |
| `docs/ui-state-inventory.md` | 替身边界表「语音转写与播放」行更新为实测状态 |
| `package.json` | `test:integration:http` 链纳入新回环脚本（沿用 #216 先例，名单制非 glob） |

## 2. 三条红线如何落地

1. **可编辑 + 用户明确确认后才发送**：`PATCH .../confirmation`（`confirmation:
   'checked_and_sendable'`）是唯一写 `confirmed_text` 的入口；发送前必须过
   `evaluateSendGate`——未经本机一次成功确认、已取消、操作已作废、记录缺失、
   revision 不符、服务端记录未确认/正文不一致，一律**零请求**。他人会话确认过
   **不**放行（闸门只认本机一次成功 PATCH）。
2. **取消/失败/迟到回调不得外发**：取消先本地永久关闭闸门再发 `DELETE`（删除失败也不重开）；
   迟到响应只允许**单调**更新展示（revision 只进不退），永远不写已确认快照；
   离页/切页经 `cancelAll()` 使在途回调整体失效；受理在途也可取消（迟到 202 被代次守卫丢弃）。
3. **确认/发送/受理都幂等**：同一次尝试（同正文、同 revision、同媒体引用）的重试复用同一把
   `Idempotency-Key`（服务端同键回放）；受理落定后尝试结束、再转写是新键；
   确认撞 409 后按服务端最新记录重读刷新，不让用户拿着过期 revision 反复重试；
   双击被 busy 守卫挡下。

## 3. 自查证据（本机实测）

| 检查 | 结果 |
| --- | --- |
| `node --test tests/unit/miniprogram-transcript-confirm.test.mjs` | 21 通过 / 0 失败 |
| `node --test tests/unit/miniprogram-voice-playback.test.mjs`（既有，页面新增区不破坏） | 58 通过 / 0 失败 |
| `node tests/integration/transcript-confirm-http.mjs` | 5 组全过 |
| `npm run test:integration:http`（全链 8 脚本） | 通过 |
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

## 5. 交付检查单（供监工/指挥逐项核对）

| # | 检查项 | 证据位置 / 命令 |
| --- | --- | --- |
| 1 | 范围未越界：只动客户端消费层与页面，未改契约、未新增错误码、未动服务端 | `git diff cf2f5ed --stat`（11 文件，无 `services/`、无 `packages/contracts/`） |
| 2 | 红线一：未经明确确认不外发 | 单测 D/H 层；`evaluateSendGate` 纯函数负例（B 层） |
| 3 | 红线二：取消/失败/迟到不外发 | 单测 I/J/K/L 层；集成 [2][4] |
| 4 | 红线三：确认/发送/受理幂等 | 单测 C/F/G 层；集成 [1][3]（同键重放不重复写入/不建第二条轮次/不二次调用提供者） |
| 5 | 请求形状逐项合契约 | 单测 E 层（两字段/四字段闭集体、If-Match 取值、ETag） |
| 6 | 测试有效性（非恒绿） | §3 变异验证记录 |
| 7 | 打包与清单一致 | `tools/prepare-wechat.mjs` 含 `utils/speech-transcript.js`；`npm run test:mini` |
| 8 | 既有页面行为不回归 | `miniprogram-voice-playback` 58/58 |
| 9 | 全量单测无新增失败 | `npm run test:unit`；注意既有 `tests/moderation/http-screening.test.mjs` 4 项 cancelledByParent 在基线 cf2f5ed 同样复现，与本片无关 |
| 10 | 替身如实标注、不冒充真实能力 | `SUBSTITUTE_RECORD_NOTE`、替身 model_version 断言、本文件 §4 |
| 11 | 已由指挥侧推送并提交 PR；未直接改 main；`Refs #11` 不关整项 | PR #248、固定 HEAD `2f0ddf8`、本文件 §4 |
