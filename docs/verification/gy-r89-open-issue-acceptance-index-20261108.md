# 开放 issue 的验收现状索引（2026-11-08 快照，R89）

> 读数快照：2026-11-08T15:29:30+08:00（Asia/Hong_Kong）。基线 `55f86ef8ef0af73b444057cd64d7c465edd32f74`（`origin/main`，2026-11-08 14:49:12 +0800，`ci(real-pg): 把真库臂读数下限从 13 抬到 19，并给「三处数字」加跨文件互校 (#1073)`）：本页全部行号与 issue／依赖读数按这一版核。此后 `origin/main` 继续前进，本页只冻结截至 `#1088`（`ba0b5036`）时已记下的五个相关合并点（`#1078`→`c031023d`、`#1080`→`f7a4d0d9` 两笔见 §一 1.2；`#1081`→`25a8cb70` 把 HTTP 端到端臂接进真库 CI，`#1085`→`04ca0735` 修 GY-R89 pool-decay 页那 15 处锚点，`#1086`→`edd41481` 把本页 11 条锚点按新的脚本行号重锚并登记；`#1081` 与 `#1086` 两笔见第六节与第七节末条）；`origin/main` 的当前值以现场 `git log origin/main` 为准（本页不写「现为 X」）；本页也不按新基线重排已核过的行号，凡被这几笔碰过的文件另行注明。

## 怎么读这张表

- 读数快照：本页每个数字都是在上面的基线上当次跑出来的——开放 issue 清单来自 `gh issue list --state open --limit 100`，开放 PR 来自 `gh pr list --state open`（第五节只冻结号集、标题与档位，不冻结 head 与 merge 状态），依赖关系来自仓内 `docs/initial-issues.json` 的 `tasks[].dependencies` 实算，本期合入清单来自 `git log fd6a225c..55f86ef8`。没有一条从上一页抄。
- 为什么 PR 那节不写 head/状态：PR 的 head 与 mergeable 是分钟级变动的，本页是小时级生命周期的快照；把前者写进后者必然过期（本页第一版就栽在这上面，更正见第八节最后一条）。
- 本页不背书关单：本页只写「现在卡在哪、缺的那件事由谁提供」，不构成对任何一张 issue 的结论；关单由指挥按各证据页另行裁定。
- 不回填旧读数：按 `docs/pr-review-policy.md:214`，「不得为了一致而回填旧读数」。旧页与本页冲突处一律按今天的事实写，逐条列在第八节。
- `#1055` 属外部线，不据它计数：外部贡献者 `cxhhandsome` 的日志脱敏单测（`74861494`）仍是 main 的祖先（`git merge-base --is-ancestor 74861494 HEAD` 退出 0），但它早于上一页快照，`git log fd6a225c..55f86ef8` 里没有它，不进本期任何计数。
- 阻断项类型（全表只用这四种，各取「当前最卡的那一条」）：
  - 外部条件：仓内能做的都做完了，只差仓外输入（账号、密钥、桶、设备、域名、法务口径）。
  - 代码在飞：开放 PR 里已有改动但未落 main。
  - 依赖未清：`docs/initial-issues.json` 的 `tasks[].dependencies` 里仍有开放 issue 挂着（见第三节）。
  - 待裁定：需要产品或监工先给一句口径，代码怎么改取决于这句话。
- 行号锚点一律写「仓库相对路径 + `:行`」：本页不写裸 `:行`，因为闸门会把归不到路径的裸锚点记成孤儿。

## 一、今天变了的事

### 1.1 基线窗口内：11 次本仓合入（`git log fd6a225c..55f86ef8` 实跑）

