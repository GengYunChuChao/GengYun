# R87 修掉 failmatrix 两臂的 ETag 强度不对等（C4-12，`PR #1028` 审查 P2-1 的遗留项）

- `origin/main = 1b0a3b63e023804a5f7d448c25b269013ed82de6`（基线与新提交的父提交）；工作树 `E:\GengYunCommander\.pg17\wt-r87-etag`、分支 `test/gy-r87-etag-parity`、建树命令 `git worktree add … 1b0a3b63`。
- 修的是 `tests/failmatrix/cases.mjs` 里 C4-12 自己 `note` 写着的遗留审查意见：`ETag 强度两臂不对等（PR #1028 审查 P2-1）`。`#1028` 合入时补了 stub 臂的强 ETag 断言，真库臂没有对应判据。
- 只动 `tests/failmatrix/**` 与 `docs/**`（本页）；⛔ 没有改 `services/**`、`packages/**`、`.github/**`、`tools/**`、任何基线 json、`tests/unit/doc-anchor-relocations.json`。没有 push、没有建 PR。行号层面**零位移**（判据函数声明在 `cases.mjs` 末尾，见 §5）。

## §1 「不对等」到底是什么（先给证据，再谈修）

| 臂 | 断言位置 | 该条实际判了什么 |
| --- | --- | --- |
| stub | `tests/failmatrix/run.mjs:144` | `exp.etag === true && !/^"\d+"$/.test(result.etag ?? '')` ⇒ 判 **存在 + 强格式**（引号包纯数字；`W/"n"` 这种弱校验前缀过不了） |
| stub | `tests/failmatrix/run.mjs:145` | 判红文案 `ETag 期望强修订号 "n"，实际 …`；`run.mjs:147` 另管 `etag === false`（必须缺失） |
| 真库 | `tests/failmatrix/run-real.mjs:790` 的 `verdictFor` | 只有三段判据——`exp.status`、`exp.code`、`meta.execution_mode`——＋ 用例自带的 `check = c.realCheck ?? c.check`（`tests/failmatrix/run-real.mjs:806`）。**整个函数从不读 `exp.etag`** |

即：同一条 `expect: { status: 200, etag: true }`，stub 臂会判「有没有 ETag、是不是强格式」，真库臂只判「200 且没有 code」。真库侧漏测，不是「真库侧另有更强判据」。

**受影响用例有多少条**：`cases.mjs` 里带 `expect.etag` 的共 12 条（C4-12、C5-09、C6-01/02/05/06/08/09、E1-01/02/03、E2-03）。但真库臂只跑权限面六族——`tests/failmatrix/run-real.mjs:990` 的 `PERMISSION_FAMILIES = new Set(['C1','C2','C3','C4','C10','C11'])`（`:991` 落筛选）——C5/C6/E1/E2 十一条**不进真库臂**，所以「两臂不对等」在今天的实际暴露面**恰好只有 C4-12 一条**（C4 族、`receiptHolder` 回执读自己的注销单、期望 200）。

**真库侧该不该更强**：不该弱。`services/api/src/routes/account-deletion.ts:353` 就是 GET 注销单的响应头——`.header('ETag', `"${String(projected['revision'])}"`)`——用正文修订号拼**强** ETag；`services/api/src/privacy/account-deletion.ts:419` 的 `normalizeRevision` 保证该字段是 ≥1 的安全整数，所以真库的 ETag 只可能是 `"n"` 形状。stub 桩件与真库在这个 header 上**结构相同**，没有「真库只能更弱」的合法理由 ⇒ 走 (a) 补断言，不走 (b) 写「有意不对等」。

## §2 修法：(a) 用例级补真库断言，而不是改公共判定器

改了 `tests/failmatrix/cases.mjs:404` 那条 C4-12：单行里引用 `realCheck: assertStrongEtagMatchesRevision`（`tests/failmatrix/run-real.mjs:806` 取 `realCheck ?? check`，所以真库臂会用它替掉本条原先不存在的断言），判据函数声明在同一文件的末尾（`tests/failmatrix/cases.mjs:737`）——为什么放末尾见 §5：

