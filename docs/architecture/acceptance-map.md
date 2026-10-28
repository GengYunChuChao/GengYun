# 初版契约覆盖与交接

GY-I01 / #1；契约 `1.0.0` 待审。[ADR](adr-001-initial-architecture.md)、[数据字典](data-dictionary.md)、[状态协议](state-contract.md)、[OpenAPI](../../packages/contracts/openapi.json)组成同一提案。

提案修订2对应PR #33旧HEAD的两项P2：F05/F13、AC08/09/16/19的已发布媒体读取与资料关联往返。新增社区上下文授权/二进制取图、Post媒体实际版本/Author头像版本、资料可用/不可用投影；消费者影响见ADR。所有新正反例仍为合成设计断言，不是HTTP服务或真实权限/AI验收。

## F / AC 到模块

下表是设计覆盖，不是运行 AC 通过。GY-I01台账acceptance_ids为空，保持不变；验收实现由对应任务提交真实证据。

| 首版 F | 契约模块 / 关键行为 | 首版 AC | 消费任务 |
| --- | --- | --- | --- |
| F01 | auth/user/admin-session，游客首页、会话与归属 | AC01、AC07、AC09 | GY-I04/18/22 |
| F02 | profile、region/crop字典，不存原坐标 | AC01、AC21 | GY-I03/05/26 |
| F03/F04/F14 | knowledge/herbicides/verify，来源制剂条件、DoseCard确定性渲染 | AC02、AC13、AC14、AC22 | GY-I03/07/08/12 |
| F05/F08 | posts/comments/likes/reports，先审后发、版本重审、独立后台 | AC08、AC16、AC19 | GY-I14/15/18 |
| F12 | transcription确认、checked target TTS、录音/播放生命周期 | AC06、AC07、AC14、AC18、AC28 | GY-I11/13/26 |
| F13 | consent、recipient、export、deletion、归属和恢复 | AC09、AC23首版基础 | GY-I06/19/25/27 |
| F15 | recognition候选与用户选择分开，不确定、真实模式 | AC11 | GY-I09/20/21 |
| F16 | OCR原始/校正、登记精确核对独立状态 | AC12 | GY-I10/20/21 |
| F17首版静态 | 首页/knowledge静态地区信息，不产生预警 | AC15首版部分 | GY-I03/07/26 |
| F18 | favorites/history，失效引用、去重、私有失败记录 | AC17 | GY-I16 |
| F19 | messages事件去重、已读、跳转权限，无外推 | AC18 | GY-I17 |
| F20 | conversations/turns，检索白名单、完整检查、无未审流 | AC29 | GY-I12/20/21 |

F06/07/09/10/11、F08人审、F05专家、F12导航震动、F17真实预警、F19外推仅二月规划；AC03/04/05/10/20/24/25/26/27没有首版接口。AC23训练部分只规定启用前门槛，不实现训练。供应商实测、模型第6节指标、真机和运维不是契约schema验证所能证明。上述缺口都是**当前无实现**，不是"永久禁止"：反向钉子已在 `tests/unit/admin-ui-review-state.test.mjs`、`tests/unit/admin-ops-governance.test.mjs`、`tests/moderation/http-callback.test.mjs` 条件化 —— 将来实现人审/票决面时须**同时**满足：审核/评审路径每条带 `x-scope`、响应 schema 不暴露他人票数、未接线（`wired: false`）时不得出现评审人/投票字段、合同出现票决路径时公开票决仍默认关闭（`publicVotingEnabled() === false`）；专家/认证字段在任何后台响应里仍**永久禁止**。⚠ "条件化"**不等于"实现只差一处"**：P3 落地时仍会变红的反向钉至少 9 处，逐条见文末「反向钉残留清单」。

## 消费者变更与前置

