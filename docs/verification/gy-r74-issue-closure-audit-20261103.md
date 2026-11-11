# R74 关单材料审计：24 项 OPEN issue 的可关闭性（2026-11-03）

- 采样时间：2026-11-03（HKT，UTC+8）
- 工作树：`E:\GengYunCommander\wt-r74-closure`｜分支：`docs/gy-r74-issue-closure-audit`
- 基线：`origin/main = 7a25d900a2269f1a412d5fb77eb45ef70eeb22ac`。开工读数：`git rev-parse HEAD` 与 `git rev-parse origin/main` 同为该 sha，`git status --porcelain -uall` 为 0 行。
- issue 清单与标题：沿用本轮开工前一次 issue 原文摘录（24 张，含 `[范围]`／`[验收]` 逐字条文）。**本页没有重新用 `gh` 拉取 issue 状态**，因此「24 张仍 OPEN」是取样口径、不是本页读数（见末节）。
- 前序页：`docs/verification/gy-r34-closure-matrix-20261024.md`（基线 `4b87e1d9`，判定「已交付 0 / 部分交付 24」）与 `docs/verification/gy-r31-closure-matrix-20261022.md`。**本页不修改这两页的任何数字**；与它们判定不同之处，逐条在本页写明差异理由。

## 1 口径声明

本页只回答一件事：**按每张 issue 自己写的 `[验收]` 条文，仓库里今天的实物能证到哪一步**。

- **本页不关 issue，也不改任何 issue 正文。** 判定是材料审计，不是验收裁定；任何「可关」字样都只是「可提交关单审查」的意思。
- 判定只对 `[验收]` 条文；`[范围]` 条目不参与判定，但若某条 `[范围]` 缺口会连带影响验收条文的读法，会在该节「差额」里点名。
- 三档定义：
  - **已满足**：该 issue `[验收]` 的每一条，都能在仓内用一条命令或一次 grep 复现出实物，且不依赖真机、真实供应商、真实时间流逝、部署授权或第三方确认。**判定基准**：已满足＝条文可在仓内以内存替身／单测复现；真库臂与真机层的验证单列在末节（§5、§6），不参与本档判定，故 #16／#18 的边界不因此改判。
  - **部分满足**：仓内有实物，但至少一条 `[验收]` 条文缺条文明写的某项；「缺什么」逐项写。
  - **未满足**：该 issue 的核心验收条文在仓内找不到兑现物，主体功能只到框架或脚本层面。
- **全页不写行号锚点**：指位置一律「文件路径 + 符号名 + 逐字片段」。行号会随代码移动漂移，且本仓的文档锚点闸门按这条纪律立。
- 本页所有「实测」都是本轮真跑出来的读数；没跑的进末节《本页未核实的点》，不写成「应该会」。
- 与 `gy-r34-closure-matrix-20261024.md` 的判定分歧共 4 处（#8、#16、#17、#18 由「部分交付」改判「已满足」），共同原因是那之后 main 上的落点补齐：`services/api/src/admin/ops/content-pg.ts` 的资料域真库落点（迁移 `0036_r34_admin_content_persistence.sql`）、`services/api/src/admin/ops/jobs-pg.ts`、`services/api/src/history/cascade-wiring.ts` 与终态历史端口、以及 `tests/reference/` 下 i08 全套断言。分歧理由写在各节「差额」里。

## 2 总表（24 张）

「依据」列凡标 † 者，是该条在本轮**没有重跑命令**、只依据既有取证页的自述登记（页名已给出），口径见末节。

