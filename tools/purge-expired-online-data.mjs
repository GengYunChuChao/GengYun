#!/usr/bin/env node
/**
 * GY-R28 · W6（#19）· **在线数据 7 日到期清除**的运维驱动命令（缺口：在线域没有时间驱动的执行者）。
 *
 * 用法（凭据只从环境变量来，⛔ 不接受 argv 里的连接串，也不回显 DSN）：
 *
 *   $env:DATABASE_URL = 'postgresql://<user>:<pass>@<host>:5432/<db>'
 *   node tools/purge-expired-online-data.mjs                        # 默认 limit=200、单轮最多 5 页
 *   node tools/purge-expired-online-data.mjs --limit 50 --dry-run    # 只列到期请求，不删
 *   node tools/purge-expired-online-data.mjs --no-cursor             # 只跑一页（不读/不写进度）
 *
 * 或 `npm run purge:online-data -- --limit 50`（等价）。
 *
 * ## 它做的四件事（顺序固定）
 * 1. `SELECT now()` 取**一个**时刻作 cutoff（到期筛选、驱动内复核、证据三处同源，不各自读时钟）；
 * 2. 从**上一轮的游标之后**取到期请求（`online_due_at <= cutoff AND state <> 'completed'`，
 *    每页上限 `--limit`，默认 200、硬顶 5000）；
 * 3. 逐请求逐模块调四域 PG store 的既有清理原语（`purgeOwnerData` 优先，`conversations` 退回
 *    `deleteAllByOwner`），并在**同一轮里继续翻页**直到队尾或用满 `--max-batches`：
 *    成功行产出 `sha256:` 证据；一行失败只影响该行，**不阻塞**同请求其余模块、后续请求与后续页；
 * 4. 把"处理到哪一行"写回游标文件（`--dry-run` 不写；`--no-cursor` 不写也不读）。
 *
 * ## 批次为什么会推进（[P1] 监工 1021/1806 的闭环点）
 * 本命令⛔ 不改 `deletion_requests.state`，所以"已经清空的请求"在库里仍是非 `completed`，会一直排在
 * `(online_due_at, id)` 的队首。若每轮都"固定取最早 `--limit` 条"，超出上限的请求**永远进不了候选**
 * （饿死）。因此候选查询是 **keyset 分页**（`(date_trunc('milliseconds', online_due_at), id) > 游标`），
 * 进度存在**游标文件**里：下一轮从上一轮停下那行之后继续；走到队尾才清掉游标、从队首重扫（= 一整轮）。
 * 细节与"为什么不用 OFFSET"见 `services/api/src/privacy/online-purge-driver.ts` 文件头。
 *
 * ## 退出码（cron 的唯一判据）
 * - `0`：本轮没有失败行（**含 0 个到期请求**——重复跑第二次就是 `already_purged` + 0 行）；
 * - `1`：有失败行（某个模块清不掉，需要人看）；
 * - `2`：参数/配置/连接类错误（缺 `DATABASE_URL`、`--limit` 非法、缺表 42P01、缺列级授权 42501…）。
 *
 * ## 为什么不用 `setInterval`
 * 到期是**日历事实**（`deletion_requests.online_due_at`），不是"进程活了多久"。常驻定时器在多副本会
 * 重复执行、重启会丢语义、还会与 CI/真库臂抢时钟；外部 cron / systemd timer 反复调用本命令才是正确形态
 * （与 30 日副本命令 `tools/purge-expired-backup-copies.mjs` 同一套理由）。
 *
 * ## 明确不做的事
 * - ⛔ 不改 `deletion_requests.state`，也不改写回执 —— 完成判定只归协调器（`packages/privacy/deletion.mjs`）；
 * - ⛔ 不改迁移、不加任何 SQL 授权（运行时角色已有四域 DELETE；`deletion_requests` 的读取走属主/运维角色，
 *   见证据页待裁决项）；
 * - ⛔ 不删备份副本行（那是 `purge:backup-copies` 的 30 日窗口，两件事不合并）。
 */
import { parseArgs } from 'node:util';

import { createPool } from '../services/api/src/db/pool.ts';
import { createPostgresConversationStore } from '../services/api/src/conversations/store-pg.ts';
import { createPostgresFavoritesStore } from '../services/api/src/favorites/store-pg.ts';
import { createPostgresHistoryStore } from '../services/api/src/history/store-pg.ts';
import { createPostgresMessagesStore } from '../services/api/src/messages/store-pg.ts';
import {
  DEFAULT_ONLINE_PURGE_BATCH_LIMIT,
  DEFAULT_ONLINE_PURGE_MAX_BATCHES,
  MAX_ONLINE_PURGE_BATCH_LIMIT,
  MAX_ONLINE_PURGE_MAX_BATCHES,
  drainDueOnlineDeletions,
  formatOnlinePurgeReport,
  listDueOnlineDeletions,
  normalizeOnlinePurgeLimit,
  normalizeOnlinePurgeMaxBatches,
  onlinePurgeExitCode,
} from '../services/api/src/privacy/online-purge-driver.ts';
import {
  ONLINE_PURGE_CURSOR_ENV,
  readOnlinePurgeCursor,
  resolveOnlinePurgeCursorPath,
  writeOnlinePurgeCursor,
} from '../services/api/src/privacy/online-purge-cursor.ts';
import { USER_DATA_DELETION_MODULES } from '../services/api/src/privacy/user-data-deletion.ts';

