# 语音转写域 PostgreSQL 持久化（GY-R28 S20）取证页

- 日期：2026-10-21（本地时区 Asia/Hong_Kong）
- 分支：`feat/gy-r28-speech-persist`，基线 `693af5d5bf7a102e1bf84d0704bf4e8fb5743419`
- 范围：语音转写域（`services/api/src/speech/**`）从"只有内存 store"接上 PostgreSQL 持久化；**不动**契约台账、`jobs/sources.ts`、`.github/workflows/**`、`deploy/postgres-cvm/**`
- 一句话结论：迁移 `0026` 建三张表（`speech_jobs` / `transcriptions` / `speech_idempotency`），`speech/store-pg.ts` 落地 12 个方法的 CAS／单事务／单语句幂等／缺表三态，路由层三态选型，真库 30 条 PASS（含 5 条负控制）；三张语音表**本片未授权**，运行时角色直连会 42501（见「没做到」）。

## 1. 改前实测（基线事实，非推断）

| 事实 | 改前读数 | 取证方式 |
| --- | --- | --- |
| `services/api/src/speech/` 内容 | `media.ts` / `provider.ts` / `service.ts` / `state.ts` / `store.ts`，**无** `store-pg.ts` | 目录列举 |
| 语音 store 实现 | 仅 `createMemorySpeechStore()`（`store.ts:142`），`persistent = false` | 源码 + `describe().storePersistent=false` |
| 重启语义 | 进程重启 ⇒ 任务与转写记录全丢（内存 Map） | 真库脚本 `[N2]` 负控制可复现 |
| 迁移链 | `0001..0025` 连续；`0026` 空号；rollback 目录 `0002..0025` 有 down、无 `0001` | `discoverMigrations()` 计数 |
| `app.ts` 行数 | 1821 行（LF，末尾换行）；末行是上一片追加的 `recognitions/store-pg.ts` 值导入 | `[IO.File]::ReadAllText` + LF 计数（PowerShell 5.1 `Get-Content` 对 UTF-8 中文会少数并乱码，**不可用**） |
| 装配行 | `services/api/src/app.ts:1711` `registerSpeechRoutes(app, config, { guards, store: speechStore, provider, media, jobDeadlineMs, consent, egress })` | 源码 |
| 基线门禁 | `node tests/integration/speech-http.mjs` ⇒ exit 0（含 `[9]` 结构性证据组） | 改前实跑 |

## 2. 改后交付

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `services/api/db/migrations/0026_speech_persistence.sql` | 154 | `BEGIN;` 三表 + 三索引 + `COMMIT;`，头部注释写清选型与边界 |
| `services/api/db/migrations/rollback/0026_speech_persistence.down.sql` | 18 | 反依赖序 `DROP TABLE IF EXISTS` ×3 |
| `services/api/src/speech/store-pg.ts` | 667 | 12 方法 + 三态探测 + 错误折叠；`persistent: true` |
| `services/api/src/routes/speech.ts` | 269 | 三态选型（注入 → real+池 ⇒ PG → 否则内存），池走第 4 个**位置**实参 |
| `services/api/src/app.ts` | 1821（**不变**） | 装配行原位一行改完：追加第 4 个实参 `config.executionMode === 'real' ? pool : null`；`git diff --numstat` = `1 1` |
| `tests/unit/speech-store-pg.test.mjs` | 503 | 15 条：12 方法一一对应 + 持久化标志 + 错误折叠 + 缺表错误类型 |
| `tests/unit/speech-store-pg-tables-missing.test.mjs` | 247 | 7 条：三态（缺表 / 探测失败 / 运行中 42P01） |
| `tests/unit/speech-store-pg-wiring.test.mjs` | 158 | 5 条：路由层四条选型 + 结构锚点 |
| `tests/integration/speech-pg.mjs` | 925 | 真库 30 条 PASS；`SPEECH_PG_TEST_URL` 未设 ⇒ 打印 SKIP 并 `exit 77` |
| `tests/unit/ci-integration-chain-structure.test.mjs` | +6 行 | `UNWIRED_DECLARATIONS` 登记 `speech-pg.mjs`（未接任何 workflow） |

### 迁移 0026 形状（与 0024/0025 同代际）

