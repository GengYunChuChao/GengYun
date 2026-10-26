# GY-R33 / I17（#17）关闭材料：应用内消息、未读状态与权限跳转

- 任务：GY-R33 写手分片（文档/取证档）——为 issue **#17**「[初版 GY-I17] 实现首版应用内消息、未读状态与权限跳转」出关闭材料。本页**纯文档**：不改代码、不改 `docs/architecture/contract-status.json`、不 push／不 merge／不 approve、不改 issue 状态。
- 分支：`docs/gy-r33-i17-closeout`（工作树 `E:\GengYunCommander\wt-r33-i17`），从 `upstream/main` 新建；基线＝`7dd3d699d71ce5ce69b5254ea8a3e54aed4f7f79`（`git -C E:\GengYunCommander\GengYun_Agent2 rev-parse upstream/main` 实测）。本页所有 `路径:行号` 都是该 SHA 上的**实读值**：工作树 `git status --porcelain` 为空 ⇒ 磁盘内容与 `upstream/main` 是同一棵树。
- 环境：Windows · node **v24.16.0** · npm **11.13.0**；本树自装依赖 `npm ci --prefer-offline --no-audit --no-fund --ignore-scripts`（`added 103 packages in 5s`，装完 `git status --porcelain` 仍为空 ⇒ lockfile 未变）。**本机无可用真 PostgreSQL**：`127.0.0.1:55727` 探测 `TcpTestSucceeded=False`，仅 `55715` 在听（属其它回合的集群，本片不借用）⇒ 本轮**未跑**真库臂，真库读数只能引既有证据页（§5-U5）。
- 本页性质：关闭材料（读数页）。只记录「已经取得什么读数、还差什么」，不替代监工的验收判定，也**不把任何未取得项写成已通过**。
- **身份归属边界**：本页引用的评论 `6333028693` 是 **`Sek1ro-oka` 于 2026-10-22 发布的「指挥裁定」**（`gh api` 实读 `user.login=Sek1ro-oka`、首行「指挥裁定（GY-I17，2026-10-22）」），属**指挥侧历史裁定/建议**；它**不能替代**用户最新「沿用完整验收、缺口未齐保持开放」的要求，也**不构成**任何「监工已改口径」的暗示。
- 与既有页面的关系：`#445` 的只读复盘（[gy-r31-i17-recon-20261022.md](gy-r31-i17-recon-20261022.md)）、G2 裁定（[gy-r31-i17-g2-ruling-20261022.md](gy-r31-i17-g2-ruling-20261022.md)）、G5（[gy-r31-i17-g5-20261022.md](gy-r31-i17-g5-20261022.md)）、G6／G7／G8（[gy-r31-i17-g678-20261022.md](gy-r31-i17-g678-20261022.md)）、真库注销臂（[gy-r31-i17-pg-arm-20261022.md](gy-r31-i17-pg-arm-20261022.md)）都是**当时时点**的快照；本页按 `7dd3d699` 重新逐条核过，**不复制**它们的结论。

**一行结论**：按**指挥裁定** `6333028693`（2026-10-22，作者 `Sek1ro-oka`）给出的关单前置（`#17`：A 跳转入口 ＋ C 里 G3 ＋ **台账重生成**），A 与 G3 已随 #448 落地，**台账重生成未落地**——`docs/architecture/contract-status.json` 里三条消息 operation 仍是 `partial`，`blocker` 仍写「真实事件/目标端口、PG/注销及页面/Android仍待验收」，而其中「真实事件／目标端口／注销」三项已随 #422／#425／#452 落地、**PG 一项只到「代码在位＋契约形状单测」（真库臂本轮未跑）**（§3.3 给出逐字读数）⇒ **#17 不可关**；缺口 ① 属**工程/流程**（台账口径，本页 docs-only 不能改），缺口 ② 属**外部依赖/契约**（真机走查、真 PG `system` 形状、通知重试 outbox、停用期间不可读，§5）。

---

## 0 结论

| 判定项 | 实测读数 | 结论 |
| --- | --- | --- |
| #17 是否可关 | 裁定前置 3 项：A ✓（#448）、G3 ✓（#448）、台账重生成 ✗（§3.3） | **不可关** |
| 缺的第 1 条 | 台账重生成：3 条 operation 仍 `partial`，`blocker` 含已不成立的子句 | **工程/流程缺口**（须另派台账片或由监工判定，本页不改台账） |
| 缺的第 2 条 | 真机／Android 走查、真 PG `system` 事件形状、通知重试 outbox、停用期间不可读 | **契约/外部依赖缺口**（§5 的 U1–U4） |
| 功能侧 | AC1／AC2／AC3 **已具备**；AC4 的消息域子句已具备，「收藏历史」子句属 #16 | 见 §1 |
| 代码是否落地 | 迁移 0019 ＋ PG 存储 ＋ 未读派生 ＋ 读标记 CAS ＋ 游标 ＋ 跳转端口 ＋ 四类消息事件（`comment`/`like`/`moderation`/`system`）的生产点，全部在 `upstream/main` 且装配在位 | 见 §2 |

**为什么「不可关」不写成「可关但有未取得项」**：`6333028693` 那句措辞是**指挥侧的历史裁定/建议**（原文：「`Closes`＋`#17` 的前置：A（跳转入口）＋C 里的 G3／台账重生成落地后由监工判定」，引述原文，非关单请求），**不构成对用户「完整验收」要求的豁免**。关单与否由监工依**实际事实与 issue 全部必要 AC／依赖**判断；本页只摆读数、不改口径，也不把「指挥曾建议某前置」读成「监工已认可该口径」。

---

## 1 AC 逐条勾稽

### 1.0 验收条目原文（`gh issue view 17 -R GengYunChuChao/GengYun --json body` 实读，`bodyLength=1504`）

「## 验收」小节下共 **4 条**（原文逐字）：

