/**
 * GY-I22（#22）· 「他人资源」与「不存在资源」的**响应文案逐字同形**静态守卫。
 *
 * ## 这条守卫补的空白：矩阵抓不到的那一层
 * `tests/failmatrix/cases.mjs` 的 `sameShapeAs` 走 `tests/failmatrix/world.mjs` 的
 * `envelopeShape()`（`tests/failmatrix/world.mjs:142-152`），它**故意**把 `error.message`
 * 归一成 `'<message>'`，只比
 * `status` / `error{code,retryable,details}` / `meta.contract_version` / `meta.execution_mode`。
 *
 * 也就是说：矩阵全绿**不能**证明「他人资源」与「不存在资源」的**文案**相同 ——
 * 两者文案差一个字（甚至差一个全角空格），矩阵照样全绿；而这一字之差正是可以被用来
 * **枚举资源是否存在**的可见面（404 文案成了存在性预言机）。
 * 本文件把这一层单独钉住：同一对请求，`status` / `error.code` / `error.message` 三者逐字相同，
 * 且去掉 `meta.request_id` 之后**整个封套逐字节相同**。
 *
 * ## 为什么是独立文件（本片选 (b)），而不是给矩阵加一族 C12（选项 (a)）
 * 1. **判据冲突**：矩阵的 `envelopeShape` 就是靠"忽略 message"来比同形的；在矩阵里再挂一个
 *    "必须比 message"的开关，等于让「矩阵全绿」同时表示两种口径 —— 读的人再也分不清
 *    哪条绿是"形状同"、哪条绿是"文案也同"。分开写，绿的含义才是单义的。
 * 2. **条数是三处对账的硬数字**：`MIN_CASES` / `FAMILY_COUNTS` / `BATCH_COUNTS` 还要和
 *    `tests/failmatrix/README.md`、`tools/i22-failmatrix-evidence-table.mjs` 的文档声明对账
 *    （`tests/failmatrix/README.md:158-159`）。为一个更严的断言去动这些数字，把"只准加不准减"
 *    的门禁与维护成本一起拖进来，收益却只是省一个文件。
 * 3. **零冲突**：本文件**只读复用** `tests/failmatrix/world.mjs` 的替身世界（`createWorld` /
 *    `createAccount` / `seedOwnerRows` / `inject`），**不改**任何既有文件。矩阵的 168 条
 *    （`MIN_CASES`，origin/main 基线）、断言与 `MIN_CASES` 一个都不动。
 *
 * ## 判据（每一对「A 碰 B 的私有行」vs「A 碰契约格式但不存在 uuid」）
 *   - `status` 相等，且两侧都必须是 `404`；
 *   - `error.code` 逐字相等，且必须是 `NOT_FOUND`；
 *   - `error.message` **逐字相等**，且必须等于下表钉住的字面量
 *     —— 只比"两侧相等"不够：源码里把两侧一起改掉也会绿，钉住字面量才能抓住这种漂移；
 *   - 去掉 `meta.request_id` 后整个封套**逐字节相同**（`retryable` / `details` /
 *     `contract_version` / `execution_mode` 任一处不同都会红）；
 *   - `details` 必须是空数组（404 不许夹带任何"我查到过什么"的痕迹）；
 *   - 文案里**不得**出现被请求的资源 id（不许拿 id 拼文案）。
 *
 * ## 本片实测（`node --test` 的读数，逐字照抄；2026-10-22，基线 origin/main d4d4808）
 * | 族 | 操作数 | 他人文案 = 不存在文案 | 逐字相同 |
 * | --- | --- | --- | --- |
 * | 作业 jobs | 2（读 / 取消） | 作业不存在 | 是 |
 * | 识别 recognitions | 3（读 / 改选 / 删） | 识别记录不存在 | 是 |
 * | OCR | 4（读 / 校正 / 确认 / 删） | OCR 记录不存在 | 是 |
 * | 转写 transcriptions | 3（读 / 确认 / 删） | 转写记录不存在 | 是 |
 * | 会话 conversations | 5（读 / 轮次读 / 轮次写 / 删 / 轮次删） | 资源不存在 | 是 |
 * | 收藏 favorites | 1（删） | 收藏不存在或不可用 | 是 |
 * | 历史 history | 1（删） | 历史记录不存在或不可用 | 是 |
 * | 消息 messages | 1（已读） | 消息不存在或不可用 | 是 |
 * | 社区 posts / comments / reports | 5（改帖 / 删帖 / 改评 / 删评 / 读举报） | 内容不存在或不可用 | 是 |
 * | 媒体 media | 2（读 / 删） | 媒体不存在 | 是 |
 *
 * ## 已知但**不**纳入本守卫的面（不是漏洞；写清原因，避免"漏了还以为覆盖了"）
 * - **社区公开读**（`GET /posts/:id`、`GET /posts/:id/comments`、`GET /comments/:id`）：
 *   别人**已发布**的帖子与评论本来就该 200 —— 「他人资源」这一侧压根没有 404 可同形。
 *   本片实测确认（foreign 侧 200/200/200、absent 侧 404 `内容不存在或不可用`），
 *   因此这三个面**不属于**"404 同形"的适用范围，排除不是放宽。
 * - **`GET /favorites/:id` 之类的"未实现路径"**：命中 `services/api/src/app.ts:1822` 的
 *   `未实现的路径：<METHOD> <path>` 404，文案回显请求路径（含 id）。它对所有 id 一视同仁，
 *   不泄露资源是否存在，所以不能当同形证据；本文件不覆盖，登记在此。
 * - **后台面 `/admin/**`**：先撞 scope 闸（403 `SCOPE_DENIED`），归属面不在本守卫的表达范围。
 * - **`If-Match` 缺失时的 428**：会话轮次删除在缺 `If-Match` 时两侧都回 428
 *   `REVISION_REQUIRED`（同形，但那是"没给版本"而不是"资源不存在"），因此本文件对该操作
 *   显式带上 `If-Match` 把请求推到真正的 404 归属分支再比。
 *
 * 声明：账号 / 媒体 / 资源 id 全是**合成夹具**，进程内 `app.inject`（`execution_mode=stub`），
 * 零真实外呼、零端口、零数据库。本文件不改任何实现文件、不改任何既有断言。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ABSENT,
  API,
  SPECIES_ID,
  createAccount,
  createWorld,
  inject,
  seedOwnerRows,
} from '../failmatrix/world.mjs';

/**
 * 转写种子专用媒体引用（固定 uuid）。
 *
 * 替身 ASR 按 `bucketOf(mediaId, 6)`（`services/api/src/speech/provider.ts:67`：
 * sha256(mediaId) 首字节 % 6）选脚本，只有 bucket 0/1 才会产出可用文本、才落转写记录；
 * `uploadReadyMedia` 得到的 mediaId 是随机 uuid，桶位不可控。这个 uuid 的桶位实测 = 0。
 * 替身媒体端口不校验归属（`services/api/src/speech/media.ts:42`，仅 stub/preset_demo 接线），
 * 所以播种只需要一个合法 uuid。
 */
