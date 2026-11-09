# 本机演示栈：四条命令（2026-11-09）

> 写给**不写代码、但要在这台 Windows 上把演示跑起来**的人。
> 一次准备约 10 分钟；之后每次「起来 → 看三行 → 收工」不到 1 分钟。
> 全部工具只有一个文件 `tools/demo-stack.mjs`，不需要装任何新东西；数据库与日志都落在仓库外，不会污染仓库。

## 0 四条命令长什么样

| 你想干什么 | 敲什么 | 正常时最后会看到 |
| --- | --- | --- |
| 拉起来 | `node tools/demo-stack.mjs up --mode real --port 38110 --pg-port 55510 --env-file <你的env文件>` | `✓ /health → 200 ok（database=ok, mode=real）` 和一段「下一步」 |
| 看一眼 | `node tools/demo-stack.mjs status --port 38110 --pg-port 55510` | 三行：`进程：` / `端口：` / `健康：` |
| 出问题看日志 | `node tools/demo-stack.mjs logs --lines 50` | 两段日志尾巴：API 与 PG |
| 收工 | `node tools/demo-stack.mjs down --port 38110 --pg-port 55510` | `复核：API 端口 38110 已释放；PG 端口 55510 已释放` |

`down` **不删数据**。下次 `up` 直接复用，几秒就好。真要清空重来，见 §7 的 `reset`。

## 1 开工前检查表（只做一次）

先在这个目录打开 PowerShell（下面所有命令都在仓库根执行）：

```powershell
cd E:\GengYunCommander\.pg17\wt-demo-stack
```

然后逐条确认：

| 项 | 怎么确认 | 期望 | 不对怎么办 |
| --- | --- | --- | --- |
| Node 24 | `node -v` | `v24.16.0` 或更高、且低于 `v25` | 找管理员装 Node 24 |
| PostgreSQL 17 的程序目录 | `Get-ChildItem E:\GengYunCommander\.pg17\pgsql\bin\pg_ctl.exe` | 有这一个文件 | 换路径时后面加 `--pg-bin <目录>` |
| 两个空端口 | `Get-NetTCPConnection -LocalPort 38110,55510 -ErrorAction SilentlyContinue` | **没有任何输出** | 有输出就说明被占用，见 §4 第 1 条 |
| 一个 env 文件 | 见 §2 | 6 个键 | 让管理员按 §2 生成一次 |

两个端口的约定：**38110 给接口，55510 给数据库**。这套演示专用，别改成 3000 / 5432——那是别的工具和别的库的地盘，撞上了排查起来很费时间。

## 2 一次性：准备 env 文件（管理员做，约 3 分钟）

`real` 模式要 6 个**真实**凭据：微信 2 项（AppID / AppSecret）+ 对象存储 4 项（地址 / 桶 / AccessKey / SecretKey）。工具**不生成、不猜、不打印**它们。

### 2.1 先空跑一次，让它把缺的键名和模板打给你

```powershell
node tools/demo-stack.mjs up --mode real --port 38110 --pg-port 55510
```

它会以 `exit 1` 结束（这不是故障，是提示），并打印类似：

```text
✗ real 模式缺 env 项：WECHAT_APP_ID, WECHAT_APP_SECRET, OBJECT_STORAGE_ENDPOINT, …
  这些键必须来自真实凭据（微信 2 项 + 对象存储 4 项），本工具不生成、不猜测：
   - WECHAT_APP_ID
   - WECHAT_APP_SECRET
   …
  做法：把这些键写进一个不提交的 env 文件，再 `--env-file <path>` 重跑。模板：
    # 演示栈 env 文件（不要提交；值从 E:\GengYunPrivate\credentials.local.json 取）
    WECHAT_APP_ID=...
    …
```

### 2.2 从私密凭据文件生成（复制这段，一次跑完）

凭据放在仓库外的 `E:\GengYunPrivate\credentials.local.json`（**JSONC，注释是 GBK 编码**，所以必须先按 GBK 读，不能直接 `Get-Content`）。下面这段只写文件、**屏幕上不出现任何密钥值**：

