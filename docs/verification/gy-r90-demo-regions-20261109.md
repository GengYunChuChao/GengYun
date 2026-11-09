# 「我的档案」支持目录补齐（演示栈实跑）

2026-11-09（UTC+8）。分叉基线 `209aa01a`（`test(failmatrix): cover account deletion cancellation (#1157)`），
分支 `feat/gy-r90-demo-regions`；推送前 `main` 前进到 `14d86d59`（另一个 PR #1158 也动了
`tools/demo-stack.mjs` / `tools/lib/demo-stack.mjs`），已在分支上合并 `14d86d59` 解冲突，本文引用的是
合并后的行号。B 档改动：`db/seeds/**`、`tools/**`、`tests/unit/**`、`docs/**`。

## 一句话结论

「支持目录」读的是 `public.regions` 与 `public.crops` 两张表（**没有**单独的县级接口），页面里的「为空」
只意味着 `cities` 过滤结果为空；而 `up --demo` 原先只写三个 feature flag，目录完全依赖 baseline 种子 +
state 里「已 seed 过」的记录。本次新增幂等演示种子 `db/seeds/seed_demo_regions.sql`，并把「补齐目录」做成
`--demo` 自己的显式步骤（含「栈已在跑」的短路分支）。实跑后页面 `counties` 由 0 变为 10（选中宁波市），
`message` 不再出现「支持目录为空」，且没有动库里别人灌的任何行。

## 查了什么：从页面一路读到 SQL

1. `miniprogram/pages/profile/profile.js:162` 一次并发取 `read()` / `crops()` / `regions()`；
2. `miniprogram/utils/profile-api.js:43` 把目录读成 `GET /catalog/<kind>?limit=20`，cursor 翻页，
   并校验 region code 形如 `^33[0-9]{4}$`、`catalog_version` 非空；
3. 服务端 `services/api/src/profile/service.ts:68` 执行
   `SELECT code,name,parent_code,catalog_version FROM public.regions WHERE supported AND code=ANY($1::varchar[]) ORDER BY code FOR SHARE`，
   随后把每一行与 `packages/knowledge/catalog/regions-zhejiang.json` **逐字段**比对；不一致的行被**静默丢掉**，
   psql 与 API 都不报错；
4. 页面在 `miniprogram/pages/profile/profile.js:166` 用 `!result[1].length || !cities.length` 决定是否写
   「支持目录为空，暂时不能选择档案。」，`miniprogram/pages/profile/profile.js:186` 的编辑入口守卫同样读这两份长度；
5. 选中市之后才填 `counties`（`miniprogram/pages/profile/profile.js:199`），所以**没进编辑/没选市时
   `counties` 本来就是 0**，这不是故障。

表结构见 `services/api/db/migrations/0001_initial_schema.sql:123`（`regions`）与
`services/api/db/migrations/0001_initial_schema.sql:108`（`crops`）：两表**没有** `note` / `reason` 列，
所以「演示数据·非生产」的标记只能落在种子文件里（文件头 + 每条行尾注释）。

## 为什么会出现 `counties=0`

- 不是版本问题：`git diff origin/main HEAD -- miniprogram/pages/profile miniprogram/utils/profile-api.js` 为空；
- 不是「表结构不支持县级」：`regions.parent_code` 就够挂三级；
- 是**这两张表没有行，或行的值与目录 JSON 不一致**：`cities` 为空 ⇒ 文案成立；
- `--demo` 原先只调 `applyDemoProfile`（`tools/demo-stack.mjs:475` 的定义），目录那一步是本次新加的：
  目录此前完全靠 baseline `SEED_FILES`，而 baseline 只在 state 里**没记过** `real:gengyun` 时才跑：
  库被重建、换库、或只跑迁移而 state 仍记 seeded，`--demo` 起来的栈就是空目录；
- 另一个实际缺口：`up` 在「API 已由本工具起过且健康」时直接短路返回，**旧版连 demo 开关都不重跑**，
  于是对「已经在跑的演示栈」执行 `up --demo` 根本补不了目录。本次在短路分支里补了幂等的一步
  （`tools/demo-stack.mjs:631`）。

## 灌了什么：`db/seeds/seed_demo_regions.sql`

