# GY-I18 / T-R12-03：后台账号读面接入真实 users 投影

2026-10-18，写手。Refs #18、#22；不是整项验收，不关闭 issue。

## 这项切片做了什么

`GET /api/v1/admin/accounts` 过去只在注入内存账号种子（`store.accountsWired === true`）时返回成功，real 模式一律 503。本切片把读面接到真实 `public.users`：新增只读函数 `public.list_admin_accounts()`（迁移 0021），API 侧新增目录适配器 `createPostgresAccountsDirectory()`，并在 real 模式装配时注入；写面（停用/恢复）沿用 0017 的单事务权威，未改动。

| 入口 | 本片状态 |
| --- | --- |
| `GET /api/v1/admin/accounts` | real 且构造出真实目录时读 `public.list_admin_accounts()`；目录为 null 时仍 503 `PROVIDER_UNAVAILABLE` |
| `POST /api/v1/admin/accounts/{id}/suspend` | 逐字未动（0017 权威、单事务） |
| 其余 32 条后台路由 | 仍 503 `PROVIDER_UNAVAILABLE`（外壳只放行读面与停用） |

## 装配口径（能力对象而非自述标志）

1. `services/api/src/admin/ops/accounts-pg.ts`：`AdminAccountsDirectory.list()` 只执行一条 SQL，返回 `AccountView[]`。
2. `services/api/src/admin/ops/service.ts`：`AdminOpsServiceOptions.accountsDirectory?: AdminAccountsDirectory | null`。`listAdminUsers` 在 `accountsDirectory !== null` 时取目录行、按契约闭集复核后仍走既有 `pageOf(context, items, query, 'accounts', byId)`（分页/游标/封套不变）；为 null 时退回 `requireWiredAccountAuthority()` + `store.listAccounts()` 原路径，逐字未动。
3. `services/api/src/admin/ops/accounts-only.ts`：外壳新增第三可选参 `options?: { accountsReadWired?: boolean }`，默认 `false` 与今天逐字相同（`listAdminUsers: reject`）；`true` 才转发 `inner.listAdminUsers`。判据是 `app.ts` 是否真的构造出目录对象，⛔ 不读任何自述持久化布尔标志；`accountsWired` 仍固定 `false`（外壳不代表账号面完整接线）。
4. `services/api/src/app.ts`（real 分支）：`const realAccountsDirectory = pool === null ? null : createPostgresAccountsDirectory({ pool });`，注入 `accountsDirectory: realAccountsDirectory`，并以 `{ accountsReadWired: realAccountsDirectory !== null }` 调外壳。`pool === null` ⇒ 目录 null ⇒ 读面仍 503。非 real（stub）分支不传目录。

残余限制（已写进 `service.ts` 注释）：目录一次读全表，`pageOf` 只在服务层内存切片，**不是** SQL 侧分页；上万账号需后续 keyset 分页片。

## SQL 与字段白名单

适配器唯一 SQL（逐字）：

```sql
SELECT id, revision, state, display_name FROM public.list_admin_accounts()
```

函数体 `RETURN QUERY`（迁移 0021，逐字）：

```sql
SELECT u.id, u.revision, u.state,
       public.admin_account_display_name(u.nickname, u.id)
  FROM public.users AS u
 ORDER BY u.created_at ASC, u.id ASC;
```

返回列恰好 `id, revision, state, display_name` 四列；⛔ 不读也不返回 `wechat_subject_cipher`、`wechat_subject_lookup`、`avatar_media_id`、`auth_epoch`、`deletion_generation`。`state` 必须落在 `ACCOUNT_STATES` 闭集内，越界即抛 `PROVIDER_UNAVAILABLE`（不折叠成 `active`）；`display_name` 必须非空。

`display_name` 复用 0017 已有的 `public.admin_account_display_name(nickname, id)`：`COALESCE(NULLIF(btrim(nickname),''), '耕云用户' || upper(substr(md5(id::text),1,4)))`。**没有**采用派单原文的 `nickname === null ? ''`，因为契约 `AdminAccountView.display_name` 是 `minLength: 1`，空串违反契约（本片按裁定 A 修正）。

## 最小权限（不放宽表权限）

- 迁移 0021：`SECURITY DEFINER` + `SET search_path = pg_catalog` + 全限定名；`REVOKE ALL … FROM PUBLIC`。
- 出厂授权 `deploy/postgres-cvm/sql/20-login-roles.sql` 新增独立区域 `gy-i18-accounts-read-grant`：函数不存在即 `RAISE EXCEPTION`，然后恰好 1 条 `GRANT EXECUTE … TO gengyun_api_runtime`。⛔ 没有给运行时任何 `users` 列授权。
- `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 新增 6 条（32–37）：函数存在且唯一、SECURITY DEFINER、`search_path=pg_catalog`、属主非运行时且不继承、只授 EXECUTE、运行时对 `users.nickname/created_at/deletion_generation` 仍无 SELECT。

## 真库读数（原生 PostgreSQL 17.11 / Node 24.16.0）

环境：便携 PG17.11（`.pg17/pgsql/bin`）新建隔离集群，`initdb -U postgres -A trust -E UTF8 --locale=C`，端口 55127，仅回环；库 `gengyun_admin_accounts_read_test`。该集群在 listen 绑定上不接受 `-h 127.0.0.1`（`Permission denied`），改用 `-c listen_addresses='*'` 启动，客户端仍只连 `127.0.0.1`。

命令：

```powershell
dropdb -h 127.0.0.1 -p 55127 -U postgres --if-exists gengyun_admin_accounts_read_test
createdb -h 127.0.0.1 -p 55127 -U postgres gengyun_admin_accounts_read_test
node tests/integration/admin-accounts-read-pg.mjs `
  "postgres://postgres@127.0.0.1:55127/gengyun_admin_accounts_read_test" `
  "postgres://gengyun_api_runtime:localonly123@127.0.0.1:55127/gengyun_admin_accounts_read_test"
