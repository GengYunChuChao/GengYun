# GY-I22 C3 覆盖缺口收口：`x-role` / `x-user-id` 请求头不得改变生效身份（证据页）

一句话结论：`#297` 安全矩阵的审查者造 7 组 mutant，**M4 存活**（在已认证会话上同时给 `x-role` / `x-user-id`
头时，矩阵没有一条用例锁住「请求头不得提升/改变身份」）。本片用 **5 个新用例 / 49 条读数 / 740 次断言执行**
把这个缺口锁住，并给出**可复现的 mutant 对照**：同一注入下**旧矩阵 6/6 全绿（存活）→ 新文件 3/5 红或 1/5 红**。
产品代码零改动（`services/**`、`packages/**`、契约、迁移 0 行 diff），矩阵 146 条读数仍全绿。

## 0 怎么读这一页

- 采集命令（全片唯一入口，无脚手架、无 `npm run`；**默认隔离**，未用 `--test-isolation=none`）：

  ```
  node --test "tests/unit/gy-i22-identity-headers.test.mjs"
  ```

  当次读数：`tests 5 / pass 5 / fail 0 / cancelled 0 / skipped 0`，打印 **49 条 `[I22-M4]`** 行；
  下表「实测」列即这些行的原始读数（§4.2 逐条抄录）。
- 「断言数」= **运行时断言执行次数**（用一次性 hook 包住 `node:assert/strict` 的导出计数，不落盘、不改产品代码）：
  `equal 591 / ok 140 / deepEqual 7 / notEqual 2`，合计 **740**。
- 「预期」写的是**安全不变量**；「实测」写当次真实状态码 + 响应要点；「断言」列给测试文件行号，逐条可追。
- 结论只有三种：**通过** / **缺陷** / **未取得**。不把「代码看起来对」写成通过。
- 测试环境：`executionMode=stub` + 内存 auth/收藏/历史/消息/社区 store + 可控可见性端口 +
  `stall-hygiene-fixtures` 冻结规则层时钟 + `makeSyntheticPassPort('tms')` 合成审核端口；
  **不联网、不连真实数据库、不连微信、不连对象存储**。账号 id / token / 事件 key 均为当次合成的随机值。
- 基线：`upstream/main = 31a746d`；本页与用例同一次提交落盘（`git log -1 --stat` 可见）。

## 1 结论总表

| 类别 | 条数 | 通过 | 缺陷 | 未取得 | 一句话结论 |
| --- | --- | --- | --- | --- | --- |
| M4 已认证用户面（身份替换/升权） | 14 | 14 | 0 | 0 | A 带 `x-role:admin` + `x-user-id:B`：6 个读面响应与基准**逐字节同形**；3 个他人资源写面 404 且与「不存在的 id」同形；写面落 A 不落 B；后台面 403 同形 |
| M4 未认证面 | 13 | 13 | 0 | 0 | 12 个用户/后台面在「游客 + 双头」下一律 401 `SESSION_REQUIRED`，响应体不含任何他人 id，与不带头同形 |
| M4 管理端逐面 | 11 | 11 | 0 | 0 | 9 个后台面：用户令牌 + 4 种身份头 ⇒ 全部 403 `SCOPE_DENIED` 且指纹唯一；后台令牌加 `x-role:user` / `x-user-id:A` 仍是 200 且不冒名（头部不降权） |
| M4 相邻组合 | 10 | 10 | 0 | 0 | 9 种头部组合（单头、大写、值大小写、自指、空值、不存在 uuid、多值注入、scope 头）× 3 个面全部与基准同形 |
| M4 静态缝 | 1 | 1 | 0 | 0 | 扫 186 个 `.ts`：身份头名 **0 命中**；`x-*` 头读取**仅** `x-media-access-token`；身份字段写入 7 个**全在** `applyIdentity`；`applyIdentity` 调用点只有 2 个守卫 |
| 合计 | 49 | 49 | 0 | 0 | — |

> 计数口径：一行表格 = 一条读数，与 §4.2 的 49 条 `[I22-M4]` 行一一对应。**未发现真漏洞**：49/49 的读数都落在
> 「请求头被完全忽略」这一侧；对照实验（§5）证明这些断言**确实能变红**，不是同义反复。

## 2 机制：请求头在哪一层被丢弃（符号 → 函数 → 行号）

### 2.1 身份的唯一来源是「Bearer → 会话行」，链路上没有任何 `headers['x-…']` 读点

