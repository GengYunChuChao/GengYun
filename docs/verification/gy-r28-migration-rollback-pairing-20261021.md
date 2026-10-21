# R28-S55 · 迁移 ↔ 回滚脚本一一对应守卫（2026-10-21）

本片只做两件事：新增一个**静态守卫测试** [tests/unit/migrations-rollback-pairing.test.mjs](../../tests/unit/migrations-rollback-pairing.test.mjs)，以及这一页证据。不改任何真实迁移/回滚文件，不改既有三个迁移测试，不改 `services/`、`apps/`、`packages/`、`deploy/`、`.github/`，不 push、不建 PR。

基线 `76b0e86`（`test(ci): 把备份副本域 backup-purge-pg 接进真库 CI（最后一条未接线脚本） (#360)`），工作树 `E:\GengYunCommander\wt-r28-s55`。

## 1 缺口复核

### 1.1 派单四条说法 vs 本机实测

| # | 派单说法 | 实测（base `76b0e86`） | 结论 |
| --- | --- | --- | --- |
| 1 | `migrations/` 26 个迁移、`rollback/` 25 个 down，缺的正是 0001 | `Get-ChildItem services/api/db/migrations/*.sql -File` → 26；`.../rollback/*.sql -File` → 25；`0001_*.down.sql` 不存在 | 成立 |
| 2 | 既有三个迁移测试都不判配对 | `migrations.test.mjs` 152 行：发现/排序/校验和/drift/幂等；`migrations-constraint.test.mjs` 60 行：PGlite 跑 0001 + CHECK 负例；`migrations-negative-pg.mjs` 406 行：三臂里只有 0016 真回滚 | 成立 |
| 3 | 全仓没有「迁移 ⇔ 回滚」的前缀配对断言 | `checkPairing`、`staleExemptions`、`每个迁移` 在既有 `tests/`+`tools/` 中 **0 命中**；`down.sql` 的 38 处既有引用全是把**某一条** down 当字符串读取/执行 | **不成立**：`tools/verify-release-materials.mjs:258-267` 已有前缀配对 |
| 4 | 因此新迁移漏写 down 时 CI 全绿 | 在 base 的仓外镜像里删掉一份 down，该门禁**由绿转红**（§1.3）；它经 `npm run test:unit` 进 CI（`engineering-shell.yml:58`） | **不成立** |

缺口复核的结论是：**「漏写 down 时无人发现」这个前提在 base 上已是假的**；真实缺口是「这条判据寄居在别处、例外不可表达、失败不可读」（§1.4），本片补的是这一块，而不是从零造一条判据。

### 1.2 既有三个迁移测试确实不判配对

- [tests/unit/migrations.test.mjs](../../tests/unit/migrations.test.mjs)：只证明**运行器目录里没有** `.down.sql`（`:56`、`:68`），以及发现/排序/校验和/drift/幂等；它不看 `rollback/` 里有什么。
- [tests/unit/migrations-constraint.test.mjs](../../tests/unit/migrations-constraint.test.mjs)：PGlite 执行 0001（`:15-19`）与 `post_versions` 三列 CHECK 负例（`:21-57`），与回滚无关。
- [tests/integration/migrations-negative-pg.mjs](../../tests/integration/migrations-negative-pg.mjs)：头注「C 回滚：既有 0016 先 up 再跑 `migrations/rollback/0016_*.down.sql`」（`:6`，实际路径 `:113`）——只覆盖 **0016 一条**，且无真库时 exit 77 显式 SKIP。

### 1.3 但 CI 里已经有一条前缀配对判据

代码在 [tools/verify-release-materials.mjs](../../tools/verify-release-materials.mjs)（GY-I24 交付材料门禁）：

```js
const migrations = readdirSync(join(ROOT, 'services/api/db/migrations'))
  .map((n) => /^(\d{4})_.*\.sql$/.exec(n)).filter(Boolean).map((m) => m[1]).sort();
const downs = readdirSync(join(ROOT, 'services/api/db/migrations/rollback'))
  .map((n) => /^(\d{4})_.*\.down\.sql$/.exec(n)).filter(Boolean).map((m) => m[1]).sort();
const expectedDowns = migrations.filter((n) => n !== '0001');
const downsMatch = expectedDowns.length === downs.length && expectedDowns.every((n, i) => n === downs[i]);
check('回滚 down 脚本覆盖 0002..N 且无 0001', downsMatch && !downs.includes('0001'), ...);
```

