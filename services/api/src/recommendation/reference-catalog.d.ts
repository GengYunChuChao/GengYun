/**
 * `packages/reference/catalog.mjs`（GY-I07 查询展示层，纯 ESM `.mjs`）的**只读**类型声明。
 *
 * 为什么单独声明：`services/api` 是 TypeScript（`strict` + `noUncheckedIndexedAccess`），而
 * 域库是纯 `.mjs`。做法与 `services/api/src/knowledge/reference.d.ts` 一致——就地声明其形状，
 * **只读导入**，不修改 `packages/reference/**` 的实现。
 *
 * 覆盖范围：本片只用到别名归一化 `normalizeText`（推荐排序要把查询症状/关键词按**同一套**
 * 归一化规则去对 `catalog/species.json`、`catalog/crops.json` 的别名表；自己再写一份归一化
 * 会把「·」「（）」等写法对不上，故直接复用域库）。若域库改签名，`npm run lint`
 * （`tsc --noEmit`）会失败——这正是本声明的作用：让漂移在静态检查阶段暴露。
 */

declare module '*packages/reference/catalog.mjs' {
  /** 归一化：去空白、全角转半角常见标点、`·` 归一、小写化（`catalog.mjs:19-27`）。 */
  export function normalizeText(value: unknown): string;
}
