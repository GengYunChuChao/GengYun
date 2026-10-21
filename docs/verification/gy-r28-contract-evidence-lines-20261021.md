# 契约台账 evidence 行号订正证据（2026-10-21）

2026-10-21（UTC+8），分支 `docs/gy-r28-contract-evidence-lines`。本页记录对 `docs/architecture/contract-status.json` 中 evidence 引用行号的订正方法与结果，**只改行号数值，不改条目、状态、结论或缺口描述**。本页是位置证据，不证明契约语义正确、真实能力或整项验收；也不替代监工复核。

- 实现基线：`c06d232`（= 当时 `upstream/main`）；完成后已 rebase 到 `56042f7`，门禁在 rebase 后重跑，结果与本页一致（见交接报告）。
- 提交作者：`dsh-r28-writer <dsh-r28-writer@local>`。
- 改动文件：`docs/architecture/contract-status.json`（92 处 `lines` 字符串）、由其机械派生的 `docs/architecture/contract-implementation-status.md`（用官方 `--write-doc` 重新生成，未手改）、本页。

## 台账形态与是否生成物

`docs/architecture/contract-status.json` 顶层含 `contract_version`、`proposal_revision`、`baseline`（`72c4923a8ec058399a51609e1cf1e3c70a890b4a`）、`source_of_operations`、`status_definitions`、`operations[]`（112 条）、`dimensions[]`（8 条）。evidence 项形状只有两种：`{path, lines}` 或 `{test, name}`。

其 `generated_by` 自述为「人工核对状态与缺口；tools/verify-contract-status.mjs 校验并同步中文表格（不是冻结契约事实源）」。全仓检索未发现生成该 JSON 的脚本；`tools/verify-contract-status.mjs` 只校验并用 `--write-doc` 同步 `docs/architecture/contract-implementation-status.md` 中的中文表格。因此本片直接订正 JSON，再用官方开关重生成投影表格，没有手改生成物。**限制**：若仓库外仍有未入库的生成流程，本片未覆盖。

## 订正判据（只采纳可确证的漂移）

先解析每条 `path` + `lines`；文件不存在、区间越界、首末行为空行或纯闭合符的记为**结构可疑**，仅作筛查，不单独作为改号依据。随后按以下顺序取得可确证的新位置：

1. **路由声明锚点（32 条）**：operation 的 method+path 在其路由文件中唯一声明（`app.<method>('${API_PREFIX}/...'` 规范化参数）。若声明行落在存储区间之外，新行号 = 声明行至该 `app.<method>(...)` 调用的配平右括号行（整个注册块）。该「整块」惯例由台账中本来正确的样本反推：`routes/public-home.ts:9-16`、`routes/auth.ts:42-83` 均恰好等于注册块。声明已在存储区间内的，一律保留。
2. **基线内容搬迁（56 条）**：取台账 `baseline` 提交 `72c4923…` 中该区间原文（仅统一行尾 CR），在当前文件中精确检索；**唯一命中**才改，新行号 = 命中区间；多处命中或零命中一律不改，列入「需人工」。
3. **引入快照（3 条）**：对基线中不存在的文件，用 `git log -S '"lines": "<旧值>"' -- docs/architecture/contract-status.json` 找到该行号写入台账的提交，比较该提交时文件对应片段，再按第 2 条在当前文件检索；唯一命中才改。
4. **同位共享（1 条）**：横切维度 `versioning` 与 operation `getKnowledge` 指向完全相同的 `routes/knowledge.ts:30-34`；同一物理位置随该路由块一并订正为 `193-199`，在报告中单列说明。

**不改的边界**：零命中、多命中、文件缺失、基线缺失、无法唯一锚定的一律保留原值；不把「相邻」「同名函数」「看起来像」当作证据；不为凑比例放宽匹配。只改 `lines` 字符串，键序、缩进、行尾（LF）、末尾换行保持原样。

## 统计

| 项目 | 数量 | 说明 |
| --- | --- | --- |
| 可解析 `path`+`lines` 引用 | 229 | 另有 9 条 `path` 无 `lines`、171 条 `test` 引用，不在本片范围 |
| 已订正 | 92 | 32 路由声明 + 56 基线搬迁 + 3 引入快照 + 1 同位共享；分布于 85 个 operation、7 个 dimension |
| 保留未动 | 109 | 基线原文在当前文件同位命中，或路由声明本就在区间内 |
| 需人工 | 28 | 无法唯一确证，未改，逐条见交接报告 |
| 结构筛查命中 | 63 | 其中订正 41、需人工 5、保留 17 |

关于「保留 17」：这 17 条首行或末行为空行/纯 `}`，但基线原文在当前文件**同位**命中（自 `baseline` 以来未漂移），其边界是完整函数或对象块的正常收尾（例如 `packages/reference/zhejiang.mjs:97-160`、`services/api/src/db/pool.ts:27-53`）。按「不能确证漂移就不改」保留原值，不把它们错误地算作已订正，也不虚报为坏引用；清单见交接报告。

改前改后结构比较（脚本 `cmp.mjs`）：JSON 行数 3139 → 3139，变化行 92 行且全部只差 `lines` 字符串，`JSON.parse` 深度比较除这 92 处外完全相等（`otherDiffs=0`）。行号格式全部符合 `^\d+-\d+$` 且在文件长度内（校验器形状错误 0）。

