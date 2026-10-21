# GY-R28-S40 语音转写域接进真库门禁（第 9 个 `-pg` 脚本，跑全链迁移 0001..0026）

- 切片：S40（把已在 main、却没有任何 workflow 跑过的 `tests/integration/speech-pg.mjs` 接进真库 job）
- 分支：`test/gy-r28-speech-ci-wire`（based on `upstream/main = 32ce461`，即 `#351` 合入后的 HEAD；
  收尾复核 `git fetch upstream` 后 base 未前进）
- 日期：2026-10-21（本机实测时间）
- 环境：Windows / PowerShell **5.1.26100.8875** / Node **v24.16.0**（`package.json` engines `>=24.16.0 <25`）/
  npm 11.13.0 / PostgreSQL **17.11** 本机二进制（`E:\GengYunCommander\.pg17\pgsql\bin`）
- 集群：本片**自己起一个**，不碰本机既有集群
  - **`:55650`**，datadir `E:\GengYunCommander\.pg17\data-r28s40`
  - `initdb -D … -U gengyun_ci_owner --auth=scram-sha-256 -E UTF8 --locale=C`，口令
    `synthetic-ci-owner-only`（与 `real-pg-integration.yml` 的 `POSTGRES_USER`／`POSTGRES_PASSWORD` **逐字一致**）
  - 由 `Invoke-CimMethod Win32_Process Create` 起 `postgres.exe -D … -p 55650 -c listen_addresses=127.0.0.1
    -c logging_collector=on`（**没有**用 `pg_ctl start`；PS 5.1 也没有 `&&`，下面「CI 同形命令」是两次
    串行调用＋各自核 `exit code`，与 `psql … && node …` 等价）
- 铁律（本片执行口径）：**先在本机真跑出 exit=0 才接线**；**没有**改被测脚本一个字节（`speech-pg.mjs`
  的 sha256 在提交前后一致）、**没有**动 `services/**`／`apps/**`／`packages/**`／`deploy/**`／`migrations/**`／
  `roles/**`／其它 workflow／其它单测，**没有**用 `--allow-skip`／`GY_ALLOW_SKIP` 把 77 洗成 0。

---

## 1 结论

一条：`tests/integration/speech-pg.mjs`（S20／`#351` 交付）此前**只在本机跑过**——`.github/workflows/`
里逐文件检索 `speech-pg.mjs` 是 **0 命中**，也就是说它在 CI 上坏成什么样都不会红。本片把它接成
`real-pg-integration.yml` 的**第 9 个真库脚本 step**（该 job 里 `- run:` 共 10 个：`L65 npm ci` ＋
9 个真库脚本；本步是文件里最后一个 step，`L156-169`）。

| 项 | 事实 |
| --- | --- |
| 连接串来源 | **只认环境变量 `SPEECH_PG_TEST_URL`**（脚本 `:48 const ENV = 'SPEECH_PG_TEST_URL'`／`:54`），无 argv 入口 ⇒ step 必须用 `env:` |
| 库名 | 硬钉 `gengyun_speech_test`（`:49 const DB`／`:74 assert.equal(url.pathname, '/gengyun_speech_test')`）⇒ step 先 `CREATE DATABASE gengyun_speech_test` |
| 库前提 | **空库**（脚本 `:57` 之后先数 `public` 下的表；本机跑前实测 `0`）⇒ 与既有 8 步同形：`psql -c 'CREATE DATABASE …' && node …` |
| 缺前置语义 | 未设 `SPEECH_PG_TEST_URL` ⇒ 打印 `SKIP` 并 **exit 77**（`:57-65`）⇒ **缺库必红**，不是通过 |
| 迁移面 | 跑**全链** `discoverMigrations()`（0001..0026，含本片 `0026_speech_persistence.sql`），并做 0026 的 UP／ROLLBACK／REPLAY ⇒ 顺带守住迁移清单不变量 |
| 守卫 | `MANAGED_SCRIPTS`／`FROZEN_MANAGED_SCRIPTS` **8 → 9**，两处逐字同步；`REQUIRED_STEP_ORDER` **8 → 9**（本步排第 9） |
| 回环链 | **仍不在** `test:integration:http`：`UNWIRED_DECLARATIONS` 条目**保留**，只把 reason 改成真相（由真库 job 的独立 step 运行，不进无 PG 的回环链） |

