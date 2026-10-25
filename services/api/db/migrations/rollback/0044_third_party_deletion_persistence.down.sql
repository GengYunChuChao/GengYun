-- 回滚 0044：撤销「第三方删除持久化 P1」的两条窄函数。
--
-- ⚠️ **不可逆的数据面**：本迁移只加函数、**没有**加列/加表/加索引，所以没有列数据要抢救；
-- 但 `public.third_party_deletions` 里已经写进去的请求与证据会**失去唯一读写路径**
-- （运行时对那张表零权限，见 90-assert-least-privilege.sql:1131-1134 的 forbidden）。
-- 因此回滚前请自行导出该表（例如
--   COPY (SELECT * FROM public.third_party_deletions) TO …）；
-- 回滚后 P2 的第三方删除接线会整体退回到「只有内存里的计划、没有任何库内证据」的旧形态
-- （如实登记，不谎称已落库）。
--
-- 顺序：先撤读函数再撤写函数（两者互不引用，顺序其实无关；按新→旧的直觉写）。
-- 带**完整参数签名**：同名函数可能因加参产生重载，不带签名会 DROP 歧义（或漏删）。
-- 不用 CASCADE：没有别的对象依赖这两条函数（没有视图、没有触发器、policy 不引用函数）。
-- 0001..0043 的对象一个不碰。
--
-- 权限侧无需单独回收 GRANT：函数被 DROP 后，其 ACL（含 20-login-roles.sql 的 D5 区授出的
-- gengyun_api_runtime EXECUTE）随对象一起消失；重跑 `20-login-roles.sql` 时 D5 区的
-- `to_regprocedure(...) IS NULL` 探针会先失败并给出「迁移 0044 未执行」的明确报错。
BEGIN;

DROP FUNCTION IF EXISTS public.list_third_party_deletions(uuid);
DROP FUNCTION IF EXISTS public.record_third_party_deletion(uuid, text, uuid, text, text, text, timestamptz);

COMMIT;
