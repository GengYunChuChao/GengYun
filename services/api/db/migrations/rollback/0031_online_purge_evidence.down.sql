-- 回滚 0031：撤销「在线清理证据落库 + 回执在线态可推导」。
--
-- ⚠️ **不可逆的数据**：`deletion_requests.online_purge_evidence` / `online_purged_at` 一旦有值，
-- 本 down 会把这份证据**整列删掉**（那是"撤销这一步"的定义，不伪造保留）。因此：
--   · 回滚前请自行导出证据（`COPY (SELECT id, online_purged_at, online_purge_evidence
--     FROM public.deletion_requests WHERE online_purge_evidence IS NOT NULL) TO …`）；
--   · 回滚后在线清理会退回"证据只在命令报告 stdout"的旧形态（如实登记，不谎称已落库）。
--
-- 顺序：先撤触发器 → 再撤函数 → 最后删列/约束（函数体引用了列，反序会挂依赖）。
-- 0001..0030 的对象一个不碰。

BEGIN;

DROP TRIGGER IF EXISTS deletion_requests_online_evidence_append_only ON public.deletion_requests;
DROP FUNCTION IF EXISTS public.deletion_requests_online_evidence_append_only();

DROP FUNCTION IF EXISTS public.read_online_purge_evidence(uuid, uuid);
DROP FUNCTION IF EXISTS public.record_online_purge_evidence(uuid, text, text, integer, integer, timestamptz);

ALTER TABLE public.deletion_requests
  DROP CONSTRAINT IF EXISTS deletion_requests_online_evidence_shape,
  DROP CONSTRAINT IF EXISTS deletion_requests_online_evidence_pair,
  DROP COLUMN IF EXISTS online_purge_evidence,
  DROP COLUMN IF EXISTS online_purged_at;

COMMIT;
