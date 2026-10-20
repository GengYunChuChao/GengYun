# GY-I23 本机回环时延分位数与 50 并发容量取证（2026-10-20）

- **类型**：取证（条件受限）／`Refs #23`／⛔ **不关闭 #23**（部分证据，条件受限，不构成任何条款达标）
- **被测代码 SHA**：`3a279db687d0ac37735b573d10a7b1f5fba99934`（本片工具提交；被测**产品代码**与基线 `df043a715e691019e14373181249a5cf51ec9da9` 逐字节相同，本片 0 行产品代码改动、0 迁移）
- **基线**：`upstream/main = df043a715e691019e14373181249a5cf51ec9da9`（取证时实测）
- **测量时点**：2026-10-20 09:34:54–09:34:58 +08:00（时延抽样，UTC 01:34:54–01:34:58）；2026-10-20 09:35:02–09:45:03 +08:00（容量压测，UTC 01:35:02–01:45:03）
- **本页提交**：只新增本文件（`docs/verification/`），**不改任何代码**；因此"被测代码 SHA"与"本页所在提交"是两个 SHA，复核命令见 §8 末行
- **原始 JSON**：仓外 `.pg17\tmp\i23-perf\latency-report.json`（sha256 `a7fa921d83aed2e1af1868d237f86a7fb1770ca95fab0154acf4524851195ec6`，10269 字节）与 `.pg17\tmp\i23-perf\load-report.json`（sha256 `7b3efb59309ff9b673a0dbcc161a56dcd92b4bdabc1d03a6c262999a08734583`，13351 字节），均**未入库**；本页 §5／§6 的数字逐字取自这两份 JSON

## 1 结论摘要

1. **时延（串行，n=60/组，冷热分列）**：`/api/v1/knowledge?limit=20` 冷连接 p95 **12.338 ms**、keep-alive p95 **12.559 ms**；详情 `/api/v1/knowledge/:id` 冷 p95 8.435 ms／热 p95 7.599 ms；`/api/v1/me/profile` 冷 5.498 ms／热 4.333 ms；`/api/v1/catalog/crops` 冷 6.817 ms／热 4.863 ms；`/health` 冷 2.445 ms／热 0.925 ms。十组共 600 条有效样本，**0 丢弃、0 错误**。
2. **容量（50 并发 × 600.151 s 混合负载）**：总请求 **177,886** 条，错误 **0** ⇒ 错误率 **0.0000%**（分母＝全部请求，含丢弃与超时）；实测吞吐 **296.4 req/s**（派生值＝177886÷600.151）。各端点 p95 落在 **138.140–211.938 ms**，其中请求量占 48.2% 的 `/knowledge` 列表组 p95 **208.692 ms**（n=85728）、`PUT /me/profile` p95 **211.938 ms**（n=12018）。
3. **50 并发下的 200 ms 级 p95 不是"容量上限"**：`services/api/src/db/pool.ts:32` 是骨架阶段的 `max: 4`（源码注释原文「骨架阶段保持小连接数，避免误用生产容量。」），50 个并发请求在 4 条数据库连接上排队；单条 `/knowledge` 列表响应体实测均值 **56,639 字节**。⇒ 该组读数描述的是**当前骨架配置**在同机 50 并发下的表现。
4. **四条现场断言全部成立**（加载前实测）：无凭据 `GET /api/v1/knowledge` ⇒ 401 `SESSION_REQUIRED`；伪造 Bearer ⇒ 401；同一 `Idempotency-Key` 连发两次 `PUT /me/profile` ⇒ 200/200 且 `revision` 相同、`single_profiles` 该用户仍只有一行；过期 `If-Match` ⇒ 409 `REVISION_CONFLICT`。加载后复核：`single_profiles` rows=100、distinct_users=100（每个用户恰一行）。
5. **一句话边界**：以上全部是**本机回环 + 原生 PostgreSQL 17.11 + `APP_EXECUTION_MODE=stub` 隔离替身 + 合成数据规模**条件下的读数；**没有**真机、**没有** ≥20Mbps／RTT≤100ms 公网链路、**没有** 真实供应商调用、**没有**独立压测机 ⇒ **不构成 #23 任何条款的达标判定**，#23 保持 OPEN。

## 2 命令原文（可直接粘贴复跑）

