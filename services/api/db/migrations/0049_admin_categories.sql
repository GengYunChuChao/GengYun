-- 迁移 0049 · 后台分类目录（`listAdminCategories` / `editCategory`）的**库层读写面**
--
-- ## 为什么必须新开一支迁移（不能改既有文件）
--
-- 这两个 operation 此前在 `services/api/src/admin/ops/accounts-only.ts:175-176` 是两条**字面裸
-- `reject`**（`listAdminCategories: reject` / `editCategory: reject`）—— 只要 `execution_mode=real`
-- 就恒 503，与库无关。拆掉裸 reject 只会得到**空页**，而契约两处 description 明写「⛔ 不返回空页
-- （空页会被读成「平台没有分类」，那是伪造读数）」⇒ 拆 reject 之前必须先有**真读真写**的数据面。
--
-- 而现有的 `public.crops`（`0001_initial_schema.sql:108-112`）与 `public.species`（`:114-121`）都缺
-- `description` / `revision`（`species` 还缺 `active`），也**没有**任何 CAS 载体列：
--
--   | 契约 `Category` 字段 | `crops`            | `species`               | 本迁移的处理 |
--   | `id`                 | `id varchar(40) PK`| `id varchar(40) PK`     | 回填成 `admin_categories.id` |
--   | `type`               | 无（表名即类型）   | 无                      | 回填成 `'crop'` / `'species'` |
--   | `name`               | `name varchar(80)` | `canonical_name varchar(120)` | 回填（`species` 用 `canonical_name`）|
--   | `description`        | **缺**             | **缺**                  | 新增列 + 回填占位说明 |
--   | `active`             | `active boolean`   | **缺**                  | `crops.active` 回填；`species` 置 `true` |
--   | `revision`           | **缺**             | **缺**                  | 新增列 + 回填 `1`（CAS 载体）|
--
-- ## 为什么是「新建目录表」而不是「给 crops/species 加列」
--
-- **先说清楚：新表不是被谁强迫的，它不是唯一解。** 给 `crops`/`species` 补
-- `description`/`revision`（`species` 还缺 `active`）同样合规，只是要连带改授权面：把这两张表
-- 从 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的 `external_manifest` 挪到
-- `domain_manifest` + `expected`（`media` 就是照这条路挪的，见该文件 `:1588-1597` 的裁定），
-- 再在 `20-login-roles.sql` 里对运行时直授列级权 —— `feature_flags` 就是
-- `source_group = 'direct'` 的现成先例（同文件 `:1576`）。该文件的 `external_violations` (c) 条
-- **并不禁止**直授，它要求的是「直授必须落在 `source_group = 'direct'` 的行上」。
--
-- 本片选新表，唯一的理由是**缩小改动面**：不动用户目录两张正本表的授权行
-- （`services/api/db/roles/profile_runtime.sql:21-28` 那两条 `UPDATE` 是 `SELECT … FOR SHARE`
-- 的锁列，属于「用户面只读目录」的组角色；把后台**写**权限挂进去等于改写最小权限基线的最小面），
-- 也不动既有普查清单的行归属与 `expected` 列清单。
--
-- **代价如实记：目录从此有两份真相。** 后台读写的是 `public.admin_categories`，而用户面
-- `GET /catalog/crops` / `GET /catalog/species` 仍读 `crops`/`species`
-- （`services/api/src/profile/service.ts:65`、`:78`）；本片**不双写** ⇒ 后台把某分类 `active`
-- 置 `false` 不会让 App 立刻看它下线，后台改名也不会改到用户面正本。收敛（用户面改读新表，
-- 或补一条同步迁移）留给后续片；当期可观测手段与漂移清单见
-- `services/api/src/admin/ops/categories-pg.ts` 文件头「两份真相」一节。
--
-- 另有一条次要理由（即使走「加列」路线也仍然成立）：`crops.name` 是 `varchar(80)`，装不下契约
-- `Category.name` 的 `maxLength: 120`，放宽宽度本身又是一次跨表列变更；`species.canonical_name`
-- 是带唯一索引的识别键（`species_canonical_name_key`），改它等于改识别身份，与契约
-- 「不由编辑名称扩大识别承诺」冲突。
--
-- 因此：**新建 `public.admin_categories`（后台字典的正本）**，迁移里从 `crops`/`species` **回填一次**，
-- 之后 `crops`/`species` 保持原样（它们是识别域的正本，不被本片改写）。表的授权面走
-- `20-login-roles.sql` 的**直授列级权**（与内容域 `admin_content_*` 三表同一体例），并在
-- `90-assert-least-privilege.sql` 的 `domain_manifest` + `expected` 里做独立复述。
--
-- ## 审计为什么必须走窄口径 `SECURITY DEFINER` 函数
--
-- `public.admin_audit_events` 对运行时是**零表级、零列级写**（`90-assert` 的 `external_manifest` 与
-- `protected_columns` 钉死，表上还有 append-only 触发器），所以审计只能沿用 `0041`/`0043`/`0047`/`0048`
-- 已裁定的第三条路：**窄口径函数 + `REVOKE ALL … FROM PUBLIC` + 只授 `EXECUTE`**。函数内把
-- `action='category.update'` / `scope='sources:write'` / `result='accepted'` / `reason_code='category_updated'`
-- 全部**字面量**固定、`target_ref` 固定为 `NULL`（契约 `TargetRef.type` 闭集里没有 category，
-- 与内存路径 `targetRef: null` 一致）、`target_hint` 由形参重建 ⇒ 调用方伪造不了 actor、动作文本或 target。
--
-- ⚠ 本迁移**不给**运行时任何 `INSERT`/`DELETE` 权限：契约没有「新建分类」「删除分类」两个 operation
-- （`CategoryInput` 只有 `name`/`description`/`active`，`type` 不可编辑）⇒ 表里不该出现后台新建的行。
--
-- ## 号位
--
-- 当前正向最大号是 `0048_admin_account_disable.sql`、`0037` 是 `services/api/db/migration-reservations.json`
-- 里 #14 的保留缺号（`count + 保留数 === max` ⇒ `47 + 1 === 48`）⇒ 取最大号 +1 = **`0049`**
-- （本片即落盘，`services/api/db/migration-reservations.json` **不新增条目**）。
--
-- ## 幂等 / 可重放
--
-- 每一句都能在已应用过的库上重放：建表 `IF NOT EXISTS`、加列 `ADD COLUMN IF NOT EXISTS`、
-- 约束用 `pg_constraint` 目录预检后再 `ADD`、回填用 `ON CONFLICT (id) DO NOTHING`、
-- 函数用 `CREATE OR REPLACE`。⛔ 不写 `DROP TABLE`/`DROP COLUMN` 之类破坏性语句。
--
-- ## 本迁移的预检错误码（都是中止，不是降级）
--
-- | 码 | MESSAGE | 触发条件 |
-- | --- | --- | --- |
-- | `G0019` | `CATALOG_BACKFILL_ID_COLLISION` | `crops` 与 `species` 出现同 id 行（会被主键吞掉其中一类）|
-- | `G0019` | `CATALOG_BACKFILL_INCOMPLETE` | 回填后仍有来源行没落进 `admin_categories`（少了行）|
-- | `G0019` | `CATALOG_COLUMN_SHAPE` | 列已存在但类型/长度/NOT NULL/DEFAULT 与契约不符 |
--
-- 三条都照 `rollback/0049_admin_categories.down.sql` 的 `G0019 CATALOG_ROLLBACK_BLOCKED` 同一体例：
-- 迁移期发现问题就停，绝不把一个「看起来成功」的库留在半路上。
--
-- 配对回滚：`rollback/0049_admin_categories.down.sql`（先预检「已有真实编辑/审计行」即中止）。

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 目录正本表
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.admin_categories (
  id varchar(80) PRIMARY KEY,
  type varchar(16) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 缺的列按契约 `Category` 逐列补齐（`name` 上限取契约的 120，⛔ 不是 `crops.name` 的 80）。
ALTER TABLE public.admin_categories
  ADD COLUMN IF NOT EXISTS name varchar(120) NOT NULL DEFAULT '（未编撰：目录项名称待人工补充）';
ALTER TABLE public.admin_categories
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '（未编撰：目录项说明待人工补充）';
ALTER TABLE public.admin_categories
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
-- `revision` 是 CAS 载体：读改写一律 `WHERE id = $1 AND revision = $2`（写法照 `public.regions.revision`）。
ALTER TABLE public.admin_categories
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.admin_categories
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- 列形态要自己复述（N4）：`ADD COLUMN IF NOT EXISTS` 遇到「列已存在但不带 NOT NULL / 不带
-- DEFAULT / 类型或长度不对」时**什么也不做、也不报错** ⇒ 光靠它保证不了契约需要的列形态。
-- 这里从 `information_schema.columns` 把五列的类型、长度、可空性、默认值逐项对一遍，
-- 不符即中止（`G0019 CATALOG_COLUMN_SHAPE`），不留「表看着在、列其实是宽口径」的半成品。
DO $$
DECLARE
  x_bad text;
BEGIN
  SELECT string_agg(format('%s（类型 %s、长度 %s、可空 %s、默认 %s）',
                           want.column_name,
                           coalesce(actual.data_type, '缺列'),
                           coalesce(actual.character_maximum_length::text, '-'),
                           coalesce(actual.is_nullable, '-'),
                           coalesce(left(actual.column_default, 40), '-')),
                    '；' ORDER BY want.column_name)
    INTO x_bad
    FROM (VALUES
            ('name',        'character varying',         120,  true, true),
            ('description', 'text',                      NULL, true, true),
            ('active',      'boolean',                   NULL, true, true),
            ('revision',    'integer',                   NULL, true, true),
            ('updated_at',  'timestamp with time zone',   NULL, true, true)
         ) AS want(column_name, data_type, max_length, needs_not_null, needs_default)
    LEFT JOIN information_schema.columns AS actual
      ON actual.table_schema = 'public'
     AND actual.table_name = 'admin_categories'
     AND actual.column_name = want.column_name
   WHERE actual.column_name IS NULL
      OR actual.data_type IS DISTINCT FROM want.data_type
      OR (want.max_length IS NOT NULL AND actual.character_maximum_length IS DISTINCT FROM want.max_length)
      OR (want.needs_not_null AND actual.is_nullable IS DISTINCT FROM 'NO')
      OR (want.needs_default AND actual.column_default IS NULL);

  IF x_bad IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'G0019',
      MESSAGE = 'CATALOG_COLUMN_SHAPE',
      DETAIL = format('public.admin_categories 的列形态与契约不符：%s', x_bad),
      HINT = 'ADD COLUMN IF NOT EXISTS 不会修正已存在的列；先手工 ALTER 到契约形态（NOT NULL + DEFAULT + 类型/长度），再重跑本迁移。';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. 从 crops / species 回填（一次性、幂等）
-- ---------------------------------------------------------------------------
--
-- 回填**只搬运库内已有的事实**：`id`/`name`（species 用 `canonical_name`）/`active`。
-- `description` 两表都没有对应列 ⇒ 回填一句**明确标为未编撰**的占位说明，而不是编一段业务文本
-- （编造说明＝伪造读数）。占位句以「（未编撰：」开头，可被一条 SQL 精确定位与替换。
--
-- ## ⚠ id 命名空间（N1）：两类共用 `admin_categories.id` 主键，冲突**不再静默丢行**
--
-- `crops.id`（`crop_*`）与 `species.id`（`species_*`）在种子数据里前缀不同、互不冲突，但两者在库里
-- 都只是 `varchar(40) PRIMARY KEY`，**没有任何约束禁止跨表同 id**。原来的写法两条 `INSERT` 都用
-- `ON CONFLICT (id) DO NOTHING` ⇒ 若真出现跨表同 id，后插入的那一类会被**静默丢弃**（无 NOTICE、
-- 无断言、后台少一行且无人知道）。
--
-- 现在分两步处理，冲突一律 fail-closed（`G0019 CATALOG_BACKFILL_ID_COLLISION`），绝不静默吞行：
-- 1. 回填**前**先算账：把「可回填的 `crops` 与 `species` id 交集」全数列出，非空即中止迁移，
--    由人决定在源表消歧（改 id）还是给其中一类加前缀；
-- 2. 回填**后**再核对：`admin_categories` 里落下的行数必须等于「两类可回填行数之和」，
--    且不许多、不许少（`G0019 CATALOG_BACKFILL_INCOMPLETE`）。两条都用 `RAISE NOTICE` 打出
--    真实行数，`psql -f` 的输出里能直接看到这次回填搬了多少行（幂等重放时也照打）。

DO $$
DECLARE
  x_crops integer;
  x_species integer;
  x_collisions text;
BEGIN
  SELECT count(*) INTO x_crops
    FROM public.crops AS c
   WHERE c.id IS NOT NULL AND c.name IS NOT NULL AND length(c.name) BETWEEN 1 AND 120;
  SELECT count(*) INTO x_species
    FROM public.species AS s
   WHERE s.id IS NOT NULL AND s.canonical_name IS NOT NULL AND length(s.canonical_name) BETWEEN 1 AND 120;

  SELECT string_agg(c.id, '、' ORDER BY c.id) INTO x_collisions
    FROM public.crops AS c
    JOIN public.species AS s ON s.id = c.id
   WHERE c.id IS NOT NULL AND c.name IS NOT NULL AND length(c.name) BETWEEN 1 AND 120
     AND s.canonical_name IS NOT NULL AND length(s.canonical_name) BETWEEN 1 AND 120;

  IF x_collisions IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'G0019',
      MESSAGE = 'CATALOG_BACKFILL_ID_COLLISION',
      DETAIL = format('crops 与 species 存在同 id 行，admin_categories 的单列主键装不下两类：%s', x_collisions),
      HINT = '先在源表消歧（改 id）或给其中一类加统一前缀，再重跑本迁移；本迁移拒绝静默丢弃任何一行。';
  END IF;

  RAISE NOTICE '迁移 0049 回填前账：crops 可回填 % 行、species 可回填 % 行、跨表同 id 0 行（合计 % 行）',
    x_crops, x_species, x_crops + x_species;
END
$$;

INSERT INTO public.admin_categories (id, type, name, description, active, revision)
SELECT c.id,
       'crop',
       c.name,
       '（未编撰：迁移 0049 从 public.crops 回填，说明待人工补充）',
       c.active,
       1
  FROM public.crops AS c
 WHERE c.id IS NOT NULL
   AND c.name IS NOT NULL
   AND length(c.name) BETWEEN 1 AND 120
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.admin_categories (id, type, name, description, active, revision)
SELECT s.id,
       'species',
       s.canonical_name,
       '（未编撰：迁移 0049 从 public.species 回填，说明待人工补充）',
       true,
       1
  FROM public.species AS s
 WHERE s.id IS NOT NULL
   AND s.canonical_name IS NOT NULL
   AND length(s.canonical_name) BETWEEN 1 AND 120
ON CONFLICT (id) DO NOTHING;

-- 回填后的账（N1 的第二半）：**行数必须对得上**，少一行就中止而不是留个缺口。
-- 判据用「来源行是否都落了表」而不是裸 `count(*) = crops + species`，这样幂等重放时
-- 后台已编辑过的行（`revision > 1`）不会让这条断言误报，而真正的丢行一定会被抓住。
DO $$
DECLARE
  x_crops integer;
  x_species integer;
  x_seeded integer;
  x_missing text;
BEGIN
  SELECT count(*) INTO x_crops
    FROM public.crops AS c
   WHERE c.id IS NOT NULL AND c.name IS NOT NULL AND length(c.name) BETWEEN 1 AND 120;
  SELECT count(*) INTO x_species
    FROM public.species AS s
   WHERE s.id IS NOT NULL AND s.canonical_name IS NOT NULL AND length(s.canonical_name) BETWEEN 1 AND 120;

  SELECT count(*) INTO x_seeded
    FROM public.admin_categories AS a
   WHERE (a.type = 'crop'
          AND EXISTS (SELECT 1 FROM public.crops AS c
                       WHERE c.id = a.id AND c.name IS NOT NULL AND length(c.name) BETWEEN 1 AND 120))
      OR (a.type = 'species'
          AND EXISTS (SELECT 1 FROM public.species AS s
                       WHERE s.id = a.id AND s.canonical_name IS NOT NULL
                         AND length(s.canonical_name) BETWEEN 1 AND 120));

  SELECT string_agg(missing.id || '（' || missing.type || '）', '、' ORDER BY missing.id) INTO x_missing
    FROM (
      SELECT c.id, 'crop' AS type
        FROM public.crops AS c
       WHERE c.id IS NOT NULL AND c.name IS NOT NULL AND length(c.name) BETWEEN 1 AND 120
         AND NOT EXISTS (SELECT 1 FROM public.admin_categories AS a WHERE a.id = c.id AND a.type = 'crop')
      UNION ALL
      SELECT s.id, 'species'
        FROM public.species AS s
       WHERE s.id IS NOT NULL AND s.canonical_name IS NOT NULL
         AND length(s.canonical_name) BETWEEN 1 AND 120
         AND NOT EXISTS (SELECT 1 FROM public.admin_categories AS a WHERE a.id = s.id AND a.type = 'species')
    ) AS missing;

  IF x_missing IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'G0019',
      MESSAGE = 'CATALOG_BACKFILL_INCOMPLETE',
      DETAIL = format('这些来源行没有落进 admin_categories：%s（crops %s 行 + species %s 行，已落 %s 行）',
                      x_missing, x_crops, x_species, x_seeded),
      HINT = '回填用 ON CONFLICT (id) DO NOTHING 是幂等的；缺行说明 id 与已有行冲突或来源行为空值，人工核对后再重跑。';
  END IF;

  RAISE NOTICE '迁移 0049 回填后账：admin_categories 已落 % 行 = crops % 行 + species % 行（缺 0 行）',
    x_seeded, x_crops, x_species;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. 约束（先 `pg_constraint` 预检再 `ADD`，可重放）
-- ---------------------------------------------------------------------------
--
-- ⛔ 不用 `DROP CONSTRAINT IF EXISTS` + 盲 `ADD`：那会把「约束被人改名」静默放过。
-- 约束把契约闭集钉在库里：`type` 只有 crop/species、`name` 1..120、`description` 1..2000
-- （`minLength: 1` ⇒ 空串是**契约违法值**，库里不许存）、`revision >= 1`。

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'admin_categories_type_closed'
       AND conrelid = 'public.admin_categories'::regclass
  ) THEN
    ALTER TABLE public.admin_categories
      ADD CONSTRAINT admin_categories_type_closed CHECK (type IN ('crop', 'species'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'admin_categories_name_length'
       AND conrelid = 'public.admin_categories'::regclass
  ) THEN
    ALTER TABLE public.admin_categories
      ADD CONSTRAINT admin_categories_name_length CHECK (length(name) BETWEEN 1 AND 120);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'admin_categories_description_length'
       AND conrelid = 'public.admin_categories'::regclass
  ) THEN
    ALTER TABLE public.admin_categories
      ADD CONSTRAINT admin_categories_description_length CHECK (length(description) BETWEEN 1 AND 2000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'admin_categories_revision_positive'
       AND conrelid = 'public.admin_categories'::regclass
  ) THEN
    ALTER TABLE public.admin_categories
      ADD CONSTRAINT admin_categories_revision_positive CHECK (revision >= 1);
  END IF;
