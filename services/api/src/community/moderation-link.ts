/**
 * GY-I14（#14 审核域）⇄ GY-I15（#15 社区域）· **联动接线端口**（社区侧）。
 *
 * ## 纪律（沿用 `events.ts` / `knowledge.ts` / `takedown.ts` 的既有跨域口径）
 *
 * - 社区**不 import** 审核域实现（仓库既有分层：特征域不互相 import）。本文件只声明
 *   **结构性端口** `ModerationDomainPort`，由装配层（`services/api/src/app.ts`）把真实的
 *   `ModerationService` 传进来；因此本目录对 `services/api/src/moderation/**` 零依赖。
 * - **不另起规则引擎**：规则先挡的**记录口径**仍是社区既有 `gate.evaluate`
 *   （`packages/moderation` 的 `evaluateHardRules`，见 `moderation-gate.ts`）。
 *   审核域的规则层结论在这里只作两件事：**登记版本级任务**（`GET /jobs/{id}` 可读）与
 *   **否决**（definitive rejected）。社区不复制审核域的判定，也不重新实现合流。
 * - **fail-closed**：审核域抛错（例如 `real` 未接真实供应商 ⇒ 契约 503
 *   `PROVIDER_UNAVAILABLE`）一律**如实向上抛**，绝不吞掉、绝不当成"通过"；
 *   形如非 `ApiError` 的未知失败也按 `PROVIDER_UNAVAILABLE`（`retryable`）如实拒绝。
 * - **不冒充模型通过**：模型层没有真实调用点（端口是替身 / 未接线）时
 *   `model_layer === 'not_wired'`、`model_concluded === false`，调用方必须保持
 *   `contract_complete:false` + `missing_contract_fields`，**不得**把它记成"AI 审核通过"。
 *
 * ## 判定口径（唯一，逐条可断言）
 *
 * 审核域对某个 `(target, revision)` 的当前版本级任务集合 `T`（文字恒有；带媒体额外有图片）：
 *
 * | 观察 | 结论 |
 * | --- | --- |
 * | 存在任务 `decision==='rejected' && hard_rule_passed !== true` | `rule_layer='rejected'` ⇒ **驳回**（规则先挡） |
 * | 存在任务 `decision==='rejected' && hard_rule_passed === true` | `model_layer='rejected'` ⇒ **驳回**（模型层明确驳回） |
 * | 任务集**非空**且全部 `decision==='approved'` | `model_layer='approved'` ⇒ **可发布** |
 * | 全部端口 `provider.synthetic === true` 或 `origin==='substitute'`（或没有端口证据） | `model_layer='not_wired'` ⇒ **隔离**（**不是**通过，也不是驳回） |
 * | 其余 | `model_layer='unconcluded'` ⇒ **隔离** |
 *
 * **三态互斥**（`publishable` / `vetoed` / `isolation`，唯一实现，调用方不得自行重算）：
 *
 * | 态 | 判据 | 社区侧处置 |
 * | --- | --- | --- |
 * | **可发布** `publishable` | `decision === 'approved'`（任务集非空且全部通过） | 允许落内容行并公开（**经审核域 `publish` 闸门**写成 `published`） |
 * | **驳回** `vetoed` | 存在 `rejected` 任务（规则层或模型层） | **不落库**（400）+ 读取面退出公开面 |
 * | **隔离** `isolation` | 其余（`quarantined` / `pending` / 超时 / 未接线 / 无结论） | **不落库**（422）+ 读取面退出公开面 |
 *
 * 依据 `docs/product-requirements.md` **B09**（服务失败或**无法判断不公开**；AI 失败/超时/无结论**保持隔离**）
 * 与监工 #155 返修（P1，2026-10-15）：**"未接线/无结论"不得发布**；但**也不必伪装成"驳回"**——
 * 两者在对外错误码（400 vs 422）、台账 `decision`（`rejected` vs `quarantined`/`pending`）与
 * `model_layer`（`rejected` vs `not_wired`/`unconcluded`）上都如实区分，审计可分辨、不冒称"已审核通过"。
 * Demo 的**通过分支**必须由**明确标注的合成 `pass` 端口**（`provider.synthetic === true`）驱动，
 * **不得**用"未接线"冒充通过。
 */