1. `- [ ] 重复调度不重复创建，未读计数可复核`
2. `- [ ] 发送或创建不当作已读；游客和其他用户不可读`
3. `- [ ] 首版不接微信外部推送，不虚构真人互动消息`
4. `- [ ] 列表、详情、收藏历史和消息均在读取时重查对象权限及当前可见性；隐藏／失效／注销不因缓存或旧链接重新公开`

「## 提交证据」小节另有 **2 条**（原文逐字）：`事件幂等与对象权限回归`、`列表／未读／跳转端到端证据`。issue 现状：`state=OPEN`，`labels=stage:initial,priority:P1,phase:M3`，`updatedAt=2026-10-22T04:53:20Z`。

### 1.1 AC1「重复调度不重复创建，未读计数可复核」——**已具备**

| 子句 | 判定 | 证据（`路径:行号` ＋ 原文片段） |
| --- | --- | --- |
| 重复调度不重复创建 | 已具备 | 去重键由**数据库唯一约束**裁决：`services/api/db/migrations/0019_messages_persistence.sql:68` `CONSTRAINT messages_owner_event_key UNIQUE (owner_id, event_key)`；写入是单条 `INSERT ... ON CONFLICT DO NOTHING RETURNING id`（`services/api/src/messages/store-pg.ts:250`），按「有没有返回行」判 `inserted`／`duplicate`（同文件 `:263`）；内存实现同义（`services/api/src/messages/store.ts` 的去重表） |
| 服务层不靠「先查后写」 | 已具备 | `services/api/src/messages/service.ts:424` 先 `findByEventKey` 命中即 `created:false`；`:439` 并发同键时**回读**既有记录，不产生第二条（`:441` 若仍查不到即按内部不变式违反报错，不臆造） |
| 事件键确定性（重复调度同键） | 已具备 | 社区事件 `community:<event>:<type>:<id>:r<revision>[:后缀]`（`services/api/src/community/events.ts:112`，后缀按身份取值见 `:115`／`:116`）；账号事件 `system:account:<suspend\|restore>:<userId>:e<authEpoch>`（`services/api/src/admin/ops/account-events.ts:68`） |
| 未读计数可复核（派生量，无计数器列） | 已具备 | `services/api/src/messages/store-pg.ts:326` 每次现算 `SELECT count(*)::bigint ... WHERE owner_id = $1::uuid AND read_at IS NULL`；迁移头注释明写「本迁移**没有**任何未读计数器列」（`services/api/db/migrations/0019_messages_persistence.sql:18`）；服务层 `services/api/src/messages/service.ts:350`；契约口径「消息未读数量服务端聚合，不从当前页估计」（`docs/architecture/state-contract.md:32`） |
| 读数 | 已取得 | 定向单测 `node --test tests/unit/messages-*.test.mjs` ⇒ **100 pass / 0 fail**（含 `tests/unit/messages-store-pg-contract.test.mjs:223`「countUnread：每次现算 count(*)，没有计数器列也没有写回」、`tests/unit/messages-concurrency.test.mjs:244`「未读数只减不增…且等于派生值」）；真库侧的「同一快照内一致」读数见既有页 [gy-r31-i17-pg-arm-20261022.md](gy-r31-i17-pg-arm-20261022.md) §2(a)（本页未复跑，见 §5-U5） |

### 1.2 AC2「发送或创建不当作已读；游客和其他用户不可读」——**已具备**

| 子句 | 判定 | 证据（`路径:行号` ＋ 原文片段） |
| --- | --- | --- |
| 创建恒为未读 | 已具备 | `services/api/src/messages/service.ts:432` `read_at: null,`（内部创建口构造记录处；`:428` `revision: 1`）；迁移侧 `read_at` 无默认值、注释「未读 = NULL」（`services/api/db/migrations/0019_messages_persistence.sql:57`） |
| 客户端不能自带已读 | 已具备 | 创建口只收 4 个合法键，传 `read_at`／`id`／`revision`／`reference_state` 一律 400 `UNKNOWN_FIELD`（`services/api/src/messages/validate.ts:187` 说明、`:196` 落点）；用例 `tests/unit/messages-security.test.mjs:208` |
| 已读只能显式操作 | 已具备 | 唯一写入口是 `PUT /messages/{id}/read`（`services/api/src/routes/messages.ts:59`）＋存储侧 CAS（`services/api/src/messages/store-pg.ts:296` 起的 `UPDATE ... WHERE ... AND read_at IS NULL`）；契约「播放成功不记为理解或已读；消息已读须单独操作」（`docs/architecture/state-contract.md:64`） |
| 游客不可读 | 已具备 | 三条路由全部 `preHandler: guards.requireUser`：`services/api/src/routes/messages.ts:44`（列表）、`:54`（未读）、`:60`（标读）；用例 `tests/unit/messages-http.test.mjs:88`「游客/后台/过期会话拒绝，他人与不存在同形，账号epoch变化立即拒绝」 |
| 其他用户不可读（与不存在同形） | 已具备 | 三条语句的归属谓词形状不同、但都在 SQL 里：列表 `services/api/src/messages/store-pg.ts:274` 是 `WHERE owner_id = $1::uuid`；未读 `:327` 是 `WHERE owner_id = $1::uuid AND read_at IS NULL`；标读先 `:298` 的 `WHERE id = $1::uuid`、再 `:299` 的 `AND ($2::uuid IS NULL OR owner_id = $2::uuid)`（owner 走 `$2` 且允许 NULL 逃逸——归属由存储层 `:312-313` 比对后返回 `OWNER_CHANGED`、服务层 `services/api/src/messages/service.ts:382` 再复核兜住）；服务层非本人一律走同一个 `notFound()`（`services/api/src/messages/service.ts:105`）；契约「私有对象非本人统一404，与不存在同形」（`docs/architecture/state-contract.md:13`）；用例 `tests/unit/messages-security.test.mjs:38`（「标记报错与"不存在"逐字节同形」） |

