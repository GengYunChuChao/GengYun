# R59 · 社区通知去重取证：一次审核动作产生几条消息（2026-10-26）

> **一句话结论**：缺陷报告描述的「驳回 ⇒ 两条通知」在当前 main **不可复现**——驳回动作没有 HTTP 路由，也从不投递通知；真实可复现的是「下架 ⇒ 同一帖同一版两条通知」，因为下架观察器只套在后台端口上，而驳回路径连触发装配都没有。那两条的构成是「发布时的审核通过」＋「后台下架的 takedown」，两条都钉在该帖的 `revision=1` 上（§2 用一条键串演示）。

| 项 | 值 |
| --- | --- |
| 仓库 / 基线 | `GengYunChuChao/GengYun` · `origin/main` = `31291afb`（派单原写的 `a96899f8` 已前进两个 commit） |
| 切片档位 | A 档：只新增本页，不改代码、契约、迁移、索引、台账 |
| 取证方式 | 只读：`git grep -n` 定位 + 逐行读源。未开服务、未跑测试、未连真库 |
| 机读钉子 | `tests/unit/community-premoderation-invariants.test.mjs:234-246`（契约 `/admin/posts` 只有 hide）、`tests/integration/admin-community-posts-pg.mjs:988-993`（库内该帖恰好两条） |
| 结论性质 | 「当前 main 的行为」＝已证；「缺陷报告当初的真实触发场景」＝未证（§5 第 1 条） |
| 跨 SHA 有效性 | §6 那条 `git diff --stat` 覆盖的全部文件在 `a96899f8` 与 `31291afb` 之间输出为空 ⇒ 行号逐字相同 |

## 1. 现状四档

### 1.1 已实现（去重机制本身是有的）

| 功能点 | 关键行号 | 说明 |
| --- | --- | --- |
| 事件去重键的唯一构造点 | `services/api/src/community/events.ts:112-118` | 形状固定为 `community:` + 事件名 + 目标类型 + 目标 id + `:r` + 版本，再按事件身份追加后缀 |
| 消息层同键幂等（库） | `services/api/db/migrations/0019_messages_persistence.sql:67-68` | `UNIQUE (owner_id, event_key)`：同键第二次投递在库层就是冲突 |
| 消息层同键幂等（应用） | `services/api/src/messages/service.ts:422-444` | 先按事件键回读，插入撞键后再回读一次 ⇒ 不产生第二条 |
| 消息层同键幂等（PG 写口） | `services/api/src/messages/store-pg.ts:246-264` | `ON CONFLICT DO NOTHING … RETURNING id`，0 行即 `duplicate` |
| 消息层同键幂等（内存写口） | `services/api/src/messages/store.ts:284` | 同 id 或同事件键一律返回 `duplicate`，不覆盖既有行 |
| 下架观察器 | `services/api/src/community/takedown.ts:58-95` | 只包 `commitPostIfCurrent`；仅当 visibility 真变 hidden 且作者非空时投递一条 takedown |
| 后台下架写路径幂等 | `services/api/src/admin/ops/community-posts.ts:48-54` | revision 不符 ⇒ `REVISION_CONFLICT`；已 hidden ⇒ `changed:false`，不重复迁版 |

### 1.2 部分落地（机制在，缺口明确）

| 功能点 | 关键行号 | 说明 |
| --- | --- | --- |
| 观察器只挂在后台端口 | `services/api/src/app.ts:1276-1277` | `communityPostPortForAdmin = adminInjection?.communityStore ?? withTakedownObserver(communityStore, …)`；社区服务拿到的是未包装的 `communityStore`（`services/api/src/app.ts:862-869`、`services/api/src/app.ts:1257-1271`） |
| 审核域自己的下架不发通知 | `services/api/src/community/moderation-authority.ts:122-138` | 注释原文「审核域**不推进**社区 revision」；`patch` 只带 `visibility`，CAS 的 moderation 参数传 `null` ⇒ 不写结论行、不投事件 |
| 审核域只在非 real 接上社区库 | `services/api/src/app.ts:884-888` | 仅当 `config.executionMode !== 'real'` 才注入 `communityContentAuthority`；real 走默认替身端口 `services/api/src/moderation/service.ts:511` |
| 投递同步、fail-open、无 outbox | `docs/verification/gy-i17-closeout-20261023.md:254` | 既有登记：失败只留 `delivered:false`，不重试；投递失败不回滚内容（`services/api/src/community/service.ts:714-718`） |
| 通知不带「来源」 | `services/api/src/community/events.ts:43-78` | 事件联合类型没有 `source` 字段；takedown 与 moderation_result 在消息层都投影成 `type='moderation'`（`services/api/src/community/events.ts:136-140`） |

