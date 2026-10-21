# R28-S54 契约台账「不可核」证据锚点补录验证

日期：2026-10-21。作者 `dsh-r28-writer`。Refs #1（R28-S54 契约台账证据校正片），不关闭整项。

## 1 范围与基线

基线 `76b0e86`（`test(ci): 把备份副本域 backup-purge-pg 接进真库 CI`），分支 `docs/gy-r28-contract-uncertifiable`，工作树 `wt-r28-s54`。本片只做一件事：把 `docs/architecture/contract-status.json` 里**没有锚点**的证据引用补成可核——`test` 引用补 `name`（用例标题原文），`path` 引用补 `lines` + `symbol`。不改任何已有字段值，不改 `status`／`blocker`，不改 `tools/`、`tests/`、服务实现、迁移与 CI，不改 `packages/contracts/`，不新增或删除任何 evidence 引用（引用总数前后都是 409 条）。

改前读数（基线实测，`node tools/verify-contract-status.mjs`，exit 0）：

```
PASS: 证据锚点 370 条引用自带锚点（区间内 229 条 + 仅整文件 141 条）；无锚点不可核 39 条（纯行号 0 + 无行号源文件 9 + 无用例名 30），只计数不判红
```

改后读数（本片，exit 0）：锚点引用 404 条（区间内 238 + 仅整文件 166），无锚点不可核 **5** 条（纯行号 0 + 无行号源文件 0 + 无用例名 5）。形状错误 0 / 语义错误 0 / 表格漂移 0。

## 2 补了什么，凭什么算「真对应」

补录 34 条：`test` 引用补 `name` 25 条、`path` 引用补 `lines` + `symbol` 9 条。逐条映射（操作 → 文件 → 字段 → 命中行号 → 首尾行原文）见交接报告 `.pg17/handoff/r28-s54-report.md`。

`name` 在本工具里只是 `check(text.includes(item.name))`（`tools/verify-contract-status.mjs` 的 `checkEntry`），塞任意在文件里出现过的字符串都能过门禁——那等于伪造证据。本片的做法是：

- 先按操作语义定用例，再**程序化**从用例源文件按行号截取标题原文（含反引号模板字面量），落盘后再用 `source.includes(name)` 复核；没有一条标题是手抄的。
- 判据是「该用例组真的碰到这个操作」：组标题逐字含操作 id，且组内断言命中该操作的 HTTP 方法+路径或服务方法。
  - `createOCR/getOCR/deleteOCR/correctOCR/verifyOCR` → `tests/integration/ocr-http.mjs` 的 `record(...)` 组 1228／1272／1417／1272／1315；`correctOCR` 与 `getOCR` 同组（该组同一段同时断言 `GET /ocr/{id}` 200+ETag 与 `PATCH /correction` 200、revision 2、raw 原样保留）。
  - `createTranscription/getTranscription/confirmTranscription` → `tests/integration/speech-http.mjs` 的 `await group(...)` 组 161／185／348。
  - `deleteTranscription` → 同文件 268 的 `[4] If-Match…` 组：**该文件没有成功删除路径的用例**，只有 `del()` 的 428／400／409 三态与归属 404；本片据实选「断言 DELETE 三态」的那组，并在报告里写明覆盖边界，不冒称成功路径已验。
  - `createSynthesis` → `tests/integration/tts-http.mjs` 的 `await check(...)` 组 318（`C03 202·JobEnvelope 形状`）。
  - community 11 条 → `tests/unit/community-contract.test.mjs` 的 185／208／230 三个 test（分别断言 Post、Post/Ack、Report 的响应形状）。
  - 维度 `idempotency` 3 条 → `tests/unit/idempotency-job-ttl.test.mjs:45`、`tests/unit/admin-idempotency-expiry.test.mjs:51`、`tests/unit/pg-write-idempotency-ttl.test.mjs:75`；维度 `source_kind` 1 条 → `tests/integration/ocr-http.mjs:1326` 的 `3d) 登记库未接线 ⇒ unavailable…`（该组断言 `ocr.verification.registration === null`：来源未接线时如实 `null`、不冒充，与同维度已有 `services/api/src/ocr/reference.ts` 的 `SUBSTITUTE_MARK`／`createUnwiredDosePort` 同题）。
- `lines` 一律圈住实现主体，`symbol` 逐条在区间内实测命中（工具容差 ±2 行）：`createConversation` 636-679／`store-pg.ts` 220-231、`listConversations` 681-699、`getConversation` 701-706、`deleteConversation`（`0013_conversations.sql` 62-64，`REFERENCES conversations (id) ON DELETE CASCADE`）、`createTurn`（`job.ts` 48-61、`guard.ts` 250-365）、`listTurns` 822-841、`deleteTurn`（`cascade.ts` 76-100）。

**留存不可核 5 条**：`getComment`／`editComment`／`deleteComment`／`likeComments`／`unlikeComments`。它们现有的 evidence 指向 `tests/unit/community-contract.test.mjs`，而该文件 5 个 test 没有一条调用或断言这 5 个操作（只覆盖 createPost/getPost/listPosts、editPost/deletePost/点赞、createReport/getOwnReport、校验器元测试、Moderation 反例）。派单禁止换测试文件、禁止新增 evidence 项，所以按「宁可少补，不许硬塞」保留不可核。缺的是**测试覆盖本身**：补测试属后续片（建议编号 S62），本片不改测试文件。

因此本片终点是 **39 → 5**，不是 0。差的那 5 条不是锚点没补，是**没有可补的用例**；把 39 条压到 0 的唯一办法是塞无关标题，那正是派单明令禁止的。

## 3 偏离派单「不改 `contract-implementation-status.md`」的原因与范围

