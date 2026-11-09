# GY-R92 演示脚本演练实测（2026-11-09，真栈 + 开发者工具模拟器）

- 演练对象：`docs/demo/演示脚本.md`（376 行，彩排版）§2–§10 共 9 段
- 演练时间：2026-11-09 23:10–23:35（Asia/Shanghai）
- 演练分支：`chore/gy-r92-rehearsal2`，基线 `origin/main = c1641fba`（"fix(miniprogram): 按 351×761 单机型收拾排版，时间戳改人类可读（GY-R92）"，PR #1167）
- 执行者：演练代理（自动化脚本驱动，非人工手点）

## 1 环境与取证方式

| 项 | 实测值 |
| --- | --- |
| API | `http://127.0.0.1:38110`，`/health` 200，`meta.execution_mode = real`，`database.status = ok`（latency 37 ms） |
| 数据库 | PG `127.0.0.1:55510`，库 `gengyun`（`E:\GengYunCommander\.pg17\pgsql\bin\psql.exe`） |
| 小程序副本 | `E:\GengYunCommander\.pg17\demo-project\wechat-local-r92`（由 `tools/prepare-wechat.mjs local --config … --no-urlcheck` 生成，位于仓库工作树之外） |
| `miniprogram/config/runtime.js` | `module.exports = {"mode":"local","apiBaseUrl":"http://127.0.0.1:38110/api/v1"}` |
| appid / 基础库 | `wx4407a4b908a69a54` / 3.17.3 |
| 模拟器机型 | iPhone 12/13 (Pro)，`screenWidth 390`、`screenHeight 844`；截图输出 351×761（390×0.9） |
| 自动化 | `cli.bat auto --project "<副本>" --auto-port 9422` + `miniprogram-automator@0.13.0`，`connect({ wsEndpoint: 'ws://127.0.0.1:9422' })` |
| 截图目录 | `E:\GengYunCommander\.pg17\demo-shots-rehearsal2\`（不进仓） |
| 日志 | `E:\GengYunCommander\.pg17\mpauto\logs\*.log`，每页 `page.data()` 快照落在同目录 `*.json` |

取证口径：每段都取「`currentPage().path` + `page.data()` 关键字段 + 截图 + HTTP 状态码」四项。HTTP 状态码的取法是把 `wx.request` 包一层，把 `method/url/statusCode` 推进 `wx.__reqLog`，再用 `mp.evaluate` 取回；不是看服务端日志猜的。

两个方法学订正（与派单里给的「前人踩过的坑」相反，以实测为准）：

1. **`reLaunch` 必须带前导斜杠**。`mp.reLaunch('pages/community/community')` 抛 `Error: Uncaught [object Object]` 且页面不动；`mp.reLaunch('/pages/community/community')` 正常。本次全部用 `/pages/...`，并且每次 reLaunch 后仍轮询 `currentPage().path` 等于目标才读 `data()`。
2. **自动化进程 stdout 会丢**。中途崩溃时 console 输出整段消失，所以所有读数改成 `fs.appendFileSync` 直接写日志文件。

## 2 阻断性发现：生成的副本缺 `utils/time-format.js`，科普/社区/消息/收藏/历史在有数据时全崩

这是本次演练**第一个**踩到的东西，且不是被测页面自己的问题：

- 现象（修复前）：`pages/knowledge/knowledge` 点「清空条件继续查询」后 `items=0`、`stateKind=error`、`status`「资料服务暂不可用，已清空，请重试。」，而同一时刻 `GET /knowledge?limit=20` 是 **200**、正文 8 条（带 token 直接请求核对过）。
- 根因：`miniprogram/pages/knowledge/knowledge.js:206` 里 `require('../../utils/time-format').formatDate(...)`，而 `tools/prepare-wechat.mjs` 复制 `miniprogram/**` 用的是**逐项文件清单**（约 `tools/prepare-wechat.mjs:401-415` 的 `copyFileSync(join(root,'miniprogram',file), target)`，`tools/prepare-wechat.mjs:330` 注释「逐项清单保留给既有静态断言」），清单里没有 `utils/time-format.js`；`grep -Pattern "time-format|utils/session" tools/prepare-wechat.mjs` 零命中。`Compare-Object` 两目录只差这两个文件。
- 为什么报的是「服务暂不可用」而不是解析错误：`require` 抛出后 `e.code` 是 `undefined`，落到 `miniprogram/utils/knowledge-api.js:240` 的默认文案；`INVALID_RESPONSE` 走的是另一句「资料响应无法核对…」，两者文案不同，可据此区分。
- 影响面（`grep -Pattern time-format miniprogram` 共 8 处）：`miniprogram/utils/history-api.js:313`、`miniprogram/pages/knowledge/knowledge.js:206`、`miniprogram/pages/messages/messages.js:328`、`miniprogram/pages/community/community.js:212`、`miniprogram/pages/communitydetail/communitydetail.js:197` 与 `miniprogram/pages/communitydetail/communitydetail.js:227`、`miniprogram/pages/historydetail/historydetail.js:122`、`miniprogram/pages/favorites/favorites.js:139`。也就是说**社区、消息、收藏、识别历史、科普五条动线，只要列表非空就会崩成同一句默认错误**；`utils/session.js` 目前没有任何 `require`，暂无影响。
- 本次处置（不改 `tools/**`，因为超出本次允许改动范围）：把工作树里的 `miniprogram/utils/time-format.js`（3996 B）和 `utils/session.js`（1928 B）手工拷进**演练副本**，等开发者工具重编译后复测 → 五个页面全部恢复正常（§4 起的所有读数都是补文件之后的）。
- 建议（交给实现方，不在本 PR 改）：`tools/prepare-wechat.mjs` 的复制清单补上 `utils/time-format.js`、`utils/session.js`，或改成整目录复制。**只要清单还缺这两个文件，任何人按文档新生成的演示副本都会在演示现场遇到「科普 0 条 + 社区 3 条全变错误」**。

## 3 逐段实测（脚本 §2–§10）

约定：「一致」= 脚本写的数字/文案与屏幕一致；不一致的在段内单列「脚本写的 vs 实际」。

### §2 第 1 段 · 冷启动 → 首页

| 项 | 实测 |
| --- | --- |
| 实际路径 | 登录页点 `.btn--primary`（「微信登录」）→ 自动落在 `pages/home/home` |
| 会话 | `wx.getStorageSync('gengyun.session')` = 扁平 4 键 `{accessToken, audience, expiresAt, executionMode}`；`accessToken` 43 字符；`expiresAt` `2026-11-16T15:15:53.079Z` |
| data 关键字段 | `guest=false`、`loggedIn=true`、`previewStatus=ready`、`previewItems` **8** 张（稗 / 狗尾草 / 荨麻属 / 马唐属 / 牛筋草 / 看麦娘 / 藜 / 空心莲子草）、`entries` **3**（`拍草识别\|未核实`、`农药标签识别\|未核实`、`语音提问\|未核实`） |
| HTTP | `GET /messages/unread-count` 200、`GET /public/home` 200、`GET /auth/session` 200 |
| 截图 | `01-home-top.png`、`01b-home-mid.png`、`01b-home-preview.png`、`01c-home-bottom.png` |
| 一致性 | **一致**（3 入口 / 8 卡 / 三个「未核实」标签 / 5 个 tab 全部对上） |

> 「未核实」标签是设计：`human_review_state: 'under_construction'` 写死，不是缺陷。报告后文「不声称」再述一次。

### §3 第 2 段 · 识草查药

| 项 | 实测 |
| --- | --- |
| 实际路径 | 首页 `.info-row` 点「识草查药（本地静态资料）」→ `pages/reference/reference`；再点 `.btn-primary`（查询） |
| data 关键字段 | `items` **20**、`total` **20**、`crops` **4**、`species` **8**、`regions` **102**、`dosageForms` **8**（首项「乳油」）、`matchLabel`「已找到符合条件的资料」、`countNote`「本页 20 条 / 共 20 条（总数为裁剪前领域判定）」、`catalogVersion`「作物目录 gy-i03-crops-2026.10 · 杂草目录 gy-i03-species-2026.10 · 地区目录 mca-xzqh-2023」、`sourceVersionNote`「src_moa_pd_2026@农药登记信息（2026年第9期）#bfe97d34e219」 |
| HTTP | `GET /herbicides?limit=20` 200（进页一次、点查询再一次） |
| 截图 | `02a-reference.png`、`02b-reference-queried.png`、`02c-reference-scrolled.png` |
| 一致性 | **数字一致，两处文案不一致**（见下） |

- **脚本写的 vs 实际（第 103 行）**：脚本「除草剂接口 /herbicides · **服务端端**资料读取；…」→ 实际 `modeNote`「除草剂接口 /herbicides · 服务端资料读取；来源核对与适用条件仍需分别确认。」（脚本多一个「端」字）。
- **脚本写的 vs 实际（第 104 行）**：脚本「数据来源」写着「服务端接口 `/herbicides`（真实读数）」→ 实际 `dataSourceLabel` 是整句「数据来源：服务端接口 /herbicides（**真实读数，等待返回**）。」，且这句是 `pages/reference/reference.js:220` 的**静态字面量**，结果已经回来后仍然写着「等待返回」。这是文案接缝（不是本次演练产生的），已记入第 6 节。

### §4 第 3 段 · 科普知识（服务端查询）

| 项 | 实测 |
| --- | --- |
| 实际路径 | 首页 `.info-row` 点「科普知识（服务端查询）」→ `pages/knowledge/knowledge`；点「清空条件继续查询」；再点 `.article-card .btn--primary`（「查看详情并核对来源」）→ `pages/knowledgedetail/knowledgedetail?id=d0000000-0000-4000-8000-00000000c008` |
| 进页第一态 | **被档案条件套住**：`profileState=applied`、`profileNote`「来自我的档案：水稻 · 西湖区；当前资料只登记到省级，已按浙江省查询。」、`cropIndex=1`、`regionIndex=1`、`items=0`、`stateKind=empty`、`status`「没有符合条件的资料，请调整条件继续查询。」 |
| 点「清空条件继续查询」后 | `cropIndex=0`、`regionIndex=0`、`items` **8**、`stateKind=ready`、`status`「已读取当前页资料；详情会重新核对来源。」、`nextCursor=null`；标题顺序「空心莲子草／藜／看麦娘／牛筋草／马唐属／荨麻属／狗尾草／稗」 |
| 目录读数 | `crops` **5**、`species` **9**、`regions` **103**；`directoryNote`「筛选目录为随包目录：gy-i03-crops-2026.10 / gy-i03-species-2026.10 / mca-xzqh-2023」 |
| 详情页 | `stateKind=ready`、`status`「已重新读取当前资料。」、`title` 空心莲子草、`source.version` `demo-seed-20261109`、`publisher`「耕云项目开发侧（演示种子）」、`review_status` verified、`validity` valid、`labels {source:'已核对种子资料', evidence:'混合证据', review:'已核对'}`、`conditionsText`「条件资料不足，作物／地区等条件未完整提供，不能据此确定适用性或用量。」、`favState='favorited'`、`favNote`「已收藏该资料。」 |
| HTTP | `GET /knowledge?crop_id=crop_rice&limit=20&region_code=330000` 200、`GET /knowledge?limit=20` 200、`GET /knowledge/d0000000-…c008` 200、`GET /favorites?limit=50` 200 |
| 截图 | `03a2-knowledge-applied-fixed.png`（档案套住 0 条空态）、`03b2-knowledge-list.png`（8 条）、`03c2-knowledge-scrolled.png`、`05a-knowledge-detail.png`、`05b-knowledge-detail-source.png` |
| 一致性 | **数字一致，第一屏顺序不一致**（见下） |

- **脚本写的 vs 实际（第 126 行 / 第 133 行）**：脚本「页面出来后等 2 秒…看到卡片后点第一张卡片的『查看详情并核对来源』」「再往下是 **8 张资料卡**」→ 实际**进页先是一条 0 条空态**（因为第 8 段已经存过档案：水稻 · 西湖区 → 只按浙江省查，取不到），必须先点黄色提示里的**「清空条件继续查询」**才会出现 8 张卡。脚本第 142 行把它写在「万一不对」里，实测它才是**正常路径**（本次演练就命中）。
- 第 142 行「点『清空条件继续查询』，8 条会回来」——**实测成立**（前提见第 2 节：副本补了 `utils/time-format.js`）。
- 卡片上的「查看详情并核对来源」必须用 `.article-card .btn--primary` 定位；`.btn--primary` 会先命中顶部「查询／重试」。

### §5 第 4 段 · 识别入口（本次重点）

| 项 | 实测 |
| --- | --- |
| 实际路径 | 首页主视觉卡「开始识别」→ `pages/identify/identify`；用 `mp.evaluate` 把一张真实 JPEG（458277 B，`docs/verification/assets/gui-adaptive-250c4d4/02-identify.jpg`）写入 `wx.env.USER_DATA_PATH + '/weed-photo.jpg'`，再 `getCurrentPages()` 取页实例调 `pg.prepareMedia(filePath)` 走「拍草识别」 |
| HTTP 全链 | `POST /media/uploads` **201** → COS `PUT …myqcloud.com/obj_EW_DxmxpO7J3gDY8wgW87tCN?X-Amz-…` **200** → `POST /media/uploads/8b937d2c-8bde-49c8-a489-38f75a81935e/complete` **202** → `POST /recognitions` **202** → `GET /jobs/04d96d0a-daf6-47fd-a9a9-93b01c55c33f` 200（轮询 2 次） |
| job 终态 | `04d96d0a-daf6-47fd-a9a9-93b01c55c33f`：revision 1 `queued`（「已受理，排队中」）→ 2 `running`（「识别中」）→ **3 `uncertain`**（「结果不确定（不可信）」）；DB `created_at 2026-11-09 23:25:15.468+08` → `updated_at 23:25:17.424+08`，约 **1.96 s**；`attempt=0`、`error_code` 空、`result_ref d2c22dc8-97a4-473e-9118-a7373a229972` |
| `recognition_records` | id `d2c22dc8-97a4-473e-9118-a7373a229972`、`media_id 8b937d2c-8bde-49c8-a489-38f75a81935e`、**`candidates = []`**、**`uncertainty_reasons = ["画面为App界面截图，无植物主体，仅有功能按钮"]`**、**`model_version = openai-vision-v1`**、`selected_species_id` 空 |
| 账本行 | `public.provider_call_ledger` 由 6 行变 **7** 行，新增 `e2852666-d3eb-40ba-b269-027c276a449b`：`attempt=1`、`capability=weed`、`provider_config_version=openai-vision-v1#deepseek-flash@1233de6f`、`model_version=openai-vision-v1`、**`invocation_state=sent`**、**`usage={"total_tokens": 1188, "prompt_tokens": 1148, "completion_tokens": 40, "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 1148}`**、`duration_ms=1902` |
| 页面 data | `modeNote`「服务端为 real 模式：照片经私有媒体链路处理，识别由真实提供者完成（当前真实提供者未接入时如实报不可用）。」；`substituteNotice` 空（未走替身）；`branch='uncertain'`；`stateView` = `{state:'uncertain', tone:'warning', component:'error', title:'结果不确定（不可信）', desc:'模型没有给出可信分数或自述不确定。候选仅供参考，需人工核对或重拍，不算识别成功。', terminal:true, success:false, retryable:true}`；`candidates []`、`candidatesTrusted=false`、`showTop3=true`；`uncertaintyReasons` 1 条；`recordId`/`recordRevision 1`；`history` 1 条；**无 `errorText`、无 403 `CONSENT_REQUIRED`** |
| 截图 | `04a-identify-entry.png`、`04b-identify-result.png`、`04c-identify-result-scrolled.png` |
| 一致性 | **「503 / 媒体链路未接线」的旧口径全部过期**（见下） |

- **脚本写的 vs 实际（第 148–150、158、171 行）**：脚本说「本机这套演示服务的照片存储链路没有接线，拍照会得到一句『照片未上传』」「不要点相机」「照片存储链路在本机没有接线」→ 实际**拍草识别全链通了**：201 → COS 200 → complete 202 → `/recognitions` 202 → job 终态 1.96 s，提供者真的读了图，`total_tokens 1188`。
- **脚本写的 vs 实际（第 359 行附表、第 376 行接缝 6、第 324 行已知边界）**：同上，503 已不存在。
- **但「succeeded + Top3 候选」的展示路径本次没走到**，必须如实写：本机没有田间实拍照片，唯一可用的真实 JPEG 是一张 App 界面截图，真实提供者据此判 `uncertain`、0 候选（理由：画面为 App 界面截图、无植物主体）。所以页面出现的是「结果不确定（不可信）＋没有候选＋『任务未成功完成，本页不把任何候选当结果』」，而不是 3 个候选。`showTop3=true` 与空候选可以并存，这是页面设计（`showTop3` 控制区块存在，候选为空时给空态），不是渲染错。

### §6 第 5 段 · 社区

| 项 | 实测 |
| --- | --- |
| 实际路径 | 底部 tab「社区」→ `pages/community/community`；点 `.post-actions__item`（「查看与评论」）→ `pages/communitydetail/communitydetail?id=d0000000-0000-4000-8000-00000000b001` |
| 列表 data | `status='ready'`、**posts 3** 条、作者统一「耕云用户03cc」、`time` = 「今天 17:00」「昨天 18:00」「11-07」、正文前缀「【演示数据·非生产】」、`filterMine=false`、`cropOptions 5`、`regionOptions 103`、`modeNote`「服务端真实模式；本机未接真实审核供应商时不会返回成功。」 |
| 详情 data | `post.title`「【演示数据·非生产】玉米田除草剂药害怎么排查？」、`author`「耕云用户03cc」、`audit_state='approved'`、`outcomeDesc`「这条内容已通过先行审核，公开可见。」、`publicLabel`「已通过先行审核」、`comments` **0** 条、`commentsStatus='empty'` |
| HTTP | `GET /posts` 200、`GET /posts/d0000000-…b001` 200、`GET /posts/d0000000-…b001/comments?limit=20` 200 |
| 截图 | `09a-community.png`、`09b-community-scrolled.png`、`09c-community-detail.png`、`09d-community-detail-scrolled.png` |
| 一致性 | **3 帖一致；导航名、正文前缀、详情可点性不一致** |

- **脚本写的 vs 实际（第 185 行）**：脚本「随便点一张卡片的正文区域**不要点**（本版帖子详情只读校验中，点了可能停在原地）」→ 实际点「查看与评论」**能正常进详情**（`status=ready`、审核态 approved、评论 0 条、无错误）。
- **脚本写的 vs 实际（第 188 行）**：脚本「顶部导航 **耕云**」→ 实际导航标题是 **「社区」**。
- **脚本写的 vs 实际（第 190 行）**：脚本「【演示数据·**非生产数据**】」→ 实际前缀是「【演示数据·**非生产**】」（少「数据」两字）。
- 卡片类名是 `.post`（`community.wxml:75`），不是 `.post-card`。

### §7 第 6 段 · 消息

| 项 | 实测 |
| --- | --- |
| 实际路径 | 底部 tab「消息」→ `pages/messages/messages` |
| data 关键字段 | `status='ready'`、**items 3 条**、`filter='all'`、`filters` 4 档 = 全部 / 未读 / **互动** / 系统、`hasUnread=true`、`unreadText='3'`、`unreadNote='未读 3 条'`、`modeNote`「服务端真实模式；消息持久存储未接线时不会返回成功。」；首条 `type='system'`、`label='系统通知'`、`unread=true`、`time='今天 19:00'`、`canOpen=false`、`referenceNote='本条不带关联目标（服务端只给事件类型与对象引用，不给正文）。'` |
| HTTP | `GET /messages` 200、`GET /messages/unread-count` 200 |
| 截图 | `10a-messages.png` |
| 一致性 | **未读 3 / 4 档 / 3 条一致；档位名与条目形态不一致** |

- **脚本写的 vs 实际（第 216 行）**：脚本「4 个档位（例如 全部 / 未读 / **回复** / 系统）」→ 实际第三档叫 **「互动」**。
- **脚本写的 vs 实际（第 217 行）**：脚本「每条有标题与一小段摘要」→ 实际每条只有**类型标签**（「系统通知」）＋ 一行引用说明（「本条不带关联目标…」）＋「今天 19:00 · 未读」＋「标记已读」按钮，**没有标题，也没有正文摘要**。

### §8 第 7 段 · 问答

| 项 | 实测 |
| --- | --- |
| 实际路径 | `pages/qa/qa`（可直接 reLaunch 进入；输入 9 字「稻田稗草怎么防除？」后点发送） |
| 流程 | T+1 s `stage=pending`、`job=queued`、`taskNote`「问题已发送，正在查找答案…」→ **T+2 s `stage=settled`、`job.state=succeeded`、`busy=false`** |
| HTTP | `POST /conversations` **201** → `POST /conversations/2bfd305a-90e5-42cb-b04d-a54392eef8d4/turns` **202** → `GET /jobs/85e0e800-199f-4c98-846c-d794700af644` 200 |
| 回答 | `answer.id 698412a3-8f22-4d58-9da4-7664a2362d15`、`status='answered'`、`checkedText` 非空（以「（未接真实模型·确定性检索结果·规则 cjk-bigram+word-match/1）…」开头，正文摘录「稗」的演示资料）、`modelVersion='unimplemented:no-real-model/text-qa-deterministic'`、`promptVersion='unimplemented:no-real-prompt/citation-guard-only'`、`ruleVersion='unimplemented:no-real-rule/cjk-bigram+word-match/1+dose/gy-i08/1.2.0'` |
| 引用 | `citations` **1** 条：「【演示】耕云本机演示资料种子（非生产数据，不代表第三方审核）」，publisher「耕云项目开发侧（演示种子）」，`url=https://example.invalid/gengyun/demo-seed-not-for-production`，`review_status=verified`、`validity=valid` |
| 剂量卡 | `doseCards = {count:0, renderable:false, blocked:true, reason:'本次回答没有附带登记用量卡（本基线真实资料覆盖有限，用量卡恒不可产出）。'}` |
| 版本口径 | `mode='real'`、`modeLabel='演示数据'`、`versionState='demo'`、`versionNote`「当前为演示数据：回答由服务端按已核对的资料条目自动摘录，不是真实大模型生成的结果，真实资料覆盖也还有限；本页不提供剂量换算或处方，实际用药请以核验登记资料与标签原文为准。（演示版本 model/text-qa-deterministic）」 |
| 截图 | `11a-qa-entry.png`、`11b-qa-answer.png`、`11c-qa-answer-scrolled.png` |
| 一致性 | **引用 1 条 / 演示数据标签一致；等待时长与「蓝色小标签」不一致** |

- **脚本写的 vs 实际（第 238 行）**：脚本「等 5～15 秒（它在服务端跑一次检索）」→ 实际 **2 秒**出结果（本机）。
- **脚本写的 vs 实际（第 245 行）**：脚本「回答区带蓝色小标签 **『演示数据』**」→ 实际是页面顶部一条**紫色说明条**（「当前为演示数据：…」），回答区右上角是一个灰色 **「已检查」** 标签。没有蓝色「演示数据」小标签。
- 回答正文仍混入实现串（`规则 cjk-bigram+word-match/1`、`db/seeds/demo_catalog_verified.sql`），与第 376 行接缝 4 描述一致，**仍在**。

### §9 第 8 段 · 我的档案（唯一写数据的动线）

| 项 | 实测 |
| --- | --- |
| 实际路径 | 底部 tab「我的」→ `pages/profile/profile`；点 `.btn--primary`（「手选作物与市县」）；`onCrop({value:2})`→水稻、`onCity({value:0})`→杭州市、`onCounty({value:2})`→西湖区；`mp.mockWxMethod('showModal',{confirm:true})` 后 `onSave()` |
| 初始 data | `cropName 水稻`、`regionName 西湖区`、`profile {crop_id:'crop_rice', region_code:'330106', region_catalog_version:'mca-xzqh-2023', revision:2}`、`crops` 4（玉米/油菜/水稻/大豆）、`cities` 11、`counties` 0（未选市时）、计数 `favoriteCount '已加载 1 条'`、`historyCount '已加载 7 条'`、`myPostCount '已加载 0 条'` |
| 编辑态 | `editing=true`、`cropIndex=2`、`cityIndex=0`、`countyIndex=2`、`counties` **13** 条（上城区/拱墅区/西湖区(330106)/滨江区/萧山区/余杭区/富阳区/临安区/临平区/钱塘区/桐庐县/淳安县/建德市） |
| 保存 | `PUT /me/profile` **200** → `GET /me/profile` **200**；保存后 `editing=false`、`cropName 水稻`、`regionName 西湖区`、`profile.revision` **3**、`region_code 330106` |
| 截图 | `08a-profile.png`、`08b-profile-lower.png`、`08c-profile-editing.png`、`08d-profile-picked.png`、`08e-profile-saved.png` |
| 一致性 | **作物 4 / 市 11 / 县 13 一致；三个计数不一致** |

- **脚本写的 vs 实际（第 277 行）**：脚本「三个计数…（本场之前应为 **1 / 6 / 0**）」→ 本次进页实际 **1 / 7 / 0**（比彩排多 1 条，因为第 4 段真跑了一次识别）；演练收尾（收藏了「藜」之后）为 **2 / 7 / 0**。
- 另：harness 的 `mp` 没有 `unmockWxMethod`，`showModal` 的 mock 未被撤掉（后续若再有页面弹确认框会自动确认）；这是自动化工具的限制，不影响 App 行为。

### §10 第 9 段 · 我的收藏 + 识别历史

| 项 | 实测 |
| --- | --- |
| 实际路径 | `pages/favorites/favorites`（点「藜」那行的「收藏」）→ `pages/history/history`（点首卡「查看详情」）→ `pages/historydetail/historydetail?id=bbb942f2-c219-4570-83cf-99bce7a64e0a` |
| 收藏页 data | `mode='real'`、`items` **1**（首屏 `title='杂草 · d0000000'`、`createdAt='今天 22:03'`、`stateLabel='可用'`）→ 点收藏后 **2**（`['藜','空心莲子草']`）；`total` 1→2；`targets` **8** 条（空心莲子草 favorited:true …）；`targetNote`「来自已上架资料：已加载 8 条可收藏（已全部加载）」 |
| 收藏写入 HTTP | `POST /favorites` **201** → `GET /favorites?limit=20` 200 |
| 历史页 data | `items` **7**、`failedCount` **1**、`mode='real'`；首条即本次识别：`kindLabel='识草'`、`createdText='今天 23:25'`、`stateLabel='结果不确定（不可信）'`、`cardTitle='识草 · 今天 23:25'`、`referenceLabel='目标当前可读'`、`navigable=true` |
| 历史详情 data | `stateLabel='结果不确定（不可信）'`、`stateDesc`「模型没有给出可信分数或自述不确定。…不算识别成功。」、`modelCandidates` 0、`modelCandidateNote`「任务未成功完成，本页不把任何候选当结果。」、`uncertaintyReasons` 1 条、`sourceVersion='openai-vision-v1'`、`historyRevision=1`、`canDelete=true`、`referenceLabel='目标当前可读'`、`doseSafetyNote` 空 |
| HTTP | `GET /favorites?limit=20` 200、`GET /knowledge?limit=20` 200、`GET /history?limit=20` 200、`GET /history?limit=50` 200、`GET /recognitions/d2c22dc8-…` 200 |
| 截图 | `06a-favorites.png`、`06b-favorites-scrolled.png`、`06c-favorites-two.png`、`06d-favorites-two-scrolled.png`、`07a-history.png`、`07b-history-scrolled.png`、`07c-history-detail.png`、`07d-history-detail-scrolled.png` |
| 一致性 | **可收藏 8 / 已收藏 1→2 一致；标题文案与历史条数不一致** |

- **脚本写的 vs 实际（第 302 行）**：脚本「『我的收藏』区里 **已有 1 条（空心莲子草）**」→ 实际首屏那一行标题显示的是 **「杂草 · d0000000」**（类型 + id 前 8 位），点过「收藏」重新拉取后才变成 **「空心莲子草」/「藜」**。冷启动两次复现同样的「杂草 · d0000000」，不是偶然。
- **脚本写的 vs 实际（第 304 行）**：脚本「右上『已加载 **6** 条 · 其中未成功 **0** 条』」→ 实际 **7 条 · 未成功 1 条**。
- **脚本写的 vs 实际（第 305 行）**：脚本「标题形如『识草 · **2026-11-09 11:08:52 UTC**』、两个标签『识草』『识别完成』」→ 实际标题 **「识草 · 今天 23:25」**（#1167 已把时间戳改成人类可读），标签是三个：**「识草」「结果不确定（不可信）」「目标当前可读」**；按钮「查看详情」「删除记录」不变。

## 4 演练对数据的写入（收尾状态）

本段演练按脚本第 8、9 段的要求做了两次真实写入，收尾状态如下（下一场演示的起点）：

| 对象 | 演练前 | 演练后 |
| --- | --- | --- |
| `public.users` 档案 revision | 2（水稻 / 330106 西湖区） | **3**（同值，`PUT /me/profile` 200） |
| `public.favorites` | 1 行（空心莲子草） | **2** 行（+ 藜，`POST /favorites` 201） |
| `public.provider_call_ledger` | 6 行 | **7** 行（`invocation_state=sent`，`total_tokens=1188`） |
| `public.recognition_records` | 6 行 | **7** 行（uncertain / 0 候选） |
| `public.jobs` | 20 行 | **24** 行（识别 1 + 问答 3） |

没有改库、没有改服务、没有 down/up 任何栈；只动 38110 / 55510。

## 5 对 `docs/demo/演示脚本.md` 的校正（只改对应句子）

| 行 | 改了什么 | 为什么 |
| --- | --- | --- |
| 103 | 「服务端**端**资料读取」→「服务端资料读取」 | 脚本多一个「端」字，与页面 `modeNote` 字面量不符 |
| 104 | 「（真实读数）」→「（真实读数，等待返回）」 | `reference.js:220` 的静态文案就带这四个字；照脚本念会和屏幕不一致 |
| 126 | 补一句：进页若已被档案套住会先 0 条，需先点「清空条件继续查询」 | 实测这是正常路径（第 8 段做完档案后必然命中） |
| 133 | 「8 张资料卡」→「（点过『清空条件继续查询』之后）8 张资料卡」 | 同上 |
| 148–150 | 删掉 ⚠️「照片存储链路没有接线，拍照会得到『照片未上传』」，改成「本段可以真拍照；本机没有田间实拍图，演示时用一张不含植物主体的图会得到『结果不确定』」 | 媒体链路已接线：实测 201/200/202/202 + job uncertain，旧口径会当场被观众拆穿 |
| 158 | 「不要点相机（会走上传，本机没有接线）」→「可以点相机；若现场没有真杂草照片，结果会是『结果不确定（不可信）』+ 0 候选，这是如实回答」 | 同上 |
| 162 | 副标题保留原样（实测「得到至多 3 个候选」确实在页面上），补一句「候选为空时页面显示『没有候选』」 | 避免观众把「至多 3 个」读成承诺 |
| 171 | 兜底话术里的「照片存储链路在本机没有接线…『照片未上传』」→「照片能传上去，只是这张图里没有植物主体，所以它给『结果不确定』，不硬凑候选」 | 同 148–150 |
| 185 | 「**不要点**（本版帖子详情只读校验中，点了可能停在原地）」→「点『查看与评论』可以进详情（只读，评论区为空）」 | 实测详情页 `status=ready`、审核 approved、评论 0 条 |
| 188 | 「顶部导航 **耕云**」→「顶部导航 **社区**」 | 实际导航标题是「社区」 |
| 190 | 「【演示数据·非生产**数据**】」→「【演示数据·非生产】」 | 实际前缀少「数据」两字 |
| 216 | 「全部 / 未读 / **回复** / 系统」→「全部 / 未读 / **互动** / 系统」 | 实际第三档叫「互动」 |
| 217 | 「每条有标题与一小段摘要」→「每条是类型标签（如『系统通知』）＋ 一行引用说明＋时间，没有正文摘要」 | 实测条目形态如此 |
| 238 | 「等 5～15 秒」→「等几秒（本机实测约 2 秒）」 | 实测 2 秒 settled |
| 245 | 「回答区带蓝色小标签『演示数据』」→「页面顶部有紫色说明条『当前为演示数据…』，回答区右上角是灰色『已检查』标签」 | 没有蓝色小标签 |
| 248 | ④ 讲解词「注意这个**蓝色**的『演示数据』标签」→「注意页面上这条**紫色**的『演示数据』说明」 | 与改后的 ③ 保持一致，否则讲解词与屏幕对不上 |
| 277 | 「本场之前应为 1 / 6 / 0」→「演练收尾为 2 / 7 / 0（现场以屏幕为准）」 | 第 4 段多了一次识别、第 9 段多了一次收藏 |
| 302 | 「已有 1 条（空心莲子草）」→「已有 1 条（首屏标题会显示成『杂草 · d0000000』，收藏一次重新加载后才显示『空心莲子草』），收藏『藜』后变 2 条」 | 实测首屏标题未解析出名字 |
| 304 | 「已加载 6 条 · 其中未成功 0 条」→「已加载 7 条 · 其中未成功 1 条」 | 实测 7 / 1 |
| 305 | 「识草 · 2026-11-09 11:08:52 UTC」「两个标签『识草』『识别完成』」→「识草 · 今天 23:25」「三个标签『识草』『结果不确定（不可信）』『目标当前可读』」 | #1167 已把时间戳改成人类可读；标签数与文案不符 |
| 324 | 已知边界「拍照能识别吗？」→「能拍、能真传、能真识别；这张图里没有植物主体，所以它给『结果不确定』，不硬凑候选」 | 媒体链路已接线 |
| 328 | 「6 条识别记录」→「7 条识别记录」 | 实测 7 条 |
| 356–365 附表 | 逐行更新为本次读数：识别「拍照上传 **202** → job `uncertain`（0 候选）」；社区/消息「时间戳已是中文相对时间」；历史「7 条、未成功 1 条」；科普补「先被档案套住」；截图列改成本次文件名 | 附表是「以屏幕为准」的核对表，不更新会误导下一场 |
| 367 | 截图目录 `…\.pg17\demo-shots7\` → `…\.pg17\demo-shots-rehearsal2\` | 本次截图实际落盘目录 |
| 371 | 接缝 1「时间戳直出原始 ISO」→ 改为「已由 #1167 修复（本次实测为『今天 17:00』『昨天 18:00』『11-07』）」 | 该接缝已关闭，留着会让人白改一遍 |
| 372 | 接缝 2「中文被挤成一字一行」→ 改为「已由 #1167 修复」（本次 `08a-profile.png`、`06c-favorites-two.png` 均正常换行） | 同上，已关闭 |
| 376 | 接缝 6「媒体链路未接线时会被读成承诺」→ 改为「候选为空时页面会显示『没有候选』，『至多 3 个』不再被读成承诺」 | 媒体链路已接线 |

## 6 本次新发现、但不属于「脚本数字过期」的接缝（未改脚本正文，仅登记）

1. **`tools/prepare-wechat.mjs` 的复制清单缺 `utils/time-format.js` / `utils/session.js`**（见第 2 节）。**这是最高优先级**：不修，任何人新生成的演示副本都会在科普/社区/消息/收藏/历史五页出现「服务暂不可用」。
2. **收藏页首屏条目标题未解析名称**，显示为「杂草 · d0000000」，收藏一次重新拉取后才显示「空心莲子草」/「藜」。冷启动复现 2 次。
3. **`reference.js:220` 的「（真实读数，等待返回）」是静态字面量**，结果回来后仍写「等待返回」，容易被观众追问。
4. **问答回答正文混入实现串**（`规则 cjk-bigram+word-match/1`、`db/seeds/demo_catalog_verified.sql`、`species 行`），与接缝 4 一致，仍在。
5. **科普/问答的「演示数据」标识位置不统一**：问答是顶部紫色说明条 + 回答区「已检查」；科普详情是「已核对种子资料」标签。演示时口径要一致（都按「演示数据」讲）。
6. **首页「识草查药（本地静态资料）」文案与实际（服务端 `/herbicides` 读数）不符**（接缝 5），仍在。

## 7 不声称

- **不声称做过真机**：全部读数来自微信开发者工具模拟器（iPhone 12/13 (Pro)，390×844），没有在真实手机上跑过。
- **不声称做过多机型**：只测了这一台模拟器、这一个基础库（3.17.3），没有验证其它机型、其它系统字号或适老布局。
- **不声称验证过真实审核供应商**：社区/消息里的 approved 数据是「由真实规则引擎判出结论行的种子」，用的是**本机演示政策**，不是生产核验；没有接入、也没有验证任何真实审核供应商。
- **不声称首页「未核实」是缺陷**：三个入口卡片右上角的灰色「未核实」是设计（`human_review_state: 'under_construction'` 写死），本次按设计记录，不作为问题上报。
- **不声称走过「识别成功 + Top3 候选」的展示路径**：本次只有一张不含植物主体的真实 JPEG，真实提供者判 `uncertain`、0 候选；`succeeded` 分支的候选渲染本次没有实测。
- **不声称改过 `tools/**`**：`prepare-wechat.mjs` 的清单缺口只登记、只在本机副本里手工补文件绕过，仓库里的 `tools/**` 一个字没动。
