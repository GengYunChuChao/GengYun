# 契约台账 evidence 语义门禁：解析器调研与复用决策（2026-10-18）

范围：`tools/verify-contract-status.mjs` 需要判断「证据区间/片段是否指向本操作」，本记录说明为何不引入 JavaScript 解析器而自研轻量扫描。

## 检索

- 检索日期：2026-10-18（本机 `Get-Date` 实测，UTC+08:00）。
- 检索词（原文）：`javascript parser ast assert call argument range zero dependency`、`acorn parser license`、`es-module-lexer license`；另以 registry 元数据实查版本与发布时间：`npm view <pkg> version license time dist.unpackedSize --json`。
- 检索方式：网页检索用于确认候选，版本/日期/许可证以 npm registry 实测为准；`acorn` 的 `latest` 文档经 `https://registry.npmjs.org/acorn/latest` 直接抓取（返回 `version 8.19.0`、`license MIT`、`engines.node >=0.4.0`、`dist.unpackedSize 568532`）。

## 来源（均已实际打开/实查）

| 来源 | 版本 | 许可证 | 最近发布（实测时间戳） |
| --- | --- | --- | --- |
| <https://registry.npmjs.org/acorn/latest> · <https://www.npmjs.com/package/acorn> | 8.19.0 | MIT | 2026-10-05 |
| <https://www.npmjs.com/package/@babel/parser> | 8.0.7 | MIT | 2026-10-07 |
| <https://www.npmjs.com/package/es-module-lexer> | 3.0.4 | MIT | 2026-10-15 |
| <https://www.npmjs.com/package/typescript> | 7.0.2（本仓 devDependency 固定 5.9.3） | Apache-2.0 | 2026-07-08 |

- 许可证与署名：三个 MIT 包需随分发保留版权与许可声明；Apache-2.0 需保留 NOTICE 与变更说明。
- 维护活跃度：四者最新发布都在 2026-07 至 2026-10 之间，均活跃维护。
- 可复用部分：`acorn`/`@babel/parser` 的 `CallExpression` 与 `start`/`end` 偏移足以给出「注册调用边界」和「assert/expect 实参范围」；`es-module-lexer` 只做 import/export 词法，不建表达式树，不满足需求。
- 兼容性：本仓 CI 与脚本用 Node 24 + ESM；`acorn` 8.x、`@babel/parser` 8.x 均提供 ESM 入口。未评估二者对 TSX/装饰器的覆盖（本仓路由文件是纯 `.ts` 源，无编译期生成）。
- 引入成本（未压缩安装体积，未实测安装时长）：`acorn` 568 KB / 10 文件；`@babel/parser` 580 KB / 8 文件；`es-module-lexer` 254 KB / 11 文件；`typescript` 2.5 MB / 416 文件。

## 决定

**不引入新依赖，自研「正则 + 字符串感知括号配对」扫描**（`tools/contract-status-core.mjs` 的 `routeDeclarations` / `declarationSegments` / `assertionArgumentRanges` / `operationMentions`）。理由：

1. 本片只做局部判定——注册声明行到块的边界、`assert`/`expect` 实参的字符范围、片段是否点名其他操作——不需要完整 AST、作用域或类型信息。
2. 解析器把「看不懂」变成「解析失败」，会扩大误报面；当前设计对无法机械判定的引用如实输出「不可核」并排除在通过之外，符合本片「不误报、也不默认通过」的要求。
3. 本片不改 `package.json`、不接 CI、不新增依赖（派单与裁定同时约束）；引入 0.25–2.5 MB 的解析器只为几条边界判定不划算，还会引入版本升级耦合。
4. `typescript` 虽已是本仓 devDependency，但它不是本轮判定的必要工具，不应让一个零依赖的校验脚本依赖其安装结果。

实测依据（真实台账，基线 `98658d5`）：`语义可核 55 条区间 + 0 条片段；不可核 138 条区间 + 131 条片段`，`语义错误 0 项`；草稿 4 类语义变异在两臂均被拦下（见 `.pg17/handoff/impl-contract-evidence-semantics.md`）。

## 未取得

- 未安装上述任一包，安装时长与真实构建耗时未实测。
- 未评估解析器方案对 141 条既有 `name` 片段的覆盖率；本片未收窄 `name` 口径。
