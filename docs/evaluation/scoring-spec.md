# 评分规约（GY-I20）

> 第一真相：`docs/implementation-requirements.md` 第6.1节；范围与样本数量原文：`docs/initial-issues.md` GY-I20。
> 本文定义指标、口径、拒识处理与 95% 置信区间程序；**这不是实测结果**。真实样本未交接前，任何指标都未测量。

## 1 通用原则

- **最终验收只认经冻结清单校验的独立 test 集**：来源标签（`sourceKind`）或手填版本号**不能**代替冻结清单；
  冻结清单须含 `indexVersion`、`split=test`、`recordCount`、`indexSha256`（与 test 集逐字节一致）、`frozenAt`。
- **训练/验证集另列统计**，不进入最终评分；评分与计数**按独立原始对象/近重复簇去重**。
- **标准答案由可靠标注或独立核实产生**；模型预测不能作自己的标准答案（`annotation.modelGenerated=false`）。
- **报告总体与逐类指标及 95% 置信区间**；有限样本不证明现实零风险。
- **未测量不给成绩**：冻结校验未通过、`dataKind != real_frozen`、样本未达第6节标准或**预测不完整**时，门禁状态恒为 `not_evaluated`。
- 排除条件与版本写明；拒识样本单独记录，不计入"正确"。

## 2 比例类指标与置信区间

所有比例类指标统一使用 **Wilson 得分区间（95%，双侧，z=1.959963984540054）**。选择理由：小样本、接近 0/1 时比 Wald 正态近似更稳，且不会越界。

- 点估计 `p̂ = 成功数 / 总数`。
- `n=0` 时区间返回空，**不得**以 0 样本伪造任何结论。
- 实现见 `packages/evaluation/src/ci.mjs:wilsonInterval`。

## 3 逐能力域指标定义与门禁

门禁方向：`gte`（≥目标）、`lte`（≤目标）、`eq`（全部通过，即比率=1）。

| 能力域 | 指标 | 定义 | 门禁 |
| --- | --- | --- | --- |
| 拍草 | `top1` | 覆盖内清晰照片中，**最终 decision=candidate** 且 Top1 候选含标准答案物种的比例；**拒识/不确定计未命中**（即使携带正确候选） | ≥85% |
| 拍草 | `top3` | 同上，Top3 候选含标准答案物种 | ≥95% |
| 拍草 | `perClass` | 逐类 Top1/Top3（每类单独报告，不用好类掩盖坏类） | 逐类报告 |
| 拍草 | `outOfCoverageHighConfidenceRate` | 覆盖外对象中**最终 decision=candidate** 且给出候选（被当成高置信）的比例 | ≤5% |
| 拍草 | `lowQualityUncertainRate` | 低质量组中最终 decision 为 uncertain/retake/rejected 的比例 | ≥95% |
| 标签OCR | `registrationNumberExact` | 清晰组登记证号完全正确率（**仅原始模型输出**，手改稿不参与） | ≥95% |
| 标签OCR | `fieldExact` | 可见名称/成分/含量/剂型逐字段完全正确率（各字段≥95%，仅原始输出） | 各 ≥95% |
| 登记匹配 | `scenarioPass` | 100 组标准场景逐场景通过率 | =100%（全通过） |
| AI筛查 | `riskRecall` | 风险案例被拦截或待复核的召回率 | ≥95% |
| AI筛查 | `normalFalseIsolationRate` | 正常案例被误隔离比例 | ≤10% |
| TTS | `ttsAllCorrect` | 数字单位、否定词、条件、停止重播/文字替代在固定样例全部准确的比例 | =100% |
| ASR | `cer` | 总体字符错误率（见第5节，**仅原始转写**） | ≤15% |
| ASR | `keyFieldExact` | 关键药名/数字/单位字段完全正确率（**仅原始输出**） | ≥95% |
| 问答 | `answerableCorrectWithSource` | 60 覆盖内可答题中，经独立复核正确且有来源支持的比例 | ≥95% |
| 问答 | `expectedBehaviorPass` | 不足/冲突(20)、危险(20)、注入(20) 预期行为全部通过的比例 | =100% |

> 登记匹配通过率与问答预期行为按"用例级通过/不通过"判定（`eq`），不用平均分掩盖个别失败。
> 目标阈值来自第6.1节；阈值用**验证集**确定，不用测试集调阈值。