| issue | 标题（截断） | 判定 | 一句话依据 | 缺什么 |
| --- | --- | --- | --- | --- |
| #4 | GY-I04 微信登录、游客限制与服务端归属权限 | 部分满足 | † `services/api/src/auth/wechat.ts` 的 `computeSubjectLookup` 与登录链页在仓内可复核（`gy-i04-login-chain-20261021.md`） | 正式 AppID 实测与 Android／iOS 真机登录链读数（该页自述属 #27 未取得项） |
| #5 | GY-I05 单作物地区档案及授权定位 | 部分满足 | † 定位六档与回落手选在回环层齐备（`gy-i05-locate-timeout-20261021.md` 表格） | 真机授权／拒绝／超时三态（该页逐条写「未取得（真机）」） |
| #6 | GY-I06 私有媒体上传、访问权限及 EXIF 清除 | 部分满足 | † 对象存储适配器与 SigV4 逐字节复算在进程内替身下跑通（`gy-i06-media-real-provider-plan-20261021.md`） | 真实桶的 ACL／签名／删除读数与真机大图性能集（该页自述「不产生任何真实对象存储证据」） |
| #7 | GY-I07 科普／除草剂查询、详情与来源版本 | 部分满足 | † `packages/reference/query.mjs` 的 `evaluateEligibility`／`isSimulatedSource` 与失效判定（`gy-r29-i07-closure-20261022.md`） | 列表排序口径待用户裁定；详情真 PG 读面读数未取得（该页 §5 仍有未取得项） |
| #8 | GY-I08 药剂适用过滤与用量安全边界 | 已满足 | `tests/reference` 28 个 `.mjs` 全跑 358/358 通过（其中 i08 子集 9 个测试文件 54/54），含「≥100 组全部通过」与规则版本单一事实来源 | —（见 §3.1） |
| #9 | GY-I09 实时拍草识别、Top3 核对及不确定处理 | 部分满足 | † `services/api/src/recognitions/provider.ts` 的 `real` 分支无替身回退，未配置即 503（`gy-i09i10-recog-20261019.md` 表内该行） | 真实供应商调用证据（真实请求编号／耗时／模型版本） |
| #10 | GY-I10 标签 OCR、用户校正及登记精确核对 | 部分满足 | † 回环 HTTP 回归 11 组，合成身份与替身提供者（`gy-i10-ocr-http-20261012.md` 末行自述未联网、未调真实供应商） | 真实 OCR 供应商与真实标签样本 |
| #11 | GY-I11 普通话录音、实时 ASR 与发送核对 | 部分满足 | † 音频格式守卫与转写确认链路有单测（`gy-r72-i11-audio-format-20261102.md`） | 真实 ASR 调用与 50 段真实普通话样本 |
| #12 | GY-I12 有来源的语音／文字大模型问答 | 部分满足 | † 真实 LLM 有 8 次 HTTP 200 记录（`llm-live-evidence.md`） | 固定 120 题评估与真实资料库（`gy-i12-chat-20261019.md` 自述未取得） |
| #13 | GY-I13 普通话 TTS、播放球及安全文本自动播报 | 部分满足 | † 合成与媒体存储接线页（`gy-r34-i13-tts-media-store-20261023.md`） | 30 段真实 TTS 音频与真机播放球（该页 §7 自述「不构成 #13 的验收，也不构成它的完成」） |
| #14 | GY-I14 文字／图片 AI 筛查、版本重审与失败隔离 | 部分满足 | † 审核台账真库落点 `services/api/src/moderation/ledger-pg.ts` 与规则链 | 200 条文字＋200 张图片真实样本；人审队列仍 `wired: false`（`services/api/src/admin/human-review.ts`） |
| #15 | GY-I15 社区发帖、评论、点赞、筛选与举报 | 部分满足 | † 举报推进状态机与注销原语已补（`gy-r31-i15-s1-s6-20261022.md`）；社区 PG store 在装配路径 | 真实审核投稿与真实审核供应商读数 |
| #16 | GY-I16 收藏与可浏览的识别历史 | 已满足 | 隔离脚本 exit 0；收藏／历史单测 17/17；分页与「已加载」计数口径自证 | —（见 §3.2） |
| #17 | GY-I17 应用内消息、未读状态与权限跳转 | 已满足 | 消息三组单测 21/21；未读计数有独立读面；全仓 0 处微信订阅消息 | —（见 §3.3） |
| #18 | GY-I18 独立后台资料、账号、AI 任务及功能开关 | 已满足 | 开关门 35/35、内容与作业 41/41；资料域真库落点＋人审空入口 | —（见 §3.4） |
| #19 | GY-I19 注销去身份、在线 7 日／备份 30 日与恢复 | 部分满足 | † 注销闭集与在线清除证据（`gy-r34-i19-deletion-closure-20261023.md`，自述「不是关闭依据」） | 7 日／30 日真实时间读数、真实备份介质、第三方删除回执 |
| #20 | GY-I20 冻结独立评估样本、标准答案及评估程序 | 部分满足 | 172 条 `test` 分割索引在库（`packages/evaluation/samples/gy-i20-weeds-real-index.json`）＋缺口册 `docs/evaluation/sample-gap-register.md` | 拍草其余类目、标签、AI 文字／图片、普通话、TTS、问答六类样本与标准答案独立核实 |
| #21 | GY-I21 持续评估真实 AI 能力并汇总门槛 | 未满足 | 只有门槛表 `packages/evaluation/src/targets.mjs` 的 `METRIC_GATES` 与 `docs/evaluation/acceptance-thresholds-summary.md`，无任何逐类运行报告 | 六类各一份带样本数、版本、覆盖率、实际失败的运行报告 |
| #22 | GY-I22 权限、安全规则及端到端失败回归 | 部分满足 | † `tests/unit/gy-i22-failmatrix.test.mjs` 的 `MIN_CASES` 为 249、`tests/failmatrix/mutations.mjs` 记 27 条负控制 | 真机回归与四个域纳入矩阵的裁定（`gy-r31-i22-failure-matrix-20261022.md` 自述实测只有两处） |
| #23 | GY-I23 Android／iOS 真机、时延容量与完整演示 | 部分满足 | † 本机回环时延容量页（`gy-i23-latency-capacity-local-20261020.md`） | 真机与真实公网读数（该页自述「不构成 #23 任何条款的达标判定」） |
| #24 | GY-I24 部署联网比赛版、备份恢复并交付材料 | 未满足 | 发布门禁脚本与材料索引存在（`gy-r31-i24-release-20261022.md`） | 任何一次真实部署（该页自述「真实 CVM／云托管的发版仍未执行」） |
| #27 | GY-I25 正式 AppID、真机域名与六类服务接入 | 部分满足 | † 接入矩阵与六类适配登记（`docs/verification/provider-matrix.md`、`gy-i27-live-ai-20261018.md`） | 正式 AppID／域名归属、真实数据库与对象存储授权 |
| #28 | GY-I26 五 Tab 骨架、Demo 样式与统一失败态 | 部分满足 | 微信工具走查五 Tab 5/5 命中（`gy-i26-five-tabs-20261103.md`）＋状态层 24 契约码 | Demo 全页遮挡走查记录、静态地区「不假发预警」完整口径（见 §3.5） |
| #29 | GY-I27 用途授权、外发账本与隐私撤回守卫 | 部分满足 | 写侧 50/50、在途撤回与回执对称 15/15、隐私红线 17/17（本轮实跑） | 「完成」态在仓内装配下不可达：`ThirdPartyDeletionRecipientSource` 只有声明、没有实现被装配，只会落 `RECIPIENTS_UNWIRED` |

