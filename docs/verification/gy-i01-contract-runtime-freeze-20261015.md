# GY-I01 正式契约与运行版本冻结记录（2026-10-15）

任务：GY-I01 / GitHub issue **#1**（**`Refs #1`，不关闭整项**）。
本片只做**记录**：**只新增本文档 1 份**，**未改** `packages/contracts/**`（冻结件）、`services/**`、`package.json` 版本约束、CI workflow、`README`。
**本文档是记录，不是 #1 的验收结论**；#1 的关闭由监工按验收项判定（理由与引用见 §9）。

| 项 | 值 |
| --- | --- |
| 独立 worktree | `E:\GengYunCommander\.pg17\wt-i01-freeze`（自建；**未改指挥仓库** `GengYun_Agent2` 的工作区，未切其分支） |
| 分支 | `docs/gy-i01-freeze-record` |
| 基线 `upstream/main` | `24fac034276c26b0e870e8ea8ea7f4349a8f8a89`（短 `24fac03`；`git fetch upstream --prune` 后读取） |
| 同点 `origin/main` | `24fac03`（与基线同一提交，故 `origin/main...HEAD` 的三点差集可信） |
| 取证机 | `Microsoft Windows 11 家庭版 中文版`（NT `10.0.26200.0`），取证 shell 为 **Windows PowerShell 5.1.26100.8875**；本机 Node `v24.16.0`、npm `11.13.0`、Python `3.14.3` |
| **未 push** | 是（写手不持有 GitHub 凭据；推送与建 PR 由指挥执行） |
| **未取得 CI 读数** | 是（本分支无 CI 运行记录；本文**不把 CI 配置当成已验证**） |

