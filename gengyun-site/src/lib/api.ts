export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

const BASE = "/functions/v1/app";

export type Account = {
  id: string;
  displayName: string;
  crop: string;
  autoReadAnswers: boolean;
  role: string;
  createdAt: string;
};

export type CloudFavorite = {
  kind: "herbicide" | "weed" | "record";
  key: string;
  title: string;
  subtitle: string;
  savedAt: string;
};

export type CloudHistory = {
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  corrections: string[];
  at: string;
};

export type SyncPayload = {
  account: Account;
  favorites: CloudFavorite[];
  history: CloudHistory[];
  readMessages: string[];
  preferences: { crop: string; autoReadAnswers: boolean };
};

export type ServerComment = {
  id: string;
  author: string;
  text: string;
  at: string;
};

export type ServerPost = {
  id: string;
  author: string;
  crop: string;
  title: string;
  body: string;
  at: string;
  likes: number;
  liked: boolean;
  mine: boolean;
  comments: ServerComment[];
};

export type NotificationItem = {
  id: string;
  kind: string;
  title: string;
  body: string;
  target: string;
  read: boolean;
  at: string;
};

export type RecognitionJob = {
  id: string;
  status: "uploaded" | "needs_review" | "reviewed" | "failed";
  note: string;
  correctedSummary: string;
  createdAt: string;
  updatedAt: string;
};

export type AdminQueue = {
  posts: {
    id: string;
    author_name: string;
    title: string;
    body: string;
    crop: string;
    status: string;
    report_count: number;
    created_at: string;
  }[];
  comments: {
    id: string;
    post_id: string;
    author_name: string;
    body: string;
    created_at: string;
    postTitle: string;
  }[];
  reports: {
    id: string;
    post_id: string;
    reason: string;
    created_at: string;
    postTitle: string;
    postAuthor: string;
    postStatus: string;
  }[];
  jobs: {
    id: string;
    account: string;
    note: string;
    createdAt: string;
    signedUrl: string | null;
  }[];
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError("network_error", 0);
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const code =
      data && typeof data === "object" && "error" in data && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `http_${response.status}`;
    throw new ApiError(code, response.status);
  }
  return data as T;
}

const postJson = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  session: () =>
    request<{ authenticated: boolean; account?: Account }>("/api/auth/session"),
  register: (body: { displayName: string; crop: string; autoReadAnswers: boolean }) =>
    postJson<{ account: Account; recoveryCode: string }>("/api/auth/register", body),
  restore: (recoveryCode: string) =>
    postJson<{ account: Account; recoveryCode: string }>("/api/auth/restore", { recoveryCode }),
  logout: () => postJson<{ ok: true }>("/api/auth/logout", {}),
  deleteAccount: () => request<{ ok: true }>("/api/auth/account", { method: "DELETE" }),
  sync: () => request<SyncPayload>("/api/sync"),
  updateAccount: (patch: Partial<Pick<Account, "displayName" | "crop" | "autoReadAnswers">>) =>
    request<{ account: Account }>("/api/account", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  addFavorite: (favorite: Omit<CloudFavorite, "savedAt">) =>
    postJson<{ ok: true }>("/api/favorites", {
      kind: favorite.kind,
      itemKey: favorite.key,
      title: favorite.title,
      subtitle: favorite.subtitle,
    }),
  removeFavorite: (favorite: Pick<CloudFavorite, "kind" | "key">) =>
    postJson<{ ok: true }>("/api/favorites/remove", {
      kind: favorite.kind,
      itemKey: favorite.key,
    }),
  addHistory: (entry: Omit<CloudHistory, "at">) =>
    postJson<{ ok: true }>("/api/history", {
      clientId: entry.id,
      kind: entry.kind,
      title: entry.title,
      subtitle: entry.subtitle,
      corrections: entry.corrections,
    }),
  clearHistory: () => postJson<{ ok: true }>("/api/history/clear", {}),
  markRead: (messageId: string) => postJson<{ ok: true }>("/api/reads", { messageId }),
  markAllRead: (messageIds: string[]) =>
    postJson<{ ok: true }>("/api/reads/all", { messageIds }),
  community: () => request<{ posts: ServerPost[] }>("/api/community"),
  createPost: (body: { title?: string; body: string; crop: string }) =>
    postJson<{ id: string; status: string; reviewReason: string | null }>(
      "/api/community/posts",
      body,
    ),
  createComment: (postId: string, body: string) =>
    postJson<{ id: string; status: string; reviewReason: string | null }>(
      `/api/community/posts/${postId}/comments`,
      { body },
    ),
  toggleLike: (postId: string) =>
    postJson<{ liked: boolean }>(`/api/community/posts/${postId}/like`, {}),
  reportPost: (postId: string, reason: string) =>
    postJson<{ ok: true; duplicate: boolean }>(`/api/community/posts/${postId}/report`, {
      reason,
    }),
  myPosts: () =>
    request<{ posts: { id: string; title: string; status: string; report_count: number; created_at: string }[] }>(
      "/api/community/mine",
    ),
  notifications: () => request<{ notifications: NotificationItem[] }>("/api/notifications"),
  readNotification: (id: string) =>
    postJson<{ ok: true }>("/api/notifications/read", { id }),
  readAllNotifications: () =>
    postJson<{ ok: true }>("/api/notifications/read-all", {}),
  recognitionJobs: () =>
    request<{ jobs: RecognitionJob[]; modelConfigured: boolean }>("/api/recognition"),
  recognitionIntent: () =>
    postJson<{ id: string; signedUrl: string; maxBytes: number }>("/api/recognition", {}),
  recognitionComplete: (id: string) =>
    postJson<{ id: string; status: string; note: string }>(
      `/api/recognition/${id}/complete`,
      {},
    ),
  adminCheck: (code: string) =>
    request<{ ok: true }>("/api/admin/check", {
      method: "POST",
      headers: { "x-gy-admin-code": code },
    }),
  adminQueue: (code: string) =>
    request<AdminQueue>("/api/admin/queue", { headers: { "x-gy-admin-code": code } }),
  adminModerate: (
    code: string,
    body: { kind: "post" | "comment"; id: string; decision: "publish" | "reject"; note?: string },
  ) =>
    request<{ ok: true; status: string }>("/api/admin/moderate", {
      method: "POST",
      headers: { "x-gy-admin-code": code },
      body: JSON.stringify(body),
    }),
  adminReview: (
    code: string,
    body: { id: string; decision: "reviewed" | "failed"; correctedSummary?: string; note?: string },
  ) =>
    request<{ ok: true; status: string }>("/api/admin/review", {
      method: "POST",
      headers: { "x-gy-admin-code": code },
      body: JSON.stringify(body),
    }),
};