1. `#1068` → `2aa5d433`（04:19:26，`test(post-media): 给 ⑩/⑪ 补静态守卫 + ⑪ 的 state 支补 processing/rejected`）：新增 `tests/unit/post-media-attachments-say-floor.test.mjs`（现 379 行），把「⑩ 同帖并发 / ⑪ `owner_id`、`state` 过滤」两节从「只有真库臂里有」变成「整节被悄悄删掉就红」——计数面是**可执行** `say(` 调用点，结构面是每条关键文案（`tests/unit/post-media-attachments-say-floor.test.mjs:114`）；该文件自己声明不判语义正确性（`tests/unit/post-media-attachments-say-floor.test.mjs:31`），语义仍在真库臂。
2. `#1067` → `21dd86eb`（04:38:29，`docs(verification): 出 R88 开放 issue 验收现状快照（21 张逐行，今天可关 0 张）`）：纯文档，出的是上一版快照 `docs/verification/gy-r88-open-issue-acceptance-index-20261108.md`；不改行为，本节其余各条才是行为变化。
3. `#1071` → `ecbe343c`（04:45:47，`test(media): 用真库 + HTTP 端到端钉住每帖 ≤3、待用池释放与 503 信封`）：real+PG 的 **HTTP** 端到端臂进 main——`tests/integration/post-media-attach-http-pg.mjs`（当时 672 行、今天 950 行）自建一次性 PG 簇、把迁移跑到 0056，再用 real 装配 + `app.inject` 走完整路由，PASS 1–8 覆盖每帖 ≤3、挂载即释放、`post_image_limit` 信封与 503 fail-closed（PASS 行打印在 `tests/integration/post-media-attach-http-pg.mjs:191`）；同提交出读数页 `docs/verification/gy-r87-i30-http-e2e-20261107.md`（当时 165 行，此后多次增补；本页不追记当前行数）。
4. `#1069` → `c026558c`（05:03:08，`docs(verification): 出 #6/#15 逐条 AC 证据页（8 条三档，五项阻断）`）：`docs/verification/gy-r87-i06-i15-ac-evidence-20261108.md`（186 行）把 `#6`/`#15` 各 4 条 AC 分三档判定，列五项阻断 B1–B5，最硬的一条是 B1 真实审核供应商凭据（`docs/verification/gy-r87-i06-i15-ac-evidence-20261108.md:127`）；同页自陈这两张的「代码在飞」判定已不成立（`docs/verification/gy-r87-i06-i15-ac-evidence-20261108.md:157`、`docs/verification/gy-r87-i06-i15-ac-evidence-20261108.md:158`）。
5. `#1070` → `841bc1c3`（05:07:09，`ci(ledger): 把账本真库臂接进 CI（承接 #1058，rebase 到 2aa5d433）`）：新增 job `real-pg-ledger-17.11`（`.github/workflows/real-pg-integration.yml:1455`），跑 `tests/integration/recognitions-provider-call-ledger-pg.mjs`（`.github/workflows/real-pg-integration.yml:1523`）。它承接的是上一页记的唯一一张在飞 PR `#1058`——那张 PR 已随本提交消失。
6. `#1072` → `b617894c`（05:21:27，`docs(i29): 回填媒体三域折叠的裁定归属，消掉两页互相不知道的口径冲突`）：`#29` 的媒体三域折叠从「两页互不知道」变成**有归属的待裁定**——`docs/architecture/acceptance-map.md:299` 补上「列与代码都已存在，这不是待建项」，并把四值闭集锚到 `services/api/src/recognitions/provider.ts:45`；另一页 `docs/verification/gy-r71-async-privacy-codes-20261030.md` 是单行等长替换（两页都零行位移）。
7. `#1074` → `6f29f4b0`（12:49:57，`docs(verification): 清一批符号零命中锚点（ZERO_HIT 11 处）`）：6 页各换 1–2 行锚点，只换锚不换结论；其中一页是 `docs/verification/gy-r88-open-issue-acceptance-index-20261108.md`。
8. `#1075` → `49b68743`（12:59:44，`test(media): 补待用池衰减与 complete 迁移覆盖`）：HTTP 臂补三组——PASS 9 24h 自衰减（断言 `tests/integration/post-media-attach-http-pg.mjs:792-796`，时间穿越靠直接改 `public.media.created_at`，SQL 在 `tests/integration/post-media-attach-http-pg.mjs:786`）、PASS 10 `state` 四值矩阵（断言 `tests/integration/post-media-attach-http-pg.mjs:845-849`）、PASS 11 `/complete` 迁移（调用 `tests/integration/post-media-attach-http-pg.mjs:893`）；文件 672→930 行（当时；今天 950 行），同提交出 `docs/verification/gy-r88-i30-pool-decay-20261108.md`（183 行）。
9. `#1076` → `3d59c863`（13:02:06，`test(reference): 提高 #28 证据下限并校正索引`）：`#28` 台账证据下限 1024→8192 字节（`tests/reference/i26-tabbar-skeleton.test.mjs:122`），同句同步到 `docs/verification/gy-i26-demo-align-20261014.md:783`；同提交出 `docs/verification/gy-r88-i28-evidence-min-bytes-20261108.md`（101 行）记这次上调的理由与代价。
10. `#1079` → `c0e7dac0`（14:20:48，`docs(verification): 热修 R88 索引页 #1030 行漂到空行的两条锚点`）：上一页 `#1030` 行有两条锚点落在空行上（`159→161`、`161→163`），本提交改页面并在 `tests/unit/doc-anchor-relocations.json` 追加 2 条登记——理由是目标文件本提交没改，行号必须恒等，属锚点漂移而不是内容变化。
11. `#1073` → `55f86ef8`（14:49:12，`ci(real-pg): 把真库臂读数下限从 13 抬到 19，并给「三处数字」加跨文件互校`）：读数闸门 `-lt 13`→`-lt 19`（`.github/workflows/real-pg-integration.yml:868`，失败文案在 `.github/workflows/real-pg-integration.yml:869`），`SAY_FLOOR = 19`（`tests/unit/post-media-attachments-say-floor.test.mjs:54`，对应 19 个**可执行** `say(` 调用点——裸 grep 会数出 22，另有 3 处只在注释里），并加跨文件互校：workflow 阈值 ⇔ 读数表 `baseline: 19`（`tests/unit/ci-real-pg-readings-gates.test.mjs:206`）⇔ `SAY_FLOOR` 三者必须相等。

