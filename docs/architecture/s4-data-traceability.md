# 数据面需求-实现-证据矩阵（S4）

本页把 F13「权限与数据保护」这一条需求拆成 **16 个可独立判定的判定项**，每项给四件事：需求出处（`文件:行`）、
实现落点、可复算的证据、以及**真实缺口**。基线 commit `81d8e0b9`（远端 `main`），取证时点 2026-10-26。

读法只有一句：**「已实现」= 能力在真实执行模式下可用且有可复算证据**；替身模式跑通、单测覆盖、迁移里建了表，
都不单独构成「已实现」。

## 0. 口径

### 0.1 四档定义

| 判定 | 定义（四条同时成立） | 反例（形似而实非） |
| --- | --- | --- |
| 已实现 | ① 需求有原文出处；② 在生产装配路径上真实生效；③ 有可复算证据（真库臂/集成测/门禁读数）；④ 不需要额外接线 | 「表建好了」「单测绿了」但没有任何生产入口 |
| 部分 | 主干能力存在且能在真实模式生效，但**至少一条子句**没有落点或没有证据 | 把「接口能调」当成「行为已达成」 |
| 未实现 | 需求子句在仓内**没有任何**实现落点（零命中可机械复核） | 「找不到」不等于「没有」——判此项前必须跑过零命中命令 |
| 已搁置 | 产品已明确裁定**首版不做**，因此既不是已实现，也不计为执行缺口 | 把「没做」记成「搁置」来躲缺口 |

判定粒度是**需求子句组**，不是 operation：一个 F13 子句可能没有任何 operation（如「受影响模型停部署」），
也可能横跨十几个 operation（如「单条删除」）。反过来，一个 operation 也可能同时服务好几个子句（如
`GET /me/exports` 既服务「外发记录」也服务「导出可见」）。

### 0.2 判定项粒度 ≠ operation（11 条 bullet → 16 项）

`docs/implementation-requirements.md:270` 起的 F13 正文是 **11 条 bullet**（`:274`–`:284`，验收行在 `:286`）。
拆成 16 项的依据是「能不能独立复算」，不是「有没有独立接口」：

| 需求行 | 判定项 | 为什么拆（或为什么不拆） |
| --- | --- | --- |
| `docs/implementation-requirements.md:274` | D01、D02 | 归属/角色鉴权确有骨架；机构与评审角色面在仓内零落点，混成一项会把「零」藏进「有」 |
| `docs/implementation-requirements.md:275` | D03、D04 | 定位/EXIF 是数据面，分用途授权是同意面，两套证据不通用 |
| `docs/implementation-requirements.md:276` | D05、D06 | 传输/存储保护与日志脱敏分别取证，前者缺落点、后者缺统一入口 |
| `docs/implementation-requirements.md:277` | D07 | 一条 bullet 一个判定项：保存期、单条删除、撤回同属「用户可处置自己的数据」 |
| `docs/implementation-requirements.md:278` | D08、D09 | 「注销即时」与「7/30 日到期」是两套时钟、两套执行器、两套证据 |
| `docs/implementation-requirements.md:279` | D10 | 保留与去身份是同一事务里的同一件事，不拆 |
| `docs/implementation-requirements.md:280` | D11 | 正文脱敏与媒体处置同属「保留下来但不可识别」 |
| `docs/implementation-requirements.md:281` | D12、D13 | 外发记录（写面+读面+门禁都在）与第三方删除（端口已接线、未装配）差一个量级，必须分开判 |
| `docs/implementation-requirements.md:282` | D14 | 训练：产品裁定首版不做，单独一项才能挂「已搁置」 |
| `docs/implementation-requirements.md:283` | D15 | 受影响模型：仓内零落点 |
| `docs/implementation-requirements.md:284` | D16 | 匿名统计：仓内零落点 |

### 0.3 行号口径（与既有收口矩阵的差异）

本页**写行号**，且每条行号都先自己复核再落笔。这与
[GY-R34 收口矩阵](../verification/gy-r34-closure-matrix-20261024.md) 的纪律相反——那一页 `:45` 明写「全页不写行号」，理由是
收口矩阵面向评审、要长期存活。本页面向的是**复算**：没有行号就无法一条条回查，所以选择写行号，代价交给门禁
`node tools/verify-doc-anchors.mjs --strict`（只报基线外新增）。

两条已知的**过期锚点**（不被本页继承，但会误导抄写者）：

| 过期引用 | 事实 |
| --- | --- |
| `docs/verification/gy-i29-closure-20261018.md:90` 引用的 `services/api/src/privacy/log-redaction.ts` | 该文件**不存在**；日志脱敏由 `packages/privacy/redact.mjs` 承担，`services/api/src` 内调用点只有账本一处 |
| 第三方删除「只有适配器没接」的说法 | 2026-10-26 前不止没接：`third_party_deletions` 在 `services/api/src` 的读写是**零**；现由 `services/api/src/privacy/third-party-deletion-pg.ts` 经 0044 两条函数读写（表仍不可直写，端口未装配） |

