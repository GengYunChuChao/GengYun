# GY-I03 公开标签来源核验（2026-10-11）

本轮交付 **24 个独立登记号的官方标签正文阅读索引，其中 20 个为首版作物文字候选、4 个仅作边界例**。它们不是 20 份已验收的完整现行标签。完整原件/图示、登记有效期、禁限用、条件审核和许可仍缺，已审核可用用量卡仍为 **0**；#3、#20 保持未完成。

基线：main `d8588e0d666e2a8cba4f270800f73c79bd9d1542`；独立资料分支 `feature/gy-i03-public-source-audit-20261011`。仅增加本页及[隔离研究索引](gy-i03-public-label-index-20261011.json)，不改业务代码、契约、迁移、种子、来源有效状态或任务分配。关联 F02/F03/F14/F20、AC02/AC12/AC22；仅交资料查核组件，`Refs #3`。

## 1 先复核已合入成果

已读取需求、开发指南、阶段/顺序、#3 和 #20 全部现有评论及开放 PR。#3 的 #44、#51–#55 资料目录/暂存/读取/来源生命周期/交接组件不重复实现，#20 的 #47 评估框架不重复开发。远端不存在本轮同范围标签审计 PR，其他登录、页面、查询取证、AI 判定分支不修改。

| 已有内容 | 本轮核对结果 | 本轮变化 |
| --- | --- | --- |
| [作物目录](../../packages/knowledge/catalog/crops.json) | 水稻、玉米、大豆、油菜 4 个规范对象 | 无 |
| [杂草目录](../../packages/knowledge/catalog/species.json) | 稗草、狗尾草、荨麻类、马唐、牛筋草、看麦娘、藜、空心莲子草 8 组；并非已有科普或评估标注 | 无 |
| [原 20 登记记录](../../packages/knowledge/herbicides/records-2026.json) | 来自公告附表，仍 partial；不是完整核准标签 | 原记录不替换、不升为有效 |
| [原覆盖报告](../../packages/knowledge/coverage-report.json) | 原记录的用量/施用/注意/有效期/禁限字段仍未交接；DoseCard 0 | 不改历史报告，用本页记录新研究 |
| #20 真实独立样本 | 既有监工评论记录实际样本 0；本轮不采集真人或私人原始媒体 | 不拿网页、模型输出或合成媒体充样本 |

## 2 来源读取与证据边界

先逐一打开原 20 个登记号的 ICAMA 标签地址，只有 **PD20211636** 取得正文，其余 **19** 本次不可访问/抓取失败。登记号、失败清单在 JSON 中逐一记录。失败不证明无标签或失效，不用经销商副本补成已核准原件。

随后从该官方门户公开检索补充候选，并实际打开、阅读其正文。24 条均读到身份、含量剂型、作物/场所及对象/用量/方式表格、技术要求、性能、注意、急救、储运、质量保证期、核准/重新核准日期等文字章节；本索引只保存少量事实元数据和自行撰写的核验备注，不转载用量或整篇标签。重新核准日期显示斜杠时写 `null`，不推断日期。

**读取方式是浏览检索工具的网页正文展示，可能是搜索服务缓存。** 网页“已读”不代表读取时源站实时返回 200，也不能据此证明当天最新版本。本机标准库直接访问 PD20161371、PD20181483 均返回 HTTP 403，没有绕过访问控制。PD20050008 有搜索结果，但实际打开未取得正文，故未纳入 24 条。

除 PD20151189 显示毒性文字外，其余 23 个页面的毒性标识为图片，本轮没有读取图像内容。未取得完整标签原始文件/包装图、未留源站字节快照及其哈希；JSON 的 `official_source_content_hash=null`，不能用本地索引哈希冒充官方原文哈希。