```powershell
$src = 'E:\GengYunPrivate\credentials.local.json'
$dst = 'E:\GengYunPrivate\demo-real.env'          # 仓库外，不会被提交
$raw = [System.IO.File]::ReadAllText($src, [System.Text.Encoding]::GetEncoding(936))
$get = { param($k) if ($raw -match ('"' + $k + '"\s*:\s*"([^"]*)"')) { $matches[1] } else { throw "缺少 $k" } }
$map = [ordered]@{
  WECHAT_APP_ID             = 'appid'
  WECHAT_APP_SECRET         = 'appsecret'
  OBJECT_STORAGE_ENDPOINT   = 'objectStorageEndpoint'
  OBJECT_STORAGE_BUCKET     = 'objectStorageBucket'
  OBJECT_STORAGE_ACCESS_KEY = 'objectStorageAccessKey'
  OBJECT_STORAGE_SECRET_KEY = 'objectStorageSecretKey'
}
$lines = foreach ($k in $map.Keys) { "$k=$(& $get $map[$k])" }
[System.IO.File]::WriteAllLines($dst, $lines, (New-Object System.Text.UTF8Encoding($false)))
"已写入 $dst（$($lines.Count) 项；值不打印）"
```

期望输出：`已写入 E:\GengYunPrivate\demo-real.env（6 项；值不打印）`。

- 不要 `git add` 这个文件，不要贴到聊天/工单里。工具自己只会打印**键名和来源**（`WECHAT_APP_ID ← env 文件`），不会打印值。
- `OBJECT_STORAGE_ENDPOINT` 必须是 `https://` 开头；写成 `http://` 会在启动时被 API 直接拒绝（§4 第 3 条）。
- `SESSION_SIGNING_KEY` / `DELETION_LEDGER_KEY` 这两把本地签名钥匙**不用写**：工具会生成，保存在 `…\.pg17\demo-stack\secrets.env`，重启复用（会话不会因为重启失效）。
- 用记事本改过 env 文件也没关系：带 BOM 的 UTF-8 也能读（第一个键不会被吃掉）。

## 3 起来：`up`

```powershell
node tools/demo-stack.mjs up --mode real --port 38110 --pg-port 55510 --env-file E:\GengYunPrivate\demo-real.env
```

要开演示档就再加 `--demo`（见 §3.1）。

它按九步走，每一步都会说自己在干什么：

| 步骤 | 你会看到 | 这一步实际做了什么 |
| --- | --- | --- |
| `[1/9] 参数与状态目录` | 模式、两个地址、状态目录 | 只是打印，不动东西 |
| `[2/9] 端口探测` | `API 38110：空闲` `PG 55510：空闲` | 被占了会直接停（§4 第 1 条） |
| `[3/9] 检查 env 与凭据` | 每个键一行 `← env 文件` / `← 本工具生成` / `← state-dir 复用` | 缺键就停；不打印值 |
| `[4/9] 检查 PostgreSQL` | `PostgreSQL 17.11：…` | 找不到 `pg_ctl` 会停 |
| `[5/9] 数据目录与 initdb` | 第一次 `✓ 新建簇`，之后 `✓ 已有簇，复用` | 只在第一次初始化 |
| `[6/9] 启动 PG 簇` | `✓ 已启动（日志 …\pg.log）` | 只监听 127.0.0.1 |
| `[7/9] 建库与迁移` | `✓ 数据库 gengyun 已存在` / `✓ 迁移完成（应用 N 个）` | 建库 + 跑迁移 |
| `[8/9] 种子数据` | `✓ seed_reference.sql` / `✓ 已导入过…跳过`；带 `--demo` 时还会看到 `[8/9] 演示开关：已开启 …` | real 模式灌演示资料；`--demo` 另外把三个开关置为开启 |
| `[9/9] 启动 API` | `已启动：pid …` → `✓ /health → 200 ok（database=ok, mode=real）` | 后台起 API，轮询健康检查 |

成功的判据是**最后这几行**（原文摘自一次真跑）：

```text
[9/9] 启动 API
  已启动：pid 26316（日志 E:\GengYunCommander\.pg17\demo-stack\api.log）
  等 /health 变 200（上限 90000ms）
  ✓ /health → 200 ok（database=ok, mode=real）（1949ms，探测 4 次）

演示栈已就绪：API http://127.0.0.1:38110（real），PG 127.0.0.1:55510
```

耗时参考（同一台机器实测）：**冷启**（第一次 initdb + 迁移 56 个 + 两个种子）约 14 秒；**热启**（已有数据）约 3.5 秒；已经起着的再敲一次 `up` 约 5 秒，会识别「是本工具上一次起的实例」而不重复启动（若这次要求的批准项与既有实例不一致，会在收敛步骤之后重启 API，见 §3.2）。

退出码就是"哪一步没过"：

