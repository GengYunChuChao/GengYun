-- 迁移 0042：`favorites` / `history` 的 `target_type` 闭集补齐第 17 值 `conversation_turn`
-- =============================================================================
--
-- 为什么**必须新增迁移**、⛔ 不能直接改 `0018_favorites_history.sql`
-- ---------------------------------------------------------------
-- · 契约 `packages/contracts/openapi.json` 的 `components.schemas.TargetRef.properties.type.enum`
--   现在是 **17 项**（第 17 项 `conversation_turn`，由 `#576` 客户端镜像 17 引入）；
--   `services/api/src/history/validate.ts` 已按 17 类校验。
-- · 而 `0018_favorites_history.sql` 里两处 `target_type` 的 CHECK 仍是**旧 16 值**
--   （`favorites` @ `:51-55`、`history` @ `:76-80`）⇒ 一旦落轮次类型：应用层放行、库层 CHECK 拒绝 ⇒ 500。
-- · `0018` 早已合入并已被既有库应用，**改它一个字节就会拦住既有库升级**（连注释都不行）：
--   `services/api/src/db/migrate.ts:47` 对整份 SQL 取 SHA256（不剥注释）、`:193` 与
--   `schema_migrations` 里已应用记录的 checksum 比对、`:241-243` 发现差异即拒绝。
--   ⇒ 只能**新增**一条正向迁移来改表，`0018` 的正文一个字都不动。
--
-- 本迁移只做两件事（同一事务，要么全成要么全不成）
-- ---------------------------------------------------------------
-- ① **先预检**：扫 `public.favorites` / `public.history` 的 `target_type`，出现 17 值闭集之外的取值
--    （含 `NULL`）即 `RAISE EXCEPTION 'G0013'` 打出行数与样例并**中止**——
--    **只报告、不删行、不映射**：不猜「最像的合法类型」，也不把契约外取值悄悄挪进闭集。
-- ② 预检通过后才动约束：把两表的列级 CHECK **原地换成同名约束**，闭集由 16 值增到 17 值。
--    `DROP CONSTRAINT` 与 `ADD CONSTRAINT` 在同一事务内 ⇒ 其它会话看不到「约束短暂缺席」的窗口
--    （`ALTER TABLE` 持 `ACCESS EXCLUSIVE` 直到提交）；`ADD CONSTRAINT … CHECK` 默认**整表校验**既有行，
--    故 ① 的行级预检是它的前置证明，不是可选项。
--
-- 约束名从哪来（推理依据 + 运行期实测双保险）
-- ---------------------------------------------------------------
--   · `0018` 的两处都是**列内联、无名** CHECK（`target_type varchar(32) NOT NULL CHECK (…)`），
--     没有 `CONSTRAINT <name>` 子句；`0018` 之后也没有任何 `ALTER TABLE … RENAME CONSTRAINT` 动过它们
--     （本仓迁移目录 `git grep -n "RENAME CONSTRAINT" services/api/db/migrations` 零命中）。
--   · PostgreSQL 对列内联无名 CHECK 的默认命名是 `<table>_<column>_check`
--     ⇒ 预期名 `favorites_target_type_check` / `history_target_type_check`。
--   · 但「名字对不上」不该靠推理兜底：动 DDL 前再用 `pg_constraint` 预检一次「这两个名字确实存在、
--     且确实是对应表 `target_type` 列上的 CHECK」；对不上就 `RAISE EXCEPTION 'G0014'` 并列出该表
--     现有 CHECK 的名字与定义（fail-closed，交人工按真实名字收敛）。
--   · 因为预检已经证明存在，下面的 `DROP CONSTRAINT` **刻意不写 `IF EXISTS`**：`IF EXISTS` 只会把
--     「预检之后名字又变了」这种意外变成静默空转（旧 16 值约束还在、`ADD CONSTRAINT` 又建一个同名新约束
--     ⇒ 迁移"成功"但第 17 值根本没放开）。
--
-- 错误码（都是**迁移期**预检，不是运行期错误码，不进 HTTP 错误面）
-- ---------------------------------------------------------------
--   G0013 FAVORITES_HISTORY_TARGET_TYPE_CLOSED_SET_VIOLATION
--         两表 `target_type` 存在契约 17 值闭集之外的取值（含 NULL）
--   G0014 TARGET_TYPE_CHECK_CONSTRAINT_NOT_FOUND
--         `favorites_target_type_check` / `history_target_type_check` 不在预期位置
--
-- 不碰什么
-- ---------------------------------------------------------------
--   ⛔ 不动其它列、索引与数据：`favorites_owner_target_key`、`favorites_owner_created_idx`、
--   `history` 的 `kind`/`job_state`/`event_key` 等约束，以及两表的任何行一律不改；
--   ⛔ 不新增列、不改列宽（`varchar(32)` 装得下 `conversation_turn`）。
--
-- 回滚：`rollback/0042_favorites_history_target_type_conversation_turn.down.sql`
--   把两表 CHECK 放回 16 值；**先预检**：库内若已有 `target_type='conversation_turn'` 的行即中止
--   （回滚不能把数据写回契约闭集之外；那种情况下正确的动作是回滚**应用版本**，不是回滚约束）。
--
-- 号位：正向最大号是 `0041`、`0037` 是登记在保留台账里的在途缺号 ⇒ 取最大号 +1 = `0042`；
-- `services/api/db/migration-reservations.json` **不新增条目**（本片即落盘）。
BEGIN;