### 1.2 本页成文窗口内：main 又前进 2 笔、PR 集换血 2 次

这一段是本页第一版（`04fe1868`，快照 15:01:27）之后发生的事，如实列在这里，因为它们正好也是第一版第五节出错的原因：

- `#1078` → `c031023d`（合入 2026-11-08T06:59:57Z = 14:59:57 HKT，比第一版快照早 90 秒）：撤回导致的 job 终态写 `CONSENT_WITHDRAWN`（新增 `tests/unit/job-terminal-reason-consent-withdrawn.test.mjs` 353 行、证据页 `docs/verification/gy-r87-i29-terminal-reason-20261107.md` 263 行，`tests/integration/egress-ledger-pg.mjs` +116 行，共 28 个文件 +944/-55）。提交正文写的是 `References: #29 (do not close)`——所以它落地不等于 `#29` 能关。
- `#1080` → `f7a4d0d9`（合入 2026-11-08T07:09:26Z = 15:09:26 HKT）：新增 job `real-pg-jobs-ledger-17-11`（`name: real-pg-jobs-ledger-17.11`）跑 `tests/integration/jobs-ledger-pg.mjs`，workflow +130 行；同提交出 `docs/verification/gy-r88-i29-jobs-ledger-wiring-20261108.md`（178 行）。**注意别把它和 `#1070` 混**：`#1070` 接的是**识别 provider 调用账本**臂，`#1080` 接的是 **jobs 账本**臂。
- `#1077` 于 2026-11-08T06:56:49Z（14:56:49 HKT）**关闭**，不是合入——它的改动没有落 main；同一件事（锚点闸门跳过围栏代码块）由新开的 `#1082` 承接，仍在飞。

本期没有新的外部线贡献（`#1055` 仍是唯一一条，见「怎么读」）。在飞 PR 见第五节：抓取时刻 3 张，`gh pr list --state open` 实跑；那一节只保证号集与标题在该时刻成立。

## 二、21 张开放 issue 总表

实跑 `gh issue list -R GengYunChuChao/GengYun --state open --limit 100 --json number,title` 得 **21 张**：`#4 #5 #6 #7 #9 #10 #11 #12 #13 #14 #15 #19 #21 #22 #23 #24 #27 #28 #29 #1003 #1030`。与上一页逐号相同（差集为空）：今天既没有新开的 issue，也没有已关的 issue——派单里「21 张」这个数我按实跑复核过，是对的，但它不是沿用来的。