| 任务 | 本提案可提供的输入 | 仍需独立完成的证据 |
| --- | --- | --- |
| GY-I02 | 目录、候选运行栈、OpenAPI、持久约束、统一错误/枚举 | 精确依赖锁/干净安装/API后台构建、微信工具、CI、迁移负例；OpenAPI2020-12与Fastify适配实测 |
| GY-I03 | 数据字典、source_kind/evidence_kind、登记与制剂、条件字段 | 四作物八组物种规范映射、20份真实来源目标及实际数量、规则覆盖和导入适配 |
| GY-I25 | 六类内部适配协议、格式/限额、Recipient配置字段 | AppID/域名/供应商SDK模型实际版本、留存不训练、删除确认、额度和双平台兼容；未验证不得enabled |
| GY-I27 | 用途epoch、recipient绑定、外发账本、回写与删除守卫 | 拒绝/撤回/注销/在途竞态实测；真实媒体外发前必须完成 |
| GY-I26 | HTTP替身形状、mode标记、五Tab、失败/未登录状态 | 原生页面、适老交互、录音播放页面生命周期，不因骨架可点标能力完成 |
| GY-I20/21 | 原始/校正分离、provider/model/prompt/rule版本、目标阈值保持需求 | 独立样本与hash、评分程序和各能力当期真实评估；禁止预设/手改计准确率 |
| GY-I19/24 | 注销即时失效、handler/第三方证据、独立清单与恢复隔离 | 在线7日/备份30日、内容脱敏、第三方失败/确认、真实恢复演练 |

契约经监工确认后下游才按已冻结版本验收；可用提案替身并行写代码，不允许依赖未验收就关闭任务。当前AppID/供应商/数据库/微信工具没有运行证据，依赖保持待验证，不假记资格具备。

## 验证入口

本 PR 在没有应用工程的 main 增加契约和标准库检查；不安装服务端框架、不创建应用完成项。

```powershell
python tools/validate_development_docs.py
python tools/validate_contracts.py
python tools/test_contracts.py
git diff --check
```

第一项检查既有F/AC/Q、27任务依赖无环、Markdown链接/表格。第二项检查OpenAPI内部引用/操作权限/写入幂等/版本/字段约束与示例、状态字典/任务图及嵌套文档链接；第三项使用有意义的负例验证拒绝缺失引用、游客私有访问、缺幂等/版本、语音未确认、模拟来源DoseCard和社区旧审核。完整OpenAPI标准schema验证另用官方JSON Schema / 受控库执行并记录版本，不能把本项目检查器称完整规范validator。

PR记录实际命令、环境、HEAD和CI链接；监工独立验证后决定是否冻结。本聊天只实现和提交，不合并、不批准自己。提案可整体回退；无数据库或上线消费者，当前无数据迁移执行。

## 反向钉残留清单（P3 人审/票决实现时必须同批改）

本片（`test/gy-r64-s3b-pin-conditioning`）只把「绝对禁止人审概念出现」改成「若出现则必须诚实」，
**没有**把 P3 的实现收窄成"只差一处"。下面逐条列出落地 P3 时**仍然会红**的反向钉 —— 至少 9 处，
每一处都在本分支 HEAD 上复现过（不是推测）。⛔ 任何 PR 描述都不许再写"只差一处"或"钉子已全部条件化"。

