# R28-W13 真库 CI 接线：两只「已登记未接线」的真库臂

日期：2026-10-21
分支：`test/gy-r28-w13-real-pg-wiring`（基点 `f5cca8b`，即 `origin/main`）
交付性质：**接线准备**（⛔ 本片没有修改 `.github/workflows/real-pg-integration.yml`，也⛔ 没有修改任何门禁文件）

## 0. 结论（先读这段）

**本片是「接线准备」，不是「真接线」。**

要接的两只真库臂——`tests/integration/online-purge-pg.mjs`（W6／`#407`）与
`tests/integration/messages-purge-pg.mjs`（W11／`#405`）——**此刻都还不存在于 `origin/main`**：
它们的 PR 都是 OPEN、`mergeCommit` 为 `null`。在 workflow 里引用一个不存在的文件，会让
`real-pg-integration.yml` 的 `npm ci` 之后**第一个 step 就 ENOENT 变红**，而本片又拿不到 CI 读数
（不 push），无法事后发现。因此本片改为交付：

1. **逐行、可照抄的接线草案**（workflow ＋ 两份门禁文件的精确锚点与逐字插入内容，见 §3）；
2. **预演读数**：草案在 `f5cca8b` 树上临时落盘后，两份门禁**全绿**（16 条受管脚本／30 条声明，见 §4）；
3. **负控制读数**：把草案的任一处真删掉/改错，门禁**必红并逐字点名**该脚本或该键（6 条，见 §5）；
4. **本机真跑读数**：`messages-purge-pg.mjs` 在本机 PG 17.11 上 `ALL PASS` 8 条（见 §6）；
5. **交接清单**：`#407`／`#405` 合入后由谁、按什么顺序执行、按什么判据验收（见 §8）。

一句话给接手的人：**先把 `#407` 与 `#405` 合进 main，再把本页 §3 的草案照抄落盘，跑 §7 的判据清单。**

## 1. 判定依据（gh / git 读数，原样）

```
$ git rev-parse HEAD
f5cca8b73d7190f0276e104cf9cf4889e91a4036
$ git rev-parse --abbrev-ref HEAD
test/gy-r28-w13-real-pg-wiring

$ git log origin/main --oneline -5
f5cca8b docs(verify): 汇总 #16/#17/#7/#8 的真库与门禁证据 (#403)
805b15c fix(i15): … (#399)
903ec8a fix(i14): … (#401)
e57b2f8 test(ci): 把 backup-copies-purge-pg 接进真库 CI（第 13 个受管脚本）(#400)
35cddc8 docs(verification): … E4 (#402)

$ gh pr view 407 --json state,mergeCommit,headRefName
{"state":"OPEN","mergeCommit":null,"headRefName":"feat/gy-r28-w6-deletion-clock",
 "title":"feat(privacy): 七日在线数据按时钟执行 + 回执 backupState 由真行推导（Refs #19）"}

$ gh pr view 405 --json state,mergeCommit,headRefName
{"state":"OPEN","mergeCommit":null,"headRefName":"test/gy-r28-w11-messages-pg-evidence",
 "title":"test(messages): 补 #17 消息域注销行数的真 PG 证据臂（他人行原样、台账按 scope 前缀删）"}

$ git ls-tree --name-only origin/main -- tests/integration/ | grep -E 'online-purge|messages-purge'
（无输出）
```

`tests/integration/` 下 main 现有的 purge 类脚本只有两只：`backup-purge-pg.mjs`、
`backup-copies-purge-pg.mjs`（后者就是 `#400` 接进去的第 13 条受管线，本片的写法完全照它）。

## 2. 为什么不能现在就接（以及一条被派单写反了的事实）

### 2.1 文件不存在 ⇒ 接线即红

`#400`（E5）把 `backup-copies-purge-pg.mjs` 接进真库 job 时，那个脚本**已经在 main 上**。
本次两只脚本还在各自 PR 分支上，若现在就把 `run: node tests/integration/online-purge-pg.mjs`
写进 workflow：

- `ci-real-pg-wiring.test.mjs` 的判据①只核对「受管脚本是否出现在某 workflow 的 `run:` 命令文本」，
  它**读不到「该文件是否存在」**（那是另一条门禁的事）⇒ 门禁会**绿**；
- 真 CI 会在那个 step 上 `Cannot find module` ⇒ **红**。

也就是说，门禁绿而 CI 红——这正是「必须先合脚本、再接线」的顺序理由，本片不越这一步。

### 2.2 W6 的脚本还依赖 `#407` 才有的产品代码（本机实测）

在本片树上（`f5cca8b`）直接跑 `online-purge-pg.mjs`，连「缺 env ⇒ 77」都到不了：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  …/wt-w13-ci-wiring/services/api/src/privacy/backup-state-derivation.ts
  imported from …/wt-w13-ci-wiring/tests/integration/online-purge-pg.mjs
(node:… ) → exit code 1
```

`services/api/src/privacy/backup-state-derivation.ts` 与 `online-purge-driver.ts` 是 `#407` 新增的
（main 上两者都不存在）。⇒ 本片**物理上无法**完成「本机真跑 W6」这一项，如实计入未取得（§9）。

### 2.3 ⚠️ 派单里的第 2 条与事实相反：声明**不能**删，只能**改写**

派单要求「从 `UNWIRED_DECLARATIONS` 移除对应条目」。实测相反：