| # | 一句话现状 | 阻断项类型 | 证据锚点 | 还缺什么（由谁提供） |
| --- | --- | --- | --- | --- |
| #4 | 微信登录路由与登录态在仓内可跑 | 外部条件 | `services/api/src/routes/auth.ts:43`（登录路由注册点）、`project.config.json:5`（该行 appid 写的就是正式 AppID wx4407a4b908a69a54，不是开发号；tools/check-wechat-project.mjs 冻结此值——仓内配置不缺 AppID） | 主体资质认证、服务类目、隐私保护指引、体验成员（用户/业主，微信公众平台） |
| #5 | 单作物地区档案的形状已有（三项必填、`region_code` 限 `^33[0-9]{4}$`） | 依赖未清 | `services/api/src/routes/profile.ts:30-31` | 先清 #4、#28、#29（其他 issue 的负责人） |
| #6 | 上传路由与帖子级挂载迁移在 main；real+PG 的 HTTP 端到端今天进 main，且已随 `#1081`（`25a8cb70`）接进真库 CI：`.github/workflows/real-pg-integration.yml:1707` 是 job id `real-pg-http-17-11:`，`.github/workflows/real-pg-integration.yml:1772` 跑该脚本（带点的 check 名 `name: real-pg-http-17.11` 在 `.github/workflows/real-pg-integration.yml:1708`） | 外部条件 | `services/api/src/routes/media.ts:219`、`services/api/db/migrations/0056_post_media_attachments.sql:63`、`tests/integration/post-media-attach-http-pg.mjs:581` | 真实审核供应商凭据（用户，B1）；真实对象存储桶与密钥（用户，B4）；清 #4、#29 |
| #7 | 科普/除草剂查询与详情排序在仓内可跑 | 依赖未清 | `packages/reference/query.mjs:513`（按登记号升序） | 先清 #4 |
| #9 | 实时识别路由在位，Top3 与不确定处理有契约 | 依赖未清 | `services/api/src/routes/recognitions.ts:80` | 先清 #5、#6、#7、#27；真模型端到端另见 #1003 |
| #10 | 实时 OCR 路由在位，校正与登记精确核对有契约 | 依赖未清 | `services/api/src/routes/ocr.ts:225` | 先清 #6、#7、#27 |
| #11 | 录音上传与 ASR 转写路由在位 | 依赖未清 | `services/api/src/routes/speech.ts:207` | 先清 #4、#6、#27；ASR 密钥（用户/业主） |
| #12 | 有来源问答的会话与消息路由在位 | 依赖未清 | `services/api/src/routes/conversations.ts:133`、`services/api/src/routes/messages.ts:43` | 先清 #7、#6、#27、#29 |
| #13 | TTS 合成路由在位 | 依赖未清 | `services/api/src/routes/synthesis.ts:119` | 先清 #28、#27、#29 |
| #14 | 文字/图片筛查按 fail-closed 走：real 模式缺真实端口直接 503，替身的无结论判隔离 | 依赖未清 | `services/api/src/moderation/service.ts:421-427`（`PROVIDER_UNAVAILABLE` + `retryable: false`）、`services/api/src/moderation/decisions.ts:210`（无结论支落 `quarantined` / `uncertain`） | 先清 #6、#27；供应商开通与密钥（用户/业主） |
| #15 | 社区发帖/评论/点赞/举报在仓内可跑，每帖 ≤3 有三道结构闸 | 外部条件 | `services/api/src/routes/community.ts:426`（上限取自 schema）、`services/api/src/community/store-pg.ts:397`（`claimPostMedia` 挂载口）、`tests/integration/post-media-attachments-pg.mjs:600`（同帖并发断言） | 真实审核供应商凭据（用户，B1）；真实桶（用户，B4）；清 #4、#5、#7、#14、#28、#29 |
| #19 | 注销受理后不可撤回的文案已如实改好；但「去身份」是零兑现的策略声明：受理事务只写 `state`/`auth_epoch`/`revision`/`updated_at` 四列，见 `services/api/db/migrations/0016_account_deletion_persistence.sql:122-128`，`public.users` 的四个 PII 列（`wechat_subject_cipher`/`wechat_subject_lookup`/`nickname`/`avatar_media_id`）原样保留；`list_admin_accounts()` 的读面没有 `state` 过滤，见 `services/api/db/migrations/0021_admin_accounts_read.sql:97-103`；`services/api/src/privacy/user-data-deletion.ts` 全文零 `exports`/`export_writebacks` ⇒ 保留策略里「随注销去身份」（`packages/privacy/retention-policy.mjs:214`）没有实现；`tests/unit/deletion-registration-coverage.test.mjs` 钉的是删模块注册棘轮，不是去身份 | 待裁定 | `services/api/src/routes/account-deletion.ts:253`、`services/api/db/migrations/0017_account_suspend_authority.sql:272-273`（受理即抛 `G0004`，管理员也 restore 不了） | 「撤销注销」要不要另立需求单（产品/监工）；另需清 #4、#6、#11、#12、#15、#29 |
| #21 | 真实 AI 能力评估只有候选矩阵，没有一条开通读数 | 外部条件 | `docs/verification/provider-matrix.md:32`（接入矩阵表头）、`docs/verification/provider-matrix.md:43`（「以上候选不表示已开通」） | 腾讯云审核 BizType 与各服务密钥（用户/业主） |
| #22 | 权限面失败矩阵真库臂 180 条同源，ETag 期望真库侧也判 | 依赖未清 | `docs/verification/gy-r87-etag-parity-20261107.md:64`（七列合计 180 / 180 / 25 / 30 / 125 / 0 / 0） | 先清 #5、#9、#10、#12、#14、#15、#19 |
| #23 | 真机端到端只成立在一台 Android 上，样本不足 | 外部条件 | `docs/verification/gy-r79-device-walkthrough-20261106.md:5`（自述不构成准确率/容量/正式发布验收）、`docs/verification/gy-r79-device-walkthrough-20261106.md:70`（单机成立） | Android + iOS 多机型矩阵与测试微信号（用户/业主） |
| #24 | 比赛版部署、备份恢复与交付材料都没有正式环境读数 | 外部条件 | `docs/verification/gy-r79-demo-readiness-20261106.md:18`（预览/体验版不可用）、`docs/verification/gy-r79-demo-readiness-20261106.md:47`（正式 HTTPS 基址未提供） | 域名与备案、服务器与备份目标、材料口径（用户/业主） |
| #27 | 正式 AppID 已在仓内配置里；真机域名与外部服务接入一项都没落地 | 外部条件 | `project.config.json:5`（该行 appid 即正式 AppID，见 #4 行）、`docs/verification/gy-r79-demo-readiness-20261106.md:45`（主体/类目/隐私指引/备案未核对） | 主体资质认证、服务类目、隐私保护指引、体验成员（微信后台），备案域名，腾讯云审核（用户/业主） |
| #28 | 五 Tab 骨架与台账闸门都硬了；今天证据下限从 1 KB 抬到 8 KB | 外部条件 | `tests/reference/i26-tabbar-skeleton.test.mjs:122`（`LEDGER_MIN_EVIDENCE_BYTES = 8192`）、`docs/verification/gy-i26-demo-align-20261014.md:783`（同句与已知限制） | 真机截图与原 demo 并排、Android/iOS 各一台（用户/业主） |
| #29 | 用途授权与外发账本有作用域负控制；级联终止经查不是漏洞；媒体三域折叠今天补上归属；job 终态原因与 jobs 账本 CI 臂今天都落地 | 待裁定 | `tests/integration/egress-ledger-pg.mjs:720-731`（撤回的跨用户／跨用途负控制；按基线 `55f86ef8` 核，`c031023d` 之后该块在 main 上已下移，见第六节）、`services/api/src/privacy/ledger-pg.ts:765`（生产侧 `guardWriteback`）、`docs/architecture/acceptance-map.md:299`（三域折叠登记为相邻面） | 「三域失败保留原码」是否必修（产品/监工）；`#1078`（终态原因）与 `#1080`（jobs 账本 CI 臂）已落地，但两条都不构成关单依据 |
| #1003 | 识别协议适配层在仓内（`openai-vision-v1` + 真实 fetch） | 外部条件 | `services/api/src/recognitions/openai-vision-adapter.ts:46`、`services/api/src/recognitions/openai-vision-adapter.ts:271` | 真实厂商端点与密钥、一次真调用读数（用户/业主） |
| #1030 | real 模式每帖 ≤3 是结构约束；今天补上 24h 衰减、`state` 四值、`/complete` 迁移三组读数；该 HTTP 臂自 `#1081`（`25a8cb70`）起已接进真库 CI（`.github/workflows/real-pg-integration.yml:1707` 是 job id `real-pg-http-17-11:`，该 job 在 `.github/workflows/real-pg-integration.yml:1772` 跑该脚本；带点的 `name: real-pg-http-17.11` 在 `.github/workflows/real-pg-integration.yml:1708`） | 外部条件 | `services/api/src/media/store-pg.ts:371`（24h 窗口写在 SQL 里）、`tests/integration/post-media-attach-http-pg.mjs:786`（衰减：把 3 行拨到 25h 前的 SQL）、`tests/integration/post-media-attach-http-pg.mjs:893`（`/complete` 调用） | `store` 侧 `postImageLimitError()` 仍无 HTTP 证据（`docs/verification/gy-r87-i30-http-e2e-20261107.md:165`）；`#1030` 四条 AC 按 `#1037`（`6e7f7465`）落地后重判（真实桶属 `#6` 的 AC，不在此列） |