### 0.4 本页不构成关单依据

计数是**自评**：已实现 2、部分 9、未实现 4、已搁置 1，合计 16。这个分母不等于 AC23 的验收项数，也不等于
任何 issue 的关闭条件。AC23 的判据在 `docs/implementation-requirements.md:585`，其中「第三方证据」「模型停止」
「恢复清单生效」三项本页均判为未达成。

## 1. 汇总表

列口径：**需求锚点**给 F13 的 bullet 行；**实现落点**给最短的一条主链（明细见 §2–§5）；
**证据**给可复算的东西（真库臂/门禁/调用点），不是「有测试」；**缺口**给判定为缺口的那一条子句。

| 项 | 判定项 | 判定 | 需求锚点 | 实现落点（主链） | 缺口 |
| --- | --- | --- | --- | --- | --- |
| D01 | 归属与角色鉴权 | 已实现 | `docs/implementation-requirements.md:274` | `services/api/src/auth/middleware.ts:233` | 无（机构/评审面另计 D02） |
| D02 | 机构仅授权汇总、评审只看被分配脱敏原文 | 未实现 | `docs/implementation-requirements.md:274` | 无（全仓只有 user/admin 两臂） | 无机构角色、无汇总投影、无评审分配 |
| D03 | 定位仅到地区、清 EXIF | 部分 | `docs/implementation-requirements.md:275` | `services/api/src/media/service.ts:1069` | 无定位接口，「不存原始坐标」无从取证 |
| D04 | 分用途授权 | 部分 | `docs/implementation-requirements.md:275` | `services/api/src/routes/consents.ts:38` | 缺 location 与 training 两个 purpose |
| D05 | 传输/敏感字段/媒体/备份受保护 | 部分 | `docs/implementation-requirements.md:276` | `deploy/postgres-cvm/sql/20-login-roles.sql:350` | 仓内无 TLS/介质加密落点 |
| D06 | 日志不带令牌/密码/媒体/联系方式 | 部分 | `docs/implementation-requirements.md:276` | `services/api/src/app.ts:589` | 无统一日志脱敏入口，只有请求层白名单 |
| D07 | 保存至注销、单条删除、撤回 | 部分 | `docs/implementation-requirements.md:277` | `services/api/src/routes/favorites.ts:109` | 消息无删除路由；识别/语音/OCR 只软删 |
| D08 | 注销即时撤会话角色、停新外发、分对象删除任务 | 部分 | `docs/implementation-requirements.md:278` | `services/api/src/routes/account-deletion.ts:130` | 真实模式整域 503，仅替身模式可用 |
| D09 | 在线 7 日、备份 30 日、恢复重放 | 部分 | `docs/implementation-requirements.md:278` | `services/api/src/privacy/deletion-aging.ts:60` | 恢复重放未装配；无生产安装证据 |
| D10 | 帖评保留、去身份、已注销用户、不可反查 | 部分 | `docs/implementation-requirements.md:279` | `services/api/src/community/authors.ts:112` | 进程内 Map 仍以 userId 为键可反查 |
| D11 | 保留正文脱敏、不能脱敏的媒体隐藏/移除 | 部分 | `docs/implementation-requirements.md:280` | `services/api/src/community/purge.ts:24` | 注销时媒体批量清除未接线 |
| D12 | 外发记录与接收方门禁 | 已实现 | `docs/implementation-requirements.md:281` | `services/api/src/privacy/ledger-pg.ts:451` | 真实外发通路未接，真库零 sent 记录 |
| D13 | 第三方删除请求/完成/失败与证据 | 未实现 | `docs/implementation-requirements.md:281` | `services/api/db/migrations/0003_privacy_consent.sql:185` | 端口已接线（只经 0044 函数）、未装配、证据不落 |
| D14 | 训练单独授权、撤回 7 日清理衍生物 | 已搁置 | `docs/implementation-requirements.md:282` | 无（产品裁定首版不做） | 无缺口；开启训练即降级为未实现 |
| D15 | 受影响模型停部署、删权重、重训重验 | 未实现 | `docs/implementation-requirements.md:283` | 无（`model_version` 只是回答标注） | 无部署登记、无停用开关、无权重删除 |
| D16 | 匿名统计可保留、明细删除后重算 | 未实现 | `docs/implementation-requirements.md:284` | 无（仓内无统计面） | 无统计投影，重算与证据限定均无落点 |

计数：已实现 2（D01、D12）／部分 9（D03–D11）／未实现 4（D02、D13、D15、D16）／已搁置 1（D14）。

