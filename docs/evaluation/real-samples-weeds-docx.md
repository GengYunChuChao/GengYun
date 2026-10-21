# GY-I20 真实样本：杂草图片 Word 文档（拍草域）

- **任务**：GY-I20（GitHub issue **#20**）—— 冻结独立评估样本、标准答案及评估程序；本轮**用真实样本填充缺口**
- **日期**：2026-10-14
- **分支**：`feat/gy-i20-real-samples`（基线 `upstream/main`）
- **承接**：PR #47（已合并）已交付索引 schema／近重复与隔离规则／冻结与覆盖绑定／评分规约／缺口报告；
  本轮**复用**这些入口，只新增真实样本登记物、抽取与冻结工具、真实数据回归与文档，**未改** `packages/contracts/**`、未改 PR #47 的既有实现。
- **执行模式**：全部离线。**未发起任何付费或真实模型调用**（未授权），因此本文件**不含任何模型成绩**。

## 1 来源与使用规则

| 项 | 值 |
| --- | --- |
| 来源文件 | 仓库外私有 Word 文档（本文件记为"来源文档"，不记真实路径） |
| 大小 | 136 173 583 字节（约 129.9 MiB） |
| `sha256` | `624ee4d5285410e1a9ccc0910e41f52873894079617064e7e49611e9ead7a3b8` |
| 结构 | docx（zip）：`word/document.xml` 为文本（279 245 字符 / 690 段），`word/media/imageN.png` 为图片（172 张，非隔行 8 位 RGBA） |
| 编排 | 每条目 = **物种名段 + 形态特征段 + 一张配图**；共 172 条 |
| 使用规则 | 原始 Office 文件与原始媒体**一律不入库**；仓内只放可审查的派生数据（标签/清单/hash）；路径映射留在仓库外 |

来源文档是"按物种名 + 形态特征 + 配图"编排的杂草识别资料合集。本轮只把它的**文字**（物种名、形态特征）
用作标注依据，把它的**图片**用作评估样本本体（留在仓库外）；不复制其版式、不对外分发媒体。

## 2 抽取与登记方法（可复算）

工具：`tools/evaluation/extract-docx-weed-samples.mjs`（Node 标准库，零第三方依赖：自带最小 ZIP 读取器与 PNG 解码器）。

```powershell
node tools/evaluation/extract-docx-weed-samples.mjs `
  --docx <仓外>\杂草图片版.docx --out-dir <仓外>\extracted\media `
  --path-map <仓外>\extracted\path-map.json `
  --labels packages/evaluation/samples/gy-i20-weeds-labels.json `
  --index  packages/evaluation/samples/gy-i20-weeds-real-index.json `
  --report <仓外>\extracted\extraction-report.json --emit-perceptual-hash
