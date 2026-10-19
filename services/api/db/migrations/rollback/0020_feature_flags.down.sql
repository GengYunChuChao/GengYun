-- GY-I18（#18）· 回滚 `0020_feature_flags.sql`。
--
-- 顺序：先删写面函数，再删表（函数体引用了表类型 ⇒ 表先删会连带依赖失败）。
-- 审计台账 `public.admin_audit_events` 属 0017，**不**在本回滚范围内：
-- 已落库的 `set_flag` 审计行保留（只可追加的台账不因功能回滚而抹除历史）。
BEGIN;

DROP FUNCTION IF EXISTS public.set_feature_flag(text, integer, boolean, uuid, uuid, uuid, text, text);

DROP TABLE IF EXISTS public.feature_flags;

COMMIT;
