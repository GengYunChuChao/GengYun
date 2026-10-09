# GY-I07 科普／除草剂查询 · 来源版本展示（`packages/reference`）

本包实现 issue #7（`[初版 GY-I07]`，priority:P0 / phase:M2；功能 F03、F14；验收 AC02、AC22）
的**查询展示域库**：作物—杂草—除草方式导航与关键词／地区筛选、详情与来源版本展示、
以及「无结果 / 失效 / 未核对 / 模拟」四类状态的如实呈现。

**纯 ESM、零第三方依赖**；只读 `packages/contracts`（契约 1.0.0）、`packages/knowledge`（首批资料）
与 `db/seeds/gy-i07`（指挥侧结构化种子资料）。**不实现 HTTP、不接数据库、不生成用量建议。**

## 模块

| 文件 | 职责 |
| --- | --- |
| `constants.mjs` | 冻结常量与枚举（**只读消费**契约），禁止标签表，种子路径与合规标注 |
| `errors.mjs` | 契约同形错误封套（`ReferenceError` / `FieldError` / `toErrorEnvelope`） |
| `catalog.mjs` | 目录装载与规范化检索（作物／杂草／地区，别名精确优先） |
| `records.mjs` | 除草剂记录装载与契约投影；`formulationIdentityHash` 保证**不同含量剂型不合并** |
| `query.mjs` | 确定性结构化查询（结构化条件优先，**不默认要求向量数据库**）；`evaluateEligibility` 列表/详情同源同判 |
| `source-version.mjs` | 来源版本一致性与下架/失效缓存失效（ETag 按记录身份键派生） |
| `labels.mjs` | 展示标签唯一来源；断言无禁用词；用量恒不展示 |
| `seed.mjs` | 指挥侧结构化**种子资料**（整理稿）装载；强制「待核实·非权威」；**不产出任何用量** |
| `service.mjs` | 服务装配为契约响应封套（`/knowledge`、`/herbicides`、`/catalog/*`、种子端点） |
| `index.mjs` | 统一出口 |

## 关键设计（对应验收）

1. **可追溯来源 / 缺项不空白**（AC02）
   每条记录带 `source`（发布方/期号/原始 `https` 链接/采集日期）与 `source_version`；
   `toDetail` 显式列出 `not_collected`（未采集字段）与 `verified_scope`（已核对字段），
   **不以空白或模型补写填充**。

2. **下架／失效退出有效查询，列表与详情一致**
   `QUERYABLE_VISIBILITIES=['published']`、`QUERYABLE_VALIDITIES=['valid']`；
   `evaluateEligibility` 为列表与详情**共用**判定。`etagFor` 按
   「记录身份键 `registration_number::identity_hash` @ `source_version`」派生，
   **下架/失效任一记录即改变 ETag**（仅按 `source_version` 去重会导致缓存不失效，见测试反证）。

3. **不授专家认证标签 / 模拟不展示真实用量**（AC22）
   `FORBIDDEN_LABELS` 明确列出禁用词（专家已审／专家认证／权威认证／权威来源／已验证安全／绝对安全／零药害／无药害）；
   `assertNoForbiddenLabel` 在标签生成处强制断言；`doseDisplayFor` 恒不生成处方/换算。

4. **不以模糊药名合并不同含量剂型**
   `formulationIdentityHash` = 归一化（名称｜剂型｜成分含量）哈希；`identity_key = registration_number::identity_hash`。
   名称相同但含量/剂型不同 → `identity_hash` 不同 → 保持独立记录。

5. **不默认要求向量数据库**
   查询为确定性结构化匹配（`crop_id` / `region_code` / `species_id` / 使用场景 + 关键词/登记号收窄），
   无外部检索依赖。

## 指挥侧种子资料（`db/seeds/gy-i07`）

`seed_unverified` / `authority=none` 的**整理稿**，展示强制标注「待核实·非权威」：

| 文件 | 条数 |
| --- | --- |
| `herbicides.json` | 96 |
| `weeds.json` | 172 |
| `weed_master.json` | 175 |
| `province_index.json` | 34（含中国台湾/中国香港/中国澳门，按省级口径） |
| `control_timing.json` | 14 |
| `usage_notes.json` | 23 |

合规处理（见 `INDEX.json` `usage_policy`）：**不显示真实用量**、**不授专家认证标签**、
**不声称可追溯权威来源**、**缺项不空白/不补写**；**原始 docx/xlsx 不入仓**。

## 小程序侧

- 数据生成：`node tools/knowledge/build_miniprogram_data.mjs`（`--check` 做漂移校验）
  → `miniprogram/data/*.js`（含种子资料）。
- 适配层：`miniprogram/utils/reference.js`（CommonJS，零 `node:` 依赖），
  口径与域库一致（同一资料、同一 eligibility 判定、同一标签）。
- 页面：`pages/reference`（查询列表）、`pages/reference-detail`（记录详情）、
  `pages/reference-seed`（种子资料库）、`pages/reference-seed-detail`（种子详情）。

## 验证

```bash
node --test "tests/reference/*.test.mjs"     # 契约/种子/来源版本/查询/标签/小程序一致性
node tools/knowledge/build_miniprogram_data.mjs --check
```

## 边界

仅推个人 Fork 功能分支 → 向上游 `main` 发 PR；**不推 main、不合并、不代替监工审批**。
真实登录态（GY-I04 整项仍 Open）、持久对象存储等**分别记录为缺项**，不声称完成。
