# GY-I02 OpenAPI 2020-12 与 Fastify 适配实测（2026-10-17）

本页只回答一个问题：契约声明的 JSON Schema **2020-12** 方言，运行时是否**真的**在被执行。只增证据、只换校验器；契约文件与既有用例断言零改动。

## 0 范围与基线

| 项 | 读数 |
| --- | --- |
| 工作树／分支 | `E:\GengYunCommander\GengYun_W02oa` / `feat/gy-i02-openapi-2020-fastify` |
| 签发基线 | `6c2200087ae5f8841a04505cb1c226284cee7f1b`（`upstream/main`；开工前 `git fetch upstream --prune` 后实读，本片期间未再前进） |
| 运行环境 | node v24.16.0 / npm 11.13.0 / Windows；本机时间 2026-10-17 17:54 +08:00 |
| 相关包（实读版本） | `fastify` 5.12.5、`@fastify/ajv-compiler` 4.0.6、`ajv` 8.20.0、`ajv-formats` 3.0.1 |
| 契约方言 | `packages/contracts/openapi.json:2` `"openapi": "3.1.1"`；`:8` `"jsonSchemaDialect": "https://json-schema.org/draft/2020-12/schema"` |
| 安装方式 | `npm ci`（本工作树内单独安装；未建任何 `node_modules` 目录联接） |

`ajv`／`ajv-formats` 在仓内是**传递依赖**（`fastify` → `@fastify/ajv-compiler` 带入；`services/api/package.json` 的 dependencies 只有 `fastify`、`pg`）。本片据此复用同一份包，**未新增任何依赖**。

## 1 改前 / 改后

### 改前（`upstream/main` 基线）

`services/api/src/app.ts` 的 `buildApp` 只覆盖了 `removeAdditional`，方言走 Fastify 默认的 `@fastify/ajv-compiler`：

```ts
    ajv: { customOptions: { removeAdditional: false } },
```

默认校验选项逐字取自 `node_modules/@fastify/ajv-compiler/lib/default-ajv-options.js`，即 `ajv` 的 **draft-07** 入口：

```js
module.exports = Object.freeze({
  coerceTypes: 'array',
  useDefaults: true,
  removeAdditional: true,
  uriResolver: fastUri,
  addUsedSchema: false,
  allErrors: false
})
```

⇒ 改前运行时校验器 = `ajv`（draft-07）实例；仓内把 `removeAdditional` 覆写为 `false`。

### 改后

新增 `services/api/src/schema-validator.ts`；`buildApp` 在**任何路由注册之前**把编译器装到实例上（`services/api/src/app.ts:698`，函数 `buildApp`，本片新增行）：

```ts
  app.setValidatorCompiler(createJsonSchema2020ValidatorCompiler());
```

编译器本体（`services/api/src/schema-validator.ts:63`，本片新增文件）：

```ts
export function createJsonSchema2020ValidatorCompiler(): FastifySchemaCompiler<unknown> {
  const ajv = new Ajv2020({ ...BASE_AJV_OPTIONS, ...RUNTIME_AJV_CUSTOM_OPTIONS });
  addFormats(ajv);
  return ({ schema }) => ajv.compile(schema as unknown as Schema);
}
```

- `Ajv2020` 来自 `ajv/dist/2020.js`（`services/api/src/schema-validator.ts:29`）。
- `BASE_AJV_OPTIONS` = `{ coerceTypes:'array', useDefaults:true, addUsedSchema:false, allErrors:false }`，逐项对齐上面的默认值。
- `RUNTIME_AJV_CUSTOM_OPTIONS` = `{ removeAdditional:false }`（`services/api/src/schema-validator.ts:55`），**同一个常量**也喂给 `Fastify({ ajv: { customOptions } })`（`services/api/src/app.ts:689`）⇒ 两处引用同源，不可能分叉。
- `ajv-formats` 与默认编译器一样无参数加载（`format:'uuid'` 等由它提供；缺了它在 strict 下会 `unknown format` 直接编译失败）。
- **未**复制 `uriResolver: fast-uri`：实际 schema 对象里没有 `$id`/`$ref`（实测见 §5 末行），求解器不参与任何编译。

