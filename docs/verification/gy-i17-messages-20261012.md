# GY-I17（#17）阶段 1 · 首版应用内消息、未读状态与权限跳转（服务层）证据

- 任务：GY-I17（GitHub issue #17）阶段 1 —— `listMessages`／`getUnreadCount`／`markMessageRead` 三条
  operationId 的**服务层**实现（不注册路由）。
- 工作区：`GengYun_W14`（分支 `feat/gy-i17-messages`）；GitHub 身份 Yu0ry（Fork `Yu0ry/GengYun_Write`）。
- **结论口径**：本文件只报告**已实测**的本地结果，**不代表**验收通过、**不代表**消息系统端到端可用
  （无路由装配、无持久化、目标读取端口未接线）。所有原始输出均落在工作区之外的
  `E:\GengYunCommander\.gy-i17-evidence\`，本文件引用其摘要。

## 1 基线与环境（开工前复核 + 收尾复核）

| 项 | 值 |
| --- | --- |
| 开工前 `git fetch upstream --prune` 后 `upstream/main` | `ffd5bf73b57709bf18d47a6644dff24eaf58e30c`（与派单要求一致） |
| 本分支 HEAD（= 基线，未 rebase、未基于任何其它 PR 分支头） | `ffd5bf73b57709bf18d47a6644dff24eaf58e30c` |
| 收尾时 `upstream/main`（第一次 fetch） | `13262f19345b6e2e99de8ba39d661dae065d3b01`（上游在本片工作期间前进了两个合并 PR） |
| 上游新增（相对本基线，第一次） | `f8da03b`（#87 GY-I09 识别闭环）、`13262f1`（#99 转写并发诊断改走 stderr） |
| 第二次 `git fetch` 后的 `upstream/main` | `6337f1899f0a9ee4384a0a71fa2db3b51e68b5a8`（再前进 1 个：`6337f18` = #101 GY-I18 阶段 1b） |
| `ffd5bf73` 是否仍为 `upstream/main` 的祖先 | 是（`git merge-base --is-ancestor` 退出码 0 ⇒ 本分支是"落后基线"而非"分叉"） |
| 本片新增文件与上游新增文件是否重叠 | 无（`git diff --name-only ffd5bf73 upstream/main` 里没有任何 `messages` 路径；#101 只动 `admin/**` 与 `tests/unit/admin-ops-*`） |
| Node / npm | `v24.16.0` / `11.13.0` |
| 依赖安装 | `npm ci --no-audit --no-fund` ⇒ `added 103 packages in 3s` |

说明：§9 的门禁数字是**在 `ffd5bf73` + 本片改动**这棵树上实测的；按指挥要求合并上游后，
已在**合成树**上复跑全部门禁，原始输出见 §11。两次上游新增（#87／#99 与 #101）与本片**零文件重叠**。

## 2 契约核对（**逐字读全**，不新增字段/错误码，不改契约）

事实源：`packages/contracts/openapi.json` 与 `packages/contracts/states.json`（契约 1.0.0）。

`Message`（`additionalProperties:false`）**完整** required 恰为 7 项：

| 字段 | 类型/约束 |
| --- | --- |
| `id` | string, format uuid |
| `revision` | integer, minimum 1 |
| `type` | enum `comment` / `like` / `moderation` / `system` |
| `target_ref` | `TargetRef` 或 `null` |
| `reference_state` | `ReferenceState`（必填，不可空） |
| `read_at` | date-time 或 `null` |
| `created_at` | date-time |

**重要缺口（已复核到底，不是只看前 700 字符）**：契约 `Message` **没有** `title`／`body`／`actor`／
`summary`／`unread`／`source_event` 等字段。这跟
[state-contract.md](../architecture/state-contract.md)「消息只存事件类型与对象引用，不保存受限正文缩略」
一致：消息本体不携带目标正文，可跳转性只由 `reference_state` 表达。因此本片**不伪造**消息正文，
也**不造**替身字段（`tests/unit/messages-contract.test.mjs` 断言这五个字段不存在）。

其余逐项核对结果：

| 契约对象 | 原文要点 | 本片落点 |
| --- | --- | --- |
| `ReferenceState` | 闭集 `available` / `unavailable`（states.json 同值） | `messages/types.ts` + `messages/reference.ts` |
| `TargetRef` | `type` 闭集 16 项、`id` 1..80、`revision` ≥1 整数，三字段全必填 | `messages/types.ts` + `validate.ts::readTargetRef` |
| `MessagePage` | `items`（`maxItems:50`）+ `next_cursor`（string 1..2048 或 null） | `service.ts::listMessages` |
| `UnreadCount` | `{count}`，integer `minimum:0`，`additionalProperties:false` | `service.ts::getUnreadCount`（**派生值**） |
| `MessagePageEnvelope` / `UnreadCountEnvelope` / `MessageEnvelope` | 均为 `{data, meta}` 全必填 | 本片只产 `data`；封套与 `meta` 属阶段 2 路由层 |
| `listMessages` 参数 | `Cursor`（≤2048）、`Limit`（1..50，默认 20） | `validate.ts::parseListMessagesQuery` |
| `markMessageRead` 参数 | path `id` uuid；`Idempotency-Key` required 8..128；`If-Match` required `^"[1-9][0-9]*"$`；**无请求体**；`x-version-required: true` | `validate.ts::requireIdempotencyKey` / `requireIfMatch` |
| 状态码 | 200 + 400/401/403/404/409/413/415/422/428/429/503/504（契约按全站枚举声明） | 本片只会产生 200/400/401/403/404/409/428（全部在闭集内，见 §9 契约用例） |
| `ErrorCode` | 25 项闭集 | 本片使用 10 项，全部在闭集内（`messages-contract.test.mjs` 逐项断言） |

## 3 实现位置（3 个 operationId + 1 个内部创建口）

| operationId / 内部口 | 方法与路径 | 实现位置 |
| --- | --- | --- |
| `listMessages` | `GET /messages` | [service.ts](../../services/api/src/messages/service.ts) `listMessages` |
| `getUnreadCount` | `GET /messages/unread-count` | [service.ts](../../services/api/src/messages/service.ts) `getUnreadCount` |
| `markMessageRead` | `PUT /messages/{id}/read` | [service.ts](../../services/api/src/messages/service.ts) `markMessageRead` |
| `appendMessage`（**非契约**，无路由） | — | [service.ts](../../services/api/src/messages/service.ts) `appendMessage` |

新增目录与文件（全部为**新增**，未修改任何既有文件）：

- [types.ts](../../services/api/src/messages/types.ts)：契约类型与三处闭集常量。
- [store.ts](../../services/api/src/messages/store.ts)：消息存储接口 + 内存实现（三个唯一写入原语）。
- [reference.ts](../../services/api/src/messages/reference.ts)：目标可用性端口（fail-closed）。
- [validate.ts](../../services/api/src/messages/validate.ts)：契约参数与创建口入参校验。
- [immutable.ts](../../services/api/src/messages/immutable.ts)：入口深冻结 + 出口深拷贝边界。
- [service.ts](../../services/api/src/messages/service.ts)：三条 operationId 与内部创建口。
- [index.ts](../../services/api/src/messages/index.ts)：出口。

**未触碰**：`services/api/src/app.ts`、`routes/**`、`{community,admin,ocr,speech,tts,recognitions,auth,db}/**`、
`miniprogram/**`、`tools/prepare-wechat.mjs`、`packages/**`、`db/**`、根 `package.json`/lock、
`.github/workflows/**`。`auth/idempotency.ts`（`claim/complete/release` 台账）与
`community/store.ts`（CAS 同步临界区）只作**只读 import / 只读参考**。

> 派单里提到的 `services/api/src/admin/idempotent-write.ts` **在基线上不存在**
> （`git cat-file -e HEAD:services/api/src/admin/idempotent-write.ts` 报
> `fatal: path ... does not exist in 'HEAD'`；`git log --follow --all` 只命中一个不包含该文件的历史提交）。
> 因此"原子占位"思路改以 `services/api/src/auth/idempotency.ts`（同仓库内唯一现存实现）为准。

## 4 `ReferenceState` 的完整取值与计算规则

契约闭集**只有两个取值**：`available`、`unavailable`。语义按
[state-contract.md](../architecture/state-contract.md) 与
[records.mjs](../../packages/reference/records.mjs) 的 `deriveReferenceState` 确定为
「**该目标当前是否对该主体可得**的逐次派生结论」：

- `available`：目标当前存在、未下架/未删除、且对**当前用户**可见 ⇒ 可以跳转；
- `unavailable`：其余一切（版本已替换、来源失效、被隐藏/删除、无权限、无目标、端口未接线、读取失败）；
  **不区分"隐藏"与"不存在"**。

计算规则（`service.ts::referenceStateFor`，三道保守取值，任一命中即 `unavailable`）：

1. `target_ref === null` ⇒ `unavailable`。依据：没有可核验的目标，就拿不到"目标当前对本人可用"的
   **正证据**；契约只允许二值，`unavailable` 是保守侧（fail-closed）。这也是本片自认的可能争议点之一（见 §10）。
2. 端口声明 `available !== true`（未接线）⇒ `unavailable`。**即使**该端口的 `stateOf` 返回 `available`
   也不采信（冗余第二道边界；`messages-security.test.mjs` 用"矛盾端口"用例断言）。
3. 端口逐次核验结果非 `'available'`（含抛错、返回 `unknown`/`true`/对象/null）⇒ `unavailable`。
   规范化只发生在 `reference.ts`，端口异常**不向上抛**、不外泄原因细节。

生产默认端口是 `createUnwiredReferencePort()` ⇒ **现阶段所有带目标的消息**
`reference_state` 恒为 `unavailable`；本片**不宣称**权限跳转已可用。真实接线（阶段 2）只需替换该工厂。
`reference_state` **不入库**：每次读取（含幂等重放）重新派生，目标状态一变立即可见。

## 5 未读一致性证据（含并发实测计数）

设计：`unread-count` 是**派生量**——`store.countUnread(ownerId)` 每次现算
`read_at === null` 的**本人**行数，不是计数器，因此不存在计数漂移路径。
读状态的唯一写入口是 `store.markReadIfUnread`：**同步**临界区内的比较并写入（CAS）+ 单调
（只允许 `null → 时刻`，已是已读则原样返回、`transitioned: false`）。

实测（`tests/unit/messages-concurrency.test.mjs`，7/7 通过）：

| 场景 | 观测量 | 实测值 |
| --- | --- | --- |
| 本人两条消息（一未读一已读） | `unread-count` | `1` |
| 标记未读消息 | `read_at` | 有值（`2026-10-12T03:00:0x.000Z`） |
| 标记后 | `unread-count` | `0` |
| 重复标记（新幂等键，`If-Match: "1"`） | `read_at` / `unread-count` | **不变** / `0` |
| 同键重放 | `read_transitions` | `1`（重放不产生第二次写入） |
| **两条并发标记同一消息**（屏障保证两条都先读完再写） | 两个响应的 `read_at` | **完全相同** |
| 同上 | `snapshotCounts().read_transitions` | **1**（只发生一次转换） |
| 同上 | `unread-count` | `0`（不是 `-1`，也不是 `2`） |
| 同上 | 派生不变量 | `count === 本人 read_at===null 行数` |
| 挂起点交错（迟到者的检查早于别人写入） | 迟到者 `read_at` | 复用首次时刻，未改写 |
| 5 条消息并发标记 + 全部再标记一轮 | `read_transitions` | `5` → 仍 `5`（单调 + 幂等） |
| 同键并发（3 条请求） | 结果 | 恰好一次 `created/生效`，两/三方拿到同一状态 |

未读数为 0 的边界：无消息 ⇒ `0`；全部已读后重复标记 ⇒ 仍 `0` 且 `>= 0`（`typeof count === 'number'`）。

## 6 归属与"同形 404"证据

- `listMessages` 的存储原语是**归属域**的 `listMessagesByOwner(ownerId)`（存储层不把他人行交给上层），
  服务层再做主体校验 ⇒ 他人消息不出现在任何列表里，未读数也按接收者归属。
- `markMessageRead` 对"不存在"与"存在但不是我的"**共用同一个** `notFound()`
  （`ApiError('NOT_FOUND', '消息不存在或不可用')`），因此
  `buildErrorEnvelope(err, {request_id, execution_mode})` 的 JSON 串**逐字节相同**。
  实测：`errorEnvelopeJson(他人未读消息) === errorEnvelopeJson(他人已读消息) === errorEnvelopeJson(不存在的 uuid)`。
- 归属被**两层**独立强制：服务层预检 `record.owner_id !== user.userId`，
  存储层 CAS 期望 `owner_id` 不符 ⇒ `OWNER_CHANGED` ⇒ 映射回同一个 `NOT_FOUND`。
  **回退-复跑实测：只去掉其中一层，反例依然通不过**（见 §8 实验 ②）；两层都去掉才失败。
- 主体域：缺会话 ⇒ 401 `SESSION_REQUIRED`；后台会话（role=admin）⇒ 403 `SCOPE_DENIED`（消息属用户会话域）。
- 目标侧不泄露：`reference_state` 是唯一与目标相关的输出，`available`/`unavailable` 不可区分
  "隐藏"与"不存在"；`target_ref` 本身由调用方给出，不构成旁路。实测"目标存在但无权"与"目标不存在"
  两条消息的可观测字段逐项相同（`id`/`created_at` 是**消息自身**身份，不是目标身份）。

## 7 分页游标稳定性

排序口径 `(created_at DESC, id DESC)`（[state-contract.md](../architecture/state-contract.md)）。
游标 = `base64url(payload).HMAC-SHA256(signingKey)`，逐项绑定 `kind`/`subject`/`route`/`filter`/`sort`
与 `expires`（15 分钟）；客户端改不动内容，他人游标也不能复用。

- **同刻多条**：注入冻结时钟使 5 条消息 `created_at` 全等，`limit=2` 翻 3 页 ⇒
  取到 5 条、无重复，且顺序恰为 `id` 降序（证明"同时刻用 id 全序兜底"真的生效）。
- `items ≤ 50`：60 条消息 `limit=50` 与 `limit=7` 两种翻法均恰好取到 60 条且顺序一致。
- 翻页途中插入新消息：既有快照不漏不重；新消息出现在**新开的第一页**（不被旧游标吞掉）。
- 非法游标（篡改签名/其它密钥/换 kind/换主体/换排序/换过滤/过期/结构非法/非 JSON/无分隔点）⇒
  400 `INVALID_CURSOR`；`cursor` 空串或 >2048 字符 ⇒ 400 `INVALID_REQUEST`；
  `limit` 为 0/51/-1/1.5/字符串/NaN ⇒ 400 `INVALID_REQUEST`；查询参数含契约**未**声明的字段 ⇒ 400 `INVALID_REQUEST`。

**设计取舍（自认风险点）**：本片**没有**给游标加"可见集合水位"（不像
[admin/cursor.ts](../../services/api/src/admin/cursor.ts) 那样集合一变就失效）。原因是消息是**追加密集**的
收件箱：任何一条新消息都会让水位游标失效，翻页几乎必然 `INVALID_CURSOR`。keyset
`(created_at,id)` 对"第一页时刻的快照"保证不漏不重，"新到的消息"由新开第一页 + 独立的
`unread-count` 覆盖（未读数**永不由当前页估算**）。

## 8 反例清单（可单独指出）与回退-复跑

### 8.1 反例（≥12 类，共 32 条用例，全部通过）

| # | 反例 | 期望 | 用例文件 |
| --- | --- | --- | --- |
| 1 | 他人消息 `markMessageRead` | 404 `NOT_FOUND`，且与"不存在"逐字节同形 | messages-security |
| 2 | 他人消息出现在自己的 `listMessages` | 不出现（0 条），未读数按接收者归属 | messages-security |
| 3 | 未知消息 id（合法 uuid） | 404 `NOT_FOUND` | messages-service |
| 4 | 非法 uuid | 400 `INVALID_REQUEST` | messages-service |
| 5 | `type` 闭集外 / 缺失 / 非字符串（创建口） | 400 `INVALID_REQUEST` + `INVALID_ENUM`，不落库 | messages-security |
| 6 | 重复标记同一消息 | `read_at` 不变、未读不再减少、`read_transitions` 不增 | messages-service / concurrency |
| 7 | **并发标记同一消息** | 未读**只减一次**（`read_transitions === 1`、两个 `read_at` 相同、`count === 0`） | messages-concurrency |
| 8 | 未读数为 0 的边界（无消息/全已读/重复标记） | `0`，且 `>= 0` | messages-service |
| 9 | `limit` 超上限（51）或非法（0/-1/1.5/字符串/NaN） | 400 `INVALID_REQUEST` | messages-service / pagination |
| 10 | 非法游标（篡改/换主体/过期/结构非法等 12 种） | 400 `INVALID_CURSOR` / `INVALID_REQUEST` | messages-pagination |
| 11 | 多余字段（查询参数、创建口含 `read_at`/`id`/`revision`/`reference_state`） | 400 `INVALID_REQUEST` + `UNKNOWN_FIELD` | messages-service / security |
| 12 | **目标不可见时 `reference_state`** | 不得假装可用 ⇒ `unavailable`，且与"目标不存在"不可区分 | messages-security |
| 13 | 目标端口未接线 / 抛错 / 返回非闭集 | 一律 `unavailable`（含"矛盾端口"） | messages-security |
| 14 | 分页同刻多条 | 不漏不重（5 条 / limit 2 / 3 页） | messages-pagination |
| 15 | 出口嵌套改动（`target_ref.id`、`read_at`、数组 push） | 动不了存储 | messages-immutability |
| 16 | 入口改动（入库后改调用方对象） | 动不了存储；存储记录深冻结 | messages-immutability |
| 17 | 创建口非法入参（19 组：owner/event_key/target_ref/注入字段） | 400 `INVALID_REQUEST`，全部不落库 | messages-security |
| 18 | 主体：缺会话 / 后台会话 | 401 `SESSION_REQUIRED` / 403 `SCOPE_DENIED` | messages-service |
| 19 | `Idempotency-Key` 缺失/过短；同键异体；处理中 | 400 / 409 `IDEMPOTENCY_CONFLICT` / 409 `REQUEST_IN_PROGRESS` | messages-service / concurrency |
| 20 | `If-Match` 缺失 / 非法 / 不匹配 | 428 `REVISION_REQUIRED` / 400 / 409 `REVISION_CONFLICT` | messages-service |
| 21 | 事件去重（同 `(owner,event_key)`） | 只创建一次；命中去重**不重置**读状态；并发只生效一次 | messages-security / concurrency |
| 22 | 契约闭集被扩展（`Message` 多字段、错误码外扩） | 契约用例立即失败 | messages-contract |

### 8.2 回退-复跑（去掉守卫/去掉原子性 ⇒ 反例失败）

变异脚本：`E:\GengYunCommander\.gy-i17-evidence\mutate.mjs`（最小改动 + 出现次数校验 + 还原后 SHA256 比对）。

**实验 ①（去掉原子性/单调守卫）**：删掉 `store.ts::markRead` 里的
`if (current.read_at !== null) return { ok: true, record: cloneDeep(current), transitioned: false };`
（⇒ 每次都无条件改写 `read_at`）。

```
✖ 并发反例（主）：同一消息两条并发标记 ⇒ 未读只减一次，两个响应 read_at 相同 (4.9888ms)
  AssertionError [ERR_ASSERTION]: 两者必须报告同一个首次已读时刻
  + actual '2026-10-12T03:00:04.000Z'  - expected '2026-10-12T03:00:05.000Z'
✖ 并发反例：挂起点交错（迟到者的检查发生在别人写入之前）⇒ 迟到者不得改写 read_at
  AssertionError: 迟到者必须复用首次 read_at，不得改写
✖ 单调性：批量并发标记/重复标记后，未读数只减不增且等于派生值（无漂移）
ℹ tests 7  ℹ pass 4  ℹ fail 3   [exit code: 1]
```

还原后（`store.ts` SHA256 与变异前一致：`50BC98CC…7A10EF`）复跑：`ℹ tests 7 ℹ pass 7 ℹ fail 0 [exit code: 0]`。

**实验 ②（去掉归属守卫）**：删掉服务层两处
`if (record === null || record.owner_id !== user.userId) throw notFound();`。

```
ℹ tests 6  ℹ pass 6  ℹ fail 0  [exit code: 0]     ← 反例**没有**失败
```

结论：**只去掉一层不够** —— 存储层 CAS 仍带 `owner_id` 期望，返回 `OWNER_CHANGED` 后被映射成同一个
`NOT_FOUND`（这是有意的冗余边界）。把 CAS 期望一并去掉（变异 ②b）后：

```
✖ 反例·归属：他人消息 既不能标记也不能列出；标记报错与"不存在"逐字节同形
  Error: 期望抛出错误，但没有抛出          ← 他人成功标记了别人的消息
ℹ tests 6  ℹ pass 5  ℹ fail 1  [exit code: 1]
```

**实验 ③（去掉列表归属过滤）**：把 `store.listMessagesByOwner` 的 `filter(owner_id === ownerId)` 删掉。

```
✖ 反例·归属：他人消息 既不能标记也不能列出；标记报错与"不存在"逐字节同形
  AssertionError [ERR_ASSERTION]: 他人消息不得出现在列表
  2 !== 0
ℹ tests 6  ℹ pass 5  ℹ fail 1  [exit code: 1]
```

三次实验全部还原后复核：`store.ts` = `50BC98CC233D76B05DBE4D2ED8BA47742DE82A4FAA202F21DC54685BAE7A10EF`、
`service.ts` = `4D49F0B77CE891ACC423FE28E4478691B5A787B6BF76532A3A600526214D9406`（与变异前逐一相同），
复跑 `node --test` 全绿。

## 9 门禁原始输出（`ffd5bf73` + 本片改动）

**`npm run lint`**

```
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
[exit code: 0]
```

**`npm run test:unit`**（本片用例加入前 / 后，同一工作区）

```
before（临时移出 tests/unit/messages-*.test.mjs）:  ℹ tests 1347  ℹ pass 1346  ℹ fail 0  ℹ skipped 1  [exit code: 0]
after :                                        ℹ tests 1379  ℹ pass 1378  ℹ fail 0  ℹ skipped 1  [exit code: 0]
差值  : +32 tests / +32 pass / +0 fail / +0 skipped
```

**`npm run test:contract`**：`ℹ tests 6 ℹ pass 6 ℹ fail 0 [exit code: 0]`（6 条全部通过，含
「API 错误码集合与 openapi ErrorCode 枚举一致」）。

**`npm run test:docs`**：

```
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
[exit code: 0]
```

**直跑 `node --test "tests/unit/messages*.test.mjs"`**：

```
ℹ tests 32  ℹ suites 0  ℹ pass 32  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0  [exit code: 0]
```

**`git diff --check`**（先 `git add -A -N .` 让新增文件进入比对）：无输出、`exit code: 0`
（仅有 LF→CRLF 的常规 `core.autocrlf` 提示，非空白错误）。

## 10 契约缺口、跨片依赖，以及自认最可能被挑出的 3 点

**契约缺口（如实记录，本片不擅自补）**

1. `Message` **没有正文/标题/actor 字段**，也没有"来源事件 id"字段 ⇒ 消息在 UI 上无法自解释内容，
   必须靠客户端拿 `target_ref` 再请求目标。若产品需要"消息预览文案"，需先改契约（本片不改）。
2. `reference_state` 是**必填二值**，对"没有 `target_ref`"的 `system` 消息没有第三种取值可选 ⇒
   本片取保守值 `unavailable`（见 §4 第 1 条）；是否应新增"not_applicable"或允许该字段为 null，
   属契约演进问题。
3. `markMessageRead` 的 `x-version-required: true` + `If-Match` 与"读标记不改变内容版本"存在张力：
   本片按仓库既有 `likePosts`（`PUT /posts/{id}/like` 同样要求 `If-Match`+`Idempotency-Key`，
   且**不**改内容 revision）的口径，**读取标记不改 `revision`**，因此 `If-Match` 是针对**事件版本**的：
   不匹配时返回 409（用例覆盖），而"重复标记"保持 200/幂等（派单验收明写要求）。
   若监工认为读状态变化也应让强 ETag 变化，本片需要改口径（会让"重复标记"变成 409，与验收字面冲突）。
4. `Message` 没有"来源事件 + 版本"的持久唯一键字段 ⇒ 去重键 `event_key` 只能作为**内部字段**存在，
   不参与契约校验；跨进程/持久化去重需阶段 2 的 `(owner_id, event_key)` 唯一约束（本片内存实现已具备）。

**跨片依赖（本片无法独立完成，未接线）**

1. 路由装配与 `meta`/封套：属阶段 2；`services/api/src/app.ts` 被 #87 占用（上游 `f8da03b` 已改 `app.ts`）。
2. 目标可用性读取端口：需要 `post`/`comment`（#15）、`species`/`herbicide`/`scheme`（#7/#3）、
   `conversation`（#12）、`job`（#9）等域的"当前可见性"查询；本片只有 `createUnwiredReferencePort`。
3. 事件写入消息：`comment`/`like`（#15）、`moderation`（#14）事件由各域调用 `appendMessage` ——
   本片只提供口，**未接线任何调用方**。
4. 注销去身份同步（"注销作者展示已注销用户"）：属 GY-I19。
5. PG 持久化（消息行 + `read_at` 单调整位 + `(owner_id, event_key)` 唯一约束 + 幂等台账）：属阶段 2；
   `db/**` 是共享文件，本阶段不碰。

**自认监工最可能挑出的 3 个点**

1. **`target_ref === null` 时取 `unavailable` 是否正确**。另一读法是"没有目标就无所谓可用性，
   应报 `available`"。本片的依据是 fail-closed：`available` 是"目标当前对本人可用"的**正证据**，
   无目标即无正证据；且契约只有二值。若监工要求 `system` 消息报 `available`，改动点是
   `service.ts::referenceStateFor` 第一行 + 对应用例（一行改动，但语义相反）。
2. **游标没有"可见集合水位"**（§7）。选择"追加密集收件箱用 keyset、watermark 会频繁失效"，
   代价是翻页期间新到的消息不在旧游标窗口内（由新开第一页 + 服务端聚合的未读数覆盖）。
   若监工坚持 watermark 口径，需改 `service.ts` 的游标载荷与 `listMessages`（并发/分页用例需同步调整）。
3. **`If-Match` 在当前阶段"几乎总能匹配"**（读取标记不改 `revision` ⇒ 消息 `revision` 恒为 1）。
   409 `REVISION_CONFLICT` 只有客户端送错 ETag（如 `"2"`）时才出现（用例覆盖），
   因此该头在阶段 1 的"防并发"作用弱于"防错"。若监工认为应由读状态推进 revision，
   则与"重复标记幂等且 `read_at` 不变"的验收条目冲突，需要监工裁定口径。

另附两点**主动暴露**的诚实边界（不是辩解，是免得被当成"已完成"）：本片**没有**路由、**没有**持久化、
**没有**任何真实目标读取实现，因此**不得**被引用为"消息系统已端到端可用"；
`docs/architecture/contract-status.json` 里三条 operationId 仍应保持 `route_mounted: false`、`status: planned`。

## 11 合并上游后在**合成树**上复跑（PR head 所在树）

按指挥要求 `git merge upstream/main` 两次，**均无冲突、无手工解冲突**（`git merge-tree --write-tree`
预检返回单一树号、无 `CONFLICT`；且与本片文件零重叠）：

| 次序 | 合并对象 | 内容 |
| --- | --- | --- |
| 第 1 次 | `13262f19` | #87 GY-I09 识别闭环、#99 转写并发诊断改走 stderr |
| 第 2 次 | `6337f18` | #101 GY-I18 后台运营与开关服务层（阶段 1b） |

门禁原始输出（**第 2 次合并后的合成树**）：

```
$ npm run lint
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
[exit code: 0]

$ npm run test:unit
before（临时移出 tests/unit/messages-*.test.mjs）: ℹ tests 1437  ℹ pass 1436  ℹ fail 0  ℹ skipped 1  [exit code: 0]
after                                        : ℹ tests 1469  ℹ pass 1468  ℹ fail 0  ℹ skipped 1  [exit code: 0]
差值                                          : +32 tests / +32 pass / +0 fail / +0 skipped

$ npm run test:contract
ℹ tests 6  ℹ pass 6  ℹ fail 0  [exit code: 0]

$ npm run test:docs
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
[exit code: 0]

$ node --test "tests/unit/messages*.test.mjs"
ℹ tests 32  ℹ suites 0  ℹ pass 32  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0  [exit code: 0]

$ git add -A -N . ; git diff --check
（无输出）[exit code: 0]
```

三次同口径基线测量（都是"把本片用例移出后"测的）：`ffd5bf73` = 1347 / 1346；
`+ #87／#99` = 1390 / 1389；`+ #101` = 1437 / 1436 ⇒ 本片差值**恒为 +32，fail 恒为 0**。

**剩余风险（交给监工）**

1. **CI 未运行**：PR 的 8 个 workflow run 全部是 `conclusion=action_required`
   （fork PR 首次贡献者需维护者点"Approve and run"）；`statuses` 为 `pending`（总数 0）⇒
   PR 的 `mergeable_state = unstable` **不代表检查失败**，但也**不是**"CI 通过"。
2. `mergeable = true`、`changed_files = 15`（A=15 / M=0，`git diff --name-status upstream/main...HEAD`）。
3. 本片**未修改** `docs/architecture/contract-status.json`（三条 operationId 仍应为 `planned`）。
4. 每次上游前进都会抬高 `test:unit` 基线；若监工在更新的 main 上复跑，请以"移出本片用例后"为基线再比对 +32。