| # | 环节 | 符号 | 位置 | 读 / 写 |
| --- | --- | --- | --- | --- |
| 1 | 取凭据 | `tokenOf(request, what)` | `services/api/src/auth/middleware.ts:53-59` | 只读 `request.headers.authorization`（`readBearerToken`）；缺失即 `SESSION_REQUIRED` |
| 2 | 查会话 | `loadLiveSession(context, token, audience)` | `services/api/src/auth/middleware.ts:62-72` | `:67 context.store.findSession(hashToken(token), audience)`；拒 revoked/expired |
| 3 | 组装用户身份 | `authenticateUser(context, request)` | `services/api/src/auth/middleware.ts:75-107` | `:81 getUser(session.userId)`；`:95-104` 字段全部取自 store 行：`userId: user.id`、`authEpoch: user.authEpoch`、`revision: user.revision`，`role` 硬编码 `'user'`、`scopes` 硬编码 `['user']` |
| 4 | 组装后台身份 | `authenticateAdmin(context, request)` | `services/api/src/auth/middleware.ts:110-147` | `:112` 按 `'admin'` 受众查会话；**`:117` 用户令牌即 `SCOPE_DENIED`**（在写身份之前）；`:134 listAdminScopes(admin.id)` 取真实 scope |
| 5 | **唯一写入点** | `applyIdentity(request, identity)` | `services/api/src/auth/middleware.ts:150-158` | 只写 7 个字段：`userId / authEpoch / role / sessionId / sessionExpiresAt / accountRevision / authScopes`，值全部来自第 3/4 步的返回值 |
| 6 | 调用点（仅 2 处） | `createAuthGuards(context)` | `services/api/src/auth/middleware.ts:232-248` | `:235`（`requireUser`）、`:239`（`requireAdmin`）——除此之外全仓无第三个写入点 |
| 7 | 下游读取 | `readIdentity` / `currentIdentity` | `services/api/src/auth/middleware.ts:184` / `:161` | 所有域从 `request.userId/role/authScopes` 读，**不读 header** |
| 8 | 全仓唯一的 `x-*` 头读取 | — | `services/api/src/routes/media.ts:342` | `request.headers['x-media-access-token']`：媒体**授权句柄**（`media grant`），不是身份；`:345` 缺失时 400 `INVALID_REQUEST` |

### 2.2 为什么 `#297` 的 C3「伪造头」用例没有锁住这里

C3 的 8 种伪造头（矩阵行 11–18）打的是**后台面**。而后台判定的顺序是：`requireAdmin` → `authenticateAdmin`
→ `:117` 抛 `SCOPE_DENIED` → **`applyIdentity` 根本不会被调用**。所以那些用例证明的是「后台守卫按受众拒绝」，
没有证明「用户面的身份写入不听请求头」：

- 用户面（收藏/历史/消息/会话/帖子）在矩阵里**零「带头 vs 不带头」对照**；
- 把覆盖注入 `applyIdentity` 的 M4 变异后，后台面读数**不变**（仍 403，因为更早被拒），
  用户面才会出现可观测差异 ⇒ 这就是 M4 存活的机制原因；
- 本片 §4 的 T3 在 M4a/M4b 注入下**仍全绿**，正是这条机制的实测旁证（见 §5 表「旧矩阵」列）。

### 2.3 反向证据：静态缝只有一个写入点

`tests/unit/gy-i22-identity-headers.test.mjs:567` 起的静态用例直接读源码：扫描 `services/api/src` 下 186 个
`.ts` 文件，断言（a）身份头名（`x-role` / `x-user-id` / `x-user-role` / `x-is-admin` / `x-scopes` 等）0 命中；
（b）`request.headers['x-…']` 的读取只有媒体授权句柄一处；（c）对 `request.userId|role|authEpoch|sessionId|
sessionExpiresAt|accountRevision|authScopes` 的赋值语句全部落在 `applyIdentity` 函数体内；（d）`applyIdentity`
的调用点恰好 2 个。这条用例是**形状**约束，不替代行为断言——但它把「以后新增第三个写入点」挡在门外。

## 3 为什么新增文件而不是扩矩阵（派单二选一，理由留档）

派单允许「在 `tests/unit/gy-i22-secmatrix.test.mjs` 里新增一组用例」或「新增 `tests/unit/gy-i22-identity-headers.test.mjs`」。
选后者，理由三条：