## 三、依赖墙：今天可关 = 0 张

数据源：`docs/initial-issues.json` 的 `tasks[].dependencies`，实算 27 项任务。映射要留意：`GY-I01..I24` → `#1..#24`，但 `GY-I25→#27`、`GY-I26→#28`、`GY-I27→#29`——**ledger 的 `GY-I27` 是 issue #29，不是 #27**，写成 #27 会把整张图算错。`#1003`、`#1030` 是缺陷单，不在 `tasks` 里，本墙不涉及。这个台账文件今天没有任何提交碰过（`git log fd6a225c..55f86ef8 -- docs/initial-issues.json` 为空），所以下表与上一页逐行相同——相同是实算结果，不是抄的。

21 张开放 issue 里 3 张没有未清依赖（`#27` 依赖为空；`#28` 只依赖已关的 #2；`#29` 只依赖已关的 #1、#2），其余 16 张各挂着 1 到 7 张未清依赖：

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

最长链 9 节，两条，链头分别是 `#27` 与 `#29`：`#27 → #4 → #6 → #14 → #15 → #19 → #22 → #23 → #24`、`#29 → #4 → #6 → #14 → #15 → #19 → #22 → #23 → #24`。两条只在第 1 节不同——`#4` 的未清依赖同时含 `#27` 与 `#29`，第 2 节起完全重合。链头两个分别是外部条件与待裁定，链尾是 `#24`（比赛版交付），中间任何一节卡住，后面 6 节都动不了。

今天可关 = 0 张。三张「无未清依赖」的也不等于能关：`#27` 卡外部条件（主体资质/备案），`#28` 卡真机目视（截图与设备），`#29` 卡裁定。跟上一页相比今天的变化是：`#29` 的理由里不再有「`#1058` 的 `CONFLICTING`」——那张 PR 已由 `841bc1c3` 合入，只剩裁定一条。

## 四、外部条件清单（必须由用户/业主提供，我们不能自造）

