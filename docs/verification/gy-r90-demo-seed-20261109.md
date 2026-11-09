# 演示资料种子：让本机首页有卡片（R90，2026-11-09）

> 读数快照：2026-11-09（Asia/Hong_Kong）。基线 `origin/main` `7e3ac403`；因为要用 `tools/demo-stack.mjs`，分支从 open PR #1150 的 head `62fdce10`（`origin/feat/gy-demo-stack`）起，PR 基分支也指它而不是 `main`——依赖关系写在 PR 描述里。
> 改动面：`db/seeds/demo_catalog_verified.sql`（新）、`tools/demo-stack.mjs`（`--seed-demo` 接线与文案）、`tools/lib/demo-stack.mjs`（参数、用法、下一步文案）、`tests/unit/demo-stack.test.mjs`（+2 用例）、`tests/unit/demo-stack-cli.test.mjs`（+2 断言）、`tests/unit/demo-seed-sql.test.mjs`（新，7 用例）、`docs/demo/本地演示-stack.md`（§7 重写）、本页（新）。
> 产品代码零改动：`services/api/src/**` 一行没动。首页读的表、JOIN、过滤条件全部是既有实现，本轮只补它缺的**资料**。

## 一、问题：首页 200 但列表空，不是栈故障

`real` 模式下 `GET /api/v1/public/home` 返回 200、`previews: []`。原因不在路由，也不在栈：首页读的视图 `catalog_read.home_species` 在真库里是 **0 行**。

该视图（迁移文件 `services/api/db/migrations/0005_catalog_read_views.sql` 里定义）要同时满足四件事才出一行：

1. 知识是 `type = 'species'`、`visibility = 'published'`，且是该 `knowledge_id` 的最大 `revision`；
2. 它的来源版本 `review_status = 'verified'`、`reviewed_by` 与 `reviewed_at` 非空、`validity = 'valid'`，且 `valid_from` 已到、`valid_to` 未过；
3. 该来源版本就是所属 `sources.current_version_id`；
4. 数据集配置 `active_mode = 'real'`（`value` 与 `mode` 两列都要）且 `database_connected = 'true'`。

仓库里现有的两个种子（`db/seeds/seed_reference.sql`、`db/seeds/seed_zhejiang_materials.sql`）把来源版本全部写成 `unverified`，`knowledge_dataset_config` 也停在 `stub`/`false`。**这是对的**：开发侧不是法定审核责任人，不能自己给自己发 `verified`。所以裸 `up` 之后列表空是**资料缺项**，不是把栈修好就能变出来的。

## 二、交付物

| 文件 | 职责 |
| --- | --- |
| `db/seeds/demo_catalog_verified.sql` | 演示资料种子本身：一个演示侧占位「审核账号」、一个 `verified_seed` 来源与版本、把数据集配置切到 `real`、8 条物种知识（正文由 `public.species` 行拼出） |
| `tools/demo-stack.mjs` | `--seed-demo` 才多跑这一份；输出 `✓ 已灌演示资料（非生产数据）：…`；`stub` 模式跳过；已灌过就跳过 |
| `tools/lib/demo-stack.mjs` | `parseArgs` 的 `seedDemo` 开关（默认 `false`）、用法文案、`nextStepsLines` 的第 4 条改口径 |
| `tests/unit/demo-seed-sql.test.mjs` | 静态守卫：只写 5 张表、可执行部分无 `DELETE`/`DROP`/`TRUNCATE`、每条 `INSERT` 都带 `ON CONFLICT`、8 个 `species_id` 都真的在 `seed_reference.sql` 里、来源地址落在 `.invalid` |
| `docs/demo/本地演示-stack.md` | §7 从「首页为什么是空的」扩成「为什么空 / 怎么灌 / 怎么核 / 怎么撤」 |

## 三、这份种子怎么做到「可审查」，而不是「造假蒙闸门」

