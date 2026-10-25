# 证据页：用户链路端到端接进真库 job（GY-R18，2026-10-25）

**一句话结论**：`tests/integration/user-chain-e2e.mjs`（P0「登录→手选→查询→详情→收藏/取消→退出」整链，
**119 条断言 / 6 步**）原先**从未接过 CI**，本片把它接进 `.github/workflows/real-pg-integration.yml` 的
独立 step，并把脚本的 env 键**对齐**既有守卫形状（`GY_PG_BIN` ＋ 唯一的 `GY_*_PG_ROOT`），
守卫 `node --test tests/unit/ci-real-pg-wiring.test.mjs` **18/18 通过**，
本机真跑 **`PASS 119 条断言 / 6 步`（PostgreSQL 17.11，热跑 15462 ms）**。
**CI 首跑红了**（`pg_ctl start` 报 `could not create lock file "/var/run/postgresql/…": Permission denied`，
0 条断言），**已修**：一次性集群显式 `-k <数据目录>`（见 §4；Windows 不编译 unix socket ⇒ 本机测不出）。
**仍未取得**：修复**后**的 CI 首跑读数（本页不据此写成「CI 已绿」，见 §6）。

## 1. 交付落点

| 文件 | 做了什么 | 复核方式 |
| --- | --- | --- |
| `tests/integration/user-chain-e2e.mjs` | **只动 env 键与提示文本，119 条断言一行未改**：PG bin 键 → `GY_PG_BIN`（旧 `USER_CHAIN_PG_BIN` 作过渡别名保留），数据根目录键 → `GY_USER_CHAIN_PG_ROOT`（旧 `USER_CHAIN_PG_DATADIR` 作过渡别名保留）；缺 PG17 仍 `return 77`；另外修掉 CI 首跑红的 socket 目录（`-k`，见 §4） | 真库臂本身 |
| `.github/workflows/real-pg-integration.yml` | 新增一条**自起集群** step（第 15d 条位置）：`GY_PG_BIN=/usr/lib/postgresql/17/bin`、`GY_USER_CHAIN_PG_ROOT=${{ runner.temp }}/gy-user-chain-pg`、`PGCLIENTENCODING=UTF8`，复用同 job 已有的 `postgresql-17` 装包 step；`⛔` 不 `CREATE DATABASE`、不加 `continue-on-error`／`if:`／吞红兜底 | YAML 解析 + 下面那份 wiring 门禁 |
| `tests/unit/ci-real-pg-wiring.test.mjs` | `MANAGED_SCRIPTS`／`FROZEN_MANAGED_SCRIPTS`／`REQUIRED_STEP_ORDER`（紧跟 `retention-purge-pg`、仍在 `recognition-chain-e2e` **之前**）各 +1（16→17），`SELF_CLUSTERED_SCRIPTS` +1（5→6）与 `SELF_CLUSTERED_ROOT_KEY` +1（`GY_USER_CHAIN_PG_ROOT`） | `node --test tests/unit/ci-real-pg-wiring.test.mjs` |
| `tests/unit/ci-integration-chain-structure.test.mjs` | `UNWIRED_DECLARATIONS` 的 user-chain-e2e 理由更新为「已接进真库 job，但**仍不进**无 PG 的 `test:integration:http`」 | `node --test tests/unit/ci-integration-chain-structure.test.mjs` |

## 2. 读数一：守卫（纯静态，双向）

```
$ node --test tests/unit/ci-real-pg-wiring.test.mjs
ℹ tests 18   ℹ pass 18   ℹ fail 0

$ node --test tests/unit/ci-integration-chain-structure.test.mjs tests/unit/integration-script-coverage.test.mjs
ℹ tests 13   ℹ pass 13   ℹ fail 0
```

正向覆盖：新 step 在 `MANAGED_SCRIPTS`／`FROZEN_MANAGED_SCRIPTS`／`REQUIRED_STEP_ORDER` 三表同集合、
落在**独立** step；`SELF_CLUSTERED_SCRIPTS ⊆ MANAGED_SCRIPTS` 且 `selfCluster` 计数＝豁免表长度；
`scriptsRunByWorkflow` 与受管集合排序后逐条相等；自起集群判据（`GY_PG_BIN` 落在 `/bin` 结尾的目录、
根键＝脚本源码真值 `GY_USER_CHAIN_PG_ROOT`、根值含 `${{ runner.temp }}`、步内无 `CREATE DATABASE`）全绿。

