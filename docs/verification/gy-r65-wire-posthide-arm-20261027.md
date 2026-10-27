# R65 · 真库臂 `admin-post-hide-audit-pg` 接进 real-PG 作业（2026-10-27）

分支 `feat/gy-r65-wire-posthide-arm`，基 `9ba635d7`，单提交；⛔ 不 push、不建 PR、不合并。
本页所有读数取自**提交前工作树**（HEAD 仍是 `9ba635d7` + 三个文件的工作区改动，`git status --porcelain` 只列这三个文件）。

## 1. 结论摘要

- **接线完成**：`.github/workflows/real-pg-integration.yml` 的 `real-pg-17.11` job 里新增一个 step，紧接
  `admin-community-posts-pg`（同一 `POST /admin/posts/{id}/hide` 处置面的专证臂），位置 `.github/workflows/real-pg-integration.yml:330-357`。
  形态逐字照抄既有真库 step：`set -euo pipefail`、`log=/tmp/admin-post-hide-audit-pg.log`、
  先 `CREATE DATABASE` 再 `node`、`exit 77` 显式升级成 `::error::` + `exit 1`、非 0 非 77 打日志尾部并 `exit $rc`。
  ⛔ 无 `continue-on-error`、无 `|| true`、77 绝不当通过。
- **未接线登记表**：条目**保留**（`UNWIRED_DECLARATIONS` 仍是 53 条），reason 改成当时态。
  派单原要求「53 → 52」，实测不可行，理由与原文见 §6（这是唯一一处与派单口径不符的实质改动）。
- **本机真库复验**：PG 17.11 / 端口 55440 / 一次性空库，`psql … CREATE DATABASE` 与 `node …` 均 **exit 0**，
  脚本末行 `PASS admin-post-hide-audit-pg · 读数 10 条 · 全部断言通过`（读数原文见 §4）。
- **三条守卫**：`ci-real-pg-wiring` 18/18、`ci-integration-chain-structure` 7/7、`migration-subset-coverage-pins` 10/10，
  全部 exit 0；`doc-anchors-guard` 10/10、`verify-doc-anchors --strict --scan docs` PASS（见 §3）。
- **负控制**：把新 step 整块注释掉 ⇒ `ci-real-pg-wiring.test.mjs` 变红（8 pass / 10 fail，报错点名
  `tests/integration/admin-post-hide-audit-pg.mjs`）；按 SHA256 字节相同还原后复绿 18/18（原文见 §5）。

## 2. 改了什么

| 文件 | `git diff --numstat` | 关键改动 |
| --- | --- | --- |
| `.github/workflows/real-pg-integration.yml` | `39 0`（679 → 718 行） | `:330-357` 新增一个 step + 11 行注释块（`:319-329`）；位置在 `admin-community-posts-pg` 之后、`ocr-jobs` 之前 |
| `tests/unit/ci-real-pg-wiring.test.mjs` | `12 0`（2229 → 2241 行） | `MANAGED_SCRIPTS` 登记 `:159`、`FROZEN_MANAGED_SCRIPTS` 登记 `:211`、`REQUIRED_STEP_ORDER` 第 3e 条登记 `:318-323`，三处都紧跟 `admin-community-posts-pg`（同相对位置） |
| `tests/unit/ci-integration-chain-structure.test.mjs` | `15 15`（738 → 738 行，**等行数替换**） | `UNWIRED_DECLARATIONS` 里 `:172-192`（共 21 行）条目**保留**、只改 reason；条数仍 53 |

新 step 的判据链逐行要点（`.github/workflows/real-pg-integration.yml`）：

- `:334` `psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_admin_post_hide_audit_test'` —— 库名硬钉，
  与 `tests/integration/admin-post-hide-audit-pg.mjs:59` 的 `const DB = 'gengyun_admin_post_hide_audit_test';` 撞得上；
- `:336` `node tests/integration/admin-post-hide-audit-pg.mjs postgres://…/gengyun_admin_post_hide_audit_test 2>&1 | tee "$log" || rc=$?`；
- `:346` 读数计数 `readings=$(awk '/^\[[A-Z0-9]+\]/{n++} END{print n+0}' "$log")`；
- `:348` 末行判据 `grep -Fq 'PASS admin-post-hide-audit-pg'`（该脚本**不打印** `[ALL PASS]`，见
  `tests/integration/admin-post-hide-audit-pg.mjs:422`，所以这里不能照抄别的 step 的 `[ALL PASS]`）。

## 3. 守卫读数（改后复跑）

