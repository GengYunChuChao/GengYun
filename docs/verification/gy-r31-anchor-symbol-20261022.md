# 台账锚点符号化（`locator`）验证记录（GY-R31，Refs #17）

- 分支：`test/gy-r31-anchor-symbol`；工作树 `E:\GengYunCommander\wt-r31-anchor-sym`；基线 `origin/main` = `489804e451814d711a45bf9be67c7b871b17584a`（2026-10-22 实取）。
- 环境：node `v24.16.0`、npm `11.13.0`、python `3.14.3`；依赖 `npm ci --prefer-offline --no-audit --no-fund --ignore-scripts`（只写本工作树，lockfile 未改）。
- 目标：让台账锚点支持**符号级定位**——条目写「文件 + 符号名（函数/方法/路由注册块）」，行号在运行时解析；行号形态继续可用。
- 不碰的字段：`status` / `blocker` / `evidence`（除 `requestAccountDeletion` 那一条的 `anchor` 形状）；不改业务代码；不合并、不 approve、不推 main、不强推。

## 1 口径

| 形态 | 写法 | 行号从哪来 | 落盘 |
| --- | --- | --- | --- |
| 行号（旧，继续可用） | `{ "path": "…", "symbol": "锚点文本", "lines": "起-止" }` | 人写死 | `--reanchor --write-doc` 重写 |
| 符号（新） | `{ "path": "…", "symbol": "锚点文本", "locator": { "symbol": "registerAccountDeletionRoutes", "file"?: "…" } }` | 运行时按归属块口径解析 | 台账里没有数字，无物可写 |

- 两种形态**二选一**：同时给 `lines` 与 `locator` 是形状错误；`locator` 只认 `symbol`（必填、非空）与 `file`（可选，缺省取 `path`／`test`），多余字段即形状错误。
- 解析失败三档，**全部是形状错误 ⇒ exit 1 并列出候选**，不降级成「不可核」：`MISSING`（0 个候选）、`NO_BLOCK`（有同名声明但无块体）、`AMBIGUOUS`（多个候选，逐个列出 `起-止` 与命中行）。
- 符号形态**不向上找块**：只认同名声明自己的块体，找不到就报错——宁可不猜。
- 提取器单一来源：`tools/lib/anchor-resolve.mjs`。`tools/verify-contract-status.mjs`（含 `--reanchor`）与 `tools/contract-status-core.mjs`（渲染）都从这里 import；`isDeclarationLine` / `enclosingBlock` / `braceBlockEnd` / `anchorLineNumbers` 已从 `contract-status-core.mjs` **迁出**（不是复制），仓内不存在第二套提取器。
- 对照表渲染：符号形态渲染成 `path#符号`，**不渲染解析出的行号**。原因见 §6「取舍一」：那张表是逐字比对的门禁，写数字等于把行号漂移从台账搬进文档（app.ts 每上移 10 行，中文对照表就假红一次），与本片要治的病相反。当前解析值在每次运行的 `PASS: 符号形态锚点 …` 行里打印。
- 样板条目（只改这一条）：`operations[requestAccountDeletion].evidence[2]`（`services/api/src/app.ts`）由 `"lines": "1825-1833"` 改为 `"locator": { "symbol": "registerAccountDeletionRoutes" }`。**JSON 行数不变**（1 行换 1 行），因此仓内十余处 `contract-status.json:N` 的行号引用不被本片撞坏。

## 2 五件读数（改前 / 改后）

| # | 命令 | 改前（`489804e4` 干净树） | 改后（本片工作树） |
| --- | --- | --- | --- |
| 1 | `npm run test:unit`（`GY_BASH=D:\Git\bin\bash.exe`） | tests 3764 / pass 3760 / **fail 1** / skipped 1 / todo 2；206.3 s；失败项是 `tests/unit/contract-status-tool.test.mjs:195` 的 `spawnSync … ETIMEDOUT`（`runtimeMountedRoutes` 的 15 s 子进程超时，全量并发下偶发），非代码断言 | tests 3769 / pass 3766 / **fail 0** / skipped 1 / todo 2；69.6 s（+5 条为本片新增用例） |
| 2 | `npm run test:contract` | tests 6 / pass 6 / fail 0，exit 0 | tests 6 / pass 6 / fail 0，exit 0 |
| 3 | `node tools/verify-contract-status.mjs` | exit 0：113 op、已装配 109、implemented 13 / partial 96 / planned 4、横切 8；语义可核 105 区间 + 不可核 99；证据锚点 412（区间内 240 + 仅整文件 172）、无锚点 0；纯行号区间 240；中文表格一致 | exit 0：113 op、已装配 109、**13 / 96 / 4**、横切 8；语义可核 105 + 不可核 99；证据锚点 **412（240 + 172）**、无锚点 0；行号区间 **240（台账直写 239 + 符号解析 1）**；**符号形态锚点 1 条 ⇒ 1826-1833**；中文表格一致 |
| 4 | `node tools/verify-doc-anchors.mjs --strict` | **本基线无此工具**（只在未合并的 `test/gy-r31-doc-anchors`／`test/gy-r31-doc-anchor-fix` 分支），见 §6「未取得一」 | 同上（工具仍不在本基线；本片未新增/修改任何 `docs/**` 里的 `源文件:行号` 引用，替代读数见下） |
| 5 | `python tools/validate_development_docs.py` | PASS：27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables | PASS（含本页；新建前一次跑为 `ERROR: … missing link ../verification/gy-r31-anchor-symbol-20261022.md`，建页后转 PASS） |