- `speech_jobs`：`id uuid PK`、`revision integer NOT NULL CHECK (revision >= 1)`、`kind text NOT NULL CHECK (kind = 'transcription')`、`owner_user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE`、`transcription_id uuid NOT NULL`、`media_id uuid NOT NULL`、`media_revision integer CHECK (>= 1)`、**`state job_state NOT NULL`（复用 0001 枚举）**、`deadline_at/created_at/updated_at timestamptz NOT NULL`、`error_code varchar(80)`；索引 `(owner_user_id, created_at DESC, id DESC)`。
- `transcriptions`：同上 revision/owner/媒体列 + `raw_text text NOT NULL CHECK (char_length <= 8000)`、`uncertain_spans jsonb NOT NULL CHECK (jsonb_typeof = 'array')`、`confirmed_text`（NULL 或 1..8000）、`confirmed_at`、`model_version`（1..80）、`deleted boolean NOT NULL`。
- `speech_idempotency`：`PRIMARY KEY (scope, key_hash)`、`request_hash`、`payload jsonb NOT NULL CHECK (jsonb_typeof = 'object')`、`pending boolean NOT NULL`、`expires_at timestamptz NOT NULL`，`expires_at` 单列索引。
- 没有给 `transcription_id` / `media_id` 建外键：转写记录由 `commitTerminal` 在**之后**写入，媒体对象不在本域表内 —— 建 FK 会在合法时序上误报，故只做类型约束，边界写在迁移头部注释里。

## 3. 12 个方法逐个（`services/api/src/speech/store-pg.ts`）

| # | 方法 | 关键 SQL 形状 | 语义要点 | 单测 | 真库 |
| --- | --- | --- | --- | --- | --- |
| 1 | `insertJob` | `INSERT INTO public.speech_jobs (...) VALUES (...) RETURNING id` 单条 | 23505 ⇒ `SpeechStoreConflictError('任务 id 冲突')`（与内存同文案） | [1] | PASS 9 |
| 2 | `getJob` | `SELECT <JOB_COLUMNS> ... WHERE id = $1::uuid` 单条 | 未命中 ⇒ `null`；行形状校验（`isJobState` + `kind`） | [2] | PASS 10 |
| 3 | `updateJob` | `UPDATE ... SET revision = $3, ... WHERE id = $1::uuid AND revision = $2 RETURNING` **单条 CAS** | 0 行 ⇒ `null`；`revision` 由调用方 `+1` 后写入（与内存一致，SQL 侧不二次加） | [3] | PASS 11 |
| 4 | `commitTerminal` | 单事务：`BEGIN` → `SET LOCAL lock_timeout='4s'` → `SELECT ... FOR UPDATE` → 可选 `INSERT transcriptions` → `UPDATE ... revision = revision + 1` → `COMMIT` | CAS 失败/非法迁移 ⇒ `null` 且**不写**记录；记录冲突 ⇒ `ROLLBACK` | [4] | PASS 12 |
| 5 | `insertTranscription` | 单条 `INSERT ... RETURNING id` | 冲突 ⇒ `转写记录 id 冲突` | [5] | PASS 13 |
| 6 | `getTranscription` | 单条按主键 `SELECT` | `uncertain_spans` 逐项映射（不重排/不合并） | [6] | PASS 14 |
| 7 | `updateTranscription` | 单条 CAS `UPDATE ... WHERE id = $1::uuid AND revision = $2 RETURNING` | CAS 前先取快照判 `raw_text`/`uncertain_spans` 是否被改：改了就抛 `转写记录的 raw_text / uncertain_spans 不可改写（存储层不变量）` 且**不发** UPDATE | [7] | PASS 15 |
| 8 | `findIdempotent` | 单条 `SELECT ... WHERE scope = $1 AND key_hash = $2` | **不**按过期过滤（与内存逐条一致；过期由 service 的 purge 清） | [8] | PASS 16 |
| 9 | `claimIdempotent` | **单条** `INSERT ... ON CONFLICT (scope, key_hash) DO NOTHING RETURNING scope` | 据返回行数判 `'claimed' / 'exists'`；⛔ 不是「先 SELECT 再 INSERT」 | [9] | PASS 17 |
| 10 | `finalizeIdempotent` | 单条 `UPDATE ... SET payload = $3::jsonb, pending = false WHERE scope/key` | 行不存在是空操作 | [10] | PASS 18 |
| 11 | `releaseIdempotent` | 单条 `DELETE ... WHERE scope/key`（无条件） | 与内存 `delete` 同义 | [11] | PASS 19 |
| 12 | `purgeIdempotent` | 单条 `DELETE ... WHERE expires_at <= $1::timestamptz RETURNING scope` | 返回**删除行数** | [12] | PASS 20 |

错误处理：`23505` 只映射成冲突（不吞成"表缺失"）；`42P01` ⇒ 清缓存 + `SpeechTablesMissingError`；`57014`/`55P03` ⇒ `ApiError('PROVIDER_TIMEOUT', retryable: true)`；其余驱动错误 ⇒ `ApiError('PROVIDER_UNAVAILABLE', retryable: true)`；非驱动错误（无字符串 `code`）**原样抛出**，不折叠。

