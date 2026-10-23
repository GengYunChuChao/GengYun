# 发布门禁用法与各项含义

`tools/release-gate.mjs` 是**一条命令把发版前的机器判据串起来**并给出**机器可读汇总**的脚本：
纯 Node、无第三方依赖、不联网、不连库。它把「类型检查 / 单元测试 / 契约 / 私密信息泄漏 / 大文件与二进制」
五类检查统一成同一个 JSON 结构，供人读、也供 CI 与发布记录直接消费。

**它不是什么**：不是发版 runbook（人工端到端清单见 [发版 runbook](runbook-20261022.md)），
也不是交付材料索引核验（那是 `tools/verify-release-materials.mjs` 的职责，只判文档齐不齐）。
三者分工：

| 入口 | 判什么 | 什么时候跑 |
| --- | --- | --- |
| `node tools/release-gate.mjs` | 代码与仓库状态（本页） | 提 PR 前、合并前、发版前各一次 |
| `node tools/verify-release-materials.mjs` | 交付材料的索引页与文件是否齐、runbook 是否可按步骤执行 | 材料/文档变更后，见 runbook §1.1 |
| [发版 runbook](runbook-20261022.md) | 备份 → 迁移 → 启动 → 验证 → 回滚 → 值班 | 真发版时人工照做 |

## 1 用法

```powershell
# 全跑（真库臂默认跳过）；报告默认落 release-gate-report.json（已 gitignore）
node tools/release-gate.mjs

# 只跑两项；或跑除某项之外的全部
node tools/release-gate.mjs --only typecheck,secrets
node tools/release-gate.mjs --skip contract

# 指定基线（默认按 upstream/main → origin/main → main → HEAD 逐个试）与报告路径
node tools/release-gate.mjs --base upstream/main --out .\gate.json

# 看清有哪些门禁 id，再决定 only/skip
node tools/release-gate.mjs --list
```

| 选项 | 作用 | 备注 |
| --- | --- | --- |
| `--only <a,b>` | 只跑点名的门禁 | 与 `--skip` 互斥；未知 id 属用法错误 |
| `--skip <a,b>` | 跑除外点名的门禁 | 过滤后为空属用法错误 |
| `--base <ref>` | 待发布 diff 的基线 | 泄漏与产物门禁都只看 `<base>...HEAD` |
| `--out <path>` | 报告落盘路径 | 默认 `release-gate-report.json`；内容与 stdout 逐字节一致 |
| `--max-file-bytes <n>` | 大文件阈值 | 默认 5242880（5 MiB） |
| `--binary-allow <.ext>` | 放行某些扩展名的二进制 | 逗号分隔，如 `--binary-allow .bin,.png`；默认空＝一律算失败 |
| `--timeout-ms <n>` | 单条命令超时 | 默认 0＝不限；超时记为该门禁失败并写明超时值 |
| `--pg` | 开启真库臂 | 见 §4 为何默认跳过 |
| `--plan <json>` | 用计划文件覆盖门禁定义 | 故障注入/自动化测试用；不是日常入口 |
| `--root <dir>` | 指定仓库根 | 默认取脚本上一级目录 |
| `--list` / `-h` | 列门禁 id / 帮助 | 两者都写 stderr，stdout 保持可解析 |

## 2 各项含义

| id | 名称 | 本仓实际命令 | 通过判据 | 失败时给出 | 默认 |
| --- | --- | --- | --- | --- | --- |
| `typecheck` | 工作区类型检查 | `npm run typecheck --workspaces --if-present`（`services/api`、`apps/admin` 均有 `tsc -p tsconfig.json --noEmit`） | 退出码 0 | 首个 `error TS…` 起 ≤3 行 | 跑 |
| `unit` | 单元测试 | `npm run test:unit`（`node --test`，覆盖 `tests/unit`、`privacy`、`media`、`reference`、`moderation`） | 退出码 0 | 首个 `not ok`/`Error` 起 ≤3 行 | 跑 |
| `contract` | 契约测试与契约状态一致性 | 两步：`npm run test:contract`，然后 `node tools/verify-contract-status.mjs` | 两步都退出码 0 | 首个失败步骤的关键行 ≤3 行 | 跑 |
| `secrets` | 私密信息泄漏扫描 | 进程内扫 `git diff <base>...HEAD` 的**新增行** | 0 条命中 | 命中 `文件:行 规则 ⇒ 掩码/路径`，最多 3 条 | 跑 |
| `artifacts` | 大文件与二进制检查 | 进程内对 diff 里新增/修改的文件 `stat` + 读前 8 KiB 找 NUL | 无 `too-large`、无未放行 `binary` | 超阈值/二进制的文件名与字节数，最多 3 条 | 跑 |
| `pg` | 真库集成臂 | 默认不执行；`--pg` 时逐个跑 `test:integration:*-pg`（本仓 3 个：`recognition-chain-pg`、`conversations-pg`、`media-persistence-pg`） | 每个都退出码 0 | 首个失败脚本的关键行 ≤3 行 | **跳过**（见 §4） |

