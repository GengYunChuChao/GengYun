/**
 * 后台「社区帖子下架」页的**读面**层 —— 纯函数，无 Vue／DOM／网络依赖，可离线逐条测。
 *
 * 事实来源（2026-11-02 复核，逐条可核）：
 * - 契约 `packages/contracts/openapi.json` **有**帖子读面：`GET /admin/posts`（`listAdminPosts`）与
 *   `GET /admin/posts/{id}`（`getAdminPost`），两者 `x-scope` 都是 `sources:read`，详情 200 带 `ETag`；
 * - 路由在 `services/api/src/routes/admin.ts`（`requireAdmin` + 读面 scope 门）；
 * - 客户端不另写一份：直接用 `admin-moderation-queue.mjs` 的 `fetchAdminPostDetail`。
 *
 * 分工（本片的口径）：读面**只用来回填 revision、核对帖子身份**（标题／作者／可见性／audit_state）；
 * 读不到（403／404／会话过期／网络／503）一律回落成**手填 revision**。
 * ⛔ 读面失败不许把提交按钮禁掉：读面是便利，不是下架的前提。
 */

import {
  AUDIT_STATE_LABELS,
  MODERATION_READ_SCOPE,
  VISIBILITY_LABELS,
  formatModerationTimestamp,
  validateAdminPost,
} from './admin-moderation-queue.mjs';
import { normalizePostId } from './post-takedown-api.mjs';

/** 读面 scope（契约 `x-scope: sources:read`；与审核队列的读面同一个门）。 */
export const POST_READ_SCOPE = MODERATION_READ_SCOPE;

/** 「手填 revision」的风险口径：读面失败时页面必须原样说清，不许省略。 */
export const MANUAL_REVISION_RISK =
  '手填 revision 的风险：填错就等于拿别的修订去比对——写旧了服务端回 409 REVISION_CONFLICT（它不会替你猜当前值），'
  + '写新了会把一条已经变过的帖子按旧意图下架；请从处置现场或详情页抄当前值，提交前再核对一次。';

/** 回落口径：读面任何失败都必须显示这一句（读失败 ≠ 不许提交）。 */
export const READ_FALLBACK_NOTE =
  '读面失败不阻塞下架：revision 回落到手填，提交按钮照常可用；本页不会因为读不到就把按钮禁掉。';

const MAX_MESSAGE = 240;

function truncate(value) {
  if (typeof value !== 'string') return '';
  const chars = [...value];
  return chars.length <= MAX_MESSAGE ? value : `${chars.slice(0, MAX_MESSAGE).join('')}…（已截断）`;
}

/**
 * 读面回执 → 页面摘要（**只搬契约字段，不补不猜**）。
 *
 * 返回 `{ok: true, postId, title, author, visibility, visibilityLabel, auditState, auditStateLabel,
 * revision, updatedAtLabel}` 或 `{ok: false, problems: [{field, message}]}`。
 * 畸形 `AdminPost`（缺必填／枚举外）不产生摘要——页面据此走「读不到」的回落分支。
 */
export function postReadSummary(post) {
  const checked = validateAdminPost(post);
  if (checked.ok !== true) {
    return {
      ok: false,
      problems: checked.errors.map((error) => ({ field: error.path, message: error.problem })),
    };
  }
  const item = checked.post;
  return {
    ok: true,
    postId: item.id,
    title: item.title,
    author: item.author_id !== null ? item.author_id : item.anonymized_author_ref ?? '（作者已注销）',
    visibility: item.visibility,
    visibilityLabel: VISIBILITY_LABELS[item.visibility] ?? item.visibility,
    auditState: item.audit_state,
    auditStateLabel: AUDIT_STATE_LABELS[item.audit_state] ?? item.audit_state,
    revision: item.revision,
    updatedAtLabel: formatModerationTimestamp(item.updated_at),
  };
}

function statusPart(result) {
  return result.status === null || result.status === undefined || result.status === 0 ? '' : `HTTP ${result.status}`;
}

function codePart(result) {
  if (result.code === null || result.code === undefined) return '';
  return `错误码 ${result.code}${result.inContract === false ? '（契约外码）' : ''}`;
}

