# R69 用途政策导入：重放/启用的**元数据一致性**（2026-10-30）

> 切片：`R69` 返修（监工 B 档「真实性阻塞」）。
> 分支 `feat/gy-r69-consent-policy-import`；worktree `E:\GengYunCommander\wt-r69-consent-import`。
> 基线：`git fetch upstream --prune` + `git fetch origin --prune` 后并入 `upstream/main`（`8f586061`），
> 合并提交 `c38ab906`；返修起点 `3ad6c1e9`（PR `#763`）。
> 本片**只动** `tools/**`、`tests/**`、`docs/**`；未改 `services/api/src/**`、未改迁移/触发器/授权。

## 1 监工说的缺陷（本页要回答的那一条）

> 同版本、同正文 sha 的重放**只比较正文，不核库行的来源/有效期/绑定等元数据** …… 于是可以判 `unchanged`；
> 报告却直接打印**新清单**的 `source_kind`/`source_ref`/`valid_until`/`reviewed_by`。
> 对未启用草稿，同一路径还会**启用旧元数据**而非本次复核的清单。

一句话：**「重放成功」被当成了「库里那一行就是这份清单」的证据**，而它当时只是「正文 sha 相同」的证据。
后果是把没真正导入的来源与有效期说成已生效。

## 2 修前读数（同一场景，旧实现）

做法：把 `git show 3ad6c1e9:tools/lib/consent-policy-import.mjs` 落到仓外（`.r69-negctl/old-lib.mjs`，
只把两条相对 `import` 改写成 `file://` 绝对路径），喂同一个场景，跑旧 `planConsentPolicyImport` 与
旧 `renderPolicyImportReport`。**无网络、无 DB、不碰仓内文件。**

场景：库行 `synthetic` + `valid_until=2026-10-02`（已过期）+ `enabled=true`；清单 `verified` +
`valid_until=2027-10-01` + 同版本 + 同正文；库钟 `2026-10-30`。

```
BEFORE action=unchanged unchanged=true enabled_after=true
BEFORE source_kind=verified
BEFORE source_ref=https://policy.gengyun.app/consent/v2
BEFORE valid_until=2027-10-01T00:00:00.000Z
BEFORE reviewed_by=0f8fad5b-d9cb-469f-a165-70867728950e
LIBRARY 行（真值）：source_kind=synthetic / valid_until=2026-10-02T00:00:00.000Z / enabled=true
```

⇒ 监工那条探针在**本树**上逐字复现：`unchanged` + 报告 `verified` / 2027-10-01，库行仍是 `synthetic` 且过期。

旧实现的三处事实（`3ad6c1e9` 上）：

1. `tools/import-consent-policy.mjs` 的现库行查询只取 `id,purpose,policy_version,content_sha256,enabled,reviewed_at`
   —— **来源 / 有效期 / 复核主体 / 绑定四类列根本没读**；
2. `planConsentPolicyImport` 在「同版本 + 同 sha」之后直接返回 `unchanged`（或在 `--enable` 时返回 `enable`），
   没有可比的第二组数据；
3. `renderPolicyImportReport` 的入参只有清单对象（`policy`），于是 `source_kind` / `valid_until` /
   `reviewed_by` 只能来自清单 —— 它连「库行」这个信息都没有。

三条串起来才是缺陷：**第 1 条让第 2 条无从判断，第 3 条把「不知道」印成了「已生效」。**

## 3 改了什么（四处，全部在 `tools/**` 内）

### 3.1 SELECT 取全安全元数据列

`tools/import-consent-policy.mjs:111` 新增列清单常量 `SELECT_POLICY_ROW_COLUMNS`，现库行查询与「写后读回」
共用它，取出的列：

`id` / `purpose` / `policy_version` / `content_sha256` / `enabled` / **`source_kind`** / **`source_ref`** /
**`review_evidence_ref`** / **`valid_from`** / **`valid_until`** / `reviewed_at` /
**`reviewed_by::text`** / **`recipient_bindings`**。