| # | 位置（用例 · 断言要点） | 它今天钉的是什么 | 为什么 P3 落地必须同批改 |
| --- | --- | --- | --- |
| 1 | `tests/unit/admin-ops-governance.test.mjs` · G6a：对 `HUMAN_REVIEW_COLLECTIONS` 逐个 `deepEqual(state[name], [])` ＋ `Object.isFrozen(...)` | 四个集合**恒空且冻结** | 真实人审目录一多一个集合或任一集合非空即红（实测：给闭集加第 5 个 `review_rounds`，红的是 `state[name]` 那条 ——「review_rounds 必须是空集合 / undefined !== []」）。⚠ 同一用例里的 `deepEqual([...directory.collections], [...HUMAN_REVIEW_COLLECTIONS])` 是**同源自比、恒真**，不构成闸；真正的"闭集字面锚"在 `tests/unit/admin-ui-review-state.test.mjs` 的「四集合名与 human-review.ts 的闭集一致」，同一变异实测红 —— 扩闭集时两处都要改 |
| 2 | `tests/unit/admin-ops-governance.test.mjs` · G6a：`assert.equal(directory.wired, false)` ＋ `state.wired === false` | 运行时人审目录**未接线**（字面 `false`） | 真接线必须把 `human-review.ts` 的 `wired` 翻成真实结果，这条字面钉必须同批翻；它与 G6b「`wired: true` 声明数 = 运行时接线数」是同一处翻转，漏一处就红 |
| 3 | `tests/unit/admin-ops-governance.test.mjs` · G8：`app.humanReviewDirectory.wired === false` ＋ `state().reviewers` 为空 | **HTTP 装配实例**上的同一空态 | 装配真实目录后 `wired`/`reviewers` 都变；G6a 只核工厂，G8 核 app 装饰，两处都要改 |
| 4 | `tests/unit/admin-ui-review-state.test.mjs` · `humanReviewQueue 的 items 恒为空数组`：`assert.match(body, /return \{[^}]*items: \[\]/)` | `nonbypass.ts` **源码文本**里的 `items: []` | 队列返回真实条目就红。它是文本钉：只要文件里还有一处 `items: []` 就绿，**证明不了**"没人往队列里塞东西"，别当行为保证 |
| 5 | `tests/unit/admin-ui-review-state.test.mjs` · `引用的行区间仍包含锚点`：`REVIEW_CODE_ANCHORS` 的 6 条**行区间锚**（人审相关 5 条：`nonbypass.ts` 的 161–168 行须含 `items: []`／`HUMAN_REVIEW_STATE`；`human-review.ts` 的 68–89 行须含 `wired: false`／`tasks: EMPTY`；`human-review.ts` 的 29–34 行须含四集合名；`moderation/types.ts` 的 110–115 行须含 `HUMAN_REVIEW_STATE = 'under_construction'`；`routes/public-home.ts` 的 10–15 行须含 `human_review_state: 'under_construction'`） | **行号区间 + 字面**双重锚（"页面出处"的可核验性） | 实现时字面必然变（队列非空、`wired` 变真接线、`under_construction` 变真实状态），且行号一定漂移 ⇒ 必须同批改锚点并复核。实测：只在 `humanReviewQueue` 上方加一行 `const`，本用例即红（「`nonbypass.ts:161-168` 不再包含 `items: []`」）。⛔ 不许把 `lines` 改小去凑容差（口径见 `AGENTS.md` 的「契约台账锚点维护」） |
| 6 | `tests/unit/admin-ui-review-state.test.mjs` · `人审目录快照冻结且 wired 为 false`：`assert.match(source, /wired: false/)` | `human-review.ts` 源码里出现 `wired: false` | 是**弱钉**（任意一处命中即可，多写一个 `wired: false` 也绿）；`wired` 改由运行时推导时必然要改写法 |
| 7 | `tests/unit/admin-ui-review-state.test.mjs` · `routes 目录里没有 review 路由`：`assert.equal(/human-review\|humanReview\)/.test(routesIndex), false)` | `admin.ts`/`public-home.ts` 里**没有**人审路由引用 | 真接线必然新增路由 ⇒ 红。**审查未列**、本轮复现时补入；它最容易被忽略，因为它钉的是"路由不存在"（实测：在 `routes/admin.ts` 里加一句注释含 `/admin/human-review` 即红） |
| 8 | `tests/unit/admin-ui-review-state.test.mjs` · 页面事实：`REVIEW_COUNT === 0`、`REVIEW_COUNT_BADGE` 含 `wired: false`、`HUMAN_REVIEW_COLLECTIONS_COUNT === 4` | 后台占位页的"结构性零"与标签 | 读面一出现，页面必须改成真实计数与真实标签（改页面＝改这三条，且 `apps/**` 不在 `tests/**` 授权面内，需另派）。实测：`REVIEW_COUNT` 改 1 即红 |
| 9 | `tests/moderation/http-callback.test.mjs` · `AI 不授权限/不改来源/不标专家…`：`queue.items === []`、`human_review_state === 'under_construction'`、`queue.voting === 'disabled'`、`publicVotingEnabled() === false` | 审核入口空态四连 | 真做审核入口/票决面时四条全要改：`items` 非空、状态离开 `under_construction`、`voting` 由开关派生、公开票决打开。实测：把 `human_review_state` 改成 `'ready'` 即红 |

另有两条**本轮新加**、落地 P3 时也会红的闸 —— 它们是**故意的闸**，不属于"残留反向钉"，
而是"实现必须与契约一起翻"的强制联动：

- `tests/unit/admin-ops-governance.test.mjs` · G6b ③：契约里声明 `wired: true` 的响应数必须等于运行时真实接线数（今天两边都是 0，取自 `createHumanReviewDirectory().wired`，不是另一个自声明）。只改契约（自声明）或只改运行时都会红。
- `tests/moderation/http-callback.test.mjs` · 契约全文属性名扫描：`components.schemas` 与所有 operation 响应 schema 的**属性名**不得命中 `/vote/i`（`description`/`title`/`example` 里的自然语言不算）。真做票决字段时必须在同一个 PR 里显式改这条扫描与运行时守卫；⛔ 不许退回"全文禁止 vote 子串"那种会误伤文案的写法。

