# 注释锚点闸门：把「位移」与「真新增」分开判（R90，2026-11-09）

> 读数快照：2026-11-09（Asia/Hong_Kong）。本分支 base `origin/main` `3ea5792554c8e675208dcdb8349ef6bca2cbd39d`（派单时的 main 是 `a4183da6`；此后 `#1134` 又合入一页，本页读数已在 `3ea57925` 上重测）。
> 改动面：`tools/verify-verification-comment-anchors.mjs`（判定面：新增位移配对、区间证据行、逐条 FAIL 落点）、`tests/unit/verification-comment-anchor-relocation.test.mjs`（新增 R1/R2/R3 三条用例）、`docs/verification/gy-r90-comment-anchor-gate-wiring-20261109.md`（第 19/20 行耗时读数与第 99 行位移结论按实测改写）、`docs/verification/gy-r90-verification-comment-anchor-guard-20261109.md`（工具行号引用刷新）。
> **基线 JSON 没有重写**：`tools/verification-comment-anchor-baseline.json` 的 `version` / `scope` / `accepted` / `why` 与条目字段（`doc,line,target,from,to,kind`）逐字未动，`entries` 仍是 1422 条。

## 一、事故：在锚点上方插一行散文，45 条锚点集体变「新增」

旧判定的键是 `baselineKey` = `doc|line|target|from` 四元组，**文档行号直接编进键**；`evaluateCommentAnchorGate` 用「当前键集合 − 基线键集合」算新增。文档里任何一行插删，都会让该页**所有**锚点的 `line` 变号 ⇒ 整页锚点同时变成「基线外新增」，而 `--require-no-new` 默认开 ⇒ EXIT 1。

真页复现（`docs/verification/gy-r28-contract-line-anchors-20261021.md`，基线里 45 条锚点，全部是区间锚点）：在第 10 行插入一行无关散文，锚点语义零变化。

```text
# 修前（origin/main 版工具，同一夹具）
VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 45、基线 45、基线外新增 45、可收紧 45（--require-no-new=on、--require-no-stale=off）
VERIFICATION-COMMENT-ANCHOR-FAIL: 基线外新增 45 条注释锚点（见上面的 NEW 行）——要么把锚点改到实质行，要么显式 --write-baseline 登记并写明理由
[EXIT 1]

# 修后（本分支，同一夹具、同一行插入）
VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 45、基线 45、基线外新增 0、可收紧 0（--require-no-new=on、--require-no-stale=off）
VERIFICATION-COMMENT-ANCHOR-RELOCATED: RELOCATED 45 条（同一身份 doc|target|from、文档行号变化；默认只告警、不判红）
[EXIT 0]
```

复现步骤（全部在临时根里做，不动交付树；`tests/unit/verification-comment-anchor-relocation.test.mjs` 的 `stageWitnessRoot` 就是这个夹具）：

```text
1. 从基线 JSON 过滤出 doc == 目标页的 45 条，按 target 复制那 19 个真源文件到临时根（保持相对路径）；
2. 把真页原文复制到临时根的同一相对路径，基线写到 <临时根>/tools/test-baseline.json；
3. 在临时页第 10 行插一行散文；
4. node tools/verify-verification-comment-anchors.mjs --root <临时根> --baseline tools/test-baseline.json
```

后果（为什么必须修）：全仓 200/373 篇验证页带锚点，任何 docs PR 只要在锚点上方插删一行就红；补救只能 `--write-baseline` 重写整份基线，而 `tools/**` 属 B 档（`docs/pr-review-policy.md` §3），常规文档改动因此被拖离 A 档自合并通道。

## 二、配对规则：身份 / 位置 / 多重集

判定的第一步不再是「键在不在集合里」，而是**先按身份配对、再看位置**：

- **身份** `identityKey(entry)` = `doc|target|from|kindClass`，其中 `kindClass` 只分 `comment` / `code` 两类（`kind === null` 记 `code`；区间锚点的 `range-covers-code` 仍归 `comment`，因为「是否算注释锚点」仍按 `from` 判）。**文档行号不在身份里。**
- **位置** = `entry.line`，即锚点在文档里的行号。
- **多重集**：同一身份可以出现多次（两行文档引用同一目标的同一行），所以按 `identityKey` 分组后按**重数**配对，不能拿 `Set` 去重。

