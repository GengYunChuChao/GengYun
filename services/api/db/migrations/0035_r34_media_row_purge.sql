-- GY-R34（#19 片2）：注销/撤回时把**媒体行**真正删掉——唯一写路径，窄口径 SECURITY DEFINER 函数。
--
-- ## 为什么不许表级 GRANT DELETE（这是本迁移存在的全部理由）
-- `public.media` 对运行时角色只有列级 SELECT/INSERT/UPDATE，**表级 DELETE 为零**，而且
-- `deploy/postgres-cvm/sql/20-login-roles.sql` 段 M 的 `\echo` 把理由写死了：
--   「media 故意不授 DELETE —— 删除是状态机（deleting→deleted，UPDATE state），
--     媒体行是审计与计费事实，不物理删。」
-- 本迁移**不动**那条不变量：整份文件**零 GRANT**，一张表的表级权限都没加（`public.media` /
-- `media_derivatives` / `content_media_refs` / `community_media_grants` / `media_object_cleanup`
-- 的授权面逐字未变）。要真删行，只能由属主身份的窄函数在「注销/撤回」这一条语义里做。
-- PG 没有列级 DELETE，所以「只许删本人的终态行」这件事只有函数体谓词能表达。
--
-- ## 三条硬条件（缺一即不安全，逐条都有对应的注释与读数）
--   ① **先入队、后删行**：删 media 行之前，每个**仍存活**的对象引用（media 本体 +
--      media_derivatives）必须已经在 `public.media_object_cleanup`（迁移 0029）里有清理意图行。
--      0029 的 `media_object_cleanup.media_id` **故意没有外键**，所以删掉父行**不会**级联删掉
--      意图行 ⇒ 重试器（`media/service.ts` 的 `cleanupOrphans`）照旧拿得到 `object_ref_cipher`
--      去删桶对象。反过来（先删行、后入队）在函数内**做不到**：入队要写 `object_ref_digest`，
--      而那是 `media/object-ref-cipher.ts` 里对对象键做的 HMAC 的 base64url——密钥只在应用进程，
--      SQL 侧算不出来。因此本函数的立场是**校验**队列而不是**代写**队列：队列没写好就整批不删
--      （`G0007 MEDIA_CLEANUP_NOT_QUEUED`）。⛔ 不要为了「跑得通」改成「删了再说」——
--      那正是侦察报告里点名的硬红线：先删行会造**永久无主孤儿**（桶里有对象、库里没有任何线索）。
--   ② 只删**终态**行：`state IN ('rejected','deleted')`。`initiated`/`uploaded`/`processing`/
--      `ready`/`deleting` 一律不动——那些行要么还有活引用，要么还在状态机里跑。
--   ③ **不越过别人的引用**：`content_media_refs` / `community_media_grants` 对 media 的外键
--      **没有** ON DELETE CASCADE（0001:298 / 0001:315），硬删会 23503 并把整批回滚。这两张表
--      属于社区内容/取图授权域，本片不越权：被引用的行**留在原地**并计数上报（`skipped_referenced`）。
--      本片补强：同样的「不越权」还要覆盖**第三处引用面** —— `public_authors.avatar_media_id`
--      （0001:236）。它**没有**外键（删 media 行不会 23503，因此只会**静默**留下一个指向
--      不存在的媒体的作者头像指针），而 F13 保留规则要求注销后公开作者行**继续存活**
--      （正文保留、作者脱敏，见 `user-data-deletion.ts` 的 `COMMUNITY_DELETION_MODULE`）⇒
--      头像媒体被删掉就会让一条被保留的作者行永远拿不出头像。故三张引用表一律按「被引用就留原地」
--      处理，并统一计入 `skipped_referenced`（⛔ 不给第三处开例外，也不静默删）。
--
-- ## 函数体铁律（与 0034 同形，缺一即被审查打回）
-- `SECURITY DEFINER` + `SET search_path = pg_catalog` + `SET TimeZone = 'UTC'`；函数体内所有业务
-- 对象一律 `public.` 显式限定（否则 search_path 劫持可换掉被删的表）；结尾
-- `REVOKE ALL ON FUNCTION … FROM PUBLIC`；参数域自检用本仓 `G000x` 错误码；读数走 jsonb
-- （⛔ 不返回 void：调用方要能把这几个数写进注销证据串）。
--
-- ## 与 0034 的分工
-- 0034 管**正文域**（识别/语音五表，运行时对它们零 DELETE，且这就是探针锁定的禁止面）；
-- 0035 管**媒体域的行**（media + 其派生行）。两者的共同点是：都不给运行时加任何表权限，
-- 都只加一条 `GRANT EXECUTE`；区别是本函数的入队前提由 0029 台账承担，而不是「删了就完」。
--
-- ## 幂等与越权
-- 谓词自带 owner 绑定 ⇒ 跨 owner 一行都删不到（不是靠调用方守规矩）。重复调用第二次目标集为空，
-- 读数全 0——不报错、不复活任何行。
--
-- ## 探针面
-- `deploy/postgres-cvm/evidence/probe-runtime-grants.sql` 里 media 域**零命中**，且本迁移不加任何
-- 表级授权 ⇒ `deploy-sql-gate.yml` 的 18 条探针 / 9 个对象**逐字未变**（⛔ 不要顺手扩禁止面）。