验证方式（跨平台可复现）：`node --test tests/unit/admin-ops-governance.test.mjs tests/unit/admin-ui-review-state.test.mjs tests/moderation/http-callback.test.mjs` 在 HEAD 上全绿；把上表任一条**单独**改成"已接线"（例如给 `/admin` 响应加 `wired: { const: true }`）即可看到对应用例变红。

## 已知缺口：`referencedetail` 无收藏入口，且随包名录 id 不是 UUID（待裁定）

2026-10-28 登记（Refs #7 #16，对应上表 F18／AC17／GY-I16 那一行）。**本节只登记，不裁定**——选哪条出路要指挥／用户拍。

**现象**：P0 链路第 5 步是「详情 → 收藏」，**入口一共两处**（`docs/ui-state-inventory.md` 第 7.6 节是唯一口径）：`pages/knowledgedetail` 的收藏按钮，与 `pages/favorites` 上半区「可收藏的资料」的逐条「收藏」（两者走同一个 `POST /favorites`）。`pages/knowledge` → `pages/knowledgedetail` 这一路走通；`pages/reference` → `pages/referencedetail` 这一路**没有收藏入口**（该页 `.js` 443 行、`.wxml` 160 行逐字读完，对 `收藏`／`favorite`／`fav` 零命中）。

**为什么"补一个按钮"补不上（**在本数据源下**不可为，不是未接线）**：

1. 该页数据源是**随包离线名录**，记录主键形如 `gy-i03-hb-001`（`miniprogram/data/records-2026.js:34`）；页面的路由判定是 `validId` 为真走服务端、否则走随包副本，随包 id 永远落在后一支：`miniprogram/pages/referencedetail/referencedetail.js:115`。
2. `validId` 就是 UUID 正则，`gy-i03-hb-001` 恒假 ⇒ 这一支永远拿不到服务端实体：`miniprogram/utils/knowledge-api.js:224`。
3. `POST /favorites` 的 `target_ref.revision` 只能取自服务端读面（`GET /knowledge/{id}`，该客户端把响应 `id` 强制 UUID），随包记录既无服务端 `id` 也无 `revision`。
4. 契约 `FavoriteTarget.id` 只约束 1..80 字符串、**不**设 UUID format ⇒ 强行发一条不会被 400 挡住，但 `reference_state` 由服务端按 `/knowledge` 公开读面逐次派生，随包记录在服务端不存在 ⇒ 恒 `unavailable`；收藏页据此不给「查看资料」入口：`miniprogram/pages/favorites/favorites.js:128`。即：加按钮换来的是**一条永远点不开的坏收藏**，比没有入口更糟。

**两条出路（二选一，本片不选）**：

- **(a) 明确不做「从名录详情收藏」**：`referencedetail` 保持无收藏入口，P0 的收藏一律走 `pages/knowledgedetail` 与 `pages/favorites`；口径已按这一支写进 `docs/ui-state-inventory.md` 第 7.6 节，可当裁定引。成本低（只动文档），不动 #7 验收口径。
- **(b) 换数据源**：让除草剂详情读服务端实体（UUID）以保住收藏。代价是要同时改 #7 的「手选条件查询」与「详情」验收口径——`/herbicides` 今天只接受 `q`／`registration_number`（结构化条件不可表达），等于把查询面也翻一遍。成本高，跨片。

**登记口径**：裁定落地前，任何走查脚本、验收记录、状态清单都**不得**把「从除草剂详情收藏」写成已支持或计划支持；`pages/referencedetail` 的界面状态里也不得出现收藏态。本片只改 `docs/**`，不碰 `miniprogram/**`、冻结契约与 #7 的验收文本。

**不裁定时这条验收怎么记账**（给后续评审与走查统一口径，避免各行其是）：

