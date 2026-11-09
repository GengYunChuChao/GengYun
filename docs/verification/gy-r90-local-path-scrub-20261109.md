# R90 · 本机绝对路径清查：`docs/verification` 自有证据页 5 行去盘符（2026-11-09）

> 读数快照：2026-11-09（Asia/Hong_Kong），基线 `3ea5792554c8e675208dcdb8349ef6bca2cbd39d`（`origin/main`，`#1134` 之后）。
> 本页只做两件事：① 把两条 R90 自有证据页里 5 行「盘符 + 反斜杠」路径改成不泄漏本机、读者仍能复现的占位写法；② 记录 `release-gate --only secrets` 与六道闸门的实测读数。
> 本页自身不含任何盘符路径：改前的形状只按「检出根下哪一层」描述，不抄原文。

## 一句话

`tools/release-gate.mjs:415-421` 的 `local-absolute-path` 规则（判据是「单个 ASCII 字母 + 冒号 + 反斜杠」）在**待发布 diff** 里命中 7 条本机路径。本次把属 R90 自有证据页的 5 条（`docs/verification/gy-r90-i19-deidentify-20261109.md` 3 行、`docs/verification/gy-r90-i1003-ac-reconciliation-20261109.md` 2 行）逐行改掉，**两页行数逐行不变**（243 行 / 248 行，改前改后一致），六道闸门仍全绿；同一 base 口径下 `--only secrets` 由 EXIT 1 / `hitCount` 7 变为 EXIT 0 / `hitCount` 0。

## 一、扫描面（只读；数出多少就报多少）

扫描口径是禁令正则的等价形态（负向前瞻排除「字母/数字/下划线 + 字母 + 冒号 + 反斜杠」的假阳性），不是派单里那串四条反斜杠的字面量——后者在 PowerShell 单引号里只命中源码中被转义成双反斜杠的形态（实测 31 行，全在 `tests/**`、`tools/**`、`docs/reference/**`，本页处理的两条证据页不在其中，它们用的是单反斜杠）。下表在基线树 `3ea57925` 上数：本次改掉的 5 行（含 7 处路径；两行各含 2 处）会从命中里消失，而这条命令按**行**计数，所以本 PR 合并后同一条命令应报 **836** 行，比 841 少的 5 行正是这 5 行——这不是「又冒出新路径」，也不是「扫面变了」。

| 范围 | 命中行 | 文件数 |
| --- | --- | --- |
| 全仓（`docs tests tools services packages apps .github`） | 841 | 280 |
| 其中 `docs/verification/**` | 736 | 233 |
| 其中 R90 当期证据页（`gy-r90*`） | 21 | 10 |
| 其中 R6x–R7x 及更早的历史取证页 | 其余 | 35（仅 R6x/R7x 段） |
| 区外（`docs/verification` 之外） | 105 | 47 |

区外 105 行的分布：`tests/**` 64、`docs/**` 26（含 `docs/development-guide.md` 5、`docs/release/runbook-20261022.md` 4、`docs/archive/**` 6）、`tools/**` 10、`.github/**` 4、`services/**` 1。**本次一行未动**，理由见 §5。

## 二、改了什么（5 行 / 7 处，逐行对照）

行号以 `3ea57925` 的树为准（纯行内替换，行数与其它行一字未动）。「改前」一栏只描述形状，不抄盘符与父目录。

