# GY-R34 · 真机微信登录端到端证据（wx.login → 自建 API → 微信换身份 → 会话落 PG）

**脱敏声明**：本页**不含** openid、`access_token`／会话 cookie 值、AppSecret，也不含任何密钥片段、
前缀或长度；只记录**内部 uuid、HTTP 状态码、耗时、行号、时间**与**字段名**。日志只摘结构化的
`reqId／method／url／statusCode／responseTime／remoteAddress`，不复制原文行。

- 取证时间：**2026-10-23 20:39:27.056 → 20:53:26.893**（Asia/Hong_Kong，UTC+08:00）：20:42:33 登录成功，
  之后到 20:53:26 都不再有登录请求，只有读面续用（§6 第 5 条）。
- 设备：**手机**（来源 IP `192.168.35.117`），微信开发者工具 **2.02.2608080**，走**真机调试**模式。
- 服务：real 模式 API，**pid 14740**，监听 **`0.0.0.0:55433`**；PG **127.0.0.1:55432**，库
  `gengyun_real_evidence`，**32/32** 迁移已应用（`schema_migrations` 32 行，最大版本 `0032`）。
- 相关单：**`Refs #27`**（不关闭整项）。

---

## 0 一句话结论

手机微信经 `wx.login` 拿到一次性 code → 小程序 `POST /api/v1/auth/wechat` → **服务端外呼微信
`sns/jscode2session`** 换回身份 → **会话写进 PG 并给出 7 天有效期**；这一次登录实测 **200 / 2011.396 ms**，
且它命中的是 **20:16:49 由模拟器那次登录创建的同一条 `public.users` 行**——两次是**同一真实微信身份的
两个设备会话**。

## 1 环境与前置

| 项 | 本次读数 | 依据 |
| --- | --- | --- |
| API 监听 | **`0.0.0.0:55433`**，pid **14740** | `Get-NetTCPConnection -LocalPort 55433` → `0.0.0.0 / 55433 / 14740` |
| 启动方式 | `run-api.cmd` 里 `set GY_API_BIND=0.0.0.0`，再 `node start-api.mjs … 55433 55432 gengyun_real_evidence …` | 该批处理**不含凭据内容**，凭据由 `start-api.mjs` 在进程内解析 |
| 执行模式 | `APP_EXECUTION_MODE=real`（同一启动器内写死派生） | `start-api.mjs` 只打印字段名与计数，不打印值 |
| 小程序 API 基址 | `http://192.168.35.69:55433/api/v1`（副本 `miniprogram/config/runtime.js` 的 `apiBaseUrl`，`mode: 'local'`） | 本地副本，**未入库**（`.pg17/tmp/login-ready/miniprogram-local`） |
| 副本 AppID / 基础库 / 域名校验 | `wx4407a4b908a69a54` / `3.17.3` / `setting.urlCheck: false` | 副本根 `project.config.json`（无 `project.private.config.json`，即 false 是直接写在公开配置里的） |
| 共享源码口径 | 仓内必须 `urlCheck: true`、`runtime.js` 必须是禁用态原文 | `tools/check-wechat-project.mjs:17`、`tools/check-wechat-project.mjs:56` |
| PG | `127.0.0.1:55432` / `gengyun_real_evidence` | `psql -h 127.0.0.1 -p 55432 -U postgres -d gengyun_real_evidence` |
| 开发者工具 | `2.02.2608080`（安装目录 `D:\微信web开发者工具`：`微信开发者工具.exe` 的 FileVersion 为 `2.02.0`，`卸载微信开发者工具.exe` 的 FileVersion 为 `2.02.2608080`，本页取后者） | 文件版本属性 |
| 日志 | `E:\GengYunCommander\.pg17\tmp\login-ready\api.log`（pino JSON 行，**只读**） | 逐行 `ConvertFrom-Json`，用 `reqId` 把 `req` 与 `res` 配对 |

### 1.1 为什么必须 `urlCheck=false` ＋ 局域网 IP

1. **域名校验对 http/IP 一律不放行**：微信开发者工具的「域名校验」要求请求域名是**已备案 + HTTPS** 的
   合法域名，局域网 IP 无法进白名单。校验开启时 `wx.request` 在**客户端就 fail**，请求**根本到不了
   服务端**——`api.log` 里连一行都不会出现。本次能读到手机发来的 12 条，前提就是副本里
   `urlCheck: false`。
2. **关闭校验只能发生在被忽略的副本里**：仓内共享源码要求 `urlCheck: true`
   （`tools/check-wechat-project.mjs:17`），本地化只允许发生在被忽略副本
   （[本地开发](../reference/local-development.md) §导入说明）。本次副本确实**未入库**。