const SPEECH_MEDIA_ID = '00000000-0000-4000-8a00-000000000001';

/** OCR 标签字段的最小合法形状（四字段都允许空）。 */
const LABEL_FIELDS = { registration_number: null, name: null, ingredients: [], dosage_form: null };
/** 转写确认体（`confirmed_text` 1..8000；`confirmation` 固定枚举）。 */
const CONFIRMATION_BODY = { confirmed_text: '合成确认文本（文案同形守卫），非真实录音内容。', confirmation: 'checked_and_sendable' };
/** 会话轮次体。 */
const TURN_BODY = { input_type: 'text', text: '合成提问（文案同形守卫）：稻田稗草三到五叶期该用什么药？' };
/** 帖子编辑体（`title` / `body` 走社区同样的合规校验，避免先撞 400 而不是 404）。 */
const POST_BODY = { title: '合成标题（文案同形守卫）', body: '合成正文（文案同形守卫），不含真实资料。', media_ids: [] };
/** 评论编辑体。 */
const COMMENT_BODY = { body: '合成评论正文（文案同形守卫）。' };

/**
 * 请求表：每一行 = 一种「按 id 取/改/删私有资源」的操作。
 *
 * - `target(seeded)` 给出**属主 B 真实存在的**那个 id；不存在的一侧固定用 `ABSENT`
 *   （`00000000-0000-4000-8000-000000000000`，契约格式合法但永不存在的 uuid）。
 * - `message` 是**钉住的字面量**：两侧相等还不够，必须等它 —— 否则源码把两侧一起改掉也会绿。
 * - `destructive: true` 的操作排在最后跑：万一同形断言被写坏、请求真的删到了 B 的行，
 *   后面的正控制会跟着红，而不是被"先删掉再看"掩盖。
 * - `ifMatch`：B 的种子行都是新建的 revision 1，两侧带**同一个** `If-Match`，
 *   保证比到的是"归属"分支（428 / 409 是版本面，不是同形面）。会话族写成
 *   `(seeded) => seeded.conversationEtag`：播种那一轮会把属主的 ETag 推进，
 *   硬编码 `"1"` 会把实现细节钉进守卫里。
 */
