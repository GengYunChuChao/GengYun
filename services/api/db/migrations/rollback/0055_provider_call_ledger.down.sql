-- 迁移 0055 回滚：删掉 `public.provider_call_ledger`（即 0055 之前的样子：识别链路外发只在外发口
-- 打日志读数，库里没有一行「用了多少 token / 用的是哪套剖面」的记账）
-- =============================================================================
--
-- **先预检，再删**：表里已有任何一行即 `RAISE EXCEPTION 'G0019'` 并中止 ——
--
--   `public.provider_call_ledger` 的每一行都是**一次已经发生的真实外发**的记账：哪个作业/哪次 export、
--   第几次尝试、用了哪套剖面与模型、供应商回了什么结局（`sent` / `send_failed`）、花了多久、烧了多少 token。
--   这些行**没有第二份**：`public.exports` 只有外发前后的状态机读数，不携带 `attempt` /
--   `provider_config_version` / `usage`；`public.recognition_records` 只记成功终态、且从不记 token。
--   所以对这个库来说，`DROP TABLE` 不是「回滚」，是**把已经付出的外发代价从账上抹掉** ⇒
--   正确动作是**回滚应用版本**（让 `withProviderCallAccounting` 的写入口停下），库停在这里；
--   真要清空属于数据订正，必须人工裁定后单开一条迁移（并说明这些行为什么可以丢）。
--
-- ⚠ 边界如实记（别把它当成安全边界）：表为空**不**意味着「从来没发过外发」——它只意味着
--   「这张表落盘之后还没有过一次外发」。0055 之前的外发没有记账，回滚也补不回来。
--
-- ⚠ 与本片其它文件的**联动**（回滚不是只删这一张表）：`public.provider_call_ledger` 的运行时授权
--   落在 `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r83-provider-call-ledger-grant` 区，
--   分类/列面复述落在 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的
--   `domain_manifest`（`required = true`）与 `expected`。删表后若仍去 provision，
--   20-login-roles 的授权区会显式 `RAISE EXCEPTION`、90-assert 会在逐表断言处判红 ——
--   **那是 fail-closed，不是缺陷**。真要撤这一片，三处必须同一批撤（同一次提交里一起改）。
--
-- 顺序：同一事务内先 `count(*)` 再 `DROP`，无提交中间态（未 `LOCK TABLE`）。
--   准确说：`BEGIN` ⇒ `DO $$ count(*) … $$` ⇒ `DROP TABLE` ⇒ `COMMIT`，「预检读空」这件事**没有**
--   先提交出去给别的会话看，所以不存在「提交后、删表前」那个窗口；但**没有** `LOCK TABLE`，
--   「count 读空」到「DROP 拿到 ACCESS EXCLUSIVE」之间理论上仍可能有一行插进来并随表一起消失。
--   这是有意的取舍：回滚是运维动作，不为此在生产表上加排他锁；真要严格，运维侧先停写再回滚。
--
-- 这里**不用 `IF EXISTS`**（沿用 0042/0043/0047/0049/0050 回滚件的理由）：回滚脚本的判据是
-- 「0055 确实落过盘」。对象不在时静默成功，等于把「这条库根本没应用过 0055 / 已经被别人删过」
-- 两种完全不同的事都说成「回滚成功」—— 真出现时应该由 `DROP TABLE` 自己报错，让人先看清库的真实状态。
--
-- 不碰什么：⛔ 不动 `public.exports` 的任何行/列/约束（0055 只对它加了一条 `REFERENCES`，
-- 删表即解除；`ON DELETE CASCADE` 只描述「删 exports 行时连带删记账行」，回滚不会触发它）；
-- ⛔ 不动 `public.jobs`（本片从未写它，钉子①仍是零 INSERT）；
-- ⛔ 不改 `0001`/`0011`/`0050`/`0054` 的正文（checksum）；
-- ⛔ 不动 0050 那张调用记录表（它的「有意冻结」姿态本片一字未改；本文件刻意不写其字面表名，
-- 理由见正向迁移 `0055_provider_call_ledger.sql` 头注释「为什么不复用 0050」一节）。
--
-- 错误码（迁移期预检，不进 HTTP 错误面）：
--   G0019 PROVIDER_CALL_LEDGER_ROLLBACK_BLOCKED
BEGIN;

-- ---------------------------------------------------------------------------
-- ① 预检：表里已有记账行 ⇒ 中止
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  x_rows bigint;
BEGIN
  SELECT count(*) INTO x_rows FROM public.provider_call_ledger;

  IF x_rows > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'G0019',
      MESSAGE = 'PROVIDER_CALL_LEDGER_ROLLBACK_BLOCKED',
      DETAIL = format('迁移 0055 回滚中止：public.provider_call_ledger 里已有 %s 行真实外发的记账。', x_rows),
      HINT = '这些行是已经发生的外发留下的唯一结构记账（attempt/provider_config_version/model_version/'
             'duration_ms/usage），删表等于把它们从账上抹掉 ⇒ 请先回滚**应用版本**'
             '（让 withProviderCallAccounting 的写入口停下），再评估是否需要一条单独的数据订正迁移'
             '并说明为什么这些行可以丢；⛔ 不要为了能回滚而 TRUNCATE 这张表。';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ② 预检通过才删（删不掉就让 DROP 自己报错：不做 IF EXISTS 静默兜底）
-- ---------------------------------------------------------------------------
DROP TABLE public.provider_call_ledger;

COMMIT;
