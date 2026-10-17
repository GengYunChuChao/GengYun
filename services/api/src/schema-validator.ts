/**
 * 运行时 JSON Schema **2020-12** 校验器（GY-I02「OpenAPI2020-12 与 Fastify 适配实测」的落点）。
 *
 * **为什么需要它**：契约 `packages/contracts/openapi.json:2` 声明 `"openapi": "3.1.1"`，并在
 * `:8` 显式钉住方言（`"jsonSchemaDialect": "https://json-schema.org/draft/2020-12/schema"`）；
 * 而 Fastify 5 的默认校验器（`@fastify/ajv-compiler` 4.0.6 ⇒ `ajv` 的 **draft-07** 入口）
 * 不认识 2020-12 专有关键字。同一份含 `prefixItems` 的 schema 在 draft-07 下实测有两种命运：
 *   - `strict` 默认（改前 Fastify 的口径）⇒ 编译即抛 `strict mode: unknown keyword: "prefixItems"`；
 *   - `strict:false` ⇒ 编译通过但 `prefixItems` **被静默忽略**，`[1,'a']` 这类非法载荷照常放行。
 * 后者正是「schema 通过、语义丢失」——所以这里用 `ajv/dist/2020.js` 的 `Ajv2020` 自建编译器，
 * 由 `buildApp` 经 `Fastify#setValidatorCompiler` 装到**全部路由**上（不是只在测试里另起一个实例）。
 * 适配实测见 `tests/unit/openapi-2020-fastify-adapter.test.mjs`。
 *
 * **选项口径**（与改前逐项对齐，只换方言）：
 *   - `@fastify/ajv-compiler/lib/default-ajv-options.js` 的默认值：
 *     `coerceTypes:'array'`、`useDefaults:true`、`removeAdditional:true`、`addUsedSchema:false`、`allErrors:false`；
 *   - 仓内显式项：`removeAdditional:false`（`app.ts` 的 `ajv.customOptions` 同源常量
 *     `RUNTIME_AJV_CUSTOM_OPTIONS`；契约里 `additionalProperties:false` 的输入必须**拒绝**多余字段，
 *     而不是静默剔除后放行——见 `app.ts:630-633` 的原注释）；
 *   - 插件 `ajv-formats`：默认编译器也内置加载它（`validator-compiler.js` 的 `addFormatPlugin`），
 *     `format:'uuid'` / `'date-time'` 由它提供。少了它，strict 模式下 `unknown format` 会直接编译失败。
 * 刻意**未**复制 `uriResolver: fast-uri`：仓内**实际 schema 对象**里没有 `$id` / `$ref`（2026-10-17 实测：
 * `services/api/src` 全树 `$(ref|id)` 命中 8 处，**全部在注释**，无一处是 schema 键），
 * 求解器不参与任何编译，`ajv` 自带默认求解器的行为等价。
 *
 * **不受影响**：响应序列化走 Fastify 的 `serializerCompiler`（fast-json-stringify），与 Ajv 选项无关；
 * 本次只换「请求侧校验」（body / querystring / params / headers）的 schema 方言。
 */
import addFormatsPlugin from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Schema } from 'ajv/dist/2020.js';
import type { FastifySchemaCompiler } from 'fastify';

/**
 * CJS 互操作（仅类型层）：`ajv-formats` 是 CommonJS 包（`module.exports = formatsPlugin`），
 * Node ESM 把它暴露成 `default`（运行时实测 `typeof addFormats === 'function'`）；而仓内
 * `verbatimModuleSyntax: true` 且未开 `esModuleInterop` 时，tsc 会把这个 default 标注成命名空间类型。
 * 这里按运行时事实断言一次，其余调用点保持强类型。
 */
const addFormats = addFormatsPlugin as unknown as (ajv: Ajv2020) => unknown;

/** `@fastify/ajv-compiler@4.0.6` 的默认校验选项（方言由 `Ajv2020` 决定）。 */
const BASE_AJV_OPTIONS = Object.freeze({
  coerceTypes: 'array',
  useDefaults: true,
  addUsedSchema: false,
  allErrors: false,
});

/**
 * 仓内显式追加的校验选项。
 *
 * **同时**喂给 Fastify 的 `ajv.customOptions` 与 `Ajv2020`：两处引用同一份常量，避免「默认编译器」与
 * 「运行时编译器」各说各话（例如有人只改了一处，`removeAdditional` 语义就分叉）。
 */
export const RUNTIME_AJV_CUSTOM_OPTIONS = Object.freeze({ removeAdditional: false });

/**
 * 构造 Fastify 校验编译器：所有路由 schema 交给**同一个** `Ajv2020` 实例编译。
 *
 * `setValidatorCompiler` 的回调在 `ready()`（及注入）时为每个 `(路由, httpPart)` 调用一次，
 * 因此返回的校验函数就是 Fastify 实际执行的那一个。
 */
export function createJsonSchema2020ValidatorCompiler(): FastifySchemaCompiler<unknown> {
  const ajv = new Ajv2020({ ...BASE_AJV_OPTIONS, ...RUNTIME_AJV_CUSTOM_OPTIONS });
  // 与默认编译器同口径：无参数加载全部格式（args 形状、uuid 正则等逐字沿用同一份 ajv-formats）。
  addFormats(ajv);
  return ({ schema }) => ajv.compile(schema as unknown as Schema);
}
