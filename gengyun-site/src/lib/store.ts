import * as React from "react";

const PREFIX = "gy.site.";

export const STORE_KEYS = {
  favorites: `${PREFIX}favorites.v1`,
  history: `${PREFIX}history.v1`,
  posts: `${PREFIX}posts.v1`,
  likedPosts: `${PREFIX}liked-posts.v1`,
  readMessages: `${PREFIX}read-messages.v1`,
  preferences: `${PREFIX}preferences.v1`,
  labelCorrection: "gy.labelCorrection.v1",
} as const;

export type FavoriteKind = "herbicide" | "weed" | "record";

export type Favorite = {
  key: string;
  kind: FavoriteKind;
  title: string;
  subtitle: string;
  savedAt: string;
};

export type ExploreRecord = {
  id: string;
  at: string;
  title: string;
  subtitle: string;
  corrections: string[];
};

export type Comment = {
  id: string;
  author: string;
  text: string;
  at: string;
};

export type Post = {
  id: string;
  author: string;
  crop: string;
  text: string;
  at: string;
  baseLikes: number;
  comments: Comment[];
  seeded?: boolean;
};

export type Preferences = {
  autoReadAnswers: boolean;
  crop: string;
};

const DEFAULT_PREFERENCES: Preferences = { autoReadAnswers: false, crop: "水稻" };

const SEED_POSTS: Post[] = [
  {
    id: "p1",
    author: "禾间笔记",
    crop: "水稻",
    text: "今天给田边的植株做了一次观察记录。拍整株和叶鞘，确实比只拍一片叶子更容易整理线索。",
    at: "20 分钟前 · 示例",
    baseLikes: 6,
    seeded: true,
    comments: [
      {
        id: "c1",
        author: "小林的田间日记",
        text: "叶鞘那一步很关键，我之前只拍叶片，回去对照时经常对不上。",
        at: "12 分钟前",
      },
      {
        id: "c2",
        author: "田埂观察员",
        text: "再记一下天气和水层，隔几天看变化会更清楚。",
        at: "8 分钟前",
      },
    ],
  },
  {
    id: "p2",
    author: "小林的田间日记",
    crop: "玉米",
    text: "把一周的田间照片按日期放在一起，变化一下就清楚了。你们平时都怎么整理农事记录？",
    at: "1 小时前 · 示例",
    baseLikes: 3,
    seeded: true,
    comments: [
      {
        id: "c3",
        author: "禾间笔记",
        text: "我按地块分文件夹，再在文件名里写日期和天气。",
        at: "40 分钟前",
      },
    ],
  },
];

type CloudHooks = {
  favorite?: (favorite: Favorite, active: boolean) => void;
  history?: (entry: ExploreRecord) => void;
  historyClear?: () => void;
  read?: (id: string) => void;
  readsAll?: (ids: string[]) => void;
  preferences?: (preferences: Preferences) => void;
};

let cloudHooks: CloudHooks | null = null;

export function setCloudHooks(hooks: CloudHooks | null) {
  cloudHooks = hooks;
}

function fireCloud(action: (hooks: CloudHooks) => void) {
  if (!cloudHooks) return;
  try {
    action(cloudHooks);
  } catch {
    // A cloud write must never block the local-first interaction.
  }
}

const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStoreVersion() {
  return React.useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith(PREFIX) || event.key === STORE_KEYS.labelCorrection) {
      emit();
    }
  });
}

function readArray<T>(key: string): T[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function readObject<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    emit();
    return true;
  } catch {
    return false;
  }
}

export function newId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function favoriteId(kind: FavoriteKind, key: string) {
  return `${kind}:${key}`;
}

export function getFavorites(): Favorite[] {
  return readArray<Favorite>(STORE_KEYS.favorites).filter(
    (item) => item && typeof item.key === "string" && typeof item.title === "string",
  );
}

export function isFavorite(kind: FavoriteKind, key: string) {
  const id = favoriteId(kind, key);
  return getFavorites().some((item) => favoriteId(item.kind, item.key) === id);
}

export function toggleFavorite(input: Omit<Favorite, "savedAt">): boolean {
  const id = favoriteId(input.kind, input.key);
  const current = getFavorites();
  const exists = current.some((item) => favoriteId(item.kind, item.key) === id);
  const next = exists
    ? current.filter((item) => favoriteId(item.kind, item.key) !== id)
    : [{ ...input, savedAt: new Date().toISOString() }, ...current];
  write(STORE_KEYS.favorites, next.slice(0, 100));
  const saved = next.find((item) => favoriteId(item.kind, item.key) === id);
  if (saved) fireCloud((hooks) => hooks.favorite?.(saved, !exists));
  return !exists;
}

export function removeFavorite(kind: FavoriteKind, key: string) {
  const id = favoriteId(kind, key);
  write(
    STORE_KEYS.favorites,
    getFavorites().filter((item) => favoriteId(item.kind, item.key) !== id),
  );
  fireCloud((hooks) =>
    hooks.favorite?.({ key, kind, title: "", subtitle: "", savedAt: "" }, false),
  );
}

export function getHistory(): ExploreRecord[] {
  return readArray<ExploreRecord>(STORE_KEYS.history).filter(
    (item) => item && typeof item.id === "string" && typeof item.title === "string",
  );
}

export function addHistory(input: Omit<ExploreRecord, "id" | "at">) {
  const entry: ExploreRecord = {
    ...input,
    id: newId(),
    at: new Date().toISOString(),
  };
  write(STORE_KEYS.history, [entry, ...getHistory()].slice(0, 50));
  fireCloud((hooks) => hooks.history?.(entry));
  return entry;
}

