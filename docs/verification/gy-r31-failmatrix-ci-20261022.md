# GY-R31：`#22` 失败回归矩阵接入 CI（2026-10-22）

- 分支：`test/gy-r31-failmatrix-ci`，基线 `origin/main = d4d48088`（`d4d48088532377adb54c278b24ba90be42cb5aaf`）。
- 机器：Windows / node v24.16.0 / npm 11.13.0（CI 侧 `ubuntu-24.04` + node `24.16.0`，与本仓其它 19 处 `setup-node` 一致）。
- 本页所有读数都是**在本工作树里实跑**的原文，不是估算；每条都给了复现命令。
- ⚠ 本页包含一条对任务前提的**更正**（§1.2）：这套矩阵在 `d4d48088` 上**并非无人执行**，它此前是通过 `npm run test:unit` 间接跑的。见下。

## 0 交付物

| # | 文件:行 | 内容 |
| --- | --- | --- |
| 1 | `package.json:24` | 新增 `"test:failmatrix": "node tests/failmatrix/run.mjs"`（唯一改动；`git diff` 只有这一行） |
| 2 | `.github/workflows/failmatrix.yml:1-64` | 新增独立 workflow（`failmatrix` job），失败即红、上传机读产物 |
| 3 | `docs/verification/gy-r31-failmatrix-ci-20261022.md` | 本页 |

