# PR-4b · 停用守卫：把「无处可挂」变成可执行断言（2026-10-26）

> **一句话结论**：裁定⑤后半句「凡会使最后管理者失效的管理员**停用/删除**路径也须共享同一守卫」里，**「停用/删除管理员」这条产品路径当前根本不存在**——全仓对 `admin_accounts` 的写只有两处 revision bump 和一条建号 INSERT，没有 state 变更、没有删除、也没有触发器；而迁移 `0017` 的 `public.suspend_account(...)` 作用对象是 `public.users`（终端用户），与 `admin_accounts` 不是同一实体。所以「停用最后一名持有者导致权限永久锁死」这条担忧**没有触发面**：守卫今天只需要覆盖**撤销**路径（`0041` 已覆盖，`G0009`），将来真要有管理员停用路径，**新建带同一把 advisory 锁的迁移**，⛔ 不是去改 `suspend_account`。本片不改任何库代码，只把上面这段推理钉成三组可执行断言。

| 项 | 值 |
| --- | --- |
| 仓库 / 基线 | `GengYunChuChao/GengYun` · 分支 `feat/gy-r64-pr4b-suspend-guard`，基线 `a7dc03f3`（= PR #646 head，其 base 是 main `60cab9fe`） |
| 切片档位 | 只改 `tests/**`（已接线文件内**追加**一组断言）+ 新增本页；不改迁移、不改契约、不改 CI、不改台账 |
| 断言落点 | `tests/integration/admin-accounts-read-pg.mjs`（已在 `.github/workflows/real-pg-integration.yml:269` 逐文件登记） |
| 为什么落在这个文件 | 该 workflow 是**逐文件列举**跑 `tests/integration/*.mjs`，新建文件 CI 根本不会执行（跑不到的臂 = 没验证）。本文件已同时拿到 owner 与 runtime 两个连接串，并已有 `seedScopeAdmin()` 帮手 |
| 证据性质 | 三组都是**真库读数**（本机 PG 17.11），不是内存替身：停用事务提交后两张表的联合读数、事务可见性与 `ROLLBACK` 语义只有真库能给 |

## 1. 为什么 ⑤ 这半句是「无触发面」

三条相互独立的事实，逐条都能在仓内当场复核：

1. **`admin_scopes` 的写路径只有一条（函数）。** 表定义在 `services/api/db/migrations/0001_initial_schema.sql:89-96`；写入只有迁移 `0041` 的 `public.grant_admin_scope()`（`services/api/db/migrations/0041_admin_scope_write_authority.sql:199`）与 `public.revoke_admin_scope()`（`services/api/db/migrations/0041_admin_scope_write_authority.sql:352`）。运行时角色对这张表连表级写权限都没有，唯一入口是那两个 `SECURITY DEFINER` 函数的 EXECUTE。
2. **`admin_accounts` 没有任何产品路径能改 `state`，更不能删。** 全仓（迁移 + `services/**` + `deploy/**`）对 `admin_accounts` 的写只有三处：`services/api/db/migrations/0041_admin_scope_write_authority.sql:312` 与 `:466` 两处 `revision = revision + 1`（授权 / 撤销各一次的 revision bump），以及 `services/api/src/auth/store.ts:383-386` 的一条 `INSERT`（建号，`state` 落 `admin_state` 的默认值 `active`）。**没有** `SET state = …`、**没有** `DELETE`、**没有**触发器（全迁移目录 `ON public.admin_accounts` / `ON public.admin_scopes` 命中 0 处）。
3. **`suspend_account` 停的不是管理员。** `services/api/db/migrations/0017_account_suspend_authority.sql:134-143` 定义 `public.suspend_account(p_actor_id, p_audit_id, p_user_id, p_expected_revision, p_request_id)`，函数体（`services/api/db/migrations/0017_account_suspend_authority.sql:194-216`）只碰三张表：`public.users`（状态迁移 + `auth_epoch+1` + `revision+1`）、`public.sessions`（撤该用户全部活跃会话）、`public.admin_audit_events`（写审计）。`admin_accounts` / `admin_scopes` 在函数体里**一次都没出现**——它的主体参数 `p_user_id` 是 `public.users.id`。

⇒ 结论：**「停用最后一名 `scopes:write` 持有者 ⇒ 有效持有者归零 ⇒ 永久锁死」这条因果链在今天的代码里连第一步都走不通**（没有能停用管理员的路径）。⑤ 后半句不是「还没接上守卫」，而是「这条路径尚不存在，没有东西可挂」。

