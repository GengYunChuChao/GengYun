-- GY-I19（#19 片B）· 回执 bearer 台账持久化
--
-- ## 为什么需要本迁移
-- `services/api/src/privacy/account-deletion.ts` 的 `DeletionReceiptRegistry` 是**进程内**
-- 台账（`tokenHash → requestId` 只存内存，明文与摘要都不落库）。受理事务（0016）只把
-- `deletion_requests.receipt_hash`（受理输入摘要，作 DB 级唯一性防重）与
-- `receipt_issued_at`/`receipt_expires_at`（回执期限）落库，**没有**把「真正发给客户端的
-- 回执 bearer 摘要」落库。因此进程重启后，旧回执 bearer 一律反查不到（旧回执 id 不可达）。
--
-- 本迁移把回执 bearer 摘要落到 `deletion_requests.receipt_bearer_hash`，并给运行时角色
-- 三条**窄口径 SECURITY DEFINER 函数**（set / resolve / count）作为唯一读写路径——
-- 与 0016 / 0031 / 0034 / 0035 的口径一致：运行时对 `deletion_requests` 仍然**零表级、零列级
-- 直接权限**（`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的 protected_columns 与
-- 函数级断言逐字不动），唯一读写路径收敛到可断言的函数。
--
-- ## 为什么是单独的 `receipt_bearer_hash` 列而不是复用 `receipt_hash`
-- `receipt_hash` 是 `requestDeletionFor()` 传入的**受理输入摘要**，被 `tests/integration/
-- account-deletion-pg.mjs` 冻结为「库内摘要 ≠ 回执 bearer 明文摘要（两者是不同凭据）」；
-- 回执 bearer 是受理后由台账**另发**的另一枚随机 token。把两者合并会推翻那条冻结断言，
-- 也改变「受理输入摘要」与「签发摘要」各自独立的语义。故新增一列承载后者，前者的列语义不动。
--
-- ## 事务边界
-- `set_deletion_receipt` 的写（set/clear）是**单条 UPDATE**（同一事务内完成）；调用方
-- （`createPostgresDeletionReceiptRegistry`）沿用 `deletion-requests-pg.ts` 的错误映射口径
-- （`G0001` ⇒ `INVALID_REQUEST`、`23505` ⇒ `REVISION_CONFLICT`、瞬时类 ⇒ 可重试、权限/函数缺失 ⇒
-- 不可重试的 `PROVIDER_UNAVAILABLE`），本迁移不新增契约错误码。

BEGIN;

-- 回执 bearer 摘要（sha256 hex，64 位）。可空：受理后尚未换发/已作废时为 NULL。
-- 与 `receipt_hash`（受理输入摘要）**分离**：前者是受理唯一性防重，后者是「真正发给客户端的 bearer」摘要。
ALTER TABLE public.deletion_requests
  ADD COLUMN receipt_bearer_hash char(64);

-- 同一时刻每枚 bearer 摘要唯一（跨请求复用同一明文摘要 ⇒ 撞唯一索引 ⇒ 23505 确定性失败）。
CREATE UNIQUE INDEX deletion_requests_receipt_bearer_hash_key
  ON public.deletion_requests (receipt_bearer_hash)
  WHERE receipt_bearer_hash IS NOT NULL;

-- 唯一写路径：set（含换发）/ clear 回执 bearer 摘要。
-- `p_token_hash IS NULL` ⇒ 作废该请求名下全部 bearer；否则校验格式与期限后写入（含换发覆盖）。
CREATE FUNCTION public.set_deletion_receipt(
  p_request_id uuid,
  p_token_hash text,
  p_issued_at timestamptz,
  p_expires_at timestamptz
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_updated integer;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  IF p_token_hash IS NULL THEN
    -- clear：作废该请求名下全部 bearer（不删删除请求本身）。
    UPDATE public.deletion_requests
       SET receipt_bearer_hash = NULL
     WHERE id = p_request_id
       AND receipt_bearer_hash IS NOT NULL;
  ELSE
    IF p_token_hash !~ '^[0-9a-f]{64}$'
       OR p_issued_at IS NULL OR p_expires_at IS NULL
       OR p_expires_at <= p_issued_at
    THEN
      RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
    END IF;
    -- set（含换发）：同一请求至多一枚有效 bearer，换发即覆盖旧摘要。
    UPDATE public.deletion_requests
       SET receipt_bearer_hash = p_token_hash,
           receipt_issued_at = p_issued_at,
           receipt_expires_at = p_expires_at
     WHERE id = p_request_id;
  END IF;

  GET DIAGNOSTICS x_updated = ROW_COUNT;
  RETURN x_updated;
END;
$$;

-- 唯一读路径：按摘要反查请求 id；过期即不可解析（不回放、不续期）。
-- `LANGUAGE sql`：函数体在建函数时解析（本迁移先加列、后建函数 ⇒ 列必已存在）。
CREATE FUNCTION public.resolve_deletion_receipt(
  p_token_hash text
) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
  SELECT id FROM public.deletion_requests
   WHERE receipt_bearer_hash = p_token_hash
     AND receipt_expires_at > clock_timestamp()
   LIMIT 1;
$$;

-- 诊断读数：当前有效 bearer 条数（不含明文；供 `liveCount()` 与故障注入反向控制使用）。
CREATE FUNCTION public.count_deletion_receipts()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
  SELECT count(*)::integer FROM public.deletion_requests
   WHERE receipt_bearer_hash IS NOT NULL
     AND receipt_expires_at > clock_timestamp();
$$;

-- 硬条件：PUBLIC 一律不得执行；唯一的 EXECUTE 授予放在
-- `deploy/postgres-cvm/sql/20-login-roles.sql`（`gy-r34-i19-deletion-receipt-grant` 区域，
-- `gengyun_api_runtime` 的 EXECUTE 在该文件按既有口径授予）。
REVOKE ALL ON FUNCTION public.set_deletion_receipt(uuid,text,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_deletion_receipt(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.count_deletion_receipts() FROM PUBLIC;

COMMIT;
