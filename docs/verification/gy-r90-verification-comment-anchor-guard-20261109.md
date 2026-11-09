# verification 注释锚点影子闸门（R90，2026-11-09）

> 读数快照：2026-11-09（Asia/Hong_Kong），基线 `origin/main` `6497031677a6ca0d7c453d18a6415ad3e68fce69`。本页报这一版读数；其中 §三 的 `8556/359` 与朴素口径 `1683/256` 两条已在 2026-11-09 复核后改成「带时点 + 带复现命令」的写法（`af39bfe6` 上的重收读数另见 `docs/verification/gy-r90-comment-anchor-rebaseline-20261109.md`）。主工具与本工具的计数口径不同，见 §一 1.3；两者不能相减。

## 一、盲区证据

### 1.1 主工具对 verification 的符号行只统计、不判红

- `tools/verify-doc-anchors.mjs:156` 把符号行判定的作用域限定为 `docs/architecture/`。
- `tools/verify-doc-anchors.mjs:876` 的 `if (!symbol.inScope)` 分支里，`tools/verify-doc-anchors.mjs:878` 只对 `comment-attached` 做 `stats.symbol.outside += 1`；真正写 `recordCommentAnchor` 的 `tools/verify-doc-anchors.mjs:884` 在 in-scope 的 `else` 分支里。因此 `docs/verification/**` 的注释锚点进不了 `commentAnchors`，也进不了 findings。
- 漂移面同样只覆盖 architecture：`tools/verify-doc-anchors.mjs:994`。
- verification 的 strict 面是只读统计：`tools/verify-doc-anchors.mjs:1350` 是 `SYMBOL_COVERAGE_VERIFICATION_SCOPE`；同处注释（第 1345–1348 行）说明三档都不参与退出码。CI 虽带 `--symbol-coverage-verification=strict`，但那里的 verification 回归闸门只判「计数比基线上升」，不判行类型。
- 主工具并非没有注释概念：`tools/verify-doc-anchors.mjs:244` 的 `isSubstantiveLine` 与 `tools/verify-doc-anchors.mjs:251` 的 `isCommentLine` 都在。第 240–242 行的注释明写「刻意不把注释行算作无内容：引用一段判据注释是合法证据形态」；问题不在这个判断本身，而在 verification 面没有单独统计/拦截它。

### 1.2 一个可核的实例

`tests/integration/post-media-attach-http-pg.mjs` 第 767 行的原文是 `// PASS 9 · 24h 自衰减（时间穿越，只动 SQL 行）`。本页刻意**不**把它写成 `path:line` 锚点——那正是本片要治的形态。当前有 7 条 `docs/verification/**` 锚点落到这一行：

- `docs/verification/gy-r87-i30-http-e2e-20261107.md:164`
- `docs/verification/gy-r88-i30-pool-decay-20261108.md:125`
- `docs/verification/gy-r88-open-issue-acceptance-index-20261108.md:68`
- `docs/verification/gy-r89-open-issue-acceptance-index-20261108.md:30`
- `docs/verification/gy-r89-open-issue-acceptance-index-20261108.md:53`
- `docs/verification/gy-r89-open-issue-acceptance-index-20261108.md:71`
- `docs/verification/gy-r89-open-issue-acceptance-index-20261108.md:179`

上面七个 `:line` 指向的是这些文档自身的表格/引用实质行；被它们引用的测试第 767 行才是注释行。这正是「文档行是实质行，但锚点目标可以是注释」的两层结构，不能因为文档行非空就认为目标也非注释。

> 后续变化：`#1116`（`9946370f`，2026-11-09）把这批锚点改指行为行（代码行）——该提交在页里写明「这两组的块首注释分别在第 767、877 行，是注释而不是行为行，故不再引作主证据」。因此在 `af39bfe6` 上落到第 767／820／877 行的注释锚点是 **0** 条（对应旧基线 16 条键失效），本节列表保留为 `#1119` 时刻的实例；逐条见 `docs/verification/gy-r90-comment-anchor-rebaseline-20261109.md` 的 G 组。

### 1.3 为什么主工具读数与本工具的 1427 不能相减

