/**
 * GY-R28-W3 · TTS「已核对内容」读取端口 · **真实实现**（PostgreSQL 只读）。
 *
 * ## 这个端口到底读什么（判定依据见证据页 §1）
 *
 * 契约 `SynthesisInput.checked_content_ref` 只有一个 `(type, id, revision)` 三元组
 * （`packages/contracts/openapi.json:13256-13271`，`SynthesisTarget` 见 `:13225-13255`），
 * 所以「已核对内容」不是一个独立接口，而是**服务端对该目标当前状态的读取**：
 * 归属 + 核对状态 + 当前 revision + 可朗读正文（四件同时在 `CheckedContentSnapshot`，
 * `services/api/src/tts/state.ts:267-278`）。本文件只补最后一跳：把库里**已经存在**的
 * 核对结论读出来，交给 `decideCheckedContent`（`services/api/src/tts/state.ts:335-378`）判定。
 *
 * ⛔ 合成期**不做**内容安全外呼：这里是只读查询，不调审核 API、不写库、不改核对状态。
 * 「未通过核对」的结论来自**离线**已经落库的审核结果，不是这里现算的。
 *
 * ## 两个真实来源（逐个说清，不按类型名猜）
 *
 * | `SynthesisTarget.type` | 真实来源 | 核对状态怎么来 |
 * | --- | --- | --- |
 * | `answer` | `public.conversation_answers`（迁移 `0013_conversations.sql:103-123`） | `check_state`：`passed` ⇒ `approved`；`blocked` ⇒ `rejected`；其它取值**原样透出**（判定层按「取不到核对状态」拒绝） |
 * | `species`/`herbicide`/`scheme`/`static_region` | `catalog_read.current_knowledge`（迁移 `0010_knowledge_read_views.sql:3-34`；来源版本须 `review_status='verified'`，见 `0002_knowledge_catalog.sql:214`） | **行存在即已核对并已发布** ⇒ `approved`；未核对/未发布的知识**不在该视图里** ⇒ 读不到行 ⇒ 404（fail-closed 的自然形状） |
 * | `dose_card` | **没有**可核验来源 | 读不到 ⇒ `null` ⇒ 404。生产口径的 `dose_cards` 恒为 `[]`（`services/api/src/ocr/reference.ts` 的两处组装），库内没有可核验的单卡核对结论；本片如实返回「不存在」，**不**从别处拼一张卡来冒充 |
 *
 * ## 故障口径（与 `tts/content.ts:8-13` 的安全口径逐条对齐）
 *
 * - 查不到行 ⇒ 返回 `null` ⇒ 404 `NOT_FOUND`（不存在／非本人可见同形）。
 * - 查询抛错（连接失败、超时、表缺失）⇒ 抛 `CheckedContentUnavailableError`
 *   ⇒ 409 `OBJECT_UNAVAILABLE`（`services/api/src/tts/service.ts:282-291` 的 catch 分支），
 *   **绝不**被当作 `approved`，也**绝不**退回 404 假装不存在。
 * - 驱动原始 message 绝不外带（不泄露主机名、SQL、用户标识）：只保留一句固定中文。
 *
 * ## 未配置 ⇒ 与现 main 逐字节一致
 *
 * `createCheckedContentPortFromConfig` 的三条分支：
 *   1. `executionMode !== 'real'` ⇒ 委托 `createMemoryCheckedContentPort(entries)`（替身，行为不变）；
 *   2. `real` 且 `pool === null`（没配 `DATABASE_URL`／没建连接池）⇒ 委托
 *      `createUnwiredCheckedContentPort()`，**同一个**端口、**同一条**原因文本 ⇒ 仍 fail-closed；
 *   3. `real` 且 `pool !== null` ⇒ 本文件的真实现。
 */
