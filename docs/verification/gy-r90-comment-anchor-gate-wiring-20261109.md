# 注释锚点影子闸门接线到单元测试（R90，2026-11-09）

> 读数快照：2026-11-09（Asia/Hong_Kong），本分支 base `origin/main` `a40fba6cacef43b2c746f90f6f1d89484fa34c14`（此前一版读数取自 `a30c8adb`；两者在本页引用的计数上逐字相同：命中 1422、基线 1422、`documents=371`，加了 `#1135` 那页后只有 `candidates` 从 9382 变 9387）。本片只做一件事：给 `tools/verify-verification-comment-anchors.mjs` 补一条**在真仓上跑整道闸门**的单元测试，让它从「有工具、没接线」变成「CI 里真的会红」。工具口径、1422 条基线的构成、逐条收紧路径见 `docs/verification/gy-r90-verification-comment-anchor-guard-20261109.md` 与 `docs/verification/gy-r90-comment-anchor-rebaseline-20261109.md`，本页不重复，也不改那些结论。

## 一、为什么需要：工具在，但没有任何作业在真仓上跑它

- 闸门工具自 `#1119` 起在 main 上，专门抓 `docs/verification/**` 里「把注释行当行为证据」的锚点（`path:line` 落在注释行 ⇒ 记一条）。
- 它此前**唯一**的测试是 `tests/unit/verify-verification-comment-anchors.test.mjs`：6 个用例全部在系统临时目录造夹具、直接调 `main()`。夹具覆盖了工具的判定分支，但**从来不扫真仓**——真仓上这条通道没有任何作业代跑。
- 于是「工具红」与「CI 绿」可以同时成立：`#1133` 之前，`origin/main` 上无参跑它读出的尾巴是 `基线外新增 9`、EXIT 1，而同一棵树的 CI 全绿。这不是判定写错了，是**没接线**：这道闸门本身是影子读数——基线内 1422 条只打 `WARN`，不会有人天天手动跑一遍。
- 补法不需要新 workflow：`engineering-shell.yml` 的 `unit-tests` 作业本来就跑 `npm run test:unit`，glob 覆盖 `tests/unit/*.test.mjs`。新增一个 `tests/unit/` 用例，从下一个 PR 起 CI 就会替人跑这道闸门。

## 二、怎么跑 / 具体断言

- 文件 `tests/unit/verification-comment-anchor-gate-on-repo.test.mjs`，4 个用例：
  - `tests/unit/verification-comment-anchor-gate-on-repo.test.mjs:93` 判据 ①（真仓正控制）；
  - `tests/unit/verification-comment-anchor-gate-on-repo.test.mjs:115` 判据 ②（防「扫了个寂寞」）；
  - `tests/unit/verification-comment-anchor-gate-on-repo.test.mjs:187` 判据 ③（防「永远红」）；
  - `tests/unit/verification-comment-anchor-gate-on-repo.test.mjs:222` 判据 ④（负控制）。
- 真仓那一跑是 `spawnSync(process.execPath, ['tools/verify-verification-comment-anchors.mjs'], { cwd: 仓库根 })`，超时 60 s（实测整道闸门 3.5–4.2 s）。不 import `main()`、不换夹具：扫的就是当前这棵树。
- 真仓读数只跑一次（① 与 ② 共用同一次输出），整份文件实测 5.7 s：`node --test tests/unit/verification-comment-anchor-gate-on-repo.test.mjs` ⇒ 4/4 pass。
- 全程只读真仓：⛔ 不写仓内文件、⛔ 不改基线。① 用基线文件 sha256 断言「跑前跑后字节相同」，确保这条测试自己不会变成第二个写盘入口。

## 三、四条判据与实测读数

