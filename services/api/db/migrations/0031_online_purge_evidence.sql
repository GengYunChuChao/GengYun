-- GY-R32 · #19 片B · **在线清理证据落库 + 回执在线态可推导**（迁移 0031）
--
-- 回滚：services/api/db/migrations/rollback/0031_online_purge_evidence.down.sql
-- （回滚会**删除**已落的在线证据列 —— 那是"撤销这一步"的定义；down 文件头如实写明）
--
-- 口径来源：
--   · 缺口登记：services/api/src/privacy/online-purge-driver.ts 文件头「证据为什么只进报告、不落库」；
--   · 对照实现：services/api/src/privacy/backup-state-derivation.ts（备份侧 completed 必须
--     「未清行 0 + 每行非空 evidence_ref + 证据可复算」，在线侧此前**没有**对应物）；
--   · 迁移号裁定：.pg17/ruling-r32-migration-0031-allocation.md（#483 已合入 ⇒ 允许落 0031）。
--
-- ## 为什么选 B1（可空列 + 窄口径 SECURITY DEFINER 函数）而不是新表
--   1. `public.deletion_requests` 本来就是注销请求的**唯一台账**（0003 建表、0016 补回执期限）；
--      证据挂在同一行上 ⇒ 一个 requestId 一份账，不会出现"第二本账"与它自己的 requestId。
--   2. 运行时角色对 `deletion_requests` 是 **forbidden**（90-assert 第 48 项 + domain_manifest），
--      新表方案要另外给它列级 SELECT，还得再给"到期时刻"开一条读面（`online_due_at` 在同一张禁表上）
--      ⇒ 要么仍是函数、要么放宽 forbidden 分类。B1 只多两个函数，表权限面**一字不动**。
--   3. 证据是**只增不改**的事实清单：放在 `jsonb` 数组里由触发器钉死 append-only，
--      与备份侧"逐行 state='purged' + evidence_ref"同构，但不需要为多模块开 5 张表。
--
-- ## 形状（两个可空列，同一行成对出现）
--   online_purged_at       timestamptz NULL —— 最近一次在线清除证据落库时刻；
--   online_purge_evidence  jsonb       NULL —— append-only 数组，元素：
--     {"module": "favorites", "evidence_ref": "sha256:<64hex>",
--      "removed": 3, "idempotency": 0, "purged_at": "YYYY-MM-DDTHH:MM:SS.mmmZ"}
--   `removed`/`idempotency` 是**真实读数**；`evidence_ref` 由
--   `services/api/src/privacy/online-purge-driver.ts::onlinePurgeEvidenceRef()` 以
--   `(requestId, module, removed, idempotency)` 复算 ⇒ 读路径可以逐条验真（见 online-state-derivation.ts）。
--
-- ## 写入/读取面（唯一两条路径，都只授 EXECUTE）
--   public.record_online_purge_evidence(uuid,text,text,integer,integer,timestamptz)
--     —— 唯一写路径：形状自检（G0001）/ 请求不存在（G0002）/ 同 (module,evidence_ref) 幂等追加。
--        处理器（受理时的在线清除）与到期驱动（tools/purge-expired-online-data.mjs）共用它。
--   public.read_online_purge_evidence(uuid,uuid)
--     —— 唯一读路径：按 (request_id, user_id) 返回 state / online_due_at / online_purged_at / evidence，
--        供 `GET /account/deletions/:id` 的在线态推导（读不到行 ⇒ NULL，由调用方折叠 blocked）。
--   运行时对 `deletion_requests` **仍然零表级零列级权限**（90-assert 的 protected_columns 与第 48 项
--   逐字不动）；两个函数都是 SECURITY DEFINER（属主＝迁移管理员）且固定 search_path。
--
-- ## append-only（触发器，不是口头约定）
--   一旦某行有了证据数组：清空、置 NULL、删条目、改既有条目、缩短长度一律 `G0005`；
--   只允许在**尾部追加**。`online_purged_at` 必须与数组同时为 NULL/非 NULL（CHECK 成对）。
--
-- ## 不变量
--   · 纯 expand：只加两个可空列 + 一个 CHECK 对 + 两个函数 + 一个触发器；不改任何既有列/索引/约束。
--   · 0001..0030 的迁移语义一行不动（不重命名、不回填、不删除）。
-- ----------------------------------------------------------------------------

BEGIN;

ALTER TABLE public.deletion_requests
  ADD COLUMN online_purged_at timestamptz,
  ADD COLUMN online_purge_evidence jsonb;

-- 成对：有证据数组就必须有落库时刻（反之亦然）。写路径总是同时写两列，所以正常数据天然满足。
ALTER TABLE public.deletion_requests
  ADD CONSTRAINT deletion_requests_online_evidence_pair
  CHECK ((online_purged_at IS NULL) = (online_purge_evidence IS NULL));

-- 形状：非 NULL 时必须是**非空数组**（空数组等于"没有证据"，不允许用它冒充"清过了"）。
-- 元素级形状由写函数自检 + 读路径逐条验真（fail-closed：验不过 ⇒ blocked）。
ALTER TABLE public.deletion_requests
  ADD CONSTRAINT deletion_requests_online_evidence_shape
  CHECK (
    online_purge_evidence IS NULL
    OR (jsonb_typeof(online_purge_evidence) = 'array'
        AND jsonb_array_length(online_purge_evidence) >= 1)
  );