```text
for 每个身份（基线侧 ∪ 当前侧的并集）:
  组内先配文档行号相同的        → SAME       （不打印，只计数）
  两侧剩下的按行号排序，各取前 min(重数) 配  → RELOCATED  （新分类，默认只告警）
  当前侧还剩下的重数            → NEW        （承重判据：仍然 --require-no-new 判红）
  基线侧还剩下的重数            → STALE      （现状：默认 WARN，--require-no-stale 可改判红）
```

关键点三条：

1. **NEW 没有降级**。身份在本侧找不到基线条目才是 NEW，仍走原来的 `-FAIL` + EXIT 1；位移只吃掉「同身份、不同文档行」的那部分。
2. **STALE 让位给 RELOCATED**。能被配对掉的基线条目记 RELOCATED，不再落进 `可收紧`；只有真配不上的（删了锚点、改了 target/from、目标已不是注释行）才 STALE。这也是「删掉两条重复锚点里的一条」只消一条、不吞另一条的原因——按重数配对，剩下的重数才算 STALE。
3. **输出行兼容**。`本次命中 N / 基线 M / 基线外新增 X / 可收紧 Y` 那一行**逐字未变**（测试与既有证据页都在 grep 它），新增读数另起两行：`-RELOCATED:` 与 `-RANGE:`。

## 三、三条验证的红/绿原文

用例文件 `tests/unit/verification-comment-anchor-relocation.test.mjs`，每个用例都在隔离临时根里跑（只复制该页 + 它引用的 19 个真源文件 + 过滤后的 45 条基线），不与真仓基线抢同一棵树。

### R1 位移不红（正控制）

真页 45 条锚点上方插一行散文 ⇒ EXIT 0、`RELOCATED 45`、`基线外新增 0`。

```text
✔ R1 锚点上方插一行散文：45 条配对成 RELOCATED，EXIT 0 且基线外新增 0 (431.9ms)
VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 45、基线 45、基线外新增 0、可收紧 0（--require-no-new=on、--require-no-stale=off）
VERIFICATION-COMMENT-ANCHOR-RELOCATED: RELOCATED 45 条（同一身份 doc|target|from、文档行号变化；默认只告警、不判红）
RELOCATED docs/verification/gy-r28-contract-line-anchors-20261021.md:109 -> services/api/src/profile/service.ts:72-104  （位移：基线文档行 108 → 109）（区间证据行 77）async function speciesDirectory(client: PoolClient): Promise<CatalogItem[]> {
[EXIT 0]
```

同一条用例还钉住：插行**前**是 `RELOCATED 0`；插行后没有 `NEW` 行、没有 `STALE` 行、`RELOCATED` 行逐条打印 45 条、每行都写清「基线文档行 A → B」且 B = A + 1。

### R2 真新增仍红（负控制，修完之后仍必须红）

同一夹具里追加一条指向**注释行**的锚点（工具里最后一条行注释）⇒ EXIT 1，且 FAIL 文案逐条点名到 `doc:line -> target:line`。

```text
✖ / ✔ R2 新增一条指向注释行的锚点：仍然 EXIT 1，并逐条点名
VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 46、基线 45、基线外新增 1、可收紧 0（--require-no-new=on、--require-no-stale=off）
VERIFICATION-COMMENT-ANCHOR-RELOCATED: RELOCATED 0 条（同一身份 doc|target|from、文档行号变化；默认只告警、不判红）
NEW  docs/verification/gy-r28-contract-line-anchors-20261021.md:425 -> tools/verify-verification-comment-anchors.mjs:557  // 新增读数另起一行（上面 -GATE 行的格式被测试与证据页 grep，逐字不动）。
VERIFICATION-COMMENT-ANCHOR-FAIL: 基线外新增 1 条注释锚点（见上面的 NEW 行）——要么把锚点改到实质行，要么显式 --write-baseline 登记并写明理由
VERIFICATION-COMMENT-ANCHOR-FAIL-ENTRY: docs/verification/gy-r28-contract-line-anchors-20261021.md:425 -> tools/verify-verification-comment-anchors.mjs:557（kind=line-comment；登记落点：doc/line/target/from 四字段）
[EXIT 1]
```

### R3 多重集不串号（多重集负控制）

同一 `(docPath, targetPath, targetLine)` 被文档两行引用（身份完全相同）。删掉其中一条：只能消掉一条，另一条仍是 SAME。

