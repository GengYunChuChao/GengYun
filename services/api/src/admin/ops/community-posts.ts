/**
 * GY-I18 阶段 1b · `hidePost` 适配层。
 *
 * 纪律（派单第 2 条）：**复用社区的可见性语义**，不在 admin 里另写一套可见性/审核判定。
 * 因此这里只做三件事：
 *   1. 调社区 store 的 `getPost` 读当前状态（拿到是否已隐藏 / 已删除 / 当前 revision）；
 *   2. **先**比对调用方给的期望 revision（`If-Match` 的服务端等价物），不匹配就**不写**；
 *   3. 调社区 store **唯一的更新原语** `commitPostIfCurrent`（CAS）把 `visibility` 置为 `'hidden'`，
 *      并把 CAS 的结果如实映射——**绝不**自己拼 visibility、**绝不**自己判断"能不能复活"。
 *
 * 「已删除不可复活」由社区 CAS 自己保证（`community/store.ts` 中
 * `current.visibility === 'deleted'` ⇒ `{ok:false, reason:'DELETED'}`，是单向门）。
 * 本层把该失败**如实**映射成拒绝，不会把 DELETED 谎报成成功。
 *
 * 「退出列表」同样由社区读取侧保证：`community/service.ts` 的口径是
 * 「对外可见 ⟺ `visibility === 'published'` 且 `audit_state === 'approved'`」，
 * 置为 `hidden` 后所有公开读（列表与详情）都会把它排除。
 */
import type { PostRecord } from '../../community/store.ts';
import type { AuditState, Visibility } from '../../community/types.ts';
import type { CommunityPostPort, CommunityPostReadPort } from './types.ts';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../../auth/tokens.ts';
import type { CommunityEventsPort } from '../../community/events.ts';
import { createPublishGate } from '../../community/moderation-gate.ts';
import type { PublishGate } from '../../community/moderation-gate.ts';
import { postModerationText } from '../../community/service.ts';
import type { ModerationRecord } from '../../community/store.ts';
import type { PostReviewPort, PostReviewRequest, PostReviewResult } from './types.ts';

export type HidePostResult =
  | { ok: true; changed: boolean; previousRevision: number; revision: number }
  | { ok: false; reason: 'NOT_FOUND' | 'DELETED' | 'NOT_PUBLIC' | 'REVISION_CONFLICT' | 'STORE_UNAVAILABLE' };

/** 下架审计的"谁 / 哪次请求"（迁移 0047 的 `record_admin_post_hide_audit` 前两个必填项之外的输入）。 */
export interface HidePostAuditContext {
  /** 操作者（服务层传 `context.identity.userId`，⛔ 不接受调用方自报）。 */
  readonly actorId: string;
  /** 请求 id（服务层传 `context.requestId`，与内存台账的 `appendAudit` 同一来源）。 */
  readonly requestId: string;
}

export interface HidePostAdapter {
  readonly wired: boolean;
  /**
   * 审计是否**真落库**（本片把 `post.hide` 从进程内存搬到 PG 的分水岭）。
   *
   * - `false`（未接线 / 内存 store）⇒ 服务层仍走内存台账 `appendAudit`，与改动前逐字一致；
   * - `true`（PG store）⇒ 审计由 `commitPostIfCurrent` 在**帖子事务内**写 `admin_audit_events`，
   *   服务层**不再** `appendAudit`（⛔ 两处都记 = 一条动作两条审计）。
   *
   * 判据取自端口自己的能力位（`CommunityPostPort.persistent`，`community/store.ts` 恒 false、
   * `community/store-pg.ts` 恒 true、`community/takedown.ts` 原样转发），不是本层自述的布尔。
   */
  readonly persistent: boolean;
  /**
   * `expectedRevision` 必须在**任何写入之前**比对（避免"先隐藏再报冲突"的部分生效）。
   *
   * `audit` 只在真库实现上用得上；审计写不进去时**抛** `PROVIDER_UNAVAILABLE`（已回滚、隐藏未生效），
   * 由服务层原样上抛为 503 —— ⛔ 不在这里折叠成 `REVISION_CONFLICT`，⛔ 也不吞成成功。
   */
  hide(id: string, expectedRevision: number, audit: HidePostAuditContext): Promise<HidePostResult>;
}

