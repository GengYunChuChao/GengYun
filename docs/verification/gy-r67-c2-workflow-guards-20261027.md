# GY-R67-C2 五份真库 workflow 的结构守卫（2026-10-27）

- 基线：`be8c7880`（main，含 #656/#657/#658/#659/#652 与 R67-A 文档真话、R67-C 两条 admin 读/写 job 已合入的部分）
- 分级：B 档（改 `.github/workflows/**` 与 `tests/**`），等监工批复，不自行合并
- 对应问题：`GY-R67-D02`（`.pg17/audit/r67-d-tests-ci.md`）——「判据⑨ 只锚 `real-pg-integration.yml`，另 5 份真库 workflow 零结构守卫」

## 1. 为什么要有这一片

`tests/unit/ci-real-pg-wiring.test.mjs` 的九条判据只覆盖 `real-pg-integration.yml`；
`auth-privacy-postgres.yml` 另有专用守卫 `tests/unit/auth-privacy-arm-isolation.test.mjs`。
剩下五份「每份承载 1–4 条真库臂」的 workflow 没有任何结构门禁：

| workflow | job | 镜像 | 承载的真库臂 |
| --- | --- | --- | --- |
| `catalog-postgres.yml` | `catalog-pg` | `postgres:17.11` | `catalog-pg.mjs` |
| `source-lifecycle-postgres.yml` | `lifecycle-pg` | `postgres:17.11` | `source-lifecycle-pg.mjs` |
| `staging-intake-postgres.yml` | `intake-pg` | `postgres:17.11` | `staging-intake-pg.mjs` |
| `workbook-staging.yml` | `staging-pg17` | `postgres:17` | `workbook-staging-pg.mjs` |
| `consent-grant-postgres.yml` | `consent-grant-pg` | `postgres:17.11` | `consent-grant-pg.mjs`、`egress-ledger-pg.mjs`、`egress-object-key-pg.mjs`、`egress-revoke-race-pg.mjs` |

后果是具体的：删掉其中一个承载真库臂的 step、把 job 名改掉、把镜像从 `17.11` 降到 `16`、
或者顺手加一句 `|| true`，**全仓没有任何门禁会红** —— 而「真库覆盖」在 CI 读数上是静默下降的，
只有等到某天有人手工翻 workflow 才会发现某条臂已经几个月没跑过。

## 2. 判据（`tests/unit/ci-real-pg-workflows-structure.test.mjs`）

九个单文件判据 + 两个跨文件判据，全部是结构判据（不读臂的断言内容、不代替臂本身）：

1. job 名恰为登记值，且 `runs-on: ubuntu-*`（真库臂只在 Linux runner 上被验证过）；
2. job 级 `timeout-minutes` 存在且落在 1–30 —— 没有它，「没跑到」会和「job 超时」混成同一种红；
3. `services.postgres.image` 与登记值逐字相等（`workbook-staging` 现状就是 `postgres:17`，
   升级必须同改本表与 workflow）；
4. 真跑的脚本集合与登记值**双向相等**（删一条、加一条都红）；
5. 每个被点名的脚本在磁盘上真实存在（改名不留死引用）；
6. 每个真库臂 step 之后十行内必须有 `env:` 且含 URL 型键（`*_TEST_URL` / `DATABASE_TEST_URL` /
   `PGDATABASE`）—— 否则「跑起来了但连的是哪个库」不可审计；
7. 禁止 `continue-on-error: true`、`|| true`、`--allow-skip`、`GY_ALLOW_SKIP`、`secrets.*`
   （前四者是既成的「把失败变绿」出口，第五者与「这五份只用合成口令」的现状不符）；
8. 五份合计的脚本集合与登记值双向相等（跨文件删 step 也红）；
9. 覆盖面自证：仓库里**凡是** `image: postgres*` 的 workflow，要么登记在 `REAL_PG_WORKFLOWS`，
   要么登记在 `COVERED_ELSEWHERE` 并指明覆盖它的测试文件真实存在 —— 新增一份真库 workflow 逃不掉。

另有「判别力自证」一例：在内存里对 `catalog-postgres.yml` 做四种变异（删臂 step、去 `timeout-minutes`、
加 `|| true`、点名幽灵脚本），每种都必须让判据变红；同时显式断言「改库名**不在**本判据面内」
（库名由臂自己硬钉，结构守卫不该假装能管）。

## 3. 先红后绿（本机实测）

- 先跑（判据已写好、workflow 未改）：`ℹ tests 8 / pass 2 / fail 6`，
  五份各报一条 `缺 job 级 timeout-minutes（超时会把「没跑到」混成「job 超时」）`；
  「跨文件合计双向相等」「覆盖面自证」两条先绿（说明它们与 timeout 无关，红点定位是精确的）。
- 修：五份 workflow 各自补一行 job 级 `timeout-minutes`（插在 `runs-on:` 之后，值与理由见 §4）。
- 后跑：`ℹ tests 8 / pass 8 / fail 0`。
- 同轮回归：`ci-real-pg-wiring.test.mjs` + `ci-integration-chain-structure.test.mjs` +
  本文件合计 `tests 33 / pass 33 / fail 0`。
- PyYAML 复核（`py -c` 逐份解析）：`catalog-pg timeout=10 img=postgres:17.11 steps=4`、
  `lifecycle-pg timeout=10 img=postgres:17.11 steps=4`、`intake-pg timeout=10 img=postgres:17.11 steps=4`、
  `staging-pg17 timeout=15 img=postgres:17 steps=5`、`consent-grant-pg timeout=20 img=postgres:17.11 steps=7`。

## 4. 为什么是这几个数值

参照仓内既有事实：`real-pg-integration.yml` 的主 job 用 15 分钟跑 35 个 step；
`auth-privacy`、`deploy-sql-gate` 等也都按 job 总量给值。据此：

- 单臂 job（`catalog` / `source-lifecycle` / `staging-intake`）给 **10** 分钟 —— 4 个 step（checkout、setup-node、npm ci、一条臂）；
- `workbook-staging` 给 **15** 分钟（5 个 step，工作簿暂存要跑真实文件解析）；
- `consent-grant` 给 **20** 分钟（7 个 step、4 条臂串联，且第三条 `egress-object-key` 依赖前两条留下的夹具）。

刻意**不**把值压到「刚好够」：超时是兜底，不是性能目标；压太紧会把「机器慢了两分钟」变成红。

## 5. 边界与「未取得」

- 本片**没有**改任何臂的脚本、也没有改任何断言；改动总量是五个 workflow 各加一行 + 一个新测试文件。
- 本片**不能**证明这五份 workflow 现在真的会绿 —— 那需要真 CI 运行（本 PR 会触发这五份 workflow，
  届时读数才是 L4 级证据）。本机能给的只是「结构上没有再漏」+「YAML 可解析」。
- 判据**不管**：库名/口令是否与臂里的硬钉一致（臂自己管）；step 顺序语义（除 `consent-grant` 的
  `EGRESS_LEDGER_KEEP` 这一条硬前提外）；镜像 minor 版本是否真能被 PGDG 拉到。
- `COVERED_ELSEWHERE` 里 `deploy-sql-gate.yml` 的覆盖者是 `tests/unit/deploy-sql-gate-probe.test.mjs`
  （探针与 42501 计数），它是否**足够**是既有判断，本片没有重新评估。
- 后续若新增真库 workflow，正确做法是：登记进 `REAL_PG_WORKFLOWS`（若本文件应逐份守卫）
  或 `COVERED_ELSEWHERE`（若已有别的测试守卫），两者都不做则第 9 条判据直接红。