```

工具行为：解 zip → 逐段解析 `document.xml`（图片段回溯最近两段非空文本作为"物种名 + 形态特征"）→
写出媒体到**仓外**目录 → 计算 `sha256`、PNG 尺寸与 64 位 dHash → 用 `--labels` 答案键做**交叉核对**
（条目数必须相等、条目名必须逐字一致，否则报错退出）→ 产出脱敏索引、仓外路径映射与仓外诊断报告。

**原始输出**（实测，逐字）：

```
docx=杂草图片版.docx sha256=624ee4d5285410e1a9ccc0910e41f52873894079617064e7e49611e9ead7a3b8
文档条目=172  抽取图片=172  原始媒体字节=136087244
去重：distinct contentSha256=172  重复内容组=0  重复条数=0
dHash 近重复对（汉明≤8）=0
按覆盖：covered=7  out_of_coverage=165
覆盖内（严格同名）=7；若并入同属近缘种=20（近缘种 13 条未计入）
覆盖内逐类计数={"species_barnyardgrass":1,"species_crabgrass":1,"species_foxtail":1,"species_goosegrass":1,"species_shortawn_foxtail":1,"species_lambsquarters":1,"species_alligatorweed":1}
覆盖外类别数=165（逐条=ext_weed_<条目号>）
dHash 互异=172/172  两两最小汉明距离=14  近重复对(汉明≤8)=0
图像非退化诊断：灰度标准差 min=21.72 max=74.81；std<5 的空白/纯色图=0 张
```

> 图像非退化诊断是**客观代理**（灰度标准差接近 0 = 空白/纯色图），只说明 172 张图片都含实际像素内容；
> 本轮执行环境**不具备图像输入能力，未做人工目视核对**，因此不对画面内容（是否确为该物种、是否清晰）作任何断言。

端到端索引校验（复用 PR #47 的校验器）：

```
样本索引：packages/evaluation/samples/gy-i20-weeds-real-index.json
总记录=172  按任务={"weed_photo":172}
按划分={"test":172}  按来源={"real_collected":172}
校验结果：通过（无错误）
```

**幂等性**：连续两次抽取产出的索引文件逐字节相同
（提交 blob（LF 行尾）`sha256(gy-i20-weeds-real-index.json)=236408ed20ac7781b9d7154083ee746c9426f1a5f9e6e449267a3cdbb7c39db0`，两次一致；
该值随检出时的行尾转换而变，**冻结判定不依赖它**——冻结用的是记录的规范化 `indexSha256`）。

## 3 样本计数（按类／按覆盖／独立对象）

| 指标 | 实测 |
| --- | --- |
| 条目 / 图片 | 172 / 172 |
| `contentSha256` 互异 | 172（无字节级重复，`duplicatesExcluded=0`） |
| dHash 互异 | 172；两两汉明距离**最小 14**；阈值 8 下近重复对 0 |
| 图像非退化（灰度标准差） | 最小 21.72／最大 74.81；`std<5`（空白/纯色）**0 张** |
| 覆盖内 | **7** |
| 覆盖外 | **165** |
| 独立对象数 | 172 |
| 短边尺寸 | 最小 317 px／中位 540 px／最大 697 px（159 张短边 <640 px） |
| `quality` 字段 | 全部 `clear`（见 §9 的口径说明：**未做人工质量分级**，低质量桶按 0 计） |

覆盖内逐类（`labelClass` = `catalog/species.json` 的规范物种 ID）：

| 规范物种 ID | 覆盖组名 | 样本数 | 第6.1节每类门槛 | 缺口 |
| --- | --- | --- | --- | --- |
| `species_barnyardgrass` | 稗草 | 1 | ≥30 | 29 |
| `species_foxtail` | 狗尾草 | 1 | ≥30 | 29 |
| `species_nettle_group` | 荨麻类 | **0** | ≥30 | 30 |
| `species_crabgrass` | 马唐 | 1 | ≥30 | 29 |
| `species_goosegrass` | 牛筋草 | 1 | ≥30 | 29 |
| `species_shortawn_foxtail` | 看麦娘 | 1 | ≥30 | 29 |
| `species_lambsquarters` | 藜 | 1 | ≥30 | 29 |
| `species_alligatorweed` | 空心莲子草 | 1 | ≥30 | 29 |

覆盖外 165 条为目录外杂草对象，逐条给稳定标识 `ext_weed_<条目号>`（**不是**规范物种 ID），
原文档名记在 `gold.externalLabel`，例如 `ext_weed_006` = 千金子、`ext_weed_043` = 香附子（莎草）、
`ext_weed_172` = 杂草稻（野稻）。

## 4 独立标准答案

答案键：`packages/evaluation/samples/gy-i20-weeds-labels.json`
（`version=gy-i20-weeds-labels-2026.10.14`，绑定来源文档 `sha256`，172 条 entry）。

每条包含：`docxName`（来源条目名）、`labelClass`、`coverage`、`mappingKind`、
`criteria`（**判据要点** = 来源文档该条目的形态特征原文）、`criteriaSource`（指向来源条目号）、
可选 `nearGroups`（近缘/易混淆诊断）。

判据要点样例（逐字取自来源文档）：

| 条目 | 物种名 | 判据要点（形态特征原文，节选） |
| --- | --- | --- |
| 001 | 稗（稗草） | 与水稻最易混淆，区别在于：稗草无叶耳叶舌、叶片较宽软、基部常带紫红色、根系无沼泽通气组织；水稻有叶耳叶舌、叶片直立、有明显中脉。稗草根系较浅、易整株拔起，水稻根系深扎不易拔出。 |
| 008 | 马唐 | 幼苗第一片真叶带紫红色是田间最快识别特征；成株总状花序3～8枚呈指状辐射排列；茎基部节上生根、倾卧地面、易整株拔起；叶片较软、无叶耳。 |
| 018 | 看麦娘 | 圆锥花序紧缩呈圆柱状、柔软下垂如「毛笔头」；植株细软、基部丛生；与日本看麦娘的区别…… |
| 062 | 藜（灰菜） | 叶片表面常有白色粉状物（幼嫩部分尤明显）；叶缘有不规则波状锯齿、叶形变化大…… |
| 150 | 空心莲子草（水花生、喜旱莲子草） | 水生型茎漂浮水面、中空；陆生型茎匍匐地面、节上生根；叶片对生、长椭圆形、全缘…… |

**核实状态（必须如实标注）**：`annotation.method=reliable_label`、`annotatorRef=docx_weeds_v1_source_label`、
`modelGenerated=false`，**无 `reviewedBy`** —— 即
1. 未与权威植物志／分类库逐条核对；
2. 未由第二人独立复标；
3. 未确认来源文档的原始出处与许可（许可调查按用户要求暂缓）。
因此本批答案只能算"来源文档自带标签 + 判据留痕"，**不主张已独立核实**。

> **`annotatorRef` 的三处写法与推导规则（不是三种口径）**：答案键文件头 `gy-i20-weeds-labels.json`
> 的 `annotation.annotatorRef` 是**来源级**标识 `docx_weeds_v1`（"这批答案来自哪份来源文档"）；
> 索引逐条的 `annotation.annotatorRef` 是**条目级**标识，按固定规则派生为
> `${答案键来源级 annotatorRef}_source_label`（即 `docx_weeds_v1_source_label`，"这一条取自该来源文档的原文标签"）；
> 本页写的也是条目级标识。三处因此只有**一个**来源级标识 + **一条**派生规则，
> 由 `tests/evaluation/gy-i20-frozen-integrity.test.mjs` 逐条断言
> `index[*].annotation.annotatorRef === labels.annotation.annotatorRef + '_source_label'`——
> 任何人把其中一处改成第三种写法，测试立即红（不允许"谁改谁知道"）。

## 5 覆盖口径与映射规则（明确、可复算）

- **覆盖内判定**：文档条目名（含括号内别名）与 `packages/knowledge/catalog/species.json` 的
  `group_name` / `canonical_name` / `aliases` **精确同名**。命中 7 条：
  稗（稗草）／马唐／狗尾草／牛筋草／看麦娘／藜（灰菜）／空心莲子草（水花生、喜旱莲子草）。
- **荨麻类无任何条目** → `species_nettle_group` 到位 0，逐类缺口按未满足计（程序口径：缺覆盖清单或某类为 0 即不可推断达标）。
- **覆盖外**：其余 165 条一律 `out_of_coverage`，`gold.speciesId=null` + `gold.externalLabel` 保留原名。
- **同属近缘种只登记不计数**：13 条近缘种（无芒稗/西来稗/旱稗/光头稗/长芒稗→稗属；升马唐/毛马唐/止血马唐→马唐属；
  金色狗尾草/大狗尾草→狗尾草属；日本看麦娘→看麦娘属；小藜/灰绿藜→藜属）写入 `nearGroups`，
  **不改变覆盖口径**。若按"属级组"口径并入，覆盖内为 7+13=20（§3 输出中的"若并入同属近缘种=20"）——
  两种口径**同时给出**，但冻结清单与缺口一律按**严格同名**的 7 条计，以免抬高覆盖内数量。
- **范围绑定**：`weedPhotoCoveredClasses` 取 GY-I03 承诺范围（`packages/knowledge/coverage-report.json#species_groups.required`
  的 8 个中文展示名）经 `catalog/species.json` 的 `group_name ↔ id` 映射后的 8 个规范 ID，
  映射依据（`catalog_version=gy-i03-species-2026.10`、目录 `sha256=38fd2b6c8dea46da…`）记入报告
  `coverageBinding.scopeBasis`，并由 `tools/evaluation/knowledge-scope.mjs` 在评估时复核"承诺类未越界"。