- main 的 `tests/unit/ci-integration-chain-structure.test.mjs` 里，`UNWIRED_DECLARATIONS` 共 **28 条**，
  **既没有** `online-purge-pg.mjs` **也没有** `messages-purge-pg.mjs`——这两条声明是 `#407`／`#405`
  各自在自己的 PR 里加的，main 上还不存在。
- 该文件判据 4 是「`tests/integration` 下的脚本，只要没进 `test:integration:http` 回环链，就必须在
  `UNWIRED_DECLARATIONS` 里显式声明」。这两只脚本**都是自起集群、缺 env 就 77**，
  ⛔ 不可能也不应该进无 PG 的回环链 ⇒ **一旦删掉声明，判据 4 立刻红**（本片已实测，见 §5 负控制 D/E）。
- 正确做法（也是 `backup-copies-purge-pg.mjs` 的既有范式）：**保留声明、改写 reason**，
  从「尚未接进任何 workflow」改写成「已接真库 job，但仍在无 PG 回环链之外，故如实登记为未接线」。

## 3. 接线草案（逐文件、逐锚点、逐字）

预演后的 `git diff --numstat`（在 `f5cca8b` 树上，三个文件、逐字对应下文）：

```
28      0      .github/workflows/real-pg-integration.yml
27      0      tests/unit/ci-integration-chain-structure.test.mjs
85      21     tests/unit/ci-real-pg-wiring.test.mjs
```

### 3.1 `.github/workflows/real-pg-integration.yml`：+28 / −0

**锚点**：文件现 286 行。插在第 **251** 行（`backup-copies` step 的 `PGCLIENTENCODING: UTF8`）之后、
第 **252** 行（`# 识别端到端链路…` 注释）之前。**不动**任何既有 step，**不动**第 214 行那条装包 step
（`postgresql-17` 只装一次，两只新脚本都复用 `/usr/lib/postgresql/17/bin`），**不新增任何 `uses:`**
（全文件仍只有 checkout `11bd71901bbe5b1630ceea73d27597364c9af683` 与 setup-node
`49933ea5288caeca8642d1e84afbd3f7d6820020` 两条，都钉满 40 位 SHA）。

插入内容（逐字，含缩进）：

```yaml
      # 在线数据七日到期清除（#19 的七日时钟 ＋ 回执 `backupState` 由真行推导，W6／`#407` 的脚本）：与前两步同属
      # **自起集群**类，复用那条装包 step 装出来的 `/usr/lib/postgresql/17/bin`，同样**不** `CREATE DATABASE`。
      # 它自己 `initdb` 出临时 17 集群（端口 55600+randomInt(0,300) 且**先探活**、只监听 127.0.0.1、
      # `DB_NAME = gy_w6_online_purge`、跑完 `pg_ctl stop` 并递归删数据目录），并**注入固定时钟**
      # （`CUTOFF = 2026-04-01T00:00:00.000Z`）——不读墙钟，故这条臂不会到某个日期自己变红。
      # 它要真跑 `deploy/postgres-cvm/sql/20-login-roles.sql` 的四域 GRANT，才能断言运行时角色「能删/不能删」的形状。
      # 缺 `GY_PG_BIN` 时打印 SKIP 并 exit 77 ⇒ 装包或路径没弄好必红（77 是未取得，不是通过，也没加任何吞红构造）。
      - name: 在线数据七日到期清除（#19 / 迁移 0023 / 回执 backupState 由真行推导）
        run: node tests/integration/online-purge-pg.mjs
        env:
          GY_PG_BIN: /usr/lib/postgresql/17/bin
          GY_I19_PG_ROOT: ${{ runner.temp }}/gy-i19-pg
          PGCLIENTENCODING: UTF8
      # 消息域注销行数（#17 的 C5「该域行被硬删且行数入证据」，W11／`#405` 的脚本）：同类自起集群，
      # 复用同一份 bin、同样**不** `CREATE DATABASE`（`DB_NAME = gengyun_messages_purge_test`，端口 55700–55999
      # 且**先探活**——刻意避开开发机上遗留的 55436）。
      # 它走**产品真实路径**（`privacy/user-data-deletion.ts` 的协调器 → `messages/store-pg.ts` 的 `purgeOwnerData`），
      # 在运行时角色 `gengyun_api_runtime` 上实测表级 DELETE 授权形状，再断言「本主体 0 行／他人原样」。
      # 数据根目录的键名是 `GY_W11_PG_ROOT`（脚本 `:92` 读它，⛔ **不是** `GY_I19_PG_ROOT`）：给错键只会让 step 里
      # 多一条装饰性 env，脚本照样落 `os.tmpdir()`；故守卫按脚本映射键名（`SELF_CLUSTERED_ROOT_KEY`）。
      # 缺 `GY_PG_BIN` 时打印 SKIP 并 exit 77（它刻意不提供任何放宽跳过的开关）。
      - name: 消息域注销行数（#17 / 迁移 0019 messages + 0008 idempotency_keys）
        run: node tests/integration/messages-purge-pg.mjs
        env:
          GY_PG_BIN: /usr/lib/postgresql/17/bin
          GY_W11_PG_ROOT: ${{ runner.temp }}/gy-w11-pg
          GY_W11_PG_LOG: ${{ runner.temp }}/gy-w11-pg.log
          PGCLIENTENCODING: UTF8
