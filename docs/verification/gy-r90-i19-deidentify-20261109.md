# R90 · `#19` 片1 证据页：注销去身份（迁移 `0057` + 权限登记 + 受理事务接线 + 真库臂 `A1–A11`）

| 项 | 值 |
| --- | --- |
| 文档性质 | **证据页**（只登记"哪一行写了什么、我本机跑出什么读数"）。不代监工判定，不代关 `#19` |
| 取证时刻 | `2026-11-09`（PowerShell，Node `v24.16.0`，PostgreSQL `17.11` 二进制取自 `$env:GY_PG_BIN` 指向的目录） |
| 仓库 / 基线 | `GengYunChuChao/GengYun`，`origin/main` = `a372bd91f420f869c8f3b0b122ef3e9576411ffc`（**写作时的 main**，此值会随主干前进而漂移；初版按 `d7160e4070ce841dee2c111635bb5a11bce17907` 取证，合并 `#1128` 后本页所有行号已按 `a372bd91` 的树逐条复核） |
| 被取证对象 | `#19`「注销去身份」**片1**（由 `#1108` 合入）：迁移 `0057` + 回滚件 + 权限登记（`20-login-roles.sql` / `90-assert-least-privilege.sql`）+ 受理调用点 + 真库臂 `A1–A11` |
| 本 PR 改动面 | **B 档文档**：新增本页 + `docs/architecture/contract-status.json` 里 `requestAccountDeletion` 的 `blocker` 一行 + 中文镜像表同一行 + `tests/unit/contract-status-ocr-anchor-truth.test.mjs` 的台账体积基线常量。`services/**`、`deploy/**`、`.github/**`、`tests/**` 的产品行为 **0 行** |
| 为什么是 B 档 | `docs/pr-review-policy.md:169` 的受保护清单逐字含 `docs/architecture/contract-status.json`（"命中任一条即 B 档，不论是否在 `docs/**` 下"），`docs/pr-review-policy.md:173` 再兜一句"不在正面清单内的路径一律 B 档" ⇒ 本 PR **不是** A 档，须监工批复、指挥不能自合 |
| 结论 | 片1 的函数面、权限面与受理事务接线在本机一次性集群上 `A1–A11` 全过（`EXIT=0`，11 秒）；CI 已接线（`#1128` 合入 job `real-pg-deidentify-17-11`，main 上 run `42514774873` 该 job 跑绿，见 §3.3）；**整项 `#19` 仍未完成**：取消注销不回滚身份、7/30 日生命周期与第三方删除证据未验；**媒体行删除（片2）与附件面不在本片**（§3.6）⇒ 本片**不满足** `#19` 验收① |

## 本页**不声称**什么

1. **不声称 `#19` 已完成。** 片1 只交付"注销受理那一刻把身份擦掉"的数据库写路径与调用点接线；`#19` 的验收面（**媒体/附件的行删除**（片2，见 §3.6）、7 日在线到期执行、30 日备份到期执行、第三方删除证据、恢复清单重放）一条都不在本片；`#19` 验收① 原文列的"账号、音频/转写/问答、识别、**媒体**、收藏消息、缓存/导出"里，媒体一项由片2 负责，本片**不满足**该条。
2. **不声称"接上 CI"是本页或本 PR 的功劳，也不声称接上之后就有人兜底。** 接线由 `#1128` 完成并已合入 main：job `real-pg-deidentify-17-11`，main 上实跑绿（run `42514774873` / headSha `a372bd91` / job `128835278181`，见 §3.3）；本 PR 只改文档与台账，`.github/**` 零改动、`tests/**` 只改台账体积基线常量。§2 的 `A1–A11` 读数仍是我在本机手动起的一次性集群上跑出来的（§4），不是抄 CI 日志；那道 job 也只覆盖这一个脚本，7/30 日生命周期与第三方证据依旧没有 CI 覆盖（§3.5）。
3. **不声称取消注销可回滚身份。** 去身份**不可逆**：被擦的四列在回滚件里也明写"不会被回滚恢复"，取消注销只把请求推进到 `cancelled`，账号停在 `deletion_pending`（§3.1）。
4. 不声称去身份让账号"消失"。`users` 行、`exports` 行、`export_writebacks` 行都**保留**；擦的是四列 PII 与 `exports.provider_request_ref_cipher`（§1.1、§3.2）。

## 0 取证口径

- 页内每条 `path:line` 都是先用 `node -e "readFileSync(p,'utf8').split('\n')"` 逐行读原文、确认那行是**实质行**（SQL 语句 / 断言行 / 导出声明 / 表格行）之后才写下的；没有一条锚在块首注释或空行上。页内**不出现裸行号**，行号一律带全路径。
- 行号按 `a372bd91` 的树（合并 `#1128` 之后的 main）。本 PR 未动 `services/**`、`deploy/**`、`.github/**`，`tests/**` 只动台账体积基线常量那一处，故这些行号在该树内稳定。
- 真库臂只跑**一个**脚本（`tests/integration/deidentify-account-pg.mjs`）；本片未在本地跑全量 `npm run test:unit`（本机 node 进程 48 个 > 6，按纪律只跑受影响文件，全量以 CI 为准）；CI 首轮暴露 T5 体积基线红 —— `tests/unit/contract-status-ocr-anchor-truth.test.mjs` 钉两份台账的字节数，改台账必然撞上，已在追加提交中同步基线常量（见该文件的"第二十七次同步"注释）。闸门只跑派单点名的六道（§4）。
- 真库臂的环境：`GY_PG_BIN` 指 PG 17 二进制、`GY_I19_PG_ROOT` 指可写根（默认 `tmpdir()` 下 `initdb` 会 `could not create directory ... Permission denied`，故必须显式指到仓外可写目录）。**端口不固定**：脚本用 `pickFreePort()` 现取，我这次拿到 `62982`。
- 读数一律抄我这次运行的原文（§4 表格里"本机读数"列），不引用别处页面里别人的读数。

