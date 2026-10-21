/**
 * GY-R28-W3 · TTS「已核对内容」读取端口 · 真实来源的**注入式端口**。
 *
 * 形状照抄 R28-W1 的同目录样板（`services/api/src/ai/ocr-live-ports.ts` /
 * `asr-live-ports.ts`）：真实分支需要的全部向外能力收进一个**字段全部必填**的
 * `RealCheckedContentPorts`，没有默认实现、不读 ambient env、不建连接、不发网络请求。
 * 缺任一字段即无法构造 ⇒ 应用装配路径**不可能**不经意地打开真实读取。
 *
 * 与 W1 两个样板的关键差异（必须说清，否则会被读成「同一个东西」）：
 * - W1 的 OCR/ASR 对外**发包**（腾讯云 TC3），所以端口里有凭据三元组、预算闸门、
 *   端点配置快照、`fetch`、时钟；**本端口一个都不需要**——它读的是**我们自己**的
 *   PostgreSQL（`conversation_answers` / `catalog_read.current_knowledge`），
 *   没有第三方凭据、没有按次计费、没有外发。因此这里**刻意没有** `credentials` /
 *   `liveGate` / `fetchImpl`：多写一个就在暗示「这一步在向外推理」。
 * - W1 的端口要证明「没配置就一个包都不发」；本端口要证明「没配置就一行 SQL 都不查」
 *   ⇒ 未配置时返回 `kind: 'unwired'` 的源，读取一律抛错（fail-closed）。
 *
 * ⛔ 本文件不含 SQL、不含任何连接串、不读环境变量、不写台账。
 */
import type { CheckedContentSnapshot, SynthesisTargetType } from '../tts/state.ts';

/**
 * 走 `catalog_read.current_knowledge` 读的知识类型。
 * 逐字取自 `services/api/db/migrations/0002_knowledge_catalog.sql` 的
 * `knowledge_versions.type` CHECK 闭集（4 值）——**不是** `SynthesisTarget` 的 6 值闭集：
 * `answer` 走 `conversation_answers`，`dose_card` 当前**没有**可核验来源（见 adapter 注释）。
 */
export const KNOWLEDGE_CONTENT_TYPES = ['species', 'herbicide', 'scheme', 'static_region'] as const;
export type KnowledgeContentType = (typeof KNOWLEDGE_CONTENT_TYPES)[number];

/** 该取值是否走知识读面（`catalog_read.current_knowledge`）。 */
export function isKnowledgeContentType(value: unknown): value is KnowledgeContentType {
  return typeof value === 'string' && (KNOWLEDGE_CONTENT_TYPES as readonly string[]).includes(value);
}

/**
 * 一行「已核对内容」的**库内原始形状**。
 *
 * 四个字段刻意声明为 `unknown`：适配器**不做任何规整**，把库里读到的值原样交给
 * `tts/state.ts` 的 `decideCheckedContent` 判定（未知核对状态／非文本正文由判定层
 * 逐项拒绝，端口绝不把未知值改写成 `approved`）。这与替身端口
 * `SubstituteCheckedContentEntry.auditState: unknown` 是同一口径。
 */
export interface CheckedContentRow {
  readonly revision: unknown;
  readonly auditState: unknown;
  readonly ownerUserId: unknown;
  readonly text: unknown;
}

/**
 * 「已核对内容」来源（注入式）。**只读**：拿不到就返回 `null`（→ 404 不存在／不可见），
 * 读取失败就**抛错**（→ 409 `OBJECT_UNAVAILABLE`，绝不当作 `approved`）。
 *
 * `read` 的入参只有契约里的 `(type, id)`：`revision` 与归属都**不**进查询条件——
 * 版本比对与越权判定是判定层（`tts/state.ts`）的职责，端口擅自过滤会让「版本不一致」
 * 退化成「不存在」，把可诊断的 `REVISION_CONFLICT` 变成不可诊断的 404。
 */
export interface CheckedContentSource {
  /** 来源类型：wired=接真库；unwired=未配置（fail-closed，一行 SQL 都不查）。 */
  readonly kind: 'wired' | 'unwired';
  /** 供证据文档／诊断引用的如实标注（不含正文、不含个人信息、不含连接串）。 */
  readonly note: string;
  read(input: { type: SynthesisTargetType | string; id: string }): Promise<CheckedContentRow | null>;
}

/** 真实读取分支的全部向外能力。**只有一项**，且必填 ⇒ 缺它即无法构造真实分支。 */
export interface RealCheckedContentPorts {
  /** 已核对内容的真实来源（本仓唯一实现：PostgreSQL 只读查询）。 */
  readonly source: CheckedContentSource;
}

/**
 * 本端口能接受的最小查询接口（结构性类型）。
 *
 * 只声明「一条只读查询」这一件事：真实装配注入 `services/api/src/db/pool.ts` 的 `PgPool`，
 * 离线单测注入一个可控的假对象。**不**把 `PgPool` 具体类型写进来，是为了让适配器
 * 拿不到事务、COPY、监听等能力——端口越窄，越不可能顺手写库。
 */
export interface CheckedContentQueryable {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

/** 端口／配置自身不合法（构造期 fail-closed；绝不带着坏配置去查库）。 */
export class CheckedContentWiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckedContentWiringError';
  }
}

/**
 * 未接线来源：**没有**可核验的已核对内容来源，因此一次读取都不放行。
 *
 * 抛出的是 `tts/content.ts` 的 `CheckedContentUnavailableError` 同义错误
 * （由 adapter 抛出，见 `checked-content-live-adapter.ts`）；这里只负责「不提供行」。
 */
export function createUnwiredCheckedContentSource(reason: string): CheckedContentSource {
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed：取不到核对状态即拒绝合成；不发起任何查询）`,
    async read() {
      return null;
    },
  };
}

/** 类型守卫：把 `unknown` 行收敛到 `CheckedContentRow`（只校验「是个对象」，不校验字段值）。 */
export function isCheckedContentRow(value: unknown): value is CheckedContentRow {
  return typeof value === 'object' && value !== null;
}

/** 把来源行装配成域快照（**不**规整 `auditState` / `text`）。 */
export function snapshotFromRow(input: {
  type: SynthesisTargetType;
  id: string;
  row: CheckedContentRow;
}): CheckedContentSnapshot {
  return {
    type: input.type,
    id: input.id,
    revision: input.row.revision as number,
    auditState: input.row.auditState,
    ownerUserId: (input.row.ownerUserId ?? null) as string | null,
    text: input.row.text,
  };
}