-- ---------------------------------------------------------------------------
-- ① 预检 A：数据里不得出现 17 值闭集之外的取值（只报告、不删行、不映射）
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  x_allowed text[] := ARRAY[
    'species', 'herbicide', 'scheme', 'static_region', 'recognition', 'ocr',
    'transcription', 'answer', 'post', 'comment', 'conversation', 'conversation_turn',
    'dose_card', 'media', 'synthesis', 'job', 'source'
  ];
  x_bad_favorites integer;
  x_bad_history   integer;
  x_bad_total     integer;
  x_samples       text;
BEGIN
  SELECT count(*) INTO x_bad_favorites
    FROM public.favorites f
   WHERE f.target_type IS NULL OR NOT (f.target_type = ANY (x_allowed));

  SELECT count(*) INTO x_bad_history
    FROM public.history h
   WHERE h.target_type IS NULL OR NOT (h.target_type = ANY (x_allowed));

  x_bad_total := x_bad_favorites + x_bad_history;

  IF x_bad_total > 0 THEN
    SELECT string_agg(format('%s.target_type=%s（%s 行）', s.tbl, s.value, s.row_count),
                      ', ' ORDER BY s.tbl, s.value)
      INTO x_samples
      FROM (
        SELECT 'favorites'::text AS tbl, coalesce(f.target_type, '<null>') AS value,
               count(*)::bigint AS row_count
          FROM public.favorites f
         WHERE f.target_type IS NULL OR NOT (f.target_type = ANY (x_allowed))
         GROUP BY coalesce(f.target_type, '<null>')
        UNION ALL
        SELECT 'history'::text, coalesce(h.target_type, '<null>'), count(*)::bigint
          FROM public.history h
         WHERE h.target_type IS NULL OR NOT (h.target_type = ANY (x_allowed))
         GROUP BY coalesce(h.target_type, '<null>')
      ) s;

    RAISE EXCEPTION USING
      ERRCODE = 'G0013',
      MESSAGE = 'FAVORITES_HISTORY_TARGET_TYPE_CLOSED_SET_VIOLATION',
      DETAIL = format(
        '迁移 0042 中止：%s 行 target_type 落在契约 17 值闭集之外（favorites %s 行 / history %s 行；样例：%s）。闭集 = %s。',
        x_bad_total, x_bad_favorites, x_bad_history, x_samples, array_to_string(x_allowed, ', ')),
      HINT = '本迁移只报告、不删行、不映射。这些行说明库里有契约外的历史脏值（可能是手工写入或更早的写路径留下的）'
             '：请先逐行核对真实目标类型（含 <null>）并裁定补齐/更正口径，再重跑本迁移；'
             '⛔ 不要改 0018 的文本（checksum 会拦住既有库升级），⛔ 不要为了通过而删行或改写成「最像的」合法值。';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ② 预检 B：两处约束必须真的是「预期名字 + 对应表 target_type 列上的 CHECK」
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  x_found  integer;
  x_actual text;
