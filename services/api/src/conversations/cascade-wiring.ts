/**
 * GY-I12（#12 AC②）· 会话/轮次级联删除的**语音转写清理接线**（应用层适配器：
 * **无 SQL 字面量、无迁移、无表结构变更**）。
 *
 * 授权来源：契约 `deleteTurn` 的描述「级联音频/结果/外发处理但不删他人媒体」。
 * 本片只接**一条**腿：该轮次引用的那条语音转写（`transcription_ref`）；外发腿
 * **如实 `unsupported`**（见文件末尾的边界说明），因此成功路径的披露仍为 `unwired`。
 *
 * ## 为什么是适配器、而不是直接 import 语音域
 * `conversations/cascade.ts` 的端口语义**已冻结**（`createWiredTurnCascadePort`：
 * cleaner 抛错 ⇒ 整体 `failed`；报 `unsupported` ⇒ `unwired`；全部 `cleaned` ⇒ `initiated`），
 * 且它**不认识任何具体域**。本文件只做一件事：把「一条已被删除的轮次所引用的转写」
 * 交给语音域**已合并**的删除口（`speech/service.ts` 的 `getTranscription` /
 * `deleteTranscription`）。因此：
 *   - 不 import 语音域实现、不改 `speech/**`（避免与在飞片撞文件）；
 *   - 语音域用**结构类型**声明（下面 `TurnSpeechCleanupPort`），不把两个域的类型绑死；
 *   - 本文件可被单测直接驱动，无需起 app、无需真库。
 *
 * ## 三条硬边界
 * 1. **不拿快照当 If-Match**：`transcription_ref.revision` 是**受理时**的快照，随时可能过期
 *    （用户核对/删除都会 +1）⇒ 删除前一律**重读当前 revision**；直接拿快照删会把本可成功的
 *    一次清除判成 409。
 * 2. **绝不向上抛**：读/删的任何异常都折叠成 `failed`（并回调 `onError`）。理由：轮次行
 *    **已经删掉了**（`conversations/service.ts` 先 `store.deleteTurn`），级联失败不得把删除
 *    改写成失败，只如实披露（响应头 `X-GY-Cascade`）。
 * 3. **「读不到」只有一种解读**：`NOT_FOUND` = 不存在／他人／已软删（越权与不存在同形），
 *    此时目标已不在、无可级联 ⇒ `cleaned`；**其余任何错误一律 `failed`**，⛔ 不猜、不吞、
 *    不把「读失败」当作「已清理」。
 *
 * ## 幂等（确定性，不含时间戳/随机数）
 * `turn-cascade:<userId>:<turnId>:<revision>`：同一 `(userId, turnId, revision)` 恒得同一键，
 * `revision` 前进则键随之变化。语音域按 `(scope=DELETE /speech/transcriptions/{id}, key)`
 * 去重，`requestHash` 含 if-match ⇒ **同键不同 revision 会撞 `IDEMPOTENCY_CONFLICT`**，
 * 这正是本文件坚持「键随 revision 变」而不是「键固定」的原因。
 */
import { ApiError } from '../errors.ts';
import {
  createWiredTurnCascadePort,
  type TurnCascadePort,
  type TurnCascadeRequest,
  type TurnCleanerResult,
} from './cascade.ts';

/**
 * 装配层从**这一个**模块拿「端口类型 + 成品工厂」（故在此转出端口类型）。
 * 理由与 `history/cascade-wiring.ts` 同：`app.ts` 只需交一个语音端口与一个日志回调，
 * 不必同时知道端口工厂在哪个文件；这样那条接线仍是「一行 import、一行装配」。
 */
export type { TurnCascadePort } from './cascade.ts';

/**
 * 语音域只需要这两件事（都是**已合并的公开口**，形状取自 `speech/service.ts`）。
 * 用结构类型声明而不 import `SpeechService`：单测传记录型替身也能对上。
 *
 * ⚠️ 装配层必须交**请求期解析**的闭包（`getTranscription: (input) => app.speechService.…`），
 * ⛔ 不得捕获 `app.speechService` 实例：语音路由在 `app.ts` 里注册得**更晚**
 * （`registerSpeechRoutes` 在 `app.ts:2459`，装饰发生在那一刻），本端口的装配行在它之前
 * → 捕获实例只会拿到 `undefined`。这与同块 `createTranscriptionPort`（`app.ts:2343` 也是闭包）
 * 同一手法；同文件 `history/cascade-wiring.ts` 亦如此（"不捕获服务实例，不受装配顺序影响"）。
 */
