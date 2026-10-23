# GY-I02 过期「未接线／未实现」断言订正（文档 + 小程序文案）

- 日期：2026-10-16（本机 +08:00）
- 范围：**只订正被实测证伪的「未接线／未实现」类断言**；文档加「校订注」保留原文（⛔ 不静默抹掉历史），小程序**只改文案字符串**（⛔ 不改条件分支／请求路径）。
- 本片**不动**：`services/api/src/**`（同批另一位写手）、`packages/contracts/**`、`.github/workflows/**`、`package.json`、`docs/verification/how-to-read-ci-runs.md`、`docs/development-guide.md`、`docs/development-progress.md`、`docs/architecture/contract-status*.{json,md}`。
- 本页是本片（首轮 ＋ 返修提交合计）**唯一新增文件**；其余改动都是对既有文件加校订注或改文案。

## 0. 实测基线（先 fetch 后实测）

| 项 | 读数 |
| --- | --- |
| `git fetch upstream --prune` 后 `upstream/main` | `3bc745184c9a7c168ef01337b4db1297ea0cc72e`（2026-10-16T11:32:58Z，`test(GY-I02): 给 test:integration:http 加结构门禁… (#225)`） |
| 开工时本分支 HEAD | `3bc7451…`（与 upstream/main **同点**，`git rev-list --left-right --count HEAD...upstream/main` = `0 0`） |
| 工作区 | `E:\GengYunCommander\GengYun_W128`（`git worktree add --detach` 造的副本；主检出在 `E:\GengYunCommander\GengYun_Agent2`） |
| 分支 | `docs/gy-i02-stale-wiring-docs` |
| 本片提交（本地，未 push） | 本分支相对 `upstream/main` 的本地提交（**返修后可能有多个**，一律现场跑 `git log --oneline upstream/main..HEAD` 取全量）：`docs(GY-I02): 订正过期的"未接线／未实现"断言…(Refs #2)`；其**基线（父）提交**为 `3bc745184c9a7c168ef01337b4db1297ea0cc72e`（`upstream/main`，提交标题 `test(GY-I02): 给 test:integration:http 加结构门禁（删条／漏接／重复／坏引用／白名单腐烂均确定性变红）(Refs #2) (#225)`）。**⛔ 本页不内嵌本片自身的 SHA**（每次再提交都会让它失效）⇒ 一律用**稳定外部锚点**指代本片：基线提交 `3bc745184c9a7c168ef01337b4db1297ea0cc72e` ＋ 本片提交标题（`git log --oneline 3bc7451..HEAD` 现场取全量）。本片**首个**提交曾以 `--amend` 更新过（reflog 实测：`branch: Created`×1 ＋ `commit`×1 ＋ `commit (amend)`×3，三个中间态**均不在任何 ref** ⇒ 不可作为引用）；**返修一律新开提交**（⛔ 不 amend／不 rebase／不 force）。返修经过见 §6 |
| 工具链 | `node v24.16.0` / `npm 11.13.0`；本 worktree 原本**无 `node_modules`**，本轮执行 `npm ci`（103 packages，走 `package-lock.json`，未改锁文件） |

> ⚠ 首次跑 `npm run test:unit` 得 `tests 1824 / pass 1769 / fail 55`——**55 条失败全部是 `ERR_MODULE_NOT_FOUND`**（`fastify`／`pg`／`@electric-sql/pglite`／`ajv`），即缺 `node_modules` 的**环境**原因，不是断言或代码回归。`npm ci` 后同一命令 `tests 2345 / pass 2344 / fail 0 / skipped 1`（skip 为既有 PG 集群用例）。
> 此坑记录在案：**在 detached worktree 里下结论前必须先 `npm ci`**，否则会把环境缺失误读成红灯。

## 1. 交付 A：文档逐条订正（7 份，全部保留原文）

