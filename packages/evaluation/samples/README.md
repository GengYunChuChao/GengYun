# 真实评估样本（GY-I20／issue #20）

本目录存放**真实来源**的评估样本登记物：脱敏索引、独立标准答案键、承诺覆盖清单与冻结清单。
原始媒体**不在仓库内**（`rawMediaCommitted=false`）；本地路径映射留在仓库外的私有文件里。

## 1 当前内容

| 文件 | 作用 |
| --- | --- |
| `gy-i20-weeds-real-index.json` | 拍草（`weed_photo`）真实样本索引：172 条，`split=test`，含内容 SHA-256、dHash、尺寸与标准答案引用 |
| `gy-i20-weeds-labels.json` | **独立标准答案键**：逐条目的物种标签、覆盖内/外分组、判据要点（形态特征原文）与来源绑定 |
| `gy-i20-weeds-coverage-manifest.json` | 承诺覆盖类清单（8 个规范物种 ID，取自 GY-I03 承诺范围映射） |
| `gy-i20-weeds-frozen-manifest.json` | **冻结清单**：`indexVersion`／`recordCount`／`indexSha256`／`frozenAt` + 内嵌覆盖绑定块 |
| `gy-i20-weeds-predictions-none.json` | 空预测占位（`{}`）：真实模型实测未授权，评估命令因此**不得**产出任何成绩 |

对应实现与命令：`tools/evaluation/extract-docx-weed-samples.mjs`（抽取/登记）、
`tools/evaluation/freeze-real-samples.mjs`（冻结与复算）；回归：`tests/evaluation/gy-i20-real-samples.test.mjs`。

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

# 2) 复算并核对冻结清单（失败即退出码 1）
node tools/evaluation/freeze-real-samples.mjs \
  --index packages/evaluation/samples/gy-i20-weeds-real-index.json \
  --coverage packages/evaluation/samples/gy-i20-weeds-coverage-manifest.json \
  --index-version gy-i20-weeds-real-2026.10.14 \
  --verify packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json

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
