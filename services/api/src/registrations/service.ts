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
 *   2) 把 `LabelFields + Conditions` 交给上面的判定内核，并按**本域的待核维度口径**投影结论
 *      （见下节「待核维度齐备性」）；
 *   3) 按契约 `Verification` 形状返回，**用量候选恒空**（无已审用量来源 ⇒ `dose_cards` 恒 `[]`，
 *      绝不补造剂量）。
 *
 * ## 待核维度齐备性（本文件局部口径，**不改** `ocr/state.ts`）
 *
 * 契约该 operation 的承诺是「登记号+成分含量剂型精确核对，**缺失/冲突不matched**」，
 * `docs/architecture/state-contract.md` 亦写明「必须登记号+全部可见成分/含量/剂型精确一致，
 * 缺字段为 insufficient 而非 matched」。这**三个维度**分别是：
 *   - `registration_number`（登记号，业务主键）；
 *   - `ingredients`（成分 + 含量 + 单位，结构化数组）；
 *   - `dosage_form`（剂型）。
 *
 * 共享内核 `decideMatchState` 的 `NECESSARY_LABEL_FIELDS` 只含 `registration_number` / `name`，
 * 因此 `dosage_form` 缺失（`null`）或 `ingredients` 为空数组时它**不进入冲突检查**，
 * 唯一命中后会直接给 `matched` + `missing_fields: []` —— 调用方会把**未核对的维度**
 * 读成**核对完成**（监工批复 R1 指出的正是这个结果语义缺口）。
 *
 * 修法选择：**在本文件的投影处**补齐，而不是改共享内核 `ocr/state.ts`
 * （后者已被 #10 `/ocr/{id}/verify` 使用并验收；改它会连带改变 #10 的行为与负例，
 * 而监工没有要求动它）。这里的口径是可判定的三步：
 *   1) **空读归一**（`normalizeVerifiableFields`）：`dosage_form` 为 `null` / 空串 /
 *      纯空白（按 `normalizeComparableText` 归一后为空）⇒ 归一成 `null`（未采集）；
 *      `ingredients` 缺失/非数组 ⇒ `[]`。归一**只删空读**，不改任何实质内容，
 *      并保证内核不会把「没读到」错归因成「读到的剂型不一致」。
 *   2) **缺失判定**（`missingVerifiableDimensions`）：`dosage_form === null` ⇒ 缺失；
 *      `ingredients` 为空数组 ⇒ 缺失。**只判「有没有」，不判「对不对」**
 *      （对不对仍由内核的冲突检查负责）。
 *   3) **投影**（`projectVerification`）：
 *      - 缺失维度**一律并入** `missing_fields`（内核已给出的缺项一个都不删；顺序：内核在前）；
 *      - **只有当内核结论会是 `matched` 时**才因缺失改判 `insufficient`
 *        （`registration: null` / `conflict_fields: []`，与内核 `insufficient` 分支同形）；
 *      - 内核已判 `unavailable` / `insufficient` / `no_match` / `ambiguous` / `conflict` 时
 *        **保持原结论**（⛔ 不把强结论降级），缺失维度只体现在 `missing_fields` 里。
 *
 * 最终优先级（**内核顺序不变，本投影只作用于 `matched` 这一档**）：
 *   `unavailable` ＞ `insufficient`（内核必要字段缺失）＞ `no_match` ＞ `ambiguous` ＞
 *   `conflict` ＞ **`matched` 且待核维度缺失 ⇒ `insufficient`** ＞ `matched`。
 * 因此「缺待核维度」**永远不会**得到 `matched`，而「三个维度都齐备且一致」仍是 `matched`
 * （正向语义未被改动）。
 *
 * ⚠ **与 #10 `/ocr/{id}/verify` 的语义分歧（如实登记，未在本片统一）**：那一面把 `fields`
 * **原样**交给同一个 `decideMatchState`（见 `services/api/src/ocr/service.ts#verifyFields`），
 * 因此对**同一份**缺 `dosage_form` / `ingredients` 的字段，本端点给 `insufficient` +
 * `missing_fields`，而 #10 仍给 `matched` + `missing_fields: []`（实测探针：内核裸调
 * `decideMatchState` 的读数为 `matched`）。统一需要把「待核维度齐备性」下沉进共享内核
 * （并同步 #10 的负例与证据页），属另一次口径裁定；本片按监工「不改 #10 内核」的边界只收口
 * 本端点，**不声称两面已同语义**。
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
  MAX_MISSING_FIELDS,
  decideMatchState,
  gateDoseCards,
  normalizeComparableText,
  sanitizeRegistryLookup,
  type Conditions,
  type DoseCard,
  type LabelFields,
  type MatchDecision,
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
 * 契约承诺要核对的**可判定维度**（实现层清单，**不是**契约字段，也不写进 `ocr/state.ts`）。
 *
 * 与内核的 `NECESSARY_LABEL_FIELDS`（`registration_number` / `name`）**互补**：
 * 那两项是「能不能开始核对」，本清单是「核对是否**覆盖**了契约承诺的全部维度」。
 * 调整本清单属于核对口径变化 ⇒ 必须同步新增/修改负例，**不得**用它把缺项抬成 `matched`。
 */
