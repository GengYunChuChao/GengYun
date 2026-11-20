import * as React from "react";
import {
  ArrowUpRight,
  Cloud,
  Flag,
  Heart,
  Leaf,
  Loader2,
  MessageCircle,
  Send,
  Sprout,
  Users,
  X,
} from "lucide-react";
import { Link } from "@/lib/router";
import { api, apiErrorText, type ServerPost } from "@/lib/api";
import { useAccount } from "@/lib/account";
import {
  addComment,
  addPost,
  getLikedPosts,
  getPosts,
  getPreferences,
  toggleLike,
  useStoreVersion,
  type Post,
} from "@/lib/store";
import { cn } from "@/lib/utils";

const TOPICS = ["# 田边的第一株草", "# 一张清晰的标签", "# 我的农事记录"];
const CROPS = ["水稻", "玉米", "小麦", "油菜", "其他"];
const REPORT_REASONS = ["与农业无关", "疑似广告或联系方式", "涉及用量或药效承诺", "其他需要复核"];

function timeText(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const STATUS_TEXT: Record<string, string> = {
  pending: "待复核",
  published: "已公开",
  rejected: "未通过",
};

function LocalPostCard({
  post,
  liked,
  onLike,
}: {
  post: Post;
  liked: boolean;
  onLike: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [reply, setReply] = React.useState("");
  const [notice, setNotice] = React.useState("");

  return (
    <article className="rounded-[16px] border border-[var(--site-border)] bg-white p-[19px]">
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#e5ebdd] text-[13px] font-semibold text-[#5d7051]">
          {post.author.slice(0, 1)}
        </span>
        <div className="min-w-0">
          <strong className="block text-[12px] font-semibold">{post.author}</strong>
          <small className="text-[10px] text-[#9ca797]">
            {post.crop} · {timeText(post.at)}
            {post.seeded ? " · 虚构示例" : " · 本机发布"}
          </small>
        </div>
      </div>

      <p className="mt-3 whitespace-pre-line text-[13px] leading-[1.9] text-[#3f5148]">{post.text}</p>

      {post.seeded && post.crop === "水稻" && (
        <div className="mt-3 flex h-[130px] items-center justify-center rounded-[12px] bg-[#e9f0df] text-[#68815c]">
          <Sprout className="size-9" aria-hidden="true" />
          <span className="ml-3 text-[10px] tracking-[1.6px]">FIELD NOTE / 示例插图</span>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] text-[#a7b1a4]">
        <button
          type="button"
          onClick={onLike}
          aria-pressed={liked}
          className={cn(
            "inline-flex min-h-[32px] items-center gap-1 rounded-full px-2 transition hover:bg-[#f7f9f4]",
            liked && "text-[var(--gy-danger)]",
          )}
        >
          <Heart className="size-3.5" fill={liked ? "currentColor" : "none"} aria-hidden="true" />
          {post.baseLikes + (liked ? 1 : 0)} 次喜欢
        </button>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="inline-flex min-h-[32px] items-center gap-1 rounded-full px-2 transition hover:bg-[#f7f9f4]"
        >
          <MessageCircle className="size-3.5" aria-hidden="true" />
          {post.comments.length} 条讨论
        </button>
        <span>· 本机演示内容</span>
      </div>

      {open && (
        <div className="mt-3 rounded-[12px] bg-[#f7f9f4] p-3">
          {post.comments.length > 0 ? (
            <ul className="grid gap-2.5">
              {post.comments.map((comment) => (
                <li key={comment.id} className="text-[11px] leading-6 text-[#4b5d52]">
                  <strong className="mr-1.5 font-semibold text-[#315534]">{comment.author}：</strong>
                  {comment.text}
                  <span className="ml-1.5 text-[9px] text-[#a7b1a4]">{timeText(comment.at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-[var(--site-muted)]">还没有讨论，写下第一条。</p>
          )}
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const ok = addComment(post.id, reply);
              setNotice(ok ? "已写在本次讨论里（仅本机可见）。" : "先写点内容再发送。");
              if (ok) setReply("");
            }}
          >
            <label htmlFor={`reply-${post.id}`} className="sr-only">
              回复这条观察
            </label>
            <input
              id={`reply-${post.id}`}
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              placeholder="写一句观察或追问…"
              maxLength={300}
              className="gy-input h-9 flex-1 text-[12px]"
            />
            <button
              type="submit"
              aria-label="发送回复"
              className="grid size-9 shrink-0 place-items-center rounded-[8px] bg-[var(--gy-green)] text-white hover:bg-[var(--gy-green-deep)]"
            >
              <Send className="size-3.5" aria-hidden="true" />
            </button>
          </form>
          {notice && (
            <p role="status" className="mt-2 text-[10px] text-[var(--site-muted)]">
              {notice}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function ServerPostCard({
  post,
  signedIn,
  onLike,
  onComment,
  onReport,
}: {
  post: ServerPost;
  signedIn: boolean;
  onLike: () => void;
  onComment: (text: string) => Promise<string>;
  onReport: (reason: string) => Promise<string>;
}) {
  const [open, setOpen] = React.useState(false);
  const [reply, setReply] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [reportOpen, setReportOpen] = React.useState(false);
  const [reason, setReason] = React.useState(REPORT_REASONS[0]);

  return (
    <article className="rounded-[16px] border border-[var(--site-border)] bg-white p-[19px]">
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#e5ebdd] text-[13px] font-semibold text-[#5d7051]">
          {post.author.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <strong className="flex flex-wrap items-center gap-1.5 text-[12px] font-semibold">
            {post.author}
            {post.mine && (
              <span className="rounded-[4px] bg-[#eff5e9] px-1.5 py-[2px] text-[8px] font-normal text-[#6d8662]">
                我的
              </span>
            )}
          </strong>
          <small className="text-[10px] text-[#9ca797]">
            {post.crop} · {timeText(post.at)} · 云端社区
          </small>
        </div>
        <Cloud className="size-3.5 shrink-0 text-[#b4bfb4]" aria-hidden="true" />
      </div>

      <h3 className="mt-3 text-[14px] font-semibold leading-6">{post.title}</h3>
      <p className="mt-1 whitespace-pre-line text-[13px] leading-[1.9] text-[#3f5148]">{post.body}</p>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] text-[#a7b1a4]">
        <button
          type="button"
          onClick={onLike}
          disabled={!signedIn}
          aria-pressed={post.liked}
          title={signedIn ? "喜欢这条观察" : "登录后可点赞"}
          className={cn(
            "inline-flex min-h-[32px] items-center gap-1 rounded-full px-2 transition hover:bg-[#f7f9f4] disabled:cursor-not-allowed disabled:opacity-60",
            post.liked && "text-[var(--gy-danger)]",
          )}
        >
          <Heart className="size-3.5" fill={post.liked ? "currentColor" : "none"} aria-hidden="true" />
          {post.likes} 次喜欢
        </button>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="inline-flex min-h-[32px] items-center gap-1 rounded-full px-2 transition hover:bg-[#f7f9f4]"
        >
          <MessageCircle className="size-3.5" aria-hidden="true" />
          {post.comments.length} 条讨论
        </button>
        {!post.mine && signedIn && (
          <button
            type="button"
            onClick={() => setReportOpen((value) => !value)}
            aria-expanded={reportOpen}
            className="inline-flex min-h-[32px] items-center gap-1 rounded-full px-2 transition hover:bg-[#f7f9f4]"
          >
            <Flag className="size-3.5" aria-hidden="true" />
            举报
          </button>
        )}
      </div>

      {!signedIn && (
        <p className="mt-2 text-[10px] text-[var(--site-muted)]">
          登录云端账号后可点赞、评论和举报。
        </p>
      )}

      {reportOpen && (
        <div className="mt-2 rounded-[12px] border border-[#ead6ae] bg-[#fdf8ec] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`reason-${post.id}`} className="text-[11px] text-[#7c4a10]">
              举报原因
            </label>
            <select
              id={`reason-${post.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="h-8 rounded-[8px] border border-[#e6d6ab] bg-white px-2 text-[11px]"
            >
              {REPORT_REASONS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setNotice(await onReport(reason));
                setBusy(false);
                setReportOpen(false);
              }}
              className="ml-auto inline-flex min-h-[32px] items-center gap-1 rounded-full border border-[#e6d6ab] bg-white px-3 text-[11px] text-[#7c4a10] disabled:opacity-50"
            >
              提交举报
            </button>
          </div>
          <p className="mt-2 text-[10px] leading-5 text-[#8a7034]">
            举报进入人工队列；被多次举报的帖子会先下线复核。请只举报确实需要复核的内容。
          </p>
        </div>
      )}

      {open && (
        <div className="mt-3 rounded-[12px] bg-[#f7f9f4] p-3">
          {post.comments.length > 0 ? (
            <ul className="grid gap-2.5">
              {post.comments.map((comment) => (
                <li key={comment.id} className="text-[11px] leading-6 text-[#4b5d52]">
                  <strong className="mr-1.5 font-semibold text-[#315534]">{comment.author}：</strong>
                  {comment.text}
                  <span className="ml-1.5 text-[9px] text-[#a7b1a4]">{timeText(comment.at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-[var(--site-muted)]">还没有讨论，写下第一条。</p>
          )}
          {signedIn ? (
            <form
              className="mt-3 flex gap-2"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!reply.trim() || busy) return;
                setBusy(true);
                setNotice(await onComment(reply));
                setBusy(false);
                setReply("");
              }}
            >
              <label htmlFor={`reply-${post.id}`} className="sr-only">
                回复这条观察
              </label>
              <input
                id={`reply-${post.id}`}
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder="写一句观察或追问…"
                maxLength={400}
                className="gy-input h-9 flex-1 text-[12px]"
              />
              <button
                type="submit"
                disabled={busy || !reply.trim()}
                aria-label="发送回复"
                className="grid size-9 shrink-0 place-items-center rounded-[8px] bg-[var(--gy-green)] text-white hover:bg-[var(--gy-green-deep)] disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="size-3.5" aria-hidden="true" />
                )}
              </button>
            </form>
          ) : (
            <Link
              to="/profile"
              className="mt-3 inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-[var(--gy-green)] px-4 text-[11px] font-semibold text-white"
            >
              登录后参与讨论
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          )}
          {notice && (
            <p role="status" className="mt-2 text-[10px] leading-5 text-[var(--site-muted)]">
              {notice}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

export function CommunityPage() {
  useStoreVersion();
  const account = useAccount();
  const preferences = getPreferences();
  const signedIn = Boolean(account.account);
  const [filter, setFilter] = React.useState<"全部" | "同作物">("全部");
  const [composing, setComposing] = React.useState(false);
  const [text, setText] = React.useState("");
  const [crop, setCrop] = React.useState(preferences.crop === "其他" ? "其他" : preferences.crop);
  const [notice, setNotice] = React.useState("");
  const [feed, setFeed] = React.useState<ServerPost[] | null>(null);
  const [feedError, setFeedError] = React.useState("");
  const [mine, setMine] = React.useState<
    { id: string; title: string; status: string; report_count: number; created_at: string }[]
  >([]);
  const [sending, setSending] = React.useState(false);

  const accountId = account.account?.id ?? null;

  const loadFeed = React.useCallback(async () => {
    try {
      const data = await api.community();
      setFeed(data.posts);
      setFeedError("");
      if (accountId) {
        try {
          const own = await api.myPosts();
          setMine(own.posts);
        } catch {
          setMine([]);
        }
      } else {
        setMine([]);
      }
    } catch (error) {
      setFeedError(apiErrorText(error));
      setFeed(null);
    }
  }, [accountId]);

  React.useEffect(() => {
    if (!account.ready) return;
    void loadFeed();
  }, [account.ready, loadFeed]);

  const localMode = Boolean(feedError);
  const localPosts = getPosts();
  const localLiked = getLikedPosts();
  const serverPosts = feed ?? [];
  const visibleServer =
    filter === "同作物"
      ? serverPosts.filter((post) => post.crop === preferences.crop)
      : serverPosts;
  const visibleLocal =
    filter === "同作物"
      ? localPosts.filter((post) => post.crop === preferences.crop)
      : localPosts;

  const publishLocal = () => {
    const post = addPost(text, crop);
    if (!post) {
      setNotice("先写下这次观察，再点发布。");
      return;
    }
    setText("");
    setComposing(false);
    setNotice("已发布到本机列表。社区服务当前不可用，这条内容不会展示给其他人。");
  };

  const publishServer = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setNotice("");
    try {
      const result = await api.createPost({ body: text, crop });
      setText("");
      setComposing(false);
      if (result.status === "published") {
        setNotice("已发布到公共社区。");
      } else {
        setNotice(
          `已提交，内容含${result.reviewReason ?? "需要复核的信息"}，通过人工复核后才会公开。`,
        );
      }
      await loadFeed();
    } catch (error) {
      setNotice(apiErrorText(error));
    } finally {
      setSending(false);
    }
  };

  const likeServer = async (post: ServerPost) => {
    if (!signedIn) return;
    try {
      const result = await api.toggleLike(post.id);
      setFeed((current) =>
        current
          ? current.map((item) =>
              item.id === post.id
                ? { ...item, liked: result.liked, likes: Math.max(0, item.likes + (result.liked ? 1 : -1)) }
                : item,
            )
          : current,
      );
    } catch (error) {
      setNotice(apiErrorText(error));
    }
  };

  const commentServer = async (postId: string, body: string) => {
    try {
      const result = await api.createComment(postId, body);
      if (result.status === "published") {
        await loadFeed();
        return "评论已公开。";
      }
      return `评论已提交，含${result.reviewReason ?? "需要复核的信息"}，通过复核后才会公开。`;
    } catch (error) {
      return apiErrorText(error);
    }
  };

  const reportServer = async (postId: string, reason: string) => {
    try {
      const result = await api.reportPost(postId, reason);
      if (result.duplicate) return "你已经举报过这条内容，人工队列会统一处理。";
      await loadFeed();
      return "举报已进入人工复核队列。";
    } catch (error) {
      return apiErrorText(error);
    }
  };

  return (
    <div>
      <header className="max-w-[68ch]">
        <span className="gy-kicker">社区 · FIELD COMMUNITY</span>
        <h1 className="mt-2 text-[24px] font-[650] leading-tight tracking-[-0.8px] sm:text-[29px] sm:tracking-[-1px]">
          田间的发现，值得分享
        </h1>
        <p className="mt-2 text-[12px] leading-[1.9] text-[var(--site-muted)]">
          记录日常观察，和更多耕耘者交流。公开内容先审后发；涉及联系方式、用量或药效承诺的表述会进入人工复核。
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--site-muted)]">
          {signedIn ? (
            <span className="gy-pill gy-pill--plain">
              <Cloud className="mr-1 size-3" aria-hidden="true" />
              已登录：{account.account?.displayName}
            </span>
          ) : (
            <span className="gy-pill gy-pill--plain">只读浏览 · 登录后可互动</span>
          )}
          {localMode && <span className="gy-pill gy-pill--amber">社区服务未连接，当前为本机演示</span>}
        </p>
      </header>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {(["全部", "同作物"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setFilter(item)}
              className={cn(
                "h-8 rounded-full border px-3.5 text-[11px] transition",
                filter === item
                  ? "border-[var(--gy-green)] bg-[var(--gy-green-soft)] font-semibold text-[#315534]"
                  : "border-[var(--site-border)] bg-white text-[var(--site-muted)] hover:border-[#c9d6c4]",
              )}
            >
              {item}
              {item === "同作物" ? ` · ${preferences.crop}` : ""}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setComposing((value) => !value)}
          aria-expanded={composing}
          className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-[var(--gy-green)] px-4 text-[12px] font-medium text-white transition hover:bg-[var(--gy-green-deep)]"
        >
          {composing ? <X className="size-3.5" aria-hidden="true" /> : <Users className="size-3.5" aria-hidden="true" />}
          {composing ? "收起" : "分享发现"}
        </button>
      </div>

      {composing && (
        <section className="mt-4 rounded-[16px] border border-[var(--site-border)] bg-white p-[19px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[15px] font-semibold">
              {localMode ? "写一条本机观察" : "写一条田间观察"}
            </h2>
            <label className="flex items-center gap-2 text-[11px] text-[var(--site-muted)]">
              作物
              <select
                value={crop}
                onChange={(event) => setCrop(event.target.value)}
                className="h-8 rounded-[8px] border border-[var(--site-border)] bg-[var(--gy-cream)] px-2 text-[11px] text-[var(--site-fg)]"
              >
                {CROPS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!localMode && !signedIn ? (
            <div className="mt-3 rounded-[12px] bg-[#f7f9f4] p-4">
              <p className="text-[12px] leading-6 text-[var(--site-muted)]">
                发布、评论和点赞需要云端账号。账号不使用手机号或邮箱，只生成一段需要你自行保存的恢复码。
              </p>
              <Link
                to="/profile"
                className="mt-3 inline-flex min-h-[38px] items-center gap-1.5 rounded-full bg-[var(--gy-green)] px-4 text-[12px] font-semibold text-white"
              >
                去创建或恢复账号
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </Link>
            </div>
          ) : (
            <>
              <label htmlFor="community-text" className="sr-only">
                观察内容
              </label>
              <textarea
                id="community-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="今天在田里看到了什么？写下时间、地块和观察到的变化…"
                maxLength={1000}
                rows={4}
                className="gy-input mt-3 w-full resize-none py-3 text-[13px] leading-6"
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <p className="max-w-[46ch] text-[10px] leading-5 text-[var(--site-muted)]">
                  {localMode
                    ? "社区服务未连接：内容只保存在当前浏览器。不要填写真实姓名、联系方式或精确地块位置。"
                    : "不要填写真实姓名、联系方式或精确地块位置；涉及用量、配比或药效承诺的内容会先进入人工复核。"}
                </p>
                <button
                  type="button"
                  onClick={localMode ? publishLocal : publishServer}
                  disabled={sending || !text.trim()}
                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full bg-[var(--gy-green)] px-4 text-[12px] font-semibold text-white hover:bg-[var(--gy-green-deep)] disabled:opacity-50"
                >
                  {sending ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Send className="size-3.5" aria-hidden="true" />
                  )}
                  {localMode ? "发布到本机" : "提交到社区"}
                </button>
              </div>
            </>
          )}

          {mine.length > 0 && (
            <div className="mt-4 border-t border-[#eff3ec] pt-3">
              <h3 className="text-[11px] font-semibold text-[var(--site-muted)]">我的最近提交</h3>
              <ul className="mt-2 grid gap-1.5">
                {mine.slice(0, 5).map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="min-w-0 flex-1 truncate text-[var(--site-fg)]">{item.title}</span>
                    <span
                      className={cn(
                        "rounded-[4px] px-1.5 py-[2px] text-[9px]",
                        item.status === "published"
                          ? "bg-[#eff5e9] text-[#6d8662]"
                          : item.status === "rejected"
                            ? "bg-[#f7e9e5] text-[#8a4b3d]"
                            : "bg-[#fdf3df] text-[#8a7034]",
                      )}
                    >
                      {STATUS_TEXT[item.status] ?? item.status}
                      {item.report_count > 0 ? ` · ${item.report_count} 次举报` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {notice && (
        <p className="mt-3 rounded-[10px] bg-[#f1f5ec] px-3 py-2 text-[11px] leading-5 text-[#5f735a]" role="status">
          {notice}
        </p>
      )}

      {feedError && (
        <p className="mt-3 rounded-[10px] border border-[#ead6ae] bg-[var(--gy-amber-soft)] px-3 py-2 text-[11px] leading-5 text-[#7c4a10]">
          社区服务暂时不可用：{feedError} 下面是本机示例内容，只保存在当前浏览器。
        </p>
      )}

      <div className="gy-split mt-5 grid gap-[22px] lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-3.5">
          {!localMode && feed === null && (
            <p className="flex items-center gap-2 rounded-[16px] border border-[var(--site-border)] bg-white p-6 text-[12px] text-[var(--site-muted)]">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              正在读取社区内容…
            </p>
          )}
          {!localMode &&
            feed !== null &&
            visibleServer.map((post) => (
              <ServerPostCard
                key={post.id}
                post={post}
                signedIn={signedIn}
                onLike={() => void likeServer(post)}
                onComment={(value) => commentServer(post.id, value)}
                onReport={(value) => reportServer(post.id, value)}
              />
            ))}
          {localMode &&
            visibleLocal.map((post) => (
              <LocalPostCard
                key={post.id}
                post={post}
                liked={localLiked.includes(post.id)}
                onLike={() => toggleLike(post.id)}
              />
            ))}
          {((!localMode && feed !== null && visibleServer.length === 0) ||
            (localMode && visibleLocal.length === 0)) && (
            <p className="rounded-[16px] border border-[var(--site-border)] bg-white p-6 text-[12px] leading-6 text-[var(--site-muted)]">
              {filter === "同作物" && !localMode
                ? `还没有关注作物「${preferences.crop}」的公开动态。可以切回「全部」，或在「我的」里调整关注作物。`
                : filter === "同作物"
                  ? `还没有关注作物「${preferences.crop}」的示例动态。可以切回「全部」。`
                  : "社区还没有公开内容。分享第一条经过复核的田间观察。"}
            </p>
          )}
        </div>

        <aside className="grid content-start gap-[22px]">
          <section className="rounded-[16px] border border-[var(--site-border)] bg-white p-[23px]">
            <h2 className="text-[16px] font-[650]">正在聊的话题</h2>
            <div className="mt-4 grid gap-2">
              {TOPICS.map((topic) => (
                <Link
                  key={topic}
                  to="/atlas"
                  className="flex items-center justify-between gap-3 rounded-[10px] bg-[#f7f9f4] px-3 py-3 transition hover:bg-[#f1f5ec]"
                >
                  <span>
                    <strong className="block text-[12px] font-semibold">{topic}</strong>
                    <small className="text-[10px] text-[#9ca797]">看看大家的田间发现</small>
                  </span>
                  <ArrowUpRight className="size-3.5 shrink-0 text-[#b4bfb4]" aria-hidden="true" />
                </Link>
              ))}
            </div>
            <p className="mt-4 text-[10px] leading-[1.8] text-[var(--site-muted)]">
              {localMode
                ? "社区服务未连接，页面中的示例内容为虚构，不代表真实用户。"
                : "社区内容由登录用户提交，经规则提示与人工复核后公开；示例话题仅用于导航。"}
            </p>
          </section>

          <section className="rounded-[16px] border border-[var(--site-border)] bg-white p-[23px]">
            <h2 className="flex items-center gap-2 text-[16px] font-[650]">
              <MessageCircle className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
              从一次观察开始
            </h2>
            <p className="mt-2 text-[11px] leading-[1.9] text-[var(--site-muted)]">
              拍下整株、叶片和叶鞘，记下时间与地块。真实资料仍要回到包装标签与当地农技指导。
            </p>
            <Link
              to="/identify"
              className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--gy-green)] hover:text-[var(--gy-green-deep)]"
            >
              <Leaf className="size-3.5" aria-hidden="true" />
              去识别一株草
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}