- `F18`／`AC17`／GY-I16 这一行按「**已实现的部分 + 一处待裁定的缺口**」记账：两处入口（`pages/knowledgedetail`、`pages/favorites`）的收藏／取消可以正常验收（201／幂等同 id／428／409／404 各有 e2e 或代码锚）。
- 「从除草剂（随包名录）详情收藏」**既不计入已实现，也不记为缺陷/待修**——它今天既不是"漏接线"，也不是"计划内待做"；在 (a)／(b) 裁定前，它属于**范围未定**。
- 因此：不得因它把 AC17 整条判「不通过」（其余验收项与它无依赖），也不得据此判「已通过」（缺一项就写缺一项）；任何把该项写进验收清单的行都必须带「待裁定」标注。
- 裁定落地后，本节的记账口径随之失效：走 (a) 就把它写成「明确不做」，走 (b) 就按 #7 新口径重新列验收项，两种都要在同一片里改 `docs/ui-state-inventory.md` 第 7.6 节与本节的这一条。

## 待裁定缺口：从 `/herbicides` 的 id 收藏必然 `unavailable`（GY-R68）

**登记日期** 2026-10-28 · **基线** `da61b64d` · **状态**：已复现、已钉负控制，**待指挥/用户裁定**。本片只加证据与登记，**不改业务行为**。

### 现象

`/herbicides` 与 `/knowledge` 是**两套 uuid**，同一条公告记录在两套读面里名字不同，而收藏的「引用可用性」解析只认后一套：

| 环节 | 派生方式 | 位置 |
| --- | --- | --- |
| `/herbicides/{id}` 的 id | `deterministicUuid(record_id)` | `packages/reference/records.mjs`（`toHerbicideContract`） |
| 同一记录在 `/knowledge` 的 id | `deterministicUuid('knowledge:' + record_id)` | `packages/reference/records.mjs`（`toKnowledgeContract`） |
| `/knowledge` 浙江首批投影的 id（第三套） | `deterministicUuid('zhejiang-knowledge:' + item_id)` | `packages/reference/zhejiang.mjs` |
| 收藏可用性解析的**唯一**权威 | 只查 `catalog_read.current_knowledge` + 浙江首批投影 | `services/api/src/app.ts`（`publicKnowledgeRowOf`、`defaultVisibility`）、`services/api/src/knowledge/reference-query.ts`（`toSeedRows`） |

实测（20 条公告记录逐条复算）：两套 id 对**同一条记录**全部不同（0/20 相同），且与浙江首批 159 条 id 集合**交集为 0**；`/herbicides` 的 20 个 id 与 `/knowledge` 读面 159 行的交集同样是 **0**。

⇒ 用 `/herbicides` 列表里的 id 建收藏：**HTTP 201 成功**，但 `reference_state` 恒为 `unavailable`，`unavailable_reason` 落在冻结闭集的对象侧那条（「目标已下架、已失效、已隐藏、已删除或不属于当前账号」）。**这与数据是否核准无关**——`/knowledge` 里 `review_status='unverified'` 的未核准种子行照样判 `available`，差别只在 id 认不认。

今天的**可达性**（如实写清，别夸大）：小程序里**没有**从 `/herbicides` 详情收藏的入口（`miniprogram/pages/referencedetail/` 无收藏按钮），收藏页的「可收藏目标」也来自 `/knowledge` 列表。所以坏收藏目前只能经 API 直接产生；**一旦给该详情页加收藏按钮，用户会立刻遇到**。

### 两条出路（待裁定，本片不选）

| # | 出路 | 代价 / 需要先定的事 |
| --- | --- | --- |
| (a) | 让收藏可用性解析器认 `/herbicides` 的 id（在 `publicKnowledgeRowOf` 之前先按 `packages/reference` 的 `Herbicide` 投影核一次，或把两套 id 统一成一套） | 动**服务端契约面**：`FavoriteTarget.id` 的语义从「`/knowledge` 的 id」扩成「任一读面的 id」。**须先裁定这是否等于「收藏授予可见性」这条红线**——收藏行为本身能不能让一条不在 `/knowledge` 读面里的目标变成「可用/可跳转」。若答案是不能，则只剩"统一 id"（改响应里的 id 值，属破坏性契约变更），不能"两套都认" |
| (b) | 像 `referencedetail` 现在这样**明确不做**：`/herbicides` 详情页**不给收藏入口**，把"不给"写成显式决定而不是遗漏 | 零服务端改动。**用户会看到什么**：`/herbicides` 详情页没有收藏按钮，收藏只能发生在 `/knowledge` 的条目上；从 `/herbicides` 复制 id 直接打 API 仍会得到 201 + `unavailable`（属开发/运维路径，不属用户路径）。代价是"从公告记录本身收藏"这个产品意图被正式放弃，需在需求侧认账 |