const PARITY_PAIRS = [
  // ---------------------------------------------------------------- 作业（jobs）
  {
    id: 'jobs.get',
    family: 'jobs',
    title: '读作业',
    method: 'GET',
    path: (id) => `${API}/jobs/${id}`,
    target: (seeded) => seeded.jobId,
    message: '作业不存在',
  },
  {
    id: 'jobs.cancel',
    family: 'jobs',
    title: '取消作业',
    method: 'POST',
    path: (id) => `${API}/jobs/${id}/cancel`,
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.jobId,
    message: '作业不存在',
  },

  // ---------------------------------------------------------- 识别（recognitions）
  {
    id: 'recognitions.get',
    family: 'recognitions',
    title: '读识别记录',
    method: 'GET',
    path: (id) => `${API}/recognitions/${id}`,
    target: (seeded) => seeded.recognitionId,
    message: '识别记录不存在',
  },
  {
    id: 'recognitions.select',
    family: 'recognitions',
    title: '改识别选择',
    method: 'PATCH',
    path: (id) => `${API}/recognitions/${id}/selection`,
    body: { selected_species_id: SPECIES_ID },
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.recognitionId,
    message: '识别记录不存在',
  },
  {
    id: 'recognitions.delete',
    family: 'recognitions',
    title: '删识别记录',
    method: 'DELETE',
    path: (id) => `${API}/recognitions/${id}`,
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.recognitionId,
    message: '识别记录不存在',
    destructive: true,
  },

  // -------------------------------------------------------------------- OCR
  {
    id: 'ocr.get',
    family: 'ocr',
    title: '读 OCR 记录',
    method: 'GET',
    path: (id) => `${API}/ocr/${id}`,
    target: (seeded) => seeded.ocrId,
    message: 'OCR 记录不存在',
  },
  {
    id: 'ocr.correct',
    family: 'ocr',
    title: '改 OCR 校正字段',
    method: 'PATCH',
    path: (id) => `${API}/ocr/${id}/correction`,
    body: { corrected_fields: LABEL_FIELDS },
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.ocrId,
    message: 'OCR 记录不存在',
  },
  {
    id: 'ocr.verify',
    family: 'ocr',
    title: '确认 OCR 结果',
    method: 'POST',
    path: (id) => `${API}/ocr/${id}/verify`,
    body: { fields: LABEL_FIELDS },
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.ocrId,
    message: 'OCR 记录不存在',
  },
  {
    id: 'ocr.delete',
    family: 'ocr',
    title: '删 OCR 记录',
    method: 'DELETE',
    path: (id) => `${API}/ocr/${id}`,
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.ocrId,
    message: 'OCR 记录不存在',
    destructive: true,
  },

  // ------------------------------------------------------ 转写（transcriptions）
  {
    id: 'transcriptions.get',
    family: 'transcriptions',
    title: '读转写记录',
    method: 'GET',
    path: (id) => `${API}/speech/transcriptions/${id}`,
    target: (seeded) => seeded.transcriptionId,
    message: '转写记录不存在',
  },
  {
    id: 'transcriptions.confirm',
    family: 'transcriptions',
    title: '确认转写文本',
    method: 'PATCH',
    path: (id) => `${API}/speech/transcriptions/${id}/confirmation`,
    body: CONFIRMATION_BODY,
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.transcriptionId,
    message: '转写记录不存在',
  },
  {
    id: 'transcriptions.delete',
    family: 'transcriptions',
    title: '删转写记录',
    method: 'DELETE',
    path: (id) => `${API}/speech/transcriptions/${id}`,
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.transcriptionId,
    message: '转写记录不存在',
    destructive: true,
  },

  // ------------------------------------------------------- 会话（conversations）
  {
    id: 'conversations.get',
    family: 'conversations',
    title: '读会话',
    method: 'GET',
    path: (id) => `${API}/conversations/${id}`,
    target: (seeded) => seeded.conversationId,
    message: '资源不存在',
  },
  {
    id: 'conversations.turns.list',
    family: 'conversations',
    title: '读会话轮次',
    method: 'GET',
    path: (id) => `${API}/conversations/${id}/turns`,
    target: (seeded) => seeded.conversationId,
    message: '资源不存在',
  },
  {
    id: 'conversations.turns.create',
    family: 'conversations',
    title: '往会话里加一轮',
    method: 'POST',
    path: (id) => `${API}/conversations/${id}/turns`,
    body: TURN_BODY,
    idempotent: true,
    ifMatch: (seeded) => seeded.conversationEtag,
    target: (seeded) => seeded.conversationId,
    message: '资源不存在',
  },
  {
    id: 'conversations.delete',
    family: 'conversations',
    title: '删会话',
    method: 'DELETE',
    path: (id) => `${API}/conversations/${id}`,
    idempotent: true,
    ifMatch: (seeded) => seeded.conversationEtag,
    target: (seeded) => seeded.conversationId,
    message: '资源不存在',
    destructive: true,
  },
  {
    id: 'conversations.turns.delete',
    family: 'conversations',
    title: '删会话轮次',
    method: 'DELETE',
    // 他人这一侧：B 的会话 + B 的轮次；不存在这一侧：两个 id 都换成 ABSENT。
    path: (id, seeded) => `${API}/conversations/${id}/turns/${id === ABSENT ? ABSENT : seeded.turnId}`,
    idempotent: true,
    ifMatch: (seeded) => seeded.conversationEtag,
    target: (seeded) => seeded.conversationId,
    message: '资源不存在',
    destructive: true,
  },

  // ------------------------------------------------------------- 收藏 / 历史 / 消息
  {
    id: 'favorites.delete',
    family: 'favorites',
    title: '删收藏',
    method: 'DELETE',
    path: (id) => `${API}/favorites/${id}`,
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.favoriteId,
    message: '收藏不存在或不可用',
    destructive: true,
  },
  {
    id: 'history.delete',
    family: 'history',
    title: '删历史记录',
    method: 'DELETE',
    path: (id) => `${API}/history/${id}`,
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.historyId,
    message: '历史记录不存在或不可用',
    destructive: true,
  },
  {
    id: 'messages.read',
    family: 'messages',
    title: '把消息标为已读',
    method: 'PUT',
    path: (id) => `${API}/messages/${id}/read`,
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.messageId,
    message: '消息不存在或不可用',
  },

  // ------------------------------------------------- 社区写面（帖 / 评 / 举报）
  {
    id: 'posts.patch',
    family: 'community',
    title: '改别人的帖子',
    method: 'PATCH',
    path: (id) => `${API}/posts/${id}`,
    body: POST_BODY,
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.postId,
    message: '内容不存在或不可用',
  },
  {
    id: 'posts.delete',
    family: 'community',
    title: '删别人的帖子',
    method: 'DELETE',
    path: (id) => `${API}/posts/${id}`,
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.postId,
    message: '内容不存在或不可用',
    destructive: true,
  },
  {
    id: 'comments.patch',
    family: 'community',
    title: '改别人的评论',
    method: 'PATCH',
    path: (id) => `${API}/comments/${id}`,
    body: COMMENT_BODY,
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.commentId,
    message: '内容不存在或不可用',
  },
  {
    id: 'comments.delete',
    family: 'community',
    title: '删别人的评论',
    method: 'DELETE',
    path: (id) => `${API}/comments/${id}`,
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.commentId,
    message: '内容不存在或不可用',
    destructive: true,
  },
  {
    id: 'reports.get',
    family: 'community',
    title: '读别人的举报',
    method: 'GET',
    path: (id) => `${API}/reports/${id}`,
    target: (seeded) => seeded.reportId,
    message: '内容不存在或不可用',
  },

  // -------------------------------------------------------------------- 媒体
  {
    id: 'media.get',
    family: 'media',
    title: '读别人的媒体',
    method: 'GET',
    path: (id) => `${API}/media/${id}`,
    target: (seeded) => seeded.mediaId,
    message: '媒体不存在',
  },
  {
    id: 'media.delete',
    family: 'media',
    title: '删别人的媒体',
    method: 'DELETE',
    path: (id) => `${API}/media/${id}`,
    idempotent: true,
    ifMatch: '"1"',
    target: (seeded) => seeded.mediaId,
    message: '媒体不存在',
    destructive: true,
  },
];

