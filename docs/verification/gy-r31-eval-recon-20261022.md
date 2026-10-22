# GY-I20／GY-I21 只读复盘与缺口清单（2026-10-22）

> 范围：issue **#20**（冻结独立评估样本、标准答案及评估程序）与 **#21**（持续评估真实 AI 能力并汇总首版验收门槛）。
> 性质：**只读复盘**。不改业务代码、不改 `docs/architecture/contract-status.json`、不合并 PR、不跑全量单测、**未发起任何付费模型调用**。
> 判据来源：`docs/implementation-requirements.md` 第 6.1／6.3 节、`docs/initial-issues.md` GY-I20／GY-I21 范围段、`docs/pr-review-policy.md`。

## 0 现场与基线

| 项 | 值 |
| --- | --- |
| 主检出 | `E:\GengYunCommander\GengYun_Agent2`（只跑 git/gh） |
| 复盘工作树 | `E:\GengYunCommander\wt-r31-eval`，分支 `feat/gy-r31-eval-recon` |
| 基线 SHA | `origin/main` = `upstream/main` = **`d4d48088`**（两 ref 实测同 SHA） |
| 复算日期 | 2026-10-22 |
| 本次实际执行的程序 | `freeze-real-samples.mjs --verify`（退出码 0）、`node --test` 三个定向文件（13+8+14 全绿） |
| 未执行 | 全量单测、真实模型调用、任何写业务代码 / 改契约文件 |

三个定向测试（**非全量**，仅评估层定向文件）：

```
node --test tests/evaluation/acceptance-thresholds.test.mjs   → 13 pass / 0 fail
node --test tests/evaluation/threshold-basis.test.mjs         →  8 pass / 0 fail
node --test tests/evaluation/gy-i20-frozen-integrity.test.mjs → 14 pass / 0 fail
```

## 1 结论摘要（先看这三行）

1. **#20 的"程序侧"基本成立，"证据侧"整体不足**：冻结清单可逐字节复算（退出码 0）、答案键单向绑定、评分口径与拒识语义均由代码强制；但**独立复核（`reviewedBy`）为 0 条**、**真实模型输出为 0 条**，且报告含墙钟时间使"同输入同输出"只在指标层成立、字节层不成立。
2. **#21 的"门槛数值"已全部落盘并可追溯，"能力实测"为零**：`METRIC_GATES` 14 条、`SAMPLE_TARGETS` 17 桶全在 `packages/evaluation/src/targets.mjs:21` / `:147`，每条带 `basis.ref` 指到需求行；但 7 个能力域中只有拍草（`weed_photo`）有冻结样本，**六域零真实样本**，全部门禁停在 `not_evaluated`。
3. **两个 issue 都不能靠"补文档"关闭**，只能靠**补输入**：独立复核记录、其余六域样本、真实输出授权。最短路径见第 5 节。

计数（逐条对账见第 3、4 节）：

| Issue | 已满足 | 部分 | 缺 | 合计 |
| --- | --- | --- | --- | --- |
| #20 | 8 | 2 | 3 | 13 |
| #21 | 3 | 2 | 3 | 8 |

## 2 评估相关资产盘点（`git ls-files` 定位，逐个标冻结状态）

### 2.1 样本索引与标准答案

| 文件 | 作用 | 是否冻结 | 缺什么 |
| --- | --- | --- | --- |
| `packages/evaluation/samples/gy-i20-weeds-real-index.json` | 拍草域真实样本脱敏索引，172 条，`split=test`，`sourceKind=real_collected` | **是**（`indexSha256=36053ceed5…`，由冻结清单钉住） | 覆盖内仅 7 张、每类 1 张、荨麻类 0；无多角度/背景；原文样式为文档配图非手机实拍 |
| `packages/evaluation/samples/gy-i20-weeds-labels.json` | 标准答案键，版本 `gy-i20-weeds-labels-2026.10.14`，172 条 | **是**（`answerKeySha256=528242761a…`，绑定条目数 172） | 无 `reviewedBy`；答案取自来源文档自身条目文字（`reliable_label`），未与权威植物志逐条核对 |
| `packages/evaluation/samples/gy-i20-weeds-coverage-manifest.json` | 承诺覆盖类清单，8 个规范物种 ID | **是**（`coverageSha256=325fae9439…`，并绑定进冻结清单） | 该清单来自 GY-I03 资料范围，**不等于**模型侧实际覆盖承诺（`sample-gap-register.md:90` 已自陈） |
| `packages/evaluation/samples/gy-i20-weeds-predictions-none.json` | 显式"无模型输出"占位预测 | 不适用（内容为 `{}`） | 七个能力域**唯一的**预测文件就是它；其余六域无预测模板 |
| `packages/evaluation/samples/README.md` | 样本目录使用说明 | 否（文档） | 无逐域"预测字段形状"说明（见 §4.4 缺口 E1） |

