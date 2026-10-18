# docs/research 机械结构看守：校验器调研与自研决策（2026-10-18）

范围：`tools/verify-research-records.mjs` 需要判定「一条 `docs/research/` 记录是否满足 README §2／§3／§4／§6／§7」。本记录说明为何**不引入 Markdown 解析器**、改为零依赖自研，判据为何按「项」而不是按「记录总数」算来源，以及 legacy 白名单的内容哈希为何必须是 LF 归一化口径。

## 检索

- 检索日期：2026-10-18（本机 `Get-Date` 实测 `2026-10-18 09:31:02+08:00`，UTC+08:00）。
- 检索方式：直接抓取官方页，未使用检索词。
- 来源版本或提交：本机 `node --version` ⇒ `v24.16.0`、`npm --version` ⇒ `11.13.0`；官方文档站页脚实测 `v24.22.0 Latest LTS`、`v26.12.0 Latest Release`；本记录引用的代码基线提交 `3b776a8b7bf8fecd9b271f880c549aa5df4f2704`。

## 1 Node.js 内置测试运行器（node:test）

- 现用版本（证据命令）：`node --version` ⇒ `v24.16.0`；`npm --version` ⇒ `11.13.0`；`node:test` 自 `v20.0.0` 起 `Stability: 2 - Stable`，本仓 `tests/unit` 已在用同一形态。
- 上游维护状态：Node.js v26 处于 Current（2026-05-05 起，最近更新 2026-10-14）；v24 Krypton 处于 LTS（2026-05-06 起，最近更新 2026-10-14）；v22 Jod 处于 LTS（2026-09-23 起）。按官方「Production applications should only use Active LTS or Maintenance LTS releases」，v24 合规；本机 `v24.16.0` 落后 `v24.22.0` 若干补丁版，但本脚本只用 v20 起稳定的 API，不受影响。
- 可复用部分：全部用内置模块——`node:test` 组织用例、`node:assert/strict` 断言、`node:child_process.spawnSync` 起被测脚本、`node:crypto.createHash('sha256')`、`node:fs`／`node:path`／`node:url` 读目录与定位仓库根；无第三方包。复用面计数命令：`git grep -c "^function " -- tools/verify-research-records.mjs` ⇒ `tools/verify-research-records.mjs:22`（22 个函数），配套测试同命令 ⇒ `tests/unit/research-records-gate.test.mjs:8`。
- 许可证与署名：Node.js 本体 MIT，本项目只**调用**其内置模块、不复制其源码，不新增署名义务；不引入第三方包 ⇒ 不新增许可证义务。
- 兼容性：`import.meta.url`、`node:test`、`node:assert`、`node:crypto`、`node:fs`、`node:child_process` 均为 Node 20+ 现有 API；本仓 `package.json` 的 `engines.node` 是 `>=24.16.0 <25`，CI 与脚本统一 Node 24 ＋ ESM，无编译期步骤。
- 引入成本：0 个新依赖、0 字节安装体积（未安装任何包，故安装时长无增量）；单次运行耗时未实测。
- 决定：**不引入 Markdown 解析器**，自研零依赖 ESM 校验脚本 `tools/verify-research-records.mjs`（配 `tests/unit/research-records-gate.test.mjs`，挂到 `npm run test:docs` 第二段，CI 同步接线）。理由：
  1. 判据只落在「结构」上：切表格行、逐字比对字段名、抽 http(s) URL、算内容哈希。README 的表头／分隔行／`（…）` 括注都是可控子集，正则＋字符串感知切分足够；上 AST 反而要处理更多 Markdown 方言，失败信息也难以精确到行号与字段名。
  2. 零依赖是本仓 `tools/*.mjs` 的既有形态（`lint-workspaces.mjs`／`verify-layout.mjs` 均如此），根 `package.json` 没有 `dependencies`（只有 `@types/node`、`typescript` 两个 devDependency）。`test:docs` 目前只依赖 python 与 node 两个运行时；引第三方包会把一条文档门禁绑到 `npm ci` 的安装结果与升级节奏上。
  3. 来源必须**按项**计：README §4 的「每项 ≥2 条」指的是每一段技术，不是全篇总数。只数全篇会放过「A 项独占四条、B/C/D 零条」这种凑数（v1 的漏洞，本版按技术段与来源表的「技术」列逐行核，去重按 `host+path` 归一，`#锚点` 与尾斜杠不算不同页面）。
  4. 只认正文：围栏代码块（``` / ~~~）与 `<!-- -->` 注释里的字段、来源、版本一律不算数——否则把七项塞进注释就能免责，判据等于没写。版本判据收紧到 `x.y.z`／40 位 SHA／`commit|sha|tag` 后的 7–40 位十六进制，裸的 `1048576` 这类读数不再冒充版本。
  5. legacy 哈希口径必须自己说了算。本仓库 `core.autocrlf=true` 且没有 `.gitattributes`：工作区检出是 CRLF、CI（ubuntu）检出是 LF。按原始字节算，**同一个提交**在两平台会得到两个 sha256，门禁就成了平台囚徒。脚本内先做 LF 归一化（丢掉 CR、保留 LF）再哈希；白名单只收基线既有的 `gy-i03-*`，其它文件名（例如 `my-notes.md`）一律报错退出。

### 检索来源

- `https://nodejs.org/api/test.html` —— 本轮读数：`Source Code: lib/test.js`、`Added in: v18.0.0, v16.17.0`、历史条目 `v20.0.0 The test runner is now stable.`、`Stability: 2 - Stable`、`If any tests fail, the process exit code is set to 1.`；`node --test` 默认收集 `**/*.test.{cjs,mjs,js}` 等 6 组 glob；`--test-name-pattern` 按正则过滤用例名。
- `https://nodejs.org/en/about/previous-releases` —— 本轮读数：`v26 - May 05, 2026 / Oct 14, 2026 / Current`、`v24 Krypton May 06, 2025 / Oct 14, 2026 / LTS`、`v22 Jod Apr 24, 2024 / Sep 23, 2026 / LTS`；页脚 `v24.22.0 Latest LTS`、`v26.12.0 Latest Release`；LTS 档位说明「typically guarantees that critical bugs will be fixed for a total of 30 months」。