import { ApiError } from '../errors.ts';

/** 契约 `TargetRef` 的社区子集（帖子/评论）。 */
export interface LinkTargetRef {
  type: 'post' | 'comment';
  id: string;
  revision: number;
}

/** 调用主体（与 `auth/middleware.ts` 的 `readIdentity` 同口径；**不来自客户端自述**）。 */
export interface LinkActor {
  userId: string;
  role: 'user' | 'admin';
  authEpoch: number;
}

/** 送审内容：与 `ModerationContent` 同形（文本恒有；媒体必须**显式**声明）。 */
export interface LinkContent {
  target_ref: LinkTargetRef;
  text: string;
  media: Array<{ media_id: string }>;
}

export type LinkAuditState = 'pending' | 'approved' | 'rejected' | 'quarantined';
export type LinkRuleLayer = 'passed' | 'rejected' | 'unconcluded';
export type LinkModelLayer = 'not_wired' | 'approved' | 'rejected' | 'unconcluded';

/** 一次送审的读取口径（**不是**契约对象；契约 `Moderation` 由审核域作业读面负责）。 */
export interface LinkScreenResult {
  target_ref: LinkTargetRef;
  rule_layer: LinkRuleLayer;
  model_layer: LinkModelLayer;
  decision: LinkAuditState;
  reason_codes: string[];
  /**
   * **审核域明确可发布**（`decision === 'approved'`：任务集非空且全部拿到通过结论）。
   * **只有它为 `true`** 时社区才允许落内容行并公开（B09：无法判断不公开）。
   */
  publishable: boolean;
  /** **明确驳回**（规则层 `rejected` 或模型层 `rejected`）⇒ 400（与"隔离"区分，不混淆）。 */
  vetoed: boolean;
  /** **隔离/未结论**（`quarantined` / `pending` / 超时 / 未接线 / 无结论）⇒ 422（不得发布，但**不**伪装成驳回）。 */
  isolation: boolean;
  rule_rejected: boolean;
  model_rejected: boolean;
  /** 模型层是否产出了**真实**结论（只有这时契约 `Moderation` 才可能装配完整）。 */
  model_concluded: boolean;
  /** 本次建立的版本级审核任务 id（证据：`GET /jobs/{id}`，`kind=moderation`）。 */
  task_ids: string[];
  task_kinds: string[];
  /** 端口证据来源（`injected`/`substitute`/`callback`/`none`），供审计与负例断言。 */
  provider_origins: string[];
  execution_mode: string;
}

/**
 * 发布闸门的结果口径（社区**只读**它，绝不自己写 `published`/`approved`）。
 *
 * `published === false` 一律按"未发布"处理（fail-closed）；审核域拒绝发布时是**抛错**，
 * 不会走到这里 —— 社区看到的错误码与 `details.reason_codes` 即拒绝原因。
 */
export interface LinkPublishResult {
  target_ref: LinkTargetRef;
  published: boolean;
  visibility: string | null;
  published_revision: number | null;
  cache_keys_invalidated: string[];
}

/** 该版本在审核域台账里的**当前**结论（读取时重查用；同步读，不发起审核）。 */
export interface LinkConclusion {
  /** 台账里是否有该 `(target, revision)` 的版本级任务。 */
  present: boolean;
  /** 台账是否**可读**。不可读 ⇒ 调用方必须按"无法判断 ⇒ 隔离"处理（fail-closed）。 */
  readable: boolean;
  /** 审核域对该版本**明确可发布**（`present && publishable`）。 */
  publishable: boolean;
  /** 明确驳回（非公开），与"隔离"分开表达。 */
  vetoed: boolean;
  /** 隔离/未结论：既非可发布、也非明确驳回（含"台账里没有该版本任务"）。 */
  isolation: boolean;
  decision: LinkAuditState | null;
  reason_codes: string[];
  task_ids: string[];
  model_layer: LinkModelLayer;
}

export interface LinkWithdrawResult {
  target_ref: LinkTargetRef;
  withdrawn: boolean;
  visibility: string | null;
  /**
   * 被失效的审核域读缓存键（下架即整链失效；可断言）。
   *
   * 这是下架唯一的对外信号：失效在审核域 `withdraw()` 内**同步**完成，本端口
   * 不再转出一层零订阅方的 `event` 字段（见 `.pg17/analysis/i14-moderation-gaps-20261019.md` R5/R6）。
   */
  invalidated_cache_keys: string[];
}

