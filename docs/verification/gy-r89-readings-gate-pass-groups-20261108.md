# R89 真库臂读数闸门：把 `pass_groups` 那道闸收进扫描面（2026-11-08）

> 读数快照：2026-11-08（Asia/Hong_Kong），基线 `76f647c15331cbc8df17999dd43534f3f0e760ff`
> （`#1093` 合入后的 `origin/main`，`ci(real-pg): real-pg-http-17-11 job 内的组数注释从 8 组口径改为 ≥ 11`）。
> 本页所有 workflow 行号按这一版核；此后 `#1094` / `#1096` 只动文档与锚点登记表（含孤儿册），`.github/**` 在 `76f647c1..origin/main`
> 区间零提交（`git log` 实测为空），故这些行号仍然有效。
> 本提交**不改** `.github/**`，被引用的 workflow 行号因此不需要任何位移登记。
> 本页是独立审查 `98b55f84` 在 PR #1093 上指出的 P2-2 的补口记录。

## 一句话

`tests/unit/ci-real-pg-readings-gates.test.mjs` 的闸门扫描面此前只认「同一行既有 `readings` 又有 `-lt`」，
于是 `real-pg-http-17-11` 里数**组数**的那道闸（变量叫 `pass_groups`）整条落在扫描面之外：
闸门数字、`::error::` 文案、以及注释头里「本机 11 组 PASS」这类散文，没有一条判据看住它。
本提交把扫描面放宽到「数 `$log` 的变量」，给这道闸门冻结基线（期望 11 组 + 被数脚本 + 它的 `say(` 计数），
并新增「注释头散文必须等于闸门真值」这条判据。闸门集合 15 → 16，原有 15 道一道没丢。

## 一、缺口长什么样（P2-2 的原形）

- 旧的扫描口径在 `tests/unit/ci-real-pg-readings-gates.test.mjs` 的 `gateLines()` 里：那一行必须同时出现
  `readings` 与 `-lt`。实测扫出 15 道闸（`.github/workflows/real-pg-integration.yml:187`、
  `.github/workflows/real-pg-integration.yml:294`、`.github/workflows/real-pg-integration.yml:370`、
  `.github/workflows/real-pg-integration.yml:410`、`.github/workflows/real-pg-integration.yml:462`、
  `.github/workflows/real-pg-integration.yml:868`、`.github/workflows/real-pg-integration.yml:910`、
  `.github/workflows/real-pg-integration.yml:1022`、`.github/workflows/real-pg-integration.yml:1056`、
  `.github/workflows/real-pg-integration.yml:1153`、`.github/workflows/real-pg-integration.yml:1182`、
  `.github/workflows/real-pg-integration.yml:1208`、`.github/workflows/real-pg-integration.yml:1236`、
  `.github/workflows/real-pg-integration.yml:1263`、`.github/workflows/real-pg-integration.yml:1296`）。
- 第 16 道在 `.github/workflows/real-pg-integration.yml:1787`：
  `if [ -z "$pass_groups" ] || [ "$pass_groups" -lt 11 ]; then`。它的读数来自
  `.github/workflows/real-pg-integration.yml:1785` 的 `sed -n … | tail -n 1`（从日志末行抽「共 N 组 PASS」），
  失败文案在 `.github/workflows/real-pg-integration.yml:1788`（「应当 ≥ 11」）。
- 变量名里没有 `readings` ⇒ 旧 `gateLines()` 不认它 ⇒ 判据②③⑤⑥ 全都看不见它。后果不是理论上的，但方向要说准：
  这道闸门从接线起就是 `-lt 11`（`76f647c1^` 的 `.github/workflows/real-pg-integration.yml:1787` 与
  `.github/workflows/real-pg-integration.yml:1788` 已经是 11），漂移的是**散文**——`real-pg-http-17-11` 的注释头
  （`.github/workflows/real-pg-integration.yml:1676`、`.github/workflows/real-pg-integration.yml:1678`、
  `.github/workflows/real-pg-integration.yml:1699`）此前写着 8 组，闸门写 11，两边不一致而守卫全绿。
  `#1093` 只改这三条注释（`1 file changed, 3 insertions(+), 3 deletions(-)`，三处全在注释里），闸门数字一个字没动。
  也就是说真实历史是「**闸门 11 + 散文 8**」的漂移，而且它不是守卫发现的，是人肉审查发现的。
