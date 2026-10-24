# GY-I12 文字提问页（`pages/qa/qa`）本地渲染与交互证据 — 2026-10-21

- 上游 issue：[GengYunChuChao/GengYun#12](https://github.com/GengYunChuChao/GengYun/issues/12)（文字问答）、[#28](https://github.com/GengYunChuChao/GengYun/issues/28)；本页只写 `Refs #12`／`Refs #28`，**不关闭整项**。
- 代码 HEAD：`4b0d093a9fce70600de5c0b7443478d08d75e6eb`，分支 `codex/gy-i12-text-question-submit-20261020`（PR #324）。
- 采集时间：2026-10-21 21:06–21:31 (+08:00)。
- 证据目录：`.local/qa-login-render-20261021/`——**本地目录，已被 `.gitignore` 忽略，不随 PR 提交**。下文截图均指该目录内的文件名，属**本地证据**，在 PR 页面不可访问，仅供本机复核。
- 本轮只做采集与整理：未改实现、未跑测试、未访问 GitHub、未读取凭据、未创建子代理。

## 0 口径（先读这一节）

本页所有「通过」只指**微信开发者工具模拟器**内的实际画面与本地 stub 服务的实际响应，不构成以下任何一项：

- **不是真机**：`platform: devtools`（机型标签 HUAWEI Mate 70 Pro / HarmonyOS 为工具内模拟标签），无 Android 真机走查。
- **不是真实回答**：服务端未接真实供应商，如实返回 `PROVIDER_UNAVAILABLE`，页面未展示任何替代或伪造回答。
- **不是整项验收**：本片只覆盖「已核实会话 → qa 渲染 → 长输入 → 一次显式发送 → 失败态 → 离页清理」这一条链路；真实问答质量、资料覆盖、用量卡渲染、真机与多机型均未取得。

身份与服务均为本机合成：本地 API（`execution_mode: stub`）＋合成微信身份＋合成提问文本，不含真实用户数据。

## 1 结论

| 目标项 | 结果 | 依据（本地证据） |
| --- | --- | --- |
| 通过产品现有 `auth.login` 建立**已核实**会话 | 通过 | 点击「微信登录」后 `loggedIn: true`；网络记录 `POST /auth/wechat` 200、`GET /auth/session` 200；会话形状 `audience=user`、`executionMode=stub`、有令牌（未导出内容）。`02-login-page.jpg` 为登录页画面 |
| `pageStack` 中确有 `pages/qa/qa` | 通过 | 页面栈 `home → pages/qa/qa`（title「文字提问」） |
| qa 页真实渲染 | 通过 | `03-qa-page.jpg`：页头「文字提问」、用药安全提示、演示数据说明、① 输入问题 `0 / 8000 字` |
| 超过 140 字且低于契约上限的输入 | 通过 | 输入 180 字合成田间问题（`draftLength = 180`，与输入原文长度一致）；`04-long-input-180.jpg` 显示 `180 / 8000 字`，正文完整可读、未在 140 字处截断 |
| 一次显式发送 | 通过（请求层） | 单击「发送」一次 → `POST /conversations` 201、`POST /conversations/{id}/turns` 202（`state: queued`）、`GET /jobs/{id}` 200；仅一次 turns POST，无重复提交 |
| 失败/不足状态如实呈现 | 通过 | 任务终态 `failed`、`error_code=PROVIDER_UNAVAILABLE`、`result: null`；页面 ③ 为「不可展示 · 这次没有生成回答。」，`answer: null`、`citations: []`（`05-send-failed.jpg`、`06-answer-gate.jpg`） |
| 离页后隐私内容清理 | 通过 | 离页后 `exitReason=hide` 且 draft/answer/turns 全空；返回后 `draftLength=0`、`turns=[]`、`answer=null`（`09-return-top.jpg`：页首、计数 `0 / 8000 字`、无上次提问残留） |
| 真实供应商回答 | **未取得** | 服务端如实 `PROVIDER_UNAVAILABLE`，本轮未验证回答正文、来源引用与用量卡渲染 |

## 2 环境与绑定

| 项 | 值 |
| --- | --- |
| 客户端 | 微信开发者工具；基础库 `3.17.3`（console 首行 `WeChatLib: 3.17.3`） |
| 运行形态 | `platform: devtools`，**模拟器，非真机** |
| 逻辑视口 | `376 × 742`（`screenWidth 376 × screenHeight 809`，`statusBarHeight 39`，`pixelRatio 3.5`） |
| 截图 | 310 × 664 JPEG（工具默认优化尺寸） |
| 工程绑定 | 隔离工程与 HEAD 的 qa 相关文件逐文件 SHA256 一致：`pages/qa/{qa.js,qa.wxml,qa.wxss,qa.json}`、`utils/qa-api.js`、`utils/navigation.js`、`app.json` |
| 本机服务 | `http://127.0.0.1:3110`，`/health` 200（`execution_mode: stub`，DB ok）；本地状态为 `local_stub / synthetic / synthetic` |

## 3 逐项过程（只记实得）

1. **会话**：`simulator_open_page pages/login/login` → 点击「微信登录」→ 产品既有 `auth.login`（`wx.login` → 本地 stub 交换 → `verifySession`）完成，`loggedIn: true`。首轮点击曾因隔离工程 `urlCheck` 拦截而失败，在**隔离工程**内新增私有配置关闭域名校验后重试成功；未改 AppID、未改仓库内共享配置。
2. **页面栈**：`automation_navigate navigateTo /pages/qa/qa` 成功后读 `pageStack`，确认 `home → pages/qa/qa`。
3. **长输入**：向 `textarea.input` 输入 180 字合成问题，`draftLength = 180`，计数 `180 / 8000 字`。
4. **发送**：单击「发送」一次，网络层为 201 → 202 → 200 三步，无重复 POST。
5. **失败态**：作业终态 `failed` / `PROVIDER_UNAVAILABLE`，页面进入回答闸门 `ANSWER_NOT_PRODUCED`，文案「这次没有生成回答。」，未用本地数据顶替。
6. **补充（会话记录）**：另用一条 24 字合成问题发送，同样 `failed / PROVIDER_UNAVAILABLE`；点「查看记录」后轮次列表 1 条，回答列为「还没有取得」（`08-session-turns.jpg`），可佐证发送确实到达服务端。
7. **离页清理**：qa 页留有草稿时切到登录页，隐藏后实例 `draftLength: 0`、`exitReason: "hide"`、`turns: 0`、`answer: false`；返回后仍为 `0 / [] / null`（`09-return-top.jpg`）。

## 4 非阻塞观察（仅记录，本轮未修）

任务终态 `failed` 后，② 回答进度区的 `taskNote` 仍停留在「问题已发送，正在查找答案…」，与同区「没有生成回答」标签并列（`05-send-failed.jpg`、`06-answer-gate.jpg`）。属页面既有文案行为，**状态语义略有冲突但不影响失败可见性与数据正确性**（③ 已明确「不可展示 · 这次没有生成回答。」，`answer` 为 `null`）。本轮按边界只记录、未改代码；是否调整文案由后续按影响判断。

## 5 未取得 / 不覆盖（不得外推）

1. **真实供应商回答**：无任何 `answered + passed` 结果，回答正文、来源 citations、用量卡条数渲染均未验证。
2. **重试路径**：本轮失败走 `answerGateCode` 分支，`taskErrorCode` 为空，页面未出现「重试」按钮，未点击验证。
3. **超时/轮询上限路径**：任务在一拍内即 `failed`，未触发「等待超时」分支。
4. **超长拒绝**（>8000）、**清空按钮**、**游客态 qa 门禁画面**：未测（本轮全程已登录）。
5. **整包编译 / 预览包 / 真机 / 多机型 / 最大字号**：未做。qa 页可渲染来自模拟器实际编译并打开页面，不是单文件编译推断；但仍不等于真机。
6. **会话丢失观测**：把登录页压栈后页面栈最终只剩登录页、本地会话为空，返回需重新点一次「微信登录」；只记观测，未定位成因、未改代码。

## 6 最小复现要点

1. 启动本机 API 并确认 `/health` 200。
2. 隔离工程需关闭域名校验（`project.private.config.json` 内 `setting.urlCheck=false`），否则 `wx.request` 报 `url not in domain list`；该文件属个人配置，不入库。
3. 登录页点击「微信登录」，等 `loggedIn: true`（网络应见 `/auth/wechat` 200、`/auth/session` 200）。
4. `navigateTo /pages/qa/qa`，`pageStack` 应含 `pages/qa/qa`。
5. 输入 180 字 → 计数 180 → 点「发送」→ 预期 `POST /turns` 202、`GET /jobs` 200、`failed / PROVIDER_UNAVAILABLE`，页面 ③ 显示「不可展示」。
6. 离页再返回，`draftLength=0`、`turns=[]`、`answer=null`。

---

`Refs #12` · `Refs #28`（**不使用** `Closes`／`Fixes`／`Resolves`）。本页不登记 #12 整项通过，也不替代真机与真实供应商验收。
