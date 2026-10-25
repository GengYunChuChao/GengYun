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

/** OCR 标签字段的最小合法形状（四个字段都允许空；用来把「未鉴权」与「body 非法」分开）。 */
const LABEL_FIELDS = { registration_number: null, name: null, ingredients: [], dosage_form: null };
/** 会话轮次请求体（会话域的 body schema 只要求是对象，input_type/text 是产品侧约定）。 */
const TURN_BODY = { input_type: 'text', text: '合成提问（矩阵）：稻田稗草三到五叶期该用什么药？' };
/** 语音合成请求体（内容引用指向不存在的 id 也合法：未鉴权时先撞 401）。 */
const SYNTHESIS_BODY = { checked_content_ref: { type: 'answer', id: ABSENT, revision: 1 }, locale: 'zh-CN' };
/** 转写确认请求体（confirmed_text 1..8000，confirmation 固定枚举）。 */
const CONFIRMATION_BODY = { confirmed_text: '合成确认文本（矩阵），非真实录音内容。', confirmation: 'checked_and_sendable' };

export const BATCHES = [
  { id: 'B1', title: '批次 1：身份与权限面（游客 / 越权 / 后台 / 会话与注销）', families: ['C1', 'C2', 'C3', 'C4'] },
  { id: 'B2', title: '批次 2：媒体归属、重复请求与无效输入', families: ['C5', 'C6', 'C7'] },
  { id: 'B3', title: '批次 3：审核回调 / AI 失败 / 下架缓存（受信 seam）', families: ['D1', 'D2', 'D3'] },
  { id: 'B4', title: '批次 4：版本回写、提示注入与媒体访问凭据', families: ['D4', 'E1', 'E2'] },
  { id: 'B5', title: '批次 5：异步 AI 域（识别 / OCR / 转写 / 合成 / 作业 / 会话）的游客面与归属面', families: ['C10', 'C11'] },
  { id: 'B6', title: '批次 6：下架后引用跳转 unavailable（消息引用帖子/评论，删除目标后同一条消息变 unavailable）', families: ['F1'] },
];

