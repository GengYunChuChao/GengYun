# R90 开放 issue 验收索引（快照 2026-11-09 00:38 HKT）

本页是继任 R89 版索引页（`docs/verification/gy-r89-open-issue-acceptance-index-20261108.md`）的**快照页**。
它只做三件事：把开放 issue 的号集与档位冻结在某个时刻、把「今天能不能关」的判据写成可复算的形式、
把每条判断指到一个可以逐行回读的锚点。

**本页不是关单依据。** 关不关由监工判；本页只把「main 上有什么 / 缺什么」摊开。

---

## 0. 页首元信息

| 项 | 值 |
| --- | --- |
| 快照时刻（UTC） | `2026-11-08T16:38:58Z` |
| 快照时刻（HKT） | `2026-11-09 00:38:58`（UTC+8） |
| 基线分支 | `origin/main` |
| 基线 SHA（全 40 位） | `c12322e3820d3c7bb170891d7c2b2826fa2d9194` |
| 基线提交时间 | `2026-11-08T16:28:15Z` = `2026-11-09 00:28:15` HKT |
| 基线提交标题 | `test(profile): 钉住手选不依赖定位 (#1107)` |
| 工作树 | `E:\GengYunCommander\.pg17\wt-r90index`（分支 `docs/gy-r90-acceptance-index`） |

**行号口径**：本页所有 `path:line` 的行号都是**基线 `c12322e3820d3c7bb170891d7c2b2826fa2d9194` 那一版**的行号。
main 前进后必须按 §附 B 重算；不要拿本页的行号去核对别的提交。

### 0.1 抓取命令原文

```text
git fetch origin main
git rev-parse origin/main

gh issue list -R GengYunChuChao/GengYun --state open --limit 100 --json number,title,labels,body
gh pr    list -R GengYunChuChao/GengYun --state open   --limit 50  --json number,title,isDraft,headRefName,baseRefName,author,createdAt
gh pr    list -R GengYunChuChao/GengYun --state merged -L 30       --json number,title,mergeCommit,mergedAt
gh run   list -R GengYunChuChao/GengYun -b main -L 40              --json name,status,conclusion,headSha,databaseId,event

gh api  repos/GengYunChuChao/GengYun/issues/<n> --jq .body
```

`gh` 一律带 `-R GengYunChuChao/GengYun`。JSON 落盘时用 `[IO.File]::WriteAllText(path, text, UTF8Encoding(false))`，
不要用 `>` 重定向（PowerShell 的 `>` 会写 UTF-16，`JSON.parse` 直接抛 `Unexpected token`）。

### 0.2 本轮 CI 读数（如实）

`gh run list -b main -L 40` 在基线 `c12322e3` 上取到 **11 个 run，11 个全部 `completed` / `success`**：
Evaluation chain readout、Migrations guard、Auth and consent native PostgreSQL gates、Catalog real PostgreSQL gates、
Failmatrix regression、Consent grant native PostgreSQL gates、Source lifecycle PostgreSQL gates、
Staging intake PostgreSQL gates、Deploy SQL chain gates、Real PostgreSQL integration gates、Engineering shell gates。
（上一版基线 `ed0d37e5` 上是 12 个：多一个 `Development documentation`，因为 `#1107` 只动 `tests/**`，该 workflow 不触发。）

**这 11 个绿只证明一件事**：这些 workflow 里声明的断言组没被删、没被跳过、没整组空转。
它**不**证明断言写对了，也**不**覆盖任何外部资源类判据（真实供应商、真实桶、真机、正式域名）。

---

## 1. 先看这里：本页与 R89 页的五处不同

R89 页写于 `2026-11-08 15:29:30 HKT`（基线 `55f86ef8`）。从那时到现在，main 前进 29 笔，其中 6 笔直接改的是**索引页自己的事实**。

### 1.1 号集 21 → 20：`#1030` 已关

R89 页 §二把 `#1030` 列在「外部条件」，并写「四条 AC 按 `#1037`（`6e7f7465`）落地后重判（真实桶属 `#6` 的 AC，不在此列）」。
**那次重判已经发生，结论是关闭**：

- `#1030` state=`CLOSED` / `state_reason=COMPLETED`，关闭时间 `2026-11-08T15:18:39Z`（`2026-11-08 23:18:39` HKT），
  比 R89 页的快照时刻（`15:29:30` HKT）晚 **7 小时 49 分 09 秒**（`23:18:39 − 15:29:30`），
  所以 R89 页不是写错，是**被后续事件推翻**。
- 关闭评论点名四件事都有实现与可执行断言，并引 reviewed_sha=`80dd2f4dab29b8c0474b3b6cd196a95c3069faae`、
  merge_sha=`fda1c31331caf99f5ae3189c7e0dcd6947bbde3e`（即 PR `#1100`）。
- 收口页 §1.1 的判定行原文：「同帖第 4 张 ⇒ `400 INVALID_REQUEST` + `post_image_limit`（不是 503），新帖 201 且只挂第 4 张。」
  → `docs/verification/gy-r90-i1030-closeout-20261108.md:28`

这是**结论级过期**（不只是行号漂移）：R89 页那一行判的「外部条件」今天不再成立。

### 1.2 档位口径换了，不是换个说法

R89 页 §二 的阻断项列用的是 **依赖未清 / 外部条件 / 待裁定** 三值。
本页按派单口径改四值：**外部条件 / 代码在飞 / 待裁定 / 差证据**。

「依赖未清」**不是一个档位**，它是一个图上的位置。理由见 §3.5：
`#27`/`#28`/`#29` 三张的未清依赖都是空集，可它们一张也关不掉（卡外部、卡真机、卡裁定）。
反过来 `#24` 处在最长链的链头，但它在链上的位置不改变它自己那条 AC 的缺口类型。
→ 用依赖墙去推「能不能关」是**无效推理**，R89 页 §三 把这两件事并列，本页拆开。

### 1.3 推翻 R89 的四处（逐条）

