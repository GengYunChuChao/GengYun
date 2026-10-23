-- GY-R34 · 回滚 0034_r34_owner_content_purge.sql
--
-- ## 可逆性判定：**完全可逆**（本迁移只新增函数，不改任何表、不搬任何数据）
--
-- 0034 只做两件事：建 `public.purge_owner_recognitions(uuid)`、
-- 建 `public.purge_owner_speech(uuid)`，并把它们的 EXECUTE 从 PUBLIC 收回。
-- 它**没有**改表结构、没有改既有函数、没有落任何一行数据，所以结构可以整块还原。
--
-- 但它**不可逆的是「已删掉的行」**：函数一旦被调用过，被删的识别/语音内容就回不来了
-- （这正是注销要的效果）。所以本 down 不伪造任何数据、也不试图"恢复已清空的内容"——
-- 它只把函数面撤掉，并在头注释里把后果讲清楚：
--
--   · 撤掉函数后，应用侧 `recognitions/store-pg.ts` / `speech/store-pg.ts` 的
--     `purgeOwnerData` 会拿到 `42883 undefined_function`，由删除协议折叠成
--     `blocked` + `HANDLER_FAILED`（fail-closed：⛔ 不会假装清完了 0 行）。
--     也就是说：回滚后注销闭集里这两域会变成「明确失败」，而不是「静默不清」。
--   · 因此回滚必须与「代码侧撤回 闭集里的 recognitions / speech 两域」配套，
--     否则生产上每次注销都会把这两个模块推到 blocked。回滚是评审动作，不是自动化兜底。
--
-- 依赖方向确认（为什么 DROP 是安全的）：没有任何表、视图、策略、其它函数引用这两个函数；
-- 唯一的引用点在应用侧 SQL 文本（`SELECT public.purge_owner_*($1)`），不在库对象图里。

BEGIN;

DROP FUNCTION IF EXISTS public.purge_owner_recognitions(uuid);
DROP FUNCTION IF EXISTS public.purge_owner_speech(uuid);

COMMIT;
