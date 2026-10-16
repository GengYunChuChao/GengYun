-- GY-I27 第三片（合成域外发账本）· 迁移 0015：把 0014 的「对象标识 XOR」约束**收紧到它声明的语义**
--
-- 为什么单独一个迁移：迁移运行器 `services/api/src/db/migrate.ts` 按**内容校验和**核对台账
--   （`planMigrations` 的 `drift`：磁盘 checksum != 台账 checksum ⇒ 中止并报漂移）。因此
--   **已应用 0014 的部署不能就地改 0014 的正文**，收紧只能以新版本落库。
--
-- 0014 的约束正文（`CHECK (object_key IS NULL OR object_id = <全零哨兵>)`）与它的头注释声明的语义
-- （「①媒体维：object_id 真实 uuid + object_key NULL；②非媒体维：object_id 哨兵 + object_key 文本键；
--   任何其它组合一律拒绝 ⇒ 不产生『无标识 / 双标识』的外发记录」）**不一致**：按正文，把
--   `object_key` 留空却写哨兵 `object_id` 也能通过 ⇒ 落进库里的是一条**两个标识都没有**的外发记录
--   （哨兵不是真实 id、键又是 NULL），与「不产生无标识记录」的声明相矛盾。
--
-- 本迁移做两件事，把库层语义补齐（**不改列、不删数据、不动既有行**）：
--   1. `exports_object_ident_xor` 重建为**双向**互斥：
--        object_key IS NULL  ⇒ object_id 必须是真实 uuid（<> 全零哨兵）  —— 媒体维形态
--        object_key IS NOT NULL ⇒ object_id 必须是全零哨兵              —— 非媒体维形态
--      即「object_key 非空 ⟺ object_id = 全零哨兵」，恰好一个真实标识。
--   2. 新增 `exports_object_key_shape`：非 NULL 的对象键必须匹配 `^[a-z0-9._:-]{1,128}$`
--      （与 `synthesis-egress.ts` 的 `OBJECT_KEY` 运行时校验同口径）。列宽 `varchar(128)` 只挡超长，
--      挡不住空串 / 大写 / 空格 / 控制字符；这些值一旦入库，读取侧就无法把它当作可靠的对象标识。
--
-- 既有数据：0011 起的媒体维行 `object_key IS NULL` 且 `object_id` 是真实 uuid（0003 的 uuid 生成器
--   保证非全零）⇒ 满足新约束；0014 之后写入的非媒体维行是「哨兵 + 文本键」⇒ 也满足。
--   两条约束都以**普通（非 NOT VALID）**方式建立：若真库上存在不合形态的历史行，本迁移会**失败**
--   （而不是把不合形态的数据留在库里）—— 这是刻意的：先人工核对再上线，好过静默放行无标识记录。
--
-- 回滚：`rollback/0015_export_object_key_shape.down.sql` 把约束还原成 0014 的正文（形状约束删除）。
BEGIN;

ALTER TABLE public.exports
  DROP CONSTRAINT exports_object_ident_xor;

ALTER TABLE public.exports
  ADD CONSTRAINT exports_object_ident_xor
  CHECK (
    (object_key IS NULL AND object_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    OR (object_key IS NOT NULL AND object_id = '00000000-0000-0000-0000-000000000000'::uuid)
  );

ALTER TABLE public.exports
  ADD CONSTRAINT exports_object_key_shape
  CHECK (object_key IS NULL OR object_key ~ '^[a-z0-9._:-]{1,128}$');

COMMENT ON COLUMN public.exports.object_key IS
  '非媒体资料（GY-I27 合成域）的对象标识：1..128 字符小写字母/数字/_-.:；非 NULL 时 object_id 必须是全零哨兵 uuid（反向亦然：object_id 为哨兵时 object_key 必须非 NULL 且形状合法）';

COMMIT;