```powershell
# ① 在本片 worktree 内准备独立端口的本机栈（先实测 3310／55536 无监听）
cd E:\GengYunCommander\.pg17\wt-i23-perf
Test-Path .local/local-dev   # 期望 False（若已存在，prepare 会拒绝重复准备）
node tools/local-dev/prepare.mjs --pg-bin E:\GengYunCommander\.pg17\pgsql\bin --api-port 3310 --pg-port 55536

# ② 起服务（见 §12 的本机坑：本机需先摘掉环境里大小写重复的代理变量）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\.local\local-dev\start.ps1

# ③ 时延抽样：每端点 × 冷/热各 60 条，预热每组 5 条
node tools/perf/latency-sample.mjs --base http://127.0.0.1:3310 --n 60 --cold --hot

# ④ 容量：50 并发 × 600 秒混合负载
node tools/perf/load-50vu.mjs --base http://127.0.0.1:3310 --vu 50 --duration 600

# ⑤ 收工
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\.local\local-dev\stop.ps1
& E:\GengYunCommander\.pg17\pgsql\bin\pg_ctl.exe -D .\.local\local-dev\private\pg-data status   # 期望 no server running
```

脚本**未接成 npm 脚本**（`package.json` 正被在飞 PR 占用，且性能数字不得成为 CI 通过条件），一律直接 `node tools/perf/...` 调用。

## 3 环境指纹（报告字段 `env_fingerprint`，逐字）

| 项 | 实测值 |
| --- | --- |
| Node | `v24.16.0`（符合 `package.json` 的 `engines.node >=24.16.0 <25`） |
| 平台／系统 | `win32`／OS release `10.0.26200`（Windows 11） |
| CPU | `12th Gen Intel(R) Core(TM) i7-12650H`，逻辑核 **16**（物理核 10） |
| 内存 | **16,905,416,704 字节**（≈15.74 GiB） |
| PostgreSQL | `PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit`（原生本机集群，非容器） |
| 端口 | API `127.0.0.1:3310`／PG `127.0.0.1:55536`（非默认 3100／55436，实测空闲后再起） |
| 执行模式 | `APP_EXECUTION_MODE=stub`（`tools/local-dev/api.mjs` 强制；合成微信身份） |
| 数据库 | 库名 `gengyun_local_dev`，迁移 `22 applied, 0 unchanged` |
| 客户端位置 | 与被测服务**同机**（`within_same_host = true`） |

除本机栈自身外，测量期间该机**同时**有其他进程占用 CPU（系统级 CPU 利用率快照均值 **50.2%**、峰值 **74.2%**，见 §6.4）⇒ 读数偏保守。

## 4 数据规模（报告字段 `data_scale`，`SELECT count(*)::bigint` 原样）

| 表 | 时延抽样时 | 容量压测结束时 |
| --- | --- | --- |
| `knowledge_versions` | 0 | 0 |
| `sources` | 0 | 0 |
| `species` | 0 | 0 |
| `crops` | 4 | 4 |
| `regions` | 102 | 102 |
| `single_profiles` | 50 | 100 |
| `users` | 57 | 107 |
| `sessions` | 57 | 107 |
| `posts` | 0 | 0 |
| `community_posts` | 0 | 0 |
| 读取面可见知识条数（`GET /api/v1/knowledge` 分页实数） | **159** | **159** |

- **数据规模不真实**：`tools/local-dev/database.mjs` 明写「**no source or knowledge records seeded**」⇒ 库内知识表 **0 行**；`/knowledge` 的 **159** 条来自 `APP_KNOWLEDGE_UNVERIFIED_SEED=1` 的 **seed 合并**（`services/api/src/routes/knowledge.ts` 的 `extraRows` 缝），不是真实生产数据。
- `single_profiles`／`users`／`sessions` 的增量来自本片自己的 50 个虚拟用户（含一次 30 秒试跑的另 50 个）——**是压测副作用**，如实登记，不是外部数据。
- 首次读取时 `single_profiles` 为 0 行（`/me/profile` 按合成默认值返回 revision 1），写完才落库。

## 5 时延分位数（**串行**采样，每端点 × 连接类别各 n=60）

分位法：**`(n-1)p` 线性插值**（等价 numpy 默认／R type 7），单位毫秒；每组预热 5 条并显式丢弃（`warmup_discarded = 50`，10 组 × 5）。⛔ 冷热两组**分列**，不合并成一条 p95。

### 5.1 冷连接（`cold`：`agent:false` + `Connection: close`，不复用连接）

