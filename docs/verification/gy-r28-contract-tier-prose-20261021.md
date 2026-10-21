# GY-R28 / S53：契约台账 §0「锚点层只计数」过期口径订正

> 切片：R28-S53；分支 `docs/gy-r28-contract-tier-prose`；基线 `76b0e86`（`git rev-parse HEAD` 起步值，本片提交是其直接子提交）；工作树 `E:\GengYunCommander\wt-r28-s53`。

- 范围：只订正 `docs/architecture/contract-implementation-status.md` §0 第 23 行的一处**过期结论**。台账事实源、生成区、`tools/`、`tests/`、`services/` 全部未动。
- 本片不含代码：改的是「这句叙述与今天的读数是否一致」，不是任何判定逻辑。

## §0 结论

1. 第 23 行末尾「锚点层目前只计数、尚无可核样本」在 `76b0e86` 上**已是假话**：229 条引用已带 `symbol`，「区间内」档从**恒 0** 变成 **229 条真在跑**。改后该半句不存在，代之以「历史读数 + 现状读数 + 仍成立的边界」三段。
2. `56042f7` 的「409 条证据中 `symbol`/`anchor` 命中 0 条」**保留为历史记录**（未删、未改数），只补一句显式的「这是历史读数，不是现状」。
3. 边界句保留并写得更死：锚点只证明「该符号出现在该引用行区间内」，**不证明证据与操作的语义对应**；229 条锚点**不改变**这条，指错地方/指错操作（但符号恰在区间内）仍可能过门禁。
4. 第 26 行的锚点校验陈述经核实**仍与实现一致，未改**（逐条依据见 §5）。
5. 第 27 行 `name` 口径段（141 条：32/70/39）**未改**：`name` 总数复测仍是 141，S50 与本片都没有碰 `name`。
6. 四行读数在改动前后**逐字相同**（本片只改散文，不改台账：`contract-status.json` 零改动）。

## §1 改前原文（逐字，`76b0e86` 的第 23 行）

```
`node tools/verify-contract-status.mjs` 的证据校验分三层：**形状**（`checkEntry`：`path`/`test` 二选一、仓库内存在、`lines` 格式与文件行数内、`name` 与锚点文本在被引用文件里找得到）、**锚点**（`checkAnchors`：引用自带 `symbol` 或 `anchor` 时，锚点文本必须出现在引用行范围内，容差 ±2 行，覆盖 operations 与 dimensions；无锚点只计「不可核」并列可疑，不判红；所有带行号引用另量区间内容，整段仅空白/收尾行或首行为空行只计可疑不判红）与**语义**（`checkSemantics`：路由注册块与断言区间）。三层都只判「引用位置与操作身份可证伪地冲突」，不判定证据与操作的语义对应，也不与 owner、路由处理器、操作语义绑定；基线 `56042f7` 实测 409 条证据中 `symbol`/`anchor` 命中 0 条（141 条 `name` 只能证「文件里出现过」，268 条无锚点只计不可核），故锚点层目前只计数、尚无可核样本，语义上指错地方、指错操作的引用仍可能过门禁；工具首行与末行也自述「不证明语义正确、真实能力或整项验收」。下列边界与口径由证据校正片补记，供后续核对者沿用同一口径。
```

## §2 改后原文（逐字，本片 HEAD 的第 23 行）

```
`node tools/verify-contract-status.mjs` 的证据校验分三层：**形状**（`checkEntry`：`path`/`test` 二选一、仓库内存在、`lines` 格式与文件行数内、`name` 与锚点文本在被引用文件里找得到）、**锚点**（`checkAnchors`：引用自带 `symbol` 或 `anchor` 时，锚点文本必须出现在引用行范围内，容差 ±2 行，覆盖 operations 与 dimensions；无锚点只计「不可核」并列可疑，不判红；所有带行号引用另量区间内容，整段仅空白/收尾行或首行为空行只计可疑不判红）与**语义**（`checkSemantics`：路由注册块与断言区间）。三层都只判「引用位置与操作身份可证伪地冲突」，不判定证据与操作的语义对应，也不与 owner、路由处理器、操作语义绑定；基线 `56042f7` 实测 409 条证据中 `symbol`/`anchor` 命中 0 条（141 条 `name` 只能证「文件里出现过」，268 条无锚点只计不可核、「区间内」档恒 0）——这是**历史读数，不是现状**。R28-S50／[#362](https://github.com/GengYunChuChao/GengYun/pull/362)（squash `9cfd3e4`，合入 main 的 `b42d921`）已给 229 条纯行号引用逐条写入真实 `symbol`，锚点层「区间内」档由恒 0 变为 229 条真在跑；基线 `76b0e86` 实测（`node tools/verify-contract-status.mjs`，exit 0）为：证据锚点 370 条引用自带锚点（区间内 229 条 + 仅整文件 141 条），无锚点不可核 39 条（纯行号 0 + 无行号源文件 9 + 无用例名 30），合计仍是 409 条、未增删任何引用；余下 141 条只有 `name` 且无 `lines`，只能证明「该串在该文件里出现过」，进不了「区间内」档；工具口径的「纯行号区间」仍是 229 条（有实质内容 229 条；整段仅空白/收尾行 0 条、区间首行为空行 2 条，只计可疑不判红），该档量的是区间内容、与是否带锚点无关。**锚点边界不因这 229 条而放宽**：锚点只证明「该符号出现在该引用行区间内（容差 ±2 行）」，不证明证据与操作的语义对应，符号恰落在区间内而语义指错地方、指错操作的引用仍可能过门禁；本段在生成区（`contract-status-tables` 标记区）之外，`--write-doc` 只重生成表格、不重写本段，故只能人工维护；工具首行与末行也自述「不证明语义正确、真实能力或整项验收」。下列边界与口径由证据校正片补记，供后续核对者沿用同一口径。
```

