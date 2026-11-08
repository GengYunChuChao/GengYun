# GY-R90 · 注释锚点影子闸门基线重收（2026-11-09）

> 页性质：收册作业页，不是新的判据。本页只记录「把 `tools/verification-comment-anchor-baseline.json` 在新 main 上重收一遍」这件事的读数、逐条归因与口径边界。
> 时刻与树：2026-11-09 02:24–02:52（Asia/Hong_Kong），`origin/main` = `af39bfe657b965042dec81a6c397509d04166a5d`，工作树分支 `ci/gy-r90-comment-anchor-rebaseline`（worktree `wt-cmtbase`）。
> 前作：`docs/verification/gy-r90-verification-comment-anchor-guard-20261109.md`（`#1119` 引入本工具与首版基线）。本页不追改那页的 `#1119` 时刻读数，只把其中两处不可复现的数字改掉（见 §五）。

## 一、结论速览

| 项 | 旧基线（`#1119`，树 `6497031`） | 重收后（`af39bfe6`） |
|---|---|---|
| 条目 | 1427 | **1422** |
| 文档 | 197 | **200** |
| 字节 | 316,705 | **315,546** |
| 文件 SHA-256 | `16E8D510EC63AFDB3CE3B33E0C017223B6AF2CB50B14E0B795C9643FFAC8AA0A` | `BD78E01699BD7F4201D21E1319CC9BCD6078E4118A42D3EC4738DA084D92F4D` |
| `scope` 字段 | `docs/verification/**/*.md` | 同（未改） |
| 生成方式 | `--write-baseline` | `--write-baseline`（未手写、未 `JSON.parse` 重写） |
| 闸门读数（默认口径） | 基线外新增 0、可收紧 0 | 基线外新增 0、可收紧 0 |
| 集合差 | — | `added` 62、`removed` 67 |

一句话：**条目净减 5 条、文档净增 3 篇，但底下是 62 条进、67 条出**——净差是巧合，逐条差异才是本页正文（§三、§四）。

## 二、重收动作与可复现读数

重收只用工具自己的入口，没有手写 JSON：

```
node tools/verify-verification-comment-anchors.mjs --write-baseline
```

尾行（EXIT 0）：

```
WRITE: tools/verification-comment-anchor-baseline.json 写入了 1422 条（accepted=gy-r90-comment-anchor-shadow-batch）
```

重生成后立刻回读（默认口径，EXIT 0）：

```
node tools/verify-verification-comment-anchors.mjs --scan docs/verification
VERIFICATION-COMMENT-ANCHOR-SCAN: candidates=8842 comment=1422 code=6657 blank=138 out-of-range=16 unresolved=284 fenced=318 duplicate=7 documents=365
VERIFICATION-COMMENT-ANCHOR-PASS: 基线内 1422 条注释锚点只告警，没有基线外新增
```

`documents=365` 是扫到的 Markdown 份数，基线条目只覆盖其中 200 篇（另 165 篇里没有注释行锚点，或锚点落在代码行/围栏内被跳过）；两个数字不是一回事。

重收前（同一棵树、同一命令，EXIT 1）作对照：

```
VERIFICATION-COMMENT-ANCHOR-SCAN: candidates=8842 comment=1422 code=6657 blank=138 out-of-range=16 unresolved=284 fenced=318 duplicate=7 documents=365
基线外新增 62 条、可收紧 67 条
```

`comment=1422` 在重收前后**完全一样**——这正说明重收不是「改判据」，只是把既有 62 条新锚点收进册子、把 67 条失效键清出去。

## 三、口径边界（闸门只对默认口径负责）

同一天、同一棵树上跑两种口径，读数差得很远：

| 口径 | 命令 | `comment` | 文档 | NEW | STALE | 首条判据 |
|---|---|---|---|---|---|---|
| **默认口径（闸门口径）** | `node tools/verify-verification-comment-anchors.mjs --scan docs/verification` | **1422** | 365 | 62 | 67 | 基线 `scope` 与工具头「判据边界」都只写 `docs/verification/**` |
| 诊断口径（**不是判据**） | `node tools/verify-verification-comment-anchors.mjs --scan docs` | 1587 | 446 | 227 | 67 | 会把 `docs/architecture/**`、`docs/reference/**`、`docs/research/**` 等一并扫进来 |

两个数字的差是 **165 条**，逐目录核对全部落在基线从未覆盖的目录（`docs/architecture`、`docs/reference`、`docs/research`、`docs/development-progress`、`docs/ui-state-inventory`、`docs/moderation`）。旧基线 1427 条的 197 个文档，`doc` 前缀 100% 是 `docs/verification/`。

