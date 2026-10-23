# GY-R28-W11 · #17 消息域注销清理 · 真 PG 行数证据（2026-10-21）

- 分支：`test/gy-r28-w11-messages-pg-evidence`（基点 `f5cca8b73d7190f0276e104cf9cf4889e91a4036`）
- 交付物：`tests/integration/messages-purge-pg.mjs`（新增真库臂）+ 本页
- 补的缺口：`docs/verification/gy-r28-e6-closure-materials-20261021.md` 指出的 **C5 判据缺一条真库臂**——
  「注销时点该域行被硬删且行数入证据」此前只在 PGlite 与内存 store 上证过；既有真库臂
  `tests/integration/favorites-history-pg.mjs:456-460` 自陈**库里没有 `public.messages` 表**（走内存 store
  ⇒ `messages:online-purged:0` 恒成立 ⇒ 恒真断言）。

## 0. 四条直接回答

| # | 问题 | 读数（真库 17.11，本机实跑） |
| --- | --- | --- |
| ① | 本主体 messages 注销后行数 | **3 → 0**（硬删：表仍是 8 列、无任何软删列；A 的 `users` 行仍在 ⇒ 不是外键级联带走的）；他人 2 行、负控制主体 2 行 **id 逐一原样** |
| ② | 共享台账按 `scope` 前缀删 | 本主体 **3 → 0**（`left(scope, len(uuid)+1) = uuid \|\| chr(10)`，其中 1 条是**本主体在 auth 域**的行，见 §6）；他人 3 行、负控制 2 行**逐字原样**（`scope` + `key_hash` 都不变）；整表 **8 → 5**（不是整表清空） |
| ③ | 负控制读数 | 同库同连接、**不跑清理**的主体 C：消息 **2 行**、台账 **2 行**；清理后共享台账仍 **5 行**（> 0）⇒ 上面的 0 行不是恒真断言 |
| ④ | 这个脚本现在**有没有被 CI 执行** | **没有。** 已登记 ≠ 已接线：它只出现在 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS`（未接线白名单）里；`ci-real-pg-wiring.test.mjs` 的 `MANAGED_SCRIPTS` / `FROZEN_MANAGED_SCRIPTS` 不含它，`.github/workflows/**` 无任何 `run:` 提到它（本片红线禁改 workflow，CI 接线另开一单） |

证据串（逐字，取自实跑输出）：

```
messages:online-purged:3;messages:idempotency-purged:3
```

回执：`messages.online_state = completed`、`backup_state = pending`（备份端口在本片未接线，回执如实 pending，
`completionStatus().completed === false` ⇒ 不谎称完成）。

## 1. 脚本形态（为什么自起集群，而不是接既有 env）

**选择：自起临时集群（`initdb` → `pg_ctl start` → 跑完 `pg_ctl stop` → 删数据目录）。理由：**

1. 本片要跑通**两个身份**：库属主（建表/迁移/造 `users` 行，全链 26 个迁移经 `readdirSync` 排序后逐个 `query`）
   与运行时角色 `gengyun_api_runtime`（真正执行清理）。接既有共享集群时角色是**跨库残留**的
   （`real-pg-integration.yml:109` 的注释即在讲此事）：要么复用别人的角色（拿不到「本片授权够不够」的读数），
   要么在别人库里 `CREATE ROLE`（留下残留）。自起集群 ⇒ 空库、干净角色、零残留。
2. 代价明确写进脚本：**没有 `GY_PG_BIN` 就没有读数**——打印「未取得，不是通过」并 `process.exit(77)`，
   且**不提供** `--allow-skip`（任何把 77 读成绿的开关都会把缺口重新藏起来，与
   `ci-real-pg-wiring.test.mjs` 的「不得有放宽跳过开关」同一条口径）。

运行方式（PowerShell）：

```powershell
$env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'   # 必填，含 initdb/pg_ctl
$env:GY_W11_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp'    # 选填，数据目录根（默认 os.tmpdir()）
node tests/integration/messages-purge-pg.mjs
```

端口：`55700–55999` 随机 + **先探活再 initdb**，并硬挡一次 55436（本开发机上有一个 55436 的遗留临时集群，
必须避开；脚本里 `if (candidate === 55436) continue;`）。数据目录名前缀硬钉
`gy-w11-messages-purge-pg-`，`stopCluster()` 删目录前先断言前缀（避免误删工作树）。
子进程 stdout/stderr 一律重定向到**文件**（本机 sandbox 禁止命名管道，管道收集 `pg_ctl` 输出会等 EOF 超时）。

## 2. 造数形状

三个随机主体（A=被注销、B=他人、C=负控制），每个主体先 `INSERT INTO public.users (id)`（`messages.owner_id`
的外键目标）：

| 主体 | 消息行（`public.messages`） | 共享台账行（`public.idempotency_keys`） |
| --- | --- | --- |
| A（被注销） | 3 | 3 = 2 条消息域（`POST /messages`、`PUT /messages/{id}/read`）+ **1 条 auth 域**（`POST /auth/logout`） |
| B（他人） | 2 | 3（同形：2 消息域 + 1 auth 域） |
| C（负控制） | 2 | 2（消息域） |

- 消息行**经产品自己的 `insertMessage`** 落库（`createPostgresMessagesStore({ pool })`，运行时角色连接池），
  形状即产品形状：8 列、`target_ref` 是 jsonb 对象、`event_key` 非空、`type='like'`。
  ⛔ 不自己拼 `INSERT INTO public.messages`——否则只是在自证自己编的形状。
- 台账行的 `scope` / `key_hash` **用产品的 `idempotencyScope(subject, METHOD, 路径)` 与
  `idempotencyKeyHashHex(scope, key)`** 拼（`<主体 uuid>\n<METHOD>\n<路径>`），不手写字符串模板。
- 读数一律用**库属主**连接（`countOf` / `ledgerOf` / `messageIdsOf`），把「授权」与「行数」分开证。

## 3. 清理路径：走真实产品链，不自己拼 SQL

```
createUserDataDeletion({ favoritesStore, historyStore, messagesStore, conversationsStore })
  → deletion.requestDeletionFor(subjectA)      // 真实协调器：闭集 favorites / history / messages / conversations
  → await deletion.executeHandlers(requestA.id)
      → messages 处理器 → services/api/src/messages/store-pg.ts:220 purgeOwnerRows()
          → 同一事务：
             DELETE FROM public.messages WHERE owner_id = $1::uuid RETURNING id
             DELETE FROM public.idempotency_keys
               WHERE left(scope, char_length($1::text) + 1) = $1::text || chr(10) RETURNING scope
```

收藏/历史/会话语料在本片用**空内存实现**，只有 messages 接真库（本片只证 #17 这一域；它们的真库臂各自已在别处）。
证据串由 `services/api/src/privacy/user-data-deletion.ts` 的 messages 处理器按
`messages:online-purged:<n>;messages:idempotency-purged:<m>` 生成，两个 `n`/`m` 都取自
`DELETE … RETURNING` 的**实际返回行数**（`SqlRunner` 无 `rowCount`），不是「调用没报错」。

## 4. 权限口径（本片最容易搞错的地方，已实测）

| 授权 | 来源 | 实测（`has_table_privilege`，以运行时角色身份查） |
| --- | --- | --- |
| `public.messages` DELETE | 表级：`deploy/postgres-cvm/sql/20-login-roles.sql:566`（`#region gy-r28-runtime-domain-grants` 起于 `:527`；本条前有 `:561-565` 的「为什么必须表级」注释；PU 没有列级 DELETE） | `true` |
| `public.idempotency_keys` DELETE | 域组角色 `gengyun_auth_privacy`（`services/api/db/roles/auth_privacy.sql:33`），经 `GRANT gengyun_auth_privacy TO gengyun_api_runtime` | `true` |
| `public.users` DELETE | **不授**（反向实测） | `false` |

`users DELETE = false` 这一条是**必要的**：否则「消息行没了」可能只是 `messages.owner_id … ON DELETE CASCADE`
顺手带走的，那本片就白测了（脚本另断言 A 的 `users` 行清理后仍在）。

## 5. 逐条断言读数（真机实跑，8 条 PASS，exit 0）

```
PASS 1: 角色/授权：清理身份 = gengyun_api_runtime；messages DELETE = true（表级）、idempotency_keys DELETE = true（域组角色）、users DELETE = false
PASS 2: 负控制基准（清理前）：A 消息 3 行 / 台账 3 行；B 消息 2 行 / 台账 3 行；C 消息 2 行 / 台账 2 行；共享台账合计 8 行
PASS 3: 证据串：messages:online-purged:3;messages:idempotency-purged:3（计数取自 DELETE … RETURNING 的实际行数，且逐项等于清理前读数）
PASS 4: ① 本主体 messages 注销后 = 0 行（表仍是 8 列、无软删列 ⇒ 硬删；A 的 users 行仍在 ⇒ 不是外键级联的副作用）；他人 B = 2 行、负控制 C = 2 行，id 逐一原样
PASS 5: ② 共享台账：本主体 A 前缀命中 = 0 行（原 3 行，含 1 条 auth 域跨域行）；他人 B = 3 行原样、C = 2 行原样；整表 8 → 5 行（不是整表清空）
PASS 6: ③ 负控制读数（同一库、同一连接、只读）：未清理主体 C 消息 2 行、台账 2 行，共享台账剩余 5 行 ⇒ 断言不是恒真
PASS 7: 重放幂等：同一主体第二次注销清理 = messages:online-purged:0;messages:idempotency-purged:0；他人两表原样
PASS 8: 回执：messages.online_state = completed（证据串即上面的行数）；backup_state = pending（本片未接备份端口，不谎称完成）
```

同次运行的环境读数：`PostgreSQL 17.11`；`[0] 全链迁移 26 个已应用；users / messages / idempotency_keys 三张真实表在岗`；
数据目录 `…\gy-w11-messages-purge-pg-e13d635b`，端口 `55987`（只监听 127.0.0.1）。
同脚本连跑第二次读数逐字相同（数据目录 `…-b1b11872`、端口 `55993`）⇒ 读数与端口/目录随机化无关。

### 5.1 每条断言为什么不是恒真

| 断言 | 不恒真的理由 |
| --- | --- |
| 本主体 0 行 | 清理前同一条计数 SQL 读到 3；同一脚本里他人 2 行与负控制 2 行仍非 0；表的 8 列清单里没有 `deleted_at/deleted/is_deleted/state/status` ⇒ 0 行只能是硬删 |
| 他人原样 | 断的是 `id` 数组 `deepEqual`（不是计数），且 A 与 B 的 uuid 只差随机位 ⇒ 谓词写错（如 `LIKE '%…%'` 或漏 `owner_id`）必红 |
| 台账按前缀删到 0 | 断的是 A 的 `(scope, key_hash)` 行集为空 + 整表从 8 落到 5（若整表清空则 5 这条必红；若谓词写宽则 B/C 必红） |
| 计数入证据 | 证据串用正则 `^messages:online-purged:(\d+);messages:idempotency-purged:(\d+)$` 全串匹配，并逐项与清理前读数相等；重放一次必须是 `0;0`（若计数来自「调用成功」而非实际行数，重放仍会是非 0 或串形状不对） |
| 负控制 | 主体 C 全程不跑清理，同库同连接读到的仍是 2/2 ⇒ 「0 行」不是环境或谓词带来的恒真 |

## 6. 一处需要决策者知情的行为（**不是缺陷，是已登记的产品决策**）

`public.idempotency_keys` 是**共享**台账：`scope` 由 `services/api/src/auth/idempotency.ts` 的
`idempotencyScope` 拼成 `<主体 uuid>\n<METHOD>\n<路径>`，auth 的 `/auth/wechat`、`/auth/logout` 与消息域**写同一张表**。
`purgeOwnerRows` 的前缀谓词只按**主体**收窄、不分域 ⇒ 会连带删掉**本主体在其它域**的幂等行。

- 产品代码已把这件事写成显式决策：`services/api/src/messages/store-pg.ts:213-215`
  （「⚠️ 需要接线的决策者知情的一处跨域效果……删除与注销语义一致；但它不是本域独占的表，属副作用而非本域自清」）。
- 本片实测把它**量出来**并写进证据：A 的台账 3 行里 1 行是 `POST /auth/logout`，清理后一并消失
  （`idempotency-purged:3`，不是 2）。因此证据串里的 `m` 语义是「本主体在该共享台账里的全部行」，
  **不是**「本域自己写的行」。接线/审计时若需要「仅本域」口径，应改判据或改 scope 设计——那属于产品侧决策，
  本片**没有**改任何产品代码来适配测试。

## 7. 未取得项 / 未接线项（⛔ 显式登记，别读成已完成）

1. **CI 未接线**：`.github/workflows/**` 无任何 `run:` 跑 `tests/integration/messages-purge-pg.mjs`
   （本片红线禁改 workflow）。`tests/unit/ci-integration-chain-structure.test.mjs` 的
   `UNWIRED_DECLARATIONS` 只是**未接线白名单**，其存在恰恰说明「没人跑它」；`ci-real-pg-wiring.test.mjs`
   的受管清单也没有它。要它变成「已接线」，得另开一单去 `real-pg-integration.yml` 加 step（并按该 workflow 的
   `GY_PG_BIN` 口径提供 `postgresql-17` 的 bin 目录）。
2. **只在 Linux 之外的这台 Windows 开发机上跑过**：本页所有读数取自 Windows + PG 17.11（`initdb`/`pg_ctl` 来自
   `E:\GengYunCommander\.pg17\pgsql\bin`）。POSIX 分支（`-k <dataDir>` 把 unix socket 钉到本集群目录）是照
   `backup-copies-purge-pg.mjs` / `backup-purge-pg.mjs` 的既有写法搬的，**本机未实跑**；接到 Linux CI 时必须以
   CI 的第一次真跑为准。
3. **备份端口未接**：`backup_state = pending`、`completionStatus().completed === false` 是本片的**如实**读数，
   不是缺口（备份清除端口在本片范围外）。
4. **PGlite / 内存 store 上的旧证据不改**：本页只补真库这一条臂，不推翻既有结论。

## 8. 复跑与残留核查

```
$ node tests/integration/messages-purge-pg.mjs        # 未设 GY_PG_BIN
SKIP: 未设置 GY_PG_BIN（postgres 二进制目录，含 initdb/pg_ctl）⇒ 真库臂跳过，没有取得「message 域注销行数」的真库读数（未取得，不是通过）。
EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本脚本刻意不提供 --allow-skip）。
$ echo $LASTEXITCODE
77
```

真库跑完后：`pg_ctl -D <dataDir> -m immediate -w stop` + 删数据目录（`finally` 里无条件执行，含断言前缀）。
本次实跑后核查：`E:\GengYunCommander\.pg17\tmp` 下**没有** `gy-w11-messages-purge-pg-*` 残留目录；
`psql`/`pg_ctl` 无本脚本起的实例（进程随 `pg_ctl stop` 退出）。

## 9. 本片自检

| 项 | 结果 |
| --- | --- |
| `npm run lint` | PASS（3 项：services/api `tsc --noEmit`、apps/admin `tsc --noEmit`、仓库卫生扫描） |
| `node tests/integration/messages-purge-pg.mjs`（设 `GY_PG_BIN`） | **ALL PASS：8 条真库断言，exit 0** |
| 同上、不设 `GY_PG_BIN` | 打印「未取得，不是通过」，**exit 77** |
| `npm run test:unit`（独占跑，全量） | **3375 tests / 3374 pass / 0 fail / 1 skipped**，exit 0 |

`test:unit` 的两次中途读数（说明，不是掩盖）：第 1 次全量跑 `tests/unit/knowledge-order-created-at.test.mjs`
整文件红（该文件在 8.4s 处整文件失败，其 5 条用例没登记）、第 2 次全量跑
`tests/unit/release-materials-index-strict.test.mjs` 在内部反向控制处红；两者**单独跑都全绿**
（前者 6/6 通过 10.7s，后者 6/6 通过 21.2s），且两者都不读本片新增文件（一个跑真实 HTTP 投影，一个只扫
`deploy/` 的 31 个在册文件）。第 3 次全量跑全绿（上面的数字）。判读：这两条是**并行负载下的既有时序敏感**，
与本片 diff（新增一条 `test:unit` 不执行的 `tests/integration/*.mjs` + 白名单加一行）无因果关系；
本片**没有**去改它们，也没有为了让它们绿而放宽任何断言。

## 10. 红线自检

- 改动文件只有两个（+ 本页）：`tests/integration/messages-purge-pg.mjs`（新增）、
  `tests/unit/ci-integration-chain-structure.test.mjs`（`UNWIRED_DECLARATIONS` 加一条未接线声明，+7 行）。
- ⛔ 未改 `services/**`、`packages/**`、`deploy/**`、迁移号、`openapi.json`、`contract-status.json`、
  `.github/workflows/**`。`git diff --stat f5cca8b` 里没有这些路径。
- 未 push、未开 PR；未读 `E:\GengYunPrivate\`。
