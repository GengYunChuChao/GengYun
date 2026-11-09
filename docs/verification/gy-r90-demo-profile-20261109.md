# GY-R90 · demo-stack 演示档 `--demo`：一条命令把三个契约开关置为开启（本机演示）

- 日期：2026-11-09（HKT）
- 分支：`feat/gy-r90-demo-profile`，基线 `origin/main` = `f354af4b`
- 改动面：`tools/lib/demo-stack.mjs`（参数、SQL 构造、失败分类）、`tools/demo-stack.mjs`（`--demo` 执行与日志、退出码）、`tests/unit/demo-stack.test.mjs`（纯函数用例）、`tests/unit/demo-stack-cli.test.mjs`（用法断言）、`docs/demo/本地演示-stack.md`（演示档小节）、本页（新增）
- 一句话结论：`--demo` 在迁移完成后用**一次** `psql -c` 执行三条带条件的 `UPDATE`，把 `submissions_enabled`、`specific_herbicide_output_enabled`、`ai_enabled` 置为 `true`；重复 `up --demo` 不会再次累加 `revision`。真跑读数：首次三个键的 `revision` 都是 2，第二次 `up --demo` 后仍是 2；`down` 后 38310／55530 都没有监听。

> 读数快照：2026-11-09，Windows + PowerShell 7，Node `v24.x`，PostgreSQL 17.11；本机端口 API 38310／PG 55530，状态目录 `E:\GengYunCommander\.pg17\demo-stack-demo`，env 文件 `E:\GengYunPrivate\demo-real.env`（只读使用，本页不记录其中的值）。基线提交 `f354af4bae34276d32f63f98d79ebcafef4cb4a9`。

## 1. 为什么要这个开关

演示栈起来之后，`public.feature_flags` 的三行仍是迁移 0020 写入的默认值 `enabled = false`。此前要演示社区投稿、制剂输出或识别／问答，只能人工连上库执行 `UPDATE`，或者先经后台的 `set_feature_flag` 写入口逐个打开；对「一条命令拉起本机演示栈」来说，这是最后一段人肉步骤。

`--demo` 把这段收进 `up`：迁移完成、种子处理完之后，在启动 API **之前**写库，因此 API 的第一个请求就能看到开启状态。它只改本机这套栈的数据库，不新增迁移，也不改任何服务代码。

## 2. 改动面与职责

| 文件 | 改动 | 为什么 |
| --- | --- | --- |
| `tools/lib/demo-stack.mjs` | 新增 `DEMO_FLAG_KEYS`、`DEMO_FLAG_REASON`、`buildDemoFlagStatements()`、`buildDemoFlagSql()`；`parseArgs` 增加 `demo`；用法增加 `--demo`；失败分类增加 `demo-profile` | 纯函数层不碰 IO，SQL 可单测；解析与帮助文本和既有选项同层 |
| `tools/demo-stack.mjs` | import 两个纯函数；新增 `EXIT.DEMO = 8`；新增 `applyDemoProfile()`；在种子段与启动 API 之间调用 | 只有这里能拿到 `pgBin`、`pgPort` 并调用 `psql`；失败要单独退出码与可读提示 |
| `tests/unit/demo-stack.test.mjs` | 断言 `--demo` 解析、用法、3 条／0 条 SQL、字段与幂等条件 | 不连真库也能钉住「带才写、不带一条不写」 |
| `tests/unit/demo-stack-cli.test.mjs` | `--help` 输出必须含 `--demo` | 防止帮助文本与实际解析脱节 |
| `docs/demo/本地演示-stack.md` | 新增 §3.1，补九步表、退出码表与速查 | 使用者要知道它做什么、不做什么，以及三个开关关掉时各自的后果 |
| 本页 | 记录改动、真跑、幂等与闸门读数 | 证据与实现分离，便于复核 |

没有改 `services/**`、`packages/**`、`.github/**`、迁移或 `docs/architecture/**`。

## 3. 行为：三条条件 UPDATE，一个 psql 调用

`buildDemoFlagStatements({ demo: true })` 对三个键各生成一条：

