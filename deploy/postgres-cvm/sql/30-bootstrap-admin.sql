-- ============================================================================
-- 耕云 · CVM PostgreSQL 17：首次元权限引导（一次性属主 seed）
--
-- 裁定依据：`.pg17/ruling-r64-pr4-design-20261026.md:52-56`（裁定 C）+ 对它的**唯一**修订
--   `.pg17/ruling-r64-c-bootstrap-seed-20261027.md`：引导审计**不新增** `admin_scope.bootstrap`
--   这个 action 值，改用既有闭集内的
--     action='admin_scope.grant' + scope='scopes:write' + result='accepted' + reason_code='bootstrap'。
--   其余约束（一次性、已有管理员必须报错、不接受明文口令、授 scope 落库、审计恰一行）一条不变。
--
-- 何时执行：`provision-db.sh` **之后**、启动 API **之前**，并且**只执行一次**。
--   runbook 见 deploy/postgres-cvm/runbook.md 的「步骤 3.5」。
--
-- 由谁执行：**迁移属主**（本交付为 `gengyun_cvm_owner`）。本文件要写
--   `public.admin_accounts` / `public.admin_scopes` / `public.admin_audit_events`，而运行时角色
--   `gengyun_api_runtime` 对前两张表只有列级 SELECT（`90-assert-least-privilege.sql` 把这两张表的
--   表级 INSERT/UPDATE/DELETE 钉成 false）⇒ 应用内的 `ensureBootstrapAdmin()`
--   （services/api/src/auth/service.ts:242-252，读 `ADMIN_BOOTSTRAP_LOGIN_NAME` /
--   `ADMIN_BOOTSTRAP_PASSWORD`，见 services/api/src/config.ts:167-200）在最小权限部署上
--   第一条 `INSERT INTO admin_accounts` 就是 `42501`。所以「首次属主」这一步只能落在部署档，
--   由本文件在**角色引导之后**用属主身份跑一次 —— 这正是裁定 C 要的"一次性元权限引导"。
--
-- 两个**必填**参数（⛔ 本文件不提供任何默认值；不传即停，不会"猜一个"）：
--   GENGYUN_BOOTSTRAP_ADMIN_LOGIN            登录名  → psql 变量 gy_admin_login
--   GENGYUN_BOOTSTRAP_ADMIN_CREDENTIAL_HASH  scrypt 摘要 → psql 变量 gy_admin_credential_hash
--   ⛔ **不接受明文口令**：本文件只收摘要。摘要由 services/api/src/auth/password.ts:16-20
--   （`hashPassword`）生成，形状固定为 `scrypt$N$r$p$saltB64$hashB64`
--   （N=16384、r=8、p=1、salt 16 字节、派生 64 字节）。形状不对 ⇒ §① 直接 `RAISE EXCEPTION`。
--
-- 本文件在**同一事务**内做三件事（全成功或全回滚）：
--   ① `public.admin_accounts` INSERT **恰 1 行**（`state`/`auth_epoch`/`revision`/`created_at`
--      全部走 0001_initial_schema.sql:63-72 的列默认值，**不手写**）；
--   ② `public.admin_scopes` 逐条字面授予 3 个 scope（理由见 §②，⛔ 不从字符串 split 动态生成）；
--   ③ `public.admin_audit_events` 落**恰一行**引导审计（见 §③）。
--
-- 为什么"已有管理员"必须 `RAISE EXCEPTION` 而不是静默跳过（裁定 C 原文要求）：
--   静默跳过会让"引导没跑"和"引导跑过了"在部署日志里长得一模一样；而
--   `verify-cvm-postgres.sh` 第 9.5 段正是靠"`reason_code='bootstrap'` 恰 1 行"判这次引导
--   到底有没有真的发生过。**引导只能发生一次**，第二次执行是异常，不是幂等成功。
--
-- 本文件**不做**的事（如实划界）：
--   - 不改口令、不做轮换、不重置 `auth_epoch`：口令轮换不在裁定 C 范围内；
--   - 不建会话、不发令牌：管理员首次登录仍走 `POST /admin/auth/login`；
--   - 不改任何既有管理员/既有授权：本文件在"表里已经有管理员"时直接失败。
--
-- 自查：`sudo deploy/postgres-cvm/verify-cvm-postgres.sh` 的第 9.5 段
--   （`bootstrap_audit_exactly_one` = 1、`scopes_write_active_holders` >= 1）。
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off

