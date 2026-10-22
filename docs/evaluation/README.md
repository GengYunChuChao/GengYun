# GY-I20 评估样本、标准答案与评估程序

本目录冻结 GY-I20（GitHub issue #20）的**样本索引与标准答案 schema、近重复排除规则、评分规约、评估命令、真实样本登记物与缺口清单**。
第一真相为 `docs/implementation-requirements.md` 第6节（第6.1至6.5），辅以 `docs/initial-issues.md` 的 GY-I20 段落。

## 本任务交付了什么 / 没交付什么

| 已交付（可审查） | 尚未交付 |
| --- | --- |
| 可重复运行的评估命令与预期输出结构 | 其余六域真实样本（标签OCR、登记匹配、AI筛查、播报、ASR、问答） |
| 样本索引与标准答案 schema（含来源/标注/分组/hash/隔离规则） | 覆盖内手机实拍照片（≥300、每类 ≥30、不同角度/背景） |
| 近重复排除规则（同源裁剪/连拍/近重复跨 split 阻断） | 独立核实记录（`reviewedBy`）与许可/出处核实 |
| 评分规约（指标定义、口径、拒识、95% 置信区间程序） | 人工质量分级（清晰/低质量分组） |
| **真实拍草样本登记 172 条**（`packages/evaluation/samples/`，`split=test`） | 真实模型/规则版本的实测结果（付费调用未授权） |
| **拍草独立标准答案键**（物种标签 + 判据要点 + 来源绑定） | 模型侧实际覆盖承诺的冻结（现以 GY-I03 资料范围为绑定依据） |
| **冻结清单 + 承诺覆盖绑定**（可复算，复算命令退出码 0） | Android/iOS 真机与联网耗时证据（第6.2节） |
| **逐条摘要台账**（172 条 × 逐字段 sha256，改动即点名到 `sampleId` 与字段） | — |
| **标准答案键绑定**（冻结清单单向钉住 labels 的 sha256+版本+条数） | — |
| [threshold-basis.md](threshold-basis.md)：17 桶 + 14 条门槛的逐条依据 | — |
| 样本缺口逐项清单（对照第6节标准，已用真实计数替换 0 值） | — |

> 评估程序框架与评分规约先交 PR；**实际样本不足列为阻塞，不用生成或重复媒体充数**。
> 本轮真实样本只填了拍草域的一部分：**覆盖内 7 张（7 类各 1、荨麻类 0）**、覆盖外 165 张；
> 因此 `isRealEvaluation=false`、门禁 `not_evaluated`、**无任何模型成绩**。
> 详见 [real-samples-weeds-docx.md](real-samples-weeds-docx.md) 与
> [../verification/gy-i20-real-samples-20261014.md](../verification/gy-i20-real-samples-20261014.md)。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [scoring-spec.md](scoring-spec.md) | 指标定义、评分口径、拒识处理、95% 置信区间程序、门禁判定 |
| [sample-index-schema.md](sample-index-schema.md) | 样本索引字段、来源、标注、独立分组、内容 hash、训练/验证/测试隔离规则 |
| [near-duplicate-policy.md](near-duplicate-policy.md) | 同源裁剪／连拍／近重复排除规则与每类／拒识样本记录 |
| [real-samples-weeds-docx.md](real-samples-weeds-docx.md) | **真实拍草样本**：来源、抽取与去重计数、标准答案与判据、覆盖口径、冻结与复算、离线评估输出、未取得/未验证项与剩余风险 |
| [sample-gap-register.md](sample-gap-register.md) | 样本缺口逐项清单（对照第6节标准，含真实计数） |
| [threshold-basis.md](threshold-basis.md) | **17 桶 + 14 条门槛的逐条依据**（`requirement` 给需求行号 / `provisional` 明标「暂定，待 #21 用真实读数校准」）；表格由代码生成，改阈值不改说明即测试红 |
| [evaluation-report-template.md](evaluation-report-template.md) | 评估报告模板与预期输出结构 |

代码实现位于 `packages/evaluation/`，命令位于 `tools/evaluation/`，真实样本登记物位于 `packages/evaluation/samples/`，测试位于 `tests/evaluation/`。

## 命令一览