const TAG = '[purge-expired-online-data]';
const USAGE = `${TAG} 用法：
  DATABASE_URL=postgresql://… node tools/purge-expired-online-data.mjs [--limit N] [--max-batches N] [--cursor-file PATH | --no-cursor] [--dry-run]
  --limit N        每页最多处理多少个「注销请求」（默认 ${DEFAULT_ONLINE_PURGE_BATCH_LIMIT}，上限 ${MAX_ONLINE_PURGE_BATCH_LIMIT}）
  --max-batches N  单轮最多推进几页（默认 ${DEFAULT_ONLINE_PURGE_MAX_BATCHES}，上限 ${MAX_ONLINE_PURGE_MAX_BATCHES}）；
                   用满仍未到队尾时，下一轮从游标之后继续（不回到队首）
  --cursor-file P  跨轮游标文件（默认 ./.gengyun-online-purge-cursor.json，也可用 ${ONLINE_PURGE_CURSOR_ENV}）
  --no-cursor      不读也不写游标（等价于只跑一页：--max-batches 按 1 执行）
  --dry-run        只列到期请求，不删除（仍打印读数与退出码；不写游标）
  连接串只从环境变量 DATABASE_URL 读取（⛔ 不接受命令行明文，也不回显）。`;

function usageError(message) {
  console.error(`${TAG} ${message}`);
  console.error(USAGE);
  process.exitCode = 2;
}

/** 连接/权限/缺表等**运维可自解**的错误：给出固定分类，不泄露驱动原文（可能带主机/用户名）。 */
function configErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  switch (code) {
    case '42P01':
      return '缺少 public.deletion_requests（或四域表）：迁移未执行（不是「没有到期请求」）';
    case '42501':
      return '当前连接角色缺少 deletion_requests 的读取权限：本命令需属主/运维角色（'
        + '运行时角色对该表零权限，这是 90-assert-least-privilege 的有意设计）';
    case '3D000':
      return '目标数据库不存在';
    case '28P01':
    case '28000':
      return '数据库认证失败';
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ECONNRESET':
      return '连不上数据库（网络/端口/主机名）';
    case 'ETIMEDOUT':
      return '数据库连接超时';
    case 'EACCES':
    case 'EPERM':
      return '文件权限不足（游标文件或它的临时目录写不进去）';
    case 'ENOTDIR':
      return '游标文件路径里有一段不是目录';
    default:
      return code === '' ? '未知错误' : `数据库错误（SQLSTATE ${code}）`;
  }
}

/**
 * 四域清理端口的装配。
 *
 * 与 `services/api/src/privacy/user-data-deletion.ts` 的 `makeHandler` 同口径：
 * `purgeOwnerData` 优先（能同时报出正文行与幂等台账行），缺它才退回 `deleteAllByOwner`
 * （只有正文行数，台账计 0 —— 这是**已知**覆盖差异，不假装台账也清了）。
 */
function createFourDomainPurgePort(pool) {
  const stores = new Map([
    ['favorites', createPostgresFavoritesStore(pool)],
    ['history', createPostgresHistoryStore(pool)],
    ['messages', createPostgresMessagesStore({ pool })],
    ['conversations', createPostgresConversationStore(pool)],
  ]);

  return {
    async purgeModule({ userId, module }) {
      const store = stores.get(module);
      if (store === undefined) {
        // 闭集外的模块名意味着调用方与 `USER_DATA_DELETION_MODULES` 脱钩了：直接拒绝，不猜要删什么。
        const error = new Error(`未知的必需模块：${module}`);
        error.code = 'STORE_REJECTED';
        throw error;
      }
      if (typeof store.purgeOwnerData === 'function') {
        const counts = await store.purgeOwnerData(userId);
        return { removed: counts.records, idempotency: counts.idempotency };
      }
      const removed = await store.deleteAllByOwner(userId);
      return { removed, idempotency: 0 };
    },
  };
}