BEGIN
  SELECT count(*) INTO x_found
    FROM (VALUES ('favorites'::text, 'favorites_target_type_check'::text),
                 ('history'::text,   'history_target_type_check'::text)) AS e(tbl, conname)
   WHERE EXISTS (
           SELECT 1
             FROM pg_constraint c
             JOIN pg_class      r ON r.oid = c.conrelid
             JOIN pg_namespace  n ON n.oid = r.relnamespace
             JOIN pg_attribute  a ON a.attrelid = r.oid AND a.attname = 'target_type'
            WHERE n.nspname = 'public'
              AND r.relname = e.tbl
              AND c.conname = e.conname
              AND c.contype = 'c'
              AND c.conkey  = ARRAY[a.attnum]::smallint[]);

  IF x_found <> 2 THEN
    SELECT string_agg(format('%s.%s = %s', s.tbl, s.conname, s.def), E'\n  ' ORDER BY s.tbl, s.conname)
      INTO x_actual
      FROM (
        SELECT r.relname::text                    AS tbl,
               c.conname::text                    AS conname,
               pg_get_constraintdef(c.oid)        AS def
          FROM pg_constraint c
          JOIN pg_class     r ON r.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = r.relnamespace
         WHERE n.nspname = 'public'
           AND r.relname IN ('favorites', 'history')
           AND c.contype = 'c'
      ) s;

    RAISE EXCEPTION USING
      ERRCODE = 'G0014',
      MESSAGE = 'TARGET_TYPE_CHECK_CONSTRAINT_NOT_FOUND',
      DETAIL = format(
        '迁移 0042 中止：预期的两条列级 CHECK（public.favorites 上的 favorites_target_type_check、'
        'public.history 上的 history_target_type_check）没有找齐（找到 %s/2）。这两表现有 CHECK：%s',
        x_found, coalesce(x_actual, '（无）')),
      HINT = '0018 里两处 CHECK 都是列内联无名约束，PostgreSQL 默认命名为 <table>_<column>_check；'
             '名字/定义对不上说明该库的约束被显式改过名或被手工替换过。请先人工核对该库的真实约束名与定义，'
             '再决定改名或改本迁移（⛔ 不要直接加 IF EXISTS 盲删：删不掉旧约束时会留下更严的旧 16 值约束）。';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ③ 预检全过才动约束：16 值 ⇒ 17 值（顺序 = 契约 `TargetRef.type` 枚举顺序）
-- ---------------------------------------------------------------------------
ALTER TABLE public.favorites
  DROP CONSTRAINT favorites_target_type_check;

ALTER TABLE public.favorites
  ADD CONSTRAINT favorites_target_type_check CHECK (target_type IN (
    'species', 'herbicide', 'scheme', 'static_region', 'recognition', 'ocr',
    'transcription', 'answer', 'post', 'comment', 'conversation', 'conversation_turn',
    'dose_card', 'media', 'synthesis', 'job', 'source'
  ));

ALTER TABLE public.history
  DROP CONSTRAINT history_target_type_check;

ALTER TABLE public.history
  ADD CONSTRAINT history_target_type_check CHECK (target_type IN (
    'species', 'herbicide', 'scheme', 'static_region', 'recognition', 'ocr',
    'transcription', 'answer', 'post', 'comment', 'conversation', 'conversation_turn',
    'dose_card', 'media', 'synthesis', 'job', 'source'
  ));

COMMIT;