| 判据 | 断言 | 本片读数 |
| --- | --- | --- |
| ① 正向（主判据） | `EXIT 0`；无 `-FAIL` 行、无 `ERR:` 行、无 `NEW` 行；`基线外新增 0`、`可收紧 0`；`--require-no-new=on`、`--require-no-stale=off`；`-PASS:` 行存在；基线 sha256 前后一致 | `本次命中 1422、基线 1422、基线外新增 0、可收紧 0`，EXIT 0 |
| ② 防「扫了个寂寞」 | `本次命中` == 基线 JSON 条目数；`documents` ≥ 300；基线 `scope` 逐字等于 `docs/verification/**/*.md` | 1422 == 1422（基线 entries=1422）；`documents=371`（含本页） |
| ③ 防「永远红」 | 真仓读数里 `--require-no-stale=off`；临时夹具里把基线内锚点的目标行从注释改成行为行 ⇒ 默认 EXIT 0 + `STALE` + `可收紧 1`；加 `--require-no-stale` 才 EXIT 1 | 见 §四 D 段 |
| ④ 负控制 | 同一临时目录、同一临时基线：注入指向注释行的锚点 ⇒ EXIT 1 + `基线外新增 1` + `NEW` 行点名 `doc:line -> target:line`；同一条改指行为行 ⇒ EXIT 0 且命中回到基线条目数 | 见 §四 A/B/C |

判据 ② 是本片最容易被糊过去的一条：docs 目录挪了、glob 坏了、`--scan` 默认值被改，工具都会「扫 0 篇、0 新增、PASS」——那是最糟的假绿。`本次命中 == 基线条目数` 配合 ① 的「新增 0 / 可收紧 0」，等价于「基线里每一条都还在本次扫描里被命中」，扫空面直接红。

## 四、负控制的前后读数（原文）

夹具（都在 `mkdtemp` 里，跑完删除，仓内零写入）：

- 真仓的一份证据页 `docs/verification/gy-r28-comment-ops-contract-20261021.md`（原文复制，只此一篇）；
- 它唯一引用的源文件 `services/api/src/community/service.ts`（原文复制）——清单不是手抄的，用主工具导出的抽取函数对这篇页现算；
- 本工具自身 `tools/verify-verification-comment-anchors.mjs`（原文复制，作为「往哪儿注锚点」的目标：第 2 行是文件头块注释，`export const TOOL_ROOT =` 是行为行）；
- 用 `--write-baseline` 生成的**临时基线**（写在临时目录里，真基线不动）。

```text
$ node tools/verify-verification-comment-anchors.mjs --root <临时目录> --write-baseline
WRITE: tools/verification-comment-anchor-baseline.json 写入了 3 条（accepted=gy-r90-comment-anchor-shadow-batch）
[EXIT 0]
```

**A. 起点**：临时基线覆盖全部命中 ⇒ 绿。

```text
VERIFICATION-COMMENT-ANCHOR: candidates=7 comment=3 code=3 blank=1 out-of-range=0 unresolved=0 fenced=0 duplicate=0
VERIFICATION-COMMENT-ANCHOR-SCOPE: docs/verification/**/*.md documents=1 （unresolved 中 ambiguous=0）
VERIFICATION-COMMENT-ANCHOR-BASELINE: path=tools/verification-comment-anchor-baseline.json entries=3 accepted=gy-r90-comment-anchor-shadow-batch
WARN docs/verification/gy-r28-comment-ops-contract-20261021.md:16 -> services/api/src/community/service.ts:1337-1342  // 父帖可读性先行：隐藏父帖不得通过评论列表泄露正文或存在性。
WARN docs/verification/gy-r28-comment-ops-contract-20261021.md:61 -> services/api/src/community/service.ts:1720  *
WARN docs/verification/gy-r28-comment-ops-contract-20261021.md:148 -> tools/verify-verification-comment-anchors.mjs:2  /**
VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 3、基线 3、基线外新增 0、可收紧 0（--require-no-new=on、--require-no-stale=off）
VERIFICATION-COMMENT-ANCHOR-PASS: 基线内 3 条注释锚点只告警，没有基线外新增
[EXIT 0]
```

**B. 注入一条新的、指向注释行的锚点** ⇒ 红，且点名。

```text
VERIFICATION-COMMENT-ANCHOR: candidates=8 comment=4 code=3 blank=1 out-of-range=0 unresolved=0 fenced=0 duplicate=0
VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 4、基线 3、基线外新增 1、可收紧 0（--require-no-new=on、--require-no-stale=off）
VERIFICATION-COMMENT-ANCHOR-FAIL: 基线外新增 1 条注释锚点（见上面的 NEW 行）——要么把锚点改到实质行，要么显式 --write-baseline 登记并写明理由
（同一次输出里点名的 NEW 行）
NEW  docs/verification/gy-r28-comment-ops-contract-20261021.md:150 -> tools/verify-verification-comment-anchors.mjs:2  /**
[EXIT 1]
```