三条共性：

- **一条门禁 = 一个 id**，多步骤门禁里**首条失败即停**（后续步骤通常依赖前者，接着跑只会刷无关噪音）；
  已跑的步骤明细仍完整留在 `details.steps` 里，便于区分「第几步红的」。
- 每条门禁都给 `name/status/durationMs/exitCode`；失败项另给 `errorLines`（**≤3 行**，见 §3.3）。
- `skipped` **不算失败**：`verdict` 只看有没有 `failed`，但跳过项必须带 `skipReason` 并计入 `counts.skipped`，
  不会用「没跑」冒充「跑过了」。

## 3 输出契约

### 3.1 退出码

| 退出码 | 含义 | 典型场景 |
| --- | --- | --- |
| `0` | 全部通过（跳过项不算失败） | 可以继续提 PR / 合并 |
| `1` | 有门禁失败 | 看 `gates[].errorLines` 定位；README 里的判定行只做速览 |
| `2` | 用法错误 | 未知选项、未知门禁 id、`--only` 与 `--skip` 冲突、过滤后为空、计划文件坏、`--root`/`--plan` 不存在 |

用法错误时 **stdout 为空、不落盘**——不给下游半份 JSON，避免「看起来跑过了」。

### 3.2 报告字段

`stdout` **只有一个 JSON 对象**（无日志、无彩色字符）；人读摘要走 `stderr`，两者互不污染。

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 报告结构版本，当前 `1`；破坏性变更时才加 |
| `tool` / `generatedAt` | 生成者与 ISO 时间戳 |
| `root` / `packageManager` | 实际仓库根；**包管理器判定结果**（见 §5） |
| `base` | `{ref, sha, attempts}`：基线引用、解析到的提交、尝试过哪些 ref |
| `verdict` / `exitCode` | `pass`/`fail` 与对应退出码（与进程退出码同值） |
| `counts` | `{total, passed, failed, skipped}` |
| `gates[]` | 逐项结果，见下表 |
| `notes` | 人类可读的补充说明（如有） |

单条门禁：

| 字段 | 含义 |
| --- | --- |
| `id` / `title` | 门禁 id 与中文名 |
| `status` | `passed` / `failed` / `skipped` |
| `durationMs` / `exitCode` | 耗时（毫秒）与实际退出码（跳过时 `exitCode` 为 `null`） |
| `command` | 实际执行的命令行（跳过时为 `null`）——**报告里写什么就真跑了什么**，不写意图写事实 |
| `skipReason` | 跳过理由（含如何开启），非跳过为 `null` |
| `errorLines` | 失败时的关键错误行，≤3 行；通过时为 `[]` |
| `details` | 逐步骤明细/扫描统计/命中列表（含掩码后的片段） |

### 3.3 失败时的「首条关键错误行」

`errorLines` 的取法：先找第一行带错误特征（`error`/`Error:`/`ERR_…`/`FAIL`/`FAILED`/`not ok`/`失败`/`错误`/`TypeError`）的输出，
取该行与其后至多 2 行；认不出错误特征时取**末尾** 3 行（命令静默失败时致命信息通常在尾部，取开头只会捞到进度噪音）。
每行截断到 400 字符。目的是「够定位、不刷屏」——完整输出仍在你自己终端里。

## 4 真库臂为什么默认跳过

`pg` 门禁需要三样本机未必具备的东西：**PostgreSQL 17 实例**、**连接参数**（`PG*`/`.env.local`，不进仓库）、
**预置 fixture 数据**。缺任一样都会红成「环境问题」，而环境问题不该冒充代码问题，也不该让人为了跑一次门禁去装库。