三条事实决定了「不能顺手扩面」：

1. 基线文件的 `scope` 字段由 `tools/verify-verification-comment-anchors.mjs` 的 `renderBaseline()` 硬编码成 `docs/verification/**/*.md`，改扫描范围而不改它，就是让文件的自我声明与内容脱钩。
2. `docs/architecture/**` 的注释锚点由主工具 `tools/verify-doc-anchors.mjs` 的 `--symbol=strict` 负责；两者是分层关系，不是覆盖关系。
3. 若按诊断口径收册：基线会变成 1587 条并把 165 条范围外锚点写进一份自称 `scope=docs/verification` 的基线里，而默认口径随后会打印 165 条假的「可收紧基线」——那是制造假账，不是修闸门。

**结论：闸门只对默认口径负责。** 扩面属于另一笔改动，必须同时改三处（工具头「判据边界」声明、基线 `scope`、证据页），单独开 PR，不能顺手夹带。

## 四、`added` 62 条逐条分类

分类依据是**精确的集合差**：`baselineKey(entry)` = `doc|line|target|from` 的四元组，`to` 不参与（所以区间锚点换尾行不算变化）。62 条 = **漂移 48 条 + 真新增 14 条**；没有任何一条属于「目标文件消失」（消失只会出现在 `removed` 侧，见 §五）。

判定漂移用的是启发式配对：同 `doc` + 同 `target`、优先同 `from`、其次最近 `from`。**Δfrom 只说明位移幅度，不声称逐条一一对应**；集合层面的进/出是精确的，配对只是给人看的归因。下面三张表整表放在代码块里，刻意不让它们成为新的基线锚点——证据页钉 62 条注释行，下次谁改 SQL 就会把闸门打红；表内 `path:line` 是 2026-11-09 的快照。

### 4.1 漂移 48 条（既有锚点被改动的目标文件推移，文档侧未变或几乎未变）

