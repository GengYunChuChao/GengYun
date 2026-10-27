# GY-R67-D01 未接线白名单理由证据页（2026-10-27）

本页记录 R67-D01 的交付：把 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS`（53 条，每条 = 一个 `tests/integration/*.mjs` 脚本 + 一句 `reason`）从「一句『需真实 PG』打发四类不同的东西」改成**按四类说当时的真话**，并把这件真话钉成机器判据。

- 基线 `108ab0d3`；分支 `feat/gy-r67-d01-reasons`。
- 改动：改 `tests/unit/ci-integration-chain-structure.test.mjs`（**344 行 `reason` 行原地换成 344 行新文本**；数组区另外 170 行非 `reason` 行——53 行 `  {`、53 行 `    path:`、53 行 `  },`、11 行条目内 `//` 注释——与基线**逐字一致**；**文件总行数 738 → 738 不变**）；新增 `tests/unit/ci-unwired-declaration-reasons.test.mjs`（397 行）；新增本页。
- 未碰：`.github/**`、`packages/contracts/**`、`services/**`、`apps/**`、迁移、`tools/**`。本片不改 TS，故未跑 `npm run build`。
- 两份被改/新增的测试文件均 UTF-8 无 BOM + LF（`BOM=false CRLF=false`，见 §7）。

## 0 本片要解决的病

判据 4 的口径是：`tests/integration/*.mjs` 要么在 `package.json` 的 `test:integration:http` 回环链里，要么必须在白名单里写明原因。它**只认那条 npm 链，不认识 workflow**。

于是白名单里 53 条 `reason` 大面积退化成同一句「需真实 PG，留作后续接线」。这句话在三层上都失真：

1. **它就是假的**：#663／#666（以及 R32、R67-C3）早就把其中 49 条接进了 workflow 的真库 job，它们每个 PR 都在真跑；说「留作后续接线」等于把已接线说成没接线。
2. **它把四类混成一句**：真被 CI 跑的、driver／fixture／反向控制这类**根本不是门禁入口**的、真缺口、纯 HTTP/内存桩——四种完全不同的处境共用一个理由，人工扫读时无法区分「这条要人盯」和「这条不需要盯」。
3. **它让判据失去意义**：`reason` 的唯一作用就是「为什么没进 npm 链」，一句可以套给任何条目的理由，等于没有登记。

⛔ 本片不动的口径：判据 4 仍然只认 npm 链（这是 D01 的前提，改它属另一片）；白名单条目数仍然是**恰好 53**；判据 5 的 `reason.trim().length < 8` ⇒ 红仍然保留。

## 1 四类分类实测（53 条）

分类不是按「看起来像」猜的，是按 `.github/workflows/*.yml` 的 `run:` 命令文本 + 脚本被谁引用逐条核出来的：**49 条**真被某个 workflow 的某次 `run:` 执行（`node tests/integration/<x>.mjs` 出现在该 job 的命令文本里），**4 条**只能被别的脚本／人调用、不在任何 workflow 的 `run:` 里，**真缺口 0 条**，**纯桩 0 条**。

| 类 | 条数 | 脚本（按归属 `workflow#job` 分组） |
| --- | --- | --- |
| 已接线（workflow） | 49 | 见下（按 `workflow#job` 分 9 组，实计 31+2+6+4+2+1+1+1+1） |
| 非门禁入口 | 4 | `favorites-history-isolation-http.reverse-control.mjs`、`knowledge-native-consumer.mjs`、`local-knowledge-smoke.mjs`、`profile-ui-fixture.mjs` |
| 未接线（真缺口） | 0 | —— |
| 不需要真库 | 0 | —— |

已接线的 49 条按 job 分组：

- `real-pg-integration.yml#real-pg-17-11`（31 条）：`account-deletion-pg`、`third-party-deletion-pg`、`account-suspend-pg`、`admin-accounts-read-pg`、`admin-audit-logs-pg`、`admin-community-posts-pg`、`admin-post-hide-audit-pg`、`admin-jobs-pg`、`admin-flags-pg`、`backup-purge-pg`、`backup-copies-purge-pg`、`community-filter-pg`、`qa-citations-pg`、`community-pg`、`conversations-pg`、`favorites-history-pg`、`media-persistence-pg`、`media-concurrency-pg`、`messages-pg`、`message-events-pg`、`messages-purge-pg`、`moderation-ledger-pg`、`ocr-corrections-pg`、`ocr-jobs-pg`、`recognition-chain-e2e`、`recognitions-pg`、`retention-purge-pg`、`speech-pg`、`user-chain-e2e`、`online-purge-pg`、`third-party-deletion-sql-pg`
- `real-pg-integration.yml#real-pg-admin-read-17-11`（2 条）：`admin-scopes-read-pg`、`admin-posts-read-pg`
- `real-pg-integration.yml#real-pg-admin-write-17-11`（6 条）：`admin-scopes-authority-pg`、`admin-content-pg`、`media-row-purge-pg`、`moderation-full-chain-pg`、`recognitions-speech-purge-pg`、`retention-clock-drill-pg`
- `consent-grant-postgres.yml#consent-grant-pg`（4 条）：`consent-grant-pg`、`egress-ledger-pg`、`egress-object-key-pg`、`egress-revoke-race-pg`
- `auth-privacy-postgres.yml#auth-privacy-pg`（2 条）：`auth-privacy-pg`、`migrations-negative-pg`
- `catalog-postgres.yml#catalog-pg`（1 条）：`catalog-pg`
- `source-lifecycle-postgres.yml#lifecycle-pg`（1 条）：`source-lifecycle-pg`
- `staging-intake-postgres.yml#intake-pg`（1 条）：`staging-intake-pg`
- `workbook-staging.yml#staging-pg17`（1 条）：`workbook-staging-pg`

⚠️ job 键是**连字符**：`real-pg-17-11`、`real-pg-admin-read-17-11`、`real-pg-admin-write-17-11`（`.github/workflows/real-pg-integration.yml:49`、`:766`、`:895`）。带点的 `real-pg-17.11` 只是 `name:` 里的显示名与人读注释，**不是 job 键**——派单与旧理由里写的都是显示名写法，直接拿去当判据会假红。

## 2 每条 `reason` 现在的形状

四类各举一条（原文，未删节）：

- 已接线：「`已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它（同一 `run:` 行先 `CREATE DATABASE gengyun_deletion_test`，再把该库 owner URL 作 argv[2]）……`」——写出 workflow 文件 + job 键 + step 的识别方式（有名字的写名字，**没有名字的写它 `run:` 行里的 `CREATE DATABASE <库>`**）。
- 非门禁入口：「`非门禁入口：**被 import 的夹具模块**（导出 `createProfileFixture`），由 `tests/integration/profile-ui-http.test.mjs` 用 `import` 语句从 `./profile-ui-fixture.mjs` 取 `createProfileFixture` 后调用……`」——写出**谁、以什么形态**调用它。
- 未接线（真缺口）：本片实测 0 条（规则仍生效：必须写清缺什么，且必须不被任何 `run:` 跑到）。
- 不需要真库：本片实测 0 条（规则仍生效：必须不被任何 `run:` 跑到）。

**行数约束**：`docs/verification/**` 里有手写行号锚点指着那 53 条各自的区间（例如 `tests/unit/ci-integration-chain-structure.test.mjs:104-118`、`:172-192`），所以每条 `reason` 只能**原地换字符串**：条目数 53 不变、逐条 `reason` 行数不变、文件总行数 738 不变。改写器把长句按中文标点（`，。；、：）`、`（`）重新分行到恰好等于原行数，并保证**不切断反引号里的代码/标识符**（例如不会出现 `admin-scopes-a` / `uthority-pg` 这种断法）。

**「行数不变」不等于「只改了 reason」**：第一版改写器把条目内部的 `//` 注释也算进了 `reason` 的行预算，于是把 11 行注释整块吃掉、用 reason 文字把行数填满——总行数仍然 738，逐条行数也仍然对得上，单看行数完全看不出问题。所以本片改用**非 reason 行多重集比对**兜底：取 `git show 108ab0d3:tests/unit/ci-integration-chain-structure.test.mjs` 与工作树逐行比，只忽略 `    reason: '…'` / `      + '…'` 形状的行，要求「只在基线出现的非 reason 行」与「只在新文件出现的非 reason 行」都为 **0 条**。定稿实测：数组区 514 行里 170 行非 reason 行与基线逐字一致（含 11 行注释：`message-events-pg` 2 行、`retention-clock-drill-pg` 3 行、`retention-purge-pg` 2 行、`third-party-deletion-sql-pg` 4 行），344 行 reason 行同索引 1:1 换掉，文件仍 738 行。

## 3 机器判据：`tests/unit/ci-unwired-declaration-reasons.test.mjs`

### 3.1 为什么放在新文件

1. 追加到 `ci-integration-chain-structure.test.mjs` 会把它的总行数从 738 顶到 739 以上，`docs/verification/**` 的行号锚点集体漂移；
2. 本仓没有「一个 `*.test.mjs` import 另一个」的先例，`import ci-integration-chain-structure.test.mjs` 会在本进程**重复注册并重跑**它那 7 条子测试。

所以新文件只**读**两样东西：那个文件的源文本（`tests/unit/ci-unwired-declaration-reasons.test.mjs:47` 的 `parseDeclarations` 解析 `UNWIRED_DECLARATIONS` 的数组形状）+ `.github/workflows/*.yml` 的文本（`:197` 的 `audit` 汇总）。解析不全会**抛**，不会静默跳过。

### 3.2 判据

1. **四类前缀**：每条 `reason` 必须以 `已接线（workflow）：`／`非门禁入口：`／`未接线（真缺口）：`／`不需要真库：` 之一开头；
2. **job 名从 yml 解析，不硬编码**：`已接线（workflow）：` 里的 `\.github/workflows/<file>#<job>` 引用的文件必须存在、job 键必须在**那份 yml 解析出来的 job 键集合**里（`jobsOf`，`:94`）；并且该 job 的命令文本里必须真的出现 `node <这个脚本>`；
3. **双向一致**：被任何 workflow 的 `run:` 跑到的白名单脚本，必须登记成已接线（反之亦然：登记成已接线的必须真被跑）；
4. **另外三类不许偷懒**：`非门禁入口`／`未接线（真缺口）`／`不需要真库` 必须**都不被任何 workflow 的 `run:` 跑到**，否则分类本身就是在说假话；`非门禁入口` 还必须引一个**真实存在、且正文真提到这个脚本**的调用方文件（`tests/integration/profile-ui-http.test.mjs`、`docs/verification/local-knowledge-native-20261011.md` 等），`未接线（真缺口）` 必须写出「缺」什么；
5. **下界与计数**：`已接线条数 === 真被 `run:` 跑到的白名单脚本数`（实测 49），另外单独钉 `>= 8`。

### 3.3 为什么 `已接线` 只钉 `>= 8` 的下界

精确值由判据 3 的**双向相等**导出（本片树上是 49），写死 49 会在下一条接线臂接进来时变成永久假红；`>= 8` 只用来钉「不可能退化成一刀切」——R67-C/C3 的两个 admin job 本身就接了 8 条臂，连它们都没认出来就说明判据没在工作。

### 3.4 为什么 `未接线（真缺口）` 没有钉 `>= 1`

派单要求「`非门禁入口` 与 `未接线（真缺口）` 两类必须各自 ≥1 条（防止以后退化成一刀切）」。实测：**53 条里真缺口是 0 条**——49 条已被 workflow 真跑，剩下 4 条是 driver／fixture／反向控制，都不是「该接而没接」。要满足「≥1」就得把某条已接线或非门禁入口**编造成真缺口**，那正好是本片要消灭的失真。

因此本片对该要求做了一处**明写的偏离**：`非门禁入口 >= 1` 保留（实测 4）；`未接线（真缺口）` 不钉条数，改成两条更强的约束——「该类必须不被任何 `run:` 跑到」+「必须写清缺什么」。真正防「一刀切」的是判据 3 的双向相等与判据 4 的交叉一致性：把 4 条非门禁入口改写成「已接线」会立刻红（它们不被任何 `run:` 跑到），把已接线的改写成「非门禁入口」也会立刻红。**此偏离待指挥裁定**（若要强制 ≥1，需要先在树上找到一条真的该接而没接的脚本）。

## 4 判别力自证（两条，真跑）

两条都用**真文件变异**跑（不是只在测试内部造字符串）：先备份文件，变异，跑判据，再从备份恢复。定稿树（补齐 11 行 `//` 注释之后）又各跑了一遍，红输出与行号与下面记录的完全一致。

### 4.1 把第 1 条的 `reason` 改回旧措辞「需真实 PG」⇒ 红

命令：`node tests/unit/ci-unwired-declaration-reasons.test.mjs` 的 runner 形态 `node --test tests/unit/ci-unwired-declaration-reasons.test.mjs`，变异器把第 70–74 行那条 5 行 `reason` 压成一行 `reason: '需真实 PG，留作后续接线。'`。红输出（原文）：

```text
✖ 未接线白名单理由：四类前缀、job 名从 yml 解析、双向一致 (12.9547ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
✖ failing tests:
✖ 未接线白名单理由：四类前缀、job 名从 yml 解析、双向一致 (12.9547ms)
    - tests/integration/account-deletion-pg.mjs（第 69 行）：reason 没有四类前缀之一（当前开头「需真实 PG，留作后续接线。」）
    - 已接线条数 48 ≠ 真被 workflow run: 跑到的白名单脚本数 49
    actual: [ ... , '四类计数合计 52 ≠ 条目数 53' ]
```

### 4.2 把 job 名改成 `no-such-job` ⇒ 红

变异器把全部 31 处 `#real-pg-17-11` 换成 `#no-such-job`。红输出（原文，节选前 8 行，实际逐条列出 31 条）：

```text
✖ 未接线白名单理由：四类前缀、job 名从 yml 解析、双向一致 (14.9233ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
    - tests/integration/account-deletion-pg.mjs（第 69 行）：引用的 job 键在 real-pg-integration.yml 里不存在（no-such-job）
    - tests/integration/third-party-deletion-pg.mjs（第 77 行）：引用的 job 键在 real-pg-integration.yml 里不存在（no-such-job）
    - tests/integration/account-suspend-pg.mjs（第 88 行）：引用的 job 键在 real-pg-integration.yml 里不存在（no-such-job）
    - tests/integration/admin-accounts-read-pg.mjs（第 98 行）：引用的 job 键在 real-pg-integration.yml 里不存在（no-such-job）
    ...
```

恢复备份后：`ℹ tests 7 / ℹ pass 7 / ℹ fail 0`。

这两条同时被**常驻**在判据里（`:370` 与 `:386` 两条子测试，在内存里对同一套 `audit` 函数做同样的变异），所以以后有人把措辞改回去、或写个不存在的 job 名，`npm run test:unit` 直接红。

## 5 顺带核到、**没有修**的 D02 残余

`tests/unit/ci-real-pg-wiring.test.mjs` 的判据⑨（`tests/unit/ci-real-pg-wiring.test.mjs:1209-1222` 的本体，用例在 `:2096-2098`）只把**一份** workflow 的文本喂进去：`:52` 的 `REAL_PG_WORKFLOW` 硬钉 `real-pg-integration.yml`，用例里 `source` 也只取这一份。

后果：`auth-privacy-postgres.yml`／`catalog-postgres.yml`／`consent-grant-postgres.yml`／`source-lifecycle-postgres.yml`／`staging-intake-postgres.yml`／`workbook-staging.yml` 这 6 份 workflow 里真跑的受管脚本，判据⑨ 看不见；它们与 `MANAGED_SCRIPTS` 是否双向相等，目前没有任何判据在看。这是**已知的 D02 残余**（D02 的事是「判据只锚一份 workflow」），本片按派单只记录、**不修**——改它要动 `ci-real-pg-wiring.test.mjs` 的判据口径与 `REQUIRED_STEP_ORDER` 一族，超出 R67-D01 的边界。

本片的判据不受这个残余影响：`tests/unit/ci-unwired-declaration-reasons.test.mjs` 每次都扫**全部** 15 份 workflow（`loadWorkflows`，`:171`）。

## 6 与派单说法不符的实测事实

1. **「其余条目里还有一批是真·未接线（真缺口）」 ⇒ 实测 0 条**。53 条里 49 条已被 workflow 真跑，另 4 条是 driver／fixture／反向控制／需要窗口目录参数的非门禁入口。本片没有找到任何「该接而没接」的脚本。
2. **job 名写法不符**：派单写 `real-pg-17.11`／`real-pg-admin-read-17.11`／`real-pg-admin-write-17.11`，真 job 键是 `real-pg-17-11`／`real-pg-admin-read-17-11`／`real-pg-admin-write-17-11`（`real-pg-integration.yml:49`、`:766`、`:895`）；带点的是 `name:` 显示名。判据按真 job 键写。
3. **两条旧理由写「本片未接进 workflow／如实登记为未接线」，但真值相反**：`online-purge-pg.mjs`（R32 接进 `real-pg-17-11`）与 `media-row-purge-pg.mjs`（R67-C3 接进 `real-pg-admin-write-17-11`）都已接线。这类「旧理由过期」的失真本片一律按接线事实改写。
4. **「必须写出 step 名」对 30 多条臂不可能字面满足**：`real-pg-17-11` 里多数 step **没有 `name:`**（是单行 `- run: psql … CREATE DATABASE <db> && node tests/integration/<x>.mjs`）。这类条目改用「无名 step + 该 `run:` 行里的 `CREATE DATABASE <库>` 指纹」定位，仍然可机读、可人工核对到唯一一条 step。

## 7 自检读数

| 命令 | 读数 |
| --- | --- |
| `node --test tests/unit/ci-integration-chain-structure.test.mjs` | `tests 7 / pass 7 / fail 0`，duration 100.7ms（基线 `108ab0d3` 同读数；reason 全换、判据 4/5/6 一条没动） |
| `node --test tests/unit/ci-real-pg-wiring.test.mjs` | `tests 18 / pass 18 / fail 0`，duration 968.3ms（基线同读数；本片未改该文件，反向控制⑨⑩仍绿） |
| `node --test tests/unit/ci-unwired-declaration-reasons.test.mjs` | `tests 7 / pass 7 / fail 0`，duration 142.8ms |
| `node tools/verify-doc-anchors.mjs --strict --scan docs` | `EXIT=0`；SCAN 373 份文档 5982 条引用；COUNT BROKEN 4 / OUT_OF_RANGE 2 / SUSPECT 7（合计 13）；BASELINE 登记 13、本次命中 13、**基线外新增 0、陈旧 0**；DRIFT 16 条命中、新增 0、陈旧 0（本页新增的引用全部落在基线内口径） |
| `node tools/verify-contract-status.mjs` | `EXIT=0`；覆盖 126 条契约操作；语义可核 105 区间 + 4 片段；证据锚点 570 条；符号锚点 9 条；行号区间 311 条；中文表格一致 |
| `npm run test:unit`（`$env:GY_BASH='C:\msys64\usr\bin\bash.exe'`） | `tests 5200 / pass 5197 / fail 0 / cancelled 0 / skipped 1 / todo 2`，duration 96092ms，exit 0。基线 `108ab0d3` 实测 `tests 5193 / pass 5190 / fail 0 / skipped 1 / todo 2`（duration 91828ms）——**增量恰为 +7**，即本片新增判据文件的 7 条子测试；其余 5193 条一条没少、没改红。日志里的 `AssertionError` 文本来自负控制用例（如 `tests/unit/i11-audio-mp3-wav-guard.test.mjs:219`），不是真失败。定稿树（补齐 11 行注释之后）重跑同命令，读数一致 |

编码与换行：改动的 2 个测试文件 + 本页均 UTF-8 无 BOM、LF（`BOM=false CRLF=false`）。

本片全程未改 `.github/**`、`services/**`、`apps/**`、`packages/**`、`tools/**`、迁移与任何既有证据页。