- 组数的真值在臂脚本里：`tests/integration/post-media-attach-http-pg.mjs` 有 11 个**无条件** `say(` 调用点
  （裸 `grep` 也是 11，本脚本没有注释里的 `say(`），`passed` 计数器在
  `tests/integration/post-media-attach-http-pg.mjs:188`，末行打印在
  `tests/integration/post-media-attach-http-pg.mjs:930`（`共 ${passed} 组 PASS`）⇒ 组数恒等于调用点数。

## 二、改了什么（只落在 `tests/unit/**`）

1. **扫描面两条口径**（`tests/unit/ci-real-pg-readings-gates.test.mjs:343`）：
   ① 同一行既有 `readings` 又有 `-lt N`（原口径，15 道全走这条）；
   ② 同一行把某个**数日志的变量**放在 `-lt` 左边，而该变量在本 step 里由 `X=$(…"$log"…)` 赋值
   （`tests/unit/ci-real-pg-readings-gates.test.mjs:377` 的 `logCounterVariables` +
   `tests/unit/ci-real-pg-readings-gates.test.mjs:389` 的 `countedVariableInComparison`）。
   ⛔ 不按变量名白名单放宽：retention 三条臂的读数真值就是 8，靠命名会误伤
   （`.github/workflows/real-pg-integration.yml:187` 的 `-lt 8` 数的是 `^PASS ` 行，真值也是 8）。
2. **冻结基线**：基线表新增第 16 条（`step` 在 `tests/unit/ci-real-pg-readings-gates.test.mjs:211`），登记期望组数
   `baseline: 11`（`tests/unit/ci-real-pg-readings-gates.test.mjs:213`）、被数脚本
   `tests/unit/ci-real-pg-readings-gates.test.mjs:212`、计数式（与 `.github/workflows/real-pg-integration.yml:1785` 逐字相等）、以及脚本侧的
   `sayCalls: 11`（`tests/unit/ci-real-pg-readings-gates.test.mjs:215`）。判据⑤ 的「计数式唯一 + 逐字」跟着
   闸门自己的变量名走（`tests/unit/ci-real-pg-readings-gates.test.mjs:430`、
   `tests/unit/ci-real-pg-readings-gates.test.mjs:457`），不再写死 `readings`。
3. **新判据⑧（散文口径）**（`tests/unit/ci-real-pg-readings-gates.test.mjs:786`）：对表里标了 `prose: true`
   的闸门，取所属 job 的注释头（job 键 `real-pg-http-17-11:` 在
   `.github/workflows/real-pg-integration.yml:1707`，注释头是它上面连续的 `#` 行），把里面所有
   「N 组 PASS」与「≥ N」的数字抓出来，**每一个**都必须等于 `-lt N` 的真值；一个数字都抓不到也红。
   用例在 `tests/unit/ci-real-pg-readings-gates.test.mjs:1246`。
4. **新判据⑨（脚本侧真值）**（`tests/unit/ci-real-pg-readings-gates.test.mjs:881`）：`sayCalls` 必须等于
   抹掉注释与字面量后数出来的可执行 `say(` 调用点数，且必须与 `baseline` 同源。这条挡的是「闸门数字与
   期望组数被**一起**改成 8」——那种改法下判据②③ 全绿，只有脚本侧的调用点数会露馅。
   用例在 `tests/unit/ci-real-pg-readings-gates.test.mjs:1271`。
5. **判别力自证**（`tests/unit/ci-real-pg-readings-gates.test.mjs:1292`）：闸门降 3 / 注释头降 3 / 表里
   baseline 降 3 / 脚本少一个 `say(`，四种变异各报一处并点名；原 ⑦ 的九种变异一条没删。
