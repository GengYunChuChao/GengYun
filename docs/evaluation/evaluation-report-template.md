# 评估报告模板与预期输出结构（GY-I20）

评估命令 `tools/evaluation/run-evaluation.mjs` 输出结构化 JSON（机器可读 schema：
[`packages/evaluation/schema/run-report.schema.json`](../../packages/evaluation/schema/run-report.schema.json)），并在 stderr 输出人类可读摘要。

## 1 顶层结构

```json
{
  "schemaVersion": "1.0.0",
  "dataKind": "real_frozen | synthetic_placeholder | mixed | no_test_split",
  "isRealEvaluation": false,
  "generatedAt": "<ISO-8601>",
  "indexSha256": "<64hex>",
  "testIndexSha256": "<64hex>",
  "predictionSha256": "<64hex>",
  "frozenIndexVersion": "<冻结版本号>",
  "frozenVerified": false,
  "frozenVerification": { "verified": false, "reasons": [], "indexSha256": "<64hex>", "manifestSha256": "<64hex|null>" },
  "splits": { "train": 0, "validation": 0, "test": 0, "total": 0 },
  "duplicatesExcluded": 0,
  "coverageManifestPresent": false,
  "predictionEvidence": { "expected": 0, "present": 0, "missing": [], "invalid": [], "extra": [], "complete": false, "byTask": {} },
  "tasks": { "<task>": { "sampleCount": 0, "scoredCount": 0, "metrics": {}, "gates": [], "gateStatus": "not_evaluated" } },
  "gaps": [ { "task": "", "bucket": "", "required": 0, "present": 0, "missing": 0, "duplicatesExcluded": 0 } ],
  "warnings": []
}
```

> 最终验收只使用经冻结清单校验的独立 `test` 集（`splits.test`）；`train`/`validation` 另列统计、不参与评分。
> `frozenVerified=false`、`predictionEvidence.complete=false` 或任一样本缺口 `missing>0` 时，`isRealEvaluation` 恒为 `false`。

## 2 门禁对象

```json
{
  "metric": "top1",
  "observed": null,
  "target": 0.85,
  "direction": "gte",
  "status": "pass | fail | not_evaluated",
  "claimable": false,
  "reason": "synthetic 或样本未达第6节目标/存在缺口，不得声称达标",
  "note": "Top1≥85%（拒识计入未命中）"
}
```

- `claimable=false` 时 `status` 恒为 `not_evaluated`：合成/占位/样本不足的输入**不会**产生 pass。
- 逐任务 `gateStatus`：全部门禁 pass→`pass`；任一 fail→`fail`；不可主张或无观测→`not_evaluated`。

## 3 人类可读摘要（stderr 示例）

```
dataKind=synthetic_placeholder  isRealEvaluation=false  frozenIndexVersion=unfrozen
- weed_photo: 16 样本  gateStatus=not_evaluated
    top1=75.00% [40.93%, 92.85%] n=8  top3=100.00% [67.56%, 100.00%] n=8
- asr: 4 样本  gateStatus=not_evaluated
    CER=3.03% [0.00%, 10.34%] n=4  说话者=2
样本缺口桶：17/17 未达标
    [缺300] weed_photo_covered (需300, 有0)
! 输入含 synthetic_placeholder：仅验证程序可运行，不构成真实评估。
! 真实样本数量未达第6节标准，评估未完成，不得标记达标。
```

> 上例为**合成占位输入**的运行结果，用于验证程序可运行；**不是真实样本评估**，不得作为任何达标证据。

## 4 真实评估报告（样本交接后）必填项

- 冻结清单（`indexVersion` + `testIndexSha256` 与清单 `indexSha256` 一致）与冻结覆盖清单；模型/规则/prompt 实际版本（对接 GY-I21）。
- 各任务**总体与逐类**指标 + 95% 置信区间（比例类 Wilson；CER bootstrap）；模型指标仅取**原始输出**。
- 预测完整性证据（`predictionEvidence`：期望/有效/缺失/非法/多余）；重复预测一律拒绝。
- 独立对象去重后的样本量与覆盖范围（`duplicatesExcluded`）；明确"有限样本不证明现实零风险"。
- 拒识样本计数与处理口径；手工校正结果单独报告；排除条件与未达标项。

## 5 报告纪律

- 未测量不给成绩；不把预设、模拟、合成输入当真实实测。
- 不用截图/界面代替实际运行证据。
- 不编造来源、登记号、专家身份；不生成处方/混配/换算。
