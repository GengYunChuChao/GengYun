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
--   ③ **不越过任何一处引用**（返修：口径从「三处」改成「11 列 / 8 类」——原版有真实漏删）。
--
--      原版只认 `content_media_refs` / `community_media_grants` / `public_authors.avatar_media_id`
--      三处。实测本库**另有两列「头像指针」与六列「正文域 media_id」、加一列 `text[]` 数组**，
--      共 8 列**只存 media uuid、且故意没有外键**。这些行指着某条 media 时，原版函数**照样会把
--      `public.media` 行删掉**：没有外键 ⇒ 数据库**不会**报 23503 ⇒ 留下一串**悬空 uuid**，
--      图片/识别/语音链路之后按 `media_id` 取对象只会拿到空，而且**无法自查**（media 行没了，
--      连「这行曾经是什么」都查不回来）。故本版把判据扩到**全部 11 列**，语义不变：
--      **被任何一处引用 ⇒ 该 media 行不删、计入 `skipped_referenced`**。
--
--      引用面清单（列 → 迁移:行；`FK` = 真有外键，`—` = 只存 uuid；**后 8 列是本版新增**）：
--        1. public.content_media_refs.media_id      0001:298  FK（无级联）
--        2. public.community_media_grants.media_id  0001:315  FK（无级联）
--        3. public.public_authors.avatar_media_id   0001:236  —
--        4. public.users.avatar_media_id            0001:40   —
--        5. public.ocr_jobs.media_id                0024:90   —
--        6. public.ocr_records.media_id             0024:113  —
--        7. public.recognition_jobs.media_id        0025:113  —
--        8. public.recognition_records.media_id     0025:135  —
--        9. public.speech_jobs.media_id             0026:95   —
--       10. public.transcriptions.media_id          0026:116  —
--       11. public.community_posts.media_ids        0022:70   —（**text[] 数组**，CHECK 上限 3 项）
--
--      第 4 处（`users.avatar_media_id`）单独说明：它今天**没有任何写入方**（`services/api/src`
--      里零 `UPDATE ... avatar_media_id`；只有 `admin/ops/accounts-pg.ts:19` 的注释与社区域投影
--      读它）。仍然并入口径，理由是**口径要按「库里有这一列」定，不按「今天有人写」定**：等
--      账号头像接上写入方那天，少这一处就是又一条静默悬空 uuid，而且没有任何测试会红。
--
--      第 11 处（数组列）的判法：`m.id::text = ANY (p.media_ids)`。`media.id` 是 uuid、
--      `media_ids` 是 text[]，把 **uuid 侧**转成文本后与数组元素直接比（text = text），
--      **不拼字符串、不猜分隔符、不取下标**；等价于
--      `EXISTS (SELECT 1 FROM unnest(p.media_ids) e WHERE e = m.id::text)`，只是不必逐元素展开。
--      ⛔ 不要改成 `LIKE '%'||…||'%'` / `position()` / `= p.media_ids[1]`：前两种会被前缀误命中，
--      后一种只看第一个元素（CHECK 允许 3 项）。
--
--      **刻意不算「引用」的四处**（写在这里，免得下一轮当成漏项）：
--       a. `public.media_derivatives.media_id`（0001:194）：域内**子行**，
--          `ON DELETE CASCADE`，且本函数先显式删它再删父行 ⇒ 它是**同一个删除单元**的一部分，
--          不是「别人的引用」。把它算成引用会让目标集恒空。
--       b. `public.media_object_cleanup.media_id`（0029:49）：这是硬条件①要求的**入队台账**。
--          把它算成引用 ⇒ 目标集永远为空（自锁），函数退化成「什么也不删」。
--       c. `public.jobs.target_id`（0001:209）：多态目标列，`target_type` 无 CHECK；且
--          `0013_conversations.sql:19` 记明 grep `INSERT INTO jobs` 在 `services/api/src` 为空
--          ⇒ 没有任何真实写入方。（契约侧 `'media'` 确实在 `TARGET_REF_TYPES`
--          `services/api/src/admin/fields.ts:62-65`，但那是**声明面**，不是库存数据。）
--       d. `public.exports.object_id`（0003:120）：同样是多态列，`object_type='media'` 确有写入
--          （`services/api/src/privacy/task-egress.ts:77,100`：把对象发给第三方的那一笔）。它是
--          **外发账本 / 计费事实**，注销后**刻意保留**（0011/0014 的保留规则）。把账本算成
--          「引用」会让「外发过一次的媒体」永远删不掉——与注销的删除义务方向相反。
--
--      并发窗口（fail-closed 的边界，如实写）：第 1/2 处有外键，若在「查」与「删」之间有人新插
--      一条引用，第二条 DELETE 撞 **23503** 并把整批回滚（安全失败，⚠ 与证据页三态映射的
--      `blocked` 同源）。第 3–11 处**没有**外键 ⇒ 同一窗口内新插的引用**无法被数据库拦下**，
--      那一行会被删掉、新引用变悬空。函数侧能做的只有「查得比删早一点」；真正的护栏是
--      **运行顺序**（见下节）+ 重试。
--      ⛔ 不要为了关掉这个窗口在函数里 `LOCK TABLE` 那 8 张表：那会把注销/撤回的删除路径扩成
--      跨域写阻塞，代价远大于收益，而且 READ COMMITTED 下**已提交**的插入照样拦不住。
--
--      索引现状（不改，但要写清）：第 3–11 处**都没有索引**（0001/0022/0024/0025/0026 里没有任何
--      以这些列为前导的索引，`git grep -n -E "CREATE (UNIQUE )?INDEX[^;]*media"` 只有 0001 的
--      media/media_derivatives/content_media_refs/community_media_grants 与 0029 的两条）⇒ 这些
--      `EXISTS` 是逐目标行的顺序扫描。边界由「单个 owner 的终态 media 行数」兜住，通常很小；
--      若将来成为热点，正确做法是在各自域的迁移里补 b-tree（第 11 处补 GIN），⛔ 不是放宽条件。
--
-- ## 运行顺序前提（裁定的一部分，⛔ 不是免责声明）
-- 本函数**不是**「跑一次就干净」的清洁器，它是「把此刻已经没人引用的终态媒体行删掉」。所以
-- 运行时接线必须把**媒体模块排在 `community` / `recognitions` / `speech` 之后**（`ocr` 目前
-- **连模块都没有**，见下），排在前面只会不断跳过、永远删不干净。证据页
-- `docs/verification/gy-r34-i19-media-row-purge-20261024.md` 的「运行顺序前提」一节与本段同形，
-- 判据（`skipped_referenced` 必须随其它模块跑完**单调不增** —— 不是「必然下降」：`ocr` 死桶
-- 与 `community` 的软删行恒不降）写在那里，不重复。
--
-- ## 函数体铁律（与 0034 同形，缺一即被审查打回）
-- `SECURITY DEFINER` + `SET search_path = pg_catalog` + `SET TimeZone = 'UTC'`；函数体内所有业务
-- 对象一律 `public.` 显式限定（否则 search_path 劫持可换掉被删的表）；结尾
-- `REVOKE ALL ON FUNCTION … FROM PUBLIC`；参数域自检用本仓 `G000x` 错误码；读数走 jsonb
-- （⛔ 不返回 void：调用方要能把这几个数写进注销证据串），且**分层计数必须比 `skipped_referenced`
-- 更细**，否则调用方看不出「该先跑哪个模块」。
--
-- ## 与 0034 的分工
-- 0034 管**正文域**（识别/语音五表，运行时对它们零 DELETE，且这就是探针锁定的禁止面）；
-- 0035 管**媒体域的行**（media + 其派生行）。两者的共同点是：都不给运行时加任何表权限，
-- 都只加一条 `GRANT EXECUTE`；区别是本函数的入队前提由 0029 台账承担，而不是「删了就完」。
-- 另：0034 删掉识别/语音行之后，本函数对应两个桶的跳过计数才会掉下来——这也是「顺序前提」的
-- 一半依据（另一半是社区域自己清 `media_ids`）。
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
  -- 分层跳过计数：8 类引用面各一个（同一行被多处引用时**每类都计**，故桶和 ≥ x_skipped）。
  x_ref_content     integer := 0;
  x_ref_grants      integer := 0;
  x_ref_avatar      integer := 0;
  x_ref_user_avatar integer := 0;
  x_ref_ocr         integer := 0;
  x_ref_recognition integer := 0;
  x_ref_speech      integer := 0;
  x_ref_community   integer := 0;
