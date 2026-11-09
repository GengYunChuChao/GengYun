# 开放 issue 的验收现状索引（2026-11-07 22:29 HKT 快照，R87）

## 怎么读这张表

- 本页是**读数快照**，不是验收结论：它只登记「每张 issue 现在卡在哪一件、由谁提供」，**不给任何 issue 背书可关单**。
- 快照时间 **2026-11-07T22:29:42+08:00**（`Get-Date -Format o` 实测）；`origin/main` = **`1b0a3b63e023804a5f7d448c25b269013ed82de6`**（提交时间 2026-11-07 22:12:23 +0800，标题「docs(verification): 补 R87 真库臂复跑读数（180 条全 same、different 0） (#1056)」）。本页写在这棵树**之上**，页面自身未合入，故本页不存在自指的提交 SHA。
- 本页**取代** `docs/verification/gy-r83-open-issue-acceptance-index-20261107.md`（那一页是 2026-11-07 04:26 HKT、`8543d63f` 的快照）。按 `docs/pr-review-policy.md` §11 的口径，旧页不回填，新读数另开页。
- 三列口径沿用旧页：**一句话现状**只说树里有什么；**证据锚点**一律给 `path:line` 或 PR/SHA，指不到具体行就不写这一条结论；**还缺什么**写到「缺哪一件 + 由谁提供」，不写「待完善」这类空话。
- 与本页无关的一条：PR `#1055`（作者 `cxhhandsome`，分支 `test/gy-r87-i29-log-payload-redaction`，只加 `tests/unit/privacy-log-payload-redaction.test.mjs`）标题自称「覆盖四个受理面（#29 AC-2）」、正文写 `Refs #29`（不 `Closes`）——**与本页的关单计数无关**，不参与本页任何计数。

## 一、今天变了的五件事

1. **`#22` 的真库臂读数清零了（这是本页最重要的一条）**：`docs/verification/gy-r87-failmatrix-real-arm-rerun-20261107.md`（PR `#1056`，squash 合入后就是 main 顶端 `1b0a3b63`；分支侧修订提交 `ee4cc192` 不在 main 历史里，只作溯源）实跑 `total 180 / same 180 / sameWithCheck 24 / sameWithShape 30 / sameWithEither 54 / sameWithNeither 126 / different 0 / not_runnable 0`，环境 `initdb (PostgreSQL) 17.11`、`server_version=17.11`（`docs/verification/gy-r87-failmatrix-real-arm-rerun-20261107.md:44-50` 的对照表；`sameWithEither` 见 `docs/verification/gy-r87-failmatrix-real-arm-rerun-20261107.md:61`，合计行见 `docs/verification/gy-r87-failmatrix-real-arm-rerun-20261107.md:84`；PG 版本见 `docs/verification/gy-r87-failmatrix-real-arm-rerun-20261107.md:15`、`docs/verification/gy-r87-failmatrix-real-arm-rerun-20261107.md:16`）。旧基线是 `docs/verification/gy-r82-failmatrix-reconcile-20261106.md:27` 的 `total=180 same=162 sameWithCheck=19 sameWithShape=27 different=5 notRunnable=13`。⇒ `#22` 的「5 条 `different`、13 条 `not_runnable`」**已从代码欠账变成已出读数**（`same 162→180`、`different 5→0`、`not_runnable 13→0`，差值见 `docs/verification/gy-r87-failmatrix-real-arm-rerun-20261107.md:44-50` 的对照列）。它剩下的阻断只剩两类：**依赖门**（`#5 #9 #10 #12 #14 #15 #19`）与**用户侧外部条件**（AC2/AC3 的真实供应商与真机证据）。
2. **`#1030` 的修复在两条在飞 PR 上，不在一处**：`#1037`（分支 `feat/gy-r83-post-media-attach`，head `8bf16e72`，改 `services/api/src/community/store-pg.ts`、`services/api/src/media/store-pg.ts`，新增迁移 `services/api/db/migrations/0056_post_media_attachments.sql` 与回滚件）与 `#1057`（分支 `feat/gy-r87-i30-attach-limit-code`，head `0e2e380a`，在 `services/api/src/routes/community.ts` 的 `preValidation` 上挂 `rejectMediaIdsOverflow`，让「超过 3 张」返回 `post_image_limit` 机器码）。两处都 `state=OPEN`、`mergeable=MERGEABLE`、非草稿（`gh pr view` 实测）。**仍缺 3 件**：同帖并发真库用例、`owner_id`/`state` 的行为级负控制、real + PG 的 HTTP 端到端。⇒ `#1030` 合入前，`#6`/`#15` 的「每帖上限」与图片挂载**不能算完成**。线下与线上要分清：`#1037` 分支侧已有锚点返修提交（`c9816486`，父 `b7d8c29a`，只改 `tests/unit/doc-anchor-relocations.json` 两条登记、`to` 跟到 1300），**但尚未推送——GitHub 上的 head 仍是 `8bf16e72`**，别把分支侧动作读成线上已更新。
3. **`#29` 的账本臂要接 CI，且有一个口径问题仍待裁定**：PR `#1058`（分支 `feat/gy-r87-i29-ledger-ci`，head `523f7170`）在 `.github/workflows/real-pg-integration.yml` 新增 job `real-pg-ledger-17-11`（`name: real-pg-ledger-17.11`，`gh pr diff 1058` 实测），并改 `tests/unit/ci-integration-chain-structure.test.mjs`、`tests/unit/ci-real-pg-wiring.test.mjs` 的接线断言；该 head 之后还会返修，合入前不当作已接线。**该 PR 的 CI 首跑是红的**：`contract-tests` 与 `unit-tests` 两个 failure，根因是它改了被取证页锚着的测试文件，触发 `SUSPECT`/`BARE_ORPHAN`/`SYMBOL-COVERAGE-VERIFICATION-REGRESSION`，正在返修——本页据此把它记作「代码在飞」，不记作绿。**产品口径仍待裁定**：「撤回是否级联终止已受理 job」——`services/api/src/privacy/ledger-pg.ts:865-899` 的 `revokeInFlight` 只 `UPDATE public.exports`（`:888-894` 置 `state='failed'`、`error_code='CONSENT_WITHDRAWN'`），**不动 `public.jobs`**；分支 `test/gy-r87-i29-revoke-scope`（`d56146f8`）补的作用域负控制只覆盖「不跨用户、不跨用途」（新增 `tests/integration/egress-ledger-pg.mjs` 91 行、+9 行文档），**不回答**这个口径问题。
4. **`#28` 的真机台账闸门也在飞，但它只防「台账空转」**：分支 `test/gy-r87-i28-device-ledger-gate`（`3b3112c1` → `412c9ccd` → 本地尖端 `1861419b`，三次都**未推送**；改 `tests/reference/i26-tabbar-skeleton.test.mjs`）给「未取得」类台账加形状闸门，仍在返修。它**不证明真机验收已发生**——五 Tab 的真机逐一目视仍是未取得。
5. `#1055` 见上节末行：`Refs #29`、不 `Closes`，与本页的关单计数无关，本页不据它加减任何计数。

## 二、21 张开放 issue 总表

> 口径：21 张 = `gh issue list --state open` 实测（`#4 #5 #6 #7 #9 #10 #11 #12 #13 #14 #15 #19 #21 #22 #23 #24 #27 #28 #29 #1003 #1030`）。**没有一张可以关**：**16 张仍有未清的开放依赖**；2 张（`#28` 只依赖已关的 `#2`、`#29` 的 `#1`/`#2` 均已关）依赖已清，但因代码在飞/待裁定仍不可关；3 张（`#27`、`#1003`、`#1030`）无依赖项，卡外部条件或在飞代码。
>
> **「阻断项类型」列的定义**：它是**当前最主要的阻断来源**（`外部条件|依赖门|待裁定|代码在飞`），不是唯一来源。凡该行尚有未清的 `tasks[].dependencies`，必须在「还缺什么」格内另起一句写 `依赖 #x 未清`——所以「外部条件」与「依赖 #4 未清」同时出现是正常的，不是自相矛盾。

| # | 一句话现状 | 阻断项类型 | 证据锚点 | 还缺什么（由谁提供） |
| --- | --- | --- | --- | --- |
| `#4` | 微信登录/游客限制/归属权限的代码在 main；AppID 写在工程配置里 | 外部条件 | `services/api/src/routes/auth.ts:5`（`POST /auth/wechat` 公开、凭 `code` 建会话）；`project.config.json:5`（`wx4407a4b908a69a54`） | 正式 AppID 的**主体与类目**资质（用户侧，微信后台）；代码侧未见欠账（未做验收）；`依赖 #27 #29 未清`（其中 `#29` 的「撤回是否级联终止已受理 job」待裁定） |
| `#5` | 单作物 + 地区码档案有读写路由与字段约束 | 外部条件 | `services/api/src/routes/profile.ts:30`（`crop_id`/`region_code`/`region_catalog_version` 必填，`region_code` 钉 `^33[0-9]{4}$`） | 真机四路径**逐项目视**（用户侧，需要设备与人眼）；`依赖 #4 #28 #29 未清` |
| `#6` | 私有媒体上传/访问权限/EXIF 的入口在 main；「每帖 ≤3」的 post-scoped 形态不在 main | 代码在飞 | `services/api/src/routes/media.ts:218`（`POST /media/uploads`）；PR `#1037`/`#1057` | 真实对象存储桶上的图片链路（用户侧）+ `#1030` 合入（本项目）；`依赖 #4 #29 未清` |
| `#7` | 科普/除草剂查询与来源版本在 main，排序口径用登记号稳定键 | 外部条件 | `packages/reference/query.mjs:513`（按 `registration_number` 稳定排序） | **真实投影读数**（仓库外：真实制剂目录/线上投影）；台账 `status` 收口属监工；`依赖 #4 未清` |
| `#9` | 识别路由与候选/不确定处理在 main；第二个供应商剖面适配器在仓内、但无已审供应商 | 外部条件 | `services/api/src/routes/recognitions.ts:79`（`POST` 识别）；`services/api/src/recognitions/openai-vision-adapter.ts:46` | 视觉**供应商评审**、真实照片集（用户侧）；无人像/无准确率证据的现状不因本页改变；`依赖 #5 #6 #7 #27 未清` |
| `#10` | OCR 路由与校正/登记核对链路在 main | 外部条件 | `services/api/src/routes/ocr.ts:224`（`POST` OCR） | 真实**标签图**与登记库样本（用户侧/业主）；`依赖 #6 #7 #27 未清` |
| `#11` | 录音上传、转写、发送核对的路由在 main；ASR 只有本地合成语音的读数 | 外部条件 | `services/api/src/routes/speech.ts:6`（`POST /speech/transcriptions` → 202） | **真人语音样本** + 真实 ASR 供应商（用户侧）；`依赖 #4 #6 #27 未清` |
| `#12` | 问答会话与消息链路在 main | 外部条件 | `services/api/src/routes/conversations.ts:133`（`POST /conversations`）；`services/api/src/routes/messages.ts:43`（`GET /messages`） | 供应商 **request id** 与 120 题集读数（用户侧/供应商）；`依赖 #6 #7 #27 #29 未清` |
| `#13` | TTS 与播报的注册点在 main，受全局开关门控 | 外部条件 | `services/api/src/routes/synthesis.ts:7`（`POST /speech/synthesis` → 202） | **真实音频链路**读数（用户侧：真机播放 + 供应商额度）；`依赖 #27 #28 #29 未清` |
| `#14` | 筛查端口与 fail-closed 口径在 main | 外部条件 | `services/api/src/moderation/provider.ts:9`（无端口即 503 `PROVIDER_UNAVAILABLE` + `retryable:false`）；`services/api/src/moderation/provider.ts:11`（无结论按 fail-closed 判 `quarantined`） | **真实图文审核能力**接入（供应商评审 + 预算，用户侧）；`依赖 #6 #27 未清` |
| `#15` | 社区发帖/评论/点赞/举报的契约与持久化在 main；每帖上限依赖 `#1030` | 代码在飞 | `services/api/src/routes/community.ts:71`（`PostInput` 含 `media_ids`）；PR `#1037`/`#1057` | `#1030` 合入（本项目）+ 审核域接线；`依赖 #4 #5 #7 #14 #28 #29 未清` |
| `#19` | 注销申请与状态迁移在 main；三步补齐的做法未定 | 待裁定 | `services/api/src/routes/account-deletion.ts:253`（`POST /me/account/deletion`） | 「不可回退的去身份」三步**由产品裁定**；真实备份介质删除能力（用户侧/运维）；`依赖 #4 #6 #11 #12 #15 #29 未清` |
| `#21` | 能力矩阵页在 `docs/verification/`，逐供应商留「未验证」明细 | 外部条件 | `docs/verification/provider-matrix.md:43`（「以上候选不表示已开通」）；`docs/verification/provider-matrix.md:32`（接入矩阵表头，表体 6 类供应商） | 各供应商**评审与预算**（用户侧）；`依赖 #9 #10 #11 #12 #13 #14 未清` |
| `#22` | 真库臂 180 条权限面全 `same`、`different` 0、`not_runnable` 0（PG 17.11） | 依赖门 | `docs/verification/gy-r87-failmatrix-real-arm-rerun-20261107.md:84`（合计行）；PR `#1056`（squash = `1b0a3b63`）；旧基线 `docs/verification/gy-r82-failmatrix-reconcile-20261106.md:27` | 依赖 `#5 #9 #10 #12 #14 #15 #19` 全清（见 `docs/initial-issues.json:909-919`）+ AC2/AC3 外部证据（用户侧） |
| `#23` | 真机一次端到端可证「上传→识别→手选」这条链，模拟器另一次 | 外部条件 | `docs/verification/gy-r79-device-walkthrough-20261106.md:70`（链在真机成立）；`:74`（不能证明什么） | **多机型矩阵**与时延/容量读数（用户侧设备）；`依赖 #19 #21 #22 未清` |
| `#24` | 本机演示栈可拉起；体验版/正式发布通道不可用 | 依赖门 | `docs/verification/gy-r79-demo-readiness-20261106.md:18`（预览/体验版**不可用**）；`:47`（正式 HTTPS 基址未提供） | **真实部署环境**（用户侧域名/主机）；`依赖 #21 #22 #23 未清` |
| `#27` | AppID 在工程配置里；主体/类目与备案域名未核对 | 外部条件 | `project.config.json:5`；`docs/verification/gy-r79-demo-readiness-20261106.md:45`（主体/类目/隐私指引/备案未核对） | 主体与类目、隐私指引/备案、request 合法域名（用户侧，微信后台） |
| `#28` | 五 Tab 骨架与失败态在 main；台账闸门在飞 | 代码在飞 | `miniprogram/app.json:38`（`tabBar`）；分支 `test/gy-r87-i28-device-ledger-gate`（本地尖端 `1861419b`，未推送） | 五 Tab **真机逐一目视**（用户侧）；闸门合入（本项目） |
| `#29` | 授权/撤回/账本链路在 main；撤回只置 exports、不动 jobs | 待裁定 | `services/api/src/privacy/ledger-pg.ts:865-899`（`revokeInFlight` 只 `UPDATE public.exports`）；PR `#1058`（`real-pg-ledger-17-11`；CI 首跑两 failure，返修中）；分支 `test/gy-r87-i29-revoke-scope` @ `d56146f8` | 「撤回是否级联终止已受理 job」**由产品裁定**；真实外发账本行要在生产/真库取（用户侧环境） |
| `#1003` | `openai-vision-v1` 适配器已在仓内（含真实 `fetchImpl`），缺的是已审供应商与凭据 | 外部条件 | `services/api/src/recognitions/openai-vision-adapter.ts:46`（协议名 `OPENAI_VISION_PROTOCOL`）、`services/api/src/recognitions/openai-vision-adapter.ts:278`（真实 `fetchImpl` 调用，适配器共 348 行）；`docs/reference/configuration.md:27`（原文：骨架已就位但**无真实供应商、无真实调用**） | 供应商评审、凭据与预算（用户侧）；`RECOGNITION_PROVIDER_URL`/`RECOGNITION_PROVIDER_KEY` 只是受理前提、不是验收证据 |
| `#1030` | 两处修复在飞：帖子级挂载 + 机器码 | 代码在飞 | PR `#1037`（GitHub head `8bf16e72`；分支侧另有 `b7d8c29a`/`c9816486` 锚点返修、未推送，迁移 `0056_post_media_attachments.sql`）；PR `#1057`（head `0e2e380a`，`services/api/src/routes/community.ts` 的 `rejectMediaIdsOverflow` 挂 `preValidation`） | 同帖并发真库用例、`owner_id`/`state` 行为级负控制、real+PG HTTP 端到端（本项目，三件） |

## 三、依赖墙：今天可关 = 0 张

- `docs/initial-issues.json` 记 27 项任务（`GY-I01`…`GY-I27`）；**21 张开放里 18 张有非空 `tasks[].dependencies`**，即 `#4 #5 #6 #7 #9 #10 #11 #12 #13 #14 #15 #19 #21 #22 #23 #24 #28 #29`；**其中 `#28` 只依赖已关的 `#2`、`#29` 依赖已关的 `#1`/`#2`，所以仍有未清开放依赖的是 16 张**。不在这 18 张里的只有三张：`#27`（`GY-I25`，`dependencies: []`）、`#1003` 与 `#1030`（两者是缺陷，不在 `tasks` 里）。
- 只在**开放节点**里算（已关的上游不计），最长链是 **9 节**：`#27 → #4 → #6 → #14 → #15 → #19 → #22 → #23 → #24`（由 `tasks[].dependencies` 逐边校验，每一条边都在开放集内）。另一条 8 节链 `#29 → #4 → #6 → #11 → #19 → #22 → #23 → #24` 同样全开放，但比上面短一节——两处口径不同时以 9 节那条为准。
- 结论：**今天可关 = 0 张**。这不是「AC 不够」的措辞问题：`#22` 的读数今天已经清零到 `different 0 / not_runnable 0`，但它的 7 个依赖仍在开放集里；`#24` 这种末端节点要等前 8 节全清。**卡住的是依赖门 + 外部条件，不是验收标准本身**。

## 四、外部条件清单（必须由用户/业主提供，我们不能自造）

| # | 外部条件 | 解谁的锁 |
| --- | --- | --- |
| 1 | 正式小程序 AppID 的**主体与类目**（微信后台完成认证） | 解 `#27`、`#4`、体验版/正式发布通道 |
| 2 | 隐私保护指引、备案、request 合法域名白名单 | 解 `#27`、`#24` 的对外可访问性、体验版 |
| 3 | 供应商评审与预算（视觉/OCR/ASR/TTS/问答/审核六类） | 解 `#9 #10 #11 #12 #13 #14 #21`、`#1003` |
| 4 | 视觉供应商凭据：仓库要 `RECOGNITION_PROVIDER_URL` / `RECOGNITION_PROVIDER_KEY` | 解 `#1003`、`#9`（没有凭据就只能跑明确标注的替身） |
| 5 | 真实照片集、真实标签图、真人语音样本 | 解 `#9 #10 #11` 的「真实输入」腿，也是 `#22` AC2/AC3 的外部证据来源 |
| 6 | 真机多机型矩阵（机型/系统版本/人眼逐项） | 解 `#23`、`#28` 的五 Tab 目视、`#5` 的四路径目视 |
| 7 | 真实部署环境（已备案 HTTPS 域名 + 公开基址） | 解 `#24` 的联网比赛版、`#27` 的域名项 |
| 8 | 真实备份介质的删除能力与恢复演练环境 | 解 `#19` 的「备份 30 日删除」腿 |

另有两件**不是外部条件、属内部待裁定**，单独列出以免混淆：`#29`「撤回是否级联终止已受理 job」（当前 `revokeInFlight` 不动 `jobs`，见上表）；`#19`「不可回退的去身份」三步补齐的做法。

## 五、本页不声称什么

- **不声称任何 issue 可关单**：上表 21 行没有一行写「已通过/已验收」，本页也不为任何一张背书。
- **不声称真机已验**：真机只有 `docs/verification/gy-r79-device-walkthrough-20261106.md` 记的那一次端到端，五 Tab 逐一目视、多机型矩阵均未取得；`#28` 的在飞闸门只防台账空转，不构成真机证据。
- **不声称外部条件已具备**：第四节 8 项全部仍在等待用户/业主提供，仓库内没有任何替身可以顶替。
- **不声称读数可复用到 CI**：`#22` 的 180 条读数是本机 Windows + 一次性 PG 17.11 簇的实测（`docs/verification/gy-r87-failmatrix-real-arm-rerun-20261107.md:150` 自陈「本机 ≠ CI」），不替代 CI 绿。
- **不声称在飞 PR 已接线**：`#1037`/`#1057`/`#1058`/`test/gy-r87-i28-device-ledger-gate` 与 `test/gy-r87-i29-revoke-scope` 均为 `state=OPEN` 或未开 PR 的分支，本页只按 head SHA 记录当时的形态（在飞项于 2026-11-07T22:54 复核一次：`#1037` `8bf16e72`、`#1057` `0e2e380a`、`#1058` `523f7170`，`#28` 闸门分支本地尖端 `1861419b`）。
