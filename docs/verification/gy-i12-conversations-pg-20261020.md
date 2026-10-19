# GY-I12（#12）会话链 · 真实 PostgreSQL 17.11 证据（2026-10-20）

- 工作树 `E:\GengYunCommander\.pg17\wt-conv-pg`，分支 `test/gy-conversations-pg`，基线 `upstream/main = 607c03c`。
- 本页只记录**本机实跑读数**；未跑的一律在「未取得」里点名，不得读成通过。
- 本片只做证据面：新增 `tests/integration/conversations-pg.mjs`（真库端到端）、
  在 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS` 登记一条、
  在 `package.json` 新增独立真库臂脚本 `test:integration:conversations-pg`，外加本页。
  **产品代码、迁移编号、既有断言一字未改**（唯一的非证据改动就是这条 npm 脚本；
  `test:integration:http` 链与 `FROZEN_CHAIN` 未动）。
- 一句话结论：**「引用只能取自本次检索集合」在真实 PG 17.11 上成立**，且成立的每一环都是产品代码
  —— 真读面视图 → 真检索端口 → 真守卫 → 真 PG store。`buildApp({ config, pool })` 不传 `store`、
  不传 `conversationInjection`（唯一的例外是第 5 节 [W] 的写穿反向控制，只替换 composer 一个字段）。

## 1 真库环境

| 项 | 值 |
| --- | --- |
| 二进制 | 便携 PostgreSQL **17.11**（`E:\GengYunCommander\.pg17\pgsql\bin`） |
| 初始化 | `initdb -D <datadir> -U postgres -A trust -E UTF8 --locale=C` |
| 监听 | 仅回环 `127.0.0.1:55540`（本机临时集群，不动任何既有实例） |
| 库名 | 硬钉 `gengyun_conversations_test`，**要求空库**（`pg_tables` where `schemaname='public'` 计数必须 0） |
| 收工 | `pg_ctl -m fast stop`，删临时数据目录 |

脚本自己的前置断言把上述三条（协议 / 无查询参数 / 回环 / 库名）都钉死；连错库或连非空库会当场红
（非空库实测 `exit=1`，报「要求空库（防误连到有数据的库）」）。

## 2 迁移子集是 7 条，不是派单写的 6 条

派单给的子集是 `0001/0002/0005/0008/0010/0013`，**缺 `0012` 会直接 500**：

- `services/api/db/migrations/0010_knowledge_read_views.sql:3-31` 建的
  `catalog_read.current_knowledge` 列清单里**没有** `created_at`；
- `services/api/db/migrations/0012_knowledge_created_at.sql:39`
  `ALTER TABLE public.knowledge_versions ADD COLUMN IF NOT EXISTS created_at timestamptz;`，
  并在 `:87` `CREATE OR REPLACE VIEW catalog_read.current_knowledge`（列清单末尾追加 `k.created_at`）；
- 读面 SQL `services/api/src/knowledge/service.ts:76`
  `SELECT * FROM catalog_read.current_knowledge ORDER BY created_at DESC, id DESC`
  ⇒ 缺 0012 必然 `42703 column "created_at" does not exist`。

因此脚本用 `MIGRATION_VERSIONS = ['0001','0002','0005','0008','0010','0012','0013']`。这不是"顺手多跑"：
仓库内所有真读面用例都带 0012（`tests/integration/profile-ui-fixture.mjs:15`、
`tests/unit/knowledge-api.test.mjs:16`、`tests/unit/local-profile-bootstrap.test.mjs:20`、
`tests/unit/knowledge-order-created-at.test.mjs:45`）。**多带的 0012 已登记为偏差，见第 7 节。**

## 3 播种夹具的两条硬约束（本片的关键发现）

### 3.1 `public.sources.id` 必须等于 `knowledge_versions.knowledge_id`

- 读面投影 `services/api/src/knowledge/service.ts:98-106` 把条目 `id` 取视图 `id`（= `k.knowledge_id`）、
  把 `source.id` 取视图 `source_id`（= `s.id`）。
- 检索端口 `services/api/src/conversations/retrieval.ts:210-213` 逐条断言
  `if (ref.id !== id) throw new ApiError('PROVIDER_UNAVAILABLE', '检索集合条目 … 的来源 id 与条目 id 不一致', { retryable:false })`。

⇒ 只要 `sources.id ≠ knowledge_id`，真实检索端口必抛 503，整条链一条也跑不通。
**`tests/integration/catalog-pg.mjs` 的 `sid ≠ knowledge_id` 播种范式在会话域不可照抄**（目录片不需要这个等式，
会话片需要）。本脚本的 `seedSource()` 就是按这个等式播的。

### 3.2 `source_versions.reviewed_by` 的 FK 指向 `admin_accounts`，不是 `users`

- `services/api/db/migrations/0001_initial_schema.sql:154` `reviewed_by uuid REFERENCES admin_accounts (id)`。
- 首次实跑现场（原文，已修夹具）：
  `error: insert or update on table "source_versions" violates foreign key constraint "source_versions_reviewed_by_fkey"`
  / `detail: Key (reviewed_by)=(…) is not present in table "admin_accounts".`

⇒ 夹具必须自己插一行"核对主体"管理员（只给 `id/login_name/credential_hash`，不授予任何后台会话）。

另外两条夹具事实（不是猜的）：

- 读面视图 JOIN `knowledge_dataset_modes` / `knowledge_dataset_config` 两表，而 `0002` **只建表不插值**
  （种子在 `services/api/db/seeds/seed_reference.sql:5-11`）⇒ 测试必须自己把 `real` 模式与
  `active_mode`/`database_connected` 两行插上，否则读面恒空。
- 视图准入即产品判据（`0005_catalog_read_views.sql:6-21`）：`validity='valid'` +
  `review_status='verified'` + `reviewed_by/reviewed_at` 非空 + 有效期覆盖 `now()` + `s.current_version_id = sv.id`。
  夹具里 `rejected`（`review_status='rejected'`）与 `expired`（`validity='expired'`）两条就是**故意播成"若视图不设防就会进来"**的。

## 4 真库实跑读数（12 条，原文）

```text
Real PostgreSQL server_version: 17.11
PASS [M] 真库 17.11：迁移子集 0001/0002/0005/0008/0010/0012/0013 按序应用，二连跑 applied=[]（含 0012 的 created_at 列）
PASS [A] 读面准入：published+verified+valid 的 1 行进视图；rejected 与 expired 两行 0 行可见
PASS [G] 真装配：buildApp({config,pool}) 无注入 ⇒ conversationService 非空、store.persistent=true、检索/守卫均为真实实现
PASS [S0] 真检索端口：同一会话读到与 /knowledge 逐字相同的一条（引用 ⊆ 本次检索集合的前置条件成立）
PASS [S] 正常子集：202 → answered/passed；引用逐字等于检索集合条目；轮次 1 行 + 回答 1 行落库，作业读面同源
PASS [R] 重启读回：同 pool 另起 app 实例，轮次/回答/会话 revision 全部仍可读（读路径不依赖进程内台账）
PASS [F1] 越界/被拒/过期/不存在的来源 id：守卫 blocked、零引用、逐条 not_in_retrieval_set（反向控制一）
PASS [F2] 同 id 改写标题 ⇒ source_mismatch；非 https 来源 ⇒ source_not_representable（反向控制二）
PASS [W] 写穿反向控制：模型输出被拒/过期来源的引用 ⇒ 回答 blocked、check_state=blocked、落库 citations=[]（越界引用从不进回答表）
PASS [E] 空集合：真端口 items=[]、端到端 insufficient/passed/零引用；no_retrieval_set 仅 set===null，空集合引用越界为 blocked（真装配下二者互斥）
PASS [N] 问题侧筛查：注入话术整轮 blocked/blocked、零引用、固定话术（不回显原文）
PASS [P] 不变量：4 行回答（answered×1 / blocked×2 / insufficient×1）；落库引用 id 恒为 ca5e7709-affc-404d-89ef-d34aaaea73c2，被拒/过期 id 0 次出现

