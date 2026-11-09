# GY-R82 · #29 AC-3 代码与单测证据（2026-11-06）

> **一句话结论**：#29 的 AC-3 三项——授权错误码与交互、模块删除注册协议、训练开关状态——在**当前树**都能由代码锚点与离线单测读数复核；但这只是「代码可证」的部分，**不能**替代真机走查，也**不主张关闭 #29**。
>
> Refs #29（不 Closes）· 基线 `origin/main = 7155b9e7` · 分支 `docs/gy-r82-i29-ac3-evidence`

## 0 背景与边界

监工 2026-11-06 在 #29 的复核里写：AC-3「授权错误码与交互、模块删除注册协议、训练开关状态——均无记录」，依据是 `docs/verification/gy-r79-device-walkthrough-20261106.md` 那一页在这三项上只有数据库读数、没有授权/删除/训练开关的记录（该页第 4 节即「识别结果（数据库读数）」，见 `docs/verification/gy-r79-device-walkthrough-20261106.md:51`）。该页是**真机走查**页，缺的是设备侧证据；这三项里**代码与单测可证的部分**此前没有单独成页。本页只补这一块。

- 本页**不能**替代真机走查，也不主张关闭 #29。
- 本页每条读数都注明「怎么跑出来的」；未跑的一律写「未取得」。
- 本页所有 `pass` / `fail` 都是**离线单测**读数，不是真机读数；不得把单测读数说成真机读数。
- 本页只新建这一个文件：不改产品代码、不改 `tests/`、不改 `tests/unit/doc-anchor-relocations.json`。

### 0.1 读数口径

- 代码基线：`7155b9e7`（`git rev-parse HEAD` 与 `git rev-parse origin/main` 同为 `7155b9e7`）。
- 运行环境：Windows，Node `v24.19.0`，2026-11-06 本机离线执行；无 PG、无真实模型调用、无真实外发、无凭据。
- 下表读数取自 `node --test <文件>`（`node:test` 运行器），同一份读数在派发复核时又独立跑过一遍，两次一致。

## 1 表 1：授权错误码与交互（AC-3 第一项）

| # | 结论 | 代码锚点（全路径 + 行号） | 机检（测试文件 + 用例数 + 实跑读数） | 怎么跑出来的 |
| --- | --- | --- | --- | --- |
| 1.1 | 未授权用途 ⇒ `403 CONSENT_REQUIRED`，文案 `缺少用途授权：<purpose>`，`retryable=false` | `packages/privacy/guard.mjs:116`（抛 `CONSENT_REQUIRED`）；`packages/privacy/errors.mjs:28`（`retryable` 缺省 `false`） | `tests/unit/privacy-egress-http.test.mjs:106`；该文件 **7 用例**，**7 pass / 0 fail**；断言 HTTP 403、`error.code='CONSENT_REQUIRED'`、`error.message='缺少用途授权：external_inference'`、`error.retryable=false` | `node tests/unit/privacy-egress-http.test.mjs`，exit 0 |
| 1.2 | 错用途 ⇒ `403 SCOPE_DENIED`，文案 `用途 <purpose> 与资料类型 <dataType> 不匹配（错用途）` | `packages/privacy/guard.mjs:106`（`SCOPE_DENIED` 码；文案字面在 `packages/privacy/guard.mjs:107`） | `tests/unit/privacy-egress-http.test.mjs:106`；同文件 **7 pass / 0 fail**；断言 HTTP 403、`error.code='SCOPE_DENIED'`、`error.message='用途 public_posting 与资料类型 voice_question 不匹配（错用途）'`、`error.retryable=false` | 同上 |
| 1.3 | 两个码互不混同；错误信封形状为 `error.code` / `error.message` / `error.retryable`（另带 `error.details` 与 `meta`） | `services/api/src/errors.ts:127`（`buildErrorEnvelope` 组装 `error` 四字段）；`packages/privacy/errors.mjs:42`（`toErrorEnvelope` 同形封套） | `tests/unit/privacy-egress-http.test.mjs:145`；同文件 **7 pass / 0 fail**；同一组请求头、同一身份、仅授权事实不同，断言两码不相等（`CONSENT_REQUIRED` ≠ `SCOPE_DENIED`） | 同上 |
| 1.4 | 异步路径保留隐私错误码：`CONSENT_REQUIRED`(403) / `OBJECT_UNAVAILABLE`(409) / `INVALID_REQUEST`(400) / `PROVIDER_UNAVAILABLE`(503)；作业封套恰好九键、且不承载 `retryable` | `services/api/src/conversations/service.ts:499`（`settleCodeOf` 同时认 `ApiError` 与 `PrivacyError`）；`services/api/src/privacy/task-egress.ts:470`（`INVALID_REQUEST`）；`services/api/src/privacy/task-egress.ts:165`（`OBJECT_UNAVAILABLE`）；`services/api/src/privacy/task-egress.ts:461`（非 real 模式的 `PROVIDER_UNAVAILABLE`）；`services/api/src/privacy/ledger-pg.ts:653`（`CONSENT_REQUIRED`，P1 替身与之同码同文案） | `tests/unit/conversation-async-privacy-codes.test.mjs:198`（P1 四码矩阵）；该文件 **3 用例**，**3 pass / 0 fail**；断言四个码在作业面同为 `failed`、`error_code` 互不相同、HTTP 语义分别为 403/409/400/503，且 `Object.keys(job)` 恰为契约九键、无 `retryable` | `node tests/unit/conversation-async-privacy-codes.test.mjs`，exit 0 |
| 1.5 | 14 码全景：服务端 **14** 个、客户端并集 **21** 个；服务端只差 `SESSION_EXPIRED`，已登记为 401 归一例外 | `docs/verification/gy-i27-error-code-parity-20261102.md:4` | 引用页自带闸门 `tests/unit/consent-error-code-parity.test.mjs`；本次实跑 **9 用例**，**9 pass / 0 fail**（含 3 条负控制） | `node tests/unit/consent-error-code-parity.test.mjs`，exit 0 |

