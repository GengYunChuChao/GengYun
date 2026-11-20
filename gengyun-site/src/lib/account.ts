import * as React from "react";
import {
  api,
  apiErrorText,
  downloadExport,
  type Account,
  type CloudFavorite,
  type CloudHistory,
  type SyncPayload,
} from "./api";
import {
  getFavorites,
  getHistory,
  getReadMessages,
  mergeFavorites,
  mergeHistory,
  mergeReadMessages,
  resetLocalData,
  setCloudHooks,
  setPreferences,
} from "./store";

export type AccountState = {
  ready: boolean;
  account: Account | null;
  busy: boolean;
  syncing: boolean;
  error: string;
  notice: string;
  syncError: string;
  recoveryCode: string | null;
  unread: number;
  lastSync: string | null;
};

let state: AccountState = {
  ready: false,
  account: null,
  busy: false,
  syncing: false,
  error: "",
  notice: "",
  syncError: "",
  recoveryCode: null,
  unread: 0,
  lastSync: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<AccountState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAccount() {
  return React.useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

function track(promise: Promise<unknown>) {
  promise
    .then(() => {
      set({ lastSync: new Date().toISOString(), syncError: "" });
    })
    .catch((error) => {
      set({ syncError: apiErrorText(error) });
    });
}

function installHooks() {
  if (!state.account) {
    setCloudHooks(null);
    return;
  }
  setCloudHooks({
    favorite(favorite, active) {
      track(
        active
          ? api.addFavorite({
              kind: favorite.kind,
              key: favorite.key,
              title: favorite.title,
              subtitle: favorite.subtitle,
            })
          : api.removeFavorite({ kind: favorite.kind, key: favorite.key }),
      );
    },
    history(entry) {
      track(
        api.addHistory({
          id: entry.id,
          kind: "label_check",
          title: entry.title,
          subtitle: entry.subtitle,
          corrections: entry.corrections,
        }),
      );
    },
    historyClear() {
      track(api.clearHistory());
    },
    read(id) {
      track(api.markRead(id));
    },
    readsAll(ids) {
      if (ids.length) track(api.markAllRead(ids));
    },
    preferences(preferences) {
      if (!state.account) return;
      track(
        api.updateAccount(preferences).then(({ account }) => {
          set({ account });
        }),
      );
    },
  });
}

type SyncMode = "register" | "restore" | "refresh";

function toRecord(item: CloudHistory) {
  return {
    id: item.id,
    at: item.at,
    title: item.title,
    subtitle: item.subtitle,
    corrections: Array.isArray(item.corrections) ? item.corrections : [],
  };
}

async function syncData(mode: SyncMode) {
  const data: SyncPayload = await api.sync();
  set({ account: data.account });

  const serverFavoriteIds = new Set(
    data.favorites.map((item: CloudFavorite) => `${item.kind}:${item.key}`),
  );
  const serverHistoryIds = new Set(data.history.map((item) => item.id));
  const serverReads = new Set(data.readMessages);

  mergeFavorites(data.favorites);
  mergeHistory(data.history.map(toRecord));
  mergeReadMessages(data.readMessages);
  if (mode !== "register") {
    setPreferences({
      crop: data.preferences.crop,
      autoReadAnswers: data.preferences.autoReadAnswers,
    });
  }

  const missingFavorites = getFavorites().filter(
    (item) => !serverFavoriteIds.has(`${item.kind}:${item.key}`),
  );
  const missingHistory = getHistory().filter((item) => !serverHistoryIds.has(item.id));
  const missingReads = getReadMessages().filter((id) => !serverReads.has(id));

  const results = await Promise.allSettled([
    ...missingFavorites.map((item) =>
      api.addFavorite({
        kind: item.kind,
        key: item.key,
        title: item.title,
        subtitle: item.subtitle,
      }),
    ),
    ...missingHistory.map((item) =>
      api.addHistory({
        id: item.id,
        kind: "label_check",
        title: item.title,
        subtitle: item.subtitle,
        corrections: item.corrections,
      }),
    ),
    ...(missingReads.length ? [api.markAllRead(missingReads)] : []),
  ]);

  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed) {
    set({ syncError: `有 ${failed} 项数据没有同步到云端，已先保存在本机。` });
  }
}

async function runCloudSync(mode: SyncMode) {
  set({ syncing: true, syncError: "" });
  try {
    await syncData(mode);
    await refreshUnread();
    set({ lastSync: new Date().toISOString() });
  } catch (error) {
    set({ syncError: apiErrorText(error) });
  } finally {
    set({ syncing: false });
    installHooks();
  }
}

export async function refreshUnread() {
  if (!state.account) {
    set({ unread: 0 });
    return;
  }
  try {
    const data = await api.notifications();
    set({ unread: data.notifications.filter((item) => !item.read).length });
  } catch {
    // The unread badge is an enhancement, not a blocker.
  }
}

let bootPromise: Promise<void> | null = null;

export function ensureAccountBooted() {
  if (!bootPromise) {
    bootPromise = (async () => {
      try {
        const session = await api.session();
        if (session.authenticated && session.account) {
          set({ account: session.account });
          await runCloudSync("refresh");
        } else {
          setCloudHooks(null);
          set({ unread: 0 });
        }
      } catch (error) {
        set({ syncError: apiErrorText(error) });
      } finally {
        set({ ready: true });
      }
    })();
  }
  return bootPromise;
}

export async function registerAccount(input: {
  displayName: string;
  crop: string;
  autoReadAnswers: boolean;
}) {
  set({ busy: true, error: "", notice: "", syncError: "" });
  setCloudHooks(null);
  try {
    const data = await api.register(input);
    setPreferences({ crop: input.crop, autoReadAnswers: input.autoReadAnswers });
    set({
      account: data.account,
      recoveryCode: data.recoveryCode,
      busy: false,
      notice: "云端账号已创建。恢复码只显示这一次，请立即保存。",
    });
    await runCloudSync("register");
    return data;
  } catch (error) {
    set({ busy: false, error: apiErrorText(error) });
    return null;
  }
}

export async function restoreAccount(recoveryCode: string) {
  set({ busy: true, error: "", notice: "", syncError: "" });
  setCloudHooks(null);
  try {
    const data = await api.restore(recoveryCode.trim());
    set({
      account: data.account,
      recoveryCode: data.recoveryCode,
      busy: false,
      notice: "已恢复云端账号，并换发了新的恢复码。",
    });
    await runCloudSync("restore");
    return data;
  } catch (error) {
    set({ busy: false, error: apiErrorText(error) });
    return null;
  }
}

export async function signOutAccount() {
  set({ busy: true, error: "" });
  try {
    await api.logout();
  } catch {
    // The cookie may already be gone; clear local session state regardless.
  }
  setCloudHooks(null);
  set({
    busy: false,
    account: null,
    recoveryCode: null,
    unread: 0,
    lastSync: null,
    notice: "已退出云端账号。本机保存的数据仍然保留。",
  });
}

export async function deleteCloudAccount() {
  set({ busy: true, error: "" });
  try {
    await api.deleteAccount();
  } catch (error) {
    set({ busy: false, error: apiErrorText(error) });
    return false;
  }
  setCloudHooks(null);
  resetLocalData("all");
  set({
    busy: false,
    account: null,
    recoveryCode: null,
    unread: 0,
    lastSync: null,
    notice: "云端账号与本机演示数据已清除。",
  });
  return true;
}

export async function updateDisplayName(displayName: string) {
  const name = displayName.trim();
  if (!name) {
    set({ error: "昵称不能为空。" });
    return false;
  }
  set({ busy: true, error: "" });
  try {
    const { account } = await api.updateAccount({ displayName: name.slice(0, 24) });
    set({ account, busy: false, notice: "昵称已保存到云端。" });
    return true;
  } catch (error) {
    set({ busy: false, error: apiErrorText(error) });
    return false;
  }
}

export async function saveAccountExport() {
  set({ busy: true, error: "" });
  try {
    const { blob, filename } = await downloadExport();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    set({ busy: false, notice: "已生成数据导出文件，下载应已开始。" });
    return true;
  } catch (error) {
    set({ busy: false, error: apiErrorText(error) });
    return false;
  }
}

export function clearAccountNotice() {
  set({ notice: "", error: "" });
}

export function clearRecoveryCode() {
  set({ recoveryCode: null });
}