```
#  | 文档 path:line                                                        | 目标 path:from                                                     | 旧 from | Δfrom | 目标行原文片段
D1  | docs/verification/gy-r28-speech-grants-20261021.md:109               | deploy/postgres-cvm/sql/20-login-roles.sql:811                     | 787     | +24   | -- #region gy-r28-runtime-domain-grants
D2  | docs/verification/gy-r28-speech-grants-20261021.md:129               | deploy/postgres-cvm/sql/20-login-roles.sql:811                     | 787     | +24   | -- #region gy-r28-runtime-domain-grants
D3  | docs/verification/gy-r28-sql-column-coverage-20261021.md:43          | deploy/postgres-cvm/sql/20-login-roles.sql:583                     | 559     | +24   | -- 为什么是「函数 EXECUTE」而不是「表写权限」
D4  | docs/verification/gy-r28-sql-column-coverage-20261021.md:84          | deploy/postgres-cvm/sql/20-login-roles.sql:738                     | 714     | +24   | --（空行注释）
D5  | docs/verification/gy-r28-w11-messages-purge-pg-20261021.md:93        | deploy/postgres-cvm/sql/20-login-roles.sql:591                     | 567     | +24   | -- 绝不留「看似收敛、点开 503/42501」的运行态。
D6  | docs/verification/gy-r28-w6-deletion-clock-20261021.md:114            | deploy/postgres-cvm/sql/20-login-roles.sql:794                     | 780     | +14   | --     `community_idempotency`（幂等台账先删后插…）、
D7  | docs/verification/gy-r28-w6-deletion-clock-20261021.md:114            | deploy/postgres-cvm/sql/20-login-roles.sql:804                     | 770     | +34   | --     任何行，注销闭集只能绕 `SECURITY DEFINER`…
D8  | docs/verification/gy-r28-w6-deletion-clock-20261021.md:115            | deploy/postgres-cvm/sql/20-login-roles.sql:385                     | 361     | +24   | -- 函数级断言逐字不动），回执 bearer 的读/写只有这三条函数这一个面。
D9  | docs/verification/gy-r31-i15-s1-s6-20261022.md:128                   | deploy/postgres-cvm/sql/20-login-roles.sql:640                     | 616     | +24   | -- 为什么需要它：`0041` 的两条 scope 函数在**主事务内**抛 G0008…
D10 | docs/verification/gy-r31-i15-s1-s6-20261022.md:134                   | deploy/postgres-cvm/sql/20-login-roles.sql:505                     | 514     | -9    | -- 迁移 0020 把写面收进 `SECURITY DEFINER` 函数 `public.set_feature_f…
D11 | docs/verification/gy-r31-i15-s1-s6-20261022.md:134                   | deploy/postgres-cvm/sql/20-login-roles.sql:538                     | 481     | +57   | -- 迁移 0020 的 `set_feature_flag` 已把 `action='set_flag'` 的审计行写…
D12 | docs/verification/gy-r34-jobs-retire-20261024.md:158                 | deploy/postgres-cvm/sql/90-assert-least-privilege.sql:3698          | 3608    | +90   | -- 的「usage 记账」口径静默落空），所以这里必须硬断言…
D13 | docs/verification/gy-r71-jobs-ledger-20261030.md:188                 | deploy/postgres-cvm/sql/20-login-roles.sql:1004                    | 984     | +20   | -- 统一作业台账 `public.jobs`（建表 0001…）
D14 | docs/verification/gy-r71-jobs-ledger-20261030.md:189                 | deploy/postgres-cvm/sql/20-login-roles.sql:1005                    | 981     | +24   | -- `services/api/src/jobs/ledger.ts` 的 `JOB_LEDGER_UPSERT_SQ…
D15 | docs/verification/gy-r71-jobs-ledger-20261030.md:190                 | deploy/postgres-cvm/sql/20-login-roles.sql:1008                    | 980     | +28   | --   ① 6 列 = 冲突目标 `id` + `WHERE` 里的 `state`…
D16 | docs/verification/gy-r72-assert-domain-visibility-20261102.md:32     | deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2374          | 2368    | +6    | -- 时一定逐条点得出是哪一条、期望什么、实际读到什么 SQLSTATE。
D17 | docs/verification/gy-r72-assert-domain-visibility-20261102.md:37     | deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2402          | 2396    | +6    | -- DEFINER 函数就会按调用者可影响的名字解析对象…
D18 | docs/verification/gy-r72-assert-domain-visibility-20261102.md:58     | deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2374          | 2368    | +6    | -- 时一定逐条点得出是哪一条…
D19 | docs/verification/gy-r72-jobs-owner-select-20261102.md:13            | deploy/postgres-cvm/sql/20-login-roles.sql:1021                    | 997     | +24   | --   ② CI 臂 `consent-grant-postgres-17.11` 的 `tests/integrat…
D20 | docs/verification/gy-r72-jobs-owner-select-20261102.md:34            | deploy/postgres-cvm/sql/20-login-roles.sql:1021                    | 997     | +24   | --   ② CI 臂 `consent-grant-postgres-17.11`…
D21 | docs/verification/gy-r72-jobs-owner-select-20261102.md:35            | deploy/postgres-cvm/sql/20-login-roles.sql:1004                    | 980     | +24   | -- 统一作业台账 `public.jobs`…
D22 | docs/verification/gy-r72-jobs-owner-select-20261102.md:132           | deploy/postgres-cvm/sql/20-login-roles.sql:1004                    | 980     | +24   | -- 统一作业台账 `public.jobs`…
D23 | docs/verification/gy-r72-jobs-owner-select-20261102.md:163           | deploy/postgres-cvm/sql/20-login-roles.sql:1004                    | 980     | +24   | -- 统一作业台账 `public.jobs`…
D24 | docs/verification/gy-r72-jobs-owner-select-20261102.md:180           | deploy/postgres-cvm/sql/20-login-roles.sql:1004                    | 980     | +24   | -- 统一作业台账 `public.jobs`…
D25 | docs/verification/gy-r72-moderation-conclusion-freshness-20261102.md:72 | deploy/postgres-cvm/sql/20-login-roles.sql:1535                  | 1512    | +23   | -- 的 4 列 + `ON CONFLICT (target_type,target_id,target_revisi…
D26 | docs/verification/gy-r72-moderation-conclusion-freshness-20261102.md:72 | deploy/postgres-cvm/sql/20-login-roles.sql:1537                  | 1510    | +27   | -- SELECT 面**只给被 WHERE / 冲突目标 / 回填真正读到的列**…
D27 | docs/verification/gy-r72-online-purge-closed-set-20261102.md:53      | deploy/postgres-cvm/sql/20-login-roles.sql:1021                    | 997     | +24   | --   ② CI 臂 `consent-grant-postgres-17.11`…
D28 | docs/verification/gy-r72-online-purge-closed-set-20261102.md:107     | deploy/postgres-cvm/sql/20-login-roles.sql:1004                    | 997     | +7    | -- 统一作业台账 `public.jobs`…
D29 | docs/verification/gy-r72-online-purge-closed-set-20261102.md:195     | deploy/postgres-cvm/sql/20-login-roles.sql:1004                    | 980     | +24   | -- 统一作业台账 `public.jobs`…
D30 | docs/verification/gy-r72-online-purge-closed-set-20261102.md:195     | deploy/postgres-cvm/sql/20-login-roles.sql:1021                    | 980     | +41   | --   ② CI 臂 `consent-grant-postgres-17.11`…
D31 | docs/verification/gy-r72-online-purge-closed-set-20261102.md:197     | deploy/postgres-cvm/sql/20-login-roles.sql:1004                    | 980     | +24   | -- 统一作业台账 `public.jobs`…
D32 | docs/verification/gy-r87-i19-cancel-ruling-20261107.md:42            | services/api/src/privacy/deletion-requests-pg.ts:134                | 109     | +25   | /** 注销请求的持久化端口（只暴露「受理」这一个动作）。 */
D33 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:86    | .github/workflows/real-pg-integration.yml:240                       | 240     | 0     | # 该脚本自建 5 组角色 + 运行时 LOGIN…
D34 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:87    | .github/workflows/real-pg-integration.yml:243                       | 243     | 0     | # 本地取证（PG 17.11 + scram 认证 + `gengyun_ci_owner`）：exit=0，PASS
D35 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:88    | .github/workflows/real-pg-integration.yml:243                       | 243     | 0     | 同 D34
D36 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:88    | .github/workflows/real-pg-integration.yml:258                       | 258     | 0     | # 本地取证（PG 17.11 + scram 认证 + `gengyun_ci_owner`）：PASS 13 组
D37 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:89    | .github/workflows/real-pg-integration.yml:351                       | 351     | 0     | # 本地取证（PG 17.11 + 空库 + 库 owner，exit=0）：读数 41 组…
D38 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:90    | .github/workflows/real-pg-integration.yml:545                       | 545     | 0     | # 本地取证（PG 17.11 + 空库 + 属主等价 `gengyun_ci_owner`）：exit=0…
D39 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:91    | .github/workflows/real-pg-integration.yml:585                       | 585     | 0     | # 本地取证（本机 PG 17.11 二进制 + 临时数据目录）：exit=0…
D40 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:92    | .github/workflows/real-pg-integration.yml:684                       | 684     | 0     | # 它自证 8 组（全链迁移后两张策略表在岗／过期·未过期·贴边造数…
D41 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:93    | .github/workflows/real-pg-integration.yml:737                       | 737     | 0     | # （service 集群 + 从 `20-login-roles.sql` 原样抽 D5 区）…
D42 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:94    | .github/workflows/real-pg-integration.yml:750                       | 750     | 0     | # `timeout-minutes: 5`：本机实测整臂（initdb + 43 个迁移…
D43 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:95    | .github/workflows/real-pg-integration.yml:753                       | 753     | 0     | # `[A]`–`[H]` 8 组读数 + 末行 `[ALL PASS]`…
D44 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:96    | .github/workflows/real-pg-integration.yml:780                       | 780     | 0     | # `timeout-minutes: 5`：本机实测整臂 ≈ 20 s…
D45 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:97    | .github/workflows/real-pg-integration.yml:844                       | 844     | 0     | # 读数必然掉到 < 19 ⇒ 这一步当场红…
D46 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:128   | .github/workflows/real-pg-integration.yml:1676                      | 1676    | 0     | # 所以「本机 11 组 PASS」不等于「CI 覆盖了它」…
D47 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:128   | .github/workflows/real-pg-integration.yml:1678                      | 1678    | 0     | # 它钉的是 11 组 PASS：每帖 ≤3 张的上限计数…
D48 | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:132   | .github/workflows/real-pg-integration.yml:1699                      | 1699    | 0     | # （末行 `[ALL PASS] … 共 N 组 PASS` + `N ≥ 11`）…
```