⇒ 改后运行时校验器 = `Ajv2020`（2020-12）实例，其余选项逐项同前。响应序列化走 Fastify 的 `serializerCompiler`（fast-json-stringify），不在本次范围。

## 2 对照读数（逐字，2026-10-17 实跑）

同一份含 `prefixItems` 的 schema（`type:'array'`、`prefixItems:[{type:'string'},{type:'integer'}]`、`minItems:2`、`maxItems:2`）、同一份非法载荷 `{ label:'x', pair:['a','b'] }`（第二槽非整数）：

```
A draft07_strict_compile THROWS: "strict mode: unknown keyword: \"prefixItems\""
B draft07_strictfalse_verdict(INVALID_PAIR) = true
C ajv2020_strictfalse_verdict(INVALID_PAIR) = false
D draft07_tuple_compile: OK (accepted)
E ajv2020_tuple_compile THROWS: "schema is invalid: data/properties/pair/items must be object,boolean"
```

对**真实装配**（`buildApp` + `app.inject`，探针路由 `POST /api/v1/__schema-2020-probe`）的读数：

```
F app_valid status= 200 body= {"received":{"label":"x","pair":["a",1]}}
G app_invalid status= 400 body= {"error":{"code":"INVALID_REQUEST","message":"请求校验失败","retryable":false,"details":[{"field":"/pair/1","code":"must be integer"}]},…}
H app_extra_field status= 400 body= {"error":{"code":"INVALID_REQUEST","message":"请求校验失败","retryable":false,"details":[{"field":"/","code":"must NOT have additional properties"}]},…}
I app_bad_uuid status= 400 body= {"error":{"code":"INVALID_REQUEST","message":"请求校验失败","retryable":false,"details":[{"field":"/id","code":"must match format \"uuid\""}]},…}
```

（G/H/I 的 `meta` 段每次请求都带新的 `request_id`，此处以 `…` 省略；`error` 段逐字保留。）

判读：

- **B vs C 是核心对照**：同一 schema、同一非法载荷，draft-07 判**合法**（`prefixItems` 被静默忽略），2020-12 判**非法** ⇒ 换方言产生了可观测的语义差异，而不是「换了实例但行为一样」。
- **A**：改前口径（strict 默认）连编译都过不了——这正是 §4 反向控制里走 `buildApp` 的用例整批红的原因。
- **D vs E** 是反方向对照：draft-07 的 `items` 数组元组写法在 2020-12 下**编译失败** ⇒ 不是「两边都接受」这种无效切换。
- **F/G** 证明差异发生在真实 Fastify 装配上（400 且字段路径 `/pair/1` 指到具体元组槽位），不是测试里另起的 Ajv 实例。

## 3 测试落点

新增 `tests/unit/openapi-2020-fastify-adapter.test.mjs`，6 个用例：1 个正/反例走真实装配、2 个 draft-07 对照（strict 编译失败 / strict:false 静默忽略）、1 个反方向对照（`items` 元组在改后被拒）、2 个保持性断言（`removeAdditional:false` 拒绝多余字段、`format:'uuid'` 仍在校验）。

```
$ node --test tests/unit/openapi-2020-fastify-adapter.test.mjs
ℹ tests 6
ℹ pass 6
ℹ fail 0
[node exit: 0]
```

## 4 反向控制（实跑）

临时删掉 `services/api/src/app.ts` 里 `app.setValidatorCompiler(...)` 这一行（其余不动），同一命令：

