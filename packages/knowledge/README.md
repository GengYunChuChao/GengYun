# 耕云首批资料清单（GY-I03）

本目录是浙江首批资料的可核查契约：浙江市县、4 类作物、8 组杂草规范对象编号，以及
目标 20 条普通除草剂记录。资料与数据库适配分离，模拟数据单独标记。

**浙江首批资料（来自用户提供的两份真实工作簿，逐条带来源定位与行哈希）**：
见 [`zhejiang/`](zhejiang/README.md)（清单、抽取/校验/负例工具、种子与精确回滚、证据页）。
该批次 `review_status=unverified`、用量缺项显式为 `null`，**不得作为用药量依据**。

**结论先行**：20 条登记证号均取自农业农村部农药管理司公开公告附表，非编造；但用药量、
施用方法、注意事项、有效期起止、禁限用状态**本轮未采集**，记录状态为 `partial`，
**不得作为用药量依据**。未接入真实数据库，未执行迁移。许可调查本轮暂缓，**未获许可**。

## 文件

| 文件 | 内容 |
| --- | --- |
| `catalog/regions-zhejiang.json` | 浙江省市县区划（102 条，来源：民政部 2023 县以上区划代码） |
| `catalog/crops.json` | 4 类作物 `crop_id` |
| `catalog/species.json` | 8 组杂草规范对象编号 `species_id` |
| `catalog/sources.json` | 来源登记（URL/发布方/许可状态） |
| `herbicides/records-2026.json` | 20 条普通除草剂登记记录 |
| `coverage-report.json` | 覆盖与缺口清单 |

## 数据来源（真实、可复核）

1. **行政区划**：民政部《2023年中华人民共和国县以上行政区划代码》
   <https://www.mca.gov.cn/mzsj/xzqh/2023/202301xzqh.html>（本轮访问 200）。取 `33` 前缀共 102 条。
2. **农药登记**：农业农村部农药管理司《农药登记信息》公告附表（.xls），经中国农药信息网
   「数据中心 / 登记信息发布」与农业农村部种植业管理司原文页公开：
   - 2026 年第 9 期：<https://zzys.moa.gov.cn/gzdt/202606/t20260604_6484759.htm>
     附表 <https://zzys.moa.gov.cn/gzdt/202606/P020260604741615151859.xls>
   - 2026 年第 7 期：<https://zzys.moa.gov.cn/gzdt/202606/t20260604_6484757.htm>
   - 2026 年第 1 期：<https://zzys.moa.gov.cn/gzdt/202603/t20260325_6482643.htm>

公告为**登记延续信息**，附数字段：登记证号、登记证持有人、农药名称、剂型、毒性、
有效成分及其含量、农药类别、作物/场所、防治对象、产品质量标准号。附表中**没有**用药量、
施用方法、注意事项、有效期起止列。

## 如何复核

```bash
# 1. 校验清单（仅标准库，可独立运行）
python tools/knowledge/validate_knowledge.py --root .

# 2. 重新生成浙江区划（从民政部页面）
python tools/knowledge/build_regions.py --url https://www.mca.gov.cn/mzsj/xzqh/2023/202301xzqh.html \
    --out packages/knowledge/catalog/regions-zhejiang.json

# 3. 重新生成除草剂清单（需 xlrd；附表需先下载，见 tools/knowledge/build_herbicides.py 头部注释）
python tools/knowledge/build_herbicides.py --ann 2026-09=<ann9.xls> --ann 2026-01=<ann1.xls> \
    --out packages/knowledge/herbicides/records-2026.json
```

`validate_knowledge.py` 会检查：登记证号非空且非 `SIM-` 前缀（真实来源）、来源 URL 必须登记在
`sources.json`、字段缺失不得标为可用、模拟记录必须全链路带 `simulation` 标记、区划代码格式与
父子关系、契约枚举（读 `packages/contracts/states.json`，只消费不修改）。失败明确报错，不静默跳过。

## 边界

- 只消费 `packages/contracts/*`，不修改契约。
- 不造登记号、不虚构来源/URL/机构。
- 不生成处方、混配、自动剂量换算；文案不出现“绝对安全”“零药害”。
- 每条记录的 `verification.card_eligible=false`、`usable_as_dose=false`，直到补齐原文用量字段。
