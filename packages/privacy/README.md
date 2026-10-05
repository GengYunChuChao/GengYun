# packages/privacy · 用途授权、外发账本与隐私撤回守卫（GY-I27 / #29）

纯 ESM 模块，无第三方依赖，Node 18+ 可用。授权错误码与枚举只读消费
`packages/contracts/states.json`，本模块是前后端一致的唯一事实来源。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `constants.mjs` | 冻结枚举 + `error_status_map` + `statusForErrorCode`（与 states.json 逐项一致） |
| `errors.mjs` | `PrivacyError` + `toErrorEnvelope`（错误封套与 services/api 的 ErrorEnvelope 同形） |
| `consent.mjs` | 用途授权存储（内存实现，可插拔 Postgres）：grant/withdraw/currentEpoch |
| `guard.mjs` | 授权守卫：**已认证执行入口** `requireConsent`（强制正整数 `auth_epoch` + 核对当前版本）与**纯用途查询** `assertConsent` / `assertAccountActive`（二者分开，不可混用） |
| `commit-gate.mjs` | **提交一致性契约**：`createCommitGate` 内存参考实现（同步一致快照 + 无 await 原子临界区 CAS 提交原语 `commit`）。**不做事后判错**：`apply` 必须同步完成，不得启动异步副作用 |
| `writeback.mjs` | **受控数据介质**：`createMemoryWritebackMedium`（`{ rows: native Map }`）+ `assertWritebackMedium`（构造期拒绝含函数属性 / 非原生 Map 的介质）。写入由账本自身 `Map.prototype.set` 同步完成，写路径内**无调用方函数** |
| `ledger.mjs` | 外发账本：`reserve` / `markSent` / `guardWriteback` / `getWriteback` / `revokeInFlight`。派发与**回写的实际结果写入**都在原子 `commitGate.commit` 的同一临界区内完成（另有非权威异步预检） |
| `deletion.mjs` | 模块删除处理器注册协议 + 第三方删除请求/确认/失败（不把请求当完成） |
| `redact.mjs` | 日志脱敏：私有正文/图片/音频/精确坐标/凭据 |
| `index.mjs` | 统一出口 |

## 与契约字段对照

| 本模块常量 | 契约来源（states.json） | 迁移 0003 表/枚举 |
| --- | --- | --- |
| `CONSENT_PURPOSES` | `ConsentPurpose` | `consent_purpose` |
| `MEDIA_PURPOSES` | `MediaPurpose` | （0001 `media_purpose`） |
| `THIRD_PARTY_STATES` | `ThirdPartyState` | `third_party_state` |
| `DELETION_STATES` | `DeletionState` | `deletion_state` |
| `EXPORT_STATES` | openapi `Export.state` | `export_state` |
| `ERROR_STATUS_MAP` | `error_status_map` | — |

## 授权中间件挂载说明（GY-I02 已合并，接线由后续任务完成）

`packages/privacy/guard.mjs` 的 `requireConsent` 是**纯模块**，不直接改 `services/api/src/app.ts`
（该文件归 GY-I02）。它是**已认证执行入口**：挂到 Fastify 路由 preHandler 时必须由会话层填充
`authEpoch`——缺失/null 得到 `SESSION_REQUIRED`，非正整数得到 `INVALID_REQUEST`，
与当前 `auth_epoch` 不一致（旧会话/注销/停用）得到 `ACCOUNT_INACTIVE`。**纯用途查询**请用
`assertConsent`（不做身份版本核对，**不代表可执行**）。挂载方式：

```js
import { createPrivacyGuard } from '../packages/privacy/guard.mjs';
// account 提供者由 services/api 注入：从会话/DB 读账号状态与 auth_epoch
const guard = createPrivacyGuard({ account: accountProvider, consentStore: consentStore });

// 示例：语音问答外发前挂载
app.route({
  method: 'POST',
  url: '/speech/transcriptions',
  preHandler: async (req) => {
    const identity = { userId: req.userId, authEpoch: req.authEpoch }; // 由 GY-I04 会话层填充
    await guard.requireConsent({ purpose: 'recording', dataType: 'voice_question' })(identity);
  },
});
```

身份上下文 `{ userId, authEpoch }` 由调用方注入；`account` / `consentStore` 为可插拔接口。
单元测试注入合成账号与内存 consentStore，**不依赖微信真实登录**，避免与 GY-I04 形成依赖循环。