BEGIN
  -- 参数域自检：NULL 主体不是「没有目标」，是调用错误（与 0016/0017/0031/0034 同码同义）。
  IF p_owner IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- 目标集：本人 + 终态 + 没有被**任何一处**引用（硬条件 ②③；11 列逐条 NOT EXISTS）。
  -- 每处引用面在这里与下面「分层计数」的子查询里**各写一次、形状逐字相同**；两处必须同时改，
  -- 只改一处就是「删了不该删的」或「假读数」二选一。tests/unit 逐列钉死两边（negated 恰好 1、
  -- positive 恰好 2 ⇒ 一处否定 + 一处肯定）。
  SELECT coalesce(array_agg(m.id ORDER BY m.id), ARRAY[]::uuid[]) INTO x_targets
    FROM public.media m
   WHERE m.owner_id = p_owner
     AND m.state IN ('rejected', 'deleted')
     AND NOT EXISTS (SELECT 1 FROM public.content_media_refs r WHERE r.media_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.community_media_grants g WHERE g.media_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.public_authors a WHERE a.avatar_media_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.avatar_media_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.ocr_jobs j WHERE j.media_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.ocr_records j WHERE j.media_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.recognition_jobs j WHERE j.media_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.recognition_records j WHERE j.media_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.speech_jobs j WHERE j.media_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.transcriptions j WHERE j.media_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.community_posts p WHERE m.id::text = ANY (p.media_ids));

  -- 跳过读数 + **分层**跳过读数（「因为哪一类引用被跳过」），供调用方判断该先跑哪个模块。
  -- 形状要点：每处引用面**只写一次** `EXISTS`（作为子查询里的布尔列 `ref_<类>`），跳过总数与
  -- 8 个分层计数都从**同一批布尔列**聚合 —— 逐字重写第二遍才是少报/错报的温床。ocr / recognition
  -- / speech 三桶各由**两列**（jobs + records）合成一桶（同一域的两条链路），其余各一列。
  -- 桶之间**互不排斥**：一行同时被 OCR 与社区引用时两个桶都 +1，而 `skipped_referenced` 只 +1。
  SELECT count(*) FILTER (WHERE t.ref_content),
         count(*) FILTER (WHERE t.ref_grants),
         count(*) FILTER (WHERE t.ref_avatar),
         count(*) FILTER (WHERE t.ref_user_avatar),
         count(*) FILTER (WHERE t.ref_ocr),
         count(*) FILTER (WHERE t.ref_recognition),
         count(*) FILTER (WHERE t.ref_speech),
         count(*) FILTER (WHERE t.ref_community),
         count(*) FILTER (WHERE t.ref_content OR t.ref_grants OR t.ref_avatar OR t.ref_user_avatar
                             OR t.ref_ocr OR t.ref_recognition OR t.ref_speech OR t.ref_community)
    INTO x_ref_content, x_ref_grants, x_ref_avatar, x_ref_user_avatar,
         x_ref_ocr, x_ref_recognition, x_ref_speech, x_ref_community, x_skipped
    FROM (
      SELECT EXISTS (SELECT 1 FROM public.content_media_refs r WHERE r.media_id = m.id)          AS ref_content,
             EXISTS (SELECT 1 FROM public.community_media_grants g WHERE g.media_id = m.id)      AS ref_grants,
             EXISTS (SELECT 1 FROM public.public_authors a WHERE a.avatar_media_id = m.id)       AS ref_avatar,
             EXISTS (SELECT 1 FROM public.users u WHERE u.avatar_media_id = m.id)                AS ref_user_avatar,
             (EXISTS (SELECT 1 FROM public.ocr_jobs j WHERE j.media_id = m.id)
              OR EXISTS (SELECT 1 FROM public.ocr_records j WHERE j.media_id = m.id))            AS ref_ocr,
             (EXISTS (SELECT 1 FROM public.recognition_jobs j WHERE j.media_id = m.id)
              OR EXISTS (SELECT 1 FROM public.recognition_records j WHERE j.media_id = m.id))    AS ref_recognition,
             (EXISTS (SELECT 1 FROM public.speech_jobs j WHERE j.media_id = m.id)
              OR EXISTS (SELECT 1 FROM public.transcriptions j WHERE j.media_id = m.id))         AS ref_speech,
             EXISTS (SELECT 1 FROM public.community_posts p WHERE m.id::text = ANY (p.media_ids)) AS ref_community
        FROM public.media m
       WHERE m.owner_id = p_owner
         AND m.state IN ('rejected', 'deleted')
    ) t;

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
  -- 补一句方向性说明：本版引用面变宽 ⇒ 目标集只会**变小**，不会变大；三段顺序与目标集谓词
  -- 是两件事，⛔ 不要用「反正引用面拦住了」当理由改顺序。
  DELETE FROM public.media_derivatives d WHERE d.media_id = ANY(x_targets);
  GET DIAGNOSTICS x_derivatives = ROW_COUNT;

  DELETE FROM public.media m WHERE m.id = ANY(x_targets);
  GET DIAGNOSTICS x_media = ROW_COUNT;

  RETURN jsonb_build_object(
    'media',                 x_media,
    'derivatives',           x_derivatives,
    'queued',                x_queued,
    'skipped_referenced',    x_skipped,
    'skipped_referenced_by', jsonb_build_object(
      'content',     x_ref_content,
      'grants',      x_ref_grants,
      'avatar',      x_ref_avatar,
      'user_avatar', x_ref_user_avatar,
      'ocr',         x_ref_ocr,
      'recognition', x_ref_recognition,
      'speech',      x_ref_speech,
      'community',   x_ref_community
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_owner_media(uuid) FROM PUBLIC;

COMMIT;