## 2. 已实现（2 项）

### D01 归属与角色鉴权

- **判定**：已实现。需求 `docs/implementation-requirements.md:274`（归属鉴权、角色鉴权），AC09 见 `:571`
  （「不能越权读取识别、反馈、认证、评审或原媒体」）。
- **实现**：`services/api/src/auth/middleware.ts:233` 定义 `requireUser`，`:237` 定义 `requireAdmin`；
  后台面拒用户会话并回 `SCOPE_DENIED`（`:117`）；scope 串校验在 `:204`。
- **证据**：契约两套鉴权方案 `packages/contracts/openapi.json:17`（`userSession`）与 `:288`（`adminSession`）；
  用例 `tests/unit/auth-privacy-arm-isolation.test.mjs`、`tests/integration/favorites-history-isolation-http.mjs`。
- **缺口**：无。**本项只判「有没有鉴权骨架与归属校验」**；「机构只给汇总、评审只看被分配脱敏原文」是另一件事，
  见 D02。这一拆分是本页与「鉴权面已实现」这类笼统结论的主要差异。

### D12 外发记录与接收方门禁

- **判定**：已实现。需求 `docs/implementation-requirements.md:281` 前半（记录接收方、目的、对象、授权版本与时间），
  产品面 `docs/product-requirements.md:226`。
- **实现**：账本表 `services/api/db/migrations/0003_privacy_consent.sql:116`
  （列含 `recipient_id`、`purpose`、`consent_epoch`、`requested_at`、`sent_at`）；写入 `services/api/src/privacy/ledger-pg.ts:451`，
  写回 `:650`；读面 `services/api/src/routes/exports.ts:42`（无池即 503，不降级内存账本 `:55`）；
  接收方门禁强制 `no_training_verified` 见 `packages/privacy/ledger.mjs:205`，授权落库要求两类证据引用见
  `services/api/src/privacy/grant-pg.ts:63`。
- **证据**：契约 `packages/contracts/openapi.json:1426`（`GET /me/exports`）；装配 `services/api/src/app.ts:2219`。
- **缺口**：**证据缺口，不是能力缺口**——真实外发传输未接，`services/api/src/app.ts:928` 起的注释写清：real 模式
  在任何账本变更**之前** 503（零 `sent` 记录），替身/演示模式**不记账**。因此真库上取不到一条真实外发记录，
  「记录得住」这件事只有结构与读面证据，没有一条真实数据流过。这一条不把 D12 降级：能力（表、写面、读面、
  门禁）都在生产装配路径上；缺的是传输这一侧的接线，属外发域而非记录域。

## 3. 部分实现（9 项）

### D03 定位仅到地区、清 EXIF

- **判定**：部分。需求 `docs/implementation-requirements.md:275`；AC21 见 `:583`（「授权取地区、原坐标不默认存，不追踪」）。
- **实现**：EXIF 清理在 `services/api/src/media/service.ts:1069`（`stripImageMetadata(stored.bytes, detected.mime)`，
  导入在 `:57`）；地区只有手选目录 `packages/contracts/operations.json:76`（`/catalog/regions`）。
- **证据**：`git grep -rn -i location -- services/api/src` 只有 2 行，且都是 `MAX_ALLOCATION_ATTEMPTS` 的误命中
  （`services/api/src/tts/media.ts:313`）⇒ 仓内没有坐标读写面。
- **缺口**：「不默认存原始坐标」「仅取地区」没有可复算的运行证据——没有定位接口，就没有「拒绝保存坐标」的行为可取。
  现在能判的只有两件事：EXIF 被清、地区是手选。

### D04 分用途授权

- **判定**：部分。需求 `docs/implementation-requirements.md:275`（分用途授权）。
- **实现**：purpose 闭集 4 项（`recording`、`media_processing`、`external_inference`、`public_posting`）见
  `packages/privacy/constants.mjs:13-18`；授权读面与撤回面 `services/api/src/routes/consents.ts:38`（写）、`:64`（撤回，
  缺 `If-Match` 即 `REVISION_REQUIRED` `:74`）、`:90`（政策读面）；撤回落库 `services/api/src/privacy/consent-pg.ts:148`。
- **证据**：契约 `packages/contracts/openapi.json:1332`（`withdrawConsent`）；真库臂
  `.github/workflows/consent-grant-postgres.yml:34`。
- **缺口**：没有 `location` 与 `training` 两个 purpose（`packages/privacy/constants.mjs:12` 自注「首版无 training」）。
  后果是「定位要单独授权」这条子句无处可撤——不是撤不掉，而是根本没有这一路授权。

### D05 传输/敏感字段/媒体/备份受保护

