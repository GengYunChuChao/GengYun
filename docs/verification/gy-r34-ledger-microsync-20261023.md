# GY-R34 · #7 台账「亚毫秒未修」按代码事实订正为「已修」（文字＋登记同步）

- 切片：worktree `wt-r34-ledger-microsync`，分支 `fix/gy-r34-ledger-microsync`，起点 `upstream/main`。
- 基线（实测时点 **2026-10-23 15:52（Asia/Hong_Kong）**）：`upstream/main = f3a5f24d7427f5c2e40b9c8278312aa4827157ca`（下文简称 `@f3a5f24d`）。
- 本片**只改文字与逐字登记**：不改任何 `status`、不改代码、不动 `evidence`／`lines`／`baseline`，也不往 `tools/doc-anchors-baseline.json` 加条目。是否把条目从 `partial` 改判，属监工权限。
- 本片**不构成 #7 完成**（未取得项见 §7）。

## 1 结论

`docs/architecture/contract-status.json` 里 `operations.listKnowledge.blocker` 与 `dimensions.pagination.blocker` 两处「亚毫秒（PG 微秒）tie-break 存在跨路径差异（**未修**）」在 `@f3a5f24d` 上是**过期表述**：

- `#500`（merge `effa98817f8e9a091cc9fa368eafa764058c9318`，2026-10-23 07:39 UTC 合入）已把 **PG 微秒全精度**键接进知识列表读路径：读语句额外投影**内部**列 `created_at_micros`，JS 侧 `microsOf()`／`compareKnowledgeRows()` 用微秒比较，与 SQL `ORDER BY created_at DESC, id DESC` **逐微秒同序**；只有**完全同刻**才退 `id` 逐码元降序。
- 该修复自带回归钉子：`tests/unit/knowledge-order-micro-precision.test.mjs`（比较器半边）与 `tests/unit/knowledge-order-created-at-precision.test.mjs`（SQL 直查 = HTTP 分页 = 服务层 list 三面对照）。

本片据此把两处 `blocker` 订正为「已修」并给出证据落点，同步 `docs/verification/gy-r29-i07-ledger-lags.json` 的两条 `ledger_blocker_verbatim`（逐字相等），再由 `node tools/verify-contract-status.mjs --write-doc` 重生成 `docs/architecture/contract-implementation-status.md`（未手改生成区）。

## 2 代码判据（符号级，全部在 `@f3a5f24d` 上实读）

读语句（`services/api/src/knowledge/service.ts` 的 `read()` 内 `client.query(...)`，单引号字面量、无拼接）：

```
SELECT * FROM catalog_read.current_knowledge, LATERAL (SELECT (extract(epoch from created_at) * 1000000)::bigint::text AS created_at_micros) micro ORDER BY created_at DESC, id DESC
```

- 微秒键**由 SQL 从同一列 `created_at` 取全精度**（`extract(epoch …) * 1000000` 取整到微秒后转十进制文本），不是 JS 侧再算一遍毫秒。
- 读面仍是 `SELECT * FROM <唯一读视图>`，`created_at_micros` 是**内部**键：`project()` 逐字段列举响应封套，`created_at` 与 `created_at_micros` 都不外泄（由精确性测试「组1」逐字段断言）。

比较器（同文件）：

- `microsOf(row)`：**优先**取 `row.created_at_micros`（十进制数字串或数值，且必须落在 `Number.isSafeInteger` 范围内）；否则回落到 `row.created_at` —— `Date` 实例按 `getTime() * 1000`（毫秒粒度），字符串按 `ISO_INSTANT` 取 0–6 位小数拼成微秒，其余形态走 `Date.parse` 毫秒兜底；解析不出 ⇒ `-Infinity`。
- `compareKnowledgeRows(a, b)`：先比微秒（大者在前，即 `DESC`），**仅当完全相等**才比 `String(id)` 的码元序（大者在前），不用 `localeCompare`。
- 归并路径：`[...dbResult.rows, ...extra].sort(compareKnowledgeRows)` —— DB 行与并入种子行走**同一个**比较器，故三面（SQL 直查／HTTP 分页／服务层 list）同序。

**边界（如实，含退化路径）**：