| 位置（`3ea57925` 树） | 改前（形状） | 改后（占位） |
| --- | --- | --- |
| `docs/verification/gy-r90-i19-deidentify-20261109.md:6` | PostgreSQL 17.11 二进制目录的 Windows 绝对路径（检出根下 `.pg17` 内的 `pgsql/bin`） | `$env:GY_PG_BIN` 指向的目录 |
| `docs/verification/gy-r90-i19-deidentify-20261109.md:225`（第 1 处） | 本机 worktree 的 Windows 绝对路径（`.pg17` 下 `wt-i19page`） | `<worktree 名>` |
| `docs/verification/gy-r90-i19-deidentify-20261109.md:225`（第 2 处） | 同第 6 行那处的 PG 二进制目录绝对路径 | `$env:GY_PG_BIN` 指向目录 |
| `docs/verification/gy-r90-i19-deidentify-20261109.md:226`（第 1 处） | 本机数据目录绝对路径（`.pg17` 下 `i19pg` 的 `gy-i19-deidentify-pg-<随机后缀>`） | `$env:GY_I19_PG_ROOT` 下的 `gy-i19-deidentify-pg-<随机后缀>` |
| `docs/verification/gy-r90-i19-deidentify-20261109.md:226`（第 2 处） | 本机日志文件绝对路径（`.pg17` 下 `r90i19page-arm.log`） | 仓外本机临时目录（文件名 `r90i19page-arm.log`） |
| `docs/verification/gy-r90-i1003-ac-reconciliation-20261109.md:38` | 仓外私密目录的 Windows 绝对路径 | 仓外本机私密目录，未入库 |
| `docs/verification/gy-r90-i1003-ac-reconciliation-20261109.md:164` | 同上 | 同上 |

占位不是随口起的，两个环境变量都是脚本里真读的：

- `tests/integration/deidentify-account-pg.mjs:67` 读 `GY_I19_PG_ROOT`（缺省 `tmpdir()`），同文件第 68 行在其下拼 `gy-i19-deidentify-pg-${randomUUID().slice(0, 8)}`——所以「`$env:GY_I19_PG_ROOT` 下的 `<随机后缀>` 目录」既去掉本机盘符，又保留读者复现所需的全部事实（为什么要显式给根目录、目录名怎么来）。
- `GY_PG_BIN` 是本院真库臂统一使用的「含 `initdb`/`pg_ctl` 的目录」环境变量（`tests/integration/**-pg.mjs` 的用法注释即此口径），指向同一事实而不绑定本机盘符。

改后两页全文复扫：`git grep -n -I -P '(?<![A-Za-z0-9_])[A-Za-z]:\\' -- <两页>` 命中 **0**。两页行数：243 / 248，与改前逐字相同（`git diff --numstat` 为 `3 3` 与 `2 2`，无新增或删除行）。

## 三、`release-gate --only secrets` 读数（改前 / 改后，两个数都给）

该工具只扫 `git diff <base>...HEAD` 的**新增行**，所以「改前」必须选一个能看见目标行的 base；另外要说明一件容易读错的事：**在干净树上（`HEAD == origin/main`）用 `--base origin/main` 必然是 `scannedLines: 0` / `hitCount: 0` / EXIT 0 —— 那是空扫，不是「已经改好了」**。因此改前读数用 `--base a4183da6^`（`#1127` 之前，能同时看见 `#1127` 与 `#1134`）与默认 base 两组。

| 时点 | 命令 | base | `scannedLines` | `hitCount` | EXIT |
| --- | --- | --- | --- | --- | --- |
| 改前 | `--only secrets`（默认） | `upstream/main`＝`a4183da6`（当时落后 `origin/main` **一个**提交） | 70 | **2** | 1 |
| 改前 | `--only secrets --base a4183da6^` | `a4183da6^` | 332 | **7** | 1 |
| 改后 | `--only secrets --base origin/main` | `origin/main`＝`3ea57925` | 122 | **0** | 0 |
| 改后 | `--only secrets --base a4183da6^` | `a4183da6^`（与改前同一口径） | 449 | **0** | 0 |
| 改后 | `--only secrets`（默认） | `upstream/main`（收尾时已被拉到 `3ea57925`，与上一行同口径） | 122 | **0** | 0 |

