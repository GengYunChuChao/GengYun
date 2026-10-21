#!/usr/bin/env node
/**
 * GY-R28 · W6（#19）· **在线数据 7 日到期清除**的运维驱动命令（缺口：在线域没有时间驱动的执行者）。
 *
 * 用法（凭据只从环境变量来，⛔ 不接受 argv 里的连接串，也不回显 DSN）：
 *
 *   $env:DATABASE_URL = 'postgresql://<user>:<pass>@<host>:5432/<db>'
 *   node tools/purge-expired-online-data.mjs                        # 默认 limit=200
 *   node tools/purge-expired-online-data.mjs --limit 50 --dry-run    # 只列到期请求，不删
 *
 * 或 `npm run purge:online-data -- --limit 50`（等价）。
 *
 * ## 它做的三件事（顺序固定）
 * 1. `SELECT now()` 取**一个**时刻作 cutoff（到期筛选、驱动内复核、证据三处同源，不各自读时钟）；
 * 2. 按 `online_due_at <= cutoff AND state <> 'completed'` 取到期请求（每批上限 `--limit`，默认 200、硬顶 5000）；
 * 3. 逐请求逐模块调四域 PG store 的既有清理原语（`purgeOwnerData` 优先，`conversations` 退回
 *    `deleteAllByOwner`）：成功行产出 `sha256:` 证据；一行失败只影响该行，**不阻塞**同请求其余模块
 *    与后续请求。
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
  MAX_ONLINE_PURGE_BATCH_LIMIT,
  formatOnlinePurgeReport,
  listDueOnlineDeletions,
  normalizeOnlinePurgeLimit,
  onlinePurgeExitCode,
  runOnlinePurgeBatch,
} from '../services/api/src/privacy/online-purge-driver.ts';
import { USER_DATA_DELETION_MODULES } from '../services/api/src/privacy/user-data-deletion.ts';

const TAG = '[purge-expired-online-data]';
const USAGE = `${TAG} 用法：
  DATABASE_URL=postgresql://… node tools/purge-expired-online-data.mjs [--limit N] [--dry-run]
  --limit N   每批最多处理多少个「注销请求」（默认 ${DEFAULT_ONLINE_PURGE_BATCH_LIMIT}，上限 ${MAX_ONLINE_PURGE_BATCH_LIMIT}）
  --dry-run   只列到期请求，不删除（仍打印读数与退出码）
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

      // ---- 2. 到期扫描（只读；只取 online_due_at 已到的请求） ----
      const { requests, totalDue } = await listDueOnlineDeletions(pool, { cutoff, limit });

      // ---- 3. 逐请求逐模块清除（端口不绑时钟：到期判定只由驱动按同一个 cutoff 做） ----
      const report = await runOnlinePurgeBatch({
        cutoff,
        limit,
        requests,
        totalDue,
        dryRun: values['dry-run'],
        modules: USER_DATA_DELETION_MODULES,
        purge: createFourDomainPurgePort(pool),
      });

      for (const line of formatOnlinePurgeReport(report)) console.log(line);
      if (report.candidates === 0) {
        console.log(`${TAG} 没有到期的注销请求（7 日窗口未到，或到期请求都已清过），本轮无需动作`);
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
