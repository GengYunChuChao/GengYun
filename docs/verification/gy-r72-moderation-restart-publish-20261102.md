# GY-R72 重启后发布面回填（`moderation` 下架闸门）· 证据页

- 日期：2026-11-02
- 分支 / 基线：`feat/gy-r72-moderation-restart-gates`，基线 `71744d5c`（复核读数：`git rev-parse 71744d5c` = `71744d5cdc696f059ca33f624a549bdcec9ed9d1`；提交前 `git rev-parse HEAD` 同值）。
- 本片只碰：`services/api/src/moderation/service.ts`（**2 行等量替换、净 0 行**）、`tests/unit/moderation-publish-hydration-gate.test.mjs`（新）、`tests/integration/moderation-full-chain-pg.mjs`（**纯追加、0 删除**）、本页（新）。**没有**碰 `ledger-pg.ts`、`decisions.ts`、`app.ts`、迁移、`packages/contracts/**`、`deploy/**`、`apps/**`、`.github/**`、四份 `tools/doc-anchors-*.json`、`docs/architecture/contract-status.json`、`tests/unit/doc-anchor-relocations.json`。

## 0 结论先说（不是"改完就好"）

1. **一处闸门与回填的次序错误**：`publish` 的下架闸门读的是**内存台账**（`services/api/src/moderation/service.ts:939` 里的 `ledger.isWithdrawn(target)`），而持久台账的下架集合是**惰性回填**的（`services/api/src/moderation/ledger-pg.ts:299-312` 的 `hydrate()`，`services/api/src/moderation/ledger-pg.ts:300` 的 `if (hydrated) return;` 说明它只在第一次真读库）。`publish` 原来唯一的 `flushLedger()` 在闸门**之后**（`services/api/src/moderation/service.ts:1017`）⇒ **进程重启后的第一次 `publish` 在回填发生之前就把闸门判完了**：库里已下架的版本被翻回 `published`。
2. **改法一行**：在闸门**之前**加 `await flushLedger();`（`services/api/src/moderation/service.ts:938`），把次序改成"先回填、再判闸门"。回填失败按 fail-closed 拒绝（映射见 §2.3），**不允许**在没有回填证据的情况下把内容翻回公开。
3. **零行差成立**：`services/api/src/moderation/service.ts` 的 `git diff --numstat` = `2 2`；`git diff -U0` 只有**一个等量替换 hunk** `@@ -937,2 +937,2 @@`；闸门行 `if ((snapshot !== null && snapshot.visibility === 'hidden' ...` **仍在第 939 行**、字节未变（`.ts` 文件总行数改前改后都是 1450）。
4. **核心判据有牙齿**：`T1` 在改前**红**（逐字读数：`发布成功：{…"published":true…}`），改后绿；三条负控制各自打红到**指定**用例（§5）；真库臂 `[R1]` 打在**真实的** `public.moderation_withdrawals` 行上，不是替身。
5. **一条必须如实登记的边界**：`[R2]` 的迟到回调**现状是 `CALLBACK_JOB_UNKNOWN`，不是 `CALLBACK_TARGET_WITHDRAWN`**——重启后 `ledger.byJobId(...)`（`services/api/src/moderation/service.ts:1260`）只问内存，返 `null`，`:1261` 就先拒了，`:1288` 的同名下架拒收在该窗口**不可达**。本片**不**改回调判定（要补需按 job_id 回填作业结论的迁移，属另一片），只把这个读数钉住，避免后来者误以为已经修好。

## 1 缺陷链（带 `path:line`）

| # | 现场 | 读数 |
| --- | --- | --- |
| 1 | `publish` 读权威快照 | `services/api/src/moderation/service.ts:936` |
| 2 | 下架闸门**只看内存** | `services/api/src/moderation/service.ts:939`（`ledger.isWithdrawn(target)`）、拒绝在 `:941` |
| 3 | 内存里的下架集合要**先回填**才有内容 | `services/api/src/moderation/ledger-pg.ts:299-312`（`hydrate()`；`:300` 是"只回填一次"的幂等判据） |
| 4 | 回填只在 `flush()` 里被顺手拉起 | `services/api/src/moderation/ledger-pg.ts:491` 的 `async flush()`，`:498` 的 `await hydrate()` |
| 5 | 而 `publish` 里那次 `flushLedger()` 在闸门**之后** | `services/api/src/moderation/service.ts:1017` |
| 6 | ⇒ 重启后第一步就是 `publish` 时，闸门在回填之前判完 | 结果：已下架版本被翻回 `published`（`T1` 的改前红读数；真库臂侧的反证是 §5-N4 的 `REVISION_CONFLICT`） |