**C. 同一个临时目录、同一份临时基线，只把这条锚点改成指向行为行** ⇒ 绿。

```text
VERIFICATION-COMMENT-ANCHOR: candidates=8 comment=3 code=4 blank=1 out-of-range=0 unresolved=0 fenced=0 duplicate=0
VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 3、基线 3、基线外新增 0、可收紧 0（--require-no-new=on、--require-no-stale=off）
VERIFICATION-COMMENT-ANCHOR-PASS: 基线内 3 条注释锚点只告警，没有基线外新增
[EXIT 0]
```

A ⇒ B ⇒ C 之间只改了「锚点指向注释行还是行为行」这一件事：命中 3 → 4 → 3，退出码 0 → 1 → 0。B 与 C 的 `documents=1` 说明这两次都没有扫到空面。

**D. 判据 ③ 的夹具**（另一份独立临时夹具）：把临时基线里那条锚点的目标行从 `/**` 改成 `export const STALE_PROBE = 0;`，即「基线里有、实际已不是注释行」。

```text
STALE docs/verification/gy-r28-comment-ops-contract-20261021.md:148 -> tools/verify-verification-comment-anchors.mjs:2 （可收紧基线：目标行已不是注释行（疑似已修）；确认后跑 --write-baseline 收册）
VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 2、基线 3、基线外新增 0、可收紧 1（--require-no-new=on、--require-no-stale=off）
VERIFICATION-COMMENT-ANCHOR-PASS: 基线内 2 条注释锚点只告警，没有基线外新增；另有可收紧条目待人工收册
[EXIT 0]

$ node tools/verify-verification-comment-anchors.mjs --root <临时目录> --require-no-stale
VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 2、基线 3、基线外新增 0、可收紧 1（--require-no-new=on、--require-no-stale=on）
VERIFICATION-COMMENT-ANCHOR-FAIL: 基线有 1 条已不再命中（见上面的 STALE 行）
[EXIT 1]
```

同一条「已修」的事实，默认口径 EXIT 0（只提示）、显式 `--require-no-stale` 才 EXIT 1 —— 这就是判据 ③ 想钉的「不是永远红」：文档插删行导致的键位移不会被误判成红，真要收紧时才有开关。

## 五、变异自证：新测试自己会红

口径：在**另一个**临时工作树（`git worktree` 到 `origin/main`，仓外路径）里做，只加一处假锚点、不碰基线，也不动交付工作树。

```text
$ git status --porcelain
 M docs/verification/gy-r28-comment-ops-contract-20261021.md     # 追加一行指向注释行的锚点（service.ts:1337）
?? tests/unit/verification-comment-anchor-gate-on-repo.test.mjs

$ node tools/verify-verification-comment-anchors.mjs
VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 1423、基线 1422、基线外新增 1、可收紧 0（--require-no-new=on、--require-no-stale=off）
VERIFICATION-COMMENT-ANCHOR-FAIL: 基线外新增 1 条注释锚点（见上面的 NEW 行）——要么把锚点改到实质行，要么显式 --write-baseline 登记并写明理由
[EXIT 1]

$ node --test tests/unit/verification-comment-anchor-gate-on-repo.test.mjs
✖ ① 真仓正控制：仓库根跑整道闸门 EXIT 0，基线外新增 0、可收紧 0
  AssertionError: 闸门在真仓上应 EXIT 0，实际 EXIT 1：
✖ ② 防「扫了个寂寞」：本次命中 == 基线条目数，documents ≥ 300
  AssertionError: 本次命中（1423）应等于基线条目数（1422）
ℹ pass 2  ℹ fail 2   [EXIT 1]

$ git checkout -- docs/verification/gy-r28-comment-ops-contract-20261021.md
$ node --test tests/unit/verification-comment-anchor-gate-on-repo.test.mjs
✔ ①②③④ …   ℹ pass 4  ℹ fail 0   [EXIT 0]
```