| 情形 | 行为 | 依据 |
| --- | --- | --- |
| DB 行（视图投影） | 一定有 `created_at_micros`；`0012` 已把 `created_at` 设 `NOT NULL` + 默认 `clock_timestamp()`，故列不会缺 | 迁移 `0012_knowledge_created_at.sql` 的 `SET NOT NULL`／`SET DEFAULT` 两段 |
| 并入种子行（`extraRows`，无该列） | 回落解析自身 `created_at`：ISO 文本 0–6 位小数按微秒；`Date` 实例只到毫秒 | `microsOf()` 的分支顺序 |
| `created_at` 为 NULL／缺字段／不可解析 | 一律 `-Infinity`，**确定性排最后**（组内仍 `id DESC`），且**不抛错** | `tests/unit/knowledge-order-micro-precision.test.mjs` 判据④ |
| `created_at_micros` 为坏值（非数字串、超安全整数） | 回落 `created_at`，**不**把整行降级成 `-Infinity` | 同上判据⑤ |
| 安全整数上界 | 2026 年微秒时间戳约 `1.79e15`，「约 2255 年前」都在 `Number.MAX_SAFE_INTEGER`（≈`9.0e15`）内 | 常量口径，非测试断言 |

## 3 改前 → 改后 逐段对照

只改 `blocker` 文本的三段；`status`／`baseline`／`evidence`／`lines` 逐字未动（自证见 §6）。

### 3.1 `operations.listKnowledge.blocker` —— 第 1 段（指向后半句的路标）

改前：

```
**排序已对齐冻结口径（毫秒对齐夹具；亚毫秒 tie-break 见本条后半）**
```

改后：

```
**排序已对齐冻结口径（毫秒对齐夹具；亚毫秒 tie-break 的修复见本条后半）**
```

### 3.2 `operations.listKnowledge.blocker` —— 第 2 段（本次的主订正）

改前：

```
**亚毫秒（PG 微秒）tie-break 存在跨路径差异（未修）**：JS 侧 `Date` 只有毫秒精度，同毫秒内 SQL 与 HTTP/服务层顺序可不同（复现与根因见同页 §3.6）。
```

改后：

```
**亚毫秒（PG 微秒）tie-break 的跨路径差异已修（#500 合入 `effa9881`；@f3a5f24d 复核）**：读语句在 `SELECT * FROM catalog_read.current_knowledge` 之后用 `LATERAL (SELECT (extract(epoch from created_at) * 1000000)::bigint::text AS created_at_micros)` 额外投影**内部**微秒列（与 SQL 同源同精度；`project()` 逐字段列举，该列不进响应封套）；`microsOf()` 以该列为先（限安全整数范围，越界按坏值回落），无该列的并入种子行回落到自身 `created_at` 的 0–6 位小数解析（`Date` 实例只到毫秒），解析不出（NULL／缺字段／不可解析）⇒ `-Infinity` 确定性排最后且不抛错；`compareKnowledgeRows()` 逐微秒比较、只有**完全同刻**才退 `id` 逐码元降序 ⇒ 与 SQL 的 `ORDER BY created_at DESC, id DESC` 逐微秒同序。判据已钉在 `tests/unit/knowledge-order-micro-precision.test.mjs`（亚毫秒反序 tie、同刻才退 id、不可解析确定性排最后、内部列优先与坏值回落）与 `tests/unit/knowledge-order-created-at-precision.test.mjs`（SQL 直查 = HTTP 分页 = 服务层 list 三面对照，且自证读语句确实投影内部列）。旧「未修」的复现与根因见同页 §3.6（该页是修复前实测），本次改前/改后对照与门禁读数见 `docs/verification/gy-r34-ledger-microsync-20261023.md`。
```

说明：新文本刻意**只写符号与文件名、不写死行号**；`@f3a5f24d` 是本片的测量 SHA。历史对照句里的 `id_asc` 字样**原样保留**（判据②③要求台账仍自称 `id_asc` 旧口径、且必须逐字登记），`partial` 的保留理由（真实生产 `DATABASE_URL` 未取得、`/herbicides` 读面口径另待裁定）也原样保留。

### 3.3 `dimensions.pagination.blocker` —— 括号内的跨路径差异句

改前：

```
（SQL 侧为冻结口径；JS 归并在亚毫秒 tie-break 上与 SQL 存在跨路径差异，未修，见该页 §3.6）
```

改后：

```
（SQL 侧为冻结口径；JS 归并的亚毫秒 tie-break 差异已修 —— #500 起 `microsOf()` 优先用读语句投影的内部微秒列 `created_at_micros`（`LATERAL (SELECT (extract(epoch from created_at) * 1000000)::bigint::text …)`，与 SQL 同源同精度），`compareKnowledgeRows()` 逐微秒比较、完全同刻才退 `id` 降序，判据见 `tests/unit/knowledge-order-micro-precision.test.mjs` 与 `tests/unit/knowledge-order-created-at-precision.test.mjs`；修复前的复现与根因见该页 §3.6，R34 订正 @f3a5f24d）
```

