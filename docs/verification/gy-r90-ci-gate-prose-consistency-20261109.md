# R90 CI workflow「散文声称的组数」↔「闸门真值」一致性守卫（2026-11-09）

> 读数快照：2026-11-09（Asia/Hong_Kong），基线 `215e9e2bd7b52f01f242ced8f25b8ea8ac144246`（`origin/main`，
> `test(community): 修正 #1102 两处 P2 措辞`）。
> 本页所有 `.github/workflows/**` 行号按这一版核；本提交**不改** `.github/**`，因此被引用的 workflow 行号
> 不需要任何位移登记（`.github/**` 在 `215e9e2b` 上就是本页引用时的内容）。
> 本提交只新增两个文件：`tests/unit/ci-gate-prose-consistency.test.mjs` 与本页。

## 一句话

`tests/unit/ci-gate-prose-consistency.test.mjs` 把「workflow 注释散文里声称的组数」与「同一个 job／step
真正的 `-lt N` 闸门数字」**机械对上**：真实扫描今天 15 个 workflow、29 个 job，其中 4 个 job 带组数闸门
（16 道闸、39 道 rc 闸）；37 处落在带闸 job 里的散文声称中 25 处匹配、2 处不一致、10 处判不了，
**0 道闸门没有散文钉住**。10 处判不了 + 2 处不一致逐条登记进文件内允许清单，每条带「为什么本轮不改」
与「该由谁改」，且每次跑测试都重新验证一遍（修好即 stale ⇒ 红），清单不会是永久豁免。

## 一、动机：两次「闸门 11、散文 8」

两起真实事故，都不是守卫发现的，是人肉审查发现的：

1. `#1093` 之前，`real-pg-http-17-11` job 的注释头（`.github/workflows/real-pg-integration.yml:1676`、
   `.github/workflows/real-pg-integration.yml:1678`、`.github/workflows/real-pg-integration.yml:1699`）
   长期写「8 组 PASS」，而 job 内的闸门是 `pass_groups -lt 11`
   （`.github/workflows/real-pg-integration.yml:1787`，失败文案在
   `.github/workflows/real-pg-integration.yml:1788`「应当 ≥ 11」）。`#1093` 只改掉这三条注释
   （`1 file changed, 3 insertions(+), 3 deletions(-)`，三处全在注释里），闸门数字一个字没动；
   `#1096` 之后才把 `-lt 11` 这道读数闸补进扫描面。
2. 同一次事故里 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `reason` 散文也写着「8 组」，
   与真实读数 11 组不符 —— 散文和闸门分处两个文件、各有一套判据，谁也不会因为对方变了而红。

R89 已经补了一道**只针对 `real-pg-http-17-11`** 的判据（`tests/unit/ci-real-pg-readings-gates.test.mjs`
判据⑧，写在 `docs/verification/gy-r89-readings-gate-pass-groups-20261108.md` §八.4 的已知缺口里：
「其余 6 个 job 的注释头有没有写死组数、写没写错，没有任何判据在看」）。本片把这条关系**推广到全部
workflow、全部 job**，并把「判不了」从「静默跳过」改成「必须登记、且登记会过期」。

## 二、扫描面读数（`判据①` 打印的那一行，实测）

```
[ci-gate-prose] 扫描面：15 个 workflow、29 个 job（其中 4 个带组数闸门）、16 道组数闸门、
39 道 rc 闸、51 处散文声称、匹配 25、不一致 2、判不了 10、闸门无散文 0
```

逐项说明：

- **15 个 workflow**：`.github/workflows/*.yml` 全量；本单点名的 `real-pg-integration.yml` 与
  `engineering-shell.yml` 必须在场（缺一个即红）。
- **29 个 job**：按 `^jobs:` 之后 `^  <key>:` 切块、块首吸收 key 上方连续的 `#` 注释、块尾取下一个
  job 的**注释头起点**。`tools/verify-g-drill-readings.mjs` 的读数独立给出同一组数（15 / 29），两处口径重合
  是个意外的交叉校验。
- **4 个带组数闸门的 job** 全在 `real-pg-integration.yml`：`real-pg-17-11`（7 道）、
  `real-pg-admin-read-17-11`（2 道）、`real-pg-admin-write-17-11`（6 道）、`real-pg-http-17-11`（1 道）。
