# GY-R67-A2 文档真值钉子证据页（2026-10-27）

本页记录 R67 阶段 A 第二片（A2）的交付：把上一片（A1，提交 `1a8af906`）刚修掉的三类假陈述钉成机器可执行断言，并给 `tools/verify-doc-anchors.mjs` 补上「锚点身份」判据（`ANCHOR_DRIFT`），让「行号指到别的代码上」不再判绿。

- 基线：`1a8af906`（A1 的提交，父 `b1d02c21`）；分支 `feat/gy-r67-docs-pins`。
- 改动范围：新增 `tests/unit/docs-truth-pins.test.mjs`（287 行）；改 `tools/verify-doc-anchors.mjs`（+296／-5，含 16 条基线条目与判据本体）；`docs/architecture/ai-ops-spec-status.md` **只改一行里的半句**（`:110` 行尾，见 §5.1）；新增本页。
- 未碰：`services/**`、`apps/**`、`packages/**`、`tools/doc-anchors-baseline.json`、`docs/architecture/**` 的其它正文、`docs/verification/**` 的历史证据页。本片不改 TS 源码，故未跑 `npm run build --workspace @gengyun/api`。
- 三份被改/新增文件均 UTF-8 无 BOM + LF（`node` 读字节：`BOM=false CRLF=false`；见 §4 末条）。

## 0 本片要解决的病

`tools/verify-doc-anchors.mjs` 原本只有三条**结构性**判据——路径存在（`BROKEN`）、行号在界（`OUT_OF_RANGE`）、区间不是纯注释/空行（`SUSPECT`）。它能发现「`app.ts:1291` 改完代码后变成 :1341」这一半，却**发现不了另一半**：`docs/architecture/ai-ops-spec-status.md:22` 曾把 `app.ts:1291` 直接改写成 `app.ts:1341` 就交了——行号在界、区间有内容，判据全绿，但 `:1341` 指的其实是 `const adminRealUnwired = config.executionMode === 'real';`，而文档想说的是 `:1363-1365`。A1 的 §4.1 有这处实测，A2 就是把它变成会红的判据。

## 1 新钉子：`tests/unit/docs-truth-pins.test.mjs`

`node:test` + `assert/strict`，只读仓库文本/JSON，不联网、不起 PG、不写任何文件。四条钉子对应 A1 修掉的四类失真。

### 1.1 钉 a：错误码计数双向相等

代码侧从 `services/api/src/contract.ts` 抽出 `ERROR_STATUS_MAP` 块（认到 `} as const;` 收尾——只认 `\n};` 会抽不到，因为块尾还带 ` as const`），断言：

- 摊平去重后恰好 **26** 个码（`uniqueCodes.length === 26`）；
- 块内没有重复登记（`codes.length === uniqueCodes.length`）；
- 状态档 **12** 个（与 `ERROR_STATUS_MAP` 的 key 数一致）；
- `ERROR_CODES = Object.values(ERROR_STATUS_MAP).flat()` 与 `const ERROR_CODE_STATUS: ReadonlyMap<string, number>` 仍在（派生常量不是第二份手写清单）。

页面侧用正则抽 `错误码单源 N 码`（`:61`）与 `恰好 N 个错误码`（`:107`），**逐个与代码实数比对**，不写死 26。页面若改成 24（或任何别的数字），断言直接红并打印行号与整行；页面若把读数删掉，也会红（信息丢失同样要人看）。

⛔ 明确不钉 `apps/admin/src/lib/admin-contract.mjs` 的 24：那是 B01（管理端镜像片）已登记的差异，属另一片范围；本文件在头注释里写明了这一点，避免后来者以为漏钉。

### 1.2 钉 b：「后台无页面消费」不许复活

先把撤回引号剥掉：`stripRetractions(line)` 用 `/(?:原写|原文|旧稿|早先写作)「[^」]*」为误/g` 把整段删掉。理由是「原写「后台无入口」为误」这句是在**引用旧陈述并宣布它错了**，属于最有价值的信息，不该因为修完假话就顺手删。剥完若整行只剩空白/标点（`hasStatement` 为假），该行**不判**——避免把「原文引用」当成「现陈述」。

