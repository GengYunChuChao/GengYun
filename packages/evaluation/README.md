# packages/evaluation

GY-I20 评估程序框架：**指标计算与评分规约先行**，真实样本另行交接。
本包只依赖 Node 标准库，无第三方依赖，可离线重复运行。

## 定位与边界

- 本包**不产出任何评估结论**，只提供可重复运行的程序与口径。
- 程序强制区分数据性质：最终验收**只使用经冻结清单校验的独立 `test` 集**；来源标签或手填版本号不能代替冻结清单。
  训练/验证样本另列统计，不参与评分；评分与缺口按**独立对象去重**。
- 只有「真实冻结 `test` 集 + 冻结校验通过 + **承诺覆盖清单绑定冻结版本** + 样本达第6节标准 + 预测完整」时才可能 `isRealEvaluation=true`；
  其余情况所有门禁恒为 `not_evaluated`，**不会写出"通过"**。
- 模型指标**仅消费原始输出**；手工校正结果单独报告，不缩分母、不补成绩；拒识/不确定查最终 `decision`。
  筛查最终决策与预测结构走**闭集校验**（`unknown`/服务错误/非法枚举不得算正常通过）；TTS 六项判定须明确为布尔值；
  OCR 固定可见字段保留**原始评估分母**（缺原始输出按缺口计，不对子集声明完整准确率）。
- 筛查是**两层判定**（规则层 `hard_rule_passed` + 模型层 `decision`）：`hardRulePass` 只比较样本
  **显式声明**的规则层期望（`gold.hardRuleExpectation='reject'|'pass'`，未声明的 `normal` 默认期望放行），
  未声明的风险样本被视为**一般模型风险**、不参与该指标（另报 `modelRiskIsolation`）——
  模型层正确隔离（`blocking` 且 `hard_rule_passed=true`）不得被当成硬规则失败。
  **零声明**（没有任何 `reject`/`pass` 声明）时该指标无观测值（`p=null` ⇒ 门禁 `not_evaluated`），
  `normal` 的默认放行不得单独把分母撑成"有样本"而报 pass。
- 原始私有样本与原始媒体**不提交 Git**，只提交脱敏索引与内容 hash。
- 标准答案必须来自可靠标注或独立核实；`annotation.modelGenerated` 强制为 `false`。

## 目录

```
packages/evaluation/
  schema/
    sample.schema.json       # 样本索引 + 标准答案 schema
    run-report.schema.json   # 评估运行报告（预期输出结构）
    predictions.schema.json  # 预测结构契约（7 个任务的字段形状，x-taskShapes 为权威绑定）
  src/
    ci.mjs                   # Wilson 95% CI、bootstrap 比率 CI、Levenshtein、CER 归一化
    metrics.mjs              # 各能力域指标计算（仅消费原始输出；拒识查最终 decision）
    grouping.mjs             # 近重复聚类、独立对象去重与训练/验证/测试隔离校验
    frozen.mjs               # 冻结清单校验、覆盖清单绑定校验与预测完整性/结构（闭集）校验
    predictions-validate.mjs # 预测结构契约的执行体（与 predictions.schema.json 同源，无新依赖）
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
  --generated-at 2026-10-04T00:00:00Z \
  --out report.json
```

`--generated-at <ISO8601>`（须带时区）固定报告里的 `generatedAt`：指标本来确定，缺省取墙钟时同输入两次运行的报告字节不同，
`sha256` 比对无法作为可复现证据；给出该参数后同输入两次运行**逐字节相同**（同一时刻的不同写法 `+08:00`/`Z` 会归一到同一份字节）。
缺省不传仍取墙钟（向后兼容），此时报告**不可复现**——不要把墙钟当契约。

运行评估回归测试（已接入工程 CI 的 `evaluation-tests` 层，禁用真实外部调用）：

```bash
npm run test:evaluation        # 等价：node --test tests/evaluation/*.test.mjs
```

## 输入输出

- 输入索引：`sample.schema.json` 描述的 JSON 数组。
- 输入预测：数组 `[{sampleId, output}]` 或对象 `{"<sampleId>": {..output..}}`；每条预测须符合
  `schema/predictions.schema.json`（7 个任务的字段形状契约，按任务的权威绑定见其 `x-taskShapes`）。
  不合契约时评估命令以退出码 1 结束并点名 `sampleId`/任务/缺哪个字段（服务失败标记 `error`/`failed`/`served` 的条目除外）。
- 输出报告：`run-report.schema.json` 描述；字段含各任务指标、门禁状态、缺口清单与警告。

详见 [docs/evaluation/](../../docs/evaluation/README.md)。