### 2.2 冻结与绑定

| 文件 | 作用 | 是否冻结 | 缺什么 |
| --- | --- | --- | --- |
| `packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json` | 冻结清单：`indexVersion`／`split=test`／`recordCount=172`／各 sha256／`frozenAt`／覆盖绑定／答案键绑定 | **是**（清单自身 `sha256=4bd2a6fa57…`） | 只覆盖 1/7 能力域；`weedPhotoCoveredClasses` 与模型侧承诺脱钩 |
| `packages/evaluation/samples/gy-i20-weeds-frozen-digests.json` | 逐条摘要台账（`recordsDigest=5d1637d30c…`，172 条） | **是**（逐字节复算通过） | 同上 |
| `packages/evaluation/src/frozen.mjs` | 冻结校验与漂移定位（`frozenVerification.drift.changed[]`，拒绝整体不一致的笼统失败） | 代码，版本随 main | — |

### 2.3 评估程序

| 文件 | 作用 | 是否冻结 | 缺什么 |
| --- | --- | --- | --- |
| `tools/evaluation/run-evaluation.mjs` | 唯一评估入口：`--index/--predictions/--manifest/--coverage/--digests/--labels/--out/--seed/--json` | 否（随 main 演进） | 不透传 `generatedAt`（见 §3 C4） |
| `tools/evaluation/freeze-real-samples.mjs` | 冻结清单生成与复算核验（`--verify`／`--verify-digests`） | 否 | — |
| `tools/evaluation/lib.mjs` | `parseArgs` 等工具 | 否 | — |
| `tools/evaluation/render-threshold-tables.mjs` | 门槛表**由代码生成**（`--write`），防止文档与代码漂移 | 否 | — |
| `packages/evaluation/src/evaluate.mjs` | 主流程：`evaluateRun`／`buildGates`／`isRealEvaluation`（`:118`／`:73`／`:190`） | 否 | — |
| `packages/evaluation/src/metrics.mjs` | 7 个能力域的指标实现（`weedPhotoMetrics:58`、`labelOcrMetrics:123`、`registrationMatchMetrics:174`、`aiModerationMetrics:191`、`ttsMetrics:212`、`asrMetrics:250`、`qaMetrics:311`） | 否 | 排他口径只落在代码与测试夹具，无 schema 文件 |
| `packages/evaluation/src/ci.mjs` | 95% 置信区间，确定性 PRNG（mulberry32，固定 seed） | 否 | — |
| `packages/evaluation/src/gaps.mjs` | 样本缺口由索引程序化产生 | 否 | — |
| `packages/evaluation/schema/sample.schema.json` | 样本索引与标准答案 schema（`annotation.modelGenerated` 的 `const false`、`rawMediaCommitted` 的 `const false`） | **是**（`$id` 含 `1.0.0`） | — |
| `packages/evaluation/schema/run-report.schema.json` | 运行报告 schema | **是** | — |
| **（不存在）** `packages/evaluation/schema/predictions.schema.json` | 7 个任务的预测字段形状 | — | **缺**：目前只存在于 `tests/evaluation/fixtures/synthetic-predictions.json` 与 `metrics.mjs` 实现里 |

### 2.4 门槛数值落盘

