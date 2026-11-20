// 耕云的最小可运营后端：应用自有账号、云端同步、社区审核、人工复核队列。
// 身份只来自本应用自己的恢复码 Cookie；不使用平台身份，也不信任浏览器提交的归属。
// 数据访问只经服务端完成；识别模型未配置时如实进入人工复核，不伪造识别结果。

export class AppError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

const NO_STORE = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const SESSION_COOKIE = "__Host-gy_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 365;
const TOKEN_PATTERN = /^gy_[A-Za-z0-9_-]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADMIN_CODE_SHA256 = "47a31736ef2a95e2884f43e0fcfad7e624f4e04e716ab2281e4f6a23441c0a6e";
const OBJECT_PREFIX = "recognition/";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const PUBLIC_ORIGINS = new Set([
  "https://gengyun-kuq6uc6h8js.qoder.zone",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);

const MODERATION_RULES = [
  {
    label: "联系方式或交易信息",
    pattern: /(微信|vx|v信|加我|私信|qq|电话|手机号|1[3-9]\d{9}|\d{5,}群|代购|出售|价格|多少钱|包邮|下单)/i,
  },
  {
    label: "用量或施药方案",
    pattern: /(\d+(\.\d+)?\s*(ml|毫升|克|g|千克|kg|升|l)\s*[\/每]?\s*(亩|公顷|桶|壶)|兑水|稀释|喷施|喷洒|用药量|亩用|拌种)/i,
  },
  {
    label: "功效保证用语",
    pattern: /(根治|包治|特效|百分百|100%|保证死|药到病除|彻底消灭|绝无复发)/i,
  },
];

const nowIso = () => new Date().toISOString();

function json(value, status = 200, extra = {}) {
  return Response.json(value, { status, headers: { ...NO_STORE, ...extra } });
}

export function errorJson(code, status, extra = {}) {
  return json({ error: code }, status, extra);
}

function fail(code, status) {
  throw new AppError(code, status);
}

function rows(result) {
  if (result?.error || !Array.isArray(result?.data)) fail("database_unavailable", 503);
  return result.data;
}

function applicationPath(request) {
  const match = new URL(request.url).pathname.match(
    /^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/,
  );
  if (!match) fail("not_found", 404);
  return match[1] || "/";
}

function requireTrustedOrigin(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  if (!origin || !PUBLIC_ORIGINS.has(origin)) fail("origin_forbidden", 403);
}

async function readJson(request, maxBytes = 16384) {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    fail("invalid_input", 400);
  }
  const reader = request.body?.getReader();
  if (!reader) fail("invalid_input", 400);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        fail("payload_too_large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("invalid_input", 400);
  }
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function text(value, max, code = "invalid_input") {
  if (typeof value !== "string") fail(code, 400);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) fail(code, 400);
  return trimmed;
}

function optionalText(value, max) {
  if (value == null) return "";
  if (typeof value !== "string") fail("invalid_input", 400);
  return value.trim().slice(0, max);
}

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(digest);
}

function newRecoveryCode() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return "gy_" + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cookieFrom(request) {
  const header = request.headers.get("cookie") ?? "";
  if (!header || header.length > 8192) return null;
  const values = [];
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const at = trimmed.indexOf("=");
    if (at < 1) continue;
    if (trimmed.slice(0, at).trim() === SESSION_COOKIE) values.push(trimmed.slice(at + 1));
  }
  if (values.length > 1) return null;
  const token = values[0] ?? null;
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
}

function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function accountView(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    crop: row.crop,
    autoReadAnswers: row.auto_read === true,
    role: row.role,
    createdAt: row.created_at,
  };
}

async function accountFor(db, request) {
  const token = cookieFrom(request);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const found = rows(
    await db.from("accounts")
      .select("id,role,display_name,crop,auto_read,created_at,token_hash")
      .eq("token_hash", hash)
      .limit(1),
  );
  if (!found.length || found[0].token_hash !== hash) return null;
  return found[0];
}