export interface TurnSpeechCleanupPort {
  getTranscription(input: { userId: string; transcriptionId: string }): Promise<{ revision: number }>;
  deleteTranscription(input: {
    userId: string;
    transcriptionId: string;
    ifMatch: string;
    idempotencyKey: string;
  }): Promise<{ accepted: true }>;
}

/** 级联清理在语音域里使用的幂等键前缀（确定性，见文件头）。 */
export const TURN_CASCADE_IDEMPOTENCY_PREFIX = 'turn-cascade:';

/**
 * 由**服务端**三元组派生的确定性幂等键：`turn-cascade:<userId>:<turnId>:<revision>`。
 *
 * ⚠️ `revision` 必须参与派生：语音域的 `requestHash` 含 if-match，同键不同 If-Match 会被判
 * `IDEMPOTENCY_CONFLICT` —— 冲突重试若复用旧键，重试**必然**失败。
 */
export function turnCascadeIdempotencyKey(input: {
  userId: string;
  turnId: string;
  revision: number;
}): string {
  return `${TURN_CASCADE_IDEMPOTENCY_PREFIX}${input.userId}:${input.turnId}:${input.revision}`;
}

/** 转写腿：目标类型不是 `transcription` 时如实披露（不猜该删哪张表）。 */
export const TURN_SPEECH_UNKNOWN_TARGET_NOTE =
  '轮次引用的目标类型不是 transcription（未知目标类型，按未接线如实披露）：本端口不猜该删哪张表';

/**
 * 外发腿的固定文案（**恒 `unsupported`**，不是失败、也不是成功）：
 * 账本 append-only（`services/api/db/roles/egress_ledger.sql` 刻意不给 DELETE），运行库里
 * 也没有按轮次的内容副本 ⇒ 本轮次没有「可清理的外发副本」这件事**能在这里做完**。
 */
export const TURN_EGRESS_CASCADE_NOTE =
  '外发账本按主体清空（append-only 授权），本轮次无本地内容副本；跨域回执属 GY-I19';

/** 已接线端口的自述（只描述本片真的做了什么，不暗示跨域完成）。 */
export const TURN_CASCADE_WIRED_NOTE =
  '语音转写清理已接线（按轮次 transcription_ref 重读当前 revision 后软删该转写）；'
  + '外发腿仍 unsupported（账本 append-only，跨域回执属 GY-I19）⇒ 成功路径披露仍为 unwired';

/**
 * 从错误里取契约错误码。
 *
 * 先认 `ApiError`（本仓唯一的业务错误类型），再**兜底**读一个字符串型 `code` 字段：
 * 装配层可能传入包了一层装饰器的语音服务（同一契约封套、不同类实例），此时 `instanceof`
 * 会落空；只认字符串 `code`，⛔ 不按 `message` 猜错误码。
 */
function errorCodeOf(error: unknown): string | null {
  if (error instanceof ApiError) return error.code;
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return null;
}

/** 单次「读当前 revision」的结果：三态，绝不把「读失败」混进「读到了」。 */
type RevisionRead =
  | { readonly kind: 'revision'; readonly revision: number }
  | { readonly kind: 'gone' }
  | { readonly kind: 'error'; readonly error: unknown };

async function readCurrentRevision(
  speech: TurnSpeechCleanupPort,
  userId: string,
  transcriptionId: string,
): Promise<RevisionRead> {
  try {
    const row = await speech.getTranscription({ userId, transcriptionId });
    return { kind: 'revision', revision: row.revision };
  } catch (error) {
    if (errorCodeOf(error) === 'NOT_FOUND') return { kind: 'gone' };
    return { kind: 'error', error };
  }
}

/**
 * 把一次「清理失败」如实折成 `failed`：先回调 `onError`（观测），再返回结果。
 * `onError` 自身抛错**不得**改写处置（观测失败 ≠ 清理成功）：吞掉异常，仍判 `failed`。
 */
