# GY-I13 合成接共享作业源 + 客户端播放生命周期 验证

日期：2026-10-14（香港时间）。口径：`Refs #13`，**不关闭整项**（本片只交付可离线验证的代码面）。

- 实现者＝写手（本 worktree、本分支）；推送者＝指挥。**本 worktree 不 push、不改共享 remote/配置。**
- 本片**未**接入任何真实 TTS 供应商、**未**发起任何付费或真实模型调用、**未**产生任何真实音频。
- 本页所有数字与结论都来自下方**逐条原始输出**；凡未跑的命令一律不写"通过"。

## 0 工作区与基线

| 项 | 值 |
| --- | --- |
| 共享仓库 | `E:\GengYunCommander\GengYun_Agent2`（本片**只读**，未改其分支/文件） |
| worktree | `E:\GengYunCommander\GengYun_W38` |
| 分支 | `feat/gy-i13-synthesis-jobs` |
| 基线 `upstream/main` | `ddeb301d7fa308023ccbd19e46c0c26871cf75a3`（`git fetch upstream --prune` 后核对，与派单给出的 `ddeb301` 一致） |
| HEAD | 本页自身即最后一个提交（`docs(GY-I13): 证据页…`）；其 SHA 会因本页修订而变化 ⇒ **权威 HEAD 以回传为准**。5 个代码/测试提交见 §6 |
| 依赖 | 直连 `npm install`（**无** junction/symlink 指向别处 `node_modules`） |

## 1 变更 1：合成域接入共享作业源（服务端）

### 1.1 现状核对（以实际路径为准，未新建 `synthesis/**`）

- 共享作业源/跟进组件（PR #125 已合并）在 `services/api/src/jobs/{registry.ts,sources.ts,routes.ts,result-shape.ts}`；
  既有 `*JobSource` 范例为 `jobs/sources.ts` 的 `createRecognitionJobSource`、`createTranscriptionJobSource`，
  以及 `moderation/job-source.ts` 的 `createModerationJobSource`（**只读参考，本片未改 `moderation/**`**）。
- 合成服务层实际位于 **`services/api/src/tts/**`**（派单写作 `synthesis/**`，以实际为准）：`tts/service.ts` 已合并并导出
  `createSynthesis` / `inspectJob` / `verifyUsable` / `settle` / `describe`；**有 `inspectJob`，本基线没有 `cancelJob`**。
- `services/api/src/routes/synthesis.ts` 已存在且**已**在 `app.ts` 注册（`POST /speech/synthesis`）。
- **本片缺口**：`app.ts` 的 `createJobRegistry([...])` 当时只注册 `recognition` / `transcription` / `moderation`
  ⇒ `kind=synthesis` 在 `GET /jobs/{id}` 上仍按"未接线 kind"同形 404。

### 1.2 改动

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `services/api/src/jobs/sources.ts` | **纯追加** `createSynthesisJobSource(service)`（+38 行）与文件头一段追加说明 | 既有两个源函数体**一字未改** |
| `services/api/src/app.ts` | import 行加入 `createSynthesisJobSource`；`createJobRegistry([...])` 数组**末位追加**一行 | 既有 recognition/transcription/moderation 三项**位置与内容逐字不变**；先确认 `'synthesis'` 未被注册（注册表 kind 重复即抛） |

`createSynthesisJobSource` 的语义（与既有三源同形）：

- `kind: 'synthesis'`；`get` 调用 `service.inspectJob({ userId, jobId })`（**只读复用**域内读面）；
- 域内 `getOwnedJob` 对「不存在」「他人作业」「非 uuid」一律抛 `ApiError('NOT_FOUND')`，适配层用本文件既有的
  `isNotFound` 映射为 `null` ⇒ 注册表无法也不需要区分 ⇒ 对外**同形 404**；
- **省略 `cancel`**（照 `createTranscriptionJobSource` 先例）：本基线 `tts/service.ts` 没有取消入口，
  派单明令「不得在作业面上另写状态机」「不得改各域服务语义」⇒ 注册表会**先确认作业存在**，再以契约
  `503 PROVIDER_UNAVAILABLE`（`retryable: true`）如实拒绝；**不伪造 `cancelled`、不动 revision**；