/** 条数下限（只准加、不准在没人注意时被删）。 */
const MIN_PAIRS = 27;
/** 逐族条数下限（同上：只增不减）。 */
const FAMILY_MINIMUMS = {
  jobs: 2,
  recognitions: 3,
  ocr: 4,
  transcriptions: 3,
  conversations: 5,
  favorites: 1,
  history: 1,
  messages: 1,
  community: 5,
  media: 2,
};
/** 题目点名的五族：一条都不能少（少一条就等于那族的文案漂移没人看见）。 */
const REQUIRED_FAMILIES = ['jobs', 'recognitions', 'ocr', 'transcriptions', 'conversations'];

/**
 * 一个替身世界只装配一次：`createWorld()` + 两个用户 + 属主 B 的私有行 + 异步 AI 域的行。
 * 全部内存 store、替身对象存储、替身 AI 提供者（零外呼）。
 */
let cached = null;
async function fixture() {
  if (cached !== null) return cached;
  const world = createWorld();
  const a = await createAccount(world, 'msgparity-a');
  const b = await createAccount(world, 'msgparity-b');
  const owned = await seedOwnerRows(world, b);
  const ai = await seedAiRows(world, b, owned);
  cached = {
    world,
    a,
    b,
    seeded: {
      jobId: ai.jobId,
      recognitionId: ai.recognitionId,
      ocrId: ai.ocrId,
      transcriptionId: ai.transcriptionId,
      conversationId: ai.conversationId,
      conversationEtag: ai.conversationEtag,
      turnId: ai.turnId,
      favoriteId: owned.favoriteId,
      historyId: owned.historyId,
      messageId: owned.messageId,
      postId: owned.postId,
      commentId: owned.commentId,
      reportId: owned.reportId,
      mediaId: owned.media.mediaId,
    },
    readings: [],
  };
  return cached;
}

