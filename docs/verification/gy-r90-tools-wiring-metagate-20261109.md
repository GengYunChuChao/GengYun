# R90 `tools/**` 接线元闸门：给每个守卫脚本点名「谁来跑它」（2026-11-09，返修版）

> 读数快照：2026-11-09（Asia/Hong_Kong）。本分支 base 已并入 `origin/main` `a4183da623215b675d3d088d402dec091f57c41e`
> （本片起点是 `a30c8adb`；自那以后 `tools/**`、`.github/workflows/**`、`package.json` 的 diff 为空，47 个脚本与 15 份
> workflow 的接线面没有变化，变的是 `#1137` 让 `tools/verify-verification-comment-anchors.mjs` 有了真仓守卫）。
> 本片只改 `tests/**` 与本页：**不动 `.github/**`、不动 `tools/**`**。
>
> 版本说明：第一版（`4a110df6`）被监工与独立审查各判「判定面会误报」——文件级退出码断言、`run:` 只看文本出现、
> 仓库根标识符不核落点、夹具副本能被当成真仓跑、`prepare-wechat` 被误判成已接线。本页与代码都是修完之后的读数，
> 修法与红/绿证据在 §六。

## 一、为什么要这道闸：三件事可以同时为真

`tools/verify-verification-comment-anchors.mjs` 的空档是一个**已发生**的事故，不是假想：

1. 它当时的唯一守卫 `tests/unit/verify-verification-comment-anchors.test.mjs` 全绿——但那份守卫的文件头写着
   「全部用临时目录夹具 + 直接调 `main()`，⛔ 不 spawn 子进程、不写仓库内文件」，它**只在夹具上跑导出函数**；
2. 同一份工具在**真仓**上跑是 `EXIT 1`（基线外新增 9 条），这个结果没人看得到，因为没有一条流水线跑它；
3. 15 份 workflow 里没有任何 `run:` 点名它 ⇒ **CI 全绿**。

于是「单测绿 + 真仓红 + CI 绿」三件事同时成立，而且能一直成立下去。既有元闸门
`tests/unit/ci-orphan-tests-wired.test.mjs` 已经把 `tests/**` 的接线面钉死了，但它**只看 `tests/**`**：
`tools/**` 是它扫不到的空档。本片就是把这块空档本身变成被测对象——不判断这些脚本的判据对不对，只判断
**有没有人跑它**。

> `#1137`（`a4183da6`）之后，那条通道由 `tests/unit/verification-comment-anchor-gate-on-repo.test.mjs` 在真仓上跑
> （`tests/unit/verification-comment-anchor-gate-on-repo.test.mjs:48` spawn + `tests/unit/verification-comment-anchor-gate-on-repo.test.mjs:98` 断言 `run.status`），按本片判据已经是 B 类接线——所以它**不在**本版白名单里。

## 二、判据：A1 / A2 / B，以及六种「看起来像接线其实不算」

| 类 | 定义 | 本片怎么判（v3） |
| --- | --- | --- |
| **A1** | 某份 `.github/workflows/*.yml` 的 `run:` 文本里**点名并执行**该路径 | 按 `;\|&&\|\|\|\|` 与换行切段、按空白/引号切词；路径必须落在**执行位**（同段更早出现 `node`/`npm`/`bash` 等运行器，或段首本身是可执行脚本）；`echo`/`printf`/`cat`/`grep` 等只把路径当数据的段跳过 |
| **A2** | 该工具由 `package.json` 的某个 script 点名，而那个 script 被某份 workflow 以 `npm run <script>` 调起 | 两段都要成立：script 文本点名 + `run:` 里真有人 `npm run` 它（只认真的被调用的 script） |
| **B** | 某个 `tests/` 下的 `.mjs` **在仓库根 spawn 它**，且**这一次 spawn 的退出码**被断言 | spawn 家族（`spawnSync`/`execFileSync`/`execSync`/`execFile`/`spawn`）+ 工具路径锚在**仓库根解析出的绝对路径**上（`join(ROOT,'tools','x.mjs')`、`new URL('../tools/x.mjs', import.meta.url)` 或它们的别名；argv 里的裸相对字面量只在该 spawn 的 `cwd` 已核实为仓库根时才算）+ `cwd` 是仓库根/继承/默认值即仓库根 + 退出码断言绑定到**该站点的返回值**（含 helper 返回值 4 跳消费链） |

