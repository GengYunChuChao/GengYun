# GY-R29 S7 · 审核判定台账落库：**合流后补丁说明**（可直接照抄）

> 状态：**面向 rebase 之后的机械套用**。本文件只写「改哪个文件、锚点在哪、old → new 原文」，
> 不含实现代码；实现已在 `feat/gy-r29-moderation-ledger`（PR #434，draft）。
> 适用条件：`#428`（迁移 `0027_admin_audit_observability.sql`）已合入 ⇒ 「迁移 1..28 连续无缺号」
> 门禁自动转绿，剩下 5 项按本文件补齐。基线：`a4626562`（基于 `442057b`）。
> 铁律：**只加行、不动既有行**；`docs/architecture/contract-status.json` 的 `status` 一字不动。

补丁共 4 处：§1 `20-login-roles.sql` 新 region、§2 `90-assert` 新增行、§3 四张注册表、§4 验证序列。

---

## 1 `deploy/postgres-cvm/sql/20-login-roles.sql`：新增 region

**插入位置**：文件末尾最后一个 `#endregion` 之后（region 之间无顺序依赖；与段 H「运行时域列级授权」同形）。

```sql
-- --- K. 审核判定台账：运行时**列级** DML（GY-R29 S7 / 迁移 0028）----------------
-- 两张表由运行时自己写（`services/api/src/moderation/ledger-pg.ts`），本域**没有** NOLOGIN 组角色，
-- 因此按段 H 的写法直接列级授权给 `gengyun_api_runtime`。
--
-- ⚠ 与派单措辞的**偏差（已报备）**：派单写「只给 SELECT/INSERT、不给 UPDATE」。实测台账的两条写路径
-- 都是 UPDATE —— ① 建行前把同目标版本的旧当前行置 `superseded`（`SUPERSEDE_SQL`）；
-- ② 回调结算推进状态/结论（`UPDATE_SQL`）—— 不授 UPDATE 会让 `publish` 与回调在真库上 42501。
-- 仍然**不给 DELETE**：本域没有任何 DELETE 语句（PostgreSQL 也不存在列级 DELETE）。
--
-- SELECT 为什么不止 `job_id`：`ON CONFLICT (job_id)` 冲突目标只需 `job_id`，
-- 但 `UPDATE ... WHERE target_type/target_id/target_revision/content_kind AND superseded = FALSE`
-- 要**读**这些列（先例：`gy-i19-backup-copies-grant` 注释「UPDATE 的 WHERE 要读它们」）。
-- 列清单取自 `tests/unit/sql-column-coverage.test.mjs` 的真实缺口读数（50 条），不是手抄猜的。
-- #region gy-r29-moderation-ledger-grant
DO $$
BEGIN
  IF to_regclass('public.moderation_decisions') IS NULL THEN
    RAISE EXCEPTION '缺少 public.moderation_decisions：迁移 0028 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
  IF to_regclass('public.moderation_withdrawals') IS NULL THEN
    RAISE EXCEPTION '缺少 public.moderation_withdrawals：迁移 0028 未执行。';
  END IF;
END;
$$;

REVOKE ALL ON TABLE public.moderation_decisions FROM PUBLIC;
REVOKE ALL ON TABLE public.moderation_withdrawals FROM PUBLIC;

GRANT SELECT (job_id,target_type,target_id,target_revision,content_kind,superseded)
  ON public.moderation_decisions TO gengyun_api_runtime;
GRANT INSERT (job_id,target_type,target_id,target_revision,content_kind,port_kind,prompt_id,
              job_revision,state,lease_token,authorization_epoch,submitted_by,deadline_at,
              decision,reason_codes,hard_rule_passed,rule_version,model_version,prompt_version,
              contract_value,gate_holder,error_code,evidence,superseded,created_at,updated_at)
  ON public.moderation_decisions TO gengyun_api_runtime;
GRANT UPDATE (state,lease_token,decision,reason_codes,hard_rule_passed,rule_version,model_version,
              prompt_version,contract_value,gate_holder,error_code,evidence,superseded,updated_at)
  ON public.moderation_decisions TO gengyun_api_runtime;

GRANT SELECT (target_type,target_id,target_revision)
  ON public.moderation_withdrawals TO gengyun_api_runtime;
GRANT INSERT (target_type,target_id,target_revision,withdrawn_at)
  ON public.moderation_withdrawals TO gengyun_api_runtime;
-- #endregion gy-r29-moderation-ledger-grant
```

**列数自证**（写入后逐项核对，防手抄漏列）：

| 表 | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| `moderation_decisions` | 6 | 26 | 14 | 0（不授） |
| `moderation_withdrawals` | 3 | 4 | 0（不授） | 0（不授） |