改动粒度：`git diff --stat` 为 `1 file changed, 1 insertion(+), 1 deletion(-)`，`git diff -U0` 只有第 23 行这一处；第 22、24 行空行与 §0 其余三条 bullet 原样。

## §3 实测读数（`node tools/verify-contract-status.mjs`，exit 0）

基线 `76b0e86` + 本片散文改动，四行逐字：

```
PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
PASS: 语义可核 104 条区间 + 0 条片段；不可核 89 条区间 + 131 条片段（不可核不计入通过）
PASS: 证据锚点 370 条引用自带锚点（区间内 229 条 + 仅整文件 141 条）；无锚点不可核 39 条（纯行号 0 + 无行号源文件 9 + 无用例名 30），只计数不判红
PASS: 纯行号区间 229 条（有实质内容 229 条；整段仅空白/收尾行 0 条、区间首行为空行 2 条，只计可疑不判红）
```

另有三条同次输出：`WARN: 无锚点可疑引用前 5/39 条：…tests/integration/ocr-http.mjs`、`PASS: 中文表格一致`、`PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。`

独立复算（脚本直接读 `docs/architecture/contract-status.json`，**不复用**工具内部计数器）：

| 项 | 实测 | 与工具读数对照 |
| --- | --- | --- |
| 证据项总数 | 409（= 229 + 141 + 39） | 与两条读数的分项相加一致 |
| 带 `symbol` / `anchor` | 229（`symbol` 229 条、`anchor` 0 条；229 条全部有 `lines`） | = 「区间内 229 条」 |
| 只有 `name`（`test` + `name`，无 `lines`） | 141（有 `lines` 的 0 条，故只能落 `fileOnly`） | = 「仅整文件 141 条」 |
| 无锚点 | 39（无用例名 30 + 无行号源文件 9 + 纯行号 0） | = 「无锚点不可核 39 条」 |
| 229 条锚点覆盖的不同区间数（`path` + `lines` 组合去重） | 221 | 与 S50 证据页 §0.4 同值 |

**与派单的差异：无。** 派单 §2 的四行读数在本基线逐字复现。另有一条自洽校验：`56042f7` 的 268 条无锚点在 S50 之后变成 39 条（268 − 229 = 39），而 141 条 `name` 引用与「纯行号区间 229 条」两档在改动前后都未变——S50 只给既有引用加 `symbol` 键，没有增删任何引用，所以总数仍是 409。

## §4 为什么这段只能人工改

- `tools/verify-contract-status.mjs:276-291`：`--write-doc` 只做一件事——把 `replaceStatusTables(原文档, status)` 的结果写回 `DOCUMENT_FILE`；`replaceStatusTables` 只替换 `<!-- contract-status-tables:start -->` 与 `:end` 之间的表格。§0 在这对标记之外（标记在文档第 29 行），**不在任何生成链上**。
- 实测：本片改完后跑 `node tools/verify-contract-status.mjs --write-doc`（exit 0，输出 `PASS: 中文表格一致`），文件 SHA-256 前后同为 `A1EC05F0C3100B435035A2418670CDE6AA471FB7BFA91874E28B11AE1D6F5485`，`git status` 仍只有本片这一处修改 ⇒ 工具不会、也不能替人改这段。
- 因此这段叙述只能人工维护：数字变了要人工重测、人工改写、人工复核；工具只会在**表格漂移**时报红，对 §0 里的文字真假零鉴别力。
- 佐证：`tests/unit/contract-status-tool.test.mjs` 里有「真实台账 `--write-doc` 臂不改写文档」的用例，本片门禁 5 通过（29/29），说明「文档不被自动改写」本身是被测住的现状。