export const FAMILIES = {
  C1: '游客面：没有凭据时一律 401 SESSION_REQUIRED（不是 403/404/500）',
  C2: '越权（IDOR）：A 不得读写 B 的私有行；「不是你的」与「不存在」同形 404',
  C3: '后台：用户会话 → 403 SCOPE_DENIED；后台缺 scope → 403；后台有 scope → 2xx；未接线面 fail-closed 503',
  C4: '会话与注销：注销/过期/旧 epoch/坏凭据的拒绝码；注销回执 bearer 的绑定与换发',
  C5: '媒体归属与媒体访问凭据：跨主体 404、缺 / 错 token、内容-媒体不匹配',
  C6: '重复请求（Idempotency-Key）：同键同体重放同一结果、同键异体 409、缺键 400、并发只产生一行',
  C7: '无效输入：坏 uuid / 坏游标 / 越界分页 / 多余字段一律 400（含 INVALID_CURSOR）',
  E1: '提示注入：内容里的指令只作数据，命中 PROMPT_INJECTION 就拒绝，绝不改写审核结论或角色',
  E2: '媒体访问凭据：篡改/越权的 token 一律 404（与「不存在」同形，不泄露对象存在性）',
  C10: '异步 AI 域游客面：识别 / OCR / 转写 / 合成 / 作业 / 会话共 23 个 operation 在无凭据时一律 401 SESSION_REQUIRED',
  C11: '异步 AI 域归属面：A 碰 B 的作业 / 识别 / OCR / 转写 / 会话（含轮次）一律 404 且与「不存在」同形；越权写不得改动 B 的行',
  F1: '引用跳转：帖子/评论被下架（删除）后，消息里的引用跳转显示 unavailable（同形，不崩溃不泄露存在性）',
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
  // 退出后多面同形 401：C4-03 只钉了 /favorites 一面。这三条把同一张封套钉到个人资料 / 目录 /
  // 资料库三个面上（`sameShapeAs` 与 C4-03 交叉引用：message 归一化，code/retryable/details + meta 逐字节比），
  // 任一面的守卫「顺手放宽成 401 另一套封套」或「漏挂 requireUser 变成 200/其他码」都会独立转红。
  { id: 'C4-19', family: 'C4', title: '注销后旧会话读个人资料（与 C4-03 同形）', actor: 'logout', method: 'GET', path: `${API}/me/profile`, expect: { status: 401, code: 'SESSION_EXPIRED' }, sameShapeAs: 'C4-03', note: '路径依据 services/api/src/routes/profile.ts:25（guards.requireUser）；会话已撤销由 auth/middleware.ts:78-80 判 SESSION_EXPIRED' },
  { id: 'C4-20', family: 'C4', title: '注销后旧会话读目录（与 C4-03 同形）', actor: 'logout', method: 'GET', path: `${API}/catalog/crops`, expect: { status: 401, code: 'SESSION_EXPIRED' }, sameShapeAs: 'C4-03', note: '路径依据 services/api/src/routes/profile.ts:44（GET /catalog/:kind，同一条 requireUser 守卫）' },
  { id: 'C4-21', family: 'C4', title: '注销后旧会话读资料库（与 C4-03 同形）', actor: 'logout', method: 'GET', path: `${API}/knowledge`, expect: { status: 401, code: 'SESSION_EXPIRED' }, sameShapeAs: 'C4-03', note: '路径依据 services/api/src/routes/knowledge.ts:196（preHandler: guards.requireUser）' },

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
  { id: 'C6-11', family: 'C6', title: '已登录取消收藏缺 If-Match：428', actor: 'b', method: 'DELETE', path: (ctx) => `${API}/favorites/${ctx.seeded.favoriteId}`, headers: key('i22-c6-11'), expect: { status: 428, code: 'REVISION_REQUIRED' }, note: '幂等键合法但不带 If-Match ⇒ favorites/service.ts:430 requireIfMatch 先抛 REVISION_REQUIRED（428 早于归属 404 与 revision 409：条件头是写路径的必备前置，不做 last-write-wins）；缺幂等键的 400 由 C6-04 覆盖' },

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

  // ------------------------------------------------- E1 提示注入（内容只是数据）
  { id: 'E1-01', family: 'E1', title: '标题里塞「忽略以上指令」⇒ 硬规则命中 PROMPT_INJECTION 并拒绝（不是照做）', actor: 'a', method: 'POST', path: `${API}/posts`, body: (ctx) => ({ title: ctx.injection.slice(0, 60), body: '稻瘟病在水稻分蘖期怎么防？', media_ids: [] }), headers: key('i22-e1-01'), expect: { status: 400, code: 'INVALID_REQUEST', etag: false }, check: (result) => {
    const details = result.body?.error?.details ?? [];
    const codes = details.map((one) => one.code);
    const problems = [];
    if (!codes.includes('PROMPT_INJECTION')) problems.push(`details 里应有 PROMPT_INJECTION，实际 ${JSON.stringify(codes)}`);
    if (!codes.includes('NOT_PUBLISHABLE')) problems.push(`details 里应有 NOT_PUBLISHABLE，实际 ${JSON.stringify(codes)}`);
    return problems;
  } },
  { id: 'E1-02', family: 'E1', title: '评论里塞「忽略以上指令」⇒ 同样按规则拒绝（评论不是旁路）', actor: 'a', method: 'POST', path: (ctx) => `${API}/posts/${ctx.seeded.postId}/comments`, body: (ctx) => ({ body: ctx.injection }), headers: wkey('i22-e1-02', '"1"'), expect: { status: 400, code: 'INVALID_REQUEST', etag: false }, check: (result) => {
    const codes = (result.body?.error?.details ?? []).map((one) => one.code);
    return codes.includes('PROMPT_INJECTION') ? [] : [`details 里应有 PROMPT_INJECTION，实际 ${JSON.stringify(codes)}`];
  } },
  { id: 'E1-03', family: 'E1', title: '干净对照：同样形状的标题/正文能发出去（拒绝必须是内容驱动）', actor: 'a', method: 'POST', path: `${API}/posts`, body: { title: '稻瘟病在水稻分蘖期怎么防？', body: '分蘖期见病斑，问用药时机。', media_ids: [] }, headers: key('i22-e1-03'), expect: { status: 201, etag: true } },

  // ------------------------------------------------- E2 媒体访问凭据（签名/归属）
  { id: 'E2-01', family: 'E2', title: '拿篡改过的访问凭据读 B 自己的媒体内容 ⇒ 404（不泄露对象存在性）', actor: 'b', method: 'GET', path: (ctx) => `${API}/community/media/${ctx.seeded.media.mediaId}/content`, headers: { 'x-media-access-token': 'tampered-token' }, expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'E2-02' },
  { id: 'E2-02', family: 'E2', title: '同一凭据去读一个不存在的媒体 id ⇒ 404，与上一条完全同形', actor: 'b', method: 'GET', path: `${API}/community/media/${ABSENT}/content`, headers: { 'x-media-access-token': 'tampered-token' }, expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'E2-03', family: 'E2', title: '属主申请自己媒体的访问凭据 ⇒ 200，且 url 落在替身域、expires_at 在未来（凭据只发给属主）', actor: 'b', method: 'POST', path: (ctx) => `${API}/media/${ctx.seeded.media.mediaId}/access`, body: {}, headers: (ctx) => wkey('i22-e2-03', `"${ctx.seeded.media.revision}"`), expect: { status: 200, etag: true }, check: (result, ctx) => {
    const data = result.body?.data ?? {};
    const problems = [];
    if (typeof data.access_token !== 'string' || data.access_token === '') problems.push('data.access_token 缺失');
    if (typeof data.url !== 'string' || !data.url.includes('media.placeholder.invalid')) problems.push(`data.url 未落在替身域：${data.url}`);
    const expires = Date.parse(String(data.expires_at));
    if (!Number.isFinite(expires)) problems.push(`data.expires_at 不是时间：${data.expires_at}`);
    else if (expires <= ctx.world.clock.ms) problems.push(`data.expires_at 必须在未来：${data.expires_at}`);
    return problems;
  } },

  // ------------------------------ C10 异步 AI 域：游客面（无凭据一律 401，不是 403/404/500）
  // 期望值来源（逐条照抄既有实现行为，未自行发明状态码）：
  // - tests/integration/ocr-http.mjs:1500-1501（无会话 GET /ocr/:id ⇒ 401 SESSION_REQUIRED）
  // - tests/integration/speech-http.mjs:263-264（转写四条无会话 ⇒ 401 SESSION_REQUIRED）
  // - tests/unit/recognitions-api.test.mjs:114-116（未登录 POST /recognitions、GET /recognitions/:id、GET /jobs/:id ⇒ 401）
  // - tests/unit/tts-jobs-http.test.mjs:225-226（无会话 GET /jobs/:id ⇒ 401 SESSION_REQUIRED）
  // - tests/unit/conversation-http.test.mjs:236（无 token GET /conversations ⇒ SESSION_REQUIRED）
  // body 必须 schema 合法：fastify 的 schema 校验先于 preHandler，非法 body 会先给 400 而不是 401。
  { id: 'C10-01', family: 'C10', title: '游客创建识别作业', method: 'POST', path: `${API}/recognitions`, body: { media_id: ABSENT, media_revision: 1 }, headers: key('i22-c10-01-rec'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-02', family: 'C10', title: '游客读识别记录', method: 'GET', path: `${API}/recognitions/${ABSENT}`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-03', family: 'C10', title: '游客改识别选择', method: 'PATCH', path: `${API}/recognitions/${ABSENT}/selection`, body: { selected_species_id: SPECIES_ID }, headers: wkey('i22-c10-03-sel', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-04', family: 'C10', title: '游客删识别记录', method: 'DELETE', path: `${API}/recognitions/${ABSENT}`, headers: wkey('i22-c10-04-recd', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-05', family: 'C10', title: '游客创建 OCR 作业', method: 'POST', path: `${API}/ocr`, body: { media_id: ABSENT, media_revision: 1 }, headers: key('i22-c10-05-ocr'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-06', family: 'C10', title: '游客读 OCR 记录', method: 'GET', path: `${API}/ocr/${ABSENT}`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-07', family: 'C10', title: '游客改 OCR 校正字段', method: 'PATCH', path: `${API}/ocr/${ABSENT}/correction`, body: { corrected_fields: LABEL_FIELDS }, headers: wkey('i22-c10-07-ocrc', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-08', family: 'C10', title: '游客确认 OCR 结果', method: 'POST', path: `${API}/ocr/${ABSENT}/verify`, body: { fields: LABEL_FIELDS }, headers: wkey('i22-c10-08-ocrv', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-09', family: 'C10', title: '游客删 OCR 记录', method: 'DELETE', path: `${API}/ocr/${ABSENT}`, headers: wkey('i22-c10-09-ocrd', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-10', family: 'C10', title: '游客创建转写作业', method: 'POST', path: `${API}/speech/transcriptions`, body: { media_id: ABSENT, media_revision: 1 }, headers: key('i22-c10-10-sp'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-11', family: 'C10', title: '游客读转写记录', method: 'GET', path: `${API}/speech/transcriptions/${ABSENT}`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-12', family: 'C10', title: '游客确认转写文本', method: 'PATCH', path: `${API}/speech/transcriptions/${ABSENT}/confirmation`, body: CONFIRMATION_BODY, headers: wkey('i22-c10-12-spc', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-13', family: 'C10', title: '游客删转写记录', method: 'DELETE', path: `${API}/speech/transcriptions/${ABSENT}`, headers: wkey('i22-c10-13-spd', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-14', family: 'C10', title: '游客请求语音合成', method: 'POST', path: `${API}/speech/synthesis`, body: SYNTHESIS_BODY, headers: key('i22-c10-14-syn'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-15', family: 'C10', title: '游客读作业', method: 'GET', path: `${API}/jobs/${ABSENT}`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-16', family: 'C10', title: '游客取消作业', method: 'POST', path: `${API}/jobs/${ABSENT}/cancel`, headers: wkey('i22-c10-16-jobc', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-17', family: 'C10', title: '游客读会话列表', method: 'GET', path: `${API}/conversations`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-18', family: 'C10', title: '游客建会话', method: 'POST', path: `${API}/conversations`, body: {}, headers: key('i22-c10-18-conv'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-19', family: 'C10', title: '游客读会话', method: 'GET', path: `${API}/conversations/${ABSENT}`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-20', family: 'C10', title: '游客删会话', method: 'DELETE', path: `${API}/conversations/${ABSENT}`, headers: wkey('i22-c10-20-cnvd', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-21', family: 'C10', title: '游客给会话加一轮', method: 'POST', path: `${API}/conversations/${ABSENT}/turns`, body: TURN_BODY, headers: wkey('i22-c10-21-turn', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-22', family: 'C10', title: '游客读会话轮次', method: 'GET', path: `${API}/conversations/${ABSENT}/turns`, expect: { status: 401, code: 'SESSION_REQUIRED' } },
  { id: 'C10-23', family: 'C10', title: '游客删会话轮次', method: 'DELETE', path: `${API}/conversations/${ABSENT}/turns/${ABSENT}`, headers: wkey('i22-c10-23-turn', '"1"'), expect: { status: 401, code: 'SESSION_REQUIRED' } },

  // ---------------------------- C11 异步 AI 域：归属面（他人资源 404，且与「不存在」逐字段同形）
  // 期望值来源：
  // - tests/unit/gy-i22-job-inflight-guard-and-ownership.test.mjs:249-287（A 读 / 取消 B 的作业、读 / 改 B 的识别记录 ⇒ 404）
  // - tests/integration/ocr-http.mjs:1329-1358、:2025-2037（他人 OCR 记录 / 作业 ⇒ 404，与不存在同形）
  // - tests/integration/speech-http.mjs:225-249（他人转写 GET / DELETE / 确认 ⇒ 404 同形）
  // - tests/unit/conversation-http.test.mjs:272-294（他人会话 / 轮次 ⇒ 404，绝不 403 泄露存在性）
  // 每条 foreign 用例都有一条 `sameShapeAs` 的「不存在」对照，且**对照真跑**（不是 note）：
  // 只有对照同时跑过，404 才能被证明为「同形」，而不是「碰巧都是 404 文案不同」。
  { id: 'C11-01', family: 'C11', title: 'A 读 B 的作业', actor: 'a', method: 'GET', path: (ctx) => `${API}/jobs/${ctx.seeded.jobId}`, expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-02' },
  { id: 'C11-02', family: 'C11', title: 'A 读不存在的作业（对照：同形基准）', actor: 'a', method: 'GET', path: `${API}/jobs/${ABSENT}`, expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-03', family: 'C11', title: 'A 取消 B 的作业', actor: 'a', method: 'POST', path: (ctx) => `${API}/jobs/${ctx.seeded.jobId}/cancel`, headers: wkey('i22-c11-03-jobc', '"2"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-04', note: '归属判定先于版本判定：If-Match 用的是属主侧 revision，越权者拿不到 409/428 这类版本提示' },
  { id: 'C11-04', family: 'C11', title: 'A 取消不存在的作业（对照）', actor: 'a', method: 'POST', path: `${API}/jobs/${ABSENT}/cancel`, headers: wkey('i22-c11-04-jobc', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-05', family: 'C11', title: 'A 读 B 的识别记录', actor: 'a', method: 'GET', path: (ctx) => `${API}/recognitions/${ctx.seeded.recognitionId}`, expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-06' },
  { id: 'C11-06', family: 'C11', title: 'A 读不存在的识别记录（对照）', actor: 'a', method: 'GET', path: `${API}/recognitions/${ABSENT}`, expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-07', family: 'C11', title: 'A 改 B 的识别选择', actor: 'a', method: 'PATCH', path: (ctx) => `${API}/recognitions/${ctx.seeded.recognitionId}/selection`, body: { selected_species_id: SPECIES_ID }, headers: wkey('i22-c11-07-sel', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-08' },
  { id: 'C11-08', family: 'C11', title: 'A 改不存在识别记录的选择（对照）', actor: 'a', method: 'PATCH', path: `${API}/recognitions/${ABSENT}/selection`, body: { selected_species_id: SPECIES_ID }, headers: wkey('i22-c11-08-sel', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-09', family: 'C11', title: 'A 删 B 的识别记录', actor: 'a', method: 'DELETE', path: (ctx) => `${API}/recognitions/${ctx.seeded.recognitionId}`, headers: wkey('i22-c11-09-recd', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-10' },
  { id: 'C11-10', family: 'C11', title: 'A 删不存在的识别记录（对照）', actor: 'a', method: 'DELETE', path: `${API}/recognitions/${ABSENT}`, headers: wkey('i22-c11-10-recd', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-11', family: 'C11', title: 'A 读 B 的 OCR 记录', actor: 'a', method: 'GET', path: (ctx) => `${API}/ocr/${ctx.seeded.ocrId}`, expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-12' },
  { id: 'C11-12', family: 'C11', title: 'A 读不存在的 OCR 记录（对照）', actor: 'a', method: 'GET', path: `${API}/ocr/${ABSENT}`, expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-13', family: 'C11', title: 'A 改 B 的 OCR 校正字段', actor: 'a', method: 'PATCH', path: (ctx) => `${API}/ocr/${ctx.seeded.ocrId}/correction`, body: { corrected_fields: LABEL_FIELDS }, headers: wkey('i22-c11-13-ocrc', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-14' },
  { id: 'C11-14', family: 'C11', title: 'A 改不存在 OCR 记录的校正字段（对照）', actor: 'a', method: 'PATCH', path: `${API}/ocr/${ABSENT}/correction`, body: { corrected_fields: LABEL_FIELDS }, headers: wkey('i22-c11-14-ocrc', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-15', family: 'C11', title: 'A 确认 B 的 OCR 结果', actor: 'a', method: 'POST', path: (ctx) => `${API}/ocr/${ctx.seeded.ocrId}/verify`, body: { fields: LABEL_FIELDS }, headers: wkey('i22-c11-15-ocrv', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-16' },
  { id: 'C11-16', family: 'C11', title: 'A 确认不存在 OCR 记录的结果（对照）', actor: 'a', method: 'POST', path: `${API}/ocr/${ABSENT}/verify`, body: { fields: LABEL_FIELDS }, headers: wkey('i22-c11-16-ocrv', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-17', family: 'C11', title: 'A 删 B 的 OCR 记录', actor: 'a', method: 'DELETE', path: (ctx) => `${API}/ocr/${ctx.seeded.ocrId}`, headers: wkey('i22-c11-17-ocrd', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-18' },
  { id: 'C11-18', family: 'C11', title: 'A 删不存在的 OCR 记录（对照）', actor: 'a', method: 'DELETE', path: `${API}/ocr/${ABSENT}`, headers: wkey('i22-c11-18-ocrd', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-19', family: 'C11', title: 'A 读 B 的转写记录', actor: 'a', method: 'GET', path: (ctx) => `${API}/speech/transcriptions/${ctx.seeded.transcriptionId}`, expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-20' },
  { id: 'C11-20', family: 'C11', title: 'A 读不存在的转写记录（对照）', actor: 'a', method: 'GET', path: `${API}/speech/transcriptions/${ABSENT}`, expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-21', family: 'C11', title: 'A 确认 B 的转写文本', actor: 'a', method: 'PATCH', path: (ctx) => `${API}/speech/transcriptions/${ctx.seeded.transcriptionId}/confirmation`, body: CONFIRMATION_BODY, headers: wkey('i22-c11-21-spc', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-22' },
  { id: 'C11-22', family: 'C11', title: 'A 确认不存在转写记录的文本（对照）', actor: 'a', method: 'PATCH', path: `${API}/speech/transcriptions/${ABSENT}/confirmation`, body: CONFIRMATION_BODY, headers: wkey('i22-c11-22-spc', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-23', family: 'C11', title: 'A 删 B 的转写记录', actor: 'a', method: 'DELETE', path: (ctx) => `${API}/speech/transcriptions/${ctx.seeded.transcriptionId}`, headers: wkey('i22-c11-23-spd', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-24' },
  { id: 'C11-24', family: 'C11', title: 'A 删不存在的转写记录（对照）', actor: 'a', method: 'DELETE', path: `${API}/speech/transcriptions/${ABSENT}`, headers: wkey('i22-c11-24-spd', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-25', family: 'C11', title: 'A 读 B 的会话', actor: 'a', method: 'GET', path: (ctx) => `${API}/conversations/${ctx.seeded.conversationId}`, expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-26' },
  { id: 'C11-26', family: 'C11', title: 'A 读不存在的会话（对照）', actor: 'a', method: 'GET', path: `${API}/conversations/${ABSENT}`, expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-27', family: 'C11', title: 'A 读 B 的会话轮次', actor: 'a', method: 'GET', path: (ctx) => `${API}/conversations/${ctx.seeded.conversationId}/turns`, expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-28' },
  { id: 'C11-28', family: 'C11', title: 'A 读不存在会话的轮次（对照）', actor: 'a', method: 'GET', path: `${API}/conversations/${ABSENT}/turns`, expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-29', family: 'C11', title: 'A 往 B 的会话里加一轮', actor: 'a', method: 'POST', path: (ctx) => `${API}/conversations/${ctx.seeded.conversationId}/turns`, body: TURN_BODY, headers: wkey('i22-c11-29-turn', '"1"'), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-30' },
  { id: 'C11-30', family: 'C11', title: 'A 往不存在的会话里加一轮（对照）', actor: 'a', method: 'POST', path: `${API}/conversations/${ABSENT}/turns`, body: TURN_BODY, headers: wkey('i22-c11-30-turn', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-31', family: 'C11', title: 'A 删 B 的会话', actor: 'a', method: 'DELETE', path: (ctx) => `${API}/conversations/${ctx.seeded.conversationId}`, headers: (ctx) => wkey('i22-c11-31-cnvd', ctx.seeded.conversationEtag), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-32' },
  { id: 'C11-32', family: 'C11', title: 'A 删不存在的会话（对照）', actor: 'a', method: 'DELETE', path: `${API}/conversations/${ABSENT}`, headers: wkey('i22-c11-32-cnvd', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },
  { id: 'C11-33', family: 'C11', title: 'A 删 B 的会话轮次', actor: 'a', method: 'DELETE', path: (ctx) => `${API}/conversations/${ctx.seeded.conversationId}/turns/${ctx.seeded.turnId}`, headers: (ctx) => wkey('i22-c11-33-trn', ctx.seeded.conversationEtag), expect: { status: 404, code: 'NOT_FOUND' }, sameShapeAs: 'C11-34' },
  { id: 'C11-34', family: 'C11', title: 'A 删不存在会话的轮次（对照）', actor: 'a', method: 'DELETE', path: `${API}/conversations/${ABSENT}/turns/${ABSENT}`, headers: wkey('i22-c11-34-trn', '"1"'), expect: { status: 404, code: 'NOT_FOUND' } },

  // 正控制（必须排在所有越权写之后）：证明上面那些 404 打的确实是**存在**的行，
  // 并且越权写没有把属主的行改掉 / 删掉——否则「404」可能只是「本来就没有」。
  { id: 'C11-35', family: 'C11', title: '正控制：B 仍能读自己的作业（A 的 404 不是把行删了）', actor: 'b', method: 'GET', path: (ctx) => `${API}/jobs/${ctx.seeded.jobId}`, expect: { status: 200 }, check: (result, ctx) => (result.body?.data?.id === ctx.seeded.jobId ? [] : [`data.id 期望 ${ctx.seeded.jobId} 实际 ${JSON.stringify(result.body?.data?.id)}`]) },
  { id: 'C11-36', family: 'C11', title: '正控制：B 仍能读自己的识别记录', actor: 'b', method: 'GET', path: (ctx) => `${API}/recognitions/${ctx.seeded.recognitionId}`, expect: { status: 200 }, check: (result, ctx) => (result.body?.data?.id === ctx.seeded.recognitionId ? [] : [`data.id 期望 ${ctx.seeded.recognitionId} 实际 ${JSON.stringify(result.body?.data?.id)}`]) },
  { id: 'C11-37', family: 'C11', title: '正控制：B 仍能读自己的 OCR 记录', actor: 'b', method: 'GET', path: (ctx) => `${API}/ocr/${ctx.seeded.ocrId}`, expect: { status: 200 }, check: (result, ctx) => (result.body?.data?.id === ctx.seeded.ocrId ? [] : [`data.id 期望 ${ctx.seeded.ocrId} 实际 ${JSON.stringify(result.body?.data?.id)}`]) },
  { id: 'C11-38', family: 'C11', title: '正控制：B 仍能读自己的转写记录', actor: 'b', method: 'GET', path: (ctx) => `${API}/speech/transcriptions/${ctx.seeded.transcriptionId}`, expect: { status: 200 }, check: (result, ctx) => (result.body?.data?.id === ctx.seeded.transcriptionId ? [] : [`data.id 期望 ${ctx.seeded.transcriptionId} 实际 ${JSON.stringify(result.body?.data?.id)}`]) },
  { id: 'C11-39', family: 'C11', title: '正控制：B 仍能读自己的会话', actor: 'b', method: 'GET', path: (ctx) => `${API}/conversations/${ctx.seeded.conversationId}`, expect: { status: 200 }, check: (result, ctx) => (result.body?.data?.id === ctx.seeded.conversationId ? [] : [`data.id 期望 ${ctx.seeded.conversationId} 实际 ${JSON.stringify(result.body?.data?.id)}`]) },

  // ----------------------------- F1 引用跳转（下架/删除后消息引用 → unavailable）
  // 期望值来源（stub 实跑读数）：消息域 `reference_state` 由 `createCommunityReferencePort` 在**每次
  // 读取时**逐次重查社区公开读面（`visibility.isPubliclyVisible`）。帖子/评论被作者删除后公开读面判
  // 不可读 ⇒ 同一条消息、同一个 id 的 `reference_state` 从 available 迁到 unavailable，且消息行不消失、
  // 字段集合不变（消息契约无 `unavailable_reason`，与「不存在」同形，不泄露目标状态）。
  // 消息的 `Message` 投影键集固定为 7 项（`additionalProperties:false`），见 messages/types.ts。
  { id: 'F1-01', family: 'F1', title: '正控制：消息引用公开帖子 ⇒ reference_state=available', actor: 'b', method: 'GET', path: `${API}/messages`, expect: { status: 200 }, check: (result, ctx) => {
    const row = (result.body?.data?.items ?? []).find((item) => item.id === ctx.refJump.postMessageId);
    if (row === undefined) return [`缺少指向帖子的消息行 ${ctx.refJump.postMessageId}`];
    return row.reference_state === 'available' ? [] : [`公开帖子的引用应为 available，实际 ${row.reference_state}`];
  } },
  { id: 'F1-02', family: 'F1', title: '正控制：消息引用公开评论 ⇒ reference_state=available', actor: 'b', method: 'GET', path: `${API}/messages`, expect: { status: 200 }, check: (result, ctx) => {
    const row = (result.body?.data?.items ?? []).find((item) => item.id === ctx.refJump.commentMessageId);
    if (row === undefined) return [`缺少指向评论的消息行 ${ctx.refJump.commentMessageId}`];
    return row.reference_state === 'available' ? [] : [`公开评论的引用应为 available，实际 ${row.reference_state}`];
  } },
  { id: 'F1-03', family: 'F1', title: '作者删除评论（下架引用目标）', actor: 'b', method: 'DELETE', path: (ctx) => `${API}/comments/${ctx.refJump.commentId}`, headers: (ctx) => wkey('i22-f1-03', ctx.refJump.commentEtag), expect: { status: 200 }, check: (result) => (result.body?.data?.accepted === true ? [] : [`data.accepted 期望 true 实际 ${JSON.stringify(result.body?.data?.accepted)}`]) },
  { id: 'F1-04', family: 'F1', title: '下架后消息引用评论 ⇒ reference_state=unavailable，且消息行不消失、字段集合同形', actor: 'b', method: 'GET', path: `${API}/messages`, expect: { status: 200 }, check: (result, ctx) => {
    const row = (result.body?.data?.items ?? []).find((item) => item.id === ctx.refJump.commentMessageId);
    const problems = [];
    if (row === undefined) problems.push('评论删除后消息行本身不得消失（历史仍在，只是点不动）');
    else {
      if (row.reference_state !== 'unavailable') problems.push(`下架后引用应为 unavailable，实际 ${row.reference_state}`);
      if (Object.keys(row).sort().join(',') !== 'created_at,id,read_at,reference_state,revision,target_ref,type') {
        problems.push(`消息投影字段集合不符（不得多出 unavailable_reason 等字段）：${Object.keys(row).sort().join(',')}`);
      }
      if (row.revision !== 1) problems.push(`reference_state 变化不得推进消息自身 revision，实际 ${row.revision}`);
    }
    if (/unavailable_reason|deleted_at|not_found/i.test(JSON.stringify(result.body))) problems.push('响应体里出现了可区分目标状态的字样（存在性泄露）');
    return problems;
  } },
  { id: 'F1-05', family: 'F1', title: '作者删除帖子（下架引用目标）', actor: 'b', method: 'DELETE', path: (ctx) => `${API}/posts/${ctx.refJump.postId}`, headers: (ctx) => wkey('i22-f1-05', ctx.refJump.postEtag), expect: { status: 200 }, check: (result) => (result.body?.data?.accepted === true ? [] : [`data.accepted 期望 true 实际 ${JSON.stringify(result.body?.data?.accepted)}`]) },
  { id: 'F1-06', family: 'F1', title: '下架后消息引用帖子 ⇒ reference_state=unavailable，且消息行不消失、字段集合同形', actor: 'b', method: 'GET', path: `${API}/messages`, expect: { status: 200 }, check: (result, ctx) => {
    const row = (result.body?.data?.items ?? []).find((item) => item.id === ctx.refJump.postMessageId);
    const problems = [];
    if (row === undefined) problems.push('帖子删除后消息行本身不得消失（历史仍在，只是点不动）');
    else {
      if (row.reference_state !== 'unavailable') problems.push(`下架后引用应为 unavailable，实际 ${row.reference_state}`);
      if (Object.keys(row).sort().join(',') !== 'created_at,id,read_at,reference_state,revision,target_ref,type') {
        problems.push(`消息投影字段集合不符（不得多出 unavailable_reason 等字段）：${Object.keys(row).sort().join(',')}`);
      }
      if (row.revision !== 1) problems.push(`reference_state 变化不得推进消息自身 revision，实际 ${row.revision}`);
    }
    if (/unavailable_reason|deleted_at|not_found/i.test(JSON.stringify(result.body))) problems.push('响应体里出现了可区分目标状态的字样（存在性泄露）');
    return problems;
  } },
];
