# GY-I22 关键安全与权限用例矩阵（证据页）

基线 `upstream/main` = `8cc9dd8b1ee251c8d7000390d54e0ba07a6ac37f`（开工时为 `0856e49e31bbc5dff3615b146cf9ce12e88a0b49`，收工前已 `fetch` 并 rebase 到最新 main）；本页对应提交见交接文件 `HEAD` 行。
关联 issue [#22](https://github.com/GengYunChuChao/GengYun/issues/22)（只 `Refs`，不 `Closes`——本片是矩阵与实证，不是整项安全验收）。

**一句话结论**：六类共 146 条实证用例中，143 条**通过**（当次真的发出请求并断言语义），1 条记**缺陷**（F-01：部分域的错误响应缺 `Cache-Control`，非数据泄露、不阻塞），2 条记**未取得**（取消注销的 DELETE 与 PATCH 两个入口，同一根因：契约里没有这条路）。**本页不宣称系统安全**，只覆盖下表列出的面。

## 0 怎么读这一页

- 采集命令（全片唯一入口，无脚手架、无 `npm run`）：

  ```
  node --test --test-isolation=none tests/unit/gy-i22-secmatrix.test.mjs
  ```

  当次读数：`tests 6 / pass 6 / fail 0 / cancelled 0 / skipped 0`，耗时 ~1.1s，打印 146 条 `[I22]` 行——下表「实测」列即这些行的原始读数。
- 「预期」写的是**安全不变量**（不是实现细节）；「实测」写当次真实状态码 + 响应要点。
- 「断言」列 = [矩阵测试](../../tests/unit/gy-i22-secmatrix.test.mjs) 内的行号，逐条可追。
- 结论只有三种：**通过** / **缺陷** / **未取得**。没有第四种，也不把「代码看起来对」写成通过。
- 测试环境：`executionMode=stub` + 内存 store + 替身对象存储 + 合成身份；**不联网、不连真实数据库、不连微信、不连对象存储**。所有账号 id、token、对象 key 都是当次随机生成的合成值。

## 1 结论总表

| 类别 | 条数 | 通过 | 缺陷 | 未取得 | 一句话结论 |
| --- | --- | --- | --- | --- | --- |
| C1 游客未登录 | 45（37 面 + 8 附加） | 44 | 1（F-01） | 0 | 37 个私有面/写面**全部** 401 `SESSION_REQUIRED`，封套形状唯一，无一处返回他人数据；游客带非法体时先被 schema 拒（400），不泄露业务数据 |
| C2 跨用户越权（IDOR） | 24 | 24 | 0 | 0 | 12 组「A 拿 B 的 id」与「拿不存在的 id」响应**逐字节同形** 404；枚举面（消息/收藏/历史）零泄露；query/body 声明身份一律 400 |
| C3 后台拒绝 | 19 | 19 | 0 | 0 | 普通用户 token 打 9 个后台面一律 403 `SCOPE_DENIED`；8 种伪造身份头 + 伪造 query + 伪造 body 全部与基准同形，头部/字段**不被采信**；拒绝来自已挂载路由的守卫（非前端隐藏） |
| C4 会话与注销 | 16 | 14 | 0 | 2 | 退出后旧 token **同一时刻**即失效（非 TTL 到期）；重复退出不复活、不假成功；注销回执幂等换发、旧 bearer 立即失效；重复回调不改变状态。**取消注销无契约入口 ⇒ 2 条未取得** |
| C5 媒体归属 | 22 | 22 | 0 | 0 | 上传签名绑定 `{kind,mediaId,ownerId,revision,exp}`；对象 key 由服务端随机生成、客户端无法声明；跨用户 4 面 404 同形；社区共享读必须显式凭据 |
| C6 模拟/真实交叉 | 20 | 20 | 0 | 0 | stub 产出的 id 在 real 装配下一律 503 `PROVIDER_UNAVAILABLE`（可解释、非假 404）；real 侧写面全部 503 ⇒ 反向产不出「真实 id」；知识域不因「公共资料」豁免 |
| 合计 | 146 | 143 | 1 | 2 | — |

> 计数口径：一行表格 = 一条用例，与测试打印的 146 条 `[I22]` 行一一对应。F-01 那一行覆盖 23 个面，但它是**同一个**工程性问题（错误响应缺 `Cache-Control: no-store`），按一条缺陷记；C4 的两条未取得也同源（契约无 cancel-deletion 入口）。见 §9、§10。

## 2 C1 游客未登录面（37 面）

夹具：两个真实账号（B 用于铺数据），先经 stub 上传两段式建出 ready 媒体、发布帖子、写评论、举报、收藏、写历史、写消息，**然后游客用这些真实 id 发请求**——若鉴权漏了，服务层会真的处理它（这才有意义）。

| # | 请求 | 预期 | 实测 | 断言 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | `GET /favorites` | 401 拒绝、无 data | 401 `SESSION_REQUIRED` | `:335` | 通过 |
| 2 | `POST /favorites` | 同上 | 401 `SESSION_REQUIRED` | `:336` | 通过 |
| 3 | `DELETE /favorites/{B的id}` | 同上 | 401 `SESSION_REQUIRED` | `:337` | 通过 |
| 4 | `GET /history` | 同上 | 401 `SESSION_REQUIRED` | `:338` | 通过 |
| 5 | `DELETE /history/{B的id}` | 同上 | 401 `SESSION_REQUIRED` | `:339` | 通过 |
| 6 | `GET /messages` | 同上 | 401 `SESSION_REQUIRED` | `:340` | 通过 |
| 7 | `GET /messages/unread-count` | 同上 | 401 `SESSION_REQUIRED` | `:341` | 通过 |
| 8 | `PUT /messages/{B的id}/read` | 同上 | 401 `SESSION_REQUIRED` | `:342` | 通过 |
| 9 | `POST /media/uploads` | 同上 | 401 `SESSION_REQUIRED` | `:343` | 通过 |
| 10 | `POST /media/uploads/{B的id}/complete` | 同上 | 401 `SESSION_REQUIRED` | `:344` | 通过 |
| 11 | `GET /media/{B的id}` | 同上 | 401 `SESSION_REQUIRED` | `:345` | 通过 |
| 12 | `DELETE /media/{B的id}` | 同上 | 401 `SESSION_REQUIRED` | `:346` | 通过 |
| 13 | `POST /media/{B的id}/access` | 同上 | 401 `SESSION_REQUIRED` | `:347` | 通过 |
| 14 | `POST /community/media-access` | 同上 | 401 `SESSION_REQUIRED` | `:348` | 通过 |
| 15 | `GET /community/media/{ABSENT}/content`（带任意 token 头） | 同上 | 401 `SESSION_REQUIRED` | `:349` | 通过 |
| 16 | `GET /knowledge` | 同上 | 401 `SESSION_REQUIRED` | `:350` | 通过 |
| 17 | `GET /knowledge/{id}` | 同上 | 401 `SESSION_REQUIRED` | `:351` | 通过 |
| 18 | `GET /herbicides` | 同上 | 401 `SESSION_REQUIRED` | `:352` | 通过 |
| 19 | `GET /herbicides/{id}` | 同上 | 401 `SESSION_REQUIRED` | `:353` | 通过 |
| 20 | `GET /posts` | 同上 | 401 `SESSION_REQUIRED` | `:354` | 通过 |
| 21 | `POST /posts` | 同上 | 401 `SESSION_REQUIRED` | `:355` | 通过 |
| 22 | `GET /posts/{B的id}` | 同上 | 401 `SESSION_REQUIRED` | `:356` | 通过 |
| 23 | `PATCH /posts/{B的id}` | 同上 | 401 `SESSION_REQUIRED` | `:357` | 通过 |
| 24 | `DELETE /posts/{B的id}` | 同上 | 401 `SESSION_REQUIRED` | `:358` | 通过 |
| 25 | `GET /posts/{B的id}/comments` | 同上 | 401 `SESSION_REQUIRED` | `:359` | 通过 |
| 26 | `POST /posts/{B的id}/comments` | 同上 | 401 `SESSION_REQUIRED` | `:360` | 通过 |
| 27 | `PATCH /comments/{B的id}` | 同上 | 401 `SESSION_REQUIRED` | `:361` | 通过 |
| 28 | `PUT /posts/{B的id}/like` | 同上 | 401 `SESSION_REQUIRED` | `:362` | 通过 |
| 29 | `POST /reports` | 同上 | 401 `SESSION_REQUIRED` | `:363` | 通过 |
| 30 | `GET /reports/{B的id}` | 同上 | 401 `SESSION_REQUIRED` | `:364` | 通过 |
| 31 | `GET /me/profile` | 同上 | 401 `SESSION_REQUIRED` | `:365` | 通过 |
| 32 | `PUT /me/profile` | 同上 | 401 `SESSION_REQUIRED` | `:366` | 通过 |
| 33 | `GET /catalog/crops` | 同上 | 401 `SESSION_REQUIRED` | `:367` | 通过 |
| 34 | `GET /auth/session` | 同上 | 401 `SESSION_REQUIRED` | `:368` | 通过 |
| 35 | `POST /auth/logout` | 同上 | 401 `SESSION_REQUIRED` | `:369` | 通过 |
| 36 | `POST /me/account/deletion` | 同上 | 401 `SESSION_REQUIRED` | `:370` | 通过 |
| 37 | `GET /account/deletions/{ABSENT}` | 401 拒绝 | 401 `SESSION_REQUIRED`（提示为「需要注销回执 bearer」） | `:371`、`:398` | 通过 |

附加断言（每面都套用一次）：

| 用例 | 预期 | 实测 | 断言 | 结论 |
| --- | --- | --- | --- | --- |
| 封套形状一致 | 状态码/code/retryable/details/契约版本/模式逐字节同形 | 37 面**形状指纹唯一**（1 种） | `:394` | 通过 |
| 逐字节指纹 | 除「人话提示」外无差异 | 2 种：唯一差异是第 37 面（回执守卫）说「需要注销回执 bearer」 | `:397`-`:398` | 通过 |
| 不泄露他人数据 | 响应体不含 B 的账号 id / 标题 / 正文 / 帖子 id / 评论 id | 37 面全部不含（逐面 `assertNoLeak`） | `:386` | 通过 |
| 不可重试 | `retryable===false`、`details===[]`、无 `data` | 37 面全部满足 | `:384`-`:385` | 通过 |
| 缓存头（观察项） | 拒绝响应不得带可缓存指令 | 14 面带 `no-store`；23 面**缺该头**（但无 `public`/`max-age`） | `:390`、`:402`-`:403` | 缺陷 F-01 |
| 正控制 | 同一批面在有效会话下不得被 401 拦住 | 11 个正控制面：`/favorites`、`/history`、`/messages`、`/messages/unread-count`、`/media/{id}`、`/posts`、`/posts/{id}`、`/auth/session` → **200**；`/knowledge`、`/me/profile`、`/catalog/crops` → **503**（对应后端未配置，非鉴权问题） | `:406`-`:426` | 通过 |
| 公开内容对照 | 已发布帖子的评论列表对他人可读属设计，游客仍 401 | B 已发布 → A 读到 200 且无账号 id；游客 401 | `:428`-`:436` | 通过 |
| 顺序对照 | 游客 + 非法请求体：schema 先拒，仍 400 且不回显提交值 | 400 `INVALID_REQUEST`，`details` 只有 `{field,code}` 两个键，无 `not-a-purpose` 字样 | `:441`-`:457` | 通过 |

`/knowledge`、`/me/profile`、`/catalog/crops` 在 stub 下 503 是**后端未接线**（资料库/画像库未配置），不是鉴权通过也不是鉴权失败；见 §6「未取得」。

## 3 C2 跨用户越权（IDOR）

| # | 用例 | 预期 | 实测 | 断言 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | A `GET /media/{B的id}` | 404，与不存在同形，无 B 字段 | 404 `NOT_FOUND`，与 `ABSENT` 指纹相同 | `:506` | 通过 |
| 2 | A `POST /media/uploads/{B的id}/complete` | 同上 | 404，同形 | `:507` | 通过 |
| 3 | A `DELETE /media/{B的id}` | 同上 | 404，同形 | `:508` | 通过 |
| 4 | A `POST /media/{B的id}/access` | 同上 | 404，同形 | `:509` | 通过 |
| 5 | A `PUT /messages/{B的id}/read` | 同上 | 404，同形 | `:510` | 通过 |
| 6 | A `DELETE /favorites/{B的id}` | 同上 | 404，同形 | `:511` | 通过 |
| 7 | A `DELETE /history/{B的id}` | 同上 | 404，同形 | `:512` | 通过 |
| 8 | A `PATCH /posts/{B的id}` | 同上 | 404，同形 | `:513` | 通过 |
| 9 | A `DELETE /posts/{B的id}` | 同上 | 404，同形 | `:514` | 通过 |
| 10 | A `PATCH /comments/{B的id}` | 同上 | 404，同形 | `:515` | 通过 |
| 11 | A `DELETE /comments/{B的id}` | 同上 | 404，同形 | `:516` | 通过 |
| 12 | A `GET /reports/{B的id}` | 同上 | 404，同形 | `:517` | 通过 |
| 13 | 评论正文面 | 已发布帖子的评论对他人公开，但不得回账号 id | 200，响应内无 B 的账号 id | `:480`-`:489` | 通过 |
| 14 | 未读计数（派生量） | 只算自己的行 | A=0、B=3；A 的 0 不是假象（B 的 3 条含种子的行） | `:496`-`:502` | 通过 |
| 15 | 消息枚举 | A 的列表不含 B 的 id；B 自己的列表含它 | A 列表 0 条（无 B 的 id）、B 列表 3 条（含其 id） | `:532`-`:537` | 通过 |
| 16 | 收藏枚举 | 同上 | A 0 条、B 1 条 | `:540`-`:544` | 通过 |
| 17 | 历史枚举 | 同上 | A 0 条、B 1 条 | `:545`-`:549` | 通过 |
| 18 | 注销请求 id：A 用**自己的会话令牌**读 C 的 id | 401，不泄露 C 的任何字段 | 401 `SESSION_EXPIRED` | `:556`-`:558` | 通过 |
| 19 | 注销请求 id：A 用**自己的回执 bearer** 打 C 的 id | 401，与「不存在」同形 | 401，指纹与随机 id 相同 | `:559`-`:564` | 通过 |
| 20 | 注销请求 id：C 用自己的 bearer（正控制） | 200，且不回账号 id | 200，`data` 内无 C 的账号 id | `:566`-`:569` | 通过 |
| 21 | query 声明身份 `GET /messages?owner_id={B}` | 400，身份只来自 Bearer | 400 `INVALID_REQUEST` | `:572`-`:574` | 通过 |
| 22 | query 声明身份 `GET /favorites?user_id={B}` | 同上 | 400 | `:575`-`:578` | 通过 |
| 23 | body 声明归属 `POST /media/uploads` + `owner_id` | 400 | 400 `INVALID_REQUEST` | `:577`-`:583` | 通过 |
| 24 | 被拒请求无副作用 | B 的帖子/媒体/收藏/历史/消息全部原样 | 全部 200 且内容未变 | `:586`-`:597` | 通过 |

> 第 18–20 条的口径：`GET /account/deletions/{id}` **不是**会话授权，而是「不记名回执」——持有 bearer 即被授权（与重置口令同类）。所以「A 拿到 C 的 bearer」= 已拿到秘密本身，属凭据保管问题，**不构成本矩阵意义上的 IDOR**；能证且已证的是：只有 id、只有会话令牌、只有别人的 bearer，三种都读不到。

## 4 C3 后台拒绝

| # | 用例 | 预期 | 实测 | 断言 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | 9 个后台面（sources/knowledge/registrations/restrictions/audit-events/accounts/categories/jobs）先断言**已挂载** | 拒绝必须来自守卫，不能是 404 假装没有 | `app.hasRoute()` 9/9 true | `:624`-`:628` | 通过 |
| 2 | 普通用户 token → `GET /admin/sources` | 403 | 403 `SCOPE_DENIED` | `:631`-`:637` | 通过 |
| 3 | 普通用户 token → `POST /admin/sources` | 403 | 403 `SCOPE_DENIED` | `:613`、`:631` | 通过 |
| 4–9 | 普通用户 token → 其余 7 面 | 403，且 9 面封套唯一 | 全部 403，指纹 1 种 | `:614`-`:620`、`:638` | 通过 |
| 10 | 游客 → 后台 | 401（鉴权先于授权，不是 403） | 401 `SESSION_REQUIRED` | `:641`-`:643` | 通过 |
| 11 | 伪造头 `x-role: admin` | 403，与基准同形 | 403，指纹与基准相同 | `:648`、`:657`-`:661` | 通过 |
| 12 | 伪造头 `x-user-role: admin` | 同上 | 同上 | `:649` | 通过 |
| 13 | 伪造头 `x-is-admin: true` | 同上 | 同上 | `:650` | 通过 |
| 14 | 伪造头 `x-admin: true` | 同上 | 同上 | `:651` | 通过 |
| 15 | 伪造头 `x-scopes: sources:write` | 同上 | 同上 | `:652` | 通过 |
| 16 | 伪造头 `x-auth-scopes: …` | 同上 | 同上 | `:653` | 通过 |
| 17 | 伪造头 `x-user-id: {真实后台账号id}` | 同上 | 同上 | `:654` | 通过 |
| 18 | 伪造头 `x-actor: admin` | 同上 | 同上 | `:655` | 通过 |
| 19 | 游客 + 伪造头 | 401（头部造不出会话） | 401 `SESSION_REQUIRED` | `:663`-`:666` | 通过 |
| 20 | 伪造 query `?role=admin&is_admin=1&user_id=…` | 403，与基准同形 | 403，指纹相同 | `:669`-`:671` | 通过 |
| 21 | 伪造 body `{name, role:'admin', is_admin:true, scopes:[…]}` | 403 或 400，两者都不提权、不落库、不回显 | 403 `SCOPE_DENIED`（后台写口无 HTTP 层 body schema，守卫先拒），与基准同形 | `:676`-`:687` | 通过 |
| 22 | 后台 token 但 `scopes=[]` | 403（不是「后台 token 就全通」） | 403 `SCOPE_DENIED` | `:688`-`:690` | 通过 |
| 23 | 正控制：`sources:read` 后台 token | 200，否则上面 403 可能是「后台整域坏了」 | 200，`meta.execution_mode=stub` | `:693`-`:696` | 通过 |
| 24 | 受众隔离：后台 token 打用户面 | 401 `SESSION_EXPIRED`（不是 403） | 401 `SESSION_EXPIRED` | `:699`-`:700` | 通过 |

> 第 21 条是**结构性**结论的实证：全仓 `services/api/src` 里没有任何「客户端可声明身份」的旁路——`grep` 唯一的自定义身份头是媒体域的 `X-Media-Access-Token`（授权句柄，不是身份），身份只来自 `Authorization: Bearer`。

## 5 C4 会话与注销

| # | 用例 | 预期 | 实测 | 断言 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | 先经真实 `POST /auth/wechat`（stub）换 token | 200 | 200，拿到 `access_token` | `:713`-`:720` | 通过 |
| 2 | 退出前 5 面正控制 | 全部 200 | `/auth/session`、`/favorites`、`/messages`、`/posts`、`/media/{id}` 全 200 | `:726`-`:737` | 通过 |
| 3 | `POST /auth/logout` | 200 `{accepted:true}` | 200 | `:740`-`:742` | 通过 |
| 4 | 退出后 5 面 | 401，封套唯一 | 全部 401 `SESSION_EXPIRED`，指纹 1 种 | `:744`-`:752` | 通过 |
| 5 | 失效**即时性** | 时钟未推进就已失效 ⇒ 是撤销而非 TTL | `clock.ms === START` 仍成立，旧 token 已 401 | `:753`-`:754` | 通过 |
| 6 | 重复退出（换幂等键） | 不得复活、不得假成功 | 401 `SESSION_EXPIRED` | `:757`-`:759` | 通过 |
| 7 | 重新登录（同一微信 code） | 同账号、新 token 有效 | 200，新 token 可用 | `:762`-`:769` | 通过 |
| 8 | 重新登录后旧 token | 仍 401（撤销不可逆） | 401 `SESSION_EXPIRED` | `:770`-`:772` | 通过 |
| 9 | `POST /me/account/deletion` | 202，`state` 如实（备份未接线 ⇒ `blocked`） | 202，`state=blocked`，handlers=[favorites,history] | `:776`-`:781` | 通过 |
| 10 | 注销回执幂等：同键同体重放 | 同一删除请求 id；bearer 换发 | 202，id 相同，`receipt_token` 变化 | `:783`-`:789` | 通过 |
| 11 | 旧 bearer 重放后 | 立即 401 | 401 `SESSION_EXPIRED` | `:790`-`:791` | 通过 |
| 12 | 新 bearer | 200 | 200 | `:792`-`:794` | 通过 |
| 13 | 重复回调不改变状态 | 不得把到期当完成 | +1h 后 `state` 仍 `blocked` | `:798`-`:802` | 通过 |
| 14 | 注销期间本人会话 | 仍 200（7 日异步窗口是设计，与「退出即时失效」两条机制） | 200 | `:805`-`:807` | 通过 |
| 15 | 取消注销 `DELETE /me/account/deletion` | 契约无入口 ⇒ 不存在 | 404 | `:810`-`:811` | **未取得** |
| 16 | 取消注销 `PATCH /me/account/deletion {state:'cancelled'}` | 同上 | 404 | `:812`-`:816` | **未取得** |

> 第 15–16 条不是「拒绝合法请求」而是「契约里根本没有这条路」：`packages/contracts/openapi.json` 无任何 cancel-deletion operation，`DeletionState` 枚举只有 `requested|processing|blocked|completed`（无 `cancelled`），`docs/` 全文 grep `取消注销|撤销注销|撤回注销` 零命中。所以「取消注销后状态回到正确态」这一子项**本片不判**，记未取得，等需求侧先定契约。

## 6 C5 媒体归属

| # | 用例 | 预期 | 实测 | 断言 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | 解码上传签名声明 | 绑定本次 media id | `{kind:'upload', mediaId:<本媒体>, revision:1}` | `:834`-`:836` | 通过 |
| 2 | 绑定上传者 | `ownerId` = 上传者 | `ownerId` = A 的账号 id | `:837` | 通过 |
| 3 | 带过期时刻 | `exp` 是数字时间戳 | 数字 | `:839` | 通过 |
| 4 | 两次上传签名不同 | 不得复用 | A/B 签名不同 | `:840` | 通过 |
| 5 | 对象 key 来源 | 服务端随机生成（`obj_` 前缀），不由客户端决定 | `obj_<24 字符 base64url>` | `:845` | 通过 |
| 6 | 对象 key 不含用户 id | 不得内嵌 | 不含 | `:846`-`:847` | 通过 |
| 7 | A `POST /media/uploads/{B}/complete` | 404 同形 | 404 | `:853`-`:863` | 通过 |
| 8 | A `GET /media/{B}` | 404 同形 | 404 | 同上 | 通过 |
| 9 | A `DELETE /media/{B}` | 404 同形 | 404 | 同上 | 通过 |
| 10 | A `POST /media/{B}/access` | 404 同形 | 404 | 同上 | 通过 |
| 11 | 正控制：本人读 | 200 | 200 | `:870`-`:871` | 通过 |
| 12 | 正控制：本人授权 | 200 且给出 `access_token` | 200 | `:872`-`:875` | 通过 |
| 13 | 篡改上传体 `object_key` | 400（不静默剔除） | 400 `INVALID_REQUEST` | `:880`-`:894` | 通过 |
| 14 | 篡改上传体 `path` | 400 | 400 | 同上 | 通过 |
| 15 | 篡改上传体 `key` | 400 | 400 | 同上 | 通过 |
| 16 | 篡改上传体 `owner_id` | 400 | 400 | 同上 | 通过 |
| 17 | 篡改 complete 体指向 B 的对象 | 400，且不回显该 key | 400，响应内无 B 的 key | `:896`-`:903` | 通过 |
| 18 | 复用 B 的幂等键去 complete B 的媒体 | 404（幂等台账不跨归属） | 404 | `:906`-`:911` | 通过 |
| 19 | 社区共享读：游客 | 401 | 401 `SESSION_REQUIRED` | `:914`-`:917` | 通过 |
| 20 | 社区共享读：已登录但缺 `X-Media-Access-Token` | 400（共享范围必须显式凭据） | 400 `INVALID_REQUEST` | `:918`-`:920` | 通过 |
| 21 | 社区共享读：错句柄（拿自己的会话 token 当句柄） | 404 | 404 `NOT_FOUND` | `:921`-`:925` | 通过 |
| 22 | 本人媒体可读性闭环 | 上传→complete→读→授权 全部走真实两段式 | 全部成功（`uploadReadyMedia` 夹具即证明） | `:215`-`:230` | 通过 |

## 7 C6 模拟与真实交叉

| # | 用例 | 预期 | 实测 | 断言 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | stub 产出一批 id（media/post/favorite/history/message/deletion） | 可枚举 | 6 个 id 全部拿到 | `:937`-`:940` | 通过 |
| 2 | preset_demo：注入 store 的 `GET /messages` | 200，`meta.execution_mode=preset_demo` | 200 | `:958`-`:960` | 通过 |
| 3 | preset_demo：`GET /favorites` | 200 | 200 | `:961`-`:962` | 通过 |
| 4 | preset_demo：`GET /posts/{stub 的 post id}` | 200 | 200 | `:963`-`:964` | 通过 |
| 5 | preset_demo：`GET /media/{stub 的 media id}` | 404（媒体记录属**服务实例内部**，不来自注入 store） | 404 | `:965`-`:967` | 通过 |
| 6 | real 装配 `GET /media/{stub 的 id}` | 503 `PROVIDER_UNAVAILABLE`（可解释，不是假 404） | 503，`retryable=false` | `:1009`-`:1018` | 通过 |
| 7 | real `POST /media/uploads` | 503 | 503 | 同上 | 通过 |
| 8 | real `GET /messages` | 503 | 503 | 同上 | 通过 |
| 9 | real `PUT /messages/{id}/read` | 503 | 503 | 同上 | 通过 |
| 10 | real `GET /favorites` | 503 | 503 | 同上 | 通过 |
| 11 | real `DELETE /favorites/{id}` | 503 | 503 | 同上 | 通过 |
| 12 | real `GET /history` | 503 | 503 | 同上 | 通过 |
| 13 | real `GET /posts` | 503 | 503 | 同上 | 通过 |
| 14 | real `GET /posts/{id}` | 503 | 503 | 同上 | 通过 |
| 15 | real `GET /admin/sources`（后台 token） | 503 | 503 | 同上 | 通过 |
| 16 | real `POST /me/account/deletion` | 503 | 503 | 同上 | 通过 |
| 17 | real 装配内部状态 | 消息/社区域必须 `null`，媒体域 fail-closed | `messagesService=null`、`communityService=null`、`mediaService.failClosedReason="real 模式缺少真实媒体接线的显式批准能力…"` | `:1021`-`:1024` | 通过 |
| 18 | real 写面 5 条（posts/reports/favorites/media access/admin sources） | 全 503 ⇒ 反向产不出「真实 id」 | 5/5 503 | `:1027`-`:1039` | 通过 |
| 19 | 模式标注 | 客户端可解释自己在哪种模式 | 同一 token 的 `/auth/session` 在 stub/real 都 200，`meta.execution_mode` 分别为 `stub`/`real` | `:1042`-`:1047` | 通过 |
| 20 | 知识/资料域不是「模式豁免」 | 依赖资料库，未配置即 503（stub 与 real 同形） | 两侧均 503 `PROVIDER_UNAVAILABLE`，`retryable=false` | `:1051`-`:1058` | 通过 |

> 第 5 条是**修正**：首轮我误以为「注入同一个对象存储 ⇒ 媒体 id 跨装配可用」。实测 404——媒体记录存在媒体服务实例内部，**只有**注入的 store（auth/favorites/history/messages/community）才跨装配共享。这是存储实例边界，与 real 的 503「整域未接线」必须分开记，否则会把「实例内查不到」误读成「模式差异」。

## 8 门禁读数

| 门禁 | 命令 | 读数 |
| --- | --- | --- |
| 依赖安装 | `npm ci --ignore-scripts` | **added 103 packages**；audited 106；0 vulnerabilities；4s |
| 矩阵单测 | `node --test --test-isolation=none tests/unit/gy-i22-secmatrix.test.mjs` | `tests 6 / pass 6 / fail 0 / cancelled 0 / skipped 0` |
| 全量单测（受影响域 + 全仓单测） | `node --test "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs" "tests/media/*.test.mjs" "tests/reference/*.test.mjs" "tests/moderation/*.test.mjs"` | `tests 2586 / pass 2585 / fail 0 / cancelled 0 / skipped 1`（唯一 skip 是既有的 native 直连用例：`native separate-connection withdrawal and account state changes at guarded read boundary`，非本片新增） |
| 集成（12 套逐个直跑） | `node tests/integration/<file>.mjs` | 12/12 `exit=0`：knowledge-consumer-http(PASS 9 组)、miniprogram-login-loop(PASS 11 组)、admin-http(30 组 0 FAIL)、profile-ui-http.test、recognitions-http、jobs-http、favorites-history-isolation-http(PASS)、ocr-http(NOTE 声明启发式盲区)、account-deletion-http(PASS)、speech-http、tts-http、rejections-http |
| 契约状态 | `node tools/verify-contract-status.mjs` | `PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项` + `PASS: 语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段（不可核不计入通过）` + `PASS: 中文表格一致` + `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` |
| 开发文档 | `python -B tools/validate_development_docs.py` | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| 空白错误 | `git diff upstream/main --check` | 空 |
| 收工干净 | `git status --porcelain` | 空 |

注：`tools/verify-contract-status.mjs` 只接受 `[--runtime] [--write-doc]`，传 `--check` 会打印用法并 exit 1；因此用**默认模式**（= 校验模式）运行，未用 `--write-doc` 改文档。

注：提交前 `git fetch upstream` 发现 main 已前进 2 个提交（`0856e49` → `8cc9dd8`，只动 `README.md`、`docs/reference/local-development.md`、`tools/prepare-wechat.mjs`、`tests/local-debug.test.mjs`，不涉 `services/api/` 与 `tests/unit/`）。已 rebase 到新 main 并**重跑**矩阵单测、全量单测、契约状态、文档校验，读数即上表（与 rebase 前一致）。12 套集成在 rebase 前于 `0856e49` 上跑过 12/12，本次 rebase 未触及被其覆盖的运行时代码。

## 9 缺陷单

### F-01 部分域的错误响应缺 `Cache-Control: no-store`（不阻塞）

| 项 | 内容 |
| --- | --- |
| 现象 | 37 个游客面里有 23 面的 401 响应**没有** `Cache-Control`；只有消息域（3 面）与社区域（11 面）在 `onRequest` 钩子里统一写了 `no-store` |
| 缺口面 | `/favorites`(3)、`/history`(2)、`/media/*`(5)、`/community/media-access`、`/community/media/{grant_id}/content`、`/knowledge`(2)、`/herbicides`(2)、`/me/profile`(2)、`/catalog/crops`、`/auth/session`、`/auth/logout`、`/me/account/deletion`、`/account/deletions/{id}`，共 23 面 |
| 为什么不阻塞 | 全部 37 面都**没有**任何可缓存指令（无 `public`/`max-age`），错误体也不含他人数据；`app.setErrorHandler`（`services/api/src/app.ts:1569-1628`）不写该头，属统一实现缺口而非某域特例 |
| 风险 | 共享缓存/中间代理理论上可缓存一份 401；若同域后续返回 200 响应体，缓存键若忽略 `Authorization` 才有串味风险——本片**未**发现忽略 `Authorization` 的缓存键证据 |
| 处置 | 本片**只记录、不改产品代码**（改动面横跨所有域的错误封套，超出「用例矩阵」范围，且需与 `no-store` 口径统一后一次性处理）。矩阵测试已把「不得带可缓存指令」锁成断言，缺口面逐面打印 |
| 建议 | 在 `app.setErrorHandler` 或统一 `onRequest` 里对**所有**响应写 `Cache-Control: no-store`，再删掉域内的重复钩子；随后把本矩阵的「缺该头」分组断言收成 `assert.equal(missingNoStore.length, 0)` |

## 10 未取得项

| 项 | 为什么未取得 | 谁能推进 |
| --- | --- | --- |
| 取消注销后状态回到正确态（C4 子项） | 契约无 cancel-deletion operation，`DeletionState` 无 `cancelled`，`docs/` 零命中该需求 | 需求/契约先行；本片不新造契约外路径 |
| `/knowledge`、`/herbicides`、`/me/profile`、`/catalog/*` 的**正向**可用性 | stub 下 503（资料库/画像库/目录库未接线）；本片只证「游客拿不到」「未配置就 503」 | 接入真实资料库后另建证据 |
| 真实微信登录、真机、真实对象存储签名、真实供应商 | 无凭据/无设备；矩阵用 stub + 替身存储，**不冒充**真实能力 | GY-I25/I06 等接入任务 |
| 并发竞态下的越权（同一资源被两人同时写） | 本片是串行矩阵；并发语义属既有的 CAS/幂等台账单测（`tests/unit/messages-security.test.mjs` 等） | 需要时另建并发矩阵 |
| 限流/暴力枚举防护 | 契约与实现均无该层 | 安全需求侧 |

## 11 与既有测试的关系（不重复、不替代）

- **不重复**：`tests/unit/gy-i22-session-inflight-cross-module.test.mjs` 已覆盖 16 个用户面 + 4 个后台面的「游客 401 / 注销 401 / authEpoch 403 / 过期 401 / 受众隔离」；本片补的是**它没覆盖的面**（媒体读删授权、社区媒体共享读、知识/资料、评论/点赞/举报、profile/catalog、注销回执面）以及**它没做的语义**（跨用户同形 404、伪造头/query/body、幂等换发、媒体对象 key、mock/real 交叉）。
- **不替代**：收藏/历史语义与隔离由 `favorites-history-isolation-http.mjs` 与本片并行另一写手（`feat/gy-i16-semantics`）负责；本片只把两者作为「游客 401 / 越权 404」的两行，不动它们的语义断言。
- **不动既有测试**：本片**未**修改、放宽、删除任何既有测试，也**未**新增 `.skip`/`.todo`。
- 复用而不复制：状态码/封套口径沿用 `tests/unit/community-http.test.mjs` 与 `messages-http.test.mjs` 的既有写法；夹具直接复用 `community-fixtures.mjs`、`favorites-history-fixtures.mjs`、`media-fixtures`（`createSubstituteObjectStore`/`newObjectRef`）。

## 12 本页不宣称的内容

- 不宣称「系统安全」「通过安全验收」「无漏洞」——只宣称**列出的 146 条**在 stub 环境下的当次读数。
- 不宣称生产可用性、性能、真实供应商能力、真实数据合规。
- 不宣称覆盖 SQL 注入、XSS、CSRF、SSRF、反序列化、依赖漏洞、日志脱敏、密钥管理、限流、审计完整性等未列面。
- F-01 的存在意味着「错误响应的缓存语义」这一层**尚未收敛**，本页不把它写成通过。
