-- 迁移 0050 · `public.provider_invocations`：**每一次真实外发**一行的调用记录
--
-- ## 为什么现在建这张表
--
-- 数据字典 `docs/architecture/data-dictionary.md:48` 已经写死了口径（`provider_invocations / 受限`），
-- 但全仓到 0049 为止**没有这张表、也没有任何写入者**：`docs/architecture/ai-ops-spec-status.md:135`
-- 的 N05 行仍是「未实现（P1）……无迁移、无代码」。而 `docs/verification/product-readiness.md:64-65`
-- 已经把「返回与重试」的判据挂在这张表上（`exports.state` + `provider_invocations.invocation_state`
-- + `jobs.attempt`），并写明 `outcome_unknown` 不能自动重复计费 ⇒ 没有这张表，那几条判据无处落笔。
--
-- 本迁移只做**建表**这一件事：字段口径逐字照数据字典那一行，不做「顺手扩字段」。
-- 写入点在 `services/api/src/privacy/task-egress.ts`（`ChatEgress.send`）与
-- `services/api/src/privacy/ledger-pg.ts`（`recordInvocation` 原语）；读面只有
-- `PostgresExportLedger.listInvocations`（按 `export_id` 取本片的调用行），
-- ⛔ 本片不开 HTTP 读面（没有 operation、没有契约）。
--
-- ## 字段口径（逐列对照数据字典那一行）
--
-- | 字典字段 | 本表列 | 类型 / 约束 | 说明 |
-- | --- | --- | --- | --- |
-- | `id` | `id` | `uuid PK DEFAULT gen_random_uuid()` | 行标识，不回传调用方 |
-- | `job_id` | `job_id` | `uuid NULL`，**无外键** | 见下节「为什么不加外键」 |
-- | `attempt` | `attempt` | `integer NOT NULL CHECK (attempt >= 1)` | 同一 `export_id` 的第几次外发，1 起 |
-- | `capability` | `capability` | `text NOT NULL CHECK (length 1..40)` | 能力名（本片恒 `'llm'`）|
-- | `provider_version` | `provider_version` | `text NULL` + 形状 CHECK | 本片恒 `NULL`（见下节）|
-- | `model_version` | `model_version` | `text NULL` + 形状 CHECK | 形如 `model/<model>#live-1` |
-- | `sdk_version` | `sdk_version` | `text NULL` + 形状 CHECK | 本片恒 `NULL`（见下节）|
-- | `prompt_version?` | `prompt_version` | `text NULL` + 形状 CHECK | 形如 `prompt/citation-bind/1` |
-- | `rule_version` | `rule_version` | `text NULL` + 形状 CHECK | 本片恒 `NULL`（见下节）|
-- | `external_request_ref_cipher?` | `external_request_ref_cipher` | `text NULL` + 形状 CHECK | 本片恒 `NULL`（失败码与短引用 cipher），⛔ 不收明文 |
-- | `invocation_state` | `invocation_state` | `text NOT NULL` + 闭集 CHECK | 见下节词表 |
-- | `sent_at?` | `sent_at` | `timestamptz NULL` | 外发**进入**时刻（不是返回值时刻）|
-- | `duration_ms?` | `duration_ms` | `integer NULL CHECK (duration_ms >= 0)` | 本次 `call()` 的墙钟耗时 |
-- | `usage?` | `usage` | `jsonb NULL CHECK (jsonb_typeof = 'object')` | 只收结构用量读数 |
-- | `export_id` | `export_id` | `uuid NOT NULL REFERENCES public.exports (id) ON DELETE CASCADE` | 挂在哪条外发记录上 |
-- | （字典未列）| `created_at` | `timestamptz NOT NULL DEFAULT now()` | **行的写入时刻** |
--
-- ### `created_at` 为什么必须有（字典那一行没有它）
--
-- `sent_at` 是**外发**时刻，由写入方给出，且允许为空（结局未知的路径拿不到）；`created_at` 是
-- **落库**时刻，由库自己给，恒非空。两者不是同一个量（重放/补记时 `sent_at` 会早于 `created_at`），
-- 而「这件事是什么时候被记下来的」是可审计性的最小前提 ⇒ 单开一列，⛔ 不拿 `sent_at` 兼职。
--
-- ### 三个「字典没打 `?` 却建了可空列」的列（如实记差异）
--
-- `provider_version` / `sdk_version` / `rule_version` 在本片**没有单一真源**：
--
--   * `provider_version`：语义上最接近的是 `public.recipients.config_version`，但那是**接收方配置**
--     的版本（`ledger-pg.ts` 的 `resolveRecipient` 产出），不是供应商 API 版本 ⇒ ⛔ 不冒名顶替。
--   * `sdk_version`：全仓没有任何 SDK 版本读数（外发走的是 `fetch`，不是 SDK）⇒ 无来源。
--   * `rule_version`：规则版本的真源是 `services/api/src/conversations/service.ts:99`
--     `answerRuleVersion()`，由服务层写进回答行；外发口（`ChatEgress.send`）拿不到它，
--     且把「回答规则版本」当成「外发规则版本」是两回事。
--
-- 拿不到就留 `NULL`，⛔ 不填占位串（先例：`services/api/src/community/moderation-gate.ts:28`
-- 「`model_version` / `prompt_version` 属模型层，本片不产出、不填占位串」）。将来真接线时再出一支
-- 独立迁移把它们收紧成 `NOT NULL` —— 那样才有「先有读数、再收紧」的顺序。
-- 数据字典那一行的 `?` 记号（「可缺值」）由文档片统一措辞；本迁移把差异记在这里，不悄悄改口径。
--
-- ### 为什么不加 `job_id` 外键
--
-- `public.jobs`（`0001_initial_schema.sql`）在本仓**全仓零 INSERT**：这个事实由
-- `tests/unit/ai-ops-ledger-pins.test.mjs` 的钉子①钉死（语句级零命中、注释级两条白名单一字不差）。
-- 也就是说**此刻没有任何一行 jobs 是这条链路创建的**，加 `REFERENCES public.jobs (id)` 的后果是：
-- 唯一写入方（`ChatEgress.send`）要么被迫先造一行 jobs（越权、且会把「零 INSERT」钉子打红），
-- 要么每次写都撞 23503 —— 表看着建好了，实际无处落笔。
-- 因此 `job_id` **可空、无外键**，注释即契约：等 jobs 真的有了写入者、且本表确认要挂作业时，
-- 再出一支独立迁移补外键（并同步钉子①的裁定）。
--
-- `unique (job_id, attempt)` 照建：PG 的唯一索引里 **NULL 互不相等**（PG 17 手册
-- `CREATE INDEX`／`Unique Constraints` 一节：多列唯一索引在任一列为 NULL 时不做唯一性判定），
-- 所以「作业还没挂上」的多行不会互相顶撞；一旦 `job_id` 真实填上，同一作业的同一 attempt 只能有一行。
--
-- ### `invocation_state` 的闭集与每词判据
--
-- 代码里**唯一**的常量定义是 `services/api/src/privacy/ledger-pg.ts` 的 `INVOCATION_STATE`
-- （`Object.freeze`，三词），本文件的 CHECK 与它逐字一致；`tests/unit/provider-invocations-ledger.test.mjs`
-- 有一支用例把「迁移 CHECK 里的词表」与「常量」集合比对，多一个/少一个都判红。
--
-- | 值 | 判据（什么时候允许写）| 本片会不会写 |
-- | --- | --- | --- |
-- | `sent` | 外发**已经发生**，供应商回了成功（拿到正文/合规响应）| 会（成功路径）|
-- | `send_failed` | 外发**已经交给传输/供应商**，但结局是错误或不可判定（回错、超时、传输中断）| 会（抛错路径 + 回错以值返回的路径）|
-- | `blocked` | 被拦截、**没有发出**（例：预算闸门拒绝）| **不会**：本片的零外发路径（非 real 模式、执行前重查拒绝、预留失败）一律**不写行**——没发出去就不该在这张表里留下一条「像发过」的读数 |
--
-- `blocked` 现在没有写入者，仍然先建进闭集：闭集的用途是**把「没发」与「发失败」分开记**，
-- 等下一个拦截点（预算/配额闸门）落地时它就有出处；在那之前它是一条「有判据、无写入者」的值，
-- 这一点写在这里，免得后来人把它当成「已有实现的结局」。
--
-- ### `usage` 为什么是 `jsonb` 而不是拆列
--
-- 拆列（`prompt_tokens` / `completion_tokens` / `total_tokens` / …）会把**供应商的字段名**固化进
-- 本仓的 DDL：换一家供应商、或多个字段，就要改表；而这一列的口径本来就是「供应商报了什么结构读数」。
-- 选 `jsonb` + `CHECK (jsonb_typeof(usage) = 'object')`（体例照 `0011_export_ledger.sql` 的
-- `export_writebacks_result_object`），⛔ 不存正文、不存字符串、不存嵌套：写入侧两道收口
-- （`task-egress.ts` 的 `usageOfOutcome` 只认顶层 `usage`；`ledger-pg.ts` 的 `sanitizedUsage`
-- 只留非负整数键值，键形状 `^[a-z][a-z0-9_]{0,39}$`，最多 8 键）。
-- 代价如实记：`jsonb` 的列面不可判 ⇒ 将来若要做「按 token 计费」的聚合查询，得先定键名口径。
--
-- ## 权限：本迁移**不**授权（本片最大的已知缺口）
--
-- 运行时的列级 GRANT 落在两处，都**不在本片改动范围**：
--   * `deploy/postgres-cvm/sql/20-login-roles.sql`（每次 provision 都会跑的登录角色引导）
--   * `services/api/db/roles/egress_ledger.sql`（组角色 `gengyun_egress_ledger`，列级粒度）
--
-- ⇒ 默认部署下 `public.provider_invocations` 对运行时**零权限**，写入会以 `42501` 失败，
-- `ledger-pg.ts` 的 `mapPgError` 把它转成 `PROVIDER_UNAVAILABLE`（`retryable: false`），
-- 而 `task-egress.ts` 的写失败路径会**留下可观测读数**（`invocationReadings().failed` + 一条
-- `provider_invocation_write_failed` 日志事件），不会把已经成功的问答判成失败。
-- 同一次授权面变更还必须同步 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的
-- `expected` 清单，以及 `tests/unit/sql-column-coverage.test.mjs` 的钉死读数
-- （`sqlLiterals` / `columnRequirements` / `EXPECTED_EXTENDED_TABLES` 等）—— 那是**接线片**的活，
-- 本片只在派单回报里如实登记，不越界。
--
-- ## 号位
--
-- 当前正向最大号是 `0049_admin_categories.sql` ⇒ 取最大号 +1 = **`0050`**（本片即落盘）。
-- `services/api/db/migration-reservations.json` 是「有意空缺」台账，本片**不新增条目**
-- （没有任何缺号；`count + 保留数 === max` 这条不变量由目录读数自然满足：49 + 0 === 49 之后
-- 本轮落盘成 50 + 0 === 50）。
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
-- | `G0019` | `PROVIDER_INVOCATIONS_COLUMN_SHAPE` | 表已存在但列的类型/可空性/默认值与口径不符 |
-- | `G0019` | `PROVIDER_INVOCATIONS_CONSTRAINT_SHAPE` | 同名约束已在，但定义与口径不符 |
--
-- 两条都照 `rollback/0049_admin_categories.down.sql` 的 `G0019` 体例：迁移期发现问题就停，
-- 绝不把一个「看起来成功」的库留在半路上。
--
-- 配对回滚：`rollback/0050_provider_invocations.down.sql`（先预检「已有调用行」即中止）。

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 调用记录正本表
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.provider_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid,
  attempt integer NOT NULL,
  capability text NOT NULL,
  provider_version text,
  model_version text,
  sdk_version text,
  prompt_version text,
  rule_version text,
  external_request_ref_cipher text,
  invocation_state text NOT NULL,
  sent_at timestamptz,
  duration_ms integer,
  usage jsonb,
  export_id uuid NOT NULL REFERENCES public.exports (id) ON DELETE CASCADE,
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
      ('job_id', 'uuid', 'YES'),
      ('attempt', 'integer', 'NO'),
      ('capability', 'text', 'NO'),
      ('provider_version', 'text', 'YES'),
      ('model_version', 'text', 'YES'),
      ('sdk_version', 'text', 'YES'),
      ('prompt_version', 'text', 'YES'),
      ('rule_version', 'text', 'YES'),
      ('external_request_ref_cipher', 'text', 'YES'),
      ('invocation_state', 'text', 'NO'),
      ('sent_at', 'timestamp with time zone', 'YES'),
      ('duration_ms', 'integer', 'YES'),
      ('usage', 'jsonb', 'YES'),
      ('export_id', 'uuid', 'NO'),
      ('created_at', 'timestamp with time zone', 'NO'),
      ('id', 'uuid', 'NO')
    ) AS t(column_name, data_type, is_nullable)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM information_schema.columns AS c
       WHERE c.table_schema = 'public'
         AND c.table_name = 'provider_invocations'
         AND c.column_name = x_row.column_name
         AND c.data_type = x_row.data_type
         AND c.is_nullable = x_row.is_nullable
    ) THEN
      x_problems := x_problems || format('%s（期望 %s / nullable=%s）', x_row.column_name, x_row.data_type, x_row.is_nullable);
    END IF;
  END LOOP;

  IF array_length(x_problems, 1) IS NOT NULL AND array_length(x_problems, 1) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'G0019',
      MESSAGE = 'PROVIDER_INVOCATIONS_COLUMN_SHAPE',
      DETAIL = format('public.provider_invocations 的列形态与数据字典口径不符：%s', array_to_string(x_problems, '；')),
      HINT = '表已经存在但列形态不对 ⇒ 先人工核对（是历史版本建的？还是被谁改过？），再决定补一支订正迁移；'
             '⛔ 不要靠本迁移的 IF NOT EXISTS 蒙过去。';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. 约束（先查目录再 ADD，可重放）