- 出口仍由注册表 `assertContractJob` 统一守卫，本适配层**不放宽**任何 schema。

### 1.3 契约对齐（逐项抄准，**未改** `packages/contracts/**`）

| 契约位置 | 取值 | 本片 |
| --- | --- | --- |
| `components.schemas.Job.required` | 九键 `id,revision,kind,target_ref,state,deadline_at,created_at,error_code,result`，`additionalProperties:false` | 未新增/未删减字段，由 `assertContractJob` 逐键校验 |
| `components.schemas.Job.properties.kind.enum` | `recognition,ocr,transcription,answer,synthesis,moderation` | `'synthesis'` 本就是闭集成员 |
| `components.schemas.JobState.enum` | `queued,running,succeeded,uncertain,failed,timed_out,cancelled` | 未新增状态 |
| `components.schemas.TargetRef.properties.type.enum` | 16 值（含 `synthesis`） | 未新增 |
| `components.schemas.SynthesisResult` / `Synthesis` | `{kind:'synthesis', value:{id(uuid),revision,checked_content_ref(TargetRef),media_id(uuid)}}` | 镜像早已在 `jobs/result-shape.ts:208-213`，**本片未改它** |
| `x-error-status-map`（`states.json.error_status_map` 与 `openapi.json` 同值） | `404:[NOT_FOUND]`、`409:[REVISION_CONFLICT,IDEMPOTENCY_CONFLICT,OBJECT_UNAVAILABLE,REQUEST_IN_PROGRESS]`、`428:[REVISION_REQUIRED]`、`503:[PROVIDER_UNAVAILABLE,PROVIDER_OUTCOME_UNKNOWN]`、`504:[PROVIDER_TIMEOUT]` | 本片用到的 400/404/428/503 **全部落在闭集内**；未发明新错误码 |
| `packages/contracts/operations.json` | `getJob` = `GET /jobs/{id}`（`version_required:false`）；`cancelJob` = `POST /jobs/{id}/cancel`（`version_required:true`）；`createSynthesis` = `POST /speech/synthesis` | **只复用这三个既有 operation，未新增任何 path/operationId** |

反例（负向）锚点：`POST /jobs/{id}/cancel` 对合成作业 ⇒ **503**（能力未接线），而不是 `409 OBJECT_UNAVAILABLE`
（"对象当前不可用"）——依据即上表 `503` 闭集与项目"未接线 ⇒ fail-closed 503"的既有口径。

## 2 变更 2：客户端播放生命周期（原生小程序）

### 2.1 新增文件（全部为原生小程序侧，无第三方依赖）

| 文件 | 职责 |
| --- | --- |
| `miniprogram/utils/speech-text.js` | **安全检查闸门**（`check_state !== 'passed'` 一律阻断；正文缺失/超长阻断；待播报文本≠已核对正文阻断）+ **播报计划复核**（分段无损 + 数字/单位/制剂条件/否定词逐项计数） |
| `miniprogram/utils/audio-playback.js` | **播放生命周期控制器**（端口注入，纯逻辑）：单一播放者、分段播报、播放/暂停/停止/重播、失败分类（文案 + 主动播放按钮）、`listened` 语义、`release()` 幂等彻底 |
| `miniprogram/utils/inner-audio-port.js` | 生产播放端口：`wx.createInnerAudioContext` 的**唯一出现处**；缺能力时如实失败（不伪造 `ended`） |
| `miniprogram/utils/substitute-player.js` | **明确标注的替身播放端口**（不产生任何声音，只按真实事件顺序发 `play→ended`）；`substitute: true` ⇒ 控制器**不置「已听取」** |
| `miniprogram/utils/voice-api.js` | `POST /speech/synthesis` 与 `GET /jobs/{id}` 消费层（契约形状严格校验）；`audioSourceForJob` 如实回答"有没有可播音频"；`cancelAll()` 作废本机在途请求（**无**服务端取消语义） |
| `miniprogram/components/gy-voice-ball/*` | 统一**语音球** + 等效**播放/暂停/停止/重播**按钮 + 失败文案与主动播放按钮 |
| `miniprogram/pages/voice/voice.*` | 播报页（三段式宿主）：安全检查 → 合成 → 播放；返回/切页/隐藏共用同一个释放出口 |

### 2.2 硬口径与可复核判据

