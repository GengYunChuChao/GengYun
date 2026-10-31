#!/usr/bin/env node
/**
 * GY-R72 · W15（#6 缺口 G1）· **媒体对象回收的运维执行者**。
 *
 * 缺口是什么：`services/api/src/media/service.ts` 的 `expireInitiated()`（`:225` 声明 / `:1412` 实现）
 * 与 `cleanupOrphans()`（`:237` 声明 / `:1424` 实现）**有实现、有单测、零生产调用者**（四处注释自认：
 * `service.ts:836`、`store.ts:133`、`store-pg.ts:472`、`privacy/user-data-deletion.ts:289/891/1018`）。
 * 本命令就是那个调用者：装配真实 PG 持久化端口 + 真实 S3 兼容对象端口，跑一轮
 * 「收到期 → 扫孤儿」，用退出码给 cron/systemd 一个判据。
 *
 * 用法（凭据只从环境变量来，⛔ 不接受 argv 里的连接串/密钥，也不回显任何配置值）：
 *
 *   $env:DATABASE_URL = 'postgresql://<user>:<pass>@<host>:5432/<db>'
 *   $env:MEDIA_OBJECT_REF_KEY = '<64 位十六进制 / base64 / 恰好 32 字节原串>'
 *   $env:OBJECT_STORAGE_ENDPOINT = 'https://cos.<region>.myqcloud.com'
 *   $env:OBJECT_STORAGE_BUCKET / _ACCESS_KEY / _SECRET_KEY = '…'
 *   node tools/purge-expired-media.mjs                    # 默认 limit=200
 *   node tools/purge-expired-media.mjs --dry-run --json    # 只读计数，不改任何数据
 *   node tools/purge-expired-media.mjs --limit 50
 *
 * 或 `npm run purge:media-objects -- --limit 50`（等价）。
 *
 * ## 它做的三件事（顺序固定）
 * 1. 装配：`createPool(DATABASE_URL)` → `createPostgresMediaStore({ pool, cipher })` →
 *    `createS3CompatibleObjectStore(readObjectStorageConfig(env))` → `createAppMediaService({ executionMode:'real', … })`。
 *    任一步不成立（缺环境变量、endpoint 非 https、密钥解不出 32 字节、对象存储未装配）⇒ **退出码 2**，
 *    ⛔ 绝不带着替身存储跑一轮然后报 0（那等于把「没装配」伪装成「没有到期」）。
 * 2. 调 `expireInitiated()`：把 `expiresAt <= now` 且仍 `initiated` 的记录收到 `rejected`；
 *    再调 `cleanupOrphans()`：删对象引用、撤访问授权、重试上一轮没确认掉的台账行。
 * 3. 打印读数（`formatMediaPurgeReport()`），按驱动层给的退出码退。
 *
 * ## `--limit` 的诚实语义（⛔ 别读成「一轮最多回收 N 条」）
 * **本域到期回收只能整批**：`expireInitiated()` 没有分批参数，一次调用就会把当时所有到期记录
 * 都收到 `rejected`。所以 `limit` 不是到期条数的上限，而是**两段之间的预算闸**——
 * `expired >= limit` 时本轮不进孤儿清扫，报告写 `truncated=true`，剩下的留给下一轮；
 * 报告里的 `expired` 永远是真实条数，**不假称只处理了 N 条**。
 *
 * ## 退出码（cron/systemd 的唯一判据）
 * - `0`：一轮跑完、零失败读数（**含到期 0 条**——重复跑第二次就是这样）；
 * - `1`：跑完了但有失败读数（对象端口抛错、删除未确认、阶段错），需要人看；
 * - `2`：没跑（参数/装配/连接类错误：缺 `DATABASE_URL`、缺 `MEDIA_OBJECT_REF_KEY`、
 *   `OBJECT_STORAGE_*` 不全、`--limit` 非法、DSN 不是 postgres）。
 *
 * ## 为什么不用 `setInterval`
 * 到期是**日历事实**（`media_records.expires_at`），不是「进程活了多久」。常驻定时器在多副本会重复
 * 执行、重启会丢语义、还会与真库臂抢时钟；外部 systemd timer 反复调用本命令才是正确形态
 * （见 `deploy/purge-schedule/gengyun-purge-media-objects.timer`，与同目录三条 purge 命令同一套理由）。
 *
 * ## 本文件**不**证明什么（⛔ 别把读数读大）
 * - 不证明真实 S3 `DeleteObject` / 版本化 / 桶策略语义：本机没有真桶，端到端跑不了；
 * - 不证明真 PG 上的并发行为（两个实例同时跑会怎样）：本机起不了真库；
 * - 不证明 `#6` 的 G2/G3，也不证明任何剂量卡。
 * 被单测覆盖的只有驱动层（`tests/unit/media-purge-driver.test.mjs`）；本文件这一层的装配
 * 只能在目标宿主上按 README 的验收步骤跑。
 *
 * ## 为什么这里可以合法铸造 `realMediaApproval`
 * `service.ts:457` 的禁令针对的是**请求装配层**（`app.ts`）自我批准——那会让「拿替身存储对外应答 201」
 * 变成可能。本文件是运维入口：它不注册任何路由、不铸授权、不对外应答，只调三个维护方法；且
 * `tests/unit/media-real-mode-fail-closed.test.mjs` 的静态扫描面明确只认 `services/api/src`（见该文件
 * `:1756`「被测文件之外的入口层……静态扫描只认文件内的调用点名字」）。仍选择 `executionMode:'real'`
 * 而不是 `'stub'`：`stub` 是「媒体域用替身存储对外应答」的模式，一旦这条装配被后人抄进服务路由，
 * `stub` 会静默通过；`real` 则同样受「必须有显式批准 + 必须是 `s3_compatible` 端口」约束。
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import { createPool } from '../services/api/src/db/pool.ts';
import {
  MEDIA_OBJECT_REF_KEY_FIELD,
  createObjectRefCipher,
} from '../services/api/src/media/object-ref-cipher.ts';
import { createS3CompatibleObjectStore, readObjectStorageConfig } from '../services/api/src/media/object-store.ts';
import {
  DEFAULT_MEDIA_PURGE_LIMIT,
  MAX_MEDIA_PURGE_LIMIT,
  MEDIA_PURGE_EXIT,
  formatMediaPurgeReport,
  normalizeMediaPurgeLimit,
  runMediaPurge,
} from '../services/api/src/media/purge-driver.ts';
import { approveRealMediaWiring, createAppMediaService } from '../services/api/src/media/service.ts';
import { createPostgresMediaStore } from '../services/api/src/media/store-pg.ts';

const TAG = '[purge-expired-media]';
const USAGE = `${TAG} 用法：
  DATABASE_URL=postgresql://… ${MEDIA_OBJECT_REF_KEY_FIELD}=… OBJECT_STORAGE_ENDPOINT=…
    node tools/purge-expired-media.mjs [--limit N] [--dry-run] [--json]
  --limit N   单轮预算（默认 ${DEFAULT_MEDIA_PURGE_LIMIT}，上限 ${MAX_MEDIA_PURGE_LIMIT}）：
              **不是**到期条数的上限（到期回收只能整批），而是两段之间的预算闸——
              到期条数达到 N 时本轮跳过孤儿清扫，剩下的留给下一轮
  --dry-run   只读计数（只调 stats()，不调 expireInitiated()/cleanupOrphans()，不改任何数据）
  --json      在读数之后多打一行 JSON（供监控采集；不含任何凭据）
  连接串/密钥/对象存储配置只从环境变量读取（⛔ 不接受命令行明文，也不回显）。`;

/** 参数错：打印用法并退 2（⛔ 不许退化成 0）。 */
function usageError(message) {
  console.error(`${TAG} ${message}`);
  console.error(USAGE);
  process.exitCode = MEDIA_PURGE_EXIT.CONFIG;
}

