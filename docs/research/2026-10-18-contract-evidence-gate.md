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

实测依据（真实台账）：基线 `98658d5` 读数为 `语义可核 55 条区间 + 0 条片段；不可核 138 条区间 + 131 条片段`；返修后在基线 `d4e6b2d`（`bd9c48c` 合入 + `57c89ba` 修正 4 条陈旧 evidence）读数为 `语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段`，两臂 `语义错误 0 项`（详见 `.pg17/handoff/impl-contract-evidence-semantics.md`、`.pg17/handoff/rework-contract-evidence-r1-final.md`）。草稿 4 类语义变异在两臂均被拦下；返修另证「区间落在他人注册块内」三例修前两臂 exit 0、修后两臂 exit 1。

## 未取得

- 未安装上述任一包，安装时长与真实构建耗时未实测。
- 未评估解析器方案对 141 条既有 `name` 片段的覆盖率；本片未收窄 `name` 口径。

## 补充留痕（2026-10-18 审计后补）

> 依据：`T-R11-02` 审计（@`3b776a8`）判定本记录有 F1（「可复用部分」缺计数命令与读数，对应 `docs/research/README.md` §3 的该字段要求）、F2（来源表 4 行中 3 行各仅 1 条 URL，对应 §4「每项 ≥2 条」）两处缺项；处置按 `.pg17/ruling-research-record-addendum-20261018.md` 的选项 B——**就地追加**本节，原文一字未改（append-only，0 行删除、0 行修改）。
> 本轮抓取／复算时点：2026-10-18 09:48（本机 `Get-Date`，UTC+08:00）；基线 `upstream/main = 3b776a8b7bf8fecd9b271f880c549aa5df4f2704`。

### 补 F1：可复用部分的计数命令 ⇒ 读数

命令 1（本仓是否引入或拷贝上游解析器包源码）：

```text
git ls-files | grep -Ec '(^|/)(acorn|@babel/parser|es-module-lexer)(/|$)'
⇒ 0
```

读数 `0`（`grep` 无匹配行时退出码为 1，属正常「无命中」，不是失败）；分母 `git ls-files` 共 **1231** 个受控文件。⇒ 本仓**未引入、也未拷贝复用** `acorn`／`@babel/parser`／`es-module-lexer` 的任何源码或目录。口径说明：本机 `grep` 不在 `PATH`，实测经 Git for Windows 自带的 `D:\Git\usr\bin\grep.exe`（GNU grep）执行，读数与直接 `grep` 等价。

命令 2（自研扫描器脚本的复用面，即 README §3「复用的目录／脚本与数量」的对应物）：

```text
git grep -c "export function " -- tools/contract-status-core.mjs
⇒ tools/contract-status-core.mjs:10
```

读数 **10**：该脚本共 10 个 `export function`。逐函数清单（`git grep -n "^export function " -- tools/contract-status-core.mjs`，实测 10 行）：`scanMountedRoutes`(15)、`mountedMismatches`(56)、`runtimeMountedRoutes`(62)、`evidenceWithinRepository`(72)、`routeDeclarations`(81)、`declarationSegments`(104)、`assertionArgumentRanges`(121)、`operationMentions`(153)、`replaceStatusTables`(166)、`renderStatusTables`(174)。

本记录「决定」段点名的 4 个函数逐一实测存在，复用面如下：

| 复用函数 | 实测行号 | 在本片中的作用 |
| --- | --- | --- |
| `routeDeclarations` | 81 | 取注册声明行及其调用的字符区间 |
| `declarationSegments` | 104 | 由声明行切出注册块片段 |
| `assertionArgumentRanges` | 121 | 取 `assert`／`expect` 实参的字符范围 |
| `operationMentions` | 153 | 判片段是否点名其它契约操作 |

⇒ 复用面 = **1 个脚本（`tools/contract-status-core.mjs`）／其 10 个导出函数中的 4 个**；实现为自研「正则 ＋ 字符串感知括号配对」，**0 行**来自上游解析器包（命令 1 读数 `0` 佐证）。

### 补 F2：逐项补充来源（各 ≥1 条与原文行不同页面、本轮实抓）

| 技术 | 本轮实抓 URL（与原文行不同页面） | 本轮读数 |
| --- | --- | --- |
| `@babel/parser` | <https://registry.npmjs.org/@babel/parser> | 版本 8.0.7；许可证 MIT；发布 2026-10-07T10:00:37.851Z；`dist.fileCount` 8；`dist.unpackedSize` 579648 |
| `es-module-lexer` | <https://registry.npmjs.org/es-module-lexer> | 版本 3.0.4；许可证 MIT；发布 2026-10-15T04:35:33.820Z；`dist.fileCount` 11；`dist.unpackedSize` 254251；`gitHead` 1c17334d2c3bc0eed6a92022e16254a28bb9ebea |
| `typescript` | <https://registry.npmjs.org/typescript> | 版本 7.0.2；许可证 Apache-2.0；发布 2026-07-08T15:55:18.431Z；`dist.fileCount` 416；`dist.unpackedSize` 2497498；`gitHead` 2bd066d87f5bafd315be9f40889d0a60b9e58e0b |

- 每项 URL 条数（原文 ＋ 本轮）：`acorn` 2 条（原文已满足）、`@babel/parser` 2 条、`es-module-lexer` 2 条、`typescript` 2 条 ⇒ **四项均 ≥2 条**，满足 README §4。页面区分：本轮新页在 `registry.npmjs.org`（registry JSON 文档），原页在 `www.npmjs.com`（包展示页），域名与页面均不同，非同一页面转载。
- 读数复核：本轮三行读数与原文来源表**逐字一致**（8.0.7／MIT／2026-10-07；3.0.4／MIT／2026-10-15；7.0.2／Apache-2.0／2026-07-08）⇒ 原文读数无订正项。
- 抓取方式：本机 `Invoke-RestMethod` 直取上述 registry JSON 文档（未使用检索词，未走镜像，未凭记忆）。另为取「不同页面类型」试过 `https://api.github.com/repos/<owner>/<repo>/releases/latest`（`babel/babel`、`guybedford/es-module-lexer`、`microsoft/TypeScript` 各 1 次），三次均返回 `403 已禁止`（本机出网策略）⇒ 该路为**附加**尝试，不影响 §4 的 ≥2 条要求；所需三项来源**未取得 0 条**。

### 结论不变声明

本节只补 README §3／§4 的结构字段，**不改变原记录的结论**：仍为「不引入 `acorn`／`@babel/parser`／`es-module-lexer`，自研轻量扫描」，决定与 4 条理由见上文原文「决定」段，逐字未改。