| 要求 | 实现 | 可复核判据（含负例） |
| --- | --- | --- |
| 安全检查在前，**完整通过后才合成及播报** | `assertSpeakable` 是唯一闸门；页面在闸门未过时**不调用** `createSynthesis`、**不创建**播放器 | 单测：`blocked/未知/缺失` ⇒ `SAFETY_CHECK_BLOCKED`；宿主页反例断言 `requests.length === 0` 且 `_controller === null` |
| 不绕过 #8 用量守卫/审核前置 | 页面**不自造**内容来源；请求体严格等于契约 `SynthesisInput`（只有 `checked_content_ref` + `locale`）；服务端 `real` 未接线一律 fail-closed | 单测：请求体逐字断言；`PROVIDER_UNAVAILABLE` 文案含"不落任务、不产生假音频" |
| 统一语音球 + 等效播放/暂停/停止/重播 | 组件同时提供语音球（主操作＝播放/暂停）与四个独立按钮 | 静态断言：`aria-role="button"` ≥6、四个按钮各有可读名称 |
| 触控区达标（320px 窄屏仍 ≥44px） | 控件一律 `min-height/min-width: var(--tap-min, 44px)`（**px**，非 rpx） | 静态断言：存在 `var(--tap-min, 44px)`；不存在 `min-height: <n>rpx` |
| 可被读屏识别 | 语音球与每个按钮都有 `aria-role="button"` + `aria-label`；状态以**文字**说明，不只靠颜色 | 静态断言见上 |
| 录音与播放控件分离 | 录音是独立控件且如实标注**能力边界**。（本片基线口径"**如实标注未接线**（`getRecorderManager` 一次都不调用）"**已过期**）**口径同步（截至 `e9353b4`）**：录音已接线——`#199`（`9794eba`）已并入 `upstream/main`；页面经注入端口真调原生能力（`miniprogram/pages/voice/voice.js:517`/`:533`，端口唯一调用点 `miniprogram/utils/recorder-port.js:205`，入口 `miniprogram/pages/voice/voice.wxml:193` `bindtap="onRecord"`），拒权/启动失败一律如实呈现、不假装在录 | 单测（现标题见 `tests/unit/miniprogram-voice-playback.test.mjs:907`）：页面**不得**直接调用平台录音能力（只能经 recorder-port）；`wx.getRecorderManager()` 唯一出现处必须是 recorder-port；下桩探针调用序列为 `['getRecorderManager','start','stop']`，成功后 `hasRecording === true`；失败不得留下"有录音可播"的假象 |
| 页面退出（返回/切页/隐藏）取消任务并释放音频与监听 | `onHide`/`onUnload` → `releaseAll()`：`stopPoll()` + `voiceApi.cancelAll()` + `controller.release()`；`release()` 递增代次 ⇒ 迟到回调失效 | 单测：释放后 `listenerCount() === 0`、活动句柄 0、迟到 `ended` 不置 `listened`、`play()` 返回 `RELEASED`；宿主页：`onHide` 后 `_controller === null`、在途响应不得进入播放段 |
| 避免重复播报 | 同一时刻最多一个活动句柄；同一计划重复 `play` ⇒ `ALREADY_PLAYING`，**不新建句柄、不重复出声** | 单测：`createdHandles` 不变、`plays === 1`；换计划先销毁旧句柄（`live === 1`） |
| 避免后台残留 | `release()` 退订全部监听（`on()` 必须返回退订函数）、`stop()`+`destroy()` 句柄、清空计划 | 单测：退出后 0 监听 0 句柄；代次守卫使迟到回调无效 |
| 自动播放失败 ⇒ 文案 + **主动播放按钮**，不假记"已听取" | 失败一律写 `failure{title,hint,actionText,manualStart:true,recordsListened:false}`；组件渲染文案 + 主动播放按钮 | 单测：空计划 ⇒ `SOURCE_UNAVAILABLE`，`listened === false`；宿主页：无音频源 ⇒ `playbackState==='failed'`、`failure.actionText` 非空、`listened === false` |
| 静音/蓝牙/拒权/平台阻止自动播放各有文案与按钮 | `FAILURE_PRESETS` 八类，四类关键分支文案**互不相同**；平台原始 `errMsg` 按特征归类 | 单测：四类 `title`／`hint`／`actionText` 三元组去重后仍为 4；`bluetooth/静音/permission/autoplay/decode/interrupt/未知` 逐条归类 |
| 数字/单位/制剂条件/否定词播报文本正确性 | `criticalTokens` 抽取 `数字+单位` 绑定对、裸数字、制剂/条件词、否定词；`verifySpeakPlan` 做"拼接逐字一致 + 逐项计数" | 单测正例 1 条；反例 6 条：数字被改写、单位丢失、制剂条件丢失、否定词丢失、截断、**多出**正文没有的否定词 |
| 控制不得遮挡提交按钮或风险信息 | 播报控件走正常文档流（页面/组件样式**无** `position:fixed/absolute`）；DOM 顺序为「风险信息 → 提交按钮 → 播报控件」 | 静态断言：无 fixed/absolute；`notice--danger < bindtap="onBroadcast" < <gy-voice-ball` |
| 适老不削弱既有保护 | 字号一律 `calc(Npx * var(--font-scale, 1))`；触控下限沿用 `--tap-min`；无 `nowrap`、无裁切 | 静态断言：含 `var(--font-scale`；无 `white-space: nowrap`；**未改** `app.wxss`/`styles/*`/既有页面 |

