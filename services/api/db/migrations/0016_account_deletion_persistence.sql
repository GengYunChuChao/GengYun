-- GY-I19（#19）· 注销请求持久化 + 同一事务内撤销（会话）+ auth_epoch 递增
--
-- ## 为什么是 SECURITY DEFINER（裁定一，逐字结论）
-- `services/api/db/roles/auth_privacy.sql` 授予运行时角色 `gengyun_api_runtime` 的
-- `public.users` 列权限**只有** `SELECT (id,state,auth_epoch,revision,wechat_subject_lookup)`
-- 与 `UPDATE (updated_at)`；`public.sessions` 只有 `UPDATE (token_hash,revoked_at)`；
-- 对 `public.deletion_requests` **零授权**。而 `docs/architecture/state-contract.md`
-- 要求「注销请求 202 的返回在**同一事务**将账号改 deletion_pending、撤所有用户会话/角色、
-- auth_epoch 递增、插入删除请求」。三处写入因此必然被 PG 拒绝（`42501`）。
--
-- 两条替代路径都被裁定否决：放宽最小权限断言（弱化安全保证）或在 API 进程里再开一条特权连接
-- （攻击面与部署复杂度更大）。选定第三条：把这三处写入收进**唯一一个窄口径函数**
-- `public.request_account_deletion(...)`，函数属主是**迁移管理员**（`gengyun_cvm_owner`，
-- 即本迁移的执行者），因此函数体内具备所需列权限，而运行时角色**只**拿到 EXECUTE。
-- 效果：运行时角色对 `users.state`/`auth_epoch`/`revision` 与 `deletion_requests`
-- 仍然**没有任何直接列权限**（`deploy/postgres-cvm/sql/90-assert-least-privilege.sql`
-- 的 `protected_columns` 与新增的函数级断言同时把这条钉死），唯一写路径收敛到一个可断言的函数。
--
-- ## 四条硬条件（逐条落实位置）
-- 1. `SET search_path = pg_catalog`（**固定**，不写 `public`、不用 `$user`）⇒ 见函数定义；
--    函数体内所有对象都写全限定名（`public.users` / `public.sessions` / `public.deletion_requests`）。
-- 2. `REVOKE ALL ... FROM PUBLIC`（本文件末尾）+ 只 `GRANT EXECUTE ... TO gengyun_api_runtime`
--    （`deploy/postgres-cvm/sql/20-login-roles.sql`：该角色在迁移之后才创建，故授权放那里）。
-- 3. `90-assert-least-privilege.sql` 只**新增函数级契约断言**（函数存在/`search_path` 已固定/
--    属主正确/EXECUTE 仅授予运行时角色），**不**给运行时角色补任何列权限。
-- 4. 反向控制：以 `gengyun_api_runtime` 直接
--    `UPDATE public.users SET auth_epoch = auth_epoch + 1` 仍必须 `permission denied`。
--
-- ## 事务边界（与判定 §3.2 逐条对齐）
-- 本函数**整体在一个语句/一个事务内**执行，恰好包住三处写入：
--   ① `UPDATE public.users`：`state='deletion_pending'` + `auth_epoch+1` + `revision+1`；
--   ② `UPDATE public.sessions`：该用户**全部**活跃会话 `revoked_at` 落值；
--   ③ `INSERT INTO public.deletion_requests`：注销请求落库（含属主与回执摘要/期限）。
-- **不在**本函数内（也不在本次事务内）：回执 bearer 明文签发、`Idempotency-Key` 台账写入
-- （既有 24h 台账语义，见 `services/api/src/routes/support.ts` 的 `runIdempotent()`）。
-- 本迁移**不建 outbox 表**（裁定三：main 上既无 outbox 表也无消费者，建表就是空承诺）。
--
-- ## 模块内 SQL 错误码（沿用仓内既有 G 码约定：每个模块在自己的适配层把 G 码映射到契约错误码）
--   G0001 INVALID_REQUEST      参数非法（含回执摘要格式、期限倒挂、截止时间倒挂）
--   G0002 NOT_FOUND            主体不存在
--   G0003 REVISION_CONFLICT    该账号的注销请求**已在受理中**（并发双受理的确定性失败面）
--   G0004 ACCOUNT_INACTIVE     账号状态不是 active（suspended/deleted）
-- 映射表在 `services/api/src/privacy/deletion-requests-pg.ts`，**不新增契约错误码**。
--
-- ## 幂等与并发
-- `SELECT ... FOR UPDATE`（行锁）+ 状态门 ⇒ 同一账号的并发受理被串行化：第二个事务重读到的
-- 必然是 `deletion_pending`，于是走 G0003 确定性失败，**不会**出现第二次 `auth_epoch+1`
-- 或第二条 `deletion_requests` 行。`deletion_requests_receipt_hash_key`（0003 已建）继续
-- 兜住同一回执摘要重复插入（`23505`）。

BEGIN;

-- ① 注销请求必须能反查属主：进程重启后仍要能回答「这条请求属于谁」。
--    ⛔ 不建第二套表、不动 0003 既有列语义。
ALTER TABLE public.deletion_requests
  ADD COLUMN user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  -- 回执 bearer 的签发/到期时刻（35 日 TTL）。在此之前回执摘要（receipt_hash）**没有期限**，
  -- 无法回答「这枚 bearer 还有效吗」；现在与删除请求同事务落库。
  ADD COLUMN receipt_issued_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN receipt_expires_at timestamptz NOT NULL,
  ADD CONSTRAINT deletion_requests_receipt_validity CHECK (receipt_expires_at > receipt_issued_at);