BEGIN;

CREATE FUNCTION public.purge_owner_media(p_owner uuid) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  SET TimeZone = 'UTC'
AS $$
DECLARE
  x_targets     uuid[]  := ARRAY[]::uuid[];
  x_media       integer := 0;
  x_derivatives integer := 0;
  x_queued      integer := 0;
  x_skipped     integer := 0;
  x_unqueued    integer := 0;
BEGIN
  -- 参数域自检：NULL 主体不是「没有目标」，是调用错误（与 0016/0017/0031/0034 同码同义）。
  IF p_owner IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- 目标集：本人 + 终态 + 没有被别人的内容/授权/头像引用（硬条件 ②③）。
  SELECT coalesce(array_agg(m.id ORDER BY m.id), ARRAY[]::uuid[]) INTO x_targets
    FROM public.media m
   WHERE m.owner_id = p_owner
     AND m.state IN ('rejected', 'deleted')
     AND NOT EXISTS (SELECT 1 FROM public.content_media_refs r WHERE r.media_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.community_media_grants g WHERE g.media_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.public_authors a WHERE a.avatar_media_id = m.id);

  -- 因为这些引用而**留下**的终态行：本片不越权删，但要报出来（否则「删了 0 行」看不出原因）。
  -- ⚠ 这两处三条件谓词必须**逐字同形**（一处加、另一处不加 ⇒ `skipped_referenced` 会少报，
  --   而少报的后果正是一个「看起来删干净了」的假读数）。tests/unit 的形状测试逐表钉死两边。
  SELECT count(*) INTO x_skipped
    FROM public.media m
   WHERE m.owner_id = p_owner
     AND m.state IN ('rejected', 'deleted')
     AND (EXISTS (SELECT 1 FROM public.content_media_refs r WHERE r.media_id = m.id)
       OR EXISTS (SELECT 1 FROM public.community_media_grants g WHERE g.media_id = m.id)
       OR EXISTS (SELECT 1 FROM public.public_authors a WHERE a.avatar_media_id = m.id));

  -- 硬条件 ①（**入队先于删行**）：逐个目标行比对「仍存活的对象引用数」与「台账行数」。
  -- 「已清空」的编码是空明文的信封（`media/object-ref-cipher.ts` 文件头「已清空怎么表示」）：
  -- 四段式 `v1.<iv 16>.<tag 22>.<密文>`，密文段为空 ⇒ 该列不再持有任何对象键。
  -- 形状认不出来的密文**一律按「仍持有对象」处理**（fail-closed：宁可不删，也不造孤儿）。
  -- 注意这是**计数式**前置，不是摘要级比对：SQL 侧没有 HMAC 密钥，无法把意图行与具体对象键对上，
  -- 因此它证明的是「没有未入队的活引用」，而不是「每一条意图都恰好对应一个活引用」。
  SELECT count(*) INTO x_unqueued
    FROM public.media m
   WHERE m.id = ANY(x_targets)
     AND (
           CASE WHEN m.object_ref_cipher
                     !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.$'
                THEN 1 ELSE 0 END
         + (SELECT count(*)
              FROM public.media_derivatives d
             WHERE d.media_id = m.id
               AND d.object_ref_cipher
                   !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.$')
         ) > (SELECT count(*) FROM public.media_object_cleanup c WHERE c.media_id = m.id);

  IF x_unqueued > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'G0007', MESSAGE = 'MEDIA_CLEANUP_NOT_QUEUED';
  END IF;

  SELECT count(*) INTO x_queued
    FROM public.media_object_cleanup c
   WHERE c.media_id = ANY(x_targets);

  -- 子先父后（与 0034 同序）：先删派生行，再删媒体行。派生行**本来就有**表级 DELETE 授权
  -- （20-login-roles.sql 段 M 的 `GRANT DELETE ON public.media_derivatives`），且
  -- `media_derivatives.media_id → media(id) ON DELETE CASCADE`（0001:194）本来就会跟着走；
  -- 这里仍然显式 `public.` 限定并先删，是为了让读数能分开报、也让 23503 不会藏在级联里。
  -- 并发说明（fail-closed，不是缺口）：目标集是**先查后删**，若此刻有另一事务新插入一条
  -- content_media_refs / community_media_grants，第二条 DELETE 会撞外键 23503 并让整批回滚
  -- （函数在单条事务里执行 ⇒ 派生行也一并回滚，不会留下「父行还在、派生行没了」的半截态）。
  -- 那是**安全失败**：宁可整批不删留待重试，也不越过别人的引用；⛔ 不要靠吞异常把它变成绿。
  DELETE FROM public.media_derivatives d WHERE d.media_id = ANY(x_targets);
  GET DIAGNOSTICS x_derivatives = ROW_COUNT;

  DELETE FROM public.media m WHERE m.id = ANY(x_targets);
  GET DIAGNOSTICS x_media = ROW_COUNT;

  RETURN jsonb_build_object(
    'media',              x_media,
    'derivatives',        x_derivatives,
    'queued',             x_queued,
    'skipped_referenced', x_skipped
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_owner_media(uuid) FROM PUBLIC;

COMMIT;