| 文件 | 作用 | 是否冻结 | 缺什么 |
| --- | --- | --- | --- |
| `packages/evaluation/src/targets.mjs:21`（`SAMPLE_TARGETS`，17 桶） | 第 6.1 节样本量要求逐桶数值（300/30/100/100/200/20/100/100/200/200/30/50/10/60/20/20/20） | 代码即权威 | 登记匹配只 1 桶 100，无"六类冲突形态"逐形态拆分 |
| `packages/evaluation/src/targets.mjs:147`（`METRIC_GATES`，14 条） | 14 条指标门槛 + `direction` + `note` + `basis` | 代码即权威 | 2 条标记为"暂定，待 #21 用真实读数校准"；缺"硬规则全部通过" |
| `docs/evaluation/threshold-basis.md` | 门槛表 + 依据说明，表格由代码生成、测试逐字节比对 | 是（与代码同构，漂移即红） | — |
| `docs/evaluation/acceptance-thresholds-summary.md` | 首版验收门槛汇总（139 行） | 是（测试锚定） | 汇总的是"门槛"，不含任何实测读数 |
| `docs/implementation-requirements.md` 第 6.3 节 | 需求原文门槛与 AC 清单 | 是 | — |

### 2.5 规约与缺口文档

`docs/evaluation/scoring-spec.md`（46 行，评分口径与拒识语义）、`docs/evaluation/sample-index-schema.md`（52 行）、`docs/evaluation/near-duplicate-policy.md`（24 行）、`docs/evaluation/sample-gap-register.md`（99 行，**已登记样本缺口**）、`docs/evaluation/evaluation-report-template.md`（58 行）、`docs/evaluation/real-samples-weeds-docx.md`（193 行，真实样本交接记录）。本报告不重复 `sample-gap-register.md` 的缺口表，只做**验收点对账**与**入口/门槛矩阵**。

## 3 #20 逐条对账（样本独立性 / 标准答案可追溯 / 程序可复现）

### A 样本独立性（不得与训练/提示词重复）

| # | 检查点 | 判定 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| A1 | 最终验收只认经冻结清单校验的独立 `test` 集；来源标签／手填版本号不能替代 | **已满足** | `packages/evaluation/src/evaluate.mjs:190`（`isRealEvaluation`）、`schema/sample.schema.json:38`、`docs/evaluation/README.md` 硬红线 4 | 无 `test` 集／冻结未过／样本不足／预测不完整任一成立即 `isRealEvaluation=false` |
| A2 | 近重复与同源簇不跨 split；评分与缺口按**独立对象去重**计数 | **已满足** | `packages/evaluation/src/frozen.mjs`（簇/重复校验）、`src/gaps.mjs`（`duplicatesExcluded`）、实测 `contentSha256` 172/172 互异、dHash 两两最小距离 14（阈值 8 下近重复对 0） | `captureSeriesId` 同簇同 split 由 schema 与校验共同约束 |
| A3 | 与训练集／提示词**无重叠**的独立证据 | **缺** | `docs/evaluation/sample-gap-register.md:53`（"训练/测试隔离只在仓库内成立：无法证明该素材未进入任何模型训练集"） | 仓内可证明"同簇不跨 split"，**仓外不可证**；提示词侧有 `packages/moderation/prompts.mjs` + `prompt-version.mjs`，但**没有任何程序把提示词文本与文本类样本做重叠检查**（当前文本样本为 0，故暂属"未做"而非"做错"） |

### B 标准答案可追溯

| # | 检查点 | 判定 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| B1 | schema 硬约束：`annotation` 必填、`modelGenerated` 恒 `false`、`rawMediaCommitted` 恒 `false` | **已满足** | `packages/evaluation/schema/sample.schema.json:86-111`（`modelGenerated` 为 `const false`、`rawMediaCommitted` 为 `const false`） | 模型预测不得充当标准答案，原始私有媒体不入库 |
| B2 | 答案键**单向**绑定进冻结清单（版本 + sha256 + 条目数），且不反向依赖清单以免成环 | **已满足** | 冻结清单 `answerKeySha256=528242761a…`、条目 172；复算输出"答案键绑定：通过（无差异）" | 显式给 `--labels` 而核对不通过时评估退出码 1、`isRealEvaluation=false` |
| B3 | 每条 `gold` 与 `labelClass`／`coverage` 一致，且可由程序复算 | **已满足** | `gy-i20-weeds-labels.json`（172 条）、`src/frozen.mjs`、`tests/evaluation/gy-i20-frozen-integrity.test.mjs`（14 pass） | — |
| B4 | 独立核实记录（`reviewedBy`）、权威库逐条核对、许可／出处核实 | **缺** | `docs/evaluation/sample-gap-register.md:50-51`、`:68`、`:97` | 172 条**全部**无 `reviewedBy`；`annotation.method` 一律 `reliable_label`；许可编号未核实 |