也就是说：一处「把注释行当行为证据」的新增，在接上这条测试之后会同时让工具与单元作业变红；恢复后两处都转绿。③④ 在变异树里仍然是绿的（它们自己有夹具，不依赖真仓当前读数），这正是「四条判据各管一段」的证据。

## 六、六道闸门（都在交付分支的最终树上跑）

```text
四连 strict    node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs   EXIT 0
contract-status node tools/verify-contract-status.mjs                                                                                                EXIT 0
test:docs       npm run test:docs（validate_development_docs + verify-research-records + verify-reading-pages）                                       EXIT 0
g-drill         node --test tests/unit/g-drill-readings.test.mjs                                                                                     EXIT 0
identity        node --test tests/unit/doc-anchor-relocation-identity.test.mjs                                                                        EXIT 0
merge-tree      git merge-tree --write-tree origin/main <本分支 head>（无冲突）                                                                        EXIT 0
```

- 本片不改 `.github/**`、不改 `tools/**`、不改 `tools/verification-comment-anchor-baseline.json`：`git show --numstat` 只有 `tests/unit/...test.mjs` 与 `docs/verification/gy-r90-comment-anchor-gate-wiring-20261109.md` 两个新增文件。
- identity 这条闸门在「HEAD 恰好等于 `origin/main`」的 detached 树上会自己报红（`base 与 HEAD 同一提交…不允许静默通过`），本片先在交付分支上 commit 再跑，读数取的是有 diff 的那棵树。

## 七、这道工具有哪些参数（负控制按它们做才不需要改工具）

| 参数 | 语义（读 `tools/verify-verification-comment-anchors.mjs:316` 的 `parseArgs`） |
| --- | --- |
| `--root <dir>` | 换根。扫描根、文件名索引、基线解析都跟着它走（`--baseline` 是相对它解析的） |
| `--scan <path>` | 扫描面，默认 `docs/verification` |
| `--baseline <path>` | 基线文件，默认 `tools/verification-comment-anchor-baseline.json`，相对 `--root` |
| `--accepted <text>` | 写基线时记的 `accepted` 标记 |
| `--why <text>` | 写基线时记的理由 |
| `--write-baseline` | **唯一**写盘入口；不传就绝不改基线（本片的临时基线靠它生成） |
| `--require-no-new` / `--no-require-no-new` | 基线外新增是否判红，缺省开（`tools/verify-verification-comment-anchors.mjs:312` 是判定式） |
| `--require-no-stale` | 可收紧条目是否判红，缺省关 |
| `--help` / `-h` | 用法 |

未知参数会打 `ERR: 未知参数：…` 并以 EXIT 2 结束。读数列的格式（`-GATE` 行的两个开关显示）在 `tools/verify-verification-comment-anchors.mjs:420`。

## 八、不声称

- 不声称已经把这道闸门做成**独立的 CI 作业**：它靠既有 `unit-tests` 作业里的 `tests/unit/**` glob 被执行，没有新增 workflow、没有新增 job、没有把它挂到别的 workflow 的 paths 上。
- 不声称它覆盖 `docs/architecture/**`：那是主工具 `verify-doc-anchors.mjs` 的 `--symbol` 面；本闸门只扫 `docs/verification/**/*.md`。
- 不声称 1422 条基线内锚点都是错的。基线是冻结的现状，不是裁定；本片只让「基线之外的新增」在 CI 里变红。
- 不声称 `本次命中 == 基线条目数` 能防住所有假绿：它防的是「扫描面塌成空集」这一类；基线整体被改写成「与实际一致」的另一种假绿不归它管（那需要人工逐条裁定，见工具的 `accepted`/`why`）。
- 不声称本片提高了闸门的判定强度或更换了注释判别口径：判别逻辑一行未动。
- 不声称负控制的夹具等价于全仓：它只复制了一篇真证据页与它引用的一个真源文件，用来证明「真仓形态下这条通路会红」，不重复工具单测里那 6 个夹具分支。

## 九、运行方式

```text
node --test tests/unit/verification-comment-anchor-gate-on-repo.test.mjs   # 4/4 pass，约 5.7 s
node tools/verify-verification-comment-anchors.mjs                         # 真仓读数，约 4 s，EXIT 0
```