6. **为什么新条目用 `countedScript` 而不是 `script`**：`tools/lib/g-drill-readings.mjs:480` 的 `realPgArms()`
   把守卫测试里**每一行**「`script:` + 带引号的 `tests/integration/…`」都当演练臂清单，而演练清单
   （`docs/verification/gy-r69-drill-full-20261028.md`）里没有这条 HTTP 臂；用 `script` 键登记会让
   `tools/verify-g-drill-readings.mjs` 的判据②③ 当场红。本 PR 不改 `tools/**` 也不改那份文档，故换键名
   （语义不变：仍是「这条闸门数的那个脚本」），臂清单维持 15 条。

## 三、闸门集合：15 → 16（逐行）

| # | 闸门行 | `-lt` | 变量 | 归属 |
| --- | --- | --- | --- | --- |
| 1 | `.github/workflows/real-pg-integration.yml:187` | 8 | `readings` | `real-pg-17-11` |
| 2 | `.github/workflows/real-pg-integration.yml:294` | 25 | `readings` | `real-pg-17-11` |
| 3 | `.github/workflows/real-pg-integration.yml:370` | 41 | `readings` | `real-pg-17-11` |
| 4 | `.github/workflows/real-pg-integration.yml:410` | 10 | `readings` | `real-pg-17-11` |
| 5 | `.github/workflows/real-pg-integration.yml:462` | 7 | `readings` | `real-pg-17-11` |
| 6 | `.github/workflows/real-pg-integration.yml:868` | 19 | `readings` | `real-pg-17-11` |
| 7 | `.github/workflows/real-pg-integration.yml:910` | 14 | `readings` | `real-pg-17-11` |
| 8 | `.github/workflows/real-pg-integration.yml:1022` | 12 | `readings` | `real-pg-admin-read-17-11` |
| 9 | `.github/workflows/real-pg-integration.yml:1056` | 3 | `readings` | `real-pg-admin-read-17-11` |
| 10 | `.github/workflows/real-pg-integration.yml:1153` | 11 | `readings` | `real-pg-admin-write-17-11` |
| 11 | `.github/workflows/real-pg-integration.yml:1182` | 34 | `readings` | `real-pg-admin-write-17-11` |
| 12 | `.github/workflows/real-pg-integration.yml:1208` | 5 | `readings` | `real-pg-admin-write-17-11` |
| 13 | `.github/workflows/real-pg-integration.yml:1236` | 10 | `readings` | `real-pg-admin-write-17-11` |
| 14 | `.github/workflows/real-pg-integration.yml:1263` | 10 | `readings` | `real-pg-admin-write-17-11` |
| 15 | `.github/workflows/real-pg-integration.yml:1296` | 18 | `readings` | `real-pg-admin-write-17-11` |
| **16（新）** | `.github/workflows/real-pg-integration.yml:1787` | **11** | **`pass_groups`** | `real-pg-http-17-11` |

归属按 yml 的 job 键边界（`^  [a-z0-9-]+:`）逐行判定，各 job 加总 = 16，与上表逐行一致：
`real-pg-17-11` 7 道（#1–#7）、`real-pg-admin-read-17-11` 2 道（#8–#9）、`real-pg-admin-write-17-11` 6 道（#10–#15）、
`real-pg-http-17-11` 1 道（#16）；`failmatrix-real-17-11`、`real-pg-ledger-17-11`、`real-pg-jobs-ledger-17-11`
这三个 job 里一道 `-lt` 闸都没有（0 道）。

## 四、变异自证（四项：两项逐字留档，两项在判据⑩ 内部断言）

判据⑩（`tests/unit/ci-real-pg-readings-gates.test.mjs:1292`）在测试内部自证四种变异：闸门降 3 / 注释头降 3 /
表里 `baseline` 降 3 / 脚本少一个 `say(`，每种都断言「恰好报一处并点名」。下面是其中两项**真改工作树**的外部
变异（逐字留档）加还原；另两项只在判据⑩ 的断言里跑，不落工作树。

工具：`node <临时目录>/mut.mjs gate-8|gate-11|prose-8|prose-11`（字节级替换，命中数必须恰好 1，否则 exit 3）。
每次变异都只改 `.github/workflows/real-pg-integration.yml` 一处，跑完立刻还原并用 `git status --porcelain` 复核。

### 4.1 ① 闸门 `-lt 11` → `-lt 8`（`.github/workflows/real-pg-integration.yml:1787`）

