-- 迁移 0040 回滚：把 `exports_object_key_shape` 从 1..80 放回 0015 的 1..128
-- （即「0014 加列 + 0015 建形状约束」之后、0040 之前的样子）。
--
-- **只回滚约束，不回滚数据**。0040 的回填把
--   `object_type='conversation_turn'` + `object_key='turn:<uuid>'` 改成了 `conversation` + `<uuid>`、
--   `object_type='checked_content'` + `object_key='<内容类型>:<id>'` 改成了 `<内容类型>` + `<id>`。
-- 这些新取值是**契约口径**（`TargetRef.type` 的 16 值闭集 + `id` ≤ 80），回退会把库重新写回
-- 闭集外取值 —— 那正是 0040 修掉的缺陷（`/me/exports` 整页 503）。而且去前缀后信息不唯一可逆
-- （`conversation` 下会话 id 与轮次 id 同域），无法逐行还原。
-- ⇒ 需要「回到旧口径」时，正确的动作是**回滚应用版本**而不是回滚数据；库层闸门放宽到 1..128，
--   只是让旧实例在发布窗口里还能写入，不会让已回填的行变得不合形态。
--
-- 顺序与 0040 反向：先删形状约束、再按旧宽度重建；列宽 `varchar(128)` 从未被 0040 改动，
-- 因此这里也不需要动列。
BEGIN;

ALTER TABLE public.exports
  DROP CONSTRAINT IF EXISTS exports_object_key_shape;

ALTER TABLE public.exports
  ADD CONSTRAINT exports_object_key_shape
  CHECK (object_key IS NULL OR object_key ~ '^[a-z0-9._:-]{1,128}$');

COMMENT ON COLUMN public.exports.object_key IS
  '非媒体资料（GY-I27 合成域）的对象标识：1..128 字符小写字母/数字/_-.:；非 NULL 时 object_id 必须是全零哨兵 uuid（反向亦然：object_id 为哨兵时 object_key 必须非 NULL 且形状合法）';

COMMIT;
