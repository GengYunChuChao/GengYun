# GY-R92 真实照片拍照识别证据（模拟器，2026-11-10）

本页登记一次「应用链路 + 界面」实测：real 演示栈 + 仓外小程序副本 + 微信开发者工具模拟器 + `miniprogram-automator`，用本机 `demo-photos` 里的真实杂草照片跑「拍照识别」，两单各跑一次、另重跑一单补截图。

模型「认得这两张图」在这之前已由直连供应商的对照验过；本页要证的是**从上传到出候选，应用这条链真的走通了，界面照实显示**。本页不证明准确率，也不替代真机验收。

## 1 环境取证

| 项 | 实测值 |
| --- | --- |
| 时间窗 | 2026-11-10 03:40:16 – 03:47（+08:00）；`GET /health` 返回时 `uptime_s` 为 24（栈刚起，本轮没有重启过它） |
| API | `http://127.0.0.1:38110`，`meta.execution_mode` 为 `real` |
| 数据库 | PG `127.0.0.1:55510`，库 `gengyun`，客户端 `E:\GengYunCommander\.pg17\pgsql\bin\psql.exe` |
| 健康检查 | `GET /health` → 200，原文见下方代码块 |
| 小程序副本 | `E:\GengYunCommander\.pg17\demo-project\wechat-local-r92`（**在工作树之外**；同一时刻该工作树 `git status --porcelain` 为 0 条，仓库里没有第二份 `miniprogram/`） |
| 副本 `apiBaseUrl` | `http://127.0.0.1:38110/api/v1`（`miniprogram/config/runtime.js`：`module.exports = {"mode":"local","apiBaseUrl":"http://127.0.0.1:38110/api/v1"}`） |
| appid / 基础库 | `wx4407a4b908a69a54` / `3.17.3`；`project.config.json` 里 `miniprogramRoot` 为 `miniprogram/`、`setting.urlCheck` 为 `false` |
| 开发者工具 | `2.02.2608080` |
| 自动化 | `miniprogram-automator` 0.13.0，端点 `ws://127.0.0.1:9422` |
| 模拟器 | `iPhone 12/13 (Pro)`；`mp.systemInfo()` 给出 `platform=devtools`、`SDKVersion=3.17.3`、`version=8.0.5`、`windowWidth=390`、`windowHeight=753` |
| 启动方式 | `cli.bat close --project "<副本>"` → `cli.bat auto --project "<副本>" --auto-port 9422` |

`GET /health` 原文：

```json
{
  "status": "ok",
  "checks": {
    "api": { "status": "ok" },
    "database": { "configured": true, "status": "ok", "latency_ms": 1 }
  },
  "meta": {
    "request_id": "6124c53d-07e2-41a1-91ba-eecd76fcd42d",
    "contract_version": "1.0.0",
    "execution_mode": "real"
  },
  "uptime_s": 24
}
```

服务端侧的前置状态（本轮只读、未改）：

- 三个 feature flag 均为开：`ai_enabled`、`specific_herbicide_output_enabled`、`submissions_enabled`，`revision` 都是 2，`reason` 都是 `demo-stack local demo profile (non-production)`。
- 两条隐私政策记录都是 `granted`（环境预置，不是本轮点出来的）：`media_processing` 与 `external_inference`，政策版本 `demo-stack-local-2`，接收方 `["demo-stack-weed-vision"]`，`consent_epoch` 7、`revision` 8，granted_at `2026-11-09 19:08:11+08`。
- 媒体批准在这台栈上是**开着**的：`POST /media/uploads` 没有回 503，两单照片都落了 `media` 行且 `state=ready`（第 3 节）。这一点是旧口径「本机拍照只会得到『照片未上传』」失效的直接原因——旧口径对应的是没有媒体批准那次起的栈。

登录（第 1 步）：

- 页面 `pages/login/login` 上有两个按钮：「微信登录」（`miniprogram/pages/login/login.wxml:5`）与「以游客身份浏览首页」（`miniprogram/pages/login/login.wxml:6`）。本轮点的是前者。
- 登录后 `wx.getStorageSync('gengyun.session')` 有 4 个字段：`accessToken`、`audience`、`expiresAt`、`executionMode`；`accessToken` 长度 43，`expiresAt` 为 `2026-11-16T19:41:55.168Z`。**token 值没有打印、也没有写进任何文件**，本页只记长度与过期时间。

## 2 注入方式，以及它的边界