**六种不算**（前四种正是 `verify-verification-comment-anchors` 踩过的坑，后两种是本版返修补的）：

1. **仅 import**：`import { main } from '../../tools/x.mjs'; main();`——模块级单测，导入成功就能绿，工具真仓跑红它也绿；
2. **只夹具**：在 `mkdtempSync()` 出来的临时树 / `cpSync` 的工程树副本上 spawn，判定的是夹具不是真仓；
3. **没有退出码断言**：spawn 了真仓工具但只看 stdout 文本，工具 `EXIT 1` 时测试照样绿；
4. **只在文档/注释里出现**：`README` 与 `package.json` 写了用法，等于没人跑；
5. **蹭别的站点的断言**：同一文件里有另一处 `assert.equal(other.status, 0)`，不代表这一次 spawn 的退出码被检查过；
6. **路径只出现在参数位**：`spawnSync(node, [copy, '--compare', 'tools/x.mjs'])` 里被跑的是副本，`tools/x.mjs` 只是参数——
   只认 `args[0]`，窗口里别处出现的路径一律不算。

> 反例就在仓里：`tests/unit/verify-verification-comment-anchors.test.mjs:29` import 三个导出函数、`:67` 起临时目录，
> 全仓 `tests/` 里**没有任何一处**在真仓 spawn 它（当时）——按上面的口径，它一条 B 证据都没有。

## 三、47 个 `tools/*.mjs` 的四类现状（逐条到 `文件:行`）

扫描面：47 个顶层 `tools/*.mjs`、15 份 workflow、164 条 `run:` 步、714 个 `tests/` 下的 `.mjs`。
汇总：**已接线 33**（A1 15 + A2 3 + B 15）、**只 import 8**、**只夹具 1**、**完全无引用 5**。33 + 8 + 1 + 5 = 47。

### 3.1 已接线（33）

