# GY-R64 PR-4c：后台 scope 操作被拒后的留痕（应用层接线）

- **片**：`#18` S2 收尾片 PR-4 剩下的一半（裁定 B 的**应用层**这一半；库层已由 `#649` 落在 main）
- **基线**：`ac8b44464e27ff5144a241e08204e26ef9497004`（原基于 `27bc991f`；`#648`／`#650`／`#651` 合入后 `rebase` 到新 main，§7 门禁读数已在新基线上复跑，见 §11）
- **分支**：`feat/gy-r64-pr4c-denial-wiring`
- **日期**：2026-10-26
- **一句话结论**：`0041` 的 `grant/revoke` 判定拒绝后整笔回滚、库里不留痕；本片在**应用层**补上这一行 —— 主事务 `ROLLBACK` → 主连接 `release()` → **另一条**连接上单条语句自提交 `public.record_admin_scope_denial(...)`（迁移 `0046`）。留痕**失败**不改主响应（403/409 原样，绝不升 500），**成功**也不会把 403/409 变 200；只在四个「被拒」SQLSTATE 上写，服务端缺陷（`XX000`/`42501`/`42883`/断连）一行都不写。

---

## 1 口径：这是「应用层申报」，不是「库层证明」

被拒的那一刻，`0041` 的 `pg_advisory_xact_lock` 已随主事务释放，`admin_scopes` 与 `admin_audit_events` 里都没有任何「刚才被拒过」的痕迹。等留痕真的落到第二事务里时，已经**无从复算**「当时有几个 `scopes:write` 持有者」「操作者当时到底持不持 `scopes:write`」。

因此这一行只申报四件事，且都能从本次请求**原样**取到，⛔ 不重新推导库层当时的判定：

| 记什么 | 取自哪里 |
| --- | --- |
| 哪个操作者 | `AdminScopeAuthorityAction.actorId`（`services/api/src/admin/ops/service.ts` 已按会话主体填好） |
| 对谁 | `action.targetId`（路径里的目标管理员 id，⛔ 不是 `users.id`） |
| 哪一次请求 | `action.requestId` —— 沿用**既有** `context.requestId`（`Meta.request_id`），本片没有新造 request-id 传递链 |
| 哪一类拒绝 | SQLSTATE → `reason_code`（闭集四值，与 `0046` 的 `x_reason_allowed` 逐字同源） |

`p_scope` 恒为 `'scopes:write'`：本片处理的是**元权限域**上的授予/撤销被拒，「操作被拒」这件事的主题是元权限本身，⛔ 不跟 `action.scope` 走。代价见 §8 第 1 条。

`p_audit_id` **不传**（用函数默认值 ⇒ 函数内 `gen_random_uuid()`）：拒绝没有「调用方已知的审计 id」这回事，硬传一个反而是给调用方留了指定 id 的缝。SQL 与常量见 `services/api/src/admin/ops/scope-denial-trace.ts:42-59`。

---

## 2 三条取舍（每条都有对应的负控制 / 静态守卫）

### 2.1 为什么**必须**第二条连接

同一事务里写的行会跟着 `ROLLBACK` 一起消失 —— 这不是「实现选择」，是物理事实：`0041` 的函数 `RAISE` 之后事务已 aborted，同一连接上任何后续语句只会拿 `25P02 current transaction is aborted`。实测（§6）把留痕改回同事务写，真库臂的「恰 1 行 `admin_scope.deny`」立刻变成 0 行。

顺序也是纪律的一部分：**先** `ROLLBACK`、**再** `client.release()`、**然后**才在 `pool.connect()` 拿到的新连接上发一条 `SELECT public.record_admin_scope_denial($1..$5)`（**不包** `BEGIN`…`COMMIT`，单语句自提交），最后 `release()`。⛔ 不得在还占着主连接时做旁路写：那会把一笔已回滚的事务重新拖进同一个事务域，「留痕行的去留」就跟着主响应一起被决定。

落点：`services/api/src/admin/ops/scope-authority-pg.ts:296-316`（`catch` 内三步 + `finally` 幂等兜底）；旁路本体 `services/api/src/admin/ops/scope-denial-trace.ts:145-191`（导出入口的吞错壳 `:132-143`、`log.warn` 的兜底 `:106-117`，见 §10）。

> 旁路单独成一个文件而不是塞进写权威：那边失败必须抛（错误映射决定 403/409），这边失败必须吞，两种相反的失败语义放一处最容易被后来人写错。

### 2.2 为什么只认四个 SQLSTATE

`G0008`（自授）/`G0009`（撤销后持有者归零）/`G0010`（操作者不是有效管理员或不持 `scopes:write`）/`G0011`（授予自己并不有效持有的 scope）是**库层判定并整笔回滚**的四类拒绝。

其中 `G0008` 有**两条到达路径**，都必须落到同一行 `admin_scope.deny`（`reason_code='self_scope_grant_denied'`、`scope='scopes:write'`）：

- **(a) 库层判定**：自授请求真的进了 `public.grant_admin_scope(...)`（例如操作者绕过服务层、或将来有人把服务层的早拒拆掉）⇒ `G0008` 抛在主事务内、整笔回滚 ⇒ 写权威 `catch` 里那条旁路另开连接记账（就是上面「库层判定并整笔回滚」这句话描述的形状）。
- **(b) 应用层早拒**：`services/api/src/admin/ops/service.ts` 的 `grantAdministratorScope` 在调 `grant` **之前**就把自授拒成 403 `SELF_SCOPE_GRANT_DENIED`（不让它进事务，也不让一次注定失败的操作占用幂等位）。这条路径上 (a) 的 `catch` **根本不会执行** ⇒ 修复前这一种自授在库里**零痕迹**。现在服务层在抛 403 之前显式调 `authority.recordEarlyDenial(subject, 'G0008')`：写路径仍是 `public.record_admin_scope_denial(...)`（`recordEarlyAdminScopeDenial` 是它的薄壳，逐字同源），区别只是**没有主事务可回滚**，因此那一条语句单语句自提交；失败同样整段吞掉，403 原样返回。

`XX000`（内部错误）/`42501`（权限不足 ⇒ 运行时角色被收权）/`42883`（函数不存在 ⇒ 迁移没跑）/连接断开，是**服务端缺陷**。给它们写一行 `result='denied'` 会把平台事故伪装成一次正常的权限拒绝 —— 值班会去查操作者，而不是去查故障。⛔ 不得冒充。表外取值一律 `return`（`denialReasonOf` 用 `Object.hasOwn` 而非 `in`，避免 `toString`/`constructor` 这类原型键被误判成命中）。

### 2.3 为什么整段吞异常

留痕是**旁路**，它不参与判定：

