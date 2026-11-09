# R90 · `#19` 片1 真库臂接 CI：`real-pg-deidentify-17-11` + 清册移出「未接线」（2026-11-09）

> 读数快照：2026-11-09（Asia/Hong_Kong），基线 `af39bfe6`（推送前实测的 `origin/main`：
> `docs(verification): 审计监工自审自合时序 #1084-#1113 (#1121)`；派单写的 `d7160e40` 在开工后已前进一格，以最新为准）。
> 本提交只做两件事：① 在 `.github/workflows/real-pg-integration.yml` **末尾追加**一个自起集群 job；
> ② 把 `tests/integration/deidentify-account-pg.mjs` 从清册的「未接线（真缺口）」改判为「已接线（workflow）」。
> 既有 7 个 job 的 1796 行**零改动**（`git diff --numstat` 为 `81	0`：全是末尾新增行，见第五节）。

## 一句话

`tests/integration/deidentify-account-pg.mjs`（迁移 0057 注销去身份的真库臂，A1–A11）此前只有本机跑法，
CI 里一次也没跑过；本提交把它接进 `real-pg-integration.yml` 的**自起集群**形态 job `real-pg-deidentify-17-11`，
并把「未接线（真缺口）」那条清册理由改写成「已接线（workflow）」。同时给这道臂配了两道读数闸
（末行「结论」+ A 断言条数 ≥ 11），`exit 77` 一律判红。

## 一、新 job：名字、位置、跑什么

- job 键 `real-pg-deidentify-17-11` 在 `.github/workflows/real-pg-integration.yml:1815`；
  `name: real-pg-deidentify-17.11` 在 `.github/workflows/real-pg-integration.yml:1816`、
  `runs-on: ubuntu-24.04` 在 `.github/workflows/real-pg-integration.yml:1817`、
  `timeout-minutes: 45` 在 `.github/workflows/real-pg-integration.yml:1818`。
- 5 个 step（封顶之和 35 + 前置余量 10 = job 级 45，落成
  `.github/workflows/real-pg-integration.yml:1818` 的 `timeout-minutes: 45`）：`actions/checkout` 在
  `.github/workflows/real-pg-integration.yml:1820`、`actions/setup-node` 在
  `.github/workflows/real-pg-integration.yml:1824`、`npm ci` 在
  `.github/workflows/real-pg-integration.yml:1829`、装 PG 17 服务端二进制在
  `.github/workflows/real-pg-integration.yml:1832`、真库臂在
  `.github/workflows/real-pg-integration.yml:1849`。
- 臂 step 跑的是 `node tests/integration/deidentify-account-pg.mjs`：
  `.github/workflows/real-pg-integration.yml:1855`。
- 四道判定依次是：`exit 77` ⇒ 红（`.github/workflows/real-pg-integration.yml:1856`，未取得不是通过）、
  其它非 0 原样透出（`.github/workflows/real-pg-integration.yml:1860`）、
  日志里必须有「  ✓ 结论：」这一行（`.github/workflows/real-pg-integration.yml:1864`）、
  A 断言条数 `pass_lines -lt 11` 判红（`.github/workflows/real-pg-integration.yml:1870`，
  `pass_lines` 由 `.github/workflows/real-pg-integration.yml:1868` 的 `awk` 从日志逐行数 `  ✓ A<n>`）。
- env 在 `.github/workflows/real-pg-integration.yml:1875`：`GY_PG_BIN: /usr/lib/postgresql/17/bin`、
  `GY_I19_PG_ROOT: ${{ runner.temp }}/gy-i19-deidentify-pg`；
  `PGCLIENTENCODING: UTF8` 在 `.github/workflows/real-pg-integration.yml:1877`。
- **为什么没有 `services:`**：臂脚本自己起一次性 17 簇——`GY_PG_BIN` 在
  `tests/integration/deidentify-account-pg.mjs:42` 读、`GY_I19_PG_ROOT` 在
  `tests/integration/deidentify-account-pg.mjs:67` 读、根目录由
  `tests/integration/deidentify-account-pg.mjs:70` 自己 `mkdirSync(recursive)`，
  跑完 `pg_ctl -m immediate stop` 并删数据目录。CI 里既没有「CI 建出来的库」，也没有可核对的库名，
  所以 `services.postgres` 在这里既不需要、也无从核对（守卫侧的等价判据见第三节）。

## 二、装 PG 17 服务端二进制那三行照抄自哪里

逐字照抄本文件里既有的那份装包 step（`failmatrix-real-17-11` 等四个 job 共用同一份）：

