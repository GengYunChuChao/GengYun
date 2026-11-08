# GY-R83 / #29（GY-I27）AC-1 负向用例补齐：用途不匹配的授予与撤回

- 日期：2026-11-07
- 仓库：`GengYunChuChao/GengYun`；基线 `origin/main` = `7a534edb270dc2e8b89c3e2efdec12d58c64d984`（本片开工时的 `0ecae98c…` 之后又进了 `7a534edb docs(verification): 修 failmatrix CI 页锚点与用例下限`，本片在自己的树里 `reset --hard` 到它再叠加改动，交付 diff 因此只有下面两个文件）
- worktree：`E:\GengYunCommander\.pg17\wt-r83-i29-neg`；分支 `test/gy-r83-i29-consent-negatives`
- 运行时：Node `v24.16.0`；原生 PostgreSQL `17.11`（`E:\GengYunCommander\.pg17\pgsql\bin`，一次性集群，端口 55410，库名 `gengyun_consent_grant_test`）
- 改动范围：只 `tests/**` 与本页；**未改** `services/**`、契约、迁移、CI。变异自检期间对两个源文件做过临时改动，全部逐个 `git checkout -- <那一个文件>` 还原，还原后 `git status --porcelain` 只剩本页与被改的测试文件

## 0. 一句话结论

派单前提「AC-1／AC-2 一条负向用例都没有」与 current main 不符：四条路径里**三条**（撤回后用同一授权／在途作业期间撤回／旧结果回写）已有真库负向用例，只有「**用途不匹配的授予**」是真空洞。因此本片不重写已有用例，只补 3 条全部咬这一条路径的负向用例（N1／N2／N3），未凑数。

## 1. 审计：四条路径在 current main 的覆盖

逐条 `path:line`（均为可执行断言行，不是注释）：

| # | 路径 | current main 的现有覆盖 | 结论 |
|---|---|---|---|
| 1 | 撤回授权后继续用同一授权 | `tests/integration/auth-privacy-pg.mjs:308`（同键并发撤回 200/200 后，同一 token 再读 `/test-only/consent-read` ⇒ 403 `CONSENT_REQUIRED`）；`tests/integration/egress-ledger-pg.mjs:567`（撤回后 `POST /recognitions` ⇒ 403 `CONSENT_REQUIRED`）+ `tests/integration/egress-ledger-pg.mjs:569`（`countExports` 仍 1，被拒的入口不得新增账本行）；`tests/integration/consent-grant-pg.mjs:140`、`tests/integration/consent-grant-pg.mjs:145`（旧授予回执重放 ⇒ 403，命中 `services/api/src/privacy/grant-pg.ts:76-83` 的重放守卫） | **已覆盖**，不新增 |
| 2 | 用途不匹配的授予（用 A 用途政策授 B 用途） | **无显式用例**（把 purpose 谓词整体删掉时，既有 `tests/integration/consent-grant-pg.mjs:193` 与 `tests/integration/consent-grant-pg.mjs:195` 会间接变红，见 §3 变异 1 的复跑读数；但那两条断言的是「版本比对」与「政策过期」，不表达「用途即权限」，也没有正控制）。唯一形似的一条是 `tests/integration/consent-grant-pg.mjs:123`：它复用同一幂等键换成 `body('recording','fixture-v1',[])`，于是先撞 `services/api/src/privacy/grant-pg.ts:45` 的 `IDEMPOTENCY_CONFLICT`，**永远走不到** `services/api/src/privacy/grant-pg.ts:47` 的按用途取政策与 `services/api/src/privacy/grant-pg.ts:54` 的版本比对。`tests/integration/consent-zero-policy-pg.mjs` 只覆盖「全库 0 政策行」 | **真缺口 ⇒ 本片补 N1／N2／N3** |
| 3 | 在途作业期间撤回 | `tests/integration/egress-ledger-pg.mjs:537`（`synthetic.hang()` 制造在途）→ `tests/integration/egress-ledger-pg.mjs:545`（`DELETE /me/consents/external_inference` 200）→ `tests/integration/egress-ledger-pg.mjs:553`（export `error_code='CONSENT_WITHDRAWN'`）；`tests/integration/egress-revoke-race-pg.mjs:307` 起的真实行锁交错（写回 INSERT 前暂停、撤回事务被 `wait_event_type='Lock'` 挡住） | **已覆盖**，不新增（残留见 §6） |
| 4 | 旧结果回写（撤回后晚到的外部结果） | `tests/integration/egress-ledger-pg.mjs:565`（放行后 `writebackCount === 0`「撤回后晚到的提供者结果必须零写入」）；`tests/integration/egress-revoke-race-pg.mjs:279` + `tests/integration/egress-revoke-race-pg.mjs:286`（`guardWriteback` 抛 `OBJECT_UNAVAILABLE`、`export_writebacks` 0 行）；诚实性基线在同文件 `tests/integration/egress-revoke-race-pg.mjs:240`（首次恰好 1 行）与 `tests/integration/egress-revoke-race-pg.mjs:248`（重放不新增） | **已覆盖**，不新增 |

