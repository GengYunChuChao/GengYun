#!/usr/bin/env node
/**
 * GY-R34 · **保留策略执行器**（声明式策略表 → 分批清理/匿名化/归档标记）。
 *
 * 策略本体在 `packages/privacy/retention-policy.mjs`（本文件一行表名都不硬编码：
 * 表名/列名/天数/处理方式全部来自策略表，⛔ 不接受命令行传表名以外的任何结构）。
 *
 * ## 用法（默认 **dry-run**；真执行必须显式 `--yes`）
 *
 *   $env:DATABASE_URL = 'postgresql://<user>:<pass>@<host>:5432/<db>'   # ⛔ 不回显、不接受命令行明文
 *   node tools/purge-retention-expired.mjs                     # 默认 dry-run：只数到期行，一行不改
 *   node tools/purge-retention-expired.mjs --yes               # 真执行（每批 ≤500 行）
 *   node tools/purge-retention-expired.mjs --yes --batch 200 --max-batches 5
 *   node tools/purge-retention-expired.mjs --json --yes        # 末行输出一份机读报告（审计留档）
 *   node tools/purge-retention-expired.mjs --table public.sessions   # 只跑一张表（可重复）
 *
 * 或 `npm run purge:retention -- --yes`（等价）。
 *
 * ## 幂等与可重入（三件事各自成立，缺一条就会造出伪读数）
 *
 * 1. **每批一条变更语句**：`DELETE/UPDATE … WHERE ctid IN (SELECT ctid … LIMIT $2)`，
 *    执行器把它包进显式 `BEGIN … COMMIT`（一批一个事务），因此**一批要么全生效、要么全不生效**；
 *    进程在中途被杀只会丢「正在跑的那一批」，已提交的批次不回滚。
 * 2. **重跑从剩余行继续**：判据是「年龄列 < cutoff」＋（匿名化/标记还要）「目标列仍为空/非空」，
 *    已处理的行**不再匹配**，所以第二次跑必然 0 行 —— 这正是真库臂断言的
 *    「重复执行第二次删 0 行」。
 * 3. **失败可重入**：单表失败只记该表的失败码并继续下一张表（不整体中断、不回滚别的表的已提交批次），
 *    进程退出码 1 让 cron 报警；修好权限/缺表后原样重跑即可，不需要手工对账。
 *
 * ## 单批上限 500 行
 *
 * 硬顶 `MAX_RETENTION_BATCH_LIMIT = 500`（`packages/privacy/retention-policy.mjs`）：
 * `--batch 5000` 直接报错（退出码 2），**静默截断**会让运维以为大事务生效了。
 * `--max-batches` 限制单表单轮最多推几批（默认 10），跑不完下一轮继续 —— 与
 * `tools/purge-expired-online-data.mjs` 的 `--max-batches` 同一套理由（不把库跑满）。
 *
 * ## 退出码（cron 的唯一判据）
 *
 * - `0`：本次没有失败表（**含 0 行到期** —— 重复跑第二次就是全 0 行）；
 * - `1`：有表失败（权限/缺表/缺列/SQL 错误），需要人看；
 * - `2`：参数/配置/连接类错误（缺 `DATABASE_URL`、`--batch` 越界、`--dry-run` 与 `--yes` 同时给…）。
 *
 * ## 明确不做的事
 *
 * - ⛔ 不改迁移、不动任何角色授权：`public.sessions` 的 `DELETE` 没授予运行时角色
 *   （`services/api/db/roles/auth_privacy.sql:24-26` 只有列级 SELECT/INSERT/UPDATE，这是有意设计），
 *   所以本命令要用**属主/运维连接串**跑；`public.idempotency_keys` 反过来对运行时角色已开
 *   `GRANT SELECT,INSERT,DELETE`（同文件 `:33`）。本命令只声明这些前提，不替任何角色扩权。
 * - ⛔ 不与 `services/api/src/auth/idempotency.ts` 的即时清扫抢语义：那里按 `expires_at` 清过期
 *   幂等键是**请求路径上的顺手清理**（`:233-236` 的 `purge`、`:261` 的 `claim` 先删同键过期行），
 *   本命令是**离线兜底**：把同一判据纳入统一台账、带 dry-run 与读数。两者判据一致
 *   （`expires_at < cutoff` 与 `<= now()`），所以不会互相「复活」任何行——谁先删都一样。
 * - ⛔ 不合并既有的两条域专用命令（`purge:online-data` / `purge:backup-copies`）：
 *   它们的判据是注销工单，不是表的日历保留期；
 * - ⛔ 不读系统时钟：cutoff 一律取库时钟 `SELECT now()`，证据链里只有一个时刻源。
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createPool } from '../services/api/src/db/pool.ts';
import {
  DEFAULT_RETENTION_BATCH_LIMIT,
  DEFAULT_RETENTION_MAX_BATCHES,
  RETENTION_POLICY,
  RETENTION_POLICY_ID,
  assertRetentionPolicy,
  buildRetentionCountSql,
  buildRetentionMutationSql,
  normalizeRetentionBatchLimit,
  normalizeRetentionMaxBatches,
  retentionCutoffIso,
} from '../packages/privacy/retention-policy.mjs';

export const TAG = '[purge-retention-expired]';

/** 退出码（与 `tools/purge-expired-online-data.mjs` 同一套约定：0/1/2）。 */
export const RETENTION_PURGE_EXIT = Object.freeze({ OK: 0, FAILED: 1, CONFIG: 2 });

