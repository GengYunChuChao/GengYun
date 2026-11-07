# 开放 issue 的验收现状索引（2026-11-08 快照，R88）

> 读数快照：2026-11-08T03:51:50+08:00（Asia/Hong_Kong）。基线 `fd6a225c5c032857411f186765c94497b604f21e`（`origin/main`，2026-11-08 03:47:35 +0800，`test(reference): 堵住 #28 台账闸门的证据路径写法绕过（同一张图不得点亮多行） (#1066)`）。派单时指定的 `8d30d4a1` 在开工后被推进两次（`3ac94018` #1060、`fd6a225c` #1066），本页按实际基线写。

## 怎么读这张表

- 读数快照：本页每个数字都是在上面的基线上当次跑出来的——开放 issue 清单来自 `gh issue list --state open`，开放 PR 与 CI 来自 `gh pr list` / `gh api .../commits/<sha>/check-runs`，依赖关系来自仓内 `docs/initial-issues.json` 的 `tasks[].dependencies` 实算，没有一条从旧页抄。
- 本页不背书关单：本页只记「现在缺什么、谁提供」，不构成对任何一张 issue 的通过结论；关单由指挥按各证据页另行裁定。
- 不回填旧读数：按 `docs/pr-review-policy.md:214`，「不得为了一致而回填旧读数」。旧页与本页冲突处一律按今天的事实写，逐条列在第八节「更正旧页」。
- `#1055` 属外部线，不据它计数：它是外部贡献者 `cxhhandsome` 的日志脱敏单测（`tests/unit/privacy-log-payload-redaction.test.mjs`，合入 `74861494`），既不进本仓任务依赖图，也不进本页任何「今天变了」的验收计数，只记存在。
- 阻断项类型（全表只用这四种，各取「当前最卡的那一条」）：
  - 外部条件：仓内可做的都做完了，只差仓外输入（账号、密钥、设备、域名、法务口径）。
  - 代码在飞：本地分支或开放 PR 已有改动但未落 main（含未推送）。
  - 依赖未清：`docs/initial-issues.json` 的 `tasks[].dependencies` 里仍有开放 issue 挂着（见第三节）。
  - 待裁定：需要产品或监工先给一句口径，代码怎么改取决于这句话。

## 一、今天变了的事（10 次本仓合入 + 1 条外部线）