export function updateHistory(id: string, patch: Partial<Pick<ExploreRecord, "subtitle" | "corrections">>) {
  const next = getHistory().map((item) => (item.id === id ? { ...item, ...patch } : item));
  write(STORE_KEYS.history, next);
  const saved = next.find((item) => item.id === id);
  if (saved) fireCloud((hooks) => hooks.history?.(saved));
}

export function clearHistory() {
  write(STORE_KEYS.history, []);
  fireCloud((hooks) => hooks.historyClear?.());
}

export function getPosts(): Post[] {
  const stored = readArray<Post>(STORE_KEYS.posts).filter(
    (item) => item && typeof item.id === "string" && typeof item.text === "string",
  );
  return stored.length > 0 ? stored : SEED_POSTS;
}

export function addPost(text: string, crop: string): Post | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const post: Post = {
    id: newId(),
    author: "田间探索者",
    crop,
    text: trimmed.slice(0, 500),
    at: new Date().toISOString(),
    baseLikes: 0,
    comments: [],
  };
  write(STORE_KEYS.posts, [post, ...getPosts()]);
  return post;
}

export function addComment(postId: string, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const posts = getPosts().map((post) =>
    post.id === postId
      ? {
          ...post,
          comments: [
            ...post.comments,
            {
              id: newId(),
              author: "田间探索者",
              text: trimmed.slice(0, 300),
              at: new Date().toISOString(),
            },
          ],
        }
      : post,
  );
  return write(STORE_KEYS.posts, posts);
}

export function getLikedPosts(): string[] {
  return readArray<string>(STORE_KEYS.likedPosts).filter((id) => typeof id === "string");
}

export function toggleLike(postId: string): boolean {
  const current = getLikedPosts();
  const liked = current.includes(postId);
  const next = liked ? current.filter((id) => id !== postId) : [...current, postId];
  write(STORE_KEYS.likedPosts, next);
  return !liked;
}

export function getReadMessages(): string[] {
  return readArray<string>(STORE_KEYS.readMessages).filter((id) => typeof id === "string");
}

export function markMessageRead(id: string) {
  const current = getReadMessages();
  if (current.includes(id)) return;
  write(STORE_KEYS.readMessages, [...current, id]);
  fireCloud((hooks) => hooks.read?.(id));
}

export function markAllMessagesRead(ids: string[]) {
  write(STORE_KEYS.readMessages, Array.from(new Set([...getReadMessages(), ...ids])));
  if (ids.length) fireCloud((hooks) => hooks.readsAll?.(ids));
}

export function getPreferences(): Preferences {
  const stored = readObject<Partial<Preferences>>(STORE_KEYS.preferences, {});
  return {
    autoReadAnswers:
      typeof stored.autoReadAnswers === "boolean"
        ? stored.autoReadAnswers
        : DEFAULT_PREFERENCES.autoReadAnswers,
    crop: typeof stored.crop === "string" && stored.crop ? stored.crop : DEFAULT_PREFERENCES.crop,
  };
}

export function setPreferences(patch: Partial<Preferences>) {
  const next = { ...getPreferences(), ...patch };
  write(STORE_KEYS.preferences, next);
  fireCloud((hooks) => hooks.preferences?.(next));
}

export function mergeFavorites(items: Array<Omit<Favorite, never>>) {
  const merged = new Map<string, Favorite>();
  for (const item of getFavorites()) merged.set(favoriteId(item.kind, item.key), item);
  for (const item of items) {
    const id = favoriteId(item.kind, item.key);
    if (!merged.has(id)) {
      merged.set(id, {
        key: item.key,
        kind: item.kind,
        title: item.title,
        subtitle: item.subtitle,
        savedAt: item.savedAt,
      });
    }
  }
  write(
    STORE_KEYS.favorites,
    [...merged.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, 100),
  );
}

export function mergeHistory(items: ExploreRecord[]) {
  const merged = new Map<string, ExploreRecord>();
  for (const item of getHistory()) merged.set(item.id, item);
  for (const item of items) {
    if (!merged.has(item.id)) merged.set(item.id, item);
  }
  write(
    STORE_KEYS.history,
    [...merged.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50),
  );
}

export function mergeReadMessages(ids: string[]) {
  write(STORE_KEYS.readMessages, Array.from(new Set([...getReadMessages(), ...ids])));
}

export function getLocalDataSummary() {
  return {
    favorites: getFavorites().length,
    history: getHistory().length,
    posts: getPosts().filter((post) => !post.seeded).length,
    unreadMessages: Math.max(0, 3 - getReadMessages().length),
    preferences: getPreferences(),
    labelCorrection: (() => {
      try {
        return window.localStorage.getItem(STORE_KEYS.labelCorrection) !== null;
      } catch {
        return false;
      }
    })(),
  };
}

export function resetLocalData(group: "all" | "favorites" | "history" | "community" | "messages" | "preferences" | "correction") {
  try {
    if (group === "all" || group === "favorites") window.localStorage.removeItem(STORE_KEYS.favorites);
    if (group === "all" || group === "history") window.localStorage.removeItem(STORE_KEYS.history);
    if (group === "all" || group === "community") {
      window.localStorage.removeItem(STORE_KEYS.posts);
      window.localStorage.removeItem(STORE_KEYS.likedPosts);
    }
    if (group === "all" || group === "messages") window.localStorage.removeItem(STORE_KEYS.readMessages);
    if (group === "all" || group === "preferences") window.localStorage.removeItem(STORE_KEYS.preferences);
    if (group === "all" || group === "correction") window.localStorage.removeItem(STORE_KEYS.labelCorrection);
    emit();
    return true;
  } catch {
    return false;
  }
}