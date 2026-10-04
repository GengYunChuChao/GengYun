# 脱敏数据库样例与字段映射

本目录给出 `packages/knowledge` JSON 清单到 `services/api/db/migrations/0002_knowledge_catalog.sql`
业务表列（及 0001 共享字典表列）的映射，以及一份**脱敏样例**。样例只含合成/公开数据，
**不含任何用户私有个体数据**（无 openid、无会话、无上传媒体、无个人定位）。

**schema 真相**：已审 `docs/architecture/data-dictionary.md` + main 上
`services/api/db/migrations/0001_initial_schema.sql`（共享字典表）+ 本 PR 的
`0002_knowledge_catalog.sql`（业务表）。

## 字段映射

| JSON 位置 | 表.列 | 说明 |
| --- | --- | --- |
| `catalog/regions-zhejiang.json` `regions[].code` | `regions.code` | GB/T 2260 六位码，浙江 `33` 前缀（共享表主键） |
| `regions[].parent_code` | `regions.parent_code` | 上级代码；省为 NULL |
| `regions[].name` | `regions.name` | 名称 |
| `regions[].catalog_version` | `regions.catalog_version` | 版本（`mca-xzqh-2023`） |
| `regions[].supported` | `regions.supported` | 是否支持 |
| `regions[].level` | **不落库** | 共享 `regions` **无 `level` 列**；层级由 `parent_code` 关系/JSON 表达 |
| `catalog/crops.json` `crops[].id` | `crops.id` | 规范作物编号（共享表） |
| `catalog/species.json` `species[].id` | `species.id` | 规范物种编号（共享表） |
| `species[].canonical_name/scientific_name/aliases/coverage_state` | `species.*` | 对应列 |
| `catalog/sources.json` `sources[].id`（文本键） | `sources.id`（uuid） | **文本 ID → 确定性 uuid5**：`uuid5(NAMESPACE_URL, "source:"+文本id)`（见 `tools/knowledge/build_seeds.py` 的 `src_db_id`） |
| `sources[].title/canonical_url/publisher/source_kind/evidence_kind` | `sources.*` | 来源登记（`source_kind`/`evidence_kind` 为共享枚举） |
| `sources[].license.survey_status/licensed` | **不落共享表** | 许可结论**只存在于资料/报告层**（`sources.json` 的 `license` 字段与验证报告）；共享 `sources` **无 `license_status`/`licensed` 列** |
| `sources[].issues[].attachment_sha256` | `source_versions.content_hash` | 附件 SHA-256 |
| `sources[].retrieved_at` | `source_versions.retrieved_at/valid_from` | timestamptz |
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

缺字段（用药量/施用方法/注意事项/有效期起止）在表中为 `NULL`，**不推断、不填默认值**；
缺登记有效期时 `registrations.status='unknown'`（不得标为 `valid`）。

## 脱敏样例

见 `desensitized-sample.sql`：仅 `source_kind='simulation'` 的合成来源与制剂 + 公开区划参考行；
全部 `ON CONFLICT DO NOTHING`，**可重复执行（幂等）**。其模拟来源行与
`db/seeds/seed_simulation.sql` 的同一来源（`src_sim_demo_gyi03` 的 uuid5）一致。
真实登记资料（20 条）在 `db/seeds/seed_herbicides_verified.sql`，属公开公告数据，非隐私数据。
