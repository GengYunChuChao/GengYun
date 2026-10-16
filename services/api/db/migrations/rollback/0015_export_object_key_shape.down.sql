-- 迁移 0015 回滚：撤销「对象键形状」约束，并把 `exports_object_ident_xor` 还原成 0014 的正文
-- （即「object_key IS NULL 或 object_id = 全零哨兵」的单向形式）。
--
-- 顺序与 0015 上行相反：先删形状约束，再重建 XOR 约束。
-- 回滚**不改动任何数据行**：收紧约束只影响后续写入，回滚只把库层闸门放回 0014 的宽度。
BEGIN;

ALTER TABLE public.exports
  DROP CONSTRAINT IF EXISTS exports_object_key_shape;

ALTER TABLE public.exports
  DROP CONSTRAINT IF EXISTS exports_object_ident_xor;

ALTER TABLE public.exports
  ADD CONSTRAINT exports_object_ident_xor
  CHECK (object_key IS NULL OR object_id = '00000000-0000-0000-0000-000000000000'::uuid);

COMMENT ON COLUMN public.exports.object_key IS
  '非媒体资料（GY-I27 合成域）的对象标识：1..128 字符小写字母/数字/_-.:；非 NULL 时 object_id 必须是全零哨兵 uuid';

COMMIT;