let pool = null;
try {
  const { values } = parseArgs({
    options: {
      limit: { type: 'string' },
      'max-batches': { type: 'string' },
      'cursor-file': { type: 'string' },
      'no-cursor': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    process.exitCode = 0;
  } else {
    let limit = DEFAULT_ONLINE_PURGE_BATCH_LIMIT;
    if (values.limit !== undefined) {
      // 只接受十进制整数字面量：`--limit 5.5` / `--limit 2e3` / `--limit abc` 一律报错，不猜。
      if (!/^\d+$/.test(values.limit)) {
        usageError(`--limit 必须是十进制正整数（收到 ${values.limit}）`);
      } else {
        try {
          limit = normalizeOnlinePurgeLimit(Number(values.limit));
        } catch (error) {
          usageError(error.message);
        }
      }
    }

    let maxBatches = DEFAULT_ONLINE_PURGE_MAX_BATCHES;
    if (values['max-batches'] !== undefined) {
      if (!/^\d+$/.test(values['max-batches'])) {
        usageError(`--max-batches 必须是十进制正整数（收到 ${values['max-batches']}）`);
      } else {
        try {
          maxBatches = normalizeOnlinePurgeMaxBatches(Number(values['max-batches']));
        } catch (error) {
          usageError(error.message);
        }
      }
    }

    // `--no-cursor` = 明确关掉跨轮进度：只跑一页，不读也不写游标文件。
    // 它与 `--cursor-file` 互斥（同时给就是想不清要写哪儿），直接报错而不是猜一个。
    let cursorPath = null;
    if (values['no-cursor']) {
      if (values['cursor-file'] !== undefined) {
        usageError('--cursor-file 与 --no-cursor 不能同时给（一个要写进度、一个明确不写）');
      }
      maxBatches = 1;
    } else if (process.exitCode !== 2) {
      try {
        cursorPath = resolveOnlinePurgeCursorPath({
          argv: values['cursor-file'],
          env: process.env,
          cwd: process.cwd(),
        });
      } catch (error) {
        usageError(error.message);
      }
    }

    if (process.exitCode !== 2) {
      const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';
      if (databaseUrl === '') {
        usageError('缺少 DATABASE_URL（在线到期清除需要真实库连接；未配置时拒绝运行，不假装跑过）');
      } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
        usageError('DATABASE_URL 必须是 postgres:// 或 postgresql:// 连接串');
      } else {
        pool = createPool(databaseUrl);
        if (pool === null) {
          usageError('数据库连接池未建立（createPool 返回 null）');
        }
      }
    }

    if (process.exitCode !== 2 && pool !== null) {
      // ---- 1. 一次取定的 cutoff（库时钟，运维不用信本机时钟） ----
      const cutoffRow = (await pool.query('SELECT now() AS cutoff')).rows[0];
      const cutoff = new Date(cutoffRow.cutoff);

      // ---- 2. 读上一轮的游标（命令侧状态；坏了就说清楚，然后从队首重扫） ----
      let cursor = null;
      if (cursorPath === null) {
        console.log(`${TAG} --no-cursor：只跑一页（--max-batches 按 1 执行），不读也不写跨轮进度`);
      } else {
        const read = readOnlinePurgeCursor(cursorPath);
        if (read.kind === 'invalid') {
          console.error(`${TAG} 游标文件不可用，本轮从队首重扫：${read.problem}｜${cursorPath}`);
          cursor = null;
        } else {
          cursor = read.cursor;
          if (cursor === null) console.log(`${TAG} 游标文件 ${cursorPath}｜从队首开始（上一轮已走完一整轮）`);
          else {
            console.log(
              `${TAG} 游标文件 ${cursorPath}｜从 request=${cursor.afterRequestId}（online_due_at=${cursor.afterDueAt}）之后继续`,
            );
          }
        }
      }

      // ---- 3. 从游标之后连续翻页清除（同一轮里推进到队尾或用满 --max-batches） ----
      const report = await drainDueOnlineDeletions({
        cutoff,
        limit,
        maxBatches,
        dryRun: values['dry-run'],
        modules: USER_DATA_DELETION_MODULES,
        purge: createFourDomainPurgePort(pool),
        after: cursor,
        fetchPage: (page) => listDueOnlineDeletions(pool, page),
      });

      for (const line of formatOnlinePurgeReport(report)) console.log(line);
      if (report.candidates === 0) {
        console.log(`${TAG} 没有到期的注销请求（7 日窗口未到，或到期请求都已清过），本轮无需动作`);
      }

      // ---- 4. 落游标（dry-run 一行都没清 ⇒ 进度不能算数；--no-cursor 明确不写） ----
      if (cursorPath !== null) {
        if (values['dry-run']) {
          console.log(`${TAG} dry-run：不写游标文件（进度只在真清除时才有意义）`);
        } else {
          writeOnlinePurgeCursor(cursorPath, report.nextCursor, new Date());
          console.log(
            report.nextCursor === null
              ? `${TAG} 游标已清：本轮走到队尾，下一轮从队首重扫（= 一整轮）`
              : `${TAG} 游标已更新：下一轮从 request=${report.nextCursor.afterRequestId} 之后继续｜${cursorPath}`,
          );
        }
      }
      process.exitCode = onlinePurgeExitCode(report);
    }
  }
} catch (error) {
  // 参数解析失败（parseArgs 自己抛）/ 连接与扫描失败：固定分类 + 退出码 2，不回显原始 message。
  if (typeof error?.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS')) {
    usageError(`命令行参数非法（${error.code}）`);
  } else {
    console.error(`${TAG} ${configErrorCode(error)}`);
    process.exitCode = 2;
  }
} finally {
  await pool?.end().catch(() => {});
}