-- ---------------------------------------------------------------------------
-- §0 必填参数守卫（**早于任何写操作**；不传即停）
-- ---------------------------------------------------------------------------
-- 范式照抄 sql/20-login-roles.sql:74-99（`\getenv` + `\if :{?var}`）：
--   环境变量**未定义** ⇒ psql 变量保持未定义 ⇒ 走 `\else` 分支；
--   环境变量**定义为空串** ⇒ `\if :{?var}` 仍为真，由下面 §① 的形状判定兜住（⛔ 不静默通过）。
-- 分支体用 `SELECT 1/0` 而不是 `\quit`：`\quit` 的退出码是 **0**，会让"没传参数"在运维脚本
--   里读起来像成功；`1/0` 在 `ON_ERROR_STOP=1` 下让 psql 以非零退出（20-login-roles.sql 同）。
\getenv gy_admin_login GENGYUN_BOOTSTRAP_ADMIN_LOGIN
\if :{?gy_admin_login}
\else
  \echo '错误：环境变量 GENGYUN_BOOTSTRAP_ADMIN_LOGIN 未设置；本文件不提供默认登录名，拒绝引导。'
  SELECT 1/0;
\endif

\getenv gy_admin_credential_hash GENGYUN_BOOTSTRAP_ADMIN_CREDENTIAL_HASH
\if :{?gy_admin_credential_hash}
\else
  \echo '错误：环境变量 GENGYUN_BOOTSTRAP_ADMIN_CREDENTIAL_HASH 未设置；本文件不接受明文口令，只收 scrypt 摘要，拒绝引导。'
  SELECT 1/0;
\endif

BEGIN;

-- ---------------------------------------------------------------------------
-- §0.5 把 psql 变量搬进会话内临时表
-- ---------------------------------------------------------------------------
-- 为什么不直接在 DO 块里写 `:'gy_admin_login'`：psql 的 `:'var'` 插值作用于**顶层 SQL 文本**，
--   而 DO 块体是 `$bootstrap$…$bootstrap$` 的 dollar-quoted 字符串 —— 依赖"psql 会不会在
--   dollar-quoted 里插值"是不可移植的（各版本/各写法行为不一致，失败形态还很难读）。
--   搬进临时表后，DO 块只读普通表，行为确定、可 grep、可复核。
-- 临时表 `ON COMMIT DROP`：无论 COMMIT 还是 ROLLBACK 都不会留下任何东西。
CREATE TEMP TABLE gy_bootstrap_input ON COMMIT DROP AS
SELECT :'gy_admin_login'::text           AS login_name,
       :'gy_admin_credential_hash'::text AS credential_hash;

-- ---------------------------------------------------------------------------
-- §① 形状守卫 + 一次性守卫 + 三条写入（同一事务）
-- ---------------------------------------------------------------------------
DO $bootstrap$
DECLARE
  -- 文件内**固定 uuid 常量**：这次引导的 `request_id`。复核/追溯时直接按它取：
  --   SELECT * FROM public.admin_audit_events WHERE request_id = '20261027-0001-4c0d-9a00-b00700000001';
  -- 数值含义：20261027 = 修订裁定日；0001 = 该日第 1 次引导；4c0d = 版本位；b007 = bootstrap。
  c_bootstrap_request_id CONSTANT uuid := '20261027-0001-4c0d-9a00-b00700000001';

  x_login       text;
  x_hash        text;
  x_parts       text[];
  x_hash_len    integer;
  x_admin_id    uuid;
  -- x_scopes 只是 §①-③ **核对清单**（自检计数 + 审计 after_value 用），
  -- ⛔ 不是授权的来源：授权的三个 scope 在下面的 INSERT … VALUES 里逐条字面写着。
  x_scopes      text[] := ARRAY['scopes:write', 'session:read', 'session:logout'];
