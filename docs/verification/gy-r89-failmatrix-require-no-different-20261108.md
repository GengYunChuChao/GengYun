# R89 真库臂加 `--require-no-different`：`different > 0` 可以把流水线直接判红

- `origin/main = a0f26d6c1f56c06fdac0e2f1bcc387e183305ce7`（#1084 的 squash 合入点；唯一父提交 `edd41481`）。**本页最初写于 `f7a4d0d9a19dc3a5065fd7705b9717293d0b804c`**（当时的基线＝分支父提交）；其后经 update-branch（分支顶端 `80de26c0`，并入的 main 提交 `cdbd7d46`）于 `a0f26d6c` 合入 main —— 现在 `f7a4d0d9` 只是**祖先**，不是父提交。原始工作树 `E:\GengYunCommander\.pg17\wt-r89nodiff`、分支 `test/gy-r89-failmatrix-require-no-different`（随 squash 合入后已删）都只作历史记录。
- 只动 `tests/failmatrix/**`、`tests/unit/**` 与本页；⛔ 没有改 `.github/**`、`services/**`、`packages/**`、`tools/**`、任何基线 json、`tests/unit/doc-anchor-relocations.json`（本片只改本页的**行内文字**，不产生锚点位移，故无需登记）。
- **行号层面零位移**：`tests/failmatrix/run-real.mjs` 既有 1518 行的**行号**一格没动（5 处就地替换、行数不变），新增的判定模块与 import 全部落在文件末尾（理由与代价见 §3）。

## §1 为什么加：这条臂的退出码从来没有读过 `different`

2026-11-07 的对抗性审查把这件事判成 **P1**，原话是「本 PR 新断言在 CI 里永远不会让流水线变红，价值只是『人肉可见』」。根因在退出码的判据本身：

- `tests/failmatrix/run-real.mjs:1477` 全臂只有一条能判红的判据——给了 `--require-no-not-runnable` 且 `not_runnable > 0` 时才 `return 1`；
- `tests/failmatrix/run-real.mjs:1483` 其后是**无条件** `return 0`（本轮改前的原文）。
- ⇒ `different > 0`（真 PG 的实际与期望不一致）时整臂照样 **exit 0**；汇总行里的「差异归因：different N 条」只是写给人看的，流水线不会红。

`.github/workflows/real-pg-integration.yml` 对这条臂写死了「⛔ 不断言 different === 0：差异正是这条臂的产品」。所以本任务**不碰 workflow**（改 `.github/**` 属 B 档）：本次只把「判红的能力」做进脚本并用开关默认关住，接线留给后续 PR（§7）。

## §2 开关语义：四种组合的退出码（逐字）

新开关 `--require-no-different`：布尔、不带参数，默认**关**。

| `--require-no-different` | `different` | 退出码 | 行为 |
| --- | --- | --- | --- |
| 关（默认，既有调用方） | `0` | **0** | 与改前**逐字相同**（不打印任何新东西） |
| 关（默认，既有调用方） | `> 0` | **0** | 与改前**逐字相同**——既有行为未变，见 §4 的 ③ |
| 开 | `0` | **0** | 本开关不因为「没有差异」判红，也不打印 FAIL |
| 开 | `> 0` | **1** | stderr 打一行 `FAIL：--require-no-different 下有 N 条 different（id 列表）。…` 后 `return 1` |

「一行 FAIL」的形状（`tests/failmatrix/require-no-different.mjs` 里 `differentFailureMessage`）：含 **`different` 计数**与**受影响用例 id**；id 最多列 10 个，多的写「等 N 条」（N 是实际条数，不是还剩几条）。逐条读数里找不到 DIFF 行（计数与读数字面不一致）时，列表位置写「逐条读数里没有 DIFF 行：计数与读数不一致，先查这个」，不静默。

**与 `--require-no-not-runnable` 正交**：新判据**从不读** `not_runnable`，旧判据**从不读** `different`（旧块从 `tests/failmatrix/run-real.mjs:1477` 起的那 5 行一字未动，含 `return 1;` 与 FAIL 文案，新判据接在它之后的原 `return 0` 位置）。两个开关各开各的，互不吞并——这是 §4 第 ④ 条单测钉住的东西。