### 2.3 三段式与"未接线"的如实呈现

1. **安全检查**：本地替身样本（**仅** `debug.localEnabled` 为真时可见，页面显著标注"非真实资料、非真实核对结论"）
   用来离线核对闸门的两条路径（`passed` 正例 / `blocked` 反例）；**非本地替身工程下页面不提供任何样本**，
   也不发明内容来源。
2. **合成**：`POST /speech/synthesis` → 轮询 `GET /jobs/{id}`。七类 `JobState` 与 `error_code` 逐类如实显示。
   本基线下服务端替身核对源**没有**条目、`real` 模式的真实提供者**未接线** ⇒ 该步**必然如实失败**
   （已在原始输出中确认文案含"真实 TTS 提供者未接线"），页面不伪造任务。
3. **播放**：`audioSourceForJob` 在替身/未接线下**恒**返回 `SOURCE_UNAVAILABLE`（替身产物不是音频、真实产物下载链路未接线）
   ⇒ 走"自动播放失败"出口：文案 + 主动播放按钮 + **不记「已听取」**。
   完整播放生命周期（播放/暂停/停止/重播、分段、资源释放）由**明确标注的替身播放端口**在本地替身工程与回归里覆盖，
   且替身播放**只置 `substituteCompleted`，绝不置 `listened`**。

## 3 跨线改动逐处披露（最小/追加式，均可单点回退）

| # | 文件 | 改了什么 | 为何必要 | 回退方式 |
| --- | --- | --- | --- | --- |
| 1 | `services/api/src/jobs/sources.ts` | 追加 `createSynthesisJobSource` + 文件头一段追加说明（既有函数体未动） | 各域作业源适配器集中于此，与 recognition/transcription 同形态 | 删该函数与说明段（`33bd325` 反向） |
| 2 | `services/api/src/app.ts` | import 增 1 个符号；`createJobRegistry` 数组末位追加 1 行 | 共享作业面的**唯一注册点**；不追加则 `kind=synthesis` 仍同形 404 | 删该行 + import（`9995391` 反向） |
| 3 | `miniprogram/app.json` | `pages` 末尾追加 `pages/voice/voice` | 微信要求页面注册；三处清单必须逐项一致（既有断言） | 删该行（`706d132` 反向） |
| 4 | `miniprogram/utils/navigation.js` | `PAGES` 末尾追加同一路由（**未**加入 `TAB_PAGES`，未改任何路由判定逻辑） | `tests/unit/miniprogram-login-return-to.test.mjs:86` 断言 `PAGES === app.json.pages` | 删该行 |
| 5 | `tools/prepare-wechat.mjs` | 白名单追加：播报页 + 5 个 `utils/*` + `components/gy-voice-ball/*`（4 文件） | 隔离打包白名单与 `app.json.pages` **逐项同序**（脚本内 `JSON.stringify` 断言）；漏加 ⇒ 标准包 `MODULE_NOT_FOUND` | 删对应行 |
| 6 | `tests/local-debug.test.mjs` | 打包页数断言 `18 ⇒ 19`（注释同步说明新增播报页）；把播报域 5 个 utils 与 `gy-voice-ball` 4 文件纳入既有"打包依赖必须存在"清单 | 该断言是**硬编码页数**；新增页面必使其失效。派单 §5 明确要求"新增页面必须同步三处清单并附该命令输出" | 把 `19` 改回 `18` 并移除新增依赖项（`706d132` 反向） |