`reviewed_by` 取 `::text` 是为了拿到小写 uuid 字符串（与 `--reviewed-by` 同形状可比），
`recipient_bindings` 取 `jsonb` 由驱动解析成对象。

### 3.2 `unchanged` 的新判据：正文 sha **且** 七列元数据全等

`tools/lib/consent-policy-import.mjs:138` 定义 `POLICY_SAFETY_METADATA_FIELDS`，
`tools/lib/consent-policy-import.mjs:635` 的 `comparePolicySafetyMetadata` 逐列比，
`tools/lib/consent-policy-import.mjs:731` 在 `planConsentPolicyImport` 里**紧跟 sha 判定之后、enable 判定之前**调用它。

| 维度 | 判据 | 例外（不算冲突） | 为什么 |
| --- | --- | --- | --- |
| `source_kind` | 逐字相同 | — | 决定「真来源」还是「合成」 |
| `source_ref` | 逐字相同 | — | 决定出处 |
| `review_evidence_ref` | 逐字相同 | — | 决定复核依据 |
| `valid_until` | 同一时刻（`…Z` 与 `….000Z` 归一） | — | 决定这一行还在不在有效期内 |
| `recipient_bindings` | 稳定键序 JSON 逐字段相同（键序不同不算不同） | — | 决定这一行能派给谁 |
| `valid_from` | 清单声明了就比同一时刻 | 清单省略 ⇒ 跳过 | 库列由库钟生成，清单没有可断言的值 |
| `reviewed_by` | 命令行 `--reviewed-by` 断言了才比 | ① 没给 `--reviewed-by`；② 库行仍是 `null`（草稿，本次启用正要写它） | 谁复核是命令行断言，不是清单字段 |

另有一条**防御性**判据：库行**缺列**（调用方 `SELECT` 没取全）一律判冲突 —— 读不到不能证明相等。
这条正好守住 3.1 那处：若将来有人把某列从 SELECT 里删掉，结果是 exit 4，而不是静默 `unchanged`。

### 3.3 报告只报库行

`tools/lib/consent-policy-import.mjs:824` 的 `renderPolicyImportReport` 现在接收一个 `row`（实际库行）：

| 键 | 取值 |
| --- | --- |
| `metadata_source` | `library_row` / `none` |
| `source_kind` / `source_ref` / `review_evidence_ref` / `valid_from` / `valid_until` / `reviewed_by` | 库行（规范化文本）；没有行 ⇒ `(未写入)` |
| `recipient_bindings` / `recipient_binding_ids` | 库行的条数与键名；没有行 ⇒ `(未写入)` |
| `request_reviewed_by` | 命令行断言（请求），与库行的 `reviewed_by`（事实）分开列 |
| `manifest_*` | **只在没有库行时**出现，供 dry-run 预览，⛔ 不用裸键冒充库行状态 |

库行从哪来：`tools/import-consent-policy.mjs:328`（重放/dry-run 传 `existingTarget`）、
`tools/import-consent-policy.mjs:385`（写入后**同事务内**按 id 读回，读不回就拒绝提交）、
`tools/import-consent-policy.mjs:392`（把那一行交给报告）。于是「报告说 verified、库里还是 synthetic」
在结构上没有第二条取值路径。

### 3.4 `--enable` 先过一致性关

`--enable` 的目标行必须先通过 3.2 的逐列比对，才进入「关掉其它行 + 开目标行」那一段。
未启用草稿若与清单不一致 ⇒ 冲突、零写，**不会把旧元数据开起来**。

### 3.5 新错误类

| 项 | 值 |
| --- | --- |
| 类别码 | `METADATA_CONFLICT`（`tools/lib/consent-policy-import.mjs:177`） |
| 退出码 | **4**（`POLICY_CONFLICT` 的细分标签，不新增退出码） |
| 报错形状 | 逐字段 `字段: 库行 <旧值> → 清单 <新值>`，⛔ 不含正文 |
| 触发点 | 同版本重放、同版本 `--enable`、库行缺列 |