1. `#1055` → `74861494`（2026-11-07 15:43 +0000，`test(privacy): add end-to-end log payload redaction coverage`）：外部线新增 292 行日志载荷脱敏单测，本仓不据它计数。
2. `#1057` → `da96c9b6`（15:45，`feat(community): return post_image_limit for over-limit posts`）：`POST/PATCH /posts` 超 3 个 `media_ids` 现在回 `post_image_limit`（`services/api/src/routes/community.ts:484`），错误码不再靠前端猜；新增 `tests/unit/community-post-media-limit-code.test.mjs` 134 行。
3. `#1059` → `07880810`（18:40，`test(privacy): 补撤回账本作用域负控制并清理共享库夹具`）：`tests/integration/egress-ledger-pg.mjs` 增 116 行，把「撤回只作用于本用途/本用户」钉成负控制（`tests/integration/egress-ledger-pg.mjs:720-731`）。
4. `#1064` → `1f623228`（19:04，`fix(miniprogram): 如实说明注销受理后不可撤回`）：小程序注销页与须知改为「受理即不可撤回」，裁定与逐条文案对照留在 `docs/verification/gy-r87-i19-cancel-ruling-20261107.md:8-10`。
5. `#1065` → `8d30d4a1`（19:33，`test(media): 钉住同帖并发挂图与负控制`）：`tests/integration/post-media-attachments-pg.mjs` 增 225 行，补 ⑩ 同帖并发（`tests/integration/post-media-attachments-pg.mjs:600`）与 ⑪ `owner_id`/`state` 计数过滤负控制。
6. `#1061` → `c327274e`（23:17，`test(reference): 给 #28 真机台账加状态闭集与证据闸门`）：`tests/reference/i26-tabbar-skeleton.test.mjs` 增 494 行，真机台账状态只许闭集、证据必须落在 `docs/verification/assets/` 且 ≥1024 字节。
7. `#1062` → `040867a7`（23:26，`docs(verification): 出 R87 开放 issue 验收现状快照`）：R87 页 76 行落地，并在 R83 页首行加「已被 R87 取代」的指路。
8. `#1063` → `6980d8f1`（2026-11-08 00:18，`test(failmatrix): 真库臂也读 expect.etag（C4-12 的 ETag 期望不再只在 stub 侧判）`）：真库臂 `sameWithCheck` 24→25、`either` 54→55、`neither` 126→125（`docs/verification/gy-r87-etag-parity-20261107.md:52`），整臂七列合计为 `total 180`、`same 180`、`sameWithCheck 25`、`sameWithShape 30`、`二者皆无 125`、`different 0`、`not_runnable 0`（`docs/verification/gy-r87-etag-parity-20261107.md:64`）；同一提交自陈这条断言在 CI 里红不了，因为真库臂退出码只由 `not_runnable` 决定（`docs/verification/gy-r87-etag-parity-20261107.md:74`）。
9. `#1037` → `6e7f7465`（02:25，`feat(media): real 模式社区图片改用帖子级挂载（每帖 ≤3 成为结构约束）`）：新增迁移 `services/api/db/migrations/0056_post_media_attachments.sql`（`ordinal BETWEEN 1 AND 3` 在 `services/api/db/migrations/0056_post_media_attachments.sql:70`），每帖 ≤3 从接口校验升级为结构约束。
10. `#1060` → `3ac94018`（03:44，`test(tools): 新增读数页闸门，核对证据页七条算术自洽`）：`tools/verify-reading-pages.mjs`（1042 行）进 main，B 档，由指挥用带 workflows 权限的 PAT 代合；它只做页内算术，不与上游产物对账（`tools/verify-reading-pages.mjs:32`）。
11. `#1066` → `fd6a225c`（03:47，`test(reference): 堵住 #28 台账闸门的证据路径写法绕过（同一张图不得点亮多行）`）：证据路径先归一化再比较（`tests/reference/i26-tabbar-skeleton.test.mjs:953-955`），`/./`、`//`、大写、尾段反斜杠写成多行现在会被抓；A 档，含 `ad627283`/`026b9ab4`/`31adc2cf` 三提交。

本节不含 `#1056`（`1b0a3b63`，2026-11-07 22:12 合入的真库臂复跑读数页）：它就是 R87 页自己的基线（旧页 `docs/verification/gy-r87-open-issue-acceptance-index-20261107.md:6` 自述 `origin/main` = `1b0a3b63e023804a5f7d448c25b269013ed82de6`、快照 22:29:42 HKT），早于旧页快照，不能算进「今天变了」。那份 180 条全 same 的读数仍在 `docs/verification/gy-r87-failmatrix-real-arm-rerun-20261107.md:84`，本页第八节按「`#1063` 之前」引用它。

仍在飞、尚未落 main 的（都不算「今天变了」）：

- `#1058` `ci: 把账本臂接进 CI，新增 real-pg-ledger-17.11（#29）`：线上 head 仍 `e67ef1b7`，`mergeable=CONFLICTING`；rebase 只提交到本地 `b424be9a`，等闸门跑完再推。
- `#1030` 真库 HTTP 端到端：本地分支 `feat/gy-r87-i30-http-e2e` @ `b0513fb4`，未推、未开 PR。
- `#29` 终态原因：本地分支 `feat/gy-r87-i29-terminal-reason` @ `a4eb4400`，未推、未开 PR。
- `#6`/`#15` 逐条 AC 证据页：本地分支 `docs/gy-r87-i06-i15-ac-evidence` @ `27a81fb8`，未推、未开 PR。

## 二、21 张开放 issue 总表

