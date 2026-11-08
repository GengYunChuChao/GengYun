# R90 CI 假红治理：PGDG 签名钥下载加重试（2026-11-09）

> 读数快照：2026-11-09（Asia/Hong_Kong）。下文日志时间戳是 GitHub 的 UTC，`2026-11-08T16:5xZ` ＝ HKT `2026-11-09 00:5x`。
> 基线 `9f09fcb3bf36d0ded290fb1187465e0b8550fdf1`（`origin/main`）。本单开工时 `origin/main` 是 `bc9c28d8…`，中途前进了
> 7 个提交到 `9f09fcb3`，但 `.github/**` 在这 7 个提交里**零变化**（`git diff --name-only bc9c28d8 9f09fcb3 -- .github/` 为空），
> 所以本页所有 workflow 行号按哪一版核都相同；§六 的计数已整体在 `9f09fcb3` 上重取，§七 的六道闸门也在 rebase 后的 HEAD 上重跑。
> 本提交改 `.github/workflows/real-pg-integration.yml` 的三行，**行数一个字符没变**（1796 行 → 1796 行；job 键仍在
> 94 / 945 / 1087 / 1331 / 1455 / 1581 / 1707），所以被引用的 workflow 行号不需要任何位移登记（§六 用闸门输出逐字比对证明）。
> 本页是「CI 假红」这一类问题的第二份记录，前一份是 [R89 读数闸门](gy-r89-readings-gate-pass-groups-20261108.md)。

## 一句话

`.github/workflows/real-pg-integration.yml` 里有四个 job 各自带同一段「安装 PG 17 服务端二进制」，它用 `curl`
现下 PGDG 签名钥 `ACCC4CF8.asc`。2026-11-09（HKT）这一天里，这一行在 4 个 run、7 次 job 上以
`curl: (56) Failure when receiving data from the peer` 结束——每次都发生在 `apt-get` 之前、任何断言之前，
重跑即绿。本提交给 `curl` 加 `--retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 15`，
给两条 `apt-get` 加 `-o Acquire::Retries=5`（`update` 另加 `-o Acquire::http::Timeout=30`）：
**只增加尝试次数，不改变任何失败语义**——`--fail` 还在，`apt-get install` 失败还是红，版本断言一行没动。

## 一、现场：7 次同形红，全部卡在同一行 `curl`

任务单上写的是「今天已连续三次」（failmatrix / real-pg / admin-read）。实测是 **7 次、4 个 run**，
多出 `real-pg-admin-write-17.11` 与 `42502309296` 的 attempt 2。全部同形：同一行命令、同一个 `curl: (56)`、
都在 `apt-get` 之前。下表按实测列全（`run_attempt` 是当时的 attempt 号）。

| # | run | attempt | job id | job | step | 该 step 时间窗（UTC） | 时长 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 42502309296 | 1 | 128797510034 | failmatrix-real-17.11 | 5 | 16:55:50.3257620 → 16:57:17.0135953 | 87.0 s |
| 2 | 42502309296 | 1 | 128797510107 | real-pg-17.11 | 28 | 16:56:43.7210621 → 16:58:06.5187994 | 82.8 s |
| 3 | 42502309296 | 2 | 128801896976 | failmatrix-real-17.11 | 5 | 17:12:43.3675186 → 17:14:11.7855691 | 88.4 s |
| 4 | 42504791342 | 1 | 128804980243 | failmatrix-real-17.11 | 5 | 17:24:28.3149168 → 17:25:56.1863393 | 87.9 s |
| 5 | 42504791342 | 1 | 128804980332 | real-pg-admin-read-17.11 | 6 | 17:24:40.0535304 → 17:27:30.9084711 | 170.9 s |
| 6 | 42504927390 | 1 | 128805388759 | failmatrix-real-17.11 | 5 | 17:26:09.2154818 → 17:26:57.8296306 | 48.6 s |
| 7 | 42505161137 | 1 | 128806108932 | real-pg-admin-write-17.11 | 6 | 17:29:13.9852492 → 17:30:03.7243387 | 49.7 s |

读法：

- 七个 job 的 step 名不同（按各自臂命名，例如 `.github/workflows/real-pg-integration.yml:591` 是
  「backup-purge / backup-copies / messages-purge / online-purge / retention-purge」，`.github/workflows/real-pg-integration.yml:1348`
  是「真 PG 臂自起集群需要 initdb/pg_ctl」），但 `run:` 块逐字相同，都是同一行 `curl` 先死。
- 时长分两簇：48.6～49.7 s 与 82.8～88.4 s（还有一个 170.9 s）。同一行命令、同一错误码、时长不同 ⇒
  卡在「等到对端收走连接」这一段，不是快速拒绝（快速拒绝会是毫秒级）。
