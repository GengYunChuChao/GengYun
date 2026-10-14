# GY-I19〔P1 返修〕删除期限语义修正：期限是**上限**，不是必须保留满 7/30 天（Refs #19）

> **本记录不关闭整项 issue #19，也不代表第 3 步（备份恢复重放清单）已完成。**
> 只覆盖监工 **[P1]** 指出的「把删除最晚期限反转为最早执行/确认时间」这一处修正与自检，
> 并**如实列出未取得项**。文中所有"通过"都附命令与原始输出；**没有跑过的一个字都不写通过**。

## 0 基本信息

| 项 | 值 |
| --- | --- |
| 分支 | `feat/gy-i19-deletion-aging`（复用既有 worktree `E:\GengYunCommander\GengYun_W39`） |
| 基线 | `upstream/main = ddeb301d7fa308023ccbd19e46c0c26871cf75a3` |
| 修正前 HEAD | `540e993`（`feat(i19): 接收方删除请求/完成/失败三态投影 + 单测`） |
| 推送 | 由**指挥**推送；写手**不 push**、不改共享 remote／配置 |
| 依据 | `docs/product-requirements.md` **B18**「在线个人记录及原始私有媒体 **7 日内删除**，备份 **30 日内滚动清理**」；`state-contract.md` §105-111 |

## 1 修正的口径（一句话）

**7 日 / 30 日是"最晚完成时间"（上限），不是"必须保留满"的时长。**
因此**到期（期限）**与**完成（事实）**必须解耦：

- `recordedState: 'completed'` **且有有效证据**（非空白）⇒ **无论是否到期都如实 `completed: true`**
  （期限内提前删完就是完成；把它隐去会误导后续调度**延迟**删除）；
- **未执行 / 缺有效证据 ⇒ 一律不得 `completed`**，且**不得凭时钟判完成**
  （仍在期限内 ⇒ `AGING_NOT_DUE`；逾期未执行 ⇒ `AGING_DUE_NOT_EXECUTED` / `AGING_DUE_IN_PROGRESS`；
  报称完成但无证据 ⇒ `AGING_DUE_NO_EVIDENCE`）；
- `is_due` / `online_due` / `backup_due` / `due_at` / `remaining_ms` **只表达期限**，不再表达"能不能完成"。

## 2 改前 / 改后对照（**实测**，非推演）

方法：把 `HEAD=540e993` 的两个文件导出到 `.local/p1-before/`（`.local/` 已在 `.gitignore`，
**用完已删除，`git status` 干净**），仅把相对导入深度由 `../../../../packages/…` 调为
`../../packages/…`，再用同一份脚本对**同一入参**分别调用改前／改后模块。

场景（= 监工实测场景）：`requestedAt=2026-10-01T00:00:00Z`、`now=2026-10-02T00:00:00Z`、
`phase=online`、`recordedState=completed`、`evidenceRef=synthetic-proof-deleted-day1`。

```
[aging] 改前 = {"phase":"online","requested_at":"2026-10-01T00:00:00.000Z","online_due_at":"2026-10-08T00:00:00.000Z","backup_due_at":"2026-10-31T00:00:00.000Z","due_at":"2026-10-08T00:00:00.000Z","now":"2026-10-02T00:00:00.000Z","online_due":false,"backup_due":false,"is_due":false,"state":"pending","completed":false,"settled":false,"reason_code":"AGING_NOT_DUE","recorded_error_code":null,"remaining_ms":518400000,"detail":"阶段 online 未到期（now < due_at），不得判完成"}
[aging] 改后 = {"phase":"online","requested_at":"2026-10-01T00:00:00.000Z","online_due_at":"2026-10-08T00:00:00.000Z","backup_due_at":"2026-10-31T00:00:00.000Z","due_at":"2026-10-08T00:00:00.000Z","now":"2026-10-02T00:00:00.000Z","online_due":false,"backup_due":false,"is_due":false,"state":"pending","completed":true,"settled":true,"reason_code":null,"recorded_error_code":null,"remaining_ms":518400000,"detail":null}
[third-party] 改前 = {"state":"requested","completed":false,"reason_code":"THIRD_PARTY_NOT_DUE","receipt_third_party_state":"requested"}
[third-party] 改后 = {"state":"completed","completed":true,"reason_code":null,"receipt_third_party_state":"confirmed"}
CHECK_EXIT=0
```

要点：改前 `completed:false` + `AGING_NOT_DUE` + 文件头写"未到期不得执行"⇒ 会把**已完成的既成事实
隐去**并暗示应**推迟**删除；改后 `completed:true`、`reason_code:null`，同时 `is_due:false` /
`remaining_ms:518400000`（约 6 天）如实保留期限信息，**调度仍能看到还剩多久**。
第三方投影同理：改前把已确认且有证据的接收方重新投影成 `requested`（回执 `requested`），
改后如实 `completed` / 回执 `confirmed`。

## 3 逐处修改