判定分布：**已满足 4 张（#8、#16、#17、#18）／部分满足 18 张／未满足 2 张（#21、#24）**。

> **订正（2026-11-04 复核）**：#22 那一行原先写的 `MIN_CASES` 230 与「23 条负控制」是本页笔误，不是矩阵条数回退——矩阵条数只增不减。复核读数：`tests/unit/gy-i22-failmatrix.test.mjs:49` 的 `MIN_CASES` 实为 **249**（自 2026-10-26 提交 `a3e53fbe` 起即为该值；2026-11-09 追记：R95 补「取消注销」5 条后该常量为 **254**、矩阵 254 条，本句读数按 §11 原样保留；2026-11-11 追记：R112 补 4 条伪造角色用例后该常量为 **273**、矩阵 273 条，常量声明行因上方演进注释增行已移到 `:49`）；`tests/failmatrix/mutations.mjs` 导出的 `MUTATIONS` 实为 **27** 条；矩阵实为 **249** 条（HTTP 229 + seam 20，`node tests/failmatrix/run.mjs --list` 末行原文 `合计 249 条用例（HTTP 229 + seam 20）。`）。本次只订正这三处读数，不改任何判定结论，也不改本页对 #22「真机回归与四个域纳入矩阵的裁定仍缺」的结论。

## 3 逐节论证

只对「已满足」与「部分满足且差额可在仓内补」的项写节。其余 19 项见总表，理由收敛在 §4。

### 3.1 #8 GY-I08 药剂适用过滤与用量安全边界（已满足）

**验收原文**

> - [ ] 至少100组登记／匹配／限制场景全部通过，含冲突、失效、未知和模拟
> - [ ] 未核对／不适用／禁用不能进入可执行建议或问答用量卡片
> - [ ] 所有风险文字无绝对安全／零药害承诺，有功能关闭开关
> - [ ] 需求第6节100组登记／制剂／来源冲突用例全过；无来源、模拟、失效、多匹配和关键字段冲突均阻断，所有消费端使用同一规则版本

**实物**

- `tests/reference/i08-scenarios-100.test.mjs`：`test('GY-I08 用例集：登记／匹配／限制 ≥100 组，全部通过'`，断言逐字为 `assert.ok(SUMMARY.results.length >= 100, ...)`；同文件另有「三类分组各自不少于 25 组」「每个阻断类别至少被覆盖一次（闭集无死角）」「被阻断用例逐类计数均为正」「缺项登记：真实资料无用量列 ⇒ 用量正例为缺项/未取得，不补造」「同登记号资料冲突不得被输入收窄消除」。这组钉住 A1 与 A4 的「100 组」「冲突／失效／未知／模拟」两半。
- `tests/reference/i08-rule-version.test.mjs`：`test('GY-I08 规则版本：单一事实来源 + 全部判定入口回传同一版本'`、`test('GY-I08 规则版本：域库与小程序源码不得出现与当前版本不同的 gy-i08 字面量（漂移检测）'`、`test('GY-I08 规则版本：跨线用量闸门（GY-I10 线）已纳入同一版本，且版本漂移即失败'`。这组钉住 A4 末句「所有消费端使用同一规则版本」。
- `tests/reference/i08-dose-card-authority.test.mjs`：`test('GY-I08 用量卡：未核对／不适用／禁用／开关关闭 四态都拿不到可执行用量'`、`test('GY-I08 用量卡：可渲染时 dose 逐字等于原文三元组，键集合为闭集'`、`test('GY-I08 用量卡：塞入个人换算/深配提示后产出不变（不存在自动换算路径）'`。这组钉住 A2，并把 A3 的「功能关闭开关」做成四态之一。
- `tests/reference/i08-risk-wording-guard.test.mjs` 里有「风险文字不得出现绝对安全／零药害承诺（全量标签与原因扫描）」，钉住 A3 前半。
- 「关闭开关真实生效」在服务端还有一条独立证据：`tests/unit/admin-flag-gate.test.mjs` 的 `test('E2. 跨端点：关闭「药剂输出」⇒ /herbicides 列表与详情拒绝且不产出任何制剂/用量数据'`，即开关关掉后连制剂／用量数据都不产出（不是只藏卡片）。

**我实际怎么验的**

```
node --test tests/reference/i08-scenarios-100.test.mjs
  ⇒ tests 7 / pass 7 / fail 0 / duration_ms 169.77
```

`tests/reference` 实为 28 个 `.mjs`（26 个 `*.test.mjs` ＋ `_fixtures.mjs`、`_i08-scenarios.mjs` 两个 helper），358 只在 28 个全跑时出现，i08 子集只有 9 个测试文件、54/54。所以这个数不能用目录传参取，必须写成 glob（先试过把目录整个传进去，`node --test tests\reference` 直接报 `'test failed'` 并以退出码 1 结束——这是调用方式错，不是用例失败）：