| 退出码 | 含义 | 先看哪 |
| --- | --- | --- |
| 0 | 成功 | — |
| 1 | 参数写错 / env 缺项 | 屏幕上点名的参数或键 |
| 2 | 端口被占用 | §4 第 1 条 |
| 3 | PostgreSQL 相关（找不到、起不来） | `logs` 里的 PG 段 |
| 4 | 迁移失败 | 屏幕上的 psql 报错原文 |
| 5 | 种子失败 | 屏幕上的最后 15 行 |
| 6 | API 启动即退出 | 自动打印的 API 日志尾 30 行 |
| 7 | 健康检查超时（进程还活着但没 200） | 自动打印的 API 日志尾 30 行 |
| 8 | 演示档写入失败（`--demo`：开关或演示政策） | 屏幕上的 psql 报错原文；确认迁移已完成 |

### 3.1 演示档 `--demo` 做什么、不做什么

`--demo` 是给**本机演示**用的一次性便利开关。它在迁移完成、种子处理完之后做这几件事：

1. 用**一次** `psql -c` 把 `public.feature_flags` 的三行更新成演示档：
   - `enabled = true`
   - `revision = revision + 1`
   - `reason = 'demo-stack local demo profile (non-production)'`
   - `changed_at = now()`
2. 再用**一次** `psql -c`（单条 simple query ⇒ 整组原子）幂等写入**本机演示政策**：
   - `public.admin_accounts` 一条不可登录的演示复核账号（`login_name='demo-stack-operator'`，
     `credential_hash` 是字面量占位、永不参与登录）；
   - `public.recipients` 一条演示接收方 `demo-stack-weed-vision`（`capability='weed'`，
     `policy_version='demo-stack-local-2'`，`config_version='demo-stack-config-1'`，两个 `*_verified=true`，
     留存 0/0，`enabled=true`），指向识别供应商端点域名 `tokenhub.tencentmaas.com`；
   - `public.consent_policies` 两条 `verified` 政策：`media_processing` 与 `external_inference`
     **都绑定**上面那条接收方，版本同为 `demo-stack-local-2`，都启用。
     两条都绑不是多余：外发预留（`services/api/src/privacy/ledger-pg.ts`）要求**每一个**必需用途的
     授权记录里都列出同一个接收方，而识别动线同时要这两个用途；只绑 `external_inference`
     会在 `POST /recognitions` 以 403「用途 media_processing 未绑定接收方」拒绝。
   - 版本号变化时先停用自家旧版本（`policy_version LIKE 'demo-stack-local-%' AND <> 当前版本`）；
     政策行一旦复核就不可改（`consent_policy_immutable`），换形状只能发新版本。
   - 标记逐字落在既有可见列（这两张表**没有** `note` 列）：政策的 `source_ref` / `review_evidence_ref`
     与接收方的 `display_name` 都含 `demo-stack local demo profile (non-production)`；可用
     `SELECT … WHERE source_ref LIKE '%demo-stack local demo profile (non-production)%'` 反查。
   - 屏幕上会显式打印 `！这是本机演示政策，不是生产核验：…`。
3. `--demo` 还会让 API 带上 `--approve-real-media-wiring`（媒体域真实接线的**唯一**铸造点，
   `services/api/src/server.ts`）：不带它，`POST /media/uploads` 会 503 `PROVIDER_UNAVAILABLE`。
   同一开关要求取图原点可部署，所以演示档在 `MEDIA_ACCESS_GRANT_ORIGIN` 缺失时兜底
   `https://127.0.0.1:<--port>`（只为过启动校验；本机 API 是 http，句柄不可直接打开）。
   不带 `--demo` 时不传这个批准参数、也不兜底任何原点。
4. env 文件里「域内必填、启动不必填」的键（`MEDIA_OBJECT_REF_KEY`、`RECOGNITION_PROVIDER_URL/KEY/PROFILE/MODEL`、
   `MEDIA_ACCESS_GRANT_ORIGIN`、`CHAT_LLM_*` 等）**给了就透传给 API**，没给不算缺——缺了 API 照样起得来，
   只是对应域按域拒绝（媒体域 503）。名单从 `tools/lib/real-capability-config.mjs` 的 `CAPABILITY_GROUPS` 派生。

三个开关与它们的语义：

| 开关 | 开启时 | 关掉时 |
| --- | --- | --- |
| `submissions_enabled` | 社区投稿与评论可受理 | 社区投稿不可用（`POST /posts`、`POST /posts/:id/comments` 拒绝） |
| `specific_herbicide_output_enabled` | `/herbicides` 与登记核对可输出制剂信息 | `/herbicides` 返回 409，错误详情里的 `code` 是 `FLAG_CLOSED` |
| `ai_enabled` | 识别、OCR、转写、合成、文字问答的**任务受理面**可用 | 这些受理面返回 409（任务不会被受理） |