3. **基址必须是电脑的私网 IP，不能是 127.0.0.1**：真机调试时代码跑在**手机上**，`127.0.0.1` 指手机
   自身（同口径见[历史真机说明](../archive/development-2026-10-10/docs/local-wechat-debug.md)）。所以三件事
   必须同时成立：副本 `apiBaseUrl` 用 `192.168.35.69:55433`、API 绑 `0.0.0.0`（不能只绑回环）、
   **手机与电脑同一网段**。
4. **副本 AppID 必须与私密凭据里的 appId 完全一致**：code 是「发给某个 appid」的一次性凭证，服务端用
   另一个 appid 去换会失败；本服务的对应映射是 `errcode 40029/40163 ⇒ 400 INVALID_REQUEST`
   （`services/api/src/auth/wechat.ts:123-124`）。

## 2 逐条请求表（手机，来源 IP `192.168.35.117`）

时间列为日志中**请求到达**时刻；`reqId` 取前 8 位便于回查（登录那一行为全值）。

| # | 时刻（UTC+08:00） | 方法 | 路径 | 状态 | 耗时 ms | 来源 IP | reqId |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 20:39:27.056 | GET | `/api/v1/auth/session` | **401** | 105.287 | 192.168.35.117 | `7fef98b7` |
| 2 | 20:42:31.942 | POST | `/api/v1/auth/wechat` | **200** | **2011.396** | 192.168.35.117 | `d656d8a7-ab71-4601-9316-8e0864179223` |
| 3 | 20:42:34.055 | GET | `/api/v1/auth/session` | 200 | 7.151 | 192.168.35.117 | `6894a6fa` |
| 4 | 20:42:34.667 | GET | `/api/v1/messages/unread-count` | 200 | 15.593 | 192.168.35.117 | `7aa9ac82` |
| 5 | 20:42:37.714 | GET | `/api/v1/auth/session` | 200 | 2.668 | 192.168.35.117 | `e3416bdf` |
| 6 | 20:42:37.759 | GET | `/api/v1/me/profile` | 200 | 240.302 | 192.168.35.117 | `15520189` |
| 7 | 20:42:37.773 | GET | `/api/v1/catalog/crops` | 200 | 775.547 | 192.168.35.117 | `e666455d` |
| 8 | 20:42:37.817 | GET | `/api/v1/catalog/regions` | 200 | 722.629 | 192.168.35.117 | `19d0986b` |
| 9 | 20:42:37.856 | GET | `/api/v1/favorites` | 200 | 627.688 | 192.168.35.117 | `c30f2e3d` |
| 10 | 20:42:37.886 | GET | `/api/v1/posts` | 200 | 531.767 | 192.168.35.117 | `e7a48808` |
| 11 | 20:42:37.921 | GET | `/api/v1/history` | 200 | 547.938 | 192.168.35.117 | `20d86f81` |
| 12 | 20:42:38.521 | GET | `/api/v1/messages/unread-count` | 200 | 12.239 | 192.168.35.117 | `a9f2cdb0` |

路由归属（供复核）：`/auth/wechat` 见 `services/api/src/routes/auth.ts:43`，`/auth/session` 见
`services/api/src/routes/auth.ts:85`，`/messages/unread-count` 见 `services/api/src/routes/messages.ts:53`，
`/catalog/{kind}` 见 `services/api/src/routes/profile.ts:44`，`/favorites` 见
`services/api/src/routes/favorites.ts:89`，`/posts` 见 `services/api/src/routes/community.ts:202`，
`/history` 见 `services/api/src/routes/history.ts:83`。

第 7–11 条是**并行发起**的（首尾只差 148 ms，回包集中在 20:42:38.418–38.549），所以它们各自的耗时
不能横向比较成「接口快慢」，也不能和同页的 `/auth/session`（2.668 ms）对比。

### 2.1 `401 → 200` 的语义

- **20:39:27 的 401 是启动探活**：小程序冷启动先问「有没有会话」，此时**没有 cookie**，
  `/auth/session` 的 `guards.requireUser` 直接 401。它 105.287 ms 的价值在于**证明请求真的进了服务端**：
  本机同款 401 只要 0.336–0.840 ms（见 §3 对照表），105 ms 是手机 → 局域网 → 服务端的真实往返。
- **20:42:34 起的 200 是登录之后的同一接口**：会话 cookie 已在客户端，同一个 `/auth/session` 变 200，
  耗时回落到 7.151 ms / 2.668 ms。**两条的区别只有「有没有带可用会话」，不是服务行为变了。**