## 2. 新增用例

**落在已有文件 `tests/integration/consent-grant-pg.mjs` 里**（新块 `tests/integration/consent-grant-pg.mjs:255-318`，插在该文件 try 块末尾、`ALL … passed` 汇总行之前），**没有**新建 `tests/integration/*.mjs`：

- 原因一（判据对口）：这个文件就是「授予」的宿主，N1／N2 咬的 `services/api/src/privacy/grant-pg.ts:47` 与 `services/api/src/privacy/grant-pg.ts:54` 正是它一直在测的两行。
- 原因二（锚点成本，实测过）：第一版做成了新文件 `tests/integration/consent-purpose-mismatch-pg.mjs`，为满足 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS`（未接线脚本必须逐条声明）就得在该测试里加一条声明，+14 行把 607／691／695-696 全部推后，实测会因此漂移的历史证据页只有 1 份：`docs/verification/gy-r65-wire-posthide-arm-20261027.md:148`（若要跟上位移应指 `tests/unit/ci-integration-chain-structure.test.mjs:620`）当场被判 `SUSPECT`；其余 13 处锚该文件的引用都落在插入点之前，不漂。把用例并进已声明的 `tests/integration/consent-grant-pg.mjs` 则只在 `tests/integration/consent-grant-pg.mjs:255` 之后加行，而 docs 对该文件的锚点只有 `tests/integration/consent-grant-pg.mjs:67`（`docs/reference/local-development.md:304`）与 `tests/integration/consent-grant-pg.mjs:175`（`docs/verification/gy-r34-i19-deletion-closure-20261023.md:125`），都在插入点之前 ⇒ 零漂移、也不必改别人写的证据页。
- 未改任何既有断言：`git diff --numstat origin/main..HEAD` 对该文件是 `64 0`（纯追加）；三条用例自带的局部 helper 是新增的 `recordOf`／`epochOf`／`withdrawP`（`tests/integration/consent-grant-pg.mjs:261-263`），既有 helper 与既有 `say(...)` 计数一个没动。
- 夹具：沿用该文件既有的 synthetic 政策夹具（`fixture://` + `allowSyntheticGrantPolicy` 注入，见 `tests/integration/consent-grant-pg.mjs:65-70`），本片只加了两个专属版本号 `fixture-neg-rec-v1`／`fixture-neg-ext-v1`，避免撞 `consent_policies_purpose_policy_version_key`。

