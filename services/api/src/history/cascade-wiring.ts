/**
 * GY-I16（#16）· 历史删除的**关联删除接线**（应用层适配器：**无 SQL 字面量、无迁移、无表结构变更**）。
 *
 * 授权来源：`.pg17/ruling-r33-i16-history-cascade-partial-20261023.md`
 * （契约 `deleteHistory` 描述「同时启动关联识别/OCR私有结果/媒体和外发删除」；裁定允许本片
 *  只接 `recognitions` 与 `ocr` **两类**，并新增披露值 `'partial'`）。
 *
 * ## 为什么是适配器、而不是直接 import 那两个域
 * 历史域只声明「按 kind 把一条关联对象删掉」这一件事的形状（下面两个 `*CascadeTarget`），
 * 真正调用由**装配层**用闭包注入（`app.ts` 的 `historyCascadePort`，请求期才解析
 * `app.recognitionService` / `app.ocrService`）。这样：
 *   - 不 import 他人实现、不改 `recognitions/**` 与 `ocr/**`（避免与其它在飞片撞文件）；
 *   - 不依赖装配顺序（与 `app.ts` 既有的历史任务状态端口 `createWiredHistoryJobPort` 同一手法）；
 *   - 本文件可被单测直接驱动，无需起 app。
 *
 * ## 三态判定（严格按裁定，不得放宽）
 * - 关联对象**真的被删成功**（先读当前 revision 再按 `If-Match` 软删成功）⇒ `'partial'`
 *   —— 因为「媒体与外发删除」这两条腿**不在本片**，永远不可能"全部删成功"，所以成功只能是 `partial`；
 * - 一项都没删成功 ⇒ `'failed'`。含：读不到（404／他人／已删）、版本冲突（409）、
 *   幂等键冲突、任何异常。⛔ 「一项都没删成功」**不得**被记成 `partial`；
 * - 端口未接线 ⇒ 由 `createUnwiredHistoryCascadePort()` 返回 `'unwired'`，本文件**不参与**
 *   （⛔ 不得把 `unwired` 改写成 `partial`）。
 *
 * ## 边界（如实）
 * - **只启动，不声称完成**：成功也只代表"该域接受了这次软删"；
 * - 不触碰历史行本身（服务层已先 `store.deleteHistory`；本适配器失败**不回滚**历史行）；
 * - 不删媒体对象、不撤外发（跨 `#6`/`#19`，见裁定第 2 条）；
 * - 幂等键 `cascade:<historyId>` 是**确定性**的（不含时间戳/随机数）：同一条历史的重复投递
 *   在目标域按 `(scope=DELETE /<域>/{id}, key)` 去重，不会产生第二次副作用。
 */
import {
  assertCascadeRequest,
  createWiredHistoryCascadePort,
  type CascadeOutcome,
  type CascadeRequest,
  type HistoryCascadePort,
} from './cascade.ts';

/**
 * 装配层从**这一个**模块拿「端口类型 + 成品工厂」（故在此转出端口类型）。
 * 理由：`app.ts` 只需要交两个闭包，不该同时知道端口工厂在哪个文件；
 * 这样 `app.ts` 的这条接线仍是一行 import、一行装配。
 */
export type { HistoryCascadePort } from './cascade.ts';

/**
 * 识别域只需这两件事（都是**已合并的公开口**，形状取自 `recognitions/service.ts`）。
 * 用结构类型声明而不 import 其服务类型，避免本条接线把两个域的类型绑死。
 */