派单要求不改 `docs/architecture/contract-implementation-status.md`（另一片在改）。本片**没有改该文档的散文**，但保留了官方工具重生成的表格差异 30 行，原因是一条仓库自身的不变式：

- `tests/unit/contract-status-tool.test.mjs:381`（`语义正控制：真实台账 plain 臂通过且零误报`）要求真实台账 plain 臂 `status === 0` 且打印 `PASS: 中文表格一致`；
- `tests/unit/contract-status-tool.test.mjs:389`（`语义正控制：真实台账 --write-doc 臂不改写文档`）要求真实台账 `--write-doc` 臂 `status === 0`、文档 sha256 不变、且不打印 `SYNC: `；
- `tools/verify-contract-status.mjs:279-288` 的漂移判定与 `tools/contract-status-core.mjs` 的 `replaceStatusTables`：该函数用 `test::name`／`path:lines` 渲染对照表 ⇒ **JSON 一新增 `name`/`lines`，表格必然漂移**。

也就是说：只要 JSON 补锚点，md 不同步就自带「表格漂移 1 项」红门禁 + 上面两条单测红（第一条运行时还会真的用 `--write-doc` 改写仓库里的 md）。同步表格是仓库用回归测试钉死的，不是可选项。派单那条 ⛔ 的本意是保护**生成区之外的散文**（S53 的 #364 只改 §0 一行散文），本片严格守住了这一点。

机器证明（可复跑，脚本 `.pg17/tmp/md-region-proof.mjs`，输出 `.pg17/handoff/r28-s54-md-region-proof.txt`，`git diff -U0` 全文 `.pg17/handoff/r28-s54-md-diff-U0.txt`）：

- 差异 30 行，全部是以 `|` 开头的表格行（行号 37、38、80–103、107、108、111、112）；
- 每一对差异行，旧行是新行的**子序列**（纯插入，字符数只增不减），单元格数前后相同（7=7），第 1 格（操作名）与第 3 格（`status`）逐字节不变；
- 把两版的所有表格行剥掉后，其余文本各 9903 字节、**逐字节相等**（散文段落 0 处改动）；
- 第 23 行（S53 的 §0 散文行）与基线逐字节相同；
- `git diff --numstat 76b0e86 -- docs/architecture/contract-implementation-status.md` = `30 30`，与差异行数一致；
- 输出判定 `PASS`，exit 0。

`--write-doc` 幂等：连跑两次均 exit 0、均打印 `PASS: 中文表格一致`、均不打印 `SYNC: `，文档 sha256 三次一致（跑前／第一次后／第二次后）都是 `376a101e46d07f00a965af93411230d20e3ee95a76bc84c5bea6936f05a7e58e`。

一步回退（若指挥判定仍须一字不动）：

```
git checkout -- docs/architecture/contract-implementation-status.md
```

代价是 `node tools/verify-contract-status.mjs` 退回 exit 1（仅「表格漂移 1 项」，形状/语义错误仍 0），并由合并侧跑 `node tools/verify-contract-status.mjs --write-doc` 补齐（S53 改的 §0 在生成区之外，该命令不会重写它）。

## 4 实际检查

本机 Windows PowerShell 5.1，无 bash；Node 调用一律落 `.mjs` 文件后执行。以下命令均在本片工作树 `wt-r28-s54` 运行，退出码为实测：

| 命令 | 退出码 | 结果与边界 |
| --- | --- | --- |
| `node tools/verify-contract-status.mjs` | 0 | 四行 PASS：112 操作／8 维度／形状 0／语义 0；锚点 404（区间内 238 + 仅整文件 166）／不可核 5（0+0+5）；纯行号区间 238 |
| `node tools/verify-contract-status.mjs --write-doc`（连跑两次） | 0 / 0 | 均 `PASS: 中文表格一致`、无 `SYNC: `；sha256 三次一致 |
| `node --test --test-concurrency=1 tests/unit/contract-status-tool.test.mjs` | 0 | 18 通过 / 0 失败（含两条「真实台账」正控制） |
| `node --test --test-concurrency=1 tests/unit/contract-status-anchors.test.mjs` | 0 | 11 通过 / 0 失败 |
| `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | 6 通过 / 0 失败 |
| `node --test --test-concurrency=1 "tests/unit/*contract*"` | 0 | 134 通过 / 0 失败 |
| `npm run lint` | 0 | `tsc --noEmit` 两个工程 + 仓库卫生扫描通过（未改业务代码） |
| `npm run test:docs` | 0 | 27 项任务依赖与 Markdown 链接/表格校验通过、研究记录 5 通过／0 失败 |
| `node .pg17/tmp/md-region-proof.mjs`（仓外） | 0 | md 只动生成区表格的机器证明，见上节 |
| `git diff --check` | 0 | 无输出（无空白/冲突缺陷） |
| `git status --short` | — | 仅 `contract-status.json`、`contract-implementation-status.md`、本页三个文件 |

## 5 未验证与剩余

- 锚点层只证明「该符号出现在该引用行区间内（容差 ±2 行）」、`name` 只证明「该字符串在被引用文件里出现过」；**都不证明证据与操作的语义对应**，也不证明真实能力或整项验收。语义对应由本记录的人工判定承担，可被后来者推翻。
- `deleteTranscription` 的用例只覆盖 `If-Match` 三段守卫（428／400／409）与归属 404，**没有成功删除路径**的证据；该操作仍是 `partial`。
- community 5 条评论类操作仍不可核（无对应用例），`status` 与 `blocker` 未动。
- 本片未跑真实服务、真机、真实 PostgreSQL／微信／供应商凭据，未跑 CI；`status` 全部保持人工判定的 `partial`，不因补了锚点升档。
- 基准读数为历史事实：`76b0e86` 时是 370／39，本片后是 404／5；引用总数未增删（409）。
