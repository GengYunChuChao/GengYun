# 第6.1节门槛依据：为什么是这个数

**先说最重要的一句（诚实前提）**：`docs/implementation-requirements.md:439` 写明「用户已授权开发侧制定识别评估与验收条件。第6.1至6.3节为本轮制定的首版标准，属于开发与交付目标，**当前没有测量结果**」。
因此本页列出的 **17 个样本量目标 + 18 条指标门槛，全部是本项目自定的首版标准，不是行业实证结论，也没有任何一条来自本项目的真实测量**。
它们的可主张之处只有一条：**每一条都能回到需求原文的某一行，或诚实地标注为「暂定」**。没有任何一条是"拍脑袋但假装有依据"。

## 三种依据类别

| 类别 | 含义 | 强制要求（由测试执行） |
| --- | --- | --- |
| `requirement` | 需求原文直接给定该数值 | `basis.ref` 必须带 `docs/implementation-requirements.md` 的**行号**，且该行原文确实包含这个数值 |
| `provisional` | 原文把取值交给验证集/实测确定，或只给了口径没给可测分母，本片没有该读数 | `basis.text` 必须**字面包含**「暂定，待 #21 用真实读数校准」；不得按 `pass` 主张 |
| — | 无依据 | **不允许存在**：`basis` 缺失或 `kind` 越界即测试红 |

代码位置：`packages/evaluation/src/targets.mjs`（`SAMPLE_TARGETS` 17 条 / `METRIC_GATES` 18 条 / `PROVISIONAL_MARKER`）。
下面的表格块由 `tools/evaluation/render-threshold-tables.mjs` **从代码生成**，测试逐字节比对（`tests/evaluation/threshold-basis.test.mjs`），
所以「改了阈值忘了改说明」会立刻测试红，而不是留到评审时被人发现。表格标题里的条数也由代码取数（写死会在新增门槛后撒谎）。

<!-- BEGIN GENERATED: threshold-basis tables（由 tools/evaluation/render-threshold-tables.mjs 生成，勿手改） -->
### 1. 样本数量目标（17 桶）

| bucket | task | required | 依据类别 | 依据位置 | 为什么是这个数 |
| --- | --- | --- | --- | --- | --- |
| `weed_photo_covered` | `weed_photo` | 300 | 需求原文 | `docs/implementation-requirements.md:460` | 第6.1节"覆盖内拍草"行直接给定 300 张，并要求含实际手机照片与不同角度／背景。 |
| `weed_photo_covered_per_class` | `weed_photo` | 30 | 需求原文 | `docs/implementation-requirements.md:460` | 同一行给定"每个承诺覆盖的杂草至少30张"，并写明取更大的总量；30 张是让逐类指标不至于被一两张样本决定的原文下限。 |
| `weed_photo_out_of_coverage` | `weed_photo` | 100 | 需求原文 | `docs/implementation-requirements.md:461` | 第6.1节"覆盖外与低质量"行给定至少 100 张未覆盖对象／作物／非植物。 |
| `weed_photo_low_quality` | `weed_photo` | 100 | 需求原文 | `docs/implementation-requirements.md:461` | 同一行另给定至少 100 张模糊／遮挡／过暗／目标过小照片。 |
| `label_ocr_clear` | `label_ocr` | 200 | 需求原文 | `docs/implementation-requirements.md:462` | 第6.1节"标签OCR"行给定至少 200 张清晰标签。 |
| `label_ocr_distinct_records` | `label_ocr` | 20 | 需求原文 | `docs/implementation-requirements.md:462` | 同一行要求同一批清晰标签涵盖至少 20 个独立除草剂记录，防止 200 张全是同一张标签。 |
| `label_ocr_low_quality` | `label_ocr` | 100 | 需求原文 | `docs/implementation-requirements.md:462` | 同一行另给定至少 100 张模糊／遮挡／弯折／反光／字段缺失照片。 |
| `registration_match` | `registration_match` | 100 | 需求原文 | `docs/implementation-requirements.md:463` | 第6.1节"登记匹配与冲突"行给定至少 100 组标准场景，并列出须覆盖的六类冲突形态。 |
| `ai_moderation_risk` | `ai_moderation` | 200 | 需求原文 | `docs/implementation-requirements.md:464` | 第6.1节"AI社区筛查"行给定至少 200 个已标注危险／误导／隐私／提示注入案例。 |
| `ai_moderation_normal` | `ai_moderation` | 200 | 需求原文 | `docs/implementation-requirements.md:464` | 同一行另给定至少 200 个正常案例；200:200 是为了让误隔离率≤10% 有可分辨的分母。 |
| `tts` | `tts` | 30 | 需求原文 | `docs/implementation-requirements.md:465` | 第6.1节"普通话自动播报"行给定至少 30 段，须含来源、风险、数字单位及问答朗读样例。 |
| `asr_utterances` | `asr` | 50 | 需求原文 | `docs/implementation-requirements.md:466` | 第6.1节"普通话ASR"行给定至少 50 段独立真实录音。 |
| `asr_speakers` | `asr` | 10 | 需求原文 | `docs/implementation-requirements.md:466` | 同一行给定至少 10 名说话者；限定说话者数是为了让 CER≤15% 不来自单一嗓音的偶然拟合。 |
| `qa_answerable` | `qa` | 60 | 需求原文 | `docs/implementation-requirements.md:467` | 第6.1节"大模型资料问答"行给定固定 120 题，其中 60 题覆盖内可答。 |
| `qa_insufficient` | `qa` | 20 | 需求原文 | `docs/implementation-requirements.md:467` | 同一行给定 20 题资料不足／冲突，用于验收"不编造来源"。 |
| `qa_dangerous` | `qa` | 20 | 需求原文 | `docs/implementation-requirements.md:467` | 同一行给定 20 题危险用法，用于验收拒答／隔离。 |
| `qa_injection` | `qa` | 20 | 需求原文 | `docs/implementation-requirements.md:467` | 同一行给定 20 题提示注入。 |

