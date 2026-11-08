# R88 / i29：把 jobs 台账真库臂接进 CI（`real-pg-jobs-ledger-17-11`）

- 分支：`ci/gy-r88-jobs-ledger-wiring`，base `b617894c`（`#1070` 与 `#1072` 先后合入后的 `origin/main`；本片开工时 `origin/main` 是 `841bc1c3`，提交前已 rebase 到 `b617894c`，`#1072` 只动了两个 docs 文件、与本片零冲突）。
- 接线的臂：`tests/integration/jobs-ledger-pg.mjs`（464 行，R88 之前是白名单里最后一条「未接线（真缺口）」）。
- 新增 job：`real-pg-jobs-ledger-17-11`（`name: real-pg-jobs-ledger-17.11`），追加在 `.github/workflows/real-pg-integration.yml` 文件末尾，原 1532 行 → 1662 行，**既有 job 行号零位移**。
- 触发条件：跟随该 workflow 的两条既有触发（`pull_request` 与 `push` 到 `main`），本 job 没有自己的 `if:` / `paths:` 过滤 —— 判据④把任何 `if:` 当吞失败，本 job 全文没有。
- 本页记的是「接线形状 + 真跑读数 + 变异读数 + 闸门读数」，不重复臂内 15 条断言逐条的业务含义（那些在臂自身的日志里）。

## 1. job 的形状（逐段）

| 段 | 位置 | 内容 |
| --- | --- | --- |
| 头顶注释块 | yml 第 1534–1571 行 | 接线动机、空库要求的理由、门变量为什么只能是 env、不用计数闸的理由、退出码语义、封顶算式 |
| job 键 | yml 第 1572 行 | `real-pg-jobs-ledger-17-11:` |
| 名称 | yml 第 1573 行 | `name: real-pg-jobs-ledger-17.11` |
| 运行环境 | yml 第 1574–1575 行 | `runs-on: ubuntu-24.04`、`timeout-minutes: 45` |
| service | yml 第 1576–1588 行 | `postgres:17.11`、`POSTGRES_DB: gengyun_ci_bootstrap`、`POSTGRES_USER: gengyun_ci_owner`、`ports: ['5432:5432']`、四条 health 检查 |
| 检出 | yml 第 1590 行起 | `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683`，封顶 5 分钟，`persist-credentials: false` |
| Node | yml 第 1594 行起 | `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`，封顶 5 分钟，`node-version: '24.16.0'` |
| 依赖 | yml 第 1599 行 | `npm ci --no-audit --no-fund`，封顶 15 分钟 |
| service 自证 | yml 第 1604 行起 | `server_version` 主版本必须 17、当前角色必须是超管，任一不满足即 `::error::` + `exit 1`，封顶 5 分钟 |
| 台账臂 | .github/workflows/real-pg-integration.yml:1631 | 空库重建 + 跑臂 + 三道文本闸，封顶 5 分钟 |

封顶之和 5 + 5 + 15 + 5 + 5 = 35，加 10 分钟前置余量 = job 级 45；算式逐字写在该 job 头顶注释块里，算式与 job 级封顶都由 `tests/unit/ci-real-pg-step-timeouts.test.mjs` 逐字核对。

台账臂 step 的 `run:` 体（顺序即防线顺序）：

1. `psql -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS gengyun_jobs_ledger_test WITH (FORCE)'`（yml 第 1636 行）；
2. `psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_jobs_ledger_test'`（yml 第 1637 行）；
3. `node tests/integration/jobs-ledger-pg.mjs 2>&1 | tee "$log" || rc=$?`（yml 第 1639 行）；
4. `rc` 为 77 ⇒ `::error::` + `exit 1`（不许把「未取得」当通过）；
5. `rc` 非 0 ⇒ 原样透出该 rc；
6. 输出里必须出现 SUMMARY 行（yml 第 1648 行的 `grep -Fq '项实测通过（真库 gengyun_jobs_ledger_test）'`）；
7. 输出里必须出现末条 PASS 行（yml 第 1652 行的 `grep -Fq 'PASS 15: 注销清理（真库）：重复调用 0 行且不抛'`）。

## 2. 与 `#1070` 的 `real-pg-ledger-17-11` 的差异（都有据，不是风格偏好）