识别页上的「拍照识别」按钮会调 `wx.chooseMedia`（`miniprogram/pages/identify/identify.js:315`）。模拟器里没有相机，脚本也点不到系统相册，所以本轮**不走** `chooseMedia`：把同一份 JPEG 字节写进 `wx.env.USER_DATA_PATH`，再取页面实例调 `prepareMedia(filePath)`——这正是 `chooseMedia` 成功回调里那一行调用的同一个函数（`miniprogram/pages/identify/identify.js:326` 调它，函数体在 `miniprogram/pages/identify/identify.js:333`）。

因此本页证明的是「自 `prepareMedia` 起」的一整条链：尺寸预检（`miniprogram/pages/identify/identify.js:354`）→ 私有上传（`miniprogram/pages/identify/identify.js:362`）→ 建任务（`miniprogram/pages/identify/identify.js:376`）→ 轮询（`miniprogram/pages/identify/identify.js:380`）→ 出候选 → 落历史。**不证明**相机/相册选择器可用（见第 6 节第 1 条）。

注入后页面自己往下走，脚本每 250 ms 读一次 `page.data()` 到终态。

## 3 两单读数

### 3.1 上传的媒体

| 单 | 文件 | 字节 | `media.sha256` | `media.id` | `state` / `revision` |
| --- | --- | ---: | --- | --- | --- |
| 1 | `01-Eleusine_indica.jpg` | 161420 | `de4e7b26477841dbb52a54444240b1780f562869f57f3ebe04164e0f61984254` | `db73d337-3951-429d-9734-e86a6aba6cd3` | `ready` / 2 |
| 2 | `03-Echinochloa_crus-galli.jpg` | 1281517 | `73c5bdec97370b127f6f728369545af012dc3af8d1a11b943ca1acbd82eb3d1b` | `ec6ec727-8152-40bf-9b1d-63c94a24bf5b` | `ready` / 2 |
| 3（补截图，重跑单 1） | `01-Eleusine_indica.jpg` | 161420 | `de4e7b26477841dbb52a54444240b1780f562869f57f3ebe04164e0f61984254` | `42cf8f74-99c3-4613-8e6f-8d1a4eb45645` | `ready` / 2 |

两单的 `bytes` 与 `sha256` 与本地文件逐字节一致（本地指纹见 [演示图片来源页](../demo/演示图片-来源.md)）。同一份 01 字节上传了两次，`media` 因此有两条行、`sha256` 相同——**上传链路没有做内容去重**，这是本轮观察到的事实，不是缺陷结论。

### 3.2 任务与结果（逐字）

| 单 | `recognition_jobs.id` | `recognition_records.id` | `state` | `error_code` | `model_version` |
| --- | --- | --- | --- | --- | --- |
| 1 | `8c8e6939-86a0-40f9-b00d-b5d9d9439166` | `933d81c2-1c1e-4d9a-83b1-d127f4da1017` | `succeeded` | NULL | `openai-vision-v1` |
| 2 | `23c45caa-5ed5-49bd-98d9-6f51a3b8231f` | `b7a4a2aa-0168-490a-81a7-541c780e78f2` | `succeeded` | NULL | `openai-vision-v1` |
| 3 | `dea89ea2-19de-4b56-91c2-c53b32b12079` | `edb20398-c4e4-49e3-9e93-32893fe5b610` | `succeeded` | NULL | `openai-vision-v1` |

三单的 `candidates` 与 `uncertainty_reasons` 原文（`recognition_records` 列值，逐字）：

- 单 1：`[{"rank": 1, "species_id": "species_goosegrass", "model_score": 0.55}]`；`uncertainty_reasons` = `[]`
- 单 2：`[{"rank": 1, "species_id": "species_barnyardgrass", "model_score": 0.78}]`；`uncertainty_reasons` = `[]`
- 单 3：`[{"rank": 1, "species_id": "species_goosegrass", "model_score": 0.72}]`；`uncertainty_reasons` = `[]`

三单的 `selected_species_id` 都是 NULL，`revision` 都是 1，`deleted` 都是 `false`——**没有任何人工确认**。

`GET /jobs/{id}` 200 的原文要点（单 1）：`revision` 3、`kind` 为 `recognition`、`deadline_at` 2026-11-09T19:42:45.987Z、`error_code` 为 `null`、`result.value.model_version` 为 `openai-vision-v1`、`meta.execution_mode` 为 `real`、`meta.request_id` 为 `3680e7a2-f1fb-497f-849f-e801e9349531`。

