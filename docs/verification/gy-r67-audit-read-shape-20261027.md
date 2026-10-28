# R67 · P0：`GET /admin/audit-logs` 读面按 `action` 解码（2026-10-27）

> **一句话结论**：`GET /admin/audit-logs` 只要结果集里出现**任意一条** `admin_scope.grant` /
> `admin_scope.revoke` 审计行，整个页面就是 **503 PROVIDER_UNAVAILABLE**（报文 `审计日志的读数形状不符`）。
> 根因既不在 SQL、也不在契约：读面解码器只认开关读数 `{enabled, revision}`，却对**每一行**的
> `before_value` / `after_value` **无条件**按开关解码；而迁移 0041 写入的正是 `{scopes, reason}`。
> 本片把解码改成 **action 感知**：只有 `set_flag` 走严格开关校验（形状不符**仍然 503**），其余动作
> 库里即便有非 null 值也**如实返回 `null`** —— 不 503、不伪造读数、不把 `{scopes, reason}` 硬塞进
> `FlagReading`。单测与真库臂都取得了「改前红 → 改后绿」；负控制（把分派改回无条件严格解码）在
> 真库臂上两次都红在 `审计日志的读数形状不符`，第二次是对**已提交字节**做的（§6.1）。

| 项 | 值 |
| --- | --- |
| 仓库 | `GengYunChuChao/GengYun` |
| 工作树 / 分支 | `E:\GengYunCommander\wt-r67-p0-audit-shape` / `feat/gy-r67-audit-read-shape` |
| 基线 | 父提交 `b1d02c21`（＝当时的 `main`，`git status` 起始为空） |
| 切片档位 | **B 档（代码类）**：只提交、不 push、不建 PR |
| 行为改动 | `services/api/src/admin/audit/pg.ts` 一处解码分派（读面），零写入面改动 |
| 契约 | **未动** `packages/contracts/**`；`{scopes, reason}` 的暴露属后续「契约扩展」片 |
| 迁移 | **未动** `services/api/db/migrations/**`（缺陷在解码器，不在 SQL） |
| 机读钉子 | `tests/unit/admin-audit-logs.test.mjs`（新增 2 例：读数按 action 分派 / 读数表与动作闭集逐项相等）＋ `tests/integration/admin-audit-logs-pg.mjs`（新增第 7 段 7a–7d） |
| 取证方式 | 真 PG **17.11** 自起临时集群（`GY_PG_BIN` / `GY_R34_PG_ROOT`）＋ `node --test` ＋ `tsc` ＋ 6 道静态门禁 |
| 结论性质 | 修的是「一条读不懂读数的行把整页藏掉」；**没有**扩大契约读面，也没有把非开关读数伪装成开关读数 |

## 1. 缺陷

`GET /admin/audit-logs` 的读面在**行级**做形状校验：任何一行的 `before_value` 或 `after_value`
不是 `{enabled: boolean, revision: number}`，就 `throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志的读数形状不符', { retryable: false })`。
异常在**整页组装时**抛出，所以一条不合形状的行会让**同一次查询的所有行**一起变成 503：
这不是「某条记录读不出来」，而是「审计事实整页不可见」。

触发面不是边角：迁移 0041 的授予/撤销写入点**每次都写** `{scopes, reason}`，而读函数没有形状过滤
⇒ 只要管理员做过一次 scope 授予，审计页就再也打不开（分页、筛选、时间窗口都不能绕开，因为过滤发生在
SQL 层、校验发生在解码层）。

## 2. 证据链（file:line 均为本工作树相对路径）

| # | 环节 | 位置 | 事实 |
| --- | --- | --- | --- |
| 1 | 读面解码器 | `services/api/src/admin/audit/pg.ts:189-204`（改前为 `:129-145`） | `toFlagReading(raw)` 只接受 `{enabled, revision}`，否则 503 `审计日志的读数形状不符` |
| 2 | 无条件调用点 | `services/api/src/admin/audit/pg.ts:309-310`（改前为 `:231-232`） | `toAuditLogRow` 对每行的 `before_value` / `after_value` 都调它，无 action 分支 |
| 3 | 写入点 A | `services/api/db/migrations/0041_admin_scope_write_authority.sql:326-327` | `jsonb_build_object('scopes', to_jsonb(x_scopes_before), 'reason', p_reason)` |
| 4 | 写入点 B | `services/api/db/migrations/0041_admin_scope_write_authority.sql:479-480` | 同上，`..._after` 版本（撤销路径） |
| 5 | 读函数无形状过滤 | `services/api/db/migrations/0033_admin_audit_log_read.sql:96-107` | 只按 `from`/`to`/`action`/`scope`/`actor` 过滤，**不看** jsonb 形状 ⇒ 0041 的行必然流到解码器 |
| 6 | 唯一写开关读数的迁移 | `services/api/db/migrations/0027_*.sql:144-145` | `jsonb_build_object('enabled', x_before.enabled, 'revision', x_before.revision)`（`set_flag` 专用） |
| 7 | 其余写入点 | 0017（`account.suspend`/`account.restore`）、0043（`job.cancel`）、0046（`admin_scope.deny`）、0047（`post.hide`） | 全部写 `NULL` ⇒ 改前它们「碰巧」不触发 503 |
| 8 | 契约只能表达开关读数 | `packages/contracts/openapi.json:15723-15732`（`before_value`）、`:15634-15650`（`FlagReading`） | `before_value`/`after_value` ＝ `anyOf[FlagReading, null]`；`FlagReading` 是 `{enabled, revision≥1}` 且 `additionalProperties: false` |
| 9 | 契约镜像检查 | `services/api/src/admin/audit/service.ts:240-249` | 端口返回的每一行都过 `collectIssues('AuditEvent', …)` ⇒ 把 `{scopes, reason}` 塞进 `FlagReading` 只是把 503 挪到下一道门 |
| 10 | 盲区：真库臂只造一种形状 | `tests/integration/admin-audit-logs-pg.mjs`（改前第 1–6 段） | 只有 `before_value: { enabled: false, revision: 3 }`，**从未**造过 0041 形状 ⇒ 这条 503 路径零测试覆盖 |

