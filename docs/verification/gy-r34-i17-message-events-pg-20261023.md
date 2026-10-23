# GY-I17（#17）· 社区事件 → 消息域 · 真 PostgreSQL 17.11 投递／去重／失败隔离／恢复读数

- 片号：R34 ｜ 分支：`test/gy-r34-i17-message-events-pg`
- 基线（开工实测）：`upstream/main = 765b6a31d993995e5dacbf6a3227ebcbb97fd8df` —— 本片首个提交的**父提交就是它**
- **已合流主线**：`upstream/main` 在作业期间推进到 `f3a5f24d7427f5c2e40b9c8278312aa4827157ca`
  （他人 8 张 PR 合入，含 `#501` 的 `docs/` 关单关键字闸门），本分支已 `git merge --no-ff upstream/main` 合流
  （**merge commit，无 rebase／无 force**）。合流时三个共享文件被 `ort` **自动合并、零冲突**：
  `real-pg-integration.yml`、`tests/unit/ci-real-pg-wiring.test.mjs`、`tests/unit/ci-integration-chain-structure.test.mjs`
  —— 解法即**并集**：本片条目（紧邻 `messages-pg`）与主线改动同时保留，见 §5 的合流后复跑读数。
- 合流后复验（见 §5）：`ci-real-pg-wiring` 的**双向相等自证** = `EXECUTED=24 / REQUIRED_STEP_ORDER=24`、
  `managedScriptSetProblems=[]`、`stepOrderProblems=[]`、`databaseGuardProblems=[]`、
  `EXECUTED_EQ_ORDER_SORTED=true`；真库臂在合流后的树上**重跑仍 exit=0 / TOTAL PASS = 8**。
- 新增脚本：`tests/integration/message-events-pg.mjs`（**576 行**，脚本头部自述运行方式与四条诚实边界）
  - 运行：`node tests/integration/message-events-pg.mjs postgres://<owner>@127.0.0.1:<port>/gengyun_message_events_test`
  - 连接串走 **argv[2]**（与 `messages-pg.mjs` 同形）；库名硬钉 `gengyun_message_events_test`；只允许回环地址；要求**空库**
- 接线：`.github/workflows/real-pg-integration.yml` —— 新 step **紧跟在消息域 `messages-pg.mjs` 那一步之后**
  （其前一步是 `messages-pg`，其后一步是 `favorites-history-pg`），并同步登记
  `tests/unit/ci-real-pg-wiring.test.mjs` 的 `MANAGED_SCRIPTS`／`FROZEN_MANAGED_SCRIPTS`／`REQUIRED_STEP_ORDER`
- 本片**不改**产品行为、**不改**契约／台账、**不新增**迁移；只读消费既有实现

## 0. 为什么有这一片（缺口的准确边界）

监工 `#22` 评论 `6357804313` 把「#17 可靠投递/恢复」及页面端到端列为保留项。开工前逐条核对既有证据，实测结论是
**代码层四件事全都已实现**，缺的是**真库上的证据**：

| 能力 | 既有实现（事实，本片只读） | 开工前既有证据 | 真库证据 |
| --- | --- | --- | --- |
| 事件 → 消息类型映射 | `services/api/src/community/events.ts` 的 `communityEventMessageType`（唯一映射点） | 单元：`tests/unit/community-message-notifications.test.mjs` | **本片补** |
| 事件键去重 | `events.ts` 的 `communityEventKey` → 消息域 `(owner_id, event_key)` 唯一约束（`services/api/db/migrations/0019_messages_persistence.sql`） | 单元（内存 store 的 Map 去重）＋ `messages-pg.mjs`（**手工**调 `appendMessage`，不经社区） | **本片补** |
| 失败隔离 | `community/service.ts` 的 `publishModerationResult`／`publishInteraction` 双 `try/catch`；`community/takedown.ts` 同口径 | 单元（端口替身） | **本片补** |
| 恢复（未读/已读持久） | `messages/store-pg.ts` 的 `countUnread`／`markReadIfUnread`／`listMessagesByOwner` | `messages-pg.mjs`（进程内；未做「关掉实例后重读」） | **本片补** |