禁词正则收窄成 `/无页面消费|后台(?:仍|也|端|侧)?(?:没有|无)(?:页面)?入口/`，而不是任务书字面的 `无页面消费|无入口`。原因：`无入口` 单独出现多半是**真话**，实测有 6 处（都在本片不改的正文里）：

| 位置 | 原文（真陈述） |
| --- | --- |
| `docs/architecture/ai-ops-spec-status.md:123` | P08「…⇒ 库侧过滤能力无入口」（后台列表 URL 只 set `limit`/`cursor`） |
| 同页 `:221` | 「能力无入口：后台 UI 的列表 URL 只 set `limit` 与 `cursor`」 |
| `docs/architecture/admin-console-capability-map.md:17` | 「后端有面、UI 无入口 12 个 operation」 |
| 同页 `:210` | 「12 条无入口里的全部…」 |
| `docs/architecture/README.md:21` | 「UI 有入口 32 个、无入口 12 个」 |
| `docs/architecture/contract-implementation-status.md:70`（及 `docs/architecture/contract-status.json:572/575`） | 「非本人无入口」 |

字面禁 `无入口` 会把上面 6 句真话一起判红，等于用假绿灯换真话。收窄后仍能抓住目标假话：把 `:125` 的句子改回「后台无入口」立刻红（见 §3.2）。正向控制写在同一个测试里：`库侧过滤能力无入口`、`能力无入口：后台 UI 的列表 URL …` 断言**不**命中禁词，且页面仍含「三读面读数不合并」。

### 1.3 钉 c：`target_ref.revision` 不许再写成恒 1

三件事：

1. 页面（按同一套 `stripRetractions` 口径）不得再出现 `/恒取\s*1|恒\s*1/`；
2. 页面必须出现真值锚点 `jobs-pg\.ts:413`；
3. 该锚点必须**真的还是真值取用**：读 `services/api/src/admin/ops/jobs-pg.ts` 的 410–420 行，断言区间里含 `targetRevision` 或 `UNCREATED_RECORD_REVISION`，且含 `revision: targetRevision ??`。区间对不上时，报错信息写的是「去文本重定位——搜索 `revision: targetRevision ??` 这行赋值，把页面里的 :413 改成真实行号；⛔ 不要只把数字挪 1-2 行凑过校验」。

现状：`services/api/src/admin/ops/jobs-pg.ts:413` 逐字为 `revision: targetRevision ?? UNCREATED_RECORD_REVISION,`；同文件 397-405 行是 `const targetRevision = row.target_revision;`，null 才退回 `UNCREATED_RECORD_REVISION`（非法整数直接 503「作业目标记录 revision 非法」）。

### 1.4 钉 d：`/admin/posts` 家族条数

- `packages/contracts/operations.json`：`path` 以 `/admin/posts` 开头的操作恰 **5** 条，id 集合 = `getAdminPost`/`hidePost`/`listAdminPosts`/`approvePost`/`rejectPost`，方法+路径固定为 `GET /admin/posts`、`GET /admin/posts/{id}`、`POST /admin/posts/{id}/hide`、`POST /admin/posts/{id}/approve`、`POST /admin/posts/{id}/reject`。
- `packages/contracts/openapi.json`：同一家族恰 5 个 path（同样逐一比对），且这些 path 的 `summary`/`description`/`operationId` 里不得出现单条断言（`恰好一条`／`只有一条`／`仅一条`／`唯一的操作`／`只暴露一个操作`）。
- 正则先 grep 确认真实现状再定：全文**没有**「恰好一条」；唯一「恰(好)一」在 `:17064`「两列恰好一个非空（0030 CHECK）」，与 posts 无关；`getAdminPost` 的 description 是「后台帖子详情（管理视角）：一条帖子的管理视图，**含已隐藏与已删除**」——「一条」指**单条资源**，不是「家族只有一条操作」，不能误禁。因此正则里带了负控制：`该家族恰好一条 hidePost 操作` 必须命中，`后台帖子详情（管理视角）：一条帖子的管理视图` 必须不命中。
- 原先「`/admin/posts` 恰好一条」那句假话在 `docs/verification/**` 的历史证据页里（本片范围外，不动）。

## 2 `tools/verify-doc-anchors.mjs` 新增 `ANCHOR_DRIFT`

### 2.1 判据定义