### 3.3 页面与账本读数

| 单 | 页面 `state` / `errorCode` | 页面耗时（提交→终态） | 阶段时间线（ms） | 账本 token（总 / 提示 / 补全） | 账本 `duration_ms` |
| --- | --- | ---: | --- | --- | ---: |
| 1 | `succeeded` / null | 5169 ms | 723 无 → 1446 `queued` → 2997 `running` → 5169 `succeeded` | 1319（983 / 336） | 3415 |
| 2 | `succeeded` / null | 6383 ms | 533 无 → 2097 `queued` → 3452 `running` → 6383 `succeeded` | 1474（1191 / 283） | 3134 |
| 3 | `succeeded` / null | 5127 ms | 26 无 → 1091 `queued` → 2178 `running` → 5127 `succeeded` | 1280（983 / 297） | 3412 |

三单 `provider_call_ledger` 的 `invocation_state` 都是 `sent`，`provider_config_version` 都是 `openai-vision-v1#deepseek-flash@1233de6f`。`usage` 原文（逐字）：

- 单 1：`{"total_tokens": 1319, "prompt_tokens": 983, "completion_tokens": 336, "prompt_cache_hit_tokens": 768, "prompt_cache_miss_tokens": 215}`
- 单 2：`{"total_tokens": 1474, "prompt_tokens": 1191, "completion_tokens": 283, "prompt_cache_hit_tokens": 1024, "prompt_cache_miss_tokens": 167}`
- 单 3：`{"total_tokens": 1280, "prompt_tokens": 983, "completion_tokens": 297, "prompt_cache_hit_tokens": 768, "prompt_cache_miss_tokens": 215}`

单 1 与单 3 是同一份字节：`prompt_tokens` 都是 983、缓存命中都是 768 / 未命中 215（提示词逐字相同），差异只在 `completion_tokens`（336 对 297），分数也就不同（0.55 对 0.72）。

## 4 同一份字节的历史读数（稳定性证据，不是结论）

把库里这两份 `sha256` 的全部识别记录按时间排开（含本轮之前几轮）：

| 时间（+08:00） | 文件 | 候选 | `model_score` |
| --- | --- | --- | ---: |
| 2026-11-10 00:00:11 | 01 | `species_crabgrass`（马唐） | 0.6 |
| 2026-11-10 00:02:19 | 01 | `species_goosegrass`（牛筋草） | 0.62 |
| 2026-11-10 00:06:14 | 01 | `species_goosegrass`（牛筋草） | 0.72 |
| 2026-11-10 03:42:19 | 01 | `species_goosegrass`（牛筋草） | 0.55 |
| 2026-11-10 03:44:36 | 01 | `species_goosegrass`（牛筋草） | 0.72 |
| 2026-11-10 00:01:51 | 03 | `species_barnyardgrass`（稗草） | 0.66 |
| 2026-11-10 00:07:10 | 03 | `species_barnyardgrass`（稗草） | 0.62 |
| 2026-11-10 03:42:52 | 03 | `species_barnyardgrass`（稗草） | 0.78 |

同一份 01 字节一共跑过 5 次：4 次牛筋草（0.55–0.72）、1 次马唐（0.6）。03 跑过 3 次，都是稗草（0.62–0.78）。**页面上写的「分数不是准确率」是对的**：这些数字随采样波动，不能当准确率读，也不能当稳定性承诺。

## 5 界面读数（截图清单）

