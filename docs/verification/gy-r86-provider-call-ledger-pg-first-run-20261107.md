# 识别外发记账表：真库臂首次实跑（2026-11-07）

## 0 结论

`tests/integration/recognitions-provider-call-ledger-pg.mjs`（迁移 `0055_provider_call_ledger`）**第一次真的跑在 PostgreSQL 17.11 上**，结果 `[√] ALL PASS`（exit 0）。此前该文件的抬头写的是「未接线（本机无 PG，未执行）」——**它是一份从未被执行过的判据**，不是证据。

这次实跑当场暴露出两处**判据自身**的缺陷（产品代码与迁移**没有**缺陷），一处已在本页记录、两处都在同一次提交里修正：

| # | 判据 | 症状 | 性质 |
| --- | --- | --- | --- |
| ① | `[T]` export_id 外键 | `AssertionError`：期望 `/REFERENCES public\.exports\(id\) ON DELETE CASCADE/i`，实测 `FOREIGN KEY (export_id) REFERENCES exports(id) ON DELETE CASCADE` | 判据写死 schema 限定词；`pg_get_constraintdef` 在 `search_path` 能解析到 `public` 时省略它 |
| ② | `[R]` 回滚件 | `error: current transaction is aborted, commands ignored until end of transaction block`（`25P02`） | 回滚件自己 `BEGIN;` 后抛 `G0019`，判据没 `ROLLBACK` 就继续查库 ⇒ 会话停在 aborted 状态 |

## 1 环境

| 项 | 值 |
| --- | --- |
| PostgreSQL | 17.11（本机回环） |
| 连接串 | `postgres://postgres@127.0.0.1:55400/postgres`（脚本只允许 `127.0.0.1`，`tests/integration/recognitions-provider-call-ledger-pg.mjs` 开头有断言） |
| 目标库 | `gengyun_provider_call_ledger_test`（脚本自带 `DROP DATABASE … WITH (FORCE)` ⇒ `CREATE`，不需要事前建库） |
| 迁移 | 全量 `up`，`applied=54` 条，`schema_migrations` 末项 `0055_provider_call_ledger.sql` |
| 命令 | `node tests/integration/recognitions-provider-call-ledger-pg.mjs postgres://postgres@127.0.0.1:55400/postgres` |

## 2 逐条读数（脚本原样输出）

```text
[N] 已重建空库 gengyun_provider_call_ledger_test（DROP … WITH (FORCE) ⇒ CREATE）
[N] 全量 up：applied=54 条，schema_migrations 末项 = 0055（0055_provider_call_ledger.sql）
[T] 13 列形状逐列一致；job_id 无外键；export_id → public.exports ON DELETE CASCADE
[K] 9 条约束 + job_idx 在场（实际约束 10 条）
[F] 夹具就绪：user=51d03811… export=b87b5d9b… job=028d4f55…
[W] record(sent) ⇒ attempt=1、usage jsonb 对象、sent_at/duration_ms 逐字落库
[W] 同一 export 再记一笔 ⇒ attempt=2（序号由数据库派生，应用不传）；send_failed 的 usage 为 NULL
[W] 外键拒绝 ⇒ PROVIDER_UNAVAILABLE（不带驱动原文）；非 uuid ⇒ INVALID_REQUEST
[C] domain 闭集外（moderation） ⇒ 23514 拒绝
[C] invocation_state 闭集外（blocked —— 本表刻意没有） ⇒ 23514 拒绝
[C] attempt=0 ⇒ 23514 拒绝
[C] capability 空串 ⇒ 23514 拒绝
[C] capability 41 字符 ⇒ 23514/22001 拒绝
[C] duration_ms=-1 ⇒ 23514 拒绝
[C] usage 是数组 ⇒ 23514 拒绝
[C] usage 是标量 ⇒ 23514 拒绝
[C] 版本串含空格 ⇒ 23514 拒绝
[C] 版本串空串（NOT NULL + 形状） ⇒ 23514 拒绝
[C] model_version 含空格 ⇒ 23514 拒绝
[C] 版本串 81 字符 ⇒ 23514/22001 拒绝
[C] 正向控制：`@` 分隔的版本串被接受（0050 的字符类会拒它 —— 本表刻意多这一个字符）
[C] 重复 (export_id, attempt) ⇒ 23505 拒绝
[G] 删 public.exports ⇒ 记账行级联消失（ON DELETE CASCADE 生效）
[A] 迁移零 GRANT 自证：新角色 SELECT / INSERT 都是 42501
[A] region 原文（角色名替换后）执行 ⇒ 2 列 SELECT（export_id/attempt）+ 11 列 INSERT（含 attempt 子查询/RETURNING）成功；整行回读与 UPDATE/DELETE 仍 42501
[R] 表里有行 ⇒ 回滚件以 G0019 / PROVIDER_CALL_LEDGER_ROLLBACK_BLOCKED 中止，表原样还在
[R] 清空后回滚 ⇒ 整表拆除（索引随表消失），不碰 exports / jobs / 0050
[√] ALL PASS
```

## 3 这次实跑改变了两件事

