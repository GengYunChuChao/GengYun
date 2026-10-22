/**
 * GY-R28 · W6（#19）· 在线到期清除的**跨轮游标**（命令侧状态，⛔ 不进库）。
 *
 * ## 为什么游标在文件里，而不是在库里
 * 见 `services/api/src/privacy/online-purge-driver.ts` 文件头「批次推进」一节：本驱动**不写**
 * `deletion_requests.state`（完成判定归协调器，只清在线四域就标 `completed` 等于谎称完成），
 * 本片又不新增迁移/加列，所以"上一轮处理到哪一行"只能放在**调用方**手里。
 * 放文件而不是放进程内存：cron 每次都是新进程，内存态等于没有进度。
 *
 * ## 这个文件里有什么、没有什么
 * 只有 `{ version, cursor: { afterDueAt, afterRequestId }, updatedAt }`：
 * `afterDueAt` 是到期时刻（日历事实），`afterRequestId` 是注销请求 id（回执里本来就有）。
 * ⛔ **没有** `user_id`、没有正文/标题/联系方式/凭据/数据库连接串 —— 它可能被运维顺手粘进工单。
 * 也⛔ 不记录"哪些请求清完了"：那是证据的事（进命令报告，见驱动文件头「证据为什么只进报告」），
 * 游标只回答一个问题：**下一次从哪一行之后继续翻**。
 *
 * ## 写坏了怎么办
 * 读到的任何偏差（不是 JSON / 版本不认识 / 游标形状非法 / 读不出来）都**不猜**：返回 `invalid` +
 * 一句固定分类的原因，由 CLI 打到 stderr 并**从队首重扫**。⛔ 不静默忽略 —— 静默忽略等于偷偷把
 * 进度清零，又会回到"每轮撞同一批队首行"的饿死老路，而且外面看不出来。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { normalizeOnlinePurgeCursor, type OnlinePurgeCursor } from './online-purge-driver.ts';

/** 文件格式版本：形状变了就换版本号，旧文件一律按"不可用"处理（⛔ 不猜旧语义）。 */
export const ONLINE_PURGE_CURSOR_STATE_VERSION = 1;

/** 环境变量：游标文件路径（命令行 `--cursor-file` 优先于它）。 */
export const ONLINE_PURGE_CURSOR_ENV = 'ONLINE_PURGE_CURSOR_FILE';

/** 缺省文件名（相对**当前工作目录**；运维应在自己的状态目录里跑，或用环境变量指到别处）。 */
export const DEFAULT_ONLINE_PURGE_CURSOR_FILE = '.gengyun-online-purge-cursor.json';

/** 文件内容（只有这三个字段，见文件头「这个文件里有什么」）。 */
export interface OnlinePurgeCursorState {
  version: number;
  cursor: OnlinePurgeCursor;
  updatedAt: string;
}

/**
 * 读盘结果（三态，**不抛**：游标坏了不该让整轮清除失败 —— 清除是安全动作，进度是优化）。
 *
 * - `absent`：还没有游标文件（第一次跑，或上一轮已走到队尾并清掉了文件）⇒ 从队首开始。
 * - `ok`：拿到游标（`cursor: null` 表示文件里明确写着"从队首"）。
 * - `invalid`：文件不可用；`problem` 是固定分类的一句话，**不含路径以外的内容**，由 CLI 打 stderr。
 */
export type OnlinePurgeCursorRead =
  | { kind: 'absent'; cursor: null; problem: null }
  | { kind: 'ok'; cursor: OnlinePurgeCursor | null; problem: null }
  | { kind: 'invalid'; cursor: null; problem: string };

function invalid(problem: string): OnlinePurgeCursorRead {
  return { kind: 'invalid', cursor: null, problem };
}

/**
 * 解析游标文件路径：`--cursor-file` > 环境变量 `ONLINE_PURGE_CURSOR_FILE` > 缺省文件名。
 *
 * 相对路径按 `cwd` 解析（cron 里 `cwd` 是谁就写谁下面 —— 所以 CI/正式调度应给绝对路径）。
 * 显式给了**空串**则报错，⛔ 不顺从地当成"没给"（那会静默换成缺省路径，运维以为写到了自己指定的地方）。
 */
export function resolveOnlinePurgeCursorPath(input: {
  argv?: string | undefined;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}): string {
  const cwd = input.cwd ?? process.cwd();
  const explicit = typeof input.argv === 'string' ? input.argv.trim() : '';
  if (explicit === '' && typeof input.argv === 'string') {
    throw new TypeError('游标文件路径不能为空串（要么给路径，要么用 --no-cursor 明确关掉）');
  }
  if (explicit !== '') return resolve(cwd, explicit);
  const fromEnv = input.env?.[ONLINE_PURGE_CURSOR_ENV];
  const envPath = typeof fromEnv === 'string' ? fromEnv.trim() : '';
  if (envPath !== '') return resolve(cwd, envPath);
  return resolve(cwd, DEFAULT_ONLINE_PURGE_CURSOR_FILE);
}

/** 读游标文件（三态；任何偏差都不抛，见 `OnlinePurgeCursorRead`）。 */
export function readOnlinePurgeCursor(path: string): OnlinePurgeCursorRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') return { kind: 'absent', cursor: null, problem: null };
    return invalid(`游标文件读不出来（错误码 ${typeof code === 'string' ? code : 'UNKNOWN'}）`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid('游标文件不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalid('游标文件不是 JSON 对象');
  }
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== ONLINE_PURGE_CURSOR_STATE_VERSION) {
    return invalid(`游标文件版本不认识（期望 version=${ONLINE_PURGE_CURSOR_STATE_VERSION}）`);
  }
  if (record['cursor'] === null) return { kind: 'ok', cursor: null, problem: null };
  try {
    return { kind: 'ok', cursor: normalizeOnlinePurgeCursor(record['cursor']), problem: null };
  } catch (error) {
    return invalid(`游标内容不可用（${(error as Error).message}）`);
  }
}

/**
 * 写游标文件（**原子**：同目录临时文件 + rename，进程被杀不会留下半个 JSON）。
 *
 * `cursor === null` ⇒ 删文件（"已走到队尾，下一轮从队首"这个语义用**文件不存在**表达，
 * 而不是在文件里留一个 `null`：少一种状态，也就少一种读错的机会）。
 * `updatedAt` 只是给人看的时间戳，⛔ 不参与任何判定。
 */
export function writeOnlinePurgeCursor(
  path: string,
  cursor: OnlinePurgeCursor | null,
  updatedAt: Date | string | number,
): void {
  if (cursor === null) {
    rmSync(path, { force: true });
    return;
  }
  const normalized = normalizeOnlinePurgeCursor(cursor);
  if (normalized === null) {
    rmSync(path, { force: true });
    return;
  }
  const stamp = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  if (!Number.isFinite(stamp.getTime())) {
    throw new TypeError('游标文件的 updatedAt 必须是可解析的时刻');
  }
  const payload: OnlinePurgeCursorState = {
    version: ONLINE_PURGE_CURSOR_STATE_VERSION,
    cursor: normalized,
    updatedAt: stamp.toISOString(),
  };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}
