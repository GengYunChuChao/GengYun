# GY-I20 评估样本、标准答案与评估程序

本目录冻结 GY-I20（GitHub issue #20）的**样本索引与标准答案 schema、近重复排除规则、评分规约、评估命令与样本缺口清单**。
第一真相为 `docs/implementation-requirements.md` 第6节（第6.1至6.5），辅以 `docs/initial-issues.md` 的 GY-I20 段落。

## 本任务交付了什么 / 没交付什么

| 已交付（可审查） | 尚未交付（真实样本未交接） |
| --- | --- |
| 可重复运行的评估命令与预期输出结构 | 真实评估样本（两类图片、语音、问答、筛查全部） |
| 样本索引与标准答案 schema（含来源/标注/分组/hash/隔离规则） | 真实独立标准答案与独立核实记录 |
| 近重复排除规则（同源裁剪/连拍/近重复跨 split 阻断） | 真实冻结清单与冻结版本号 |
| 评分规约（指标定义、口径、拒识、95% 置信区间程序） | 真实模型/规则版本的实测结果 |
| 样本缺口逐项清单（对照第6节标准） | — |

> 评估程序框架与评分规约先交 PR；**实际样本不足列为阻塞，不用生成或重复媒体充数**。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [scoring-spec.md](scoring-spec.md) | 指标定义、评分口径、拒识处理、95% 置信区间程序、门禁判定 |
| [sample-index-schema.md](sample-index-schema.md) | 样本索引字段、来源、标注、独立分组、内容 hash、训练/验证/测试隔离规则 |
| [near-duplicate-policy.md](near-duplicate-policy.md) | 同源裁剪／连拍／近重复排除规则与每类／拒识样本记录 |
| [sample-gap-register.md](sample-gap-register.md) | 样本缺口逐项清单（对照第6节标准） |
| [evaluation-report-template.md](evaluation-report-template.md) | 评估报告模板与预期输出结构 |

代码实现位于 `packages/evaluation/`，命令位于 `tools/evaluation/`，测试位于 `tests/evaluation/`。

## 命令一览

```bash
# 1) 生成合成占位输入（仅验证程序，不是真实评估）
node tools/evaluation/make-synthetic-fixture.mjs

# 2) 校验脱敏样本索引（schema + 硬红线 + 隔离）
node tools/evaluation/validate-evaluation-samples.mjs --index <index.json>

# 3) 运行评估，产出结构化报告
node tools/evaluation/run-evaluation.mjs --index <index.json> --predictions <predictions.json> --out <report.json>

# 4) 单元测试
node --test tests/evaluation/*.test.mjs
```

## 硬红线（程序强制）

1. `rawMediaCommitted` 必须为 `false`：原始私有媒体不提交 Git。
2. `annotation.modelGenerated` 必须为 `false`：模型不得作为自己的标准答案。
3. 同簇（同源裁剪/连拍/近重复）不得跨 `split`。
4. `dataKind != real_frozen` 或样本未达第6节标准时，门禁恒为 `not_evaluated`，不得声称达标。
5. 原始媒体与令牌不进入仓库；只提交脱敏索引与 hash。