- **16 道组数闸门 / 39 道 rc 闸**：`-lt N`（`-le`/`-gt`/`-ge` 同档）且 `N > 0` 归组数闸；`-ne 0` / `!= 0`
  归 rc 闸（退出码不是读数），不参与一致性判定。
- **51 处散文声称**：`N 组` / `N 条读数` / `基线 N` / `≥ N` / `< N` / `共 N 组` 六种形态。其中只有 **37 处**
  落在「带组数闸门的 job」里（25+2+10），另外 14 处落在没有组数闸门的 job 里 —— 没有闸门就没有「闸门声称」，
  本文件不判它们（见 §七）。
- **`engineering-shell.yml` 是 0**：8 个 job、0 道数值比较、0 处组数散文。判据① 把它钉成「覆盖到了且确实是 0」，
  免得以后有人以为它被漏扫。
- 其余两个出现过数值比较的 workflow（`deploy-sql-gate.yml`、`evaluation-chain.yml`）里只有 `-ne 0` rc 闸，
  因此 0 道组数闸门、0 处需要判定的散文。

## 三、判据与绑定顺序（`tests/unit/ci-gate-prose-consistency.test.mjs` 文件头 ①–⑦）

① 扫描面全量 + 两个点名文件；② job 分块（块首含注释头、块尾取下一块注释头起点）；③ 只认
`"$var" -lt N` / `-ne N` / `!= N`，`pg_isready`／`timeout-minutes`／`5432:5432` 按构造不会命中（有 fixture 反例）；
④ 六种散文形态，**不**把裸 `= N` 当门槛（「3 条前置 + 装包 5 + 两条臂各 5 = 22」是加法）；⑤ 绑定顺序
＝先按变量名（散文行点名了哪道闸的变量就绑它）→ 所在 step 内唯一的组数闸 → 所在 job 内唯一的组数闸 →
都不成立记 `unbound`（**判不了就登记，绝不默认放行**）；⑥ 允许清单会过期；⑦ 每道闸门都得有散文钉住
（否则闸门是隐形的）。

今天 16 道闸门 **16/16** 都有散文钉住（`unclaimed` = 0），这是一条正面读数：改任何一道闸门数字，
至少会翻一处散文判据。

## 四、今天的 12 处「不一致 / 判不了」——逐条与允许清单

`.github/**` 属 B 档，本单**明确禁止**改 yml ⇒ 12 条全部登记在测试文件内的 `ALLOWLIST`，逐条写清
「为什么本轮不改」+「该由谁改」。全部落在 `real-pg-integration.yml` 的 `real-pg-17-11` 这一个 job 里
（它有 7 道读数闸，散文里的数字大多不是闸门数字，位置规则判不了）。