> 只开 `ai_enabled` 还不够：`POST /media/uploads` 与 `POST /recognitions` 还要过用途授权闸
> （`media_processing` + `external_inference`）。没有可用的已核验政策时它们会 403 `CONSENT_REQUIRED`
> —— 这正是第 2 步要补的。

幂等策略：每条 `UPDATE` 都带「当前还不是演示档」的条件；已经是 `enabled = true` 且 `reason` 一致的行不会再次 `revision + 1`。
政策用 `ON CONFLICT (purpose, policy_version) DO NOTHING` + 一条 `enabled IS DISTINCT FROM true` 的更新；
接收方用 `ON CONFLICT (id) DO UPDATE … WHERE 逐列 IS DISTINCT FROM EXCLUDED`。所以同一版本上 `down` 后再 `up --demo` 是零改动；
换政策版本时**第一次**会写入新版本并停用自家旧版本（政策行复核后不可改），之后就又是零改动。
若同一 `purpose` 已存在**另一条**启用政策，部分唯一索引会以 `23505` 让整个演示档失败（exit 8）——
⛔ 本工具不会去禁用别人的政策。

它**不**做这些：

- 不新增迁移，不改 `services/api/**`，也不改开关的默认值、后台写入口或权限模型；
- 不改种子里已有的业务资料，不建**可登录**的演示账号（那条复核账号没有可用口令），不补首页的 `verified` 来源；
- 不碰生产环境、不改 `.env` 或凭据，也不把开关值写回任何模板；
- 不是「安全建议」。这是**本机演示配置**：生产环境该开哪个、什么时候开、政策由谁核验，要按实际审核与合规要求决定，
  不能照抄这里的三个 `true` 与两条演示政策。

不带 `--demo` 时只打印「演示开关：未开（默认）」，不执行任何 `UPDATE`，`public.feature_flags` 与两张隐私表都保持迁移后的原值；
如果这时检测到 `consent_policies` 里没有生效的已核验政策，`up` 结束会打一条警告：
「识别动线会 403：没有已核验政策，用 --demo 或先跑 import-consent-policy/recipient」。

> 这是本机演示配置，不是生产建议。

### 3.2 `up --demo` 与已运行实例的关系

再敲一次 `up` 时，工具先探 `--port`：端口上那个进程是本工具起的（pid 文件里的 pid 一致、命令行带
`--gy-demo-stack-instance=…`），就**不再起第二个**。但「已经起着」不等于「这次的要求它满足」——
`--demo` 要求的批准项是**进程启动参数**，改不了运行中的进程，只能重启。

批准项持久化在哪：

| 位置 | 字段 | 谁写 | 谁读 |
| --- | --- | --- | --- |
| `<--state-dir>\api.pid` | `demo`、`approvals: {media, moderation}` | `up` 起 API 时 | `status`、下一次 `up`、`down` |
| `<--state-dir>\state.json` | `mode`、`demo`、`approvals`、两个端口、`lastUpAt` | 每次 `up` 成功 | 下一次 `up`（端口默认值）、给人看 |

`--state-dir` 默认 `E:\GengYunCommander\.pg17\demo-stack`；`api.pid` 是「这个实例是谁、带什么批准」的
持久记录。旧的 pid 文件没有这两个字段，读回是 `approvals: null`（**未知**），不是「没批」——`status`
会如实写「媒体批准=未知」，不替你猜。

判断顺序是**活进程的命令行 > pid 记录**：命令行里有没有 `--approve-real-media-wiring` 是唯一真值；
命令行读不到（探测不到持有进程）才退回 pid 记录；两边都没有就是「未知」。

真值不够时会发生什么：

- **缺批准**（`--demo` 要求媒体批准，既有实例命令行里没有）：`up --demo` **不会**静默成功。它先打印

  ```text
  API 是本工具上一次起的实例（pid 26316），但批准项不满足这次的要求 ⇒ 起 API 前会重启它（数据目录保留）
  · 缺 --approve-real-media-wiring
  ```

  然后**照常走 `[3/9]`–`[8/9]` 的收敛步骤**（env / PG / 迁移 / 种子 / 演示档都是幂等的，数据目录不动）。
  这些步骤全过了才停旧 API、等端口释放、用新的批准参数起一个新实例，并打印

  ```text
  检测到既有实例未带 --approve-real-media-wiring，已重启 API（数据目录保留）
  ```

  中间任何一步失败 ⇒ 以对应退出码结束（1/3/4/5/6/7/8），**旧实例原样留着**：先确认能重新起来再杀，
  别把正在演示的栈弄没。