纯逻辑探针（无 process 环境、无网络、无 DB）输出的 `reason` **原文**：

```
同 (purpose, policy_version) 已存在，但安全元数据与清单不一致（source_kind: 库行 synthetic → 清单 verified；
source_ref: 库行 fixture://consent-import/policy-terms → 清单 https://policy.gengyun.app/consent/v2；
review_evidence_ref: 库行 fixture://consent-import/policy-review → 清单 https://policy.gengyun.app/review/v2；
valid_until: 库行 2026-10-02T00:00:00.000Z → 清单 2027-10-01T00:00:00.000Z）。这一行不能就地改
（0009 的 consent_policy_immutable 只放 enabled/updated_at），所以「重放」不能把它变成清单说的样子：
要么改用新的 policy_version，要么按库行现状处理 —— ⛔ 不许把清单的来源/有效期/复核主体当成已生效。
```

命令行把它打印成 `[import-consent-policy] METADATA_CONFLICT: <上面这段>` 并以 4 退出。

## 4 用例读数

`tests/unit/consent-policy-import.test.mjs`：24 条 ⇒ **30 条**（新增 6 条，改写 2 条）。
本机真 PG 17.11（`$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'`）：
`tests 30 / pass 30 / fail 0 / skipped 0`；无 `GY_PG_BIN` 时同一文件 `pass 29 / skipped 1`（显式 SKIP 原因）。

| 新增/改写 | 用例（行号为 `tests/unit/consent-policy-import.test.mjs`） | 钉住什么 |
| --- | --- | --- |
| 新增 | `tests/unit/consent-policy-import.test.mjs:601` 监工场景 | 库行 `synthetic`+过期、清单 `verified`+未来有效期、同版本同正文 ⇒ `METADATA_CONFLICT`、exit 4、**无 action**（不会去写） |
| 新增 | `tests/unit/consent-policy-import.test.mjs:648` 六类「只差这一列」 | 见 §4.1；并含一条正控制：逐列一致 ⇒ 仍 `unchanged` |
| 新增 | `tests/unit/consent-policy-import.test.mjs:687` 元数据读不全 | 七个字段逐个删一列 ⇒ 冲突；整行缺失也冲突 |
| 新增 | `tests/unit/consent-policy-import.test.mjs:705` `reviewed_by` 特例 | 草稿（`reviewed_by=null`）可启用；已有他人复核 ⇒ 冲突（`COALESCE` 会让本次复核静默不生效） |
| 新增 | `tests/unit/consent-policy-import.test.mjs:726` `valid_from` | 清单未声明 ⇒ 跳过；声明了不同时刻 ⇒ 冲突；同一时刻两种写法不算不同 |
| 新增 | `tests/unit/consent-policy-import.test.mjs:745` 报告逐字段等于库行 | 七个键按库行渲染；`(未写入)` 与 `manifest_*` 的分工 |
| 改写 | `tests/unit/consent-policy-import.test.mjs:538` dry-run 报告 | 首次插入时安全元数据键打印 `(未写入)` + `metadata_source=none` |
| 改写 | 退出码映射 | `exitCodeFor(METADATA_CONFLICT) === 4`，且与 `POLICY_CONFLICT` 可区分 |

### 4.1 六类「只差这一列 ⇒ 冲突」逐条读数