### 1.3 AC3「首版不接微信外部推送，不虚构真人互动消息」——**已具备**

| 子句 | 判定 | 证据 / 复现命令 |
| --- | --- | --- |
| 不接微信外部推送 | 已具备 | `git grep -nE 'requestSubscribeMessage\|subscribeMessage\|wx\.cloud\|templateId\|tmplIds' -- miniprogram` ⇒ **命中 0**（实测，`7dd3d699`） |
| 无客户端创建口 | 已具备 | 契约只有 3 条 operation：`GET /messages`／`GET /messages/unread-count`／`PUT /messages/{id}/read`（`packages/contracts/openapi.json` 实读 `operationId` 分别为 `listMessages`／`getUnreadCount`／`markMessageRead`）；路由只注册这 3 条（`services/api/src/routes/messages.ts:43`、`:53`、`:59`）；`git grep -nE 'app\.(post\|patch\|delete)' -- services/api/src/routes/messages.ts` ⇒ 命中 0；内部创建口不注册路由（`services/api/src/messages/service.ts:422`，文件头 `:6` 自述） |
| 不虚构真人互动 | 已具备 | 消息只由两类**真实事件**产生：他人评论/点赞/审核（`services/api/src/community/events.ts:136` 按事件来源取 `comment`／`like`／`moderation`）、账号停用/恢复（`services/api/src/admin/ops/account-events.ts:144`）；社区域**永不产** `system`（`services/api/src/community/events.ts:129` 注释）；该边界被钉成守卫断言 `tests/unit/community-message-notifications.test.mjs:274`（N8 白名单：`system` 生产点只允许 `admin/ops/account-events.ts`） |
| 无种子/演示消息 | 已具备 | `git grep -nE 'seedMessages\|demoMessages\|presetMessages\|MESSAGE_SEED' -- services/api/src miniprogram` ⇒ **命中 0**；`appendMessage` 的调用方只有两处端口（`services/api/src/community/events.ts:173`、`services/api/src/admin/ops/account-events.ts:144`） |

### 1.4 AC4「列表、详情、收藏历史和消息均在读取时重查对象权限及当前可见性；隐藏／失效／注销不因缓存或旧链接重新公开」——**部分**（消息域子句已具备；「收藏历史」属 #16）

| 子句 | 判定 | 证据 |
| --- | --- | --- |
| 「消息」在读取时重查 | 已具备 | 投影逐条重派生：`services/api/src/messages/service.ts:238` `projectMessage` → `:244` `reference_state: await referenceStateFor(...)`，列表 `:345` 对每条现算；`:227` 三道保守取值（无 target／端口未接线／非 `available` 一律 `unavailable`）；不缓存由端口契约钉住（`services/api/src/messages/reference.ts:23`） |
| 跳转目标判定的唯一来源 | 已具备 | 端口只转接社区「公开可读」判据：`services/api/src/messages/reference-community.ts:53`（只 `post`／`comment`）→ `:56` `isPubliclyVisible`；社区侧闸门 `services/api/src/community/service.ts:893`（`publiclyVisibleTarget`）＋发布谓词 `:619`（`published && approved`）；只读谓词 `services/api/src/community/service.ts:1852` |
| 下架/失效**立即**反映（同一 id 的真实迁移） | 已取得 | 用例 `tests/unit/messages-reference-community.test.mjs:113`（「删除前 available → 删除后 unavailable，读取时重查」）、`tests/unit/messages-security.test.mjs:182`（「reference_state 不入库、逐次派生」）；不区分「隐藏/不存在」由 `:77` 用例钉住 |
| 不因缓存重新公开 | 已具备 | 三条路由全挂 `Cache-Control: no-store`（`services/api/src/routes/messages.ts:21` 定义、`:44`／`:54`／`:60` 挂载）；契约「消息只存事件类型与对象引用，不保存受限正文缩略；跳转时重验目标权限」（`docs/architecture/state-contract.md:99`） |
| 注销不复活 | 已具备（服务端 + 真库既有读数） | 注销原语同事务删消息与本人幂等行：`services/api/src/messages/store-pg.ts:220`（`purgeOwnerRows`）→ `:230` `DELETE FROM public.messages WHERE owner_id = $1::uuid RETURNING id`；装配 `services/api/src/app.ts:1920`（`messagesStore: messagesDeletionStore`）；真库读数（A 的 9 条 → 0、B 逐 id 原样、台账 3→0）见 [gy-r31-i17-pg-arm-20261022.md](gy-r31-i17-pg-arm-20261022.md) §3 |
| 「详情」子句对消息域 | **不适用（非缺口）** | 契约里消息只有列表/未读/标读 3 条 operation，**没有**消息详情端点 ⇒ 无「详情」对象可核；`gh issue view 17` 正文的「详情」指其它域页面 |
| 「收藏历史」子句 | **不在本片范围** | 属 #16 验收面；本页不代为断言（其关闭材料 [gy-r31-i16-closeout-20261022.md](gy-r31-i16-closeout-20261022.md) 自陈 AC4 整条未闭合，其中「消息」那一条注明「属 #17」）。补记：`#484`（`fix(i16)`，`c728648a`）把 `real` 模式终态历史端口接真库——**它是 #16 的 PR，不是 #17 相关 PR**（§3.1 更正） |

### 1.5 勾稽分布

