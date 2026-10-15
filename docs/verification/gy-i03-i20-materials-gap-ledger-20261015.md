# GY-I03 / GY-I20 真实资料与样本缺项台账（2026-10-15）

- **关联**：`Refs #3`、`Refs #20`；**不关闭任何整项**。
- **基线**：`upstream/main = 24fac03`。本文所有 `file:line` 均指该基线的仓库检出。
- **上游依据**：仓库外侦察报告（`.pg17/handoff/recon-materials-samples.md`，只读侦察，2026-10-15）。
- **模型标注（如实）**：本文档按**会话继承模型**执行 = `deepseek-v4.1-flash`；**推理等级无法通过参数下发 ⇒ 仅声明，不声称已下发**。
- **本次改动范围**：**只新增本文档 1 个文件**。未改 `packages/**`、`tools/**`、`db/**`、素材、契约、CI、`README.md`；未 push、未合并、未 force；未读取或打印任何密钥；**未把私密素材内容写入本文档**（只写文件名 / 字节数 / `sha256` 等元数据）。

> **🔴 一句话结论（会改变后续怎么干）**
> `#3` 与 `#20` 的「私密素材 → 仓库资料 / 样本」**管线都已存在、都已跑过这三份素材、都已合入 main**（PR #131 / #130）。
> 因此现在的缺口**不是"没有管线"**，而是：**用量与安全字段在三份素材里根本不存在**（只能靠 ICAMA 核准标签，**严禁补造**）、**20 份独立登记标签取得 0 份**、**`reviewedBy` 全为 `null`（独立核实未发生）**、**覆盖内严格同名样本仅 7 张（要求 ≥300、每类 ≥30）**、**许可全 `licensed=false`**。
> **本文档是缺项台账，不构成 `#3` / `#20` 的验收结论。**

---

## 0 本台账的性质、基线与纪律

### 0.1 性质（先读这一段，避免误读）

1. 本文档回答的是「**现在到底有什么、缺什么、缺的谁来给**」，**不回答**「`#3` / `#20` 是否通过验收」。
2. 本文档**没有**声称资料 / 样本已就绪；**没有**声称任何缺项已补齐；**没有**声称许可已确立。
3. 本文档**不替用户或监工拍板**：§4 的 C1–C14 逐条原样列出，**未作结论**。
4. 本文档**不新增任何从素材抽取的数据**（零新数据入库）：§2 的映射表只对既有产物与既有文档做**逐列登记**。

### 0.2 基线事实（本机复核）

```
upstream/main                = 24fac034276c26b0e870e8ea8ea7f4349a8f8a89
#3  浙江首批资料（PR #131）  = a15a7f1  feat(GY-I03): 浙江首批资料清单与既有适配层的可复核落地（Refs #3） (#131)
#20 真实杂草样本（PR #130）  = de1004c  feat(GY-I20): 真实杂草样本登记/答案键/冻结清单与离线评估接入（Refs #20） (#130)
```

### 0.3 工作树陷阱（**会直接影响后续怎么开工**）

`GengYun_W22`（`feat/gy-i03-zhejiang-materials` @ `588ba8f`）与 `GengYun_W23`（`feat/gy-i20-real-samples` @ `d70edc6`）是 **squash 合并前的旧分支尖端**，**不是** `upstream/main` 的祖先，已被 `a15a7f1` / `de1004c` 取代。

> ⇒ **后续任何切片都必须从 `upstream/main@24fac03` 开新分支**；不得复用 `GengYun_W22` / `GengYun_W23` 工作树，也不得把它们当作"未合并的现成实现"。

### 0.4 纪律声明

- 未修改 `packages/**`、`tools/**`、`db/**`、素材本体、契约（`packages/contracts/**`）、CI 配置与 `README.md`。
- 未解包、未复制、未转存任何私密素材内容；本文档只有文件名、字节数与 `sha256`。
- 文档内**不出现**仓外绝对路径；仓外来源一律用 `repo-external://samples/<文件名>` 形式表示。

---

## 1 已有资产（逐条给出位置、PR 号、条目数）

### 1.1 `#3` 管线：两份 xlsx → 可复核资料清单 → 库内条目（**已存在、已合入 main**）

| 组件 / 资产 | 位置（file:line，基线 24fac03） | PR | 条目数 / 关键结论 |
| --- | --- | --- | --- |
| 抽取器（Python 标准库） | `tools/knowledge/extract_zhejiang_materials.py` | #131 | 消费两份 xlsx（`--samples-dir` 仓外只读样本目录） |
| 校验器（离线 + 可选重算） | `tools/knowledge/validate_zhejiang_materials.py`（`--root .` / `--root . --samples-dir …`） | #131 | 离线结构校验可在 CI 跑；带样本时逐字节重算 |
| 负例自测（14 例） | `tools/knowledge/test_zhejiang_materials.py` | #131 | 含"补造用量""行指纹截断""来源未登记""覆盖漂移"等负例 |
| 种子 / 回滚生成 | `tools/knowledge/build_seeds.py` → `db/seeds/seed_zhejiang_materials.sql`、`db/seeds/rollback_zhejiang_materials.sql` | #131 | `seed_zhejiang_materials.sql:12` 绑定 `weed-summary-2026.10` + xlsx `sha256` + `repo-external://samples/<文件名>` + `valid` / `unverified` |
| 受限暂存导入器 | `tools/knowledge/import_workbook_staging.py` | 早于 #131 | 只读抽取到 `.local/`，产出 `staging.json` / `import.sql` / `rollback.sql`（全 Git 忽略） |
| **清单产物** | `packages/knowledge/zhejiang/materials-zhejiang-v1.json` | #131 | schema `gengyun.knowledge.zhejiang-materials.v1`；`weed_items=119`、`control_timing_items=14`、`herbicide_items=96`、`usage_notes=14`、`sources=2`、`gaps=8` |
| **入库条目数（已证据项）** | `packages/knowledge/zhejiang/README.md:35` | #131 | **159 条 = 119 杂草 + 5 防除时期 + 35 除草剂** |
| 抽取结果明细 | `packages/knowledge/zhejiang/README.md:29-34` | #131 | 杂草总表 175 行 → 浙江适用 119；省份索引 118 名全部可定位；防除时期 14 行 → 5 行与浙江作物一致；除草剂 96 行 → 首批 35（2 显式浙江 + 33 长江中下游） |
| 逐条来源绑定结构 | `packages/knowledge/zhejiang/README.md:37-55` | #131 | `source_id` / `source_version` / `file` / `file_sha256` / `sheet` / `excel_row` / `cell_range` / `row_sha256` / `locator` |
| 库内落地与边界 | `packages/knowledge/zhejiang/README.md:76-92`、`:94-99` | #131 | 只出现在 `v_queryable_seed_version`，**不进** `v_active_source_version`；`licensed=false` 不得写为已许可 |
| 覆盖报告 | `packages/knowledge/coverage-report.json:59-98`（`zhejiang_first_batch`） | #131 | `source_kind=verified_seed`、`review_status=unverified`、`originals_committed=false` |
| 覆盖报告缺口桶 | `packages/knowledge/coverage-report.json:99-107` | #131 | 7 条 gaps（用量未采集、有效期未采集、禁限用未采集、未与 ICAMA 复核、ICAMA 接口报错、许可暂缓、八组科普缺失） |
| **入库 / 暂存设计** | `docs/architecture/workbook-staging-design.md:5-25`（六列映射）、`:39`（仅暂存、不进用量卡）、`:41-51`（表与字段）、`:44`（`file_sha256 + mapping_version` 联合 unique）、`:50`（CHECK 禁标 valid/verified/card_ready）、`:81`（单次读取上限 25,000,000 字节，超出立即拒绝） | 早于 #131 | 阶段仅暂存；未知来源保持 `source_version_id=null` |
| 证据页 | `docs/verification/gy-i03-zhejiang-materials.md` | #131 | `:292-306` 11 条必须如实标注的缺项；`:308-318` 未取得 / 风险；`:320-338` 复现命令 |
| 标签研究（20 份目标） | `docs/research/gy-i03-public-label-index-20261011.json`、`gy-i03-label-evidence-increment-20261011.{json,md}`、`gy-i03-public-source-audit-20261011.md` | 早于 #131 | 候选 24 条；`gy-i03-label-evidence-increment-20261011.md:47` **"20 份独立核准完整标签的目标未达到"**，取得完整现行核准标签 = **0** |
| 库内回归 | `tools/knowledge/pglite_verify.mjs`、`tests/unit/gy-i03-db.test.mjs` | #131 | 执行范围限定 `<= 0003`，打印跳过清单 |