## §3 实现：为什么抽模块、为什么 import 写在文件末尾

- 新文件 `tests/failmatrix/require-no-different.mjs`（无副作用，可被单测直接 import）导出三样：`requireFlagField`（`--require-no-not-runnable` / `--require-no-different` → 开关字段名；穷举 `switch`，**未知参数抛错**，不再是 fail-open 的静默别名）、`differentFailureMessage`（上面那行 FAIL 文案）、`shouldFailOnDifferent(opts, tally, rows)`（判定，返回 0/1）。
- `tests/failmatrix/run-real.mjs:1483` 只把原来的 `return 0;` 换成 `return shouldFailOnDifferent(opts, tally, rows);`——一个表达式，没有挪动任何既有行。
- 参数解析就地扩展，与既有开关同风格（布尔、无参数、`continue`）：`tests/failmatrix/run-real.mjs:965` 的默认值对象加 `requireNoDifferent: false`，`tests/failmatrix/run-real.mjs:969` 的布尔分支接受两个开关名，`tests/failmatrix/run-real.mjs:972` 的未知参数提示补上新名字。
- 文件头 usage 同步补一句（`tests/failmatrix/run-real.mjs:32`）：本脚本没有 `--help`，用法块是唯一的入口说明。
- `import` 写在文件**末尾**（`tests/failmatrix/run-real.mjs:1530`）：ESM 的 import 会被提升，与写在第一行等价，而写在第一行会把下面每一行下推一格，牵动 `docs/verification/` 里一批 `run-real.mjs:<行号>` 锚点（同一取舍见 `docs/verification/gy-r87-etag-parity-20261107.md:28`）。文件末尾的注释块写明了「⛔ 不要挪上去」。
- **不改**的部分（下面每个符号都能在仓里 `git grep -n` 命中；括号里给的是真实声明/使用行，不是示意）：
  - 逐条判定入口 `verdictFor`（`tests/failmatrix/run-real.mjs:790`），一个字没动。
  - 权限族表 `PERMISSION_FAMILIES`（`tests/failmatrix/run-real.mjs:990`），一个字没动。
  - 「权限面合计 …」汇总行文案（`tests/failmatrix/run-real.mjs:1421`）——这一行没有独立符号名，按文案本身引用，一个字符没动。
  - `--json=` 的产物结构，一个字节都没动。

## §4 单测：10 条（`tests/unit/failmatrix-require-no-different.test.mjs`）

判定被抽成纯函数，所以前 5 条直接调函数、不打簇、不碰网络；涉及 CLI 的两条用「空 `initdb` 假 bin」让解析通过后立刻在起簇处失败，避免真起 PG。

1. 开关打开 + `different > 0` ⇒ 返回 1，stderr 一行 FAIL 含计数与受影响用例 id
2. 开关打开 + `different === 0` ⇒ 返回 0（本开关不因为「没有差异」判红），且不打 FAIL
3. 开关关闭 + `different > 0` ⇒ 返回 0：**既有行为未变**（退出码仍只由 `not_runnable` 决定）
4. 开关打开 + `notRunnable > 0` 且没给 `--require-no-not-runnable` ⇒ 仍只按 `different` 判（两开关互不吞）
5. `different` 多于 10 条时只列 10 个用例 id，多出来的写「等 N 条」（N = 实际条数）
6. 参数拼错 `--require-no-diff` ⇒ 与既有非法参数行为一致（`parseArgs` 顶层 `throw` 未知参数，exit 1）
7. `--require-no-different` 被 `parseArgs` 接受：解析器不崩、直接走到起簇（正向标记 `[pg] bin=`、`[pg] dataDir=`、`真 PG 臂 FAIL` 都在，且输出里没有 `ReferenceError`；起簇真失败 ⇒ exit 1，不是 77）
8. 结构契约：字段映射独立、短路行接在既有 `return` 处、新内容全在文件末尾（既有 1518 行不动）
9. 文件头 usage 提到 `--require-no-different`
10. `requireFlagField` 对未知参数**抛错**（`--require-no-diff`、`--require-no-not-runnabl`、空串），不再静默映射成 `requireNoNotRunnable`