- 它失败 **不得** 改变主响应（`mapAdminScopeAuthorityError` 决定的 403/409 原样返回，绝不升 500）；
- 它成功 **也** 不得把 403/409 变 200（返回值仍由那条映射决定）；
- 唯一观测面是 `log.warn`（装配在 `services/api/src/app.ts:1505-1512` 注入 `app.log`）。载荷只带 `sqlstate`/`reason_code`/`actor_id`/`target_id`/`request_id`/`denial_error_sqlstate`，⛔ 不记驱动 `message`（可能带 SQL 上下文/连接串片段），⛔ 不 `console.*`（会绕过结构化日志与脱敏）。

`recordAdminScopeDenial(...)` 返回 `void` 是刻意的：调用方拿不到「留痕成没成」这个信号，就不可能让主响应依赖它。

### 2.4 一个副作用（正面）：错误映射仍留在 `catch` 内

本片重构后 `mapAdminScopeAuthorityError(...)` 仍**在 `catch` 分支内**返回。这不是笔误：`tests/unit/retryable-fallback-inventory.test.mjs` 判据要求「映射函数必须与 catch 同文件、且从 catch 通道可达」，把映射搬到 `try/catch` 之外（用布尔标志收尾）会让 `scope-authority-pg.ts` 的那条 `retryable: true` 站点从 R31 清单里**静默消失**——本片实测红过一次（原文：`清单**多了**实际不存在的条目 … scope-authority-pg.ts 的 mapAdminScopeAuthorityError [has]`），改回「映射在 catch 内」后恢复。

---

## 3 台账变化（一处都不能少）

`0041`/`0046` 早已写审计，但应用层的 action 闭集**没登记**它们 —— 于是 `?action=admin_scope.grant` 今天必然 400（`services/api/src/admin/audit/service.ts` 校验闭集，闭集外 ⇒ `INVALID_REQUEST`）。这是本片顺手修掉的既有漂移：

| 文件 | 变化 |
| --- | --- |
| `services/api/src/admin/audit/catalog.ts:70-130` | `AUDIT_ACTIONS` 末位追加 `admin_scope.grant` / `admin_scope.revoke` / `admin_scope.deny`；`AUDIT_ENTITY_SCOPES` 追加 `admin_scope: 'scopes:write'`；文件头表改为 7 种 action / 5 支迁移，并如实登记「`admin_scope` 实体的 `scope` 列取 `scopes:write`」这处收窄 |
| `packages/contracts/openapi.json` | `/admin/audit-logs` 的 `action` enum 4 → 7、`entity` enum 3 → 4（只改枚举，不改路径/参数） |
| `apps/admin/src/lib/admin-audit-logs.mjs` | 前端镜像同步（`AUDIT_LOG_ACTIONS` / `..._LABELS` / `AUDIT_LOG_ENTITIES` / `..._LABELS` / `..._ENTITY_SCOPES`） |
| `tests/unit/admin-audit-logs.test.mjs` | `deepEqual(action enum, AUDIT_ACTIONS)`、entity 同理、`AUDIT_ENTITY_SCOPES` 排序断言一起放宽到 7/4 值 |
| `tests/unit/ai-ops-ledger-pins.test.mjs` | 钉子④的字面锚（`order` + `runtime` 两份）改成 7 项，注释说明第 5-7 项来自 0041/0046 |
| `tests/unit/admin-audit-action-jobs-cancel.test.mjs` | 「前 4 项」判据收敛为 `slice(0,4)`，并加注「后续扩值只能追加在末位」 |
| `tests/unit/admin-ui-audit-logs.test.mjs`、`…-render.test.mjs` | 期望值同步到 7/4 值 |

⛔ 没有新增/修改任何 `services/api/db/migrations/*.sql`，⛔ 没有碰 `deploy/**` 与 `90-assert`，⛔ 没有改 `0041` 的函数、`ErrorCode` 常量语义，也没有加新 SQLSTATE。

---

## 4 第一档：单测（假池记录语句序列）

`tests/unit/admin-scope-denial-wiring.test.mjs`（12 条，`tests/unit/retryable-fallback-inventory.test.mjs` 另 3 条一并列入门禁 1）

| 用例 | 判据 |
| --- | --- |
| 纪律 1·顺序 | `record_admin_scope_denial` 的落点索引 **>** `ROLLBACK` 索引、**>** 主连接 `release` 索引；留痕那条**新**连接上只有 1 条 query、且以 `SELECT public.record_admin_scope_denial(` 开头（⛔ 没有 `BEGIN`/`COMMIT`） |
| 纪律 1·入参 | 四个 SQLSTATE 逐个：`params === [actorId, targetId, 'scopes:write', reasonCode, requestId]`，且 `length === 5`（不传 `p_audit_id`） |
| 纪律 2·吞错 | 留痕那一步抛 `XX000` ⇒ 主响应仍是 409/403（**不是 500、也不是 200**）；`log.warn` 恰 1 次且载荷带 `denial_error_sqlstate`；载荷不得含驱动 `message` 原文 |
| 纪律 2·logger 自己抛错 | 注入的 `log.warn` 抛异常 ⇒ 主响应仍是 409/403（`G0009`→409、`G0008`→403 两轮；`warn` 被调 1 次即够，异常不向外穿透）——**§10 必修 2 的那条用例** |
| 纪律 2·`release()` 抛错 | 归还主连接时 `release()` 抛异常 ⇒ 主响应仍是 409/403，且留痕照样发出（释放失败不等于「这笔请求没发生过」） |
| 纪律 2·次连接拿不到 | 第二次 `connect()` 抛 `ECONNREFUSED` ⇒ 同样只 warn、主响应不变 |
| 纪律 2·无 log | 不注入日志口也不炸（本片唯一允许的静默降级） |
| 纪律 0·表外码 | `XX000`/`42501`/`42883` ⇒ `PROVIDER_UNAVAILABLE`；`57014`/`55P03` ⇒ `PROVIDER_TIMEOUT`；`ECONNRESET`/空码 ⇒ `PROVIDER_UNAVAILABLE`；全部断言 `status ∉ {403, 409}`、零留痕、零 warn |
| 纪律 0·成功路径 | 授予/撤销**成功**时零留痕，且只开 1 条连接（不许多开） |
| 映射表同源 | 恰 4 键；四个 `reason_code` 与 `0046` 里的字面量逐值对拍（任一侧改名即红） |
| 闭集同源 | 从 `0046` 里解析 `x_reason_allowed`/`x_scope_allowed` 两个字面量闭集，断言 reason 四值与映射表排序后逐值相等、scope 恰 13 项且含 `scopes:write`（旧版这条是「断言一个必然存在的子串」，见 §10 必修 3） |
| 静态接线 | `scope-authority-pg.ts` 里 `recordAdminScopeDenial(` 恰 1 处，且文本顺序是 `ROLLBACK` → `releaseQuietly(client)` → 留痕；旁路文件里不得出现事务控制语句、不得 `console.*`；两处失败兜底（`warnQuietly`、导出入口的 `try`）必须在位 |

