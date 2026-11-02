# GY-R67-A 文档真值修订证据页（2026-10-27）

本页记录五轴审查「文档真值」轴抽样里分给本片的 5 条失真，逐条给出「原文（逐字）→ 为什么是假的（证据 `文件:行号` 或命令输出）→ 改成什么（逐字）→ 复核命令与输出」，并单列对上游审查结论的纠正、未取得项、本片不改但已知为假／不精确的清单。

- 基线：`b1d02c21`（detached），分支 `feat/gy-r67-docs-truth`（本片新建），父提交即 `b1d02c21`。
- 改动范围：只改文档。`docs/architecture/ai-ops-spec-status.md` 14 行、`docs/architecture/admin-console-capability-map.md` 1 行（纯追加）、新增本页。
- 未碰：`docs/architecture/contract-status.json`（受保护文档）、`tools/**`、`services/**`、`apps/**`、`tests/**`、`.github/**`、`packages/**`、`E:\agri-run\**`；`docs/architecture/ai-ops-spec-status.md` 的 E31（:101）／E40（:110）／N02（:133）三行与 :29 一字未动（在飞 PR #659 的改动面）。
- 行数不变：`docs/architecture/ai-ops-spec-status.md` 改动前后均 322 行、`docs/architecture/admin-console-capability-map.md` 均 233 行（全部为单行原地替换／行尾追加，不动段落结构）；两份文件均 UTF-8 无 BOM + LF（`[System.IO.File]::ReadAllBytes` 查 `EF BB BF` 为 False、`ReadAllText` 匹配 `\r\n` 为 False）。

## 0 三条门禁的末行读数

```text
$ node tools/verify-doc-anchors.mjs --strict --scan docs
SCAN: 文档 363 份；抽出「路径:行号」引用 5731 条（解析成功 5508 条、同名多文件无法唯一解析 213 条不计红、同文档重复 8 条已去重）
COUNT: BROKEN 4 / OUT_OF_RANGE 2 / SUSPECT 7（合计 13 条；另只计数不判红：区间首行为空行 106 条、区间全是注释行 757 条）
BASELINE: tools/doc-anchors-baseline.json 登记 13 条；本次命中 13 条、基线外新增 0 条、陈旧 0 条
MODE: --strict（只在新增加非零时 exit 1）
PASS: --strict 下没有基线之外的新增（基线内条目只计数、不判红；陈旧条目见 STALE）
EXIT=0

$ node tools/verify-contract-status.mjs
PASS: 覆盖 124 条契约操作；已装配 124 条；implemented 18 / partial 106 / planned 0；横切维度 8 条；形状错误 0 项；语义错误 0 项
PASS: 语义可核 106 条区间 + 2 条片段；不可核 163 条区间 + 211 条片段（不可核不计入通过）
PASS: 证据锚点 558 条引用自带锚点（区间内 305 条 + 仅整文件 253 条）；无锚点不可核 0 条（纯行号 0 + 无行号源文件 0 + 无用例名 0），只计数不判红
PASS: 行号区间 305 条（台账直写 302 条 + 符号解析 3 条；有实质内容 305 条；整段仅空白/收尾行 0 条、区间首行为空行 16 条，只计可疑不判红）
PASS: 中文表格一致
EXIT=0

$ python tools/validate_development_docs.py
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
EXIT=0
```

**工具能给与不能给的**：`verify-doc-anchors` 只判断「引用的行号在文件里存在且不是空行/纯注释行」，**判不出「行号存在但语义错」**——本次 6 处 `app.ts` 旧行号在基线里既不在 13 条基线条目内、也没被判红（旧行号指向真实存在的代码行），所以这 6 处只能靠文本重定位人工确认（见 §4）；门禁只能证明「没改坏基线」。

## 1 错误码：`恰好 24 个错误码` → 26（任务第 1 条）

### 1.1 原文（逐字）

`docs/architecture/ai-ops-spec-status.md:107`（改前）：

```text
| E37 | 错误码单源：`ERROR_STATUS_MAP` 12 个状态、恰好 24 个错误码 | 已实现 | services/api/src/contract.ts:14-31 | 事实源是 packages/contracts/states.json:108；`packages/contracts/` 下无源码文件 |
```

同一页还有第二处同一断言，`docs/architecture/ai-ops-spec-status.md:61`（改前）：

```text
| 契约单源 | 1 | 1 | 0 | 0 | 0 | 错误码单源 24 码，改动必须过 `states.json` |
```

### 1.2 为什么是假的（证据）

`services/api/src/contract.ts:14-31` 的 `ERROR_STATUS_MAP` 现在是 12 个状态键、**26** 个错误码；`SELF_SCOPE_GRANT_DENIED`（403 档）与 `LAST_SCOPE_MANAGER`（409 档）是 #646 新增。复算方式与输出（`states.json` 是 E37 自己写明的事实源，逐档求和）：

```text
$ $j = Get-Content -Raw -Encoding utf8 packages\contracts\states.json | ConvertFrom-Json; $m = $j.error_status_map
$ $m.PSObject.Properties | ForEach-Object { "$($_.Name): $($_.Value.Count)" }
400: 3
401: 2
403: 4
404: 1
409: 5
413: 1
415: 1
422: 3
428: 1
429: 2
503: 2
504: 1
$ "TOTAL=" + ((...Count) | Measure-Object -Sum).Sum ; "STATUS_KEYS=" + (...)
TOTAL=26
STATUS_KEYS=12
```

