/**
 * GY-I07 查询展示层 · 来源版本一致性与下架/失效缓存失效。
 *
 * 目标（#7 提交证据：「来源版本和下架缓存回归」）：
 *   1) **列表与详情同一 `source_version`**：同一记录任意入口取到的 source_version 相同；
 *   2) **ETag 派生自 source_version 集合**：集合快照变化即 ETag 变化 → 旧缓存失效；
 *   3) **下架/失效立即退出有效集合**：`hidden`/`deleted` 可见性或非 `valid` 有效期，
 *      下一拍查询即不再命中，且详情入口返回 NOT_FOUND（与列表一致）。
 *
 * 本模块不引入外部缓存；只提供**判定原语**与版本索引，供 service / 页面 / 测试使用。
 *
 * 纯 ESM，无第三方依赖（仅 node:crypto）。
 */

import { createHash } from 'node:crypto';
import { QUERYABLE_VALIDITIES, QUERYABLE_VISIBILITIES } from './constants.mjs';

/**
 * 构建来源版本索引：record_id / registration_number → 该记录**当前**source_version。
 * 用途：跨入口一致性核对（同一记录从列表与详情取到的 source_version 必须相等）。
 */
export function createVersionIndex(items) {
  const byRecordId = new Map();
  const byRegistration = new Map();
  for (const it of items) {
    byRecordId.set(it.record_id, it.source_version);
    byRegistration.set(it.registration_number, it.source_version);
  }
  return {
    size: byRecordId.size,
    versionForRecord: (recordId) => byRecordId.get(recordId) ?? null,
    versionForRegistration: (registrationNumber) => byRegistration.get(registrationNumber) ?? null,
    /** 校验两条 source_version 字符串是否一致（列表 vs 详情一致性断言）。 */
    consistent: (a, b) => typeof a === 'string' && a === b,
  };
}

/**
 * 由「记录身份 × source_version」集合派生 ETag（强 ETag，形如 "sv-N-<hash>"）。
 *
 * 关键：**不能只对 source_version 去重**。首批 20 条记录共用同一来源公告版本，
 * 只按版本串去重会让「下架其中一条」不改变 ETag —— 旧缓存不会失效。
 * 因此以「记录身份键（registration_number::identity_hash）@ source_version」为单位，
 * 排序后哈希：内容敏感、顺序无关，**下架/失效任一记录即变**。
 *
 * @param {Array<string|{key?:string, source_version?:string, registration_number?:string, identity_hash?:string}>} entries
 */
export function etagFor(entries) {
  const normalized = [
    ...new Set(
      (entries ?? [])
        .map((e) => {
          if (typeof e === 'string') return e;
          if (e && typeof e === 'object') {
            const key = e.key ?? (e.registration_number && e.identity_hash ? `${e.registration_number}::${e.identity_hash}` : e.registration_number ?? e.record_id ?? '');
            const ver = e.source_version ?? '';
            return `${key}@${ver}`;
          }
          return '';
        })
        .filter((v) => typeof v === 'string' && v !== ''),
    ),
  ].sort();
  const hash = createHash('sha256').update(normalized.join('\n'), 'utf8').digest('hex').slice(0, 32);
  return `"sv-${normalized.length}-${hash}"`;
}

/**
 * 判定记录当前是否「有效且可见」——与 query.evaluateEligibility 的可见/有效期口径**一致**，
 * 供缓存失效与一致性测试独立调用（避免两处口径漂移）。
 */
export function isActiveVersion(item) {
  const validity = item?.source?.source_validity ?? item?.source?.validity ?? 'unknown';
  const visibility = item?.visibility ?? 'published';
  return QUERYABLE_VALIDITIES.includes(validity) && QUERYABLE_VISIBILITIES.includes(visibility);
}

/**
 * 对一组记录应用「下架/失效」变更，返回**新的**items 数组（不修改入参）。
 * @param {Array} items 现有 items
 * @param {object} change { record_id, visibility?, validity? }
 * 语义：模拟内容治理侧的下架/失效事件，用于缓存回归测试。
 */
export function applyGovernanceChange(items, change) {
  return items.map((it) => {
    if (it.record_id !== change.record_id) return it;
    const nextVisibility = change.visibility ?? it.visibility;
    const nextValidity = change.validity ?? it.source?.source_validity ?? it.source?.validity ?? 'unknown';
    const nextSource = { ...it.source, source_validity: nextValidity };
    const nextReference = nextVisibility === 'published' && nextValidity === 'valid' ? it.reference_state : 'unavailable';
    return Object.freeze({ ...it, visibility: nextVisibility, source: Object.freeze(nextSource), reference_state: nextReference });
  });
}

/**
 * 计算「有效集合」的 ETag（只计入 active 记录），用于缓存失效断言：
 * 下架一条记录后，ETag 必变（因按记录身份键派生，见 etagFor）。
 */
export function activeEtag(items) {
  return etagFor(items.filter(isActiveVersion));
}
