# 如何取得与判读 CI 实跑读数

本页只写**方法**：从哪个工作流取数、用什么只读命令取、读数怎么判读、以及读数不能证明什么。

**本页不记录、也不声称任何一次 CI 已经通过。** 需要"某提交的 CI 读数"时，按本页方法**现场取数**并把结论**绑定到具体 SHA**；仓库内不放读数副本，理由见[第 4 节](#4-为什么-pr-上的读数不入仓库)。

关联：`Refs #2`（干净环境与工具证据）。范围仅限 GitHub Actions 的检查运行；微信开发者工具编译、真机与真实供应商不在其中（见第 5 节）。

---

## 1 读什么：三个工作流的触发条件与内容（file:line）

检查名是 PR 上可直接引用的必需检查名。下表逐项给出**触发条件**与**实际执行**的 `file:line`。

### 1.1 `.github/workflows/engineering-shell.yml`（工程七项检查）

| 项 | 值 | 位置 |
| --- | --- | --- |
| 触发 | `pull_request`（全部路径）；`push` 限定 `main` | `.github/workflows/engineering-shell.yml:8-11` |
| 权限 | `contents: read` | `:13-14` |
| runner | `ubuntu-24.04`（七个 job 均同） | `:19,32,47,62,81,96,111` |

| job 名（= 检查名） | 位置 | 实际执行 |
| --- | --- | --- |
| `docs` | `:17-28` | `python3 --version` → `validate_development_docs.py` → `validate_contracts.py` → `test_contracts.py`（**不装 Node**） |
| `static-check` | `:30-43` | `setup-node` 固定 `24.16.0` → `npm ci --no-audit --no-fund` → `npm run lint` |
| `unit-tests` | `:45-58` | 同上安装 → `npm run test:unit` |
| `integration-http` | `:60-77` | 同上安装 → `npm run test:integration:http`（`package.json` 里**逐个列出**的 8 个回环脚本；**无需 PG／微信开发者工具／外网**；约 12–17 秒，量级参考） |
| `contract-tests` | `:79-92` | 同上安装 → `npm run test:contract` |
| `evaluation-tests` | `:94-107` | 同上安装 → `npm run test:evaluation` |
| `build` | `:109-122` | 同上安装 → `npm run build` |

文件头另有一条**边界声明**（不是检查）：`:6` 明写"微信开发者工具编译与真机是**本机任务**，不在本 CI，也不由 Node 检查冒充"。

`integration-http` 挑脚本的方式与其它 job 不同：名单写在 `package.json` 的 `test:integration:http` 里**逐个列出**（不是 glob）——`tests/integration/**` 另含需 PG（`*-pg.mjs`）与需微信开发者工具（`local-dev-*.cjs`）的脚本，一把抓会把它们拖进必跑路径。该 job 只用内存存储与 `127.0.0.1` 回环：不起库、不调真实供应商；脚本里出现的 `*.invalid` 域名是**内容数据**（RFC 2606 保留、不可解析），不是请求目标。

### 1.2 `.github/workflows/development-docs.yml`（文档检查）

| 项 | 值 | 位置 |
| --- | --- | --- |
| 触发 | `pull_request` 与 `push: main`，**均**限定 `paths`：`docs/**`、`AGENTS.md`、`README.md`、`.github/**`、四个 `tools/*.py`、`packages/contracts/**` | `.github/workflows/development-docs.yml:2-25` |
| 权限 | `contents: read` | `:26-27` |
| job 名（= 检查名） | `development-docs` | `:29-30` |
| 实际执行 | `python3 --version` → `validate_development_docs.py` → `validate_contracts.py` → `test_contracts.py`（与 `engineering-shell.yml` 的 `docs` job 同三条命令，**不装 Node**） | `:36-39` |

⇒ 只改 `docs/**` 的 PR，**只会**命中 `development-docs`；七个工程 job 在 `engineering-shell.yml` 上**不带 `paths` 过滤**，所以文档 PR 也会触发它们。

### 1.3 `.github/workflows/local-wechat.yml`（本机准备）

| 项 | 值 | 位置 |
| --- | --- | --- |
| 触发 | `pull_request` 与 `push: main`，**均**限定 `paths`（`miniprogram/**`、`project*.json*`、`config/**`、`docs/ui-demo/**`、指定 tools/tests、`.gitignore`、本 workflow 自身） | `.github/workflows/local-wechat.yml:2-39` |
| 权限 | `contents: read` | `:40-41` |
| job 名（= 检查名） | `local-preparation` | `:43` |
| checkout | `fetch-depth: 0`，理由原文："界面检查需比对 origin/main 基线，浅克隆会使冻结契约检查被跳过" | `:46-50` |
| 实际执行 | `setup-node 24.16.0` →`npm ci` →`check-wechat-project.mjs` →`node --check tools/smoke-wechat.cjs`（**仅语法**）→ 四个 `node --test` →`demo-align.mjs` →`verify-layout.mjs` → 忽略规则双向断言 | `:51-64` |

⚠️ **路径过滤造成的"没有读数"不等于 PASS**：`docs/**` 改动**不**命中 1.3 的 `paths`，该检查**不会被触发**，因而不会有 success 结论；判读时按第 5 节处理，**不得**把"未触发"记成通过。

---

## 2 怎么读：本地可用的只读取数方式

以下命令**只读**。示例用 `<OWNER>/<REPO>` 与 `<SHA>` 占位，请按当前仓库与目标提交替换；**不要**把真实取值当成本页结论。

### 2.1 取某提交的全部检查运行（`gh`，推荐）

```bash
# 逐条列：检查名、状态、结论
gh api --paginate \
  "repos/<OWNER>/<REPO>/commits/<SHA>/check-runs?per_page=100" \
  --jq '.check_runs[] | [.name, .status, (.conclusion // "-"), .details_url] | @tsv'
```

⇒ `status=completed` 才是**已经结束**；`conclusion` 是判读字段（取值见第 5 节）。

### 2.2 取某 PR 的检查运行（`gh`）

```bash
# 把 PR head 的 SHA 换成目标提交
gh pr checks <PR号> --repo <OWNER>/<REPO>

# 只想要可机读的份额：
gh pr checks <PR号> --repo <OWNER>/<REPO> --json name,state,bucket,link
```

也可直接 `gh api "repos/<OWNER>/<REPO>/commits/<PR_HEAD_SHA>/check-runs"`（同 2.1）。

### 2.3 按 SHA 取工作流运行本身（Actions 运行，含尚未产出 check-run 的排队运行）

```bash
gh api --paginate \
  "repos/<OWNER>/<REPO>/actions/runs?head_sha=<SHA>&per_page=100" \
  --jq '.workflow_runs[] | [.name, .event, .status, (.conclusion // "-"), .html_url] | @tsv'
```

### 2.4 不用 `gh` 时（HTTP 只读接口）

```bash
curl -sS -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/<OWNER>/<REPO>/commits/<SHA>/check-runs?per_page=100"
# 私有仓库需自带只读令牌：-H "Authorization: Bearer $GH_TOKEN"（变量不落盘、不打印）
```

### 2.5 取证纪律

1. **只读**：以上全部是 `GET`。不 rerun、不 approve、不 dispatch、不改 workflow。
2. **不打印凭据**：`gh` 默认从系统凭据库取令牌；**不要** `echo $GH_TOKEN`、不要 `--show-token`、不要 `cat` 凭据文件。
3. **按仓库显式指定**：加 `--repo <OWNER>/<REPO>`，避免落到同名的其他远端或本机默认仓库。
4. **本地读取与 CI 读取是两回事**：本机 `node --version`／`npm run test:unit` 的输出**不是** CI 读数（见第 5 节第 1 条）。

---

## 3 判读：结论必须绑定 SHA 并写清"跑在哪个提交上"

1. **先记 SHA，再看结论**。README/设计文档里常见的写法是"某提交的检查已 success"——`success` 只对该 SHA 成立。记录形式建议：`<检查名> @ <完整 40 位 SHA> = <conclusion>`。
2. **把"检查名"与"结论"分开记**：检查名是稳定的（1.1–1.3 已列全），结论是易变的。
3. **区分 PR 读数与 `push: main` 读数**：`event` 字段给出触发方式（`pull_request` / `push`）；同一 workflow 在两者上的运行是不同运行。
4. **"未触发"要显式写成未触发**：路径过滤（1.2、1.3）会让某些检查根本不出现；这与 `failure`、与 `success` 都不同。
5. **结论不与"整项验收"挂钩**：本仓库口径中，CI 只覆盖 Node／Python 层的离线检查；真实 PG 结构行为、真机渲染、真实供应商各自另有门禁（第 5 节第 5 条）。

---

## 4 为什么 PR 上的读数不入仓库

本页只写方法，不收录任何一次运行的读数副本，原因：

1. **时效性**：读数绑定具体 SHA，**推送新提交即失效**（旧 SHA 的 success 不能描述新 HEAD）；把某次读数的 success 写进仓库，读者很容易把它误当成当前提交的结论。
2. **仓内引用会腐化**：写死运行链接/SHA 的文档，一旦所引 SHA 不是 `main` 的祖先（分支尖端经 squash 合并后即如此），引用就与实际主线脱钩；这类引用没有机器门禁能抓住（见第 6 节）。
3. **权威副本只有一个**：某提交/某 PR 的读数，**以该 PR 的 Checks 页或该 SHA 的 Actions 运行页为准**；仓库内只保留"如何取得"的方法（本页）。
4. **日志有保留期**：Actions 运行与日志会按平台保留策略过期，历史链接不保证长期可解析；需要长期留存的结论应在**当时**以文本形式记入对应证据文档，并**绑定 SHA**。

---

## 5 两条（及以上）诚实口径

1. **本机读数 ≠ `ubuntu-24.04` CI 读数。** 本仓库 CI 的 runner 固定为 `ubuntu-24.04`（1.1 各 job 的 `runs-on`），Node 版本由 workflow 固定为 `24.16.0`；本机是 Windows + 各自安装的 Node/npm/Python 版本。同一提交上，操作系统、依赖解析结果、环境变量、并行时序都不同 ⇒ **本机跑绿不能代替 CI 读数，CI 跑绿也不能代替真机/真实服务读数**。两者只能各自如实标注。
2. **推送新提交即失效。** 检查运行绑定 SHA，**结论必须绑定 SHA** 才有意义；`main` 前进后，旧 SHA 的 success 不再描述当前 `main`。引用读数时写清"跑在哪个 SHA 上"，并注明它是否为当前 `main` 的祖先。
3. **`conclusion` 取值必须逐字判读**，常见取值：

| `conclusion` | 判读 |
| --- | --- |
| `success` | 该 job **在该 SHA 上**通过。不推出其他 SHA、其他 job、其他工作流也通过 |
| `failure` | 失败，需读该 job 日志定位；不得写成"通过" |
| `cancelled` | 被取消，**不构成证据** |
| `skipped` | 被跳过，**不是通过** |
| `timed_out` / `action_required` / `neutral` / `stale` | 均**不得**记作通过 |
| `status` 非 `completed`（`queued`/`in_progress`） | **尚无结论**，稍后重取 |

4. **"没有运行"与"运行失败"要分开**：路径过滤（1.2、1.3）会让检查根本不产生；运行 ID 过期、分支被删、squash 合并使旧分支尖端不在 `main` 上，也都会让原链接失去可判读的对应关系。此时应写明"未取得"，**不要**用邻近提交的 success 顶替。
5. **工程七项检查不覆盖的范围**（不得用其 success 冒称）：
   - 微信开发者工具编译、真机渲染、基础库版本 —— 见 `engineering-shell.yml:6` 的边界声明；本机任务，不在该 CI。
   - 真实 PostgreSQL 结构/行为 —— 由独立的工作流承担（本仓库另有 5 个检查名以 `-postgres-17.11` 结尾的 job：`auth-privacy-postgres-17.11`／`catalog-postgres-17.11`／`consent-grant-postgres-17.11`／`source-lifecycle-postgres-17.11`／`staging-intake-postgres-17.11`，外加 `workbook-staging.yml` 的 `staging-pg17`）；`engineering-shell.yml` 的七项里**没有**起库步骤。
   - 真实供应商（AI/OCR/ASR/TTS 等）能力 —— CI 内一律禁用真实外部调用。
   - `a0cab31`/`857a683` 一类历史基线的读数 —— 只能各自现场取数，不互相顶替。

---

## 6 已知边界：链接腐化没有机器门禁

`npm run test:docs`（= `node tools/run-python.mjs tools/validate_development_docs.py`）**只校验仓库内的相对链接**：`tools/validate_development_docs.py:117-120` 对 Markdown 目标显式 `if "://" in target or target.startswith("#"): continue` 跳过，再对剩余目标做 `(path.parent / target).exists()` 存在性检查。

⇒ **指向 GitHub 的绝对链接（含 Actions 运行、PR、评论）不经过任何机器校验**；它们是否仍指向 `main` 的祖先、是否仍可解析，**只能靠人工复核**。因此：

- 仓内写引用时**优先用不会腐化的写法**（描述性引用、或指向仓库内稳定文档）；
- 确需写绝对链接时，**同时**写下该引用绑定的 SHA 是否在 `main` 上，便于后续人工复核。