/**
 * 播种异步 AI 域的属主行（识别 / OCR / 转写作业 + settle 落定、会话 + 一轮）。
 *
 * 为什么要 `settle()`：替身提供者是异步的，不落定就只有作业行、没有"识别 / OCR / 转写记录"
 * 可读；而本守卫要证明的正是"B 的记录确实存在，A 拿到的 404 才叫同形"。
 */
async function seedAiRows(world, owner, owned) {
  const recognitionJob = await inject(world.app, {
    method: 'POST',
    path: `${API}/recognitions`,
    actor: owner,
    body: { media_id: owned.media.mediaId, media_revision: owned.media.revision },
    headers: { 'idempotency-key': 'i22-msgparity-seed-recognition' },
  });
  assert.equal(recognitionJob.status, 202, `播种识别作业失败：${recognitionJob.status} ${recognitionJob.text}`);

  const ocrJob = await inject(world.app, {
    method: 'POST',
    path: `${API}/ocr`,
    actor: owner,
    body: { media_id: owned.media.mediaId, media_revision: owned.media.revision },
    headers: { 'idempotency-key': 'i22-msgparity-seed-ocr' },
  });
  assert.equal(ocrJob.status, 202, `播种 OCR 作业失败：${ocrJob.status} ${ocrJob.text}`);

  const transcriptionJob = await inject(world.app, {
    method: 'POST',
    path: `${API}/speech/transcriptions`,
    actor: owner,
    body: { media_id: SPEECH_MEDIA_ID, media_revision: 1 },
    headers: { 'idempotency-key': 'i22-msgparity-seed-transcription' },
  });
  assert.equal(transcriptionJob.status, 202, `播种转写作业失败：${transcriptionJob.status} ${transcriptionJob.text}`);

  for (const service of [world.app.recognitionService, world.app.ocrService, world.app.speechService]) {
    if (typeof service?.settle === 'function') await service.settle();
  }

  const conversation = await inject(world.app, {
    method: 'POST',
    path: `${API}/conversations`,
    actor: owner,
    body: {},
    headers: { 'idempotency-key': 'i22-msgparity-seed-conversation' },
  });
  assert.equal(conversation.status, 201, `播种会话失败：${conversation.status} ${conversation.text}`);
  const conversationId = conversation.body.data.id;

  // 轮次写面要求 If-Match：先读一次拿属主侧的强 ETag（新会话是 "1"）。
  const conversationRead = await inject(world.app, {
    method: 'GET',
    path: `${API}/conversations/${conversationId}`,
    actor: owner,
  });
  const conversationEtag = conversationRead.etag ?? `"${conversation.body.data.revision}"`;
  const turn = await inject(world.app, {
    method: 'POST',
    path: `${API}/conversations/${conversationId}/turns`,
    actor: owner,
    body: TURN_BODY,
    headers: { 'idempotency-key': 'i22-msgparity-seed-turn', 'if-match': conversationEtag },
  });
  assert.equal(turn.status, 202, `播种会话轮次失败：${turn.status} ${turn.text}`);

  // 轮次写进去之后**重读**一次拿当前强 ETag：会话的 revision 会不会因加轮次而变，
  // 是实现细节；守卫不该把 `"1"` 硬编码进来（那样版本面一漂就误报成归属面）。
  const afterTurn = await inject(world.app, {
    method: 'GET',
    path: `${API}/conversations/${conversationId}`,
    actor: owner,
  });
  assert.equal(afterTurn.status, 200, `播种后重读会话失败：${afterTurn.status} ${afterTurn.text}`);

  return {
    jobId: recognitionJob.body.data.id,
    recognitionId: recognitionJob.body.data.target_ref.id,
    ocrId: ocrJob.body.data.target_ref.id,
    transcriptionId: transcriptionJob.body.data.target_ref.id,
    conversationId,
    conversationEtag: afterTurn.etag ?? `"${afterTurn.body.data.revision}"`,
    turnId: turn.body.data.id,
  };
}