| 文件 | 位置（改后行号） | 过期断言 | 实测 |
| --- | --- | --- | --- |
| `docs/verification/gy-i01-contract-status-20261011.md` | `:241` 新增「本表后续校订」，`:237` 表内加指向 | 「媒体路由本身也未装配」 | `services/api/src/app.ts:1354` `registerMediaRoutes(app, config, guards, mediaService);`；媒体域 7 条路由全注册（`services/api/src/routes/media.ts:157/175/199/217/237/257/276`）。**「未取得」结论仍成立**：真实对象存储适配器未接线（`services/api/src/media/object-store.ts:136-137` `export const UNWIRED_OBJECT_STORE_REASON = '真实对象存储（S3/COS 兼容）尚未接线…'`（常量声明在 `:136`、字符串值在 `:137`，跨两行）；`:143` `export function createUnwiredObjectStore(reason = UNWIRED_OBJECT_STORE_REASON): MediaObjectStore`；`:450` 在 `resolveMediaObjectStore`（定义于 `:447`）的 `options.executionMode === 'real'` 分支内 `if (config === null) return createUnwiredObjectStore();` ⇒ 503 fail-closed） |
| `docs/verification/gy-i06-private-media-20261014.md` | `:19`（原文转述在 `:17`） | 转述「媒体 HTTP 路由尚未接线」 | `packages/media/README.md:74` 标题已改为「媒体 HTTP 路由已接线；未接线的是**句柄消费网关**」。**订正（2026-10-17 本树实读）**：三处接力点 `services/api/src/{recognitions,speech,ocr}/media.ts` 的**文件头仍为旧措辞**——`Select-String -CaseSensitive -Path services/api/src/recognitions/media.ts,services/api/src/speech/media.ts,services/api/src/ocr/media.ts -Pattern '媒体 HTTP 路由尚未接线'` 共 **4 命中**（三份的 `:8` 各 1 命中，另 `recognitions/media.ts:9` 1 命中为同句转引），且 `:10`／`:9`／`:9` 另写「本片不接线媒体 HTTP 路由」⇒ **⛔ 本页不把其文件头当现状**（与 `docs/verification/gy-i06-private-media-20261014.md:19-25` 同口径），该订正由**在飞 PR #235**（`fix/gy-i02-stale-wiring-comments`）承载。**仍未接线**：句柄消费网关、真实对象存储 |
| `docs/verification/gy-i07-detail-route-20261011.md` | `:53` | 「关联图文/用量查询整体仍未接线」 | `/knowledge/:id`、`/herbicides/:id` 均已注册（`app.ts:1298` `registerKnowledgeRoutes`）；`/api/v1/herbicides`、`/api/v1/herbicides/:id` 运行期在册 |
| `docs/verification/gy-i07-knowledge-api-20261011.md` | `:48` | 「尚未装配的 herbicides 列表/详情…仍 404」 | 同上，herbicides 两条**已装配**；**仍成立**：`staging`、`registrations` 仍 404（4 条 `planned` operation 之内）。同文 `:44`「旧测试仍假定知识路由未装配」是**引述失败原因**的历史叙述 ⇒ 仍成立，未动 |
| `docs/verification/gy-i09-identify-loop-20261011.md` | `:184`（本条在 `:183`） | 「**媒体 HTTP 未接线**」及其括注 | 同 gy-i01/gy-i06 行；本条其余（`real` 模式如实 fail-closed、未取得成功上传证据、本片不接线 `/media/**` 的范围决定）**均仍成立** |
| `docs/verification/gy-i11-speech-http-20261012.md` | `:135` | 第 1 条「`getJob`／取消未装配 ⇒ 失败终态不可经 HTTP 轮询」 | 运行期存在 `GET,HEAD /api/v1/jobs/:id` 与 `POST /api/v1/jobs/:id/cancel`（注册点 `app.ts:1953` `registerJobRoutes`）；脚本内当年观测到的 `[gap] … 404` 属**历史证据**，未据此重跑或改写。第 2–6 条未复核出过期 |
| `docs/verification/gy-i22-cross-module-security-e2e-20261027.md` | `§0 :32-37` 校订记录、`:51`／`:55` 逐条标注、`§0.1`（`:58-83`）、§7 第 5 项（`:480`） | ①「`tests/moderation/**` 无 CI 覆盖」②「专用 workflow 按名运行的 `*-pg.mjs` 计数过期」 | ① `package.json:20` `test:unit` **逐字**含 `"tests/moderation/*.test.mjs"`，且 `.github/workflows/engineering-shell.yml:46` `name: unit-tests` 在 `:58` 跑 `npm run test:unit` ⇒ **该断言不成立**（本片同 HEAD 实跑含 moderation 用例，`pass 2344 / fail 0`）。② 逐字读 `.github/workflows/`：`tests/integration/**` **34** 个脚本（枚举口径＝`*.mjs` **22** ＋ `*.cjs` **12**；同目录实际 **35** 个文件，多出的 1 个是 `tests/integration/knowledge-native-pg.ps1`、不计入脚本口径；本片实测 `total=35 mjs=22 cjs=12 ps1=1`，命令见 §5）中 **16** 个有 CI 覆盖（workflow 按名 8 个 ∪ `test:integration:http` 串的 9 个，交集 `profile-ui-http.test.mjs`），**18** 个只由作者显式跑（**2026-10-17 本树复算**：workflow 按名 **8** 个 ∪ `test:integration:http` 链 **9** 条，交集 1（`profile-ui-http.test.mjs`）⇒ 并集 **16**、其余 **18**，逐项吻合；命令见 §5。同期 `upstream/main`（`3ce0d5c`）实测 `total=36 mjs=23 cjs=12 ps1=1`、链 **11** 条 ⇒ 36／23 属 main 侧前进，**不改本页读数**）；「通用 glob 不进 CI」仍成立 |

### 1.1 本条必须点名：`docs/verification/how-to-read-ci-runs.md` 有**同源过期读数**，但**本轮禁改**

该文在**本片基线 `3bc7451`** 上 `:28` 逐字写作「`package.json` 里**逐个列出**的 6 个回环脚本」；而**同一基线 `3bc7451`** 上 `package.json:24` 的 `test:integration:http` 链逐字为 **9 条**脚本，末条为 `node tests/integration/account-deletion-http.mjs`（**本片同基线实跑 = 9 条脚本串、63 条 `PASS`／0 条 `FAIL`**）⇒ **在该基线上**该文读数比实测**少 3 条**（同源过期读数）。
> **时点说明（2026-10-17 复核）**：该文件随后已被其它片刷新——在 `1480aab3383b16daf7a5b5088c3e21cc12c422d3` 上 `:28` 逐字写 **9** 个回环脚本（`git show 1480aab:docs/verification/how-to-read-ci-runs.md`），而**同一 SHA** 的 `package.json` 链实测为 **11** 条（`git show 1480aab:package.json` 按 ` && ` 切分；末两条 `node tests/integration/speech-http.mjs`、`node tests/integration/tts-http.mjs`）⇒ 该文件该行在 `1480aab` 上**仍比真值少 2 条**。故本页所有读数**一律以各自标注的 SHA 为准**，⛔ 不随 `upstream/main` 前进而重写。
> **复算命令与输出**（2026-10-16 返修时实测，用于订正本行**原先误写的脚本段小计数**：原值 `8`，实测 `9`）：
> `node -e "const a=require('./package.json').scripts['test:integration:http'].split(' && ');console.log(a.length+' 条');console.log(a[8])"` ⇒ `9 条` ＋ `node tests/integration/account-deletion-http.mjs`；
> `npm run test:integration:http 2>&1 | Select-String -Pattern '^PASS ' | Measure-Object -Line` ⇒ `63`。
⛔ 该文件在**本轮避让清单**内，故**未改**；此处只留可追溯记录——该文件随后已被其它片刷新（见上「时点说明」），后续对照值以该段各自标注的 SHA 为准。

## 2. 交付 B：小程序 11 处——判据到**页面行为层**（页面是否真调该端点）

判据来源：`miniprogram/utils/*-api.js` 的实际请求路径 + `miniprogram/pages/**` 的调用点 + `services/api/src/app.ts` 的注册点（**不看注释自述**）。`runtime.apiBaseUrl` 是**客户端拼接基址**（`miniprogram/config/runtime.js` 出厂 `mode:'disabled'`／`apiBaseUrl:''`；本地联调工具才写入 `http://127.0.0.1:<port>/api/v1`），所以路径字面量出现在 `utils/*-api.js` 里而非 `pages/**`。