| 条目 | 判定 | 一句话依据 |
| --- | --- | --- |
| AC1 | **已具备** | 唯一约束裁决去重 ＋ 派生 `count(*)` 未读，服务端与页面两层读数齐 |
| AC2 | **已具备** | 创建恒 `read_at: null`；三路由 `requireUser`；他人与不存在同形 404 |
| AC3 | **已具备** | 零推送代码、零创建路由、事件类型按来源取值、无种子消息 |
| AC4 | **部分** | 消息域四子句齐（读时重查／no-store／注销）；「收藏历史」属 #16 |
| 提交证据①（事件幂等与对象权限回归） | **已具备** | 幂等：`services/api/db/migrations/0019_messages_persistence.sql:68` ＋ `tests/unit/messages-security.test.mjs:279`；权限：`tests/unit/messages-security.test.mjs:38`、`tests/unit/messages-http.test.mjs:88` |
| 提交证据②（列表／未读／跳转端到端证据） | **部分** | 列表/未读：`tests/unit/messages-http.test.mjs:203`、`:227`；跳转：服务端 `tests/unit/messages-target-scope.test.mjs:62`、页面 `tests/unit/miniprogram-ui-auth-integration.test.mjs:434`／`:459`／`:485`；**真机端到端未取得**（§5-U1） |

---

## 2 代码落点（`git grep` / 实读，行号＝`7dd3d699` 当前值）

### 2.1 消息存储（持久化与去重）

| 能力 | 实现位置 | 原文片段 |
| --- | --- | --- |
| 建表与闭集约束 | `services/api/db/migrations/0019_messages_persistence.sql:49` | `CREATE TABLE messages (` |
| 类型闭集 | `services/api/db/migrations/0019_messages_persistence.sql:63` | `CONSTRAINT messages_type_allowed CHECK (type IN ('comment', 'like', 'moderation', 'system'))` |
| 事件去重键 | `services/api/db/migrations/0019_messages_persistence.sql:68` | `CONSTRAINT messages_owner_event_key UNIQUE (owner_id, event_key)` |
| 列表排序索引 | `services/api/db/migrations/0019_messages_persistence.sql:72` | `CREATE INDEX messages_owner_created_idx ON messages (owner_id, created_at DESC, id DESC);` |
| PG 写入原语 | `services/api/src/messages/store-pg.ts:246` | `async insertMessage(record) {` （`:250` `ON CONFLICT DO NOTHING`） |
| 去重判定 | `services/api/src/messages/store-pg.ts:263` | `const result: InsertResult = rows.length > 0 ? 'inserted' : 'duplicate';` |
| 持久化标志（装配判据） | `services/api/src/messages/store-pg.ts:244` | `persistent: true,` |
| 装配：有池走 PG | `services/api/src/app.ts:802` | `const messagesStore: MessagesStore =` （`:806` `createPostgresMessagesStore({ pool })`） |
| 装配：real 无池即 null（503） | `services/api/src/app.ts:812` | `const messagesService = config.executionMode === 'real'` |

### 2.2 未读聚合

| 能力 | 实现位置 | 原文片段 |
| --- | --- | --- |
| 派生计数（无计数器列） | `services/api/src/messages/store-pg.ts:326` | `SELECT count(*)::bigint AS count FROM public.messages` |
| 服务层读取口 | `services/api/src/messages/service.ts:350` | `async getUnreadCount(actor: unknown): Promise<UnreadCount> {` |
| 路由 | `services/api/src/routes/messages.ts:53` | `app.get(\`${API_PREFIX}/messages/unread-count\`, {` |
| 口径（服务端聚合） | `docs/architecture/state-contract.md:32` | `消息未读数量服务端聚合，不从当前页估计` |
| 失败不清零（页面） | `miniprogram/pages/messages/messages.js:226` | `// G6（#17）：失败分支**不进 \`_applyUnread\`**——一次 setData 都不发给角标，` |
| 失败不清零（tabBar） | `miniprogram/custom-tab-bar/index.js:55` | `}).catch(function (error) {`（`:57` 注释「失败时一个 setData 都不发」，`:59` 只留 `warnUnreadFailure`） |
| 可点重试 | `miniprogram/pages/messages/messages.js:244` | `onRetryUnread: function () {` |

### 2.3 读标记（CAS ＋ 版本 ＋ 强 ETag）

| 能力 | 实现位置 | 原文片段 |
| --- | --- | --- |
| 唯一写入口（CAS 单语句） | `services/api/src/messages/store-pg.ts:296` | `UPDATE public.messages`（`:300` `AND read_at IS NULL`） |
| 版本恰好 +1 | `services/api/src/messages/store-pg.ts:297` | `SET read_at = $3::timestamptz, revision = revision + 1` |
| 幂等 + If-Match 校验 | `services/api/src/messages/service.ts:383` | `if (record.revision !== ifMatch.revision) {`（`:384` 抛 `REVISION_CONFLICT`） |
| 路由写 ETag | `services/api/src/routes/messages.ts:69` | `return reply.header('ETag', strongEtagOf(data.revision)).send({ data, meta: buildMeta(request, config) });` |
| 契约口径 | `docs/architecture/state-contract.md:15` | `GET 条目带强 ETag \`"<revision>"\`；…缺失428，不匹配409，不做 last-write-wins` |
| 读数 | 已取得 | `tests/unit/messages-read-version.test.mjs:32`（首次 +1）、`:61`（重复标记不推进）、`:91`（旧 ETag ⇒ 409） |

### 2.4 游标

| 能力 | 实现位置 | 原文片段 |
| --- | --- | --- |
| TTL 15 分钟 | `services/api/src/messages/service.ts:55` | `export const CURSOR_TTL_MS = 15 * 60 * 1000;` |
| 签名编码/验签 | `services/api/src/messages/service.ts:254`／`:259` | `function encodeCursor(payload: CursorPayload): string {`／`function decodeCursor(` |
| 绑定主体/路由/过滤/排序/水位 | `services/api/src/messages/service.ts:313` | `watermark: createHmac('sha256', signingKey).update('messages-watermark/v1\n')` |
| 稳定游标（同刻用 id 全序兜底） | `services/api/src/messages/service.ts:326` | `const remaining =`（`:329` 起按 `created_at <` 或 `created_at === && id <` 过滤） |
| 失效即 400 | `services/api/src/messages/service.ts:322` | `throw new ApiError('INVALID_CURSOR', '游标位置已失效，请重新读取首页');` |
| 读数 | 已取得 | `tests/unit/messages-pagination.test.mjs:38`（同刻 5 条不漏不重）、`:104`（新消息使旧游标 400）、`:124`（篡改/换主体/换排序/过期全 400） |

