# GY 契约台账校验器进 CI：把「只在人工手里跑」的 `verify-contract-status` 接进 `contract` job

- 日期：2026-10-20
- 分片：契约台账校验器 CI 接线（派单 `.pg17/dispatch/r28-s19-contract-status-gate.md`）
- 分支：`test/gy-r28-contract-status-gate`，基线 `412297636141562653ecbaa6b3fbbfecb05ecdd4`（短 `4122976`，= `origin/main`，改前实测）
- 实现提交：`f8abc6a`（workflow 一行 ＋ 结构守卫测试）；本页单独提交（页内不自指哈希，`git rev-list --count 4122976..HEAD` 读数见交接报告）
- 环境：Windows（PowerShell 5.1.26100.8875）、Node v24.16.0、`npm ci --ignore-scripts`（103 packages，`node_modules` 为真实目录）
- 本页所有数字都有可复跑命令；标「未取得」的一律**没有验证过**。

## 0 结论（先看这四条）

1. **缺口是真的**：`tools/verify-contract-status.mjs` 在改前的 12 份 `.github/workflows/*.yml` 里 **0 命中**、在 `package.json` 的 `scripts` 里 **0 命中**（§1.1）——它只能靠人记得在本机跑。
2. **本片只做一件事**：在既有 `engineering-shell.yml` 的 `contract` job 里、`npm run test:contract` **之后**追加**唯一一步** `- run: node tools/verify-contract-status.mjs`（§2）。⛔ 没有扩校验能力、没有加 flag、没有动其它 job/step/文件。
3. **把这条接线变成会红的断言**：新增 `tests/unit/ci-contract-status-gate.test.mjs`（**5 个用例**：①该步存在且只一条 ②无 `--write-doc` ③无软失败构造 ④被调用路径真实存在且非空、校验器无 `--force`/`--skip` ⑤位置在 `test:contract` 之后）。四个负控制里，三个在磁盘上真的破坏过 workflow、每次复原后 sha256 逐字节核对一致（§4）。
4. **未取得（如实）**：本片**没有**在真 GitHub runner 上跑过，也没有增加「行号是否命中符号」的校验（§6，两条都写清原因）。

## 1 为什么开这一片（含文件行号）

### 1.1 校验器没有任何自动入口

改前的实测（基线 `4122976`）：

```
git grep -n "verify-contract-status" -- .            → 全仓 130 处 / 49 个文件
  其中 .github/workflows/                             → 0 处
  其中 package.json                                   → 0 处（scripts 段在 package.json:15，test:contract 在 :21）
  其中 tools/verify-contract-status.mjs               → 1 处（:209-215 的 PASS 文本）
  其中 tests/unit/contract-status-tool.test.mjs       → 8 处（414 行 / 18 个 test，只 spawnSync 工具本体跑夹具，对 .github/workflows 0 引用）
```

（上面「0 处」是**改前**读数；改后同一命令给 `.github/workflows/engineering-shell.yml => 1`，就是本片新增的那一行，见 §2。）

也就是说：`#325` 那种「台账里的行号早就漂了」的错误，**CI 上一路绿灯**，只能靠复审眼力发现。工具自身唯一的失败模式是退出码——`tools/verify-contract-status.mjs:15-18` 只认 `--runtime` / `--write-doc`，其余 flag 直接打印用法并 `exit 1`；校验不过时 `:200-207` 聚合后 `process.exit(1)`。**它在 CI 里跑起来就会红**，问题是没人跑。

### 1.2 #325 修的就是「行号漂移」，且漂移本身没有门禁

`git show f18763e --stat` 实测：2 个文件、`34 insertions(+) / 34 deletions(-)`、`docs/architecture/contract-implementation-status.md` 5 个 hunk（另一文件 `docs/architecture/contract-status.json` 32 行）。主体订正是这一类：

```
- 取消能力现有识别域与 OCR 域：… OCR 源（cancel 见 `services/api/src/jobs/sources.ts:169-186`）
+ 取消能力现有识别、转写、合成与 OCR 四域（下列行号为本基线 47fe028 实测）：…
+   OCR 源 `services/api/src/jobs/sources.ts:208`（域内实现 `services/api/src/ocr/service.ts:687` 的 cancelJob）
```