原始日志（UTF-8）另存**仓库外** `E:\GengYunCommander\.pg17\tmp-i01-freeze\`：`test-docs.txt`、`test-docs-after.txt`、`test-docs-final.txt`、`test-contract.txt`、`test-contract-final.txt`、`validate-contracts.txt`、`test-contracts-py.txt`、`verify-status.txt`、`verify-status-runtime.txt`、`verify-status-runtime-final.txt`、`hashes.txt`、`npm-ls.txt`、`versions.txt`、`ui-adaptive-baseline.txt`、`gate-diff.txt`、`selfcheck-a.txt`、`selfcheck-b.txt`。
本轮返修（r2）日志另存**仓库外** `E:\GengYunCommander\.pg17\tmp-i01-freeze\fix-r2\`：`crosscheck-lf.sh`／`crosscheck-lf.txt`（跨平台复核命令原样实跑＋GNU `sha256sum` 独立复核）、`from-doc-cmd.txt`（从本文件 §2.2(b) 提取的命令原文）＋`run-from-doc.cmd`／`run-from-doc.sh`／`run-from-doc-ps51.ps1`（三种 shell 的 runner）、`gate-x-cmd.txt`／`gate-x-bash.txt`／`gate-x-ps51.txt` 及最终 HEAD 复跑副本 `gate-x-cmd-final.txt`／`gate-x-bash-final.txt`／`gate-x-ps51-final.txt`（三 shell 原始输出）、`gate-negative-control-r2.txt`（负控制）、`gate-r2-final.txt`（返修门禁）、`check-eol.sh`／`check-eol.txt`（行尾检查）、`from-dispatch-verbatim.txt`／`repro-dispatch-verbatim.cmd`／`.txt`／`check-verbatim.sh`／`.txt`（派单第 25 行命令**漏印一对数组括号**的逐字节复现：原样执行抛 `TypeError … Received type string ('blob')`）、`diag-quoting.sh`／`diag-msys.sh`／`repro-min.sh`（shell 引号差异定位）。
本记录在基线 `24fac03` 之上**只新增这一份文档**（`git diff --name-only upstream/main...HEAD` 实测见 §6.1）；该提交的短 SHA 以回传 handoff 为准。

**修订记录（r2，2026-10-15；返修单 `.pg17/dispatch/issue1-freeze-fix.md`，2026-10-15）**：增量复审判「需修改」⇒ 本版只改本文档、修正三处：**B1（阻塞）** §2 改以 **LF 归一化 sha256** 为跨平台判据并写入跨平台复核命令（原 CRLF 工作区值保留，降级为"仅登记、不作判据"）；**C1** §4.2 微信基础库引用真身由 `local-wechat.yml:6` 更正为 `.github/workflows/engineering-shell.yml:6`；**C2** §1.1#17／§4.2 的 CI Node pin 与 `npm ci` 计数按实测更正。**本记录仍是记录，不构成 #1 的验收结论**（§9）。

## 1 侦察结论：已存在、可直接复用 vs 缺失、需本次补

派单要求先侦察、避免重复劳动。侦察一律读 `upstream/main = 24fac03`（在写手 worktree 内工作区即该提交，`git status --porcelain` 为空）。

### 1.1 已存在、可直接复用（逐项给 file:line）

| # | 已有成果 | 位置（file:line） | 一句话说明 |
| --- | --- | --- | --- |
| 1 | 正式契约三件 + 示例 + 运行基线 | `packages/contracts/openapi.json`（LF 445,338 B／本机 CRLF 462,211 B）、`operations.json`（18,049／18,839 B）、`states.json`（2,730／2,887 B）、`examples.json`（201,929／208,172 B）、`runtime-baseline.json`（2,329／2,359 B） | 契约 `1.0.0`、提案修订 `2`；三件即本记录要冻结指纹的对象。字节数**前为 git blob（LF 仓库字节，跨平台）**，**后为本机 CRLF 工作区大小（机器相关，仅登记）**——两者差异见 §2.2 |
| 2 | 契约目录自带状态声明 | `packages/contracts/README.md:3` | 原文「GY-I01 / #1，**待监工冻结**；没有已运行API」⇒ 现状是**待冻结**，不是已冻结 |
| 3 | 契约版本变更规则（同 PR 更新消费者） | `packages/contracts/README.md:14` | 「版本变化须同PR更新消费者、枚举、索引、行为说明与示例」 |
| 4 | 冻结提案与变更分级口径 | `docs/architecture/adr-001-initial-architecture.md:3`、`:68` | `:3` 状态「提交监工审查，**尚未冻结生效**」；`:68` minor／patch／major 与 `/api/v2`、同 PR 更新消费者 |
| 5 | 冻结生效条件的政策条文 | `docs/architecture/acceptance-map.md:40`、`:55` | `:40`「契约经监工确认后下游才按已冻结版本验收」；`:55`「监工独立验证后决定是否冻结」 |
| 6 | #1 的权威验收条文（改契约须同步文档与依赖） | `docs/initial-issues.json:37` | GY-I01 `acceptance[2]` 原文；台账 `status` 为 `待审PR` |
| 7 | 契约实现状态对照（人工判定 + 机器副本） | `docs/architecture/contract-implementation-status.md`、`docs/architecture/contract-status.json:6` | `:6` 明写该 JSON「**不是冻结契约事实源**」，只记实现进度 |
| 8 | 可复核校验工具（独立命令，未接 CI） | `tools/verify-contract-status.mjs`；接入状态见 `docs/architecture/contract-implementation-status.md` 第 6 节「可回归校验」 | 第 6 节原文「脚本是独立命令，**未追加 CI 工作流或修改 package.json**」 |
| 9 | 契约一致性门禁 | `package.json:21`（`test:contract`）、`.github/workflows/engineering-shell.yml:57-69`、`.github/workflows/development-docs.yml:38-39` | CI 跑 `npm run test:contract` 与 `python3 tools/validate_contracts.py`／`test_contracts.py`（离线、无外部调用） |
| 10 | **契约文件不可改**的机器断言 | `tests/ui-adaptive.test.mjs:303-324`（判据在 `:320`） | `assert.ok(!changed.some((f) => f.startsWith('packages/contracts/')), '不得修改冻结契约')`；与 `docs/ui-contract-binding.md:24` 的人工口径一致 |
| 11 | 既有契约验证记录 | `docs/architecture/validation.md`、`docs/verification/gy-i01-contract-status-20261011.md`、`docs/verification/gy-i01-contract-status-refresh-20261013.md`、`docs/verification/gy-i01-status-sync-20261013.md` | 分别记：契约本身检查与限制；可复现启动 + 本机门禁；对照刷新（逐项比较 112 条操作元数据未改）；新 main 同步 |
| 12 | 运行版本来源（Node／npm） | `package.json:7-10`、`services/api/package.json:9-11`、`apps/admin/package.json:8-10` | 三处 `engines`：`"node": ">=24.16.0 <25"`，根另有 `"npm": ">=11.13.0"` |
| 13 | 依赖精确版本与锁文件策略 | `services/api/package.json:21-22`、`apps/admin/package.json:18-23`、`package.json:28-31`、`package-lock.json` | 依赖写**精确版本**（无 `^`）；`package-lock.json` **已提交**（`git ls-files` 命中），`lockfileVersion = 3`、156 条 `packages` |
| 14 | 运行候选基线（含未验证声明） | `packages/contracts/runtime-baseline.json` | `status = candidate_pending_GY-I02_GY-I25`；`verification.*` 多项仍 `pending` |
| 15 | 微信基础库目标 | `project.config.json:7`、`miniprogram/project.config.json:27` | 两处 `"libVersion": "3.17.3"`（同一口径） |
| 16 | 既有运行版本**实测**证据（历史） | `docs/verification/gy-i02-clean-repro-20261014.md` §1、§4.10 | 记：Node `v24.16.0`／npm `11.13.0`／Python `3.14.3`；模拟器 `SDKVersion=3.17.3`（**devtools，不是真机**） |
| 17 | CI 中锁定的 Node 版本 | **13 处 / 9 个 workflow**（共 10 个 workflow 文件，实测见 §4.2）：`.github/workflows/engineering-shell.yml:38,52,66,80,94`、`.github/workflows/local-wechat.yml:53`、`.github/workflows/access-verification.yml:19`、`.github/workflows/auth-privacy-postgres.yml:31`、`.github/workflows/catalog-postgres.yml:31`、`.github/workflows/consent-grant-postgres.yml:31`、`.github/workflows/source-lifecycle-postgres.yml:31`、`.github/workflows/staging-intake-postgres.yml:31`、`.github/workflows/workbook-staging.yml:39` | 13 处均为 `node-version: '24.16.0'`；`git grep -c "node-version: '24.16.0'" -- .github/workflows/` 逐文件合计即 13（**原文写"六处"，漏记 7 处，本次按实测更正**） |

### 1.2 缺失、需本次补（本次按"只加 1 份文档"补齐；**不改代码**）

| # | 缺失项 | 侦察依据（file:line 或命令） | 本片处理 |
| --- | --- | --- | --- |
| 1 | 三个契约文件的**登记在案指纹**（sha256／git blob） | ① 本机 **CRLF 工作区 sha256** 与 **git blob**：`git grep -e e677d805df1b925f -e 3804c64b3cdda57e …` ⇒ 除本文档自身外 **0 命中**；② **LF 归一化 sha256**（§2.2(b)）：全仓 **5/5 已登记**——`docs/verification/assets/i07-wechat-main8932ba5-pr80b5a6468/merged-source-equivalence.json:1818-1842`，逐条 `"rule": "UTF-8 CRLF to LF"` | 本次补入 §2（实测命令 + 原始输出）。②说明**本记录的跨平台判据与仓库既有约定同源**（同一算法、同一行尾口径），非本片新发明 |
| 2 | 「**本地实测**」与「**CI 声称**」**分述**的运行版本记录 | 本次检索范围内 `docs/verification/**` 无此类记录；`docs/architecture/validation.md:23` 只记「Node24.16.0/npm11.13.0 实际运行版本已读」，未与 CI 声称分列（范围外已有：`deploy/cloudrun/README.md:16-17` 的 Node `24.16.0`／npm `11.13.0` 实测 + 来源表） | 本次补入 §5（分列 5.1／5.2／5.3） |
| 3 | 版本真源文件 `.nvmrc`／`.node-version`／`.tool-versions` | `git ls-files` 匹配 `nvmrc\|node-version` ⇒ **0 命中** | 本片**不新增**（新增版本文件属工程变更，超出"记录"范围）；如实登记为缺口 |
| 4 | `engines` 的机器强制 | `git grep engines` 仅命中 3 个 `package.json`，无工具／测试消费；无 `.npmrc`（`git ls-files` 0 命中）、无 `engine-strict` | 本片**不改代码**；登记为"仅声明，无门禁" |
| 5 | `runtime-baseline.json` 的陈旧声明 | `packages/contracts/runtime-baseline.json`：`verification.clean_install = "pending"` | 与本次实测（§3.3 `npm ci` exit 0）不一致；该文件属**冻结件**，本片**不修改**，只登记待监工裁定（见 §9） |
| 6 | 冻结是否**已生效**的批复 | `packages/contracts/README.md:3` 仍为「待监工冻结」；`docs/architecture/adr-001-initial-architecture.md:3` 仍为「尚未冻结生效」 | 本片**不能**补，也不冒充；登记为"未取得"（§7） |

**未触发派单 §3 的停手条件**：存在可冻结的正式契约（`packages/contracts/{openapi,operations,states}.json`）；且本记录**不需要改任何代码**即可成立（版本实测为只读命令）。

## 2 契约冻结：三文件实测指纹

### 2.1 命令（原样照录）

```powershell
foreach ($f in @(
  'packages/contracts/openapi.json',
  'packages/contracts/operations.json',
  'packages/contracts/states.json',
  'packages/contracts/examples.json',
  'packages/contracts/runtime-baseline.json')) {
  "{0}  sha256={1}  blob={2}" -f $f,
    (Get-FileHash -Algorithm SHA256 $f).Hash.ToLower(),
    (git hash-object $f)
}
```

- `Get-FileHash -Algorithm SHA256` 对**文件原始字节**做 SHA-256；在本机该原始字节即 **CRLF 工作区字节**（根因：机器级 `core.autocrlf=true`（`D:/Git/etc/gitconfig`）+ 本仓**无**仓库级 `.gitattributes`；`git ls-files --eol packages/contracts/` = `i/lf  w/crlf  attr/`）⇒ **该值随检出时的行尾转换而变，机器相关，不是冻结判据**。其算法等价于 GNU `sha256sum`，但**只在与本机同为 CRLF 工作区时可比对**；本仓 15 处 `runs-on` 全为 `ubuntu-24.04`（`git grep runs-on -- .github/workflows/` 实测，共 10 个 workflow），CI／Linux 检出的是 LF 字节，按该值复核**必然不等**——故 §2.2(a) 的 `sha256` 列**只登记、不作判据**。
- **冻结判据 = §2.2 的 `blob` 列（`git rev-parse HEAD:<path>`，与行尾转换无关）＋ §2.2(b) 的 LF 归一化 sha256**；二者跨平台一致。此口径与仓库既有约定同源，非本片新发明：`docs/verification/gy-i20-real-samples-20261014.md:55`「该文件级摘要**随检出时的行尾转换而变**；**冻结判定不依赖它**——冻结用的是规范化 `indexSha256`」；`docs/verification/gy-i26-demo-align-20261014.md:23`「本仓 `core.autocrlf=true`…**sha256 差异仅由行尾造成**；比对时按 **LF 归一化**」。
- `git hash-object` 给 **git blob** 哈希（`sha1("blob <len>\0" + 内容)`），与 `git rev-parse HEAD:<path>` 一致（§2.3 已核对）。

### 2.2 原始输出（2026-10-15，worktree HEAD `24fac03`，工作区无改动）

#### 2.2(a) 本机 CRLF 工作区字节（**机器相关，仅登记，不作判据**）

§2.1 命令原样输出（`sha256` 列＝本机 CRLF 工作区字节；`blob` 列＝git 对象，跨平台）：

```
packages/contracts/openapi.json  sha256=e677d805df1b925f0c36d53441ae80e8dc2e0e12261ee9be574b1b57a247d9d8  blob=3804c64b3cdda57ef1f87d5a569c74d712ffefa6
packages/contracts/operations.json  sha256=a1d9eea897bcc4c269bd6256e82db2cb4672d286668ddf4b7872669586a051b7  blob=06b82fc7094821e7aab4ee6e994ad81daecdfedf
packages/contracts/states.json  sha256=18802f45fc819481f16da98963101f39de255e77fa470afa4ccc0b233753857e  blob=e78510c0a65b4d186ae870cd4902bf910d0fc55c
packages/contracts/examples.json  sha256=014bbb1d3e840b871df8e95cae2207e274798a302d03d7664dabd5e47870df89  blob=b8bb9a5f601edd1364898755e76fcb7926990a93
packages/contracts/runtime-baseline.json  sha256=9869bd5feb3343bebe0be6f279a3c3f5791277a19c12838dfb368a4eaa5122bc  blob=10ddf580544ae847698ac83abeddde4a4f4fcfea
```

#### 2.2(b) LF 归一化 sha256（**跨平台判据**）

对 **git blob 内容**直接取 sha256：git 对象存储不做行尾转换（`i/lf`），blob 内容即 LF 字节 ⇒ 任何平台检出同一提交都得到同一结果（blob 与提交对象的绑定见 §2.3）。

跨平台复核命令（仅用 Node 内置 `crypto` + `git`，无第三方依赖）：

```
$ node -e "const{execFileSync}=require('child_process'),c=require('crypto');for(const f of ['openapi','operations','states','examples','runtime-baseline']){const p='packages/contracts/'+f+'.json';const h=execFileSync('git',['rev-parse','HEAD:'+p],{encoding:'utf8'}).trim();const b=execFileSync('git',['cat-file','blob',h]);console.log(p,'blob='+h,'lfSha256='+c.createHash('sha256').update(b).digest('hex'),'bytes='+b.length)}"
packages/contracts/openapi.json blob=3804c64b3cdda57ef1f87d5a569c74d712ffefa6 lfSha256=8a7714983711e4b349f44c84c20bb138ea822b8ae0dd7bc0d983f0989fba89d0 bytes=445338
packages/contracts/operations.json blob=06b82fc7094821e7aab4ee6e994ad81daecdfedf lfSha256=d5b29a1877ed22c91f69919def6d2348d736087403af954500298d74f5a13a8a bytes=18049
packages/contracts/states.json blob=e78510c0a65b4d186ae870cd4902bf910d0fc55c lfSha256=5b4ff78cc9da79acfe03b454ca9fc609c13aeee0bb09c6efa92f71a917d2b3b1 bytes=2730
packages/contracts/examples.json blob=b8bb9a5f601edd1364898755e76fcb7926990a93 lfSha256=871786b56030f9e7d6beaa3e4e9310cb64bf553b55bc38d9ee0a05d5d5f902e8 bytes=201929
packages/contracts/runtime-baseline.json blob=10ddf580544ae847698ac83abeddde4a4f4fcfea lfSha256=b95c77e9855130067925996d6ae0b25872832d2b0152e6823d00ef5e7a204eda bytes=2329
# EXITCODE: 0
```

- **Windows PowerShell 5.1** 会把传给原生程序的**内层引号全部剥掉**（实测 `SyntaxError: Invalid or unexpected token`），故该 shell 下须写成 `node --% -e "…"`（`--%` 之后的文本原样传递）；**PowerShell 7 与 bash 可原样执行**。此三条实跑输出逐字符相同（原始输出见 §6.2）。
- **复制来源提醒**：若从返修单（仓库外 `.pg17/dispatch/issue1-freeze-fix.md` 第 25 行）转抄本命令，注意该处**漏印了一对数组括号**（作 `execFileSync('git','cat-file','blob',h)`，应为 `execFileSync('git',['cat-file','blob',h])`）⇒ 原样执行抛 `TypeError [ERR_INVALID_ARG_TYPE]: … Received type string ('blob')`。**请以本 §2.2(b) 上方的命令为准**（逐字节复现存档见 §1 的 r2 日志清单）。
- 等价 POSIX 写法（GNU coreutils；`sha256sum` 直接消费 `git cat-file blob` 的字节）：

```
$ for f in openapi operations states examples runtime-baseline; do p="packages/contracts/$f.json"; h=$(git rev-parse "HEAD:$p"); printf '%s blob=%s lfSha256=%s bytes(lf)=%s\n' "$p" "$h" "$(git cat-file blob "$h" | sha256sum | cut -d' ' -f1)" "$(git cat-file -s "$h")"; done
```

- **`indexSha256` 同源佐证**：上列五个 LF 值**已登记在仓内既有记录** `docs/verification/assets/i07-wechat-main8932ba5-pr80b5a6468/merged-source-equivalence.json:1818-1842`（每条 `"rule": "UTF-8 CRLF to LF"`），**5/5 与本表相同** ⇒ 本判据与仓库既有行尾口径一致（§1.2 第 1 项）。

汇总表（五份文件）：

| 文件 | blob sha1（跨平台） | **LF 归一化 sha256（跨平台判据）** | LF 字节 | 本机 CRLF 工作区 sha256（机器相关，仅登记） | CRLF 字节 |
| --- | --- | --- | --- | --- | --- |
| `packages/contracts/openapi.json` | `3804c64b3cdda57ef1f87d5a569c74d712ffefa6` | `8a7714983711e4b349f44c84c20bb138ea822b8ae0dd7bc0d983f0989fba89d0` | 445,338 | `e677d805df1b925f0c36d53441ae80e8dc2e0e12261ee9be574b1b57a247d9d8` | 462,211 |
| `packages/contracts/operations.json` | `06b82fc7094821e7aab4ee6e994ad81daecdfedf` | `d5b29a1877ed22c91f69919def6d2348d736087403af954500298d74f5a13a8a` | 18,049 | `a1d9eea897bcc4c269bd6256e82db2cb4672d286668ddf4b7872669586a051b7` | 18,839 |
| `packages/contracts/states.json` | `e78510c0a65b4d186ae870cd4902bf910d0fc55c` | `5b4ff78cc9da79acfe03b454ca9fc609c13aeee0bb09c6efa92f71a917d2b3b1` | 2,730 | `18802f45fc819481f16da98963101f39de255e77fa470afa4ccc0b233753857e` | 2,887 |
| `packages/contracts/examples.json` | `b8bb9a5f601edd1364898755e76fcb7926990a93` | `871786b56030f9e7d6beaa3e4e9310cb64bf553b55bc38d9ee0a05d5d5f902e8` | 201,929 | `014bbb1d3e840b871df8e95cae2207e274798a302d03d7664dabd5e47870df89` | 208,172 |
| `packages/contracts/runtime-baseline.json` | `10ddf580544ae847698ac83abeddde4a4f4fcfea` | `b95c77e9855130067925996d6ae0b25872832d2b0152e6823d00ef5e7a204eda` | 2,329 | `9869bd5feb3343bebe0be6f279a3c3f5791277a19c12838dfb368a4eaa5122bc` | 2,359 |

**冻结与改错判定请用中间两列（blob／LF 归一化 sha256）＋ LF 字节**；最右两列只在与本机同为 CRLF 工作区时有意义。

### 2.3 指纹自绑（blob 与提交对象一致，实测）

```
$ git rev-parse HEAD:packages/contracts/openapi.json HEAD:packages/contracts/operations.json HEAD:packages/contracts/states.json
3804c64b3cdda57ef1f87d5a569c74d712ffefa6
06b82fc7094821e7aab4ee6e994ad81daecdfedf
e78510c0a65b4d186ae870cd4902bf910d0fc55c
```

⇒ §2.2(a)／§2.2(b) 的 `blob` 列即该提交（`24fac03`）内的对象身份，可被 `git cat-file -p <blob>` 直接取回；**其内容即 §2.2(b) 计算 LF 归一化 sha256 所用的字节**（故该判据与 blob 一体、跨平台恒定）。

### 2.4 冻结口径（**引用仓库既有政策，未自行发明**）

| 口径 | 出处（file:line） | 原文摘录 |
| --- | --- | --- |
| 契约当前状态 = **待监工冻结** | `packages/contracts/README.md:3` | 「GY-I01 / #1，待监工冻结；没有已运行API。业务v1.0、开发v1.1。」 |
| 冻结未生效 | `docs/architecture/adr-001-initial-architecture.md:3` | 「状态：**提交监工审查，尚未冻结生效**。契约版本 `1.0.0`，不是应用发布版本。」 |
| 下游按冻结版本验收的前提 | `docs/architecture/acceptance-map.md:40` | 「契约经监工确认后下游才按已冻结版本验收；可用提案替身并行写代码」 |
| 谁决定冻结 | `docs/architecture/acceptance-map.md:55` | 「PR记录实际命令、环境、HEAD和CI链接；监工独立验证后决定是否冻结。」 |
| #1 权威验收条文 | `docs/initial-issues.json:37` | 「监工审查确认契约后，下游才按冻结版本开发；改变契约必须同步文档与依赖」 |
| 改契约的影响评估 | `docs/development-guide.md:104` | 「API 契约版本为 1.0.0；删改字段、权限、单位或状态语义需列消费者和兼容／迁移影响，不静默破坏接口。」 |
| 变更分级与消费者同步 | `docs/architecture/adr-001-initial-architecture.md:68` | 「冻结后新增可选字段走 minor，纠错走 patch，删除/重命名字段、枚举语义、权限、单位或状态转移变化走 major 与 `/api/v2`，须同 PR 更新小程序、后台、适配器和验证案例。」 |
| 同 PR 更新清单 | `packages/contracts/README.md:14` | 「版本变化须同PR更新消费者、枚举、索引、行为说明与示例」 |
| 破坏冻结契约 = 审查阻塞项 | `docs/pr-review-policy.md:65` | 「**阻塞须有实际影响：** 功能故障、错误可执行指导、**冻结契约消费者破坏**、权限／隐私／用药安全…仍阻塞」 |
| 「零差异」人工判据 | `docs/ui-contract-binding.md:24`、`:117` | 判据：`git diff origin/main -- packages/contracts/` ⇒ 零差异 |
| 机器判据 | `tests/ui-adaptive.test.mjs:320` | `assert.ok(!changed.some((f) => f.startsWith('packages/contracts/')), '不得修改冻结契约')` |

**本记录据此只登记"当前指纹"，不声明"已冻结生效"**——冻结生效须由监工按上表条文判定。

## 3 可复核命令与本次实测输出

### 3.1 契约一致性（CI 也跑的离线命令）

```
$ npm run test:contract
> gengyun@0.0.0 test:contract
> node --test "tests/contract/*.test.mjs"

✔ API 错误码与 HTTP 状态映射与契约 states.json 完全一致 (1.149ms)
✔ API ExecutionMode 与契约 states.json 一致 (0.1238ms)
✔ API 错误码集合与 openapi ErrorCode 枚举一致 (0.203ms)
✔ 错误码在状态映射中不重复归属 (0.0796ms)
✔ meta.contract_version 与契约 Meta 常量一致，且必填字段齐备 (0.1089ms)
✔ Error / ErrorEnvelope 形状与契约一致 (0.0968ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 122.8765
# EXITCODE: 0
```

⇒ 该命令验的是**代码与契约一致**，**不验指纹、也不证明契约未被改动**（见 §5）。

`development-docs.yml:38-39` 还会在 CI 跑两条纯 Python 离线检查，本次也实跑留档：

```
$ python3 tools/validate_contracts.py
PASS: 112 operations; contract consistency; 29 fixtures; 30 media traces; 8 knowledge roundtrips (design only, not runtime tests)
# EXITCODE: 0

$ python3 tools/test_contracts.py
... Ran 8 tests in 0.163s

OK
# EXITCODE: 0
```

⇒ 二者验的是**契约自身一致性与检查器负例**（设计层，非运行层），同样**不比对文件指纹**。

### 3.2 契约覆盖与装配（独立命令，未接 CI）

```
$ node tools/verify-contract-status.mjs
PASS: 覆盖 112 条契约操作；已装配 99 条；implemented 13 / partial 86 / planned 13；横切维度 8 条；中文表格一致
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。
# EXITCODE: 0

$ node tools/verify-contract-status.mjs --runtime
PASS: 覆盖 112 条契约操作；已装配 99 条；implemented 13 / partial 86 / planned 13；横切维度 8 条；中文表格一致
PASS: 无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致（不监听 / 不请求服务）。
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。
# EXITCODE: 0
```

`--runtime` 需要已安装依赖（无 `node_modules` 时实测 `ERR_MODULE_NOT_FOUND: Cannot find package 'fastify'`、exit 1，已存档）；本次在 §3.3 的 `npm ci` 之后运行通过，**未监听端口、未请求业务服务**。

### 3.3 依赖安装与锁定（本地实测）

```
$ npm ci --no-audit --no-fund
added 103 packages in 4s
# EXITCODE: 0
```

```
$ npm ls fastify typescript vue vite pg @vitejs/plugin-vue @vue/compiler-sfc --depth=0
gengyun@0.0.0 E:\GengYunCommander\.pg17\wt-i01-freeze
+-- @gengyun/admin@0.0.0 -> .\apps\admin
| +-- @vitejs/plugin-vue@6.0.9
| +-- @vue/compiler-sfc@3.5.43
| +-- vite@7.3.6
| `-- vue@3.5.43
+-- @gengyun/api@0.0.0 -> .\services\api
| +-- fastify@5.12.5
| `-- pg@8.23.1
`-- typescript@5.9.3
# EXITCODE: 0
```

⇒ 实测安装版本与 `packages/contracts/runtime-baseline.json` 的候选**逐项相同**（fastify 5.12.5、typescript 5.9.3、vue 3.5.43、@vue/compiler-sfc 3.5.43、vite 7.3.6、@vitejs/plugin-vue 6.0.9、pg 8.23.1）。**这不等于运行时/插件兼容已验收**（该文件自身也标注 `clean_install: pending`）。

### 3.4 契约未被改动（人工判据）

```
$ git diff --name-only origin/main -- packages/contracts/
# （无输出）
# EXITCODE: 0
```

## 4 运行版本冻结：本地实测 vs CI 声称（**分开写**）

### 4.1 本地实测（本次，写手 worktree）

| 项 | 声称来源（file:line） | 声称值／约束 | **本地实测值** | 实测命令 | 是否满足 |
| --- | --- | --- | --- | --- | --- |
| Node | `package.json:8`、`services/api/package.json:10`、`apps/admin/package.json:9` | `>=24.16.0 <25` | `v24.16.0` | `node --version` | 满足（下界恰好命中） |
| npm | `package.json:9` | `>=11.13.0` | `11.13.0` | `npm --version` | 满足（下界恰好命中） |
| Python | `README.md:27` | `3.11+`（文档检查用） | `3.14.3` | `python3 --version` | 满足 |
| 平台 | `packages/contracts/runtime-baseline.json`（`platform` 记 `Windows x64`） | 未约束 | `Microsoft Windows 11 家庭版 中文版`，NT `10.0.26200.0` | `(Get-CimInstance Win32_OperatingSystem).Caption`、`[System.Environment]::OSVersion` | 仅登记（非兼容结论） |
| 依赖（API） | `services/api/package.json:21-22` | fastify `5.12.5`、pg `8.23.1` | 5.12.5、8.23.1 | `npm ls … --depth=0` | 一致 |
| 依赖（后台） | `apps/admin/package.json:18-23` | vue `3.5.43`、@vitejs/plugin-vue `6.0.9`、@vue/compiler-sfc `3.5.43`、vite `7.3.6` | 同左，逐项一致 | `npm ls … --depth=0` | 一致 |
| 依赖（根） | `package.json:28-31`（`:29` `@types/node`、`:30` typescript） | typescript `5.9.3`、@types/node `24.19.1` | typescript `5.9.3`、@types/node `24.19.1` | `npm ls … --depth=0`、`npm ls @types/node --depth=0` | **逐项一致**（r2 补齐：`npm ls @types/node --depth=0` ⇒ `@types/node@24.19.1`，与 `package.json:29` 相同；初版"@types/node 未测"一条**已关闭**） |
| 锁文件策略 | `package-lock.json`（已提交）、`.gitignore` 无锁文件例外 | `npm ci` 锁文件安装 | `lockfileVersion = 3`、156 条 `packages`、`npm ci` exit 0（103 包） | `node -e "…package-lock.json…"`、`npm ci` | 成立 |
| 微信基础库 | `project.config.json:7`、`miniprogram/project.config.json:27` | `libVersion: 3.17.3` | **本次未实测**（本片未开微信开发者工具）；历史实测见 4.3 | — | **未取得** |

### 4.2 CI 声称（**仅读配置，未取得 CI 运行读数**）

| 项 | 位置（file:line） | CI 配置值 | 本次是否实跑 | 说明 |
| --- | --- | --- | --- | --- |
| Node | **全仓合计：13 处 / 9 个 workflow**（`git grep -c "node-version: '24.16.0'" -- .github/workflows/`，共 10 个 workflow 文件） | `node-version: '24.16.0'` | **否** | `engineering-shell.yml` 5 处、`local-wechat.yml:53`、`access-verification.yml:19`、`auth-privacy-postgres.yml:31`、`catalog-postgres.yml:31`、`consent-grant-postgres.yml:31`、`source-lifecycle-postgres.yml:31`、`staging-intake-postgres.yml:31`、`workbook-staging.yml:39`。**原文只写"六处"，本次按实测更正** |
| Node | `.github/workflows/engineering-shell.yml:38,52,66,80,94` | `node-version: '24.16.0'` | **否** | **五个** job（static/unit/contract/evaluation/build）各自内联；同文件的 `docs` job（`:17-27`）**不装 Node**。与 `engines` 下界字面相同 |
| Node | `.github/workflows/local-wechat.yml:53` | `node-version: '24.16.0'` | **否** | 该 workflow **只在指定 paths 变更时触发**（`:4-20`、`:23-39`） |
| Python | `.github/workflows/engineering-shell.yml:24`、`.github/workflows/development-docs.yml:36` | 仅 `python3 --version`（**未锁版本**） | **否** | 用 runner 自带 `python3`，无 `setup-python`、无版本 pin |
| npm | 无 | CI 无 npm 版本 pin | **否** | 由 Node 发行包自带 npm 决定 |
| 依赖 | **全仓 `npm ci`：12 处 / 8 个 workflow**（其中带 `--no-audit --no-fund` 的 **11 处 / 7 个**）：`engineering-shell.yml:40,54,68,82,96`、`auth-privacy-postgres.yml:33`、`catalog-postgres.yml:33`、`consent-grant-postgres.yml:33`、`source-lifecycle-postgres.yml:33`、`staging-intake-postgres.yml:33`、`workbook-staging.yml:41`，另 `local-wechat.yml:54` 为**不带 flags** 的 `npm ci` | `npm ci --no-audit --no-fund`（锁文件） | **否** | 命令与本地一致，但**本次未取得 CI 日志**。口径：`git grep -c "npm ci" -- .github/workflows/`（**原文只列 engineering-shell 的 5 处，本次按实测更正**） |
| 微信基础库 | 无 | CI **无**基础库／编译步骤 | **否** | `local-wechat.yml` 只做 Node 静态与诊断检查（`.github/workflows/local-wechat.yml:55-63`）；该句出自 **`.github/workflows/engineering-shell.yml:6`** 文件头——「微信开发者工具编译与真机是**本机任务**，不在本 CI，也不由 Node 检查冒充。」（**原文误引为 `local-wechat.yml:6`**；该行实为 `      - 'project*.json*'`，且该句在本机 `local-wechat.yml` 内**零命中**，实测：`git grep -n "本机任务" -- .github/workflows/`） |

### 4.3 历史实测（**引用既有记录，本次未复测，不得当作本次读数**）

| 项 | 出处 | 记录值 | 边界 |
| --- | --- | --- | --- |
| Node／npm／Python | `docs/verification/gy-i02-clean-repro-20261014.md:33-35` | `v24.16.0`／`11.13.0`／`3.14.3` | 2026-10-14，另一 worktree（`GengYun_W32`） |
| 微信基础库（模拟器） | `docs/verification/gy-i02-clean-repro-20261014.md:337-338` | `SDKVersion = 3.17.3` | **`platform = devtools`，不是真机**；该记录亦注明「真机 `SDKVersion`／真机渲染未取得」 |
| 契约安装兼容（旧结论） | `docs/architecture/validation.md:31` | 「干净安装及 Fastify 注入/TS 编译/Vue 与 Vite 构建兼容**未通过，也未执行**；没有可提交的应用锁文件」 | 该结论绑定 2026-10-03 的 PR #33 HEAD；与本次实测（锁文件已存在、`npm ci` exit 0）**状态不同**。本片**不改历史文件**，并列登记，是否更新由监工裁定 |

### 4.4 本地实测与 CI 声称的差异

1. **Node 一致**：本机 `v24.16.0` 与 **13 处 / 9 个 workflow** 的 CI pin 字面相同；但 `engines` 是**声明**，无 `engine-strict`／`.npmrc`（§1.2 第 4 项），**不构成机器强制**。
2. **npm 无 CI pin**：CI 用 Node 自带 npm，是否 ≥ `11.13.0` 未在 CI 侧核对。
3. **Python 无 CI pin**：本地 `3.14.3`（满足 `README.md:27` 的 3.11+），CI 仅打印 `python3 --version`，**版本未锁定、本次未读到 CI 读数**。
4. **基础库完全不在 CI**：`libVersion` 只有配置文件与历史模拟器实测，**无 CI 覆盖**。
5. **本片未取得任何 CI 运行记录** ⇒ 上表"CI 声称"列**全部是配置字面值**，不是运行证据。

## 5 自证：本记录**是否有机器门禁**

### 5.1 实验 (a)：把本文档里的一个契约指纹**改错一位** ⇒ 门禁是否变红？

改法：把 §2.2(a) `states.json` 的 CRLF 工作区 sha256 末位 `e` 改成 `f`（未提交，仅工作区）。
运行的检查：`npm run test:docs`、`npm run test:contract`、`node --test tests/ui-adaptive.test.mjs`、`git diff --check`。

结果（实测原始输出摘要）：

```
# 指纹已在工作区改错一位（states.json 末位 e → f）
$ npm run test:docs
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
# EXITCODE: 0
$ npm run test:contract
ℹ pass 6   ℹ fail 0
# EXITCODE: 0
$ node --test tests/ui-adaptive.test.mjs
ℹ pass 26   ℹ fail 0
# EXITCODE: 0
$ git diff --check
# EXITCODE: 0
```

⇒ **全部仍然 PASS／exit 0**（无任何检查变红）。

⇒ **本记录登记的指纹没有任何机器门禁校验**。仓库现有的契约相关自动检查（`tests/contract/*.test.mjs`、`tools/validate_contracts.py`、`tools/test_contracts.py`、`tools/verify-contract-status.mjs`、`tests/ui-adaptive.test.mjs`）**都不读本文档的哈希值**。
**因此本文档的指纹只能靠人工复核**：按 **§2.2(b) 的跨平台命令**重算，并与 §2.2(b) 的 **LF 归一化 sha256 / LF 字节**逐字符比对（§2.2(a) 的 CRLF 工作区值**只在同为 CRLF 工作区的机器上可比，不作判据**，否则 CI 上必然假红）。**本记录不暗示存在自动校验**。

**返修后复跑（2026-10-15，r2）**：负控制改用**新判据列**——把 §2.2(b) `states.json` 的 **LF 归一化 sha256** 末位 `1` 改成 `2`（未提交，仅工作区），同一组检查仍**全 PASS／exit 0** ⇒ 结论不变（原始输出见 §6.2）。

### 5.2 实验 (b)：改**契约文件本身** ⇒ 既有门禁是否变红？（证明该门禁确实活着）

做法（**临时**，随后完全回退）：在 `packages/contracts/states.json` 末尾追加一个空格 ⇒ 提交一个临时提交 ⇒ 跑 `node --test tests/ui-adaptive.test.mjs`。

实测原始输出（节选）：

```
✖ 本任务未改动冻结契约与本地配置隔离规则 (74.601ms)
ℹ tests 26
ℹ pass 25
ℹ fail 1
✖ failing tests:
  AssertionError [ERR_ASSERTION]: 不得修改冻结契约
      at TestContext.<anonymous> (file:///…/tests/ui-adaptive.test.mjs:320:10)
# EXITCODE: 1
```

⇒ 断言 `tests/ui-adaptive.test.mjs:320` 报 `不得修改冻结契约`，测试**变红（exit 1）**。
随后 `git reset --hard <本片文档提交>` 回退该临时提交，并复核：

```
$ git log --oneline -1
docs(GY-I01): 补正式契约与运行版本冻结记录（含实测指纹与可复核命令）(Refs #1)
$ git status --porcelain      # 空
$ git diff --name-only origin/main -- packages/contracts/   # 空 ⇒ 零差异
$ git hash-object packages/contracts/states.json
e78510c0a65b4d186ae870cd4902bf910d0fc55c    # 与 §2.2 blob 列一致，契约已还原
```

⇒ **"不得修改冻结契约"这条有机器门禁，且实测可被触发**。但有三点限制，**不能当成"契约指纹有门禁"**：

1. 它比的是 `git diff --name-only origin/main...HEAD` ⇒ **只看已提交的提交差集，不看工作区文件内容**，也**不比对哈希**；
2. 它只在 `local-wechat.yml` 的 `paths` 命中时运行（`.github/workflows/local-wechat.yml:4-20`，且 `:58` 才执行该测试）；`packages/contracts/**` 不在该 paths 内 ⇒ 只改契约不会触发它；触发该 workflow 的是 `miniprogram/**`、`project*.json*`、`config/**`、`docs/ui-demo/**`、部分 `tools/*wechat*` 等；
3. 依赖 `origin/main` 基线存在；无基线时该用例 `t.skip`（`:314-316`，脚本注释说明这是**有意**避免把"未验证"记成 PASS）。

### 5.3 门禁清单（本记录相关，如实）

| 检查 | 命令 | 是否读本记录指纹 | 本次实测 |
| --- | --- | --- | --- |
| 文档结构／链接／表格／F-AC-Q 映射 | `npm run test:docs` | **否** | exit 0（§6） |
| 代码与契约一致 | `npm run test:contract` | **否** | exit 0（§3.1） |
| 契约覆盖与装配 | `node tools/verify-contract-status.mjs [--runtime]` | **否** | exit 0（§3.2） |
| 契约文件未被改动 | `tests/ui-adaptive.test.mjs:320`（`local-wechat.yml` 内） | **否**（只比路径） | 基线 exit 0（26/26）；负控制见 §5.2 |
| **本文档的 blob／LF 归一化 sha256 指纹** | **无** | — | **无机器门禁，人工复核**（r2 负控制复跑见 §6.2(b)） |

## 6 门禁执行记录（本片改动＝只新增 1 份文档；r2 只在该文档上修改）

| 门禁 | 命令 | 退出码 | 输出摘要 |
| --- | --- | --- | --- |
| 文档检查 | `npm run test:docs` | **0** | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| 契约一致性 | `npm run test:contract` | **0** | `ℹ tests 6 / pass 6 / fail 0` |
| 契约自身一致性（设计层） | `python3 tools/validate_contracts.py` | **0** | `PASS: 112 operations; contract consistency; 29 fixtures; 30 media traces; 8 knowledge roundtrips (design only, not runtime tests)` |
| 契约检查器负例 | `python3 tools/test_contracts.py` | **0** | `Ran 8 tests … OK` |
| 契约覆盖与装配 | `node tools/verify-contract-status.mjs --runtime` | **0** | 112 操作、99 装配、13／86／13、8 维度、中文表一致；stub 装配一致 |
| 改动面 | `git diff --name-only upstream/main...HEAD` | — | 见 §6.1（**只 1 份文档**） |
| 工作区 | `git status --porcelain` | — | 空（`node_modules` 被忽略，未入库） |
| 空白检查 | `git diff --check` | **0** | 无输出 |

`test:docs` 原文（照录）：

```
> gengyun@0.0.0 test:docs
> node tools/run-python.mjs tools/validate_development_docs.py

PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
```

### 6.1 改动面与提交

```
$ git diff --name-only upstream/main...HEAD
docs/verification/gy-i01-contract-runtime-freeze-20261015.md

$ git status --porcelain          # 空
$ git diff --check                # 无输出
# EXITCODE(diff --check): 0
```

（上为**提交后**实测；`git diff --name-only` 结果只有本文件一项，除该文件外**无任何其他改动**。
`git diff --stat upstream/main...HEAD` 的插入行数**不在本文件内自引用**——该数字会随本文件自身增删而变，故只在回传 handoff 中登记最终实测值。）

⇒ 相对 `upstream/main` **只新增 1 份文档**（r2 的返修改动也只落在该文档内），**未改** `packages/contracts/**`、`services/**`、`package.json`、`.github/workflows/**`、`README.md`、`AGENTS.md`。故**本次新增 docs 会触发** `.github/workflows/development-docs.yml`（`paths` 含 `docs/**`，`:5`）——但**本片未取得该 workflow 的运行读数**（§4.2）。

### 6.2 返修（r2）自证与负控制原始输出

**(a) §2.2(b) 跨平台复核命令在三种 shell 下实跑**（命令文本**取自本文件 §2.2(b) 代码块、未经改写**，提取脚本记录 `has-brackets=1`）：

```
$ cmd.exe /c run-from-doc.cmd                                   # (A) Windows cmd.exe
packages/contracts/openapi.json blob=3804c64b3cdda57ef1f87d5a569c74d712ffefa6 lfSha256=8a7714983711e4b349f44c84c20bb138ea822b8ae0dd7bc0d983f0989fba89d0 bytes=445338
packages/contracts/operations.json blob=06b82fc7094821e7aab4ee6e994ad81daecdfedf lfSha256=d5b29a1877ed22c91f69919def6d2348d736087403af954500298d74f5a13a8a bytes=18049
packages/contracts/states.json blob=e78510c0a65b4d186ae870cd4902bf910d0fc55c lfSha256=5b4ff78cc9da79acfe03b454ca9fc609c13aeee0bb09c6efa92f71a917d2b3b1 bytes=2730
packages/contracts/examples.json blob=b8bb9a5f601edd1364898755e76fcb7926990a93 lfSha256=871786b56030f9e7d6beaa3e4e9310cb64bf553b55bc38d9ee0a05d5d5f902e8 bytes=201929
packages/contracts/runtime-baseline.json blob=10ddf580544ae847698ac83abeddde4a4f4fcfea lfSha256=b95c77e9855130067925996d6ae0b25872832d2b0152e6823d00ef5e7a204eda bytes=2329
# EXITCODE: 0

$ bash run-from-doc.sh                                          # (B) Git for Windows bash（MINGW64_NT-10.0-26200）
# 同上五行，逐字符相同
# EXITCODE: 0

$ powershell -NoProfile -ExecutionPolicy Bypass -File run-from-doc-ps51.ps1   # (C) Windows PowerShell 5.1.26100.8875（按 §2.2(b) 说明加 --%）
# check: prefix node --% -e = True
# 同上五行，逐字符相同
# EXITCODE: 0
```

逐字符比对（提取本文件 §2.2(b) 与汇总表中的该格式行，`Compare-Object -SyncWindow 0`）：`(A) lines=5 逐字符相同 = True`、`(B) lines=5 逐字符相同 = True`、`(C) lines=5 逐字符相同 = True`。
独立实现复核：GNU coreutils 8.32 的 `sha256sum` 直接消费 `git cat-file blob` 的字节 ⇒ 五行 `lfSha256` 与 §2.2(b) **5/5 相同**；且与仓内既有记录 `merged-source-equivalence.json:1818-1842` **5/5 相同**。

**(b) 负控制：把 §2.2(b) `states.json` 的 LF 归一化 sha256 末位 `1` 改成 `2`（未提交，仅工作区）**：

```
$ git diff --stat
 docs/verification/gy-i01-contract-runtime-freeze-20261015.md | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
$ npm run test:docs
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
# EXITCODE(test:docs): 0
$ npm run test:contract
ℹ tests 6   ℹ pass 6   ℹ fail 0
# EXITCODE(test:contract): 0
$ node --test tests/ui-adaptive.test.mjs
ℹ tests 26   ℹ pass 26   ℹ fail 0
# EXITCODE(ui-adaptive): 0
$ git diff --check
# （无输出）
# EXITCODE(diff --check): 0
```

⇒ **新判据（LF 归一化 sha256）改错一位，四个检查全 PASS／exit 0** ⇒ §5.1 的"无机器门禁、只能人工复核"结论**在 r2 复跑后仍成立**。随后 `git checkout -- <本文件>` 还原：`git status --porcelain` 空、`git diff --stat` 空、`git diff --name-only upstream/main...HEAD` 仍只有本文件。

**(c) 返修门禁（r2，提交后实测）**：`npm run test:docs` ⇒ exit 0（原文同上）；`git diff --name-only upstream/main...HEAD` ⇒ 仅本文件；`git status --porcelain` ⇒ 空；`git diff --check`（**两点**：工作区↔索引）与 `git diff --check upstream/main...HEAD`（**三点**：基线↔HEAD，**以三点为准**）⇒ **均无输出、exit 0**。本节自身为记录新增、其后再提交，故**最终 HEAD 上同一组门禁的原始输出登记在回传 handoff**（值相同）；`fix-r2\gate-negative-control-r2.txt`、`gate-x-cmd.txt`、`gate-x-bash.txt`、`gate-x-ps51.txt` 为上述原始输出存档（仓库外）。

## 7 未取得项（**单列；不计入通过、不冒称**）

| 项 | 状态 | 原因 | 复核入口 |
| --- | --- | --- | --- |
| **契约"已冻结生效"的监工批复** | **未取得** | `packages/contracts/README.md:3` 仍写「待监工冻结」；`docs/architecture/adr-001-initial-architecture.md:3` 仍写「尚未冻结生效」。冻结须由监工按 `docs/initial-issues.json:37`、`docs/architecture/acceptance-map.md:40,55` 判定 | #1 台账与监工批复 |
| **#1 整项验收结论** | **未取得** | 不在本片范围；本片只做记录 | `docs/initial-issues.json`（GY-I01 `acceptance`） |
| **CI 运行读数（本分支）** | **未取得** | 本片未 push，无 PR／无 Actions 运行记录 | 建 PR 后由监工独立核对 |
| **CI 实跑 `npm run test:docs` / `test:contract` / `verify-contract-status --runtime`** | **未取得** | 同上；§4.2 的 CI 值全部来自**配置字面读取** | 同上 |
| **CI Python 版本读数** | **未取得** | CI 只 `python3 --version`，未 pin（`development-docs.yml:36`） | 需 CI 日志 |
| **`engines` 的机器强制** | **未取得（且无机制）** | 无 `.npmrc`／`engine-strict`，`engines` 未被工具或测试消费（§1.2 第 4 项） | `git grep engines` |
| **`.nvmrc`／`.node-version` 版本真源** | **未取得（且不存在）** | `git ls-files` 0 命中（§1.2 第 3 项） | 同上 |
| **真机基础库／真机渲染** | **未取得** | 本片未开微信开发者工具；历史记录只到**模拟器** `platform=devtools`（`docs/verification/gy-i02-clean-repro-20261014.md:337-338`） | 真机走查（属 #23 等） |
| **本次微信工具编译／界面检查** | **未取得** | 本片是纯文档记录，不启工具、不编译 | `local-wechat.yml` 触发的检查 |
| **若仅改契约文件的 CI 拦截** | **未取得** | `packages/contracts/**` 不在 `local-wechat.yml` 的 `paths`（`:4-20`）⇒ 契约不可改的机器断言**不会仅因改契约而被触发** | §5.2 第 2 点 |
| **`sha256sum` 交叉复核** | **已取得（Git for Windows 自带 GNU coreutils 8.32，非 Linux）** | r2 以 `git cat-file blob <blob>` 送 `sha256sum` 复核 §2.2(b) 五行 ⇒ **5/5 逐字符相同**（原始输出：仓库外 `fix-r2\crosscheck-lf.txt` 第 (2) 段） | Linux／CI 侧仍未实跑；复核时直接用 §2.2(b) 命令 |
| **CI（`ubuntu-24.04`）实跑 §2.2(b) 命令** | **未取得** | 本片未 push ⇒ 无 Actions 运行；r2 的本机复核是 Windows 侧三种 shell（cmd.exe／Git Bash／PowerShell 5.1） | 建 PR 后在任一 Linux runner 复跑 §2.2(b)（判据跨平台，预期 5/5 相同） |
| **`runtime-baseline.json` 的陈旧声明更正** | **未做（有意）** | 该文件属冻结件，本片不改；`verification.clean_install = "pending"` 与 §3.3 实测不一致 | 待监工裁定 |

## 8 本片结论与边界

- **契约侧**：`upstream/main = 24fac03` 上确实存在可冻结的正式契约三件（`openapi.json`／`operations.json`／`states.json`），本记录给出其**实测 git blob 指纹与 LF 归一化 sha256（跨平台判据）＋ LF 字节**（§2.2(b)），并登记本机 CRLF 工作区 sha256 与字节（§2.2(a)，**机器相关、不作判据**）；并引用仓库既有政策说明**冻结生效须由监工判定**（§2.4）——本记录**不宣布冻结**。
- **运行版本侧**：Node／npm／Python／依赖精确版本／锁文件策略均有**本地实测**读数；CI 侧只有**配置字面值**（§4），二者**分述**，未混写。
- **门禁侧**：本记录**无机器门禁**，靠人工复核（§5.1 实验证伪了"有校验"的假设）；"不得修改冻结契约"这条机器断言确实存在且可被触发，但有 §5.2 列出的三点限制。
- **未取得项**已在 §7 单列，**不计入通过**。

## 9 诚实边界与交付声明

- **本文档是记录，不构成 #1 的验收结论**。#1 的关闭由监工按其验收项（`docs/initial-issues.json` GY-I01 的 `acceptance`，含「监工审查确认契约后，下游才按冻结版本开发；改变契约必须同步文档与依赖」）判定。
- 本片**只涉及 1 份文档**：`docs/verification/gy-i01-contract-runtime-freeze-20261015.md`（初版为新增；r2 返修仅在该文件内修改，未新增／改动其他文件）。
- **未改** `packages/contracts/**`（冻结件）、`services/**`、`package.json` 版本约束、CI workflow、`README`／`AGENTS.md`。
- **未 push、未合并、未 force**；写手不持有 GitHub 凭据。
- **未读取或打印任何密钥**；§3.2 的 `--runtime` 在无凭据 stub 子进程中运行，不监听端口、不请求业务服务。
- 待监工裁定的两处**陈旧／待补**：`packages/contracts/runtime-baseline.json` 的 `verification.clean_install: "pending"`（与 §3.3 实测不一致）；`docs/architecture/validation.md:31` 的历史结论（与本次实测状态不同）。二者均**属冻结件/历史记录，本片有意未改**。
- **模型标注（如实）**：初版与 r2 返修单均声明 `model = deepseek-v4.1-flash`（r2 按**会话继承模型**执行，与派单一致）；推理等级（「高」）**无法通过工具参数下发**，仅在派单文件与本记录中**声明**，本片不据此声称参数合规。
