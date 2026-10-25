# API 层限流策略与调参（GY-R34）

本文件说明**认证端点与写接口的限流策略**：默认值、超限时对外表现（错误码与响应头）、
存储边界，以及调参/替换点。实现位于 `services/api/src/rate-limit/`（`limiter.ts` 规则与中间件、
`store.ts` 计数存储），配置解析在 `services/api/src/config.ts` 的 `RATE_LIMIT_*` 区块，
默认值的**唯一事实源**是同处导出的 `RATE_LIMIT_DEFAULTS`——本文件的表格从它抄写，⛔ 不在文档里另立数值。

> 本文件描述的是**当前实现**，不是验收结论；契约层面的错误码仍以
> [OpenAPI](../../packages/contracts/openapi.json) 与[状态协议](state-contract.md)为准。

## 1. 两处执行点（同一份规则表、同一个计数器）

| 执行点 | 位置 | 覆盖 | 为什么在这里 |
| --- | --- | --- | --- |
| `onRequest` 钩子 | `services/api/src/app.ts` 里由 `createRateLimiter(...).mount(app)` 登记（`mount` 内部 `app.addHook('onRequest', …)`） | 认证类端点（`POST /api/v1/auth/*`、`POST /api/v1/admin/auth/*`）按**客户端 IP** 计数 | 登录/后台登录本身是**公开**端点；等鉴权之后再数就永远数不到暴力破解那条路径 |
| 守卫包装（`wrapGuards`） | 包在 `createAuthGuards(...)` 的返回值外层，再交给 `createFlagGatedGuards` | 其余 `POST/PUT/PATCH/DELETE` 按**服务端解析出的用户 id** 计数 | 按用户计数必须发生在鉴权成功之后；包装既有守卫接缝 ⇒ **零路由文件改动** |

执行顺序：`onRequest 限流（IP） → 鉴权 → 限流（用户） → 开关门 → scope → handler`。

装配形态说明：`app.ts` 里这两处执行点写成**一行**
（`const guards = createRateLimiter({ config: config.rateLimit, now: clock }).mount(app).wrapGuards(createAuthGuards(...));`），
`limiter.ts` 的 import 也追加在文件末尾。两个都是**锚点中立**的取舍：`services/api/src/app.ts` 与
`config.ts` 的行号被 `docs/**` 的手写引用与契约台账当锚点，在函数体里多插几行会把别人文档里的
`app.ts:NNNN` 整片推离事实位置（`tools/verify-doc-anchors.mjs --strict` 会点名）。代价是这一行偏长；
规则表、存储与取舍不在该行展开，全在 `services/api/src/rate-limit/limiter.ts` 的文件头与本文。

同一请求串行经过两条守卫（`requireAdmin` + `requireScope`）时，**按规则去重**：一次请求只计一次。
未鉴权的写请求（理论上只可能是公开端点）兜底按 `ip:` 计数，避免出现「数不到」的空洞。

## 2. 默认策略表

| 规则 id | 方法 | 路径前缀 | 计数键 | 默认上限 | 默认窗口 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| `auth-ip` | `POST` | `/api/v1/auth/`、`/api/v1/admin/auth/` | 客户端 IP | 20 次 | 60 000 ms | 登录、退出、后台登录/退出一把尺子 |
| `write-user` | `POST`、`PUT`、`PATCH`、`DELETE` | `/api/v1/` | 用户 id（无身份时兜底 IP） | 120 次 | 60 000 ms | 写接口一律计；`GET` 不计 |

规则表**首个命中生效**：`POST /api/v1/auth/logout` 既像认证端点又像写接口，按上表顺序落到
`auth-ip`（会话类端点用同一把尺子，且它属于「能造/能毁会话」的一类）。

取值依据：

- `POST /auth/wechat` 一次调用对应一次小程序登录，正常人一分钟远到不了 20 次；20 次/分钟足以
  挡住「换 code 刷会话」与撞库，又不会卡住弱网重试。
- 写接口 120 次/分钟 ≈ 2 次/秒，是本仓界面操作节奏（一次点按＝一次写）的上限带余量，
  同时把「脚本狂刷社区/留言」压到人工量级。
- 两侧窗口都取 60 秒：与 `Retry-After` 的整数秒粒度一致，运维只需记一个数。

## 3. 超限时的对外表现（契约）