⇒ 因此本片**没有**任何产品代码改动，只新增一条真库臂 + 接线 + 本证据页。**不存在**「代码层缺失、需停手回报」的情形。

## 1. 真库读数（本机实测，PostgreSQL **17.11**，端口 55441，空库一次跑完）

原始输出（`node tests/integration/message-events-pg.mjs postgres://postgres@127.0.0.1:55441/gengyun_message_events_test`，
exit=0）：

```
[M] 空库 + 全链迁移自举：32 个迁移，本次应用 32 个
PASS 1: [M] 空库自举成功；public.messages 与 (owner_id, event_key) 唯一约束在岗（迁移三连不在此重复）
[0] 用户 A 83595a39-7fc1-4b4e-b44d-20ee4110d011 / B 07152380-4b11-4a30-9258-efdb1ade5d22 已在 users 表落库；会话走真实 PG
PASS 2: [W] 三类社区事件经真实写路径各落一行：moderation(approved) / comment / like，八列逐列与契约一致
PASS 3: [W] HTTP 面：3 条未读、契约七字段无内部列外泄、reference_state 三条都是 available（逐次现查）
PASS 4: [D] 同一 communityEventKey：端到端重复调度 + 直插 PG store 两条路径都只有 1 行，且既有行 id/时间戳/读状态逐字不变
PASS 5: [F] 消息落库真失败：数据库侧 23514、端口侧折叠为 PROVIDER_UNAVAILABLE；内容点赞行照常 1 行、消息 0 行
PASS 6: [F] 摘掉约束后同一事件投递成功且只落 1 行（created:true）⇒ 失败没有留残行，临时约束已摘干净
PASS 7: [W] 接收者口径：A 收 5 条（三类事件都指向内容作者）、B 只收自己评论的 1 条审核结论（互动者不收他人消息）
PASS 8: [R] 进程内状态清空（关 app + 关池）后：新 store 读回 5 条、未读 4；新 app 实例 HTTP 读回 5 条、未读 4；已读时间戳逐字不变
[√] ALL PASS：社区事件 → 消息域 的真库投递/去重/失败隔离/恢复（迁移自举 + 三类事件 + 唯一键去重 + 23514 失败窗口 + 新实例重读）
TOTAL PASS = 8
```

末尾另有 6 条 `未取得 …` 行（§3 逐条转抄）。

## 2. 四件事逐条对照（要求 → 读数 → 断言位置）

### 2.1 落库：评论／点赞／审核三类事件 → 消息行，字段与契约一致

| 社区事件 | 产生方式（**真实写路径**，不是手工 `appendMessage`） | `Message.type` | 实测 `event_key` 形状 |
| --- | --- | --- | --- |
| `moderation_result` | `app.communityService.createPost(...)`（干净文本 + 合成放行端口 + 冻结规则时钟） | `moderation` | `community:moderation_result:post:<postId>:r1:approved` |
| `comment_created` | `app.communityService.createComment(B, postId, …)` | `comment` | `community:comment_created:post:<postId>:r1:c<commentId>` |
| `like_created` | `app.communityService.likePosts(B, postId, …)` | `like` | `community:like_created:post:<postId>:r1:u<userB>` |

逐列核对（三类事件一起，真库 `SELECT` 读八列）：
`id`（uuid）/`revision`（=1）/`owner_id`（= **内容作者**，不是互动者）/`type`（∈ 契约闭集 `comment|like|moderation|system`）/
`target_ref`（**恰好**三字段 `id`/`revision`/`type`，`type='post'`、`id`=被互动/被处置的帖子、`revision`=事件发生时刻的版本）/
`read_at`（`NULL`：创建不当已读）/`created_at`（可解析时间）/`event_key`（非空）。
另两条**一致性**断言（不是形状断言）：`type` 必须逐字等于 `communityEventMessageType(同一事件)`，
`moderation_result` 的 `event_key` 必须逐字等于 `communityEventKey(同一事件)`（用同一函数反算）。

