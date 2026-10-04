# 脱敏数据库样例与字段映射

本目录给出 `packages/knowledge` JSON 清单到 `db/migrations/0002_knowledge_catalog.sql` 表列的
映射，以及一份**脱敏样例**。样例只含合成/公开数据，**不含任何用户私有个体数据**
（无 openid、无会话、无上传媒体、无个人定位）。

## 字段映射

| JSON 位置 | 表.列 | 说明 |
| --- | --- | --- |
| `catalog/regions-zhejiang.json` `regions[].code` | `regions.code` | GB/T 2260 六位码，浙江 `33` 前缀 |
| `regions[].parent_code` | `regions.parent_code` | 上级代码；省为 NULL |
| `regions[].name` | `regions.name` | 名称 |
| `regions[].catalog_version` | `regions.catalog_version` | 版本（`mca-xzqh-2023`） |
| `regions[].level` | `regions.level` | `province/prefecture/county` |
| `catalog/crops.json` `crops[].id` | `crops.id` | 规范作物编号 |
| `catalog/species.json` `species[].id` | `species.id` | 规范物种编号 |
| `species[].canonical_name/scientific_name/aliases/coverage_state` | `species.*` | 对应列 |
| `catalog/sources.json` `sources[].id/title/canonical_url/publisher/source_kind/evidence_kind` | `sources.*` | 来源登记 |
| `sources[].license.survey_status/licensed` | `sources.license_status/licensed` | 许可状态（本轮 `deferred/false`） |
| `sources[].issues[].attachment_sha256` | `source_versions.content_hash` | 附件 SHA-256 |
| `herbicides/records-2026.json` `records[].registration_number` | `formulations.registration_number` | 登记证号 |
| `records[].producer/dosage_form` | `formulations.producer/dosage_form` | 持有人/剂型 |
| `records[].ingredients_text`（解析后） | `formulations.ingredients` jsonb | `[{name,content_text,unit_text}]` |
| `records[].registered_name` | `registrations.registered_name` | 登记名称 |
| `records[].source.issue` | 关联 `source_versions.id` | 来源版本 |
| `records[].use_scene` | `applicability.use_scene` | 使用场景（作物/场所原文） |
| `records[].crop_ids[0]` | `applicability.crop_id` | 主作物 |
| `records[].target_original` | （原文；命中8组时填 `applicability.species_id`） | 防治对象原文 |
| `records[].verification.card_eligible` | `applicability.card_ready` | 本轮恒 `false` |
| `records[].verification.review_status` | `source_versions.review_status` | 本轮 `unverified` |

缺字段（用药量/施用方法/注意事项/有效期起止）在表中为 `NULL`，**不推断、不填默认值**。

## 脱敏样例

见 `desensitized-sample.sql`：仅 `source_kind='simulation'` 的合成记录 + 公开区划/作物参考行。
真实登记资料（20 条）在 `db/seeds/seed_herbicides_verified.sql`，属公开公告数据，非隐私数据。