接线前后对照：

| | 接线前（base `32ce461`） | 接线后（本片） |
| --- | --- | --- |
| 谁真跑 `speech-pg.mjs` | 没有任何 workflow | `real-pg-integration.yml` 的 `real-pg-17-11` job 最后一步 |
| 受管清单 | 8 条（末位 `ocr-jobs-pg`） | 9 条（末位 `speech-pg`） |
| 它坏了 CI 会红吗 | **不会**（0 命中） | 会（step 失败 ⇒ job 失败；守卫另有判据①⑥⑦⑧⑨） |
| 无 PG 回环链 | 不在 | **仍不在**（白名单条目保留、reason 更新） |

**注意本步与既有 `admin-accounts-read`／`admin-flags` 步的差别**：那两步依赖 R28-S14 在同一 job 里先建好的
运行时角色 `gengyun_api_runtime`；本步**不依赖任何角色**，只用库 owner 连接串、自己建专用空库、自己
apply 迁移，所以排在最后不影响任何前序 step 的假设（既有 8 步的顺序与文本一字未动）。

---

## 2 真跑取证（scram 集群 + CI 同形凭据，exit 0）

跑前建库与空库确认（`gengyun_speech_test`，属主 `gengyun_ci_owner`）：

```powershell
$env:PGPASSWORD = 'synthetic-ci-owner-only'
psql -w -h 127.0.0.1 -p 55650 -U gengyun_ci_owner -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_speech_test'
psql -w -h 127.0.0.1 -p 55650 -U gengyun_ci_owner -d gengyun_speech_test -tAc "select count(*) from information_schema.tables where table_schema='public'"
# 0
```

CI 同形命令（⚠️ 环境变量刻意与 workflow 里那个 step 的 `env:` 同源）：

```powershell
$env:PGHOST='127.0.0.1'; $env:PGPORT='55650'; $env:PGUSER='gengyun_ci_owner'
$env:PGPASSWORD='synthetic-ci-owner-only'; $env:PGDATABASE='gengyun_ci_bootstrap'
$env:SPEECH_PG_TEST_URL='postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:55650/gengyun_speech_test'
node tests/integration/speech-pg.mjs
```

首 8 行原文（`[M]` 迁移三连 + 结构不变量 + 行为负控制 + 接线）：

```
INFO 连接角色：gengyun_ci_owner（本片用库 owner 取证；授权缺口见文件头"已知边界"）
PASS 1: [M0] 结构不变量：迁移 26 个（0001..0026），连续无缺号；count === max；含 0026_speech_persistence.sql
PASS 2: [M1] 0001..0025 已应用：speech_* / transcriptions 全部不存在，users 在岗
PASS 3: [M2] UP：三表 + 三索引 + state 绑定 job_state 枚举（7 值逐项核对）+ 2 条 CASCADE 外键全部出现
PASS 4: [M3] ROLLBACK：本片对象全部消失，users 与 0001 的 jobs 表逐字仍在
PASS 5: [M4] REPLAY：同一份 UP 再执行一次仍成功，speech_jobs 再次出现
PASS 6: [0] 夹具主体 A=cad2fcfa-7a6d-4c5f-aadc-ec30b632162e（归属者）/ B=e11910fa-cd0c-4fbf-bd80-1f62bf19d97e（越权对照）已落 users 表
PASS 7: [M5] 行为验证：闭集外 state 'bogus_state'（枚举 22P02）/ kind 'bogus_kind'（23514）/ revision=0（23514）均被库侧拒绝，且 speech_jobs 仍 0 行
PASS 8: [W] 接线：real+池 ⇒ storePersistent=true；real+无池 ⇒ storePersistent=false（如实，不冒充）
```