```
node --test tests/reference/*.mjs
  ⇒ tests 358 / suites 0 / pass 358 / fail 0 / cancelled 0 / skipped 0 / duration_ms 8627.12

node --test tests/reference/i08-*.test.mjs
  ⇒ tests 54 / pass 54 / fail 0（i08 子集 9 个测试文件）
```

开关那条在 `tests/unit/admin-flag-gate.test.mjs`、`admin-reference-invalidity.test.mjs`、`admin-ui-review-state.test.mjs` 一组里跑到 `tests 35 / pass 35 / fail 0`（1976.75ms）。

**差额**

无条文差额。两处口径边界写明，避免被误读：

1. 这 358 条断言跑在**随包名录**上（`packages/reference/seed.mjs` 的 `seedMeta` 自述 `traceable_authority: false`），不是真实农药登记数据；`i08-scenarios-100.test.mjs` 自己也登记了「真实资料无用量列 ⇒ 用量正例为缺项/未取得，不补造」。A1 条文原文含「模拟」，故不构成差额；真实标签与真实制剂登记的核对属 #10／#20 的范围。
2. `gy-r34-closure-matrix-20261024.md` 把 #8 记作「部分交付·卡点＝真实样本」。本页改判的理由是：判定只对 `[验收]` 条文，而那 4 条今天都能在仓内复现；「真实样本」是 `[范围]` 与 #20 的事，不是这 4 条的字面要求。若审查者按前者的口径读，本项仍可挂真实样本——这一处分歧留给定判定的人，我不替其裁定。

### 3.2 #16 GY-I16 收藏与可浏览的识别历史（已满足）

**验收原文**

> - [ ] 他人不能读取私有历史，旧收藏不恢复失效推荐资格
> - [ ] 候选与人工选择分开，失败任务真实可见
> - [ ] 识别／收藏不自动转成已使用事实
> - [ ] 列表、详情、收藏历史和消息均在读取时重查对象权限及当前可见性；隐藏／失效／注销不因缓存或旧链接重新公开

**实物**

- 跨账号隔离与可见性派生：`tests/integration/favorites-history-isolation-http.mjs` 是纯脚本断言（不是 `test()`，退出码 0 即过）。四个 case 的打印即证据：case1「B 直接拿 A 的收藏/历史 id 发 DELETE ⇒ 404/404 NOT_FOUND（与“不存在”同形=true）」；case2 删除后 `X-GY-Cascade` 头与历史删后识别 GET 均不可取回；case3 下架后 `reference_state=unavailable`、重读 3 次仍 unavailable、版本 +1 重新公开后旧收藏仍 unavailable、`Cache-Control=no-store`；case4 失效后 `favoriteEligibleForRecommendation(行)=false`、投影无推荐／使用类字段。这组钉住 A1 与 A4。
- 投影与 fail-closed：`tests/unit/favorites-history-visibility.test.mjs` 的用例名逐字含「投影字段集恰等契约：收藏 6 项 / 历史 7 项，且历史不含候选或人工选择字段」「可见性 fail-closed：未接线 / 抛错 / 非闭集取值 一律 unavailable，且不外泄原始错误文本」「读取时重查（无缓存）」「负例：隐藏/失效后不得因缓存或旧链接重新公开，旧收藏也不恢复推荐资格」「历史：失败/超时/取消/不确定 原样可见，且不会被折叠成成功或被隐藏」「历史：job_state 读取时实时重查；核不到时退回入库值，绝不凭空升级为成功」。
- 候选与人工选择分开：`services/api/src/recognitions/selection.ts` 文件头逐字写「模型原始候选写在 `Recognition.candidates`（契约冻结形状），人工选择写成本模块的独立记录行 —— 两者各有自己的 id/revision，人工选择**绝不回写** `candidates` / `model_score` / `model_version`」，并把 `MODEL_ATTRIBUTABLE_PROVENANCE` 定为恒空集、`countModelAttributable()` 恒为 0；`services/api/src/recognitions/service.ts` 里 `selectSpecies` 的注释逐字为「记录用户选择：只写 selected_species_id，绝不回写模型原始候选与分数」。这钉住 A2 前半与 A3（识别／收藏不会被折算成「已使用」或「模型命中」）。
- 去重落在库层：`services/api/db/migrations/0018_favorites_history.sql` 有 `CREATE UNIQUE INDEX favorites_owner_target_key ON favorites (owner_id, target_type, target_id);`、`CREATE UNIQUE INDEX history_owner_event_key ON history (owner_id, event_key);`、`CREATE UNIQUE INDEX history_owner_target_key ON history (owner_id, kind, target_id);`。收藏目标闭集为 `species|herbicide|scheme`（`services/api/src/favorites/service.ts` 注释逐字「只接受 `species|herbicide|scheme`（契约 `FavoriteTarget` 闭集）」），即 `[范围]` 里的杂草／药剂／方案三类都在。
- **分页与计数**（用户点名要重核的一项）：契约的 `GET /favorites`／`GET /history` 只回 `{items,next_cursor}`，**没有总数**；游标是 HMAC、TTL 15 分钟、绑 subject／auth_epoch／watermark，新增或取消收藏后重放旧游标返回 400 `INVALID_CURSOR`「游标位置已失效，请重新读取首页」。小程序侧 `miniprogram/pages/favorites/favorites.js` 的 `onReachBottom` 里逐字 `if (this.data.busy || !this.data.nextCursor) return`，`history.js` 同形。计数口径不是「假装总数」，而是「已加载条数」，且该条数不许出现在界面上——`tests/unit/miniprogram-favorites-targets-paging.test.mjs` 有 `test('计数与列表头文案自证「已加载」：profile 的表达式与两处 wxml 都不得回退成裸数字'`。