| 脚本 | 面 | 证据（文件:行） | 强度 |
| --- | --- | --- | --- |
| `tools/ai-config.mjs` | A1 | `.github/workflows/access-verification.yml:28` | 仅语法级 `node --check` |
| `tools/verify-tencent-live.mjs` | A1 | `.github/workflows/access-verification.yml:21` | 仅语法级 `node --check` |
| `tools/verify-provider-adapter-live.mjs` | A1 | `.github/workflows/access-verification.yml:22` | 仅语法级 `node --check` |
| `tools/verify-llm-live.mjs` | A1 | `.github/workflows/access-verification.yml:24` | 仅语法级 `node --check` |
| `tools/verify-tokenhub.mjs` | A1 | `.github/workflows/access-verification.yml:26` | 仅语法级 `node --check` |
| `tools/prepare-ai-verification.mjs` | A1 | `.github/workflows/access-verification.yml:29` | 仅语法级 `node --check` |
| `tools/verify-env.mjs` | A1 | `.github/workflows/access-verification.yml:35` | 仅语法级 `node --check` |
| `tools/check-wechat-project.mjs` | A1 | `.github/workflows/local-wechat.yml:55` | 真跑 |
| `tools/demo-align.mjs` | A1 | `.github/workflows/local-wechat.yml:60` | 真跑 |
| `tools/verify-layout.mjs` | A1 | `.github/workflows/local-wechat.yml:61` | 真跑 |
| `tools/verify-contract-status.mjs` | A1 | `.github/workflows/engineering-shell.yml:111`（另有 4 条 B 证据） | 真跑 + 真仓 spawn |
| `tools/verify-doc-anchors.mjs` | A1 | `.github/workflows/engineering-shell.yml:112` | 真跑（四连 strict） |
| `tools/verify-reading-pages.mjs` | A1 | `.github/workflows/engineering-shell.yml:113` | 真跑 |
| `tools/verify-research-records.mjs` | A1 | `.github/workflows/development-docs.yml:45`（另有 `tests/unit/research-records-gate.test.mjs:67` 与 `tests/unit/research-records-gate.test.mjs:499`） | 真跑 + 真仓 spawn |
| `tools/verify-migrations-unique.mjs` | A1 | `.github/workflows/migrations-guard.yml:83` 与 `.github/workflows/migrations-guard.yml:87`（另有 `tests/unit/ci-migrations-guard-annotations.test.mjs:59`） | 真跑 + 真仓 spawn |
| `tools/lint-workspaces.mjs` | A2 | `.github/workflows/engineering-shell.yml:43` → `scripts.lint` | 真跑 |
| `tools/verify-admin-capability-map.mjs` | A2 | `.github/workflows/engineering-shell.yml:114` → `scripts.verify:capability-map` | 真跑 |
| `tools/verify-purge-schedule.mjs` | A2 | `.github/workflows/engineering-shell.yml:173` → `scripts.verify:purge-schedule` | 真跑 |
| `tools/import-consent-policy.mjs` | B | `tests/unit/consent-policy-import.test.mjs:883` | 真仓 spawn + `.status`（缺真 PG 会 skip） |
| `tools/purge-expired-backup-copies.mjs` | B | `tests/integration/backup-copies-purge-pg.mjs:572` | 真仓 spawn + `.status`（真库臂） |
| `tools/purge-expired-media.mjs` | B | `tests/unit/media-purge-driver.test.mjs:344` | 真仓 spawn + `.status` |
| `tools/purge-expired-online-data.mjs` | B | `tests/integration/online-purge-pg.mjs:379` | 真仓 spawn + `.status` |
| `tools/purge-retention-expired.mjs` | B | `tests/integration/retention-purge-pg.mjs:216` | 真仓 spawn + `.status` |
| `tools/release-gate.mjs` | B | `tests/unit/release-gate.test.mjs:40` | 真仓 spawn + `.status`（**弱**：真仓臂多为 `--list`/`--help`/`--only pg`(skip)，见 §八） |
| `tools/verify-chain-e2e-r29.mjs` | B | `tests/unit/chain-e2e-tool.test.mjs:111`（另有 `:134`/`:195`/`:241`/`:300`） | 真仓 spawn + `.status` |
| `tools/verify-g-drill-readings.mjs` | B | `tests/unit/g-drill-readings.test.mjs:1018` | 真仓 spawn + `.status`（另两臂带 `--root` 夹具，不计） |
| `tools/verify-release-materials.mjs` | B | `tests/unit/release-materials-index.test.mjs:52` | 真仓 spawn + `.status`（镜像臂是夹具，不计） |
| `tools/verify-sample-gap.mjs` | B | `tests/evaluation/gy-i20-sample-gap-recompute.test.mjs:96`/`:106` | 真仓 spawn + `.status` |
| `tools/verify-verification-comment-anchors.mjs` | B | `tests/unit/verification-comment-anchor-gate-on-repo.test.mjs:48` | 真仓 spawn + `.status`（`#1137` 接线） |
| `tools/run-python.mjs` | B | `tests/unit/tools-repo-run-smoke.test.mjs:33` | 真仓 spawn + `.status`（**只断言 argv 契约**，见 §八） |
| `tools/openapi-route-parity.mjs` | B | `tests/unit/tools-repo-run-smoke.test.mjs:42` | 真仓 spawn + `.status`（完整判定） |
| `tools/verify-gy-i09-candidates.mjs` | B | `tests/unit/tools-repo-run-smoke.test.mjs:55` | 真仓 spawn + `.status`（完整判定） |
| `tools/i22-failmatrix-evidence-table.mjs` | B | `tests/unit/i22-failmatrix-evidence-table-guard.test.mjs:235`（调用点，helper 形态） | 真仓 spawn + `.status`（v2 认得 helper 调用点，见 §六 变异 A） |

7 个只有 `node --check` 的脚本：**语法级点名也算接线，但不假装它够**（见 §八）。

### 3.2 只 import（8）：导出函数被进程内调用，真仓从未 spawn

| 脚本 | 引用点（文件:行） | 说明 |
| --- | --- | --- |
| `tools/collect-g-drill.mjs` | `tools/verify-g-drill-readings.mjs:55`、`tests/unit/g-drill-readings.test.mjs:72` | 纯函数库，宿主已接线 |
| `tools/contract-status-core.mjs` | `tests/unit/contract-status-tool.test.mjs:422`（动态 import） | 核心库，宿主 `verify-contract-status` 已接线 |
| `tools/contract-status-runtime.mjs` | `tools/contract-status-core.mjs:68`（宿主内部 `execFileSync`） | 二层宿主，`tests/` 无引用 |
| `tools/local-debug-config.mjs` | `tests/local-debug.test.mjs:9` | 配置读取器，被 `local-wechat.yml:57` 的测试进程内驱动 |
| `tools/local-debug-server.mjs` | `tests/local-debug.test.mjs:10` | 回环 HTTP 服务，同上 |
| `tools/local-env.mjs` | `tests/unit/local-env.test.mjs:809` | 本机栈编排（真 PG17 + gitignored `.env`） |
| `tools/verify-production-provisioning.mjs` | `tests/unit/production-provisioning.test.mjs:15` | 有 `report → exit` 语义，由测试注入假凭据进程内驱动 |
| `tools/verify-real-capability-config.mjs` | `tests/unit/real-capability-config.test.mjs:33` | 有 `exitCodeFor(report)` 语义，读 gitignored 本地配置 |