`[1]`–`[12]`（`SpeechStore` 12 个方法逐条，逐字）：

```
PASS 9: [1] insertJob：落库 1 行（kind/state/transcription_id 逐字对）；同 id 再写由主键裁决并抛「任务 id 冲突」
PASS 10: [2] getJob：命中返回逐字段相等的行（含毫秒级时间往返）；不存在 ⇒ null
PASS 11: [3] updateJob：CAS 失败 ⇒ null 且库内 revision 不变；命中 ⇒ 状态迁移 + revision 恰好 +1；过期 revision 再写 ⇒ null
PASS 12: [4] commitTerminal：合法终态任务+记录同事务落库；CAS 失败不写记录；取消后迟到结果 null；记录冲突整体回滚（任务与 revision 均未变）
PASS 13: [5] insertTranscription：落库 1 行；同 id 再写由主键裁决并抛「转写记录 id 冲突」
PASS 14: [6] getTranscription：raw_text/uncertain_spans/model_version 逐字往返；不存在 ⇒ null
PASS 15: [7] updateTranscription：CAS + 核对落库（raw/spans 不动）；改写原始输出被拒且库内逐字不变（revision 不消耗）；软删走普通 CAS
PASS 16: [8] findIdempotent：未占位 null；占位后 request_hash/payload/pending/expires_at 如实；过期行仍可读到（不自带过期过滤）
PASS 17: [9] claimIdempotent：首次 claimed、同键 exists 且不覆盖；并发双 claim 恰好一次成功、行数恒 1；到期行由 purge 清理后可重新占位
PASS 18: [10] finalizeIdempotent：pending ⇒ false、payload 替换为最终引用；request_hash/expires_at 不动
PASS 19: [11] releaseIdempotent：占位被真正释放，同键可重新占位（不会留下永久 pending）
PASS 20: [12] purgeIdempotent：删除 1 行（返回行数）、未到期行保留、再跑一次不再删（0）
```

`[R]` 重启臂（含真·子进程重启）与 `[N]` 负控制（逐字）：

```
PASS 21: [R1] 写入完成；关闭前 2 个后端进程，pool.end() 之后残留 0（连接真的全关了）
PASS 22: [R2] 重启（关连接→新 Pool→新 store）：任务指纹 9902b8b4ef5f3d68… 与记录指纹 bee42de8e106cdaf… 与写入时逐字节相等
PASS 23: [R3] 新 app（real+新池）的语音读面读到重启前的任务与转写；他人读同一条记录仍 NOT_FOUND（归属不放宽）
  CHILD-PID=33420
  CHILD-JOB-FP=9902b8b4ef5f3d689a289ae3dec688729f0ab596a52e16c27794cf07324a29d3
  CHILD-RECORD-FP=bee42de8e106cdafe2ddaad08efa7f153504f290d2609e6ea6a3665d63ac609c
  CHILD-RESULT=PERSISTED（新进程、新连接池，按指纹逐字节相等）
PASS 24: [R4] 进程级重启臂：**新进程** + 新连接池按指纹逐字节相等 ⇒ exit 0（subprocess 原始输出见上）
PASS 25: [N1] byte_exact_restore：篡改 ⇒ 指纹变（红）；按原 jsonb 文本写回 ⇒ 指纹与 `::text` 双双重现（绿）
PASS 26: [N2] 负控制：同一序列在内存 store 上，新实例读不到任务与转写记录（改前"重启即丢"的缺陷本体，可复现）
PASS 27: [N3] 负控制：同一 revision 并发双写 ⇒ 恰好 1 次成功、库内 revision=2（若 CAS 退化为先查后写，本臂会出现 2 次成功）
PASS 28: [N4] 负控制：同 id 并发/重复写由主键裁决 ⇒ 行数恒为 1
PASS 29: [N5] 缺表三态（真库）：回滚后读三方法全 null、写入抛 SpeechTablesMissingError 点名 0026；缓存 ready 的旧实例遇 42P01 同样 fail-closed
PASS 30: [N5] 复原：REPLAY 0026 之后新 store 立即可写（fail-closed 不会永久锁死）
```

