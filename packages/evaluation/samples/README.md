# 真实评估样本（GY-I20／issue #20）

本目录存放**真实来源**的评估样本登记物：脱敏索引、独立标准答案键、承诺覆盖清单与冻结清单。
原始媒体**不在仓库内**（`rawMediaCommitted=false`）；本地路径映射留在仓库外的私有文件里。

## 1 当前内容

| 文件 | 作用 |
| --- | --- |
| `gy-i20-weeds-real-index.json` | 拍草（`weed_photo`）真实样本索引：172 条，`split=test`，含内容 SHA-256、dHash、尺寸与标准答案引用 |
| `gy-i20-weeds-labels.json` | **独立标准答案键**：逐条目的物种标签、覆盖内/外分组、判据要点（形态特征原文）与来源绑定 |
| `gy-i20-weeds-coverage-manifest.json` | 承诺覆盖类清单（8 个规范物种 ID，取自 GY-I03 承诺范围映射） |
| `gy-i20-weeds-frozen-manifest.json` | **冻结清单**：`indexVersion`／`recordCount`／`indexSha256`／`frozenAt` + 内嵌覆盖绑定块 + `answerKey`（单向钉住答案键 sha256/版本/条数）+ `digestLedger`（逐条摘要台账指针） |
| `gy-i20-weeds-frozen-digests.json` | **逐条摘要台账**：172 条 × 记录摘要 + 20 个字段路径的 sha256（前 12 位），一条一行便于 `git diff`；任何一条被改动都点名到 `sampleId` 与字段 |
| `gy-i20-weeds-predictions-none.json` | 空预测占位（`{}`）：真实模型实测未授权，评估命令因此**不得**产出任何成绩 |

对应实现与命令：`tools/evaluation/extract-docx-weed-samples.mjs`（抽取/登记）、
`tools/evaluation/freeze-real-samples.mjs`（冻结、逐条台账与答案键绑定）；
回归：`tests/evaluation/gy-i20-real-samples.test.mjs`、`tests/evaluation/gy-i20-frozen-integrity.test.mjs`。

> **台账由脚本生成，不许手写**：`freeze-real-samples.mjs --digests <out>` 生成，
> `--verify-digests <file>` 重算并与既有台账**逐字节**比对（不一致即退出码 1）。
> 摘要口径：`sha256(JSON.stringify(record))` / `sha256(JSON.stringify(record[字段路径]))`，
> 均在 `JSON.parse` 之后计算，与换行符/缩进/BOM 无关（读取侧先剥离 BOM）。

## 2 样本规模（2026-10-14 实测）

| 指标 | 值 |
| --- | --- |
| 来源文档条目 | 172 |
| 抽取图片 | 172（全部 PNG，非隔行，8 位 RGBA） |
| 原始媒体字节 | 136 087 244（约 129.8 MiB） |
| `contentSha256` 互异 | 172 / 172（无字节级重复） |
| 感知哈希（dHash）互异 | 172 / 172；两两汉明距离**最小 14**，阈值 8 下近重复对 **0** |
| 图像非退化（灰度标准差） | 最小 21.72、最大 74.81；`std<5`（空白/纯色）**0 张**（客观代理，非目视核对） |
| 覆盖内（严格同名映射） | **7** |
| 覆盖外 | **165** |
| 独立对象（去重后） | 172（`duplicatesExcluded=0`） |
| 图片短边 | 最小 317 px、中位 540 px、最大 697 px |

逐类（覆盖内）：`species_barnyardgrass`、`species_crabgrass`、`species_foxtail`、`species_goosegrass`、
`species_shortawn_foxtail`、`species_lambsquarters`、`species_alligatorweed` **各 1 张**；
`species_nettle_group`（荨麻类）**0 张** —— 第6.1节"每个承诺覆盖的杂草至少30张"因此**逐类未满足**。

## 3 复算命令

