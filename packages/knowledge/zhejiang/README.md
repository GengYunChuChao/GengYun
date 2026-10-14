# 浙江首批资料（GY-I03 / #3）

本目录是**浙江首批资料清单**的可复核派生数据：从用户提供的两份真实工作簿中抽出浙江适用的
杂草、防除时期与除草剂适用条目，**逐条带来源定位与行哈希**。

- 清单：`materials-zhejiang-v1.json`（schema `gengyun.knowledge.zhejiang-materials.v1`）
- 抽取器：`tools/knowledge/extract_zhejiang_materials.py`（仅标准库，读仓外样本）
- 校验器：`tools/knowledge/validate_zhejiang_materials.py`（离线校验 + 可选重算比对）
- 负例自测：`tools/knowledge/test_zhejiang_materials.py`
- 库内落地：`db/seeds/seed_zhejiang_materials.sql`、`db/seeds/rollback_zhejiang_materials.sql`
- 证据页：[docs/verification/gy-i03-zhejiang-materials.md](../../docs/verification/gy-i03-zhejiang-materials.md)

## 结论先行

1. **来源真实**：两份工作簿为仓外只读样本，清单登记文件名 + sha256 + 工作表 + 行号 + 单元格
   范围 + 行指纹；原文件与原始媒体**不入库**。
2. **浙江适用性有依据**：只用源字段的显式证据分级，不做插值猜测：
   - 浙江行（省份索引表 r12）显式列出 118 个杂草名，且所属大区为「长江中下游稻区」；
   - 杂草总表 118 行「分布省份」字段显式含浙江，与省名单互为交叉验证；
   - 除草剂只在「适用／常用地区」字段出现 浙江／长江中下游 时才进首批（35/96）。
3. **用量缺项不得补造**：两份工作簿**没有**「标签原文用量」列，清单不抽取、不推断任何
   用量/施用方法/注意事项/安全间隔期，`dose_text` 显式为 `null`，`usable_as_dose=false`、
   `card_ready=false`。**不得作为用药量依据。**

## 抽取结果（release 2026-10-14）

| 项 | 数量 | 说明 |
| --- | --- | --- |
| 杂草总表数据行 | 175 | 源表全量 |
| 浙江适用杂草条目 | **119** | 118 行分布字段显式含浙江 + 1 行为同名（name_only，已单独标注） |
| 省份索引表浙江杂草名 | 118 | 全部可在杂草总表定位（无未解析名） |
| 防除时期速查数据行 | 14 | 5 行与浙江主要作物一致（水稻移栽/直播、油菜、蔬菜、果园／茶园），9 行本工作簿未给出与浙江的对应关系 |
| 除草剂数据行 | 96 | 2 行地区字段显式含浙江 + 33 行含长江中下游/长江流域（跨表与浙江所属大区一致）= **首批 35**；10 行为大区泛称（需人工复核）；51 行无浙江证据 |
| 说明与使用提示约束行 | 14 | 含「用量必须以登记信息与产品标签为准」「不构成农药使用推荐」等源表自述约束 |
| 入库条目（已证据项） | **159** | 119 杂草 + 5 防除时期 + 35 除草剂 |

## 逐条来源绑定方式

每条记录（含省份索引行本身）都带同一结构的 `source`：

```json
{
  "source_id": "src_gengyun_weed_summary_workbook",
  "source_version": "weed-summary-2026.10",
  "file": "中国各省份农田常见杂草识别与防除时期汇总表.xlsx",
  "file_sha256": "e708577e…c420",
  "sheet": "杂草总表", "excel_row": 2, "cell_range": "A2:I2",
  "row_sha256": "…64 位十六进制…",
  "locator": "file=…;sha256=…;sheet=杂草总表;row=2;cells=A2:I2"
}
```

`row_sha256 = sha256(json.dumps({"sheet","excel_row","cells"}, ensure_ascii=False, sort_keys=True,
separators=(",",":")))`，`cells` 为该行「坐标 → 值」映射（共享字符串/内联字符串已解析）。
复核方式：给出仓外样本目录后运行 `--samples-dir` 重算并逐字节比对（见下）。

## 复核与回归

```bash
# 1) 离线结构校验（CI 可跑，不需样本）：来源可回源、用量缺项未被补造、覆盖自洽、种子/回滚一致
python tools/knowledge/validate_zhejiang_materials.py --root .

# 2) 用仓外样本确定性重算并逐字节比对（需只读样本目录）
python tools/knowledge/validate_zhejiang_materials.py --root . --samples-dir <仓外样本目录>

# 3) 从仓外样本重新生成清单
python tools/knowledge/extract_zhejiang_materials.py --samples-dir <仓外样本目录>

# 4) 负例自测（14 例：补造用量、行指纹截断、来源未登记、覆盖漂移、必列缺项被删、种子/回滚越界…）
python tools/knowledge/test_zhejiang_materials.py --root .

# 5) 种子/回滚 SQL 由清单确定性生成
python tools/knowledge/build_seeds.py --root .
```

## 库内落地（复用既有适配层，不新增迁移）

清单写入 **0002 已有**的表，语义与既有 20 条记录一致：

- `sources` / `source_versions`：来源与版本，`review_status=unverified`、`validity=valid`
  → **不进** `v_active_source_version`（未核对不得当权威），只出现在 `v_queryable_seed_version`（stub 联调须标注未核对）；
- `knowledge_versions`：条目正文（`type` 为 `species`／`scheme`／`herbicide`），
  `region_codes=["330000"]`、`visibility='private'`（未发布）；
- `catalog_import_runs` / `catalog_source_update_events`：批次导入审计与来源事件；
- 幂等：uuid5 确定性 id + `ON CONFLICT (id) DO NOTHING`（二次执行行数不变）；
- 精确回滚：`rollback_zhejiang_materials.sql` 只删本批次 id，不触碰其他种子、脱敏样例或
  `knowledge_staging` 批次。

**边界**：`applicability`／`formulations`／`registrations` 本轮**未新增行**——工作簿没有登记证号、
剂型、用量与施用方法，无法满足 `card_ready` 与制剂最小字段；不得为凑卡片而补造。
受限暂存（0004/0007）本轮只对`市面常见除草剂…xlsx`（其映射版本 `herbicide-summary-v1` 已合）
做了真实样本 intake；杂草总表 9 栏需要新映射版本，本轮不越范围修改已合并的暂存工具（见证据页缺项）。

## 边界与禁止事项

- 只消费 `packages/contracts/*`，不修改契约；不新增迁移，不改 `packages/knowledge/catalog/*` 既有目录。
- 不造来源、不虚构 URL/机构；工作簿为整理稿，`authority=none_asserted_by_source`。
- 不生成处方、混配、剂量换算；文案不出现「绝对安全」「零药害」。
- 许可调查仍暂缓（`licensed=false`），原文件不入库，不得写为已许可。