import type { CheckedContentPort, SubstituteCheckedContentEntry } from '../tts/content.ts';
import { CheckedContentUnavailableError, createMemoryCheckedContentPort, createUnwiredCheckedContentPort } from '../tts/content.ts';
import type { CheckedContentSnapshot, SynthesisTargetType } from '../tts/state.ts';
import {
  CheckedContentWiringError,
  createUnwiredCheckedContentSource,
  isCheckedContentRow,
  isKnowledgeContentType,
  type CheckedContentQueryable,
  type CheckedContentRow,
  type CheckedContentSource,
  type RealCheckedContentPorts,
} from './checked-content-live-ports.ts';

export {
  CheckedContentWiringError,
  createUnwiredCheckedContentSource,
  KNOWLEDGE_CONTENT_TYPES,
  type CheckedContentQueryable,
  type CheckedContentRow,
  type CheckedContentSource,
  type KnowledgeContentType,
  type RealCheckedContentPorts,
} from './checked-content-live-ports.ts';

/** 契约 `SynthesisTarget.id` 的 1..80 任意字符串；但两个真实来源的主键都是 uuid。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 回答的核对结论读取。**不按 owner 过滤**：归属交由 `tts/state.ts` 判定，端口只如实透出
 * `owner_id`（这样「他人的内容」走 `TARGET_FOREIGN_OWNER` 分支，而不是退化成「不存在」）。
 */
const ANSWER_SQL =
  'select revision, check_state, owner_id, checked_text from public.conversation_answers where id = $1::uuid limit 1';

/**
 * 知识读面的核对结论读取。`type = $2` 是**跨类型冒用**的闸门：拿一个 `scheme` 的 id
 * 当 `herbicide` 播报 ⇒ 查不到行 ⇒ 404（绝不用「同 id 的别的内容」顶替）。
 */
const KNOWLEDGE_SQL =
  'select revision, title, body from catalog_read.current_knowledge where id = $1::uuid and type = $2 limit 1';

/**
 * 回答的核对状态 ⇒ 合成域 `AuditState`。
 *
 * `conversation_answers.check_state` 只有 `passed|blocked` 两个合法取值
 * （`0013_conversations.sql:110`）；**其它取值原样返回**（未做规整），于是判定层看到的是
 * 一个非 `AuditState` 的值 ⇒ `AUDIT_STATE_UNREADABLE` ⇒ 409，而不是被悄悄翻译成 `approved`。
 */
export function auditStateFromCheckState(raw: unknown): unknown {
  if (raw === 'passed') return 'approved';
  if (raw === 'blocked') return 'rejected';
  return raw;
}

/**
 * 知识读面的核对状态：**行存在即 `approved`**。
 *
 * 依据（不是凭直觉）：`catalog_read.current_knowledge` 的 `WHERE` 子句强制
 * `visibility='published'` 且只保留每个 `knowledge_id` 的最新 revision，其来源版本必须先满足
 * `catalog_read.current_verified_sources`（`review_status='verified'`，`0002_knowledge_catalog.sql:214`）。
 * 也就是说：**未核对的知识根本不会出现在这个视图里** —— 因此「查得到」等价于「已核对且已发布」。
 * 残留口径差异如实登记：库内**没有**逐行 `AuditState` 列，`pending`/`quarantined`
 * 这两种状态在这个读面上**不可表达**（它们的表现是「查不到行」）；这正是 fail-closed 的方向。
 */
function knowledgeTextFromRow(row: unknown): unknown {
  if (typeof row !== 'object' || row === null) return undefined;
  const { title, body } = row as { title?: unknown; body?: unknown };
  if (typeof title !== 'string' || typeof body !== 'string') return undefined;
  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0 || body.trim().length === 0) return undefined;
  return `${trimmedTitle}\n${body}`;
}

/** 把驱动返回的一行收敛成端口行；无行 / 非对象 ⇒ `null`（→ 404）。 */
function firstRow(rows: unknown): unknown {
  if (!Array.isArray(rows)) return null;
  return rows.length === 0 ? null : rows[0];
}

/**
 * 真实来源：对 `public.conversation_answers` 与 `catalog_read.current_knowledge` 的只读查询。
 *
 * 只做两件事：拼最小查询、把行**原样**收敛成 `CheckedContentRow`。任何异常都转成
 * `CheckedContentUnavailableError`（不含驱动原文）。
 */