- 审查意见当时引的「255」本页**复现不出来**。同一条四连 strict（`node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs`）在基线树 `6497031` 上打「`SYMBOL-COVERAGE-VERIFICATION: 可判 984 条——OK 940、符号不在区间 44`」，`UNDECLARED` 250；在 `af39bfe6` 上打「可判 1015 条——OK 971、符号不在区间 44」，`UNDECLARED` 252。两棵树都没有 255。按实测改记：verification 面「符号不在区间」**44**，`UNDECLARED` **250**（`6497031`）／**252**（`af39bfe6`），255 作废。
- 主工具这一面只统计「锚点 + 紧邻符号」能配成对的那部分：`tools/verify-doc-anchors.mjs:1350` 把作用域钉在 `docs/verification/`，`tools/verify-doc-anchors.mjs:878` 只对 `comment-attached` 计 `stats.symbol.outside`；同行没有紧邻符号的锚点在 `6497031` 是 4562 条、在 `af39bfe6` 是 4717 条，不进这一档。
- 本工具的 1427（重收后 1422）是 `docs/verification/**/*.md` 里所有首行落在注释行的 `path:line` 锚点，不要求目标是被 symbol 规则识别的符号，目标文件类型包含 js/ts/json/yml/sql/md，且包含区间锚点。
- 两者分母不同：主工具那三档是「能配上符号」的子集，本工具是全目标文件类型集合。**不能相减，也不能用 1427 去反推主工具有遗漏**；本片只提供另一条更宽的影子读数。

## 二、本片做法

- 新增独立只读工具 `tools/verify-verification-comment-anchors.mjs`；不改 `tools/verify-doc-anchors.mjs`，不改 `.github/**`。
- 锚点提取与主工具同口径：复用 `extractReferences` 与 `attributeBareAnchors`，显式 `path:line` 直接取，同行裸锚点按最近前置路径归属；围栏代码块单独计入 `fenced`，不混进注释计数。
- `tools/verify-verification-comment-anchors.mjs:100` 的 `commentKindsOf` 做有状态块注释掩码：识别 `//`、`/* */`、`*` 续行、`--`、shell/sql/yml 语境的 `#`、`<!-- -->`。块状态只在整行以 `/*` 或 `<!--` 开头时打开，避免把 `packages/contracts/openapi.json` 里 `"description": "audio/*"` 这类字符串误判成块注释。
- `tools/verify-verification-comment-anchors.mjs:161` 的 `collectCommentAnchors` 先去重（同一 `docLine|target|from|to` 的显式/继承撞车只算一次），再解析目标文件，按首行分类：`comment`、`code`、`blank`、`outOfRange`、`unresolved`（`ambiguous` 单列子计数）、`fenced`，另有 `duplicate`；六格加 `duplicate` 等于 `candidates`。
- 基线条目键是 `tools/verify-verification-comment-anchors.mjs:291` 的 `baselineKey`，即 `doc|line|target|from` 四元组；`to` 与 `kind` 只作说明，不参与键。`tools/verify-verification-comment-anchors.mjs:347` 的 `describeStale` 负责说明「文档没了 / 目标无法解析 / 行号越界 / 目标仍是注释但文档行号疑似位移 / 目标已不是注释」。
- `tools/verify-verification-comment-anchors.mjs:370` 的 `evaluateCommentAnchorGate` 只做三件事：基线内命中、基线外新增、基线可收紧。`tools/verify-verification-comment-anchors.mjs:496` 的 `main` 负责打印与退出码。
- 闸门语义：`--require-no-new` 默认开，基线外新增 ⇒ EXIT 1 并逐条点名；基线内 ⇒ EXIT 0 但逐条 WARN；基线里已有、实际已不再命中 ⇒ 默认 EXIT 0 + `可收紧基线` WARN，`--require-no-stale` 时 EXIT 1；`--write-baseline` 只在显式传参时写盘，并打印 `写入了 N 条`。
- 基线文件 `tools/verification-comment-anchor-baseline.json`：**1427 条、197 个文档、316,705 字节**（`#1119` 时刻的读数；2026-11-09 已在 `af39bfe6` 上重收为 1422 条 / 200 文档 / 315,546 字节，新旧对照与逐条 `added`／`removed` 见 `docs/verification/gy-r90-comment-anchor-rebaseline-20261109.md`，本页其余读数保持当时原样、不追改），`accepted` 为 `gy-r90-comment-anchor-shadow-batch`。`why` 原文：「逐字引用判据注释原文」在本仓是合法证据形态的一类（例如证据页引用 workflow 注释说明不变量），这批历史命中未经逐条人工裁定，先整批登记为影子基线；闸门只拦基线之外的新增，修掉一条再由 `--write-baseline` 收紧。