成因（`git log` 实测，全部在 `6497031..af39bfe6` 内）：

- **D1–D32（32 条）＝ `1ac256ec`（`#1108` `fix(privacy): 注销受理事务内擦除身份`，2026-11-09 01:28:47）**。该提交往 `deploy/postgres-cvm/sql/20-login-roles.sql` 与 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 插了行，SQL 行号整体 +24（个别 +6/+14/+20/+23/+25/+27/+34/+41/+57/+90），另把 `services/api/src/privacy/deletion-requests-pg.ts` 的端口注释从 109 推到 134。文档一行没改 ⇒ 48 条里 32 条是「同一目标行、新行号」。
- **D33–D48（16 条）＝ `9f09fcb3`（`#1120` `test(ci): 修正闸门标签与清单自洁`）**。该提交改 `docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md`，文档侧插了 4 行、末尾又加了 4 行，于是这 16 条锚点的**文档行号 +4/+8 而目标行号一字不动**（Δfrom 全为 0）。旁证：`d7160e40`（`#1123`）虽然最后改过 `.github/workflows/real-pg-integration.yml`，但它「行数零变化」，不是成因。

### 4.2 真新增 14 条（新文档带进来的新锚点，目标行本身也存在）

```
#   | 文档 path:line                                                     | 目标 path:from-to                                          | kind         | 目标行原文片段
N1  | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:206 | .github/workflows/deploy-sql-gate.yml:17-17                | hash-comment | #      · `deploy-sql-17-11`（5 组）＝**生产默认形态**…
N2  | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:207 | .github/workflows/deploy-sql-gate.yml:19-19                | hash-comment | #      · `deploy-sql-17-11-cli-groups`（7 组）…
N3  | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:208 | .github/workflows/deploy-sql-gate.yml:21-21                | hash-comment | #        根本不存在，所以默认 job 不建它们…
N4  | docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md:208 | .github/workflows/deploy-sql-gate.yml:58-58                | hash-comment | # R28-S64 追加取证（7 组形态，端口 55661）…
N5  | docs/verification/gy-r90-contract-runtime-schema-parity-20261109.md:93  | tests/unit/contract-runtime-schema-parity.test.mjs:289-289 | line-comment | // 判据③：规范化自身的分辨率（既不过敏，也不迟钝）
N6  | docs/verification/gy-r90-contract-runtime-schema-parity-20261109.md:243 | tests/unit/contract-runtime-schema-parity.test.mjs:345-345 | line-comment | // 判据③c：属性名与文档键同名时不许被丢掉…
N7  | docs/verification/gy-r90-i1112-assertion-audit-20261109.md:9       | tests/unit/miniprogram-voice-hardening.test.mjs:903-903     | line-comment | // 计数恒等式（created - destroyed === live）不在这里断言…
N8  | docs/verification/gy-r90-i1112-assertion-audit-20261109.md:11      | tests/unit/miniprogram-voice-hardening.test.mjs:903-903     | line-comment | 同 N7
N9  | docs/verification/gy-r90-i1112-assertion-audit-20261109.md:66      | tests/unit/miniprogram-voice-hardening.test.mjs:903-903     | line-comment | 同 N7
N10 | docs/verification/gy-r90-i1112-assertion-audit-20261109.md:88      | tests/unit/miniprogram-voice-hardening.test.mjs:903-903     | line-comment | 同 N7
N11 | docs/verification/gy-r90-i1112-assertion-audit-20261109.md:114     | tests/unit/miniprogram-voice-hardening.test.mjs:934-934     | line-comment | // 下面两条读的是**状态机内部字段**…
N12 | docs/verification/gy-r90-open-issue-acceptance-index-20261109.md:176 | services/api/src/recognitions/openai-vision-adapter.ts:22-22 | block-comment | * 本文件是**骨架**：零真实供应商、零真实调用、零准确率证据。
N13 | docs/verification/gy-r90-open-issue-acceptance-index-20261109.md:429 | services/api/src/recognitions/openai-vision-adapter.ts:22-22 | block-comment | 同 N12
N14 | docs/verification/gy-r90-open-issue-acceptance-index-20261109.md:456 | services/api/src/recognitions/openai-vision-adapter.ts:22-22 | block-comment | 同 N12
```