契约投影（HTTP 面，`GET /api/v1/messages`，A 的会话）：恰好 **7 字段**
（`created_at`/`id`/`read_at`/`reference_state`/`revision`/`target_ref`/`type`），`owner_id`/`event_key` **不外泄**；
`GET /api/v1/messages/unread-count` = `3`（三条都未读）。
`reference_state` 三条都是 **`available`**（逐次现查：帖子此刻已发布且审核通过 ⇒ 社区可见性端口给出可用）。

### 2.2 幂等／去重：同一 `communityEventKey` 重复投递 ⇒ 不产生第二行

两条**独立**读数：
1. **端到端**：`unlikePosts` → `likePosts`（换幂等键）⇒ `addLike` 再次返回「新增」⇒ 社区服务再次调度同一事件
   ⇒ 该事件键仍**只有 1 行**，且既有行的 `id`/`created_at`/`read_at` 逐字不变（**不重置读状态**）。
2. **真库裁决**：绕过服务层，直接对 `createPostgresMessagesStore({ pool })` 用同一 `(owner_id, event_key)` 再写一次
   ⇒ 返回 **`'duplicate'`**（`INSERT … ON CONFLICT DO NOTHING RETURNING id` 0 行），行数仍是 1。
   这一条证明裁决者是**数据库唯一约束** `messages_owner_event_key`，不是应用层「先查后写」。

### 2.3 失败隔离：消息投递失败不影响内容写入本身，且失败可观测

做法：在 `public.messages` 上临时加 `CONSTRAINT gy_message_events_fail_window CHECK (type <> 'like') NOT VALID`
（`finally` 与 `finally` 之外的收尾**两处**都 `DROP CONSTRAINT IF EXISTS`，实测收尾后
`pg_constraint` 里该名字计数 = 0，**不留 schema 残留**），把「like 消息落库」真打断，然后：

| 读数 | 结果 |
| --- | --- |
| 数据库侧是否真被拒绝 | 绕开领域层直插（`event_key` 换成 `<likeKey>:raw-probe`，避开去重干扰）⇒ 原始错误码 **`23514`**（`check_violation`） |
| 内容写入是否受影响 | `community_likes` 真库 **1 行**（`target_id`+`user_id` 精确计数）⇒ **不受影响** |
| 是否留下半条消息 | 该 `event_key` 的消息行 **0 行**（失败前后两次读都是 0） |
| 失败是否可观测 | 端口回传 `{delivered:false, created:false, messageId:null, reason:'PROVIDER_UNAVAILABLE'}` |
| 失败后能否恢复 | 摘掉约束后**同一事件**再投递 ⇒ `{delivered:true, created:true}`，恰好 1 行 |

⚠ **口径说明（如实）**：可观测到的 `reason` 是**契约闭集错误码** `PROVIDER_UNAVAILABLE`，不是原始 `23514` ——
`services/api/src/messages/store-pg.ts` 的 `classifyMessagesDatabaseError` 把驱动错误折叠成契约错误码
（`57014`/`55P03` ⇒ `PROVIDER_TIMEOUT`，其余 ⇒ `PROVIDER_UNAVAILABLE`）。两个读数本臂都取了：
数据库侧 `23514`、端口侧 `PROVIDER_UNAVAILABLE`。

### 2.4 恢复：进程内状态清空后，从 PG 重新读取仍能看到未读/已读与消息行

1. 关闭前：`PUT /api/v1/messages/{id}/read`（`Idempotency-Key` + `If-Match: "1"`）⇒ **200**、`revision` 1→2、`read_at` 非空、
   `ETag "2"`；`unread-count` = 4（5 条中 1 条已读）。