| 要什么 | 卡住谁 | 现状（本页读到的） |
| --- | --- | --- |
| 正式小程序 AppID + 主体类目 | #4、#27 | 仓内 appid 已是正式号（`project.config.json:5`）；主体资质认证与服务类目仍未核对 |
| 隐私指引与备案号 | #27、#24 | 未核对（`docs/verification/gy-r79-demo-readiness-20261106.md:45`） |
| 正式 HTTPS 域名与证书 | #24、#23 | 基址未提供（`docs/verification/gy-r79-demo-readiness-20261106.md:47`） |
| 腾讯云审核 BizType 与各服务密钥（OCR/ASR/TTS/视觉/内容安全） | #9、#10、#11、#13、#14、#21、#1003、#6、#15 | 只有候选矩阵，无开通读数（`docs/verification/provider-matrix.md:43`）；替身对任何内容一律回报 `unsure`（`services/api/src/moderation/provider.ts:48`） |
| 真实对象存储桶与访问密钥 | #6、#15、#1030 | 桶未提供；现有媒体链路全跑在替身/合成端点上 |
| Android + iOS 多机型真机矩阵与测试微信号 | #23、#28 | 只有一台 Android 的端到端（`docs/verification/gy-r79-device-walkthrough-20261106.md:70`），iOS 无设备 |
| 法务口径：注销受理后不可撤回的对外表述 | #19 | 文案已按「受理即不可撤回」改好，口径本身仍需业主确认 |
| 产品/监工裁定：撤销注销是否另立需求单、三域失败是否保留原码 | #19、#29 | 两条都无结论 |

`E:\GengYunPrivate` 下已备的东西（本页只报文件名与用途，用途按文件名判断，不读、不打印任何值）：11 个文件 + 2 个子目录 `backups`、`reference`（只记名字，不进去读）。

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
- `github-pat.txt`：带 workflows 权限的 PAT（B 档 PR 代合要它，今天 `#1070`、`#1073` 就是这样合进来的）。

这些文件只是「备着」，不等于条件满足：把 #27 的主体资质、#21 的开通读数、#23 的真机矩阵变成读数，仍要人拿着它们去平台上操作一遍，并把读数落成证据页。

## 五、在飞 PR 清单

本节在 **2026-11-08T15:29:30+08:00（Asia/Hong_Kong）** 抓取，只保证**号集与标题**在该时刻成立；head 与 merge 状态变动比本页快，凡与本页冲突以现场 `gh pr list` 为准。第一版这一节写的是 head 与 mergeable，而它抓下来时四行里已经有三行不成立（`#1078` 在那一版快照前 90 秒已合入、`#1077` 在前 4 分 38 秒已关闭、`#1080` 在本页改稿期间合入），所以改成本版：**只冻结「谁开着、标题是什么、干什么用的」**。

实跑 `gh pr list -R GengYunChuChao/GengYun --state open` 得 **3 张**（上一页只有 1 张，且那张 `#1058` 今天已由 `#1070` 合入）：

| PR | 标题（完整） | 档位 | 这一张在做什么（一句） |
| --- | --- | --- | --- |
| #1083 | `docs(verification): 出 R89 开放 issue 验收现状快照（21 张逐行，今天可关 0 张）` | A | 就是本页所在的 PR：只新增 `docs/verification/**` 证据页 |
| #1082 | `test(tools): 锚点闸门跳过围栏代码块，并把「目标文件不存在」纳入零容忍（承接 #1077）` | B | 承接已关闭的 `#1077`，继续改 `tools/**` 的锚点闸门 |
| #1081 | `ci(media): 把 HTTP 端到端臂接进真库 CI（real-pg-http-17.11）` | B | 把 `#1071`／`#1075` 那支 HTTP 臂真正接进 workflow |

- 档位依据：`#1083` 只改 `docs/**` 下的证据页，落在 A 档正面清单（`docs/pr-review-policy.md:167`）；`#1082` 改 `tools/**`、`#1081` 改 `.github/**`，都在正面清单外 ⇒ 一律 B 档（`docs/pr-review-policy.md:173`）。A 档不取消独立审查，只是不经监工批复。
- 本节不写 head、不写 mergeable：这两项在本页成文期间变了不止一次（下一条就是记录），写进快照页只会再错一次。
- **本页成文期间发生的事**（如实记，也作为「本表会过期」的证据）：`#1078` 已于 14:59:57 HKT 合入 main（`c031023d`，比第一版快照 15:01:27 早 90 秒）；`#1080` 已于 15:09:26 合入（`f7a4d0d9`）；`#1077` 已于 14:56:49 关闭并由 `#1082` 承接（关闭不等于合入：它的改动没有落 main）。
- 本表只列 `gh pr list` 能看到的东西。别人机器上未推送的本地分支本页看不到，我不声称「除这三张之外没有在飞改动」。

## 六、待裁定与已知限制

