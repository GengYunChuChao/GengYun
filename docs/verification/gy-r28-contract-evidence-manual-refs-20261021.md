# 契约台账 28 条人工 evidence 引用裁定（R28-S41，2026-10-21）

2026-10-21（UTC+8），分支 `docs/gy-r28-contract-evidence-manual-refs`，基点 `upstream/main = 32ce461`（台账自述 baseline `72c4923a8ec058399a51609e1cf1e3c70a890b4a`）。本页逐条裁定 S30 交接报告「需人工清单（28 条，全部未改）」中的 evidence 引用：能在 HEAD 定位的重新锚定 `lines`，定位不到的如实留原值并登记。**只改 `lines` 值，不改条目、状态、缺口描述、键序与缩进**。本页是位置证据，不证明契约语义正确、真实能力或整项验收，也不替代监工复核。

- 提交作者：`dsh-r28-writer <dsh-r28-writer@local>`。
- 改动文件：`docs/architecture/contract-status.json`（27 处 `lines` 字符串）、由其机械派生的 `docs/architecture/contract-implementation-status.md`（`node tools/verify-contract-status.mjs --write-doc` 重生成，未手改）、本页。
- 28 条全部处理，未减条目、未抽样；条目顺序、`path`/`status`/`test`/`notes`/`blocker`/`title` 一字未动。

## 1. 输入与判定口径

**权威清单**：S30 报告 `E:\GengYunCommander\.pg17\handoff\r28-s30-report.md` 的「需人工清单（28 条，全部未改）」。S30 判据分布：`gone` 20 条（基线原文在当前文件唯一命中 0）、`base-missing` 5 条（#8–#12 的文件在基线尚不存在）、`base-blank-snippet` 2 条（#4、#28 的旧区间在基线越界）、「区间首行 `});` 无唯一锚点」1 条（#27）。合计 28。

**S30 判据为何不够用**：S30 的订正判据是「基线区间原文在当前文件精确检索、唯一命中才改」。这 28 条正是该判据零命中的剩余项——基线原文被后续实现改动重排过（函数增长、文档块替换），逐字匹配已不可能。本片改用**实现块重锚**，并以可核符号断言约束：

1. 取台账 `baseline` 提交里该区间的原文，判定它当时指向哪段实现（函数声明、方法体、文档头或错误区），据此确定「应指向哪个代码符号」。
2. 在 HEAD 找到该符号的声明行与该块的收尾行（`}` / `};` / `},` / `});`），新区间 = 声明行..收尾行。
3. 每条新区间必须同时满足五项断言：① 文件存在；② `1 ≤ from ≤ to ≤ 文件行数`；③ 起点行包含锚点符号名；④ 区间内该符号至少出现一次；⑤ 区间内至少有一行实质内容（非空白、非纯收尾符）。另外排除「区间等于整个文件」（`from===1 && to≥行数-1`）。任一项不满足即不改，并登记「已死/存疑」。
4. 断言由脚本执行（`plan.mjs check`），逐条输出起点行、终点行与锚点命中数；本页表格即该输出。

**「条目名」与「代码符号」不是同一个东西**（这是本片最容易被误读的一点）：台账 evidence 的条目名是 operation id / dimension key，基线证据自身就不保证该名在目标文件里字面出现——例如基线 `loginWechat` 的证据指向 `createWechatIdentityProvider` 整体、`execution_modes` 指向 `loadConfig` 整体、`grantConsent` 指向 `persistConsentGrant` 整体、`getPublicHome` 指向 `readHomePreviews` 整体、`listKnowledge` 指向 `paginateKnowledge` 函数体。因此断言用**锚点代码符号**（表中「锚点（文件内命中）」列），并把「表内条目名是否在区间内」作为附加事实列出（§3.2），不静默放宽成「同名才算」——否则这 28 条里会有 7 条被误判为死引用。

## 2. 28 条逐条裁定