| 端点 | n | dropped | p50 | p90 | p95 | max | mean | 响应体均值（字节） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/knowledge?limit=20` | 60 | 0 | 10.324 | 11.906 | 12.338 | 13.411 | 10.434 | 56639 |
| `GET /api/v1/knowledge/:id` | 60 | 0 | 7.200 | 8.227 | 8.435 | 9.818 | 7.094 | 3363 |
| `GET /api/v1/me/profile` | 60 | 0 | 4.443 | 5.181 | 5.498 | 6.400 | 4.493 | 199 |
| `GET /api/v1/catalog/crops` | 60 | 0 | 5.781 | 6.709 | 6.817 | 7.974 | 5.786 | 298 |
| `GET /health` | 60 | 0 | 1.884 | 2.251 | 2.445 | 2.964 | 1.884 | 235 |

### 5.2 keep-alive 复用（`hot`：同一连接复用）

| 端点 | n | dropped | p50 | p90 | p95 | max | mean | 响应体均值（字节） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/knowledge?limit=20` | 60 | 0 | 10.100 | 11.896 | 12.559 | 14.442 | 10.240 | 56639 |
| `GET /api/v1/knowledge/:id` | 60 | 0 | 6.164 | 7.323 | 7.599 | 8.897 | 6.282 | 3363 |
| `GET /api/v1/me/profile` | 60 | 0 | 3.793 | 4.161 | 4.333 | 4.823 | 3.798 | 199 |
| `GET /api/v1/catalog/crops` | 60 | 0 | 4.113 | 4.609 | 4.863 | 5.684 | 4.141 | 298 |
| `GET /health` | 60 | 0 | 0.689 | 0.854 | 0.925 | 1.362 | 0.698 | 235 |

### 5.3 丢弃与错误

十组 `dropped` 全为 **0**、`drop_reasons` 全为 `{}`、`error_rate` 全为 `0/60`。⇒ 本次抽样**没有**出现超时、非 2xx 或传输错误；**这不等于**"在任何条件下都不会出错"，只说明这 600 条样本里没发生。
`GET /api/v1/knowledge/:id` 的被测 id 取自列表首条（`fe61a647-d05b-5d14-871d-2807bf9dd153` 所在 seed 集合），不是随机挑选"最快的条目"。

## 6 容量读数（50 并发虚拟用户 × 600 秒混合负载）

### 6.1 负载定义（计划配比＝`--mix` 默认值，原样输出）

| 操作 | 端点 | 计划占比 | 实测请求数 |
| --- | --- | --- | --- |
| `knowledge_list` | `GET /api/v1/knowledge?limit=20` | 0.45 | 85728 |
| `knowledge_detail` | `GET /api/v1/knowledge/:id` | 0.15 | 26790 |
| `me_profile` | `GET /api/v1/me/profile` | 0.15 | 26711 |
| `catalog_crops` | `GET /api/v1/catalog/crops` | 0.10 | 17830 |
| `history` | `GET /api/v1/history` | 0.05 | 8809 |
| `profile_put` | `PUT /api/v1/me/profile` | 0.10 | 12018 |

- 每个虚拟用户**一条独立合成身份**（50 次 `POST /api/v1/auth/wechat`），因此 profile 写入之间不存在"合法版本冲突"，409 不会被混进错误率。
- 写入有速率闸 `--write-budget-per-s 20`：超预算的写入**降级为读**，降级 **5744** 次（`load.mix.substituted`），计划/实测分开记。
- 写入失败（非 200）时会额外发一次 `GET /me/profile` 刷新版本游标，本次 **0** 次（`refresh_requests = 0`）。
- ⛔ **不含社区读写**：本机栈社区域未接线，`GET /api/v1/posts?limit=20` 实测 **503 `PROVIDER_UNAVAILABLE`**（`services/api/src/routes/community.ts` 的 `ready()` 分支），故混合负载如实排除，**不用替身读数顶替**。

### 6.2 读数（`concurrent` + `hot`，分母含丢弃）

| 操作 | n | dropped | p50 | p90 | p95 | max | mean | 错误率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `knowledge_list` | 85728 | 0 | 172.630 | 199.083 | 208.692 | 350.239 | 174.217 | 0.0000%（0/85728） |
| `knowledge_detail` | 26790 | 0 | 168.874 | 195.220 | 205.064 | 343.264 | 170.482 | 0.0000%（0/26790） |
| `me_profile` | 26711 | 0 | 165.397 | 190.992 | 200.043 | 341.876 | 166.770 | 0.0000%（0/26711） |
| `catalog_crops` | 17830 | 0 | 165.402 | 191.157 | 200.521 | 308.606 | 166.953 | 0.0000%（0/17830） |
| `history` | 8809 | 0 | 106.695 | 129.485 | 138.140 | 272.878 | 107.678 | 0.0000%（0/8809） |
| `profile_put` | 12018 | 0 | 173.709 | 201.635 | 211.938 | 354.332 | 175.670 | 0.0000%（0/12018） |