| 命令 | 结果 |
| --- | --- |
| `node --test tests/unit/ci-real-pg-wiring.test.mjs` | `tests 18 / pass 18 / fail 0`，exit 0 |
| `node --test tests/unit/ci-integration-chain-structure.test.mjs` | `tests 7 / pass 7 / fail 0`，exit 0 |
| `node --test tests/unit/migration-subset-coverage-pins.test.mjs` | `tests 10 / pass 10 / fail 0`，exit 0 |
| `node --test tests/unit/doc-anchors-guard.test.mjs` | `tests 10 / pass 10 / fail 0`，exit 0 |
| `node tools/verify-doc-anchors.mjs --strict --scan docs` | exit 0；`SCAN 文档 361 份；引用 5685 条（解析成功 5465、同名多文件 210 不计红、同文档重复 8 去重）`；`COUNT: BROKEN 4 / OUT_OF_RANGE 2 / SUSPECT 7（合计 13）`；`BASELINE 登记 13、命中 13、基线外新增 0、陈旧 0`；`PASS` |

`ci-real-pg-wiring.test.mjs` 的 18 条里，与本片直接相关的四条判据（全部前向 + 反向控制）读数：

- 前向① 受管脚本都被某个 workflow 的 `run:` 真跑 —— 绿；
- 前向⑤（判据⑥）`REQUIRED_STEP_ORDER` 顺序一致 —— 绿（新臂排在 `admin-community-posts-pg` 之后、`ocr-jobs-pg` 之前）；
- 前向⑥（判据⑦＋⑧）同 step 内「先 `CREATE DATABASE` 再 `node`」且库名与该 step 传入的一致 —— 绿；
- 前向⑦（判据⑨）workflow 跑的 `-pg.mjs`／`-e2e.mjs` 集合与 `MANAGED_SCRIPTS` 双向相等 —— 绿。

## 4. 本机真库手跑（PG 17.11 / 55440）

集群：`E:\GengYunCommander\.pg17\pgsql\bin`，数据目录一次性的 `…\.pg17\tmp\r65-wire-pgdata`（跑完即删），
`initdb -U postgres -A trust -E UTF8 --locale=C` exit 0；`pg_ctl start` 带
`-o "-p 55440 -c listen_addresses=127.0.0.1"`、`-w -t 30`，服务日志与客户端日志分开两个文件。
`select version()` 读数：`PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit`。
启动后 `Get-Process postgres` 计数 = 6，55440 处于 listen。

模拟 CI step（等价于 `.github/workflows/real-pg-integration.yml:334` 与 `:336` 两行，只把连接串换成
本机超级用户、库名一字不改）：

1. `psql -h 127.0.0.1 -p 55440 -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_admin_post_hide_audit_test'`
   ⇒ 输出 `CREATE DATABASE`，exit 0；随后 `pg_database` 里该库计数 = 1。
2. `node tests/integration/admin-post-hide-audit-pg.mjs postgres://postgres@127.0.0.1:55440/gengyun_admin_post_hide_audit_test`
   ⇒ **exit 0**，客户端日志 13 行（`ADMIN_POST_HIDE_AUDIT_PG_TEST_URL` 与 `GY_ALLOW_SKIP` 都置空，只走 argv[2]）。

读数原文（原样，`[X]` 行 10 条，末行是 `PASS …`）：

```
[M] PG 17.11 · 空库前提成立（public 下 0 张表）
[M] 迁移子集 0001+0017+0022+0027+0030+0032+0033+0045+0047 逐条 apply、二连跑 0 条；0047 函数在且 SECURITY DEFINER、PUBLIC 不可执行
[M] 依赖列在位：admin_audit_events.{target_ref,reason_code,request_id}、admin_scopes.revoked_at、community_posts.{visibility,revision,updated_at}
[M] 夹具 2 条 published 帖真落 community_posts；管理员镜像进 admin_accounts + admin_scopes(sources:write)
[A] 隐藏成功 ⇒ public.admin_audit_events 恰 1 行：actor=该管理员 / scope=sources:write / action=post.hide / result=accepted / reason=post_hidden / target_ref={post,id,revision:1} / target_hint=NULL
[A] 库层调用口径：COMMUNITY_POST_SQL.hideAudit 是字面量 SELECT public.record_admin_post_hide_audit($1..$5)（无 FROM、不走调用方拼字符串）
[A2] 读面不受伤：public.list_admin_audit_logs(p_limit => 50) 正常返回 1 行，其中 post.hide 恰 1 行且同 id（#654 的翻车点在这里钉住）
[B] 返修臂：触发器令 post.hide 写入抛错 ⇒ 503 PROVIDER_UNAVAILABLE(retryable:false, message 含「审计写入失败」)；帖子 visibility 仍 published、revision=1、审计零新增
[B] 负控制的对照臂：拆掉触发器后同一路径恢复 200，审计 +1（说明被挡住的确实是审计写入，不是权限/账号）
[C] 幂等：已隐藏再隐藏 ⇒ 200 accepted、ETag 不变、行逐列不变、post.hide 审计仍 2 条（不多出）
```

