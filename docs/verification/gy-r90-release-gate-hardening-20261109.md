# R90 发布门禁硬化：改名漏扫（AMR）与空 diff 假绿（--require-base）（2026-11-09）

> **一句话结论**：`tools/release-gate.mjs` 的两条假绿通道已堵上——① `git mv` 改名提交在 `--diff-filter=AM` 下
> 整份漏扫（实测 `scannedLines: 0`／退出码 0），改 `AMR` 后同一夹具退出码 1、命中 `moved.txt:21`；
> ② 无远端仓库的默认基线会落到 `HEAD`，空 diff 扫 0 行也判 `pass`，新增的 `--require-base` 把它变成退出码 2，
> 而 `--base HEAD~1` 的真泄漏照旧退出码 1。两个补丁都只收紧：`AMR ⊃ AM`，`--require-base` 是新增开关、
> 不加时行为逐字节不变。

| 项 | 值 |
| --- | --- |
| 仓库 / 基线 | `GengYunChuChao/GengYun` · `origin/main` = `3ea57925`（本页证据即在该提交的工作树上取的） |
| 切片档位 | B 档：改 `tools/**` 与 `tests/**`，另加本页与 `docs/release/release-gate.md`；**不碰** `.github/**` |
| 取证方式 | 真跑：临时 git 仓库夹具 ×4 组、改前/改后两份 `release-gate.mjs`、`node --test`、七道闸门 |
| 改前工具 | `git show origin/main:tools/release-gate.mjs`（1009 行）另存后对拍；改后 1051 行 |
| 结论性质 | 「这两条假绿通道已被堵上」＝已证；「release-gate 已进 CI」「覆盖 pg 臂」「能扫历史泄漏」＝**未**证（见 §6） |

## 1 两个补丁改了什么

### 1.1 补丁 1：`--diff-filter=AM` → `AMR`

| 位置（改前行号 → 改后行号） | 函数 | 改动 |
| --- | --- | --- |
| 改前 475 → `tools/release-gate.mjs:505` | `collectAddedLines` | `--diff-filter=AM` → `--diff-filter=AMR`，并在上方补 3 行注释说明为什么必须含 `R` |
| 改前 511 → `tools/release-gate.mjs:542` | `collectChangedFiles` | 同上（供大文件/二进制检查用的文件清单） |

### 1.2 补丁 2：新增 `--require-base`

| 位置（改后行号） | 改动 |
| --- | --- |
| `tools/release-gate.mjs:74` | `--help` 文字加一行 `--require-base`（说明「否则退出码 2」） |
| `tools/release-gate.mjs:115` / `tools/release-gate.mjs:120` / `tools/release-gate.mjs:134` | `parseArgs`：默认值 `requireBase: false`、`flagOpts` 加 `'require-base'`、分支链加 `opts.requireBase = true` |
| `tools/release-gate.mjs:484-495` | 新增 `baseRequirementProblem(base, headSha)`：基线解析不到、或解到的 sha 就是 HEAD ⇒ 返回用法错误文案；否则返回 `null` |
| `tools/release-gate.mjs:1014-1022` | `main` 里在 `ctx.base` 构造之后、任何门禁开跑之前判定；不合规直接 `return 2`（stdout 为空、不落盘） |

**没有改的东西**：`resolveBase` 的候选顺序（`upstream/main → origin/main → main → HEAD`）、
`--base` 的解析语义、任何门禁的判据、任何退出码的既有含义。`--require-base` 只增加一条**前置否决**。

## 2 补丁 1 的读数（改前 / 改后）

夹具 A：`git init -q -b main`，`clean.txt` 20 行 → 同一提交里 `git mv clean.txt moved.txt` 并追加第 21 行
`const key = '<sk 前缀><16 位>'`。`git diff --name-status` 给出 `R093	clean.txt	moved.txt`，
`--diff-filter=AM` 视角是**空串**（这就是漏扫的机制）。

```text
# 改前（origin/main 版工具）
node release-gate-before.mjs --root <夹具A> --only secrets --base HEAD~1
⇒ EXIT 0    base.ref=HEAD~1  base.sha=6c085a09  status=passed  scannedLines=0  hits=0

# 改后（本片工具，同一夹具、同一命令）
node tools/release-gate.mjs --root <夹具A> --only secrets --base HEAD~1
⇒ EXIT 1    status=failed  scannedLines=1  hits=["moved.txt:21"]

# 改后 + --require-base（基线 HEAD~1 ≠ HEAD，不该被误伤）
⇒ EXIT 1
```