### 1.2 `#20` 管线：docx → 样本索引 / 答案键 / 冻结清单（**已存在、已合入 main**）

| 组件 / 资产 | 位置（file:line，基线 24fac03） | PR | 条目数 / 关键结论 |
| --- | --- | --- | --- |
| 抽取器（零依赖 ZIP + PNG） | `tools/evaluation/extract-docx-weed-samples.mjs`；`:1-19` 用途 / 约束 / 用法；`:8-12` 三条约束（只标准库 / 原始媒体写仓外 `rawMediaCommitted=false` / 答案键逐字交叉核对否则退出）；`:32-37` `repoRelativeRef` 防绝对路径入索引 | #130 | CLI：`--docx`（仓外）`--out-dir`（仓外）`--path-map`（仓外）`--labels` `--index` |
| 冻结与复算 | `tools/evaluation/freeze-real-samples.mjs`（`--out` / `--verify`，不符退出码 1） | #130 | 冻结清单可复算 |
| 离线评估入口 | `tools/evaluation/run-evaluation.mjs` | #47 | 消费 index + predictions + manifest + coverage |
| schema 校验 | `tools/evaluation/validate-evaluation-samples.mjs` | #47 | 硬红线程序校验 |
| 覆盖范围复核 | `tools/evaluation/knowledge-scope.mjs` | #47 | 复核"承诺类未越界" |
| 样本 schema | `packages/evaluation/schema/sample.schema.json`；`:8-22` required 13 项；`:36-39` `split`；`:40-48` `clusterId` / `captureSeriesId`；`:59-62` `sourceKind` 4 值闭集；`:63-68` `sourceRef` 脱敏；`:74-77` `coverage`；`:78-81` `quality`；`:86-90` `gold`；`:94-99` `annotation.method`；`:101` `reviewedBy` 可空；`:102-105` `modelGenerated` **const false**；`:108-111` `rawMediaCommitted` **const false** | #47 | schema 说明另见 `docs/evaluation/sample-index-schema.md:25-31`（`:29` `rawMediaCommitted` const false 硬约束） |
| **样本产物** | `packages/evaluation/samples/` | #130 | `gy-i20-weeds-real-index.json`（172 条）、`gy-i20-weeds-labels.json`（172 条 entry）、`gy-i20-weeds-coverage-manifest.json`、`gy-i20-weeds-frozen-manifest.json`、`gy-i20-weeds-predictions-none.json`（空 `{}`） |
| 冻结清单绑定块 | `packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json` | #130 | `indexVersion=gy-i20-weeds-real-2026.10.14`、`split=test`、`recordCount=172`、`indexSha256=36053ceed50abbeb…c78f`、`frozenAt=2026-10-14T12:05:00+08:00`、`coverage.weedPhotoCoveredClasses` 8 个规范物种 ID + `coverageSha256` + `basisRef` |
| 流程与红线 | `docs/evaluation/README.md:72-84` | 早于 #130 | 10 条程序强制硬红线（`:74` rawMediaCommitted=false；`:75` modelGenerated=false；`:76` 同簇不跨 split；`:81` 任一条件不满足即 `isRealEvaluation=false`；`:82` 原始媒体与令牌不入仓） |
| 抽取方法文档 | `docs/evaluation/real-samples-weeds-docx.md`；`:16` 来源 `sha256`；`:17` 172 张 PNG；`:19` 原始件与媒体一律不入库；`:103-127` 答案键与核实状态；`:129-143` 覆盖口径 | #130 | 见 §1.3 与 §2.6 |
| 近重复策略 / 评分规约 | `docs/evaluation/near-duplicate-policy.md`、`docs/evaluation/scoring-spec.md` | 早于 #130 | dHash 阈值 8；两两最小汉明距离 14、近重复对 0 |
| 样本目录说明 | `packages/evaluation/samples/README.md:1-4`、`:67-81` | #130 | `:67-81` 明确列出"**不主张**"的事（含标准答案未经独立复核） |
| 缺口清单（程序产出） | `docs/evaluation/sample-gap-register.md:16-34`、`:41-54`、`:86-99` | #130 | 17 个缺口桶；解除阻塞所需输入 10 条（`:86-99`） |
| 证据页 | `docs/verification/gy-i20-real-samples-20261014.md` | #130 | 既有证据页 |
| 回归 | `tests/evaluation/gy-i20-real-samples.test.mjs` | #130 | 11 例（含 3 例负控制） |
| 合成夹具（负控制） | `tools/evaluation/make-synthetic-fixture.mjs` → `tests/evaluation/fixtures/synthetic-index.json` | 早于 #130 | 全 `sourceKind=synthetic_placeholder` |

**答案键的治理字段（`packages/evaluation/samples/gy-i20-weeds-labels.json` 头部，逐字）**

```
:2   schema = gengyun.evaluation.weed-labels.v1
:3   version = gy-i20-weeds-labels-2026.10.14
:6   sourceDocSha256 = 624ee4d5285410e1a9ccc0910e41f52873894079617064e7e49611e9ead7a3b8
:8   sourceCharacterization = "…本轮只使用其物种名与形态特征文字作为标注依据，不使用其任何版式或图片本体入库。"
:15  annotation.method = "reliable_label"
:16  annotation.annotatorRef = "docx_weeds_v1"
:17  annotation.modelGenerated = false
:18  annotation.reviewedBy = null
:19  annotation.note = "…**尚未进行独立复核**（无 reviewedBy）：既未与权威植物志/分类库逐条核对，也未由第二人独立复标。"
:21  licenseNote = "原始出处与再分发许可未核实（许可调查按用户要求暂缓）；原始媒体不入库、不对外分发。"
```

### 1.3 三份私密素材的身份核验（`sha256` 与仓内登记值）

**结论：三份文件的实测 `sha256` 与仓内登记值逐字节吻合 —— 这是"同一份文件"的硬证据。**

| 素材（文件名） | 字节 | `sha256` | 仓内登记位置 | 判定 |
| --- | --- | --- | --- | --- |
| `杂草图片版.docx` | 136 173 583 | `624ee4d5285410e1a9ccc0910e41f52873894079617064e7e49611e9ead7a3b8` | `docs/evaluation/real-samples-weeds-docx.md:16`；`packages/evaluation/samples/gy-i20-weeds-labels.json:6`（`sourceDocSha256`） | **逐字节一致** |
| `中国各省份农田常见杂草识别与防除时期汇总表.xlsx` | 74 680 | `e708577e1cd035b435686c8d249209aa96d345d86a33a9a870e01cd6cdddc420` | `packages/knowledge/coverage-report.json:69`；`db/seeds/seed_zhejiang_materials.sql:12` | **逐字节一致** |
| `市面常见除草剂环境风险与适用信息汇总表.xlsx` | 27 422 | `c4905d850b3750c712b10fd8278b5029448a651308fb92c186df604a527c9e70` | `docs/architecture/workbook-staging-design.md:7`；`packages/knowledge/coverage-report.json:74` | **逐字节一致** |

docx 只读结构（侦察仅读 zip 中央目录，**未解包**）：zip 条目 189、`word/media/*.png` **172 张**、媒体总字节 **136 087 244**、单图 min 272 843 / 中位 748 056 / max 1 548 832 B、含 `word/document.xml` 正文、无宏无外链。

### 1.4 新杠杆：docx 与杂草 xlsx **可按物种名 join**（侦察实测）

```
labels entries = 172 ; distinct docxName = 172
xlsx 杂草总表 A 列非空 = 175
规范化（去括号别名）后 distinct：xlsx=174  docx=171
INTERSECTION（规范化精确同名）= 170
docx-only = 1 ; xlsx-only = 4
```

读法：**170 / 172 的 docx 条目名与杂草总表 A 列精确同名**；docx 提供「图片 + 形态特征原文」，xlsx 提供「学名 / 科属 / 伴生作物 / 分布省份 / 生长时期 / 最佳防除时期 / 施药窗口 / 识别要点」，两者可按物种名 join。

> ⚠️ **但不得据此主张"独立核实"**：两份都是**同一用户提供的整理稿**（同链来源）；`criteria` 与 xlsx「识别要点」是否同源**未经核对**（见 §4 `C6`）。

### 1.5 覆盖口径现状（172 条，两种口径同时给出，冻结与缺口一律按前者）