```bash
# 1) 从仓外 docx 重算索引（幂等：重复运行产出逐字节相同的索引文件）
node tools/evaluation/extract-docx-weed-samples.mjs \
  --docx <仓外>/杂草图片版.docx --out-dir <仓外>/extracted/media \
  --path-map <仓外>/extracted/path-map.json \
  --labels packages/evaluation/samples/gy-i20-weeds-labels.json \
  --index packages/evaluation/samples/gy-i20-weeds-real-index.json \
  --report <仓外>/extracted/extraction-report.json --emit-perceptual-hash

# 2) 复算并核对冻结清单 + 逐条摘要台账 + 标准答案键（任一不符即退出码 1）
node tools/evaluation/freeze-real-samples.mjs \
  --index packages/evaluation/samples/gy-i20-weeds-real-index.json \
  --coverage packages/evaluation/samples/gy-i20-weeds-coverage-manifest.json \
  --index-version gy-i20-weeds-real-2026.10.14 \
  --labels packages/evaluation/samples/gy-i20-weeds-labels.json \
  --verify-digests packages/evaluation/samples/gy-i20-weeds-frozen-digests.json \
  --verify packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json

# 2b) 重新生成逐条摘要台账与冻结清单（改了样本/答案键之后；两处必须同时更新）
node tools/evaluation/freeze-real-samples.mjs \
  --index packages/evaluation/samples/gy-i20-weeds-real-index.json \
  --coverage packages/evaluation/samples/gy-i20-weeds-coverage-manifest.json \
  --index-version gy-i20-weeds-real-2026.10.14 --frozen-at <ISO 时间> \
  --labels packages/evaluation/samples/gy-i20-weeds-labels.json \
  --digests packages/evaluation/samples/gy-i20-weeds-frozen-digests.json \
  --out packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json

# 3) schema/硬红线/隔离校验
node tools/evaluation/validate-evaluation-samples.mjs --index packages/evaluation/samples/gy-i20-weeds-real-index.json

# 4) 离线评估（无模型输出 → 门禁 not_evaluated）
node tools/evaluation/run-evaluation.mjs \
  --index packages/evaluation/samples/gy-i20-weeds-real-index.json \
  --predictions packages/evaluation/samples/gy-i20-weeds-predictions-none.json \
  --manifest packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json \
  --coverage packages/evaluation/samples/gy-i20-weeds-coverage-manifest.json --out <报告.json>
```

## 4 明确**不主张**的事（避免误读）

1. **没有模型成绩**：本目录不含任何模型/规则版本的实测指标；空预测文件使 `isRealEvaluation=false`、门禁 `not_evaluated`。
2. **标准答案未经独立复核**：标签与判据取自来源文档自身条目文字（`annotation.method=reliable_label`），
   无 `reviewedBy`，未与权威植物志逐条核对，也未由第二人复标。
3. **不是手机实拍、无多角度/背景**：第6.1节要求覆盖内含实际手机照片及不同角度／背景，
   本批为文档配图（短边中位 540 px）且**每类仅 1 张**，不构成该要求的满足。
4. **未做人工目视核对**：本轮只做了客观非退化诊断（无空白/纯色图），
   未核对每张画面内容是否确为该物种，也未做清晰度/遮挡分级。
5. **训练/测试隔离只在仓库已知范围内成立**：无法证明该文档素材未被任何模型训练使用；
   任何真实模型评估前必须确认来源未进入该模型训练集。
6. **许可未核实**：`sourceKind=real_collected` 只表示"真实来源、非合成"，不代表已获授权或可再分发；
   原始媒体与路径映射一律留在仓库外。
7. 覆盖承诺类取自 **GY-I03 资料覆盖范围**（`coverage_state=planned`），
   它是本轮的可用绑定依据，但**不等于模型侧已完成的识别覆盖承诺**。

## 5 最小真实评估路径（≥30 张真机照片 → 一次可复算的能力评估）

