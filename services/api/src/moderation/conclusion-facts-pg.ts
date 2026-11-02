/* ===========================================================================
 * ## 结论事实端口的 PostgreSQL 实现（GY-R72 W54）——只读、不抛、**不参与可见性**
 *
 * 为什么单独一个文件、而不是塞进 `ledger-pg.ts` 末尾：`ledger-pg.ts` 被 `docs/` 按行号引用
 * 7 处（`moderation/ledger-pg.ts:200`、`:299`、`:465`、`:491`、`:504` 等），`service.ts` 55 处，
 * `app.ts` 321 处。本片的纪律是那几个热文件**净 0 行**（既有行整行 1 换 1），新增能力一律落新文件
 * ⇒ 那 383 处 prose 锚点一行都不用重算。端口契约在 `./conclusion-facts.ts`（纯类型 + 判定逻辑），
 * 这里只放"真发一条 SELECT"的实现细节（SQL、行映射、warn 去重）。
 *
 * ⛔ 边界（写在这里是为了让后来人第一个看到）：本端口**只**回答"已落库的结论用了哪一版
 * 规则/模型/prompt"，只喂 `service.ts` 的 `RESCREEN_REQUIRED` 判定。
 * 它**不**碰 `present` / `effectiveState` / `checkReadVisibility` / 任何 `Visibility` 结论 ——
 * 「存量任务行不回填」那条针对可见性的决策（`ledger-pg.ts:48-51`）原样保留。
 * 拿不到事实时它返回空数组 ⇒ 调用方**少判** stale，绝不因此多放行或多下架。
 * --------------------------------------------------------------------------- */
import { ApiError } from '../errors.ts';
import { CONTENT_KINDS, type TargetRef } from './types.ts';
import type { SqlRunner } from './ledger-pg.ts';
import type {
  ConcludedAssessmentDecision,
  ConcludedAssessmentFact,
  ModerationConclusionFactsPort,
} from './conclusion-facts.ts';

/**
 * 结论事实读面 SQL（**只读**；唯一用途：判"已发布结论该不该重评"）。
 *
 * 列清单与 `deploy/postgres-cvm/sql/20-login-roles.sql` 段 M3 的 `GRANT SELECT` **逐列一致**
 * （12 列；`90-assert-least-privilege.sql` 的 `expected(...)` 与 W54 零行探针是同一份名单）：
 *   · 谓词列：`target_type` / `target_id` / `target_revision` / `superseded` / `decision`
 *   · 读出的版本列：`content_kind` / `rule_version` / `model_version` / `prompt_version`
 *   · 时间列：`concluded_at`（迁移 0052 新增）与兜底用的 `updated_at`
 * ⇒ 多引一列就是运行时 `42501`；引了未授权的列会被 `tests/unit/sql-column-coverage.test.mjs` 拦下。
 *
 * 为什么是 `COALESCE(concluded_at, updated_at)` 而不是只认 `concluded_at`：0052 的写面本片留白
 * （只加 SELECT 授权，没给 `concluded_at` 的 UPDATE 授权），迁移**之后**新判定的行 `concluded_at`
 * 仍是 NULL —— 只认新列的话这些行在重启后永远看不见，缺陷就只修到"回填那一刻"。
 * 兜底口径的来龙去脉见 `0052_moderation_conclusion_facts.sql` 的「为什么本片不写它」。
 *
 * `superseded = FALSE`：与台账 `current` 的口径一致（只取各目标当前的现任行；
 * 被退位的历史行是"当时的结论"，不是"现在的结论"，拿它判过期会把早已重审过的内容反复标脏）。
 * `decision = 'approved'`：只有通过的结论才是可复用的已发布结论（`rejected`/`quarantined`/
 * `pending`/NULL 一律不进来；这一点与 `service.ts` 的 `task.decision !== 'approved'` 同口径）。
 * `LIMIT 30`：事实条数天然是"内容类别数 × 现任行数"，这里与读面 `.slice(0, 30)` 取同一个上限封顶。
 */
const CONCLUSION_FACTS_SQL = `
  SELECT content_kind,
         decision,
         rule_version,
         model_version,
         prompt_version,
         COALESCE(concluded_at, updated_at) AS concluded_at
    FROM public.moderation_decisions
   WHERE target_type = $1
     AND target_id = $2
     AND target_revision = $3
     AND superseded = FALSE
     AND decision = 'approved'
   ORDER BY COALESCE(concluded_at, updated_at) DESC
   LIMIT 30`;

/** 本 SQL 只可能产出 `'approved'`（谓词写死）；这里仍做白名单映射，防的是"有人改了谓词"。 */
const CONCLUSION_FACT_DECISIONS: readonly ConcludedAssessmentDecision[] = ['approved'];

