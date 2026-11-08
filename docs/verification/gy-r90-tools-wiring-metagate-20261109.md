# R90 `tools/**` 接线元闸门：给每个守卫脚本点名「谁来跑它」（2026-11-09）

本页记录 `tests/unit/ci-orphan-tools-wired.test.mjs` 与 `tests/unit/orphan-tools-wired-baseline.json` 的判据、
当前 47 个顶层 `tools/*.mjs` 的四类归属、白名单逐条理由、变异自证与六道闸门读数。基线 `a30c8adb`（`origin/main`），
本片只新增 `tests/**` 两个文件与本页，**不动 `.github/**`、不动 `tools/**`**。

## 一、为什么要这道闸：三件事可以同时为真

`tools/verify-verification-comment-anchors.mjs` 的空档是一个**已发生**的事故，不是假想：

1. 它自己的守卫 `tests/unit/verify-verification-comment-anchors.test.mjs` 全绿——但那份守卫的文件头写着
   「全部用临时目录夹具 + 直接调 `main()`，⛔ 不 spawn 子进程、不写仓库内文件」，它**只在夹具上跑导出函数**；
2. 同一份工具在**真仓**上跑是 `EXIT 1`（基线外新增 9 条），这个结果没人看得到，因为没有一条流水线跑它；
3. 15 份 workflow 里没有任何 `run:` 点名它 ⇒ **CI 全绿**。

于是「单测绿 + 真仓红 + CI 绿」三件事同时成立，而且能一直成立下去。既有元闸门
`tests/unit/ci-orphan-tests-wired.test.mjs` 已经把 `tests/**` 的接线面钉死了，但它**只看 `tests/**`**：
`tools/**` 是它扫不到的空档。本片就是把这块空档本身变成被测对象——不判断这些脚本的判据对不对，只判断
**有没有人跑它**。

## 二、判据：A / A2 / B，以及四种「看起来像接线其实不算」

| 类 | 定义 | 本片怎么判 |
| --- | --- | --- |
| **A1** | 某份 `.github/workflows/*.yml` 的 `run:` 文本里**整词点名**该路径 | 按空白 / 引号 / `;\|&()` 切词，整词相等或含 `*` 的 glob 命中才算；YAML 注释行与块标量里的 shell 注释行不算 |
| **A2** | 该工具由 `package.json` 的某个 script 点名，而那个 script 被某份 workflow 以 `npm run <script>` 调起 | 两段都要成立：script 文本点名 + `run:` 里真有人 `npm run` 它 |
| **B** | 某个 `tests/**/*.mjs` **在仓库根 spawn 它**，且**断言退出码** | spawn 家族（`spawnSync`/`execFileSync`/`execSync`/`execFile`/`spawn`）+ 参数点名该工具（字面量或别名）+ `cwd` 指向仓库根 + 同文件有 `assert.*(….status)` + 没被 `--root/--dir/--project/--workspace` 改指夹具 |

**四种不算**（这正是 `verify-verification-comment-anchors` 踩过的坑）：

1. **仅 import**：`import { main } from '../../tools/x.mjs'; main();`——模块级单测，导入成功就能绿，工具真仓跑红它也绿；
2. **只夹具**：在 `mkdtempSync()` 出来的临时树 / `cpSync` 的工程树副本上 spawn，判定的是夹具不是真仓；
3. **没有退出码断言**：spawn 了真仓工具但只看 stdout 文本，工具 `EXIT 1` 时测试照样绿；
4. **只在文档/注释里出现**：`README` 与 `package.json` 写了用法，等于没人跑。

> 反例就在仓里：`tests/unit/verify-verification-comment-anchors.test.mjs:29` import 三个导出函数、
> `:67` 起临时目录，全仓 `tests/**` 里**没有任何一处**在真仓 spawn 它——按上面的口径，它一条 B 证据都没有。

## 三、47 个 `tools/*.mjs` 的四类现状（逐条到 `文件:行`）

扫描面：47 个顶层 `tools/*.mjs`、15 份 workflow、164 条 `run:` 步、713 个 `tests/**/*.mjs`。
汇总：**已接线 29**（A1 15 + A2 3 + B 11）、**只 import 10**、**只夹具 1**、**完全无引用 7**。

