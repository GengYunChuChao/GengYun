# GY-I22（#22）失败回归矩阵 · 首版端到端骨架与前两批用例

- **分支**：`test/gy-r29-i22-failmatrix`（基线 `origin/main` = `a2ab0d9aff391a199142699038b01eda2f74d497`）
- **时间**：2026-10-22（Asia/Hong_Kong）· node v24.16.0 · `execution_mode=stub` · 传输 = 进程内 `app.inject`
- **命令**：`node tests/failmatrix/run.mjs`、`node tools/i22-failmatrix-negative-control.mjs`、
  `node --test tests/unit/gy-i22-failmatrix.test.mjs`
- **本页只记本片真实读数**。本片**不宣称 #22 完成**：交付的是可重复运行的骨架 + 142 条用例 + 14 条负控制，
  issue 里 AI 失败/提示注入/版本回写/下架缓存/外部删除状态/在途取消/重复回调/上传签名等条目仍未覆盖（见 §6）。

## 1 交付物

| 文件 | 说明 |
| --- | --- |
| `tests/failmatrix/world.mjs`（265 行） | 世界装配：内存 auth/业务 store + 替身对象存储 + 合成审核端口（四个网络 seam 持有即抛错） |
| `tests/failmatrix/cases.mjs`（258 行） | 用例表：142 条，C1–C7 七族，字段 = `id/method/path/headers/body/expect{status,code,etag}/check/sameShapeAs/concurrent` |
| `tests/failmatrix/run.mjs`（394 行） | 表驱动 runner：状态码/错误码 + 四条拒绝不变量 + 同形对照 + 按族/批次汇总 + `--only/--json/--list` |
| `tests/failmatrix/mutations.mjs`（156 行） | 14 条负控制清单（逐字 `find`，要求恰好命中一次） |
| `tools/i22-failmatrix-negative-control.mjs`（214 行） | 负控制执行器：sha256 → 真改 → watch 必须全红 → **原始字节**恢复 → sha256 复核 → 复跑必须全绿 |
| `tests/unit/gy-i22-failmatrix.test.mjs`（138 行） | CI 入口：真跑全矩阵断言 `FAIL 0`/条数 ≥142 + 负控制清单与产品代码同步的静态检查 |
| `tests/failmatrix/README.md` | 用法、为什么用 `inject`、每族覆盖、负控制挑法、未取得清单 |

为什么用进程内 `app.inject` 而不是 loopback HTTP：每条用例要零端口、零外呼、可复现到行；`inject` 走完整
Fastify 生命周期（`onRequest` → schema → `preHandler` → 处理器 → `onSend`），与 loopback 只差 TCP 编解码。
**代价**：不覆盖反向代理、真实 TLS、真实 body 上限与真实网络超时（记入「未取得」）。

## 2 矩阵读数（142 条，全绿）

```
node tests/failmatrix/run.mjs
矩阵合计 142 条：PASS 142 / FAIL 0
```

| 族 | 条数 | 读数 |
| --- | --- | --- |
| C1 游客面 | 37 | PASS 37 / FAIL 0 |
| C2 越权（IDOR） | 24 | PASS 24 / FAIL 0 |
| C3 后台 | 27 | PASS 27 / FAIL 0 |
| C4 会话与注销 | 18 | PASS 18 / FAIL 0 |
| C5 媒体归属与访问凭据 | 10 | PASS 10 / FAIL 0 |
| C6 重复请求 | 10 | PASS 10 / FAIL 0 |
| C7 无效输入 | 16 | PASS 16 / FAIL 0 |
| **B1 批次 1**（C1–C4，身份与权限面） | 106 | FAIL 0 |
| **B2 批次 2**（C5–C7，媒体归属/重复请求/无效输入） | 36 | FAIL 0 |

代表性逐条读数（原文取自 `--json` 机读结果，`cache` 列全部为 `no-store`）：