这 14 条全部是「本轮新页引用了本来就存在的注释行」：`deploy-sql-gate.yml` 的 4 条 hash 注释、`contract-runtime-schema-parity.test.mjs` 的 2 条 `//` 判据注释、`miniprogram-voice-hardening.test.mjs` 的 5 条 `//` 注释、`openai-vision-adapter.ts` 头部那一段 block 注释（3 条锚点同指 22 行）。来源提交：`365d3740`（`#1126`）出 `contract-runtime-schema-parity` 页、`bef0ba63`（`#1118`）出 `i1112-assertion-audit` 页；`openai-vision-adapter.ts` 本身是 `54a4ab23`（2026-11-07）的老文件，只是到本轮才有页引用它的头部注释。

**判定：无一条「真新增注释」被误判成漂移，也无一条漂移被误判成真新增。** 两类在 `baselineKey` 上可分：真新增的 `target` 在旧基线里根本不存在（`deploy-sql-gate.yml`、两个 test 文件、`openai-vision-adapter.ts` 整文件），漂移的 `target` 在旧基线里有同 `doc` 的老键。

## 五、`removed` 67 条与 STALE 分类

67 条出册 = **48 条漂移配对（§4.1 同一条的另一半）+ 19 条无替代**。没有一条是「文档被删」或「目标文件解析不了」；19 条无替代里，16 条是**锚点被主动改指**，3 条是**目标行被代码顶掉**。