它经 [tests/unit/release-materials-index.test.mjs:30-37](../../tests/unit/release-materials-index.test.mjs) 的 `spawnSync` 实跑进入 `npm run test:unit`，而该脚本在 [.github/workflows/engineering-shell.yml:58](../../.github/workflows/engineering-shell.yml) 里。仓库自己的索引页也把这条写在册：[gy-i24-release-materials-index-20261017.md:211](gy-i24-release-materials-index-20261017.md#L211)「✅ down 脚本覆盖 `0002..0026`（25 个）、无 `0001`（门禁第 8 项）」。

**镜像实测**（`git archive HEAD` 解到 `.pg17\handoff\r28-s55-logs\mirror-missing-down`，`git init` 后提交，避免动仓内任何文件）：

| 镜像状态 | 该门禁退出码 | 明细 |
| --- | --- | --- |
| 与 base 一致（对照） | 0 | `15/15 项通过` |
| 删掉 `rollback/0002_knowledge_catalog.down.sql` | **1** | `FAIL 回滚 down 脚本覆盖 0002..N 且无 0001 — 期望 down 0002,...,0026，实际 0003,...,0026`；`14/15 项通过` |

镜像里 `docs/资源需求清单.md` 因 `tar` 对含空格的文件名报 `Invalid empty pathname` 未解出，该文件不参与这门禁的任何一项，对照仍 15/15。

### 1.4 真实的残余缺口（本片要补的）

| 编号 | 缺口 | 证据 |
| --- | --- | --- |
| G1 | 判据寄居在「交付材料索引」门禁里，只被一个**索引页**回归测试间接调用；索引页或该测试一重构，配对判据就消失，而迁移测试全绿 | 工具 `:258-267`；调用点 `release-materials-index.test.mjs:30-37`；该测试主体是索引页与文件系统读数 |
| G2 | 例外是硬编码 `n !== '0001'`：没有理由字段、没有「豁免已过期」检查，也无法表达第二种合法例外（例如将来某条 `CREATE EXTENSION` 不可逆） | 工具 `:263` |
| G3 | 失败只打印「期望 0002,...,0026，实际 0003,...,0026」，不区分缺回滚/孤儿/重复，也不点名是哪个前缀 | 工具 `:266-267` |
| G4 | 文件名不合规会被静默吞掉：`filter(Boolean)` 把 `0002_foo_down.sql` 直接丢掉，表现为「缺 0002」而不是「名字不合规」 | 工具 `:259-262` |
| G5 | 数量判据重复且更弱：`downs.length === migrations.length - 1` 只保证总数，一缺一多仍相等；它只在工具那次调用被跳过时才有意义 | `release-materials-index.test.mjs:60` |

### 1.5 本片补的是哪一块

新增独立测试：纯函数 + 前缀级配对 + **带理由、会过期的例外表** + 分桶点名 + 不依赖任何索引文档。它与 GY-I24 门禁**互补**（后者管发布材料一致性，前者管迁移纪律），不是替换，也不放松任何既有断言。

## 2 守卫规则与夹具

### 2.1 三个失败桶 + 例外表

| 规则 | 触发条件 | 返回桶 | 现实对应 |
| --- | --- | --- | --- |
| a | 每个迁移前缀恰有 1 个 `NNNN_*.down.sql` | 无（计入 `details.pairs`） | 正常配对 |
| b1 | 某迁移前缀 0 份 down，且未登记豁免 | `missing` | 新迁移漏写 down |
| b2 | 某回滚前缀没有同名迁移 | `orphan` | 迁移被删/改名，down 遗留 |
| b3 | 同前缀多于 1 份 down | `duplicate` | 复制粘贴出多份 |
| c1 | 豁免前缀**其实已有回滚** | `staleExemptions` | 豁免该删了 |
| c2 | 豁免前缀**没有同名迁移** | `staleExemptions` | 豁免指向已删迁移 |
| c3 | 豁免理由为空/纯空白 | `staleExemptions` | 占位豁免 |

`ok` 当且仅当四个桶（`missing`、`orphan`、`duplicate`、`staleExemptions`）全空。

### 2.2 内存夹具（7 条，不落盘）

| 夹具 | 输入 | 断言 |
| --- | --- | --- |
| 1 正常配对 | `0001`、`0002` 各一份 down | `ok === true`，四桶全空；`0001` 有 down 时**不**被当成天然豁免 |
| 2 缺回滚 | `0001`、`0002`、`0003`，缺 `0002` 的 down | `missing === ['0002']`，其余桶空 |
| 3 孤儿回滚 | 只有 `0001`，多一个 `0009_ghost.down.sql` | `orphan === ['0009']`，`missing` 空 |
| 4 重复回滚 | `0002` 两份 down | `duplicate === ['0002']`，`details.duplicate` 列出两个文件名 |
| 5 有效豁免 | 缺 `0001` 的 down + 非空理由 | `ok === true`，`missing` 空，`details.exempted` 记理由 |
| 6 过期豁免 | `0001` 已有 down 但仍登记豁免 | `staleExemptions === ['0001']`，其余桶空 |
| 7 理由为空 | 缺 `0001` 的 down + 理由为 `'   '` | 落 `staleExemptions` 而**不是** `missing`（同一问题只记一次） |

### 2.3 纯函数契约

- `checkPairing(migrationFiles, rollbackFiles, exemptions = new Map())`：只接文件名与例外表，不读盘、不连库。
- 返回 `{ missing, orphan, duplicate, staleExemptions, ok, details }`；`details` 另给 `migrations`/`rollbacks`/`exemptions` 读数、`pairs`、`exempted`、`duplicate`、`duplicateMigrations`、`ignoredMigrations`、`ignoredRollbacks`。
- 非法入参（非数组、例外表不是 `Map`）抛 `TypeError`，不静默降级。
- 真实目录测试额外断言 `ignored*` 为空：名字不合规的 `.sql` **不许**被静默忽略——这是 G4 的正面修复。

## 3 真实目录读数

- 迁移 26 个（`0001..0026`），回滚 25 个（`0002..0026`），豁免 1 个（`0001`）。
- 配对 25 对；`missing`、`orphan`、`duplicate`、`staleExemptions` 全空；`ok === true`。
- 测试输出原句：`[pairing] 迁移 26 个 / 回滚 25 个 / 豁免 1 个`。
- 目录来自 `DEFAULT_MIGRATIONS_DIR`（`services/api/src/db/migrate.ts:42`），与运行器同源；但文件名模式在测试里**独立重写**为 `/^(\d{4})_[a-z0-9_]+\.sql$/`（与 `:44` 的 `MIGRATION_PATTERN` 同形），故意不 import 运行器正则——运行器将来放宽命名时，守卫不能跟着放宽。
- 豁免前缀清单：只有 `0001`；其理由写在测试的 `EXEMPT` 常量里，判定过程见 §4。

## 4 0001 可逆性判定

### 4.1 0001 到底建了什么

- [services/api/db/migrations/0001_initial_schema.sql:15-29](../../services/api/db/migrations/0001_initial_schema.sql#L15)：15 个 `CREATE TYPE ... AS ENUM`（user_state、admin_state、session_audience、source_kind、evidence_kind、source_validity、review_status、media_purpose、media_state、job_state、visibility、audit_state、public_author_state、media_slot、linked_target_type）。
- `:32-306`：20 个 `CREATE TABLE`（users、sessions、admin_accounts、admin_sessions、admin_scopes、single_profiles、crops、species、regions、sources、source_versions、media、media_derivatives、jobs、public_authors、author_links、posts、post_versions、content_media_refs、community_media_grants），连同索引与 21 条外键。
- 不建 schema、不 `CREATE EXTENSION`；唯一「外部」依赖 `gen_random_uuid()` 是 PG13+ 内建函数，不是扩展对象。
- `:166` 的 `ALTER TABLE sources` 给 `sources.current_version_id` 加 `sources_current_version_fk` → `source_versions`：0001 **内部**就有一个引用环（sources ↔ source_versions）。

### 4.2 后续迁移有没有往 0001 的表上加东西

`grep "ALTER TABLE"` 在 26 个迁移里共 24 处，全部落在 0011/0012/0013/0015/0016 自己新建的表（exports、knowledge_versions、conversation_turns、deletion_requests）；**没有一处**指向 0001 的 20 张表。⇒ HEAD 上 0001 的对象集合就是 0001 文件本身，写一份 down 不需要「感知后续迁移」。

### 4.3 既有 down 怎么对待 0001

- [rollback/0002_knowledge_catalog.down.sql:7-8](../../services/api/db/migrations/rollback/0002_knowledge_catalog.down.sql#L7)：「共享字典表（crops/species/regions/sources/source_versions）由 0001 拥有，0002 未创建，本回滚**不删除**它们；其数据回滚见 `db/seeds/rollback_seed.sql`。」
- [rollback/0026_speech_persistence.down.sql:3-6](../../services/api/db/migrations/rollback/0026_speech_persistence.down.sql#L3)：「本迁移**没有**改动任何既有表…也没有跨迁移外键（唯一的外键指向 0001 的 `users`，回滚只删引用方、不触碰被引用方），因此回滚后库结构与 `0025` 之后完全一致。」
- 25 个 down 里 `DROP TABLE`/`DROP TYPE`/`ALTER TABLE` 指向 0001 那 20 表/15 枚举的：**0 处**（宽正则会误报 `community_posts`、`ocr_jobs`、`speech_jobs`、`recognition_jobs`，收紧到紧邻表名后为 0）。
- [db/seeds/rollback_seed.sql:1](../../db/seeds/rollback_seed.sql#L1)：「回滚本次种子（只删本目录 seed 写入的行；共享表结构不动）。」⇒ 字典**数据**的回滚在数据层，schema 不动。

### 4.4 实测：能不能写出一份跑得通的 0001 down

隔离 PG 17.11（`E:\GengYunCommander\.pg17\pgsql\bin`，一次性集群 `data-r28s55`，端口 55701，`initdb -U postgres -A trust -E UTF8 --locale=C`）。假设 down 由脚本从 0001 的 CREATE 语句反推（15 个 TYPE、20 个 TABLE），只写在仓外 `.pg17\handoff\r28-s55-logs\` 下，**未进仓**：

| 臂 | 动作 | 结果 |
| --- | --- | --- |
| P1 | 空库应用 0001（`psql -v ON_ERROR_STOP=1 -q -f`） | exit 0；`tables=20`、`enums=15`、`fks=21` |
| P2 | 只按「建表逆序 DROP TABLE」的假设 down（没有解环） | **exit 3**：`ERROR: cannot drop table source_versions because other objects depend on it` / `DETAIL: constraint sources_current_version_fk on table sources depends on table source_versions` / `HINT: Use DROP ... CASCADE` |
| P3 | 先 `ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_current_version_fk`，再逆序 DROP 20 表 + 15 枚举 | **exit 0**；随后 `tables=0`、`enums=0`、`fks=0` |

### 4.5 判定与处理

- **结构上可逆**：对象全自有、无扩展依赖、无 schema 依赖；唯一的坑是 0001 自身的 sources↔source_versions 引用环，先解约束再逆序 DROP 即可跑通（P3）。
- **语义上不可逆**：0001 是全库地板，0002..0026 全建其上；执行它的 down 等于清空整库（users/media/posts 等全部数据 + `db/seeds` 字典数据），并与既有 down 的约定（§4.3：down 一律保留 0001 的对象、字典数据回滚走 `db/seeds/rollback_seed.sql`）直接冲突。
- 因此判定为「**作为回滚一步不可执行**」⇒ 登记豁免，本片**不新增** down 脚本（红线）。若将来确实需要「全清」，建议**另开片**做显式 teardown（`DROP SCHEMA public CASCADE` 或重建库），而不是在 0001 里伪装成可回滚的一步。
- 豁免不是永久免检：一旦 0001 有了 down，规则 c1 立刻把它判成 `staleExemptions`（§5 负控制 3 实测），届时必须删豁免或改判定。

## 5 负控制（守卫真的会红）

只改**内存里的副本**，不动任何真实文件：

| # | 内存改动 | 期望 | 实测 |
| --- | --- | --- | --- |
| N1a | 从真实**回滚**列表删掉 `0002_knowledge_catalog.down.sql` | `missing` 命中 `0002` | 红：`missing === ['0002']`，其余桶空 |
| N1b | 从真实**迁移**列表删掉 `0002_knowledge_catalog.sql` | 按规则 b2 命中 `orphan` | 红：`orphan === ['0002']`，`missing` 空 |
| N2 | 例外表换成 `new Map()` | `missing` 命中 `0001` | 红：`missing === ['0001']` |
| N3 | 给 `0001` 在内存里补一个假 down 名 | `staleExemptions` 命中 `0001` | 红：`staleExemptions === ['0001']`，`pairs === 26` |

派单 §2.3.5 的 N1 原文写「删掉一个**迁移**元素 ⇒ `missing` 命中该前缀」，这与 §2.1 规则 b 的定义（缺回滚 ⇒ `missing`；有回滚无迁移 ⇒ `orphan`）互斥：删迁移只会留下孤儿 down。本片按规则 b 实现，并把两个方向都测了（N1a/N1b），没有为了对上原文而把语义写错。

## 6 门禁

本机 Windows PowerShell 5.1，工作树 `E:\GengYunCommander\wt-r28-s55`，在最终文件状态下逐条执行：

| # | 命令 | 退出码 | 读数 |
| --- | --- | --- | --- |
| 1 | `node --test --test-concurrency=1 tests/unit/migrations-rollback-pairing.test.mjs` | 0 | `tests 12 / pass 12 / fail 0`；输出 `[pairing] 迁移 26 个 / 回滚 25 个 / 豁免 1 个` |
| 2 | `node --test --test-concurrency=1 "tests/unit/migrations*.test.mjs"` | 0 | `tests 22 / pass 22 / fail 0`（12 新 + 10 既有） |
| 3 | `npm run lint` | 0 | `PASS tsc --noEmit services/api`、`PASS tsc --noEmit apps/admin`、仓库卫生扫描 PASS |
| 4 | `npm run test:docs` | 0 | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables`；研究记录校验 5 通过 / 0 失败 / 4 legacy 已钉住 |
| 5 | `node tools/verify-contract-status.mjs` | 0 | 覆盖 112 条契约操作；已装配 108；implemented 13 / partial 95 / planned 4；形状错误 0；语义错误 0；`WARN` 无锚点 5/39（既有、不判红） |
| 6 | `git diff --check` | 0 | 无输出（无空白错误） |
| 7 | `git status --porcelain` | 0 | 提交后为空 |

另跑一次 `node tools/verify-release-materials.mjs`（不在派单门禁清单里，用于 §1.3 复核）：exit 0，`15/15 项通过`，`PASS 回滚 down 脚本覆盖 0002..N 且无 0001 — 迁移 26 个（0001..0026），down 25 个（0002..0026）`。

## 7 未取得与边界

1. **静态守卫**：不执行 down、不连库；「有 down 文件」不等于「down 能跑」。真执行证据分散在既有真库脚本里（0016 由 [migrations-negative-pg.mjs](../../tests/integration/migrations-negative-pg.mjs)，其余 0002..0026 的 down 由各域真库脚本各自执行），本片不重复。
2. **不判语义互逆**：不比较 up 与 down 的 SQL 是否真的把对象拆干净，也不判 down 是否有「有审计数据时拒绝」这类前置（那属于各脚本自己的设计）。
3. **0001 只在空库上实测了结构拆除**（P1→P3）。**没有**在 0002..0026 全部应用后的库上跑「0026→0002 逐条 down，再接 0001 down」的整链演练，也没有实测 `db/seeds/rollback_seed.sql` 的数据回滚。§4.5 的「语义不可逆」依据的是 §4.3 的仓库约定与数据面事实，不是整链实跑。
4. **没有在 CI/远端跑**：§6 是本机读数；本机全绿不等于远端绿。
5. **例外表是测试内常量**，不是配置文件：新增豁免要同时改测试与这一页，这是有意的摩擦（负控制 N2 证明撤掉豁免就红）。
6. **不覆盖 up 侧的重复版本号/非法文件名**：那是 `services/api/src/db/migrate.ts:44` 与 `migrations.test.mjs:84-98` 的既有职责，本片不重复断言。

## 8 复现

在仓根（`E:\GengYunCommander\wt-r28-s55`）执行：

```powershell
node --test --test-concurrency=1 tests/unit/migrations-rollback-pairing.test.mjs
node --test --test-concurrency=1 "tests/unit/migrations*.test.mjs"
npm run lint
npm run test:docs
node tools/verify-contract-status.mjs
git diff --check
```

0001 三臂需要一次性 PG（不在本页自动化）：`initdb` → `pg_ctl start -o "-p 55701"` → `createdb gy_r28s55_floor` → `psql -v ON_ERROR_STOP=1 -q -f services/api/db/migrations/0001_initial_schema.sql` → 再执行 §4.4 的 P2/P3 假设脚本；探针脚本与日志留在仓外 `.pg17\handoff\r28-s55-logs\`。

## 9 与派单的偏差

1. 派单 §1 的「没有测试断言二者必须配对 ⇒ 漏写 down 时 CI 全绿」被 §1.1/§1.3 的镜像实测否定：既有 GY-I24 门禁已在 CI 里抓这件事。本片按实测记录，不按原文复述；交付物仍按派单要求给出（独立、带理由例外、分桶点名的守卫），并在 §1.4 说明它补的是哪五个真实缺口。
2. 派单 §2.3.5 的负控制 1 口径与规则 b 互斥，按规则 b 修正为「删回滚 ⇒ `missing`、删迁移 ⇒ `orphan`」，两向都测（§5）。
3. 夹具按派单要求做 6 类 + 「理由为空」，实际落成 7 条夹具测试 + 1 条真实目录 + 4 条负控制 = 12 条测试（`pass 12`），没有为了凑数拆条或改名。
4. 0001 判定的结论是「结构可逆、语义不可逆 ⇒ 不补 down、登记永久豁免」；派单里「若判定可逆则写建议另开片补 down」的形态在此变成了「若要全清，建议另开片做显式 teardown」，理由见 §4.5。
