/**
 * GY-I04 · **登记核对路由**：契约 operationId `verifyRegistration`
 * （`POST /registrations/verify`）。本文件是**唯一注册点**（装配在 `services/api/src/app.ts`）。
 *
 * ## 契约事实（逐条取自 `packages/contracts/openapi.json` 该 operation 原文）
 *
 * - `security: [{ userSession: [] }]`、`x-scope: user` ⇒ 必须用户会话（未登录 401）；
 * - `parameters`: `Idempotency-Key`（`in: header`、`required: true`、`minLength 8`、`maxLength 128`）；
 * - `x-version-required: false` ⇒ **不需要** `If-Match`（与 `verifyOCR` 不同）；
 * - `requestBody.required: true` → `VerifyInput{ fields: LabelFields, conditions?: Conditions }`；
 * - `200` → `VerificationEnvelope{ data: Verification, meta }`；响应头声明 `Cache-Control`
 *   （「私有/授权访问 no-store」）与 `ETag`（「资源 revision 强 ETag」）。
 * - 其余状态码：400/401/403/404/409/413/415/422/428/429/503/504。
 *
 * ## 与同域既有实现的关系
 *
 * 判定语义**不在本文件**：服务层 `services/api/src/registrations/service.ts` 复用 GY-I10 已合并、
 * 已审查的 `ocr/state.ts`（`decideMatchState` / `sanitizeRegistryLookup` / `gateDoseCards`）。
 * 本文件只负责 HTTP 外壳：鉴权、`Idempotency-Key` 形状校验、请求体 schema、错误码与响应头。
 *
 * ## `Idempotency-Key`：**只做形状校验，不写台账**（照 #554 的既有写法）
 *
 * `#554`（在途取消注销）对本类「没有副作用的写形状端点」的既有做法是：头部形状（8..128）不合
 * ⇒ `400 IDEMPOTENCY_KEY_REQUIRED`，**不建 24h 幂等台账**（它的注释原文：「取消的幂等由状态机给出
 * （再取消 ⇒ 409），不写 24h 台账」）。本端点同构：
 *   - 核对本身是**纯函数**（同一 `fields` + 同一登记记录 ⇒ 同一 `Verification`），没有可重复执行的
 *     副作用，也没有「同键不同体」可冲突的状态 ⇒ 不另立台账（契约也没有要求 409/IDEMPOTENCY_CONFLICT
 *     之外的重放语义，本端点连 409 都不会由幂等产生）；
 *   - 但头部**形状**是契约 required 参数，缺/短/长一律 400，不留「不带键也能调」的口子；
 *   - 先鉴权后校验键（与 `#554` 一致：401 先于 400，开关/键状态不泄露给未鉴权方）。
 *
 * ## 为什么响应**不写** `ETag`
 *
 * 契约 200 的 `ETag` 头说明是「**资源 revision** 强 ETag」。本操作**不创建也不修改任何资源**
 * （无 ocr 行、无 revision），因此不存在可绑定的资源 revision。硬凑一个内容哈希会让调用方把它当成
 * 条件请求的校验器，而响应恒 `Cache-Control: no-store` ⇒ 该头没有任何合法用途，属自造语义。
 * 故本端点只发 `Cache-Control: no-store`；该差异已如实登记在台账 `blocker` 与 PR「未取得项」。
 *
 * ## 安全红线（本片的可判定形态）
 *
 * - **不是「请求存在即通过」**：结论只由 `decideMatchState` 产生，`matched` 需要
 *   「登记号 + 名称」两个必要条件都命中且与登记记录逐字段一致；缺项 ⇒ `insufficient`，
 *   不一致 ⇒ `conflict`，多候选 ⇒ `ambiguous`，登记库不可用 ⇒ `unavailable`。
 * - **不泄露内部标识**：响应只下发契约 `Verification` 的五个键；`registration` 由
 *   `sanitizeRegistryLookup` 逐字段重建（内部 `record_id` / `source_version` / `identity_hash`
 *   等**不可能**随行）。本文件手写响应体，不 splice 域对象。
 * - **不泄露密钥**：`Idempotency-Key` 只校验形状，**不读值、不回显、不落库**。
 * - **开关不可绕过**：装配点传入 `gatedGuards`（含「药剂输出」全局开关），关闭时在产出前拒绝，
 *   且关闭态不泄露给未鉴权方（先 `requireUser` 后判开关，见 `admin/ops/flag-gate.ts`）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import type { Conditions, LabelFields } from '../ocr/state.ts';
import {
  createRegistrationVerifyService,
  type RegistrationVerifyService,
} from '../registrations/service.ts';
import { buildMeta } from './support.ts';

/** 契约 200 头说明：授权访问 `no-store`。错误分支由 `app.ts` 的 `onSend` 统一补同一头。 */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** `Idempotency-Key` 契约边界（`minLength 8` / `maxLength 128`）。 */
const IDEMPOTENCY_KEY_MIN = 8;
const IDEMPOTENCY_KEY_MAX = 128;

