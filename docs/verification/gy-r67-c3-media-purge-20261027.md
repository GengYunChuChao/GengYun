# R67-C3：媒体行清除驱动接进 CI，并把它自己的迁移号判据改成台账口径

## 1. 基线

- main：`380bf7bd ci: wire seven admin PostgreSQL integration arms (#663)`。
- 本片分支 `feat/gy-r67-c3-media-row-purge`，父 `380bf7bd`，单提交。
- 证据分级：**L2**（本机静态 + 单测 + YAML 实解）＋ **L4 待 CI**（该臂在本机跑不起来，见 §6「未取得」）。

## 2. 起因：#663 之后只剩这一条「可接但没接」的真库臂

R67-C 把 7 条臂接进两个新 job（读 job `real-pg-admin-read-17-11`、写 job `real-pg-admin-write-17-11`），
当时唯一没接的就是 `tests/integration/media-row-purge-pg.mjs`，原因是它自己的判据与仓库现状不符 ——
旧断言写「迁移号必须从 0001 起连续无缺号」：

```js
for (let index = 0; index < versions.length; index += 1) {
  assert.equal(versions[index], index + 1, `迁移号必须从 0001 起连续无缺号，缺 ${index + 1}`);
}
```

而仓库自 #14 起就允许「先把号分配出去、文件后落」：`services/api/db/migration-reservations.json`
里登记着 `0037`（`0037_issue_14_allocated.sql`，owner `#14（已分配，号空出、尚无文件）`），
迁移目录是 `0036_r34_admin_content_persistence.sql` 直接跳到 `0038_r34_deletion_receipt_persistence.sql`。
⇒ 该臂在今天的树上必红，接进 CI 就是一条每跑必红的 step（R67-C 的证据页 §7.2 记录过这次判定）。
`tools/verify-migrations-unique.mjs` 的口径本来就是「46 条配对 + 1 条登记允许缺省 = 47」，
`[gap]` 判据还要求缺号有「故意跳过」依据 ⇒ **错的是臂的判据，不是树**。

## 3. 改动一：迁移号不变量改成保留台账口径（`media-row-purge-pg.mjs:318-342`）

```js
const reservations = JSON.parse(
  readFileSync(new URL('../../services/api/db/migration-reservations.json', import.meta.url), 'utf8'),
).reservations;
const reservedVersions = new Set(reservations.map((entry) => entry.version));
const missingVersions = [];
for (let version = 1; version <= Math.max(...versions); version += 1) {
  if (!versions.includes(version) && !reservedVersions.has(version)) missingVersions.push(version);
}
assert.deepEqual(missingVersions, [], `迁移号缺号必须逐个在 migration-reservations.json 登记（未登记空洞：…）`);
assert.ok(versions.includes(35), '迁移清单里必须有 0035（本片的媒体行窄函数）');
assert.equal(versions.length + reservedVersions.size, Math.max(...versions),
  '文件数 + 已登记保留数必须等于最大号（否则存在既无文件也未登记的号）');
```

- 保留了原来的 `versions.includes(35)`（本片要用的媒体行窄函数仍在）。
- 收尾读数同步改真：`全链迁移应用完成：46 个文件，编号 1..47（其中 1 个号为已登记保留、缺文件属正常：37）`。
- **判据没有放宽**：旧判据只查「连续」，新判据多查了两件事 —— ①每个缺号都必须能在台账里找到登记
  （未登记空洞仍红）；②`文件数 + 保留数 === 最大号`（防「既无文件也未登记」的号被悄悄漏过）。

本机独立复算（不依赖 PG，直接用同一份目录与台账跑新判据）：

```
files=46 max=47 reserved=37 missing=none
count+reserved=max ? true
has0035 ? true
```

## 4. 改动二：接进写 job（`real-pg-integration.yml:1077-1108`）

- 位置：`real-pg-admin-write-17-11` 的**最后一步**（第 10 步），step 名
  `媒体行清除驱动（R67-C3：media-row-purge-pg / 自起集群 / 迁移号按保留台账口径）`，`timeout-minutes: 5`。