| # | 条目 | 文件 | 旧 lines | 新 lines | 判定 | 锚点（文件内命中数） | 新起点行（节选） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `listAdminUsers`（op） | `services/api/src/admin/ops/service.ts` | 315-320 | 400-411 | A 重锚 | `listAdminUsers`（10） | `async function listAdminUsers(ctx: AdminCallCo…` |
| 2 | `listFlags`（op） | `services/api/src/admin/ops/service.ts` | 496-501 | 707-711 | A 重锚 | `listFlags`（8） | `async function listFlags(ctx: AdminCallContext…` |
| 3 | `idempotency`（dim） | `services/api/src/app.ts` | 349-358 | 828-834 | B 重锚（存疑） | `idempotency`（14） | `idempotency: idempotencyStore,` |
| 4 | `requestAccountDeletion`（op） | `services/api/src/app.ts` | 1722-1729 | —（不变） | C 原位有效 | `registerAccountDeletionRoutes`（2） | （原值已正确） |
| 5 | `loginWechat`（op） | `services/api/src/auth/wechat.ts` | 66-131 | 66-132 | A 重锚 | `createWechatIdentityProvider`（1） | `export function createWechatIdentityProvider(o…` |
| 6 | `execution_modes`（dim） | `services/api/src/config.ts` | 126-238 | 155-283 | A 重锚 | `loadConfig`（1） | `export function loadConfig(env: Env = process.…` |
| 7 | `getPublicHome`（op） | `services/api/src/db/catalog.ts` | 14-27 | 14-32 | A 重锚 | `readHomePreviews`（2） | `export async function readHomePreviews(pool: P…` |
| 8 | `listFavorites`（op） | `services/api/src/favorites/service.ts` | 214-258 | 305-347 | A 重锚 | `listFavorites`（4） | `/** listFavorites：GET /favorites。只列本人收藏；(…` |
| 9 | `createFavorite`（op） | `services/api/src/favorites/service.ts` | 262-330 | 359-415 | A 重锚 | `createFavorite`（5） | `async createFavorite(actor: unknown, body: unk…` |
| 10 | `deleteFavorite`（op） | `services/api/src/favorites/service.ts` | 332-380 | 426-466 | A 重锚 | `deleteFavorite`（4） | `async deleteFavorite(actor: unknown, id: unkno…` |
| 11 | `listHistory`（op） | `services/api/src/history/service.ts` | 238-292 | 318-358 | A 重锚 | `listHistory`（4） | `/** listHistory：GET /history。只列本人历史；(crea…` |
| 12 | `deleteHistory`（op） | `services/api/src/history/service.ts` | 294-340 | 369-404 | A 重锚 | `deleteHistory`（6） | `async deleteHistory(actor: unknown, id: unknow…` |
| 13 | `cancel`（dim） | `services/api/src/jobs/registry.ts` | 283-308 | 283-309 | A 重锚 | `async cancel(input)`（1） | `async cancel(input) {` |
| 14 | `listKnowledge`（op） | `services/api/src/knowledge/pagination.ts` | 24-65 | 30-72 | A 重锚 | `paginateKnowledge`（1） | `export function paginateKnowledge<T extends { …` |
| 15 | `pagination`（dim） | `services/api/src/knowledge/pagination.ts` | 24-65 | 30-72 | A 重锚 | `paginateKnowledge`（1） | `export function paginateKnowledge<T extends { …` |
| 16 | `listKnowledge`（op） | `services/api/src/knowledge/service.ts` | 14-56 | 56-123 | A 重锚 | `createKnowledgeService`（1） | `export function createKnowledgeService(pool: P…` |
| 17 | `getKnowledge`（op） | `services/api/src/knowledge/service.ts` | 43-56 | 57-121 | A 重锚 | `async function read(`（1） | `async function read(input: Identity, query: Kn…` |
| 18 | `source_kind`（dim） | `services/api/src/knowledge/service.ts` | 43-47 | 102-104 | B 重锚（存疑） | `source_kind`（1） | `publisher: row.publisher,source_kind: row.sour…` |
| 19 | `createUpload`（op） | `services/api/src/media/service.ts` | 1-40 | 807-874 | B 重锚（存疑） | `initiateUpload`（7） | `const initiateUploadUnclaimed: AppMediaService…` |
| 20 | `completeUpload`（op） | `services/api/src/media/service.ts` | 1-40 | 876-953 | A 重锚 | `completeUpload`（11） | `const completeUploadUnclaimed: AppMediaService…` |
| 21 | `getMedia`（op） | `services/api/src/media/service.ts` | 1-40 | 975-978 | A 重锚 | `getMedia`（6） | `const getMedia: AppMediaService['getMedia'] = …` |
| 22 | `deleteMedia`（op） | `services/api/src/media/service.ts` | 1-40 | 980-1009 | A 重锚 | `deleteMedia`（10） | `const deleteMediaUnclaimed: AppMediaService['d…` |
| 23 | `grantMediaAccess`（op） | `services/api/src/media/service.ts` | 1-40 | 1021-1052 | A 重锚 | `grantMediaAccess`（6） | `const grantMediaAccess: AppMediaService['grant…` |
| 24 | `grantCommunityMediaAccess`（op） | `services/api/src/media/service.ts` | 1-40 | 1056-1174 | A 重锚 | `grantCommunityMediaAccess`（5） | `const grantCommunityMediaAccess: AppMediaServi…` |
| 25 | `readCommunityMediaContent`（op） | `services/api/src/media/service.ts` | 1-40 | 1176-1222 | A 重锚 | `readCommunityMediaContent`（5） | `const readCommunityMediaContent: AppMediaServi…` |
| 26 | `grantConsent`（op） | `services/api/src/privacy/grant-pg.ts` | 26-97 | 32-113 | A 重锚 | `persistConsentGrant`（1） | `export async function persistConsentGrant(clie…` |
| 27 | `timeout`（dim） | `services/api/src/recognitions/service.ts` | 525-543 | 525-544 | A 重锚 | `runProviderWithDeadline`（2） | `async function runProviderWithDeadline(job: Jo…` |
| 28 | `cancel`（dim） | `services/api/src/recognitions/service.ts` | 756-796 | 757-797 | A 重锚 | `cancelJob`（3） | `async function cancelJob(input: {` |