第四件的替代读数（同一棵树、同一时点）：`npm run test:docs` 与 `npm run lint`；另用 `test/gy-r31-doc-anchors` 分支上的 `tools/verify-doc-anchors.mjs` 对 `origin/main` 树跑过一次 `--strict`，读数是「基线之外新增 10 条」（该片自己的基线尚未覆盖 main 的现状），本片不据此判红、也不把它当门禁读数。

status 分布逐项对照（改前 = 改后，未动语义字段）：implemented 13 条、partial 96 条、planned 4 条，合计 113；已装配 109 条；横切维度 8 条。`--reanchor` 改后读数：

```
REANCHOR: requestAccountDeletion services/api/src/app.ts#registerAccountDeletionRoutes 符号形态锚点，运行时解析为 1826-1833（台账里没有行号，无需重写）
REANCHOR: 无可重定位项（带锚点且带行号的引用 239 条，锚点都在 ±2 行容差内；符号形态 1 条按运行时解析，不写盘）
```

## 3 核心价值证明：同一份台账、同一棵树，只在 `app.ts` 头部插行

做法：整棵工作树复制到临时目录（排除 `node_modules`/`.git`），台账**只做文本级**替换（符号形态 ⇄ `"lines": "1825-1833"`，其余字节相同），`services/api/src/app.ts` 头部插入 N 行注释；每次跑 `node tools/verify-contract-status.mjs`。六臂实测（2026-10-22，`489804e4` 基线的 app.ts，1928 行）：

| 台账形状 | 头部插入 | 装配块实际所在 | exit | 语义错误 | 命中 `app.ts` 条目 | 表格漂移 | 解析读数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `lines: "1825-1833"` | 0 | 1826-1833 | 0 | 0 | 0 | 0 | — |
| `lines: "1825-1833"` | **10** | 1836-1843 | **0** | **0** | **0** | 0 | —（见下「边界」） |
| `lines: "1825-1833"` | **11** | 1837-1844 | **1** | **1** | **1** | 0 | — |
| `locator#registerAccountDeletionRoutes` | 0 | 1826-1833 | 0 | 0 | 0 | 0 | `⇒ 1826-1833` |
| `locator#registerAccountDeletionRoutes` | 10 | 1836-1843 | **0** | 0 | 0 | 0 | `⇒ 1836-1843` |
| `locator#registerAccountDeletionRoutes` | 11 | 1837-1844 | **0** | 0 | 0 | 0 | `⇒ 1837-1844` |

红的那一臂的原文（`+11`，行号形态）：

```
ERROR: 语义错误 · requestAccountDeletion: services/api/src/app.ts:1825-1833 的锚点「accountDeletionWired」不在引用行范围内（容差 ±2 行；实际出现在第 1836、1838、1839、1840 行）
FAIL: 契约实现状态对照校验未通过（1 项）[形状错误 0 / 语义错误 1 / 表格漂移 0]
exit 1
```

绿的那一臂的原文（`+11`，符号形态）：

```
PASS: 符号形态锚点 1 条（运行时解析，台账里不存行号：services/api/src/app.ts#registerAccountDeletionRoutes ⇒ 1837-1844）
PASS: 中文表格一致
exit 0
```

