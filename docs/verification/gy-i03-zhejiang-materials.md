# GY-I03 浙江首批资料清单与可替换数据库适配（#3）验证证据

- 日期：2026-10-14（香港时间）
- issue：[#3](https://github.com/GengYunChuChao/GengYun/issues/3)（P0/M1，**本页不关闭整项**）
- 分支：`feat/gy-i03-zhejiang-materials`；worktree：`E:\GengYunCommander\GengYun_W22`
- 基线：`upstream/main` = `1fc0308818b85227078d43b6246d006cb2aead7f`
- 本分支：`feat/gy-i03-zhejiang-materials`（HEAD SHA 随提交在交接与 PR 中回传；文档不自指自身提交 SHA）
- 本页只记录**实际运行**的命令与结果；未运行、未接入的项在下文明确写为未完成。

> 结论先行：浙江适用条目已从**用户提供的两份真实工作簿**确定性抽出，逐条带
> `文件 sha256 + 工作表 + 行号 + 单元格范围 + 行指纹`，并接入**既有** 0002 适配层
> （幂等种子 + 批次精确回滚，本机 PostgreSQL 17.11 与本仓库既有 PGlite 回归均实测）。
> 用量/DoseCard、八组科普评估、云库/受控 HTTPS/正式 `real`/双手机真机**均未取得**，
> 不因本交付关闭 #3。

## 1 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/knowledge/zhejiang/materials-zhejiang-v1.json` | 浙江首批资料清单（543607 B，逐条带来源定位与行指纹） |
| `packages/knowledge/zhejiang/README.md` | 清单说明、选取规则、复现与边界 |
| `tools/knowledge/extract_zhejiang_materials.py` | 抽取器（只读仓外样本，确定性输出） |
| `tools/knowledge/validate_zhejiang_materials.py` | 校验器（离线结构校验 + 可选重算比对） |
| `tools/knowledge/test_zhejiang_materials.py` | 负例自测（14 例） |
| `db/seeds/seed_zhejiang_materials.sql` | 幂等种子（159 条，复用 0002 表与语义） |
| `db/seeds/rollback_zhejiang_materials.sql` | 本批次精确回滚 |
| `tests/unit/gy-i03-db.test.mjs` | 新增 1 例：种子幂等／用量门／精确回滚 |
| `tools/knowledge/build_seeds.py` | 扩展：新增浙江清单 → 种子/回滚两个产出（既有 4 个产出字节不变） |
| `tools/knowledge/pglite_verify.mjs` | 扩展 3b 段；并把迁移范围显式限定为 0001→0003（见 §6.5） |
| `packages/knowledge/coverage-report.json` | 新增 `zhejiang_first_batch` 覆盖/缺项块（与清单同步受校验器约束） |

**未改**：`packages/contracts/**`、`services/api/db/migrations/**`、`services/api/**`、他人已合并实现。

## 2 来源身份（可独立复核）

原文件在仓库外只读目录，**不提交**；仓内只有派生条目。用系统自带哈希独立复核（非本工具输出）：

```text
PS> Get-FileHash <样本目录>\*.xlsx -Algorithm SHA256
e708577e1cd035b435686c8d249209aa96d345d86a33a9a870e01cd6cdddc420  中国各省份农田常见杂草识别与防除时期汇总表.xlsx
c4905d850b3750c712b10fd8278b5029448a651308fb92c186df604a527c9e70  市面常见除草剂环境风险与适用信息汇总表.xlsx
```

与仓外 `MANIFEST.md` 登记值、与清单 `sources[].file.sha256`、与种子 `source_versions.content_hash` 一致
（抽取器在读取时强制校验，不符即失败退出）。路径映射不写入仓库。

## 3 逐条来源绑定（本批次的可复核方式）

每条记录（含省份索引行）都带同一结构的 `source`：

```json
{ "source_id": "src_gengyun_weed_summary_workbook", "source_version": "weed-summary-2026.10",
  "file": "中国各省份农田常见杂草识别与防除时期汇总表.xlsx", "file_sha256": "e708577e…c420",
  "sheet": "杂草总表", "excel_row": 2, "cell_range": "A2:I2",
  "row_sha256": "…64 位十六进制…",
  "locator": "file=…;sha256=…;sheet=杂草总表;row=2;cells=A2:I2" }
```

行指纹定义：`row_sha256 = sha256(json.dumps({"sheet","excel_row","cells"}, ensure_ascii=False,
sort_keys=True, separators=(",",":")))`，`cells` 为该行「坐标 → 值」（共享字符串/内联字符串已解析）。
普通 CI 可离线校验结构；有样本目录时可**确定性重算并逐字节比对**（§6.2，本次结果 `identical`）。

## 4 浙江适用性判定与结果（只按源字段显式证据，不插值）

| 选取器 | 依据 | 结果 |
| --- | --- | --- |
| 省份索引表浙江行（r12） | 显式列出 118 个杂草名，所属大区「长江中下游稻区」，主要作物：水稻、油菜、蔬菜、茶园、果园、蚕豆 | 118 名全部可在杂草总表定位（无未解析名） |
| 杂草总表「分布省份」含浙江 | 显式字段证据 | 118 行 |
| 两者并集 | — | **119 条**（多出 1 条为同名 `狗尾草（莠狗尾草／巨大狗尾草）` r45：省名单命中主名但该行分布字段不含浙江，已标 `zhejiang_evidence_strength=name_only` 并在覆盖表中单列） |
| 防除时期速查 | 场景作物与浙江主要作物一致：水稻（移栽田）、水稻（直播田）、油菜、蔬菜、果园／茶园 | 5/14 进首批；其余 9 行标 `no_zhejiang_link_in_workbook` 并保留 |
| 除草剂「适用／常用地区」 | ①显式含浙江：丙草胺(r40)、敌草胺(r44)；②含长江中下游/长江流域 33 行，与浙江行所属大区一致 | **35/96 进首批**；10 行仅大区泛称（华东/华中/南方/华南）标 `regional_inference` 需人工复核；51 行无浙江证据 |

工作簿**没有**登记证号、剂型、用量、施用方法列，因此本批次**不新增** `formulations`／
`registrations`／`applicability` 行——不得为凑 `card_ready` 卡片补造制剂最小字段。

## 5 数据库接入（复用既有机制，不新增迁移）

- 复用 **0002** 的 `sources`／`source_versions`／`knowledge_versions`／`catalog_import_runs`／
  `catalog_source_update_events`，条目 `region_codes=["330000"]`、`visibility='private'`，
  `review_status=unverified`、`validity=valid`；
- 语义门：`v_active_source_version` **不含**本批次（未核对不得当权威），只出现在
  `v_queryable_seed_version`（stub 联调须标注未核对）；
- 幂等：uuid5 确定性 id + `ON CONFLICT (id) DO NOTHING`；
- 精确回滚：`rollback_zhejiang_materials.sql` 只删本批次 id（含解除 `sources.current_version_id` 引用），
  不触碰其他种子、脱敏样例、`knowledge_staging` 批次；其他种子行数在回滚前后不变（§6.7 实测）；
- 受限暂存（0004/0007）：对`市面常见除草剂…xlsx`沿用已合并的 `herbicide-summary-v1` 映射版本做了
  **真实文件** intake（§6.6）；杂草总表 9 栏需要新映射版本，本轮**不越范围**修改已合并的暂存工具。

## 6 实测命令与原始输出

### 6.1 抽取（确定性）

```text
PS> python tools/knowledge/extract_zhejiang_materials.py --samples-dir <样本目录>
wrote packages\knowledge\zhejiang\materials-zhejiang-v1.json: 543607 bytes
  control_timing_items_linked_to_zhejiang = 5
  control_timing_items_unlinked = 9
  control_timing_rows_total = 14
  herbicide_explicit_zhejiang = 2
  herbicide_first_batch = 35
  herbicide_not_evidenced = 51
  herbicide_regional_inference = 10
  herbicide_rows_total = 96
  herbicide_yangtze_xref = 33
  province_index_names_unresolved_in_master = []
  province_index_weed_names = 118
  rows_with_row_sha256 = 244
  usage_note_rows_selected = 14
  weed_items_selected = 119
  weed_master_rows_total = 175
  weed_name_only_examples = ['狗尾草（莠狗尾草／巨大狗尾草）']
  weed_selected_name_only = 1
  weed_selected_with_distribution_evidence = 118
```

### 6.2 校验（离线 + 仓外样本重算比对）

```text
PS> python tools/knowledge/validate_zhejiang_materials.py --root .
  control_timing_items = 14 ... weed_items = 119, db_target_items = 159, gaps = 8
  coverage_report_synced = True
PASS: 来源可回源、用量缺项未被补造、覆盖自洽、种子与回滚一致

PS> python tools/knowledge/validate_zhejiang_materials.py --root . --samples-dir <样本目录>
  recompute_from_samples = identical
  recomputed_sha256 = 56f0689580e8669c08036dd478ef466c172f5354e254910ebb72880e083a53dc
PASS

PS> python tools/knowledge/extract_zhejiang_materials.py --samples-dir <样本目录> --verify
verify: committed=405188B recomputed=405188B identical=True
PASS: 清单可由仓外样本确定性重算
```

### 6.3 负例自测（14 例全部被拒绝）

```text
PS> python tools/knowledge/test_zhejiang_materials.py --root .
[PASS] 补造用量 dose_text: 拒绝 (2 errors)
[PASS] 缺项状态被改成 present: 拒绝 (1 errors)
[PASS] 行指纹被截断: 拒绝
[PASS] 来源文件哈希不符: 拒绝
[PASS] 来源未登记: 拒绝
[PASS] item_id 重复: 拒绝
[PASS] 条目缺来源引用: 拒绝
[PASS] 覆盖统计漂移: 拒绝 (声明 120，实际 119)
[PASS] 浙江省代码被改错: 拒绝
[PASS] 必列缺项被删除: 拒绝（gaps 缺必列缺项：['gap-dose']）
[PASS] 来源被标为 verified: 拒绝
[PASS] 种子缺条目(JSON 与 SQL 不一致): 拒绝
[PASS] 种子写入非空用量: 拒绝
[PASS] 回滚越范围删除其他表: 拒绝（触碰 formulations）
14/14 负例被拒绝
```

### 6.4 既有资料子域回归（未被本改动破坏）

```text
PS> python tools/knowledge/validate_knowledge.py --root .        → PASS（区划102/作物4/物种8/来源3/记录20）
PS> python tools/knowledge/test_knowledge.py --root .            → 6/6 负例被拒绝
PS> python tools/knowledge/adapter_demo.py --root .              → PASS（active=0、缺用量不产卡片、冲突阻断、回滚幂等）
PS> python tools/knowledge/build_seeds.py --root .               → 二次生成；既有 4 个种子 git diff 为空（字节不变）
```

### 6.5 PGlite 内存引擎回归（既有工具，扩展 3b 段）

```text
PS> node tools/knowledge/pglite_verify.mjs
DEFAULT_MIGRATIONS_DIR = <repo>\services\api\db\migrations\
运行器发现 = 0001…0010（10 个）
本次应用 = 0001_initial_schema.sql, 0002_knowledge_catalog.sql, 0003_privacy_consent.sql
显式跳过（超出本回归范围，未在本工具验证）= 0004…0010
PASS 种子 ×2 幂等（sources=3/versions=5/crops=4/species=8/regions=102/formulations=22/registrations=22/applicability=22）
PASS 浙江种子 ×2 幂等（knowledge_versions=159；sources=5；source_versions=7；import_runs=1；events=2）
PASS v_queryable_seed_version = 原 +2；v_active_source_version 仍为空；region_codes=[330000] 且 visibility=private
PASS 无非空 dose_text / 全部显式 dose_text null / 无 usable_as_dose=true / 无 card_ready=true
PASS 负例：补造用量行被门检出（1）→ 删除
PASS 回滚 ×2：knowledge_versions=0、sources/source_versions 复原、import_run=reverted、其他种子 registrations 不变
PASS 脱敏样例 ×2 / FK 负例 23503 / 原种子回滚 ×2 / 0002 down
ALL CHECKS PASSED（85 PASS / 0 FAIL）
```

**对既有工具的必要修正（须审查）**：当前 main 的迁移已到 `0010`，而本回归的既定范围是
GY-I03 资料子域（0001→0002，含同分支 0003）。原实现用 `for (const m of discovered)` 执行**全部**
发现的迁移，因此在当前 main 上直接崩溃于 `0007_staging_intake.sql`（`extension "pgcrypto" is not
available`，PGlite 不提供该扩展）。本次把执行范围显式限定为 `version <= "0003"` 并**打印跳过清单**，
不把「跳过」写成「通过」；0004+ 的运行交接仍由
[数据库运行交接](database-run-handoff.md) 负责。该失败在本改动之前即存在（可复现：
在 `0010` 的 main 上直接运行未改动的 `pglite_verify.mjs`）。

### 6.6 受限暂存（0004/0007）真实文件 intake

```text
PS> python tools/knowledge/import_workbook_staging.py "<样本目录>\市面常见除草剂环境风险与适用信息汇总表.xlsx" --output .local\gy-i03-intake-herb
{"data_rows": 96, "missing_by_header": {6 个表头均 0}, "duplicate_name_groups": 0, "quarantined_rows": 0,
 "formula_cells": 0, "comment_part_count": 0, "merged_count": 0, "macro_present": false,
 "external_links_present": false, "source_url_column_present": false, "registration_column_present": false,
 "sheets": [{"name": "除草剂汇总表", "nonempty_rows": 97}, {"name": "说明与使用提示", "nonempty_rows": 19}]}
# 产出（保持在仓库外/.local，不入库）：staging.json 290023 B、import.sql 218850 B
# batch_id（uuid5(file_sha256 + ':' + mapping_version)）= a18dcfec-ab5f-581f-88fe-5ba7b3300940
# rollback.sql = BEGIN; DELETE FROM knowledge_staging.workbook_batches WHERE id='a18dcfec-…'; COMMIT;
```

**负数（能力边界）**：把同一 CLI 用于杂草工作簿时被正确拒绝，因为已合并的映射版本只有一个：

```text
PS> python tools/knowledge/import_workbook_staging.py "<样本目录>\中国各省份农田常见杂草识别与防除时期汇总表.xlsx" --output .local\gy-i03-intake-weeds
ValueError: EXPECTED_TABLE_MISSING_OR_MERGED
```

⇒ 杂草总表 9 栏的受限暂存需要**新的映射版本**（并需相应 `staging_intake` 校验放宽），本轮不改
已合并工具、不自行扩范围；已列为缺项（§8）。

### 6.7 本机隔离 PostgreSQL 17.11 重放（真实实库）

自建**全新、专用、独立**集群（自有数据目录 `E:\GengYunCommander\.w22-i03-pg\data`、自有端口 55433、
仅回环、trust），不接管、不读取任何他人实例与凭据；脚本最后 `pg_ctl -m fast stop` 停止。
客户端编码 `PGCLIENTENCODING=UTF8`（中文条目往返见下 `zj_titles_utf8_ok`）。

```text
PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit
---- 0001_initial_schema exit=0
---- 0002_knowledge_catalog exit=0
---- seed_reference #1 exit=0
---- seed_herbicides_verified #1 exit=0
---- seed_simulation #1 exit=0
---- seed_zhejiang_materials #1 exit=0
---- seed_zhejiang_materials #2 (idempotent) exit=0
---- counts after zhejiang seed (#1/#2 idempotent) ----
 card_ready_true              | 0
 catalog_import_runs          | 1
 catalog_source_update_events | 2
 dose_leak_rows               | 0
 dose_null_rows               | 159
 formulations                 | 22
 import_runs_succeeded        | 1
 knowledge_versions           | 159
 region_330000_private_rows   | 159
 registrations                | 22
 source_versions              | 7
 sources                      | 5
 usable_as_dose_true          | 0
 v_active_source_version      | 0
 v_queryable_seed_version     | 6
 zj_knowledge                 | 159
 zj_titles_utf8_ok            | 159
---- negative: fabricated dosage row must be detectable ----
 INSERT 0 1 ; dose_leak_rows_after_bad_insert | 1 ; DELETE 1
---- FK negative: knowledge_versions -> missing source_version (expect 23503) ----
 ERROR: insert or update on table "knowledge_versions" violates foreign key constraint
        "knowledge_versions_source_version_id_fkey"
 DETAIL: Key (source_version_id)=(00000000-0000-0000-0000-000000000000) is not present in table "source_versions".
---- rollback_zhejiang_materials #1 ----
 catalog_source_update_events  | 0     crops_kept | 4      formulations_other_seed_kept | 22
 import_runs_reverted          | 1     import_runs_total | 1  knowledge_versions | 0
 registrations_other_seed_kept | 22    source_versions | 5      sources | 3
---- rollback_zhejiang_materials #2 (idempotent) ---- （与 #1 完全相同的计数）
server stopped
```

注：FK 负例的证据是 psql 的 `ERROR … violates foreign key constraint` 原文（23503 语义）；
本脚本未用 `$LASTEXITCODE` 判定该步（Windows PowerShell 5.1 在 `2>&1 | Out-String` 后会把
`$LASTEXITCODE` 读成 0），已在脚本注释与本节如实标注，不据此写「退出码非零」。

### 6.8 仓库门禁（按改动影响选择）

```text
PS> python tools/knowledge/test_zhejiang_materials.py --root .   → 14/14（§6.3）
PS> npm run test:unit                                            → tests 1698 / pass 1697 / fail 0 / skipped 1
                                                                   含新例「浙江首批资料种子：幂等、用量缺项门、批次精确回滚」
PS> npm run lint                                                 → PASS（tsc ×2 + 仓库卫生扫描）
PS> npm run test:docs                                            → PASS（27 任务、依赖无环、F/AC/Q 映射、链接与表格）
PS> git diff --check                                             → PASS（exit 0）
```

未跑：`test:contract`／`test:evaluation`／`test:mini`（本轮未改契约、评估与小程序产物；`test:reference`
已包含在 `test:unit` 内并被读到的唯一相关文件 `coverage-report.json` 由新增校验器同步约束）。

## 7 负数与边界场景（同一次实测）

| 场景 | 结果 |
| --- | --- |
| 源文件 sha256 与 MANIFEST 不符 | 抽取器直接失败退出（`--samples-dir` 路径） |
| 工作簿宏/外部链接工作表 | 复用 `inspect_workbook`：`macro_present=false`、`external_links_present=false`；如为真则拒绝 |
| 补造用量（清单层/库层） | 校验器 14 例含 2 例；库层 `dose_leak_rows` 门检出（PGlite + PG17.11 各 1 次） |
| 行指纹截断/来源未登记/来源自称 verified | 校验器拒绝 |
| 条目重复（item_id）或 JSON 与种子 SQL 不一致 | 校验器拒绝 |
| 回滚越范围（删其他表） | 校验器拒绝；实际回滚 SQL 仅 4 张本批次相关表的 DELETE |
| 回滚重复执行 | 两次结果一致（PGlite + PG17.11） |
| FK 负例（引用不存在的 source_version） | PG17.11 实库 23503 拒绝 |
| 杂草工作簿走已合并暂存 CLI | 正确拒绝（`EXPECTED_TABLE_MISSING_OR_MERGED`），不冒充通过 |

## 8 必须如实标注的缺项（**不得补造、不得关闭整项**）

| 缺项 | 状态 | 说明 |
| --- | --- | --- |
| **标签原文用量 / DoseCard** | `absent_in_source` | 两份工作簿**没有**用量/施用方法/注意事项/安全间隔期字段（除草剂表仅 名称/别称/危害等级/危害/防除对象/适用地区）。清单 `dose_text=null`、`usable_as_dose=false`、`card_ready=false`；**严禁**据此推断或补造用量。DoseCard 仍为 0 |
| **八组科普评估** | `not_done` | 需既定评估方案与真实来源核对，本轮未做（既有 `species.json` 仅规范对象编号，`coverage_state=planned`） |
| **云库 / 受控 HTTPS / 正式 `real` 启动** | `not_done` | 未触碰生产库、未发起付费调用；`knowledge_dataset_config.active_mode` 仍为 `stub`、`database_connected=false` |
| **双手机真机** | `not_done` | 无真机证据，未跑 |
| 逐条权威出处 | `unverified` | 工作簿为整理稿，未标注逐条权威来源；`review_status=unverified`，作者侧非法定审核责任人 |
| 再分发许可 | `deferred` | `licensed=false`，原文件不入库；不得写为已许可 |
| 作物目录 | `blocked_on_scope` | 浙江行主要作物含 蔬菜/茶园/果园/蚕豆，首批 `crop_id` 目录只有 水稻/玉米/大豆/油菜；不自行扩目录，需需求确认（已入库条目中这些场景的 `crop_ids` 为空，正文保留原文） |
| 防除时期未取证场景 | `deferred` | 9 行（小麦冬麦区、玉米、大豆、花生／棉花等）本工作簿未给出与浙江的对应关系，保留在清单但未入首批库 |
| 除草剂非首批条目 | `deferred` | 61 行（10 行大区泛称需人工复核 + 51 行无浙江证据）保留在清单但不入首批库 |
| 杂草总表受限暂存映射 | `deferred` | 需新 `mapping_version` 与相应校验扩展，本轮不改已合并工具 |
| ICAMA/登记详情逐条复核 | `not_done` | 本批次资料源为两份工作簿，未与登记详情或核准标签逐条比对 |

## 9 未取得／未验证项与剩余风险

- PGlite 是内存引擎（PostgreSQL 18.x 内核），**不等于**目标 PG17.11 验收；因此本轮另跑了
  §6.7 的**真实 PG17.11 隔离实例**，两者证据分开列出，不互相替代。
- 本机 PG 为**作者自有隔离实例**，不构成 CI、监工或云库证据；实例已停止（`pg_ctl -m fast stop`）。
- 未做：生产库写入、正式 `real` 启动、受控 HTTPS、真机、付费调用、`services/api` 端到端消费新条目、
  `knowledge_staging` 与 `staging_intake` 的本次真实文件端到端函数调用（只跑到 0004 形状的 intake SQL 生成）。
- 剩余风险：①来源为整理稿，内容可能有误或过期，且无逐条权威出处，**不得**作为用药依据；
  ②`华东/南方/华南` 10 行适用性属区划常识推断，需人工复核；③清单为全量文本派生，若权利方要求，
  可用 `rollback_zhejiang_materials.sql` 精确撤回本批次全部库内行；④`knowledge_versions.body` 为
  JSON 文本，尚未有对外读取端点（本轮未新增），消费方接线属后续任务。

## 10 复现

```bash
# 抽取/校验/负例（需仓外只读样本目录；后两条可在无样本的 CI 运行）
python tools/knowledge/extract_zhejiang_materials.py --samples-dir <样本目录>
python tools/knowledge/validate_zhejiang_materials.py --root .
python tools/knowledge/validate_zhejiang_materials.py --root . --samples-dir <样本目录>
python tools/knowledge/test_zhejiang_materials.py --root .
python tools/knowledge/build_seeds.py --root .

# 库内回归
node tools/knowledge/pglite_verify.mjs
node --test tests/unit/gy-i03-db.test.mjs
# 受限暂存（真实文件，产出留在 .local）
python tools/knowledge/import_workbook_staging.py "<样本目录>\市面常见除草剂环境风险与适用信息汇总表.xlsx" --output .local\gy-i03-intake-herb

# 门禁
npm run lint && npm run test:docs && npm run test:unit && git diff --check
```

## 11 PR 正文（可粘贴）

```markdown
Refs #3（**不关闭整项**）

## 本次交付
- 从用户提供的两份真实工作簿抽出**浙江首批资料清单**（119 杂草 / 5 防除时期 / 35 药剂适用），
  逐条带 `file_sha256 + sheet + excel_row + cell_range + row_sha256 + locator`，可确定性重算比对。
- 接入**既有** 0002 可替换适配层：`sources/source_versions/knowledge_versions/catalog_import_runs/
  catalog_source_update_events`，`review_status=unverified`、`region_codes=[330000]`、`visibility=private`；
  幂等种子 + 本批次精确回滚；**不新增迁移、不改契约、不改他人已合并实现**。
- 复用既有受限暂存（0004/0007 的 `herbicide-summary-v1`）对除草剂工作簿做真实文件 intake；
  杂草总表 9 栏需新映射版本，本轮不扩范围（已列缺项）。

## 证据（实测）
- 抽取/校验/重算/负例 14/14；既有资料子域回归 PASS。
- PGlite 回归 `ALL CHECKS PASSED`（85 PASS / 0 FAIL，含 3b 浙江段）；
  并修正该工具在当前 main（迁移已到 0010）上因 `0007` 需要 pgcrypto 而崩溃的问题：
  执行范围显式限定 `<= 0003` 并打印跳过清单，不把跳过写成通过（崩溃在本改动前即存在）。
- 本机**隔离** PostgreSQL 17.11 实库：0001→0002→既有种子→浙江种子 ×2（幂等）→
  `knowledge_versions=159`、`dose_leak_rows=0`、`card_ready_true=0`、`v_active_source_version=0` →
  回滚 ×2 还原（其他种子 22 制剂/22 登记不变）；FK 负例 23503。实例已停止。
- 门禁：`npm run lint` / `npm run test:docs` / `npm run test:unit`（1698 例，fail 0）/ `git diff --check`。

## 未取得（如实标注，不关闭 #3）
用量／DoseCard（源表无该列，严禁推断补造）、八组科普评估、云库/受控 HTTPS/正式 `real`、双手机真机；
许可调查仍暂缓（`licensed=false`），来源 `unverified`，**不得作为用药量依据**。

证据页：`docs/verification/gy-i03-zhejiang-materials.md`
```

---

**本页不含**：生产库写入、云库连接、真实 HTTPS、真机、付费调用与真实用户数据；原工作簿与原始媒体
未提交入库。