夹具 B：`big.txt`（2048 字节）+ `blob.bin`（含 NUL），纯 `git mv` 成 `renamed-big.txt` / `renamed-blob.bin`
（`R100`），`--diff-filter=AM` 视角同样为空：

```text
# 改前
node release-gate-before.mjs --root <夹具B> --only artifacts --max-file-bytes 512
⇒ EXIT 0    scannedFiles=0  findings=0

# 改后
node tools/release-gate.mjs --root <夹具B> --only artifacts --max-file-bytes 512
⇒ EXIT 1    scannedFiles=2  findings=["renamed-big.txt:too-large","renamed-blob.bin:binary"]
```

### 2.1 等价性论证：为什么 `AMR` 不可能把红变绿

`git diff --diff-filter` 的每个字母是一个**独立的集合筛选**，`--diff-filter=AM` 是 `A ∪ M`，`--diff-filter=AMR`
是 `A ∪ M ∪ R`。三者关系恒为 `A ∪ M ⊆ A ∪ M ∪ R`，所以：

1. **原来会扫的 A/M 一个不少**：同一提交、同一基线、同一 git 版本下，`AMR` 输出的 A/M 条目集合与 `AM` 逐条相同
   （多出来的只有 `R` 条目）。扫的行集合是超集 ⇒ 命中集合是超集 ⇒ `failed` 只会增、不会减。
2. **只多扫 rename**：新增的 `R` 条目是 git 自己认定的改名（相似度 ≥50%，`R0xx` 改内容、`R100` 纯改名）。
   它们原本在 `AM` 视角里**完全不存在**，现在被扫到，最坏结果是把「本该红但没红」变成红。
3. **不会产生假的命中**：`R` 条目喂给 `runSecretsGate` 的是同一个 `collectAddedLines` 解析出的 `+` 行
   （`file:line` 用 hunk 头的新文件行号），规则正则一字未改；`runArtifactsGate` 拿到的是同一批路径的
   `stat` + 前 8 KiB，阈值与 NUL 判据一字未改。改名不会凭空造出 `sk-` 形状的文本或 NUL 字节。
4. **口径上「只收紧」**：唯一的失败面增量是「原本 0 行 ⇒ 现在有行」。任何一条在 `AM` 下 `passed` 的夹具，
   在 `AMR` 下要么 `passed`（新增的 R 行没命中），要么 `failed`（新增的 R 行命中）——后者正是要修的漏扫。
5. **不碰删除**：`D` 没有被加进 filter。这不是口味问题——`AMRD` 是**错的**，实测见 §2.2
   （`git rm --cached` 会假红、`scannedFiles` 被删除项污染）。

反向自证（原本就红的情况改后仍然红，见 §3 夹具 C 与 §4 负控制）：`--base HEAD~1` 的真泄漏在改前后都是
退出码 1；`AM`/`AMR` 都包含它所在的 `A` 条目。

### 2.2 为什么是 `AMR` 而不是 `AMRD`（双夹具对照）

独立审查（`88170f24`）提出、本片**自己复跑复现**：`D` 不能进 filter，否则会把「文件已不在待发布树里」的
形状当成待发布内容。对照做法是把 `--diff-filter=AMR` 机械替换成 `AMRD`（两处）另存为
`release-gate-amrd.mjs`，同一夹具、同一参数各跑一遍。

夹具 G——`git rm --cached ghost.bin`（git 记成 `D`，但文件仍在工作树里，并不进入待发布版本）：

```text
git -C <夹具G> --name-status HEAD~1 HEAD   ⇒ D	ghost.bin     (工作树里 ghost.bin 仍在)

# AMR（本片实现）
node tools/release-gate.mjs --root <夹具G> --base HEAD~1 --only artifacts
⇒ EXIT 0    verdict=pass  scannedFiles=0  findings=[]

# AMRD（对照，仅把两处 filter 换成 AMRD）
node release-gate-amrd.mjs --root <夹具G> --base HEAD~1 --only artifacts
⇒ EXIT 1    verdict=fail  scannedFiles=1  findings=["ghost.bin:binary"]   ← 假红
```