本节写给后来人：怎样用**一批新拍的真机照片**把「覆盖内 7/300」往前推进，并跑出**能复算**的指标与 95% 置信区间。
目标形态：**≥30 张真机拍摄的同物种照片**，推荐稗草（`species_barnyardgrass`）——它在冻结覆盖清单里是 `covered`，
判据也最好写（与水稻的叶耳叶舌区分）。跑完一轮，覆盖内从 **7** 到 **37**（第6.1节要求 ≥300，每类 ≥30；见
`docs/implementation-requirements.md:460`），稗草这一类由 1 张到 31 张，**逐类**才第一次可能达标；
总量仍远不足 300，所以 `isRealEvaluation` 仍是 `false`，指标只能作为**能力评估**，不能当作效果承诺。

### 5.1 照片放哪、怎么命名

| 项 | 约定 |
| --- | --- |
| 原始照片 | **仓外**私有目录，例如 `<仓外>/phone-<YYYYMM>/barnyardgrass/`；只把 hash 与元数据入库（`rawMediaCommitted=false`） |
| 文件命名 | `barnyard_<两位序号>_<角度>.jpg`，如 `barnyard_01_overview.jpg`、`barnyard_02_leaf.jpg`、`barnyard_03_base.jpg`；角度取整株／叶片／茎基部／田面背景 |
| 一株多张 | 同一株的多角度或连拍**必须同一 `clusterId`**；去重按**独立对象**计数，同株多张只算 1 条独立证据 |
| 因此 | 要 30 条独立证据，就要 **≥30 株独立植物**；同株拍 30 张，去重后仍然是 1 |
| 索引（仓内） | `packages/evaluation/samples/gy-i20-weeds-phone-index.json`，一条一记录，字段照 [../../../docs/evaluation/sample-index-schema.md](../../../docs/evaluation/sample-index-schema.md) 第 1 节 |
| 答案键（仓内） | 在 `gy-i20-weeds-labels.json` 追加条目（或新开同 schema 文件）：`criteria` 写该物种判据要点，`reviewedBy` 记独立复核人 |
| 冻结清单与逐条台账 | **不许手写**，由 `freeze-real-samples.mjs` 生成（见 5.2 第 2 步） |

最小可用记录（照现有 `gy-i20-weeds-001` 的形状，略去工具自填的媒体尺寸）：

```json
{
  "schemaVersion": "1.0.0",
  "sampleId": "gy-i20-phone-001",
  "task": "weed_photo",
  "split": "test",
  "clusterId": "gy-i20-phone-cl-001",
  "contentSha256": "<64 hex>",
  "perceptualHash": "<16 hex>",
  "sourceKind": "real_collected",
  "sourceRef": "phone_2026_11#barnyard-001",
  "labelClass": "species_barnyardgrass",
  "coverage": "covered",
  "quality": "clear",
  "gold": { "speciesId": "species_barnyardgrass" },
  "annotation": { "method": "independent_verification", "annotatorRef": "<脱敏采集人>", "reviewedBy": "<复核人>", "modelGenerated": false },
  "rawMediaCommitted": false,
  "rawMediaSha256": "<64 hex>"
}
```

`sourceRef` 只写脱敏批次与序号，不写真实姓名、手机号、聊天目录或原始路径；`split` 必须是 `test`；
`quality` 按实情取 `clear`／`blurry`／`occluded`／`dark`／`target_too_small`。

### 5.2 跑哪条命令（按顺序，任一步退出码非 0 就停）

评估核心在 `packages/evaluation/src/evaluate.mjs`（导出 `evaluateRun`），命令行包装是
`tools/evaluation/run-evaluation.mjs`；**跑的是后者的 CLI**，不要直接调 `evaluate.mjs`。