### 1.3 未实现（缺陷报告假设它已经存在的东西）

| 功能点 | 关键行号 | 说明 |
| --- | --- | --- |
| 驳回的 HTTP 路由 | `services/api/src/community/service.ts:1735` | `reReviewContent` 在 `services/api/src` 内只被定义、未被任何路由注册；全仓非 docs 命中都在测试 |
| 写 `audit_state='rejected'` 的落点 | `services/api/src/community/service.ts:1774-1781` | 唯一**落库**写入口：`services/api/src/community/service.ts:1790-1798` 才提交；读面报 `rejected` 走实时投影、不落库也不发通知（`services/api/src/community/service.ts:583-616`） |
| 驳回时的通知 | `services/api/src/community/service.ts:696-699` | 注释原文「被拒的写入请求**不投递**：那条 revision 从未落库」 |
| 驳回时连内容都不写 | `services/api/src/community/moderation-link.ts:37` | 表格行原文：驳回 `vetoed` ⇒ **不落库**（400）+ 读取面退出公开面 |
| 后台的通过 / 驳回动作 | `services/api/src/admin/ops/service.ts:211-224` | 12 项 operationId 闭集里与帖相关的只有 `hidePost`，位置在 `services/api/src/admin/ops/service.ts:221` |
| 契约里的审核动作 | `packages/contracts/openapi.json:11008` | spec 里 `/admin/posts` 家族恰好一条 `/admin/posts/{id}/hide` |
| 同上（被测试钉死） | `tests/unit/community-premoderation-invariants.test.mjs:234-246` | `assert.deepEqual` 直接比对 `['/admin/posts/{id}/hide']` |
| `notifications` 表 / outbox 表 | `services/api/db/migrations/0016_account_deletion_persistence.sql:36` | 仓库自陈「main 上既无 outbox 表也无消费者，建表就是空承诺」 |
| docs 侧的既有记录 | `docs/verification/gy-i15-community-http-20261020.md:247` | 该行记录的是「读取时重查负例·用例 6」（删除后 `reReviewContent` 返回 `re_reviewed:false / visibility:'deleted'`，**不复活**）——属于「读取时重查」的行为用例之一。**路由层零调用**：`git grep -n reReviewContent -- services/api/src` 只有定义 `services/api/src/community/service.ts:1735`，没有任何调用点 |

### 1.4 需迁移（要动库才能落的方向）

| 功能点 | 关键行号 | 说明 |
| --- | --- | --- |
| 库级 `(post_id, kind)` 唯一键 | `services/api/db/migrations/0019_messages_persistence.sql:55` | `messages.target_ref` 是 `jsonb`：要唯一必须先加生成列、再加唯一索引、并在部署期补列级授权；且要先回填库内既有 approved+hidden 双行（§4 的否决理由） |
| 结论行留历史 | `services/api/src/community/store-pg.ts:313-328` | 写口是 `ON CONFLICT (target_type, target_id, target_revision) DO UPDATE`：同版重审是**覆盖写**，库里只留最后一版结论 |
| outbox + dispatcher | `docs/verification/gy-i17-closeout-20261023.md:254` | 契约要求「outbox 与业务更新同事务」；main 既无表也无消费者 |

## 2. 结构性根因：内容域按 revision 分桶，通知域按事件种类分桶

| 域 | 桶键 | 落点 |
| --- | --- | --- |
| 内容域：审核结论 | `(target_type, target_id, target_revision)` 主键 | 建表见 `services/api/db/migrations/0022_community_persistence.sql:158-172`；写入是覆盖写 `services/api/src/community/store-pg.ts:319` |
| 通知域：消息 | `(owner_id, event_key)` 唯一 | `services/api/db/migrations/0019_messages_persistence.sql:67-68` |
| 通知域的键形状 | `community:` + 事件名 + 目标类型 + 目标 id + `:r` + 版本 + 可选后缀 | `services/api/src/community/events.ts:112-118` |

一条具体键串。帖 `P` 发布时审核通过，随后被后台下架：

