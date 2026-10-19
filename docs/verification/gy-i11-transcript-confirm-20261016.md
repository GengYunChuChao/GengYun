# GY-I11 语音转写核对（可编辑 · 确认后发送）客户端切片 — 2026-10-16／修复 2026-10-19

范围：**仅 stub/preset_demo 局部实现**（派单口径）。实现基线 `main@cf2f5ed`，工作分支
`step/gy-i11-transcript-confirm-20261016`。写手：WorkBuddy Step（本地实现与自检）；
由指挥侧推送并提交 PR（#248），未直接改 main。

**刷新记录（2026-10-19，应指挥派发）**：分支已 rebase 到 `main@0856e49`（原基线 `95b8e7c`），
并按新基线复跑全部检查；修复监工在 PR #248 指出的 **P2：发送结果未知时重试会生成新的
revision 和幂等键**（详见 §3）。分支现为三个提交：切片主体、三处加固、P2 修复
（rebase 后 SHA 已变，以 PR 页 HEAD 为准）。

## 1. 本片做了什么

在已合并的转写服务端四端点（`POST /speech/transcriptions`、`GET`、`PATCH .../confirmation`、
`DELETE`）与问答轮次面（`POST /conversations/{id}/turns`，`SpeechTurnInput`）之上，补齐**客户端消费层**：

| 文件 | 改动 |
| --- | --- |
| `miniprogram/utils/speech-transcript.js` | 新增：四端点 + 建会话 + 发轮次的消费层；契约闭集校验（Transcription 七键／Job 九键／Ack／Conversation／TargetRef）；`If-Match` 与 `Idempotency-Key` 装配；**发送闸门** `evaluateSendGate`（纯函数）；尝试级幂等键 `stableKey`；逐码文案 |
| `miniprogram/pages/voice/voice.js` | 新增「④ 转写核对」区：受理→轮询→可编辑正文→核对并发送→取消；代次/epoch 守卫；迟到响应单调保护；确认/发送两条冲突重读出口；**发送重试复用原发送身份**（§3） |
| `miniprogram/pages/voice/voice.wxml` / `.wxss` | 同上区的界面与可编辑正文样式（文档流、无 fixed/absolute、触控下限与字号随令牌） |
| `tests/unit/miniprogram-transcript-confirm.test.mjs` | 新增 25 项回归（假 transport + 真实页面/模块代码）；假 transport 的 PATCH/GET/轮次路由按**服务端真实语义**建模（同键回放不推进 revision、新键 `revision + 1`、If-Match 不符 409、读面反映确认态） |
| `tests/integration/transcript-confirm-http.mjs` | 新增 6 组回环集成（真实 `buildApp` stub + loopback + 未经修改的原生客户端模块） |
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
   **发送结果未知后的重试复用原发送身份**——同一 `transcriptionRevision` + 同一把发送键，
   且**不再重复确认**（否则服务端 `revision + 1` 会连带换掉发送键，见 §3）；
   确认/发送撞 409 后按服务端最新记录重读刷新，不让用户拿着过期 revision 反复重试；
   双击被 busy 守卫挡下。

## 3. P2 修复：发送结果未知时重试不再生成新 revision 与新键（2026-10-19）

**缺陷（监工在 PR #248 指出）**：用户点「核对并发送」→ 确认成功（服务端 `revision` 1→2）→
发送请求结果未知（网络未能确认）→ 用户再次点击。旧代码把整条流程重跑一遍：
`recordRevision` 已是 2 ⇒ 确认描述符 `confirm:<id>:2:<正文>` 与首次不同 ⇒ `stableKey`
换**新键** ⇒ 服务端 `confirmTranscription` 对新键执行写入，`revision` 2→**3** ⇒
发送描述符 `send:<id>:3` 又换一把**新发送键** ⇒ 服务端把这次重发当成**另一笔**发送。
若首次发送其实已到达服务端，结果是**重复轮次**；页面提示却写着「同一尝试复用同一幂等键」
（不实）。

**根因链**（均已核实）：`services/api/src/speech/service.ts` 的 `confirmTranscription`
经 `runIdempotentWrite`——同键同体回放（不推进 revision）、**新键则 `revision + 1`**；
`miniprogram/pages/voice/voice.js` 的发送描述符含 `confirmed.revision`，故 revision 一涨、
发送键必换。