| 字段 | 取值 | 为什么这样写 |
| --- | --- | --- |
| `sources.source_kind` | `verified_seed` | `real` 模式只接受 `database` / `verified_seed`（`preset_demo` 才会接受模拟数据）；这里如实标成「种子」类别，不冒充 `database` |
| `sources.title` | `【演示】耕云本机演示资料种子（非生产数据，不代表第三方审核）` | 打开 `sources` 表就能一眼看出这是演示件 |
| `sources.canonical_url` | `https://example.invalid/gengyun/demo-seed-not-for-production` | `.invalid` 是 RFC 2606 保留域名，解析不了；**不**放任何真实公告链接来冒充出处 |
| `source_versions.review_status` | `verified` | 这是视图的硬条件。它是**演示侧的自我标注**，不是第三方结论——所以才要把上面三行写得那么显眼 |
| `source_versions.reviewed_by` | 占位账号 `demo-seed-placeholder（演示占位，非真人）` | `review_status <> 'unverified'` 时表约束要求 `reviewed_by`/`reviewed_at` 非空，只能落到一行 `admin_accounts` 上；这行的 `credential_hash` 是不可用占位串（`!demo-seed-placeholder-not-a-credential`），**登不进来**，`login_name` 里也写明「非真人」 |
| `knowledge_versions.body` | `【演示资料·非生产数据】<中文名>（学名 …）；别名：…。本条为演示用占位说明，用于展示「资料卡 → 检索 → 带引用回答」的链路；不含识别结论、防治建议与用药指引，也不代表任何第三方审核。` | 卡片正文里就带标记，截图流传出去也不会被当成真资料；文字**只**来自 `seed_reference.sql` 已有的物种行（中文名/学名/别名），没有新增任何农艺结论。2026-11-09 GY-R92 起改了措辞：旧版把 `db/seeds/*.sql` 路径与派生过程写进正文，演示时会被当知识正文念给观众听；句尾两段声明与「文字只来自 species 行」不变 |
| `knowledge_versions.visibility` / `type` | `published` / `species` | 视图要求；`species_ids` 用 `jsonb_build_array(s.id)` 指回参考行，能顺着查回原表 |

8 条映射是**写死的** `knowledge_id ↔ species_id`（稗、狗尾草、荨麻属、马唐属、牛筋草、看麦娘、藜、空心莲子草），不是全表扫：谁上了首页，看文件就能数出来。

## 四、幂等怎么保证

三层，缺一层都会在复跑时露馅：

1. **行级**：5 条 `INSERT` 全部带 `ON CONFLICT`（`admin_accounts` 是 `DO NOTHING`，其余 `DO UPDATE`），`knowledge_versions` 用 `(knowledge_id, revision)` 唯一键。
2. **版本级**：`sources.current_version_id` 只在真的不等于目标版本时才写，并伴随 `revision + 1` —— 复跑不会把 `revision` 越推越高。
3. **不覆盖时间戳**：`ON CONFLICT DO UPDATE` 的列清单里没有 `created_at`，复跑不改首见时间。

另加一条**失败要响**：文件末尾的 `DO $$ … $$` 自检查 `catalog_read.home_species` 的行数，为 0 就 `RAISE EXCEPTION`。防的是「`public.species` 没导入 ⇒ `INSERT … SELECT` 静默插 0 行 ⇒ 首页还是空，但工具说成功了」。

实测（真库，PG 17.11，端口 55510）：

```text
第一次：BEGIN; INSERT 0 1 ×5; UPDATE 1; INSERT 0 8; COMMIT;  exit 0
第二次：BEGIN; INSERT 0 0; INSERT 0 1 ×4; UPDATE 0; INSERT 0 8; COMMIT;  exit 0
```

复跑前后逐字比对：`knowledge_versions.created_at` 不变；`sources.revision` 停在 `2`；`home_species` 仍是 `8`；`current_verified_sources` 仍是 `1`。

工具层的幂等另有一条：`state.json` 里记 `demo:gengyun`，第二次 `up --seed-demo` 打印「✓ 演示资料已灌过（state 记录 demo:gengyun），跳过；要重灌用 `up --reset`」，不再跑 psql。

## 五、实跑（原文摘录）

环境：Windows + PowerShell 5.1、node `v24.16.0`、PG 17.11（`E:\GengYunCommander\.pg17\pgsql\bin`）、端口 API 38110 / PG 55510、env 文件 `E:\GengYunPrivate\demo-real.env`（6 个外部键，值不打印）。完整日志在 `E:\GengYunCommander\.pg17\demo-stack-logs\run-20261109-seed-demo.log`。

### 5.1 冷启：`reset --yes` 之后带 `--seed-demo` 从零 `up`

```text
$ node tools/demo-stack.mjs reset --yes          → exit 0
$ node tools/demo-stack.mjs up --mode real --port 38110 --pg-port 55510 \
      --env-file <redacted> --seed-demo          → exit 0

[5/9] 数据目录与 initdb
  ✓ initdb 完成
[7/9] 建库与迁移
  ✓ 已建库 gengyun
  ✓ 迁移完成：应用 56 个
[8/9] 种子数据
  ✓ seed_reference.sql
  ✓ seed_herbicides_verified.sql
  ✓ 已灌演示资料（非生产数据）：db/seeds/demo_catalog_verified.sql
    卡片文字取自 db/seeds/seed_reference.sql 的物种参考行；不是生产数据，也不代表第三方审核。
[9/9] 启动 API
  ✓ /health → 200 ok（database=ok, mode=real）（1944ms，探测 4 次）
```