- 分支已推：`git ls-remote origin refs/heads/test/gy-r31-failmatrix-ci` → `fcb744a4046bb39c855dab13feac8db530c4d0fd  refs/heads/test/gy-r31-failmatrix-ci`。
- PR：[#467](https://github.com/GengYunChuChao/GengYun/pull/467)（`Refs #22`，不关闭整项）。首跑 `failmatrix` 检查名 **pass / 17 s**，产物 `failmatrix-8afe42f623b7…`（7240 bytes）可下载，见 §3.4。

⛔ 没有动：既有 13 个 workflow、`tests/failmatrix/run.mjs` 的任何断言、`docs/architecture/contract-status.json`、任何既有用例的 `expect`。

## 1 现状（改之前）

### 1.1 逐条事实

1. **`package.json` 无 `failmatrix` 脚本。** 改动后 `git diff --stat` 是 `1 file changed, 1 insertion(+)`，即改动前一个都没有。
2. **既有 13 个 workflow 无一处提到 `failmatrix`。** 复现：`Get-ChildItem .github\workflows -Filter *.yml | Select-String failmatrix` —— 改动前命中 0 个文件；改动后只命中新增的 `failmatrix.yml`（工作流文件数从 13 变 14）。
3. **实测用例 168 条**（HTTP 148 + 受信 seam 20），不是 230 条：`node tests/failmatrix/run.mjs --list` 末行原文是 `合计 168 条用例（HTTP 148 + seam 20）。`（分族 C1 37 / C2 24 / C3 27 / C4 18 / C5 10 / C6 10 / C7 16 / E1 3 / E2 3 / D1 11 / D2 4 / D3 2 / D4 3）。全文提到的「230」若指别的东西，本页不认领。

### 1.2 更正：「谁都不跑」不成立，但「没有自己的门禁」成立

`tests/unit/gy-i22-failmatrix.test.mjs`（随 `903ad629` 进入 main，是 `d4d48088` 的祖先）已经把整套矩阵包进了 `npm run test:unit`：它 `spawnSync` 跑一遍 `run.mjs --json=`，再断言全绿、条数不少于 `MIN_CASES`、每条都有真实读数、分族/分批次条数与基线一致。`engineering-shell.yml:46` 的 `unit-tests` job 在 `engineering-shell.yml:58` 跑 `npm run test:unit`。

所以准确说法是：

- **矩阵的绿是有人在看的**（`unit-tests` 会因为它红而红）；
- 但**它没有自己的名字、没有机读产物、不能单独重跑**：一条 failmatrix 失败会淹没在整包单测的 7 分钟里，而且 `unit-tests` 这一个 job 结论同时代表了上百条无关用例；分支保护只能勾到 `unit-tests`，勾不到「失败矩阵」。
- 也**没有一条命令能在本地直接跑它**（`npm run test:failmatrix` 此前不存在），写手/监工想单跑只能敲 `node tests/failmatrix/run.mjs` 或 `node --test tests/unit/gy-i22-failmatrix.test.mjs`。

复现（改动前也存在的能力）：

```
$ node --test tests/unit/gy-i22-failmatrix.test.mjs
✔ GY-I22 失败矩阵：全量真跑 159 条全绿，且每条都有真实读数 (1003.7347ms)
✔ GY-I22 失败矩阵：用例表自洽（id 唯一、族/批次闭合、expect 齐备） (0.6943ms)
✔ GY-I22 负控制清单与当前产品代码同步（每条 find 恰好命中一次） (5.163ms)
ℹ tests 3 / ℹ pass 3 / ℹ fail 0 / ℹ duration_ms 1737.0001
EXIT=0  ELAPSED_SEC=1.86
```

> 用例条数写「159」只是那个测试**标题**里的旧文案，实际断言的是 `MIN_CASES = 168` 条——标题没跟上加用例，不影响判定；本页不改它（改它就得动 `tests/unit/`，与本轮无关）。

**本轮补的正是这三件缺的事**：一个固定检查名（`failmatrix`）、一条命令（`npm run test:failmatrix`）、一份可下载的机读产物（`failmatrix-<sha>`），并且**不依赖** `test:unit` 是否被人盯着。

## 2 改法

### 2.1 `package.json:24`（只新增一个键）

```json
"test:failmatrix": "node tests/failmatrix/run.mjs",
```

放在 `test:evaluation` 与 `test:integration:http` 之间，与既有 `test:*` 排序一致；其余脚本一字未动。

### 2.2 `.github/workflows/failmatrix.yml`（新增 64 行）

关键行（行号对应当前文件）：

| 关心点 | 行 | 原文 |
| --- | --- | --- |
| 触发 | `:21-26` | `on:` / `pull_request: branches: [main]` / `push: branches: [main]` / `workflow_dispatch:` |
| 运行环境 | `:34` | `runs-on: ubuntu-24.04` |
| Node 版本 | `:42` | `node-version: '24.16.0'`（照抄既有 19 处） |
| 依赖安装 | `:44` | `npm ci --no-audit --no-fund`（与既有 job 同款） |
| 跑矩阵 | `:47` | `npm run test:failmatrix -- --json="$RUNNER_TEMP/failmatrix/matrix.json"` |
| 失败判定① | `:47` | 上面这步的退出码：`run.mjs:448` `return fail === 0 ? 0 : 1;` ⇒ 步骤红 ⇒ job 红 |
| 失败判定② | `:50-57` | 读机读产物二次判定：`t.fail!==0 \|\| t.pass!==t.total \|\| t.total===0` ⇒ `exit 1` |
| 产物上传 | `:58-64` | `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02`（v4.6.2，按 SHA 钉住）；`name: failmatrix-${{ github.sha }}`；`if: always()`；`retention-days: 14` |

- `permissions: contents: read`：不写、不评论、不推。
- **没有**任何 PG / 网络 / 密钥 / 微信开发者工具步骤：世界装配里的四个网络 seam **持有即抛错**，执行模式固定 `stub`。
- 与既有 workflow 的关系：互不依赖、不共享 job、不改它们；新文件不会与在飞 PR 抢同一个文件。

### 2.3 为什么另开一个 workflow 而不是并进 `engineering-shell.yml`

`engineering-shell.yml` 是 13 个 job 的大文件，正被多张在飞 PR 反复改；往里加 job 会抢同一个文件、冲掉别人的改动。另开一个小文件：零冲突面、检查名独立（`failmatrix`）、可以单独 `workflow_dispatch` 重跑一次。

## 3 读数（原文）

### 3.1 全量：`npm run test:failmatrix` ⇒ exit 0，168/168

```
$ npm run test:failmatrix
...
C1 游客面：没有凭据时一律 401 SESSION_REQU… 37 条：PASS 37 / FAIL 0
C2 越权（IDOR）：A 不得读写 B 的私有行；「不是你的… 24 条：PASS 24 / FAIL 0
C3 后台：用户会话 → 403 SCOPE_DENIED；后… 27 条：PASS 27 / FAIL 0
C4 会话与注销：注销/过期/旧 epoch/坏凭据的拒绝码；… 18 条：PASS 18 / FAIL 0
C5 媒体归属与媒体访问凭据：跨主体 404、缺 / 错 to… 10 条：PASS 10 / FAIL 0
C6 重复请求（Idempotency-Key）：同键同体重放… 10 条：PASS 10 / FAIL 0
C7 无效输入：坏 uuid / 坏游标 / 越界分页 / 多… 16 条：PASS 16 / FAIL 0
E1 提示注入：内容里的指令只作数据，命中 PROMPT_IN… 3 条：PASS 3 / FAIL 0
E2 媒体访问凭据：篡改/越权的 token 一律 404（与… 3 条：PASS 3 / FAIL 0
D1 审核回调（重复/旧版本/下架/授权撤回 ⇒ 拒绝；回调绝… 11 条：PASS 11 / FAIL 0
D2 AI 失败/超时/结构错误/规则未过 ⇒ 一律不得发布… 4 条：PASS 4 / FAIL 0
D3 下架 ⇒ 读缓存失效 + 可见性转 hidden… 2 条：PASS 2 / FAIL 0
D4 版本回写：内容改版后旧审核结论不得复用，历史版本不得发布… 3 条：PASS 3 / FAIL 0
B1 批次 1：身份与权限面（游客 / 越权 / 后台 / 会话与注销）：106 条，FAIL 0
B2 批次 2：媒体归属、重复请求与无效输入：36 条，FAIL 0
B3 批次 3：审核回调 / AI 失败 / 下架缓存（受信 seam）：17 条，FAIL 0
B4 批次 4：版本回写、提示注入与媒体访问凭据：9 条，FAIL 0
矩阵合计 168 条：PASS 168 / FAIL 0
机读结果：tests/failmatrix/.artifacts/matrix.json

EXIT=0  ELAPSED_SEC=1.13
```

机读交叉核对（`--json` 产物）：`totals: total=168 pass=168 fail=0`、`transport=app.inject+trusted-seam`、`execution_mode=stub`，13 个族逐族 `fail=0`。

### 3.2 连跑 3 次：无 flaky

```
$ npm run test:failmatrix -- --json=...   # 连跑三次
RUN1 EXIT=0 WALL_SEC=5.78 :: 矩阵合计 168 条：PASS 168 / FAIL 0
RUN2 EXIT=0 WALL_SEC=5.31 :: 矩阵合计 168 条：PASS 168 / FAIL 0
RUN3 EXIT=0 WALL_SEC=5.72 :: 矩阵合计 168 条：PASS 168 / FAIL 0
```

三次都是 168/168、三次 exit 0、无一条用例在三次之间翻面。（世界是内存 store + 固定 `now`，本身不带时间/网络抖动源。）

### 3.3 非空证明：门禁真的会红

把 `cases.mjs:52` 里 `C1-01` 的 `expect: { status: 401, ... }` 临时改成 `status: 999`（expect 自身不改判定逻辑，故意让它对不上真实读数 401）：

```
  FAIL C1-01  GET    /api/v1/favorites → 401 SESSION_REQUIRED · cache=no-store etag=- · 游客读收藏列表
       ✗ status 期望 999 实际 401
  PASS C1-02  POST   /api/v1/favorites → 401 SESSION_REQUIRED · cache=no-store etag=- · 游客写收藏
...
矩阵合计 168 条：PASS 167 / FAIL 1

NEG_EXIT=1
```

**它点名了用例 id（`C1-01`）、给了期望/实际两侧读数、并且 exit 1** —— 这就是「门禁不是空转」的证据。

复原（逐字节还原，前后 SHA256 相同）：`cases.mjs` SHA256 改动前 `9C6C92DDD0CC438BF0FA0A000AE9BA72788617AB6AF9ECD2165BD5181DE1245D`，复原后同一值 ⇒ `MATCH=True`。复原后再跑：

```
$ npm run test:failmatrix
矩阵合计 168 条：PASS 168 / FAIL 0
RESTORED_EXIT=0  ELAPSED_SEC=5.79
```

`git status --porcelain` 此刻为空 ⇒ 仓库里没有残留改动。

### 3.4 耗时与 CI 预算

| 测法 | 读数 |
| --- | --- |
| runner 本身（`node tests/failmatrix/run.mjs`，5 次） | 0.998 / 1.157 s，中位 **1.045 s** |
| **单条用例**（中位 1.045s ÷ 168 条） | **≈ 6.2 ms** |
| `npm run test:failmatrix` 端到端（含 npm 启动，3 次） | 5.31 / 5.72 / 5.78 s |
| 单测包装（`node --test tests/unit/gy-i22-failmatrix.test.mjs`） | 1.86 s（其中矩阵 1.00 s） |
| **真 CI**：GitHub Actions 的 `failmatrix` job（PR #467） | **17 s**（整 job：checkout+setup 8 s、`npm ci` 1 s、矩阵 1 s、二次判定+上传 1 s） |
| CI 预算 | **≤ 240 s** |

- 结论：**未超预算**。真 CI 整 job **17 s**，占 240 s 预算的 **7.1%**；矩阵本身的步骤只占 1 s。
- 这一点在提交后已被真 CI 证实（不是本地估算）：

```
# PR #467 · workflow run 39731131047 · job failmatrix ⇒ pass / 17s
Run npm ci --no-audit --no-fund
  added 103 packages in 1s
Run npm run test:failmatrix -- --json="$RUNNER_TEMP/failmatrix/matrix.json"
  矩阵合计 168 条：PASS 168 / FAIL 0
  机读结果：/home/runner/work/_temp/failmatrix/matrix.json
机读结果必须 PASS == 总数、FAIL == 0
  矩阵 168 条：PASS 168 / FAIL 0 · 基线 8afe42f623b7 · app.inject+trusted-seam

# 产物：failmatrix-8afe42f623b77f81364de7d61a38351c88bb35c6（7240 bytes，未过期）
```

> 上面的「基线 `8afe42f623b7`」是 GitHub 给 PR 造的合成 merge 提交（我的分支 merge 进 main 后的树），说明矩阵在「合过 main 之后」也是绿的。产物名里的 SHA 同为此合成提交——这是 `${{ github.sha }}` 的固有语义，不是写错。
- 因此**不需要** `--only=` 分批。若将来用例涨到现在的 20 倍（约 3400 条）才可能逼近预算，届时可按族拆成 `--only=C*` / `--only=D*,E*` 两个 job —— 但**任何拆法都必须整族跑全**，且总条数仍由单测里的 `MIN_CASES` 兜底，⛔ 不靠删用例换时间。

### 3.5 两处既有门禁复查

```
$ node tools/verify-contract-status.mjs
PASS: 覆盖 113 条契约操作；已装配 109 条；implemented 13 / partial 96 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
...
VERIFY_CONTRACT_STATUS_EXIT=0

$ npm run test:docs
PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住
TEST_DOCS_EXIT=0

$ node --test tests/unit/gy-i22-failmatrix.test.mjs
ℹ tests 3 / pass 3 / fail 0        EXIT=0
```

## 4 失败判定的三层（为什么它真的会红）

1. **退出码**：`run.mjs:448` `return fail === 0 ? 0 : 1;` —— 任意一条 FAIL ⇒ 步骤退出 1 ⇒ job 红。实测见 §3.3。
2. **机读二次判定**：workflow `:50-57` 读 `--json` 产物，`fail!==0 || pass!==total || total===0` 就 `exit 1`。这层挡的是「将来有人把 runner 改成『打完成绩也退 0』」和「产物被清空却显示 0 条」。本地验证：好产物 `GOOD_EXIT=0`；把 `fail` 改成 1 的产物 `BAD_EXIT=1` 且日志打印 `矩阵有失败或被清空：FAIL 1 / 合计 168`。
3. **条数不缩水**：`tests/unit/gy-i22-failmatrix.test.mjs` 仍在 `test:unit` 里，`MIN_CASES = 168` 与分族/分批次计数会挡「悄悄删用例」。

## 5 未覆盖（本页不宣称的部分）

| 缺口 | 为什么没覆盖 | 谁来覆盖 |
| --- | --- | --- |
| **传输层**：反向代理、TLS、body 上限、真实超时、keep-alive、HTTP/2 | `app.inject` 直接进 app，绕开真实 HTTP 栈与 socket | `test:integration:http` 那类真起端口的用例 |
| **真实供应商**：AI 审核外呼、对象存储签名、微信/短信 | 世界固定 `execution_mode=stub`，四个网络 seam 持有即抛错；真实外呼仍「未取得」 | 需真实账号/额度，见 `docs/verification/` 各实时证据页 |
| **真机与微信端到端**（#4 / #23 / #28） | 无可执行真机 | 真机验收 |
| **PG**：唯一约束、事务、死锁、真驱动行为 | 世界用内存 store | `real-pg-integration` 等 5 个 postgres workflow |
| **跨进程并发**：多实例抢同一幂等键、崩溃重启后重放 | 并发用例是单进程内两请求 | 未覆盖 |
| **真实时钟**：过期/租约/±5min 签名窗口 | 世界注入固定 `now` | 未覆盖（不能靠真等） |
| **账号停用真实生效**（`users.state !== 'active'`） | stub 世界不可达，`C3-22` 只是 fail-closed 503 读数 | 需真实账号写权威 |

一句话：这套门禁保证的是**「拒绝语义不变」**（状态码、错误码、封套、不泄露存在性、不让旧结论复用），不保证**「真实链路可用」**。

## 6 维护方式

### 6.1 新增一条 HTTP 用例

1. 写进 `tests/failmatrix/cases.mjs` 的 `CASES` 数组：`{ id, family, title, method, path, headers?, body?, expect: { status, code?, etag?, ... }, check? }`。`path` 可以是函数（依赖世界装配）。
2. 期望值必须是**实跑读数**，行尾注释写清日期与执行模式（沿用现有风格）。
3. 族必须已登记在 `FAMILIES`，**并且**被某个 `BATCHES[].families` 收口；否则 `test:unit` 的「用例表自洽」会红。
4. 同步改 `tests/unit/gy-i22-failmatrix.test.mjs` 的 `MIN_CASES`（`:28`）、`FAMILY_COUNTS`（`:30`）、`BATCH_COUNTS`（`:32`）。**不改就红**——这是防止用例被悄悄删的机制；⛔ 只准往上调。

### 6.2 新增一条 seam 用例（回调 / AI 失败 / 下架 / 版本回写）

写进 `tests/failmatrix/seams.mjs` 的 `SEAM_CASES`：`{ id: 'D<族>-NN', family, title, invoke, expect: { code }, check? }`，族登记到 `SEAM_FAMILIES`，同样要在 `BATCHES` 里收口，同样更新单测计数。

### 6.3 新增一条负控制（证明断言不是空转）

写进 `tests/failmatrix/mutations.mjs`：`{ id: 'NC-NN', file, find, replace, watch: [用例 id...] }`。

- `find` 必须在目标文件里**恰好命中 1 次**（`test:unit` 会数；命中 0 次或 2 次都红 = 守卫被重构了，负控制已失效）；
- `find !== replace`；
- `watch` 里的用例必须真实存在。负控制的含义是「把这条守卫改坏，`watch` 里的用例必须红」——本地验证一次性改坏时用 `--only=` 缩小范围即可。

### 6.4 `--only` / `--list` / `--json` 怎么用

```
node tests/failmatrix/run.mjs --list                  # 列出全部用例 + 总数（现为 168）
node tests/failmatrix/run.mjs --only=C1                # 整个 C1 族（37 条）
node tests/failmatrix/run.mjs --only=C1,C2-01,D3       # 族名或用例 id，前缀匹配
npm run test:failmatrix -- --only=C5                   # 经 npm 传参（注意  --  分隔符）
node tests/failmatrix/run.mjs --json=out.json          # 另存机读结果
```

未知参数直接报错（`run.mjs:58` 的注释：避免「以为筛了，其实没筛」）。

**门禁里永远跑全量**：`failmatrix.yml:47` 不带 `--only`。`--only` 只用于本地定位与调试，或将来真的超预算时按整族拆分。

### 6.5 维护这套门禁时要盯的三件事

1. 改了任何**拒绝路径**（中间件、错误码、`no-store`、封套字段）⇒ 先跑 `npm run test:failmatrix`，红了多半是语义变了，不是用例过时。
2. 新增「应当拒绝」的接口 ⇒ 必须同时给**同形对照**（「不存在」与「不是你的」返回一致），否则等于给 404 加了可枚举的信号。
3. 改 `cases.mjs`/`seams.mjs` 的族结构 ⇒ 记得同步 `FAMILIES`、`SEAM_FAMILIES`、`BATCHES` 与单测里的三处计数。