### 3.3 只夹具（1）：spawn 了，但点在临时树上

| 脚本 | 引用点（文件:行） | 说明 |
| --- | --- | --- |
| `tools/prepare-wechat.mjs` | `tests/local-debug.test.mjs:100` → `tests/local-debug.test.mjs:105`、`tests/local-debug.test.mjs:249`、`tests/unit/prepare-wechat-components.test.mjs:47` → `tests/unit/prepare-wechat-components.test.mjs:60` | **v1 误判成 B**：三个站点全是 `cpSync` 出来的副本（见 §六 变异 C） |

> `tools/i22-failmatrix-evidence-table.mjs` 曾登记在「只夹具」：它的守卫用 `runTool(TOOL, [...], ROOT)` 在真仓跑，
> 只是被包在 `function runTool(toolPath, args, cwd)` 里、脚本位是形参——v2 起按 helper **调用点**建站点，
> 它回到 B 类（`tests/unit/i22-failmatrix-evidence-table-guard.test.mjs:235`），白名单里那条随之删除。

### 3.4 完全无引用（5）：`tests/`、15 份 workflow、`package.json` 里都没有判定面

| 脚本 | 唯一「提及」 | 说明 |
| --- | --- | --- |
| `tools/i22-failmatrix-negative-control.mjs` | 只在 `tests/failmatrix/mutations.mjs` 的**注释块**里被提到一次、外加 `tests/failmatrix/README.md` 的命令清单（第 22-23 行）与工具表（第 75 行） | 文字提及，不是接线 |
| `tools/openapi-route-inventory.mjs` | 无 | 0 命中；只被宿主 `tools/openapi-route-parity.mjs:82` 当子进程调起 |
| `tools/verify-chat-live.mjs` | 无 | 0 命中（受控付费取证，头注框在人工范围） |
| `tools/verify-gy-i05-log-redaction.mjs` | 无 | 0 命中（负例对照探针，需人工对比 `before/after`） |
| `tools/verify-provider-live-r28.mjs` | 无 | 0 命中（头注明令不得进 CI） |

## 四、白名单 14 条：逐条一句话理由

`tests/unit/orphan-tools-wired-baseline.json`。`kind` 四档：`library`（库模块，接线由 host 承担）、
`in-process`（由 CI 会跑的测试在进程内驱动，没有独立退出码）、`by-design`（确实不该接）、
`gap`（**本该接，本片接不了**——本版为 0 条：三条走 B 类接上了，见 §六 变异 E）。