## 3. 改法

### 3.1 一张显式映射，不在调用点写字符串比较

`services/api/src/admin/audit/pg.ts:88-114`：

```ts
type AuditReadingKind = 'flag_reading' | 'unexposed';

export const AUDIT_READING_KIND: Readonly<Record<AdminAuditAction, AuditReadingKind>> = Object.freeze({
  [AUDIT_ACTION_ACCOUNT_SUSPEND]: 'unexposed',
  [AUDIT_ACTION_ACCOUNT_RESTORE]: 'unexposed',
  [AUDIT_ACTION_SET_FLAG]: 'flag_reading',
  [AUDIT_ACTION_JOB_CANCEL]: 'unexposed',
  [AUDIT_ACTION_ADMIN_SCOPE_GRANT]: 'unexposed',
  [AUDIT_ACTION_ADMIN_SCOPE_REVOKE]: 'unexposed',
  [AUDIT_ACTION_ADMIN_SCOPE_DENY]: 'unexposed',
});

export function readingKindOf(action: string): AuditReadingKind {
  return (AUDIT_READING_KIND as Readonly<Record<string, AuditReadingKind>>)[action] ?? 'unexposed';
}
```

为什么是 `Record<AdminAuditAction, …>` 而不是 `Record<string, …>`：动作闭集在
`services/api/src/admin/audit/catalog.ts:77-85`（`AUDIT_ACTIONS`）。用闭集当键类型，**闭集新增动作时
`tsc` 会在这张表上报缺项**，逼作者显式声明「这个动作有没有开关读数」，而不是静默落进某个 `else` 分支。
闭集外的动作（例如 0047 的 `post.hide`，尚未登记进 `AUDIT_ACTIONS`）走 `?? 'unexposed'`。

编译期只管「不漏」，运行时还要管「不多、不乱序」：这张表**导出**只为让单测拿
`Object.keys(AUDIT_READING_KIND)` 与 `AUDIT_ACTIONS` 做**集合与顺序的双向比对**
（`tests/unit/admin-audit-logs.test.mjs:636-660`，判据见 §3.3）。

### 3.2 解码分派：严格校验只留给 `flag_reading` 类

`services/api/src/admin/audit/pg.ts:219-236`：

```ts
function toAuditLogReading(raw: unknown, action: string): AuditLogReading | null {
  if (raw === null || raw === undefined) return null;
  if (readingKindOf(action) === 'flag_reading') return toFlagReading(raw);
  return null;
}
```

- `toFlagReading`（`services/api/src/admin/audit/pg.ts:189-204`）**逐字保留**改前的两条严格校验与错误文案
  ⇒ `set_flag` 行形状不符**仍然 503**（分派不是放宽）。
- 非开关动作：库里 `NULL` ⇒ `null`（与改前一致）；库里**非 null**（`admin_scope.grant`/`revoke` 的
  `{scopes, reason}`）⇒ **也返回 `null`**，并就地写明理由：契约把这两个字段钉成 `FlagReading`
  （`additionalProperties: false`），只能表达开关读数，`{scopes, reason}` 今天**不在契约读面上**，
  等后续「契约扩展」片再暴露；⛔ 不在这里硬塞，⛔ 也不为一条行让整页 503。
- 调用点改为 `toAuditLogReading(raw['before_value'], action)` / `(raw['after_value'], action)`
  （`services/api/src/admin/audit/pg.ts:309-310`），文件头「出口形状」段同步加了一句说明
  （`services/api/src/admin/audit/pg.ts:14-16`）。

### 3.3 测试侧：先把红路走一遍，再让它变绿

- 单测新增一例 `tests/unit/admin-audit-logs.test.mjs:548-622`：假 pool 返回**两行**原始库行
  （`admin_scope.grant` 行带 `{scopes: [], reason: 'x'}` / `{scopes: ['sources:write'], reason: 'x'}`；
  `set_flag` 行带 `{enabled: false, revision: 3}` / `{enabled: true, revision: 4}`），走**真**
  `createPostgresAdminAuditLogPort` + `createAdminAuditLogService`。断言：整页 200、grant 行两读数
  都是 `null` 且其余字段原样透出、flag 行读数**仍在**；外加一条反向控制（`set_flag` 行塞
  `{scopes: [], reason: 'x'}` ⇒ 仍 503）。
- 单测再加一条**双向钉子** `tests/unit/admin-audit-logs.test.mjs:636-660`：`Object.keys(AUDIT_READING_KIND)`
  与 `AUDIT_ACTIONS` 逐项相等（同值、同序、无重复），外加牙齿用例（多一个闭集外的键 `post.hide` 必须被判红）、
  `Object.isFrozen` 断言、以及「今天只有 `set_flag` 走 `flag_reading`」与「闭集外动作回落 `unexposed`」两条语义断言。
  理由：`Record` 的编译期检查只保证闭集里的动作**不漏**，挡不住表里多出一个闭集外的键（构造方式一旦不是字面量，
  excess property 检查就不生效）。