末几行原文（**逐字**；注意脚本在 `ALL PASS` 之后还会打印 5 条「未取得」，所以文件**最后一行不是**
`ALL PASS`）：

```
共 30 条 PASS，耗时 1881ms
ALL PASS：语音转写域 PostgreSQL 持久化（迁移 0026 三连 / 12 方法语义 / 关连接重开逐字节仍在 / 5 条负控制含缺表 fail-closed）
未取得 HTTP 面的"重启不丢"：real 模式真实 ASR 提供者/媒体端口未接线 ⇒ POST 语音受理前即 503，无法经 HTTP 建任务；本片证据在 store 层 + 迁移层 + app.speechService 读面
未取得 三张语音表的运行时授权：本片按派单**不改** `deploy/postgres-cvm/**`（不新增 GRANT）；运行时角色直连会 42501，授权属后续片，本脚本用库 owner 取证
未取得 多进程并发写同一任务的压测：本片只做两路并发 CAS 与两路并发 claim，未做 20+ 并发的吞吐/延迟读数
未取得 真实 ASR 模型输出落库：模型调用未接线；本片用契约合法的手工文本/区间验证持久化，不伪造识别准确率
未取得 备份恢复演练：本片只验证单库迁移 UP/ROLLBACK/REPLAY 与关连接重开，未做 pg_dump/pg_restore 演练
```

- **`EXITCODE=0`**，`PASS` 计数 **30**，耗时 1881ms
- 同一条命令在**未设** `SPEECH_PG_TEST_URL` 时（本机实跑，`--allow-skip` 未使用）：

```
SKIP real PG17: SPEECH_PG_TEST_URL 未设置 —— 本次运行没有验证真库持久化（不是通过，也不是失败）。
EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。
```

  **`EXITCODE=77`** ⇒ 这个 step 在 CI 上**缺库/漏传 env 一定是红的**，没有第二条出口。
- 原始输出落盘：`E:\GengYunCommander\.pg17\handoff\speech-pg-scram-r28s40.log`（真库臂 43 行）／
  `…\speech-pg-skip-r28s40.log`（缺 env 的 77 出口）

---

## 3 接线改动面

只动派单允许的四类文件，共 4 个：

| 文件 | 改动 |
| --- | --- |
| `.github/workflows/real-pg-integration.yml` | 末尾追加 1 个 step（`L156-169`：6 行注释 + `run:` + `env:` 6 个 `KEY: value`），既有 8 步一字未动（`+14/−0`） |
| `tests/unit/ci-real-pg-wiring.test.mjs` | `MANAGED_SCRIPTS`／`FROZEN_MANAGED_SCRIPTS` 各 **+1**（8 → 9，逐字同步）；`REQUIRED_STEP_ORDER` **+第 9 项＋4 行注释**；头注释补第 9 条来源；第 8 条注释里「排在最后（workflow 里也是最后一步）」订正为「R28-S40 之后它不再是最末一步」 |
| `tests/unit/ci-integration-chain-structure.test.mjs` | `speech-pg` 的 `UNWIRED_DECLARATIONS` **条目保留**，reason 改成真相（已接真库 job 的独立 step；仍不进无 PG 回环链），口径照 `ocr-jobs-pg` |
| `docs/verification/gy-r28-speech-ci-wire-20261021.md` | 本证据页 |

workflow 新增段原文：

```yaml
      # 语音转写域（#351 / R28-S40）：库名硬钉 `gengyun_speech_test`，脚本同样要求**空库**
      # （自己断言 `public` 下 0 张表），并用 `discoverMigrations()` 跑**全链迁移**（0001..0026，含本片的
      # 0026_speech_persistence.sql）；随后做 0026 的 UP／ROLLBACK／REPLAY ⇒ 顺带守住迁移清单不变量。
      # 连接串走 **env**（`SPEECH_PG_TEST_URL`）：未设时脚本打印 SKIP 并以 77 退出 ⇒ 缺库必红（77 不是通过）。
      # 位置排最后：它自建专用空库、自己 apply 迁移，不建组角色、也不复用别人的运行时角色 ⇒ 对前后无耦合。
      # 本地取证（PG 17.11 + scram + 空库）：exit=0，`共 30 条 PASS`（含关连接重开逐字节仍在 + 子进程重启臂）。
      - run: psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_speech_test' && node tests/integration/speech-pg.mjs
        env:
          PGHOST: 127.0.0.1
          PGPORT: '5432'
          PGUSER: gengyun_ci_owner
          PGPASSWORD: synthetic-ci-owner-only
          PGDATABASE: gengyun_ci_bootstrap
          SPEECH_PG_TEST_URL: postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:5432/gengyun_speech_test
```

两处形态选择的理由（有事实支撑，不是偏好）：

1. **连接串走 `env:` 而不是 argv。** `speech-pg.mjs` 的契约**只读环境变量**（`:48/:54`），写 argv 它不认；
   这与 `ocr-jobs-pg` 同构，也与 `conversations/community/favorites-history` 三步的「`psql … && node <脚本>`
   不带 URL」同形，只是多一行 `SPEECH_PG_TEST_URL`。
2. **`run:` 用单行 `cmd && cmd` 而不是 `run: |` 多行。** 既有 8 步全是单行（`&&` 保证 `CREATE DATABASE`
   失败时不再跑 node）；`runCommandTextsOf()` 对 `run: |` 块体另有口径（块内 `#` 行按 shell 注释剔除），
   单行形态与其余 8 步一致，守卫口径无需任何放宽。

---

## 4 负控制（两条，都「由绿变红」，还原后 sha256 逐字节相等）

变异前的基线：

| 文件 | sha256（变异前 = 还原后） |
| --- | --- |
| `.github/workflows/real-pg-integration.yml` | `00EFB16BE3922089A490ABFF5AD35E2FC7DDB867B8193483520EB2B9FABDDA8C` |

恢复手段：变异前 `Copy-Item` 备份到 `E:\GengYunCommander\.pg17\handoff\r28s40-real-pg-integration.yml.bak`，
恢复时 `Copy-Item` 覆盖回来，再用 `Get-FileHash -Algorithm SHA256` 与基线逐字节比对，并用
`git status --porcelain` 确认工作树只剩预期的 3 个修改。

### 负控制 ①：删掉新增 step（`MANAGED_SCRIPTS` 仍含 `speech-pg.mjs`）

变异：把新增的整段（6 行注释 + `run:` + `env:`）删掉 ⇒ workflow 文本回到 base（`git diff` 该文件
**0 行**）⇒ 意图是「脚本还在受管清单里，但没有任何 step 真跑它」。

`node --test --test-concurrency=1 tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs`
⇒ **`EXITCODE=1`**，`ℹ tests 23 / ℹ pass 15 / ℹ fail 8`。第一条红的原文：

```
✖ 前向①：两个受管真库脚本都被某个 workflow 的 `run:` 真跑 (14.2789ms)
  AssertionError [ERR_ASSERTION]: 有受管真库脚本既没有被任何 workflow 的 `run:` 执行，也没有对应的真库臂——
  这类脚本坏了 CI 也不会红（「脚本在 main、但没人跑」的静默缺口）：
    · tests/integration/speech-pg.mjs

  改法：在 `.github/workflows/real-pg-integration.yml`（或另一个带 `services.postgres` 的 workflow）里加一步
  `node <脚本>`，不要只写在注释里、也不要只写裸文件名。
  + actual - expected

  + [
  +   'tests/integration/speech-pg.mjs'
  + ]
  - []

      at assertManagedScriptsWired (file:///E:/GengYunCommander/wt-r28-s40/tests/unit/ci-real-pg-wiring.test.mjs:566:10)
      at TestContext.<anonymous> (file:///E:/GengYunCommander/wt-r28-s40/tests/unit/ci-real-pg-wiring.test.mjs:849:3)
```

另外 7 条红都是同一次变异的**级联**（如实登记，不是独立缺陷）：`反向控制①`／`反向控制①b`／`反向控制⑦`
断言「删掉 A 的 run 行后必须**只**点名 A」，而此刻 speech 也缺线，actual 变成 `[A, speech]`；
`前向⑤`（顺序判据失去对象）、`前向⑥`（找不到 speech 的 step）、`前向⑦`（workflow 跑了、清单里没有）、
`反向控制⑧`（同上的顺序/库名/双向相等三连的前提）。还原后全绿（见下）。

还原校验：

```
restored sha256: 00EFB16BE3922089A490ABFF5AD35E2FC7DDB867B8193483520EB2B9FABDDA8C
RERUN_EXITCODE=0
ℹ tests 23 / ℹ pass 23 / ℹ fail 0
status lines: 3（= 本片应改的 3 个文件，见 §3）
```

### 负控制 ②：把 step 的 `CREATE DATABASE` 库名改成 `gengyun_speech_test_typo`

变异：只把新增 step 里的库名改错（脚本仍连 `gengyun_speech_test`）⇒ 意图是「建错库/改库名时判据⑧要红」。

`node --test --test-concurrency=1 …`（同上两文件）⇒ **`EXITCODE=1`**，
`ℹ tests 23 / ℹ pass 21 / ℹ fail 2`。红的原文：

```
✖ 前向⑥（判据⑦＋⑧）：每个受管脚本所在 step 先 CREATE DATABASE 再 node，且库名与该 step 传入的一致 (6.8563ms)
  AssertionError [ERR_ASSERTION]: `.github/workflows/real-pg-integration.yml` 的「先建库＋库名一致」判据不通过：
    · job `real-pg-17-11`：`CREATE DATABASE gengyun_speech_test_typo` 与传给 `tests/integration/speech-pg.mjs` 的库名 `gengyun_speech_test` 不一致
```

（另一条红是 `反向控制⑧`——它开头先断言磁盘真值三条判据全绿，属级联。）
还原后 sha256 回到
`00EFB16BE3922089A490ABFF5AD35E2FC7DDB867B8193483520EB2B9FABDDA8C`，复跑 `23/23` 全绿。

---

## 5 门禁读数（本片收尾时实跑，全部 `EXITCODE=0`）

| 门禁 | 命令 | `EXITCODE` | 尾部原文 |
| --- | --- | --- | --- |
| 静态 | `npm run lint` | **0** | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）` / `lint 通过（静态检查；不代表运行期或真实服务已通过）。` |
| 发布材料 | `node tools/verify-release-materials.mjs` | **0** | `PASS migrate.ts 命令闭集为 up\|status\|list — migrate.ts 含封闭命令集报错` / `15/15 项通过（离线文档核验；不代表部署、云端或运行期已验收）` |
| 文档 | `npm run test:docs` | **0** | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住` / `PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住` |
| 契约状态 | `node tools/verify-contract-status.mjs` | **0** | `PASS: 中文表格一致` / `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。`（另有 1 行既有 `WARN: 无锚点可疑引用前 5/268 条…`，**base 上同样存在**，只计数不判红） |
| 契约单测 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | **0** | `ℹ tests 6 / ℹ pass 6 / ℹ fail 0` |
| 两个守卫（本片核心） | `node --test --test-concurrency=1 tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` | **0** | `ℹ tests 23 / ℹ pass 23 / ℹ fail 0` |
| 空白/冲突标记 | `git diff --check` | **0** | （无输出） |

---

## 6 我没做到的取证（如实登记）

- **没有**在 GitHub Actions 上实跑：本片⛔ 不 push、不开 PR，也没有 CI 凭据 ⇒ 这个 step 的「CI 侧第一次
  真红/真绿」要等 PR 运行。本页给的是**本机 scram 等价集群**上的等价读数（用户/口令/库名/库前提/连接串
  形态与 workflow 逐字一致），以及缺 env 时 77 的实测出口。
- **没有**独立验证 `postgres:17.11` 镜像的权限面（例如 `POSTGRES_USER` 在镜像里是超级用户、`pgcrypto` 是
  可信扩展因而非超级用户属主也能 `CREATE EXTENSION`）：这两点沿用既有 8 步已验的前提，本步**不引入任何
  新角色/新迁移**，因此没有新增该类风险。
- **没有**跑 `npm run test:integration:http` 这条无 PG 回环链（本步不进那条链，`UNWIRED_DECLARATIONS` 的
  reason 已如实写明），改动不触及那里的任何断言。
- **没有**量 10 个 `- run:` 串行后的总墙钟时间：本步本身实测 1881ms，job 的 `timeout-minutes: 15` 未见紧张，
  但整 job 的总耗时本片未测。
- **派单事实偏差（如实记录）**：派单 §1 说 base 的头注释已有「第 9 条讲 R28-S39（账号停用）」——实测 base
  `32ce461` 的 `ci-real-pg-wiring.test.mjs` 只到第 8 条（OCR），`MANAGED_SCRIPTS`／`FROZEN_MANAGED_SCRIPTS`
  各 8 条、`REQUIRED_STEP_ORDER` 8 项，**没有**第 9 条（`#353` 仍 OPEN）。故本片把 speech 追加为第 9 条，
  并顺带订正第 8 条注释里「排在最后（workflow 里也是最后一步）」这句已随本片失实的话（只改注释措辞，
  不动任何断言）。

---

## 7 复现命令（本机）

```powershell
# 1) 起一个 scram 集群（:55650，datadir 独立）
$bin = 'E:\GengYunCommander\.pg17\pgsql\bin'
Set-Content -Path E:\GengYunCommander\.pg17\tmp-r28s40-pw.txt -Value 'synthetic-ci-owner-only' -NoNewline -Encoding ascii
& "$bin\initdb.exe" -D E:\GengYunCommander\.pg17\data-r28s40 -U gengyun_ci_owner --auth=scram-sha-256 --pwfile=E:\GengYunCommander\.pg17\tmp-r28s40-pw.txt -E UTF8 --locale=C
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"E:\GengYunCommander\.pg17\pgsql\bin\postgres.exe" -D "E:\GengYunCommander\.pg17\data-r28s40" -p 55650 -c listen_addresses=127.0.0.1 -c logging_collector=on' }

# 2) 建空库 + 真跑（与 workflow step 同形：先 CREATE DATABASE 再 node）
$env:PGPASSWORD='synthetic-ci-owner-only'
& "$bin\psql.exe" -w -h 127.0.0.1 -p 55650 -U gengyun_ci_owner -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_speech_test'
$env:PGHOST='127.0.0.1'; $env:PGPORT='55650'; $env:PGUSER='gengyun_ci_owner'; $env:PGDATABASE='gengyun_ci_bootstrap'
$env:SPEECH_PG_TEST_URL='postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:55650/gengyun_speech_test'
node tests/integration/speech-pg.mjs   # ⇒ 共 30 条 PASS / ALL PASS / exit 0

# 3) 两个守卫 + 七项门禁
node --test --test-concurrency=1 tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs
npm run lint; node tools/verify-release-materials.mjs; npm run test:docs
node tools/verify-contract-status.mjs; node --test --test-concurrency=1 "tests/contract/*.test.mjs"
git diff --check

# 4) 收尾停集群
& "$bin\pg_ctl.exe" -D E:\GengYunCommander\.pg17\data-r28s40 -m fast stop
```
