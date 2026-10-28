# GY-R68 D09b：s4 错锚收尾与文档锚点复测（2026-10-28）

本页是本轮自己写的**核对证据**（不是历史取证页）：记录 base `de2aa3c6`（`upstream/main` 当时 tip）上
`docs/architecture/s4-data-traceability.md` 那几处 `app.ts` 错号的收尾依据，以及同一批闸门在收尾后的读数。
范围只有 A 档 docs、工具注释与其登记表：不动 `services/api/**`、`packages/contracts/openapi.json`、`apps/**`。

## 1. 六处引用逐条给行原文

取证命令：`git show de2aa3c6:services/api/src/app.ts`（全文 2695 行）与
`git grep -n "available: config.executionMode" de2aa3c6 -- services/api/src/app.ts`。

| 行 | 原文 | 说明 |
| --- | --- | --- |
| `services/api/src/app.ts:2076` | `          ) => messagesPurgeSnapshot(ownerId, client),` | 旧锚点（186/342/366/368）都落在这里：messages 清理快照的 store 回调，与「注销可用性门」「第三方读侧装配」都无关 |
| `services/api/src/app.ts:2257` | `    available: config.executionMode !== 'real',` | 注销可用性门的符号本体；`git grep` 显示这句在整个 `app.ts` 里**只出现 1 行**（2257） |
| `services/api/src/app.ts:2255` | `    deletion: userDataDeletion,` | 2257 的上两行：2257 确实落在注销/回执这套装配对象内部 |
| `services/api/src/app.ts:2256` | `    receipts: deletionReceipts,` | 同上 |
| `services/api/src/app.ts:1998` | `  const thirdPartyWiring: { thirdParty?: ThirdPartyDeletionReadPort } =` | 第三方读侧端口的装配点；同一符号在 2227 `    ...thirdPartyWiring,` 展开进注销装配、2550 `    thirdPartyRows: thirdPartyWiring.thirdParty ?? null,` 落到注销状态读数 |
| `services/api/src/app.ts:2058-2065` | 2058 `  const messagesPurgeCounts = messagesStore.purgeOwnerData?.bind(messagesStore);` … 2065 `      return messagesPurgeDelete(ownerId);` | 187 行的旧锚点落在这里：messages 清理 store 的方法绑定与 `deleteAllByOwner` 实现，没有一句讲「real 模式整域不接线」，是**出生即错**（不是漂移） |
| `services/api/src/app.ts` 第 2078 行 | `  };` | 188 行的旧锚点落在这里：`messagesDeletionStore` 字面量的收尾括号，什么也没自陈（故意不写成 `路径:行号` 形式——这类"整段只有右括号"的位置会被结构闸门判 SUSPECT，而它本来就是错锚，不该被登记成一条基线） |
| `services/api/src/app.ts:2239-2246` | 2239 `  //   - 执行模式门（本片红线「真实依赖缺失 ⇒ 如实失败/503」）：`real` 模式**整域不接线**` / 2241 `  //     因此**不接线**：`available: false` ⇒ 两个 operation 一律 503 `PROVIDER_UNAVAILABLE`` / 2242 `  //     （`retryable: false`），**不**回 200 空壳、**不**假装删除成功。` | 187 行讲的「注释明写：real 整域不接线、两个 operation 一律 503 `PROVIDER_UNAVAILABLE`、`retryable: false`」逐字就是这一段 |
| `services/api/src/app.ts:2259` | `    // ⚠ 可达性（实测）：本项注入门是「real ⇒ 有」（见上方 `egressRevoker` 装配），`available`（real ⇒ false）与之**互斥** ⇒ real 下 `requireWired()` 先 503、非 real 装配期不建撤销器 ⇒ **两条路都到不了这里**（仅 `privacyInjection` 测试注入可达）；…` | 188 行讲的「外发撤销器与 `available` 门互斥、两条路都到不了这里（仅测试注入可达）」逐字就是这一行 |

结论：186/342/366 指的符号是 `available: config.executionMode !== 'real'`，在 base 树上唯一落在 2257；
368（D13）讲第三方读侧装配，落 1998；187 讲的是「执行模式门」那段注释，落 2239-2246；188 讲的是「外发撤销器
与 `available` 门互斥」的实测说明，落 2259。六个新值都是**按符号与行原文逐条判**出来的，不是「旧值加偏移」的平移。