| 口径 | 覆盖内 | 覆盖外 | 说明 |
| --- | --- | --- | --- |
| **严格同名（冻结 / 缺口采用）** | **7** | **165** | 稗草 / 马唐 / 狗尾草 / 牛筋草 / 看麦娘 / 藜 / 空心莲子草 **各 1 张**；`species_nettle_group`（荨麻类）**0** |
| 并入同属近缘种（仅作参考） | 20 | 152 | 近缘种 13 条，**不改变**冻结口径 |

依据：`docs/evaluation/real-samples-weeds-docx.md:80-83`、`:129-143`；`docs/evaluation/sample-gap-register.md:18-19`。

---

## 2 列 → 字段映射表（可直接用 / 缺失 / 需人工核准）

三态口径：**可直接用** = 已有落地约定且取值域明确；**需人工核准** = 可映射但口径或权威性待定；**缺失（源表无此列）** = 不得推断、不得补造。

### 2.1 素材 A `中国各省份农田常见杂草识别与防除时期汇总表.xlsx` —— sheet `杂草总表`（9 列 × 175 行）

目标字段来源：`packages/knowledge/zhejiang/materials-zhejiang-v1.json` 与 `db/seeds/seed_zhejiang_materials.sql` 的 `knowledge_versions.body`。

| Excel 列 | 表头（原文） | 仓内目标字段 | 判定 |
| --- | --- | --- | --- |
| A | 杂草名称 | `weed_name` + `canonical_name`（去括号别名） | **可直接用**（已有 119 条落地） |
| B | 学名 | `scientific_name` | 可直接用；**需人工核准**（未与 `catalog/species.json` 权威学名核对） |
| C | 科属 | `family_genus` | 可直接用；**需人工核准**（自由文本，非规范科属 ID） |
| D | 伴生作物 | `companion_crops[]` | 可直接用；**需人工核准**：作物目录只有 水稻 / 玉米 / 大豆 / 油菜，蔬菜 / 茶园 / 果园 / 蚕豆无 `crop_id`（`docs/verification/gy-i03-zhejiang-materials.md:302` `blocked_on_scope`） |
| E | 分布省份（中国） | `distribution_note` + `distribution_provinces[]`，派生 `zhejiang_evidence_strength="distribution_field"` | **可直接用**（浙江适用性的唯一显式证据源） |
| F | 各生长时期状态描述 | `growth_stages_text` | **可直接用** |
| G | 最佳防除时期 | `best_control_stage_text` | **可直接用** |
| H | 推荐施药／防除窗口 | `spray_window_text` | 可直接用；**需人工核准**（属"何时打"而非"打多少"，**不得当作用量**） |
| I | 识别要点 | `identification_key_text` | 可直接用；**需人工核准**（与 docx `criteria` 可能同源，独立性未核 — 见 §4 `C6`） |
| — | （无此列） | `dose_text` / `usable_as_dose` / `card_ready` | **缺失（源表无此列）**，已显式 `null` / `false`；**严禁推断补造**（`docs/verification/gy-i03-zhejiang-materials.md:296`） |
| — | （无此列） | 登记证号 / 成分含量 / 剂型 / 施用方法 / 注意事项 / 安全间隔期 / 登记有效期 | **缺失（源表无此列）**，不得为凑卡片补造 |

### 2.2 素材 A —— sheet `省份索引表`（5 列 × 34 行）

| 列 | 表头（原文） | 仓内用法 | 判定 |
| --- | --- | --- | --- |
| A | 省份／省级行政区 | `region`（浙江行 = r12） | **可直接用** |
| B | 所属大区 | 浙江 = 「长江中下游稻区」，用作除草剂"长江中下游"归属依据 | **可直接用** |
| C | 该省常见农田杂草（数量） | 与 D 列交叉校验计数 | **可直接用** |
| D | 常见杂草清单 | 118 个杂草名，与 `杂草总表` E 列互为交叉验证 | **可直接用** |
| E | 该省主要作物与说明 | 浙江主要作物（水稻 / 油菜 / 蔬菜 / 茶园 / 果园 / 蚕豆） | **需人工核准**：部分超出 `crop_id` 目录（见 §4 `C9`） |

### 2.3 素材 A —— sheet `防除时期速查`（4 列 × 14 行）

| 列 | 表头（原文） | 仓内目标字段 | 判定 |
| --- | --- | --- | --- |
| A | 作物／场景 | `scene_text` | **可直接用**（5 行已入库为 `scheme`） |
| B | 防除关键期 | `critical_window_text` | **可直接用** |
| C | 主要杂草对象 | `target_weeds_text` | 可直接用；**需人工核准**（自由文本，不自动链接规范物种 ID） |
| D | 要点提示 | `key_points_text` | **可直接用** |
| — | （9 行未取证场景） | — | **缺失**：本工作簿未给出与浙江的对应关系 ⇒ `deferred`（`docs/verification/gy-i03-zhejiang-materials.md:303`） |

### 2.4 素材 A —— sheet `说明与使用提示`（1 列 × 27 行）

14 条约束行，含「用量必须以登记信息与产品标签为准」「不构成农药使用推荐」等**源表自述约束**；应保留为 `context`，**不得当药剂行**（`docs/architecture/workbook-staging-design.md:52`；`packages/knowledge/zhejiang/README.md:34`）。

### 2.5 素材 B `市面常见除草剂环境风险与适用信息汇总表.xlsx` —— sheet `除草剂汇总表`（6 列 × 96 行）

映射原文出处：`docs/architecture/workbook-staging-design.md:16-23`（`mapping_version=herbicide-summary-v1` 已合）。

| Excel 列 | 原表头 | 未审核映射字段 | 规范化边界（原文要点） | 判定 |
| --- | --- | --- | --- | --- |
| A | 除草剂名称 | `name_text`；另存 `name_search` | 原文完整保留；`name_search` 仅 NFKC 与首尾空白；不能推断成分、登记号或制剂 | **可直接用** |
| B | 常见别称／商品名 | `aliases_text` | 不自动拆分或作为登记精确匹配键 | **可直接用** |
| C | 对环境危害等级 | `risk_grade_text` | 保留汇总表自定等级，不转权威毒性分级或安全分数 | 可直接用；**需人工核准**（须标注"来源自定等级"） |
| D | 对环境主要造成的危害 | `risk_text` | 自由文本原文，不自动拆成定量环境风险证据 | **可直接用** |
| E | 常用于防除的对象（杂草） | `weed_text` | 自由文本；不自动链接规范物种或推出可用性 | 可直接用；**需人工核准**才可链接物种 |
| F | 适用／常用地区 | `region_text` | 混有地区 / 作物带 / 禁限用叙述，不自动生成浙江适用条件或禁限用法规 | **需人工核准**：浙江适用性只能靠"显式含浙江 / 长江中下游"文本匹配（已得 2 + 33 = 35 条） |
| — | （无此列） | 登记证号 / 成分浓度 / 剂型 / 登记有效期 / 来源链接 / 标签原文 / 剂量单位 | **缺失**：96 行这些规范字段均保持 `null`（`:25`），不得补造 | **缺失（源表无此列）** |
| — | （无此列） | `validity` / `review_status` / `card_ready` | 已按 `unknown` / `unverified` / `false` 落 | **可直接用**（现状即如实值） |

sheet `说明与使用提示`（1 列 × 23 行，19 行有内容）：**保存原 Excel 行号、空白间隔不压缩重编号**（`:12`），存 `context`。

### 2.6 素材 C `杂草图片版.docx` → `#20` 样本（**已在用**）

| docx 结构 | 仓内目标字段 | 判定 |
| --- | --- | --- |
| 每条目 = 物种名段 + 形态特征段 + 1 张图（172 条） | `sampleId` / `clusterId` / `contentSha256` / `perceptualHash`（dHash）/ 尺寸 | **可直接用**（`extract-docx-weed-samples.mjs` 已实现） |
| 物种名段 | `gold.docxName`，再经 `catalog/species.json` 精确同名 → `labelClass` / `coverage` / `mappingKind` | 可直接用；**需人工核准**（严格同名口径，同属近缘种只进 `nearGroups` 不计数） |
| 形态特征段 | `gold.criteria` + `criteriaSource`（指向来源条目号） | 可直接用；**需人工核准**（是来源文档自述，非权威判据） |
| 图片本体（172 张 PNG，136 087 244 B） | **不入库**：写仓外 + 索引只留 hash / 尺寸 / dHash | **可直接用**（已有约定） |
| 来源文档自身 | `sourceDocSha256` = `624ee4d5…a3b8`（绑定） | **可直接用** |
| — | `annotation.reviewedBy` | **缺失**：当前 `null` ⇒ `#20` AC「独立核实标准答案」**未满足** |
| — | 独立于来源文档的判据 / 答案 | **缺失**：`criteria` 全部取自来源文档 ⇒ 需用户 / 专家 |
| — | 手机实拍 / 多角度 / 背景 | **缺失**：本素材不具备（文档配图，短边中位 540 px，每类 1 张）⇒ 无法由本素材满足第 6.1 节 |