### 5.2 首页：200 且 `previews` 8 条

```text
$ curl.exe -s -w "\nHTTP=%{http_code}" http://127.0.0.1:38110/api/v1/public/home
HTTP=200
previews=8   human_review_state=under_construction   execution_mode=real
标题：稗 / 狗尾草 / 荨麻属 / 马唐属 / 牛筋草 / 看麦娘 / 藜 / 空心莲子草
```

第一条（原文，未删字；这是 **GY-R92 之前**的措辞，改后形状见 §三 的 `knowledge_versions.body` 行）：

```json
{
  "id": "d0000000-0000-4000-8000-00000000c001",
  "title": "稗",
  "summary": "【演示资料·非生产数据】稗（学名 Echinochloa crus-galli）；别名：稗草、稗子、野稗。本卡片由 db/seeds/demo_catalog_verified.sql 从仓库既有物种参考表（db/seeds/seed_reference.sql 的 species 行）派生，只用于本机演示首页；不含识别结论、防治建议或用药指引，也不代表任何第三方审核。",
  "content_type": "knowledge",
  "source_kind": "verified_seed"
}
```

### 5.3 库侧读数

```text
$ psql ... -c "select (select count(*) from catalog_read.home_species) home_species,
                      (select count(*) from catalog_read.current_verified_sources) verified_sources,
                      (select count(*) from knowledge_versions
                        where source_version_id = '…b002') demo_kv,
                      (select revision from sources where id = '…b001') src_revision,
                      (select value from knowledge_dataset_config where key = 'active_mode') active_mode;"
 home_species | verified_sources | demo_kv | src_revision | active_mode
            8 |                1 |       8 |            2 | real
```

### 5.4 负控制：不带 `--seed-demo`（独立状态目录与端口）

```text
$ node tools/demo-stack.mjs up --mode real --port 38133 --pg-port 55533 \
      --state-dir …\demo-stack-neg --env-file <redacted>     → exit 0
[8/9] 种子数据
  · 演示资料：未灌（默认不开）⇒ 首页会返回 200 但列表为空；要卡片请加 --seed-demo

$ curl.exe -s -w "\nHTTP=%{http_code}" http://127.0.0.1:38133/api/v1/public/home
HTTP=200   预览条数 0
```

同一份代码、同一个库结构，只差一个开关：**默认关**、关着时首页就是空列表。这条负控制是「默认不开」的实际证据，不是读代码推的。

### 5.5 收工：`down` 与端口复核

```text
$ node tools/demo-stack.mjs down --port 38110 --pg-port 55510     → exit 0
  API：已停（pid 27172）
  PG：已停（fast）
  数据目录保留（下次 up 直接复用；要重来用 reset --yes）
  复核：API 端口 38110 已释放；PG 端口 55510 已释放

$ Get-NetTCPConnection -LocalPort 38110,55510 -State Listen
（无输出 ⇒ 两个端口都没有监听）
```

记录一个使用坑：5.2 之后我又跑过一次 `up --seed-demo`，是为了验「已经灌过就跳过」这条（它会把栈重新拉起来：API 27172 / PG 72788，15:24 启动），而我当时以为已经收工。复核时 `Get-NetTCPConnection` 仍看到这两个监听，再跑一次 `down` 才真正停掉并确认无监听。所以 **`down` 打印「已释放」只说明那一刻的探测通过；跑过几次 `up` 就要复核几次端口**，上面最后两行才是那次收工的读数。日志：`…\.pg17\demo-stack-logs\down-20261109-final.log`。

之后 38110/55510 这一组要留给同一台机器上接微信开发者工具的另一位协作者，所以最终证据改用 38210/55520 从零复跑了一遍（见 5.6）；38110/55510 在 5.5 的 `down` 之后也复核过 `Get-NetTCPConnection` 为空，没有留下监听。

### 5.6 复跑（最终证据）：38210 / 55520 + 独立状态目录

`--state-dir` 指到 `…\.pg17\demo-stack-r90`，新 initdb、新库，与 38110 那套数据目录完全分开：

