# 真库臂「同库隔离」修复与护栏（GY-R29 第二片 / F6）

- 基线：`5b631ec`（= 本片开工时 `origin/main`）｜分支 `test/gy-r29-arms-isolation`｜worktree `E:\GengYunCommander\wt-r29-isolation`
- 现场：本机 PostgreSQL 17.11（`E:\GengYunCommander\.pg17\pgsql\bin`，`initdb -U gengyun_ci_owner`，端口 `55661`，`scram-sha-256`）
- 范围：**只做 F6**（`auth-privacy-pg` 与 `migrations-negative-pg` 共用一库的隔离风险）。F2/F3/F4/F5 未动，见 §5。

## 1. 结论（五条）

1. **两个 step 曾经跑在同一个库上。** `.github/workflows/auth-privacy-postgres.yml` 的 `AUTH_PRIVACY_TEST_URL` 与 `MIGRATIONS_NEGATIVE_TEST_URL` 原都指向 `…/gengyun_auth_privacy_test`；一端的残留会掩住另一端（真红读数见 §2）。
2. **已分库**：`auth-privacy-pg` 独占 `gengyun_auth_privacy_test`；迁移负例的**维护连接**改指服务自带的空库 `postgres`，由脚本自建 `gengyun_migrations_negative_maint`（维护）与 `…_{a,b,c}`（被测），收尾删净并断言 `pg_database` 零残留。
3. **"按库限定"不能用 `IN DATABASE` 语法**：PG 17.11 实测 `ERROR: syntax error at or near "IN"`。所以 `DROP OWNED BY` 只能**逐库连接**各做一次（`auth-privacy-pg.mjs:56` 的 `dropRolesEverywhere`）。
4. **收尾不再吞错**：`migrations-negative-pg.mjs:464-492` 与 `auth-privacy-pg.mjs:403-429` 都改成分项 try/catch 收集故障 → 断言必须为空；另断言「本臂库/角色残留 = 0」。旧实现的 `.catch(() => {})` 是一条假绿通道（§2 R3）。
5. **护栏落地**：新增 `tests/unit/auth-privacy-arm-isolation.test.mjs`（4 条判据 + 5 条反向控制，8/8 pass），把「两 step 不同库」「不新增集成 step」「不吞错」「逐库清理」钉成静态门禁。

## 2. 改前真红读数（逐字）

**R1 同库复用**（本片复现；改后代码亦然，因为它就是"全新库"前置契约）：

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

29 !== 0

    at file:///E:/GengYunCommander/wt-r29-isolation/tests/integration/auth-privacy-pg.mjs:136:10
```

`:136` 是 `SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'` 必须为 `0` 的**全新库前置断言**（该行是本臂原有关卡，非本片新增）。⇒ 同一个库被两个 step/两次运行共用时，"谁先跑"就决定另一个的红绿。

**R2 跨库依赖**（角色在**另一个库**里拥有对象，只在当前库 `DROP OWNED BY` 后再 `DROP ROLE`）：

```
CODE=2BP01  MESSAGE=role "probe_decoy_role" cannot be dropped because some objects depend on it
DETAIL=1 object in database probe_decoy_db
```

⇒ 旧收尾 `DROP OWNED BY a,b; DROP ROLE …`（单条、只清当前库）在跨库残留时必抛；若外层还有 `.catch`，红就被吃掉。

**R3 吞错**（删库失败 + `.catch(() => {})`）：

```
CODE=55006  MESSAGE=database "probe_swallow_db" is being accessed by other users
吞错后该库仍存在=true（进程此刻 exit 0 语义）
```

⇒ 旧 `migrations-negative-pg.mjs` 收尾的 `.catch(() => {})` 会让"库没删掉"这一步照绿。

**R4 语法不可用**（否决"用 `IN DATABASE` 限定"这条捷径）：

```
ERROR:  syntax error at or near "IN"
LINE 1: DROP OWNED BY gengyun_ci_owner IN DATABASE postgres
```

## 3. 改了什么（文件:行 → 判据）