改前 7 条的落点（逐条）：`docs/verification/gy-r90-i19-deidentify-20261109.md:6` 一行 1 条、该页第 225 行 2 条、第 226 行 2 条；`docs/verification/gy-r90-i1003-ac-reconciliation-20261109.md:38` 一行 1 条、该页第 164 行 1 条。改后三行的 `scannedLines` 比改前多出的 117 行，正是本证据页自身的全部新增行（5 行改动新增 + 117 行新页 = 122；332 + 117 = 449），不是新的泄漏。

**一条必须写明的纠正**：改前默认 base 的那 2 条（`i1003` 页第 38、164 行）**不是**「扫到已合并内容的假红」——`#1134` 已把那两行合进 `main`，它们是主干上的**真泄漏**；只有把它们一起改掉，默认基线才可能转绿。本次因此把它们放在**独立提交**里（见 §6），可以单独回退而不影响 deidentify 页的 3 行。

## 四、六道闸门（EXIT 与尾行照抄）

读数取自本提交（提交后在工作树上复跑；第 1、4 项的计数含本页）。

| # | 命令 | EXIT | 尾行 / 关键读数 |
| --- | --- | --- | --- |
| 1 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | 0 | `PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）`；`BARE-ORPHAN` 命中 3469 条、基线外新增 0 条；`ANCHOR-COUNT` 进判据锚点 9630 条 / 306 份文档、计数下降的文档 0 份 |
| 2 | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | 0 | `ℹ tests 37` / `ℹ pass 37` / `ℹ fail 0`；判定面 `base=3ea5792554c8`、`documented files=3 docLines=5 tokens=12 pairs=12 judged=12 identical=12 relocated=0 registered=0 corrected=0 carried=692 removed=0 unresolved=0 hunks(pair=4 add=1 del=0)` ⇒ **不需要任何登记** |
| 3 | `node tools/verify-contract-status.mjs` | 0 | `PASS: 中文表格一致`；`PASS: 行号区间 324 条（台账直写 312 条 + 符号解析 12 条；有实质内容 324 条；整段仅空白/收尾行 0 条、区间首行为空行 4 条，只计可疑不判红）`；尾行 `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` |
| 4 | `npm run test:docs` | 0 | `PASS: 识别 5 页 / 跳过 368 页（扫描面 373 页：docs/verification）——读数七条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字 ⑦同页副本一致）` |
| 5 | `node tools/verify-g-drill-readings.mjs --check` | 0 | `✓ 八条判据全过：workflows 15 / jobs 30 / 演练 21 条 / 测试文件 609（glob 合计 579）；生长型读数按**下界**判（--tolerant-growth），其中 8 条滞后已逐行打印` |
| 6 | `git merge-tree --write-tree --name-only origin/main HEAD` | 0 | 只输出一行 tree OID，`--name-only` 无任何路径 ⇒ 与 `origin/main` 无冲突、无重叠改动面 |

另跑 `node tools/verify-verification-comment-anchors.mjs`：EXIT 0，`VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 1422、基线 1422、基线外新增 0、可收紧 0` ⇒ 仍是「基线外新增 0」。

## 五、没动的：清单与理由

### 5.1 R90 同期页仍有 16 行（已合进 `main`，不进本次 `base...HEAD` 扫描面）

