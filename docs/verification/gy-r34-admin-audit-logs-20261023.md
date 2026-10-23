# GY-R34 后台审计日志只读查询接口（`GET /admin/audit-logs`）（2026-10-23）

> 基线：`upstream/main` = `af0fb36e87dc0a32597ed719a0cfc95267392909`（开工时 `git rev-parse upstream/main` 实测）。
> 分支：`feat/gy-admin-audit-query`；工作树：`E:\GengYunCommander\.pg17\wt-gy-admin-audit-query`。
> `Refs #18` —— **本页不构成 `#18` 完成**（见 §9：审计写面仍未落库，库里只有三个写入点）。

## 0 摘要

1. **本片无对应 issue**：`gh issue list --state open` 只有 `#4`–`#29` 的「初版 GY-Ixx」里程碑，全量标题过滤 `审计|audit` 零命中；`docs/` 台账里也没有审计查询切片。最相关的是 `#18`（独立后台资料/账号/AI 任务/功能开关），其真库臂在 `.pg17/STATE-current.md` 里记着「库内审计未取得：`appendAudit` 仍进程内，real 下 `GET /admin/audit-events` 实测 503」。本片按派单范围自做，并在提交信息里 `Refs #18`。
2. **新增一条只读路由**：`GET /api/v1/admin/audit-logs`，`operationId = listAuditLogs`，`x-scope = audit:read`（复用 `listAuditEvents` 同一把门，未新造权限体系），`x-version-required = false`。
3. **零新增契约 schema**：200 复用既有 `AuditEventPageEnvelope`（`data.items[] = AuditEvent`，与 `/admin/audit-events` 同形，前端可共用一个渲染器），故 `packages/contracts/examples.json` 无需改动。
4. **读路径走库内只读函数**：迁移 `0033_admin_audit_log_read.sql` 建 `public.list_admin_audit_logs(...)`（`SECURITY DEFINER` + 固定 `search_path`），因为 0017 裁定运行时对 `public.admin_audit_events` 零表级权限；`deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r34-audit-logs-grant` 段把 EXECUTE 只授给 `gengyun_api_runtime`。
5. **分页是键集游标**（`(created_at, id) < (…, …)`，`ORDER BY created_at DESC, id DESC`），不提供深 `offset`；游标把「筛选组合 + 管理员主体 + 15 分钟过期」都绑进 HMAC，改筛选或用别人的游标一律 `INVALID_CURSOR`。
6. **枚举闭集来自既有写入点**：`action ∈ {account.suspend, account.restore, set_flag}`、`entity ∈ {account, flag}`（映射 `scope` 列 `accounts:suspend` / `flags:write`）。未知取值 **400 `INVALID_REQUEST`**，不静默返回空页。
7. **脱敏**：出口按允许列表投影，`target_ref` 只留 `type` / `id` / `revision`；`actor_id` 映射为契约字段 `actor`。表里**没有** `ip` / `user_agent` / 任何凭据列，故响应形状不含它们（不是「有意隐去」，是本来就没有）。
8. **未新增索引**：0033 的迁移**不含** `CREATE INDEX`，理由与真实数据量读数见 §7（20006 行上三种查询形状都是 `Function Scan`）。
9. **读数**：单测 8/8、三个受影响的既有后台用例 11/11、真库臂 PASS（PG 17.11，端口 55434）、`tsc --noEmit` exit 0、`verify-contract-status.mjs` exit 0、`verify-doc-anchors.mjs --strict` exit 0、`validate_contracts.py` `PASS: 114 operations`、`verify-migrations-unique.mjs --strict` 5 项全满足。

## 1 与既有两个审计读面的差异（为什么不复用它们）

| 读面 | 数据来源 | 分页 | 能否查账号类事件 | 缺口 |
| --- | --- | --- | --- | --- |
| `GET /admin/audit-events`（`listAuditEvents`） | 进程内 store 的 `audit.list()` | HMAC 覆盖「可见集合 id 序列」的游标 | 只能看进程内记忆 | real 模式未接真实持久层 ⇒ 实测 503；重启即丢 |
| `GET /admin/flag-audit-events`（`listFlagAuditEvents`） | 迁移 0027 的 `public.list_admin_flag_audit()` | 键集 | **不能**（函数把 `action='set_flag'` 写死） | 只覆盖开关变更 |
| **`GET /admin/audit-logs`（`listAuditLogs`，本片）** | 迁移 0033 的 `public.list_admin_audit_logs()` | 键集 | 能（`account.suspend` / `account.restore`） | 写入面仍只有三个库内函数（§9） |

## 2 路由契约