- **判定**：部分。需求 `docs/implementation-requirements.md:276`。
- **实现**：库侧最小授权是真做了的：`deploy/postgres-cvm/sql/20-login-roles.sql:350` 把 `purge_owner_media` 的
  EXECUTE 只授给运行时角色，`public.media` 零表级 DELETE；密钥不提交见 `AGENTS.md:42`。
- **证据**：`git grep -n -i hsts -- services/api/src` = 0 行。
- **缺口**：仓内**没有**传输层与介质加密的实现落点（TLS 由部署前置终止、备份介质由环境承担），因此「传输受保护」
  「备份受保护」这两句在仓库内取不到证据。只把 D05 判成「部分」而不是「未实现」的理由：应用边界内的最小授权与
  不落密钥是可复算的，缺的是环境侧证据。

### D06 日志不带令牌/密码/媒体/联系方式

- **判定**：部分。需求 `docs/implementation-requirements.md:276` 后半。
- **实现**：请求日志白名单 `services/api/src/app.ts:589`（`requestLogFields`），`:608` 注释写清「整条查询串一律不落」，
  挂载在 `:737`；账本回执脱敏 `packages/privacy/redact.mjs:68`（`redactForLog`）与 `:99`（`assertNoSensitiveLeak`），
  唯一调用点（限 `services/api/src`）是 `services/api/src/privacy/ledger-pg.ts:824`。
- **证据**：`services/api/src/privacy/log-redaction.ts` 不存在（见 §0.3 表格）。
- **缺口**：没有统一日志脱敏入口。业务域自己 `logger.info({...})` 的对象没有被机械校验，只有两处防住了：
  请求层白名单与账本一处 `redactForLog`。要升档需要「所有日志出口经同一个脱敏函数」这个事实，现在没有。

### D07 保存至注销、单条删除、撤回

- **判定**：部分。需求 `docs/implementation-requirements.md:277`。
- **实现**：`services/api/src/routes/**` 共 14 条 `app.delete`，其中 13 条是「本人删单条资源」：社区帖/评/赞 4 条
  （`services/api/src/routes/community.ts:242` 起）、授权撤回（`services/api/src/routes/consents.ts:64`）、
  会话与轮次（`services/api/src/routes/conversations.ts:148`、`:184`）、收藏 `services/api/src/routes/favorites.ts:109`、
  历史 `services/api/src/routes/history.ts:88`、媒体 `services/api/src/routes/media.ts:278`、
  识别 `services/api/src/routes/recognitions.ts:148`、语音 `services/api/src/routes/speech.ts:256`、
  OCR `services/api/src/routes/ocr.ts:310`；第 14 条是注销取消。
- **证据**：历史删除的级联处置有非契约披露头 `X-GY-Cascade`（`services/api/src/routes/history.ts:103`），
  只区分 `partial`/`failed`/`unwired`，不声称外部清理已完成。
- **缺口**：三条。① **消息没有单条删除**：`services/api/src/routes/messages.ts:43` 起只有 GET、GET、PUT；
  ② 删除深度不一致——识别/语音/OCR 只是把行标成 `deleted: true`
  （`services/api/src/recognitions/service.ts:755`、`services/api/src/speech/service.ts:794`、`services/api/src/ocr/service.ts:931`），
  只有媒体走到「确认删桶对象」（`services/api/src/media/service.ts:1170` → `:736`）；
  ③ 历史删除的关联删除只接识别与 OCR 两域，**媒体与外发明确未接**（`services/api/src/history/cascade-wiring.ts:17` 起，
  边界在 `:27`）。

### D08 注销即时撤会话角色、停新外发、分对象删除任务

- **判定**：部分。需求 `docs/implementation-requirements.md:278`；AC23 见 `:585`。
- **实现**：受理 `services/api/src/routes/account-deletion.ts:130`、回执 `:191`、取消 `:221`；协议
  `services/api/src/privacy/account-deletion.ts:287`（接口）、`:315`（工厂）、`:328`（受理，撤销在途外发在 `:338` 起）；
  删除模块闭集 4 项固定 + 4 项条件追加（`services/api/src/privacy/user-data-deletion.ts:164-169`、`:202-207`），
  真实注销路径有效闭集 **8 项**（`:151-153` 自述）。
- **证据**：`tests/integration/account-deletion-pg.mjs`，CI `.github/workflows/real-pg-integration.yml:189`。
- **缺口**：**这是本页最重要的一处修正**。`services/api/src/app.ts:2076` 是 `available: config.executionMode !== 'real'`，
  注释 `:2058-2065` 明写：real 模式整域不接线，两个 operation 一律 503 `PROVIDER_UNAVAILABLE`、`retryable: false`。
  也就是说「注销即时生效」这条在真实执行模式下**不可用**，只在 `stub`/`preset_demo` 成立。同一处 `:2078` 自陈
  外发撤销器与 `available` 门互斥，「两条路都到不了这里」（仅测试注入可达）。