`packages/contracts/states.json:108` 逐字为 `"error_status_map": {`（E37 依据列引的锚点仍然对得上）；`services/api/src/contract.ts:14` 逐字 `export const ERROR_STATUS_MAP = {`、`:31` 逐字 `} as const;`，与 `states.json` 逐档一致（26）。全 `docs/**` 里「24 个错误码」只命中 `:107` 这一处，「24 码」只命中 `:61` 这一处，两处都已改；其余形如「24 个」的命中说的是迁移条数、分页操作数等，与错误码无关。（本节 `:N` 均为**历史读数**，按当时快照记录，勿随行号位移更新。）

### 1.3 改成什么（逐字，见 §7.4／§7.3 全文）

- `:107` → `| E37 | 错误码单源：`ERROR_STATUS_MAP` 12 个状态、恰好 26 个错误码 | 已实现 | services/api/src/contract.ts:14-31 | 事实源是 packages/contracts/states.json:108；26 = 12 个状态档的码数之和（403 档 `SELF_SCOPE_GRANT_DENIED`、409 档 `LAST_SCOPE_MANAGER` 是 #646 新增）；`packages/contracts/` 下无源码文件 |`
- `:61` → `错误码单源 26 码`

判定未动：E37 仍是「已实现」，§1 的「契约单源 1 | 1 | 0 | 0 | 0」计数不变——本片只改数字与复算说明，不改档位、不改口径。

## 2 `后台无页面消费 GET /admin/audit-logs` 三处为假（任务第 2 条）

### 2.1 原文（逐字，三处）

`docs/architecture/ai-ops-spec-status.md:57`（改前，§1 计数矩阵「审计」行）：

```text
| 审计 | 6 | 3 | 2 | 1 | 0 | `job.cancel` 已登记进闭集、读面可筛（E40）；剩余是后台无入口（P10）与台账滞后（N02） |
```

`docs/architecture/ai-ops-spec-status.md:125`（改前，P10 判定行）：

```text
| P10 | 后台审计三读面权威分离（内存／开关库函数／全表库函数） | 部分实现 | services/api/src/admin/audit/service.ts:14-16 | 闭集那半条已随 #609 补齐（E40）；缺口改在**出口**：两个审计页分别只接内存读面（apps/admin/src/lib/audit-events.mjs:33）与只认 `set_flag` 的开关审计面（apps/admin/src/lib/flag-audit.mjs:54），全仓没有页面消费 `GET /admin/audit-logs` |
```

`docs/architecture/ai-ops-spec-status.md` §7.1（改前原文，原「仍没做到的两处」第 1 条；该项已随 #710 闭合，本节标题现为「仍没做到的一处」）：

```text
- 后台仍无入口：两个审计页分别只接内存读面（`apps/admin/src/lib/audit-events.mjs:33`）与只认 `set_flag` 的开关审计面（`apps/admin/src/lib/flag-audit.mjs:54`），全仓没有页面消费 `GET /admin/audit-logs`（P10）。
```

同一断言在同一页还有两处：`:110`（E40 缺口列末句「剩余边界：后台无页面消费该读面（P10）」）与 `:206`（「只剩「后台点不到」与「台账说没写」」）。`:110` 属在飞 PR #659 的改动面，**本片不动**（列入 §9）；`:206` 是同一假陈述的隐性出现，本片一并改（见 §7.11）。

### 2.2 反证（证据逐条）