**边界（实测，必须一起读）**：派单写的是「头部插 10 行」，但这一条台账项在 `+10` 时**行号形态并没有变红**。原因是既有判据 `from-2 ≤ 命中行 ≤ to+2` 把容差加在区间**两端**：首命中从 1825 漂到 1835，而区间终点 1833 + 2 = 1835，恰好压线（区间里另外三个命中 1837/1838/1839 其实早已越界，但判据是 `some`，只要有一个命中在容差内就算过）。插 **11** 行（首命中 1836 > 1835）才 exit 1、语义错误 1 条。也就是说：旧形态在「漂移 10 行」这个派单点名的场景里不是「能被发现」，而是**错得刚好没被发现**——这比红更糟，也正是本片要治的病。符号形态在 0／10／11 三种情况下都绿，且解析值同步漂移（1826-1833 → 1836-1843 → 1837-1844）。

单元测试把这条边界按**当前文件**算出来而不是写死：`shiftToRed = blockEnd + 3 - anchorLine`（今日 = 11），断言「`+10` 符号形态仍绿」「`+shiftToRed` 行号形态红、符号形态绿」，app.ts 再漂也不会让该用例变成假红。

## 4 四张 PR 里该行的实际行号（实测，2026-10-22）

用 `git fetch origin refs/pull/<n>/head` 取到 PR 头，逐张量 `services/api/src/app.ts` 的 `const accountDeletionWired` 行与本次装配块末行，并读该 PR 自己台账里的 `lines`：

| 引用 | 头 SHA | 该行实际所在（const / 块末） | 该 PR 台账写的 `lines` | 与 `origin/main` 的关系 |
| --- | --- | --- | --- | --- |
| `origin/main` | `489804e4` | 1825 / 1833 | `1825-1833` | 基线 |
| `#407` | `575b0847` | 1816 / 1824 | `1816-1824` | 未合入；比 main 少 9 行 |
| `#419` | `276ac3f9` | 1864 / 1872 | `1864-1872` | 未合入；比 main 多 39 行 |
| `#469` | `5947c507` | 1825 / 1833 | `1825-1833` | 已合入 main（merge commit `371c0ad9`） |
| `#474` | `4f5dd61a` | 1847 / 1855 | `1847-1855` | 未合入；比 main 多 22 行 |

四张 PR 各自把自己的 `lines` 重锚成四个不同值（1816／1825／1847／1864）。合并任意两张，未后合的那张的 `lines` 必然指向错误区间——若两者相差落在 ±2 容差外则红、落内则静默绿；这与任务书 §背景 的复现同构（任务书记的是当日的 1814-1822 → 1825-1833 → 1836-1844，今天 main 已前进，故读数为本表）。符号形态下这四张 PR 都不需要重锚：`locator.symbol` 在各自树上解析出各自的行。

## 5 负控制（`tests/unit/contract-anchor-symbol.test.mjs`，夹具用**真实** `services/api/src/app.ts`）

| 用例 | 做法 | 读数原文（关键行） |
| --- | --- | --- |
| 正例 | 符号形态，未插行 | `PASS: 符号形态锚点 1 条（运行时解析，台账里不存行号：services/api/src/app.ts#registerAccountDeletionRoutes ⇒ 1826-1833）`；台账逐字节未变；对照表渲染 `services/api/src/app.ts#registerAccountDeletionRoutes`，`PASS: 中文表格一致` |
| 负控制 1 | `locator.symbol` 改成不存在的 `createAccountDeletionWiring` | `ERROR: 形状错误 · post /me/account/deletion: services/api/src/app.ts 的符号锚点「createAccountDeletionWiring」解析失败（MISSING：符号在文件里出现 0 次，但没有一处是声明行（要函数/方法/路由注册块，或 const/class/interface/type 声明））`；`FAIL: … [形状错误 1 / 语义错误 0 / 表格漂移 0]`；exit 1 |
| 负控制 2 | 在 app.ts 末尾再声明一个同名函数 | `ERROR: 形状错误 · post /me/account/deletion: services/api/src/app.ts 的符号锚点「registerAccountDeletionRoutes」解析失败（AMBIGUOUS：符号落在 2 个不同归属块（候选 1826-1833、1930-1932；命中行 1826、1930））`；exit 1，两个候选都列出 |
| 负控制 3 | 头部插入（见 §3） | `+10`：符号形态 exit 0、解析 1836-1843；`+11`：行号形态 exit 1（`语义错误 1`），符号形态 exit 0、解析 1837-1844 |
| 形状 | `lines` 与 `locator` 同给 / `locator` 带未知字段 | `… 同时给了 lines 与 locator，锚点两种形态只能二选一`；`locator 出现未知字段 range（只认 symbol 与 file）`；都 exit 1 |

## 6 未取得项 / 取舍 / 边界

