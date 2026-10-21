# GY-I22（#22）失败回归矩阵 · 可执行骨架

一套**能重复跑**的权限/安全失败回归：表驱动、每条用例给真实读数、每条关键守卫配**负控制**
（故意放宽守卫 → 对应用例必须真红 → 原字节恢复 → sha256 前后一致 → 复跑转绿）。

**本片不宣称 #22 完成。** 这里只交付骨架与前两批用例（142 条），issue 里还有大量条目
（AI 失败/提示注入/内容版本变更、下架缓存、消息与收藏引用、外部删除状态、在途取消、
重复回调、上传签名与媒体归属、模拟与真实环境交叉访问等）留待后续批次；`README` 末尾
「未取得」一节逐条列出本片**没有**取得的能力证据。

## 一条命令

```bash
node tests/failmatrix/run.mjs              # 全跑（142 条）
node tests/failmatrix/run.mjs --only=C2    # 只跑某族（前缀匹配）
node tests/failmatrix/run.mjs --only=C2-01,C2-02 --json=out.json
node tests/failmatrix/run.mjs --list       # 只列用例

node tools/i22-failmatrix-negative-control.mjs               # 14 条负控制
node tools/i22-failmatrix-negative-control.mjs --only=NC-09  # 只跑一条
```

进 CI/单测入口：`tests/unit/gy-i22-failmatrix.test.mjs`（`npm run test:unit` 会带上它）。
它真跑一遍全矩阵并断言 `FAIL 0` / 条数不少于 142，另加一条**静态同步检查**：负控制清单里
每处 `find` 必须在当前产品代码里恰好出现一次（守卫被重构时这条先红，而不是等你发现矩阵不再变红）。

## 为什么用进程内 `app.inject`，不用 loopback HTTP

- 每条用例都要**零端口、零外呼、可复现到行**。`inject` 直接走 Fastify 的完整请求生命周期
  （`onRequest` → schema 校验 → `preHandler` 守卫 → 处理器 → `onSend`），与 loopback 的差别
  只在 TCP 编解码；本轮没有一条用例要验传输层。
- loopback 要选端口、处理并发占用、在 CI 里额外开 socket；`inject` 一条命令跑完。
- **代价（如实记账）**：不覆盖反向代理、真实 TLS、真实 body 上限与真实网络超时。这些属于
  「未取得」里的「真机/真实网络」一条。

世界装配（`world.mjs`）：内存 auth store + 内存业务 store + 替身对象存储 + 合成审核端口，
四个网络 seam **持有即抛错**——跑这套用例不可能偷偷打到真实供应商。执行模式固定 `stub`，
运行器对每个响应额外校验 `meta.execution_mode === 'stub'`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `world.mjs` | 世界装配 + 身份播种（直插会话，零登录外呼）+ 请求助手 + 响应指纹 |
| `cases.mjs` | 用例表：`id` / `method` / `path` / `headers` / `body` / `expect{status,code,etag}` / `check` / `sameShapeAs` / `concurrent` |
| `run.mjs` | 表驱动 runner：判定 + 拒绝不变量 + 按族/批次汇总 + `--json` 机读结果 |
| `mutations.mjs` | 14 条负控制清单（`file` + 逐字 `find` + `replace` + `watch` 用例） |
| `tools/i22-failmatrix-negative-control.mjs` | 负控制执行器：sha256 → 改 → 跑（必须全红）→ 原字节恢复 → sha256 复核 → 复跑（必须全绿） |

## 用例族与批次

| 族 | 条数 | 覆盖 |
| --- | --- | --- |
| C1 | 37 | 游客面：无凭据一律 `401 SESSION_REQUIRED`（不是 403/404/500），且带 `no-store` |
| C2 | 24 | 越权（IDOR）：A 读写 B 的私有行一律 `404`，与「不存在」同形；列表隔离；公开内容不得过度拦截 |
| C3 | 27 | 后台：用户会话 `403 SCOPE_DENIED`；缺 scope `403`；有 scope 2xx；未接线面 fail-closed `503` |
| C4 | 18 | 会话与注销：注销/过期/旧 epoch/坏凭据的拒绝码；注销回执 bearer 的绑定、换发与重放 |
| C5 | 10 | 媒体归属与媒体访问凭据：跨主体 `404`、缺/错 token、内容-媒体不匹配 |
| C6 | 10 | 重复请求：同键同体重放同一行、同键异体 `409`、缺键 `400`、并发只产生一行 |
| C7 | 16 | 无效输入：坏 uuid / 坏游标 / 越界分页 / 多余字段 → `400`（含 `INVALID_CURSOR`） |

批次 1（B1）＝ C1–C4，106 条：身份与权限面。批次 2（B2）＝ C5–C7，36 条：媒体归属、
重复请求与无效输入。**这就是本片「前两批」的定义。**

## 拒绝不变量（每条 4xx/5xx 都校验，不只是状态码）

