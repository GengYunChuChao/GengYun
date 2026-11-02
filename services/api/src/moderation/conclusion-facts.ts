/**
 * GY-R72 W54 · 审核结论的**只读事实**端口（只为「结论新鲜度」而存在）。
 *
 * ## 它回答什么问题
 * 「这个目标、这个版本，**已经落库**的审核结论是哪些，各自用的哪一版规则/模型/prompt？」
 * —— 有了它，`service.ts` 的过期判定（`RESCREEN_REQUIRED`）在**进程重启之后**仍然算得出来；
 * 没有它，那份判定只能从内存台账派生，重启即失忆（缺陷与证据见
 * `docs/verification/gy-r72-moderation-conclusion-freshness-20261102.md`）。
 *
 * ## 它**不**回答什么问题（本片最硬的边界）
 * ⛔ 它**不是**可见性数据源：不接 `present`、不接 `effectiveState`、不接任何
 * `checkReadVisibility` / `Visibility` 判定，也不参与「能不能看」的结论。
 * 「已发布内容该不该重评」与「这条内容对谁可见」是两件事：
 *   - 前者由本端口提供事实、由 `service.ts` 的版本比对判定；
 *   - 后者仍然**只**由内存台账 + 内容权威的既有路径判定（`ledger-pg.ts:48-51` 的
 *     「存量任务行不回填」是针对后者的决策，本片**不改**那条决策）。
 * 换句话说：即便本端口返回空数组、返回过期数据、或整个实现缺席，**可见性判定必须一字不变**
 * （T6 钉的就是这一条：端口给 `approved` 还是给空，`present` / `effectiveState` 逐字相同）。
 *
 * ## 实现纪律（fail-closed 的**方向**要看清）
 * 1. `concludedAssessmentsOf` **不得抛**：缺表、缺列、权限不足、连接失败、超时 ——
 *    一律返回空数组，并按需记一次 warn（`ledger-pg.ts` 的实现即如此）。
 * 2. 空数组的语义是「**不知道**有没有结论」，**不是**「没有结论」。调用方据此**少判**
 *    `RESCREEN_REQUIRED`（继续按内存台账的老口径放行），而不是把「不知道」当成「已审」或
 *    「未审」去改可见性 —— 拿不到事实只允许少判，绝不允许凭它多放行/多下架。
 * 3. 端口是**只读**的：只有 `SELECT`，没有任何写方法。写面（谁在什么时候把结论落成这一列）
 *    属于另一片，见迁移 `0052_moderation_conclusion_facts.sql` 的「为什么本片不写它」。
 *
 * ## 谁实现它
 * - 生产：`services/api/src/moderation/conclusion-facts-pg.ts` 的 `createPostgresConclusionFacts()`
 *   （一条列级授权内的 `SELECT`，列清单与 `20-login-roles.sql` 段 M3 的 SELECT 授权逐列一致）；
 * - 测试：`tests/unit/moderation-conclusion-freshness.test.mjs` 里的内存端口与探针端口；
 * - 装配：`services/api/src/app.ts` 的审核域装配行（只在有 `pool` 时接上；`pool === null`
 *   的替身/演示模式不接 ⇒ 行为与改前完全一致）。
 */
import type { ContentKind, TargetRef } from './types.ts';

/**
 * 结论取值（本端口只关心这三种）。
 *
 * `0028_moderation_persistence.sql` 的 `decision` 列还有第四个取值 `'quarantined'`（隔离待复核）；
 * 这里**刻意不出现**：隔离不是「可复用的已审结论」，实现方只应把「已落定的结论」交出来。
 * 生产实现的 SQL 直接以 `decision = 'approved'` 过滤，因此实际只会产出 `'approved'`；
 * 类型保留另两个取值，是为了让「端口如实报告驳回/待定」这件事在类型上成立 ——
 * 调用方（`service.ts`）对非 `approved` 的结论一律**不算 stale**，与内存台账
 * `versionFreshnessOf` 的 `task.decision !== 'approved'` 同一口径。
 */
export type ConcludedAssessmentDecision = 'approved' | 'rejected' | 'pending';

