-- 迁移 0047：后台「隐藏帖子」(`post.hide`) 的审计从**进程内存**落到 `public.admin_audit_events`
-- =============================================================================
--
-- 为什么必须新增迁移、⛔ 不能改既有迁移
-- ---------------------------------------------------------------
-- · 语义早已存在：`hidePost`（`services/api/src/admin/ops/service.ts`） 隐藏成功后写
--   `{ action: 'post.hide', scope: OPS_SCOPES.hidePost (= 'sources:write'),
--     targetRef: {type:'post', id, revision: outcome.previousRevision}, targetHint: null,
--     reasonCode: 'post_hidden', result: 'accepted' }`，但落点是进程内的 ops store
--   （`appendAudit` → `store.audit.append`）⇒ **进程重启即丢**：换一个进程读同一张帖子，
--   那次隐藏的审计就再也查不到（本片之前由 `tests/unit/community-audit-channel-pins.test.mjs` 的钉子钉着）。
-- · 库层**读**面已经存在：`0033_admin_audit_log_read.sql` 的 `public.list_admin_audit_logs(...)`
--   只读全表（`admin_audit_events` 对运行时是零表级权限，只有那条函数的 `EXECUTE`）。
--   于是今天的状态是「能查、但没有写入口」——`post.hide` 的审计行永远进不了这张表。
-- · ⛔ 不能给运行时表级/列级 `INSERT`：`deploy/postgres-cvm/sql/90-assert-least-privilege.sql`
--   的 external_manifest（`admin_audit_events` 表级 S/I/U/D 全 false）与 protected_columns 一起
--   把「运行时直接写审计表」钉成红线（`tests/unit/community-audit-channel-pins.test.mjs` 的
--   `srcHits(/INSERT\s+INTO.*admin_audit_events/i) === []` 也是同一条红线的应用侧镜像）。
-- · 所以沿用 `0041_admin_scope_write_authority.sql:1-31` / `0043_admin_job_cancel_audit.sql` 已裁定的
--   **第三条路**：**窄口径 `SECURITY DEFINER` 函数 + `REVOKE ALL … FROM PUBLIC` + 只授 `EXECUTE`
--   给运行时角色**（`0041` 原话：「既不给运行时表级写权，也不让应用层自证」）。
--   本迁移**不新增任何**表级/列级授权。
-- · `services/api/db/migrations/0018_*.sql` 等既有迁移已被现网库应用，改一个字节即 checksum 拒绝
--   （`services/api/src/db/migrate.ts:47/193/241-243`）⇒ 只能**新增**一条正向迁移。
--
-- 本迁移只做两件事（同一事务，要么全成要么全不成）
-- ---------------------------------------------------------------
-- ① 建 `public.record_admin_post_hide_audit(...)`：一次调用 = 校验操作者 + 同事务写**恰好一行**审计。
-- ② 收回该函数的默认 ACL（PG 新建函数的 `EXECUTE` 默认授 `PUBLIC`）：
--    `REVOKE ALL … FROM PUBLIC`；运行时的 `EXECUTE` 在
--    `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `#region gy-r64-posthide-audit-grant` 区域授予
--    （与 `0041`/`0033`/`0043` 完全同一体例：迁移只收回，授予以部署脚本为唯一出处）。
--
-- 函数签名（顺序即调用顺序，全部必填：没有"可选 actor"这种缝）
-- ---------------------------------------------------------------
--   public.record_admin_post_hide_audit(
--     p_actor_id      uuid,    -- 操作者的 admin_accounts.id（= 会话身份，不接受调用方另传 actor 列）
--     p_post_id       uuid,    -- 被隐藏的帖子 id（community_posts.id）
--     p_post_revision integer, -- **隐藏前**的帖子 revision（写进 target_ref.revision）
--     p_reason_code   text,    -- 理由码；本函数只接受闭集 {'post_hidden'}
--     p_request_id    uuid     -- 契约 Meta.request_id
--   ) RETURNS uuid             -- 写入行的 admin_audit_events.id
--
-- 函数内的校验点（顺序固定，任一不成立即 `RAISE EXCEPTION`，什么都不写）
-- ---------------------------------------------------------------
--   ① 入参自检 —— `G0001 INVALID_REQUEST`：任一参数为 NULL、`p_post_revision < 1`、
--      `p_reason_code` 长度 > 64；理由码不在闭集内 —— `G0018 INVALID_REASON_CODE`
--      （`G0001` 是「参数本身不成立」，`G0018` 是「参数成立但不是本动作的合法理由码」；
--       编号按仓内既有 `G00xx` 序列顺延，`G0001`–`G0017` 已被既有迁移占用）。
--   ② 操作者存在 —— `G0002 NOT_FOUND`：`admin_accounts` 里没有这一行。
--   ③ 操作者可用 —— `G0010 SCOPE_DENIED`：`state <> 'active'`（停用/已注销的账号不能再留痕）。
--   ④ **当前有效**持 `sources:write` —— `G0010 SCOPE_DENIED`：`admin_scopes` 里
--      `revoked_at IS NULL` 的那一行不存在（撤销过的授权不算；与 `0041` 的
--      「锁内重核验操作者」同源：不采信应用层 HTTP 侧的判定结果）。
--
-- 为什么调用方伪造不了审计内容
-- ---------------------------------------------------------------
--   · `actor_id` 只能是入参 `p_actor_id`，且必须先过 ②③④ 三道核验；函数**不接收**任何
--     「以谁的名义写」的旁路参数 ⇒ 没有"代写"入口。
--   · `action` / `scope` / `result` 在函数体内是**字面量**（`'post.hide'` / `'sources:write'` /
--     `'accepted'`），调用方改不了；`target_hint` 固定 `NULL`（与内存审计那条路径逐字段一致）。
--   · `target_ref` 由**形参重建**（`jsonb_build_object('type','post','id',p_post_id::text,'revision',p_post_revision)`），
--     不接受调用方直接塞 jsonb ⇒ 绕不过 `admin_audit_events_target_ref_shape`（0017）那条 CHECK。
--   · `reason_code` 走**闭集**而不是自由文本：本动作目前只有一个合法理由码 `post_hidden`。
--     若放开成自由文本，任何能调用本函数的进程都能让审计读起来像「因 X 原因隐藏」——
--     那是伪造审计**语义**，与伪造 actor 同级。**拓宽闭集必须新增迁移**（这是刻意的代价）。
--   · `request_id` 由调用方给（契约追踪 id），它不参与任何授权判定，只用于把审计行与请求对齐。
--
-- 与内存路径的逐字段对应（改造前后同一事实的两种落点，不新增字段语义）
-- ---------------------------------------------------------------
--   action=post.hide / scope=sources:write / reason_code=post_hidden / result=accepted /
--   target_hint=NULL / actor_id=会话身份 / target_ref.revision=**隐藏前** revision
--   （`hidePost` 的 `targetRef.revision = outcome.previousRevision`，即 CAS 读到的 `current.revision`，
--   也就是 published→hidden 那次迁移之前的那个号）。`before_value`/`after_value` 不写
--   （本动作的"前后值"就是帖子行的 visibility/revision，读面另有 `GET /admin/posts`，不在这里重复一份）。
--
-- 调用点与事务边界（这里也是唯一正确姿势）
-- ---------------------------------------------------------------
--   本函数**只在帖子隐藏的那个事务里**被调用：`services/api/src/community/store-pg.ts` 的
--   `commitPost` 已经整段在 `withTransaction` 内 —— 可见性那一步的 CAS 写入 →
--   `writeModeration(...)`（有 moderate 时）→ `SELECT public.record_admin_post_hide_audit(…)` → `COMMIT`，
--   全部共用同一个 `sql`（同一个 client）。
--   ⇒ 任何一步失败都走 `catch` 里的 `ROLLBACK`：帖子保持 `published`/原 `revision`，
--     审计表**零新增**，客户端收到 503（`PROVIDER_UNAVAILABLE`，`retryable: false`，
--     message 含「审计写入失败」）。
--   ⇒ 因此不存在「隐藏已提交、审计没写成」的缺口，`admin_audit_events` 是 append-only 的
--     （触发器拦 UPDATE/DELETE，G0006），那条缺口事后也无从补记 —— 只能在事务里消灭它。
--   ⛔ 不要在 `COMMIT` 之后补写审计（那是"先成后败"的假成功），
--     也⛔ 不要把本函数包进第二个事务（换了 `sql`/client 就不再是同一个事务）。
--
-- 已知边界（如实登记，不在此迁移里偷偷绕过）
-- ---------------------------------------------------------------
--   · 本函数**不复查帖子行**（不查 `community_posts` 的 `visibility='hidden'`）：它与那一次
--     `UPDATE` 同事务，行锁在手，`UPDATE` 的 `RETURNING` 已经证明迁移发生了；再查一遍只会把
--     "帖子表的结构"耦合进审计函数，却证明不了更多。跨域的连接点由调用方保证（同一个事务）。
--   · 本函数**不判定幂等**：重复隐藏在服务层就被拦下（端口层 `revision` CAS 不匹配即
--     `changed: false`，不再迁移、不再记审计）⇒ 同一帖子的隐藏审计行应当恰好一行，
--     靠的是那道判定，不是函数里的 `ON CONFLICT`（审计表没有幂等键可冲突）。
--
-- 错误码（都是**运行期**错误码：函数被调用时才可能抛出，不是迁移期预检）
-- ---------------------------------------------------------------
--   G0001 INVALID_REQUEST       入参不成立（NULL / revision < 1 / reason_code 超长）
--   G0018 INVALID_REASON_CODE   理由码不在闭集 {'post_hidden'} 内
--   G0002 NOT_FOUND             操作者 admin_accounts.id 不存在
--   G0010 SCOPE_DENIED          操作者非 active，或当前未有效持有 sources:write
--
-- 不碰什么
-- ---------------------------------------------------------------
--   · ⛔ 不给运行时 `admin_audit_events` 任何表级/列级权限（函数是 SECURITY DEFINER，属主写行）；
--   · ⛔ 不改既有表结构、索引、触发器（`admin_audit_events_append_only` 仍在，UPDATE/DELETE 依旧 G0006）；
--   · ⛔ 不改 `0017` / `0027` / `0033` / `0041` / `0043` 的正文（checksum）；
--   · ⛔ 不动 `0018` 的 `target_type` 闭集，也⛔ 不扩 `target_ref.type` 白名单：
--     `{type:'post', …}` 早已被 0017 的 `admin_audit_events_target_ref_shape` 接受
--     （该 CHECK 只要求 `type` 是字符串、`id` 是字符串、`revision` 是数字）；
--   · ⛔ 本片**不动读面闭集**：`services/api/src/admin/audit/catalog.ts` 的 `AUDIT_ACTIONS` /
--     `AUDIT_ENTITY_SCOPES` 与 `packages/contracts/openapi.json` 的查询 enum 仍是原样。
--     理由：那两个文件正被在飞 `#652` 修改，同片改会撞车。**读面放开留给下一片**
--     （在那之前，`GET /admin/audit-logs` 按 action 过滤仍只认原四值；不带过滤取全表不受影响）。
--
-- 回滚：`rollback/0047_admin_post_hide_audit.down.sql`
--   先数 `action='post.hide'` 的审计行，> 0 即 `RAISE EXCEPTION 'G0019'` 中止，再删函数。
--
-- 号位：当前正向最大号是 `0046`、`0037` 是保留台账里的在途缺号 ⇒ 取最大号 +1 = `0047`（本片即落盘，
-- `services/api/db/migration-reservations.json` 不新增条目）。
BEGIN;

