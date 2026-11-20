import * as React from "react";
import { SiteShell } from "@/components/site-shell";
import { AboutPage } from "@/pages/about";
import { AtlasPage } from "@/pages/atlas";
import { CommunityPage } from "@/pages/community";
import { FavoritesPage } from "@/pages/favorites";
import { HistoryPage } from "@/pages/history";
import { HomePage } from "@/pages/home";
import { IdentifyPage } from "@/pages/identify";
import { MessagesPage } from "@/pages/messages";
import { ModerationPage } from "@/pages/moderation";
import { PrivacyPage } from "@/pages/privacy";
import { ProfilePage } from "@/pages/profile";
import { QaPage } from "@/pages/qa";
import { VideosPage } from "@/pages/videos";
import { Link, usePath } from "@/lib/router";
import { ensureAccountBooted } from "@/lib/account";

const TITLES: Record<string, string> = {
  "/": "耕云 · 看见田间的每一种可能",
  "/identify": "识别 · 耕云",
  "/community": "社区 · 耕云",
  "/messages": "消息 · 耕云",
  "/profile": "我的 · 耕云",
  "/about": "关于耕云 · 技术与边界",
  "/atlas": "资料库 · 耕云",
  "/qa": "农事问答 · 耕云",
  "/videos": "情景视频 · 耕云",
  "/favorites": "我的收藏 · 耕云",
  "/history": "探索记录 · 耕云",
  "/privacy": "隐私与授权 · 耕云",
  "/moderation": "审核与复核 · 耕云",
};

const ROUTES = [
  "/",
  "/identify",
  "/community",
  "/messages",
  "/profile",
  "/about",
  "/atlas",
  "/qa",
  "/videos",
  "/favorites",
  "/history",
  "/privacy",
  "/moderation",
];

export default function App() {
  const path = usePath();

  React.useEffect(() => {
    void ensureAccountBooted();
  }, []);

  React.useEffect(() => {
    document.title = TITLES[path] ?? "耕云 · 田间探索";
    window.scrollTo(0, 0);
  }, [path]);

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-[var(--gy-green)] focus:px-4 focus:py-2 focus:text-white"
      >
        跳到主要内容
      </a>
      <SiteShell>
        {path === "/" && <HomePage />}
        {path === "/identify" && <IdentifyPage />}
        {path === "/community" && <CommunityPage />}
        {path === "/messages" && <MessagesPage />}
        {path === "/profile" && <ProfilePage />}
        {path === "/about" && <AboutPage />}
        {path === "/atlas" && <AtlasPage />}
        {path === "/qa" && <QaPage />}
        {path === "/videos" && <VideosPage />}
        {path === "/favorites" && <FavoritesPage />}
        {path === "/history" && <HistoryPage />}
        {path === "/privacy" && <PrivacyPage />}
        {path === "/moderation" && <ModerationPage />}
        {!ROUTES.includes(path) && <NotFound />}
      </SiteShell>
    </>
  );
}

function NotFound() {
  return (
    <div className="gy-shell grid min-h-[50vh] place-items-center py-16 text-center">
      <div>
        <p className="text-[12px] font-bold tracking-[0.18em] text-[var(--gy-green)]">404</p>
        <h1 className="mt-3 text-[28px] font-bold">这条田埂还没修好</h1>
        <p className="mt-2 text-[14px] text-[var(--site-muted)]">页面不存在，回到首页重新出发。</p>
        <Link
          to="/"
          className="mt-5 inline-flex min-h-[44px] items-center rounded-full bg-[var(--gy-green)] px-5 text-[14px] font-semibold text-white"
        >
          回到首页
        </Link>
      </div>
    </div>
  );
}