| # | R89 页的说法 | 今天的事实 | 锚点 |
| --- | --- | --- | --- |
| ① | `#1030` 判「外部条件」，等 `#1037` 落地后重判 | 已按该口径重判并**关闭**（COMPLETED） | `docs/verification/gy-r90-i1030-closeout-20261108.md:28` |
| ② | 「今天可关 = 0」的理由里含「依赖未清」 | 依赖全清的 `#27`/`#28`/`#29` 也关不掉；0 张的理由是**每条都缺外部资源或裁定**，与依赖无关 | `docs/verification/gy-r79-demo-readiness-20261106.md:45` |
| ③ | `#19`「去身份是零兑现的策略声明」 | `#1108`（在飞）正在写迁移 0057 与受理事务内擦除 PII，档位由「待裁定」改为**代码在飞** | `services/api/db/migrations/0017_account_suspend_authority.sql:272-273` |
| ④ | §六 自承「未在新基线上复核过全部行号」（基线仍 `55f86ef8`） | 本页全部锚点在 `c12322e3` 上逐行回读命中；读数见 §附 A.1（`bad=0`、`blank=0`） | 无外部锚点：复核读数在 §附 A.1 自报（本页不拿闸门工具的实现行充当「已复核」的证据） |

另外 R89 页 §五 的在飞 PR 三张（`#1083`/`#1082`/`#1081`）今天**全部已合入**，
其中 `#1083` 就是 R89 页自己的 PR（merge `cdbd7d46`）。整表失效，本页 §5 是全新的四张。

### 1.4 本页不继承 R89 的锚点行号

R89 页有一处典型漂移：它把 `tests/integration/egress-ledger-pg.mjs` 的撤回负控制锚在文件前段的块首注释上。
`#1078` 在那个文件前段插了 32 行，那组行号今天已不指任何东西。
本页改锚**可执行断言**：`tests/integration/egress-ledger-pg.mjs:824`
（`assert.deepEqual(afterA[1], beforeA[1], '同用户不同用途的行必须逐字段不变（含 state/revision/error_code/updated_at）');`）。

**通用教训**：注释行不是证据。块首注释会随插入而漂，断言文字不会。

---

## 2. 开放 issue 一览（20 张）

抓取自 `gh issue list --state open --limit 100`，实测 **20 张**，号集为：
`#4 #5 #6 #7 #9 #10 #11 #12 #13 #14 #15 #19 #21 #22 #23 #24 #27 #28 #29 #1003`。
与 R89 页相比**只少了 `#1030`**，其余 20 张号集完全一致，无新增、无重开。

档位取「最卡的那一类」。但「最卡」得能机械复算，所以先把阶梯写死——按「越不可由本仓库自行消解越靠前」排：

| 阶梯 | 档 | 判据：这条 AC 的缺口长什么样 |
| --- | --- | --- |
| 1 | **外部条件** | 必须由本仓库之外的东西满足：真实客户凭据、真实对象存储桶、真机、正式域名与备案、微信主体／类目／隐私指引、供应商开通 |
| 2 | **待裁定** | 缺的是**验收口径本身**：某条 AC 算不算违约、某组读数能不能作关闭依据，只能由监工／架构给口径 |
| 3 | **代码在飞** | 实现已经写出来、躺在未合入 main 的 PR 里，只等合并 |
| 4 | **差证据** | 缺口全部在仓内可补：补实现、补断言、补一次真实读数、补一张证据页；既不需要外部资源，也不需要别人裁定 |

**混合缺口怎么记（本页规则，写下来是为了能复算，不是为了好看）**：逐条 AC 标出缺口类别得到集合 `S`，
`档 = S 里阶梯号最小的一类`，`S = ∅ ⇒ 记「可关」`。等价说法：**一条 AC 卡在更硬的阶梯上，整张就记更硬的那一档**；
不按条数投票、不按缺口体量加权。三条推论，本页第 20 张里都用到了：

- 既缺证据又缺裁定 ⇒ 记**待裁定**（`#7`：3 条仓内可补的读数 + 1 条 `/herbicides` 排序口径裁决）。
- 既缺证据又有外部资源卡着 ⇒ 记**外部条件**（`#4`：AppID 形态已在仓内，缺的是主体／类目／隐私指引／备案）。
- 「关单权在监工」**不**构成待裁定——那是对 20 张一视同仁的权限事实，不是某条 AC 的口径缺口。

按这条阶梯重判，本页第一版的两处自由裁量被改掉：`#7` 从「差证据」改记**待裁定**；`#1003` 从「只差裁定」
改成「仓内读数 + 裁定」（它的适配层只是骨架，一次真实调用都没跑过，见 §6.3）。

**机器口径：怎么从下表第 3 列机械加总**（不重判任何一张，只数行）。取 `## 2.` 之后、`### 2.1` 之前、
以 `| #数字 |` 开头的表体行，按第 3 列分组计数：

```bash
node -e '
const fs = require("fs");
const P = "docs/verification/gy-r90-open-issue-acceptance-index-20261109.md";
const L = fs.readFileSync(P, "utf8").split("\n");
const s = L.findIndex((l) => l.startsWith("## 2. "));
const e = L.findIndex((l) => l.startsWith("### 2.1"));
const rows = L.slice(s, e).filter((l) => /^\| #\d+ \|/.test(l));
const c = {};
for (const r of rows) { const k = r.split("|")[3].trim(); c[k] = (c[k] ?? 0) + 1; }
console.log("rows=" + rows.length, JSON.stringify(c));'
```

实测输出：`rows=20`，外部条件 14 / 待裁定 3 / 代码在飞 1 / 差证据 2
（本机是 PowerShell，`node -e '…'` 的引号会被壳吃掉，所以把同一段存成 `.cjs` 再 `node` 跑，输出与此处一致）。
四个数加起来等于号集张数 20，是本页 §6.2 那张表的唯一来源；`#7` 从差证据挪到待裁定，就是 `3/1/2`
与 `2/1/3` 的差别（差证据／代码在飞／待裁定）。