一条被推翻的旧说法（对抗审查 B1）：工具里那条旧注记「实际在 `services/api/src/app.ts:2221`」**不是出生即错**。
实测 `1a8af906`（`app.ts` 2659 行）的第 2221 行正是 `    available: config.executionMode !== 'real',`，且该片段
在该文件唯一命中 2221；到 base `de2aa3c6`（2695 行）相对那棵树 **+36 行**之后才漂到 2257 —— 它是**曾经正确、
随 +36 行漂移失效**。本片早前把它写成「当时就错」，已按此改正（工具表头注释、本页 §1、§4 三处一并改口）。
（base 的 2221 现在是 `    now: clock,`，那是应用时钟装配，跟注销门无关——这只是「现在不是」，不是「当时就不是」。）

## 2. s4 页六处改动（行内替换，未增删整行）

| 文档行 | 改前指向 | 改后指向 | 该行指的符号 |
| --- | --- | --- | --- |
| 186 | `services/api/src/app.ts:2076` | `services/api/src/app.ts:2257` | `available: config.executionMode !== 'real'`（注销可用性门） |
| 187 | `:2058-2065` | `:2239-2246` | 「real 模式整域不接线 ⇒ 两个 operation 一律 503 `PROVIDER_UNAVAILABLE`、`retryable: false`」那段注释 |
| 188 | `:2078` | `:2259` | 「`egressRevoker` 注入门与 `available` 门互斥 ⇒ 两条路都到不了这里（仅测试注入可达）」 |
| 342 | `services/api/src/app.ts:2076` | `services/api/src/app.ts:2257` | 同上（E1「真实模式下注销整域 503」的可复算落点） |
| 366 | `services/api/src/app.ts:2076` | `services/api/src/app.ts:2257` | 同上（D08 升档判据落点） |
| 368 | `services/api/src/app.ts:2076` | `services/api/src/app.ts:1998` | `const thirdPartyWiring: { thirdParty?: ThirdPartyDeletionReadPort } =`（D13 第三方读侧装配） |

187/188 是相对引用（路径沿用同段 186 行的 `services/api/src/app.ts`），与页内 183 行
`` `…user-data-deletion.ts:164-169`、`:202-207` `` 是同一种写法。本片那条内容提交（`HEAD^1`）自己相对父
`de2aa3c6` 的行数是 **389 → 389**（`git diff --numstat` 为 `6 6`，六行原地替换，没有新增/删除整行），
所以被行号钉住的引用（`docs/verification/gy-r67-docs-pins-20261027.md:106`）不会因为那次改动移位。
**并入 `#706` 之后整页是 391 行**（`git show HEAD:该路径` 按 `split('\n')` 计是 392，末尾空行占 1）；
本页下面所有 s4 行号与读数都按合并后的树报。

上表行号是**本片第一个提交相对 base `de2aa3c6` 的编号**。并入 `#706`（C5 复核）之后，`#706` 在本页前文
插了一行，D08 与 D13 各下移一行：`366 → 367`、`368 → 369`；186/187/188/342 不动。合并后的登记表条目与
doc 行号按合并后的树重新核过（见 §3 与 §8）。

## 3. 登记表：186/342/366/368 必须登记，187/188 登记不了（闸门的盲区）

`services/api/src/app.ts` 本提交一个字都没改，而文档里的行号变了 —— 这正是
`tests/unit/doc-anchor-relocation-identity.test.mjs` 的判定面：「目标文件本提交未改动 ⇒ 行号必须恒等」。
不登记时的红原文（本片实测，改动前跑过）：

```
docs/architecture/s4-data-traceability.md:186 ⟨services/api/src/app.ts :2076 → :2257⟩ 目标文件本提交未改动 ⇒
行号必须恒等，但被改成 :2257（真要把陈旧锚点改到正确行号，必须在 tests/unit/doc-anchor-relocations.json 里
登记 doc/line/target/from/to/reason）
旧行原文（services/api/src/app.ts:2076）："          ) => messagesPurgeSnapshot(ownerId, client),"
新行实际（services/api/src/app.ts:2257）："    available: config.executionMode !== 'real',"
```

因此在 `tests/unit/doc-anchor-relocations.json` 追加 4 条（59 → 63 条，只追加不改旧条目）：
`186/342/366` 登记 `2076 → 2257`、`368` 登记 `2076 → 1998`，每条 `reason` 都写「旧行是什么符号 / 新行是什么符号 /
为什么旧的是错的」。这条用例的口径只接受这种登记，不接受改 `services/api/**` 来迁就文档。

