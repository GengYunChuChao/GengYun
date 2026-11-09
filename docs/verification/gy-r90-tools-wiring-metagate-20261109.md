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

## 二、判据：A1 / A2 / B，以及五种「看起来像接线其实不算」

| 类 | 定义 | 本片怎么判（v2） |
| --- | --- | --- |
| **A1** | 某份 `.github/workflows/*.yml` 的 `run:` 文本里**点名并执行**该路径 | 按 `;\|&&\|\|\|\|` 与换行切段、按空白/引号切词；路径必须落在**执行位**（同段更早出现 `node`/`npm`/`bash` 等运行器，或段首本身是可执行脚本）；`echo`/`printf`/`cat`/`grep` 等只把路径当数据的段跳过 |
| **A2** | 该工具由 `package.json` 的某个 script 点名，而那个 script 被某份 workflow 以 `npm run <script>` 调起 | 两段都要成立：script 文本点名 + `run:` 里真有人 `npm run` 它（只认真的被调用的 script） |
| **B** | 某个 `tests/` 下的 `.mjs` **在仓库根 spawn 它**，且**这一次 spawn 的退出码**被断言 | spawn 家族（`spawnSync`/`execFileSync`/`execSync`/`execFile`/`spawn`）+ 工具路径锚在**仓库根解析出的绝对路径**上（`join(ROOT,'tools','x.mjs')`、`new URL('../tools/x.mjs', import.meta.url)` 或它们的别名；argv 里的裸相对字面量只在该 spawn 的 `cwd` 已核实为仓库根时才算）+ `cwd` 是仓库根/继承/默认值即仓库根 + 退出码断言绑定到**该站点的返回值**（含 helper 返回值 4 跳消费链） |

**五种不算**（前四种正是 `verify-verification-comment-anchors` 踩过的坑，第五种是本版返修补的）：

1. **仅 import**：`import { main } from '../../tools/x.mjs'; main();`——模块级单测，导入成功就能绿，工具真仓跑红它也绿；
2. **只夹具**：在 `mkdtempSync()` 出来的临时树 / `cpSync` 的工程树副本上 spawn，判定的是夹具不是真仓；
3. **没有退出码断言**：spawn 了真仓工具但只看 stdout 文本，工具 `EXIT 1` 时测试照样绿；
4. **只在文档/注释里出现**：`README` 与 `package.json` 写了用法，等于没人跑；
5. **蹭别的站点的断言**：同一文件里有另一处 `assert.equal(other.status, 0)`，不代表这一次 spawn 的退出码被检查过。

> 反例就在仓里：`tests/unit/verify-verification-comment-anchors.test.mjs:29` import 三个导出函数、`:67` 起临时目录，
> 全仓 `tests/` 里**没有任何一处**在真仓 spawn 它（当时）——按上面的口径，它一条 B 证据都没有。

## 三、47 个 `tools/*.mjs` 的四类现状（逐条到 `文件:行`）

扫描面：47 个顶层 `tools/*.mjs`、15 份 workflow、164 条 `run:` 步、714 个 `tests/` 下的 `.mjs`。
汇总：**已接线 32**（A1 15 + A2 3 + B 14）、**只 import 8**、**只夹具 2**、**完全无引用 5**。32 + 8 + 2 + 5 = 47。

### 3.1 已接线（32）

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

7 个只有 `node --check` 的脚本：**语法级点名也算接线，但不假装它够**（见 §八）。

### 3.2 只 import（8）：导出函数被进程内调用，真仓从未 spawn

| 脚本 | 引用点（文件:行） | 说明 |
| --- | --- | --- |
| `tools/collect-g-drill.mjs` | `tools/verify-g-drill-readings.mjs:55`、`tests/unit/g-drill-readings.test.mjs:72` | 纯函数库，宿主已接线 |
| `tools/contract-status-core.mjs` | `tests/unit/contract-status-tool.test.mjs:422`（动态 import） | 核心库，宿主 `verify-contract-status` 已接线 |
| `tools/contract-status-runtime.mjs` | `tools/contract-status-core.mjs:68`（宿主内部 `execFileSync`） | 二层宿主，`tests/` 无引用 |
| `tools/local-debug-config.mjs` | `tests/local-debug.test.mjs:9` | 配置读取器，被 `local-wechat.yml:57` 的测试进程内驱动 |
| `tools/local-debug-server.mjs` | `tests/local-debug.test.mjs:9` | 回环 HTTP 服务，同上 |
| `tools/local-env.mjs` | `tests/unit/local-env.test.mjs:809` | 本机栈编排（真 PG17 + gitignored `.env`） |
| `tools/verify-production-provisioning.mjs` | `tests/unit/production-provisioning.test.mjs:15` | 有 `report → exit` 语义，由测试注入假凭据进程内驱动 |
| `tools/verify-real-capability-config.mjs` | `tests/unit/real-capability-config.test.mjs:33` | 有 `exitCodeFor(report)` 语义，读 gitignored 本地配置 |

