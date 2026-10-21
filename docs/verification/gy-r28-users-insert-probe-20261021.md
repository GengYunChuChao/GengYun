# R28-S45 · `users` 登录建号路径的列级 INSERT：从「待裁定」到五条真执行断言

> 切片：R28-S45；分支 `test/gy-r28-users-insert-probe`；基线 `094f78c`（`test/gy-r28-runtime-surface-parity` 与 `upstream/main` 的合并点，含 S43 的授权面快照）。
> 交付物：`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 新增真执行探针段（L924-995）、读数 CTE `users_login_probe`（L1447 起）、第 104 条断言 `runtime_users_login_insert_path`（L2527 起）；S43 证据页 §7 第 2 条由「待裁定」改为「已裁定」；本页；报告 `.pg17/handoff/r28-s45-report.md`。
> 一句话问题：S43 把「运行时可对 `users` 写 `wechat_subject_lookup`」登记成待裁定，依据是授权面快照（`has_column_privilege` + `pg_attribute.attacl`）——那是**权限清单**，不是「登录建号语句真能跑」的证据；本片用运行时身份真执行五条探针，把它压成一条断言，并把裁定落成文字。

**取证范围声明**：本页全部读数来自**本机一次性 PG 17.11 集群**（`127.0.0.1:55654`，datadir `E:\GengYunCommander\.pg17\data-r28s45`），没有在真实 CVM、没有在 GitHub Actions runner 上执行；`provision-db.sh` 本体未运行，按它的顺序手工复现（26 个迁移 → 8 个角色文件 → `20-login-roles.sql`）。未取得项逐条列在 §7。

## 0. 结论摘要

| 项 | 改前（`094f78c`） | 改后 |
| --- | --- | --- |
| 90-assert 断言计数 `TOTAL/OK/BAD` | `103/103/0`（verdict `ok`、exit 0） | **`104/104/0`**（verdict `ok`、exit 0） |
| `sum(length(label)+2)` / 最长 label | `3239` / `50` | `3272` / `50` |
| `users` 登录建号路径的真执行证据 | **0 条**（S43 只有权限快照） | **5 条运行时探针 + 1 条断言** |
| S43 的「待裁定」 | 待裁定 | **已裁定：不改授权**（登录建号必须写 lookup 列，见 §2） |
| 变异 3 条 | — | 全部按预期判红；每条复原后 `104/104/0`；仓库文件 `sha256` 复原后逐字节相等 |
| 门禁 6 项 | — | 全部 exit 0（§6） |

## 1. 背景：为什么「快照绿」不等于「路径通」

S43 新增的 `runtime_grants_external_users` 证明的是「授权面与快照逐列一致」：`services/api/db/roles/auth_privacy.sql:12` 授了 `wechat_subject_lookup`、`wechat_subject_cipher` 两列 INSERT，`pg_attribute.attacl` 里也确实有这两列。它**答不了**两个问题：

1. 这条 `INSERT` 在运行时身份下**真能跑通**吗？列级 ACL 齐了，但只要触发器、RLS、`DEFAULT` 表达式、类型转换任何一处出问题，语句就失败——而快照断言照样全绿；
2. 越界列**真会被拒**吗？`has_column_privilege = false` 是「没有权限」的清单等价物，不是「执行时返回 42501」的观测。

R28 里同类缺口已经出现过三次（S24「软台账≠真执行」、S28、S38），本片把 S43 停在「清单」上的这一步补成「真执行」。

## 2. 裁定：不改授权

登录建号路径的四段代码事实：

| 位置 | 语句 / 事实 | 作用 |
| --- | --- | --- |
| `services/api/src/auth/store.ts:235` | `SELECT id, state, auth_epoch, revision FROM users WHERE wechat_subject_lookup = decode($1, 'hex')` | 登录时按 lookup 找用户（读 4 列；列级 SELECT 面是 5 列，多出的就是 lookup 本身） |
| `services/api/src/auth/store.ts:249-251` | `INSERT INTO users (wechat_subject_lookup, wechat_subject_cipher) VALUES (decode($1, 'hex'), NULL) RETURNING id, state, auth_epoch, revision` | 首次登录建号；cipher 实参是 `NULL`，竞态 `23505` 时回读既有行（:259-262） |
| `services/api/src/auth/wechat.ts:13`、`:49` | lookup = HMAC-SHA256(密钥, `` `${appId}\n${openid}` ``) → hex | lookup 是不可逆的查找键；运行时可写它 ≠ 能读回身份明文 |
| `services/api/db/roles/auth_privacy.sql:11-12`、`:14` | SELECT 5 列 / INSERT 2 列 / UPDATE `updated_at` | 运行时对 `users` 的全部列级授权面 |
| `services/api/db/migrations/0001_initial_schema.sql` | `wechat_subject_lookup bytea`、`wechat_subject_cipher text`、唯一索引 `users_subject_lookup_key` | 列类型与唯一约束 |

补充事实：`deploy/postgres-cvm/sql/20-login-roles.sql` **没有** `users` 的 INSERT 授权（只有 `:374/:377/:380` 的 `user_backup_copies` 三条），users 列级 GRANT 的唯一源头是 `services/api/db/roles/auth_privacy.sql`。

**结论**：该列级 INSERT 权限是登录建号路径的设计所需，不是越权面；本片 ⛔ **未改任何 GRANT/REVOKE**，`services/api/db/roles/*.sql` 与 `20-login-roles.sql` 一字未动。

## 3. 五条探针（真执行、零残留）

| # | 探针名 | 语句（缩写） | 期望 | 实测 |
| --- | --- | --- | --- | --- |
| 1 | `users_login_insert_ok` | `INSERT INTO public.users (wechat_subject_lookup, wechat_subject_cipher) VALUES (decode(<32B hex>), decode(<32B hex>)) RETURNING id` | 成功 | **SQLSTATE 00000（成功）** |
| 2 | `users_insert_extra_column_denied` | 同形多写 `nickname = 'r28-s45-probe'` | 恰好 42501 | **SQLSTATE 42501** |
| 3 | `users_select_granted_ok` | `SELECT id, state, auth_epoch, revision, wechat_subject_lookup FROM public.users LIMIT 0` | 成功 | **SQLSTATE 00000（成功）** |
| 4 | `users_select_extra_column_denied` | `SELECT nickname FROM public.users LIMIT 0` | 恰好 42501 | **SQLSTATE 42501** |
| 5 | `users_update_extra_column_denied` | `UPDATE public.users SET nickname = nickname WHERE false` | 恰好 42501 | **SQLSTATE 42501** |

失败原文（同一集群、同一批跑）为 `ERROR:  permission denied for table users`。

写法要点（复核/复现时按这几条看）：

- 段首 `\set ON_ERROR_STOP off` → `BEGIN` → `SET LOCAL ROLE gengyun_api_runtime`，并先记 `\set r28_probe_users_role :ERROR`：**身份切换本身也要成功**，否则会出现「角色没切过去、五条全是 42501」被误读成通过的情况。
- 每条探针独立 `SAVEPOINT r28_probe_users` … `ROLLBACK TO SAVEPOINT r28_probe_users`，同时记 `:ERROR` 与内置变量 `:SQLSTATE`。**「恰好 42501」用 `:SQLSTATE` 判**：只看 `:ERROR = true` 分不出 42501（权限）与 42703（未知列）/22001（超长）——那正是这类断言最容易假绿的地方。
- 段末整段 `ROLLBACK` + `\set ON_ERROR_STOP on`：探针不往库里留任何行（`users` 行数、`pg_temp.r28_assert_results` 前后均一致）。
- 探针值：lookup 与 cipher 都用 32 字节真 hex `decode(...)`。生产语句的 cipher 实参是 `NULL`，探针写「真值」是更严的形状（`wechat_subject_cipher` 是 `text`，`bytea` 经 I/O 赋值转换成功，已实测 00000）。
- 反面教材（m3 第一次尝试）：把探针 1 的列换成 `nickname` 却继续传 32 字节 `decode(...)` 时，读到的是 **SQLSTATE 22001（value too long）**而不是 42501 —— `users.nickname` 是 `varchar(40)`，`decode` 的 bytea→text 转换结果 66 字符在解析/常量折叠阶段就报超长，**早于**执行器的 INSERT 权限检查。⇒ 探针的值必须与列类型相容，否则读到的码不是权限码，断言会把「类型错」误判成「不是恰好 42501」。

## 4. 断言：`runtime_users_login_insert_path`（第 104 条）

- `ok` = `:'r28_probe_users_role' = 'false'` **且** `NOT EXISTS (SELECT 1 FROM users_login_probe p WHERE p.ok IS NOT TRUE)`；
- `users_login_probe(name, want, ok, reading)` 一份定义同时供 `ok` 与 `detail` 用 ⇒ 不会出现「判红但说不出哪条」；`reading` 一律 `'SQLSTATE ' || <实测码>`；
- `detail` 先列静态期望，再列 `前置 SET LOCAL ROLE 实测 error=…`，再逐条列 `name=reading`，最后用 `不满足：` 动态点名（全绿时写 `（无）`）。

全绿时 detail 原文（本集群实测，取自 `count-final.out`）：

> `SET LOCAL ROLE gengyun_api_runtime 后，登录建号路径必须真能跑（services/api/src/auth/store.ts:249-251 的 INSERT 两列、:235 的按 lookup 查找），越界必须恰好 42501（读、改 nickname 两个方向都查）；前置 SET LOCAL ROLE 实测 error=false；逐条实测：users_insert_extra_column_denied=SQLSTATE 42501；users_login_insert_ok=SQLSTATE 00000；users_select_extra_column_denied=SQLSTATE 42501；users_select_granted_ok=SQLSTATE 00000；users_update_extra_column_denied=SQLSTATE 42501；不满足：（无）`

## 5. 三条变异（逐条造红 → 复原 → 复跑回绿）

| 变异 | 做法 | 判红读数（`TOTAL/OK/BAD`） | 哪条断言红 | 复原 | 复原后读数 |
| --- | --- | --- | --- | --- | --- |
| m1 | 临时 `GRANT INSERT (nickname) ON public.users TO gengyun_api_runtime` | **`104/102/2`** | ① `runtime_grants_external_users`（「直授 runtime（列级 INSERT）：nickname；越界列级 INSERT：nickname」）② `runtime_users_login_insert_path`（「users_insert_extra_column_denied 期望 恰好 42501、实际 SQLSTATE 00000」） | 对应 `REVOKE` | **`104/104/0`**（exit 0） |
| m2 | 临时 `REVOKE INSERT (wechat_subject_cipher) ON public.users FROM gengyun_auth_privacy` | **`104/102/2`** | ① `runtime_grants_external_users`（「缺列级 INSERT：wechat_subject_cipher」）② `runtime_users_login_insert_path`（「users_login_insert_ok 期望 成功、实际 SQLSTATE 42501」） | 用 `auth_privacy.sql:12` 的逐字反操作 `GRANT INSERT (wechat_subject_cipher) ON public.users TO gengyun_auth_privacy`（偏离派单，理由见 5.2） | **`104/104/0`**（exit 0） |
| m3 | 把探针 1 的第二列 `wechat_subject_cipher` 换成未授权的 `nickname`（值 `'r28-s45-m3'`，`varchar(40)` 可容） | **`104/103/1`** | **只有** `runtime_users_login_insert_path`（「users_login_insert_ok 期望 成功、实际 SQLSTATE 42501」）；S43 的快照断言仍绿 ⇒ 证明新断言不是恒真、能独立判红 | 改回两列 + 真 hex | **`104/104/0`**；`Get-FileHash` 逐字节回到交付态 |

### 5.1 三条变异都打在交付态文件上

`m1`/`m2` 是数据库侧授权变更（不动仓库文件），`m3` 是文件侧临时改动。m3 复原后用 `Get-FileHash <绝对路径> -Algorithm SHA256` 比对，与变异前备份 `90-assert.pre-m3.sql` 的 sha 完全相同：

| 阶段 | 文件 sha256 |
| --- | --- |
| 改前（`094f78c` 的 HEAD 版本） | `656793BF6BC704991D9DCC5690C3193F4215ED559E746FDB8EF822B1315614CA` |
| 交付态（= m3 变异前 = m3 复原后） | `D62B0F0DC3AD172AE90A72B4DF2C25E15A66FD52932C1A5FBE8CA6DE9949C79A` |

### 5.2 m2 复原偏离派单（必须记）

派单 §3 要求 m2 复原时「重跑 `20-login-roles.sql`」。实测**做不到且不该做**：

1. `deploy/postgres-cvm/sql/20-login-roles.sql` 里**没有** `users` 的 INSERT 授权（`grep -n users` 只有 `:374/:377/:380` 的 `user_backup_copies`），重跑它不可能把 `wechat_subject_cipher` 加回去；
2. `services/api/db/roles/auth_privacy.sql` **不幂等**：首行就是 `CREATE ROLE gengyun_auth_privacy`，在已建好的库上重跑第 5 行即 `ERROR: role "gengyun_auth_privacy" already exists`、rc=3，后面的 GRANT 根本执行不到；
3. 用 `GRANT INSERT (wechat_subject_cipher) ON public.users TO gengyun_auth_privacy`（与 `auth_privacy.sql:12` 逐字对应的反操作）复原，并用 `pg_attribute.attacl` 前后快照双证：撤后 `wechat_subject_cipher` 整行从 attacl 消失（只剩 6 行），复原后回到 `wechat_subject_cipher|{gengyun_auth_privacy=a/gengyun_cvm_owner}`，其余 6 列的 attacl 前后完全相同；`runtime_grants_external_users` 也回到绿。

### 5.3 m1 的「双红」是设计使然

m1 红了两条：S43 的 `runtime_grants_external_users`（授权面变了）与新断言（探针 2 不再被拒）。这说明**两个断层面互补**：快照断言抓「授权面漂移」，新断言抓「运行时能否真跑」。m3 只红新断言，正好证明两者不重叠。

## 6. 门禁（6 项，全部 exit 0）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `npm run lint` | exit 0 |
| 2 | `node tools/verify-release-materials.mjs` | exit 0 |
| 3 | `npm run test:docs` | exit 0 |
| 4 | `node tools/verify-contract-status.mjs` | exit 0 |
| 5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | exit 0 |
| 6 | `git diff --check`（工作树）与 `git diff --check upstream/main..HEAD` | 两条都 exit 0（提交前、提交后各跑一次，均 0） |

日志：`.pg17/handoff/r28-s45-logs/gates/`。

## 7. 未取得

1. **真实 CVM 与 GitHub Actions runner 未跑**：本页全部读数来自本机一次性集群（55654），`provision-db.sh` 本体未执行；边界同 S43 页。
2. **部署期差异未验证**：本机是按 `provision-db.sh` 的顺序手工复现的干净库；若 CVM 上有额外的 RLS 策略、触发器或手工 GRANT，探针读数可能不同。
3. **DELETE 面未覆盖**：派单只要求 INSERT/SELECT/UPDATE 三类；运行时对 `users` 也确实没有 DELETE（由 S43 的 `runtime_grants_external_users` 覆盖），本片未另加探针。
4. **cipher 列的读取方未验证**：运行时对 `users` 的 SELECT 面不含 `wechat_subject_cipher`（`auth_privacy.sql:11` 的 5 列里没有它），谁读 cipher（隐私面/egress）不在本片范围。
5. **m2 复原方式偏离派单**（§5.2）：未重跑 `20-login-roles.sql`，改用逐字反操作 GRANT + attacl 双证。
6. **未在 GBK 客户端复跑**：全程 `PGCLIENTENCODING=UTF8`；不设该变量时迁移文件里的中文注释会让 psql 报编码错，属已知环境约束，不是本片结论的边界。

## 8. 复现命令

```bash
# 1) 建库（26 迁移 → 8 角色文件 → 20-login-roles.sql，口令恰 48 位小写 hex）
bash .pg17/handoff/r28-s45-logs/build-cluster.sh

# 2) 合规态 + 计数（期望 104|104|0|3272|50，exit 0）
PGCLIENTENCODING=UTF8 psql -h 127.0.0.1 -p 55654 -U gengyun_cvm_owner -d gengyun \
  -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql
PGCLIENTENCODING=UTF8 psql -h 127.0.0.1 -p 55654 -U gengyun_cvm_owner -d gengyun \
  -f .pg17/handoff/r28-s45-logs/count.sql

# 3) 看第 104 条的 detail（正常跑不会逐条打印 label，只出 SELECT 104 与末行 ok）
PGCLIENTENCODING=UTF8 psql -h 127.0.0.1 -p 55654 -U gengyun_cvm_owner -d gengyun \
  -f .pg17/handoff/r28-s45-logs/detail.sql      # ON_ERROR_STOP off，先 \i 90-assert 再打明细

# 4) 三条变异（各自造红 → 复原 → 复跑回绿）
bash .pg17/handoff/r28-s45-logs/mut-m1.sh
bash .pg17/handoff/r28-s45-logs/mut-m2.sh
#    m3 是文件侧改动，步骤见 §5 与报告；复原后 Get-FileHash 应为 D62B0F0D…

# 5) 收尾
pg_ctl -D E:\GengYunCommander\.pg17\data-r28s45 -m fast -w stop
```