夹具 F——同一提交里真删除两个二进制（`D` + `D`，没有 A/M/R）：

```text
git -C <夹具F> --name-status HEAD~1 HEAD   ⇒ D	a.bin / D	b.bin

AMR  ⇒ EXIT 0  verdict=pass  scannedFiles=0  findings=[]
AMRD ⇒ EXIT 0  verdict=pass  scannedFiles=2  findings=[]      ← 不红，但 scannedFiles 被删除项污染（0 → 2）
```

两条结论：① `D` 会在「文件还在、只是不跟踪了」的形状上制造**假红**，而 `AMR` 判 `passed` 才是对的；
② 即便不假红，`D` 也会把删除项算进 `scannedFiles`，而该字段语义是「扫过的**待发布**文件数」——多算等于
报告自己在说谎，也会破坏新增用例②对 `scannedFiles === 2` 的语义。所以边界停在 `AMR`。

## 3 补丁 2 的读数（改前 / 改后）

夹具 C：`git init -q -b trunk`，**无 remote、无 `main`/`origin/main`/`upstream/main`**；baseline 提交之后，
HEAD 上有一个真泄漏文件 `leak.txt`。HEAD = `ebcbdd47`，HEAD~1 = `67d8b5d1`。

```text
# 改前·默认（不给 --base，候选链一路落到 HEAD）
⇒ EXIT 0    base.ref=HEAD  base.sha=ebcbdd47  status=passed  scannedLines=0     ← 空 diff 假绿

# 改前·--base HEAD~1（同一个仓库里的真泄漏）
⇒ EXIT 1    scannedLines=4  hits=["leak.txt:1","leak.txt:2","leak.txt:4"]        ← 原本就红

# 改后·默认（不加 flag：行为必须完全不变）
⇒ EXIT 0    base.ref=HEAD  scannedLines=0

# 改后·--require-base
⇒ EXIT 2    stdout 为空、报告不落盘
   stderr 首行 = 用法错误：--require-base 要求基线不是 HEAD，但当前基线就是 HEAD（ref=HEAD，sha=ebcbdd47）：
   此时 `<base>...HEAD` 必为空 diff，扫 0 行也判 pass，等于把「没看」当成「没问题」。
   请把 --base 指到待发布分支与主干的共同祖先（CI 里用 --base origin/main）

# 改后·--require-base --base HEAD（显式把基线指到 HEAD，同样要拒）
⇒ EXIT 2    同上文案

# 改后·--base HEAD~1（真泄漏照样红）
⇒ EXIT 1
# 改后·--require-base --base HEAD~1（合规基线 + 真泄漏 ⇒ 1，不是 2）
⇒ EXIT 1
```

夹具 D（**不误伤**）：有 `main`，HEAD 在 `feature` 分支上，基线解析到 `main`（`a28dbd98`）：

```text
改后·默认        ⇒ EXIT 0  scannedLines=1
改后·--require-base ⇒ EXIT 0  scannedLines=1   ← 基线 ≠ HEAD，不误伤
```

判据落点：合规定义是「`resolveBase` 解到的 `sha` 非空**且**不等于 `HEAD` 的 sha」。
`--base HEAD` 与「默认 fallback 落到 HEAD」走同一条判定（都看 `ctx.base.sha === headSha`），
所以不存在「显式写 HEAD 就绕过」的口子。

## 4 新增用例与红/绿原文

`tests/unit/release-gate.test.mjs`：394 行 → 545 行（+151）；用例 10 条 → **13 条**（原有 10 条一字未改、名字与顺序不变）。
另把夹具 helper 扩成 `makeGitFixture(files, branch = 'main')`，以便造出「没有 `main` 分支」的仓库
（否则 `--require-base` 测不到「默认 fallback 落到 HEAD」那条路径）；既有 10 条的调用点不受影响。