/** 一条已落库的审核结论事实（**只读快照**，不含任何可见性字段）。 */
export interface ConcludedAssessmentFact {
  /** 事实所属目标（与查询入参同一个 `TargetRef`）。 */
  target: TargetRef;
  /** 结论取值；见 `ConcludedAssessmentDecision`。 */
  decision: ConcludedAssessmentDecision;
  /**
   * 结论所针对的内容类别（`text` / `image`）。
   *
   * 为什么事实必须带它、而不是让调用方去猜：当前模型版本与 prompt 版本都是**按类别**派生的
   * （`service.ts:599-601` 的 `currentModelVersion(content_kind)`、`:603-615` 的
   * `currentPromptVersion(mediaCount)`，而 `mediaCount` 又由类别决定：纯文本 0、含图 1+）。
   * 没有类别就只能对候选集合取并集，把「图文混合 prompt」错判成文本结论的过期原因。
   * 表里行本来就按 `(target, content_kind)` 分开存，事实天然带类别。
   */
  content_kind: ContentKind;
  /** 该结论使用的规则版本（缺失 ⇒ `null`，调用方按 `RULE_VERSION_UNKNOWN` 处理）。 */
  rule_version: string | null;
  /** 该结论使用的模型版本（缺失 ⇒ `null`）。 */
  model_version: string | null;
  /** 该结论使用的 prompt 版本（缺失 ⇒ `null`）。 */
  prompt_version: string | null;
  /** 结论时刻（ISO 8601 字符串；生产实现为 `COALESCE(concluded_at, updated_at)`）。 */
  concluded_at: string;
  /** 结论所针对的目标版本（= `target.revision`；单独给出便于调用方直接比对，不必再解引用）。 */
  revision: number;
}

/** 结论事实端口：**只读、不抛、不参与可见性**。 */
export interface ModerationConclusionFactsPort {
  /**
   * 取该目标该版本的已落库结论事实。
   *
   * @returns 零到多条事实（同一目标可同时有 `text` 与 `image` 两条结论）。
   *          **空数组 = 不知道**（见文件头「实现纪律」第 2 条），实现**不得**抛错。
   */
  concludedAssessmentsOf(target: TargetRef): Promise<readonly ConcludedAssessmentFact[]>;
}

/* ===========================================================================
 * ## 结论新鲜度：两个数据源的统一入口（GY-R72 W54）
 *
 * 缺陷（本段存在的理由）：`readView` 的 `staleReasons` 原来只从内存台账
 * （`ledger.forRevision(target)`）派生，而 PG 台账的 `forRevision` **只答本进程写过的行**
 * （`ledger-pg.ts:48-51` 那条「存量任务行不回填」的决策，针对的是**可见性**，本片不改它）。
 * ⇒ 进程一重启，内存空，`staleReasons` 恒空，`RESCREEN_REQUIRED` 再也不会触发。
 *
 * 做法（派单 §1.3 的口径）：
 *   ① 内存**有**结论（`forRevision` 非空）⇒ 按内存算，与改前**逐字同口径**（`versionFreshnessOf` 原样调用）；
 *   ② 内存**为空才**问只读事实端口 `concludedAssessmentsOf(target)`（重启后的主路径）；
 *   ③ 两者都空 / 端口缺席 / 端口抛错 ⇒ 空数组 ⇒ 维持改前的 `stale:false`。
 *
 * fail-closed 的**方向**（别弄反）：拿不到事实只允许**少判** stale。
 * 绝不把"不知道有没有结论"当成"已审"（那是多放行），也不当成"未审"去下架（那是多下架）；
 * 更不参与任何可见性判定 —— 本段的返回值只喂 `RESCREEN_REQUIRED` 那一个分支。
 *
 * 为什么整段逻辑住在这个文件、而不是 `service.ts`：`service.ts` 被 `docs/` 按行号引用（55 处），
 * 本片要求它净 0 行 ⇒ 热文件里只留「一行调用 + 一个 import」，判定逻辑全部下沉到这里。
 * --------------------------------------------------------------------------- */
import type { ModerationLedger } from './decisions.ts';
import type { ModerationTaskRecord } from './types.ts';