实跑 `gh issue list -R GengYunChuChao/GengYun --state open --limit 100 --json number` 得 21 张：`#4 #5 #6 #7 #9 #10 #11 #12 #13 #14 #15 #19 #21 #22 #23 #24 #27 #28 #29 #1003 #1030`。与 R87 页（`docs/verification/gy-r87-open-issue-acceptance-index-20261107.md`）列的 21 张逐号相同：**差集为空**——今天没有新开的 issue，也没有已关的 issue；派单预估的「20 张左右」偏低，实际 21 张。

| # | 一句话现状 | 阻断项类型 | 证据锚点 | 还缺什么（由谁提供） |
| --- | --- | --- | --- | --- |
| #4 | 微信登录路由与登录态在仓内可跑 | 外部条件 | `services/api/src/routes/auth.ts:43`（登录路由注册点）、`project.config.json:5`（现用 AppID 仍是开发号） | 正式小程序 AppID 与主体资质（用户/业主） |
| #5 | 单作物地区档案的形状已有（三项必填、`region_code` 限 `^33[0-9]{4}$`） | 依赖未清 | `services/api/src/routes/profile.ts:30-31` | 先清 #4、#28、#29 |
| #6 | 私有媒体上传路由在位，帖子级挂载迁移已落 main | 外部条件 | `services/api/src/routes/media.ts:219`、`services/api/db/migrations/0056_post_media_attachments.sql:63` | 真实对象存储桶与密钥（用户/业主）；另需清 #4、#29 |
| #7 | 科普/除草剂查询与详情排序在仓内可跑 | 依赖未清 | `packages/reference/query.mjs:513`（按登记号排序） | 先清 #4 |
| #9 | 实时识别路由在位，Top3 与不确定处理有契约 | 依赖未清 | `services/api/src/routes/recognitions.ts:80` | 先清 #5、#6、#7、#27；真模型端到端另见 #1003 |
| #10 | 实时 OCR 路由在位，校正与登记精确核对有契约 | 依赖未清 | `services/api/src/routes/ocr.ts:225` | 先清 #6、#7、#27 |
| #11 | 录音上传与 ASR 转写路由在位 | 依赖未清 | `services/api/src/routes/speech.ts:207` | 先清 #4、#6、#27；ASR 密钥（用户/业主） |
| #12 | 有来源问答的会话与消息路由在位 | 依赖未清 | `services/api/src/routes/conversations.ts:133`、`services/api/src/routes/messages.ts:43` | 先清 #7、#6、#27、#29 |
| #13 | TTS 合成路由在位 | 依赖未清 | `services/api/src/routes/synthesis.ts:119` | 先清 #28、#27、#29 |
| #14 | 文字/图片筛查按 fail-closed 走（无结论判 `quarantined`） | 依赖未清 | `services/api/src/moderation/provider.ts:9`（503 + `retryable:false`）、`services/api/src/moderation/provider.ts:11`（无结论按 fail-closed 判） | 先清 #6、#27；供应商开通与密钥（用户/业主） |
| #15 | 社区发帖/评论/点赞/举报在仓内可跑，每帖 ≤3 有结构约束 | 代码在飞 | `services/api/src/routes/community.ts:426`（`MAX_MEDIA_IDS_PER_POST` 取自 schema）、`services/api/src/community/store-pg.ts:397`（`claimPostMedia` 挂载口） | `docs/gy-r87-i06-i15-ac-evidence` @ `27a81fb8` 未推，逐条 AC 证据页缺（指挥） |
| #19 | 注销受理后不可撤回的文案已如实改好，去身份链路有测试钉住 | 待裁定 | `services/api/src/routes/account-deletion.ts:253`、`services/api/db/migrations/0017_account_suspend_authority.sql:272-273`（受理即抛 `G0004`，连管理员都 restore 不了） | 「撤销注销」要不要另立需求单，需产品/监工一句话；另需清 #4、#6、#11、#12、#15、#29 |
| #21 | 真实 AI 能力评估只有候选矩阵，没有一条开通读数 | 外部条件 | `docs/verification/provider-matrix.md:32`（接入矩阵表头）、`docs/verification/provider-matrix.md:43`（「以上候选不表示已开通」） | 腾讯云审核 BizType 与各服务密钥（用户/业主） |
| #22 | 权限面失败矩阵真库臂 180 条同源，ETag 期望真库侧也判 | 依赖未清 | `docs/verification/gy-r87-etag-parity-20261107.md:64`（七列合计 180 / 180 / 25 / 30 / 125 / 0 / 0） | 先清 #5、#9、#10、#12、#14、#15、#19 |
| #23 | 真机端到端只成立在一台 Android 上，样本不足 | 外部条件 | `docs/verification/gy-r79-device-walkthrough-20261106.md:70`（单机成立）、`docs/verification/gy-r79-device-walkthrough-20261106.md:74`（不能证明分布） | Android + iOS 多机型矩阵与测试微信号（用户/业主） |
| #24 | 比赛版部署、备份恢复与交付材料未有正式环境读数 | 外部条件 | `docs/verification/gy-r79-demo-readiness-20261106.md:18`（预览/体验版不可用）、`docs/verification/gy-r79-demo-readiness-20261106.md:47`（正式 HTTPS 基址未提供） | 域名与备案、服务器与备份目标、材料口径（用户/业主） |
| #27 | 正式 AppID、真机域名与外部服务接入一项都没落地 | 外部条件 | `project.config.json:5`、`docs/verification/gy-r79-demo-readiness-20261106.md:45`（主体/类目/隐私指引/备案未核对） | 微信 AppID 与主体类目、隐私指引、备案，腾讯云审核（用户/业主） |
| #28 | 五 Tab 骨架与台账闸门都硬了：状态闭集 + 证据归一化 | 外部条件 | `tests/reference/i26-tabbar-skeleton.test.mjs:462`（同一条证据不得跨行复用）、`docs/verification/gy-i26-demo-align-20261014.md:783`（已知限制同步句） | 真机截图与原 demo 并排、Android/iOS 各一台（用户/业主） |
| #29 | 用途授权与外发账本有作用域负控制；级联终止经查不是漏洞 | 待裁定 | `tests/integration/egress-ledger-pg.mjs:720-731`（撤回的跨用户/跨用途负控制，走真实 HTTP 触发面）、`services/api/src/privacy/ledger-pg.ts:765`（生产侧 `guardWriteback`） | 「终态原因被抹平成 `PROVIDER_OUTCOME_UNKNOWN`」是否算必须修的缺口，需裁定；修法在 `a4eb4400` |
| #1003 | 识别协议适配层已在仓内（`openai-vision-v1` + 真实 fetch） | 外部条件 | `services/api/src/recognitions/openai-vision-adapter.ts:46`、`services/api/src/recognitions/openai-vision-adapter.ts:271` | 真实厂商端点与密钥、一次真调用读数（用户/业主） |
| #1030 | real 模式每帖 ≤3 已是结构约束，并发与计数负控制有测试钉住；但 ⑩/⑪ 目前无 CI 计数闸门覆盖（`tests/integration/post-media-attachments-pg.mjs:506` 自述） | 代码在飞 | `services/api/db/migrations/0056_post_media_attachments.sql:70`、`services/api/src/community/store-pg.ts:397`、`tests/integration/post-media-attachments-pg.mjs:600` | real+PG 的 **HTTP** 端到端仍缺（现有用例是 store 层直连）：`feat/gy-r87-i30-http-e2e` @ `b0513fb4` 未推（指挥） |