| 用例 | 请求 | 实际读数 | 断言 |
| --- | --- | --- | --- |
| C1-01 | `GET /api/v1/favorites`（游客） | `401 SESSION_REQUIRED` | 游客一律 401，不是 403/404/500 |
| C1-35 | `GET /api/v1/admin/sources`（游客） | `401 SESSION_REQUIRED` | 后台面同样先要求会话 |
| C2-01 | A 读 B 的媒体 | `404 NOT_FOUND` | 跨主体与「不存在」同形 |
| C2-11 | A 读不存在的媒体（对照） | `404 NOT_FOUND` | 与 C2-01 封套同形（`sameShapeAs`） |
| C2-19 | A 读 B 的公开帖子 | `200` | **反向控制**：不得过度拦截公开内容 |
| C2-22 | A 的收藏列表 | `200`，不含 B 的收藏行 | 列表隔离 |
| C3-01 | 用户会话读后台 | `403 SCOPE_DENIED` | 后台不接受用户会话 |
| C3-09 | 零 scope 后台读内容族 | `403 SCOPE_DENIED` | 缺权限拒绝 |
| C3-12 | 零 scope 后台登出 | `403 SCOPE_DENIED` | 登出也要 `session:logout` |
| C3-19 | 全 scope 读账号列表 | `503 PROVIDER_UNAVAILABLE` | 账号写权威未接线 → fail-closed |
| C3-27 | 帖子被后台隐藏后 A 再读 | `404 NOT_FOUND` | 下架真生效 |
| C4-03 | 注销后旧会话读收藏 | `401 SESSION_EXPIRED` | 注销立刻作废旧会话 |
| C4-11 | 注销申请缺幂等键 | `400 IDEMPOTENCY_KEY_REQUIRED` | 缺键先于业务 |
| C4-14 | 回执跨单使用 | `401 SESSION_EXPIRED` | 回执绑定注销单 id |
| C5-04 | 社区媒体内容缺 token | `400 INVALID_REQUEST` | `X-Media-Access-Token` 必填 |
| C6-02 | 同键同体重放写收藏 | `201` + 同一 `id` | 重放不产生第二行 |
| C6-04 | 缺幂等键写收藏 | `400 IDEMPOTENCY_KEY_REQUIRED` | 缺键 400 |
| C6-10 | 并发两发同键 | `201` + `201`，同一 `id` | 并发只产生一行 |
| C7-05 | `cursor=%25%25%25` | `400 INVALID_CURSOR` | 游标非法单独成码 |

## 3 负控制（14 条，全部 PASS：真红 → 原字节恢复 → 复跑绿）

`node tools/i22-failmatrix-negative-control.mjs` → `负控制合计 14 条：PASS 14 / FAIL 0`。
每条都是**真改一行**（NC-06b 因守卫分两层，两处各一行），跑完用**原始字节**写回，sha256 与改前逐字节一致。