/**
 * 失败码闭集（稳定、可断言、不含 SQL 原文 —— 驱动 message 可能带主机/用户名）。
 *
 * `AUDIT_IMMUTABLE` 是为 `public.admin_audit_events` 预留的读数：迁移 0017 的 append-only
 * 触发器抛 SQLSTATE `G0006`。当前策略表**不登记**该表（见 `RETENTION_EXCLUSIONS`），
 * 一旦有人误加，这里会把原因如实印出来而不是当成通用失败。
 */
export const RETENTION_PURGE_FAILURES = Object.freeze({
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  MISSING_TABLE: 'MISSING_TABLE',
  MISSING_COLUMN: 'MISSING_COLUMN',
  AUDIT_IMMUTABLE: 'AUDIT_IMMUTABLE',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  UNCLASSIFIED: 'UNCLASSIFIED',
});

/**
 * 把驱动错误归一成失败码（只读 `error.code`，绝不回显 message）。
 *
 * @param {unknown} error
 * @returns {string}
 */
export function classifyRetentionFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  switch (code) {
    case '42501':
      return RETENTION_PURGE_FAILURES.PERMISSION_DENIED;
    case '42P01':
      return RETENTION_PURGE_FAILURES.MISSING_TABLE;
    case '42703':
      return RETENTION_PURGE_FAILURES.MISSING_COLUMN;
    case 'G0006':
      return RETENTION_PURGE_FAILURES.AUDIT_IMMUTABLE;
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ECONNRESET':
    case 'ETIMEDOUT':
    case '28P01':
    case '28000':
    case '3D000':
      return RETENTION_PURGE_FAILURES.CONNECTION_FAILED;
    default:
      return RETENTION_PURGE_FAILURES.UNCLASSIFIED;
  }
}

/**
 * 按策略表逐表清理。
 *
 * @param {object} input
 * @param {() => Promise<{ query: (text: string, params?: ReadonlyArray<unknown>) => Promise<any>, release?: () => void }>} input.connect
 *   取一个**独占连接**（一批一个事务，必须同一连接上 BEGIN/COMMIT）
 * @param {string | number | Date} input.now 本次运行的唯一时刻（执行器自身不读时钟）
 * @param {boolean} [input.dryRun] 默认 `true`（默认 dry-run 是刻意的：手滑不会删数据）
 * @param {number} [input.batchLimit] 单批行数上限（1..500）
 * @param {number} [input.maxBatches] 单表单轮批数上限（1..50）
 * @param {ReadonlyArray<any>} [input.policy] 策略表（默认仓内 `RETENTION_POLICY`）
 * @param {ReadonlyArray<string> | null} [input.onlyTables] 只跑这些表（表名必须在策略里）
 * @param {(line: string) => void} [input.log] 逐行输出（默认丢弃；CLI 传 console.log）
 * @returns {Promise<object>} 运行报告（`entries[]` + `totals`）
 */