### 不裁定的后果

用户从除草剂详情点收藏会得到「**收藏成功但永远不可用**」的坏收藏——比被拒更糟：按钮变「取消收藏」、提示「已收藏该资料。」，用户以为收藏到了；事后在收藏页只看到 pill「不可用」+ 一句刻意不区分原因的非披露文案，既不能跳转也无法自救。裁决前若有人给 `/herbicides` 详情页加收藏按钮，这条坏路径会立刻变成线上体验。

### 本片的钉子（不是修复）

`tests/unit/favorites-herbicide-id-gap.test.mjs` 把上面每一条钉成可复跑的断言：

| 用例 | 钉住的事实 |
| --- | --- |
| R68-0 | 两套 id 的口算：20/20 对同一条记录不同、与浙江首批 159 条 id 交集 0（纯函数，不启服务） |
| R68-① | `/herbicides` 首条 id ⇒ `POST /favorites` **201** + `reference_state='unavailable'` + 理由码在冻结闭集内；同一夹具里 `/knowledge` 读面 159 条非空且与 20 个 herbicide id 交集 0（排除"读面为空"这一平凡解释） |
| R68-② | 两条原因**分开**断言：甲「数据未核准」不导致 unavailable（未核准种子行照样 `available`）；乙「id 不认」——同一条记录换成 `/knowledge` 拼法即 `available`，`/herbicides` 拼法 `unavailable` |
| R68-③ | 负控制：把解析器换成"任何 id 都 available"（经 `buildApp` 的公开注入缝 `favoritesInjection.visibility`，不改生产代码）⇒ ①②的核心断言双双变红 |

⛔ 这些断言刻意钉在**今天的坏行为**上：按出路 (a) 修好后它们**必须变红**，届时同批改断言并把本节状态改成「已裁定/已实现」。另：本片还用一次**临时改动生产默认解析器**（`publicKnowledgeRowOf` 返回 `null` 时改判 `available`）复核了负控制——① 与 ② 变红且红在 `reference_state` 那两条断言上，随后立即复原（blob 指纹前后一致，未入提交）。

## 后台人工审核 ＝ 合法的人工复核路径（`approvePost`，GY-R68 登记）

**登记日期** 2026-10-29 · **状态**：**用户已裁定「这条保留」**。本节的任务是把「`private` 能被直接推成 `published`」这件事从"看起来像后门"改写成**有文档、有审计、有用例钉住**的人工复核路径；**不改业务行为**（`services/**`、契约、迁移、CI 在本片全是零改动）。

### 现象与判据的差别

侦察记的那笔账**成立**：`POST /admin/posts/{id}/approve` 在 real 装配下能把 `private` 直接推成 `published`，全程**不经过** AI 审核端口，与 #14「先审后发」的出发点看似冲突。但"绕过"是一个**结论**，不是一条**事实**——它取决于四个条件是否同时成立。今天这四条都成立，所以它是人工复核；只要有任一条塌掉，它才真的是后门。

### 四个条件（缺一即为后门）

| # | 条件 | 落点与读数 |
| --- | --- | --- |
| 1 | **有人** | 结论行带 `decided_by`，值取自会话里的管理员 id（⛔ 不接受调用方自报）：`services/api/src/admin/ops/community-posts.ts:292`；列定义见迁移 `services/api/db/migrations/0045_community_post_review_actor.sql:61`——`NULL` 是机器结论，非 `NULL` 才是人工结论 |
| 2 | **有 scope** | 路由门是 `requireAdmin` 加 `requireScope`：`services/api/src/routes/admin.ts:569-572`；scope 取 `sources:write`（与 `hidePost` 同门，不新增 scope 值）：`services/api/src/admin/ops/service.ts:429`；没有它即 403 `SCOPE_DENIED`：`services/api/src/admin/identity.ts:69-70` |
| 3 | **有审计** | 结论与帖子行**同一次原子提交**（不是"先发布、再补一条审计"）：`services/api/src/admin/ops/community-posts.ts:351-361` 只调一次 CAS 原语，结论作第 4 个实参交给它；库层在同一事务里写结论行：`services/api/src/community/store-pg.ts:632`，列与覆盖语义见 `services/api/src/community/store-pg.ts:354` 与 `services/api/src/community/store-pg.ts:366` |
| 4 | **有 CAS** | 写之前逐项比对修订号、可见性、审核态，不符即拒：`services/api/src/community/store-pg.ts:470-476`；可见性推进只是这次 CAS 的**新态**之一：`services/api/src/admin/ops/community-posts.ts:327-328`（仅对 `private` 生效，`hidden`／`deleted` 不翻案） |