| # | 标题 | 档 | 还差什么（一句 + 锚点） |
| --- | --- | --- | --- |
| #4 | 实现微信登录、游客限制与服务端归属权限 | 外部条件 | 仓内配的是正式形态 AppID（`wx` 开头 18 位，`project.config.json:5`）；真正缺的是微信主体资质／类目／隐私指引与备案域名，`#27` 在核，`docs/verification/gy-r79-demo-readiness-20261106.md:45` |
| #5 | 实现单作物地区档案及授权定位／手动选择 | 外部条件 | 缺真机「授权定位」读数；「手选不覆盖定位」这一半今天已被断言钉住，`tests/unit/profile-api.test.mjs:533` |
| #6 | 实现私有媒体上传、访问权限及 EXIF 清除 | 外部条件 | 真实审核凭据（B1）与真实对象存储桶（B4）都在用户侧，`docs/verification/gy-r87-i06-i15-ac-evidence-20261108.md:130` |
| #7 | 实现科普／除草剂查询、详情与来源版本展示 | 待裁定 | 收口页 §5 列 4 条未取得：前三条（真实库排序读数、页面证据、来源「未核对」态收口）仓内可补，第四条 `/herbicides` 排序口径要监工／架构给口径 ⇒ 按 §2 混合规则记待裁定，`docs/verification/gy-r29-i07-closure-20261022.md:247`、`docs/verification/gy-r29-i07-closure-20261022.md:261` |
| #9 | 实现实时拍草识别、Top3 核对及不确定处理 | 外部条件 | 真实视觉模型未开通；识别路由已在 main，`services/api/src/routes/recognitions.ts:80` |
| #10 | 实现实时标签 OCR、用户校正及登记精确核对 | 外部条件 | 同上；OCR 路由 `services/api/src/routes/ocr.ts:225`，供应商逐项仍「未验证」，`docs/verification/provider-matrix.md:43` |
| #11 | 实现普通话录音、实时 ASR 转写和发送核对 | 外部条件 | 真实 ASR 未开通；转写路由 `services/api/src/routes/speech.ts:207` |
| #12 | 实现有来源的语音／文字大模型问答与回答安全检查 | 外部条件 | 真实 LLM 未开通；会话路由 `services/api/src/routes/conversations.ts:133` |
| #13 | 实现普通话 TTS、播放球及安全文本自动播报 | 外部条件 | 真实 TTS 未开通；合成路由 `services/api/src/routes/synthesis.ts:119` |
| #14 | 实现文字／图片 AI 筛查、版本重审和失败隔离 | 外部条件 | 审核供应商未接，`retryable:false` 仍 fail-closed，`services/api/src/moderation/service.ts:421-427` |
| #15 | 实现真实社区发帖、评论、点赞、筛选与举报 | 外部条件 | 同 `#6` 的 B1：AC15-1「经真实审核」没有真实读数，`docs/verification/gy-r87-i06-i15-ac-evidence-20261108.md:130` |
| #19 | 贯通注销去身份、在线 7 日备份 30 日删除与恢复验收 | 代码在飞 | 受理态守卫在库层，`services/api/db/migrations/0017_account_suspend_authority.sql:272-273`；去身份擦除由 `#1108` 在写 |
| #21 | 持续评估各项真实 AI 能力并汇总首版验收门槛 | 差证据 | `docs/verification` 下没有 `i21` 页；六类供应商逐项读数，`docs/verification/provider-matrix.md:43` |
| #22 | 完成权限、安全规则及首版端到端失败回归 | 差证据 | 缺证据页自陈「本页不构成关闭声明」，`docs/verification/gy-i22-closure-gap-20261018.md:3` |
| #23 | 执行 Android／iOS 真机、时延容量及完整演示验收 | 外部条件 | 真机走查只记录一次会话、不构成发布验收，`docs/verification/gy-r79-device-walkthrough-20261106.md:5` |
| #24 | 部署联网比赛版、备份恢复并交付完整材料 | 外部条件 | 正式 HTTPS 部署基址未提供，`docs/verification/gy-r79-demo-readiness-20261106.md:47` |
| #27 | 提前验证正式 AppID、真机域名及 AI 和数据库服务接入 | 外部条件 | 微信主体／类目／隐私指引／备案「未在本次范围内核对」，`docs/verification/gy-r79-demo-readiness-20261106.md:45` |
| #28 | 提前建立五 Tab 原生页面骨架、Demo 样式及统一失败状态 | 外部条件 | 缺真机目视；台账闸门只有字节下限、不是画质判据，`tests/reference/i26-tabbar-skeleton.test.mjs:122` |
| #29 | 前置用途授权、外发账本与隐私撤回接口守卫 | 待裁定 | 三域把 provider 异常吞成 `PROVIDER_OUTCOME_UNKNOWN`，验收图记「需另行裁定」，`docs/architecture/acceptance-map.md:299` |
| #1003 | [缺陷] 实时识别接真实视觉模型缺少协议适配层 | 待裁定 | 适配层在 main（`services/api/src/recognitions/openai-vision-adapter.ts:46`），但文件头自述是**骨架**、零真实供应商、**一次真实调用都没跑过**（`services/api/src/recognitions/openai-vision-adapter.ts:22`）；issue 第一条 AC 要「real 下由仓库内实现完成一次真实调用并留证」⇒ 缺口 = 仓内读数 + 裁定（三条「口径建议」能否作关闭依据） |

### 2.1 一个反直觉但重要的读数：元数据不携带验收信号

- 20 张 issue 的 `## 验收` 复选框**一份都没勾**（逐张核对：`unchecked = 条数`、`checked = 0`）。
- 台账 `docs/initial-issues.json` 里，19 张有对应 task 的开放 issue 的 `status` **全部是「待领取」**。
- 唯一有区分度的字段是 `dependencies`（§3 用它）。

**所以本页的档位不是从 issue 元数据抄来的**，是从「代码在不在 main + 证据页自陈缺什么」建的。
把复选框当进度会得出「20 张一条 AC 都没做」的荒谬结论——那是元数据没人维护，不是实现没做。

---

## 3. 依赖墙（独立重算）

R89 页算过「最长 9 节 ×2」。本节**不引用它的结果**，从台账原始 `dependencies` 字段重算，结论一致。

