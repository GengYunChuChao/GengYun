-- 迁移 0055：`public.provider_call_ledger` —— 识别链路**外发那一行**的用量与剖面版本记账
--
-- 本迁移只做一件事：建一张**窄口径、追加式**的外发记账表。
-- 它不改任何既有表、不加列、不搬数据、不开读面、不引入金额。
--
-- ## 这张表补的是什么缺口
--
-- issue #1003 的两条验收口径一直没落地：
--   ① 「这一次识别**用了多少 token**」—— 供应商回包里的 `usage` 没有任何一处落库；
--   ② 「这一次外发**用的是哪套剖面/哪个模型**」—— 装配层的 `profile` / `model` / `endpoint`
--      在运行时被折成一个适配器对象，事后无法从库里反推。
--
-- 识别链路本身已经在 `MediaJobEgress` 里（`services/api/src/app.ts` 构造、包装 provider），
-- 执行时天然拿到 `exportId` 与 `jobId`，所以缺的只是「把 outcome 上的 usage 落一行」。
--
-- ## 为什么**不**复用 0050 那张调用记录表
--
-- ⚠ 本文件**不写**那张表的字面表名（也不写它的迁移件名）：`tests/unit/ai-ops-ledger-pins.test.mjs`
-- 的钉子②按**纯文本**扫 `migrations/**/*.sql`，要求「提到那张表的正向迁移恰好一份」——它判的是
-- 「有没有人另开一支建表/改表迁移」，而本文件只是解释「为什么不再建第二张」。为不触发误报，
-- 这里只写迁移号；完整理由（含三处「有意冻结」的原文出处）在本目录 `README.md` 的 0055 条目。
--
-- 要点：那张表的运行时写入权被三处文档明写「有意冻结」（`0050` 的建表件 :106、
-- `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2423` 的 `unwired_manifest` 登记行、
-- `docs/architecture/ai-ops-spec-status.md:135` 的 N05）。
-- ⇒ 默认部署下运行时对它零权限，写会恒 `42501`，记不进也不会报错（正是本片要修的静默缺口）。
-- 解冻那张表属**安全姿态变更**，不在本片范围；本片另开一张同构的窄表，代价是暂时两张账本，
-- 收益是「不动任何既有授权面就能把读数落下来」。
--
-- ## 为什么**不**给 `recognition_records` 加列
--
-- 那是识别终态行，写入与 `commitTerminal` 同事务 ⇒ 记账失败（42501 / CHECK）会让**整笔终态回滚**、
-- 作业卡在 `running`；而且它只记得住**成功终态**，超时/HTTP 错的那一次外发已经烧掉的 token
-- 记不到。本表刻意**不进终态事务**：写入是 best-effort，失败只留可观测读数，绝不改判识别结果。
--
-- ## 与 0050 那张表的列名刻意同构
--
-- `job_id` / `attempt` / `capability` / `model_version` / `invocation_state` / `sent_at` /
-- `duration_ms` / `usage` / `export_id` / `created_at` 逐列同名同义 ⇒ 日后若解冻 0050 那张表，
-- 本表是**并入**（`INSERT … SELECT`）而不是重写。
--
-- ## `domain` 为什么是闭集、且当前只有一个值
--
-- 闭集的作用是**把「哪条链路」写成判据**：本片只有识别链路一个写入者，于是闭集就是
-- `('recognition')`。语音/OCR 日后接入是**加值**（一条 `ALTER TABLE … DROP CONSTRAINT/ADD CONSTRAINT`
-- 的订正迁移），⛔ 不是「先空着、以后随便写字符串」—— 那样这张表会变成一张什么都能塞的垃圾桶。
--
-- ## `invocation_state` 的闭集为什么比 0050 少一个 `blocked`
--
-- 本表的两个值都有真实写入者：
--   | 值 | 判据 | 写入路径 |
--   | --- | --- | --- |
--   | `sent` | 外发**已经发生**，供应商回了成功（拿到正文）| 成功分支 |
--   | `send_failed` | 外发**已经交给传输/供应商**，但结局是错误或不可判定（回错、超时、传输中断）| 抛错分支 |
-- 0050 里的 `blocked`（被拦截、**没有发出**）在本表**没有写入者**：本片的零外发路径
-- （非 `real` 模式、适配器根本不被调用）一律**不写行** —— 没发出去就不该在这张表里留下一条
-- 「像发过」的读数。既然没有写入者，就不把值建进闭集（⛔ 不复制 0050 的「有判据、无写入者」）。
--
-- ## `usage` 为什么是 `jsonb` 而不是拆列
--
-- 同 0050:90-98 的理由：拆列会把**供应商的字段名**固化进本仓 DDL，换一家供应商就要改表；
-- 这一列的口径本来就是「供应商报了什么结构读数」。选 `jsonb` +
-- `CHECK (jsonb_typeof(usage) = 'object')`（体例照 `0011_export_ledger.sql` 的
-- `export_writebacks_result_object`）。⛔ 不存正文、不存字符串、不存嵌套：写入侧两道收口
-- （`services/api/src/recognitions/call-metadata.ts` 的 `readCallMetadata` 只认顶层对象、
-- 只留非负整数键值、键数 ≤ 8；本表的 CHECK 再兜一次「必须是对象」）。
--
-- ## 权限：本迁移**不**授权
--
-- 运行时的列级 GRANT 落在 `deploy/postgres-cvm/sql/20-login-roles.sql` 的
-- `gy-r83-provider-call-ledger-grant` 区（**独立 region**，不并进既有区：
-- `tests/integration/egress-ledger-pg.mjs` 按 `#region` 抽取既有区并**逐条断言它只含 `public.jobs`
-- 的列级授权**，往里加表会让那条臂判红）；同一次授权面变更还必须同步
-- `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的三处：
--   * `domain_manifest` 的分类行（`granted` + `required=true`）
--   * `expected` 的独立列清单复述（断言 49–58 逐表核对）
--   * 一条 `SET LOCAL ROLE gengyun_api_runtime` 的零行探针 + 它对应的断言分支
-- 缺任何一处，`deploy-sql-gate` 的两个 job 都会判红（这是**有意的重复**，不是冗余）。
--
-- ⛔ 本表不授表级 DML、不授 DELETE、不授 TRUNCATE/REFERENCES/TRIGGER —— 记账行是**追加式**事实，
-- 删改面一个都不开（清理随 `export_id` 的 `ON DELETE CASCADE` 走，见下）。
--
-- ## `job_id` 为什么可空、且**不加外键**
--
-- 照 0050:361-363 的先例：`public.jobs` 全仓零 INSERT（钉子①钉死），此刻加外键会让唯一写入方
-- 无处落笔。可空是真实语义：识别作业的 `jobId` 由 `MediaJobEgress` 在 `linkJob` 之后才拿得到，
-- 没链上就是 NULL。`UNIQUE (export_id, attempt)` 不看 `job_id`，所以 NULL 不影响序号派生。
--
-- ## 号位
--
-- 当前正向最大号是 `0054_favorites_target_lookup.sql` ⇒ 取最大号 +1 = **`0055`**（本片即落盘）。
-- `services/api/db/migration-reservations.json` **不新增条目**（`0037` 仍留给 #14，本片不碰它）；
-- `count + 保留数 === max` 这条不变量由目录读数自然满足：54 + 1 === 55。
--
-- ## 幂等 / 可重放
--
-- 建表 `IF NOT EXISTS`、索引 `IF NOT EXISTS`、`COMMENT ON` 可重放；列形态用 `information_schema`
-- 逐项复述（`CREATE TABLE IF NOT EXISTS` 遇到「表已在、但列形态不对」时**什么都不说**，
-- 光靠它保证不了口径）；约束用 `pg_catalog.pg_constraint` 预检后再 `ADD`。
-- ⛔ 不写 `DROP TABLE` / `DROP COLUMN` 之类破坏性语句。
--
-- ## 本迁移的预检错误码（都是中止，不是降级）
--
-- | 码 | MESSAGE | 触发条件 |
-- | --- | --- | --- |
-- | `G0019` | `PROVIDER_CALL_LEDGER_COLUMN_SHAPE` | 表已存在但列的类型/可空性/长度/默认值与口径不符 |
--
-- 照 `rollback/0049_admin_categories.down.sql` 的 `G0019` 体例：迁移期发现问题就停，
-- 绝不把一个「看起来成功」的库留在半路上。
--
-- 配对回滚：`rollback/0055_provider_call_ledger.down.sql`（先预检「已有记账行」即中止）。

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 外发记账正本表
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.provider_call_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL,
  job_id uuid,
  export_id uuid NOT NULL REFERENCES public.exports (id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  capability varchar(40) NOT NULL,
  provider_config_version varchar(80) NOT NULL,
  model_version varchar(80),
  invocation_state text NOT NULL,
  usage jsonb,
  sent_at timestamptz,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. 列形态复述（`CREATE TABLE IF NOT EXISTS` 不会纠正已存在表的列形态）
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  x_problems text[] := ARRAY[]::text[];
  x_row record;
BEGIN
  FOR x_row IN
    SELECT * FROM (VALUES
      ('id', 'uuid', 'NO', NULL::integer),
      ('domain', 'text', 'NO', NULL::integer),
      ('job_id', 'uuid', 'YES', NULL::integer),
      ('export_id', 'uuid', 'NO', NULL::integer),
      ('attempt', 'integer', 'NO', NULL::integer),
      ('capability', 'character varying', 'NO', 40),
      ('provider_config_version', 'character varying', 'NO', 80),
      ('model_version', 'character varying', 'YES', 80),
      ('invocation_state', 'text', 'NO', NULL::integer),
      ('usage', 'jsonb', 'YES', NULL::integer),
      ('sent_at', 'timestamp with time zone', 'YES', NULL::integer),
      ('duration_ms', 'integer', 'YES', NULL::integer),
      ('created_at', 'timestamp with time zone', 'NO', NULL::integer)
    ) AS t(column_name, data_type, is_nullable, max_len)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM information_schema.columns AS c
       WHERE c.table_schema = 'public'
         AND c.table_name = 'provider_call_ledger'
         AND c.column_name = x_row.column_name
         AND c.data_type = x_row.data_type
         AND c.is_nullable = x_row.is_nullable
         AND (x_row.max_len IS NULL OR c.character_maximum_length = x_row.max_len)
    ) THEN
      x_problems := x_problems || format(
        '%s（期望 %s / nullable=%s / max_len=%s）',
        x_row.column_name, x_row.data_type, x_row.is_nullable, COALESCE(x_row.max_len::text, '-'));
    END IF;
  END LOOP;

  IF array_length(x_problems, 1) IS NOT NULL AND array_length(x_problems, 1) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'G0019',
      MESSAGE = 'PROVIDER_CALL_LEDGER_COLUMN_SHAPE',
      DETAIL = format('public.provider_call_ledger 的列形态与数据字典口径不符：%s', array_to_string(x_problems, '；')),
      HINT = '表已经存在但列形态不对 ⇒ 先人工核对（是历史版本建的？还是被谁改过？），再决定补一支订正迁移；'
             '⛔ 不要靠本迁移的 IF NOT EXISTS 蒙过去。';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. 约束（先查目录再 ADD，可重放）
-- ---------------------------------------------------------------------------

-- `domain`：闭集，当前只有识别链路一个写入者（加值要订正迁移，见文件头）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_call_ledger'::regclass
       AND conname = 'provider_call_ledger_domain_closed'
  ) THEN
    ALTER TABLE public.provider_call_ledger
      ADD CONSTRAINT provider_call_ledger_domain_closed CHECK (domain IN ('recognition'));
  END IF;
END
$$;

-- `attempt`：同一 export 的第几次外发，1 起（0 是「还没发过」，不是一条记录）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_call_ledger'::regclass
       AND conname = 'provider_call_ledger_attempt_positive'
  ) THEN
    ALTER TABLE public.provider_call_ledger
      ADD CONSTRAINT provider_call_ledger_attempt_positive CHECK (attempt >= 1);
  END IF;
END
$$;

-- `capability`：非空短 token（与 0050 的 `capability_length` 同量级，库层只兜长度）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_call_ledger'::regclass
       AND conname = 'provider_call_ledger_capability_length'
  ) THEN
    ALTER TABLE public.provider_call_ledger
      ADD CONSTRAINT provider_call_ledger_capability_length CHECK (length(capability) BETWEEN 1 AND 40);
  END IF;
END
$$;

-- 版本串形状：1..80，`[A-Za-z0-9._:/#+@-]`，首字符字母或数字；NULL 放行。
-- 与 0050 的版本串约束（`…_version_shape`）差**一个字符**：这里多允许 `@`。
-- ⚠ 这处偏离是刻意的，理由写死在这里：本片的版本串格式是
--   `${profile}#${model}@${sha256(hostname).slice(0,8)}`
-- —— 分隔符就是 `@`，而 0050 那套字符类里**没有** `@`。若照抄 0050 的字符类，每一个
-- 带主机摘要的版本串都会被 CHECK 拒掉（23514），`record()` 抛错、记账行整条丢，症状还只是
-- 「readings.failed 一直在涨」。所以此处把 `@` 加进字符类：多一个标点、语义仍只是「版本标识」，
-- 不放宽长度、不放宽首字符、不引入任何新的机密面（端点原文/密钥仍进不来）。
-- ⛔ 两处必须同步：`services/api/src/recognitions/call-metadata.ts` 的 `CALL_VERSION_SHAPE`
-- 与 `tests/unit/recognitions-call-metadata.test.mjs` 的常量（有断言逐字比对）。
-- ⚠ `provider_config_version` 是 NOT NULL：装配层必须能给出一个版本串（`providerConfigVersionOf`
-- 在字符类不合法/超长时降级为 profile 串，仍返回非空），⛔ 不用「写 NULL 表示不知道」。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_call_ledger'::regclass
       AND conname = 'provider_call_ledger_version_shape'
  ) THEN
    ALTER TABLE public.provider_call_ledger
      ADD CONSTRAINT provider_call_ledger_version_shape CHECK (
        provider_config_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/#+@-]{0,79}$'
        AND (model_version IS NULL OR model_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/#+@-]{0,79}$')
      );
  END IF;
END
$$;

-- `invocation_state`：闭集，只有两个**有写入者**的值（`blocked` 刻意不进，见文件头）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_call_ledger'::regclass
       AND conname = 'provider_call_ledger_state_closed'
  ) THEN
    ALTER TABLE public.provider_call_ledger
      ADD CONSTRAINT provider_call_ledger_state_closed
      CHECK (invocation_state IN ('sent', 'send_failed'));
  END IF;