[官方门户的《农药标签和说明书管理办法》公开页面](https://www.icama.cn/portal/homepage/getpitai.do?id=2c9280e5601cdd1e01601cfc1ddd008f&type=2)也已阅读全文，可用于核查标签章节和核准信息位置。本轮不出具现行法规完整性或许可结论；页面公开、站点版权声明及正文可读均不证明获得全文展示、再分发或训练授权。许可统一为尚未建立/`licensed=false`。

## 3 已读正文清单

以下日期只记录页面所示重新核准日期（没有时为“/”）；不是登记有效期。每个链接对应一个登记号，同药名/成分/含量也不合并。首版作物“候选”仅表示适用表出现该作物，不代表浙江、具体品种/生育期/栽培模式审核已通过。

| 登记号与官方正文 | 药名／剂型／含量身份摘要 | 首版作物表出现的场景 | 重核日期 |
| --- | --- | --- | --- |
| [PD20211636](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20211636) | 乙·嗪·滴辛酯／乳油／82% | 春大豆、春玉米（原20记录之一） | 2024-09-29 |
| [PD20080626](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20080626) | 苄嘧磺隆／可湿性粉剂／30% | 水稻移栽田 | 2020-06-18 |
| [PD20151189](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20151189) | 2甲4氯二甲胺盐／水剂／以2甲4氯计62% | 水稻移栽田 | / |
| [PD20183937](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20183937) | 2甲·灭草松／可溶液剂／460克/升 | 水稻直播田，叙述与表格范围待核 | / |
| [PD20250140](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20250140) | 丙草·丙噁·松／乳油／48% | 水稻移栽田 | / |
| [PD20210496](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20210496) | 敌稗／乳油／34% | 水稻直播田 | / |
| [PD20086306](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20086306) | 苄嘧·丙草胺／可湿性粉剂／25% | 水稻直播田 | / |
| [PD20173018](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20173018) | 唑嘧磺草胺／水分散粒剂／80% | 大豆、玉米 | 2025-09-01 |
| [PD20172613](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20172613) | 辛·烟·莠去津／可分散油悬浮剂／38% | 玉米 | / |
| [PD20081734](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20081734) | 乙草胺／乳油／900克/升 | 冬油菜、春/夏大豆、春/夏玉米 | 2019-12-27 |
| [PD20082322](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20082322) | 精异丙甲草胺／乳油／960克/升 | 冬油菜、春/夏大豆、春/夏玉米 | 2026-04-17 |
| [PD20201114](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20201114) | 乙·嗪·滴辛酯／乳油／82% | 春大豆 | / |
| [PD20210507](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20210507) | 乙·嗪·滴辛酯／乳油／82% | 春大豆、春玉米 | 2026-07-29 |
| [PD20141898](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20141898) | 精异丙甲草胺／乳油／960克/升 | 冬油菜、夏玉米，表格没有大豆 | 2024-06-11 |
| [PD20081680](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20081680) | 精喹禾灵／乳油／5% | 春/夏大豆、油菜 | / |
| [PD20100133](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20100133) | 烯草酮／乳油／120克/升 | 油菜 | / |
| [PD20171896](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20171896) | 烯草酮／乳油／240克/升 | 春油菜 | / |
| [PD20140297](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20140297) | 硝磺草酮／悬浮剂／15% | 玉米 | / |
| [PD20083717](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20083717) | 草除灵／悬浮剂／30% | 冬油菜 | / |
| [PD20211623](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20211623) | 灭草松钠盐／可溶液剂／以灭草松计480克/升 | 大豆、水稻移栽田 | / |

另外四条是明确不计入上述 20 候选的边界例：

| 登记号与官方正文 | 本轮排除/隔离理由 |
| --- | --- |
| [PD20181483](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20181483) | 非耕地，不推广到田埂/农林场所；在浙江的持有人不能证明适用于项目作物 |
| [PD20084065](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20084065) | 适用表有项目作物，但技术要求将春/夏玉米限于北方；免耕油菜/晚稻还需模式核对，本轮不计候选 |
| [PD20101587](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20101587) | 玉米用途为指定耐受转化体；项目未确认相应品种，不泛化普通玉米 |
| [PD20140879](https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20140879) | 玉米/大豆用途为指定耐受转化体；其他场景为首版范围外果园，不泛化普通玉米/大豆 |

## 4 已发现的接入风险

- **制剂身份不按模糊药名合并。** 三个 82% 乙·嗪·滴辛酯登记号的持有人/适用作物/重核日期不同；两个 960克/升精异丙甲草胺的适用表也不同。PD20141898 没有大豆，不能继承 PD20082322 的大豆用途。核验入口见上表相应原文。
- **表格、叙述冲突不静默补全。** PD20183937 表格为直播稻，技术/性能文本提及移栽稻，应保留冲突待专业复核，不把叙述扩大成登记条件。
- **粗粒度作物ID不足。** PD20172613 涉玉米类型限制；PD20083717 涉油菜类型；PD20084065 涉地区和免耕。用户只选“玉米/浙江”仍不能产生匹配用量卡；不能省略阶段、播栽方式、品种、环境/邻作等条件。
- **毒性图片和版本未交接。** 不能由有效成分推测成品毒性；核准/重新核准日期、质量保证期均不是登记有效期。页面最近被抓取也不是最新核准保证。
- **俗名不能补精确物种条件。** PD20211623 的性能文字提“莲子草”，不能直接匹配空心莲子草；“一年生杂草”也不能自动声明荨麻类全部可防除。8组对象的权威命名核验、浙江分布及逐对象科普仍缺。
- **旧急救/混配措辞隔离。** 标签网页中的急救、配合使用叙述只是待审核资料，不因本次研究直接成为面向用户的医疗建议、生成混配或处方。

这些是读取后的研发风险标注，未形成登记适用或安全承诺，不能替代专业审核。

## 5 从研究候选到受控资料的剩余门槛

本索引位于 `docs/research/`，使用独立 `gengyun.research.*` schema，现有 `build_seeds.py`/生产资料目录不读取它。`audit_version` 只是本轮索引版本，不填生产 `source_version`；元数据更新不能自动发布资料。

后续按[开发指南](../development-guide.md)及既有来源生命周期组件处理：取得可留存的完整原件/图示与明确权限 → 记录真实内容哈希和官方版本证据 → 核对有效期/最新禁限用/登记制剂/完整条件/原文单位 → 列冲突与不足 → 专业/资料审核 → 经已审发布流程产生来源版本，并使列表/详情及用量依据引用同一版本。缺任一步保留 unknown/unverified/card_ready=false。撤回、失效及冲突仍走既有生命周期，不用研究日期当 valid_from。

| 交接缺口 | 当前实际数/状态 | 下一次所需最小资料 |
| --- | --- | --- |
| 原20记录的标签正文 | 1/20 已读、19 本轮未取得 | 官方导出/合法可留存原件，优先原19登记号；正文地址失败不自行替换登记号 |
| 20份完整现行核准标签 | 0/20 完整交付并审核 | 完整原文及图示、登记详情有效期与当日状态、版本/哈希、许可及审核 |
| 替代候选 | 20 个正文元数据候选已列 | 如需改变原20制剂范围，单独核验和审查，不能静默替换既有记录 |
| 全国/浙江禁限用和条件 | 未完整逐条审核 | 当前官方限制公告、具体制剂/地区/播栽/品种/生育期核对结果 |
| 8组杂草科普与命名 | 对象编号已有，逐对象内容及权威核验未交付 | 权威植物资料正文、学名/属级差异、浙江覆盖及引用许可 |
| 真实独立图片/语音/答案 | 本轮新增 0 | 合法采集的独立实拍/录音，按 #20 既有隔离、去重、冻结规约交接 |

本轮公开资料研究完成，不需购买接口、访问私人原稿或部署。无需立即向用户索要全部原件；候选和缺口可先供后续资料协作者继续核验，但 #3 和 #20 不关闭。

## 6 验证记录

纯资料文档，无运行接口/数据库/小程序改动。实际检查：

- JSON UTF-8可解析；登记号唯一、24/20/4计数与正文表一致；原20记录读取/失败集合恰好覆盖现有清单。
- 核准日期有效、重新核准日期空值真实保留；候选作物只沿用既有4作物类别，不增加杂草范围。
- 24条链接与已读登记号逐一对应；对浏览抓取失败、直接HTTP403、搜索摘要和缓存正文作不同标识，不宣称全部源站实时可达。
- 研究索引与现有种子/契约隔离、资料未提升；文档本地链接、任务依赖/映射校验与 `git diff --check`。

未验证：完整原件/图像/真实源站快照、最新登记/禁限用、专业审核、许可、数据库导入及真实模型样本。无业务构建/真机/付费验证，文档合入不代替上述验收。监工须独立抽查固定提交 SHA 的来源/字段与边界后决定是否合入。