| 只差 | 库行值 | 清单值 | 是否冲突 | 报错点名 |
| --- | --- | --- | --- | --- |
| `source_kind` | `synthetic` | `verified` | 是 | `source_kind: 库行 synthetic → 清单 verified` |
| `source_ref` | `fixture://consent-import/policy-terms` | `…-v2` | 是 | `source_ref: 库行 … → 清单 …` |
| `valid_from` | `2026-09-01T00:00:00Z` | `2026-10-01T00:00:00Z` | 是 | `valid_from: 库行 … → 清单 …` |
| `valid_until` | `2098-12-31T00:00:00Z` | `2099-12-31T00:00:00Z` | 是 | `valid_until: 库行 … → 清单 …` |
| `reviewed_by` | `11111111-2222-4333-8444-555555555555` | `0f8fad5b-…` | 是 | `reviewed_by: 库行 … → 清单 …` |
| `recipient_bindings` | `{}` | `{ 'fixture-llm': … }` | 是 | `recipient_bindings: 库行 {} → 清单 {…}` |
| 正控制：全等 | — | — | 否（`unchanged`） | — |

另有第七维（同一把尺子也管复核证据）：`review_evidence_ref` 不同 ⇒ 同样冲突。

### 4.2 真 PG17 集成：14 条 ⇒ 17 条读数

新增的三条（`tests/unit/consent-policy-import.test.mjs:925` 起的集成用例内）：

```
PASS 15: 重放报告逐字段等于库行：source_kind/source_ref/review_evidence_ref/valid_from/valid_until/
         reviewed_by/绑定条数 全部取自库行（valid_from=2026-10-30T07:19:07.143Z）
PASS 16: 监工场景（真库）：exit 4 + METADATA_CONFLICT + 点名 source_kind/valid_until 的旧值→新值，
         整行快照逐字段不变（零写、未启用）
PASS 17: 库行过期 ⇒ 即使清单如实写 synthetic + 同一个过期日，也会在内容校验被拒（exit 3）
         ⇒ 过期行不可能被说成已生效
```

三条的判据分别是：

- **PASS 15**：`reportValue(replay.stdout, key)` 逐字等于 `snapshot()` 里那一行的值（含 `valid_from`
  这个清单没声明的列 —— 旧代码这里打印的是「由库里的 `clock_timestamp()` 决定」）；
- **PASS 16**：退出码 4、`stderr` 命中 `METADATA_CONFLICT` 与两处「旧值→新值」、输出里**没有**
  `transaction=commit` 也没有 `unchanged=true`、正文行不出现；`snapshot()`（含 `xmin` / `enabled` /
  `reviewed_by`）与执行前**逐字段相等**，且那一行仍是 `enabled=false` / `reviewed_by=null` /
  `source_kind=synthetic`；
- **PASS 17**：把清单改成「与库行一致但已过期」⇒ exit 3（`valid_until` 不晚于库钟），库内仍零写。
  这条堵住「那我干脆把清单写成过期日期」的绕法。

## 5 四条负控制（实际打红 → 恢复复绿）

驱动器在仓外（`E:\GengYunCommander\.r69-negctl\negctl.mjs`）：备份原文 → 只改**一处** → 跑整个
`consent-policy-import.test.mjs`（含真 PG 集成）→ 从备份恢复。四次恢复后
`tools/lib/consent-policy-import.mjs` 的 sha256 与备份**逐字节相同**（`FE0025383BBB…B4AF6`）。

| # | 改坏什么 | 读数（`ℹ pass / ℹ fail`） | 红点（首条断言） | 恢复后 |
| --- | --- | --- | --- | --- |
| ① | 把 `source_kind` 从 `POLICY_SAFETY_METADATA_FIELDS` 里删掉 | 26 / **4** | `The input did not match /source_kind: 库行 synthetic → 清单 verified/`（监工场景）；`只差 source_kind 必须冲突，实测 {"ok":true,"action":"unchanged",…}` | 30 / 0 |
| ② | 报告改回按清单渲染（`fromRow` 直接取 `manifestMetadataValue`） | 27 / **3** | `没有库行时 source_kind 必须是 (未写入)，不是清单值`（实际 `synthetic`）；`报告 valid_from 必须逐字等于库行（不是清单）`（实际 `(null)`） | 30 / 0 |
| ③ | 元数据不一致时返回 `{ ok: true, action: 'unchanged' }` | 25 / **5** | `同版本元数据不一致必须冲突，⛔ 不许判 unchanged`（actual `true`）；`只差 source_kind 必须冲突，实测 {"ok":true,"action":"unchanged",…}` | 30 / 0 |
| ④ | 在比对循环里单独放过 `valid_until` | 26 / **4** | `The input did not match /valid_until: 库行 2026-10-02T00:00:00.000Z → 清单 2027-10-01T00:00:00.000Z/`；`只差 valid_until 必须冲突，实测 {"ok":true,"action":"unchanged",…}` | 30 / 0 |

