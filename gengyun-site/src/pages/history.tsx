import * as React from "react";
import { ArrowRight, ClipboardCheck, History, ScanLine, Trash2 } from "lucide-react";
import { Link } from "@/lib/router";
import { clearHistory, getHistory, useStoreVersion } from "@/lib/store";
import { useAccount } from "@/lib/account";

function timeText(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function HistoryPage() {
  useStoreVersion();
  const { account } = useAccount();
  const signedIn = Boolean(account);
  const records = getHistory();
  const [confirming, setConfirming] = React.useState(false);

  return (
    <div className="gy-shell">
      <header className="max-w-[64ch]">
        <span className="gy-kicker">探索记录 · HISTORY</span>
        <h1 className="mt-2 text-[24px] font-[650] leading-tight tracking-[-0.8px] sm:text-[29px] sm:tracking-[-1px]">
          每一次核对，都留一条线索。
        </h1>
        <p className="mt-2 text-[12px] leading-[1.9] text-[var(--site-muted)]">
          {signedIn
            ? "这里记录标签核对与人工更正，并同步到云端账号，不保存照片。机器读数不是权威判读，记录也不构成用药依据。"
            : "这里只记录本机完成的标签核对与人工更正，不保存照片；登录云端账号后会同步到服务器。机器读数不是权威判读，记录也不构成用药依据。"}
        </p>
      </header>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="gy-pill gy-pill--plain">
          {signedIn ? "云端同步" : "本机记录"} · {records.length} 条
        </span>
        <span className="gy-pill gy-pill--plain">上限 50 条</span>
        {records.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              clearHistory();
              setConfirming(false);
            }}
            className="ml-auto inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-[var(--site-border)] bg-white px-3.5 text-[11px] text-[var(--site-danger)] hover:border-[#e2b6ad]"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            {confirming ? "再点一次确认清空" : "清空记录"}
          </button>
        )}
      </div>

      {records.length === 0 ? (
        <section className="gy-card mt-6 grid min-h-[260px] place-items-center p-8 text-center">
          <div>
            <History className="mx-auto size-8 text-[var(--site-muted)]" aria-hidden="true" />
            <h2 className="mt-3 text-[18px] font-semibold">还没有探索记录</h2>
            <p className="mt-1 max-w-[38ch] text-[12px] leading-6 text-[var(--site-muted)]">
              完成一次标签核对后，机器读数、人工更正和核对时间会留在这里，方便回头对照包装。
            </p>
            <Link
              to="/identify"
              className="mt-4 inline-flex min-h-[42px] items-center gap-1.5 rounded-full bg-[var(--gy-green)] px-5 text-[13px] font-semibold text-white hover:bg-[var(--gy-green-deep)]"
            >
              去核对一张标签
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </section>
      ) : (
        <ol className="mt-6 grid gap-3">
          {records.map((record) => (
            <li key={record.id} className="gy-card p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-[var(--gy-green-soft)] text-[var(--gy-green)]">
                  {record.corrections.length > 0 ? (
                    <ClipboardCheck className="size-4" aria-hidden="true" />
                  ) : (
                    <ScanLine className="size-4" aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-[15px] font-semibold">{record.title}</h2>
                    <span className="text-[10px] text-[#a7b1a4]">{timeText(record.at)}</span>
                  </div>
                  <p className="mt-1 text-[12px] leading-6 text-[var(--site-muted)]">
                    {record.subtitle}
                  </p>
                  {record.corrections.length > 0 ? (
                    <div className="mt-2 rounded-[10px] bg-[var(--gy-cream)] px-3 py-2">
                      <p className="text-[10px] font-semibold tracking-wider text-[var(--site-muted)]">
                        本次人工更正 {record.corrections.length} 项
                      </p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] leading-5">
                        {record.corrections.map((change) => (
                          <li key={change}>{change}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="mt-2 text-[10px] text-[#a7b1a4]">
                      本次未发现与机器读数不同的字段。
                    </p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <p className="mt-5 flex items-start gap-2 text-[11px] leading-6 text-[var(--site-muted)]">
        <History className="mt-1 size-3.5 shrink-0" aria-hidden="true" />
        删除记录只影响当前浏览器；公开演示从未把记录上传到服务器，也没有可登录的账号。
      </p>
    </div>
  );
}