**为什么这条链只在"重启"上显形**：`submitScreening` 在 `ledger.create(...)` 之后就会 `flushLedger()`（`services/api/src/moderation/service.ts:898`），所以一个健康的进程在送审路径上已经把下架集合回填过；只有"重启后第一次动作是 `publish`"（另一个进程已经下架、本进程还没送审过任何东西）才踩空。这正是 `T1` 造的现场。

## 2 改法

### 2.1 一行（等量替换，净 0 行）

`services/api/src/moderation/service.ts:938` 现在读作：

```
    await flushLedger(); // 闸门前先回填持久台账的下架集合：重启后内存为空，不回填这道闸门看不见库里的下架行。
```

原第 937–938 行是两行注释，被压成**一行注释 + 这一行调用**（注释语义保留在 `services/api/src/moderation/service.ts:937`）。⇒ `git diff -U0` 只有一个 `@@ -937,2 +937,2 @@`，`git diff --numstat` = `2 2`，闸门行仍是第 939 行。

### 2.2 为什么放在这里，而不是"再往后补一次"

- 闸门是**前置**判据：若放到 `services/api/src/moderation/service.ts:1017` 那个位置之后的任何地方，拒绝路径已经先改可见性、或者已经先返回"版本冲突"——后者会把"永久不可复活"降级成"版本问题"（§5-N4 就是这条红）。
- 也**不**在闸门里额外加"再 `await flush`"：那会让闸门自己变成有副作用的分支，且拒绝路径上仍要先跑一次库查询。

### 2.3 回填失败为什么是 fail-closed

`ledger.flush()` 的语义是"**先回填下架集合，再等写入链**"（`services/api/src/moderation/ledger-pg.ts:491`、`:498`）；回填失败**不跳过**写面收尾（否则失败项不会被标成 reported），但最终**必须拒绝**（`services/api/src/moderation/ledger-pg.ts:504` 抛 `hydrateFailure`）。文案点明「回填」（`services/api/src/moderation/ledger-pg.ts:262-263`），与写面失败的「结论未落定」区分。错误码沿既有映射（`services/api/src/moderation/ledger-pg.ts:200-203`）：`57014`/`55P03` ⇒ `PROVIDER_TIMEOUT`，其余 ⇒ `PROVIDER_UNAVAILABLE`。

`flushLedger()` 本体（`services/api/src/moderation/service.ts:541`）对**内存台账**仍是空操作（`:542` 的 `if (ledger.flush === undefined) return;`）⇒ 内存装配不会被这次新增调用改变行为（`T2` 钉这一条）。

## 3 单测四条（`tests/unit/moderation-publish-hydration-gate.test.mjs`，新）

用的都是**既有**假池/夹具手法：持久台账用记录型假池（只认回填 SELECT、下架行 INSERT、结论 INSERT/UPDATE 与 `superseded` 读回，别的一律抛「假池不认这条语句」），权威用 `createSubstituteContentAuthority()` 外加一层记录包装（记 `setVisibility`/`setPublishedRevision` 次数）。"重启前已定结论、重启后还没回填"的现场是这么造的：先在内存 harness 上真跑一次 `submitScreening` 拿到 `succeeded`/`approved` 记录，再用 `ledger.create(record)` 搬进**新的**持久台账——`create()` 只入队、不打回填 SELECT（实测此时 `withdrawalsHydrated === false`）。

| 用例 | 钉什么 | 改前 | 改后 |
| --- | --- | --- | --- |
| **T1** | 持久台账 + 库里已有下架行（`withdrawalsHydrated === false`）⇒ `publish` 必须 `OBJECT_UNAVAILABLE` + `reason_codes` 恰为 `['TARGET_WITHDRAWN']`、可见性写入 0 次、不写下架行、回填后 `withdrawalsHydrated === true` | **红**：`AssertionError: 库里有下架行时不得发布；实际：发布成功：{…"published":true,"visibility":"published",…}`（原输出里另有 `target_ref` 与两个版本数字字段，此处省略，避免与本工具的裸锚点判据相撞） | 绿 |
| **T2** | 内存台账不回归：`ledger.flush === undefined` ⇒ 照旧发布成功、`isWithdrawn` 恒 `false` | 绿 | 绿 |
| **T3** | fail-closed 两条支路：(a) 通用存储失败 ⇒ `PROVIDER_UNAVAILABLE`；(b) `57014` ⇒ `PROVIDER_TIMEOUT`。两条都断言**发布没有发生**（可见性写入 0 次、不写下架行、不是成功体）、文案含「回填」、一次 `publish` 只打 2 条回填 SELECT（`hydrate()` 内部重试一次） | 绿（改前 1017 那次 `flushLedger()` 也会失败） | 绿 |
| **T4** | 回填只做一次：同一实例两次 `publish` 只发 **1** 条回填 SELECT | **红**：`第一次发布必须被拒；实际：发布成功：{…}` | 绿 |