export function createHidePostAdapter(port: CommunityPostPort | undefined, now: () => Date): HidePostAdapter {
  if (port === undefined) {
    return Object.freeze({
      wired: false,
      // 未接线 ⇒ 没有真实审计落点，服务层继续走内存台账。
      persistent: false,
      hide: async (): Promise<HidePostResult> => ({ ok: false, reason: 'STORE_UNAVAILABLE' }),
    });
  }
  const community = port;
  const persistent = community.persistent === true;

  return Object.freeze({
    wired: true,
    persistent,
    async hide(id: string, expectedRevision: number, audit: HidePostAuditContext): Promise<HidePostResult> {
      const current = await community.getPost(id);
      if (current === null) return { ok: false, reason: 'NOT_FOUND' };
      // 已删除是单向门：真正的守卫在社区 CAS 里（下面同样会拒），这里先如实回拒。
      if (current.visibility === 'deleted') return { ok: false, reason: 'DELETED' };
      // If-Match 的服务端等价物：**写之前**比对，避免部分生效。
      if (current.revision !== expectedRevision) return { ok: false, reason: 'REVISION_CONFLICT' };
      // 幂等：已经隐藏 ⇒ 不再迁移、不再记审计。
      if (current.visibility === 'hidden') {
        return { ok: true, changed: false, previousRevision: current.revision, revision: current.revision };
      }
      // 作者的未发布草稿不改写（显式的 fail-closed 策略，见报告）。
      if (current.visibility !== 'published') return { ok: false, reason: 'NOT_PUBLIC' };

      const result = await community.commitPostIfCurrent(
        id,
        { revision: current.revision, visibility: current.visibility },
        { revision: current.revision + 1, visibility: 'hidden', updated_at: now().toISOString() },
        null,
        // 审计与可见性变更**同一次原子提交**（PG 实现里同一个事务）：
        // `postRevision` 用 CAS 读到的**隐藏前** revision，与内存台账原来的 `previousRevision` 同义。
        {
          actorId: audit.actorId,
          postId: id,
          postRevision: current.revision,
          reasonCode: 'post_hidden',
          requestId: audit.requestId,
        },
      );
      if (!result.ok) {
        if (result.reason === 'DELETED') return { ok: false, reason: 'DELETED' };
        if (result.reason === 'NOT_FOUND') return { ok: false, reason: 'NOT_FOUND' };
        // REVISION_CHANGED / VISIBILITY_CHANGED / AUDIT_STATE_CHANGED / AUTHOR_CHANGED
        return { ok: false, reason: 'REVISION_CONFLICT' };
      }
      return { ok: true, changed: true, previousRevision: current.revision, revision: result.record.revision };
    },
  });
}

/* ------------------------------------------------------------------ *
 * R59 · 后台帖子**读面**适配层（`listAdminPosts` / `getAdminPost`）
 * ------------------------------------------------------------------ */

/** 已解析的后台列表查询（游标已在服务层验签+解出，这里只做下推）。 */
export interface AdminPostPageQuery {
  readonly limit: number;
  readonly after: { createdAt: string; id: string } | null;
  readonly state: Visibility | null;
  readonly auditState: AuditState | null;
}

export interface AdminPostReadAdapter {
  /**
   * 管理视角一页。**强制** `scope: 'admin'` —— 这是本读面的定义：
   * 候选集里必须有 `hidden` / `deleted`（用户读面 `scope: 'public'` 会把它们全部排除），
   * 否则管理员看不到自己要处置的行。`state` / `auditState` 只做**等值收窄**，不做可见性判定。
   */
  list(query: AdminPostPageQuery): Promise<{ items: PostRecord[]; hasMore: boolean }>;
  /** 管理视角单条。`null` ⇒ 不存在（服务层映射 404，⛔ 不用 403 泄露存在性）。 */
  get(id: string): Promise<PostRecord | null>;
}

/**
 * `port` 未接线 ⇒ 返回 `null`（服务层 fail-closed 503）。
 * ⛔ 不返回"空页适配器"：空列表会被读成「库里没有帖子」，那是伪造读数。
 */