## 复核读数

- `node tools/verify-research-records.mjs`（仓根）⇒ exit 0，`研究记录校验：3 通过 / 0 失败 / 4 legacy 已钉住`；逐行 `PASS 2026-10-18-contract-evidence-gate.md`、`PASS 2026-10-18-research-records-gate.md`、`PASS 2026-10-18-stack-reuse-decision.md`，4 个 `gy-i03-*` 的 `PASS …（legacy 已钉住）`。
- 同一命令在补齐 `legacy-allowlist.json` 之前是 `2 通过 / 4 失败`、exit 1——白名单缺位会被拦下，不是摆设。
- `node --test tests/unit/research-records-gate.test.mjs` ⇒ 34 例全过（含「照抄 README §7 范例 ⇒ exit 0」与「仓库真实 docs/research ⇒ exit 0」两例）。
- 函数计数命令 `git grep -c "^function " -- tools/verify-research-records.mjs` ⇒ `tools/verify-research-records.mjs:22`（22 个函数）；同命令对 `tests/unit/research-records-gate.test.mjs` ⇒ 8（8 个夹具与运行助手）。

## 未取得

- 未在 ubuntu（LF 检出）实跑本脚本：本机只有 Windows CRLF 检出。跨平台一致性由「LF 归一化」口径保证，并由 `git show` blob 字节与工作区字节的双路复算佐证，**不是**第二平台实测。
- 未安装 markdownlint／remark 一类解析器，故未实测其安装体积、安装时长与本仓语法的适配度。「不引入」的结论基于判据形态与零依赖约束，不是打包实测。
- 未做变异测试／完整负控制矩阵：`tests/unit/research-records-gate.test.mjs` 只逐条覆盖判据的触发路径（按项来源、围栏与注释、版本启发式、七项形状、白名单收口、legacy 哈希），不是全排列枚举。
- 未覆盖 `docs/research` 的子目录（脚本只看顶层）与正文语义（例如「决定」是否真被正文论证）——只管机械结构。
- 未评估中文主题名的记录：当前正则只允许小写 ASCII 字母／数字／连字符，README 未规定主题字符集，本脚本按现有两例的体裁收窄，如需放宽要单独裁定。
