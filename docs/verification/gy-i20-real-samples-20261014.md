# GY-I20（#20）· 真实样本抽取、冻结与离线评估 —— 证据页

- **任务**：GY-I20（GitHub issue **#20**，P0／M1）—— 冻结独立评估样本、标准答案及评估程序（用真实样本填充缺口）
- **本轮交付**：杂草图片 Word 文档 → 172 条真实拍草样本登记、独立标准答案键、承诺覆盖绑定、冻结清单、
  可复算的离线评估输入与输出、真实数据回归（含负控制）
- **日期**：2026-10-14
- **分支**：`feat/gy-i20-real-samples`
- **执行模式**：全部离线。**未发起任何付费调用或真实模型调用**；**未做 Android/iOS 真机检查**
- **复用的既有实现**（PR #47 已合并，未改动）：`packages/evaluation/**`、`tools/evaluation/{lib,knowledge-scope,run-evaluation,validate-evaluation-samples}.mjs`、
  `docs/evaluation/{sample-index-schema,near-duplicate-policy,scoring-spec,sample-gap-register}.md`

## 0 环境

```
$ node -v
v24.16.0
$ npm -v
11.13.0
$ git -C GengYun_W23 log -1 --format='%H %s' upstream/main
1fc0308818b85227078d43b6246d006cb2aead7f feat(GY-I27): 用途授权外发账本、在途守卫与模块删除注册协议（Refs #29） (#128)
```

## 1 抽取与登记（原始输出）

```
$ node tools/evaluation/extract-docx-weed-samples.mjs --docx <仓外>\杂草图片版.docx \
    --out-dir <仓外>\extracted\media --path-map <仓外>\extracted\path-map.json \
    --labels packages/evaluation/samples/gy-i20-weeds-labels.json \
    --index packages/evaluation/samples/gy-i20-weeds-real-index.json \
    --report <仓外>\extracted\extraction-report.json --emit-perceptual-hash

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

抽取器的自校验：来源文档 `sha256` 必须与答案键绑定的 `sourceDocSha256` 一致；
答案键条目数必须等于文档条目数；条目名必须逐字一致——任一不符即报错退出（本次全部通过）。

**幂等复算**（第二次抽取写入同一路径后比较文件摘要；行尾为提交 blob 的 LF）：

```
before=236408ED20AC7781B9D7154083EE746C9426F1A5F9E6E449267A3CDBB7C39DB0
after =236408ED20AC7781B9D7154083EE746C9426F1A5F9E6E449267A3CDBB7C39DB0
identical=True
```

> 该文件级摘要随检出时的行尾转换而变；**冻结判定不依赖它**——冻结用的是记录的规范化 `indexSha256`（下 §3）。

**媒体规模诊断**（仓外报告 `extraction-report.json`，本次实测）：

```
width  min/med/max = 317 / 688 / 1075
height min/med/max = 406 / 608 / 697
shortSide min/med/max = 317 / 540 / 697   (短边 <640: 159 张, <480: 44 张)
bytes  min/med/max = 272843 / 748056 / 1548832
imageSanity: minGrayStd=21.72  maxGrayStd=74.81  degenerateCountStdBelow5=0  grayStdBelow20=0
dHash distanceHistogram = {14:1, 15:1, 16:5, 17:10, 18:11, 19:25, 20:48, 21:97, 22:139, 23:264, 24:391,
  25:556, 26:744, 27:915, 28:1087, 29:1284, 30:1330, 31:1405, 32:1345, 33:1213, 34:1057, 35:845,
  36:652, 37:452, 38:325, 39:209, 40:127, 41:81, 42:47, 43:26, 44:7, 45:3, 46:2, 48:1, 49:1}
```

> 图像非退化诊断是**客观代理**（灰度标准差 ≈0 表示空白/纯色图），只说明 172 张都含实际像素内容；
> 本轮执行环境**无图像输入能力**，未做人工目视核对，因此不核对画面内容是否确为该物种。

## 2 索引合规校验（schema + 硬红线 + 隔离）

```
$ node tools/evaluation/validate-evaluation-samples.mjs --index packages/evaluation/samples/gy-i20-weeds-real-index.json
样本索引：packages/evaluation/samples/gy-i20-weeds-real-index.json
总记录=172  按任务={"weed_photo":172}
按划分={"test":172}  按来源={"real_collected":172}
校验结果：通过（无错误）
exit=0
```

## 3 冻结清单复算核对

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
verifyExit=0
```

## 4 离线评估（接入 PR #47 入口，无模型输出）