export function createSqlCheckedContentSource(pool: CheckedContentQueryable): CheckedContentSource {
  if (typeof pool !== 'object' || pool === null || typeof pool.query !== 'function') {
    throw new CheckedContentWiringError('真实已核对内容来源缺少可用的只读查询端口');
  }
  const note =
    '真实核对源（PostgreSQL 只读）：answer → public.conversation_answers；'
    + 'species/herbicide/scheme/static_region → catalog_read.current_knowledge；dose_card 当前无可核验来源';
  return {
    kind: 'wired',
    note,
    async read({ type, id }): Promise<CheckedContentRow | null> {
      if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
        // 契约允许 1..80 的任意字符串，但两个来源的主键都是 uuid ⇒ 非 uuid 不可能存在。
        // 不把这种入参送进 `$1::uuid`（那会让驱动的 22P02 抛出，被误判成「取不到核对状态」＝409）。
        return null;
      }
      try {
        if (type === 'answer') {
          const { rows } = await pool.query(ANSWER_SQL, [id]);
          const row = firstRow(rows);
          if (!isCheckedContentRow(row)) return null;
          const raw = row as { revision?: unknown; check_state?: unknown; owner_id?: unknown; checked_text?: unknown };
          return {
            revision: raw.revision,
            auditState: auditStateFromCheckState(raw.check_state),
            ownerUserId: raw.owner_id ?? null,
            text: raw.checked_text,
          };
        }
        if (isKnowledgeContentType(type)) {
          const { rows } = await pool.query(KNOWLEDGE_SQL, [id, type]);
          const row = firstRow(rows);
          if (!isCheckedContentRow(row)) return null;
          return {
            revision: (row as { revision?: unknown }).revision,
            auditState: 'approved',
            ownerUserId: null,
            text: knowledgeTextFromRow(row),
          };
        }
        // `dose_card`（无可核验来源）与契约闭集之外的取值（`tts/state.ts` 已在入口拒绝）。
        return null;
      } catch (error) {
        if (error instanceof CheckedContentUnavailableError) throw error;
        throw new CheckedContentUnavailableError('读取已核对内容失败（数据库查询异常）');
      }
    },
  };
}

/** 真实读取端口：把来源行装配成域快照，**不规整** `auditState` / `text`。 */
export function createLiveCheckedContentPort(ports: RealCheckedContentPorts): CheckedContentPort {
  const source = ports?.source;
  if (source === undefined || source === null || typeof source.read !== 'function') {
    throw new CheckedContentWiringError('真实已核对内容端口缺少来源（source）');
  }
  return {
    kind: 'wired',
    note: source.note,
    async read({ type, id }): Promise<CheckedContentSnapshot | null> {
      const row = await source.read({ type, id });
      if (row === null) return null;
      return {
        type: type as SynthesisTargetType,
        id,
        revision: row.revision as number,
        auditState: row.auditState,
        ownerUserId: (row.ownerUserId ?? null) as string | null,
        text: row.text,
      };
    },
  };
}

/**
 * 装配处唯一入口：按执行模式与**连接池是否配置**选出核对端口。
 *
 * 三个分支的取值理由见本文件头部「未配置 ⇒ 与现 main 逐字节一致」一节：
 * 非 `real` 走替身（不变）、`real` 无池走未接线（不变）、`real` 有池才走真实读取端口。
 */
export function createCheckedContentPortFromConfig(input: {
  executionMode: string;
  entries?: readonly SubstituteCheckedContentEntry[];
  pool: CheckedContentQueryable | null;
}): CheckedContentPort {
  if (input.executionMode !== 'real') {
    return createMemoryCheckedContentPort(input.entries ?? []);
  }
  if (input.pool === null || input.pool === undefined) {
    // 逐字复用未接线端口：原因文本与提示语与现 main 完全一致（不改既有可观测输出）。
    return createUnwiredCheckedContentPort();
  }
  return createLiveCheckedContentPort({ source: createSqlCheckedContentSource(input.pool) });
}
