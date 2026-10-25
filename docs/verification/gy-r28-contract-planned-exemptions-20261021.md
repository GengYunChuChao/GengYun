# R28-S73 · planned 契约操作的零证据登记（计划证据，非实现证据）

日期：2026-10-21　分支：`test/gy-r28-contract-evidence-completeness`　基点：`6d7f2af`

本页记录 R28-S73 的落盘口径与结论。**本片没有给任何 planned 操作补实现证据**，也没有改契约台账与状态；实际交付是一道守卫（新测试）+ 这份说明。

## 1. 为什么计划证据不能写进 contract-status.json

台账的校验工具对 planned 有一条**反向**不变量，`tools/verify-contract-status.mjs:303`：

```js
check(entry.status === 'planned' ? entry.evidence.length === 0 : entry.evidence.length > 0, `${owner}: 状态与证据数量不符`);
```

即 **planned ⇒ evidence 必须为空数组**。因此在 `docs/architecture/contract-status.json` 里给 `listSpecies` 等 4 条 planned 操作补任何 evidence，都会让 `node tools/verify-contract-status.mjs` 由 exit 0 变成 exit 1（实测报错：`ERROR: 形状错误 · get /catalog/species: 状态与证据数量不符`）。

由此产生一个真实缺口：台账今天的 4 条 planned 操作 evidence 全为空，**没有任何检查会因为「某条操作一条证据都没有」而变红**——planned 的零证据是合法形态，永远不会被看见。本片的守卫就是补这条缝，而不是绕过 `:127`：

- 不改 `tools/verify-contract-status.mjs`（`:127` 是硬约束，放宽它等于让 planned 与 partial 的边界失效）；
- 不改任何 `status`（把 planned 标成 partial/implemented 只为「有证据可填」属凑数，红线）；
- 不往 JSON 塞计划证据（计划依据不是实现证据，塞进去还会直接打红门禁）。

计划依据因此记在本页与测试的豁免表里，并由测试机器校验其可核性——**它们证明「有契约/需求/领域层依据」，不证明 HTTP 实现存在**。

## 2. 4 条 planned 操作的逐条计划依据

台账 `docs/architecture/contract-status.json` 中 evidence 为空的 4 条，全部 `status: planned`、`route_mounted: false`：

| 操作 | 方法与路径 | 台账定位 | 计划依据（path 与行区间） | 依据性质 |
|---|---|---|---|---|
| `listSpecies` | `GET /catalog/species` | `contract-status.json:291` | `packages/reference/service.mjs:61-71` 的 `listSpecies` | 参考层领域实现，无产品路由 |
| `getPrivacyPolicy` | `GET /me/privacy-policy` | `contract-status.json:303` | `docs/ui-contract-binding.md:85` 的界面绑定行 | 需求侧要求，无任何实现 |
| `listExports` | `GET /me/exports` | `contract-status.json:398` | `packages/privacy/egress.mjs:411-413` 的 `listExportsForUser` | 账本读面领域实现，无 HTTP 路由 |
| `verifyRegistration` | `POST /registrations/verify` | `contract-status.json:813` | `packages/reference/deterministic.mjs:357` 的 `evaluateRegistrationMatch` | 匹配内核，无路由与 handler |

逐条说明：