1. **证据页计数口径不被污染**：矩阵证据页（[gy-i22-secmatrix-20261019.md](gy-i22-secmatrix-20261019.md)）的
   §0/§1/§4 与 146 条 `[I22]` 读数逐行对应；把新读数塞进矩阵，要么重编那张表，要么让两张表不一致。本片不动矩阵，
   矩阵的 146 条读数原样可复核。
2. **mutant 对照需要两行可复现命令**：§5 的表格两列就是「旧矩阵绿 / 新文件红」。两个文件各自独立跑，
   谁存活谁被杀一眼可见；混在一个文件里会变成「同一文件有的 test 红有的绿」，证据力下降。
3. **采集口径不同**：矩阵证据页的采集命令是 `--test-isolation=none`（既有页面的口径）；派单要求默认隔离。
   新文件按默认隔离跑，不必为一片用例改动既有页面的命令。

矩阵本身**未改一行**（`git diff --numstat` 只有本页与新文件两行），且仍全绿：`tests 6 / pass 6 / fail 0`，146 条 `[I22]`。

## 4 用例表

### 4.1 五个用例与断言要点

| # | 用例（文件行） | 面 | 断言要点 | 读数 |
| --- | --- | --- | --- | --- |
| 1 | M4 已认证用户 + `x-role:admin` / `x-user-id:他人`（`:261`） | 用户面 + 后台面 | 先自证「夹具真的有差异」（A=2 条未读、B=1 条）；再逐面断言带头响应与不带头响应**逐字节同形**；3 个他人资源写面 404 且与不存在 id 同形；事后态 B 不被改动；写面落 A；后台 403；未接线域（`/me/profile`）仍 503 | 14 |
| 2 | M4 未认证 + 双头（`:402`） | 游客面 | 12 个面（含后台面）一律 401 `SESSION_REQUIRED`，且响应体不含 B 的 id；与不带头同形 | 13 |
| 3 | M4 管理端 9 面逐面（`:448`） | 后台面 | 每面先断言路由**已挂载**（`app.hasRoute`，避免「404 假装没挂」）；用户令牌 + 4 种头 ⇒ 403 `SCOPE_DENIED` 且 9 面指纹唯一；后台令牌 + `x-role:user`/`x-user-id:A` ⇒ 仍 200 且操作者仍是后台账号；后台令牌打用户面 ⇒ 401 `SESSION_EXPIRED` | 11 |
| 4 | M4 相邻组合 9 种头部（`:507`） | 用户面 + 后台面 + 他人资源 | 单头 / 大写 `X-Role` / 值大小写 `ADMIN` / 自指 / 空值 / 不存在 uuid / 多值注入 `"B, A"` / scope 头冒充：每种 × 3 面都与基准同形 | 10 |
| 5 | M4 静态缝（`:567`） | 源码 | 见 §2.3 四条断言 | 1 |

### 4.2 49 条读数（stdout 原样抄录）