### C 评估程序可复现（同输入同输出）

| # | 检查点 | 判定 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| C1 | 单一固定入口 + 参数化 + 明确前置校验顺序 | **已满足** | `tools/evaluation/run-evaluation.mjs`（用法串见 `:4`）、`docs/evaluation/README.md` 第 2 节 | 命令与参数在文档中固定 |
| C2 | 冻结清单／逐条台账可**逐字节**复算 | **已满足** | 本次实跑：`复算核对 …：冻结=通过（无差异）`、`覆盖绑定：通过`、`答案键绑定：通过`、`exit=0` | 台账 `recordsDigest=5d1637d30c…`、清单 `sha256=4bd2a6fa57…` 与仓库文件一致 |
| C3 | 预测完整性、ID 对齐、重复预测拒绝、手改稿不得补成绩 | **已满足** | `packages/evaluation/src/evaluate.mjs`（预测校验与 `claimable` 逻辑）、`metrics.mjs:229-233`（ASR 原始输出须留在 `originalHypothesis`） | 缺预测 → `not_evaluated` + 缺口，不写 0 分 |
| C4 | **同输入同输出**（字节级） | **部分** | `packages/evaluation/src/evaluate.mjs:127`（`generatedAt = new Date().toISOString()`）；`tools/evaluation/run-evaluation.mjs:60` **只读取 `args.seed`**，无 `--generated-at` | 指标、CI、门禁状态是确定的（PRNG 固定、`--seed` 可固定）；**报告字节不确定**，因为 `generatedAt` 取墙钟且 CLI 无法覆盖，两次同输入运行 `--out` 结果 diff 非空 |
| C5 | 存在真实模型／规则版本输出（否则只能 `not_evaluated`） | **缺** | `packages/evaluation/samples/gy-i20-weeds-predictions-none.json` 内容为 `{}`；`sample-gap-register.md:52`（"模型实测未授权"） | 付费调用未授权，本轮**零模型输出**；`weed_photo.metrics.top1.p=null` |
| C6 | 7 个任务的**预测字段形状**有版本化契约 | **部分** | 仅有 `schema/sample.schema.json` 与 `schema/run-report.schema.json`；预测形状实际编码在 `tests/evaluation/fixtures/synthetic-predictions.json` 与 `metrics.mjs` | 程序能跑、能拒错，但"喂什么字段"没有 schema 文件可引用；跨实现/跨供应商采集时口径靠读源码 |

**#20 小计：已满足 8（A1/A2/B1/B2/B3/C1/C2/C3）／部分 2（C4/C6）／缺 3（A3/B4/C5）。**

## 4 #21 对账（持续评估真实 AI 能力 + 门槛汇总）

### 4.1 六能力评估入口矩阵

`task` 闭集见 `packages/evaluation/schema/sample.schema.json:33`：`weed_photo`／`label_ocr`／`registration_match`／`ai_moderation`／`tts`／`asr`／`qa`（7 个）。

| 能力 | 评估入口（指标） | 冻结样本 | 真实预测 | 门槛条数 | 现状 |
| --- | --- | --- | --- | --- | --- |
| 识别（拍草） | `weedPhotoMetrics`（`metrics.mjs:58`） | ✅ 172 条 | ❌ | 4（含 2 条暂定） | 入口齐、样本不足、无读数 |
| OCR（标签） | `labelOcrMetrics`（`:123`） | ❌ | ❌ | 2 | 入口齐、无样本 |
| ASR | `asrMetrics`（`:250`） | ❌ | ❌ | 2 | 入口齐、无样本 |
| TTS | `ttsMetrics`（`:212`） | ❌ | ❌ | 1 | 入口齐、无样本 |
| 问答 | `qaMetrics`（`:311`） | ❌ | ❌ | 2 | 入口齐、无样本 |
| 筛查 | `aiModerationMetrics`（`:191`） | ❌ | ❌ | 2 | 入口齐、无样本 |
| 登记匹配 | `registrationMatchMetrics`（`:174`） | ❌ | ❌ | 1 | 入口齐、无样本 |

