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
| 取证机 | Windows（`Microsoft Windows 11 家庭版`），PowerShell；本机 Node `v24.16.0`、npm `11.13.0`、Python `3.14.3` |
| **未 push** | 是（写手不持有 GitHub 凭据；推送与建 PR 由指挥执行） |
| **未取得 CI 读数** | 是（本分支无 CI 运行记录；本文**不把 CI 配置当成已验证**） |

原始日志（UTF-8）另存**仓库外** `E:\GengYunCommander\.pg17\tmp-i01-freeze\`（`test-docs.txt`、`test-contract.txt`、`verify-status.txt`、`verify-status-runtime.txt`、`hashes.txt`、`npm-ls.txt`、`versions.txt`、`ui-adaptive-baseline.txt`）。

## 1 侦察结论：已存在、可直接复用 vs 缺失、需本次补

派单要求先侦察、避免重复劳动。侦察一律读 `upstream/main = 24fac03`（在写手 worktree 内工作区即该提交，`git status --porcelain` 为空）。

### 1.1 已存在、可直接复用（逐项给 file:line）

| # | 已有成果 | 位置（file:line） | 一句话说明 |
| --- | --- | --- | --- |
| 1 | 正式契约三件 + 示例 + 运行基线 | `packages/contracts/openapi.json`（462,211 B）、`operations.json`（18,839 B）、`states.json`（2,887 B）、`examples.json`（208,172 B）、`runtime-baseline.json`（2,359 B） | 契约 `1.0.0`、提案修订 `2`；三件即本记录要冻结指纹的对象 |
| 2 | 契约目录自带状态声明 | `packages/contracts/README.md:3` | 原文「GY-I01 / #1，**待监工冻结**；没有已运行API」⇒ 现状是**待冻结**，不是已冻结 |
| 3 | 契约版本变更规则（同 PR 更新消费者） | `packages/contracts/README.md:14` | 「版本变化须同PR更新消费者、枚举、索引、行为说明与示例」 |
| 4 | 冻结提案与变更分级口径 | `docs/architecture/adr-001-initial-architecture.md:3`、`:68` | `:3` 状态「提交监工审查，**尚未冻结生效**」；`:68` minor／patch／major 与 `/api/v2`、同 PR 更新消费者 |
| 5 | 冻结生效条件的政策条文 | `docs/architecture/acceptance-map.md:40`、`:55` | `:40`「契约经监工确认后下游才按已冻结版本验收」；`:55`「监工独立验证后决定是否冻结」 |
| 6 | #1 的权威验收条文（改契约须同步文档与依赖） | `docs/initial-issues.json:37` | GY-I01 `acceptance[2]` 原文；台账 `status` 为 `待审PR` |
| 7 | 契约实现状态对照（人工判定 + 机器副本） | `docs/architecture/contract-implementation-status.md`、`docs/architecture/contract-status.json:6` | `:6` 明写该 JSON「**不是冻结契约事实源**」，只记实现进度 |
| 8 | 可复核校验工具（独立命令，未接 CI） | `tools/verify-contract-status.mjs`；接入状态见 `docs/architecture/contract-implementation-status.md:183` | `:183` 原文「脚本是独立命令，**未追加 CI 工作流或修改 package.json**」 |
| 9 | 契约一致性门禁 | `package.json:21`（`test:contract`）、`.github/workflows/engineering-shell.yml:57-69`、`.github/workflows/development-docs.yml:38-39` | CI 跑 `npm run test:contract` 与 `python3 tools/validate_contracts.py`／`test_contracts.py`（离线、无外部调用） |
| 10 | **契约文件不可改**的机器断言 | `tests/ui-adaptive.test.mjs:303-324`（判据在 `:320`） | `assert.ok(!changed.some((f) => f.startsWith('packages/contracts/')), '不得修改冻结契约')`；与 `docs/ui-contract-binding.md:24` 的人工口径一致 |
| 11 | 既有契约验证记录 | `docs/architecture/validation.md`、`docs/verification/gy-i01-contract-status-20261011.md`、`docs/verification/gy-i01-contract-status-refresh-20261013.md`、`docs/verification/gy-i01-status-sync-20261013.md` | 分别记：契约本身检查与限制；可复现启动 + 本机门禁；对照刷新（逐项比较 112 条操作元数据未改）；新 main 同步 |
| 12 | 运行版本来源（Node／npm） | `package.json:7-10`、`services/api/package.json:9-11`、`apps/admin/package.json:8-10` | 三处 `engines`：`"node": ">=24.16.0 <25"`，根另有 `"npm": ">=11.13.0"` |
| 13 | 依赖精确版本与锁文件策略 | `services/api/package.json:21-22`、`apps/admin/package.json:18-23`、`package.json:28-31`、`package-lock.json` | 依赖写**精确版本**（无 `^`）；`package-lock.json` **已提交**（`git ls-files` 命中），`lockfileVersion = 3`、156 条 `packages` |
| 14 | 运行候选基线（含未验证声明） | `packages/contracts/runtime-baseline.json` | `status = candidate_pending_GY-I02_GY-I25`；`verification.*` 多项仍 `pending` |
| 15 | 微信基础库目标 | `project.config.json:7`、`miniprogram/project.config.json:27` | 两处 `"libVersion": "3.17.3"`（同一口径） |
| 16 | 既有运行版本**实测**证据（历史） | `docs/verification/gy-i02-clean-repro-20261014.md` §1、§4.10 | 记：Node `v24.16.0`／npm `11.13.0`／Python `3.14.3`；模拟器 `SDKVersion=3.17.3`（**devtools，不是真机**） |
| 17 | CI 中锁定的 Node 版本 | `.github/workflows/engineering-shell.yml:38,52,66,80,94`、`.github/workflows/local-wechat.yml:53` | 六处均为 `node-version: '24.16.0'` |

### 1.2 缺失、需本次补（本次按"只加 1 份文档"补齐；**不改代码**）

| # | 缺失项 | 侦察依据（file:line 或命令） | 本片处理 |
| --- | --- | --- | --- |
| 1 | 三个契约文件的**登记在案指纹**（sha256／git blob） | 全仓搜索本次算出的指纹：`git grep -e e677d805df1b925f -e 3804c64b3cdda57e …` ⇒ **0 命中** | 本次补入 §2（实测命令 + 原始输出） |
| 2 | 「**本地实测**」与「**CI 声称**」**分述**的运行版本记录 | 既有 `docs/verification/**` 无此类记录；`docs/architecture/validation.md:23` 只记「Node24.16.0/npm11.13.0 实际运行版本已读」，未与 CI 声称分列 | 本次补入 §5（分列 5.1／5.2／5.3） |
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

- `Get-FileHash -Algorithm SHA256` 对**文件原始字节**做 SHA-256（等价算法同 GNU `sha256sum`；**本机无 `sha256sum`，未做交叉复核**，如实说明）。
- `git hash-object` 给 **git blob** 哈希（`sha1("blob <len>\0" + 内容)`），与 `git rev-parse HEAD:<path>` 一致（§2.3 已核对）。

### 2.2 原始输出（2026-10-15，worktree HEAD `24fac03`，工作区无改动）

```
packages/contracts/openapi.json  sha256=e677d805df1b925f0c36d53441ae80e8dc2e0e12261ee9be574b1b57a247d9d8  blob=3804c64b3cdda57ef1f87d5a569c74d712ffefa6
packages/contracts/operations.json  sha256=a1d9eea897bcc4c269bd6256e82db2cb4672d286668ddf4b7872669586a051b7  blob=06b82fc7094821e7aab4ee6e994ad81daecdfedf
packages/contracts/states.json  sha256=18802f45fc819481f16da98963101f39de255e77fa470afa4ccc0b233753857e  blob=e78510c0a65b4d186ae870cd4902bf910d0fc55c
packages/contracts/examples.json  sha256=014bbb1d3e840b871df8e95cae2207e274798a302d03d7664dabd5e47870df89  blob=b8bb9a5f601edd1364898755e76fcb7926990a93
packages/contracts/runtime-baseline.json  sha256=9869bd5feb3343bebe0be6f279a3c3f5791277a19c12838dfb368a4eaa5122bc  blob=10ddf580544ae847698ac83abeddde4a4f4fcfea
```

### 2.3 指纹自绑（blob 与提交对象一致，实测）

```
$ git rev-parse HEAD:packages/contracts/openapi.json HEAD:packages/contracts/operations.json HEAD:packages/contracts/states.json
3804c64b3cdda57ef1f87d5a569c74d712ffefa6
06b82fc7094821e7aab4ee6e994ad81daecdfedf
e78510c0a65b4d186ae870cd4902bf910d0fc55c
```

⇒ 上表 blob 列即该提交（`24fac03`）内的对象身份，可被 `git cat-file -p <blob>` 直接取回。

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

### 3.1 契约一致性（CI 也跑的两条离线命令）

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

⇒ 该命令验的是**代码与契约一致**，**不验指纹、也不证明契约未被改动**（见 §6）。

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
| 平台 | `packages/contracts/runtime-baseline.json`（`platform`） | 未约束 | Windows 11 家庭版 | — | 仅登记 |
| 依赖（API） | `services/api/package.json:21-22` | fastify `5.12.5`、pg `8.23.1` | 5.12.5、8.23.1 | `npm ls … --depth=0` | 一致 |
| 依赖（后台） | `apps/admin/package.json:18-23` | vue `3.5.43`、@vitejs/plugin-vue `6.0.9`、@vue/compiler-sfc `3.5.43`、vite `7.3.6` | 同左，逐项一致 | `npm ls … --depth=0` | 一致 |
| 依赖（根） | `package.json:28-31` | typescript `5.9.3`、@types/node `24.19.1` | typescript 5.9.3 | `npm ls … --depth=0` | 一致（@types/node 未列入本次查询） |
| 锁文件策略 | `package-lock.json`（已提交）、`.gitignore` 无锁文件例外 | `npm ci` 锁文件安装 | `lockfileVersion = 3`、156 条 `packages`、`npm ci` exit 0（103 包） | `node -e "…package-lock.json…"`、`npm ci` | 成立 |
| 微信基础库 | `project.config.json:7`、`miniprogram/project.config.json:27` | `libVersion: 3.17.3` | **本次未实测**（本片未开微信开发者工具）；历史实测见 4.3 | — | **未取得** |

### 4.2 CI 声称（**仅读配置，未取得 CI 运行读数**）

| 项 | 位置（file:line） | CI 配置值 | 本次是否实跑 | 说明 |
| --- | --- | --- | --- | --- |
| Node | `.github/workflows/engineering-shell.yml:38,52,66,80,94` | `node-version: '24.16.0'` | **否** | 六个 job（docs/static/unit/contract/evaluation/build）各自内联；与 `engines` 下界字面相同 |
| Node | `.github/workflows/local-wechat.yml:53` | `node-version: '24.16.0'` | **否** | 该 workflow **只在指定 paths 变更时触发**（`:4-20`、`:23-39`） |
| Python | `.github/workflows/engineering-shell.yml:24`、`.github/workflows/development-docs.yml:36` | 仅 `python3 --version`（**未锁版本**） | **否** | 用 runner 自带 `python3`，无 `setup-python`、无版本 pin |
| npm | 无 | CI 无 npm 版本 pin | **否** | 由 Node 发行包自带 npm 决定 |
| 依赖 | `.github/workflows/engineering-shell.yml:40,54,68,82,96` | `npm ci --no-audit --no-fund`（锁文件） | **否** | 与本地同命令，但**本次未取得 CI 日志** |
| 微信基础库 | 无 | CI **无**基础库／编译步骤 | **否** | `local-wechat.yml` 只做 Node 静态与诊断检查（`:55-63`），文件头 `:6` 注明「微信开发者工具编译与真机是**本机任务**，不在本 CI」 |

### 4.3 历史实测（**引用既有记录，本次未复测，不得当作本次读数**）

| 项 | 出处 | 记录值 | 边界 |
| --- | --- | --- | --- |
| Node／npm／Python | `docs/verification/gy-i02-clean-repro-20261014.md:33-35` | `v24.16.0`／`11.13.0`／`3.14.3` | 2026-10-14，另一 worktree（`GengYun_W32`） |
| 微信基础库（模拟器） | `docs/verification/gy-i02-clean-repro-20261014.md:337-338` | `SDKVersion = 3.17.3` | **`platform = devtools`，不是真机**；该记录亦注明「真机 `SDKVersion`／真机渲染未取得」 |
| 契约安装兼容（旧结论） | `docs/architecture/validation.md:31` | 「干净安装及 Fastify 注入/TS 编译/Vue 与 Vite 构建兼容**未通过，也未执行**；没有可提交的应用锁文件」 | 该结论绑定 2026-10-03 的 PR #33 HEAD；与本次实测（锁文件已存在、`npm ci` exit 0）**状态不同**。本片**不改历史文件**，并列登记，是否更新由监工裁定 |

### 4.4 本地实测与 CI 声称的差异

1. **Node 一致**：本机 `v24.16.0` 与六处 CI pin 字面相同；但 `engines` 是**声明**，无 `engine-strict`／`.npmrc`（§1.2 第 4 项），**不构成机器强制**。
2. **npm 无 CI pin**：CI 用 Node 自带 npm，是否 ≥ `11.13.0` 未在 CI 侧核对。
3. **Python 无 CI pin**：本地 `3.14.3`（满足 `README.md:27` 的 3.11+），CI 仅打印 `python3 --version`，**版本未锁定、本次未读到 CI 读数**。
4. **基础库完全不在 CI**：`libVersion` 只有配置文件与历史模拟器实测，**无 CI 覆盖**。
5. **本片未取得任何 CI 运行记录** ⇒ 上表"CI 声称"列**全部是配置字面值**，不是运行证据。

## 5 自证：本记录**是否有机器门禁**

### 5.1 实验 (a)：把本文档里的一个契约指纹**改错一位** ⇒ 门禁是否变红？

改法：把 §2.2 `states.json` 的 sha256 末位 `e` 改成 `f`（未提交，仅工作区）。
运行的检查：`npm run test:docs`、`npm run test:contract`、`node --test tests/ui-adaptive.test.mjs`、`git diff --check`。

结果（实测）：**全部仍然 PASS／exit 0**。

⇒ **本记录登记的指纹没有任何机器门禁校验**。仓库现有的契约相关自动检查（`tests/contract/*.test.mjs`、`tools/validate_contracts.py`、`tools/test_contracts.py`、`tools/verify-contract-status.mjs`、`tests/ui-adaptive.test.mjs`）**都不读本文档的哈希值**。
**因此本文档的指纹只能靠人工复核**：按 §2.1 命令重算并与 §2.2 逐字符比对。**本记录不暗示存在自动校验**。

### 5.2 实验 (b)：改**契约文件本身** ⇒ 既有门禁是否变红？（证明该门禁确实活着）

做法（**临时**，随后完全回退）：在 `packages/contracts/states.json` 末尾追加一个空格 ⇒ 提交一个临时提交 ⇒ 跑 `node --test tests/ui-adaptive.test.mjs`。

预期与实测：断言 `tests/ui-adaptive.test.mjs:320` 报 `不得修改冻结契约`，测试**变红（exit 1）**。
随后 `git reset --hard 24fac03` 回退该临时提交，确认 `git log -1` 回到 `24fac03`、`git status --porcelain` 为空。

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
| **本文档的 sha256／blob 指纹** | **无** | — | **无机器门禁，人工复核** |

## 6 门禁执行记录（本片改动＝只新增 1 份文档）

| 门禁 | 命令 | 退出码 | 输出摘要 |
| --- | --- | --- | --- |
| 文档检查 | `npm run test:docs` | **0** | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| 契约一致性 | `npm run test:contract` | **0** | `ℹ tests 6 / pass 6 / fail 0` |
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
```

```
$ git diff --cached --stat          # 提交前（暂存区）实测
 .../gy-i01-contract-runtime-freeze-20261015.md     | 342 +++++++++++++++++++++
 1 file changed, 342 insertions(+)

$ git diff --cached --numstat
342	0	docs/verification/gy-i01-contract-runtime-freeze-20261015.md
```

（除该文件外**无任何其他改动**；`git diff --name-only upstream/main...HEAD` 的实测输出见上一段，提交后同集。）

⇒ 只新增 1 份文档，**未改** `packages/contracts/**`、`services/**`、`package.json`、`.github/workflows/**`、`README.md`、`AGENTS.md`。故**本次新增 docs 会触发** `.github/workflows/development-docs.yml`（`paths` 含 `docs/**`，`:5`）——但**本片未取得该 workflow 的运行读数**（§4.2）。

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
| **`sha256sum` 交叉复核** | **未取得** | 本机（Windows）无 `sha256sum` | 可在 Linux/WSL 复算比对 |
| **`runtime-baseline.json` 的陈旧声明更正** | **未做（有意）** | 该文件属冻结件，本片不改；`verification.clean_install = "pending"` 与 §3.3 实测不一致 | 待监工裁定 |

## 8 本片结论与边界

- **契约侧**：`upstream/main = 24fac03` 上确实存在可冻结的正式契约三件（`openapi.json`／`operations.json`／`states.json`），本记录给出其**实测 sha256 与 git blob 指纹**（§2），并引用仓库既有政策说明**冻结生效须由监工判定**（§2.4）——本记录**不宣布冻结**。
- **运行版本侧**：Node／npm／Python／依赖精确版本／锁文件策略均有**本地实测**读数；CI 侧只有**配置字面值**（§4），二者**分述**，未混写。
- **门禁侧**：本记录**无机器门禁**，靠人工复核（§5.1 实验证伪了"有校验"的假设）；"不得修改冻结契约"这条机器断言确实存在且可被触发，但有 §5.2 列出的三点限制。
- **未取得项**已在 §7 单列，**不计入通过**。

## 9 诚实边界与交付声明

- **本文档是记录，不构成 #1 的验收结论**。#1 的关闭由监工按其验收项（`docs/initial-issues.json` GY-I01 的 `acceptance`，含「监工审查确认契约后，下游才按冻结版本开发；改变契约必须同步文档与依赖」）判定。
- 本片**只新增 1 份文档**：`docs/verification/gy-i01-contract-runtime-freeze-20261015.md`。
- **未改** `packages/contracts/**`（冻结件）、`services/**`、`package.json` 版本约束、CI workflow、`README`／`AGENTS.md`。
- **未 push、未合并、未 force**；写手不持有 GitHub 凭据。
- **未读取或打印任何密钥**；§3.2 的 `--runtime` 在无凭据 stub 子进程中运行，不监听端口、不请求业务服务。
- 待监工裁定的两处**陈旧／待补**：`packages/contracts/runtime-baseline.json` 的 `verification.clean_install: "pending"`（与 §3.3 实测不一致）；`docs/architecture/validation.md:31` 的历史结论（与本次实测状态不同）。二者均**属冻结件/历史记录，本片有意未改**。
- **模型标注（如实）**：派单指定 `provider = wb-writer`／`model = deepseek-v4.1-flash`，推理等级「高」。**推理等级无法通过工具参数下发**，仅在派单文件与本记录中**声明**，本片不据此声称参数合规。