### 2.7 映射缺口汇总

| 缺口类别 | 具体缺失 | 能否用现有三份素材补 |
| --- | --- | --- |
| **用量与安全字段** | `dose_text` / 施用方法 / 注意事项 / 安全间隔期 / `registration_valid_from` / `registration_valid_to` / `restriction_rules` | **不能**：三份素材都没有这些列 ⇒ 只能靠 ICAMA 核准标签原文（外部） |
| **制剂身份字段（部分）** | 现有 20 条来自农业农村部公开公告附表：登记证号 / 名称 / 生产者 / 剂型 / 成分 / 毒性 / 场景 / 对象均 `20/20`；`dose_text` / 施用方法 / 注意事项 / 有效期起止 / 禁限用 **均 `0/20`**（`packages/knowledge/coverage-report.json:40-53`） | **不能**：缺的是列与证据，不是空值 |
| **许可与出处** | `licensed` / 逐条权威 URL / 再分发许可 | **不能**：全部 `licensed=false`，许可调查暂缓 |
| **独立核实** | 样本 `reviewedBy`、资料 `review_status=verified` | **不能**：需第二人 / 植物分类专业人员 / 资料审核人 |
| **场景覆盖** | 20 份独立除草剂登记标签 | **不能**：研究索引 24 条候选，取得完整现行核准标签 = 0 |
| **样本量** | 覆盖内 293 张、逐类 ≥30、低质量 100；其余六域全部为 0 | **不能**：本素材只能贡献 7 张覆盖内，且形态不符 |
| **staging 映射版本** | 杂草总表 9 栏的 `mapping_version` | **不能**（本轮）：`deferred`，需新 `mapping_version` 与校验扩展（见 §4 `C11`） |

---

## 3 缺项台账

**"能否由 AI 自行补齐"一列：一律为「否」，除非有明确依据。** 本表所有行均为「否」，理由逐行给出；理由不足的行不得改判。

| 编号 | 缺口 | 依据（file:line 或 AC 原文） | 需要谁提供 | 能否由 AI 自行补齐 | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| `L01` | **ICAMA 核准标签（用量 / 施用方法 / 注意事项 / 安全间隔期 / 登记有效期 / 禁限用规则）** | `packages/knowledge/coverage-report.json:99-104`（"用药量、施用方法、注意事项未采集（公告附表无此列）"；"未逐条与 ICAMA 登记详情 / 核准标签原文复核"；"ICAMA 登记查询接口本轮程序化访问返回服务器内部错误，未取得逐条详情"）；`docs/verification/gy-i03-zhejiang-materials.md:296`（`absent_in_source`，**严禁**推断或补造用量） | 用户（ICAMA 逐条导出或清晰标签全页）；资料审核人核对 | **否** —— 三份素材无此列；模型/推断补造被明文禁止（`gy-i03-zhejiang-materials.md:296`、`packages/knowledge/zhejiang/README.md:21-23`、`:98`） | **未取得（0 份）**；`dose_text=null`、`usable_as_dose=false`、`card_ready=false` 已如实落库；DoseCard = 0 |
| `L02` | **20 份独立除草剂登记标签** | `#3` scope 原文「20份独立除草剂登记标签为资料目标，缺可靠来源则列不足，不造登记号」；`#3` acceptance 原文「缺失、过期、冲突和未核对不标为有效；不虚构20条已完成」；`docs/research/gy-i03-label-evidence-increment-20261011.md:47`（"20 份独立核准完整标签的目标未达到"，候选 24 条不变） | 用户（官方查询导出或完整清晰标签全页）；无则按"列不足"处理 | **否** —— 需仓外真实标签；研究索引不得自动放行（`…increment…md:49`） | **取得 0 / 20**；研究候选 24 条；此项目标**未达到** |
| `L03` | **独立核实（样本 `reviewedBy` 全为 `null`）** | `packages/evaluation/samples/gy-i20-weeds-labels.json:18`（`"reviewedBy": null`）、`:19`（"尚未进行独立复核"）；`#20` acceptance 原文「独立核实标准答案，模型不得作为自己的答案」；`packages/evaluation/schema/sample.schema.json:102-105`（`modelGenerated` const `false`）；`docs/evaluation/README.md:75`；`docs/evaluation/real-samples-weeds-docx.md:248`；`docs/evaluation/sample-gap-register.md:50-51`、`:68`、`:97` | 独立复核人（植物分类专业人员 / 第二人复标）；资料审核人 | **否** —— 模型不得作为自己的答案（硬约束）；`reliable_label` 不等于 `independent_verification` | **未发生**；`annotation.method=reliable_label`，**不主张已独立核实** |
| `L04` | **覆盖内样本量：7 / 300；逐类 7 / 30（荨麻类 0）** | `docs/evaluation/sample-gap-register.md:18-19`（`weed_photo_covered` 实际 7、缺口 293；`weed_photo_covered_per_class` 最小值口径 0）；`docs/evaluation/real-samples-weeds-docx.md:49-50`、`:80-81`、`:230-231`；`docs/implementation-requirements.md:460`（至少 300 张独立清晰照片且每类至少 30 张，含实际手机照片及不同角度／背景） | 用户提供真实手机实拍（含不同角度 / 背景）；验收方裁定文档配图是否计入（见 §4 `C5`） | **否** —— 需真实新增采集；`#20` scope 原文「均不可用演示样本替代」（`docs/evaluation/sample-gap-register.md:54`） | **缺口 293 张**；逐类**未满足**；`species_nettle_group=0` |
| `L05` | **许可（全部 `licensed=false`）** | `packages/knowledge/coverage-report.json:105`（"许可调查本轮暂缓，所有来源 licensed=false"）；`docs/research/gy-i03-public-label-index-20261011.json:41-42`（`licensed:false`、`license_survey_status:"not_established"`）；`gy-i03-label-evidence-increment-20261011.json:37`（`permission_status`：公开可访问与落地页声明**不构成**再利用 / 训练许可）；`#3` acceptance 原文「许可调查本轮暂缓但不得写成已许可」；`docs/implementation-requirements.md:456` | 权利方 / 资料提供方；用户决定是否启动许可调查（见 §4 `C2`）；法律意见 | **否** —— 许可同意只能由权利方给出；AI 只能如实标 `licensed=false` | **未确立**；原文件不入库；**不得写为已许可** |
| `L06` | **覆盖外 165 张的形态与分组条件** | `docs/evaluation/sample-gap-register.md:20`（程序桶 165 ≥ 100 已满足）、`:37-39`（"来源形态为文档配图而非手机实拍，是否计入由验收方裁定；**不据此主张该要求已达标**"；`quality` 一律 `clear`，仅为"未登记为低质量"）；`docs/implementation-requirements.md:461` | 验收方裁定（见 §4 `C5` / `C14`）；人工目视分级作业者 | **否** —— 需人工裁定与人工分级；本执行环境无图像输入能力（`sample-gap-register.md:49`） | **不主张达标**；`quality` 未人工分级 |
| `L07` | **低质量样本 100 张** | `docs/evaluation/sample-gap-register.md:21`（`weed_photo_low_quality` 实际 0、缺口 100）；`docs/evaluation/real-samples-weeds-docx.md:245-246`（`quality` 一律 `clear`，低质量桶按 0 计） | 用户提供模糊 / 遮挡 / 过暗 / 目标过小照片并定义分组；人工目视分级 | **否** —— 需真实低质量样本与人工分级 | **0 / 100** |
| `L08` | **其余六域真实样本（标签OCR / 登记匹配 / AI筛查 / 播报 / ASR / 问答）** | `docs/evaluation/sample-gap-register.md:22-34`（第 5 至 17 桶全部为 0）、`:43`、`:66`；`#20` scope 原文「AI200风险＋200正常；普通话50段≥10人；TTS30段；问答120题（60可答＋20不足＋20危险＋20注入）」 | 用户 / 采集方按域提供；`C8` 与 §6 切片 | **否** —— 需真实采集与标注；不得用演示样本替代（`sample-gap-register.md:54`） | **六域零真实样本**；冻结清单仅拍草域 |
| `L09` | **20 条已有登记记录的用量相关字段（6 项 0/20）** | `packages/knowledge/coverage-report.json:40-53`（8 字段 `20/20`；`dose_text` / `application_method` / `precautions_text` / `registration_valid_from` / `registration_valid_to` / `restriction_rules` 均 `0/20`）、`:55-57`（`usable_as_dose=0`，`card_eligible=0`，"非编造；但缺用药量…记录状态 partial，禁止作为用药量依据"） | 与 `L01` 同源：ICAMA 核准标签 | **否** —— 公告附表无此列 | **partial**；`usable_as_dose=0`；**禁止作为用药量依据** |
| `L10` | **杂草总表 9 栏的受限暂存 `mapping_version`** | `docs/verification/gy-i03-zhejiang-materials.md:305`（`deferred`，需新 `mapping_version` 与相应校验扩展，本轮不改已合并工具）；`docs/architecture/workbook-staging-design.md:44` | 监工 / 用户确认是否本期做（见 §4 `C11`） | **否（本轮）** —— 越范围改已合并工具；**获 `C11` 确认后属可实现项**，但不在本台账执行范围 | **deferred** |
| `L11` | **作物目录扩充（蔬菜 / 茶园 / 果园 / 蚕豆）** | `docs/verification/gy-i03-zhejiang-materials.md:302`（`blocked_on_scope`：首批 `crop_id` 目录只有 水稻 / 玉米 / 大豆 / 油菜；不自行扩目录，需需求确认） | 用户 / 需求方裁定（见 §4 `C9`） | **否** —— 扩目录等于改覆盖面与契约边界，须先获授权 | **blocked_on_scope**；已入库条目的这些场景 `crop_ids` 为空，正文保留原文 |
| `L12` | **浙江适用性中的 10 行大区泛称（华东 / 南方 / 华南）** | `docs/verification/gy-i03-zhejiang-materials.md:316`（属区划常识推断，需人工复核）；`:304`（10 行大区泛称需人工复核，保留在清单但不入首批库） | 农业 / 区划专业人员或资料审核人复核（见 §4 `C10`） | **否** —— 属人工复核事项；AI 推断不得当作证据 | **需人工复核**；未入首批库 |
| `L13` | **训练（调参）集隔离确认** | `docs/evaluation/real-samples-weeds-docx.md:254-255`（"仅有仓库内证据…**无法证明**该素材未进入任何模型的训练集"）；`packages/evaluation/samples/README.md:76-77`；`docs/evaluation/sample-gap-register.md:53`、`:99`；`docs/implementation-requirements.md:456` | 用户 / 被测模型供应商书面确认（见 §4 `C3`） | **否** —— 是否入训练集只能由素材使用方 / 供应商确认 | **无法证明**；不确认则**不能作独立测试集** |
| `L14` | **付费真实模型实测（`isRealEvaluation=false`）** | `docs/evaluation/real-samples-weeds-docx.md:243-244`；`docs/evaluation/sample-gap-register.md:52`、`:67`；`docs/pr-review-policy.md:42`（新增真实付费请求须用户单独授权）；`packages/knowledge/coverage-report.json:108-110` | 用户单独授权（供应商 / 预算，见 §4 `C13`） | **否** —— 付费外发需用户单独授权 | **未授权、未做**；`gy-i20-weeds-predictions-none.json` 刻意留空；`top1` 必须为 `null` |
| `L15` | **docx 图片的人工目视内容核对与质量分级** | `docs/evaluation/real-samples-weeds-docx.md:245-247`（未做人工目视分级；**未核对画面内容是否确为该物种**）；`docs/evaluation/sample-gap-register.md:48-49` | 人工目视作业者（有图像输入能力的执行环境） | **否** —— 需人工 / 具图像输入能力的环境；本轮不做 | **未做**；`quality` 一律 `clear` |
| `L16` | **八组杂草科普评估内容** | `docs/verification/gy-i03-zhejiang-materials.md:297`（`not_done`；`coverage_state=planned`）；`packages/knowledge/coverage-report.json:106` | 需求方定义评估方案 + 资料审核人核对真实来源 | **否** —— 需既定评估方案与真实来源核对 | **未做** |
| `L17` | **真机 / 双手机证据** | `docs/verification/gy-i03-zhejiang-materials.md:299`；`docs/evaluation/real-samples-weeds-docx.md:252`；`docs/verification/gy-i03-zhejiang-materials.md:313` | 有 Android 真机与联网环境的执行者 | **否** —— 无真机则无证据；模拟器 / Demo 不计真机（`docs/pr-review-policy.md:41`） | **未取得** |