| id | 用例 | 咬住的判据 | 断言位置 |
|---|---|---|---|
| N1 | 只有 `recording` 政策（**刻意**给它配置与 `external_inference` 同形的 `recipient_bindings`），用该政策的版本去授 `external_inference` | 按用途取政策必须得 0 行 ⇒ 403 `CONSENT_REQUIRED` + 文案「没有可用的已核验用途政策」，且 `consent_records`／`privacy_epochs`／`idempotency_keys` 三表零行；再用同一夹具授 `recording` 得 201（正控制：证明 403 不是夹具坏或接收方证据坏） | `tests/integration/consent-grant-pg.mjs:271`（403+code）、`tests/integration/consent-grant-pg.mjs:272`（文案）、`tests/integration/consent-grant-pg.mjs:273`（三表零行）、`tests/integration/consent-grant-pg.mjs:279`（正控制 201）、`tests/integration/consent-grant-pg.mjs:280-281`（正控制只写 recording） |
| N2 | `recording` 与 `external_inference` 两个政策同时启用，客户端拿 `recording` 的 `policy_version`（`fixture-neg-rec-v1`）去授 `external_inference` | 按用途取到的是 `external_inference` 自己的政策行，只有版本比对能拦住 ⇒ 409 `REVISION_CONFLICT` + 文案「用途政策版本已变化」，三表零行；正控制：正确版本 `fixture-neg-ext-v1` 201 且落库 `policy_version` 就是它 | `tests/integration/consent-grant-pg.mjs:289`（409+code）、`tests/integration/consent-grant-pg.mjs:290`（文案）、`tests/integration/consent-grant-pg.mjs:291`（零行）、`tests/integration/consent-grant-pg.mjs:294-296`（正控制 201 与落库版本） |
| N3 | 只授过 `external_inference`（revision 2）的用户，`DELETE /me/consents/recording` + `If-Match: "2"` | 撤回只能退掉路径里点名的用途 ⇒ 404 `NOT_FOUND`，且 `external_inference` 的 record 仍 `granted`/revision 2、epoch 仍 `current_epoch='1'`/`granted`、`recording` 仍无记录；正控制：同一记录经自己的用途撤回仍 200，record→`withdrawn`、epoch→`'2'`/`withdrawn` | `tests/integration/consent-grant-pg.mjs:306`（404）、`tests/integration/consent-grant-pg.mjs:307-310`（另一用途未动）、`tests/integration/consent-grant-pg.mjs:313-316`（正控制 200 后的真实状态） |

读数：`ALL 31 grant integration groups passed`（既有 28 组 + N1／N2／N3），`NODE_EXIT=0`。三条都钉 status 与 `error.code`（N1、N2 另把 `error.message` 钉到具体文案；N3 只钉 status＋code＋库内状态，不钉文案），三条都另钉库内行数/状态，不是只看状态码；每条还各带一个「同一夹具换个用途就成功」的正控制，避免把「夹具坏了」当成「守卫生效」。

## 3. 变异自检（全部在 commit 之前做完）

做法：把被测判据临时改坏 ⇒ 重跑整个 `tests/integration/consent-grant-pg.mjs` ⇒ 确认**新增用例**变红 ⇒ 只 `git checkout -- <那一个源文件>` 还原。每轮还原后都复核 `git status --porcelain`，除本页与测试文件外无残留。