### 3.3 只夹具（2）：spawn 了，但点在临时树上

| 脚本 | 引用点（文件:行） | 说明 |
| --- | --- | --- |
| `tools/i22-failmatrix-evidence-table.mjs` | `tests/unit/i22-failmatrix-evidence-table-guard.test.mjs:44`（建夹具树）、`:142`（跑夹具副本） | 真仓那份从未被跑；它还需要未入库的 `.artifacts/matrix.json` |
| `tools/prepare-wechat.mjs` | `tests/local-debug.test.mjs:100` → `tests/local-debug.test.mjs:105`、`tests/local-debug.test.mjs:249`、`tests/unit/prepare-wechat-components.test.mjs:47` → `tests/unit/prepare-wechat-components.test.mjs:60` | **v1 误判成 B**：三个站点全是 `cpSync` 出来的副本（见 §六 变异 E） |

### 3.4 完全无引用（5）：`tests/`、15 份 workflow、`package.json` 里都没有判定面

| 脚本 | 唯一「提及」 | 说明 |
| --- | --- | --- |
| `tools/i22-failmatrix-negative-control.mjs` | `tests/failmatrix/mutations.mjs:5`（注释）、`tests/failmatrix/README.md:22` | 文字提及，不是接线 |
| `tools/openapi-route-inventory.mjs` | 无 | 0 命中；只被 `openapi-route-parity.mjs:82` 内部当子进程调起 |
| `tools/verify-chat-live.mjs` | 无 | 0 命中（受控付费取证，头注框在人工范围） |
| `tools/verify-gy-i05-log-redaction.mjs` | 无 | 0 命中（负例对照探针，需人工对比 `before/after`） |
| `tools/verify-provider-live-r28.mjs` | 无 | 0 命中（头注明令不得进 CI） |

## 四、白名单 15 条：逐条一句话理由

`tests/unit/orphan-tools-wired-baseline.json`。`kind` 四档：`library`（库模块，接线由 host 承担）、
`in-process`（由 CI 会跑的测试在进程内驱动，没有独立退出码）、`by-design`（确实不该接）、
`gap`（**本该接，本片接不了**——本版为 0 条：三条走 B 类接上了，见 §六 变异 F）。

| # | 脚本 | kind | 一句话理由 |
| --- | --- | --- | --- |
| 1 | `tools/collect-g-drill.mjs` | library | 纯函数库（`runDrillPlan`/`readSha`/`readDirty`），无 CLI，接线由 host `verify-g-drill-readings` 负责 |
| 2 | `tools/contract-status-core.mjs` | library | 契约锚点核心库，host `verify-contract-status` 已在 `engineering-shell.yml:111` 被点名 |
| 3 | `tools/contract-status-runtime.mjs` | library | 运行期探针，由 `contract-status-core.mjs:68` 子进程调起，两层宿主最终落在已接线的 `verify-contract-status` |
| 4 | `tools/local-debug-config.mjs` | in-process | 配置读取器，被 `local-wechat.yml:57` 点名的 `tests/local-debug.test.mjs:9` 进程内驱动 |
| 5 | `tools/local-debug-server.mjs` | in-process | 回环调试服务，常驻无一次性退出码，同样由 `tests/local-debug.test.mjs` 驱动 |
| 6 | `tools/i22-failmatrix-evidence-table.mjs` | by-design | 证据页生成器，依赖未入库的 `tests/failmatrix/.artifacts/*.json`，只输出 Markdown、无判定面 |
| 7 | `tools/i22-failmatrix-negative-control.mjs` | by-design | 人工变异执行器（27 条负控制），`README` 写明人工执行，进 CI 会把「负控制按预期失败」误报成红 |
| 8 | `tools/local-env.mjs` | by-design | 本机开发栈编排（真 PG17 + 固定端口 + gitignored `.env`），CI 没有这套宿主，本机路径已由 `tests/unit/local-env.test.mjs` 覆盖 |
| 9 | `tools/openapi-route-inventory.mjs` | by-design | 一次性盘点脚本，只打印路由表 JSON，没有断言与退出码语义（判定在同目录 `openapi-route-parity`，已接线） |
| 10 | `tools/prepare-wechat.mjs` | by-design | 装配微信开发者工具工程，只有真微信工程树才有意义（会写 `project.config.json` 一类文件）；三个站点全是 `cpSync` 副本，按判据属「只夹具」 |
| 11 | `tools/verify-chat-live.mjs` | by-design | 受控付费取证：默认零外发（无 `--approved` 只预检 `exit 2`），需外发台账 + 单独授权 + 最多 2 次付费调用 |
| 12 | `tools/verify-provider-live-r28.mjs` | by-design | 文件头第 17-18 行明写「⛔ 本工具不得被任何 workflow 引用，也不得进任何 `test:*` 套件」 |
| 13 | `tools/verify-production-provisioning.mjs` | in-process | 真云控制台核对：脚本要生产只读凭据，但判定逻辑有退出码语义，已由 `tests/unit/production-provisioning.test.mjs` 注入假凭据进程内驱动 |
| 14 | `tools/verify-real-capability-config.mjs` | in-process | 读 `.gitignore:42` 忽略的 `config.local.json`，裸跑必红；但 `exitCodeFor(report)` 有退出码语义，已由 `tests/unit/real-capability-config.test.mjs:33` 进程内驱动 |
| 15 | `tools/verify-gy-i05-log-redaction.mjs` | by-design | 负例对照探针：要在「改前」的 `app.ts` 上跑并 `tee before.log` 人工对比，固化进 CI 等于把历史源码塞进流水线 |