| 位置 | 该行是什么路径（形状） |
| --- | --- |
| `docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:173` | 本机 `.pg17` 下的 `wt-gateprose` 工作树 |
| `docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:186` | 本机 MSYS/Git for Windows 的 `bash.exe`（另一个盘符） |
| `docs/verification/gy-r90-collaboration-ops-20261109.md:12` | 本机 `.pg17` 目录前缀 |
| `docs/verification/gy-r90-collaboration-ops-20261109.md:162` | 主检出目录 |
| `docs/verification/gy-r90-collaboration-ops-20261109.md:214` | 主检出目录 |
| `docs/verification/gy-r90-comment-anchor-rebaseline-20261109.md:210` | `.pg17` 下 `wt-cmtbase-hist` 工作树 |
| `docs/verification/gy-r90-comment-anchor-rebaseline-20261109.md:212` | 两处：`.pg17/cmBase-artifacts` 下的探针脚本、`wt-cmtbase-hist` 工作树 |
| `docs/verification/gy-r90-comment-anchor-rebaseline-20261109.md:233` | `.pg17` 下 `wt-cmtbase-head` 工作树 |
| `docs/verification/gy-r90-comment-anchor-rebaseline-20261109.md:234` | 同上 |
| `docs/verification/gy-r90-contract-runtime-schema-parity-20261109.md:264` | `.pg17` 下 `wt-contractparity` 工作树 |
| `docs/verification/gy-r90-i1030-closeout-20261108.md:13` | `.pg17` 下 `wt-i1030` 工作树 |
| `docs/verification/gy-r90-i19-deidentify-ci-wiring-20261109.md:106` | `.pg17` 下的 `pgsql/bin` |
| `docs/verification/gy-r90-i19-deidentify-ci-wiring-20261109.md:107` | `.pg17` 下的 `i19root` |
| `docs/verification/gy-r90-open-issue-acceptance-index-20261109.md:21` | `.pg17` 下 `wt-r90index` 工作树 |
| `docs/verification/gy-r90-supervisor-self-merge-audit-20261109.md:222` | 仓外私密目录下的 `github-pat.txt`（**凭据文件路径**，优先级高于其余各项） |
| `docs/verification/gy-r90-supervisor-self-merge-audit-20261109.md:233` | 同上 |

**为什么本次不清**：这些行都在 `#1134` 及更早的提交里，已属 `main`，不进本 PR 的 `base...HEAD` 扫描面，改与不改都不影响本次闸门；而每多改一页就多一份「证据页原文被改写」的审查面，混进同一个 PR 会让「只改 5 行」的边界失真。要清须另开单（建议按 §5.1 表逐行摘，`supervisor` 页那两处凭据路径优先）。

### 5.2 历史取证页（`docs/verification/**` 里 R6x–R7x 及更早）

736 行里的绝大多数落在这里（233 份文件中的 220 余份），本次**一行未动**。理由：这些页是当次读数的原件，路径本身就是证据的一部分——把盘符换成占位符，等于事后改写「我当时到底在哪棵树、用哪个二进制跑出来的」。**改了就毁证据价值**，而这批页已合进 `main`，不影响任何闸门。

### 5.3 区外 105 行

- `tests/**` 64 行、`tools/**` 10 行：多为真库臂用法注释里的 `GY_PG_BIN` 示例与 `tests/unit/bash-resolver.mjs` 的解析器用例。属 **B 档与行为面**（改注释会动到行为用例的判据面），另立单。
- `docs/**` 26 行（`development-guide.md`、`release/runbook-20261022.md`、`archive/**` 等）：是给读者照着填的**模板示例**，不是读数；要改得先定「用哪个占位口径」，同样另立单。
- `.github/**` 4 行、`services/**` 1 行：CI 与源码注释，B 档。

## 六、本页的边界

- **本页不声称清空了仓库里的本机路径**：`docs/verification/**` 改后仍有 731 行命中（16 行 R90 同期页 + 715 行历史取证页），区外另有 105 行；本页只动 5 行。
- **本页不声称 `local-absolute-path` 今后不会再红**：该规则只扫**新增行**，只要有人再往 diff 里写盘符路径，它照样红；本次做的是把已进 `main` 的 7 条清掉，并把「干净树 + `--base origin/main` 是空扫」这条读法写清楚，防止后来人拿空扫当证据。
- 本页不判定任何 `#` 编号或台账状态：两个提交都只落在 `docs/**`（A 档范围），`status` 一个字段也没改。
- 两个提交：`8f3fa06e33cf93c06c25c628abb2afe196a6fa6d`（deidentify 页 3 行）、`9986af8841a3e8282125a6d6a00876c82fc663da`（i1003 页 2 行，**派单外增补，可单独回退**）。