- `42502309296` 现在的 `conclusion` 是 success，`run_attempt` 已是 3：`gh run rerun --failed` 后转绿，
  这正是「与代码无关」的直接证据——同一份 head `cbf33bf953520f3f1c829f7b03fd23791deb47c3` 的代码没变。

## 二、失败行原文（逐字）

这个 `run:` 块在日志里是先整段回显、再执行，所以失败行与它前后几行都在 `##[group]Run` 段里
（`\e[36;1m` 是 GitHub 给命令回显加的高亮前缀，下面按去掉 ANSI 后的原文抄）：

```text
2026-11-08T16:55:50.3256069Z ##[group]Run set -euo pipefail
2026-11-08T16:55:50.3256816Z sudo install -d /usr/share/postgresql-common/pgdg
2026-11-08T16:55:50.3257620Z sudo curl --fail --silent --show-error -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
2026-11-08T16:55:50.3258872Z echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list > /dev/null
2026-11-08T16:55:50.3260085Z sudo apt-get update
2026-11-08T16:55:50.3260486Z sudo apt-get install -y --no-install-recommends postgresql-17
2026-11-08T16:55:50.3285730Z ##[endgroup]
2026-11-08T16:57:17.0135953Z curl: (56) Failure when receiving data from the peer
2026-11-08T16:57:17.0180280Z ##[error]Process completed with exit code 56.
```

两点值得记下来：

- `##[endgroup]` 到 `curl: (56)` 之间 **86.7 秒没有任何一行输出**——`apt-get update` / `install` 一次都没被回显，
  说明失败点在 `curl` 内部，下载根本没完成。
- 没有 `E: Failed to fetch`、没有 `initdb --version` 的输出、没有 `::error::装出来的服务端不是 17`。
  最后一条 `##[error]` 是 runner 对非零退出的通用包装，不是我们断言打的。

## 三、改法：三行就地替换（逐字前后对照）

四个 job 各有一份，共 12 行改动（每 job 3 行 + 各自 1 处 `update` 行，其中 `install` 与 `update` 各 4 处=8 行、
`curl` 4 行 ⇒ 12 行）。下表的「行」是按 job 分的实际行号，全部在 `.github/workflows/real-pg-integration.yml`：

| 行 | job | 位置 |
| --- | --- | --- |
| 596 / 598 / 599 | real-pg-17-11（`.github/workflows/real-pg-integration.yml:94`） | curl / apt update / apt install |
| 982 / 984 / 985 | real-pg-admin-read-17-11（`.github/workflows/real-pg-integration.yml:945`） | 同上 |
| 1121 / 1123 / 1124 | real-pg-admin-write-17-11（`.github/workflows/real-pg-integration.yml:1087`） | 同上 |
| 1353 / 1355 / 1356 | failmatrix-real-17-11（`.github/workflows/real-pg-integration.yml:1331`） | 同上 |

### 3.1 下载签名钥

改前（`.github/workflows/real-pg-integration.yml:596` 等四处，缩进 10 空格）：

```text
          sudo curl --fail --silent --show-error -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
```

改后：

```text
          sudo curl --fail --silent --show-error --retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 15 -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
```

四个开关逐个说：

- `--retry 5`：失败后最多再试 5 次（合计最多 6 次尝试）。`--retry` 的默认白名单只含
  「瞬时/连接」类错误，**不含** 56 这类「收数据时对端断了」，所以要靠下一个开关放行。
- `--retry-all-errors`：把 `--retry` 的适用范围放宽到所有错误（curl 7.71+）。没有它，今天这 7 次一次都不会重试。
- `--retry-delay 3`：两次尝试之间至少等 3 秒，避免把「对端刚好在抖」变成「连续 6 次都撞在同一秒」。
- `--connect-timeout 15`：单次尝试里 TCP 建连最多 15 秒。今天卡的是收数据段（`curl: (56)`），这个开关**治不到**它，
  但它能挡住「对端连 SYN 都不回」那种把 `timeout-minutes: 5` 直接吃满的形态——两种形态的兜底各管一段。

### 3.2 `apt-get update`

改前（`.github/workflows/real-pg-integration.yml:598` 等四处）：

```text
          sudo apt-get update
```

改后：

```text
          sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update
```

### 3.3 `apt-get install`

改前（`.github/workflows/real-pg-integration.yml:599` 等四处）：

```text
          sudo apt-get install -y --no-install-recommends postgresql-17
```

改后：

```text
          sudo apt-get -o Acquire::Retries=5 install -y --no-install-recommends postgresql-17
```