| 内容 | 照抄源 | 本 job |
| --- | --- | --- |
| `sudo install -d /usr/share/postgresql-common/pgdg` | `.github/workflows/real-pg-integration.yml:1352` | `.github/workflows/real-pg-integration.yml:1836` |
| `sudo curl --fail --silent --show-error --retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 15 -o …apt.postgresql.org.asc …` | `.github/workflows/real-pg-integration.yml:1353` | `.github/workflows/real-pg-integration.yml:1837` |
| `sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update` | `.github/workflows/real-pg-integration.yml:1355` | `.github/workflows/real-pg-integration.yml:1839` |
| `sudo apt-get -o Acquire::Retries=5 install -y --no-install-recommends postgresql-17` | `.github/workflows/real-pg-integration.yml:1356` | `.github/workflows/real-pg-integration.yml:1840` |
| 主版本自证：`initdb --version` / `pg_ctl --version` / `server_major != 17` ⇒ `exit 1` | `.github/workflows/real-pg-integration.yml:1357` | `.github/workflows/real-pg-integration.yml:1841` |

即 `#1123` 那轮给外部下载加的重试参数（`--retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 15`
与 `-o Acquire::Retries=5`）**原样继承**，没有另写一套装包逻辑、也没有放宽版本判据
（`server_major != 17` 那条自证在本 job 里逐字保留，`.github/workflows/real-pg-integration.yml:1845`）。

## 三、清册与守卫同步（四处）

1. **清册理由**：`tests/unit/ci-integration-chain-structure.test.mjs:646` 那条条目的 reason 从
   「未接线（真缺口）：」改写成「已接线（workflow）：」（首行在
   `tests/unit/ci-integration-chain-structure.test.mjs:648`），点名
   `.github/workflows/real-pg-integration.yml#real-pg-deidentify-17-11` 这个 job、该 step 不 `CREATE DATABASE`、
   `exit 77` ⇒ 红、读数闸 `pass_lines -lt 11`。
   ⛔ **条目本身保留、没有删**：判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链，
   deidentify 不在那条链里 ⇒ 删掉条目会立刻变成「既不在 http 链、也不在白名单」的未声明红。
   这是与派单口径的**实质差异**（派单写「移出 UNWIRED_DECLARATIONS 条目并把 `ENTRY_COUNT` 59→58」），
   按守卫实测改为「只换前缀、条目数不变」——先例是 R88 的两条
   （`docs/verification/gy-r88-i30-http-arm-wiring-20261108.md:84`、
   `docs/verification/gy-r88-i29-jobs-ledger-wiring-20261108.md:55`）。
   条目区间仍是 18 行（起于 `tests/unit/ci-integration-chain-structure.test.mjs:646`，止于 `tests/unit/ci-integration-chain-structure.test.mjs:662`）⇒ 该文件的 `tests/unit/ci-integration-chain-structure.test.mjs:676`、`tests/unit/ci-integration-chain-structure.test.mjs:760` 两个锚点与
   `tests/unit/doc-anchor-relocations.json:3075` 与 `tests/unit/doc-anchor-relocations.json:3076` 的 to 值都不动。
2. **白名单计数**：`tests/unit/ci-unwired-declaration-reasons.test.mjs:34` 的 `ENTRY_COUNT = 59` **未变**
   （条目还在，只是从 GAP 类变 WIRED 类；WIRED 类要求 reason 里点名 workflow 且该 job 真跑到该脚本，
   由 `.github/workflows/real-pg-integration.yml:1855` 满足）。
3. **受管脚本表**（`tests/unit/ci-real-pg-wiring.test.mjs`）：`MANAGED_SCRIPTS` 第 27 条在
   `tests/unit/ci-real-pg-wiring.test.mjs:243`、`FROZEN_MANAGED_SCRIPTS` 同名条目在
   `tests/unit/ci-real-pg-wiring.test.mjs:304`、`REQUIRED_STEP_ORDER` 第 27 条在
   `tests/unit/ci-real-pg-wiring.test.mjs:601`、`SELF_CLUSTERED_SCRIPTS` 在
   `tests/unit/ci-real-pg-wiring.test.mjs:716`、根键映射
   `'tests/integration/deidentify-account-pg.mjs': 'GY_I19_PG_ROOT'` 在
   `tests/unit/ci-real-pg-wiring.test.mjs:777`。
   五处插入全部**净 0 行**（同清单内把既有注释压行），因此 `:135`/`:246`/`:333`/`:665`/`:732`/`:2481`
   这些被 docs 锚点钉住的行号原地不动。