## 迁移 0003 位置与依赖顺序

`services/api/db/migrations/0003_privacy_consent.sql` 位于迁移运行器
（`services/api/src/db/migrate.ts` 的 `DEFAULT_MIGRATIONS_DIR`）的扫描目录，可被 `npm run db:migrate`
发现（回归断言见 `tests/privacy/migration.test.mjs`：运行器发现含 `0001` 与 `0003`，且 `0001` 在 `0003`
之前；`0002` 由 GY-I03 提供）。其
`consent_records` / `privacy_epochs` / `exports` 以 `users(id)` 为外键，**必须在 0001（GY-I02
初始迁移）之后执行**；对 0002 无硬依赖，建议整体顺序 `0001 → 0002 → 0003`。本 PR 不包含/不修改
0001、0002（分别由 GY-I02、GY-I03 提供）。

回滚脚本置于 `services/api/db/migrations/rollback/0003_privacy_consent.down.sql`：运行器文件模式为
`NNNN_name.sql`，`.down.sql` 不合规、`..._down.sql` 会与 0003 版本号重复，故回滚脚本单独放在子目录，
不进入正向发现集。

## 边界（不实现）

- 完整 7/30 日删除（对象存储/备份/供应商副本/恢复清单重放）由 **GY-I19** 集成；本模块只提供
  `registerModule` 协议、第三方删除请求/确认/失败接口与 `completionStatus` 派生判定。
- `deletion_tombstones` / `backup_inventory` 属 GY-I19 独立受控清单，不在本迁移范围。
- 训练**不是**首版 `ConsentPurpose`；`user_training_consents.training_enabled` 默认 `false`，
  启用需独立同意 + 模型谱系验收（迁移 CHECK 强制），首版无放行训练路径。
- 用户端页面（手选地区/文字替代交互）不实现，由 GY-I05/F12 消费 `CONSENT_REQUIRED` 错误码兜底。
- **提交门禁的内存参考实现不等价于实库事务**：`createCommitGate` 依赖单线程同步临界区；生产部署须由
  部署方以单事务 + 行锁 / 行版本 CAS 实现同一 `commit` 契约（**校验读取与实际结果写入在同一事务内**
  完成并一起提交）并注入。PGlite（0.5.8 / PG18.x）内存验证**不等于** PG17.11 实库验收，实库验收由
  集成阶段（GY-I19 等）在真实 PG17.11 上完成。

## 硬红线落实

- 不默认第三方训练：`ledger.reserve` 对 `external_inference` 外发要求接收方 `no_training_verified`。
- 日志脱敏：所有日志/审计出口复用 `redactForLog`，不含私有正文、图片、音频、精确坐标、凭据。
- 不把请求当完成：`deletion.completionStatus` 只在**所有 handler 在线/备份均 `completed` 且完成证据齐全**、
  且所有第三方均 `confirmed`（有证据）时置 `completed`；`failed` / `unsupported` 一律保留阻塞——
  「已证实完成」与「无法删除/无法证实」不等价。
- 错误出口只出固定安全分类：`deletion` 的 handler 异常/返回码经白名单映射，原始 SDK 文本不进入用户回执。
- 身份与用途不可分离：`ledger.markSent` / `guardWriteback` 的**唯一权威提交边界**是
  `commitGate.commit(expected, { precondition, apply })`。其内存参考实现的 `commit` 体内
  **不含任何 `await`**：在同一个不可分割的同步临界区内一次性重读「账号身份（状态 + auth_epoch）
  + 全部必需用途（epoch + 授予）+ 接收方（enabled + config_version + 训练/删除条款）」，逐项与
  `reserve` 快照比对，并核对外发记录的同步前置条件（在途状态 + revision）；**全部通过才执行 `apply`**。
  因为校验与提交之间没有 await，任何 `await` 边界上的写者（含**不经** `revokeInFlight` 的
  注销/停用/用途撤回）都无法被插入——窗口被**结构性消除**，而非「再读一次异步快照」。
  提交路径上另有一段**非权威异步预检**（仅早退 + 细化错误码）：它读到的是某一时刻的快照、可能过期，
  **不构成安全保证**；即使预检因读到旧快照而放行，原子提交仍会用同一 tick 的同步快照重新判定并拒绝。