### 3.1 已接线（29）

| 脚本 | 接线面 | 证据（文件:行） | 强度 |
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
| `tools/verify-contract-status.mjs` | A1 | `.github/workflows/engineering-shell.yml:111` | 真跑 |
| `tools/verify-doc-anchors.mjs` | A1 | `.github/workflows/engineering-shell.yml:112` | 真跑（四连 strict） |
| `tools/verify-reading-pages.mjs` | A1 | `.github/workflows/engineering-shell.yml:113` | 真跑 |
| `tools/verify-research-records.mjs` | A1 | `.github/workflows/development-docs.yml:45` | 真跑 |
| `tools/verify-migrations-unique.mjs` | A1 | `.github/workflows/migrations-guard.yml:83` | 真跑 |
| `tools/lint-workspaces.mjs` | A2 | `.github/workflows/engineering-shell.yml:43` → `package.json` `scripts.lint` | 真跑 |
| `tools/verify-admin-capability-map.mjs` | A2 | `.github/workflows/engineering-shell.yml:114` → `scripts.verify:capability-map` | 真跑 |
| `tools/verify-purge-schedule.mjs` | A2 | `.github/workflows/engineering-shell.yml:173` → `scripts.verify:purge-schedule` | 真跑 |
| `tools/import-consent-policy.mjs` | B | `tests/unit/consent-policy-import.test.mjs:883` | 真仓 spawn + `.status`（缺真 PG 会 skip） |
| `tools/prepare-wechat.mjs` | B | `tests/local-debug.test.mjs:105` | 真仓 spawn + `.status` |
| `tools/purge-expired-backup-copies.mjs` | B | `tests/integration/backup-copies-purge-pg.mjs:572` | 真仓 spawn + `.status`（真库臂） |
| `tools/purge-expired-media.mjs` | B | `tests/unit/media-purge-driver.test.mjs:344` | 真仓 spawn + `.status` |
| `tools/purge-expired-online-data.mjs` | B | `tests/integration/online-purge-pg.mjs:379` | 真仓 spawn + `.status` |
| `tools/purge-retention-expired.mjs` | B | `tests/integration/retention-purge-pg.mjs:216` | 真仓 spawn + `.status` |
| `tools/release-gate.mjs` | B | `tests/unit/release-gate.test.mjs:40` | 真仓 spawn + `.status` |
| `tools/verify-chain-e2e-r29.mjs` | B | `tests/unit/chain-e2e-tool.test.mjs:111` | 真仓 spawn + `.status` |
| `tools/verify-g-drill-readings.mjs` | B | `tests/unit/g-drill-readings.test.mjs:1018` | 真仓 spawn + `.status`（另两臂带 `--root` 夹具，不计） |
| `tools/verify-release-materials.mjs` | B | `tests/unit/release-materials-index.test.mjs:52` | 真仓 spawn + `.status`（镜像臂是夹具，不计） |
| `tools/verify-sample-gap.mjs` | B | `tests/evaluation/gy-i20-sample-gap-recompute.test.mjs:96` | 真仓 spawn + `.status` |

7 个只有 `node --check` 的脚本：**语法级点名也算接线，但不假装它够**（见 §八）。

### 3.2 只 import（10）：导出函数被进程内调用，真仓从未 spawn