⚠ 一处口径微调（实测驱动）：`[A2]` 这类带数字的标记匹配不上 `^\[[A-Z]\]`，照抄别的 step 那个字符类会数出 **9** 条
（脚本自己报的是 10 条）。故 `.github/workflows/real-pg-integration.yml:346` 写成 `[A-Z0-9]+`，本机用同一条 awk 判据
复算得到 **10**，与脚本自报一致；门禁本身是 `-lt 1` 的下限判据，放窄或放宽都不会把 0 条读成通过。

## 5. 负控制（红 → 绿自证）

做法：把 `.github/workflows/real-pg-integration.yml:319-357` 整块（注释 + step）逐行前缀成 YAML 注释，
文件仍是 718 行、其余一字未动，然后跑同一条守卫。

红（`node --test tests/unit/ci-real-pg-wiring.test.mjs` ⇒ **exit 1**，`tests 18 / pass 8 / fail 10`）原文摘录：

```
✖ 前向①：两个受管真库脚本都被某个 workflow 的 `run:` 真跑 (15.3192ms)
  AssertionError [ERR_ASSERTION]: 有受管真库脚本既没有被任何 workflow 的 `run:` 执行，也没有对应的真库臂——
  这类脚本坏了 CI 也不会红（「脚本在 main、但没人跑」的静默缺口）：
    · tests/integration/admin-post-hide-audit-pg.mjs
```

```
✖ 前向⑥（判据⑦＋⑧）：每个受管脚本所在 step 先 CREATE DATABASE 再 node，且库名与该 step 传入的一致
  AssertionError [ERR_ASSERTION]: `.github/workflows/real-pg-integration.yml` 的「先建库＋库名一致」判据不通过：
    · tests/integration/admin-post-hide-audit-pg.mjs：workflow 里找不到执行它的 step
```

```
✖ 前向⑦（判据⑨）：workflow 里执行的 `-pg.mjs`／`-e2e.mjs` 集合与 MANAGED_SCRIPTS 双向相等
  AssertionError [ERR_ASSERTION]: `.github/workflows/real-pg-integration.yml` 真正执行的 `-pg.mjs` 集合与 `MANAGED_SCRIPTS` 不双向相等：
    · 清单里有、workflow 没跑：tests/integration/admin-post-hide-audit-pg.mjs
```

```
✖ 前向⑤（判据⑥）：受管脚本在 workflow 里的执行顺序必须与 REQUIRED_STEP_ORDER 一致
    · workflow 里找不到这些脚本的 `node` 调用（顺序判据失去对象）：tests/integration/admin-post-hide-audit-pg.mjs
```

绿（还原后）：按提交前做的**字节相同备份**还原，还原前后 `Get-FileHash -Algorithm SHA256` 都是
`EE0AED507207D4252DB19032770924FF160864E5D24EED9E3E4C49A0EB723862`（`identical=True`），文件仍 718 行；
复跑同一条守卫 ⇒ **exit 0**，`tests 18 / pass 18 / fail 0`；`git status --porcelain` 只剩三个待提交文件：

```
 M .github/workflows/real-pg-integration.yml
 M tests/unit/ci-integration-chain-structure.test.mjs
 M tests/unit/ci-real-pg-wiring.test.mjs
```

## 6. 与派单口径不符之处

### 6.1 `UNWIRED_DECLARATIONS` 53 → 52：**不可行**，本片保留 53

派单要求「从 `UNWIRED_DECLARATIONS` 删除本脚本那条（53 → 52）」。实测删除后
`node --test tests/unit/ci-integration-chain-structure.test.mjs` ⇒ **exit 1**，原文：

```
  ✖ 4 未接线必须显式声明：新脚本既不接线也不声明 ⇒ 红 (0.9892ms)
ℹ tests 7 / ℹ pass 5 / ℹ fail 2
  AssertionError [ERR_ASSERTION]: tests/integration 下有既未接线、也未在本文件 UNWIRED_DECLARATIONS 声明的脚本：tests/integration/admin-post-hide-audit-pg.mjs。请二选一：接进 test:integration:http 链，或在白名单里写明原因。
  + [ 'tests/integration/admin-post-hide-audit-pg.mjs' ]
  - []
```