| 项 | 值 |
| --- | --- |
| 方法 / 路径 | `GET /api/v1/admin/audit-logs` |
| `operationId` | `listAuditLogs` |
| 后台 scope | `audit:read` |
| 鉴权 | `guards.requireAdmin`（后台会话）+ `guards.requireScope('audit:read')` |
| 版本前置 | `x-version-required: false`（读面，不需 `If-Match`） |
| 查询参数 | `limit`（1–50，默认 20，超限 400）· `cursor`（不透明串，≤2048 字符）· `from` / `to`（RFC 3339 `date-time`，闭区间）· `action`（闭集 3 值）· `entity`（闭集 2 值） |
| 200 响应体 | `AuditEventPageEnvelope` = `{data: {items: AuditEvent[], next_cursor: string \| null}, meta: {request_id, contract_version, execution_mode}}` |
| 200 响应头 | `Cache-Control: no-store`（列表不发 `ETag`） |
| 错误 | 400 `INVALID_REQUEST`（参数形状/枚举/顺序）· 401 `SESSION_REQUIRED` · 403 `SCOPE_DENIED` · 409/428 同既有错误表 · 429 · 503 `PROVIDER_UNAVAILABLE`（未接线/读失败/行不符契约） |
| 幂等 | 不适用（`GET`，无 `Idempotency-Key`） |
| 条目形状 | 既有 `AuditEvent`：`id, action, scope, target_ref, reason_code, request_id, result, created_at` 必填；`actor, target_hint, before_value, after_value` 可空 |

`limit` 上限取 **50** 而不是派单里的 100 的原因：契约校验器 `tools/validate_contracts.py` 对「带 `cursor` 的操作」有硬判据 `Unbounded pagination`——`limit` 的 `maximum` 必须是 50，且仓内 24 个分页操作全部复用同一个 `Limit` 参数。取 50 仍在「≤100」的上界之内。

## 3 示例请求与响应

```bash
curl -sS -X GET \
  'https://<host>/api/v1/admin/audit-logs?limit=2&action=account.suspend&from=2026-10-20T00:00:00Z&to=2026-10-23T00:00:00Z' \
  -H 'Authorization: Bearer <后台会话令牌>'
```

```json
{
  "data": {
    "items": [
      {
        "id": "00111111-1111-4111-8111-111111111111",
        "action": "account.suspend",
        "scope": "accounts:suspend",
        "target_ref": null,
        "reason_code": "account_suspended",
        "request_id": "99999999-9999-4999-8999-999999999999",
        "result": "accepted",
        "created_at": "2026-10-20T10:00:00.000Z",
        "actor": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "target_hint": "account:1234",
        "before_value": null,
        "after_value": null
      }
    ],
    "next_cursor": "eyJraW5kIjoiYXVkaXQiLCJzdWJqZWN0Ijoi….<hmac>"
  },
  "meta": {
    "request_id": "ffffffff-ffff-4fff-8fff-ffffffffffff",
    "contract_version": "1.0.0",
    "execution_mode": "real"
  }
}
```

翻下一页：把 `next_cursor` 原样回传，**其余查询参数一个都不能改**（改了就 `INVALID_CURSOR`：`筛选条件已变化，请从第一页重新开始`）。

| 场景 | 请求 | 结果 |
| --- | --- | --- |
| 首页 | `GET /admin/audit-logs` | 200，默认 `limit=20`，`items` 按 `created_at DESC, id DESC` |
| 第二页 | `GET /admin/audit-logs?limit=2&cursor=<next_cursor>` | 200，与首页无重叠 |
| 末页 | 同上，最后一页 | 200，`next_cursor: null` |
| 时间区间 | `?from=2026-10-20T00:00:00Z&to=2026-10-21T00:00:00Z` | 200，闭区间（含两端） |
| 事件类型 | `?action=set_flag` / `?entity=flag` | 200，等价筛选（`entity` 映射 `scope` 列） |
| 未知枚举 | `?action=account.delete` | 400 `INVALID_REQUEST`，`details: [{field: "action", code: "enum"}]` |
| 时间格式错 | `?from=2026-10-20 10:00:00` | 400，`details: [{field: "from", code: "format"}]` |
| 区间颠倒 | `?from=2026-10-21T00:00:00Z&to=2026-10-20T00:00:00Z` | 400，`details: [{field: "from", code: "order"}]` |
| 超限 | `?limit=51` | 400，`details: [{field: "limit", code: "maximum"}]` |
| 无 scope | 令牌只有 `flags:read` | 403 `SCOPE_DENIED`，`message` 含 `audit:read`，**不含任何「有无该记录」的信息** |
| 用户会话 | 用普通用户令牌调后台接口 | 403 `SCOPE_DENIED`（后台接口不接受用户会话） |
| 无令牌 | — | 401 `SESSION_REQUIRED` |
| 未接线 | real 下 `pool === null` | 503 `PROVIDER_UNAVAILABLE`，**不返回空页**（空页会被读成「平台从未发生审计事件」） |

