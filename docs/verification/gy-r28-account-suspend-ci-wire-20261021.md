# R28-S39：把 `account-suspend-pg.mjs` 接进真库 CI（第 10 个受管脚本）

日期 2026-10-21。被测脚本 `tests/integration/account-suspend-pg.mjs`（612 LF / 34065 B / `sha256=fea5c274…`，即 R28-S15 修完 scram 自洽化后的形态，本片**未改它一个字**）。
工作树 `E:\GengYunCommander\wt-r28-s39`，分支 `test/gy-r28-account-suspend-ci-wire`。本片 **standalone**，不依赖任何在途 PR：初版曾按 `#349` head（`7b39a0b`）堆叠交付，因 `#349` 迟迟未合、main 已前进到 `32ce461`，指挥于 2026-10-21 在 main 上重建（`git reset --hard upstream/main` 后重做四处改动；原堆叠提交保留在本地引用 `s39-old-head`，未强推）。**随后 `#349`（识别域接 CI）与 `#352`（语音域授权）相继合入 main（`e01dd67` / `4e93d7b`），本片合流 `upstream/main` 后把本步重排为第 10 条**（识别域占第 9 条），工作流与两个单测的读数均按合流后重取。
集群：本轮自建一次性 PG 17.11 **scram** 集群（`127.0.0.1:55649`，`--auth=scram-sha-256`）。**本页每个读数都是本轮真跑**；日志在 `E:\GengYunCommander\.pg17\handoff\r28-s39-logs\`（一次性本地目录，未入库）。

## 0. 结论

| 读数 | 接线前（`32ce461`） | 本片之后 |
| --- | --- | --- |
| `MANAGED_SCRIPTS` 条数 | 9（合流前基线 8） | **10**（`FROZEN_MANAGED_SCRIPTS` 同步 10，两份逐字一致；`REQUIRED_STEP_ORDER` 同步 10 项） |
| `tests/unit/ci-real-pg-wiring.test.mjs` 前向① | 不适用（脚本不在受管清单里） | **绿**（脚本被 workflow 的 `run:` 真跑） |
| 把新 step 临时删掉后同一条断言 | — | **红**，且只点名 `tests/integration/account-suspend-pg.mjs`（§5.1） |
| 本机真跑（PG 17.11 + scram + 超级用户 owner，省略 `argv[3]`） | 从未在 CI 里跑过 | **exit 0，末行 `ALL PASS`，四臂 `[M]`/`[P]`/`[A–D]`/`[E–F]` 齐全**（§3.3） |
| 排在「集群里已有同名角色且不可 DROP」之后 | 旧版会 `42710` | **exit 0，6 组角色 + 运行时角色全部走 `ALTER` 复用**（§4） |
| 跨 step 角色残留 | — | 干净集群上跑完只剩 owner 一个 `gengyun*` 角色（§3.4） |

一句话：**这条脚本现在既被 workflow 真跑、又被受管清单守住；少了那一步 CI 会红，不是静默缺口。**

## 1. 背景：为什么此前不接、缺陷何时修掉

R28-S14 判定「不接线」的理由写在两处（本片都改掉了）：

- `tests/unit/ci-real-pg-wiring.test.mjs:45-48`（旧头注释）：「前者在 scram 认证下必 `28P01`」（运行时角色口令是自己 `randomBytes(24)` 生成的，与 `argv[3]` 无关）。
- `tests/unit/ci-integration-chain-structure.test.mjs:77-79`（旧 `reason`）：「**脚本缺陷 ⇒ R28-S14 判定不接线**」。

那个缺陷**已由 R28-S15 修掉**并合入 main（见 `docs/verification/gy-r28-account-suspend-scram-20261020.md`）：省略 `argv[3]` 时脚本自己生成口令、`CREATE`/`ALTER` 角色、再由 owner URL **派生**运行时 URL（同一个口令变量既写进角色又写进 URL ⇒ scram 下自洽）；`resetRoles()` 删不掉的角色改成属性逐字相同的 `ALTER ROLE`（§4 实测）。**因此「不接线」的两条前提都不成立了。**

`backup-purge-pg` 仍不接：它要求在 runner 上 `initdb`/`pg_ctl` 另起 17.11 集群，而 CI 里只有 `services.postgres` 容器内那一份。本片只接 `account-suspend-pg`。

## 2. 改动（四处）

### 2.1 `.github/workflows/real-pg-integration.yml`：job `real-pg-17-11` 末尾追加一步（+16 行，其它 0 改动）

```yaml
      # 账号停用/恢复域（I22 / R28-S39）：库名硬钉 `gengyun_suspend_test`，脚本按「**空库**」前提跑
      # （它自己 apply 0001–0017、再把 0017 单独跑 UP/ROLLBACK/REPLAY 三连；非空库会在首个 `CREATE` 撞车 ⇒ 必红），
      # 故与既有 9 步同形：`psql -c 'CREATE DATABASE …' && node <脚本>`。
      # argv 只给 owner URL——省略 argv[3] 时脚本自建/改 `gengyun_api_runtime` 并用随机口令派生运行时 URL，
      # scram-sha-256 下自洽；旧版「口令割裂 ⇒ 28P01」的缺陷已由 R28-S15 修掉
      # （`docs/verification/gy-r28-account-suspend-scram-20261020.md`）。
      # 它自己 apply 迁移，故不需要额外准备；收尾会 DROP 它自建的角色（`cleanup()`），排在最后一步时
      # 前面 `admin-accounts-read` 留下的同名角色它用 `ALTER ROLE` 复用，不会再 42710。
      # 本地取证（PG 17.11 + scram + `gengyun_ci_owner` 超级用户）：exit=0，四臂 [M]/[P]/[A-D]/[E-F] 齐全，末行 `ALL PASS`。
      - run: psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_suspend_test' && node tests/integration/account-suspend-pg.mjs postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:5432/gengyun_suspend_test
        env:
          PGHOST: 127.0.0.1
          PGPORT: '5432'
          PGUSER: gengyun_ci_owner
          PGPASSWORD: synthetic-ci-owner-only
          PGDATABASE: gengyun_ci_bootstrap
