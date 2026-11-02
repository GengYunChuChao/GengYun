# GY-I26 I2 识别页语音入口核查

Refs #28。2026-10-28，指挥 Codex 核查、集成和推送，供独立监工审查；不作为监工批准。

## 版本与实现者

基线 main `de2aa3c6`。实现与提示文字返修均由本机 Hub 的 `deepseek-v4.1-flash` 写手完成；写手工作树为 `codex/gy-i26-identify-voice-hub-20261027`，基于 `bc8b9eb5`。文件补丁无冲突集成到最新 main，原写手文件保留。

写手的命令沙箱报 Windows ACL 错误，未运行测试或提交；文件工具交付后正常结束。以下运行检查均为指挥在自己的 LF 检出完成，不冒称写手自测通过。

## 变更与审查要点

- 移除识别页仅切换布尔值的假录音/播放按钮与状态；明确本页不录音、不采集、不上传，ASR 尚未接通。
- 新入口固定指向既有 `/pages/voice/voice`；复用原文字问答入口门禁，先校验登记路由，再核实会话，核实前不导航，游客禁用。
- 文字问答保留原目标和登录提示；不改共享认证、导航、voice 页面、供应商、后端、契约或依赖。
- 提示只保留用户有用的能力边界：独立页有录音与安全检查后的文字播报入口，真实服务尚未核实、合成语音暂不能播放。不把客户端接线写成真实服务已验收。
- 录音/播报分离的既有静态检查迁到实际 voice 页面，安全检查与禁止直接平台调用的要求保留；原假按钮断言改为受控入口的真实行为检查。

## 本轮实际检查

- `node --test tests/unit/miniprogram-identify.test.mjs tests/unit/miniprogram-ui-auth-integration.test.mjs tests/unit/miniprogram-voice-playback.test.mjs tests/ui-adaptive.test.mjs`：最终 174/174 通过。
- `node tools/check-wechat-project.mjs`：通过，不等于微信完整编译或真机验收。
- 契约台账检查通过；严格文档锚点检查通过。四处受代码位移影响的历史引用仅按目标文件同一原文行平移，未改历史验收结论，不将陈旧描述当本次现状证明。
- 当前状态清单改为独立语音页录音/播报操作及识别页受控入口；历史报告里曾记载的 onRecord/onPlay 只是旧版本记录，本次已删除，不再代表当前页面。

## 微信工具与证据缺口

使用隔离 `.local/wechat-release` 副本，仅作验证；共享 runtime 未改，副本禁用联网，不是可发布版本。skill 0.3.11、版本关系 equal、登录未过期；项目窗口已打开。

`compile_wxml pages/identify/identify.wxml` 返回 success，codeLength=32400。首次导航超时，随后普通导航成功，但游客进入 identify 会按现有门禁跳转登录页；实际 currentPage 为 `pages/login/login`。这只说明游客没有停留在受控业务页，不证明新区域布局或已登录入口点击。

**尚未取得新区域的已登录模拟器截图与实际按钮点击证据。** 未用 setData 绕过门禁、未填充私有数据，未把登录页截图冒充布局通过。因此先提交草稿，补该局部证据后再转 ready；不重试退出整个 IDE或终止其他进程。

真实 HTTP 登录、录音上传、ASR/TTS、可播放音频、Android 真机和整项 #28 均未在本片验收。合并入口修正不能关闭 #28 或推定语音服务可用。

## 已登录布局与真实点击证据（2026-11-02 补）

本节补齐上文「尚未取得新区域的已登录模拟器截图与实际按钮点击证据」的缺口。取证由指挥（DSH 会话协调者）在自己的隔离工作树与隔离导入工程中执行，仍交独立监工审查，不构成批准。

### 取证环境

- 导入工程：`.local/local-dev/wechat`（由 `miniprogram/` 生成的独立导入目录，appid `wx4407a4b908a69a54`，libVersion 3.17.3），与共享 runtime 无关，禁止联网。
- 页面代码：把本 PR `8a1aac59` 两个文件按字节写入导入工程 `miniprogram/pages/identify/`：`identify.js` 74417 字节、`identify.wxml` 22287 字节，`git cat-file -s` 与磁盘大小逐一相等，确认模拟器加载的就是本 PR 版本（其后 `fdd2b645` 只改文档）。
- 后端：本地 stub API `http://127.0.0.1:3100` + 本地 PostgreSQL 55436（`.local/local-dev/start.ps1` 一键起，输出 `READY: API ...; PG ...; synthetic WeChat identity.`）。
- 驱动：`miniprogram-automator` 0.12.1，脚本 `.local/i2-evidence.cjs`；自动化端口 9451，IDE 服务端口 20241。
- 设备参数：viewport 376×742、pixelRatio 3.5、SDKVersion 3.17.3、platform `devtools`。

### 结果

1. 游客门禁：进入识别页被门禁重定向到 `pages/login/login`，只证明未登录被拦下（截图 `00-guest-login-gate.png`）。
2. 登录：点击「微信登录」，`wx.login` 由开发者工具真实返回 code 交给本地 stub 的 `/auth/wechat` 换合成身份，登录后 `guest=false`、`resumePath=pages/identify/identify`，回落到识别页（截图 `01-identify-top.png`）。
3. 登录后布局：识别页出现「其他入口 / 语音提问」区块，说明文字写明本页不录音、不采集、不上传音频、ASR 未接通，并指引独立语音页有录音入口与安全检查后的文字播报入口；绿色按钮文案为「去语音页（录音 / 播报）」，`disabled=false`，CSS px 位置 `left=42`、`top=886.9375`，尺寸 `292 × 47.1953125`；截图前 `scrollTop=318`，故 `02-identify-voice-entry.png` 中入口居视口下部（截图是完整模拟器画面，未裁剪）。
4. 真实点击：`element.tap()` 点击该按钮后 `currentPage = pages/voice/voice`，`pageStack = [pages/identify/identify, pages/voice/voice]`，`passed=true`（截图 `03-voice-after-click.png`）。

### 过程中排除的工具故障（不影响结论）

开发者工具侧曾反复出现「连上自动化端口但取不到页面」（`Cannot destructure property 'rawPath' of getPageMetaByWebviewId as it is null`）。日志根因是 IDE 内存里残留过期的 simulator builder 状态：`[BuilderFactory] shouldCreate=false requestId=2 type=simulator` 使工具判定「已有模拟器」而不新建，随后 `[appservice] simulator launch failed` 与 `SIMULATOR_LAUNCH_CAUGHT { valueType: 'undefined' }`。用 `cli close` → `cli open` → 换新自动化端口 `cli auto` 重开同一项目后一次成功。属工具状态问题，与本 PR 代码无关；未退出整个 IDE、未终止其他项目进程。

### 限制（不夸大）

- 合成身份 + 本地 stub API，不是真实微信身份交换，不是正式环境。
- 模拟器（platform `devtools`），不是 Android/iOS 真机。
- 未调用真实 ASR/TTS 或付费供应商；voice 页真实录音与播报可用性未在本次验证。
- 截图来自模拟器完整画面，未做区域裁剪；尺寸与坐标均为 CSS px。
- 真实 HTTP 登录、录音上传、真机与整项 #28 仍未验收，本证据只覆盖「登录后识别页布局 + 入口真实点击跳转」这一局部。

证据文件：`docs/verification/assets/gy-i26-identify-voice-20261028/` 下 `00-guest-login-gate.png`、`01-identify-top.png`、`02-identify-voice-entry.png`、`03-voice-after-click.png`。