**未触碰**：`packages/contracts/**`、`services/api/src/community/**`、`services/api/src/moderation/**`、
`services/api/src/privacy/**`、`tts/service.ts` 及 TTS 域任何服务语义、`miniprogram/pages/identify/*`
（含其"未接入时不调用录音/播放能力"与"录音/播放两个独立按钮"两条既有断言）、`miniprogram/app.wxss`、
`miniprogram/styles/*`、`.github/workflows/**`、根 `package.json`/lock。

> 说明：#6 是**唯一**对已合并测试的修改，属派单要求的清单同步；改动面只有 1 个常量 + 注释 + 新增依赖项断言，
> 不删除、不放宽任何既有断言。

## 4 测试原始输出

### 4.1 服务端：合成接共享作业源（新增 9 例）

命令：`node --test tests/unit/tts-jobs-http.test.mjs`

```
✔ 接线·GET /jobs/{id} 读出 kind=synthesis 的契约 Job（九键/闭集/SynthesisResult），未接线的旧行为不变
✔ 接线·未注册的接口形态不新增：TTS 域仍只有 POST（GET/DELETE /speech/synthesis 仍是 404）
✔ 反例·他人作业 / 不存在的 uuid / 非法 uuid：前两者同形 404，非法 uuid 由 HTTP 层判 400
✔ 状态流转·失败：提供者失败 ⇒ failed + 契约 error_code（绝不伪装 succeeded），result 如实为 null
✔ 状态流转·无取消能力：cancel 如实 503 PROVIDER_UNAVAILABLE(retryable)，**不伪造 cancelled**、状态与 revision 不变
✔ 状态流转·取消能力缺失时缺请求头仍按既有口径：缺 Idempotency-Key ⇒ 400；缺 If-Match ⇒ 428
✔ 幂等·同 Idempotency-Key 重复请求收敛到同一 job_id（不新建任务、不重复调用提供者）
✔ 并发·同键并发请求只产生一条作业（作业读面可复核：id 唯一、状态终态）
✔ real 未接真实 TTS ⇒ 受理前 503 PROVIDER_UNAVAILABLE(retryable)，**不落任务、不产假音频**；stub 对照可用
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1264.9908
```

（`real` 对照用例同时断言 `providerAvailable=false`、`realAudioProduced=false`、提供者标注不含 `audio/mpeg|audio/wav`；
`stub` 对照断言 `SynthesisRow.substitute === true`。）

### 4.2 客户端播放生命周期（新增 30 例）

命令：`node --test tests/unit/miniprogram-voice-playback.test.mjs`