/** `timestamptz` ⇒ ISO 8601 字符串（`pg` 给 `Date`；记录型假池可能给字符串；解析不了 ⇒ null）。 */
function isoTimestampOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** 版本列 ⇒ 字符串或 null（空串按"缺失"处理：`'' !== 当前版本` 会把内容全部误判过期）。 */
function versionTextOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** 失败原因摘要（**不抛**：这条读面是 fail-closed 的旁路，不能把错误再抛回去）。 */
function conclusionFactsFailureOf(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message.slice(0, 160)}`;
  const record = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown };
  const code = typeof record.code === 'string' ? record.code : 'UNKNOWN';
  const detail = typeof record.message === 'string' ? (record.message.split('\n')[0] ?? '').slice(0, 160) : '';
  return detail.length === 0 ? code : `${code}: ${detail}`;
}

/**
 * 结论事实端口的 **PostgreSQL 实现**（唯一生产实现）。
 *
 * 三条纪律（全部由 `tests/unit/moderation-conclusion-freshness.test.mjs` 钉死）：
 * 1. **只读**：只发上面那一条 `SELECT`，没有任何写语句；
 * 2. **不抛**：缺表（迁移没跑）、缺列（`concluded_at` 没落）、权限不足（42501）、连接失败、
 *    超时 —— 一律 `return []` 并记**一次** warn（同样的失败不刷屏）；
 * 3. **不改可见性**：本函数拿到的行只映射成 `ConcludedAssessmentFact`，一个可见性字段都不带。
 *
 * `warn` 可注入（测试用它断言"记过一次、没抛"）；默认走 `console.warn`，载荷形如
 * `{"level":"warn","event":"moderation.conclusion_facts.unavailable","reason":"42501: permission denied",…}`，
 * 与 `task-egress.ts` 的 JSON 事件行同一风格。
 */
export function createPostgresConclusionFacts(options: {
  pool: SqlRunner;
  warn?: (line: string) => void;
}): ModerationConclusionFactsPort {
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const warned = new Set<string>();
  const warnOnce = (key: string, line: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    warn(line);
  };

  return {
    async concludedAssessmentsOf(target: TargetRef): Promise<readonly ConcludedAssessmentFact[]> {
      let rows: Array<Record<string, unknown>>;
      try {
        const result = await options.pool.query(CONCLUSION_FACTS_SQL, [target.type, target.id, target.revision]);
        rows = result.rows;
      } catch (error) {
        warnOnce(
          `query:${conclusionFactsFailureOf(error)}`,
          JSON.stringify({
            level: 'warn',
            event: 'moderation.conclusion_facts.unavailable',
            reason: conclusionFactsFailureOf(error),
            target_ref: { type: target.type, id: target.id, revision: target.revision },
            consequence: 'stale_reasons_degraded_to_memory_only',
          }),
        );
        // fail-closed 的**方向**：拿不到事实 ⇒ 空数组 ⇒ 调用方少判 `RESCREEN_REQUIRED`。
        // 绝不抛：读面不该因为"新鲜度算不出来"而 500，更不该凭"不知道"改任何可见性。
        return [];
      }

      const facts: ConcludedAssessmentFact[] = [];
      for (const row of rows) {
        const contentKind = row.content_kind;
        if (typeof contentKind !== 'string' || !(CONTENT_KINDS as readonly string[]).includes(contentKind)) {
          warnOnce(
            `shape:content_kind:${String(contentKind)}`,
            JSON.stringify({
              level: 'warn',
              event: 'moderation.conclusion_facts.row_skipped',
              reason: 'content_kind 越出闭集',
              target_ref: { type: target.type, id: target.id, revision: target.revision },
            }),
          );
          continue;
        }
        const decision = row.decision;
        const concludedAt = isoTimestampOf(row.concluded_at);
        if (typeof decision !== 'string' || !(CONCLUSION_FACT_DECISIONS as readonly string[]).includes(decision) || concludedAt === null) {
          // 谓词已经把非 `approved` 与无时间的行挡在 SQL 外；走到这里说明谓词被改过 —— 跳过而不是猜。
          warnOnce(
            `shape:row:${String(decision)}`,
            JSON.stringify({
              level: 'warn',
              event: 'moderation.conclusion_facts.row_skipped',
              reason: '结论取值或时间列不可用',
              target_ref: { type: target.type, id: target.id, revision: target.revision },
            }),
          );
          continue;
        }
        facts.push({
          target: { type: target.type, id: target.id, revision: target.revision },
          decision: decision as ConcludedAssessmentDecision,
          content_kind: contentKind as ConcludedAssessmentFact['content_kind'],
          rule_version: versionTextOf(row.rule_version),
          model_version: versionTextOf(row.model_version),
          prompt_version: versionTextOf(row.prompt_version),
          concluded_at: concludedAt,
          revision: target.revision,
        });
      }
      return facts;
    },
  };
}