## 1 片1 做了什么

### 1.1 迁移与函数：一条唯一写路径

`services/api/db/migrations/0057_deidentify_account_on_deletion.sql`（**156** 行，`split('\n')` 末尾空串不计）建一个函数，函数体内**没有任何 `GRANT`**：

| 面 | 位置 | 事实 |
| --- | --- | --- |
| 签名 | `services/api/db/migrations/0057_deidentify_account_on_deletion.sql:73`、`services/api/db/migrations/0057_deidentify_account_on_deletion.sql:74` | `CREATE FUNCTION public.deidentify_account(p_user_id uuid)` / `RETURNS jsonb` |
| 安全面 | `services/api/db/migrations/0057_deidentify_account_on_deletion.sql:76`、`services/api/db/migrations/0057_deidentify_account_on_deletion.sql:77`、`services/api/db/migrations/0057_deidentify_account_on_deletion.sql:78` | `SECURITY DEFINER` + `SET search_path = pg_catalog` + `SET TimeZone = 'UTC'` ⇒ 函数以属主身份执行、搜索路径与时区都钉死（不给 `search_path` 劫持留入口） |
| 状态门 | `services/api/db/migrations/0057_deidentify_account_on_deletion.sql:94`、`services/api/db/migrations/0057_deidentify_account_on_deletion.sql:104` | 先 `SELECT ... FOR UPDATE` 锁行，再要求 `state = 'deletion_pending'`；不满足即 `G0015` ⇒ 未受理的账号擦不动 |
| 四列擦除 | `services/api/db/migrations/0057_deidentify_account_on_deletion.sql:113`、`services/api/db/migrations/0057_deidentify_account_on_deletion.sql:118`、`services/api/db/migrations/0057_deidentify_account_on_deletion.sql:119`、`services/api/db/migrations/0057_deidentify_account_on_deletion.sql:120`、`services/api/db/migrations/0057_deidentify_account_on_deletion.sql:121` | `UPDATE public.users SET nickname / avatar_media_id / wechat_subject_cipher / wechat_subject_lookup = NULL`，同句 `deletion_generation = deletion_generation + 1`、`updated_at = now()` |
| 幂等闸 | `services/api/db/migrations/0057_deidentify_account_on_deletion.sql:124` | `WHERE id = p_user_id AND (四列任一 IS NOT NULL)` ⇒ 第二次调用**零行更新**，不再自增 generation |
| 幂等回落 | `services/api/db/migrations/0057_deidentify_account_on_deletion.sql:125`、`services/api/db/migrations/0057_deidentify_account_on_deletion.sql:129` | `RETURNING deletion_generation INTO x_generation`；零行时 `COALESCE(x_generation, x_generation_before)` ⇒ 返回的 `generation` 仍是库里的真值 |
| 外发台账 | `services/api/db/migrations/0057_deidentify_account_on_deletion.sql:133`、`services/api/db/migrations/0057_deidentify_account_on_deletion.sql:136` | 只清 `public.exports.provider_request_ref_cipher`（第三方请求引用），且同样带 `IS NOT NULL` 闸 |
| `revision` 零写入 | `services/api/db/migrations/0057_deidentify_account_on_deletion.sql:113`、`services/api/db/migrations/0057_deidentify_account_on_deletion.sql:119` | 函数体里对 `users` 只有这一句 `UPDATE`，`SET` 列表到 `updated_at = now()` 结束，**没有 `revision` 项** ⇒ 202 回执的 `accountRevision` 不会被去身份顶掉（可执行版见 A2、A9） |
| 撤 PUBLIC | `services/api/db/migrations/0057_deidentify_account_on_deletion.sql:154` | `REVOKE ALL ON FUNCTION public.deidentify_account(uuid) FROM PUBLIC`（本文件里唯一一条权限语句，且是回收） |

不动的东西由真库臂钉成可测事实，而不是靠注释承诺：`exports.recipient_id`（以及同表其余列）在 A6 里逐列比对（`tests/integration/deidentify-account-pg.mjs:403`），`export_writebacks` 在 A7 里整行 `deepEqual`（`tests/integration/deidentify-account-pg.mjs:410`），`users.revision` 的零写入由 A2（`tests/integration/deidentify-account-pg.mjs:354`）与 A9（`tests/integration/deidentify-account-pg.mjs:476`）双向钉住。

回滚件是 `services/api/db/migrations/rollback/0057_deidentify_account_on_deletion.down.sql`（**派单写的文件名不带 `.down`，实测带**），全文只有 `BEGIN`、一条 `DROP FUNCTION IF EXISTS public.deidentify_account(uuid)`、`COMMIT`：`services/api/db/migrations/rollback/0057_deidentify_account_on_deletion.down.sql:13`。它不含任何 `UPDATE`/`INSERT`/`DELETE` ⇒ 回滚只删函数，**不恢复**任何已擦除的数据。

### 1.2 权限面：出厂授权 + 最小权限断言