跑法：`node --test tests/unit/failmatrix-require-no-different.test.mjs`。

## §5 真库臂实跑（一次性簇，PG 17.11）

环境：`GY_PG_BIN=E:\GengYunCommander\.pg17\pgsql\bin`、`GY_I22_PG_ROOT=E:\GengYunCommander\.pg17\r89-nodiffnits-pgroot`、Node `v24.16.0`。簇由脚本自取端口（`freePort()` 走 `listen(0)`，**外部指定不了端口**）、只听 `127.0.0.1`，`finally` 里 stop + 删数据目录。

```powershell
node tests/failmatrix/run-real.mjs --require-no-not-runnable --require-no-different --json=<仓外临时路径>
```

本次读数（合并后在 `a0f26d6c` 上重跑，簇 `port=50084`、`server_version=17.11`）：

- 末行汇总：`真 PG 臂完成：180 条权限面用例在 PostgreSQL 17.11 上取得逐条读数，耗时 11143 ms（same=180 sameWithCheck=25 sameWithShape=30 different=0 not-runnable=0）。`
- 族合计行：`权限面合计 180 条：same 180 / sameWithCheck 25 / sameWithShape 30 / different 0 / not_runnable 0`
- `EXITCODE=0`，倒数第二行 `[pg] 一次性集群已停止，数据目录已删除`。

⇒ `different 0` 时新开关**不放红**（这是开关默认关与开都必须成立的同一件事）。**这条读数不证明**「`different > 0` 时退出码真是 1」——那一半用下面这组反向对照钉。

**端到端反向对照（造一条真 different，跑完立刻还原、未进提交）**：把 `tests/failmatrix/cases.mjs:111`（C1-01）的期望临时从 401 改成 402，让真 PG 返回 401 撞出 1 条 `different`，同一棵树连跑两次：

- 开 `--require-no-different`（簇 `port=61928`、10521 ms）⇒ `EXITCODE=1`；stderr 末行 `FAIL：--require-no-different 下有 1 条 different（C1-01）。different 不是通过：它表示真 PG 的实际与期望不一致；本开关把这类差异判成失败（关掉开关时退出码仍只由 not_runnable 决定）。`；汇总行 `same=179 … different=1 not-runnable=0`。
- 关掉它（簇 `port=60072`、11067 ms，**同一份「1 条 different」**）⇒ `EXITCODE=0`；汇总行同样是 `same=179 … different=1 not-runnable=0`。

⇒ **同一份读数，关=0、开=1**。两端都已 `git checkout` 还原（`git status --porcelain` 为空、`cases.mjs` 回到 401），这组对照没有进提交。

## §6 变异自证

**变异 A（判定恒假，钉第 ①/④ 条）**：把 `shouldFailOnDifferent` 临时改成恒 `false`（函数首行加一行 `return 0;`，短路掉 FAIL 分支）⇒ `node --test tests/unit/failmatrix-require-no-different.test.mjs` 变 **EXIT 1 / `ℹ tests 10` / `ℹ pass 8` / `ℹ fail 2`**，红的两条正是第 ① 条（「开关打开 + `different > 0` ⇒ 返回 1 …」，断言在 `tests/unit/failmatrix-require-no-different.test.mjs:72`）与第 ④ 条（「两开关互不吞」，断言在 `tests/unit/failmatrix-require-no-different.test.mjs:119`）——「开关失效」直接被打死，不是靠别的用例兜住。

**变异 B（解析器里 `requireFlagField` 未定义，钉第 ⑦ 条的新断言）**：把 `tests/failmatrix/run-real.mjs:969` 的调用点临时改成 `requireFlagFieldX(arg)`（等价于删掉文件末尾那句 import：名字解析不到）⇒ `node --test --test-name-pattern="被 parseArgs 接受" tests/unit/failmatrix-require-no-different.test.mjs` 变 **EXIT 1**，红点就是第 ⑦ 条新增的那条正向断言（`tests/unit/failmatrix-require-no-different.test.mjs:192` 的 `assert.match(output, /\[pg\] bin=/)`）：子进程在**模块求值阶段**就 `ReferenceError: requireFlagFieldX is not defined`（`at parseArgs (…run-real.mjs:969:84)`、`at …run-real.mjs:976:14`），`main()` 根本没进，所以 `[pg] bin=` / `[pg] dataDir=` 一行都没出现。**旧写法在这次变异下是绿的**：它的两条断言（`doesNotMatch(/未知参数/)`、`status === 1`）都被满足——ReferenceError 的进程退出码同样是 1，输出里也没有「未知参数」。这正是把否定式断言换成正向标记的原因。

