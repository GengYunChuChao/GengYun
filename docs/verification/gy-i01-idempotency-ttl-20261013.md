# GY-I01 普通幂等回执 24 小时保留期修订

日期：2026-10-13。作者 cxhhandsome；基线正式 main `b1f6ab0e4dc304d2dd621d6a20852b31ccbfab3e`。
[领取记录](https://github.com/GengYunChuChao/GengYun/issues/1#issuecomment-6140570173)；仅 Refs #1，整项保持开放。
证据绑定包含本记录的作者提交；实际 reviewed_sha、CI 和合并状态以 PR 作者 COMMENT／独立批复为准。

## 问题与修订范围

[冻结状态协议](../architecture/state-contract.md)第 34 行要求普通幂等记录保留 24 小时。
原认证默认及识别／OCR／ASR／TTS 共用的 `IDEMPOTENCY_TTL_SECONDS` 为 5 分钟：超过该窗口同键重试会失去原结果引用，可能重新建会话／任务。
修订共用常量为 `24 * 60 * 60`，认证默认改为复用该常量，API README 同步。
未修改业务路由、任务状态、存储实现、迁移、权限或冻结接口字段；PR #106／#110 的装配仍属原写手范围。

保留期只适用于普通回执，不延长用户 7 天／后台 8 小时会话，不要求持久业务唯一键随之失效。
重放仍按原结果引用重新检查当前状态；退出、停用、epoch 变化和到期拒绝沿用现有校验。
认证重放换发令牌时，原会话 ID、会话绝对到期时间与回执到期时间均不滑动，台账不保存可用令牌。

## 实际验证

Windows；Node `v24.19.0`、npm `11.17.0`、Fastify `5.12.5`、TypeScript `5.9.3`。
子进程清理业务／凭据环境，只使用合成身份、替身媒体／提供者和测试数据。

| 层次 | 命令／证据 | 实际结果 |
| --- | --- | --- |
| 受影响组件／产品装配 | `node --test --test-reporter=spec tests/unit/idempotency-job-ttl.test.mjs tests/unit/auth-store-pg.test.mjs tests/unit/auth-guards.test.mjs tests/unit/recognitions-api.test.mjs tests/unit/ocr-service.test.mjs tests/unit/ocr-state.test.mjs tests/unit/speech-service.test.mjs tests/unit/speech-state.test.mjs tests/unit/tts-service.test.mjs tests/unit/tts-state.test.mjs tests/unit/auth-routes.test.mjs tests/unit/api-errors.test.mjs tests/contract/contract-codes.test.mjs` | 346 通过、0 失败、0 跳过；包含 Fastify inject 与 PGlite SQL，后者不是 PG17 证据 |
| 原生数据库／实际 HTTP | `node tests/integration/auth-privacy-pg.mjs`，仅注入独立本机测试库的 `AUTH_PRIVACY_TEST_URL` | PG17.11 新建合成集群、受限 LOGIN、实际回环 HTTP，26 组通过；已停止测试集群 |
| 缺陷敏感度 | 作者隔离 checkout 临时恢复基线的 `auth/idempotency.ts` 与 `auth/service.ts`，运行 7 项保留期／会话边界用例，finally 按原字节恢复 | 原实现 7 失败；候选实现 7 通过，不以模型输出代替反例 |
| 类型／卫生 | `node tools/lint-workspaces.mjs` | API／后台 `tsc --noEmit` 与仓库卫生通过 |
| 文档一致性 | `node tools/run-python.mjs tools/validate_development_docs.py` | 27 项编号、依赖、F／AC／Q、链接及表格通过 |

认证测试覆盖 5 分钟之后仍命中、24 小时前最后 1ms、精确到期边界、同键异体冲突、唯一会话、无明文令牌和非滑动时效。
四类任务各运行真实服务代码，统计替身提供者调用一次，6 分钟／24 小时前重放返回原 job ID，到期后普通回执清理一次；不据此要求再次计费。
原生 PG 进一步核对保存的 expires_at、会话 ID／时效、合成身份交换次数、退出拒绝、旧回执行实际删除，以及后台 8 小时过期后不新增会话。
时间边界采用注入应用时钟，没有真实等待 24 小时；数据库和 HTTP 为真实本机组件，微信身份交换为明确合成替身。

DSH `0.2.0-rc.2`／连接插件 `0.7.2` 的 Step-5-Preview 仅辅助反例文字初稿，耗时约 89.7 秒，17 个工具插件禁用，无工具事件。
未向其提供项目源文件、真实数据或业务凭据，未派发文件读写任务；模型把“状态变化”宽泛列为拒绝条件，作者按具体撤销／epoch／凭据校验细化，不将其视为独立审查或通过证据。

## 兼容、回滚与剩余

无迁移、接口字段或游标变化；新占位／回执使用 24 小时默认值，既有 5 分钟记录不会追溯延长。
认证显式测试注入的 TTL 仍可覆盖默认；共用常量影响四类任务，因此均已回归。
回滚代码恢复旧默认，不改写已存记录的 expires_at；已有 24 小时回执继续由原到期清理机制处理。
占位和完成回执仍使用既有默认到期机制，业务抛错释放占位；未新增进程崩溃后的持久占位租约／回收能力。

后台业务域另有独立的 `admin/identity.ts` 5 分钟默认，本轮未改；其他键域／版本／业务唯一键差异仍须按模块审查。
授权分页 PR #109、Retry-After PR #108 和状态对照 PR #107 单独待合，不把未合成果记入 main。
未新增真实微信／供应商、Android 真机、生产库、付费业务验证、部署或全项目发布验收。
组件自查不代替独立审查／CI；整体 GY-I01 和有关业务验收保持开放。