export async function downloadExport() {
  let response: Response;
  try {
    response = await fetch(`${BASE}/api/auth/export`, {
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError("network_error", 0);
  }
  if (!response.ok) {
    let code = `http_${response.status}`;
    try {
      const data = (await response.json()) as { error?: string };
      if (typeof data.error === "string") code = data.error;
    } catch {
      // Keep the HTTP fallback.
    }
    throw new ApiError(code, response.status);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return {
    blob: await response.blob(),
    filename: match?.[1] ?? "gengyun-export.json",
  };
}

export async function uploadRecognitionFile(file: File) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new ApiError("invalid_upload", 400);
  }
  if (file.size > 5 * 1024 * 1024 || file.size === 0) {
    throw new ApiError("invalid_upload", 400);
  }
  const intent = await api.recognitionIntent();
  let uploaded: Response;
  try {
    uploaded = await fetch(intent.signedUrl, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": file.type },
      body: file,
    });
  } catch {
    throw new ApiError("network_error", 0);
  }
  if (!uploaded.ok) throw new ApiError("upload_failed", uploaded.status);
  return api.recognitionComplete(intent.id);
}

const ERROR_TEXT: Record<string, string> = {
  network_error: "网络连接失败，请检查网络后重试。",
  login_required: "请先在「我的」创建或恢复云端账号。",
  invalid_recovery_code: "恢复码不正确，请检查后再试。",
  restore_conflict: "恢复码刚被更新，请使用最新恢复码重试。",
  origin_forbidden: "请求来源校验失败，请刷新页面后重试。",
  account_unavailable: "账号服务暂时不可用，请稍后再试。",
  database_unavailable: "云端数据暂时不可用，请稍后再试。",
  storage_unavailable: "图片存储暂时不可用，请稍后再试。",
  storage_cleanup_failed: "照片清理失败，账号尚未注销；请稍后重试。",
  invalid_upload: "只接受 5MB 以内的 PNG、JPEG 或 WebP 图片。",
  upload_pending: "照片还没有上传完成，请稍后再试。",
  upload_failed: "照片上传失败，请重新选择图片。",
  admin_required: "管理码不正确。",
  cannot_report_own_post: "不能举报自己的帖子。",
  post_not_published: "帖子还在复核中，暂时不能评论。",
  payload_too_large: "内容过长，请精简后重试。",
  invalid_input: "提交内容不符合要求，请检查后再试。",
  not_found: "目标内容已不存在。",
};

export function apiErrorText(error: unknown) {
  if (error instanceof ApiError) {
    return ERROR_TEXT[error.code] ?? `请求失败（${error.code}）。`;
  }
  return "请求未完成，请稍后再试。";
}