END;
$$;

-- 读面按 `id` 有序分页（契约 `listAdminCategories` 只有 Cursor + Limit，无过滤参数）⇒ 主键索引即够，
-- ⛔ 不预先建 `type`/`active` 索引：没有语句用到它们，多一个索引只是多一份无人核对的授权面。

-- ---------------------------------------------------------------------------
-- 4. 审计窄函数（后台分类编辑的唯一审计写路径）
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_admin_category_update(
  p_actor_id uuid,
  p_category_id text,
  p_category_revision integer,
  p_request_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_actor public.admin_accounts%ROWTYPE;
  x_live_revision integer;
  x_audit_id uuid;
BEGIN
  -- ① 入参自检（G0001）：NULL、空串、超契约上限、revision < 1 一律拒绝，⛔ 不靠调用方自觉。
  IF p_actor_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;
  IF p_category_id IS NULL OR length(p_category_id) < 1 OR length(p_category_id) > 80 THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;
  IF p_category_revision IS NULL OR p_category_revision < 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- ② 操作者必须存在（G0002）。
  SELECT * INTO x_actor FROM public.admin_accounts WHERE id = p_actor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;

  -- ③ 必须 `active`（G0010）。
  IF x_actor.state <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'G0010', MESSAGE = 'SCOPE_DENIED';
  END IF;

  -- ④ 必须**当前有效**持 `sources:write`（G0010）；`revoked_at IS NULL` 才算持有。
  IF NOT EXISTS (
    SELECT 1
      FROM public.admin_scopes AS s
     WHERE s.admin_id = p_actor_id
       AND s.scope = 'sources:write'
       AND s.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G0010', MESSAGE = 'SCOPE_DENIED';
  END IF;

  -- ⑤ 审计只能挂在**真实存在的修订**上：调用点在同事务内刚把 `revision` 抬到 p_category_revision，
  --    因此这里必然读到同一个值（G0002 = 行不在；G0001 = 传了别的修订号，即调用方在编数）。
  SELECT c.revision INTO x_live_revision FROM public.admin_categories AS c WHERE c.id = p_category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;
  IF x_live_revision <> p_category_revision THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  x_audit_id := gen_random_uuid();
  INSERT INTO public.admin_audit_events (
    id, actor_id, action, scope, target_ref, target_hint, reason_code, request_id, result
  ) VALUES (
    x_audit_id,
    p_actor_id,
    'category.update',
    'sources:write',
    NULL,
    'category:' || p_category_id,
    'category_updated',
    p_request_id,
    'accepted'
  );
  RETURN x_audit_id;
END;
$$;

COMMENT ON FUNCTION public.record_admin_category_update(uuid, text, integer, uuid) IS
  '后台分类编辑（category.update）的审计唯一写路径：action/scope/result/reason_code 在函数内字面量固定，target_ref 恒 NULL（契约 TargetRef.type 闭集无 category）、target_hint 由形参重建；重核验操作者存在 + active + 当前有效持 sources:write + 审计所挂 revision 真实存在于 public.admin_categories。';

REVOKE ALL ON FUNCTION public.record_admin_category_update(uuid, text, integer, uuid) FROM PUBLIC;

COMMIT;
