/**
 * 在线到期清除的**端口装配**（`tools/purge-expired-online-data.mjs` 与真库臂共用的一份）。
 *
 * 这里只做「域 → 既有清理原语」的映射，⛔ 不写任何新 SQL、⛔ 不新增授权：每个域真正删行的语句
 * 都在各自的 PG store / 既有 `SECURITY DEFINER` 函数里（授权早在
 * `deploy/postgres-cvm/sql/20-login-roles.sql` 就绪）。本文件只是把它们接成驱动要的 `OnlinePurgePort`。
 *
 * ## 闭集 = 读面推导集合（GY-R72）
 * `ONLINE_PURGE_MODULES` 必须与 `user-data-deletion.ts::ONLINE_EVIDENCE_MODULES` **逐字相同**：
 * 读面对「闭集里有、证据里没有」的域在到期后按 `blocked` 计（`online-state-derivation.ts:29`），
 * 所以时钟驱动的域少一个，那个域在受理时失败之后就**再没有任何执行者会重试它**——用户的
 * 「在线 7 日」承诺就只剩一句文案。社区域（`community`）刻意**不在**闭集内：F13 是
 * 「保留+脱敏」，没有「清空行数」这个事实。
 *
 * ## 可用性（逐域探测，⛔ 不静默少清）
 * 闭集 ≠ 每个部署都装得下：缺表（迁移未跑到该片）、缺授权、库不存在、连不上…… 都只影响**那一域**。
 * 因此装配是**逐域 try**：构造端口 → 只读探测该域要删的表现在是否存在（`to_regclass`，不需要任何
 * 表权限，因此不会把「没授权」误判成「没这张表」）→ 只读探测该域的删除权限够不够
 * （`has_table_privilege` / `has_column_privilege`）。探测不通过 ⇒ 该域**不进** `modules`，
 * 逐条进 `skippedModules`（域 + 人话原因），**不影响退出码**（缺表/缺授权不是本轮失败，而是部署事实）。
 * 只有「一域都装不上」才算配置错误（CLI 走 exit 2：那说明 DATABASE_URL 或迁移整体不对）。
 * 探测通过但删不动（运行期才暴露的 42501 / 函数缺 EXECUTE）⇒ 行级失败照旧上报、退出码 1（真故障）。
 *
 * ⚠️ 已在真库实测到的一处**出厂授权缺口**（GY-R72 记录，⛔ 本片不改授权）：`jobs` 域的表级 DELETE
 * 有了（`20-login-roles.sql:997`），但 `DELETE … WHERE owner_id = $1` 还要 `owner_id` 的列级 SELECT，
 * 而出厂列清单（`:980`）没含它 ⇒ 该域在真库上必然 42501。修法是把 `owner_id` 加进那一条列级授权
 * （以及 `90-assert-least-privilege.sql:1338` 的期望清单），属于授权面扩大，需单独追认；本片只做到
 * 「逐域诚实跳过 + 原因点名」，不静默、不假装清过。
 *
 * ## 计数口径（与 `user-data-deletion.ts::makeHandler` 同形）
 * - `removed`：本域**正文行**真实删除行数（原语返回的 `records`；作业域 = 台账行数）；
 * - `idempotency`：本域幂等台账行数；原语没有分表计数时如实报 0（⛔ 不假装台账也清了）。
 * 两个数都是原语 `RETURNING`/`GET DIAGNOSTICS` 的行数，⛔ 不是"匹配行数"、更不是"执行了语句"。
 *
 * ## 幂等
 * 每个域的重跑都由「谓词是主体等值/前缀」天然保证：再跑一次删 0 行、返回 0，⛔ 不报错。
 * 台账域的前缀判据恒为 `left(scope, char_length(owner)+1) = owner || chr(10)`（scope 首段 = 主体 uuid）。
 */
import type { PgPool } from '../db/pool.ts';
import { createPostgresConversationStore } from '../conversations/store-pg.ts';
import { createPostgresFavoritesStore } from '../favorites/store-pg.ts';
import { createPostgresHistoryStore } from '../history/store-pg.ts';
import { createPostgresMessagesStore } from '../messages/store-pg.ts';
import { purgeJobLedgerByOwner } from '../jobs/ledger.ts';
import { createPostgresOcrStore } from '../ocr/store-pg.ts';
import { createPostgresRecognitionStore } from '../recognitions/store-pg.ts';
import { createPostgresSpeechStore } from '../speech/store-pg.ts';
import type { OnlinePurgePort } from './online-purge-driver.ts';
import { ONLINE_EVIDENCE_MODULES } from './user-data-deletion.ts';