```
#   | 旧键 文档:line                                                      | 目标 path:from-to                                              | describeStale 判定                                    | 目标行现内容（前 60 字）
G1  | docs/verification/gy-r28-w6-deletion-clock-20261021.md:32           | deploy/postgres-cvm/sql/90-assert-least-privilege.sql:2555-2560 | 目标行已不是注释行（疑似已修）                          | AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplicat
G2  | docs/verification/gy-r28-w6-deletion-clock-20261021.md:116          | 同上 2555-2560                                                  | 同上                                                  | 同上
G3  | docs/verification/gy-r28-w6-deletion-clock-20261021.md:376          | 同上 2555-2560                                                  | 同上                                                  | 同上
G4  | docs/verification/gy-r87-i30-http-e2e-20261107.md:164              | tests/integration/post-media-attach-http-pg.mjs:767-767          | 目标行仍是注释行（基线键含文档行号 164…）              | // PASS 9 · 24h 自衰减（时间穿越，只动 SQL 行）
G5  | docs/verification/gy-r87-i30-http-e2e-20261107.md:164              | tests/integration/post-media-attach-http-pg.mjs:877-877          | 同 G4                                                 | // PASS 11 · `/complete` 迁移：真字节 → `ready` → 挂帖释放
G6  | docs/verification/gy-r88-i30-pool-decay-20261108.md:125            | tests/integration/post-media-attach-http-pg.mjs:767-767          | 同 G4                                                 | // PASS 9 · 24h 自衰减…
G7  | docs/verification/gy-r88-i30-pool-decay-20261108.md:126            | tests/integration/post-media-attach-http-pg.mjs:820-820          | 同 G4                                                 | // PASS 10 · `state` 四值矩阵 + `deleted`/`rejected` 不占位
G8  | docs/verification/gy-r88-i30-pool-decay-20261108.md:128            | tests/integration/post-media-attach-http-pg.mjs:820-820          | 同 G4                                                 | 同 G7
G9  | docs/verification/gy-r88-i30-pool-decay-20261108.md:129            | tests/integration/post-media-attach-http-pg.mjs:877-877          | 同 G4                                                 | 同 G5
G10 | docs/verification/gy-r88-open-issue-acceptance-index-20261108.md:68 | tests/integration/post-media-attach-http-pg.mjs:767-767          | 同 G4                                                 | 同 G4
G11 | docs/verification/gy-r88-open-issue-acceptance-index-20261108.md:68 | tests/integration/post-media-attach-http-pg.mjs:877-877          | 同 G4                                                 | 同 G5
G12 | docs/verification/gy-r89-open-issue-acceptance-index-20261108.md:30 | tests/integration/post-media-attach-http-pg.mjs:767-767          | 同 G4                                                 | 同 G4
G13 | docs/verification/gy-r89-open-issue-acceptance-index-20261108.md:30 | tests/integration/post-media-attach-http-pg.mjs:820-820          | 同 G4                                                 | 同 G7
G14 | docs/verification/gy-r89-open-issue-acceptance-index-20261108.md:30 | tests/integration/post-media-attach-http-pg.mjs:877-877          | 同 G4                                                 | 同 G5
G15 | docs/verification/gy-r89-open-issue-acceptance-index-20261108.md:53 | tests/integration/post-media-attach-http-pg.mjs:767-767          | 同 G4                                                 | 同 G4
G16 | docs/verification/gy-r89-open-issue-acceptance-index-20261108.md:71 | tests/integration/post-media-attach-http-pg.mjs:767-767          | 同 G4                                                 | 同 G4
G17 | docs/verification/gy-r89-open-issue-acceptance-index-20261108.md:71 | tests/integration/post-media-attach-http-pg.mjs:877-877          | 同 G4                                                 | 同 G5
G18 | docs/verification/gy-r89-open-issue-acceptance-index-20261108.md:179 | tests/integration/post-media-attach-http-pg.mjs:767-767         | 同 G4                                                 | 同 G4
G19 | docs/verification/gy-r89-open-issue-acceptance-index-20261108.md:180 | tests/integration/post-media-attach-http-pg.mjs:877-877         | 同 G4                                                 | 同 G5
```