| # | key（`file#job:line:claim:kind`） | kind | 闸门 | 为什么本轮不改 | 该由谁改 |
| --- | --- | --- | --- | --- | --- |
| 1 | `real-pg-integration.yml#real-pg-17-11:240:5:unbound` | unbound | — | `.github/workflows/real-pg-integration.yml:240`「自建 5 组角色 + 运行时 LOGIN」数的是合成脚本造的数据库**角色**个数，不是读数门槛；该 step 没有 `-lt` 闸，job 有 7 道 ⇒ 判不了 | 后续改 yml 的 B 档单 |
| 2 | `real-pg-integration.yml#real-pg-17-11:243:13:unbound` | unbound | — | `.github/workflows/real-pg-integration.yml:243`「exit=0，PASS 13 组」是本地取证的一次实测读数，不是门槛 | 同上（或把取证读数挪到证据页） |
| 3 | `real-pg-integration.yml#real-pg-17-11:258:13:unbound` | unbound | — | `.github/workflows/real-pg-integration.yml:258` 同 :243，另一处「PASS 13 组」取证记录 | 同上 |
| 4 | `real-pg-integration.yml#real-pg-17-11:351:23:mismatch` | mismatch | 41 | `.github/workflows/real-pg-integration.yml:351` 同一行既有真值「读数 41 组」又有历史值「旧值 23 组已过时」；23 被当成第二处声称 ⇒ 与闸门 41 判成不一致。语义上它已标注「已过时」，属扫描器**已知假阳性形态**；本轮不放宽扫描器（放宽会漏真漂移） | 改 yml 的 B 档单：把「旧值 23 组已过时」改成不带数字的措辞，改完删本条 |
| 5 | `real-pg-integration.yml#real-pg-17-11:545:17:unbound` | unbound | — | `.github/workflows/real-pg-integration.yml:545`「17 条读数，全部断言通过」是该 step 自己脚本打印的读数条数，该 step 内没有 `-lt` 闸 | 同上 B 档单 |
| 6 | `real-pg-integration.yml#real-pg-17-11:585:13:unbound` | unbound | — | `.github/workflows/real-pg-integration.yml:585`「`RESULT=PASS 13 组`」是取证输出摘录 | 同上 |
| 7 | `real-pg-integration.yml#real-pg-17-11:684:8:unbound` | unbound | — | `.github/workflows/real-pg-integration.yml:684`「它自证 8 组」说的是该臂脚本自己的读数条数；这一步没有闸 | 同上 |
| 8 | `real-pg-integration.yml#real-pg-17-11:737:8:unbound` | unbound | — | `.github/workflows/real-pg-integration.yml:737`「8 组读数：①首次…」描述该 step 的 8 条读数构成 | 同上 |
| 9 | `real-pg-integration.yml#real-pg-17-11:750:8:unbound` | unbound | — | `.github/workflows/real-pg-integration.yml:750`「43 个迁移 + 8 组读数」是超时预算的**加法项**（≈40 s 的实测构成），不是门槛 | 同上 |
| 10 | `real-pg-integration.yml#real-pg-17-11:753:8:unbound` | unbound | — | `.github/workflows/real-pg-integration.yml:753`「`[A]`–`[H]` 8 组读数 + 末行 `[ALL PASS]`」说明该臂读数形态 | 同上 |
| 11 | `real-pg-integration.yml#real-pg-17-11:780:11:unbound` | unbound | — | `.github/workflows/real-pg-integration.yml:780`「全链 46 个迁移 + 11 组读数」同样是超时预算加法项 | 同上 |
| 12 | `real-pg-integration.yml#real-pg-17-11:844:13:mismatch` | mismatch | 19 | `.github/workflows/real-pg-integration.yml:844` 讲基线演进：「旧基线 13 时删掉 ⑩/⑪ 仍剩 16 ≥ 13 … 抬到 19」。13/16 是历史值，19 才是现闸门（`.github/workflows/real-pg-integration.yml:868` 的 `-lt 19`）；扫描器按数字取第一处 ⇒ 13 与 19 判成不一致 | 改 yml 的 B 档单：历史值改成扫描器不当门槛的措辞，改完删本条 |

两条 `mismatch` 的共同点值得记下来：它们**不是**「散文写错了」的旧事故复发，而是「同一行同时出现
现值和历史值」这种新形态。本片选择**如实登记而不是放宽扫描器**，因为任何「认旧值」的放宽都会把
「散文从 11 漂回 8」这类真漂移一起放过 —— 那正是本文件存在的理由。

## 五、变异自证（两处落盘变异，跑完逐字还原）

两次变异都在工作树上改 `.github/workflows/real-pg-integration.yml`，跑完 `node --test` 立刻
`git checkout -- .github/workflows/real-pg-integration.yml` 还原（`git status --porcelain` 只剩新增的
测试文件），**没有任何 yml 改动进入提交**。

### 5.1 M1：闸门侧 `-lt 11` → `-lt 8`（`.github/workflows/real-pg-integration.yml:1787`）

命中 1 处，`node --test tests/unit/ci-gate-prose-consistency.test.mjs` ⇒ `tests 9 / pass 6 / fail 3`：

```
✖ 判据④⑤：真实扫描 —— 今天每一处「不一致 / 判不了」都必须与允许清单逐字相等
  AssertionError [ERR_ASSERTION]: 允许清单与扫描结果不是同一集合：…
  +   'real-pg-integration.yml#real-pg-http-17-11:1676:11:mismatch',
  +   'real-pg-integration.yml#real-pg-http-17-11:1678:11:mismatch',
  +   'real-pg-integration.yml#real-pg-http-17-11:1699:11:mismatch',
  +   'real-pg-integration.yml#real-pg-http-17-11:1787:8:unclaimed',
  +   'real-pg-integration.yml#real-pg-http-17-11:1788:11:mismatch',
✖ 判据⑦：真实文件里 16 道组数闸门全部有散文钉住，且 http 臂那道就是 11（事故锚点）
  AssertionError [ERR_ASSERTION]: 有闸门没有任何散文钉住 ⇒ 闸门是隐形的
  +   'real-pg-http-17-11:1787'
✖ 判据②：变异自证 —— 把 `-lt 11` 改成 `-lt 8` 必须红（内存变异，不落盘）
  AssertionError [ERR_ASSERTION]: 变异锚点「pass_groups" -lt 11」在文本里出现 0 次，预期 1 次
```