- `cases.mjs:739` 取 `result.headers?.etag`、`cases.mjs:740` 取 `result.body?.data?.revision`；`cases.mjs:741` 判强格式，口径与 stub 臂 `run.mjs:144` **逐字同源**：`typeof etag === 'string' && /^"\d+"$/`。
- `cases.mjs:746` 再把 ETag **逐字钉到正文修订号**：`etag === `"${String(revision)}"``；`cases.mjs:744` 先要求 `revision` 是 ≥1 的安全整数（不是就判红）。这一条比 stub 臂强——stub 臂只看形状，真库臂连「ETag 和正文是同一个修订号」都不许漂。

**为什么不改公共判定器（在 `verdictFor` 里加 `exp.etag` 分支）**：那会把 `tests/failmatrix/run-real.mjs:806` 之后的每一行都往下推，牵动 `docs/verification/` 三处历史取证页的十几个锚点，而今天除 C4-12 外没有任何带 `expect.etag` 的用例进真库臂 ⇒ 检测力净增 0、文档位移代价全额。

改为在 `tests/failmatrix/run-real.mjs:782`（同一函数注释里 `checkProblems` 那一条）**行数不变**地补一句显式警告：本函数不读 `expect.etag`，新增带 `expect.etag` 的权限面用例**必须同时**给 real 侧断言，否则真库侧会静默退化成状态码级。把「这一类洞」写在决策点旁，比补一条今天用不上的公共分支更能挡住复发。

C4-12 的 `note` 也同步改写：不再写「两臂强度不对等属既有实现」，改写成「本条已对等 + 由 realCheck 判 + 变红条件（真库不再回 ETag / 回弱形式 `W/"n"` / 与 `data.revision` 不再逐字相等）」。

## §3 实跑读数

环境：`GY_PG_BIN=E:\GengYunCommander\.pg17\pgsql\bin`（`initdb (PostgreSQL) 17.11`）、`GY_I22_PG_ROOT=E:\GengYunCommander\.pg17\tmp\r87etag-final`、Node `v24.16.0`；簇由脚本自取端口、只听 `127.0.0.1`，`finally` 里 stop + 删目录（日志末行 `[pg] 一次性集群已停止，数据目录已删除`）。

```powershell
node tests/failmatrix/run.mjs                                     # stub 臂
$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'
node tests/failmatrix/run-real.mjs --require-no-not-runnable `    # 真库臂
  --json=E:\GengYunCommander\.pg17\tmp\r87etag-final.json