还容易漏一条：**硬规则层照旧拦得住**。人工放行覆盖的是"引擎没给结论／给了隔离"，不是违禁内容——硬规则否决时 422：`services/api/src/admin/ops/community-posts.ts:318-320`。

### 它与 AI 审核的关系（两个方向都要写清）

- **AI 不通过 ⇒ 人工可以放行。** 这是人工复核**唯一**的正当性来源：引擎给不出结论、或给了隔离时，人可以在 scope 后面重新判断并留下 `decided_by`。入口里**没有** AI 审核端口（适配器只注入社区 store、事件端口与规则层发布门：`services/api/src/admin/ops/community-posts.ts:225-236`），所以"人工放行"从来不是"AI 说通过"——文档与读面都不得把它记成 AI 结论。
- **AI 通过 ⇒ 不免除人工抽检。** 反向不成立。AI 通过只说明规则层/模型层没有否决，**不产生** `decided_by`；一行 `decided_by IS NULL` 是机器结论，不等于"人工已复核"。任何把抽检记成"已被 AI 覆盖"的走查口径都不成立。
- **为什么"通过"必须同时翻可见性。** 待审队列在库里就是 `private` 加 `pending`，而公开读面要求 `published` 且 `approved`，契约里又没有作者自助发布口；只翻审核态会让运营点了通过、帖子永远不可见。故 v1 口径是"通过动作同时承担发布语义"；作者自助发布口属 S4，上线时须重新裁定这一段（口径页见 `docs/architecture/s3-community-review-design.md`）。

### 钉子：三条用例 ＋ 一条负控制

`tests/unit/admin-post-approve-audit-pin.test.mjs`（内存 store 臂；不连真库、不读真实 `.env`、零外呼）：

| 臂 | 做什么 | 期望读数 |
| --- | --- | --- |
| ① 正控制 | `approvePost` 推一条 `private` 加 `pending` 的帖子 | 200、`published` 加 `approved`、修订号 1→2；`community_moderation_decisions` **恰好 1 行**、`decided_by` 是该管理员、`hard_rule_passed=true` |
| ② 负控制 | 把「写 decisions」那一步改成空操作（唯一改动：CAS 的结论实参换成 `null`） | CAS 照跑、帖子**照样** `published`、仍然 200 ⇒ ① 的断言**必须红**，且红在「人工审核必须留痕」这句上 |
| ③ 越权 | 缺 `sources:write`（403）／无会话（401） | 拒绝，且可见性仍是 `private`、结论行 0 行、内存审计 0 条、修订号不动 |

②的两层复核对得上：测试侧的变异落在端口包装上（生产代码零改动）；另用一次**临时改动生产代码**（把 CAS 的第 4 个实参换成 `null`）复核了同一件事——① 变红在「人工审核必须留痕」那一句，而帖子**已经是** `published`。随后立即复原（文件指纹前后一致、未入提交）。这正是本节要证明的：**状态迁移本身不是证据，结论行才是**。

真库臂（PG 的事务边界与逐列读数）不在本文件：`tests/integration/admin-community-posts-pg.mjs` 的审核臂已按 `community_moderation_decisions` 逐列核对同一组事实（含并发两笔只允许一笔 200、另一笔 409）。

### 不得据此放宽的三件事

1. **不得把 `approve` 记成 AI 审核通过**：响应里的 `decision` 是人工结论；"有人做过这件事"的证据只有一条——`decided_by` 非 `NULL`。
2. **不得因为有人工通道就跳过审核门**：`POST /posts` 的发布闸门照旧（硬规则层加审核域）。人工通道是"结论落不下来"时的出口，不是绕过闸门的新入口。
3. **不得把本节当成 #14 的替代**：AI 审核的真实样本覆盖仍按 `docs/evaluation/sample-gap-register.md` 记（风险／正常两格均为 0/200），本节补的是"没人管的那一段"，补不了"审核能力本身"。