- 真库臂追加第 7 段 `tests/integration/admin-audit-logs-pg.mjs:632-772`：用 0041 的形状**直接 INSERT**
  一行 `admin_scope.grant`（`jsonb_build_object('scopes', to_jsonb(ARRAY[]::text[]), 'reason', 'arm:grant')`
  与 `to_jsonb(ARRAY['sources:write']::text[])`），再断言 7a 不过滤列表 200 且该行读数 `null`、
  7b `?action=admin_scope.grant` 也能取到它、7c **同一次查询**里的 `set_flag` 行仍带 `{enabled, revision}`、
  7d 总行数（20009 → 20010）与键集游标（首页 + 第二页顺序、`limit=2` 五页收全 9 行）不变。
  既有 1–6 段的断言与 `· 规模` 口径**未改**。

### 3.4 附带：契约台账锚点的机械重算（非行为改动）

`pg.ts` 新增约 73 行后，`docs/architecture/contract-implementation-status.md:166` 的锚点
`services/api/src/admin/audit/pg.ts:305-305`（`createPostgresAdminAuditLogPort`）漂移到第 378 行，
`node tools/verify-contract-status.mjs` 因此报「锚点不在引用行范围内」。按 `AGENTS.md`
「契约台账锚点维护」一节先用 `--reanchor`（dry-run）确认差异只是行号漂移，再 `--reanchor --write-doc` 落盘：

```text
REANCHOR: listAuditLogs services/api/src/admin/audit/pg.ts 旧 lines 305-305 → 新 lines 378-429（锚点「createPostgresAdminAuditLogPort」命中第 378 行；归属块 378-429）
REANCHOR: 只报不改（dry-run）；1 条候选，加 --write-doc 才会写盘。
```

落盘只改了两个字面行号（`docs/architecture/contract-implementation-status.md:166` 与
`docs/architecture/contract-status.json:3643`），无任何语义/状态变化；`git diff` 见 §8.3。

⚠ **这是本片唯一越出派单白名单的改动**（白名单只列了 `services/api/src/admin/audit/pg.ts`、两份测试、
本页）；理由是 `services/api/src/**` 一改行数就必然让台账锚点漂移，而 `verify-contract-status` 是本片必跑门禁，
`AGENTS.md`「契约台账锚点维护」要求的就是这条工具写盘流程。补双向钉子时 `pg.ts` 又长了 3 行，
`createPostgresAdminAuditLogPort` 移到第 381 行 —— **仍落在 `378-429` 这个区间内**，复跑
`node tools/verify-contract-status.mjs` 依旧 exit 0，因此没有做第二次重锚（区间是工具算出的归属块，不手工改）。

## 4. 改前红（原文）

### 4.1 改前红：单测（新增用例，原缺陷形态下的实测）

`node --test tests/unit/admin-audit-logs.test.mjs`，`tests 10 / pass 9 / fail 1`，`exit 1`，
`test at tests\unit\admin-audit-logs.test.mjs（原文第 460 行，补用例后移到第 548 行）`：

```text
✖ GET /admin/audit-logs：读数按 action 分派（admin_scope.grant 如实 null，set_flag 仍严格） (0.5111ms)
  Error [ApiError]: 审计日志的读数形状不符
      at toAuditLogReading (file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/pg.ts:142:11)
      at toAuditLogRow (file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/pg.ts:231:19)
      at file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/pg.ts:349:34
```

堆栈行号 `142 / 231 / 349` 是**改前**的 `pg.ts`（分派逻辑尚未加入时）——即缺陷本体。

### 4.2 复现同一处红（把分派临时改成无条件严格解码后再跑一次，全文）

为了让「红」可复算，本页另做了一次复现：把 `toAuditLogReading` 临时改成
`void action; return toFlagReading(raw);`（＝改前形态），跑同一份单测。此时文件里**已有**新代码，
所以堆栈行号是新的（`217 / 304 / 422`），失败点与错误文案完全相同：

