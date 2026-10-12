/**
 * GY-I07 科普／除草剂查询与来源版本展示 · 冻结常量与枚举。
 *
 * 本文件是「查询展示层」的唯一事实来源之一：所有枚举**只读消费**
 * `packages/contracts/states.json` 与 `packages/contracts/openapi.json`（契约 1.0.0），
 * 不修改契约。任何与契约不一致的取值都在 `tests/reference/contract.test.mjs` 中被断言。
 *
 * 设计约束（对应 issue #7 范围与验收 AC02/AC22）：
 *   1) **不以模糊药名合并不同含量剂型** —— 制剂身份由 `registration_number + identity_hash`
 *      共同确定；`registered_name` 相同但含量/剂型不同的记录保持独立。
 *   2) **列表与详情使用同一 `source_version`** —— 二者都从同一条记录的 `source` 派生。
 *   3) **不默认要求向量数据库** —— 查询为确定性结构化匹配（crop/region/species/关键词/登记号），
 *      无外部检索依赖。
 *   4) **来源不足或模拟不得作为真实用量依据** —— 记录状态 / 来源类型 / 审核状态分别标注，
 *      `usable_as_dose` 恒为 false（首批资料缺用量字段）。
 *
 * 纯 ESM，无第三方依赖。本模块不实现 HTTP，只产出**契约形状**的数据供上层路由消费。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 契约版本（与 openapi Meta.contract_version 一致）。 */
export const CONTRACT_VERSION = '1.0.0';

/** 本域资料的目录版本标记，用于「列表／详情同源」与缓存失效判定。 */
export const REFERENCE_DOMAIN = 'gengyun.reference';

/**
 * 执行模式（契约 ExecutionMode）。**只消费**，不改写。
 * - real：接入真实数据库
 * - stub：受控替身/种子
 * - preset_demo：显式标注的模拟演示
 */
export const EXECUTION_MODES = ['real', 'stub', 'preset_demo'];

/** 来源类型（契约 SourceKind）。 */
export const SOURCE_KINDS = ['database', 'verified_seed', 'simulation'];

/** 证据类型（契约 EvidenceKind）：科研／经验／混合。 */
export const EVIDENCE_KINDS = ['research', 'experience', 'mixed'];

/** 知识条目类型（契约 Knowledge.type）。 */
export const KNOWLEDGE_TYPES = ['species', 'herbicide', 'scheme', 'static_region'];

/** 参考可得性（契约 ReferenceState）。 */
export const REFERENCE_STATES = ['available', 'unavailable'];

/** 匹配状态（契约 MatchState）：命中／无匹配／歧义／冲突／不足／不可用。 */
export const MATCH_STATES = ['matched', 'no_match', 'ambiguous', 'conflict', 'insufficient', 'unavailable'];

/** 来源有效期（契约 SourceRef.validity）。 */
export const SOURCE_VALIDITIES = ['valid', 'expired', 'conflicting', 'unknown', 'withdrawn'];

/** 来源审核状态（契约 SourceRef.review_status）。 */
export const REVIEW_STATUSES = ['unverified', 'verified', 'rejected'];

/** 可见性（契约 Visibility）——下架（hidden）/删除（deleted）退出有效查询。 */
export const VISIBILITIES = ['private', 'published', 'hidden', 'deleted'];

/** 覆盖状态（契约 Species.coverage_state）。 */
export const COVERAGE_STATES = ['planned', 'supported', 'unsupported'];

/**
 * 允许进入「有效查询」的来源有效期：仅 `valid`。
 * `expired`/`withdrawn`/`conflicting`/`unknown` 一律退出有效查询并在详情中给出原因。
 */
export const QUERYABLE_VALIDITIES = ['valid'];

/**
 * 允许进入「有效查询」的可见性：仅 `published`。
 * `hidden`（下架）与 `deleted` 退出，且**列表与详情必须一致**。
 */
export const QUERYABLE_VISIBILITIES = ['published'];

/** 分页默认/上限（契约 Limit：1..50，默认 20）。 */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
/** 关键词最大长度（契约 /knowledge 的 q：1..80）。 */
export const MAX_QUERY_LENGTH = 80;

/** 浙江地区编码前缀（契约 region_code pattern `^33[0-9]{4}$`）。 */
export const REGION_CODE_PATTERN = /^33[0-9]{4}$/;

/** 登记证号（真实记录形如 PD20161371；模拟记录以 SIM- 前缀显式标注）。 */
export const REGISTRATION_NUMBER_PATTERN = /^[A-Za-z0-9-]{3,40}$/;
export const SIMULATION_REGISTRATION_PREFIX = 'SIM-';

/**
 * 展示层命名集合（供 UI 标签使用，**不**改变契约枚举）。
 * 关键：这里**没有**「专家已审」「绝对安全」等标签，且明确列出禁止标签，
 * 供测试断言 UI 文案不得出现（AC22：不授 AI／用户经验"专家认证"标签）。
 */