**T3 为什么不能当"改动前后"的判据、却必须留**：它证明的是"回填失败 ⇒ 拒绝"这条**在所有调用点上**都成立（改前改后都绿），所以它拦不住"把调用漏掉/挪后"——那两条由 T1/T4 与 §5 的负控制负责。两条支路在 T3 内部**各自独立跑完再汇总**（先收集 `failures`，最后一次 `assert.deepEqual(failures, [])`），这样任一支路变红都能在一条失败信息里同时看到两条。

## 4 真库臂（`tests/integration/moderation-full-chain-pg.mjs`，纯追加一节 `[R]`）

追加位置：既有 `[3]` 那组 `say('[3] …')` **之后**、`await app.close()` **之前**（`[R]` 需要沿用已建立的 `pool` / `postId` / `moderationAdmin`；文件尾部 `finally` 已经把 `pool.end()` + `stopCluster()` 做掉了，物理追加到 EOF 就拿不到这些句柄）。该文件 `git diff --numstat` = 新增 93 / 删除 0，`git diff -U0` **只有一个纯插入 hunk**（`@@ -446,0 +447,93 @@`），前 446 行与既有尾部逐字未变。既有 5 组读数一字未改：`PASS 1..5` 与 `[ALL PASS] … （共 5 组 PASS）` 逐字复现；`[R]` 两行用**不推进 `passed`** 的打印函数发出。

| 读数 | 内容 |
| --- | --- |
| **`[R1]`** | 同一个 `pool` 上再 `buildApp` 一个实例当"重启"（`moderationInjection` 补 `callbackKey`，否则先撞 `CALLBACK_SIGNATURE_INVALID`）；该实例内存台账 `counts().withdrawn === 0`（**前提被断言**）。用它 `moderationService.publish` 发**已下架**的 `rev2` ⇒ 抛 `OBJECT_UNAVAILABLE`、`details` 恰为 `['TARGET_WITHDRAWN']`；回填后 `counts().withdrawn === 1`；社区行仍 `hidden` + `revision 3`（**拒绝路径零可见性写入**） |
| **`[R2]`** | 用库里**真实存在**的那条 `rev2` 作业 `job_id` 造一条合法签名（同一 `callbackKey`、`issued_at` 落在 `±CALLBACK_MAX_SKEW_MS` 内）⇒ `ingestCallback` 返回 `accepted === false` 且 `reason_codes` 含 **`CALLBACK_JOB_UNKNOWN`**（现状表征，非 `CALLBACK_TARGET_WITHDRAWN`，理由见 §0-5） |

**实跑读数（本机 PG 17.11，一次性集群，随机空闲端口只监听 `127.0.0.1`；跑两次一致）**：

```
PASS 1..5（[M] 迁移子集、[1] 建帖/编辑、[2] 422 隔离、[3] 后台下架与读缓存整链失效）
[R1] 重启实例（同 pool、内存台账空 withdrawn=0）⇒ 已下架的 rev2 publish 被拒 OBJECT_UNAVAILABLE+TARGET_WITHDRAWN；回填后 withdrawn=1，社区行仍 hidden+rev3（拒绝路径零可见性写入）
[R2] 迟到合法签名回调（库里真实存在的那条 rev2 任务）⇒ accepted=false + CALLBACK_JOB_UNKNOWN（现状表征：重启后 byJobId 只问内存，service.ts:1288 的 CALLBACK_TARGET_WITHDRAWN 在该窗口不可达；要补需迁移 0052 回填作业结论，属另一片）
[ALL PASS] 真库臂整线联调：post → edit → review → takedown 全链三态读数通过（共 5 组 PASS）
```

## 5 负控制（三条 + 一条附加，逐条打红 → 备份还原 → `Get-FileHash` 复算）