export function createAdminPostReadAdapter(port: CommunityPostReadPort | undefined): AdminPostReadAdapter | null {
  if (port === undefined) return null;
  const community = port;

  return Object.freeze({
    async list(query: AdminPostPageQuery): Promise<{ items: PostRecord[]; hasMore: boolean }> {
      // 多取一行判定 `next_cursor`，返回前截掉——比再跑一次 count 便宜，且不会给出总数
      // （后台列表契约明确不返回总数，见 `AdminPostPageEnvelope` 描述）。
      const rows = await community.listPosts({
        scope: 'admin',
        state: query.state ?? undefined,
        auditState: query.auditState ?? undefined,
        after: query.after,
        limit: query.limit + 1,
      });
      const hasMore = rows.length > query.limit;
      return { items: hasMore ? rows.slice(0, query.limit) : rows, hasMore };
    },
    async get(id: string): Promise<PostRecord | null> {
      return community.getPost(id);
    },
  });
}

// ---------------------------------------------------------------------------
// S3：人工「通过 / 驳回」
// ---------------------------------------------------------------------------

export interface PostReviewAdapterOptions {
  /** 社区存储端口；缺省 ⇒ 未接线（`wired: false`，服务层 503）。 */
  port?: CommunityPostPort;
  /**
   * 作者通知端口（`community/events.ts` 的既有端口）。
   *
   * 缺省 = 未接线：**仍然能审核**，只是 `notified: false`。理由与既有纪律一致
   * （`community/takedown.ts:74-84`）：结论是事实，通知是副作用；通知没接线不该让审核不可用。
   */
  events?: CommunityEventsPort;
  /**
   * 发布门（`community/moderation-gate.ts`）。默认 `createPublishGate()`，
   * 与 `community/service.ts:264` 的缺省门**同源**（同一套规则集 ⇒ 同一个 `rule_version`）。
   *
   * 为什么要它：人工结论必须带上**当前规则集版本**才能被读面认作有效——
   * `effectiveState()`（`community/service.ts:604-605`）在 `rule_version` 与当前不符时
   * 直接把结论降级为 `pending`/`quarantined`。因此审核写结论前必须向门要版本，
   * **不接受**调用方自带版本号（否则「用假版本号放行」成为可能）。
   */
  gate?: PublishGate;
  /** 时钟（测试可注入）；缺省取系统时间，与 `createHidePostAdapter` 的注入风格一致。 */
  now?: () => Date;
}

/**
 * 帖子人工审核适配器：`approve` 放行、`reject` 驳回，**都只经社区的 CAS 原语落库**。
 *
 * 与 `createHidePostAdapter` 的三条同款纪律：
 *   1. 先读当前状态（拿到 revision / visibility / audit_state）；
 *   2. **写之前**比对 `If-Match`（`expectedRevision`），不符即拒，避免部分生效；
 *   3. 只调 `commitPostIfCurrent`（CAS），结论随内容**同一次原子提交**写进
 *      `community_moderation_decisions`（PG 实现里与帖子行同一事务）。
 *
 * 与 `hidePost` 的**关键差异**（写手必读）：
 *   - `approve` 对**待审未发布**（`visibility === 'private'`）的帖子**同时把可见性推向
 *     `published`**：待审队列本身就是"私有 + 待审"（`community/service.ts:1066-1067`、
 *     `:1197-1198` 由"联动发布未成"造成的 `private`+`pending`），而读面口径是
 *     "可见 ⟺ published 且 approved"（`service.ts:10`）。若只翻 `audit_state`，
 *     这些行会永远停在 private——"先审后发"就没有出口。契约里也**没有**单独的
 *     发布 endpoint（`/posts` 只有 get/post/patch/delete），所以这条出口只能在这里。
 *   - `approve` **不**把 `hidden`（下架）翻回来：一篇被 `hidePost` 隐藏过的帖子，
 *     人工通过后仍然是隐藏的（下架是平台/作者的另一条决定，审核不为它翻案）；
 *   - `reject` 除了 `audit_state='rejected'` 还必须把 `visibility` 置 `hidden`：
 *     驳回的语义是"不可公开"，只写 `audit_state` 会让读面去算，
 *     而读面的降级口径（`effectiveState` 的 `demoted`）在 `private` 帖上仍回 `private`
 *     —— 显式置 `hidden` 是这条动作**自己**要负责的事。
 *   - `reject` 会**顺带**触发装配层的 `withTakedownObserver`（`app.ts:1277`）再发一条
 *     `takedown` 事件 ⇒ 一篇被驳回的帖子会收到 `moderation_result` + `takedown` 两条通知。
 *     这是既有行为，本片**不去重**（去重属 S4），但测试里把它写成期望值。
 */