| 脚本 | 引用点（文件:行） | 说明 |
| --- | --- | --- |
| `tools/collect-g-drill.mjs` | `tools/verify-g-drill-readings.mjs:55`、`tests/unit/g-drill-readings.test.mjs:72` | 纯函数库，宿主已接线 |
| `tools/contract-status-core.mjs` | `tests/unit/contract-status-tool.test.mjs:422`（动态 import） | 核心库，宿主 `verify-contract-status` 已接线 |
| `tools/contract-status-runtime.mjs` | `tools/contract-status-core.mjs:68`（宿主内部 `execFileSync`） | 二层宿主，`tests/**` 无引用 |
| `tools/local-debug-config.mjs` | `tests/local-debug.test.mjs:9` | 配置读取器，被 `local-wechat.yml:57` 的测试进程内驱动 |
| `tools/local-debug-server.mjs` | `tests/local-debug.test.mjs:9` | 回环 HTTP 服务，同上 |
| `tools/local-env.mjs` | `tests/unit/local-env.test.mjs:809` | 本机栈编排 |
| `tools/openapi-route-parity.mjs` | `tests/contract/openapi-route-parity.test.mjs:17` | 判定逻辑在进程内跑，CLI 入口无人点名 |
| `tools/verify-production-provisioning.mjs` | `tests/unit/production-provisioning.test.mjs:15` | 只 import（真云凭据） |
| `tools/verify-real-capability-config.mjs` | `tests/unit/real-capability-config.test.mjs:33` | 只 import（gitignored 本地配置） |
| `tools/verify-verification-comment-anchors.mjs` | `tests/unit/verify-verification-comment-anchors.test.mjs:29` + `:67` | **本片反例**：导出函数 + 临时夹具，真仓从未跑 |

### 3.3 只夹具（1）：spawn 了，但点在临时树上

| 脚本 | 引用点（文件:行） | 说明 |
| --- | --- | --- |
| `tools/i22-failmatrix-evidence-table.mjs` | `tests/unit/i22-failmatrix-evidence-table-guard.test.mjs:44`（建夹具树）、`:142`（跑夹具副本） | 真仓那份从未被跑；它还需要 `.artifacts/matrix.json` |

### 3.4 完全无引用（7）：`tests/**`、15 份 workflow、`package.json` 里都没有判定面

| 脚本 | 唯一「提及」 | 说明 |
| --- | --- | --- |
| `tools/i22-failmatrix-negative-control.mjs` | `tests/failmatrix/mutations.mjs:5`（注释）、`tests/failmatrix/README.md:22` | 文字提及，不是接线 |
| `tools/openapi-route-inventory.mjs` | 无 | 0 命中 |
| `tools/run-python.mjs` | `package.json` `scripts.test:docs` | 而 `test:docs` 本身没有 workflow 点名 |
| `tools/verify-chat-live.mjs` | 无 | 0 命中 |
| `tools/verify-gy-i05-log-redaction.mjs` | 无 | 0 命中 |
| `tools/verify-gy-i09-candidates.mjs` | 无 | 0 命中（头注却写「供人工与 CI 复核」） |
| `tools/verify-provider-live-r28.mjs` | 无 | 0 命中（头注明令不得进 CI） |

## 四、白名单 18 条：逐条一句话理由

`tests/unit/orphan-tools-wired-baseline.json`。`kind` 四档：`library`（库模块，接线由 host 承担）、
`in-process`（由 CI 会跑的测试在进程内驱动，没有独立退出码）、`by-design`（确实不该接）、
`gap`（**本该接，本片接不了**：要改 `.github/**`，A 档不动）。

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
| 9 | `tools/openapi-route-inventory.mjs` | by-design | 一次性盘点脚本，只打印路由表 JSON，没有断言与退出码语义 |
| 10 | `tools/verify-chat-live.mjs` | by-design | 受控付费取证：默认零外发（无 `--approved` 只预检 `exit 2`），需外发台账 + 单独授权 + 最多 2 次付费调用 |
| 11 | `tools/verify-provider-live-r28.mjs` | by-design | 文件头第 17-18 行明写「⛔ 本工具不得被任何 workflow 引用，也不得进任何 `test:*` 套件」 |
| 12 | `tools/verify-production-provisioning.mjs` | by-design | 真云控制台核对，需生产只读凭据；仓库规矩是凭据只在内存、未审代码不接触生产 |
| 13 | `tools/verify-real-capability-config.mjs` | by-design | 读 `.gitignore:42` 明确忽略的 `docs/verification/config.local.json`，CI 里没有这份文件 |
| 14 | `tools/verify-gy-i05-log-redaction.mjs` | by-design | 负例对照探针：要在「改前」的 `app.ts` 上跑并 `tee before.log` 人工对比，固化进 CI 等于把历史源码塞进流水线 |
| 15 | `tools/run-python.mjs` | **gap** | 本该接：`test:docs` 的第一环，而 `test:docs` 在 15 份 workflow 里 0 命中 |
| 16 | `tools/openapi-route-parity.mjs` | **gap** | 本该接：`verify:parity` 就是跑它，但没有任何 workflow 调用该 script |
| 17 | `tools/verify-gy-i09-candidates.mjs` | **gap** | 本该接：头注自称「供人工与 CI 复核」，纯本地合成数据、`exit 0/1` 就是判定，却 0 命中 |
| 18 | `tools/verify-verification-comment-anchors.mjs` | **gap** | 本该接：本片的事故本体，守卫只用夹具调导出函数，真仓从未跑过 |

