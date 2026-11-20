import * as React from "react";
import { AlertTriangle, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

type RiskVideoProps = {
  src: string;
  poster: string;
  title: string;
  desc: string;
  buttonLabel: string;
  note: string;
  className?: string;
};

export function RiskVideo({
  src,
  poster,
  title,
  desc,
  buttonLabel,
  note,
  className,
}: RiskVideoProps) {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState("");

  return (
    <div className={className}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-[38px] shrink-0 place-items-center rounded-[11px] bg-[#edf3e8] text-[#567441]">
          <Play className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-[16px] font-[650] leading-[1.4]">{title}</h3>
          <p className="mt-1 text-[11px] leading-[1.8] text-[var(--site-muted)]">{desc}</p>
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        className="mt-4 min-h-[40px] w-full rounded-[10px] border-[#dfe6dd] bg-[#fafbf8] text-[12px] font-medium text-[var(--site-fg)] hover:bg-[#f1f4ec]"
        onClick={() => {
          setOpen((value) => !value);
          setError("");
        }}
      >
        {open ? "收起视频" : buttonLabel}
      </Button>

      {open && (
        <div className="mt-4 overflow-hidden rounded-[var(--site-radius)] border border-[var(--site-border)] bg-black">
          <video
            src={src}
            poster={poster}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="mx-auto block max-h-[560px] w-full object-contain"
            onError={() => setError("视频加载失败，请刷新页面重试。")}
          />
        </div>
      )}

      {error && (
        <p className="mt-2 flex items-center gap-1.5 text-[13px] text-[var(--gy-danger)]" role="alert">
          <AlertTriangle className="size-4" aria-hidden="true" />
          {error}
        </p>
      )}

      <p className="mt-3 text-[10px] leading-[1.8] text-[var(--site-muted)]">{note}</p>
    </div>
  );
}