```

**env 不是猜的**，逐条对得上脚本头部：

| env | 脚本契约（行号取自各自 PR 分支的脚本本体） | 是否必填 |
| --- | --- | --- |
| `GY_PG_BIN` | `online-purge-pg.mjs:63` `binDir`；`messages-purge-pg.mjs:63` `binDir`。两脚本都 `assert.ok(existsSync(tool('initdb')))`（`:148` / `:166`），缺它打印 SKIP 并 `process.exit(77)`（`:61` / `:66-70`） | **必填** |
| `GY_I19_PG_ROOT` | `online-purge-pg.mjs:94` `const rootDir = process.env.GY_I19_PG_ROOT ?? tmpdir();` | 选填（缺省 `os.tmpdir()`，故 CI 里必须显式给） |
| `GY_W11_PG_ROOT` | `messages-purge-pg.mjs:92` `const rootDir = process.env.GY_W11_PG_ROOT ?? tmpdir();` | 选填（同上） |
| `GY_W11_PG_LOG` | `messages-purge-pg.mjs:75` 服务端日志路径 | 选填 |
| `PGCLIENTENCODING: UTF8` | 与既有 `backup-purge`／`backup-copies` 两步同款 | — |

⚠️ **W11 的根目录键是 `GY_W11_PG_ROOT`，不是 `GY_I19_PG_ROOT`。** 两者不可互换：给 W11 传
`GY_I19_PG_ROOT` 只会让 step 里多一条**装饰性 env**——脚本照样回落到 `os.tmpdir()`，
「数据根落在 runner 临时目录、⛔ 不落仓库/系统目录」的初衷正好落空。这是既有门禁的一处假绿漏洞，
本片把它补掉（§3.2 的 `SELF_CLUSTERED_ROOT_KEY`），并在 §5 给了专门的负控制（C1）。

### 3.2 `tests/unit/ci-real-pg-wiring.test.mjs`：+85 / −21

main 现 1732 行；预演后 1796 行。锚点行号均指 **main** 的行号。

| # | 锚点（main 行号） | 改动 |
| --- | --- | --- |
| a | 文件头 docstring，第 89 行之后 / 第 90 行 ` */` 之前 | 追加「第 15 条 / 第 16 条」两段共 8 行（见下） |
| b | `MANAGED_SCRIPTS`（`:91`），在第 104 行 `backup-copies-purge-pg.mjs` 之后 | +2 条 |
| c | `FROZEN_MANAGED_SCRIPTS`（`:108`），在第 121 行之后 | +2 条 |
| d | `REQUIRED_STEP_ORDER`（`:147`），在第 186 行之后 | +2 条 ＋ 两组带序号的注释；原第 187 行 `// 14. recognition-chain-e2e` 改写成 `// 16.` |
| e | `REQUIRED_STEP_ORDER` 第 176 行注释 | `SELF_CLUSTERED_ENV` → `SELF_CLUSTERED_PG_BIN_ENV`（改名后唯一引用点） |
| f | `SELF_CLUSTERED_SCRIPTS`（`:216`），在第 220 行之后 | +2 条（带注释） |
| g | `SELF_CLUSTERED_ENV`（`:228`，常量 ＋ 2 个条目，共 12 行） | **整块替换**（−12/+38）：`SELF_CLUSTERED_PG_BIN_ENV` ＋ `SELF_CLUSTERED_ROOT_KEY`（4 条映射） ＋ `SELF_CLUSTERED_ROOT_PATTERN` ＋ `SELF_CLUSTERED_ROOT_HINT` ＋ `export function selfClusteredEnvOf(script)`（见下）；它上方 2 行 docstring 同步改写（另计 −2/+2） |
| h | `selfClusteredProblems`（`:549`）函数体开头 | 加「没在 `SELF_CLUSTERED_ROOT_KEY` 登记就判红」的前置校验（+6 行） |
| i | 同函数第 557 行 `for (const { key, pattern, hint } of SELF_CLUSTERED_ENV)` | 改为 `of selfClusteredEnvOf(script)` |
| j | docstring 判据⑧ 说明（`:211` 的 `② 必须显式给出 GY_I19_PG_ROOT，落在 runner 的临时目录里…`） | 改写为「该脚本自己读的数据根目录键（见 `SELF_CLUSTERED_ROOT_KEY`）」（−1/+2） |
| k | `:589` 判据注释、`:793` 断言说明串 | 同步文案（`GY_PG_BIN ／ GY_I19_PG_ROOT` → `GY_PG_BIN ＋ 该脚本自己读的数据根目录键`）（−2/+2） |

**b / c / d 三处逐字（同集合、同顺序）：**

```js
  'tests/integration/online-purge-pg.mjs',
  'tests/integration/messages-purge-pg.mjs',
```

插在 `backup-copies-purge-pg` 之后、`recognition-chain-e2e` 之前 ⇒ 三条数组顺序一致为
… → `backup-purge-pg` → `backup-copies-purge-pg` → `online-purge-pg` → `messages-purge-pg` → `recognition-chain-e2e`。
（`recognition-chain-e2e` 仍**排最后**：它起 loopback 监听并反复轮询异步落库，是最慢的一步。）

**f 逐字：**