- **G1–G3（3 条）：目标行被 #1108 的插行顶掉。** `90-assert-least-privilege.sql` 第 2555–2560 行原是一段注释块，`1ac256ec` 在该文件上部插了 6 行后整块下移，现在注释块首行是 `-- 5. 不得是迁移管理员成员（否则等于拿到超级用户）`（现第 2561 行），而第 2555 行变成了 `to_regclass('public.admin_audit_events') IS NOT NULL` 这样的代码。文档没改指 ⇒ 旧键失效、无替代。**这是「目标已消失」里唯一一类真消失：注释还在，只是不在那个行号了。**
- **G4–G19（16 条）：锚点被 `9946370f`（`#1116` `docs(verification): HTTP 臂锚点改指行为行`）主动改指，不是漂移。** 该提交把这几页对 `post-media-attach-http-pg.mjs` 的引用从块首注释（767／820／877）改成行为行（786／792-796／845-849／893），并在页里写明理由：「这两组的块首注释分别在第 767、877 行，是注释而不是行为行，故不再引作主证据」。实测 `af39bfe6` 上落到该文件的注释锚点是 **0** 条；`describeStale` 只能看到「旧键不在新扫描里」，所以给的是保守措辞「目标行仍是注释行…疑似键位移」——真实原因是文档侧主动改指，不是键位移。`afedd3df`（`#1122`）随后又校正了这几页的措辞与 AppID 口径，但不影响这 16 条的失效结论。

**STALE 67 的归类（不要与 `NEW` 混读）**：`NEW` 是「基线里没有、扫描里有」= 62；`STALE` 是「基线里有、扫描里没有」= 67。两侧不是同一批对象：48 条在两侧同时出现（同一个锚点行号变了，旧键出、新键进），另 19 条只出不进。

## 六、修掉 `#1119` 页两处不可复现读数

`#1119` 的审查者指出的两处读数，本片逐条复现后按实测改：

### 6.1 朴素口径「初版 1590 条 / 减少 163 条」→ 实测 **1683 / 256**

原写法把「朴素口径」（把块注释开状态判据换回「行内出现 `/*` 就开」，也就是不看该行是否以 `/*` 开头）的读数写成 1590 条、相对 1427 减少 163 条。实测不是这个数：

- `tools/verify-verification-comment-anchors.mjs` 现版本在判断块注释时要求整行以 `/*` 开头（`commentKindsOf`），这是为了不被 `"description": "audio/*"` 这类字符串误开状态；
- 把这一句换回「行内出现 `/*` 就开状态」、其余一字不动，在**同一棵** `6497031` 树上跑：`comment` 从 1427 变 **1683**，`code` 从 6371 变 6115，基线外新增 **256** 条；
- 256 条多出来的锚点全部指向 `packages/contracts/openapi.json` 的 JSON 行（例如 `"x-scope": "sources:write",`、`"description": "SCOPE_DENIED, …"`），即「字符串里出现 `/*` 就把后续行当注释」的经典误判。

复现命令（不需要改仓库里的工具，用一个只改了这一处的临时副本）：

```
git worktree add E:\GengYunCommander\.pg17\wt-cmtbase-hist --detach 6497031677a6ca0d7c453d18a6415ad3e68fce69
# 从 af39bfe6 取当前工具与旧基线，放进该 worktree；再把 tools/verify-verification-comment-anchors.mjs:99 的判据改成 line.includes('/*')
node E:\GengYunCommander\.pg17\cmtbase-artifacts\naive-anchor-probe.mjs --root E:\GengYunCommander\.pg17\wt-cmtbase-hist
# ⇒ comment=1683、基线外新增 256
node tools/verify-verification-comment-anchors.mjs      # 同一棵树，原判据 ⇒ comment=1427、基线外新增 0、EXIT 0
```

`tests/unit/verify-verification-comment-anchors.test.mjs` 里有专门钉这一条的用例（`audio/*` 不许误开块状态），所以这个回归不会悄悄回来。

### 6.2 「8556 / 359」→ 拆成两个时点，各自绑树

原写法把两个时点的数字混在一句里，读起来像「当前读数」。实际是两个快照：