/**
 * 把一条"表里的操作 + 目标 id"翻成一个请求。
 *
 * `Idempotency-Key` 两侧必须**不同**：同键重放会直接回放上一次的结果，
 * 那样比较的就不是两次真实判定，而是"幂等台账里存的同一行"——断言会变成空转。
 * 键长必须 8..128（实测 7 字符 ⇒ 400 `IDEMPOTENCY_KEY_REQUIRED`，会把 404 面整个挡掉）。
 * `If-Match` 两侧必须**相同**：它是"客户端手里的版本"，与被访问的 id 是两回事。
 */
function requestFor(pair, id, side, seeded) {
  const headers = {};
  if (pair.idempotent === true) headers['idempotency-key'] = `i22-msgparity-${pair.id.replaceAll('.', '-')}-${side}`;
  if (pair.ifMatch !== undefined) {
    // ifMatch 可以是字面量，也可以是 (seeded) => 属主侧当前 ETag（会话的行会被种子写入推进版本）。
    headers['if-match'] = typeof pair.ifMatch === 'function' ? pair.ifMatch(seeded) : pair.ifMatch;
  }
  const request = { method: pair.method, path: pair.path(id, seeded) };
  if (pair.body !== undefined) request.body = pair.body;
  if (Object.keys(headers).length > 0) request.headers = headers;
  return request;
}

/** 封套指纹：去掉**每请求必然不同**的 `meta.request_id` 之后，逐字节可比。 */
function envelopeOf(result) {
  const clone = result.body === null || result.body === undefined ? null : JSON.parse(JSON.stringify(result.body));
  if (clone !== null && clone.meta !== null && typeof clone.meta === 'object') delete clone.meta.request_id;
  return JSON.stringify(clone);
}