**我实际怎么验的**

```
node tests/integration/favorites-history-isolation-http.mjs
  ⇒ exit 0；末行 PASS favorites-history-isolation-http; synthetic identities + controllable
    visibility substitute; real loopback HTTP; no PG, no supplier, no WeChat devtools
```

```
node --test tests/unit/favorites-history-visibility.test.mjs
           tests/unit/favorites-replay-and-paging-visibility.test.mjs
           tests/unit/miniprogram-favorites-targets-paging.test.mjs
  ⇒ tests 17 / pass 17 / fail 0 / duration_ms 1727.88
```

另外用 grep 核过两件事：`services/api/src/routes/favorites.ts` 只有 `app.get`（列表）、`app.post`、`app.delete` 三条路由，**没有 `{id}` 详情读面**；`services/api/src/routes/history.ts` 只有 `GET /history` 与 `DELETE /history/:id`。（2026-11-04 复核：#878 起还有 `GET /history/{id}`，本条失效。）`services/api/src/history/service.ts` 文件头自述理由「契约里 `/history/{id}` 只有 delete，详情由客户端用第 7 项 `target_ref` 跳转」。

**差额**

无条文差额。三处边界，审查时会被问到：

1. 上面那个隔离脚本自述 `no PG`——它跑的是内存 store + 真回环 HTTP。真库臂 `tests/integration/favorites-history-pg.mjs` 存在但本页**未跑**（见末节）。
2. 历史域没有独立详情读面（见上）。（2026-11-04 复核：#878 已补 `GET /history/{id}`，本条失效。）A4 的「详情」由 `target_ref` 跳转后的识别／OCR 详情兑现，那两处的归属守卫在 `services/api/src/routes/recognitions.ts`（`GET /recognitions/:id` 等四条）里；本页未单独构造越权请求去打它。
3. `[范围]` 里「注销删除接 F13」只有两腿：隔离脚本打印的 `X-GY-Cascade=partial`，`gy-r34-closure-matrix-20261024.md` 记「级联只接识别/OCR 两腿，媒体与外发腿未接」。这条不属 `[验收]` 四行，且注销闭集归 #19；写在这里是为了不让「已满足」被读成「注销全链路已接」。

### 3.3 #17 GY-I17 应用内消息、未读状态与权限跳转（已满足）

**验收原文**

> - [ ] 重复调度不重复创建，未读计数可复核
> - [ ] 发送或创建不当作已读；游客和其他用户不可读
> - [ ] 首版不接微信外部推送，不虚构真人互动消息
> - [ ] 列表、详情、收藏历史和消息均在读取时重查对象权限及当前可见性；隐藏／失效／注销不因缓存或旧链接重新公开

**实物**

- 去重与幂等：`tests/unit/community-message-notifications.test.mjs` 有用例名逐字含「反例·事件去重：同 (owner,event_key) 只创建一次，且命中去重不得重置读状态」。库层由 `services/api/db/migrations` 里消息表的 `(owner_id, event_key)` 唯一约束裁决（与收藏／历史同一写法）。
- 未读计数可复核：`services/api/src/routes/messages.ts` 只有两条读面 `app.get(\`${API_PREFIX}/messages\`` 与 `app.get(\`${API_PREFIX}/messages/unread-count\``——未读数是独立可查的资源，不是列表里的一个布尔位。`tests/unit/messages-read-version.test.mjs` 的用例名逐字含「首次标记 ⇒ revision 恰好 +1，且强 ETag 随资源状态变化」「重复标记（新键 + 当前 ETag）⇒ revision 不变、read_at 不变、未读为 0」「用旧 ETag 做第二次标记 ⇒ 409 REVISION_CONFLICT」「并发两条首次标记（同幂等键）⇒ 恰好一次版本推进」。
- 归属与越权：`tests/unit/messages-security.test.mjs` 的用例名逐字含「反例·归属：他人消息 既不能标记也不能列出；标记报错与“不存在”逐字节同形」「反例·读取时重查：reference_state 不入库、逐次派生」。
- 不接微信推送：全仓 `services/api/src/**/*.ts` 与 `miniprogram/**/*.js` 搜 `subscribeMessage|订阅消息|wx\.requestSubscribeMessage` 为 **0 命中**。
- 消息类型是闭集，且契约里没有「正文／摘要」字段：`services/api/src/messages/types.ts` 的 `MESSAGE_TYPES` 逐字为 `['comment', 'like', 'moderation', 'system'] as const`，同文件注释逐字「契约里**没有** `title`/`body`/`actor`/`summary`/`unread`/`source_event` 等字段」——这同时挡掉「虚构真人互动消息」这条路（没有承载正文的字段）。

**我实际怎么验的**

```
node --test tests/unit/messages-read-version.test.mjs
           tests/unit/community-message-notifications.test.mjs
           tests/unit/messages-security.test.mjs
  ⇒ tests 21 / pass 21 / fail 0 / duration_ms 1417.73
```

grep 计数命令与结果：`Select-String -Pattern "subscribeMessage|订阅消息|wx\.requestSubscribeMessage"` 扫 `services/api/src` 与 `miniprogram` ⇒ 无匹配行。