**负控制 M1（实测，跑完已还原）**：把新 step 的 `GY_USER_CHAIN_PG_ROOT:` 改成 `GY_I19_PG_ROOT:` ⇒
判据⑥红，且两条问题都点名 `tests/integration/user-chain-e2e.mjs`：① 该 step **没有**它自己读的根键
`GY_USER_CHAIN_PG_ROOT`；② 它给的 `GY_I19_PG_ROOT` 只是一条**装饰性 env**（守卫绿了脚本照样落 `os.tmpdir()`，
这正是 `SELF_CLUSTERED_ROOT_KEY` 要钉的缺陷形态）。还原后复跑 18/18。

§4 的 socket 修复（只动 `pg_ctl` 的 `-o` 拼接，不碰 workflow 与守卫表）之后复跑：
`ci-real-pg-wiring` 仍 **18/18**（`duration_ms 766.9223`）；
`npm run test:unit`（`GY_BASH=D:\Git\bin\bash.exe`）**4709 tests / 4706 pass / 0 fail / 1 skipped / 2 todo**，
exit 0（墙钟 161 s）。那两条 `todo` 是既有的 I11「MP3/供应商错误码」缺口，带 `todo` 不计失败。

## 3. 读数二：本机真跑（Windows，PG 17.11）

```
$ GY_PG_BIN=E:\GengYunCommander\.pg17\pgsql\bin \
  GY_USER_CHAIN_PG_ROOT=E:\GengYunCommander\.pg17\tmp\r18-uchain-wire \
  node tests/integration/user-chain-e2e.mjs
PASS 用户链路端到端：119 条断言，6 步，耗时 223250 ms（PostgreSQL 17.11 / http://127.0.0.1:62442）
EXITCODE=0
```

含 `initdb` 的墙钟 **279 s**；迁移 **41** 段（第二轮重复 **0**）；跑完脚本自删数据目录（`pg_ctl stop` 后逐文件删除），
`<root>` 已清空。**新键生效的证据**：全程**未设**旧别名 `USER_CHAIN_PG_DATADIR`，数据目录落在
`<root>/gengyun-user-chain-pg-<RUN_ID>` 而不是系统 TEMP。

⚠ **读数更正（后来实测推翻上面 223 s 的「本机慢 17×」判断）**：上面那条 223250 ms 是**冷缓存假象**——
修 unix socket 目录时用同一个键热跑一次是：

```
$ GY_PG_BIN=E:\GengYunCommander\.pg17\pgsql\bin \
  GY_USER_CHAIN_PG_ROOT=E:\GengYunCommander\.pg17\tmp\r18-uchain-k \
  node tests/integration/user-chain-e2e.mjs
PASS 用户链路端到端：119 条断言，6 步，耗时 15462 ms（PostgreSQL 17.11 / http://127.0.0.1:58257）
（含 initdb 墙钟 29 s；迁移 41 段、重复 0；跑完自删数据目录）
```

**15462 ms** 与指挥机上的 **13165 ms** 同量级 ⇒ 先前「本机比指挥机慢 17×」的判断作废，
不要把 223 s 当成本机或 CI 的代表读数。两个读数都 ≪ job 的 `timeout-minutes: 15`。

## 4. CI 首跑：红了 → 已修（一次性集群的 unix socket 目录）

`#595` 的 `real-pg-17.11` 上这条臂**首次真跑就红**，红在**集群启动**、不在断言（**0 条断言、620 ms**）：

```
FAIL 用户链路端到端：Command failed: /usr/lib/postgresql/17/bin/pg_ctl -D /home/runner/work/_temp/gy-user-chain-pg/gengyun-user-chain-pg-5884-mvo04rhu -l ... -w -t 60 -o -p 41739 -c listen_addresses=127.0.0.1 start（已跑 0 条断言，620 ms）
--- postgres log ---
LOG:  listening on IPv4 address "127.0.0.1", port 41739
FATAL:  could not create lock file "/var/run/postgresql/.s.PGSQL.41739.lock": Permission denied
LOG:  database system is shut down
```