```
1.1 GET /favorites：基准 200 ↔ 带头 200，响应体逐字节同形
1.1 GET /history：基准 200 ↔ 带头 200，响应体逐字节同形
1.1 GET /messages：基准 200 ↔ 带头 200，响应体逐字节同形
1.1 GET /messages/unread-count：基准 200 ↔ 带头 200，响应体逐字节同形
1.1 GET /auth/session：基准 200 ↔ 带头 200，响应体逐字节同形
1.1 GET /posts：基准 200 ↔ 带头 200，响应体逐字节同形
1.2 未读派生量：A=2、B=1（刻意不同）
1.3 DELETE /favorites/{B.id} 带双头 → 404 NOT_FOUND（与不存在 id 同形；头部没有把 A 变成 B）
1.3 DELETE /history/{B.id} 带双头 → 404 NOT_FOUND（与不存在 id 同形；头部没有把 A 变成 B）
1.3 PUT /messages/{B.id}/read 带双头 → 404 NOT_FOUND（与不存在 id 同形；头部没有把 A 变成 B）
1.4 事后态：B 的收藏/历史/消息全部原样（带头越权无副作用）
1.5 写面：A 带 x-user-id:B 写收藏 → 201，行落在 A（A=2 条、B 仍 1 条）
1.6 后台面：A + x-role:admin + x-user-id:B → 403 SCOPE_DENIED（与基准同形，未升权）
1.7 画像域 /me/profile：基准与带头均 503 PROVIDER_UNAVAILABLE（头部不能让未接线域变为可用）
2 GET /favorites 游客 + 双头 → 401 SESSION_REQUIRED（与不带头同形）
2 POST /favorites 游客 + 双头 → 401 SESSION_REQUIRED（与不带头同形）
2 DELETE /favorites/{B.id} 游客 + 双头 → 401 SESSION_REQUIRED（与不带头同形）
2 GET /history 游客 + 双头 → 401 SESSION_REQUIRED（与不带头同形）
2 GET /messages 游客 + 双头 → 401 SESSION_REQUIRED（与不带头同形）
2 GET /messages/unread-count 游客 + 双头 → 401 SESSION_REQUIRED（与不带头同形）
2 PUT /messages/{B.id}/read 游客 + 双头 → 401 SESSION_REQUIRED（与不带头同形）
2 GET /auth/session 游客 + 双头 → 401 SESSION_REQUIRED（与不带头同形）
2 POST /auth/logout 游客 + 双头 → 401 SESSION_REQUIRED（与不带头同形）
2 GET /me/profile 游客 + 双头 → 401 SESSION_REQUIRED（与不带头同形）
2 GET /posts 游客 + 双头 → 401 SESSION_REQUIRED（与不带头同形）
2 GET /admin/sources 游客 + 双头 → 401 SESSION_REQUIRED（与不带头同形）
2 汇总：12 个用户/后台面在游客 + 双头下一律 401，且不含 B 的任何 id
3 GET /admin/sources 用户令牌 + 4 个身份头 → 403 SCOPE_DENIED（与基准同形）
3 POST /admin/sources 用户令牌 + 4 个身份头 → 403 SCOPE_DENIED（与基准同形）
3 GET /admin/knowledge 用户令牌 + 4 个身份头 → 403 SCOPE_DENIED（与基准同形）
3 GET /admin/registrations 用户令牌 + 4 个身份头 → 403 SCOPE_DENIED（与基准同形）
3 GET /admin/restrictions 用户令牌 + 4 个身份头 → 403 SCOPE_DENIED（与基准同形）
3 GET /admin/audit-events 用户令牌 + 4 个身份头 → 403 SCOPE_DENIED（与基准同形）
3 GET /admin/accounts 用户令牌 + 4 个身份头 → 403 SCOPE_DENIED（与基准同形）
3 GET /admin/categories 用户令牌 + 4 个身份头 → 403 SCOPE_DENIED（与基准同形）
3 GET /admin/jobs 用户令牌 + 4 个身份头 → 403 SCOPE_DENIED（与基准同形）
3 后台令牌 + x-role:user / x-user-id:A → 200（头部不能降权，也不能冒名）
3 后台令牌 + x-role:user 打用户面 → 401 SESSION_EXPIRED（头部不能把后台会话变成用户会话）
4 仅 x-role:admin → 用户面 200 同形 / 后台 403 同形 / 他人资源 404 同形
4 仅 x-user-id:B → 用户面 200 同形 / 后台 403 同形 / 他人资源 404 同形
4 大写 X-Role / X-User-Id → 用户面 200 同形 / 后台 403 同形 / 他人资源 404 同形
4 值大小写 x-role:ADMIN → 用户面 200 同形 / 后台 403 同形 / 他人资源 404 同形
4 自指 x-role:user + x-user-id:A → 用户面 200 同形 / 后台 403 同形 / 他人资源 404 同形
4 空值 x-user-id:"" → 用户面 200 同形 / 后台 403 同形 / 他人资源 404 同形
4 不存在的 uuid → 用户面 200 同形 / 后台 403 同形 / 他人资源 404 同形
4 多值注入 "B, A" → 用户面 200 同形 / 后台 403 同形 / 他人资源 404 同形
4 scope 头冒充后台能力 → 用户面 200 同形 / 后台 403 同形 / 他人资源 404 同形
4 汇总：9 种头部组合 × 3 个面（用户读 / 后台 / 他人资源）全部与基准逐字节同形，B 的数据原样
5 静态缝：扫 186 个 .ts — 身份头名 0 命中；x-* 头读取仅 media-access-token；身份字段写入 7 个全在 applyIdentity；applyIdentity 调用点 2 个守卫
```

## 5 改前 / 改后读数：mutant 表

改前读数（基线 `31a746d`，产品代码未动）：矩阵 `6/6 绿`、新文件 `5/5 绿`。