- 第 2 条之外的所有 200 都依赖第 2 条拿到的会话；把它删掉，后面 10 条应当全部回到 401。

### 2.2 两条会话的时间差（服务端只在「回包前」落库）

| 事件 | 时刻（UTC+08:00） |
| --- | --- |
| `POST /auth/wechat` 到达 | 20:42:31.942 |
| 该请求 `request completed`（日志自记） | 20:42:33.956 |
| 耗时 `responseTime` | **2011.396 ms** |
| **手机会话 `public.sessions.created_at`** | **20:42:33.943** |

- 会话行比**请求到达**晚 **2001 ms**、比**回包**早 **13 ms**：写库发生在「外呼 + 建会话」之后、
  「发出 200」之前，顺序与实现一致（`services/api/src/auth/service.ts:159-165`：先 `exchange`、
  再 `findUserBySubject`、再 `issueSession`）。
- 这 2001 ms 里，进程内**只有一处出网**：`services/api/src/auth/wechat.ts:89-92` 拼 URL、
  `services/api/src/auth/wechat.ts:98` 的 `fetch`（超时上限 `EXCHANGE_TIMEOUT_MS = 8000`，
  `services/api/src/auth/wechat.ts:33`）。合成模式走
  `services/api/src/auth/wechat.ts:69-73`，**同步返回、没有任何外呼**，因此不可能产生秒级耗时。
- 会话有效期：`expires_at − created_at = 7.000 天`，与 `USER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60`
  （`services/api/src/auth/tokens.ts:12`）逐字一致。

## 3 对照：同一日志里的两次模拟器登录（证明「真外呼」不是本地兜底）

| 时刻 | 完成时刻 | 方法 / 路径 | 状态 | 耗时 ms | 来源 IP | reqId |
| --- | --- | --- | --- | --- | --- | --- |
| 20:02:42.546 | 20:02:42.865 | POST `/api/v1/auth/wechat`（**无效 code**） | **400** | **318.299** | 127.0.0.1 | `655b8e1f` |
| 20:16:47.440 | 20:16:49.529 | POST `/api/v1/auth/wechat` | **200** | **2044.647** | 127.0.0.1 | `39424b34` |
| 20:02:42.506 | 20:02:42.507 | GET `/api/v1/auth/session` | 401 | **0.840** | 127.0.0.1 | `dc2ece89` |
| 20:04:04.708 | 20:04:04.709 | GET `/api/v1/auth/session` | 401 | **0.336** | 127.0.0.1 | `2af74c56` |

- **400 这条是「真外呼」的硬证据**：合成模式分支（`services/api/src/auth/wechat.ts:69-73`）永远不会
  返回 400；能给出 400 的唯一路径是微信返回 `errcode 40029/40163`
  （`services/api/src/auth/wechat.ts:123-124`），即服务端**确实拿着 code 去问了微信**。
- 318.299 ms 这个量级也自证：本机 401 的基线是 0.336–0.840 ms，318 ms 只可能来自一次**跨网往返**。
- 20:16:47 那次 200（**2044.647 ms**）与手机这次 200（**2011.396 ms**）同量级，两次都是真实往返；
  其会话行 `created_at = 20:16:49.512`，比回包（20:16:49.529）早 **17 ms**，与 §2.2 同一条顺序。
- 说明：`api.log` 是**追加写入**（`run-api.cmd` 用 `>>`），因此同一文件里既有 pid 14740（20:22:07
  启动，`0.0.0.0:55433`）的行，也有它**前一次实例**留下的 20:02／20:16 行；两者不影响各自的读数，
  但**不能把跨实例的行当成一次连续会话**。

## 4 数据库侧证据（psql 原样输出）

```
users|sessions|active_sessions
1|2|2

id|user_id|audience|created|expires|revoked_at|days
5814b9e9-ed89-49e2-9789-5d9e305c1e6f|099a67af-1d04-4fd4-8c39-fb33b81a2ff9|user|2026-10-23 20:16:49.512|2026-10-30 20:16:49||7.000
a57c3625-bcb0-478d-accc-a2b62bc3a05e|099a67af-1d04-4fd4-8c39-fb33b81a2ff9|user|2026-10-23 20:42:33.943|2026-10-30 20:42:33||7.000

id|state|revision|created
099a67af-1d04-4fd4-8c39-fb33b81a2ff9|active|1|2026-10-23 20:16:49.431
```

取数命令（只读）：