| # | 脚本 | kind | 一句话理由 |
| --- | --- | --- | --- |
| 1 | `tools/collect-g-drill.mjs` | library | 纯函数库（`runDrillPlan`/`readSha`/`readDirty`），无 CLI，接线由 host `verify-g-drill-readings` 负责 |
| 2 | `tools/contract-status-core.mjs` | library | 契约锚点核心库，host `verify-contract-status` 已在 `engineering-shell.yml:111` 被点名 |
| 3 | `tools/contract-status-runtime.mjs` | library | 运行期探针，由 `contract-status-core.mjs:68` 子进程调起，两层宿主最终落在已接线的 `verify-contract-status` |
| 4 | `tools/local-debug-config.mjs` | in-process | 配置读取器，被 `local-wechat.yml:57` 点名的 `tests/local-debug.test.mjs:9` 进程内驱动 |
| 5 | `tools/local-debug-server.mjs` | in-process | 回环调试服务，常驻无一次性退出码，由 `tests/local-debug.test.mjs:10` 驱动 |
| 6 | `tools/i22-failmatrix-negative-control.mjs` | by-design | 人工变异执行器（27 条负控制），`README` 的命令清单与工具表都写明人工执行，进 CI 会把「负控制按预期失败」误报成红 |
| 7 | `tools/local-env.mjs` | by-design | 本机开发栈编排（真 PG17 + 固定端口 + gitignored `.env`）；`tests/unit/local-env.test.mjs:809` 只 import 一个辅助函数 `stopSpawnedApi`，不构成接线 |
| 8 | `tools/openapi-route-inventory.mjs` | by-design | 一次性盘点脚本，只打印路由表 JSON，没有断言与退出码语义；唯一调用方是宿主 `openapi-route-parity.mjs:82`（已接线） |
| 9 | `tools/prepare-wechat.mjs` | by-design | 装配微信开发者工具工程，只有真微信工程树才有意义（会写 `project.config.json` 一类文件）；三个站点全是 `cpSync` 副本，按判据属「只夹具」 |
| 10 | `tools/verify-chat-live.mjs` | by-design | 受控付费取证：默认零外发（无 `--approved` 只预检 `exit 2`），需外发台账 + 单独授权 + 最多 2 次付费调用 |
| 11 | `tools/verify-provider-live-r28.mjs` | by-design | 文件头第 19 行明写「⛔ 本工具不得被任何 workflow 引用，也不得进任何 `test:*` 套件」 |
| 12 | `tools/verify-production-provisioning.mjs` | in-process | 真云控制台核对：脚本要生产只读凭据，但判定逻辑有退出码语义，已由 `tests/unit/production-provisioning.test.mjs` 注入假凭据进程内驱动 |
| 13 | `tools/verify-real-capability-config.mjs` | in-process | 读 `.gitignore:42` 忽略的 `config.local.json`，裸跑必红；但 `exitCodeFor(report)` 有退出码语义，已由 `tests/unit/real-capability-config.test.mjs:33` 进程内驱动 |
| 14 | `tools/verify-gy-i05-log-redaction.mjs` | by-design | 负例对照探针：要在「改前」的 `app.ts` 上跑并 `tee before.log` 人工对比，固化进 CI 等于把历史源码塞进流水线 |

14 条 = 47 − 33，与 §三 的四类表逐条对得上。**没有为了让它绿把本该接的塞进 by-design**：
- 第一版登记为 `gap` 的 4 条（`run-python`、`openapi-route-parity`、`verify-gy-i09-candidates`、
  `verify-verification-comment-anchors`）全部退出了白名单——前三条由新增的 `tools-repo-run-smoke` 在真仓跑，
  最后一条由 `#1137` 的守卫在真仓跑（§六 变异 E）。
- 第二版把 `i22-failmatrix-evidence-table` 从 by-design 里删掉：它不是「无判定面」，而是判定被包在 helper 里，
  属于**元闸门认不出**而非「不该接」——按审查要求改成认 helper 调用的**真仓调用点**，它回到 B 类（§六 变异 A）。
  这也是本页要区分「人工归类」与「机器判定」的地方：表里的 kind 是人工判断，机器只认 A/B 证据。

## 五、判据代码怎么写的

`tests/unit/ci-orphan-tools-wired.test.mjs`（六条判据，测试名带 ①–⑥）：

1. **① 扫描面下界**：47 tools / 15 workflows / 164 `run:` 步 / 714 测试文件的下界（工具 44、workflow 14、
   run 140、测试 600），外加「一个 spawn 站点都没解析出来 ⇒ 红」。解析器坏掉时先红，避免「扫到 0 条所以全绿」。
2. **② 未接线必须登记**：`classify(tool)` 返回证据数组，空数组 = 未接线；未接线且不在白名单 ⇒ 红，逐条点名并给三条修法。
3. **③ 白名单不得过期**：已接线却还在白名单 ⇒ 红「已过期，删掉它」（与 `ci-orphan-tests-wired` 同口径：**过期判红**）。
4. **④ 白名单自身可核**：路径必须 ∈ 当前 47 个脚本；`kind` ∈ 四档；`reason` ≥ 12 字；`library` 的 `host`
   必须存在且**沿 host 链最终接到已接线脚本**（`contract-status-runtime → core → verify-contract-status` 走得通）；
   `in-process` 的 `exercisedBy` 必须是真测试文件且被某份 workflow（含 `npm run` 转接）跑到。