| 项 | 取值 | 说明 |
| --- | --- | --- |
| HTTP 状态 | `429` | 由错误码映射得出，不由调用点自选 |
| 错误码 | `RATE_LIMITED` | **复用**契约 `error_status_map` 里 429 的既有码（`packages/contracts/states.json`／`services/api/src/contract.ts`），本片**不新增错误码**、不改 `packages/contracts/**` |
| `error.retryable` | `true` | 同一请求稍后重试会成功（口径见 `services/api/src/errors.ts` 的 `retryable` 注释） |
| `Retry-After` | 剩余窗口整数秒（≥1，向上取整） | 由 `retryAfterSecondsFor` **唯一出口**写头：限流器把剩余毫秒放进 `ApiError.retryAfterSeconds`，本函数取整落地 |
| `X-RateLimit-Limit` | 该规则的窗口上限 | 放行与超限都写 |
| `X-RateLimit-Remaining` | 本次之后还剩几次（超限为 `0`） | 放行与超限都写 |
| `X-RateLimit-Reset` | 距离窗口恢复的**整数秒**（不是 epoch 时间戳） | 放行与超限都写 |
| `Cache-Control` | `no-store` | 由既有 `onSend` 钩子对 ≥400 响应统一补齐 |

口径细节：

- `Retry-After` 与 `X-RateLimit-Reset` 在**同一窗口**内通常相等（都指向「最早那次命中 + 窗口」）；
  差别只在 `Retry-After` 描述「多久之后重试会成功」，`X-RateLimit-Reset` 描述「窗口何时清空」。
- 被拒的请求**不写入命中**，因此反复重试**不会**延长窗口（客户端按 `Retry-After` 等待即可恢复）。
- 非 429/409 的响应不写 `Retry-After`（契约里该头只对可重试 429/409/503 有意义；
  限流器只产出 429）。
- **豁免路径与白名单 IP 的请求不写任何限流头**：`limiter.ts` 在判定「豁免路径 / 白名单 IP」后
  **直接 `return`**（`checkIpRules` / `checkUserRules` 两处早退），既不计命中也就不写
  `X-RateLimit-*`——`/health` 这类健康检查的响应体与头保持原样，探针不会因为多出三个头而误判。
  换句话说：`X-RateLimit-*` 只出现在**真正被规则覆盖**的响应上；「看不到限流头」= 这条请求
  不在限流规则、或命中了豁免/白名单，而不是「额度无限」。

## 4. 计数模型：滑动窗口（why not 令牌桶）

实现是**精确滑动窗口日志**：每个 key 只保存「窗口内每次放行的时间戳」，窗口右移时过期命中被逐出。

- 相比**固定窗口计数**：不会在窗口边界出现「双倍突刺」（固定窗口最坏允许 `2 × limit`）。
- 相比**令牌桶**：令牌桶更平滑、能表达「匀速 N 次/秒」，但需要为每个 key 持久化令牌数与上次补充
  时刻，且「一分钟内最多 N 次」这类**可解释口径**难以直接映射；认证/写接口都是**人类操作**，
  滑动窗口的「一分钟内 N 次」更贴近直觉，`resetAt` / `Retry-After` 也能从命中时间直接算出。
  代价是单 key 最多存 `limit` 个时间戳（上限即窗口上限，量级 1e2），内存可控。

## 5. 存储边界（重要）

> **单实例内存计数，多实例需外置存储。**

- 计数在**进程内**：`createMemoryRateLimitStore()`（`services/api/src/rate-limit/store.ts`）。
  N 个实例 ⇒ 实际允许量约为 `N × limit`，且 `Retry-After` 只反映**本实例**的窗口。
- **多副本口径（运维必读）**：横向扩到 N 个副本时，客户端实际能拿到的额度是 `N × limit`
  （每个副本各有自己的桶）；`Retry-After` / `X-RateLimit-Reset` 也只描述**本实例**看到的窗口，
  同一客户端下一秒可能被另一个副本放行或拒绝。要么按「单副本额度 × N ≈ 期望额度」反推
  `RATE_LIMIT_*_LIMIT`，要么上外置存储（见下一条）；云托管侧同口径见 `deploy/cloudrun/README.md`。
- 不引入新的外部依赖：**没有** Redis / 限流库（`services/api/package.json` 仍只有 `fastify` 与 `pg`）。
- 替换点**已接口化**：`RateLimitStore` 只要求 `consume(key, window, nowMs)` / `sweep(nowMs)` / `size()`，
  中间件、规则表、错误码、响应头全部与存储实现解耦。换外置存储＝再实现一个 `RateLimitStore`
  （若实现是异步的，需把接口改为 `Promise` 并在 `limiter.ts` 的两处调用点 `await`），
  路由文件与契约均不变。