```text
$ node tools/demo-stack.mjs reset --yes --state-dir …\demo-stack-r90 --port 38210 --pg-port 55520
  reset：停栈并删除 …\demo-stack-r90
  API：未运行；PG：未运行；已删除 …；下次 up 会重新 initdb。            → exit 0

$ node tools/demo-stack.mjs up --mode real --port 38210 --pg-port 55520 \
      --state-dir …\demo-stack-r90 --env-file <redacted> --seed-demo
  ✓ initdb 完成
  ✓ 迁移完成：应用 56 个
  [8/9] ✓ seed_reference.sql
        ✓ seed_herbicides_verified.sql
        ✓ 已灌演示资料（非生产数据）：db/seeds/demo_catalog_verified.sql
  [9/9] 已启动：pid 77920
  ✓ /health → 200 ok（database=ok, mode=real）（1951ms，探测 4 次）      → exit 0

$ curl.exe -s -o home-r90-38210.json -w "%{http_code}" http://127.0.0.1:38210/api/v1/public/home
200    # data.previews 8 条

  d0000000-0000-4000-8000-00000000c001  稗
  d0000000-0000-4000-8000-00000000c002  狗尾草
  d0000000-0000-4000-8000-00000000c003  荨麻属
  d0000000-0000-4000-8000-00000000c004  马唐属
  d0000000-0000-4000-8000-00000000c005  牛筋草
  d0000000-0000-4000-8000-00000000c006  看麦娘
  d0000000-0000-4000-8000-00000000c007  藜
  d0000000-0000-4000-8000-00000000c008  空心莲子草

$ psql -p 55520 -d gengyun -c '<计数>'
 home_species | verified_sources | demo_kv | src_revision | active_mode
            8 |                1 |       8 |            2 | real
```

卡片的 id 是 8 个服务端常量 `d0000000-0000-4000-8000-00000000c0NN`（`c001`…`c008`），不是随机 UUID。

幂等在这一套上也复验了：把种子文件再连跑两遍，两遍的报表都是 `INSERT 0 0 / INSERT 0 1 ×4（ON CONFLICT DO UPDATE 时 psql 也报 INSERT 0 1）/ UPDATE 0 / INSERT 0 8 / DO`，跑完 `home_species` 仍是 8、`sources.revision` 仍是 2、8 条 `created_at` 逐字不变（脚本里比对 `$before -eq $after` = True）。

收工：

```text
$ node tools/demo-stack.mjs down --port 38210 --pg-port 55520 --state-dir …\demo-stack-r90
  API：已停（pid 77920）
  PG：已停（fast）
  复核：API 端口 38210 已释放；PG 端口 55520 已释放                       → exit 0

$ Get-NetTCPConnection -LocalPort 38210,55520 -State Listen
（无输出 ⇒ 这两个端口都没有监听）
```

日志：`…\.pg17\demo-stack-logs\run-20261109-r90-38210.log`、`down-20261109-r90-38210.log`、`home-r90-38210.json`。

## 六、闸门

```text
$ node --test tests/unit/demo-stack.test.mjs tests/unit/demo-stack-cli.test.mjs tests/unit/demo-seed-sql.test.mjs
ℹ tests 37   ℹ pass 37   ℹ fail 0        # 原 23 例 + 新增 14 例

$ node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict \
      --symbol-coverage-verification=strict --scan docs
SYMBOL-COVERAGE-VERIFICATION-GATE: … 本次：不在区间 44、UNDECLARED 259、配成对 1334
PASS: --strict 下没有基线之外的新增（…）     # exit 0；UNDECLARED 259 < 基线 265，没有新增

$ node --test tests/unit/doc-anchor-relocation-identity.test.mjs
ℹ tests 37   ℹ pass 36   ℹ fail 0   ℹ skipped 1
# 唯一 SKIP 是主用例本身：本次改动没有触及任何既有锚点的行号，位移恒等没有判定面
# （SKIP 明细会给出具体原因与纯新增 hunk 数）；不是被判松，另有 A2/A4 等负控制钉住「该红的仍红」

$ npm run test:docs
PASS: 识别 5 页 / 跳过 373 页（扫描面 378 页：docs/verification）——读数七条判据全部自洽   # exit 0
```

另跑了 `node --test tests/unit/ci-orphan-tools-wired.test.mjs`（6 例全绿），确认 `tools/` 接线元闸门没因为改 `demo-stack.mjs` 而红。

## 七、不声称清单

这份种子**不**声称、也**不**能用作：

