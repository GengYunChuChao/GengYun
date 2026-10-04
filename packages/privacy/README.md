# packages/privacy · 用途授权、外发账本与隐私撤回守卫（GY-I27 / #29）

纯 ESM 模块，无第三方依赖，Node 18+ 可用。授权错误码与枚举只读消费
`packages/contracts/states.json`，本模块是前后端一致的唯一事实来源。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `constants.mjs` | 冻结枚举 + `error_status_map` + `statusForErrorCode`（与 states.json 逐项一致） |
| `errors.mjs` | `PrivacyError` + `toErrorEnvelope`（错误封套与 services/api 的 ErrorEnvelope 同形） |
| `consent.mjs` | 用途授权存储（内存实现，可插拔 Postgres）：grant/withdraw/currentEpoch |
| `guard.mjs` | 授权守卫：`assertConsent` / `assertAccountActive` / `requireConsent`（可注入身份上下文） |
| `ledger.mjs` | 外发账本：`reserve` / `markSent` / `guardWriteback` / `revokeInFlight` |
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

## 授权中间件挂载说明（待 #43 合并后接线）

`packages/privacy/guard.mjs` 的 `requireConsent` 是**纯模块**，不直接改 `services/api/src/app.ts`
（该文件归 GY-I02 / PR #43）。合并后按以下方式挂载到 Fastify 路由 preHandler：

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

## 迁移 0003 依赖顺序

`db/migrations/0003_privacy_consent.sql` 的 `consent_records` / `privacy_epochs` / `exports`
以 `users(id)` 为外键，**必须在 0001（GY-I02 初始迁移）之后执行**；对 0002 无硬依赖，
建议整体顺序 `0001 → 0002 → 0003`。本 PR 不包含 0001/0002。

## 边界（不实现）

- 完整 7/30 日删除（对象存储/备份/供应商副本/恢复清单重放）由 **GY-I19** 集成；本模块只提供
  `registerModule` 协议、第三方删除请求/确认/失败接口与 `completionStatus` 派生判定。
- `deletion_tombstones` / `backup_inventory` 属 GY-I19 独立受控清单，不在本迁移范围。
- 训练**不是**首版 `ConsentPurpose`；`user_training_consents.training_enabled` 默认 `false`，
  启用需独立同意 + 模型谱系验收（迁移 CHECK 强制），首版无放行训练路径。
- 用户端页面（手选地区/文字替代交互）不实现，由 GY-I05/F12 消费 `CONSENT_REQUIRED` 错误码兜底。

## 硬红线落实

- 不默认第三方训练：`ledger.reserve` 对 `external_inference` 外发要求接收方 `no_training_verified`。
- 日志脱敏：所有日志/审计出口复用 `redactForLog`，不含私有正文、图片、音频、精确坐标、凭据。
- 不把请求当完成：`deletion.completionStatus` 只在 handler 全完成 + 第三方全 confirmed/unsupported 时置 completed。