```

三条设计点：

1. **只给 `argv[2]`（owner URL），不给 `argv[3]`**——这正是 S15 修出来的自洽形态；给了 `argv[3]` 反而要求角色口令与 URL 逐字一致，是更脆的调用形态。
2. **建库与跑脚本用 `&&` 串联**：建库失败不能滑过去变成「脚本 77 也算跑过」（与既有 9 步同形）。
3. **放最后一步**：脚本收尾会 `DROP` 它自建的角色，放末尾能把「角色残留」的影响面压到零（§4 另行证明即使不空也不炸）。

### 2.2 `tests/unit/ci-real-pg-wiring.test.mjs`：登记进受管清单（合流后 vs main：+14/−5）

- `MANAGED_SCRIPTS` 与 `FROZEN_MANAGED_SCRIPTS` **各追加** `'tests/integration/account-suspend-pg.mjs'`（9 → 10，两份逐字一致）；`REQUIRED_STEP_ORDER` 同时追加第 10 项（另加 4 行注释说明「为什么必须排最后」，紧跟在第 9 项 `recognitions-pg` 之后）。
- 头注释：合流后保留 `#349` 写的「第 9 条是 R28-S36 接的（识别域持久化／迁移 0025）」，把本片写成「第 10 条是 R28-S39 接的（账号停用/恢复域 I22…；scram 缺陷由 R28-S15 修掉）」，并把「R28-S14 的另一条候选」收成只剩 `backup-purge-pg` 不接（它要求在 runner 上用 `initdb`/`pg_ctl` 另起 17.11 集群）。
- **判据一条没动**：判据 ③ 的 job 作用域、判据 ④ 的 SHA 钉、判据 ⑤ 的吞红禁止全部原样；也没有放宽任何断言。

### 2.3 `tests/unit/ci-integration-chain-structure.test.mjs`：改 `account-suspend-pg` 的声明原因（+7/−12）

`UNWIRED_DECLARATIONS` 那一条**保留**（它仍**不**进无 PG 的回环链 `test:integration:http`），只把已过时的 `reason`（「脚本缺陷 ⇒ R28-S14 判定不接线」）改成现在的真相：已接进 `.github/workflows/real-pg-integration.yml` 的独立真库 job，由**独立 step** 真跑；仍不进回环链，因为必须有真 PG 与可建角色的超管连接。写法照 `#349` 改 `recognitions-pg` 那条（同一文件、同一张表）。

### 2.4 本页

`docs/verification/gy-r28-account-suspend-ci-wire-20261021.md`。

## 3. 本机真跑（读数逐字）

### 3.1 集群身份：确实是 scram，owner 确实是超级用户

```
select version()  → PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit
select rolname||':'||rolsuper where rolname='gengyun_ci_owner' → gengyun_ci_owner:true
```

