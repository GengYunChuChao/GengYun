# gy-r90-i14：社区 takedown 事件的**正向**订阅单测（隐藏成功 ⇒ 恰好一条 moderation 消息）

> **一句话结论**：`withTakedownObserver` 在「下架已生效」这一条路径上**确实**投递一次 takedown 事件，且仓内**唯一**投递实现 `createMessagesCommunityEventsPort` 会把它落成**恰好一条** `type='moderation'` 的消息，`event_key` 与 `target_ref.revision` 都取**处置前那一版**；重复投递被 `UNIQUE (owner_id, event_key)` 语义吸收（`created=false`、行数不变）；通知端口抛错时**不回滚**已生效的处置（fail-open 是纪律，不是缺陷）。本页只证这三件事，边界见 §6。

| 项 | 值 |
| --- | --- |
| 仓库 / 基线 | `GengYunChuChao/GengYun`，`origin/main` = `0221e69c13ff8b94907ac1a9839422506ef86e47`（本分支从该提交切出，未 rebase） |
| 切片档位 | **A 档**：只新增 `tests/unit/community-takedown-subscription.test.mjs` 与本页；**未改任何产品代码**（`git diff --stat origin/main` 只列这两个文件） |
| 取证方式 | 真 `createMessagesCommunityEventsPort` + 内存 messages 假端口（复刻唯一键语义，不恒 `return true`）+ 假 community store，包在真 `withTakedownObserver` 里跑；另做三条**变异自证**（改坏产品代码 ⇒ 用例必须变红，改完还原） |
| 机读钉子 | `tests/unit/community-takedown-subscription.test.mjs`（4 个 `test()`：①②③ + 匿名负控 ④） |
| 结论性质 | 人工判定。脚本与用例只证明「这条路径上的行为」，不证明真实消息送达、不证明 real 域装配完整（见 §6） |

## 1. 生产事实：谁发、谁收、键长什么样

| 事实 | 锚点（HEAD 实测） |
| --- | --- |
| 观察器只在 **CAS 成功 且 patch 与返回记录都是 `hidden`** 时进发事件分支 | `services/api/src/community/takedown.ts:82-83` |
| **先**调用 `store.commitPostIfCurrent`，**拿到返回之后**才发事件 —— 发事件不在事务里 | `services/api/src/community/takedown.ts:82`、`services/api/src/community/takedown.ts:88-93` |
| 事件体四个字段：`event:'takedown'`、`ownerId`、`target.revision = expected.revision`（处置前那版）、`reason` | `services/api/src/community/takedown.ts:88-93`、`services/api/src/community/takedown.ts:91` |
| 匿名（`author_id === null`）直接不发 | `services/api/src/community/takedown.ts:87` |
| `catch {}` 空实现：通知失败只如实标注未投递，**不回滚** | `services/api/src/community/takedown.ts:95-97`，纪律写在 `services/api/src/community/takedown.ts:21-22` |
| 去重键 `community:<event>:<type>:<id>:r<revision>`，takedown 再拼 `reason` 前 80 字 | `services/api/src/community/events.ts:112-118`（`services/api/src/community/events.ts:113` + `services/api/src/community/events.ts:117`） |
| takedown ⇒ `Message.type='moderation'` | `services/api/src/community/events.ts:136-140`（`services/api/src/community/events.ts:139`） |
| 唯一**投递实现**：`createMessagesCommunityEventsPort` → `messages.appendMessage({ owner_id, type, target_ref, event_key })` | `services/api/src/community/events.ts:164`、`services/api/src/community/events.ts:171-182` |
| 另一个实现是**不投递**的空端口，如实标 `wired:false` | `services/api/src/community/events.ts:143`（接口定义在 `services/api/src/community/events.ts:89`） |
| 装配点只有两处 | `services/api/src/app.ts:1217-1221`（选端口）、`services/api/src/app.ts:1336-1337`（包观察器） |

「唯一订阅者」的取证是仓库级 grep，不是本文件的断言：

- `git grep -n "'takedown'" -- services/api/src` 在 HEAD 上只命中两行 —— 类型联合成员 `services/api/src/community/events.ts:53` 与唯一发布点 `services/api/src/community/takedown.ts:89`；
- `CommunityEventsPort` 的生产实现只有 `services/api/src/community/events.ts:143`（空端口）与 `services/api/src/community/events.ts:164`（消息域端口）。

## 2. 本文证明什么（三条断言 + 一匿名负控）

三条断言全部落在同一文件，且**期望值硬编码**（不调用 `communityEventKey` / `communityEventMessageType` 反推期望值——否则就是「用实现证明实现」，实现改坏、两边一起改坏也照样绿）。