——`sources.ts` 的 OCR `cancel` 从 `:169-186` 漂到 `:208`，靠人读 diff 发现。这是「行号型证据」的固有脆性，本片**不试图**用脚本证明符号对得上（见 §6 第 1 条），只保证**机器每次 PR 都会问一遍**那些它能问的东西。

### 1.3 校验器能力边界（本片没有扩它）

`tools/contract-status-core.mjs`（184 行）导出的判据：

| 导出 | 行号 | 管什么 |
| --- | --- | --- |
| `scanMountedRoutes` | `:15` | 扫 `services/api/src` 的装配点 |
| `mountedMismatches` | `:56` | JSON 声明 vs 实际装配 |
| `runtimeMountedRoutes` | `:62` | `--runtime` 时的运行时装配 |
| `evidenceWithinRepository` | `:72` | 证据路径**在仓内且存在**（不判行号指向什么符号） |
| `routeDeclarations` | `:81` | 路由声明行 |
| `declarationSegments` | `:104` | 「注册块从声明行到下一声明前一行」 |
| `assertionArgumentRanges` | `:121` | `test()` 断言块区间 |
| `operationMentions` | `:153` | 操作名提及 |
| `replaceStatusTables` / `renderStatusTables` | `:166` / `:174` | 中文表格重渲染 |

即：语义检查是「区间是否落在注册块内／是否越界／是否整文件／是否跨块」，**不校**「`:208` 那一行是不是 `cancelJob`」。这条边界是本片刻意保留的（派单 §0「不许扩校验能力」）。

## 2 改了什么（3 个文件，一行生产代码）

### 2.1 `.github/workflows/engineering-shell.yml`：`contract` job 加一步

改后 `contract` job 在 `:79-93`，新增的一行是 `:93`：

```yaml
  contract:
    name: contract-tests
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          persist-credentials: false
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: '24.16.0'
          cache: npm
      - run: npm ci --no-audit --no-fund
      - run: npm run test:contract
      - run: node tools/verify-contract-status.mjs
```

相对基线的完整差异（`git diff 4122976 -- .github/workflows/engineering-shell.yml` 逐字读数）：

```
@@ -90,6 +90,7 @@ jobs:
           cache: npm
       - run: npm ci --no-audit --no-fund
       - run: npm run test:contract
+      - run: node tools/verify-contract-status.mjs
 
   evaluation:
```

**只加这一行**：没有 `--write-doc`（CI 不得自动改写台账）、没有 `--runtime`（需要真运行态，本 job 不提供）、没有 `if:` / `continue-on-error:` / 行尾 `|| true`（任何软失败都会让门禁失去意义）、不新增 job、不动其它 step、不动另外 11 份 workflow。改后文件 124 行 / 4050 字节 / LF / 无 BOM。

### 2.2 `tests/unit/ci-contract-status-gate.test.mjs`（新增，237 行）

仿 `tests/unit/ci-real-pg-wiring.test.mjs`、`tests/unit/ci-integration-chain-structure.test.mjs` 的形状：**只 `readFileSync` / `existsSync` / `statSync`**，无 `yaml` 依赖、不联网、不 spawn 子进程（所以在任何 runner 上都跑得起来）。

| 用例 | 行号 | 断言什么 | 失败时给什么 |
| --- | --- | --- | --- |
| ① | `:135` | `contract` job 里 `node tools/verify-contract-status.mjs` **恰好 1 处** | 列出「该 job 现有命令」逐行定位，并给可粘贴的补法 |
| ② | `:156` | 该命令不含 `--write-doc` | 说明它会让 CI 自动重写台账、把漂移就地抹平 |
| ③ | `:172` | 该 step 不含 `if:` / `continue-on-error:` / 行尾 `\|\| true` | 逐处列出行号与原文 |
| ④ | `:196` | 从 workflow 文本里正则取出的路径**真实存在、是文件、非空**；校验器文本里不含 `--force` / `--skip` | 指出「钉了不存在的路径」并给回退写法 |
| ⑤ | `:225` | 该 step 排在 `npm run test:contract` **之后** | 给出两步行号与「挪到之后」的改法 |