## §5 第 26 行「仍与实现一致」的核实（结论：一致，未改）

| 第 26 行的陈述 | 实现位置（`tools/verify-contract-status.mjs`） | 结论 |
| --- | --- | --- |
| 「`symbol`/`anchor` 在文件里根本不存在」会被拦 | `checkEntry` :142-148：`anchorSpec` 取到 `kind:'value'` 后 `!text.includes(anchor.value)` ⇒ `errors.push(...中找不到锚点...)`，属形状错误（exit 1） | 一致 |
| 「锚点存在但落在引用行范围外（±2 行，计语义错误）」 | `checkAnchors` :267-270：`hits.some(line => from - ANCHOR_TOLERANCE <= line && line <= to + ANCHOR_TOLERANCE)` 未命中 ⇒ `semanticErrors.push(...不在引用行范围内（容差 ±2 行…）)`；`ANCHOR_TOLERANCE = 2`（:33） | 一致 |
| 「`symbol` 与 `anchor` 同给且取值不同」会被拦 | `anchorSpec` :61-62 返回 `{ kind: 'conflict' }`，`checkEntry` :143 ⇒ `errors.push(...symbol 与 anchor 同给且取值不同，锚点必须唯一)` | 一致 |

两点补充（不构成第 26 行失实，故未改）：`checkAnchors` 同时覆盖 `operations` 与 `dimensions`（:273-274），第 26 行未限定范围；`--write-doc` 在存在语义错误时拒绝写盘（:284-286），与第 25 行记载一致。

## §6 未取得

- **未改任何判定逻辑**：`tools/`、`tests/`、`services/`、`apps/`、`packages/`、`migrations/`、`deploy/`、`.github/` 零改动；`git diff --name-only 76b0e86..HEAD` 只有本文件与本证据页。
- **未新增/删除任何 evidence 引用**：`docs/architecture/contract-status.json` 零改动。409 条证据、229 条锚点都是 S50 的既有事实，本片只复测、只写散文。
- **未处理 141 条 `name` 引用**：它们无 `lines`，进不了「区间内」档；要给它们补行区间属另一片工作（S50 证据页 §6 已列）。
- **未做语义抽查**：229 条锚点仍只证明「符号在区间内」，不证明语义对应；本片未抽查任何一条锚点的语义正确性，只订正口径。
- **未复核第 27 行的 32/70/39 三分**：141 条总数已复测未变；三分属 `name` 口径细分，派单明确不动，本片未触碰 `name` 字段。
- **未改第 3 行「更新：2026-10-16」**：本片没有重核整份台账，改那个日期等于冒充全量复核；§0 的现状读数已自带基线 `76b0e86` 标注。

## §7 门禁（全部在 `wt-r28-s53`，最终树）

| # | 命令 | exit | 关键读数 |
| --- | --- | --- | --- |
| 1 | `npm run lint` | 0 | `tsc --noEmit` 两份配置 PASS、仓库卫生扫描 PASS、`lint 通过` |
| 2 | `npm run test:docs` | 0 | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住`；`PASS docs/research 结构校验` |
| 3 | `node tools/verify-contract-status.mjs` | 0 | 见 §3 四行 |
| 4 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | `tests 6 / pass 6 / fail 0` |
| 5 | `node --test --test-concurrency=1 tests/unit/contract-status-tool.test.mjs tests/unit/contract-status-anchors.test.mjs` | 0 | `tests 29 / pass 29 / fail 0` |
| 6 | `git diff --check` | 0 | 无输出 |

加测（不在派单六条内，因与本段直接相关）：`node --test --test-concurrency=1 tests/unit/ci-contract-status-gate.test.mjs` exit 0，`tests 5 / pass 5`——钉住 CI 真跑校验器那一步，与本片口径无冲突。

## §8 偏差

- 派单写「作者署名 `dsh-r28-writer <dsh-r28-writer@local>`（本树 `git config` 已是该值，勿改）」；**实测本树不是该值**：`git config --show-origin user.name` 为 `adv-3ee16ebe`、`user.email` 为 `adv-3ee16ebe@local`，来源 `file:E:/GengYunCommander/GengYun_Agent2/.git/config`（worktree 共用主仓配置）。按红线「不改 git config」，提交改用 `git -c user.name=dsh-r28-writer -c user.email=dsh-r28-writer@local commit` 临时指定，**未写任何配置文件**；作者与提交者仍为 `dsh-r28-writer`。
- 其余无偏差：四行读数与派单逐字一致，六条门禁全为 exit 0，`git diff --check` 无输出。
