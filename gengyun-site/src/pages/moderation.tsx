import * as React from "react";
import {
  ArrowRight,
  Check,
  ClipboardCheck,
  ImageIcon,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { api, apiErrorText, type AdminQueue } from "@/lib/api";
import { cn } from "@/lib/utils";

const CODE_KEY = "gy.admin.code";

function timeText(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function ModerationPage() {
  const [code, setCode] = React.useState(() => {
    try {
      return window.sessionStorage.getItem(CODE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [authed, setAuthed] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [queue, setQueue] = React.useState<AdminQueue | null>(null);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [busyId, setBusyId] = React.useState("");
  const [selectedJob, setSelectedJob] = React.useState<AdminQueue["jobs"][number] | null>(null);
  const [summary, setSummary] = React.useState("");
  const [reviewNote, setReviewNote] = React.useState("");

  const load = React.useCallback(async (adminCode: string) => {
    const data = await api.adminQueue(adminCode);
    setQueue(data);
    setAuthed(true);
  }, []);

  const connect = React.useCallback(
    async (candidate: string) => {
      if (!candidate.trim()) return;
      setChecking(true);
      setError("");
      try {
        await api.adminCheck(candidate.trim());
        try {
          window.sessionStorage.setItem(CODE_KEY, candidate.trim());
        } catch {
          // Session storage can be unavailable; the tab still works in memory.
        }
        setCode(candidate.trim());
        await load(candidate.trim());
        setNotice("");
      } catch (caught) {
        setAuthed(false);
        setQueue(null);
        setError(apiErrorText(caught));
      } finally {
        setChecking(false);
      }
    },
    [load],
  );

  React.useEffect(() => {
    if (code) void connect(code);
    // Only try the stored code once on entry.
  }, []);

  const refresh = async () => {
    if (!authed) return;
    setError("");
    try {
      await load(code);
      setNotice("队列已刷新。");
    } catch (caught) {
      setError(apiErrorText(caught));
    }
  };

  const moderate = async (
    kind: "post" | "comment",
    id: string,
    decision: "publish" | "reject",
  ) => {
    setBusyId(id);
    setError("");
    setNotice("");
    try {
      await api.adminModerate(code, { kind, id, decision });
      setNotice(decision === "publish" ? "已通过并公开。" : "已拒绝，作者会收到站内通知。");
      await load(code);
    } catch (caught) {
      setError(apiErrorText(caught));
    } finally {
      setBusyId("");
    }
  };

  const review = async (decision: "reviewed" | "failed") => {
    if (!selectedJob) return;
    if (decision === "reviewed" && summary.trim().length < 2) {
      setError("人工复核摘要至少写 2 个字，说明照片里能确认什么、不能确认什么。");
      return;
    }
    setBusyId(selectedJob.id);
    setError("");
    setNotice("");
    try {
      await api.adminReview(
        code,
        decision === "reviewed"
          ? { id: selectedJob.id, decision, correctedSummary: summary.trim() }
          : {
              id: selectedJob.id,
              decision,
              note: reviewNote.trim() || "照片无法辨认，请重新拍摄完整的包装正面。",
            },
      );
      setNotice(decision === "reviewed" ? "复核摘要已保存，用户会收到通知。" : "已标记为无法复核。");
      setSelectedJob(null);
      setSummary("");
      setReviewNote("");
      await load(code);
    } catch (caught) {
      setError(apiErrorText(caught));
    } finally {
      setBusyId("");
    }
  };

  if (!authed) {
    return (
      <div className="gy-shell">
        <header className="max-w-[64ch]">
          <span className="gy-kicker">站点管理 · REVIEW CONSOLE</span>
          <h1 className="mt-2 text-[24px] font-[650] leading-tight tracking-[-0.8px] sm:text-[29px] sm:tracking-[-1px]">
            审核与人工复核
          </h1>
          <p className="mt-2 text-[12px] leading-[1.9] text-[var(--site-muted)]">
            社区发帖、评论与照片复核共用一个管理码。管理码不写入代码仓库或公开页面，
            只保存在当前标签页的 sessionStorage；关闭标签页即清除。
          </p>
        </header>

        <section className="gy-card mt-6 max-w-[560px] p-5 sm:p-6">
          <h2 className="flex items-center gap-2 text-[16px] font-[650]">
            <KeyRound className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
            输入管理码
          </h2>
          <form
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void connect(code);
            }}
          >
            <label htmlFor="admin-code" className="sr-only">
              管理码
            </label>
            <input
              id="admin-code"
              type="password"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              className="h-10 min-w-0 flex-1 rounded-[9px] border border-[var(--site-border)] bg-white px-3 text-[12px]"
              placeholder="管理码"
            />
            <button
              type="submit"
              disabled={checking || !code.trim()}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full bg-[var(--gy-green)] px-5 text-[12px] font-semibold text-white disabled:opacity-50"
            >
              {checking ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <ShieldCheck className="size-3.5" aria-hidden="true" />
              )}
              进入队列
            </button>
          </form>
          {error && (
            <p role="alert" className="mt-3 text-[11px] leading-5 text-[#8a4b3d]">
              {error}
            </p>
          )}
          <p className="mt-3 text-[10px] leading-[1.8] text-[var(--site-muted)]">
            审核原则：涉及用量、配比、药效承诺、联系方式或交易信息的内容不公开；
            照片复核只记录「能看到什么」，不推断药效，不提供施用建议。
          </p>
        </section>
      </div>
    );
  }

  const pendingPosts = queue?.posts ?? [];
  const pendingComments = queue?.comments ?? [];
  const reports = queue?.reports ?? [];
  const jobs = queue?.jobs ?? [];

  return (
    <div className="gy-shell">
      <header className="max-w-[70ch]">
        <span className="gy-kicker">站点管理 · REVIEW CONSOLE</span>
        <h1 className="mt-2 text-[24px] font-[650] leading-tight tracking-[-0.8px] sm:text-[29px] sm:tracking-[-1px]">
          审核与人工复核
        </h1>
        <p className="mt-2 text-[12px] leading-[1.9] text-[var(--site-muted)]">
          管理码只保存在当前标签页。所有操作都会给作者发送站内消息；拒绝时请写清边界原因。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full border border-[var(--site-border)] bg-white px-4 text-[11px]"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            刷新队列
          </button>
          <button
            type="button"
            onClick={() => {
              try {
                window.sessionStorage.removeItem(CODE_KEY);
              } catch {
                // Ignore storage failures.
              }
              setAuthed(false);
              setQueue(null);
              setCode("");
              setNotice("");
            }}
            className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full border border-[var(--site-border)] bg-white px-4 text-[11px] text-[var(--site-muted)]"
          >
            <X className="size-3.5" aria-hidden="true" />
            退出管理
          </button>
        </div>
      </header>

      {error && (
        <p role="alert" className="mt-4 rounded-[10px] border border-[#ead6ae] bg-[var(--gy-amber-soft)] px-4 py-3 text-[12px] text-[#7c4a10]">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-4 rounded-[10px] border border-[var(--gy-green)]/30 bg-[var(--gy-green-soft)] px-4 py-3 text-[12px] text-[var(--gy-green-deep)]">
          {notice}
        </p>
      )}

      <section className="gy-card mt-5 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--site-border)] px-5 py-4">
          <h2 className="text-[16px] font-[650]">待复核帖子 · {pendingPosts.length}</h2>
          <span className="gy-pill gy-pill--plain">先审后发</span>
        </div>
        {pendingPosts.length === 0 ? (
          <p className="px-5 py-6 text-[12px] text-[var(--site-muted)]">没有待复核帖子。</p>
        ) : (
          <ul className="divide-y divide-[var(--site-border)]">
            {pendingPosts.map((post) => (
              <li key={post.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--site-muted)]">
                  <span className="gy-pill gy-pill--plain min-h-[22px] px-2 text-[9px]">
                    {post.crop}
                  </span>
                  <span>{post.author_name}</span>
                  <span>· {timeText(post.created_at)}</span>
                  {post.report_count > 0 && (
                    <span className="text-[#8a4b3d]">· {post.report_count} 次举报</span>
                  )}
                </div>
                <h3 className="mt-2 text-[14px] font-semibold">{post.title}</h3>
                <p className="mt-1 whitespace-pre-line text-[12px] leading-6 text-[#4b5d52]">
                  {post.body}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busyId === post.id}
                    onClick={() => void moderate("post", post.id, "publish")}
                    className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-[var(--gy-green)] px-4 text-[11px] font-semibold text-white disabled:opacity-50"
                  >
                    <Check className="size-3.5" aria-hidden="true" />
                    通过并公开
                  </button>
                  <button
                    type="button"
                    disabled={busyId === post.id}
                    onClick={() => void moderate("post", post.id, "reject")}
                    className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-[#e2b6ad] bg-white px-4 text-[11px] text-[#8a4b3d] disabled:opacity-50"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    拒绝
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="gy-card mt-5 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--site-border)] px-5 py-4">
          <h2 className="text-[16px] font-[650]">待复核评论 · {pendingComments.length}</h2>
        </div>
        {pendingComments.length === 0 ? (
          <p className="px-5 py-6 text-[12px] text-[var(--site-muted)]">没有待复核评论。</p>
        ) : (
          <ul className="divide-y divide-[var(--site-border)]">
            {pendingComments.map((comment) => (
              <li key={comment.id} className="px-5 py-4">
                <p className="text-[10px] text-[var(--site-muted)]">
                  {comment.author_name} · 回复《{comment.postTitle}》 · {timeText(comment.created_at)}
                </p>
                <p className="mt-1 whitespace-pre-line text-[12px] leading-6 text-[#4b5d52]">
                  {comment.body}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busyId === comment.id}
                    onClick={() => void moderate("comment", comment.id, "publish")}
                    className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-[var(--gy-green)] px-4 text-[11px] font-semibold text-white disabled:opacity-50"
                  >
                    <Check className="size-3.5" aria-hidden="true" />
                    通过
                  </button>
                  <button
                    type="button"
                    disabled={busyId === comment.id}
                    onClick={() => void moderate("comment", comment.id, "reject")}
                    className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-[#e2b6ad] bg-white px-4 text-[11px] text-[#8a4b3d] disabled:opacity-50"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    拒绝
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="gy-card mt-5 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--site-border)] px-5 py-4">
          <h2 className="text-[16px] font-[650]">标签照片人工复核 · {jobs.length}</h2>
          <span className="gy-pill gy-pill--plain">未接入自动识别模型</span>
        </div>
        {jobs.length === 0 ? (
          <p className="px-5 py-6 text-[12px] text-[var(--site-muted)]">没有待复核照片。</p>
        ) : (
          <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <ul className="grid content-start gap-2">
              {jobs.map((job) => (
                <li key={job.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedJob(job);
                      setSummary("");
                      setReviewNote("");
                      setError("");
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-[10px] border p-3 text-left transition",
                      selectedJob?.id === job.id
                        ? "border-[var(--gy-green)] bg-[var(--gy-green-soft)]"
                        : "border-[var(--site-border)] bg-[var(--gy-cream)] hover:border-[#c9d6c4]",
                    )}
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-[8px] bg-white text-[var(--gy-green)]">
                      <ImageIcon className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-[11px] font-semibold">{job.account}</strong>
                      <small className="block text-[10px] text-[var(--site-muted)]">
                        {timeText(job.createdAt)} · {job.signedUrl ? "照片可查看" : "照片链接不可用"}
                      </small>
                    </span>
                    <ArrowRight className="size-3.5 shrink-0 text-[#b4bfb4]" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="rounded-[12px] border border-[var(--site-border)] bg-white p-3">
              {selectedJob ? (
                <>
                  {selectedJob.signedUrl ? (
                    <a href={selectedJob.signedUrl} target="_blank" rel="noreferrer">
                      <img
                        src={selectedJob.signedUrl}
                        alt={`${selectedJob.account} 提交的标签照片`}
                        className="aspect-[4/3] w-full rounded-[8px] object-cover"
                      />
                    </a>
                  ) : (
                    <p className="rounded-[8px] bg-[var(--gy-cream)] p-6 text-center text-[11px] text-[var(--site-muted)]">
                      照片签名链接生成失败，请刷新后重试，或检查存储服务。
                    </p>
                  )}
                  <label htmlFor="review-summary" className="mt-3 block text-[11px] font-medium">
                    人工复核摘要（用户可见，至少 2 个字）
                  </label>
                  <textarea
                    id="review-summary"
                    value={summary}
                    onChange={(event) => setSummary(event.target.value)}
                    rows={3}
                    maxLength={500}
                    placeholder="只写照片上能确认的信息，例如「可见药名与剂型；登记证号末位模糊，无法确认」"
                    className="gy-input mt-1 w-full resize-none py-2 text-[12px] leading-5"
                  />
                  <label htmlFor="review-note" className="mt-2 block text-[11px] font-medium">
                    无法复核时给用户的说明（可选）
                  </label>
                  <input
                    id="review-note"
                    value={reviewNote}
                    onChange={(event) => setReviewNote(event.target.value)}
                    maxLength={200}
                    className="gy-input mt-1 h-9 w-full text-[12px]"
                    placeholder="例如：照片反光，请重拍包装正面"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busyId === selectedJob.id}
                      onClick={() => void review("reviewed")}
                      className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full bg-[var(--gy-green)] px-4 text-[11px] font-semibold text-white disabled:opacity-50"
                    >
                      <ClipboardCheck className="size-3.5" aria-hidden="true" />
                      保存人工摘要
                    </button>
                    <button
                      type="button"
                      disabled={busyId === selectedJob.id}
                      onClick={() => void review("failed")}
                      className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full border border-[#e2b6ad] bg-white px-4 text-[11px] text-[#8a4b3d] disabled:opacity-50"
                    >
                      无法复核
                    </button>
                  </div>
                  <p className="mt-2 text-[10px] leading-5 text-[var(--site-muted)]">
                    摘要会直接展示给用户，不提供用量、药效或施用方案。不要照抄无法确认的字段。
                  </p>
                </>
              ) : (
                <p className="flex h-full min-h-[180px] items-center justify-center px-4 text-center text-[11px] leading-6 text-[var(--site-muted)]">
                  选择左侧一张照片查看，并填写人工复核摘要。
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="gy-card mt-5 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--site-border)] px-5 py-4">
          <h2 className="text-[16px] font-[650]">最近的举报 · {reports.length}</h2>
        </div>
        {reports.length === 0 ? (
          <p className="px-5 py-6 text-[12px] text-[var(--site-muted)]">没有举报记录。</p>
        ) : (
          <ul className="divide-y divide-[var(--site-border)]">
            {reports.map((report) => (
              <li key={report.id} className="flex flex-wrap items-center gap-2 px-5 py-3 text-[11px]">
                <strong className="font-semibold">{report.postTitle}</strong>
                <span className="text-[var(--site-muted)]">作者：{report.postAuthor || "未知"}</span>
                <span className="text-[var(--site-muted)]">状态：{report.postStatus}</span>
                <span className="text-[#8a4b3d]">原因：{report.reason}</span>
                <span className="ml-auto text-[10px] text-[var(--site-muted)]">
                  {timeText(report.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-4 text-[10px] leading-6 text-[var(--site-muted)]">
        管理码只以哈希形式存在服务端；本页不会把管理码写入日志或导出文件。复核照片的签名链接 5 分钟后失效。
      </p>
    </div>
  );
}