截图都在本机 `E:\GengYunCommander\.pg17\demo-shots-photos\`，**不入库**；下面只列文件名与「这张拍到了什么」，本页不嵌入图片。

状态机的三态证据来自单 3 那一轮（第一次截图时页面停在页首，状态块根本没入画，那几个文件不能当证据，见下表的说明）。

| 文件 | 拍到的界面 | 关键读数 |
| --- | --- | --- |
| `00-after-login.png` | 登录后的首页 | 「早安，田间探索者」、深绿主视觉卡「识草查药，除草不求人」+「开始识别」、「你的田间工具」三个入口（带「未核实」标签） |
| `09-p4-idle.png` | 识别页下半屏（已滚动） | 「任务状态」标题、「我的识别记录（私有）」本机索引 2 条、「清空本机索引」「我的 → 识别历史」 |
| `10-p4-queued.png` | 单 3 刚提交 | `JobState: queued`、「已受理，排队中」、「任务已建立，尚未开始识别。」、「取消任务」 |
| `10-p4-running.png` | 单 3 处理中 | `JobState: running`、「识别中」「正在识别，请稍候。」、「取消任务」 |
| `11-p4-result-state.png` | 单 3 终态（状态块 + 候选区同屏） | `JobState: succeeded`、「识别完成」、「候选（识别成功）」`#1 牛筋草`、`模型分数：72%` |
| `11-p4-result-candidates.png` | 单 3 终态（紧一档滚动） | 同上；下方本机索引变成 3 条 |
| `11-p3-result-candidates.png` | 单 2（半滚，约 300 px） | 三个入口卡 + 状态块露出 `JobState: succeeded`「识别完成」；候选区未入画 |
| `10-p1-running.png`、`11-p1-result.png`、`10-p3-queued.png`、`10-p3-running.png`、`11-p3-result.png` | 首版截图（页面停在页首） | 只有入口卡与页首说明；状态块不在画面内——**不能当处理中或终态证据**，本轮保留它们只为记账 |
| `20-history-top.png` | 历史页顶部 | 「全部记录」「已加载 18 条 · 其中未成功 4 条」、前两张卡「识草 · 今天 03:44 / 今天 03:42」，标签「识草」「识别完成」「目标当前可读」 |
| `21-history-detail.png` | 详情页（单 3） | 「识草详情」、任务状态「识别完成」、`目标当前可读`、模型候选 `#1 牛筋草 72%` |
| `22-history-detail-s420.png` | 同一详情页滚到「人工选择」 | 「你还没有在这条记录里确认物种」、来源（模型）版本 `openai-vision-v1`、「重新实时读取」「删除这条记录」 |
| `23-p1-detail.png` | 详情页（单 1） | 候选 `#1 牛筋草 55%`、「未人工选择」、来源版本 `openai-vision-v1` |
| `24-p3-detail.png` | 详情页（单 2） | 候选 `#1 稗草 78%`、「未人工选择」 |
| `raw-p1.json`、`raw-p3.json`、`raw-p4.json` | 三单的原始快照 | `snap`（页面 `data()` 摘录）+ `GET /jobs/{id}` 原文 + 250 ms 采样的时间线 |

界面里这几处文字与代码一致，可以对照：

- 状态块把契约状态名直接写在屏上：`JobState：{{stateView.state}}`（`miniprogram/pages/identify/identify.wxml:54`）——不靠颜色传达状态。
- 「取消任务」只在非终态出现（`miniprogram/pages/identify/identify.wxml:75` 的条件是 `!stateView.terminal`）。
- 候选区标题三态：`succeeded` 且可信时写「候选（识别成功）」，不可信时写「候选（不可信，需人工核对）」（`miniprogram/pages/identify/identify.wxml:199`）。
- 分数那行是 `模型分数：{{item.scoreText}}`（`miniprogram/pages/identify/identify.wxml:207`）。
- 详情页从历史列表打开：`miniprogram/pages/history/history.js:134` 拼 `/pages/historydetail/historydetail?id=<行 id>`。本轮自动化点不到那个自定义按钮，改走同一个 URL——行为等价，但「点按钮」这一下没被覆盖。

## 6 不能证明的六条（不要引用成别的意思）

1. **不声称真机可用。** 全程是开发者工具模拟器（`platform=devtools`）；相机、相册权限、真机网络与渲染都没碰。本轮连 `wx.chooseMedia` 都没有走（第 2 节）。
2. **不声称多机型。** 只跑了一个模拟器配置（iPhone 12/13 Pro，390×753 逻辑像素）；窄屏、超宽屏、安卓 WebView 的排版都未验。
3. **不声称第三方审核。** 识别链路里没有任何人工或第三方复核环节；三单的 `selected_species_id` 都是 NULL，`uncertainty_reasons` 都是空数组。
4. **不声称物种鉴定权威。** 候选是模型自报，分数不是准确率（详情页原文：「以下为模型候选与其自报分数，未人工确认；分数不是准确率。」）。第 4 节还给了同一份字节给出不同物种的读数。
5. **不声称图片版权归项目。** 四张演示图都来自 Wikimedia Commons（三张 CC BY-SA 3.0、一张公有领域），项目只有按许可使用的权利，没有版权；再分发须遵守各自许可，见 [演示图片来源页](../demo/演示图片-来源.md)。
6. **不声称长期稳定性。** 「两单成功」只说明这两次成功了；第 4 节的 8 条记录已经显示同一份字节会漂（0.55 / 0.62 / 0.72，还出现过一次马唐）。没有做并发、限流、供应商超时、缓存失效等任何压力面。