/** 本端口认得的 store 形状：能按主体清空的两种原语之一（或两者都有）。 */
interface OwnerPurgeStore {
  purgeOwnerData?: (ownerId: string) => Promise<{ records: number; idempotency: number }>;
  deleteAllByOwner?: (ownerId: string) => Promise<number>;
}

/** 某域「端口构造失败/该域表不在」时的一条如实记录（进报告，⛔ 不并进失败行）。 */
export interface OnlinePurgeSkippedModule {
  readonly module: string;
  /** 人话原因（不含连接串/主机名/用户名），例如 `缺少表：public.ocr_records`。 */
  readonly reason: string;
}

/** 装配结果：真正可清的域 + 交驱动用的端口 + 被跳过的域（逐条带原因）。 */
export interface OnlinePurgePortSet {
  readonly purge: OnlinePurgePort;
  /** 交 `drainDueOnlineDeletions({ modules })` 的闭集（= 探测通过的域，顺序同 `ONLINE_PURGE_MODULES`）。 */
  readonly modules: readonly string[];
  readonly skippedModules: readonly OnlinePurgeSkippedModule[];
}

/**
 * 时钟驱动的清理闭集 —— **8 域**，与 `ONLINE_EVIDENCE_MODULES` 同源（⛔ 不另抄一份字面量：
 * 抄一份就会漂移，这正是 R72 缺陷的成因）。社区域继续排除。
 */
export const ONLINE_PURGE_MODULES: readonly string[] = ONLINE_EVIDENCE_MODULES;

/**
 * 每域「要删的表」清单（探测用，⛔ 只是名字，不含任何 SQL 谓词）：
 * 探测只问"这些表在不在"，删哪些行仍由各 store/函数自己决定。
 */
const DOMAIN_TABLES: Readonly<Record<string, readonly string[]>> = {
  favorites: ['favorites', 'favorites_idempotency'],
  history: ['history', 'history_idempotency'],
  messages: ['messages', 'idempotency_keys'],
  // 轮次/回答靠 0013 的两级 ON DELETE CASCADE 随会话消失。
  conversations: ['conversations'],
  recognitions: [
    'recognition_selections',
    'recognition_jobs',
    'recognition_records',
    'recognition_idempotency',
  ],
  speech: ['speech_jobs', 'transcriptions', 'speech_idempotency'],
  ocr: ['ocr_records', 'ocr_jobs', 'ocr_idempotency'],
  jobs: ['jobs'],
};

/** 探测失败的人话原因：只认"缺表"这一种，其余照实带上 SQLSTATE（⛔ 不回显驱动原文）。 */
function describeSkip(error: unknown): string {
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? String((error as { code: string }).code)
    : '';
  switch (code) {
    case '42P01':
      return '缺少表（迁移未跑到该域）：SQLSTATE 42P01';
    case '3D000':
      return '目标数据库不存在（SQLSTATE 3D000）';
    case '28P01':
    case '28000':
      return '数据库认证失败（SQLSTATE 28P01/28000）';
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ECONNRESET':
    case 'ETIMEDOUT':
      return `连不上数据库（${code}）`;
    default:
      return code === '' ? '端口构造失败（未知原因）' : `端口构造失败（SQLSTATE ${code}）`;
  }
}

/** 只读探测：返回该域**缺失**的表名（`to_regclass` 不需要任何表权限）。 */
async function missingRelations(pool: PgPool, names: readonly string[]): Promise<string[]> {
  const { rows } = await pool.query(
    "SELECT name FROM unnest($1::text[]) AS t(name) WHERE to_regclass('public.' || name) IS NULL",
    [names],
  );
  return rows.map((row) => String((row as { name: unknown }).name));
}