### 2.5 权限跳转

| 能力 | 实现位置 | 原文片段 |
| --- | --- | --- |
| 端口契约（闭集 `available\|unavailable`） | `services/api/src/messages/reference.ts:94` | `export function createWiredReferencePort(options: WiredReferencePortOptions): MessageReferencePort {` |
| fail-closed 折叠 | `services/api/src/messages/reference.ts:103` | `return value === 'available' ? 'available' : 'unavailable';` |
| 未接线端口（诊断用） | `services/api/src/messages/reference.ts:59` | `export function createUnwiredReferencePort(` |
| 只接社区域两型（裁定 B 的落点） | `services/api/src/messages/reference-community.ts:53` | `if (target_ref.type !== 'post' && target_ref.type !== 'comment') return 'unavailable';` |
| 社区权威判据（注入） | `services/api/src/messages/reference-community.ts:56` | `const readable = await community.isPubliclyVisible(target_ref.type, target_ref.id);` |
| 社区只读谓词（不进路由/不进 OpenAPI） | `services/api/src/community/service.ts:1851` | `visibility: Object.freeze({` |
| 装配：后绑定读取器 | `services/api/src/app.ts:810` | `const messageReference: MessageReferencePort =`（`:811` `createCommunityReferencePort({ community: () => communityVisibility })`；`:1154` 补赋值） |
| 页面可点判据（唯一） | `miniprogram/pages/messages/messages.js:310` | `const canOpen = message.reference_state === 'available' && target !== null &&` |
| 页面跳转（post 直跳／comment 先取父帖） | `miniprogram/pages/messages/messages.js:277`／`:278` | `if (item.targetType === 'post') { open(item.targetId); return }`／`communityApi.getComment(item.targetId).then(function (result) {` |
| 行绑定 | `miniprogram/pages/messages/messages.wxml:101` | `bindtap="onOpenTarget"`（`:108` `查看详情 ›`；`:115` `catchtap="onMarkRead"`） |
| 文案不暗示存在性 | `miniprogram/pages/messages/messages.js:48` | `unavailable: '关联内容当前不可查看，本条不提供跳转入口。'` |

### 2.6 事件源与装配

| 能力 | 实现位置 | 原文片段 |
| --- | --- | --- |
| 社区事件键 | `services/api/src/community/events.ts:112` | `export function communityEventKey(event: CommunityEvent): string {` |
| 事件类型按来源取值 | `services/api/src/community/events.ts:136` | `export function communityEventMessageType(event: CommunityEvent): CommunityMessageType {` |
| 社区事件投递 | `services/api/src/community/events.ts:173` | `const result = await options.messages.appendMessage({` |
| 账号事件键 | `services/api/src/admin/ops/account-events.ts:68` | `export function accountSystemEventKey(event: AccountSystemEvent): string {` |
| changed-only（幂等分支不投递） | `services/api/src/admin/ops/account-events.ts:205` | `if (outcome.changed !== true) {` |
| 账号事件投递 | `services/api/src/admin/ops/account-events.ts:144` | `const result = await options.messages.appendMessage({` |
| 装配：社区事件端口 | `services/api/src/app.ts:1128` | `(messagesService === null`（`:1130` `createMessagesCommunityEventsPort({ messages: messagesService })`） |
| 装配：账号事件装饰器 | `services/api/src/app.ts:1388` | `const accountEvents: AccountEventsPort =`（`:1398` `withAccountSystemEvents(accountAuthorityBase, { events: accountEvents, log: app.log })`） |
| 路由注册（唯一处） | `services/api/src/app.ts:2254` | `registerMessageRoutes(app, config, guards, messagesService);` |
| 创建口入参闭集 | `services/api/src/messages/validate.ts:43` | `export const EVENT_KEY_MAX = 200;` |

---

## 3 PR 与裁定记录（自己核过的读数）

### 3.1 PR 状态与内容核对

下表 `state`／`mergeCommit`／`mergedAt` 均来自 `gh pr view <n> -R GengYunChuChao/GengYun --json state,mergeCommit,mergedAt,headRefName,title`（本页写作时实跑）；`mergeCommit` 一律写 **40 位全量 OID**（不缩写）。「在 main 祖先链」列是 `git merge-base --is-ancestor <oid> upstream/main` 的退出码读数（`0`＝在链上／`1`＝不在链上），两种取值都由 `git cat-file -t <oid>` ＝ `commit` 佐证——**不在链上 ≠ 未合并**，原因见 §3.4。「内容证据」列是本页在 `upstream/main` 上实读到的落点。