每条都从**做完本片改动的工作树**出发，只改被测那一行，跑本片用例，再从备份整体还原并复算 SHA256。**本片改动后 `services/api/src/moderation/service.ts` 的基线 SHA256 = `B8028931647898F4B918B0599CFEB2D72CC34FAB849CA75D28E6C88496736710`**；四条负控制还原后都**逐字节**回到该值（每次都与备份文件同时复算比对）。

| # | 怎么打的 | 红在哪（逐字摘录） | 恢复后 |
| --- | --- | --- | --- |
| **N1** | 删掉 `services/api/src/moderation/service.ts:938` 那行 `await flushLedger();` | `✖ T1 … AssertionError: 库里有下架行时不得发布；实际：发布成功：{…"published":true…}`、`✖ T4 … 第一次发布必须被拒；实际：发布成功：{…}`；T2/T3 绿 ⇒ **改的正是核心判据** | 复绿 4/4，SHA256 = 基线 |
| **N2** | 把它**挪到闸门之后**（闸门块结束之后、`services/api/src/moderation/service.ts:946` 的 revision 核对之前） | 与 N1 **逐字相同**的两条红（T1/T4），T2/T3 绿 ⇒ 位置是判据的一部分，不是"有调用就行" | 复绿 4/4，SHA256 = 基线 |
| **N3** | 让 `flushLedger()` 忽略 `ledger.flush`：`services/api/src/moderation/service.ts:542` 改成 `if (true) return;`（等价于"永不 flush"） | `✖ T1 … 实际：抛 PROVIDER_UNAVAILABLE：审核结论尚未确认落库：本次发布按未落库拒绝`、`✖ T4 …` 同形；**`✖ T3 … AssertionError: 两条支路都必须 fail-closed，红在：通用存储失败：…文案必须点明「回填」… ／ 语句超时：…回填失败必须拒绝发布（PROVIDER_TIMEOUT）；实际：抛 PROVIDER_UNAVAILABLE：…`** ⇒ T3 的**两条支路同时红** | 复绿 4/4，SHA256 = 基线 |
| **N4**（附加，派单未要求） | 把 `services/api/src/moderation/service.ts:938` 那行临时换成注释（等价 N1），跑**真库臂** | `FAIL: AssertionError [ERR_ASSERTION]: 重启后发布已下架版本必须 OBJECT_UNAVAILABLE，实际 REVISION_CONFLICT：内容不得发布（审核/版本/证据闸门不通过）`，exit=1 ⇒ 正是 `services/api/src/moderation/service.ts:937` 注释警告的"把永久不可复活改判成版本问题" | 真库臂复跑 `PASS 1..5` ＋ `[R1]`/`[R2]` 两行全绿，SHA256 = 基线 |

**一条如实说明（N3 的红不在"发布成功"）**：N3 让 `flushLedger()` 恒早退后，T1/T4 并不是"发布成功"，而是被**第二道闸**兜住了——`services/api/src/moderation/service.ts:1019` 的 `assertDecisionsDurable(gateTasks)` 以 `PROVIDER_UNAVAILABLE`「审核结论尚未确认落库」拒绝。所以 N3 的判别力落在 T3（文案必须点明「回填」）上，而不是 T1 的成功体上。这条区别是本片实测出来的，不写成"少了 flush 就能发布"。

## 6 门禁读数（逐条末行原文）

（见下表；`exit` 是命令自身的退出码，不是管道尾部命令的退出码。）