- 总计：**177,886** 请求，**0** 错误，实测时长 **600.151 s**，派生吞吐 **296.4 req/s**。
- **未计算跨组合并分位数**：合并会把分组差异抹平（例如 `history` 明显更快），故只给分组读数与区间（p95 138.140–211.938 ms）。
- 观测到的瓶颈（如实、不作因果断言）：`db/pool.ts:32` 的 `max: 4` 连接池 + 单 Node 进程事件循环；系统级 CPU 均值只到 50.2%，**不是** CPU 打满导致的饱和。

### 6.3 现场断言（加载前/后，报告字段 `load.assertions`）

| 断言 | 结果 | 实测读数 |
| --- | --- | --- |
| 无凭据访问必拒 | 通过 | `GET /api/v1/knowledge` 无 `Authorization` ⇒ 401 `SESSION_REQUIRED` |
| 伪造令牌必拒 | 通过 | 带 `Bearer perf-load-bogus-token` ⇒ 401 |
| 同一幂等键不产生第二结果 | 通过 | 同键连发两次 `PUT /me/profile` ⇒ 200/200，`revision=2/2` |
| 过期 `If-Match` 必拒 | 通过 | `If-Match: "999999"` ⇒ 409 `REVISION_CONFLICT` |
| 幂等键不产生第二行（库侧） | 通过 | `single_profiles` rows=51、distinct_users=51（当时 51 个用户各一行） |
| 压测后每用户仍恰一行 | 通过 | `single_profiles` rows=100、distinct_users=100 |

### 6.4 资源快照（每 30 秒一条，共 22 条；全机口径）

| 指标 | 读数 |
| --- | --- |
| CPU 利用率均值 | 50.2% |
| CPU 利用率峰值 | 74.2%（t=30 s） |
| 压测进程 RSS 峰值 | 180.7 MB |
| PG 会话数（`pg_stat_activity`，库 `gengyun_local_dev`） | 5（连接池 `max: 4` + 1 条取数连接） |

CPU 利用率由 `os.cpus()` 时间差算出（含压测生成器自身）；Windows 的 `os.loadavg()` 恒 0，**未采用**。

## 7 与规格书 §4.4 十四项字段的逐项对照

| 序号 | 字段 | 本页位置 | 状态 |
| --- | --- | --- | --- |
| 1 | 基线 SHA 与被测代码 SHA | 页首 + §8 末行复核命令 | 已取得 |
| 2 | 测量时点（含时区） | 页首（+08:00 与 UTC 并列） | 已取得 |
| 3 | 命令原文 | §2（五行可直接粘贴） | 已取得 |
| 4 | `envFingerprint` | §3 | 已取得 |
| 5 | 每端点 `n / dropped / dropReasons` | §5.1、§5.2、§6.2 | 已取得 |
| 6 | `p50/p90/p95/max` + 分位法 | §5.1、§5.2、§6.2 + 「`(n-1)p` 线性插值」 | 已取得 |
| 7 | `errorRate`（分母口径） | §6.2 表 + 「分母＝全部请求（含丢弃/超时）」 | 已取得 |
| 8 | `dataScale`（行数原样） | §4 | 已取得（含"不真实"声明） |
| 9 | 冷/热与串行/并发分组 | §5（串行×冷热）、§6（并发×热） | 已取得 |
| 10 | `substitute` 声明 + 真实调用计数 | §1.5、§6.1；`real_provider_calls = 0` | 已取得 |
| 11 | `withinSameHost` | §3 末行（`true`） | 已取得 |
| 12 | 未取得项单列 | §11 | 已取得（6 项） |
| 13 | 与 #23 条款的逐条对照（能/不能主张） | §10 | 已取得 |
| 14 | 原始 JSON 的路径或哈希 | 页首（两份 JSON 的 sha256 + 仓外路径） | 已取得（**未入库**） |

复核"被测代码未变"：`git diff --stat 3a279db687d0ac37735b573d10a7b1f5fba99934..HEAD -- ':!docs/verification/gy-i23-latency-capacity-local-20261020.md'` 期望**为空**。