```
node <临时目录>/mut.mjs gate-8        ⇒ exit 0，1787 行变成 if [ -z "$pass_groups" ] || [ "$pass_groups" -lt 8 ]; then
node --test tests/unit/ci-real-pg-readings-gates.test.mjs ⇒ exit 1
```

逐字红（判据②，点名 step 与行号）：

```
AssertionError [ERR_ASSERTION]: 表与 yml 必须逐条相等：单边改动（只改 yml 或只改表）都会让闸门数字失去来源
  'step「HTTP 端到端真库臂（R87：上传上限/挂载释放/状态过滤/preValidation 信封/503 逐字文案）」的基线对不上：yml 写 `-lt 8`（第 1787 行），表里是 `baseline: 11` ⇒ 两边必须逐条相等 （yml 被下调/表没跟着改 都会让这条闸门失真）'
```

逐字红（判据⑥，文案仍写 11）：

```
'step「HTTP 端到端真库臂（R87：上传上限/挂载释放/状态过滤/preValidation 信封/503 逐字文案）」的 `::error::` 文案写着 11，而闸门是 `-lt 8`（第 1787 行）⇒ 文案里的阈值必须与闸门数字相等（旧注释的「15 条 / 23 组」就是同一类错）；原文：`echo "::error::HTTP 真库臂退 0，但只数到 ${pass_groups:-0} 组 PASS（应当 ≥ 11）⇒ 有整组断言被删/被跳过，按未取得处理。"`'
```

逐字红（判据⑧，散文仍写 11）：

```
AssertionError [ERR_ASSERTION]: 注释头与闸门不一致：
job `real-pg-http-17-11` 的注释头写着 11（第 1676 行） / 11（第 1678 行） / 11（第 1699 行），而闸门是 `-lt 8`（第 1787 行）⇒ 注释头的组数必须等于闸门真值（改了闸门数字就得同步改注释，反之亦然）；原文：`# 所以「本机 11 组 PASS」不等于「CI 覆盖了它」——这个 job 是它的第一个 CI 读数口。`
```

该次 `node --test` 汇总：`tests 10 / pass 5 / fail 5`（②⑥⑦⑧⑩ 红；⑦⑩ 是自证用例的「基点必须绿」前置）。

### 4.2 ② 注释头「11 组」→「8 组」（`.github/workflows/real-pg-integration.yml:1676`）

```
node <临时目录>/mut.mjs prose-8       ⇒ exit 0，1676 行变成 # 所以「本机 8 组 PASS」不等于「CI 覆盖了它」——…
node --test tests/unit/ci-real-pg-readings-gates.test.mjs ⇒ exit 1
```

逐字红（判据⑧，点名 1676 与 1787，并原样打出注释）：

```
AssertionError [ERR_ASSERTION]: 注释头与闸门不一致：
job `real-pg-http-17-11` 的注释头写着 8（第 1676 行），而闸门是 `-lt 11`（第 1787 行）⇒ 注释头的组数必须等于闸门真值（改了闸门数字就得同步改注释，反之亦然）；原文：`# 所以「本机 8 组 PASS」不等于「CI 覆盖了它」——这个 job 是它的第一个 CI 读数口。`
```

该次 `node --test` 汇总：`tests 10 / pass 8 / fail 2`（只有 ⑧ 与 ⑩ 红；②③⑤⑥⑦ 全绿 —— 红落在散文判据上，
说明定位是准的）。

### 4.3 ③ 还原后全绿

```
node <临时目录>/mut.mjs gate-11；node <临时目录>/mut.mjs prose-11  ⇒ exit 0（各自命中 1 处）
node --test tests/unit/ci-real-pg-readings-gates.test.mjs ⇒ exit 0
```

```
ℹ tests 10
ℹ pass 10
ℹ fail 0
```

`git status --porcelain` 只剩 ` M tests/unit/ci-real-pg-readings-gates.test.mjs`（workflow 逐字还原）。

## 五、全量单测

`npm run test:unit`（`node --test "tests/unit/*.test.mjs" …`）：

```
ℹ tests 6778
ℹ suites 23
ℹ pass 6775
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
ℹ duration_ms 296811.688
EXIT=0
```

`GY_BASH=D:\Git\bin\bash.exe`（本机 `bash` 默认是 WSL 存根，按 `docs/development-guide.md:131` 指路）。

三条 skip 逐条（都不是本次改动引入的）：

- `真 PG17：dry-run → apply → 重放(unchanged) → 失败回滚 四连` ——
  `# SKIP 真 PG17 集成：找不到 PostgreSQL 的 bin 目录（设 GY_PG_BIN 指向含 initdb 的目录，或把 initdb 放进 PATH）。纯逻辑用例不受影响。`
  ⇒ 本机没装 PG，本次也按约定不起集群。