反证（**scram 在生效**，不是 trust）：`PGPASSWORD=wrong-password-for-probe` 连 `gengyun_ci_owner` ⇒

```
psql: error: connection to server at "127.0.0.1", port 55649 failed: FATAL:  password authentication failed for user "gengyun_ci_owner"
```

exit **2**；换回 `synthetic-ci-owner-only` 才拿到上面的 `version()`（exit 0）。
`initdb` 参数：`-U gengyun_ci_owner --auth=scram-sha-256 --pwfile=<临时口令文件> -E UTF8 --locale=C`；起进程用 `Invoke-CimMethod Win32_Process Create`（PID 85516，`postmaster.pid` 第 1 行即 85516；**未用** `pg_ctl start`）。

### 3.2 空库前提成立

```
DROP DATABASE IF EXISTS gengyun_suspend_test WITH (FORCE)   → DROP DATABASE（exit 0；首次跑为 NOTICE … does not exist, skipping）
CREATE DATABASE gengyun_suspend_test                        → CREATE DATABASE（exit 0）
select count(*) from pg_tables where schemaname='public'     → 0
select … from pg_roles where rolname like 'gengyun%'         → gengyun_ci_owner
```

### 3.3 与 CI 逐字相同的命令（写手用 55649；指挥复跑用 55646）⇒ exit 0、`ALL PASS`

```
psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_suspend_test' && \
node tests/integration/account-suspend-pg.mjs postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:55649/gengyun_suspend_test
```

日志 `01-local-realpg-account-suspend.log`（19 行，逐字）。**下面的读数是指挥在重建后的 `32ce461` 树上复跑取的**（端口 55646，`gengyun_cvm_owner` 超级用户），与写手原读数（55649、迁移 25）唯一差异是迁移计数已随 0026 抬到 26：

```
[M] 迁移清单 26 个，版本号严格递增且无重复；本脚本只应用 0017_account_suspend_authority.sql 及其之前的版本（目录最大号 0026 与本脚本无关）
[M] UP：suspend_account / restore_account / admin_audit_events / append-only 触发器 全部出现
[M] ROLLBACK：三个对象与触发器全部消失，users/sessions 仍在（回滚不越界）
[M] REPLAY：对象与触发器再次全部出现（迁移可重放）
[P] 未给 argv[3] ⇒ 本脚本自建角色并派生运行时 URL（用户 gengyun_api_runtime，口令 48 位，不打印）
[P] 已按出厂区域 gy-i22-suspend-grant 授予 EXECUTE（恰好 3 条：suspend/restore/display_name）
[P] 运行时角色 6 条直接写入/读取/DDL 全部 42501（users.state/auth_epoch/revision、审计台账读写、DDL）
[A] 停用前用户 token 调 /auth/session ⇒ 200
[A] 停用 ⇒ 200，data.state=suspended，revision=2，display_name=耕云用户8292
[B] 停用后同一 token ⇒ 401 SESSION_EXPIRED（用户会话已过期或已失效）
[C] 停用后重新登录 ⇒ 403 ACCOUNT_INACTIVE（账号不可用）
[D] 恢复 ⇒ state=active，auth_epoch=3，revoked_sessions=0
[D] 恢复后重新登录 ⇒ 200；新 token ⇒ 200；**旧 token 仍 401**（未复活）
[A–D] 审计台账：account.suspend/account_suspended/accepted , account.restore/account_restored/accepted
[E] 并发双停用 ⇒ changed=true/false，auth_epoch 1→2（恰好 +1），审计恰好 1 行
[F] 第 4 步（写审计，23505）失败 ⇒ PROVIDER_UNAVAILABLE；state/auth_epoch/revision 逐字未变 {"state":"active","auth_epoch":"1","revision":1}；已撤会话 0→0；审计 0 行
[S] 90-assert-least-privilege.sql 含 psql 元命令 ⇒ 由 `psql -f` 单独执行（本脚本不代跑）
清理：删除本脚本新建的 7 个角色（gengyun_auth_privacy,gengyun_preview_reader,gengyun_evidence_reader,gengyun_consent_granter,gengyun_profile_runtime,gengyun_knowledge_runtime,gengyun_api_runtime）
ALL PASS：迁移三连 / 最小权限 / A–E / 失败注入 全部取得真库读数
```