- **`listSpecies`**：`packages/reference/service.mjs` 里 `listSpecies` 返回契约的 `PageEnvelope` 形状，目录数据在 `packages/knowledge/catalog/species.json`；但 `services/api` 没有 `/catalog/species` 的路由注册，`tests/` 下也没有该端点的用例。**定性：计划证据（领域层有实现，HTTP 层没有）。**
- **`getPrivacyPolicy`**：无 policy 内容模块、无路由、无测试；仅有 `docs/ui-contract-binding.md:85` 的界面绑定要求（`静态文案 | GY-I27 … 界面读取待接入`）与 `docs/initial-issues.json` 里 GY-I27 的任务描述。**定性：纯计划证据（需求侧）。**
- **`listExports`**：`packages/privacy/egress.mjs` 明确写了「不注册 HTTP 路由（`/me/exports` 等 operationId 的装配属接线方）」，但有真实账本读面与真实用例 `tests/privacy/egress.test.mjs:296`（`账本读面：契约 Export 形状 + keyset 游标分页；畸形游标抛 INVALID_CURSOR`）。**定性：计划证据（领域层有实现与用例，HTTP 层没有）。**
- **`verifyRegistration`**：只有登记匹配内核 `evaluateRegistrationMatch` 与 `tests/reference/i08-scenarios-100.test.mjs` 的冲突场景用例；无 `registrations` 路由、无 handler、无端点级断言。**定性：计划证据（内核有，端点没有）。**

## 3. 守卫：`tests/unit/contract-planned-exemptions.test.mjs`

断言口径（双向，任一不满足即红，失败信息点名操作 id）：

1. evidence 为空的操作必须 `status === 'planned'` 且逐字登记在 `PLANNED_EXEMPT`（新增空证据操作未登记 ⇒ 红）；
2. `PLANNED_EXEMPT` 的每个键必须在台账中存在、仍是 planned、证据仍为空（陈旧或错位登记 ⇒ 红）；
3. 每条登记的 `plan_ref` 必须可核：`path` 真实存在、`lines` 在文件行数内、`symbol` 在引用区间 ±2 行内逐字出现；
4. evidence 非空的操作至少有一条带锚（`symbol`/`anchor`/`name` 任一），只有 `path` 的弱锚按无锚计——今天 409 条引用全部带锚，违规数为 0。

`PLANNED_EXEMPT` 条数钉死为 4。内存夹具（不落盘、只改入参）覆盖 4 个负控 + 1 个正控：新增空证据操作未登记、登记台账不存在的键、`plan_ref.symbol` 写成不存在的串、非空证据全是弱锚，均在预期断言上判红；现状 4 条登记判绿。守卫另带反向断言：解析出的 operations 必须 > 100、空证据集合必须非空，避免「扫了个空台账还很绿」。

## 4. 状态分类疑问（上报，本片不动）

`listSpecies` 与 `listExports` 有真实领域实现（其中 `listExports` 还有真实用例），只是没有挂 HTTP 路由。按仓内自己的 `partial` 定义（「有独立服务 / 参考组件，不能直接调用 HTTP 接口」），它们更接近 **partial** 而不是 planned；`verifyRegistration` 处于边界（有匹配内核、无端点）；只有 `getPrivacyPolicy` 是干净的 planned。

**本片不动 `status`**：改状态会让台账与工具的口径同时位移，属独立决策，留待另开授权。此处只登记疑问与证据位置，供后续裁决。

## 5. 未取得项

- 未给 4 条 planned 操作补任何实现证据（`tools/verify-contract-status.mjs:303` 禁止，且 3 条确实无 HTTP 实现）。
- 未改 `docs/architecture/contract-status.json` 与 `docs/architecture/contract-implementation-status.md`（本片零改动，`git status` 可证）。
- 未改 `tools/verify-contract-status.mjs`、`services/**`、`tests/integration/**`。
- 未对 4 条操作做状态重分类（见第 4 节，需另开授权）。
- 未验证真实 HTTP 调用：4 条操作均未装配路由，任何「调用成功」的断言都无从谈起。

## 6. 本片门禁读数

| 门禁 | 退出码 |
|---|---|
| `npm run lint` | 0 |
| `node tools/verify-contract-status.mjs` | 0（planned 4 / partial 95 / implemented 13，与改动前一致） |
| `node --test --test-concurrency=1 tests/unit/contract-planned-exemptions.test.mjs` | 0（6 条全绿） |
| `node --test --test-concurrency=1 tests/contract/*.test.mjs` | 0 |
| `npm run test:docs` | 0 |
| `node tools/verify-release-materials.mjs` | 0 |
| `git diff --check` | 0 |