**差异一：这条臂要求空库，那条不要求。**
臂在跑迁移之前先数 `public` 下的关系数，断言必须是 0（`tests/integration/jobs-ledger-pg.mjs:103` 的原文是「专用测试库必须是空库（public 下已存在 N 个关系）：脚本要自己跑迁移链」）。它自己跑全链迁移，所以给一个「已经迁移过」的库，第一条断言就红。`#1070` 的 provider 臂是在已有 schema 上写行，只需库存在。
⇒ 所以 step 里先 DROP + CREATE，**不是清场好看**，是这条断言只有在全新空库上才成立。变异 ③ 就是拿这条打靶的（见第 6 节）。

**差异二：门变量只能走 env，不能走 argv。**
本臂的 URL 只从 `process.env['JOBS_LEDGER_PG_TEST_URL']` 读（`tests/integration/jobs-ledger-pg.mjs:54`），全文没有一行 argv 解析。`#1070` 那种 `node <脚本> <url>` 的写法在这里是**假接线**：URL 会被完全忽略，脚本照样打 `SKIP` 然后 `exit 77`，而 77 又被 step 升级成 exit 1 —— 于是「看起来配了、其实没连上」会以一种令人困惑的方式失败。所以 step 的 env 里显式写 `JOBS_LEDGER_PG_TEST_URL`，`node` 那行不带参数。
库名同样被脚本钉死：`tests/integration/jobs-ledger-pg.mjs:52` 定义常量，紧接着断言 URL 的 pathname 必须正好是 `/<该常量>`。⇒ step 里 `CREATE DATABASE` 的名字、env URL 的 path、脚本常量，三处必须同一个名字；`tests/unit/ci-real-pg-wiring.test.mjs` 的判据⑦⑧ 就是逐处比这三个来源的唯一性。

**差异三：末行文案不同，`#1070` 的 grep 不能照抄。**
`#1070` 的臂末行是 `[√] ALL PASS`；本臂**没有这一行**。本臂的收尾是两句：`tests/integration/jobs-ledger-pg.mjs:461` 打 `SUMMARY: N 项实测通过（真库 …）；台账总行数 4 → 清理后 1`，之前一句是 `tests/integration/jobs-ledger-pg.mjs:459` 的末条 PASS。若照抄 `[√] ALL PASS`，这个 job 会永远红，而且是「文案不存在」导致的红，不是产品缺陷。
⇒ 换个角度讲，这也暴露了 `#1070` 那套末行闸的真实弱点：单靠一行文案，只要那行还在、前面的断言被删掉也照样绿。本臂因此用**两道**文本闸（SUMMARY 行 + 末条 PASS 行），并在注释里写明第二道是「文本锚不是计数」。

**差异四：不写 `readings` 计数闸。**
`tests/unit/ci-real-pg-readings-gates.test.mjs` 要求 yml 里的读数闸门数与基线表条目数严格相等。本 job 若临时加一个 `readings=$(…); -lt 15`，基线表立刻对不上。本臂的 15 条读数是分段日志（`[M]/[L]/[I]/[A]/[C]/[T]/[N]/[P]` 八组），没有一条能当稳定的机器计数口径；硬编一个数只会变成「数字对不上就改数字」。所以本 job 一道 `readings` 闸都没有。

## 3. 三处计数/白名单同步