| # | 用例名 | 断言要点（原文） |
| --- | --- | --- |
| ① | 门禁·改名（git mv）后追加疑似密钥：AMR 必须扫到并判红（AM 下是 0 行假绿） | `assert.match(nameStatus, /^R\d+\tclean\.txt\tmoved\.txt$/m)` → `assert.equal(exit, 1, '改名后的疑似密钥必须判红')`、`assert.equal(details.scannedLines, 1)`、`assert.deepEqual(hits, ['moved.txt:21'])`、`assert.equal(hits[0].rule, 'openai-style-key')` |
| ② | 门禁·改名后的大文件/二进制必须被抓到（纯改名 R100 也不能漏） | `assert.match(nameStatus, /^R100\tbig\.txt\trenamed-big\.txt$/m)` → `assert.equal(exit, 1, '改名后的大文件/二进制必须判失败')`、`assert.equal(details.scannedFiles, 2)`、findings 断言 `renamed-big.txt → 'too-large'` 与 `renamed-blob.bin → 'binary'` |
| ③ | 门禁·--require-base：默认基线落到 HEAD ⇒ 2，而 --base HEAD~1 的真泄漏仍为 1 | ①默认：`assert.equal(loose.status, 0)`、`assert.equal(details.base.ref, 'HEAD')`、`assert.equal(details.base.sha, git rev-parse HEAD)`、`assert.equal(details.scannedLines, 0)`；②`--require-base`：`assert.equal(strict.status, 2, '--require-base 下基线落到 HEAD 必须退 2')`、`assert.equal(strict.stdout, '')`、`assert.equal(existsSync(out), false)`、`assert.match(strict.stderr, /--require-base 要求基线不是 HEAD/)`；②b `--base HEAD --require-base` ⇒ 2；③`--base HEAD~1` ⇒ `assert.equal(leaky.status, 1)` 且 `hits.length >= 3`；③b `--base HEAD~1 --require-base` ⇒ `assert.equal(leakyStrict.status, 1)`、`assert.equal(verdict, 'fail')`；④不误伤：有 `main` + `feature` 分支 ⇒ `--require-base` 仍 0 且 `base.ref === 'main'`；⑤`--help` ⇒ 0 且 stderr 含 `--require-base` |

### 4.1 绿：改后跑全文件

```text
node --test tests/unit/release-gate.test.mjs
✔ 门禁·全过场景：退出码 0、verdict=pass、报告文件与 stdout 同字节
✔ 门禁·注入失败：退出码 1、失败项带 exitCode 与 ≤3 行首条关键错误行，后续步骤不再执行
✔ 门禁·--only 只跑点名项，--skip 剔除点名项
✔ 门禁·用法错误（未知 id／过滤后为空／only 与 skip 同给）退出码 2，且不产出报告
✔ 门禁·泄漏扫描命中：四条规则都报，且密钥原文不进 stdout／报告
✔ 门禁·泄漏扫描未命中：干净新增文件判 pass，且确实扫过新增行
✔ 门禁·自指回归：本脚本源码自己不得命中自己的扫描规则
✔ 门禁·大文件与二进制检查：超阈值、二进制都判失败；白名单扩展名可放行
✔ 门禁·真库臂默认跳过并带理由（--only pg 不执行命令、退出码 0）
✔ 门禁·产物契约：--list 列六个门禁、--help 退出码 0、包管理器判定写进报告
✔ 门禁·改名（git mv）后追加疑似密钥：AMR 必须扫到并判红（AM 下是 0 行假绿）
✔ 门禁·改名后的大文件/二进制必须被抓到（纯改名 R100 也不能漏）
✔ 门禁·--require-base：默认基线落到 HEAD ⇒ 2，而 --base HEAD~1 的真泄漏仍为 1
ℹ tests 13   ℹ pass 13   ℹ fail 0
```

### 4.2 红（负控制）：把 `tools/release-gate.mjs` 换回 `origin/main` 版，只跑三条新用例

```text
node --test --test-name-pattern="AMR|R100|require-base" tests/unit/release-gate.test.mjs
✖ 门禁·改名（git mv）后追加疑似密钥…            AssertionError: 改名后的疑似密钥必须判红  actual: 0, expected: 1
✖ 门禁·改名后的大文件/二进制必须被抓到…          AssertionError: 改名后的大文件/二进制必须判失败  actual: 0, expected: 1
✖ 门禁·--require-base…
    AssertionError: 报错必须说清判据是「基线不是 HEAD」
    actual: '用法错误：未知选项：--require-base\n\n发布门禁汇总（release gate）…'（旧工具整份 USAGE）
    expected: /--require-base 要求基线不是 HEAD/
ℹ tests 3   ℹ pass 0   ℹ fail 3
```