**exit=0**。四臂对照派单 §3 的要求逐条落地：`[M]`×4、`[P]`×3（+ 角色口令 48 位不打印）、`[A]`–`[F]`、`[S]` 一行属**设计内**（该 SQL 含 psql 元命令，只能 `psql -f` 跑，脚本如实打印而不代跑，不计失败）。

### 3.4 跑完之后的集群状态（跨 step 残留）

```
select … from pg_roles where rolname like 'gengyun%'   → gengyun_ci_owner     ← 只剩 owner
select count(*) from pg_tables where schemaname='public'（gengyun_suspend_test） → 45
select datname from pg_database                        → gengyun_suspend_test,postgres,template0,template1
```

即：**库留下、角色清空**——与 workflow 注释里「收尾会 DROP 它自建的角色」一致，跨 step 不会把同名角色留给后面的步骤。

## 4. 顺序前提的实测：排在 `admin-accounts-read` 之后不炸

workflow 注释里那句「排在 `admin-accounts-read` 之后是安全的（后者留下的同名角色它用 `ALTER ROLE` 复用）」是本片**新增的断言**，所以单独验了一遍。夹具（不属于交付物，`r28-s39-logs/90-ordering-fixture.sql`）：先在独立库 `gengyun_hold` 里给 6 个组角色 + 运行时角色各建一张表并改由它拥有 ⇒ **跨库依赖使 `DROP ROLE` 必失败**（`DROP OWNED BY` 只清当前库，救不了）⇒ 脚本只能走 `ALTER` 复用分支。这与真实 CI 里「前序 step 已把角色留下来」是同一形状。

读数（日志 `04-ordering-reuse-when-roles-precede.log`，**exit 0，`ALL PASS`**）：

```
[P] 复用已存在的组角色 gengyun_auth_privacy（跨库依赖使其不可 DROP ⇒ CREATE 换 ALTER，属性逐字相同）
[P] 复用已存在的组角色 gengyun_preview_reader（…同上…）
[P] 复用已存在的组角色 gengyun_evidence_reader（…同上…）
[P] 复用已存在的组角色 gengyun_consent_granter（…同上…）
[P] 复用已存在的组角色 gengyun_profile_runtime（…同上…）
[P] 复用已存在的组角色 gengyun_knowledge_runtime（…同上…）
[P] 复用已存在的运行时角色 gengyun_api_runtime（跨库依赖使其不可 DROP；非本轮残留）
…（[M]/[A]–[F] 全部照常取得）
清理：删除本脚本新建的 0 个角色（无）
ALL PASS：迁移三连 / 最小权限 / A–E / 失败注入 全部取得真库读数
```

两点必须让审查者知道：

1. **`[E]` 那一行的 `changed=` 顺序会变**：干净集群上是 `changed=false/true`，本夹具上是 `changed=true/false`（并发双停用谁先赢是竞态）。脚本断言的是「恰好一个 `true` ∧ `auth_epoch` 恰好 +1 ∧ 审计恰好 1 行」，两次读数都满足；**顺序本身不是判据**。若日后有人把这一行当固定字符串比对，会假红。
2. 夹具里收尾打印「删除 **0** 个角色」，是因为跨库依赖让 `DROP` 失败——这是**测试夹具**造的假象，不是脚本缺陷：真实 CI 里同名角色没有跨库依赖（同一 job 内其它 step 的库在 job 结束时才随容器消失，但本 step 的 `resetRoles()` 是在**它自己**那一步跑，前序 step 的库仍存在，故 CI 里**两种分支都可能**）。所以本片不主张「CI 里一定 DROP 成功」，只主张「两种分支都 exit 0」。

## 5. 负控制

### 5.1 去掉新 step ⇒ 同一断言必红并点名它

做法：`Copy-Item` 备份当前 workflow → 用脚本删掉本步的**注释块 + `- run:` 行 + `env:` 块**（合流后位于 `line 170..185`；删后 `account-suspend-pg` 出现次数 **0**）→ 跑两个单测文件 → 从备份恢复。**exit 1**，`tests 23 / pass 15 / fail 8`，红的 8 条与合流前**完全同一组**：

