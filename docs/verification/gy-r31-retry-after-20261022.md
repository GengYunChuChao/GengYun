# 429 补 `Retry-After` 与 main 的冲突收口验证记录（GY-R31 / Refs #22）

- 分支：`feat/gy-r31-retry-after`；工作树 `E:\GengYunCommander\wt-r31-retry-after`；基线 `origin/main` = `489804e4`；本片开工时的分支 HEAD = `1042ae5a`（PR #450）。
- 范围：只做**与 main 的冲突收口 + 读数**。不改实现语义（`errors.ts` / `app.ts` 的实现部分一行未动）、不改任何契约文件、不删 #442 已合入 main 的任何用例。
- 合并方式：`git merge origin/main`（不 rebase、不强推），冲突解落后以 merge commit 提交。

## 1. 冲突面：GitHub 显示可合，真 `git merge` 红在一个文件

PR #450 在 GitHub 上显示 `MERGEABLE`，但那是相对它声明的 **stacked base** `feat/gy-r31-i22-rate-timeout` 算出来的，不是相对 `main`。#442 已经 squash 合入 main（`c6c124e9`），于是 main 上有同名文件、分支上又从 #442 的 pre-merge 状态新建了同一路径 —— add/add。真合并读数：

```
$ git merge origin/main
Auto-merging services/api/src/app.ts
Auto-merging tests/unit/gy-i22-rate-and-timeout.test.mjs
CONFLICT (add/add): Merge conflict in tests/unit/gy-i22-rate-and-timeout.test.mjs
Automatic merge failed; fix conflicts and then commit the result.
$ git diff --name-only --diff-filter=U
tests/unit/gy-i22-rate-and-timeout.test.mjs
```

- 冲突文件**只有 1 个**：`tests/unit/gy-i22-rate-and-timeout.test.mjs`（add/add）。
- `services/api/src/app.ts` 自动合并成功（main 在本片改点之外另有 8 处改动，没与本片的 import / 错误出口撞在同一行）。
- `services/api/src/errors.ts`：main 自 merge-base `d4d48088` 以来未改动该文件，无冲突。

## 2. 解法：同名文件只留一份，以 main（#442）版为底搬入 #450 真正新增的用例

| 版本 | 行数 | 字节 |
| --- | --- | --- |
| `origin/main` 上 #442 版 | 267 | 16030 |
| `origin/feat/gy-r31-retry-after` 分支版 | 346 | 21159 |
| 合并解（仓内唯一一份） | 346 | 21159 |

判定依据：分支版是 main 版的**严格超集**，不是「各留一半」。`git diff --numstat origin/main -- tests/unit/gy-i22-rate-and-timeout.test.mjs` = `89	10`，逐块只有 3 处：

1. **头部「本片不验证」条目改写**：原文写「实现不写该头、本文件如实断言当前无该头」，改成「该头已按 `state-contract.md:27` 补齐；能测的是头存在/合法整数秒/非 HTTP-date，不能测真实退避窗口是否够用」。只改注释，不动用例。
2. **429 用例里那条「无该头」断言翻面**：`assert.equal(first.headers['retry-after'], undefined, …)` → 断言存在 + `/^[1-9][0-9]*$/` + `≥1`。这是 **#22 唯一的钥匙**：只有这一支断言能被本片翻过来，删掉它等于把口径缺口重新钉回「现状」。
3. **新增 1 个用例**：`409：媒体域同键并发 ⇒ REQUEST_IN_PROGRESS 带 Retry-After: 1`。用「悬停的对象存储预签」确定性制造同键并发，钉住 `media/service.ts:778` 注释所称的头，并核对占位释放后 201 回放**不带**该头。

**没有删除 main 上任何用例**：429 封套键集/上游 errmsg 不回显/失败不落幂等台账、504 的 `57014` 与 `55P03` 两支，原样保留、断言未改。合并解与分支版逐字节相同（`resolved === branch` 为真），也就是「main 版 + 上述 3 处新增」，不存在第二个同名文件。

两侧语义都留：`app.ts` 自动合并后仍是 main 的版本 + 本片的两行改动 —— `:28` import `retryAfterSecondsFor`，错误出口改调该函数写整数秒头；`errors.ts` 的 `retryAfterSecondsFor`（409 与 429 给确定性 1 秒，其余含 503/504 返回 `null`）原样保留。

## 3. 非空证明：改前用 main 版跑必红，改后全绿

同一份实现（本分支的 429 实现），只换测试文件：

| 步骤 | 测试文件 | 命令 | tests | pass | fail |
| --- | --- | --- | --- | --- | --- |
| ① 分支原状（未合 main） | 分支版 346 行 | `node --test tests/unit/gy-i22-rate-and-timeout.test.mjs` | 4 | 4 | 0 |
| ② **改前**：main（#442）版 267 行 | `git checkout origin/main -- <该文件>` 后跑同一命令 | 同上 | 3 | 2 | **1** |
| ③ **改后**：合并解 | 本页提交的版本 | 同上 | 4 | 4 | 0 |

②「旧断言把无头当现状 ⇒ 改后红」的原文：

```
✖ 429：上游 45011 ⇒ HTTP 429 RATE_LIMITED（封套完整 / 无 Retry-After / 失败不落幂等台账）
  AssertionError [ERR_ASSERTION]: 口径缺口：429 当前不带 Retry-After（state-contract.md:27 有要求，实现未接）
  '1' !== undefined
      at tests\unit\gy-i22-rate-and-timeout.test.mjs:135:10
```