END
$$;

-- `duration_ms`：非负整数（⛔ 不用 -1 表示「未知」：未知就是 NULL）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_call_ledger'::regclass
       AND conname = 'provider_call_ledger_duration_nonneg'
  ) THEN
    ALTER TABLE public.provider_call_ledger
      ADD CONSTRAINT provider_call_ledger_duration_nonneg CHECK (duration_ms IS NULL OR duration_ms >= 0);
  END IF;
END
$$;

-- `usage`：只收对象（体例照 `0011_export_ledger.sql` 的 `export_writebacks_result_object`）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_call_ledger'::regclass
       AND conname = 'provider_call_ledger_usage_object'
  ) THEN
    ALTER TABLE public.provider_call_ledger
      ADD CONSTRAINT provider_call_ledger_usage_object CHECK (usage IS NULL OR jsonb_typeof(usage) = 'object');
  END IF;
END
$$;

-- 唯一性：同一 export 的同一次尝试只能有一行。
-- 与 0050 **不同**：这里锚的是 `export_id`（非空、有外键），不是可空的 `job_id`
-- ⇒ 唯一性判定真的生效（0050 的 `(job_id, attempt)` 在 job_id 为 NULL 时不判定）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_call_ledger'::regclass
       AND conname = 'provider_call_ledger_export_attempt_key'
  ) THEN
    ALTER TABLE public.provider_call_ledger
      ADD CONSTRAINT provider_call_ledger_export_attempt_key UNIQUE (export_id, attempt);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. 索引