统计：**改 27 条**（A 重锚 24、B 重锚但原意存疑 3）、**原位有效不改 1 条**（#4）、**死引用 0 条**、**存疑 3 条**（B 组）。断言通过 28/28（失败 0 条）。

A/B 的分界：A = 基线片段的**首行本身就是该函数的声明**（或首行即该块的第一行实质代码），符号与区间一一对应，不存在第二种合理读法；B = 基线片段与本次选取的实现块之间的对应关系需要一次语义推断（旧区间指向的是无关代码或模块文档头），区间内符号可核，但「作者原意」不能证明。

## 3. 已死引用与存疑项

### 3.1 已死引用：0 条

28 条里没有一条的文件或符号在 HEAD 消失，因此**死引用 0 条**、没有需要「保留原值并登记为死引用」的条目。两条最像死引用的假设均已证伪：

| 假设 | 检索 | 结论 |
| --- | --- | --- |
| `getPublicHome` 在 `db/catalog.ts` 已死 | `getPublicHome` 在该文件大小写敏感命中 **0**；全仓（含 `packages/contracts/openapi.json:23-24`、`packages/contracts/operations.json:5`、台账自身、两份历史证据页）共 8 处；实现为同文件 `readHomePreviews`（14 声明、32 闭包），HTTP 面在 `services/api/src/routes/public-home.ts` | **未死**，重锚 14-32 |
| `grantConsent` 在 `privacy/grant-pg.ts` 已死 | `grantConsent` 在该文件大小写敏感命中 **0**；全仓 10 处（`openapi.json:1237-1238`、`docs/verification/product-readiness.md:62-63`、台账自身等）；实现为 `persistConsentGrant`（32 声明、113 闭包），HTTP 面在 `services/api/src/routes/consents.ts` | **未死**，重锚 32-113 |

### 3.2 条目名在区间内不出现的 7 条（不是死引用）

| # | 条目名 | 条目名在目标文件命中 | 锚点符号 | 说明 |
| --- | --- | --- | --- | --- |
| 4 | `requestAccountDeletion` | app.ts 2 处，均在注释行（140/1716） | `registerAccountDeletionRoutes` | 本条证据指「装配点」，注册块 1722-1729 原值已正确 |
| 5 | `loginWechat` | wechat.ts **0**（routes/auth.ts:2/57 有） | `createWechatIdentityProvider` | operation 名属 HTTP 面，文件内实现名不同 |
| 7 | `getPublicHome` | catalog.ts **0** | `readHomePreviews` | 同上，见 §3.1 |
| 14/15/16 | `listKnowledge` | pagination.ts **0** / service.ts **0** | `paginateKnowledge` / `createKnowledgeService` | 台账以 operation 名引用实现块 |
| 17 | `getKnowledge` | service.ts **0** | `async function read(` | 读路径由 `read()` 承载 |
| 26 | `grantConsent` | grant-pg.ts **0** | `persistConsentGrant` | 见 §3.1 |