- `#19`：撤销注销要不要另立需求单，待产品/监工一句话。事实是受理即撤，连管理员都 restore 不了（`services/api/db/migrations/0017_account_suspend_authority.sql:272-273` 抛 `G0004`）。
- `#29`：「三域把 provider 异常吞成 `PROVIDER_OUTCOME_UNKNOWN`」是否必修，待裁定；今天 `#1072` 只补了归属与锚点（`docs/architecture/acceptance-map.md:299`），判定没变（仍未修、相邻面、需另行裁定）。终态原因那一半已经不在飞了：`#1078` 于 14:59:57 合入（`c031023d`），但它的提交正文写的是 `References: #29 (do not close)`，落地不等于可关。
- `#6`：证据页 §6 留了两条待裁定（上传取消是否入契约、帖子收藏/历史是否属 #15 的口径），本页不替谁拍（`docs/verification/gy-r87-i06-i15-ac-evidence-20261108.md:133`）。
- `#28` 台账闸门的已知限制写在测试里：只比路径、不比字节，同一张图另存 4 份物理拷贝仍能点亮多行（`tests/reference/i26-tabbar-skeleton.test.mjs:950-951`）；证据下限 8192 字节（`tests/reference/i26-tabbar-skeleton.test.mjs:122`）只抬高占位成本，不是画质判据。
- `#1030` 的 HTTP 臂（本地读数）是在**一次性簇**上跑的：对象存储是合成端点、审核域是合成端口、PG 临时簇跑完即删（`docs/verification/gy-r87-i30-http-e2e-20261107.md:160`），`.github/workflows/real-pg-integration.yml:857` 跑的是另一支 store 级臂；这条 HTTP 臂自 `#1081`（`25a8cb70`）起已接进真库 CI：`.github/workflows/real-pg-integration.yml:1707` 是 job id `real-pg-http-17-11:`，`.github/workflows/real-pg-integration.yml:1772` 跑该脚本；带点的 check 名 `name: real-pg-http-17.11` 在 `.github/workflows/real-pg-integration.yml:1708`。
- 读数页闸门（`tools/verify-reading-pages.mjs`）只做页内算术：不与上游 json 产物对账（`tools/verify-reading-pages.mjs:32`）；页内没有「这一行属于哪一组」的声明时会误报（`tools/verify-reading-pages.mjs:30`）。
- `SAY_FLOOR` 只挡「整节被悄悄拿走」：它按可执行 `say(` 调用点与结构串判定，不判断言语义（`tests/unit/post-media-attachments-say-floor.test.mjs:31`）。
- `#29` 那行第三条锚（`tests/integration/egress-ledger-pg.mjs:720-731`）是按基线 `55f86ef8` 核的：`#1078`（`c031023d`）在同一文件前段插了 32 行，同一块在 `f7a4d0d9` 上已下移到后段。本页没在新基线上重核这条行号——按 main 查时请用注释块原文 `12. 撤回的作用域负控制` 定位，别用本页的行号。
- 同理，`c031023d`／`f7a4d0d9` 碰过的其它文件本页没有锚点（`services/api/src/privacy/task-egress.ts`、`services/api/src/errors.ts` 等），不受影响；`#1030` 行那两条 workflow 锚（`.github/workflows/real-pg-integration.yml:857`、`.github/workflows/real-pg-integration.yml:868`）我在 `f7a4d0d9` 上复核过，行号与原文都没变（`#1080` 的 130 行加在文件后段）。

## 七、本页不声称什么

- 本页不声称任何一张 issue 的验收结论，也不给「可以关单」的名单；关单权在指挥。
- 本页不声称外部条件已经具备：`E:\GengYunPrivate` 里的文件只是存在，本页没读它们的值，也没验证它们能不能用。
- 本页不声称 CI 绿等于功能可用：`#1073` 抬的是「读数条数下限」，它只能证明断言组没被删，不证明断言写对了。
- 本页不声称真库臂等于真实外部服务：HTTP 臂的桶与审核端口都是合成件（`docs/verification/gy-r87-i30-http-e2e-20261107.md:160`）。
- 本页不声称读数页闸门能替代人工审读数：它只做页内算术，不与上游产物对账。
- 本页不声称台账闸门能防住重复证据：它只比归一化后的路径，不比字节内容。
- 本页不声称依赖图完整反映真实阻塞：它只反映 `docs/initial-issues.json` 里写下的 `dependencies`，外部条件与待裁定项不在图里，所以「今天可关 0 张」是这两类叠加的结果，不是图算出来的。
- 本页不声称 `#1055` 属本仓验收范围：那是外部线贡献，只记存在，不据它计数。
- 本页不声称本期合入清单完整覆盖 main 上的全部提交：§一 1.1 只覆盖 `fd6a225c..55f86ef8` 这一段（11 个提交，`git log` 实跑），1.2 那三笔是成文期间追加记录的。
- 本页不声称第五节的号集在成文后仍然成立：它只冻结 2026-11-08T15:29:30+08:00 那一刻的号集与标题，头 SHA 与 merge 状态一律不写（成文窗口内就有三张变了，见 §一 1.2）。
- 本页不声称已在新基线上复核过全部行号：基线仍是 `55f86ef8`；只有指向被 `#1081`（`25a8cb70`）改动文件的 11 条锚点已按 `edd41481` 重核并登记（`#1086`），其余锚点未逐条复核（例外：`#19` 行那条保留策略锚点已按该策略文件里的 `table:` 行重核并单独登记）。