| 面 | 位置 | 事实 |
| --- | --- | --- |
| 授权区域 | `tests/integration/deidentify-account-pg.mjs:49` | 区域名 `gy-i19-deidentify-grant` 是脚本抽取的常量（区域标记在 `deploy/postgres-cvm/sql/20-login-roles.sql`，`#region`/`#endregion` 之间是**可被原样执行**的纯 SQL，不含 psql 元命令） |
| 迁移前置 | `deploy/postgres-cvm/sql/20-login-roles.sql:267`、`deploy/postgres-cvm/sql/20-login-roles.sql:268` | 函数不存在就 `RAISE EXCEPTION`（消息点名"迁移 0057 未执行"）⇒ 顺序错了当场失败，不留"授权成功但函数不在"的半截状态 |
| 回收与授予 | `deploy/postgres-cvm/sql/20-login-roles.sql:273`、`deploy/postgres-cvm/sql/20-login-roles.sql:274` | `REVOKE ALL ... FROM PUBLIC` 后 `GRANT EXECUTE ... TO gengyun_api_runtime`——区域内 `TO gengyun_api_runtime` **恰一条**，没有第二个被授者 |
| manifest 登记 | `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2098`、`deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2099` | `('public', 'deidentify_account', 'runtime', ARRAY['gengyun_api_runtime']::text[])` ⇒ 该函数属于"只有运行时能执行"的那一类 |
| 112 存在且签名精确 | `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2799`、`deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2807` | 断言名 `deidentify_function_exists`；签名逐字比 `'p_user_id uuid'` ⇒ 换参数名/加默认参数都会红 |
| 113 必须 SECURITY DEFINER | `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2813` | 读 `pg_proc.prosecdef` ⇒ 有人把函数改成 `SECURITY INVOKER` 就红（那样四列擦除必然 42501） |
| 114 会话固定 | `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2822` | `proconfig @> ARRAY['search_path=pg_catalog', 'TimeZone=UTC']` ⇒ 少一项就红 |
| 115 属主正确 | `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2832`、`deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2839` | 属主 ≠ 运行时、运行时不能 `SET ROLE` 成为它，且属主对六列（四列 PII + `deletion_generation` + `exports.provider_request_ref_cipher`）都有 `UPDATE` 列权限 ⇒ 属主错了函数会在运行时 42501 |
| 116 只授运行时 | `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2848`、`deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2867` | 一半查"运行时确实能 EXECUTE"，一半查"`grantee` 只有 0/运行时/属主之外无他人、且 PUBLIC 不在 `proacl` 里" ⇒ 多授一个角色或漏 `REVOKE` 都红 |

### 1.3 调用点：去身份发生在受理事务内，失败即整笔回滚

| 面 | 位置 | 事实 |
| --- | --- | --- |
| 唯一 SQL 常量 | `services/api/src/privacy/deletion-requests-pg.ts:79` | `SELECT public.deidentify_account($1::uuid) AS result` |
| 事务起点 | `services/api/src/privacy/deletion-requests-pg.ts:278`、`services/api/src/privacy/deletion-requests-pg.ts:279` | 全文件唯一的 `pool.connect()`，紧接着 `BEGIN` ⇒ 去身份、受理落库、会话撤销共用**同一条连接同一个事务** |
| 事务内顺序 | `services/api/src/privacy/deletion-requests-pg.ts:281`、`services/api/src/privacy/deletion-requests-pg.ts:311`、`services/api/src/privacy/deletion-requests-pg.ts:313` | 锁超时 → 受理函数 → **去身份** → `COMMIT`。`COMMIT` 前一条就把返回值解析成内部类型，形状不符也是整笔回滚（`services/api/src/privacy/deletion-requests-pg.ts:312`） |
| fail-closed | `services/api/src/privacy/deletion-requests-pg.ts:315`、`services/api/src/privacy/deletion-requests-pg.ts:316`、`services/api/src/privacy/deletion-requests-pg.ts:214` | catch 里 `ROLLBACK`（吞掉回滚自身的错）后转 `mapDeletionError`，而它的签名是 `: never` ⇒ 异常路径**恒抛**，不可能走到 `202` |
| 缺授权口径 | `services/api/src/privacy/deletion-requests-pg.ts:225` | `G0015` ⇒ `PROVIDER_UNAVAILABLE('注销去身份暂不可用', { retryable: false })`：运维缺陷，不标可重试 |
| `deidentified` 不进 HTTP | `services/api/src/privacy/deletion-requests-pg.ts:131`、`services/api/src/privacy/account-deletion.ts:400`、`packages/contracts/openapi.json:14741` | `deidentified` 只是 store 的内部返回字段（可选、非契约）；回执投影 `projectReceipt()` 返回的是**显式七字段字面量**（没有 `deidentified`）；`DeletionReceipt` 又是 `additionalProperties: false` ⇒ 它想漏进 HTTP 会被契约挡下 |

### 1.4 真库臂：一个脚本、十一条断言、一次性集群

`tests/integration/deidentify-account-pg.mjs`（547 行）自己在 `127.0.0.1` 上起一次性集群：`pickFreePort()` 现取端口（`tests/integration/deidentify-account-pg.mjs:147`，不写死 `554xx`）、按 `discoverMigrations` 顺序跑**全链 56 个迁移**（我这次运行打印"最大号 57"）、再按真实次序执行出厂角色与两条授权区域，最后跑 `A1–A11`。缺 `GY_PG_BIN` 时它打印 SKIP 并 `exit 77`——**未取得不是通过**。

## 2 `A1–A11`：每臂断言什么 → 为什么它能红