结论：**入口完备度 7/7，样本完备度 1/7，实测完备度 0/7。**

### 4.2 门槛数值落盘核对（14 条 `METRIC_GATES`）

| 能力 | 指标 | 目标 | 方向 | 依据性质 |
| --- | --- | --- | --- | --- |
| weed_photo | `top1` | 0.85 | gte | 需求原文 |
| weed_photo | `top3` | 0.95 | gte | 需求原文 |
| weed_photo | `outOfCoverageHighConfidenceRate` | 0.05 | lte | **暂定**（待 #21 用真实读数校准） |
| weed_photo | `lowQualityUncertainRate` | 0.95 | gte | **暂定**（同上） |
| label_ocr | `registrationNumberExact` | 0.95 | gte | 需求原文 |
| label_ocr | `fieldExact` | 0.95 | gte | 需求原文 |
| registration_match | `scenarioPass` | 1 | eq | 需求原文 |
| ai_moderation | `riskRecall` | 0.95 | gte | 需求原文 |
| ai_moderation | `normalFalseIsolationRate` | 0.10 | lte | 需求原文 |
| tts | `ttsAllCorrect` | 1 | eq | 需求原文 |
| asr | `cer` | 0.15 | lte | 需求原文 |
| asr | `keyFieldExact` | 0.95 | gte | 需求原文 |
| qa | `answerableCorrectWithSource` | 0.95 | gte | 需求原文 |
| qa | `expectedBehaviorPass` | 1 | eq | 需求原文 |

落盘三处一致：`targets.mjs:147`（代码权威）、`docs/evaluation/threshold-basis.md`（由 `render-threshold-tables.mjs` 生成，`threshold-basis.test.mjs` 逐字节比对 8 例全绿）、`docs/evaluation/acceptance-thresholds-summary.md`（`acceptance-thresholds.test.mjs` 13 例全绿，含"首版必过 19 项""AC15 只验静态"与需求 AC 清单比对）。

### 4.3 缺口 A 类：**有能力、无评估入口**

| # | 能力（定位） | 现状 | 为什么算缺口 |
| --- | --- | --- | --- |
| A-1 | 内容安全检查／回答安全检查链路：`services/api/src/ai/checked-content-live-adapter.ts`、`services/api/src/community/moderation-gate.ts`（合流不变式 `approved ⟹ hard_rule_passed===true`） | 评估侧只有 `ai_moderation` 的 **decision 级**指标 | `packages/evaluation` 对 `services/` **零引用**（`git grep "services/" -- packages/evaluation tools/evaluation tests/evaluation` 无命中），合流层行为无任何评估入口 |
| A-2 | 四个真实供应商 live 适配器：`ocr-live-adapter.ts`／`asr-live-adapter.ts`／`tts/live-ports.ts`／`checked-content-live-adapter.ts`（及对应 `*-live-ports.ts`） | 评估只吃**离线 predictions JSON** | **无 live→predictions 采集桥**：通过评估不要求跑真实链路，跑真实链路也不产出可评估预测 |
| A-3 | 识别 Top3 选择与不确定／重拍判定：`services/api/src/recognitions/selection.ts` | `weedPhotoMetrics` 只消费 `candidates[]` 与 `decision` | 选择逻辑自身（阈值、拒绝策略）无独立评估；换实现不会被评估发现 |
| A-4 | 提示词版本：`packages/moderation/prompts.mjs`、`packages/moderation/prompt-version.mjs` | 提示词有版本，但预测结构里**无 `promptVersion` 字段** | 无法回答"提示词改动后筛查指标如何变"，也无法做提示词与样本的重叠检查（见 §3 A3） |

### 4.4 缺口 B 类：**有评估入口、无门槛**