| PR | state | mergeCommit（40 位） | 在 main 祖先链 | 标题要点 | 内容证据（实读） |
| --- | --- | --- | --- | --- | --- |
| #138 | MERGED | `1865c64e6ed4e5f4bbdcd939865785f6e7b513dc` | 1（不在） | 接通消息三端点与固定期限分页 | `services/api/src/routes/messages.ts:43`／`:53`／`:59` |
| #191 | MERGED | `e1e1e4ad91c02bab938602d4cf0ab7ca8b353558` | 1（不在） | 消息页真实读面与未读角标 | `miniprogram/pages/messages/messages.js:298`（`_applyUnread`） |
| #215 | MERGED | `cc07de8fd2fabfcd51b11c37962994631ecfbed5` | 1（不在） | 修复微信端标为已读被误判 400 | `services/api/src/routes/messages.ts:36`（`dropEmptyBodyContentType`） |
| #278 | MERGED | `293fbefa600f64c3a33e5404352f97a97a6ac829` | 1（不在） | 消息域接入 PostgreSQL 持久化 | `services/api/db/migrations/0019_messages_persistence.sql:49`、`services/api/src/messages/store-pg.ts:246` |
| #422 | MERGED | `50e3bf40346811a72cb511f19e4b49f035a5a020` | 1（不在） | 他人评论/点赞真落库，类型按来源取值 | `services/api/src/community/events.ts:136`、`:173` |
| #425 | MERGED | `88942df44666e6061244465bc5f03ba1bae1c349` | 1（不在） | 接线跳转目标可用性 | `services/api/src/messages/reference-community.ts:49`（`createCommunityReferencePort`）、`services/api/src/app.ts:810` |
| #445 | MERGED | `7afabe8a8c4fbe5258351dee6e516b6c9b9521a3` | 0（在） | 只读复盘与九条缺口（文档） | [gy-r31-i17-recon-20261022.md](gy-r31-i17-recon-20261022.md) |
| #448 | MERGED | `ac848d9d2325c382f97d918e4e43a95abec17260` | 0（在） | 消息行可跳转 ＋ 未读数可重试 ＋ 过期文案（**A／G3／G7／G8**） | `miniprogram/pages/messages/messages.js:310`、`:244`、`miniprogram/pages/messages/messages.wxml:101` |
| #452 | MERGED | `174b547c65ed3106928820aecc9782ee2744898b` | 0（在） | 消息域「注销即删」真库读数（**G4**） | [gy-r31-i17-pg-arm-20261022.md](gy-r31-i17-pg-arm-20261022.md)、`tests/integration/messages-pg.mjs` |
| #468 | MERGED | `56ed9f2c8f89494a8bb02e03830a134cb8a0e2af` | 0（在） | 未读数失败不再静默清空角标（**G6**） | `miniprogram/custom-tab-bar/index.js:55`、`miniprogram/pages/messages/messages.js:226` |
| #470 | MERGED | `36c6d0677c5845fe5f9b7951437fa5f215b26053` | 0（在） | 幂等台账前缀单点化 ＋ 跨域守卫（**G5**） | [gy-r31-i17-g5-20261022.md](gy-r31-i17-g5-20261022.md) |
| #477 | MERGED | `693142eb750be07d0b904239110520ff22f69457` | 0（在） | G2 裁定：跳转范围仅 `post`/`comment`（文档） | [gy-r31-i17-g2-ruling-20261022.md](gy-r31-i17-g2-ruling-20261022.md)、`tests/unit/messages-target-scope.test.mjs:62` |
| #479 | MERGED | `1aa310fa5509d7fa741270a5dbc36072b41951f6` | 0（在） | 台账锚点支持符号形态（Refs #17） | §3.3 给出的那三处装配括注重锚读数 |
| #484 | MERGED | `c728648a74ede69181d875d0c7f32ee2ad126a3d` | 0（在） | **`fix(i16)`: real 模式终态历史端口接真库**（Refs #16） | 与 #17 无代码交集；任务书把它列为「#17 相关」，**实读纠正：它属 #16** |
| #485 | MERGED | `5b4292f2bd7237abe3ff3257f606e90d60487537` | 0（在） | 账号级系统事件（停用/恢复 → `system`，**G9**） | `services/api/src/admin/ops/account-events.ts:68`、`:144`；装配 `services/api/src/app.ts:1388` |

### 3.2 指挥历史记录 `6333028693`（`gh api repos/GengYunChuChao/GengYun/issues/comments/6333028693` 实读：`user.login=Sek1ro-oka`（`type=User`）、首行「指挥裁定（GY-I17，2026-10-22）」、`bodyLength=773`、`created_at=2026-10-22T04:53:20Z`）——属**指挥侧评论**，不是任何形式的批复或判决

原文三段要点与逐条核对：

1. **裁定 B：本版跳转范围＝`post`/`comment` 两型**；其余 14 型「恒 `unavailable` 且不泄露存在性」，**不记为缺陷**；若要覆盖 16 型「另开 issue 走端口扩容（复用 `targetref/visibility.ts:170` 同源判定，禁止在消息域另写一套）」。
   - 我的核对：代码与之一致——`services/api/src/messages/reference-community.ts:53` 只放行两型；14 型 `unavailable` 由 `tests/unit/messages-target-scope.test.mjs:62`（闭集 16 型、支持集恰两型）、`:162`（同页 14 型全部 `unavailable` 且整体 200）钉住。
   - 一处需登记的**口径差额**（只登记，不判缺陷）：裁定点名的「同源判定」是 `services/api/src/targetref/visibility.ts:170` 的 `deriveVisibility`（收藏/历史用的端口形状），而消息域现在用的是 `services/api/src/messages/reference.ts:94` 的 `createWiredReferencePort`（更窄的闭集折叠）。两者都 fail-closed、都不泄露存在性，但**不是同一函数**；若将来扩 16 型，需按裁定复用 `deriveVisibility`，⛔ 不得在消息域另写一套。
2. **不算缺口、不要改的点**：`DELETE /messages/:id` 契约与实现两侧都不存在 ⇒ 本版不加；`store-pg.ts:430/437` 的 `deleteAllByOwner`／`purgeOwnerData` 是注销内部原语。
   - 我的核对：`packages/contracts/openapi.json` 里消息只有 3 条 operation（§1.3）；实读 `services/api/src/messages/store-pg.ts:430`（`async deleteAllByOwner(ownerId) {`）与 `:437`（`async purgeOwnerData(ownerId) {`）——行号与裁定一致。
3. **关单前置（`Closes`＋`#17`，引述原文，非关单请求）**：A（跳转入口）＋C 里的 G3／**台账重生成**落地后由监工判定（**该句原文如此**，本页按原文引述，不据此推断任何人已改口径）；单靠 B 不构成关闭。
   - 我的核对：A／G3 已随 #448 落地；**台账重生成未落地**（§3.3）⇒ 前置不全。

### 3.3 台账现状（`docs/architecture/contract-status.json`，本页只读、不改）