**读数**：`node --test --test-concurrency=1 <9 个文件>` ⇒ **tests 97 / pass 97 / fail 0，exit 0**。

---

## 5 第二档：真库臂（PG 17.11，单实例，真 `gengyun_api_runtime` 身份）

落点：`tests/integration/admin-scopes-authority-pg.mjs`（自起临时集群，`DB_NAME=gengyun` 以满足 `20-login-roles.sql` 的硬前置）。新增的四条断言（在既有「最后授权者守卫」段之后）：

1. **业务码**：`createPostgresAdminScopeAuthority` 经**真库池**执行 `revoke(A 自撤 scopes:write)` ⇒ `LAST_SCOPE_MANAGER` / `status 409`（异常原样抛出，未被留痕改写）；
2. **`admin_scopes` 有效行数未变**：`7` 行（`revoked_at === null` 计数），A 的 scope 集合与 `admin_accounts.revision` 原样；
3. **`admin_audit_events` 恰 1 行**：`action='admin_scope.deny'`、`result='denied'`、`actor_id`/`request_id` 与本次请求一致、`scope='scopes:write'`、`reason_code='last_scope_manager'`、`target_hint='admin_account:<target>'`；
4. **零告警**：`log.warn` 一次都没被调用（否则 ③ 是假绿：row 可能是别的路径写的）。

命令与读数：

```
$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'
$env:GY_R37_PG_ROOT='E:\GengYunCommander\.pg17\tmp'
node tests/integration/admin-scopes-authority-pg.mjs
```

```
✓ 应用层：自撤最后一名 scopes:write ⇒ 409 LAST_SCOPE_MANAGER（异常原样抛出，未被留痕改写）
✓ 应用层：被拒后 admin_scopes 有效行数未变（7 行）、A 的 scope 与 revision 原样
✓ 应用层：admin_audit_events 恰 1 行 admin_scope.deny/denied，actor·request·scope·reason·target_hint 逐字段一致
✓ 应用层：留痕全程零告警（第二条连接以 gengyun_api_runtime 身份真的写成了）
✓ 全链读数一致（授予/撤销/复活/委派各留下自己的审计行，库层被拒路径零行，应用层被拒恰 1 行 deny）
· 审计留痕（admin_scope.*）共 7 行：… admin_scope.deny/scopes:write/last_scope_manager …
· 收尾：临时集群已停、目录已删、端口无监听
EXIT_PG=0
```

**准确口径（§10 订正过）**：整份输出 **38 行 = 34 条 `✓` + 4 条 `·`**，`✗` 0 条。`✓` 是 `pass()`（断言通过）；`·` 是 `note()`（纯信息行，**不是**断言、也不是跳过）——4 条分别是集群引导 2 行（目录/端口、`server_version = 17.11`）、审计行清单 1 行（`admin_scope.*` 共 7 行）、收尾 1 行。本片新增的是其中第 28-31 行那 4 条「应用层」`✓`。脚本里的两个打印器：`const pass = line => console.log(\`  ✓ ${line}\`)`、`const note = line => console.log(\`  · ${line}\`)`。

为什么这一臂必须真跑产品代码（而不是裸 SQL）：假池证得动「语句顺序」，证不动「第二条连接以 `gengyun_api_runtime` 身份真的被 `20-login-roles.sql` 授权过」——`0046` 的 `EXECUTE` 只授给运行时角色，而写权威用的正是运行时连接串。

---

## 6 第三档：负控制（把留痕改回**同事务**写）

改法（其余**一律不动**）：在 `catch` 里、`ROLLBACK` **之前**，用**主连接**发同一条 `SELECT public.record_admin_scope_denial(...)`（`try/catch` + `log.warn` 保留），并把出 `catch` 的 `recordAdminScopeDenial(...)` 临时停用。

```
  ✓ 应用层：自撤最后一名 scopes:write ⇒ 409 LAST_SCOPE_MANAGER（异常原样抛出，未被留痕改写）
  ✓ 应用层：被拒后 admin_scopes 有效行数未变（7 行）、A 的 scope 与 revision 原样
AssertionError [ERR_ASSERTION]: admin_scope.deny 必须恰有 1 行，实际 0 行
    at file:///E:/GengYunCommander/wt-r64-pr4c/tests/integration/admin-scopes-authority-pg.mjs:835:12
  code: 'ERR_ASSERTION', actual: 0, expected: 1, operator: 'strictEqual'
EXIT_NEG=1
```

**只红这一条**：①② 仍绿（业务码与 `admin_scopes` 行数不受影响——这正是设计意图：留痕绝不能参与判定），第 4 条「零告警」在 ③ 之后、**没有机会执行**。还原后 `services/api/src/admin/ops/scope-authority-pg.ts` 的 SHA256 与改前逐字节一致（`233C3ED78BA5369FE2CE78772A3FC13273ACA9E91C7A8A828CC816F5D5208F5F`），并复跑真库臂 exit 0。

> 这一条也顺便证明了「为什么必须第二连接」不是风格偏好：同事务写在 PG 里**物理不可能**成立。

---

## 7 门禁读数（串行执行）

