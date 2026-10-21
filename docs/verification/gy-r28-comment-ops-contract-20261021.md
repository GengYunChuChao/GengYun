# R28-S60 评论五操作的契约形状用例与 evidence 锚点补齐（2026-10-21）

2026-10-21（UTC+8），分支 `test/gy-r28-comment-ops-contract`，工作树 `E:\GengYunCommander\wt-r28-s60`，基点 `76b0e86`。本页记录：在 `tests/unit/community-contract.test.mjs` 追加两个契约形状用例、给 `docs/architecture/contract-status.json` 里 5 条 operation 的 evidence 补 `name`、用官方 `--write-doc` 重生成投影表格的经过与机器证明。

本页是**位置与形状证据**，不证明契约语义正确、真实审核能力、HTTP 装配、真实微信身份/真机或整项验收；也不替代监工复核。

## 1 背景：5 条 operation 为何长期「不可核」

`docs/architecture/contract-status.json` 的 evidence 项只有两种形状：`{path, symbol/anchor, lines}` 或 `{test, name?}`。以下 5 条 operation 的第 3 条证据是 `{"test": "tests/unit/community-contract.test.mjs"}`，但**没有 `name`**，`tools/verify-contract-status.mjs` 因此把它们计入「无锚点不可核 · 无用例名」桶：锚点字段缺失时工具只计数、不判红，这条引用实际等于没被核对过。

| operation | 方法与路径 | 服务实现位置（台账既有引用） | 追加前证据 |
| --- | --- | --- | --- |
| `getComment` | `GET /comments/{id}` | `services/api/src/community/service.ts:1208-1213` | `{"test":"tests/unit/community-contract.test.mjs"}`（无 `name`） |
| `editComment` | `PATCH /comments/{id}` | `services/api/src/community/service.ts:1215-1220` | 同上 |
| `deleteComment` | `DELETE /comments/{id}` | `services/api/src/community/service.ts:1295-1300` | 同上 |
| `likeComments` | `PUT /comments/{id}/like` | `services/api/src/community/service.ts:1337-1342` | 同上 |
| `unlikeComments` | `DELETE /comments/{id}/like` | `services/api/src/community/service.ts:1341-1346` | 同上 |

派单核实的事实：`getComment`／`editComment`／`deleteComment` 在 `community-service.test.mjs`、`community-atomic.test.mjs`、`community-moderation-*.test.mjs` 有行为覆盖，但**不在**契约形状用例文件里；`likeComments`／`unlikeComments` 在 `tests/unit/` 下**零调用**（真正没测过）。

## 2 新增的两个用例（`tests/unit/community-contract.test.mjs`，原 5 + 新 2 = 7）

沿用文件既有风格：`makeHarness()` + `publishPost()` + `idem(seed)` 幂等键 + `check(契约名, 值)` 校验器（返回问题数组，空数组 = 形状合规）+ `assertApiError(code, status)`。

### 2.1 用例一：`getComment / editComment / deleteComment 的响应形状与契约一致（Comment / Ack）`

| 步骤 | 输入 | 断言 |
| --- | --- | --- |
| 建帖 | `publishPost(h.service, USER_A, {}, idem(11))` | 返回契约 `Post`（既有 helper） |
| 建评论 | `createComment(USER_B, post.id, { body: '评论区的第一版正文' }, { idempotencyKey: idem(12), ifMatch: \`"${post.revision}"\` })` | `check('Comment', …)` 为空；`revision === 1` |
| 读评论 | `getComment(USER_B, comment.id)` | `check('Comment', …)` 为空且 `id`／`post_id`／`revision` 与原值一致 |
| 编辑 | `editComment(USER_B, comment.id, { body: '改后的正文' }, { idempotencyKey: idem(13), ifMatch: \`"${comment.revision}"\` })` | `check('Comment', …)` 为空；`revision === comment.revision + 1`；`body` 为新正文 |
| **反例一：非作者** | `editComment(USER_A, comment.id, …)`（`USER_A` 是父帖作者、不是评论作者） | `assert.rejects(…, assertApiError('NOT_FOUND', 404))`：ApiError + `code` + HTTP 状态三者同时成立 |
| **反例二：旧 revision** | `editComment(USER_B, comment.id, { body: '拿着旧版本再改' }, { idempotencyKey: idem(15), ifMatch: '"1"' })`，此时当前已是 2 | `assertApiError('REVISION_CONFLICT', 409)` |
| 删除 | `deleteComment(USER_B, comment.id, { idempotencyKey: idem(16), ifMatch: \`"${edited.revision}"\` })` | `check('Ack', …)` 为空 |
| **反例三：软删后不可见** | `getComment(USER_B, comment.id)` | `assertApiError('NOT_FOUND', 404)`——不是返回一条 `visibility=deleted` 的 `Comment` |

### 2.2 用例二：`likeComments / unlikeComments 的响应形状与契约一致（Ack），重复 PUT 幂等、未点赞取消不回退`