export interface LinkReadResult {
  visible: boolean;
  visibility: string | null;
  reason_codes: string[];
  cache_hit: boolean;
  cache_entry_stale: boolean;
  cache_keys_invalidated: string[];
}

/**
 * 审核域的**结构性端口**（只声明社区用到的子集）。
 *
 * 参数/返回都取 `unknown`：本目录**不 import** 审核域类型，形状核对在适配器里
 * **逐字段、fail-closed** 地做（形状不合 ⇒ 契约 503，绝不当成通过）。
 */
export interface ModerationDomainPort {
  readonly execution_mode?: string;
  submitScreening(input: unknown): Promise<unknown>;
  /**
   * **发布闸门**（与筛查分开的第二步）：社区把"已获筛查放行"的内容交给审核域发布，
   * 由审核域按自己的端口重跑模型层可发布判定与重审判定后才写可见性。
   * **不得**由社区自己写 `published`/`approved`。
   */
  publish(input: unknown): Promise<unknown>;
  withdraw(input: unknown): Promise<unknown>;
  readView(input: unknown): Promise<unknown>;
  tasks(target_ref: unknown): unknown;
  counts?(): unknown;
}

/** 审核域台账的**只读**计数（供证据页/用例断言；不参与任何业务判定）。 */
export interface LinkCounts {
  tasks: number;
  current: number;
  withdrawn: number;
  cache_entries: number;
  authority_origin: string;
  execution_mode: string;
}

export interface CommunityModerationLink {
  readonly wired: true;
  readonly note: string;
  /** 送审：建立/刷新该版本的版本级审核任务，并回读判定（**不吞错**）。 */
  screen(input: { actor: LinkActor; content: LinkContent }): Promise<LinkScreenResult>;
  /**
   * 发布（**筛查通过后的第二步**）：把该版本交给审核域的发布闸门，由其按自己的端口重跑
   * 模型层可发布判定与重审判定并写可见性。
   *
   * 社区**不得**自己写 `visibility:'published'` + `audit_state:'approved'`；
   * 审核域拒绝发布时**抛错**（不吞错），调用方必须保持"未发布"。
   */
  publish(input: { actor: LinkActor; content: LinkContent }): Promise<LinkPublishResult>;
  /** 下架（管理员动作）：驱动审核域整链缓存失效 + 该版本永久不可复活。 */
  withdraw(input: { actor: LinkActor; target_ref: LinkTargetRef; reason_code: string }): Promise<LinkWithdrawResult>;
  /** 读取时重查（隐藏/未发布/旧链接/账号状态不因缓存或旧链接复活）。 */
  readView(input: { actor: LinkActor; target_ref: LinkTargetRef }): Promise<LinkReadResult>;
  /** 台账当前结论（同步；供读取路径做"明确驳回即不可见"的加严判定）。 */
  conclusionFor(target_ref: LinkTargetRef): LinkConclusion;
  counts(): LinkCounts;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function auditStateOf(value: unknown): LinkAuditState | null {
  return value === 'pending' || value === 'approved' || value === 'rejected' || value === 'quarantined'
    ? value
    : null;
}

/** 形状不可用 ⇒ 契约 503（fail-closed；**绝不**把"读不懂"当成"通过了"）。 */
function shapeUnavailable(what: string): ApiError {
  return new ApiError('PROVIDER_UNAVAILABLE', `审核域${what}形状不可用（fail-closed，不得视为通过）`, {
    // 审核域端口形状不可用／无法归类 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。
    retryable: false,
  });
}

/**
 * 未知失败一律按"未接线/不可用"如实拒绝（fail-closed）。
 *
 * **不**把其它模块抛出的裸字符串错误码硬塞进 `ApiError`（那会绕过契约错误码闭集）；
 * 审核域自己的 `ApiError`（例如 `real` 的 503 `PROVIDER_UNAVAILABLE`）原样上抛，不遮蔽。
 */
function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  // 审核域端口形状不可用／无法归类 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。
  return new ApiError('PROVIDER_UNAVAILABLE', '审核域调用失败且无法归类（fail-closed）', { retryable: false });
}