```js
  // R28-W13：`online-purge-pg.mjs`（`#407`）同上——自起集群、自建 `gy_w6_online_purge`、跑完删数据目录。
  'tests/integration/online-purge-pg.mjs',
  // R28-W13：`messages-purge-pg.mjs`（`#405`）同上。⚠️ 它读的数据根键是 `GY_W11_PG_ROOT`（脚本 `:92`），
  // 与上面三条的 `GY_I19_PG_ROOT` **不同** ⇒ 键名按脚本映射，见 `SELF_CLUSTERED_ROOT_KEY`。
  'tests/integration/messages-purge-pg.mjs',
```

**g 逐字（把 `SELF_CLUSTERED_ENV` 那一块整体换掉）：**

```js
const SELF_CLUSTERED_PG_BIN_ENV = Object.freeze({
  key: 'GY_PG_BIN',
  pattern: /\/bin\/?$/,
  hint: '含 `initdb`/`pg_ctl` 的服务端 bin 目录（CI 里是 `/usr/lib/postgresql/17/bin`）',
});

/**
 * 每条自起集群脚本**自己读的**数据根目录键（键名不是共用契约，是脚本各自的契约）：
 *   - `backup-purge-pg.mjs` / `backup-copies-purge-pg.mjs` / `online-purge-pg.mjs:94` 读 `GY_I19_PG_ROOT`；
 *   - `messages-purge-pg.mjs:92` 读 `GY_W11_PG_ROOT`（它的日志键是 `GY_W11_PG_LOG`，见 `:75`）。
 * 为什么必须按键名核对：给 `messages-purge-pg` 传 `GY_I19_PG_ROOT` 时，step 里只多一条**装饰性 env**——
 * 守卫照样绿、脚本照样回落 `os.tmpdir()` ⇒ 数据目录落在共享 tmp，与「落在 runner 临时目录、⛔ 不落仓库/
 * 系统目录」的初衷正好相反。这种假绿只有「按脚本取键名」才拦得住。
 */
const SELF_CLUSTERED_ROOT_KEY = Object.freeze({
  'tests/integration/backup-purge-pg.mjs': 'GY_I19_PG_ROOT',
  'tests/integration/backup-copies-purge-pg.mjs': 'GY_I19_PG_ROOT',
  'tests/integration/online-purge-pg.mjs': 'GY_I19_PG_ROOT',
  'tests/integration/messages-purge-pg.mjs': 'GY_W11_PG_ROOT',
});

const SELF_CLUSTERED_ROOT_PATTERN = /\$\{\{\s*runner\.temp\s*\}\}/;

const SELF_CLUSTERED_ROOT_HINT = 'runner 的临时目录（CI 里是 `${{ runner.temp }}/<该脚本自己的根>`，⛔ 不落地到仓库）';

/**
 * 某条自起集群脚本在 step 里必须给出的 env 清单：`GY_PG_BIN` 在前，该脚本自己的数据根键在后。
 * 没在 `SELF_CLUSTERED_ROOT_KEY` 登记时只返回 `GY_PG_BIN`——缺登记由 `selfClusteredProblems` 单独判红，
 * ⛔ 不要在这里静默放行。
 */
export function selfClusteredEnvOf(script) {
  const rootKey = SELF_CLUSTERED_ROOT_KEY[script];
  if (rootKey === undefined) return [SELF_CLUSTERED_PG_BIN_ENV];
  return [
    SELF_CLUSTERED_PG_BIN_ENV,
    { key: rootKey, pattern: SELF_CLUSTERED_ROOT_PATTERN, hint: SELF_CLUSTERED_ROOT_HINT },
  ];
}
```

**h 逐字（`selfClusteredProblems` 函数体开头、`problems` 初始化之后）：**

```js
  if (SELF_CLUSTERED_ROOT_KEY[script] === undefined) {
    problems.push(
      `\`${script}\` 在 \`SELF_CLUSTERED_SCRIPTS\` 里，却没在 \`SELF_CLUSTERED_ROOT_KEY\` 登记它读的数据根目录键：`
      + '那样这条判据会退化成「只有一个 `GY_PG_BIN`」，root 传丢/传错都不会红。',
    );
  }
```

**a 逐字（docstring 追加的第 15/16 条）：**

```
 * 第 15 条是 R28-W13 接的（`online-purge-pg.mjs`，`#407`／W6 合入的脚本，`#19` 七日时钟 + 回执 `backupState`
 * 由真行推导）：与第 12/13 条**同类**（自起集群、端口 55600+randomInt(0,300) 且先探活、跑完 `pg_ctl stop`
 * 并删数据目录），判据⑦⑧ 走同一套自起集群等价判据；它读**固定时钟** `CUTOFF = 2026-04-01T00:00:00.000Z`，
 * 故不会随墙钟漂移变红。缺 `GY_PG_BIN` 时 exit 77 ⇒ 装包/路径没弄好必红。
 * 第 16 条是 R28-W13 接的（`messages-purge-pg.mjs`，`#405`／W11 合入的脚本，`#17` 消息域注销**行数**）：
 * 同类自起集群，但它读的数据根目录键是 **`GY_W11_PG_ROOT`**（脚本 `:92`），⛔ 不是 `GY_I19_PG_ROOT`——
 * 键名按脚本映射见 `SELF_CLUSTERED_ROOT_KEY`，给错键就是装饰性 env（守卫绿、脚本照样落 `os.tmpdir()`）。
 * 见 `docs/verification/gy-r28-w13-real-pg-wiring-20261021.md`。