export interface RecognitionCascadeTarget {
  getRecognition(input: { userId: string; recognitionId: string }): Promise<{ id: string; revision: number }>;
  deleteRecognition(input: {
    userId: string;
    recognitionId: string;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<unknown>;
}

/** OCR 域同形（`ocr/service.ts` 的公开口）。 */
export interface OcrCascadeTarget {
  getOcr(input: { userId: string; ocrId: string }): Promise<{ id: string; revision: number }>;
  deleteOcr(input: {
    userId: string;
    ocrId: string;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<unknown>;
}

/**
 * 装配层注入的两个**闭包**（不是服务实例）：请求期才解析，避免装配顺序耦合。
 * 装配顺序漂移（装饰还没发生）会抛错 ⇒ 被本适配器折叠成 `'failed'`，**不**伪造成功。
 */
export interface HistoryCascadeServices {
  recognitionService(): RecognitionCascadeTarget;
  ocrService(): OcrCascadeTarget;
}

/** 级联删除在目标域里使用的幂等键前缀（确定性，见文件头）。 */
export const CASCADE_IDEMPOTENCY_PREFIX = 'cascade:';

/** 由**服务端**历史行 id 派生的确定性幂等键（不含时间戳/随机数）。 */
export function cascadeIdempotencyKey(historyId: string): string {
  return `${CASCADE_IDEMPOTENCY_PREFIX}${historyId}`;
}

/** 单条腿的处置结果：只有 `'deleted'` 才算"该项关联已删"。 */
export type CascadeLegOutcome = 'deleted' | 'failed';

/**
 * 把一条历史行的关联对象交给对应域的**已合并**删除口。
 *
 * 关键点：历史行里存的 `target_ref.revision` 是**历史校验时**的快照，可能已过期
 * （目标域 revision 已前进）⇒ 必须先 `get*` 取**当前** revision 再用 `If-Match` 删；
 * 直接拿快照当 `If-Match` 会把本可以成功的一次删除判成 409。
 */
async function deleteAssociation(
  services: HistoryCascadeServices,
  request: CascadeRequest,
): Promise<CascadeLegOutcome> {
  // `kind` 是闭集 2 项，且历史行只由识别/OCR 两个域的内部创建口写入 ⇒ type 必然等于 kind。
  // 万一不等（数据被旁路改写），**无法**确定该删哪张表的哪一行 ⇒ 如实判失败，绝不猜。
  if (request.target_ref.type !== request.kind) return 'failed';
  const targetId = request.target_ref.id;
  if (typeof targetId !== 'string' || targetId === '') return 'failed';
  const idempotencyKey = cascadeIdempotencyKey(request.historyId);

  if (request.kind === 'recognition') {
    const service = services.recognitionService();
    const current = await service.getRecognition({ userId: request.userId, recognitionId: targetId });
    await service.deleteRecognition({
      userId: request.userId,
      recognitionId: targetId,
      ifMatch: `"${current.revision}"`,
      idempotencyKey,
    });
    return 'deleted';
  }

  const service = services.ocrService();
  const current = await service.getOcr({ userId: request.userId, ocrId: targetId });
  await service.deleteOcr({
    userId: request.userId,
    ocrId: targetId,
    ifMatch: `"${current.revision}"`,
    idempotencyKey,
  });
  return 'deleted';
}

/**
 * 生成 `createWiredHistoryCascadePort({ initiate })` 需要的 `initiate` 实现。
 *
 * **绝不向上抛**（服务层另有兜底，但本函数自身也必须无抛错：`history/service.ts` 的
 * `initiateCascade` 依赖这一点保证历史行已删事实不被级联失败改写）。
 */
export function createHistoryCascadeFromServices(
  services: HistoryCascadeServices,
): (request: CascadeRequest) => Promise<CascadeOutcome> {
  return async function initiate(request: CascadeRequest): Promise<CascadeOutcome> {
    try {
      assertCascadeRequest(request);
      const leg = await deleteAssociation(services, request);
      // 只有"真的删掉了那条关联对象"才是 `partial`；其余一律 `failed`（一项都没删成功）。
      return leg === 'deleted' ? 'partial' : 'failed';
    } catch {
      return 'failed';
    }
  };
}

/** 装配层用的默认文案（如实：接了两类，媒体/外发仍未接 ⇒ 成功只到 `partial`）。 */
export const HISTORY_CASCADE_WIRED_NOTE =
  '关联识别/OCR 记录删除已接线（按历史行 kind 调 recognitionService.deleteRecognition / '
  + 'ocrService.deleteOcr：先读当前 revision 再按 If-Match 软删；确定性幂等键 cascade:<historyId>）'
  + '⇒ 成功披露 partial（至少一项已删、未全部删成功）；媒体对象与外发撤销仍跨线未接（#6/#19）';

/**
 * 装配层**一行接线**用的成品端口：`createWiredHistoryCascadePort` ＋ 上面那个分派实现。
 *
 * 之所以由本模块（而不是 `app.ts`）组合：装配层只需要把两个**闭包**交进来，
 * 不必知道"用哪个端口工厂、文案怎么写"；端口语义与它的默认接线保持在同一处。
 *
 * `app.ts` 的调用点（唯一一处生产装配）：
 * ```
 * const historyCascadePort: HistoryCascadePort =
 *   historyInjection?.cascade ?? createHistoryCascadePort({
 *     recognitionService: () => app.recognitionService,   // 闭包：请求期才解析
 *     ocrService: () => app.ocrService,
 *   });
 * ```
 * 与同块 `historyJobPort`（`createWiredHistoryJobPort`）、`recordHistoryTerminal` 同一手法：
 * **不捕获服务实例**，因此不受装配顺序影响；装饰尚未发生时会抛错，被折叠成 `failed`（不伪造成功）。
 */
export function createHistoryCascadePort(
  services: HistoryCascadeServices,
  note: string = HISTORY_CASCADE_WIRED_NOTE,
): HistoryCascadePort {
  return createWiredHistoryCascadePort({ note, initiate: createHistoryCascadeFromServices(services) });
}