## 三、基线构成与当前读数

上表与本节两条读数都是 `#1119` 时刻（基线 `6497031` 上生成、1427 条）的构成；2026-11-09 在 `af39bfe6` 上重收后的构成（1422 条 / 200 文档 / 315,546 字节）见 `docs/verification/gy-r90-comment-anchor-rebaseline-20261109.md`，两者不要混读。

| 注释种类 | 条数 |
| --- | ---: |
| line-comment | 547 |
| block-comment | 495 |
| jsdoc | 144 |
| hash-comment | 140 |
| sql-comment | 100 |
| html-comment | 1 |
| **合计** | **1427** |

- 1427 条里有 682 条是区间锚点（`to != from`），745 条是单行；本工具只按 `from` 首行判类型，不判区间尾行。（2026-11-09 位移配对片修订：**是否计入**仍按 `from`，但 `kind` 与告警正文改按窗口内首个行为行判，`kind=range-covers-code` 并标注「区间证据行」，见 `docs/verification/gy-r90-comment-anchor-relocation-20261109.md` §五。）
- 基线生成时的读数（基线在其上生成的 `6497031` 树、本页尚未合入；`node tools/verify-verification-comment-anchors.mjs` 默认口径）：`candidates=8556 comment=1427 code=6371 blank=137 out-of-range=16 unresolved=284 fenced=314 duplicate=7`，扫描 `documents=359`（只数 `docs/verification/**/*.md`）。`unresolved` 中 `ambiguous=284`；`comment=1427` 与基线条数相等 ⇒ 基线外新增 0、EXIT 0。
- 本页合入后的读数（`9862bb7b` 树、含本页自身）：`candidates=8584 comment=1427 code=6399 blank=137 out-of-range=16 unresolved=284 fenced=314 duplicate=7`，`documents=360`。本页自身贡献 +28 个 candidates、+1 个文档，且这 28 条全部落在代码行（`code` 6371→6399），故 `comment` 仍是 1427、基线不必为本页重写。
- 上面两条各自绑定一棵树与一个时刻，**不是** main 的当前读数；main 前进到 `af39bfe6` 后的重收读数（`candidates=8842 comment=1422`、`documents=365`）见 `docs/verification/gy-r90-comment-anchor-rebaseline-20261109.md`。
- 掩码收紧前的朴素读数：把 `tools/verify-verification-comment-anchors.mjs:115` 的「整行以 `/*` 开头才开块状态」换回「行内出现 `/*` 就开状态」，同一棵 `6497031` 树上 `comment` 由 1427 涨到 **1683**、`code` 由 6371 跌到 6115，基线外新增 **256** 条。256 条全部是对 `packages/contracts/openapi.json` 的误判（例如 `"x-scope": "sources:write",`、`"description": "SCOPE_DENIED, …"`），不是被删掉的真实锚点；测试 ⑥（`tests/unit/verify-verification-comment-anchors.test.mjs:182`）钉死这个回归。复现见本页 §五 末段。
- 基线是**冻结**，不是裁定：它只回答「这批在 2026-11-09 已经存在」，不回答「每一条都该保留」。逐条修掉后从基线删条目并重跑 `--write-baseline`，是后续收紧路径。

## 四、变异读数（证明闸门真能红）

