/**
 * 后台「社区帖子下架」表单层 —— **纯函数**，无 Vue／DOM／网络依赖，可离线逐条测。
 *
 * 分工：本模块只做「操作员填的东西能不能提交」与「不能提交时第一句该说什么」；
 * 请求形状与错误映射在 `post-takedown-api.mjs`（同一套校验函数由那边复用，口径只有一份）。
 *
 * 为什么必须「按 ID 直接下架」而不是选列表：契约里**没有**帖子读面
 * （`packages/contracts/openapi.json` 只有 `/admin/posts/{id}/hide` 一条 `/admin/posts` path），
 * 造一份帖子列表就是伪造数据（`docs/ui-contract-binding.md` 已就此定口径）。
 */

import { buildReason, normalizePostId, validateRevision } from './post-takedown-api.mjs';

/** 表单一句话口径（页面与测试共用的说明文案，避免两处漂移）。 */
export const FORM_NOTE = '下架是单向操作：已删除的内容不复活；理由会进服务端审计（reason_code `post_hidden`），本页不写任何本地审计行。';

/** 确认勾选的文案（不可撤销这一点必须由操作员显式勾选，而不是默认勾上）。 */
export const CONFIRM_LABEL = '我已知晓：下架不可撤销、已删除内容不可复活，且本操作会进服务端审计';

/** 字段 → 中文名（错误文案与页面标题共用）。 */
export const FIELD_LABELS = Object.freeze({
  post_id: '帖子 ID',
  revision: '当前 revision',
  reason: '下架理由',
  confirmed: '确认勾选',
  idempotency_key: '幂等键',
  token: '后台会话令牌',
});

/** 空表单（长度与「刚好没填」一致）。 */
export function emptyTakedownForm() {
  return { post_id: '', revision: '', reason: '', confirmed: false };
}

/**
 * 校验整张表单。
 *
 * 返回 `{ok, problems: [{field, message}], value: {postId, revision, reason}}`。
 * `revision` 的 `*` 在这里就报 `wildcard`（服务端会 400），不会拖到发请求才失败。
 */
export function validateTakedownForm(form) {
  const problems = [];
  const postId = normalizePostId(form?.post_id);
  if (postId === null) {
    problems.push({ field: 'post_id', message: '帖子 ID 必填，且必须是 uuid（社区帖子 ID）' });
  }
  const revision = validateRevision(form?.revision);
  if (!revision.ok) problems.push({ field: 'revision', message: revision.problem });
  const reason = buildReason(form?.reason);
  if (!reason.ok) problems.push({ field: 'reason', message: reason.problem });
  if (form?.confirmed !== true) {
    problems.push({ field: 'confirmed', message: `必须勾选：${CONFIRM_LABEL}` });
  }
  return {
    ok: problems.length === 0,
    problems,
    value: {
      postId: postId ?? '',
      revision: revision.ok ? revision.revision : null,
      reason: reason.ok ? reason.reason : '',
    },
  };
}

/**
 * 提交按钮为什么被禁用（`null` = 可提交）。
 *
 * 顺序固定为 `submitting → scope_missing → post_id → revision → reason → confirmed`：
 * 页面永远只显示**第一句**最该先解决的问题（不是一次性把 6 条错误糊上去）。
 * `scope_missing` 只做**提示并禁用**，不放行也不替服务端判定（与 `SourcesView` 同口径）。
 */
export function submitBlockReason(form, { hasWriteScope = true, submitting = false } = {}) {
  if (submitting) return { code: 'submitting', message: '正在提交…（等待服务端回执，勿重复点击）' };
  if (!hasWriteScope) {
    return {
      code: 'scope_missing',
      message: '当前后台会话没有 sources:write：提交按钮已禁用；真实拒绝仍由服务端判定。',
    };
  }
  const checked = validateTakedownForm(form);
  if (checked.ok) return null;
  for (const field of ['post_id', 'revision', 'reason', 'confirmed']) {
    const hit = checked.problems.find((problem) => problem.field === field);
    if (hit !== undefined) return { code: field, message: hit.message };
  }
  return { code: 'invalid', message: '表单未通过校验' };
}

/** 是否可提交（`submitBlockReason(...) === null`）。 */
export function canSubmitTakedown(form, options) {
  return submitBlockReason(form, options) === null;
}