## 三、依赖墙：今天可关 = 0 张

数据源：`docs/initial-issues.json` 的 `tasks[].dependencies`，实算 27 项任务。映射必须留意：`GY-I01..I24` → `#1..#24`，但 `GY-I25→#27`、`GY-I26→#28`、`GY-I27→#29`——**ledger 里的 `GY-I27` 是 issue #29，不是 #27**，写成 #27 会把整张依赖图算错。`#1003`、`#1030` 是缺陷单，不在 `tasks` 里，本墙不涉及。

21 张开放 issue 里，3 张没有未清依赖（`#27` 依赖为空；`#28` 只依赖已关的 #2；`#29` 只依赖已关的 #1、#2），其余 16 张各挂着 1 到 7 张未清依赖：

| # | 未清依赖 | 链深 |
| --- | --- | --- |
| #4 | #27、#29 | 2 |
| #5 | #4、#28、#29 | 3 |
| #6 | #4、#29 | 3 |
| #7 | #4 | 3 |
| #9 | #5、#6、#7、#27 | 4 |
| #10 | #6、#7、#27 | 4 |
| #11 | #4、#6、#27 | 4 |
| #12 | #7、#6、#27、#29 | 4 |
| #13 | #28、#27、#29 | 2 |
| #14 | #6、#27 | 4 |
| #15 | #4、#5、#7、#14、#28、#29 | 5 |
| #19 | #4、#6、#11、#12、#15、#29 | 6 |
| #21 | #9、#10、#11、#12、#13、#14 | 5 |
| #22 | #5、#9、#10、#12、#14、#15、#19 | 7 |
| #23 | #19、#21、#22 | 8 |
| #24 | #21、#22、#23 | 9 |