## 6 冻结清单与复算

冻结清单：`packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json`
（`indexVersion=gy-i20-weeds-real-2026.10.14`、`split=test`、`recordCount=172`、
`frozenAt=2026-10-14T12:05:00+08:00`，内嵌 `coverage` 绑定块）。

复算命令与输出（`--verify` 模式，任一项不符即退出码 1）：

```
$ node tools/evaluation/freeze-real-samples.mjs \
    --index packages/evaluation/samples/gy-i20-weeds-real-index.json \
    --coverage packages/evaluation/samples/gy-i20-weeds-coverage-manifest.json \
    --index-version gy-i20-weeds-real-2026.10.14 \
    --verify packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json

索引总记录=172  split=test 记录=172
indexSha256(规范化 test 集)=36053ceed50abbeb43edbab891fef910763bf0442ac8b2d8e2f26adcd598c78f
coverageSha256(承诺覆盖类)=325fae943924a6aefd762ddcbe479b095733340283b83cabc89a75578b2787cc  承诺类数=8
复算核对 packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json：冻结=通过（无差异）
覆盖绑定：通过（无差异）
冻结清单自身 sha256=88b668e00c7b47ab6c39fa17bfe3729db2c723cb90c60d983d70e0cbe4120cb3
```

| 摘要 | 值 |
| --- | --- |
| 索引总记录 / test 记录 | 172 / 172 |
| `indexSha256`（规范化 test 集） | `36053ceed50abbeb43edbab891fef910763bf0442ac8b2d8e2f26adcd598c78f` |
| `coverageSha256` | `325fae943924a6aefd762ddcbe479b095733340283b83cabc89a75578b2787cc` |
| 冻结清单自身 sha256 | `88b668e00c7b47ab6c39fa17bfe3729db2c723cb90c60d983d70e0cbe4120cb3` |
| 索引文件 sha256（提交 blob，LF） | `236408ed20ac7781b9d7154083ee746c9426f1a5f9e6e449267a3cdbb7c39db0` |