```
✖ 前向①：两个受管真库脚本都被某个 workflow 的 `run:` 真跑
  AssertionError [ERR_ASSERTION]: 有受管真库脚本既没有被任何 workflow 的 `run:` 执行，也没有对应的真库臂——
  这类脚本坏了 CI 也不会红（「脚本在 main、但没人跑」的静默缺口）：
    · tests/integration/account-suspend-pg.mjs
  actual:   [ 'tests/integration/account-suspend-pg.mjs' ]
  expected: []
✖ 反向控制①：删掉某脚本的 `run:` 行，同一断言必须红并点名它
  actual:   [ 'tests/integration/account-suspend-pg.mjs', 'tests/integration/conversations-pg.mjs' ]
  expected: [ 'tests/integration/conversations-pg.mjs' ]
✖ 反向控制①b：`run: |` 块体里把调用写成 shell 注释，判据①必须判红
✖ 反向控制⑦：R27-S4 追加的两条受管脚本，删掉各自的 `run:` 行后必须逐条点名（且只点名它）
✖ 前向⑤（判据⑥）：受管脚本在 workflow 里的执行顺序必须与 REQUIRED_STEP_ORDER 一致
✖ 前向⑥（判据⑦＋⑧）：每个受管脚本所在 step 先 CREATE DATABASE 再 node，且库名与该 step 传入的一致
✖ 前向⑦（判据⑨）：workflow 里执行的 `-pg.mjs` 集合与 MANAGED_SCRIPTS 双向相等
✖ 反向控制⑧：判据⑥⑦⑧⑨ 各自的变异都必须红，且消息能定位到脚本/库名
```

后三条是**同一原因的连带**：它们都拿「去掉某条 run 行后只点名那一条」当判据，而基线 workflow 本来就缺本步，于是多出一个 `account-suspend-pg` 被点名 ⇒ 一起红。**这恰好证明本步不可省**。其余 15 条（判据②③④、镜像/删 services/诱饵 job 等）保持绿。

### 5.2 恢复后必绿（sha256 逐字节还原）

```
sha256-after-restore = BAE195F1A8D47A65071D05174BA981183FE6F1D6F4A2C3A55478C971359621AF   (与备份逐字节相等)
git diff --numstat upstream/main -- .github/workflows/real-pg-integration.yml → 16  0（只新增，不删既有行）
```

日志 `03-restored-green.log`：`tests 23 / pass 23 / fail 0 / cancelled 0`，**exit 0**（重建后实测：`ci-real-pg-wiring.test.mjs` 16 条 + `ci-integration-chain-structure.test.mjs` 7 条）。

## 6. 工作流静态自检（读数为 `05-workflow-static-check.log`）

| 项 | 读数 |
| --- | --- |
| 真 job 步数（`run`/`uses`） | 13（2 个 `uses` + 11 个 `run`） |
| 新步位置 | 最后一步，`line 179`；上一步是识别域（`line 162`），再上一步是 OCR 域（`line 148`） |
| 新步 `run` 行 | 与派单 §2.1 **逐字一致**（`true`） |
| 新步 `env` | `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`，与既有 9 步逐字同形 |
| `continue-on-error` | 无 |
| step 级 `if:` | 无 |
| `\|\| true` | 无 |
| `GY_ALLOW_SKIP` / `--allow-skip` | 无 / 无 |
| `uses:` | 2 条，均 40 位小写 hex（`actions/checkout@11bd7190…`、`actions/setup-node@49933ea5…`） |
| `services` 镜像 | `line 46: image: postgres:17.11`（未动） |
| 全库搜索 `account-suspend-pg` | 只出现在本 workflow 的 `line 179`（即 `run:` 行，不是注释） |

## 7. 门禁（全绿，逐条 exit code）