```
$ node tools/evaluation/run-evaluation.mjs \
    --index packages/evaluation/samples/gy-i20-weeds-real-index.json \
    --predictions packages/evaluation/samples/gy-i20-weeds-predictions-none.json \
    --manifest packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json \
    --coverage packages/evaluation/samples/gy-i20-weeds-coverage-manifest.json \
    --out <仓外>\eval-report-weeds.json

exit=0
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

报告内关键字段（结构化核对，`<仓外>\eval-report-weeds.json`）：

```
dataKind=real_frozen  isRealEvaluation=false  frozenVerified=true
frozenVerification={"verified":true,"reasons":[],"indexSha256":"36053ceed…c78f","manifestSha256":"88b668e0…0cb3"}
coverageBinding={"verified":true,"reasons":[],"boundClasses":[8 个规范物种 ID],"coverageSha256":"325fae94…87cc",
  "basisRef":"GY-I03#species_groups.required@pkg/knowledge/coverage-report.json",
  "scopeBasis":{"basisRef":"GY-I03#species_groups","catalogRef":"packages/knowledge/catalog/species.json",
    "catalogVersion":"gy-i03-species-2026.10","catalogSha256":"38fd2b6c…c213","sourceGroups":[8 个中文组名]}}
splits={"train":0,"validation":0,"test":172,"total":172}
duplicatesExcluded=0
weed_photo.gates=[top1, top3, outOfCoverageHighConfidenceRate, lowQualityUncertainRate]
  → 每条 observed=null, status="not_evaluated", claimable=false