export async function runRetentionPurge({
  connect,
  now,
  dryRun = true,
  batchLimit = DEFAULT_RETENTION_BATCH_LIMIT,
  maxBatches = DEFAULT_RETENTION_MAX_BATCHES,
  policy = RETENTION_POLICY,
  onlyTables = null,
  log = () => {},
} = {}) {
  if (typeof connect !== 'function') {
    throw new TypeError('runRetentionPurge 需要 connect()：取一个独占连接才能保证一批一个事务');
  }
  const batch = normalizeRetentionBatchLimit(batchLimit);
  const maxRounds = normalizeRetentionMaxBatches(maxBatches);
  assertRetentionPolicy(policy);

  const wanted = onlyTables === null ? null : new Set(onlyTables);
  if (wanted !== null) {
    const known = new Set(policy.map((entry) => entry.table));
    for (const table of wanted) {
      if (!known.has(table)) {
        throw new RangeError(`--table ${table} 不在保留策略表里（未知表名不做任何猜测）`);
      }
    }
  }
  const entries = policy.filter((entry) => wanted === null || wanted.has(entry.table));

  const report = {
    policy: RETENTION_POLICY_ID,
    dry_run: dryRun === true,
    batch_limit: batch,
    max_batches: maxRounds,
    entries: [],
    totals: { tables: entries.length, batches: 0, rows: 0, failures: 0, drained: 0 },
  };

  const client = await connect();
  try {
    for (const entry of entries) {
      const cutoff = retentionCutoffIso({ now, retentionDays: entry.retentionDays });
      const record = {
        table: entry.table,
        disposition: entry.disposition,
        retention_days: entry.retentionDays,
        basis: entry.basis,
        basis_ref: entry.basisRef,
        age_column: entry.ageColumn,
        target_column: entry.targetColumn,
        revision_column: entry.revisionColumn ?? null,
        cutoff,
        batches: 0,
        rows: 0,
        drained: false,
        error: null,
      };
      report.entries.push(record);
      log(
        `table=${entry.table} disposition=${entry.disposition} retention_days=${entry.retentionDays}`
          + ` basis=${entry.basis} cutoff=${cutoff}`,
      );

      try {
        if (dryRun === true) {
          // dry-run 只发**读**语句：一条 count，不 BEGIN、不写库。
          const counted = await client.query(buildRetentionCountSql(entry), [cutoff]);
          record.rows = Number(counted?.rows?.[0]?.due ?? 0);
          record.drained = true;
          report.totals.drained += 1;
          // dry-run 的 rows 是「**到期**行数」而不是「已处理」行数；SUMMARY 照样累计，
          // 否则 dry-run 的汇总恒为 0，运维看不出压了多少活（批数仍保持 0）。
          report.totals.rows += record.rows;
          log(`  dry-run table=${entry.table} due=${record.rows}（未删除、未写入）`);
        } else {
          for (let round = 0; round < maxRounds; round += 1) {
            await client.query('BEGIN');
            let mutated;
            try {
              mutated = await client.query(buildRetentionMutationSql(entry), [cutoff, batch]);
              await client.query('COMMIT');
            } catch (error) {
              // 回滚失败不掩盖原始错误（原始错误才是要报出来的那个）。
              await client.query('ROLLBACK').catch(() => {});
              throw error;
            }
            const affected = Number(mutated?.rowCount ?? 0);
            record.batches += 1;
            record.rows += affected;
            report.totals.batches += 1;
            report.totals.rows += affected;
            log(
              `  batch=${record.batches} table=${entry.table} rows=${affected}`
                + ` cutoff=${cutoff} tx=committed`,
            );
            if (affected < batch) {
              record.drained = true;
              report.totals.drained += 1;
              break;
            }
          }
          if (!record.drained) {
            log(
              `  table=${entry.table} 用满 --max-batches=${maxRounds} 仍未吃完：下一轮从剩余行继续（不改判据）`,
            );
          }
        }
      } catch (error) {
        record.error = classifyRetentionFailure(error);
        report.totals.failures += 1;
        log(`  FAIL table=${entry.table} code=${record.error}`);
      }
    }
  } finally {
    if (typeof client?.release === 'function') client.release();
  }

  return report;
}

