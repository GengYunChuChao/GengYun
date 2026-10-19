# GY-I14 发布闸门接进产品路径 + 旧版本零副作用证据（离线，Refs #14）

- 日期：2026-10-19（UTC+8）
- 分支：`fix/gy-i14-publish-gate`；worktree：`.pg17\wt-i14-gate`；基线 `upstream/main = 8cc9dd8b1ee251c8d7000390d54e0ba07a6ac37f`
- 提交：`127b961`（先）/ `92feada`（后）；实现者：写手（本 worktree）。无 GitHub 凭据，**未 push、未开 PR、未评论**；`Refs #14` 不关闭整项。
- 关联：[任务台账 GY-I14](../initial-issues.md)、[审核域说明](../moderation/README.md)、[HTTP 层](../moderation/http-layer.md)

**边界（先读）**

> **本页不证明真实 AI 供应商能力（替身已标注）。** 所有模型端口均为测试内**显式注入的合成端口**
> （`provider.synthetic === true`，`provider_origin` 为 `injected`，`liveGate.open === false`），
> 不发起任何真实或付费调用、不读生产凭据。本页只证明**接线与失败语义**（版本绑定、零副作用、
> 未发布不可见）。它不替代 AC08 的人工审核入口、也不替代 GY-I21 的 200 风险 + 200 正常样本评估；
> AC16 的规则语料证据在 `tests/moderation/*`，本页只证明发布路径不会绕过规则层。

---

## 1 本片做了什么（两处缺陷）

| # | 缺陷（改前实测） | 提交 | 落点 |
| --- | --- | --- | --- |
| A | 审核域 `publish`／内容权威可见性写入**不核对权威当前 revision**：旧版本请求能写到新版本行上，且失败发生在副作用之后（半发布） | `127b961` | `services/api/src/moderation/service.ts`、`services/api/src/community/moderation-authority.ts`、`services/api/src/moderation/visibility.ts` |
| B | 发布闸门**不在产品路径上**：社区 `createPost`／`editPost` 在同一条写入里直接写 `visibility:'published'` + `audit_state:'approved'`，`moderationService.publish` 零生产调用方 | `92feada` | `services/api/src/community/service.ts`、`services/api/src/community/moderation-link.ts` |

**口径说明（与派单用词对齐）**：派单称"走 `pending_review`"。契约的 `Visibility` 闭集是 `private / published / hidden / deleted`，`AuditState` 闭集是 `pending / approved / rejected / quarantined`（`packages/contracts/openapi.json` → `components.schemas.Visibility`、`components.schemas.AuditState`）。因此"待审"在本片落地为 **`visibility:'private'` + `audit_state:'pending'`**，**未新增枚举值、未改契约**（契约与 `contract-status.json` 本片零改动）。

## 2 验收项逐条：代码锚 + 断言 + 实测

### 2.1 AC19「内容版本、注入防护、危险隔离、图片、修改重审，失败不公开」