weed_photo.metrics.top1={"p":null,"low":null,"high":null,"n":0,"successes":0}
weed_photo.metrics.coveredCount=7  outOfCoverageCount=165
```

**判读**：`frozenVerified` 与 `coverageBinding.verified` 为真（冻结与覆盖绑定两道程序门槛通过）；
`isRealEvaluation=false`、`top1.p=null`、门禁 `not_evaluated` —— **没有任何模型成绩**，
"程序可跑"被严格区分于"模型达标"。

## 5 真实数据回归（含负控制）

```
$ node --test tests/evaluation/gy-i20-real-samples.test.mjs
✔ 真实索引：172 条拍草样本通过 schema + 硬红线 + 隔离校验
✔ 真实索引：无原始媒体、无模型自答、ID 与摘要格式合法
✔ 答案键覆盖全部条目，且条目名/来源与索引逐条一致
✔ 覆盖口径：7 条严格同名覆盖内 + 165 条覆盖外；同属近缘种不计入覆盖
✔ 冻结清单可由索引复算：indexSha256/coverageSha256/recordCount 一致（可复算）
✔ 冻结校验与覆盖绑定在真实数据上通过，且落在 GY-I03 承诺范围内
✔ 负控制：改动一条样本内容摘要 → 冻结校验必须失败（冻结集被改动）
✔ 负控制：删除一条样本 → recordCount 与摘要不一致，冻结校验失败
✔ 负控制：缩减承诺覆盖清单 → 覆盖绑定必须拒绝（覆盖清单被缩减）
✔ 真实缺口：覆盖外达标（165≥100），覆盖内每类/总量仍缺；重复排除数为 0
✔ 真实样本 + 空预测的离线评估：isRealEvaluation=false、门禁全 not_evaluated、无任何模型成绩
ℹ tests 11  ℹ pass 11  ℹ fail 0
```

完整评估测试层（含 PR #47 既有 73 例）：

```
$ npm run test:evaluation
ℹ tests 84  ℹ pass 84  ℹ fail 0
```

文档一致性（本轮改了 `docs/evaluation/**`）：

```
$ npm run test:docs
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
```

## 6 未运行的检查（如实标注，不得写成通过）

| 检查 | 状态 | 原因 |
| --- | --- | --- |
| 真实模型/规则实测（Top1/Top3、CER、风险召回、QA、TTS） | **未运行** | 付费调用未授权；无模型输出，预测文件刻意留空 |
| Android / iOS 真机检查（播放、静音、拒权、蓝牙、断网、耗时） | **未运行** | 无设备与联网真实环境；属第6.2节，本轮不涉及 |
| `npm run lint`（tsc + 仓库密钥/ TLS 扫描） | **未运行** | 本轮只新增 JS 工具、JSON 数据与 Markdown 文档，**未改** TypeScript、workspace 依赖或配置；按轻量规范不作为适用项 |
| 人工质量分级 / 低质量桶 | **未运行** | 无人工作业；`quality` 一律 `clear` 仅为"未登记为低质量"，低质量桶按 0 计 |
| 人工目视核对画面内容 | **未运行** | 本轮执行环境不具备图像输入能力（`read_image` 不可用）；只做灰度标准差等客观代理诊断 |
| 独立复核（`reviewedBy`） | **未运行** | 未与权威植物志核对、未第二人复标 |
| 许可/出处核实 | **未运行** | 许可调查按用户要求暂缓 |

## 7 复算清单（评审可直接重跑）

1. `node tools/evaluation/validate-evaluation-samples.mjs --index packages/evaluation/samples/gy-i20-weeds-real-index.json` → 通过（0 错误）
2. `node tools/evaluation/freeze-real-samples.mjs --index … --coverage … --index-version gy-i20-weeds-real-2026.10.14 --verify packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json` → 退出码 0
3. `node tools/evaluation/run-evaluation.mjs --index … --predictions packages/evaluation/samples/gy-i20-weeds-predictions-none.json --manifest … --coverage … --out <仓外>` → `isRealEvaluation=false`
4. `node --test tests/evaluation/gy-i20-real-samples.test.mjs` → 11/11 通过
5. 抽取器需**仓库外**的来源 docx：`sha256=624ee4d5…a3b8`；媒体与路径映射一律写在仓外

## 8 提交 blob 复核（不依赖工作区）

```
$ node -e "git cat-file blob HEAD:<path> 后重算摘要"
committed blob: records=172 test=172 covered=7 out=165
blob indexSha256   =36053ceed50abbeb43edbab891fef910763bf0442ac8b2d8e2f26adcd598c78f  match=true
blob coverageSha256=325fae943924a6aefd762ddcbe479b095733340283b83cabc89a75578b2787cc  match=true
blob manifestSha256=88b668e00c7b47ab6c39fa17bfe3729db2c723cb90c60d983d70e0cbe4120cb3
```

即：**提交进仓库的索引/覆盖 blob 本身**就能复算出冻结清单里的摘要（不依赖本地工作区、不依赖来源 docx）。

## 9 PR 正文（可粘贴）

> ### GY-I20（#20）真实拍草样本冻结 + 离线评估接入（Refs #20，**不关闭整项**）
>
> **做了什么**：把用户提供的仓外私有 Word 文档（杂草图片版，`sha256=624ee4d5…a3b8`）转成**可审查的脱敏登记物**——
> 172 条真实 `weed_photo` 样本索引（`split=test`，只含 `contentSha256`/dHash/尺寸/答案引用）、172 条独立标准答案键
> （物种标签 + 判据要点 + 来源绑定）、8 类承诺覆盖清单（规范物种 ID）与**可复算的冻结清单**；
> 新增零依赖抽取器与冻结复算器、真实数据回归 11 例（含 3 例负控制）。原始媒体与路径映射**一律留在仓库外**。
>
> **实测计数（如实）**：文档 172 条目 / 172 图 / 136 087 244 字节；`contentSha256` 172/172 互异、dHash 两两最小距离 14
> （阈值 8 下近重复对 0）；覆盖内**严格同名 7 条**（7 类各 1，荨麻类 0），覆盖外 165 条；重复排除 0。
>
> **程序结果**：`frozenVerified=true`、`coverageBinding.verified=true`；
> 但 `isRealEvaluation=false`、拍草四项门禁全部 `not_evaluated`、`top1.p=null`、缺口桶 16/17 未达标
> —— **无任何模型成绩**（付费调用未授权，预测文件刻意留空）。
>
> **未取得 / 未验证**：真实模型实测、Android/iOS 真机；人工质量分级与目视核对（执行环境无图像输入能力，只做了客观非退化诊断）；
> 独立复核（无 `reviewedBy`）；许可/出处核实；以及"样本量是否达标"——覆盖内 7/300（每类 0–1/30）、
> 其余六域 0，**未达标，不用合成占位充数**。另如实提示：覆盖外 165 条虽满足程序缺口桶，
> 但来源形态为文档配图而非手机实拍，是否计入由验收方裁定，本 PR 不据此主张达标。
>
> **风险**：无法证明该素材未进入任何模型训练集；来源文档缺手机实拍与多角度/背景；覆盖绑定依据为 GY-I03 资料范围（非模型侧承诺）。
>
> **复算**：`validate-evaluation-samples.mjs`（0 错误）、`freeze-real-samples.mjs --verify`（退出码 0）、
> `run-evaluation.mjs`（`isRealEvaluation=false`）、`node --test tests/evaluation/gy-i20-real-samples.test.mjs`（11/11）。
> 详见 `docs/evaluation/real-samples-weeds-docx.md` 与 `docs/verification/gy-i20-real-samples-20261014.md`。