export function createPostReviewAdapter(options: PostReviewAdapterOptions): PostReviewPort {
  const port = options.port;
  if (port === undefined) {
    return Object.freeze({
      wired: false,
      review: async (): Promise<PostReviewResult> => ({ ok: false, reason: 'STORE_UNAVAILABLE' }),
    });
  }
  const community = port;
  const gate = options.gate ?? createPublishGate();
  const now = options.now ?? (() => new Date());
  const events = options.events;

  /** 通知作者；**永不抛**（失败只回 `false`，已提交的结论不回滚）。 */
  async function notify(
    post: PostRecord,
    revision: number,
    decision: 'approved' | 'rejected',
    reasonCodes: readonly string[],
  ): Promise<boolean> {
    // 匿名化帖子（`author_id === null`）没有可通知的人：不发，也不算失败。
    if (post.author_id === null || events === undefined) return false;
    try {
      // 复用社区**既有**事件形状（不新造 `post_approved`/`post_rejected`）：
      // `createMessagesCommunityEventsPort` 会把它投影成契约 `Message.type='moderation'`，
      // `event_key` 为 `community:moderation_result:post:<id>:r<rev>:<decision>`（同一版同一结论只一条）。
      const delivery = await events.publish({
        event: 'moderation_result',
        ownerId: post.author_id,
        target: { type: 'post', id: post.id, revision },
        decision,
        reasonCodes: [...reasonCodes],
      });
      return delivery.delivered === true;
    } catch {
      // 通知是副作用：吞掉，如实回 false。回滚已提交的审核结论会让运营看到 500 但状态已变。
      return false;
    }
  }

  /** 构造人工结论行（形状与 `community/service.ts:337-356` 的 `buildVerdict` 逐字同源）。 */
  function humanVerdict(
    post: PostRecord,
    revision: number,
    decision: 'approved' | 'rejected',
    ruleVersion: string,
    reasonCodes: readonly string[],
    missingFields: readonly string[],
    actorId: string,
  ): ModerationRecord {
    return {
      id: randomUUID(),
      // ⚠️ 必须写**新** revision：`commitPost` 按 `next.revision` 存结论，
      // 读面又按 `target_ref.revision === record.revision` 比对，写错版本会被判 `pending`。
      target_ref: { type: 'post', id: post.id, revision },
      decision,
      reason_codes: [...reasonCodes],
      // 复用审核域的硬约束（`packages/moderation/review.mjs:165-172`）：
      //   approved ⇒ hard_rule_passed 必须 true；rejected ⇒ 必须 false。
      // 写反了会被判 DECISION_INCONSISTENT，读面落 quarantined 而不是 rejected。
      hard_rule_passed: decision === 'approved',
      rule_version: ruleVersion,
      // 与读面**同一个**正文口径（`community/service.ts:226`），否则 `effectiveState` 判 `pending`。
      text_digest: sha256Hex(postModerationText(post)),
      contract_complete: false,
      missing_contract_fields: [...missingFields],
      // 迁移 0045：人工结论的"谁"。机器路径不传该字段 ⇒ NULL。
      decided_by: actorId,
      created_at: now().toISOString(),
    };
  }

  return Object.freeze({
    wired: true,
    async review(request: PostReviewRequest): Promise<PostReviewResult> {
      const current = await community.getPost(request.postId);
      if (current === null) return { ok: false, reason: 'NOT_FOUND' };
      // 已删除是单向门：真正的守卫在社区 CAS 里，这里先如实回拒。
      if (current.visibility === 'deleted') return { ok: false, reason: 'DELETED' };
      if (current.revision !== request.expectedRevision) return { ok: false, reason: 'REVISION_CONFLICT' };

      const ruleVersion = gate.currentRuleVersion();
      if (ruleVersion === null) {
        // 写进去也会被读面判 RULE_VERSION_UNKNOWN ⇒ quarantined。宁可拒绝，不伪造"已审"。
        return { ok: false, reason: 'RULE_VERSION_UNKNOWN' };
      }
      const text = postModerationText(current);
      // 门禁复核：只取"硬规则层是否明确否决 + 缺失契约字段"这两件事，**不做**放行判定
      // （人工审核的意义正是覆盖"引擎没给结论/给了隔离"的情形）。
      const outcome = gate.evaluate({ type: 'post', id: current.id, revision: current.revision }, text, []);

      if (request.decision === 'approved') {
        // 硬规则否决**不可**由人工放行：那是违禁/违法内容的红线，不是"运营权衡"。
        if (outcome.hard_rule_passed !== true) {
          return { ok: false, reason: 'RULE_VETOED', reasonCodes: [...outcome.reason_codes] };
        }
        // v1 口径：**通过动作同时承担发布语义**（`private → published` + `audit_state='approved'`）。
        // 依据三条：待审帖在库里就是 private+pending；公开读面要求「published 且 approved」；契约里
        // 没有作者自助发布口 ⇒ 只翻 audit_state 会让「通过」变成黑洞（运营点了通过、帖子永远不可见）。
        // 作者自助发布口是 S4 的独立能力，届时若上线，通过动作是否仍翻 visibility 需重新裁定
        // （口径页：docs/architecture/s3-community-review-design.md §1）。
        // 不对称：hidden/deleted **不**为它们翻案（下架/删除是单向门），幂等返回当前状态。见下方幂等分支。
        const targetVisibility: PostRecord['visibility'] =
          current.visibility === 'private' ? 'published' : current.visibility;
        // 幂等：已经是"已通过"且可见性无需推进 ⇒ 不迁移、不再通知、不落第二条结论。
        if (current.audit_state === 'approved' && targetVisibility === current.visibility) {
          return {
            ok: true,
            changed: false,
            previousRevision: current.revision,
            revision: current.revision,
            auditState: 'approved',
            visibility: current.visibility,
            notified: false,
            reasonCodes: [],
          };
        }
        const verdict = humanVerdict(
          current,
          current.revision + 1,
          'approved',
          ruleVersion,
          [],
          outcome.missing_contract_fields,
          request.actorId,
        );
        const result = await community.commitPostIfCurrent(
          current.id,
          { revision: current.revision, visibility: current.visibility, audit_state: current.audit_state },
          {
            revision: current.revision + 1,
            audit_state: 'approved',
            ...(targetVisibility === current.visibility ? {} : { visibility: targetVisibility }),
            updated_at: now().toISOString(),
          },
          verdict,
        );
        if (!result.ok) {
          if (result.reason === 'DELETED') return { ok: false, reason: 'DELETED' };
          if (result.reason === 'NOT_FOUND') return { ok: false, reason: 'NOT_FOUND' };
          return { ok: false, reason: 'REVISION_CONFLICT' };
        }
        const notified = await notify(current, result.record.revision, 'approved', []);
        return {
          ok: true,
          changed: true,
          previousRevision: current.revision,
          revision: result.record.revision,
          auditState: 'approved',
          visibility: result.record.visibility,
          notified,
          reasonCodes: [],
        };
      }

      // ---- 驳回 ----
      const reasonCodes = request.reasonCode === null ? [] : [request.reasonCode];
      // 幂等：已驳回且已隐藏 ⇒ 不迁移、不再通知。
      if (current.audit_state === 'rejected' && current.visibility === 'hidden') {
        return {
          ok: true,
          changed: false,
          previousRevision: current.revision,
          revision: current.revision,
          auditState: 'rejected',
          visibility: 'hidden',
          notified: false,
          reasonCodes,
        };
      }
      const verdict = humanVerdict(
        current,
        current.revision + 1,
        'rejected',
        // rejected ⇒ hard_rule_passed 必须 false（review.mjs 的硬约束），故这里传 false 由
        // humanVerdict 依 decision 派生；缺失字段沿用门禁给的清单。
        ruleVersion,
        reasonCodes,
        outcome.missing_contract_fields,
        request.actorId,
      );
      const result = await community.commitPostIfCurrent(
        current.id,
        { revision: current.revision, visibility: current.visibility, audit_state: current.audit_state },
        {
          revision: current.revision + 1,
          audit_state: 'rejected',
          visibility: 'hidden',
          updated_at: now().toISOString(),
        },
        verdict,
      );
      if (!result.ok) {
        if (result.reason === 'DELETED') return { ok: false, reason: 'DELETED' };
        if (result.reason === 'NOT_FOUND') return { ok: false, reason: 'NOT_FOUND' };
        return { ok: false, reason: 'REVISION_CONFLICT' };
      }
      const notified = await notify(current, result.record.revision, 'rejected', reasonCodes);
      return {
        ok: true,
        changed: true,
        previousRevision: current.revision,
        revision: result.record.revision,
        auditState: 'rejected',
        visibility: 'hidden',
        notified,
        reasonCodes,
      };
    },
  });
}