| 时点 | 树 | `candidates` | `documents` | `comment` | 说明 |
|---|---|---|---|---|---|
| 基线生成时 | `6497031`（本页未合入） | 8556 | 359 | 1427 | `comment` 与基线条数相等 ⇒ 基线外新增 0、EXIT 0 |
| 本页合入后 | `9862bb7b`（PR 头） | 8584 | 360 | 1427 | 本页自身 +28 `candidates`、+1 文档；28 条全落在代码行（`code` 6371→6399），`comment` 不变 ⇒ 基线不必重写 |

两个数字各自绑树绑时刻，都不是 main 当前读数。main 到 `af39bfe6` 的实际读数是 `candidates=8842`、`comment=1422`、`documents=365`（见 §二）。

复现：

```
git worktree add E:\GengYunCommander\.pg17\wt-cmtbase-head --detach 9862bb7b
cd E:\GengYunCommander\.pg17\wt-cmtbase-head
node tools/verify-verification-comment-anchors.mjs --scan docs/verification
# ⇒ candidates=8584 comment=1427 code=6399 documents=360、EXIT 0
```

`#1119` 页与测试头注都已按上面两节改写；页内 §一 1.3 那个「255」也一并作废（实测两棵树分别是「符号不在区间 44」+`UNDECLARED` 250／252，没有 255）。

## 七、闸门读数（本片全跑，EXIT 0）

七项都在同一棵树（本片提交后的工作树，基线 `af39bfe6`）上跑完，下面是 EXIT 与尾行原文。

**① 四连 strict anchors** —— `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs`：**EXIT 0**。

尾行：`PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）`；同行读数 `COUNT: BROKEN 0 / OUT_OF_RANGE 1 / SUSPECT 39 / NOT_SYMBOL_LINE 8（合计 48 条）`、`SYMBOL-COVERAGE-VERIFICATION: 可判 1015 条——OK 971、符号不在区间 44（仅 WARN，不影响 exit code）`、`ANCHOR-COUNT: 进判据锚点 9037 条 / 299 份文档`。

**② 锚点搬迁身份单测** —— `node --test tests/unit/doc-anchor-relocation-identity.test.mjs`：**EXIT 0**，`tests 37 / pass 37 / fail 0`。

**③ 契约状态** —— `node tools/verify-contract-status.mjs`：**EXIT 0**。

尾行：`PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。`

**④ 文档闸门** —— `npm run test:docs`：**EXIT 0**。

尾行：`PASS: 识别 5 页 / 跳过 361 页（扫描面 366 页：docs/verification）——读数七条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字 ⑦同页副本一致）`

**⑤ 钻孔读数** —— `node tools/verify-g-drill-readings.mjs --check`：**EXIT 0**。

尾行：`✓ 八条判据全过：workflows 15 / jobs 29 / 演练 21 条 / 测试文件 608（glob 合计 578）；生长型读数按**下界**判（--tolerant-growth），其中 8 条滞后已逐行打印`

**⑥ 本工具单测** —— `node --test tests/unit/verify-verification-comment-anchors.test.mjs`：**EXIT 0**，`tests 6 / pass 6 / fail 0`。

**⑦ 与 main 的合并冲突试算** —— `git merge-tree --write-tree --name-only origin/main HEAD`：**EXIT 0**，只打印一个含并的树哈希、没有任何冲突路径行（有冲突时该命令会把冲突名逐行列出并给非零退出码）。

> 闸门① 的 verification 面仍在「只 WARN 不判红」的收敛期，本片没有动它的基线与判据；闸门⑥ 的 6 条用例钉的是本工具的判据边界，不钉仓库基线（基线漂移由闸门①的 COMMENT_ANCHOR 面负责）。

## 八、不声称

- 不声称注释锚点「全部正确」：本片只保证**基线等于当前树**，`1422` 条里仍然包含「目标行是注释但内容已过时」这类问题；`baselineKey` 只认「文档行 + 目标行 + 目标路径」，不认语义。
- 不声称本工具等价于主闸门：它不解析符号、不校验区间尾行、不区分 `to`，覆盖面（目标文件类型、锚点形态）与 `tools/verify-doc-anchors.mjs` 的 strict 面不同，两者**不能相减**。
- 不声称闸门能抓到「文档行内容与目标行内容不匹配」：它只比对行号是否还在注释行上，不做语义比对。
- 不声称扩面到 `docs/**` 已完成：本片**明确拒绝**顺手扩面，扩面必须三处同改、单独一笔 PR（见 §三）。
- 不声称 62/67 的逐条配对是精确的：集合差精确，配对的 Δfrom 只用于归因。
