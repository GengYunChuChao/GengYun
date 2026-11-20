import * as React from "react";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  isFavorite,
  toggleFavorite,
  useStoreVersion,
  type FavoriteKind,
} from "@/lib/store";

export function FavoriteButton({
  kind,
  itemKey,
  title,
  subtitle,
  className,
}: {
  kind: FavoriteKind;
  itemKey: string;
  title: string;
  subtitle: string;
  className?: string;
}) {
  useStoreVersion();
  const active = isFavorite(kind, itemKey);
  const [notice, setNotice] = React.useState("");

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <button
        type="button"
        aria-pressed={active}
        aria-label={active ? `取消收藏 ${title}` : `收藏 ${title}`}
        onClick={() => {
          const next = toggleFavorite({
            key: itemKey,
            kind,
            title,
            subtitle,
          });
          setNotice(next ? "已收藏到本机「我的收藏」。" : "已取消收藏。");
        }}
        className={cn(
          "inline-flex min-h-[40px] items-center gap-1.5 rounded-full border px-4 text-[12px] font-medium transition",
          active
            ? "border-[var(--gy-green)] bg-[var(--gy-green-soft)] text-[var(--gy-green-deep)]"
            : "border-[var(--site-border)] bg-[var(--gy-cream)] text-[var(--site-fg)] hover:border-[#c9d6c4]",
        )}
      >
        <Star
          className="size-3.5"
          aria-hidden="true"
          fill={active ? "currentColor" : "none"}
        />
        {active ? "已收藏" : "收藏"}
      </button>
      <span className="text-[10px] text-[var(--site-muted)]" role="status">
        {notice}
      </span>
    </div>
  );
}