18 条 = 47 − 29，与 §三 的四类表逐条对得上。**没有为了让它绿把本该接的塞进 by-design**：
4 条 `gap` 就是「本该接但接不了」的显式台账，测试⑥会把它们逐条打印出来，而不是当豁免。

## 五、判据代码怎么写的

`tests/unit/ci-orphan-tools-wired.test.mjs`（六条判据，测试名带 ①–⑥）：

1. **① 扫描面下界**：47 tools / 15 workflows / 164 `run:` 步 / 713 测试文件的下界（工具 44、workflow 14、
   run 140、测试 600）。解析器坏掉时先红，避免「扫到 0 条所以全绿」。
2. **② 未接线必须登记**：`classify(tool)` 返回证据数组，空数组 = 未接线；未接线且不在白名单 ⇒ 红，逐条点名并给三条修法。
3. **③ 白名单不得过期**：已接线却还在白名单 ⇒ 红「已过期，删掉它」（与 `ci-orphan-tests-wired` 同口径：**过期判红**，不是只报）。
4. **④ 白名单自身可核**：路径必须 ∈ 当前 47 个脚本；`kind` ∈ 四档；`reason` ≥ 12 字；`library` 的 `host`
   必须存在且**沿 host 链最终接到已接线脚本**（`contract-status-runtime → core → verify-contract-status` 这种两层链走得通）；
   `in-process` 的 `exercisedBy` 必须是真测试文件且**被某份 workflow 连同 `npm run` 转接一起跑到**。
5. **⑤ 反向控制**：把合成文本喂给同一批判据函数，11 条边逐条断言——YAML 注释 `run` 不算、块标量里的 shell 注释不算、
   `node --check` 算、整词才算（`verify-demo-extra` 不算 `verify-demo`）、`paths:` 不造 `run` 步、仅 import ⇒ 0 个站点、
   夹具 spawn 不算、`--root` 改指夹具不算、真仓 spawn + `.status` 算、没有 `.status` 断言不算、`cwd = ROOT` 默认参数算。
6. **⑥ gap 台账**：把 `kind: gap` 的条目逐条 `t.diagnostic` 打印 + 计数（**不判红**，因为 A 档改不了 workflow）。

实现上几个必须配平而不是正则截断的地方（都踩过）：

- `cwd` 取值要读到**顶层的** `,` / `}`：`cwd: fileURLToPath(new URL('../../', import.meta.url))` 里的逗号
  会让 `[^,}\n]+` 提前截断，把真仓跑误判成夹具（`tests/integration/online-purge-pg.mjs:379` 就是这么被误判的）；
- `{cwd, ...}` 简写要回看形参默认值：`tests/unit/release-gate.test.mjs:40` 的 `function gate(args, cwd = ROOT)`
  传的是仓库根，按夹具对待会把 `release-gate` 误判成未接线；
- 仓库根标识符不只有 `resolve(dirname(fileURLToPath(import.meta.url)))`：`tests/evaluation/gy-i20-sample-gap-recompute.test.mjs:15`
  的 `REPO_ROOT` 是**从工具 import 来的**，得单独认；
- 工具别名除了 `join(ROOT, 'tools', 'x.mjs')`，还有 `const TOOL = 'tools/x.mjs'` 这种裸字面量
  （`tests/unit/release-materials-index.test.mjs:28`）。

## 六、变异自证：红/绿原文