并入 `#706` 后登记表按**并集**收（两侧条目一条不丢），同一处修正只留一条：`#706` 也把 D13 登成
`2076 → 1998`（它登在 369，本片登在 368，是同一处纠正）。合并后 D13 落在 **369** ⇒ 保留 `#706` 那条、
删掉本片重复的那条；本片 D08 那条的 `line` 由 366 改为 **367**。最终 **67 条**（59 历史保留 + `#706` 的 5 条 +
本片的 3 条 186/342/367），按 `(doc, line, target, from, to)` 自证无重复。

187/188 登记不了，原因是工具把裸 `:行号` 归到**当前文档自己**（`docs/architecture/s4-data-traceability.md`），
而该页只有 391 行（工具的分母写 392，按 `split('\n')` 计、含末尾空行）⇒ 这两条落进「行号越界、未判」桶，
既不算判红也不算判绿：

```
docs/architecture/s4-data-traceability.md:187 ⟨docs/architecture/s4-data-traceability.md⟩ 行号越界（旧 2058/392、新 2239/392），未判
docs/architecture/s4-data-traceability.md:188 ⟨docs/architecture/s4-data-traceability.md⟩ 行号越界（旧 2078/392、新 2259/392），未判
```

（上面两行是合并后在 `HEAD` 上跑出来的原文，可直接复现。）

这是工具的已知盲区（页内相对引用没有解析到真正的目标文件），本片不为此改判据。试过把这两处写成显式路径
`services/api/src/app.ts:2239-2246`：结构基线 13 条与漂移基线 15 条都不动，但 `--symbol=strict` 的
`COMMENT_ANCHOR` 会**基线外新增 1 条**（2239/2259 是注释行、不是文档注释）⇒ 门禁 exit 1，等于为了看得见而
动基线，所以退回页内既有写法的相对引用。

## 4. 漂移基线的连带处理

`tools/verify-doc-anchors.mjs` 的 `ARCHITECTURE_ANCHOR_BASELINE` 里原来登记了

```
docs/architecture/s4-data-traceability.md:186#available: config.executionMode !== 'real'
```

这条登记的就是**修好前的漂移**（同一行里既写了 `2076`，又用行内代码 `available: config.executionMode !== 'real'`
做指纹，工具据此判 ANCHOR_DRIFT）。本片把页面上的引用改成真实落点 2257 之后，这条 key 再也命中不了。
删它的理由要写准：**不是闸门硬要求**——实测把它加回去，`--strict` 仍然 exit 0，只是多打一行 `STALE-DRIFT`
（陈旧漂移条目不进 exit code，与结构基线的陈旧条目同语义）。删它是为了**不留一条永远命不中的假基线**，
并顺手把表头注释里「实际在 :2221」这条注记的来龙去脉写对（它当年正确、随 +36 行漂移失效，见 §1）。
删条只动登记表：判据逻辑与漂移窗口（`ANCHOR_DRIFT_WINDOW = 2`）一个字没改。

## 5. 复测读数（合并 `#706` 之后、工作区干净的状态下跑，命令原样）

| 命令 | 读数 |
| --- | --- |
| `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | exit 0；结构基线 `登记 13 条；命中 13、新增 0、陈旧 0`；漂移基线 `登记 15 条；命中 15、新增 0、陈旧 0`；符号基线 `登记 28 条；命中 28、新增 0、陈旧 0`；`PASS: --strict 下没有基线之外的新增` |
| `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | exit 0；tests 31 / pass 31 / fail 0；`base=578e7e30`（merge-base HEAD origin/main）、`docLines=6 tokens=6 pairs=6`、`registered=3 carried=64 removed=0 unresolved=2`（unresolved 是上面 187/188 的「未判」，不判红）；登记表 67 条 |
| `node --test "tests/unit/doc-anchor*.test.mjs"` | exit 0；tests 80 / pass 80 / fail 0 |
| `node --test "tests/unit/*anchor*" tests/unit/s4-data-gap-pins.test.mjs tests/unit/verify-anchors-script.test.mjs` | exit 0；tests 142 / pass 142 / fail 0 |
| `node --test tests/unit/doc-anchors-symbol-baseline-fresh.test.mjs tests/unit/doc-anchors-symbol-strict.test.mjs tests/unit/doc-anchors-symbol-count.test.mjs tests/unit/doc-anchors-symbol-line.test.mjs`（符号基线新鲜度那组） | exit 0；tests 39 / pass 39 / fail 0 |
| `node tools/verify-contract-status.mjs` | exit 0（台账自证 PASS，含「状态为人工判定」那条免责） |
| `npm run verify:parity` | exit 0（`extra` / `missing` / `ledgerDrift` 均空） |
| `node --test tests/unit/docs-truth-pins.test.mjs` | exit 0；tests 9 / pass 9 / fail 0 |

