-- GY-I19（#19）· 注销去身份：受理事务内擦除账号 PII + 外发台账的第三方引用
--
-- ## 为什么是 SECURITY DEFINER
-- `services/api/db/roles/auth_privacy.sql` 给运行时组 `gengyun_auth_privacy`
-- （`gengyun_api_runtime` 经 `20-login-roles.sql` 继承）的 `public.users` 列权限只有
-- `SELECT (id,state,auth_epoch,revision,wechat_subject_lookup)`、`INSERT (wechat_subject_lookup,wechat_subject_cipher)`
-- 与 `UPDATE (updated_at)`；`public.exports` 只有 `SELECT (user_id)`，**没有**任何 UPDATE。
-- 而「注销请求受理即去身份」要求同一事务把 `users.nickname` / `users.avatar_media_id` /
-- `users.wechat_subject_cipher` / `users.wechat_subject_lookup` 置空、把
-- `exports.provider_request_ref_cipher` 置空（`docs/implementation-requirements.md` 的
-- F13 取证材料要求「台账行保留、PII 不按日历留存」）。直接写必然 42501。
--
-- 两条替代路径都被否决：给运行时角色补 `UPDATE(nickname, avatar_media_id, wechat_subject_cipher,
-- wechat_subject_lookup, deletion_generation)` 列权（等于把「改昵称/改微信主体」变成运行时可做的
-- 普通写，最小权限面显著变宽，且绕过 `90-assert-least-privilege.sql` 的 `protected_columns` 口径）；
-- 或在 API 进程里再开一条特权连接（攻击面与部署复杂度更大，且会与受理函数的行锁打架——见下）。
-- 选定第三条：把这两处写入收进**唯一一个窄口径函数** `public.deidentify_account(p_user_id uuid)`，
-- 属主是迁移管理员（`gengyun_cvm_owner`，即本迁移执行者），函数体内因此具备所需列权限，
-- 而运行时角色**只**拿到 EXECUTE。运行时角色对上述四列与 `exports` 仍然没有任何直接写权限。
--
-- ## 四条硬条件（逐条落实位置）
-- 1. `SET search_path = pg_catalog`（**固定**，不写 `public`、不用 `$user`）⇒ 见函数定义；
--    函数体内所有对象都写全限定名（`public.users` / `public.exports`），
--    连类型也写 `public.user_state` —— `search_path=pg_catalog` 下不限定就是 42P01。
-- 2. `REVOKE ALL ... FROM PUBLIC`（本文件末尾）+ 只 `GRANT EXECUTE ... TO gengyun_api_runtime`
--    （`deploy/postgres-cvm/sql/20-login-roles.sql`：该角色在迁移之后才创建，故授权放那里）。
-- 3. `90-assert-least-privilege.sql` 只**新增函数级契约断言**（函数存在/`prosecdef`/
--    `proconfig` 固定 `search_path`/属主正确/EXECUTE 恰好 owner + 运行时角色），
--    **不**给运行时角色补任何列权限。
-- 4. 反向控制：以 `gengyun_api_runtime` 直接
--    `UPDATE public.users SET nickname = NULL` 或直接 `SELECT nickname` 仍必须 `permission denied`。
--
-- ## 事务边界（与判定 §3.2 逐条对齐）
-- 本函数**不自己开事务**，必须由受理路径在**已经 `BEGIN` 的那个事务里、用同一个连接**调用
-- （`services/api/src/privacy/deletion-requests-pg.ts` 的 `createRequest()`：`CALL_FUNCTION_SQL`
-- 之后、`COMMIT` 之前）。原因有二：
--   ① 原子性 —— 去身份与「账号改 deletion_pending + 撤销会话 + 请求落库」同生共死：
--      任一步失败整体 ROLLBACK ⇒ 零写入、**不**签发 202（fail-closed）。
--   ② 行锁 —— 受理函数已 `SELECT ... FOR UPDATE` 锁住该 `public.users` 行；换连接再写同一行
--      会在 `lock_timeout='4s'` 之后 55P03 自死锁。故本函数**不再**自建连接、
--      也**不**依赖调用方传锁（同事务内 `FOR UPDATE` 可重入）。
-- 不在本函数内：状态迁移/auth_epoch（属 `request_account_deletion`）、
-- 删除 `media` 行、备份副本清单写入（属 `#19` 后续片）。
--
-- ## 模块内 SQL 错误码（沿用仓内既有 G 码约定：适配层把 G 码映射到契约错误码）
--   G0001 INVALID_REQUEST       `p_user_id IS NULL`
--   G0002 NOT_FOUND             主体不存在
--   G0015 PROVIDER_UNAVAILABLE  账号状态不是 deletion_pending（本函数只在受理事务内合法）
-- 映射表在 `services/api/src/privacy/deletion-requests-pg.ts` 的 `mapDeletionError()`，
-- **不新增契约错误码**（`packages/contracts/openapi.json` 的 `DeletionReceipt` 是
-- `additionalProperties: false`，去身份读数只回给服务端记录，不进 HTTP 体）。
--
-- ## 幂等与并发
-- 第二个 `UPDATE public.users` 的 `WHERE ... AND (任一 PII 列 IS NOT NULL)` 是幂等的唯一依据：
-- 首次擦除后四列全 NULL ⇒ 再调用匹配 0 行 ⇒ `identity = 0`、`deletion_generation` **不再自增**
-- （计数器只为「真发生过擦除」前进，供取消注销/审计判断是否已去身份）。
-- `public.exports` 同理：`provider_request_ref_cipher IS NOT NULL` 的谓词保证重复调用不改
-- `updated_at`，不制造假「最近有外发」的时间戳。
-- 并发：同一账号的并发调用被受理函数的行锁串行化；后到者重读到的仍是 deletion_pending，
-- 于是走 `identity = 0` 的幂等分支，不会二次自增 generation。
--
-- ## 明确不动的东西（改这些会破坏既有契约）
--   ⛔ `public.exports.recipient_id`（NOT NULL）、`object_key` / `object_id`
--      （`0015` 的双向 XOR 约束 `exports_object_ident_xor`）—— 它们是与第三方对账所需的
--      证据链，不是自然人身份；本函数只清 `provider_request_ref_cipher` 与 `updated_at`。
--   ⛔ `public.export_writebacks` —— 无 PII 列（回写台账只记「回写了 0 行」的证据）。
--   ⛔ `public.users.revision` —— 本文件函数体里**不出现**该列：`revision` 只由受理函数推进，
--      若这里也 +1，202 回执里的 `accountRevision` 会掉队一格。