| # | 命令 | exit | 关键读数 |
| --- | --- | --- | --- |
| 1 | `node --test --test-concurrency=1 <9 个受影响测试文件>` | 0 | tests 97 / pass 97 / fail 0 |
| 2 | `node --test --test-concurrency=1 "tests/unit/*.test.mjs" …`（串行等价于 `npm run test:unit`） | 0 | tests 5128 / pass 5125 / fail 0 / skipped 1 / todo 2（443 s；可用内存 2.69 GB，未跳过；`npm run test:unit` 不带 `--test-concurrency=1`，按「单实例」纪律用等价的串行命令跑） |
| 3 | `npm run test:contract` | 0 | tests 16 / pass 16 / fail 0 |
| 4 | `python tools/validate_contracts.py` | 0 | `PASS: 124 operations; contract consistency; 29 fixtures; 30 media traces; 8 knowledge roundtrips` |
| 5 | `python tools/validate_development_docs.py` | 0 | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| 6 | `node tools/verify-contract-status.mjs` | 0 | 行号区间 305 条全 PASS、语义错误 0、中文表格一致（**未手改台账**，见 §8 第 3 条） |
| 7 | `node tools/openapi-route-parity.mjs` | 0 | `"missing": [], "ledgerDrift": []` |
| 8 | `node tools/verify-doc-anchors.mjs --strict --scan docs` | 0 | `BROKEN 4 / OUT_OF_RANGE 2 / SUSPECT 7（合计 13）；基线登记 13、命中 13、基线外新增 0、陈旧 0` |
| 9 | `npm run lint`（仓内等价于 `lint-workspaces`） | 0 | `PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、`PASS 仓库卫生扫描` |

真库臂另计：`node tests/integration/admin-scopes-authority-pg.mjs` ⇒ exit 0（**34 条 `✓` + 4 条 `·`，共 38 行，`✗` 0 条**；口径见 §5 与 §10.4）。
门禁 8 读数：`BROKEN 4 / OUT_OF_RANGE 2 / SUSPECT 7（合计 13）；基线登记 13、命中 13、基线外新增 0、陈旧 0`。

---

## 8 未取得 / 判据边界 / 有争议

1. **`scope` 列取 `scopes:write` 会「一变多」**：`0041` 的 grant/revoke 审计行 `scope` 列记的是**被授/被撤的那个 scope 本身**，而 `0046` 的拒绝行写死 `scopes:write`（只有「动到 `scopes:write` 的授予/撤销行」才与拒绝行同值）。因此 `?entity=admin_scope` 的筛选语义是「元权限域相关」，逐 scope 的完整读法要用 `?action=admin_scope.grant`。已在 `catalog.ts` 文件头如实登记，⛔ 没有把 `scope` 改成 `null`/空数组去退化成静默全量。
2. **CI 不跑这条真库臂**：`.github/workflows/real-pg-integration.yml` 是**逐条 `run:` 列举**（不是目录扫描），`admin-scopes-authority-pg.mjs` 从未接线（`tests/unit/ci-integration-chain-structure.test.mjs` 有登记与理由：自起集群 + `GY_PG_BIN` 必需 + 缺则 3 行 SKIP + `exit 77`）。接线要同时改 `ci-real-pg-wiring` 的三张清单并补证据页，属独立门禁变更，不在本片。**本片的真库读数只能本机手动复现**。
3. **两条台账行号仍在 ±2 容差内、但已不紧贴**：本片刻意把新增代码搬出 `scope-authority-pg.ts`（旁路独立成 `scope-denial-trace.ts`），让该文件里两个被台账锚定的符号落在台账给的 `180-211` / `220-280` 区间 ±2 内 —— 现坐标 `mapAdminScopeAuthorityError` 在 `:191`、`createPostgresAdminScopeAuthority` 在 `:246`（后者在本轮新增 `releaseQuietly` 后 233 → 246，仍在窗内），门禁 6 因此 PASS。`--reanchor` 对本条目**不可用**：判据是「同名符号的命中行分属不同声明块」，而定义行与调用行天然两块 ⇒ 恒 `AMBIGUOUS`（当时实测输出：`候选行号第 243、421 行；归属块 243-274、358-425`，其中 243/421 是**当时代码**的坐标，本轮的对应坐标是 191/310）。为不越「⛔ 不手改受保护台账」的界，宁可搬代码也不去改 `contract-status.json` 的 `lines`。台账这一行将来若要贴合实况，需先扩 `anchor-resolve` 的判据（属工具片）。
4. **`docs/architecture/contract-implementation-status.md` 的 blocker 文案已过时**：`grantAdministratorScope` 那一行仍写「拒绝侧留痕（裁定⑥后半句）不在本片」。该文档是**治理台账**（与 `contract-status.json` 同族、由 `tools/verify-contract-status.mjs` 校对中文表格），按项目惯例不单方面改受保护台账 —— `docs/pr-review-policy.md` §10.1 的受保护清单**并未**列入它，本片也没有拿到书面授权，故**没有改**，请裁定是否另开一片同步。
5. **HTTP 层没有端到端**：真库臂驱动的是 port（`createPostgresAdminScopeAuthority`），不是 Fastify 路由。403/409 的**封套**由既有 `tests/unit/admin-scopes-write.test.mjs` 与 `admin-http` 系列覆盖；本片新增的是「拒绝之后的那一次旁路写」，它只发生在 port 层，路由层没有新增分支。
6. **最坏情形仍可能丢一行**：`release()` 之后、旁路写完成之前若进程被杀/连接池不可用，这一次拒绝就无痕（只留可能的 `log.warn`）。这是「不把留痕塞进主事务」的必然代价，也是裁定 B 明确选择的取舍 —— 宁可少一行审计，也不让一次拒绝因为留痕失败变成 500。
7. **本片只覆盖 `scopes:write` 域**：其它 scope 上的授予/撤销被拒（`G0011` 之外的目标 scope 越权等）仍由同一条旁路处理，但 `p_scope` 一律 `scopes:write`；若将来要按被操作 scope 记账，需要 `0046` 放宽 `p_scope` 的闭集约束（库层变更，不在本片）。
8. **迁移 README 的「当前状态」无需再改**：`services/api/db/migrations/README.md:7` 在基线上已是 `0001..0046`；文中 `0001..0034`/`0001..0036` 两处是各片落盘**当时**的历史叙述，不是当前状态，故不动（也避免了无意义的锚点位移）。
9. **落库的拒绝只有两类，⛔ 不是「每一次 403/409 都留一行」**：① 真正进了写权威的拒绝（`G0008` 路径 (a)、`G0009`、`G0010`、`G0011`，即 `0046` 闭集里的四值）；② 服务层自授这一处**提前**拒绝（`G0008` 路径 (b)，见 §2.2）。**不**落库的（刻意）：`resolveContext`/`requireAdminScope` 的 403 `SCOPE_DENIED`、`parseIfMatchHeader` 的 428/400、契约镜像校验的 400、`normalizeIdParam` 的 400、未接线时的 503、幂等外壳的 400/409、以及路由/中间件层的 401/403；它们不是库层判定，而是应用层根本没让请求进权威。要覆盖它们，必须先扩 `0046` 的 `x_reason_allowed` 闭集并另立口径（库层变更，不在本片）；⛔ 不得靠把任意应用层 403 塞进这条旁路来「补齐」——那会把「平台在犯病」记成「操作者越权」。
   **本轮真库实测（2026-10-27，端口 55440）**：整条臂只落 **2 行** `admin_scope.deny`（`last_scope_manager=1`、`self_scope_grant_denied=1`）。两类「应用层 403 不落库」都被实测钉住：`[W5]` 里缺 `scopes:write` 的 403 前后总数 `1 → 1`（差 0）；`[W3]` 并发互撤的 loser 同样是 403 `SCOPE_DENIED` 且 0 行 —— 因为 `services/api/src/auth/middleware.ts` 每个请求都**活读** `admin_scopes`（`listAdminScopes`），输掉并发那一方的 `scopes:write` 已被撤销，请求在应用层门就被拦下，压根没进写权威。这条比干说更清楚：**「403 有行」和「403 没行」的区别不在状态码，而在有没有进权威**。

---

## 9 复跑指引

```powershell
# 单测（受影响文件）
node --test --test-concurrency=1 tests/unit/admin-scope-denial-wiring.test.mjs tests/unit/admin-scope-denial-trace.test.mjs tests/unit/admin-audit-logs.test.mjs tests/unit/ai-ops-ledger-pins.test.mjs tests/unit/admin-audit-action-jobs-cancel.test.mjs tests/unit/admin-ui-audit-logs.test.mjs tests/unit/admin-ui-audit-logs-render.test.mjs tests/unit/admin-scopes-write.test.mjs tests/unit/retryable-fallback-inventory.test.mjs

