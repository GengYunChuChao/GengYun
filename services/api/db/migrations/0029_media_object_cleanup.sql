-- GY-I06（#6）· R28-W12 媒体域：**待清理对象台账**（清理 outbox）。
--
-- ## 这张表解决什么（监工 1022-0203 / 1022-0541 / 1022-0659 三轮 P1，同一阻塞项）
-- 媒体域的红线是「桶删除**未确认**（端口返回 false / 抛错）⇒ 必须保留引用，留待重试」。
-- 但这条红线的唯一落点原来是**父行**（`media.object_ref_cipher` / `media_derivatives`），
-- 而父行随时可能消失或失去引用：
--   1. `completeUpload` 与 `deleteMedia` 的幂等 scope 不同 ⇒ 可以并发。CAS=0 的失利者
--      （`media/service.ts` 里 `saveMediaIfCurrent` 返回 0 的分支）**一个字节都不写库**，
--      它手里刚生成、且未确认删除的衍生对象只存在于**进程内快照**里；
--   2. 并发的 `deleteMedia` 已把真行写成 `deleted` 并清空 `rawRef`/`derivativeRef`
--      （软删：行还在，引用没了）⇒ 清理器枚举真行时**什么都看不到**；
--   3. 注销清理还会物理删掉媒体行。
-- ⇒ 「桶这次删不掉」撞上「父行没引用」，一次失败的尽力删除就把**可重试的清理依据永久丢掉**，
--    对象成了没有任何行指向的孤儿。
--
-- ## 做法（不复活媒体、不覆盖新版本）
-- 清理意图**先**落本表，**再**尝试桶删除；只有桶删除被**确认**成功（含幂等删除
-- 「对象本就不存在」）才删该行。父行被删**不**级联删除本表任何一行，重试器
-- （`cleanupOrphans`）只按本表扫描，因此线索的生命周期与父行**无关**。
--
-- ## 为什么 media_id 不建外键（与 0023 `user_backup_copies` 同一条理由）
-- 归属事实必须独立于 `media` 行是否还在：本表存在的**全部意义**就是「父行已经不在了（或已
-- 没有引用）也要能清掉对象」。挂 `REFERENCES media (id) ON DELETE CASCADE` 会让注销清理
-- 顺手删掉「还没清完」的待清理行 —— 那正是本表要防的丢失。故 `media_id` 只是定位用的 uuid，
-- 不建外键、也不参与级联。
--
-- ## 为什么同时有密文列与摘要列
-- `object_ref_cipher` 沿用 0001/`media` 的同一套密文口径（`services/api/src/media/object-ref-cipher.ts`，
-- 对象键不以明文入库）。AES-256-GCM 每次加密换 nonce ⇒ 同一明文键两次加密得到不同密文，
-- **无法**用密文做去重或定位；因此另有 `object_ref_digest` = sha256(明文键) 的 hex：
--   * 唯一索引 `media_object_cleanup_object_key` 让「同一对象重复登记」收敛成一行；
--   * 重试器确认删除成功后按摘要删该行。
-- 摘要不可逆（对象键是随机 `newObjectRef()`，不是可枚举 id），不构成明文回退。
--
-- ## 编号说明（如实登记）
-- 本迁移落在 main 的 `0027` 之后。开工前实测：`upstream/main` 最大号 `0027`
-- （`0027_admin_audit_observability.sql`），`0028` 已被在途分支
-- `feat/gy-r29-moderation-ledger`（#434，`0028_moderation_persistence.sql`）占用，且按
-- `.pg17/ruling-migration-number-allocation.md` 不得占别人的号 ⇒ 本片取 **`0029`**。
-- 核对方式与读数写进 PR #419 的评论。
--
-- ## 回滚
-- `services/api/db/migrations/rollback/0029_media_object_cleanup.down.sql`（纯新增 ⇒ 整表 DROP；
-- 不碰任何既有表、不碰既有数据）。
BEGIN;

CREATE TABLE public.media_object_cleanup (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id          uuid NOT NULL,
  object_ref_cipher text NOT NULL,
  object_ref_digest char(64) NOT NULL,
  reason            varchar(64) NOT NULL,
  attempts          integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_object_cleanup_digest_shape
    CHECK (object_ref_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT media_object_cleanup_reason_shape
    CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT media_object_cleanup_cipher_present
    CHECK (length(btrim(object_ref_cipher)) > 0),
  CONSTRAINT media_object_cleanup_time_order
    CHECK (updated_at >= created_at)
);

-- 同一对象键只留一行：重试器按行扫描，不能越重试越多。
CREATE UNIQUE INDEX media_object_cleanup_object_key
  ON public.media_object_cleanup (object_ref_digest);
-- 按媒体行反查「这条媒体还欠哪些对象要清」（诊断用；不参与清理判定）。
CREATE INDEX media_object_cleanup_media_idx
  ON public.media_object_cleanup (media_id);

COMMENT ON TABLE public.media_object_cleanup IS
  '媒体域待清理对象台账（清理 outbox）：桶删除未确认时保留可重试的清理依据，独立于 media 行存活，不建外键、不级联';
COMMENT ON COLUMN public.media_object_cleanup.object_ref_cipher IS
  '待清理对象的密文对象键（与 media.object_ref_cipher 同一加解密器；明文永不出库）';
COMMENT ON COLUMN public.media_object_cleanup.object_ref_digest IS
  'sha256(明文对象键) 的 hex：供唯一约束去重与「确认删除后按对象删行」定位（密文因每次换 nonce 无法用于此）';
COMMENT ON COLUMN public.media_object_cleanup.reason IS
  '为什么需要清（闭集 slug）：cas_conflict / owner_delete / reject_<failure_code>';
COMMENT ON COLUMN public.media_object_cleanup.attempts IS
  '尝试次数：首次登记为 1，每次重新登记 +1；只用来看重试轮数，不参与清理判定';

COMMIT;
