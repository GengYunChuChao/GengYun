/**
 * GY-I04 · **登记核对**（契约 `POST /registrations/verify`，operationId `verifyRegistration`）
 * 的服务层：把「标签上读到的字段」与「已收集的登记记录」做**精确**核对，
 * 产出契约 `Verification`（`match_state` / `registration` / `conflict_fields` /
 * `missing_fields` / `dose_cards`）。
 *
 * ## 语义认定依据（**不新造语义**）
 *
 * 契约原文（`packages/contracts/openapi.json` 的该 operation description）：
 * 「登记号+成分含量剂型精确核对，缺失/冲突不matched；具体卡片须conditions齐全和规则有效。」
 * 请求体是 `VerifyInput{ fields: LabelFields, conditions?: Conditions }`，响应是
 * `VerificationEnvelope{ data: Verification, meta }` —— 与 GY-I10 标签 OCR 的核对面
 * **同一组 schema**。因此本层的判定**完全复用**已合并、已审查的判定内核
 * `services/api/src/ocr/state.ts`：
 *   - `decideMatchState(fields, lookup)`：`missing_fields` / `conflict_fields` / `ambiguous` /
 *     `unavailable` 的硬规则与判定顺序都写在那里（含「必要条件（登记号/名称）未采集 ⇒
 *     `insufficient`，绝不 matched」）；
 *   - `sanitizeRegistryLookup(raw)`：登记库返回物按**不可信载荷**逐字段收敛，任一候选
 *     不可解析 ⇒ 整体 `unavailable`（**不丢坏候选保留好候选**，否则 `ambiguous` 会静默退化成
 *     `matched`）；
 *   - `gateDoseCards(...)`：用量卡下发门（条件齐全 + 规则有效 + 绑定本次命中的登记制剂）。
 *
 * 本文件**不新增**任何契约字段，也**不另立**一套匹配规则 —— 只做三件事：
 *   1) 组装「登记库端口」（真实记录 / 未接线两种形态，见 `createRegistrationRegistryPort`）；
 *   2) 把 `LabelFields + Conditions` 交给上面的判定内核；
 *   3) 按契约 `Verification` 形状返回，**用量候选恒空**（无已审用量来源 ⇒ `dose_cards` 恒 `[]`，
 *      绝不补造剂量）。
 *
 * ## fail-closed 口径
 *
 * - `real` 执行模式：真实登记库**未接线** ⇒ 端口恒 `unavailable`（`match_state: 'unavailable'`）。
 *   **绝不**把它伪装成 `no_match`（「查不到」会把「不可用」说成业务结论），也**绝不**回退到
 *   `<user>` 仓库内的公开公告记录去冒充权威登记库。
 * - 非 `real`（`stub` / `preset_demo`）：使用仓库内已收集的**真实**登记公告记录
 *   （`packages/knowledge/herbicides/records-2026.json`，20 条）做核对；这些记录
 *   `review_status = 'unverified'`，响应里**如实**带出该值（不提升为「已核对」）。
 * - 装载本身抛错（文件缺失/不可解析）⇒ `503 PROVIDER_UNAVAILABLE`（既有错误码）；
 *   装载成功但投影不合契约 ⇒ 端口退化为 `unavailable`（仍然**不放行**）。
 * - 模拟记录（`SIM-` 前缀 / `source_kind = simulation`）与**下架/删除/私有**记录
 *   **不进入核对面**：前者不得作为真实依据，后者与读面同口径（下架即不可查，返回 `no_match`，
 *   不确认其细节）。
 */
import {
  decideMatchState,
  gateDoseCards,
  normalizeComparableText,
  sanitizeRegistryLookup,
  type Conditions,
  type DoseCard,
  type LabelFields,
  type MatchState,
  type RegistryHerbicide,
  type RegistryLookup,
} from '../ocr/state.ts';
import { ApiError } from '../errors.ts';
import { loadHerbicideRecords, type ReferenceHerbicideItem } from '../../../../packages/reference/index.mjs';

/**
 * 契约 `Verification` 的投影（`additionalProperties:false`：只允许这五个键）。
 *
 * `registration` 是契约 `Herbicide`（由 `sanitizeRegistryLookup` 逐字段重建，未校验字段
 * **不可能**随行下发）；不可匹配时为 `null`。
 */
export interface VerificationProjection {
  match_state: MatchState;
  registration: RegistryHerbicide | null;
  conflict_fields: string[];
  missing_fields: string[];
  dose_cards: DoseCard[];
}