| 负控制 | 改动 | 改前 sha256 → 改后（前 16 位） | 恢复 | watch 真红读数 |
| --- | --- | --- | --- | --- |
| NC-01 | 无凭据 `SESSION_REQUIRED` → `SESSION_EXPIRED` | `7d27f11e9cc3bde7` → `f1b048f5ed451b4e` | 一致 | C1-01/02/09/16/27/35、C4-07/08 → `401 SESSION_EXPIRED` |
| NC-02 | 会话已撤销 → `return session` | `7d27f11e9cc3bde7` → `18b8188994b9…` | 一致 | C4-03、C4-04 → `200` |
| NC-03 | 会话已过期 → `return session` | `7d27f11e9cc3bde7` → `e715246bbee9…` | 一致 | C4-05 → `200` |
| NC-04 | 删 `ACCOUNT_INACTIVE` 抛出 | `7d27f11e9cc3bde7` → `b8848579ab58…` | 一致 | C4-06 → `200` |
| NC-05 | 删「后台接口不接受用户会话」 | `7d27f11e9cc3bde7` → `e705dc298ae6…` | 一致 | C3-01/02/07 → `401`（落到下一层） |
| NC-06 | 删路由层 `requireScope` | `7d27f11e9cc3bde7` → `569fac41f4fd…` | 一致 | C3-12 → `200`（只依赖路由层的那条） |
| NC-06b | 删**两层** scope 校验（路由层 + `admin/identity.ts`） | 两文件均变（`…569fac41f4fd`、`b31c0bd03023` → `a4b4cf511157`） | 一致 | C3-09 → `200`、C3-10/C3-11 → `503`、C3-13 → `200` |
| NC-07 | 删 `routes/support.ts` 幂等键门 | `1614ae44331806e7` → `4bb01d9a105068de` | 一致 | C4-01 → `200`、C4-11 → `202` |
| NC-07b | 删 `favorites/validate.ts` 的键门 | `55fd2c9a8d9c361d` → `55517c96877602ce` | 一致 | C6-04 → `201` |
| NC-08 | 回执不再绑定注销单 id | `41c003931f07203e` → `abb88a528336…` | 一致 | C4-14 → `404`（另一路径 → 落到「不存在」） |
| NC-09 | 删 `media/service.ts` 属主判断 | `90a7146f814677b9` → `d99bb441e1bf…` | 一致 | C2-01 → `200`（跨主体读媒体泄露）、C2-02 → `202` |
| NC-10 | 删收藏列表属主过滤 | `33e9a5413ddb2bea` → `3e70b77eee25…` | 一致 | C2-22 → `200` 且列表出现 B 的收藏 |
| NC-11 | 删历史列表属主过滤 | `5eb0d8600878b7b4` → `230424e3e34f…` | 一致 | C2-23 → `200` 且列表出现 B 的历史 |
| NC-12 | 删消息列表属主过滤 | `ead31a22a3b2566c` → `361bb9b3262d…` | 一致 | C2-24 → `200` 且列表出现 B 的消息 |

真红原文（执行器原样输出，节选四条，逐字照抄）：

```
真红原文：C1-01 GET /api/v1/favorites → 实际 {"status":401,"code":"SESSION_EXPIRED","cache":"no-store","etag":null}：
      status 期望 401 实际 401；error.code 期望 SESSION_REQUIRED 实际 SESSION_EXPIRED
真红原文：C2-01 GET /api/v1/media/… → 实际 {"status":200,"code":null,"cache":"no-store","etag":"\"2\""}：
      status 期望 404 实际 200；期望错误封套 NOT_FOUND，实际没有 error：{"data":{"id":"def66837-…","revision":2,…}；
      拒绝响应里带了 data（失败必须是纯封套）
真红原文：C3-09 GET /api/v1/admin/sources → 实际 {"status":200,"code":null,"cache":"no-store","etag":null}：
      status 期望 403 实际 200；期望错误封套 SCOPE_DENIED，实际没有 error：{"data":{"items":[],"next_cursor":null},…}；
      拒绝响应里带了 data（失败必须是纯封套）
真红原文：C4-14 GET /api/v1/account/deletions/00000000-… → 实际 {"status":404,"code":"NOT_FOUND",…}：
      status 期望 401 实际 404；error.code 期望 SESSION_EXPIRED 实际 NOT_FOUND
```

**恢复后逐字节一致**：以下 9 个被临时改过的产品文件全部与 `origin/main` 相同
（`git diff origin/main -- services/` = 0 行），当前 sha256：

