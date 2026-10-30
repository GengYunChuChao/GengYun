-- 迁移 0050 回滚：删掉 `public.provider_invocations`（即 0050 之前的样子：数据字典里有口径、
-- 库里没有这张表、外发口也没有 invocation 读数）
-- =============================================================================
--
-- **先预检，再删**：表里已有任何一行即 `RAISE EXCEPTION 'G0019'` 并中止 ——
--
--   `public.provider_invocations` 的每一行都是**一次已经发生的真实外发**的记账：谁在什么时候、
--   花了多久、供应商回了什么结局（`sent` / `send_failed`）、用了多少 token。这些行**没有第二份**：
--   `public.exports` 只有 `reserved` / `sent` / `failed` 这类**外发前**的状态机读数，不携带
--   `attempt` / `duration_ms` / `usage` / 版本串；日志里即便留了痕，也不是可查询的结构数据。
--   所以对这个库来说，`DROP TABLE` 不是「回滚」，是**把已经付出的外发代价从账上抹掉** ⇒
--   正确动作是**回滚应用版本**（让写入口停下），库停在这里；真要清空属于数据订正，
--   必须人工裁定后单开一条迁移（并说明这些行为什么可以丢）。
--
-- ⚠ 边界如实记（别把它当成安全边界）：表为空**不**意味着「从来没发过外发」——它只意味着
--   「这张表落盘之后还没有过一次外发」。0050 之前的外发没有记账，回滚也补不回来。
--
-- 顺序：预检（数行）⇒ 删表（同一事务 ⇒ 不会留下「预检时说空、删之前又被人写进来」的中间态）。
--
-- 这里**不用 `IF EXISTS`**（沿用 0042/0043/0047/0049 回滚件的理由）：回滚脚本的判据是
-- 「0050 确实落过盘」。对象不在时静默成功，等于把「这条库根本没应用过 0050 / 已经被别人删过」
-- 两种完全不同的事都说成「回滚成功」—— 真出现时应该由 `DROP TABLE` 自己报错，让人先看清库的真实状态。
--
-- 不碰什么：⛔ 不动 `public.exports` 的任何行/列/约束（0050 只对它加了一条 `REFERENCES`，
-- 删表即解除；`ON DELETE CASCADE` 只描述「删 exports 行时连带删调用行」，回滚不会触发它）；
-- ⛔ 不动 `public.jobs`（本片从未写它，钉子①仍是零 INSERT）；
-- ⛔ 不改 `0001`/`0011`/`0049` 的正文（checksum）；
-- ⛔ 不碰 `deploy/postgres-cvm/sql/20-login-roles.sql` 与 `services/api/db/roles/egress_ledger.sql`
--    （本片从未给这张表授权 ⇒ 回滚也不需要回收授权；真要接线，授权与回收由接线片一起做）。
--
-- 错误码（迁移期预检，不进 HTTP 错误面）：
--   G0019 PROVIDER_INVOCATIONS_ROLLBACK_BLOCKED
BEGIN;

-- ---------------------------------------------------------------------------
-- ① 预检：表里已有调用行 ⇒ 中止
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  x_rows bigint;
BEGIN
  SELECT count(*) INTO x_rows FROM public.provider_invocations;

  IF x_rows > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'G0019',
      MESSAGE = 'PROVIDER_INVOCATIONS_ROLLBACK_BLOCKED',
      DETAIL = format('迁移 0050 回滚中止：public.provider_invocations 里已有 %s 行真实外发的调用记录。', x_rows),
      HINT = '这些行是已经发生的外发留下的唯一结构记账（attempt/duration_ms/usage/版本串），'
             '删表等于把它们从账上抹掉 ⇒ 请先回滚**应用版本**（让 task-egress 的写入口停下），'
             '再评估是否需要一条单独的数据订正迁移并说明为什么这些行可以丢；'
             '⛔ 不要为了能回滚而 TRUNCATE 这张表。';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ② 预检通过才删（删不掉就让 DROP 自己报错：不做 IF EXISTS 静默兜底）
-- ---------------------------------------------------------------------------
DROP TABLE public.provider_invocations;

COMMIT;