/**
 * 当前版本三元组的取值器（全部由 `createModerationService` 的闭包提供，见 `service.ts:585-615`）。
 *
 * `task` 单独给一个函数而不是把整段 `versionFreshnessOf` 复制过来：内存那一半必须**原样复用**
 * 既有实现（含它对 `MODEL_LAYER_INPUT_BINDING_UNVERIFIED`/`NOT_PUBLISHABLE` 的过滤），
 * 复制一份就是给"两套口径慢慢漂开"埋雷。
 */
export interface ConclusionFreshnessSources {
  task: (task: ModerationTaskRecord) => { stale: boolean; reason_codes: string[] };
  rule: () => string | null;
  model: (kind: ContentKind) => string | null;
  prompt: (kind: ContentKind) => string | null;
}

/** 结论事实 → 过期原因码：**显式镜像** `service.ts:759-788` 的 `versionFreshnessOf` 三段比对。 */
export function concludedFactFreshnessOf(
  fact: ConcludedAssessmentFact,
  freshness: ConclusionFreshnessSources,
): string[] {
  // 与 `versionFreshnessOf` 的 `task.decision !== 'approved'` 同口径：非通过的结论不是"可复用的已发布结论"。
  if (fact.decision !== 'approved') return [];
  const ruleVersion = freshness.rule();
  // 同口径：当前规则版本都算不出来 ⇒ 直接一项 UNKNOWN（不再往下叠原因）。
  if (ruleVersion === null) return ['RULE_VERSION_UNKNOWN'];
  const codes: string[] = [];
  if (fact.rule_version === null) codes.push('RULE_VERSION_UNKNOWN');
  else if (fact.rule_version !== ruleVersion) codes.push('RULE_VERSION_CHANGED');
  // 模型/prompt 两项与合流层的重评估（`packages/moderation/model-review.mjs`）同口径：
  // "当前版本"或"结论记录的版本"任一缺失都算 UNKNOWN（不知道用的是哪一版 ≠ 没变化），
  // 两者都有且不等才是 CHANGED。注意不要把缺失降级成"当作相同"——那会把待重评内容放出去。
  const modelVersion = freshness.model(fact.content_kind);
  if (modelVersion === null || fact.model_version === null) codes.push('MODEL_VERSION_UNKNOWN');
  else if (fact.model_version !== modelVersion) codes.push('MODEL_VERSION_CHANGED');
  const promptVersion = freshness.prompt(fact.content_kind);
  if (promptVersion === null || fact.prompt_version === null) codes.push('MODEL_PROMPT_VERSION_UNKNOWN');
  else if (fact.prompt_version !== promptVersion) codes.push('MODEL_PROMPT_VERSION_CHANGED');
  return codes;
}

/**
 * 读面的结论新鲜度（`service.ts` 的 `readView` 唯一调用点）。
 *
 * 返回值语义与改前完全一致：一组去重后的原因码，最多 30 条（`.slice(0, 30)` 的上限沿用）；
 * 非空 ⇒ 调用方判 `RESCREEN_REQUIRED` + 清缓存 + 判不可见（那段逻辑一行未动）。
 */
export async function conclusionStaleReasonsOf(args: {
  target: TargetRef;
  ledger: ModerationLedger;
  port: ModerationConclusionFactsPort | undefined;
  visible_published: boolean;
  freshness: ConclusionFreshnessSources;
}): Promise<string[]> {
  // 改前的第一道门：非"可见且已发布"根本不算新鲜度（原样保留，顺序也不变）。
  if (!args.visible_published) return [];
  const inMemory = args.ledger.forRevision(args.target);
  if (inMemory.length > 0) {
    return [
      ...new Set(
        inMemory.flatMap((task) => {
          const fresh = args.freshness.task(task);
          return fresh.stale ? fresh.reason_codes : [];
        }),
      ),
    ].slice(0, 30);
  }
  if (args.port === undefined) return [];
  let facts: readonly ConcludedAssessmentFact[];
  try {
    facts = await args.port.concludedAssessmentsOf(args.target);
  } catch {
    // 端口实现本应自己吞错（`createPostgresConclusionFacts` 即如此）；这里再兜一层，
    // 保证任何注入实现抛错都只降级成"没有事实"，绝不让读面 500、也绝不改可见性。
    return [];
  }
  return [...new Set(facts.flatMap((fact) => concludedFactFreshnessOf(fact, args.freshness)))].slice(0, 30);
}