- 形态照同 job 邻居：`set -euo pipefail` → `log=/tmp/media-row-purge-pg.log` →
  `node tests/integration/media-row-purge-pg.mjs 2>&1 | tee "$log" || rc=$?` →
  `rc=77` ⇒ `::error::` + `exit 1`（77 = 未取得，不是通过）→ 非 0 非 77 ⇒ 透传退出码 →
  读数判据 `awk '/PASS [0-9]+:/{n+=1} /✓/{n+=1}'`，<1 条 ⇒ 硬失败。
- `env`：`GY_PG_BIN: /usr/lib/postgresql/17/bin`、`GY_R34_PG_ROOT: ${{ runner.temp }}/gy-r34-pg`、
  `PGCLIENTENCODING: UTF8`。它是**自起集群**族（自己 `initdb`、自建 `gengyun_media_row_purge_test`、
  跑完 `pg_ctl stop` 并删数据目录）⇒ 本 step ⛔ 不建库，也不需要 owner URL。
- 现有 `real-pg-17-11` 的 35 步、读 job 的 6 步**零改动**。

## 5. 改动三：守卫五张清单同位置登记（`tests/unit/ci-real-pg-wiring.test.mjs`）

`MANAGED_SCRIPTS`、`FROZEN_MANAGED_SCRIPTS`、`REQUIRED_STEP_ORDER`（追加到尾部，与写 job 最后一步一致）、
`SELF_CLUSTERED_SCRIPTS`、`SELF_CLUSTERED_ROOT_KEY`（`'…/media-row-purge-pg.mjs': 'GY_R34_PG_ROOT'`）。
`UNWIRED_DECLARATIONS`（`tests/unit/ci-integration-chain-structure.test.mjs`，仍 53 条）**原样不动**：
那条守卫的 wiring 判据只认 `package.json` 的 `test:integration:http` 链，真库臂永远进不去，
理由段本来写的就是「需真实 PG」——本片接进 real-PG workflow 不改变它必须继续声明的事实。

## 6. 本机读数与「未取得」

本机实测（全部 exit 0）：

| 项 | 读数 |
| --- | --- |
| `node --check` 两个改动文件 | 0 |
| 新迁移号判据独立复算 | `files=46 max=47 reserved=37 missing=none`；`count+reserved=max=true`；`has0035=true` |
| `node --test tests/unit/ci-real-pg-wiring.test.mjs` | `tests 18 / pass 18 / fail 0` |
| `node --test tests/unit/ci-integration-chain-structure.test.mjs` | 7/7 |
| PyYAML 实解 workflow | `jobs=3`，steps `real-pg-17-11: 35`、`real-pg-admin-read-17-11: 6`、`real-pg-admin-write-17-11: 10` |

**未取得（必须留给 CI）**：

- 该臂在本机**没有真跑过**。Windows 上 `initdb` 落在 `%TEMP%` 下会 `could not change permissions`（R67-C 时已踩过，
  本片没再试），加上当时可用内存 1060 MB（低于起 PG 的门槛），所以它的 `PASS N:` 读数条数、耗时、
  以及「接进 Linux runner 后还剩什么假设」全部未知。⇒ 本片只能声称「判据改对 + 接线形态对齐邻居 + 守卫与 YAML 通过」，
  **不声称该臂已绿**。
- 因此本 PR 的首要目的就是把这条臂放到 Linux 上跑一次；红了就按 R66/R67-C 的老路逐轮定位（那里的教训是：
  CI 一次只暴露第一个失败点，红点会逐轮后移）。

## 7. 边界

- 只动三处：`tests/integration/media-row-purge-pg.mjs`（迁移号判据 + 收尾读数）、
  `.github/workflows/real-pg-integration.yml`（+1 step）、`tests/unit/ci-real-pg-wiring.test.mjs`（五张清单各 +1 条）；
  另加本页，以及 `docs/verification/gy-r67-c-wiring-20261027.md` §7.2 的一条前向引用（历史页只追加，不改旧读数）。
- ⛔ 没动 `packages/contracts/**`、`services/api/**`、`apps/**`、`tools/**`、`deploy/**`；
  ⛔ 没动该臂的任何业务断言（媒体行删除、权限面、七条硬条件全部原样）。
- 迁移号口径若日后变化（例：保留台账不再用 `reservations` 键），本臂与 `verify-migrations-unique.mjs` 会同时需要改；
  这是一处**新的耦合**，写在这里备查。
