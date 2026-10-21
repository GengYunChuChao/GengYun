/**
 * GY-I22（#22）失败回归矩阵 · 用例表。
 *
 * 一条用例 = 一个可执行断言：
 *   `id` + `method/path/headers/body` + `expect{status, code, etag}` + 拒绝不变量（runner 统一加）。
 *
 * 期望值全部来自**本轮在 `origin/main`（a2ab0d9）实跑出来的读数**，不是推测：
 * 每条 `expect` 后的行尾注释记录了实跑日期与执行模式（stub）。
 *
 * 表里没有的东西（本片不宣称）：
 * - 真实 AI 外呼、真机、微信端到端、真实对象存储/网络 → 一律「未取得」；
 * - 账号被停用（`users.state !== 'active'`）需要真实账号写权威，stub 世界不可达 → 见 `C3-22`（fail-closed 503）。
 */
import { API, ABSENT, SPECIES_ID } from './world.mjs';

/** 幂等键头（8..128 字符）。 */
const key = (value) => ({ 'idempotency-key': value });
/** 幂等键 + If-Match（强 ETag 带引号）。 */
const wkey = (value, ifMatch) => ({ 'idempotency-key': value, ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) });

const FAVORITE_BODY = { target_ref: { type: 'species', id: SPECIES_ID, revision: 1 } };
const POST_BODY = { title: '合成标题（矩阵）', body: '合成正文（矩阵），不含真实病例或真实农药用量。', media_ids: [] };
const UPLOAD_BODY = { purpose: 'community_image', mime: 'image/png', bytes: 1024, sha256: 'a'.repeat(64) };
const COMMUNITY_MEDIA_BODY = {
  content_ref: { type: 'post', id: ABSENT, revision: 1 },
  media_ref: { media_id: ABSENT, media_revision: 1 },
  slot: 'attachment',
  author_revision: 1,
};

export const BATCHES = [
  { id: 'B1', title: '批次 1：身份与权限面（游客 / 越权 / 后台 / 会话与注销）', families: ['C1', 'C2', 'C3', 'C4'] },
  { id: 'B2', title: '批次 2：媒体归属、重复请求与无效输入', families: ['C5', 'C6', 'C7'] },
];

export const FAMILIES = {
  C1: '游客面：没有凭据时一律 401 SESSION_REQUIRED（不是 403/404/500）',
  C2: '越权（IDOR）：A 不得读写 B 的私有行；「不是你的」与「不存在」同形 404',
  C3: '后台：用户会话 → 403 SCOPE_DENIED；后台缺 scope → 403；后台有 scope → 2xx；未接线面 fail-closed 503',
  C4: '会话与注销：注销/过期/旧 epoch/坏凭据的拒绝码；注销回执 bearer 的绑定与换发',
  C5: '媒体归属与媒体访问凭据：跨主体 404、缺 / 错 token、内容-媒体不匹配',
  C6: '重复请求（Idempotency-Key）：同键同体重放同一结果、同键异体 409、缺键 400、并发只产生一行',
  C7: '无效输入：坏 uuid / 坏游标 / 越界分页 / 多余字段一律 400（含 INVALID_CURSOR）',
};

