# docs/research 机械结构看守：校验器调研与自研决策（2026-10-18）

范围：`tools/verify-research-records.mjs` 需要判定「一条 `docs/research/` 记录是否满足 README §2／§3／§4」。本记录说明为何**不引入 Markdown 解析器**、改为零依赖自研，以及 legacy 白名单的内容哈希为何必须是 LF 归一化口径。

## 检索

- 检索日期：2026-10-18（本机 `Get-Date` 实测 `2026-10-18 09:31:02+08:00`，UTC+08:00）。
- 检索方式：直接抓取官方页，未使用检索词。
- 来源版本或提交：本机运行 `node v24.16.0`、`npm 11.13.0`（`node --version`／`npm --version` 实测）；官方文档站展示最新发布版本——最新发布 `v26.12.0`、v24 分支最新 LTS `v24.22.0`（releases 页页脚实测），本机 `v24.16.0` 落后 `v24.22.0` 若干补丁版。

## 来源（均已实际打开）

- `https://nodejs.org/api/test.html` —— 本轮读数：`Source Code: lib/test.js`、`Added in: v18.0.0, v16.17.0`、历史条目 `v20.0.0 The test runner is now stable.`、`Stability: 2 - Stable`、`If any tests fail, the process exit code is set to 1.`；`node --test` 默认收集 `**/*.test.{cjs,mjs,js}` 等 6 组 glob；`--test-name-pattern` 按正则过滤用例名。
- `https://nodejs.org/en/about/previous-releases` —— 本轮读数：`v26 - May 05, 2026 / Oct 14, 2026 / Current`、`v24 Krypton May 06, 2025 / Oct 14, 2026 / LTS`、`v22 Jod Apr 24, 2024 / Sep 23, 2026 / LTS`；页脚 `v24.22.0 Latest LTS`、`v26.12.0 Latest Release`；LTS 档位说明「typically guarantees that critical bugs will be fixed for a total of 30 months」。

- 现用版本（证据命令）：`node --version` ⇒ `v24.16.0`；`npm --version` ⇒ `11.13.0`；`node:test` 自 `v20.0.0` 起 `Stability: 2 - Stable`，本仓 `tests/unit` 已在用同一形态。
- 上游维护状态：Node.js v26 处于 Current（2026-05-05 起，最近更新 2026-10-14）；v24 Krypton 处于 LTS（2026-05-06 起，最近更新 2026-10-14）；v22 Jod 处于 LTS（Sep 23, 2026）。按官方「Production applications should only use Active LTS or Maintenance LTS releases」，v24 合规；本机 `v24.16.0` 落后 `v24.22.0` 若干补丁版，但本脚本只用 v20 起稳定的 API，不受影响。
- 可复用部分：全部用内置模块——`node:test` 组织用例、`node:assert/strict` 断言、`node:child_process.spawnSync` 起被测脚本、`node:crypto.createHash('sha256')`、`node:fs`／`node:path`／`node:url` 读目录与定位仓库根；无第三方包。
- 许可证与署名：Node.js 本体 MIT，本项目只**调用**其内置模块、不复制其源码，不新增署名义务；不引入第三方包 ⇒ 不新增许可证义务。
- 兼容性：`import.meta.url`、`node:test`、`node:assert`、`node:crypto`、`node:fs`、`node:child_process` 均为 Node 20+ 现有 API；本仓 `package.json` 的 `engines.node` 是 `>=24.16.0 <25`，CI 与脚本统一 Node 24 ＋ ESM，无编译期步骤。
- 引入成本：0 个新依赖、0 字节安装体积（未安装任何包，故安装时长无增量）；单次运行耗时未实测。

## 决定

**不引入 Markdown 解析器，自研零依赖 ESM 校验脚本 `tools/verify-research-records.mjs`（配 `tests/unit/research-records-gate.test.mjs`，挂到 `npm run test:docs` 第二段）。** 理由：

1. 判据只落在「结构」上：切表格行、逐字比对字段名、抽 http(s) URL、算内容哈希。README 的表头／分隔行／`（…）` 括注都是可控子集，正则＋字符串感知切分足够；上 AST 反而要处理更多 Markdown 方言，失败信息也难以精确到行号与字段名。
2. 零依赖是本仓 `tools/*.mjs` 的既有形态（`lint-workspaces.mjs`／`verify-layout.mjs` 均如此），根 `package.json` 没有 `dependencies`（只有 `@types/node`、`typescript` 两个 devDependency）。`test:docs` 目前只依赖 python 与 node 两个运行时；引第三方包会把一条文档门禁绑到 `npm ci` 的安装结果与升级节奏上。
3. legacy 哈希口径必须自己说了算。本仓库 `core.autocrlf=true` 且没有 `.gitattributes`：工作区检出是 CRLF、CI（ubuntu）检出是 LF。按原始字节算，**同一个提交**在两平台会得到两个 sha256，门禁就成了平台囚徒。脚本内先做 LF 归一化（丢掉 CR、保留 LF）再哈希；本机双路复算一致——`git show HEAD:docs/research/<name>` 的 blob 字节与工作区字节归一化后同值，4 个 `gy-i03-*` 文件全部 `agree=true`。
4. 宁可少判也不误判：README §3 允许写「未取得」、§7 允许内部工具片只写最短记录。脚本对「未取得」不作失败、对没有技术字段表的记录不做七项断言——否则会把**合规的**记录打红，门禁就变成逼人凑字段。
5. 「空目录」必须报错（exit 2）：路径写错却让整条门禁静默通过，是最坏的一种假绿；同理目录里缺 `README.md` 也报错，而不是当作「没有记录所以通过」。

实测读数（基线 `3b776a8b7bf8fecd9b271f880c549aa5df4f2704`）：`node tools/verify-research-records.mjs` ⇒ exit 0，`研究记录校验：2 通过 / 0 失败 / 4 legacy 已钉住`；逐行 `PASS 2026-10-18-contract-evidence-gate.md`、`PASS 2026-10-18-stack-reuse-decision.md`，4 个 `gy-i03-*` 文件的 `PASS …（legacy 已钉住）`。同一命令在补齐 `legacy-allowlist.json` 之前是 `2 通过 / 4 失败`、exit 1——白名单缺位会被拦下，不是摆设。

## 未取得

- 未在 ubuntu（LF 检出）实跑本脚本：本机只有 Windows CRLF 检出。跨平台一致性由「LF 归一化」口径保证，并由 `git show` blob 字节与工作区字节的双路复算佐证，**不是**第二平台实测。
- 未安装 markdownlint／remark 一类解析器，故未实测其安装体积、安装时长与本仓语法的适配度。「不引入」的结论基于判据形态与零依赖约束，不是打包实测。
- 未做变异测试／负控制矩阵；`tests/unit/research-records-gate.test.mjs` 只逐条覆盖判据的触发路径（合格记录、缺字段、单来源、重复来源、日期不一致、技术表缺项、legacy 改一字节、空目录、`未取得` 放行）。
- 未覆盖 `docs/research` 的子目录（脚本只看顶层）与正文语义（例如「决定」是否真被正文论证）——只管机械结构。
- 未评估中文主题名的记录：当前正则只允许小写 ASCII 字母／数字／连字符，README 未规定主题字符集，本脚本按现有两例的体裁收窄，如需放宽要单独裁定。