- **未取得一（工具不存在）**：`tools/verify-doc-anchors.mjs` 与 `tools/reanchor-doc-anchors.mjs` **不在 `origin/main` 基线上**（`git ls-tree origin/main` 无此文件；前者只在未合并的 `test/gy-r31-doc-anchors`／`test/gy-r31-doc-anchor-fix` 分支，后者仓内不存在）。因此「三个工具都改用同一个解析器」在本基线只能落到**实存的两个调用点**：`tools/verify-contract-status.mjs`（含 `--reanchor`）与 `tools/contract-status-core.mjs`（渲染）。共享模块 `tools/lib/anchor-resolve.mjs` 的 API 已按「文档行号闸门也能直接用」的形状导出（`locatorSpec` / `resolveSymbolBlock` / `enclosingBlock` / `anchorLineNumbers`），后续闸门落地时 import 即可，无需再抄；本片不代建他人未合并的工具。
- **取舍一（表格不写数字）**：任务书要求「`--write-doc` 仍能把它渲染成当前行号」。本片的落地是：对照表渲染 `path#符号`（稳定、可逐字比对），当前行号在每次运行的 `PASS: 符号形态锚点 …` 行与 `--reanchor` 的 `REANCHOR: … ⇒ 起-止` 行给出，证据页另存快照（§2／§3）。若把解析出的数字写进对照表，这张逐字比对的表会随 app.ts 每次上移而假红（比本片要治的漂移更频繁），故不采纳；这是取舍，不是遗漏。
- **取舍二（字段名）**：任务书写的「新形态 `symbol: "…"`，可选 `file`」直接落在证据项上会与既有**锚点文本**字段 `symbol` 撞名（后者已用于 412 条引用）。故新形态落成 `locator: {symbol, file?}`，`symbol` 保持「锚点文本」原义不变；台账 diff 因此只有 1 行。
- **边界一（`--write-doc` 会把对照文档改成 LF）**：`docs/architecture/contract-implementation-status.md` 在库里是 CRLF，`--write-doc` 落盘固定用 LF ⇒ 整份文档 200 行全变（既有行为，与本片无关）。本片因此只对**那一格**做定向替换（`app.ts:1825-1833` → `app.ts#registerAccountDeletionRoutes`），保住 CRLF，diff 为 1 行；`node tools/verify-contract-status.mjs` 复跑仍 `PASS: 中文表格一致`。
- **边界二（±2 容差）**：同一份台账、同一棵树，行号形态在 `+10` 行时因容差压线而**不变红**（§3）。本片没有改容差（那是既有判据、有独立依据），但把该读数钉进证据页与单测，避免有人把它当成「10 行以内没问题」。

## 7 变更清单

- 新增 `tools/lib/anchor-resolve.mjs`：归属块提取器 + 符号解析的单一来源（`isDeclarationLine` / `declarationName` / `declarationBlock` / `enclosingBlock` / `braceBlockEnd` / `anchorLineNumbers` / `locatorSpec` / `resolveSymbolBlock`）。
- `tools/contract-status-core.mjs`：删除已迁出的提取器（-121 行），改为 import；对照表证据格渲染 `path#符号`。
- `tools/verify-contract-status.mjs`：新增 `locator` 形态（形状校验、区间级校验共用同一份解析结果、`--reanchor` 的 `SYMBOL` 拒绝档与 `symbolResolved` 报告）；输出新增一行 `PASS: 符号形态锚点 …`，`纯行号区间` 一行改为 `行号区间（台账直写 + 符号解析）`。
- `docs/architecture/contract-status.json`：只改 `requestAccountDeletion` 那一条的锚点形状（1 行）。
- `docs/architecture/contract-implementation-status.md`：§0 补「锚点两种形态」一段；对照表那一格改渲染形式（CRLF 保留）。
- `tests/unit/contract-anchor-symbol.test.mjs`：新增 5 条用例（正例 + 三条负控制 + 形状）。
- `tests/unit/contract-status-{anchors,reanchor,tool}.test.mjs`：夹具复制清单加 `lib/anchor-resolve.mjs`；三处输出文案断言随格式更新。
- `docs/verification/gy-r31-reanchor-20261022.md`：把「归属块实现在 `contract-status-core.mjs`」的事实指向新位置（一行）。

## 8 不做 / 待监工

- 未合并、未 approve、未推 main、未强推；只推 `test/gy-r31-anchor-symbol`。
- 其余 112 条操作与 8 条横切维度的锚点形状**未动**（避免大 diff，也避免与 #407／#419／#469／#474 抢同一片）。
- `status` / `blocker` / `evidence` 语义字段未动；本片不主张任何操作的状态变化。
