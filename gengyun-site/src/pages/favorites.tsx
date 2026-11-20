import * as React from "react";
import { ArrowRight, BookOpen, Star, Trash2 } from "lucide-react";
import { Link } from "@/lib/router";
import {
  getFavorites,
  removeFavorite,
  useStoreVersion,
  type FavoriteKind,
} from "@/lib/store";
import { useAccount } from "@/lib/account";

const KIND_LABEL: Record<FavoriteKind, string> = {
  herbicide: "除草剂",
  weed: "田间杂草",
  record: "登记样本",
};

function savedText(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function FavoritesPage() {
  useStoreVersion();
  const { account } = useAccount();
  const signedIn = Boolean(account);
  const favorites = getFavorites();
  const [confirming, setConfirming] = React.useState(false);

  return (
    <div className="gy-shell">
      <header className="max-w-[64ch]">
        <span className="gy-kicker">我的收藏 · SAVED</span>
        <h1 className="mt-2 text-[24px] font-[650] leading-tight tracking-[-0.8px] sm:text-[29px] sm:tracking-[-1px]">
          把要再看一眼的，先留在这里。
        </h1>
        <p className="mt-2 text-[12px] leading-[1.9] text-[var(--site-muted)]">
          {signedIn
            ? "收藏已同步到云端账号，换设备后可随账号恢复；收藏不等于「已使用」，也不代表资料已被核实。"
            : "未登录时收藏只保存在当前浏览器；登录云端账号后会同步到服务器。收藏不等于「已使用」，也不代表资料已被核实。"}
        </p>
      </header>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="gy-pill gy-pill--plain">
          {signedIn ? "云端同步" : "本机存储"} · {favorites.length} 条
        </span>
        <span className="gy-pill gy-pill--amber">种子演示数据 · 待核实 · 非权威</span>
        {favorites.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              for (const item of favorites) removeFavorite(item.kind, item.key);
              setConfirming(false);
            }}
            className="ml-auto inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-[var(--site-border)] bg-white px-3.5 text-[11px] text-[var(--site-danger)] hover:border-[#e2b6ad]"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            {confirming ? "再点一次确认清空" : "清空收藏"}
          </button>
        )}
      </div>

      {favorites.length === 0 ? (
        <section className="gy-card mt-6 grid min-h-[260px] place-items-center p-8 text-center">
          <div>
            <Star className="mx-auto size-8 text-[var(--site-muted)]" aria-hidden="true" />
            <h2 className="mt-3 text-[18px] font-semibold">还没有收藏</h2>
            <p className="mt-1 max-w-[36ch] text-[12px] leading-6 text-[var(--site-muted)]">
              到资料库里挑一条除草剂、杂草或登记样本，点「收藏」就会出现在这里。
            </p>
            <Link
              to="/atlas"
              className="mt-4 inline-flex min-h-[42px] items-center gap-1.5 rounded-full bg-[var(--gy-green)] px-5 text-[13px] font-semibold text-white hover:bg-[var(--gy-green-deep)]"
            >
              去资料库
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </section>
      ) : (
        <section className="gy-card mt-6 divide-y divide-[var(--site-border)]" aria-label="收藏列表">
          {favorites.map((item) => (
            <article key={`${item.kind}:${item.key}`} className="flex items-start gap-3 p-4 sm:p-5">
              <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-[var(--gy-green-soft)] text-[var(--gy-green)]">
                <BookOpen className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[15px] font-semibold">{item.title}</h2>
                  <span className="gy-pill gy-pill--plain min-h-[24px] px-2 text-[10px]">
                    {KIND_LABEL[item.kind] ?? "资料"}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-[var(--site-muted)]">
                  {item.subtitle}
                </p>
                <p className="mt-1 text-[10px] text-[#a7b1a4]">收藏于 {savedText(item.savedAt)}</p>
              </div>
              <button
                type="button"
                aria-label={`取消收藏 ${item.title}`}
                onClick={() => removeFavorite(item.kind, item.key)}
                className="grid size-9 shrink-0 place-items-center rounded-full text-[var(--site-muted)] transition hover:bg-[#f7e8e4] hover:text-[var(--site-danger)]"
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </article>
          ))}
        </section>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Link
          to="/atlas"
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-[var(--site-border)] bg-[var(--gy-cream)] px-4 text-[12px] font-medium hover:border-[#c9d6c4]"
        >
          继续查资料
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
        <Link
          to="/profile"
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full px-4 text-[12px] text-[var(--site-muted)] hover:text-[var(--site-fg)]"
        >
          回到我的
        </Link>
      </div>
    </div>
  );
}