async function requireAccount(db, request) {
  const account = await accountFor(db, request);
  if (!account) fail("login_required", 401);
  return account;
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function requireAdmin(request, expectedHash) {
  const code = request.headers.get("x-gy-admin-code");
  if (!code || code.length > 256) fail("admin_required", 401);
  const hash = await sha256Hex(code);
  if (!safeEqual(hash, expectedHash)) fail("admin_required", 401);
}

function moderate(input) {
  for (const rule of MODERATION_RULES) {
    if (rule.pattern.test(input)) return rule.label;
  }
  return null;
}

async function notify(db, accountId, kind, title, body, target) {
  try {
    await db.from("notifications").insert({
      id: crypto.randomUUID(),
      account_id: accountId,
      kind,
      title,
      body,
      target,
      read_at: null,
      created_at: nowIso(),
    });
  } catch {
    // 通知失败不回滚已经完成的主操作。
  }
}

async function verifyImage(response) {
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!response.ok || !response.body) fail("invalid_upload", 422);
  if (!["image/png", "image/jpeg", "image/webp"].includes(type)) {
    await response.body.cancel().catch(() => {});
    fail("invalid_upload", 422);
  }
  const reader = response.body.getReader();
  let size = 0;
  const timer = setTimeout(() => {
    void reader.cancel().catch(() => {});
  }, 15000);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) fail("invalid_upload", 422);
    }
    if (size === 0) fail("invalid_upload", 422);
    return { size, type };
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function deleteWhere(db, table, pairs) {
  let query = db.from(table).delete();
  for (const [key, value] of pairs) query = query.eq(key, value);
  const result = await query;
  if (result?.error) fail("database_unavailable", 503);
}

async function forgetAccount(db, storage, account) {
  const jobs = rows(
    await db.from("recognition_jobs")
      .select("id,object_path").eq("account_id", account.id).limit(500),
  );
  const objectPaths = jobs.map((job) => job.object_path).filter((path) => typeof path === "string");
  if (objectPaths.length) {
    try {
      await storage.remove(objectPaths);
    } catch {
      fail("storage_cleanup_failed", 503);
    }
  }

  const posts = rows(await db.from("posts").select("id").eq("author_id", account.id).limit(500));
  for (const post of posts) {
    await deleteWhere(db, "comments", [["post_id", post.id]]);
    await deleteWhere(db, "likes", [["post_id", post.id]]);
    await deleteWhere(db, "reports", [["post_id", post.id]]);
  }
  await deleteWhere(db, "comments", [["author_id", account.id]]);
  await deleteWhere(db, "likes", [["account_id", account.id]]);
  await deleteWhere(db, "reports", [["reporter_id", account.id]]);
  await deleteWhere(db, "posts", [["author_id", account.id]]);
  await deleteWhere(db, "notifications", [["account_id", account.id]]);
  await deleteWhere(db, "message_reads", [["account_id", account.id]]);
  await deleteWhere(db, "history", [["account_id", account.id]]);
  await deleteWhere(db, "favorites", [["account_id", account.id]]);
  await deleteWhere(db, "recognition_jobs", [["account_id", account.id]]);
  await deleteWhere(db, "accounts", [["id", account.id]]);
}