/**
 * 报告文本（运维读的那一面：表 → 天数 → 依据 → 批数 → 行数）。
 *
 * @param {object} report
 * @returns {string[]}
 */
export function formatRetentionPurgeReport(report) {
  const mode = report.dry_run ? 'dry-run（未写库）' : 'execute';
  const lines = [
    `${TAG} policy=${report.policy} mode=${mode} batch=${report.batch_limit} max-batches=${report.max_batches}`,
  ];
  for (const entry of report.entries) {
    const head = `  · ${entry.table}｜${entry.disposition}｜留 ${entry.retention_days} 天（${entry.age_column}）`
      + `｜依据 ${entry.basis} ${entry.basis_ref}｜cutoff ${entry.cutoff}`;
    if (entry.error !== null) {
      lines.push(`${head}｜FAIL ${entry.error}`);
    } else if (report.dry_run) {
      lines.push(`${head}｜到期 ${entry.rows} 行（dry-run）`);
    } else {
      lines.push(`${head}｜删/改 ${entry.rows} 行｜批 ${entry.batches}｜${entry.drained ? '已吃完' : '未吃完'}`);
    }
  }
  lines.push(
    `${TAG} SUMMARY tables=${report.totals.tables} batches=${report.totals.batches}`
      + ` rows=${report.totals.rows} drained=${report.totals.drained} failures=${report.totals.failures}`
      + ` mode=${report.dry_run ? 'dry-run' : 'execute'}`,
  );
  return lines;
}

/**
 * @param {object} report
 * @returns {0 | 1}
 */
export function retentionPurgeExitCode(report) {
  return report.totals.failures > 0 ? RETENTION_PURGE_EXIT.FAILED : RETENTION_PURGE_EXIT.OK;
}

const USAGE = `${TAG} 用法：
  DATABASE_URL=postgresql://… node tools/purge-retention-expired.mjs [--yes] [--batch N] [--max-batches N] [--table T …] [--json]
  （默认 --dry-run：只数到期行，一行不改；真执行必须显式 --yes）
  --dry-run        显式声明 dry-run（与默认一致；与 --yes 互斥）
  --yes            真执行（每批 ≤${DEFAULT_RETENTION_BATCH_LIMIT} 行，一批一个事务）
  --batch N        单批行数上限（1..${DEFAULT_RETENTION_BATCH_LIMIT}）
  --max-batches N  单表单轮最多推几批（默认 ${DEFAULT_RETENTION_MAX_BATCHES}）
  --table T        只跑这些表（可重复；表名必须在策略表里）
  --json           末行输出机读报告（审计留档；含 cutoff 与逐表行数，不含连接串）
  连接串只从环境变量 DATABASE_URL 读取（⛔ 不接受命令行明文，也不回显）。`;