对**含至少一条可解析「路径:行号」引用的文档行**：

1. 抽出该行所有行内代码片段（``` `…` ```），逐个过滤——去空白后必须：长度 ≥ 12；不是锚点自身（`x.ext:NNN`）；不含 `://`；不以 `GET|POST|PUT|PATCH|DELETE /` 开头（那是路由，不是代码）；含空白；含 `=;(){}` 之一；不含省略号 `...`／`…`；且**该片段在本文件里只出现在这一行**（同一片段在别处也写过 ⇒ 归属不唯一，不判）。
2. 归一化比较：`norm(s) = s.trim().replace(/\s+/g,' ').replace(/;+$/,'')`；命中 = `norm(目标行).includes(norm(片段))`。
3. 任一命中落在任一引用的 `[from-2, to+2]` 内 ⇒ 该行**绿**。
4. 否则，若某条引用「片段恰 1 处命中且不在窗口内」⇒ `ANCHOR_DRIFT`（`drift-unique`，报实际行号并给出「建议改写成 路径:实际行号」，可自动重锚）。
5. 否则，若该行**只有 1 条引用**且所有片段在目标文件 0 命中 ⇒ `ANCHOR_DRIFT`（`drift-gone`，不可自动，需人工判断改文档还是改代码）。
6. 其余（多引用行 0 命中、片段多处命中、行内没有合格片段）⇒ **只计数不判红**（dry-run 也打印，但不进 exit code）。

没有行内代码片段的引用行一律跳过——现状里这类占绝大多数（535 行引用行中跳过 505 行），不跳过会一上来红一片，判据就没法落地。

### 2.2 边界：为什么只对 `docs/architecture/**` 判红

`docs/verification/**` 是**当时的**证据页：它记录的是「那棵树、那次运行」的行号与片段，后来代码演进是正常现象；对这些页面判「锚点身份」，等于要求历史记录跟着现在改，既做不到也不该做（A1 的实测里，历史页的陈旧锚点会一次红出上百条）。所以 `ANCHOR_DRIFT` 的扫描面由 `ANCHOR_DRIFT_SCOPE = 'docs/architecture/'` 卡死：`--scan docs`、默认 targets（`docs/architecture` + `docs/verification`）都只对架构页判，其余页面连读数都不进 `DRIFT-COUNT`。范围写死成常量而不是参数，是为了避免「哪天有人 `--scan` 换个目录，判据静默失效」。

### 2.3 基线：N=16，具名常量，不是数字上限

实测（本判据实现后、常量仍为空时跑工具）：**16 条**（`drift-unique` 7 + `drift-gone` 9）。这个数与落地前的探针（v4 口径，仓外一次性脚本 `E:\GengYunCommander\.pg17\probe-drift*.mjs`）一致，说明口径移植没有漂。

基线条目写成 `tools/verify-doc-anchors.mjs` 里的显式常量 `ARCHITECTURE_ANCHOR_BASELINE`（16 个字符串，每个形如 `文档:行号#片段指纹`，行尾带「判定档｜片段实际落点｜归类」注释），**不是数字 16，也不是 `<= 16`**——多一条未登记的漂移就红，少一条（修好了）该条变 `STALE-DRIFT` 提示。