/**
 * 装配期错误的固定分类（不回显驱动原文：原文可能带主机名/用户名/endpoint 主机）。
 *
 * 与 `tools/purge-expired-online-data.mjs` 的 `configErrorCode()` 同口径，另外补了媒体域特有的两类：
 * 对象端口配置非法（`createS3CompatibleObjectStore` 抛的是普通 Error）与密钥材料解不出。
 */
function configErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  switch (code) {
    case '42P01':
      return '缺少媒体域表（media_records / media_object_cleanup / media_access_grants）：迁移未执行（不是「没有到期记录」）';
    case '42501':
      return '当前连接角色缺少媒体域表的读写权限：本命令需属主/运维角色';
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
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return '命令行参数非法（未知选项；连接串/密钥不收 argv，只从环境变量读）';
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
      return `命令行参数非法（${code}）`;
    default:
      return code === '' ? (error?.message ?? '未知错误') : `错误（code=${code}）`;
  }
}

/**
 * 装配真实对象端口：配置不全 ⇒ 抛错（退 2），⛔ 不返回替身存储。
 *
 * 只报**字段名 + 原因**，不回显值——endpoint 主机、bucket 名、密钥一律不进日志。
 */
function createRequiredObjectStore(env) {
  const { config, issues } = readObjectStorageConfig(env);
  if (config === null) {
    const detail = issues.map((issue) => `${issue.field}（${issue.code}：${issue.reason}）`).join('；');
    throw new Error(
      `对象存储未装配：${detail || 'readObjectStorageConfig() 未给出配置与原因'}｜` +
        '本命令只做真实删除，拒绝在未装配真实对象存储的情况下跑一轮然后报 0',
    );
  }
  return createS3CompatibleObjectStore(config);
}

