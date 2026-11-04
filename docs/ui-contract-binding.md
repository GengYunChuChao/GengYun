# GY-I26 界面与冻结契约绑定记录

- 记录：2026-10-09｜分支：`feature/gui-adaptive-pages`｜PR：[#39](https://github.com/GengYunChuChao/GengYun/pull/39)
- 记录人：尹一（开发者端）
- 契约来源（冻结契约；操作条数以 `packages/contracts/operations.json` 现数为准，本页不抄写——本行 2026-10-09 记的数已过时）：`packages/contracts/operations.json`

> 本文件是任务书「提交证据」第 2 项中「**接口契约绑定记录**」的交付物。
> **机器归属**：全部结论来自作者本机静态核查，未发起任何网络调用，未读取任何生产凭据。

---

> 2026-10-10 接续更正：下列原始扫描表属于 PR #39 的历史 UI 壳，不是当前合并结果。当前使用 main 的 `utils/auth.js`，已接入 `POST /auth/wechat`、`GET /auth/session`、`POST /auth/logout`；存在真实请求封装，游客门禁不使用 `utils/session.js` 的恒游客占位。资料查询沿用 main 已实现页面及路由。业务识别、语音、社区内容尚未据 UI 壳接入，不能宣称全项目零 `wx.request`。

## 1 结论先行：绑定为设计级映射，实现尚未开始

任务书范围写明「先用冻结 HTTP 契约联调替身，再逐项替换真实服务」。实际核查结果：

| 项 | 核查方式 | 结果 |
| --- | --- | --- |
| 页面是否直接调用接口 | 全页面 `*.js` 搜 `wx.request` 及 api/net/http/service 引用 | **零命中** |
| 是否存在请求封装 | `miniprogram/utils/` 逐文件核查 | 仅 `debug`／`font-scale`／`session`／`system-font`，**无网络层** |
| 共享运行配置 | `miniprogram/config/runtime.js` | `{ mode: 'disabled', apiBaseUrl: '' }` |
| 真实服务地址 | `runtime.js` 搜 `http(s)://` | 零命中，无硬编码地址 |
| 冻结契约是否被改动 | `git diff origin/main -- packages/contracts/` | 零差异 |

**因此本任务交付的是「界面元素 → 契约端点」的映射约定，不是已接通的调用。** 识别、语音、社区入口均可点击但不产生任何请求，全部走替身占位。

这不违反任务书——范围末句已写明「基础库／工具编译和界面走查可先完成，后续业务验收按各功能任务完成」，且 `mode: disabled` 正是「与真实服务地址和评估数据隔离」的实现方式。

## 2 界面动作与契约端点映射

左列为界面上真实存在的元素（可在 [ui-state-inventory.md](ui-state-inventory.md) 与走查截图中核对），右列为契约中已冻结的操作。

### 2.1 首页

| 界面动作 | 契约操作 | 当前实现 | 后续任务 |
| --- | --- | --- | --- |
| 进入首页 | `GET /public/home` | 替身·静态文案 | [GY-I07](https://github.com/GengYunChuChao/GengYun/issues/7) |
| 三个识别入口 | 见 2.2 | 替身·未接入 | GY-I09/10/11 |
| 识别历史／收藏计数 | `GET /history`、`GET /favorites` | 替身·计数 0 条 | [GY-I16](https://github.com/GengYunChuChao/GengYun/issues/16) |

### 2.2 识别页（三入口）

| 界面动作 | 契约操作 | 当前实现 | 后续任务 |
| --- | --- | --- | --- |
| 拍照识别杂草 | `POST /recognitions`、`GET /recognitions/{id}` | 替身·置灰不可点 | [GY-I09](https://github.com/GengYunChuChao/GengYun/issues/9) |
| Top3 核对与选择 | `PATCH /recognitions/{id}/selection` | 未实现（无数据可核对） | GY-I09 |
| 拍照识别农药标签 | `POST /ocr`、`GET /ocr/{id}` | 替身·置灰不可点 | [GY-I10](https://github.com/GengYunChuChao/GengYun/issues/10) |
| 标签用量校正与登记核对 | `PATCH /ocr/{id}/correction`、`POST /ocr/{id}/verify` | 未实现 | GY-I10 |
| 语音提问（录音） | `POST /speech/transcriptions`、`PATCH /speech/transcriptions/{id}/confirmation` | 替身·按钮分离但不发请求 | [GY-I11](https://github.com/GengYunChuChao/GengYun/issues/11) |
| 语音提问（文字） | `POST /conversations/{id}/turns` | 替身·未接入 | [GY-I12](https://github.com/GengYunChuChao/GengYun/issues/12) |
| 文本转语音播报 | `POST /speech/synthesis` | 未实现 | [GY-I13](https://github.com/GengYunChuChao/GengYun/issues/13) |

> 「录音」与「播放」在界面上为两个独立按钮，对应两个不同操作，满足范围「录音与播放按钮分离」。

### 2.3 社区页

| 界面动作 | 契约操作 | 当前实现 | 后续任务 |
| --- | --- | --- | --- |
| 浏览帖子 | `GET /posts` | 游客拦截，未登录不可见 | [GY-I14](https://github.com/GengYunChuChao/GengYun/issues/14) |
| 发帖／评论（先审后发） | `POST /posts`、`POST /posts/{id}/comments` | 未实现，**不提供任何输入框** | GY-I14/15（**2026-11-04 复核：中列「未实现，不提供任何输入框」已过期** —— `miniprogram/pages/communitycreate/communitycreate.wxml` 已有标题输入框、正文输入区与「提交审核」按钮；`miniprogram/pages/communitydetail/communitydetail.wxml` 已有评论输入区与「发送评论」按钮；接口层 `miniprogram/utils/community-api.js` 有 `createPost` 与 `createComment`；`miniprogram/app.json` 已注册这两页，`miniprogram/pages/community/community.wxml` 另有「分享发现」入口） |
| 点赞 | `PUT /posts/{id}/like`、`DELETE /posts/{id}/like` | 未实现 | GY-I14（**2026-11-04 复核：中列「未实现」已过期** —— `miniprogram/pages/communitydetail/communitydetail.wxml` 已有点赞与取消点赞按钮（帖子一组、每条评论一组），`miniprogram/utils/community-api.js` 有 `likePost` 与 `unlikePost`） |
| **人工审核空入口** | 后台仅 `POST /admin/posts/{id}/hide`（隐藏已发布内容）；**契约中无「帖子审核列表」类操作** | 用户端**不含任何后台入口** | [GY-I18](https://github.com/GengYunChuChao/GengYun/issues/18)（**2026-11-04 复核：中列「契约中无『帖子审核列表』类操作」已过期** —— 契约已有 `listAdminPosts`（`GET /admin/posts`）、`getAdminPost`（`GET /admin/posts/{id}`）、`approvePost`（`POST /admin/posts/{id}/approve`）、`rejectPost`（`POST /admin/posts/{id}/reject`）；右列「用户端不含任何后台入口」本次未复核，保留原判） |

> AC08 要求「人审入口建设中，无假任务／审核人」。用户端只保留空入口与说明，**未渲染任何审核人、任务或「已通过」字样**，符合范围「只保留人工审核的空入口」与「独立后台与用户端分开」。

### 2.4 消息页

| 界面动作 | 契约操作 | 当前实现 | 后续任务 |
| --- | --- | --- | --- |
| 消息列表 | `GET /messages` | 游客拦截 + 空态 | [GY-I17](https://github.com/GengYunChuChao/GengYun/issues/17)（2026-11-04 复核：中列「游客拦截 + 空态」已过期——列表已装配并可渲染：服务端 `app.get` 注册在 `services/api/src/routes/messages.ts` 第 43 行（`preHandler` 仍是 `guards.requireUser`，「游客拦截」这半仍成立），第 50 行调 `ready(request).listMessages(...)`；服务实现是 `services/api/src/messages/service.ts` 第 303 行的 `listMessages`（只列本人、`(created_at DESC, id DESC)` 稳定排序＋HMAC 游标），装配点是 `services/api/src/app.ts` 第 2616 行的 `registerMessageRoutes`，实例在第 903 行按执行模式构造。客户端 `miniprogram/utils/messages-api.js` 第 222 行的 `listMessages` 真打 `GET /messages` 并逐字段核对封套，`miniprogram/pages/messages/messages.js` 第 145 行取回后 `setData` 出 `items`／`visibleItems`，`miniprogram/pages/messages/messages.wxml` 第 95 行 `wx:for="{{visibleItems}}"` 逐条渲染；空态仍在（第 150 行 `status: items.length ? 'ready' : 'empty'`）。仍缺：`real` 模式无连接池时服务实例为 `null`（`services/api/src/app.ts` 第 904 行），整域 503 `PROVIDER_UNAVAILABLE`，页面走错误态而非空态（第 126 行 `_fail` 置 `status: 'error'` 并带 `errorCode`）） |
| 未读数 | `GET /messages/unread-count` | 未实现 | GY-I17 |
| 标记已读 | `PUT /messages/{id}/read` | 未实现 | GY-I17 |
| 播放控制 | 见 2.2 `POST /speech/synthesis` | 未实现 | [GY-I13](https://github.com/GengYunChuChao/GengYun/issues/13)（2026-11-04 复核：中列「未实现」已过期——播放控制已装配：服务端 `POST /speech/synthesis` 注册在 `services/api/src/routes/synthesis.ts` 第 118 行（受 `ai_enabled` 开关门，基线为开），装配点是 `services/api/src/app.ts` 第 2525 行的 `registerSynthesisRoutes`；另有音频读面 `GET /speech/synthesis/{id}/audio`（同文件第 217 行），客户端取真实字节只走它。客户端 `miniprogram/utils/voice-api.js` 第 314 行真发 `POST /speech/synthesis` 并轮询任务，第 353 行的 `audioSourceForJob` 在第 389 行拼出上述音频读面地址；播放端口是 `miniprogram/utils/inner-audio-port.js` 第 203 行的 `wx.createInnerAudioContext`（私有读面不能带自定义头 ⇒ 先 `wx.downloadFile` 带会话头再播），控制器 `miniprogram/utils/audio-playback.js` 第 167 行的 `createPlaybackController` 提供 play／pause／resume／stop／replay，页面 `miniprogram/pages/voice/voice.js` 第 727／734／735／736 行接 `onPlay`／`onPause`／`onStop`／`onReplay`（`miniprogram/pages/voice/voice.wxml` 第 136 至 139 行 `bind:play` 等四条绑定）。仍缺：真实 TTS 提供者要 `config.aiProviders.tts` 被校验快照，未配置时 `services/api/src/tts/provider.ts` 第 143 行的 `createRealTtsProvider` 恒 `available: false` ⇒ 受理前 503 `PROVIDER_UNAVAILABLE`，真实供应商调用仍未取得；`services/api/src/tts/service.ts` 第 995 行的 `realAudioProduced: false` 仍成立；`stub`／`preset_demo` 产物是标注过的非音频占位，客户端如实回 `SUBSTITUTE_ARTIFACT`（第 373 行起），所以「能播真实音频」仍不成立） |

> AC18 要求「首版无外部订阅发送」。全项目搜索「订阅消息／推送通知／短信／公众号」**零命中**，本任务未引入任何外发通道。

### 2.5 我的页

| 界面动作 | 契约操作 | 当前实现 | 后续任务 |
| --- | --- | --- | --- |
| 微信登录 | `POST /auth/wechat` | **未接入**，登录按钮仅提示 | [GY-I04](https://github.com/GengYunChuChao/GengYun/issues/4) |
| 会话查询／退出 | `GET /auth/session`、`POST /auth/logout` | 未接入 | GY-I04 |
| 档案（作物／地区） | `GET /me/profile`、`PUT /me/profile` | 替身·计数 0 条 | [GY-I05](https://github.com/GengYunChuChao/GengYun/issues/5) |
| 隐私说明 | `GET /me/privacy-policy` | 静态文案 | GY-I27 组件已由 [PR #45](https://github.com/GengYunChuChao/GengYun/pull/45) 合入 main=bb3f20f（`packages/privacy/`）；界面读取待接入 |
| 用途授权与撤回 | `GET /me/consents`、`POST /me/consents`、`DELETE /me/consents/{purpose}` | 未接入 | 服务端守卫已由 [PR #45](https://github.com/GengYunChuChao/GengYun/pull/45) 合入；界面与接线待接入 |
| 字体设置 | **无契约** | 本地读 `wx.getSystemInfoSync()`，不涉及网络 | 本任务 |

> **无本地存储的字号档位**：需求第 4.1 节只要求「适配微信字体设置」，未要求应用内开关，故本任务不设档位、不写存储（详见 [gui-adaptive-evidence.md](verification/gui-adaptive-evidence.md) 7.7）。

## 3 验收标准（AC）归属切分

任务书引用 9 条 AC，部分属其他任务，本任务不重复验收：

| AC | 要点 | 本任务 | 说明 |
| --- | --- | --- | --- |
| AC01 | 游客仅主页、其他页及 API 拦截 | **本任务** | 五 Tab 游客态走查已实测；登录本身属 GY-I04 |
| AC06 | 普通话自动播报 | **GY-I13** | 任务书已注明本任务不重复验收语音服务准确率 |
| AC07 | 失败和重试，输入保留、重复提交不重复创建 | **本任务（状态定义）** | 八种状态与统一失败组件；真实重试逻辑随各功能任务接入 |
| AC08 | 真实社区与人审空入口，无假任务／审核人 | **本任务（空入口）** | 用户端仅空入口，无审核人／任务／「已通过」字样 |
| AC14 | 风险提示，无绝对安全标签，播放不假记理解 | **本任务（文案）** | 文案无绝对化断言（已有自动化断言）；播报属 GY-I13 |
| AC15 | 静态地区不假发预警 | **本任务（文案）** | 全页面搜索预警类表述**零命中**；真实预警属 2027-02 |
| AC17 | 收藏与识别历史真实记录 | **GY-I16** | 本任务仅占位计数「0 条」 |
| AC18 | 消息与播放控制，无外部订阅发送 | **部分本任务** | 无外部订阅通道为本任务确认；播放属 GY-I13、记录属 GY-I17 |
| AC21 | 定位确认，拒定位可手选，不存原坐标 | **GY-I05** | 本任务无定位实现 |

**AC15 核查过程**（此前遗漏，本次补做）：任务书第一条验收即写「静态地区不假发预警」。核查覆盖全部五个页面的 `*.wxml`，检索「预警」「会提前通知」「自动报警」「风险已解除」「无风险」等表述，**零命中**——识别页在未接入状态下只说明「功能尚未接入」，未对灾害性杂草作出任何预警承诺。

## 4 替身开关与隔离

| 要求 | 实现 | 核查方式 |
| --- | --- | --- |
| 替身数据仅开发模式明确标注 | 状态组件 `status="stub"` 额外渲染「替身数据 · 仅开发模式可见」标签 | 界面实测见走查截图 |
| 与真实服务地址隔离 | `config/runtime.js` 为 `{ mode: 'disabled', apiBaseUrl: '' }` | 搜 `http(s)://` 零命中 |
| 与评估数据隔离 | 共享源码网络全面禁用；本地准备只写被 `.gitignore` 精确忽略的副本 | `tests/local-debug.test.mjs` 4 项 PASS |
| 未接入会话前恒为游客 | `utils/session.js` 的 `SESSION_ENABLED` 为 `false` 时 `isGuest()` 无条件返回 `true` 且不读存储 | 合成 `wx.getStorageSync` 覆盖 10 种缓存取值 |
| 不改冻结契约 | `packages/contracts/` 相对 `origin/main` 零差异 | `git diff --name-only origin/main...HEAD` |

## 5 自查结论

按任务书逐条自查，**未发现实现层面的违规**。本次补齐的缺失证据：

| 问题 | 处理 |
| --- | --- |
| 证据第 2 项「接口契约绑定记录」缺失 | 本文件补齐 |
| 9 条 AC 归属未切分，易被误读为本任务全交 | 第 3 节补齐 |
| AC15「静态地区不假发预警」此前未核查 | 已核查，零命中（第 3 节末） |

**仍未通过（不属本任务可解决）**：

- 登录态界面未走查，依赖 [GY-I04](https://github.com/GengYunChuChao/GengYun/issues/4)
- 真实社区、消息、收藏、历史记录未实现
- 语音播报未实现，依赖 [GY-I13](https://github.com/GengYunChuChao/GengYun/issues/13)
- 真机双平台与体验版上传未做，依赖 [GY-I25](https://github.com/GengYunChuChao/GengYun/issues/27) / [GY-I23](https://github.com/GengYunChuChao/GengYun/issues/23)

因此 issue #28 保持 open，本任务不标整项完成。