4. **`services:` 判据的窄豁免**：`postgresJobProblems()`（
   `tests/unit/ci-real-pg-wiring.test.mjs:1012`）对「跑受管脚本」的每个 job 都要求 `services.postgres`，
   自起集群 job 天然没有 ⇒ 在 `tests/unit/ci-real-pg-wiring.test.mjs:1022` 处加一条豁免判断（`if (isSelfClusteredOnlyJob(job, managed)) continue;`），
   谓词 `isSelfClusteredOnlyJob`（受管脚本全部落在自起集群族、且 job 没有 `services:` 行才放行）写在 `tests/unit/ci-real-pg-wiring.test.mjs:2695`：
   只有「该 job 命中的受管脚本全部 ∈ `SELF_CLUSTERED_SCRIPTS`」**且**「job.body 没有 `services:` 行」才跳过。
   反向控制⑪ 在 `tests/unit/ci-real-pg-wiring.test.mjs:2708` 钉住这条路**不能更宽**：
   ① 声明了 `image: postgres:16.4` 的纯自起集群 job 仍红；② 无 `services:` 但混一条非自起集群脚本仍红。
5. **读数闸登记**：`tests/unit/ci-real-pg-readings-gates.test.mjs:223` 新增第 17 条表项
   （`countedScript: 'tests/integration/deidentify-account-pg.mjs'`、`baseline: 11`、
   `counter` 与 step 里的 `pass_lines=$(…)` 括号内表达式逐字一致）。
   ⛔ 刻意不登记 `prose: true`：该旗标要求同时登记 `sayCalls`，而本臂用的是 `pass(` 不是 `say(`；
   注释头散文由 `ci-gate-prose-consistency` 的判据⑦ 看住。
   组数闸门总数随之 16 → 17（`tests/unit/ci-gate-prose-consistency.test.mjs:639`）。

## 四、本机实跑读数（不是 CI 读数）

```
$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'
$env:GY_I19_PG_ROOT='E:\GengYunCommander\.pg17\i19root'
node tests/integration/deidentify-account-pg.mjs
```

- `EXIT=0`；`  ✓ ` 开头的行 12 条 = A1–A11（11 条）+ 结论行（
  `tests/integration/deidentify-account-pg.mjs:532`）。
- 结论行原文：`  ✓ 结论：注销去身份的函数擦除面（A1–A7）+ 最小权限（A8）+ 受理事务接线与 fail-closed（A9–A10）+ 后台展示名回落（A11）全部通过`
- 集群：`port=63538`、库名 `gengyun_i19_deidentify_test`、全链 56 个迁移（最大号 57）、0057 的
  `deidentify_account` 函数已就位且 `SECURITY DEFINER`。
- 跑完 `Get-Process postgres,pg_ctl,initdb,psql` 为空（无残留）；数据目录被脚本自己的 `rmSync` 清掉。
- 本机口径提醒：把 `GY_I19_PG_ROOT` 指到 `%TEMP%` 下的目录时 `initdb` 会报
  `could not create directory …: Permission denied`（本机 ACL 限制，与脚本无关）；换成仓外
  `…\.pg17\i19root` 后一次跑通。CI 里该值是 `runner.temp` 下的子目录
  （`.github/workflows/real-pg-integration.yml:1876`），不经过本机这条限制。

## 五、既有 job 一行未改的证据

- `git diff --numstat origin/main -- .github/workflows/real-pg-integration.yml` ⇒ `81	0`
  （81 行新增、0 行删除），且新增的 81 行全部落在文件末尾这一段（注释头 + job 块，job 键 `.github/workflows/real-pg-integration.yml:1815`；文件从 1796 行变 1877 行）。
- 既有 7 个 job 的键仍然落在原来那 7 行上：`real-pg-17-11` 在
  `.github/workflows/real-pg-integration.yml:94`、`real-pg-admin-read-17-11` 在
  `.github/workflows/real-pg-integration.yml:945`、`real-pg-admin-write-17-11` 在
  `.github/workflows/real-pg-integration.yml:1087`、`failmatrix-real-17-11` 在
  `.github/workflows/real-pg-integration.yml:1331`、`real-pg-ledger-17-11` 在
  `.github/workflows/real-pg-integration.yml:1455`、`real-pg-jobs-ledger-17-11` 在
  `.github/workflows/real-pg-integration.yml:1581`、`real-pg-http-17-11` 在
  `.github/workflows/real-pg-integration.yml:1707`；新 job 在
  `.github/workflows/real-pg-integration.yml:1815`（追加在末尾，不动上面 7 行）。
  因此上文第二节引用的 `.github/workflows/real-pg-integration.yml:1352`、
  `.github/workflows/real-pg-integration.yml:1353`、`.github/workflows/real-pg-integration.yml:1355`、
  `.github/workflows/real-pg-integration.yml:1356`、`.github/workflows/real-pg-integration.yml:1357`
  这些「照抄源」行号在 HEAD 上仍然有效。