第 ③ 条一开始断言写的是 `/--require-base/`，负控制暴露它**太弱**：旧工具报「未知选项：--require-base」也匹配，
`/HEAD/` 还会被 USAGE 里的「`… → main → HEAD` 解析」蒙过去。已收紧成
`/--require-base 要求基线不是 HEAD/`（只有新文案里有这一串），负控制重跑仍红、正跑仍绿。
这说明用例验的是**判据**，不是「flag 名字出现过」。

## 5 闸门读数

全部读数的树 = 本页所在提交。七道闸门在工作推进的三个前沿各跑过一遍，EXIT **全为 0**：
首轮 `4c7cb2d7`、P2 修订后 `487977f0`、以及把 `origin/main`（`f130343e`，"R90 本机绝对路径清查" #1140）并入分支之后的 HEAD。
此后每次把 `origin/main` 再并进本分支（主干一直在动），都按同表整套重跑，EXIT 同样全为 0。
本页刻意不钉死最终提交号——写进去就过期；要复核请对当时的 HEAD 重跑下表命令。

| # | 闸门 | 命令 | 尾行原文（节选） | EXIT |
| --- | --- | --- | --- | --- |
| 1 | 四连 strict 锚点 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | `本次：不在区间 44、UNDECLARED 259、配成对 1329`（基线 44 / 265 / 1051）＋`PASS: --strict 下没有基线之外的新增` | **0** |
| 2 | 锚点位移恒等（identity） | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | `ℹ tests 37　ℹ pass 36　ℹ fail 0`（另 1 条 SKIP） | **0** |
| 3 | 契约状态 | `node tools/verify-contract-status.mjs` | `PASS: 行号区间 324 条…整段仅空白/收尾行 0 条`、`PASS: 中文表格一致` | **0** |
| 4 | 开发文档 | `npm run test:docs` | `PASS: 识别 5 页 / 跳过 368 页（扫描面 373 页：docs/verification）——读数七条判据全部自洽` | **0** |
| 5 | G 档演练读数 | `node tools/verify-g-drill-readings.mjs --check` | `✓ 八条判据全过：workflows 15 / jobs 30 / 演练 21 条 / 测试文件 609（glob 合计 579）` | **0** |
| 6 | 与 main 的合并干净度 | `git merge-tree --write-tree --name-only origin/main HEAD` | 只输出一行树 oid，其后没有冲突文件名（有冲突才会列文件） | **0** |
| 7 | 证据页注释锚点 | `node tools/verify-verification-comment-anchors.mjs` | `本次命中 1422、基线 1422、基线外新增 0、可收紧 0` | **0** |

第 7 道第一遍是**红的**（`基线外新增 4`）：本页把 4 个锚点指到了注释行（`tools/release-gate.mjs` 里的块注释
首行与 `main` 里的行注释）。已把这 4 个锚点改到实质代码行（`tools/release-gate.mjs:505` /
`tools/release-gate.mjs:542` / `tools/release-gate.mjs:484-495` / `tools/release-gate.mjs:1014-1022`），
重跑为 0。没有用 `--write-baseline` 登记，也没有改判据。

另外跑过（不属七道闸门，但与本片直接相关）：`node --test tests/unit/release-gate.test.mjs` ⇒ 13/13 绿（§4.1），
`node --check` 两个改动文件均通过。

**没跑全量 `npm run test:unit`**：取证机当时 `Get-Process node` 有 60 个进程（派单阈值 >6 即不跑），
按派单只跑受影响文件，全量以 CI 为准（见 §6）。

## 6 本片不声称

- **不声称 release-gate 已进 CI**。本片只改脚本、测试与文档；`.github/**` 一字未动，CI 里没有任何 job
  跑 `tools/release-gate.mjs`。接 workflow 是下一片（另开 PR），本页的「CI 用法」只是给那一片的建议参数。