1. **`#1003` 的「用量/剖面版本落库」从「代码已合入」升级为「数据库侧被判据钉住且已实跑」**：`attempt` 序号由数据库派生（应用不传）、`usage` 是 jsonb 对象、`send_failed` 的 `usage` 必须是 NULL、`UNIQUE (export_id, attempt)` 真的会拦重复、`exports` 行被删时记账行级联消失——这些都不是应用自述，是库给的。
2. **授权面被真库验证**：迁移自身零 `GRANT`（新角色连 `SELECT`/`INSERT` 都 42501）；把 `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `#region gy-r83-provider-call-ledger-grant` 原文（只替换角色名）执行一遍后，恰好只放行 2 列 `SELECT`（`export_id`/`attempt`）与 11 列 `INSERT`（含 `attempt` 子查询与 `RETURNING attempt`），整行回读与 `UPDATE`/`DELETE` 仍 42501。

## 4 这条记录不证明什么

- **不证明运行角色 `gengyun_api_runtime` 已被 provision 到位**：那由 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的 `runtime_provider_call_ledger_dml_exec` 探针在 deploy-sql-gate 里判，本臂只用临时探针角色复述授权区原文。
- **不证明真实外发发生过**：本臂的记账行全部是夹具写入的（`export=b87b5d9b…`、`job=028d4f55…`），没有真的调用供应商；「真实外发账本」要在生产/真库跑一次真实外发才有。
- **不证明 HTTP 读面**：本片不加读接口，本臂也不判读面。
- **不是生产环境**：`127.0.0.1:55400` 是本机隔离集群；不涉及备份/恢复、不涉及多实例。
- **不替 `#1030`/`#1037` 背书**：每帖 ≤3 的 post-scoped 挂载是另一条线（`0056_post_media_attachments`）。

## 5 复现

```bash
# 1) 起一个隔离的 PG 17（本机示例端口 55400），确保 pg_hba 允许 127.0.0.1 免密登录 postgres
# 2) 在仓库根执行（脚本自建库、自迁移、自清理角色）
node tests/integration/recognitions-provider-call-ledger-pg.mjs postgres://postgres@127.0.0.1:55400/postgres
# 3) 期望末行 `[√] ALL PASS`，exit 0
```

## 6 独立审查之后的加固（2026-11-07）

独立审查（reviewed `95ddbb96`；审查评论见 PR `#1048`）复跑本臂两次、逐行比对 §2 的读数，结论「可合并（0 P0/P1/P2）」，并提出三条 P3。处置如下：

| P3 | 处置 |
| --- | --- |
| P3-1 §2 里「表原样还在」只由 `to_regclass` 非空支撑 | **已加固**：判据改成「表在 **且** 记账行数与中止前**相等**」——只断言表存在（甚至只断言「行数 > 0」）都允许「表在、行没了/少了一半」。变异自证：在 `ROLLBACK` 之后插一句删空表，判据红在「中止后表与记账行必须原样还在（不是只剩空表/少行）」 |
| P3-2 §2 的 `[K] 9 条约束 + job_idx 在场（实际约束 10 条）` 里 9 与 10 并列却不说明第 10 条 | 本页不改动那行读数（它是当次实跑的原样转录），在此说明：**第 10 条是 `export_id` → `public.exports(id)` 的外键**（前 9 条 = 8 条命名 CHECK/UNIQUE + 主键 `provider_call_ledger_pkey`） |
| P3-3 抬头删掉「未接线」后，单看本文件可能被读成 CI 已覆盖 | **已加固**：抬头补一句「本臂仍**不在任何 workflow 的 `run:` 里**（白名单登记见 `tests/unit/ci-integration-chain-structure.test.mjs`）」（R87 起该句已改为「已接线」，见 §7） |

加固后本臂复跑仍 `[√] ALL PASS`、exit 0；除每次运行随机的 `[F]` 夹具 UUID 外，输出逐行相同（读数表 §2 无需回填：本次加固不改任何被记录的读数）。

## 7 R87 接线与「分段计数闸」的边界（2026-11-08）

- **已接线**：`#29` 尾巴由 R87 接上——`.github/workflows/real-pg-integration.yml` 新增 job `real-pg-ledger-17-11`（`services.postgres:17.11`，发布在 `127.0.0.1:5432`，`POSTGRES_USER` 即超管；先 `CREATE DATABASE gengyun_provider_call_ledger_test`，再经 `argv[2]` 把连接串交给脚本，末行闸门要求日志里出现 `[√] ALL PASS`）。§5 的本机手动跑仍是复现方式，但不再是唯一路径。
- **闸的性质**：脚本末尾新增 `EXPECTED_SEGMENTS` 分段计数闸（基线 27）。它数的是**日志分段行数**（`^\[[A-Z]\] `），**不是断言条数**——只证「每组判据都还在」，不证「组内每条断言都在」。
- **已知限制**（审查实测）：删掉整组 `[R]`（32 行）⇒ 分段 25/27、`AssertionError` 判红；只删 `[A]` 组 16 行（三条 `assert.rejects`）⇒ **仍 27/27 全绿**。本闸挡「整段消失」，不挡「组内少一条」；要锁断言条数需另设断言计数器，不在本片范围。
- **`[N]` 不再钉「迁移末项」**（2026-11-08 rebase 到 `#1037` 后本机实测）：原判据是「`schema_migrations` 末项必须是 0055」，而基线落了 `0056_post_media_attachments`（`#1030`）之后这条立刻为假 ⇒ 本臂假红（`AssertionError: schema_migrations 末项必须是 0055（实际 0056）`，PG 17.11 一次性簇）。现改为「台账与磁盘迁移集逐条一致 **且** 本片 0055 在位（名字仍是 `provider_call_ledger`）」：漏跑、多跑、跳号仍判红，基线再前进不再假红。§2 的 `[N]` 读数是 2026-11-07 首次实跑的原样转录，**未回改**。