function reasonOf(result) {
  return [truncate(result.message ?? ''), codePart(result), statusPart(result)].filter((part) => part !== '').join(' · ');
}

/**
 * 读面失败 → 页面提示。`title` 说**为什么读不到**，`risk` 说手填的风险，`fallback` 说**提交照常可用**。
 *
 * 只认 `fetchAdminPostDetail` 的失败形状（`classifyQueueReadFailure`）；`null`／非失败对象返回 `null`。
 */
export function describePostReadFailure(result) {
  if (result === null || typeof result !== 'object' || result.ok !== false) return null;
  const tail = reasonOf(result);
  const base = { tone: 'warn', risk: MANUAL_REVISION_RISK, fallback: READ_FALLBACK_NOTE };

  switch (result.kind) {
    case 'forbidden':
      return {
        ...base,
        code: 'read_forbidden',
        title: `读不到帖子：会话缺 scope ${POST_READ_SCOPE}（HTTP 403）`,
        detail: `${tail || '服务端拒绝了读面'}｜后台会话有效，但详情读面要求 ${POST_READ_SCOPE}，本页没有别的读法`,
      };
    case 'not_found':
      return {
        ...base,
        code: 'read_not_found',
        title: '读不到帖子：服务端查不到这个 ID（HTTP 404）',
        detail: `${tail || '详情读面回 404'}｜404 与「已删除」不是同一回事（已删除是 409 OBJECT_UNAVAILABLE，那要真的发一次下架才会知道）`,
      };
    case 'signed_out':
      return {
        ...base,
        code: 'read_signed_out',
        title: '读不到帖子：未登录或会话已过期',
        detail: tail || '读面要求有效的后台会话',
      };
    case 'network_error':
      return {
        ...base,
        code: 'read_network_error',
        title: '读不到帖子：网络请求失败（结果未知）',
        detail: tail || '请求没有送达或回执丢了；这不代表帖子不存在',
      };
    case 'unavailable':
      return {
        ...base,
        code: 'read_unavailable',
        title: `读不到帖子：服务端暂不可用（${statusPart(result) || 'HTTP 5xx'}）`,
        detail: tail || '读面 503／504；服务端没有给出帖子数据',
      };
    case 'rate_limited':
      return {
        ...base,
        code: 'read_rate_limited',
        title: '读不到帖子：请求过于频繁（HTTP 429）',
        detail: tail || '按服务端 Retry-After 冷却后再读',
      };
    case 'invalid_request':
      return {
        ...base,
        code: 'read_invalid_request',
        title: '读不到帖子：帖子 ID 不是 uuid',
        detail: tail || '读面路径参数 format: uuid；本地就拦下了，没有发请求',
      };
    case 'invalid_response':
      return {
        ...base,
        code: 'read_invalid_response',
        title: '读不到帖子：读面回执不符合契约',
        detail: `${tail || '响应不是合法 AdminPost'}｜本页不猜缺了哪个字段，也不从畸形回执里回填 revision`,
      };
    default:
      return {
        ...base,
        code: 'read_failed',
        title: '读不到帖子：读面失败',
        detail: tail || '服务端没有给出可识别的结论',
      };
  }
}

/**
 * 「读取帖子确认」按钮为什么不可点（`null` = 可读）。
 *
 * 顺序：`reading → read_scope_missing → post_id`。缺读面 scope 只做**提示并禁用读取**，
 * 手填 revision 与提交照常（读面不是提交前提）。
 */
export function readBlockReason({ hasReadScope = true, reading = false, postId = '' } = {}) {
  if (reading) return { code: 'reading', message: '正在读取帖子详情…（等待读面回执，勿重复点击）' };
  if (!hasReadScope) {
    return {
      code: 'read_scope_missing',
      message: `当前后台会话没有 ${POST_READ_SCOPE}：读取按钮已禁用，revision 只能手填（读面失败同样不禁提交）。`,
    };
  }
  if (normalizePostId(postId) === null) {
    return { code: 'post_id', message: '先填帖子 ID（uuid）才能读取。' };
  }
  return null;
}
