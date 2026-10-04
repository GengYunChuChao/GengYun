# GY-I03 验证记录与限制（#3）

- 日期：2026-10-04
- 分支：`feature/gy-i03-zhejiang-data`；worktree：`E:/worktrees/gengyun-i03-data`
- base：`main` = `b60652c346fc0efccc0fe71b959e39f475669a9f`（PR #43 GY-I02 已合并）
- 说明：本文件只记录**实际运行**的命令与结果；未运行、未接入的项明确写为未完成。

## 1. 已运行检查

| 检查 | 命令（Python 3.13.12 标准库） | 结果 |
| --- | --- | --- |
| 资料清单校验 | `python tools/knowledge/validate_knowledge.py --root .` | PASS：区划102（11市/90县）、作物4、物种组8、来源3、记录20/20、种子SQL 20、card_eligible 0 |
| 负例自测 | `python tools/knowledge/test_knowledge.py --root .` | 6/6 负例被拒绝 |
| 适配层逻辑演示 | `python tools/knowledge/adapter_demo.py --root .` | PASS：active视图=0、可查询种子版本=4、模拟视图=1、卡片=0、冲突阻断、回滚与幂等通过 |
| 真实模式负例 | `python tools/knowledge/validate_knowledge.py --root . --mode real` | 预期 FAIL（`usable_as_dose=0`，未接入真实库） |
| 种子 SQL 一致性 | 校验脚本内 `JSON↔SQL` 交叉检查 | PASS：20 证号均在 `seed_herbicides_verified.sql` |
| 单元/回归测试 | `node --test "tests/unit/*.test.mjs"` | PASS：30/30（含迁移发现、脱敏样例、回滚、down） |
| 数据库全链路回归 | `node tools/knowledge/pglite_verify.mjs`（PGlite 0.5.8） | ALL CHECKS PASSED（见 §7） |
| 空白差异 | `git diff --check` | PASS |

### 关键输出摘录

```
== GY-I03 资料校验 ==
  crops = 4
  records_achieved = 20
  records_card_eligible = 0
  records_usable_as_dose = 0
  records_gap = 0
  records_target = 20
  regions_county = 90
  regions_prefecture = 11
  regions_total = 102
  seed_sql_records = 20
  sources = 3
  species_groups = 8
PASS: 全部检查通过
```

```
== GY-I03 适配层逻辑演示（非真实数据库）==
  v_active_source_version (valid+verified+非模拟): 0
  v_queryable_seed_version (valid+非模拟): 4
  v_simulation_only: 1
  v_knowledge_applicability (card_ready 门): 0
  gate_unverified_not_active: PASS
  gate_missing_dose_no_card: PASS
  real_mode_usable_records: 0
  conflict_detected: True
  rollback_cleared_seeded_rows: True
  import_run_status: reverted
  idempotent_second_rollback: True
PASS
```

## 2. 数据获取实测（真实来源可达性）

| 来源 | 命令要点 | 结果 |
| --- | --- | --- |
| 民政部行政区划代码 | `curl -sL https://www.mca.gov.cn/mzsj/xzqh/2023/202301xzqh.html` | 200，1449027 字节，解析浙江 102 条 |
| 中国农药信息网数据中心 | `POST .../zwb/getPage {id:753,pageNumber:1,limit:20}` | 200，返回公告期次 JSON |
| 农业农村部公告原文 | `curl -sL https://zzys.moa.gov.cn/gzdt/202606/t20260604_6484759.htm` | 200，附表 `.xls` 链接 |
| 公告附表（2026年第9期） | 下载 `P020260604741615151859.xls` | 200，311296 字节，SHA-256 `bfe97d34…ace768`，1083 行 |
| ICAMA 登记查询接口 | `POST https://www.icama.cn/BasicdataSystem/pesticideRegistration/queryselect.do` | **返回“服务器发生内部错误”**，未取得逐条详情 |

ICAMA 查询接口本轮程序化访问失败（无论按证号/名称/成分类别），因此**未从 ICAMA 逐条详情页取数**；
改用农业农村部农药管理司公开公告附表，字段可复核。

## 3. 数据成果