# 真库臂（需本机 PG 17；缺 GY_PG_BIN 会以 77 跳过）
$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'; $env:GY_R37_PG_ROOT='E:\GengYunCommander\.pg17\tmp'
node tests/integration/admin-scopes-authority-pg.mjs
```

负控制复现：把 `catch` 里的旁路调用换成「`ROLLBACK` 之前、用主连接发同一条 SQL」，其余不动 ⇒ 上面第 3 条断言必须变红且只它一条红。

---

## 10 审查修复轮（PR `#652` · 独立审查 `#652` comment `6418256597`：1 阻塞 + 8 非阻塞）

审查的阻塞项成立，逐条照改；另把「`log.warn` 自己抛错」判成必修（不是理论风险，见 10.2）。三处都做了**变异证明** —— 光「改完是绿的」不算证明，得能说清「改坏了会红、红在哪条」。

### 10.1 必修 1：`ai-ops-spec-status.md` 的 E31/E40 是假陈述

**审查说的**：`AUDIT_ACTIONS` 从 4 值扩到 7 值，但 E31 仍写「四条落库审计写路径 … 表注释与 `AUDIT_ACTIONS` 四项一一对应」、E40 仍写「`AUDIT_ACTIONS` 恰四值」，且指针全是旧行号。这页 `:271` 自己就写着「`AUDIT_ACTIONS` 闭集扩容（E40）」会让读数失效，所以本片必须同 PR 改，且该页**不在** §10.1 受保护清单里。

**我怎么改**（条数是从 `services/api/src/admin/audit/catalog.ts:9-17` 的表里**数**出来的，不是照抄）：

- **E31** → 「**七条**落库审计写路径（账号停用／恢复 `0017`、开关变更 `0020`／`0027`、scope 授予／撤销 `0041`、作业取消 `0043`、scope 操作被拒 `0046`）」+ 依据 `catalog.ts:9-17`；并写明「表七行与 `AUDIT_ACTIONS` 七值一一对应但**顺序不同**」——表按迁移顺序（`job.cancel` 在表里第 6 位），闭集把 `job.cancel` 留在**第 4 位**、`admin_scope.*` 追加在末三位。这个错位是真实存在的，照抄「一一对应」会在扩值时误导人。
- **E40** → 「`AUDIT_ACTIONS` **恰七值**（`job.cancel` 仍在第 4 位，`admin_scope.grant`／`revoke`／`deny` 追加在末三位），`?action=job.cancel` 与 `?action=admin_scope.grant` 都由 400 转 200」+ 依据 `catalog.ts:76-85`。
- 指针全部改成实测行号：`admin-audit-action-jobs-cancel.test.mjs:171`（200 且只回该动作）、`:150-154`（前 4 项长度 + 第 4 项）、`:225`（闭集外仍 400、零端口调用）、`admin-audit-logs.test.mjs:130-131`（`deepEqual(enum, AUDIT_ACTIONS)` / `AUDIT_ENTITIES`）、`ai-ops-ledger-pins.test.mjs:173`（钉子④）、`packages/contracts/openapi.json:11008-11015`（action 七值）、`:11024-11028`（entity 四值）。
- 顺带修掉一处**双重过时**的交叉引用：E31 末尾原指 `docs/architecture/contract-implementation-status.md:164` 并断言「写入点只有三处」。**实测（`27bc991f`）**：`:164` 是 `setFlag` 那一行（535 字符，最近的真空行在 `:175`），而「库内写入点只有 suspend_account / restore_account / set_feature_flag 三处」这句**逐字存在于 `:166`**（`listAuditLogs` 行）；`N02` 也**没有销号**（`ai-ops-spec-status.md` 里 `N02` 实指 **8 处**：`:57`／`:133`／`:151`／`:163`／`:204`／`:236`／`:306`／`:307`；另 `:18` 与 `:145`（该行两次）为顺带提及 —— 逐字重数为 **10 行 / 11 次**，`:133` 指针写的仍是 `:164`、`:151` 待办写的仍是「三处 → 四处」）。所以原指针是**指错了两行**，不是「指到空行」、也不是「那句话不存在」。本片据实改指 `:166`（`listAuditLogs` 判定不变，仍 `partial`），并把 N02 的 `:133`／`:204` 指针与 `:151` 的待办数字一并改正（「三处 → 四处」→「三处 → 七处」）。`contract-implementation-status.md` 本身是治理台账（§10.1 受保护清单未列入它，但本片亦无书面授权），**没有改它**——它那行「三处」仍与七值闭集冲突，N02 因此仍未关闭，需另开一片同步。

**怎么证明（人工证据，`--strict` 抓不到这类错）**：一次性脚本（不入仓）把 E31/E40 里所有 `路径:行号` 抽出来，逐条 ① 读该区间、断言每行非空且非纯符号（防「指到空行仍 exit 0」）② 按 `EXPECT` 表做**语义**断言（该行必须是被声称的那一行）。输出（11 条全中）：

```
OK  E31 services/api/src/admin/audit/catalog.ts:9-17                   ⟨* | 写入点（库内函数） | `action` | `scope`（查询参数 `entity` 的取值来源） | 迁移 |⟩
OK  E31 tests/unit/admin-audit-action-jobs-cancel.test.mjs:150-154     ⟨test('(d) 前 4 项长度仍为 4（第 4 项 = 0043 的 job.cancel）；后续扩值只能追加在末位', () => {⟩
OK  E31 docs/architecture/contract-implementation-status.md:166        ⟨| `listAuditLogs` | GET /admin/audit-logs | `partial` | services/api/src/route⟩
OK  E40 services/api/src/admin/audit/catalog.ts:76-85                  ⟨/** `GET /admin/audit-logs` 的 `action` 闭集（= 库内写入点的 `action` 列取值）。 */⟩
OK  E40 tests/unit/admin-audit-action-jobs-cancel.test.mjs:171         ⟨test('(b) `action=job.cancel` ⇒ 200，只返回该动作的行，且过滤值真的下发到端口', async () => {⟩
OK  E40 tests/unit/admin-audit-action-jobs-cancel.test.mjs:150-154     ⟨test('(d) 前 4 项长度仍为 4（第 4 项 = 0043 的 job.cancel）；后续扩值只能追加在末位', () => {⟩
OK  E40 tests/unit/admin-audit-action-jobs-cancel.test.mjs:225         ⟨test('(c) 反向控制：`action=not.an.action` ⇒ 400 INVALID_REQUEST，零端口调用', async () =⟩
OK  E40 tests/unit/admin-audit-logs.test.mjs:130-131                   ⟨assert.deepEqual(action.schema.enum, [...AUDIT_ACTIONS]);⟩
OK  E40 tests/unit/ai-ops-ledger-pins.test.mjs:173                     ⟨test('钉子④：AUDIT_ACTIONS 与契约 enum 双向相等（同值、同序、无重复），扩值必须同 PR 改三件套', () => {⟩
OK  E40 packages/contracts/openapi.json:11008-11015                    ⟨"enum": [⟩
OK  E40 packages/contracts/openapi.json:11024-11028                    ⟨"enum": [⟩

核对完成：11 条带行号的指针全部命中预期行，且没有一条指向空行/纯符号。
```