覆盖方式：在 `services/api/src/auth/middleware.ts` 的三行赋值上**各注入一次**（下面三个 mutant），每次跑完立即
`git checkout -- services/api/src/auth/middleware.ts` 还原，并在脚本内比对新旧文件字节相等；还原后
`git diff --numstat` 对 `services/**` 为 0 行（本片最终 diff 只有测试 + 本页）。

| mutant | 注入点（`applyIdentity` 内） | 旧矩阵（`gy-i22-secmatrix`） | 新文件（`gy-i22-identity-headers`） | 判定 |
| --- | --- | --- | --- | --- |
| **M4a** 身份替换：`request.userId` 改读 `x-user-id` 头 | `middleware.ts:151` `request.userId = identity.userId` | `tests 6 / pass 6 / fail 0`（**存活**） | `pass 2 / fail 3` ⇒ T1、T4、T5 红 | 被**行为断言**杀 |
| **M4b** 升权：`request.role` 改读 `x-role: admin` | `middleware.ts:153` `request.role = identity.role` | `tests 6 / pass 6 / fail 0`（**存活**） | `pass 2 / fail 3` ⇒ T1、T4、T5 红 | 被**行为断言**杀 |
| **M4c** 提权：`request.authScopes` 由 `x-role` 头注入 | `middleware.ts:157` `request.authScopes = identity.role === 'admin' ? …` | `tests 6 / pass 6 / fail 0`（**存活**） | `pass 4 / fail 1` ⇒ 仅 T5（静态缝）红 | **行为面不可观测，仅静态缝杀**（见 §7.2） |

> M4a / M4b 下 T3（管理端 9 面）**仍绿**，T1 里的「后台面 403」子断言也仍绿——这不是漏测，而是 §2.2 的机制：
> 用户令牌在 `authenticateAdmin`（`middleware.ts:117`）就被拒，`applyIdentity` 未被调用。真正的观测点只能放在
> **用户面**（读面同形、写面落 A、越权 404），这正是本片 T1/T4 放在用户面的原因。

## 6 门禁读数