function failedLeg(
  error: unknown,
  transcriptionId: string,
  onError: (error: unknown, detail: { transcriptionId: string }) => void,
): TurnCleanerResult {
  try {
    onError(error, { transcriptionId });
  } catch {
    // 观测口抛错不能把「清理失败」改写成别的处置，也不能向外抛。
  }
  const code = errorCodeOf(error) ?? 'unknown';
  return { state: 'failed', note: `本轮语音转写未能清理（${code}）：已如实披露 failed，不回滚已完成的轮次删除` };
}

/**
 * 转写 cleaner：清掉该轮次引用的那条转写（软删 `deleted=true` + `revision+1`）。
 *
 * 顺序：`null` ⇒ `cleaned`（本轮无音频）→ 类型不符 ⇒ `unsupported` → 重读 revision →
 * 按 `If-Match` 软删 → 冲突时**重读后重试恰好一次**。永不向上抛。
 */
async function cleanTranscription(
  speech: TurnSpeechCleanupPort,
  request: TurnCascadeRequest,
  onError: (error: unknown, detail: { transcriptionId: string }) => void,
): Promise<TurnCleanerResult> {
  const ref = request.transcriptionRef;
  // 纯文字轮次：没有音频可级联，本条腿什么都不用做（不是"未接线"）。
  if (ref === null) return { state: 'cleaned' };
  if (ref.type !== 'transcription') return { state: 'unsupported', note: TURN_SPEECH_UNKNOWN_TARGET_NOTE };

  const transcriptionId = ref.id;
  const first = await readCurrentRevision(speech, request.userId, transcriptionId);
  if (first.kind === 'gone') return { state: 'cleaned' };
  if (first.kind === 'error') return failedLeg(first.error, transcriptionId, onError);

  let revision = first.revision;
  let lastConflict: unknown = null;
  // 至多两次删除：首次 + 「冲突后重读再试一次」（派单只允许重试一次）。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await speech.deleteTranscription({
        userId: request.userId,
        transcriptionId,
        ifMatch: `"${revision}"`,
        idempotencyKey: turnCascadeIdempotencyKey({
          userId: request.userId,
          turnId: request.turnId,
          revision,
        }),
      });
      return { state: 'cleaned' };
    } catch (error) {
      const code = errorCodeOf(error);
      // 删的时候已经没了（含并发软删）：目标不在 ⇒ 与"已清理"同结果。
      if (code === 'NOT_FOUND') return { state: 'cleaned' };
      // 非冲突错误：不重试、不猜，如实失败。
      if (code !== 'REVISION_CONFLICT') return failedLeg(error, transcriptionId, onError);
      lastConflict = error;
    }
    // 只有 REVISION_CONFLICT 能走到这里：重读当前 revision 后再试（⛔ 绝不拿快照重试）。
    const again = await readCurrentRevision(speech, request.userId, transcriptionId);
    if (again.kind === 'gone') return { state: 'cleaned' };
    if (again.kind === 'error') return failedLeg(again.error, transcriptionId, onError);
    revision = again.revision;
  }
  // 两次都是 REVISION_CONFLICT：有人在并发改这条转写，放弃并如实披露（绝不谎称已清理）。
  return failedLeg(lastConflict, transcriptionId, onError);
}

/**
 * 外发 cleaner：**恒 `unsupported`**。不是偷懒，是这一腿在本片**根本不可做**：
 * 外发账本 append-only（授权组里刻意没有 DELETE），运行库也没有按轮次的内容副本；
 * 让本端口返回 `cleaned` 就等于谎报「供应商副本已删」。
 */
async function cleanEgress(): Promise<TurnCleanerResult> {
  return { state: 'unsupported', note: TURN_EGRESS_CASCADE_NOTE };
}

/**
 * 装配一个**已接线**的轮次级联端口（`app.ts` 的唯一生产调用点）。
 *
 * 两个 cleaner 顺序固定：**转写在前、外发在后**（先清真的可清的东西，再如实披露不可清的）。
 * 端口级的 `failed` 由 `createWiredTurnCascadePort` 折叠，本文件不回滚任何已完成的删除。
 */
export function createConversationCascadePort(options: {
  speech: TurnSpeechCleanupPort;
  onError?: (error: unknown, detail: { transcriptionId: string }) => void;
}): TurnCascadePort {
  const onError = options.onError ?? (() => {});
  return createWiredTurnCascadePort({
    note: TURN_CASCADE_WIRED_NOTE,
    cleaners: [
      (request) => cleanTranscription(options.speech, request, onError),
      () => cleanEgress(),
    ],
  });
}