脚本首跑还**抓出了我自己一个错**：原本写的 `openapi.json:11008-11016` 末行只是 `]`，不合「非纯符号」判据 ⇒ 收敛成 `11008-11015` / `11024-11028`。这就是为什么要逐行读、而不是只看「行号在文件长度内」。

### 10.2 必修 2：`log.warn` 抛错会把 403/409 升成 500

**问题**：`:108` 的不变量写的是「旁路写失败**不得**改变主响应 …… 绝不升 500」，但 `log?.warn(...)` 自己就在 `catch` 里、**没有自己的 `try`**：logger 配置错 / 序列化环 / 测试替身故意抛 ⇒ 异常穿透 `recordAdminScopeDenial` → 穿透 `scope-authority-pg.ts` 的 `catch` → 冒到路由层 ⇒ 403/409 变 500。这违反的是**唯一**的不变量，不是纯理论。

**怎么改**（两层，缺一层都还会漏）：

1. `services/api/src/admin/ops/scope-denial-trace.ts:106-117` 新增 `warnQuietly(log, payload, message)`：`try { log.warn(payload, message); } catch { /* 静默 */ }`。
2. 导出入口 `:132-143` 改成**结构性**吞错壳：`try { await writeAdminScopeDenial(args); } catch { /* 兜底 */ }`——这样以后旁路里任何新增语句（包括 `release()`）抛错都不会外泄，不必靠「记得每处都包 try」。原实现整体改名 `writeAdminScopeDenial`（`:145-191`），其 `finally` 里的 `client?.release()` 也包了 `try`。
3. **顺手修同类洞**：`scope-authority-pg.ts` 主路径的 `client?.release()` 同样没保护（`release()` 会因重复释放/池已关抛错），新增 `releaseQuietly(client)`（`:229-238`），`catch` 与 `finally` 都用它。这个洞和 `log.warn` 是同一类：**清理动作抛错把业务错误顶掉**。

**怎么证明**：新增两条单测（`logger 自己抛错`、`release() 抛错`），并做变异：

- **变异 A**（去掉 `warnQuietly` 的 `try` 与导出入口的 `try`，回到审查看到的形状）⇒ 红两条，原文：`AssertionError: G0009：logger 抛错后主错误码被改写了 / actual: 'ELOGGER' / expected: 'LAST_SCOPE_MANAGER'`，同时静态用例 `导出入口必须把整段留痕包在 try 里` 变红。还原后 exit 0。
- **变异 B**（`releaseQuietly` 去掉 `try`）⇒ 唯一红点 `AssertionError: 释放失败后主错误码被改写了 / actual: 'ERELEASE' / expected: 'LAST_SCOPE_MANAGER'`。还原后 exit 0。

### 10.3 必修 3：一条近乎恒真的断言

**审查说的**：`tests/unit/admin-scope-denial-wiring.test.mjs` 里那条「闭集同源」是近乎恒真。

**为什么弱**：原文是 `assert.ok(sql.includes(\`'${ADMIN_SCOPE_DENIAL_SCOPE}'\`) || sql.includes('scopes:write'))` —— 两个操作数**是同一个字面量**（`ADMIN_SCOPE_DENIAL_SCOPE === 'scopes:write'`），而且 `'scopes:write'` 在 `0046` 的**注释**里出现 8 次。所以它几乎不可能红：闭集被改成 `'scopes:read'`、或者 `scopes:write` 从 `x_scope_allowed` 里被删掉，它都照样 PASS。

**怎么改**：改成从 `0046` 里**解析** `x_reason_allowed` / `x_scope_allowed` 的 `ARRAY[…]::text[]` 字面量（`closedSet()`），断言 ① reason 闭集与 `Object.values(ADMIN_SCOPE_DENIAL_REASONS)` 排序后**逐值相等** ② `allowedScopes.length === 13` ③ `allowedScopes.includes('scopes:write')`；解析不到时先报「解析失败」而不是静默通过。

**变异证明**（一次性脚本，不入仓；把 `0046` 文本里闭集的 `'scopes:write',` 那一行删掉、**注释原样保留**——正是旧断言看不见的那种改动）：

```
原始         → 旧断言 PASS / 新断言 PASS
变异         → 旧断言 PASS（盲）/ 新断言 FAIL（红）
变异是否真的动到了闭集：是（删掉了 1 行）
注释里 'scopes:write' 的出现次数（变异前后相同）：8
```

### 10.4 两个数字的口径订正

- **真库臂：`34 ✓` + `4 ·`（共 38 行，`exit 0`，`✗` 0 条）**，不是上一轮报的「44 ✓」。`·` 是 `note()` 的纯信息行（集群引导 2 行 + 审计行清单 1 行 + 收尾 1 行），既不是断言也不是 skip。审查数出的「34 ✓ + 4 ·」是对的。
- **R31 清单（`tests/fixtures/retryable-fallbacks.json`）**：本片新增一个源文件（`scope-denial-trace.ts`）+ 主路径 `catch` 下移，跑 `GY_RETRYABLE_INVENTORY_UPDATE=1` 重写了两个字段（`scanned.services/api/src.files` 239 → 240、`scope-authority-pg.ts` 站点行号 206 → 217）。行号在该文件里只做定位提示（不判红），但既然真漂了就按工具的 UPDATE 模式刷新，别留着当噪声。

### 10.5 修复轮复跑读数

见 §7 表（本轮全部重跑）；单测批次 **tests 97 / pass 97 / fail 0**，真库臂 **exit 0（34 ✓ + 4 ·）**。

## 11 第二轮增量复核后的口径订正与 rebase 复跑（纯文档）

增量复核（审查者（`#652` comment `6419332259` 代贴））对 `13feede7 → 42fbb0af` 判 **确认修复 —— 阻塞 0 条**，同时提了三条**表述层**建议。本节记录按建议做的订正，以及随后发生的基线漂移复跑。本节的改动**不含任何代码、测试或契约文件**。

