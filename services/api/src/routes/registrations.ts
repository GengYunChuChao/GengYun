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
 * - 其余状态码：400/401/403/404/409/413/415/422/429/503/504（无 428：本 operation 不要求前置条件头）。
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
 *
 * ## `minLength: 1` 在本运行时**不生效**：为什么必须用 `preValidation` 挡空串
 *
 * 运行时校验器（`services/api/src/schema-validator.ts`）沿用 `@fastify/ajv-compiler` 的默认
 * `coerceTypes: 'array'`。该选项会在校验前**改写请求体**：
 *   - `''` 被强转成 `null` ⇒ 契约 `anyOf: [{type:'string',minLength:1}, {type:'null'}]` 的第二支
 *     直接命中，`minLength: 1` **永不执行**（实测：`dosage_form: ''` 校验后成为 `null`）；
 *   - 标量被强转成字符串/单元素数组 ⇒ `dosage_form: 42` ⇒ `'42'`、`dosage_form: ['水分散粒剂']`
 *     ⇒ `'水分散粒剂'`，都能通过字符串分支；
 *   - 布尔同理（`name: true` ⇒ `'true'`）。
 *
 * `minLength` 只对**留得住字符串**的 schema 有效（例：`Ingredient` 三键没有 `null` 分支，
 * 因此 `name: ''` 仍是 `''` 并被 `minLength` 拒绝，实测 400）；凡是「可空」的字段都会被这条
 * 强制规则绕过。同一根因在 `routes/media.ts:93-96` 已被记录（那里用联合 `type` 绕开
 * `anyOf` 的 `null` 分支）。
 *
 * 修法边界（**最小、且不改全局 Ajv 配置**）：本路由在 **`preValidation`**（Fastify 的
 * `onRequest → preParsing → preValidation → 校验 → preHandler` 次序中位于 Ajv **之前**，
 * 实测该钩子里 `request.body.dosage_form === ''` 仍是原值）对**原始值**做形状校验：
 *   - `registration_number` / `name` / `dosage_form`：**必须是 `string` 或 `null`**（允许 `null`，
 *     它代表「未采集」）；字符串**不得为 `''`**（`minLength: 1` 的语义）；
 *   - `ingredients`：缺失 / 空数组都放行（未采集 ≠ 非法，`minLength` 由元素承担）；`null` 不是
 *     合法值（契约是 required `array`，由 schema 给 400）；**每个元素必须是对象**，其三键必须是
 *     **非空字符串**；
 *   - 违反 ⇒ `400 INVALID_REQUEST`（与 schema 校验失败**同一个**既有错误码与 `details` 形状，
 *     ⛔ 不新造错误码）。
 *
 * **纯空白字符串（`'   '`）不在本层拒绝**：契约只要求 `minLength: 1`，`'   '` 长度合法 ⇒ 拒绝它
 * 等于拒收契约合法请求；它按「空读」由服务层 `normalizeVerifiableFields` 归一为 `null` 并
 * 判 `insufficient`（见 `registrations/service.ts`，用例 J1）。
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

/**
 * 契约里 `LabelFields` 三键是 `anyOf: [string(1..80), null]`，逐字照抄。
 *
 * ⚠ 这份 schema 的 `minLength: 1` 在**当前运行时**挡不住 `''`（`coerceTypes` 会先把它转成 `null`），
 * 「类型不是字符串」「空串」两条由 `requireRawFieldShapes` 在 `preValidation` 里补齐（见文件头）。
 */
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
 * 契约 `LabelFields` 的三个**可空文本**维度（键名与契约逐字一致）。
 *
 * 它们共用 `nullableLabelText`，因而共用同一个 `coerceTypes` 缺口（见文件头）：形状必须在
 * `preValidation` 里按**原始值**判一次。
 */
const NULLABLE_LABEL_KEYS = ['registration_number', 'name', 'dosage_form'] as const;

/** 契约 `Ingredient` 的三键（逐键 `minLength 1` / `maxLength 80`）。 */
const INGREDIENT_TEXT_KEYS = ['name', 'content_text', 'unit_text'] as const;