-- ---------------------------------------------------------------------------

-- `attempt`：同一 export 的第几次外发，1 起（0 是「还没发过」，不是一条记录）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_invocations'::regclass
       AND conname = 'provider_invocations_attempt_positive'
  ) THEN
    ALTER TABLE public.provider_invocations
      ADD CONSTRAINT provider_invocations_attempt_positive CHECK (attempt >= 1);
  END IF;
END
$$;

-- `capability`：非空短 token（与 `ledger-pg.ts` 的 `SAFE_TOKEN` 同量级，库层只兜长度）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_invocations'::regclass
       AND conname = 'provider_invocations_capability_length'
  ) THEN
    ALTER TABLE public.provider_invocations
      ADD CONSTRAINT provider_invocations_capability_length CHECK (length(capability) BETWEEN 1 AND 40);
  END IF;
END
$$;

-- 版本串 / 引用 cipher 的形状：1..80，`[A-Za-z0-9._:/#+-]`，首字符字母或数字；NULL 放行。
-- 形状与 `ledger-pg.ts` 的 `VERSION_TOKEN` 一致（⛔ 不做「看起来像版本的都收」）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_invocations'::regclass
       AND conname = 'provider_invocations_version_shape'
  ) THEN
    ALTER TABLE public.provider_invocations
      ADD CONSTRAINT provider_invocations_version_shape CHECK (
        (provider_version IS NULL OR provider_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/#+-]{0,79}$')
        AND (model_version IS NULL OR model_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/#+-]{0,79}$')
        AND (sdk_version IS NULL OR sdk_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/#+-]{0,79}$')
        AND (prompt_version IS NULL OR prompt_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/#+-]{0,79}$')
        AND (rule_version IS NULL OR rule_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/#+-]{0,79}$')
        AND (external_request_ref_cipher IS NULL OR external_request_ref_cipher ~ '^[A-Za-z0-9][A-Za-z0-9._:/#+-]{0,79}$')
      );
  END IF;
END
$$;

-- `invocation_state`：闭集。词表与 `ledger-pg.ts` 的 `INVOCATION_STATE` 逐字一致（用例比对）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_invocations'::regclass
       AND conname = 'provider_invocations_state_closed'
  ) THEN
    ALTER TABLE public.provider_invocations
      ADD CONSTRAINT provider_invocations_state_closed
      CHECK (invocation_state IN ('sent', 'send_failed', 'blocked'));
  END IF;
END
$$;

-- `duration_ms`：非负整数（⛔ 不用 -1 表示「未知」：未知就是 NULL）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_invocations'::regclass
       AND conname = 'provider_invocations_duration_nonneg'
  ) THEN
    ALTER TABLE public.provider_invocations
      ADD CONSTRAINT provider_invocations_duration_nonneg CHECK (duration_ms IS NULL OR duration_ms >= 0);
  END IF;
END
$$;

-- `usage`：只收对象（体例照 `0011_export_ledger.sql` 的 `export_writebacks_result_object`）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_invocations'::regclass
       AND conname = 'provider_invocations_usage_object'
  ) THEN
    ALTER TABLE public.provider_invocations
      ADD CONSTRAINT provider_invocations_usage_object CHECK (usage IS NULL OR jsonb_typeof(usage) = 'object');
  END IF;
END
$$;

-- 唯一性：同一作业的同一次尝试只能有一行（`job_id` 为 NULL 时 PG 不做唯一性判定，见文件头）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_invocations'::regclass
       AND conname = 'provider_invocations_job_attempt_key'
  ) THEN
    ALTER TABLE public.provider_invocations
      ADD CONSTRAINT provider_invocations_job_attempt_key UNIQUE (job_id, attempt);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. 索引：按 export 取本片调用行（`listInvocations` 的唯一读法）+ 按 attempt 排序
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS provider_invocations_export_attempt_idx
  ON public.provider_invocations (export_id, attempt);

-- ---------------------------------------------------------------------------
-- 5. 口径写进库目录（给不看迁移文件的人）
-- ---------------------------------------------------------------------------

COMMENT ON TABLE public.provider_invocations IS
  '每一次**真实外发**一行的调用记录（数据字典 provider_invocations / 受限）。本表只记「已经发生的外发」：'
  '零外发路径（非 real 模式、执行前重查拒绝、预留失败）不写行。job_id 可空且无外键（public.jobs 全仓零 INSERT）；'
  'attempt 由账本派生（同一 export_id 的第几条，1 起），调用方不得自报。';

COMMENT ON COLUMN public.provider_invocations.invocation_state IS
  '闭集，与 services/api/src/privacy/ledger-pg.ts 的 INVOCATION_STATE 逐字一致：'
  'sent=外发已发生且供应商回成功；send_failed=外发已发生但回错/超时/结局不可判定；'
  'blocked=被拦截、没有发出（本片无写入者，零外发路径一律不写行，见迁移头注释）。';

COMMENT ON COLUMN public.provider_invocations.sent_at IS
  '外发**进入**时刻（进入 call() 之前取值），不是拿到返回值的时刻；重放/补记时可早于 created_at。';

COMMENT ON COLUMN public.provider_invocations.created_at IS
  '行的落库时刻，由库自己给，恒非空。⛔ 与 sent_at 不是同一个量，不要互换。';

COMMENT ON COLUMN public.provider_invocations.usage IS
  '供应商返回的**结构用量**（jsonb 对象，只留非负整数键值，如 {prompt_tokens, completion_tokens}）。'
  '⛔ 不收正文/字符串/嵌套；键名口径来自供应商文档，无实测样本（见派单回报的未验证清单）。';

COMMENT ON COLUMN public.provider_invocations.job_id IS
  '可空、**无外键**：public.jobs 全仓零 INSERT（钉子①钉死），此刻加外键会让唯一写入方无处落笔。'
  'unique (job_id, attempt) 照建（NULL 在唯一索引里互不相等）。';

-- 真实读数：让 provision 日志里能看见「建了几行」（⛔ 不打印任何行内容）。
DO $$
DECLARE
  x_rows bigint;
BEGIN
  SELECT count(*) INTO x_rows FROM public.provider_invocations;
  RAISE NOTICE '迁移 0050：public.provider_invocations 就绪，现有 % 行（新表应为 0）', x_rows;
END
$$;

COMMIT;