```bash
# 1) 生成合成占位输入（仅验证程序，不是真实评估）
node tools/evaluation/make-synthetic-fixture.mjs

# 1b) 从仓外 docx 抽取真实拍草样本（幂等；答案键 cross-check；媒体只写仓外）
node tools/evaluation/extract-docx-weed-samples.mjs \
  --docx <仓外>/杂草图片版.docx --out-dir <仓外>/extracted/media \
  --path-map <仓外>/extracted/path-map.json \
  --labels packages/evaluation/samples/gy-i20-weeds-labels.json \
  --index packages/evaluation/samples/gy-i20-weeds-real-index.json \
  --report <仓外>/extracted/extraction-report.json --emit-perceptual-hash

# 2) 校验脱敏样本索引（schema + 硬红线 + 隔离）
node tools/evaluation/validate-evaluation-samples.mjs --index <index.json>

# 3) 运行评估，产出结构化报告（真实验收须带冻结清单与覆盖清单）
node tools/evaluation/run-evaluation.mjs \
  --index <index.json> --predictions <predictions.json> \
  --manifest <frozen-manifest.json> --coverage <coverage-manifest.json> \
  --digests packages/evaluation/samples/gy-i20-weeds-frozen-digests.json \
  --labels packages/evaluation/samples/gy-i20-weeds-labels.json \
  --out <report.json>

# 3a) 冻结清单生成 / 复算核对（--verify 失败即退出码 1）
#     --digests 写逐条摘要台账；--verify-digests 重算并与既有台账逐字节比对；--labels 钉标准答案键
node tools/evaluation/freeze-real-samples.mjs \
  --index packages/evaluation/samples/gy-i20-weeds-real-index.json \
  --coverage packages/evaluation/samples/gy-i20-weeds-coverage-manifest.json \
  --index-version gy-i20-weeds-real-2026.10.14 \
  --labels packages/evaluation/samples/gy-i20-weeds-labels.json \
  --verify-digests packages/evaluation/samples/gy-i20-weeds-frozen-digests.json \
  --verify packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json

# 3b) 门槛依据文档的表格块（代码 → 文档，改完 targets.mjs 后重跑）
node tools/evaluation/render-threshold-tables.mjs --write

# 4) 单元测试（亦接入工程 CI 的 evaluation-tests 层）
node --test tests/evaluation/*.test.mjs
```

## 硬红线（程序强制）

1. `rawMediaCommitted` 必须为 `false`：原始私有媒体不提交 Git。
2. `annotation.modelGenerated` 必须为 `false`：模型不得作为自己的标准答案。
3. 同簇（同源裁剪/连拍/近重复）不得跨 `split`；评分与缺口按**独立对象去重**计数。
4. **最终验收只认经冻结清单校验的独立 `test` 集**；来源标签/手填版本号不能代替冻结清单。
5. **预测必须完整、结构合法、与索引 ID 对应**；缺失/非法保留 `not_evaluated` 与缺口，重复预测被拒绝。
6. **模型指标仅消费原始输出**；手工校正结果单独报告、不得补模型成绩、不得缩分母。
7. 拒识/不确定**统一检查最终 `decision`**，即使携带正确候选也计未命中。
8. 任一条件不满足（无 `test` 集/冻结未过/样本不足/预测不完整/非真实来源）即 `isRealEvaluation=false`、门禁 `not_evaluated`。
9. 原始媒体与令牌不进入仓库；只提交脱敏索引与 hash。
10. **范围口径统一为规范物种 ID**：`weedPhotoCoveredClasses`/`labelClass`/`gold`/`candidates` 一律用 `catalog/species.json` 的 `id`；
    GY-I03 承诺范围（中文展示组名）须经 `group_name ↔ id` 映射为 ID 再核对，映射依据（`catalog_version`/SHA-256）记入 `coverageBinding.scopeBasis`。
11. **冻结必须可点名**：冻结清单登记逐条摘要台账（`digestLedger`）后，样本集任何一条被改动都必须报出
    `sampleId` + 变更字段路径（`frozenVerification.drift.changed[]`），**不接受"整体不一致"这种笼统失败**；
    显式给 `--digests` 时评估命令以退出码 1 结束。
12. **标准答案键单向绑定**：冻结清单钉住 `gy-i20-weeds-labels.json` 的 `sha256`+版本+条数，答案键不反向依赖清单（避免环）；
    显式给 `--labels` 而核对不通过时评估命令退出码 1，且 `isRealEvaluation=false`。