```

| 臂 | 合计行（原文） | 退出码 |
| --- | --- | --- |
| stub | `矩阵合计 249 条：PASS 249 / FAIL 0` | 0 |
| 真库 | `权限面合计 180 条：same 180 / sameWithCheck 25 / sameWithShape 30 / different 0 / not_runnable 0` | 0 |

真库臂判据强度行：`判据强度：same 里真跑过断言 55 条（check 25 + 同形 30），只比 status/code 125 条`。

**与改动前的基线差**（基线见 `docs/verification/gy-r87-failmatrix-real-arm-rerun-20261107.md:46`）：`sameWithCheck 24 → 25`、`sameWithEither 54 → 55`、`sameWithNeither 126 → 125`，`same 180`、`different 0`、`not_runnable 0` 都没动。挪动的这 1 条就是 C4-12——它从「只比 status/code」挪进了「真跑过断言」，说明新加的 `realCheck` **真的执行了**，不是写完就搁着。逐条 json 里 C4-12 的 `assertions.check = "ran"`。

族分布（由 json `rows` 逐条复算，口径同 `docs/verification/gy-r87-failmatrix-real-arm-rerun-20261107.md:110`）：

| 族 | total | same | sameWithCheck | sameWithShape | 二者皆无 | different | not_runnable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | 37 | 37 | 0 | 0 | 37 | 0 | 0 |
| C2 | 24 | 24 | 3 | 10 | 11 | 0 | 0 |
| C3 | 36 | 36 | 14 | 0 | 22 | 0 | 0 |
| C4 | 21 | 21 | **3** | 3 | **15** | 0 | 0 |
| C10 | 23 | 23 | 0 | 0 | 23 | 0 | 0 |
| C11 | 39 | 39 | 5 | 17 | 17 | 0 | 0 |
| **合计** | **180** | **180** | **25** | **30** | **125** | **0** | **0** |

C4 族 `sameWithCheck 2 → 3`、`二者皆无 16 → 15`，其余五族逐格未动。

C4-12 行原文：`  SAME C4-12  GET    /api/v1/account/deletions/<uuid> → 真PG 200 - · stub期望 200 - · 回执 bearer 读自己的注销单`。

## §4 变异自证（新断言是活的）

两次变异都只改 `cases.mjs` 里新加的那一条断言，跑完立即还原；判定「红」是读数行与 `DIFF` 行，因为 `--require-no-not-runnable` 按设计**只**把 `not_runnable` 变成 exit 1（`tests/failmatrix/run-real.mjs:1489`），`different` 不进退出码。

**⚠️ 交付价值说准一点：这条断言在 CI 里红不了——它是「人肉可见」，不是「门禁」。** 真库臂的退出码只由 `not_runnable` 决定：`tests/failmatrix/run-real.mjs:1487-1491` 只在 `--require-no-not-runnable` 且 `tally.notRunnable > 0` 时 `return 1`，正常走到底就是 `return 0`（`:1493`）；脚本也没有 `--require-no-different` 这类开关（`:972` 列的合法参数只有 `--json=` / `--allow-skip` / `--require-no-not-runnable`）。CI 侧 `.github/workflows/real-pg-integration.yml:1264-1270` 的两条判决是「退出码（77 显式升级成 1、其它非 0 原样透出）」与「`--json` 的条数自证」，并且明文写着「⛔ 不断言 `different === 0`」。所以下表变异 A/B 判出的那种红，在 CI 里只会落在合计行的 `different 1` 与一条 `DIFF C4-12：…`（`run-real.mjs:1447`）上，**流水线照旧绿，得有人去翻日志才看得见**。要变成门禁得另开 B 档改动（给 `run-real.mjs` 加 `--require-no-different`，或改成与基线 json 逐条比对）；本页**不声称**它已进 CI 门禁。

| 变异 | 改法 | 读数 | 判红原文 |
| --- | --- | --- | --- |
| A 强→弱 | `cases.mjs:741` 的 `/^"\d+"$/` 改成 `/^W\/"\d+"$/`（要求弱校验前缀） | `same 179 / sameWithCheck 24 / different 1` | `DIFF C4-12：… （ETag 期望强修订号 "n"（不带 W/ 弱前缀；与 stub 臂 run.mjs:144-148 同口径），实际 "\"2\""）` |
| B 值改一位 | `cases.mjs:746` 的 `String(revision)` 改成 `String(revision + 1)` | `same 179 / sameWithCheck 24 / different 1` | `DIFF C4-12：… （ETag 必须逐字等于正文修订号：期望 "\"2\""，实际 "\"2\""）` |
| 还原 | 两处逐字改回 | `same 180 / sameWithCheck 25 / sameWithShape 30 / different 0 / not_runnable 0` | 无 `DIFF` |

变异 B 的文案里「期望」与「实际」看起来同形，是因为**文案取的是真修订号（2）、判等取的是变异后的修订号（3）**：真库此刻 ETag 就是 `"2"`、正文 `data.revision` 也是 `2`，所以判等要求 `"3"` 时必然红，而文案照旧打印真值。读这一行要看 verdict，不要看两个引号之间长得一样。

还原后的绿跑过三次（同一份提交内容，只差机器负载）：`11558 ms`（`r87etag-zero.log`）、`10377 ms`（`r87etag-restored.log`）、`9254 ms`（`r87etag-final2.log`），三次读数逐格一致——`same 180 / sameWithCheck 25 / sameWithShape 30 / different 0 / not_runnable 0`。

## §5 为什么判据写在文件末尾（零位移）

第一版把 `realCheck` 写成 C4-12 里的多行箭头函数：`cases.mjs` 从 676 行长到 693 行（净 +17），404 行之后的所有行号 +17，于是 `docs/verification/` 里三处锚着 `cases.mjs` 第 407/413/438 行的取证页（r87 真库臂复跑页第 123、124 行；r82 对账页第 40、41、99 行）必须跟着改数字。改完跑 `tests/unit/doc-anchor-relocation-identity.test.mjs` 直接红。

判词（转述，避免在页内再造指向错文件的裸锚点）：`锚点位移恒等失败 3 条（base=1b0a3b63e023 … documented files=3 docLines=5 tokens=6 judged=6 identical=0 relocated=6 registered=0 corrected=0 carried=600 removed=0）`，三条都是「[登记表] 第 598/599/600 条 … 陈旧：该文档第 40/41/99 行里已经没有登记表声明的那个 `tests/failmatrix/cases.mjs` 锚点（新行号不命中）」。

原因是 r82 那三处不是普通锚点，而是 `tests/unit/doc-anchor-relocations.json` 第 598/599/600 条 `kind: "correction"` 登记（`from 354 → to 407`、`from 367 → to 438`，`symbol` 分别是 `C4-15`／`C4-18`）：闸门按「HEAD 上是否仍成立」重验每一条，文档行必须仍然含指向 `tests/failmatrix/cases.mjs:407` 的那个锚点。**只改文档数字会把它判成「陈旧」，而把 `to` 跟着改成 424/455 就得动登记表**——本片明确不动那张表（它不在 `tests/failmatrix/**` 里）。反过来把文档数字留着不动也不行：`to=407` 那条 `correction` 要求「HEAD 的 407 行含 `C4-15`」，而位移后 407 行是别的内容。

所以改成**零位移**的写法：C4-12 仍是第 404 行（一条长对象字面量的单个 `realCheck: assertStrongEtagMatchesRevision` 引用），判据函数 `assertStrongEtagMatchesRevision` 声明在文件末尾（`tests/failmatrix/cases.mjs:737`），函数声明提升让「用例先引用、文末声明」成立。实测：`prefixIdentical: true`（前 403 行逐字未动）、`tailIdentical: true`（原 421 行之后的每一行逐字未动），`git diff --numstat 1b0a3b63 aeaa5c24 -- tests/failmatrix/cases.mjs` 只有 `34 1 tests/failmatrix/cases.mjs`：**34 行新增 = 文末追加的 33 行（第 677 行的分隔空行 + 第 678–709 行的 JSDoc 与函数本体）＋ 第 404 行原位改写的 1 行**；**1 行删除 = 第 404 行的旧内容**。C4-12 **没有折行**——改动前后它都是第 404 行的一整行，变的是 `note` 文案、以及多出 `realCheck: assertStrongEtagMatchesRevision` 这一段引用；文件从 676 行长到 709 行（+33）。（第一版把 `realCheck` 写成 C4-12 里的多行箭头函数，那一版才是折行；§5 开头 676→693 的 +17 讲的就是那一版，最终版已无折行。）

代价写在函数注释里：判据离用例远了 290 行。收益是**一条文档锚点都不用动**，登记表不用动，`doc-anchor-relocation-identity` 这条闸门本轮判决面为空（`git diff` 的 docs 侧只有本页这一份纯新增文件 ⇒ 显式 SKIP）。

`cases.mjs` 里 404 行之前的锚点（`gy-r31-*` 三个历史页、`docs/architecture/ai-ops-spec-status.md`、r87 页指向 C3-19/20/21 的三处）一个都没动，因为根本没有位移。

## §6 局限（不要外推）

- **本机 PG 17.11 ≠ CI**：不是 CI 的 ubuntu-24.04 + PGDG `postgresql-17`；读数一致只说明同一脚本、同一棵树、同一大版本下相同。
- **只证明 C4-12 这一条**：`realCheck` 只加在这一条；`verdictFor` 仍然不读 `exp.etag`，所以**将来**新增带 `expect.etag` 的权限面用例仍会静默退化——这一条靠 `run-real.mjs:782` 的注释警告挡，不是靠代码强制。要强制得改公共判定器（见 §2 的代价说明）。
- **不覆盖 12 条里的另外 11 条**：C5/C6/E1/E2 的 etag 用例只在 stub 臂判定，本页不声称它们有真库判据。
- **这条判据隐含「200 + 有正文」**：它除了取响应头 `ETag`，还要拿正文 `result.body.data.revision` 做逐字比对（`cases.mjs:746`），所以只适用于「200 且带正文」的用例；304／空正文一类即使也回 ETag 也不能照抄这条 `realCheck`——`revision` 取不到就会落进「`data.revision` 期望正整数」那一支判红。
- **`--require-no-not-runnable` 的拒红分支仍未触发**：本轮 `not_runnable = 0`，那个 `return 1` 分支没执行过。
- 变异自证的两处改动已逐字还原（`git diff --numstat 1b0a3b63 aeaa5c24` 为 `104 0 docs/verification/gy-r87-etag-parity-20261107.md`、`34 1 tests/failmatrix/cases.mjs`、`1 1 tests/failmatrix/run-real.mjs`），本页是唯一新增文件。