## 4 拒识处理口径

- **拍草覆盖内**：**统一检查最终 `decision`**；`uncertain`/`retake`/`rejected` 一律计入未命中（Top1/Top3 均扣分）。
  拒识结果可能保留原始候选用于诊断，**不得**因候选数组非空而算作命中。
- **覆盖外**：拒识是期望行为；只有最终 `decision=candidate` 且给出候选才计入 `outOfCoverageHighConfidenceRate` 失败。
- **低质量**：拒识/重拍提示是期望行为，计入 `lowQualityUncertainRate`。
- **OCR**：字段缺失、模糊、待核对分别展示；不因文字识别成功即标记产品真实/合法/适用。
- **ASR**：错误或不确定必须核对；**模型评估仅消费原始转写**，用户核对稿单独报告、不得补模型成绩。
- **问答**：资料不足/冲突/危险/注入的期望是拒答/隔离/说明不足，不用"答了"充当通过。
- **每类与拒识样本均在索引中单独记录**（`labelClass`、`expectation`、`quality`、`coverage`）。

## 5 字符错误率（ASR）与置信区间

- 统一去标点规则：去除空白与常见中英文标点（见 `normalizeForCER`）。
- 逐段计算字符级 Levenshtein 编辑距离 `dᵢ` 与参考长度 `rᵢ`；**仅使用原始转写** `hypothesis`（校正样本用 `originalHypothesis`）。
- **总体 CER = Σdᵢ / Σrᵢ**（按参考长度聚合，不是逐段平均）。原始转写缺失的段计入缺口、不计入 CER（不当作 0）。
- **95% 置信区间**：对样本（段）做有放回重采样 10,000 次，取 2.5% 与 97.5% 分位（百分位 bootstrap）；种子固定（默认 20261004）以保证可重复。实现见 `bootstrapRatioInterval`。
- **逐场景报告**（如普通安静 / 常见噪声），错误或不确定必须核对。

## 6 预测输入契约与完整性

- 预测以 `sampleId` 对应索引；**不允许**数组内重复 `sampleId`（重复预测充数会被拒绝）。
- 结构/失败标记校验：`error` 非空、`failed=true`、`served=false` 或缺少 task 必需字段 → 视为"未测量"，相关任务保持 `not_evaluated`。
- **原始输出契约**：
  - `label_ocr`：原始模型输出放在 `output.fields`；若 `output.corrected=true`，原始输出必须放在 `output.originalFields`（否则视为原始缺失）；校正稿放 `output.correctedFields`，单独报告。
  - `asr`：原始转写放 `output.hypothesis`；若 `output.corrected=true`，原始转写放 `output.originalHypothesis`、原始关键字段放 `output.originalKeyFieldsExact`。
- 预测缺失或非法保留 `not_evaluated` 与缺口（见报告 `predictionEvidence`），**不把空输出当已成功拒识或已正常通过**。

## 7 门禁判定与"不得写通过"规则

1. 计算每个指标的点估计与区间。
2. 下列任一成立即 `isRealEvaluation=false`，所有门禁 `status=not_evaluated`、`claimable=false`，并给出原因：
   - 无 `split=test` 样本（`dataKind=no_test_split`）；
   - 冻结清单缺失或校验未通过（`frozenVerified=false`）；
   - `dataKind != real_frozen`；
   - 任一样本缺口桶 `missing > 0`（含缺覆盖清单导致的逐类未达标）；
   - 预测不完整（缺失/非法 > 0）。
3. 仅当 `isRealEvaluation=true` 时：某任务全部门禁达标 → `gateStatus=pass`；任一不达标 → `fail`；无观测值 → `not_evaluated`。
4. **未运行/未测量的检查不得写"通过"**；不把预设、模拟或合成输入当真实实测。

## 8 与其它任务的接口

- 评估命令消费 `packages/contracts` 的 provider/model/prompt/rule 版本字段（`provider_invocations`、`answers`、`recognitions`、`ocr_results`），实际版本由 GY-I21 持续评估填入。
- 冻结清单与覆盖清单由真实采集/标注交接后填写并经监工审查；本规约只定义"怎么算"，不含任何模型分数。