## 八、更正上一页（R88）

旧页 = `docs/verification/gy-r88-open-issue-acceptance-index-20261108.md`（快照 2026-11-08T03:51:50+08:00，基线 `fd6a225c5c032857411f186765c94497b604f21e`）。以下逐条按今天的事实更正，每条给依据：

- 旧页第五节「实跑 `gh pr list --state open` 得 1 张」：本页抓取时刻是 3 张（`#1083`、`#1082`、`#1081`），且那唯一一张 `#1058` 已由 `#1070`（`841bc1c3`）合入 main——那张表的唯一一行整行失效，不只是数字变了。
- 旧页 `#1030` 行「24h 自衰减未测」：`#1075`（`49b68743`）已补 PASS 9（断言 `tests/integration/post-media-attach-http-pg.mjs:792-796`），做法是把 `public.media.created_at` 拨到 `now() - interval '25 hours'`（`tests/integration/post-media-attach-http-pg.mjs:786`）——「需要时间穿越」这个理由本身成立，但今天已经穿过去了。
- 旧页 `#1030` 行「上传完成 ⇒ ready 的 `/complete` 状态迁移未覆盖」：`#1075` 已补 PASS 11（调用 `tests/integration/post-media-attach-http-pg.mjs:893`，202/`state=ready`/`revision=2` 断言在第 897–899 行）。
- 「代码在飞」不是旧页 R88 的判定，而是上上页 R87 的（`docs/verification/gy-r87-open-issue-acceptance-index-20261107.md:29` 的 `#6`、`docs/verification/gy-r87-open-issue-acceptance-index-20261107.md:37` 的 `#15`）；R88 已把 `#6` 改判「外部条件」（`docs/verification/gy-r88-open-issue-acceptance-index-20261108.md:48`），`#15` 在 R88 仍是「代码在飞」（`docs/verification/gy-r88-open-issue-acceptance-index-20261108.md:56`）。`#1069` 出的证据页自陈这个判定对这两张已不成立（`docs/verification/gy-r87-i06-i15-ac-evidence-20261108.md:157`、`docs/verification/gy-r87-i06-i15-ac-evidence-20261108.md:158`），且 HTTP 端到端用例已在 main ⇒ 本页把这两行改判为「外部条件」为主（最卡的是 B1 真实凭据）。
- 旧页 `#14` 行把 `services/api/src/moderation/provider.ts:9`、`services/api/src/moderation/provider.ts:11` 当证据：这两行是文件头 JSDoc 的**注释**（讲口径），不是判定代码。判定在 `services/api/src/moderation/service.ts:421-427`（真抛 503 + `retryable: false`）与 `services/api/src/moderation/decisions.ts:210`（无结论支落 `quarantined`）。注释锚能过闸门（区间全是注释不判 SUSPECT），但它不是证据，本页改锚。
- 旧页 `#23` 行用 `docs/verification/gy-r79-device-walkthrough-20261106.md:74` 证「不能证明分布」：那一行只是小标题「**不能证明**」，正文没有分布结论。本页改用该页 `docs/verification/gy-r79-device-walkthrough-20261106.md:5`（「本页只记录这一次会话的实际读数，不构成准确率、容量或正式发布验收」）。
- 旧页第三节把「今天可关 0 张」的理由之一写成「`#29` 卡裁定加 `#1058` 的 `CONFLICTING`」：`#1058` 已合入（`841bc1c3`），这条理由今天不成立；`#29` 只剩裁定——它的终态原因改动已于 14:59:57 随 `c031023d` 合入 main（`#1078`），不再是在飞项。
- 旧页第一节尾注写在飞的「`#29` 终态原因：本地分支 `feat/gy-r87-i29-terminal-reason` @ `a4eb4400`，未推、未开 PR」：它已走完 PR 流程并合入 main（`#1078` → `c031023d`，2026-11-08T06:59:57Z），「本地分支、未开 PR」这个状态描述两层都过期。
- 本页第一版（`04fe1868`）第五节自己也犯了同一类错，一并纠正：它把 `gh pr list` 数成 4 张，其中 `#1078`（14:59:57 已合入）、`#1077`（14:56:49 已关闭）当时都不在 open 里，还漏了承接 `#1077` 的 `#1082`；`#1080` 也在 15:09:26 合入。根因是把分钟级变动的 PR 头 SHA／merge 状态写进小时级生命周期的快照页——第二版起第五节只冻结号集与标题，节末另记成文窗口内的变动。