三条红的位置分别是 `.github/workflows/real-pg-integration.yml:1676`、`:1678`、`:1699`、`:1787`、`:1788`
（判据④⑤ 与 ⑦），以及判据② 自己的锚点计数（变异已在盘上做过一次，内存里再变就找不到锚点 —— 这条
恰好证明 `mutate()` 的锚点断言不是摆设）。

### 5.2 M2：散文侧 `N ≥ 11` → `N ≥ 8`（`.github/workflows/real-pg-integration.yml:1699`）

命中 1 处，同样 `tests 9 / pass 6 / fail 3`：

```
✖ 判据④⑤：… +   'real-pg-integration.yml#real-pg-http-17-11:1699:8:mismatch'
✖ 判据⑦：… http 臂四处散文（1676/1678「11 组 PASS」+ 1699「N ≥ 11」+ 1788「应当 ≥ 11」）必须全是 11
  +   '1699:8',
  -   '1699:11',
✖ 判据②：… 闸门被改小后应正好 4 处散文不再匹配，实测 3（1676、1678、1788 三行各 11 处）
```

### 5.3 还原后

```
node --test tests/unit/ci-gate-prose-consistency.test.mjs ⇒ ℹ tests 9 / pass 9 / fail 0
git status --porcelain ⇒ ?? tests/unit/ci-gate-prose-consistency.test.mjs（workflow 逐字还原）
```

（上面这条 `git status` 是本页落盘之前的读数；本页写入后同一条命令会多出本页这一行 untracked / 已提交。）

## 六、闸门读数

全部在本工作树 `E:\GengYunCommander\.pg17\wt-gateprose`（分支 `test/gy-r90-gate-prose-consistency`，基线 `215e9e2b`，本页就装在本分支第一个提交里）上跑；`.github/**`、`services/**`、`tools/**` 一个字节都没动。

| # | 闸门命令 | 读数（逐字） | 结论 |
| --- | --- | --- | --- |
| 1 | `node --test tests/unit/ci-gate-prose-consistency.test.mjs` | `ℹ tests 9 / pass 9 / fail 0`（184 ms） | 绿 |
| 2 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | `EXIT=0`；`BASELINE: 登记 48 条；本次命中 48 条、基线外新增 0 条、陈旧 0 条`；`BARE-ORPHAN: 登记 3469 条；本次命中 3469 条、基线外新增 0 条、陈旧 0 条` | 绿（本页加进来前后裸锚点册同为 3469/3469 ⇒ 本页 0 条新增） |
| 3 | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | `ℹ tests 37 / pass 36 / fail 0 / skipped 1`；SKIP 原文（`<基线>..<本次提交>` 那段 SHA 随提交改写而变，这里只钉理由）：`本次文档提交只有新增行，没有锚点位移面（1 个纯新增 hunk）` | 绿（纯新增文档 hunk ⇒ 显式 SKIP，且不是「扫描面为空」的假 SKIP：夹具 A1 钉的正是这条） |
| 4 | `node tools/verify-contract-status.mjs` | `EXIT=0`；`覆盖 130 条契约操作；已装配 130 条；形状错误 0 项；语义错误 0 项` | 绿 |
| 5 | `npm run test:docs` | `EXIT=0`；`PASS: 识别 5 页 / 跳过 354 页（扫描面 359 页）` | 绿 |
| 6 | `node tools/verify-g-drill-readings.mjs --check` | `EXIT=0`；`✓ 八条判据全过：workflows 15 / jobs 29 / 演练 21 条 / 测试文件 604（glob 合计 574）`（8 条生长型读数滞后，按下界判） | 绿 |
| 7 | `git merge-tree --write-tree --name-only origin/main HEAD` | `EXIT=0`；`e9a970e91b025a24db2bf357d20a9ecac84f96bb`（除树号外无输出 ⇒ 无冲突、无同名改动） | 绿 |
| 8 | `npm run test:unit`（全量） | **未跑**：跑前 `Get-Process node \| Measure-Object` = **41** 个 node 进程（同机多个子代理并发跑全量），按本仓运行纪律跳过，避免把 6–9 分钟的套件拖成小时级 | 见下「替代读数」 |