下面每条都给"断言所在行"与"什么样的改动会让它变假"。**能红的理由都是对被测对象的变异**（改函数体 / 改授权 / 改调用点），不是改断言自己。

### A1 正常擦除的读数

- 断言：返回值三读数必须 `identity=1 / exports=1 / generation=1`——`tests/integration/deidentify-account-pg.mjs:339`、`tests/integration/deidentify-account-pg.mjs:341`；夹具擦除前 `generation` 必须为 0——`tests/integration/deidentify-account-pg.mjs:336`。
- 为什么能红：三个读数分别来自 `users` 的 `GET DIAGNOSTICS` 与 `exports` 的 `ROW_COUNT`。把 `UPDATE` 的 `WHERE` 写歪（少匹配一行）、把 `deletion_generation + 1` 去掉、或让函数恒返回 0，任一条都立刻让 `deepEqual` 假。
- 本机读数：`✓ A1 正常擦除：identity=1、exports=1、generation 0 → 1（读数来自 GET DIAGNOSTICS / RETURNING）`

### A2 四列全 NULL，且 state / auth_epoch / revision 一字未动

- 断言：四列逐列为 `null`——`tests/integration/deidentify-account-pg.mjs:349`、`tests/integration/deidentify-account-pg.mjs:350`；`state`/`auth_epoch`/`revision` 与擦除前相等——`tests/integration/deidentify-account-pg.mjs:352`、`tests/integration/deidentify-account-pg.mjs:353`、`tests/integration/deidentify-account-pg.mjs:354`；`generation` 必须 `+1`——`tests/integration/deidentify-account-pg.mjs:355`；`updated_at` 按**微秒**比必须前移——`tests/integration/deidentify-account-pg.mjs:357`。
- 为什么能红：漏擦一列（例如只清 `nickname` 忘了 `wechat_subject_lookup`）⇒ 该列非 NULL 即红；函数里顺手写 `state = 'deleted'` 或 `revision = revision + 1` ⇒ 后两条立刻红。后一条正是这一臂存在的理由：`revision` 被顶掉，202 回执的 `accountRevision` 就掉队。`updated_at` 单列出来按微秒判，是因为同一秒内两次写入用秒级字符串会假"没变"。
- 本机读数：`✓ A2 四列 PII 全 NULL；state / auth_epoch / revision 一字未动，deletion_generation=1`

### A3 幂等：第二次零写入

- 断言：第二次读数必须 `identity=0 / exports=0 / generation=1`——`tests/integration/deidentify-account-pg.mjs:364`、`tests/integration/deidentify-account-pg.mjs:366`；`generation` 不得再自增——`tests/integration/deidentify-account-pg.mjs:370`；`updated_at` 必须**一字不动**——`tests/integration/deidentify-account-pg.mjs:371`。
- 为什么能红：删掉 `WHERE` 里的 `AND (四列任一 IS NOT NULL)` ⇒ 第二次照样 `UPDATE` ⇒ `generation` 变 2、`updated_at` 前移，两处都红；把 `COALESCE(x_generation, x_generation_before)` 改成直接用 `x_generation`（零行时为 NULL）⇒ `generation` 读数不再是 1，`deepEqual` 红。
- 本机读数：`✓ A3 幂等：第二次 identity=0、exports=0，generation 不再自增、updated_at 不动`

### A4 非 `deletion_pending` ⇒ `G0015` 且零写入

- 断言：`active` 用户必须抛 `G0015`——`tests/integration/deidentify-account-pg.mjs:379`、`tests/integration/deidentify-account-pg.mjs:380`；被拒后昵称仍是夹具值——`tests/integration/deidentify-account-pg.mjs:382`；`generation` 仍是 0——`tests/integration/deidentify-account-pg.mjs:383`。
- 为什么能红：状态门放宽（例如只拒 `deleted`）⇒ `active` 账号也能被擦，`G0015` 断言先红；把"先校验后写"改成"先写后校验"或把 `RAISE` 挪到 `UPDATE` 之后 ⇒ 后两条测到 `nickname` 变 NULL / `generation` 变 1，红。
- 本机读数：`✓ A4 state=active ⇒ G0015，且零写入（fail-closed）`

### A5 不存在的 uuid ⇒ `G0002`

- 断言：`tests/integration/deidentify-account-pg.mjs:386`、`tests/integration/deidentify-account-pg.mjs:387`。
- 为什么能红：把 `SELECT ... INTO` 之后的 `IF NOT FOUND` 检查删掉，函数就会拿 NULL 继续走到 `RETURN jsonb_build_object(...)` 而不是抛 `G0002` ⇒ 断言红（并且会顺带把"未知主体"变成"成功受理"）。
- 本机读数：`✓ A5 不存在的 uuid ⇒ G0002`

### A6 `exports` 只清一列，其余逐列原样

- 断言：`exports` 行必须还在——`tests/integration/deidentify-account-pg.mjs:391`；除 `updated_at` 外**变化列集合恰为** `['provider_request_ref_cipher']`——`tests/integration/deidentify-account-pg.mjs:394`、`tests/integration/deidentify-account-pg.mjs:397`；该列必须变 NULL——`tests/integration/deidentify-account-pg.mjs:402`；`recipient_id` 必须原样——`tests/integration/deidentify-account-pg.mjs:403`。
- 为什么能红：函数里多清一列（例如顺手清 `recipient_id`）⇒ `changed` 集合长度变 2，`deepEqual` 红；把 `UPDATE` 写成 `DELETE` ⇒ 行消失，`afterExport !== undefined` 红——这一臂把"擦引用 ≠ 删台账"钉成可测事实。
- 本机读数：`✓ A6 exports 行仍在；逐列比对后只有 provider_request_ref_cipher 变 NULL（updated_at 前移），recipient_id/object_id 原样`

