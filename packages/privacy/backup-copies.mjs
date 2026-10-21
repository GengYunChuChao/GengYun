/**
 * GY-I19（#19）· 逐用户备份副本域的**纯逻辑**（无 IO、无时间、可重复调用逐字同值）。
 *
 * 设计见 `docs/architecture/gy-i19-user-backup-copies-design.md`：
 *   - §5  payload 最小化：只存**不透明引用**与**计数**，禁止正文/标题/身份信息/自由文本；
 *   - §7.2 清除证据 `evidenceRef` 的摘要口径（带域分隔，风格对齐 `replayKeyOf`）；
 *   - §4   行形状（`module` / `scope` / `payload_digest` / `lineage` 的取值约束）。
 *
 * 本模块只算三件事：
 *   1. `module` → `scope` 的**显式映射**（不猜、不截断、不把模块名原样当范围名）；
 *   2. payload 的**规范序列化**与 `sha256` 摘要（同一清单逐字同值 ⇒ 证据可复核）；
 *   3. 清除证据摘要（排序后拼接各副本的 `payload_digest`，与行数一一对应）。
 *
 * 放在 `packages/privacy` 是因为写路径（`services/api`）与单测都要用同一份口径；
 * 这里**不**读库、不建连接、不碰时钟，DB 形状由迁移 `0023` 的 CHECK 兜住。
 */
import { createHash } from 'node:crypto';

/**
 * 本片写入的副本行 `lineage`：写明「这行清单由**注销受理**产生」。
 *
 * 设计 §4 只要求非空白；之所以不用备份系统里的真实 lineage 名字，是因为本仓至今
 * **没有**逐用户备份系统接线（运维备份只有整库 `pg_dump`）。用一个如实标注来源的常量，
 * 好过编造一个不存在的备份链名字。
 */
export const BACKUP_COPY_LINEAGE = 'deletion-manifest/v1';

/**
 * `module` → `scope` 的显式映射（闭集）。
 *
 * 设计 §4 说 scope「语义闭集镜像 `REPLAY_SCOPES`」，但 `REPLAY_SCOPES` 里**没有** `history`
 * （见 `services/api/src/privacy/backup-replay-manifest.ts` 的闭集），而设计同段又举了
 * `favorite`、`history` 两个例子。本片按设计的**例子**取词，并把这条字面不一致记进交接：
 *   - `favorites` → `favorite`（与 `REPLAY_SCOPES` 同名）；
 *   - `history`   → `history`（`REPLAY_SCOPES` 无此项，但设计文档明确以此为例）；
 *   - `messages`  → `message`（#17 注销清理链 P0-2：消息域必须进备份副本清单，否则
 *     「注销后备份里还有消息」是对用户的假话；词形沿用 `favorite` 的单数风格）；
 *   - `conversations` → `conversation`（#12 注销清理链 G6/G8：会话域已进清理闭集却没有清单行，
 *     真实备份端口会如实回 `blocked/EVIDENCE_REQUIRED`，整个注销请求就永远到不了 completed）。
 * 未登记的模块**直接抛错**：闭集之外的范围名不许悄悄落库。
 */
export const BACKUP_COPY_SCOPES = Object.freeze({
  favorites: 'favorite',
  history: 'history',
  messages: 'message',
  conversations: 'conversation',
});

/** 与迁移 `0023` 的 CHECK 同形（DB 侧是最终闸门，这里先挡在应用层）。 */
export const BACKUP_COPY_SHAPE = /^[a-z][a-z0-9_]{0,31}$/;

/** `payload_digest` 形状：64 位小写十六进制。 */
export const BACKUP_COPY_DIGEST_SHAPE = /^[0-9a-f]{64}$/;

/** 清除证据摘要的域分隔前缀（改它等于换证据口径，必须同步改测试与文档）。 */
export const BACKUP_PURGE_EVIDENCE_VERSION = 'gengyun/backup-purge/v1';

/** 不透明引用允许的形状：id / sha256 / opaque token，不含空白，因此装不下自由文本。 */
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/** 闭集内取 `scope`；不在闭集即抛（不猜、不兜底）。 */
export function scopeForBackupModule(module) {
  if (typeof module !== 'string' || !Object.hasOwn(BACKUP_COPY_SCOPES, module)) {
    throw new RangeError(`备份副本域没有登记该模块的 scope：${String(module)}`);
  }
  return BACKUP_COPY_SCOPES[module];
}