/**
 * 请求体 schema：逐字段镜像契约 `VerifyInput` / `LabelFields` / `Conditions` / `Ingredient`
 * （与 `routes/ocr.ts` 的 `verifyBody` 同一形状 —— 两条 operation 消费的是**同一组** schema，
 * 因此校验口径必须一致；`additionalProperties:false` 使多余字段 400 而不是被静默剔除）。
 */
const ingredientSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'content_text', 'unit_text'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    content_text: { type: 'string', minLength: 1, maxLength: 80 },
    unit_text: { type: 'string', minLength: 1, maxLength: 80 },
  },
} as const;

const nullableLabelText = { anyOf: [{ type: 'string', minLength: 1, maxLength: 80 }, { type: 'null' }] } as const;

const labelFieldsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['registration_number', 'name', 'ingredients', 'dosage_form'],
  properties: {
    registration_number: nullableLabelText,
    name: nullableLabelText,
    ingredients: { type: 'array', maxItems: 20, items: ingredientSchema },
    dosage_form: nullableLabelText,
  },
} as const;

const conditionsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['crop_id', 'region_code'],
  properties: {
    crop_id: { type: 'string', minLength: 1, maxLength: 80 },
    region_code: { type: 'string', pattern: '^33[0-9]{4}$' },
    species_id: { type: 'string', minLength: 1, maxLength: 80 },
    growth_stage: { type: 'string', minLength: 1, maxLength: 80 },
    planting_method: { type: 'string', minLength: 1, maxLength: 80 },
    use_scene: { type: 'string', minLength: 1, maxLength: 80 },
  },
} as const;

const verifyBody = {
  type: 'object',
  additionalProperties: false,
  required: ['fields'],
  properties: { fields: labelFieldsSchema, conditions: conditionsSchema },
} as const;

/** 契约该 operation **没有** query 参数 ⇒ 任何查询串都按 400（与 `/herbicides/{id}` 同口径）。 */
const emptyQuery = { type: 'object', additionalProperties: false } as const;

/** 路由测试注入面（**产品装配不传**：`app.ts` 只给 `(app, config, guards)`）。 */
export interface RegistrationRouteDeps {
  service?: RegistrationVerifyService;
}

/**
 * `Idempotency-Key` 形状校验（契约 required，8..128）。
 *
 * 只判形状，**不读值、不回显、不落台账**（理由见文件头）；顺序与 `#554` 一致：鉴权（preHandler）
 * → 头部 400 → 未接线 503。
 */
function requireIdempotencyKeyShape(request: FastifyRequest): void {
  const raw = request.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (typeof key !== 'string' || key.length < IDEMPOTENCY_KEY_MIN || key.length > IDEMPOTENCY_KEY_MAX) {
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', '缺少有效幂等键');
  }
}

/**
 * 注册登记核对路由。
 *
 * 服务缺省由本层按 `config.executionMode` 组装 ⇒ 产品装配只需一行调用：
 * `registerRegistrationVerifyRoutes(app, config, gatedGuards);`。
 */
export function registerRegistrationVerifyRoutes(
  app: FastifyInstance,
  config: AppConfig,
  guards: AuthGuards,
  deps: RegistrationRouteDeps = {},
): RegistrationVerifyService {
  const service = deps.service ?? createRegistrationVerifyService({ executionMode: config.executionMode });

  app.post(
    `${API_PREFIX}/registrations/verify`,
    {
      preHandler: guards.requireUser,
      schema: { querystring: emptyQuery, body: verifyBody },
    },
    async (request, reply) => {
      requireIdempotencyKeyShape(request);
      const body = request.body as { fields: LabelFields; conditions?: Conditions };
      const data = await service.verify({ fields: body.fields, conditions: body.conditions ?? null });
      // 只下发契约 `Verification` 的五个键（`service` 的返回类型即该形状；此处不再增删字段）。
      return reply.headers(NO_STORE).send({ data, meta: buildMeta(request, config) });
    },
  );

  return service;
}
