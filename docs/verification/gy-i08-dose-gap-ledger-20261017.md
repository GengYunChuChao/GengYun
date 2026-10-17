# GY-I08 剂量缺口台账（真实用量正例 N=0）

- 台账日期：**2026-10-17**（实测 `Get-Date -Format o` ⇒ `2026-10-17T18:15:54+08:00`）。
- 测量快照：`upstream/main` = `6c2200087ae5f8841a04505cb1c226284cee7f1b`；本表由工作树 `GengYun_W08vac` 实测，
  **未改动 `packages/knowledge/**` 任何数据**，也**未**为让守卫变绿而补写剂量。
- 正例口径（谓词，与 `tests/reference/i08-dose-empty-vacuous-guard.test.mjs` 同一实现）：
  `usable_as_dose === true` **且** `dose_text` 为非空字符串；任一不成立即**非正例**。

## 1 正例计数 N 与两源计数

| 来源 | 条目 | `usable_as_dose=true` | `dose_text` 非空 | `dose_status` 有值 | 正例 |
| --- | --- | --- | --- | --- | --- |
| A `packages/knowledge/herbicides/records-2026.json`（`records`） | 20 | 0 | 0（`dose_text` 键整体缺席） | 0（`dose_status` 键整体缺席） | 0 |
| B `packages/knowledge/zhejiang/materials-zhejiang-v1.json`（`herbicide_items`） | 96 | 0 | 0（96/96 为 `null`） | 96（96/96 = `absent_in_source`） | 0 |
| 合计 | 116 | 0 | 0 | 96 | **0** |

实测命令（只读；输出即下表读数）：

```powershell
node --test tests/reference/i08-dose-empty-vacuous-guard.test.mjs
# [GY-I08] 真实用量正例 N=0（A 正例 0；B 正例 0）｜A 20 条：usable_as_dose=true 0、dose_text 非空 0、dose_status 有值 0（缺项状态词 0）｜B 96 条：usable_as_dose=true 0、dose_text 非空 0、dose_status 有值 96（缺项状态词 96）
# [GY-I08] 真实资料用量卡可渲染计数=0（逐条 55 条；B 首批 35 条）
# [GY-I08] 剂量串回查：数据侧 1 个、产出侧 180 段文本、编造 0 个；正例控制（夹具）产出 40克
```

「逐条 55 条」＝源 A 20 条 ＋ 浙江首批 `herbicide_applicability` 35 条（96 条原表按首批清单筛选进入 35 条）。
「数据侧 1 个」剂量串＝浙江原文里既有的 `240克`（不是剂量列，仅说明回查不是恒空比对）。

## 2 核准标签 0 份、可用剂量卡 0 张

来源 `docs/research/gy-i03-public-label-index-20261011.json`（`observed_at` = `2026-10-11`，24 条标签）：

```powershell
node -e "const d=require('./docs/research/gy-i03-public-label-index-20261011.json');console.log('labels='+d.labels.length,'approved_labels='+d.labels.filter(l=>l.reviewedBy!=null&&l.licensed===true).length,'usable_dose_cards='+d.summary.usable_dose_cards,'complete_approved_current_labels_delivered='+d.summary.complete_approved_current_labels_delivered)"
# labels=24 approved_labels=0 usable_dose_cards=0 complete_approved_current_labels_delivered=0
```

- **20 份核准标签 = 0**（`complete_approved_current_labels_delivered: 0`；24 条标签里没有一条带 `reviewedBy`／`licensed` 键）。
- **usable dose cards = 0**（`summary.usable_dose_cards: 0`；24 条里带剂量类字段的 0 条）。

## 3 未取得项（逐条）

1. **真实标签原文剂量**：两源 dose 族字段全空或整体缺席，数字、单位、原文条件均未取得。**不可由本仓推断补足。**
2. **20 份独立核准标签**：正文只读到 1 份（`existing_seed_label_bodies_read: 1`），其余 19 份未取得（`existing_seed_label_bodies_not_obtained: 19`）。**不可由本仓推断补足。**
3. **合格（`reviewedBy` 非空且 `licensed=true`）标签 0 份**：授权与复核均未发生，不得把整理稿当核准原文。**不可由本仓推断补足。**
4. **浙江 96 条的审核状态**：全部 `unverified`／`private`（清单自述「整理稿、未逐条核对权威出处」）。**不可由本仓推断补足。**
5. **真机侧展示／朗读实测**：本片只跑仓库内 Node 检查；Android 真机、微信开发者工具、真机 TTS 上的剂量卡展示与朗读**未实测**。**不可由本仓推断补足。**
6. **PG 侧复算「usable dose cards=0」**：本片未起 PostgreSQL 栈，读数取仓内标签索引 `summary` 与两源数据，**未重新落库复算**。**不可由本仓推断补足。**

## 4 机器登记行

剂量真实正例数（N，机器登记行）=0

（`tests/reference/i08-dose-empty-vacuous-guard.test.mjs` 解析本行并与实测 N 比对：数据变化而未同步本行 ⇒ 该用例转红。）

## 5 结论

**N=0 是「缺项」，不是「通过」**：现有「用量守卫全绿」在真实资料上属**空真** —— 两源 116 条里没有一条能产出用量卡，
只有内存合成夹具能产出（`40克/公顷`，`苗后茎叶喷雾`）。补齐真实剂量与核准标签前，对外只能给「缺项／未取得，不补造」；
不得为了让守卫变绿而写入任何剂量或换算。