| # | 文档:行 | 判定 | 片段实际落点 | 归类 |
| --- | --- | --- | --- | --- |
| 1 | `docs/architecture/acceptance-map.md:69` | drift-unique | `services/api/src/moderation/nonbypass.ts:15` | 归属误判：片段属同行散文写的 `moderation/types.ts:110-115` |
| 2 | `docs/architecture/ai-ops-spec-status.md:197` | drift-gone | 0 命中 | 真漂移：`service.ts:776-780` 现在是 `account.suspend` 审计；`job_cancelled` 在 `service.ts:880/962` |
| 3 | `docs/architecture/gy-i19-user-backup-copies-design.md:26` | drift-unique | `services/api/src/privacy/user-data-deletion.ts:329` | 历史树锚点（页内声明行号属 GY-R34-I19 树） |
| 4 | 同页 `:303` | drift-gone | 0 命中 | 历史树锚点 |
| 5 | 同页 `:312` | drift-gone | 0 命中 | 历史树锚点 |
| 6 | 同页 `:354` | drift-gone | 0 命中 | 历史树锚点 |
| 7 | `docs/architecture/gy-r34-retention-policy.md:46` | drift-unique | `services/api/src/community/store-pg.ts:1086` | 真漂移 |
| 8 | 同页 `:112` | drift-gone | 0 命中 | 表述差异：实际 `GRANT UPDATE (token_hash,revoked_at) ON admin_sessions` |
| 9 | 同页 `:156` | drift-unique | `services/api/src/auth/idempotency.ts:261` | 真漂移（同句已写 `:261`） |
| 10 | `docs/architecture/gy-r59-retention-backup-thirdparty-map.md:32` | drift-gone | 0 命中 | 归属误判：片段属同行的 `tools/purge-expired-online-data.mjs:16` |
| 11 | 同页 `:33` | drift-gone | 0 命中 | 归属误判（同上，`package.json:34`） |
| 12 | 同页 `:84` | drift-gone | 0 命中 | 表述差异：SQL 是 `CREATE FUNCTION public.record_third_party_deletion(` 多行签名 |
| 13 | 同页 `:108` | drift-unique | `services/api/src/privacy/backup-replay-manifest.ts:85` | 真漂移（同句已写 `:85`） |
| 14 | `docs/architecture/rate-limit-policy.md:185` | drift-gone | 0 命中 | 真漂移：`app.ts:2450-2455` 现为 OCR 作业源注释；`hop < trustProxy` 在 `app.ts:2716` 且带类型标注 |
| 15 | `docs/architecture/s4-data-traceability.md:186` | drift-unique | `services/api/src/app.ts:2221` | 真漂移 |
| 16 | `docs/architecture/state-contract.md:117` | drift-unique | `services/api/db/migrations/0023_user_backup_copies.sql:75` | 真漂移（引用写的是 `:34`） |

**为什么不用 `--emit-baseline`／`--write-baseline`**：那套基线条目形状是 `path|reason|reference`，只覆盖 `BROKEN`/`OUT_OF_RANGE`/`SUSPECT` 三条结构判据，而且 `tests/unit/doc-anchors-guard.test.mjs` 要求「条目陈旧就必须删」；把 16 条漂移混进 `tools/doc-anchors-baseline.json` 会让那份文件的语义变味、让两套陈旧处理互相牵制。因此这里是**独立常量**，`tools/doc-anchors-baseline.json` 的 13 条一个字没动，两套互不干扰（`--emit-baseline`／`--write-baseline` 的语义也未改：它们只处理结构三判据）。

**为什么 `STALE-DRIFT` 不判红**：历史树锚点被修掉、或文档行重写让片段对不上以后，基线条目就该删；若陈旧也判红，合并会被「基线腐烂」永久卡住，反而逼人去放宽判据。所以陈旧只打印清单（最多 20 条），不进 exit code——与既有 13 条基线里 `STALE` 的语义保持一致。

**这是有意为之的收紧**：合入后，任何新 PR 只要在 `docs/architecture/**` 里写下「行号 + 行内代码片段」而片段指到别处，CI 就会红。自救路径两条：① 按报错给的「实际行号」做**文本重定位**，把引用改成片段真正所在的行；② 确属历史遗留或归属不唯一（一张表里多个引用共用一句注解）的，人工裁决后把该 key 加进 `ARCHITECTURE_ANCHOR_BASELINE` 并写清归类。⛔ `--emit-baseline` 不管这条判据——它不会替你把这 16 条或任何 `ANCHOR_DRIFT` 登记进去。

### 2.4 向后兼容

- 结构三判据的 `collectFindings()` 返回值**一个字没改**（`findings`/`stats`/`unresolved` 形状不变），`tests/unit/doc-anchors-guard.test.mjs` 10 个用例全绿（含「判据是结构性的：不得引入内容哈希」——所以基线 key 用片段原文，没用 sha1）。
- 新增的是并列的 `collectAnchorDrift({ root, targets })`、`driftBaselineKey(finding)`、`partitionDriftByBaseline(findings)`、`describeDrift(finding)`、`printDriftSummary()` 与常量；`main()` 先打结构读数与 `STALE`，再打 `DRIFT:` / `DRIFT-COUNT:` / `DRIFT-BASELINE:` 三行，最后 `structuralFailed || driftFailed` 才 exit 1。
- `--symbol=count` 与 dry-run 未受影响（`node tools/verify-doc-anchors.mjs --symbol=count --scan docs/architecture` exit 0）。