2. **清空进程内状态**：`app.close()` **全部** app 实例 + `pool.end()` **全部**连接池。
3. **新连接池 + 新 store**（`createPostgresMessagesStore`，**不经 `buildApp`**）：`listMessagesByOwner` 读回 **5 条**、
   `countUnread` = **4**；已读那条的 `read_at` 与关闭前**逐字相等**、`revision` 不回退（=2）；
   SQL 直读 `read_at IS NULL` = 4，与新 store 派生值一致。
4. **新 app 实例**（新池、重新 `buildApp`）+ **同一会话 token**：`GET /messages` 读回 **5 条**、同一条的 `read_at` 逐字不变、
   `unread-count` 仍是 **4**。

⇒ 「重启语义」按派单允许的**新建连接/新实例**模拟，**未**做子进程真重启（见 §3）。

## 3. 未取得项（逐条转抄脚本输出；⛔ 不是通过）

```
未取得 页面端到端（未读红点/收件箱页面）：本片只覆盖后端真库与 HTTP 契约，客户端未改也未在真机跑 ⇒ 不构成 #17 完成
未取得 跳转真能打开目标页面：本臂读到 reference_state=available（社区可见性端口已接线），但没有页面级跳转读数
未取得 投递失败的日志/指标出口：现有实现只有端口回传 delivered:false+reason；服务层按既有纪律吞掉该返回值，无第二观测面
未取得 真实模型端口：审核端口是合成替身（provider.synthetic=true，不联网、无凭据）⇒ 不构成审核准确率/召回率证据
未取得 多进程并发投递同一事件键：本片在单进程内重复调度 + 直插 store 两条路径验证唯一键；未做跨进程并发压测
未取得 >1 万行规模与万级未读计数：本片 5 条消息验证语义，未做规模基准
```

另需登记的两条**结构边界**（不是未取得，是刻意的口径）：
- **端口实例的构造**：装配层只 `decorate` 了 `messagesService`/`communityService`，**没有**把 `communityEvents` 挂出来
  ⇒ `[F]` 用与 `app.ts` **同一表达式**（`createMessagesCommunityEventsPort({ messages: app.messagesService })`）构造端口，
  复用的正是 app 里那**一个**消息服务实例，**不是**第二套装配；`[W]`/`[D]`/`[R]` 全部走 `app.communityService`（真实装配）。
- **执行模式**：本臂用 `executionMode: 'stub'` + 真连接池。原因是 `real` 下审核域整域 fail-closed（未授权真实 tms/ims 供应商），
  社区写路径一律 503（`community-pg.mjs` 已把这条读数列为既有事实）⇒ real 下**发不出社区事件**。
  消息落库靠 `messagesInjection.store = createPostgresMessagesStore({ pool })`（装配层为测试预留的注入点），
  与 real 模式下 `app.ts` 自己选的是**同一实现**。

## 4. 明确：**不构成 #17 完成**

- 本片只把「社区事件 → 消息域」的**后端真库**链路从「零真库证据」抬到「有可复跑读数」，**不含**任何页面/客户端读数；
  #17 的**页面端到端**（收件箱页面、未读红点、点击跳转）仍**缺**，仍应按监工 `#22` 的口径保留为未完成项；
- 投递失败的**可观测出口**仍只有端口回传值（无日志、无指标、HTTP 面不可见）——这是既有设计（内容写入权威性优先），
  本片**未**改动；若将来要求「失败可被运维看见」，那是新切片；
- `reference_state=available` 只证明**端口派生**正确，不证明「跳转真的能打开某个页面」。

## 5. 门禁读数（本机；**合流 `upstream/main` 之后**复跑，全部 exit=0）