最长链 9 节，共两条，链头分别是 `#27` 与 `#29`：`#27 → #4 → #6 → #14 → #15 → #19 → #22 → #23 → #24`、`#29 → #4 → #6 → #14 → #15 → #19 → #22 → #23 → #24`。两条只在第 1 节不同——`#4` 的未清依赖同时含 `#27` 与 `#29`（见上表 `#4` 行），第 2 节起完全重合。8 节另有 17 条、7 节 74 条，三种链头（`#27`/`#28`/`#29`）展开的依赖链总共 261 条。链头两个分别是外部条件与待裁定，链尾是 `#24`（比赛版交付），中间任何一节卡住，后面 6 节都动不了。

今天可关 = 0 张。三张「无未清依赖」的也不等于能关：`#27` 卡外部条件（AppID/备案），`#28` 卡真机目视（截图与设备），`#29` 卡裁定加 `#1058` 的 `CONFLICTING`。其余 16 张都在等链头，或等各自的证据页落 main。

## 四、外部条件清单（必须由用户/业主提供，我们不能自造）

| 要什么 | 卡住谁 | 现状（本页读到的） |
| --- | --- | --- |
| 正式小程序 AppID + 主体类目 | #4、#27 | 仓里仍是开发号（`project.config.json:5`） |
| 隐私指引与备案号 | #27、#24 | 未核对（`docs/verification/gy-r79-demo-readiness-20261106.md:45`） |
| 正式 HTTPS 域名与证书 | #24、#23 | 基址未提供（`docs/verification/gy-r79-demo-readiness-20261106.md:47`） |
| 腾讯云审核 BizType 与各服务密钥（OCR/ASR/TTS/视觉/内容安全） | #9、#10、#11、#13、#14、#21、#1003 | 只有候选矩阵，无开通读数（`docs/verification/provider-matrix.md:43`） |
| 真实对象存储桶与访问密钥 | #6 | 桶未提供 |
| Android + iOS 多机型真机矩阵与测试微信号 | #23、#28 | 只有一台 Android 的端到端（`docs/verification/gy-r79-device-walkthrough-20261106.md:70`），iOS 无设备 |
| 法务口径：注销受理后不可撤回的对外表述 | #19 | 文案已按「受理即不可撤回」改好，口径本身仍需业主确认 |
| 产品/监工裁定：撤销注销是否另立需求单、终态原因是否必须修 | #19、#29 | 两条都无结论 |

`E:\GengYunPrivate` 下已备的文件（本页只报文件名与用途，用途按文件名判断，不读、不打印任何值）：

