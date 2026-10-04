# GY-I03 验证记录与限制（#3）

- 日期：2026-10-04
- 分支：`feature/gy-i03-zhejiang-data`；worktree：`E:/worktrees/gengyun-i03-data`
- base：`main` = `9743a122edb7ac1c55a68cbdceb77a64928029d9`
- 说明：本文件只记录**实际运行**的命令与结果；未运行、未接入的项明确写为未完成。

## 1. 已运行检查

| 检查 | 命令（Python 3.13.12 标准库） | 结果 |
| --- | --- | --- |
| 资料清单校验 | `python tools/knowledge/validate_knowledge.py --root .` | PASS：区划102（11市/90县）、作物4、物种组8、来源3、记录20/20、种子SQL 20、card_eligible 0 |
| 负例自测 | `python tools/knowledge/test_knowledge.py --root .` | 6/6 负例被拒绝 |
| 适配层逻辑演示 | `python tools/knowledge/adapter_demo.py --root .` | PASS：active视图=0、可查询种子版本=4、模拟视图=1、卡片=0、冲突阻断、回滚与幂等通过 |
| 真实模式负例 | `python tools/knowledge/validate_knowledge.py --root . --mode real` | 预期 FAIL（`usable_as_dose=0`，未接入真实库） |
| 种子 SQL 一致性 | 校验脚本内 `JSON↔SQL` 交叉检查 | PASS：20 证号均在 `seed_herbicides_verified.sql` |
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

- **未接入真实数据库，未执行迁移**：无 PostgreSQL、无 0001。SQL 为静态产物；适配层为内存逻辑演示。
- **20 条记录字段不完整**：缺用药量、施用方法、注意事项、登记有效期起止、禁限用状态，
  故 `record_status=partial`、`card_ready=false`、`usable_as_dose=false`，**不得作为用药依据**。
- `real` 模式可用记录为 0（无 `verified` 来源）——**接入缺项**，非“已接入”。
- 未逐条与 ICAMA 登记详情/核准标签原文复核。
- 8 组杂草尚无逐对象科普知识内容与识别评估标注。
- **许可调查本轮暂缓，所有来源 `licensed=false`**，不得写为已许可。
- `0002` 依赖 `0001`（GY-I02）；合并顺序须在 GY-I02 之后。

## 5. 复现

```bash
python tools/knowledge/validate_knowledge.py --root .
python tools/knowledge/test_knowledge.py --root .
python tools/knowledge/adapter_demo.py --root .
python tools/knowledge/build_regions.py --url https://www.mca.gov.cn/mzsj/xzqh/2023/202301xzqh.html --out /tmp/regions.json
git diff --check
```