| # | 变异（临时改坏） | 改动位置 | 基线读数 | 变异后读数 |
|---|---|---|---|---|
| 1 | 去掉按用途过滤政策：`WHERE purpose=$1 AND enabled` → `WHERE ($1::text IS NOT NULL) AND enabled` | `services/api/src/privacy/grant-pg.ts:47` | `PASS 29: N1 …`（403 `CONSENT_REQUIRED`） | **红在既有用例 `tests/integration/consent-grant-pg.mjs:193`（`PASS 1..17` 后 `409 !== 403`、`REVISION_CONFLICT`），N1（`tests/integration/consent-grant-pg.mjs:271`）未执行**——两次复跑一致。机制：`tests/integration/consent-grant-pg.mjs:190` 与 `tests/integration/consent-grant-pg.mjs:192` 先插入 ext `fixture-v2` 与 recording `fixture-recording` 两条政策，purpose 谓词消失后 seq scan 首行取到 ext 那条，于是先在 `services/api/src/privacy/grant-pg.ts:54` 撞版本比对 409。**因此这个变异不构成本用例的牙证**：它探到的是「purpose 谓词被整体删除」这类更粗的改动，红点落在既有用例上 |
| 2 | 把版本比对从「本用途政策行的版本」放宽成「全库任意 enabled 政策行存在这个版本就行」：`if (policy.policy_version !== input.policy_version)` → `if (!foreignVersion && …)` | `services/api/src/privacy/grant-pg.ts:54` | `PASS 30: N2 …`（409 `REVISION_CONFLICT`） | N2 **红**：`201 !== 409`（`tests/integration/consent-grant-pg.mjs:289`）；同一轮 `PASS 29`（N1）仍绿 ⇒ 两条用例不互相顶替，N2 咬的是「版本必须来自本用途那一行」 |
| 3 | 撤回时用途过滤失守：`AND p.purpose=$2` → `AND ($2::text IS NOT NULL)` | `services/api/src/privacy/consent-pg.ts:166` | `PASS 31: N3 …`（404 `NOT_FOUND`） | N3 **红**：`409 !== 404`（`tests/integration/consent-grant-pg.mjs:306`）。机制：record 选择失守后 `services/api/src/privacy/consent-pg.ts:188` 会真的去撤另一用途的 record，但 `services/api/src/privacy/consent-pg.ts:192` 的 epoch 更新仍按 purpose 过滤 ⇒ 事务整体回滚成 409；两处都失守才会真的撤错用途。同一轮 N1／N2 仍绿 |

两条**失败的变异尝试**（如实记录，都不是有效读数）：

1. 变异 1 最初写成 `WHERE ($1 IS NOT NULL) AND enabled`：Postgres 报 `42P18 could not determine data type of parameter $1` ⇒ 503 `PROVIDER_UNAVAILABLE`。那是**绑定错误**，不是「错用途政策顶替成功」，拿它当读数等于假证；改成 `$1::text` 后才是上表第 1 行。
2. 变异 2 最初直接删掉 `services/api/src/privacy/grant-pg.ts:54` 整行：确实变红，但红在**既有**用例 `tests/integration/consent-grant-pg.mjs:108`（`201 !== 409`），流程在那里就中止，**根本没跑到 N2**。也就是说「删掉版本比对」这件事早被既有用例咬住，N2 的增量价值不是「版本比对存在」，而是「版本比对**按用途**取」。因此换成上表第 2 行的放宽式变异，才把 N2 单独打红。

## 4. 四道闸门（worktree 根目录实跑）

| # | 闸门 | exit code | 关键计数行 |
|---|---|---|---|
| 1 | `node --test "tests/unit/*.test.mjs"` | 0 | `ℹ tests 5593`；`ℹ pass 5590`；`ℹ fail 0`；`ℹ skipped 3` |
| 2 | `CONSENT_GRANT_TEST_URL=postgres://postgres@127.0.0.1:55410/gengyun_consent_grant_test`（含 `GY_PG_BIN`）+ 全新库 `node tests/integration/consent-grant-pg.mjs` | 0 | `ALL 31 grant integration groups passed`（`PASS 1..31`）+ `NODE_EXIT=0` |
| 3 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | 0 | `BARE-ORPHAN: … 册 tools/doc-anchors-orphan-baseline.json 登记 3481 条；本次命中 3481 条、基线外新增 0 条、本次扫描面内陈旧 0 条`；`DRIFT-COUNT: ANCHOR_DRIFT 12 条`；`PASS: --strict 下没有基线之外的新增` |
| 4 | `node tools/verify-contract-status.mjs` | 0 | `PASS: 覆盖 130 条契约操作；已装配 130 条；implemented 19 / partial 111 / planned 0；横切维度 8 条；形状错误 0 项；语义错误 0 项`；`PASS: 中文表格一致` |

每次集成运行前都重建库（`dropdb --force` + `createdb`），脚本自身先断言 `public` 下 0 张表，所以「三表零行」类断言不会被上一轮残留行喂成假绿或假红。