```text
✔ GET /admin/audit-logs：action/entity 闭集与契约、库内写入点一致 (7.4996ms)
✔ GET /admin/audit-logs：权限矩阵（无会话 401 / 用户会话 403 / 缺 scope 403，均零端口调用） (2.9248ms)
✔ GET /admin/audit-logs：未接线 ⇒ 503 PROVIDER_UNAVAILABLE（不伪造空页） (0.4011ms)
✔ GET /admin/audit-logs：分页边界（limit 缺省 20、上限 50、越界 400、next_cursor 往返） (2.5978ms)
✔ GET /admin/audit-logs：同毫秒不同微秒 ⇒ 游标位置必须保留微秒（不得按毫秒截断） (1.0822ms)
✔ GET /admin/audit-logs：筛选组合（action/entity/from/to 下传、未知值 400、from>to 400、游标绑定筛选） (5.3613ms)
✔ GET /admin/audit-logs：游标完整性（跨用户、过期、篡改、位置不可解析一律 INVALID_CURSOR） (0.6966ms)
✔ GET /admin/audit-logs：权限矩阵、筛选组合、分页边界与脱敏 (0.7407ms)
✖ GET /admin/audit-logs：读数按 action 分派（admin_scope.grant 如实 null，set_flag 仍严格） (0.6015ms)
✔ GET /admin/audit-logs：PG 适配器（参数化 SQL、limit+1 判 hasMore、行投影） (0.6013ms)
ℹ tests 10
ℹ pass 9
ℹ fail 1
ℹ duration_ms 299.9747

✖ failing tests:

test at tests\unit\admin-audit-logs.test.mjs（原文第 460 行，补用例后移到第 548 行）
✖ GET /admin/audit-logs：读数按 action 分派（admin_scope.grant 如实 null，set_flag 仍严格） (0.6015ms)
  Error [ApiError]: 审计日志的读数形状不符
      at toFlagReading (…/services/api/src/admin/audit/pg.ts:196:11)
      at toAuditLogReading (…/services/api/src/admin/audit/pg.ts:217:10)
      at toAuditLogRow (…/services/api/src/admin/audit/pg.ts:304:19)
      at …/services/api/src/admin/audit/pg.ts:422:34
      at Array.map (<anonymous>)
      at Object.listAuditLogs (…/services/api/src/admin/audit/pg.ts:422:21)
      at async Object.listAuditLogs (…/services/api/src/admin/audit/service.ts:230:18)
      at async TestContext.<anonymous> (…/tests/unit/admin-audit-logs.test.mjs 该例断言处) {
    code: 'PROVIDER_UNAVAILABLE',
    retryable: false,
    details: [],
    retryAfterSeconds: null
  }
```

## 5. 改后绿（原文）

### 5.1 单测

```text
✔ GET /admin/audit-logs：读数按 action 分派（admin_scope.grant 如实 null，set_flag 仍严格） (1.2362ms)
ℹ tests 10
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 264.8846
```

### 5.2 真库臂（自起临时集群，PG 17.11）

命令（PowerShell）：

```powershell
$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'
$env:GY_R34_PG_ROOT='E:\GengYunCommander\.pg17\tmp\r67-p0-arm'
node tests/integration/admin-audit-logs-pg.mjs
```

```text
· 临时集群：E:\GengYunCommander\.pg17\tmp\r67-p0-arm\gy-r34-audit-logs-pg-55436-e959ad，端口 55436（仅 127.0.0.1）
· server_version = 17.11
✓ 迁移 0047 经 migrate.ts up 落到真库（schema_migrations 末项 0047）
✓ 部署授权段 gy-r34-audit-logs-grant 原样执行通过（存在性检查 + REVOKE PUBLIC + GRANT 运行时）
✓ 造数 6 行（三写入点形状 + 键集并列 + 时间窗外 + target_ref 夹带多余键）
✓ 权限：运行时零表级 SELECT、函数 EXECUTE 已授予、未授权角色被拒（负向对照）
✓ 运行时直查表被数据库拒（SQLSTATE 42501），读面只能走函数
✓ 条数与顺序：6 行，created_at DESC + id DESC（并列组 id 大者在前）
✓ 键集翻页：3 页收全 6 行，顺序一致、无重复、末页 next_cursor 为 null
✓ 时间区间：from 排除窗口外 1 行（5 行），from+to 闭区间取到 2 行
✓ 事件类型：action=account.suspend 取 1 行；entity=flag 取 3 行、entity=account 取 3 行
✓ 脱敏：target_ref 只留 type/id/revision；无 ip / user_agent / 凭据字段；actor_id 映射为 actor
✓ 同毫秒不同微秒：微秒位置翻页收全 3 行；毫秒位置复现漏行（下一页 0 行），微秒位置取回 a002
· 规模：表内 20009 行（含 9 行夹具：6 行基础夹具 + 3 行同毫秒不同微秒）
· 首页无筛选：8.33ms，plan=Function Scan
· action 过滤（约 2%）：3.00ms，plan=Function Scan
· 深翻页（键集，第 200 页）：2.46ms，plan=Function Scan
✓ 7a) 不过滤列表 200，0041 形状的 admin_scope.grant 行在结果里，before_value/after_value 均为 null，其余字段原样
✓ 7b) ?action=admin_scope.grant 精确取回该行（仅 1 行，无 scope 收窄），读数仍为 null
✓ 7c) 同一次查询 9 行顺序不变；set_flag 行仍带 {enabled:false,revision:3} / {enabled:true,revision:4}，grant 行仍为 null
✓ 7d) 总行数 20010；时间窗 limit=2 恰好 5 页收全 9 行、无重复、顺序与全量一致；全表首页与第二页游标正确
✓ P0 回归：0041 形状的 admin_scope.grant 行整页 200、读数为 null、?action 精确命中；同查询 set_flag 读数仍在；总行数与游标不变
真库臂 PASS：读通道的 SQL、权限、键集、筛选、脱敏全部在真 PG 17.11 上取得读数。
```

`ARM_EXIT=0`。注意 `· 规模：表内 20009 行` 是**造完基础夹具后**的口径（第 7 段之前的既有读数），
第 7 段自己 INSERT 的 `admin_scope.grant` 行随后把总数推到 **20010**（7d 断言的值），两处数字不矛盾。

### 5.3 tsc

`npm run build --workspace @gengyun/api` ⇒ `BUILD_EXIT=0`（上一片就是漏了这一步被 CI 抓红）。

### 5.4 验证顺序（实际过程，按时间序）

这份页子不是先改代码再补测试，而是**先让红出现，再让它消失**，每一步都留了原文：

