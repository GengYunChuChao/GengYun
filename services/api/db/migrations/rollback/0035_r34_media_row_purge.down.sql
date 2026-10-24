-- GY-R34 · 回滚 0035_r34_media_row_purge.sql
--
-- ## 可逆性判定：**完全可逆**（本迁移只新增函数，不改任何表、不搬任何数据、不加任何表权限）
--
-- 0035 只做一件事：建 `public.purge_owner_media(uuid)`，并把它的 EXECUTE 从 PUBLIC 收回。
-- 它**没有**改表结构、没有改既有函数、没有落任何一行数据、也**没有**给 `public.media` /
-- `media_derivatives` / `content_media_refs` / `community_media_grants` / `media_object_cleanup`
-- 加任何权限，所以结构可以整块还原。
--
-- 但它**不可逆的是「已删掉的行」**：函数一旦被调用过，被删的媒体行就回不来了
-- （这正是注销要的效果）。所以本 down 不伪造任何数据、也不试图「恢复已删的媒体行」——
-- 它只把函数面撤掉，并在头注释里把后果讲清楚：
--
--   · ⚠ **本片未接线**：`services/api/src/privacy/user-data-deletion.ts` 里目前**还没有**媒体
--     模块（接线要动 `MediaStore` 接口 + 注销装配区 + 覆盖断言，另立一片，见证据页「未取得项」）。
--     等接线之后再只回滚本迁移、却留着代码，每次注销就会拿到 `42883 undefined_function`，
--     由删除协议折叠成 `blocked` + `HANDLER_FAILED`（fail-closed：⛔ 不会假装清完了 0 行）。
--   · 因此将来的回滚必须与「代码侧撤回 media 模块」配套，否则生产上每次注销都会把媒体模块推到
--     blocked。回滚是评审动作，不是自动化兜底。
--   · 另一条**必须说清**的副作用：桶里的对象与 `media_object_cleanup` 里的意图行**不随本 down
--     回滚**（0029 的台账本来就不删；桶对象只由应用侧 `cleanupOrphans` 按台账删）。
--     这在语义上是正确的——意图先于删行，删行撤不回来，意图也不该丢。
--
-- 依赖方向确认（为什么 DROP 是安全的）：没有任何表、视图、策略、其它函数引用这个函数；
-- 唯一的引用点将是应用侧 SQL 文本（`SELECT public.purge_owner_media($1)`）——本片尚未接线，
-- 故当前除本迁移与 `20-login-roles.sql` 的授权面之外全仓零引用——不在库对象图里。

BEGIN;

DROP FUNCTION IF EXISTS public.purge_owner_media(uuid);

COMMIT;