```text
✔ R3 两行引用同一目标行：删一条只消一条，不吞另一条

# 两条都在、删掉第二条之后
VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 1、基线 2、基线外新增 0、可收紧 1（--require-no-new=on、--require-no-stale=off）
VERIFICATION-COMMENT-ANCHOR-RELOCATED: RELOCATED 0 条（同一身份 doc|target|from、文档行号变化；默认只告警、不判红）
WARN docs/verification/reloc-multiplicity.md:3 -> src/multi.mjs:5  // 目标行：下面两行文档锚点都指向这里
STALE docs/verification/reloc-multiplicity.md:4 -> src/multi.mjs:5 （可收紧基线：目标行仍是注释行（基线文档行 4 未配到同身份条目：锚点可能已删/改编，或目标行位移后仍无法配对）；确认后跑 --write-baseline 收册）
[EXIT 0]

# 同一条再插一行把两条一起下移：应两条都位移，不该一配一漏
VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 2、基线 2、基线外新增 0、可收紧 0（--require-no-new=on、--require-no-stale=off）
VERIFICATION-COMMENT-ANCHOR-RELOCATED: RELOCATED 2 条（同一身份 doc|target|from、文档行号变化；默认只告警、不判红）
[EXIT 0]
```

（上例 STALE 的判据是「同一身份组里没有可配的文档行了」：基线里两条同身份条目、当前只剩一条，多出来的那条走 `describeStale()` 的「目标行仍是注释行」分支——它说的是「锚点可能已删/改编」，不是「文档已不存在」（文档文件仍在，同次输出里那条 WARN 就来自它，文档第 3 行）。「文档已不存在」只在整篇文档被删时才出现。）

## 四、整仓读数：只改标签与配对，不改收集面

同一棵树、同一基线，修前（`3ea57925` 版工具，用 `git show 3ea57925:tools/verify-verification-comment-anchors.mjs` 另存到 `tools/` 下运行）与修后（本分支当前判定面）的收集面**逐字相同**：

```text
VERIFICATION-COMMENT-ANCHOR: candidates=9582 comment=1422 code=7214 blank=138 out-of-range=16 unresolved=284 fenced=501 duplicate=7
VERIFICATION-COMMENT-ANCHOR-SCOPE: docs/verification/**/*.md documents=373 （unresolved 中 ambiguous=284）

# 修前版工具没有下面两行；修后多出这两行读数
VERIFICATION-COMMENT-ANCHOR-RELOCATED: RELOCATED 0 条（同一身份 doc|target|from、文档行号变化；默认只告警、不判红）
VERIFICATION-COMMENT-ANCHOR-RANGE: 区间锚点 679 条，其中窗口内有行为行 403 条（kind=range-covers-code；行上标注「区间证据行」）
```

- 上面那两行是 2026-11-09 在 **base `3ea57925`** 的树上重测的：修前版工具与修后版工具打出**同一行计数**（`comment=1422`、`code=7214`、`blank=138`、`out-of-range=16`、`unresolved=284`、`fenced=501`、`duplicate=7`、`documents=373` 两侧一致）。
- 本页首版（提交 `1807cf32`）写的 `candidates=9529 code=7169 blank=139 unresolved=285 documents=372` 是 `a4183da6` 上的旧树读数，已作废：`#1134` 在 `a4183da6` 之后又合入一页（200/371 → 200/373），候选数随之 9529 → 9582。
- `RELOCATED 0` 是真仓的现状：基线里 1422 条与当前 1422 条同身份、同文档行，全部 SAME。
- 真仓 `-GATE` 行仍是 `本次命中 1422、基线 1422、基线外新增 0、可收紧 0`，EXIT 0；修前版工具在同一棵树上也是这一行。
- 收集面在修前修后一致，说明这次改的是**配对与标签**，不是「少收一点让它变绿」。

## 五、随修的三条 P2 与两处复审小修