四条都同时打红了**真 PG 集成**那一条（说明不是纯逻辑层的装饰性断言）。①③④ 改的是判定，
②改的是报告 —— 与监工指出的两个半边（判错 + 印错）一一对应。

## 6 门禁读数（本机 2026-10-30；八条 exit 0，`build` 被宿主环境卡住）

| 门禁 | 读数 | exit |
| --- | --- | --- |
| `npm run test:unit` | `tests 5953 / pass 5949 / fail 0 / cancelled 0 / skipped 2 / todo 2`；`✖ failing tests:` 标题下的两条是既有 `todo` 的 I11 缺口本体（`tests/unit/i11-audio-mp3-wav-guard.test.mjs:191` 与 `tests/unit/i11-audio-mp3-wav-guard.test.mjs:206`），**计入 todo 2、不计 fail** | 0 |
| `npm run verify:anchors` | `verify-contract-status` PASS（覆盖 127 条契约操作；已装配 127；implemented 18 / partial 109 / planned 0；形状错误 0、语义错误 0）；`verify-doc-anchors --strict` PASS —— `BARE_ORPHAN` 命中 **3478**、基线外新增 **0**；`ANCHOR-COUNT` **6510** 条 / **233** 份文档，下降 **0** 份、上升 19 份；`ANCHOR_DRIFT` 15 条全在基线内；末行以 `PASS: --strict 下没有基线之外的新增` 开头 | 0 |
| `npm run verify:parity` | `extra []` / `missing []` / `ledgerDrift []` | 0 |
| `npm run verify:capability-map` | `totalOps=46，有入口=46，无入口=0，死按钮=0`；文档标记块与重算一致 | 0 |
| `npm run test:docs` | 研究记录校验与 `docs/research` 结构校验通过（含本次新增链接的存在性检查） | 0 |
| `npm run lint` | `tsc --noEmit` services/api PASS、apps/admin PASS；仓库卫生扫描 PASS | 0 |
| `npm run test:contract` | `tests 17 / pass 17 / fail 0` | 0 |
| `npm run test:failmatrix` | `矩阵合计 249 条：PASS 249 / FAIL 0` | 0 |
| `npm run build` | **环境受阻（exit 1），不写 PASS。** `services/api` 的 `tsc` 通过；`apps/admin` 的 `vite build` 在 `vite:esbuild-transpile` 报 `remove C:\Users\MR\AppData\Local\Temp\esbuild-<hash>: Access is denied` —— 与本片改动无关（本片未碰 `apps/**`、`services/**`），是这台机器上 esbuild 的 >1 MiB 临时文件被 Windows 拒绝的结构性问题 | **1** |

`build` 之后、`test:unit` 之前已删 `services/api/dist` 与 `apps/admin/dist`（两者 `Test-Path` 均为 `False`）；
`TMP`/`TEMP` 指向 `C:\Users\MR\AppData\Local\Temp`，在仓外。

### 6.1 提交前后的 `test:unit`

本片在返修前已并入 `upstream/main`（`8f586061`），`git merge-base HEAD origin/main` 因而**不等于** HEAD
—— 所以 `doc-anchor-relocation-identity` 那条「未提交就硬红」的闸门这次有判定面，**提交前**跑的读数就是
`fail 0`（上面那一行）。这与「先提交再跑」的读数一致，没有把红改写成绿的问题。

## 7 证明了什么