1. **N02 的计数口径**：上一轮我写「仍有 8 处」，把 `N02` 实指的行当成了全部。逐字重数后是 **10 行 / 11 次**：实指仍是原来那 8 处（`:57`／`:133`／`:151`／`:163`／`:204`／`:236`／`:306`／`:307`），另有 `:18` 与 `:145`（该行两次）为**顺带提及**。口径错在上一轮审查，本轮已按上文 §10.1 订正。
2. **N02 的描述过窄**：`ai-ops-spec-status.md:133` 原写「`catalog.ts` 的**四写点表**」「未跟上**第四条**写路径」——写点表现为**七行**，台账记三处、实际七条、**未登记四条**（`0041` grant／revoke、`0043` job.cancel、`0046` deny）。已改成「七行写点表」＋「未跟上 0041／0043／0046 的四条写路径」。照原文抄下去，下一个人会写成「三处 → 四处」，正是本片修掉的那类错。
3. **⛔ 的措辞自相矛盾**：`docs/pr-review-policy.md` §10.1 的受保护清单**并未**列入 `contract-implementation-status.md`，而我在 §8 第 4 条与上面那段里都写成「在 ⛔ 名单里」（在同一段里又写「§10.1 未列」）。已统一为「它是**治理台账**（与 `contract-status.json` 同族、由 `tools/verify-contract-status.mjs` 校对中文表格），按项目惯例不单方面改受保护台账，本片也没有拿到书面授权」——行为不变（仍然没改它），去掉「名单」这个不存在依据。
4. **基线漂移与复跑**：`#648`／`#650`／`#651` 已合入，`main` 从 `27bc991f` 前移到 `ac8b4446`（其中 `ac8b4446` 就是 `#651` 的 squash、`d9f7f8f7` 是 `#650`、`aa65be8d` 是 `#648`）。`git merge-tree` 对本片与新 main **无冲突**，直接 rebase 成功（`42fbb0af` → `34ed2145`，20 文件 +1211/−44 不变）。§7 的四项读数在新基线上复跑**与本节原值一致**：

   | 门禁 | exit | 新基线上的读数 |
   | --- | --- | --- |
   | `python tools/validate_contracts.py` | 0 | `PASS: 124 operations; 29 fixtures; 30 media traces; 8 knowledge roundtrips` |
   | `node tools/verify-contract-status.mjs` | 0 | 行号区间 `305` 条（台账直写 304 + 符号解析 1）全 PASS、中文表格一致 |
   | `node tools/openapi-route-parity.mjs` | 0 | `extra [] / missing [] / ledgerDrift []` |
   | `node tools/verify-doc-anchors.mjs --strict --scan docs` | 0 | `BROKEN 4 / OUT_OF_RANGE 2 / SUSPECT 7（合计 13）`；基线登记 13、命中 13、**基线外新增 0** |

   `#648` 带进的是 `miniprogram/**` 与 `tools/prepare-wechat.mjs` 的改动（**没有**动 `openapi.json`：`git diff --numstat 27bc991f aa65be8d -- packages/contracts/openapi.json` 为空）；`openapi.json` 的字段扩充来自 `#651`（`git diff --numstat d9f7f8f7 ac8b4446` = **+215/−8**）。逐版实测 `paths=94 / operations=124 / operationIds=124`（`27bc991f`、`aa65be8d`、`d9f7f8f7`、`ac8b4446`、`e26586db` 五版全同），故 `124 operations` 与 `parity` 三项读数不变；台账侧 `#651` 已把它自己那 50 行数字重编号落进 main，`305` 条与中文表格仍一致。

## 12 第三轮：监工指出的「自授提前拒绝无留痕」缺口（代码修复 + 定向证据）

**监工原话要点（`gengyun-supervisor[bot]`，PR `#652`，2026-10-26T14:48:34Z）**：持 `scopes:write` 的管理员用合法 body/`If-Match`/`Idempotency-Key` 对**自己** POST `/admin/administrators/{id}/scopes` 时，`grantAdministratorScope` 在调 `scopeAuthority.grant` **之前**就抛 `SELF_SCOPE_GRANT_DENIED` ⇒ 本轮新增的写权威 `catch` 与 `recordAdminScopeDenial` 都不执行 ⇒ 那个 403 在 `admin_audit_events` 里**一行都没有**。上一轮（§4/§5 的读数）**只**证明了「进了权威的拒绝会留痕」，对这条**提前**拒绝是零覆盖 —— 这是真缺口，不是表述问题。

### 12.1 改了什么

| 文件 | 改动 |
| --- | --- |
| `services/api/src/admin/ops/scope-denial-trace.ts` | ① `:75` 新增 `SELF_SCOPE_GRANT_DENIAL_SQLSTATE: AdminScopeDenialSqlState = 'G0008'`；② `:174-181` 新增薄壳 `recordEarlyAdminScopeDenial(args)`，函数体只有 `return recordAdminScopeDenial(args)` |
| `services/api/src/admin/ops/scope-authority-pg.ts` | ① `:137` 端口加 `recordEarlyDenial(subject: AdminScopeDenialSubject, sqlState: string): Promise<void>`；② `:342` 工厂内委托 `recordEarlyAdminScopeDenial({ pool, subject, sqlState, log })`；③ `:61` 转出 `SELF_SCOPE_GRANT_DENIAL_SQLSTATE`（服务层只认识端口，不必认识旁路模块） |
| `services/api/src/admin/ops/service.ts` | `:1507` 先 `const authority = requireWiredScopeAuthority();`；自授分支内在抛 403 **之前** `:1517-1521` 调 `authority.recordEarlyDenial({ actorId, targetId, requestId }, SELF_SCOPE_GRANT_DENIAL_SQLSTATE)`，整段 `try/catch` 吞掉；`:1532` 的 `grant(...)` 改用同一个 `authority` |
| `tests/unit/admin-scopes-write.test.mjs` | `:54` 假权威补 `recordEarlyDenial`（独立 `earlyDenials` 流水，⛔ 不混进 `calls`）；`:228` 自授用例加「留痕 1 次 + `sqlState === 'G0008'` + 主体正确」；`:252` 新增负控制（留痕抛错 ⇒ 主响应仍 403 同码）；`:269` 新增适配层用例（真实现 ⇒ 单语句自提交、参数逐字、不包事务、连接归还） |
| `tests/integration/admin-accounts-read-pg.mjs` | `:226` 扩 `REGIONS` 加 `gy-r64-pr4a-denial-trace-grant`（否则运行时角色没有留痕函数的 EXECUTE，**所有** 403/409 都静默只 warn）；`:623`/`:625` 两个计数助手；`[W4]` 补「+1 行 `last_scope_manager`」；`[W5]` 补「缺权 403 差 0」（边界）与「自授 +1 行 `self_scope_grant_denied`」+ 按 `reason_code` 分组的读数 |