## 抽样对照（改前 → 改后，均为 HEAD 实际行）

| 条目 | 文件 | 改前 | 改后 | 新行号首行（节选） | 判据 |
| --- | --- | --- | --- | --- | --- |
| createUpload | `services/api/src/routes/media.ts` | 157-165 | 218-233 | `app.post(` | 路由声明 |
| listPosts | `services/api/src/routes/community.ts` | 200-200 | 201-209 | `app.get(` | 路由声明 |
| listKnowledge | `services/api/src/routes/knowledge.ts` | 25-29 | 188-192 | ``app.get(`${API_PREFIX}/knowledge`, { preHandler: …`` | 路由声明 |
| listFavorites | `services/api/src/routes/favorites.ts` | 60-72 | 89-92 | ``app.get(`${API_PREFIX}/favorites`, { preHandler: …`` | 路由声明 |
| listHistory | `services/api/src/routes/history.ts` | 55-62 | 80-83 | ``app.get(`${API_PREFIX}/history`, { preHandler: …`` | 路由声明 |
| getKnowledge（含 versioning 同位） | `services/api/src/routes/knowledge.ts` | 30-34 | 193-199 | ``app.get(`${API_PREFIX}/knowledge/:id`, { preHandler: …`` | 路由声明 |
| listPosts | `services/api/src/community/service.ts` | 490-495 | 748-753 | `async listPosts(actor: unknown, query: ListPostsQuery = {})` | 基线搬迁 |
| listAdminSources | `services/api/src/admin/service.ts` | 513-518 | 574-579 | `listAdminSources: async (ctx, query = {}) => …` | 基线搬迁 |
| error_codes | `services/api/src/errors.ts` | 29-63 | 42-76 | `export class ApiError extends Error {` | 基线搬迁 |
| requestAccountDeletion | `services/api/src/privacy/account-deletion.ts` | 176-205 | 200-229 | `export function createAccountDeletionRequestService(input: …` | 引入快照 |
| getDeletionReceipt | `services/api/src/privacy/account-deletion.ts` | 96-141 | 120-165 | `export function createDeletionReceiptRegistry(input: …` | 引入快照 |
| timeouts（ocr） | `services/api/src/ocr/service.ts` | 52-58 | 53-59 | `export const DEFAULT_JOB_DEADLINE_MS = 30 * 1000;` | 基线搬迁 |
| timeouts（tts） | `services/api/src/tts/service.ts` | 637-660 | 819-842 | `mediaPort: media.kind,` | 基线搬迁 |
| likePosts | `services/api/src/community/service.ts` | 944-949 | 1329-1334 | `async likePosts(actor: unknown, id: unknown, options: WriteOptions)` | 基线搬迁 |
| suspendUser | `services/api/src/admin/ops/service.ts` | 320-325 | 413-418 | `async function suspendUser(ctx: AdminCallContext, id: string)` | 基线搬迁（见限制） |

全量改前改后对照（92 条）保存在一次性脚本输出中，未提交；报告给出统计与需人工清单。

## 未取得项与限制

- **不能证明作者原意**：锚点唯一命中只证明该文本/声明当前位于此，不能证明作者当初想指这一段；若作者原意是别的区间，本片无法发现。路由「整块」区间是由台账内已知正确样本反推的惯例，不是台账写明的规则。
- **`suspendUser` 属宽度保持的推断**：基线区间末行是空行，当前文件对应位置没有该空行；实质 5 行（413-417）唯一命中，为保持原 6 行宽度取到 418（该行是注释）。这条改动的末行不是唯一证据，已在报告注明。
- **17 条结构保留项**：不能证明其边界符合作者本意，只证明自基线以来未漂移。
- **28 条需人工项未改**：包括区间首行即 `});` 的 `recognitions/service.ts:525-543`、文件在基线中尚不存在的 favorites/history service 引用、以及 `media/service.ts:1-40` 这类明显指向文件头的引用；逐条 path+原行号+原因见交接报告。
- **中文表格是投影**：`contract-implementation-status.md` 由 `node tools/verify-contract-status.mjs --write-doc` 重生成，diff 仅 evidence 单元格的行号文本变化；未手改，但不能排除该投影脚本自身的历史问题。
- **未覆盖**：`test` 类引用（171 条）、无 `lines` 的 `path` 引用（9 条）、以及行号正确但语义覆盖范围不当的可能性。
- 不声称本次订正通过监工审查、不声称契约实现或真实业务通过验收。

## 复核命令与结果（本工作树，rebase 到 `56042f7` 后）

| 命令 | exit |
| --- | --- |
| `npm run lint` | 0（tsc 2/2、卫生扫描通过） |
| `node tools/verify-release-materials.mjs` | 0（15/15） |
| `npm run test:docs` | 0（研究记录 5 通过 / 0 失败 / 4 legacy 钉住） |
| `node tools/verify-contract-status.mjs` | 0（形状错误 0、语义错误 0、中文表格一致） |
| `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0（6/6） |
| `node --test --test-concurrency=1 tests/unit/*contract*.test.mjs`（10 个文件） | 0（123/123） |