```
✔ 闸门·只有 check_state=passed 才放行；blocked/未知/缺失一律 SAFETY_CHECK_BLOCKED（不合成、不播报）
✔ 反例·passed 但待播报文本与已核对正文不一致 ⇒ TEXT_MISMATCH（客户端不得改写已核对正文）
✔ 反例·passed 但已核对正文缺失/超长 ⇒ CHECKED_TEXT_UNREADABLE（不得播报空内容）
✔ 分段·无损：任一段上限下，拼接结果与正文逐字一致、每段不超上限（不截断、不省略）
✔ 关键令牌·抽取：数字/单位绑定对、裸数字、制剂条件词、否定词都逐项可见
✔ 正例·分段播报计划通过复核（拼接逐字一致 + 关键令牌齐全）
✔ 反例·数字被改写 / 单位丢失 / 制剂条件丢失 / 否定词丢失 / 截断，各有可指出的判据
✔ 生命周期·单段自然播完才置「已听取」；播放中状态为 playing
✔ 生命周期·多段按序播报，只有最后一段结束才置「已听取」（段间不重复建句柄）
✔ 反例·重复播报：同一计划重复 play 不新建句柄、不重复出声；换计划必先销毁旧句柄
✔ 生命周期·暂停/继续/停止/重播：停止与暂停都**不**记「已听取」，重播重置计数
✔ 释放·release 幂等且彻底：监听 0、活动句柄 0，迟到回调不生效，之后 play 不再建句柄
✔ 失败·空计划 ⇒ SOURCE_UNAVAILABLE 文案 + 主动播放按钮，且**不**记已听取
✔ 失败·静音/蓝牙/拒权/平台阻止自动播放各有**不同**文案与按钮，且都不记已听取
✔ 失败·平台原始错误按特征归类（静音/蓝牙/拒权/自动播放阻止/解码/中断/未知）
✔ 失败·失败码闭集逐个走完控制器：状态 failed、无残留句柄/监听、一律不记已听取
✔ 失败·中断（来电/其它音频/蓝牙切换）不记已听取，并给出 PLAYBACK_INTERRUPTED 文案
✔ 替身播放·整份计划走完只置 substituteCompleted，**绝不**记「已听取」
✔ 真机端口缺能力 ⇒ 如实失败（不伪造播放完成、不记已听取）
✔ 宿主页·安全检查未过 ⇒ **零**合成请求、无播放器、不播报（反例）
✔ 宿主页·安全检查通过 ⇒ 恰好一次 POST /speech/synthesis（带 8..128 的 Idempotency-Key）
✔ 宿主页·合成成功但无可播音频 ⇒ 自动播放失败：文案 + 主动播放按钮，且不记已听取
✔ 宿主页·离页（隐藏/卸载）取消在途请求并释放播放器：监听 0、句柄 0、迟到回调无效
✔ 宿主页·录音控件与播报控件分离，且录音如实标注未接线（不调用任何录音能力）
✔ 无障碍·语音球与四个等效按钮都有 aria-role/aria-label（可被读屏识别）
✔ 布局·控件走正常文档流（无 fixed/absolute）、触控下限用 px 令牌、字号随 --font-scale
✔ 布局·播报控件在提交按钮与风险信息之后（DOM 顺序即不遮挡判据）
✔ 文案·新增文件不含绝对化风险表述
✔ 清单·三处页面清单逐项一致（app.json.pages / navigation.PAGES / prepare-wechat 白名单）
✔ 页面可被标准包加载：页面与组件的四个文件齐备且 json 合法（CJS，无 ESM 语法）
ℹ tests 30
ℹ suites 0
ℹ pass 30
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 201.4818
```

> **口径同步（截至 `e9353b4`）**：本块是 2026-10-14 的原始输出，**照录不改**。其中用例
> `✔ 宿主页·录音控件与播报控件分离，且录音如实标注未接线（不调用任何录音能力）` 的标题与断言已随
> `#199`（`9794eba`，已并入 `upstream/main`）变更：现标题为「宿主页·录音控件与播报控件分离（独立入口/独立状态，
> 页面仍不直接引用平台录音与播放能力）」（`tests/unit/miniprogram-voice-playback.test.mjs:907`），同文件另增 23 例
> 真实录音/上传用例（`:927` 起）。该行只反映本片基线，**不得据以判断当前录音能力**；其余 29 行的用例名在
> `e9353b4` 上仍逐字可见。

### 4.3 新增页面必附的三条自查（派单 §5）

命令：`node --test tests/unit/miniprogram-login-return-to.test.mjs`

```
ℹ tests 41
ℹ suites 0
ℹ pass 41
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 306.4791
```

（其中 `page and tab lists match actual app.json; each actual tab is accepted without query` 即 `PAGES === app.json.pages` 的锁定用例，
新增 `pages/voice/voice` 后仍逐项一致。）

命令：`node --test tests/local-debug.test.mjs`

```
✔ missing, public, wildcard, credential, unsafe path and mismatched configs fail (17.7579ms)
✔ apiBaseUrl accepts origin or origin plus a client-append base path without widening rejections (8.6573ms)
✔ actual HTTP service is synthetic, no-store and has no business routes (50.7182ms)
✔ client blocks trial/release/unknown environments and labels stub or failure (2.4273ms)
✔ isolated packaging excludes private files and rejects release overrides/stale output (3034.6713ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3197.6903
```

命令：`node tools/check-wechat-project.mjs`

```
PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.
```

