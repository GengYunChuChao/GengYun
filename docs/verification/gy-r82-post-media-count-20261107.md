# GY-R82 · #6「每帖 ≤3 张」real 计数端口接线（2026-11-07）

- 工作树 `E:\GengYunCommander\.pg17\wt-r82-mediacount`，分支 `fix/gy-r82-post-media-count`，基线 `origin/main`（当时 `6daa4bc5`）。
- `Refs #6`（不 `Closes`）：本片只解决该 issue 六个缺口之一——real 模式下 `community_image` 用途的「每帖 ≤3 张」计数端口从**恒 503** 变为**真实 PG 计数**。
- 零迁移：计数只读 `public.media`（`owner_id` / `purpose` / `state`）；`deploy/postgres-cvm/sql/20-login-roles.sql` 已对该表授权，未新增表、未新增函数。
- 口径：**按 owner 的保守计数**（`state NOT IN ('deleted','rejected')`）；权威「每帖」判定仍属 GY-I15 附件挂载，本端口不冒名顶替。

## §1 改动清单

| 文件 | 改动 |
| --- | --- |
| `services/api/src/media/attachment-counter-pg.ts`（新增） | `createPostgresAttachmentCounter(store)` 的**全部实现**：构造期校验 `store.kind === 'postgres'`，否则 `TypeError`（fail-closed，不静默放行）；`countFor({ liveCommunityImages })` 原样返回登记册读数；`note` 字段如实写明口径与 TOCTOU 窗口 |
| `services/api/src/media/service.ts` | **行号中性**，只做四处同行原位替换：①`object-store.ts` 那行 import 尾部追加新模块 import；②`CommunityAttachmentCounter.kind` 联合加 `'postgres'`；③默认计数器表达式由 `executionMode === 'real' ? …` 改为先看持久化端口 `options.persistence?.kind === 'postgres'` 再回落原分支（仍在原 3 行内）；④`unwired` 那条 docblock 补「real 且端口不是 PG 时的默认」口径。**整文件 1679 行不变，相对 base 4 增 4 删** |
| `services/api/src/app.ts` | **零改动**：装配层早已在 `services/api/src/app.ts:1831` 显式传 `persistence: mediaStore`，默认二分即可接线 |
| `tests/unit/media-attachment-limit-pg.test.mjs`（新增） | 3 条用例（见 §2） |

> 为什么新实现单独成文件：`media/service.ts` 被 `docs/**` 大量行号锚点引用，本仓纪律是「改被大量锚定的源文件优先行号中性」。第一版把实现写在 `service.ts` 里（净 +56 行）直接打红了文档锚点闸门（`ANCHOR_DRIFT 13` / `SUSPECT` 新增 5 / `BARE_ORPHAN` 新增 1 / 符号覆盖 44→47），因此改为现在这一版。

## §2 测试读数

`tests/unit/media-attachment-limit-pg.test.mjs`（PG 夹具零外网；建库脚本取 `0001` + `0003` + `0008`）：

| 用例 | 断言 |
| --- | --- |
| ① real + PG 装配 | `attachmentCounter.kind === 'postgres'`；第 1/2/3 张 201，第 4 张 400 `INVALID_REQUEST`（`details[{field:'/purpose',code:'post_image_limit'}]`，与既有文案一致） |
| ② 跨 owner 隔离 | 他人 3 张后第 4 张 400；本人此时仍 3 张 201、第 4 张 400（计数按 owner 分离） |
| ③ 端口缺失 fail-closed | `createPostgresAttachmentCounter(createMemoryMediaStore())` 构造期 `TypeError`，文案逐字断言；不发包、不放行 |

既有套件 `tests/unit/media-*.test.mjs`：166 pass / 0 fail（含 `media-attachment-limit.test.mjs` 的 real 无池 ⇒ `unwired` 503 用例，行为不变）。

## §3 自检读数

- `git diff --numstat <base> -- services/api/src/media/service.ts` → `4  4`（整文件行数 1679 → 1679）
- `node node_modules/typescript/bin/tsc -p services/api/tsconfig.json --noEmit` → exit 0
- `node tools/verify-contract-status.mjs` → exit 0
- `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` → exit 0

## §4 这个 PR 不声称什么

1. 不声称「权威每帖计数已实现」：本端口按 owner 计数，权威判定（帖子维度）属 GY-I15。
2. 不消除并发 TOCTOU：先数后写之间仍有窗口，本片如实登记，不用「加锁」之类的说法掩盖。
3. 不声称媒体域整体已接线：`services/api/src/media/real-ports.ts` 对 `persistence === 'process_memory'` 的校验与 `app.ts:1824` 注入 `createPostgresMediaStore` 的口径差异是另一件事，本片不动。
4. 未在真机/模拟器上走「社区发帖连续传 4 张图」的端到端路径：本次只有 PG 夹具级证据。

## §5 复现步骤

1. `cd E:\GengYunCommander\.pg17\wt-r82-mediacount`
2. `node --test tests/unit/media-attachment-limit-pg.test.mjs` → 3 pass
3. `node --test "tests/unit/media-*.test.mjs"` → 166 pass
4. `node node_modules/typescript/bin/tsc -p services/api/tsconfig.json --noEmit` → exit 0
5. `node tools/verify-contract-status.mjs && node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` → 双 exit 0