**分类小结**（两种口径并列，⛔ 勿混读）：**按主条 = 11 项**（#1–#11；#11b 是 #11 的补充行，不另计为主条）——其中 **#1–#7 共 7 项已过期**、**#8–#11 共 4 项仍成立**（7＋4＝11）；**按 §2 表行数 = 12 行**（因 **#11 跨两个文件**、按文件拆成 #11 与 #11b 两行）——**已过期 8 行**（#1–#7、#11b）、**仍成立 4 行**（#8、#9、#10、#11）、**无法判定 0 行**（8＋4＋0＝12）。两口径相差 1 ＝ #11 在两个文件上结论不同（`utils/messages-api.js` 侧**仍成立**／`pages/messages/messages.js:29-30` 侧**已过期**），故 #11 在主条口径下不并入单侧。
> 过程留痕：#11 初判为"无法判定"（以为消息域端口装配属禁改范围、无法证实），随后按 `services/api/src/app.ts:783-784`（装配 `createCommunityReferencePort`）+ `messages/reference.ts:59` 实测**改判为"仍成立"**，并把 `utils/messages-api.js` 的运行时文案**保持原样**；只有 `pages/messages/messages.js` 的**静态**文案因"把前端待接线读成服务端待接线"改为行为陈述。

**已接线（页面真的在调）**：`/auth/*`、`/me/profile`、`/catalog/*`、`/knowledge`、`/knowledge/:id`、`/public/home`、`/recognitions` + `/jobs/:id` + `/recognitions/:id/selection` + `DELETE /recognitions/:id`、`/ocr` + `/jobs/:id` + `/ocr/:id`、`/media/uploads` + `/media/uploads/:id/complete`、`/favorites`、`/history`、`/messages` + `/messages/unread-count` + `PUT /messages/:id/read`、`/speech/synthesis` + `/jobs/:id`、社区域（`utils/community-api.js`）。

| # | 位置（改前 → 改后） | 类别 | 判据 |
| --- | --- | --- | --- |
| 1 | `miniprogram/app.js:5-6`（原 1 行注释拆成 2 行；本表返修前误标 `:7`——`:7` 是空注释行 ` *`）：`识别、OCR、语音与社区业务尚未接入，登录成功不代表这些能力完成。` → 「识别、OCR、语音与社区业务**已接服务端HTTP面**（见 `services/api/src/app.ts` 的各 `register*Routes` 调用）；登录成功仍不代表这些能力的**真实验收**完成」 | **已过期** | `app.ts:1305/1306/1307/1308/1378` 分别注册识别／语音／合成／OCR／社区；工具层与页面确有调用 |
| 2 | `miniprogram/pages/home/home.js:14`：`识别、社区、消息与我的等业务尚未接入` → 「识别、标签识别、语音与社区等业务页均已接服务端…不代表真实业务验收」 | **已过期** | 同上；消息／我的（档案）另有 `/messages*`、`/me/profile` |
| 3 | `miniprogram/pages/home/home.wxml:40`：角标 `未接入` → `演示` | **已过期** | 该三张卡片分别是识别／标签识别／语音，均已接线；保留「演示」以免读成真实能力已完成 |
| 4 | `miniprogram/pages/home/home.wxml:86`：`功能尚未接入`／`…均未接入真实服务` → `演示与走查状态`／「已接服务端；真实提供者、真实数据与真机验收未完成」 | **已过期** | 同上；真机证据本轮**未取**，故保留「未完成」口径 |
| 5 | `miniprogram/pages/favorites/favorites.wxml:53`：`当前尚未接入资料查询` → `资料查询暂不可用` | **已过期** | `/knowledge`、`/knowledge/:id` 已注册且收藏页经 `utils/knowledge-api.js` 真调；空态原因改为「已上架资料为空，或查询不可用」两种可分辨情形 |
| 6 | `miniprogram/pages/identify/identify.js:171`（**符号**＝`data.modes[2]`（`key:'text'`）的 `desc`／`action`；**所在函数**＝无（在 `Page({…})` 的初始 `data` 字面量内）；**行号**＝`:171`；**实读**：2026-10-17 本树 `Select-String -CaseSensitive`，下同）：`文字提问 … （尚未接入）／尚未接入` → `打字提问入口尚未接入（本页此处不发起）`／`尚未接入` | **已过期** | 服务端 `/conversations`（问答）**已接线**：`app.ts:1384` `registerConversationRoutes(...)`，`services/api/src/routes/conversations.ts:113/124/134/146/159/172/182` 七条在册；`miniprogram` 全域**无** `/conversations` 调用（`grep -r "conversations" miniprogram` = 0 命中）⇒ 过期的是**能力不存在**这一说法；本页文案只主张「入口尚未接入（**本页此处不发起**）」＝前端无调用点，属**本页范围**（「去语音页」式改写未落地，返修提交已撤销） |
| 7 | `miniprogram/pages/identify/identify.js:282`：**符号**＝`wx.showToast`；**所在函数**＝`onShoot`（定义于 `:275`）；**行号**＝`:282`（原引 `:281` 现为并排插入的注释「文字提问入口未接入：不指向语音页…不新增跳转」）。toast `该入口尚未接入` → **实况逐字**（同 #6 实读）`文字提问入口尚未接入；本页此处不发起` | **已过期** | 同 #6；⛔ 未改分支与跳转逻辑（仍 `showToast`；`miniprogram` 全域无 `/conversations` 调用，本页 `navigateTo` 仍只有 `:684`／`:829` 两处） |
| 8 | `miniprogram/pages/identify/identify.js:285`／`:294`：**符号**＝`onRecord` 上方块注释／`wx.showToast`；**所在函数**＝`onRecord`（定义于 `:286`）／`onPlay`（定义于 `:292`；`:293` 为其守卫「guest 或无录音时直接返回」，逐字见 §8）；**行号**＝`:285`／`:294`（原引 `:284`／`:293` 因 `:281` 插入 1 行而 +1 失准）。文案 `尚未接入真实录音`／`播放能力尚未接入` | **仍成立** | 本页 `onRecord`/`onPlay` 只切文案，不调 `utils/recorder-port.js`／`utils/audio-playback.js`（那两个仅语音页用）；真实录音／播放确未接 |
| 9 | `miniprogram/pages/voice/voice.js:770`：`（真实对象存储未接线）` | **仍成立** | 与 `services/api/src/media/object-store.ts:143` `createUnwiredObjectStore`（原因常量 `:136-137`；`real` 模式默认走它，调用点 `:450`）的 fail-closed 一致；非 real 模式本就不上传 |
| 10 | `miniprogram/utils/identify-api.js:838`／`:842`／`:845` 与 `miniprogram/pages/identify/identify.js:1029`／`:1037`（**符号**＝`readOnlyNote`／`modeNoteFor` 的 `real` 分支返回串；**所在函数**＝`ocrResultView`（定义于 `:1001`）／`modeNoteFor`（定义于 `:1035`）；**行号**＝`:1029`／`:1037`；原引 `:1028`（`authorityNote`）／`:1036`（`const noun = …`）因 `:281` 插入 1 行而 +1 失准）：取消能力／真实 OCR 提供者／媒体端口未接线、本页只读 | **仍成立** | 无取消路由（`app.ts:1953` 的 job 注册表内无标签识别取消能力）；真实 OCR 提供者未接线；`PATCH /ocr/:id` 虽在册（`routes/ocr.ts:274`）但**客户端从不调用** ⇒ 「不提交人工核对」为真 |
| 11 | **两个文件**（行号分属两文件，勿混读）：`miniprogram/utils/messages-api.js:22`（注释「目标可用性端口未接线」）＋同文件 `:202`／`:209-216`／`:230`（运行时文案：`服务端真实模式；消息持久存储未接线时不会返回成功。`／`消息服务未接线`／`消息服务暂不可用（服务端未接线真实消息存储）…`）；`miniprogram/pages/messages/messages.js:27`（注释「端口未接线时**不**假装可跳」）／`:29-30`（本片已改）／`:136`（`未读数未取得：服务端未接线`） | **仍成立（已复核，非"无法判定"）** | 运行期 `/messages*` 已注册（`app.ts:1355`、`routes/messages.ts:42/52/58`）；**消息域的目标读取端口确未接线**：`services/api/src/app.ts:783-784` `reference: messagesInjection?.reference ?? createCommunityReferencePort({ community: () => communityVisibility }),`（本页写就时该处是 `createUnwiredReferencePort()`；#14／#15 后改为社区可见性投影，`createUnwiredReferencePort` 仍留在 `messages/reference.ts:59` 但已不在装配路径上），端口实现 `services/api/src/messages/reference.ts:59` 恒 `unavailable`（`services/api/src/messages/service.ts:227` `referenceStateFor` 逐次经该端口派生）⇒ 带目标的消息 `reference_state` **恒 `unavailable`**（`tests/unit/community-http.test.mjs:506` 同口径）。**对照**：收藏／历史两域走 `services/api/src/targetref/visibility.ts` 的**真实**可见性端口，已接线 ⇒ 两域说法不通用。服务端 `messages/index.ts:8-9`、`messages/service.ts:32-33` 的同一说法**同属仍成立**，本片未改（也不需改） |
| 11b | `miniprogram/pages/messages/messages.js:29-30`：`跳转入口尚未接线`／`（服务端目标读取端口未接线）` → `本页只列出消息，不提供跳转入口` | **已过期（改因）** | 前端**始终**不提供跳转（全域无目标读取调用），"尚未接线"读起来像**前端**待接线；且 `available` 分支永远走不到（服务端恒 `unavailable`）⇒ 改成对**本页行为**的陈述，去掉会误导的因果。⛔ 同一函数只改这两个字符串，未改分支与数据流 |