**变异 A：从白名单里删掉 `tools/local-env.mjs`（其余不动）**

```
AssertionError [ERR_ASSERTION]: 以下 1 个 tools 脚本既没被 workflow 的 run: 点名，也没有在真仓上跑它并断言退出码的测试，
且不在白名单里（只 import / 只夹具 / 无 .status 断言都不算接线）：
  - tools/local-env.mjs
```

恢复后：`ℹ tests 6 / ℹ pass 6 / ℹ fail 0`。

**变异 B：把已接线脚本 `tools/verify-contract-status.mjs` 塞进白名单**

```
✖ ③ 白名单不得过期：已接线的条目必须删掉
AssertionError [ERR_ASSERTION]: 白名单里有条目已经被接线了（已过期，删掉它，否则白名单会越养越松）：
+   'tools/verify-contract-status.mjs（.github/workflows/engineering-shell.yml:111（run: 点名））'
```

恢复后：`ℹ pass 6 / ℹ fail 0`。两次变异都只动 `tests/unit/orphan-tools-wired-baseline.json`，恢复后
`git status --porcelain` 只剩两个新增文件。

## 七、六道闸门（本片实跑，EXIT 0）

| # | 闸门 | 命令 | EXIT |
| --- | --- | --- | --- |
| ① | 四连 strict anchors | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | 0 |
| ② | 锚点搬迁身份单测 | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | 0 |
| ③ | 契约状态 | `node tools/verify-contract-status.mjs` | 0 |
| ④ | 文档闸门 | `npm run test:docs` | 0 |
| ⑤ | 钻孔读数 | `node tools/verify-g-drill-readings.mjs --check` | 0 |
| ⑥ | 与 main 合并试算 | `git merge-tree --write-tree --name-only origin/main HEAD` | 0 |

尾行摘录：

- ① `PASS: --strict 下没有基线之外的新增…`；`SYMBOL-COVERAGE-VERIFICATION-GATE: 本次：不在区间 44、UNDECLARED 253、配成对 1287`
- ② `ℹ tests 37 / ℹ pass 36 / ℹ fail 0 / ℹ skipped 1`（**提交前**跑会红：该用例在 `base == HEAD` 时明确拒绝静默通过，落提交后转绿）
- ③ `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。`
- ④ `PASS: 识别 5 页 / 跳过 366 页（扫描面 371 页：docs/verification）——读数七条判据全部自洽`
- ⑤ `✓ 八条判据全过：workflows 15 / jobs 30 / 演练 21 条 / 测试文件 609（glob 合计 579）`
- ⑥ 只输出一个含并的树哈希（`9f5600939cc787ed7011c890c6366ef3893d15b3`），无冲突路径行

## 八、不声称

- **不声称这些脚本的判据本身正确**：本闸门只问「有没有人跑」，不问「跑出来的判定对不对」。
  `release-gate` 的 secrets/artifacts 判据、`verify-sample-gap` 的读数口径，本片一个字没验。
- **不声称替代真正的 CI 接线**：4 条 `gap` 就是证据——它们本该进 workflow，本片（A 档）改不了 `.github/**`，
  只能登记 + 打印。要让缺口归零，得另开 B 档 PR 往 `engineering-shell.yml` 加 `run:`。
- **不声称 B 判定覆盖所有 spawn 写法**：只认「`cwd` 明确是仓库根 + 有 `.status` 断言」；没有 `cwd` 的 spawn
  一律不算（静态无法证明它跑的是真仓）。这是**宁可低估**的方向：漏判会让白名单偏松，误判会让真接线看起来没接。
- **不声称 `node --check` 够**：7 个脚本只有语法级点名（§3.1 标了「仅语法级」），语法通过不等于门禁判定跑过。
- **不声称 by-design 的判断有外部背书**：14 条 `by-design` 的理由来自各工具的文件头自述、`.gitignore`、
  以及 `access-verification.yml:43` 的 `git check-ignore` 证据；它是本片的判断，不是工具作者的授权。
- **不声称白名单可以长期不动**：`③` 只挡「已过期」，挡不住「理由变得不成立」；理由失真需要人工复审。