- **回写的实际结果写入在同一临界区，且写入口不是任意函数**：`guardWriteback({ exportId, userId, result })`
  接收的是**数据** `result`（**不接受任何 `write` 回调**）。结果写入发生在 `apply` 内的**账本自身同步
  代码**中，作用于**受控数据介质**（native Map，见 `writeback.mjs`）——**校验不通过 ⇒ 根本不写入 ⇒
  零写入**。这是**结构性保证**：
  - 写路径内**没有调用方代码**：调用方只能提供**纯数据容器** `{ rows: <native Map> }`；
  - 注入物若含**任何函数属性**（如 `write`）→ **构造即抛错**；`rows` 非原生 Map（子类/覆写）→ 同样拒绝；
  - 账本以 `Map.prototype.set.call` 内建方法写入，**不可能**在写路径内启动异步任务。
    于是不存在「被调用时启动异步保存链、事后再判错」的窗口；也不依赖 `constructor.name` 猜测同步性。
  `guardWriteback` 自身**不返回任何可后置消费的授权结论**（只回 `{ written:true, exportId }`）。
  回归见 `tests/privacy/ledger.test.mjs`：R5-1 正向、R5-2 校验前撤回/注销零写入、R5-3 门禁异步返回暂停
  期间撤回/注销仍只在临界区内写一次、R5-4 注入含函数／缺原生 Map 的介质 → 构造即拒绝；
  **R7-1..R7-5** 以「函数返回延迟 Promise」注入（含 `{ write: entry => pending.then(() => save(entry)) }`
  及「rows + 函数」混合介质）验证：**构造即拒绝**、`calls=0 / saves=0`（释放 `pending` 后仍为 0）；
  R7-2/R7-3 撤回/注销 + `revokeInFlight` 后记录 `failed`、`saves=0`、介质零写入；R7-4 正向恰好一次
  （`mediumSize=1`）。
  > **保证范围与依据（本轮纠正）**：此前 README/PR 表述为「构造期强制同步」「异步副作用无法进入」，
  > 该表述**不成立**——修复轮 6 的 `assertSyncWritebackPort` 只比对 `write.constructor.name` 是否为
  > `AsyncFunction`；普通函数 `entry => pending.then(() => save(entry))` 的 constructor 是 `Function`，
  > **通过校验**，而**调用即已启动临界区之外的写链**，返回的 Promise 被忽略、立即回 `written:true`，
  > 随后的撤回/注销 `revokeInFlight` 撤不掉它。本轮改为**结构性方案**：写入口**不再是函数**，调用方
  > 只能给纯数据容器，写入由账本自身同步代码完成。**本模块保证的零写入范围**：任何注入介质含函数、
  > 或 `rows` 非原生 Map ⇒ **构造即拒绝（不投入使用）**；`commit` 未返回 `committed:true` ⇒ 介质不被
  > 写入（结果不落库）。**依据**：写路径内无调用方代码 + 原生 Map 内建同步写入。**默认内存路径**
  > （native Map）即**已验证安全路径**；**实库路径见下方「提交一致性契约」的部署义务**。
- **派发 at-least-once**：`markSent` 把 `reserved→sent` 放进同一临界区提交；真正的第三方网络派发
  发生在临界区之外，**不因事后回滚撤销**（外部调用无法与本地事务绑定）。
- 执行入口不接受省略身份版本：`guard.requireConsent` 强制正整数 `auth_epoch` 并核对当前版本，
  与纯用途查询 `assertConsent` 分开，杜绝「不传 epoch 即绕过」。

## 提交一致性契约（Commit Consistency Contract）

派发（`markSent`）与回写（`guardWriteback`）的原子性由注入的 **commitGate** 提供。适配器必须实现：

```js
commit(expected, { precondition, apply }) -> Promise<{ committed: boolean, reason?: string }>
```

`expected`（`reserve` 时冻结的快照，调用方不可覆盖）：

```js
{
  userId, authEpoch,                 // 账号身份版本（auth_epoch 单调递增）
  requiredConsents: { [purpose]: epoch }, // 全部必需用途的 epoch
  recipientId, recipientConfigVersion,    // 接收方与其绑定版本
  requireRecipientIntegrity,         // external_inference 时为 true：须 no_training_verified + deletion_verified
}
```

契约要求（违反即视为不可用）：

1. 在**同一临界区/事务**内重读上述全部维度并逐项与 `expected` 比对；账号 `authEpoch` 与每个用途
   `epoch` 必须**单调**（撤回/重新授权即前进，旧快照自然失效）。
