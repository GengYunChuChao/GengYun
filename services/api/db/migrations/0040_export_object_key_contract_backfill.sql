-- GY-R35（`/me/exports` 越枚举）· 迁移 0040（二轮）：把**可证明身份**的越界外发对象改成契约取值，
-- 并把对象键形状从 1..128 收到 **1..80**（= 契约 `TargetRef.id` 的 `maxLength`）
--
-- 为什么单独一个迁移：迁移运行器 `services/api/src/db/migrate.ts` 按**内容校验和**核对台账
--   （`planMigrations` 的 `drift`：磁盘 checksum != 台账 checksum ⇒ 中止并报漂移）。因此
--   **已应用 0015 的部署不能就地改 0015 的正文**，收紧只能以新版本落库（同 0015 头注释的理由）。
--
-- ## 缺陷（实测证据：docs/verification/gy-r35-i19-exports-ledger-20261025.md）
-- `/me/exports` 把账本行原样投影成契约 `Export.object_ref`
--   （`packages/privacy/egress.mjs`：`type: record.objectType, id: record.objectId`），
--   而契约 `TargetRef.type` 是**闭集**（`packages/contracts/openapi.json` 的 `TargetRef`）、
--   `TargetRef.id` 的 `maxLength` 是 **80**。写入侧曾有两处越界：
--     1. `services/api/src/privacy/task-egress.ts` 写 `object_type='checked_content'` 之外的
--        另一种历史形态：键形如 `turn:<turnId>`（`turn:` 前缀白占 5 个字符的 id 预算）；
--     2. `services/api/src/privacy/synthesis-egress.ts` 写 `object_type='checked_content'`
--        （它是**资料维度**名 `data_type`，不是外发对象的实体类型；见
--        `packages/privacy/constants.mjs` 的 `NON_MEDIA_DATA_TYPES` 与 `requiredConsentsForDataType`），
--        键形如 `<内容类型>:<id>`。
--   域外类型会让**整页**投影抛错 ⇒ 全部 503。
--
-- ## 二轮变更（监工 R1/R2，2026-10-25）
--   **R1：账本的对象类型、id、revision 必须指向同一真实实体，不能只把标签改成合法枚举。**
--   ⇒ 早先「`conversation_turn` ⇒ `conversation`」的映射**已删除**：一次问答外发记的是**轮次**
--   （`objectId = 轮次 id`、`objectRevision = 轮次 revision`），把它标成容器 `conversation` 会造出
--   「会话类型 + 轮次 id + 轮次 revision」的错配。轮次本就是契约实体 `Turn`，因此改为
--   **契约 `TargetRef.type` 增补 `conversation_turn` 成员**（16 → 17 值），账本类型保持原值。
--
-- ## 部署与复跑提示（二轮补充）
--   * **不要把本版本号复用到旧库**：上一轮同编号的 0040 曾把轮次行写成 `conversation` + 裸 uuid。
--     若某库跑过上一轮，本文件会因**内容校验和漂移**被 `services/api/src/db/migrate.ts` 拒绝（正确）；
--     即便人工放行，本脚本也**不会**修正那些行（它们已合法、不被 ③ 残留预检捕获）⇒ 需人工审计
--     `object_type='conversation'` 的账本行是否其实指向轮次。
--   * **发布顺序**：必须先上线新代码（不再写 `checked_content` / `turn:` 前缀），再跑 0040；
--     否则旧实例在发布窗口内继续写坏行，会让该用户 `/me/exports` 整页 503 且无在轨修复路径。
--   本迁移对 `conversation_turn` 行**只做一件事**：去掉多余的 `turn:` 前缀（不改变类型、不猜 id）。
--   裁定见 `.pg17/ruling-r34-exports-turn-identity-20261025.md`。
--
--   **R2：历史回填只转换可证明的真实身份，不能靠移除旧标签让预检通过。**
--   ⇒ ① 只处理 `object_key LIKE 'turn:%'` **且** 后缀是 uuid 形状的行（可证明是轮次 id）；
--      ② 只处理冒号前是六值内容类型 **且** 冒号后是 uuid 形状 **且** 去前缀后 ≤ 80 的行；
--      ③ 其余一律**不转换**，由残留预检 `RAISE EXCEPTION` 打样例并整条中止。
--
-- ## 回填口径（与写入侧逐字一致）
--   a) `object_type='conversation_turn'`：类型**不动**；`object_key` 去掉 `turn:` 前缀 ⇒ 裸轮次 uuid。
--   b) `object_type='checked_content'` ⇒ 取键里首个 `:` **之前**那一段作对象类型，必须落在
--      `services/api/src/tts/state.ts` 的六值闭集（answer / scheme / herbicide / species /
--      static_region / dose_card，全部在契约枚举内）；`object_key` 去掉该前缀，留裸 id
--      （`object_key` 就是读侧的 `object_ref.id`）。冒号后必须是 **uuid 形状**：非 uuid 的 id
--      （例如 `answer:some-label`）无法证明是真实对象标识 ⇒ 不转换、交给预检中止。
--   两类都在**同一条 UPDATE 里同时写 `object_type` 与 `object_key`**：0015 的
--   `exports_object_ident_xor`（双向）要求「`object_key` 非空 ⟺ `object_id` = 全零哨兵」，
--   而回填**不碰 `object_id`**（文本键行本来就是哨兵）——一条 UPDATE 到位，不存在
--   「类型改了、键还是旧形」的中间态。`media` 维行（`object_key IS NULL`、`object_id` 真实 uuid）
--   **一行不动**。
--
-- ## 不可回填的行 ⇒ 整条中止（刻意 fail-closed）
--   ① 残留的 `object_type='checked_content'` 行：没有如实的映射目标（猜一个内容类型就是伪造类型）。
--   ② `object_type='conversation_turn'` 但键不是裸 uuid 的行（仍带 `turn:` 前缀、NULL、或根本不是
--      uuid 形状）：无法证明它指向真实轮次。监工举的正是 `conversation_turn / not-a-turn` 这类形状
--      ——**绝不允许**先把它改标成 `conversation` 从而"消失"在预检之外。
--   两类都会 `RAISE EXCEPTION` 并打印样例，运维人工核对后再重跑（与 0015「宁可失败也不把不合形态
--   的数据留在库里」同口径）。特别地，**无冒号的退化情形**（`object_key` 恰好是 `'answer'`）由
--   `strpos(object_key, ':') > 1` 排除：否则 `substr` 会把类型名原样当成对象 id 写回去 = 伪造标识。
--
-- ## 收紧形状：`exports_object_key_shape` 由 0015 的 `{1,128}` 收到 `{1,80}`
--   **语句顺序即执行顺序**：先回填 → 再两道 fail-closed 预检（残留越界类型、回填后仍 >80 的键）
--   → 最后才建约束。反过来会把回填前的 `turn:<uuid>` 也放过、把 >80 的历史键留在库里，读面继续 503。
--   列宽仍是 `varchar(128)`：**不改列类型**（收列宽会重写表、且回滚不可逆），长度由 CHECK 兜底。
--
-- ## 本迁移**不做**的三件事（如实登记，见片报告「风险与未做」）
--   1. 不加 `object_type` 的枚举 CHECK（口径见 `docs/architecture/contract-implementation-status.md`
--      的偏差条目）。理由：`object_type` 是 `varchar(40)` 的自由列，历史/测试环境可能并存其它
--      维度名；建枚举 CHECK 后，任何未知值都会让整条迁移在 `ALTER TABLE` 阶段中止，而中止点
--      看不到是哪几行。读侧判据（`packages/privacy/egress.mjs` 的枚举成员判定）是最后一道闸门，
--      写入侧已无第三处生产者。⇒ 建议后续单开一片：先审计 `SELECT DISTINCT object_type`，再加 CHECK。
--   2. 不动资料维度（`data_type`）：`checked_content` 在 `packages/privacy/constants.mjs`
--      （`NON_MEDIA_DATA_TYPES`）上仍然是**合法**的资料类型 —— 它决定"必需哪些用途"以及
--      "对象键是文本（非媒体）还是 uuid（媒体）"，与 `object_type` 是两个维度，不在本迁移范围内。
--   3. 不同步库层 `0018_favorites_history.sql` 的 `target_type` CHECK（仍是旧 16 值、不含 `conversation_turn`）。
--      今日 favorites/history 的写入口只落 3 型与 recognition/ocr、不可达该成员；但 `services/api/src/history/validate.ts`
--      的内部创建口已按 17 类校验 ⇒ 一旦落轮次类型会撞库层 CHECK 报 500。改它需要另开迁移改表，本片只登记不改表。
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
--   （那正是本片修掉的缺陷），且去掉前缀后信息不唯一可逆。
BEGIN;