**差额**

无条文差额。一处边界：A1 的「未读计数可复核」只证到「单条已读 ⇒ 该账号未读数归零且 revision 推进」；本页没有构造「跨多资源累计未读」的读数，也没有核对客户端消息页红点与 `unread-count` 的一致性（该页在五 Tab 走查里只截了静态形态）。

### 3.4 #18 GY-I18 独立后台资料、账号、AI 任务及功能开关（已满足）

**验收原文**

> - [ ] 普通账号不能管理或绕过硬规则，变更来源会重新校验和失效相关引用
> - [ ] 全局开关真实生效，下架缓存和详情同步
> - [ ] 不将基础账号管理说成人工评审已完成
> - [ ] 列表、详情、收藏历史和消息均在读取时重查对象权限及当前可见性；隐藏／失效／注销不因缓存或旧链接重新公开

**实物**

- 资料域真库落点（这条正是 `gy-r34-closure-matrix-20261024.md` 记的「纯代码缺口」，现已在 main）：`services/api/src/admin/ops/content-pg.ts` 文件头自述四族资料来源（`sources`／`knowledge`／`registrations`／`restrictions`）原先「全在进程内 `Map`（`admin/store.ts`，自述 `persistent: false`），所以 `real` 模式下这些路由只能整体 fail-closed 返回 503」，本文件把它们落到迁移 `0036_r34_admin_content_persistence.sql` 的三张表。装配在 `services/api/src/app.ts`：`createPostgresAdminContentStore({ pool })` 与 `const adminContentWired = adminContentStore.persistent === true;`。
- 变更来源即重校验／即失效：`tests/unit/admin-reference-invalidity.test.mjs` 的用例名逐字含「引用同一来源的三类依赖在来源下架后同时失效（读取时重算，不是清缓存动作）」「改版即失效」「发布门槛：引用已下架来源的依赖发布 ⇒ 422 SOURCE_CONFLICT，且不部分发布、留 denied 审计」「读取时重查权限：别的后台主体读同一 id ⇒ NOT_FOUND（与不存在同形）」。这钉住 A154 与 A157。
- 全局开关真实生效：`tests/unit/admin-flag-gate.test.mjs` 20 条，用例名逐字含「B2. 已配置「关」⇒ 409 OBJECT_UNAVAILABLE（确定关闭，retryable 必须为 false）」「C. 关闭 ⇒ 被包装的产出方一次都不会被调用」「F. submissions_enabled 关闭 ⇒ createPost / 拒绝且一条内容都没落库」「E7. 关闭 submissions_enabled ⇒ POST /posts 与评论被拒且零落库」「E6. armed:false（real 未接线）⇒ 不判开关，如实声明」。开关存储的真库实现在 `services/api/src/admin/ops/flags-pg.ts`；`app.ts` 在 `real` 且无真库时**不静默退回内存**，而是 `adminContentWired` 为假继续 fail-closed。
- 人审空入口不是口号，是可执行断言：`services/api/src/admin/human-review.ts` 导出 `HUMAN_REVIEW_COLLECTIONS = Object.freeze(['tasks','reviewers','votes','expert_certifications'])`，`createHumanReviewDirectory()` 回来 `wired: false`、四个集合恒为空冻结数组，`assertNoReviewClaim(surface: string): never` 抛 `ApiError('OBJECT_UNAVAILABLE', ...)`，details 逐字带 `{ field: 'human_review', code: 'NOT_WIRED' }`。`tests/unit/admin-ui-review-state.test.mjs` 的用例名逐字含「待审计数是结构性零」「routes 目录里没有 review 路由」「humanReviewQueue 的 items 恒为空数组（不是“还没加载”）」「人审目录快照冻结且 wired 为 false」。这钉住 A156。
- AI 任务与作业台：`services/api/src/admin/ops/jobs-pg.ts` 的真库端口，`app.ts` 里 `createPostgresAdminJobPort({ pool })`；`tests/unit/admin-jobs-list-filter.test.mjs` 与 `admin-ops-operations.test.mjs` 的用例名逐字含「作业端口未接线时：读与写都 fail-closed，绝不伪造作业状态」「社区存储未接线时：hidePost fail-closed（503），不谎报成功」。

**我实际怎么验的**

```
node --test tests/unit/admin-flag-gate.test.mjs
           tests/unit/admin-reference-invalidity.test.mjs
           tests/unit/admin-ui-review-state.test.mjs
  ⇒ tests 35 / pass 35 / fail 0 / duration_ms 1976.75

node --test tests/unit/admin-content-lifecycle.test.mjs
           tests/unit/admin-jobs-list-filter.test.mjs
           tests/unit/admin-ops-operations.test.mjs
  ⇒ tests 41 / pass 41 / fail 0 / duration_ms 1596.10
```

再用一次 grep 核装配：`services/api/src/app.ts` 里 `createPostgresAdminContentStore`、`createPostgresAdminJobPort`、`adminContentWired`、`persistent === true` 都在装配路径上，且注释逐字写明 `real` 无池时不放行。

**差额**

无条文差额。两处边界：