### 3.1 口径与一处必须处理的映射陷阱

台账 `docs/initial-issues.json` 用 `GY-I01 … GY-I27` 编号，issue 用 `#1 … #29` 编号。
前 24 个一一对应，**但 25/26/27 不连续**：

| 台账 id | issue 号 | 台账内的证明 |
| --- | --- | --- |
| `GY-I24` | `#24` | `docs/initial-issues.json:1063`（`"github_number": 24,`） |
| `GY-I25` | `#27` | `docs/initial-issues.json:1109`（`"github_number": 27,`） |
| `GY-I26` | `#28` | （同构，`#28`） |
| `GY-I27` | `#29` | `docs/initial-issues.json:1204`（`"github_number": 29,`） |

把 `GY-I27` 当成 `#27` 会把整张图算歪：`#29` 的未清依赖会被错记到 `#27` 头上。
本页的映射按上表写死。

其余口径：

1. 只保留两端都 **OPEN** 的依赖边；已关 issue 作依赖的边一律剔除（它们不再是门）。
2. 链长按**节点数**计（含链头链尾）。
3. 枚举**全部极大链**（每条简单路径走到不能再走），再筛最大值 —— 不能只跑一遍「取最长」，
   并列时那种写法只会返回其中一条（本页第一版就是这么漏掉第二条链的）。

### 3.2 最长链：9 节，且**恰好 2 条**

```
#27 → #4 → #6 → #14 → #15 → #19 → #22 → #23 → #24     （9 节）
#29 → #4 → #6 → #14 → #15 → #19 → #22 → #23 → #24     （9 节）
```

两条链**只在链头不同**：`#4` 的未清依赖同时含 `#27` 与 `#29`
（`docs/initial-issues.json:136-139` 是 `GY-I04.dependencies` 块，逐字为 `GY-I02`／`GY-I25`／`GY-I27`；
其中 `GY-I02` 已关被剔除，剩下两个映射到 `#27`、`#29` 且都在 OPEN 集内，所以两条都是极大链）。
链尾都是 `#24`（部署与交付），这与常识一致：交付卡在整条链上。

> 方向说明：R89 页反向书写（`#27 → #4 → …`），本页同向；两边是同一张图。

### 3.3 逐张未清依赖（只剩 OPEN 集内）

| issue | 未清依赖 | 可再走几节 |
| --- | --- | --- |
| #4 | `#27`, `#29` | 2 |
| #5 | `#4`, `#28`, `#29` | 3 |
| #6 | `#4`, `#29` | 3 |
| #7 | `#4` | 3 |
| #9 | `#5`, `#6`, `#7`, `#27` | 4 |
| #10 | `#6`, `#7`, `#27` | 4 |
| #11 | `#4`, `#6`, `#27` | 4 |
| #12 | `#7`, `#6`, `#27`, `#29` | 4 |
| #13 | `#28`, `#27`, `#29` | 2 |
| #14 | `#6`, `#27` | 4 |
| #15 | `#4`, `#5`, `#7`, `#14`, `#28`, `#29` | 5 |
| #19 | `#4`, `#6`, `#11`, `#12`, `#15`, `#29` | 6 |
| #21 | `#9`, `#10`, `#11`, `#12`, `#13`, `#14` | 5 |
| #22 | `#5`, `#9`, `#10`, `#12`, `#14`, `#15`, `#19` | 7 |
| #23 | `#19`, `#21`, `#22` | 8 |
| #24 | `#21`, `#22`, `#23` | 9 |
| #27 | （空） | 1 |
| #28 | （空） | 1 |
| #29 | （空） | 1 |
| #1003 | 不在台账 `tasks` 内 | — |

被剔除的已关依赖（供复核，避免误判「凭空消失」）：
`#4→#2`、`#5→#3`、`#6→#2`、`#7→#3`、`#9→#8,#20`、`#10→#8,#20`、`#11→#20`、`#12→#8,#20`、
`#13→#8,#20`、`#14→#3,#20`、`#19→#16,#17,#18`、`#21→#20`、`#22→#8,#16,#17,#18`、`#23→#16,#17,#18`、
`#28→#2`、`#29→#1,#2`。

台账原始字段可回读：`docs/initial-issues.json:1027-1031`（`GY-I24` 的 `dependencies` 块，含 `GY-I21`/`GY-I22`/`GY-I23`）、
`docs/initial-issues.json:1168-1171`（`GY-I27` 的 `dependencies` 块，`GY-I01`/`GY-I02` 已关故整条空）。

### 3.4 复算命令

```bash
node -e '
const fs=require("fs");
const L=JSON.parse(fs.readFileSync("docs/initial-issues.json","utf8"));
const MAP={}; L.tasks.forEach((t,i)=>{MAP[t.id]=t.github_number ?? (i+1);});
const OPEN=new Set([4,5,6,7,9,10,11,12,13,14,15,19,21,22,23,24,27,28,29,1003]);
const deps=new Map();
for(const t of L.tasks){
  const n=MAP[t.id]; if(!OPEN.has(n)) continue;
  deps.set(n,(t.dependencies||[]).map(d=>MAP[d]).filter(x=>OPEN.has(x)));
}
const chains=[];
(function walk(node,path){
  const next=(deps.get(node)||[]).filter(x=>!path.includes(x));
  if(!next.length){ chains.push(path.slice()); return; }
  for(const x of next){ path.push(x); walk(x,path); path.pop(); }
})(24,[24]);
const max=Math.max(...chains.map(c=>c.length));
console.log("max nodes =",max,"count =",chains.filter(c=>c.length===max).length);
chains.filter(c=>c.length===max).forEach(c=>console.log(c.map(n=>"#"+n).join(" -> ")));
'
```

输出应为 `max nodes = 9 count = 2`，两行链与 §3.2 一致。
（脚本在 worktree 根跑，路径相对仓库根。）

### 3.5 依赖墙**不能**用来推「今天能不能关」

这是本页与 R89 页最重要的方法差异：