1. **同版本只比正文不再能触发 `unchanged`**：七列安全元数据逐列比对，任何一列不同 ⇒ `METADATA_CONFLICT`
   + exit 4（纯逻辑 6 条用例 + 真 PG 1 条）。
2. **监工场景在真库上零写**：`synthetic`+过期 / `verified`+未来有效期的同版本重放，**整行快照**
   （`xmin` / `enabled` / `reviewed_by` / `valid_until` …）逐字段不变，且没有 `commit`、没有 `unchanged=true`。
3. **报告不可能再说谎**：`source_kind` / `source_ref` / `review_evidence_ref` / `valid_from` /
   `valid_until` / `reviewed_by` / 绑定条数**逐字等于库行**（含清单没声明的 `valid_from` 与命令行没断言的
   `reviewed_by`）；没有库行时一律 `(未写入)` + `metadata_source=none`。
4. **`--enable` 不再「启用旧元数据」**：草稿行与清单不一致 ⇒ 冲突、不启用、不写 `reviewed_by`。
5. **这四条不是恒绿装饰**：四条负控制分别打红 4 / 3 / 5 / 4 条用例，恢复后逐字节回到原文件。
6. **过期行不可能被说成已生效**：即使清单如实写 `synthetic` + 同一个过期日，也会在内容校验 exit 3。

## 8 没证明什么（**这一节比上一节重要**）

1. **没有证明「真实政策正文」是对的**：本片全部正文都是 `SYNTHETIC TEST FIXTURE` / 中性填充叙述，
   显式标注、只落在仓外临时目录。`verified` 的**真实来源**（真实 `https://` 政策页、真实复核记录）
   一条都没导入过，也一条都没验过。
2. **没有证明生产库的状态**：全部真库读数来自本机一次性 `initdb` 簇（PG 17.11，真跑
   `0001/0003/0009`）。临时簇里只有本用例插的 3 行，`recipients` 与 `admin_accounts` 也都是本用例
   自己插的。生产 `consent_policies` 仍是 0 行（这张表本来就没有生产写入）。
3. **没有打开任何一道业务闸**：`external_inference` 仍因「没有已核验接收方」打不开（`recipients`
   仍是生产零写入）；本片对政策表之外的任何一层都没有作用。`POST /posts` 等在真实环境上的行为未测。
4. **没有覆盖 `reviewed_at` 与 `enabled` 的时间语义**：`reviewed_at` 由库钟写、清单里没有对应字段，
   因此**不参与**元数据比对；`enabled` 是启停状态、不是「这一行说了什么」，也不参与。两者各有既有判据
   （`0009` 的 CHECK、单条 enabled 的部分唯一索引）。
5. **没有证明「只差 `valid_from` 且清单省略」的情形**：清单省略 `valid_from` 时该维度**跳过比对**
   （库列由库钟生成）—— 这是刻意的，但也意味着「库里 `valid_from` 在未来」不会被这条判据抓到。
   它仍是 `warning=` 那一层的事（`valid_from` 在未来 ⇒ 该政策尚未生效），不在这条判据里。
6. **没做运行时/CI 面**：`build` 在本机结构性失败（§6），CI 上的 `build` 与 `contract-tests` 未在本机复跑；
   本片未 push，PR 上的 CI 读数本页不含。
7. **没有改不可变触发器，也不该改**：修复靠「发现不一致就拒绝」，不是靠「允许就地改」。
   触发器 `23514` 的行为在用例里仍被断言（原地改 sha 仍红）。

## 9 未做 / 未碰

- 未改 `services/api/src/**`、`apps/**`、迁移、`db/roles/*.sql`、任何 `GRANT`（监工明说不需要）。
- 未新增运行时权限；`DATABASE_URL` 仍必须是迁移属主/运维身份。
- 未 push、未调 `gh`、未发起任何真实外呼；无凭据出现在日志/证据里。
- 本片文档不含裸露的行号锚点（一律 `path:line` 形式）。