```
psql -h 127.0.0.1 -p 55432 -U postgres -d gengyun_real_evidence -A -F '|' \
  -c "select id, user_id, audience, to_char(created_at,'YYYY-MM-DD HH24:MI:SS.MS') as created,
             to_char(expires_at,'YYYY-MM-DD HH24:MI:SS') as expires, revoked_at,
             round(extract(epoch from (expires_at-created_at))/86400,3) as days
        from public.sessions order by created_at;"
```

- `public.sessions` 2 行、`revoked_at` 均为空（= active 2）、`audience` 均为 `user`；`audience` 只能是
  `user` 由表约束固定（`services/api/db/migrations/0001_initial_schema.sql:57`）。
- `expires_at > created_at` 亦有约束兜底（`services/api/db/migrations/0001_initial_schema.sql:58`）。

## 5 必须写的发现：手机这次命中同一条 user 行

**观察**：`public.users` 只有 **1** 行，`created_at = 20:16:49.431`（**模拟器**那次登录建立）；手机的
会话（`created_at = 20:42:33.943`）与它**同属** `user_id 099a67af-1d04-4fd4-8c39-fb33b81a2ff9`，
两条会话都 active。

**机制**（可复核）：服务端不存 openid 原文，只把 `appId + openid` 折成 `subjectLookupHex`
（`services/api/src/auth/wechat.ts:62-64`、`services/api/src/auth/wechat.ts:129`），登录时先
`findUserBySubject`、没命中才 `createUser`
（`services/api/src/auth/service.ts:162-163`）；`users.wechat_subject_lookup` 上有**唯一索引**
（`services/api/db/migrations/0001_initial_schema.sql:46`）。

**结论**：手机的 `wx.login` 与模拟器的 `wx.login` 得到的是**同一个真实微信账号的 openid**（同一 appid
生效），因此两次登录折出同一个 subject、命中同一条 user 行 —— **同一身份的两个设备会话**，而不是
两个用户。反过来看，这也说明模拟器那次**不是本地假身份**：它走的是同一个真实微信账号。

**边界**：本页不记录 openid，故「同一身份」是由「唯一索引 + 只命中一条 user 行」推出的等价结论，
不是 openid 原文的逐字比对。

## 6 证明了什么 / 没证明什么

**证明（本页可支撑）**：

1. **真机流量到达自建服务端**：12 条记录的 `remoteAddress` 全是 `192.168.35.117`，而模拟器那两次是
   `127.0.0.1`；对照清晰，不是本机自打。
2. **真 code、真微信往返**：`POST /auth/wechat` 200 且 **2011.396 ms**；同日志另有 **400 / 318.299 ms**
   的无效 code 对照——合成模式给不出 400，也拿不出秒级耗时（§3）。
3. **会话落到 PG 且 7 天有效**：2 行 `sessions`、`audience=user`、`revoked_at` 空、差值精确 7.000 天。
4. **登录后读面可用**：同一会话下 `/auth/session`、`/messages/unread-count`、`/me/profile`、
   `/catalog/crops`、`/catalog/regions`、`/favorites`、`/posts`、`/history` 全 200。
5. **会话不是一次性的**：20:51:23.510–20:53:26.893 同一 IP 另有 **54** 条请求，**方法全是 GET、状态
   全是 200**（本页不逐条展开），说明登录态在这段时间内持续可用，不是一次登录只服务一轮。

**没证明（必须与上面的结论一起引用）**：

- **单账号、单机型、单次登录（N=1）**：没有第二个微信账号、没有第二款手机、没有重复采样的稳定性结论。
- **无并发验证**：没有多设备同时登录、没有同账号并发写、没有压测；两次成功登录是**先后**发生的。
- **没验证失败与边界路径**：token 刷新、`logout` 撤销（`services/api/src/routes/auth.ts:101`）、过期后
  重登、幂等重放（`Idempotency-Key` 走 `replayUserLogin`）、`admin` 会话，全部**未测**。
- **非 HTTPS、非生产部署**：`http://` + 局域网 IP + `urlCheck=false`；关闭域名校验只在开发者工具/
  真机调试下有效，**不代表线上可用**，也不代表备案/证书/网关就绪。
- **「手机」这一属性是操作事实**：日志只能证明请求来自 `192.168.35.117` 这台局域网设备（真机调试二维码
  由该机扫描）；它无法区分「手机」和「另一台电脑」。
- **2011.396 ms 不是微信侧耗时分解**：进程内没有分段计时，本页只给「客户端可观测总耗时 + 出网唯一性」
  的推理，不给「微信花了多少」的断点读数。
- **openid 未比对原文**：见 §5 边界。

## 7 复现步骤