### A7 `export_writebacks` 整行不变

- 断言：`tests/integration/deidentify-account-pg.mjs:410`（整行 `deepEqual`）。
- 为什么能红：在函数里加一句 `UPDATE public.export_writebacks ...`（哪怕只动一个字段）⇒ 整行比较红。该表无 PII 列，所以"不动"是可断言的事实，而不是口头承诺。
- 本机读数：`✓ A7 export_writebacks 整行逐字段不变（不在本片擦除面）`

### A8 运行时角色：能 EXECUTE，不能碰列

- 断言：`SET ROLE gengyun_api_runtime` 后 EXECUTE 成功且 `identity=1`——`tests/integration/deidentify-account-pg.mjs:419`、`tests/integration/deidentify-account-pg.mjs:422`；直改 `users.nickname` 必须 `42501`——`tests/integration/deidentify-account-pg.mjs:424`；直读同一列也必须 `42501`——`tests/integration/deidentify-account-pg.mjs:426`；被拒后该列仍是函数擦出来的 NULL——`tests/integration/deidentify-account-pg.mjs:431`。
- 为什么能红：这是**双向**判据。少授 EXECUTE（例如 `REVOKE` 后忘了 `GRANT`、或只授给别的角色）⇒ 第一条红；把 `nickname` 的列级 `UPDATE`/`SELECT` 误授给运行时（或让运行时继承到某个能改该列的角色）⇒ 第二、三条红；`finally` 里 `RESET ROLE` 漏了会污染后续臂，`tests/integration/deidentify-account-pg.mjs:428` 就是为此。
- 本机读数：`✓ A8 SET ROLE 运行时：EXECUTE 成功（identity=1），直改/直读 users.nickname 各 42501`

### A9 真实 `createRequest()` 的合流读数

- 断言：受理记录的 `deidentified` 必须是 `{identity:1, exports:1, generation:1}`——`tests/integration/deidentify-account-pg.mjs:469`、`tests/integration/deidentify-account-pg.mjs:471`；`accountState=deletion_pending`——`tests/integration/deidentify-account-pg.mjs:474`；`authEpoch=2`——`tests/integration/deidentify-account-pg.mjs:475`；`accountRevision=2`——`tests/integration/deidentify-account-pg.mjs:476`；会话撤销 1——`tests/integration/deidentify-account-pg.mjs:477`；落库 `nickname` 已为 NULL——`tests/integration/deidentify-account-pg.mjs:480`；`deletion_requests` 恰一行——`tests/integration/deidentify-account-pg.mjs:484`。
- 为什么能红：这一臂走的是**产品代码**（`createPostgresDeletionRequestStore().createRequest()`），不是直接调 SQL。把 `DEIDENTIFY_SQL` 挪到 `BEGIN` 之前、或另开一条连接执行 ⇒ 去身份与受理落库不再同一事务，`nickname` 与 `deletion_requests` 的联合读数会出现不可能的组合；把 `deidentified` 的字段映射错位（例如 `identity` 取成 `exports`）⇒ 第一条红；函数若碰了 `revision` ⇒ `accountRevision` 变 3，第四条红。
- 本机读数：`✓ A9 真实 createRequest()：deidentified={identity:1,exports:1,generation:1}；state=deletion_pending、auth_epoch=2、revision=2、会话撤销 1、deletion_requests 1 行`

### A10 收回 EXECUTE ⇒ 503 口径且整笔回滚

- 断言：收回授权后 `createRequest()` 必须抛（不许静默受理）——`tests/integration/deidentify-account-pg.mjs:499`；错误码 `PROVIDER_UNAVAILABLE`——`tests/integration/deidentify-account-pg.mjs:500`；`retryable=false`——`tests/integration/deidentify-account-pg.mjs:501`；`users.state` 仍是 `active`——`tests/integration/deidentify-account-pg.mjs:503`；`nickname` 还在——`tests/integration/deidentify-account-pg.mjs:504`；`deletion_requests` 零行——`tests/integration/deidentify-account-pg.mjs:506`。
- 为什么能红：catch 里若吞错并返回空壳（"看起来受理了"）⇒ 第一条红；若 `ROLLBACK` 缺失或换成 `COMMIT` ⇒ 前序 `INSERT`/`UPDATE` 留在库里，后三条红；把 `retryable` 写成 `true` ⇒ 第三条红（缺授权是运维缺陷，重试不会好）。这一臂就是"fail-closed 不签发 202"的可执行版本。
- 本机读数：`✓ A10 收回 EXECUTE ⇒ PROVIDER_UNAVAILABLE(retryable:false)，users 仍 active、nickname 未动、deletion_requests 零行`

### A11 后台读面的展示名回落

- 断言：`SELECT display_name FROM public.list_admin_accounts()` 必须等于 `耕云用户 + md5(id) 前 4 位大写`——`tests/integration/deidentify-account-pg.mjs:513`、`tests/integration/deidentify-account-pg.mjs:517`；账号仍必须在后台目录里——`tests/integration/deidentify-account-pg.mjs:514`。
- 为什么能红：若擦除把昵称写成空串而不是 NULL，`admin_account_display_name()` 就走不到 `NULL` 回落分支 ⇒ `display_name` 变空/异常，与 `fallbackDisplayName(userId)` 不等即红。回落算法本身在 `services/api/db/migrations/0017_account_suspend_authority.sql:122`。
- 本机读数：`✓ A11 后台 display_name 回落到 耕云用户3D63（nickname 为 NULL 时的 0017 回落算法）`