- `文档锚点位移恒等：目标文件没改 ⇒ 行号恒等…` ——
  `# SKIP: d6a263770e23..92de0ab5008c 本次文档提交只有新增行，没有锚点位移面（1 个纯新增 hunk）`
  ⇒ 本提交的文档改动只有新增页，既有文档的带锚点行一行没动，没有位移面可判（该文件的 37 条用例与新页无关，照跑）。
  （区间右端点就是当时 HEAD 的短 SHA；PR 期间 rebase / amend 会换掉它，判据与结论不变。）
- `native separate-connection withdrawal and account state changes at guarded read boundary` ——
  `# SKIP`（既有用例，与读数闸门无关）。

`fail 0` ⇒ 无既有失败，`origin/main` 对照不需要跑。

## 六、六道闸门

全部在最终 HEAD 上跑（工作树干净，提交只含本页与守卫测试两个文件；本页此后只改文字，守卫测试与 workflow
逐字未动，故 ①②④ 在最终 HEAD 上重跑的**计数与结论**相同——② 的 skip 行右端点是当时 HEAD 的短 SHA，不算逐字）。§四 的变异也在同一份文件内容上跑（rebase 只换了父提交，
守卫测试与 workflow 一个字符都没变）。

| # | 闸门 | EXIT | 尾行 |
| --- | --- | --- | --- |
| 1 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | 0 | `PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）` |
| 2 | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | 0 | `ℹ tests 37 / pass 36 / fail 0 / skipped 1`（skip 见 §五：纯新增文档提交无位移面） |
| 3 | `node tools/verify-contract-status.mjs` | 0 | `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` |
| 4 | `npm run test:docs` | 0 | `PASS: 识别 5 页 / 跳过 351 页（扫描面 356 页：docs/verification）——读数七条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字 ⑦同页副本一致）` |
| 5 | `git merge-tree --write-tree --name-only origin/main HEAD` | 0 | 只打印一棵树（无冲突文件名；当轮 `origin/main`＝`cb3bce5e`，对 `upstream/main` 跑同一条是同一棵树） |
| 6 | `git diff --name-only origin/main...HEAD` | 0 | `docs/verification/gy-r89-readings-gate-pass-groups-20261108.md`、`tests/unit/ci-real-pg-readings-gates.test.mjs`（只有这两条） |

附带读数：`node tools/verify-g-drill-readings.mjs --check` ⇒ 0，
`✓ 八条判据全过：workflows 15 / jobs 29 / 演练 21 条 / 测试文件 602（glob 合计 572）…`（臂清单仍 15 条，见 §二 6）；
`node --test tests/unit/post-media-attachments-say-floor.test.mjs` ⇒ 6/6 pass（这份守卫以文本方式读本文件，追加条目不影响它）。

## 七、本提交**没有**做的事

- 不改 `.github/**`：`real-pg-integration.yml` 一字未动。这道闸门是 `-lt 11`
  （`.github/workflows/real-pg-integration.yml:1787`，失败文案在 `.github/workflows/real-pg-integration.yml:1788`），
  注释头的三条散文由 `#1093` 从 8 改成 11（`.github/workflows/real-pg-integration.yml:1676`、
  `.github/workflows/real-pg-integration.yml:1678`、`.github/workflows/real-pg-integration.yml:1699`）；
  本提交只是让守卫开始看住「闸门数字 ↔ 注释数字」这对关系，两边一个数都没改。