- **批准项未知**（命令行读不到、pid 文件也是旧格式）：按「没批」处理并重启，原文换成
  `检测到既有实例的批准项无法确认（命令行读不到），已重启 API（数据目录保留）`。
- **同样档位重复 `up`**：不重启。打印 `API 是本工具上一次起的实例（pid …）⇒ 不重复启动，等它变健康`，
  等 `/health` 200 就返回 0，pid 不变。
- **反向**（既有实例带着媒体批准、这次没要求，比如不带 `--demo` 的 `up`）：也不重启，只打一行提醒
  「撤掉批准不是正确性要求，演示完记得 `down`」。

为什么选「自动重启」而不是「明确失败、让你先 `down` 再 `up`」：`up --demo` 的语义是「把栈收敛到演示档」，
缺批准时工具自己知道该做什么；让人先 `down` 再 `up` 多一次停机，而且容易在「看起来开好了」之后才发现
第一步 503。代价是这条路径会重启 API（进程内存里的东西会重来，数据目录不动），所以日志必须把
「为什么重启、缺的是哪个开关」写清楚。

> 批准项只能靠**重启进程**生效；`up` 不会改一个正在跑的进程的参数，也不会替你 `down` 别人的栈。

自查命令：

```powershell
node tools/demo-stack.mjs status --port 38110 --pg-port 55510          # 第一行末尾：媒体批准=已带 / 未带 / 未知
node tools/demo-stack.mjs status --port 38110 --pg-port 55510 --json   # api.approvals + api.approvalsSource
```

## 4 看一眼：`status`

```powershell
node tools/demo-stack.mjs status --port 38110 --pg-port 55510
```

正常时**前三行就是结论**：

```text
进程：API 在跑（pid 26316，mode=real，媒体批准=已带）
端口：TCP 127.0.0.1:38110 被占用（pid 26316，node.exe）
健康：GET /health → 200 ok（database=ok, mode=real）
  PG 簇：在运行（127.0.0.1:55510，数据 …\demo-stack\pgdata）
  日志：…\demo-stack\api.log
```

怎么读：

- **进程**：`API 未运行（无 pid 文件）` = 没起；`API 未运行` 但没括号 = 有 pid 文件而进程没了（下一次 `up` 会清理）。
- **批准项**（挂在进程行末尾）：`媒体批准=已带` = 命令行里有 `--approve-real-media-wiring`，媒体上传不会因接线缺失 503；
  `未带` = 就是 §3.2 那种「已就绪但缺批准」，跑一次 `up --demo` 会收敛；`未知` = 命令行与 pid 记录都读不到（旧版本写的 pid 文件），
  要确认就 `down` 再 `up --demo`。
- **端口**：`空闲` = 没人监听；`被占用（pid …, node.exe）` = 谁占着，点名到 PID。
- **健康**：`200 ok` 才算真起来；`连不上：ECONNREFUSED` = 端口没人听；`503` = API 活着但数据库没就绪。

没起任何东西时它是这样（放心，`status` 永远不改任何东西）：

```text
进程：API 未运行（无 pid 文件）
端口：TCP 127.0.0.1:38111 空闲
健康：GET /health → 连不上：ECONNREFUSED
```

给脚本用可以加 `--json`，输出一份结构化读数（进程 / 端口 / PG / 健康）。

## 5 出问题看日志：`logs`

```powershell
node tools/demo-stack.mjs logs --lines 50
```

它会打印 API 与 PG 两段日志的**尾部**（默认 40 行）。日志文件在仓库外：

- API：`…\.pg17\demo-stack\api.log`（工具启动 API 前会清空它，所以总是本次的）
- PG：`…\.pg17\demo-stack\pg.log`
- `pg_ctl` 自己的输出：`…\.pg17\demo-stack\pg-ctl.log`（PG 起不来时先看这个）

## 6 常见故障与修法

> 顺序按"遇到概率"排。每条都给出**屏幕上会出现的原文**，对上了再照做。