- `#27`、`#28`、`#29` 三张的未清依赖是**空集**，图上是「无门」。
  但它们分别卡在**正式 AppID/域名/供应商凭据**、**真机目视**、**三域异常口径裁定**，
  一张都关不掉 —— 见 §6。
- `#24` 在最长链的链头，可它自己的 AC 是「比赛版部署 + 备份恢复 + 材料交付」，
  缺的东西和链上任何一张都不重叠（正式 HTTPS 基址未提供）。

**结论**：依赖墙是**排期视图**，不是**验收视图**。把二者混在一张表里，
会得到「等依赖清完就能关」这种既不能证伪、也不能执行的结论。

---

## 4. 已落地证据索引（R89 → R90）

从 `gh pr list --state merged -L 30` 里挑出与本仓验收直接相关的 12 笔。
每行给一句「钉住了哪条 AC」+ 一个**逐行回读命中**的锚点（基线口径见 §0）。

| PR | 合入 SHA | 标题 | 钉住了哪条 AC | 锚点 |
| --- | --- | --- | --- | --- |
| #1078 | `c031023d` | feat(privacy) 撤回导致 job 终态写 `CONSENT_WITHDRAWN` | `#29` AC「撤回后外发终态被守卫阻断」的库侧落点 | `services/api/src/privacy/ledger-pg.ts:889` |
| #1080 | `f7a4d0d9` | ci(privacy) jobs 账本真库臂接进 CI | `#29` AC「第三方删除请求／完成／失败可追溯」有了 CI 真库臂 | `.github/workflows/real-pg-integration.yml:1582` |
| #1081 | `25a8cb70` | ci(media) HTTP 端到端臂接进真库 CI | `#6` AC4 的 HTTP 面（上传上限／挂载释放／503 信封）第一次进 CI | `.github/workflows/real-pg-integration.yml:1772` |
| #1082 | `6df31497` | test(tools) 锚点闸门跳过围栏代码块 + 目标文件不存在零容忍 | 证据页「围栏里抄下来的报文」不再被当成锚点 | `tools/verify-doc-anchors.mjs:415` |
| #1084 | `a0f26d6c` | test(failmatrix) 真库臂加 `--require-no-different` | `#22` AC「权限／安全规则失败回归」必须有判别力，不能「怎么跑都绿」 | `tests/failmatrix/require-no-different.mjs:78` |
| #1093 | `76f647c1` | ci(real-pg) `real-pg-http-17-11` 组数注释 8 组 → ≥11 | `#6` AC4 的读数门槛写实 | `.github/workflows/real-pg-integration.yml:1787` |
| #1095 | `c740995c` | test(ci) 组数闸门 `pass_groups -lt 11` 收进读数守卫 | 把「注释头写的数字」与「闸门里的数字」绑在一条断言上 | `tests/unit/ci-real-pg-readings-gates.test.mjs:1036` |
| #1100 | `fda1c313` | docs `#1030` 收口证据页 | `#1030` 四条 AC 的判定表（§1.1 据此判它已关） | `docs/verification/gy-r90-i1030-closeout-20261108.md:28` |
| #1101 | `85155184` | fix(miniprogram) 重播先停再重播 | `#13` 播放球：重播不叠音、不叠两路播放态 | `miniprogram/utils/audio-playback.js:400` |
| #1102 | `3b06e2c3` | test(community) takedown 正向订阅单测与证据 | `#14` 处置 → 订阅消息的键与版本都取「处置前那一版」 | `tests/unit/community-takedown-subscription.test.mjs:182` |
| #1106 | `ed0d37e5` | docs(env) 登记识别供应商剖面与模型键 | `#1003` 适配层的运维口径（剖面名 + 模型键） | `.env.example:82` |
| #1107 | `c12322e3` | test(profile) 手选不覆盖定位的两条负例 | `#5` AC「手动选择不依赖定位」的负例面 | `tests/unit/profile-api.test.mjs:533` |

### 4.1 这 12 笔里，哪些**不能**当验收证据

- `#1082`、`#1093`、`#1095`、`#1101` 钉的是**工具、CI 读数与小程序播放态**，
  它们保护的是「证据不会被伪造或静默删除」，本身不是任何一条产品 AC 的读数。
- `#1106` 只改 `.env.example` 与 ADR 文本：它让「剖面具名」这件事可核对，
  但**没有**调用过任何真实供应商，不构成 `#1003` 的验收。
- `#1102` 是单测：它钉住了消息契约，但真实审核下这条仍只有替身读数（`#14` 的 B1 未解）。

**一句话**：这 12 笔合起来，钉住的是「断言在、读数门槛在、终态码在」，
不是「真实供应商跑通了」。后者一条都没有。

---

## 5. 在飞 PR（只冻结号集 + 完整标题 + 档位）

抓取时刻 `2026-11-08T16:38:58Z`，`gh pr list --state open` 返回 **4 张**开放 PR，作者均 `Sek1ro-oka`。
这是**抓取调用的原样**，不是「这一时刻的开放集」：按各 PR 的 `createdAt`／`mergedAt` 复算，`16:38Z` 只应有 **3 张**
（`#1108`／`#1110`／`#1111`）。两种口径的差别与复算过程见 §5.2。

| PR | 完整标题 | 档 | 一句职责 |
| --- | --- | --- | --- |
| #1111 | `docs(verification): r87/r88/r89 的 HTTP 臂锚点由块首注释改指行为代码行` | A 档（`docs/pr-review-policy.md:167`） | 把三张证据页的 HTTP 臂锚点从注释移到断言行 |
| #1110 | `docs(verification): #1030 收口页自述过期与弱锚点修正（#1103 后续 nit）` | A 档（`docs/pr-review-policy.md:167`） | 修收口页里已过期的自述与偏弱的锚点 |
| #1109 | `docs(verification): 修正 R89 索引页两处已证伪事实与两处锚点` | A 档（`docs/pr-review-policy.md:167`） | 修 R89 索引页的两处事实与两处锚点 |
| #1108 | `[GY-I19] 注销去身份：迁移 0057 + 受理事务内擦除 PII（#19 片1）` | B 档（`docs/pr-review-policy.md:173`，动 `services/api/db/migrations/**`） | `#19` 的第一片：去身份擦除 |