这也解释了 `0041` 自己在文件头（第 37–41 行注释）写下的分片边界：明确记录「本片只覆盖**撤销**这一条路径」，并说明若要让 `suspend_account` 同取那把 advisory 键，必须是**新迁移**替换/包装该函数——本片不但没做，而且证明了**今天是零工作量**：没有管理员停用路径，就没有需要共享守卫的第二个入口。

## 2. 三组断言各钉住什么

三组都在 `tests/integration/admin-accounts-read-pg.mjs` 的 `[G]` 段（入口 `async function suspendGuardEvidence()`，`tests/integration/admin-accounts-read-pg.mjs:693`），跑在既有 `[W1]`–`[W5]` 之后（它会归一化持有者数量，跑在前面会冲掉写面用例的并发前置）。

| 编号 | 位置 | 钉住的事实 | 什么情况下会红 |
| --- | --- | --- | --- |
| **[G1]** 实体分离（主断言） | `tests/integration/admin-accounts-read-pg.mjs:746-774` | 造 2 名 `state='active'` 且各持 `scopes:write` 的管理员 ⇒ 记 `SELECT count(*) FROM admin_scopes WHERE scope='scopes:write' AND revoked_at IS NULL` = **2** ⇒ 对**同数量**（2 行）`public.users` 调停用（走产品端口 `createPostgresAccountAuthority(...).suspend(...)`，调用形态与 `tests/integration/account-suspend-pg.mjs:525` 一致）⇒ 同一个 count **仍是 2**；两名管理员的 `admin_accounts` 行 `state` 仍 `'active'`、`revision` 一位没动 | 一旦有人把停用实现成「顺带撤销 `admin_scopes`」或「把管理员 `state` 改成 `suspended`」，count 或 `admin_accounts` 读数立刻偏离 |
| **[G2]** 零持有者也不因停用而变 | `tests/integration/admin-accounts-read-pg.mjs:776-799` | 先用**直接 SQL** 把 `scopes:write` 撤到 **0** 持有者（这是唯一能归零的方式：走 `revoke_admin_scope()` 必被 `G0009` 拒绝，`[W4]` 已证明）⇒ 再停用 2 行 `public.users` ⇒ count 仍是 **0**，且**不抛任何错误** | 有人在停用路径上挂隐式守卫（比如「元权限为 0 就拒绝任何后台动作」），这里会抛错变红 |
| **[G3]** 负控制（只红这一条） | `tests/integration/admin-accounts-read-pg.mjs:801-833` | 在**独立事务**里人为把「停用顺带撤销」做出来（`UPDATE admin_scopes SET revoked_at = now() WHERE scope='scopes:write' AND revoked_at IS NULL` ——与 `[G2]` 同形，只动仍然有效的行）⇒ 主断言口径必读到 **0**（守卫口径同样 0）⇒ `ROLLBACK` 复原 ⇒ 回到 **2** | 如果这条负控制**不红**，说明主断言读的根本不是这张表/这个条件，[G1] 就是空断言 |

两条防「空断言」的反向自证（不写出来这组证据会自己骗自己）：

- **[G1]/[G2] 的停用都必须真的生效**：每次停用都断 `outcome.changed === true`，[G1] 还回查 `public.users` 里这 2 行确实已 `suspended`。否则「停用之后 count 没变」可能只是**停用压根没发生**（什么都没做当然不会变）。
- **[G1] 先固定起点**：[G] 段开头用直接 SQL 把历史 `scopes:write` 有效持有者全部撤销（⛔ 不走函数，撤最后一名会被 `G0009` 拒），让计数从确定的 **0** 起手，再由本组自己造 2 名持有者 ⇒ 后面的「2」不是继承来的偶然值。

## 3. 负控制证明了什么

[G3] 证明的不是「代码正确」，而是**这条断言有能力变红**：它先在一个独立连接上 `BEGIN`，把「停用会牵动 `admin_scopes`」这件事人为造出来（模拟一种错误实现：停用管理员时顺带撤销其元权限），在主断言**同一口径、同一 SQL** 下读到 0，然后 `ROLLBACK`，再读到 2。

- **只红这一条**：其余读数（[W1]–[W5]、[G1]、[G2]）在负控制期间不受影响，说明变红的原因确实是「有人动了 `admin_scopes`」而不是环境噪声。
- **变异不落库**：`UPDATE` 只活在那个事务里，`ROLLBACK` 之后库里没有一行被改；变异**不在**最终代码里，也不在迁移里。它是一个「如果实现错了，断言会长什么样」的现场演示，而不是一段被注释掉的危险代码。
- 换句话说：**若把管理员停用实现成顺带撤销 `scopes:write`，[G1] 的主断言会红。** 这就是「无触发面」这句话的可执行版本——今天绿，是因为没有人能触发；不是因为断言写松了。