BEGIN;

-- 唯一写路径：注销去身份（四列擦除 + 外发台账第三方引用擦除，返回实测读数）。
CREATE FUNCTION public.deidentify_account(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_state public.user_state;
  x_generation integer;
  x_generation_before integer;
  x_identity integer;
  x_exports integer;
BEGIN
  -- 入参自检：NULL 不是「查不到」，是调用方 bug ⇒ G0001。
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- 行锁 + 状态门：本函数只允许在受理事务内对该账号执行。
  -- `FOR UPDATE` 与受理函数同事务可重入（不换连接，见头注释「事务边界」）。
  SELECT u.state, u.deletion_generation
    INTO x_state, x_generation
    FROM public.users u
   WHERE u.id = p_user_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;
  -- 非 deletion_pending（active/suspended/deleted）⇒ 去身份没有合法依据，确定性失败。
  IF x_state <> 'deletion_pending' THEN
    RAISE EXCEPTION USING ERRCODE = 'G0015', MESSAGE = 'PROVIDER_UNAVAILABLE';
  END IF;

  x_generation_before := x_generation;

  -- ① 账号 PII 四列擦除（唯一索引 `users_subject_lookup_key` 对 NULL 不去重，
  --    故同一微信主体再扫码会走 `createUser()` **新建**账号，不会与这行冲突）。
  --    `deletion_generation + 1` 只在「真擦过」时前进：WHERE 的 `IS NOT NULL` 谓词
  --    让重复调用匹配 0 行 ⇒ 幂等。
  UPDATE public.users
     SET nickname = NULL,
         avatar_media_id = NULL,
         wechat_subject_cipher = NULL,
         wechat_subject_lookup = NULL,
         deletion_generation = deletion_generation + 1,
         updated_at = now()
   WHERE id = p_user_id
     AND (nickname IS NOT NULL
          OR avatar_media_id IS NOT NULL
          OR wechat_subject_cipher IS NOT NULL
          OR wechat_subject_lookup IS NOT NULL)
  RETURNING deletion_generation INTO x_generation;
  GET DIAGNOSTICS x_identity = ROW_COUNT;

  -- 0 行被改 ⇒ RETURNING 没赋值（变量被置 NULL）⇒ 回落到擦除前的读数。
  x_generation := COALESCE(x_generation, x_generation_before);

  -- ② 外发台账：只清第三方的请求引用密文（可用来向收方反查「谁发的」的那一列）。
  --    ⛔ 不动 recipient_id / object_key / object_id / export_writebacks（见头注释）。
  UPDATE public.exports
     SET provider_request_ref_cipher = NULL,
         updated_at = now()
   WHERE user_id = p_user_id
     AND provider_request_ref_cipher IS NOT NULL;
  GET DIAGNOSTICS x_exports = ROW_COUNT;

  -- 返回**实测**读数（条数取自 GET DIAGNOSTICS，generation 取自 RETURNING/COALESCE），
  -- 供受理层与真 PG 证据逐字核对。`state` 是状态门的实测值，便于审计确认调用时机。
  RETURN jsonb_build_object(
    'userId', p_user_id,
    'state', x_state,
    'identity', x_identity,
    'exports', x_exports,
    'generation', x_generation
  );
END;
$$;

-- 硬条件 2（前半）：PUBLIC 一律不得执行；唯一的 EXECUTE 授予放在
-- `deploy/postgres-cvm/sql/20-login-roles.sql`（`gengyun_api_runtime` 在该步才创建）。
REVOKE ALL ON FUNCTION public.deidentify_account(uuid) FROM PUBLIC;

COMMIT;