| 门禁 | 末行 / 读数 | exit |
| --- | --- | --- |
| `git diff --check` | 无输出 | 0 |
| `node --check tests/unit/moderation-publish-hydration-gate.test.mjs` | 无输出 | 0 |
| `node --check tests/integration/moderation-full-chain-pg.mjs` | 无输出 | 0 |
| `node --test tests/unit/moderation-publish-hydration-gate.test.mjs` | `ℹ tests 4 / ℹ pass 4 / ℹ fail 0` | 0 |
| `node --test tests/unit/moderation-withdraw-hydration.test.mjs` | `ℹ tests 6 / ℹ pass 6 / ℹ fail 0` | 0 |
| `node --test tests/unit/moderation-ledger-pg.test.mjs` | `ℹ tests 12 / ℹ pass 12 / ℹ fail 0` | 0 |
| `node --test tests/unit/jobs-cancel-moderation-answer.test.mjs` | `ℹ tests 10 / ℹ pass 10 / ℹ fail 0`（派单点名的 `tests/unit/moderation-cancel-idempotency.test.mjs` **在仓里不存在**，见 §7-3） | 0 |
| `node --test tests/moderation/http-callback.test.mjs` | `ℹ tests 14 / ℹ pass 14 / ℹ fail 0` | 0 |
| `node --test tests/moderation/http-jobs.test.mjs` | `ℹ tests 5 / ℹ pass 5 / ℹ fail 0` | 0 |
| `npm run lint` | `lint 通过（静态检查；不代表运行期或真实服务已通过）。` | 0 |
| `npm run test:docs` | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住` ＋ `PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住` | 0 |
| `node tools/verify-doc-anchors.mjs --strict --scan docs` | `PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN）` | 0 |
| `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | `PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）` | 0 |
| `node tools/verify-contract-status.mjs` | `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` | 0 |
| `npm run test:contract` | `ℹ tests 17 / ℹ pass 17 / ℹ fail 0` | 0 |
| `node --test tests/unit/doc-anchor-relocation-identity.test.mjs`（提交后跑） | `ℹ tests 33 / ℹ pass 33 / ℹ fail 0`（含 `A1 纯新增 docs 提交 ⇒ 显式 SKIP` 那条自证） | 0 |
| `npm run test:unit`（`$env:GY_BASH='D:\Git\bin\bash.exe'`） | `ℹ tests 6257 / ℹ suites 23 / ℹ pass 6253 / ℹ fail 0 / ℹ skipped 2 / ℹ todo 2 / ℹ duration_ms 163863`（首跑 2 红，见 §6.1 第三段） | 0 |
| 真库臂 `node tests/integration/moderation-full-chain-pg.mjs` | `[ALL PASS] 真库臂整线联调：post → edit → review → takedown 全链三态读数通过（共 5 组 PASS）` ＋ `[R1]`/`[R2]` 两行 | 0 |

### 6.1 两条"先红后修"的读数（如实登记，不删过程）

**本页第一次跑 `--strict` 时是 exit 1**，红在我自己刚写的这一页上（与本片代码无关）：`BARE_ORPHAN 基线之外新增 6 条`（其中一条是 `ambiguous-block`——只写行号、不带路径时 `service.ts` 与 `ledger-pg.ts` 都可能是候选；其余五条是 `no-explicit-in-block`）＋ 一条 `SUSPECT`（锚点指到只有右括号 `}` 的那一行）。修法：逐条补全为带完整路径的锚点、把指到右括号的那条改指紧邻的实质行（`services/api/src/moderation/service.ts:946`）、并把 T1 红读数里两处「字段名＋数值」的片段省略（否则会被当成裸锚点）；之后复跑两条门禁到 exit 0（见上表读数）。⇒ **这两条 PASS 是修过之后的读数**，不是一次成功。

**一门副产物**：那次报红里有一条是 T1 红读数中的「`published_revision` 加数值」片段被当成裸锚点——即"逐字摘录报错原文"与"裸锚点判据"会相撞，本页因此对那段 JSON 做了省略，并在此写明省略了哪两个字段（`published_revision`、`target_ref.revision`）。

**全量单测也红过一次（如实登记）**：`npm run test:unit` 首跑是 `ℹ tests 6257 / ℹ pass 6251 / ℹ fail 2`（exit 1），当时本页还带着上面那批裸锚点；把本页修到 `--strict` 绿之后再跑同一条命令，得到 §6 表里那次 `ℹ pass 6253 / ℹ fail 0`（exit 0），并单独复跑 `tests/unit/doc-anchors-guard.test.mjs`、`tests/unit/test-line-anchors-guard.test.mjs`、`tests/unit/docs-truth-pins.test.mjs`、`tests/unit/doc-anchors-symbol-strict.test.mjs` 共 53 条全绿。首跑那两条具体是哪两个用例**没有留名**（首跑只筛了汇总行），因此这里只登记"在哪一版上红的"，不声称"已确认是锚点用例"。

## 7 诚实边界

