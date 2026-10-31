/**
 * GY-I16（#16 AC4）· 「本人识别 / OCR 历史」的**当前可见性接线**（应用层适配器：
 * **无 SQL 字面量、无迁移、无 GRANT、不需要任何外部凭据**）。
 *
 * ## 缺陷（接线前）
 * 历史与收藏回读时会**逐次重算**目标的「当前可见性」（`history/service.ts` 的 `project()` →
 * `deriveVisibility(visibility, { target_ref, userId })`）。但 `app.ts` 的生产默认端口
 * `defaultVisibility` 只认收藏契约闭集 `species|herbicide|scheme`（`favorites/types.ts` 的
 * `isFavoriteTargetType`），其余目标一律回 `unavailable`；而 `recordHistoryTerminal` 往历史里写的
 * 恰恰是 `recognition` / `ocr` 两类 ⇒ 用户**自己的**识别、OCR 历史在 `GET /history` 里永远显示
 * 「对象已失效」，即使那条记录就在库里、就是他本人的。
 *
 * ## 授权（只用**既有** owner 读面，不新写 SQL）
 *   - `recognition` ⇒ `recognitionService.getRecognition({ userId, recognitionId })`
 *     （`recognitions/service.ts`：`getOwnedRecognition` 在 非 UUID／查不到／不属于该 `userId`／
 *      已软删 时一律 `ApiError('NOT_FOUND')`）；
 *   - `ocr` ⇒ `ocrService.getOcr({ userId, ocrId })`（`ocr/service.ts`：同形口径，同一 `userId` 守卫）。
 * 归属由这两条读面自己的 404 口径保证——本文件不查 owner 列，也**不**把投影里的任何字段当授权依据
 * （`RecognitionProjection` / `OcrProjection` 里本来就不含 `ownerUserId`）。
 *
 * ## 为什么是适配器、而不是把两条读面写进 `app.ts`
 * `app.ts` 是全仓文档锚点最密的文件：接线只该在那里留**装配**（谁、在哪、按什么闭合），判定规则与
 * 三态留在本文件，便于单测直接驱动——与同目录族 `history/cascade-wiring.ts` 同一手法
 * （结构类型 + 闭包 + 请求期解析）。也因此不 import `recognitions/**` 与 `ocr/**` 的服务类型，
 * 避免把两个域的类型绑死在历史可见性这条线上。
 *
 * ## 三态判定（fail-closed，不得放宽）
 * - `'available'`：读面**成功**返回了这条记录，且返回的 `id` 与 `target_ref.id` **一致**
 *   （＝「本人的、仍然存在的这条记录」）；
 * - `'unavailable'`：读面抛错（他人的记录／不存在／非 UUID／已软删／存储故障全折在这一档）、
 *   返回空、返回的 `id` 对不上、或服务在请求期还没装饰上 ⇒ 一律**不可用**。
 *   ⛔ 「读不到」**绝不**等于「可用」：本文件没有任何把异常翻成 `'available'` 的分支；
 * - `'delegate'`：目标型别不是 `recognition`／`ocr` ⇒ **原样交回**既有逻辑
 *   （`species|herbicide|scheme` 仍走 `/knowledge` 公开读面、其余型别仍 `unavailable`），
 *   本片**不改变**这些型别的行为（回归由 `tests/unit/target-visibility-wiring.test.mjs` 逐条对照）。
 *
 * ## 边界（如实，不得据此扩写）
 * - **只接 `recognition` / `ocr` 两型**。`media`、`dose_card`、`conversation`、`conversation_turn`、
 *   `synthesis`、`job`、`source`、`post`、`comment`、`answer`、`transcription`、`static_region`
 *   等其余 15 型**仍恒 `unavailable`**：它们没有对应的 owner 读面（或公开读面），本片不造一个。
 * - **不核验 `revision` 是否与历史行一致**：识别/OCR 记录是**可变**的（选种、订正都会升 revision），
 *   历史行冻结的是当时的 revision，版本变新不代表目标失效。这与 `/knowledge` 那种「不可变发布版本、
 *   type/revision 逐项一致才可用」的判据**故意不同**（照搬会把用户改过一次的记录判成失效）。
 * - 不判「任务是否已终态／是否成功」：历史行自己带 `job_state`，可用性只回答「目标还在不在」。
 * - 不缓存、不落库、不写 `reference_state`（历史投影每次读都逐次派生）。
 */
import type { ReferenceState, TargetRef } from './types.ts';

/**
 * 本片能判「当前可见性」的两种目标型别（`TARGET_REF_TYPES` 的子集）。
 * ⛔ 不新增闭集成员：`targetref/types.ts` 与契约一个字都不动。
 */
export const OWNED_VISIBILITY_TARGET_TYPES = Object.freeze(['recognition', 'ocr'] as const);
export type OwnedVisibilityTargetType = (typeof OWNED_VISIBILITY_TARGET_TYPES)[number];