5. **⑤ 反向控制**：把合成文本喂给同一批判据函数，**20 条边**逐条断言——YAML 注释 `run` 不算、块标量里的 shell
   注释不算、`echo` 之后的路径不算、`node --check` 算、整词才算、`paths:` 不造 `run` 步、仅 import ⇒ 0 站点、
   夹具 cwd 不算、`--root` 改指夹具不算、真仓 spawn + `.status` 算、没有 `.status` 断言不算、`cwd = ROOT` 默认参数算、
   同文件另一站没断言 ⇒ 仍不算、`cpSync` 副本 ⇒ 0 站点、裸相对字面量有/无 `cwd` 两种结果，
   以及 v3 新增的六条：**参数位/重定向目标/`bash -c` 内层参数/npm 参数位都不算执行位**（P1-4）、
   **`'--root=' + tmp` 拼接算改指夹具**（P2）、**helper 真仓调用点算 / helper 夹具调用点不算**（P1-1）、
   **同文件同名 `const result` 不串号**（P1-3）、**argv[0] 是副本、字面量只在参数位 ⇒ 0 站点**（P1-2）。
6. **⑥ gap 台账 + 读数**：`kind: gap` 逐条 `t.diagnostic`（不判红），并打印「已接线 A1/A2/B + 白名单四档」读数供对账。

实现上几个必须**配平/求值**而不是正则截断的地方（每一处都踩过一次）：

- `cwd` 取值要读到**顶层的** `,` / `}`：`cwd: fileURLToPath(new URL('../../', import.meta.url))` 里的逗号
  会让 `[^,}\n]+` 提前截断，把真仓跑误判成夹具（`tests/integration/online-purge-pg.mjs:379` 就这么被误判过）；
- `{cwd, ...}` 简写要回看形参默认值：`tests/unit/release-gate.test.mjs:40` 的 `function gate(args, cwd = ROOT)`；
- **仓库根标识符要求值**：`resolve(dirname(fileURLToPath(import.meta.url)), …)` 只说明「相对本文件算了条路径」，
  必须按该测试文件的位置求值后**恰好等于仓库根**才登记；从 `tools/*.mjs` import 进来的 `REPO_ROOT`
  也走同一把尺子（读那个模块自己的根表达式求值）；
- **被执行的脚本只认 argv[0]**：`spawnSync(cmd, args)` 里 `args[0]` 才是被执行对象；窗口里别处出现的
  `'tools/x.mjs'`（参数位、`cpSync` 源、比较参数）一律不算——第一版就是被这条骗过的（P1-2）；
- **退出码断言按站点绑定**：`statusAssertions` 收集 `assert.*(X.status)` 的**位置**，`valueConsumers` 记下
  `const r = runTool(...)`／`const run = (a) => spawn(...)` 的**绑定位置**，再要求断言落在该站点所属的
  `enclosingBlock` 内——同名标识符在别的 `test()` 里被断言不算（P1-3）；
- **helper 站点建到调用点**：`spawnSync(..., [toolPath, ...])` 里脚本位是形参时，用 `functionParams` +
  `helperCallSites` 把站点改记在调用点上，实参须是锚在仓库根的 `tools/x.mjs`、`cwd` 实参须是仓库根；
- **`run:` 只认执行位**：切段后剥行尾注释、跳过 `NON_EXEC` 段首（`echo`/`cat`/`grep`…）、`bash -c` 内层递归、
  `npm|pnpm|yarn` 之后全是参数位、`>`/`>>` 之后不算、段首在 `RUNNERS` 时第一个非 `-` 参数才是脚本位（P1-4）；
  注释里写明这是**降级口径**：`node --import ./pre.mjs tools/x.mjs` 会被判「没接线」，宁可低估。

## 六、变异自证：红/绿原文

每一行都是本机实跑（`node --test tests/unit/ci-orphan-tools-wired.test.mjs`，Node v24.16.0），
做法是**把判据改回旧行为**（而不是改断言或改预期），确认对应那条边会红；改完即恢复。
三条 P1 的反例形状照审查给的原文构造（副本 + 参数位字面量、同名 `const result`、参数位路径）。

**变异 A（P1-1 分类纠错）：关掉 helper 调用点展开**（`for (const call of []) {`）

```
✖ ② 未接线的 tools/*.mjs 必须在白名单里写明理由
  AssertionError [ERR_ASSERTION]: 以下 1 个 tools 脚本既没被 workflow 的 run: 点名，也没有在真仓上跑它并断言退出码的测试，且不在白名单里（只 import / 只夹具 / 无 .status 断言都不算接线）：
    - tools/i22-failmatrix-evidence-table.mjs
✖ ⑤ 反向控制：合成文本喂同一批判据函数
  AssertionError [ERR_ASSERTION]: helper 的真仓调用点必须被认成一个站点
ℹ pass 4 / ℹ fail 2
```