/**
 * CLI 主体（导出仅为单测；`node tools/…` 时会自己跑）。
 *
 * @param {ReadonlyArray<string>} argv
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = process.argv.slice(2)) {
  let pool = null;
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        batch: { type: 'string' },
        'max-batches': { type: 'string' },
        table: { type: 'string', multiple: true, default: [] },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });

    if (values.help) {
      console.log(USAGE);
      return RETENTION_PURGE_EXIT.OK;
    }

    // 「显式 dry-run」与「显式 --yes」同时给，说明调用方想不清要干哪样：报错，不替它选。
    if (values['dry-run'] && values.yes) {
      return usageError('--dry-run 与 --yes 不能同时给（一个明确不写库、一个明确要写库）');
    }
    const dryRun = values.yes !== true;

    let batchLimit = DEFAULT_RETENTION_BATCH_LIMIT;
    if (values.batch !== undefined) {
      if (!/^\d+$/.test(values.batch)) {
        return usageError(`--batch 必须是十进制正整数（收到 ${values.batch}）`);
      }
      try {
        batchLimit = normalizeRetentionBatchLimit(Number(values.batch));
      } catch (error) {
        return usageError(error.message);
      }
    }

    let maxBatches = DEFAULT_RETENTION_MAX_BATCHES;
    if (values['max-batches'] !== undefined) {
      if (!/^\d+$/.test(values['max-batches'])) {
        return usageError(`--max-batches 必须是十进制正整数（收到 ${values['max-batches']}）`);
      }
      try {
        maxBatches = normalizeRetentionMaxBatches(Number(values['max-batches']));
      } catch (error) {
        return usageError(error.message);
      }
    }

    const onlyTables = values.table.length === 0 ? null : values.table;
    if (onlyTables !== null) {
      assertRetentionPolicy(RETENTION_POLICY);
      const known = new Set(RETENTION_POLICY.map((entry) => entry.table));
      for (const table of onlyTables) {
        if (!known.has(table)) {
          return usageError(`--table ${table} 不在保留策略表里（未知表名不做任何猜测）`);
        }
      }
    }

    const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';
    if (databaseUrl === '') {
      return usageError('缺少 DATABASE_URL（保留策略执行器需要真实库；未配置时拒绝运行，不假装跑过）');
    }
    if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
      return usageError('DATABASE_URL 必须是 postgres:// 或 postgresql:// 连接串');
    }
    pool = createPool(databaseUrl);
    if (pool === null) {
      return usageError('数据库连接池未建立（createPool 返回 null）');
    }

    const client = await pool.connect();
    let now;
    try {
      // 唯一时刻源：库时钟。dry-run 也读它 —— 读数必须能对得上「如果真跑会删哪一批」。
      now = (await client.query('SELECT now() AS now')).rows[0].now;
    } finally {
      client.release();
    }

    const report = await runRetentionPurge({
      connect: () => pool.connect(),
      now,
      dryRun,
      batchLimit,
      maxBatches,
      onlyTables,
      log: (line) => console.log(`${TAG} ${line}`),
    });

    for (const line of formatRetentionPurgeReport(report)) console.log(line);
    if (report.totals.rows === 0 && report.totals.failures === 0) {
      console.log(
        `${TAG} 没有到期行（重复执行第二次的预期读数；或留存窗口未到），本次无事可做`,
      );
    }
    if (values.json) console.log(JSON.stringify(report));
    return retentionPurgeExitCode(report);
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS')) {
      return usageError(`命令行参数非法（${error.code}）`);
    }
    console.error(`${TAG} ${describeFatal(error)}`);
    return RETENTION_PURGE_EXIT.CONFIG;
  } finally {
    await pool?.end().catch(() => {});
  }
}

/**
 * 致命错误的一句话说明（固定分类，不回显驱动原文）。
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeFatal(error) {
  const code = classifyRetentionFailure(error);
  switch (code) {
    case RETENTION_PURGE_FAILURES.MISSING_TABLE:
      return '缺少策略表里的某张表：迁移未执行到该版本（不是「没有到期行」）';
    case RETENTION_PURGE_FAILURES.PERMISSION_DENIED:
      return '当前连接角色权限不足：本命令需属主/运维角色（`public.sessions` 的 DELETE 未授予运行时角色，'
        + '`services/api/db/roles/auth_privacy.sql:24-26` 只有列级 SELECT/INSERT/UPDATE，这是有意设计）';
    case RETENTION_PURGE_FAILURES.CONNECTION_FAILED:
      return '连不上数据库或认证失败（网络/端口/库名/口令）';
    default:
      return code === RETENTION_PURGE_FAILURES.UNCLASSIFIED
        ? '执行失败（未知 SQLSTATE，需要人看）'
        : `执行失败（${code}）`;
  }
}

/**
 * @param {string} message
 * @returns {2}
 */
function usageError(message) {
  console.error(`${TAG} ${message}`);
  console.error(USAGE);
  return RETENTION_PURGE_EXIT.CONFIG;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  process.exitCode = await main();
}