/** `'delegate'`＝「不归本文件管，原样交回既有逻辑」（**不是**契约里的 `ReferenceState`）。 */
export const TARGET_VISIBILITY_DELEGATE = 'delegate';

/** 三态判定：`'available'` / `'unavailable'` / `'delegate'`。 */
export type TargetVisibilityVerdict = ReferenceState | typeof TARGET_VISIBILITY_DELEGATE;

/**
 * 结构化声明的 owner 读面：只声明本文件用到的那**一个**方法，且入参形状取自
 * `recognitions/service.ts:592` 与 `ocr/service.ts:681` 的既有签名。
 * 返回类型放宽成 `{ id: string } | null`：读面对「他人的／不存在的」是**抛 404**，正常只会返回记录；
 * 若实现（含替身）返回空，本文件仍判不可用。
 */
export interface OwnedRecognitionReadFace {
  getRecognition(input: { userId: string; recognitionId: string }): Promise<{ id: string } | null>;
}
export interface OwnedOcrReadFace {
  getOcr(input: { userId: string; ocrId: string }): Promise<{ id: string } | null>;
}

/**
 * 服务来源：**闭包**，请求期才解析。
 * 装配期 `app.recognitionService` 要到 `app.ts` 的 `decorate` 之后才存在，`app.ocrService` 更要等
 * `registerOcrRoutes` 注册时才装饰 ⇒ 直接传实例会在装配顺序上打结（与 `history/cascade-wiring.ts`
 * 的 `HistoryCascadeServices` 同形同理由）。
 */
export interface OwnedVisibilityServices {
  recognitionService(): OwnedRecognitionReadFace;
  ocrService(): OwnedOcrReadFace;
}

/** 成品：`resolve(targetRef, userId)` ⇒ 三态判定。 */
export interface TargetVisibilityWiring {
  resolve(targetRef: TargetRef, userId: string): Promise<TargetVisibilityVerdict>;
}

/** 型别判定（闭集判定，与 `targetref/types.ts` 的 `isTargetRefType` 同一写法）。 */
export function isOwnedVisibilityTargetType(value: unknown): value is OwnedVisibilityTargetType {
  return value === 'recognition' || value === 'ocr';
}

/**
 * 读成功后的形状判定：**必须是这一条记录**。
 * 读面对「别人的 / 不存在的」是抛错而不是返回空；这里再兜一层「返回了空 / 返回了非对象 /
 * 返回了别的 id」⇒ 仍判不可用，避免替身或未来实现把"读了个空"读成"可用"。
 */
function readableRecordId(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * 工厂：把 `recognition` / `ocr` 两型接到既有 owner 读面，其余型别 `'delegate'`。
 *
 * ⛔ 本函数**绝不向上抛**：`resolve` 的任何失败都折叠成 `'unavailable'`
 * （`app.ts` 那条端口本身也会把异常折成「读取失败 ⇒ 不可用」，这里先一步折在语义更准的档位上）。
 */
export function createTargetVisibilityWiring(services: OwnedVisibilityServices): TargetVisibilityWiring {
  /** 按型别分派到对应读面；抛错由 `resolve` 统一折叠。 */
  async function readOwnedId(type: OwnedVisibilityTargetType, targetRef: TargetRef, userId: string): Promise<string | null> {
    // 请求期才解析服务（见 `OwnedVisibilityServices` 的注释）：装饰还没发生 ⇒ 这里会抛 ⇒ 折叠成不可用。
    const face = type === 'recognition' ? services.recognitionService() : services.ocrService();
    if (face === null || typeof face !== 'object') return null;
    if (type === 'recognition') {
      const projection = await (face as OwnedRecognitionReadFace).getRecognition({ userId, recognitionId: targetRef.id });
      return readableRecordId(projection);
    }
    const projection = await (face as OwnedOcrReadFace).getOcr({ userId, ocrId: targetRef.id });
    return readableRecordId(projection);
  }

  return {
    async resolve(targetRef, userId) {
      // 不归本片管的型别原样交回：`species|herbicide|scheme` 与其余 15 型的行为**一点都不变**。
      if (!isOwnedVisibilityTargetType(targetRef.type)) return TARGET_VISIBILITY_DELEGATE;
      let ownedId: string | null;
      try {
        ownedId = await readOwnedId(targetRef.type, targetRef, userId);
      } catch {
        // 他人的记录 / 不存在 / 非 UUID / 已软删 / 存储故障：owner 读面只会抛错，这一档一律不可用。
        // ⛔ 不得改成 'available'：把"读不到"当"可用"等于向用户谎称目标仍然有效。
        return 'unavailable';
      }
      // 读面返回了记录，但**不是这一条**（替身/未来实现返回空或别的 id）⇒ 仍不可用。
      return ownedId === targetRef.id ? 'available' : 'unavailable';
    },
  };
}