---

## 2 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql`：新增 4 行

### 2.1 `domain_manifest`（`:1052` 起）

在 `('community_idempotency', 'granted', true),` **之后**插两行（缩进与既有行逐字节对齐：4 空格 + 表名宽 34 列 + `'granted',` + 10 空格 + `true`）：

```sql
    ('moderation_decisions',           'granted',          true),
    ('moderation_withdrawals',         'granted',          true),
```

### 2.2 `expected(...)`（`:1099` 起）

在 `('community_posts', ...)` 那一块**之后**（缩进 4 空格、数组元素每行缩进按既有行）插两块。**必须与 §1 的 GRANT 逐列一致**——`:2577` 起的「49-58 逐表范围断言」是拿 `expected` 做等值比对，少一列/多一列都红：

```sql
    ('moderation_decisions',
     ARRAY['job_id','target_type','target_id','target_revision','content_kind','superseded'],
     ARRAY['job_id','target_type','target_id','target_revision','content_kind','port_kind','prompt_id',
           'job_revision','state','lease_token','authorization_epoch','submitted_by','deadline_at',
           'decision','reason_codes','hard_rule_passed','rule_version','model_version','prompt_version',
           'contract_value','gate_holder','error_code','evidence','superseded','created_at','updated_at'],
     ARRAY['state','lease_token','decision','reason_codes','hard_rule_passed','rule_version','model_version',
           'prompt_version','contract_value','gate_holder','error_code','evidence','superseded','updated_at'],
     false),
    ('moderation_withdrawals',
     ARRAY['target_type','target_id','target_revision'],
     ARRAY['target_type','target_id','target_revision','withdrawn_at'],
     ARRAY[]::text[],
     false),
```

### 2.3 `function_surface_manifest`（`:1514` 起）

**不用改**：迁移 0028 不含任何 SQL 函数（只有两张表 + 索引）。派单提到「函数进 `function_surface_manifest`」——本片实测为 **no-op**，如实登记在此，避免合流时误加一条指向不存在函数的面。

---

## 3 四张注册表：old → new

### 3.1 `docs/verification/gy-i24-release-materials-index-20261017.md`（测试 `tests/unit/release-materials-index.test.mjs:39` 派生校验）

测试从文件系统**实测**计数并与索引文档比对，因此只改**文档**（测试代码不动）：

- 当前实测：迁移 **27** 个（`0001..0026` + `0028`）、down **26** 个。
- old → new：索引里写迁移数的那句 `26 个`（或 `**26** 个`）→ `27 个`；写 down 数的那句 `25 个` → `26 个`。
  （只要文档里出现 `27 个` 与 `26 个` 即满足断言；`deploy` 文件数那句是**派生**的，本片不加 deploy 文件，无需改。）
- 自证：`node --test tests/unit/release-materials-index.test.mjs`。

### 3.2 `tests/unit/ci-integration-chain-structure.test.mjs`：`UNWIRED_DECLARATIONS`（`:67` 起）

在数组里加一条（**不要**把脚本接进 `test:integration:http` 链：它需要真 PG）：

```js
  {
    path: 'tests/integration/moderation-ledger-pg.mjs',
    reason: '需真实 PG 17.11（硬钉库名 `gengyun_moderation_test`，脚本要求**空库**：自己 apply 全部迁移后'
      + '单独跑 0028 的 UP/ROLLBACK/REPLAY 三连，并断言部分唯一索引与 26+5 列）；由'
      + ' `.github/workflows/real-pg-integration.yml` 的真库 job 运行，**不进**无 PG 的回环链——'
      + '回环链里既没有真 PG 也没有可建库的超管连接。',
  },
```

### 3.3 `tests/unit/migration-pin-guard.test.mjs`：`ALLOW`（`:77` 起）

在 `ALLOW` 数组里加一条（`category` 必须 `'last-index'`，`pattern` 只要命中该行即可）：

```js
  {
    file: 'moderation-ledger-pg.mjs',
    category: 'last-index',
    pattern: /末项 \$\{String\(versions\[versions\.length - 1\]\)\.padStart\(4, '0'\)\}/,
    why: '这是 note() 的日志插值：只把迁移目录的最大号打印进日志，本臂自己 apply 全部迁移'
      + '（无窗口过滤），末位即真实末位，**不参与任何断言**；目录再加 0029+ 也不会让它变红。',
  },
```

### 3.4 `tests/unit/sql-column-coverage.test.mjs`（4 处）