```

### 3.3 `tests/unit/ci-integration-chain-structure.test.mjs`：+27 / −0

main 现 403 行、`UNWIRED_DECLARATIONS`（`:67`）**28** 条；预演后 30 条（+2，**并逐条改写 reason**）。

- `messages-purge-pg.mjs`：插在第 **180** 行（`messages-pg.mjs` 声明块的收尾 `  },`）之后、第 181 行之前。
- `online-purge-pg.mjs`：插在第 **194** 行（`ocr-jobs-pg.mjs` 声明块的收尾 `  },`）之后、第 195 行
  （`profile-ui-fixture.mjs`）之前——与既有条目一样按 `path` 字母序。

两条逐字：

```js
  {
    path: 'tests/integration/messages-purge-pg.mjs',
    reason: '需真实 PG 17.11，且与 `backup-purge-pg.mjs` 同为**自起集群**脚本：要求 `GY_PG_BIN` 指向服务端'
      + '二进制目录（自行 `initdb`/`pg_ctl` 起临时集群，仅回环；端口取 55700–55999 且**先探活再起**，'
      + '刻意避开 55436 的遗留集群）；缺 `GY_PG_BIN` 时打印 SKIP 并 exit 77（未取得，不是通过；'
      + '它刻意不提供任何放宽跳过的开关）。它验证的是 #17 的 C5「注销时点消息域行被硬删且行数入证据」'
      + '（走产品真实路径 `privacy/user-data-deletion.ts` 的协调器 → `messages/store-pg.ts` 的 `purgeOwnerData`），'
      + '没有真库就没有读数。R28-W13 已把它接进 `.github/workflows/real-pg-integration.yml`：复用该 job 里'
      + '那条装 `postgresql-17`（PGDG `noble-pgdg`）的 step 装出来的 `/usr/lib/postgresql/17/bin`（`GY_PG_BIN`）＋'
      + ' `GY_W11_PG_ROOT=${{ runner.temp }}/gy-w11-pg` 真跑（⛔ 不是 `GY_I19_PG_ROOT`：脚本 `:92` 读的是前者），'
      + '⛔ 不自己 `CREATE DATABASE`（受管脚本第 16 条）⇒ **已接真库 job**。'
      + '但它**仍不进**无 PG 的回环链：回环链里既没有真 PG、也没有 `initdb`/`pg_ctl`'
      + '（装 PG 服务端是那个真库 job 自己的事），故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/online-purge-pg.mjs',
    reason: '需真实 PG 17.11，且与 `backup-purge-pg.mjs` 同为**自起集群**脚本：要求 `GY_PG_BIN` 指向服务端'
      + '二进制目录（自行 `initdb`/`pg_ctl` 起临时集群，仅回环；端口取 55600+randomInt(0,300) 且**先探活再起**）；'
      + '缺 `GY_PG_BIN` 时打印 SKIP 并 exit 77（未取得，不是通过；它刻意不提供任何放宽跳过的开关）。'
      + '它验证的是 #19 的七日在线时钟与回执 `backupState` 由真行推导（**注入固定时钟** `CUTOFF`，不读墙钟），'
      + '并且要真跑 `deploy/postgres-cvm/sql/20-login-roles.sql` 的四域 GRANT 才能断言运行时角色的权限形状，'
      + '没有真库就没有读数。R28-W13 已把它接进 `.github/workflows/real-pg-integration.yml`：复用同一条装'
      + '`postgresql-17`（PGDG `noble-pgdg`）的 step 装出来的 `/usr/lib/postgresql/17/bin`（`GY_PG_BIN`）＋'
      + ' `GY_I19_PG_ROOT=${{ runner.temp }}/gy-i19-pg` 真跑，⛔ 不自己 `CREATE DATABASE`（受管脚本第 15 条）'
      + ' ⇒ **已接真库 job**。但它**仍不进**无 PG 的回环链：回环链里既没有真 PG、也没有 `initdb`/`pg_ctl`'
      + '（装 PG 服务端是那个真库 job 自己的事），故在此如实登记为未接线。',
  },
```

## 4. 预演读数（草案落盘后，全绿）

`.github/workflows/real-pg-integration.yml`（314 行）、`tests/unit/ci-real-pg-wiring.test.mjs`（1796 行）、
`tests/unit/ci-integration-chain-structure.test.mjs`（430 行）三处落盘、并将两只脚本按各自 PR 的 blob
原样放进 `tests/integration/`（`git hash-object` 与远端逐字节相同：`online-purge-pg.mjs` =
`7368c7049e68d22b6e1d8609bb1b7bc7caeddfa6`，`messages-purge-pg.mjs` =
`343f24f9fed2fa8013332c60b01858c00157baab`）后：

```
$ node --test tests/unit/ci-real-pg-wiring.test.mjs
ℹ tests 17   ℹ pass 17   ℹ fail 0
  ✔ 反向控制⑨：删掉 `backup-copies-purge-pg` 的整段 step ⇒ 四条判据必须逐条点名它

$ node --test tests/unit/ci-integration-chain-structure.test.mjs
ℹ tests 7    ℹ pass 7    ℹ fail 0
```

三处数组读数（静态解析，探针逐条打印）：

```
MANAGED_SCRIPTS        = 16
FROZEN_MANAGED_SCRIPTS = 16
REQUIRED_STEP_ORDER    = 16
三处同集合             = true
MANAGED === ORDER 顺序  = true
MANAGED === FROZEN 顺序 = true

 1 conversations-pg        2 community-pg            3 messages-pg
 4 favorites-history-pg    5 account-deletion-pg     6 admin-accounts-read-pg
 7 admin-flags-pg          8 ocr-jobs-pg             9 recognitions-pg