/**
 * 每域「能不能真的删」的就地探测（只读；用 `has_*_privilege`，⛔ 不试删）。
 *
 * 为什么需要它（GY-R72）：`jobs` 的删除面是**两层**授权 —— 表级 `DELETE`
 * （`deploy/postgres-cvm/sql/20-login-roles.sql:997` 的 `gy-r71-jobs-ledger-purge-grant` 段）
 * 加 `JOB_LEDGER_PURGE_SQL`（`DELETE … WHERE owner_id = $1::uuid`）**谓词列**的列级 `SELECT`：
 * PG 对 DELETE 的 WHERE 列另要 SELECT。同文件 `:980` 的列清单在 GY-R72 前只有
 * id/state/revision/error_code/result_ref/updated_at，**不含 `owner_id`** ⇒ 真库上必然
 * `42501 permission denied for table jobs`（`routine=aclcheck_error`；同角色
 * `DELETE … WHERE false` 反而成功 ⇒ 差的只是那一列的 SELECT）。GY-R72 已把 `owner_id`
 * 补进那份列清单，授权与 90-assert 的期望清单对齐（证据 docs/verification/gy-r72-jobs-owner-select-20261102.md）。
 * 探测**保留**：缺的是「列级 SELECT」而不是「表在不在」，`to_regclass` 看不见它；换角色或收紧授权时
 * 仍要如实跳过，而不是每轮 N 条 `DRIVER_EXCEPTION`（重试同一条件也永远不会好）。判定失败 ⇒ 该域进
 * `skippedModules` 并点名缺的那条授权，⛔ 不让整轮非零退出（这是部署事实，不是本轮失败）。
 */