| # | 动作 | 结果 | 原文在哪 |
| --- | --- | --- | --- |
| 1 | 只写新单测（`admin_scope.grant` 行 + `set_flag` 行同查询），**不动** `pg.ts` | **红**：`审计日志的读数形状不符`，改前版本第 142 → 231 → 349 行，`tests 10 / pass 9 / fail 1` | §4.1 |
| 2 | 加 `AuditReadingKind` / `AUDIT_READING_KIND` / `readingKindOf` + `toAuditLogReading(raw, action)` 分派，改两处调用点 | **绿**：`tests 10 / pass 10 / fail 0` | §5.1 |
| 3 | `tsc`：`npm run build --workspace @gengyun/api` | **0** | §5.3 |
| 4 | 真库臂（含新第 7 段：0041 形状 INSERT + 7a/7b/7c/7d） | **PASS**，`ARM_EXIT=0` | §5.2 |
| 5 | **负控制（第一轮）**：把分派剥成 `void action; return toFlagReading(raw);`，再跑真库臂 | **红**：`真库臂 FAIL： 审计日志的读数形状不符`，失败点第 7a 段，`NEG_ARM_EXIT=1` | §6.2 |
| 6 | 还原分派：`Get-FileHash` 与补丁前逐位一致（`2876E97…2C4B`），`grep 负控制` 0 命中 | 一致 | §6.2 |
| 7 | 还原后复跑真库臂 | **绿** | §5.2 |
| 8 | 另把同一份「剥分派」补丁跑一次**单测**，取一份带新行号的复现红（`217/304/422`） | **红**，同一失败点 | §4.2 |
| 9 | 补双向钉子（`Object.keys(AUDIT_READING_KIND)` vs `AUDIT_ACTIONS`）+ `pg.ts` 导出 | **绿**：`tests 11 / pass 11` | §8.1 |
| 10 | 全量 `npm run test:unit`（`GY_BASH` 已设，且**删掉 `services/api/dist/`** 后跑） | **绿**：`tests 5160 / pass 5157 / fail 0`，exit 0 | §8.1 |
| 11 | **负控制（第二轮）**：在**已提交字节**上再剥一次分派，跑真库臂 | **红**：同一文案、同一 7a 失败点，`NEG2_EXIT=1` | §6.1 |
| 12 | 还原：SHA256 回到 `1FE99E74…2E63A`（与补丁前逐位一致），`grep` 0 命中，`git status` 干净 | 一致 | §6.1 |

> 注：评审口述里曾提到「字面量 → Record → `withReadingKind` → 剥分派」四步；本片**没有** `withReadingKind`
> 这一步（那是评审的草稿，不是代码现状）。上表是按 `git`/命令时间序复原的真实过程，不为了对齐口述编步骤。

## 6. 负控制（必须红，原文）

把分派**临时改回**「无条件按开关解码」（`void action; return toFlagReading(raw);`），跑同一条真库臂命令。
一共做了两轮：第一轮在代码定型前（补导出与钉子之前），第二轮在**提交前的最终字节**上——
后者才是这份页子实际担保的那份文件的负控制，**以 §6.1 为准**。

### 6.1 第二轮：对已提交字节做（权威读数）

替换 `services/api/src/admin/audit/pg.ts:234-235` 两行为：

```text
  // 负控制（临时，跑完立刻还原）：无条件按开关读数严格解码 = 改前的缺陷形态。
  void action;
  return toFlagReading(raw);
```

真库臂原文（全量日志 `$env:TEMP\gy-r67-neg2.log`）：

```text
  · 规模：表内 20009 行（含 9 行夹具：6 行基础夹具 + 3 行同毫秒不同微秒）
  · 首页无筛选：12.37ms，plan=Function Scan
  · action 过滤（约 2%）：3.77ms，plan=Function Scan
  · 深翻页（键集，第 200 页）：3.45ms，plan=Function Scan
node : 真库臂 FAIL： 审计日志的读数形状不符
ApiError: 审计日志的读数形状不符
    at toFlagReading (file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/pg.ts:199:11)
    at toAuditLogReading (file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/pg.ts:221:10)
    at toAuditLogRow (file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/pg.ts:308:19)
    at file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/pg.ts:426:34
    at Array.map (<anonymous>)
    at Object.listAuditLogs (file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/pg.ts:426:21)
    at async Object.listAuditLogs (file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/service.ts:230:18)
    at async main (file:///E:/GengYunCommander/wt-r67-p0-audit-shape/tests/integration/admin-audit-logs-pg.mjs:666:24)
    at async file:///E:/GengYunCommander/wt-r67-p0-audit-shape/tests/integration/admin-audit-logs-pg.mjs:778:3
NEG2_EXIT=1
```

- 失败点仍是**第 7a 段**（`tests/integration/admin-audit-logs-pg.mjs:666`，不过滤列表），前 1–6 段已全部跑过
  （EXPLAIN 三行读数已打印）⇒ 红的是这条 P0 回归钉子本身，不是别的用例。
- 错误码/文案与缺陷现场一致：`PROVIDER_UNAVAILABLE` / `审计日志的读数形状不符`。
- 还原一致性：撤销补丁后 `Get-FileHash -Algorithm SHA256` ＝
  `1FE99E74F8E0D9AD4EF05FDA8A960CE8CEC7413E8835CA6A834C233B7BD2E63A`，与补丁**前**读数逐位相同；
  `grep -E '负控制|void action'` 在 `pg.ts` **0 命中**；`git status --short` 空（与提交 `65302451` 的内容一致）。
  这份字节**为绿**的读数由 §5.2 那次臂承担（同字节，`ARM_EXIT=0`）。
