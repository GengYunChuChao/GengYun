import * as React from "react";
import { ArrowRight, Cloud, Database, ShieldCheck, Trash2 } from "lucide-react";
import { Link } from "@/lib/router";
import { useAccount } from "@/lib/account";
import {
  getLocalDataSummary,
  resetLocalData,
  useStoreVersion,
} from "@/lib/store";

type Group = "favorites" | "history" | "community" | "messages" | "preferences" | "correction";

const GROUPS: {
  key: Group;
  label: string;
  description: string;
  count: (summary: ReturnType<typeof getLocalDataSummary>) => string;
}[] = [
  {
    key: "favorites",
    label: "我的收藏",
    description: "你从资料库收藏的除草剂、杂草与登记样本标题。",
    count: (summary) => `${summary.favorites} 条`,
  },
  {
    key: "history",
    label: "探索记录",
    description: "标签核对的机器读数摘要与人工更正内容，不含照片。",
    count: (summary) => `${summary.history} 条`,
  },
  {
    key: "community",
    label: "本机社区草稿",
    description: "社区服务不可用时，本机保存的观察、评论和点赞状态。",
    count: (summary) => `${summary.posts} 条发布`,
  },
  {
    key: "messages",
    label: "演示消息已读状态",
    description: "未登录时，哪些示例消息已经读过。",
    count: (summary) => `${summary.unreadMessages} 条未读`,
  },
  {
    key: "preferences",
    label: "偏好设置",
    description: "自动朗读开关与关注作物的本机副本。",
    count: (summary) => summary.preferences.crop,
  },
  {
    key: "correction",
    label: "标签更正草稿",
    description: "识别页保存的最近一次人工更正字段。",
    count: (summary) => (summary.labelCorrection ? "已保存 1 份" : "无"),
  },
];