15 条 = 47 − 32，与 §三 的四类表逐条对得上。**没有为了让它绿把本该接的塞进 by-design**：
第一版登记为 `gap` 的 4 条（`run-python`、`openapi-route-parity`、`verify-gy-i09-candidates`、
`verify-verification-comment-anchors`）全部退出了白名单——前三条由新增的 `tools-repo-run-smoke` 在真仓跑，
最后一条由 `#1137` 的守卫在真仓跑（见 §六 变异 F）。本版 `gap` 为 0，⑥ 仍保留台账与读数（防将来回填）。

## 五、判据代码怎么写的

`tests/unit/ci-orphan-tools-wired.test.mjs`（六条判据，测试名带 ①–⑥）：

1. **① 扫描面下界**：47 tools / 15 workflows / 164 `run:` 步 / 714 测试文件的下界（工具 44、workflow 14、
   run 140、测试 600），外加「一个 spawn 站点都没解析出来 ⇒ 红」。解析器坏掉时先红，避免「扫到 0 条所以全绿」。
2. **② 未接线必须登记**：`classify(tool)` 返回证据数组，空数组 = 未接线；未接线且不在白名单 ⇒ 红，逐条点名并给三条修法。
3. **③ 白名单不得过期**：已接线却还在白名单 ⇒ 红「已过期，删掉它」（与 `ci-orphan-tests-wired` 同口径：**过期判红**）。
4. **④ 白名单自身可核**：路径必须 ∈ 当前 47 个脚本；`kind` ∈ 四档；`reason` ≥ 12 字；`library` 的 `host`
   必须存在且**沿 host 链最终接到已接线脚本**（`contract-status-runtime → core → verify-contract-status` 走得通）；
   `in-process` 的 `exercisedBy` 必须是真测试文件且被某份 workflow（含 `npm run` 转接）跑到。
5. **⑤ 反向控制**：把合成文本喂给同一批判据函数，**14 条边**逐条断言——YAML 注释 `run` 不算、块标量里的 shell
   注释不算、`echo` 之后的路径不算、`node --check` 算、整词才算、`paths:` 不造 `run` 步、仅 import ⇒ 0 站点、
   夹具 cwd 不算、`--root` 改指夹具不算、真仓 spawn + `.status` 算、没有 `.status` 断言不算、`cwd = ROOT` 默认参数算、
   **同文件另一站没断言 ⇒ 仍不算**（P1-1）、**`cpSync` 副本 ⇒ 0 站点**（P1-B）、裸相对字面量有/无 `cwd` 两种结果。
6. **⑥ gap 台账 + 读数**：`kind: gap` 逐条 `t.diagnostic`（不判红），并打印「已接线 A1/A2/B + 白名单四档」读数供对账。

实现上几个必须**配平/求值**而不是正则截断的地方（每一处都踩过一次）：