### 5.1 为什么本页不写 head / mergeable / 状态

R89 页第一版写了这三类字段，结果**抓取到落盘之间**四行里三行已不成立，被一个 P1 打回。
今天这半小时内，开放 PR 从 2 张走成 3 张、4 张，再落回 3 张（`#1107` 在 16:28:15Z 合入；`#1109`/`#1110`/`#1111` 在
16:25:06Z–16:31:13Z 陆续开出；`#1109` 又在 16:37:39Z 合入）。
**这类分钟级字段在本页的载体上一定会过期**，所以本页只冻结「号 + 标题 + 档 + 职责」——
这四项的过期速度是天级，不是分钟级。

`#1108` 的档位判 B 而不是 A，只因为它动 `services/api/db/migrations/**`
（`docs/pr-review-policy.md:173` 明确把这个目录划在正面清单之外）；与实现质量无关。

### 5.2 两种口径：抓取调用的原样 vs 用 REST 时间线复算

这张表有两件事必须分开写，混在一起就是 R89 页被打回的同一类错：**「查询返回了什么」不等于「那一刻的开放集」**。

**口径一：抓取调用的原样。** §5 那四行，就是 `gh pr list --state open` 在 `2026-11-08T16:38:58Z` 返回的东西。
`#1109` 的 `mergedAt` 是 `2026-11-08T16:37:39Z`（`mergeCommit=a043bf8e12bb178d76cd6eb75dd904c67d655d5c`，
`headRefName=docs/gy-r89-index-facts3`），比抓取早 79 秒，可它仍然被这次查询返回了。本页没有回头把那行删掉——
删了就等于「宣称一个我没有观测到的集合」。这张表只有一种读法：**抓取那一刻，API 返回了什么**。

**口径二：用每个 PR 自己的 `createdAt`／`mergedAt` 复算任一时刻的开放集。** 这是另一件事：`#1109` 从 `16:37:39Z`
起就不再是开放 PR，所以按时间线复算，`16:38Z` 的开放集是 **3 张**，不是 4 张。两个口径给出不同答案不是谁在撒谎：
一个是「服务端这次返回的列表」（允许滞后），一个是「按合并时刻切出来的瞬时集合」（不允许滞后）。
**本页第一版把 `16:38Z` 记成 4 张，就是把两者混用了**——同页自己写着 `#1109` 在 `16:37:39Z` 合入，却把它算进了 79 秒后的开放集。

按时间线逐张核过 `createdAt`／`mergedAt`，三个时刻的开放集是这样：

| 时刻（UTC） | 开放集（时间线复算） | 张数 | 这一刻的前后 |
| --- | --- | --- | --- |
| `16:24Z` | `#1107`、`#1108` | **2** | `#1108` 于 `16:20:17Z` 开出；`#1107` 要到 `16:28:15Z` 才合入 |
| `16:38Z` | `#1108`、`#1110`、`#1111` | **3** | `#1109` 已于 `16:37:39Z` 合入而消失；`#1112` 要到 `16:41:07Z` 才开出 |
| `16:46Z` | `#1108`、`#1110`、`#1111`、`#1112`、`#1113` | **5** | `#1112`（`16:41:07Z`）、`#1113`（`16:43:11Z`）已开出，分别在 `16:46:51Z`／`16:48:20Z` 合入 |

**「4 张」不是凭空来的**：它对应 `16:31:13Z`（`#1111` 开出）到 `16:37:39Z`（`#1109` 合入）那 **6 分 26 秒**的窗口。
谁在那 6 分钟里抓，看到的就是 4 张；在 `16:38Z` 抓，时间线口径只认 3 张。抓取发生在 `16:38:58Z`，
比 `#1109` 合入晚 79 秒，而返回列表里还带着它——这就是两个口径的全部差别。

还有一处今天才算得清：这张表里 `#1110`／`#1111` 后来**都未合并即关闭**（`16:58:08Z`／`17:05:06Z`，分别由 `#1115`／`#1116` 承接），
所以四行里只有 `#1109` 真的合入了 main。这不改变读法——本页冻结的是那一刻的号集，不是「它们后来怎样」。

要当前值就直接跑 §0.1 的第一条命令。§7 第 6 条已把「那张表不是全集」写进不声称清单。

---

## 6. 三档计数与逐张理由

### 6.1 判据（先写清，再看结果）

| 档 | 判据 |
| --- | --- |
| **今天可关** | 该 issue 的**全部** AC 在 main 上都有可执行断言**或**逐条证据页；且没有一条依赖外部资源或未定裁定 |
| **差一条** | **恰好一条** AC 未满足，且缺口在仓内可补（不需要等外部资源、不需要等裁定） |
| **不该关** | 有 **≥2 条** AC 未满足；**或**至少一条 AC 必须等外部资源／等裁定 |

「未满足」以证据页自己的自陈为准（`未取得` / `部分实现` / `未覆盖` 都算），
不以 issue 复选框与台账 status 为准（§2.1 已说明它们不携带信号）。

### 6.2 计数

| 档 | 张数 | 号 |
| --- | --- | --- |
| 今天可关 | **0** | — |
| 差一条 | **0** | — |
| 不该关 | **20** | `#4 #5 #6 #7 #9 #10 #11 #12 #13 #14 #15 #19 #21 #22 #23 #24 #27 #28 #29 #1003` |

三档与 §2 的四值是两个正交视图，不要互换：**四值讲「缺口长什么样」**（§2 表第 3 列按机器口径加总 =
外部条件 **14** / 待裁定 **3** / 代码在飞 **1** / 差证据 **2**，合计 20）；**三档讲「今天能不能关」**（0 / 0 / 20）。
20 张在四值里全部落在「不可关」那一侧，所以三档只有一格有数——这正是四值口径的用处：
它能区分「等外部」「等口径」「等合并」「等自己补证据」，而三档只回答是／否。

**「差一条 = 0」不是没查，是查了之后一条都不够格。** 最容易误判成「差一条」的两张是 `#7` 与 `#1003`：