1. 页面存在且只调这一个读面：`apps/admin/src/views/AuditLogsView.vue:5` 的文件头注释逐字「只调 `GET /admin/audit-logs`（operationId `listAuditLogs`，x-scope `audit:read`）：」；`:72` 逐字 `const result = await fetchAuditLogsPage({`，而 `fetchAuditLogsPage` 定义在 `apps/admin/src/lib/admin-audit-logs.mjs:374`，逐字 `export async function fetchAuditLogsPage({ fetchImpl, baseUrl, token, cursor = null, limit = LIMIT_DEFAULT, filters = null, signal } = {}) {`；该文件的读面常量在 `apps/admin/src/lib/admin-audit-logs.mjs:31` 逐字 `export const AUDIT_LOGS_PATH = '/admin/audit-logs';`。
2. 导航与渲染都在：`apps/admin/src/App.vue:33` 逐字 `{ key: 'auditLogs', label: '审计总台账（只读）', note: '读面已接入' },`；`apps/admin/src/App.vue:70` 逐字 `<AuditLogsView v-else-if="active === 'auditLogs'" />`。
3. 引入时间：该页面由提交 `04728c69`「Add read-only admin audit and administrator pages (#633)」引入，早于本页基线 `b1d02c21`，也在 `docs/architecture/admin-console-capability-map.md` 的基线 `68dec742` 上（该提交上 `AuditLogsView.vue:72`、`App.vue:33`、`App.vue:70` 与本页所引逐字相同，已用 `git show 68dec742:...` 抽行核对）。
4. 另外两个审计页确实只读窄面（这部分原文是真的）：`apps/admin/src/lib/audit-events.mjs:33` 逐字 `export const AUDIT_EVENTS_PATH = '/admin/audit-events';`；`apps/admin/src/lib/flag-audit.mjs:54` 逐字 `export const FLAG_AUDIT_PATH = '/admin/flag-audit-events';`。

### 2.3 为什么这三处是假的

三处都说「全仓没有页面消费 `GET /admin/audit-logs`」／「后台无入口」，而 `AuditLogsView.vue` 恰恰只消费这一个读面，且已挂进导航与会话校验后的渲染分支。这是「页面已存在但文档说没有」——正是本片要清除的那类失真。

### 2.4 改成什么（逐字，见 §7.2／§7.10／§7.11）

三处都改成真值表述，并按任务要求在每处保留一句「原写『…』为误，见 `docs/verification/gy-r67-docs-truth-20261027.md`」：

- `:57` → 记「审计总台账**已有页面**消费全表读面（`AuditLogsView.vue:72` 调 `listAuditLogs`，导航 `App.vue:33`、渲染 `App.vue:70`，#633）；剩余是三读面读数不合并（P10）与台账滞后（N02）」。
- `:125`（P10 缺口列）→ 记「出口侧：审计总台账页已消费全表读面…另两个审计页仍分别只接内存读面／只认 `set_flag` 的开关审计面 ⇒ 三读面读数不能合并、页面读数也无端到端验收，故仍判部分实现」。
- `:203` → 标题从「后台仍无入口」改成「三读面读数不合并」，并保留「页面读数也无端到端验收（P10）」。
- `:206` → 「只剩『后台点不到』」改成「只剩『三读面读数不合并』」。

### 2.5 仍为真的部分（这也是 P10 继续判「部分实现」的理由）

1. 审计端口只在 `real` + 有库池时构造：`services/api/src/app.ts:1501-1502`「`const realAuditLogPort =` / `adminInjection?.auditLogPort ?? (pool === null ? null : createPostgresAdminAuditLogPort({ pool }));`」，缺省装配仍 503（同文件 `:1688`）。
2. 三个读面的权威不同、读数无法合并：总台账页读全表库函数；`audit-events.mjs` 那条只读内存读面；`flag-audit.mjs` 那条只认 `set_flag` 子集。
3. 页面读数**没有端到端验收**：现有用例只在客户端形状与接口层——`tests/unit/admin-ui-audit-logs.test.mjs`（URL 形状与常量）、`tests/unit/admin-audit-logs.test.mjs`（接口层）、`tests/integration/admin-http.mjs:1044-1067`（缺省 503／注入端口 200）、`tests/integration/admin-audit-logs-pg.mjs`（真库读通道）；没有任何用例驱动 `AuditLogsView.vue` 打真库，也没有发布验收读数。
4. P10 的档位（部分实现）与 §1「审计 6 | 3 | 2 | 1 | 0」计数**未改**——本片只改假陈述。

## 3 `target_ref.revision` 恒取 1 为假（任务第 3 条）

### 3.1 原文（逐字）

`docs/architecture/ai-ops-spec-status.md:126`（改前，P11 缺口列）：

```text
`target_ref.revision` 恒取 1、`result` 恒 `null`——形状对、语义未真实化
```

`docs/architecture/ai-ops-spec-status.md` §7.2（改前原文，原「真正没做到的」第 1 条；该项现已改写为「投影语义只真实化一半」）：

```text
- 投影语义未真实化：`target_ref.revision` 恒取 1、`result` 恒 `null`（`services/api/src/admin/ops/jobs-pg.ts:17-22`），即前端看到的「修订号／结果」不是真值（P11）。
```

### 3.2 为什么是假的（证据）

1. 取的是记录行真实版本列：`services/api/src/admin/ops/jobs-pg.ts:413` 逐字 `revision: targetRevision ?? UNCREATED_RECORD_REVISION,`，其中 `targetRevision` 来自 SQL 投影 `r.revision`（同文件 `:18-19` 的头注释逐字「`revision` 取记录行的**真实版本列**（SQL 里 `r.revision`，投影成 `target_revision`）」）；该实现随 #608（提交 `e9c4de8c`）落地。
2. 退回 1 只发生在「记录尚未创建」这一合法分支：`services/api/src/admin/ops/jobs-pg.ts:23-28` 逐字「记录**尚未创建**时退回 `1`：记录行只由终态事务那一笔写入…初始 `revision` 恒为 1。这与三域自己的读面**同一口径**…不是"随便占位"」；`:400-405` 对非法值一律 503，不折算、也不夹到 1。
3. `result` 恒 `null` 是**契约形状**，不是实现偷懒：`packages/contracts/openapi.json:15993-15995` 逐字 `"result": {` / `"type": "null"` / `},`；实现侧 `services/api/src/admin/ops/jobs-pg.ts:419` 逐字 `result: null,`。
4. 两条时钟不同（说明为什么不能拿作业 revision 顶替）：同文件 `:18-22` 与 `:408`（`revision: row.revision,`）——作业行自己的 `revision` 是状态迁移计数（取消一次 1→2），`target_ref.revision` 是目标记录版本；真库臂 `tests/integration/admin-jobs-pg.mjs:1351-1361` 断言记录版本 5 与作业 revision 2 必须不同。

### 3.3 改成什么（逐字，见 §7.9／§7.14）

- `:126` → 「`target_ref.revision` **自 #608 起已取记录行真实 revision**（`jobs-pg.ts:413`…；记录尚未创建时才退回 1，见同文件 :23-28）；`result` 恒 `null` 是契约形状、作业结果在后台读面仍读不到——形状对、语义只真实化一半。原写「`target_ref.revision` 恒取 1」为误…」
- `:220` → 「投影语义只真实化一半：`target_ref.revision` 自 #608 起取记录行真实 revision（`jobs-pg.ts:413`），只有记录尚未创建时才退回 1；`result` 恒 `null`（同文件 :419）是契约形状…」

**档位不变**：P11 仍是「部分实现」，因为投影的另一半（`result`）仍恒 `null`、后台读面仍看不到作业结果；升档需要同时改 §0/§1 全套计数与 E/P 编号，超出本片（且属 PR #659 的改动面）。

## 4 `app.ts` 锚点漂移（任务第 4 条）

### 4.1 漂移表（文本命中，逐条已打印命中行确认逐字对上）

| 引用处 | 改前（旧行号） | 改后（实测行号） | 命中行（逐字） |
| --- | --- | --- | --- |
| `ai-ops-spec-status.md:22` `:108` `:212` | `services/api/src/app.ts:1291` | `services/api/src/app.ts:1341` | `const adminRealUnwired = config.executionMode === 'real';`（全文件唯一） |
| `ai-ops-spec-status.md:22` `:108` `:213` | `:1313-1315` | `:1363-1365` | `const adminJobPort =` / `adminInjection?.jobPort ??` / `(adminRealUnwired && pool !== null ? createPostgresAdminJobPort({ pool }) : undefined);`（唯一） |
| `ai-ops-spec-status.md:100` | `:1316-1330` | `:1366-1380` | `:1366` `// **武装的前置条件（T-R12-08R）**：`real` + 有池 + **表确认可用**，三者缺一不可。` → `:1377` `const flagArmingProbe =` → `:1380` `: undefined;` |
| `ai-ops-spec-status.md:213` | `同文件 :1476` | `同文件 :1549` | `jobPort: adminJobPort,`（唯一） |
| `ai-ops-spec-status.md:73`（E03） | `:2285-2320` | `:2433-2472` | `:2433` `registerJobRoutes(app, config, guards, createJobRegistry([` → `:2472` `]));`，六源在 `:2434`／`:2440`／`:2443`／`:2449`／`:2457`／`:2465` |

### 4.2 为什么按文本重定位而不是「按新增行数位移」

`app.ts` 在 #600（引入本页的提交 `c296f6f3`）之后插了内容，且**两段漂移量不同**：首段是 +50（`1291→1341`、`1313-1315→1363-1365`、`1316-1330→1366-1380`），作业注册段是 +148（`2285→2433`）。用「本片新增行数」或「统一 +N」位移都会算错，所以每一处都先用 `Select-String -Encoding utf8` 找片段、打印命中行确认逐字对上、且确认全文件唯一，再改行号（命中不唯一的一律不改——本片没有不唯一的）。

### 4.3 上游给的数字里有一处是错的（`2285-2320 → 2429-2455`）

任务单写 E03 的新锚点是 `2429-2455`，与文本不符：

- `services/api/src/app.ts:2429` 是注释行，逐字 `// 各域以作业源形式接入，**共 6 个**（识别 + 转写 + 审核 + 合成 + OCR + 文字问答，即下面`；
- `services/api/src/app.ts:2455` 落在第 5 个源（`createOcrJobSource`）的注释中间，不是块的收尾。

按文本重定位，E03 的语义单位是「`registerJobRoutes` 的注册块」，起于 `:2433`、止于 `:2472` 的 `]));`（`:2429-2432` 是四行注释）。另外旧区间 `2285-2320` 本身就截在第 6 个源（`createAnswerJobSource`）中间（旧文件 `:2317` 起是第 6 个源、`:2322` 才收尾），所以改后取整块而不是「旧终点 +148」的 `:2468`。**本片改的是 `2433-2472`，不是 `2429-2455`。**

### 4.4 逐行改动

见 §7.1／§7.5／§7.6／§7.7／§7.8／§7.12／§7.13。

## 5 `admin-console-capability-map.md:214` 的口径统一（任务第 5 条）

### 5.1 原文（逐字，改前）

```text
「审计总台账」与「管理员权限读面」已落地（页面见 §4 更正记录），不再需要补入口。遗留的只是**装配风险**而非 UI 缺口：`listAuditLogs` 在 `real` + 有库池时只读端口已构造（`services/api/src/app.ts:1485-1493`），只有缺省装配（stub / real 无池）才 503——运维侧确认运行模式即可。
```

### 5.2 这一行本身不是假话——矛盾在 ai-ops 页

这一行**本来就写着审计总台账已落地**（还给了页面与锚点），与任务单说的「自相矛盾」相反：矛盾来自 `docs/architecture/ai-ops-spec-status.md` 的 P10 说「全仓没有页面消费」。本页 §4 的更正记录也已逐字给出 `listAuditLogs` → `fetchAuditLogsPage`（`apps/admin/src/lib/admin-audit-logs.mjs:374`）→ `AuditLogsView.vue:72`、tab 装配 `App.vue:33`、渲染 `App.vue:70`。

另外它的 `services/api/src/app.ts:1485-1493` 等锚点在**当前 HEAD 上是漂移的**，但该页第 3 行明确声明「本页所有「文件:行号」都以 `68dec742` 为准」，这些锚点在 `68dec742` 上逐行对得上——属「基线相对锚点」，不是假陈述，**本片不改它的行号**（改了反而破坏它自己的口径）。

### 5.3 改成什么（逐字，见 §7.15）

在该行末尾追加一句「R67-A 口径对齐（2026-10-27）」，写明：审计总台账确有页面消费该读面（`AuditLogsView.vue:72` 调 `listAuditLogs`、导航 `App.vue:33`、渲染 `App.vue:70`，#633），并指回 `docs/architecture/ai-ops-spec-status.md` 的 P10 已按本页口径改成真值（三读面读数不合并、页面读数无端到端验收），逐条证据见本页。原句与它自己的基线锚点一字未动。

## 6 对上游审查结论的纠正（三条）

### 6.1 真库臂**不是**「以『改动前恒 1』锁着相反事实」，也不是待办

上游结论说 `tests/integration/admin-jobs-pg.mjs:1352-1354` 用「改动前恒 1」钉住旧口径、要另记待办。实读不是：该用例已经钉住**真值 5**，逐字如下（`tests/integration/admin-jobs-pg.mjs:1349-1361`）：

```text
  const succeeded = items.find((item) => item.id === seeded.succeeded);
  assert.ok(succeeded !== undefined, '有记录的 succeeded 作业必须出现在列表里');
  assert.deepEqual(
    succeeded.target_ref,
    { type: 'ocr', id: recordId, revision: 5 },
    'target_ref.revision 必须等于记录行的真实 revision（改动前恒 1 ⇒ 真红）',
  );
  assert.equal(succeeded.revision, 2, 'AdminJob.revision 仍是作业行自己的状态迁移计数（2）');
  assert.equal(
    succeeded.target_ref.revision === succeeded.revision,
    false,
    '两条时钟必须不同：记录版本 5 ≠ 作业 revision 2',
  );
```

断言说明里的「改动前恒 1 ⇒ 真红」是**历史叙述**（含义：改前恒 1，所以改后若仍为 1 就真红），不是断言里的期望值；期望值就是 `revision: 5`。同一臂 `:1363-1370` 还钉住「记录尚未创建 ⇒ 退回 1」（`assert.equal(queuedItem.target_ref.revision, 1, '记录尚未创建 ⇒ 记录行的初始版本 1（不是 0/null）')`）。⇒ **这条不是待办，是上游前提错误**，代码/测试无需任何改动。

### 6.2 E03 的锚点数字错了（见 §4.3）

上游给的 `2285-2320 → 2429-2455` 不行：`2429` 是注释行、`2455` 落在第 5 个源的注释中间。已按文本重定位为 `2433-2472`。

### 6.3 「`docs/verification/` 下有几处 `app.ts` 旧行号」定位错了

本片实测：`docs/verification/` 下没有引用 `services/api/src/app.ts` 旧行号的条目；上游描述的那些数字（`1291`、`1313-1315`、`1476`、`2285-2320`）全部在 `docs/architecture/ai-ops-spec-status.md`（`:22`／`:73`／`:100`／`:108`／`:212`／`:213`）。另有 `docs/architecture/contract-implementation-status.md` 里也有成批的 `app.ts` 旧行号，但那是另一份台账页、不在本片 5 条之内（见 §9）。

## 7 逐行改动（15 行，原文与新文均逐字摘录）

改动前后行号相同（全部单行原地替换），行号按改后文件计。

### 7.1 `docs/architecture/ai-ops-spec-status.md:22`

- 原文（逐字）：

```text
| 原 N03 | 未实现（作业台端口未接线） | 撤条 → 并入 E38 | `services/api/src/app.ts:1291` 的 `adminRealUnwired` 值只等于「real 模式」，`:1313-1315` 在 real + 有池时即构造生产端口 |
```

- 新文（逐字）：

```text
| 原 N03 | 未实现（作业台端口未接线） | 撤条 → 并入 E38 | `services/api/src/app.ts:1341` 的 `adminRealUnwired` 值只等于「real 模式」，`:1363-1365` 在 real + 有池时即构造生产端口 |
```

- 依据：§4.1 两行；`services/api/src/app.ts:1341` 与 `:1363-1365` 逐字命中且唯一。

### 7.2 `docs/architecture/ai-ops-spec-status.md:57`（任务第 2 条）

- 原文（逐字）：

```text
| 审计 | 6 | 3 | 2 | 1 | 0 | `job.cancel` 已登记进闭集、读面可筛（E40）；剩余是后台无入口（P10）与台账滞后（N02） |
```

- 新文（逐字）：

```text
| 审计 | 6 | 3 | 2 | 1 | 0 | `job.cancel` 已登记进闭集、读面可筛（E40）；审计总台账**已有页面**消费全表读面（`apps/admin/src/views/AuditLogsView.vue:72` 调 `listAuditLogs`，导航 `apps/admin/src/App.vue:33`、渲染 `apps/admin/src/App.vue:70`，#633）；剩余是三读面读数不合并（P10）与台账滞后（N02）。原写「后台无入口」为误，见 `docs/verification/gy-r67-docs-truth-20261027.md` |
```

- 依据：§2.2；计数列（6|3|2|1|0）未动。

### 7.3 `docs/architecture/ai-ops-spec-status.md:61`（任务第 1 条，同页第二处）

- 原文（逐字）：`| 契约单源 | 1 | 1 | 0 | 0 | 0 | 错误码单源 24 码，改动必须过 `states.json` |`
- 新文（逐字）：`| 契约单源 | 1 | 1 | 0 | 0 | 0 | 错误码单源 26 码，改动必须过 `states.json` |`
- 依据：§1.2 的 26 码复算输出。

### 7.4 `docs/architecture/ai-ops-spec-status.md:107`（任务第 1 条）

- 原文（逐字）：见 §1.1 第一条。
- 新文（逐字）：

```text
| E37 | 错误码单源：`ERROR_STATUS_MAP` 12 个状态、恰好 26 个错误码 | 已实现 | services/api/src/contract.ts:14-31 | 事实源是 packages/contracts/states.json:108；26 = 12 个状态档的码数之和（403 档 `SELF_SCOPE_GRANT_DENIED`、409 档 `LAST_SCOPE_MANAGER` 是 #646 新增）；`packages/contracts/` 下无源码文件 |
```

- 依据：§1.2；`packages/contracts/states.json:108` 逐字 `"error_status_map": {`。

### 7.5 `docs/architecture/ai-ops-spec-status.md:73`（E03，任务第 4 条）

- 原文（逐字）：

```text
| E03 | 六个 kind 全部注册作业源（识别／OCR／转写／问答／合成／审核） | 已实现 | services/api/src/app.ts:2285-2320 | 「注册」不等于「有能力」：取消能力另按域判定（P01） |
```

- 新文（逐字）：

```text
| E03 | 六个 kind 全部注册作业源（识别／OCR／转写／问答／合成／审核） | 已实现 | services/api/src/app.ts:2433-2472 | 「注册」不等于「有能力」：取消能力另按域判定（P01） |
```

- 依据：§4.3；`services/api/src/app.ts:2433` `registerJobRoutes(app, config, guards, createJobRegistry([`、`:2472` `]));`、六源 `:2434`／`:2440`／`:2443`／`:2449`／`:2457`／`:2465`。

### 7.6 `docs/architecture/ai-ops-spec-status.md:100`（E30）

- 原文（逐字，仅末句）：`探测装配见 services/api/src/app.ts:1316-1330`
- 新文（逐字，仅末句）：`探测装配见 services/api/src/app.ts:1366-1380`
- 依据：§4.1 第 3 行（注释 `:1366` → 表达式 `:1377` → `:1380` 收尾）。

### 7.7 `docs/architecture/ai-ops-spec-status.md:108`（E38）

- 原文（逐字）：见 §4.1（`services/api/src/app.ts:1313-1315` 与「同文件 :1291」）。
- 新文（逐字）：

```text
| E38 | 后台作业台**真库端口**的产品装配：real + 有池 ⇒ `createPostgresAdminJobPort` | 已实现 | services/api/src/app.ts:1363-1365 | `adminRealUnwired` 只是「real 模式」的别名（同文件 :1341）；生产端口的 `persistent: true` 见 services/api/src/admin/ops/jobs-pg.ts:450-451 |
```

- 依据：§4.1 前两行。

### 7.8 `docs/architecture/ai-ops-spec-status.md:125`（P10，任务第 2 条）

- 原文（逐字）：见 §2.1 第二条。
- 新文（逐字）：

```text
| P10 | 后台审计三读面权威分离（内存／开关库函数／全表库函数） | 部分实现 | services/api/src/admin/audit/service.ts:14-16 | 闭集那半条已随 #609 补齐（E40）；出口侧：审计总台账页已消费全表读面（`apps/admin/src/views/AuditLogsView.vue:72` 调 `listAuditLogs`，导航 `apps/admin/src/App.vue:33`、渲染 `apps/admin/src/App.vue:70`，#633），另两个审计页仍分别只接内存读面（apps/admin/src/lib/audit-events.mjs:33）与只认 `set_flag` 的开关审计面（apps/admin/src/lib/flag-audit.mjs:54）⇒ 三读面读数不能合并、页面读数也无端到端验收，故仍判部分实现。原写「全仓没有页面消费 `GET /admin/audit-logs`」为误，见 `docs/verification/gy-r67-docs-truth-20261027.md` |
```

- 依据：§2.2、§2.5；档位「部分实现」未动。

### 7.9 `docs/architecture/ai-ops-spec-status.md:126`（P11，任务第 3 条）

- 原文（逐字）：见 §3.1 第一条。
- 新文（逐字）：

```text
| P11 | 作业台作业投影按契约形状输出 | 部分实现 | services/api/src/admin/ops/jobs-pg.ts:17-22 | `target_ref.revision` **自 #608 起已取记录行真实 revision**（`services/api/src/admin/ops/jobs-pg.ts:413` 的 `targetRevision ?? UNCREATED_RECORD_REVISION`，SQL 投影 `r.revision`；记录尚未创建时才退回 1，见同文件 :23-28）；`result` 恒 `null` 是契约形状、作业结果在后台读面仍读不到——形状对、语义只真实化一半。原写「`target_ref.revision` 恒取 1」为误，见 `docs/verification/gy-r67-docs-truth-20261027.md` |
```

- 依据：§3.2；档位「部分实现」未动（理由见 §3.3 末段）。

### 7.10 `docs/architecture/ai-ops-spec-status.md` §7.1（任务第 2 条；改前引的是该页第 203 行，N02 销号后那两行已删）

- 原文（逐字）：见 §2.1 第三条。
- 新文（逐字）：

```text
- 三读面读数不合并：审计总台账页已消费全表读面（`apps/admin/src/views/AuditLogsView.vue:72` 调 `listAuditLogs`），另两个审计页仍分别只接内存读面（`apps/admin/src/lib/audit-events.mjs:33`）与只认 `set_flag` 的开关审计面（`apps/admin/src/lib/flag-audit.mjs:54`），三面读数无法合并、页面读数也无端到端验收（P10）。原写「后台仍无入口…全仓没有页面消费 `GET /admin/audit-logs`」为误，见 `docs/verification/gy-r67-docs-truth-20261027.md`。
```

- 依据：§2.2、§2.5。

### 7.11 `docs/architecture/ai-ops-spec-status.md:206`（§7.1「留档的理由」，同一假陈述的隐性出现）

- 原文（逐字）：

```text
**留档的理由**：这条曾经是「写进去了，但没人读得到，且文档说它没写」。现在库里有行、接口能筛、用例锁住，只剩「后台点不到」与「台账说没写」——同一类漂移换了个面，别当它消失了。
```

- 新文（逐字，仅改引号内两项）：

```text
**留档的理由**：这条曾经是「写进去了，但没人读得到，且文档说它没写」。现在库里有行、接口能筛、用例锁住，只剩「三读面读数不合并」与「台账说没写」——同一类漂移换了个面，别当它消失了。
```

- 依据：§2.2；与 `:57`／`:125`／`:203` 同一断言，不改会与本片改后的三处直接打架。段落结构与「留档的理由」的论证未动。

### 7.12 `docs/architecture/ai-ops-spec-status.md:212`（§7.2）

- 原文（逐字）：`- 判定变量名骗人但不骗逻辑：`const adminRealUnwired = config.executionMode === 'real'`（`services/api/src/app.ts:1291`），值只取决于是否 real。`
- 新文（逐字）：同上，仅 `:1291` → `:1341`。
- 依据：§4.1 第 1 行。

### 7.13 `docs/architecture/ai-ops-spec-status.md:213`（§7.2）

- 原文（逐字）：`- 装配：`adminJobPort = adminInjection?.jobPort ?? (adminRealUnwired && pool !== null ? createPostgresAdminJobPort({ pool }) : undefined)`（同文件 :1313-1315），显式注入优先；随后注入服务层（同文件 :1476）。`
- 新文（逐字）：同上，仅 `:1313-1315` → `:1363-1365`、`:1476` → `:1549`（这两个数字是 A1 当时树上成立的读数）。
- 依据：§4.1 第 2、4 行。R68 合流（#652／R68 一并落在同一条装配链上）后同一块下移：`adminJobPort` 的定义在 `services/api/src/app.ts:1375`（`:1375-1377` 三行），真库域的注入点在 `services/api/src/app.ts:1572`（stub 域另有一处同名注入在 `:1703`，两者不是同一块）。

### 7.14 `docs/architecture/ai-ops-spec-status.md` §7.2（任务第 3 条；改前引的是该页第 220 行，该条现已改写为「投影语义只真实化一半」）

- 原文（逐字）：见 §3.1 第二条。
- 新文（逐字）：

```text
- 投影语义只真实化一半：`target_ref.revision` 自 #608 起取记录行真实 revision（`services/api/src/admin/ops/jobs-pg.ts:413`），只有记录尚未创建时才退回 1；`result` 恒 `null`（同文件 :419）是契约形状，即前端看到的「结果」仍不是真值（P11）。
```

- 依据：§3.2；`services/api/src/admin/ops/jobs-pg.ts:419` 逐字 `result: null,`。

### 7.15 `docs/architecture/admin-console-capability-map.md:214`（任务第 5 条，行尾追加）

- 原文（逐字）：见 §5.1。
- 新文（逐字）：

```text
「审计总台账」与「管理员权限读面」已落地（页面见 §4 更正记录），不再需要补入口。遗留的只是**装配风险**而非 UI 缺口：`listAuditLogs` 在 `real` + 有库池时只读端口已构造（`services/api/src/app.ts:1485-1493`），只有缺省装配（stub / real 无池）才 503——运维侧确认运行模式即可。**R67-A 口径对齐（2026-10-27）**：审计总台账确有页面消费该读面——`apps/admin/src/views/AuditLogsView.vue:72` 调 `listAuditLogs`（`GET /admin/audit-logs`），导航 `apps/admin/src/App.vue:33`、渲染 `apps/admin/src/App.vue:70`（#633，见 §4 更正记录）；`docs/architecture/ai-ops-spec-status.md` 的 P10 原写「全仓没有页面消费 `GET /admin/audit-logs`」为误，已按本页口径改成真值（三读面读数不合并、页面读数无端到端验收），逐条证据见 `docs/verification/gy-r67-docs-truth-20261027.md`。
```

- 依据：§5.2、§5.3。

## 8 未取得

1. **没有在真浏览器 + 真库上跑过 `apps/admin` 页面**：本片无前端运行环境、无 PG17 实例，所以「审计总台账页已消费该读面」只到代码层与客户端用例层（`tests/unit/admin-ui-audit-logs.test.mjs` 只验 URL 形状），**端到端读数未取得**——这也是 P10 改写后仍保留「页面读数无端到端验收」的依据。
2. **没有重跑真库臂**（`tests/integration/admin-jobs-pg.mjs` 需 `postgres:17.11`）：`target_ref.revision` 取真值只到代码 + 既有用例文本层，本机未执行。
3. **工具无法证明语义**：`verify-doc-anchors --strict` 只能证明「行号存在、不在基线外新增」，不能证明「行号语义对」；本次 6 处 `app.ts` 旧行号在基线里既不红也不在 13 条基线条目内，故本片用文本重定位人工核对（§4）。`verify-contract-status` 自己也声明「脚本不证明语义正确、真实能力或整项验收」。
4. **未做 `docs/architecture/contract-implementation-status.md` 的锚点全量复核**（见 §9 第 4 条）。

## 9 本片不改、但已知为假或不精确的清单

1. `docs/architecture/ai-ops-spec-status.md:110`（E40 缺口列末句）「剩余边界：后台无页面消费该读面（P10）」——与 §2 同一假陈述，**禁改**（在飞 PR #659 的改动面）。另片应改为「三读面读数不合并、页面读数无端到端验收」。
2. `docs/architecture/ai-ops-spec-status.md:58`「投影语义未真实化（P11）」——现在只一半真（`result` 仍 `null`），不精确但在本片授权行之外，未改。
3. `docs/architecture/ai-ops-spec-status.md:271`（§9 失效触发清单）末项「真库端口投影改成真值（P11）」——把 P11 整条当未来触发，实际已发生一半（revision 已真、`result` 未真）；属宽表述，未改。
4. `docs/architecture/contract-implementation-status.md` 里成批的 `services/api/src/app.ts` 旧行号（该页 :19／:36／:39／:42／:43／:68／:73／:87-91／:126-128 一带）——另一份台账页，本片未逐条复核、未改。
5. `docs/verification/gy-i28-unified-states-20261021.md:44`「契约错误码全表（**24 码** + 2 个客户端自造码）」——该表滞后（契约已 26 码，缺 `SELF_SCOPE_GRANT_DENIED`／`LAST_SCOPE_MANAGER`）；同页 `:42`「覆盖率由测试对着该文件逐码核对：**漏一个码就红**」需要另片复核（`miniprogram/utils/states.js` 对这两个新码 0 命中，`miniprogram/**` 不在本片范围）。
6. `services/api/src/admin/ops/jobs-pg.ts:30` 的代码注释引了 `fields.ts:101` 作为 `AdminJob.result` 的依据，但 `packages/contracts/fields.ts` 不存在（实测 0 行）；正确锚点是 `packages/contracts/openapi.json:15993-15995`。属源码注释、本片不改，供后续片修正。
7. `docs/verification/gy-i14-community-chain-20261021.md:70`、`docs/verification/gy-r31-i26-recon-20261022.md:128` 的「没有页面消费者」说的是举报状态入口与 `/public/home` 预览，与审计无关，无动作。

## 10 复算命令清单（可重跑）

```text
# 26 码复算（状态档 + 总和）
$j = Get-Content -Raw -Encoding utf8 packages\contracts\states.json | ConvertFrom-Json
$j.error_status_map.PSObject.Properties | ForEach-Object { "$($_.Name): $($_.Value.Count)" }

# app.ts 锚点（每条都应唯一命中）
Select-String -Encoding utf8 -Path services\api\src\app.ts -Pattern "adminRealUnwired = config.executionMode"
Select-String -Encoding utf8 -Path services\api\src\app.ts -Pattern "createPostgresAdminJobPort\(\{ pool \}\)"
Select-String -Encoding utf8 -Path services\api\src\app.ts -Pattern "jobPort: adminJobPort,"
Select-String -Encoding utf8 -Path services\api\src\app.ts -Pattern "registerJobRoutes\(app, config, guards"

# 审计页反证
Select-String -Encoding utf8 -Path apps\admin\src\views\AuditLogsView.vue -Pattern "fetchAuditLogsPage\("
Select-String -Encoding utf8 -Path apps\admin\src\App.vue -Pattern "auditLogs"

# revision 真值
Select-String -Encoding utf8 -Path services\api\src\admin\ops\jobs-pg.ts -Pattern "targetRevision \?\? UNCREATED_RECORD_REVISION"

# 门禁
node tools/verify-doc-anchors.mjs --strict --scan docs
node tools/verify-contract-status.mjs
python tools/validate_development_docs.py
```