```sql
UPDATE public.feature_flags
   SET enabled = true,
       revision = revision + 1,
       reason = 'demo-stack local demo profile (non-production)',
       changed_at = now()
 WHERE key = '<key>'
   AND (enabled IS DISTINCT FROM true OR reason IS DISTINCT FROM 'demo-stack local demo profile (non-production)')
RETURNING key;
```

三条语句用换行拼成**一个** `psql -c` 参数，由 `psql` 一次发送。任一条失败时 psql 以非零退出，`up` 在启动 API 前停住并返回 `EXIT.DEMO`（8），不会出现「栈起来了但开关只开了一半」的假成功。`buildDemoFlagStatements({ demo: false })` 返回空数组，`buildDemoFlagSql` 返回 `null`；调用方只在 `options.demo` 为真时才调用 `psql`。

幂等的落点就是 `WHERE` 里的条件：只有「`enabled` 不是 true」或「`reason` 还不是演示档」的行才 `revision + 1`。已经是目标状态的行不更新，所以重复 `up --demo` 不会继续抬高 revision；`RETURNING key` 同时让工具能区分「本次改了 3 条」与「本来就已经是演示档」。

日志固定两段：

- 成功头：`[8/9] 演示开关：已开启 submissions_enabled / specific_herbicide_output_enabled / ai_enabled（非生产）`
- 本次有更新：`  本次更新 3/3 个开关（revision +1）：submissions_enabled / specific_herbicide_output_enabled / ai_enabled`
- 本次无更新：`  已是演示档：3 个开关均已开启且 reason 一致，revision 未重复累加（幂等）`
- 不带 `--demo`：`演示开关：未开（默认）`，并且一条 SQL 都不执行。

数字前缀沿用了用户指定的 `[8/9]`；它与同段的 `[8/9] 种子数据` 并列，表示「种子之后的演示档处理」，不是多出来的第九步。

## 4. 三个开关的语义

| 开关 | 关掉时的可见后果 | 开启后的本机演示效果 |
| --- | --- | --- |
| `submissions_enabled` | 社区投稿不可用；`POST /posts`、`POST /posts/:id/comments` 被拒 | 社区投稿与评论可受理 |
| `specific_herbicide_output_enabled` | `/herbicides` 返回 409，错误详情里的 `code` 是 `FLAG_CLOSED` | `/herbicides` 与登记核对可输出制剂信息 |
| `ai_enabled` | 识别、OCR、转写、合成、文字问答的受理面返回 409，任务不会被受理 | 这些受理面可受理任务 |

这三条来自服务端的全局开关闸门：关闭是**确定性的 409**，不是「暂时故障」的 503；闸门在受理前拒绝，不会先收任务再失败。具体路由清单与错误形状由 `services/api/src/admin/ops/flag-gate.ts` 维护，本改动没有碰它。

**这是本机演示配置，不是生产建议。** 生产环境该开哪个、什么时候开，要按实际审核、合规与运营要求决定，不能照抄这里的三个 `true`。

## 5. 真跑：首次 `up --demo`

命令（状态目录与端口都是本任务专用，未复用别人的栈）：

```powershell
node tools/demo-stack.mjs up --mode real --port 38310 --pg-port 55530 --state-dir E:\GengYunCommander\.pg17\demo-stack-demo --env-file E:\GengYunPrivate\demo-real.env --demo
```

关键原文：

```text
[5/9] 数据目录与 initdb
  没有簇：initdb → E:\GengYunCommander\.pg17\demo-stack-demo\pgdata（trust / locale=C / UTF8）
  ✓ initdb 完成

[6/9] 启动 PG 簇
  ✓ 已启动（日志 E:\GengYunCommander\.pg17\demo-stack-demo\pg.log）

[7/9] 建库与迁移
  ✓ 已建库 gengyun
  ✓ 迁移完成：应用 56 个

[8/9] 种子数据
  ✓ seed_reference.sql
  ✓ seed_herbicides_verified.sql

[8/9] 演示开关：已开启 submissions_enabled / specific_herbicide_output_enabled / ai_enabled（非生产）
  本次更新 3/3 个开关（revision +1）：submissions_enabled / specific_herbicide_output_enabled / ai_enabled

[9/9] 启动 API
  已启动：pid 53376（日志 E:\GengYunCommander\.pg17\demo-stack-demo\api.log）
  等 /health 变 200（上限 90000ms）
  ✓ /health → 200 ok（database=ok, mode=real）（3328ms，探测 5 次）
```