解析口径：`jobBlockOf()` 按「两空格 job 键」切块、`stepsOf()` 按最小缩进 `- name|uses|run:` 切 step、`runCommandsOf()` 只读 `run:`（含 `|` 块标量）不读 `name:` / `uses:`。⚠️ 这是**结构守卫**，不是 YAML 解析器：workflow 若改成别的缩进口径（例如 job 键 4 空格），①会以「解析出 0 个 step」失败并提示同步改 `JOB_ID`，⛔ 不许删守卫了事。

### 2.3 本页

`docs/verification/gy-r28-contract-status-gate-20261020.md`（唯一新增文档）。不写索引登记：`docs/verification/` 目前没有索引清单要求（135 个 `.md`）。

### 2.4 明确没动的（红线自检）

`git diff --stat 4122976..HEAD` 只应出现上面 3 个文件。特别地：`tools/verify-contract-status.mjs` 一个字符没改（sha256 `278c0067…9b5dd` 前后一致，§4 NC4 的 `TOOL_EQ=True` 是同一哈希）、`docs/architecture/contract-status.json` 与 `docs/architecture/*.md` 台账未动、`package.json` 未加 script、services/apps/packages/迁移/其它 workflow 未动。

## 3 改前必红（把「没有这一步」这件事变成红）

**证明方式**：把 `:93` 那一行删掉，得到的文件与基线 `4122976` 版本**逐字节相同**——不是「看起来像」，是 sha256 相等：

```
git cat-file blob 4122976:.github/workflows/engineering-shell.yml  → 3999 bytes, sha256 51fe5c1f625d9c6b18750ca30bf335c0f82f3f975d08c27cc27be65137b8ef5b
删掉 :93 一行后的工作树文件                                        → 3999 bytes, sha256 51fe5c1f625d9c6b18750ca30bf335c0f82f3f975d08c27cc27be65137b8ef5b
```

在这个「基线状态」下跑结构守卫：

```
node --test --test-isolation=none tests/unit/ci-contract-status-gate.test.mjs
→ ℹ tests 5 / ℹ pass 0 / ℹ fail 5     exit 1
```

①的红原文（节选，含「该 job 现有命令」逐行定位，第 93 行确实不在了）：

```
✖ ① contract job 里有 `node tools/verify-contract-status.mjs` 这一步
  AssertionError [ERR_ASSERTION]: `.github/workflows/engineering-shell.yml` 的 `contract` job 里没有 `node tools/verify-contract-status.mjs` 这一步：
  契约台账校验器（docs/architecture/contract-status.json ↔ 中文对照表）因此不会在 CI 上跑，
  台账漂移可以静默进主干。
  改法：在同 job 的 `- run: npm run test:contract` 之后追加一行：
        - run: node tools/verify-contract-status.mjs
  ⛔ 不要加 `--write-doc`、`--runtime`、`if:`、`continue-on-error` 或行尾 `|| true`。
  该 job 现有命令：
  第 84 行：(无 run)
  第 87 行：(无 run)
  第 91 行：npm ci --no-audit --no-fund
  第 92 行：npm run test:contract
```

还原后：`4050 bytes, sha256 782706236584dd9265cc1de9e43f714fb33ac1df62553260ce980d566c2861b4`，`git status --porcelain` 0 行，守卫回到 5/5 绿。

## 4 负控制（NC1–NC4：先在磁盘上改坏，再证明它红）