> **说明**：`L14` 与 `L17` 属执行侧 / 验收侧缺项，**不阻塞本台账**，但**阻塞 `#20` 的实测指标**，故一并登记。
> **未登记项（属推断，见 §4 `C1`）**：`Q` 行与 `#3` / `#20` 的**显式绑定**在任务 JSON 中不存在（`docs/initial-issues.json` 只有 `function_ids`(F) 与 `acceptance_ids`(AC) 两类编号），本台账不对 `Q` 绑定下结论。

---

## 4 待确认 C1–C14（**原样列出；未替用户 / 监工拍板**）

> 下表 C1–C14 的「待确认事项」「为什么必须由用户 / 监工定」「建议问法」三列**原样搬运**自仓库外侦察报告。**最后一列「是否阻塞本线」为本台账所加，仅作标记，不改前三列内容。**

| 编号 | 待确认事项 | 为什么必须由用户 / 监工定 | 建议问法（不预设结论） | 是否阻塞本线 |
| --- | --- | --- | --- | --- |
| **C1** | 派单所说的 "Q" 是否即 `docs/implementation-requirements.md` 的 Q 表？#3/#20 各自绑定哪些 Q 行？ | 任务 JSON **无 Q 字段**；侦察按 F-id 交叉定位（Q17 对 F20 等）属推断 | "Q 口径以 Q 表为准还是另有出处？#3/#20 要绑定哪几行？" | 否（仅需记录状态） |
| **C2** | 三份素材的**原始出处、著作权人、再分发与训练许可** | 全仓 `licensed=false`、`license_survey_status=not_established`；许可调查**按用户要求暂缓** | "是否现在启动许可调查？谁去问资料提供方？" | **是（硬阻塞）** |
| **C3** | 素材**是否已进入任何模型的训练集** | `real-samples-weeds-docx.md:254-255` 明示"无法证明"；不确认则**不能作独立测试集** | "被测模型（哪家/哪版）是否用过这三份素材？" | **是（硬阻塞）** |
| **C4** | 是否**放宽** `rawMediaCommitted=false` 以允许少量抽样图片入库？ | 硬红线 + `docs/pr-review-policy.md:29`；放宽等于改治理基线 | "保持 0 媒体入库，还是另开一条显式授权的例外通道？" | 否（但影响 §5.2 最小表示） |
| **C5** | 第6.1节「覆盖内 ≥300 含**实际手机照片**及不同角度/背景」是否**接受文档配图**？ | `sample-gap-register.md:37-38,46-47` 明示"是否计入由验收方裁定" | "文档配图算不算？若不算，手机实拍从哪来？" | **是（硬阻塞）** |
| **C6** | docx 的 `criteria` 与 xlsx 的「识别要点」**是否同源**？能否互为交叉核对？ | 侦察实测 170/172 同名（§1.4），但**同链来源不构成独立核实** | "两者是否同一作者整理？可否作 'cross_checked_original' 的依据？" | 否（影响做法，不构成独立核实） |
| **C7** | 谁担任**独立复核人**（写 `reviewedBy`）？植物分类专业人员从哪来？ | `#20` AC 要求"独立核实标准答案"；`reviewedBy` 现为 `null` | "有无专家/植物志来源？没有则由谁承担？" | **是（硬阻塞）** |
| **C8** | 20 份独立除草剂登记标签由**谁**提供？（ICAMA 逐条导出或清晰标签全页） | `…increment…md:47-49`：目标未达到、取得 0 份；研究索引不能自动放行 | "由用户提供 ICAMA 导出，还是改为列不足不达标？" | **是（硬阻塞）** |
| **C9** | 作物目录是否**扩充**（蔬菜/茶园/果园/蚕豆）？ | `gy-i03-zhejiang-materials.md:302` `blocked_on_scope`：`crop_id` 目录只有 4 类，**不自行扩目录，需需求确认** | "扩目录还是接受 `crop_ids` 为空、正文保留原文？" | 否（部分条目受阻，非本线全阻） |
| **C10** | 浙江适用性中"10 行大区泛称（华东/南方/华南）"是否**采纳**？ | `gy-i03-zhejiang-materials.md:316` 明示属"区划常识推断，需人工复核" | "采纳、剔除，还是单独标 `inferred` 不入首批？" | 否（仅需记录状态） |
| **C11** | 是否为**杂草总表**开发新 `mapping_version` 的 staging 映射？ | `gy-i03-zhejiang-materials.md:305` `deferred`：需新映射版本 + 校验扩展；本轮**不越范围改已合并工具** | "本期做还是继续 deferred？" | 否（仅需记录状态） |
| **C12** | `coverage_state=planned` 的 GY-I03 八组能否作为**模型侧覆盖承诺**？ | `coverage-manifest.json` 的 `note` + `sample-gap-register.md:90`：模型侧独立覆盖承诺**仍待冻结** | "模型侧覆盖承诺何时冻结？变了要新冻结版本" | 否（仅需记录状态） |
| **C13** | 是否授权**付费真实模型调用**以产生 `#20` 的实测指标？ | `real-samples-weeds-docx.md:243`；`coverage-report.json:108-110`；**需用户单独授权** | "现在授权哪些供应商/预算多少？" | 否（属评估执行线） |
| **C14** | 覆盖外 165 张（程序桶已满足 165≥100）**是否主张达标**？ | `sample-gap-register.md:20,37-39` 明示"不据此主张达标"，且 `quality` 一律 `clear` 未人工分级 | "主张、不主张，还是先做人工质量分级？" | 否（属验收裁定） |

