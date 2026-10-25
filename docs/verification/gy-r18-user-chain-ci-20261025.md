# 证据页：用户链路端到端接进真库 job（GY-R18，2026-10-25）

**一句话结论**：`tests/integration/user-chain-e2e.mjs`（P0「登录→手选→查询→详情→收藏/取消→退出」整链，
**119 条断言 / 6 步**）原先**从未接过 CI**，本片把它接进 `.github/workflows/real-pg-integration.yml` 的
独立 step，并把脚本的 env 键**对齐**既有守卫形状（`GY_PG_BIN` ＋ 唯一的 `GY_*_PG_ROOT`），
守卫 `node --test tests/unit/ci-real-pg-wiring.test.mjs` **18/18 通过**，
本机真跑 **`PASS 119 条断言 / 6 步`（PostgreSQL 17.11）**。
**未取得**：GitHub runner 上的首次读数（本机只能给等价环境的本地读数，见 §3、§5）。

## 1. 交付落点

| 文件 | 做了什么 | 复核方式 |
| --- | --- | --- |
| `tests/integration/user-chain-e2e.mjs` | **只动 env 键与提示文本，119 条断言一行未改**：PG bin 键 → `GY_PG_BIN`（旧 `USER_CHAIN_PG_BIN` 作过渡别名保留），数据根目录键 → `GY_USER_CHAIN_PG_ROOT`（旧 `USER_CHAIN_PG_DATADIR` 作过渡别名保留）；缺 PG17 仍 `return 77` | 真库臂本身 |
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

⚠ 这台机器的 223 s 不代表 CI；同一脚本在指挥机上是 **13165 ms**（含 initdb 约 17 s）。
怀疑本机 `E:` 盘 + 沙箱文件 ACL 让 `initdb` 落盘与 41 段迁移的事务提交都变慢。两个读数都 ≪ job 的
`timeout-minutes: 15`。

## 4. 为什么接真库 job 却仍不进 `test:integration:http`

`test:integration:http` 是**无 PG** 的回环链，这条脚本在没有 PG17 时只会 `exit 77`；
把它塞进那条链等于让整链在无 PG 机器上红。故落法与其它真库臂一致：进 `real-pg-integration.yml` 的独立 step，
在 `ci-integration-chain-structure.test.mjs` 里**如实登记**它不进回环链。

`77` 是**未取得**，⛔ 不是通过：step 里不得加 `continue-on-error`、不得把 77 兜成 0，
缺 `GY_PG_BIN` 时该臂就该红（守卫的 `swallowedFailureHits` 与 `SELF_CLUSTERED_PG_BIN_ENV` 一起钉这一条）。

## 5. 未取得

1. **GitHub runner 上的首次真跑读数**——本机没有该 runner，只能给 §3 的等价本地读数；首个 PR 的
   `real-pg-17.11` job 才能给出 CI 读数，届时应回填本节。
2. **CI 增量耗时实测**——按 §3 的两个读数（13.2 s / 223 s）与既有同 job 臂的量级，预计该 step 的
   增量在**数十秒**量级（装 `postgresql-17` 的 apt step 与本 job 共用，不重复计），远低于 15 min 上限；
   精确值同样等 CI 首跑。
3. 生产/受限环境读数（本片不涉及）。
