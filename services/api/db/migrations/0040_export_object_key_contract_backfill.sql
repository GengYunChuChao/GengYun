-- GY-R35（`/me/exports` 越枚举）· 迁移 0040：把两类**越界的外发对象**回填成契约取值，
-- 并把对象键形状从 1..128 收到 **1..80**（= 契约 `TargetRef.id` 的 `maxLength`）
--
-- 为什么单独一个迁移：迁移运行器 `services/api/src/db/migrate.ts` 按**内容校验和**核对台账
--   （`planMigrations` 的 `drift`：磁盘 checksum != 台账 checksum ⇒ 中止并报漂移）。因此
--   **已应用 0015 的部署不能就地改 0015 的正文**，收紧只能以新版本落库（同 0015 头注释的理由）。
--
-- ## 缺陷（实测证据：docs/verification/gy-r35-i19-exports-ledger-20261025.md）
-- `/me/exports` 把账本行原样投影成契约 `Export.object_ref`
--   （`packages/privacy/egress.mjs:388`：`type: record.objectType, id: record.objectId`），
--   而契约 `TargetRef.type` 是 16 值闭集（`packages/contracts/openapi.json:11551-11570`）、
--   `TargetRef.id` 的 `maxLength` 是 **80**（`:11575`）。写入侧却有两处越界：
--     1. `services/api/src/privacy/task-egress.ts` 写 `object_type='conversation_turn'`（闭集外），
--        键形如 `turn:<turnId>`（`turn:` 前缀白占 5 个字符的 id 预算）；
--     2. `services/api/src/privacy/synthesis-egress.ts` 写 `object_type='checked_content'`（闭集外；
--        它是**资料维度**名（`data_type`，见 `packages/privacy/constants.mjs:45 NON_MEDIA_DATA_TYPES`
--        与 `requiredConsentsForDataType`），只用于「该资料类型必需哪些用途」的判定，**不是**外发
--        对象的实体类型），键形如 `<内容类型>:<id>`。
--   这两类行让**整页**投影抛错 ⇒ 全部 503。写入侧已在同一片里改好（`conversation` + 裸 id、
--   `<真实内容类型>` + 裸 id）；本迁移负责把**库里已经写坏的行**改成同一口径。
--
-- ## 回填口径（与写入侧逐字一致）
--   a) `object_type='conversation_turn'` ⇒ `'conversation'`；`object_key` 去掉 `turn:` 前缀。
--   b) `object_type='checked_content'` ⇒ 取键里首个 `:` **之前**那一段作对象类型，必须落在
--      `services/api/src/tts/state.ts:53-60` 的六值闭集
--      （answer / scheme / herbicide / species / static_region / dose_card，全部在契约枚举内）；
--      `object_key` 去掉该前缀，留裸 id（`object_key` 就是读侧的 `object_ref.id`）。
--   两类都在**同一条 UPDATE 里同时写 `object_type` 与 `object_key`**：0015 的
--   `exports_object_ident_xor`（双向）要求「`object_key` 非空 ⟺ `object_id` = 全零哨兵」，
--   而回填**不碰 `object_id`**（文本键行本来就是哨兵）——一条 UPDATE 到位，不存在
--   「类型改了、键还是旧形」的中间态。`media` 维行（`object_key IS NULL`、`object_id` 真实 uuid）
--   **一行不动**。
--
-- ## 不可回填的行 ⇒ 整条中止（刻意 fail-closed）
--   回填后仍留在 `('conversation_turn','checked_content')` 里的行，说明它的键不是上述可解析形态
--   （例如有人手工塞了 `object_type='checked_content'` + `object_key='some-label'`）。这种行
--   **没有如实的映射目标**：猜一个内容类型就是伪造对象类型。本迁移因此 `RAISE EXCEPTION` 并
--   打印样例，让运维先人工核对再上线（与 0015「宁可失败也不把不合形态的数据留在库里」同口径）。
--
-- ## 收紧形状：`exports_object_key_shape` 由 0015 的 `{1,128}` 收到 `{1,80}`
--   **语句顺序即执行顺序**：先回填（上面两条 UPDATE）、再建约束。反过来会把回填前的
--   `turn:<uuid>`（41 字符）也放过、把 >80 的历史键留在库里，读面继续 503。
--   列宽仍是 `varchar(128)`：**不改列类型**（收列宽会重写表、且回滚不可逆），长度由 CHECK 兜底。
--
-- ## 本迁移**不做**的两件事（如实登记，见片报告「风险与未做」）
--   1. 不加 `object_type` 的枚举 CHECK（口径见 `docs/architecture/contract-implementation-status.md`
--      的偏差条目）。理由：`object_type` 是 `varchar(40)` 的自由列，历史/测试环境可能并存其它
--      维度名；建枚举 CHECK 后，任何未知值都会让整条迁移在 `ALTER TABLE` 阶段中止，而中止点
--      看不到是哪几行（上面的 DO 块只覆盖本片能解析的两类）。读侧判据
--      （`packages/privacy/egress.mjs` 的 16 值枚举判定）是最后一道闸门，写入侧已无第三处生产者。
--      ⇒ 建议后续单开一片：先审计 `SELECT DISTINCT object_type`，再加枚举 CHECK。
--   2. 不动资料维度（`data_type`）：`checked_content` 在 `packages/privacy/constants.mjs:45`
--      （`NON_MEDIA_DATA_TYPES`）上仍然是**合法**的资料类型 —— 它决定"必需哪些用途"以及
--      "对象键是文本（非媒体）还是 uuid（媒体）"，与 `object_type` 是两个维度，不在本迁移范围内。
--
-- ## 上线动作（运维必读）
--   运行时角色 `gengyun_egress_ledger` **没有** `object_key` 的 UPDATE 权限（见 0014 头注释第 4 条：
--   「对象标识不可篡改」，且 `roles/egress_ledger.sql` 只授 SELECT/INSERT 该列）。本迁移的回填
--   必须由**属主/迁移角色**执行（`ALTER TABLE`/`DROP CONSTRAINT` 本来也要求属主），
--   用运行时会以 `42501 permission denied` 失败。
--   `deploy/postgres-cvm` 的授权面是否满足「迁移角色 = 表属主」**本片未核**（见片报告）。
--
-- 回滚：`rollback/0040_export_object_key_contract_backfill.down.sql`
--   **只回滚约束**（形状放回 `{1,128}`）。已回填的数据**不回退**：回退会把行重新写回闭集外取值
--   （那正是本片修掉的缺陷），且去前缀后信息不唯一可逆（`conversation` 下会话 id 与轮次 id 同域）。
BEGIN;