- 三条 operation 的 `status` 全部仍是 `partial`：`listMessages`（`get /messages`）、`getUnreadCount`（`get /messages/unread-count`）、`markMessageRead`（`put /messages/{id}/read`）。
- 三条的 `blocker` 逐字相同，末段为：「…**真实事件/目标端口、PG/注销及页面/Android仍待验收**，不虚构真人消息」。其中三项按本页实读**已不成立**：真实事件＝#422（`services/api/src/community/events.ts:136`）、目标端口＝#425（`services/api/src/app.ts:810`）、注销＝#452 的真库读数页。**「PG」一项只能算「代码在位」**——迁移 0019 ＋ `services/api/src/messages/store-pg.ts:244` 的 `persistent: true` ＋ PG 存储的契约形状单测（`tests/unit/messages-store-pg-contract.test.mjs`），**真库臂本轮未跑**（§5-U5）⇒ 证据强度比前三项**弱一档**，本页不把它写成等强。只有「页面/Android」仍成立（§5-U1）。
- **「自根提交以来只重锚过行号」的逐字读数**：`git diff 903ad629..upstream/main -- docs/architecture/contract-status.json` 里 `listMessages`／`getUnreadCount`／`markMessageRead`／`真实事件/目标端口` 共 9 处命中，其中唯一的语义差异是那三处装配括注的锚点重校准（与 `#479` 的主题一致）：旧值在 `903ad629` 的台账里写作 `app\.ts:757` 这个锚点（**转义只为避开文档行号闸门的路径识别，台账原文没有反斜线**；复现：`git show 903ad629:docs/architecture/contract-status.json | grep -c 'app\.ts:757'` ⇒ **3** 次；⚠ 那个行号在**当前** `services/api/src/app.ts` 上是收尾括号 `}`、不是装配代码，所以**不能**当代码引用核——写成字面 `路径:行号` 会被闸门判 SUSPECT），新值写作 `services/api/src/app.ts:802-806`（同一份台账命中 **3** 次）；`status` 与那句「真实事件/目标端口…仍待验收」**一字未变**。
- 因此本页对台账的判定只有一句：**「未按已落地事实重生成」**。本页**不**判「status 应为 `implemented`」——那是监工/台账片的口径裁定（`node tools/verify-contract-status.mjs` 只校验锚点与生成表字节一致，**不校验语义**）。

### 3.4 一处必须写明的历史事实（否则并入判定会错）

`upstream/main` 的**可见历史只有 66 个提交**，其**根提交是 `903ad629`**（`git rev-list --parents -n 1 903ad629` 只返回它自己 ⇒ 无父提交；`git rev-list --max-parents=0 upstream/main` 也只返回它）。该提交一次性把当时整棵树作为「新增」带入（`git show 903ad629 --name-status` 中 `services/api/src/app.ts`、`services/api/src/community/events.ts`、`services/api/src/messages/reference-community.ts` 均为 `A`）。

后果与口径：

- 边界正好落在 import 点上：#138／#191／#215／#278／#422／#425 的 `mergeCommit`（`1865c64e…`／`e1e1e4ad…`／`cc07de8f…`／`293fbefa…`／`50e3bf40…`／`88942df4…`，全量见 §3.1）**都不在** `upstream/main` 的祖先链上（`git merge-base --is-ancestor` 六个均 exit=1），而 #445 起的九个均 exit=0；但这两组的内容**都在当前 main**（`services/api/src/messages/reference-community.ts:49` 存在、`services/api/src/community/events.ts:136` 的类型映射在位）⇒ **并入判定一律用内容核对，不用祖先关系**（与 `AGENT.md` §5 第 6 条／§7 的口径一致；本页因此**不**把 ancestry 当作任何证据）。
- 同理，早于 import 的 PR（#138／#191／#215／#278／#422／#425）只按内容核对：`mergeCommit` 照实填 40 位 OID，「祖先链」列写 `1（不在）`，**不**写成「未合并」。

---

## 4 门禁读数（本片交付时实跑）

