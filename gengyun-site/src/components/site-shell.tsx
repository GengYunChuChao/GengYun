import * as React from "react";
import {
  ArrowUpRight,
  Bell,
  BookOpen,
  Home,
  MessageSquare,
  ScanLine,
  Smartphone,
  Sprout,
  UserRound,
  Users,
  Video,
} from "lucide-react";
import { Link, usePath } from "@/lib/router";
import { cn } from "@/lib/utils";
import { MESSAGES } from "@/lib/messages";
import { getReadMessages, useStoreVersion } from "@/lib/store";
import { useAccount } from "@/lib/account";

const MAIN_NAV = [
  { to: "/", label: "首页", icon: Home },
  { to: "/identify", label: "识别", icon: ScanLine },
  { to: "/community", label: "社区", icon: Users },
  { to: "/messages", label: "消息", icon: Bell, badge: 3 },
  { to: "/profile", label: "我的", icon: UserRound },
];

const MORE_NAV = [
  { to: "/atlas", label: "资料库", icon: BookOpen },
  { to: "/qa", label: "农事问答", icon: MessageSquare },
  { to: "/videos", label: "情景视频", icon: Video },
];

const MOBILE_NAV = [
  { to: "/", label: "首页", icon: Home },
  { to: "/community", label: "社区", icon: Users },
  { to: "/identify", label: "识别", icon: ScanLine, center: true },
  { to: "/messages", label: "消息", icon: Bell },
  { to: "/profile", label: "我的", icon: UserRound },
];

const CRUMBS: Record<string, string> = {
  "/": "首页",
  "/identify": "识别",
  "/community": "社区",
  "/messages": "消息",
  "/profile": "我的",
  "/about": "关于耕云",
  "/atlas": "资料库",
  "/qa": "农事问答",
  "/videos": "情景视频",
  "/favorites": "我的收藏",
  "/history": "探索记录",
  "/privacy": "隐私与授权",
  "/moderation": "审核与复核",
};

