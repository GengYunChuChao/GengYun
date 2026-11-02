# 迁移注释永久 stale：证据与登记（GY-R73）

核对日期 2026-11-03，基线 `upstream/main = cc10d0a5`。本页只登记一件事：**`services/api/db/migrations/**` 里的注释会随着被引用的代码移动而变成假话，而这类注释永久不可修**。因此正确做法是「读代码不读迁移注释」，并由本页把已知的假话逐条登记下来 —— 不是遗留问题，也不进 backlog。

## 1 冻结机制（当次实测，不是传闻）

- `services/api/src/db/migrate.ts` 第 46–48 行附近是 `checksum(sql)`，第 47 行把整份 SQL 文本喂给 `createHash('sha256').update(sql, 'utf8').digest('hex')`。摘要覆盖**整份文件的字节**，注释也在内。
- 同一文件第 241–243 行附近：`plan.drift.length > 0` 就 `throw new Error(\`迁移校验和 drift，拒绝继续：…\`)`；drift 的收集在第 194 行附近 —— 磁盘文件重算出的摘要与 `schema_migrations` 台账里记的那一份不等，即判 drift。
- 所以只要某个迁移**已经应用过**，它的注释改一个字符 ⇒ 摘要变 ⇒ 服务拒绝启动。这不是「没人愿意去改」，是**机制上不准改**。

## 2 已确认 stale、且本次不修的位置（实测基线 `cc10d0a5`）

### 2.1 `0028_moderation_persistence.sql`：帖子下架的实现行号

第 44 行注释（原文）写着「而且**帖子也会被下架**（`moderation/service.ts` 的 `withdraw` 服务的是任意 `TargetRef`）」，其中 `moderation/service.ts` 后面跟的是当时的行号 848。

实测（本次在 `cc10d0a5` 上读）：`services/api/src/moderation/service.ts` 第 848 行现在是一个空行；`withdraw` 的实现已经整体搬走，当前在**同一文件第 1047 行**（`async function withdraw(args: { actor: …; target_ref: TargetRef; reason_code: string }): Promise<WithdrawOutcome>`）。⇒ 该引用已指空。

### 2.2 `0051_moderation_idempotency.sql`：取消幂等的三段引用

第 16–18 行注释（原文要点）：

- 第 16 行：「`services/api/src/moderation/service.ts` 只走 `requireCancelIdempotencyKey`」，跟的是行号 1187；
- 第 17 行：括号里给出 `requireCancelIdempotencyKey` 的位置 357–360（长度 8..128、非法即 400 `IDEMPOTENCY_KEY_REQUIRED`），随后再跟 `service.ts` 的「270–271」；
- 第 18 行：「自陈『本域没有幂等台账』」—— 那是当时被引用处的原文。

实测：

- 第 1187 行**仍然**是 `const key = requireCancelIdempotencyKey(input.idempotencyKey);` ⇒ 这一处行号没漂（是巧合，不是保证）；
- `requireCancelIdempotencyKey` 的定义在 `service.ts` 第 357 行（`function requireCancelIdempotencyKey(value: unknown): string {`）⇒ 357–360 仍成立；
- 第 270–271 行现在是 GY-R72 之后的接口文档注释（第 271 行写「未注入幂等台账（`deps.idempotency` 缺省）⇒ 回落到旧的『重复取消不报错』路径，与接线前逐字节相同」）⇒ 原来那句「本域没有幂等台账」的自陈已经不存在，这一处引用既**指空又反义**；
- 更要紧的是语义：这段注释说「此前只做形状校验、不参与回放」，而 GY-R72 已把取消面接成按 `Idempotency-Key` 回放首次结果（`0051` 这份迁移本身就是那次接线的产物）⇒ 注释描述的「缺口」今天已不是缺口，整段论证的前提过期。

## 3 结论口径

1. 这些注释**永久不修**。修 = 改冻结文本 = 启动被拒（见 §1），所以「顺手把行号补对」这个动作本身是错的，不要排期、不要提 PR。
2. 正确做法是**读代码不读迁移注释**：任何把迁移注释当判据的场合（评审、证据页、事故复盘）都必须按当前树重新读一遍被引用的实现，不能照抄注释里的行号或结论。
3. 本页就是这类假话的登记处。以后发现新的同类 stale，加进 §2，**不改迁移文件**。
4. 本页有意不写「路径:行号」的锚点形状（一律「第 N 行」的散文式），所以它不进契约锚点台账，也不需要 `--reanchor`。

## 4 复核方法

```bash
git show cc10d0a5:services/api/db/migrations/0028_moderation_persistence.sql
git show cc10d0a5:services/api/db/migrations/0051_moderation_idempotency.sql
git grep -n 'service\.ts' cc10d0a5 -- services/api/db/migrations
```

读被引用的实现时同样按固定 SHA 取，避免与工作树状态混淆；**不要**对迁移文件做 `git diff` 之外的任何写操作 —— 迁移文件出现 diff 就说明已经有人改了冻结文本，那是事故，不是修复。