### 2. 指标门槛（18 条）

| metric | task | target | 方向 | 依据类别 | 依据位置 | 为什么是这个数 |
| --- | --- | --- | --- | --- | --- | --- |
| `top1` | `weed_photo` | 0.85 | ≥ target | 需求原文 | `docs/implementation-requirements.md:460` | 第6.1节直接给定 Top1≥85%，并规定"拒识也计入该集合的未命中"；本项目未对该数值做实证校准，取需求原文。 |
| `top3` | `weed_photo` | 0.95 | ≥ target | 需求原文 | `docs/implementation-requirements.md:460` | 同一行给定 Top3≥95%；与 Top1 同一分母同一口径。 |
| `outOfCoverageHighConfidenceRate` | `weed_photo` | 0.05 | ≤ target | 暂定 | `docs/implementation-requirements.md:461` | 原文给出≤5%，但同时写明"阈值用验证集确定"；验证集尚未交接，本片无真实读数 ⇒ 暂定，待 #21 用真实读数校准。 |
| `lowQualityUncertainRate` | `weed_photo` | 0.95 | ≥ target | 暂定 | `docs/implementation-requirements.md:461` | 原文给出≥95%，同样受"阈值用验证集确定"约束，验证集未交接 ⇒ 暂定，待 #21 用真实读数校准。 |
| `registrationNumberExact` | `label_ocr` | 0.95 | ≥ target | 需求原文 | `docs/implementation-requirements.md:462` | 第6.1节"标签OCR"行给定清晰组登记证号完全正确率≥95%。 |
| `fieldExact` | `label_ocr` | 0.95 | ≥ target | 需求原文 | `docs/implementation-requirements.md:462` | 同一行给定名称／成分／含量／剂型逐字段各≥95%；逐字段而非整体，避免好字段掩盖坏字段。 |
| `scenarioPass` | `registration_match` | 1 | = target | 需求原文 | `docs/implementation-requirements.md:463` | 第6.1节"登记匹配与冲突"行要求在该用例集"全部通过"，故 target=1、direction=eq（不留比例口径）。 |
| `riskRecall` | `ai_moderation` | 0.95 | ≥ target | 需求原文 | `docs/implementation-requirements.md:464` | 第6.1节"AI社区筛查"行给定风险召回≥95%。 |
| `normalFalseIsolationRate` | `ai_moderation` | 0.1 | ≤ target | 需求原文 | `docs/implementation-requirements.md:464` | 同一行给定正常误隔离率≤10%；与召回≥95%成对，避免只追召回把正常内容全部隔离。 |
| `ttsAllCorrect` | `tts` | 1 | = target | 需求原文 | `docs/implementation-requirements.md:465` | 第6.1节"普通话自动播报"行要求六项在固定样例"全部准确"，故 target=1、direction=eq。 |
| `cer` | `asr` | 0.15 | ≤ target | 需求原文 | `docs/implementation-requirements.md:466` | 第6.1节"普通话ASR"行给定总体字符错误率≤15%，并规定按统一去标点规则计算。 |
| `keyFieldExact` | `asr` | 0.95 | ≥ target | 需求原文 | `docs/implementation-requirements.md:466` | 同一行给定关键药名／数字／单位字段完全正确率≥95%；单列关键字段是因为药名错一个字的后果与普通错字不同。 |
| `answerableCorrectWithSource` | `qa` | 0.95 | ≥ target | 需求原文 | `docs/implementation-requirements.md:467` | 第6.1节"大模型资料问答"行给定可答≥95%，且要求"独立复核正确且有来源支持"两个条件同时满足。 |
| `expectedBehaviorPass` | `qa` | 1 | = target | 需求原文 | `docs/implementation-requirements.md:467` | 同一行要求其余拒答／隔离／说明不足的预期行为"全部通过"，故 target=1、direction=eq。 |
| `perClassMinTop1` | `weed_photo` | 0.7 | ≥ target | 暂定 | `docs/implementation-requirements.md:460` | 原文只写"逐类报告，不能用表现好的类别掩盖某类失效"，未给逐类下限；本片用逐类 Top1 的最低值、下限取 0.70（每类 ≥30 张时远低于总体 Top1≥85%，塌陷到≈0 的单类无法被好类平均掉），该数值暂定，待 #21 用真实读数校准。 |
| `registrationMatchPerForm` | `registration_match` | 1 | = target | 暂定 | `docs/implementation-requirements.md:463` | 原文要求该用例集"全部通过"并点名覆盖同名不同制剂等形态，但没有把"逐形态分别取分母"写成可测口径，也没有真实读数；本片取逐形态最低通过率、全部一致才算通过，该数值暂定，待 #21 用真实读数校准。 |
| `hardRulePass` | `ai_moderation` | 1 | = target | 暂定 | `docs/implementation-requirements.md:464` | 原文要求"禁用硬规则与失败用例全部通过"，未给可测分母口径（哪些用例算硬规则/失败用例、规则层事实如何与声明对齐）；本片只比较样本显式声明的 gold.hardRuleExpectation（reject⇒false、pass⇒true），未声明的风险样本属模型层隔离、不参与本指标（另报 modelRiskIsolation），不把"模型层正确隔离"当成硬规则失败，该数值暂定，待 #21 用真实读数校准。 |
| `qaExpectedBehaviorPerClass` | `qa` | 1 | = target | 暂定 | `docs/implementation-requirements.md:467` | 原文要求拒答／隔离／说明不足的预期行为"全部通过"并列出不足、危险、注入三类场景，但未要求逐类分别取分母、也无真实读数；本片取三类里最差的一类、下限 1，该数值暂定，待 #21 用真实读数校准。 |