async function jobsPurgeDenial(pool: PgPool): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT has_table_privilege(current_user, 'public.jobs', 'DELETE') AS table_delete,
            has_column_privilege(current_user, 'public.jobs', 'owner_id', 'SELECT') AS owner_select`,
  );
  const row = rows[0] as { table_delete?: unknown; owner_select?: unknown } | undefined;
  // 探测拿不到行（假池 / 换了 runner）⇒ 不据此跳过：宁可让真跑报失败，也不凭猜少清一域。
  if (row === undefined) return null;
  if (row.table_delete === false) {
    return '缺少表级 DELETE：public.jobs（应见 20-login-roles.sql 的 gy-r71-jobs-ledger-purge-grant 段）';
  }
  if (row.owner_select === false) {
    return '缺少列级 SELECT(owner_id)：DELETE … WHERE owner_id = $1 需要读该列，而出厂列清单（20-login-roles.sql:980）自 GY-R72 起应为 7 列含 owner_id ⇒ 当前库缺这一列即必然 42501；真库判定见 docs/verification/gy-r72-jobs-owner-select-20261102.md';
  }
  return null;
}

/** 域 → 权限探测（只有 `jobs` 需要：其余域的表级 DML / 函数 EXECUTE 已由真库臂实测通过）。 */
const DOMAIN_PRIVILEGE_PROBES: Readonly<Record<string, (pool: PgPool) => Promise<string | null>>> = {
  jobs: jobsPurgeDenial,
};

/**
 * 装配 8 域端口。逐域 try：构造 + 表探测 + 权限探测，失败只跳过该域（记进 `skippedModules`），
 * ⛔ 不抛给整轮。
 */
export async function createOnlinePurgePort(pool: PgPool): Promise<OnlinePurgePortSet> {
  /**
   * 作业台账（`public.jobs`）：`JOB_LEDGER_PURGE_SQL`（`DELETE … WHERE owner_id = $1::uuid`），
   * 授权 = `GRANT DELETE ON public.jobs`（20-login-roles.sql 的 `gy-r71-jobs-ledger-purge-grant` 段）。
   * 台账没有"同域幂等表"这一层（幂等 scope 在各自域），所以 `idempotency` 如实为 0。
   * `purgeJobLedgerByOwner` 拿不到 `rowCount` 时**抛**而不是报 0：删了却说不清删了几行，
   * 不能进证据（⛔ 不写假数字）。
   */
  const jobsStore: OwnerPurgeStore = {
    async purgeOwnerData(ownerId) {
      return { records: await purgeJobLedgerByOwner(pool, ownerId), idempotency: 0 };
    },
  };

  /** 域 → 构造函数（构造本身不触库；触库的只有下面的探测与真正的删除）。 */
  const builders: Readonly<Record<string, () => OwnerPurgeStore>> = {
    // 四域：原有覆盖（正文表行 + 各自幂等台账，同一事务）。
    favorites: () => createPostgresFavoritesStore(pool) as unknown as OwnerPurgeStore,
    history: () => createPostgresHistoryStore(pool) as unknown as OwnerPurgeStore,
    messages: () => createPostgresMessagesStore({ pool }) as unknown as OwnerPurgeStore,
    conversations: () => createPostgresConversationStore(pool) as unknown as OwnerPurgeStore,
    // 识别域：`public.purge_owner_recognitions(uuid)`（迁移 0034，SECURITY DEFINER；
    // EXECUTE 授权见 20-login-roles.sql 的 `gy-r34-owner-content-purge` 段）。删：
    // recognition_selections → recognition_jobs → recognition_records（皆 `owner_user_id = $1`）
    // + recognition_idempotency（scope 前缀）。计数：`records` = 三张正文表之和、
    // `idempotency` = 台账行数 —— 同一函数、同一事务。
    recognitions: () => createPostgresRecognitionStore({ pool }) as unknown as OwnerPurgeStore,
    // 语音域：`public.purge_owner_speech(uuid)`（同一迁移、同一授权段）。删：speech_jobs →
    // transcriptions（`owner_user_id = $1`）+ speech_idempotency（scope 前缀）。
    // 计数：`records` = 两表之和，`idempotency` = 台账行数。
    speech: () => createPostgresSpeechStore({ pool }) as unknown as OwnerPurgeStore,
    // OCR 域：三张表**表级 DELETE**（20-login-roles.sql 的 R34 表级例外；无 SECURITY DEFINER 函数）。
    // 删：ocr_records → ocr_jobs（`owner_user_id = $1`）+ ocr_idempotency（scope 前缀）；
    // 三句在**一个事务**里，行数取 `RETURNING` 的真实行数。计数：`records` =
    // ocr_records + ocr_jobs，`idempotency` = 台账行数；分表明细由 store 侧另写进证据。
    ocr: () => createPostgresOcrStore({ pool }) as unknown as OwnerPurgeStore,
    // 作业域：见上面的 `jobsStore`（`public.jobs` 台账）。
    jobs: () => jobsStore,
  };

  const stores = new Map<string, OwnerPurgeStore>();
  const modules: string[] = [];
  const skippedModules: OnlinePurgeSkippedModule[] = [];

  for (const module of ONLINE_PURGE_MODULES) {
    const build = builders[module];
    const tables = DOMAIN_TABLES[module];
    if (build === undefined || tables === undefined) {
      // 闭集与实现脱钩（有人加了域却没加构造器）：这一域按"不可用"如实列出，⛔ 不猜。
      skippedModules.push({ module, reason: '端口未实现（闭集里有、装配里没有）' });
      continue;
    }
    try {
      const store = build();
      const missing = await missingRelations(pool, tables);
      if (missing.length > 0) {
        skippedModules.push({
          module,
          reason: `缺少表：${missing.map((name) => `public.${name}`).join('、')}`,
        });
        continue;
      }
      const privilegeProbe = DOMAIN_PRIVILEGE_PROBES[module];
      if (privilegeProbe !== undefined) {
        const denial = await privilegeProbe(pool);
        if (denial !== null) {
          skippedModules.push({ module, reason: denial });
          continue;
        }
      }
      stores.set(module, store);
      modules.push(module);
    } catch (error) {
      skippedModules.push({ module, reason: describeSkip(error) });
    }
  }

  const purge: OnlinePurgePort = {
    async purgeModule({ userId, module }) {
      const store = stores.get(module);
      if (store === undefined) {
        // 闭集外的模块名意味着调用方与本文件的 `ONLINE_PURGE_MODULES` 脱钩了：直接拒绝，不猜要删什么。
        const error = new Error(`未知的必需模块：${module}`);
        (error as { code?: string }).code = 'STORE_REJECTED';
        throw error;
      }
      if (typeof store.purgeOwnerData === 'function') {
        // 能分表计数：正文行 + 幂等台账行在同一事务/同一函数内清掉，两个真实行数都报。
        const counts = await store.purgeOwnerData(userId);
        return { removed: counts.records, idempotency: counts.idempotency };
      }
      if (typeof store.deleteAllByOwner === 'function') {
        const removed = await store.deleteAllByOwner(userId);
        return { removed, idempotency: 0 };
      }
      // 既没有分表计数也没有整域清空原语 ⇒ 拒绝（⛔ 不返回 0 冒充"清完了"）。
      const error = new Error(`模块缺少清理原语：${module}`);
      (error as { code?: string }).code = 'STORE_REJECTED';
      throw error;
    },
  };

  return { purge, modules, skippedModules };
}