四轮都在同一个真实工作树里改文件（不是内存变异），每轮 `finally` 复原并核对 sha256；复原后 `git status --porcelain` 均为 **0 行**。原始备份：`E:\GengYunCommander\.pg17\nc-r28-s19\`（`engineering-shell.yml.orig`、`verify-contract-status.mjs.orig` 及各轮输出日志）。

| 控制 | 改动 | 变异后 sha256 | 读数 | 红的是哪几条 |
| --- | --- | --- | --- | --- |
| NC1 | 删掉 `:93` 整行 | workflow `51fe5c1f…8ef5b`（= 基线 4122976 原文） | exit 1，5 tests / pass 0 / fail 5 | ①②③④⑤ 全红 |
| NC2 | 该行尾部加 `--write-doc` | workflow `c6dfda05…57fe4` | exit 1，pass 2 / fail 3 | ①⑤ ＋ **②** |
| NC3 | 该行尾部加 `\|\| true` | workflow `2fdbf75d…97218` | exit 1，pass 2 / fail 3 | ①⑤ ＋ **③** |
| NC4 | 路径改成 `…mjs.bak`，并把 `tools/verify-contract-status.mjs` 真改名成 `.mjs.bak` | workflow `bccf0c92…71a854` | exit 1，pass 3 / fail 2 | ①⑤（④ 见下方说明） |
| NC4b | 只把路径改成 `…mjs.bak`（**不改名**） | workflow `bccf0c92…71a854` | exit 1，pass 2 / fail 3 | ①⑤ ＋ **④** |

**NC2 的②红原文**：

```
✖ ② contract job 里那一步不带 `--write-doc`（CI 不得自动改写台账）
  AssertionError [ERR_ASSERTION]: 第 93 行的契约校验步带了 `--write-doc`：`node tools/verify-contract-status.mjs --write-doc`
  CI 里带它会让校验器按 JSON 自动重写 docs/architecture/contract-implementation-status.md，
  把「表格漂移」就地抹平 ⇒ 门禁失去对台账的约束力（且 PR 会被 CI 自动改脏）。
  改法：删掉 `--write-doc`，同步只在人工本地核对后执行。
```

**NC3 的③红原文**：

```
✖ ③ contract job 里那一步不带 `if:` / `continue-on-error` / `|| true`（不得软失败）
  AssertionError [ERR_ASSERTION]: 契约校验步被改成了软失败（1 处）：
    · 第 93 行的命令有行尾 `|| true`：node tools/verify-contract-status.mjs || true
  以上任一构造都会让「校验失败」仍被判绿——门禁等于没有。
  改法：那一步只留 `- run: node tools/verify-contract-status.mjs`，不加 `if:` / `continue-on-error:` / 行尾 `|| true`。
```

**NC4 的④红原文**（NC4b，路径指向不存在的文件）：

```
✖ ④ 被调用路径真实存在且非空；校验器不含 `--force` / `--skip` 这类无条件通过开关
  AssertionError [ERR_ASSERTION]: workflow 里调用的是 `tools/verify-contract-status.mjs.bak`，但仓库里没有这个文件（仓库根解析为 E:\GengYunCommander\wt-r28-s19）。
  这正是「钉了一个不存在的路径」：workflow 看起来有检查，实际 CI 会因找不到脚本而红/或指向别处。
  改法：把那一步写回 `node tools/verify-contract-status.mjs`（⛔ 不改名、不指向 .bak / 临时脚本）。
```

⚠️ **NC4 原始形态为什么 ④ 是绿的（不掩饰）**：按派单 §4 的写法，路径改成 `.mjs.bak` 的**同时**把真文件改名成 `verify-contract-status.mjs.bak`——于是 `tools/verify-contract-status.mjs.bak` 在磁盘上**确实存在**、非空、是文件，④ 的「存在性」判据如实通过；红的是 ①（命令文本必须逐字等于 `node tools/verify-contract-status.mjs`）与 ⑤（找不到那一行）。为了让「路径指错必红」有独立证据，另跑 NC4b（只改路径、不改名）：④ 立即红，原文如上。两条合起来覆盖了「路径错」与「命令错」两种破坏。

**复原读数**（各轮 `finally` 实测）：

```
NC1 workflow 782706236584dd9265cc1de9e43f714fb33ac1df62553260ce980d566c2861b4 (= 改前)  EQ=True
NC2 workflow 782706236584dd9265cc1de9e43f714fb33ac1df62553260ce980d566c2861b4 (= 改前)  EQ=True
NC3 workflow 782706236584dd9265cc1de9e43f714fb33ac1df62553260ce980d566c2861b4 (= 改前)  EQ=True
NC4 workflow 782706236584dd9265cc1de9e43f714fb33ac1df62553260ce980d566c2861b4 (= 改前)  EQ=True
    tool     278c00679856f798eb724c47ed29f6d447f69f15ee6ae69b59b0028b9489b5dd (= 改前)  EQ=True
    tools/verify-contract-status.mjs.bak 残留：False