- 收尾：这一轮 `pg_ctl` 停止时句柄滞留，臂脚本报「⚠ 临时集群目录未能删除（句柄滞留，不影响读数）」；
  事后按绝对路径核验目录/`postmaster.pid`（PID 64656、port 55436、data dir 一致）后
  `pg_ctl -D … -m immediate -w stop` ⇒ `waiting for server to shut down.... done` / `server stopped`，
  `postgres` 进程计数 0，再 `Remove-Item` 删目录；`GY_R34_PG_ROOT` 下只剩 `gy-r34-audit-logs-pg-tools.log`。

### 6.2 第一轮：定型前（同样红，行号整体小 3）

补丁前 `pg.ts` SHA256 ＝ `2876E9736775E959108B282345CC6A88AEE33146BDE9DC89490D1CA474262C4B`
（当时还没有导出 `AUDIT_READING_KIND` 与那 3 行注释），原文：

```text
node : 真库臂 FAIL： 审计日志的读数形状不符
ApiError: 审计日志的读数形状不符
    at toFlagReading (file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/pg.ts:196:11)
    at toAuditLogReading (file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/pg.ts:218:10)
    at toAuditLogRow (file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/pg.ts:305:19)
    at file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/pg.ts:423:34
    at Array.map (<anonymous>)
    at Object.listAuditLogs (file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/pg.ts:423:21)
    at async Object.listAuditLogs (file:///E:/GengYunCommander/wt-r67-p0-audit-shape/services/api/src/admin/audit/service.ts:230:18)
    at async main (file:///E:/GengYunCommander/wt-r67-p0-audit-shape/tests/integration/admin-audit-logs-pg.mjs:666:24)
    at async file:///E:/GengYunCommander/wt-r67-p0-audit-shape/tests/integration/admin-audit-logs-pg.mjs:774:3
NEG_ARM_EXIT=1
```

还原后 SHA256 逐位回到 `2876E97…2C4B`，`grep 负控制` 0 命中，复跑真库臂再次全绿（`ARM_EXIT=0`）。


## 7. 覆盖边界：哪些 action 的 `before_value` / `after_value` 今天仍不暴露

| action | 库里今天写的读数 | 读面今天返回 | 说明 |
| --- | --- | --- | --- |
| `set_flag` | `{enabled, revision}`（`services/api/db/migrations/0027_*.sql:144-145`） | **`FlagReading`**（严格校验，形状不符仍 503） | 契约唯一能表达的形状 |
| `admin_scope.grant` / `admin_scope.revoke` | `{scopes, reason}`（`services/api/db/migrations/0041_admin_scope_write_authority.sql:326-327` / `:479-480`） | `null` | **本片修的正是这条**：不 503，但也**不暴露**（`FlagReading` 装不下，塞进去会被契约镜像拒） |
| `account.suspend` / `account.restore`（0017）、`job.cancel`（0043）、`admin_scope.deny`（0046）、`post.hide`（0047） | `NULL` | `null` | 与改前一致；`post.hide` 还不在 `AUDIT_ACTIONS` 闭集里，`readingKindOf` 走 `?? 'unexposed'` |

因此本片的**收益**是「不再整页 503、其余审计事实可见」，**不是**「`{scopes, reason}` 读得出来了」。
把 `scopes` / `reason` 真正暴露出去需要**契约扩展**（`AuditEvent.before_value` / `after_value` 新增一种读数形状，
并同步 `packages/contracts/**` 镜像、后台 UI 列），属后续片；本片刻意不动 `packages/contracts/**`。

其他边界：

- 只覆盖**读面**。写入侧今天的形状（0041 写 `{scopes, reason}`）保持不变。
- 新增形状出现时（例如未来某个迁移写 `{foo: 1}`）**不会**报错而是静默 `null`：这是有意的取舍
  （宁可不显示读数，也不藏掉整页），代价是「库里有、界面没有」的差异只能靠 §7 表与契约扩展片发现。
- `deploy/postgres-cvm/sql/30-bootstrap-admin.sql:209` 与 `deploy/postgres-cvm/verify-cvm-postgres.sh:407`
  的注释仍在描述**旧行为**（「`toAuditLogReading()` 遇到 `{"scopes": …}` 会抛 PROVIDER_UNAVAILABLE ⇒ 整页 503」）；
  它们现在**已陈旧**，但 `deploy/**` 属本片禁改范围 ⇒ 只在此登记，留给 deploy 侧跟进。

### 7.1 `AUDIT_ACTIONS` 增到第 8 值时补一行（已在本片完成，且被 CI 亲眼验证过）

提交时的父提交是 `b1d02c21`，其 `AUDIT_ACTIONS` 是 **7 值**（`services/api/src/admin/audit/catalog.ts:77-85`）；
写这份页子期间监工先合了 #658 与 #659，`main` 前进到 `be8c7880`，闭集变成 **8 值**（第 8 值 `post.hide`）。

事后的真实顺序（可作为「牙齿是否有效」的现成证据）：

1. 按 7 值写的 PR 一开，CI 的 `build` / `static-check` / `contract-tests` 立刻红，原文：
   `src/admin/audit/pg.ts(99,14): error TS2741: Property '"post.hide"' is missing in type 'Readonly<{ … }>' but required in type 'Readonly<Record<… | "post.hide" | …, AuditReadingKind>>'`
   ⇒ `Record<AdminAuditAction, …>` 的编译期牙齿按设计咬住了「新增动作忘声明」。