### 缺表三态（`服务` 三种输入 → 三种行为）

| 探测结果 | 读类（`getJob`/`getTranscription`/`findIdempotent`） | 写类（其余 9 个） | `persistent` |
| --- | --- | --- | --- |
| `ready` | 正常查库 | 正常写库 | `true` |
| `missing`（三表 `to_regclass` 明确为 NULL） | 返回 `null`，不抛错 | 抛 `SpeechTablesMissingError`，文案点名 `0026_speech_persistence.sql`，`retryable: false`，**不进入事务** | `true`（如实：仍是持久化实现，只是表没迁移） |
| `unknown`（探测本身失败/应答形状读不懂） | 按数据库故障 fail-closed：`PROVIDER_UNAVAILABLE`（`retryable: true`），**不**冒充"未迁移" | 同上 | `true` |

运行中才缺表（写前缓存为 `ready`、之后表被回滚）同样 fail-closed：`42P01` ⇒ 缓存失效 + 点名迁移文件的错；下一轮会重新探测（`[三态-3]` 单测 + 真库 `[N5]` 正反两向各一条）。

## 4. 偏离派单字面要求（如实登记，已获指挥裁决 B）

- 派单 §2.3 的字面要求：**`app.ts` 自己**做三态选型（`real`+池 ⇒ `createPostgresSpeechStore`，否则内存），并"import 追加在文件末尾"。
- 实测被既有资产挡住：`tests/integration/speech-http.mjs:530-540` 把「`app.ts` 里所有含 `speech/store`、`speech/provider`、`speech/media` 的行只能是 `import type { … } from './speech/…'`」钉成结构性质。在 `app.ts` 追加**值**导入会直接打红这条既有断言；而红线要求"不削弱断言"。
- 采用 OCR 同形范式（2026-10-20 的 `0024` 接线就是这么接的）：**选型下沉到域内** `services/api/src/routes/speech.ts`，`app.ts` 只在装配行原位置多传一个**位置实参**池：
  - `services/api/src/app.ts:1711` → `registerSpeechRoutes(app, config, { …原有的 7 个键… }, config.executionMode === 'real' ? pool : null);`
  - `routes/speech.ts`：`const store = deps.store ?? (config.executionMode === 'real' && persistencePool !== null ? createPostgresSpeechStore({ pool: persistencePool }) : createMemorySpeechStore());`
  - 池不是 `deps` 的键 ⇒ 注册行键集判据（`guards/store/provider/media/jobDeadlineMs/consent/egress`）逐字不变。
- 因此：**既没改那条断言，也没削弱它**；`speech-http.mjs` 原样跑 ⇒ exit 0（读数见 §6）。代价是"三态选型"证据落在 `tests/unit/speech-store-pg-wiring.test.mjs`（路由层四条），而不是 app.ts 结构断言；"为什么测这里"即本节。

### 行号锚点的坑（连带发现，如实记录）

第一次改 `routes/speech.ts` 时我把"选型说明"写成 13 行头部注释 + 多行签名，结果 `node tools/verify-contract-status.mjs` 立刻红：

```
ERROR: 语义错误 · getTranscription: services/api/src/routes/speech.ts:196-208 区间落在 post /speech/transcriptions 的注册块内，未覆盖任何本操作注册块，与 get /speech/transcriptions/{id} 不符
FAIL: 契约实现状态对照校验未通过（1 项）[形状错误 0 / 语义错误 1 / 表格漂移 0]
```

原因：该文件的 160-194 / 196-208 / 210-228 / 230-248 是契约台账的行号锚点，上面多一行就整体漂移。修法：签名与选型**各替换一行**（净行数 0），解释与导入全部追加到文件末尾（锚点之后）。最终 `git diff --numstat` = `20 2`，其中 18 行在文件末尾；重跑校验器回到 `PASS`（§6 g4）。这条也解释了 `app.ts` 为什么坚持"原位一行、零新增 import"。

## 5. 真库读数（PG 17.11，端口 55646，库 `gengyun_speech_test`，角色 `gengyun_cvm_owner`）

启动方式按派单：`Invoke-CimMethod Win32_Process Create` 起 `postgres.exe`（⛔ 没有用 `pg_ctl start`）；`initdb -A scram-sha-256` 初始化 datadir `.pg17\data-r28s20`；跑完停进程。

命令与结果：