### 4.1 阻塞本线的少数几条（**`C2` / `C3` / `C5` / `C7` / `C8`**）

| 编号 | 阻塞什么 | 不解的后果 |
| --- | --- | --- |
| `C2` | 三份素材的出处与许可 | 任何入库 / 发布 / 训练用途都缺权利基础；只能维持 `licensed=false` 与不入库现状 |
| `C3` | 训练集隔离确认 | 素材**不能**作为独立测试集 ⇒ `#20` 的"独立评估"前提不成立 |
| `C5` | 文档配图是否计入覆盖内 ≥300 | `#20` 覆盖内口径无法定案；现有 7 张的去留取决于此 |
| `C7` | 独立复核人来源 | `#20` AC「独立核实标准答案」无法满足；`reviewedBy` 只能维持 `null` |
| `C8` | 20 份独立登记标签的提供方 | `#3` 资料目标与 `#20` 标签OCR 域均无法推进；只能按"列不足"如实记录 |

> 其余 `C1`、`C4`、`C6`、`C9`–`C14` 在本台账中**只记状态、不等结论**；`C4` 与 `C6` 会影响 §5.2 最小表示与 §6 切片的具体做法，但**不构成硬阻塞**。

---

## 5 不得入库清单（15 条，**原样搬运**）与最小表示建议

### 5.1 不得入库项（**逐条给依据；原样搬运自侦察报告 §5.1**）

| 编号 | 不得入库的内容 | 依据 |
| --- | --- | --- |
| G1 | **136MB docx 原始件本体**及其**任何图片本体** | `docs/evaluation/real-samples-weeds-docx.md:19`（"原始 Office 文件与原始媒体**一律不入库**"）；`sample.schema.json:108-111` `rawMediaCommitted` const `false`；`docs/evaluation/README.md:74,82` 硬红线 |
| G2 | **两份 xlsx 原始件本体**及其整表导出 | `packages/knowledge/zhejiang/README.md:16`（原文件与原始媒体不入库）；`workbook-staging-design.md:25`（原 xlsx/JSON/SQL/说明原文仅留本地忽略目录，**不提交公共资料种子**） |
| G3 | **任何密钥 / 真实 .env / 凭据** | `AGENTS.md:35`；`README.md:127`；`docs/pr-review-policy.md:29` |
| G4 | **Word 原稿 / doc 目录 / 个人原始媒体** | `AGENTS.md:35`；`README.md:127`；`docs/pr-review-policy.md:29` |
| G5 | **含个人信息的内容**：聊天目录、账号路径、真实姓名、手机号、真实 URL、原始路径 | `workbook-staging-design.md:45`（`filename` **只存文件名，不存聊天目录或账号路径**）；`sample.schema.json:63-68`（`sourceRef` **不得含个人身份、真实 URL 或原始路径**）；`docs/implementation-requirements.md:276`（日志不记令牌/密码/完整媒体/私人联系方式） |
| G6 | **仓外绝对路径** | `extract-docx-weed-samples.mjs:32-37`（`repoRelativeRef`；仓外路径只留文件名）；仓内派生数据一律用 `repo-external://samples/<文件名>` 相对形式（`db/seeds/seed_zhejiang_materials.sql:12`） |
| G7 | **用量 / 剂量 / 混配换算 / 处方** | `docs/verification/gy-i03-zhejiang-materials.md:296`（**严禁**推断或补造用量）；`workbook-staging-design.md:39`（不能进入用量卡）；`packages/knowledge/zhejiang/README.md:98`（不生成处方、混配、剂量换算） |
| G8 | **未核实许可而写"已许可"** | `docs/verification/gy-i03-zhejiang-materials.md:301`（`licensed=false`，**不得写为已许可**）；`packages/knowledge/zhejiang/README.md:99` 同义；`coverage-report.json:105` |
| G9 | **"绝对安全" / "零药害" 类文案** | `packages/knowledge/zhejiang/README.md:98`；`docs/evaluation/README.md` 相关红线 |
| G10 | **模型生成的"标准答案"** | `sample.schema.json:102-105` `modelGenerated` const `false`；`docs/evaluation/README.md:75` |
| G11 | **合成 / 演示样本冒充真实评估** | `docs/evaluation/README.md:81`；`docs/evaluation/sample-gap-register.md:54`（风险400/ASR50/问答120/TTS30及两类图片**均不可用演示样本替代**） |
| G12 | **暂存行被标成 valid / verified / card_ready** | `workbook-staging-design.md:50`（CHECK 禁止） |
| G13 | **暂存资料进 `v_active_source_version` / 用量卡 / 给 LLM** | `workbook-staging-design.md:39,56` |
| G14 | **原图裁剪 / 连拍跨 split** | `sample.schema.json:40-48`；`docs/evaluation/README.md:76`；`docs/implementation-requirements.md:456` |
| G15 | **付费 / 真实模型调用（未单独授权）** | `coverage-report.json:108-110`；`docs/evaluation/real-samples-weeds-docx.md:243`；`docs/pr-review-policy.md:42` |

> **本台账对侦察报告的两处依据勘误（如实标注）**
> 1. 侦察报告把 G3 / G4 与"数据样本只用获准脱敏索引"一并挂在 `docs/pr-review-policy.md:23`；基线复核后，该内容**不在** `:23`（`:23` 为空行，`:24` 起是"作者提交前清单"说明）。**实际对应**：`:29`（检查完整 diff，无意外文件、冲突标记、密钥／真实 .env、个人原始媒体、依赖或构建输出）、`:42`（真实能力／资料：版本、来源、失败证据及独立样本评估；新增真实付费请求须用户单独授权）。本台账按**勘误后**的行号给出。
> 2. G8 的 `workbook-staging-design.md:75` 在基线上为许可相关段落之外的正文；本台账改用可复核的 `:25`（"来源许可和原文再发布未确认"）与 `:99`（`packages/knowledge/zhejiang/README.md` 的许可暂缓行），并在 §3 `L05` 给出三处可复核依据。

### 5.2 入库的**最小表示**建议

**（a）资料侧（`#3`）—— 已有约定，照抄即可**

```
{ "source_id": "src_<来源稳定名>",
  "source_version": "<语义版本，如 weed-summary-2026.10>",
  "file": "<文件名，不含路径>",
  "file_sha256": "<64 hex>",
  "sheet": "<sheet 名>", "excel_row": <int>, "cell_range": "A2:I2",
  "row_sha256": "<64 hex>",
  "locator": "file=<文件名>;sha256=<hex>;sheet=<sheet>;row=<n>;cells=A2:I2" }
```

依据：`packages/knowledge/zhejiang/README.md:37-55`（逐条来源绑定结构 + `row_sha256` 计算式）。

- **只入派生字段 + 行级可回溯指纹**；原文件留在仓外只读目录。
- `dose_text:null` / `usable_as_dose:false` / `card_ready:false` **显式写出**，不省略 —— 省略会被读成"未采集完"而不是"源表无此列"。