export const VERIFY_DIMENSION_FIELDS = ['dosage_form', 'ingredients'] as const;

/** 待核维度名（与 `LabelFields` 的键名逐字一致，便于调用方直接回填表单）。 */
export type VerifyDimensionField = (typeof VERIFY_DIMENSION_FIELDS)[number];

/**
 * 「读到的东西」→「可核对的东西」的**唯一归一化口径**（空读统一成未采集）。
 *
 * - `dosage_form` 为**空串或纯空白**（按全片唯一归一化口径 `normalizeComparableText`
 *   归一后为空）⇒ 归一为 `null`。理由：空读**不是「另一种剂型」**——
 *   若原样交给内核，`conflictFields` 会因为 `'' !== '水分散粒剂'` 报 `conflict(dosage_form)`
 *   （把「没读到」错归因成「读到的剂型不一致」），同时 `missing_fields` 又说它缺失，
 *   同一字段既冲突又缺失自相矛盾。归一后内核只会跳过该维度，缺失由
 *   `missingVerifiableDimensions` 如实报出。
 *   HTTP 层 schema 的 `minLength 1` 只挡得住空串、**挡不住纯空白** ⇒ 这里必须再判一次。
 * - `ingredients` 缺失/非数组 ⇒ 归一为 `[]`（未采集）。契约 `LabelFields.ingredients` 只有
 *   `maxItems 20`、**没有 `minItems`** ⇒ 空数组本身是**合法请求**，内核的冲突检查也已对
 *   空数组跳过比较 ⇒ 与 `dosage_form` 的口径保持一致。
 *
 * 该函数**只删空读、不改任何实质内容**：非空值的用字/含量/单位/大小写一律原样透传
 * （「对不对」仍由内核的 `normalizeComparableText` + 冲突检查负责，本层不重写比对规则）。
 */
export function normalizeVerifiableFields(fields: LabelFields): LabelFields {
  const dosageForm = fields.dosage_form;
  // `null` 与「非字符串」都按未采集处理（本函数是导出面；类型外的入参按 fail-closed 收敛，不抛 500）。
  const normalizedDosageForm =
    typeof dosageForm === 'string' && normalizeComparableText(dosageForm) !== '' ? dosageForm : null;
  const normalizedIngredients = Array.isArray(fields.ingredients) ? fields.ingredients : [];
  if (normalizedDosageForm === fields.dosage_form && normalizedIngredients === fields.ingredients) return fields;
  return { ...fields, dosage_form: normalizedDosageForm, ingredients: normalizedIngredients };
}