| 步骤 | 输入 | 断言 |
| --- | --- | --- |
| 点赞 | `likeComments(USER_A, comment.id, { idempotencyKey: idem(19), ifMatch: \`"${comment.revision}"\` })` | `check('Ack', …)` 为空；`accepted === true` |
| **同键重复 PUT** | 同 key `idem(19)`、同 `ifMatch` | 仍 `check('Ack', …)` 为空、`accepted === true`、不抛错（走 `withIdempotency` 的重放分支） |
| 读面 | `getComment(USER_B, comment.id)` | `check('Comment', …)` 为空；并断言 `{...read, like_count: 1}` 必然被契约的 `additionalProperties: false` 拒绝 |
| 计数 | `h.service.countLikes('comment', comment.id)` | `=== 1`（重复 PUT 不重复计数，**不得为 2**） |
| 取消 | `unlikeComments(USER_A, comment.id, { idempotencyKey: idem(20), ifMatch })` | `check('Ack', …)` 为空；计数 `=== 0` |
| **未点赞再取消** | 同目标再 `unlikeComments(…, { idempotencyKey: idem(21), ifMatch })` | 仍 `Ack`、不抛错；计数仍 `=== 0`（**不得回退成 -1**），`accepted === true` |
| 不改版本 | `getComment(USER_B, comment.id)` | `revision` 与点赞前一致（点赞/取消不是内容编辑） |

### 2.3 ⚠ 偏差登记：契约 `Comment` 里**没有** `like_count`

派单 §2.1 第 4 步要求「`getComment` 读 `like_count`，断言为 1 且不为 2」，并注明「若契约 `Comment` 里没有该字段则跳过这条断言并在报告里说明」。按实际契约：

```
packages/contracts/openapi.json#/components/schemas/Comment
  additionalProperties: false
  properties: id, revision, post_id, author, body, visibility, audit_state, created_at
  required:   id, revision, post_id, author, body, visibility, audit_state, created_at
```

**`like_count` 不在其中**，且 `additionalProperties: false` 使任何额外字段都判违规；服务实现自己也这样记（`services/api/src/community/service.ts:1530` 注释：「契约 `Post`/`Comment` **没有**点赞计数字段，故无对外读取口」）。

处理方式（不放宽断言、不改服务代码）：

1. 用 `check('Comment', { ...afterLike, like_count: 1 })` 断言**必然**报 `additionalProperties` 违规——把「契约无此字段」这件事本身钉在用例里；
2. 计数改由服务诊断口 `h.service.countLikes('comment', comment.id)` 读取（同一文件 `community-service.test.mjs` 既有的做法），仍然断言 `1`／`0`，即「不重复计数」「不回退成负」两条语义照测。

## 3 evidence 补 `name`：行级定点插入

- 插入脚本：node 脚本，按 `"id": "<op>",` 定位 operation 块 → 块内找到**唯一**一行 `          "test": "tests/unit/community-contract.test.mjs"` → 该行行尾加逗号、紧随其后插入一行 `"name"`（缩进与原行一致）。标题从**新用例文件里逐字取出**（正则匹配 `test('<标题>', async () => {`），不手抄。
- 映射（前三条 → 用例一，后两条 → 用例二）：

| operation | 新增 `name` |
| --- | --- |
| `getComment` | `getComment / editComment / deleteComment 的响应形状与契约一致（Comment / Ack）` |
| `editComment` | 同上 |
| `deleteComment` | 同上 |
| `likeComments` | `likeComments / unlikeComments 的响应形状与契约一致（Ack），重复 PUT 幂等、未点赞取消不回退` |
| `unlikeComments` | 同上 |

- 文本层：`contract-status.json` 3368 行 → 3373 行，**净增 5 行**，另有 5 行只多一个行尾逗号（`git diff` 里就是 5 个 `-` + 10 个 `+`），插入后 JSON 仍可 `JSON.parse`，行尾保持 LF、无 BOM、末尾换行不变。
- 对象层（正反两向 `deepEqual`）：
  - `deepEqual(after, structuredClone(before) + 这 5 个 name)` ⇒ 通过（**除新增 `name` 外零差异**）；
  - `delete name ×5` 后 `deepEqual(_, before)` ⇒ 通过（反向还原一致）。
- 字节层（反向重放）：删掉那 5 行 `name`、去掉 5 个行尾逗号，结果与原文件**逐字节相等**。
- 未动：5 条的 `path`／`lines`／`symbol`，其它 operation 的 evidence 项数与内容，`dimensions`，`status`／`blocker`／`baseline` 等全部字段。

## 4 `--write-doc`：只动生成区

命令：`node tools/verify-contract-status.mjs --write-doc`（exit 0）。工具把 5 条 evidence 渲染成 `tests/unit/community-contract.test.mjs::<name>`，投影文档随之变化。

**读数（本次只贴变化的两行）**：

```
--write-doc 前：
PASS: 证据锚点 370 条引用自带锚点（区间内 229 条 + 仅整文件 141 条）；无锚点不可核 39 条（纯行号 0 + 无行号源文件 9 + 无用例名 30），只计数不判红
PASS: 语义可核 104 条区间 + 0 条片段；不可核 89 条区间 + 131 条片段（不可核不计入通过）

--write-doc 后：
PASS: 证据锚点 375 条引用自带锚点（区间内 229 条 + 仅整文件 146 条）；无锚点不可核 34 条（纯行号 0 + 无行号源文件 9 + 无用例名 25），只计数不判红
PASS: 语义可核 104 条区间 + 0 条片段；不可核 89 条区间 + 136 条片段（不可核不计入通过）
```