test('文案同形守卫：用例表自洽（id 唯一、五族齐备、逐族条数只增不减）', () => {
  const ids = new Set();
  for (const pair of PARITY_PAIRS) {
    assert.ok(typeof pair.id === 'string' && pair.id.length > 0, '用例缺 id');
    assert.ok(!ids.has(pair.id), `用例 id 重复：${pair.id}`);
    ids.add(pair.id);
    assert.ok(FAMILY_MINIMUMS[pair.family] !== undefined, `${pair.id} 的族 ${pair.family} 没有条数基线`);
    assert.match(pair.method, /^(GET|POST|PUT|PATCH|DELETE)$/, `${pair.id} 的 method 不合法：${pair.method}`);
    assert.equal(typeof pair.path, 'function', `${pair.id} 的 path 必须是函数（要按 id 展开）`);
    assert.equal(typeof pair.message, 'string', `${pair.id} 缺钉住的文案`);
    assert.ok(pair.message.trim().length > 0, `${pair.id} 的文案是空串`);
    assert.equal(typeof pair.target, 'function', `${pair.id} 缺 target`);
    assert.ok(typeof pair.title === 'string' && pair.title.length > 0, `${pair.id} 缺 title`);
  }

  assert.ok(PARITY_PAIRS.length >= MIN_PAIRS, `条数 ${PARITY_PAIRS.length} 少于基线 ${MIN_PAIRS}（用例被删了？）`);
  for (const [family, minimum] of Object.entries(FAMILY_MINIMUMS)) {
    const total = PARITY_PAIRS.filter((pair) => pair.family === family).length;
    assert.ok(total >= minimum, `族 ${family} 只剩 ${total} 对（基线 ${minimum}）`);
  }
  for (const family of REQUIRED_FAMILIES) {
    assert.ok(
      PARITY_PAIRS.some((pair) => pair.family === family),
      `点名必覆盖的族 ${family} 一对都没有`,
    );
  }
});

test('正控制（越权之前）：属主 B 确实拥有这些私有行', async () => {
  const { world, b, seeded } = await fixture();
  const reads = [
    ['作业', `${API}/jobs/${seeded.jobId}`, seeded.jobId],
    ['识别记录', `${API}/recognitions/${seeded.recognitionId}`, seeded.recognitionId],
    ['OCR 记录', `${API}/ocr/${seeded.ocrId}`, seeded.ocrId],
    ['转写记录', `${API}/speech/transcriptions/${seeded.transcriptionId}`, seeded.transcriptionId],
    ['会话', `${API}/conversations/${seeded.conversationId}`, seeded.conversationId],
  ];
  const failures = [];
  for (const [label, path, id] of reads) {
    const result = await inject(world.app, { method: 'GET', path, actor: b });
    if (result.status !== 200) {
      failures.push(`${label}：属主读自己的行应 200，实际 ${result.status} ${result.text.slice(0, 200)}`);
    } else if (result.body?.data?.id !== id) {
      failures.push(`${label}：data.id 期望 ${id}，实际 ${JSON.stringify(result.body?.data?.id)}`);
    }
  }
  assert.deepEqual(failures, [], `正控制失败（"他人 404"就没有意义了）：\n${failures.join('\n')}`);
});