NC4b workflow 782706236584dd9265cc1de9e43f714fb33ac1df62553260ce980d566c2861b4 (= 改前) EQ=True
```

## 5 门禁读数（本片实测）

| # | 命令 | 读数 | 退出码 |
| --- | --- | --- | --- |
| 1 | `node --test --test-isolation=none tests/unit/ci-contract-status-gate.test.mjs` | 5 tests / 5 pass / 0 fail | 0 |
| 2 | `npm run lint` | `PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、`PASS 仓库卫生扫描`、`lint 通过` | 0 |
| 3 | `npm run test:contract` | 6 tests / 6 pass / 0 fail | 0 |
| 4 | `npm run test:docs` | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables`；研究记录 5 通过 / 0 失败 / 4 legacy 已钉住 | 0 |
| 5 | `node tools/verify-contract-status.mjs` | 见下四行 | 0 |
| 6 | `node --test --test-concurrency=1 "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs" "tests/media/*.test.mjs" "tests/reference/*.test.mjs"` | `tests 2641 / pass 2640 / fail 0 / skipped 1`，`duration_ms 284608.85` | 0 |

第 5 条的逐字输出（四行 PASS，本机复跑，不是转抄）：

```
PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
PASS: 语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段（不可核不计入通过）
PASS: 中文表格一致
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。
```

第 6 条的如实标注：

- **必须**带 `--test-concurrency=1`：本机并行跑会 OOM 假红，读数不可信。
- `skipped 1` = `tests/unit/knowledge-api.test.mjs:102` 的 `{ skip: !f.native }`（`native = process.env.GY_KNOWLEDGE_TEST_OWNER_URL`，本机未设）。
- 本机存在 1 条**负载敏感假红**（`tests/unit/miniprogram-transcript-confirm.test.mjs` 的 `releaseGet is not a function`）。本轮全量**没有复现**，`fail 0` 是这一轮的真实读数，但不据此宣称该缺陷已修。
- 全量日志留在 `E:\GengYunCommander\.pg17\tmp-r28-s19-unit.log`（3033 行）。

## 6 没做到（如实）

1. **没有增加「行号是否命中符号」的校验**。派单 §0 明确禁止扩校验能力；且本片只改一行 CI 接线，若顺手加判据，等于把「接线片」偷偷变成「校验器改造片」。`services/api/src/jobs/sources.ts:208` 到底是不是 OCR 的 `cancel`，仍只能靠人读——本片只保证**校验器每次 PR 都会跑**，不保证它比昨天更聪明。
2. **没有在真 GitHub runner 上跑过**。本机只能证明「结构守卫读到的工作流文本里有这一行且路径存在」；checkout 之后的真实行为（runner 上 `npm ci` 是否成功、工具在干净环境下是否仍 4 行 PASS）**未取得**。第一份证据要等本分支的 CI run。
3. **没有证明「删掉该步 ⇒ GitHub 上那个 job 变红」**。本片证明的是「删掉 ⇒ 仓库内的结构守卫测试红」（NC1，5/5 红）；即使有人在本地删掉这一行而忘了改守卫，守卫会在 PR 的 `contract` job 第一步之前就红——但仍属本机/测试层证据，不是远端 run 证据。
4. **没有修 #325 那一类行号漂移本身**，也没有扫全仓还有多少处过期行号。那属于台账维护，不在本片范围。
5. **只覆盖 `contract` job 这一处**。若以后有人把这一步挪到别的 job（例如新建 `contract-status` job），守卫会因为「`contract` job 里没有这一步」而红——这是**有意的**：挪位置必须同步改守卫与 `JOB_ID`，不能静默漂到无守卫的地方。