-- ① `conversation_turn`：**类型保持原值**（轮次 = 契约实体 `Turn`），只去掉多余的 `turn:` 前缀。
--    仅当后缀是 uuid 形状（可证明是轮次 id）时才去；不满足的行不参与，落 ③ 的预检中止。
UPDATE public.exports
   SET object_key = substr(object_key, 6)
 WHERE object_type = 'conversation_turn'
   AND object_key LIKE 'turn:%'
   AND substr(object_key, 6) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- ② `checked_content` ⇒ 该条正文的**真实内容类型**（键的首段），并去掉 `<类型>:` 前缀。
--    四条同时成立才转换：有非空前缀、前缀在六值闭集、冒号后是 uuid 形状、去前缀后 ≤ 80。
--    任一条不成立都留给 ③ 的中止块，绝不猜。
UPDATE public.exports
   SET object_type = split_part(object_key, ':', 1),
       object_key  = substr(object_key, strpos(object_key, ':') + 1)
 WHERE object_type = 'checked_content'
   AND object_key IS NOT NULL
   AND strpos(object_key, ':') > 1
   AND split_part(object_key, ':', 1) IN
       ('answer', 'scheme', 'herbicide', 'species', 'static_region', 'dose_card')
   AND substr(object_key, strpos(object_key, ':') + 1) ~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND length(substr(object_key, strpos(object_key, ':') + 1)) <= 80;