## 8 十条措辞约束（规格书 §5）与本页采用的写法

| 编号 | 红线（原文摘要） | 本页采用的写法 |
| --- | --- | --- |
| 1 | 不得写"查询 p95＝X ms 满足 ≤3 秒" | §1.5 与本表第 1 行：只报"本机回环、数据规模 N、stub 条件下"的分布，并明写**不构成** §6.2 第 5 行判定 |
| 2 | 不得写"50 并发下容量达标" | §1.3、§6.2：写"同机共享 CPU 与 PG、读数偏保守、不是部署容量结论、不代表外部 AI 容量" |
| 3 | 首屏／页面耗时未测就写未测 | §11 第 1 项：首屏 p95 需真机 + 微信渲染，**未取得** |
| 4 | 不得把 stub 时延当真实识别时延 | §1.5、§6.1：AI 为 `stub` 隔离替身、零外呼；真实识别/语音 **未取得** |
| 5 | 不得用一次读数当分位数 | §5.3：`/health` 的 `latency_ms` 类单样本**未并入**任何分组 |
| 6 | 不得用 `app.inject()` 进程内计时当 HTTP 时延 | **全部**读数来自客户端 HTTP 边界 `process.hrtime.bigint()`（§2 脚本口径） |
| 7 | 不得挑最快若干次凑 n=30 | §5.1、§5.2：n=60 全量保留，`dropped=0` 也照样登记；预热条数显式记录 |
| 8 | 不得引 1000 并发目标 | 本页通篇不出现 1000 并发目标（需求已限缩：`docs/implementation-requirements.md` 明写"1000并发与运营规模不是本轮默认首版承诺"） |
| 9 | 不得把 p95 写成"95% 置信区间" | §5 开头与 §10：明写"分位数 ≠ 置信区间，未做 bootstrap 区间估计" |
| 10 | 不得把本机读数登记为 #23 的提交证据 | 页首与 §10：登记为"**部分证据（条件受限）**"，#23 **保持 OPEN** |

## 9 与 #23 条款的逐条对照（能主张什么／不能主张什么）

| 条款 | 能主张 | 不能主张 |
| --- | --- | --- |
| C1 内部资料查询（服务端段） | 本机回环、159 条可见知识、原生 PG 17.11 条件下 `/knowledge` 列表与详情的服务端处理分位数（§5.1／§5.2） | 「查询 p95≤3 秒达标」；真机／公网条件下的查询时延 |
| C1 首屏 p95≤2 秒 | — | 任何首屏读数（需真机 + 微信渲染） |
| C2 两类识别／语音问答耗时 | 仅「替身链路可跑通、零外呼」这一点 | 真实供应商的 p95 与失败率；真实额度与耗时 |
| C3 内部 50 并发 10 分钟、错误≤1% | 50 个并发客户端（同机、独立身份）在 600.151 s 内 177,886 条请求、0 错误、分组 p95 区间（§6.2） | 「C3 达标」；「生产／部署容量」；「外部 AI 容量」 |
| C5 每项≥30 次、记录完整路径 | 每格 n=60（时延）／每组 n≥8809（容量），丢弃与原因逐条登记 | 「按需求网络条件」的记录；真机设备/系统/微信/缓存字段 |
| C6 不挑最快次数 | 全量保留、预热显式丢弃 | 真机样本的"完整路径"记录 |
| C7 不得把替身称外部容量 | `substitute.execution_mode=stub`、`real_provider_calls=0` 的声明 | 任何"内部替身＝外部 AI 容量"的表述（本条已被本页与报告 schema 双重约束） |
| C8 分位数／容量报告（提交证据） | 本机条件下**形态合规**的分位数与容量报告（§5／§6／§7 十四项字段齐备） | 「性能分位数/容量报告已满足 #23 提交证据」（需求条件未满足） |

## 10 未取得项（本片不可能取得，如实单列）

1. **Android 真机首屏 p95**：需真机 + 微信渲染 + 用户扫码授权 —— 未取得。
2. **iOS 任何读数**：用户已正式暂缓，且"暂缓 ≠ 验收通过" —— 未取得。
3. **真实两类识别／语音问答的 p95 与失败率**：真实供应商付费调用未授权 —— 未取得（本页只有替身链路）。
4. **满足"≥20Mbps、RTT≤100ms"的网络条件**与"设备／系统／微信／资源／缓存／网络"全字段记录 —— 未取得（本机为回环）。
5. **独立压测机**：本轮恒同机，生成器与被测服务共享 CPU 与 PostgreSQL —— 未取得。
6. **替身与真实的差值 Δ**：`stub` 时延与真实供应商时延无可比性 —— 只能记"未取得"。
7. **社区域读写**（本机栈未接线：`/api/v1/posts` 实测 503）—— 混合负载中如实排除。
8. **首屏/页面级 DOM 时序**：本机不能用 `app.inject()` 或模拟器冒充 —— 未取得。

