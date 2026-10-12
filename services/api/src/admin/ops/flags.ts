/**
 * GY-I18 阶段 1b · 功能开关（flag）注册表与 **fail-closed 守卫**。
 *
 * 派单要求（逐条落实）：
 * - 「先把契约里 flag 的 `key` 空间/取值查清（以契约为准）」⇒
 *   契约 `setFlag` 的 `key` 是**闭集枚举**，恰好 3 个：
 *   `submissions_enabled` / `specific_herbicide_output_enabled` / `ai_enabled`
 *   （见 `openapi.json` paths./admin/feature-flags/{key}.put.parameters 与 schemas.Flag）。
 * - 「**任何** flag **都不得**关闭硬规则、不得把"未求值/失败"变成"通过"、不得让未核对内容可发布」⇒
 *   两层守卫（见下）。
 * - 「若契约的 flag 集合里存在此类语义，必须显式拒绝该 key 并记审计」⇒
 *   第 1 层守卫：**安全语义保留名一律显式拒绝并写 `result: 'denied'` 的审计**
 *   （含"契约将来若把这类 key 加进闭集"的前向防护）。
 *
 * 审查依据（为什么这 3 个 key 不构成放宽）：issue #18 原文的范围是
 * 「账号授权、AI任务／错误／隔离查看、**停止投稿或药剂输出开关**」——
 * 三个 key 都是**能力门**（capability gate）：关掉即关闭/收紧对应能力，
 * 没有任何一个能把"未求值/失败"变成"通过"，也没有任何一个参与硬规则或发布门槛的判定。
 * 第 2 层守卫把这个结论变成**结构性不变量**：语义分类表在服务构造时自检，
 * 一旦出现"削弱 fail-closed"的条目就**拒绝启动**。
 */

/** 契约闭集里的 3 个 flag key（镜像；由契约比对测试保证不漂移）。 */
export const CONTRACT_FLAG_KEYS = [
  'submissions_enabled',
  'specific_herbicide_output_enabled',
  'ai_enabled',
] as const;
export type FlagKey = (typeof CONTRACT_FLAG_KEYS)[number];

/**
 * **安全语义保留名**：这些 key 一旦可设，就意味着"关闭硬规则 / 跳过审核 / 放行未核对内容"。
 * 契约当前闭集里**没有**它们；本片仍然**显式拒绝**（并记审计），作为前向防护——
 * 将来契约若把它们加进闭集，本服务会拒绝而不是静默照做。
 */
export const FORBIDDEN_FLAG_KEYS: readonly string[] = Object.freeze([
  'hard_rules_enabled',
  'hard_rule_enabled',
  'moderation_enabled',
  'moderation_required',
  'fail_closed',
  'fail_closed_enabled',
  'auto_approve',
  'auto_approve_enabled',
  'skip_moderation',
  'skip_review',
  'bypass_moderation',
  'bypass_hard_rules',
  'disable_hard_rules',
  'disable_moderation',
  'allow_unverified_publish',
  'publish_unverified',
]);

/** 安全语义**形态**匹配（兜住保留名之外的同义命名）。 */
export const FORBIDDEN_FLAG_KEY_PATTERN =
  /(hard_?rule|moderation|fail_?closed|auto_?approve|bypass|skip_?review|skip_?moderation|unverified_publish|disable_?review)/i;

/** 一个 flag 的语义分类。三个"放宽类"标志**必须恒为 false**。 */
export interface FlagEffect {
  /** 该开关把住哪个能力（说明性文字，不参与判定）。 */
  readonly gates: string;
  /** 是否会削弱 fail-closed。 */
  readonly weakens_fail_closed: boolean;
  /** 是否能关闭确定性硬规则层。 */
  readonly disables_hard_rules: boolean;
  /** 是否能让未核对内容可发布。 */
  readonly allows_unverified_publish: boolean;
}

/**
 * 契约 3 个 key 的默认语义分类：全部为**能力门**，三个放宽标志全部 false。
 * 表可注入（`createAdminOpsService({ flagEffects })`），以便在测试里证明
 * "出现放宽语义 ⇒ 拒绝启动"。
 */
export const DEFAULT_FLAG_EFFECTS: Readonly<Record<FlagKey, FlagEffect>> = Object.freeze({
  submissions_enabled: Object.freeze({
    gates: 'community_submissions',
    weakens_fail_closed: false,
    disables_hard_rules: false,
    allows_unverified_publish: false,
  }),
  specific_herbicide_output_enabled: Object.freeze({
    gates: 'specific_herbicide_output',
    weakens_fail_closed: false,
    disables_hard_rules: false,
    allows_unverified_publish: false,
  }),
  ai_enabled: Object.freeze({
    gates: 'ai_capabilities',
    weakens_fail_closed: false,
    disables_hard_rules: false,
    allows_unverified_publish: false,
  }),
});

/**
 * **构造期自检**：语义分类表里不允许存在任何"削弱 fail-closed"的条目。
 *
 * 这是「任何 flag 都不得关闭硬规则」的结构性不变量：
 * 数据一旦违规，服务**拒绝构造**（fail-closed at wiring time），
 * 而不是带着一个能放宽安全判定的开关跑起来。
 */
export function assertNoFlagWeakensFailClosed(effects: Readonly<Record<string, FlagEffect>>): void {
  for (const [key, effect] of Object.entries(effects)) {
    const violations: string[] = [];
    if (effect.weakens_fail_closed !== false) violations.push('weakens_fail_closed');
    if (effect.disables_hard_rules !== false) violations.push('disables_hard_rules');
    if (effect.allows_unverified_publish !== false) violations.push('allows_unverified_publish');
    if (violations.length > 0) {
      throw new Error(
        `flag「${key}」被声明为可放宽安全判定（${violations.join(',')}）：` +
          '任何开关都不得关闭硬规则、不得把未求值/失败变成通过、不得让未核对内容可发布。拒绝接线。',
      );
    }
  }
}

export type FlagKeyVerdict =
  | { ok: true; key: FlagKey }
  | { ok: false; kind: 'safety_critical'; matched: string }
  | { ok: false; kind: 'unknown' };

/**
 * 判定一个 `key` 路径参数是否可设。
 * 顺序有意如此：**先查安全语义保留名**（可记审计），再查契约闭集。
 */
export function classifyFlagKey(rawKey: unknown): FlagKeyVerdict {
  if (typeof rawKey !== 'string' || rawKey === '') return { ok: false, kind: 'unknown' };
  const normalized = rawKey.toLowerCase();
  if (FORBIDDEN_FLAG_KEYS.includes(normalized) || FORBIDDEN_FLAG_KEY_PATTERN.test(normalized)) {
    return { ok: false, kind: 'safety_critical', matched: normalized };
  }
  if ((CONTRACT_FLAG_KEYS as readonly string[]).includes(rawKey)) return { ok: true, key: rawKey as FlagKey };
  return { ok: false, kind: 'unknown' };
}

/**
 * 出厂默认状态：**全部 false**（功能关闭）。
 *
 * 理由：关闭态对所有使用方都是**最严格**的一侧——投稿关闭、药剂输出关闭、AI 关闭，
 * 不会因为"默认开启"而把未准备好/未核对的能力暴露出去。本片没有真实配置库，
 * 因此进程重启即回到这组默认值（如实声明，不冒充已持久化）。
 */
export function defaultFlagStates(): { key: FlagKey; enabled: boolean; revision: number }[] {
  return CONTRACT_FLAG_KEYS.map((key) => ({ key, enabled: false, revision: 1 }));
}