## 六、闸门读数（本提交实测）

- 四连 strict anchors（`--strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict`）：
  BASE（`af39bfe6`）与 HEAD 各跑一次，`EXIT=0`。`BARE-ORPHAN`（3469／3469／新增 0／陈旧 0）、
  `SYMBOL-LINE`（可判 903：落代码行 865、注释 25、逐字引用 3、文档注释 10）、
  `SYMBOL-STRICT`（903／865 通过／28 进基线、基线命中 25／新增 0）、
  `SYMBOL-COV-VERIFICATION`（可判 1015——OK 971、符号不在区间 44）**四行逐字相同**；
  只有 `ANCHOR-COUNT` 从 8872 条／298 份变 8943 条／299 份（本页新增 71 条锚点、1 份文档），
  连带 `SYMBOL-COVERAGE-SCOPE` 的「作用域外锚点」6299 → 6346、
  `SYMBOL-COVERAGE-VERIFICATION-SCOPE` 的 6036 → 6083（文档 255 → 256）；
  该面的配成对 1267、OK 971、符号不在区间 44、UNDECLARED 252 四格**一格未动**（只计数的「两侧等距不猜」6 → 7 随本页 +1）。
- 守卫测试：`ci-real-pg-wiring` / `ci-real-pg-step-timeouts` / `ci-real-pg-workflows-structure` /
  `ci-integration-chain-structure` / `ci-gate-prose-consistency` / `ci-unwired-declaration-reasons`
  六个文件合跑 **79 条全过**（基线 78 条 + 新增的反向控制⑪ 1 条）；单文件读数依次是
  21／7／28／7／9／7 条，全 `EXIT=0`。
- `tests/unit/ci-real-pg-readings-gates.test.mjs`：**10 条全过**（表 17 条 ⇔ yml 17 道闸）。
- `tests/unit/doc-anchor-relocation-identity.test.mjs`：HEAD `tests 37 / pass 36 / fail 0 / skipped 1`、`EXIT=0`
  （跳过的是夹具 A5「纯散文改动」：被改写的行里没有任何行号引用、`tokens=0` ⇒ 该用例无判定面，属预期 skip）；
  BASE（`af39bfe6`，检出即 `origin/main` 本身）上同一命令是 `pass 36 / fail 1`、`EXIT=1`：红的是「自愈夹具」，
  因为那时 `git merge-base HEAD origin/main` 就是 HEAD，夹具自己断言「base 与 HEAD 同一提交且不是 CI 浅克隆」
  ⇒ **结构性红**，与提交内容无关（更早的 `d7160e40` 上同样）。本提交没碰这个测试、也没碰登记表
  （`git diff --stat origin/main HEAD -- tests/unit/doc-anchor-relocation-identity.test.mjs tests/unit/doc-anchor-relocations.json`
  输出为空），亦未新增任何登记条目。
- `node tools/verify-contract-status.mjs`：`EXIT=0`（PASS 行见报告）。
- `npm run test:docs`：`EXIT=0`。
- `node tools/verify-g-drill-readings.mjs --check`：`EXIT=0`（八条判据全过，生长型读数按下界判）。
- `git merge-tree --write-tree --name-only origin/main HEAD`：`EXIT=0`，无冲突文件。

## 七、不声称

- **不声称**本提交根除 CI 抖动：装包那三行只是继承 `#1123` 的重试参数；`apt-get`/`curl` 仍可能整段失败，
  自起集群仍可能因端口/`initdb` 失败而红。本页只证明「这个 job 存在、判定条件与读数闸在、本机实跑能过」。
- **不声称**覆盖 7 日 / 30 日生命周期：A1–A11 覆盖的是「擦除读数／幂等／守卫／exports 逐列／writebacks 不动／
  `SET ROLE` 直改 42501／`createRequest` 合流／收回 EXECUTE 后 503 且零写入／后台 `display_name` 回落」，
  跨天留存、审计回放、真实删除请求的端到端时序**不在**这 11 条里。
- **不声称**本机实跑等于 CI 实跑：本机是 PG 17.11 二进制 + Windows，CI 是 `ubuntu-24.04` + PGDG 装的 17；
  本页只给「同一脚本、同一 11 条断言、同一 `EXIT=0`」这一层。
- **不声称** `.github/workflows/real-pg-integration.yml` 的其它 job 也跑过这个臂：它们一行未改，跑的仍是它们
  各自的脚本。