> ⚠ **派单口径订正**：`storeFiles` **不动**（仍 8）——`ledger-pg.ts` 不是 `store-pg.ts`，
> 它进的是「R28-S66 新纳管」那组；涨的是 **`auditedFiles` 16 → 17**。
> 下面的数字都是本片**实跑**得到的（把 `'moderation/ledger-pg.ts'` 临时加进
> `ADDITIONAL_SQL_HOST_FILES` 跑 `node --test tests/unit/sql-column-coverage.test.mjs`，跑完已还原，sha256 未变）。

1. **`ADDITIONAL_SQL_HOST_FILES`**（`:64`，8 → 9 个），按字母序插在 `'knowledge/service.ts',` 之后：
   ```js
     'moderation/ledger-pg.ts',
   ```

2. **`EXPECTED_EXTENDED_READINGS`**（`:331` 起）old → new：
   ```
   auditedFiles:        16  → 17
   sqlLiterals:         217 → 221   (+4：SUPERSEDE / INSERT / UPDATE / WITHDRAW 四条)
   statements.INSERT:   36  → 38    (+2)
   statements.UPDATE:   32  → 34    (+2)
   statements.SELECT:   119 → 119   (0)
   statements.DELETE:   30  → 30    (0)
   referencedTables:    39  → 41    (+public.moderation_decisions / +public.moderation_withdrawals)
   columnRequirements:  1409 → 1459 (+50)
   coveredRequirements: 1355 → 1405 (+50，**前提：§1 的 GRANT 已落地**；两者差仍为 0)
   ledgerExemptions:    33  → 33    (0)
   ```

3. **`EXPECTED_EXTENDED_PER_FILE`**（`:355` 起）加一行（字母序在 `'messages'` 之后、`'ocr'` 之前）：
   ```js
     'moderation/ledger-pg.ts': 4,
   ```

4. **`EXPECTED_EXTENDED_TABLES`**（`:372` 起，39 → 41 张）加两行（字母序在 `'public.messages',` 之后）：
   ```js
     'public.moderation_decisions',
     'public.moderation_withdrawals',
   ```

5. **文案里的 16/8**（不改会让「审计文件数」断言仍红）：
   - `assert.equal(auditedFiles, 16, '审计文件数必须是 16（8 store + 8 新纳管）')` →
     `assert.equal(auditedFiles, 17, '审计文件数必须是 17（8 store + 9 新纳管）')`
   - 用例标题 `SQL 宿主 = 16 已审计 + 7 登记（R28-S66 / R28-E2 / R28-W3）` → `17 已审计 + 7 登记`
   - NC7 断言「临时新增一个宿主必须恰红 1 条」在登记完成后自动回到 1（无需改）。

---

## 4 合流后验证序列（按序跑，任一步红即停）

```bash
git fetch origin main && git rebase origin/main          # 预期：0027 已由 #428 带入
node --test tests/unit/sql-column-coverage.test.mjs      # 期望：全绿（含 NC5–NC9 负控制）
node --test tests/unit/migration-pin-guard.test.mjs      # 期望：全绿（无未登记末位判据、无陈旧豁免）
node --test tests/unit/ci-integration-chain-structure.test.mjs
node --test tests/unit/release-materials-index.test.mjs
node --test tests/unit/moderation-ledger-pg.test.mjs     # 12/12
node tools/verify-contract-status.mjs                    # 期望：语义 0 / 形状 0 / 中文表格一致
npm run lint
```

真库臂（本机，PG 17.11；库名硬钉、要求空库）：

```bash
createdb -h 127.0.0.1 -p 55712 gengyun_moderation_test
node tests/integration/moderation-ledger-pg.mjs postgres://postgres@127.0.0.1:55712/gengyun_moderation_test
# 期望：[√] ALL PASS
```

全绿后把 PR #434 从 draft 转 ready。

---

## 5 已知偏差与理由（合流评审请一并看）

1. **`moderation_withdrawals` 的 PK 不是 `comment_id`**：台账 `markWithdrawn` 的键是 `targetKey = type|id|revision`
   （`decisions.ts:63-65`），且**帖子也会被下架**（`service.ts` 的 `withdraw` 服务任意 `TargetRef`），
   `comment_id` 单列表达不了这两件事 ⇒ PK `(target_type,target_id,target_revision)`。理由已写进迁移头注释。
2. **`20-login-roles.sql` 需要 UPDATE**（派单原写「不给 UPDATE」）：见 §1 的偏差说明——两条写路径均为 UPDATE，
   不授会在真库 42501；仍不给 DELETE。
3. **`function_surface_manifest` 无新增**：本迁移零函数。
4. **`storeFiles` 不变**：涨的是 `auditedFiles`（见 §3.4 的订正）。