- **不声称覆盖 pg 臂**。`pg` 门禁默认跳过（需要的真库环境本片没有），本片所有读数都只涉及
  `secrets` / `artifacts` 两臂；`--require-base` 是前置判定，与跑哪几臂无关，但它在 `--only pg` 下的行为
  本片**没有**单独取过证据。
- **不声称能扫出历史泄漏**。`secrets`/`artifacts` 只看 `<base>...HEAD` 的 diff；仓库里已经存在的泄漏
  两个补丁都翻不出来（这正是 §6 之外的既有边界，见 `docs/release/release-gate.md`）。
- 不声称改名的相似度阈值、`--find-renames` 的默认档位在各 git 版本上一致：本片只在取证机（git for Windows）
  上验过 `R093`/`R100` 两种形态；相似度低于 git 默认阈值时 git 会记成 `D`+`A`，那本来就在 `AM` 里。
- 不声称 `--require-base` 能替代「基线选对」：它只能证明基线**不是 HEAD**，证明不了基线**选得对**
  （`--base HEAD~5` 同样会被放行）。
- 不声称本片跑过全量 `npm run test:unit`：取证机当时有 60 个 node 进程，按派单要求只跑受影响文件，
  **全量以 CI 为准**。

## 7 派单与实测的出入

- 派单给的改前行号 475 / 511 与 `origin/main` 版**完全一致**（实测行号同值，分别指向两处 `--diff-filter=AM`），
  改后因新增代码前移为 `tools/release-gate.mjs:505` / `tools/release-gate.mjs:542`——不是派单写错，是插入行导致的位移，本页两套行号都给。
- 派单预写的读数（夹具 A：改前 0 行 / 改后 `moved.txt:21`；夹具 C：默认 0 / `--require-base` 2 /
  `--base HEAD~1` 1）与实测**逐条吻合**，无需修正。
- 派单未提、实测补上的一条：`docs/release/release-gate.md` 的「参数一览」在 §1（不是单独小节），
  加行后整页 183 → 203 行；该页**本提交内被改**，按仓库规矩不需要登记
  `tests/unit/doc-anchor-relocations.json`（登记只针对「目标文件本次未改」的漂移，本页 692 条登记里
  没有一条指向它）。

## 8 审查后修订（P2，追加提交）

独立审查（`88170f24`）带 nit 通过（P0/P1 均为 0），四条 P2 已在本分支追加提交里修掉；改动只在文档与证据页，
`tools/**` 与 `tests/**` 的代码一字未动（因此 §2–§4 的读数无需重跑，仍对应 `4c7cb2d7` 与之前的实现）。

| # | 位置 | 改前 | 改后 |
| --- | --- | --- | --- |
| P2-1 | 本页元信息表与 §4 | `1010 行` / `1052 行`；`394 行 → 543 行` | `1009 行` / `1051 行`；`394 行 → 545 行（+151）`——原先按 `split('\n')` 的尾部空串少算/多算，现按 `wc -l` 口径 |
| P2-2 | 本页元信息表、§5 末句 | 「六道闸门」 | 「七道闸门」——§5 表里本来就是 7 行（四连 strict、identity、contract-status、test:docs、g-drill、merge-tree、verification-comment-anchors） |
| P2-3 | `docs/release/release-gate.md` §7 | 只写「`push` 落到 HEAD ⇒ 空 diff 假绿」 | 显式写明「`--require-base` 仅适用 `pull_request`（或其它 `origin/main != HEAD`）事件；`push` 到 `main` 时 `origin/main` 就是 `HEAD`，照抄会**恒退出 2**，属按设计行为」 |
| P2-4 | `docs/release/release-gate.md` §3.1 退出码表 | 退出码 `2` 的典型场景里没有 `--require-base` | 补「`--require-base` 下基线解析不到或解析结果就是 `HEAD`」 |
| P2-5 | `docs/release/release-gate.md` §8 | 「纯删除（`D`）仍不扫，因为删掉的代码不进入待发布版本」 | 换成实测理由（§2.2 的夹具 F/G）：`git rm --cached` 假红 + `scannedFiles` 语义污染 |

跳过 P2-6（用例③ 里 `/HEAD/` 冗余断言）：它不影响判别力，且已被更强的
`/--require-base 要求基线不是 HEAD/` 覆盖；删它要重跑全套用例，收益为零。