失败点在 `waitForReady()` **之前**——`pg_ctl start` 就退出了，所以 119 条断言行一条都没跑，
耗时只有 620 ms（真跑一遍要十几秒）。这种「红得很早」的形态容易被误读成脚本坏了，实际是集群没起来。

**机制（为什么本机永远测不出）**：Debian/Ubuntu 的 `postgresql-17` 把 `unix_socket_directories` 的
**编译默认值**钉在 `/var/run/postgresql`；`initdb` 出来的集群沿用该默认值（脚本没在 `postgresql.conf` 里
覆盖它），而 `-o` 里只覆盖了 `-p` 与 `listen_addresses` ⇒ `runner` 用户对 `/var/run/postgresql` 无写权限，
socket 的 lock 文件建不出来。而 **Windows 版 PostgreSQL 不编译 unix-domain socket**：`pg_ctl` 在 win32 上
根本不建这个 lock 文件，`unix_socket_directories` 也被忽略 ⇒ 这条失败路径在本机**不存在**。
这是「本地绿 ≠ CI 绿」的一个具体形态，值得后来人记住：**平台根本不编译的东西，本机跑多少遍都测不出来**，
只能靠「与既有脚本逐字对齐」来继承别人踩过的坑。

**修法**（只改脚本，`.github/**` 一行未动；照全仓既有约定——10 个 `*pg.mjs` 的 `serverOptions()` 逐字同款）：

```js
const startOptions = [`-p ${port}`, '-c listen_addresses=127.0.0.1', '-c max_connections=32'];
if (process.platform !== 'win32') startOptions.push(`-k ${dataDir}`);  // ↖ socket 目录显式指到数据目录
runDetached(pgTool(pgBin, 'pg_ctl'), ['-D', dataDir, '-l', logFile, '-w', '-t', '60',
  '-o', startOptions.join(' '), 'start']);
```

⚠ `-o` 只收**一个**字符串：把数组直接当 arg 传会被 `String()` 用 `,` 拼成 `-p 55902,-c …`，
postgres 报 `FATAL: invalid value for parameter "port": "55902,-c"`（`media-row-purge-pg.mjs:157-159`
记过这个坑）⇒ 必须 `join(' ')`。`-k` 只在非 win32 加（Windows 上没有 unix socket，加了会报错），
故本机行为不变：修复后复跑仍 PASS（见 §3 更正后的 15462 ms 读数）。

## 5. 为什么接真库 job 却仍不进 `test:integration:http`

`test:integration:http` 是**无 PG** 的回环链，这条脚本在没有 PG17 时只会 `exit 77`；
把它塞进那条链等于让整链在无 PG 机器上红。故落法与其它真库臂一致：进 `real-pg-integration.yml` 的独立 step，
在 `ci-integration-chain-structure.test.mjs` 里**如实登记**它不进回环链。

`77` 是**未取得**，⛔ 不是通过：step 里不得加 `continue-on-error`、不得把 77 兜成 0，
缺 `GY_PG_BIN` 时该臂就该红（守卫的 `swallowedFailureHits` 与 `SELF_CLUSTERED_PG_BIN_ENV` 一起钉这一条）。

## 6. 未取得

1. **修复后的 CI 首跑读数仍未取得**——§4 的红是修复**前**的首跑，§3 的本机读数（无论 223 s 还是
   15.5 s）都不是 CI 读数；本页**不**据此写成「CI 已绿」。等重跑出数再回填本节。
2. **CI 增量耗时实测**——按 §3 更正后的两个读数（指挥机 13.2 s / 本机热跑 15.5 s），该 step 的增量预计
   **15–30 s**（装 `postgresql-17` 的 apt step 与本 job 共用，不重复计），远低于 15 min 上限；精确值等 CI 出数。
3. 生产/受限环境读数（本片不涉及）。