| 要求 | 代码锚 | 断言（测试名 → 文件:行） | 实测 |
| --- | --- | --- | --- |
| 旧版本审核结果不得套新版本（写侧） | `services/api/src/moderation/service.ts:702-708`：`snapshot.current_revision !== target.revision` ⇒ `reasons.push('REVISION_SUPERSEDED:…')` + `refuse('REVISION_CONFLICT')`，**位置在任何写入之前** | `RG-1` → `tests/moderation/publish-revision-guard.test.mjs:57`；`RG-C1` → `tests/unit/community-moderation-revision-guard.test.mjs:52` | 4/4 + 4/4 pass |
| 内容权威不按"行自身版本"做 CAS | `services/api/src/community/moderation-authority.ts:120`：`const expected = { revision: target.revision, … }`；旧版本 ⇒ `:105-113` 拒绝（`旧版本不得改可见性`） | `RG-C1`（`assert.deepEqual(after, before)` 逐字段深等）、`RG-C2`（`:66`） | pass |
| 写失败不得留半发布中间态 | `services/api/src/moderation/service.ts:769-777`：`setVisibility` 后 `setPublishedRevision` 抛错 ⇒ `restoreWrittenVisibility(...)`（`:379-390`）回写写前可见性后原样抛 | `RG-4` → `publish-revision-guard.test.mjs:126`（写入序列 `['setVisibility','setPublishedRevision','setVisibility']`，第三次回写 `private`） | pass |
| 修改重审：新 revision 必须重新过闸门 | `services/api/src/community/service.ts:973-1011`（`editPost` 落 `private/pending` 后调 `link.publish`，`target_ref.revision` 是新版本） | `W3` → `tests/unit/community-moderation-gate-wiring.test.mjs:123`（`publish` 两次，第 2 次 `revision:2`、`published_revision:2`）；`W4`（`:144`）新版本被拒 ⇒ 行停在 `private/pending`、公开面消失 | pass |
| 失败不公开（隔离/未结论/发布被拒） | `services/api/src/community/service.ts:886-898`、`:999-1011`：闸门拒绝 ⇒ 行保留待审、错误原样上抛 | `W2` → `community-moderation-gate-wiring.test.mjs:81`（他人 `getPost` 404、公开列表空、作者看到 `private`）；既有 `G1d`／`G1g`（`tests/unit/community-moderation-publish.test.mjs:166/214`）仍为 422 零落库 | pass |
| 编辑后旧结论不得继续放行 | 见上（`W4`）＋审核域 `evaluateModelReReview`／`ledger.current(target,kind)` 按 revision 取任务 | `W4`；`G2a`／`G2b`／`G2c`（`tests/unit/community-moderation-revision.test.mjs`）全绿 | pass |

### 2.2 AC08「发帖评论可用且先审后发；人审入口建设中，无假任务／审核人」

| 要求 | 代码锚 | 断言 | 实测 |
| --- | --- | --- | --- |
| 发帖仍可用、同一请求内完成（对调用方行为不变） | `services/api/src/community/service.ts:863-901`：筛查放行 ⇒ 落 `private/pending` ⇒ `link.publish` ⇒ 返回 `published/approved` | `W1` → `community-moderation-gate-wiring.test.mjs:37`（发布**前一瞬**行是 `private/pending`，返回是 `published/approved`，`calls.publish.length === 1`）；既有 `G1i` 正控制仍绿 | pass |
| 先审后发：规则拒绝/隔离一律不落库 | `services/api/src/community/service.ts:842-858`（先 `gate.evaluate`，再 `requireDomainClearance`，之后才写行） | `G1a`／`G1d`／`G1g`／`G7` 保持原断言全绿（`snapshotCounts().posts === 0`） | pass |
| 人审入口不造假任务、不造假审核人 | 本片**未新增**任何人审任务/审核人；`humanReview` 仍无 HTTP 消费者（见 §6 未做） | 无新增断言（不变量：审核域任务只由 `submitScreening` 创建） | 未放宽 |

### 2.3 AC16「广告、购买链接、私下交易导流不发布」

| 要求 | 代码锚 | 断言 | 实测 |
| --- | --- | --- | --- |
| 规则层先挡，发布路径不得绕过规则拒绝 | `services/api/src/community/service.ts:844-848`：`gate.evaluate` 不 publishable ⇒ `recordRefusalVerdict` + `refusal(...)`，**先于**送审与落库；本片未改规则层与 `commerce` 类别 | `G7` → `tests/unit/community-moderation-publish.test.mjs:274`（危险正文 400 + `DANGEROUS_MIX`，`calls.screen.length === 0`，审核域零任务） | pass |
| 规则放行但闸门拒绝的内容仍不可见 | `services/api/src/community/service.ts:886-898` | `W2`（`:81`） | pass |

## 3 缺陷 A：改前 / 改后实测（探针，非测试）