export const CASES = [
  // ---------------------------------------------------------------- C1 游客面
  { id: 'C1-01', family: 'C1', title: '游客读收藏列表', method: 'GET', path: `${API}/favorites`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-02', family: 'C1', title: '游客写收藏', method: 'POST', path: `${API}/favorites`, body: FAVORITE_BODY, headers: key('i22-c1-02'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-03', family: 'C1', title: '游客取消收藏', method: 'DELETE', path: `${API}/favorites/${ABSENT}`, headers: wkey('i22-c1-03', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-04', family: 'C1', title: '游客读历史', method: 'GET', path: `${API}/history`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-05', family: 'C1', title: '游客删历史', method: 'DELETE', path: `${API}/history/${ABSENT}`, headers: wkey('i22-c1-05', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-06', family: 'C1', title: '游客读消息', method: 'GET', path: `${API}/messages`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-07', family: 'C1', title: '游客读未读数', method: 'GET', path: `${API}/messages/unread-count`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-08', family: 'C1', title: '游客标记已读', method: 'PUT', path: `${API}/messages/${ABSENT}/read`, headers: wkey('i22-c1-08', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-09', family: 'C1', title: '游客建上传句柄', method: 'POST', path: `${API}/media/uploads`, body: UPLOAD_BODY, headers: key('i22-c1-09'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-10', family: 'C1', title: '游客完成上传', method: 'POST', path: `${API}/media/uploads/${ABSENT}/complete`, body: { sha256: 'a'.repeat(64), bytes: 1024 }, headers: wkey('i22-c1-10', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-11', family: 'C1', title: '游客读媒体元数据', method: 'GET', path: `${API}/media/${ABSENT}`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-12', family: 'C1', title: '游客删媒体', method: 'DELETE', path: `${API}/media/${ABSENT}`, headers: wkey('i22-c1-12', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-13', family: 'C1', title: '游客申请媒体访问', method: 'POST', path: `${API}/media/${ABSENT}/access`, body: {}, headers: wkey('i22-c1-13', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-14', family: 'C1', title: '游客申请社区媒体访问', method: 'POST', path: `${API}/community/media-access`, body: COMMUNITY_MEDIA_BODY, headers: wkey('i22-c1-14', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-15', family: 'C1', title: '游客取社区媒体内容', method: 'GET', path: `${API}/community/media/${ABSENT}/content`, headers: { 'x-media-access-token': 'synthetic-token' }, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-16', family: 'C1', title: '游客读帖子列表', method: 'GET', path: `${API}/posts`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-17', family: 'C1', title: '游客发帖', method: 'POST', path: `${API}/posts`, body: POST_BODY, headers: key('i22-c1-17'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-18', family: 'C1', title: '游客读单帖', method: 'GET', path: `${API}/posts/${ABSENT}`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-19', family: 'C1', title: '游客发评论', method: 'POST', path: `${API}/posts/${ABSENT}/comments`, body: { body: '合成评论（矩阵）' }, headers: wkey('i22-c1-19', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-20', family: 'C1', title: '游客读评论列表', method: 'GET', path: `${API}/posts/${ABSENT}/comments`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-21', family: 'C1', title: '游客改评论', method: 'PATCH', path: `${API}/comments/${ABSENT}`, body: { body: '合成评论（矩阵）' }, headers: wkey('i22-c1-21', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-22', family: 'C1', title: '游客点赞', method: 'PUT', path: `${API}/posts/${ABSENT}/like`, headers: wkey('i22-c1-22', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-23', family: 'C1', title: '游客举报', method: 'POST', path: `${API}/reports`, body: { target_ref: { type: 'post', id: ABSENT, revision: 1 }, reason_code: 'other' }, headers: key('i22-c1-23'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-24', family: 'C1', title: '游客查举报', method: 'GET', path: `${API}/reports/${ABSENT}`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-25', family: 'C1', title: '游客读档案', method: 'GET', path: `${API}/me/profile`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-26', family: 'C1', title: '游客写档案', method: 'PUT', path: `${API}/me/profile`, body: { crop_id: 'rice', region_code: '330100', region_catalog_version: 'v1' }, headers: key('i22-c1-26'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-27', family: 'C1', title: '游客读会话', method: 'GET', path: `${API}/auth/session`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-28', family: 'C1', title: '游客注销', method: 'POST', path: `${API}/auth/logout`, headers: key('i22-c1-28'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-29', family: 'C1', title: '游客申请账号注销', method: 'POST', path: `${API}/me/account/deletion`, body: { confirmation: 'delete_account' }, headers: key('i22-c1-29'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-30', family: 'C1', title: '游客读注销回执（无回执 bearer）', method: 'GET', path: `${API}/account/deletions/${ABSENT}`, expect: { status: 401, code: 'SESSION_REQUIRED' }, note: 'message 是「需要注销回执 bearer」：该路由鉴权的是回执而不是会话' },
  { id: 'C1-31', family: 'C1', title: '游客读同意书', method: 'GET', path: `${API}/me/consents`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-32', family: 'C1', title: '游客读目录', method: 'GET', path: `${API}/catalog/crops`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-33', family: 'C1', title: '游客读除草剂目录', method: 'GET', path: `${API}/herbicides`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-34', family: 'C1', title: '游客读知识库', method: 'GET', path: `${API}/knowledge`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-35', family: 'C1', title: '游客读后台内容族', method: 'GET', path: `${API}/admin/sources`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-36', family: 'C1', title: '游客读后台会话', method: 'GET', path: `${API}/admin/auth/session`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C1-37', family: 'C1', title: '游客停用他人账号', method: 'POST', path: `${API}/admin/accounts/${ABSENT}/suspend`, body: { reason: 'synthetic' }, headers: wkey('i22-c1-37', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },

  // --------------------------------------------------------------- C2 越权 IDOR
  { id: 'C2-01', family: 'C2', title: 'A 读 B 的媒体元数据', actor: 'a', method: 'GET', path: (ctx) => `${API}/media/${ctx.seeded.media.mediaId}`, expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C2-11' },
  { id: 'C2-02', family: 'C2', title: 'A 删 B 的媒体', actor: 'a', method: 'DELETE', path: (ctx) => `${API}/media/${ctx.seeded.media.mediaId}`, headers: (ctx) => wkey('i22-c2-02', `"${ctx.seeded.media.revision}"`), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C2-12' },
  { id: 'C2-03', family: 'C2', title: 'A 申请 B 的媒体访问', actor: 'a', method: 'POST', path: (ctx) => `${API}/media/${ctx.seeded.media.mediaId}/access`, body: {}, headers: (ctx) => wkey('i22-c2-03', `"${ctx.seeded.media.revision}"`), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C2-13' },
  { id: 'C2-04', family: 'C2', title: 'A 取消 B 的收藏', actor: 'a', method: 'DELETE', path: (ctx) => `${API}/favorites/${ctx.seeded.favoriteId}`, headers: wkey('i22-c2-04', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C2-14' },
  { id: 'C2-05', family: 'C2', title: 'A 删 B 的历史', actor: 'a', method: 'DELETE', path: (ctx) => `${API}/history/${ctx.seeded.historyId}`, headers: wkey('i22-c2-05', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C2-15' },
  { id: 'C2-06', family: 'C2', title: 'A 标记 B 的消息已读', actor: 'a', method: 'PUT', path: (ctx) => `${API}/messages/${ctx.seeded.messageId}/read`, headers: wkey('i22-c2-06', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C2-16' },
  { id: 'C2-07', family: 'C2', title: 'A 删 B 的帖子', actor: 'a', method: 'DELETE', path: (ctx) => `${API}/posts/${ctx.seeded.postId}`, headers: wkey('i22-c2-07', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C2-17' },
  { id: 'C2-08', family: 'C2', title: 'A 改 B 的帖子', actor: 'a', method: 'PATCH', path: (ctx) => `${API}/posts/${ctx.seeded.postId}`, body: { title: 'A 想改别人的帖子', body: 'A 的正文', media_ids: [] }, headers: wkey('i22-c2-08', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C2-09', family: 'C2', title: 'A 改 B 的评论', actor: 'a', method: 'PATCH', path: (ctx) => `${API}/comments/${ctx.seeded.commentId}`, body: { body: 'A 想改别人的评论' }, headers: wkey('i22-c2-09', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C2-18' },
  { id: 'C2-10', family: 'C2', title: 'A 删 B 的评论', actor: 'a', method: 'DELETE', path: (ctx) => `${API}/comments/${ctx.seeded.commentId}`, headers: wkey('i22-c2-10', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C2-18' },
  { id: 'C2-11', family: 'C2', title: '对照：A 读不存在的媒体', actor: 'a', method: 'GET', path: `${API}/media/${ABSENT}`, expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C2-12', family: 'C2', title: '对照：A 删不存在的媒体', actor: 'a', method: 'DELETE', path: `${API}/media/${ABSENT}`, headers: wkey('i22-c2-12', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C2-13', family: 'C2', title: '对照：A 申请不存在媒体的访问', actor: 'a', method: 'POST', path: `${API}/media/${ABSENT}/access`, body: {}, headers: wkey('i22-c2-13', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C2-14', family: 'C2', title: '对照：A 取消不存在的收藏', actor: 'a', method: 'DELETE', path: `${API}/favorites/${ABSENT}`, headers: wkey('i22-c2-14', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C2-15', family: 'C2', title: '对照：A 删不存在的历史', actor: 'a', method: 'DELETE', path: `${API}/history/${ABSENT}`, headers: wkey('i22-c2-15', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C2-16', family: 'C2', title: '对照：A 标记不存在的消息', actor: 'a', method: 'PUT', path: `${API}/messages/${ABSENT}/read`, headers: wkey('i22-c2-16', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C2-17', family: 'C2', title: '对照：A 删不存在的帖子', actor: 'a', method: 'DELETE', path: `${API}/posts/${ABSENT}`, headers: wkey('i22-c2-17', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C2-18', family: 'C2', title: '对照：A 改不存在的评论', actor: 'a', method: 'PATCH', path: `${API}/comments/${ABSENT}`, body: { body: '合成评论（矩阵）' }, headers: wkey('i22-c2-18', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C2-19', family: 'C2', title: '反向控制：A 能读 B 的公开帖子（不得过度拦截）', actor: 'a', method: 'GET', path: (ctx) => `${API}/posts/${ctx.seeded.postId}`, expect: { status: 200 }, note: '公开内容不是越权；若这条变红说明守卫把公共面也拦了' },
  { id: 'C2-20', family: 'C2', title: 'A 查 B 的举报', actor: 'a', method: 'GET', path: (ctx) => `${API}/reports/${ctx.seeded.reportId}`, expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C2-21' },
  { id: 'C2-21', family: 'C2', title: '对照：A 查不存在的举报', actor: 'a', method: 'GET', path: `${API}/reports/${ABSENT}`, expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C2-22', family: 'C2', title: 'A 的收藏列表不含 B 的行', actor: 'a', method: 'GET', path: `${API}/favorites?limit=50`, expect: { status: 200 }, check: (result, ctx) => {
    const items = result.body?.data?.items ?? [];
    return items.some((item) => item.id === ctx.seeded.favoriteId) ? ['A 的收藏列表里出现了 B 的收藏行（跨主体列表泄露）'] : [];
  } },
  { id: 'C2-23', family: 'C2', title: 'A 的历史列表不含 B 的行', actor: 'a', method: 'GET', path: `${API}/history?limit=50`, expect: { status: 200 }, check: (result, ctx) => {
    const items = result.body?.data?.items ?? [];
    return items.some((item) => item.id === ctx.seeded.historyId) ? ['A 的历史列表里出现了 B 的历史行（跨主体列表泄露）'] : [];
  } },
  { id: 'C2-24', family: 'C2', title: 'A 的消息列表不含 B 的行', actor: 'a', method: 'GET', path: `${API}/messages?limit=50`, expect: { status: 200 }, check: (result, ctx) => {
    const items = result.body?.data?.items ?? [];
    return items.some((item) => item.id === ctx.seeded.messageId) ? ['A 的消息列表里出现了 B 的消息行（跨主体列表泄露）'] : [];
  } },

  // ---------------------------------------------------------------- C3 后台
  { id: 'C3-01', family: 'C3', title: '用户会话读后台内容族', actor: 'a', method: 'GET', path: `${API}/admin/sources`, expect: { status: 403, code: 'SCOPE_DENIED' } },
  { id: 'C3-02', family: 'C3', title: '用户会话读后台账号列表', actor: 'a', method: 'GET', path: `${API}/admin/accounts`, expect: { status: 403, code: 'SCOPE_DENIED' } },
  { id: 'C3-03', family: 'C3', title: '用户会话读后台作业', actor: 'a', method: 'GET', path: `${API}/admin/jobs`, expect: { status: 403, code: 'SCOPE_DENIED' } },
  { id: 'C3-04', family: 'C3', title: '用户会话读审计事件', actor: 'a', method: 'GET', path: `${API}/admin/audit-events`, expect: { status: 403, code: 'SCOPE_DENIED' } },
  { id: 'C3-05', family: 'C3', title: '用户会话读分类', actor: 'a', method: 'GET', path: `${API}/admin/categories`, expect: { status: 403, code: 'SCOPE_DENIED' } },
  { id: 'C3-06', family: 'C3', title: '用户会话读特性开关', actor: 'a', method: 'GET', path: `${API}/admin/feature-flags`, expect: { status: 403, code: 'SCOPE_DENIED' } },
  { id: 'C3-07', family: 'C3', title: '用户会话隐藏帖子', actor: 'a', method: 'POST', path: (ctx) => `${API}/admin/posts/${ctx.seeded.postId}/hide`, body: { reason: 'synthetic-hide' }, headers: wkey('i22-c3-07', '"1"'), expect: { status: 403, code: 'SCOPE_DENIED' } },
  { id: 'C3-08', family: 'C3', title: '用户会话停用账号', actor: 'a', method: 'POST', path: (ctx) => `${API}/admin/accounts/${ctx.b.userId}/suspend`, body: { reason: 'synthetic-suspend' }, headers: wkey('i22-c3-08', '"1"'), expect: { status: 403, code: 'SCOPE_DENIED' } },
  { id: 'C3-09', family: 'C3', title: '零 scope 后台会话读内容族', actor: 'adminNone', method: 'GET', path: `${API}/admin/sources`, expect: { status: 403, code: 'SCOPE_DENIED' } },
  { id: 'C3-10', family: 'C3', title: '只有 sources:read 的后台会话读账号列表', actor: 'adminRead', method: 'GET', path: `${API}/admin/accounts`, expect: { status: 403, code: 'SCOPE_DENIED' } },
  { id: 'C3-11', family: 'C3', title: '只有 sources:read 的后台会话读作业', actor: 'adminRead', method: 'GET', path: `${API}/admin/jobs`, expect: { status: 403, code: 'SCOPE_DENIED' } },
  { id: 'C3-12', family: 'C3', title: '零 scope 后台会话登出', actor: 'adminNone', method: 'POST', path: `${API}/admin/auth/logout`, headers: key('i22-c3-12'), expect: { status: 403, code: 'SCOPE_DENIED' } },
  { id: 'C3-13', family: 'C3', title: '只有 sources:read 的后台会话隐藏帖子', actor: 'adminRead', method: 'POST', path: (ctx) => `${API}/admin/posts/${ctx.seeded.postId}/hide`, body: { reason: 'synthetic-hide' }, headers: wkey('i22-c3-13', '"1"'), expect: { status: 403, code: 'SCOPE_DENIED' } },
  { id: 'C3-14', family: 'C3', title: '正控制：sources:read 后台会话读内容族', actor: 'adminRead', method: 'GET', path: `${API}/admin/sources`, expect: { status: 200 } },
  { id: 'C3-15', family: 'C3', title: '正控制：全 scope 后台会话读审计事件', actor: 'adminFull', method: 'GET', path: `${API}/admin/audit-events`, expect: { status: 200 } },
  { id: 'C3-16', family: 'C3', title: '正控制：全 scope 后台会话读特性开关', actor: 'adminFull', method: 'GET', path: `${API}/admin/feature-flags`, expect: { status: 200 } },
  { id: 'C3-17', family: 'C3', title: '正控制：全 scope 后台会话读后台会话', actor: 'adminFull', method: 'GET', path: `${API}/admin/auth/session`, expect: { status: 200 } },
  { id: 'C3-18', family: 'C3', title: '后台隐藏帖子缺 If-Match', actor: 'adminFull', method: 'POST', path: (ctx) => `${API}/admin/posts/${ctx.seeded.postId}/hide`, body: { reason: 'synthetic-hide' }, headers: key('i22-c3-18'), expect: { status: 428, code: 'REVISION_REQUIRED' } },
  { id: 'C3-19', family: 'C3', title: '后台读账号列表（账号权威未接线）', actor: 'adminFull', method: 'GET', path: `${API}/admin/accounts`, expect: { status: 503, code: 'PROVIDER_UNAVAILABLE' }, note: 'fail-closed：stub 世界没有账号读权威，返回 503 而不是空列表' },
  { id: 'C3-20', family: 'C3', title: '后台读作业面（未接线）', actor: 'adminFull', method: 'GET', path: `${API}/admin/jobs`, expect: { status: 503, code: 'PROVIDER_UNAVAILABLE' } },
  { id: 'C3-21', family: 'C3', title: '后台停用账号（未接线）', actor: 'adminFull', method: 'POST', path: (ctx) => `${API}/admin/accounts/${ctx.b.userId}/suspend`, body: { reason: 'synthetic-suspend' }, headers: wkey('i22-c3-21', '"1"'), expect: { status: 503, code: 'PROVIDER_UNAVAILABLE' }, note: '账号写权威未注入时 fail-closed 503，绝不假装成功' },
  { id: 'C3-22', family: 'C3', title: '后台读不存在的内容族条目', actor: 'adminFull', method: 'GET', path: `${API}/admin/sources/${ABSENT}`, expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C3-23', family: 'C3', title: '后台会话读用户会话（不得代替）', actor: 'adminFull', method: 'GET', path: `${API}/auth/session`, expect: { status: 401, code: 'SESSION_EXPIRED' } },
  { id: 'C3-24', family: 'C3', title: '后台会话读社区面（不得代替）', actor: 'adminFull', method: 'GET', path: `${API}/posts`, expect: { status: 401, code: 'SESSION_EXPIRED' } },
  { id: 'C3-25', family: 'C3', title: '正控制：全 scope 后台隐藏帖子', actor: 'adminFull', method: 'POST', path: (ctx) => `${API}/admin/posts/${ctx.hideTargetPostId}/hide`, body: { reason: 'synthetic-hide' }, headers: wkey('i22-c3-25', '"1"'), expect: { status: 200 }, check: (result) => (result.body?.data?.accepted === true ? [] : [`data.accepted 期望 true 实际 ${JSON.stringify(result.body?.data?.accepted)}`]), note: '隐藏目标是 runner 单独播种的一帖（ctx.hideTargetPostId），避免污染其它族对 ctx.seeded.postId 的用例' },
  { id: 'C3-26', family: 'C3', title: '正控制：隐藏留痕（审计事件指向被隐藏帖子）', actor: 'adminFull', method: 'GET', path: `${API}/admin/audit-events`, expect: { status: 200 }, check: (result, ctx) => {
    const problems = [];
    const items = result.body?.data?.items ?? [];
    const hit = items.find((item) => item.action === 'post.hide');
    if (hit === undefined) problems.push(`审计事件里没有 post.hide（隐藏未留痕）：actions=${JSON.stringify(items.map((item) => item.action))}`);
    else if (!JSON.stringify(hit).includes(ctx.hideTargetPostId)) problems.push('post.hide 审计事件没有指向被隐藏的帖子 id');
    return problems;
  } },
  { id: 'C3-27', family: 'C3', title: '后台隐藏后该帖对普通用户不可见', actor: 'a', method: 'GET', path: (ctx) => `${API}/posts/${ctx.hideTargetPostId}`, expect: { status: 404, code: 'NOT_FOUND' }, note: '隐藏必须真生效：不是只写一条审计' },

  // ------------------------------------------------------- C4 会话与注销
  { id: 'C4-01', family: 'C4', title: '注销缺幂等键', actor: 'fresh', method: 'POST', path: `${API}/auth/logout`, expect: { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' } },
  { id: 'C4-02', family: 'C4', title: '注销成功', actor: 'fresh', method: 'POST', path: `${API}/auth/logout`, headers: key('i22-c4-02'), expect: { status: 200 }, check: (result) => (result.body?.data?.accepted === true ? [] : [`data.accepted 期望 true 实际 ${JSON.stringify(result.body?.data?.accepted)}`]) },
  { id: 'C4-03', family: 'C4', title: '注销后旧会话读收藏', actor: 'logout', method: 'GET', path: `${API}/favorites`, expect: { status: 401, code: 'SESSION_EXPIRED' } },
  { id: 'C4-04', family: 'C4', title: '注销键重放（会话已撤销）', actor: 'logout', method: 'POST', path: `${API}/auth/logout`, headers: key('i22-c4-logout'), expect: { status: 401, code: 'SESSION_EXPIRED' }, note: '退出类请求不重放旧 Ack：会话撤销后重放得到 401' },
  { id: 'C4-05', family: 'C4', title: '过期会话', actor: 'expired', method: 'GET', path: `${API}/favorites`, expect: { status: 401, code: 'SESSION_EXPIRED' } },
  { id: 'C4-06', family: 'C4', title: '账号 epoch 变更后的旧会话', actor: 'stale', method: 'GET', path: `${API}/favorites`, expect: { status: 403, code: 'ACCOUNT_INACTIVE' } },
  { id: 'C4-07', family: 'C4', title: '非 Bearer 凭据', method: 'GET', path: `${API}/favorites`, headers: { authorization: 'Basic dXNlcjpwYXNz' }, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C4-08', family: 'C4', title: '空 Bearer', method: 'GET', path: `${API}/favorites`, headers: { authorization: 'Bearer ' }, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C4-09', family: 'C4', title: '小写 bearer（不合规 scheme）', method: 'GET', path: `${API}/favorites`, headers: { authorization: 'bearer c3ludGhldGlj' }, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C4-10', family: 'C4', title: '注销申请确认词错误', actor: 'deleter', method: 'POST', path: `${API}/me/account/deletion`, body: { confirmation: 'delete' }, headers: key('i22-c4-10'), expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C4-11', family: 'C4', title: '注销申请缺幂等键', actor: 'deleter', method: 'POST', path: `${API}/me/account/deletion`, body: { confirmation: 'delete_account' }, expect: { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' } },
  { id: 'C4-12', family: 'C4', title: '回执 bearer 读自己的注销单', actor: 'deleter', method: 'GET', path: (ctx) => `${API}/account/deletions/${ctx.actors.deleter.deletionId}`, headers: (ctx) => ({ authorization: `Bearer ${ctx.actors.deleter.receipt}` }), expect: { status: 200, etag: true } },
  { id: 'C4-13', family: 'C4', title: '用户会话不能当回执用', actor: 'deleter', method: 'GET', path: (ctx) => `${API}/account/deletions/${ctx.actors.deleter.deletionId}`, expect: { status: 401, code: 'SESSION_EXPIRED' } },
  { id: 'C4-14', family: 'C4', title: '回执跨单使用（改路径 id）', actor: 'deleter', method: 'GET', path: `${API}/account/deletions/${ABSENT}`, headers: (ctx) => ({ authorization: `Bearer ${ctx.actors.deleter.receipt}` }), expect: { status: 401, code: 'SESSION_EXPIRED' } },
  { id: 'C4-15', family: 'C4', title: '注销申请重放：同一单 + 换发回执', actor: 'deleter', method: 'POST', path: `${API}/me/account/deletion`, body: { confirmation: 'delete_account' }, headers: key('i22-c4-deletion'), expect: { status: 202 }, check: (result, ctx) => {
    const problems = [];
    const prior = ctx.actors.deleter;
    if (result.body?.data?.deletion?.id !== prior.deletionId) problems.push(`重放产生了新的注销单 id（幂等失效）：${result.body?.data?.deletion?.id}`);
    if (typeof result.body?.data?.receipt_token !== 'string' || result.body.data.receipt_token === prior.receipt) problems.push('重放没有换发新回执');
    return problems;
  }, after: (result, ctx) => {
    const deleter = ctx.actors.deleter;
    deleter.staleReceipt = deleter.receipt;
    if (typeof result.body?.data?.receipt_token === 'string') deleter.receipt = result.body.data.receipt_token;
  } },
  { id: 'C4-16', family: 'C4', title: '换发后旧回执失效', actor: 'deleter', method: 'GET', path: (ctx) => `${API}/account/deletions/${ctx.actors.deleter.deletionId}`, headers: (ctx) => ({ authorization: `Bearer ${ctx.actors.deleter.staleReceipt}` }), expect: { status: 401, code: 'SESSION_EXPIRED' } },
  { id: 'C4-17', family: 'C4', title: '换发后新回执可用', actor: 'deleter', method: 'GET', path: (ctx) => `${API}/account/deletions/${ctx.actors.deleter.deletionId}`, headers: (ctx) => ({ authorization: `Bearer ${ctx.actors.deleter.receipt}` }), expect: { status: 200 } },
  { id: 'C4-18', family: 'C4', title: '冷静期内原会话仍可用（注销在线 7 日到期前）', actor: 'deleter', method: 'GET', path: `${API}/favorites`, expect: { status: 200 }, note: '契约：注销申请后在线数据保留 7 日（cooling-off），到期前会话仍可用；到期后的失效由 deletion 执行面负责（未取得）' },

  // ---------------------------------------------------------------- C5 媒体
  { id: 'C5-01', family: 'C5', title: '上传句柄带多余字段', actor: 'a', method: 'POST', path: `${API}/media/uploads`, body: { ...UPLOAD_BODY, object_key: 'evil/key' }, headers: key('i22-c5-01'), expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C5-02', family: 'C5', title: '上传 sha256 形状非法', actor: 'a', method: 'POST', path: `${API}/media/uploads`, body: { ...UPLOAD_BODY, sha256: 'abc' }, headers: key('i22-c5-02'), expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C5-03', family: 'C5', title: '完成不存在的上传', actor: 'a', method: 'POST', path: `${API}/media/uploads/${ABSENT}/complete`, body: { sha256: 'a'.repeat(64), bytes: 1024 }, headers: wkey('i22-c5-03', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C5-04', family: 'C5', title: '社区媒体内容缺 X-Media-Access-Token', actor: 'a', method: 'GET', path: `${API}/community/media/${ABSENT}/content`, expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C5-05', family: 'C5', title: '社区媒体内容 token 在但授权不存在', actor: 'a', method: 'GET', path: `${API}/community/media/${ABSENT}/content`, headers: { 'x-media-access-token': 'synthetic-token' }, expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C5-06', family: 'C5', title: '社区媒体授权 id 非 uuid', actor: 'a', method: 'GET', path: `${API}/community/media/not-a-uuid/content`, headers: { 'x-media-access-token': 'synthetic-token' }, expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C5-07', family: 'C5', title: '内容-媒体不匹配的社区媒体授权', actor: 'a', method: 'POST', path: `${API}/community/media-access`, body: (ctx) => ({ content_ref: { type: 'post', id: ctx.seeded.postId, revision: 1 }, media_ref: { media_id: ctx.seeded.media.mediaId, media_revision: ctx.seeded.media.revision }, slot: 'attachment', author_revision: 1 }), headers: wkey('i22-c5-07', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, note: '帖子没有该附件 ⇒ 一律 404，不因为媒体属于自己就放行' },
  { id: 'C5-08', family: 'C5', title: 'B 能申请自己媒体的访问（正控制）', actor: 'b', method: 'POST', path: (ctx) => `${API}/media/${ctx.seeded.media.mediaId}/access`, body: {}, headers: (ctx) => wkey('i22-c5-08', `"${ctx.seeded.media.revision}"`), expect: { status: 200 }, check: (result) => {
    const data = result.body?.data ?? {};
    const problems = [];
    if (typeof data.url !== 'string' || data.url === '') problems.push('data.url 缺失');
    if (typeof data.access_token !== 'string' || data.access_token === '') problems.push('data.access_token 缺失');
    if (typeof data.expires_at !== 'string') problems.push('data.expires_at 缺失');
    return problems;
  } },
  { id: 'C5-09', family: 'C5', title: 'B 能读自己媒体的元数据（正控制）', actor: 'b', method: 'GET', path: (ctx) => `${API}/media/${ctx.seeded.media.mediaId}`, expect: { status: 200, etag: true } },
  { id: 'C5-10', family: 'C5', title: '媒体路径 id 非 uuid', actor: 'a', method: 'GET', path: `${API}/media/not-a-uuid`, expect: { status: 400, code: 'INVALID_REQUEST' } },

  // ------------------------------------------------------------ C6 重复请求
  { id: 'C6-01', family: 'C6', title: '写收藏（首次）', actor: 'a', method: 'POST', path: `${API}/favorites`, body: { target_ref: { type: 'species', id: SPECIES_ID, revision: 1 } }, headers: key('i22-c6-fav'), expect: { status: 201, etag: true } },
  { id: 'C6-02', family: 'C6', title: '同键同体重放：同一行', actor: 'a', method: 'POST', path: `${API}/favorites`, body: { target_ref: { type: 'species', id: SPECIES_ID, revision: 1 } }, headers: key('i22-c6-fav'), expect: { status: 201, etag: true }, check: (result, ctx) => {
    const first = ctx.results.get('C6-01');
    if (first?.body?.data?.id !== result.body?.data?.id) return [`重放返回了不同 id（幂等失效）：${first?.body?.data?.id} vs ${result.body?.data?.id}`];
    return [];
  } },
  { id: 'C6-03', family: 'C6', title: '同键异体：409', actor: 'a', method: 'POST', path: `${API}/favorites`, body: { target_ref: { type: 'herbicide', id: SPECIES_ID, revision: 1 } }, headers: key('i22-c6-fav'), expect: { status: 409, code: 'IDEMPOTENCY_CONFLICT' } },
  { id: 'C6-04', family: 'C6', title: '缺幂等键：400', actor: 'a', method: 'POST', path: `${API}/favorites`, body: { target_ref: { type: 'species', id: SPECIES_ID, revision: 2 } }, expect: { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' } },
  { id: 'C6-05', family: 'C6', title: '发帖（首次）', actor: 'a', method: 'POST', path: `${API}/posts`, body: POST_BODY, headers: key('i22-c6-post'), expect: { status: 201, etag: true } },
  { id: 'C6-06', family: 'C6', title: '同键同体重放：同一帖', actor: 'a', method: 'POST', path: `${API}/posts`, body: POST_BODY, headers: key('i22-c6-post'), expect: { status: 201, etag: true }, check: (result, ctx) => {
    const first = ctx.results.get('C6-05');
    if (first?.body?.data?.id !== result.body?.data?.id) return [`重放返回了不同帖子 id：${first?.body?.data?.id} vs ${result.body?.data?.id}`];
    return [];
  } },
  { id: 'C6-07', family: 'C6', title: '同键异体重放帖子：409', actor: 'a', method: 'POST', path: `${API}/posts`, body: { ...POST_BODY, title: '另一个合成标题' }, headers: key('i22-c6-post'), expect: { status: 409, code: 'IDEMPOTENCY_CONFLICT' } },
  { id: 'C6-08', family: 'C6', title: '举报（首次）', actor: 'a', method: 'POST', path: `${API}/reports`, body: (ctx) => ({ target_ref: { type: 'post', id: ctx.seeded.postId, revision: 1 }, reason_code: 'other' }), headers: key('i22-c6-report'), expect: { status: 201, etag: true } },
  { id: 'C6-09', family: 'C6', title: '同键同体重放举报：同一行', actor: 'a', method: 'POST', path: `${API}/reports`, body: (ctx) => ({ target_ref: { type: 'post', id: ctx.seeded.postId, revision: 1 }, reason_code: 'other' }), headers: key('i22-c6-report'), expect: { status: 201, etag: true }, check: (result, ctx) => {
    const first = ctx.results.get('C6-08');
    if (first?.body?.data?.id !== result.body?.data?.id) return [`重放返回了不同举报 id：${first?.body?.data?.id} vs ${result.body?.data?.id}`];
    return [];
  } },
  { id: 'C6-10', family: 'C6', title: '并发同键写收藏：只产生一行', actor: 'a', concurrent: 2, method: 'POST', path: `${API}/favorites`, body: { target_ref: { type: 'species', id: SPECIES_ID, revision: 3 } }, headers: key('i22-c6-concurrent'), expect: { status: 201 }, check: (results) => {
    const problems = [];
    const ok = results.filter((r) => r.status === 201);
    const busy = results.filter((r) => r.status === 409);
    if (ok.length + busy.length !== results.length) problems.push(`出现非 201/409 的响应：${results.map((r) => r.status).join(',')}`);
    if (busy.some((r) => r.body?.error?.code !== 'REQUEST_IN_PROGRESS')) problems.push('409 的错误码不是 REQUEST_IN_PROGRESS');
    if (busy.some((r) => r.body?.error?.retryable !== true)) problems.push('REQUEST_IN_PROGRESS 必须 retryable=true');
    const ids = new Set(ok.map((r) => r.body?.data?.id));
    if (ids.size > 1) problems.push(`并发同键产生了多行：${[...ids].join(',')}`);
    return problems;
  } },

  // ------------------------------------------------------------ C7 无效输入
  { id: 'C7-01', family: 'C7', title: '帖子路径 id 非 uuid', actor: 'a', method: 'GET', path: `${API}/posts/not-a-uuid`, expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C7-02', family: 'C7', title: '取消收藏路径 id 非 uuid', actor: 'a', method: 'DELETE', path: `${API}/favorites/not-a-uuid`, headers: wkey('i22-c7-02', '"1"'), expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C7-03', family: 'C7', title: '标记已读路径 id 非 uuid', actor: 'a', method: 'PUT', path: `${API}/messages/not-a-uuid/read`, headers: wkey('i22-c7-03', '"1"'), expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C7-04', family: 'C7', title: '举报路径 id 非 uuid', actor: 'a', method: 'GET', path: `${API}/reports/not-a-uuid`, expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C7-05', family: 'C7', title: '游标非法', actor: 'a', method: 'GET', path: `${API}/favorites?cursor=%25%25%25`, expect: { status: 400, code: 'INVALID_CURSOR' } },
  { id: 'C7-06', family: 'C7', title: '分页下界越界', actor: 'a', method: 'GET', path: `${API}/favorites?limit=0`, expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C7-07', family: 'C7', title: '分页上界越界', actor: 'a', method: 'GET', path: `${API}/favorites?limit=51`, expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C7-08', family: 'C7', title: '列表多余查询参数', actor: 'a', method: 'GET', path: `${API}/favorites?unknown=1`, expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C7-09', family: 'C7', title: '帖子列表分页非数字', actor: 'a', method: 'GET', path: `${API}/posts?limit=abc`, expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C7-10', family: 'C7', title: '发帖缺 media_ids', actor: 'a', method: 'POST', path: `${API}/posts`, body: { title: '缺字段', body: '缺字段' }, headers: key('i22-c7-10'), expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C7-11', family: 'C7', title: '发帖 4 个媒体（上限 3）', actor: 'a', method: 'POST', path: `${API}/posts`, body: { title: '超限', body: '超限', media_ids: [ABSENT, ABSENT, ABSENT, ABSENT] }, headers: key('i22-c7-11'), expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C7-12', family: 'C7', title: '举报原因码不在枚举内', actor: 'a', method: 'POST', path: `${API}/reports`, body: (ctx) => ({ target_ref: { type: 'post', id: ctx.seeded.postId, revision: 1 }, reason_code: 'bogus' }), headers: key('i22-c7-12'), expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C7-13', family: 'C7', title: '收藏目标类型不在枚举内', actor: 'a', method: 'POST', path: `${API}/favorites`, body: { target_ref: { type: 'bogus', id: SPECIES_ID, revision: 1 } }, headers: key('i22-c7-13'), expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C7-14', family: 'C7', title: '收藏目标 revision 为 0', actor: 'a', method: 'POST', path: `${API}/favorites`, body: { target_ref: { type: 'species', id: SPECIES_ID, revision: 0 } }, headers: key('i22-c7-14'), expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C7-15', family: 'C7', title: '空评论正文', actor: 'a', method: 'POST', path: (ctx) => `${API}/posts/${ctx.seeded.postId}/comments`, body: { body: '' }, headers: wkey('i22-c7-15', '"1"'), expect: { status: 400, code: 'INVALID_REQUEST' } },
  { id: 'C7-16', family: 'C7', title: '注销申请缺确认词', actor: 'deleter', method: 'POST', path: `${API}/me/account/deletion`, body: {}, headers: key('i22-c7-16'), expect: { status: 400, code: 'INVALID_REQUEST' } },
];