读库（psql 走本栈的 PG 端口）：

```powershell
& E:\GengYunCommander\.pg17\pgsql\bin\psql.exe -h 127.0.0.1 -p 55530 -U postgres -d gengyun -c "select key,enabled,revision from public.feature_flags order by key"
```

原文：

```text
                key                | enabled | revision
-----------------------------------+---------+----------
 ai_enabled                        | t       |        2
 specific_herbicide_output_enabled | t       |        2
 submissions_enabled               | t       |        2
(3 rows)
```

三行 `enabled` 都是 `t`，`revision` 都是 2（迁移初值是 1，本次各加一次）。

## 6. 幂等复核：第二次 `up --demo`

为了真正走到 SQL，而不是命中「API 已在跑」的早退分支，先 `down`（保留数据目录），再用同一条命令 `up --demo`。第二次的关键原文：

```text
[7/9] 建库与迁移
  ✓ 数据库 gengyun 已存在
  ✓ 迁移完成（无待应用）

[8/9] 种子数据
  ✓ 已导入过（state 记录 real:gengyun），跳过；要重灌用 `up --reset`

[8/9] 演示开关：已开启 submissions_enabled / specific_herbicide_output_enabled / ai_enabled（非生产）
  已是演示档：3 个开关均已开启且 reason 一致，revision 未重复累加（幂等）

[9/9] 启动 API
  ✓ /health → 200 ok（database=ok, mode=real）（5369ms，探测 6 次）
```

第二次读库，三行仍是 `enabled = t`、`revision = 2`，与首次相同。说明条件 `UPDATE` 确实把「已经是演示档」的行排除了，而不是每次盲目 `+1`。

## 7. 收工与端口

```text
node tools/demo-stack.mjs down --port 38310 --pg-port 55530 --state-dir E:\GengYunCommander\.pg17\demo-stack-demo
  API：已停（pid 55024）
  PG：已停（fast）
  数据目录保留（下次 up 直接复用；要重来用 reset --yes）
  复核：API 端口 38310 已释放；PG 端口 55530 已释放
```

随后用 `Get-NetTCPConnection -State Listen -LocalPort 38310,55530` 复核，没有返回任何监听项，输出「38310/55530 无监听」。本任务没有留下 API、PG 或后台任务。

## 8. 单测与四道闸门

单测（不连真库）：

```text
node --test tests/unit/demo-stack.test.mjs tests/unit/demo-stack-cli.test.mjs
ℹ tests 29
ℹ pass 29
ℹ fail 0
```

四道闸门与尾行：

| 闸门 | 结果 | 尾行原文 |
| --- | --- | --- |
| `verify-doc-anchors` 严格档 | PASS | 见下方第 1 条 |
| `doc-anchor-relocation-identity` | PASS | 见下方第 2 条 |
| `npm run test:docs` | PASS | 见下方第 3 条 |
| `verify-verification-comment-anchors` | PASS | 见下方第 4 条 |

```text
$ node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs
PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）

$ node --test tests/unit/doc-anchor-relocation-identity.test.mjs
ℹ tests 37
ℹ pass 36
ℹ fail 0
ℹ skipped 1

$ npm run test:docs
PASS: 识别 5 页 / 跳过 374 页（扫描面 379 页：docs/verification）——读数七条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字 ⑦同页副本一致）

$ node tools/verify-verification-comment-anchors.mjs
VERIFICATION-COMMENT-ANCHOR-PASS: 基线内 1419 条注释锚点只告警，没有基线外新增
```

## 9. 不声称项

- 不声称三个开关在生产环境应当开启；本页只证明本机演示栈可以一条命令把它们置为开启。
- 不声称本改动改变了开关的权限模型、审计字段或后台写入口；写库用的是演示栈自己的 PostgreSQL 超级用户连接，生产写面仍走既有的 `set_feature_flag`。
- 不声称种子数据、首页资料或 `verified` 来源有任何变化；真跑里首页仍可能为空，原因见运行手册第 7 节。
- 不声称别的端口、别的状态目录或别人的栈被触碰；本次只用 38310／55530 与 `E:\GengYunCommander\.pg17\demo-stack-demo`。