`Acquire::Retries=5` 是 apt 的「同一 URI 失败后重新排队」次数；`Acquire::http::Timeout=30` 把它默认的
「空闲 120 秒才判失败」收紧到 30 秒，配合重试能在同一个 `timeout-minutes: 5` 里多试几轮。
两条都是 `-o` 命令行覆盖，**没有写进任何配置文件**，也没改 `apt-get` 的退出语义。

### 3.4 一行没动的东西

`sudo install -d …/pgdg`、`echo "deb [signed-by=…]" | sudo tee …`、`run: |`、`set -euo pipefail`、
`initdb --version` 与 `if [ "$server_major" != "17" ]` 版本断言（4 处 `::error::` 文案）、
`timeout-minutes: 5`、以及每个 step 的 `- name:` 文案，全部逐字未改。§六 的计数对照表把这几项都数了一遍。

## 四、为什么这不叫「吞错」

判定标准第 1 条要求「不吞错」，逐项对：

1. `curl` 仍然带 `--fail`：HTTP 4xx/5xx 仍然变成非零退出（`--fail` 4 处仍在，§六 有计数）。`--retry` 只改
   「试几次」，不改「试完还失败就退出非零」。本机实测（`curl 8.21.0`）：`--fail --retry 2 --retry-all-errors`
   对 404 仍打 `curl: (22) The requested URL returned error: 404` 并以非零退出。
2. `apt-get install` 失败仍红：`-o Acquire::Retries=5` 只影响取包，`apt-get` 取不到包时照旧打
   `E: Failed to fetch …` 并返回 100，`set -euo pipefail` 照旧让 step 死。
3. 没有 `continue-on-error`、没有 `|| true`（§六 计数：2 处与 3 处都是别处既有，这 12 行里一个都没有）。
4. 版本断言一个字没动：`if [ "$server_major" != "17" ]` 仍在四个块里，`::error::` 仍会打。
5. 重试耗尽后的最终结果仍是红。本机实测（同上）：`--retry 2` 打满 3 次尝试后 `EXIT=7`，不是 0。

换句话说：这次改动把「一次抖动 ⇒ 红」改成「六次里有一次成功 ⇒ 绿」，**没有**把任何一次失败变成成功。

## 五、可观测：下次抖动时日志里该出现什么

判定标准第 2 条要求「失败时日志见重试痕迹」。这一节把「该看到什么」写死，方便下次看日志的人对号：

- **curl 侧**：`curl: (56) Failure when receiving data from the peer` 仍会出现，但**不是一次就完**——
  `--retry 5` 下同一条错误行最多重复 6 次，相邻两次间隔 ≥ 3 秒（`--retry-delay`）。
  本机 `curl 8.21.0` 实测：`--silent --show-error` 组合下 curl **不打印** `Will retry in N seconds` 横幅
  （`--silent` 会吞掉 warn 级提示，`--show-error` 只放行 error 级），所以重试痕迹就是**同一条 `curl: (NN) …`
  行重复出现**＋时间戳间隔。真出现横幅也只是额外信息，不影响判读。
- **成功时**：能看到 `apt-get` 的 `Get:…` / `Setting up postgresql-17 …`，随后是版本断言的回显
  `initdb (PostgreSQL) 17.x`。今天这 7 次红在 `##[endgroup]` 之后**一行都没有**，下次只要看到 apt 的行，
  就说明 `curl` 那步过了。
- **六次都失败时**：仍是 `curl: (56) …` + `##[error]Process completed with exit code 56.`，与今天一模一样，
  只是晚了约 5×3 ≈ 15 秒（外加可能的 `--connect-timeout 15`）。
- **apt 侧**：`Acquire::Retries` 不打印计数横幅，重试痕迹是同一 URI 的获取行再次出现；无论重试几次，
  最终失败照旧是 `E: Failed to fetch …` + 非零退出。

⚠️ 这几条是给读日志的人对照用的，**不是新判据**：判据仍然是 exit code 与版本断言，本提交没有加任何
「日志里出现某字样才算过」的检查（那种检查会把日志文案变成契约，属判据面变更）。

## 六、行号零位移的证据

### 6.1 两段式取证

新增本页本身会抬高 `ANCHOR-COUNT` / `BARE-ORPHAN` 的绝对数，直接拿「改后」跟「改前」比会把「本页自己带来的增量」
和「yaml 位移」混在一起。所以拆成两段：