## 11 复现步骤与本机两处坑（如实登记，不改仓库代码）

1. **`start.ps1`／`stop.ps1` 在本机的 `Start-Process` 环境冲突**：本机会话环境里同时存在大小写两份代理变量（`NO_PROXY`／`no_proxy`、`HTTPS_PROXY`／`https_proxy`、`HTTP_PROXY`／`http_proxy`），Windows PowerShell 5.1 的 `Start-Process` 在构造子进程环境字典时抛
   `Item has already been added. Key in dictionary: 'NO_PROXY' Key being added: 'no_proxy'`（换个顺序后报 `'https_proxy'`）。**绕过方式**：调用脚本前在**同一进程内**执行
   `[Environment]::SetEnvironmentVariable('no_proxy',$null)`（三份小写变量各一次）再调 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...`；`NO_PROXY` 原值保留（含 `127.0.0.1`，回环不被代理拦截）。**脚本与仓库均未改动**。
2. **执行策略**：`E:` 盘被视为 internet zone，直接 `& .\start.ps1` 报"未对文件进行数字签名"；必须经 `powershell.exe -ExecutionPolicy Bypass -File` 子进程调用（与项目既有推送脚本同一坑）。
3. 起服务后按纪律**先等再探**：`start.ps1` 自带 `/health` 轮询（30 次 × 200 ms），本次一次性 READY（`Database ready: 22 applied`）。
4. 端口现场实测：起栈前 `Get-NetTCPConnection -State Listen -LocalPort 3310,55536` 零行；收工后同样零行（§12）。

## 12 清理与零残留自证

- 服务已停：`stop.ps1` 退出码 **0**（`Local API and owned PostgreSQL stopped; data retained.`）；`pg_ctl ... status` → **`pg_ctl: no server running`**（退出码 3，预期）；`Get-NetTCPConnection -State Listen -LocalPort 3310,55536` → **0 行**；`Get-CimInstance Win32_Process` 里命令含 `wt-i23-perf` 的 node 进程 → **0 个**。
- 仓库零改动：收工时 `git status --porcelain -uall` 只有本页一条新增（`.local/` 已被 `.gitignore` 的 `/.local/` 忽略，不入库）；`git diff --check` 空。
- **保留**：`.local/local-dev/`（`prepare.mjs` 的产物，gitignored；含本机一次性开发口令与本地 PG 数据目录，**未打印、未入库**）；仓外 `.pg17/tmp/i23-perf/` 下两份**原始 JSON 报告**（明确引用并声明用途的取证文件，§页首给哈希）。
- **删除**：本次探测用的临时脚本与试跑产物（`probe.mjs`／`probe2.mjs`／`dbprobe.mjs`／`cols.mjs`／`extract.mjs`／`dry-*.json`／`*.err`／`*.out.txt`／`commit1.txt`），删除前后均未触碰任何受控文件。
- 未触动的红线：`package.json`、`tests/integration/**`、`tests/unit/ci-integration-chain-structure.test.mjs`、`docs/verification/gy-i24-release-materials-index-20261017.md`、`docs/evaluation/acceptance-thresholds-summary.md`、`packages/evaluation/schema/run-report.schema.json`、`docs/architecture/contract-status.json` 及其生成区、迁移目录（**0 迁移**，`0023` 仍由在飞 #295 占用）。

## 13 边界声明

- 本页是 **#23 的部分证据（条件受限）**：形态齐备、读数可复核，但**条件不满足**需求 §6.2 的原意（真机、需求网络条件、真实供应商、独立压测机）。
- 因此本页**不构成任何条款的达标判定**，**不关闭 #23**，也不改变任何 AC 状态（`docs/architecture/contract-status.json` 与 `docs/evaluation/acceptance-thresholds-summary.md` 均未改动）。
- 性能数字**未**作为任何 CI 通过条件：`package.json` 未新增性能脚本，`.github/workflows/` 未新增性能 job（本片 0 处 CI 改动）。