interface TaskRead {
  job_id: string | null;
  content_kind: string | null;
  decision: LinkAuditState | null;
  hard_rule_passed: boolean;
  reason_codes: string[];
  /** 该任务的结论是否已过期（规则集/模型/prompt 版本前进 ⇒ 必须重评）。 */
  stale: boolean;
  /** 过期的可判别理由（审核域原样给出；不含正文）。 */
  stale_reason_codes: string[];
  provider_origin: string | null;
  provider_synthetic: boolean;
}

function readTasks(tasksValue: unknown): TaskRead[] {
  if (!Array.isArray(tasksValue)) return [];
  return tasksValue.filter(isPlainObject).map((task) => {
    const evidence = isPlainObject(task['evidence']) ? task['evidence'] : {};
    const provider = isPlainObject(evidence['provider']) ? evidence['provider'] : null;
    return {
      job_id: typeof task['job_id'] === 'string' ? task['job_id'] : null,
      content_kind: typeof task['content_kind'] === 'string' ? task['content_kind'] : null,
      decision: auditStateOf(task['decision']),
      hard_rule_passed: task['hard_rule_passed'] === true,
      reason_codes: stringArray(task['reason_codes']),
      // 缺字段一律按**过期**处理（fail-closed：证明不了"结论仍新鲜"就不许当已审）。
      stale: task['stale'] !== false,
      stale_reason_codes: stringArray(task['stale_reason_codes']),
      provider_origin: provider !== null && typeof provider['origin'] === 'string' ? provider['origin'] : null,
      provider_synthetic: provider !== null && provider['synthetic'] === true,
    };
  });
}

/** 由任务集合推出规则层/模型层结论（判定口径见文件头；**唯一**实现，不重复）。 */
export function judgeTasks(tasksValue: unknown): {
  rule_layer: LinkRuleLayer;
  model_layer: LinkModelLayer;
  decision: LinkAuditState;
  reason_codes: string[];
  publishable: boolean;
  vetoed: boolean;
  isolation: boolean;
  rule_rejected: boolean;
  model_rejected: boolean;
  model_concluded: boolean;
  task_ids: string[];
  task_kinds: string[];
  provider_origins: string[];
} {
  const tasks = readTasks(tasksValue);
  const ruleRejected = tasks.some((task) => task.decision === 'rejected' && task.hard_rule_passed !== true);
  const modelRejected = tasks.some((task) => task.decision === 'rejected' && task.hard_rule_passed === true);
  const allApproved = tasks.length > 0 && tasks.every((task) => task.decision === 'approved');
  const allRulePassed = tasks.length > 0 && tasks.every((task) => task.hard_rule_passed);
  /**
   * "曾经通过、但结论已过期"：规则集/模型/prompt 版本在结论之后前进 ⇒ 这一刻**不算已审**。
   * 它既不等于驳回（内容没被判定违规），也不能算通过（没按当前版本审过），
   * 因此归到既有契约状态 `pending`（＝待重评），**不新增**状态值。
   */
  const staleApproved = tasks.some((task) => task.stale === true && task.decision === 'approved');

  // "模型层没有真实调用点"的判据：没有任何 `injected`/`callback` 端口证据。
  // 替身（`synthetic === true` / `origin === 'substitute'`）与"没有端口证据"都算未接线。
  const hasWiredProvider = tasks.some(
    (task) =>
      task.provider_synthetic !== true &&
      (task.provider_origin === 'injected' || task.provider_origin === 'callback'),
  );

  let modelLayer: LinkModelLayer;
  if (modelRejected) modelLayer = 'rejected';
  else if (allApproved) modelLayer = 'approved';
  else if (!hasWiredProvider) modelLayer = 'not_wired';
  else modelLayer = 'unconcluded';

  const decision: LinkAuditState =
    ruleRejected || modelRejected
      ? 'rejected'
      : allApproved && !staleApproved
        ? 'approved'
        : tasks.some((task) => task.decision === 'pending') || staleApproved
          ? 'pending'
          : 'quarantined';

  // 过期理由与任务自身理由合并去重（过期理由同样来自引擎闭集，不含正文）。
  const reasonCodes = [
    ...new Set([
      ...tasks.flatMap((task) => task.reason_codes),
      ...tasks.flatMap((task) => task.stale_reason_codes),
    ]),
  ].slice(0, 30);
  // **三态互斥**：只有"任务集非空且全部 approved"才可发布；存在 rejected 任务即驳回；
  // 其余（quarantined / pending / 未接线 / 无结论 / 超时）一律**隔离**（不得发布，也不谎称驳回）。
  const publishable = decision === 'approved';
  const vetoed = ruleRejected || modelRejected;
  return {
    rule_layer: ruleRejected ? 'rejected' : allRulePassed ? 'passed' : 'unconcluded',
    model_layer: modelLayer,
    decision,
    reason_codes: reasonCodes,
    publishable,
    vetoed,
    isolation: !publishable && !vetoed,
    rule_rejected: ruleRejected,
    model_rejected: modelRejected,
    model_concluded: allApproved || modelRejected,
    task_ids: tasks.map((task) => task.job_id).filter((id): id is string => id !== null),
    task_kinds: tasks.map((task) => task.content_kind).filter((kind): kind is string => kind !== null),
    provider_origins: tasks
      .map((task) => task.provider_origin)
      .filter((origin): origin is string => origin !== null),
  };
}