```
7d27f11e9cc3bde7c7b33198ecfbb4b8dc7845b4a1e76cc96652542c204bb2c9  services/api/src/auth/middleware.ts
b31c0bd030233385311cc7b4a9279dee5dc40c1b2d884d4ff7d06042f6215880  services/api/src/admin/identity.ts
1614ae44331806e7b2d4640197ff181e7bd963e5bcfa045dc2522ebfd1f26b8e  services/api/src/routes/support.ts
55fd2c9a8d9c361d0ac5b6e44803f1b90a5ff9bcfb1a5a8f30d9e4ba8c92b9d1  services/api/src/favorites/validate.ts
41c003931f07203e27831f3ab14a619f5c84df71251346c76664d9fad6b38550  services/api/src/routes/account-deletion.ts
90a7146f814677b924a01be7b26984f89a891abe8b899bd519c45a87d558ef93  services/api/src/media/service.ts
33e9a5413ddb2beaefe362c9f4ef37a0b77a0a2c09aa8f095815b65f918f02f3  services/api/src/favorites/store.ts
5eb0d8600878b7b472a49d3cf1b3bddeb4bcb6f1325b1b967d9601c0214ff3d4  services/api/src/history/store.ts
ead31a22a3b2566c9074abf376f2762907c7bbdb0d65a59f85fd6b326deabe4b  services/api/src/messages/store.ts
```

### 3.1 夹具自检（证明这套矩阵自己会红，而不是只会绿）

首跑时「全 scope」后台账号漏了 `audit:read`、`session:read` 两个 scope，`C3-15`/`C3-17`/`C3-26` 当场真红。
为把这条留成可复现的证据，本轮又做了一次**夹具负控制**（改测试夹具一行，不改产品代码）：从
`tests/failmatrix/run.mjs` 的 `ALL_SCOPES` 临时删掉 `'audit:read',` 后单跑 C3-15：

```
  FAIL C3-15  GET    /api/v1/admin/audit-events → 403 SCOPE_DENIED · cache=no-store etag=-
       ✗ status 期望 200 实际 403
       ✗ 期望成功，实际 error=SCOPE_DENIED（缺少所需权限：audit:read）
```

恢复后 `run.mjs` 与改前**字节相同**（sha256 `c2b3c67ba195b5eefd7b87164b219e75e0422a2e4d7241af566c7187aef1f07e`），
单跑 C3-15 回到 `PASS`。结论：**这套矩阵有红的能力**，不是「只绿不红」的同形测试。

### 3.2 两条负控制挑法的实测依据（写进 README，避免后来者误判）

1. **收藏/历史/消息的 IDOR 删除，单改 service 一行不会变红**：service 判属主后，内存 store 的
   `remove()`/`deleteHistory()` 又按 `owner_id` 复核一次，`commitRefusal` 映射回同一个 `404`，用例仍绿。
   代表性负控制因此落在**列表隔离**（store 的 `list*` 过滤）与**媒体归属**（`ownedRecord`）。
2. **后台 scope 是两层**：`routes/admin.ts` 的 `guards.requireScope(...)` 与 `admin/identity.ts:49
   requireAdminScope` 各判一次。单独去掉任一层，缺权限会话仍被另一层挡成 403（NC-06 首版 watch 4 条只有 1 条
   变红即此因），故 `NC-06b` 是「两层各删一行」。

## 4 真扫：在 `origin/main` 上真红的项 = **0 条**

对 142 条矩阵在 `a2ab0d9` 上完整真扫：**0 条真红**，即本片覆盖范围内没有发现新的、可直接复现的严重安全/权限缺陷。
不把它写成「没问题」的地方，按事实列在这里：

1. 首跑那 3 条红（C3-15/C3-17/C3-26）是**我自己的夹具漏 scope**，不是产品缺陷；已修并留了 §3.1 的复现证据。
2. `C3-19/C3-20/C3-21` 把「账号/作业面未接线 → `503 PROVIDER_UNAVAILABLE`」钉成**期望值**（fail-closed）。
   这与 `#22` 前轮 §5.1「后台账号能力脱钩方向更保守」的裁定一致；一旦这些面接线，这三条会**先红**，
   提醒后续批次改期望而不是悄悄跳过。
3. `POST /favorites` 指向不存在的 species/herbicide 返回 `201` + `reference_state: 'unavailable'` 是**设计**
   （收藏可指向已下架目标），不是缺陷；矩阵按实跑读数钉住，避免后人误判成 bug。