| 门禁 | 命令 | 读数 |
| --- | --- | --- |
| 依赖安装 | `npm ci --offline --ignore-scripts` | 成功（`--offline` 生效，未回退联网）：added 103 packages；audited 106；0 vulnerabilities |
| 矩阵单测（回归 146 条） | `node --test "tests/unit/gy-i22-secmatrix.test.mjs"` | `tests 6 / pass 6 / fail 0 / cancelled 0 / skipped 0 / todo 0`，exit 0；**146 条 `[I22]`** |
| 新文件聚焦跑 | `node --test "tests/unit/gy-i22-identity-headers.test.mjs"` | `tests 5 / pass 5 / fail 0 / cancelled 0 / skipped 0 / todo 0`，exit 0；**49 条 `[I22-M4]`** |
| 全量单测（默认隔离） | `node --test "tests/unit/*.test.mjs"` | `tests 1738 / pass 1737 / fail 0 / cancelled 0 / skipped 1 / todo 0`，exit 0；唯一 skip 是既有条件跳过（`knowledge-api.test.mjs` 的 native 直连用例，`{ skip: !f.native }`），非本片新增 |
| 类型检查 | `npx tsc -p services/api/tsconfig.json --noEmit` | exit 0，**0 行输出** |
| 契约状态（静态） | `node tools/verify-contract-status.mjs` | exit 0，4 条 PASS：112 条操作/已装配 108；形状错误 0、语义错误 0；语义可核 59 区间；中文表格一致 |
| 契约状态（真装配） | `node tools/verify-contract-status.mjs --runtime` | exit 0，5 条 PASS：上列 4 条 +「无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描一致」 |
| 开发文档 | `python -B tools/validate_development_docs.py` | exit 0：`PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| 空白/冲突标记 | `git diff upstream/main --check` | exit 0，**0 行输出** |
| 产品代码 0 改动 | `git diff --numstat upstream/main HEAD` | 只有 `tests/unit/gy-i22-identity-headers.test.mjs` 与 `docs/verification/gy-i22-identity-headers-20261019.md` 两行；`services/**`、`packages/**`、契约、迁移 **0 行** |
| 禁用标记 | `grep -c 'skip\|todo\|\.only(' 新文件` | 0 处 |

注：首次全量跑出现过 **1 红**（`contract-status-tool.test.mjs` 的 `spawnSync … ETIMEDOUT`），已单独披露与复跑证据，见 §7.3。

## 7 发现与披露

### 7.1 是否发现真漏洞：**没有**

49/49 的读数都落在「请求头被完全忽略」一侧：读面同形、写面落会话本人、越权 404 与不存在 id 同形、后台面
403 同形、游客面 401 同形。三个 mutant 的对照（§5）证明这些断言具备检出能力，因此「没有发现」不是断言失效
造成的假阴性。审查者此前的结论（产品当前无此路径，属覆盖缺口而非漏洞）与本片实测一致。

### 7.2 M4c（scope 从头部注入）只在静态缝可见——如实披露

行为面为什么观测不到：本产品里 `request.authScopes` 的**唯一消费者**是后台路由的 `requireScope`
（`services/api/src/auth/middleware.ts:201`），而用户令牌在 `authenticateAdmin`（`:117`）就已经被受众检查拒绝，
走不到 `requireScope`；收藏/历史/消息/会话等用户面不读 `authScopes`。所以 M4c 在行为上**不可观测**，
只有 §2.3 的静态缝（写入点唯一性）能杀死它。这不削弱结论（M4c 不是 M4 的原形，M4 的原形是 M4a/M4b，
两者都被行为断言杀死），但它说明：**如果将来用户面开始消费 `authScopes`，M4c 的行为覆盖需要补**。
本片不为此新增产品面，仅留档。

### 7.3 首次全量单测的 1 红：`spawnSync … ETIMEDOUT`（环境载荷，非本片改动）

- 现象：`tests/unit/contract-status-tool.test.mjs:198` → `tools/contract-status-core.mjs:65` 的
  `execFileSync` 在并行跑全量时超时（`errno: -4039`，`signal: 'SIGTERM'`，子进程 `contract-status-runtime.mjs`）。
- 复跑证据：该文件**单独**跑 `tests 18 / pass 18 / fail 0`（exit 0）；随后**全量**重跑
  `tests 1738 / pass 1737 / fail 0 / skipped 1`（exit 0）。两次读数与基线一致。
- 结论：这是并行负载下子进程启动超过 spawn 超时的**环境抖动**，与本片改动无关（本片只增一个测试文件与一个
  Markdown 页，不触碰 `tools/` 与契约表）。

## 8 未取得

| 项 | 为什么未取得 | 谁能推进 |
| --- | --- | --- |
| 真实微信登录态下的身份头行为 | 需要真实 AppID/Secret 与真机；本机只有合成会话 | 有测试号的环境 |
| 真实反向代理/网关层的头改写行为 | 本仓库测试只到 Fastify 装配层；网关（Nginx/云 WAF）不在仓内 | 部署环境负责人 |
| 生产审计日志中「是否有人尝试过这类头」 | 需要生产日志权限 | 运维/监工 |
| 小程序侧请求拦截器是否注入身份头 | 小程序脚本校验依赖 bash，本机为 WSL 存根 | 有 bash/真机环境 |

## 9 与既有测试的关系（不重复、不替代）

- **不重复**：[矩阵](gy-i22-secmatrix-20261019.md) 的 C3 证明「后台守卫按受众拒绝、伪造头进不去后台」；
  本片证明的是**另一个命题**——「用户面已经写入的身份不会被请求头改写」，且给出「带头 vs 不带头」的逐字节对照。
  两者互补：M4a/M4b 注入下矩阵 6/6 仍绿、本片红（§5），正是互补关系的实证。
- **不替代**：本片没有放宽任何既有期望；矩阵文件 0 改动、146 条读数原样全绿；`skip`/`todo`/`only` 0 处。
- 与 `gy-i22-cross-module-security-e2e-20261027.md`（会话/角色在途变化、授权撤回）关注点不同：本片只测**请求头**
  这一种输入通道，不测会话在途状态变化。

## 10 本页不宣称的内容

1. 不宣称「系统安全」：只证明**在这些固定输入下**服务端返回了这组固定输出。
2. 不宣称覆盖所有身份旁路：只覆盖 `x-role` / `x-user-id` 及其 9 种相邻写法；query / body / cookie / JWT claim
   等通道不在本片（其中 query/body 在矩阵 C3 行 20–21 已覆盖）。
3. 不宣称网关层同样如此：本机测试不含反向代理与 WAF（见 §8）。
4. 不宣称 mutant 表穷尽：三个 mutant 覆盖 `applyIdentity` 的 7 个字段中的 3 个（`userId` / `role` / `authScopes`），
   其余字段（`authEpoch` / `sessionId` / `sessionExpiresAt` / `accountRevision`）的注入未做，因为它们不进
   路由判定，注入后行为不可观测。