闸门 1 有一个**前置条件**：`tests/unit/doc-anchor-relocation-identity.test.mjs:1317` 断言 `git merge-base HEAD origin/main !== HEAD`，也就是「本分支必须已经有一个提交」。因此工作树态首跑的退出码是 1，唯一失败就是这条守卫（`actual === expected === 0ecae98c…`、`AssertionError: base 与 HEAD 同一提交…不允许静默通过`）；本片提交后复跑同一命令则全绿，读数见上表。

## 5. 这些用例证明什么、不证明什么

**证明（每条都可机械复现，均在真库上跑）**

1. 请求 `external_inference` 而库里只有别用途的政策时，授予被 403 挡住，且 `consent_records`／`privacy_epochs`／`idempotency_keys` 一行都不写 —— 不是「先写后回滚」的假绿，三表零行是直接查库的读数。
2. 该 403 不能归因于夹具坏：同一份政策、同一批接收方绑定，换成它自己的用途（`recording`）就得 201。
3. 两个用途的政策都健在时，客户端拿错用途的 `policy_version` 会得到 409，且零行；正确版本仍是 201。也就是说「版本号」这一判据是**按用途**取的，不是全库随便命中一行。
4. `DELETE /me/consents/recording` 不会顺手撤掉 `external_inference` 的记录与 epoch；而同一记录从自己的用途撤回仍然成功（200、`withdrawn`、epoch 前进）。撤回的「用途边界」在两条边上都被钉住。

**不证明（本片口径之外，别把它当验收）**

1. **不证明任何外部供应商真的收到了删除请求或执行了删除。** 本片全部是本地合成传输 + synthetic 政策，未发出任何外发请求；「第三方删除请求／完成／失败」的可追溯性是 `tests/integration/egress-revoke-race-pg.mjs` 与第三方删除族的事，不是这里。
2. **不证明 7 日在线／30 日备份的留存行为。** 本片不推进任何时钟，`valid_until` 只放了 1 小时窗口；时间流逝后的留存/清除由 `tests/integration/retention-clock-drill-pg.mjs` 那一族负责。
3. **不证明 `evidence_ref`／`content_sha256` 由谁签、签得对不对。** 本片政策全是 `fixture://policy/terms`、`fixture://policy/review`、`content_sha256='a'*64`，只是让 synthetic 校验通过；签名与评审归属是运维/评审流程的事。
4. **不证明生产装配可用。** `allowSyntheticGrantPolicy` 只在测试 harness 打开；生产 app 拒绝 synthetic 政策的读数是 `tests/integration/consent-grant-pg.mjs:106`，不是本片。
5. **不证明作业表被终止。** `services/api/src/privacy/ledger-pg.ts:864-883` 的 `revokeInFlight` 只 `UPDATE public.exports`，不动 `jobs`；本片与既有用例都没钉 `jobs` 行（见 §6 第 1 条）。
6. **不证明跨用户隔离。** 三条用例各只用一个用户，跨用户的账本/撤回隔离不在本片。

## 6. 残留缺口（如实登记，本片不修）