- 不改 `tools/**`：`realPgArms()` 的臂清单口径没动，所以新条目换键名（见 §二 6）。
- 不改 `services/**`、`apps/**`、`packages/**`。
- 不把 15 条既有闸门补上 `sayCalls`：那需要逐条核臂脚本的 `say(` 数，是另一件事；本提交只要求
  「登记了就必须对、标了 `prose: true` 就必须登记」。
- 不真跑 PG 集群：新条目的 `source` 写明是**静态计数**（11 个可执行 `say(`），真跑读数留给有集群的一轮 CI。

## 八、同类闸门与已知边界（本 PR 不改）

本页顺带记下形状相同、但这次没动的缺口，供后续派单：

1. **`readings` 之外的变量名**：判据② 现在覆盖「数 `$log` 的变量」，但**不**覆盖「数别的东西的变量」
   （例如 `grep -c` 数一个非 `$log` 文件、或 `wc -l` 数一个临时文件）。
2. **`-lt` 之外的比较符**：`.github/workflows/real-pg-integration.yml` 里读数闸门全是 `-lt`；
   将来若有人写成 `(( readings < 11 ))` 或 `test "$readings" -ge 11` 配 `::error::` 文案，
   扫描面会漏（`GATE_NUMBER` 只认 `-lt`）。
3. **注释头的其它写法**：判据⑧ 只认「N 组 PASS」与「≥ N」。注释头写成「十一条」「组数 = 11」
   「11 条断言」都抓不到（本页 §二 3 已写明这条局限）。
4. **其它 job 的注释头**：目前只有 `real-pg-http-17-11` 标了 `prose: true`。其余 6 个 job 的注释头里
   有没有写死组数、写没写错，没有任何判据在看；要逐个核再登记，本 PR 不做。
5. **被数脚本的「组」定义**：判据⑨ 数的是 `say(` 调用点，不是「断言条数」。若某脚本用 `say(` 打非 PASS
   的提示行（本 HTTP 臂没有这种情况），组数与调用点数会脱钩。

### 8.1 扫描面已知的误收／漏收形状（5 种，都不影响本 PR 结论）

1. **只告警不 exit 的比较被当闸**：`warns=$(grep -c '^WARN ' "$log")` 配 `if [ "$warns" -lt 3 ]`（只 `echo`
   警告、不 `exit 1`）会被口径② 收进闸门集合，判据② 随即要求给它登记基线 —— 对「不是闸的读数」属于误收。
2. **「零失败」语义被当闸并撞判据①**：`failed=$(grep -c '^FAIL ' "$log")` 配 `-lt 1` 同样被收；而 `-lt 1`
   正好撞判据①（反空转禁令），于是这种「零失败」写法一进扫描面就先红在① 上。
3. **`export` 前缀漏收**：`export pass_groups=$(…)` 不是 `VAR=$(…)` 形状（正则要求行首是变量名），口径② 不认。
4. **跨行赋值漏收**：`pass_groups=$(` ⏎ `sed -n … "$log" …` ⏎ `)` 的三行写法，`LOG_COUNTER_ASSIGNMENT`
   只吃单行，漏收。
5. **大写 `$LOG` 漏收**：口径② 只认 `$log` / `${log}`；`$LOG`、`$LOGFILE` 都不认（区分大小写）。

### 8.2 两条维护陷阱（本次踩过或验证过）

1. **`countedScript` 能躲开演练臂正则，只因为那条正则区分大小写**：`tools/lib/g-drill-readings.mjs:480` 匹配的是
   字面 `script: 'tests/integration/…'`（没有词边界）。实测：`countedScript:` 不匹配；但 `counted_script:` 与
   `countedscript:` **都匹配**（它们分别是 `counted_` + `script:` 和 `counted` + `script:`），会被当成第 16 条演练臂
   ⇒ `tools/verify-g-drill-readings.mjs` 的判据②③ 红。改键名时必须保持 `Script` 大写。
2. **`prose: true` 只能给「注释头真写了组数」的条目**：给 `.github/workflows/real-pg-integration.yml:187`
   （retention 臂，真值 8）加 `prose: true` 会立刻**假红** —— 它所属的 `real-pg-17-11` 的注释头 22 行里一个组数
   散文都没有（实测 0 处「N 组 PASS」/「≥ N」），而判据⑧ 的规定是「一个数字都抓不到也红」。