/**
 * 待核维度**未采集**清单（只判「有没有」，**不判**「对不对」）。
 *
 * 与 `normalizeVerifiableFields` **同一口径**（先归一，再判 `null` / 空数组）——
 * 因此「缺失」的定义只有一处，不会出现两套互相打架的判据。
 *
 * 顺序固定（`dosage_form` 在前），使 `missing_fields` 的读数可逐字节复现。
 */
export function missingVerifiableDimensions(fields: LabelFields): VerifyDimensionField[] {
  const normalized = normalizeVerifiableFields(fields);
  const missing: VerifyDimensionField[] = [];
  if (normalized.dosage_form === null) missing.push('dosage_form');
  if (normalized.ingredients.length === 0) missing.push('ingredients');
  return missing;
}

/**
 * 把内核判定**投影**成契约 `Verification` 的前四键（`dose_cards` 由下发门单独产出）。
 *
 * 这是 R1 的落点，三条规则都写成可判定的形式：
 *   1. 待核维度缺失**一律并入** `missing_fields`：内核给的缺项一个都不删、不重排前置
 *      （内核在前、待核维度在后），因此「缺登记号 + 缺剂型」会得到 `['registration_number',
 *      'dosage_form']`，不会互相覆盖；
 *   2. **只有** `decision.match_state === 'matched'` 且确实有待核维度缺失时才改判
 *      `insufficient`（`registration: null` / `conflict_fields: []`，与内核 `insufficient`
 *      分支同形）—— 此时**不得**带出候选记录，否则「未核对完成」会被读成「命中了登记记录」；
 *   3. 内核已判 `unavailable` / `insufficient` / `no_match` / `ambiguous` / `conflict` 时
 *      **原样保留**（⛔ 不把强结论降级成 `insufficient`），缺失维度只反映在 `missing_fields` 里。
 *
 * `missing_fields` 仍按契约 `maxItems 20` 截断（本函数最多新增 2 项，截断只在防御极端入参时生效）。
 */
export function projectVerification(
  decision: MatchDecision,
  missingDimensions: readonly VerifyDimensionField[],
): Omit<VerificationProjection, 'dose_cards'> {
  const merged = [...decision.missing_fields];
  for (const field of missingDimensions) {
    if (!merged.includes(field)) merged.push(field);
  }
  const missingFields = merged.slice(0, MAX_MISSING_FIELDS);
  if (decision.match_state !== 'matched' || missingDimensions.length === 0) {
    return {
      match_state: decision.match_state,
      registration: decision.registration,
      conflict_fields: decision.conflict_fields,
      missing_fields: missingFields,
    };
  }
  return { match_state: 'insufficient', registration: null, conflict_fields: [], missing_fields: missingFields };
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
    // 先按本片的「空读归一」口径收敛（空串/纯空白剂型 ⇒ 未采集），再交给内核 ⇒
    // 内核不会把「没读到」错归因成「读到的剂型不一致」。
    const fields = normalizeVerifiableFields(input.fields);
    const decision = decideMatchState(fields, lookup);

    // R1 收口：契约承诺「登记号+成分含量剂型精确核对，缺失/冲突不matched」，而内核的
    // 必要字段清单只含登记号/名称 ⇒ 在这里判定「待核维度是否齐备」，再投影结论
    // （见 `missingVerifiableDimensions` / `projectVerification` 的逐条说明）。
    const projection = projectVerification(decision, missingVerifiableDimensions(fields));

    // 下发门：候选恒空 ⇒ 结果恒 `[]`；仍走 gate，使「条件齐全 + 规则有效 + 绑定登记制剂」
    // 是**下发前提**而不是被绕过的一步（gate 自身对空候选不抛错、不补造）。
    // 绑定的登记制剂取**投影后**的结论：改判 `insufficient` 时已无「命中的登记制剂」可绑。
    const gated = gateDoseCards({
      candidates: NO_DOSE_CANDIDATES,
      conditions: input.conditions,
      registration: projection.registration,
    });

    return {
      match_state: projection.match_state,
      registration: projection.registration,
      conflict_fields: projection.conflict_fields,
      missing_fields: projection.missing_fields,
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