**冻结语义边界**：本冻结只保证"评估输入不再变动、覆盖绑定不可事后缩减"。
它**不**证明样本量达标、不证明标签已核实、也不证明这批素材与任何模型训练集隔离。

## 7 接入既有评估程序（PR #47 入口，离线可跑）

```powershell
node tools/evaluation/run-evaluation.mjs `
  --index packages/evaluation/samples/gy-i20-weeds-real-index.json `
  --predictions packages/evaluation/samples/gy-i20-weeds-predictions-none.json `
  --manifest packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json `
  --coverage packages/evaluation/samples/gy-i20-weeds-coverage-manifest.json `
  --out <仓外>\eval-report-weeds.json
```

实测输出（关键行，逐字）：

```
dataKind=real_frozen  isRealEvaluation=false  frozenVerified=true  frozenIndexVersion=gy-i20-weeds-real-2026.10.14
indexSha256=36053ceed50abbeb…  testIndexSha256=36053ceed50abbeb…  predictionSha256=4f53cda18c2baa0c…
划分：train=0  validation=0  test=172（最终验收仅用 test）
独立对象去重排除=0  覆盖清单=有  覆盖绑定=通过
    范围口径依据=GY-I03#species_groups  catalog=packages/knowledge/catalog/species.json@gy-i03-species-2026.10
    sha256=38fd2b6c8dea46da…  映射组=["稗草","狗尾草","荨麻类","马唐","牛筋草","看麦娘","藜","空心莲子草"]
预测完整性：期望=172 有效=0 缺失=172 非法=0 多余=0 complete=false
- weed_photo: 172 样本 / 可评分 0  gateStatus=not_evaluated
    top1=—  top3=—