| # | 屏幕上会看到 | 意思 | 怎么修 |
| --- | --- | --- | --- |
| 1 | `✗ API 端口 38110 已被占用：pid 27376（node.exe）` 并附命令行，exit 2 | 有别的程序占着这个端口 | 关掉那个程序（`Stop-Process -Id 27376`，先确认是自己不要的）；或换端口 `--port 38120` 并同步改手册里所有命令 |
| 2 | `✗ PG 端口 55510 已被别的进程占用` exit 2 | 别的数据库实例占着 55510 | 同上，换 `--pg-port`，或停掉那个 PG |
| 3 | `✗ real 模式缺 env 项：…` + 模板，exit 1 | env 文件没给、路径写错、或少了键 | 按 §2 生成；确认 `--env-file` 的绝对路径对得上 |
| 4 | `✗ API_EXITED：API 进程退出了（exit=1）` + 日志里 `- OBJECT_STORAGE_ENDPOINT [INVALID_VALUE] 必须是 https:// 开头的 endpoint（明文 http 不接受）`，exit 6 | 端点写成了 `http://` | 把 env 里的 `OBJECT_STORAGE_ENDPOINT` 改成 `https://…` 再 `up` |
| 5 | `✗ API_EXITED` 且日志里 `[INVALID_VALUE]` / `缺少` 其它键 | 凭据值不合法或为空 | 按日志里点名的键回去查 env 文件（工具只打键名，值自己核） |
| 6 | `✗ HEALTH_TIMEOUT：API 没在 90000ms 内返回 200`，exit 7，并打印 API 日志尾 30 行 | API 没在时限内就绪 | 先看那 30 行；`DATABASE_URL` 连不上、或 env 有错是常见原因。重来：`down` 再 `up` |
| 7 | `✗ 找不到 pg_ctl：<路径>` exit 3 | `--pg-bin` 指错了 | 指到含 `pg_ctl.exe` 的目录，例如 `--pg-bin E:\GengYunCommander\.pg17\pgsql\bin` |
| 8 | `✗ PG_START_FAILED` / 日志里 `could not create any TCP/IP sockets` | 55510 被别人抢先，或数据目录属于别的 PG 版本 | 先 `status` 看 PG 段；必要时 `reset --yes` 重建（会丢演示数据） |
| 9 | `✗ MIGRATION_DRIFT`（迁移台账与文件不一致） | 数据目录是旧的，迁移文件变过 | `node tools/demo-stack.mjs reset --yes` 后重新 `up` |
| 10 | `down` 之后端口还显示被占 | 另一个进程在你收工后抢了这个端口 | `Get-NetTCPConnection -LocalPort 38110 -State Listen` 看是谁；不是本工具起的就别乱杀 |
| 11 | 首页 503（stub 模式） | **正常契约**：非 real 模式首页必 503（数据库未接入） | 要演示首页就用 `--mode real`；stub 只用来验证「进程/端口/健康」链路 |
| 12 | 首页 200 但列表空的 | 资料接入缺项，不是栈坏了 | 见 §7 |

## 7 首页为什么是空的 / 怎么灌演示资料

### 7.1 先分清是「栈坏了」还是「资料缺项」

`real` 模式下首页读的是数据库里的 `catalog_read.home_species` 视图，接口本身没问题：返回 **200 + 空列表**（`{"previews":[],"human_review_state":"under_construction"}`）的唯一原因是**视图里 0 行**。

视图不是「有知识就上」，它同时要求：

- 知识是 `type = 'species'`、`visibility = 'published'`，且是该 `knowledge_id` 的最大 revision；
- 它的来源版本 `review_status = 'verified'`、`reviewed_by` 与 `reviewed_at` 非空、`validity = 'valid'` 且在有效期内；
- 该来源版本就是所属 `sources.current_version_id`；
- 数据集配置 `active_mode = 'real'` 且 `database_connected = 'true'`。

仓库里现有的种子（`db/seeds/seed_reference.sql`、`db/seeds/seed_zhejiang_materials.sql`）来源版本**全是 `unverified`**——开发侧不是法定审核责任人，这是**对的**，不该为了首页好看去改那一行。

所以裸 `up` 之后列表空是**资料缺项**，不是本栈故障，也不该在工具里用假数据兜底。

自己核一遍（只读，不改数据）：

```powershell
& 'E:\GengYunCommander\.pg17\pgsql\bin\psql.exe' -h 127.0.0.1 -p 55510 -U postgres -d gengyun -c "select count(*) from catalog_read.home_species;"
```

没灌过演示资料时，期望 `0`。

### 7.2 要首页有卡片：显式加 `--seed-demo`

```powershell
node tools/demo-stack.mjs up --mode real --port 38110 --pg-port 55510 --env-file E:\GengYunPrivate\demo-real.env --seed-demo
```