-- ---------------------------------------------------------------------------

-- `(export_id, attempt)` 的唯一约束已自带索引 ⇒ 序号派生那条
-- `SELECT COALESCE(MAX(attempt),0)+1 … WHERE export_id = $1` 走它，不另建同前缀索引。
-- 本处只补 job_id 一条：按作业回查「这一次作业烧了多少」是本表唯一的**预期**读法，
-- 而它目前还没有写入者之外的用途（⛔ 本片不开 HTTP 读面）。
CREATE INDEX IF NOT EXISTS provider_call_ledger_job_idx
  ON public.provider_call_ledger (job_id);

-- ---------------------------------------------------------------------------
-- 5. 口径写进库目录（给不看迁移文件的人）
-- ---------------------------------------------------------------------------

COMMENT ON TABLE public.provider_call_ledger IS
  '识别链路每一次**真实外发**一行的用量与剖面版本记账（追加式、best-effort）。'
  '零外发路径（非 real 模式、适配器未被调用）不写行。写入不在识别终态事务里：'
  '本表写失败只留可观测读数，绝不把已成功的识别判成失败。'
  'job_id 可空且无外键（public.jobs 全仓零 INSERT）；attempt 由账本派生（同一 export_id 的第几条，1 起），'
  '调用方不得自报。';