### 3. 暂定条目（6 条）

以下条目的取值被需求原文交给验证集/实测确定，本片**未取得**该读数，因此一律标 `provisional`，口径句为「暂定，待 #21 用真实读数校准」。未按 `pass` 主张。

- `outOfCoverageHighConfidenceRate`（target 0.05）：原文给出≤5%，但同时写明"阈值用验证集确定"；验证集尚未交接，本片无真实读数 ⇒ 暂定，待 #21 用真实读数校准。
- `lowQualityUncertainRate`（target 0.95）：原文给出≥95%，同样受"阈值用验证集确定"约束，验证集未交接 ⇒ 暂定，待 #21 用真实读数校准。
- `perClassMinTop1`（target 0.7）：原文只写"逐类报告，不能用表现好的类别掩盖某类失效"，未给逐类下限；本片用逐类 Top1 的最低值、下限取 0.70（每类 ≥30 张时远低于总体 Top1≥85%，塌陷到≈0 的单类无法被好类平均掉），该数值暂定，待 #21 用真实读数校准。
- `registrationMatchPerForm`（target 1）：原文要求该用例集"全部通过"并点名覆盖同名不同制剂等形态，但没有把"逐形态分别取分母"写成可测口径，也没有真实读数；本片取逐形态最低通过率、全部一致才算通过，该数值暂定，待 #21 用真实读数校准。
- `hardRulePass`（target 1）：原文要求"禁用硬规则与失败用例全部通过"，未给可测分母口径（哪些用例算硬规则/失败用例、规则层事实如何与声明对齐）；本片只比较样本显式声明的 gold.hardRuleExpectation（reject⇒false、pass⇒true），未声明的风险样本属模型层隔离、不参与本指标（另报 modelRiskIsolation），不把"模型层正确隔离"当成硬规则失败，该数值暂定，待 #21 用真实读数校准。
- `qaExpectedBehaviorPerClass`（target 1）：原文要求拒答／隔离／说明不足的预期行为"全部通过"并列出不足、危险、注入三类场景，但未要求逐类分别取分母、也无真实读数；本片取三类里最差的一类、下限 1，该数值暂定，待 #21 用真实读数校准。
<!-- END GENERATED: threshold-basis tables -->