2. 于是把本片 `git rebase --onto be8c7880 b1d02c21`（无冲突），补两处：
   - `import { …, AUDIT_ACTION_POST_HIDE, … } from './catalog.ts'`；
   - `AUDIT_READING_KIND` 末尾 `[AUDIT_ACTION_POST_HIDE]: 'unexposed',`（与 `AUDIT_ACTIONS` 顺序一致，`:100-108`）。
3. 同时把「多一个闭集外的键」那条牙齿的替身从 `post.hide` 换成尚未进闭集的 `post.approve`
   （`tests/unit/admin-audit-logs.test.mjs:645-659`），否则这条负向断言会因为 `post.hide` 转正而变成自欺。
4. 复跑：单测 11/11、`npm run build --workspace @gengyun/api` 0、`verify-contract-status` PASS。

⇒ 结论：这一条不是「将来要注意」，而是**已经发生并被两个方向（tsc + 运行时钉子）同时抓住**的记录。

## 8. 门禁读数

### 8.1 全部门禁逐条

| 门禁 | 命令 | 读数 |
| --- | --- | --- |
| TS 构建 | `npm run build --workspace @gengyun/api` | **0**（`BUILD_EXIT=0`） |
| 主单测 | `node --test tests/unit/admin-audit-logs.test.mjs` | `tests 11 / pass 11 / fail 0`，exit **0**（10 条旧 + 「读数按 action 分派」+「读数表与闭集逐项相等」） |
| 既有钉子① | `node --test tests/unit/ai-ops-ledger-pins.test.mjs` | `tests 5 / pass 5 / fail 0`，exit **0** |
| 既有钉子② | `node --test tests/unit/admin-ui-audit-logs.test.mjs` | `tests 19 / pass 19 / fail 0`，exit **0** |
| 既有钉子③ | `node --test tests/unit/admin-audit-action-jobs-cancel.test.mjs` | `tests 7 / pass 7 / fail 0`，exit **0** |
| 真库臂 | `node tests/integration/admin-audit-logs-pg.mjs`（`GY_PG_BIN`/`GY_R34_PG_ROOT`） | **PASS**，`ARM_EXIT=0`（PG 17.11） |
| 负控制 | 同上（分派临时改回无条件严格），两轮 | **FAIL**，`NEG_ARM_EXIT=1`（定型前）/ `NEG2_EXIT=1`（已提交字节）（§6） |
| 契约台账 | `node tools/verify-contract-status.mjs` | 先 **1**（锚点漂移）→ reanchor → **0**（见 §8.3） |
| 文档锚点 | `node tools/verify-doc-anchors.mjs --strict --scan docs` | **0**（基线外新增 0 条） |
| 路由对账 | `node tools/openapi-route-parity.mjs` | **0**（`extra`/`missing`/`ledgerDrift` 均空） |
| 迁移唯一性 | `node tools/verify-migrations-unique.mjs` | **0**（5 项判据全过；45 条配对 + 1 条登记缺省） |
| 契约校验 | `python tools/validate_contracts.py` | **0**（124 operations；契约一致性 / 29 fixtures / 30 media traces / 8 roundtrips） |
| 开发文档 | `python tools/validate_development_docs.py` | **0**（27 initial tasks；依赖无环；F/AC/Q 完整） |
| 全量单测 | `npm run test:unit`（`GY_BASH=C:\msys64\usr\bin\bash.exe`） | **0**：`tests 5160 / pass 5157 / fail 0 / skipped 1 / todo 2`（跑之前必须删掉 `services/api/dist/`，见 §8.4） |

文档锚点读数明细（本页加入**后**）：

```text
SCAN: 文档 364 份；抽出「路径:行号」引用 5768 条（解析成功 5545 条、同名多文件无法唯一解析 213 条不计红、同文档重复 8 条已去重）
COUNT: BROKEN 4 / OUT_OF_RANGE 2 / SUSPECT 7（合计 13 条；另只计数不判红：区间首行为空行 106 条、区间全是注释行 767 条）
BASELINE: tools/doc-anchors-baseline.json 登记 13 条；本次命中 13 条、基线外新增 0 条、陈旧 0 条
MODE: --strict（只在新增加非零时 exit 1）
PASS: --strict 下没有基线之外的新增（基线内条目只计数、不判红；陈旧条目见 STALE）
```

`SCAN:` 与 `COUNT:` 是**全仓累计值**，随提交单调变化；要钉的是「同一提交上 exit 0」。本页加入前
（同一棵树、未含本页）为 `文档 363 份 / 引用 5730 条`，加入后为 `364 份 / 5768 条`：份数 **+1** 即本页，
条数 **+38** 是本页新增的引用 —— `BROKEN / OUT_OF_RANGE / SUSPECT` 三项合计仍然是基线里那 13 条，
**基线外新增 0 条**，所以 `--strict` 仍 exit 0。

### 8.2 python 门禁的解释器

`python` 在 PATH 上：`C:\msys64\ucrt64\bin\python.exe`（Real path，非 WSL 存根），两条 python 门禁都真的跑了。

### 8.3 契约台账：先红后绿（原文）

首次跑 `node tools/verify-contract-status.mjs` ⇒ exit **1**：