- `sweep(nowMs)` 在生产**没有调用点**（本仓禁止 `setInterval`，不做进程内调度）：内存 store 的
  有界性靠 `consume` 时对单个 key 的逐次修剪 + `RATE_LIMIT_MAX_KEYS` 的 LRU 淘汰保证；
  当前 `sweep` **仅供测试与未来外置存储驱动使用**（外置驱动可用自己的调度器调它，不必改本仓）。
- 内存有界：key 总数默认上限 5000（`RATE_LIMIT_MAX_KEYS`），超出后淘汰**最久未使用**的 key。
  被淘汰的 key 计数归零 ⇒ 该 key 的限流**临时失效（fail-open）**。这是有意的取舍：宁可漏限一个冷
  key，也不能让攻击者用海量随机 key 把进程内存打爆。评估口径：单个 key 最多 `limit` 个时间戳，
  5000 个活跃 key × 每 key ≤ 120 个数字，量级在 1e5 数字。

## 6. 调参表

| 环境变量 | 含义 | 默认值 | 允许区间 | 改了会怎样 |
| --- | --- | --- | --- | --- |
| `RATE_LIMIT_ENABLED` | 总开关 | `true` | `true`/`false`（也接受 `1`/`0`） | `false` ⇒ 不计数、不写头、不产生 429（熔断/压测时用） |
| `RATE_LIMIT_AUTH_LIMIT` | 认证端点窗口上限 | `20` | 1..100000 | 调小更严格；登录异常量上升时先看这条是否被误伤 |
| `RATE_LIMIT_AUTH_WINDOW_MS` | 认证端点窗口长度 | `60000` | 100..3600000 | 与上限同比例调整才保持同等强度 |
| `RATE_LIMIT_WRITE_LIMIT` | 写接口窗口上限 | `120` | 1..100000 | 社区/留言刷屏投诉多则调小 |
| `RATE_LIMIT_WRITE_WINDOW_MS` | 写接口窗口长度 | `60000` | 100..3600000 | 同上 |
| `RATE_LIMIT_EXEMPT_PATHS` | 豁免路径前缀（逗号分隔） | `/health` | 以 `/` 开头的纯路径 | 逐条**精确/前缀**豁免；显式空串（`RATE_LIMIT_EXEMPT_PATHS=`）表示**清空**默认豁免 |
| `RATE_LIMIT_ALLOWLIST_IPS` | 豁免 IP（逗号分隔，精确匹配） | 空 | IPv4/IPv6 字面量 | 给运维探针/压测机留口子；⛔ 不接受网段写法（`10.0.0.0/8` 会被判 `INVALID_VALUE`） |
| `RATE_LIMIT_MAX_KEYS` | 进程内 key 上限 | `5000` | 1..1000000 | 调大＝更少 fail-open，内存占用随之上升 |
| `API_TRUST_PROXY` | 是否信任反向代理（决定 `request.ip` 取 socket 对端还是 `X-Forwarded-For` 里的客户端） | `false` | `true` / `false` / `0..32` 的整数跳数 | 网关后**是否**打开按两条准入条件之一判定（(a) 网关**已确认会覆盖/清洗**客户端传入的 `X-Forwarded-For`；(b) 使用**受保护的固定代理跳数**，即跳数本身不可被客户端影响）；**核实网关行为之前保持默认 `false`**（代价是 `auth-ip` 退化成全站共享额度）。⚠ 只把容器限制成「只能经网关访问」**不**足以让整条链可信：`true` 取 XFF **最左项**，网关若「在客户端自带 XFF 之后追加真实地址」，最左项仍是客户端可控 ⇒ 攻击者换头即换限流桶。数字跳数只在「反向代理**覆盖**（而非追加）`X-Forwarded-For`、且代理层数固定」时才安全：`1` 信的是 XFF **末段**，即对端写入、客户端直连时可伪造的值。风险与取值口径见 §8「代理与 IP 语义」 |

配置口径（与其它 `*_` 环境变量一致）：

- 缺省即默认策略，**不是** `real` 模式的启动必填项；给了非法值 ⇒ 启动即 `ConfigError`，
  一次性列出**全部**非法字段（`INVALID_VALUE`），⛔ 不静默夹取/退回默认。
- 数字键只接受整数；窗口长度下限 100 ms（低于它等于关闭限流）。
- `RATE_LIMIT_ENABLED` 与豁免/白名单都是**运维手段**：不要在业务代码里按请求动态开关。
- `API_TRUST_PROXY` 特意用 `API_` 前缀而**不是** `RATE_LIMIT_`：它是**服务器级**代理语义
  （`request.ip` 同时进请求日志的 `remoteAddress`），不属于限流器的调参；限流器只是
  `request.ip` 的消费方之一。