**（b）样本侧（`#20`）—— 已有约定，照抄即可**

```
1) 仓内：脱敏样本索引（sample.schema.json 的 13 个 required 字段）
        + 答案键（labelClass / coverage / mappingKind / criteria / criteriaSource / nearGroups）
        + 覆盖清单（8 个规范物种 ID + basisRef）
        + 冻结清单（indexVersion / split / recordCount / indexSha256 / frozenAt / coverage 绑定块）
2) 仓外：原始媒体 + 本地路径映射（path-map.json） + 逐条诊断报告
3) 索引内只允许出现：hash / dHash / 尺寸 / 脱敏 sourceRef / 标注引用
```

依据：`packages/evaluation/samples/README.md:1-4`；`docs/evaluation/real-samples-weeds-docx.md:19`；`tools/evaluation/extract-docx-weed-samples.mjs:8-12`。

### 5.3 建议的体积上限（**以下为建议，需用户 / 监工拍板，非既有约定**）

| 项 | 既有硬约束 | 本单建议 | 理由 |
| --- | --- | --- | --- |
| 单文件读取上限 | **25,000,000 B**（`workbook-staging-design.md:81`） | **沿用 25 MB**，不回退 | 已合并的确定性负例；撤回会丢负例覆盖 |
| 入库派生 JSON 单文件 | 无明文 | 不超过 1 MB / 文件；超则按物种或批次分片 | 现有 `materials-zhejiang-v1.json` 约 555 KB、`gy-i20-weeds-real-index.json` 约 233 KB 均在此内 |
| 一次 PR 的新增仓内文本体积 | 无明文 | 不超过 2 MB（不含依赖与构建产物） | 审查可读完；`criteria` 全文是主要膨胀源 |
| 仓内新增媒体 | **0 B**（禁入） | **保持 0** | `rawMediaCommitted` const `false` |
| 若确实要入库抽样图片 | 现约定禁止 | **不得由本单放宽** ⇒ 列为待确认 `C4` | 会破 `rawMediaCommitted` 硬红线与 `docs/pr-review-policy.md:29` |

---

## 6 下一步建议切片（≤3 条，每条可独立验收）

> 以下三条沿用侦察报告 §6 的排序与口径，**全部满足统一前置**：
> - 一律从 `upstream/main@24fac03` 开新分支；**不得复用** `GengYun_W22` / `GengYun_W23`（§0.3）。
> - 一律 `Refs #3` / `Refs #20`，**不关闭整项**。
> - 只提交**派生数据或纯文档**；原始件与媒体留仓外；所有 `sourceRef` / `locator` 脱敏（无绝对路径、无真实姓名）。
> - 每条切片**先经监工审查**再合并（`#20` acceptance 原文：「冻结清单、来源、划分与评估口径先经监工审查」）。
> - **本组切片一律不新增付费调用、不入库原始媒体、不改 `packages/contracts/**`。**

### 切片 A（建议先做）—— `#3` / `#20`：把**列映射 + 缺项台账**做成单一事实源

**做什么**

1. 新增 `docs/knowledge/field-mapping-workbooks.md`：把三张 sheet（杂草总表 9 列 / 省份索引表 5 列 / 防除时期速查 4 列）与除草剂 6 列 → 仓内字段的映射**逐列成表**，每列标注三态：`direct` / `needs_review` / `absent_in_source`（源表无此列，**严禁补造**）。
2. 同文件维护缺项台账：把 `docs/verification/gy-i03-zhejiang-materials.md:292-306` 的 11 条缺项与 `packages/knowledge/coverage-report.json:99-107` 的 7 条 `gaps` 合并去重，逐条给「状态 / 依据 file:line / 解除条件」。
3. 只引用既有产物与行号，**不新增任何从素材抽取的数据**（零新数据入库）。

**验收口径**

- `npm run test:docs` 通过。
- 映射表**行数可核**：杂草总表 = 9 行、省份索引表 = 5 行、防除时期速查 = 4 行、除草剂 = 6 行，共 24 行；每行都有三态之一。
- 缺项台账条数不少于 11 + 7 去重后的数量，且**每条都有 file:line 依据**。
- 反例检查：文中**不出现**任何用量 / 剂量数值、任何仓外绝对路径、任何"已许可"表述。

**预计体积 / 文件数**：1 个新 `.md`，约 8–15 KB；0 个媒体文件；0 字节原始数据。
**需谁确认**：监工（合并）；`C1`、`C9`、`C10`、`C11` —— 这些在台账里**只记状态、不等结论**。

### 切片 B —— `#20`：把 docx 与杂草总表的**名称 join** 做成可复算的跨素材核对报告

**做什么**

1. 新增 `tools/evaluation/cross-check-weed-names.mjs`（Node 标准库，零第三方依赖，沿用 `extract-docx-weed-samples.mjs` 的风格）：输入 `packages/evaluation/samples/gy-i20-weeds-labels.json` 的 `docxName` 与仓外 xlsx（`--xlsx <仓外路径>`、`--sheet 杂草总表`）；**只输出计数与差异清单**（intersection / docx-only / xlsx-only，规范化规则写成常量并打印），**不导出任何 xlsx 数据行**；xlsx 路径不入仓、不入报告（只留文件名与 `file_sha256`）。
2. 新增 `docs/evaluation/cross-material-name-check.md`：记录实测结果（侦察已预跑：intersection 170、docx-only 1、xlsx-only 4，规范化 = 去括号别名 + trim）并写入**明确"这不构成独立核实"**的边界声明。
3. 结论只写"可 join 与否"，**不写**"已交叉核实答案"。

**验收口径**

- 命令退出码 0 且**幂等**（连续两次输出逐字节相同）。
- 报告内出现 `intersection=170` / `docx-only=1` / `xlsx-only=4`（或实测值），并给出规范化规则原文。
- **负控制不少于 3 例**：① 篡改 xlsx 名（不匹配）⇒ 计数变化且不崩；② `--xlsx` 指向 `sha256` 不符的文件 ⇒ 拒绝、退出码 1；③ 缺少 `--sheet` 或 sheet 名不存在 ⇒ 拒绝。
- 报告**不含**任何 xlsx 数据行、不含仓外绝对路径。
- 接入现有回归：`node --test tests/evaluation/*.test.mjs` 全绿（新增 1 个测试文件）。

**预计体积 / 文件数**：2 个新文件（1 个 `.mjs` 约 6–10 KB + 1 个 `.md` 约 5–8 KB）+ 1 个测试文件约 4 KB；0 媒体。
**需谁确认**：监工（合并）；`C2` / `C6`（同源性与许可 —— 报告必须写"暂缓 / 未核"）；`C3`（训练集隔离）—— **报告不得据此主张独立核实**。

### 切片 C —— `#20`：把 172 条真实样本的**缺口复算**做成一条可复跑命令（不含任何新素材）

**做什么**

1. 在 `docs/evaluation/sample-gap-register.md` 的既有口径下，新增 `tools/evaluation/report-sample-gaps.mjs --index … --coverage … --out <报告.json>`（或复用 `packages/evaluation/src/gaps.mjs` 补一个 CLI 入口），**把手工表格程序化**，避免表格与索引漂移。
2. 输出同时给**两种覆盖口径**：严格同名（覆盖内 7 / 覆盖外 165）与并入同属近缘种（20）—— **并显式标注冻结与缺口一律按前者**。
3. 报告携带 `indexSha256` 与 `coverageSha256`，与 `packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json` 交叉核对；不一致即退出码 1。

**验收口径**

- 命令退出码 0，输出的 17 个缺口桶与 `docs/evaluation/sample-gap-register.md:16-34` 表**逐格一致**（覆盖内 7 / 293、逐类 0、覆盖外 165、低质量 0、其余 0）。
- **复算一致**：`indexSha256` 与冻结清单一致（`36053ceed50abbeb…c78f`）。
- **负控制不少于 3 例**：① 删掉 1 条样本 ⇒ 计数变化且缺口 +1；② 缩减覆盖清单 ⇒ 拒绝（沿用既有"缩减一律拒绝"语义）；③ 篡改冻结清单 ⇒ 退出码 1。
- 报告**不得**出现 `top1` / `top3` 成绩数值（`isRealEvaluation=false` ⇒ 必须为 `null` / `—`）；不得把 165 覆盖外写成"达标"。