（`execution_modes` 系小写键名：config.ts 内小写 `execution_modes` 命中 0，但大写 `EXECUTION_MODES` 在 164/167/173，属同一配置校验；大小写不敏感全仓 26 处。）

### 3.3 存疑项：3 条（已改，但原意不能证明）

| # | 条目 | 新区间 | 搜了什么 | 残留风险 |
| --- | --- | --- | --- | --- |
| 3 | `idempotency`（dim） | app.ts 828-834 | `idempotency` 在 app.ts 14 处；基线旧区间是 5 个 `register*Routes` 装配调用（与幂等无关）；候选为 814（`idempotencyStore` 选择）、828（注入 `AuthService`）、834（`idempotencyHmacKey`） | 取「注入段 828-834」是**语义选择**：若作者原意是存储装配行 814，本条应收窄为单行 |
| 18 | `source_kind`（dim） | knowledge/service.ts 102-104 | `source_kind` 在文件内 1 处（102，位于 `project()` 的返回对象 100-105） | 基线旧区间 43-47 是会话/DB 读取区，说明该引用写于更早版本；现区间是唯一含该字段的投影区 |
| 19 | `createUpload`（op） | media/service.ts 807-874 | `createUpload` 在文件内 5 处（5/149/343/742/868）；实现符号是 `initiateUpload`（807 声明）、同键保护入口 869-874、**868 行注释含 `createUpload`** | 7 条 media 引用此前共用模块头 1-40；createUpload 的区间含注释行 868 与包装函数，比另 6 条宽（另 6 条各自 = 一个实现块） |

## 4. 只改 `lines` 的机器证明

`git diff -U0 -- docs/architecture/contract-status.json` 的读数为：

| 读数 | 值 |
| --- | --- |
| 删除行（`-`，不含 `---`） | 27 |
| 其中形如 `"lines": "<数字>-<数字>",?` 的行 | 27 |
| 新增行（`+`，不含 `+++`） | 27 |
| 其中形如 `"lines": "<数字>-<数字>",?` 的行 | 27 |
| 非 `lines` 的变化行 | **0** |

- 文件行数 3139 → 3139（无增删行，只有 27 行内容变化）；字符数 115688 → 115721（仅行号位数差）；`JSON.parse` 自检：`operations` 112 条、`dimensions` 8 条，与改前一致。
- **未用 `JSON.stringify` 全量重写**：该文件存在既有的缩进不规则（第 705-716 行一带的证据对象比标准 2 空格深/浅 1 格），`JSON.parse → stringify` 会重排约 100 行与本次无关的内容。本片改为**逐行文本手术**：只替换目标行的 `lines` 值，其余字节原样保留（脚本 `apply.mjs`，按「条目 + path + 旧值」三元组定位，命中数必须恰为 1）。
- 27 处改动分布在 27 个不同行号上；同一物理区间被多条条目共享的两组（#14/#15 的 `pagination.ts` 旧值、#19–#25 的 `media/service.ts` 旧值）均按条目分别改写，未合并、未拆分条目。

## 5. 校验器改前 / 改后逐字读数

`node tools/verify-contract-status.mjs`，改前（`git stash` 掉本片改动后实跑，exit 0）与改后（exit 0）逐字：

| 关键行 | 改前 | 改后 |
| --- | --- | --- |
| 语义计数 | `PASS: 语义可核 104 条区间 + 0 条片段；不可核 89 条区间 + 131 条片段（不可核不计入通过）` | 同左，未变 |
| 锚点计数 | `PASS: 证据锚点 141 条引用自带锚点（区间内 0 条 + 仅整文件 141 条）` | 同左，未变 |
| 纯行号区间 | `PASS: 纯行号区间 229 条（有实质内容 229 条；整段仅空白/收尾行 0 条、区间首行为空行 3 条）` | `… 区间首行为空行 2 条` |
| 中文表格 | `PASS: 中文表格一致` | `PASS: 中文表格一致`（先报 `FAIL: 表格漂移`，`--write-doc` 重生成后通过） |
| 形状/语义错误 | 0 / 0 | 0 / 0 |