## 4 登记表同步（`docs/verification/gy-r29-i07-ledger-lags.json`）

- 两条 `ledger_blocker_verbatim` 已改为与新 `blocker` **逐字相等**；改动由一次性脚本从台账原文**直接取值**写入（不是人工转抄），脚本落地后自证「原文件 `JSON.stringify` 往返逐字一致」，即除目标字段外无格式漂移；临时脚本在仓外 `E:\GengYunCommander\.pg17\tmp\r34-ledger-microsync\sync-registry.mjs`，不随本片提交。
- `note` 末尾追加一句：`R34：#500 合入后已从「未修」订正为「已修」（改前/改后对照、代码判据与门禁读数见 docs/verification/gy-r34-ledger-microsync-20261023.md；测量 SHA f3a5f24d）`。
- `ledger_line`（716／3199）、`status_field_line`（694／3168）、`status_value`（`partial`）、`code_of_record` 等字段**未动**——因为改的是单行 JSON 字符串的**行内**文本，行号不漂移；这一点由判据②的「行号仍指向同一 blocker 行」断言实测守住。
- 判据②③④**一条未删、未弱化**：仍逐字读登记表、仍要求 `id_asc` 作为历史对照出现在台账里、代码里仍不得出现 `id_asc`、登记表仍为 2 条。

## 5 测试读数（改前红 → 同步后绿）

命令均在 worktree 根目录执行（`node --test`，逐文件默认隔离；⛔ 未用 `--test-isolation=none`）。

**(a) 先红（只改台账、登记表尚未同步）**：`node --test tests/unit/knowledge-ledger-sort-drift.test.mjs` ⇒ **exit 1**

```
✖ ② 台账滞后登记必须同时与台账和代码成立（任一侧变化即红）
  AssertionError [ERR_ASSERTION]: 台账 `operations.listKnowledge.blocker` 的 blocker 已变更（可能滞后已被修掉）⇒ 请更新或删除 `docs/verification/gy-r29-i07-ledger-lags.json` 里的这条登记。
```

**(b) 同步登记表后转绿**：同一命令 ⇒ **exit 0**

```
✔ ① 三方逐字一致：冻结契约 = service.ts 实际发出的语句 = 内置字面量
✔ ② 台账滞后登记必须同时与台账和代码成立（任一侧变化即红）
✔ ③ 台账里任何未登记的 id_* 排序声称都必须判红
✔ ④ 零放宽自证：本文件不含软化钩子，登记表与台账同源
ℹ tests 4  ℹ pass 4  ℹ fail 0
```

**(c) 比较器半边**：`node --test tests/unit/knowledge-order-micro-precision.test.mjs` ⇒ **exit 0 / 5 tests, pass 5, fail 0**
（① 0/1/3/6 位小数同刻；② `.000500Z` 先于 `.000100Z` 的亚毫秒反序 tie，且压到毫秒后次序必须反过来；③ 同刻才退 `id`，逐码元而非 `localeCompare`；④ NULL／缺字段／不可解析 ⇒ `-Infinity` 排最后且不抛错；⑤ 内部列优先、坏值回落不退化。）

**(d) 真实投影 + 真实 HTTP**：`node --test tests/unit/knowledge-order-created-at.test.mjs` ⇒ **exit 0 / 6 tests, pass 6, fail 0**
（排序＝`created_at DESC, id DESC`；排序键不进响应封套；翻页逐页拼接无重复无空洞；旧 `id_asc` 自述游标必须被拒；`0012` 回填确定性；运行期角色仍只能读视图。）

**(e) 微秒三面对照（回归钉子）**：`node --test tests/unit/knowledge-order-created-at-precision.test.mjs` ⇒ **exit 0 / 5 tests, pass 5, fail 0**
（组1 微秒反序 tie 三面均为 `[X, Y]` 且封套不新增字段；组2 毫秒对齐夹具未回归；组3 种子归并 0/1/3/6 位小数＋不可解析行确定性；组4 自证读语句确实投影内部列。）

## 6 生成区重生成 ＋ 空操作证明