1. **不是第三方审核**。`reviewed_by` / `reviewed_at` 是演示侧占位，`login_name` 就写着「演示占位，非真人」；没有农药登记机构、没有农技专家、没有任何外部机构看过这 8 条。
2. **不是生产数据**。文件在 `db/seeds/` 下、名字带 `demo_`、来源标题带「【演示】」、URL 落在 `.invalid`、正文带「【演示资料·非生产数据】」；`reset` 一删就没了。它不进任何迁移，也不会被 `up` 默认灌入。
3. **不是识别结论**。8 条全是物种条目（中文名/学名/别名），没有一张图、没有一个识别置信度、没有「这是稗不是狗尾草」的判断。
4. **不是防治建议 / 用药指引**。正文里没有任何药剂、剂量、施药时机；`seed_herbicides_verified.sql` 里的制剂数据本轮一行没动，也没接进首页卡片。
5. **不代表真实资料已接入**。真实来源仍是 `unverified`，`catalog_read.current_verified_sources` 在裸 `up` 下仍是 0；这份种子只是让**本机演示**有东西可看，不代表资料入库、审核流程或合规验收有任何进展。
6. **不改产品语义**。视图、路由、`readHomePreviews` 的 SQL 与错误码一行没动；开关只决定「要不要多执行一个 SQL 文件」。

## 八、没做到 / 没验证

1. **没跑全量 `npm run test:unit`**（整套包含大量与本次无关的用例，耗时长）；只跑了受影响的三份测试文件。若 CI 跑全量后有别处红，需要另开修复。
2. **没在小程序里实际点一遍首页**。只验到 HTTP 层（`curl` 拿到的 JSON）；`docs/ui-demo/demo.html` 与小程序渲染这一层没截图、没真机跑。
3. **没验证 UI 上「演示资料」标记是否被卡片样式截断**。正文前缀是「【演示资料·非生产数据】」，若首页卡片只显示前 N 个字，可能只露出标记、也可能露不全——渲染层没看。
4. **没做并发复跑**。幂等性验的是串行重复执行；两个 `up --seed-demo` 同时跑会怎样（psql 的 `ON CONFLICT` 应能处理，但唯一键冲突时的时序没实测）。
5. **没验证 `--seed-demo` 与 `--reset` 组合之外的恢复路径**。文件末尾的回滚 SQL 是注释块，没有真跑过；只验了 `reset --yes` 这条「全删」路径。
6. **端口是共享资源，不是独占的**：负控制首跑时 PG 55520 被别人的实例占着（`demo-walk-pgdata`，pid 69652，工具点名了 pid 并 exit 2），才改到 38133/55533；最终复跑（5.6）用 38210/55520 时已经空闲。同一台机器上可能同时有多套栈，`up` 前先看端口探测那两行。
7. **`reset` 期间别在状态目录里开着日志文件**：我第一次把 `Tee-Object` 的日志写在 `…\.pg17\demo-stack\` 里，`reset --yes` 因 Windows 文件占用报 `EPERM`（工具报的是「未预期的错误」，不好看但没造成数据问题）。日志改放 `…\.pg17\demo-stack-logs\` 后一切正常。这是使用姿势问题，本轮没有改 `reset` 的删除逻辑。
8. **收工前一度留下一个在跑的实例**：见 5.5。我为了验「已灌过会跳过」又 `up` 了一次，那次把栈拉起来了；后续复核发现有监听，再 `down` 才停掉。这条是本轮的操作记录，不是工具行为断言——我没有复现出「`down` 该停没停」的确定性场景，因此没为它改 `down`。

## 九、复现

```powershell
cd E:\GengYunCommander\.pg17\wt-demo-seed
node tools/demo-stack.mjs reset --yes --state-dir E:\GengYunCommander\.pg17\demo-stack-r90 --port 38210 --pg-port 55520
node tools/demo-stack.mjs up --mode real --port 38210 --pg-port 55520 `
  --state-dir E:\GengYunCommander\.pg17\demo-stack-r90 `
  --env-file E:\GengYunPrivate\demo-real.env --seed-demo
curl.exe -s -w "`n%{http_code}`n" http://127.0.0.1:38210/api/v1/public/home
node tools/demo-stack.mjs down --port 38210 --pg-port 55520 --state-dir E:\GengYunCommander\.pg17\demo-stack-r90
```

端口只是例子，换一组空闲端口、配独立的 `--state-dir` 就行（同一台机器上可能有人正在用 38110/55510）。

只想知道「它是不是真的只在演示里有」：把 `--seed-demo` 去掉，换一组空闲端口与独立 `--state-dir` 再 `up` 一次，首页就是空列表（见 5.4）。