test('他人资源 / 不存在资源：status、error.code、error.message 逐字相同，且封套逐字节相同', async () => {
  const context = await fixture();
  const { world, a, b, seeded } = context;
  const failures = [];
  /** 收集而不是首错即停：一次读就能看到全部 27 对的差异，像矩阵那样给完整读数。 */
  const failed = (line) => {
    failures.push(line);
  };

  // 破坏性操作（DELETE）排在最后：万一同形保护本身失效、请求真的动到了 B 的行，
  // 后面的正控制会跟着红，而不是被"已经删掉了所以都 404"掩盖成同形。
  const ordered = [...PARITY_PAIRS].sort(
    (left, right) => Number(left.destructive === true) - Number(right.destructive === true),
  );

  for (const pair of ordered) {
    const foreignId = pair.target(seeded);
    const foreign = await inject(world.app, { ...requestFor(pair, foreignId, 'foreign', seeded), actor: a });
    const absent = await inject(world.app, { ...requestFor(pair, ABSENT, 'absent', seeded), actor: a });

    const foreignCode = foreign.body?.error?.code ?? null;
    const absentCode = absent.body?.error?.code ?? null;
    const foreignMessage = foreign.body?.error?.message ?? null;
    const absentMessage = absent.body?.error?.message ?? null;

    context.readings.push({ pair, foreignId, foreign, foreignMessage, absentMessage });

    if (foreign.status !== 404) failed(`${pair.id} 他人资源应 404，实际 ${foreign.status}`);
    if (absent.status !== 404) failed(`${pair.id} 不存在资源应 404，实际 ${absent.status}`);
    if (foreign.status !== absent.status) failed(`${pair.id} status 不同：他人 ${foreign.status} / 不存在 ${absent.status}`);
    if (foreignCode !== 'NOT_FOUND') failed(`${pair.id} 他人资源 code 应 NOT_FOUND，实际 ${JSON.stringify(foreignCode)}`);
    if (absentCode !== 'NOT_FOUND') failed(`${pair.id} 不存在资源 code 应 NOT_FOUND，实际 ${JSON.stringify(absentCode)}`);
    if (foreignCode !== absentCode) failed(`${pair.id} code 不同：他人 ${JSON.stringify(foreignCode)} / 不存在 ${JSON.stringify(absentCode)}`);

    // 文案：先比"两侧逐字相同"，再比"等于钉住的字面量"。只比前者会让"两侧一起改"漏网。
    if (foreignMessage !== absentMessage) {
      failed(`${pair.id} message 不同：他人 ${JSON.stringify(foreignMessage)} / 不存在 ${JSON.stringify(absentMessage)}`);
    }
    if (foreignMessage !== pair.message) {
      failed(`${pair.id} message 漂移：钉住 ${JSON.stringify(pair.message)}，实际 ${JSON.stringify(foreignMessage)}`);
    }

    // 封套逐字节：retryable / details / contract_version / execution_mode 任一处不同都算泄露面。
    const foreignEnvelope = envelopeOf(foreign);
    const absentEnvelope = envelopeOf(absent);
    if (foreignEnvelope !== absentEnvelope) failed(`${pair.id} 去掉 request_id 后封套不同：\n  他人 ${foreignEnvelope}\n  不存在 ${absentEnvelope}`);

    for (const [side, result] of [['他人', foreign], ['不存在', absent]]) {
      const details = result.body?.error?.details;
      if (!Array.isArray(details) || details.length !== 0) {
        failed(`${pair.id} ${side}侧的 error.details 应为空数组，实际 ${JSON.stringify(details)}`);
      }
      if (result.body?.meta?.contract_version !== '1.0.0') {
        failed(`${pair.id} ${side}侧的 meta.contract_version 异常：${JSON.stringify(result.body?.meta?.contract_version)}`);
      }
    }
  }

  // 收尾正控制放在同一个 test 里：断言顺序保证了"越权请求跑完之后 B 的行还在"。
  const after = [
    ['作业', `${API}/jobs/${seeded.jobId}`],
    ['识别记录', `${API}/recognitions/${seeded.recognitionId}`],
    ['OCR 记录', `${API}/ocr/${seeded.ocrId}`],
    ['转写记录', `${API}/speech/transcriptions/${seeded.transcriptionId}`],
    ['会话', `${API}/conversations/${seeded.conversationId}`],
  ];
  for (const [label, path] of after) {
    const result = await inject(world.app, { method: 'GET', path, actor: b });
    if (result.status !== 200) failed(`${label}：越权请求之后属主仍应能读自己的行（实际 ${result.status}）`);
  }

  assert.deepEqual(failures, [], `文案同形守卫失败：\n${failures.join('\n')}`);
});

test('反泄露：404 文案不含被请求的资源 id（不拿 id 拼文案）', async () => {
  const { readings } = await fixture();
  assert.equal(readings.length, PARITY_PAIRS.length, '上一轮没有把每对请求都跑完，反泄露断言会空转');

  const failures = [];
  for (const { pair, foreignId, foreignMessage, absentMessage } of readings) {
    for (const [side, message, id] of [['他人', foreignMessage, foreignId], ['不存在', absentMessage, ABSENT]]) {
      if (typeof message !== 'string' || message.length === 0) {
        failures.push(`${pair.id} ${side}侧文案不是非空字符串：${JSON.stringify(message)}`);
        continue;
      }
      if (message.includes(id)) failures.push(`${pair.id} ${side}侧文案里出现了资源 id：${JSON.stringify(message)}`);
      // 任何 uuid 片段都不该出现在 404 文案里：文案一旦开始回显 id，同形就不再成立。
      if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(message)) {
        failures.push(`${pair.id} ${side}侧文案里出现了 uuid：${JSON.stringify(message)}`);
      }
      if (message.includes('/api/v1/')) failures.push(`${pair.id} ${side}侧文案里回显了请求路径：${JSON.stringify(message)}`);
    }
  }
  assert.deepEqual(failures, [], `反泄露守卫失败：\n${failures.join('\n')}`);
});