10 account-suspend-pg     11 speech-pg              12 backup-purge-pg
13 backup-copies-purge-pg 14 online-purge-pg        15 messages-purge-pg
16 recognition-chain-e2e

SELF_CLUSTERED_SCRIPTS  = 4
SELF_CLUSTERED_ROOT_KEY = {backup-purge: GY_I19_PG_ROOT, backup-copies: GY_I19_PG_ROOT,
                           online-purge: GY_I19_PG_ROOT, messages-purge: GY_W11_PG_ROOT}
```

还原后（本节全部改动已 `git checkout --` 回退、两只脚本副本已删）同一组门禁回到基线绿：
`ci-real-pg-wiring` 17/17、`ci-integration-chain-structure` 7/7，`git status --porcelain` 为空。

## 5. 负控制读数（6 条，逐条逐字）

每次变异都立即还原，并用 `[System.IO.File]::ReadAllText` 做**逐字节等值**校验（输出 `byte-identical`）。

| # | 变异 | 结果 | 是否逐字点名 |
| --- | --- | --- | --- |
| A | 把两只脚本放进 `tests/integration`，但**不**写任何声明 | **红**（chain-structure 断言 4） | 是，两只都点名 |
| B | 删掉草案里 `online-purge-pg` 的**整段 step**（6 行） | **红**（ci-real-pg-wiring 判据①） | 是，点名 `tests/integration/online-purge-pg.mjs` |
| C1 | 把 W11 的 `GY_W11_PG_ROOT` **换成** `GY_I19_PG_ROOT`（值仍是 `${{ runner.temp }}/…`） | **红**（自起集群 env 判据） | 是，点名 `GY_W11_PG_ROOT` |
| C2 | 整行删掉 `GY_W11_PG_ROOT` | **红**（同上） | 是，点名 `GY_W11_PG_ROOT` |
| D | 删掉 `messages-purge-pg.mjs` 的声明 | **红**（断言 4） | 是，点名 `tests/integration/messages-purge-pg.mjs` |
| E | 两条声明都删掉 | **红**（断言 4） | 是，两只都点名 |

A 的原始报错（这是「不能删声明」的直接反证）：

```
AssertionError [ERR_ASSERTION]: tests/integration 下有既未接线、也未在本文件 UNWIRED_DECLARATIONS
声明的脚本：tests/integration/messages-purge-pg.mjs、tests/integration/online-purge-pg.mjs。
请二选一：接进 test:integration:http 链，或在白名单里写明原因。
```

C1 / C2 的原始报错（这条是把「装饰性 env」这个假绿堵死的那条判据）：

```
· job `real-pg-17-11` 里执行自起集群脚本 `tests/integration/messages-purge-pg.mjs` 的 step 没有
  `GY_W11_PG_ROOT`（必须给：runner 的临时目录（CI 里是 `${{ runner.temp }}/<该脚本自己的根>`，
  ⛔ 不落地到仓库））；缺它时脚本只打印 SKIP 并 exit 77，「真跑」等于没跑
```

D / E 的原始报错：

```
AssertionError [ERR_ASSERTION]: tests/integration 下有既未接线、也未在本文件 UNWIRED_DECLARATIONS
声明的脚本：tests/integration/messages-purge-pg.mjs。请二选一：接进 test:integration:http 链，或在白名单里写明原因。
（E：… 声明的脚本：tests/integration/messages-purge-pg.mjs、tests/integration/online-purge-pg.mjs。…）
```

## 6. 本机真跑读数（两只脚本，逐只给数）

本机 PG：`E:\GengYunCommander\.pg17\pgsql\bin`（17.11，`initdb.exe`/`pg_ctl.exe`/`postgres.exe` 齐全）。

### 6.1 `messages-purge-pg.mjs`（W11）：**真跑 ALL PASS 8 条**，exit 0

```
$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'
$env:GY_W11_PG_ROOT='E:\GengYunCommander\.pg17\tmp\w13-w11'
$env:GY_W11_PG_LOG='E:\GengYunCommander\.pg17\tmp\w13-w11.log'
$ node tests/integration/messages-purge-pg.mjs
  - 临时集群：数据目录 …\tmp\w13-w11\gy-w11-messages-purge-pg-5dff46b3，端口 55706（只监听 127.0.0.1）
  - PostgreSQL 17.11
  - [0] 全链迁移 26 个已应用；users / messages / idempotency_keys 三张真实表在岗