-- ---------------------------------------------------------------------------
-- ① 唯一写路径：窄口径 SECURITY DEFINER 函数（一次调用 = 一行审计）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_admin_post_hide_audit(
  p_actor_id      uuid,
  p_post_id       uuid,
  p_post_revision integer,
  p_reason_code   text,
  p_request_id    uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_actor    public.admin_accounts%ROWTYPE;
  x_audit_id uuid;
BEGIN
  -- ① 入参自检：非法即 G0001（不把 CHECK 违反当「服务器错误」外泄）。
  IF p_actor_id IS NULL
     OR p_post_id IS NULL
     OR p_request_id IS NULL
     OR p_post_revision IS NULL OR p_post_revision < 1
     OR p_reason_code IS NULL OR length(p_reason_code) > 64
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- ①' 理由码闭集：本动作只有一个合法理由码（拓宽闭集必须新增迁移）。
  IF p_reason_code <> 'post_hidden' THEN
    RAISE EXCEPTION USING ERRCODE = 'G0018', MESSAGE = 'INVALID_REASON_CODE';
  END IF;

  -- ② 操作者存在（definer 内读 admin_accounts；运行时不持有该表的任何直读/直写权）。
  SELECT * INTO x_actor FROM public.admin_accounts WHERE id = p_actor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;

  -- ③ 操作者可用：停用/已注销的账号不能再造审计行（同 0017/0041 的 active 口径）。
  IF x_actor.state <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'G0010', MESSAGE = 'SCOPE_DENIED';
  END IF;

  -- ④ 当前**有效**持有 sources:write（`revoked_at IS NULL`）；不采信应用层 HTTP 侧的判定结果。
  IF NOT EXISTS (
    SELECT 1
      FROM public.admin_scopes AS s
     WHERE s.admin_id = p_actor_id
       AND s.scope = 'sources:write'
       AND s.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G0010', MESSAGE = 'SCOPE_DENIED';
  END IF;

  -- ⑤ 审计：action/scope/reason_code/result 在函数内固定，target_ref 由形参重建 ⇒ 调用方伪造不了。
  x_audit_id := gen_random_uuid();
  INSERT INTO public.admin_audit_events (
    id, actor_id, action, scope, target_ref, target_hint, reason_code,
    request_id, result
  ) VALUES (
    x_audit_id,
    p_actor_id,
    'post.hide',
    'sources:write',
    jsonb_build_object('type', 'post', 'id', p_post_id::text, 'revision', p_post_revision),
    NULL,
    p_reason_code,
    p_request_id,
    'accepted'
  );

  RETURN x_audit_id;
END;
$$;

COMMENT ON FUNCTION public.record_admin_post_hide_audit(uuid, uuid, integer, text, uuid) IS
  '后台「隐藏帖子」审计的唯一写路径（迁移 0047）：校验操作者存在/active/当前有效持 sources:write，'
  '同事务向 public.admin_audit_events 写一行 action=post.hide、scope=sources:write、result=accepted，'
  '返回该行 id。EXECUTE 只授 gengyun_api_runtime（20-login-roles.sql 的 gy-r64-posthide-audit-grant）。';

-- ---------------------------------------------------------------------------
-- ② 收回默认 ACL：函数的 `EXECUTE` 默认授予 PUBLIC，这里必须显式收回。
--    运行时的 `EXECUTE` 在 `20-login-roles.sql` 的 `gy-r64-posthide-audit-grant` 区域授予；
--    ⛔ 本迁移不给运行时 `admin_audit_events` 任何 INSERT（那是 90-assert 的 external_manifest
--    与 protected_columns 钉死的红线）。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.record_admin_post_hide_audit(uuid, uuid, integer, text, uuid)
  FROM PUBLIC;

COMMIT;