## 4. 真要有管理员停用路径，应当怎么加（⛔ 而不是改 `suspend_account`）

将来若真要停用后台管理员，正确做法是**新开一条迁移**，并且让它与撤销路径共享**同一把** advisory 锁，而不是去改 `0017`：

```sql
-- 新迁移（编号接着往后排）：管理员停用的唯一写路径
CREATE OR REPLACE FUNCTION public.suspend_admin_account(
  p_actor_id uuid, p_target_id uuid, p_reason text, p_revision integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER                       -- 与 0017 / 0041 同一条已裁定路线
SET search_path = pg_catalog           -- 固定 search_path，函数体内全限定名
AS $$
BEGIN
  -- ① 与 grant/revoke 同一把键（0041 已在用这一把）⇒ 授/撤/停用三者互斥：
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_scope:' || 'scopes:write', 18040));

  -- ② 锁内**重新**计数（不是应用层先数后写）：
  --    UPDATE admin_accounts SET state='suspended' ...
  --    然后对「revoked_at IS NULL 且 state='active'」的 scopes:write 持有者重新 count
  IF x_holders = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'G0009', MESSAGE = 'LAST_SCOPE_MANAGER';  -- 映射 409
  END IF;
  -- ③ 回滚该管理员的全部 admin_sessions + 审计，与状态变更同一事务
END;
$$;
REVOKE ALL ON FUNCTION public.suspend_admin_account(uuid, uuid, text, integer) FROM PUBLIC;
```

为什么⛔ 不能改 `suspend_account`：

- 它停的是 `public.users`（终端用户）+ `sessions`，与 `admin_accounts` **不是同一实体**；往里塞管理员逻辑会把两个实体焊死，也让「终端用户停用」这条已验收路径重新变红。
- 给它补 actor 权限核验会打红 `tests/integration/account-suspend-pg.mjs` 的**合成 actor 直调**（该臂故意用合成 actor 直接驱动端口）。
- `0017` 是已合入的迁移，⛔ 一个字节都不该改（改历史迁移 = 已部署环境与库内对象不一致）。
- 锁键必须与 `0041` 一致（`hashtextextended('admin_scope:' || p_scope, 18040)`，见 `services/api/db/migrations/0041_admin_scope_write_authority.sql:235`），否则「停用」与「撤销」两条路径可以并发穿过去，守卫等于没有。

## 5. 本片边界（没做的事）

- ⛔ 不改任何迁移、⛔ 不动 `0017`、⛔ 不 `CREATE OR REPLACE public.suspend_account`。
- ⛔ 不在 `admin_accounts` 上加触发器、⛔ 不给 `suspend_account` 补 actor 权限核验。
- ⛔ 不新建 `tests/integration/*.mjs`（CI 逐文件列举，新文件就是跑不到）。
- ⛔ 不动 `tests/integration/moderation-ledger-pg.mjs`（PR #649 正在改，会冲突）。
- 负控制的变异**只存在于一个随后 `ROLLBACK` 的事务里**，不留在代码中。

## 6. 台账（`docs/architecture/contract-status.json`）为什么没动

`git diff --name-only 60cab9fe a7dc03f3` 显示 PR #646 已经改过 `docs/architecture/contract-status.json` ⇒ 本片按派单要求**不碰那份台账**，避免与 #646 的锚点漂移撞车。本页 + `[G]` 段的注释就是「无触发面」这句话的登记处。

## 7. 真库读数（原始）

```
node tests/integration/admin-accounts-read-pg.mjs <owner-url> <runtime-url>
[G1] 实体分离：停用前 holders=2（active 各 1 次 revision=1/1） ⇒ 对 2 行 public.users 停用（changed=true×2）⇒ holders 仍 2，两名管理员 state 仍 active、revision 未动
[G2] 零持有者：SQL 直撤到 0 ⇒ 再停用 2 行 public.users（changed=true×2、零错误） ⇒ holders 仍 0（停用路径上没有隐式守卫）
[G3] 负控制：事务内「停用顺带撤销」⇒ 计数 2→0；ROLLBACK 后回到 2（若把停用实现成顺带撤销，[G1] 的主断言会红；变异未留在代码里）
```

（本机 PG 17.11，端口在 55000–56499 内自选；跑完停实例、删临时库目录，零残留。该文件整体 exit=0 时，末段结论行会一并带上本页这三组。）