- `node tools/verify-contract-status.mjs --write-doc` ⇒ **exit 0**，`SYNC: 中文表格此前不是「中文表格一致」状态，已按 JSON 重写`；`docs/architecture/contract-implementation-status.md` 只有两条表格行（`listKnowledge`、分页维度）随之更新，**未手改生成区**。
- 随后 `node tools/verify-contract-status.mjs` ⇒ **exit 0**，含 `PASS: 中文表格一致`。
- **空操作证明**：再跑一次 `--write-doc` ⇒ **exit 0**，且
  - 该 md 的工作区字节 `git hash-object` 前后同为 `6ca4acdbc01aec851f550ce0728cee5d77ee0f8c`（同一口径比对，**非** blob 口径）；
  - `git status --porcelain` 行数前后同为 **3**（本片 3 个改动文件），无新增改动。

**`status` 0 改动自证**（逐条 `id`＋`status` 比对，基线 `HEAD` 对照工作区）：`operations` + `dimensions` 共 **121** 条，`STATUS_DIFF=0`；`baseline` 字段序列化逐字相同；全部 121 条的 `evidence` 序列化逐字相同。`git diff --numstat` 仅 `contract-status.json 2/2`、`gy-r29-i07-ledger-lags.json 3/3`。

## 7 门禁读数（逐条 exit）

| 门禁 | 读数 |
| --- | --- |
| `node --test tests/unit/knowledge-ledger-sort-drift.test.mjs` | 改前红 exit 1 → 同步后 **exit 0**（4/4 pass） |
| `node --test tests/unit/knowledge-order-micro-precision.test.mjs` | **exit 0**（5/5 pass） |
| `node --test tests/unit/knowledge-order-created-at.test.mjs` | **exit 0**（6/6 pass） |
| `node --test tests/unit/knowledge-order-created-at-precision.test.mjs`（补跑，非派单门禁） | **exit 0**（5/5 pass） |
| `node tools/verify-contract-status.mjs` | **exit 0**（形状错误 0、语义错误 0、中文表格一致） |
| `node tools/verify-contract-status.mjs --write-doc`（第二次） | **exit 0**，空操作（见 §6） |
| `node tools/verify-doc-anchors.mjs --strict` | **exit 0**（基线 103 条、命中 103、**基线外新增 0**、陈旧 0） |
| `npm run test:docs` | **exit 0**（27 项初始任务无环、F/AC/Q 映射完整；研究记录 5 通过 / 0 失败 / 4 legacy 已钉住） |
| `node --test tests/unit/doc-closing-keywords.test.mjs`（补跑，`docs/` 扫描面自检） | **exit 0** |

## 8 未取得（如实）

1. **真实生产 `DATABASE_URL` 读数仍缺**：本片未连任何真实库；`knowledge-order-created-at*.test.mjs` 跑在 PGlite（内嵌真实 PostgreSQL/WASM）隔离合成夹具上，`knowledge-order-micro-precision.test.mjs` 是纯单元（不连库）。三面一致的**生产**读数仍属未取得项，不能据本片宣称已获得。
2. **本片只是文字与登记订正，不构成 #7 完成**：`/herbicides` 读面排序口径仍待裁定；`created_at` 之外的排序维度未涉及。
3. **`status` 未改**（仍 `partial`）：改判属监工权限；本片只提供证据。
4. **未跑全量单测**：按派单要求只跑定向文件与文档门禁；未跑 `tests/unit/*.test.mjs` 全量、未跑集成/真机/付费项。
5. **未改**：`services/api/src/**`、`tests/**`、`tools/doc-anchors-baseline.json`、`docs/verification/gy-r33-contract-ledger-20261023.md`（该页是 R33 时点的历史取证，其中 §3.6「未修」在**当时**成立，故按历史记录保留不改写）。

## 9 复现命令（跨平台）

```bash
git -C <worktree> rev-parse HEAD          # 期望 HEAD 含本片提交
node --test tests/unit/knowledge-ledger-sort-drift.test.mjs
node --test tests/unit/knowledge-order-micro-precision.test.mjs
node --test tests/unit/knowledge-order-created-at.test.mjs
node tools/verify-contract-status.mjs
node tools/verify-doc-anchors.mjs --strict
npm run test:docs
```

判「台账文字 = 代码事实」的机器判据只有 `tests/unit/knowledge-ledger-sort-drift.test.mjs`（逐字读取登记表与台账）＋ `tools/verify-contract-status.mjs --write-doc`（生成区与 JSON 字节一致）；两者都**不**证明 `status` 判定正确 —— 那属人工/监工判断。