> 1.4 的口径说明：`CONSENT_REQUIRED` 那一行由账本替身在 `resolveRecipient` 处抛**同码同文案**的 `PrivacyError`（对齐 `services/api/src/privacy/ledger-pg.ts:653`），并不是真库查询；`INVALID_REQUEST` 与 `PROVIDER_UNAVAILABLE` 则走 `services/api/src/privacy/task-egress.ts` 的真实分支。该测试文件头部的旧注释把锚点写成 `services/api/src/privacy/ledger-pg.ts` 第 521 行，当前树实际在 `services/api/src/privacy/ledger-pg.ts:653`——本页按当前行号写。

## 2 表 2：模块删除注册协议（AC-3 第二项）

| # | 结论 | 代码锚点（全路径 + 行号） | 机检（测试文件 + 用例数 + 实跑读数） | 怎么跑出来的 |
| --- | --- | --- | --- | --- |
| 2.1 | 必需模块是**闭集**（常量四域：favorites / history / messages / conversations，扩大而非替换）；非闭集模块注册即拒 | `services/api/src/privacy/user-data-deletion.ts:194`（`USER_DATA_DELETION_MODULES` 四域闭集）；抛 `INVALID_REQUEST` 的闭集校验在 `packages/privacy/deletion-modules.mjs:114` | `tests/unit/user-data-deletion.test.mjs:81`（用例名「F13：必需模块闭集含四域（扩大而非替换），且非闭集模块注册即拒（复用同一协议）」）；该文件 **5 用例**，**5 pass / 0 fail**；断言 `requiredModules()` 恰为四域、`registerModule('other-module')` 抛 `/不在必需模块闭集内/`、`missingRegistrations()` 为空 | `node tests/unit/user-data-deletion.test.mjs`，exit 0 |
| 2.2 | 注册覆盖度：每张用户数据表必须被已注册模块覆盖，或显式声明未注册并写明原因与归属编号 | `tests/unit/deletion-registration-coverage.test.mjs:225`（闭集与覆盖映射逐项对齐）；`tests/unit/deletion-registration-coverage.test.mjs:257`（覆盖或显式声明的棘轮） | 该文件 **7 用例**，**7 pass / 0 fail**；从 `services/api/db/migrations/*.sql` 静态枚举用户数据表，与 `USER_DATA_DELETION_MODULES` 同源比对 | `node tests/unit/deletion-registration-coverage.test.mjs`，exit 0 |
| 2.3 | 按主体清理、其它主体不受影响；备份如实 `pending`、不谎称完成 | `tests/unit/user-data-deletion.test.mjs:101`（用例名「F13：按主体清理，其它主体不受影响；在线证据非空，备份如实 pending（不谎称完成）」） | 同文件 **5 pass / 0 fail**；断言 A 的四域数据清零、B 的收藏/历史/消息/会话各行保留；四个模块行 `online_state='completed'`、`backup_state='pending'`、`error_code=null`；`completionStatus(requestId).completed === false` | 同上 |

> 2.1 的口径说明：常量闭集是四域；生产装配会按注入条件追加社区域、识别域、语音域、OCR 域与统一作业台账 `jobs`，生产生效闭集为 9 项（`tests/unit/deletion-registration-coverage.test.mjs:315`）。追加仍走同一个 `registerModule` 协议（`packages/privacy/deletion-modules.mjs:112`），不绕过 2.1 的闭集校验。