## 7 复现步骤

1. 确认栈在：`GET http://127.0.0.1:38110/health` 返回 200 且 `meta.execution_mode=real`；起栈时必须带媒体批准（`--demo` / `--approve-real-media-wiring`），否则上传会 503。
2. 小程序副本放在**工作树之外**（本轮是 `E:\GengYunCommander\.pg17\demo-project\wechat-local-r92`），并确认 `miniprogram/config/runtime.js` 的 `apiBaseUrl` 指向 `http://127.0.0.1:38110/api/v1`。
3. `cli.bat close --project "<副本>"` 之后再 `cli.bat auto --project "<副本>" --auto-port 9422`；用 `miniprogram-automator` 的 `connect({ wsEndpoint: 'ws://127.0.0.1:9422' })` 接上。
4. `reLaunch('/pages/login/login')` → 点「微信登录」→ 断言 `wx.getStorageSync('gengyun.session').accessToken` 非空。
5. 把照片写成 base64 分块 `writeFile` 到 `wx.env.USER_DATA_PATH`，再 `getCurrentPages()` 取识别页实例调 `prepareMedia(path)`（Page 实例没有 `.call()`），250 ms 轮询 `page.data()` 到 `stateView.terminal`。
6. **先滚动再截图**：识别页的「任务状态」块在首屏之下，`pageScrollTo` 到 560–700 px 再截；本轮第一版截图因为停在页首，只拍到了入口卡，作废重拍。
7. psql 核对三张表：`media`（bytes / sha256 / state）、`recognition_jobs`（state / error_code）、`recognition_records`（candidates / uncertainty_reasons / model_version），以及 `provider_call_ledger`（invocation_state / usage / duration_ms / provider_config_version）。

## 8 六道闸门

本轮提交上的闸门尾行（逐字复制自命令输出，退出码见右列）：

| # | 命令 | 尾行 | 退出码 |
| --- | --- | --- | ---: |
| 1 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | `PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）` | 0 |
| 2 | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | `ℹ pass 36` / `ℹ fail 0` / `ℹ skipped 1`（`tests 37`） | 0 |
| 3 | `node tools/verify-contract-status.mjs` | `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` | 0 |
| 4 | `npm run test:docs` | `PASS: 识别 5 页 / 跳过 381 页（扫描面 386 页：docs/verification）——读数七条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字 ⑦同页副本一致）` | 0 |
| 5 | `node tools/verify-g-drill-readings.mjs --check` | `✓ 八条判据全过：workflows 15 / jobs 30 / 演练 21 条 / 测试文件 626（glob 合计 596）；生长型读数按**下界**判（--tolerant-growth），其中 8 条滞后已逐行打印` | 0 |
| 6 | `git merge-tree --write-tree --name-only origin/main HEAD` | 退出码 0；输出只有一行树 SHA、没有冲突文件名（树 SHA 随提交变：补闸门表前 `6db26a2d…`、补完 `f499c729…`，两次都只打印一行） | 0 |

第 1 条第一次跑是红的：本页把 `/health` 的原文压成一行 JSON，里面 `latency_ms` 与 `uptime_s` 两个字段的数值被扫成两条「归不到路径的裸锚点」（BARE_ORPHAN 基线外新增 2 条）。改成缩进展开的 JSON 后转绿——**代码块里冒号紧跟数字也会被当锚点**，这条记在这里免得下次重踩。
第 2 条要求 HEAD 与 `origin/main` 不同：提交之前跑会红在 `notStrictEqual` 上，提交后转绿。

## 9 边界与后续

- 相机/相册选择器未验：要验需要真机，或在工具里手动点选（自动化点不到系统选择器）。
- 历史页「查看详情」按钮的**点击**没被覆盖（自定义组件选择器点不到），只覆盖了同一 URL 的打开路径。
- 识别页「我的识别记录」把时间戳直出成原始 ISO（`succeeded · 2026-11-09T19:42:53.505Z`），同一条记录在历史页却是「今天 03:44」；这类排版接缝不在本页范围，仍记在 [演示脚本](../demo/演示脚本.md) 的附录清单里。
- 本页读数只对应 2026-11-10 这一台本机栈；栈重建后 `uptime_s`、`provider_config_version` 的哈希段都可能变，届时以新读数重写本页，不要沿用。