读数未变的原因：语义计数只统计 operations 的**路由声明块**（`app.<method>('…')`），本片改的都是 service / config / registry / 装配行，所在文件无路由声明 ⇒ 仍计入「不可核」；`dimensions` 不参与语义计数。唯一的变化是「区间首行为空行」3 → 2（#6 旧区间首行是空行，重锚后不再以空行开头，且未新增此类区间）。

`docs/architecture/contract-implementation-status.md` 由官方开关重生成，diff 为 **25 个表格行**（27 条 evidence 因同一表格行内合并而落在 25 行：`listKnowledge` 一行含 #14/#16 两条、`取消` 维度一行含 #13/#28 两条、`超时` 行同时含 S30 已订正的 `525-542` 与本片 #27 的 `525-544`）。未手改一个字符。

## 6. 门禁（本工作树，HEAD = `32ce461` + 本片改动）

| 命令 | exit | 读数 |
| --- | --- | --- |
| `npm run lint` | 0 | tsc 2/2 PASS；仓库卫生扫描 PASS |
| `node tools/verify-release-materials.mjs` | 0 | 15/15 项通过 |
| `npm run test:docs` | 0 | 研究记录 5 通过 / 0 失败 / 4 legacy 钉住 |
| `node tools/verify-contract-status.mjs` | 0 | 形状错误 0 / 语义错误 0 / 中文表格一致 |
| `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | pass 6 / fail 0 |
| `node --test --test-concurrency=1 tests/unit/contract-status-anchors.test.mjs` | 0 | pass 11 / fail 0 |
| `git diff --check` | 0 | 无输出 |

## 7. 未取得项与限制

- **不能证明作者原意**：区间内符号可核，只证明该符号现在位于此，不证明作者当初想指这段。B 组 3 条（#3/#18/#19）尤其如此，已在 §3.3 单列。
- **没有死引用可登记**：本片结论是 0 条死引用，而不是「跳过」。两条疑似死引用（`getPublicHome`、`grantConsent`）经检索证伪，实现符号在 HEAD 存在；把「operation 名不在该文件」当成死引用会误杀 7 条正确引用（§3.2）。
- **未改任何代码**：`services/**`、`apps/**`、`packages/**`、`tests/**`、`deploy/**`、`migrations/**` 与 workflow 零改动；未改任何 `status`、`notes`、`blocker`。
- **未复核 S30 已改的 92 条**：不在本片范围；本片只处理 28 条「需人工」。同文件另有一条 `timeout` 证据 `525-542`（S30 已订正，非 28 条之一）也未动——它与 #27 的 `525-544` 是两条独立 evidence，未合并（见下）。
- **#27 与同文件另一条 `timeout` 的处理**：`services/api/src/recognitions/service.ts` 的 `timeout` 维度有两条 evidence，`525-542`（S30 订正后）与 `525-543`（#27）。两条都不是重复项：前者是 S30 用「基线搬迁」判据改的，后者是 S30 判「无唯一锚点」留下的。本片只把 #27 改为 `525-544`（函数闭包行），**没有**把 `525-542` 一并改成 `525-544`，也没有删除任一条——避免二次破坏 S30 的订正。两条现分别指向同一实现的「计时器/竞态段」与「整个函数块」，宽度不同但都自洽；若要收敛，应由台账 owner 决定删哪条，不属本片。
- **未跑全量测试**：本片只改文档数据，按 `docs/pr-review-policy.md` 跑契约、锚点与文档门禁；未跑 `npm test` 全量。
- 不声称通过监工审查，不声称契约实现或真实业务通过验收。

## 8. 复现命令

脚本在工作树外（不提交）：`E:\GengYunCommander\.pg17\tmp\r28-s41\`。

| 目的 | 命令 |
| --- | --- |
| 28 条断言 + 断点行/终点行 | `node .pg17\tmp\r28-s41\plan.mjs check` |
| 27 处文本手术 | `node .pg17\tmp\r28-s41\apply.mjs` |
| 只改 lines 证明 | `git diff -U0 -- docs/architecture/contract-status.json` |
| 重生成投影 | `node tools/verify-contract-status.mjs --write-doc` |
| 校验 | `node tools/verify-contract-status.mjs` |