| # | 已产出的指标 | 缺的门槛 | 依据 |
| --- | --- | --- | --- |
| B-1 | 逐类指标：`weedPhotoMetrics.perClass`、`registrationMatchMetrics.perClass`、`labelOcrMetrics` 逐字段 | `METRIC_GATES` 只对**总体**设阈；逐类只报告不设阈 | 第 6.1 节"报告逐类和总体"——报告已做，**达标判定**没有 |
| B-2 | 登记匹配冲突形态 | 只有 1 条 `scenarioPass=1`；`SAMPLE_TARGETS[7]` 是单一 100 桶，**schema 无"冲突形态"字段**，六类形态无法逐类统计 | `targets.mjs` 第 7 桶的 `basis.text` 自己写着"并列出须覆盖的六类冲突形态" |
| B-3 | 筛查的"硬规则全部通过" | `METRIC_GATES` 无对应项；`aiModerationMetrics` 不读 `hard_rule_passed` | 需求 6.3 有"硬规则全部通过"，而 `packages/moderation` 已实现 `hard_rule_passed`（`engine.mjs`），两边未接 |
| B-4 | ASR 场景分组（安静／噪声） | 只有总体 `cer` 与 `keyFieldExact`；样本侧也只 1 个 `asr_utterances` 桶 | 第 6.1 节点名要求含安静／噪声场景，`sample-gap-register.md:95` 已列为交接要求，但没有指标门槛 |
| B-5 | QA 三类拒答行为 | `expectedBehaviorPass` 把"不足／危险／注入"**合成一条** eq 门槛 | 合并后无法定位是哪一类退化；三类各有 20 题，分母足够单列 |

**#21 小计：已满足 3（入口齐全、门槛落盘、门槛依据可追溯）／部分 2（样本与答案键只 1/7 域、逐类逐形态门槛不全）／缺 3（硬规则门槛、真实读数回填、2 条暂定门槛校准）。**

## 5 结论：最短关闭路径

### 5.1 最短可关闭 #20 的 3 件事

1. **补独立复核记录（解除 B4）** — 定位：`packages/evaluation/samples/gy-i20-weeds-labels.json`（172 条 `annotation` 块）＋ `docs/evaluation/sample-gap-register.md:97` 的交接要求。
   最小动作：第二人按 `catalog/species.json` 逐条复标并在 `annotation.reviewedBy` 落编号，重算 `answerKeySha256`、重跑 `freeze-real-samples.mjs --verify` 使其通过。
   判据：`reviewedBy` 非空条数 = 172，且 `--verify` 退出码 0、`frozenVerification` 无差异。
2. **让"同输入同输出"在字节层成立（解除 C4）** — 定位：`tools/evaluation/run-evaluation.mjs:60`（只读 `args.seed`）→ `packages/evaluation/src/evaluate.mjs:127`（`generatedAt`）。
   最小动作：加 `--generated-at <ISO>` 并透传进 `options.generatedAt`；同输入两次运行 `--out` 后 `sha256` 相同。
   判据：两条命令字节级一致（`Get-FileHash` 相等），且 `docs/evaluation/scoring-spec.md` 补一行"报告字节可复现条件"。
3. **把预测契约落盘（解除 C6）** — 定位：新增 `packages/evaluation/schema/predictions.schema.json`，形状取自 `tests/evaluation/fixtures/synthetic-predictions.json`（7 个任务的字段已在夹具里全备）＋ `metrics.mjs` 的读取路径。
   最小动作：一个 schema 文件 + 在 `evaluate.mjs` 前做一次 schema 校验（非法预测仍走既有 `not_evaluated` 语义）。
   判据：`synthetic-predictions.json` 通过校验；删掉 `tts` 任一字段即红（负控制）。

> C5（真实输出）不列入"最短三件"，因为它需要**用户单独授权的付费调用**，属外部输入而非工程动作；A3（跨仓训练集证明）同属外部输入。

### 5.2 最短可关闭 #21 的 3 件事

1. **把"有指标无门槛"补成门槛（解除 B-1/B-2/B-3/B-5）** — 定位：`packages/evaluation/src/targets.mjs:147`（`METRIC_GATES`）与 `:21`（`SAMPLE_TARGETS`）。
   最小动作：新增 4 条门槛定义——`perClassMinTop1`（逐类 Top-1 下限）、`registrationMatchPerForm`（六类冲突形态逐形态 pass）、`hardRulePass`（筛查 `hard_rule_passed` 全通过）、`qaExpectedBehaviorPerClass`（不足／危险／注入分列）；并给 `schema/sample.schema.json` 的 `labelClass` 约定登记匹配的六类形态取值。
   判据：`render-threshold-tables.mjs --write` 后 `threshold-basis.test.mjs` 仍绿，`threshold-basis.md` 出现 4 条新行且每条带 `basis.ref`。