| 文件 | 位置 | 改动 | 判据 |
| --- | --- | --- | --- |
| `.github/workflows/auth-privacy-postgres.yml` | `:37-43` | `MIGRATIONS_NEGATIVE_TEST_URL` 改指 `…:5432/postgres`；注释写死"不要改回 `gengyun_auth_privacy_test`"；**不新增 step** | 两 step 库名不同；建/删库仍由脚本负责 |
| `tests/integration/auth-privacy-pg.mjs` | `:34-35` | 诱饵库/诱饵角色常量 `gengyun_auth_privacy_decoy_db` / `gengyun_auth_privacy_decoy` | 负控制可寻址 |
| 同上 | `:56` `:66-67` | `dropRolesEverywhere(names)`（遍历 `pg_database WHERE datistemplate = false`，逐库 `DROP OWNED BY` 后再 `DROP ROLE`）、`dropDatabase`/`createDatabase` | 跨库残留可清；不用 `IN DATABASE` |
| 同上 | `:135` | 开跑前先逐库清掉同名角色，再断言 `pg_tables`/`pg_roles` 为 0 | 顺序/并发不再决定红绿 |
| 同上 | `:144-163` | **D0 跨库负控制（CI 每次跑）**：造 `decoy_db` + 拥有对象的 `decoy` 角色 → 断言"只清当前库"必报 `cannot be dropped because some objects depend on it` → 每库清理后断言诱饵角色/诱饵库归零 | 收尾断言非空转 |
| 同上 | `:403-429` | `catch` 记 `bodyFailure` 后重抛；`finally` 分项收集清理故障 → `assert.deepEqual(faults, [])`、残留角色/残留库 `deepEqual []`；正向臂已红时只打日志不盖原始失败 | 清理失败必红 |
| `tests/integration/migrations-negative-pg.mjs` | `:123` `:125` | 专用维护库 `gengyun_migrations_negative_maint`、诱饵库 `gengyun_migrations_negative_decoy` | 维护连接不落在被测库 |
| 同上 | `:236-237` | 开跑前清掉本臂前缀的全部遗留库，并断言为零 | 上次残留不污染本次 |
| 同上 | `:242-253` | 维护库建立后断言"本臂库只剩维护库"；造诱饵库 → 断言探测器抓到 → 删掉 → 断言归零 | 探测器有牙 |
| 同上 | `:464-492` | 收尾去掉 `.catch(() => {})`；逐库删（含维护库）并收集故障；断言故障为空、`pg_database` 无本臂库、基准库 `public` 对象数不变 | 删库失败必红 |
| `tests/unit/auth-privacy-arm-isolation.test.mjs` | 新文件 | 判据 1-4（库名互异 + 维护库指向 `postgres` + 集成 step 数 == 2 + 不吞错/逐库清理/残留断言在场）+ 反向控制 ①-⑤（每处变异必须红） | 判据回退时测试必红 |

## 4. 改后读数

| 检查 | 命令 | 读数 |
| --- | --- | --- |
| 迁移负例（真库） | `MIGRATIONS_NEGATIVE_TEST_URL=…55661/postgres node tests/integration/migrations-negative-pg.mjs` | **exit 0 / 7.2 s / PASS 12 / 版本 17.11 / 26 迁移 / 台账 26 行**；含 `PASS 1: D1 遗留库负控制：诱饵库被抓到 → 清掉 → 探测器归零` |
| auth-privacy（真库） | `AUTH_PRIVACY_TEST_URL=…55661/gengyun_auth_privacy_test node tests/integration/auth-privacy-pg.mjs` | **exit 0 / 7.2 s / PASS 27 / 版本 17.11**；含 `PASS 2: 跨库负控制：只在本库 DROP OWNED 时 DROP ROLE 报 dependent objects；每库清理后诱饵角色/诱饵库归零` |
| 收尾残留（外部核对） | `psql -Atc "SELECT string_agg(datname,',') FROM pg_database"`、`… FROM pg_roles WHERE rolname LIKE '%decoy%'` | 库：`postgres,gengyun_auth_privacy_test,template1,template0`；诱饵角色：`(none)` |
| 新判据单测 | `node --test tests/unit/auth-privacy-arm-isolation.test.mjs` | **8/8 pass**（120 ms），含 5 条反向控制 |
| 既有接线/顺序守门 | `node --test tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` | **25/25 pass**（未放宽、未改步数） |

## 5. 未改动与边界

- **不加 `CREATE DATABASE` step**：本 workflow 没有 `REQUIRED_STEP_ORDER` 之类的顺序常量，加 step 只会再造一套形状；建/删库仍由两个脚本自建自删（`migrations-negative` 用一个维护库 + 三个被测库）。因此 `ci-real-pg-wiring.test.mjs` 的四数组（15/15/15/3）与 `ci-integration-chain-structure.test.mjs` 的顺序判据**一行未改**。
- **F2/F3/F4/F5 未动**（20 只脚本的 `*_PG_ROOT` 统一、版本变量补齐、断言计数、诱饵断言等），按指挥要求另片处理。
- `auth-privacy-pg` 仍要求**全新库**（`:136` 断言）：CI 每个 job 一个新 `service` 满足；本地复跑必须先 `DROP DATABASE … WITH (FORCE)` 再建同名库（本片读数即如此取得）。
- 诱饵库/诱饵角色在**每次运行内**建立并删除，同名残留由 `:135`/`:236-237` 的开跑前清理兜住。

## 6. 未取得（单列）

- **未取得 GitHub Actions 读数**：本片只在本地 17.11 + 静态单测上验证；`auth-privacy-postgres-17.11` job 的真红/真绿待 PR 跑出。
- **未取得 CI 服务里 `postgres` 库的直连证据**：本地是 `initdb` 自建实例（`postgres` 库必在）；CI 由 `postgres:17.11` service 提供，`POSTGRES_USER` 在该镜像里是超级用户、`postgres` 库默认存在——这条属**推断**，未在 Actions 实测。
- **未取得并发改名后的耗时基线**：`:136` 的全新库契约意味着同一个库连跑两次仍会红（§2 R1），本片未把它改成"每次换库名"（那会改动臂的对外环境变量契约，超出 F6 范围）。