-- ---------------------------------------------------------------------------
-- 唯一写路径
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.record_online_purge_evidence(
  p_request_id uuid,
  p_module text,
  p_evidence_ref text,
  p_removed integer,
  p_idempotency integer,
  p_purged_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $fn$
DECLARE
  x_entry jsonb;
  x_id uuid;
  x_evidence jsonb;
BEGIN
  -- 入参自检：非法即 G0001（与 request_account_deletion 的 G 码约定一致：模块内 G 码，
  -- 适配层再映射到契约错误码；⛔ 不把 CHECK 违反当"服务器错误"外泄）。
  IF p_request_id IS NULL
     OR p_module IS NULL
     OR p_module !~ '^[a-z][a-z0-9_]{0,63}$'
     OR p_evidence_ref IS NULL
     OR p_evidence_ref !~ '^sha256:[0-9a-f]{64}$'
     OR p_removed IS NULL OR p_removed < 0
     OR p_idempotency IS NULL OR p_idempotency < 0
     OR p_purged_at IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  x_entry := jsonb_build_object(
    'module', p_module,
    'evidence_ref', p_evidence_ref,
    'removed', p_removed,
    'idempotency', p_idempotency,
    'purged_at', to_char(p_purged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  -- 幂等：同一 (module, evidence_ref) 已经在数组里 ⇒ 不再追加（重试/重放不制造重复证据）。
  -- GREATEST：`online_purged_at` 只前进不后退（早到的重放不得把时刻拉回去）。
  UPDATE public.deletion_requests AS r
     SET online_purge_evidence = CASE
           WHEN r.online_purge_evidence IS NULL THEN jsonb_build_array(x_entry)
           WHEN EXISTS (
             SELECT 1
               FROM jsonb_array_elements(r.online_purge_evidence) AS e
              WHERE e ->> 'module' = p_module
                AND e ->> 'evidence_ref' = p_evidence_ref
           ) THEN r.online_purge_evidence
           ELSE r.online_purge_evidence || jsonb_build_array(x_entry)
         END,
         online_purged_at = GREATEST(COALESCE(r.online_purged_at, p_purged_at), p_purged_at)
   WHERE r.id = p_request_id
  RETURNING r.id INTO x_id;

  IF x_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;

  SELECT r.online_purge_evidence INTO x_evidence
    FROM public.deletion_requests AS r
   WHERE r.id = p_request_id;

  RETURN jsonb_build_object(
    'request_id', p_request_id,
    'appended', (x_evidence @> jsonb_build_array(x_entry)),
    'evidence', x_evidence
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 唯一读路径（只读；user_id 参与过滤 ⇒ 不知道主体就取不到任何一行）
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.read_online_purge_evidence(
  p_request_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $fn$
  SELECT jsonb_build_object(
    'request_id', r.id,
    'state', r.state,
    'online_due_at',
      to_char(r.online_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'online_purged_at',
      CASE WHEN r.online_purged_at IS NULL THEN NULL
           ELSE to_char(r.online_purged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END,
    'evidence', COALESCE(r.online_purge_evidence, '[]'::jsonb)
  )
  FROM public.deletion_requests AS r
  WHERE r.id = p_request_id
    AND r.user_id = p_user_id
$fn$;

-- ---------------------------------------------------------------------------
-- append-only 触发器：只许在尾部追加，不许清空/置 NULL/删条目/改既有条目
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.deletion_requests_online_evidence_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF OLD.online_purge_evidence IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.online_purge_evidence IS NULL
     OR jsonb_typeof(NEW.online_purge_evidence) <> 'array'
     OR jsonb_array_length(NEW.online_purge_evidence) < jsonb_array_length(OLD.online_purge_evidence)
     OR (
       -- 前 N 项必须与旧数组**逐项全等**（N = 旧长度）：等价于"只允许尾部追加"。
       SELECT jsonb_agg(e ORDER BY ord)
         FROM jsonb_array_elements(NEW.online_purge_evidence) WITH ORDINALITY AS t(e, ord)
        WHERE ord <= jsonb_array_length(OLD.online_purge_evidence)
     ) IS DISTINCT FROM OLD.online_purge_evidence
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G0005', MESSAGE = 'EVIDENCE_APPEND_ONLY';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER deletion_requests_online_evidence_append_only
  BEFORE UPDATE ON public.deletion_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.deletion_requests_online_evidence_append_only();

-- 硬条件：PUBLIC 一律不得执行（PG 默认给新建函数授 PUBLIC EXECUTE；三条都要显式撤）。
-- 唯一的 EXECUTE 授予放在 deploy/postgres-cvm/sql/20-login-roles.sql
-- （`gengyun_api_runtime` 在那一步才创建）。
REVOKE ALL ON FUNCTION public.record_online_purge_evidence(uuid,text,text,integer,integer,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_online_purge_evidence(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deletion_requests_online_evidence_append_only() FROM PUBLIC;

COMMIT;