- `README.md`：该目录的取用说明。
- `credentials.local.json`：本地联调凭证聚合（real 模式在开发机上跑通用）。
- `database-url.txt`：真实 PostgreSQL 连接串（real 臂与集成测试连库）。
- `db-credentials.env`：数据库账号密码的环境变量式载体。
- `object-storage.env`：对象存储桶与密钥（#6 的真实桶）。
- `SecretKey-r34-asr.csv`：ASR 服务密钥（#11）。
- `新建子用户信息.csv`：云账号子用户信息（腾讯云审核与调用）。
- `腾讯云.txt`：腾讯云账号/审核相关登记信息（#21、#27）。
- `服务器账号密码.txt`：部署服务器账号（#24）。
- `gengyun-supervisor.2026-10-23.private-key.pem`：服务器登录私钥（#24 部署与备份）。
- `github-pat.txt`：带 workflows 权限的 PAT（B 档 PR 代合要它，今天 #1060 就是这样合的）。

这些文件只是「备着」，不等于条件满足：把 #27 的 AppID、#21 的开通读数、#23 的真机矩阵变成读数，仍要人拿着它们去平台上操作一遍。

## 五、在飞 PR 清单

实跑 `gh pr list --state open` 得 1 张，就是下表这一张（除它之外没有别的在飞 PR；`#1060` 已合入，不再在飞）。

| PR | 标题 | head | CI（check-runs） | 档位 |
| --- | --- | --- | --- | --- |
| #1058 | `ci: 把账本臂接进 CI，新增 real-pg-ledger-17.11（#29）` | `e67ef1b74a56f33c69a1f95ecc334614432e4eae` | 25/25 success（含 `real-pg-ledger-17.11`），但 `mergeable=CONFLICTING`、`mergeStateStatus=DIRTY` | B |

- `#1058` 档位 B 的依据：它改 `.github/workflows/real-pg-integration.yml`（+128）与 `tests/**`，前者落在「不在正面清单一律 B 档」里（`docs/pr-review-policy.md:173`）；A 档正面清单只收 `tests/**` 与 `docs/**` 下的证据/进度记录（`docs/pr-review-policy.md:164-167`）。
- `#1058` 的 CI 全绿与 `CONFLICTING` 同时成立：绿的是它自己的 head，冲突的是它相对现在 main 的合并面。rebase 版只在本地 `b424be9a`，推上去才作数。
- 另有 3 条只在本地、未开 PR 的在飞改动（`b0513fb4`、`a4eb4400`、`27a81fb8`），它们不进上面这张表，因为 `gh pr list` 看不到，任何 CI 也没跑过。

## 六、待裁定与已知限制

- `#19`：撤销注销要不要另立需求单，待产品/监工一句话。事实是受理即撤全部会话，连管理员都 restore 不了（`services/api/db/migrations/0017_account_suspend_authority.sql:272-273` 抛 `G0004`）。
- `#29`：「撤回是否级联终止已受理 job」经查不是漏洞——仓内没有 worker，执行前有 `assertExecutable`（`services/api/src/privacy/task-egress.ts:127`）、保存前有 `guardWriteback`（`services/api/src/privacy/ledger-pg.ts:765`）两道复查。真缺口只是终态原因被抹平成 `PROVIDER_OUTCOME_UNKNOWN`，修法在本地 `a4eb4400`，要不要算必修仍待裁定。
- `#28` 台账闸门的已知限制写在测试里：只比路径、不比字节，同一张图另存 4 份物理拷贝仍能点亮多行（`tests/reference/i26-tabbar-skeleton.test.mjs:950-951`）；8.3 短名与长名是不同字符串键，在关闭 8dot3name 的卷上连造都造不出来，只能靠人工复核。
- 读数页闸门（`tools/verify-reading-pages.mjs`，随 `#1060` 进 main）只做页内算术：不与上游 json 产物对账（`tools/verify-reading-pages.mjs:32`）；页内没有「这一行属于哪一组」的声明时会误报（`tools/verify-reading-pages.mjs:30`）；historical 前缀规则靠 `旧读数|旧基线|旧版本|修前` 正则（`tools/verify-reading-pages.mjs:314-315`、`tools/verify-reading-pages.mjs:322`），把读数写成散文标「（旧读数）」即可绕开比对。

## 七、本页不声称什么

