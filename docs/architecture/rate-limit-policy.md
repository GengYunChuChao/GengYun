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
- 不引入新的外部依赖：**没有** Redis / 限流库（`services/api/package.json` 仍只有 `fastify` 与 `pg`）。
- 替换点**已接口化**：`RateLimitStore` 只要求 `consume(key, window, nowMs)` / `sweep(nowMs)` / `size()`，
  中间件、规则表、错误码、响应头全部与存储实现解耦。换外置存储＝再实现一个 `RateLimitStore`
  （若实现是异步的，需把接口改为 `Promise` 并在 `limiter.ts` 的两处调用点 `await`），
  路由文件与契约均不变。
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

配置口径（与其它 `*_` 环境变量一致）：

- 缺省即默认策略，**不是** `real` 模式的启动必填项；给了非法值 ⇒ 启动即 `ConfigError`，
  一次性列出**全部**非法字段（`INVALID_VALUE`），⛔ 不静默夹取/退回默认。
- 数字键只接受整数；窗口长度下限 100 ms（低于它等于关闭限流）。
- `RATE_LIMIT_ENABLED` 与豁免/白名单都是**运维手段**：不要在业务代码里按请求动态开关。

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
| 反向代理后的真实客户端 IP | 依赖 Fastify `request.ip` | 部署在代理/网关之后时需按部署形态确认 `trustProxy`，否则所有请求会共享代理 IP 的额度 |
| 按路由细分的额度 | **未做**：写接口一条规则覆盖全部写方法 | 若某端点需要独立额度，按 `defaultRateLimitRules` 的形态增一条规则（首个命中生效，注意顺序） |
| 计数观测指标 | 仅 `size()`（当前 key 数），**未**接指标/日志 | 需要时在 `enforce` 旁加计数，不改变语义 |
| 与供应商侧限流的区别 | 本片只管**本仓 API 入口** | AI 供应商 429（`PROVIDER_QUOTA_EXCEEDED`）走各自的适配器与既有测试（`tests/unit/gy-i22-rate-and-timeout.test.mjs`），不是本限流器 |

## 9. 验证

```bash
node --test "tests/unit/rate-limit.test.mjs"
node tools/verify-contract-status.mjs
node tools/verify-doc-anchors.mjs --strict
```

`tests/unit/rate-limit.test.mjs` 覆盖：窗口内超限 429、窗口过期恢复、不同 key（IP/用户）互不影响、
豁免路径与白名单、`mount` 登记 `onRequest` 钩子/关闭时不登记、`RATE_LIMITED` + `Retry-After` +
`X-RateLimit-*` 字段正确、同一请求两条守卫只计一次、配置缺省/覆盖/非法值一次报全。