根因是判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链（`readChainEntries()` 在
`tests/unit/ci-integration-chain-structure.test.mjs:594` 从 `package.json` 真值解析，`:678` 的过滤式
`!wired.has(path) && !declared.has(path)`，失败消息在 `:682-683`）：**真库臂永远不在那条链里**（回环链里既没有真 PG、
也没有 `initdb`/`pg_ctl`），所以「接进真库 job」与「从本白名单移除」在现有断言下互斥。

处置（指挥裁定 B 方案）：**保留条目、只把 reason 改成当时态**，条数仍 53；「workflow 真的跑它」这件事改由
`tests/unit/ci-real-pg-wiring.test.mjs` 的三张清单（`MANAGED_SCRIPTS` `:159`、`FROZEN_MANAGED_SCRIPTS` `:211`、
`REQUIRED_STEP_ORDER` `:318-323`）强制，那三条判据在 §5 的负控制里逐条点名过本脚本。
⛔ 本片**没有**为凑 52 去放宽/改判定据 1–6 一个字。

**登记为后续片（本片不做）**：教会判据 4 认 real-PG workflow（即把「在 `real-pg-integration.yml` 里被 `node` 真跑」
也算作 `wired`），届时那条条目才能安全删除、条数才降到 52。

### 6.2 读数计数：`[A-Z]` → `[A-Z0-9]+`

见 §4 末段。既有 step 的 `awk` 字符类是 `[A-Z]`，本臂有一条 `[A2]` 会漏计（9 vs 10）。本片在**本 step 内**改用
`[A-Z0-9]+`（`.github/workflows/real-pg-integration.yml:346`），未改动别的 step，也未改任何守卫。

### 6.3 该条目保持恰好 21 行

`docs/verification/**` 里有多处手写行号锚点指向 `tests/unit/ci-integration-chain-structure.test.mjs`，
删/增行都会让 `node tools/verify-doc-anchors.mjs --strict` 判 SUSPECT/BROKEN。故 `:172-192` 的条目是**等行数替换**
（`git diff --numstat` 读数 `15 15`，文件总行数 738 → 738），改后锚点读数仍是 §3 那一行（基线 13、新增 0、陈旧 0）。

## 7. step 参数：argv 契约结论

`tests/integration/admin-post-hide-audit-pg.mjs` 的连接串契约（`.mjs` 内实测）：

- `tests/integration/admin-post-hide-audit-pg.mjs:79` `const argvUrl = process.argv.slice(2).find((value) => /^postgres(ql)?:\/\//.test(value));`
- `:80` `const rawUrl = argvUrl ?? process.env[ENV];`，`ENV` 在 `:60` 是 `ADMIN_POST_HIDE_AUDIT_PG_TEST_URL`；
- `:95-96` 两道硬闸：host 只允许 `127.0.0.1`／`localhost`／`[::1]`；`url.pathname` 必须**恰好**是 `/${DB}`（`:59`）；
- `:81` `--allow-skip`／`GY_ALLOW_SKIP=1` 只把「缺连接串」从 exit 77 变成 exit 0（本机开发用）。

结论：**只需要一个 owner 连接串，不需要 runtime 连接串，也不建任何角色**（脚本不 `CREATE ROLE`、不依赖集群级角色）。
所以 step 只传 **1 个参数**（argv[2] 的 owner URL），不设 `*_PG_TEST_URL` 类 env —— 传 env 反而会留下
「argv 与 env 指向不同库」的假绿通道（判据⑧正是盯这个）。缺 URL 时脚本打印 SKIP 并 `:89 process.exit(77)`，
本 step 把 77 显式升级成硬失败，所以「连接串传丢了」不会静默变绿。

## 8. 未取得 / 未做

- **未取得**：本机无法复现 GitHub Actions runner 的真实环境（`postgres:17` 服务容器、owner 角色
  `gengyun_ci_owner` 与 `PGDATABASE=gengyun_ci_bootstrap` 的连接）。§4 的手跑用的是本机一次性集群 + 超级用户连接串，
  库名与脚本内硬钉常量完全一致；step 的环境变量取值照抄相邻 step（`.github/workflows/real-pg-integration.yml:352-357`），
  但**没有任何一次真实 CI 运行读数**。
- **未做**（超出本片授权）：push / PR / 合并；「教会判据 4 认 real-PG workflow」（§6.1 已登记为后续片）。