export function PrivacyPage() {
  useStoreVersion();
  const account = useAccount();
  const signedIn = Boolean(account.account);
  const summary = getLocalDataSummary();
  const [confirmingAll, setConfirmingAll] = React.useState(false);
  const [notice, setNotice] = React.useState("");

  const clear = (group: Group, label: string) => {
    const ok = resetLocalData(group);
    setNotice(ok ? `已清除「${label}」的本机数据。` : "浏览器不允许本机存储，本次没有清除。");
  };

  return (
    <div className="gy-shell">
      <header className="max-w-[64ch]">
        <span className="gy-kicker">隐私与授权 · LOCAL DATA</span>
        <h1 className="mt-2 text-[24px] font-[650] leading-tight tracking-[-0.8px] sm:text-[29px] sm:tracking-[-1px]">
          数据留在本机，云端说清边界。
        </h1>
        <p className="mt-2 text-[12px] leading-[1.9] text-[var(--site-muted)]">
          网页版提供可选的云端账号：用恢复码登录，不收集手机号、微信身份或位置。
          这里分别列出浏览器本机保存的数据和云端账号保存的数据，你可以逐项清除本机数据，或到「我的」导出、注销云端账号。
        </p>
      </header>

      <section className="mt-6 grid gap-3 sm:grid-cols-3" aria-label="数据边界">
        {[
          {
            title: "照片上传是可选的",
            text: "样本回放不上传照片。只有登录后主动选择标签照片，才会保存到站点存储并进入人工复核。",
          },
          {
            title: "账号也是可选的",
            text: "不登录也能浏览和回放；登录只保存恢复码哈希，不收集手机号、邮箱或微信身份。",
          },
          {
            title: "不收集位置",
            text: "网页不请求定位，也不保存任何坐标或地区轨迹。",
          },
        ].map((item) => (
          <div key={item.title} className="gy-card p-4">
            <ShieldCheck className="size-5 text-[var(--gy-green)]" aria-hidden="true" />
            <h2 className="mt-2 text-[14px] font-semibold">{item.title}</h2>
            <p className="mt-1 text-[11px] leading-[1.8] text-[var(--site-muted)]">{item.text}</p>
          </div>
        ))}
      </section>

      <section className="gy-card mt-5 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--site-border)] px-4 py-4 sm:px-5">
          <h2 className="flex items-center gap-2 text-[16px] font-[650]">
            <Database className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
            当前浏览器保存了什么
          </h2>
          <span className="gy-pill gy-pill--plain">localStorage · 仅本机</span>
        </div>
        <ul className="divide-y divide-[var(--site-border)]">
          {GROUPS.map((group) => (
            <li key={group.key} className="flex flex-wrap items-start gap-3 px-4 py-4 sm:px-5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[13px] font-semibold">{group.label}</h3>
                  <span className="gy-pill gy-pill--plain min-h-[22px] px-2 text-[10px]">
                    {group.count(summary)}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-[1.8] text-[var(--site-muted)]">
                  {group.description}
                </p>
              </div>
              <button
                type="button"
                onClick={() => clear(group.key, group.label)}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-[var(--site-border)] bg-white px-3.5 text-[11px] text-[var(--site-danger)] transition hover:border-[#e2b6ad]"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                清除
              </button>
            </li>
          ))}
        </ul>
        <p className="border-t border-[var(--site-border)] px-4 py-3 text-[10px] leading-[1.8] text-[var(--site-muted)] sm:px-5">
          {signedIn
            ? "登录状态下，清除本机数据不会删除云端副本；下次同步可能把云端数据重新合并回来。要删除云端数据，请注销账号。"
            : "未登录时，这些数据不会离开当前浏览器；换浏览器或清除站点数据后无法恢复。"}
        </p>
      </section>

      {notice && (
        <p
          role="status"
          className="mt-4 rounded-[10px] border border-[var(--gy-green)]/30 bg-[var(--gy-green-soft)] px-4 py-3 text-[12px] leading-6 text-[var(--gy-green-deep)]"
        >
          {notice}
        </p>
      )}

      <section className="gy-card mt-5 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[16px] font-bold">
            <Cloud className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
            云端账号保存了什么
          </h2>
          <span className="gy-pill gy-pill--plain">
            {signedIn ? `已登录：${account.account?.displayName}` : "当前未登录"}
          </span>
        </div>
        {signedIn ? (
          <>
            <p className="mt-2 text-[12px] leading-6 text-[#4b5d52]">
              云端保存：昵称、关注作物、朗读偏好、收藏、探索记录与人工更正、消息已读状态、
              社区发布/评论/点赞/举报，以及你主动上传的标签照片与人工复核结果。
              照片只用于这次复核，不用于训练或广告。
            </p>
            <p className="mt-2 text-[12px] leading-6 text-[#4b5d52]">
              登录凭据是安全 Cookie；恢复码在服务器只保存哈希。注销账号会删除上述云端数据与照片，
              无法恢复，但不会自动清除你当前浏览器里的本机副本。
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link
                to="/profile"
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-full bg-[var(--gy-green)] px-5 text-[12px] font-semibold text-white"
              >
                管理、导出或注销云端账号
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
              <Link
                to="/about"
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-full border border-[var(--site-border)] bg-[var(--gy-cream)] px-4 text-[12px] font-medium"
              >
                阅读技术与边界
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-[12px] leading-6 text-[#4b5d52]">
              当前浏览器没有登录云端账号：不存在服务端账号，也不会上传照片。
              本页上面的数据全部只在本机；社区为只读浏览，消息为虚构演示。
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link
                to="/profile"
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-full bg-[var(--gy-green)] px-5 text-[12px] font-semibold text-white"
              >
                创建或恢复云端账号
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
              <Link
                to="/about"
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-full border border-[var(--site-border)] bg-[var(--gy-cream)] px-4 text-[12px] font-medium"
              >
                阅读技术与边界
              </Link>
            </div>
          </>
        )}
      </section>

      <section className="gy-card mt-5 border-[#ead6ae] bg-[var(--gy-amber-soft)] p-5 sm:p-6">
        <h2 className="text-[16px] font-bold text-[var(--gy-amber)]">清除当前浏览器的数据</h2>
        <p className="mt-1 text-[12px] leading-6 text-[#7c4a10]">
          这一步只清空本机保存的收藏、记录、草稿、已读状态与偏好，不影响云端账号；
          云端数据要删除时，请到「我的」使用注销。清除本机数据后不可恢复。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              if (!confirmingAll) {
                setConfirmingAll(true);
                setNotice("再次点击将清除本机全部演示数据，包括收藏、记录、草稿、消息状态与偏好。");
                return;
              }
              const ok = resetLocalData("all");
              setConfirmingAll(false);
              setNotice(ok ? "已清除本机全部演示数据。" : "浏览器不允许本机存储，本次没有清除。");
            }}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-[var(--gy-danger)] px-5 text-[13px] font-semibold text-white transition hover:opacity-90"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            {confirmingAll ? "再点一次，清除本机全部" : "清除本机全部数据"}
          </button>
          <Link
            to="/about"
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-[var(--site-border)] bg-[var(--gy-cream)] px-4 text-[12px] font-medium"
          >
            阅读技术与边界
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
      </section>

      <p className="mt-4 text-[11px] leading-6 text-[var(--site-muted)]">
        清除本机数据不可恢复；若你只是返回首页看看，数据会继续留在当前浏览器。
        无论是否登录，耕云都不提供用量、药效承诺或施用方案。
      </p>
    </div>
  );
}