只灌演示路径要的最小集合（10 条区划 + 4 类作物），每条都带 `-- 【演示数据·非生产】`：

| 级别 | code | 名称 | parent_code |
| --- | --- | --- | --- |
| 省 | `330000` | 浙江省 | `NULL`（页面靠 `parent_code === null` 找根） |
| 市 | `330100` | 杭州市 | `330000` |
| 市 | `330200` | 宁波市 | `330000` |
| 市 | `330300` | 温州市 | `330000` |
| 县区 | `330102` / `330106` | 上城区 / 西湖区 | `330100` |
| 县区 | `330203` / `330205` | 海曙区 / 江北区 | `330200` |
| 县区 | `330302` / `330304` | 鹿城区 / 瓯海区 | `330300` |

作物 4 条：`crop_rice` 水稻、`crop_corn` 玉米、`crop_soybean` 大豆、`crop_rapeseed` 油菜
（与 `packages/knowledge/catalog/crops.json` 一致）。

- 全部 `catalog_version='mca-xzqh-2023'`、`supported=true`，与目录 JSON 逐字段一致（否则服务端会丢行）；
- 幂等：每条 `ON CONFLICT (code|id) DO UPDATE`（`db/seeds/seed_demo_regions.sql:29`、`:45`），
  没有 `DELETE` / `TRUNCATE`；
- 自检：文件末尾 `DO $$`（`db/seeds/seed_demo_regions.sql:51`）数省/市/县区/作物，缺一项就
  `RAISE EXCEPTION`；配 `-v ON_ERROR_STOP=1` ⇒ 整组回滚，不会留下半套目录；
- 接线：`tools/lib/demo-stack.mjs:540` 定义路径常量，`tools/demo-stack.mjs:434` 的 `applyDemoCatalog`
  用 `psql -f` 跑它（与既有 `--seed-demo` 同一种跑法），并回读
  `tools/lib/demo-stack.mjs:560` 的读数 SQL 打印「省 / 市 / 县区 / 作物」。

## 计数前后（同簇 scratch 库，只应用 0001 迁移）

为了排除「库里本来就有 102 条，看不出种子效果」，在一个**独立 scratch 库** `gengyun_r90_probe`
（只跑 `0001_initial_schema.sql`，不跑任何 baseline 种子）上重复执行两次：

| 步骤 | regions | crops | 省 / 市 / 县区 | 结论 |
| --- | --- | --- | --- | --- |
| 种子前 | 0 | 0 | 0 / 0 / 0 | 空表，页面必然「支持目录为空」 |
| 第 1 次 `psql -f` | 10 | 4 | 1 / 3 / 6 | 一次补齐，`NOTICE 【演示数据·非生产】支持目录就绪：省=1 市=3 县区=6 作物=4` |
| 第 2 次 `psql -f` | 10 | 4 | 1 / 3 / 6 | 幂等：行数不变，`pg_stat_user_tables` 的 `n_tup_ins` 仍 10/4、`n_tup_upd` 10/4 |

scratch 库用完即 `dropdb`，现网只剩 `gengyun`。

## 实跑（本机演示栈 38110 / 55510，未新建端口）

```
node tools/demo-stack.mjs up --mode real --port 38110 --pg-port 55510 ^
  --state-dir E:\GengYunCommander\.pg17\demo-stack-live ^
  --env-file E:\GengYunPrivate\demo-real.env --demo --timeout-ms 90000
```

| 读数 | 结论 |
| --- | --- |
| `[2/9] API 是本工具上一次起的实例（pid 54716）⇒ 不重复启动` + `✓ /health → 200 ok` | 走的是「栈已就绪」短路分支，没有重启 API |
| `[8/9] 演示目录：已补齐「我的档案」的支持目录（演示数据·非生产）` / `库内读数：省 1 / 市 3 / 县区 6 / 作物 4` / EXIT 0 | 短路分支也会补目录 |
| 库内 `regions=102`、`crops=4`、`single_profiles=0`、`users=3` 不变；`pg_stat_user_tables` 里 `regions` 为 `ins 102 / upd 10` | 只 UPSERT 演示路径那 10 行，没删没加别人的数据 |
| API `/health` 200（`execution_mode: real`，`database: ok`） | 接口侧仍然健康 |