- 本页不声称任何一张 issue 的验收结论，也不给「可以关单」的名单；关单权在指挥。
- 本页不声称外部条件已经具备：`E:\GengYunPrivate` 里的文件只是存在，本页没读它们的值，也没验证它们能不能用。
- 本页不声称 CI 全绿等于功能可用：`#1058` 是 25/25 success 同时 `CONFLICTING` 的典型反例。
- 本页不声称读数页闸门能替代人工审读数：它只做页内算术，不与上游产物对账，historical 规则可绕。
- 本页不声称台账闸门能防住重复证据：它只比归一化后的路径，不比字节内容。
- 本页不声称 `#1055` 属本仓验收范围：那是外部线贡献，只记存在，不据它计数。
- 本页不声称依赖图完整反映真实阻塞：它只反映 `docs/initial-issues.json` 里写下的 `dependencies`，外部条件与待裁定项不在图里，所以「今天可关 0 张」是这两类叠加的结果，不是图算出来的。
- 本页不声称做过安全评审或渗透测试：`#29` 的「不是漏洞」是代码阅读结论（仓内无 worker + 执行前 `assertExecutable`、保存前 `guardWriteback` 两道复查），不是攻击面验证。

## 八、更正旧页（R87）

旧页 = `docs/verification/gy-r87-open-issue-acceptance-index-20261107.md`（2026-11-07 22:29:42 HKT 快照，基线 `1b0a3b63e023804a5f7d448c25b269013ed82de6`，即 `#1056` 的 merge commit，见旧页 `docs/verification/gy-r87-open-issue-acceptance-index-20261107.md:6`；`8d30d4a1` 是 `#1065` 的 merge commit，晚 5 小时，不是旧页基线）。以下逐条按今天的事实更正：

- 旧页把 `#1058` 记成「CI 首跑红（contract-tests/unit-tests 两 failure）」：现在 head `e67ef1b7` 上 25/25 success，红的一面换成了 `mergeable=CONFLICTING`。
- 旧页把 `#1037` 记成「head `8bf16e72` 在飞、分支侧返修未推送」：已合入 main 为 `6e7f7465`。
- 旧页把 `#1057` 记成「head `0e2e380a` 在飞」：已合入为 `da96c9b6`。
- 旧页把 `#28` 台账闸门记成「在分支 `test/gy-r87-i28-device-ledger-gate`，本地尖端 `1861419b`，未推送」：已合入 `c327274e`，今天又加了一层路径归一化（`fd6a225c`）。
- 旧页把 `#22` 的真库臂读数记成 `sameWithCheck 24`：`#1063` 之后是 25（`docs/verification/gy-r87-etag-parity-20261107.md:64`）；旧页引的 `docs/verification/gy-r87-failmatrix-real-arm-rerun-20261107.md:84` 那行仍是 24，因为它是 `#1063` 之前的复跑，两页不同源，不是矛盾。
- 旧页说 `#1030` 还差三件（同帖并发真库用例、`owner_id`/`state` 行为级负控制、real+PG HTTP 端到端）：前两件已由 `8d30d4a1` 落地（`tests/integration/post-media-attachments-pg.mjs:600` 与 ⑪），只剩 real+PG 的 **HTTP** 端到端。
- 旧页把 `#29` 作用域负控制记成「只在分支 `d56146f8`」：已合入 `07880810`；同时旧页把它当潜在漏洞，今天查明级联终止不是漏洞，真缺口是终态原因。
- 旧页 §五 的「22:54 复核」那组读数（`#1037` `8bf16e72`、`#1057` `0e2e380a`、`#1058` `523f7170`）全部过期，以本页第五节为准。
- 旧页引的 `services/api/src/routes/ocr.ts:224` 与 `services/api/src/routes/media.ts:218` 不是「今天漂了」，而是**当时就偏一行**：这两行是 `app.post(` 的开括号，路径字面量在下一行 `services/api/src/routes/ocr.ts:225` 与 `services/api/src/routes/media.ts:219`；这两个文件今天没有被任何提交碰过，旧页指的是一处早就存在的行号错位。
- 旧页写在飞的 `#1060` 已由 `3ac94018` 合入，读数页闸门现在是 main 上的常驻闸门，不再是「待合入」。
