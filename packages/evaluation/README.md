# packages/evaluation

GY-I20 评估程序框架：**指标计算与评分规约先行**，真实样本另行交接。
本包只依赖 Node 标准库，无第三方依赖，可离线重复运行。

## 定位与边界

- 本包**不产出任何评估结论**，只提供可重复运行的程序与口径。
- 程序强制区分数据性质：最终验收**只使用经冻结清单校验的独立 `test` 集**；来源标签或手填版本号不能代替冻结清单。
  训练/验证样本另列统计，不参与评分；评分与缺口按**独立对象去重**。
- 只有「真实冻结 `test` 集 + 冻结校验通过 + 样本达第6节标准 + 预测完整」时才可能 `isRealEvaluation=true`；
  其余情况所有门禁恒为 `not_evaluated`，**不会写出"通过"**。
- 模型指标**仅消费原始输出**；手工校正结果单独报告，不缩分母、不补成绩；拒识/不确定查最终 `decision`。
- 原始私有样本与原始媒体**不提交 Git**，只提交脱敏索引与内容 hash。
- 标准答案必须来自可靠标注或独立核实；`annotation.modelGenerated` 强制为 `false`。

## 目录

```
packages/evaluation/
  schema/
    sample.schema.json       # 样本索引 + 标准答案 schema
    run-report.schema.json   # 评估运行报告（预期输出结构）
  src/
    ci.mjs                   # Wilson 95% CI、bootstrap 比率 CI、Levenshtein、CER 归一化
    metrics.mjs              # 各能力域指标计算（仅消费原始输出；拒识查最终 decision）
    grouping.mjs             # 近重复聚类、独立对象去重与训练/验证/测试隔离校验
    frozen.mjs               # 冻结清单校验与预测完整性/结构校验
    schema-validate.mjs      # 索引校验（无依赖，含硬红线）
    targets.mjs              # 第6.1节样本数量与指标门禁
    gaps.mjs                 # 样本缺口逐桶计算（独立对象去重 + 覆盖清单逐类）
    evaluate.mjs             # 编排：冻结校验 + 指标 + 门禁 + 缺口 → 报告
  index.mjs                  # 公共出口
```

## 快速开始

生成合成占位输入（**仅验证程序本身，非真实样本**）：

```bash
node tools/evaluation/make-synthetic-fixture.mjs
```

校验索引合规：

```bash
node tools/evaluation/validate-evaluation-samples.mjs --index tests/evaluation/fixtures/synthetic-index.json
```

运行评估：

```bash
# 真实验收：必须提供经核实的冻结清单与冻结覆盖清单，否则 isRealEvaluation 恒为 false
node tools/evaluation/run-evaluation.mjs \
  --index <index.json> \
  --predictions <predictions.json> \
  --manifest <frozen-manifest.json> \
  --coverage <coverage-manifest.json> \
  --out report.json
```

运行评估回归测试（已接入工程 CI 的 `evaluation-tests` 层，禁用真实外部调用）：

```bash
npm run test:evaluation        # 等价：node --test tests/evaluation/*.test.mjs
```

## 输入输出

- 输入索引：`sample.schema.json` 描述的 JSON 数组。
- 输入预测：数组 `[{sampleId, output}]` 或对象 `{"<sampleId>": {..output..}}`。
- 输出报告：`run-report.schema.json` 描述；字段含各任务指标、门禁状态、缺口清单与警告。

详见 [docs/evaluation/](../../docs/evaluation/README.md)。