1. **`[R2]` 不是"已修好"的证据，是"现状表征"的钉子**：重启后迟到回调一律先撞 `CALLBACK_JOB_UNKNOWN`（`services/api/src/moderation/service.ts:1260` 取不到作业 ⇒ `:1261` 拒收），`services/api/src/moderation/service.ts:1288` 的 `CALLBACK_TARGET_WITHDRAWN` 在该窗口**不可达**。本片**没有**让下架目标的迟到回调返回下架码——要那样做，回调侧必须能按 `job_id` 从库里取回作业结论（迁移回填），属另一片。⛔ 不把"钉住了读数"说成"修好了回调"。
2. **真库臂的追加位置与派单原文不同**：派单写"只在文件末尾追加"，但 `[R]` 需要沿用已建立的 `pool`/`postId`/`admin`，而文件尾部 `finally` 已 `pool.end()` + `stopCluster()`；物理追加到 EOF 拿不到这些句柄（只剩另起第二套集群，那会与"不许另起集群"冲突）。实际插在既有 `[3]` 之后、`await app.close()` 之前，并用 `git diff -U0` 证明**只有一个纯插入 hunk**（`@@ -446,0 +447,93 @@`、删除 0 行）、既有 5 组读数与 `[ALL PASS] … （共 5 组 PASS）` 逐字未变。该位置已由指挥裁决（m00370）批准。
3. **派单点名的 `tests/unit/moderation-cancel-idempotency.test.mjs` 在仓里不存在**（`tests/**` 下没有任何文件名含 `cancel` 的用例叫这个名字）。跑了仓里真正存在的、覆盖同一面的 `tests/unit/jobs-cancel-moderation-answer.test.mjs`（R71 的 `moderation`/`answer` 取消与幂等用例，10/10 绿）。⇒ 这是**替代**，不是"派单那条跑过了"。
4. **N3 的红不在"发布成功"**：N3 让 `flushLedger()` 恒早退后，T1/T4 由**第二道闸**（`services/api/src/moderation/service.ts:1019` 的 `assertDecisionsDurable`）以 `PROVIDER_UNAVAILABLE` 拒掉，所以 N3 的判别力落在 T3（文案必须点明「回填」）与 T1/T4 的错误码语义上。同理 **T3 不是"改前红"的判据**（改前 `:1017` 那次 `flushLedger()` 也会让 T3 绿）；改前红的是 T1 与 T4。
5. **`57014` 映射成 `PROVIDER_TIMEOUT`，不是 `PROVIDER_UNAVAILABLE`**：派单原文写的是后者，实测按 `services/api/src/moderation/ledger-pg.ts:200-203` 是前者。T3 因此拆成两条支路分别断言，两条都要求"发布没有发生"。**没有**为此改 `ledger-pg.ts`。
6. **一次失败的 `publish` 会打 2 条回填 SELECT**：`hydrate()` 失败后重试一次（`services/api/src/moderation/ledger-pg.ts:299-312`），T3 就钉 `hydrate_reads === 2`（只钉"确实去打了库"与"没有第三次"，不钉具体延迟）。
7. **没有覆盖的面**：真实供应商（`tms`/`ims` 真实外呼）路径、多进程并发下架、进程被强杀后的中间态、以及"迁移回填作业结论"那条（不在本片）。真库臂用的是既有的一次性集群与 `makeSyntheticPassPort`。
8. **`npm run build` 未跑**（本机 Windows esbuild 临时文件受阻，派单也未要求）。本页不声称"打包通过"。
9. **`npm run test:unit` 跑在 commit 之前的同一棵树上**；随后只把 §6 里 `doc-anchor-relocation-identity` 那一格读数补进本页（纯文本数字，不含任何锚点、不碰代码/测试），并复跑该条闸门确认仍绿。

## 8 需裁定点

1. **迟到回调要不要另开一片**：要让已下架目标的迟到回调返回 `CALLBACK_TARGET_WITHDRAWN`（`services/api/src/moderation/service.ts:1288`），必须让回调侧能按 `job_id` 取回作业结论（迁移回填 `moderation_decisions`）。本片只钉现状读数，不扩范围。
2. **`publish` 里现在有两次 `flushLedger()`**（闸门前 `services/api/src/moderation/service.ts:938`、闸门后 `services/api/src/moderation/service.ts:1017`）。第二次在回填已完成时等价于"再等一次写入链"，语义上是重复劳动。本片为守住"零行差（只允许一个等量替换 hunk）"**没有**动 `:1017`；是否合并成一次，建议单独一片处理（要动就得改行数）。
3. **`tests/integration/moderation-ledger-pg.mjs` 的头注释**写着该文件是"重启后旧回调不能复活已下架版本"的真库证据，与 §7-1 的实测不符（`CALLBACK_TARGET_WITHDRAWN` 在该窗口不可达）。该文件不在本片改动面内，由指挥在 W43 单独订正，本片**未动**它、也未算进 diff。