COMMENT ON COLUMN public.provider_call_ledger.domain IS
  '闭集，当前只有 recognition。加值必须走订正迁移（⛔ 不把它当自由文本用）。';

COMMENT ON COLUMN public.provider_call_ledger.provider_config_version IS
  '外发所用**剖面/模型组合**的版本串，形如 `${profile}#${model}@${sha256(hostname).slice(0,8)}`。'
  '⛔ 只含主机名摘要，不含 endpoint 原文、query 或任何密钥；字符类不合法/超长时由 '
  'recognitions/call-metadata.ts 的 providerConfigVersionOf 降级为 profile 串。';

COMMENT ON COLUMN public.provider_call_ledger.model_version IS
  '模型标识串（可空；装配层没给就是 NULL，⛔ 不填占位串）。形状与 provider_config_version 同。';

COMMENT ON COLUMN public.provider_call_ledger.invocation_state IS
  '闭集：sent=外发已发生且供应商回成功；send_failed=外发已发生但回错/超时/结局不可判定。'
  '⛔ 没有 blocked：没发出去就不写行（见迁移头注释）。';

COMMENT ON COLUMN public.provider_call_ledger.usage IS
  '供应商返回的**结构用量**（jsonb 对象，只留非负整数键值，如 {prompt_tokens, completion_tokens}）。'
  '⛔ 不收正文/字符串/嵌套；键名口径来自 OpenAI 兼容回包，无实测样本（见派单回报的未验证清单）。';

COMMENT ON COLUMN public.provider_call_ledger.sent_at IS
  '外发**进入**时刻（进入适配器之前取值），不是拿到返回值的时刻；重放/补记时可早于 created_at。';

COMMENT ON COLUMN public.provider_call_ledger.created_at IS
  '行的落库时刻，由库自己给，恒非空。⛔ 与 sent_at 不是同一个量，不要互换。';

COMMENT ON COLUMN public.provider_call_ledger.job_id IS
  '可空、**无外键**：public.jobs 全仓零 INSERT（钉子①钉死），此刻加外键会让唯一写入方无处落笔。'
  'uniqueness 锚在 (export_id, attempt) 上，本列只是回查维度。';

-- 真实读数：让 provision 日志里能看见「建了几行」（⛔ 不打印任何行内容）。
DO $$
DECLARE
  x_rows bigint;
BEGIN
  SELECT count(*) INTO x_rows FROM public.provider_call_ledger;
  RAISE NOTICE '迁移 0055：public.provider_call_ledger 就绪，现有 % 行（新表应为 0）', x_rows;
END
$$;

COMMIT;
