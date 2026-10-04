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
| `commit-gate.mjs` | **提交一致性契约**：`createCommitGate` 内存参考实现（同步一致快照 + 无 await 原子临界区 CAS 提交原语 `commit`） |
| `ledger.mjs` | 外发账本：`reserve` / `markSent` / `guardWriteback` / `revokeInFlight`（唯一提交边界 = 原子 `commitGate.commit`；另有非权威异步预检） |
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
  部署方以单事务 + 行锁 / 行版本 CAS 实现同一 `commit` 契约并注入。PGlite（0.5.8 / PG18.x）内存验证
  **不等于** PG17.11 实库验收，实库验收由集成阶段（GY-I19 等）在真实 PG17.11 上完成。

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
  **不构成安全保证**；即使预检因读到旧快照而放行，原子提交仍会用同一 tick 的同步快照重新判定并拒绝
  （回归见 `tests/privacy/ledger.test.mjs` 的 R4「暂停第 2 次 get」「返回过期 epoch」两组用例）。
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

1. 在**同一临界区**内重读上述全部维度并逐项与 `expected` 比对；账号 `authEpoch` 与每个用途 `epoch`
   必须**单调**（撤回/重新授权即前进，旧快照自然失效）。
2. `precondition()`（同步、调用方所有）为假，或任一维度不一致 → **不得执行 `apply`**，
   返回 `{ committed: false, reason }`；`reason ∈ { account, consent, recipient, recipient_policy, precondition }`。
3. 校验读取与 `apply` 之间**不得**插入 `await`/IO；否则临界区被撕开，异步窗口复现。
4. 记账方（`ledger`）据此映射错误码：`account → ACCOUNT_INACTIVE(403)`、`consent/recipient → OBJECT_UNAVAILABLE(409)`、
   `recipient_policy → SCOPE_DENIED(403)`、`precondition → OBJECT_UNAVAILABLE(409)`。

两种实现路径：

- **内存参考实现**（本模块 `createCommitGate`）：由同步访问器 `account.identityOf` /
  `consentStore.snapshotOf` / `recipientStore.currentOf` 构成一致快照，`commit` 体内无 await，
  单线程模型下不可交错。**缺任一同步访问器即构造即抛错**（`ledger` 拒绝投入使用，漏实现不放行）。
- **数据库部署**：由部署方以**单事务 + 行锁 / 行版本 CAS**实现同一 `commit` 契约（`SELECT ... FOR UPDATE`
  于同一事务内读取并提交），并注入 `commitGate`。内存实现**不等价于**实库事务，见上方「边界（不实现）」。

> 覆盖不足时的红线：适配器只提供异步读取（无法给出「同一时刻」的一致快照）时必须**拒绝投入使用**——
> `createExportLedger` 在未注入 `commitGate` 且适配器缺少任一同步快照方法时**构造即抛错**。