- **默认不开**。不带这个参数时行为与以前完全一致（首页空列表）；带了 `--seed-demo` 却给了 `--mode stub` 会直接报错退出，不会静默忽略。
- 打开后额外灌一份 `db/seeds/demo_catalog_verified.sql`，成功时打印 `✓ 已灌演示资料（非生产数据）：…`；已灌过则打印「已灌过，跳过」（state 记 `demo:gengyun`，重灌用 `up --reset --seed-demo`）。
- 灌进去的是**演示用资料**：标题/学名/别名只取自 `db/seeds/seed_reference.sql` 里已有的 8 个物种行，正文带「【演示资料·非生产数据】」前缀；`reviewed_by` 指向一个**登录不进去的占位账号**，**不是真人审核、不是第三方审核**，也不构成识别结论、防治建议或用药建议。它只影响本机这台机器的这个演示库。
- 幂等：写入全部是 `INSERT … ON CONFLICT DO UPDATE`；重复执行不新增行、不抬高 `sources.revision`、不改 `knowledge_versions.created_at`。若 `public.species` 参考行缺失，文件末尾的自检会 `RAISE EXCEPTION` 直接失败——不会「看起来灌了、其实 0 行」。
- 撤回：文件末尾有注释掉的逐条回滚 SQL；最省事的是 `up --reset`（或 `reset --yes` 删整个状态目录）。

灌完自检：

```powershell
curl.exe -s -w "`n%{http_code}`n" http://127.0.0.1:38110/api/v1/public/home
```

期望 **200** 且 `previews` 有 8 条，每条 `"content_type":"knowledge"`、`"source_kind":"verified_seed"`。

仍是空列表时按这个顺序看：返回 503 ⇒ 不是 `real` 模式；200 但 0 条 ⇒ 先跑 7.1 的 psql，再确认 `up` 的输出里有没有「已灌演示资料（非生产数据）」。

完整的实跑读数、为什么它不算生产数据、以及**不声称**清单见[演示资料种子证据页](../verification/gy-r90-demo-seed-20261109.md)。

## 8 和微信开发者工具接上（`prepare-wechat` 衔接）

`up` 成功后，屏幕上的「下一步」就是这段流程。照抄即可，注意三处**硬约束**：

1. 准备配置：复制 `config/debug.local.json.example` 为 `config/debug.local.json`（后者已被 `.gitignore` 忽略），改成：

   ```json
   {
     "mode": "local",
     "bindHost": "127.0.0.1",
     "port": 38110,
     "apiBaseUrl": "http://127.0.0.1:38110/api/v1"
   }
   ```

   - `apiBaseUrl` **必须带 `/api/v1`**：小程序是直接拿它拼 `/auth/session` 等路径的（客户端不做前缀补全），漏了会一路 404。
   - 必须是 `http://` + 私有地址（`127.0.0.1`）+ 端口与 `port` 一致；带用户名密码、query、`#` 都会被拒。

2. 生成隔离工程：

   ```powershell
   node tools/prepare-wechat.mjs local --config config/debug.local.json
   ```

   期望最后打印 `LOCAL import root: <仓库>\.local\wechat-local`。三条真实行为，别踩：
   - 输出目录**已存在就报错**（`Output already exists: …`）：要重来先删掉那个确切目录，它不会覆盖。
   - 共享工程必须 `compileType=miniprogram`、`miniprogramRoot=miniprogram/`、`setting.urlCheck=true`，且共享 `miniprogram/config/runtime.js` 仍是 disabled 原文；否则工具拒绝生成（这是防呆，不是 bug）。
   - 生成副本里的 AppID 默认沿用共享工程；协作者要用自己的测试号时加 `--appid wx…`（`wx` + 16 位小写十六进制）。

3. 导入与放行：开发者工具 → 导入项目 → 选上面那个 `LOCAL import root` 目录；在这个**隔离副本**里勾「详情 → 本地设置 → 不校验合法域名…」（只在这个副本里勾，别改共享工程）。

4. 在模拟器里点「首页」：`real` 模式应为 200（可能显示"暂无资料"，见 §7）；若 503，先回 `status` 看健康是不是 200。