## 3 自证

### 3.1 先红后绿①：把 `:61` 的 26 改回 24

改回后 `node --test tests/unit/docs-truth-pins.test.mjs`（原文，节选首尾）：

```text
  ✖ 页面侧：写的「26 码」与代码实数一致（改成任何别的数字都必须红） (4.088ms)
✖ 钉 a：错误码计数双向相等 (6.3936ms)
ℹ pass 8
ℹ fail 1
✖ failing tests:
✖ 页面侧：写的「26 码」与代码实数一致（改成任何别的数字都必须红） (4.088ms)
  AssertionError [ERR_ASSERTION]: 第 61 行写的错误码数与 services/api/src/contract.ts 的实数不符：页面 24 / 代码 26
```

还原后：文件 SHA256 `b874b4f5c8059c374a926f9b3f7f6bb79e12e5c78e4bdaf4956a667ab9db08d1`，`node --test` 回到 `pass 9 / fail 0`。

### 3.2 先红后绿②：把 `:125` 改回「后台无入口」

在 `:125` 的句子里插回「后台无入口」（`，后台无入口，另两个审计页仍分别只接内存读面…`），`node --test tests/unit/docs-truth-pins.test.mjs`（原文，节选）：

```text
  ✖ 架构页不得再断言后台没有页面消费该读面 (5.1913ms)
✖ 钉 b：「后台无页面消费」这一族断言不许复活 (6.9606ms)
ℹ pass 8
ℹ fail 1
  AssertionError [ERR_ASSERTION]: docs/architecture/ai-ops-spec-status.md 又出现了「后台无页面消费／后台无入口」这一族断言（真值：apps/admin/src/views/AuditLogsView.vue 已在消费 GET /admin/audit-logs，见 P10）：
  第 125 行：| P10 | 后台审计三读面权威分离（内存／开关库函数／全表库函数） | 部分实现 | services/api/src/admin/audit/service.ts:14-16 | 闭集那半条已随 #609 补齐（E40）；出口侧：审计总台账页已消费全表读面（`apps/admin/src/views/AuditLogsView.vue:72` 调 `listAuditLogs`，导航 `apps/admin/src/App.vue:33`、渲染 `apps/admin/src/App.vue:70`，#633），后台无入口，另两个审计页仍分别只接内存读面（apps/admin/src/lib/audit-events.mjs:33）与只认 `set_flag` 的开关审计面（apps/admin/src/lib/flag-audit.mjs:54）⇒ 三读面读数不能合并、页面读数也无端到端验收，故仍判部分实现。原写「全仓没有页面消费 `GET /admin/audit-logs`」为误，见 `docs/verification/gy-r67-docs-truth-20261027.md` |
```

还原后 SHA256 同上（`b874b4f5…08d1`），`pass 9 / fail 0`。

### 3.3 `ANCHOR_DRIFT` 判别力：把 `:1341` 挪成 `:1344`

`docs/architecture/ai-ops-spec-status.md:212` 引用 `services/api/src/app.ts:1341`（片段 `const adminRealUnwired = config.executionMode === 'real'`）。把该引用临时改成 `:1344` 后（`:1342-1345` 是注释，片段只在 `:1341`）：

```text
DRIFT-COUNT: ANCHOR_DRIFT 17 条（可按文本重定位 8 条 / 需人工确认 9 条）
DRIFT-BASELINE: ARCHITECTURE_ANCHOR_BASELINE 登记 16 条；本次命中 16 条、基线外新增 1 条、陈旧 0 条
FAIL: 锚点身份闸门未通过（ANCHOR_DRIFT 基线之外新增 1 条；判据只管 docs/architecture/**）
  · docs/architecture/ai-ops-spec-status.md:212 → services/api/src/app.ts:1344（drift-unique，实际在第 1341 行；建议改写成 services/api/src/app.ts:1341；owner=api-server）
EXIT=1
```

注意：结构三判据读数仍是「13 条基线、新增 0」——**旧工具在此刻是绿的**，这正好说明新判据补的是它判不出的那一半。