BEGIN
  SELECT login_name, credential_hash INTO x_login, x_hash FROM gy_bootstrap_input;

  -- ①-1 登录名形状。`admin_accounts.login_name varchar(80)`（0001:65），应用层没有更严的规则
  --      （services/api/src/auth/service.ts:246-250 原样传参、store 精确匹配）⇒ 部署档挡住空白/
  --      不可见字符，免得种出一个"永远登不进去"的账号。⛔ 本文件不提供默认值。
  IF x_login IS NULL OR x_login !~ '^[A-Za-z0-9._@-]{3,80}$' THEN
    RAISE EXCEPTION '引导中止：GENGYUN_BOOTSTRAP_ADMIN_LOGIN 形状不符（要求 3..80 位，只允许 A-Z a-z 0-9 . _ @ -）。本文件不提供默认登录名。';
  END IF;

  -- ①-2 scrypt 摘要形状：逐条对齐 services/api/src/auth/password.ts:23-45（`verifyPassword`）的判定
  --      ① split('$') 恰好 6 段、首段必须是 'scrypt'（password.ts:25）
  --      ② N/r/p 都是整数且 N>=2、r>=1、p>=1（password.ts:26-29）
  --      ③ salt / 派生值都能 base64 解出、且解码后非空（password.ts:32-38）
  --      ⛔ 不额外要求 N/r/p 等于 16384/8/1：`verifyPassword` 从摘要里读参数，别的合法参数也能验过；
  --      多要一条会把本可用的摘要判死（"校验比真实格式更严"同样是缺陷）。
  --      ⛔ 但要求 N/r/p 是**纯十进制数字**：`Number('1e5')` 会放过 '1e5'，而那样写出来的摘要
  --      人眼复核不了、也无法与 hashPassword 的输出对齐。
  --      报错里**只打印段数与长度，绝不回显入参**：万一运维把明文口令贴进了这个变量，
  --      回显就等于把口令写进 psql 的 stderr/日志。
  x_hash_len := coalesce(length(x_hash), 0);
  x_parts    := string_to_array(coalesce(x_hash, ''), '$');
  IF array_length(x_parts, 1) IS DISTINCT FROM 6 OR x_parts[1] IS DISTINCT FROM 'scrypt' THEN
    RAISE EXCEPTION '引导中止：GENGYUN_BOOTSTRAP_ADMIN_CREDENTIAL_HASH 不是 scrypt 摘要（应形如 scrypt$N$r$p$saltB64$hashB64；本文件不接受明文口令）。收到 % 段、共 % 字符。',
      coalesce(array_length(x_parts, 1), 0), x_hash_len;
  END IF;
  IF x_parts[2] !~ '^[0-9]{1,7}$' OR x_parts[3] !~ '^[0-9]{1,7}$' OR x_parts[4] !~ '^[0-9]{1,7}$' THEN
    RAISE EXCEPTION '引导中止：scrypt 参数 N/r/p 必须是十进制整数（与 password.ts:26-29 同一判定）。';
  END IF;
  IF x_parts[2]::bigint < 2 OR x_parts[3]::bigint < 1 OR x_parts[4]::bigint < 1 THEN
    RAISE EXCEPTION '引导中止：scrypt 参数越界，要求 N>=2、r>=1、p>=1（与 password.ts:29 同一判定）。';
  END IF;
  IF x_parts[5] !~ '^[A-Za-z0-9+/]+={0,2}$' OR x_parts[6] !~ '^[A-Za-z0-9+/]+={0,2}$' THEN
    RAISE EXCEPTION '引导中止：scrypt 摘要的 salt / 派生值不是 base64（与 password.ts:32-37 同一判定）。';
  END IF;
  IF length(decode(x_parts[5], 'base64')) = 0 OR length(decode(x_parts[6], 'base64')) = 0 THEN
    RAISE EXCEPTION '引导中止：scrypt 摘要的 salt / 派生值解码后为空（与 password.ts:38 同一判定）。';
  END IF;

  -- ①-3 一次性守卫（裁定 C 原文）：**已有管理员必须报错，不许静默跳过**。
  --      事务级 advisory 锁把"守卫计数 + 三条写入"这整段串行化：两个并发的引导进程不会都读到
  --      空表、各自建一个管理员（0041 的 grant/revoke 用同一手法按 scope 串行化，:233-235）。
  --      盐 18041 是本片专用（0041 用 18040、0006 用 6006），避免与其它域的 advisory 键相撞。
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_bootstrap:seed', 18041));

  IF EXISTS (SELECT 1 FROM public.admin_accounts) THEN
    RAISE EXCEPTION '引导中止：public.admin_accounts 已存在管理员，拒绝重复引导（裁定 C：一次性属主 seed，已存在必须报错而不是静默跳过）。';
  END IF;

  -- ①-4 建账号：只给两列，其余全走默认值（⛔ 不手写 state/auth_epoch/revision/created_at）。
  INSERT INTO public.admin_accounts (login_name, credential_hash)
  VALUES (x_login, x_hash)
  RETURNING id INTO x_admin_id;

  -- ② 授 scope：**逐条字面列出**（⛔ 不从字符串 split 动态生成），每条都写明理由。
  --    ⚠️ `admin_scopes.scope` 有库层闭集 CHECK（0041:177-194），下面三个值都在闭集内；
  --    闭集外的名字写不进来（含属主直写），改这里之前先确认闭集。
  --
  --    (a) scopes:write —— **元权限本身**，本片的核心。两条理由：
  --        · 0041 的 `grant_admin_scope` / `revoke_admin_scope` 都要求"操作者当前**有效**持有
  --          scopes:write"（0041:238-256，失败即 G0010 SCOPE_DENIED）；而引导发生时表里没有
  --          任何管理员 ⇒ 谁都不可能有这一条 ⇒ 不在这里授予，系统就**永久失去授权维护入口**
  --          （只能直接改库，那等于把裁定 C 想要的"元权限"绕过去了）。
  --        · `verify-cvm-postgres.sh` 第 9.5 段的 `scopes_write_active_holders`（>=1）盯的就是它。
  --    (b) session:read / session:logout —— 与 services/api/src/auth/service.ts:40 的
  --        `BOOTSTRAP_ADMIN_SCOPES = ['session:logout', 'session:read']` 对齐：应用内
  --        `ensureBootstrapAdmin()` 给首个管理员的正是这两个（service.ts:249 把 `bootstrapScopes`
  --        原样交给 `store.createAdmin`）。这里给同样的两条，是为了让"部署档 seed 出来的账号"
  --        与"应用内引导出来的账号"能力一致 —— 否则同一个初始管理员在两套引导路径下权限不同，
  --        排查时无从对齐。
  --    (c) 不授 `accounts:*` / `audit:read` / `flags:*` / `jobs:*` / `sources:*`：最小权限。
  --        需要时由这个管理员自己用 (a) 走 0041 的既有唯一写路径 `grant_admin_scope` 扩，
  --        并留下自己的审计行 —— 比在 seed 里一次给全更好复核。
  --
  --    `granted_by` = 刚建的这个管理员自己：引导时不存在任何既有管理员，唯一可追溯的授予者
  --    就是它（这条递归在 0041 里做不到，因为那时表非空；本文件在表为空时执行，所以成立）。
  INSERT INTO public.admin_scopes (admin_id, scope, granted_by)
  VALUES (x_admin_id, 'scopes:write',   x_admin_id),   -- (a) 元权限：没有它就没有授权维护入口
         (x_admin_id, 'session:read',   x_admin_id),   -- (b) 与 BOOTSTRAP_ADMIN_SCOPES 一致
         (x_admin_id, 'session:logout', x_admin_id);   -- (b) 与 BOOTSTRAP_ADMIN_SCOPES 一致

  -- ③ 引导审计：**恰一行**。字段值按裁定 C 修订版固定：
  --      action='admin_scope.grant'（既有闭集值，⛔ 不是新造的 'admin_scope.bootstrap'）
  --      scope='scopes:write'（本次引导授予的元权限）
  --      result='accepted'
  --      reason_code='bootstrap'（**唯一的筛选维度**：verify 第 9.5 段按它精确计数）
  --
  --    target_ref：必须满足 0017_account_suspend_authority.sql:85-94 的形状 CHECK ——
  --      该 CHECK 允许 NULL，或者必须是 {type:string, id:string, revision:number} 的**对象**。
  --      契约 `TargetRef.type` 的闭集里**没有** `admin_account`（0017:78-79 已把这条记为契约缺口），
  --      所以与 0041 的 `grant_admin_scope`（0041:319-328）口径一致：target_ref 留 NULL，
  --      被授对象落在 target_hint='admin_account:<id>'。
  --    before_value / after_value：0027:36-52 加的两个可空 jsonb（形状必须是对象或 NULL）；
  --      这里如实写"引导前空 ⇒ 引导后 3 条"，让审计页看得懂这次变了什么。
  --
  --    `admin_audit_events` 上有**追加型**触发器（0017:104-115，BEFORE UPDATE OR DELETE ⇒
  --    G0006 AUDIT_IMMUTABLE）：它只拦改/删，**不拦 INSERT**，所以本行不会踩它。
  --    也正因为"只可追加"，本文件**不做**任何 UPDATE / ON CONFLICT 补救：写错了就回滚重来。
  INSERT INTO public.admin_audit_events (
    id, actor_id, action, scope, target_ref, target_hint, reason_code,
    request_id, result, before_value, after_value
  ) VALUES (
    gen_random_uuid(),
    x_admin_id,
    'admin_scope.grant',
    'scopes:write',
    NULL,
    'admin_account:' || x_admin_id::text,
    'bootstrap',
    c_bootstrap_request_id,
    'accepted',
    jsonb_build_object('scopes', '[]'::jsonb),
    jsonb_build_object('scopes', to_jsonb(x_scopes))
  );

  -- ④ 事务内自检：三条写入必须**同时**成立，否则整体回滚（fail-closed，不留半截引导）。
  IF (SELECT count(*) FROM public.admin_accounts) <> 1 THEN
    RAISE EXCEPTION '引导自检失败：期望 public.admin_accounts 恰 1 行，实际 % 行；事务回滚。',
      (SELECT count(*) FROM public.admin_accounts);
  END IF;
  IF (SELECT count(*) FROM public.admin_scopes s
       WHERE s.admin_id = x_admin_id AND s.revoked_at IS NULL AND s.scope = ANY (x_scopes)) <> 3 THEN
    RAISE EXCEPTION '引导自检失败：期望给新管理员授 3 条有效 scope，实际 % 条；事务回滚。',
      (SELECT count(*) FROM public.admin_scopes s
        WHERE s.admin_id = x_admin_id AND s.revoked_at IS NULL AND s.scope = ANY (x_scopes));
  END IF;
  IF (SELECT count(*) FROM public.admin_audit_events WHERE reason_code = 'bootstrap') <> 1 THEN
    RAISE EXCEPTION '引导自检失败：期望 reason_code=bootstrap 的审计恰 1 行，实际 % 行；事务回滚。',
      (SELECT count(*) FROM public.admin_audit_events WHERE reason_code = 'bootstrap');
  END IF;