探针 `E:\GengYunCommander\.pg17\tmp\probe-i14-revision-gate.mjs`，**同一脚本**对基线树 `.pg17\wt-i14-base`（`8cc9dd8`）与修复树各跑一次，输出见 `.pg17\tmp\probe-i14-before.json` / `-after.json`。

| 探针 | 改前（`8cc9dd8`） | 改后（`127b961`） |
| --- | --- | --- |
| A：行 `revision=2`，调 `setVisibility({revision:1},'published')` | `{ok:true}`，行变 `published` + `approved`（**旧请求写到新版本行**） | `REVISION_CONFLICT`(409)：`可见性写入未生效（目标 revision=1 不是社区当前版本 2：旧版本不得改可见性）`；行仍 `revision:2 / private / pending`，`updated_at` 不变 |
| A：紧接 `setPublishedRevision({revision:1},1)` | `REVISION_CONFLICT`：`拒绝声明已发布 revision=1：社区行的派生已发布版本为 2`（**失败在副作用之后**） | `REVISION_CONFLICT`：`拒绝声明已发布 revision=1：目标 revision=1 不是社区当前版本 2`（两次都**写前**拒绝） |
| A2 正控制：版本一致（`revision=2`） | 两步都成功，行 `published/approved`，CAS 写 **1** 次 | 同左（未误拒正常路径） |
| B：台账已有 rev1 的 `approved`，权威 `current_revision` 推到 2 后 `publish(rev1)` | `{published:true, published_revision:1}`；快照 `{visibility:'published', current_revision:2}`；`readView(rev1)` 此时才 `visible:false` + `REVISION_SUPERSEDED` | `REVISION_CONFLICT`(409) + `details:[{field:'reason_codes', code:'REVISION_SUPERSEDED:2:1'}]`；快照仍 `{visibility:'private', current_revision:2}`，`publishedRevision(rev1) === null` |

即：改前是"先写后报错（半发布）"，改后是"**先核对、再写、写后仍失败则补偿回写**"，且正常路径没有被误拒。

## 4 缺陷 B：改前 / 改后实测（探针 + 计数端口）

探针 `E:\GengYunCommander\.pg17\tmp\probe-i14-gate-wiring.mjs`（同一脚本跑两棵树），输出见 `.pg17\tmp\probe-gate-before.json` / `probe-gate-after.json`。探针用 `communityLinkWrapper` 在 `publish` 被调用的**那一瞬**读回社区行。

| 场景 | 改前（`8cc9dd8`） | 改后（`92feada`） |
| --- | --- | --- |
| 安全内容（合成 pass 端口） | `published` + `approved`，但 `publish_calls = 0`（**从未经过发布闸门**），`row_at_publish_call = []` | `published` + `approved`，`publish_calls = 1`（`target_ref` 为 `{post, id, revision:1}`），`row_at_publish_call = [{visibility:'private', audit_state:'pending'}]`，最终行 `published/approved`，公开列表 1 条 |
| 规则违规内容 | `INVALID_REQUEST`，`posts = 0`，审核任务 0，`publish_calls = 0` | 同左（**行为不变**） |
| 需复核内容（合成替身 `unsure` ⇒ 隔离） | `INPUT_UNCERTAIN`，`posts = 0`，审核任务 1 | 同左（**行为不变**：隔离仍在落库前被拒，不产生公开内容） |

说明：本片**没有**把"筛查隔离"改成"落库待审"。派单要求"需人审的走 pending_review"，本片落地为两段：

1. **筛查阶段就不放行**（隔离/驳回）⇒ 保持既有语义：400/422、**零落库**（`G1a`/`G1d`/`G1g`/`G7` 原断言不变）；
2. **筛查放行、发布闸门拒绝**（版本/重审判定/任务转待审）⇒ 行**落库为 `private` + `pending`**（即待审），错误原样上抛、读面不可见，不静默丢弃（`W2`/`W4`）。