还原后 SHA256 同上，`DRIFT-COUNT: 16`、`DRIFT-BASELINE: … 新增 0`、`PASS`、`EXIT=0`。

## 4 门禁读数（原文）

```text
$ node --test tests/unit/doc-truth-pins.test.mjs
▶ 钉 a：错误码计数双向相等
  ✔ 代码侧：ERROR_STATUS_MAP 摊平去重后恰好 26 码、12 个状态档 (1.8274ms)
  ✔ 页面侧：写的「26 码」与代码实数一致（改成任何别的数字都必须红） (1.2667ms)
✔ 钉 a：错误码计数双向相等 (3.9126ms)
▶ 钉 b：「后台无页面消费」这一族断言不许复活
  ✔ 架构页不得再断言后台没有页面消费该读面 (3.1292ms)
  ✔ 真话不受牵连：「能力无入口」「三读面读数不合并」仍然可以写 (0.6479ms)
✔ 钉 b：「后台无页面消费」这一族断言不许复活 (3.9508ms)
▶ 钉 c：target_ref.revision 不许再写成恒 1
  ✔ 页面不得再写「恒取 1」／「恒 1」 (1.5899ms)
  ✔ 页面必须给出真值锚点 jobs-pg.ts:413 (0.5727ms)
  ✔ 锚点必须仍然指在真值取用上（文件行数变动请去文本重定位，不要只改数字） (0.6353ms)
✔ 钉 c：target_ref.revision 不许再写成恒 1 (3.0783ms)
▶ 钉 d：/admin/posts 家族条数
  ✔ 契约里 /admin/posts 前缀恰好 5 条操作，id 集合固定 (0.6561ms)
  ✔ OpenAPI 里同样 5 条 path，且没有「恰好一条」这类单条断言 (4.7976ms)
✔ 钉 d：/admin/posts 家族条数 (5.6449ms)
ℹ tests 9
ℹ suites 4
ℹ pass 9
ℹ fail 0
```

```text
$ node tools/verify-doc-anchors.mjs --strict --scan docs
SCAN: 文档 365 份；抽出「路径:行号」引用 5872 条（解析成功 5646 条、同名多文件无法唯一解析 216 条不计红、同文档重复 8 条已去重）
COUNT: BROKEN 4 / OUT_OF_RANGE 2 / SUSPECT 7（合计 13 条；另只计数不判红：区间首行为空行 106 条、区间全是注释行 775 条）
BASELINE: tools/doc-anchors-baseline.json 登记 13 条；本次命中 13 条、基线外新增 0 条、陈旧 0 条
MODE: --strict（只在新增加非零时 exit 1）
DRIFT: 作用域 docs/architecture/**（17 份文档）；带「路径:行号」引用的行 535 行——无行内代码片段跳过 505 行、区间内命中 9 行、归属或文本不唯一只计数 5 行
DRIFT-COUNT: ANCHOR_DRIFT 16 条（可按文本重定位 7 条 / 需人工确认 9 条）
DRIFT-BASELINE: ARCHITECTURE_ANCHOR_BASELINE 登记 16 条；本次命中 16 条、基线外新增 0 条、陈旧 0 条
PASS: --strict 下没有基线之外的新增（结构三判据与 ANCHOR_DRIFT 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT）
EXIT=0

$ node tools/verify-doc-anchors.mjs --strict          # CI 用法（默认 targets 含 docs/verification）
… DRIFT-COUNT: ANCHOR_DRIFT 16 条（可按文本重定位 7 条 / 需人工确认 9 条）
… DRIFT-BASELINE: ARCHITECTURE_ANCHOR_BASELINE 登记 16 条；本次命中 16 条、基线外新增 0 条、陈旧 0 条
PASS: --strict 下没有基线之外的新增（结构三判据与 ANCHOR_DRIFT 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT）
EXIT=0

$ node --test tests/unit/doc-anchors-guard.test.mjs
✔ 判据是结构性的：不得引入内容哈希（sha256 全等会把任何合法改代码都判红） (0.9202ms)
ℹ tests 10
ℹ pass 10
ℹ fail 0

$ node tools/verify-contract-status.mjs
PASS: 行号区间 305 条（台账直写 302 条 + 符号解析 3 条；有实质内容 305 条；整段仅空白/收尾行 0 条、区间首行为空行 16 条，只计可疑不判红）
PASS: 中文表格一致
EXIT=0

$ python tools/validate_development_docs.py
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
EXIT=0

$ python tools/validate_contracts.py
PASS: 124 operations; contract consistency; 29 fixtures; 30 media traces; 8 knowledge roundtrips (design only, not runtime tests)
EXIT=0

$ node tools/verify-migrations-unique.mjs
[gap] 缺号有「故意跳过」依据（1 个）：0037 → README.md:26
PASS：5 项判据全部满足（surface / runner / dup / coexist / rollback）；45 条配对 + 1 条登记允许缺省 = 46 条正向迁移逐条有交代。
EXIT=0
```

