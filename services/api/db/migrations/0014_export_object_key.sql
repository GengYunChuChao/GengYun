-- GY-I27 第三片（合成域外发账本）· 迁移 0014：外发账本的**文本型对象标识列**
--
-- 背景（提案 §5.4 α1，证据见 docs/verification/gy-i27-egress-ledger-pg-20261014.md:226）：
--   `exports.object_id` 是 `uuid`，而合成域的「已核对正文」标识 `checked_content_ref.id`
--   是 **1..80 的任意字符串**（如 `sample-i13-passed`），不是 uuid ⇒ 合成域无法在自己的
--   维度上记账（要么伪造 uuid，要么放弃记账）。本迁移**只新增一列**承载文本标识，
--   **不改既有列类型、不做数据回填、不动 media 维的既有行**。
--
-- 边界（逐条对应派单 §1.2）：
--   1. `object_key` **可空**（既有行天然满足：媒体维行只有 `object_id`）⇒ 既有行可读性未被破坏，
--      且 `ADD COLUMN` 不加 NOT NULL/DEFAULT ⇒ 大表上不重写、不长时间持锁。
--   2. `object_id` **保持 0003 的 `uuid NOT NULL`**（本片不动既有列的类型与可空性）：文本键行在
--      `object_id` 写**全零 uuid 哨兵** `00000000-0000-0000-0000-000000000000`，真实标识写进 `object_key`。
--      约束 `exports_object_ident_xor` = `(object_key IS NULL OR object_id = <全零哨兵>)`，
--      在**库层**钉死两种合法形态：①媒体维（`object_id` 真实 uuid、`object_key` NULL）；
--      ②非媒体维（`object_id` 哨兵、`object_key` 文本键）。任何其它组合（object_key 非空却配真实 uuid、
--      或 object_id 为 NULL）一律拒绝 ⇒ 不产生「无标识 / 双标识」的外发记录。既有行 100% 满足形态①，
--      故约束对存量数据成立（无需回填、无需 NOT VALID）。读取侧以 `object_key` 优先，哨兵不被当作真实 id。
--   3. 索引 `exports_object_key_idx`：供按对象键检索（与 `exports_cancelled_object_idx` 同形，
--      非唯一 —— 同一份正文的多次**已受理**朗读是多次真实外发，各自成行）。
--   4. 角色 `gengyun_egress_ledger` 的列级授权在 `services/api/db/roles/egress_ledger.sql`，
--      已同步补 `object_key` 的 SELECT/INSERT（否则该角色 INSERT 报 42501）。
--      **既有部署的上线动作**（角色已存在，整文件重跑会因 `CREATE ROLE` 中止事务）：
--        GRANT SELECT (object_key), INSERT (object_key) ON exports TO gengyun_egress_ledger;
--      ⚠ 若执行过 `rollback/0014_export_object_key.down.sql`，`DROP COLUMN` 会**连带撤销该列的
--      列级授权**（ACL 项随列消失）：重放本迁移后必须**重新**执行上面这条 GRANT，否则运行时的
--      墓碑查询与登记 INSERT 会以 `permission denied` 失败。真库行为由
--      tests/integration/egress-object-key-pg.mjs 的「重放 → 授权确实被撤销 → 补授 → 就位」段钉住。
--      漏授的后果不是报错而是**静默降级**：INSERT 报 42501，被 ledger-pg 的 mapPgError 笼统映射成
--      503 PROVIDER_UNAVAILABLE（合成域外发全部失败且看不出原因）。UPDATE 白名单**不加**该列：对象标识不可篡改。
--      证据：tests/integration/egress-object-key-pg.mjs 真库断言该授权就位且 UPDATE 被拒。
BEGIN;

ALTER TABLE public.exports
  ADD COLUMN object_key varchar(128);

ALTER TABLE public.exports
  ADD CONSTRAINT exports_object_ident_xor
  CHECK (object_key IS NULL OR object_id = '00000000-0000-0000-0000-000000000000'::uuid);

COMMENT ON COLUMN public.exports.object_key IS
  '非媒体资料（GY-I27 合成域）的对象标识：1..128 字符小写字母/数字/_-.:；非 NULL 时 object_id 必须是全零哨兵 uuid';

CREATE INDEX exports_object_key_idx
  ON public.exports (user_id, object_type, object_key, object_revision);

COMMIT;