```
$env:SPEECH_PG_TEST_URL='postgres://gengyun_cvm_owner@127.0.0.1:55646/gengyun_speech_test'
node tests/integration/speech-pg.mjs
共 30 条 PASS，耗时 1844ms
ALL PASS：语音转写域 PostgreSQL 持久化（迁移 0026 三连 / 12 方法语义 / 关连接重开逐字节仍在 / 5 条负控制含缺表 fail-closed）
EXIT=0
```

> 上表读数是**最终树复跑**的：`0026` + `store-pg.ts` + 路由层重排 + 证据页全部落定之后，drop 掉旧库重建成空库再跑一遍（脚本自己断言"public 下 0 张表"，第二次跑若不重建库会以 `68 !== 0` 拒绝 —— 这正是"必须空库"前置在工作）。

30 条覆盖：`[M0]` 迁移链 26 个连续无缺号 · `[M1]` 0001..0025 已应用且语音表全不存在 · `[M2]` UP 后三表三索引 + `state` 绑定 `job_state` 七值 + 2 条 CASCADE 外键 · `[M3]` ROLLBACK 只掉本片对象、`users`/`jobs` 仍在 · `[M4]` REPLAY 成功 · `[M5]` 库侧闭集拒绝（`bogus_state` ⇒ 22P02、`bogus_kind`/`revision=0` ⇒ 23514） · `[W]` 接线三态 · `[1]..[12]` 12 方法逐条语义 + 库内核对 · `[R1]` `pool.end()` 后残留 0 连接 · `[R2]` 新 Pool + 新 store 指纹逐字节相等（`498609c586097d3e…` / `c3c0556906730f14…`） · `[R3]` 新 app 读面读到重启前数据、他人读仍 NOT_FOUND · `[R4]` **子进程**重启臂 `CHILD-RESULT=PERSISTED` · `[N1]` 篡改⇒指纹变、写回⇒逐字节重现 · `[N2]` 内存 store 新实例读不到（改前缺陷本体复现） · `[N3]` 并发双 CAS 恰好 1 次成功、库内 `revision=2` · `[N4]` 同 id 重复写行数恒 1 · `[N5]` 回滚后读全 null / 写抛点名 0026、缓存 ready 的旧实例遇 42P01 同样 fail-closed · `[N5]` 复原后立即可写（不会永久锁死）。

## 6. 负控制（每条都用"变异 → 红 → 复原 → 绿"取原文）

三条都是**故意改坏源码**再跑同一份单测，红了以后 `git checkout --` 复原并复跑绿：

1. **CAS 不加 revision**：把 `commitTerminal` 的 `revision = revision + 1` 改成 `revision = revision`。
   ```
   ✖ [4] commitTerminal：单事务 BEGIN → FOR UPDATE → INSERT（可空）→ UPDATE → COMMIT
     AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^UPDATE public\.speech_jobs SET state = \$3, error_code = \$4, revision = revision \+ 1/. Input:
     'UPDATE public.speech_jobs SET state = $3, error_code = $4, revision = revision, updated_at = $5::timestamptz WHERE id = $1::uuid AND revision = $2 RETURNING …'
   ℹ pass 14 / ℹ fail 1
   ```
   复原后：`ℹ pass 15 / fail 0`。
2. **幂等退化成 DO UPDATE**：把 `claimIdempotent` 的 `ON CONFLICT … DO NOTHING` 改成 `DO UPDATE SET pending = EXCLUDED.pending`。
   ```
   ✖ [9] claimIdempotent：单条 INSERT … ON CONFLICT (scope, key_hash) DO NOTHING；据返回行判 claimed/exists
     AssertionError [ERR_ASSERTION]: The input did not match the regular expression / ON CONFLICT \(scope, key_hash\) DO NOTHING/. Input:
     'INSERT INTO public.speech_idempotency (…) VALUES (…) ON CONFLICT (scope, key_hash) DO UPDATE SET pending = EXCLUDED.pending RETURNING scope'
   ℹ pass 14 / ℹ fail 1
   ```
   复原后：`ℹ pass 15 / fail 0`。
3. **缺表静默写**：去掉 `insertJob` 的 `requireTables()`（让缺表时的写直接落到库上报 42P01 而不是 fail-closed）。
   ```
   ✖ [三态-1] 探测明确"缺表"：写方法抛点名迁移文件的错（N7），且不进入事务
     AssertionError [ERR_ASSERTION]: Missing expected rejection: insertJob 缺表时必须 fail-closed
   ℹ pass 6 / ℹ fail 1
   ```
   复原后：`ℹ pass 7 / fail 0`。

真库侧另有 5 条常驻负控制（`[N1]..[N5]`，§5），不是一次性变异：篡改-复原、内存冒充、并发双 CAS、重复写、缺表 fail-closed/复原。