/**
 * **原始值形状校验**：在 Ajv 归一化**之前**（`preValidation` 钩子）拒绝空串与非字符串。
 *
 * 存在的理由只有一个：`coerceTypes: 'array'` 会把 `''` 转成 `null`、把数字/布尔/单元素数组转成
 * 字符串，使契约 `minLength: 1` 与「必须为字符串」全线失效（文件头有逐条实测读数）。
 * 这里判的是 **schema 判不到的那部分**，不重复 schema 已有的校验：
 *   - 键**缺失**不在这里报（`required` 由 schema 给 400，避免同一错误出两种口径）；
 *   - 字符串**长度上限**（`maxLength 80`）、数组 `maxItems 20`、多余键、`conditions` 全部交给 schema；
 *   - 这里只补三件 schema 在当前运行时会漏掉的事：**类型不是字符串/`null`**、**空串**、
 *     **`ingredients` 元素内三键的类型/空串**。
 *
 * 纯空白字符串**刻意放行**（契约 `minLength 1` 允许）：它按「空读」由服务层归一为未采集并判
 * `insufficient`，不是非法输入（见文件头与用例 J1）。
 *
 * 错误码与 `details` 形状对齐 `app.ts` 的 schema 失败分支（`INVALID_REQUEST` + `{field, code}`），
 * 使调用方无论被哪一层拒绝都读到同一个封套形状；`field` 取 Ajv 风格的实例路径。
 *
 * ⚠ **必须返回 Promise（`async`）**：Fastify 的钩子运行器（`fastify/lib/hooks.js` 的
 * `hookRunnerGenerator`）只在「钩子返回 thenable」或「三参钩子调用 `done`」时才继续；一个
 * 同步返回 `undefined` 的单参钩子会让请求**永久挂住**（实测：`app.inject` 永不 settle）。
 * 本函数不 `await` 任何东西，`async` 在这里是**协议要求**而不是风格。
 */
async function requireRawFieldShapes(request: FastifyRequest): Promise<void> {
  const body: unknown = request.body;
  // 顶层不是对象 / 没有 `fields` / `fields` 不是对象 ⇒ 交给 schema（否则会与它的报错口径打架）。
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;
  const fields: unknown = (body as { fields?: unknown }).fields;
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return;
  const record = fields as Record<string, unknown>;

  const details: Array<{ field: string; code: string }> = [];
  for (const key of NULLABLE_LABEL_KEYS) {
    const value = record[key];
    if (value === undefined || value === null) continue; // 缺失 ⇒ schema；`null` ⇒ 契约允许（未采集）
    if (typeof value !== 'string') {
      details.push({ field: `/fields/${key}`, code: '必须是字符串或 null' });
    } else if (value.length === 0) {
      details.push({ field: `/fields/${key}`, code: '必须是长度不少于 1 的字符串（不得为空串）' });
    }
  }

  const ingredients = record.ingredients;
  // 缺失 / 空数组 = 未采集（契约无 `minItems`）⇒ 本层放行；缺失与 `null` 由 schema 判 400，
  // 非数组（字符串/数字/单对象）实测也被 schema 拒（400）⇒ 本层不重复报错。
  if (Array.isArray(ingredients)) {
    ingredients.forEach((item: unknown, index: number) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        details.push({ field: `/fields/ingredients/${index}`, code: '成分项必须是对象' });
        return;
      }
      const entry = item as Record<string, unknown>;
      for (const key of INGREDIENT_TEXT_KEYS) {
        const value = entry[key];
        if (value === undefined) continue; // 缺键 ⇒ schema 的 `required`
        if (typeof value !== 'string') {
          details.push({ field: `/fields/ingredients/${index}/${key}`, code: '必须是字符串' });
        } else if (value.length === 0) {
          details.push({ field: `/fields/ingredients/${index}/${key}`, code: '必须是长度不少于 1 的字符串（不得为空串）' });
        }
      }
    });
  }
  // 非数组（含字符串/数字/单对象）由 schema 拒绝；此处不重复报错。

  if (details.length > 0) {
    throw new ApiError('INVALID_REQUEST', '请求校验失败', { details: details.slice(0, 30) });
  }
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
      // **必须早于 schema 校验**：Ajv 的 `coerceTypes: 'array'` 会把 `''` 转成 `null`、
      // 把数字/布尔转成字符串，`minLength: 1` 因此在可空字段上失效；`preValidation` 是唯一
      // 还能看到原始值的钩子（`onRequest` 时请求体尚未解析）。理由与实测见文件头与
      // `requireRawFieldShapes`。
      preValidation: requireRawFieldShapes,
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