## 5 门禁清单（命令 + 退出码 + 关键输出）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `npm run lint` | 0 | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）` / `lint 通过（静态检查；不代表运行期或真实服务已通过）。` |
| `npm run test:unit` | 0 | `ℹ tests 2001 / ℹ pass 2000 / ℹ fail 0 / ℹ skipped 1`（基线 1970 pass ⇒ 本片 +30 例并全部通过） |
| `node --test tests/unit/tts-jobs-http.test.mjs` | 0 | 9/9 pass（§4.1） |
| `node --test tests/unit/miniprogram-voice-playback.test.mjs` | 0 | 30/30 pass（§4.2） |
| `node --test tests/unit/miniprogram-login-return-to.test.mjs` | 0 | 41/41 pass（§4.3） |
| `node --test tests/local-debug.test.mjs` | 0 | 5/5 pass（§4.3） |
| `node tools/check-wechat-project.mjs` | 0 | `PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax.` |
| `npm run test:mini` | 0 | 先 `check-wechat-project` PASS，再 `tests/local-debug.test.mjs` 5/5 pass |
| `npm run test:docs` | 0 | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| `git diff --check` | 0 | 无输出（无空白错误） |

受影响既有面（另跑，均通过）：`node --test tests/unit/jobs-registry.test.mjs tests/unit/jobs-result-shape.test.mjs tests/moderation/http-jobs.test.mjs tests/unit/tts-service.test.mjs` ⇒ 68/68 pass。