### D09 在线 7 日、备份 30 日、恢复重放

- **判定**：部分。需求 `docs/implementation-requirements.md:278`。
- **实现**：常量 `services/api/src/privacy/deletion-aging.ts:60`（在线 7 日）、`:62`（备份 30 日），与
  `packages/privacy/backup-retention.mjs:40`、`:43` 同值；到期计算 `services/api/src/privacy/deletion-aging.ts:225`，
  三态判定 `:244`；执行器 `tools/purge-expired-online-data.mjs` 与 `tools/purge-expired-backup-copies.mjs`；
  调度 `deploy/purge-schedule/gengyun-purge-online-data.timer:24`（每 10 分钟）、
  `deploy/purge-schedule/gengyun-purge-backup-copies.timer:17`（每 15 分钟）。
- **证据**：CI 里三条真库臂 `.github/workflows/real-pg-integration.yml:546`（online-purge-pg）、`:501`
  （backup-copies-purge-pg）、`:485`（backup-purge-pg）。
- **缺口**：① 恢复重放只有纯函数模块 `services/api/src/privacy/backup-replay-manifest.ts:559`，**没有装配进 `app.ts`**，
  契约里也没有恢复 operation（该文件 `:68` 自陈）；② 调度件的「已安装并生效」不在仓内，没有任何生产读数；
  ③ 加速演练 `tests/integration/retention-clock-drill-pg.mjs` 未进任何 workflow，未设 `GY_PG_BIN` 时如实 `exit 77`。

### D10 帖评保留、去身份、已注销用户、不可反查

- **判定**：部分。需求 `docs/implementation-requirements.md:279`。
- **实现**：`services/api/src/community/authors.ts:112`（`display_name: '已注销用户'`）、`:113`（`display_id: ref`）；
  写路径同事务置 `author_id = NULL` 并写引用（`services/api/src/community/purge.ts:24` 起，举报同形）；
  引用形状 `^gy-anon-[0-9a-f]{16}$` 与共用规则见 `services/api/db/migrations/0032_community_report_reporter_ref.sql:24`。
- **证据**：`services/api/src/community/purge.ts:141` 起（`authors.anonymize` 调用与形状校验）。
- **缺口**：`services/api/src/community/authors.ts:92` 的进程内 `anonymizedRefs` 以 **userId** 为键，进程生命周期内
  仍能把「原账户 → 注销引用」对上（重启即失，持久面已去关联）；另外举报表在 0032 之前是强关联，
  迁移 `:8-12` 自陈过这一点。

### D11 保留正文脱敏、不能可靠脱敏的媒体隐藏/移除

- **判定**：部分。需求 `docs/implementation-requirements.md:280`。
- **实现**：行级读数含 `hiddenMedia`（`services/api/src/community/purge.ts:69`），blocked 原因码在 `:32` 起；
  单条媒体的对象删除是「确认后才清引用」（`services/api/src/media/service.ts:736`，先落清理意图再删桶对象）。
- **证据**：账本脱敏 `packages/privacy/redact.mjs:68`。
- **缺口**：**注销时按主体批量清媒体未接线**——`git grep -n purge_owner_media -- services/api/src` = 0 行，
  迁移自陈见 `services/api/db/migrations/rollback/0035_r34_media_row_purge.down.sql:14`（「本片未接线」，
  `user-data-deletion.ts` 里还没有媒体模块）。所以「不能可靠脱敏的媒体在注销后被隐藏或移除」这一步没有执行者。

## 4. 未实现（4 项）

### D02 机构仅授权汇总、评审只看被分配脱敏原文

- **判定**：未实现。需求 `docs/implementation-requirements.md:274` 后半；AC09 `:571` 明写「机构仅授权汇总」。
- **实现**：无。`git grep -rn -i "organi[sz]ation" -- services/api/src` = 0 行；角色枚举只有 `user` 与 `admin`
  两臂，`services/api/src/auth/middleware.ts:204` 只校验 scope 串。
- **证据**：无（`docs/architecture/acceptance-map.md:18` 只登记 F13 → AC09、AC23 的覆盖关系，不含机构面）。
- **缺口**：三件都没有——机构角色、只给汇总不给明细的投影、评审任务的分配表。

### D13 第三方删除请求/完成/失败与证据

- **判定**：未实现。需求 `docs/implementation-requirements.md:281` 后半；产品面 `docs/product-requirements.md:226`
  （注销即发删除请求、在线 7 日/备份 30 日、记录请求/完成/失败及证据、不把已发请求假记为已删）。
