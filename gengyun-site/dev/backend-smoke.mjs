import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { application } from "../functions/routes.mjs";

const ADMIN_CODE = "smoke-admin";
const adminCodeHash = createHash("sha256").update(ADMIN_CODE).digest("hex");

function createDb() {
  const tables = {
    accounts: [], favorites: [], history: [], message_reads: [], posts: [],
    comments: [], likes: [], reports: [], notifications: [], recognition_jobs: [],
  };
  const db = {
    from(table) {
      assert.ok(table in tables, `unknown table ${table}`);
      let mode = "read";
      let values;
      let conflict;
      const filters = [];
      const orders = [];
      let columns = null;
      let limit = 1000;
      const query = {
        select(value) { columns = value; return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        order(key, options = {}) { orders.push([key, options.ascending !== false]); return query; },
        limit(value) { limit = value; return query; },
        insert(value) { mode = "insert"; values = value; return query; },
        insertIfAbsent(value, options) {
          mode = "insert";
          values = value;
          conflict = options.onConflict.split(",");
          return query;
        },
        update(value) { mode = "update"; values = value; return query; },
        delete() { mode = "delete"; return query; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            const matches = () => tables[table].filter((row) => filters.every(([key, value]) => row[key] === value));
            let result;
            if (mode === "insert") {
              const duplicate = conflict && tables[table].some((row) => conflict.every((key) => row[key] === values[key]));
              if (duplicate) result = [];
              else {
                const row = { ...values };
                if (!row.id) row.id = randomUUID();
                tables[table].push(row);
                result = [row];
              }
            } else if (mode === "update") {
              result = matches();
              for (const row of result) Object.assign(row, values);
            } else if (mode === "delete") {
              result = matches();
              for (const row of result) tables[table].splice(tables[table].indexOf(row), 1);
            } else {
              result = matches();
            }
            for (const [key, asc] of [...orders].reverse()) {
              result = [...result].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (asc ? 1 : -1));
            }
            result = result.slice(0, limit).map((row) => columns
              ? Object.fromEntries(columns.split(",").map((key) => [key, row[key]]))
              : { ...row });
            return { data: result, error: null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { db, tables };
}

function createStorage() {
  const objects = new Map();
  let lastPath = null;
  return {
    objects,
    get lastPath() { return lastPath; },
    async createSignedUploadUrl(path) { lastPath = path; return { signedUrl: `/upload/${encodeURIComponent(path)}` }; },
    async createSignedUrl(path) { return { signedUrl: `/download/${encodeURIComponent(path)}` }; },
    async download(path) {
      const object = objects.get(path);
      if (!object) {
        const error = new Error("not found");
        error.code = "storage_object_not_found";
        throw error;
      }
      return new Response(object.bytes, { headers: { "content-type": object.type } });
    },
    async remove(paths) {
      for (const path of paths) objects.delete(path);
      return { ok: true };
    },
  };
}

const { db, tables } = createDb();
const storage = createStorage();
const handle = application({ db, storage, adminCodeHash });

function cookieOf(response) {
  const raw = response.headers.get("set-cookie");
  return raw ? raw.split(";")[0].split("=").slice(1).join("=") : null;
}

async function call(method, path, { body, cookie, admin } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = `__Host-gy_session=${cookie}`;
  if (admin) headers["x-gy-admin-code"] = admin;
  if (method !== "GET") headers.origin = "http://127.0.0.1:5173";
  const request = new Request(`http://127.0.0.1:5173/functions/v1/app${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let response;
  try {
    response = await handle(request);
  } catch (error) {
    if (error?.code) return { status: error.status, data: { error: error.code }, cookie: null };
    throw error;
  }
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, cookie: cookieOf(response) };
}

const health = await call("GET", "/api/health");
assert.equal(health.status, 200);

const registered = await call("POST", "/api/auth/register", {
  body: { displayName: "田间测试", crop: "水稻", autoReadAnswers: true },
});
assert.equal(registered.status, 201);
assert.match(registered.data.recoveryCode, /^gy_[A-Za-z0-9_-]{32}$/);
let cookie = registered.cookie;
assert.ok(cookie, "session cookie");
const firstCode = registered.data.recoveryCode;

const session = await call("GET", "/api/auth/session", { cookie });
assert.equal(session.data.authenticated, true);
assert.equal(session.data.account.displayName, "田间测试");

const favorite = await call("POST", "/api/favorites", {
  cookie,
  body: { kind: "herbicide", itemKey: "demo:苯甲丙环唑", title: "苯甲·丙环唑", subtitle: "演示条目" },
});
assert.equal(favorite.status, 200);
const history = await call("POST", "/api/history", {
  cookie,
  body: { clientId: randomUUID(), kind: "label", title: "标签核对", subtitle: "1 项待确认", corrections: ["a"] },
});
assert.equal(history.status, 200);
const read = await call("POST", "/api/reads", { cookie, body: { messageId: "m1" } });
assert.equal(read.status, 200);
const patched = await call("PATCH", "/api/account", {
  cookie,
  body: { crop: "玉米", autoReadAnswers: false },
});
assert.equal(patched.status, 200);
assert.equal(patched.data.account.crop, "玉米");

const synced = await call("GET", "/api/sync", { cookie });
assert.equal(synced.data.favorites.length, 1);
assert.equal(synced.data.history.length, 1);
assert.deepEqual(synced.data.readMessages, ["m1"]);

const post = await call("POST", "/api/community/posts", {
  cookie,
  body: { title: "第一次记录", body: "今天记录了叶鞘和水层，想听听大家怎么整理照片。", crop: "水稻" },
});
assert.equal(post.status, 201);
assert.equal(post.data.status, "published");
const postId = post.data.id;

const second = await call("POST", "/api/auth/register", { body: { displayName: "邻居账号" } });
assert.equal(second.status, 201);
const secondCookie = second.cookie;

const comment = await call("POST", `/api/community/posts/${postId}/comments`, {
  cookie: secondCookie,
  body: { body: "按日期和地块分文件夹，回看会清楚很多。" },
});
assert.equal(comment.status, 201);
assert.equal(comment.data.status, "published");

const like = await call("POST", `/api/community/posts/${postId}/like`, { cookie: secondCookie });
assert.equal(like.data.liked, true);
const community = await call("GET", "/api/community", { cookie: secondCookie });
assert.equal(community.data.posts.length, 1);
assert.equal(community.data.posts[0].comments.length, 1);
assert.equal(community.data.posts[0].liked, true);

const ownReport = await call("POST", `/api/community/posts/${postId}/report`, {
  cookie, body: { reason: "测试自报" },
});
assert.equal(ownReport.status, 400);
const report = await call("POST", `/api/community/posts/${postId}/report`, {
  cookie: secondCookie, body: { reason: "需要复核" },
});
assert.equal(report.data.ok, true);

const intent = await call("POST", "/api/recognition", { cookie });
assert.equal(intent.status, 201);
storage.objects.set(storage.lastPath, {
  bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  type: "image/png",
});
const completed = await call("POST", `/api/recognition/${intent.data.id}/complete`, { cookie });
assert.equal(completed.status, 200);
assert.equal(completed.data.status, "needs_review");
assert.equal(completed.data.modelConfigured, undefined);

const jobList = await call("GET", "/api/recognition", { cookie });
assert.equal(jobList.data.jobs[0].status, "needs_review");
assert.equal(jobList.data.modelConfigured, false);

const flagged = await call("POST", "/api/community/posts", {
  cookie,
  body: { title: "求推荐", body: "这个药兑水 30 毫升每亩够吗？加微信聊。", crop: "水稻" },
});
assert.equal(flagged.status, 201);
assert.equal(flagged.data.status, "pending");

const adminDenied = await call("GET", "/api/admin/queue");
assert.equal(adminDenied.status, 401);
const queue = await call("GET", "/api/admin/queue", { admin: ADMIN_CODE });
assert.equal(queue.status, 200);
assert.equal(queue.data.jobs.length, 1);
assert.equal(queue.data.reports.length, 1);
assert.ok(queue.data.posts.some((item) => item.id === flagged.data.id));

const moderated = await call("POST", "/api/admin/moderate", {
  admin: ADMIN_CODE,
  body: { kind: "post", id: flagged.data.id, decision: "reject", note: "请去掉用量和联系方式。" },
});
assert.equal(moderated.data.status, "rejected");

const reviewed = await call("POST", "/api/admin/review", {
  admin: ADMIN_CODE,
  body: { id: intent.data.id, decision: "reviewed", correctedSummary: "人工复核：叶片局部黄化，建议补充整株照片。" },
});
assert.equal(reviewed.data.status, "reviewed");

const notices = await call("GET", "/api/notifications", { cookie });
assert.ok(notices.data.notifications.some((item) => item.kind === "review"));

const exported = await call("GET", "/api/auth/export", { cookie });
assert.equal(exported.status, 200);
assert.equal(exported.data.favorites.length, 1);
assert.equal(exported.data.recognitionJobs.length, 1);

const restored = await call("POST", "/api/auth/restore", { body: { recoveryCode: firstCode } });
assert.equal(restored.status, 200);
assert.notEqual(restored.data.recoveryCode, firstCode);
const rotatedCookie = restored.cookie;
const oldCookieSession = await call("GET", "/api/auth/session", { cookie });
assert.equal(oldCookieSession.data.authenticated, false);
const newCookieSession = await call("GET", "/api/auth/session", { cookie: rotatedCookie });
assert.equal(newCookieSession.data.authenticated, true);

const deleted = await call("DELETE", "/api/auth/account", { cookie: rotatedCookie });
assert.equal(deleted.status, 200);
assert.equal(tables.accounts.length, 1);
assert.equal(tables.posts.length, 0);
assert.equal(tables.recognition_jobs.length, 0);
const afterDelete = await call("GET", "/api/auth/session", { cookie: rotatedCookie });
assert.equal(afterDelete.data.authenticated, false);

console.log("backend smoke: ok");
console.log(`tables: ${Object.entries(tables).map(([name, rows]) => `${name}=${rows.length}`).join(" ")}`);