function actorOf(actor: unknown): LinkActor {
  const holder = isPlainObject(actor) ? actor : {};
  return {
    userId: typeof holder['userId'] === 'string' ? holder['userId'] : '',
    role: holder['role'] === 'admin' ? 'admin' : 'user',
    authEpoch: typeof holder['authEpoch'] === 'number' ? holder['authEpoch'] : 0,
  };
}

function targetOf(value: unknown): LinkTargetRef {
  const holder = isPlainObject(value) ? value : {};
  const type = holder['type'];
  return {
    type: type === 'comment' ? 'comment' : 'post',
    id: typeof holder['id'] === 'string' ? holder['id'] : '',
    revision: typeof holder['revision'] === 'number' ? holder['revision'] : 0,
  };
}

/**
 * 构造社区侧的审核域联动端口。
 *
 * **本函数不做任何本地判定**：判定一律来自审核域台账（`judgeTasks` 只做"读口径"，
 * 不重写规则匹配、不重写合流、不合成结论）。
 */
export function createCommunityModerationLink(options: {
  moderation: ModerationDomainPort;
  note?: string;
}): CommunityModerationLink {
  const moderation = options.moderation;

  async function submit(input: { actor: LinkActor; content: LinkContent }): Promise<LinkScreenResult> {
    let raw: unknown;
    try {
      raw = await moderation.submitScreening({ actor: input.actor, content: input.content });
    } catch (error) {
      // **不吞错**：`real` 的 503 必须原样到达调用方（fail-closed）。
      throw asApiError(error);
    }
    if (!isPlainObject(raw)) throw shapeUnavailable('送审结论');
    const judged = judgeTasks(raw['tasks']);
    return {
      target_ref: targetOf(input.content.target_ref),
      ...judged,
      execution_mode: typeof moderation.execution_mode === 'string' ? moderation.execution_mode : 'unknown',
    };
  }

  async function publish(input: { actor: LinkActor; content: LinkContent }): Promise<LinkPublishResult> {
    let raw: unknown;
    try {
      raw = await moderation.publish({ actor: input.actor, content: input.content });
    } catch (error) {
      // **不吞错**：审核域拒绝发布（REVISION_CONFLICT / INPUT_UNCERTAIN / OBJECT_UNAVAILABLE …）
      // 必须原样到达调用方 —— 内容**不得**因此变成"已发布"。
      throw asApiError(error);
    }
    if (!isPlainObject(raw)) throw shapeUnavailable('发布结论');
    // 形状不可读／没写成 ⇒ 一律按"未发布"拒绝（fail-closed；**绝不**当成发布成功）。
    if (raw['published'] !== true) {
      throw new ApiError('INPUT_UNCERTAIN', '审核域发布未生效（fail-closed，不得视为已发布）', {
        retryable: false,
      });
    }
    const publishedRevision = raw['published_revision'];
    return {
      target_ref: targetOf(raw['target_ref']),
      published: true,
      visibility: typeof raw['visibility'] === 'string' ? raw['visibility'] : null,
      published_revision: typeof publishedRevision === 'number' ? publishedRevision : null,
      cache_keys_invalidated: stringArray(raw['cache_keys_invalidated']),
    };
  }

  async function withdraw(input: {
    actor: LinkActor;
    target_ref: LinkTargetRef;
    reason_code: string;
  }): Promise<LinkWithdrawResult> {
    let raw: unknown;
    try {
      raw = await moderation.withdraw({ actor: input.actor, target_ref: input.target_ref, reason_code: input.reason_code });
    } catch (error) {
      throw asApiError(error);
    }
    if (!isPlainObject(raw)) throw shapeUnavailable('下架结论');
    return {
      target_ref: targetOf(raw['target_ref']),
      withdrawn: raw['withdrawn'] === true,
      visibility: typeof raw['visibility'] === 'string' ? raw['visibility'] : null,
      invalidated_cache_keys: stringArray(raw['invalidated_cache_keys']),
    };
  }

  async function readView(input: { actor: LinkActor; target_ref: LinkTargetRef }): Promise<LinkReadResult> {
    let raw: unknown;
    try {
      raw = await moderation.readView({ actor: input.actor, target_ref: input.target_ref });
    } catch (error) {
      throw asApiError(error);
    }
    if (!isPlainObject(raw)) throw shapeUnavailable('读取重查结论');
    return {
      visible: raw['visible'] === true,
      visibility: typeof raw['visibility'] === 'string' ? raw['visibility'] : null,
      reason_codes: stringArray(raw['reason_codes']),
      cache_hit: raw['cache_hit'] === true,
      cache_entry_stale: raw['cache_entry_stale'] === true,
      cache_keys_invalidated: stringArray(raw['cache_keys_invalidated']),
    };
  }

  function conclusionFor(target_ref: LinkTargetRef): LinkConclusion {
    let tasks: unknown;
    try {
      tasks = moderation.tasks(target_ref);
    } catch {
      // 台账读不出来 ⇒ **不可读**：调用方必须按"无法判断 ⇒ 隔离"处理（B09），
      // 绝不把"读不懂"当成"可发布"。
      return {
        present: false,
        readable: false,
        publishable: false,
        vetoed: false,
        isolation: true,
        decision: null,
        reason_codes: [],
        task_ids: [],
        model_layer: 'unconcluded',
      };
    }
    const judged = judgeTasks(tasks);
    const present = judged.task_ids.length > 0;
    return {
      present,
      readable: true,
      // 台账里没有该版本任务 ⇒ **不**算"可发布"（没有结论就不是放行）。
      publishable: present && judged.publishable,
      vetoed: present && judged.vetoed,
      isolation: !present || judged.isolation,
      decision: present ? judged.decision : null,
      reason_codes: judged.reason_codes,
      task_ids: judged.task_ids,
      model_layer: judged.model_layer,
    };
  }

  function counts(): LinkCounts {
    const raw = typeof moderation.counts === 'function' ? moderation.counts() : null;
    const holder = isPlainObject(raw) ? raw : {};
    return {
      tasks: typeof holder['tasks'] === 'number' ? holder['tasks'] : 0,
      current: typeof holder['current'] === 'number' ? holder['current'] : 0,
      withdrawn: typeof holder['withdrawn'] === 'number' ? holder['withdrawn'] : 0,
      cache_entries: typeof holder['cache_entries'] === 'number' ? holder['cache_entries'] : 0,
      authority_origin: typeof holder['authority_origin'] === 'string' ? holder['authority_origin'] : 'unknown',
      execution_mode: typeof moderation.execution_mode === 'string' ? moderation.execution_mode : 'unknown',
    };
  }

  return {
    wired: true,
    note:
      options.note ??
      '版本级审核任务与结论来自已合并审核域（services/api/src/moderation/**）；社区只做读取与否决，不重写判定',
    screen: submit,
    publish,
    withdraw,
    readView,
    conclusionFor,
    counts,
  };
}

/** 主体规范化（社区服务内部用；与 `CommunityActor` 同形）。 */
export function linkActorOf(actor: { userId: string; role: 'user' | 'admin'; authEpoch: number }): LinkActor {
  return actorOf(actor);
}