-- ① `conversation_turn` ⇒ `conversation`：一次「回答一个轮次」在契约里没有独立实体类型，
--    取最贴近的容器类型 `conversation`（已知代价：该类型下会同时存在会话 id 与轮次 id，接受）。
--    前缀存在才去；`object_key IS NULL` 的行（理论上不会出现：0015 的双向 XOR 要求文本键非空）
--    按 NULL 原样保留，再由下面的 DO 块兜住。
UPDATE public.exports
   SET object_type = 'conversation',
       object_key  = CASE WHEN object_key LIKE 'turn:%' THEN substr(object_key, 6) ELSE object_key END
 WHERE object_type = 'conversation_turn';

-- ② `checked_content` ⇒ 该条正文的**真实内容类型**（键的首段），并去掉 `<类型>:` 前缀。
--    只认六值闭集：其它首段不是内容类型（是任意标签），留给 DO 块报错，绝不猜。
UPDATE public.exports
   SET object_type = split_part(object_key, ':', 1),
       object_key  = substr(object_key, strpos(object_key, ':') + 1)
 WHERE object_type = 'checked_content'
   AND object_key IS NOT NULL
   AND split_part(object_key, ':', 1) IN
       ('answer', 'scheme', 'herbicide', 'species', 'static_region', 'dose_card');

-- ③ 不可回填行 ⇒ 整条中止（BEGIN/COMMIT 保证前面两条 UPDATE 一并回滚，库不停在半改状态）。
DO $$
DECLARE
  residual_count integer;
  sample text;
BEGIN
  SELECT count(*) INTO residual_count
    FROM public.exports
   WHERE object_type IN ('conversation_turn', 'checked_content');
  IF residual_count > 0 THEN
    SELECT string_agg(format('%s/%s', s.object_type, coalesce(s.object_key, '<null>')), ', ')
      INTO sample
      FROM (SELECT object_type, object_key
              FROM public.exports
             WHERE object_type IN ('conversation_turn', 'checked_content')
             ORDER BY object_type, object_key
             LIMIT 5) s;
    RAISE EXCEPTION
      '迁移 0040 中止：仍有 % 行越界对象类型无法如实回填（样例：%）。本迁移只认 object_key = turn:<id> 或 <六值正文类型>:<id>；请先人工核对这几行的真实对象类型再重跑。',
      residual_count, sample;
  END IF;
END
$$;

-- ④ 最后才收紧形状：1..128 ⇒ 1..80（与契约 `TargetRef.id` 的 `maxLength`、与写入侧
--    `ledger-pg.ts` 的 `OBJECT_KEY_MAX = 80` 三者同口径）。
ALTER TABLE public.exports
  DROP CONSTRAINT exports_object_key_shape;

ALTER TABLE public.exports
  ADD CONSTRAINT exports_object_key_shape
  CHECK (object_key IS NULL OR object_key ~ '^[a-z0-9._:-]{1,80}$');

COMMENT ON COLUMN public.exports.object_key IS
  '非媒体资料的对象标识（读侧原样作为对象引用的 id）：1..80 字符小写字母/数字/_-.:；非 NULL 时 object_id 必须是全零哨兵 uuid（反向亦然：object_id 为哨兵时 object_key 必须非 NULL 且形状合法）。长度上限 80 = 契约 TargetRef.id 的 maxLength（0040 从 0015 的 128 收紧）';

COMMIT;