- `cwd` 取值要读到**顶层的** `,` / `}`：`cwd: fileURLToPath(new URL('../../', import.meta.url))` 里的逗号
  会让 `[^,}\n]+` 提前截断，把真仓跑误判成夹具（`tests/integration/online-purge-pg.mjs:379` 就这么被误判过）；
- `{cwd, ...}` 简写要回看形参默认值：`tests/unit/release-gate.test.mjs:40` 的 `function gate(args, cwd = ROOT)`；
- **仓库根标识符要求值**：`resolve(dirname(fileURLToPath(import.meta.url)), …)` 只说明「相对本文件算了条路径」，
  必须按该测试文件的位置求值后**恰好等于仓库根**才登记（P1-3）；从 `tools/*.mjs` import 进来的 `REPO_ROOT`
  也走同一把尺子（读那个模块自己的根表达式求值）；
- **退出码断言按站点绑定**：`assertedStatusIdents` 收集被 `assert.*(....status)` 断言的标识符，再用
  `valueConsumers` 把 `const r = runTool(...)` / `const run = (a) => spawn(...)` 的 4 跳消费链接起来（P1-1）；
- **工具路径只认锚**：`toolPathsInWindow` 不再用宽松的 `/tools\/(x\.mjs)/` 去窗口里捞，只解析内联
  `join/resolve/new URL` 与别名——这正是夹具副本骗过第一版的入口（P1-B）。

## 六、变异自证：红/绿原文

每一行都是本机实跑（`node --test tests/unit/ci-orphan-tools-wired.test.mjs`），改完即恢复。

**变异 A（P1-1 反向控制）：把 `statusAssertForSite` 退回文件级判定**（`if (asserted.size > 0) return true;`）

```
✖ ⑤ 反向控制：合成文本喂同一批判据函数
  AssertionError [ERR_ASSERTION]: 同文件另一站没有断言 ⇒ 不能蹭前一个站点的 .status
ℹ pass 5 / ℹ fail 1
```

恢复后：`ℹ pass 6 / ℹ fail 0`。

**变异 B（P1-B 反向控制）：造 `tools/zzz-spawn-probe.mjs` + 假测试**（`cpSync` 到 tmpdir、spawn **副本**、`cwd: ROOT`、`assert.equal(result.status, 0)`）

```
✖ ② 未接线的 tools/*.mjs 必须在白名单里写明理由
  - tools/zzz-spawn-probe.mjs
ℹ pass 5 / ℹ fail 1
```

删掉两个临时文件后：`ℹ pass 6 / ℹ fail 0`（`git status --porcelain tools` 为空）。

**变异 C（P1-A 分类纠错）：删掉 `tools/prepare-wechat.mjs` 的白名单条目**

```
✖ ② 未接线的 tools/*.mjs 必须在白名单里写明理由
  - tools/prepare-wechat.mjs
ℹ pass 5 / ℹ fail 1
```

恢复后：`ℹ pass 6 / ℹ fail 0`。这条证明 v1 的「B 已接线」是错的：三个站点全是副本，删了条目就会红。

**变异 D：从白名单删掉 `tools/local-env.mjs`**

```
✖ ② 未接线的 tools/*.mjs 必须在白名单里写明理由
  - tools/local-env.mjs
ℹ pass 5 / ℹ fail 1
```

**变异 E：把已接线的 `tools/verify-contract-status.mjs` 塞进白名单**

```
✖ ③ 白名单不得过期：已接线的条目必须删掉
  AssertionError [ERR_ASSERTION]: 白名单里有条目已经被接线了（已过期，删掉它，否则白名单会越养越松）：
  +   'tools/verify-contract-status.mjs（.github/workflows/engineering-shell.yml:111（run: 点名））'
```

其余五条判据仍绿（`✔ ② ✔ ④ ✔ ⑤ ✔ ⑥`）。恢复后：`ℹ pass 6 / ℹ fail 0`。

**变异 F（gap 退场）：新增 `tests/unit/tools-repo-run-smoke.test.mjs`**

```
✔ tools/run-python.mjs：不带参数必须 exit 2 并打印用法（argv 契约） (87.0ms)
✔ tools/openapi-route-parity.mjs：真仓路由表与契约一致（退出码即判定） (1760.0ms)
✔ tools/verify-gy-i09-candidates.mjs：六类分支与用量守卫逐条通过 (189.1ms)
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
| ⑥ | 与 main 合并试算 | `git merge-tree --write-tree --name-only origin/main HEAD` | 0 | 单行树哈希 `1f12ab047a3a045e27cf87870570201bbe24b5b7`，无冲突路径行 |

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