`actual: '1'` 就是补上的头，`expected: undefined` 是 main 版钉的现状 ⇒ 旧断言与修好的实现**不可共存**，本片不可能只保留 main 版。②只有 3 个用例，因为第 4 个（409）用例本来就是 #450 新增的。

③ 逐条（全 ✔，fail 0）：

```
✔ 429：上游 45011 ⇒ HTTP 429 RATE_LIMITED（封套完整 / 带 Retry-After 整数秒 / 失败不落幂等台账）
✔ 504：同步读面在 57014 下折叠为 PROVIDER_TIMEOUT（故障点：资料读语句（catalog_read.current_knowledge））
✔ 504：同步读面在 55P03 下折叠为 PROVIDER_TIMEOUT（故障点：会话守卫语句（public.users））
✔ 409：媒体域同键并发 ⇒ REQUEST_IN_PROGRESS 带 Retry-After: 1（钉住 media/service.ts:778 注释）
ℹ tests 4  ℹ pass 4  ℹ fail 0  ℹ skipped 0
```

同一批改动触达的另一支定向用例：`node --test tests/unit/idempotency-retry-after-http.test.mjs` → tests 2 / pass 2 / fail 0（429 的两个错误码在统一出口矩阵里期望 `'1'`，其余错误码仍断言无该头）。

## 4. 全量单测读数

```
$ $env:GY_BASH='D:\Git\bin\bash.exe'; npm run test:unit
ℹ tests 3765
ℹ suites 0
ℹ pass 3762
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 2
ℹ duration_ms 376643.7168
exit 0
```

- 唯一 skip：`native separate-connection withdrawal and account state changes at guarded read boundary`（需原生依赖，既有 skip，与本片无关）。
- 输出末尾 `failing tests:` 段里列出的 2 条是 `tests/unit/i11-audio-mp3-wav-guard.test.mjs` 的 **todo**（#472 故意登记「MP3→WAV 未修」缺口），计入 `todo` 不计 `fail`，`exit 0`；本片未触碰这两条。
- `GY_BASH` 必须指向真 bash（本机 `D:\Git\bin\bash.exe`），否则 `deploy/postgres-cvm/*.sh` 的 `bash -n` 会因 WSL 存根假红（开发指南 §6）。

## 5. 契约台账

```
$ node tools/verify-contract-status.mjs
PASS: 覆盖 113 条契约操作；已装配 109 条；implemented 13 / partial 96 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
PASS: 证据锚点 412 条引用自带锚点（区间内 240 条 + 仅整文件 172 条）；无锚点不可核 0 条
PASS: 中文表格一致
exit 0

$ node tools/verify-contract-status.mjs --reanchor
REANCHOR: 无可重定位项（带锚点且带行号的引用 240 条，锚点都在 ±2 行容差内）
exit 0
```

合并把 `app.ts` 的写头代码从 `:1833` 一带下移到 `:1869` 一带（main 的 41 行新增在前），但台账里**没有**引用这些行的锚点，所以既没有锚点漂移、也不需要 `--write-doc` / `--reanchor` 落盘：本页没有手工改过任何行号，`docs/architecture/contract-status.json` 与中文对照表在本片一字节未动。

## 6. 未取得项（如实标注，不当成已验）

- **真机 429 触发**：未在真机/真微信环境触发上游 `errcode 45011`。用例用可注入的 `fetchImpl` 在「上游响应」这一层模拟，所以「连打至限流」这一环是模拟的，不是真实限流；能实测的是「我方收到 45011 之后的对外行为」。
- **真实上游限流**：微信侧的频率判定策略、真实退避窗口是否够用，均未验证。`Retry-After: 1` 是**确定性常量**（本仓没有本地限流器，唯一 429 来源是上游错误码映射，上游不给剩余窗口），不是实测窗口；取 1 是因为 openapi 该头 `minimum: 1`。
- **生产链路是否透传该头**：网关/边缘代理是否会改写或吞掉 `Retry-After`，未验证。
- **504 的 `retryable` 取值差异**（`knowledge/service.ts` 用 `ApiError` 缺省 `false`，与「瞬时故障应 true」不一致）：本片只断它是布尔，未改实现。
- **PR 元数据**：本片不合并、不 approve、不推 main、不强推；亦未改 PR #450 的 base（仍指向 stacked 的 `feat/gy-r31-i22-rate-timeout`，#442 已 squash 合入），是否改指 main 由指挥裁定。

## 7. 复现命令

```powershell
git fetch origin
git worktree add E:\GengYunCommander\wt-r31-retry-after feat/gy-r31-retry-after
npm ci --prefer-offline --no-audit --no-fund --ignore-scripts

# 改前（main 版测试 + 本分支实现 ⇒ 必红）
git checkout origin/main -- tests/unit/gy-i22-rate-and-timeout.test.mjs
node --test tests/unit/gy-i22-rate-and-timeout.test.mjs      # tests 3 / pass 2 / fail 1

# 冲突收口
git merge origin/main                                        # 唯一冲突：tests/unit/gy-i22-rate-and-timeout.test.mjs
# 解：保留一份（= main 版 + 上述 3 处），git add 后提交
node --test tests/unit/gy-i22-rate-and-timeout.test.mjs      # tests 4 / pass 4 / fail 0

$env:GY_BASH='D:\Git\bin\bash.exe'; npm run test:unit        # 3765/3762/0/1/2，exit 0
node tools/verify-contract-status.mjs                        # exit 0
```