**修复**（`voice.js`，两处）：

1. **重试复用判定 `reuseConfirmed`**：本机已成功确认、且 `confirmed.text === 当前正文`、
   `record.revision === confirmed.revision`、服务端记录确为已确认态 ⇒ **跳过 PATCH**，
   直接进发送闸门并以原 `_sendAttempt` 重发（同 revision、同键）。只有**正文变化**或
   **revision 变化**才算新尝试，才重新确认（换键、推进 revision、换发送键）。
2. **发送撞 409/404 先重读再决定**（新增 `resyncAfterSendConflict`）：记录仍在且 revision
   与已确认快照一致 ⇒ 冲突在会话侧 ⇒ 回到 ready，**同一把发送键**可重试（会话自动重建）；
   revision 变了 ⇒ 按服务端最新记录刷新、清确认尝试键，让用户**重新明确确认**（新尝试）；
   记录已不存在 ⇒ 如实失败并关闭本流。旧代码不区分这两种冲突，"可重试"提示对转写侧冲突
   是空头承诺（原样重试必然再冲突）。

**为什么不在客户端绕过**：幂等是服务端语义，客户端能做的只有**稳定地复用同一把键**；
换键等于声明"这是另一笔请求"，服务端无从去重。

**回归**（新增 4 项单测 + 1 组集成）：

| 用例 | 锁住的行为 |
| --- | --- |
| 单测·发送结果未知后重试 | 零新增 PATCH（revision 不推进）、同一把发送键、读面 revision 仍为 2 |
| 单测·发送失败后改正文 | 新尝试：新确认键、If-Match 基于已确认 revision、新 revision、新发送键 |
| 单测·发送撞冲突（转写侧已变） | 重读刷新到最新 revision；不自动重发；重新确认后才发新 revision |
| 单测·发送撞冲突（会话侧） | 转写身份未变 ⇒ 不重新确认，同一把发送键重试即成功 |
| 集成 [6]·响应丢失后重试 | 真实服务器：请求已处理但响应丢失 ⇒ 同键同 revision 重发 ⇒ 仍只 1 条轮次、revision 仍为 2 |

## 4. 自查证据（本机实测，基线 `0856e49`）

| 检查 | 结果 |
| --- | --- |
| `node --test tests/unit/miniprogram-transcript-confirm.test.mjs` | 25 通过 / 0 失败 |
| `node --test tests/unit/miniprogram-voice-playback.test.mjs`（既有，页面新增区不破坏） | 58 通过 / 0 失败 |
| `node tests/integration/transcript-confirm-http.mjs` | 6 组全过 |
| `npm run test:integration:http`（全链 13 脚本） | 12 个通过；`ocr-http.mjs` 因**本机 node_modules 是目录联接（junction）**触发其模块注册表检查（裸导入解析到仓外），纯净基线 `0856e49` 同样复现，与本片无关；其前 7 个与其后 4 个脚本均通过 |
| `npm run test:unit`（全量） | 2605 项 / 2542 过 / 0 新增失败 / 55 cancelled / 1 skipped |
| `node tools/check-wechat-project.mjs` | PASS |
| `node tools/run-python.mjs tools/validate_development_docs.py` | PASS |
| `npm run lint` | PASS |
| `git diff --check` | clean |

**全量单测的 7 项失败：既有环境问题，与本片无关**（已用纯净 `0856e49` worktree 同命令复现同一组失败）：
全部来自 GY-I24 已合入的 `tests/unit/release-materials-index-strict.test.mjs`（6 项）与
`tests/unit/release-materials-index.test.mjs`（1 项）。根因：这两个文件的"镜像"机制把
**工作区文件**（本机 `core.autocrlf=true` ⇒ CRLF）以 `-c core.autocrlf=false` `add -A`
提交进临时 git 仓 ⇒ 镜像 blob 带 CR ⇒ 我此前为 GY-I24 写的门禁「CVM 脚本提交内容为 LF
（blob 判据）」转红。Linux/CI 签出为 LF 时该组为绿；属 Windows 签出环境与镜像机制的组合
问题，**不是**本片改动引入（本片未触达 `deploy/`、`tools/verify-release-materials.mjs`
与这两个测试文件）。建议由 GY-I24 材料 Owner 处置（如镜像提交时按 LF 归一化）。

