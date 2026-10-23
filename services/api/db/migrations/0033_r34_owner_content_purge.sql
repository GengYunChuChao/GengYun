-- GY-R34 (#19 注销闭集扩展) · 0033
--
-- ## 这个迁移解决什么问题
--
-- 本片把识别域（0025：recognition_jobs / recognition_records / recognition_selections /
-- recognition_idempotency）与语音域（0026：speech_jobs / transcriptions / speech_idempotency）
-- 接进「注销账号时删光用户数据」的删除闭集（闭集从 5 项扩到 7 项，代码侧见
-- services/api/src/privacy/user-data-deletion.ts 的 RECOGNITIONS_DELETION_MODULE /
-- SPEECH_DELETION_MODULE）。
--
-- 清理这些内容需要一个**以属主身份执行**的写路径，原因是硬性事实：
--   · 部署授权（deploy/postgres-cvm/sql/20-login-roles.sql 段 J/K）对运行时角色
--     `gengyun_api_runtime` **不给**这五张正文表的 DELETE —— 且这是**刻意的安全不变量**：
--     `deploy/postgres-cvm/evidence/probe-runtime-grants.sql` 把它们钉成禁止面，
--     deploy-sql-gate 逐条断言「直接 DELETE 必须恰好 42501」（18 条 / 9 个对象）。
--   · PostgreSQL 没有列级 DELETE，所以「能删一列」这种收窄根本不存在；
--     要么表级 DELETE（= 打破上面的不变量），要么经 SECURITY DEFINER 函数。
--
-- 因此这里按 0016（`request_account_deletion`）与 0031（`record_online_purge_evidence`）
-- 的同一套三件套实现清理入口：SECURITY DEFINER + `SET search_path = pg_catalog`
-- （函数体内所有业务对象一律 `public.` 显式限定）+ `REVOKE ALL … FROM PUBLIC`，
-- 由 20-login-roles.sql 只授 EXECUTE 给运行时角色。
--
-- ## 为什么是「两个窄函数」而不是并进 request_account_deletion()
--
-- ① 语义时机不同：受理（202 + 回执）与在线内容清理是分开的两步 —— 闭集每个域的 handler
--    在在线窗口（7 日）内各自执行并各自留证据串；把批量删除并进受理函数会把整批删除压进
--    202 的那个事务里，既拉长 `public.users` 行锁的临界区，也把「在线 7 日」这个对外承诺
--    变成「受理即已清」。
-- ② 逐域取证：回执里每域的证据串（`recognitions:online-purged:N` /
--    `recognitions:idempotency-purged:M`）取自本次删除的**行数**，只有保留「每域一次调用」
--    才留得住；并进受理函数就只能拿到一个总数。
-- ③ 特权面最小：窄函数只删**一个域**、只删**一个主体**，且不碰 users / sessions /
--    deletion_requests 任何一行 —— 即使函数被误用，作用范围也只是「该主体的识别/语音内容」。
--
-- ## 四条硬条件（与 0016 逐条对齐）
--
-- 1. 子先父后：recognition_selections（引 recognition_records）→ recognition_jobs →
--    recognition_records → recognition_idempotency；语音域 speech_jobs → transcriptions →
--    speech_idempotency（两张正文表之间没有外键，顺序按「任务先于正文」的业务语义）。
--    `ON DELETE CASCADE` 只在删 users 行时才会触发，而本仓**没有任何** `DELETE FROM public.users`
--    （注销是状态迁移 deletion_pending，见 0016），所以级联永远不会替我们删这些行 ——
--    必须显式逐表删。
-- 2. 幂等：重复调用返回 0 行、不报错（DELETE … WHERE owner_user_id = p_owner 天然满足）。
-- 3. 只删本人：谓词恒为 `owner_user_id = p_owner`（台账是
--    `left(scope, char_length(p_owner::text) + 1) = p_owner::text || chr(10)`，
--    因为 `auth/idempotency.ts` 的 scope 首段恒为主体 uuid，见
--    `idempotencyScope()` 的注释与 `tests/unit/idempotency-scope-grammar.test.mjs`）。
-- 4. 结构化读数：返回 jsonb，字段名与 `packages/privacy` 与各域 store 的计数端口
--    （`records` / `idempotency`）保持一致，另附分表明细供证据页与真库臂断言。
--
-- ⛔ 本迁移**不**给运行时角色任何表权限，也**不**改任何既有函数。

BEGIN;

-- ---------------------------------------------------------------------------
-- 识别域：recognition_selections / recognition_jobs / recognition_records /
--            recognition_idempotency
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.purge_owner_recognitions(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_selections  integer := 0;
  x_jobs        integer := 0;
  x_recognitions integer := 0;
  x_idempotency integer := 0;
BEGIN
  IF p_owner IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'G0001',
      MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- 子表先删：recognition_selections.recognition_id → recognition_records（CASCADE）
  DELETE FROM public.recognition_selections WHERE owner_user_id = p_owner;
  GET DIAGNOSTICS x_selections = ROW_COUNT;
  DELETE FROM public.recognition_jobs WHERE owner_user_id = p_owner;
  GET DIAGNOSTICS x_jobs = ROW_COUNT;
  DELETE FROM public.recognition_records WHERE owner_user_id = p_owner;
  GET DIAGNOSTICS x_recognitions = ROW_COUNT;

  -- 幂等台账没有主体列，只能按 scope 首段（主体 uuid + 换行）精确前缀删。
  DELETE FROM public.recognition_idempotency
   WHERE left(scope, char_length(p_owner::text) + 1) = p_owner::text || chr(10);
  GET DIAGNOSTICS x_idempotency = ROW_COUNT;

  RETURN jsonb_build_object(
    'records',      x_selections + x_jobs + x_recognitions,
    'idempotency',  x_idempotency,
    'selections',   x_selections,
    'jobs',         x_jobs,
    'recognitions', x_recognitions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_owner_recognitions(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 语音域：speech_jobs / transcriptions / speech_idempotency
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.purge_owner_speech(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_jobs          integer := 0;
  x_transcriptions integer := 0;
  x_idempotency   integer := 0;
BEGIN
  IF p_owner IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'G0001',
      MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- speech_jobs.transcription_id → transcriptions，故任务先于正文。
  DELETE FROM public.speech_jobs WHERE owner_user_id = p_owner;
  GET DIAGNOSTICS x_jobs = ROW_COUNT;
  DELETE FROM public.transcriptions WHERE owner_user_id = p_owner;
  GET DIAGNOSTICS x_transcriptions = ROW_COUNT;

  DELETE FROM public.speech_idempotency
   WHERE left(scope, char_length(p_owner::text) + 1) = p_owner::text || chr(10);
  GET DIAGNOSTICS x_idempotency = ROW_COUNT;

  RETURN jsonb_build_object(
    'records',       x_jobs + x_transcriptions,
    'idempotency',   x_idempotency,
    'jobs',          x_jobs,
    'transcriptions', x_transcriptions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_owner_speech(uuid) FROM PUBLIC;

COMMIT;