前置：API 已按 real 模式起在 `0.0.0.0:55433`（`run-api.cmd` 的那两条命令），PG 在
`127.0.0.1:55432/gengyun_real_evidence` 且迁移 32/32；手机与电脑同一网段。

1. 把仓库 `miniprogram/` **复制到被忽略的临时目录**（本次是
   `.pg17/tmp/login-ready/miniprogram-local`，位于仓库外），再改两处：`miniprogram/config/runtime.js` 的
   `apiBaseUrl = http://<电脑私网 IPv4>:55433/api/v1`；`project.config.json` 的 `appid` 与私密凭据里的
   appId **逐字一致**、`setting.urlCheck = false`。**仓库内 `miniprogram/` 一律不动**。
2. 开发者工具导入**副本目录**（不是仓库根），工具里确认当前 AppID、基础库与「域名校验」实际生效值。
3. 选**真机调试**（不是模拟器、不是「预览」），手机扫码；手机与电脑连同一个可信网络。
4. 手机上点登录；成功判据是 `api.log` 出现 `POST /api/v1/auth/wechat` **200**，且随后
   `/auth/session` **200**、`sessions` 新增一行 `audience=user`、`expires_at − created_at = 7 天`。

**四个坑（每一个都会让登录停在客户端、服务端毫无记录）**：

| 坑 | 症状 | 处理 |
| --- | --- | --- |
| 手机与电脑不同网段 | `wx.request` 直接 fail，日志零行 | 同网段；用电脑私网 IPv4，不要用 `127.0.0.1` |
| 副本 appid 与私密凭据不一致 | 登录 400（code 无效/已使用） | 两侧 appId 逐字对齐 |
| 忘了 `urlCheck=false` | 客户端报域名不合法，日志零行 | 只在被忽略副本里关；仓内共享源码保持 `true` |
| 用了模拟器/预览而不是真机调试 | 请求来源是 `127.0.0.1`，不是手机 | 选「真机调试」，并核对日志 `remoteAddress` |

**排障顺序（按日志二分，别猜）**：

1. 登录卡住先看 `/api/v1/auth/session` **有没有到服务端**（401 也算到）：**到** ⇒ 网络/域名校验没问题，
   问题在登录本身；**没到** ⇒ 回头查基址、端口、网段、`urlCheck`、防火墙。
2. 再看 `POST /api/v1/auth/wechat` 的**状态码**：**400** ⇒ code 已用/无效或 appid 不匹配；
   **超时/5xx（`PROVIDER_*`）** ⇒ 出网被拦或凭据未配置（`services/api/src/auth/wechat.ts:82-86`）；
   **200** ⇒ 登录成功，转去看 `sessions` 是否落库。
3. 200 但用户对不上：查 `users` 行数（应命中唯一一条）与 `wechat_subject_lookup` 唯一索引。

## 8 采集与脱敏方式（可复核）

- 读日志：逐行 `ConvertFrom-Json`，用 `reqId` 把 `incoming request` 与 `request completed` 配对；
  只取 `req.method / req.url / req.remoteAddress / res.statusCode / responseTime` 与两端的 `time`。
- **只读**：`api.log` 全程未修改、未截断；数据库只用 `select`。
- 毫秒读数取自 `responseTime`（pino 浮点毫秒，如 `2011.3962999999058`），本页统一**四舍五入到
  0.001 ms**（`2011.396`）：不换单位、不省略小数、不做其他加工；日志增长后重跑会得到同样的行。
- 未输出、未落盘的字段：`code`、`openid`、`sessionid`、`access_token`、会话 cookie 值、AppSecret。
- 本页出现的 uuid 都是**库内主键/请求 id**，不含身份信息。

## 9 门禁读数（本页提交前实测）

| 命令 | 读数 | exit |
| --- | --- | --- |
| `node tools/verify-doc-anchors.mjs --strict` | `SCAN: 文档 267 份；4827 条引用`；`BROKEN 33 / OUT_OF_RANGE 6 / SUSPECT 64`（合计 103）；`BASELINE 登记 103 条；本次命中 103 条、基线外新增 0 条、陈旧 0 条` | **0** |
| `npm run test:docs` | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables`；研究记录 `5 通过 / 0 失败 / 4 legacy 已钉住` | **0** |
| `node tools/verify-contract-status.mjs` | `覆盖 113 条契约操作；已装配 110 条；implemented 17 / partial 92 / planned 4；形状错误 0 项；语义错误 0 项` | **0** |

本页**未**改动 `docs/verification/README.md` 索引：不加索引行时 `--strict` 已 PASS，且基线外新增为 0，
故不引入索引行（此前有页面加索引行导致该行变空、多 1 条 SUSPECT）。