恢复后：`ℹ pass 6 / ℹ fail 0`。这条正是审查 P1-1 的实测：`i22-failmatrix-evidence-table` 有真仓臂
（`tests/unit/i22-failmatrix-evidence-table-guard.test.mjs:235` 的 `runTool(TOOL, [...], ROOT)` + `:236` 的
`assert.equal(result.status, 1, …)`），把它写成 by-design 是错的。

**变异 B（P1-2）：把「窗口里任意位置的 `'tools/x.mjs'` 字面量」兜底加回来**

反例形状（审查原文）：`cpSync` 到 tmpdir 后 spawn **副本**，参数位里带仓内路径、`cwd: ROOT`、`assert.equal(result.status, 0)`。

```
✖ ⑤ 反向控制：合成文本喂同一批判据函数
  AssertionError [ERR_ASSERTION]: 跑的是副本，参数位里的仓内路径不能算接线
ℹ pass 5 / ℹ fail 1
```

恢复后：`ℹ pass 6 / ℹ fail 0`。现在只认 `spawnSync(cmd, args)` 的 `args[0]`（且必须锚在仓库根上）。

**变异 C（P1-3）：把站点级断言换成「文件里有人断言过这个标识符就算」**（`if (hits.length > 0) return true;`）

反例形状（审查原文）：test a 里 `const result = spawnSync(...)` 只断言 `.stdout`；test b 里
`const result = compute(); assert.equal(result.status, 0)`。

```
✖ ⑤ 反向控制：合成文本喂同一批判据函数
  AssertionError [ERR_ASSERTION]: 同名的 result 在别的块里被断言，不能算这一站的证据
ℹ pass 5 / ℹ fail 1
```

恢复后：`ℹ pass 6 / ℹ fail 0`。

**变异 D（P1-4）：把「只有执行位算」换回「同段任意 token 出现过就算」**

```
✖ ⑤ 反向控制：合成文本喂同一批判据函数
  AssertionError [ERR_ASSERTION]: 参数位不算执行
ℹ pass 5 / ℹ fail 1
```

恢复后：`ℹ pass 6 / ℹ fail 0`。四条反例（参数位 / `>` 重定向目标 / `bash -c` 内层参数 / `npm run x -- path`）
一起钉在 ⑤ 里，同时保留 `bash -c "node tools/verify-demo.mjs"` 必须为真的正控制。

**变异 E：从白名单删掉 `tools/local-env.mjs`（入口仍在，只是不再免检）**

```
✖ ② 未接线的 tools/*.mjs 必须在白名单里写明理由
  AssertionError [ERR_ASSERTION]: 以下 1 个 tools 脚本既没被 workflow 的 run: 点名，也没有在真仓上跑它并断言退出码的测试，且不在白名单里（只 import / 只夹具 / 无 .status 断言都不算接线）：
    - tools/local-env.mjs
ℹ pass 5 / ℹ fail 1
```

恢复后：`ℹ pass 6 / ℹ fail 0`。

**变异 F：把已接线的 `tools/verify-contract-status.mjs` 塞进白名单**（③ 过期口径）

```
✖ ③ 白名单不得过期：已接线的条目必须删掉
  AssertionError [ERR_ASSERTION]: 白名单里有条目已经被接线了（已过期，删掉它，否则白名单会越养越松）：
  +   'tools/verify-contract-status.mjs（.github/workflows/engineering-shell.yml:111（run: 点名））'
```

其余五条判据仍绿（`✔ ② ✔ ④ ✔ ⑤ ✔ ⑥`）。恢复后：`ℹ pass 6 / ℹ fail 0`。

**变异 G（gap 退场）：新增 `tests/unit/tools-repo-run-smoke.test.mjs`**

```
✔ tools/run-python.mjs：不带参数必须 exit 2 并打印用法（argv 契约） (86.9ms)
✔ tools/openapi-route-parity.mjs：真仓路由表与契约一致（退出码即判定） (2449.0ms)
✔ tools/verify-gy-i09-candidates.mjs：六类分支与用量守卫逐条通过 (167.6ms)
ℹ pass 3 / ℹ fail 0
```

三者在元闸门里随即变成 B 类（§3.1 后三行），`gap` 台账从 4 条降到 0 条。

## 七、六道闸门（本片实跑）

