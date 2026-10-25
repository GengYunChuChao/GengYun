-- 0044 · 第三方删除持久化（P1 切片：先让库**记住**第三方删除请求与证据）
--
-- 本片范围（P1 only）：只加两条库函数 + 授予运行时 EXECUTE + 断言 + 真库臂 + CI 接线。
-- **不接电**：`services/api/src/**` 一行未动，运行时行为不变（P2 才把适配层接上来）。
--
-- ## 为什么不加列、不加态（表已经够用）
--
-- `public.third_party_deletions`（0003_privacy_consent.sql:185-206）的九列 + 两条部分唯一
-- 索引（0003:210-215）已经能表达 requested / confirmed / failed / unsupported 四态：
-- 它是**覆盖写**的状态行，不是事件流（要事件流请另开表，本片不做）。
-- 尤其**禁止**新增「受理 / accepted」态或 accepted_at：
--   · `third_party_state` 是五值闭集（packages/privacy/constants.mjs）；
--   · 被 `packages/contracts/openapi.json`、`services/api/src/privacy/account-deletion.ts:392`
--     与投影三处同时消费；
--   · 加第六值 = 改契约 + 改三处消费者，是 P2 的事，而且大概率不需要（requested 就是受理）。
--
-- ## 为什么是 SECURITY DEFINER（唯一的真缺口是权限）
--
-- `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:1131-1134` 把
-- `third_party_deletions` 标为 `forbidden`；断言 48（同文件 `runtime_domain_forbidden_tables_untouched`
-- `:3104-3115`）要求运行时角色对这张表**零表级 / 零列级权限**。
-- 也就是说：写要走函数、读也要走函数（运行时连 SELECT 都没有，P2 不可能直接查表）。
-- 本迁移只造这两条窄函数，**不**给运行时任何表权限（授权在 20-login-roles.sql 的 D5 区，
-- 只授 EXECUTE；`90-assert` 的 function_surface_manifest 与断言 105/106 把这件事钉住）。
--
-- ## 单函数写两列（P1 已知限制，必须在头注释里写明）
--
-- 线上/备份两个面在库里是**同一行的两个列**（`online_status` / `backup_status`），
-- 消费方按 phase 选列（`services/api/src/privacy/backup-replay-manifest.ts:684`）。
-- P1 的签名只有 `p_state` 一个状态参数 ⇒ 两条列**同时**写同一个状态。
-- 这是刻意的：P1 的验收是「记住」，不是「两面各自推进」。真要分开推进时再加
-- `p_phase`（那是 P2 的加参迁移，不能偷偷把语义塞进同一个参数里）。
--
-- ## 四条硬条件（逐条落实位置）
--
-- 1. **不信任入参**：状态必须落在闭集内（函数内 `x_state.*` 白名单比对，不靠枚举 cast
--    抛 22P02 —— 那会把「非法状态」变成不透明的类型错误），时刻/接收方/证据/错误码
--    逐个自检（`G0001 INVALID_REQUEST`）。
-- 2. **不越过外键**：`request_id` 必须真在 `deletion_requests` 里、`export_ref` 非空时必须
--    真在 `exports` 里 —— 否则给 `G0002 NOT_FOUND`（不把 23503 外键错抛给调用方）。
-- 3. **confirmed 一次写齐**：`third_party_confirmed_evidence`（0003:196-200）要求
--    `confirmed` 时 `confirmed_at` 与 `evidence_ref` 同时非空。函数**不接受**两步 UPDATE：
--    缺证据的 confirmed 直接 `G0001`；参数里的 `p_at` 就是 `confirmed_at`。
-- 4. **单调 + 幂等**：`(request_id, recipient_id, export_ref)` 是键（两条部分唯一索引各管
--    一支）；`confirmed` / `unsupported` 是终态不可回退；`failed` 可被后续 `confirmed`
--    覆盖；重复 `requested` 幂等且**不刷新** `requested_at`。
--
-- ## 状态机（`state` 列的窄口径映射）
--
--           ┌──────────── requested ────────────┐
--           │                 │                 │
--           ▼                 ▼                 ▼
--        failed ─────────▶ confirmed        unsupported(终态)
--           │                 ▲
--           └─────────────────┘   （failed 是可重试态，confirmed 是终点）
--
--   · 允许：requested → {requested, confirmed, failed, unsupported}
--           failed    → {failed, confirmed}
--   · 拒绝：confirmed / unsupported 出发的任何写入（`G0003 REVISION_CONFLICT`），
--           例外是**完全相同的终态重放**（同态 + 同证据 + 同错误码 ⇒ 原样返回，不刷新时刻）。
--   · 拒绝：`not_requested`（不是可写状态；撤销/重置会破坏单调性）。
--
-- ## 模块内 SQL 错误码（沿用仓内既有 G 码约定，不新增契约错误码）
--
--    G0001  INVALID_REQUEST     参数形状错（状态非闭集 / confirmed 缺证据 / 非 confirmed 带
--                               证据 / failed 缺错误码 / 接收方为空或超长 / 错误码超长 / 时刻为空）
--    G0002  NOT_FOUND           request_id 不在 deletion_requests、export_ref 不在 exports、
--                               或（并发下）UPDATE…RETURNING 没有拿回行
--    G0003  REVISION_CONFLICT   终态不可回退：confirmed / unsupported 行收到不同内容的重放
--
--   与 0016 同码同义（G0001/G0002/G0003 在 0016 里分别是 INVALID_REQUEST / NOT_FOUND /
--   REVISION_CONFLICT），所以适配层可以按同一张映射表处理；本模块**不需要** G0004。
--
-- ## 幂等与并发
--
--   · 键是 `(request_id, recipient_id, export_ref)`；`export_ref` 可为 NULL ⇒ 两条部分唯一
--     索引各自 ON CONFLICT（`WHERE export_ref IS NULL` / `WHERE export_ref IS NOT NULL`），
--     不能合成一条（PG 的部分索引推不出来）。
--   · `ON CONFLICT DO UPDATE … WHERE <非终态>`：守卫写在 DO UPDATE 的 WHERE 里而不是先
--     SELECT 再 UPDATE —— 并发下只有一个事务能改动这行（行锁串行化），第二个事务会看到
--     已提交的终态并走 G0003，不会出现「先读后写」的丢更新。
--   · `requested_at = COALESCE(既有值, EXCLUDED…)`：重复 requested 不刷新时刻。
--
-- ## 事务边界
--
--   迁移本身 `BEGIN; … COMMIT;` 一把过（函数创建是 DDL，DDL 在 PG 里可回滚）。
--   两条函数都不自己开事务：单条语句 + plpgsql 的隐式事务，调用方的事务边界就是它们的边界。

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 写路径：public.record_third_party_deletion(...)
-- ---------------------------------------------------------------------------
-- 返回**写入后的整行快照**（jsonb）：调用方拿到的就是库里的真值，不需要回读（也已经读不到
-- —— 运行时对表零权限）。时刻一律 `to_char(… AT TIME ZONE 'UTC', …)` 序列化，与
-- `Date#toISOString()` 同形；直接让 PG 输出 timestamptz 会受 DateStyle 影响。
CREATE FUNCTION public.record_third_party_deletion(
  p_request_id   uuid,
  p_recipient_id text,
  p_export_ref   uuid,
  p_state        text,
  p_evidence_ref text,
  p_error_code   text,
  p_at           timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $fn$
DECLARE
  x_states   constant text[] := ARRAY['requested', 'confirmed', 'failed', 'unsupported']::text[];
  x_row      public.third_party_deletions;
  x_existing public.third_party_deletions;
  x_evidence text;
  x_error    text;
BEGIN
  -- (1) 参数形状自检。状态先按白名单比对，再做枚举 cast ⇒ 非法状态给 G0001 而不是 22P02。
  IF p_request_id IS NULL
     OR p_at IS NULL
     OR p_recipient_id IS NULL
     OR btrim(p_recipient_id) = ''
     OR length(p_recipient_id) > 80
     OR p_state IS NULL
     OR NOT (p_state = ANY (x_states))
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  IF p_error_code IS NOT NULL AND length(p_error_code) > 80 THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- (3) 证据必须与 confirmed 一次写齐：confirmed 缺证据 = 参数错；
  --     反过来「非 confirmed 却带证据」也拒（否则库里会留下半截证据行）。
  IF p_state = 'confirmed' THEN
    IF p_evidence_ref IS NULL OR btrim(p_evidence_ref) = '' THEN
      RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
    END IF;
    x_evidence := p_evidence_ref;
    x_error := NULL;
  ELSIF p_evidence_ref IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  ELSE
    x_evidence := NULL;
  END IF;

  -- 错误码只在 failed / unsupported 有意义：failed 必填（要能解释失败原因），
  -- unsupported 可空（「不支持删除」本身就是原因）；requested 带错误码判参数错。
  IF p_state = 'failed' THEN
    IF p_error_code IS NULL OR btrim(p_error_code) = '' THEN
      RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
    END IF;
    x_error := p_error_code;
  ELSIF p_state = 'unsupported' THEN
    x_error := p_error_code;
  END IF;

  -- (2) 外键面自检：把 23503 变成可解释的 G0002，且顺带锁住父行（CASCADE 删除与本次写入
  --     竞争时串行化 —— 本片只读父行存在性，不读其内容）。
  IF NOT EXISTS (SELECT 1 FROM public.deletion_requests AS r WHERE r.id = p_request_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;

  IF p_export_ref IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.exports AS e WHERE e.id = p_export_ref)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;

  -- (4) 覆盖写 + 单调守卫。两支不能合并：部分唯一索引的 ON CONFLICT 需要谓词推索引。
  IF p_export_ref IS NULL THEN
    INSERT INTO public.third_party_deletions AS d (
      request_id, recipient_id, export_ref,
      online_status, backup_status,
      requested_at, confirmed_at, evidence_ref, error_code
    ) VALUES (
      p_request_id, p_recipient_id, NULL,
      p_state::public.third_party_state, p_state::public.third_party_state,
      p_at,
      CASE WHEN p_state = 'confirmed' THEN p_at ELSE NULL END,
      x_evidence,
      x_error
    )
    ON CONFLICT (request_id, recipient_id) WHERE export_ref IS NULL
    DO UPDATE SET
      online_status = EXCLUDED.online_status,
      backup_status = EXCLUDED.backup_status,
      -- 幂等：重复 requested 不刷新首次受理时刻
      requested_at  = COALESCE(d.requested_at, EXCLUDED.requested_at),
      confirmed_at  = EXCLUDED.confirmed_at,
      evidence_ref  = EXCLUDED.evidence_ref,
      error_code    = EXCLUDED.error_code
    WHERE d.online_status NOT IN ('confirmed', 'unsupported')
      AND d.backup_status NOT IN ('confirmed', 'unsupported')
    RETURNING * INTO x_row;
  ELSE
    INSERT INTO public.third_party_deletions AS d (
      request_id, recipient_id, export_ref,
      online_status, backup_status,
      requested_at, confirmed_at, evidence_ref, error_code
    ) VALUES (
      p_request_id, p_recipient_id, p_export_ref,
      p_state::public.third_party_state, p_state::public.third_party_state,
      p_at,
      CASE WHEN p_state = 'confirmed' THEN p_at ELSE NULL END,
      x_evidence,
      x_error
    )
    ON CONFLICT (request_id, recipient_id, export_ref) WHERE export_ref IS NOT NULL
    DO UPDATE SET
      online_status = EXCLUDED.online_status,
      backup_status = EXCLUDED.backup_status,
      requested_at  = COALESCE(d.requested_at, EXCLUDED.requested_at),
      confirmed_at  = EXCLUDED.confirmed_at,
      evidence_ref  = EXCLUDED.evidence_ref,
      error_code    = EXCLUDED.error_code
    WHERE d.online_status NOT IN ('confirmed', 'unsupported')
      AND d.backup_status NOT IN ('confirmed', 'unsupported')
    RETURNING * INTO x_row;
  END IF;

  -- 守卫挡下了本次写入（行是终态）：区分「幂等重放」与「真回退」。
  IF x_row IS NULL THEN
    SELECT * INTO x_existing
      FROM public.third_party_deletions AS d
     WHERE d.request_id = p_request_id
       AND d.recipient_id = p_recipient_id
       AND d.export_ref IS NOT DISTINCT FROM p_export_ref
       FOR UPDATE;

    IF NOT FOUND THEN
      -- 行在竞态里被删掉了（deletion_requests CASCADE）：对调用方就是「不存在」。
      RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
    END IF;

    IF x_existing.online_status::text = p_state
       AND x_existing.backup_status::text = p_state
       AND x_existing.evidence_ref IS NOT DISTINCT FROM x_evidence
       AND x_existing.error_code IS NOT DISTINCT FROM x_error
    THEN
      x_row := x_existing;  -- 完全相同的终态重放：原样返回，不刷新任何时刻
    ELSE
      RAISE EXCEPTION USING ERRCODE = 'G0003', MESSAGE = 'REVISION_CONFLICT';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'request_id',    x_row.request_id,
    'recipient_id',  x_row.recipient_id,
    'export_ref',    x_row.export_ref,
    'online_state',  x_row.online_status,
    'backup_state',  x_row.backup_status,
    'requested_at',  to_char(x_row.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'confirmed_at',  to_char(x_row.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evidence_ref',  x_row.evidence_ref,
    'error_code',    x_row.error_code
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. 读路径：public.list_third_party_deletions(p_request_id)
-- ---------------------------------------------------------------------------
-- 运行时对表零权限 ⇒ 读也必须走函数。只吐**证据面需要的列**（八个），不吐内部列；
-- 时刻同样按 UTC + ISO8601 序列化成 text（`RETURNS TABLE` 里不用 timestamptz，
-- 免得调用方在 Date 解析上再分叉）。
-- 排序固定 `(recipient_id, export_ref)`：同一请求可能有多个接收方 / 多个导出物，
-- 顺序不定会让调用方与测试都变成flake。
CREATE FUNCTION public.list_third_party_deletions(p_request_id uuid)
RETURNS TABLE (
  recipient_id text,
  export_ref   uuid,
  online_state text,
  backup_state text,
  requested_at text,
  confirmed_at text,
  evidence_ref text,
  error_code   text
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $fn$
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  RETURN QUERY
  SELECT d.recipient_id::text,
         d.export_ref,
         d.online_status::text,
         d.backup_status::text,
         to_char(d.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         to_char(d.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         d.evidence_ref,
         d.error_code::text
    FROM public.third_party_deletions AS d
   WHERE d.request_id = p_request_id
   ORDER BY d.recipient_id, d.export_ref;
END;
$fn$;

-- 默认 ACL：新函数对 PUBLIC 有 EXECUTE（PG 默认行为）。这里收回，之后只由
-- deploy/postgres-cvm/sql/20-login-roles.sql 的 D5 区把 EXECUTE 授给 gengyun_api_runtime。
REVOKE ALL ON FUNCTION public.record_third_party_deletion(uuid, text, uuid, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_third_party_deletions(uuid) FROM PUBLIC;

COMMIT;
