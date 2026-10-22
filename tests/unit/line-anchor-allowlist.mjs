/**
 * 写死 `源文件:行号` 的**显式 allowlist**（R31，配合 `test-line-anchors-guard.test.mjs`）。
 *
 * 为什么需要这张表：`源文件:行号` 一旦写进断言，就多了一条「代码一改行、测试就红」的机械红 ——
 * 2026-10-22 一天里两红（`tools/verify-contract-status.mjs` 的证据区间、`sql-column-coverage`
 * 的 NC6 `profile/service.ts:61`）都是这一族。默认口径是**按源码实时定位**（见扫描器
 * `line-anchor-scan.mjs` 与本目录 `sql-column-coverage.test.mjs` 的 `siteLine/siteRef`），
 * 只有「确实定位不了、又确有判据价值」的才登记到这里，并且**每条都要写清为什么不能自动定位**。
 *
 * 收敛规则（守卫会逐条核对，别指望加一条就完事）：
 * - 每条必须有 `path`（写死行号的那个**测试文件**）、`anchor`（`源文件:行号` 或 `源文件:起-止`，
 *   路径是**真实**仓库相对路径）、`reason`（一句话：为什么不能按源码实时算）、`owner`（`GY-Ixx` 或 `R31`）。
 * - **条目必须仍然命中一处「判红位置」的硬编码**，否则守卫报 stale（白名单不许腐烂成免疫区）。
 * - `anchor` 的行号写死是刻意的：夹具/边界值一旦变了，这里必须跟着重新论证，而不是悄悄漂移。
 * - 只收「断言判据」里的锚点；失败消息、`reason:` 文案、注释里的引用**不需要**登记（它们不会因改行变红）。
 */
export const ANCHOR_ALLOWLIST = [
  {
    path: 'tests/unit/contract-status-tool.test.mjs',
    anchor: 'services/api/src/routes/ocr.ts:2-8',
    reason: '这个 2-8 是测试喂进去的**错误输入**而不是期望坐标：mutate 故意把 evidence[0].lines 写成 2-8，'
      + '断言工具能认出「这段区间覆盖的是 post /ocr 的注册块」。数字必须落在测试自造的那份 25 行 OCR_ROUTE_SOURCE 上，'
      + '真 services/api/src/routes/ocr.ts 有 353 行、同一语句在别的行，按真源码算行会算错。',
    owner: 'R31',
  },
  {
    path: 'tests/unit/contract-status-tool.test.mjs',
    anchor: 'services/api/src/routes/ocr.ts:10-16',
    reason: '同上：两条操作区间互换时被断言的错位坐标，取的是 OCR_ROUTE_SOURCE 的第 10-16 行（get /ocr/{id} 块），'
      + '不是真 ocr.ts 的行号，没有可实时定位的真源码可算。',
    owner: 'R31',
  },
  {
    path: 'tests/unit/contract-status-tool.test.mjs',
    anchor: 'services/api/src/routes/ocr.ts:1-25',
    reason: '1-25 的语义是「区间恰好等于整个夹具文件」（规则：区间 == 整文件 ⇒ 无法定位具体实现），'
      + '它是**文件长度边界值**而不是某条语句的位置，只能按夹具的 25 行手写，无法从任何符号声明算出来。',
    owner: 'R31',
  },
  {
    path: 'tests/unit/contract-status-tool.test.mjs',
    anchor: 'services/api/src/routes/ocr.ts:11-13',
    reason: '要的是「落在别人注册块内、又不覆盖本操作任何注册块」这个**部分重叠**形状，'
      + '必须手挑 3 行（夹具里没有等价的符号可定位），所以无法实时算。',
    owner: 'R31',
  },
  {
    path: 'tests/unit/contract-status-tool.test.mjs',
    anchor: 'services/api/src/routes/ocr.ts:2-16',
    reason: '跨两个注册块的边界（covered.length >= 2 分支），起点 2 与终点 16 都是「从上一操作起、到下一块末」的手挑边界，'
      + '不存在能直接算出来的单一符号。',
    owner: 'R31',
  },
  {
    path: 'tests/unit/doc-anchors-guard.test.mjs',
    anchor: 'services/api/src/app.ts:17-30',
    reason: '这是**夹具输入**而不是期望坐标：该用例要把一份「文档里写成 17-30 行」的假锚点喂给闸门，'
      + '断言闸门能认出它覆盖的是 `registerRoutes` 的归属块。真实 app.ts 有上千行，按源码实时算会算出完全不同的区间。',
    owner: 'R31',
  },
  {
    path: 'tests/unit/doc-anchors-guard.test.mjs',
    anchor: 'miniprogram/utils/session.js:9',
    reason: '同上：夹具要把一个**单行**引用喂进去，验证「单行锚点必须落在同一个归属块内」这条判据；'
      + 'session.js 第 9 行是手挑的探针位置，不是任何真实文档锚点。',
    owner: 'R31',
  },
];

/** allowlist 条目的规范化键：`测试文件::源文件:起[-止]`。 */
export function allowlistKey(entry) {
  return `${entry.path}::${entry.anchor}`;
}

/** 扫描命中的规范化键，与 {@link allowlistKey} 同形。 */
export function hitKey(file, repoPath, startLine, endLine) {
  return `${file}::${repoPath}:${startLine}${endLine === null || endLine === undefined ? '' : `-${endLine}`}`;
}