1. **FAIL 文案有 per-entry 落点**：`-FAIL` 之后逐条打 `-FAIL-ENTRY: doc:line -> target:range（kind=…；登记落点：doc/line/target/from 四字段）`（上限 100 条，超出再打一行汇总），直接告诉人「是哪一条、该往基线 JSON 的哪四个字段登记」，不再是只有一句「登记并写明理由」。
2. **区间锚点按窗口内首个行为行判 kind**：`services/api/src/community/service.ts` 的 1337–1342 行这种区间，`1337` 可能只是注释而证据在 `1338`；现在 `findRangeEvidenceLine` 取窗口内**首个非空且非注释**的行作为证据行（`evidenceFrom`），并把 `kind` 标成 `range-covers-code`、WARN 行后缀「（区间证据行 N）」、正文引用证据行原文。**仍然按 `from` 决定是否计入注释锚点**——这一点是刻意的：若把「窗口含代码行」的区间锚点整体踢出判定面，实测 679 条区间锚点里 403 条会消失（目标页 45 → 11），等于变相放宽判定 + 逼着重写整份基线，与「不许整份基线重写」「NEW 仍判红」都冲突。
3. **耗时读数改成实测**：见 `docs/verification/gy-r90-comment-anchor-gate-wiring-20261109.md` 第 19/20 行（整道闸门 3.5–3.9 s / 5 次，整份 on-repo 测试 4.6–5.0 s / 3 次；机器 Windows 11 10.0.26200、Intel i7-12650H 10C16T、Node v24.16.0；规模 `documents=373`、`comment=1422`）。
4. **第二轮审查的两处小修**：`renderBaseline()` 写盘时把判定期的 `range-covers-code` 还原成真实注释 kind（`commentKind`，采集时随每条锚点一起记下），否则下一次 `--write-baseline` 会把 403 条区间锚点的 `kind` 改名、与 `docs/verification/gy-r90-verification-comment-anchor-guard-20261109.md` 公布的直方图冲突；`identityKey()` 里恒假的 `|| undefined` 分支已删（`kind == null` 显式判）。两条分别由 R4 与 §六 末两条钉住。

## 六、不声称

- **不声称覆盖 `docs/architecture/**`**：那是 `verify-doc-anchors.mjs` 的 `--symbol` 面；本闸门只扫 `docs/verification/**/*.md`。
- **不声称能识别「锚点语义变了但行号没变」**：位移配对只看 `(doc, target, from, kindClass)` 与文档行号。目标文件里被引用的那行注释被换成另一句、行号没动，仍然算 SAME——它有可能是错的证据，本工具不判。反过来，锚点的 `target`/`from` 被改动、或目标行从注释变成代码，都不会被当成位移（前者 NEW、后者 STALE）。
- 不声称 `RELOCATED` 等于「锚点正确」：它只说明「同一身份换了文档行号」，不说明证据仍然支持结论。
- 不声称改了 `--write-baseline` / `--require-no-stale` 的语义，也不声称改了基线 JSON 的字段结构：`--write-baseline` 仍是唯一写盘入口，`--require-no-stale` 仍缺省关。
- 不声称本页的绝对读数可跨树复现：命中数随树变化，耗时随机器变化；能复现的是「同一夹具下修前 45 条新增 / 修后 45 条位移」这个对照。
- 不声称多重集配对能识别「删一条、又在别处补一条同身份」：条目净数不变时它会判 `RELOCATED 1`、NEW 0、EXIT 0（实测：两行同身份夹具删掉第 4 行、再在页内另加一行同 `(doc,target,from)` 的锚点 ⇒ `本次命中 2、基线 2、基线外新增 0、可收紧 0`、`RELOCATED 1`、EXIT 0）。危害低（条数没少），但语义上是「换了一条」而不是「挪了一条」。
- 不声称身份键能看见区间长度：`to` 不在身份里 ⇒ 已登记的单行锚点改成任意长区间仍判 SAME（实测：基线登记目标文件 `src/multi.mjs` 的第 5 行，页内把该锚点改成 5–6 行区间、5–8 行区间，都是 `本次命中 1、基线 1、基线外新增 0、可收紧 0`、`RELOCATED 0`、EXIT 0，只有 WARN 行的区间后缀变化）。要让区间长度也进身份，得升基线版本号。
- 不声称 `--write-baseline` 会写出 `range-covers-code`：基线 JSON 只登记「这条算哪种注释」（`commentKind`），`range-covers-code` 只是判定期的证据行标签。实测把 5–8 行区间写盘得到 `kind=line-comment`，复跑 EXIT 0——因此 403 条区间锚点不会被下一次 `--write-baseline` 改掉 `kind` 直方图。
- 不声称位移配对能替代人工复核：它只把「文档行号漂移」从红里摘出来，锚点本身对不对仍要人看。

## 七、运行方式

```text
node --test tests/unit/verification-comment-anchor-relocation.test.mjs   # 4/4 pass（R1/R2/R3/R4）
node tools/verify-verification-comment-anchors.mjs                      # 真仓读数：1422/1422/0/0，EXIT 0
node tools/verify-verification-comment-anchors.mjs --require-no-stale    # 语义未变：可收紧条目才判红
```