```bash
# 1) 结构 + 硬红线 + 隔离（同簇／连拍／近重复不得跨 split）
node tools/evaluation/validate-evaluation-samples.mjs \
  --index packages/evaluation/samples/gy-i20-weeds-phone-index.json

# 2) 生成冻结清单 + 逐条摘要台账 + 答案键绑定（样本一变就必须是新的 indexVersion）
node tools/evaluation/freeze-real-samples.mjs \
  --index packages/evaluation/samples/gy-i20-weeds-phone-index.json \
  --coverage packages/evaluation/samples/gy-i20-weeds-coverage-manifest.json \
  --index-version gy-i20-weeds-phone-<YYYY.MM.DD> \
  --labels packages/evaluation/samples/gy-i20-weeds-labels.json \
  --digests packages/evaluation/samples/gy-i20-weeds-phone-frozen-digests.json \
  --out packages/evaluation/samples/gy-i20-weeds-phone-frozen-manifest.json

# 3) 评估：--predictions 必须是模型／规则的**原始输出**，不许手改
#    （付费调用未获用户单独授权时就是空预测 {}，门禁保持 not_evaluated、无成绩）
node tools/evaluation/run-evaluation.mjs \
  --index packages/evaluation/samples/gy-i20-weeds-phone-index.json \
  --predictions <predictions.json> \
  --manifest packages/evaluation/samples/gy-i20-weeds-phone-frozen-manifest.json \
  --coverage packages/evaluation/samples/gy-i20-weeds-coverage-manifest.json \
  --digests packages/evaluation/samples/gy-i20-weeds-phone-frozen-digests.json \
  --labels packages/evaluation/samples/gy-i20-weeds-labels.json \
  --generated-at <ISO8601 带时区> \
  --out <仓外>/reports/gy-i20-weeds-phone-<YYYYMMDD>.json

# 4) 门禁读数快照（三份日志 + 可选报告 JSON）：给证据文件引用，不重算
node tools/evaluation/verify-gate-readout.mjs <run-evaluation.log> <freeze.log> <validate.log> <report.json>
```

`--generated-at` 固定报告时间戳，同一输入两次运行逐字节相同——这是把报告当证据的前提。

### 5.3 输出落到哪

- 报告 JSON：**仓外**（体积大、含逐条明细）；证据文件写进 `docs/verification/gy-i20-<日期>.md`（沿用现有 `gy-i20-*` 命名），
  只贴**命令、退出码、报告里可核对的字段**：`frozenIndexVersion`、`splits.test`、`duplicatesExcluded`、
  `frozenVerified`、`coverageBinding.verified`、`isRealEvaluation`、`tasks.weed_photo.gateStatus` 与
  `tasks.weed_photo.gates[].status`，以及 `tasks.weed_photo.metrics.top1` / `top3` 的 `p`、`low`、`high`、`n`
  （`p/low/high` 是 Wilson 95% 区间；无模型输出时 `p=null`，**不得写 0 分或成绩**）。
- `docs/evaluation/sample-gap-register.md` 第 1 节第 1、2 行的「实际到位」随新计数更新（那是唯一计数来源）。

### 5.4 必须人工核对的事（程序核不了）

1. 画面**确实是稗草**，不是水稻、千金子等近缘种；把区分判据写进 `criteria`（叶耳叶舌有无、叶片宽软、茎基部颜色等）。
2. `coverage` 分对：稗草 = `covered`；拍到别的物种就 `out_of_coverage` + `labelClass=ext_<编号>`（目录外稳定标识），**不许改名凑覆盖内**。
3. `quality` 如实分级：模糊、遮挡、过暗、目标过小不要填 `clear`，否则低质量桶被虚增、清晰桶被污染。
4. 同株／连拍关系如实登记 `clusterId`（必要时补 `captureSeriesId`），不要靠"看起来不同"拆成多条独立样本。
5. 来源与许可：`sourceRef` 脱敏；许可未核实就不得写"已许可"，原图与路径映射留在仓外。

### 5.5 边界（做不到就不算）

- **不许用合成图、截图或网络图冒充**真机拍摄；合成占位只能走 `make-synthetic-fixture.mjs` 的夹具路径。
- **不许把演示视频帧当样本**：演示片明确不承担真实性／科学预测准确率要求（`docs/features/pesticide-demo-video.md:34`）。
- 结果只作**能力评估**：覆盖内未达 300、逐类未达 30 之前，不得对外宣称"支持稗草识别"或给出任何准确率／效果承诺。
- 真实模型／规则输出须有**用户单独授权的付费调用**；未授权就保持空预测、`not_evaluated`，不得用人工校正结果补成成绩。
