# GY-I12 原生文字提问页（miniprogram/pages/qa）客户端切片 — 2026-10-20

提交准备补充（2026-10-20）：原实现目录和下文沙箱记录保留为历史。推进者 cxhhandsome 在独立提交目录 `D:/challenge_cup/.supervisor/gy-i12-text-question-submit-20261020` 将本片11个文件移植到最新 `main@47fe028`（其增量未改本片已有前端文件），实际执行原始 `node tools/check-wechat-project.mjs` PASS、`node --test tests/unit/miniprogram-qa-text-question.test.mjs` 29/29 PASS；此前两项独立返修探针亦由推进者实际复核2/2 PASS。推进者另外同步了打包回归的固定页面数19→20，并增加问答页必须入包的断言，`node --test tests/local-debug.test.mjs` 6/6 PASS；此为第12个变更文件。原作者沙箱的 EPERM 不适用于本次推进者检查。实现者 DSH Step、返修者 DSH DeepSeek V4.1 Flash、提交集成/推送者 cxhhandsome。仍无微信IDE编译/渲染、Android真机新增证据；拟建草稿PR，不登记整项通过，不自批准或合并。

- 上游 issue：[GengYunChuChao/GengYun#12](https://github.com/GengYunChuChao/GengYun/issues/12)（文字问答）——**只写 `Refs #12`／`Refs #28`，本片不关闭整项**。
  （#28 为任务书中点名的关联项；本片未触及 #28 的任何交付物，仅按派单要求挂 Refs。）
- worktree：`D:\challenge_cup\.supervisor\gy-i12-text-question-ui-20261020`
- 分支：`codex/gy-i12-text-question-ui-20261020`；基线 `main@13dd429a02db57953ad604e17951901ebbc9d2ab`
  （派单给定；`git rev-parse HEAD` 实测一致）
- 实现者：**DSH Step**（首轮实现与自检）
- 返修者：**DSH DeepSeek V4.1 Flash**（第一轮交付返修 P1×2 + P2×2；只改本文所列问题，不重写功能）
- 派单授权：用户明确授权本次前端片；不创建子代理、不访问 GitHub、不读凭据、不推送、不改其他 checkout／共享配置／认证。
- 当前 HEAD：`13dd429a02db57953ad604e17951901ebbc9d2ab`（**未提交**，原因见 §6 第 1 条）

---

## 1. 本片做了什么

在服务端已装配的七个问答 operation（`docs/architecture/contract-implementation-status.md` 的
`createConversation`/`listConversations`/`getConversation`/`deleteConversation`/`createTurn`/
`listTurns`/`deleteTurn` 全部标 `partial`，`GET /jobs/{id}` 已接 `kind=answer` 读面）之上，
补齐**原生小程序文字提问前端**。**未改契约、未改服务端、未改迁移、未改锁文件。**

| 文件 | 改动 |
| --- | --- |
| `miniprogram/utils/qa-api.js`（新） | 文字问答 HTTP 消费层：`POST /conversations`、`POST /conversations/{id}/turns`（**`TextTurnInput`**）、`GET /jobs/{id}`、`GET /conversations/{id}/turns`、`DELETE /conversations/{id}/turns/{turn_id}`。契约闭集校验（`Answer` 十一键／`SourceRef` 十键／`Job` 九键／`Conversation` 四键／`Turn` 七键／`TurnPage` 两键／`Ack` 一键／`TargetRef` 三键）；`If-Match` 由服务端回传 revision 生成；`Idempotency-Key` 8..128 且尝试级固化；**回答可展示性闸门** `evaluateAnswerGate`（纯函数）；`doseCardsView`／`citationsView`；401/403 如实归因（`CONSENT_REQUIRED`／`SCOPE_DENIED` 不折叠成"登录失效"）；逐码文案 |
| `miniprogram/pages/qa/qa.js`（新） | 四段式页面：① 文字输入 + 显式「提问」+ 空白/上限显式校验（**不静默截断**）；② 会话创建与**复用**、`busy` 防重复；③ 有界轮询（1s 一拍、30 拍上限、以 202 的 `deadline_at` 为真正边界）；④ 回答**整体**展示 + 来源 + 用量卡条数；轮次历史读取。`onHide`/`onUnload`/门禁失效走同一释放出口 |
| `miniprogram/pages/qa/qa.wxml` / `.json` / `.wxss`（新） | 界面与页面样式：发送按钮与风险信息在前、回答与来源在后（正常文档流，无 `position:fixed/absolute`）；触控下限 `var(--tap-min, 44px)`；字号 `calc(Npx * var(--font-scale,1))`；回答正文纯 `text` 节点（**不转富文本**）；模板不引用任何可执行用量字段 |
| `miniprogram/pages/identify/identify.js` | 「文字提问」卡从「尚未接入」toast 改为**实际有门禁的 qa 入口** `openQa()`（复用 `navigation.beginReturnTo` + `auth.verifySession`；未登录同口径引导登录，不放行私有数据）；引入 `utils/navigation` |
| `miniprogram/app.json` | `pages` 追加 `pages/qa/qa`（**纯追加，不重排既有路由**） |
| `miniprogram/utils/navigation.js` | `PAGES` 追加 `pages/qa/qa`（非 Tab；不接受查询参数） |
| `tools/prepare-wechat.mjs` | 打包允许清单追加 `utils/qa-api.js` 与 `pages/qa/qa`（**不放宽 release 门禁**；`assertSharedProjectConfig`／runtime 断言一律未动） |
| `tests/unit/miniprogram-qa-text-question.test.mjs`（新） | 首轮 20 项；返修后 **29 项**（假 transport + **真实**页面/模块代码经 vm 加载，含 202 后重试回放原键、跨账号返回清理、`maxlength` 与文案口径的回归） |

---

## 2. 关键行为与红线

| 红线 | 落地方式 | 回归判据 |
| --- | --- | --- |
| **不把 `SpeechTurnInput` 冒充 `TextTurnInput`** | `validateTextTurnBody` 只产出 `{input_type:'text', text}` 两键；静态用例逐一断言 `transcription_id`/`transcription_revision`/`confirmed` **不在**请求体里 | `契约·TextTurnInput 请求体恰两键`；`页面·提问全链路` 对 `Object.keys(body).sort()` 逐项比对 |
| **空白/上限显式拒绝，不静默截断** | `localGate()`：`trim()===''` ⇒ 不发送；`>8000` ⇒ 提示实际字数并**零请求**；`textarea` 显式 `maxlength="-1"`（微信原生默认 140，不写就是静默截断 140 字）。计数单位 `String.length`，与服务端 `validate.ts` 的 `value.length` 同口径（见 §8） | `页面·空白与超长提问 ⇒ 零请求`（含空串／纯空白／超长三分支，断言 `http.calls.length === 0`）；`静态·textarea 显式 maxlength="-1"` |
| **回答只在成功 + 安全检查通过 + 结构完整时整体展示** | `evaluateAnswerGate`：`status==='answered'` && `check_state==='passed'` && 十一键闭集 && `citations.length>0`；**不流式、不部分展示**；拒绝结果不携带任何可展示正文 | `闸门·只有 answered+passed+结构完整+有引用才放行`（9 个负例 + fail-closed 纪律断言 `gate.answer === undefined`） |
| **来源只从服务器真实引用集合来，不生成链接** | `citationsView` 逐字投影服务端 `SourceRef` 十键；`url` 必须是 `https://`；无引用 ⇒ `ANSWER_NO_SOURCE` 阻断 | `页面·succeeded 但无引用 ⇒ ANSWER_NO_SOURCE`；`契约·Answer` 含 `引用 url 非 https` 负例 |
| **用量安全：只报条数，不给可执行结论** | `doseCardsView` 只输出 `{count, renderable:false, blocked:true, reason}` 四键；`renderable` **恒 false**；模板**不引用** `original_text`/`unit_text`/`method_text`/`precautions_text`/`formulation`/`content_hash`；不把富文本转 HTML | `闸门·用量卡只报条数与资格判定`；`静态·qa 模板与样式`（六字段逐一不在模板 + 无 `rich-text`） |
| **终态错误/超时/不确定按实际协议呈现** | `settle()` 按 `JobState` 逐类给**用户可读**文案（`failed`/`timed_out`/`uncertain`/`cancelled` 各不相同），内部状态码只留在 `answerGateCode`（数据层，不上主流程）；都不显示"已有回答" | `页面·failed/timed_out/uncertain 三类终态逐类呈现`（并断言展示文案不含 `state=`/`error_code`）；`页面·succeeded 但 check_state=blocked` |
| **超时后不自动重复创建收费请求** | 越过 `deadline_at` ⇒ `ANSWER_NOT_PRODUCED` + 停轮询，**不**重发；重试由用户明确触发且**严格回放同一请求身份**（见 §8 P1-1） | `页面·轮询越过 deadline_at ⇒ … 且不自动重发`（断言 `turns.length === 1`）；`页面·202 受理后轮询超时，点「重试」严格回放同一请求身份` |
| **发送中防重复** | `busy` 守卫 + WXML `disabled` | `页面·发送中重复点击 ⇒ 恰好一个轮次请求`（在途窗口内连点） |
| **离页/换账号清空全部私有内容** | `onHide`/`onUnload` → `releaseAll()`：停轮询 + `qaApi.cancelAll()` + 代次递增 + **清空 answer/draft/turns/`_conversation`/`_sendAttempt`**；`isCurrent()` 额外绑定 `auth.sessionEpoch()`，换人后旧回调不回填 | `页面·onHide 立刻清空全部私有显示与会话缓存`；`页面·隐藏后换成另一个账号返回…`；`页面·旧账号在途响应在换人后不得回填` |
| **不写私有提问/回答到日志或公共 storage** | 页面**不调用** `wx.setStorageSync`、不调用 `console.*`；会话缓存只在进程内实例字段 `this._conversation` | `静态·qa 页不直接发请求`（三条否定断言） |
| **用途授权不客户端假造** | 403 `CONSENT_REQUIRED`／`SCOPE_DENIED` 原样带出并给各自文案；只有 `SESSION_*` 才 `auth.clearSession()` | `qa-api.js` 的 `forbiddenOrSessionLoss`（与 `identify-api`／`speech-transcript` 同口径） |
| **未接线/演示数据如实说明（且说人话）** | `UNWIRED_ANSWER_NOTE` 常驻页面顶部：「当前为演示数据…不是真实大模型生成的结果…不提供剂量换算或处方」；版本串/`partial`/`unimplemented:no-real-` 等实现细节移出主流程，只留在代码与报告 | WXML 常驻 `notice notice--stub`；`静态·面向用户的文案不暴露契约名/路径/状态机/幂等键/版本串` |

---

## 3. 契约与装配核对（实读结论）

| 核对项 | 实读结论 |
| --- | --- |
| `TextTurnInput` | `packages/contracts/openapi.json:13037`：恰两键 `input_type:'text'`（const）+ `text`（1..8000），`additionalProperties:false` |
| `SpeechTurnInput` | 同文件 `:13055`：四键（`transcription_id`/`transcription_revision`/`confirmed`）——**本片一次都未发送** |
| `Answer` | 同文件 `:13094`：十一键闭集；`status` 闭集 `answered`/`insufficient`/`blocked`；`check_state` 闭集 `passed`/`blocked`；`citations` ≤20；`dose_cards` ≤10 |
| `SourceRef` | 同文件 `:11420`：十键闭集；`url` pattern `^https://` |
| `Job`/`JobState`/`JobResult` | `:14656`／`:10916`／`:14631`：九键；七类状态；`result` 为 `{kind,value}`，`answer` 分支 value 是 `Answer` |
| `Conversation`/`Turn`/`TurnPage`/`Ack` | `:13003`／`:13169`／`:15469`／`Ack`：键集与闭集逐项核对 |
| 幂等/版本头 | `Idempotency-Key` 8..128 必填（`:10875`）；`If-Match` pattern `^"[1-9][0-9]*"$` 必填、缺失 428、不匹配 409（`:10886`） |
| 路由装配 | `services/api/src/app.ts:1723` `registerConversationRoutes(app, config, guards, conversationService)`；`:1673` 起 `createAnswerJobSource` 已接入跨 kind 作业读面 |
| 契约实现状态 | `docs/architecture/contract-implementation-status.md` 的 `createConversation`/`createTurn`/`listTurns`/`deleteTurn`/`getJob`/`cancelJob` 六行均为 `partial`，且**明言**：未接真实模型（版本串 `unimplemented:no-real-` 前缀）、正文是确定性检索条目摘录、真实资料覆盖有限（浙江首批 159 条 `review_status=unverified`）⇒ **用量卡在本基线恒不可产出**、`answer` 作业**取消仍未接线**（作业面如实 503 `PROVIDER_UNAVAILABLE`）。本片 UI 口径与这三条逐字一致 |
| 取消能力 | 服务端对回答作业无取消入口 ⇒ 本片**不**发任何"取消任务"请求、**不**谎称服务端任务已取消（页面 `exitReason` 文案如实写明） |

---

## 4. 命令与读数

| 命令 | 读数（首轮 / 返修轮） |
| --- | --- |
| `node tools/check-wechat-project.mjs` | **本沙箱不可执行**：`AssertionError null !== 0`，根因 `spawnSync … EPERM`（本环境禁止子进程 spawn，见 §6）。**不是代码缺陷**；返修轮实测 `node -e "spawnSync(...)"` 仍为 `EPERM`，故此条本轮仍未真正执行 |
| 静态等价校验（临时脚本，跑完即删，未提交） | 首轮：`PASS(static-equivalent): … 86 checks.`；返修轮复跑：`PASS(static-equivalent, spawn 禁用): JSON/routes/tabs/shared config/runtime + 64 JS syntax (vm.Script) + GY-I12 allowlists.` —— 复算 `check-wechat-project.mjs` 的全部静态断言（两份 project.config.json 的 appid/urlCheck/libVersion、`miniprogramRoot`、五个 Tab 注册、每个 page 的 `.js`/`.json`/`.wxml` 存在且 `.json` 可解析、`sitemap.json`、示例 urlCheck、`miniprogram/**` 全部 `.js` 语法、`runtime.js` 必须 `mode:'disabled', apiBaseUrl:''`），并追加 GY-I12 三处清单一致 |
| `node --test --test-isolation=none tests/unit/miniprogram-qa-text-question.test.mjs` | 首轮 **tests 20 / pass 20 / fail 0**；返修轮 **tests 29 / pass 29 / fail 0** |
| `node --test --test-isolation=none` 跑五个受影响页面测试文件（identify / ocr-correction / ui-auth-integration / voice-playback / voice-hardening） | 返修轮实测 **tests 152 / pass 152 / fail 0**，逐文件：identify 31、ocr-correction 7、ui-auth-integration 26、voice-playback 58、voice-hardening 30。首轮另记过 172/172，但本轮未复现该计数，**不作等价引用** |
| `node "D:\challenge_cup\.supervisor\dsh-i12-ui-20261020\review-probes.mjs"`（父进程探针，任务目录外） | 返修前 **2 项均失败**（轮询超时重试换键；onHide 不清 answer/`_conversation`）；返修后 **tests 2 / pass 2 / fail 0** |
| `node tools/verify-contract-status.mjs` | `PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项`（首轮；返修轮未改动契约面，未重跑） |
| 全量 `node --test --test-isolation=none "tests/unit/*.test.mjs"` | **返修轮按派单不跑全量、也不做工作树还原对照**（首轮曾在另一状态跑过，本轮不继承其结论） |

> 说明：`--test-isolation=none` 是既有问答测试文件的既定跑法（见 `docs/verification/gy-i12-chat-20261019.md`）；
> 本沙箱禁止 `spawn`，进程隔离模式会直接 `spawn EPERM` 无法运行。

---

## 5. 未验证／未取得（不得外推）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| **微信 IDE 编译／渲染** | **未验证** | 用户明令不启动/关闭/重置 IDE；沙箱亦禁 spawn。首轮与返修轮都只有 Node 静态与 VM 测试证据，**无任何渲染证据** |
| 真机（Android）走查 | **未取得** | 无设备；按派单不属本片范围 |
| 真实 LLM 供应商问答 | **未取得** | 无真实密钥、未发起外网调用；服务端版本串保持 `unimplemented:no-real-`，页面已如实标注 |
| 真实资料库检索覆盖 / 120 题评估（GY-I21） | **未取得** | 属资料域与评估任务；本片不改写其结论 |
| 登记用量卡可执行展示 | **本基线恒不可产出** | `contract-implementation-status.md` 明言；本片据此**只报条数**，不渲染用量正文 |
| 回环 HTTP 集成（`tests/integration/*-http.mjs`） | **未跑** | 派单要求"有意义的受影响测试"而非全量；本片新增 Node VM 层 29 项 + 既有页面回归已覆盖请求形状与失败路径。若监工要求回环，需在允许 spawn 的环境补跑 |
| `npm run lint` / `npm run test:contract` / `npm run build` | **未跑** | 同上（派单：不启动 IDE、以代码和局部检查为主要交付；这些命令在禁 spawn 沙箱下同样不可靠） |

---

## 6. 风险、残留与执行限制

1. **未提交（`git status` 见 4 改 + 3 新增 + 本文件）**：`git add` 与 `git commit` 都需要写
   `.git/worktrees/gy-i12-text-question-ui-20261020/index.lock`，本沙箱均 **`Permission denied`**
   （worktree 与主仓共用 Git 元数据；首轮实测 `git add` exit 128、`git stash push -u` 同样被拒）。
   按派单「不突破边界、保留代码由父进程提交」，**返修轮未尝试提权、未修改审批策略、未改用其他 Git 目录**。
   代码完整保留在工作树中（未 staged）；返修轮也未执行任何写 Git 的操作。
2. **用户 simulator 提示**（`.user-simulator-warning.md`，本地文件、**不提交**）：用户报"模拟器长时间没有响应"。
   本片已按该提示核对新增页面：**无同步长循环**（唯一循环是 `setInterval` 轮询，每拍要么发起一个有 15s timeout 的
   `wx.request`，要么 `stopPoll()`）；**无界轮询不存在**（30 拍上限 + `deadline_at` 双边界）；**无错误重试风暴**
   （失败只停轮询并回到可重试态，**不自动重发**；返修后重试严格同键回放，也不会放大请求量）；**生命周期清理齐全**
   （`onHide`/`onUnload`/门禁失效/换账号四路都 `stopPoll()` + `cancelAll()` + 代次递增 + 清空私有内容）。
   但**根因未经定位**：无编译/渲染证据，不能把该提示归因于本页，**也不能宣称已修复**（返修轮同样不声称修复 IDE/模拟器）。
   若后续定位到本页问题，最小修复优先，不重跑全仓定时器审计。
3. **轮次读面不含作业状态**（既有契约形状，本片未改）：`TurnView` 没有 `job_state`/`error_code`，
   只看轮次列表时失败与"还没有回答"同形。本片因此在轮次历史里**只显示服务端真实返回的字段**，
   并对 `answer===null` 明确写「回答：还没有取得」，不用任务状态猜测。
4. **回答版本串是"未接真实模型"的机器判据，但不上主界面**（返修 P2-4 后）：
   `model_version`/`prompt_version`/`rule_version` 仍在 `answer` 数据对象里原样保留（可核验、未改写），
   但不再渲染到用户主流程；用户看到的是「当前为演示数据……不是真实大模型生成的结果」。
   审阅者需要逐字版本串时读本文 §3 与页面 data，不要求用户界面承担该职责。
5. 本片所有"通过"仅指**客户端形状、闸门与失败可见性**在替身通路成立，**不构成**真实问答质量、
   准确率、渲染或整项 #12 验收。

---

## 7. 交付物清单（`git status --porcelain` 实测）

```
 M miniprogram/app.json
 M miniprogram/pages/identify/identify.js
 M miniprogram/utils/navigation.js
 M tools/prepare-wechat.mjs
?? miniprogram/pages/qa/            （qa.js / qa.json / qa.wxml / qa.wxss）
?? miniprogram/utils/qa-api.js
?? tests/unit/miniprogram-qa-text-question.test.mjs
?? docs/verification/gy-i12-text-question-ui-20261020.md   （本文件）
?? .user-simulator-warning.md       （本地用户消息，按其中说明**不提交**）
```

（返修轮未增删交付文件，只改了 `miniprogram/pages/qa/qa.js`、`miniprogram/pages/qa/qa.wxml`、
`miniprogram/utils/qa-api.js`、`tests/unit/miniprogram-qa-text-question.test.mjs` 与本文件；
临时静态复算脚本跑完即删。）

## 8. 第一轮交付返修（2026-10-20，返修者：DSH DeepSeek V4.1 Flash）

父进程在任务目录外用 `D:\challenge_cup\.supervisor\dsh-i12-ui-20261020\review-probes.mjs`
（复用本片同一套 VM 夹具）实测：**两项均失败**。下列四条为返修范围，不扩大、不重写功能、不动后端/契约。

### 8.1 P1-1 已受理提问轮询超时后重试换键（可能重复创建付费作业）

- **真实缺陷**：`onSend` 在收到 202 后立刻 `this._sendAttempt = null`，随即又把"同一尝试复用同一把键"
  写进超时文案——文案对、行为错：`onRetry` 再走 `onSend` 时 `stableKey` 看到 `previous === null`
  就 `newKey('i12-send')`，产生**新的 Idempotency-Key**。服务端幂等台账按 key 去重，新键 = 新轮次 = 新付费作业。
- **修复**：202 受理后**保留** `_sendAttempt`（连同 `_acceptedAttemptKey`），重试严格回放原键；
  只有两种"用户明确开始新提问"的情形换键：① 改正文后重新发送（descriptor 变，`stableKey` 自然换）；
  ② 点「清空」重新开始（`onClearDraft` 显式丢弃尝试身份）。
  离开本页/换账号时随 `releaseAll()` 一并清空（此时不该再回放旧身份）。
- **回归**：`页面·202 受理后轮询超时，点「重试」严格回放同一请求身份`（连续两次重试都断言同一个
  `Idempotency-Key`）、`页面·明确改正文后再发送 ⇒ 换新键`、`页面·点「清空」重新开始同一句话 ⇒ 换新键`。
- **父探针**：`review: accepted task timeout retry preserves request identity` 由失败转为通过。

### 8.2 P1-2 私有数据跨账号残留（onHide 只清 busy/定时器）

- **真实缺陷**：`onHide → releaseAll()` 只复位 `busy`/`exitReason`/停轮询，**不清** `answer`/`draft`/`turns`/
  `_conversation`/`_sendAttempt`。账号 A 看见回答后隐藏页面、在别的页面切到账号 B、再返回时，
  `pageGate` 只要核实 B 成功就会把 A 的私有正文继续显示在页面上——旧的 `current(bound)` 只挡"在途响应"，
  挡不住**已经 setData 落屏**的旧内容。
- **修复（两层）**：
  1. `releaseAll()` 改成唯一的"清空私有内容"出口：停轮询 + `qaApi.cancelAll()` + 代次递增，并把
     `draft/draftLength/inputNote/conversationId/conversationRevision/stage/mode/job/taskNote/taskErrorCode/
     answer/answerGateCode/answerGateMessage/citations/doseCards/turns/turnsNote` 全部复位，
     同时丢弃 `_conversation`/`_conversationAttempt`/`_sendAttempt`/`_acceptedAttemptKey`。
     `onHide`/`onUnload`/`closePrivate` 全部走它，**不再存在"只清一半"的路径**。
  2. 身份 epoch 绑定：页面记 `this._epoch = auth.sessionEpoch()`；`onShow` 重新核实时若 epoch 变化，
     先 `closePrivate()` 再决定展示；`isCurrent()` 也要求 `_epoch === auth.sessionEpoch()`，
     使旧身份的在途回调无法回填。
  3. 附带修正：`pageGate.start` 会**先同步回调一次 `false`**（代表"核实还没完成"），原实现会把它
     当成"门禁失效"写提示；现在第一次回调只更新 `guest/networkOff`，不触发清理通报。
- **回归**：`页面·onHide 立刻清空全部私有显示与会话缓存`、`页面·隐藏后换成另一个账号返回：重新核实成功
  也不得显示上一个账号的内容`（断言账号 B 看到 `answer === null`、且 `JSON.stringify(page.data)` 里
  不含 A 的回答正文）、`页面·未 onHide 但身份 epoch 变化后返回`、`页面·旧账号在途响应在换人后不得回填`。
- **父探针**：`review: hide removes private answer and conversation before another identity can return` 转为通过。

### 8.3 P2-3 textarea 默认 140 字上限被当成"无限输入"

- **真实缺陷**：`qa.wxml` 的 `textarea` **没有** `maxlength`。按微信官方组件文档
  （<https://developers.weixin.qq.com/miniprogram/dev/component/textarea.html>），`textarea` 的
  `maxlength` 默认为 **140**——不写不等于不限，而是**静默截断 140 字**，与本片"不静默截断"的口径相反。
  另外文案称超过 8000 是"码点"，但代码用 JS `String.length`（UTF-16 码元），emoji 计 2，单位宣称错误。
- **修复**：模板显式 `maxlength="-1"`（原生组件里 `-1` = 不限），发送前仍由 `localGate()` 按契约
  `TEXT_MAX = 8000` 显式拒绝超长（零请求、给出实际字数）；计数单位统一到 `String.length`，与
  `services/api/src/conversations/validate.ts::lengthProblem()` 的 `value.length` **同口径**，
  界面文案改称「字」并注明原生默认 140 已放开，不再宣称"码点"。
- **回归**：`静态·textarea 显式 maxlength="-1"`（并断言模板不再出现"不设 maxlength"的错误口径）；
  超长用例改断言 `/超过上限 8000/` 与 `/不会自动截断/`。
- **证据修正**：§2 原表把"不设 maxlength"写成正确做法，已按原生组件实际行为改写；§4 原静态断言同步更正。

### 8.4 P2-4 页面产品文案暴露实现细节

- **真实缺陷**：主界面直接出现 `TextTurnInput`、`GET /conversations/{id}/turns`、`JobState`、
  幂等键、`check_state`/`status=`、`unimplemented:no-real-` 版本串、`partial`、会话 id/revision、截止时间等。
- **修复**：模板改为自然短句——「输入问题／发送／正在查找／等待超时／重试／资料不足／来源／当前为演示数据」；
  会话 id/revision、截止时间、`JobState`、`error_code`、版本串从主流程移除（数据仍在 `page.data`，
  供核对与后续报告使用）；执行模式改成 `modeLabel`（`stub`/`preset_demo` ⇒ 「演示数据」）。
  **必要提示一律保留**：演示数据与"不是真实大模型结果"、未接线 503 如实归因、
  「不构成用药建议／不提供剂量换算或处方」、用量卡只报条数、来源逐字来自服务端。
- **回归**：`静态·面向用户的文案不暴露契约名/路径/状态机/幂等键/版本串`（清单式否定 + 必要提示必须在）；
  终态/闸门用例追加"展示文案不含 `state=`/`error_code`/`check_state`"的断言。

### 8.5 返修轮的命令与限制（如实）

| 命令 | 读数 |
| --- | --- |
| `node --test --test-isolation=none tests/unit/miniprogram-qa-text-question.test.mjs` | **tests 29 / pass 29 / fail 0** |
| `node --test --test-isolation=none` 跑五个受影响页面测试文件（identify / ocr-correction / ui-auth-integration / voice-playback / voice-hardening） | **tests 152 / pass 152 / fail 0**（逐文件：31 / 7 / 26 / 58 / 30） |
| `node "D:\challenge_cup\.supervisor\dsh-i12-ui-20261020\review-probes.mjs"` | **tests 2 / pass 2 / fail 0**（返修前 2/2 失败） |
| `node tools/check-wechat-project.mjs` | **仍未真正执行**：`spawnSync … EPERM`（本会话实测 `spawnSync(process.execPath, …)` 返回 `status:null, error:'EPERM'`）。改用等价的静态复算脚本（`vm.Script` 代替 `node --check` 子进程），`PASS … 64 JS syntax + GY-I12 allowlists`。**原始命令未执行这一限制照实保留** |
| 全量 unit / 工作树还原对照 | **按派单未跑** |

- 未做：不提交（Git 共用元数据受限时按要求不提权，交父进程提交）、不推送/合并、不启动或干预 IDE、
  不动后端与契约、不新增子代理、不碰其他 checkout/凭据。
- **渲染证据仍为无**：本轮全部是 Node VM + 静态断言，**没有任何微信 IDE 编译或渲染证据**；
  模拟器卡顿**根因仍未定位**，本轮不声称修复 IDE 或模拟器问题。
- `.user-simulator-warning.md` 仍是本地文件，**不提交**。

`Refs #12` · `Refs #28`（**不使用** `Closes`／`Fixes`／`Resolves`）。