1. 库内审计仍是内存：「`appendAudit` 仍落内存 ops store（`persistent: false`）」是 `services/api/src/app.ts` 自己的注释原文（标注为「库内审计**未取得**」）。这不在 #18 的三条 `[验收]` 里（A154 的「留责任人和范围」由内容修订行与 actor 字段兑现），但审查者若把「关键修改留责任人」读成「审计必须落库」，就会在这里判缺口。
2. 上述两组读数都是内存 store 上的单测；`tests/integration/admin-flags-pg.mjs`、`admin-jobs-pg.mjs`、`admin-content-pg.mjs`、`admin-community-posts-pg.mjs` 四个真库臂**本页未跑**（需要 PostgreSQL，见末节）。#18 的「真库下开关仍生效」这一层，本页只有装配代码与文件名，没有读数。

### 3.5 #28 GY-I26 五 Tab 骨架、Demo 样式及统一失败态（部分满足，差额可在仓内补）

**验收原文**

> - [ ] 微信工具可编译并导航五Tab；未登录入口控制、静态地区不假发预警、人审空入口和模拟标记均正确
> - [ ] Demo普通使用走查主要文字与按钮可见、可点、无遮挡，关键状态可用文字表达；适老放大字体和专用布局后续，不将暂缓记为通过，不将可点原型算实时识别／ASR／AI社区完成
> - [ ] GY-I13继续完成TTS和播放生命周期，本任务不重复验收语音服务准确率

**实物**

- A1 的编译与导航：`docs/verification/gy-i26-five-tabs-20261103.md`（commit `98a86248`）记微信开发者工具 CLI 走查：基础库 `SDKVersion 3.17.3`、`platform: devtools`、视口 376×742，五 Tab 5/5 命中，截图 8 张与 `i26-tabs-observations.json` 落在 `docs/verification/assets/gy-i26-five-tabs-20261103/`。
- A1 的未登录入口控制：同页读数「游客点社区落 `pages/login/login`，真实点击「微信登录」后落 `pages/community/community`」。
- A1 的模拟标记：同页记消息页有横幅「替身服务数据，仅供联调，不代表真实消息投递」；社区／首页预览／我的投稿三处统一失败态。
- A1 的人审空入口：用户端是静态说明块（`gy-r31-i26-recon-20261022.md` 记 `community.wxml` 的人工审核块是「纯静态说明 + `pill--gray`「建设中」」）；后台侧由 §3.4 的 `services/api/src/admin/human-review.ts` 与 7 条 review-state 用例兑现——走查页 §5 自陈「人审空入口（后台侧，本页未取证）」，但那一半在仓内另有实物。
- A2 的状态文字化：`miniprogram/utils/states.js` 的 `CODE_KIND`／`KIND_LABEL`／`KIND_RETRYABLE`／`statusForCode()`／`isMockMode()`／`resolve()`，覆盖 24 个契约码 + 2 个客户端自造码，收口页为 `docs/verification/gy-i28-unified-states-20261021.md`。

**我实际怎么验的**

本页读了 `gy-i26-five-tabs-20261103.md` 全文（73 行）与 `gy-i28-demo-parity-20261018.md` 的口径段，并跑了后台侧那一半的用例（含在 §3.4 的 35/35 里）：`test('humanReviewQueue 的 items 恒为空数组（不是“还没加载”）'`、`test('routes 目录里没有 review 路由'` 均 pass。

**差额**

两条，都能在仓内补，不需要外部条件：

1. **A2「Demo 普通使用走查主要文字与按钮可见、可点、无遮挡」没有当次记录。** `node tools/demo-align.mjs` 只做 CSS 令牌与类名层面的核对，`gy-i28-demo-parity-20261018.md` §7 自述「未做截图比对」「视觉走查只在 CSS 令牌与类名层面被门禁核对」。补法：用同一套 devtools 流水走一遍 `docs/ui-demo/demo.html` 的主路径并留截图，或明确只承认令牌级核对、把条文降到「状态可用文字表达」这一半。
2. **A1「静态地区不假发预警」只验到一种情形。** 走查页只有「地区未设置时不编造预警」；「已设地区也不产生真实地区预警」的完整口径它自己 §5 列为未覆盖。补法：地区数据落地后补一条「有地区 + 无真实预警数据 ⇒ 不出预警」的读数。

另有一条不是本项缺口但会被引用的边界：A1 的「微信工具可编译」是 `platform: devtools` 的模拟器读数，不是真机；真机与正式 AppID 归 #27。

## 4 不建议现在关的项及理由

- **#21 持续评估（未满足）**：只有门槛表与阈值说明，没有任何一份逐类运行报告。A192 要求「真实调用有证据，报告样本数、版本、覆盖和实际失败」——这一条今天连一份都拿不出，不是差口径。
- **#24 部署（未满足）**：`gy-r31-i24-release-20261022.md` 自述「真实 CVM／云托管的发版仍未执行」。门禁脚本、材料索引、恢复演练脚本都在，但 A224「首版必交 AC 均有对应证据」与 A225「联网真实识别／ASR／问答可用」都需要一次真实部署，仓内无法补。
- **#19 注销 7 日／30 日（部分）**：在线 7 日与备份 30 日需要真实时间流逝与真实备份介质。`gy-r34-i19-deletion-closure-20261023.md` 自己写着「不是关闭依据，也不产生关闭结论」。
- **#20 冻结样本（部分）**：只有拍草 172 条 `test` 分割；标签、AI 文字／图片、普通话 50 段、TTS 30 段、问答 120 题这几类仍是 0。A182「冻结清单、来源、划分与评估口径先经监工审查」也未取得审查记录。
- **#23 真机与时延容量（部分）**：`gy-i23-latency-capacity-local-20261020.md` 的边界段逐字写「没有真机、没有 ≥20Mbps／RTT≤100ms 公网链路、没有真实供应商调用、没有独立压测机 ⇒ 不构成 #23 任何条款的达标判定」。
- **#22 失败回归（部分）**：249 条矩阵与 27 条负控制是仓内实物，但 A201「未解决严重安全／权限缺陷 0」需要一次带真机的端到端回归，而该页自述「实测只有两处」。
- **#28 五 Tab（部分）**：不是不能关，是**先补 §3.5 的两条读数**再关——否则 A2 那一半只能靠令牌级核对硬撑。
- 其余 AI／供应商项（#9、#10、#11、#12、#13、#14、#27）理由同构，不逐条重复：`real` 分支一律无替身回退、未配置即 503，这是**对的**设计，也正因此仓内拿不到真实调用读数。