- `#7` 的收口页 §5 一次列了 **4 条**未取得（真实库排序读数、面向最终用户的页面证据、
  来源「未核对」态收口、`/herbicides` 排序口径裁决）→ `docs/verification/gy-r29-i07-closure-20261022.md:247`
  与 `docs/verification/gy-r29-i07-closure-20261022.md:259`。四条，不是一条。
  其中前三条（真实库排序读数、页面证据、来源「未核对」态收口）是仓内可补的读数，第四条要监工／架构给口径
  （同页 `docs/verification/gy-r29-i07-closure-20261022.md:261`）⇒ 按 §2 的混合规则记**待裁定**。
- `#1003` 的适配层已经在 main 上，看起来「只差关单」；但它是**骨架**：文件头自述零真实供应商、
  零真实调用、零准确率证据（`services/api/src/recognitions/openai-vision-adapter.ts:22`），而 issue 第一条
  验收口径要「real 下由仓库内实现完成一次真实调用并留证」——**一次真实调用都没跑过**。
  所以它的缺口是「仓内读数 + 裁定」（三条「口径建议」能否作为关闭依据），按 §6.1 落「不该关」而非「差一条」。

### 6.3 逐张理由

| # | 结论 | 理由（一句） |
| --- | --- | --- |
| #4 | 不该关 | AC 要正式主体下的登录读数；仓内配的已是正式形态 AppID（`project.config.json:5`，`wx` 开头 18 位），缺的是微信主体资质／类目／隐私指引与备案域名（`docs/verification/gy-r79-demo-readiness-20261106.md:45`） |
| #5 | 不该关 | 「授权定位」需真机，「手选」那一半今天已有断言（`tests/unit/profile-api.test.mjs:533`），只补了一半 |
| #6 | 不该关 | 4 条 AC 里 3 条标「部分实现」，且卡真实审核凭据 + 真实桶（`docs/verification/gy-r87-i06-i15-ac-evidence-20261108.md:130`） |
| #7 | 不该关 | 收口页自列 4 条未取得（`docs/verification/gy-r29-i07-closure-20261022.md:247`），其中第 4 条是口径裁决（`docs/verification/gy-r29-i07-closure-20261022.md:261`）⇒ 3 条仓内 + 1 条裁定，仍 ≥2 条 |
| #9 | 不该关 | 真实视觉模型未开通，AC 的「Top3／不确定处理」没有真实读数（`services/api/src/routes/recognitions.ts:80` 只证明路由在） |
| #10 | 不该关 | 同 `#9`；供应商逐项仍是候选未验证（`docs/verification/provider-matrix.md:43`） |
| #11 | 不该关 | 真实 ASR 未开通（`services/api/src/routes/speech.ts:207` 只证明转写路由在） |
| #12 | 不该关 | 真实 LLM 未开通；「有来源」的引用读数在真实问答下未取（`services/api/src/routes/conversations.ts:133`） |
| #13 | 不该关 | 真实 TTS 未开通；合成路由在 main 不等于真实合成读数（`services/api/src/routes/synthesis.ts:119`） |
| #14 | 不该关 | 审核供应商未接，实现按 `retryable:false` fail-closed，属外部条件（`services/api/src/moderation/service.ts:421-427`） |
| #15 | 不该关 | AC15-1「经真实审核」无真实读数，B1 仍在用户侧（`docs/verification/gy-r87-i06-i15-ac-evidence-20261108.md:130`） |
| #19 | 不该关 | 去身份擦除在 `#1108` 里改（代码在飞），未并 main，本页不给读数 |
| #21 | 不该关 | 没有任何逐条证据页，六类供应商读数全为候选（`docs/verification/provider-matrix.md:43`） |
| #22 | 不该关 | 缺证据页自陈「本页不构成关闭声明」，且定级权在监工（`docs/verification/gy-i22-closure-gap-20261018.md:3`） |
| #23 | 不该关 | 真机／容量读数只到「一次会话」的量级（`docs/verification/gy-r79-device-walkthrough-20261106.md:5`） |
| #24 | 不该关 | 正式部署基址未提供（`docs/verification/gy-r79-demo-readiness-20261106.md:47`），材料交付依赖它 |
| #27 | 不该关 | 主体／类目／隐私指引／备案未核对（`docs/verification/gy-r79-demo-readiness-20261106.md:45`） |
| #28 | 不该关 | 缺真机目视；台账闸门只有 8192 字节下限，不是画质判据（`tests/reference/i26-tabbar-skeleton.test.mjs:122`） |
| #29 | 不该关 | 三域异常口径待裁定（`docs/architecture/acceptance-map.md:299`），裁定前不能判过 |
| #1003 | 不该关 | 适配层在 main（`services/api/src/recognitions/openai-vision-adapter.ts:46`），但只是骨架、**一次真实调用都没跑过**（`services/api/src/recognitions/openai-vision-adapter.ts:22`）；关闭依据另需裁定 |

### 6.4 离可关最近的几张（按仓内还能自己补的条数排）

排序键 = **仓内还能自己补的条数**（升序），并列按 issue 号。这个键只回答「本仓库还能推进多少」，
不回答「离关闭多近」——后者还取决于别人给口径的快慢。

| 排序 | # | 仓内可补 | 缺口是什么 | 谁能让它动 |
| --- | --- | --- | --- | --- |
| 1 | #19 | 0（等合并） | 去身份擦除落 main | `#1108` |
| 2 | #29 | 0（等口径） | 三域异常吞成 `PROVIDER_OUTCOME_UNKNOWN` 是否保留原码 | 监工／架构 |
| 3 | #1003 | 1（一次真实调用 + 留证） | 骨架适配层要在 real 下完成一次真实调用并留证；三条「口径建议」能否作关闭依据另需裁定 | 本项目 + 监工／架构 |
| 4 | #7 | 3 | 见 §6.3 | 本项目 + 监工（1 条裁决） |

**注意这四张都不是「差一条」**：`#19` 等 PR 合并、`#29` 等口径、`#1003` 要一次真实调用再加一次裁定、
`#7` 是 4 条（3 条仓内 + 1 条裁决）。这正是 §6.2「差一条 = 0」的由来。