页面侧（微信开发者工具 automator `ws://127.0.0.1:9423`，`page.data()` 实测）：

| 状态 | `crops` | `regions` | `cities` | `counties` | `message` |
| --- | --- | --- | --- | --- | --- |
| 进页（未编辑） | 4 | 102 | 11 | 0（正常：没选市） | `""` |
| 点「手选作物与市县」 | 4 | 102 | 11 | 0 | `""` |
| `onCity {value:1}`（宁波市） | 4 | 102 | 11 | **10** | `""` |
| `onCounty {value:0}`（海曙区） | 4 | 102 | 11 | 10，`countyIndex: 0` | `""` |

宁波市下 10 个县区：`330203 海曙区`、`330205 江北区`、`330206 北仑区`、`330211 镇海区`、
`330212 鄞州区`、`330213 奉化区`、`330225 象山县`、`330226 宁海县`、`330281 余姚市`、`330282 慈溪市`。

截图（`E:\GengYunCommander\.pg17\demo-shots5\`）：
`07-profile-after-demo-seed.png`（进页，卡片不再有「支持目录为空」）、
`08-profile-counties-after-seed.png`（选宁波市后的县区列表）、
`09-profile-county-selected-after-seed.png`（「浙江市 宁波市 / 县区 海曙区」已选中）。

## 闸门

四道闸门都在本分支实跑（合并 `main` 之后的工作树即本页所在提交），尾行照抄：

| # | 闸门 | 命令 | 尾行 | 结论 |
| --- | --- | --- | --- | --- |
| ① | 四连 strict | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | `PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）` | EXIT 0 |
| ② | identity | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | `ℹ tests 37` / `ℹ pass 36` / `ℹ fail 0` / `ℹ skipped 1` | EXIT 0 |
| ③ | test:docs | `npm run test:docs` | `PASS: 识别 5 页 / 跳过 377 页（扫描面 382 页：docs/verification）——读数七条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字 ⑦同页副本一致）` | EXIT 0 |
| ④ | 注释锚点 | `node tools/verify-verification-comment-anchors.mjs` | `VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 1425、基线 1425、基线外新增 0、可收紧 0（--require-no-new=on、--require-no-stale=off）` ＋ `VERIFICATION-COMMENT-ANCHOR-PASS: 基线内 1425 条注释锚点只告警，没有基线外新增` | EXIT 0 |

相关单测：`node --test tests/unit/demo-regions-seed.test.mjs tests/unit/demo-stack.test.mjs tests/unit/demo-stack-cli.test.mjs`
→ `ℹ tests 52 / ℹ pass 52 / ℹ fail 0`。

④ 在合并 `main` 之前判红过一次：本次新增的 import 行让 `tools/demo-stack.mjs` 整体位移 3 行，
既有证据页 `docs/verification/gy-r90-demo-stack-20261109.md` 里那条指向 `tools/demo-stack.mjs`
第 323 行的锚点就落到了块注释上（基线外新增 1 条）。没有去改别人的锚点、也没有 `--write-baseline`，
而是把新增的 import 名并进既有 import 行内（相对基线净位移 0）。合并 `main` 后基线本身涨到 1425 条，
本节记的是合并后的读数。

## 不声称

- **不代表生产行政区划完整**：只覆盖演示路径 1 省 / 3 市 / 6 县区；完整 102 条仍在生成文件
  `db/seeds/seed_reference.sql`，本种子不替代它、也不改它；
- 不声称生产库或别人的栈已经补过：本次只对 `38110 / 55510` 这套演示栈实跑过（未重启 API）；
- 不声称修了小程序产品代码：`miniprogram/**` 未改动（本次未发现需要改的产品 bug）；
- 不声称种子能替代权威区划校验：值必须与 `packages/knowledge/catalog/regions-zhejiang.json`
  逐字段一致，改 JSON 就要同步改种子；
- 不声称 `regionNote` 相关行为已变：那是知识页的 `REGION_TIER_NOTE`，不在「我的档案」页；
- 不声称覆盖面：`up --demo` 只保证演示路径可选中；不做真实区划校验、不覆盖其它省份。