-- ③ 不可回填行 ⇒ 整条中止（BEGIN/COMMIT 保证前面两条 UPDATE 一并回滚，库不停在半改状态）。
DO $$
DECLARE
  residual_count integer;
  sample text;
BEGIN
  SELECT count(*) INTO residual_count
    FROM public.exports
   WHERE object_type = 'checked_content'
      OR (object_type = 'conversation_turn'
          AND (object_key IS NULL
               OR object_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));
  IF residual_count > 0 THEN
    SELECT string_agg(format('%s/%s', s.object_type, coalesce(s.object_key, '<null>')), ', ')
      INTO sample
      FROM (SELECT object_type, object_key
              FROM public.exports
             WHERE object_type = 'checked_content'
                OR (object_type = 'conversation_turn'
                    AND (object_key IS NULL
                         OR object_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
             ORDER BY object_type, object_key
             LIMIT 5) s;
    RAISE EXCEPTION
      '迁移 0040 中止：仍有 % 行对象无法如实回填（样例：%）。本迁移只认 object_key = turn:<uuid>（去前缀）或 object_type=checked_content + <六值内容类型>:<uuid>（改成真实类型 + 裸 uuid）；其余形状无法证明真实对象身份，请先人工核对再重跑。',
      residual_count, sample;
  END IF;
END
$$;

-- ④ 回填后再做一次**长度预检**，才动约束：超过 80 字符的键如果只剩「ADD CONSTRAINT 撞约束」
--    这一步兜底，运维看到的只有裸约束名 `exports_object_key_shape`，看不出是哪几行、多长。
--    本文件通篇的纪律是「宁可失败并打印样例」，最后一步也不破例。
DO $$
DECLARE
  too_long_count integer;
  sample text;
BEGIN
  SELECT count(*) INTO too_long_count
    FROM public.exports
   WHERE object_key IS NOT NULL
     AND length(object_key) > 80;
  IF too_long_count > 0 THEN
    SELECT string_agg(
             format('%s/%s…(len=%s)', s.object_type, left(s.object_key, 24), s.len),
             ', ' ORDER BY s.len DESC)
      INTO sample
      FROM (SELECT object_type, object_key, length(object_key) AS len
              FROM public.exports
             WHERE object_key IS NOT NULL
               AND length(object_key) > 80
             ORDER BY length(object_key) DESC, object_type
             LIMIT 5) s;
    RAISE EXCEPTION
      '迁移 0040 中止：仍有 % 行对象键超过 80 字符（样例：%）。这些行的键无法收到契约 TargetRef.id 的 maxLength=80；本迁移不做截断（静默改写标识比拒绝更危险），请先人工核对真实对象标识再重跑。',
      too_long_count, sample;
  END IF;
END
$$;

-- ⑤ 最后才收紧形状：1..128 ⇒ 1..80（与契约 `TargetRef.id` 的 `maxLength`、与写入侧
--    `ledger-pg.ts` 的 `OBJECT_KEY_MAX = 80` 三者同口径）。
ALTER TABLE public.exports
  DROP CONSTRAINT exports_object_key_shape;

ALTER TABLE public.exports
  ADD CONSTRAINT exports_object_key_shape
  CHECK (object_key IS NULL OR object_key ~ '^[a-z0-9._:-]{1,80}$');

COMMENT ON COLUMN public.exports.object_key IS
  '非媒体资料的对象标识（读侧原样作为对象引用的 id）：1..80 字符小写字母/数字/_-.:；非 NULL 时 object_id 必须是全零哨兵 uuid（反向亦然：object_id 为哨兵时 object_key 必须非 NULL 且形状合法）。长度上限 80 = 契约 TargetRef.id 的 maxLength（0040 从 0015 的 128 收紧）';

COMMIT;