---

## 7. 不声称清单

1. **不代监工判定**：本页的档位与「不该关」都是**描述**，不是批复。关单权、AC 判定权在监工。
2. **不代关单**：本页不关任何 issue，也不建议在什么时间关。
3. **不声称 CI 读数覆盖全部判据**：§0.2 的 11 个绿只证明断言组没被删／没被跳过，
   不覆盖任何外部资源类判据（真实供应商、真实桶、真机、正式域名）。
4. **不声称外部资源已具备**：真实审核凭据、真实对象存储桶、正式 AppID、备案域名、真机——
   本页逐条记为「未提供／未核对」，没有任何一条被本页当作已就绪。
5. **不声称锚点全对**：本页只声称「§附 A 列出的那些锚点，在本页写入时于基线 `c12322e3` 上逐行命中」。
   main 前进后行号会漂，锚点会失效——那时代码没错，是本页过期了。
6. **不声称在飞 PR 的状态，也不声称那张表的号集是全集**：§5 只冻结号集、标题、档位与职责；
   head／mergeable／review 状态本页一律不记；那张表是抓取调用的原样，不是「任一时刻的开放集」（§5.2）。
7. **不声称 `#1030` 的关闭是本页的功劳或判断**：它的关闭是监工在 `2026-11-08T15:18:39Z` 做的，
   本页只是记录「R89 页那一行因此过期」。
8. **不声称依赖墙等价于验收进度**：§3.5 已单列理由。

---

## 附 A. 锚点自校（写入时实测）

口径：把本页出现的每一个 `path:line`（含 `path:a-b` 区间）交给脚本，
逐个打开文件、打印该行原文、标出空行；命中 = 文件存在 且 该行非空。

| 读数 | 值 |
| --- | --- |
| 锚点总数（occurrences） | **78** |
| 去重后（unique，区间按区间计） | **42** |
| 空行／越界命中 | **0** |
| 裸 `:NNN`（无路径前缀） | **0** |
| 未命中（文件不存在或该行空白） | **0** |

自校脚本（worktree 根执行，只读）：

```bash
node -e '
const fs=require("fs"), path=require("path");
const page="docs/verification/gy-r90-open-issue-acceptance-index-20261109.md";
const text=fs.readFileSync(page,"utf8");
const re=/`([A-Za-z0-9_.\/-]+\.(?:md|mjs|js|ts|json|yml|yaml|sql|example)):(\d+)(?:-(\d+))?`/g;
const seen=new Set(); let total=0, bad=0;
for(const m of text.matchAll(re)){
  const key=m[1]+":"+m[2]; total++; seen.add(key);
  const lines=fs.readFileSync(m[1],"utf8").split(/\r?\n/);
  const from=+m[2], to=m[3]?+m[3]:from;
  for(let i=from;i<=to;i++){
    const t=(lines[i-1]??"").trim();
    if(t===""){ console.log("BLANK "+m[1]+":"+i); bad++; }
  }
}
console.log("anchors="+total+" unique="+seen.size+" blank="+bad);
'
```

### A.1 写入时的实测读数

```
anchors=78 unique=42 bare=0 blank=0
```

复跑方式见上面的脚本；`bare=0` 是人工核对：本页没有任何一处只写行号不写路径。
`unique=42` 与 `anchors=78` 的差额来自 §6.3 逐张理由把 §2 的同一批锚点又写了一遍（便于单表直读）。

**这个脚本只判「非空」，不判「实质」。** 所以本轮另做了一次逐条回读：把 78 处 occurrences 全部打开目标文件、
打印该行的原文、逐条确认它落在**实质行**（断言行、表体行、迁移语句、导出声明、标题行）而不是空行、
块首注释或无关行——78 条全部命中实质行，0 条需要改锚。这一页不拿锚点闸门工具的实现行充当「已复核」的证据
（§1.3④ 的旧锚点因此删掉，`tools/verify-doc-anchors.mjs` 在本页只出现在 §4 讲闸门行为的那一行）。

**本轮（P2 修订）相对第一版的锚点变化**：删 1 处（§1.3④ 拿工具实现行充当复核证据的那一处），
新增 8 处（收口页第 4 条的裁决段 ×3、骨架自述行 ×3、就绪页第 45 行 ×2）⇒ `71 → 78`、`unique 40 → 42`
（裁决段与骨架自述行各是一个新键；就绪页第 45 行与 §2 `#27` 行原有的同锚去重后不增 unique）。

---

## 附 B. main 前进后怎么重算

1. 先重取基线：`git fetch origin main && git rev-parse origin/main`。
2. 重抓三份清单（§0.1 的命令原文），核对号集是否仍是 20 张；在飞 PR 那 4 张只是抓取原样（§5.2），不是应然值。
3. 依赖墙：直接跑 §3.4 的脚本；`docs/initial-issues.json` 若没动，结果应一字不差。
4. 锚点：跑 §附 A 的脚本。**指到注释行的锚点优先换成断言行**——注释行会随插入漂，断言文字不会。
5. 若 §0.2 的 run 数变了，先弄清是「new workflow」还是「旧 workflow 没触发」（`#1107` 只动 `tests/**`
   就少了 `Development documentation`），不要把「少了一个 run」误读成「CI 红了」。
6. 写作窗口内 `origin/main` 前移了 3 笔：`a043bf8e`（`#1109`）、`ed423956`（`#1112`）、`64970316`（`#1113`）。
   `git diff --name-only c12322e3 64970316` 只有 5 个文件：R89 索引页、新增的
   `docs/verification/gy-r90-ci-gate-prose-consistency-20261109.md`、`tests/unit/ci-gate-prose-consistency.test.mjs`、
   `tests/unit/miniprogram-voice-hardening.test.mjs`、`tests/unit/doc-anchor-relocations.json`。
   这 5 个文件**与本页 30 个被锚文件零交集**，所以这三笔不移动本页任何行号。
   但下一笔未必如此：要重算就从 §附 A 的脚本跑起，不要相信这一行。