export function application({ db, storage, adminCodeHash = ADMIN_CODE_SHA256 }) {
  async function syncPayload(account) {
    const favorites = rows(
      await db.from("favorites")
        .select("kind,item_key,title,subtitle,created_at")
        .eq("account_id", account.id)
        .order("created_at", { ascending: false })
        .limit(100),
    );
    const history = rows(
      await db.from("history")
        .select("client_id,kind,title,subtitle,corrections,correction_notes,created_at")
        .eq("account_id", account.id)
        .order("created_at", { ascending: false })
        .limit(50),
    );
    const reads = rows(
      await db.from("message_reads")
        .select("message_id").eq("account_id", account.id).limit(200),
    );
    return {
      account: accountView(account),
      favorites: favorites.map((row) => ({
        kind: row.kind,
        key: row.item_key,
        title: row.title,
        subtitle: row.subtitle,
        savedAt: row.created_at,
      })),
      history: history.map((row) => ({
        id: row.client_id,
        kind: row.kind,
        title: row.title,
        subtitle: row.subtitle,
        corrections: Array.isArray(row.correction_notes) ? row.correction_notes : [],
        at: row.created_at,
      })),
      readMessages: reads.map((row) => row.message_id),
      preferences: { crop: account.crop, autoReadAnswers: account.auto_read === true },
    };
  }

  async function register(request) {
    const body = await readJson(request);
    const displayName = text(body?.displayName ?? "田间探索者", 24);
    const crop = text(body?.crop ?? "水稻", 20);
    const autoRead = body?.autoReadAnswers === true;
    const id = crypto.randomUUID();
    const recoveryCode = newRecoveryCode();
    const tokenHash = await sha256Hex(recoveryCode);
    const createdAt = nowIso();
    const inserted = rows(
      await db.from("accounts").insertIfAbsent({
        id,
        token_hash: tokenHash,
        role: "user",
        display_name: displayName,
        crop,
        auto_read: autoRead,
        created_at: createdAt,
        updated_at: createdAt,
      }, { onConflict: "token_hash" }).select("id"),
    );
    if (!inserted.length) fail("account_unavailable", 503);
    await notify(
      db,
      id,
      "system",
      "欢迎来到耕云",
      "云端同步已经开启。请先保存恢复码：它只在创建时显示一次。",
      "/profile",
    ).catch(() => {});
    return json(
      {
        account: { id, displayName, crop, autoReadAnswers: autoRead, role: "user", createdAt },
        recoveryCode,
      },
      201,
      { "set-cookie": sessionCookie(recoveryCode) },
    );
  }

  async function restore(request) {
    const body = await readJson(request);
    const code = typeof body?.recoveryCode === "string" ? body.recoveryCode.trim() : "";
    if (!TOKEN_PATTERN.test(code)) fail("invalid_recovery_code", 401);
    const oldHash = await sha256Hex(code);
    const found = rows(
      await db.from("accounts")
        .select("id,role,display_name,crop,auto_read,created_at,token_hash")
        .eq("token_hash", oldHash)
        .limit(1),
    );
    if (!found.length) fail("invalid_recovery_code", 401);
    const account = found[0];
    const nextCode = newRecoveryCode();
    const nextHash = await sha256Hex(nextCode);
    const rotated = rows(
      await db.from("accounts")
        .update({ token_hash: nextHash, updated_at: nowIso() })
        .eq("id", account.id)
        .eq("token_hash", oldHash)
        .select("id"),
    );
    if (!rotated.length) fail("restore_conflict", 409);
    return json(
      { account: accountView(account), recoveryCode: nextCode },
      200,
      { "set-cookie": sessionCookie(nextCode) },
    );
  }

  async function exportAccount(account) {
    const [favorites, history, reads, posts, comments, likes, reports, jobs, notifications] =
      await Promise.all([
        db.from("favorites").select("kind,item_key,title,subtitle,created_at").eq("account_id", account.id).limit(500),
        db.from("history").select("client_id,kind,title,subtitle,corrections,correction_notes,created_at").eq("account_id", account.id).limit(500),
        db.from("message_reads").select("message_id,read_at").eq("account_id", account.id).limit(500),
        db.from("posts").select("id,title,body,crop,status,report_count,created_at,published_at").eq("author_id", account.id).limit(500),
        db.from("comments").select("id,post_id,body,status,created_at").eq("author_id", account.id).limit(500),
        db.from("likes").select("post_id,created_at").eq("account_id", account.id).limit(1000),
        db.from("reports").select("post_id,reason,created_at").eq("reporter_id", account.id).limit(500),
        db.from("recognition_jobs").select("id,status,note,corrected_summary,created_at,updated_at").eq("account_id", account.id).limit(500),
        db.from("notifications").select("kind,title,body,target,read_at,created_at").eq("account_id", account.id).limit(500),
      ]);
    return json({
      exportedAt: nowIso(),
      account: accountView(account),
      favorites: rows(favorites),
      history: rows(history),
      messageReads: rows(reads),
      posts: rows(posts),
      comments: rows(comments),
      likes: rows(likes),
      reports: rows(reports),
      recognitionJobs: rows(jobs),
      notifications: rows(notifications),
      boundary:
        "导出内容仅为你提交与本机产生的数据。耕云不提供用量、药效承诺或施用方案。",
    }, 200, { "content-disposition": 'attachment; filename="gengyun-export.json"' });
  }

  async function communityList(account) {
    const posts = rows(
      await db.from("posts")
        .select("id,author_id,author_name,crop,title,body,status,created_at,published_at")
        .eq("status", "published")
        .order("created_at", { ascending: false })
        .limit(100),
    );
    const comments = rows(
      await db.from("comments")
        .select("id,post_id,author_name,body,created_at")
        .eq("status", "published")
        .order("created_at", { ascending: true })
        .limit(500),
    );
    const likes = rows(
      await db.from("likes").select("post_id,account_id").limit(1000),
    );
    const postIds = new Set(posts.map((post) => post.id));
    const commentsByPost = new Map();
    for (const comment of comments) {
      if (!postIds.has(comment.post_id)) continue;
      const list = commentsByPost.get(comment.post_id) ?? [];
      list.push({
        id: comment.id,
        author: comment.author_name,
        text: comment.body,
        at: comment.created_at,
      });
      commentsByPost.set(comment.post_id, list);
    }
    const likeCount = new Map();
    const likedByMe = new Set();
    for (const like of likes) {
      if (!postIds.has(like.post_id)) continue;
      likeCount.set(like.post_id, (likeCount.get(like.post_id) ?? 0) + 1);
      if (account && like.account_id === account.id) likedByMe.add(like.post_id);
    }
    return json({
      posts: posts.map((post) => ({
        id: post.id,
        author: post.author_name,
        crop: post.crop,
        title: post.title,
        body: post.body,
        at: post.published_at ?? post.created_at,
        likes: likeCount.get(post.id) ?? 0,
        liked: likedByMe.has(post.id),
        mine: account ? post.author_id === account.id : false,
        comments: (commentsByPost.get(post.id) ?? []).slice(-30),
      })),
    });
  }

  async function createPost(account, request) {
    const body = await readJson(request);
    const bodyText = text(body?.body, 1000);
    const title = text(body?.title ?? bodyText.slice(0, 40), 80);
    const crop = text(body?.crop ?? account.crop, 20);
    const flagged = moderate(`${title}\n${bodyText}`);
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    rows(
      await db.from("posts").insert({
        id,
        author_id: account.id,
        author_name: account.display_name,
        crop,
        title,
        body: bodyText,
        status: flagged ? "pending" : "published",
        report_count: 0,
        created_at: createdAt,
        published_at: flagged ? null : createdAt,
      }).select("id"),
    );
    if (flagged) {
      await notify(
        db,
        account.id,
        "moderation",
        "帖子已提交复核",
        `内容包含${flagged}，已进入人工复核队列。复核通过后才会公开。`,
        "/community",
      ).catch(() => {});
    }
    return json({
      id,
      status: flagged ? "pending" : "published",
      reviewReason: flagged,
    }, 201);
  }

  async function createComment(account, postId, request) {
    const body = await readJson(request);
    const comment = text(body?.body, 400);
    const post = rows(
      await db.from("posts").select("id,author_id,author_name,title,status")
        .eq("id", postId).limit(1),
    );
    if (!post.length) fail("not_found", 404);
    if (post[0].status !== "published") fail("post_not_published", 409);
    const flagged = moderate(comment);
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    rows(
      await db.from("comments").insert({
        id,
        post_id: postId,
        author_id: account.id,
        author_name: account.display_name,
        body: comment,
        status: flagged ? "pending" : "published",
        created_at: createdAt,
      }).select("id"),
    );
    if (!flagged) {
      await notify(
        db,
        post[0].author_id,
        "comment",
        "你的帖子收到一条评论",
        `${account.display_name}：${comment.slice(0, 60)}`,
        "/community",
      ).catch(() => {});
    } else {
      await notify(
        db,
        account.id,
        "moderation",
        "评论已提交复核",
        `评论包含${flagged}，已进入人工复核队列。`,
        "/community",
      ).catch(() => {});
    }
    return json({ id, status: flagged ? "pending" : "published", reviewReason: flagged }, 201);
  }

  async function toggleLike(account, postId) {
    const post = rows(
      await db.from("posts").select("id,status").eq("id", postId).limit(1),
    );
    if (!post.length || post[0].status !== "published") fail("not_found", 404);
    const existing = rows(
      await db.from("likes").select("post_id").eq("post_id", postId).eq("account_id", account.id).limit(1),
    );
    if (existing.length) {
      await deleteWhere(db, "likes", [["post_id", postId], ["account_id", account.id]]);
      return json({ liked: false });
    }
    rows(
      await db.from("likes").insertIfAbsent({
        post_id: postId,
        account_id: account.id,
        created_at: nowIso(),
      }, { onConflict: "post_id,account_id" }).select("post_id"),
    );
    return json({ liked: true });
  }

  async function reportPost(account, postId, request) {
    const body = await readJson(request);
    const reason = text(body?.reason ?? "内容需要复核", 200);
    const post = rows(
      await db.from("posts").select("id,author_id,status,report_count").eq("id", postId).limit(1),
    );
    if (!post.length || post[0].status === "rejected") fail("not_found", 404);
    if (post[0].author_id === account.id) fail("cannot_report_own_post", 400);
    const inserted = rows(
      await db.from("reports").insertIfAbsent({
        id: crypto.randomUUID(),
        post_id: postId,
        reporter_id: account.id,
        reason,
        created_at: nowIso(),
      }, { onConflict: "post_id,reporter_id" }).select("id"),
    );
    if (!inserted.length) return json({ ok: true, duplicate: true });
    const count = (post[0].report_count ?? 0) + 1;
    const patch = { report_count: count };
    if (count >= 3) {
      patch.status = "pending";
      patch.published_at = null;
    }
    await db.from("posts").update(patch).eq("id", postId);
    return json({ ok: true, duplicate: false });
  }

  async function adminQueue() {
    const pendingPosts = rows(
      await db.from("posts")
        .select("id,author_name,title,body,crop,status,report_count,created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(100),
    );
    const pendingComments = rows(
      await db.from("comments")
        .select("id,post_id,author_name,body,created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(100),
    );
    const reports = rows(
      await db.from("reports").select("id,post_id,reason,created_at")
        .order("created_at", { ascending: false }).limit(50),
    );
    const jobs = rows(
      await db.from("recognition_jobs")
        .select("id,account_id,object_path,note,created_at")
        .eq("status", "needs_review")
        .order("created_at", { ascending: true })
        .limit(50),
    );
    const posts = rows(
      await db.from("posts")
        .select("id,title,author_name,status,report_count")
        .order("created_at", { ascending: false }).limit(200),
    );
    const postMap = new Map(posts.map((post) => [post.id, post]));
    const commentPostIds = pendingComments.map((comment) => comment.post_id);
    const commentPosts = [];
    for (const id of new Set(commentPostIds)) {
      const found = rows(await db.from("posts").select("id,title").eq("id", id).limit(1));
      if (found.length) commentPosts.push(found[0]);
    }
    const commentPostMap = new Map(commentPosts.map((post) => [post.id, post.title]));
    const accounts = new Map();
    for (const job of jobs) {
      if (!accounts.has(job.account_id)) {
        const found = rows(
          await db.from("accounts").select("id,display_name").eq("id", job.account_id).limit(1),
        );
        accounts.set(job.account_id, found[0]?.display_name ?? "田间用户");
      }
    }
    const jobViews = [];
    for (const job of jobs) {
      let signedUrl = null;
      try {
        const signed = await storage.createSignedUrl(job.object_path, 300);
        signedUrl = signed?.signedUrl ?? null;
      } catch {
        signedUrl = null;
      }
      jobViews.push({
        id: job.id,
        account: accounts.get(job.account_id) ?? "田间用户",
        note: job.note,
        createdAt: job.created_at,
        signedUrl,
      });
    }
    return json({
      posts: pendingPosts,
      comments: pendingComments.map((comment) => ({
        ...comment,
        postTitle: commentPostMap.get(comment.post_id) ?? "（帖子不可用）",
      })),
      reports: reports.map((report) => {
        const post = postMap.get(report.post_id);
        return {
          ...report,
          postTitle: post?.title ?? "（帖子不可用）",
          postAuthor: post?.author_name ?? "",
          postStatus: post?.status ?? "",
        };
      }),
      jobs: jobViews,
    });
  }

  async function moderateContent(request) {
    const body = await readJson(request);
    const kind = body?.kind;
    const id = body?.id;
    const decision = body?.decision;
    const note = optionalText(body?.note, 200);
    if (!isUuid(id) || !["post", "comment"].includes(kind) || !["publish", "reject"].includes(decision)) {
      fail("invalid_input", 400);
    }
    if (kind === "post") {
      const found = rows(
        await db.from("posts").select("id,author_id,title").eq("id", id).limit(1),
      );
      if (!found.length) fail("not_found", 404);
      const post = found[0];
      const status = decision === "publish" ? "published" : "rejected";
      await db.from("posts").update({
        status,
        published_at: decision === "publish" ? nowIso() : null,
      }).eq("id", id);
      await notify(
        db,
        post.author_id,
        "moderation",
        decision === "publish" ? "帖子已通过复核" : "帖子未通过复核",
        decision === "publish"
          ? `《${post.title}》已公开。`
          : `《${post.title}》未公开。${note || "内容不符合社区边界，请修改后重新发布。"}`,
        "/community",
      ).catch(() => {});
      return json({ ok: true, status });
    }
    const found = rows(
      await db.from("comments").select("id,author_id,post_id").eq("id", id).limit(1),
    );
    if (!found.length) fail("not_found", 404);
    const comment = found[0];
    const status = decision === "publish" ? "published" : "rejected";
    await db.from("comments").update({ status }).eq("id", id);
    await notify(
      db,
      comment.author_id,
      "moderation",
      decision === "publish" ? "评论已通过复核" : "评论未通过复核",
      decision === "publish" ? "你的评论已公开。" : note || "评论未公开，请遵守社区边界。",
      "/community",
    ).catch(() => {});
    return json({ ok: true, status });
  }

  async function reviewJob(request) {
    const body = await readJson(request);
    const id = body?.id;
    const decision = body?.decision;
    if (!isUuid(id) || !["reviewed", "failed"].includes(decision)) fail("invalid_input", 400);
    const found = rows(
      await db.from("recognition_jobs")
        .select("id,account_id,status,object_path").eq("id", id).limit(1),
    );
    if (!found.length) fail("not_found", 404);
    const job = found[0];
    const summary = decision === "reviewed" ? text(body?.correctedSummary, 500) : "";
    const note = decision === "reviewed"
      ? "人工复核已完成。"
      : optionalText(body?.note, 200) || "该照片暂无法完成人工复核。";
    await db.from("recognition_jobs").update({
      status: decision,
      corrected_summary: summary,
      note,
      updated_at: nowIso(),
    }).eq("id", id);
    await notify(
      db,
      job.account_id,
      "review",
      decision === "reviewed" ? "照片复核有结果了" : "照片复核未完成",
      decision === "reviewed"
        ? `人工复核记录：${summary}`
        : note,
      "/identify",
    ).catch(() => {});
    return json({ ok: true, status: decision });
  }

  async function recognitionList(account) {
    const jobs = rows(
      await db.from("recognition_jobs")
        .select("id,status,note,corrected_summary,created_at,updated_at")
        .eq("account_id", account.id)
        .order("created_at", { ascending: false })
        .limit(50),
    );
    return json({
      jobs: jobs.map((job) => ({
        id: job.id,
        status: job.status,
        note: job.note,
        correctedSummary: job.corrected_summary,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      })),
      modelConfigured: false,
    });
  }

  return async function handle(request) {
    requireTrustedOrigin(request);
    const path = applicationPath(request);
    const method = request.method;

    if (path === "/api/health" && method === "GET") return json({ ok: true });

    if (path === "/api/auth/register" && method === "POST") return register(request);
    if (path === "/api/auth/restore" && method === "POST") return restore(request);

    if (path === "/api/auth/session" && method === "GET") {
      const account = await accountFor(db, request);
      if (!account) {
        return cookieFrom(request)
          ? json({ authenticated: false }, 200, { "set-cookie": clearCookie() })
          : json({ authenticated: false });
      }
      return json({ authenticated: true, account: accountView(account) });
    }

    if (path === "/api/auth/logout" && method === "POST") {
      return json({ ok: true }, 200, { "set-cookie": clearCookie() });
    }

    if (path === "/api/auth/export" && method === "GET") {
      return exportAccount(await requireAccount(db, request));
    }

    if (path === "/api/auth/account" && method === "DELETE") {
      const account = await requireAccount(db, request);
      await forgetAccount(db, storage, account);
      return json({ ok: true }, 200, { "set-cookie": clearCookie() });
    }

    if (path === "/api/account" && method === "PATCH") {
      const account = await requireAccount(db, request);
      const body = await readJson(request);
      const patch = {};
      if (body?.displayName !== undefined) patch.display_name = text(body.displayName, 24);
      if (body?.crop !== undefined) patch.crop = text(body.crop, 20);
      if (body?.autoReadAnswers !== undefined) patch.auto_read = body.autoReadAnswers === true;
      if (!Object.keys(patch).length) fail("invalid_input", 400);
      patch.updated_at = nowIso();
      const updated = rows(
        await db.from("accounts").update(patch)
          .eq("id", account.id).select("id,role,display_name,crop,auto_read,created_at"),
      );
      return json({ account: accountView(updated[0] ?? { ...account, ...patch }) });
    }

    if (path === "/api/sync" && method === "GET") {
      return json(await syncPayload(await requireAccount(db, request)));
    }

    if (path === "/api/favorites" && method === "POST") {
      const account = await requireAccount(db, request);
      const body = await readJson(request);
      const kind = text(body?.kind, 20);
      if (!["herbicide", "weed", "record"].includes(kind)) fail("invalid_input", 400);
      const itemKey = text(body?.itemKey, 120);
      const title = text(body?.title, 120);
      const subtitle = optionalText(body?.subtitle, 200);
      rows(
        await db.from("favorites").insertIfAbsent({
          id: crypto.randomUUID(),
          account_id: account.id,
          kind,
          item_key: itemKey,
          title,
          subtitle,
          created_at: nowIso(),
        }, { onConflict: "account_id,kind,item_key" }).select("id"),
      );
      return json({ ok: true, favorite: { kind, key: itemKey, title, subtitle } });
    }

    if (path === "/api/favorites/remove" && method === "POST") {
      const account = await requireAccount(db, request);
      const body = await readJson(request);
      const kind = text(body?.kind, 20);
      const itemKey = text(body?.itemKey, 120);
      await deleteWhere(db, "favorites", [
        ["account_id", account.id],
        ["kind", kind],
        ["item_key", itemKey],
      ]);
      return json({ ok: true });
    }

    if (path === "/api/history" && method === "POST") {
      const account = await requireAccount(db, request);
      const body = await readJson(request);
      const clientId = body?.clientId;
      if (!isUuid(clientId)) fail("invalid_input", 400);
      const kind = text(body?.kind, 20);
      const title = text(body?.title, 160);
      const subtitle = optionalText(body?.subtitle, 300);
      const corrections = Array.isArray(body?.corrections) ? body.corrections : [];
      if (corrections.length > 20 || corrections.some((item) => typeof item !== "string" || item.length > 200)) {
        fail("invalid_input", 400);
      }
      const existing = rows(
        await db.from("history").select("id").eq("account_id", account.id)
          .eq("client_id", clientId).limit(1),
      );
      if (existing.length) {
        await db.from("history").update({
          kind,
          title,
          subtitle,
          corrections: corrections.length,
          correction_notes: corrections,
          created_at: nowIso(),
        }).eq("id", existing[0].id).eq("account_id", account.id);
      } else {
        rows(
          await db.from("history").insertIfAbsent({
            id: crypto.randomUUID(),
            account_id: account.id,
            client_id: clientId,
            kind,
            title,
            subtitle,
            corrections: corrections.length,
            correction_notes: corrections,
            created_at: nowIso(),
          }, { onConflict: "account_id,client_id" }).select("id"),
        );
      }
      return json({ ok: true });
    }

    if (path === "/api/history/clear" && method === "POST") {
      const account = await requireAccount(db, request);
      await deleteWhere(db, "history", [["account_id", account.id]]);
      return json({ ok: true });
    }

    if (path === "/api/reads" && method === "POST") {
      const account = await requireAccount(db, request);
      const body = await readJson(request);
      const messageId = text(body?.messageId, 120);
      rows(
        await db.from("message_reads").insertIfAbsent({
          account_id: account.id,
          message_id: messageId,
          read_at: nowIso(),
        }, { onConflict: "account_id,message_id" }).select("message_id"),
      );
      return json({ ok: true });
    }

    if (path === "/api/reads/all" && method === "POST") {
      const account = await requireAccount(db, request);
      const body = await readJson(request);
      const ids = Array.isArray(body?.messageIds) ? body.messageIds : [];
      if (ids.length > 200 || ids.some((id) => typeof id !== "string" || id.length > 120)) {
        fail("invalid_input", 400);
      }
      for (const messageId of ids) {
        rows(
          await db.from("message_reads").insertIfAbsent({
            account_id: account.id,
            message_id: messageId,
            read_at: nowIso(),
          }, { onConflict: "account_id,message_id" }).select("message_id"),
        );
      }
      return json({ ok: true });
    }

    if (path === "/api/community" && method === "GET") {
      return communityList(await accountFor(db, request));
    }

    if (path === "/api/community/posts" && method === "POST") {
      return createPost(await requireAccount(db, request), request);
    }

    const commentPath = path.match(/^\/api\/community\/posts\/([0-9a-f-]{36})\/comments$/);
    if (commentPath && isUuid(commentPath[1]) && method === "POST") {
      return createComment(await requireAccount(db, request), commentPath[1], request);
    }

    const likePath = path.match(/^\/api\/community\/posts\/([0-9a-f-]{36})\/like$/);
    if (likePath && isUuid(likePath[1]) && method === "POST") {
      return toggleLike(await requireAccount(db, request), likePath[1]);
    }

    const reportPath = path.match(/^\/api\/community\/posts\/([0-9a-f-]{36})\/report$/);
    if (reportPath && isUuid(reportPath[1]) && method === "POST") {
      return reportPost(await requireAccount(db, request), reportPath[1], request);
    }

    if (path === "/api/community/mine" && method === "GET") {
      const account = await requireAccount(db, request);
      const posts = rows(
        await db.from("posts")
          .select("id,title,body,crop,status,report_count,created_at,published_at")
          .eq("author_id", account.id)
          .order("created_at", { ascending: false })
          .limit(100),
      );
      return json({ posts });
    }

    if (path === "/api/recognition" && method === "GET") {
      return recognitionList(await requireAccount(db, request));
    }

    if (path === "/api/recognition" && method === "POST") {
      const account = await requireAccount(db, request);
      const id = crypto.randomUUID();
      const objectPath = `${OBJECT_PREFIX}${account.id}/${id}`;
      const createdAt = nowIso();
      rows(
        await db.from("recognition_jobs").insert({
          id,
          account_id: account.id,
          object_path: objectPath,
          status: "uploaded",
          note: "照片已登记，等待上传完成。",
          corrected_summary: "",
          created_at: createdAt,
          updated_at: createdAt,
        }).select("id"),
      );
      const signed = await storage.createSignedUploadUrl(objectPath, { upsert: false });
      return json({ id, signedUrl: signed?.signedUrl, maxBytes: MAX_IMAGE_BYTES }, 201);
    }

    const completePath = path.match(/^\/api\/recognition\/([0-9a-f-]{36})\/complete$/);
    if (completePath && isUuid(completePath[1]) && method === "POST") {
      const account = await requireAccount(db, request);
      const found = rows(
        await db.from("recognition_jobs")
          .select("id,status,object_path,note").eq("id", completePath[1])
          .eq("account_id", account.id).limit(1),
      );
      if (!found.length) fail("not_found", 404);
      const job = found[0];
      if (job.status === "needs_review" || job.status === "reviewed") {
        return json({ id: job.id, status: job.status, note: job.note });
      }
      let image;
      try {
        image = await storage.download(job.object_path);
      } catch (error) {
        if (error?.code === "storage_object_not_found") fail("upload_pending", 409);
        fail("storage_unavailable", 503);
      }
      try {
        await verifyImage(image);
      } catch (error) {
        if (error instanceof AppError) throw error;
        fail("storage_unavailable", 503);
      }
      const note = "当前未接入自动识别模型，照片已进入人工复核队列，不会生成猜测结果。";
      await db.from("recognition_jobs").update({
        status: "needs_review",
        note,
        updated_at: nowIso(),
      }).eq("id", job.id).eq("account_id", account.id);
      await notify(
        db,
        account.id,
        "review",
        "照片已进入人工复核",
        "耕云当前未接入自动识别模型，不会伪造识别结果。人工复核完成后会在这里通知你。",
        "/identify",
      ).catch(() => {});
      return json({ id: job.id, status: "needs_review", note });
    }

    if (path === "/api/notifications" && method === "GET") {
      const account = await requireAccount(db, request);
      const list = rows(
        await db.from("notifications")
          .select("id,kind,title,body,target,read_at,created_at")
          .eq("account_id", account.id)
          .order("created_at", { ascending: false })
          .limit(50),
      );
      return json({
        notifications: list.map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          body: item.body,
          target: item.target,
          read: item.read_at != null,
          at: item.created_at,
        })),
      });
    }

    if (path === "/api/notifications/read-all" && method === "POST") {
      const account = await requireAccount(db, request);
      await db.from("notifications").update({ read_at: nowIso() })
        .eq("account_id", account.id);
      return json({ ok: true });
    }

    if (path === "/api/notifications/read" && method === "POST") {
      const account = await requireAccount(db, request);
      const body = await readJson(request);
      const id = body?.id;
      if (!isUuid(id)) fail("invalid_input", 400);
      await db.from("notifications").update({ read_at: nowIso() })
        .eq("id", id).eq("account_id", account.id);
      return json({ ok: true });
    }

    if (path === "/api/admin/check" && method === "POST") {
      await requireAdmin(request, adminCodeHash);
      return json({ ok: true });
    }

    if (path.startsWith("/api/admin/") && !["/api/admin/check"].includes(path)) {
      await requireAdmin(request, adminCodeHash);
      if (path === "/api/admin/queue" && method === "GET") return adminQueue();
      if (path === "/api/admin/moderate" && method === "POST") return moderateContent(request);
      if (path === "/api/admin/review" && method === "POST") return reviewJob(request);
      fail("not_found", 404);
    }

    fail("not_found", 404);
  };
}