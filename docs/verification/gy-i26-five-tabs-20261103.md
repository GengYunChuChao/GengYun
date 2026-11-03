# GY-I26 五 Tab 骨架与统一失败状态 · 微信开发者工具走查（2026-11-03）

关联：#28（本页为 `Refs #28` 的界面走查证据，不是整项验收完成）。

结论一句话：**当前 main 的五 Tab 骨架在微信开发者工具里可编译、可导航，未登录入口控制和「替身数据」模拟标记均如实生效**；社区与「我的—我的投稿」显示的是统一失败状态（stub 服务端没有真实存储），这是预期的如实拒绝，不是界面缺陷。

## 1. 取证环境（全部如实列出）
- 工具：微信开发者工具（CLI 驱动），IDE 服务端口 20241；自动化端口 9458。
- 基础库：`SDKVersion 3.17.3`；`platform: devtools`；视口 376×742，`pixelRatio 3.5`（模拟器，**非真机**）。
- 工程：独立导入工程（把当前 main 的 `miniprogram/` 整目录复制成一份独立工程，未改仓库源码），`appid` 用仓库既有的公开测试标识，`miniprogramRoot: miniprogram/`。
- 本地开关（两处，都在**副本**里，不进仓库）：`miniprogram/config/runtime.js` 写成 `{"mode":"local","apiBaseUrl":"http://127.0.0.1:3100/api/v1"}`（源文件恒断网，注释明确「本地准备只写被忽略的副本」）；`project.private.config.json` 置 `setting.urlCheck = false`，否则开发者工具会拦掉到本地 stub 的请求。
- 服务端：本地 stub API（`http://127.0.0.1:3100`，`meta.execution_mode = stub`）+ 真实 PostgreSQL（55436），登录身份为**合成微信身份**（真实 `wx.login` 拿到 code，由本地 stub 换成 session）。
- 未做：真机、正式 AppID、真实 ASR/TTS/识别/审核供应商调用。

## 2. 走查步骤与读数
完整机器读数见同目录 `i26-tabs-observations.json`（含每一步的页面 `data()` 快照）。

| 步骤 | 结果 | 关键读数 |
| --- | --- | --- |
| 清会话归零游客态 | ok | 落点 `pages/home/home`，`guest=true, loggedIn=false` |
| 游客点「社区」Tab | ok | 落点 **`pages/login/login`**（未登录入口控制生效） |
| 真实点击「微信登录」按钮 | ok | 按钮文案 `微信登录`、`disabled=false`；登录后落点 `pages/community/community` |
| 五 Tab 依次导航 | 5/5 ok | home / community / identify / messages / profile 逐一命中预期路径 |
| 回到首页复核 | ok | `guest=false, loggedIn=true` |

## 3. 五 Tab 路由与状态清单
| Tab | 路径 | 本次实测状态 |
| --- | --- | --- |
| 首页 | `pages/home/home` | 正常渲染；页脚如实标注「开发准备工程……仅供参考，不代表真实业务验收」；公开预览区显示 `PROVIDER_UNAVAILABLE` 的统一失败态 |
| 社区 | `pages/community/community` | 统一失败态「社区内容没有取到 / 社区服务暂不可用（服务端未接线真实存储）」；作物 5 项、地区 103 项静态候选在位 |
| 识别 | `pages/identify/identify` | 三个入口（拍草识别 / 标签识别 / 文字提问）与「其他入口—语音提问」齐全；无录音进行中状态 |
| 消息 | `pages/messages/messages` | 空态 `status=empty`；**模拟标记**可见：「替身服务数据，仅供联调，不代表真实消息投递」；筛选 4 项在位 |
| 我的 | `pages/profile/profile` | 资料已载入；作物/地区选择器在位；「我的投稿」显示统一失败态（`myPostState=error`）；地区未设置时显示「未设置」，**没有凭空编造地区预警** |

## 4. 截图（按顺序）
1. `00-home-guest.png` — 游客首页
2. `01-guest-gate-community.png` — 游客点社区后的登录门禁页（不是社区布局证据）
3. `02-after-login.png` — 微信登录完成后的落点
4. `02-tab-home.png` — 首页
5. `03-tab-community.png` — 社区（统一失败态）
6. `04-tab-identify.png` — 识别（三入口 + 语音提问入口）
7. `05-tab-messages.png` — 消息（空态 + 替身数据标记）
8. `06-tab-profile.png` — 我的

截图是完整模拟器画面，未裁剪、未拼接、未改色。

## 5. 本页覆盖了什么、没覆盖什么
覆盖（#28 验收的界面面）：
- 微信工具编译通过 + 五 Tab 真实导航（点击驱动，非直接改路由）
- 未登录入口控制（游客 → 登录页）
- 替身数据的模拟标记可见（消息页横幅、首页开发准备提示）
- 统一失败状态在社区 / 首页预览 / 我的投稿三处如实呈现，且不伪造内容

未覆盖（不得据此关闭整项）：
- **真机与正式 AppID**：本页全部为模拟器 + 合成身份（属 #27）。
- **「人审空入口」**：后台侧入口不在小程序端，本页未取证。
- **静态地区"不假发预警"**：只观测到未设置地区时不出现预警横幅；完整口径（按真实区县数据触发/不触发）需地区数据落地后另行取证。
- 语音、识别、社区投稿等业务链路的真实供应商结果（分别归各自 issue）。

## 6. 复现命令
```text
# 1) 起本地 stub API + 真实 PostgreSQL
cd .local/local-dev ; powershell -File .\start.ps1
# 2) 打开独立导入工程并挂自动化端口（IDE 服务端口 20241）
& "...\微信web开发者工具\cli.bat" open --project <wechat28 目录> --port 20241
& "...\微信web开发者工具\cli.bat" auto --project <wechat28 目录> --auto-port 9458 --port 20241
# 3) 跑走查（清会话 → 游客门禁 → 真实点击登录 → 五 Tab 截图与读数）
node .local/i26-tabs.cjs <sdk> .local/evidence/tabs-20261103 9458
```

## 7. 取证过程中的两个环境坑（留给后来者）
- 直接把**仓库根**当工程打开时，automator 会一直 `timeout waiting for automator response`（IDE 日志里是 `[appservice] simulator launch success` 之后紧跟 `/__pageframe__/instanceframe.html timeout`）。换成独立导入工程即可连——仓库根文件数过多（`node_modules` 等）会让这个版本的工具起不来 pageframe。
- `runtime.js` 不改或 `urlCheck` 不关，登录必定停在登录页：前者会直接按"本地未启用"失败，后者会让到 `127.0.0.1` 的请求被域名校验拦掉，页面显示「网络请求失败，请检查地址与网络后重试」。