| 门禁 | 命令 | exit | 摘要行（原样） |
| --- | --- | --- | --- |
| 开发文档 | `npm run test:docs` | **0** | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` ＋ `PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住` |
| 文档行号闸门 | `node tools/verify-doc-anchors.mjs --strict` | **0** | `SCAN: 文档 255 份；抽出「路径:行号」引用 4654 条…`／`BASELINE: … 本次命中 105 条、基线外新增 0 条、陈旧 0 条`／`PASS: --strict 下没有基线之外的新增` |
| 定向单测（消息域全族） | `node --test tests/unit/messages-*.test.mjs` | **0** | `tests 100 / pass 100 / fail 0 / skipped 0`（13 个 `.test.mjs` ＋ 共用 `messages-fixtures.mjs`） |
| 定向单测（事件源与页面） | `node --test tests/unit/i17-system-events.test.mjs tests/unit/community-message-notifications.test.mjs tests/unit/community-moderation-events-fail-closed.test.mjs tests/unit/miniprogram-ui-auth-integration.test.mjs` | **0** | `tests 64 / pass 64 / fail 0` |

两条说明（避免把本页读数当成关单门禁）：

- 上面第 3、4 行是**本页引用的读数**，不是 #17 的关单门禁；本片只新增文档，未改任何被测代码。
- 首次在没有 `node_modules` 的干净树里跑第 3 行时，5 个文件以 `ERR_MODULE_NOT_FOUND: Cannot find package 'pg'`／`'fastify'` 报红（`tests 58 / pass 53 / fail 5`）——这是**环境缺依赖**，不是断言失败；`npm ci` 后复跑得到上表的 `100/100`。该过程只留档，不作任何判据。

---

## 5 未取得项（逐条：为什么拿不到 ＋ 若要取得需要什么）

| 编号 | 未取得的东西 | 为什么本片拿不到（实测依据） | 若要取得需要什么 |
| --- | --- | --- | --- |
| U1 | **真机／微信开发者工具**走查：行点击跳转、pill 点按重试、角标展示 | 本机无微信编译器与真机交互环境；页面侧证据只到 Node 下对页面 JS/WXML 的逻辑断言（`tests/unit/miniprogram-ui-auth-integration.test.mjs:434`／`:459`／`:485` 3 例） | 一台真机或开发者工具 ＋ 可登录账号 ＋ 至少一条 `available` 的 `post` 消息（或合成 stub 模式走查），记录截图与 network |
| U2 | **真 PG 的 `system` 事件形状** | `git grep -n "system" -- tests/integration/messages-pg.mjs` ⇒ **命中 0**（真库臂不覆盖 `system`）；`#485` 的 PG 证据只到**假池语句形状**（`$4::jsonb` 收 NULL、`read_at` 恒 NULL） | 扩写真库臂：插入 `type='system'`＋`target_ref=NULL` 行，回读 `target_ref IS NULL`、`read_at IS NULL`、唯一约束命中；或由 DBA 侧给 `select` 读数 |
| U3 | **通知重试 outbox** | `git grep -ni outbox -- services/api/src/messages services/api/src/admin/ops/account-events.ts services/api/src/community/events.ts` ⇒ **命中 0**：投递是**同步、fail-open、不重试**（失败只留 `delivered:false`＋计数＋`warn`，见 `services/api/src/admin/ops/account-events.ts:205` 起与 `:222`）；而契约要求「outbox 与业务更新同事务，dispatcher 消费去重键」（`docs/architecture/state-contract.md:52`） | 要么实现 outbox＋dispatcher（迁移＋端口＋重试语义），要么由监工出具「消息域不走 outbox」的裁定并把口径写进契约；两者都不是本页能做的 |
| U4 | **停用期间的不可读**（S1 消息读不到） | `#485` 已核：停用会撤会话且 `user.state !== 'active'` ⇒ `/messages` 401/403；**恢复没有 HTTP 路由**（`packages/contracts/operations.json` 只有 `suspendUser`）⇒ 没有「恢复后读到 S2」的端到端读数 | 先补恢复路由（属 #18 边界），再做「停用→恢复→收件箱读到两条」的端到端读数 |
| U5 | **本轮真库臂读数** | `127.0.0.1:55727` `TcpTestSucceeded=False`；在听的 `55715` 属其它回合的集群，本片不借用（避免污染他人库） | 起一台专用集群（`initdb`＋`postgres -p <唯一端口>`）并重建 `gengyun_messages_test` 后跑 `node tests/integration/messages-pg.mjs <url>`；或取 CI `real-pg-17.11` 的 job 记录（`.github/workflows/real-pg-integration.yml:147`） |
| U6 | **CI 实跑记录**（本分支的 job 绿/红） | 本片 docs-only、**不 push**（按派单红线） | 由推送者开 PR 后取该 PR 的 job 记录；本页只能证明「步骤在 job 里」（`.github/workflows/real-pg-integration.yml:147` 的 messages-pg、`:454` 的 messages-purge-pg） |

---

## 6 不可核项（写明为什么无法核）

| 项 | 为什么不可核 |
| --- | --- |
| 14 型（非 `post`/`comment`）目标的「真实可用性」 | 裁定 B 明确本版不接线；`services/api/src/messages/reference-community.ts:53` 在取社区判据**之前**就返回 `unavailable` ⇒ 既不存在「曾可用」的读数，也无从区分「未接线」与「目标不可读」。只能核「恒 `unavailable` 且与不存在同形」 |
| 消息「详情」子句 | 契约无消息详情端点（只有 3 条 operation）⇒ 无对象可核；这不是缺失，是把子句的主体（详情页）划到了别的域 |
| 「收藏历史」的读时重查 | 属 #16 验收面；本页不代核（其关闭材料自陈 AC4 未闭合）。为避免重复记账，本页只登记归属 |
| 台账 `partial` 的**口径正确性** | 工具只做机械校验（锚点范围、生成表与 JSON 字节一致），**不判断语义**；「应否 `implemented`」是裁定问题，不是可计算事实 |
| 投递失败后的最终一致性 | 无 outbox（U3）⇒ 失败后有没有补发**没有实现可核**；本页不把 `fail-open` 读成「最终一致」 |
| 旧 ETag 与并发落败方的**可区分性** | 结构性不可区分：`tests/unit/messages-read-version.test.mjs:183` 明写「落败方的请求形状与『用旧 ETag 的第二次标记』完全同形 ⇒ 规则上不可区分」 |

---

## 7 复跑清单与清理自证

```powershell
cd E:\GengYunCommander\wt-r33-i17

# 0) 依赖（本树自装；装完 git status --porcelain 必须为空）
npm ci --prefer-offline --no-audit --no-fund --ignore-scripts

# 1) 消息域全族（本页 §4 第 3 行）
node --test "tests/unit/messages-*.test.mjs"

# 2) 事件源与页面（本页 §4 第 4 行）
node --test tests/unit/i17-system-events.test.mjs tests/unit/community-message-notifications.test.mjs `
  tests/unit/community-moderation-events-fail-closed.test.mjs tests/unit/miniprogram-ui-auth-integration.test.mjs

# 3) 门禁（本页 §4 前两行）
npm run test:docs                              # 期望 exit 0
node tools/verify-doc-anchors.mjs --strict     # 期望 exit 0（基线外新增 0）

# 4) 真库臂（本片未跑，见 §5-U5；需要一台专用集群与空库）
#    node tests/integration/messages-pg.mjs postgres://<user>@127.0.0.1:<port>/gengyun_messages_test
```

**清理自证**：本片只在仓库内新增本文件（`docs/verification/gy-i17-closeout-20261023.md`）；临时产物（issue/PR/评论的 JSON 与文本转储、单测日志）全部落在**仓外** `E:\GengYunCommander\.pg17\` 下的 `tmp-i17-*` 前缀文件，未进仓库、未改任何被测代码或台账；本片**未删任何文件**（`git status --short` 见交付回报）。