| # | 断言 | 用例锚点 | 断言行 |
| --- | --- | --- | --- |
| ① | 隐藏成功 ⇒ `appendMessage` **恰好 1 次**、**恰好 1 行**；投递入参逐字等于 `{owner_id, type:'moderation', target_ref:{type:'post',id,revision:1}, event_key:'community:takedown:post:post-i14-0001:r1:admin_hide'}` | `tests/unit/community-takedown-subscription.test.mjs:182` | `tests/unit/community-takedown-subscription.test.mjs:201`、`tests/unit/community-takedown-subscription.test.mjs:202`、`tests/unit/community-takedown-subscription.test.mjs:208` |
| ① 续 | `target_ref.revision` 是**处置前**那一版（1），不是隐藏后的 `record.revision`（2） | 同上 | `tests/unit/community-takedown-subscription.test.mjs:218-222` |
| ② | 同一事件重投两次 ⇒ 两次都 `created === false`、仍 `delivered === true`、行数仍 1、键未变；同一 `expected` 再提交 ⇒ `REVISION_CHANGED` 且不再发事件 | `tests/unit/community-takedown-subscription.test.mjs:225` | `tests/unit/community-takedown-subscription.test.mjs:240-248`、`tests/unit/community-takedown-subscription.test.mjs:258-265` |
| ③ | 事件端口抛错 ⇒ `commitPostIfCurrent` 仍 `ok:true`、返回记录与 store 记录都仍 `hidden`、revision 已 +1（CAS 真落库了，不是「其实没写」） | `tests/unit/community-takedown-subscription.test.mjs:268` | `tests/unit/community-takedown-subscription.test.mjs:287-295` |
| ④ | 匿名（`author_id === null`）⇒ 处置照常生效、`appendMessage` 0 次、0 行 | `tests/unit/community-takedown-subscription.test.mjs:298` | `tests/unit/community-takedown-subscription.test.mjs:316-317` |

① 的两个细节值得点明，它们是本切片最容易「假绿」的地方：

1. **`revision` 取处置前那一版**。CAS 成功会把 revision 推到 2（`tests/unit/community-takedown-subscription.test.mjs:195-199` 先把这件事钉成前置），所以「把 `services/api/src/community/takedown.ts:91` 的 `expected.revision` 换成 `result.record.revision`」这条变异一定能被 ① 抓住（见 §3-B）。
2. **消息域的「去重」是「已存在」而不是「失败」**。真 `appendMessage` 命中唯一键就返回 `{created:false, message: existing}`（`services/api/src/messages/service.ts:424-425`），所以 ② 同时钉 `created:false` 与 `delivered:true`：把去重写成「静默丢弃 / 返回失败」都会被咬。

## 3. 变异自证（改坏产品代码 ⇒ 用例必须红；测完逐条还原）

变异前基线：`node --test tests/unit/community-takedown-subscription.test.mjs` ⇒ 4 pass / 0 fail（EXIT=0）。每条变异后都 `git checkout -- services/api/src/community/takedown.ts` 还原，`git status --porcelain` 只剩未跟踪的新用例文件。

| 变异 | 改动 | 期望变红 | 实测 |
| --- | --- | --- | --- |
| A | 删掉 `services/api/src/community/takedown.ts:88-93` 这 6 行发布块（保留外层 `if`） | ①②（③ 的前置也会红） | ①②③ 全红，EXIT=1 |
| B | `services/api/src/community/takedown.ts:91` 的 `revision: expected.revision` → `revision: result.record.revision` | ①（键换了，② 也红） | ①② 红，EXIT=1 |
| C | `services/api/src/community/takedown.ts:95-97` 的空 `catch` → `catch (error) { throw error; }` | ③ | ③ 红，EXIT=1 |

红原文（`node --test` 输出摘录，只留断言名与断言行）：

- 变异 A：
  - ① `AssertionError: 下架成功必须**恰好**投递 1 次，实际 0 次` —— `0 !== 1`，`tests/unit/community-takedown-subscription.test.mjs:201`
  - ② `AssertionError: 首次必须落 1 行（前置条件）` —— `0 !== 1`，`tests/unit/community-takedown-subscription.test.mjs:234`
  - ③ `AssertionError: 前置：观察器确实调用了会抛错的端口（不是「压根没走到」）` —— `0 !== 1`，`tests/unit/community-takedown-subscription.test.mjs:287`
- 变异 B：
  - ① `AssertionError: 投递入参必须逐字相等（事件端口只许传 owner_id / type / target_ref / event_key 四个字段）` —— `tests/unit/community-takedown-subscription.test.mjs:208`
  - ② `AssertionError: 重投不得换键：换键会让真库的 UNIQUE (owner_id, event_key) 也拦不住第二条` —— `tests/unit/community-takedown-subscription.test.mjs:244`
- 变异 C：
  - ③ `Error: EVENT_PORT_UNAVAILABLE`（抛出点 `tests/unit/community-takedown-subscription.test.mjs:275`，冒泡出 `commitPostIfCurrent` 调用处 `tests/unit/community-takedown-subscription.test.mjs:280`）——「不吞异常」立刻把 fail-open 破坏掉，所以 ③ 红。

## 4. 闸门读数（HEAD 实测，逐条 EXIT）