## 7. 白名单与豁免的边界

- `RATE_LIMIT_EXEMPT_PATHS` 走的是**路径前缀**匹配：`/health` 同时豁免 `/health` 与 `/health/…`。
  健康检查不因同机其它流量被判超限。
- `RATE_LIMIT_ALLOWLIST_IPS` 是**精确 IP** 匹配（`::ffff:1.2.3.4` 与 `1.2.3.4` 归一为同一键），
  不解析网段——本仓不引入 IP 段库，也不做地理/代理链推断。
- 两者都**只影响计数**，不影响鉴权与授权：豁免的请求仍需各自的会话/scope。

## 8. 未做项与风险

| 项 | 现状 | 影响 / 后续 |
| --- | --- | --- |
| 多实例一致限流 | **未做**：进程内计数，多实例不共享 | 需要外置存储（Redis/PG/网关令牌桶）时按 `RateLimitStore` 接口另实现；本片明确**不引入** Redis |
| 分布式限流的时钟一致性 | **未做** | 外置实现需自带时钟口径（本接口已把 `nowMs` 作为入参传入，不读系统时钟） |
| 反向代理后的真实客户端 IP | 已提供开关 `API_TRUST_PROXY`（默认 `false`） | 部署在网关/代理之后**是否**打开取决于准入条件（网关已确认覆盖/清洗 XFF，或受保护的固定跳数）；**核实前保持 `false`**；不打开时 `request.ip` 恒为网关地址、`auth-ip` 退化成全站共享额度，开启后的取值与伪造风险见下方「代理与 IP 语义」 |
| 跨域调用方读取限流头 | **未做**：不设 `Access-Control-Expose-Headers` | 同源（H5 同域、小程序 `wx.request`、后台同源）本来就能读这些头；将来出现跨域调用方时再在 CORS 层暴露 `Retry-After` / `X-RateLimit-*`，本片**不引入** CORS |
| 按路由细分的额度 | **未做**：写接口一条规则覆盖全部写方法 | 若某端点需要独立额度，按 `defaultRateLimitRules` 的形态增一条规则（首个命中生效，注意顺序） |
| 计数观测指标 | 仅 `size()`（当前 key 数），**未**接指标/日志 | 需要时在 `enforce` 旁加计数，不改变语义 |
| 与供应商侧限流的区别 | 本片只管**本仓 API 入口** | AI 供应商 429（`PROVIDER_QUOTA_EXCEEDED`）走各自的适配器与既有测试（`tests/unit/gy-i22-rate-and-timeout.test.mjs`），不是本限流器 |

### 代理与 IP 语义（`API_TRUST_PROXY`）

限流器只用 `request.ip` 作为 IP 键（`services/api/src/rate-limit/limiter.ts` 的两处 `normalizeIp(request.ip)`），
而 `request.ip` 由 Fastify 的 `trustProxy` 决定——所以「关掉信任」与「信错代理」都会改变额度归属：

- **默认 `false`（不信任任何代理）**：`request.ip` = TCP 对端（socket）地址，`X-Forwarded-For`
  **完全被忽略**。直连部署、本地开发、单测都按这个口径；伪造 XFF 也换不到新桶。
- **网关之后（微信云托管）：先核实网关行为，再决定是否打开**：容器在平台网关后，若不打开，`request.ip` 对所有用户
  都是**同一个网关地址** ⇒ `auth-ip` 的 20 次/分钟退化成**全站共享**的登录额度，一波流量就能让
  所有人登录 429（`write-user` 按用户键不受影响，但未鉴权的写请求兜底用 `ip:` 键，同样共享）。
  这是「**打开**」的动机，但**不是**「必须打开」的理由——打开是否安全取决于网关对
  `X-Forwarded-For` 的处置（覆盖/清洗 vs 追加），见下一条；**核清之前保持默认 `false`**。
