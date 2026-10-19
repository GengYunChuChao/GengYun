# GY-I22 缺陷 F-01 修复证据页：拒绝类响应与私有响应统一 `Cache-Control: no-store`

基线 `upstream/main` = `8cc9dd8b1ee251c8d7000390d54e0ba07a6ac37f`；本页对应提交见交接文件 `HEAD` 行。
关联 issue [#22](https://github.com/GengYunChuChao/GengYun/issues/22)（只 `Refs`，不 `Closes`——本片只收口一个响应头缺陷，不是整项安全验收）。

**一句话结论**：唯一产品代码改动是 `services/api/src/app.ts` 里**一个应用级 `onSend` 钩子**（含注释共 +39 行）。I22 矩阵记的 F-01——37 个游客面里 23 面的 401 响应缺 `Cache-Control`——**逐面清零**（矩阵当次读数从「14 面带 / 23 面缺」变为「**37 面带 / 0 面缺**」）。拒绝家族不再只是 401：403、跨用户同形 404、未匹配 404、400 校验、415 媒体类型、500 兜底、503 域门**全部**带 `no-store`；同时**公共只读** `GET /health` 的 200 仍**不带**任何 `Cache-Control`（没有把公共缓存一并关掉）。矩阵回归 6/6、新测试 4/4、全量与干净基线树**失败集合同名同数**。

## 0 怎么读这一页

- 三条采集命令（本片唯一入口，无脚手架、无 `npm run`／`npm test`）：

  ```
  node --test --test-isolation=none tests/unit/gy-i22-cache-headers.test.mjs
  node --test --test-isolation=none tests/unit/gy-i22-secmatrix.test.mjs
  node --test --test-isolation=none "tests/unit/*.test.mjs"
  ```

- 「实测」列写当次真实状态码与响应头取值，逐条可从测试的 `[I22-CACHE]`／`[I22]` 打印行复现。
- 「断言」列 = [新测试](../../tests/unit/gy-i22-cache-headers.test.mjs) 内的行号（矩阵行号指 `tests/unit/gy-i22-secmatrix.test.mjs`，该文件在 `feat/gy-i22-secmatrix` 分支，见 §6）。
- 结论只有三种：**通过** / **缺陷** / **未取得**。本页所有「通过」都来自当次真实发出的请求，不写「代码看起来对」。
- 测试环境：`executionMode=stub` + 内存 store + 替身对象存储 + 合成审核端口 + 合成身份；**不联网、不连 PG、不连微信、不连对象存储**。所有 id / token / 对象 key 均为当次随机合成值。

## 1 缺陷出典（矩阵原文，逐字引用）

来源 `docs/verification/gy-i22-secmatrix-20261019.md` §9「缺陷单」的 F-01 条目：

| 字段 | 原文 |
| --- | --- |
| 现象 | 37 个游客面里有 23 面的 401 响应**没有** `Cache-Control`；只有消息域（3 面）与社区域（11 面）在 `onRequest` 钩子里统一写了 `no-store` |
| 缺口面 | `/favorites`(3)、`/history`(2)、`/media/*`(5)、`/community/media-access`、`/community/media/{grant_id}/content`、`/knowledge`(2)、`/herbicides`(2)、`/me/profile`(2)、`/catalog/crops`、`/auth/session`、`/auth/logout`、`/me/account/deletion`、`/account/deletions/{id}`，共 23 面 |
| 为什么不阻塞 | 全部 37 面都**没有**任何可缓存指令（无 `public`/`max-age`），错误体也不含他人数据；`app.setErrorHandler`（`services/api/src/app.ts:1569-1628`）不写该头，属统一实现缺口而非某域特例 |
| 风险 | 共享缓存/中间代理理论上可缓存一份 401；若同域后续返回 200 响应体，缓存键若忽略 `Authorization` 才有串味风险——本片**未**发现忽略 `Authorization` 的缓存键证据 |
| 处置 | 本片**只记录、不改产品代码**……需与 `no-store` 口径统一后一次性处理 |

本片即那条「一次性处理」：**只动响应头，不动鉴权逻辑、不改状态码、不改错误体结构**。

## 2 归因：不是「忘了写头」，而是**头写在了错误的位置**

判断依据是矩阵自己的分界线——14 面带 / 23 面缺，正好等于「`onRequest` 钩子」与「成功分支写头」两组域的分界，没有第三个例外：

| 域 | 写头位置 | 修复前 401 是否带头 | 说明 |
| --- | --- | --- | --- |
| 消息域（3 面） | `services/api/src/routes/messages.ts:21-23` 的 `onRequest` 钩子 | **带** | `const noStore = async (_request, reply) => { reply.header('Cache-Control','no-store'); }`——钩子在鉴权**之前**执行，成功与失败都写 |
| 社区域（11 面） | `services/api/src/routes/community.ts:181-183` 的 `onRequest` 钩子 | **带** | `const noStoreHook = async (_request, reply) => { reply.header('Cache-Control','no-store'); }`；同文件 `:174-180` 的注释已写明「只在成功分支写头会让错误响应失去 no-store」 |
| 其余 13 个域（23 面） | 各路由的**成功分支**里 `reply.header('Cache-Control','no-store')` | **不带** | 鉴权失败抛 `ApiError` 后直接进 `app.setErrorHandler`，成功分支根本没执行到 ⇒ 401/403/404/409/422/503 全缺该头 |

即：**写头位置与「是否在拒绝路径上执行」强相关**。因此逐路由补漏必然再漏（23 个面 × 每个域各自的错误路径），修法只能落在**响应的统一出口**。

## 3 改动点（唯一产品代码改动）

`services/api/src/app.ts:718-724`，紧跟既有 `onRequest` 钩子之后：

```ts
app.addHook('onSend', async (_request, reply, payload) => {
  if (reply.statusCode >= 400 && reply.getHeader('cache-control') === undefined) {
    reply.header('Cache-Control', 'no-store');
  }
  return payload;
});
```

同文件另有两处**只加注释、不改行为**的交叉引用（`:1596-1597` 的 `setNotFoundHandler`、`:1606-1608` 的 `setErrorHandler`），避免以后有人在这两个处理器里重复写头。`:691-716` 的注释写明缺陷归因、选型理由与三条边界。

**为什么是 `onSend` 而不是只改 `setErrorHandler`**：`setErrorHandler` 覆盖不到 `setNotFoundHandler`（未匹配路径的 404）与将来任何在路由里直接 `reply.status(4xx).send(...)` 的拒绝面；`onSend` 是这三条路径**共同的唯一**出口。§4 第 4 组用合成路由把这一点做成了断言：抛错的 500 与「路由直接 `reply.status(409).send()`」都补到了 `no-store`，而「路由自写 `Cache-Control`」时**不被覆盖**。

**三条边界（不允许被误读）**：

1. **只写错误响应**：`statusCode < 400` 一律不碰 ⇒ 公共只读成功面（`/health`、`/public/home`、`/herbicides` 等）的缓存语义与接线前**逐字节相同**；
2. **不覆盖路由已写的值**：已有 `Cache-Control` 时原样保留（现状里所有成功分支写的就是 `no-store`，本钩子只补「缺」的那些）；
3. **只加一个响应头**：状态码、错误封套结构、`ETag`/`Retry-After` 等既有头、错误码判定次序与鉴权逻辑全部不变。

## 4 逐条断言表

采集命令 `node --test --test-isolation=none tests/unit/gy-i22-cache-headers.test.mjs`，当次读数 **`tests 4 / pass 4 / fail 0 / cancelled 0 / skipped 0`**，耗时 ~1.8s。

### 4.1 第 1 组：游客 401，F-01 的 25 个面逐面断言（`:240`）

循环断言：状态码 `401`、`error.code === 'SESSION_REQUIRED'`、`error.retryable === false`、`Cache-Control` **恰好等于** `no-store`（`:285-289`；辅助函数 `:214`，同时禁止 `public`/`max-age` 子串）。前 23 行是矩阵记的缺口面，末 2 行是 `onRequest` 域对照面。

| # | 面 | 修复前实测 | 当次实测 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | `GET /favorites` | 401 无头 | 401 + `no-store` | 通过 |
| 2 | `POST /favorites` | 401 无头 | 401 + `no-store` | 通过 |
| 3 | `DELETE /favorites/{id}` | 401 无头 | 401 + `no-store` | 通过 |
| 4 | `GET /history` | 401 无头 | 401 + `no-store` | 通过 |
| 5 | `DELETE /history/{id}` | 401 无头 | 401 + `no-store` | 通过 |
| 6 | `POST /media/uploads` | 401 无头 | 401 + `no-store` | 通过 |
| 7 | `POST /media/uploads/{id}/complete` | 401 无头 | 401 + `no-store` | 通过 |
| 8 | `GET /media/{id}` | 401 无头 | 401 + `no-store` | 通过 |
| 9 | `DELETE /media/{id}` | 401 无头 | 401 + `no-store` | 通过 |
| 10 | `POST /media/{id}/access` | 401 无头 | 401 + `no-store` | 通过 |
| 11 | `POST /community/media-access` | 401 无头 | 401 + `no-store` | 通过 |
| 12 | `GET /community/media/{grant_id}/content` | 401 无头 | 401 + `no-store` | 通过 |
| 13 | `GET /knowledge` | 401 无头 | 401 + `no-store` | 通过 |
| 14 | `GET /knowledge/{id}` | 401 无头 | 401 + `no-store` | 通过 |
| 15 | `GET /herbicides` | 401 无头 | 401 + `no-store` | 通过 |
| 16 | `GET /herbicides/{id}` | 401 无头 | 401 + `no-store` | 通过 |
| 17 | `GET /me/profile` | 401 无头 | 401 + `no-store` | 通过 |
| 18 | `PUT /me/profile` | 401 无头 | 401 + `no-store` | 通过 |
| 19 | `GET /catalog/crops` | 401 无头 | 401 + `no-store` | 通过 |
| 20 | `GET /auth/session` | 401 无头 | 401 + `no-store` | 通过 |
| 21 | `POST /auth/logout` | 401 无头 | 401 + `no-store` | 通过 |
| 22 | `POST /me/account/deletion` | 401 无头 | 401 + `no-store` | 通过 |
| 23 | `GET /account/deletions/{id}` | 401 无头 | 401 + `no-store` | 通过 |
| 24 | `GET /messages`（`onRequest` 对照） | 401 带头 | 401 + `no-store` | 通过（未回归） |
| 25 | `GET /posts`（`onRequest` 对照） | 401 带头 | 401 + `no-store` | 通过（未回归） |

面的数量被显式锁住（`:296`：`assert.equal(readings.length, 25, …)`），只允许增不许悄悄减。**每一行都是结构合法的请求**：夹具先经两个真实账号把媒体（两段式上传到 ready）、帖子、评论、举报、收藏、历史、消息都铺出来，游客再拿这些**真实 id** 发请求——若鉴权漏了，服务层会真的去处理它（这才有意义）。

### 4.2 第 2 组：拒绝家族不只 401（`:303`，11 条）

| # | 用例 | 预期 | 当次实测 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | 用户 token `GET /admin/sources` | 403 `SCOPE_DENIED` | 403 + `no-store` | 通过 |
| 2 | 用户 token `GET /admin/accounts` | 403 `SCOPE_DENIED` | 403 + `no-store` | 通过 |
| 3 | A `GET` B 的 `/media/{id}` | 404 同形 | 404 + `no-store` | 通过 |
| 4 | A `DELETE` B 的 `/media/{id}` | 404 同形 | 404 + `no-store` | 通过 |
| 5 | A `PATCH` B 的 `/comments/{id}` | 404 同形 | 404 + `no-store` | 通过 |
| 6 | A `GET` B 的 `/reports/{id}` | 404 同形 | 404 + `no-store` | 通过 |
| 7 | `GET /api/v1/__i22ch-no-such-route` | 404 `NOT_FOUND`（走 `setNotFoundHandler`） | 404 + `no-store` | 通过 |
| 8 | `GET /favorites?limit=not-a-number` | 400 `INVALID_REQUEST` | 400 + `no-store` | 通过 |
| 9 | `POST /favorites`，`content-type: application/xml` | 415（无解析器） | 415 + `no-store` | 通过 |
| 10 | `POST /favorites`，`content-type: text/plain` | 400（解析成字符串后被 schema 拒） | 400 + `no-store` | 通过 |
| 11 | 有效会话 `GET /me/profile`（stub） | 503 `PROVIDER_UNAVAILABLE` | 503 + `no-store` | 通过 |

第 3-6 条同时锁「同形」：跨用户响应与「同形但不存在的 id」响应去掉 `request_id` 后**逐字节相等**（`:337-343`），且两侧都带 `no-store`——缓存头本身也不能成为存在性信号。
第 7 条是选型的直接证据：未匹配路径的 404 走 `setNotFoundHandler`，`setErrorHandler` **根本不会被调用**，仅靠后者修补会漏掉这类面。
用例数下限被锁（`:391`：`assert.ok(cases.length >= 9, …)`）。

### 4.3 第 3 组：2xx 边界 —— 私有仍 `no-store`，公共只读**不带**（`:398`）

| # | 面 | 语义 | 当次实测 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | `GET /favorites` | 私有 2xx | 200 + `no-store` | 通过 |
| 2 | `GET /history` | 私有 2xx | 200 + `no-store` | 通过 |
| 3 | `GET /messages` | 私有 2xx | 200 + `no-store` | 通过 |
| 4 | `GET /messages/unread-count` | 私有 2xx | 200 + `no-store` | 通过 |
| 5 | `GET /media/{id}` | 私有 2xx | 200 + `no-store` | 通过 |
| 6 | `GET /posts` | 私有 2xx | 200 + `no-store` | 通过 |
| 7 | `GET /posts/{id}` | 私有 2xx | 200 + `no-store` | 通过 |
| 8 | `GET /auth/session` | 私有 2xx | 200 + `no-store` | 通过 |
| 9 | `GET /herbicides` | 私有 2xx | 200 + `no-store` | 通过 |
| 10 | **`GET /health`** | **公共只读 2xx（负控制）** | **200，`Cache-Control` 缺省（`undefined`）** | 通过 |
| 11 | `GET /api/v1/public/home` | 公共内容面，stub 下无资料库 | 503 `PROVIDER_UNAVAILABLE` + `no-store` | 通过 |

第 1-9 行说明「私有成功响应也不得可缓存」这条要求在本仓**基线即已满足**（各域成功分支本来就写 `no-store`），本片没有改动它们，只是把它们锁进断言。派单允许的弱形式是 `private` + 无 `max-age`；本仓既有口径严格到 `no-store`，因此这里锁**严格值**。
第 10 行是**负控制**：若哪天有人把收口写成「全局无条件 `no-store`」，这条会立刻变红——它是「没有一律关掉公共缓存」的可执行证明，断言在 `:427`（`assert.equal(result.cache, undefined)`）。
第 11 行是我方公共内容面唯一一条 `no-store`：**它由路由自己写**（`services/api/src/routes/public-home.ts:10`），属接线前既有语义，本片未改（见 §5）。

### 4.4 第 4 组：统一出口的健壮性（`:444`，合成路由，仅测试内注册）

| # | 合成面 | 预期 | 当次实测 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | `GET /__i22ch/throw`（路由抛 `Error`） | 500 + 契约缺口标记 | 500，`contract_gap=NO_CONTRACT_CODE_FOR_500`，`no-store` | 通过 |
| 2 | `GET /__i22ch/reject-409`（路由直接 `reply.status(409).send()`） | 409 原样 | 409 + `no-store` | 通过 |
| 3 | `GET /__i22ch/reject-with-own-header`（403 + 路由自写 `private, max-age=0`） | 不覆盖 | 403，头仍为 `private, max-age=0` | 通过 |
| 4 | `GET /__i22ch/public-200`（合成公共 200） | 不加头 | 200，`Cache-Control` 缺省 | 通过 |

第 1 行覆盖 `setErrorHandler` 的最后一跳（500 兜底）；第 2 行覆盖 `setErrorHandler` **看不见**的路径（`onSend` 是唯一出口）；第 3 行锁「不夺权」；第 4 行再次证明 `statusCode < 400` 不被触碰。四条合成路由只存在于测试文件内，不进产品代码。

## 5 「公共只读保持可缓存」的边界说明

- 本片**只**在 `statusCode >= 400` 时写头，因此对任何 2xx 响应的头与体**逐字节无影响**——这不是「按接口类型白名单」判断，而是按状态码判断，不依赖域的公有/私有标注，也就不会因为某个域被重新标注而改变行为。
- 公共只读的可执行负控制是 `GET /health` 200（§4.3 第 10 行，压测点在 `:427`）。
- 公共内容面 `/api/v1/public/home` 在接线前就由路由自己写 `no-store`（`routes/public-home.ts:10`），本片**未改动**它；`/public/home` 的 503 只是 stub 下无资料库的当次读数，**不代表真实 PG 下的缓存语义**（真实 200 的读取见 §7「未取得」）。
- 按派单要求：**没有**把 `no-store` 加到静态资源（`apps/web`、`miniprogram/` 的静态产物不在 Fastify 路由内，本次零改动），也没有把公共只读的成功面纳入 `no-store`。

## 6 门禁读数（逐条）

| # | 门禁 | 命令 | 当次读数 | 结论 |
| --- | --- | --- | --- | --- |
| ① | 依赖 | `npm ci --ignore-scripts`（工作树内） | `added 103 packages`，`found 0 vulnerabilities` | 通过 |
| ② | 新增测试 | `node --test --test-isolation=none tests/unit/gy-i22-cache-headers.test.mjs` | `tests 4 / pass 4 / fail 0 / cancelled 0 / skipped 0`，~1.8s | 通过 |
| ③ | 矩阵回归 | `node --test --test-isolation=none tests/unit/gy-i22-secmatrix.test.mjs` | `tests 6 / pass 6 / fail 0 / cancelled 0 / skipped 0`，~3.0s；C1 缓存头读数 **37 面带 `no-store` / 0 面缺**（基线 14 带 / 23 缺） | 通过 |
| ④ | 定向域测试（17 个文件） | `node --test --test-isolation=none tests/unit/{messages-security,messages-http,community-http,favorites-http,history-http,media-http-upload,media-http-access,knowledge-herbicides-http,profile-api,api-health,api-errors,auth-routes,auth-guards,public-home,error-retryable-behavior,idempotency-retry-after-http,admin-route-family-consistency}.test.mjs` | `tests 176 / pass 176 / fail 0` | 通过 |
| ⑤ | 全量单元（改动树） | `node --test --test-isolation=none "tests/unit/*.test.mjs"` | `tests 1627 / pass 1618 / fail 8 / cancelled 0 / skipped 1 / todo 0` | 见下注 |
| ⑤ | 全量单元（干净基线树 `.pg17/tmp/i22f01-base` @ `8cc9dd8`） | 同命令 | `tests 1617 / pass 1608 / fail 8 / cancelled 0 / skipped 1 / todo 0` | 见下注 |
| ⑥ | 集成（逐套直跑） | `node tests/integration/account-deletion-http.mjs` | `PASS GY-I19 account-deletion loopback HTTP integration`（含 503 域门、409 幂等冲突、跨主体键域隔离） | 通过 |
| ⑥ | 集成 | `node tests/integration/favorites-history-isolation-http.mjs` | `PASS favorites-history-isolation-http`（case3 显式打印 `列表/详情响应 Cache-Control=no-store`） | 通过 |
| ⑥ | 集成 | `node tests/integration/rejections-http.mjs` | `pass 12 / fail 0 / skipped 2` | 通过 |
| ⑦ | 契约状态 | `node tools/verify-contract-status.mjs` | `PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；形状错误 0 项；语义错误 0 项` 等 4 行 PASS | 通过 |
| ⑦ | 契约状态（运行时） | `node tools/verify-contract-status.mjs --runtime` | 上述 4 行 + `PASS: 无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致` | 通过 |
| ⑦ | 文档 | `python -B tools/validate_development_docs.py` | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` | 通过 |
| ⑦ | 空白/冲突标记 | `git diff upstream/main --check` | 无输出，`exit=0` | 通过 |
| ⑦ | 工作树清洁 | `git status --porcelain` | 提交后为空 | 通过 |

**注（⑤ 的对照口径）**：两棵树**失败集合同名同数**——同为 8 条，全部落在 knowledge 域，逐条名字比对为空差异（`Compare-Object` 无输出）。改动树多出的 10 条用例正是本片新增（`gy-i22-cache-headers` 4 条 + 临时拷入的矩阵 6 条，见下段），pass 数因此同为 +10。8 条 knowledge 域失败在基线树上**本就存在**（涉及 PGlite/真实投影链路的环境相关断言），与本片无因果关系：本片未触碰 knowledge 域任何文件，且同一批 `herbicides`/`knowledge` 的 `no-store`/`ETag` 断言在本次运行里为通过（如 `✔ /herbicides 列表：契约封套/实体形状对齐、no-store、列表不带 ETag`）。按派单「失败集合同名同数否则停手」的口径，此处满足，继续交付。

**关于矩阵测试文件的来源**：`tests/unit/gy-i22-secmatrix.test.mjs` **不在** `upstream/main` 上（它在 `feat/gy-i22-secmatrix` 分支的 `4d4277e`），本片为跑 ③ 号回归把它临时拷入工作树（`git hash-object` = `3dc9610e870a2f551b0c1cdb8c5fbaf573641978`），**提交前删除**，不随本片提交。

## 7 负控制：把新测试放到「未修复」的树上必须变红

在干净基线树 `.pg17/tmp/i22f01-base`（`8cc9dd8`，`npm ci --ignore-scripts` 后）拷入同一份新测试并直跑，读数 **`tests 4 / pass 1 / fail 3`**：

| 组 | 未修复树 | 修复树 | 说明 |
| --- | --- | --- | --- |
| 第 1 组 游客 401（25 面） | **红**（`Cache-Control` 缺头） | 绿 | 缺头就是被测缺陷本身 |
| 第 2 组 拒绝家族（11 条） | **红**（`Cache-Control` 缺头） | 绿 | 同一根因，覆盖 403/404/400/415/503 |
| 第 3 组 2xx 边界（11 条） | 绿 | 绿 | 私有 2xx 基线即 `no-store`、`/health` 基线即无头 ⇒ 本条不区分修复与否，反证它不会假红 |
| 第 4 组 统一出口（4 条） | **红**（500 与直接 409 缺头） | 绿 | 证明「只改 `setErrorHandler` 之外还需出口钩子」 |

即：新测试在「未修复」树上红在它该红的地方、绿在它该绿的地方（第 3 组），不是一组恒真的断言。

## 8 未取得（如实登记，不伪造）

| 项 | 原因 |
| --- | --- |
| 真机（Android/iOS）与小程序的端到端缓存行为 | 本机无真机、无微信开发者工具运行时；本片只做服务端响应头，客户端缓存行为未实测 |
| 真实微信登录链路下的 401 | 依赖真实 `APPID/SECRET` 与真实微信；本片全部使用合成身份与内存 store |
| 真实共享缓存/中间代理（CDN、反向代理）是否会缓存 401 | 需要真实部署拓扑与流量；本片只证明「服务端已不再发出可缓存语义的拒绝响应」，不证明任何第三方缓存的实际行为 |
| 真实 PG 下 `/public/home` 的 200 与 `/me/profile`、`/knowledge`、`/catalog/*` 的成功语义 | 单测环境无 `DATABASE_URL` ⇒ 这些面在 stub 下是 503（当次已按错误面断言 `no-store`）；真实 200 的读取未取得 |
| 依赖 bash 的校验 | 本机 `bash` 为 WSL 存根（`bash -n` 空转），未取得真实读数 |
| knowledge 域 8 条既有失败 | 基线树同数同名失败，非本片引入；本片不做该域修复 |

## 9 不宣称

- 本页**不宣称系统安全**，也不宣称 I22 整项通过：只证明「在这组固定输入下，服务端返回了这组固定响应头」。
- 不宣称「缓存问题已彻底解决」：本片只处理**响应头语义**（服务端不发出可缓存指令），不涉及客户端/中间层实现、不涉及 `Vary` 策略、不涉及任何缓存键设计。
- 不宣称「所有域都已覆盖」：断言覆盖派单点名的 401/403/404 三类 + 400/415/500/503 与一个私有 2xx、一个公共只读 2xx；未逐一枚举全部 112 条契约操作面。