- **阶段 B**：只改 yaml、不写本页。在 `9f09fcb3` 上另开一个 worktree（除 yaml 外一个文件没动），把改后的
  `.github/workflows/real-pg-integration.yml` 覆盖进去再跑同一条闸门：输出与「未改」那一份**逐字节相同**，EXIT 0
  ⇒ yaml 改动零锚点位移（这一条是本次改动唯一会碰 workflow 的地方，所以它把「零位移」证完了）。
- **阶段 C**：写入本页后再跑同一条，增量全部来自本页自身（§6.2 逐行对照）。

### 6.2 关键计数对照（改前 / 阶段 B / 阶段 C）

| 判据 | 改前（`9f09fcb3` 原样，EXIT 0） | 阶段 B（只改 yaml） | 阶段 C（含本页） |
| --- | --- | --- | --- |
| `ANCHOR-COUNT` 进判据锚点 | 8825 条 / 296 份文档（上升 107 份、下降 0 份） | 逐字节相同 | 8835 条 / 297 份文档（+10 条 / +1 份，增量全部来自本页） |
| `BARE-ORPHAN` 裸锚点 | 3469 条（基线外新增 0、陈旧 0） | 逐字节相同 | 3469 条（新增 0、陈旧 0）—— 与基线逐字相同 |
| `BARE-ORPHAN-OUTSIDE` 作用域外 | 117 条（新增 0、陈旧 0） | 逐字节相同 | 117 条（新增 0、陈旧 0）—— 与基线逐字相同 |
| `SYMBOL-LINE` 可判（`docs/architecture/**`） | 903 条：代码行 865 / 注释 25 / 逐字 3 / 文档注释 10（判红 8） | 逐字节相同 | 903 条：代码行 865 / 注释 25 / 逐字 3 / 文档注释 10（判红 8）—— 与基线逐字相同 |
| `SYMBOL-STRICT-BASELINE` | 登记 25、命中 25、新增 0、陈旧 0 | 逐字节相同 | 登记 25、命中 25、新增 0、陈旧 0 —— 与基线逐字相同 |
| `SYMBOL-COVERAGE-VERIFICATION` | 不在区间 44 / UNDECLARED 252 / 配成对 1266 | 逐字节相同 | 不在区间 44 / UNDECLARED 252 / 配成对 1266 —— 与基线逐字相同 |

阶段 C 的三类预期：`ANCHOR-COUNT` 的总条数与文档份数各 +1 份本页的锚点数；`BARE-ORPHAN` 不变（本页的锚点全部写成
完整 `path:NNN`，没有裸 `:NNN`）；`SYMBOL-*` 不变（本页不落 `docs/architecture/**` 作用域）。

### 6.3 复核脚本

除闸门外另跑了一份针对性复核（`node probe-invariants.mjs <repo> <path> origin/main <worktree>`，脚本不入库），
对 `origin/main` 与工作树逐字比 `.github/workflows/real-pg-integration.yml`：

- 行数恒等：1797 个 `split('\n')` 元素（文件 1796 行 + 末尾空串）两边相同。
- 变化行正好 12 行：596, 598, 599, 982, 984, 985, 1121, 1123, 1124, 1353, 1355, 1356；每处都保持原 10 空格缩进，
  且都只落在 `curl` / `apt-get` 行上。
- 结构计数改前=改后：`curl --fail` 4、`ACCC4CF8.asc` 4、`apt-get install` 4、`$server_major != 17` 断言 7、`::error::` 4、
  `run: |` 28、`set -euo pipefail` 28、`continue-on-error` 2（既有、别处）、`|| true` 3（既有、别处）、`timeout-minutes: 5` 68。
- job 键行号逐个相同：94 / 945 / 1087 / 1331 / 1455 / 1581 / 1707（`pull_request:` 在 66、`push:` 在 67）。
- 结论行 `RESULT=PASS`。

### 6.4 另两个 workflow：核过，不需要改

- `.github/workflows/engineering-shell.yml`（174 行）：没有 `apt-get`、没有 `postgresql-17`、没有 `ACCC4CF8`。
- `.github/workflows/deploy-sql-gate.yml`（548 行）：不现场装服务端——两个 job 都用 `services:` 容器
  `image: postgres:17.11`，所以没有这一行可加。按任务指令**不改**它，只在 §九 登记建议。
- 全仓 workflow 里 `ACCC4CF8` 只出现在 `.github/workflows/real-pg-integration.yml` 的 4 行
  （596 / 982 / 1121 / 1353），所以「逐一检查所有含这一步的 workflow」的结论就是上面三条。

## 七、六道闸门

全部在最终 HEAD 上跑（`.github/workflows/real-pg-integration.yml` 12 行替换 + 本页新增，无其他文件）：