- **风险（必读）**：开了 `trustProxy` 就**必须**有可信网关，且客户端不能绕过网关直连容器，否则
  客户端自带 `X-Forwarded-For: <随便一个 IP>` 就能伪造 `request.ip`，**绕过限流**，并污染请求日志的
  `remoteAddress`。两种形态取的位置不同，别当成等价：
  - `true`（信任整条链）：取**最左**项。网关只**追加**不覆盖时，最左就是客户端自己塞进去的伪造值
    （实测：socket `192.0.2.10` + `X-Forwarded-For: 5.6.7.8, 203.0.113.7, 198.51.100.5` ⇒
    `request.ip = 5.6.7.8`）。所以 `true` 的前提是**网关覆盖**该头（或链上没有任何客户端可写的段）。
  - 数字跳数（只信最近 N 跳）：取**最右**可信项（同一请求实测 `1` ⇒ `198.51.100.5`、
    `2` ⇒ `203.0.113.7`）。`1` 信的是 **XFF 末段**，末段由**对端**写入——只有对端一定是网关、
    且代理层数固定时才等于真实客户端；客户端能直连或网关前面还有别的层，末段就是可伪造的值。
  - 因此**没有无条件配方**，只有两条准入条件之一：(a) 目标网关**已确认会覆盖/清洗**客户端传入的
    `X-Forwarded-For`（证据口径：两个不同来源各带一个伪造的 XFF 打进来，`request.ip` 仍等于真实
    来源、且两个来源不同桶，另附网关侧配置形态的书面证据）；(b) 使用**受保护的固定代理跳数**
    （跳数本身不可被客户端影响）。**在核实网关行为之前保持默认 `false`**；没有可信网关时同样保持
    `false`。⚠ 把容器限制成「只能经网关访问」并**不**能证明最左项可信——网关若在客户端自带 XFF
    **之后追加**真实地址，`true` 取到的仍是最左那个客户端可控的值。代价一致——容器不能被绕过网关
    直连。本文档**未取得**目标网关覆盖/清洗行为的实测证据，该核对已列入
    `deploy/cloudrun/README.md` §2 的「部署验收待验证」项与 §4.1 的准入条件 (a)。
- **取值面**：`true` / `false` / `0..32` 的整数跳数（`0` 等价 `false`，`1` = 只信任最近一跳）。
  `1` / `0` 按**跳数**解释而非布尔（与 `RATE_LIMIT_ENABLED` 接受 `1/0` 不同）；`yes`、`-1`、`2.5`、
  `>32` 都在启动时以 `ConfigError` 一次性报出，**不夹取**、不猜。
- **实现注意**：Fastify 5 **不再接受数字**（`trustProxy: number` 会把所有来源判成不可信、静默
  fail-closed 退回到 socket 地址），因此布尔以外的取值由 `trustProxyOption` 编译成自定义谓词
  `(_address, hop) => hop < trustProxy`（`services/api/src/app.ts:2450-2455`，原记 :2271-2276）后传入：谓词只判
  `hop`，`address` 不参与判断，语义与 `proxy-addr` 的 hop 形态一致。改这里时别忘了
  `tests/unit/rate-limit.test.mjs` 里「默认忽略 XFF / 打开后按 XFF 分桶」两条断言。
- **额外的落盘面（开 `trustProxy` 的副作用）**：请求日志里的 `remoteAddress` 会从网关地址变成
  **真实客户端 IP**（`services/api/src/app.ts:742`，原记 :630）。这是本片新引入的「终端用户 IP 落盘」，
  与限流生效与否是两件事——需要和日志脱敏/留存口径一起评估，而不是只看 429 是否按 IP 分开。
## 9. 验证

```bash
node --test "tests/unit/rate-limit.test.mjs"
node --test "tests/unit/miniprogram-auth-runtime.test.mjs"
node tools/verify-contract-status.mjs
node tools/verify-doc-anchors.mjs --strict
```

`tests/unit/rate-limit.test.mjs` 覆盖：窗口内超限 429、窗口过期恢复、不同 key（IP/用户）互不影响、
豁免路径与白名单、`mount` 登记 `onRequest` 钩子/关闭时不登记、`RATE_LIMITED` + `Retry-After` +
`X-RateLimit-*` 字段正确、同一请求两条守卫只计一次、配置缺省/覆盖/非法值一次报全；
返修补入**代理语义两向断言**（默认配置下换 `X-Forwarded-For` 不换 socket ⇒ 同一桶；`API_TRUST_PROXY=true`
时换 XFF 即换桶）、**真实路由去重**（`POST /api/v1/admin/posts/:id/hide` 在一次「守卫 + 限流」里只计一次），
以及豁免断言的可证伪化（`exemptPaths: ['/api/v1/auth']` 打 `/api/v1/auth/wechat`）。

`tests/unit/miniprogram-auth-runtime.test.mjs` 覆盖登录 429 的用户可读文案（秒数优先取 `Retry-After` 头，
缺头时退回服务端 `error.message`），并锁住「其它错误码仍显示错误码」这条老行为。
