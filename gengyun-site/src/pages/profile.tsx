import * as React from "react";
import {
  ArrowRight,
  BellRing,
  BookOpen,
  Check,
  Cloud,
  CloudOff,
  Copy,
  Download,
  History,
  KeyRound,
  Leaf,
  Loader2,
  LogOut,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sprout,
  Trash2,
  UserRound,
} from "lucide-react";
import { Link } from "@/lib/router";
import {
  deleteCloudAccount,
  registerAccount,
  restoreAccount,
  saveAccountExport,
  signOutAccount,
  updateDisplayName,
  useAccount,
} from "@/lib/account";
import {
  getFavorites,
  getHistory,
  getPosts,
  getPreferences,
  resetLocalData,
  setPreferences,
  useStoreVersion,
} from "@/lib/store";
import { cn } from "@/lib/utils";

const CROPS = ["水稻", "玉米", "小麦", "油菜", "其他"];

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export function ProfilePage() {
  useStoreVersion();
  const preferences = getPreferences();
  const favorites = getFavorites().length;
  const history = getHistory().length;
  const myPosts = getPosts().filter((post) => !post.seeded).length;
  const account = useAccount();

  const [editing, setEditing] = React.useState(false);
  const [crop, setCrop] = React.useState(preferences.crop);
  const [notice, setNotice] = React.useState("");
  const [mode, setMode] = React.useState<"create" | "restore">("create");
  const [displayName, setDisplayName] = React.useState("");
  const [recoveryInput, setRecoveryInput] = React.useState("");
  const [accountName, setAccountName] = React.useState("");
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  React.useEffect(() => {
    setAccountName(account.account?.displayName ?? "");
  }, [account.account?.displayName]);

  const signedIn = Boolean(account.account);
  const display = account.account?.displayName ?? "田间探索者";
  const followedCrop = account.account?.crop ?? preferences.crop;
  const feedback = account.error || account.notice || notice;

  const copyRecovery = async () => {
    if (!account.recoveryCode) return;
    try {
      await navigator.clipboard.writeText(account.recoveryCode);
      setNotice("恢复码已复制到剪贴板。");
    } catch {
      setNotice("复制失败，请手动选中恢复码保存。");
    }
  };

  const downloadRecovery = () => {
    if (!account.recoveryCode) return;
    downloadText(
      "gengyun-recovery-code.txt",
      [
        "耕云云端账号恢复码",
        "",
        account.recoveryCode,
        "",
        "用途：换设备或清除 Cookie 后恢复云端账号。",
        "注意：服务器只保存哈希，无法找回；旧恢复码在每次恢复后都会失效。",
        "请勿把这段文字发到公开群聊或截图分享。",
      ].join("\n"),
    );
    setNotice("已下载恢复码文本，请保存在只有你能访问的位置。");
  };

  return (
    <div>
      <header className="max-w-[68ch]">
        <span className="gy-kicker">我的 · PROFILE</span>
        <h1 className="mt-2 text-[24px] font-[650] leading-tight tracking-[-0.8px] sm:text-[29px] sm:tracking-[-1px]">
          我的耕云
        </h1>
        <p className="mt-2 text-[12px] leading-[1.9] text-[var(--site-muted)]">
          登录云端账号后，收藏、探索记录、已读状态与偏好会同步到服务器；
          不登录也可以继续使用本机模式，数据只留在当前浏览器。
        </p>
      </header>

      <section className="mt-6 flex items-center gap-3.5 rounded-[16px] border border-[var(--site-border)] bg-white p-[23px]">
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-[#e5ebdd] text-[18px] font-semibold text-[#5d7051]">
          {(signedIn ? display : "田").slice(0, 1)}
        </span>
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-[18px] font-[650]">
            {display}
            {account.syncing ? (
              <span className="flex items-center gap-1 text-[10px] font-normal text-[var(--site-muted)]">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                同步中
              </span>
            ) : signedIn ? (
              <span className="gy-pill gy-pill--plain min-h-[20px] px-2 text-[9px]">
                <Cloud className="mr-1 size-3" aria-hidden="true" />
                云端账号
              </span>
            ) : (
              <span className="gy-pill gy-pill--plain min-h-[20px] px-2 text-[9px]">
                <CloudOff className="mr-1 size-3" aria-hidden="true" />
                本机模式
              </span>
            )}
          </h2>
          <p className="mt-0.5 text-[11px] text-[var(--site-muted)]">
            {followedCrop} ·{" "}
            {signedIn
              ? account.lastSync
                ? `最近同步 ${new Date(account.lastSync).toLocaleString("zh-CN", { hour12: false })}`
                : "等待首次同步"
              : "未登录，数据只保存在本机"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditing((value) => !value);
            setCrop(preferences.crop);
          }}
          aria-expanded={editing}
          className="ml-auto h-9 shrink-0 rounded-[10px] border border-[var(--site-border)] bg-[#fafbf8] px-4 text-[11px] text-[var(--site-fg)] transition hover:border-[#c9d6c4]"
        >
          {editing ? "收起" : "编辑资料"}
        </button>
      </section>

      {editing && (
        <section className="mt-3 rounded-[14px] border border-[var(--site-border)] bg-white p-4">
          {signedIn && (
            <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-[#eff3ec] pb-3">
              <label htmlFor="profile-name" className="text-[12px] font-medium">
                云端昵称
              </label>
              <input
                id="profile-name"
                value={accountName}
                maxLength={24}
                onChange={(event) => setAccountName(event.target.value)}
                className="h-9 min-w-0 flex-1 rounded-[8px] border border-[var(--site-border)] bg-white px-2 text-[12px]"
              />
              <button
                type="button"
                disabled={account.busy || !accountName.trim()}
                onClick={async () => {
                  const ok = await updateDisplayName(accountName);
                  if (ok) setNotice("昵称已同步到云端。");
                }}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-[var(--site-border)] px-4 text-[12px] font-medium disabled:opacity-50"
              >
                保存昵称
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label htmlFor="profile-crop" className="text-[12px] font-medium">
              关注作物
            </label>
            <select
              id="profile-crop"
              value={crop}
              onChange={(event) => setCrop(event.target.value)}
              className="h-9 rounded-[8px] border border-[var(--site-border)] bg-[var(--gy-cream)] px-2 text-[12px] text-[var(--site-fg)]"
            >
              {CROPS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setPreferences({ crop });
                setEditing(false);
                setNotice(
                  signedIn
                    ? `已把关注作物改为「${crop}」，正在同步到云端。`
                    : `已把关注作物改为「${crop}」，本机保存。`,
                );
              }}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-[var(--gy-green)] px-4 text-[12px] font-semibold text-white hover:bg-[var(--gy-green-deep)]"
            >
              <Check className="size-3.5" aria-hidden="true" />
              保存
            </button>
          </div>
          <p className="mt-2 text-[10px] leading-5 text-[var(--site-muted)]">
            关注作物会影响社区「同作物」筛选；不会请求定位，也不保存地区。
          </p>
        </section>
      )}

      {feedback && (
        <p
          role="status"
          className={cn(
            "mt-3 rounded-[10px] px-3 py-2 text-[11px] leading-5",
            account.error
              ? "border border-[#ead6ae] bg-[var(--gy-amber-soft)] text-[#7c4a10]"
              : "bg-[#f1f5ec] text-[#5f735a]",
          )}
        >
          {feedback}
        </p>
      )}

      {account.syncError && (
        <p className="mt-2 rounded-[10px] border border-[#ead6ae] bg-[var(--gy-amber-soft)] px-3 py-2 text-[11px] leading-5 text-[#7c4a10]">
          {account.syncError} 你仍可继续操作，本机数据不会丢失。
        </p>
      )}

      {account.recoveryCode && (
        <section className="mt-4 rounded-[16px] border border-[#d9c48f] bg-[#fbf6e8] p-[23px]">
          <h2 className="flex items-center gap-2 text-[16px] font-[650] text-[#6f5318]">
            <KeyRound className="size-4" aria-hidden="true" />
            你的恢复码，只显示这一次
          </h2>
          <p className="mt-2 text-[12px] leading-6 text-[#7c6027]">
            换设备或清除浏览器 Cookie 后，只能用这段恢复码找回账号。服务器只保存哈希，无法替你找回。
          </p>
          <code className="mt-3 block break-all rounded-[10px] border border-[#e6d6ab] bg-white px-3 py-3 font-mono text-[13px] leading-6 text-[#4a3a12]">
            {account.recoveryCode}
          </code>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={copyRecovery}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full border border-[#d9c48f] bg-white px-4 text-[12px] font-medium text-[#6f5318]"
            >
              <Copy className="size-3.5" aria-hidden="true" />
              复制恢复码
            </button>
            <button
              type="button"
              onClick={downloadRecovery}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full border border-[#d9c48f] bg-white px-4 text-[12px] font-medium text-[#6f5318]"
            >
              <Download className="size-3.5" aria-hidden="true" />
              下载 TXT
            </button>
            <button
              type="button"
              onClick={() => setNotice("已隐藏恢复码。确保你已妥善保存。")}
              className="inline-flex min-h-[38px] items-center rounded-full px-3 text-[11px] text-[#7c6027] underline underline-offset-4"
            >
              我已保存，隐藏
            </button>
          </div>
          <p className="mt-2 text-[10px] leading-5 text-[#8a7034]">
            不要发到公开群聊或截图分享。旧恢复码在每次恢复后立即失效。
          </p>
        </section>
      )}

      {!signedIn ? (
        <section className="mt-4 rounded-[16px] border border-[var(--site-border)] bg-white p-[23px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-[16px] font-[650]">
              <Cloud className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
              云端账号（可选）
            </h2>
            <span className="gy-pill gy-pill--plain">不收集手机号 / 邮箱</span>
          </div>
          <p className="mt-2 text-[12px] leading-6 text-[var(--site-muted)]">
            云端账号让收藏、记录、消息已读状态与偏好在多台设备间同步；
            创建时不需要密码，只生成一段恢复码。恢复码就是唯一凭证。
          </p>

          <div className="mt-4 flex gap-2">
            {(
              [
                { key: "create", label: "创建云端账号" },
                { key: "restore", label: "用恢复码登录" },
              ] as const
            ).map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setMode(item.key)}
                className={cn(
                  "h-8 rounded-full border px-3.5 text-[11px] transition",
                  mode === item.key
                    ? "border-[var(--gy-green)] bg-[var(--gy-green-soft)] font-semibold text-[#315534]"
                    : "border-[var(--site-border)] bg-white text-[var(--site-muted)]",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          {!account.ready ? (
            <p className="mt-4 flex items-center gap-2 text-[11px] text-[var(--site-muted)]">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              正在确认登录状态…
            </p>
          ) : mode === "create" ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <label className="grid gap-1 text-[11px] text-[var(--site-muted)]">
                昵称
                <input
                  value={displayName}
                  maxLength={24}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="例如：田埂观察员"
                  className="h-10 rounded-[9px] border border-[var(--site-border)] bg-white px-3 text-[12px] text-[var(--site-fg)]"
                />
              </label>
              <label className="grid gap-1 text-[11px] text-[var(--site-muted)]">
                关注作物
                <select
                  value={crop}
                  onChange={(event) => setCrop(event.target.value)}
                  className="h-10 rounded-[9px] border border-[var(--site-border)] bg-white px-2 text-[12px] text-[var(--site-fg)]"
                >
                  {CROPS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={account.busy || !displayName.trim()}
                onClick={async () => {
                  setNotice("");
                  await registerAccount({
                    displayName: displayName.trim(),
                    crop,
                    autoReadAnswers: preferences.autoReadAnswers,
                  });
                }}
                className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-full bg-[var(--gy-green)] px-5 text-[12px] font-semibold text-white hover:bg-[var(--gy-green-deep)] disabled:opacity-50"
              >
                {account.busy ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Cloud className="size-3.5" aria-hidden="true" />
                )}
                创建
              </button>
            </div>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label className="grid gap-1 text-[11px] text-[var(--site-muted)]">
                恢复码
                <input
                  value={recoveryInput}
                  onChange={(event) => setRecoveryInput(event.target.value)}
                  placeholder="gy_..."
                  autoComplete="off"
                  spellCheck={false}
                  className="h-10 rounded-[9px] border border-[var(--site-border)] bg-white px-3 font-mono text-[12px] text-[var(--site-fg)]"
                />
              </label>
              <button
                type="button"
                disabled={account.busy || recoveryInput.trim().length < 8}
                onClick={async () => {
                  setNotice("");
                  const result = await restoreAccount(recoveryInput);
                  if (result) setRecoveryInput("");
                }}
                className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-full bg-[var(--gy-green)] px-5 text-[12px] font-semibold text-white hover:bg-[var(--gy-green-deep)] disabled:opacity-50"
              >
                {account.busy ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <KeyRound className="size-3.5" aria-hidden="true" />
                )}
                恢复并换发新码
              </button>
            </div>
          )}
          <p className="mt-3 text-[10px] leading-[1.8] text-[var(--site-muted)]">
            恢复成功后旧恢复码立即失效，并显示新的恢复码。没有密码找回、没有客服重置，
            请把恢复码保存在只有你能访问的地方。继续使用本机模式不会上传任何数据。
          </p>
        </section>
      ) : (
        <section className="mt-4 rounded-[16px] border border-[var(--site-border)] bg-white p-[23px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-[16px] font-[650]">
              <ShieldCheck className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
              云端数据与账号
            </h2>
            <span className="gy-pill gy-pill--plain">服务端 Cookie 登录</span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={account.busy}
              onClick={async () => {
                setNotice("");
                await saveAccountExport();
              }}
              className="flex min-h-[44px] items-center justify-between gap-2 rounded-[10px] border border-[var(--site-border)] px-4 text-[12px] transition hover:border-[#c9d6c4] disabled:opacity-50"
            >
              <span className="flex items-center gap-2">
                <Download className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
                导出云端数据
              </span>
              <ArrowRight className="size-3 text-[#b4bfb4]" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={account.busy}
              onClick={async () => {
                setConfirmingDelete(false);
                setNotice("");
                await signOutAccount();
              }}
              className="flex min-h-[44px] items-center justify-between gap-2 rounded-[10px] border border-[var(--site-border)] px-4 text-[12px] transition hover:border-[#c9d6c4] disabled:opacity-50"
            >
              <span className="flex items-center gap-2">
                <LogOut className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
                退出云端账号
              </span>
              <span className="text-[10px] text-[var(--site-muted)]">保留本机数据</span>
            </button>
          </div>
          <div className="mt-3 rounded-[10px] border border-[#f0d9d3] bg-[#fdf6f4] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] leading-5 text-[#8a4b3d]">
                注销会删除账号、云端收藏/记录/消息状态、社区发布与识别照片，且无法恢复。
              </p>
              <button
                type="button"
                disabled={account.busy}
                onClick={async () => {
                  if (!confirmingDelete) {
                    setConfirmingDelete(true);
                    setNotice("再次点击将注销账号并删除全部云端数据。");
                    return;
                  }
                  setConfirmingDelete(false);
                  await deleteCloudAccount();
                }}
                className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-full bg-[var(--site-danger)] px-4 text-[11px] font-semibold text-white disabled:opacity-50"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {confirmingDelete ? "再点一次，注销账号" : "注销云端账号"}
              </button>
            </div>
          </div>
          <p className="mt-3 text-[10px] leading-[1.8] text-[var(--site-muted)]">
            登录状态依赖当前浏览器的安全 Cookie；清除 Cookie 或换设备后，需要用恢复码重新登录。
            站内消息的已读状态会以云端记录为准。
          </p>
        </section>
      )}

      <div className="mt-4 grid grid-cols-3 gap-3">
        {[
          { value: favorites, label: "我的收藏", to: "/favorites" },
          { value: history, label: "探索记录", to: "/history" },
          { value: myPosts, label: "本机发布", to: "/community" },
        ].map((item) => (
          <Link
            key={item.label}
            to={item.to}
            className="rounded-[14px] border border-[var(--site-border)] bg-white px-4 py-4 transition hover:border-[#c9d6c4]"
          >
            <strong className="block text-[22px] font-[650] leading-none">{item.value}</strong>
            <small className="mt-2 block text-[11px] text-[var(--site-muted)]">{item.label}</small>
          </Link>
        ))}
      </div>

      <div className="gy-split mt-4 grid gap-3.5 lg:grid-cols-2">
        <section className="rounded-[16px] border border-[var(--site-border)] bg-white p-[23px]">
          <h2 className="text-[16px] font-[650]">我的偏好</h2>
          <div className="mt-3">
            <button
              type="button"
              onClick={() => {
                setEditing(true);
                setCrop(preferences.crop);
              }}
              className="flex min-h-[48px] w-full items-center justify-between gap-3 border-b border-[#eff3ec] text-left text-[12px] text-[var(--site-fg)]"
            >
              <span className="flex items-center gap-2">
                <Sprout className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
                关注作物
              </span>
              <span className="flex items-center gap-1 text-[11px] text-[var(--site-muted)]">
                {followedCrop}
                <ArrowRight className="size-3" aria-hidden="true" />
              </span>
            </button>
            <div className="flex min-h-[48px] items-center justify-between gap-3 border-b border-[#eff3ec] text-[12px] text-[var(--site-fg)]">
              <span className="flex items-center gap-2">
                <BellRing className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
                问答自动朗读
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={preferences.autoReadAnswers}
                aria-label="问答自动朗读"
                onClick={() =>
                  setPreferences({ autoReadAnswers: !preferences.autoReadAnswers })
                }
                className={cn(
                  "relative h-5 w-9 rounded-full transition",
                  preferences.autoReadAnswers ? "bg-[var(--gy-green)]" : "bg-[#dfe6dd]",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition",
                    preferences.autoReadAnswers ? "left-[18px]" : "left-0.5",
                  )}
                  aria-hidden="true"
                />
              </button>
            </div>
            <Link
              to="/privacy"
              className="flex min-h-[48px] items-center justify-between gap-3 text-[12px] text-[var(--site-fg)]"
            >
              <span className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
                隐私与授权
              </span>
              <ArrowRight className="size-3 text-[#b4bfb4]" aria-hidden="true" />
            </Link>
          </div>
          <p className="text-[10px] leading-[1.8] text-[var(--site-muted)]">
            {signedIn
              ? "偏好会同时写入本机并同步到云端；换设备后可随账号恢复。"
              : "偏好保存在本机浏览器；可在「隐私与授权」逐项清除。"}
          </p>
        </section>

        <section className="rounded-[16px] border border-[var(--site-border)] bg-white p-[23px]">
          <h2 className="text-[16px] font-[650]">我的内容</h2>
          <div className="mt-3">
            <Link
              to="/favorites"
              className="flex min-h-[48px] items-center justify-between gap-3 border-b border-[#eff3ec] text-[12px] text-[var(--site-fg)]"
            >
              <span className="flex items-center gap-2">
                <BookOpen className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
                我的收藏
              </span>
              <span className="flex items-center gap-1 text-[11px] text-[var(--site-muted)]">
                {favorites} 条
                <ArrowRight className="size-3" aria-hidden="true" />
              </span>
            </Link>
            <Link
              to="/history"
              className="flex min-h-[48px] items-center justify-between gap-3 border-b border-[#eff3ec] text-[12px] text-[var(--site-fg)]"
            >
              <span className="flex items-center gap-2">
                <History className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
                探索记录
              </span>
              <span className="flex items-center gap-1 text-[11px] text-[var(--site-muted)]">
                {history} 条
                <ArrowRight className="size-3" aria-hidden="true" />
              </span>
            </Link>
            <Link
              to="/messages"
              className="flex min-h-[48px] items-center justify-between gap-3 border-b border-[#eff3ec] text-[12px] text-[var(--site-fg)]"
            >
              <span className="flex items-center gap-2">
                <UserRound className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
                消息与互动
              </span>
              <ArrowRight className="size-3 text-[#b4bfb4]" aria-hidden="true" />
            </Link>
            <Link
              to="/about"
              className="flex min-h-[48px] items-center justify-between gap-3 text-[12px] text-[var(--site-fg)]"
            >
              <span className="flex items-center gap-2">
                <Leaf className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
                关于耕云
              </span>
              <span className="flex items-center gap-1 text-[11px] text-[var(--site-muted)]">
                v1.2
                <ArrowRight className="size-3" aria-hidden="true" />
              </span>
            </Link>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#eff3ec] pt-3">
            <button
              type="button"
              onClick={() => {
                resetLocalData("all");
                setNotice(
                  signedIn
                    ? "已清除本机缓存；云端账号数据仍在服务器上，可退出或注销账号处理。"
                    : "已清除本机收藏、记录、发布、消息状态与偏好，示例内容已恢复。",
                );
              }}
              className="flex min-h-[40px] items-center gap-2 text-left text-[12px] text-[var(--site-danger)]"
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              重置本机数据
            </button>
            <Settings className="size-3.5 text-[#b4bfb4]" aria-hidden="true" />
          </div>
          <p className="mt-2 text-[10px] leading-[1.8] text-[var(--site-muted)]">
            {signedIn
              ? "「重置本机数据」不会删除云端数据；要删除服务器数据请使用上方注销。"
              : "当前没有云端账号，重置后数据直接回到示例状态。"}
          </p>
        </section>
      </div>
    </div>
  );
}