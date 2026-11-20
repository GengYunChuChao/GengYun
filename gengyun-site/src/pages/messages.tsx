import * as React from "react";
import {
  ArrowRight,
  Bell,
  ChevronDown,
  Heart,
  Leaf,
  Loader2,
  MessageSquare,
  ScanLine,
  ShieldCheck,
  Video,
} from "lucide-react";
import { Link } from "@/lib/router";
import { MESSAGES, type MessageType } from "@/lib/messages";
import { api, apiErrorText, type NotificationItem } from "@/lib/api";
import { refreshUnread, useAccount } from "@/lib/account";
import {
  getReadMessages,
  markAllMessagesRead,
  markMessageRead,
  useStoreVersion,
} from "@/lib/store";
import { cn } from "@/lib/utils";

const ICONS = {
  n1: MessageSquare,
  n2: Video,
  n3: Leaf,
} as const;

const SERVER_ICONS: Record<string, typeof Bell> = {
  comment: MessageSquare,
  moderation: ShieldCheck,
  review: ScanLine,
  welcome: Leaf,
  like: Heart,
};

const FILTERS: { key: "all" | MessageType; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "interaction", label: "互动" },
  { key: "system", label: "系统" },
];

function serverType(kind: string): MessageType {
  return kind === "comment" || kind === "like" ? "interaction" : "system";
}

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