编码：`tools/verify-doc-anchors.mjs`、`tests/unit/docs-truth-pins.test.mjs`、`docs/architecture/ai-ops-spec-status.md` 三份文件 `BOM=false CRLF=false`（`node` 读字节判首三字节与 `0x0D`）。

## 5 未取得项与需要审的判断

### 5.1 `:110` 的 E40 整行另由 #659 处理

本片只改了 `docs/architecture/ai-ops-spec-status.md:110` **行尾那半句**：`剩余边界：后台无页面消费该读面（P10）` → `剩余边界：该读面已有页面消费（P10），三读面读数不合并`。理由是它与同页 `:57`／`:125`／`:203` 已改的真值直接打架，不改就没有「先红后绿」可演。E40 的「恰七值/恰八值」与锚点数字**没碰**——在飞 PR #659 会整行重写 E40，落地时 rebase 合并这半句即可。

### 5.2 现状 16 条漂移：登记基线，不改文档

`docs/architecture/**` 下这 16 条里，8 条是真漂移（②⑦⑨⑬⑭⑮⑯ 与 ⑧ 的表述差异）、3 条是「一句注解配多条引用」的归属误判（①⑩⑪）、4 条是历史树锚点（③④⑤⑥）。本片的边界是「不改其它 `docs/architecture/**` 正文」，所以选择**如实登记基线**而不是顺手改文档。这是我认为最可能被不同意的判断：登记基线的确让这 16 条不再判红，但判据对**新增**第 17 条立刻红（§3.3 已演），而且每条都写了归类与真实落点，后续谁修都能对照删除。若要求「零基线」，需要另开一片改这 16 处文档（历史树那页还得先决定是否提行号口径）。

### 5.3 判据的保守面

- 多引用行里片段 0 命中只计数（`ambiguous`）：`gy-r59…:32/33` 这类一行多引用的表格，片段归属本身就不唯一，判红会误伤，所以只打印。
- `drift-unique` 允许「自动重锚」只是给出建议，工具不写盘：本片不引入 `--fix`，避免误改文档。
- `ANCHOR_DRIFT` 只认行内代码片段；纯符号名、路由、文件名都不算指纹——这是为了不再出现「一上来红一片」的量级（探针实测：无过滤时 344 条，最终口径 16 条）。

### 5.4 派单书里另有、但本片未做的项

- 派单书要求再钉 6 项计数（`AUDIT_ACTIONS`／`entity` 闭集／operations 124／迁移 47／integration 67 等）与「`SUSPECT` 两类在 `--strict` 下判红」；用户消息的必做项里没有它们，本片按用户消息执行，未加（加了会与 #659 的 E40 整行改动面重叠）。
- 派单书称 `AUDIT_ACTIONS` = 8，而架构页 `:110` 写「恰七值」并由 `tests/unit/admin-audit-action-jobs-cancel.test.mjs` 钉「前 4 项长度仍为 4、第 4 项仍是 `job.cancel`」。本片**不钉这个数字**（用户消息未列，且 #659 正在改这行），只在此记录口径差异，供后续核对。
- 任务书写的 `node tools/validate_contracts.py` 实际是 Python 脚本，已用 `python tools/validate_contracts.py` 跑（见 §4）。
- 未跑 `npm run test:unit` 全量（本片不改 TS 源码，只跑了受影响的 `tests/unit/doc-anchors-guard.test.mjs` 与新钉子；`test:unit` 的 glob `tests/unit/*.test.mjs` 会自动收进新文件）。