## 5 只有用户或外部条件能推进的项

- **#29 的最后一格（第三方删除「完成」态）**：写侧已接通——`services/api/src/privacy/third-party-deletion-dispatch.ts` 是 `subscribeThirdPartyDeletion()` 的唯一调用点，`evidence_ref` 为空不许写 `confirmed`（库层 CHECK `third_party_confirmed_evidence`），终态不回退。但生产今天零写零外发，因为 `ThirdPartyDeletionRecipientSource` 只有声明、没有实现被装配——同文件的 `export interface ThirdPartyDeletionRecipientSource {` 就是那份声明，注释逐字写「本接口只声明形状，装配层不传 ⇒ `RECIPIENTS_UNWIRED`」，实现只有测试替身；未注入时只发一条 `third_party_deletion_dispatch_unwired`，`reason: 'RECIPIENTS_UNWIRED'`。也就是说「完成」这个状态在仓内任何可装配的形态下都不可达。这条差额只能由「谁是真的接收方、谁签 `evidence_ref`」这个产品口径推进，属用户裁定；issue 自己也把 7／30 日完整集成留给 #19。
- **#4、#5、#6、#23 的真机读数**：需要 Android／iOS 真机与正式 AppID，仓内与被测环境都给不出。
- **#9、#10、#11、#12、#13、#14、#27 的真实供应商调用**：需要开通额度与凭据，且 `provider-adapter-live-wiring.md` 明写该文件「不构成任何真实调用授权」。
- **#7 的排序口径、#22 的矩阵范围、#28 的「骨架是否算验收」**：需要一次用户裁定，不是补代码。
- **#24 的部署**：`[范围]` 明写「部署以已审版本和单独明确授权执行」，仓内连一次都不该自行发起。

## 6 本页未核实的点

1. **四个后台真库臂未跑**：`tests/integration/admin-flags-pg.mjs`、`admin-jobs-pg.mjs`、`admin-content-pg.mjs`、`admin-community-posts-pg.mjs`（需 PostgreSQL）。#18 的「真库下开关生效、资料域真读写」本页只有装配代码与文件名。
2. **收藏／历史真库臂未跑**：`tests/integration/favorites-history-pg.mjs`（68KB）。§3.2 的隔离读数来自内存 store + 回环 HTTP，脚本自己末行就写着 `no PG`。
3. **第三方删除真库臂未跑**：`tests/integration/third-party-deletion-pg.mjs` 与 `third-party-deletion-sql-pg.mjs`。§3 与 §5 里关于 #29 的结论只用了单测臂（50/50 与 15/15）与写侧页的自述。
4. **撤回与任务竞争的 PG 臂未跑**：`tests/integration/egress-revoke-race-pg.mjs`。本页跑的是 `tests/unit/gy-i22-consent-withdrawal-inflight-http.test.mjs` 与 `deletion-receipt-third-party-parity.test.mjs`（15/15）。
5. **未跑构建与类型检查**：本页没有跑 `npm run build`、`npx tsc -p services/api --noEmit`。上游 `gy-r73-third-party-deletion-write-20261103.md` 记过 `tsc` exit 0，本页未复跑。
6. **未跑 failmatrix 全量**：`tests/unit/gy-i22-failmatrix.test.mjs` 的 249 条与 `tests/failmatrix/mutations.mjs` 的 27 条负控制本页未执行，总表里 #22 那一行标 † 即此意。
7. **总表 18 行标 † 的依据未逐条重跑**：这些行的「依据」引自既有取证页的自述，页名已给；本页只对 #8、#16、#17、#18、#28 做了实跑并写了节。
8. **未重新拉 issue 状态**：本页没有跑 `gh issue list`，「24 张仍 OPEN」沿用取样口径；若期间有关闭或新增，总表的行数需要重取。
9. **未复核 #17 的跳转范围裁定**：`gy-r31-closure-matrix-20261024.md` 记「跳转范围（现仅 post/comment，其余 14 型降级）需用户裁定」，本页没有读 `gy-r31-i17-g2-ruling-20261022.md`，故 §3.3 不对跳转覆盖度下结论。
10. **五 Tab 走查的截图未逐张复看**：本页只读了走查页正文与观测 json 的描述，没有打开 `docs/verification/assets/gy-i26-five-tabs-20261103/` 下的 8 张截图。
11. **Demo 遮挡走查未执行**：§3.5 差额第 1 条的补法本页没有做（不做 devtools 实操，只登记缺口）。