## 6. 与 c5 那页历史读数的关系

`docs/verification/gy-r68-s4-recheck-20261028.md` §4 里 `node --test "tests/unit/doc-anchor*.test.mjs"` 的
`exit 1 / tests 54 / pass 53 / fail 1` 是 `9b29bd08` 时刻的读数（那页在 base `de2aa3c6` 上还没合入），
本页不是改写它，而是在**base 前移 + #708 新增 26 例**之后的复测：同一命令现在 80 例全绿，
原来那条 ai-ops 红例已转入「历史保留」档。两页并存：旧页记当时的读数，本页记复测的读数。
D13 那一行的 1998 与 c5 页给出的 `2076 → 1998` 是同一个判断（c5 页未改我树上的这一行，本片只对齐结论）。

## 7. 本片明显没做的事

- 没有改 `services/api/**`、`apps/**`、`.github/**`、迁移、`packages/contracts/openapi.json`（行号坐标系正被别的片改）。
- 没有动 `docs/verification/gy-r67-docs-pins-20261027.md` 等历史页：它们记的是当时那棵树的读数，改了就不叫历史了。
- 没改 `tools/verify-doc-anchors.mjs` 的任何判据逻辑：只删了一条已失效的漂移登记、改了一段表头注释。
- s4 页 342/367 两处只有「路径:行号」、没有行内指纹片段，`ANCHOR_DRIFT` 判据（要求同一行另有行内代码指纹）
  对它们**不判红也不判绿**（落「无行内代码片段跳过」桶）；369（D13）虽有行内片段，但按 ±2 窗口对不上，
  落 ambiguous 桶、同样只计数不判红。所以这三处（342/367/369）都属人工复核修正，没有自动闸门兜底。
  186 那处原来是 `ANCHOR_DRIFT` 真正抓到的漂移（`actualLine 2257`、`suggestion services/api/src/app.ts:2257`），
  改对后它从 findings 里消失、转入 green：在 `HEAD` 上复算 `collectAnchorDrift({ root, targets: ['docs'] })`
  得 15 条 finding、**s4 页 0 条**，`stats = {documents:17, referenceLines:533, skipped:499, green:13, ambiguous:6}`。
  `tests/unit/doc-anchor-relocation-identity.test.mjs` 这**3 条**（186/342/367）都抓到了。
- s4 页 187/188 两道闸门都看不见（详见 §3 的「未判」读数与显式路径试验），它们的正确性只由本页的行原文比对兜着。

## 8. 与 `#706`（C5 s4 D 轴复核）合并后的状态

本片是两个提交：先 `docs(s4)`（相对 base `de2aa3c6`），再 `merge upstream/main`（并入 `578e7e30`，#706）。
另起 worktree 的指针：`git log --oneline -2` 能看到 `merge:` 与 `docs(s4):` 两条，`HEAD^1` 是本片那条、
`HEAD^2` 是 `578e7e30`。

合并后 s4 页（相对 `upstream/main` 逐行核过）：
- 全文 `2076` **零命中**（`git grep` 与逐行扫描都是 0 行）。
- `available: config.executionMode !== 'real'` 的落点 2257 在 186 / 265 / 313 / 342 / 367 五行上被引用，与 `app.ts` 一致。
- 第三方读侧装配 1998 在 55 / 82 / 249 / 261 / 262 / 312 / 369 上被引用（其中 369 就是 D13 行）。
- 相对 `upstream/main` 的 `git diff --numstat` 仍是 `6 6`（六行原地替换：186/187/188/342/367 的落点号 + 369 的 D13 判据措辞）。
- 登记表最终 67 条，`(doc, line, target, from, to)` 无重复（同一处修正只有一条）。