PASS 1: 角色/授权：清理身份 = gengyun_api_runtime；messages DELETE = true（表级）、idempotency_keys DELETE = true（域组角色）、users DELETE = false
PASS 2: 负控制基准（清理前）：A 消息 3 行 / 台账 3 行；B 消息 2 行 / 台账 3 行；C 消息 2 行 / 台账 2 行；共享台账合计 8 行
PASS 3: 证据串：messages:online-purged:3;messages:idempotency-purged:3（计数取自 DELETE … RETURNING 的实际行数，且逐项等于清理前读数）
PASS 4: ① 本主体 messages 注销后 = 0 行（表仍是 8 列、无软删列 ⇒ 硬删；A 的 users 行仍在 ⇒ 不是外键级联的副作用）；他人 B = 2 行、负控制 C = 2 行，id 逐一原样
PASS 5: ② 共享台账：本主体 A 前缀命中 = 0 行（原 3 行，含 1 条 auth 域跨域行）；他人 B = 3 行原样、C = 2 行原样；整表 8 → 5 行（不是整表清空）
PASS 6: ③ 负控制读数（同一库、同一连接、只读）：未清理主体 C 消息 2 行、台账 2 行，共享台账剩余 5 行 ⇒ 断言不是恒真
PASS 7: 重放幂等：同一主体第二次注销清理 = messages:online-purged:0;messages:idempotency-purged:0；他人两表原样
PASS 8: 回执：messages.online_state = completed（证据串即上面的行数）；backup_state = pending（本片未接备份端口，不谎称完成）

ALL PASS：8 条真库断言（exit code 0）
EXITCODE=0
```

收尾核对（**无残留**）：脚本自己 `pg_ctl stop` 并删数据目录——`…\tmp\w13-w11` 目录内 **0 个条目**；
服务端日志末尾 `server stopped`；`Get-NetTCPConnection` 的 55000–56000 监听列表里**没有 55706**；
`Get-CimInstance Win32_Process` 里 postgres 进程**没有**命令行含 `w13-w11` 的。脚本副本用完随即删除。

### 6.2 `messages-purge-pg.mjs` 不设 env：**77**

```
SKIP: 未设置 GY_PG_BIN（postgres 二进制目录，含 initdb/pg_ctl）⇒ 真库臂跳过，没有取得「message 域注销行数」的真库读数（未取得，不是通过）。
EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本脚本刻意不提供 --allow-skip）。
EXITCODE=77
```

### 6.3 `online-purge-pg.mjs`（W6）：**未取得（本片物理上跑不了）**

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  …/services/api/src/privacy/backup-state-derivation.ts
  imported from …/tests/integration/online-purge-pg.mjs
exit code 1
```

原因见 §2.2：它 import 的 `backup-state-derivation.ts`／`online-purge-driver.ts` 是 `#407` 新增的。
⇒ 「W6 本机真跑 ALL PASS」与「W6 不设 env ⇒ 77」两项**本片都拿不到**，须由 `#407` 合入后的接线片补。

## 7. 判据清单（接线执行者逐条打勾）

落盘后依次跑，全绿才算接完：

1. `node --test tests/unit/ci-real-pg-wiring.test.mjs` ⇒ 17/17 pass（判据①③⑦⑧⑨ 现在覆盖 16 条受管脚本）。
2. `node --test tests/unit/ci-integration-chain-structure.test.mjs` ⇒ 7/7 pass（断言 4 在 30 条声明下不红）。
3. 三处数组读数 **16 / 16 / 16**，且 `MANAGED ≡ FROZEN ≡ REQUIRED_STEP_ORDER` 集合与顺序**都**相等；
   `recognition-chain-e2e` 仍排最后。
4. `SELF_CLUSTERED_SCRIPTS` = **4** 条；`SELF_CLUSTERED_ROOT_KEY` 4 条映射里
   `messages-purge-pg.mjs → GY_W11_PG_ROOT`，其余三只 → `GY_I19_PG_ROOT`。
5. `UNWIRED_DECLARATIONS` = **30** 条，两条新脚本的 reason 已改写为「已接真库 job，但仍不进无 PG 回环链」。
6. workflow 里 `uses:` 仍**恰好两条**且都钉 40 位 SHA；无 `continue-on-error` / `if:` / `|| true` /
   `set +e`；两只脚本的 step 里**没有** `CREATE DATABASE`；装包 step 仍**只有一条**。
7. 负控制（§5 的 B / C1 / D 三条必做）：删 step ⇒ 红并点名脚本；把 root 键换错 ⇒ 红并点名键；
   删声明 ⇒ 红并点名脚本。还原后回绿。
8. `npm run lint` 通过；`npm run test:unit` 全量通过（本片基线：`tests 3375 / pass 3374 / fail 0 / skipped 1`）。
9. 本机真跑：W11 `ALL PASS` 8 条；W6 若 `#407` 已合入，应同样 `ALL PASS`（10 组臂），
   两只都要确认跑完停服、删目录、无残留。

## 8. 交接：谁、什么时候、按什么顺序

**前置条件（硬）**：`#407` 与 `#405` 已**合入 main**（`gh pr view 407/405 --json state,mergeCommit` 显示
`MERGED` 且 `mergeCommit` 非 null），且 `git ls-tree origin/main -- tests/integration/` 能看到
`online-purge-pg.mjs` 与 `messages-purge-pg.mjs`。

**执行者**：接手「真库 CI 接线」的下一片执行者（E/W 系列）。**不是**本片（本片不 push、不开 PR）。

**顺序与要点**：

1. 从**新的** `origin/main` 起工作分支（本页所有锚点行号都以 `f5cca8b` 为准；若 main 已前进，
   用锚点**文本**重新定位，别硬编码行号）。
2. workflow：照 §3.1 在第 251/252 行之间插入两段 step（照 `backup-copies-purge-pg` 的既有范式）。
3. `ci-real-pg-wiring.test.mjs`：照 §3.2 a–k 逐处改；**注意 g 项是一次刻意的门禁改造**
   （`SELF_CLUSTERED_ENV` → `SELF_CLUSTERED_PG_BIN_ENV` + `SELF_CLUSTERED_ROOT_KEY`），
   它把「给 W11 一条装饰性 `GY_I19_PG_ROOT` 也能绿」这个假绿堵掉；证据页须写明这个理由。