export const DISPLAY_LABELS = {
  source_kind: {
    database: '在线数据库记录',
    verified_seed: '已核对种子资料',
    simulation: '模拟演示数据（非真实资料）',
  },
  evidence_kind: {
    research: '科研来源',
    experience: '经验来源',
    mixed: '科研与经验混合',
  },
  review_status: {
    unverified: '未核对',
    verified: '已核对',
    rejected: '已驳回',
  },
  reference_state: {
    available: '资料可用',
    unavailable: '资料不可用',
  },
  match_state: {
    matched: '已匹配',
    no_match: '无匹配结果',
    ambiguous: '存在多个可能结果',
    conflict: '资料相互冲突',
    insufficient: '条件不足',
    unavailable: '资料暂不可用',
  },
  record_status: {
    partial: '字段不完整',
    complete: '字段完整',
    simulated: '模拟记录',
  },
};

/**
 * 禁止在对外文案中出现的标签（AC22 / F03 / F14）。
 * 展示层任何位置出现这些词都属于违规，测试会断言。
 */
export const FORBIDDEN_LABELS = [
  '专家已审',
  '专家认证',
  '权威认证',
  '权威来源',
  '已验证安全',
  '绝对安全',
  '零药害',
  '无药害',
];

/**
 * GY-I08 药剂适用过滤规则版本。
 *
 * 所有消费端（packages/reference 域库、miniprogram 详情页、GY-I12 问答用量卡片）
 * **必须引用同一常量**，以满足规格「所有消费端使用同一规则版本」的契约要求。
 * 任何一处修改适用过滤语义时，须同步 bump 此版本并回归 miniprogram 镜像。
 */
export const APPLICABILITY_RULE_VERSION = 'gy-i08/1.0.0';

/**
 * 禁限用状态枚举（GY-I08 适用过滤维度之一）。
 * - banned：禁用（不得进入可执行建议/用量卡片，AC13）
 * - restricted：限用（需额外确认，默认不得进入）
 * - unrestricted：非禁限用
 * - unknown：来源未采集该状态（**不得静默视为安全**；按 fail-closed 处理）
 */
export const RESTRICTION_STATUSES = ['banned', 'restricted', 'unrestricted', 'unknown'];

/** 药剂适用过滤的维度清单（顺序即检查顺序；用于测试断言与 UI 说明）。 */
export const APPLICABILITY_DIMENSIONS = [
  'valid_source',
  'banned_restricted',
  'crop',
  'growth_stage',
  'region',
  'dosage_form',
  'ingredient_content',
  'use_scene',
];

/**
 * 指挥提供的结构化**种子数据**（整理稿）的强制标注。
 *
 * 合规口径（见 db/seeds/gy-i07/INDEX.json usage_policy）：
 * - `data_origin=seed_unverified`、`authority=none`；
 * - 展示须标注「待核实·非权威」；
 * - 不得显示真实用量、不得授专家/用户经验认证标签、不得声称可追溯权威来源、
 *   不得在缺项处用空白或模型补写。
 */
export const SEED_DATA_ORIGIN = 'seed_unverified';
export const SEED_AUTHORITY = 'none';
export const SEED_REQUIRED_LABEL = '待核实·非权威';
export const SEED_DISCLAIMER =
  '整理稿，无逐条权威出处标注。仅作种子资料，须标注「待核实·非权威」；不得作为用药依据。';

/** 地区表述约定：中国台湾/中国香港/中国澳门 按省级行政区处理。 */
export const REGION_CONVENTION =
  '中国台湾/中国香港/中国澳门 一律按省级行政区处理，不视为国家。';

/** 目录文件相对仓库根的路径。 */
export const CATALOG_PATHS = {
  crops: 'packages/knowledge/catalog/crops.json',
  species: 'packages/knowledge/catalog/species.json',
  sources: 'packages/knowledge/catalog/sources.json',
  regions: 'packages/knowledge/catalog/regions-zhejiang.json',
  herbicides: 'packages/knowledge/herbicides/records-2026.json',
  coverage: 'packages/knowledge/coverage-report.json',
};

/** GY-I07 种子数据文件相对仓库根的路径。 */
export const SEED_PATHS = {
  index: 'db/seeds/gy-i07/INDEX.json',
  herbicides: 'db/seeds/gy-i07/herbicides.json',
  weeds: 'db/seeds/gy-i07/weeds.json',
  weedMaster: 'db/seeds/gy-i07/weed_master.json',
  provinceIndex: 'db/seeds/gy-i07/province_index.json',
  controlTiming: 'db/seeds/gy-i07/control_timing.json',
  usageNotes: 'db/seeds/gy-i07/usage_notes.json',
};

/** 仓库根（相对本文件：packages/reference → 仓库根）。 */
export const REPO_ROOT = resolve(here, '..', '..');

/** 从仓库根解析目录文件绝对路径。 */
export function catalogPath(relPath) {
  return resolve(REPO_ROOT, relPath);
}

/** 读取并解析 JSON 文件（失败即抛，不静默返回空）。 */
export function readJson(relPath) {
  return JSON.parse(readFileSync(catalogPath(relPath), 'utf8'));
}

/** 断言某值属于契约枚举，否则抛错（不静默放行未知取值）。 */
export function assertInSet(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    throw new Error(`非法取值 ${fieldName}=${JSON.stringify(value)}，允许：${allowed.join('/')}`);
  }
  return value;
}