2. `precondition()`（同步、调用方所有）为假，或任一维度不一致 → **不得执行 `apply`**（即不得发生
   任何实际写入/状态迁移），返回 `{ committed: false, reason }`；`reason ∈ { account, consent,
   recipient, recipient_policy, precondition }`。
3. 校验读取与 `apply` 之间**不得**插入 `await`/IO；否则临界区被撕开，异步窗口复现。
4. `apply` 就是**实际副作用本身**（派发的状态迁移、回写的**结果写入**）。**不得**只把校验放进事务、
   而把实际写入留到事务/临界区之外后置消费——那会把「校验通过」与「结果落库」重新拆开，撤回/注销
   仍可在两者之间发生。`apply` **必须同步完成、不得启动任何异步副作用**：一旦启动（例如
   `() => pending.then(() => save())`），事后再判错也**无法取消**已经启动的写链，故本模块**不做**
   这类事后判错——回写的结果写入改为由**账本自身同步代码**写入**受控数据介质**（见下）。记账方
   **不返回可在以后使用的授权结论**。
5. **写路径内不得存在可调用的调用方代码**。尤其：不得以「先调用、再检查返回值是否为 Promise/是否拒绝」
   作为保护——普通函数 `() => pending.then(...)` 的 `constructor` 是 `Function`，能绕过
   `AsyncFunction` 检查，且调用即已启动写链；也不得以 `constructor.name` 检查替代结构性保证。
   唯一可靠的做法是**让非同步写入结构上无法进入 `apply`**：调用方只提供**纯数据容器**，
   写入由账本自身同步代码完成，写路径内**没有函数**可被调用。
6. 记账方（`ledger`）据此映射错误码：`account → ACCOUNT_INACTIVE(403)`、`consent/recipient → OBJECT_UNAVAILABLE(409)`、
   `recipient_policy → SCOPE_DENIED(403)`、`precondition → OBJECT_UNAVAILABLE(409)`。

两种实现路径（**区分「已验证安全的内存路径」与「注入介质契约要求的部署义务」**）：

- **内存参考实现（已验证安全路径）**（本模块 `createCommitGate` + `writeback.mjs`）：由同步访问器
  `account.identityOf` / `consentStore.snapshotOf` / `recipientStore.currentOf` 构成一致快照，`commit`
  体内无 await，单线程模型下不可交错。**回写写入 = 账本自身代码 `Map.prototype.set.call(medium.rows, ...)`**，
  写路径内**无任何调用方函数**，故异步副作用无法进入——这是**结构性事实**（非 `constructor.name` 猜测）。
  `commit` **不检查 `apply` 的返回值**（不对「返回了 Promise」做事后判错），因为对**已启动**的异步写链
  事后拒绝并不能撤销它。**构造期强制的约束**：缺任一同步访问器、注入介质含**任何函数属性**、
  或 `rows` **非原生 Map** ⇒ **构造即抛错**（`ledger` 拒绝投入使用，漏实现不放行）。
  该路径的零写入性质由 R7-1..R7-5 以**实际 save 计数**验证。
- **数据库部署（部署义务，非本模块可对任意介质结构性强制）**：由部署方以**单事务 + 行锁 / 行版本 CAS**
  实现同一 `commit` 契约——在同一事务内完成校验读取（`SELECT ... FOR UPDATE` / 行版本 CAS）**与实际结果
  写入**（`INSERT/UPDATE`），最后一起 `COMMIT`；并注入 `commitGate`。**校验与写入必须同事务**，否则等价于
  把写入后置到事务之外、窗口复现。**PostgreSQL 17 契约**：本模块只保证「不向临界区注入任意函数」；
  「同一事务内完成写入」是**部署方的义务**，需由实库适配器自证（进程内事务替身/实库用例）。本 PR 未提供
  实库适配器，内存实现**不等价于**实库事务，见上方「边界（不实现）」。内存介质为 `{ rows: native Map }`；
  实库部署须将同一事务内的写入落到 DB，不得后置。

> 覆盖不足时的红线：适配器只提供异步读取（无法给出「同一时刻」的一致快照）时必须**拒绝投入使用**——
> `createExportLedger` 在未注入 `commitGate` 且适配器缺少任一同步快照方法时**构造即抛错**。