**预计体积 / 文件数**：1 个 `.mjs` 约 6–10 KB（若新增 CLI）+ 可选 1 个测试约 4 KB；0 媒体；不改既有 JSON 产物。
**需谁确认**：监工（合并）；`C5`（文档配图是否计入）、`C14`（覆盖外是否主张达标）、`C12`（模型侧覆盖承诺）—— CLI 只如实输出，**不替验收方裁定**。

### 排序理由与"本轮不建议自派"的三项

| 顺序 | 切片 | 理由 |
| --- | --- | --- |
| 1 | **A**（列映射 + 缺项台账） | 零风险、零新数据，直接服务 `#3` `evidence` 第 1 项（"字段映射…"）与 AC「实际来源和条目清单可复核」；也是 `#20` 覆盖绑定的上游（`#20` 依赖 `GY-I03`） |
| 2 | **B**（docx 与 xlsx 名称 join） | 侦察已实测 170/172，**投入最小、信息增量最大**；为 `C6` / `C7` 的"独立核实"决策提供事实基础；严格只输出计数，不碰内容 |
| 3 | **C**（缺口复算 CLI） | 把已有手工表格变成可复跑证据，直接对上 `#20` `evidence` 第 2 项（"可重复评估命令和预期输出结构"）；**须等 A / B 的治理结论不被推翻**再动 |

**本轮一并建议（不进切片，留作待确认 `C2` / `C8` / `C13`）**：许可调查、20 份标签取得、付费实测 —— 三项都属于"需用户 / 外部资源"的阻塞，**不宜由写手自派**。

---

## 7 未取得项（单列）

| 编号 | 未取得项 | 状态 | 说明 |
| --- | --- | --- | --- |
| U1 | **独立核实的来源**（第二人 / 植物分类专业人员 / 资料审核人） | **未取得** | `reviewedBy` 全为 `null`（`gy-i20-weeds-labels.json:18`）；无权威植物志 / 分类库比对记录（`real-samples-weeds-docx.md:248`）；`sample-gap-register.md:97` 亦列为未完成 |
| U2 | **ICAMA 访问** | **未取得** | 逐条详情未取得；程序化访问本轮返回服务器内部错误（`coverage-report.json:104`）；未与核准标签逐条比对（`gy-i03-zhejiang-materials.md:306`） |
| U3 | **许可状态** | **未确立** | `licensed=false`、`license_survey_status=not_established`（`gy-i03-public-label-index-20261011.json:41-42`）；`permission_status` 明示不构成再利用 / 训练许可（`gy-i03-label-evidence-increment-20261011.json:37`）；许可调查按用户要求暂缓 |
| U4 | **真实已核对资料存量** | **未确立** | 现有资料 `review_status=unverified`（`coverage-report.json:64`）、`authority=none_asserted_by_source`（`packages/knowledge/zhejiang/README.md:97`）；无逐条权威出处（`gy-i03-zhejiang-materials.md:300`） |
| U5 | **真实样本存量（除拍草域）** | **六域为 0** | `sample-gap-register.md:22-34`、`:43` |
| U6 | **覆盖内真实手机照片** | **未取得** | 只有文档配图 7 张（每类 1 张，短边中位 540 px）；无不同角度 / 背景（`real-samples-weeds-docx.md:249`） |
| U7 | **低质量样本 100 张与人工质量分级** | **未取得 / 未做** | `sample-gap-register.md:21`、`:48-49` |
| U8 | **docx 图片的目视内容核对与像素尺寸复核** | **未做 / 未复核** | 未解出任何图片；只测字节体量与短边登记值（`real-samples-weeds-docx.md:83` 记短边 317–697 px，侦察未复核） |
| U9 | **训练 / 测试隔离的外部证明** | **无法证明** | `real-samples-weeds-docx.md:254-255`；`packages/evaluation/samples/README.md:76-77` |
| U10 | **付费真实模型实测指标** | **未授权、未做** | `real-samples-weeds-docx.md:243`；`sample-gap-register.md:67`；`isRealEvaluation=false`、门禁 `not_evaluated`、`top1=null` |
| U11 | **真机（双手机 / Android 真机）证据** | **未取得** | `gy-i03-zhejiang-materials.md:299`、`:313`；`real-samples-weeds-docx.md:252` |
| U12 | **云库 / 受控 HTTPS / 正式 `real` 启动** | **未做** | `gy-i03-zhejiang-materials.md:298`；`coverage-report.json:108-110`（`database.connected=false`） |
| U13 | **列映射的第一手复核** | **部分未做** | 侦察只读 sheet 名、维度、行数与**前 3 行表头**，**未导出任何数据行、未统计取值分布**；`#3` 侧学名 / 科属与权威学名的比对未做（§2.1） |
| U14 | **`Q` 行与 `#3` / `#20` 的显式绑定** | **属推断，未确认** | 任务 JSON 只有 F / AC 两类编号（`docs/initial-issues.json`）；见 §4 `C1` |
| U15 | **本台账与指挥 / 监工既有口径的交叉比对** | **未做** | 本轮只做仓库内只读核对与文档落账，未发评论、未开 PR、未与监工交叉比对 |

> **另记一条仓库内观察（不阻断本线，供监工核对）**：答案键的 `annotatorRef` 实为 `docx_weeds_v1`（`packages/evaluation/samples/gy-i20-weeds-labels.json:16`），而 `docs/evaluation/real-samples-weeds-docx.md:122` 写作 `docx_weeds_v1_source_label`。两处对同一字段的描述不一致，**建议由 `#20` 后续切片一并核对**；本台账只如实登记，不改动任何一侧。

---

## 8 诚实边界（**必须整段保留**）

> 1. **本文档是缺项台账，不构成 `#3` / `#20` 的验收结论。** 它只登记"已有什么、缺什么、缺的谁来给"，不对任何整项下验收判定。
> 2. **本文档没有声称资料 / 样本已就绪。** §1 登记的是**已合入 main 的管线与派生数据**；§3 / §7 登记的是**仍然缺的**。
> 3. **用量与安全字段绝不补造。** 三份素材**根本没有**这些列；只能依赖 ICAMA 核准标签原文（外部），且 `dose_text:null` / `usable_as_dose:false` / `card_ready:false` 必须**显式**保留。任何"推断用量""为凑卡片补列"都属禁止项（§5.1 G7）。
> 4. **本文档不主张任何"已达标"。** 尤其：覆盖外 165 张**不据此主张达标**（`C14`、`L06`）；172 条样本**不主张已独立核实**（`L03`）；159 条入库条目**不主张已核来源**（`review_status=unverified`）。
> 5. **本文档不代表许可状态有任何变化。** 全部来源维持 `licensed=false`；**不得写为已许可**。
> 6. **本文档不替用户 / 监工拍板。** §4 的 C1–C14 原样列出，未作结论；§5.3 的体积上限是**建议**而非既有约定。
> 7. **本文档未改任何代码 / 素材 / 契约 / CI。** 本次改动仅新增本文档 1 个文件；未 push、未合并、未 force；未读取或打印任何密钥；未把私密素材内容写入本文档（只有文件名、字节数、`sha256`）。
> 8. **本文档对侦察报告的引用已做基线复核，并如实标注 2 处依据勘误**（见 §5.1 下方说明）。其余 `file:line` 均在基线 `24fac03` 上逐条核对。

---

## 9 复核用命令（只读，可复现本台账关键数字）

```bash
# 0) 基线
git log --oneline -1 upstream/main            # -> 24fac03
git log --oneline --grep='GY-I03' 24fac03     # -> a15a7f1 (#131)
git log --oneline --grep='GY-I20' 24fac03     # -> de1004c (#130)

# 1) #20 样本与答案键计数 / 治理字段
node -e "const j=require('./packages/evaluation/samples/gy-i20-weeds-labels.json');console.log(j.entries.length, j.annotation)"
node -e "const j=require('./packages/evaluation/samples/gy-i20-weeds-frozen-manifest.json');console.log(j.recordCount, j.indexSha256, j.split)"

# 2) #3 清单计数
node -e "const j=require('./packages/knowledge/zhejiang/materials-zhejiang-v1.json');console.log(j.weed_items.length, j.control_timing_items.length, j.herbicide_items.length, j.gaps.length)"

# 3) 许可与缺口
node -e "const j=require('./packages/knowledge/coverage-report.json');console.log(j.zhejiang_first_batch.review_status, j.gaps)"

# 4) 门禁（纯文档改动）
npm run test:docs
git diff --name-only upstream/main...HEAD
git status --short
git diff --check upstream/main...HEAD
```

*台账结束。本文档为缺项登记与治理边界记录，不含任何新增抽取数据，不构成验收结论。*