| 文件 | 改动 |
| --- | --- |
| `services/api/src/privacy/deletion-aging.ts` | 判定分支重排：新增「`completed` + 有效证据 ⇒ 完成（不看时钟）」为首个成功分支；新增「`completed` 但无有效证据 ⇒ `AGING_DUE_NO_EVIDENCE`（与是否到期无关）」；`!isDue` 分支降级为「仍在期限内、尚未完成」并改文案；`state` 明确为**窗口态**（pending/due/failed）而非完成态；文件头「三条铁律／边界」重写为**期限=上限**口径；原因码注释同步（**码值集合不变**，仍为原 7 个） |
| `services/api/src/privacy/third-party-deletion-projection.ts` | `projectPhase()` 去掉「`!due` ⇒ 重投影回 `requested`」这一反转分支，改为「`confirmed` + 有效证据 ⇒ 如实完成」；证据缺失 ⇒ `THIRD_PARTY_NO_EVIDENCE`；`due`/`due_at` 降级为**事实列示**（注释写明不是完成门槛）；`NOT_DUE` 保留为导出闭集成员但**不再产生**；文件头同步 |
| `tests/privacy/deletion-aging.test.mjs` | 原「铁律 1：未到期不得 completed」用例**改写**为 P1 用例（见 §4）；矩阵不变量由「completed ⇒ is_due」改为「completed ⇒ 状态 completed + 证据非空」 |
| `tests/privacy/third-party-deletion-projection.test.mjs` | 原「请求→完成：到达窗口才 completed」用例改写为 P1 用例；`assertProjectionInvariants` 删除「`!due` ⇒ 不得 completed」，新增「完成必须 `protocol_state=confirmed`」「未完成不得给 `NOT_DUE`」 |

**未改动**：`packages/**`（含 `packages/privacy/deletion.mjs` 的终态行为与 `packages/contracts/**`）
一个字节未动 —— 监工已登记「`failed` 可被 `confirmed` 覆盖、无终态守卫」的**只读观察**，
本片**不把"重试成功必须永不允许"加成未经裁定的门槛**。

## 4 补的两类证据（监工要求）

1. **期限内提前完成（有证据）**：
   `requestedAt=T`、`now=T+1d`、`completed` + 证据 ⇒ `is_due:false` 且 **`completed:true` /
   `reason_code:null` / `settled:true`**（在线与备份阶段各测一次；备份在第 7 日完成也判完成）。
   第三方投影侧：第 1 小时确认 + `vendor-receipt-1` ⇒ `completed:true`、回执 `confirmed`、
   `reasons` 里**不含** `THIRD_PARTY_NOT_DUE`。
2. **到期仍未执行（无证据）**：
   在线第 30 日 `recordedState:'pending'` ⇒ `is_due:true`、`state:'due'`、**`completed:false`**、
   `AGING_DUE_NOT_EXECUTED`；第三方第 30 日仍未确认 ⇒ `completed:false`、`reason_code:'THIRD_PARTY_REQUESTED'`、
   `due:true`。另测：**报称完成但证据空白**在期限内与逾期两种情况都不得 `completed`
   （`AGING_DUE_NO_EVIDENCE` / `THIRD_PARTY_NO_EVIDENCE`）。

## 5 门禁（命令 + 退出码 + 关键输出）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `npm run lint` | `0` | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描` |
| `node --test tests/privacy/deletion-aging.test.mjs` | `0` | `ℹ tests 8 / ℹ pass 8 / ℹ fail 0` |
| `node --test tests/privacy/third-party-deletion-projection.test.mjs` | `0` | `ℹ tests 6 / ℹ pass 6 / ℹ fail 0` |
| `npm run test:unit` | `0` | `ℹ tests 1984 / ℹ pass 1983 / ℹ fail 0 / ℹ skipped 1` |
| `git diff --check` | `0` | 无输出（仅有 `core.autocrlf=true` 的 LF→CRLF 提示，非错误） |

自证（变异，**真做了**）：本轮为**语义修正**，改动本身即由 §4 两类用例反向锁死 ——
把 §3 第一个文件的新成功分支改回「`!isDue` 优先」会让 P1 用例立刻红、改回「`!evidenceOk` 优先」
会让「缺证据不得 completed」红；第三方侧去掉 `!evidenceOk` 优先则第 1 小时用例红。
第 3 步模块的完整变异记录见其各自的证据页。

## 6 未取得项（如实）

- **不涉及**真实第三方供应商、真实备份系统、真实对象存储、PG、真机与部署：本片是**纯语义修正**，
  零外部调用；§2 的「改前」是把 `HEAD` 的两个文件复制到 `.local`（已删除）后本地运行的，
  **不是**真实服务演练。
- 真实**调度器**（谁按 `due_at` 排任务）不在本片：本片只保证「已完成的事实不再被隐去」，
  接线方仍须自行消费 `remaining_ms` / `due_at`。
- `AGING_NOT_DUE` 的原因码**名称**沿用既有分类（码值集合不变以免下游漂移），
  含义已在注释里改为「仍在期限内且尚未完成」，**不含**"不得完成"的意思。
- 契约零改动；未新增/删除任何原因码取值。
- **本片范围之外**：第 3 步模块 `services/api/src/privacy/backup-replay-manifest.ts` 复用本模块的
  `evaluateDeletionAging()`，其自身的「期限门槛」（原写为"未到期不得声称恢复安全"）**同日后续提交**
  一并同步为本口径；本页不声称第 3 步已完成或已验收。