- 浙江区划 102 条（1 省 + 11 市 + 90 县），来源民政部。
- 4 类作物、8 组杂草规范对象编号映射完成。
- 20 条普通除草剂记录，**登记证号全部取自官方公告附表**（非编造），覆盖水稻 6 / 玉米 5 / 大豆 4 / 油菜 3 / 跨作物 2。

## 4. 未完成与阻塞（不虚构）

- **未接入真实 PostgreSQL 实例**：迁移与种子已在 PGlite 内存引擎实测通过（0001→0002→种子→回滚，
  无 42804/23503），但尚未在真实 PG 服务端落库运行；适配层业务逻辑为内存演示。
- **20 条记录字段不完整**：缺用药量、施用方法、注意事项、登记有效期起止、禁限用状态，
  故 `record_status=partial`、`card_ready=false`、`usable_as_dose=false`，**不得作为用药依据**。
- `real` 模式可用记录为 0（无 `verified` 来源）——**接入缺项**，非“已接入”。
- 未逐条与 ICAMA 登记详情/核准标签原文复核。
- 8 组杂草尚无逐对象科普知识内容与识别评估标注。
- **许可调查本轮暂缓，所有来源 `licensed=false`**，不得写为已许可；
  共享 `sources` 表无 `license_status/licensed` 列，许可结论只在资料/报告层。
- `0002`（`services/api/db/migrations/0002_knowledge_catalog.sql`）依赖 GY-I02 的
  `0001`（同目录）；合并顺序须在 0001 之后。

## 5. 复现

```bash
python tools/knowledge/validate_knowledge.py --root .
python tools/knowledge/test_knowledge.py --root .
python tools/knowledge/adapter_demo.py --root .
python tools/knowledge/build_regions.py --url https://www.mca.gov.cn/mzsj/xzqh/2023/202301xzqh.html --out /tmp/regions.json
git diff --check
```

## 6. 修复轮（监工 3×P1 + 1×P2 审查响应）

### 6.1 P1-1：0002 对齐 0001 的 uuid 类型与列集（方案 a）

采用**方案 (a)**：`db/migrations/0002_knowledge_catalog.sql` 删除对共享字典表
（`crops/species/regions/sources/source_versions`）的重复 `CREATE TABLE IF NOT EXISTS`，
只保留业务表并直接引用 0001 的真实定义。关键修正：

- `sources.id` → `uuid`（0001 `DEFAULT gen_random_uuid()`）；种子改用 `uuid5` 确定性派生。
- `source_versions.source_id` → `uuid REFERENCES sources(id)`。
- `catalog_source_update_events.source_id` → `uuid REFERENCES sources(id)`。
- `source_versions.reviewed_by` / `valid_from`/`valid_to` / `sources.publisher varchar(120)` /
  `sources.revision`/`current_version_id` / `regions` 无 `level` 列 —— 均以 0001 为准，不再覆盖。
- 种子同步：`sources` 不写 `license_status/licensed`（0001 无此列，许可调查结论保留在
  `sources.json` 的 `license` 字段与报告，不落库）；`regions` 不写 `level`；
  `crops/species` 不写 `updated_at`。

**实测（PGlite 0.5.8，内存 PostgreSQL 引擎）**：依次执行 `0001 → 0002 → 种子`，
无 42804 / 23503；`public` schema 表数量 = 30（0001 的 20 + 0002 业务/适配 10）；
关键 FK 均成立（见 `tools/knowledge/pglite_verify.mjs` 全量输出）。

### 6.2 P1-2：种子注释吞 INSERT

`tools/knowledge/build_seeds.py` 中所有 `ref.append("-- …")` 注释改为以 `\n` 结尾，
重新生成全部种子；PGlite 实测种子导入成功且幂等（二次导入行数不变）。

### 6.3 P1-3：回滚范围限定

`db/seeds/rollback_seed.sql`（生成器同步）：
- `DELETE FROM formulations` 从「无 registrations 引用即删」改为「`WHERE id IN (本次种子
  写入的 formulation id 列表)`」，不再误删无关批次。
- 依赖顺序：先解除 `sources.current_version_id` → 删 `applicability` → `registrations`
  → `formulations` → `catalog_source_update_events` → `source_versions` → `sources`。