- **实现（半成品，逐层都在但没接起来）**：
  ① 表在——`services/api/db/migrations/0003_privacy_consent.sql:185`，两条 CHECK 保证「confirmed 必有确认时间与证据」
  （`:196`）与「已请求必有请求时间」（`:202`）；
  ② 内存协议在——`packages/privacy/deletion.mjs:210`（请求）、`:236`（确认，无证据引用即 `INVALID_REQUEST`）、
  `:252`（失败）、`:261`（不支持）；
  ③ 适配器在——`services/api/src/privacy/third-party-deletion-adapter.ts:134`，无凭据或无传输即不可用
  （`:147`），错误码 `OBJECT_UNAVAILABLE`（`:45`）；
  ④ 回执投影在——`services/api/src/privacy/third-party-deletion-projection.ts:277`；
  ⑤ 真库端口在——`services/api/src/privacy/third-party-deletion-pg.ts`：只经 0044 两条 `SECURITY DEFINER` 函数进出
  （表零 DML/SELECT），**尚未装配**进 `app.ts`（装配属 P2-b）。
- **库层证据（2026-10-26 增补；判定与下面三条缺口均不变）**：迁移
  `services/api/db/migrations/0044_third_party_deletion_persistence.sql:97` 建了唯一写路径
  `record_third_party_deletion_request(...)`（`SECURITY DEFINER` ＋ `SET search_path = pg_catalog`），`:270` 建了唯一读路径
  `list_third_party_deletions(...)`（只吐八个证据面列、固定排序、终态不可回退）；授权在
  `deploy/postgres-cvm/sql/20-login-roles.sql:414`（REVOKE PUBLIC）与 `:416`（GRANT EXECUTE 给 `gengyun_api_runtime`，
  该表对运行时仍 `forbidden`，见 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:1134`），函数形状断言在同文件
  `:1803`；真库臂在 `tests/integration/third-party-deletion-pg.mjs:1`（自述 P1，子判据 E-S4-P1-A..E 见 `:27`），由
  `.github/workflows/real-pg-integration.yml:203` 在 CI 跑（PG 17.11、现建空库）。**但这是「库层记住」，不是运行面接线**：
  同一迁移 `:4` 自陈「**不接电**」——端口只被单测调用、`services/api/src/app.ts` 一行未装配，运行面仍无写入口。
- **证据（2026-10-26 起）**：`git grep -n third_party_deletions -- services/api/src` = 5 行 / 1 文件（全在端口
  `privacy/third-party-deletion-pg.ts`：3 条注释 + 1 条常量 + 1 条 `FROM public.list_third_party_deletions(...)`，对表零 DML/SELECT）；
  `git grep -n "ThirdPartyDeletion|third-party-deletion" -- services/api/src/app.ts` = 0 行。
- **缺口**：① 已于 2026-10-26 收窄——应用侧读写由端口补齐（只经 0044 两条函数、表零直写），但**未装配**，
  所以运行面上仍然没有写入口；② 适配器未在 `app.ts` 装配，因此「没有凭据就用 `OBJECT_UNAVAILABLE` 如实失败」
  这个设计在运行面上也不存在；③ 投影只被单测调用（`tests/privacy/third-party-deletion-projection.test.mjs`），
  没接进 `/me/exports` 回执 ⇒ 「请求/完成/失败与证据」四件事在运行面上一个都取不到。

### D15 受影响模型停部署、删权重、重训重验

- **判定**：未实现。需求 `docs/implementation-requirements.md:283`；产品面 `docs/product-requirements.md:228`
  （已训练模型：停部署、在线权重 7 日、备份 30 日、重训重验）。
- **实现**：无。`model_version` 在仓里是「这条回答由哪个版本产生」的标注字段
  （`services/api/src/conversations/types.ts:109`），不是模型部署登记面；审核域的 `model_version` 同样是台账字段。
- **证据**：无部署登记表、无停用开关、无权重删除对象（`purge_owner_media` 只覆盖媒体行的 11 列，不含模型权重）。
- **缺口**：需求要求的四件事（停部署、在线权重 7 日、备份 30 日、重训重验）全无落点。这一项与 D14 的区别：
  训练是产品裁定的搁置，模型下线是**已写进 AC23 的交付项**（`:585` 明写「模型停止」），不能搁置。

### D16 匿名统计可保留、明细删除后重算

- **判定**：未实现。需求 `docs/implementation-requirements.md:284`。
- **实现**：无。`services/api/src/routes/public-home.ts:9` 只有首页读面；仓内没有统计投影，后台也刻意不给计数
  （`services/api/src/admin/ops/service.ts:1057` 写明「不返回 COUNT(*)」）。
- **证据**：无。
- **缺口**：「明细删除后重算」与「证据单独限定」都依附于一个不存在的统计面。若产品裁定不做统计，本项应按 §7
  改判「已搁置」并写明裁定出处；在此之前记未实现。

## 5. 已搁置（1 项）

### D14 训练单独授权、撤回后 7 日清理衍生物

- **判定**：已搁置。需求 `docs/implementation-requirements.md:282`；产品面 `docs/product-requirements.md:227`。
- **实现**：无 training purpose（`packages/privacy/constants.mjs:12` 注释「首版无 training」），
  也没有对应列（`services/api/src/privacy/privacy-policy.ts:11`：`training_enabled` 恒 `false`）。
- **证据**：`AGENTS.md:44`「首版不开启用户训练」。
- **为什么是搁置而不是未实现**：训练不是「漏做」，是产品已裁定的范围外。搁置也要留痕：一旦新增 training purpose，
  本项必须立刻降级为未实现——7 日清理衍生物与备份 30 日在代码里完全没有落点，届时那是一个真缺口，
  而不是一次裁定。

## 6. 真实缺口门槛

「真实缺口」不靠语气，靠五条准入门槛，全部满足才写进本页缺口列：

1. **需求有原文**：能在需求文件里指出一行，且那一行**真的写了这件事**（不是推导出来的）。
2. **「没有」可机械复算**：零命中 grep、文件不存在、装配点缺失这类可重跑的证据，不是「我没找到」。
3. **缺的是能力，不是环境**：缺凭据、缺 PG 二进制、缺生产机位 ⇒ 记「未取得证据」，不记缺口。
4. **修法可命名**：能写出要动哪几个文件、加哪张表、补哪个门禁。
5. **不把文档缺陷混进实现缺口**：过期锚点（§0.3 表格两条）算文档缺陷，单独修。

按这五条，全页只有两条够格（另有一条 ★G3 已于 2026-10-26 复核消解，整条留档见本节末）：

### ★G1 第三方删除（判据：D13）

表、协议、适配器、投影、真库端口都在，唯独**未装配 + 证据不落**（读写已由端口接上，只经 0044 两条函数、表零直写）。可复算：
`git grep -n third_party_deletions -- services/api/src` = 5 行 / 1 文件（就是那个端口；对表零 DML/SELECT）。修法可命名：把适配器注入 `app.ts`，
在注销受理时按接收方建行、把投影接进 `/me/exports` 回执。这一条直接决定 AC23（`docs/implementation-requirements.md:585`）
的「第三方证据」判不了。

### ★G2 注销时媒体本体批量清除（判据：D11）

`purge_owner_media` 有函数、有授权、有真库臂（`tests/integration/media-row-purge-pg.mjs`），但应用侧零引用、
注销闭集里没有媒体模块（`services/api/src/privacy/user-data-deletion.ts:164-169` 只有四域，条件追加的四域也不含媒体）。
迁移自己写了「本片未接线」（`services/api/db/migrations/rollback/0035_r34_media_row_purge.down.sql:14`）。
可复算：`git grep -n purge_owner_media -- services/api/src` = 0 行。

### ★G3（**已于 2026-10-26 复核消解，整条留档**）保留策略（GY-R34）没有调度单元（判据：D09 的边角，但不属 D09 主体）

原判称 `purge:retention` **没有 `.service`/`.timer`**，也**不在** 调度门禁的必需清单里（旧文引
`tools/verify-purge-schedule.mjs:109` 的 `REQUIRED_NPM_SCRIPTS` 只有 `purge:online-data` 与 `purge:backup-copies`），
并与日级频率冲突（门禁要求 `OnCalendar` 展开间隔 ≤60 分钟，保留策略天生按天）⇒ 要么开日级例外，要么明确「仅手工执行」。

**2026-10-26 复核：G3 所述三项均已落地，见 [数据保留／备份／第三方完成证据现状清单](gy-r59-retention-backup-thirdparty-map.md)。**
① 单元在——`deploy/purge-schedule/gengyun-purge-retention.service` ＋ `.timer`（`OnCalendar=*-*-* 03:20:00` 日级一次，
`ExecStart` 带 `--yes --json`，`User=gengyun-ops`）；② 必需清单已是 **3 项**，真实位置 `tools/verify-purge-schedule.mjs:117`
（`:109` 实为 `DEFAULT_SCHEDULE_DIR`，旧文引错行）；③ 频率上界已按命令分档（`INTERVAL_BUDGET_MINUTES`，
`tools/verify-purge-schedule.mjs:152`，日级 ≤1440 分钟），不再与 ≤60 分钟冲突。
现读数：`node tools/verify-purge-schedule.mjs` = `PASS：10 项判据全部满足`，其中 `[npm-script]` 必需覆盖 3/3。
⇒ 本条**撤出缺口列**，仅留档；§6 开头计数与 §7 两张表已同步。

### 证据基础设施缺口（不计入上面两条，但会让两条长期不可关）

| 编号 | 事实 | 可复算 |
| --- | --- | --- |
| E1 | 真实模式下注销整域 503，任何「注销已实现」的读数都只在替身模式成立 | `services/api/src/app.ts:2076` |
| E2 | 三条真库臂不在任何 workflow：`tests/integration/media-row-purge-pg.mjs`、`tests/integration/recognitions-speech-purge-pg.mjs`、`tests/integration/retention-clock-drill-pg.mjs` | 在 `.github` 下 grep 这三个脚本名，命中 0 行 |
| E3 | 恢复重放只有纯函数，契约无恢复 operation | `services/api/src/privacy/backup-replay-manifest.ts:559` |
| E4 | 加速演练 `exit 77` 是「未取得」，不是通过 | `tests/integration/retention-clock-drill-pg.mjs:20` |

## 7. 复核命令与升降条件

### 7.1 复核命令（本页所有判定都能被这几条重跑）

| 目的 | 命令 | 期望读数 |
| --- | --- | --- |
| 行号不腐烂 | `node tools/verify-doc-anchors.mjs --strict` | `exit 0`，基线外新增 0 |
| 文档结构与链接 | `npm run test:docs` | `exit 0`；`PASS: … Markdown links and tables` 在第 5 行（第一个工具的输出），末行是 `PASS docs/research 结构校验…` |
| D13 读写接缝 | `git grep -n third_party_deletions -- services/api/src` | 5 行 / 1 文件（= 端口 `privacy/third-party-deletion-pg.ts`；表零 DML/SELECT） |
| G2 未接线 | `git grep -n purge_owner_media -- services/api/src` | 0 行 |
| G3 调度清单 | `node tools/verify-purge-schedule.mjs` | `PASS：10 项判据全部满足`，必需清单 **3/3**（`tools/verify-purge-schedule.mjs:117`；旧文误引 `:109` 实为 `DEFAULT_SCHEDULE_DIR`）。2026-10-26 复核后 G3 已撤出缺口列 |
| D08 模式门 | `git grep -n "available: config.executionMode" -- services/api/src/app.ts` | 1 行，`!== 'real'` |
| D07 单条删除面 | `git grep -n "app.delete(" -- services/api/src/routes` | 14 条（13 条单条删除 + 1 条注销取消） |
| D08 闭集 | `node --test tests/unit/deletion-registration-coverage.test.mjs` | 全绿；改闭集必须同步改常量 |

### 7.2 升档条件（写清「还差什么」，避免下一轮重新论证）

| 项 | 现在 | 升档需要的事实 | 判据落点 |
| --- | --- | --- | --- |
| D08 | 部分 | `available` 门不再是 `!== 'real'`，且真实模式有注销受理读数 | `services/api/src/app.ts:2076` |
| D11 | 部分 | 注销闭集含媒体，且媒体原语可被应用侧调用（或 `MediaStore` 有按主体清空） | `services/api/src/privacy/user-data-deletion.ts:202` |
| D13 | 未实现 | 适配器与 0044 真库端口都在 `app.ts` 装配；注销受理时按接收方建行；回执带第三方状态 | `services/api/src/app.ts:2076` 同侧装配区 |
| D09 | 部分 | 恢复重放接进装配并有一次重放读数 | `services/api/src/privacy/backup-replay-manifest.ts:559` |
| D14 | 已搁置 | 出现 training purpose 即降级为未实现（7 日清理衍生物仍无落点） | `packages/privacy/constants.mjs:13` |
| G3 | **已消解（2026-10-26 复核）** | 已具备（撤条理由）：`deploy/purge-schedule/gengyun-purge-retention.service` ＋ `.timer` 在、`purge:retention` 已在必需清单、日级上界 1440 分钟已分档；若单元被删或必需清单回落到 2 项，按缺口重新记 | `tools/verify-purge-schedule.mjs:117` |

### 7.3 降档条件

出现下列任一事实，已实现/部分要往下调，而不是「解释一下就好」：生产入口被 503 挡掉（D08 的形状）、
闭集因装配漏注入静默收缩（`services/api/src/privacy/user-data-deletion.ts:151` 已警示）、
真库臂从 CI 掉出去（E2 的形状）、证据只剩替身模式。

## 8. 相关页

- [实现需求（F13 权限与数据保护）](../implementation-requirements.md)
- [产品需求（B18 数据授权与使用范围 / Q17）](../product-requirements.md)
- [需求入口](../requirements.md)
- [F / AC 覆盖与交接](acceptance-map.md)
- [数据保留策略表与清理执行器（GY-R34）](gy-r34-retention-policy.md)
- [逐用户备份副本域设计（GY-I19）](gy-i19-user-backup-copies-design.md)
- [GY-I29 隐私一致性收口](../verification/gy-i29-closure-20261018.md)
- [GY-R34 收口矩阵](../verification/gy-r34-closure-matrix-20261024.md)
- [仓库 README 的隐私与发布现状](../../README.md)