根级 UI 用例（**不在任何 npm script 的 glob 内**，属 `.github/workflows/local-wechat.yml`）：

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --test tests/ui-adaptive.test.mjs` | 0 | 26/26 pass —— 其中包含「录音与播放为两个独立按钮，播放需先有录音（identify 页不得调用录音/播放能力）」「触控区为 44px 且使用 px 单位，320px 窄屏下仍成立」「正文为 18px 且不随屏宽缩放」三条既有红线，**未被本片削弱** |
| `node --test tests/ui-demo-align.test.mjs` | **1** | **失败，且与本片无关**：`miniprogram/styles/icons.wxss 与 demo SVG path 生成结果不一致，请运行 node tools/demo-align.mjs --write-icons`。证据：该用例的**全部输入**（`miniprogram/styles/**`、`docs/ui-demo/**`、`tools/demo-align.mjs`、该用例本身）在本分支相对 `upstream/main` 的 `git diff --name-only` 中**一个都没有出现** ⇒ 输入与基线 `ddeb301` 逐字节相同 ⇒ 该失败**在基线即已存在**，属**既有问题**，本片不修（修它需改 `styles/icons.wxss`，属 GY-I26 范围）。**不作"通过"声明。** |

## 6 提交清单（本地，未 push）

| SHA | 提交 |
| --- | --- |
| `33bd325` | `feat(GY-I13): 合成域作业源适配器（只读复用 inspectJob，无取消入口不伪造 cancelled）(Refs #13)` |
| `9995391` | `feat(GY-I13): 合成作业源注册进共享作业面（纯追加）与回环回归（Refs #13）` |
| `820984c` | `feat(GY-I13): 播报安全检查闸门、播放生命周期控制器与统一语音球组件（Refs #13）` |
| `706d132` | `feat(GY-I13): 播报页（语音球宿主）与三处页面清单同步（Refs #13）` |
| `1348b69` | `test(GY-I13): 客户端播放生命周期回归 30 例（含负例与 fail-closed 对照）（Refs #13）` |

其后还有 1 个**证据页**提交（`docs(GY-I13): 证据页（作业源接线 + 播放生命周期原始输出与未取得项）(Refs #13)`），
即本文件自身；其 SHA 随本页修订变化，故不在此固定（权威 HEAD 见回传）。

`git diff --stat upstream/main...HEAD`（实测）：

```
 docs/verification/gy-i13-synthesis-jobs-20261014.md | 312 +++++++++
 miniprogram/app.json                               |   3 +-
 miniprogram/components/gy-voice-ball/gy-voice-ball.js   | 117 ++++
 miniprogram/components/gy-voice-ball/gy-voice-ball.json |   4 +
 miniprogram/components/gy-voice-ball/gy-voice-ball.wxml |  76 ++
 miniprogram/components/gy-voice-ball/gy-voice-ball.wxss |  94 +++
 miniprogram/pages/voice/voice.js                   | 405 +++++++++++
 miniprogram/pages/voice/voice.json                 |   6 +
 miniprogram/pages/voice/voice.wxml                 | 178 +++++
 miniprogram/pages/voice/voice.wxss                 |  22 +
 miniprogram/utils/audio-playback.js                | 434 ++++++++++++
 miniprogram/utils/inner-audio-port.js              | 157 +++++
 miniprogram/utils/navigation.js                    |   5 +-
 miniprogram/utils/speech-text.js                   | 301 ++++++++
 miniprogram/utils/substitute-player.js             |  93 +++
 miniprogram/utils/voice-api.js                     | 330 +++++++++
 services/api/src/app.ts                            |   7 +-
 services/api/src/jobs/sources.ts                   |  38 +
 tests/local-debug.test.mjs                         |  13 +-
 tests/unit/miniprogram-voice-playback.test.mjs     | 770 +++++++++++++++++++++
 tests/unit/tts-jobs-http.test.mjs                  | 344 +++++++++
 tools/prepare-wechat.mjs                           |  16 +
 22 files changed, 3720 insertions(+), 5 deletions(-)
```

唯一被修改的既有**源码**文件是 `services/api/src/app.ts`（+7/−1，唯一删除行是 import 改写）与
`services/api/src/jobs/sources.ts`（纯追加）；其余修改均为**清单同步**（`app.json` / `navigation.js` /
`prepare-wechat.mjs` / `tests/local-debug.test.mjs`）。

## 7 未取得 / 未验证项（如实登记，不主张通过）

1. **真实 TTS 供应商：零调用**（未授权付费）。`real` 未接真实依赖一律 **fail-closed**：受理前
   `503 PROVIDER_UNAVAILABLE`（`retryable`），**不落任务、不产假音频**（§4.1 用例钉住）。本片**不以替身验收**真实合成能力。
2. **真实音频：0 字节**。本片不生成、不下载、不缓存任何音频；替身产物是**非 `audio/*`** 的标注内容，替身播放端口**不产生声音**。
3. **Android/iOS 真机音频与交互记录：未取得**（属 #23）。因此"真机扬声器/蓝牙/耳机路由、系统静音、来电中断"这四类
   **只有离线替身与文案证据**，没有真机日志或录屏。§2.2 表中相关判据一律标注为**离线**。
4. **30 段实机样例：0 段**（`docs/evaluation/sample-gap-register.md` 的 `tts` 要求 30、实际 0）。
   本片**不产生、不声称**任何合成质量/音色/自然度/听感结论。
5. **需求第 6 节本能力评估：未跑**。该评估须"实现时就跑"，且**替身/夹具不计模型准确率**；本片无真实音频，
   因此**不主张任何准确率数字**。
6. **正式部署：未做**（不部署、不改套餐/权限/可见性、不接续期）。
7. **`tests/integration/**` 未运行**：它**不在任何 CI glob 内**，本片也未依赖它（本片新增的 HTTP 证据放在
   `tests/unit/` 的 CI glob 内）。若需集成级证据，须由指挥/监工显式指定并另附原始输出。
8. **微信开发者工具/真机编译、五 Tab 截图、系统大字不遮挡走查：未做**（脚本无法覆盖，属人工走查项）。
9. **服务端"已核对内容"读取端点不存在**（契约里只有 `POST /speech/synthesis`）。本片**未自造**该端点；
   播报页因此不发明内容来源，离线只提供**明确标注的替身样本**（且仅本地替身工程可见）。
10. **合成产物下载链路未接线**（`media_id` → 媒体访问授权），故 `audioSourceForJob` 在 `real` 下也如实返回不可播放。
11. **`tests/ui-demo-align.test.mjs` 在基线上即失败**（`styles/icons.wxss` 与 demo SVG path 不一致）；本片输入未变、
    未修、**不主张其通过**（详见 §5）。`tests/ui-adaptive.test.mjs` 26/26 通过。
12. **未跑 `npm run test:contract` / `test:evaluation` / `npm run build`**：本片未改 `packages/contracts/**`、
    未改评估数据与构建配置；如实登记为未跑，不主张通过。