**两处判据口径（写清以免下一个人踩）**：

1. **`G0008` 不能从 `ADMIN_SCOPE_DENIAL_REASONS` 取「键」**：那张表是 `{ G0008: 'self_scope_grant_denied' }`，`ADMIN_SCOPE_DENIAL_REASONS.G0008` 是 `reason_code`（值），当 SQLSTATE 传进去是**表外键** ⇒ `denialReasonOf` 返回 `undefined` ⇒ 一行都不写。所以新增了具名常量 `SELF_SCOPE_GRANT_DENIAL_SQLSTATE`（类型是 `keyof typeof ADMIN_SCOPE_DENIAL_REASONS`，改号即编译期红），服务层仍**不**自带第二份映射。
2. **为什么是薄壳而不是在写权威里直接调 `recordAdminScopeDenial`**：`tests/unit/admin-scope-denial-wiring.test.mjs` 有一条静态判据「`scope-authority-pg.ts` 里 `recordAdminScopeDenial(` 恰 1 处，且必须在 `ROLLBACK` 与 `releaseQuietly(client)` **之后**」。在权威里再写一处同名调用会让它红，也会让读者以为早拒也包在主事务里。薄壳与本体逐字同源（同一个 `RECORD_DENIAL_SQL`、同一份「整段吞错」语义），只是调用时机不同：早拒没有主事务可回滚、没有主连接要 release，那一条语句自提交。

### 12.2 读数（本机，2026-10-27）

**单测**（`node --test`，三文件串跑）：

| 文件 | tests | pass | fail |
| --- | --- | --- | --- |
| `tests/unit/admin-scopes-write.test.mjs` | 30 | 30 | 0 |
| `tests/unit/admin-scope-denial-wiring.test.mjs` + `tests/unit/admin-scope-denial-trace.test.mjs` | 20 | 20 | 0 |
| 合计 | 50 | 50 | 0 |

`npx tsc -p services/api/tsconfig.json --noEmit` ⇒ `exit 0`。

**真库臂**（便携 PG 17，端口 55440，`exit 0`）——本轮新增/改写的读数逐行原文：

```
[P] 已按出厂区域 gy-r64-pr4a-denial-trace-grant 授予 EXECUTE（恰好 1 条：record_admin_scope_denial）⇒ has_function_privilege=true
[W4] 留痕：admin_scope.deny +1 行（reason_code=last_scope_manager，actor=最后授权者，scope=scopes:write，request_id=73bd2410-c625-4251-b0c6-86ba9b81ca07）
[W5] 边界：缺 scopes:write 的 403 SCOPE_DENIED **不**落 deny 行（总数 1 → 1，差 0）
[W5] 留痕：admin_scope.deny +1 行（reason_code=self_scope_grant_denied，actor/target 均为自授者，scope=scopes:write，request_id=16d785ba-6a2f-406f-b158-7255c3ca61e8）
[W5] 本臂 deny 行按 reason_code 分组：last_scope_manager=1，self_scope_grant_denied=1
```

跑完直接从库里回读（`SELECT reason_code, scope, actor_id, request_id, result FROM admin_audit_events WHERE action='admin_scope.deny'`）：

```
last_scope_manager|scopes:write|50d49ea2-377e-40e2-ab12-8025c90132f8|73bd2410-c625-4251-b0c6-86ba9b81ca07|denied
self_scope_grant_denied|scopes:write|50d49ea2-377e-40e2-ab12-8025c90132f8|16d785ba-6a2f-406f-b158-7255c3ca61e8|denied
```

⛔ `request_id` **不是** `Idempotency-Key`（这是随机/入站请求 id，`genReqId`）；断言只钉「非空 + uuid 形状 + ≠ 幂等键」，没有断言等于 `gy-w-self-0001`。

**六条门禁（串行，全 exit 0）**：

| 门禁 | exit | 读数 |
| --- | --- | --- |
| `node tools/verify-contract-status.mjs` | 0 | 行号区间 `305` 条全 PASS、中文表格一致 |
| `node tools/verify-doc-anchors.mjs --strict --scan docs` | 0 | `BROKEN 4 / OUT_OF_RANGE 2 / SUSPECT 7（合计 13）`；基线 13、命中 13、**基线外新增 0** |
| `node tools/openapi-route-parity.mjs` | 0 | `extra [] / missing [] / ledgerDrift []` |
| `node tools/verify-migrations-unique.mjs` | 0 | `45 条配对 + 1 条登记允许缺省 = 46 条` |
| `python tools/validate_contracts.py` | 0 | `PASS: 124 operations; 29 fixtures; 30 media traces; 8 knowledge roundtrips` |
| `python tools/validate_development_docs.py` | 0 | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping` |

### 12.3 覆盖边界与行号漂移（如实登记）

1. **覆盖边界**见 §8 第 9 条：本条修复只把「服务层自授」这一处**提前**拒绝接进同一条旁路；其它应用层提前拒绝（含 `[W3]` 并发互撤 loser 的 403）**实测 0 行**，且刻意如此。
2. **`[W3]` 的 loser 为什么不落行**：`services/api/src/auth/middleware.ts` 每请求**活读** `admin_scopes`，输掉并发互撤的一方已无 `scopes:write`，请求在应用层门就被拦下。上一轮我以为它可能是 `G0010`（那是会落行的），本轮实测否定了这个猜测 —— 所以 `[W4]`/`[W5]` 的断言一律用**前后差值**，不硬编码 `0→1`。
3. **`docs/verification/gy-r64-pr4b-suspend-guard-20261026.md` 的 4 处行号引用已同步**（`:693`→`:777`、`:746-774`→`:830-858`、`:776-799`→`:860-883`、`:801-833`→`:885-917`）：本轮在 `[W]` 段追加断言使 `[G]` 段整体下移 84 行，只改行号、未改任何判据（否则 doc-anchors 闸门会新报 SUSPECT）。
4. **为什么 `service.ts` 的 import 拧成一行**：新增的 `SELF_SCOPE_GRANT_DENIAL_SQLSTATE` 并入既有的端口 import 行，而不是另起一行 —— 该文件任何一行新增都会让 `docs/verification/r59-community-notify-dedupe-20261026.md:83` 引用的 `service.ts:1195` 落到一处只剩 `});` 的位置，从而在 doc-anchors 闸门新增 SUSPECT。这是**行号约束**驱动的写法，不是风格偏好。
5. **没有重跑**：全量 `npm run test:unit`（内存吃紧，只跑受影响的三个文件）、`admin-scopes-authority-pg.mjs`（本轮没动它的代码路径）、`admin-http.mjs`、CI。