4. `NC-08` 证明「回执跨单使用」当前落到 `404`（回执不再绑定 → 目标不存在），与 `C4-14` 期望的 `401`
   不同码——这是**负控制真红**的表现，产品本身仍是 `401`。

## 5 与禁改清单的关系

- 未改 `services/api/src/app.ts`、`config.ts`、`tts/*`、`speech/*`、`ocr/*`、
  `tests/unit/sql-column-coverage.test.mjs`、`deploy/postgres-cvm/*`、`docs/verification/gy-r29-*`、
  `tests/integration/online-purge-pg.mjs`。
- 未改 `docs/architecture/contract-status.json`（`status` 与 `lines` 均未动）；产品代码 `git diff origin/main -- services/` = 0 行。
- 未改 issue 状态、未 merge、未 push main。

## 6 未取得（一律不许当成绿）

| 条目 | 状态 |
| --- | --- |
| 真实 AI 外呼（供应商失败/超时/配额、提示注入、内容版本变更后旧审核回写） | **未取得**（本片无这些用例；下一批 C8+） |
| 真机、微信端到端（`POST /auth/wechat` 真实换会话、真机上传/预览） | **未取得** |
| 真实对象存储 / 真实网络（上传签名校验、断网重试、真实超时） | **未取得**（替身对象存储只验归属与状态机） |
| 账号被停用（`users.state !== 'active'`）真实生效 | **未取得**（stub 无账号写权威；仅覆盖 fail-closed 503） |
| 注销冷静期到期后的真实清理（在线 7 日 / 备份 30 日执行面） | **未取得**（仅覆盖申请→回执→冷静期内原会话可用） |
| 社区媒体授权全链路（帖子带附件 → 访客申请 → 拿 grant → 读内容） | **未取得**：stub 下带媒体发帖被内容筛查判 `422 INPUT_UNCERTAIN`（`decision=quarantined`），正路走不通，只能覆盖其前的 `400/404` 分支（C5） |
| `REQUEST_IN_PROGRESS`（409，在途占位超预算） | **未取得**：内存台账太快，并发同键落到「重放同一行」，未出现 409 |
| 下架缓存、消息与收藏引用、外部删除状态、在途取消/注销撤回、重复回调、上传签名归属 | **未取得**（本片未覆盖，留待后续批次） |

## 7 事实 vs 派单

| 派单要求 | 事实 |
| --- | --- |
| 一个可重复运行的失败矩阵 harness | 已交付：`tests/failmatrix/{world,cases,run,mutations}.mjs` + `tools/i22-failmatrix-negative-control.mjs`，一条命令跑完 |
| 表驱动：场景 id + 期望状态码/错误码 + 实际 + PASS/FAIL | 已交付：142 条，`--json` 给机读逐条读数 |
| 先交付一批真能跑绿的用例 | 已交付 142 条全绿（C1–C7 七族，B1 106 条 / B2 36 条） |
| 每条附负控制：放宽守卫必须真红，恢复后转绿 | 已交付 14 条负控制全部 PASS（含 sha256 逐字节恢复） |
| 真扫 main 并列出真红项 | 真红 **0 条**；首跑 3 红为夹具 bug（已修，留复现证据）；另列 4 条「不该误判为缺陷」的事实 |
| 不擅自修产品代码 | 产品代码 `git diff origin/main -- services/` = 0 行 |
| 未取得项单列 | 见 §6（AI 外呼/真机/微信/真实存储/账号停用/到期清理/社区媒体正路/409 在途） |
| 提交前 lint + harness + verify-contract-status | 见 §8 |

## 8 提交前自检读数

（本轮最终读数见 PR 描述；`npm run lint`、`node tools/verify-contract-status.mjs`、
`node tests/failmatrix/run.mjs`、`node tools/i22-failmatrix-negative-control.mjs`、
`node --test tests/unit/gy-i22-failmatrix.test.mjs` 五条命令的真实输出尾巴会贴进 PR。）