全量缺席的替代读数（同一工作树、`GY_BASH=D:\Git\bin\bash.exe`）：新增文件 `9/9` 之外，把**可能被本页 / 本次新增触及**的既有文件一次跑掉 ——
`ci-integration-chain-structure`、`ci-real-pg-workflows-structure`、`ci-real-pg-wiring`、`ci-real-pg-readings-gates`、`doc-anchors-guard`、`docs-live-counts-shape`、`docs-truth-pins`、`admin-contract-docs` 共 8 个文件 ⇒ `ℹ tests 133 / pass 133 / fail 0`，`EXIT=0`。
**本页不声称全量 `test:unit` 已绿**；全量结论以 PR 的 `gh pr checks` 为准。

## 七、不声称

1. **不声称覆盖所有散文形态**。判据④ 只认 `N 组` / `N 条读数` / `基线 N` / `≥ N` / `< N` / `共 N 组`；
   「十一条」「组数 = 11」「11 条断言」「ELEVEN」这类写法抓不到。裸 `= N` 故意不认（它是加法，不是门槛）。
2. **不声称能替代人工语义审查**。它判的是「数字是否一致」，不是「散文说得对不对」。像 §四 #4／#12
   这种「同一行既有现值又有历史值」的句子，扫描器只能报告不一致，判断「这是历史叙述、不是漂移」必须靠人。
3. **不声称改动了 yml**。`.github/**` 一字未改（两次变异都已还原，见 §五；`git diff --name-only` 只有两个新文件）。
4. **不声称覆盖没有组数闸门的 job**。51 处散文声称里有 14 处落在「没有 `-lt` 闸门」的 job 里 ——
   没有闸门就没有「闸门声称」，本文件不判；这 14 处是否该有闸门，是另一件事。
5. **不声称 `-lt` 之外的比较符**。`(( readings < 11 ))`、`test "$readings" -ge 11`、`-gt` 配 `::error::`
   这些写法要么根本没进扫描面、要么进了也会被归到「非 count」档；将来有人换写法，本文件会静默漏收。
6. **不声称允许清单是白名单**。12 条每条都带「为什么本轮不改 + 该由谁改」，且判据⑥ 要求它们**仍然**
   不一致；修好不删 ⇒ 红（`fixture-mismatch` 用例演示了这条路径）。
7. **不声称与 R89 的判据⑧ 重复**。R89 的判据⑧ 只冻 `real-pg-http-17-11` 这一个 job 的注释头；本文件是
   「全部 workflow、全部 job + 允许清单会过期」。两者都在，谁红了都能定位；R89 那条仍然独立有效。

## 八、与既有守卫的关系（为什么不是重复造轮子）

| 守卫 | 扫描面 | 判什么 | 会不会过期 |
| --- | --- | --- | --- |
| `tests/unit/ci-real-pg-readings-gates.test.mjs` 判据⑧（R89） | `real-pg-http-17-11` 一个 job 的注释头 | 注释头组数 == 该 job 闸门真值 | 不需要（没有清单，全量断言） |
| `tests/unit/ci-integration-chain-structure.test.mjs` | 集成链结构 | `reason` 散文是否描述真实链路 | 不需要 |
| **本文件（R90）** | 15 个 workflow / 29 个 job / 16 道闸 | 每个 job、每个 step 的散文组数 == 对应闸门；**并**要求每道闸门至少被一处散文钉住 | 会：允许清单条目不成立即红 |

三者互补：R89 只有一道闸门的一道判据、`ci-integration-chain-structure` 只讲结构与 `reason` 散文，
本文件第一次把「其余 6 个 job 的注释头有没有写死组数、写没写错」这条已知缺口（R89 页 §八.4 第 4 条）
纳入机械判定，并给出 16/16 闸门都有散文钉住的正面读数。