```
✖ 2020-12 语义在真实装配上被执行：prefixItems 正例放行、反例 400 INVALID_REQUEST
✔ 对照①：同一 schema 交给改前口径 draft-07（strict 默认）编译即失败（不是运行期才拦）
✔ 对照②：draft-07 关掉 strict 后编译通过，但 prefixItems 被静默忽略、同一反例被判合法
✖ 反方向对照：draft-07 合法写法（items 数组元组）在改后的真实 app 上编译即失败
✖ removeAdditional:false 保持：多余字段被 400 拒绝，而不是被静默剔除后放行
✖ ajv-formats 随编译器存活：format:"uuid" 仍在被校验（换方言没有把它弄丢）
ℹ tests 6 / pass 2 / fail 4
Error [FastifyError]: Failed building the validation schema for POST: /api/v1/__schema-2020-probe, due to error strict mode: unknown keyword: "prefixItems"
    code: 'FST_ERR_SCH_VALIDATION_BUILD'
[node exit: 1]
```

对照①② 仍绿是**预期**：它们用文件内自建的 draft-07／`Ajv2020` 实例、不经过 app；四个走 `buildApp` 的用例全红 ⇒ 本片绿色确实由 `setValidatorCompiler` 决定，而不是被别的路径顺带满足。

恢复该行后 `services/api/src/app.ts` 的 SHA256 与删除前逐字节相同（`456FF2AC38F2DC75B4F6AB9472BF7CEA0560E4F03BE52599BCBFC5FF42219B33`），重跑 6/6 绿、exit 0。

## 5 受影响路由面与契约零改动

| 项 | 读数 |
| --- | --- |
| 路由注册点 | 109 处 `app.<method>(`，分布在 20 个源文件（`Select-String 'app\.(get\|post\|put\|patch\|delete\|head\|options)\('` 结构性计数） |
| 编译方言 | **全部**路由的请求 schema 都经这台 `Ajv2020` 编译（`setValidatorCompiler` 在实例级生效，`ready()` 时逐路由编译） |
| 现有路由语义 | 等价：差额只出现在 2020-12 专有关键字（`prefixItems`、`$dynamicRef`、`unevaluatedProperties`、`dependentSchemas`…），仓内 schema 一个都没用 |
| 契约文件差异 | `git diff --stat -- packages/contracts` 输出为空（零改动；只读不写） |
| 契约回归 | `tests/reference/contract.test.mjs` 31/31 绿；`node tools/verify-contract-status.mjs` → `PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；中文表格一致` |
| 全量单测 | `npm run test:unit` 全绿（读数见交接文件的六项门禁） |
| `$id`/`$ref` 实测 | `services/api/src` 全树 `$(ref\|id)` 命中 8 处，**全部在注释**（`services/api/src/app.ts:642`、`admin/fields.ts:30/46/145`、`admin/ops/fields.ts:24/27`、`jobs/result-shape.ts:70`、`schema-validator.ts:22`），无一处是 schema 键 |

## 6 未取得项（如实列出）

| 项 | 状态 | 原因与复核入口 |
| --- | --- | --- |
| 其它 2020-12 关键字逐条实测 | 未取得 | 本片只对 `prefixItems`（正向）与 `items` 元组（反向）实测；`unevaluatedProperties`／`dependentSchemas`／`$dynamicRef` 未逐条跑。复核：在同一探针上加 schema 即可，`Ajv2020` 是 ajv 官方 2020-12 入口 |
| `$ref`／远程 `$id` 解析（`uriResolver` 差异） | 未取得 | 仓内 schema 无引用，故「不复制 `fast-uri` 是否等价」只有静态判读，没有用例覆盖；一旦出现第一处 `$ref` 需重测 |
| 响应序列化方言 | 未取得 | 走 `serializerCompiler`（fast-json-stringify），不支持 2020-12 关键字；本片不涉及，也不声称已覆盖 |
| 原生库（真实 PostgreSQL）迁移负例 | 未取得 | 属 GY-I02 验收表同行的另一项，需数据库；本片不冒称（`docs/architecture/acceptance-map.md:32`） |
| 契约 `jsonSchemaDialect` 对下游工具链的影响 | 未取得 | 未接入外部 OpenAPI 校验器／代码生成器；本片只证明运行时校验器，不证明生态工具一致 |
| 微信开发者工具／真机 | 不适用本片 | 纯服务端校验器切换，不涉及客户端；真机通道属其它片 |