export function MessagesPage() {
  useStoreVersion();
  const account = useAccount();
  const signedIn = Boolean(account.account);
  const read = getReadMessages();
  const [filter, setFilter] = React.useState<"all" | MessageType>("all");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState<NotificationItem[] | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!account.ready || !signedIn) {
      setNotes(null);
      return;
    }
    let active = true;
    setError("");
    api
      .notifications()
      .then((data) => {
        if (active) setNotes(data.notifications);
      })
      .catch((caught) => {
        if (active) setError(apiErrorText(caught));
      });
    return () => {
      active = false;
    };
  }, [account.ready, signedIn, account.account?.id]);

  const localList = MESSAGES.filter((message) => filter === "all" || message.type === filter);
  const serverList = (notes ?? []).filter(
    (note) => filter === "all" || serverType(note.kind) === filter,
  );

  const localUnread = MESSAGES.filter((message) => !read.includes(message.id)).length;
  const serverUnread = (notes ?? []).filter((note) => !note.read).length;
  const unread = signedIn ? serverUnread : localUnread;

  const markServerRead = async (note: NotificationItem) => {
    if (note.read || !notes) return;
    setNotes(notes.map((item) => (item.id === note.id ? { ...item, read: true } : item)));
    try {
      await api.readNotification(note.id);
      await refreshUnread();
    } catch {
      // The badge catches up on the next refresh.
    }
  };

  const markAllServer = async () => {
    setBusy(true);
    try {
      await api.readAllNotifications();
      setNotes((current) => current?.map((item) => ({ ...item, read: true })) ?? current);
      await refreshUnread();
    } catch (caught) {
      setError(apiErrorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <header className="max-w-[68ch]">
        <span className="gy-kicker">消息 · INBOX</span>
        <h1 className="mt-2 text-[24px] font-[650] leading-tight tracking-[-0.8px] sm:text-[29px] sm:tracking-[-1px]">
          消息，让交流继续
        </h1>
        <p className="mt-2 text-[12px] leading-[1.9] text-[var(--site-muted)]">
          {signedIn
            ? "账号消息保存在云端：社区评论、复核结果与系统提醒会出现在这里，已读状态跨设备同步。"
            : "当前是本机演示消息。创建云端账号后，会在这里收到真实站内通知；站内消息不会发送短信或邮件。"}
        </p>
      </header>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              className={cn(
                "h-8 rounded-full border px-3.5 text-[11px] transition",
                filter === item.key
                  ? "border-[var(--gy-green)] bg-[var(--gy-green-soft)] font-semibold text-[#315534]"
                  : "border-[var(--site-border)] bg-white text-[var(--site-muted)] hover:border-[#c9d6c4]",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={busy || unread === 0}
          onClick={() => {
            if (signedIn) {
              void markAllServer();
            } else {
              markAllMessagesRead(MESSAGES.map((message) => message.id));
            }
          }}
          className="h-9 rounded-[10px] border border-[var(--site-border)] bg-white px-4 text-[11px] text-[var(--site-fg)] transition hover:border-[#c9d6c4] disabled:cursor-default disabled:opacity-60"
        >
          {unread === 0 ? "已全部标记为已读" : `全部已读（${unread}）`}
        </button>
      </div>

      {signedIn && error && (
        <p className="mt-4 rounded-[10px] border border-[#ead6ae] bg-[var(--gy-amber-soft)] px-3 py-2 text-[11px] leading-5 text-[#7c4a10]">
          消息服务暂时不可用：{error}
        </p>
      )}

      <section className="mt-5 overflow-hidden rounded-[16px] border border-[var(--site-border)] bg-white">
        {signedIn && notes === null && !error && (
          <p className="flex items-center gap-2 px-5 py-8 text-[12px] text-[var(--site-muted)]">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            正在读取云端消息…
          </p>
        )}

        {signedIn &&
          notes !== null &&
          serverList.map((note) => {
            const Icon = SERVER_ICONS[note.kind] ?? Bell;
            const open = openId === note.id;
            return (
              <article key={note.id} className="border-b border-[#eff3ec] last:border-0">
                <button
                  type="button"
                  onClick={() => {
                    setOpenId(open ? null : note.id);
                    void markServerRead(note);
                  }}
                  aria-expanded={open}
                  className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-[#f7f9f4]"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-[#edf3e8] text-[#567441]">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block text-[12px] font-semibold">{note.title}</strong>
                    <span className="mt-1 block text-[11px] text-[#7f8d83]">{note.body}</span>
                    <small className="mt-1 block text-[10px] text-[#a7b1a4]">
                      {timeText(note.at)} · 站内消息
                    </small>
                  </span>
                  {!note.read ? (
                    <span className="size-2 shrink-0 rounded-full bg-[var(--gy-green)]" aria-label="未读" />
                  ) : (
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-[#b4bfb4] transition-transform",
                        open && "rotate-180",
                      )}
                      aria-hidden="true"
                    />
                  )}
                </button>
                {open && (
                  <div className="bg-[#fafbf8] px-5 pb-5 pl-[68px]">
                    <p className="text-[12px] leading-[1.9] text-[#4b5d52]">{note.body}</p>
                    <Link
                      to={note.target || "/"}
                      className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--gy-green)] hover:text-[var(--gy-green-deep)]"
                    >
                      去看看
                      <ArrowRight className="size-3.5" aria-hidden="true" />
                    </Link>
                  </div>
                )}
              </article>
            );
          })}

        {signedIn && notes !== null && serverList.length === 0 && (
          <p className="px-5 py-8 text-center text-[12px] text-[var(--site-muted)]">
            这个分类下暂时没有云端消息。
          </p>
        )}

        {!signedIn &&
          localList.map((message) => {
            const Icon = ICONS[message.id as keyof typeof ICONS] ?? Bell;
            const isUnread = !read.includes(message.id);
            const open = openId === message.id;
            return (
              <article key={message.id} className="border-b border-[#eff3ec] last:border-0">
                <button
                  type="button"
                  onClick={() => {
                    setOpenId(open ? null : message.id);
                    markMessageRead(message.id);
                  }}
                  aria-expanded={open}
                  className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-[#f7f9f4]"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-[#edf3e8] text-[#567441]">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block text-[12px] font-semibold">{message.title}</strong>
                    <span className="mt-1 block text-[11px] text-[#7f8d83]">{message.text}</span>
                    <small className="mt-1 block text-[10px] text-[#a7b1a4]">
                      {message.time} · 演示消息
                    </small>
                  </span>
                  {isUnread ? (
                    <span className="size-2 shrink-0 rounded-full bg-[var(--gy-green)]" aria-label="未读" />
                  ) : (
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-[#b4bfb4] transition-transform",
                        open && "rotate-180",
                      )}
                      aria-hidden="true"
                    />
                  )}
                </button>
                {open && (
                  <div className="bg-[#fafbf8] px-5 pb-5 pl-[68px]">
                    <p className="text-[12px] leading-[1.9] text-[#4b5d52]">{message.detail}</p>
                    <Link
                      to={message.to}
                      onClick={() => markMessageRead(message.id)}
                      className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--gy-green)] hover:text-[var(--gy-green-deep)]"
                    >
                      去看看
                      <ArrowRight className="size-3.5" aria-hidden="true" />
                    </Link>
                  </div>
                )}
              </article>
            );
          })}

        {!signedIn && localList.length === 0 && (
          <p className="px-5 py-8 text-center text-[12px] text-[var(--site-muted)]">
            这个分类下暂时没有消息。
          </p>
        )}
      </section>
      <p className="mt-3 text-[10px] leading-[1.8] text-[var(--site-muted)]">
        {signedIn
          ? "已读状态同步到云端账号；注销账号会删除这些消息记录。消息只做站内提醒，不包含用量或用药建议。"
          : "演示消息为虚构内容，不连接真实账号，也不会发送通知；创建云端账号后可查看真实站内消息。"}
      </p>
    </div>
  );
}