## 3 已知后果与边界

### 3.1 取消注销**不**回滚身份

已擦的四列不会回来，`deletion_generation` 也停在 `+1` 后的值。取消注销的实现只动请求状态、不碰 `users`：

- `services/api/src/privacy/user-data-deletion.ts:1632` 是 `cancelDeletion(userId)` 的定义，整段（`services/api/src/privacy/user-data-deletion.ts:1637` … `services/api/src/privacy/user-data-deletion.ts:1645`）只有"挑本人的最新请求 → 交协调器取消 → 返回回执"，**零 `users` 写入**。
- 路由侧同此：`services/api/src/routes/account-deletion.ts:377` 只是转调 `cancelDeletion`。
- 唯一把 `users` 行改回 `active` 的路径是 `public.restore_account`（`services/api/db/migrations/0017_account_suspend_authority.sql:238`）；措辞必须限定到 `users`：另一处 `SET state = 'active'` 在 `services/api/db/migrations/0048_admin_account_disable.sql:395`，改的是 `public.admin_accounts`（后台账号，该表无 PII 列），与用户身份无关。而 `restore_account` 对 `deletion_pending`/`deleted` 直接抛 `G0004`：`services/api/db/migrations/0017_account_suspend_authority.sql:272`、`services/api/db/migrations/0017_account_suspend_authority.sql:273`；即便走到它的 `UPDATE`（`services/api/db/migrations/0017_account_suspend_authority.sql:291`），写的也只有 `state`/`auth_epoch`/`revision`/`updated_at`，**不写昵称与三列微信身份**。

**派单写的 vs 实测**：派单说"全仓无 `UPDATE users SET state='active'` 的恢复路径"。实测**存在**这条 `UPDATE`（在 `restore_account` 里），但它被 `deletion_pending` 守卫挡在门外、且不恢复任何 PII。结论不变（取消注销后身份不可回滚），措辞要按实测改：不是"没有恢复函数"，而是"恢复函数对注销中账号直接拒绝、且不恢复 PII"。

### 3.2 擦掉 `wechat_subject_lookup` 后，同一微信主体再扫码 = **新建账号**（不是 500）

链路是"查无 → 直接建"，四段代码拼起来：

1. `services/api/src/auth/service.ts:162` 先 `findUserBySubject(subjectLookupHex)`；
2. `services/api/src/auth/service.ts:163` 是 `const user = existing ?? (await this.store.createUser(subjectLookupHex));` ⇒ 查不到就建；
3. `services/api/src/auth/store.ts:260` 查无行返回 `null`（不是抛错），`services/api/src/auth/store.ts:270` 的 `INSERT INTO users (wechat_subject_lookup, wechat_subject_cipher) VALUES (decode($1,'hex'), NULL)` 直接建新行；
4. `services/api/db/migrations/0001_initial_schema.sql:46` 的唯一索引 `users_subject_lookup_key` 建在 `wechat_subject_lookup` 上，**对 NULL 不去重**（PostgreSQL 里 `NULL` 不等于 `NULL`，唯一索引放行任意多行 NULL）⇒ 擦除后的用户在索引眼里"不存在"，新建不会撞唯一约束。

后果：一个已注销（或被去身份）的人用同一个微信再登录，会拿到一个**全新的 `users` 行**（新 id、`state=active`、`revision` 从 1 起），而不是"账号已注销"的报错。这是产品决策层面的已知行为，不是本片要修的东西；但它意味着"注销去身份"不是"账号封禁"，不要把它当后者宣传。

### 3.3 CI 接线：`real-pg-deidentify-17-11`（已接线，有我实查得到的一次绿）

**先纠正一处过期口径。** 本页初版（基线 `d7160e40`）把这条臂写成"未接线（真缺口）"，那是接线前的真实状态；`#1128` 已把它接进 CI 并合入 main。下面的位置与读数按合并后的树（`a372bd91`）重写。

接线位置（`.github/workflows/real-pg-integration.yml`，自起集群形态的 job，不 `CREATE DATABASE`）：

- job 键与超时：`.github/workflows/real-pg-integration.yml:1815`（`real-pg-deidentify-17-11:`）、`.github/workflows/real-pg-integration.yml:1818`（`timeout-minutes: 45`）。
- 跑臂的那一行：`.github/workflows/real-pg-integration.yml:1855`（`node tests/integration/deidentify-account-pg.mjs 2>&1 | tee "$log" || rc=$?`）。
- 三道判据，任一不满足就红：`exit 77` ⇒ 红（"未取得"不是"通过"）——`.github/workflows/real-pg-integration.yml:1856`；退 0 但日志里没有「结论行」⇒ 红——`.github/workflows/real-pg-integration.yml:1864`；A 断言条数 `< 11` ⇒ 红——`.github/workflows/real-pg-integration.yml:1870`（计数写在前一行 `.github/workflows/real-pg-integration.yml:1868`）。
- 环境：`GY_PG_BIN` 钉到 17 那一份——`.github/workflows/real-pg-integration.yml:1875`。

**哪一次运行可以引用**（`gh run list -R GengYunChuChao/GengYun -b main -L 30` 实测；workflow 名是 `Real PostgreSQL integration gates`）：