## 3 表 3：训练开关状态（AC-3 第三项）

| # | 结论 | 代码锚点（全路径 + 行号） | 机检（测试文件 + 用例数 + 实跑读数） | 怎么跑出来的 |
| --- | --- | --- | --- | --- |
| 3.1 | 首版**不开展用户数据训练**；政策对象字段类型与下发值恒为 `training_enabled: false` | `services/api/src/privacy/privacy-policy.ts:115`（接口字段声明 `training_enabled: false`）；`services/api/src/privacy/privacy-policy.ts:211`（读取结果下发处） | `tests/unit/privacy-policy-read.test.mjs:60`（空态）与 `tests/unit/privacy-policy-read.test.mjs:79`（有行）；该文件 **8 用例**，**8 pass / 0 fail**；空态断言 `version='unpublished'`、`purposes=[]`、`recipients=[]`、`training_enabled=false`，键集恰为四键 | `node tests/unit/privacy-policy-read.test.mjs`，exit 0 |
| 3.2 | 说明文字：训练不是首版 `ConsentPurpose`，`user_training_consents.training_enabled` 默认 `false`，启用需独立同意 + 模型谱系验收，首版无放行训练路径 | `packages/privacy/README.md:148` | 无（说明性文字，非机检） | 未取得（未跑；文档阅读） |
| 3.3 | 读取与空态诚实：无政策行 ⇒ 200 + `version='unpublished'`，不编造政策文本也不 5xx；库里真存哨兵值 ⇒ 503，不冒充空态 | `services/api/src/privacy/privacy-policy.ts:202`（`UNPUBLISHED_POLICY_VERSION` 空态哨兵） | `tests/unit/privacy-policy-read.test.mjs:60`（空态）与 `tests/unit/privacy-policy-read.test.mjs:113`（哨兵撞车 503）；同文件 **8 pass / 0 fail** | 同上 |
| 3.4 | 项目硬约束：「社区先审后发，首版不开启用户训练」 | `AGENTS.md:44` | 无（原文引用） | 未取得（未跑；原文阅读） |

> 3.1 的「恒 `false`」是**类型级**约束（字段类型写成字面量 `false`，不是 `boolean`）＋**下发处**逐字写 `false`，两处任一被改成可变值都会改变类型或需要改测试；它证明的是代码与离线读取行为，不证明线上库中不存在历史训练授权行。

## 4 本次实跑读数汇总

| 命令 | 用例数 | 实跑读数 | 退出码 |
| --- | --- | --- | --- |
| `node tests/unit/privacy-egress-http.test.mjs` | 7 | 7 pass / 0 fail | 0 |
| `node tests/unit/conversation-async-privacy-codes.test.mjs` | 3 | 3 pass / 0 fail | 0 |
| `node tests/unit/user-data-deletion.test.mjs` | 5 | 5 pass / 0 fail | 0 |
| `node tests/unit/deletion-registration-coverage.test.mjs` | 7 | 7 pass / 0 fail | 0 |
| `node tests/unit/privacy-policy-read.test.mjs` | 8 | 8 pass / 0 fail | 0 |
| `node tests/unit/consent-error-code-parity.test.mjs` | 9 | 9 pass / 0 fail | 0 |

本页自身的锚点闸门读数（`node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs`）：本页 34 条显式锚点全部解析成功，`BROKEN 0 / OUT_OF_RANGE 0 / SUSPECT 0`，裸锚点 0 条（基线外新增 0），符号覆盖配对 12 条全部 OK，工具 exit 0。

## 5 不能证明什么

以下各项**本页一项都没有**，也正是 #29 仍然开放的原因：

1. **真机上的授权弹窗与拒绝路径：未取得。** 1.1–1.3 走的是 `app.inject` 的合成 HTTP 请求，不经过微信小程序 UI，不证明真机上弹窗会出现、按钮可点、拒绝后页面如何提示。
2. **真实日志内容审计：未取得。** 本页没有读取任何生产或真机日志，无法证明日志里到底有没有私有正文、图片、音频、精确坐标、凭据。
3. **真实删除请求的第三方完成记录：未取得。** 2.1–2.3 使用内存存储与备份清除端口替身；`backup_state='pending'` 恰恰说明真实备份副本清除尚未接线，更没有第三方完成回执。
4. **真实外发账本行：未取得。** 本页未产生任何真实外发；测试里出现的 `sent` 行来自 stub 替身账本，不是真实供应商调用。
5. **AC-1 / AC-2 的负向用例与真实日志审计仍未取得。**

因此，本页只能支撑「AC-3 的代码与单测可证部分已可复核」，不能支撑「AC-3 整体通过」，更不能支撑关闭 #29。