| 命令 | EXIT | 关键尾行 |
| --- | --- | --- |
| `node --test tests/unit/community-takedown-subscription.test.mjs` | 0 | `pass 4 / fail 0` |
| `node --test tests/unit/community-notify-dedupe-pins.test.mjs tests/unit/community-message-notifications.test.mjs` | 0 | `pass 10 / fail 0` |
| `npm run test:unit`（全量） | 0 | `tests 6782 / pass 6779 / fail 0 / skipped 3` |
| `npm run lint` | 0 | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）` |
| `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | 0 | `PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红）`；`SYMBOL-COVERAGE-VERIFICATION: 可判 977 条——OK 933、符号不在区间 44`（后两格为 WARN，原本就不判红） |
| `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | 0 | `tests 37 / pass 36 / fail 0 / skipped 1`（本机约 299s；其中一个 skip 是设计内跳过） |
| `node tools/verify-contract-status.mjs` | 0 | `PASS: 行号区间 324 条…` / `PASS: 中文表格一致` |
| `npm run test:docs` | 0 | `PASS: 识别 5 页 / 跳过 352 页（扫描面 357 页：docs/verification）`（本页加入后扫描面从 356 涨到 357；本页没写 failmatrix 读数，按规则跳过） |
| `node tools/verify-g-drill-readings.mjs --check` | 0 | `✓ 八条判据全过：workflows 15 / jobs 29 / 演练 21 条 / 测试文件 603（glob 合计 573）` |
| `git merge-tree --write-tree --name-only origin/main HEAD` | 0 | 输出只有一行树对象、`--name-only` 未列出任何文件名（无冲突）；本页不记树哈希——那是提交自身的内容哈希，改一个字就变，记了也没法复现 |

读数口径备注（不写会误导人）：

- `npm run lint` 是在「worktree 里没有 `node_modules`」的前提下跑通的：为跑静态检查，把主检出的 `node_modules` 以**只读目录联接**挂进本 worktree（`npm install` 未在本 worktree 执行）。tsc 检查的是本 worktree 的源码（`services/api/src/**`、`apps/admin/**`，均未改动），因此读数有效，但「依赖是复用主检出的」这件事必须写明。
- 变异自证期间跑的是单文件用例；全量单测在一次完整的、无变异的树上跑（见上表）。

## 5. 两处判断的依据行号（供审查者复核）

1. **「匿名不发」**：产品代码的判据是 `if (result.record.author_id !== null)`（`services/api/src/community/takedown.ts:87`），注释给的语义是「迁移 0030：已注销内容（`author_id = NULL`）没有可通知的账户主体」（`services/api/src/community/takedown.ts:85`）。所以 ④ 钉的是「跳过投递」，**不是**「投递失败」。
2. **「去重语义」**：真库唯一约束是 `CONSTRAINT messages_owner_event_key UNIQUE (owner_id, event_key)`（`services/api/db/migrations/0019_messages_persistence.sql:68`，注释在 `services/api/db/migrations/0019_messages_persistence.sql:67`），应用层对应 `services/api/src/messages/service.ts:424-425`（命中已有行 ⇒ `{created:false, message: existing}`）。内存假端口按 `(owner_id, event_key)` 建 `Map` 复刻同一语义，**不**直接 `return true`——否则 ② 会退化成「假端口说自己去了重」。

## 6. 不声称清单（明确边界）

- **不声称** real 域的下架缓存失效钩子已接。real 分支不挂 `withModerationTakedownLink` 是既有裁定：`services/api/src/app.ts:1481-1483`（「real 未注入审核权威时，替身权威对未登记目标 `setVisibility` 会抛 `OBJECT_UNAVAILABLE`，把一次**已生效**的社区下架折成 503」）。本切片没有、也不该改这条。
- **不声称**把通知改成事务性 outbox。本切片只加用例；生产仍是「先提交、后通知、失败吞掉」（`services/api/src/community/takedown.ts:82-97`），事件与 CAS 不同事务这件事**没变**。
- **不声称** real 模式整体装配了 takedown 事件：`services/api/src/app.ts:1217-1221` 在 `messagesService === null` 时选的是空端口（`services/api/src/community/events.ts:143`）。
- **不声称**消息真的送达用户（无推送、无已读回执）；只证明「落了一行 moderation 消息」。
- **不声称** `communityEventKey` 覆盖所有 reason 形态；用例只覆盖 `admin_hide`（短 reason，不触发 80 字截断）。
- **不声称**匿名内容的账号侧语义完整；只证明观察器在 `services/api/src/community/takedown.ts:87` 跳过 `NULL`。

## 7. 未确认清单

- 真库上的 `messages_owner_event_key` 冲突路径（并发双写后回读）由 `services/api/src/messages/service.ts:436-443` 兜底，本切片用内存假端口复刻的是**顺序**语义，未压并发。
- 本页读数为本机一次实测（Windows / Node 24），未在 CI 复跑；`npm run test:unit` 的 skip 数随环境变化，读数以 §4 尾行为准。