## 4 权限矩阵（单测与真库臂都钉住）

| 调用方 | scope | HTTP | 错误码 | 是否触达数据库 |
| --- | --- | --- | --- | --- |
| 无会话 | — | 401 | `SESSION_REQUIRED` | 否（`port.calls.length === 0`） |
| 用户角色会话 | 任意 | 403 | `SCOPE_DENIED`（`后台接口不接受用户会话`） | 否 |
| 管理员 | `flags:read` 等非本 scope | 403 | `SCOPE_DENIED`（`缺少所需权限：audit:read`） | 否 |
| 管理员 | `audit:read` | 200 | — | 是 |
| 运行时角色直查表 | — | — | PG `42501`（`permission denied for table admin_audit_events`） | — |
| 运行时角色调函数 | — | — | 允许（EXECUTE 已授予） | — |
| 未授权角色调函数 | — | — | PG `42501`（负向对照） | — |

## 5 筛选、分页与排序语义

- **排序**：`ORDER BY created_at DESC, id DESC`。同一毫秒写入的多行靠 `id DESC` 定序，翻页不会重复或漏行（真库臂专门造了两行同一 `created_at` 的并列组）。
- **键集条件**：`(e.created_at, e.id) < (p_before_created_at, p_before_id)`，行比较而非字符串比较；`p_before_*` 任一为 `NULL` 时退化为「第一页」。
- **游标载荷**：`{kind:'audit', subject:<管理员 id>, family:'audit_logs', after:'<created_at>|<id>', watermark:Hmac([from,to,action,entity]), expires:now+15min}`，整体 `<base64url(json)>.<HMAC-SHA256>`。四道校验依次是：签名 → 归属（`subject`）→ 过期 → `watermark`（筛选未变）。
- **`limit` 取 `limit + 1` 行**判 `hasMore`，因此「末页 `next_cursor: null`」不需要额外 `COUNT(*)`。
- **`from`/`to` 为标准化的 UTC**：入参接受任意带偏移的 RFC 3339，服务端统一 `new Date(raw).toISOString()` 后下传。

## 6 脱敏与投影（允许列表，不是黑名单）

| 层 | 做法 |
| --- | --- |
| 函数 | 返回列逐项列出；`target_ref` 用 `jsonb_build_object('type', …, 'id', …, 'revision', …)` 重建，其他键一律不出现在结果里 |
| 适配器 | `toAuditLogRow` 只读 12 个字段，`actor_id → actor`；`target_ref` 再过一遍 16 值 `TARGET_REF_TYPES` 闭集 + `id` 长度 + `revision` 正整数校验，不符整页 503（不静默丢字段） |
| 服务 | 每条过 `collectIssues('AuditEvent', item)`，整页封套再过 `collectIssues('AuditEventPageEnvelope')` |
| 表本身 | 无 `ip` / `user_agent` / 凭据列（逐列核对过 0017 与 0027 的 DDL） |

真库臂的对抗性夹具：某行 `target_ref` 里塞了 `ip: '203.0.113.7'`、`credential: 'hidden-secret'`、`user_agent: 'Mozilla/5.0 (r34 arm)'`，断言响应序列化后**不含**这三个值，且条目键恰好是契约的 12 个。

## 7 迁移 0033 与索引取舍