- **无用例名 30 → 25**（−5，恰是本片 5 条），「仅整文件」锚点 141 → 146（+5），与预期一致。
- 「不可核片段」131 → 136（+5）：工具的片段可核口径要求命中位置落在 `assert(...)`／`expect(...)` 的**实参**里，而这里新增的 5 个 `name` 是 `test(...)` 标题，按工具既有口径记「不可核」、**不冒充通过**（既有台账里同类 `name` 也是这么记的）；「语义可核片段」仍是 0，未因本片变好看。

**机器证明：只动生成区**（脚本 `prove-doc-tables.mjs`，源码见交接报告）：

```
LINES: 旧 200 / 新 200（相等）
PROOF A: 剥掉 135 条 | 行后，两版 sha256 同为 82195a14cb293ebd…，逐字节相等
PROOF B: 变化行 5 条，全部含 | 且落在生成区第 29–175 行之间；逐行前四列不变
  第 104 行：新增 1 个 ::用例名
  第 105 行：新增 1 个 ::用例名
  第 106 行：新增 1 个 ::用例名
  第 109 行：新增 1 个 ::用例名
  第 110 行：新增 1 个 ::用例名
PROOF C: §0 第 23 行逐字节未变（属在途 PR #364，未触碰）
```

- 证明 A 就是派单要求的「剥掉所有 `|` 行后新旧文档逐字节相等」（`contract-implementation-status.md` 200 行不变，135 条表格行被剥掉后两版 sha256 相同）。
- 证明 B 另外确认：5 条变化行**全部**含 `|`、**全部**落在 `<!-- contract-status-tables:start -->`（第 29 行）与 `<!-- contract-status-tables:end -->`（第 175 行）之间，且每行的**操作 id / 方法路径 / 状态**三列逐字节未变——变化只是证据列多出 `::<用例名>`。
- 证明 C：§0 第 23 行（`node tools/verify-contract-status.mjs` 的证据校验分三层…，属在途 PR #364）逐字节未变。

## 5 门禁（本工作树，逐条 exit 码）

| # | 命令 | exit | 结果 |
| --- | --- | --- | --- |
| 1 | `node --test --test-concurrency=1 tests/unit/community-contract.test.mjs` | 0 | 7/7 通过（原 5 + 新 2） |
| 2 | `node --test --test-concurrency=1 tests/unit/community-service.test.mjs tests/unit/community-atomic.test.mjs` | 0 | 42/42 通过 |
| 3 | `node tools/verify-contract-status.mjs`（不带 `--write-doc`） | 0 | 形状错误 0、语义错误 0、`中文表格一致`；读数见 §4 |
| 4 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | 6/6 通过 |
| 5 | `node --test --test-concurrency=1 tests/unit/contract-status-tool.test.mjs` | 0 | 18/18 通过（含「真实台账 `--write-doc` 臂不改写文档」） |
| 6 | `npm run lint` | 0 | tsc 2/2 + 仓库卫生扫描通过 |
| 7 | `npm run test:docs` | 0 | 研究记录 5 通过 / 0 失败 / 4 legacy 钉住 |
| 8 | `git diff --check`；`git status` | 0 | 无空白错误；提交后工作树干净 |

## 6 未取得项与限制

- **不证明语义正确**：用例只证明服务层返回值满足 `packages/contracts/openapi.json` 的 `Comment`／`Ack` 形状，以及三条反例的错误码/状态；不证明契约字段设计合理、不证明审核策略得当。
- **不是 HTTP 层证据**：两个用例直接调用 `createCommunityService`，不经产品路由（`services/api/src/routes/community.ts` 的契约头部、强 ETag、`no-store` 由 `tests/unit/community-http.test.mjs` 等其它文件覆盖，本片未改也未重测它们）。
- **不覆盖真实持久存储与真实审核**：内存 store + 冻结时钟出厂 gate；`real` 模式整域 `503 PROVIDER_UNAVAILABLE`、审核域发布闸门接线分支（`awaitingPublish`、评论重审后新 revision 发布）不在本片范围。
- **点赞计数不是契约面**：`Comment`／`Post` 都没有计数字段（§2.3），计数证据只来自服务诊断口 `countLikes`，外部客户端看不到。
- **`name` 的判别力有限**：工具只校验「该文本在被引用文件里找得到」，不证明该用例真的覆盖这条 operation 的全部语义；本节新增的 5 条因此按「不可核片段」计（§4），不冒充语义可核。
- **三条反例的边界**：非作者 404 用的是父帖作者 `USER_A`（比"陌生人"更强的越权尝试）仍得 404；未覆盖「他人能否读到自己不可见的评论」的读路径组合，那部分由 `community-service.test.mjs` 既有用例覆盖。
- 不声称本片通过监工审查、不声称契约实现或真实业务验收通过。