1. `Cache-Control: no-store`（认证/授权响应不得被缓存）；
2. 封套带 `error{code,message,retryable,details}`，且 `meta.contract_version === '1.0.0'`；
3. `meta.execution_mode === 'stub'`（防止有人把真实模式混进来复跑）；
4. **失败响应不得带 `data`**（半成功比失败更危险）。

## 负控制：哪些守卫、为什么这么挑

| 负控制 | 改的那一行 | watch（必须真红） |
| --- | --- | --- |
| NC-01 | `auth/middleware.ts` 无凭据 → `SESSION_EXPIRED` | C1-01/02/09/16/27/35、C4-07/08 |
| NC-02 | 会话已撤销 → `return session` | C4-03、C4-04 |
| NC-03 | 会话已过期 → `return session` | C4-05 |
| NC-04 | 删 `ACCOUNT_INACTIVE`（epoch 变更） | C4-06 |
| NC-05 | 删「后台接口不接受用户会话」 | C3-01/02/07 |
| NC-06 | 删路由层 `requireScope` | C3-12（只有这条只依赖路由层） |
| NC-06b | 删**两层** scope 校验（路由层 + `admin/identity.ts`） | C3-09/10/11/13 |
| NC-07 | 删 `routes/support.ts` 幂等键门 | C4-01、C4-11 |
| NC-07b | 删 `favorites/validate.ts` 自己的键门 | C6-04 |
| NC-08 | 注销回执不再绑定注销单 id | C4-14 |
| NC-09 | 删 `media/service.ts` 的属主判断 | C2-01、C2-02（跨主体读媒体 → 200 泄露） |
| NC-10/11/12 | 删收藏/历史/消息列表的属主过滤 | C2-22 / C2-23 / C2-24 |

两条**必须知道**的实测结论（它们本身就是被测代码的性质，不是测试写法）：

1. **收藏/历史/消息的 IDOR 删除，单改 service 一行不会变红**：service 判属主之后，内存 store
   的 `remove()` / `deleteHistory()` 又按 `owner_id` 复核一次，`commitRefusal` 把它映射回同一个
   `404`，用例仍然绿。所以这类用例的代表性负控制落在**列表隔离**（store 的 `list*` 过滤那一行）
   与**媒体归属**（`ownedRecord` 那一行）。要证明「删除路径」真能红，得同时改两处——那就不叫
   「一处一行」的负控制了，本片不做。
2. **后台 scope 是两层校验**：路由层 `guards.requireScope(...)` 与 `admin/identity.ts` 的
   `requireAdminScope` 各判一次。单独去掉任一层，缺权限会话仍被另一层挡成 `403`；所以
   `NC-06b` 是「两层各删一行」的组合改动，`NC-06` 只用于证明**只依赖路由层**的那条用例（后台登出）
   会真红。

## 未取得（本片没有证据的，不许当成绿）

- **真实 AI 外呼**：`/conversations`、`/recognitions` 的供应商失败/超时/配额、提示注入、
  内容版本变更后旧审核回写——全部未取得（本片不含这些用例）。
- **真机 / 微信端到端**：`POST /auth/wechat` 真实换取会话、真机媒体上传与预览——未取得。
- **真实对象存储 / 真实网络**：上传签名校验、断网重试、真实超时——未取得（替身对象存储只验证
  归属与状态机）。
- **账号被停用（`users.state !== 'active'`）**：需要真实账号写权威（`accounts-pg`），stub 世界
  不可达；本片只覆盖「未接线时 fail-closed `503`」（C3-19 账号列表 / C3-20 作业面 / C3-21 停用账号）。
- **注销冷静期到期后的真实清理**（在线 7 日 / 备份 30 日执行面）——未取得；本片只覆盖
  「申请 → 回执 → 冷静期内原会话仍可用」。
- **社区媒体授权全链路**：stub 下「带媒体的发帖」会被内容筛查判 `422 INPUT_UNCERTAIN`
  （`decision=quarantined`），因此「帖子带附件 → 访客申请访问 → 拿到 grant → 读内容」这条正路
  走不通；本片只能覆盖它前面的 `400/404` 分支（C5）。
- **下架缓存、消息与收藏引用、外部删除状态、重复回调、上传签名**——本片未覆盖。

## 与 `#22` 的关系

`#22` 远未完成。本片交付的是**可重复运行的失败回归骨架 + 142 条真读数用例 + 14 条负控制**，
并把「在 main 上一跑就绿」与「哪些还没取得」分开记账。后续批次直接在 `cases.mjs` 追加族
`C8+`（例如 AI 失败重放、提示注入、版本回写、外部删除状态），并在 `mutations.mjs` 追加对应负控制；
`tests/unit/gy-i22-failmatrix.test.mjs` 的 `MIN_CASES` / `FAMILY_COUNTS` 随之抬高——条数只准加、
不准在没人注意时被删。