- 正向：`services/api/db/migrations/0033_admin_audit_log_read.sql`（建函数 + `REVOKE ALL … FROM PUBLIC`）。
- 回滚：`services/api/db/migrations/rollback/0033_admin_audit_log_read.down.sql`（只 `DROP FUNCTION`，不动表/索引/既有读函数/审计行；回滚后 HTTP 面仍 503，而不是伪造空页）。
- 授权：`deploy/postgres-cvm/sql/20-login-roles.sql` 新增 `gy-r34-audit-logs-grant` 段（存在性检查 → `REVOKE` → `GRANT EXECUTE TO gengyun_api_runtime`）；`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的函数面兜底清单补一行 `('public','list_admin_audit_logs','runtime',ARRAY['gengyun_api_runtime'])`。
- **不新增索引**：表上已有 `admin_audit_events_created_idx (created_at DESC, id DESC)`，正好是本函数的排序与键集形状。20006 行实测（`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`，owner 身份、单条 SQL 两次预热后的稳定读数）：

| 查询形状 | 计划 | 执行时间 |
| --- | --- | --- |
| 首页无筛选（`limit=20`） | `Function Scan on list_admin_audit_logs` | 14.10 ms（首跑 13.67 ms） |
| `action='account.suspend'`（约 2%） | `Function Scan` | 4.30 ms（首跑 3.56 ms） |
| 键集深翻页（第 200 页） | `Function Scan` | 4.44 ms（首跑 3.04 ms） |

  `Function Scan` 说明过滤发生在函数体内部：时间区间与键集走既有 `created_idx`，`action`/`scope` 过滤在函数内做（2 万行量级可接受）。**若未来单表过百万行且以 `action` 为主的查询变热**，再加一条 `(action, created_at DESC, id DESC)` 的**可逆**索引迁移即可；现在加只会让每次 `INSERT` 多维护一棵树，而写入点只有三个低频管理动作。这个取舍写在这里，是为了让下一步的人不必重新论证。

## 8 测试读数（全部本机实测）

| 项 | 命令 | 读数 |
| --- | --- | --- |
| 本片单测 | `node --test tests/unit/admin-audit-logs.test.mjs` | `tests 8 / pass 8 / fail 0` |
| 受影响的既有用例 | `node --test tests/unit/admin-contract-conformance.test.mjs tests/unit/admin-routes-nail.test.mjs tests/unit/admin-real-mode-fail-closed.test.mjs` | `tests 11 / pass 11 / fail 0` |
| 真库臂（PG 17.11，端口 55434） | `$env:GY_PG_BIN=…; node tests/integration/admin-audit-logs-pg.mjs` | `真库臂 PASS：读通道的 SQL、权限、键集、筛选、脱敏全部在真 PG 17.11 上取得读数`，exit 0 |
| 类型检查 | `node .\node_modules\typescript\bin\tsc -p services/api/tsconfig.json --noEmit` | exit 0（零输出） |
| 契约一致性 | `node tools/run-python.mjs tools/validate_contracts.py` | `PASS: 114 operations; contract consistency; 29 fixtures; …` |
| 契约台账/中文表 | `node tools/verify-contract-status.mjs` | exit 0（形状 0 / 语义 0 / 表格漂移 0） |
| 文档行号闸门 | `node tools/verify-doc-anchors.mjs --strict` | exit 0（基线外新增 0） |
| 迁移编号 | `node tools/verify-migrations-unique.mjs --strict` | 5 项判据全满足，exit 0 |

真库臂 SKIP 语义：没设 `GY_PG_BIN` 时打印 `SKIP` 并 exit 0——**跳过不是通过**，读数以上表那次真实运行为准。

## 9 未做项与风险

1. **写面仍未落库**：库内审计写入点只有 `suspend_account`、`restore_account`、`set_feature_flag` 三处；其余 `appendAudit` 仍落内存 ops store（`persistent: false`，重启即丢）。所以本接口能查到的是「账号停用/恢复 + 开关变更」，不是全量审计。要补全量，需要另一片把 `appendAudit` 改成写 `admin_audit_events`（含 `action`/`scope` 的新取值 ⇒ 要同步扩本片的枚举闭集与契约 `enum`）。
2. **后台 UI 尚未消费**：本片只交后端读面与文档；`apps/admin` 的审计页仍读 `/admin/audit-events`（real 下 503）。
3. **`limit` 上限是 50 而非 100**：受契约校验器硬判据约束（§2），若要 100 需先改成仓内统一的 `Limit` 参数口径并过 `Unbounded pagination` 判据。
4. **枚举扩张是破坏性变更**：新增写入点若不更新 `AUDIT_ACTIONS` / `AUDIT_ENTITY_SCOPES` 与契约 `enum`，新 `action` 将无法被筛选（只能全量翻页看到），单测 `契约闭集一致` 会在 CI 里先响。
5. **`SECURITY DEFINER` 函数的既定风险**：函数固定 `search_path = pg_catalog`、`TimeZone='UTC'`，`REVOKE ALL FROM PUBLIC` 后仅授运行时角色；但函数体一旦被改成拼接 SQL（`EXECUTE format(...)`）就会重新引入注入面——本片全部为静态 SQL + 参数绑定，真库臂断言了 `queries[0].text` 不含任何拼接值。
6. **临时集群清理**：Windows 上 `pg_ctl -m immediate -w stop` 返回后 `server.log` 句柄可能滞留，真库臂改为「等 `postmaster.pid` 消失 → 重试删目录 → 删不掉只告警不判失败」，因此 `.pg17/tmp` 下偶尔会留下 `gy-r34-audit-logs-pg-<port>-<rand>` 目录，需人工清理（不影响读数）。