1. 发布落库后投递审核结果：`services/api/src/community/service.ts:1097` 传 `{ revision: 1 }` 与 `outcome.decision`（本例为 `approved`），键头由 `services/api/src/community/events.ts:113` 拼出、后缀由 `services/api/src/community/events.ts:114` 追加 ⇒ `community:moderation_result:post:P:r1:approved`。
2. 后台下架：内容行 `revision` 由 1 迁到 2（`services/api/src/admin/ops/community-posts.ts:56-61`），但观察器投递的 takedown 事件取 `expected.revision`，即**处置前**那一版（`services/api/src/community/takedown.ts:82-88`，理由写在 `services/api/src/community/takedown.ts:42-56`）⇒ 键头仍是 `r1`、后缀是 reason ⇒ `community:takedown:post:P:r1:admin_hide`。
3. 两个键形状合法、彼此不重复，库层唯一键按 `(owner_id, event_key)` 判定 ⇒ 两行都留下。真库测试把这句写成了期望：`tests/integration/admin-community-posts-pg.mjs:988-993`（两条、都是 moderation、都指向下架前那一版），同帖未读数在下架后只 +1（`tests/integration/admin-community-posts-pg.mjs:971-973`）。

于是两个域的语义就分叉了：内容域的桶是「一版一结论」（同版重审覆盖写，`services/api/src/community/store-pg.ts:319`）；通知域的桶是「一版多事件」（同版每个事件种类各占一行，`services/api/src/community/events.ts:112-118`）。**两套桶键互不约束**——缺的不是去重能力，而是「这次事件属于同一次审核动作」的归属字段：`CommunityEvent` 里没有 source（`services/api/src/community/events.ts:43-78`），所以通知层无法把同一次动作派生出的两种事件合并。

## 3. 两件必须分开说的事

### 3.1 「下架审计不落库」是全模式事实

- 审计台账是进程内数组：`services/api/src/admin/audit.ts:80-82`（注释原文「内存审计日志。进程内实现，**非**真实 PG 接线。」）。
- 管理端 runtime 恒为 `persistent: false`：`services/api/src/admin/runtime.ts:77-84`。
- 全仓没有 PG 版管理端 store：`git grep -n "createPostgresAdminOpsStore"` 命中 0。
- 迁移里没有 `post.hide` 的落点：`git grep -n "post\.hide" -- services/api/db/migrations` 命中 **0**。应用侧只有 1 处：`services/api/src/admin/ops/service.ts:1153`（写内存 ops store）。该字符串在 `tests/**`、`docs/**`、`apps/admin/**` 也有出现（测试与文档的引用、后台端展示文案）；**本页未读 `apps/**`，故不复述其内容**。
- 迁移自己登记了这件事：`services/api/db/migrations/0036_r34_admin_content_persistence.sql:69-74`（真库臂里审计仍落在 `createAuditLog()` 进程内台账上，证据页如实写「审计落库未接」）。

⇒ 这条与执行模式无关：不接池不落库，接了池也不落库（没有 PG 实现、没有迁移落点）。

### 3.2 「库里查不到两条通知」只在 real + 无池成立

- real 且无池 ⇒ `messagesService` 为 `null`：`services/api/src/app.ts:843-857`。
- `messagesService === null` ⇒ 事件端口换成未接线端口（`services/api/src/app.ts:1157-1161`），`publish` 恒返回失败（`services/api/src/community/events.ts:143-153`）。
- 同一条件下社区存储退化成内存实现（`services/api/src/app.ts:862-869`）⇒ `communityRealUnwired` 为真 ⇒ 社区服务整个置 `null`（`services/api/src/app.ts:1249`、`services/api/src/app.ts:1251-1255`），社区域路由一律 503。
- 反过来：非 real，或 real + 有池，消息存储与事件端口都是接上的（`services/api/src/app.ts:833-838`、`services/api/src/app.ts:1157-1161`），两条通知照常落库。

⇒ 「查不到两条通知」是**部署形态**的读数，不是去重逻辑的读数，不能拿它当「缺陷不存在」的证据。

## 4. 指挥官裁定

> 去重方向取「事件带 source + 通知层按 (post, revision, source) 合并」，**不取**库级 `(post_id,kind)` 唯一索引方案（那要先回填库内既有 approved+hidden 双行，且 `messages.target_ref` 是 jsonb，加唯一索引要动生成列与部署期列级授权）。理由是：合并语义解决的是「同一次审核动作产生多条通知」，属于事件层归属问题；库级唯一键解决的是「同一帖同一类事件只能有一行」，会把 `moderation_result` 与 `takedown` 这两个语义不同的事件强行压成一行，丢掉 `reference_state` 之外的区分度。