**测试有效性（变异验证）**：

- 临时把 `reuseConfirmed` 改为恒假（= 恢复旧行为"重试必重新确认"）⇒ 3 项目标用例转红
  （P2 核心回归、既有发送重试用例、会话侧冲突重试用例）；
- 临时删掉发送冲突重读（= 恢复旧行为"只丢会话记录"）⇒ 转写侧冲突回归转红；
- 恢复后均全绿。

> 注：早期版本的假 transport「PATCH 恒返 revision 2、GET 恒返未确认态」，使
> 「重试又确认一次」的真实后果不可见（既有发送重试用例因此是空转的）。本次已把假
> transport 的 PATCH/GET/轮次路由改为按服务端语义建模，上述变异才可被观测。

集成侧关键读数（回环观察）：同键重放确认 ⇒ revision 仍为 2（无第二次写入）；
同键重放发送 ⇒ 轮次恰 1 条且 `input_text === confirmed_text`、
`transcription_ref = {type:'transcription', id, revision:2}`；**响应丢失后同键重发 ⇒
仍 1 条轮次、revision 仍为 2**；未确认即发送 ⇒ 服务端 `INPUT_UNCERTAIN` 且零轮次；
取消后发送 ⇒ `NOT_FOUND` 且零轮次；静默桶 ⇒ 任务 `uncertain/INPUT_UNCERTAIN`、
记录 404、零新增会话/轮次。

## 5. 替身与边界（不得外推）

- 本地替身工程（`debug.localEnabled`）才可见两条**明确标注的替身录音引用**
  （固定 uuid，对应 stub 分桶 normal/silent）：不是真实上传、不读取任何录音字节、
  不构成真实请求号；`preset_demo` 下提供者返回固定演示句。
- **真实 ASR 未接线**：替身文本不构成任何识别效果或准确率证据；真实媒体引用只能来自
  real 模式的真实上传产物。
- **GY-I11 整项未完成**：主动录音授权交互细节、真实供应商适配与评估（GY-I21 的 50 段）、
  Android 实机、微信端原生渲染均未在本片验收；本片不关闭整项 issue。
- 回答任务只回报受理事实（job id/state），回答内容呈现属问答页后续切片。

## 6. 交付检查单（供监工/指挥逐项核对）

| # | 检查项 | 证据位置 / 命令 |
| --- | --- | --- |
| 1 | 范围未越界：只动客户端消费层与页面，未改契约、未新增错误码、未动服务端 | `git diff 0856e49 --stat`（无 `services/`、无 `packages/contracts/`） |
| 2 | 红线一：未经明确确认不外发 | 单测 D/H 层；`evaluateSendGate` 纯函数负例（B 层） |
| 3 | 红线二：取消/失败/迟到不外发 | 单测 I/J/K/L 层；集成 [2][4] |
| 4 | 红线三：确认/发送/受理幂等；**重试复用原发送身份** | 单测 C/F/G/H 层；集成 [1][3][6] |
| 5 | P2 定向：发送结果未知后零新增 revision、零新键、零重复轮次 | §3；单测 F 层 + 集成 [6]；§4 变异验证 |
| 6 | 请求形状逐项合契约 | 单测 E 层（两字段/四字段闭集体、If-Match 取值、ETag） |
| 7 | 测试有效性（非恒绿） | §4 变异验证记录（两组变异各打红目标用例） |
| 8 | 打包与清单一致 | `tools/prepare-wechat.mjs` 含 `utils/speech-transcript.js`；`npm run test:mini` |
| 9 | 既有页面行为不回归 | `miniprogram-voice-playback` 58/58 |
| 10 | 全量单测无新增失败 | `npm run test:unit`：2542 过 / 0 新增失败；7 项既有失败与 55 项 `cancelledByParent` 均为环境既有现象（见 §4 末），纯净基线同样复现 |
| 11 | 替身如实标注、不冒充真实能力 | `SUBSTITUTE_RECORD_NOTE`、替身 model_version 断言、本文件 §5 |
| 12 | 已由指挥侧推送并提交 PR；未直接改 main；`Refs #11` 不关整项 | PR #248、HEAD 见 PR 页、本文件 §5 |