END
$bootstrap$;

-- ---------------------------------------------------------------------------
-- §③.5 提交前取可核读数（提交后打印；⛔ 不打印摘要）
-- ---------------------------------------------------------------------------
SELECT (SELECT count(*) FROM public.admin_accounts)                                  AS n_admin_accounts,
       (SELECT count(*) FROM public.admin_scopes WHERE revoked_at IS NULL)           AS n_admin_scopes_active,
       (SELECT count(*) FROM public.admin_audit_events WHERE reason_code = 'bootstrap') AS n_bootstrap_audit
\gset

COMMIT;

-- ---------------------------------------------------------------------------
-- §④ 可核结果（给人看的收尾；数字来自上面 §③.5 的实测，不是字面量）
-- ---------------------------------------------------------------------------
\echo ''
\echo '30-bootstrap-admin.sql 完成：已创建 1 名管理员 + 3 个 scope（scopes:write / session:read / session:logout）+ 1 行 bootstrap 审计。'
\echo '  管理员登录名：':gy_admin_login
\echo '  实测读数：admin_accounts=':n_admin_accounts'  active_admin_scopes=':n_admin_scopes_active'  reason_code=bootstrap 审计行=':n_bootstrap_audit
\echo '  引导审计复核：按文件内固定 request_id（见 §① 的 c_bootstrap_request_id）取 admin_audit_events 那一行。'
\echo '  下一步：sudo deploy/postgres-cvm/verify-cvm-postgres.sh（第 9.5 段 bootstrap_audit_exactly_one / scopes_write_active_holders）'
\echo '  注意：本文件**一次性**，重跑会因"已存在管理员"而失败 —— 这是裁定 C 要求的行为，不是缺陷。'