4. `ci-integration-chain-structure.test.mjs`：**不要新增重复条目**——`#407`／`#405` 合入后，
   这两条声明很可能**已经在** `UNWIRED_DECLARATIONS` 里（reason 写着「尚未接进任何 workflow」）。
   正确动作是**就地改写那两条的 reason**（照 §3.3），断言 2 禁重复，重复会直接红。
5. 跑 §7 的 1–8 项；负控制至少做 B / C1 / D 三条。
6. 写本片的续篇证据页（或以本页 §4/§5/§6 为基线补齐 CI 读数）。

**验收判据**：§7 全绿 **且** 真 CI 上 `real-pg-integration` job 跑绿、两个新 step 的日志末尾各出现
`ALL PASS`（W6 10 组臂 / W11 8 条断言）。⛔ 在拿到真 CI 读数之前，不得在任何文档里写「已在 CI 通过」。

## 9. 未取得项（本片明确没有的东西）

1. **真 CI 运行读数**：本片不 push、不开 PR ⇒ `real-pg-integration` 没有跑过。因此本页**没有**、
   也⛔ 不能写「已在 CI 通过」；现状只能是「草案已预演绿 + 本机读数 + 待 CI 验证」。
2. **W6（`online-purge-pg.mjs`）的本机真跑**：`ERR_MODULE_NOT_FOUND`（缺 `#407` 的两个新模块），
   故它的 10 组臂读数与「不设 env ⇒ 77」两项本片都拿不到。
3. **两只脚本在 main 上的存在性**：不存在（`#407`／`#405` 未合）。这正是本片不接线的原因。
4. **`#405`／`#407` 的合并时点与顺序**：不由本片决定。

### 9.1 观察项（如实记录，与本次改动无关）

`npm run test:unit` 在本片机器上共跑三次：

| 次序 | 时点 | 结果 |
| --- | --- | --- |
| 1 | 改动前（还原态） | `tests 3375 / pass 3374 / fail 0 / skipped 1` |
| 2 | 仅新增本证据页之后 | `fail 1`：`tests/unit/local-profile-bootstrap.test.mjs` 一条 `strictEqual` 断言 `actual 1 / expected 0` |
| 3 | 紧接着重跑 | `tests 3375 / pass 3374 / fail 0 / skipped 1` |

单跑该文件 `node --test tests/unit/local-profile-bootstrap.test.mjs` ⇒ `tests 3 / pass 3 / fail 0`。
本片对该文件零改动（本片工作树只新增本页），且三次跑之间唯一差别是本页这份 markdown ⇒
判定为**该真 PG 用例在全量并发下的偶发抖动**（它自带 `initdb`/登录角色修复臂，跑 2–8 秒），
与本片接线草案无关；供后续接线片参考，若在 CI 上复现需单独排查它的端口/集群资源竞争。

## 10. 红线自查

- ⛔ **没有**给 workflow 加吞红构造：草案里没有 `continue-on-error`、`if:`、`|| true`、`set +e`；
  两只脚本的 step 都是裸 `run: node …`（缺 env 时脚本 exit 77 ⇒ step 直接红，不升级、不吞）。
- ⛔ **没有**新增 `uses:`；既有两条仍钉 40 位 SHA。
- ⛔ **没有**改 `services/**`、`packages/**`、`deploy/**`、迁移号、`openapi.json`、`contract-status.json`。
- ⛔ **没有**在 workflow 注释里写 `--allow-skip` / `GY_ALLOW_SKIP`（`escapeHatchHits` 逐行扫全文、
  **不跳过注释**，写了就把判据②判红）。
- ⛔ **没有**改 workflow、门禁文件或任何 `tests/`（本片工作树上除本页外 `git status --porcelain` 为空）。
- ⛔ 不 push、不开 PR、不切分支、不碰其他 worktree。

## 11. 复现命令（本片用过的全部读数）

```pwsh
cd E:\GengYunCommander\wt-w13-ci-wiring

# 判定
git rev-parse HEAD; git rev-parse --abbrev-ref HEAD; git log origin/main --oneline -5
gh pr view 407 --json state,mergeCommit,headRefName
gh pr view 405 --json state,mergeCommit,headRefName
git ls-tree --name-only origin/main -- tests/integration/

# 基线（还原态）
node --test tests/unit/ci-real-pg-wiring.test.mjs            # 17/17
node --test tests/unit/ci-integration-chain-structure.test.mjs # 7/7
npm run lint
npm run test:unit                                            # 3375 / pass 3374 / fail 0 / skipped 1

# 本机真跑（W11）
$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'
$env:GY_W11_PG_ROOT='E:\GengYunCommander\.pg17\tmp\w13-w11'
$env:GY_W11_PG_LOG='E:\GengYunCommander\.pg17\tmp\w13-w11.log'
node tests/integration/messages-purge-pg.mjs                  # ALL PASS 8 条 / exit 0

# 无 env ⇒ 77
Remove-Item Env:GY_PG_BIN,Env:GY_W11_PG_ROOT,Env:GY_W11_PG_LOG
node tests/integration/messages-purge-pg.mjs                  # exit 77
```