- 实测用例：混合批次保留（无关来源/版本/制剂/登记在回滚后保留）、重复回滚（幂等）、
  FK 约束（引用不存在 source_version 被 23503 拒绝）。

### 6.4 P2-4：缺登记有效期 status=unknown

公告附表无登记有效期起止，`registrations` 的 `status` 由 `'valid'` 改为 `'unknown'`
（JSON→SQL 映射同步；模拟数据本就用 `'unknown'`）。

### 6.5 修复轮实测命令

```bash
# 种子重新生成
python tools/knowledge/build_seeds.py --root .
# 校验 / 负例 / 演示
python tools/knowledge/validate_knowledge.py --root .
python tools/knowledge/test_knowledge.py --root .
python tools/knowledge/adapter_demo.py --root .
# PGlite 内存引擎实测 0001→0002→种子→回滚（含幂等/混合批次/重复回滚/FK）
cd /tmp/pgtest && node verify.mjs
git diff --check
```

PGlite 实测结论：`ALL CHECKS PASSED`（表数量 30、种子行数 sources=3/versions=5/crops=4/
species=8/regions=102/formulations=22/registrations=22/applicability=22、幂等、回滚只删本次
22 制剂保留无关批次、重复回滚无副作用、FK 23503 正确拒绝）。

## 7. 修复轮 2（监工第二轮：脱敏样例 P2 + 迁移落位）

### 7.1 P2：`db/samples/desensitized-sample.sql` 对齐共享 schema

原样例引用共享 schema 不存在的列/类型：`regions.level`（0001 无）、`sources.license_status/
licensed`（0001 无）、`sources.id` 用文本键 `src_sim_demo_gyi03`（实为 uuid）。修复：

- `regions` 去掉 `level` 列；`sources` 去掉 `license_status/licensed`（许可结论只留资料/报告层）。
- 来源 id 改为 **uuid5**：`uuid5("source:src_sim_demo_gyi03") = e3b756bf-b047-51b8-9607-e6f898f96743`
  （与 `tools/knowledge/build_seeds.py` 的 `src_db_id` 一致）。
- 同步 `db/samples/field-mapping.md`（去除 level/license 行、补 UUID 转换说明）与
  `db/README.md`（迁移/种子/样例执行入口与顺序、down 位置）。

### 7.2 迁移落位与运行器

`services/api/src/db/migrate.ts` 的 `DEFAULT_MIGRATIONS_DIR = services/api/db/migrations/`，
pattern `/^(\d{4,})_([a-z0-9_]+)\.sql$/`：

- `0002_knowledge_catalog.sql` 移入 `services/api/db/migrations/`（运行器可发现）。
- `.down.sql` 含 `.down` 段**不匹配 pattern**，放入运行器顶层会使 `discoverMigrations` 抛
  「迁移文件名不合规」；故按 I27 约定放 `services/api/db/migrations/rollback/`（`isFile()` 过滤子目录）。
- 未提交 `0001`（由 GY-I02/main 拥有）。

### 7.3 实测（PGlite 0.5.8 / PostgreSQL 18.x 内核；≠ PG17.11 实库验收）

```
运行器发现 = 0001:0001_initial_schema.sql, 0002:0002_knowledge_catalog.sql
PASS exec 0001 / 0002 / 0003_privacy_consent(I27, 不在本分支)
PASS 种子 ×2 幂等（sources=3/versions=5/crops=4/species=8/regions=102/formulations=22/registrations=22/applicability=22）
PASS 样例 ×2 幂等（无 42703；formulations 22→23，重复后仍 23）
PASS 回滚 ×2 幂等（种子行清零，样例制剂 00000000-…-301 保留；crops/regions 保留）
PASS 0002 down（删除 0002 对象，0001 共享表保留）
ALL CHECKS PASSED
```

另：样例**独立执行**（仅 0001→0002→0003 之后直接跑样例，监工原始复现路径）通过且幂等
（formulations=1、sources=1，重复后不变）。

复现命令：

```bash
node tests/unit/gy-i03-db.test.mjs            # 等价：node --test "tests/unit/*.test.mjs"
node tools/knowledge/pglite_verify.mjs
# 保真含 I27 的 0003：GY_M0003=/path/0003_privacy_consent.sql node tools/knowledge/pglite_verify.mjs
```