const isActive = (path: string, to: string) =>
  to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`);

function ModeBadge() {
  return (
    <span className="gy-mode-badge flex items-center gap-[7px] text-[10px] tracking-[1.5px] text-[var(--site-fg)]">
      <span className="size-1.5 rounded-full bg-[var(--gy-green)]" aria-hidden="true" />
      DEMO MODE
    </span>
  );
}

export function SiteShell({ children }: { children: React.ReactNode }) {
  const path = usePath();
  const crumb = CRUMBS[path] ?? "页面未找到";
  const [phone, setPhone] = React.useState(false);
  useStoreVersion();
  const account = useAccount();
  const staticUnread = MESSAGES.filter((message) => !getReadMessages().includes(message.id)).length;
  const unreadMessages = account.account ? account.unread : staticUnread;

  return (
    <div
      className={cn(
        "gy-app min-h-dvh lg:mx-auto lg:grid lg:max-w-[1510px] lg:grid-cols-[224px_minmax(0,1fr)]",
        phone && "gy-phone",
      )}
    >
      <aside className="gy-sidebar sticky top-0 hidden h-dvh flex-col overflow-y-auto bg-[var(--gy-cream)] px-[23px] py-[34px] lg:flex">
        <Link to="/" className="flex items-center gap-[11px] px-[6px] py-px">
          <span className="grid size-[41px] shrink-0 place-items-center rounded-[14px] bg-[var(--gy-ink)] text-[var(--gy-lime)]">
            <Sprout className="size-5" aria-hidden="true" />
          </span>
          <span>
            <span className="block text-[25px] font-[650] leading-[1.1] tracking-[4px]">
              耕云
            </span>
            <span className="mt-[5px] block text-[10px] tracking-[2.6px] text-[#86918b]">
              GENGYUN
            </span>
          </span>
        </Link>

        <div className="mb-[13px] mt-[44px] px-[14px] text-[10px] tracking-[2px] text-[#9aa49d]">
          田间工作台
        </div>
        <nav aria-label="主导航" className="grid gap-1">
          {MAIN_NAV.map((item) => {
            const active = isActive(path, item.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-[45px] items-center gap-[14px] rounded-[12px] px-4 text-[14px]",
                  active
                    ? "bg-[var(--gy-green-soft)] font-semibold text-[#315534]"
                    : "text-[#718277] hover:bg-[#f1f4ec] hover:text-[var(--site-fg)]",
                )}
              >
                <Icon className="size-[19px]" aria-hidden="true" />
                {item.label}
                {item.to === "/messages" && unreadMessages > 0 ? (
                  <span className="ml-auto grid min-w-[18px] place-items-center rounded-full bg-[#e3eed7] px-1 text-[10px] font-semibold leading-[18px] text-[#567441]">
                    {unreadMessages}
                  </span>
                ) : (
                  active && (
                    <span
                      className="ml-auto size-[5px] rounded-full bg-[var(--gy-green)]"
                      aria-hidden="true"
                    />
                  )
                )}
              </Link>
            );
          })}
        </nav>

        <div className="mt-[26px] border-t border-[var(--site-border)] pt-[22px]">
          <div className="mb-[13px] px-[14px] text-[10px] tracking-[2px] text-[#9aa49d]">
            探索更多
          </div>
          <div className="grid gap-1">
            {MORE_NAV.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className="flex h-[45px] items-center gap-[14px] rounded-[12px] px-4 text-[14px] text-[#718277] hover:bg-[#f1f4ec] hover:text-[var(--site-fg)]"
                >
                  <Icon className="size-[19px]" aria-hidden="true" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>

        <div className="mt-auto rounded-[14px] border border-[var(--site-border)] p-[15px] text-[11px] leading-[1.9] text-[var(--site-muted)]">
          <strong className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--site-fg)]">
            <span className="size-1.5 rounded-full bg-[var(--gy-lime)]" aria-hidden="true" />
            田间的可能，正在发生
          </strong>
          <p className="mt-1">每一次观察，都是新的起点。</p>
          <p className="mt-1">演示数据与真实核对回放分开标注</p>
          <p className="mt-1">云端账号可选 · 不提供用量</p>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="gy-topbar sticky top-0 z-30 flex h-[66px] items-center justify-between gap-3 border-b border-[var(--site-border)] bg-[#fafbf8]/95 px-4 backdrop-blur-md lg:h-[85px] lg:px-[42px]">
          <Link to="/" className="gy-mobile-brand flex items-center gap-2 lg:hidden">
            <span className="grid size-8 place-items-center rounded-[10px] bg-[var(--gy-ink)] text-[var(--gy-lime)]">
              <Sprout className="size-4" aria-hidden="true" />
            </span>
            <span className="text-[18px] font-[650] tracking-[0.12em]">耕云</span>
          </Link>

          <div className="gy-crumb hidden items-center gap-[10px] text-[12px] text-[#9aa49e] lg:flex">
            工作台 <span aria-hidden="true">/</span>
            <b className="font-semibold text-[var(--site-fg)]">{crumb}</b>
          </div>

          <div className="flex items-center gap-2 lg:gap-[18px]">
            <ModeBadge />
            <button
              type="button"
              onClick={() => setPhone((value) => !value)}
              className="gy-preview-toggle hidden h-[33px] items-center gap-1.5 rounded-[8px] border border-[#dfe6dd] px-3 text-[11px] text-[var(--site-fg)] transition hover:border-[#c9d6c4] sm:flex"
              aria-pressed={phone}
            >
              <Smartphone className="size-3.5" aria-hidden="true" />
              {phone ? "退出手机预览" : "手机预览"}
            </button>
            <Link
              to="/profile"
              aria-label="个人中心"
              className="grid size-[35px] place-items-center rounded-full bg-[#e5ebdd] text-[13px] font-semibold text-[#5d7051] transition hover:bg-[#dbe5d2]"
            >
              {account.account ? account.account.displayName.slice(0, 1) : "田"}
            </Link>
          </div>
        </header>

        <main
          id="main"
          className="gy-main mx-auto w-full max-w-[1210px] px-4 pb-28 pt-5 lg:px-[42px] lg:pb-8 lg:pt-[30px]"
        >
          {children}
          <p className="mt-[23px] flex flex-col gap-1 border-t border-[var(--site-border)] pt-4 text-[10px] tracking-[0.5px] text-[#adb6aa] sm:flex-row sm:items-center sm:justify-between">
            <span>耕云 · 演示站 / 标签结果为真实运行回放，其余为演示数据</span>
            <span>账号与社区内容存于云端 · 不提供用量 · 不构成用药建议</span>
          </p>
        </main>
      </div>

      <nav
        aria-label="移动端主导航"
        className="gy-bottom-nav fixed inset-x-0 bottom-0 z-40 border-t border-[#e2e9da] bg-[#fbfcf9]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
      >
        <div className="relative mx-auto grid max-w-[560px] grid-cols-5 items-end px-2 pb-2 pt-1.5">
          {MOBILE_NAV.map((item) => {
            const active = isActive(path, item.to);
            const Icon = item.icon;
            if (item.center) {
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? "page" : undefined}
                  className="flex flex-col items-center gap-1"
                >
                  <span
                    className={cn(
                      "grid size-[48px] -translate-y-3 place-items-center rounded-[15px] text-white shadow-[0_10px_22px_-10px_rgba(23,107,80,0.75)] transition",
                      active ? "bg-[var(--gy-green-deep)]" : "bg-[var(--gy-green)]",
                    )}
                  >
                    <Icon className="size-[21px]" aria-hidden="true" />
                  </span>
                  <span className="-mt-2 text-[10px] font-semibold text-[var(--gy-green)]">
                    {item.label}
                  </span>
                </Link>
              );
            }
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "mx-auto flex min-h-[48px] flex-col items-center justify-center gap-1 rounded-[10px] px-3 text-[10px]",
                  active
                    ? "bg-[var(--gy-green-soft)] font-semibold text-[#315534]"
                    : "text-[var(--site-muted)]",
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

export function ToolCard({
  to,
  icon: Icon,
  title,
  desc,
  tone = "green",
  badge,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  title: string;
  desc: string;
  tone?: "green" | "teal" | "amber" | "violet";
  badge?: string;
}) {
  const toneClass =
    tone === "teal"
      ? "bg-[#edf4f4] text-[#638184]"
      : tone === "amber"
        ? "bg-[var(--gy-amber-soft)] text-[var(--gy-amber)]"
        : tone === "violet"
          ? "bg-[#f3eef9] text-[#8977a3]"
          : "bg-[#edf3e8] text-[#567441]";

  return (
    <Link
      to={to}
      className="group relative flex min-h-[145px] flex-col rounded-[15px] border border-[var(--site-border)] bg-white p-[21px] transition hover:-translate-y-0.5 hover:border-[#c9d6c4] hover:shadow-[0_16px_32px_-26px_rgba(23,53,43,0.55)]"
    >
      <span className={cn("grid size-[38px] place-items-center rounded-[11px]", toneClass)}>
        <Icon className="size-[19px]" aria-hidden="true" />
      </span>
      {badge && (
        <span className="absolute right-[13px] top-[12px] rounded-[4px] bg-[#eff5e9] px-1.5 py-[3px] text-[8px] tracking-[1px] text-[#6d8662]">
          {badge}
        </span>
      )}
      <ArrowUpRight
        className="absolute right-[17px] top-[24px] size-3.5 text-[#b4bfb4] transition group-hover:text-[var(--gy-green)]"
        aria-hidden="true"
      />
      <h3 className="mt-[17px] text-[14px] font-semibold leading-[19px]">{title}</h3>
      <p className="mt-[7px] text-[11px] leading-[15px] text-[#909d93]">{desc}</p>
    </Link>
  );
}