这样"需复核内容不得 published"在两条路径上都成立，且没有把"人工审核入口不存在"包装成"内容已待审可发布"。

## 5 既有断言：没有放宽任何一条

- 断言改动：**0 条**（未删测试、未加 `skip`、未改任何 `assert.*` 的期望值/边界）。
- 测试侧改动**只有装配**，逐条对照如下（原因均为"发布现在必须经同源权威写社区 store"，与断言强弱无关）：

| 文件 | 改前 | 改后 | 为什么不是放宽 |
| --- | --- | --- | --- |
| `tests/unit/community-moderation-events-fail-closed.test.mjs`（G6c） | `makeServiceHarness({executionMode:'stub', ports:{tms:passingPort()}})`（默认脱离社区存储的替身权威） | 同一调用加 `store`/`authors`/`authority: createCommunityContentAuthority({store,authors})` | 断言集完全未变；只把"stub 能通过"的对照装置换成与 `app.ts` 一致的同源权威（否则发布无处可写，属装置问题而非判定问题） |
| `tests/unit/community-moderation-takedown.test.mjs`（G4b） | 一套装配（替身权威）里先发布再下架 | 先用同源装配发布（`h`），再用**共用同一份 store** 的替身副本装配（`detached`）下架；断言全部落在 `detached` | 负控制要证明的是"下架只作用于权威端口指向的那份数据"；断言逐条保留（含 `authority_origin === 'substitute'`），并**新增**一条前提断言 `detached.store === h.store` |
| `tests/unit/community-moderation-fixtures.mjs` | `observeLink` 记录 `screen/withdraw/readView/conclusionFor`；两个替身包装透传 `withdraw/readView/...` | 增加 `publish` 记录与透传 | 只增加观测/透传通道，不改任何既有断言 |
| `tests/unit/community-moderation-takedown.test.mjs`（`unreadableWithdrawPort`） | 手写端口对象含 5 个方法 | 补 `publish: (input) => moderation.publish(input)` | 同上（端口形状必须与产品接口一致，否则装配即失败） |

## 6 门禁读数（逐条）

树：`.pg17\wt-i14-gate`，HEAD `92feada`（本页所在提交为其后的文档提交），基线 `upstream/main = 8cc9dd8`。