/** 行内 `module` 形状校验（与迁移 CHECK 同口径）。 */
export function assertBackupCopyModule(module) {
  if (typeof module !== 'string' || !BACKUP_COPY_SHAPE.test(module)) {
    throw new RangeError(`备份副本模块名形状非法：${String(module)}`);
  }
  return module;
}

/** 行内 `scope` 形状校验（与迁移 CHECK 同口径）。 */
export function assertBackupCopyScope(scope) {
  if (typeof scope !== 'string' || !BACKUP_COPY_SHAPE.test(scope)) {
    throw new RangeError(`备份副本范围名形状非法：${String(scope)}`);
  }
  return scope;
}

/**
 * 校验并冻结一份「待清对象清单」。
 *
 * **空集是合法清单**（0 个对象也要写一行，见设计 §7.3：空集不能靠「没写行」冒充成功）。
 * 但 `records` 必须与 `objectRefs.length` 相等：本片写入路径的语义是「一个对象一个引用、
 * 计数即对象数」，这样清除后「证据行数 ↔ 被清对象数」才能对得上（设计 §7.2 的复核要求）。
 */
export function normalizeObjectRefs({ objectRefs, records }) {
  if (!Array.isArray(objectRefs)) {
    throw new TypeError('备份副本清单必须给出 objectRefs 数组');
  }
  if (!Number.isSafeInteger(records) || records < 0) {
    throw new RangeError('备份副本清单的 records 必须是非负安全整数');
  }
  for (const ref of objectRefs) {
    if (typeof ref !== 'string' || !OPAQUE_REF.test(ref)) {
      throw new TypeError('备份副本清单只接受不透明引用（id/摘要/token），不接受自由文本');
    }
  }
  if (objectRefs.length !== records) {
    throw new RangeError(
      `备份副本清单的 records（${records}）必须等于 objectRefs 数（${objectRefs.length}）：本片语义是一对象一引用`,
    );
  }
  return Object.freeze({ objectRefs: Object.freeze([...objectRefs]), records });
}

/**
 * payload 的**规范序列化**：键序固定为 `object_refs`、`records`，无空格。
 * 同一清单逐字同值 ⇒ `payload_digest` 可复核（设计 §7.2 的「证据可复核」）。
 */
export function copyPayloadJson({ objectRefs, records }) {
  const normalized = normalizeObjectRefs({ objectRefs, records });
  return JSON.stringify({ object_refs: normalized.objectRefs, records: normalized.records });
}

/** `payload_digest`：规范 payload 的 sha256（64 位小写十六进制）。 */
export function copyPayloadDigest(payloadJson) {
  if (typeof payloadJson !== 'string' || payloadJson.length === 0) {
    throw new TypeError('payload_digest 只能对非空规范 payload 求摘要');
  }
  return createHash('sha256').update(payloadJson, 'utf8').digest('hex');
}

/**
 * 清除证据摘要（设计 §7.2 逐字口径）：
 *
 * ```text
 * 'sha256:' + hex(sha256('gengyun/backup-purge/v1\0' + requestId + '\0' + module + '\0' + 排序后的 payload_digest 拼接))
 * ```
 *
 * - `payloadDigests` 必须非空：**没有副本行的「清除」不产生证据**（空集不是成功）；
 * - 排序取字典序的**副本**，不改写入参；
 * - 逐字拼 `\0`：摘要只对「这个请求、这个模块、这些副本」负责，换任一维度即换证据。
 */
export function purgeEvidenceRef({ requestId, module, payloadDigests }) {
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new TypeError('清除证据必须绑定非空 requestId');
  }
  assertBackupCopyModule(module);
  if (!Array.isArray(payloadDigests) || payloadDigests.length === 0) {
    throw new RangeError('清除证据必须来自至少一个副本行：空集不产生证据');
  }
  for (const digest of payloadDigests) {
    if (typeof digest !== 'string' || !BACKUP_COPY_DIGEST_SHAPE.test(digest)) {
      throw new TypeError('清除证据只接受 64 位小写十六进制 payload_digest');
    }
  }
  const sorted = [...payloadDigests].sort();
  const material = [BACKUP_PURGE_EVIDENCE_VERSION, requestId, module, ...sorted].join('\u0000');
  return `sha256:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}