该方向属 **B 档**（要改 `services/api/src`），由监工批复。本页只记录裁定与证据，不实施。

## 5. 未确认清单（取证报告第 4 节的 7 条，如实转录）

1. 缺陷现象的真实来源无法证明：本机没有运行环境、没有真 PG、没有线上日志，只能证明当前 main 不会产生「驳回 + 下架」双条。
2. 前端呈现未核：没有读 `apps/**` 的消息中心渲染，无法断言 UI 是两条卡片还是被折叠；`apps/admin/**` 只核到文档登记。
3. `reReviewContent` 的预期调用方与所属 issue 未查；「当前无路由」是确凿的（§1.3 已复核）。
4. `awaitingPublish` 在真实部署里的取值未确认（依赖 gate / link 的装配）。
5. 消息 `type='moderation'` 是否足够区分通过、驳回、下架未确认：消息没有正文、没有 decision 字段（`services/api/src/messages/types.ts:66-76`）。
6. `deploy/postgres-cvm/sql/*` 的列级权限影响未逐行核对。
7. `community_moderation_decisions` 的写入是否 UPSERT 未核对。

本页对第 3、7 条的复核结果：
- 第 3 条：`reReviewContent` 在 `services/api/src` 内只有定义（`services/api/src/community/service.ts:1735`），没有任何路由注册它 ⇒ 维持「无 HTTP 路由」。
- 第 7 条：已核，是 UPSERT —— `services/api/src/community/store-pg.ts:319` 为 `ON CONFLICT (target_type, target_id, target_revision) DO UPDATE`，即同版覆盖写；该结论已并入 §2。

## 6. 与取证报告的差异（复核后更正）

| 报告原文 | 复核结果 |
| --- | --- |
| `0022` 的主键定位在 `0022:155-159+` | 实际建表在 `services/api/db/migrations/0022_community_persistence.sql:158-172`，主键约束在该区间末行 |
| 「全仓 `grep reject_reason` 命中 0」 | 不成立：药剂域有命中（`miniprogram/utils/reference.js:643` 等）。正确表述是「`services/api/db/migrations` 命中 0，且 `community_posts` 列清单无该列（`services/api/db/migrations/0022_community_persistence.sql:62-89`）」 |
| 「`services/api/src/admin/ops/store.ts:95-114` 是内存 Map 实现」 | 审计实现在 `services/api/src/admin/audit.ts:80-82`，是数组不是 Map；`store.ts` 只转发 `runtime.audit`。Map 指的是幂等台账 `services/api/src/admin/runtime.ts:78` |
| 「社区路由 17 条一律 503」 | `services/api/src/app.ts:1251-1255` 的日志原文写「16 条社区路由」，两者不一致；本页不复述具体条数 |

本页对跨 SHA 有效性的取证命令（输出为空即证明行号未漂移）：

```bash
git diff --stat a96899f8 31291afb -- \
  services/api/src/app.ts services/api/src/community services/api/src/moderation/service.ts \
  services/api/src/admin services/api/src/messages services/api/src/routes \
  services/api/db/migrations packages/contracts/openapi.json packages/contracts/operations.json \
  tests/unit/community-premoderation-invariants.test.mjs tests/integration/admin-community-posts-pg.mjs \
  docs/verification/gy-i17-closeout-20261023.md docs/verification/gy-i15-community-http-20261020.md
```

## 7. 复核命令

```bash
node tools/verify-contract-status.mjs
node tools/verify-doc-anchors.mjs --strict --scan docs
```

## 8. 本页不覆盖（明确边界）

- 不实施 B 档方案：事件 `source` 字段、通知层 `(post, revision, source)` 合并、库级唯一键，三者都不在本页落地（§4 已裁定方向与档位）。
- 不跑测试：本片是 docs-only 新增，`tests/**` 未改动；§1 引用的两条钉子用例是**既有**断言，本页只引用不重跑。
- 不连真库、不起服务、不看 UI：`apps/**` 一行未读，消息中心如何呈现两条通知不在本页结论内（§5 第 2 条）。
- 不改任何既有文件：索引、台账、契约、`docs/architecture/README.md` 均未触碰。