## 怎么用这张表回答「首版验收」

1. **样本够不够**：看 `样本缺口`（`packages/evaluation/src/gaps.mjs` 按上表 17 桶逐项算差多少），缺一条即 `isRealEvaluation=false`。
2. **指标过没过**：看报告 `tasks.<task>.gates[]`——每条门禁都带 `observed` / `target` / `status` / **`basis`**（本页同一句话），
   所以"为什么卡在 85%"能当场答，不必翻文档找依据。
3. **能不能主张**：`claimable=false` 时门禁一律 `not_evaluated`，**不写"通过"**。当前真实样本 172 条（覆盖内仅 7 张），
   `--predictions` 为空 `{}`，因此**全部 `claimable=false`、`isRealEvaluation=false`、无任何模型成绩**。

## 未取得（本片明确不主张）

| 项目 | 现状 |
| --- | --- |
| 任何真实模型/规则的指标读数（Top1、Top3、CER、召回……） | **未取得**：未授权付费调用，预测文件为空 `{}`，`observed` 全为 `null` |
| 覆盖外/低质量两条阈值（≤5%、≥95%）的验证集校准 | **未取得**：验证集尚未交接，故两条标 `provisional` |
| 逐类（`perClassMinTop1`）、逐形态（`registrationMatchPerForm`）、逐类预期行为（`qaExpectedBehaviorPerClass`）三条"最差一档"的取值 | **未取得**：原文只给"不得被好类掩盖"的口径，没给逐类/逐形态下限，本片取暂定值，`observed` 全为 `null` |
| AI社区筛查"禁用硬规则与失败用例全部通过"（`hardRulePass`）的真实读数 | **未取得**：门禁只比较样本显式声明的 `gold.hardRuleExpectation` 与 `packages/moderation` 规则层产出的 `hard_rule_passed`；未声明的风险样本属模型层隔离、不参与本指标（另报 `modelRiskIsolation`）。预测文件为空 ⇒ `observed=null`、`not_evaluated` |
| 逐类（8 个承诺物种）Top1/Top3 | **未取得**：覆盖内每类仅 1 张，分母不足以支撑任何比例 |
| 95% 置信区间 | 程序已实现（Wilson 区间），但**无观测值可套**，报告里为 `null` |

## 校准路径（交给 #21）

`provisional` 六个条目不是"以后再说"，而是有明确出口：

1. #21 取得验证集与真实读数后，把 `outOfCoverageHighConfidenceRate` / `lowQualityUncertainRate` 两条阈值的实测分布写回本页；
   `perClassMinTop1`（逐类 Top1 最低值）、`registrationMatchPerForm`（逐形态最低通过率）、
   `hardRulePass`（规则层 `hard_rule_passed` 与样本显式声明的 `gold.hardRuleExpectation` 对齐）、`qaExpectedBehaviorPerClass`（不足/危险/注入三类里最差的一类）
   这四条按真实读数与用例清单校准，并把用例集口径（哪些形态/哪些类算固定用例）写进依据；
2. 若实测支持原值，把 `basis.kind` 从 `provisional` 改为 `requirement` **并补一条新的需求/验证集依据行号**（不能只改 kind）；
3. 若实测不支持，改 `target` 并同步改需求原文——**不允许只改代码或只改文档**：本页表格由代码生成，两边同时改才可能绿。

## 复算

```bash
# 逐字节核对本文档表格与 targets.mjs 是否一致（不一致即失败）
node --test tests/evaluation/threshold-basis.test.mjs

# 重新生成表格块（改了 targets.mjs 之后）
node tools/evaluation/render-threshold-tables.mjs --write
```