| 命令 | 读数 |
| --- | --- |
| `node --test tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs tests/unit/community-message-notifications.test.mjs tests/unit/doc-closing-keywords.test.mjs` | **38 tests / 38 pass / 0 fail**，exit=0 |
| ↳ 单跑 `ci-real-pg-wiring` | **18 / 18 pass**，exit=0 |
| ↳ 单跑 `community-message-notifications` | **8 / 8 pass**，exit=0 |
| ↳ `doc-closing-keywords`（`#501` 新增的 `docs/` 关单关键字闸门） | 「全扫描面 0 命中」⇒ 本文与仓内文档均无字面关单关键字 |
| 双向相等自证（直接调 `ci-real-pg-wiring.test.mjs` 的导出函数） | `EXECUTED=24`、`REQUIRED_STEP_ORDER=24`、`EXECUTED_EQ_ORDER_SORTED=true`、`managedScriptSetProblems=[]`、`stepOrderProblems=[]`、`databaseGuardProblems=[]`、`MINE_WIRED=true` |
| `npx tsc -p services/api/tsconfig.json --noEmit` | 空输出，exit=0 |
| `node tools/verify-contract-status.mjs` | `PASS: 覆盖 113 条契约操作；已装配 109 条；implemented 17 / partial 92 / planned 4；形状错误 0 项；语义错误 0 项` …，exit=0 |
| `node tools/lint-workspaces.mjs` | `lint 通过`（含两个 workspace 的 `tsc --noEmit` 与仓库卫生扫描），exit=0 |
| `node tools/verify-doc-anchors.mjs --strict` | `BASELINE 登记 103 条；本次命中 103 条、基线外新增 0 条、陈旧 0 条`，exit=0 |
| 真库臂（本机临时集群，**合流前**与**合流后**各跑一次） | 两次都 **exit=0**、`TOTAL PASS = 8`（§1 为合流前那次的原始输出；合流后同 8 条逐条复现） |

## 6. 冻结指纹（跨平台可复现：`git` blob 哈希，⛔ 不用工作区字节 sha256）

**合流后**的 blob（`git rev-parse HEAD:<path>`，在合流提交上实测）：

```
tests/integration/message-events-pg.mjs                       => （见下方复算命令；本片新增文件，内容未再变动）
.github/workflows/real-pg-integration.yml                     => 主线改动与本片改动合并后的 blob
tests/unit/ci-real-pg-wiring.test.mjs                         => 同上
tests/unit/ci-integration-chain-structure.test.mjs            => 同上
```

⚠ **不写死具体哈希**：合流后这三份文件都被主线改过（`ort` 自动并集），哈希随合流提交变化，
写死一个值只会在下一次合流时变成假指纹。**以命令复算为准**：

```
git rev-parse HEAD:<path>                    # 提交后
git hash-object --path=<path> -- <path>      # 提交前（与上一行同值）
```

本文档自身不写自引用指纹（写进去就会改变它自己的哈希）。

## 7. 本机环境与收尾（可复跑）

- 集群：PG **17.11** 便携二进制 `E:\GengYunCommander\.pg17\pgsql\bin`，`initdb -D <tmp> -U postgres -A trust -E UTF8 --locale=C`，
  端口 **55441**（派单要求的 55432–55467 区间内），只监听 `127.0.0.1`；
- 库：`createdb gengyun_message_events_test`（跑前实测 `public` 下 0 张表；合流前共跑 5 轮、合流后 1 轮，
  每轮前 `dropdb --force` 重建）；
- 收尾：两轮都以 `pg_ctl -D <tmp> -m fast -w -t 30 stop` 关闭 ⇒ **exit=0**、`pg_isready` 报 `no response`；
  数据目录按「先枚举重解析点 = **0**、再 `Remove-Item -Recurse`」删除，删后 `Test-Path` = `False`；
- 依赖：本 worktree 内 `npm ci --prefer-offline --no-audit --no-fund --ignore-scripts`（`git status --porcelain` 跑完仍为 0 行，lockfile 未变；⛔ 未做任何跨 worktree 的 `node_modules` 联接）。