| # | 闸门 | EXIT | 尾行 |
| --- | --- | --- | --- |
| 1 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | 0 | `PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）` |
| 2 | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | 0 | `ℹ tests 37 / pass 36 / fail 0 / skipped 1`（skip 那条正是「纯新增 docs 提交没有锚点位移面」） |
| 3 | `node tools/verify-contract-status.mjs` | 0 | `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` |
| 4 | `npm run test:docs` | 0 | `PASS: 识别 5 页 / 跳过 359 页（扫描面 364 页：docs/verification）——读数七条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字 ⑦同页副本一致）` |
| 5 | `git merge-tree --write-tree --name-only origin/main HEAD` | 0 | 只打印一棵树、没有任何冲突文件名（当轮 `origin/main`＝`9f09fcb3`） |
| 6 | `git diff --name-only origin/main...HEAD` | 0 | `.github/workflows/real-pg-integration.yml`、`docs/verification/gy-r90-ci-pg-install-retry-20261109.md`（只有这两条） |

附带读数（读 yml 的既有测试，也是本提交的 yaml 合法性验证手段——`node_modules` 里既没有 `yaml` 也没有 `js-yaml`，
python 也没有 yaml 模块，所以用仓库既有手段）：

- `node --test tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-real-pg-step-timeouts.test.mjs tests/unit/ci-real-pg-workflows-structure.test.mjs tests/unit/ci-gate-prose-consistency.test.mjs`
  ⇒ 64 个用例全绿：`tests 64 / pass 64 / fail 0`
- `node tools/verify-g-drill-readings.mjs --check` ⇒ `✓ 八条判据全过：workflows 15 / jobs 29 / 演练 21 条 / 测试文件 608（glob 合计 578）；生长型读数按**下界**判（--tolerant-growth），其中 8 条滞后已逐行打印`

## 八、本页**没有**做的事（不声称）

1. **不声称根除抖动。** 重试只是把「单次抖动即红」放宽成「六次里有一次成功就绿」。今天这 7 次每次都在**同一个
   `curl` 调用内部**卡了近 87 秒才报 56，重试最多再加 5×(0.5 秒建连 + 3 秒间隔)；若一整天都在抖，照样会红。
2. **不声称改了判定语义。** `--fail` 还在、`apt-get install` 失败仍红、`server_major != 17` 断言一字未动、
   没有 `continue-on-error`、没有 `|| true`、没有删任何断言。
3. **不声称覆盖所有外部下载点。** 本单只处理 `ACCC4CF8.asc` 这一处；仓库里其他外部依赖点
   （`npm ci`、`docker pull`、其他 `curl`/`wget` 下载、`gh api`）没有盘点和加固。
4. **不声称改动了 step 超时。** `timeout-minutes: 5` 一个字没动——因为 `tests/unit/ci-real-pg-step-timeouts.test.mjs:227`
   钉死每个 step 的封顶，改它属判据面变更。由此有一个已知代价要记账：最坏情况六次全卡（6×~88 s + 5×3 s ≈ 9 分钟）
   **会先撞 step 封顶**，红因从 `Process completed with exit code 56` 变成 step 超时。仍然红、仍然与代码无关，
   但这是本改法的天花板。
5. **不声称降低 CI 时长。** 正常情况下 `--retry*` 零成本（只有失败时才等 3 秒），但也**不会**让绿的 job 变快。
6. **不声称这 7 次是同一个根因。** 只能证明失败位置、错误码、时长同形；runner 日志不会告诉我们上游是哪一段网络。
7. **不声称「重试救回来了」。** 本提交没有任何一次运行是靠重试救回的记录（改动尚未在任何一次抖动上被观测到）。
   下次若绿，也不能单独归因于本改动——这种抖动本来就是间歇的。
8. **不声称 `--connect-timeout 15` 能治今天这种卡法。** 今天卡在收数据段（`curl: (56)`），`--connect-timeout`
   只管建连段；它挡的是另一种形态（连 SYN 都不回）。

## 九、建议（另开单，本提交不改）

`real-pg-admin-read-17.11` / `real-pg-admin-write-17.11` / `real-pg-ledger-17.11` / `real-pg-jobs-ledger-17.11`
这几条臂里，凡是不需要 `initdb` / `pg_ctl` 自起集群、只要一个能连的 PG 17 的，都可以改用
`services:` 容器（`image: postgres:17.11`）——`.github/workflows/deploy-sql-gate.yml` 已经这么干，
那样「现场 apt 装服务端」整步就不存在，抖动面从根上去掉。

**但本提交不动它**：把一条臂从「自起集群」换成「容器服务」是判据面变更（臂验证的东西变了），
按任务指令只登记、另开单。