- **新增一条**：临时加入 `docs/verification/tmp-comment-anchor-mutation.md`，其中一条锚点指向 `tests/integration/post-media-attach-http-pg.mjs` 第 767 行。读数变为 `comment=1428`，打印一条 `NEW`，`基线外新增 1`，**EXIT 1**；临时页随后删除。
- **修掉一条**：把 `services/api/src/moderation/service.ts` 第 139 行的 JSDoc 临时替换成 `export const MUTATION_PROBE = 0;`。读数变为 `comment=1426`，打印一条 `STALE`，原因为「目标行已不是注释行（疑似已修）」，`可收紧 1`，默认 **EXIT 0** + WARN；加 `--require-no-stale` 则 EXIT 1。随后 `git checkout -- services/api/src/moderation/service.ts` 复原，`git diff` 为空。
- **单元测试**：`node --test tests/unit/verify-verification-comment-anchors.test.mjs` → 6/6 pass，EXIT 0。覆盖：基线内不红（`tests/unit/verify-verification-comment-anchors.test.mjs:93`）、基线外新增点名（`tests/unit/verify-verification-comment-anchors.test.mjs:112`）、已修条目的可收紧提示与 `--require-no-stale` 红（`tests/unit/verify-verification-comment-anchors.test.mjs:129`）、目标缺失/越界单列（`tests/unit/verify-verification-comment-anchors.test.mjs:146`）、基线缺失按 0 条处理（`tests/unit/verify-verification-comment-anchors.test.mjs:174`）、`audio/*` 字符串不误判 JSON（`tests/unit/verify-verification-comment-anchors.test.mjs:182`）。

## 五、运行方式与退出码

```text
node tools/verify-verification-comment-anchors.mjs
node tools/verify-verification-comment-anchors.mjs --require-no-stale
node tools/verify-verification-comment-anchors.mjs --write-baseline
```

- 默认 `--require-no-new`：新增红、基线内 WARN、可收紧 WARN 但 EXIT 0。
- `--require-no-stale`：可收紧也红，用于确认基线只减不增后的收紧阶段。
- `--write-baseline`：唯一写盘入口，打印 `写入了 N 条`；不传就绝不改基线。
- 测试放在 `tests/unit/**`，由既有 `unit-tests` 的 glob 自动执行，因此本片不需要改 `.github/**`。

**复现「朴素口径 1683 / 256」**（不改仓库里的工具，用只改了这一处的临时副本）：

```text
git worktree add <tmp> --detach 6497031677a6ca0d7c453d18a6415ad3e68fce69
# 把当前 main 的 tools/verify-verification-comment-anchors.mjs 与旧基线放进 <tmp>；
# 再把 tools/verify-verification-comment-anchors.mjs:115 的 `startsWith('/*')` 改成 `includes('/*')`：
node <tmp>/tools/verify-verification-comment-anchors.mjs --scan docs/verification
# ⇒ comment=1683、基线外新增 256（多出来的全是对 packages/contracts/openapi.json 的误判）
node <tmp>/tools/verify-verification-comment-anchors.mjs --scan docs/verification   # 原判据
# ⇒ comment=1427、基线外新增 0、EXIT 0
```

## 六、不声称

- 不声称这 1427 条注释锚点都是错的。仓内确实存在「逐字引用判据注释」的合法证据形态；本片只把「基线外新增」变成可见的红色，不替历史条目定罪。
- 不声称替代人工逐条裁定。基线只冻结现状，`accepted`/`why` 明确写了这批未经逐条裁定，后续仍需人判断每条是修锚点还是保留并说明。
- 不声称覆盖 `docs/architecture` 面。主工具对 architecture 的符号行判定仍是原口径；本工具只扫 `docs/verification/**/*.md`，也不覆盖 `docs/` 下其他目录。
- 不声称判断注释内容是否与断言一致。本工具只判锚点目标首行「是不是注释」，不判注释文字是否支持文档结论，也不判区间尾行。
- 不声称 1427 与主工具的 verification 面读数（符号不在区间 44、`UNDECLARED` 250／252）同一分母，或可互相校验；两者的口径差异见 §一 1.3。

## 七、后续收紧路径

1. 人工逐条看基线里的 1427 条，优先处理「注释只是分隔线/块标题，不含判据」的条目；把锚点改到邻近实质行。
2. 每修一条就从 `tools/verification-comment-anchor-baseline.json` 删对应四元组，跑 `node tools/verify-verification-comment-anchors.mjs --write-baseline` 收册；不要手工改基线计数。
3. 基线只减不增后再考虑把 `--require-no-stale` 接进常驻闸门；本片先保留默认 WARN，避免「文档插删行导致键位移」被误判成修复。
4. 若确有新的合法注释证据，只能显式 `--write-baseline` 并在 `why` 里写明理由；不允许静默把新增注释锚点变成绿色。