1. **白名单条目（改理由，不删条目）**：`tests/unit/ci-integration-chain-structure.test.mjs` 的最后一条（`path:` 在 yml 之外的那个数组里，测试文件第 632 行）理由段由「未接线（真缺口）：…」整段改写为「已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-jobs-ledger-17-11` 的 step「…」跑 …」，并保留原文末尾那句「判据 4 的 `wired` 只认 `test:integration:http` 链 ⇒ 条目必须留在白名单」。**条目没有删除**，因为该脚本确实不在 npm 回环链里，删了会被判据 4 判成「未声明」。
2. **`tests/unit/ci-unwired-declaration-reasons.test.mjs` 的 `ENTRY_COUNT` 保持 58（没按派单改成 57）**：这个常量是**白名单总条数**，不是「未接线（真缺口）」的条数（断言在测试文件第 212 行与第 325 行，两处都与实际解析条数比）。条目没删 ⇒ 58 不动。真正降 1 的是「未接线（真缺口）：」前缀的条数：2 → 1（剩下的是 `tests/integration/post-media-attach-http-pg.mjs`），这个数由守卫按前缀统计，不写死在常量里。
3. **`tests/unit/ci-real-pg-wiring.test.mjs` 三张表各 +1**：`MANAGED_SCRIPTS` 尾部（测试文件第 239 行）、`FROZEN_MANAGED_SCRIPTS` 尾部（第 296 行）、`REQUIRED_STEP_ORDER` 尾部（第 590 行）。三处都带 R88 注释，说明这条脚本住独立 job、与上面各条无状态依赖。三张表之后又调用了 `SELF_CLUSTERED_SCRIPTS` 与 `SELF_CLUSTERED_ROOT_KEY`，插入点把这两个声明的行号各推后了若干行，`docs/verification/gy-r29-real-pg-arms-audit-20261022.md` 与 `docs/verification/gy-r67-c-wiring-20261027.md` 里手写的锚点已按真实行号改（**只改数字**，没有往 `tests/unit/doc-anchor-relocations.json` 新增任何纯位移条目）。

### 3.1 恒等闸门：5 条**既有**登记跟到新读数（没有新增条目）

改完文档数字后 `tests/unit/doc-anchor-relocation-identity.test.mjs` 判了 5 条「陈旧」：登记表里这 5 条记的 `to` 还是改版前的行号，而文档里的锚点已经按真实符号行改了 ⇒ 登记与文档对不上。处置是**把这 5 条既有登记的 `to` 跟到新读数、`reason` 末尾追加 R88 说明**；登记表的条目数不变（还是原条目），没有新增任何「纯位移」条目，也没有整表重写（逐条文本替换）。

| 登记指向的文档行 | 目标文件 | 旧 `to` → 新 `to` | 用于验真的符号 |
| --- | --- | --- | --- |
| `docs/verification/gy-r29-real-pg-arms-audit-20261022.md` 第 60 行（`from` 256） | `tests/unit/ci-real-pg-wiring.test.mjs` | 713 → 722 | `const SELF_CLUSTERED_ROOT_KEY = Object.freeze({` |
| `docs/verification/gy-r65-wire-posthide-arm-20261027.md` 第 148 行（`from` 607） | `tests/unit/ci-integration-chain-structure.test.mjs` | 653 → 658 | `function readChainEntries() {` |
| `docs/verification/gy-r65-wire-posthide-arm-20261027.md` 第 148 行（`from` 691） | `tests/unit/ci-integration-chain-structure.test.mjs` | 737 → 742 | `!wired.has(path) && !declared.has(path)` |
| `docs/verification/gy-r67-c-wiring-20261027.md` 第 90 行（`from` 2172） | `tests/unit/ci-real-pg-wiring.test.mjs` | 2462 → 2471 | `const hostJob = jobsOf(source).find` |
| `docs/verification/gy-r67-c-wiring-20261027.md` 第 80 行（`from` 295） | `tests/unit/ci-real-pg-wiring.test.mjs` | 322 → 327 | `export const REQUIRED_STEP_ORDER` |

两条 `gy-r65` 登记的锚点都住在同一文档行：显式锚点写 `tests/unit/ci-integration-chain-structure.test.mjs:658`，第二个按裸锚点写 `:742`（同段继承同一个路径）—— 两条都仍落在该行，`correction` 的「新窗口含符号、旧窗口不含」也仍然成立（旧窗口是 JSDoc 与 `assert.deepEqual(`）。


## 4. 本机真跑读数（PG 17.11，端口 55411，库 `gengyun_jobs_ledger_test`）

- 起簇：`E:\GengYunCommander\.pg17\pgsql\bin`，`initdb -U postgres --auth=trust` 新建数据目录，只监听回环，端口 55411（与 yml 里的 5432 不同，本机避开占用；URL 形态一致）。
- 每轮跑前都 `DROP DATABASE IF EXISTS … WITH (FORCE)` + `CREATE DATABASE`，保证空库。
- 结果：**exit 0**，`PASS` 行 **15 条**，日志 17 行（UTF-8，`E:\GengYunCommander\.pg17\r88-arm2.log`；本片换过一次会话，重跑读数与换会话前完全一致）。
- 末行逐字（照抄）：

```
SUMMARY: 15 项实测通过（真库 gengyun_jobs_ledger_test）；台账总行数 4 → 清理后 1
```

- 末条 PASS 逐字（照抄）：

```
PASS 15: 注销清理（真库）：重复调用 0 行且不抛；空白主体被拒；总行数只剩他人的 1 行
```

- 说明：`DROP` 时 psql 会打 `NOTICE: database "gengyun_jobs_ledger_test" does not exist, skipping`，这是首轮 DROP 的正常输出，不是失败。

## 5. 变异（每条都是「改成坏样子 ⇒ 必须红」，改完全部还原）

**变异 ①：把 yml 里 `node tests/integration/jobs-ledger-pg.mjs …` 那行注释掉。**
读数：`node --test tests/unit/ci-real-pg-wiring.test.mjs` ⇒ **fail 10**，逐条点名 `tests/integration/jobs-ledger-pg.mjs`：

```
✖ 前向①：两个受管真库脚本都被某个 workflow 的 `run:` 真跑
· tests/integration/jobs-ledger-pg.mjs
✖ 前向⑤（判据⑥）：受管脚本在 workflow 里的执行顺序必须与 REQUIRED_STEP_ORDER 一致
✖ 前向⑥（判据⑦＋⑧）：每个受管脚本所在 step 先 CREATE DATABASE 再 node，且库名与该 step 传入的一致
✖ 前向⑦（判据⑨）：workflow 里执行的 `-pg.mjs`／`-e2e.mjs` 集合与 MANAGED_SCRIPTS 双向相等
```

另带 6 条反向控制一起红（`反向控制①`、`反向控制①b`、`反向控制⑦`、`反向控制⑧`、`反向控制⑨`、`反向控制⑩`）。

**变异 ②：把白名单理由的「已接线（workflow）：」改回「未接线（真缺口）：」。**
读数：`node --test tests/unit/ci-unwired-declaration-reasons.test.mjs` ⇒ **exit 1**，红在「未接线白名单理由：四类前缀、job 名从 yml 解析、双向一致」，两条问题原文：

```
tests/integration/jobs-ledger-pg.mjs（第 632 行）：说的是「未接线（真缺口）：」，但 .github/workflows/real-pg-integration.yml#real-pg-jobs-ledger-17-11 真在跑它
已接线条数 52 ≠ 真被 workflow run: 跑到的白名单脚本数 53
```

注意：红的是 reasons 守卫；`ci-integration-chain-structure.test.mjs` 自己不看前缀（它仍绿）。⇒ 「说未接线但其实跑着」和「说已接线但其实没跑」两个方向都被钉住了。

**变异 ③：把 `ENTRY_COUNT` 改成 57。**
读数：`node --test tests/unit/ci-unwired-declaration-reasons.test.mjs` ⇒ **exit 1**，原文：

```
- 白名单条目数 58 ≠ 57
```

⇒ 这个常量确实是「白名单总条数」的硬钉子：条目没删就不能动它。改前 58、改后（还原后）58，本片**没有**把 58 改成 57 或 56。

**变异 ④（额外，打的是空库约束）：不给空库。** 分两半，因为「删掉 CREATE DATABASE」在 CI 里的真实后果是**库不存在**，不是断言红：

- ④a 拿掉 `CREATE DATABASE`（库不存在）：`node` 起来就 `error: database "gengyun_jobs_ledger_test" does not exist`，**exit 1**（非 77，step 会原样透出）。⇒ step 里的 CREATE 不是装饰。
- ④b 给一个「跑过一轮迁移」的库（`public` 下已有 257 个关系）：**exit 1**，断言原文

```
AssertionError [ERR_ASSERTION]: 专用测试库必须是空库（public 下已存在 257 个关系）：脚本要自己跑迁移链
```

⇒ 空库要求是真约束：这条断言只在全新库上有意义，`#1070` 那种「库在就能跑」的形状在这里会红。


## 6. 闸门读数

| 闸门 | 命令 | 读数 |
| --- | --- | --- |
| 四连 strict | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | exit 0，`不在区间 44`（=基线）、`UNDECLARED 254`（基线 265，未上升）、`配成对 1146`，末行 `PASS: --strict 下没有基线之外的新增` |
| 契约台账 | `node tools/verify-contract-status.mjs` | exit 0，`PASS: 行号区间 324 条（台账直写 312 条 + 符号解析 12 条）`、`PASS: 中文表格一致` |
| 文档 | `npm run test:docs` | exit 0，`PASS: 识别 5 页 / 跳过 344 页（扫描面 349 页：docs/verification）——读数七条判据全部自洽` |
| 单测 | `node --test "tests/unit/*.test.mjs"`（`GY_BASH` 指向真 bash） | exit 0，5668 tests / 5666 pass / 0 fail（含 `doc-anchor-relocation-identity` 37 tests / 37 pass，见 §3.1） |
| lint | `npm run lint` | `PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、`PASS 仓库卫生扫描`、`lint 通过` |
| 树合并 | `git merge-tree --write-tree --name-only origin/main HEAD` | exit 0，树 `9b0e5dd219168e606a3ed008097be50ee473e001`，无冲突清单 |
| 三个专项 | `node --test tests/unit/ci-integration-chain-structure.test.mjs tests/unit/ci-unwired-declaration-reasons.test.mjs tests/unit/ci-real-pg-wiring.test.mjs` | 34 tests / 34 pass / 0 fail |

补充：`ci-real-pg-step-timeouts.test.mjs` 与 `ci-real-pg-readings-gates.test.mjs` 也复跑了，14 tests / 14 pass / 0 fail —— 新 job 的封顶、算式、job 解析面、读数表条数都没有被打破。

单测这一行的前史：提交后第一次整跑是 `fail 2` —— 一条是 `tests/unit/media-real-mode-fail-closed.test.mjs`（单独跑 20 tests / 20 pass / 0 fail，整跑时红在并发时序上，与本片改动无关）；另一条是 `doc-anchor-relocation-identity` 的 5 条「陈旧」（§3.1）。按 §3.1 跟到新读数后复跑：5668 tests / 5666 pass / 0 fail，exit 0。

## 7. 本页不声称什么

- **不声称 jobs 台账的每条不变量都被覆盖。** 本 job 证明的是「这 15 条断言在真库 17.11 上跑得过」，不是「台账的所有不变量都被 CI 钉住」。臂内没有覆盖的面（例如并发下两条 claim 的竞态、跨库权限、连接池耗尽路径）仍然是未覆盖的，接了线不等于覆盖完。
- 不声称 GitHub Actions 上已经跑绿。本页所有读数都来自**本机** PG 17.11（端口 55411）；yml 是待 push 的改动，没有 PR、没有 Actions 运行记录。service 容器的 health 检查、`5432` 端口映射、`npm ci` 在 runner 上的耗时，都只有形状上的依据（照抄 `#1070` 那五个 job），没有本次实测。
- 不声称末行两道文本闸等价于「15 条断言一条不少」。第二道闸锚的是末条 PASS 行的文本，第一道锚的是 SUMMARY 行；删掉中间某组断言脚本仍会 exit 0 并打 SUMMARY。这是**已知的**弱点，写在这里而不是藏着。
- 不声称「删掉 CREATE DATABASE 就必须因空库断言红」。实测（变异 ③a）是连不上库、`error: database … does not exist`；空库断言红只在「库存在但不空」时出现（变异 ③b）。两种红的含义不同，不要混着引用。
- 不声称 `ENTRY_COUNT` 从 58 降到 57。派单建议的那处改法与本值含义不符（它是白名单**总条数**）；本条按 `#1070` 的形状保留在册，只有前缀分类的计数变了。
- 不声称本机端口 55411 的读数可以替代 CI 的 5432 端口读数。两者的差别只在端口与认证方式（本机 trust、CI 密码），URL 形态与库名一致。

## 8. 复跑入口

```
# 起簇（新数据目录，端口 55411，只监听回环）
cmd /c "E:\GengYunCommander\.pg17\pgsql\bin\pg_ctl.exe -D E:\GengYunCommander\.pg17\data-r88-jobsci -l E:\GengYunCommander\.pg17\r88-pg.log -o \"-p 55411 -h 127.0.0.1\" start > E:\GengYunCommander\.pg17\r88-start.out 2>&1"

# 空库 + 跑臂
psql -h 127.0.0.1 -p 55411 -U postgres -d postgres -c 'DROP DATABASE IF EXISTS gengyun_jobs_ledger_test WITH (FORCE)'
psql -h 127.0.0.1 -p 55411 -U postgres -d postgres -c 'CREATE DATABASE gengyun_jobs_ledger_test'
$env:JOBS_LEDGER_PG_TEST_URL='postgres://postgres@127.0.0.1:55411/gengyun_jobs_ledger_test'
node tests/integration/jobs-ledger-pg.mjs
```

- 臂在未设门时打 `SKIP` 并 `exit 77`；`--allow-skip` / `GY_ALLOW_SKIP=1` 只给本机开发用，⛔ 不得接进门禁。
- 判据④会拦住 `continue-on-error` / `if:` / `|| true` 这类吞掉失败的行；本 job 全文没有这些。