```text
ERROR: 语义错误 · listAuditLogs: services/api/src/admin/audit/pg.ts:305-305
的锚点「createPostgresAdminAuditLogPort」不在引用行范围内（容差 ±2 行；实际出现在第 378 行）
FAIL: 契约实现状态对照校验未通过（1 项）[形状错误 0 / 语义错误 1 / 表格漂移 0]
```

按 `AGENTS.md` 的标准流程走 `--reanchor`（dry-run，只报不改）→ 确认只有 1 条候选、只是行号漂移
（旧 `305-305` → 新 `378-429`）→ `--reanchor --write-doc` 落盘 → 复跑 exit **0**：

```text
PASS: 语义可核 106 条区间 + 2 条片段
PASS: 中文表格一致
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。
```

落盘 diff 只有两行（`docs/architecture/contract-status.json:3643` 的 `"lines"` 与
`docs/architecture/contract-implementation-status.md:166` 表格里那一段引用），无状态/结论改动：

```diff
-          "lines": "305-305"
+          "lines": "378-429"
```

### 8.4 一个容易踩的顺序坑：`services/api/dist/` 会让全量单测红 1 条

第一次跑全量单测时树上有 `npm run build` 留下的 `services/api/dist/**`（480 个文件，`.gitignore:22` 已忽略），
结果 `tests/moderation/model-ports.test.mjs:183` 红：

```text
actual: [ '\\services\\api\\dist\\moderation\\callback.js :: MODEL_VERDICT_LABELS',
          '\\services\\api\\dist\\moderation\\decisions.js :: requiredModelPortKinds',
          '\\services\\api\\dist\\moderation\\provider.js :: MODEL_PORT_SEAMS,validateModelPort',
          '\\services\\api\\dist\\moderation\\service.js :: mergeModeration,checkMergedInvariant,…' ],
expected: []
```

原因：那条钉子扫 `services/` `apps/` `miniprogram/` `tools/` 下的 `.js/.ts/.mjs/.cjs`，受信清单只列
`services/api/src/moderation/*.ts` 六个文件；编译产物 `dist/moderation/*.js` 自然命中。**与本片改动无关**
（改前同样会发生）⇒ 正确顺序是「先 `npm run build` 收 tsc 读数，再删 `dist/`，最后跑全量单测」。
删掉 `dist/` 后复跑：`tests 5160 / pass 5157 / fail 0`，exit **0**。

## 9. 未取得

- **生产库真实数据量下的表现未测**：真库臂的表内规模是 20010 行（夹具 + 批量造数），EXPLAIN 显示三处查询都是
  `Function Scan`（`list_admin_audit_logs()` 是 SQL 函数，读面不直接扫表）；更大量级的耗时/内存未取得。
- **后台 UI 的呈现未验**：`apps/admin/**` 的审计页不在本片范围（本片只动 `services/api` + 两份测试），
  「非开关行读数显示为空」在界面上的实际观感未取得。
- **`{scopes, reason}` 的正确读法未定义**：本片只保证「不再 503」，`scopes`/`reason` 该怎么进契约、怎么渲染，
  属于「契约扩展」片，**未取得**。
- **`deploy/**` 两处陈旧注释未修**（`deploy/postgres-cvm/sql/30-bootstrap-admin.sql:209`、
  `deploy/postgres-cvm/verify-cvm-postgres.sh:407`）：属禁改范围，**未取得**。
- **一次全绿的整体树**：本片只保证「同一棵树上 13 道门禁逐条 exit 0 + 真库臂 PASS + 负控制红」，
  没有在**干净 clone** 上重跑一遍（仓外报告里的读数都来自本工作树）。

## 10. 复现

```powershell
# 0. 工作树与基线
git -C E:\GengYunCommander\wt-r67-p0-audit-shape status --short   # 应只有本片 5 个改动文件

# 1. 构建（tsc 必须 0）
npm run build --workspace @gengyun/api

# 2. 单测（改后应 11/11）
node --test tests/unit/admin-audit-logs.test.mjs
node --test tests/unit/ai-ops-ledger-pins.test.mjs
node --test tests/unit/admin-ui-audit-logs.test.mjs
node --test tests/unit/admin-audit-action-jobs-cancel.test.mjs

# 3. 真库臂（自起临时集群；跑完请 pg_ctl stop 并删目录）
$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'
$env:GY_R34_PG_ROOT='E:\GengYunCommander\.pg17\tmp\r67-p0-arm'
node tests/integration/admin-audit-logs-pg.mjs

# 4. 负控制：把 services/api/src/admin/audit/pg.ts 的 toAuditLogReading 临时改成
#    void action; return toFlagReading(raw); 再跑第 3 步 ⇒ 必须红在「审计日志的读数形状不符」
#    还原后 Get-FileHash -Algorithm SHA256 必须等于
#    1FE99E74F8E0D9AD4EF05FDA8A960CE8CEC7413E8835CA6A834C233B7BD2E63A
#    （跑完确认 postgres 进程计数为 0 并删除临时集群目录）

# 5. 静态门禁
node tools/verify-contract-status.mjs
node tools/verify-doc-anchors.mjs --strict --scan docs
node tools/openapi-route-parity.mjs
node tools/verify-migrations-unique.mjs
python tools/validate_contracts.py
python tools/validate_development_docs.py

# 6. 全量单测：先删 build 产物，否则 tests/moderation/model-ports.test.mjs 会命中 dist/（见 §8.4）
Remove-Item -Recurse -Force services/api/dist
$env:GY_BASH='C:\msys64\usr\bin\bash.exe'
npm run test:unit
```
