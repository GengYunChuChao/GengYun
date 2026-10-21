#!/usr/bin/env node
/**
 * GY-I19（#19）· 备份副本 30 日到期清除的**运维驱动命令**（缺口 G9 / P0-4）。
 *
 * 用法（凭据只从环境变量来，⛔ 不接受 argv 里的连接串，也不回显 DSN）：
 *
 *   $env:DATABASE_URL = 'postgresql://<user>:<pass>@<host>:5432/<db>'   # 运行时角色即可，无需属主
 *   node tools/purge-expired-backup-copies.mjs                       # 默认 limit=200
 *   node tools/purge-expired-backup-copies.mjs --limit 50 --dry-run   # 只列不清
 *   node tools/purge-expired-backup-copies.mjs --retry-failed         # 显式重排 failed 行后再清
 *
 * 或 `npm run purge:backup-copies -- --limit 50`（等价）。
 *
 * ## 它做的三件事（顺序固定）
 * 1. `SELECT now()` 取**一个**时刻作 cutoff（枚举/复核/端口时钟三处同源，不各自读时钟）；
 * 2. 按 `state <> 'purged' AND retention_until <= cutoff` 取到期组（整组到期才取，见驱动模块注释），
 *    每批上限 `--limit`（默认 200，硬顶 5000）；
 * 3. 逐组调既有端口 `createPostgresBackupPurgePort().purge({ userId, module, requestId })`：
 *    成功即 ``payload='null'`` + `state='purged'` + 证据摘要落库（端口内同事务复核）；
 *    失败只影响该组（端口写 `failed`/`last_error_code`/`purge_attempts+1`），**不阻塞后面的组**。
 *
 * ## 退出码（cron 的唯一判据）
 * - `0`：本轮没有失败组，也没有待显式重排的 `failed` 行（**含 0 组可做**——重复跑第二次就是 0 组）；
 * - `1`：有失败组，或存在 `failed_needs_requeue`（有副本行清不掉，需要人看）；
 * - `2`：参数/配置/连接类错误（缺 `DATABASE_URL`、`--limit` 非法、缺表 42P01、缺列级授权 42501…）。
 *
 * ## 明确不做的事
 * - ⛔ 不用 `setInterval` 常驻定时；本命令由外部 cron / systemd timer 反复调用。
 * - ⛔ 不改 `BACKUP_COPY_SCOPES`（消息域纳入是另一片）、不改迁移、不加任何 SQL 授权。
 * - ⛔ 不改写 `deletion_requests` 与任何回执状态（回执 `backupState` 的接线是 G11/G5 的另一片）。
 */
import { parseArgs } from 'node:util';

import { createPool } from '../services/api/src/db/pool.ts';
import { createPostgresBackupPurgePort } from '../services/api/src/privacy/backup-copies-pg.ts';
import {
  DEFAULT_BACKUP_PURGE_BATCH_LIMIT,
  MAX_BACKUP_PURGE_BATCH_LIMIT,
  backupPurgeExitCode,
  formatBackupPurgeReport,
  listDueBackupCopyGroups,
  normalizeBackupPurgeLimit,
  requeueFailedBackupCopyGroup,
  runBackupPurgeBatch,
} from '../services/api/src/privacy/backup-purge-driver.ts';

const TAG = '[purge-expired-backup-copies]';
const USAGE = `${TAG} 用法：
  DATABASE_URL=postgresql://… node tools/purge-expired-backup-copies.mjs [--limit N] [--dry-run] [--retry-failed]
  --limit N       每批最多处理多少个「(受理, 主体, 模块)」组（默认 ${DEFAULT_BACKUP_PURGE_BATCH_LIMIT}，上限 ${MAX_BACKUP_PURGE_BATCH_LIMIT}）
  --dry-run       只列到期组，不清除（仍打印读数与退出码）
  --retry-failed  把已到期组的 failed 行显式重排为 pending_purge 后再清（默认跳过并计入 failed_needs_requeue）
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
      return '缺少 public.user_backup_copies：迁移 0023 未执行（不是「没有到期副本」）';
    case '42501':
      return '运行时角色缺少 user_backup_copies 的列级 SELECT/UPDATE：'
        + '核对 20-login-roles.sql 的 gy-i19-backup-copies-grant 是否已执行';
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

let pool = null;
try {
  const { values } = parseArgs({
    options: {
      limit: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'retry-failed': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    process.exitCode = 0;
  } else {
    let limit = DEFAULT_BACKUP_PURGE_BATCH_LIMIT;
    if (values.limit !== undefined) {
      // 只接受十进制整数字面量：`--limit 5.5` / `--limit 2e3` / `--limit abc` 一律报错，不猜。
      if (!/^\d+$/.test(values.limit)) {
        usageError(`--limit 必须是十进制正整数（收到 ${values.limit}）`);
      } else {
        try {
          limit = normalizeBackupPurgeLimit(Number(values.limit));
        } catch (error) {
          usageError(error.message);
        }
      }
    }

    if (process.exitCode !== 2) {
      const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';
      if (databaseUrl === '') {
        usageError('缺少 DATABASE_URL（备份副本到期清除需要真实库连接；未配置时拒绝运行，不假装跑过）');
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

      // ---- 2. 到期扫描（只读；走 0023 的部分索引） ----
      const { groups, totalDue, mixedGroups } = await listDueBackupCopyGroups(pool, { cutoff, limit });

      // ---- 3. 逐组清除（端口时钟钉在同一个 cutoff 上，避免两个时钟打架） ----
      const port = createPostgresBackupPurgePort({ pool, now: () => cutoff });
      const report = await runBackupPurgeBatch({
        cutoff,
        groups,
        limit,
        totalDue,
        mixedGroups,
        retryFailed: values['retry-failed'],
        dryRun: values['dry-run'],
        purge: (input) => port.purge(input),
        requeue: ({ requestId, userId, module }) =>
          requeueFailedBackupCopyGroup(pool, { requestId, userId, module, cutoff }),
      });

      for (const line of formatBackupPurgeReport(report)) console.log(line);
      if (report.candidates === 0) {
        console.log(`${TAG} 没有到期的备份副本行（此前已清或 30 日窗口未到），本轮无需动作`);
      }
      process.exitCode = backupPurgeExitCode(report);
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