/** 登记库端口：`kind` 明确区分「仓内记录」与「未接线」，避免「不可用」被静默当成「查不到」。 */
export interface RegistrationRegistryPort {
  readonly kind: 'records' | 'unwired';
  readonly note: string;
  lookup(input: { registrationNumber: string | null; name: string | null }): Promise<RegistryLookup>;
}

/** 真实登记库未接线时的统一说明（出现在 `unavailable` 判定里，可被证据页逐字引用）。 */
export const UNWIRED_REGISTRY_REASON = '真实登记库尚未接线，无法核对登记资料';

/**
 * 本域**没有任何已审用量来源** ⇒ 候选恒空 ⇒ 契约 `dose_cards` 恒 `[]`。
 *
 * 这不是「暂时没数据」，而是口径：用量原文必须绑定「登记制剂 + 齐全条件 + 已核对有效来源」，
 * 三者在本域当前都不成立，故一律不产出卡片（见 `ocr/state.ts` 的 `gateDoseCards` 说明）。
 */
const NO_DOSE_CANDIDATES: readonly never[] = Object.freeze([]);

/** 未接线端口：一律 `unavailable`，**不伪装**成 `no_match`，也不回退替身/仓内记录。 */
export function createUnwiredRegistryPort(reason: string = UNWIRED_REGISTRY_REASON): RegistrationRegistryPort {
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed：一律 unavailable，不伪装成 no_match 或 matched）`,
    async lookup() {
      return { status: 'unavailable', reason };
    },
  };
}

/** 把一份候选压进索引（同一键多值：同登记号/同名多记录**不合并**）。 */
function pushInto(index: Map<string, RegistryHerbicide[]>, key: string, value: RegistryHerbicide): void {
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [value]);
  else bucket.push(value);
}

/**
 * 仓内登记记录端口（非 `real` 模式）。
 *
 * 候选口径（逐条可复核）：
 *   - `simulated` 记录**排除**（模拟数据不得作为真实登记依据）；
 *   - `visibility !== 'published'`（隐藏/删除/私有）**排除**（与读面同口径：下架即不可查）；
 *   - 其余记录按 `sanitizeRegistryLookup` **逐字段校验并重建**，任一不合契约 ⇒ 整体退化为
 *     `unwired`（`unavailable`）—— 宁可整体不可用，也不让坏数据混进「命中」。
 *
 * 检索键为**契约可判定的两个身份维度**：
 *   - `formulation.registration_number`（业务主键，精确）；
 *   - 记录的 `registered_name`（契约 `Herbicide` **没有**产品名字段 —— 这是已登记的契约缺口，
 *     名称只作为**登记号未命中时**的候选收敛入口，绝不用于「模糊药名合并」）。
 * 归一化口径取 `ocr/state.ts#normalizeComparableText`（与 `decideMatchState` 内部比对**同一套**），
 * 不另写第二份。
 */
export function createRecordsRegistryPort(items: readonly ReferenceHerbicideItem[]): RegistrationRegistryPort {
  const eligible = items.filter((item) => item.simulated !== true && item.visibility === 'published');
  const sanitized = sanitizeRegistryLookup({
    status: 'available',
    candidates: eligible.map((item) => item.contract),
  });
  if (sanitized.status !== 'available') {
    // 记录投影不合契约 ⇒ 整个端口不可用（不保留「好候选」：那会让 ambiguous 静默退化成 matched）。
    return createUnwiredRegistryPort(`仓内登记记录投影不合契约：${sanitized.reason}`);
  }

  const byRegistration = new Map<string, RegistryHerbicide[]>();
  const byName = new Map<string, RegistryHerbicide[]>();
  eligible.forEach((item, index) => {
    const herbicide = sanitized.candidates[index];
    // 顺序由 `sanitizeRegistryLookup` 保证（逐条重建、不丢项）；这里仍显式收窄类型。
    if (herbicide === undefined) return;
    const registration = normalizeComparableText(herbicide.formulation.registration_number);
    if (registration !== '') pushInto(byRegistration, registration, herbicide);
    const name = normalizeComparableText(item.registered_name);
    if (name !== '') pushInto(byName, name, herbicide);
  });

  return {
    kind: 'records',
    note:
      `仓内公开登记公告记录（${eligible.length} 条，均已过契约前提门禁；` +
      'review_status 如实为 unverified，不作为已核对权威来源）',
    async lookup({ registrationNumber, name }) {
      const registration = typeof registrationNumber === 'string' ? normalizeComparableText(registrationNumber) : '';
      if (registration !== '') {
        const hits = byRegistration.get(registration);
        // 登记号命中即以它为准，**不再**用名称扩大候选（否则精确命中会被稀释成 ambiguous）。
        if (hits !== undefined && hits.length > 0) return { status: 'available', candidates: hits.slice() };
      }
      const normalizedName = typeof name === 'string' ? normalizeComparableText(name) : '';
      const byNameHits = normalizedName === '' ? undefined : byName.get(normalizedName);
      // 候选已在构造期逐字段校验过；这里只做只读切片，不再重算判定。
      return { status: 'available', candidates: byNameHits === undefined ? [] : byNameHits.slice() };
    },
  };
}

/**
 * 按执行模式选端口。
 *
 * `real` ⇒ **未接线**（真实登记库尚无落点，见 `UNWIRED_REGISTRY_REASON`）；
 * 其余模式 ⇒ 仓内真实公告记录。
 * 装载抛错（文件缺失/不可解析）**不在此吞掉**：由 `createRegistrationVerifyService` 转成
 * `503 PROVIDER_UNAVAILABLE`，而不是返回一个空的「没有资料」。
 */
export function createRegistrationRegistryPort(
  executionMode: string,
  loadRecords: () => readonly ReferenceHerbicideItem[] = () => loadHerbicideRecords().items,
): RegistrationRegistryPort {
  if (executionMode === 'real') return createUnwiredRegistryPort();
  return createRecordsRegistryPort(loadRecords());
}

/** 核对服务的对外形状（供路由与测试消费，不暴露内部索引）。 */
export interface RegistrationVerifyService {
  verify(input: { fields: LabelFields; conditions: Conditions | null }): Promise<VerificationProjection>;
  /** 如实回报当前端口形态（`records` / `unwired`）与说明，供证据页与测试核对。 */
  describe(): { registry: 'records' | 'unwired'; note: string };
}

/**
 * 创建登记核对服务。
 *
 * @param options.executionMode 装配层给出的执行模式（`real` ⇒ 未接线端口）
 * @param options.registry 端口覆盖项（**仅测试注入**；生产装配只给 `executionMode`）
 */
export function createRegistrationVerifyService(options: {
  executionMode: string;
  registry?: RegistrationRegistryPort;
  /** 记录装载覆盖项（**仅测试注入**：用于证明「装载失败 ⇒ 503」而不是静默空集）。 */
  loadRecords?: () => readonly ReferenceHerbicideItem[];
}): RegistrationVerifyService {
  // 端口按需构造：数据文件损坏时，请求得到 503（既有错误码），而不是进程启动即崩。
  let port: RegistrationRegistryPort | null = options.registry ?? null;
  function registry(): RegistrationRegistryPort {
    if (port !== null) return port;
    try {
      port = createRegistrationRegistryPort(options.executionMode, options.loadRecords ?? (() => loadHerbicideRecords().items));
    } catch (error) {
      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        `登记核对资料装载失败：${String((error as Error).message ?? error)}`,
      );
    }
    return port;
  }

  async function verify(input: {
    fields: LabelFields;
    conditions: Conditions | null;
  }): Promise<VerificationProjection> {
    const current = registry();
    let lookup: RegistryLookup;
    try {
      lookup = await current.lookup({
        registrationNumber: input.fields.registration_number,
        name: input.fields.name,
      });
    } catch {
      // 端口抛错等同不可用：**不得**降级成 no_match（否则「登记库坏了」会被读成「没这个药」）。
      lookup = { status: 'unavailable', reason: '登记库查询异常' };
    }

    // 判定内核（与 GY-I10 同一份）：缺失/冲突/歧义/不可用一律非 matched。
    const decision = decideMatchState(input.fields, lookup);

    // 下发门：候选恒空 ⇒ 结果恒 `[]`；仍走 gate，使「条件齐全 + 规则有效 + 绑定登记制剂」
    // 是**下发前提**而不是被绕过的一步（gate 自身对空候选不抛错、不补造）。
    const gated = gateDoseCards({
      candidates: NO_DOSE_CANDIDATES,
      conditions: input.conditions,
      registration: decision.registration,
    });

    return {
      match_state: decision.match_state,
      registration: decision.registration,
      conflict_fields: decision.conflict_fields,
      missing_fields: decision.missing_fields,
      dose_cards: gated.dose_cards,
    };
  }

  return {
    verify,
    describe() {
      const current = registry();
      return { registry: current.kind, note: current.note };
    },
  };
}