### 2.1 明确「仍成立」的其它同源文案（本片**未改**，防止误伤）

`miniprogram/utils/{community,favorites,history,messages,voice,identify}-api.js` 里的 `PROVIDER_UNAVAILABLE`／`OBJECT_UNAVAILABLE` 文案一律指向**真实持久存储／真实提供者／对象存储／TTS**未接线——与 `services/api/src/media/object-store.ts:143` `createUnwiredObjectStore`（原因常量 `:136-137`、`real` 模式默认路径 `:450`）的 fail-closed 一致，**仍成立**；`miniprogram/utils/debug.js:18` 同理（且 `tests/local-debug.test.mjs:96` 断言其含「未接入」，改字会连带本地联调工具 `tools/local-dev/prepare.mjs:34` 的替换串失效 ⇒ 属**另一片**范围，本片只记录不改）。

## 3. 门禁读数（在**本分支 HEAD**（含返修提交）上实测；⛔ 本页不内嵌 SHA，校验请现场跑 `git rev-parse HEAD`）

| 门禁 | 读数 |
| --- | --- |
| `npm run lint` | exit 0：`PASS tsc --noEmit services/api/tsconfig.json`、`apps/admin/tsconfig.json`、`PASS 仓库卫生扫描`、`lint 通过` |
| `npm run test:docs` | exit 0：`PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| `npm run test:unit` | exit 0：`tests 2345 / pass 2344 / fail 0 / skipped 1`（含 `tests/moderation/*.test.mjs`，即交付 A ① 的实测依据） |
| `npm run test:integration:http` | exit 0：63 × `PASS`，0 × `FAIL`（9 条脚本全绿，含 `account-deletion-http.mjs`） |
| `npm run test:mini` | exit 0：`PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax`；`tests 5 / pass 5 / fail 0` |
| `node tools/verify-contract-status.mjs` | `PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；中文表格一致` |
| `git diff --check` / `git diff --check upstream/main...HEAD` | exit 0（无空白错误） |

> `npm ci` 后 `node_modules` 被 `.gitignore:17 node_modules/` 忽略，`git status --porcelain node_modules` = 0 条，**未入库**。

## 4. 本轮**未取得**的证据（必须单列，不得当作已验收）

1. **客户端真机证据**：⛔ 本轮**未取**。没跑微信开发者工具、没装真机、没截屏、没走真机网络链路。上面所有"页面真的在调该端点"来自**源码级判据**（请求路径 + 调用点 + 注册点），**不等于**真机可用。
2. **真实外部服务**：⛔ 未做任何真实外呼（微信 `code` 交换、真实对象存储、真实 OCR/ASR/LLM/TTS 提供者均未触达）。
3. **真实 PostgreSQL 集群**：`test:unit` 里 1 条 `SKIP`（native separate-connection withdrawal）未跑；未起真实 PG 集群、未跑迁移。
4. **PR／推送**：⛔ 未 push、未建 PR、未合并、未审批（分支仅本地提交，见交接回报的实测 HEAD）。
5. **CI**：⛔ 未触发远端 CI；上表读数全部是**本机同 HEAD** 复跑所得，不能当作远端 CI 通过。
6. `tests/moderation/**` 在 **GitHub Actions 上**的历史运行记录未取（只证明了**配置与本地运行**含该 glob）。

## 5. 复现命令

```bash
git fetch upstream --prune && git rev-parse upstream/main
git rev-list --left-right --count HEAD...upstream/main
npm ci                                   # 无 node_modules 时必做，否则 unit 会假红 55 条
npm run lint && npm run test:docs && npm run test:unit && npm run test:integration:http && npm run test:mini
node tools/verify-contract-status.mjs
git ls-tree -r --name-only HEAD -- tests/integration | wc -l             # 35 个文件（§1 交付 A ② 的脚本枚举口径）
git ls-tree -r --name-only HEAD -- tests/integration | grep -c '\.mjs$'   # 22
git ls-tree -r --name-only HEAD -- tests/integration | grep -c '\.cjs$'   # 12 ⇒ 脚本口径 = 22 + 12 = 34，余 1 个 *.ps1 不计入
grep -n 'test:unit' package.json          # 看到 tests/moderation/*.test.mjs
grep -n 'npm run test:unit' .github/workflows/engineering-shell.yml
grep -rn "conversations" miniprogram      # 0 命中 ⇒ 前端未接问答端点
# N6 复算（2026-10-17 本树实读）：workflow 按名 8 个 / 链 9 条 / 交集 1 ⇒ 并集 16、其余 18
node -e "console.log(require('./package.json').scripts['test:integration:http'].split(' && ').length)"   # 9 条
# 下行为 PowerShell（本仓文档侧既有用法）：按名执行 integration 脚本去重计数 = 8
(Select-String -Path .github/workflows/*.yml -CaseSensitive -Pattern 'tests/integration/[A-Za-z0-9._-]+\.(mjs|cjs)' -AllMatches).Matches.Value | Sort-Object -Unique | Measure-Object -Line
# §3 并入判定（实读 upstream/main = 3ce0d5c5c13d71fe3b36fc8f29a6524a3a78aecf）
git log upstream/main --oneline --grep='gy-i02-stale-wiring'    # 0 命中
git log upstream/main --oneline --grep='受理前一律 409'          # 0 命中
git log 3bc7451..upstream/main -- services/api/src/recognitions/media.ts services/api/src/speech/media.ts services/api/src/ocr/media.ts   # 空 ⇒ 该域未被并入
git show upstream/main:services/api/src/ocr/media.ts | Select-String -CaseSensitive '媒体 HTTP 路由尚未接线'   # 仍命中 :8 ⇒ PR #235 未并入
```

## 6. 返修记录（2026-10-16，对抗性审查后的第二轮）

被审对象＝本片**返修前**的提交；审查报告（文件名含**被审**短 SHA，指向返修前的状态；该 SHA 是返修提交的父提交、永久可达）：`.pg17\adv-verdict-stale-wiring-docs-7828c97.md`（结论 **需修改**：2 条阻断 ＋ 1 条自相矛盾数字 ＋ 若干计数/行号偏差）。本轮**新开提交**承载全部修正（⛔ 不 amend／不 rebase／不 force）。**⛔ 本页不写入本片 HEAD 的 SHA**（写一次就过期一次）——引用本片请用「基线提交 ＋ 提交标题」或现场 `git rev-parse HEAD`。

| 项 | 原（本页返修前） | 现（实测后） |
| --- | --- | --- |
| **D2** 自指 SHA 失效 | §0 表内写「提交前最后一次 amend 后的短 SHA 为 `ca86d63`」（**已淘汰、不可引用，此处仅存历史**） | 实测该短 SHA 是**倒数第二次 amend 的中间态**、不在任何 ref（`git for-each-ref --contains ca86d63…` = **空**）⇒ **§0 已删除自指 SHA**，改用**稳定外部锚点**：基线（父）提交 `3bc745184c9a7c168ef01337b4db1297ea0cc72e` ＋ 提交标题；校验一律现场跑 `git rev-parse HEAD`／`git log --oneline 3bc7451..HEAD` |
| **D3** 行号处为空 | §1 表 gy-i01 行、§2 表 #9 行、§2.1 三处引 `services/api/src/media/object-store.ts:132` 作 fail-closed 位置 | 实测 `:132` = `}`（上一函数结尾，**该行没有任何 fail-closed 逻辑**）⇒ 三处改指**实测存在且语义正确**的位置：`:136-137` 原因常量（`:136` = `export const UNWIRED_OBJECT_STORE_REASON =`、`:137` = 字符串值 `'真实对象存储（S3/COS 兼容）尚未接线：媒体域不可用，拒绝以内存/替身存储返回成功封套'`）、`:143` `export function createUnwiredObjectStore(...)`、`:450` `if (config === null) return createUnwiredObjectStore();`（所在函数 `resolveMediaObjectStore`，定义于 `:447`）。**结论不变**（`real` 模式默认 fail-closed 503） |
| **N9** 同句数字矛盾 | §1.1 写「共 **8** 个脚本段」而同一句又写「**9** 条脚本」 | 实测 `package.json:24` 的 `test:integration:http` 链 = **9** 条 ⇒ 统一为 **9 条脚本串**（63 条 `PASS`／0 条 `FAIL`），并附复算命令与输出（见 §1.1） |
| **N3** 被引行号偏移 | §1 表 gy-i22 行标 §7 第 5 项 `:478`、`§0` 记 `:32-36`、`§0.1` 记 `:58-81` | 实测 §7 第 5 项在 **`:480`**（`git diff -U0` 的 `@@ -443 +480 @@`）；校订记录实际占 `:32-37`、§0.1 实际占 `:58-83` ⇒ 三处行号已按实测改写 |
| **N4** 表头未区分文件（可选） | §2 表 #11 位置列把 `utils/messages-api.js` 与 `pages/messages/messages.js` 的行号混写在同一括号内 | 已在**不改引用事实**的前提下分行写明：`utils/messages-api.js:22`＋`:202`／`:209-216`／`:230`；`pages/messages/messages.js:27`／`:29-30`／`:136`（逐行复核命中） |
| **基线漂移**（审查期间实测） | §0 只记 `upstream/main` = `3bc7451…` | 审查期间 `upstream/main` 前移到 `06d63453c7890f96aa6fb4dc3ca3cd03c5cf70a3`（`docs(GY-I07): 订正知识域两处已证伪的注释断言（只改注释，零行为改动）(#226)`）；`git merge-base --is-ancestor 3bc7451 upstream/main` **exit 0**（未 force-push），且 `git diff --name-only 3bc7451..06d6345 -- <本片 8 份文档>` = **空** ⇒ 本页全部判定不受影响 |

**返修后的行号↔内容逐条复核**（本页全部 `file:line` 引用，2026-10-16 实测：行号＋行内容要点＋所在函数/位置）：

- `services/api/src/media/object-store.ts:132` = `}`（**空引用，已改**）；`:134` = 注释「未接线（fail-closed）」；`:136` = `export const UNWIRED_OBJECT_STORE_REASON =`（**跨行**）；`:137` = `  '真实对象存储（S3/COS 兼容）尚未接线：媒体域不可用，拒绝以内存/替身存储返回成功封套';`；`:143` = `export function createUnwiredObjectStore(reason: string = UNWIRED_OBJECT_STORE_REASON): MediaObjectStore`；`:145` = `new MediaError('PROVIDER_UNAVAILABLE', …（fail-closed）, { retryable: true })`；`:447` = `export function resolveMediaObjectStore(options: ResolveObjectStoreOptions): MediaObjectStore`；`:450` = `if (config === null) return createUnwiredObjectStore();`（在 `options.executionMode === 'real'` 分支内）。
- `services/api/src/app.ts` 的 `:631`／`:1298`／`:1305`／`:1306`／`:1307`／`:1308`／`:1313`／`:1354`／`:1355`／`:1378`／`:1384` 逐行与各调用一致 ✔（例：`:1354` = `registerMediaRoutes(app, config, guards, mediaService);`；`:1384` = `registerConversationRoutes(app, config, guards, conversationService);`）。
- `services/api/src/routes/media.ts:157/175/199/217/237/257/276` = 7 处 `app.<method>(` ✔；`services/api/src/routes/conversations.ts:113/124/134/146/159/172/182` = 7 处 `app.<method>(` ✔；`services/api/src/routes/ocr.ts:274` = `app.patch(` ✔；`services/api/src/routes/messages.ts:42/52/58` = `/messages`、`/messages/unread-count`、`/messages/:id/read` 三处注册 ✔。
- `packages/media/README.md:74` = `## services/api 挂载示例（媒体 HTTP 路由已接线；未接线的是**句柄消费网关**）` ✔。
- `services/api/src/messages/reference.ts:59` = `export function createUnwiredReferencePort(`（`:63` = `kind: 'unwired'`；`:65` = `available: false`）✔；`services/api/src/messages/service.ts:227` = `async function referenceStateFor(record: MessageRecord, userId: string): Promise<ReferenceState>`、`:229` = `if (reference.available !== true) return 'unavailable';` ✔；`messages/index.ts:8-9`、`messages/service.ts:32-33` 同口径 ✔。
- `tests/unit/community-http.test.mjs:506` = 断言 `added[0].reference_state === 'unavailable'` ✔；`miniprogram/utils/debug.js:18`、`tests/local-debug.test.mjs:96`（`assert.match(message, /未接入/)`）、`tools/local-dev/prepare.mjs:34` ✔。
- `miniprogram/app.js` 的改动行实测为 **`:5-6`**（原 §2 表 #1 写 `:7`，`:7` 是空注释行 ` *`）⇒ 已按实测改。

**本轮改动仍只落在文档正文/注释与文案字符串**：`git diff -U0 upstream/main...HEAD -- miniprogram` 与上一轮**逐字相同**（仍全是同行数替换/注释拆分，无逻辑、无条件分支、无请求路径改动）；`tests/**`、`packages/contracts/**`、`services/api/src/**`、`.github/workflows/**`、`package.json` 继续 **0 改动**（读数见交接「返修记录」节）。

## 7. 返修记录（2026-10-17，第三轮：本页三处口径与行号精度 ＋ §1.1 时点绑定）

本轮只动本页，**新开提交**（⛔ 不 amend／不 rebase／不 force），订正上一轮遗留的三处表述精度问题（P1–P3），并按 `upstream/main` 前进后的实测补一处**时点绑定**（P4）；**分类与证据条目一律未增删、未改判**，P1–P4 **均未改动既有实测数字**。

| 项 | 原（本轮改前，逐字） | 现（实测后，逐字） | 判定 |
| --- | --- | --- | --- |
| **P1** §2 分类小结总数与分项对不上 | `**分类小结（11 处按条目计）**：**已过期 8**（#1–#7、#11b）、**仍成立 4**（#8、#9、#10、#11）、**无法判定 0**。` | 改为**两种口径并列**：**按主条 = 11 项**（#1–#11；#11b 是 #11 的补充行）⇒ 7 项已过期 ＋ 4 项仍成立 ＝ 11；**按 §2 表行数 = 12 行**（#11 跨两个文件、拆成 #11／#11b 两行）⇒ 8 行已过期 ＋ 4 行仍成立 ＋ 0 行无法判定 ＝ 12 | **单位混用**（非总数错）：`11` 是**主条**数、`8＋4＋0＝12` 是**表行**数，差额 1 ＝ #11 在 `utils/messages-api.js` 侧仍成立／`pages/messages/messages.js:29-30` 侧已过期。分项分类本身无误，故**未改任何条目或类别** |
| **P2** §1 交付 A ② 的「34 个脚本」未写明枚举口径 | `tests/integration/**` 34 个脚本中 **16** 个有 CI 覆盖 | `tests/integration/**` **34** 个脚本（枚举口径＝`*.mjs` **22** ＋ `*.cjs` **12**；同目录实际 **35** 个文件，多出的 1 个是 `tests/integration/knowledge-native-pg.ps1`、不计入脚本口径；本片实测 `total=35 mjs=22 cjs=12 ps1=1`，命令见 §5） | **口径未写明**（非计数错）：34 只在 `*.mjs`／`*.cjs` 口径下成立，同口径出处是被引的 `docs/verification/gy-i22-cross-module-security-e2e-20261027.md:74`；已在**本页行内**写明枚举与差额 |
| **P3** 原因常量被合写成单行 `:136` | §1 表 gy-i01 行、§2 表 #9 行、§2.1、§6 D3 行、§6 复核清单五处均引 `services/api/src/media/object-store.ts:136`（其中复核清单写成 `:136` = `export const UNWIRED_OBJECT_STORE_REASON = '…'`） | 五处一律改指 **`:136-137`**（常量**跨两行**）：`:136` = `export const UNWIRED_OBJECT_STORE_REASON =`、`:137` = `  '真实对象存储（S3/COS 兼容）尚未接线：媒体域不可用，拒绝以内存/替身存储返回成功封套';` | **行号精度不足**（非空引用）：实测 `:136` 行末为 `=`、字符串值在 `:137`；按「引用的文本落在哪一行就给哪一行／跨行给区间」订正。`:143`／`:145`／`:447`／`:450` 四行经复核均为单行完整内容，**未改** |
| **P4** §1.1 对被引文件的读数未绑定测量时点 | `该文 `:28` 逐字写作「…的 6 个回环脚本」；而实测 `package.json:24`（基线 `3bc7451`）同一链逐字为 **9 条**…` | 两侧读数**各自绑定 SHA**（**均＝本片基线 `3bc7451`**），并加「**时点说明（2026-10-17 复核）**」：在 `1480aab3383b16daf7a5b5088c3e21cc12c422d3` 上该文件 `:28` 逐字写 **9**、而**同一 SHA** 的链实测 **11** 条（末两条 `node tests/integration/speech-http.mjs`、`node tests/integration/tts-http.mjs`）⇒ 该行在 `1480aab` 上**仍比真值少 2 条**；本页读数一律以各自标注的 SHA 为准。§1.1 末行「请下一片…按 9 条刷新」改为指向该时点说明 | **被引文件已刷新**（非本页计数错）：`1480aab:docs/verification/how-to-read-ci-runs.md` 的 blob 已由 `2c486f48f67c27e51af2fd0c57ed80b0f166e4b1` 变为 `6c31e055e4670f727767ae28743040b3545d4719` ⇒ `:36` 原「6」的表述在并入后的 main 上会与实文不符。两侧数字（`6`／`9`、`9`／`11`）**一律未改**，只加 SHA 绑定与时点说明 |

## 8. 返修记录（2026-10-17，第四轮：M5 行号与「改后」文案回到实况、M6 假断言、N4 消歧、N6 复算、§3 并入判定）

被审对象＝`556dcbbbe53fac37457cf4edc11d08091416a19a`；审查报告＝`.pg17\adv-verdict-stale-wiring-docs-payload-556dcbb.md`（结论 **需修改**：M5／M6 各 1 条 ＋ N4／N6 各 1 条）。本轮**只动本页**（唯一改动文件 `docs/verification/gy-i02-stale-claims-20261016.md`），**新开提交叠在 `556dcbb` 之上**（⛔ 不 amend／不 rebase／不 force）。分类与证据条目一律**未增删、未改判**；§3 并入判定＝**未并入 ⇒ 措辞不变**，故 `docs/verification/gy-i06-private-media-20261014.md` ⛔ 未改。

### 8.1 M5：六处「符号 → 所在函数 → 行号」（2026-10-17 本树 `Select-String -CaseSensitive` 实读）

失准根因：`556dcbb` 在 `miniprogram/pages/identify/identify.js:281` 插入 1 行注释（原 `wx.showToast` 下移为 `:282`），使其下引用 **+1**。

| # | 符号 | 所在函数 | 改前引 | 改后引 | 该行逐字要点 |
| --- | --- | --- | --- | --- | --- |
| 6 | `data.modes[2]`（`key:'text'`）的 `desc`／`action` | 无（在 `Page({…})` 初始 `data` 字面量内；`Page({` 在 `:158`） | `:171` | `:171`（正确，未偏移） | `desc: '打字提问入口尚未接入（本页此处不发起）', action: '尚未接入'` |
| 7 | `wx.showToast` | `onShoot`（定义于 `:275`） | `:281` | `:282` | `title: '文字提问入口尚未接入；本页此处不发起'` |
| 8a | `onRecord` 上方块注释 | `onRecord`（定义于 `:286`） | `:284` | `:285` | `/** 录音入口：**尚未接入真实录音**，只切换按钮文案…` |
| 8b | `wx.showToast` | `onPlay`（定义于 `:292`；`:293` 为其守卫「guest 或无录音时直接返回」） | `:293` | `:294` | `title: '播放能力尚未接入'` |
| 10a | `readOnlyNote` | `ocrResultView`（定义于 `:1001`） | `:1028` | `:1029` | `'本页只读：不提供编辑标签文本、也不提交人工核对…'` |
| 10b | `modeNoteFor` 的 `real` 分支返回串 | `modeNoteFor`（定义于 `:1035`） | `:1036` | `:1037` | `if (mode === 'real') return '服务端为 real 模式：…'` |

改前的 `:281`／`:284`／`:293`／`:1028`／`:1036` 实测逐字＝新注释行／空行／守卫逐字 `if (this.data.guest || !this.data.hasRecording) return`／`authorityNote: …`／`const noun = kind === 'ocr' ? …`（负控制输出见 8.4）。#6／#7 的「改后」文案一律改回**本树实况逐字**：`打字提问入口尚未接入（本页此处不发起）`／`尚未接入`、toast `文字提问入口尚未接入；本页此处不发起`；并写明「打字提问在语音页…／去语音页」式改写**未落地**（返修提交已撤销）。

### 8.2 M6：`:27` 的假断言（三份 `media.ts` 文件头）

改前（逐字）：「…三处接力点 `services/api/src/{recognitions,speech,ocr}/media.ts` **文件头随之更新**。」
实读：`Select-String -CaseSensitive -Path services/api/src/recognitions/media.ts,services/api/src/speech/media.ts,services/api/src/ocr/media.ts -Pattern '媒体 HTTP 路由尚未接线'` ⇒ **4 命中**（三份的 `:8` 各 1，另 `recognitions/media.ts:9` 1 为同句转引）；`:10`／`:9`／`:9` 另写「本片不接线媒体 HTTP 路由」⇒ 文件头**仍为旧措辞** ⇒ 原断言为假，且与 `docs/verification/gy-i06-private-media-20261014.md:21-23` 相矛盾。
改后：删去该断言，改为「**订正（2026-10-17 本树实读）**：…的**文件头仍为旧措辞**——…共 **4 命中**…⇒ **⛔ 本页不把其文件头当现状**（与 `docs/verification/gy-i06-private-media-20261014.md:19-25` 同口径），该订正由**在飞 PR #235**（`fix/gy-i02-stale-wiring-comments`）承载。**仍未接线**：句柄消费网关、真实对象存储」⇒ 同载荷内自相矛盾消除。

### 8.3 N4／N6／§3

| 项 | 原（逐字） | 现 | 判定 |
| --- | --- | --- | --- |
| **N4** `:64` shorthand 歧义 | （`service.ts:227` `referenceStateFor` | （`services/api/src/messages/service.ts:227` `referenceStateFor` | 消歧。反引号包裹**非链接**（若改写成 Markdown 链接形式，`test:docs` 会判 `missing link path:227` 而红）。同行 `messages/index.ts:8-9`／`messages/service.ts:32-33` 按派单**未动** |
| **N6** 记 `34/16/18` | 「…**18** 个只由作者显式跑」 | 加「**2026-10-17 本树复算**：workflow 按名 **8** 个 ∪ `test:integration:http` 链 **9** 条，交集 1（`profile-ui-http.test.mjs`）⇒ 并集 **16**、其余 **18**，逐项吻合；同期 `upstream/main`（`3ce0d5c`）实测 `total=36 mjs=23 cjs=12 ps1=1`、链 **11** 条 ⇒ 36／23 属 main 侧前进，**不改本页读数**」；§5 补两条复算命令 | **可复现 ⇒ 三个数字一律未改**（本树 `tests/integration` 35 个文件＝`*.mjs` 22 ＋ `*.cjs` 12 ＋ `*.ps1` 1，脚本口径 34） |
| **§3** 条件项：PR #235 是否已并入 `upstream/main` | 措辞「订正由**在飞 PR #235**…承载」 | **未改**（判定＝**未并入**） | 实读 `upstream/main`＝`3ce0d5c5c13d71fe3b36fc8f29a6524a3a78aecf`：`git log upstream/main --grep='gy-i02-stale-wiring'`＝0 命中、`--grep='受理前一律 409'`＝0 命中、`git log 3bc7451..upstream/main -- <三份 media.ts>`＝**空**、`git show upstream/main:services/api/src/ocr/media.ts` 的 `:8` 仍含旧句。`84de2ce4…` 仅存在于本地／origin 的 `fix/gy-i02-stale-wiring-comments` ref（判「是否已并入」⛔ 未用 `git merge-base --is-ancestor`） |

### 8.4 行号断言的正／负控制（本页 §2 的六处行号**有**可检出手段）

正控制：按订正后行号逐条断言「该行含文档所引文本」⇒ **6/6 命中**。负控制：同断言故意沿用**改前**行号（-1 偏移）⇒ **0/6 命中**（`:170` 为 ocr 模式项、`:281` 为新注释、`:284` 为空行、`:293` 为守卫、`:1028` 为 `authorityNote`、`:1036` 为 `const noun`）⇒ 该读数**有自动回归保护**（可检出 +1 型失准）。

```powershell
$lines = Get-Content -LiteralPath miniprogram/pages/identify/identify.js -Encoding UTF8
$pairs = @(@{n=171;s='打字提问入口尚未接入（本页此处不发起）'},@{n=282;s='文字提问入口尚未接入；本页此处不发起'},
           @{n=285;s='尚未接入真实录音'},@{n=294;s='播放能力尚未接入'},
           @{n=1029;s='本页只读'},@{n=1037;s='real 模式'})
($pairs | Where-Object { $lines[$_.n-1] -clike ('*'+$_.s+'*') }).Count   # 6；负控制改用 ($_.n-2) ⇒ 0
```

### 8.5 本轮门禁（本页内容上有本提交，逐项实跑）

| 门禁 | exit | 读数 |
| --- | --- | --- |
| `npm run lint` | 0 | `lint 通过`（tsc ×2 ＋ 仓库卫生扫描） |
| `npm run test:docs` | 0 | `PASS: 27 initial tasks; acyclic dependencies; …; Markdown links and tables` |
| `node tools/verify-contract-status.mjs` | 0 | `PASS: 覆盖 112 条契约操作…中文表格一致` |
| `npm run test:unit` | 0 | `tests 2345 / pass 2344 / fail 0 / skipped 1` |
| `npm run test:mini` | 0 | `tests 5 / pass 5 / fail 0` |
| `npm run test:integration:http` | 0 | 9 条脚本串全绿、`^FAIL` 0 条（`tests/**` 本轮 0 改动 ⇒ §3 表读数不受影响） |

`package.json` **无** `verify-contract-status` 脚本 ⇒ 按**命令**实跑 `node tools/verify-contract-status.mjs`。⛔ 未直接跑 `python tools/validate_development_docs.py`（`npm run test:docs` 即其官方 wrapper）。首次 `test:docs` 曾因 8.1 表 #8 行内写入逐字守卫（`if (this.data.guest || !…`）多出 2 个竖线而 **exit 1**（`ERROR: …:61/:62: inconsistent table`）⇒ 已把逐字守卫移到本节 8.1 表（改为文字描述），复跑 exit 0；**逐字原文未丢**：守卫逐字与 `:285` 行要点均在本节 8.1 的**正文与表内**实读保留。