# exit 0，原始输出：
```

```text
[M] 迁移清单 18 个，版本号无重复，含 0021_admin_accounts_read.sql（本片分支 0018–0020 缺号属预期）
[M] UP：public.list_admin_accounts() 出现；SECURITY DEFINER=true；search_path=["search_path=pg_catalog"]；属主=postgres；返回=TABLE(id uuid, revision integer, state user_state, display_name text)
[M] ROLLBACK：list_admin_accounts() 消失；admin_account_display_name(text,uuid) 与 users 仍在（回滚不越界）
[M] REPLAY：读函数再次出现且仍为 SECURITY DEFINER（迁移可重放）
[P] 已按出厂区域 gy-i18-accounts-read-grant 授予 EXECUTE（恰好 1 条：list_admin_accounts）
[H] 夹具 3 行就位（created_at 序：active/1/"Smaug" , suspended/3/NULL , deletion_pending/2/"   "）
[P] 运行时角色：nickname/created_at/deletion_generation 直读、派单逐字 SQL、state 直写 全部 42501
[P] 运行时直读 `SELECT id, revision, state FROM public.users` ⇒ 成功（3 行）：缺的只是 nickname / created_at
[P] 权限面读数：表级 SELECT=false，nickname SELECT=false，created_at SELECT=false ⇒ 读面放行的是函数能力，不是权限面
[H] GET /api/v1/admin/accounts ⇒ 200，items=3，字段集合恰好 {id,revision,state,display_name}，display_name=[Smaug , 耕云用户4D39 , 耕云用户7532]
[H] 正文不含 wechat / cipher / lookup / auth_epoch / deletion_generation（字符串级否定断言）
[H] 游标翻页：limit=2 ⇒ 2 条 + next_cursor；续页 ⇒ 1 条 + next_cursor=null
[H] 负控制：只有 accounts:suspend 的管理员 ⇒ 403 SCOPE_DENIED
[H] 负控制：无令牌 ⇒ 401
结论：迁移三连 + 最小权限反向控制 + 真实模式 HTTP（三态/nickname 回退/游标翻页/两条负控制）全部通过；90 号断言由 psql -f 单独执行并回读 verdict。
```

其中 HTTP 手臂用真实 minimal-privilege 连接跑 `APP_EXECUTION_MODE=real` 的 `buildApp`（非 stub 注入）；夹具三行分别是 `active / revision 1 / nickname "Smaug"`、`suspended / revision 3 / nickname NULL`、`deletion_pending / revision 2 / nickname "   "`，所以后两行 `display_name` 走 `耕云用户` + md5 前 4 位（`4D39`、`7532`），**不是**空串。

最小权限断言与整体 verdict（`90-assert-least-privilege.sql` 含 psql 元命令，由 `psql -f` 单独执行；执行前需有迁移属主角色 `gengyun_cvm_owner`，本集群手工 `CREATE ROLE gengyun_cvm_owner NOLOGIN` 对齐生产）：

```text
psql -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql
ok    # exit 0；含本片新增断言 32–37
```

跨切片回归：`node tests/integration/account-suspend-pg.mjs <owner-url> <runtime-url>` ⇒ exit 0、`ALL PASS：迁移三连 / 最小权限 / A–E / 失败注入 全部取得真库读数`。该脚本本片只改两处：迁移目录断言改为「本脚本实际应用过 0001–0017 且末项 0017」，setup 循环只跑 `< 0017` 的版本再单独应用 0017（原因：目录里已有 0021，旧循环会在 0017 之前跑 0021 而缺 `admin_account_display_name`）。停用写面的 GRANT 计数、权限与状态机断言逐字未动。

## 未取得项

- 真机与后台 UI 联调：没有在真实小程序/后台页面点过这条读面。
- 超 1 万账号规模：未压测；分页仍在服务层内存切片，SQL 侧无 LIMIT/OFFSET/keyset。
- HTTP 层之外的审计：读面无审计事件（读面不写审计，本片也未新增）；没有观测/告警接入证据。
- 迁移编号连续性与 `tests/integration/migrations-negative-pg.mjs`：本片分支 0018–0020 缺号（在途未合并），该脚本的「无缺号」断言必然红，未跑；合并顺序必须是 `#272`(0018) → 消息片(0019) → 开关片(0020) → 本片(0021)。
- 与裁定字面的一处差异：裁定要求 `search_path = pg_catalog, public`，实现用 `pg_catalog`（全限定名，与 0016/0017 及 90 号既有断言一致，更严）；如需逐字对齐裁定可单独改。

## 回滚

`services/api/db/migrations/rollback/0021_admin_accounts_read.down.sql` 只 `DROP FUNCTION IF EXISTS public.list_admin_accounts();`。回滚后 API 侧目录适配器调用会失败并映射为 `PROVIDER_UNAVAILABLE`，读面回到 503，不会退回内存种子、也不会泄露其它列；`20-login-roles.sql` 的 `gy-i18-accounts-read-grant` 区域会因函数不存在而 `RAISE EXCEPTION`（防止带病出厂）。