1. **「撤回是否终止已受理的 job」的读面仍无断言**：`tests/integration/egress-ledger-pg.mjs:532` 撤回后只 `waitFor(() => terminalJobState(...))` 等「任意终态」，没有断言该终态的 `state`／`error_code`；而 `services/api/src/privacy/ledger-pg.ts:864-883` 只把 `exports` 置 `failed`，`jobs` 表不在其 UPDATE 范围内。要钉住这一点，需要有 `GET /jobs/{id}` 的读面断言 + 明确「撤回是否应级联 job」的产品口径 —— 解锁人是账本在途接线单的 owner，不是本片。
2. **`revokeInFlight` 的跨用户／跨用途过滤缺负控制**：`services/api/src/privacy/ledger-pg.ts:864-883` 里 `user_id=$1` 与 `required_consents ? $2` 两处过滤都没有「另一个用户/另一个用途的 export 不受影响」的用例。
3. **CI 覆盖是「搭车」而非「新接线」**：新用例落在 `tests/integration/consent-grant-pg.mjs`，而该文件已由 `.github/workflows/consent-grant-postgres.yml:35` 在真库 job 里跑、`.github/workflows/consent-grant-postgres.yml:37` 提供 `CONSENT_GRANT_TEST_URL` ⇒ 三条新用例**不需要**改 CI 就进了流水线。代价是它们与既有的 28 组同生共死：该 job 没有 skip 分支——缺 `CONSENT_GRANT_TEST_URL`／PG 时 `tests/integration/consent-grant-pg.mjs:11-15` 会立刻断言失败（`.github/workflows/real-pg-integration.yml:843-844` 自述该组脚本「没有 SKIP、没有 77：真库没起来就是红」），所以新用例与既有 28 组一样，真库没起来就红、不会静默跳过。另外该文件仍不在 `package.json` 的 `test:integration:http` 链里（那条链要求无 PG 可跑），`tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS` 条目保持原样未动。
4. **撤回侧只补了「无该用途记录」这一面**：`If-Match` 与当前 revision 不符的 `REVISION_CONFLICT` 已由 `tests/integration/consent-grant-pg.mjs` 与 `tests/integration/auth-privacy-pg.mjs` 的既有断言覆盖，本片未重复造。

## 7 R87 补片：§6② 的跨用户／跨用途负控制（2026-11-07，只追加，不改上文任何读数）

§6② 登记的缺口已由 `tests/integration/egress-ledger-pg.mjs` 的**第 12 节**补上（真实 PostgreSQL 17.11，本机隔离、仅回环）：

- **判据是逐字段**（`SELECT *` 整行 `deepStrictEqual`，含 `state`／`revision`／`error_code`／`updated_at`／`required_consents`），不是数行数；并带一条**正控制**（A 的目标行确实被撤：`failed` + `CONSENT_WITHDRAWN` + `revision+1`），否则「不变」是空断言。
- **四条判据腿**（编号随 `tests/integration/egress-ledger-pg.mjs:729-732`）：① **正控制**——撤回后 A 的目标行 `failed` + `CONSENT_WITHDRAWN` + `revision+1`（否则「不变」是空断言）；② **跨用途**——同用户另一用途的行不变（`checked_content` 的 `required_consents` 只有 `external_inference`）；③ **跨用户**——另一个用户的两行（一行 `sent`、一行 `reserved`）不变；④ **注销级**——`purpose=null` 的撤回只撤 A 剩下的那一行（计数恰为 1），B 仍逐字段不变。
- **负控制自证**（改源码 → 跑同一用例 → 还原，还原后 `sha256` 逐字节一致 = `2269C5F4…DB1D`）：把 `user_id=$1::uuid` 改宽成 `$1::uuid IS NOT NULL` ⇒ **腿③（跨用户）**变红（`tests/integration/egress-ledger-pg.mjs:794`：B 那行 `error_code` 由 `null` 变 `CONSENT_WITHDRAWN`）；把 `required_consents ? $2::text` 改宽成 `TRUE` ⇒ **腿②（跨用途）**变红（`tests/integration/egress-ledger-pg.mjs:792`）；两处还原后同一命令 14 组全 PASS。编号随 `tests/integration/egress-ledger-pg.mjs:729-732`（①正控制／②跨用途／③跨用户／④注销级），回跳请以行号锚点为准。
- 因此本页 §5⑥「不证明跨用户隔离」只适用于本片当时那三条用例，**不再适用于账本撤回路径**（本补片的证据只覆盖 `exports` 表的**撤回**——`revokeInFlight` 的 `UPDATE … WHERE user_id=…`；账本的列表／读面跨用户隔离仍无断言）；§6①（撤回不动 `jobs`）仍然开放，本补片没碰。