let pool = null;
try {
  const { values } = parseArgs({
    options: {
      limit: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    process.exitCode = MEDIA_PURGE_EXIT.OK;
  } else {
    let limit = DEFAULT_MEDIA_PURGE_LIMIT;
    if (values.limit !== undefined) {
      // 只接受十进制整数字面量：`--limit 5.5` / `--limit 2e3` / `--limit abc` 一律报错，不猜。
      if (!/^\d+$/.test(values.limit)) {
        usageError(`--limit 必须是十进制正整数（收到 ${values.limit}）`);
      } else {
        try {
          limit = normalizeMediaPurgeLimit(Number(values.limit));
        } catch (error) {
          usageError(error.message);
        }
      }
    }

    // 环境变量：只读，不写回；缺一个就退 2（不静默取默认值）。
    let databaseUrl = '';
    if (process.exitCode !== MEDIA_PURGE_EXIT.CONFIG) {
      databaseUrl = process.env.DATABASE_URL?.trim() ?? '';
      if (databaseUrl === '') {
        usageError('缺少 DATABASE_URL（媒体对象回收需要真实库连接；未配置时拒绝运行，不假装跑过）');
      } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
        usageError('DATABASE_URL 必须是 postgres:// 或 postgresql:// 连接串');
      }
    }

    let mediaService = null;
    if (process.exitCode !== MEDIA_PURGE_EXIT.CONFIG) {
      // ---- 1. 对象引用加密密钥（`MEDIA_OBJECT_REF_KEY`；解不出 32 字节材料就是装配错） ----
      const keyMaterial = process.env[MEDIA_OBJECT_REF_KEY_FIELD]?.trim() ?? '';
      if (keyMaterial === '') {
        throw new Error(
          `缺少 ${MEDIA_OBJECT_REF_KEY_FIELD}：媒体域真实持久化必须能用它加密对象引用（未配置时拒绝运行，不假装跑过）`,
        );
      }
      // 抛错信息由 `MediaObjectRefKeyError` 给出（只说表示形式，不含材料本身）。
      const cipher = createObjectRefCipher(keyMaterial);

      // ---- 2. 真实对象端口（未装配即退 2，⛔ 不退化成替身存储） ----
      const objectStore = createRequiredObjectStore(process.env);

      // ---- 3. 真实 PG 持久化端口 ----
      pool = createPool(databaseUrl);
      if (pool === null) throw new Error('数据库连接池未建立（createPool 返回 null）');
      const persistence = createPostgresMediaStore({ pool, cipher });

      mediaService = createAppMediaService({
        executionMode: 'real',
        objectStore,
        // 本命令只回收、不铸授权：签名密钥只需满足端口约束（≥16 字符），用完即弃。
        tokenSecret: randomBytes(32).toString('hex'),
        persistence,
        realMediaApproval: approveRealMediaWiring({
          reason:
            'purge:media-objects（tools/purge-expired-media.mjs）：为回收通道显式接线，只调 expireInitiated()/cleanupOrphans()/stats()，不开任何对外路由',
        }),
      });

      const mode = values['dry-run'] ? 'dry-run（只读计数）' : '实际执行';
      console.log(
        `${TAG} 开始：${mode}｜limit=${limit}｜对象端口 kind=${objectStore.kind}｜` +
          '配置来自环境变量（值不回显）',
      );

      // ---- 4. 跑一轮（编排与读数在驱动层；本文件只负责装配与打印） ----
      const report = await runMediaPurge({
        mediaService,
        now: () => new Date(),
        dryRun: values['dry-run'],
        limit,
      });

      for (const line of formatMediaPurgeReport(report)) console.log(`${TAG} ${line}`);
      if (values.json) console.log(JSON.stringify(report));
      process.exitCode = report.exitCode;
    }
  }
} catch (error) {
  // 参数解析失败（parseArgs 自己抛）/ 装配失败 / 连接失败：固定分类 + 退出码 2，不回显原始凭据。
  console.error(`${TAG} 未跑（装配或连接失败）：${configErrorCode(error)}`);
  process.exitCode = MEDIA_PURGE_EXIT.CONFIG;
} finally {
  await pool?.end().catch(() => {});
}