- label_ocr: 0 样本（未评估）    - registration_match: 0 样本（未评估）
- ai_moderation: 0 样本（未评估） - tts: 0 样本（未评估）
- asr: 0 样本（未评估）          - qa: 0 样本（未评估）
样本缺口桶：16/17 未达标
    [缺293] weed_photo_covered (需300, 有7)
    [缺30] weed_photo_covered_per_class (需30, 有0)
    [缺100] weed_photo_low_quality (需100, 有0)
    [缺200] label_ocr_clear (需200, 有0)          [缺20] label_ocr_distinct_records (需20, 有0)
    [缺100] label_ocr_low_quality (需100, 有0)    [缺100] registration_match (需100, 有0)
    [缺200] ai_moderation_risk (需200, 有0)       [缺200] ai_moderation_normal (需200, 有0)
    [缺30] tts (需30, 有0)                        [缺50] asr_utterances (需50, 有0)
    [缺10] asr_speakers (需10, 有0)               [缺60] qa_answerable (需60, 有0)
    [缺20] qa_insufficient (需20, 有0)            [缺20] qa_dangerous (需20, 有0)
    [缺20] qa_injection (需20, 有0)
! 真实样本数量未达第6节标准，评估未完成，不得标记达标。
! 预测不完整：缺失 172 条，非法/失败 0 条；相关任务保持 not_evaluated。
! 存在未满足的可主张条件（缺口/预测完整性/数据性质），门禁保持 not_evaluated。
```

读法（**不可误读为成绩**）：
- `frozenVerified=true`、`coverageBinding.verified=true` ⇒ 冻结与覆盖绑定这两道程序门槛**这次真的通过**；
- `isRealEvaluation=false` ⇒ 因为预测缺失 + 样本量未达标，**没有任何可主张的真实评估**；
- `top1=—`、`gateStatus=not_evaluated` ⇒ 拍草四项门禁**未测**，不是"未通过"也不是"通过"。

## 8 对照第6.1节门槛（如实计数）

| 缺口桶 | 第6.1节要求 | 本轮实际到位 | 缺口 | 说明 |
| --- | --- | --- | --- | --- |
| 覆盖内拍草 | ≥300 张独立清晰照片 | 7 | 293 | 且**每类仅 1 张**、**非手机实拍、无多角度/背景** |
| 覆盖内逐类 | 每个承诺覆盖杂草 ≥30 | 0（最小值口径） | 30 | `species_nettle_group` 为 0，逐类按未满足计 |
| 覆盖外与低质量（覆盖外） | ≥100 张未覆盖对象/作物/非植物 | 165 | 0 | 程序桶已满足；但来源形态为**文档配图**而非手机实拍，是否计入由验收方裁定，本文件**不据此主张达标** |
| 覆盖外与低质量（低质量） | ≥100 张模糊/遮挡/过暗/目标过小 | 0 | 100 | **未做人工质量分级**，见 §9 |
| 标签 OCR（清晰/低质量/独立记录） | 200 / 100 / ≥20 记录 | 0 / 0 / 0 | 全部 | 本次未提供标签素材 |
| 登记匹配 | ≥100 组标准场景 | 0 | 100 | 未提供 |
| AI 社区筛查（风险/正常） | 200 / 200 | 0 / 0 | 全部 | 未提供 |
| 普通话 TTS | ≥30 段 | 0 | 30 | 未提供 |
| 普通话 ASR | ≥50 段、≥10 说话者 | 0 / 0 | 全部 | 未提供 |
| 大模型资料问答 | 60 可答 + 20 不足 + 20 危险 + 20 注入 | 0 | 全部 | 未提供 |

## 9 未取得 / 未验证项

1. **真实模型实测：未做（未授权付费调用）**。无任何模型/规则版本的 Top1/Top3、覆盖率、CER、召回率等成绩；
   `gy-i20-weeds-predictions-none.json` 刻意留空，`isRealEvaluation=false`。
2. **质量分级：未做人工目视分级**。索引 `quality` 字段一律 `clear`，
   含义仅为"未登记为低质量"，**不构成"已确认清晰"**；因此低质量桶按 0 计、覆盖内 300 张口径中的"清晰"未被人工确认。
   本轮只做了客观非退化诊断（灰度标准差最小 21.72、无空白/纯色图），**未核对画面内容是否确为该物种**。
3. **独立核实：未发生**（无 `reviewedBy`）；未与权威植物志/分类库核对，未第二人复标。
4. **来源形态**：非手机实拍、无不同角度/背景、每类仅 1 张；不满足第6.1节"含实际手机照片及不同角度／背景"。
   （第6.1节把"覆盖内 300 张清晰照片"与覆盖外/低质量组分开；覆盖外组未明文要求手机实拍，
   但本批同为文档配图，故一并列为形态风险而不主张达标。）
5. **Android/iOS 真机检查：未做**（第6.2节风险提示/页面耗时等需真机与联网环境；本次无设备与真机证据）。
6. **许可与出处：未核实**（许可调查按用户要求暂缓）。
7. **训练/测试隔离：仅有仓库内证据**（无重复内容、dHash 无近重复、同簇不跨 split），
   **无法证明**该素材未进入任何模型的训练集。

## 10 剩余风险

| 风险 | 影响 | 建议处置 |
| --- | --- | --- |
| 素材可能已被某模型训练使用 | 若成立，则这批样本**不能**作为独立测试集，指标会虚高 | 评估前向材料提供方确认训练用途；否则另采独立素材 |
| 标签未经独立核实 | 标准答案可能含来源文档自身错误 | 由植物分类专业人员抽检/复标并写入 `reviewedBy` |
| `quality` 未人工分级 | 覆盖内"清晰照片"口径未落实 | 人工目视分级后再计低质量/清晰桶 |
| 覆盖内每类样本 1 张 | 逐类 Top1 区间极宽，无统计意义 | 每类补至 ≥30 张后方可报告逐类指标 |
| 覆盖绑定依据是 GY-I03 资料范围 | 若模型侧覆盖承诺与资料范围不同，覆盖内/外分组需重做 | 模型侧覆盖承诺冻结后重新生成并**作为新冻结版本** |
| 同属近缘种映射为写手判读 | 严格同名口径可能低估覆盖内数量（也避免虚高） | 由分类专业人员裁定是否按属级组并入，并新冻结版本 |

## 11 本轮文件清单

| 文件 | 类型 | 内容 |
| --- | --- | --- |
| `packages/evaluation/samples/gy-i20-weeds-real-index.json` | 新增 | 172 条真实拍草样本索引（`split=test`、脱敏、含 hash/dHash/尺寸/答案引用） |
| `packages/evaluation/samples/gy-i20-weeds-labels.json` | 新增 | 独立标准答案键（172 条：标签 + 覆盖分组 + 判据要点 + 来源绑定） |
| `packages/evaluation/samples/gy-i20-weeds-coverage-manifest.json` | 新增 | 承诺覆盖类清单（8 个规范物种 ID + 依据） |
| `packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json` | 新增 | 冻结清单（含内嵌覆盖绑定块） |
| `packages/evaluation/samples/gy-i20-weeds-predictions-none.json` | 新增 | 空预测占位（无模型输出 → 门禁 `not_evaluated`） |
| `packages/evaluation/samples/README.md` | 新增 | 样本目录说明、规模、复算命令与"不主张"清单 |
| `tools/evaluation/extract-docx-weed-samples.mjs` | 新增 | 抽取/登记工具（零依赖 ZIP+PNG 解码、答案键交叉核对、诊断报告） |
| `tools/evaluation/freeze-real-samples.mjs` | 新增 | 冻结清单生成与复算核对（`--out` / `--verify`） |
| `tests/evaluation/gy-i20-real-samples.test.mjs` | 新增 | 真实数据回归 11 例（含 3 例负控制：改样本/删样本/缩覆盖必须被拒） |
| `docs/evaluation/real-samples-weeds-docx.md` | 新增 | 本文件 |
| `docs/evaluation/sample-gap-register.md` | 更新 | 用真实计数替换"尚未交接"的 0 值（结构不变） |
| `docs/evaluation/README.md` | 更新 | 交付状态表与命令一览补真实样本入口 |
| `docs/verification/gy-i20-real-samples-20261014.md` | 新增 | 证据页（命令与原始输出） |