- run `42514774873`、`run_number 2284`、headSha `a372bd91f420f869c8f3b0b122ef3e9576411ffc`、`2026-11-08T19:23:10Z`、结论 `success`。
- 同一 run 的 job `real-pg-deidentify-17.11`：job id `128835278181`、结论 `success`、`19:23:31Z → 19:24:07Z`（36 秒），其 step「注销去身份真库臂（R90 / …」也是 `success`。
- 该 job 的日志里能读到这两行（原文抄录）：

```text
2026-11-08T19:24:04.4093258Z   ✓ 结论：注销去身份的函数擦除面（A1–A7）+ 最小权限（A8）+ 受理事务接线与 fail-closed（A9–A10）+ 后台展示名回落（A11）全部通过
2026-11-08T19:24:04.6449094Z 注销去身份真库臂断言读数：A 段 11 条
```

清册口径也随 `#1128` 改了（不在本 PR 的改动面内）：`tests/unit/ci-integration-chain-structure.test.mjs:647` 仍是条目路径，但 `tests/unit/ci-integration-chain-structure.test.mjs:648` 的 `reason` 现在以「已接线（workflow）」开头，`tests/unit/ci-integration-chain-structure.test.mjs:656` 写的是 CI 口径（`exit 77` 判红 + 读数闸 `pass_lines -lt 11` ⇒ 期望 11 条 A 断言）。条目**不删**：判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链（那条链没有能建角色的超管连接），真库 job 不算"接线"，删条目反而会变成"未声明"的红——`tests/unit/ci-integration-chain-structure.test.mjs:659`。所以本条现在的准确说法是：**已接线（`#1128`，job `real-pg-deidentify-17-11`）；接线前为真缺口。** `#1128` 自带一份接线证据页：`docs/verification/gy-r90-i19-deidentify-ci-wiring-20261109.md`。

结论：**主干上现在有 CI 会在别人改坏 `A1–A11` 时变红**；但它只覆盖这一个脚本——7 日/30 日生命周期、第三方删除证据、恢复清单重放仍然没有 CI 覆盖（§3.5），本页 §2 的读数也仍是我本机跑的（§4），不是抄 CI 日志。

### 3.4 断言覆盖的已知边界

- **区域断言只覆盖弱面。** `tests/integration/backup-purge-pg.mjs:369` 只断言"区域存在"，`tests/integration/backup-purge-pg.mjs:371` 只断言"区域里没有 psql 元命令"。它**不**校验 `REVOKE`、不校验"`TO gengyun_api_runtime` 恰一条"、不校验"没有授给别的角色"。那三条由 §1.2 的 90-assert 断言 112–116 与真库臂 A8 分别覆盖；`backup-purge-pg.mjs` 这一处只是"能执行"，不是"授对了"。
- **单测切片弱点已由 `#1125` 修掉（派单写的是修前状态）。** `tests/unit/deidentify-account-store-sql.test.mjs:55` 现在用仓内词法器 `createRequestSpan()` 配平花括号，切片终点落在 `createRequest()` 方法体自身的 `}`，并强制边界自证（`tests/unit/deidentify-account-store-sql.test.mjs:72`）；消费点在 `tests/unit/deidentify-account-store-sql.test.mjs:122`。此前"终点切到文件尾"的写法（`slice(indexOf(...))`）已不存在。

### 3.5 不在本片的手动项（未取得，不是通过）

- **7 日在线数据到期的真实执行**：本片只落"受理即擦身份"，没有任何调度器/定时任务真跑过一次 7 日到期。
- **30 日备份到期的真实执行**：同理；备份副本的清理由 `backup-purge` 那条链负责（它有自己的 CI step：`.github/workflows/real-pg-integration.yml:610`），本片既没改它、也没取它的到期读数。
- **第三方删除证据**：第三方（如微信）侧的删除回执/对账证据一条未取；`exports.provider_request_ref_cipher` 被清掉之后，对账只能靠 `recipient_id`/`object_id`/`object_key`（§1.1 明确不动）。
- **恢复清单重放**：`backup-replay-manifest` 那条链本片未碰，未验证"用备份清单把已注销账号重放回来"会得到什么形状。

### 3.6 不在本片的功能面：媒体行删除（片2，已有实现与证据）

`#19` 验收① 原文含"**媒体**"，AC23 原文含"**附件处理**"（`docs/implementation-requirements.md:585` 那一行：「注销删除与保留 | 会话立即失效，在线7日备份30日；帖评去身份／附件处理、第三方证据、模型停止及恢复清单生效」）。片1 的迁移文件头自己就写明这块**不属于**本函数：「不在本函数内：状态迁移/auth_epoch（属 `request_account_deletion`）、删除 `media` 行、备份副本清单写入（属 `#19` 后续片）」（在 `services/api/db/migrations/0057_deidentify_account_on_deletion.sql` 的第 42–43 行；那两行是文件头注释、不是实质行，故此处只引原文，不给 `path:line` 锚点）。**因此本片不满足 `#19` 验收① 的媒体/附件面。**

这块有独立实现与独立证据，但都不在本 PR：