2. **建立 live→predictions 采集桥（解除 A-1/A-2/A-3/A-4）** — 定位：`services/api/src/ai/*-live-adapter.ts`、`services/api/src/recognitions/selection.ts` → 新 `tools/evaluation/collect-predictions.mjs`（输出即 5.1-3 的 schema 形状）。
   最小动作：一个采集脚本把适配器输出写成 predictions（含 `promptVersion`／`ruleVersion`），**默认不联网、不付费**，由参数显式启用。
   判据：用 `packages/evaluation/samples/gy-i20-weeds-real-index.json` 跑通一次"采集 → `run-evaluation.mjs`"闭环，且未授权时脚本拒绝调用真实供应商。
3. **回填真实读数并校准 2 条暂定门槛（解除 B-3 的实测部分与 §4.2 的"暂定"）** — 定位：`targets.mjs:147` 中 `outOfCoverageHighConfidenceRate` 与 `lowQualityUncertainRate` 两条的 `basis.kind='provisional'`；汇总落在 `docs/evaluation/acceptance-thresholds-summary.md`。
   最小动作：在**用户授权**的付费调用下产出首发实测报告（`evaluation-report-template.md` 形状），把 2 条 provisional 换成实证依据或明确保留理由。
   判据：`isRealEvaluation=true` 的报告至少 1 份；`acceptance-thresholds-summary.md` 的"暂定"条目数从 2 降为 0 或附实证依据。

> 六域真实样本（`sample-gap-register.md` 第 4 节）是 #21 的**实质前置**，但它不是"三件事"级别的工程动作，而是外部交接；本报告不把它包装成可代码关闭项。

## 6 未取得项与边界

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实模型／供应商输出 | **未取得** | 付费调用未授权；本轮按要求**未发起任何调用**，未自掏额度 |
| 六域真实样本（OCR／登记匹配／筛查／TTS／ASR／QA） | **未取得** | 仓库内为 0；`sample-gap-register.md` 已登记交接清单 |
| 覆盖内拍草 300 张（每类 30） | **未取得** | 实到 7 张、每类 1、荨麻类 0 |
| 独立复核（`reviewedBy`） | **未取得** | 172/172 缺失 |
| 许可／出处核实 | **未取得** | `sourceRef` 已脱敏，但许可编号未核 |
| 跨仓训练集隔离证明 | **不可能在本仓取得** | 只能由模型提供方出具 |

边界声明：本报告所有"已满足"均以**仓库内可复算的程序行为**为依据，不代表真实能力达标；所有计数均由上文表格逐行相加得出，未使用估算。`docs/architecture/contract-status.json` **未被读取或修改**（在飞 PR 占用）。

## 7 复算命令（照抄即可复现本报告的程序侧结论）

```bash
# 冻结清单与逐条台账复算（退出码 0 才算通过）
node tools/evaluation/freeze-real-samples.mjs \
  --index packages/evaluation/samples/gy-i20-weeds-real-index.json \
  --coverage packages/evaluation/samples/gy-i20-weeds-coverage-manifest.json \
  --index-version gy-i20-weeds-real-2026.10.14 \
  --labels packages/evaluation/samples/gy-i20-weeds-labels.json \
  --verify-digests packages/evaluation/samples/gy-i20-weeds-frozen-digests.json \
  --verify packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json

# 门槛文档与代码逐字节一致 + 门槛汇总口径（定向文件，非全量）
node --test tests/evaluation/threshold-basis.test.mjs
node --test tests/evaluation/acceptance-thresholds.test.mjs
node --test tests/evaluation/gy-i20-frozen-integrity.test.mjs
```

本次实跑输出关键值（可对照校验）：
`indexSha256=36053ceed5…` / `coverageSha256=325fae9439…` / `answerKeySha256=528242761a…` / `recordsDigest=5d1637d30c…` / 冻结清单 `sha256=4bd2a6fa57…` / 记录数 172 / 承诺类 8。