conversations-pg：12 条读数全部通过（真 PostgreSQL 17.11）
```

读数逐条对应派单 §2 的六条要求：

| 派单要求 | 落点 | 实际读数 |
| --- | --- | --- |
| ① 越界/未命中 ⇒ `blocked` 或该条不进 `citations` | [F1] | `status/check_state = blocked`，`citations = []`，`not_in_retrieval_set:<id>` 三条逐条留痕 |
| ② `review_status='rejected'` 的 source 行不得进 `citations` | [A] + [F1] + [P] | 视图层 0 行；守卫层 `not_in_retrieval_set`；DB 层该 id 0 次出现 |
| ③ 知识集合清空后 `blocked` + `no_retrieval_set` | [E] | **如实不符**：清空后是 `insufficient/passed`（详见第 7 节偏差 B） |
| ④ 正常子集：引用 ⊆ 检索集合 + 轮次落库 + 重启可读 | [S0]/[S]/[R] | 引用十键逐字相等；回答 1 行 + 轮次 1 行；重启后逐字读回 |
| ⑤ 越界条目即使被模型输出，也不得写进 `conversation_answers.citations` | [W] + [P] | 替身 composer 真输出两条越界引用 ⇒ HTTP `blocked`、DB `citations=[]`；全库引用 id 并集恰为本集合那一条 |
| ⑥ 迁移二连跑第二次 `applied.length === 0` | [M] | `applied=[]`，`schema_migrations` 恰好 7 行 |

## 5 [W] 为什么有一个 composer 替身

派单第 5 条要求证明"**即使模型输出越界条目**也不落库"。确定性 composer
（`services/api/src/conversations/service.ts:createDeterministicAnswerComposer`）只会引用本次集合内的条目，
所以真链路上根本出现不了"越界引用"这种候选 —— 那这条要求就只能靠**只替换 composer** 的替身来造。

- 注入按字段回退装配：`services/api/src/app.ts:1475-1531` 的 `conversationInjection?.composer ?? createDeterministicAnswerComposer()`，
  因此只换 composer 时，store（PG）/ 检索端口 / 守卫 / 筛查**全部仍是产品实现**（脚本里也断言了
  `store.persistent === true`）。
- 该回答最终 `blocked` 且 `citations=[]`，`conversation_turns.job_state='succeeded'`
  （阻断是终态回答，不是失败），落库 `conversation_answers.citations` 为 `[]`。
- 主链（[M]/[A]/[S0]/[S]/[R]/[F1]/[F2]/[E]/[N]/[P]）**一条注入都没有**，与派单"不传 store / 不传
  conversationInjection"一致；替身只出现在这条明确标注的反向控制里，且它的存在正是为了不伪造"模型会守规矩"。

## 6 门禁逐条读数（本工作树 HEAD 上实跑）

| # | 门禁 | 命令 | 读数 |
| --- | --- | --- | --- |
| 1 | 单测全量 | `node --test "tests/unit/*.test.mjs"` | `tests 1807 / pass 1806 / fail 0 / skipped 1`，退出码 0（约 66 s） |
| 2 | 本片真库 | `$env:CONVERSATIONS_PG_TEST_URL=…; node tests/integration/conversations-pg.mjs` | 12 条 PASS，退出码 0（PG 17.11 / 端口 55540 / 空库） |
| 2′ | 本片真库（npm 脚本） | `$env:CONVERSATIONS_PG_TEST_URL=…; npm run test:integration:conversations-pg` | 12 条 PASS，退出码 0（同一脚本；`package.json` 里该脚本不带任何 flag） |
| 3 | HTTP 回环链 | `npm run test:integration:http` | 13 条脚本全绿，退出码 0（末段：`PASS 6 groups; loopback only, stub substitute ASR, no database, no external network`） |
| 4 | 类型 | `npx tsc -p services/api/tsconfig.json --noEmit` | 退出码 0，无输出 |
| 5 | 契约状态 | `node tools/verify-contract-status.mjs` | `PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；形状错误 0 项；语义错误 0 项` |
| 5′ | 契约状态（运行期） | `node tools/verify-contract-status.mjs --runtime` | 同上 + `PASS: 无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致` |
| 6 | 开发文档 | `python -B tools/validate_development_docs.py` | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| 7 | 发布材料 | `node tools/verify-release-materials.mjs` | `15/15 项通过（离线文档核验；不代表部署、云端或运行期已验收）` |
| 8 | 空白/冲突标记 | `git diff --check` | 无输出，退出码 0 |

真库臂由**独立 npm 脚本** `test:integration:conversations-pg`（值为 `node tests/integration/conversations-pg.mjs`）
承载，不进 `test:integration:http` 链：该链成员必须严格是 `node <路径>`
（`tests/unit/ci-integration-chain-structure.test.mjs:185-203`，不允许带 flag），而真库前置
（PG 17.11 + 空库 + 连接串）不该拖垮无库回环链。同一脚本的两种出口都在 HEAD 上实测过：

- 带 `CONVERSATIONS_PG_TEST_URL` 跑 `npm run test:integration:conversations-pg` ⇒ 12 条 PASS，`exit=0`；
- 不设该变量 ⇒ 打印 `SKIP real PG17: …` 与 `EXITCODE=77`，`exit=77`（「未取得」，不是通过）。

结构门禁单跑（`node --test "tests/unit/ci-integration-chain-structure.test.mjs"`）：`tests 7 / pass 7 / fail 0`，
其中断言 4（未接线必须显式声明）与断言 5（白名单不得腐烂）都覆盖了新增的这一条。

跳过分支的两种出口也逐一实跑过：不设 `CONVERSATIONS_PG_TEST_URL` ⇒ 打印
`SKIP real PG17: …` 并 `EXITCODE=77`（`exit=77`）；加 `--allow-skip` ⇒ `EXITCODE=0`（`exit=0`）。
**77 是"未取得"，不是通过**（见偏差 A）。

## 7 与派单的三条偏差（如实登记）

### A 跳过出口是 77，不是 0

派单原文要求"未设 `CONVERSATIONS_PG_TEST_URL` ⇒ 打印 SKIP 且 exit 0"，并注明
`favorites-history-pg.mjs` 实际用 77。但仓内有一条**逐文件扫描**的硬守卫：
`tests/unit/integration-script-coverage.test.mjs:274-347`（`wholeChainSkipWithout77`）对
`tests/integration/*.mjs` 里所有 `console.log/error('…SKIP…')` 的分支要求附近必须有 77 出口，
否则判"假绿"并点名文件；它还有反空转断言（至少扫到 3 个有 SKIP 分支的脚本）。
本片第一版按派单写 `process.exit(0)`，该守卫当场红并点名 `tests/integration/conversations-pg.mjs`。

两条要求互斥，且派单同时写着"⛔ 不放宽断言"⇒ 按**仓内既有约定**落地：默认 77，`--allow-skip`／
`GY_ALLOW_SKIP=1` 显式取 0（与 `favorites-history-pg.mjs:40-54` 同形）。这条偏差是"不放宽断言"的必然结果，
不是绕过门禁：真跑通过仍 0，真失败仍非 0。父代理同日已把该口径正式裁定为统一约定
（`.pg17/ruling-skip-exit-code-20261020.md`：缺 env 一律 77、真库臂用独立 npm 脚本承载），本片按裁定落地。

### B 空集合读到的是 `insufficient`，不是 `blocked` + `no_retrieval_set`

派单第 3 条要求"知识集合清空后必须 `blocked` 且 `rejected_citations` 含 `no_retrieval_set`"。产品实际契约是两段口径，
且**两段在真装配下互斥**：

- `services/api/src/conversations/guard.ts:257-261`：`set === null`（检索端口未接线/读不到）时，
  若候选带引用才 push `no_retrieval_set`，并返回 **`insufficient` / `passed`**（不是 blocked）。
- `services/api/src/conversations/retrieval.ts:267-300`：真装配的 `read()` **恒返回对象**（空集合是 `{items: []}`，
  不是 `null`）⇒ 真链路上 `set` 永不为 `null`，所以端到端**不可能**出现同时含 `blocked` 与 `no_retrieval_set` 的回答。
- 真链路上的清空后读数：确定性 composer 面对空集合产出 `{text:'', citations:[], dose_cards:[]}`，
  守卫走"无引用无卡"分支 ⇒ `insufficient` / `passed` / 零引用（这正是"没有依据就不给结论"的正确形态）。

因此本脚本不伪造 `blocked`，而是把两条机制**分别钉住**：[E] 端到端如实 `insufficient`；
`set===null` 的守卫单点读数给 `insufficient` + `['no_retrieval_set']`；
空集合 + 越界引用的守卫单点读数给 `blocked` + `not_in_retrieval_set:<id>`。
"`no_retrieval_set` 这条拒绝原因存在且可复现"与"清空集合 ⇒ 不再给引用"两件事都取证了，
只是它们不在同一条路径上。**派单第 3 条按字面不可满足，属派单假设与产品契约不符**，此处如实上报。

### C 迁移子集多带 0012

见第 2 节。派单列的 6 条里不含 0012，但它由读面 SQL 的排序键强制依赖；不带则整条链在建视图之后
第一个读面请求就 500。按"证据必须能跑通"优先，带 0012 并在此登记。

## 8 未取得（不得读成通过）

- **未取得** 真模型/真检索供应商读数：本片用的是产品自带的确定性 composer 与确定性剂量权威，
  回答文案与引用选择都是规则产物；"真实模型会不会输出越界引用"这件事由 [W] 的替身**模拟**，不是实测。
- **未取得** CI 接线：本片没有新增/修改任何 workflow，真库脚本只在本机隔离集群跑过；
  这也是它按仓内规则登记进 `UNWIRED_DECLARATIONS` 的原因（不冒充 CI 绿）。
- **未取得** 生产数据规模：夹具只有 3 条来源（1 条可读），没有做 50 条上限、翻页、万行级压力的读数。
- **未取得** 客户端/微信真机：只覆盖后端 HTTP 契约；小程序端与前端渲染未改也未跑。
- **未取得** 会话链其它域的联合读数：导出、删除、语音转写（transcription/cascade）在本片仍是
  未接线端口（`createUnwiredTurnCascadePort()`），本页不对它们作任何声称。
- **未取得** `conversations`/`conversation_turns`/`conversation_answers` 的并发争用读数：
  本片是单请求串行（202 → `drain()` → 读回），没有做同一轮次的并发 `claimTurnJob` 竞争。

## 9 复跑步骤（本机）

```powershell
$PG = 'E:\GengYunCommander\.pg17\pgsql\bin'
& "$PG\initdb.exe" -D E:\GengYunCommander\.pg17\tmp-conv-pg-55540 -U postgres -A trust -E UTF8 --locale=C
& "$PG\pg_ctl.exe" start -D E:\GengYunCommander\.pg17\tmp-conv-pg-55540 -o "-p 55540 -h 127.0.0.1" -l <datadir>\server.log -w
& "$PG\createdb.exe" -h 127.0.0.1 -p 55540 -U postgres gengyun_conversations_test
$env:CONVERSATIONS_PG_TEST_URL = 'postgres://postgres@127.0.0.1:55540/gengyun_conversations_test'
node tests/integration/conversations-pg.mjs
& "$PG\pg_ctl.exe" stop -D E:\GengYunCommander\.pg17\tmp-conv-pg-55540 -m fast
```

注意：脚本要求**空库**（第二次跑同一库会红在"要求空库"），重跑前 `dropdb`/`createdb`。