两条变异都还原成 HEAD 原始内容（变异 A 的还原顺带把本片对 `tests/failmatrix/require-no-different.mjs` 的 `switch` 改动一起冲掉了，已重新落地并复核）；还原后 **EXIT 0 / `ℹ tests 10` / `ℹ pass 10` / `ℹ fail 0`**，`git status --porcelain` 里 `tests/failmatrix/run-real.mjs` 零残留，`tests/failmatrix/require-no-different.mjs` 只剩本片那处 fail-closed 改动。

## §7 闸门读数（六道，全 EXIT 0）

| 闸门 | 结果 | 尾行原文 |
| --- | --- | --- |
| 单测专属文件 | EXIT 0 | `ℹ tests 10` / `ℹ pass 10` / `ℹ fail 0` |
| 锚点位移身份 | EXIT 0 | `ℹ tests 37` / `ℹ pass 37` / `ℹ fail 0` / `ℹ skipped 0`（本片改写了本页的既有行，主用例不再是「纯新增 hunk」的 SKIP，而是真把 §3/§6/§7 的行对判了一遍） |
| 文档行号 `--strict` 全套 | EXIT 0 | `PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）` |
| 契约状态 | EXIT 0 | `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` |
| `test:docs` | EXIT 0 | `PASS: 识别 5 页 / 跳过 350 页（扫描面 355 页：docs/verification）——读数七条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字 ⑦同页副本一致）` |
| 合并预演 | RC 0 | 只输出一行合并树 oid（无 `CONFLICT`、无 `changed in both`） |

文档行号闸门的计数面（verification 面，**只判「比基线上升」**）：基线 `不在区间 44、UNDECLARED 265、配成对 1051`；在本片 HEAD 上实测 `不在区间 44、UNDECLARED 250、配成对 1197`。如实说：**`不在区间` 持平 44、`UNDECLARED` 由 265 降到 250 —— 这两项没有上升**；`配成对` 由 1051 升到 1197，那是「锚点＋符号」配成对的条数变多（更多真符号被写在锚点旁边），属于**锚点覆盖变多，不是回归**——该闸门也只把「上升」判红，所以结论仍是 `PASS`，另有一条 `STALE` 提示（`UNDECLARED` 低于基线，可跑 `--write-symbol-coverage-verification-baseline` 收紧）。原文那句「三项都没上升」是 update-branch 之前的旧读数（当时 `1051 → 1178` 本身就已经是上升），已按合并后实测改写。

## §8 CI 尚未接：这是本页最大的「不声称」

脚本现在**有能力**判红，但 `.github/workflows/real-pg-integration.yml` 调这条臂时**没有加** `--require-no-different`，所以今天的 CI 仍然不会因为 `different > 0` 变红。接线要同时改两处（命令行加开关、把「⛔ 不断言 different === 0」那段注释改写成新语义），那属于 `.github/**`、按 AGENTS.md 是 B 档，另开 PR 做。

**不声称**：

- 不声称 CI 已经会因 `different > 0` 变红——没接。
- 不声称 `different > 0` 就是产品缺陷：差异可能是期望写错、也可能是实现错，开关只负责「计数不为 0 ⇒ 红」，判因仍靠逐条读数。
- 不声称覆盖 `not_runnable`：那是 `--require-no-not-runnable` 的事，两者正交。
- 不声称开关默认开：默认关，既有调用方行为逐字不变。
- 不声称 `180 / 180 / 25 / 30 / 0 / 0` 这组读数能复用到 CI：本机 Windows + 一次性簇的实测，不替代 CI 绿。
