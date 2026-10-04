# 样本索引与标准答案 Schema（GY-I20）

机器可校验定义：[`packages/evaluation/schema/sample.schema.json`](../../packages/evaluation/schema/sample.schema.json)。
索引是**脱敏登记**：一行=一个样本，只含 hash 与元数据，**不含原始媒体**。

## 1 字段表

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | const `1.0.0` | ✔ | 版本化 |
| `sampleId` | string | ✔ | 不透明稳定 ID，不编码可逆身份或原始路径 |
| `task` | enum | ✔ | `weed_photo` / `label_ocr` / `registration_match` / `ai_moderation` / `tts` / `asr` / `qa` |
| `split` | enum | ✔ | `train` / `validation` / `test`；冻结评估集必须为 `test` |
| `clusterId` | string | ✔ | 近重复簇（同源裁剪/连拍/衍生同簇） |
| `captureSeriesId` | string |  | 连拍系列标识 |
| `contentSha256` | hex64 | ✔ | 归一化内容 SHA-256 |
| `perceptualHash` | hex16 |  | 64 位 dHash，用于近重复近似匹配 |
| `sourceKind` | enum | ✔ | `real_collected` / `real_third_party_licensed` / `database_record` / `synthetic_placeholder` |
| `sourceRef` | string | ✔ | 脱敏来源描述（批次/采集方式/许可编号），不得含个人身份或真实 URL |
| `labelClass` | string | ✔ | 标注类别：物种 ID / 登记证号 / 场景编号 / 危险类型等 |
| `coverage` | enum | ✔ | `covered` / `out_of_coverage` |
| `quality` | enum | ✔ | `clear` / `blurry` / `occluded` / `dark` / `target_too_small` / `reflective` / `bent` / `field_missing` |
| `expectation` | enum |  | `match` / `reject` / `answerable` / `insufficient` / `dangerous` / `injection` / `normal` / `risk` / `acceptable` / `unacceptable` |
| `gold` | object | ✔ | 标准答案（按 task 取用） |
| `annotation.method` | enum | ✔ | `reliable_label` / `independent_verification` / `expert_transcription` / `cross_checked_original` / `synthetic_placeholder` |
| `annotation.annotatorRef` | string | ✔ | 脱敏标注人/来源编号 |
| `annotation.reviewedBy` | string |  | 独立复核人编号 |
| `annotation.modelGenerated` | const `false` | ✔ | **硬约束：模型不得作为标准答案** |
| `rawMediaCommitted` | const `false` | ✔ | **硬约束：原始私有媒体不提交** |
| `rawMediaSha256` | hex64 |  | 原始媒体摘要（仅 hash） |
| `notes` | string |  | 备注 |

## 2 各 task 的 `gold` 约定

| task | gold 关键字段 | 备注 |
| --- | --- | --- |
| `weed_photo` | `speciesId` | 植物对象标准答案；覆盖外可为 `null` + `expected` |
| `label_ocr` | `registrationNumber,name,ingredient,content,dosageForm` | 由原文交叉核对 |
| `registration_match` | `expectedStatus` | 场景预期状态（no_match/conflict/... ） |
| `ai_moderation` | `decision` | `blocked` / `published` 等预期 |
| `tts` | `numbers,units,negation,conditions` | 固定样例的准确性要求 |
| `asr` | `reference,keyFields{drugNames,numbers,units}` | 人工转写作答案 |
| `qa` | `citationRefs`（可答）/ 期望行为 | 引用来自检索结果 |

## 3 来源、标注与独立核实

- **来源**：每条记录必须有 `sourceKind` 与 `sourceRef`。未知不得写成已确认；许可调查本轮按用户要求暂缓，`sourceKind` 不使用"已授权"以外的推断。
- **标注**：优先可靠标注（`reliable_label`）或独立核实（`independent_verification`）；语音用 `expert_transcription`；OCR 用 `cross_checked_original` 与原文交叉核对。
- **独立核实**：`reviewedBy` 记录独立复核人；模型不得作为自己的标准答案（`modelGenerated` 强制 false，校验器拒绝）。
- **拒识样本**：用 `expectation=reject` 与 `quality`/`coverage` 记录，单独统计。

## 4 训练 / 验证 / 测试隔离规则

1. **先冻结再调参**：最终测试集在模型调参前冻结；冻结清单须含 `indexVersion`、`split=test`、`recordCount`、
   `indexSha256`（与 test 集逐字节一致）与 `frozenAt`，来源标签或手填版本号不能代替冻结清单校验。
2. **同簇不跨 split**：同一 `clusterId` 的所有样本必须落在同一 `split`（校验器报错阻断）。
3. **连拍不跨 split**：同一 `captureSeriesId` 必须同簇、同 split。
4. **文本近重复不跨 split**：问答/ASR 中标准答案文本完全相同的样本必须同 split。
5. **感知近重复需合并**：`perceptualHash` 汉明距离 ≤ 阈值（默认 8）的两条样本必须同簇，否则报错要求人工确认。

> 规则实现：`packages/evaluation/src/grouping.mjs`；校验命令：`tools/evaluation/validate-evaluation-samples.mjs`。

## 5 内容 hash 与脱敏

- `contentSha256`：对归一化内容（媒体字节或文本归一化）计算，用于去重与完整性。
- `rawMediaSha256`：原始媒体摘要；原始媒体保存在**仓库外**私有存储，`rawMediaCommitted=false`。
- `sourceRef`、`annotatorRef`、`reviewedBy` 一律脱敏，不含个人身份、真实 URL、原始路径或令牌。
- 索引文件中**不得出现**：原始媒体二进制、base64、真实姓名/联系方式、openid、访问令牌。

## 6 校验与命令

```bash
# 校验索引（schema + 硬红线 + 隔离）
node tools/evaluation/validate-evaluation-samples.mjs --index <index.json>
```

校验失败（退出码 1）的典型原因：缺 `gold`、`modelGenerated=true`、`rawMediaCommitted=true`、hash 非法、
`sampleId` 重复、同簇/连拍/近重复跨 split。