| # | 闸门 | 命令 | EXIT | 尾行摘录 |
| --- | --- | --- | --- | --- |
| ① | 四连 strict anchors | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | 0 | `本次：不在区间 44、UNDECLARED 258、配成对 1317`；`PASS: --strict 下没有基线之外的新增` |
| ② | 锚点搬迁身份单测 | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | 0 | `ℹ tests 37 / ℹ pass 36 / ℹ fail 0 / ℹ skipped 1`（提交前跑会红：`base == HEAD` 时拒绝静默通过） |
| ③ | 契约状态 | `node tools/verify-contract-status.mjs` | 0 | `PASS: 中文表格一致`；`PASS: 状态为人工判定…` |
| ④ | 文档闸门 | `npm run test:docs` | 0 | `PASS: 识别 5 页 / 跳过 368 页（扫描面 373 页：docs/verification）——读数七条判据全部自洽` |
| ⑤ | 钻孔读数 | `node tools/verify-g-drill-readings.mjs --check` | 0 | `✓ 八条判据全过：workflows 15 / jobs 30 / 演练 21 条 / 测试文件 611（glob 合计 581）` |
| ⑥ | 与 main 合并试算 | `git merge-tree --write-tree --name-only origin/main HEAD` | 0 | 输出只有一行树哈希、**没有冲突路径行**（树哈希随任何文字改动而变，故不在此钉死具体值） |

### 七之一、本页自己被下游闸门抓了一次（真实案例，不是夹具）

返修轮推送后 `unit-tests` 红，红的两条不在本片新测试里，而在 `tests/unit/verification-comment-anchor-gate-on-repo.test.mjs`：

```
✖ ① 真仓正控制：仓库根跑整道闸门 EXIT 0，基线外新增 0、可收紧 0
✖ ② 防「扫了个寂寞」：本次命中 == 基线条目数，documents ≥ 300
```

原因是本页 §三 的一行把「某脚本只在别处被注释提过」写成了 `path:行` 形式、而那行恰好是注释行 ⇒ `tools/verify-verification-comment-anchors.mjs` 的读数从 `命中 1422 / 基线 1422` 变成 `命中 1423 / 基线 1422`，**基线外新增 1 条**。修法不是改基线（那是把红灯写进册子），而是把那处引用改成**不带冒号行号的散文引述**；改后读数回到 `本次命中 1422、基线 1422、基线外新增 0、可收紧 0`，两条红灯转绿。

这件事本身值得记下来：**元闸门的文档也会被下游闸门抓**——写「某脚本只在注释里被提过」时，别用只对注释行成立的 `path:行` 锚点，否则等于给下游闸门送了一条新违章。本片因此把「文档里的锚点」也算进了自检面。

## 八、不声称

- **不声称这些脚本的判据本身正确**：本闸门只问「有没有人跑」，不问「跑出来的判定对不对」。
  `release-gate` 的 secrets/artifacts 判据、`verify-sample-gap` 的读数口径，本片一个字没验。
- **不声称 A 的强度足够**：7 个脚本只有 `node --check`（§3.1 标了「仅语法级」），语法通过不等于门禁判定跑过。
- **不声称 B 的强度整齐**：判据只要求「这一次 spawn 的退出码被断言」，不要求断言覆盖工具的全部判定面。
  `tools-repo-run-smoke` 里 `run-python` 只断言不带参数退 2 的 argv 契约；`release-gate` 的真仓臂偏弱
  （`--list` / `--help` / `--only pg`(skip)，`--base HEAD` 空 diff 臂不断言 status）——它们算「接线」，但不算「验过」。
- **不声称替代真正的 CI 接线**：B 类接线的判定面比在 workflow 里单列一步窄（没有独立 job、没有路径过滤、
  没有 failure annotation）。要让 `tools/**` 的接线强度整体上一个台阶，仍应另开 B 档 PR 往 `.github/workflows/**` 加 `run:`。
- **不声称不误报**：本闸门是静态解析（不做 shell / JS 语义分析）。方向是**宁可低估**——`cwd` 不明、
  路径不锚、断言不绑定到站点，一律不算接线；代价是少数真接线可能被判未接线，需要显式登记或改写成可判形态。
- **不声称 by-design 的判断有外部背书**：这些理由来自各工具的文件头自述、`.gitignore`、以及
  `access-verification.yml:43` 的 `git check-ignore` 证据；它是本片的判断，不是工具作者的授权。
- **不声称白名单可以长期不动**：③ 只挡「已过期」，挡不住「理由变得不成立」；理由失真需要人工复审。