想自己先用命令行确认真通了（不经过小程序）：

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:38110/health      # 应 200
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:38110/api/v1/health  # 应 404（健康检查在根路径）
curl.exe -s -w "`n%{http_code}`n" http://127.0.0.1:38110/api/v1/public/home  # 应 200（可能空列表）
```

## 9 清空重来：`reset`（会删数据）

```powershell
node tools/demo-stack.mjs reset --yes
```

它停掉 API + PG，然后**删掉整个状态目录**（`…\.pg17\demo-stack`：数据、日志、pid 文件、生成的签名钥匙），下一次 `up` 会重新 initdb。不带 `--yes` 时它只打印风险、exit 1，什么都不删。

## 10 速查

| 事 | 命令 |
| --- | --- |
| 在哪跑 | `cd E:\GengYunCommander\.pg17\wt-demo-stack` |
| 起来 | `node tools/demo-stack.mjs up --mode real --port 38110 --pg-port 55510 --env-file E:\GengYunPrivate\demo-real.env` |
| 演示档 | 在上面的 `up` 末尾加 `--demo`（三个开关置为开启；幂等，仅本机演示） |
| 首页要卡片（演示资料） | 上面那条加 `--seed-demo`（默认不开；灌的是非生产数据，见 §7.2） |
| 状态 | `node tools/demo-stack.mjs status --port 38110 --pg-port 55510` |
| 日志 | `node tools/demo-stack.mjs logs --lines 50` |
| 收工 | `node tools/demo-stack.mjs down --port 38110 --pg-port 55510` |
| 清空 | `node tools/demo-stack.mjs reset --yes` |
| 帮助 | `node tools/demo-stack.mjs --help` |

名词对照：**API** = 本机的接口服务（浏览器/小程序访问它）；**PG** = PostgreSQL 数据库；**state-dir / 状态目录** = 数据、日志、pid 文件的存放处（在仓库外）；**real / stub** = 连真数据库 / 只验证链路（首页必 503）。

这套工具与既有的 `npm run local:up`（`tools/local-env.mjs`，默认 3111/5555，另含端点断言与摘要落盘）是**两套并行入口**：本手册这套面向"四条命令 + 演示"，那个面向"本机环境核验"。两者都用 PG，但用不同端口和不同状态目录，可以并存，别把端口改成一样。

## 11 这套栈能演什么、不能演什么（2026-11-09 彩排实测）

演之前先读这一节：**同一个 `up`，带不带 `--demo`，能让「拍照识别」这一条动线可用或不可用。**

| 事实 | 依据 |
| --- | --- |
| 只有带 `--demo` 起，API 才带 `--approve-real-media-wiring` | §3.1 第 3 条：不带它 `POST /media/uploads` 会 503 `PROVIDER_UNAVAILABLE` |
| 不带 `--demo` 起（即 §0/§10 那四条命令的默认形态）→ 识别页拍照拿不到候选 | 同上；小程序会显示「服务端真实对象存储尚未接线（媒体域 fail-closed），照片未上传」 |
| 「不出结果」是**设计如此**，不是坏了 | 识别页与问答页都会显式写「未接入时如实报不可用」 |

### 11.1 本机 2026-11-09 的实际形态（与 §4 的差异，别当成故障）

当时 38110 上的 API **不是** `tools/demo-stack.mjs` 起的，而是别的工作树里手动拉起的
`services/api/src/server.ts` 进程（带 `--gy-demo-stack-instance=…`，**没有** `--approve-real-media-wiring`）。
后果有两个，都会让人误判：

1. `node tools/demo-stack.mjs status` 会打印「进程：API 未运行（无 pid 文件）」「端口被占用（pid …）」，
   但 `GET /health` 仍然是 `200 {"status":"ok"}`。**以 `/health` 为准**，不要因为这个 status 去重启。
2. 识别动线拍照必然得到「照片未上传」。想让它真出候选，只能用 `--demo` 重新起一个栈（会换进程与 pid 文件，
   别和正在用的这个抢 38110）。

### 11.2 演示可用的数据面（同一次彩排实测）

| 页面 | 实测 |
| --- | --- |
| 首页 | 3 个入口、公开预览 **8** 张资料卡 |
| 识草查药（`/herbicides` 读数） | 共 **20** 条；作物 4 / 杂草 8 / 地区 102 / 剂型 8 |
| 科普知识（服务端查询） | **8** 条；档案设成「水稻 + 西湖区」后会预置筛选并显示 0 条，点「清空条件继续查询」回到 8 条 |
| 社区 | **3** 帖 |
| 消息 | **3** 条、未读 **3** |
| 问答 | 「稻田稗草怎么防除？」→ 回答非空、引用 1 条、标签「演示数据」 |
| 我的档案 | 作物 4 / 市 11 / 县 13；保存后「水稻 · 西湖区」 |
| 我的收藏 | 可收藏 **8**、默认已收藏 0 |
| 识别历史 | **6** 条，全部「识别完成」 |

逐段怎么讲、每屏该出现什么、失败时说什么，见同目录的 [演示脚本](./演示脚本.md)。