| # | 命令 | 读数 |
| --- | --- | --- |
| 1 | `git status --porcelain` | 提交 #2 后 **0 行**（本页与交接为随后单独提交） |
| 2a | `node --test tests/moderation`（派单字面命令） | **不可用**：`Error: Cannot find module '…\tests\moderation'`，`ℹ tests 1 / fail 1`；**基线树同命令同样失败**（Node 24 不把裸目录当 glob），属环境限制、不是本片引入 |
| 2b | `node --test "tests/moderation/*.test.mjs"` | **306 tests / 306 pass / 0 fail / 0 skipped**（基线 302 + 本片新增 4 条），duration_ms=1710.98 |
| 2c | `node --test "tests/unit/community-*.test.mjs"` | **109 tests / 109 pass / 0 fail / 0 skipped**，duration_ms=3340.66（基线 101 + 本片新增 8 条） |
| 3 | `node --test "tests/unit/*.test.mjs"`（默认隔离） | 修复树 **1625 tests / 1624 pass / 0 fail / 1 skipped**，duration_ms=105429.44；**同 SHA 干净基线**（`.pg17\wt-i14-base`，`8cc9dd8`）**1617 / 1616 / 0 / 1**，duration_ms=100171.48。差值 = 新增 8 条；失败集同为**空**（`--test-isolation=none` 按要求未使用） |
| 4 | `node tools/verify-contract-status.mjs` | `PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；形状错误 0 项；语义错误 0 项`；`PASS: 语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段`；`PASS: 中文表格一致`；`PASS: 状态为人工判定…`，exit=0 |
| 4 | `node tools/verify-contract-status.mjs --runtime` | 同上 4 行 + `PASS: 无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致（不监听 / 不请求服务）`，exit=0 |
| 5 | `python -B tools/validate_development_docs.py` | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables`，exit=0（Python 3.14.3） |
| 6 | `git diff upstream/main --check` | 无输出，exit=0 |
| 7 | `tests/integration/community-*.mjs` | **本仓不存在该文件集**（`tests/integration/` 下 0 命中 `community*`），**本项无对象可跑**；未启动或连接任何 PG 实例（本机有残留 postgres 进程但未取得该集群的连接参数/凭据，未执行任何 PG 用例）。如实登记，不冒充通过。 |
| 附 | `npm run typecheck --workspace @gengyun/api` | `tsc -p tsconfig.json --noEmit` 无输出，exit=0（超出七项门禁的额外自查） |

## 7 未做 / 边界（交接同步登记）

1. **评论路径未接发布闸门**：`createComment`（`services/api/src/community/service.ts:1160-1161`）与 `editComment`（`:1230-1231`）仍由社区直接写 `published/approved`。本片按派单只接发帖与编辑（派单引用的改前行号为 `:863-864`／`:954-955`，改动后位置见 §2）。
2. **下架事件的 revision 口径差 1**（诊断 3-5，P2）：`services/api/src/app.ts:556-593` 用**处置前**版本调 `withdraw`，而 `hidePost` 已把 revision +1。本片为让它继续幂等，只对"**会真正改变**行/声明"的写做版本核对，纯 no-op 声明（可见性已是目标值、派生已发布版本已等于声明值）放行；未改该口径。
3. **`invalidated_cache_keys` 恒空**（3-4）、**下架事件无订阅者**（3-5）、**版本变化不触发重评**（4-3）、**`assertSourceUnchanged` 死代码 + `moderation-authority.ts` 的 `source_kind:'database'` 硬编码**（2-3）、**合成预测可进评估计分**（4-5）、**台账仅内存**（3-6）、**`nonbypass.ts:163` 三元同分支**、**`nonbypass.ts:151` 死代码**、**`admin`/`human-review` 无 HTTP 消费者**、**`docs/moderation/http-layer.md:204` 过期**：均为 P2/后续项，本片未动。
4. **无真实供应商**：全部模型端口为合成替身；本页不证明真实 AI 能力，也不证明 AC08 的人工审核入口可用。
5. 未 push、未开 PR、未评论、未改 `packages/contracts/**`、未改 `docs/architecture/contract-status.json`、未动迁移与 `miniprogram/**`、未新增依赖。

## 8 复现命令

```powershell
# 1) 两处缺陷的改前/改后探针（工作区外脚本，两个 worktree 各跑一次）
node E:\GengYunCommander\.pg17\tmp\probe-i14-revision-gate.mjs   E:\GengYunCommander\.pg17\wt-i14-base
node E:\GengYunCommander\.pg17\tmp\probe-i14-revision-gate.mjs   E:\GengYunCommander\.pg17\wt-i14-gate
node E:\GengYunCommander\.pg17\tmp\probe-i14-gate-wiring.mjs     E:\GengYunCommander\.pg17\wt-i14-base
node E:\GengYunCommander\.pg17\tmp\probe-i14-gate-wiring.mjs     E:\GengYunCommander\.pg17\wt-i14-gate

# 2) 新增回归
node --test tests/moderation/publish-revision-guard.test.mjs
node --test tests/unit/community-moderation-revision-guard.test.mjs
node --test tests/unit/community-moderation-gate-wiring.test.mjs

# 3) 门禁（见 §6）
node --test "tests/moderation/*.test.mjs"
node --test "tests/unit/community-*.test.mjs"
node --test "tests/unit/*.test.mjs"
node tools/verify-contract-status.mjs; node tools/verify-contract-status.mjs --runtime
python -B tools/validate_development_docs.py
git diff upstream/main --check
```