## 7. 门禁读数（全部本机自跑，原始日志在 `.pg17/handoff/r28-s20-logs/`）

| # | 命令 | exit | 读数 |
| --- | --- | --- | --- |
| g1 | `npm run lint` | 0 | `tsc --noEmit` services/api PASS、apps/admin PASS、仓库卫生扫描 PASS |
| g2 | `npm run test:contract` | 0 | `tests 6 / pass 6 / fail 0` |
| g3 | `npm run test:docs` | 0 | 研究记录 5 通过 / 0 失败 / 4 legacy 钉住；`docs/research` 结构校验 PASS |
| g4 | `node tools/verify-contract-status.mjs` | 0 | `覆盖 112 条契约操作；已装配 108；implemented 13 / partial 95 / planned 4；形状错误 0 / 语义错误 0` |
| g5 | `node tools/verify-release-materials.mjs` | 0 | `15/15 项通过`；迁移 26 个（0001..0026）/ down 25 个（0002..0026） |
| g6 | `node --test --test-concurrency=1 tests/unit/speech-store-pg*.test.mjs` | 0 | `tests 27 / pass 27 / fail 0 / skipped 0` |
| g7 | `node tests/integration/speech-http.mjs` | 0 | 含 `[9]` 默认零端口注入结构性证据（`store: speechStore`、键集 7 个、app.ts 只 import type） |
| g8 | `npm run test:integration:http` | 0 | 13 个脚本全链通过（含 speech-http、tts-http、transcript-confirm-http） |
| g9 | `node --test --test-concurrency=1 "tests/unit/*.test.mjs"` | 见下 | 全量单测读数 |

> `node --test` 一律加 `--test-concurrency=1`（派单要求）。

## 8. 没做到（不掩盖）

1. **三张语音表的运行时授权缺口（最重要）**：本片按派单**一个字都没改** `deploy/postgres-cvm/**`，没有给 `speech_jobs` / `transcriptions` / `speech_idempotency` 加 `GRANT`。迁移本身用库 owner 执行，但**运行时角色**直连这三张表会 `42501`（insufficient_privilege）。按既有 S24/S26/S28 的节奏，授权属**后续授权片**；真库取证因此用库 owner `gengyun_cvm_owner`，这不能当成"运行时角色已可用"。
2. **HTTP 面的"重启不丢"未取证**：`real` 模式的真实 ASR 提供者/媒体端口未接线，`POST` 语音受理在 provider 前即 503，无法经 HTTP 建任务。本片证据落在 **store 层 + 迁移层 + `app.speechService` 读面**，不是 HTTP 端到端。
3. **没有做压测**：只做两路并发 CAS 与两路并发 claim，没有 20+ 并发的吞吐/延迟读数，也没有 `lock_timeout` 在长事务下的行为取证。
4. **没有真实 ASR 模型输出落库**：模型调用未接线，用契约合法的手工文本/区间验证持久化，不声称识别准确率。
5. **没有备份恢复演练**：只验证单库迁移 `UP/ROLLBACK/REPLAY` 与关连接重开，没有 `pg_dump`/`pg_restore`。
6. **`speech-pg.mjs` 未接 CI**：本片只按派单在 `UNWIRED_DECLARATIONS` 登记（理由：未接任何 workflow），`.github/workflows/**` 一字未改；真库门禁接线留后续片。
7. **`app.ts` 没有做字面上的三态**：按指挥裁决 B 下沉到路由层（§4），`app.ts` 只多传位置实参。这不是削弱，但确实与派单 §2.3 的字面不同。

## 9. 复现命令

```powershell
cd E:\GengYunCommander\wt-r28-s20
npm run lint
npm run test:contract
npm run test:docs
node tools/verify-contract-status.mjs
node tools/verify-release-materials.mjs
node --test --test-concurrency=1 tests/unit/speech-store-pg.test.mjs tests/unit/speech-store-pg-tables-missing.test.mjs tests/unit/speech-store-pg-wiring.test.mjs
node --test --test-concurrency=1 "tests/unit/*.test.mjs"
node tests/integration/speech-http.mjs
npm run test:integration:http
# 真库（PG 17.11，先用 Invoke-CimMethod 起进程，不要用 pg_ctl start）
$env:SPEECH_PG_TEST_URL='postgres://gengyun_cvm_owner@127.0.0.1:55646/gengyun_speech_test'
node tests/integration/speech-pg.mjs
```

> 本页是离线/本机取证，不代表云端部署、运行时角色授权或真实 ASR 能力已验收。