-- 按属主取最新请求（跨用户隔离的读取形状：必须带 user_id 条件）。
CREATE INDEX deletion_requests_user_requested_idx
  ON public.deletion_requests (user_id, requested_at DESC, id DESC);

-- ② 唯一写路径：注销受理（状态迁移 + auth_epoch 递增 + 全会话撤销 + 请求落库）。
CREATE FUNCTION public.request_account_deletion(
  p_id uuid,
  p_user_id uuid,
  p_receipt_hash text,
  p_generation integer,
  p_requested_at timestamptz,
  p_online_due_at timestamptz,
  p_backup_due_at timestamptz,
  p_receipt_issued_at timestamptz,
  p_receipt_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_before public.users;
  x_after public.users;
  x_request public.deletion_requests;
  x_revoked integer;
BEGIN
  -- 入参自检：非法即 G0001（不把 CHECK 违反当成「服务器错误」外泄）。
  -- `requested_at`/截止时刻/回执期限由**受理服务**以与回执同源的时钟计算并传入
  -- （`packages/privacy/deletion.mjs` 的 `createDeletionRequest()` 不接受外部 id/时间戳注入，
  -- 故以进程内已生成的值为准，避免同一请求出现两套时间）。
  IF p_id IS NULL OR p_user_id IS NULL OR p_receipt_hash IS NULL
     OR p_generation IS NULL OR p_generation < 1
     OR p_requested_at IS NULL OR p_online_due_at IS NULL OR p_backup_due_at IS NULL
     OR p_receipt_issued_at IS NULL OR p_receipt_expires_at IS NULL
     OR p_receipt_hash !~ '^[0-9a-f]{64}$'
     OR p_receipt_expires_at <= p_receipt_issued_at
     OR p_online_due_at < p_requested_at
     OR p_backup_due_at < p_online_due_at
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- 行锁：并发双受理在此串行化（后到的事务重读最新行 ⇒ 必然看到 deletion_pending）。
  SELECT * INTO x_before FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;
  -- 已在受理中 ⇒ 幂等/并发冲突（确定性失败面，不重复递减权利、不重复撤销）。
  IF x_before.state = 'deletion_pending' THEN
    RAISE EXCEPTION USING ERRCODE = 'G0003', MESSAGE = 'REVISION_CONFLICT';
  END IF;
  -- 非 active（suspended/deleted）⇒ 账号不可用。语义与
  -- `services/api/src/auth/middleware.ts` 的状态门**同码同义**（403 ACCOUNT_INACTIVE）。
  IF x_before.state <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'G0004', MESSAGE = 'ACCOUNT_INACTIVE';
  END IF;

  -- ① 账号状态迁移 + auth_epoch 递增（既有会话立即失效的**唯一**依据）+ revision 前进。
  UPDATE public.users
     SET state = 'deletion_pending',
         auth_epoch = auth_epoch + 1,
         revision = revision + 1,
         updated_at = now()
   WHERE id = p_user_id
  RETURNING * INTO x_after;

  -- ② 撤销该用户**全部**活跃会话（不是当前一个）：这是「401 SESSION_EXPIRED」的成因，
  --    与 auth_epoch 造成的 403 是两个可分离的机制（判定 §5「两者都真、不得混用」）。
  UPDATE public.sessions
     SET revoked_at = now()
   WHERE user_id = p_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS x_revoked = ROW_COUNT;

  -- ③ 注销请求落库（同一事务）：属主 + 回执摘要 + 期限 + 在线 7 日/备份 30 日截止。
  INSERT INTO public.deletion_requests (
    id, user_id, receipt_hash, generation, state, requested_at,
    online_due_at, backup_due_at, revision, receipt_issued_at, receipt_expires_at
  ) VALUES (
    p_id, p_user_id, p_receipt_hash, p_generation, 'requested', p_requested_at,
    p_online_due_at, p_backup_due_at, 1, p_receipt_issued_at, p_receipt_expires_at
  )
  RETURNING * INTO x_request;

  -- 返回**实测**读数（状态/epoch 取自 UPDATE ... RETURNING，不靠算术推断；
  -- 撤销条数取自 GET DIAGNOSTICS），供受理层与真 PG 证据逐字核对。
  -- 时刻一律显式格式化为 UTC 的 ISO-8601（`to_char(...)`）而不是直接放 timestamptz：
  -- timestamptz 的 JSON 文本形态受会话 `DateStyle` 影响（默认 `ISO, MDY` 出来是
  -- `2026-10-30 12:34:56.789+00`，带空格、不带秒的小数点分隔规范），
  -- 直接交给 Node 侧 `new Date()` 解析会变成实现细节依赖。此处把契约钉死为
  -- `YYYY-MM-DDTHH:MM:SS.mmmZ`，与 Node 的 `Date#toISOString()` 同形。
  RETURN jsonb_build_object(
    'id', x_request.id,
    'user_id', x_request.user_id,
    'state', x_request.state,
    'revision', x_request.revision,
    'requested_at', to_char(x_request.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'online_due_at', to_char(x_request.online_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'backup_due_at', to_char(x_request.backup_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'receipt_issued_at', to_char(x_request.receipt_issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'receipt_expires_at', to_char(x_request.receipt_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'account_state', x_after.state,
    'auth_epoch', x_after.auth_epoch,
    'account_revision', x_after.revision,
    'revoked_sessions', x_revoked
  );
END;
$$;

-- 硬条件 2（前半）：PUBLIC 一律不得执行；唯一的 EXECUTE 授予放在
-- `deploy/postgres-cvm/sql/20-login-roles.sql`（`gengyun_api_runtime` 在该步才创建）。
REVOKE ALL ON FUNCTION public.request_account_deletion(uuid,uuid,text,integer,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) FROM PUBLIC;

COMMIT;