因此默认 `skipped`，并在 `skipReason` 里写明「用 `--pg` 显式开启」。发版前请在**有库的机器**上显式跑：

```powershell
node tools/release-gate.mjs --only pg --pg
```

## 5 包管理器判定

派单原话是 `pnpm -r typecheck` / `pnpm -r test:unit`，但**本仓是 npm workspaces**（根 `package.json` 的
`workspaces` 字段；没有 pnpm 锁文件，pnpm 会对该字段报警告并且递归脚本无从解析）。脚本不硬编码任何一种，
而是按仓库现状判定并**把判定结果写进报告**：

| 判定 | 触发条件 | `typecheck` 命令 | 证据/备注 |
| --- | --- | --- | --- |
| `pnpm` | 存在 `pnpm-workspace.yaml` 或 `pnpm-lock.yaml` | `pnpm -r --if-present run typecheck` | 递归由 pnpm 负责 |
| `npm` | 否则 | `npm run typecheck --workspaces --if-present` | **本仓当前判定** |

`--if-present` 不能省：工作区没定义该脚本时，缺了它会把「空跑」变成失败，或把「没检查」伪装成通过。
同理，`unit` 门禁优先用**根** `test:unit`——本仓两个工作区都没定义 `test:unit`，
若硬套 `-r test:unit` 会得到一个**什么都没跑的空门禁**（假绿）。

## 6 私密信息泄漏扫描

扫的是**待发布 diff 的新增行**（`git diff <base>...HEAD`，只认新增/修改文件），不是整仓源码——
整仓源码的同类规则由 `tools/lint-workspaces.mjs` 管，两者互补：那边防「一直就在仓库里的」，
这边防「这次才被加进来的」。

| 规则 id | 严重度 | 认什么 | 输出 |
| --- | --- | --- | --- |
| `openai-style-key` | high | `sk-` 前缀且后接 ≥8 位密钥字符 | 掩码（前 4 字符 + 标记） |
| `secret-key-assignment` | high | `SecretKey` 这类键名后接 `:`/`=` 与 ≥8 位值 | 掩码 |
| `private-key-block` | high | `-----BEGIN` 开头、`PRIVATE KEY-----` 结尾的 PEM 块 | 掩码 |
| `local-absolute-path` | medium | 盘符后接反斜杠开头的本机绝对路径（正则 `[A-Za-z]:\\`） | **原样**给出（不是密钥，需看清才能修） |

**high 命中一律掩码**，密钥原文不进 stdout、不进报告、不进终端；这是硬要求，
失败信息足够定位到「哪个文件哪一行哪条规则」，但不足以把密钥再抄一遍到日志里。

规则 id 故意不写成会被本表命中的形状（第一条用 `openai-style-key`，不直写前缀）：
本脚本自己也在「待发布 diff」里，id 命中自己的规则就会变成一次假阳性——
这条约束是被真跑扫出来后补上的，写新规则时请一起遵守。

## 7 与 CI 的关系

`.github/workflows/engineering-shell.yml` 把判据拆成 7 个 job 并行跑（docs/static/unit/integration/contract/evaluation/build），
那是**合并前的事实来源**；本脚本是**本地一条命令的汇总视图**，用于提 PR 前自查与发版记录，
不取代 CI、也不放宽任何 CI 判据。两者口径对齐处：`contract` 门禁与 CI 的 `contract` job 同为
`npm run test:contract` + `node tools/verify-contract-status.mjs`。

## 8 已知边界

- **不做**整仓扫描、不跑 `integration`/`evaluation`/`build`——那些由 CI 与本机对应脚本负责，塞进来只会变慢变糊。
- **不联网**、不需要任何 token：脚本只读 git 与文件系统，不碰 GitHub API。
- `secrets`/`artifacts` 只看 diff：**已存在于仓库里的**历史泄漏不会被本门禁翻出来（那是 `lint-workspaces` 与人工排查的范围）。
- 泄漏规则是**启发式**：命中即拦截（要求人看清），不保证零漏报；`local-absolute-path` 允许作为 medium 放行修复判断。
- 报告默认落在仓库根的 `release-gate-report.json`，已在 `.gitignore` 里；不要把它提交进仓库。