- 写路径：`public.purge_owner_media(p_owner uuid) RETURNS jsonb` —— `services/api/db/migrations/0035_r34_media_row_purge.sql:121`（`SECURITY DEFINER` + 钉死 `search_path`；谓词自带 owner 绑定，跨 owner 一行都删不到）。
- 真库臂：`tests/integration/media-row-purge-pg.mjs:272` 是该脚本对 `SELECT public.purge_owner_media($1::uuid) AS r` 的调用点（脚本自己起一次性集群，741 行）。
- 证据页：`docs/verification/gy-r34-i19-media-row-purge-20261024.md`（300 行）。
- 授权面：该迁移不加任何表级授权，media 域在探针里零命中 —— `deploy/postgres-cvm/evidence/probe-runtime-grants.sql`。

读本页时请把片1 与片2 分开算：**片1 擦的是"身份列"，片2 删的是"媒体行与派生文件"**；两者都到位才谈得上 `#19` 验收①。台账 blocker 已按同一口径写明「媒体行删除（#19 片2）不在本片」。

## 4 闸门读数（我实跑）

- 取证环境：本 PR 的 worktree（`<worktree 名>`），Windows + PowerShell 7。`origin/main` = `a372bd91f420f869c8f3b0b122ef3e9576411ffc`（写作时的 main；本分支已 merge 该提交，闸门 2 与闸门 6 的 base 就是它）。真库臂用 `$env:GY_PG_BIN` 指向目录里的 PostgreSQL 17.11。
- 真库臂本身（不在六道闸门里，但本页所有「本机读数」都出自它）：`node tests/integration/deidentify-account-pg.mjs` ⇒ **EXIT 0、11 秒**，A1–A11 十一条全过。集群端口由 `pickFreePort()` 现分配（本次 62982），数据库名 `gengyun_i19_deidentify_test`，数据目录建在 `$env:GY_I19_PG_ROOT` 下的 `gy-i19-deidentify-pg-<随机后缀>`（默认 `tmpdir()` 下 `initdb` 会 `could not create directory ... Permission denied`，所以显式给了根目录），收尾 `pg_ctl stop -m immediate` 并删目录；完整日志留在仓外本机临时目录（文件名 `r90i19page-arm.log`）。

| # | 命令 | EXIT | 尾行 / 关键读数 |
| --- | --- | --- | --- |
| 1 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | 0 | `PASS: --strict 下没有基线之外的新增`（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT、COMMENT_ANCHOR 均按基线内条目只计数）；读数行：`BARE-ORPHAN` 命中 3469 条、基线外新增 0 条、面内陈旧 0 条；`ANCHOR-COUNT` 进判据锚点 **9530 条 / 304 份文档**、计数下降的文档 0 份（上升 115 份，清册只判下降）；`SYMBOL-COVERAGE-VERIFICATION`：不在区间 44、UNDECLARED 258、配成对 1315（低于基线 UNDECLARED 265，只提示收紧、不判红） |
| 2 | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | 0 | `pass 37` / `fail 0`（`tests 37`）；判定面 `base=a372bd91f420`（`git merge-base HEAD origin/main`）、`documented files=3 docLines=2 tokens=50 pairs=50 judged=50 identical=50 relocated=0 registered=0 corrected=0 carried=685 removed=0 unresolved=0 hunks(pair=2 add=1 del=0)` ⇒ **不需要任何登记**：本页三个提交里，本页本身只有新增行（`add=1` 的纯新增 hunk 不进判定面），被改的两行是台账 JSON 与中文镜像的同一行 blocker，其锚点改前改后逐字相同 |
| 3 | `node tools/verify-contract-status.mjs` | 0 | `PASS: 中文表格一致`；`PASS: 覆盖 130 条契约操作；已装配 130 条；implemented 19 / partial 111 / planned 0；横切维度 8 条；形状错误 0 项；语义错误 0 项`；尾行 `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` |
| 4 | `npm run test:docs` | 0 | `PASS: 识别 5 页 / 跳过 366 页（扫描面 371 页：docs/verification）——读数七条判据全部自洽` |
| 5 | `node tools/verify-g-drill-readings.mjs --check` | 0 | `✓ 八条判据全过：workflows 15 / jobs 30 / 演练 21 条 / 测试文件 608（glob 合计 578）`；生长型读数按**下界**判（`--tolerant-growth`），8 条滞后已逐行打印 |
| 6 | `git merge-tree --write-tree --name-only origin/main HEAD` | 0 | 输出只有一行 tree OID，`--name-only` 没有任何路径 ⇒ 与 `origin/main` 无冲突、无重叠改动面；tree OID 随提交内容变化（本页每改一次都会变），故只报形态、不复述具体值 |

闸门 2 与 6 的判定面都来自**提交**（`git diff merge-base..HEAD`）：分支上还没有提交时，闸门 2 会以「base 与 HEAD 同一提交 …… 不允许静默通过」拒绝——我第一次跑正是撞在这条上，那是该闸门自己的自证而不是锚点问题，所以上表读数都是提交之后跑的。

## 5 本页的边界

本页只提供证据：哪一行写了什么、我本机跑出什么读数。**是否判定 `#19` 片1 通过、是否关 `#19`、是否把 `#19` 从 `partial` 抬到 `implemented`，都不是本页的事**，由监工按 `#19` 的完整验收面（含 §3.3、§3.5 的未取得项与 §3.6 的片2 功能面）决定。本 PR 对台账只做"口径同步"：`status` 仍是 `partial`。

同样地，本页不声称上述行号会永久稳定：一旦有人改动 `services/**`、`deploy/**`、`tests/**`，这些锚点会漂移，届时按 `tools/verify-doc-anchors.mjs` 与 `tests/unit/doc-anchor-relocation-identity.test.mjs` 的口径处理。