日志都在 `E:\GengYunCommander\.pg17\handoff\r28-s39-logs\gates\`（第 6 条另存一份 `../03-restored-green.log`）。

| # | 命令 | exit | 读数（逐字） |
| --- | --- | --- | --- |
| 1 | `npm run lint` | **0** | `PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、`PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）`、`lint 通过`（`01-lint.log`） |
| 2 | `node tools/verify-release-materials.mjs` | **0** | 末行 `15/15 项通过（离线文档核验；不代表部署、云端或运行期已验收）`（`02-verify-release-materials.log`） |
| 3 | `npm run test:docs` | **0** | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住`、`PASS docs/research 结构校验…`（`03-test-docs.log`） |
| 4 | `node tools/verify-contract-status.mjs` | **0** | `PASS: 证据锚点 141 条…`、`PASS: 纯行号区间 229 条…`、`PASS: 中文表格一致`（`04-verify-contract-status.log`；`WARN` 是既有的 268 条无锚点计数，只计数不判红） |
| 5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | **0** | `tests 6 / pass 6 / fail 0`（`05-contract.log`） |
| 6 | `node --test --test-concurrency=1 tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` | **0** | `tests 23 / pass 23 / fail 0 / cancelled 0`（重建后实测） |
| 7 | `git diff --check` | **0** | 输出为空（无空白错误，`07-git-diff-check.log` 0 字节） |

## 8. 未取得项（诚实清单）

1. **没有在 GitHub runner 上跑过**：本片写手不持有 GitHub 凭据，`pushed=no`、无 run ID。CI 侧的真实读数要等 PR 起来之后由监工看。
2. **没有验证 runner 自带的 `psql` 版本**：本步用到的只有 `psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE …'`，与既有 9 步**完全同形**（那 9 步在 `ubuntu-24.04` 上已长期绿），所以风险被既有事实覆盖；但本片没有单独取证。
3. **与 `#349` 的合并顺序已实测**：`#349` 先合（`e01dd67`）后本片 PR 变 `DIRTY`，指挥在 `wt-r28-s39` 合流 `upstream/main` 时解了两处冲突（workflow 尾部、`ci-real-pg-wiring.test.mjs` 的四段），把本片重排为**第 10 条**、把「第 8 条注释里已失实的『workflow 里也是最后一步』」订正，并重取了本页全部读数（含 §5 负控制）。结论：冲突是**文本同区域**而非语义依赖，判据⑥按 `REQUIRED_STEP_ORDER` 逐项比对，与「谁是第 9 条」无关。若后续 `#354`（语音域接 CI）合流，它应排为第 11 条。
4. **没有跑真实的「前序 step 序列」**：§4 用的是跨库依赖夹具（等效形状），不是把 `admin-accounts-read-pg` 真跑一遍再接着跑本脚本。差别在于真实前序会留下 `gengyun_admin_accounts_read_test` 库与其中的对象；夹具用 `gengyun_hold` 库等效占位。**结论（两种分支都 exit 0）不受影响**，但严格意义上不是端到端复现。
5. **`[S]` 那一臂未重跑**：`90-assert-least-privilege.sql` 含 psql 元命令，只能 `psql -f` 单独跑；本片沿用 R28-S15 证据页 §7 的读数（脚本的 `[S]` 行如实打印其存在，不代跑、不计失败）。
6. **未在 Linux 上跑过**：脚本是纯 ESM + `pg` 驱动，无平台分支；但本页所有读数都来自 Windows 本机。

## 9. 复现（命令清单）

```powershell
# 1) 一次性集群（用 Invoke-CimMethod，不要 pg_ctl start）
$bin='E:\GengYunCommander\.pg17\pgsql\bin'; $dd='E:\GengYunCommander\.pg17\data-r28s39'
Set-Content -Path "$env:TEMP\pw.txt" -Value 'synthetic-ci-owner-only' -NoNewline   # --pwfile 不接受进程替换
& "$bin\initdb.exe" -D $dd -U gengyun_ci_owner --auth=scram-sha-256 --pwfile="$env:TEMP\pw.txt" -E UTF8 --locale=C
$cmd = "`"$bin\postgres.exe`" -D `"$dd`" -p 55649 -c listen_addresses=127.0.0.1"
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }

# 2) psql 必须带 PGPASSWORD（scram 会等口令挂住）
$env:PGPASSWORD='synthetic-ci-owner-only'
& "$bin\psql.exe" -h 127.0.0.1 -p 55649 -U gengyun_ci_owner -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_suspend_test'

# 3) 与 CI 逐字相同的脚本调用（只换端口）
node tests/integration/account-suspend-pg.mjs postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:55649/gengyun_suspend_test

# 4) 负控制（备份→回退 workflow→跑→恢复→核对 sha256）
```

## 10. 与 R28-S15 的衔接

- S15 修的是**脚本**（口令单一来源、派生 URL、CREATE 换 ALTER）；本片做的是**接线**，脚本本体零改动（`git diff --stat` 只含 3 个文件 + 本页）。
- S15 §4.2 曾写「本脚本必须排在 `admin-accounts-read-pg` / `account-deletion-pg` **之后**」——本片把它变成了**有序 steps 里的最后一步**，并用 §4 的夹具证明了「排在其后」这一条不会因角色残留而炸。
- S15 §4.1 的「非超级 owner 会残留 7 个角色而日志照打『删除 7 个』」**仍在**（本片没碰脚本）；CI 里 owner 是 `POSTGRES_USER=gengyun_ci_owner`（容器内超级用户，§3.1 已验），故不触发该瑕疵。
