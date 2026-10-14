# GY-I19〔P1 返修〕必重放条目只认**本轮**证据：历史完成事实不得覆盖本轮失败（Refs #19）

> **本记录不关闭整项 issue #19**（PR #153 `Refs #19`），也不代表第 3 步以外的模块已验收。
> 只覆盖监工 **[P1]** 指出的「`needed` 条目可用历史 `deletion_settled` 覆盖本轮失败/未接线」这一处
> 最小修正、补的用例与自检，并**如实列出未取得项**。文中所有"通过"都附命令与原始输出；
> **没有跑过的一个字都不写通过**。

## 0 基本信息

| 项 | 值 |
| --- | --- |
| 分支 | `feat/gy-i19-deletion-aging`（复用既有 worktree `E:\GengYunCommander\GengYun_W39`，未新建） |
| 基线 | `upstream/main = 210c89a9bcbdd51ac0900126f2ce8f9db0b17960`（本次 `git fetch upstream --prune` 后实测） |
| 修正前 HEAD | `a8c5320`（`Merge upstream/main into feat/gy-i19-deletion-aging`） |
| 本次修正提交 | `bda391e`（`fix(i19): 必重放条目只认本轮证据，历史完成事实不得覆盖本轮失败（Refs #19）`） |
| 推送 | 由**指挥**推送；写手**不 push**、不改共享 remote／配置 |
| 依据 | 监工 **[P1]** 原文；`state-contract`「加载清单 → 删除/重播 → 验证无复活 → 开流量，失败保持隔离」 |

**交接事实（如实）**：修正代码与本单测的**主体**是**上一写手**（多轮未提交、已被中止）留在该 worktree 的
**未提交改动**。本次**未重写、未丢弃**，而是**先审阅**其口径是否与监工一致（结论：一致，见 §1／§2），
再**补 2 条断言**（`needed===true` / `replayed===0` / `failed===1`）与**本记录**，然后落成一笔提交。

## 1 修正的口径（一句话）

**「本轮结果」与「历史事实」严格分开。**

- `needed === true`（快照含该对象，或 tombstone 比快照水位新）：该条**只能由本轮定案** ——
  本轮 `applied`/`duplicate` **且带本轮非空证据**（第三方还须本轮 `confirmed === true`）；
  本轮 **`failed` / `pending` / 端口未接线 / 无本轮有效证据 / 第三方未确认** ⇒
  **保留失败原因、`settled:false`、`restore_safe:false`、`isolation_required:true`**；
  清单里的 `deletion_settled`（历史 `completed` + 证据）**只作背景信息**，**不得**兜成本轮成功。
- `needed === false`（被快照覆盖）：没有本轮动作，**仍可合法复用**清单里既成的完成证据（**保留**）。
- `duplicate` 是本轮**幂等成功**（同一 `replay_key` 只产生一份事实），**保留**。
- **`visible_after === false` 不得单独作为放行依据** —— 本地不可见 ≠ 当前第三方已确认。

## 2 改前 / 改后对照（**实测**，非推演）

方法：`.local/p1-i19-replay-check.mjs`（一次性脚本，`.local/` 已在 `.gitignore`，**用完已删除、`git status` 干净**）
对**同一入参**分别调用改前／改后模块。场景 = **监工实测场景**：快照明确
`contains_object_refs=[opaque:third-party-object]`；对应 `third_party` tombstone 已有**历史 confirmed + 证据**
⇒ `deletion_settled=true`；本轮 `target.available=true` 但 `target.thirdParty.available=false`；
`isVisible` 只对本地恢复对象回查 ⇒ `false`。

```
== 改前（旧口径：needed 条目可被历史 deletion_settled 兜成成功） ==
{"entry":{"needed":true,"deletion_settled":true,"status":"failed","evidence_ref":null,"visible_after":false,"settled":true,"restore_safe":true,"reason_code":null},"required":1,"failed":1,"restore_safe":true,"isolation_required":false,"reason_code":null,"reasons":[],"sends":0}

== 改后（当前 HEAD 代码） ==
{"entry":{"needed":true,"deletion_settled":true,"status":"failed","evidence_ref":null,"visible_after":false,"settled":false,"restore_safe":false,"reason_code":"REPLAY_THIRD_PARTY_UNWIRED"},"required":1,"failed":1,"restore_safe":false,"isolation_required":true,"reason_code":"REPLAY_THIRD_PARTY_UNWIRED","reasons":["REPLAY_THIRD_PARTY_UNWIRED"],"sends":0}
```

改前逐字复现监工所述缺陷：`required=1、failed=1、entry.status=failed、entry.evidence_ref=null`，
**却** `restore_safe=true`、`isolation_required=false`、`reason_code=null`、`sends=0`
（历史确认把本轮未执行的第三方重放兜成了"恢复安全"）。改后：**`restore_safe=false`、
`isolation_required=true`、`reason_code` 非空（`REPLAY_THIRD_PARTY_UNWIRED`）、`sends=0`**（端口未接线 ⇒ 零发送）。

## 3 逐处修改

| 位置 | 改动 |
| --- | --- |
| `backup-replay-manifest.ts` 原 `settledEntry` 一行 | `entry.needed ? (settledByReplay \|\| entry.deletion_settled) : entry.deletion_settled` ⇒ `entry.needed ? replayedThisRound : entry.deletion_settled`（本轮完成定义抽为 `replayedThisRound`） |
| `BackupReplayEntryOutcome` | 新增只读字段 `replayed_this_round`（本轮真的重放成功且带本轮证据），使"本轮定案"可被下游**判别**而不只体现在布尔结论里 |
| 文件头铁律 / `deletion_settled` 注释 / `restore_safe` 判据注释 | 同步为「本轮 vs 历史」口径；写明 `visible_after===false` 不得单独放行、覆盖条目可合法复用、`duplicate` 仍是本轮幂等成功 |
| `restore_safe` 判据本身 | **表达式未改**（仍为 `settledEntry && visibleAfter === false`）；本次只改 `settledEntry` 的来源 —— 「本地不可见就当安全」的**唯一**入口被堵住 |
| `tests/privacy/backup-replay-manifest.test.mjs` | 替身新增 `thirdPartyUnavailable`（端口存在但 `available:false`）与 `thirdPartySends` 计数；新增 P1 用例（§4） |

**未改动**：`services/api/src/community/**`、`moderation/**`、`tts/**`、`packages/contracts/**` 一个字节未动；
`packages/privacy/deletion.mjs` 的终态行为**未动**（监工已裁定不动）。

## 4 补的用例（监工点名场景 + 保留项）

`test('P1 返修：历史完成事实不得覆盖本轮失败 …')`：

1. **监工场景**（快照含第三方对象 + 历史 `confirmed` + 本轮 `thirdParty.available=false`）⇒ 必须
   `entries[0].status='failed'`、`reason_code='REPLAY_THIRD_PARTY_UNWIRED'`、`evidence_ref=null`、
   `replayed_this_round=false`、`settled=false`、`visible_after=false`（**这正是陷阱**）、
   **`restore_safe=false`、`isolation_required=true`、整体 `reason_code` 非空**、`reasons` 含该码、
   `needed=true` / `replayed=0` / `failed=1`、**`thirdPartySends=0`**。
2. **正向对照**（同一份清单，端口可用且**本轮**确认）⇒ `applied`、`replayed_this_round=true`、
   `settled=true`、`restore_safe=true`、`reason_code=null`、`thirdPartySends=1`。
   即放行**不是**被一刀切关掉，只认本轮证据。
3. **同一缺陷的非第三方实例**：本轮 `failed`（`STORE_REJECTED`）/ `pending`（`STORE_UNREACHABLE`），
   本地恰好不可见 ⇒ 同样 `restore_safe=false` + `isolation_required=true` + 原因码保留。
4. **保留项**：覆盖条目（`needed=false`）仍复用既成证据 ⇒ `settled=true`、`restore_safe=true`；
   同一目标连跑两次 ⇒ 第二条 `duplicate`、`replayed_this_round=true`、`restore_safe=true`（幂等未被破坏）。
5. `assertReplayInvariants` 全量不变量对上述每条结果都跑（`restore_safe=false ⇒ reason_code` 必非空、
   状态闭集、冻结等）。

## 5 门禁（命令 + 退出码 + 关键输出）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `npm run lint` | `0` | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）` / `lint 通过` |
| `node --test tests/privacy/backup-replay-manifest.test.mjs tests/privacy/deletion-aging.test.mjs tests/privacy/third-party-deletion-projection.test.mjs` | `0` | `ℹ tests 23 / ℹ pass 23 / ℹ fail 0 / ℹ skipped 0`（其中本文件 `tests 9 / pass 9 / fail 0`） |
| `npm run test:unit` | `0` | `ℹ tests 2069 / ℹ pass 2068 / ℹ fail 0 / ℹ skipped 1`（1 skipped 为既有跳过，非本次引入） |
| `git diff --check` | `0` | 无输出（仅有 `core.autocrlf=true` 的 LF→CRLF 提示，非错误） |

## 6 自证（变异，**真做了**：2 个变异体各跑一次，均**真红**，非语法假红）

| 变异体（临时改坏后立即改回） | 结果 |
| --- | --- |
| ① `settledEntry` 改回 `entry.needed ? (replayedThisRound \|\| entry.deletion_settled) : …`（即旧口径） | `node --test tests/privacy/backup-replay-manifest.test.mjs` ⇒ **exit 1**；`✖ P1 返修…`，`AssertionError` 落 `assertReplayInvariants` 第 162 行（`restore_safe=false` ⇒ `isolation_required=true`）；`ℹ pass 8 / ℹ fail 1` |
| ② 单条判据改为 `const restoreSafe = visibleAfter === false;`（把"本地不可见"单独当放行依据） | **exit 1**；`✖ P1 返修…`，`AssertionError` 落同一函数第 159 行「单条安全必须有证据确定的完成事实」（`false !== true`） |

两次都是**行为性断言失败**（不是工具改写导致的编译/语法错误那种假红）。改回后：
`git status --porcelain` 空、`git diff` 空、用例 `pass 9 / fail 0`；
另有 §2 的改前/改后原始输出作为行为层面对照。**无效尝试：无**（未出现语法假红、未需要重跑门禁之外的东西）。

## 7 未取得项（如实）

- **不涉及**真实备份系统、真实对象存储、真实第三方供应商、PG、真机与部署：本片是**纯语义修正**，
  零外部调用（§2 的 `sends:0` 只是替身计数，**不等于**真实供应商未被调用过）。§2 的"改前"是把
  旧表达式在本地临时还原后跑的，**不是**真实服务演练。
- **未取得** PR #153 页面本身的读数（标题/CI 状态/既有评审意见）：写手**不持有任何 GitHub 凭据**，
  本页不声称 PR 当前状态。
- **未跑**：`npm run test:contract`、`test:docs`、`test:e2e`、真实备份/PG 集群、供应商沙箱、变异/穷举矩阵 ——
  监工已明确**不要求**全量、真实备份/PG/供应商或额外矩阵；本片改动只落在上述判据与用例。
- **只覆盖受影响分支**：本次只堵「`needed` 条目被历史 `deletion_settled` / 单独 `visible_after===false` 放行」
  这一条路径；`packages/privacy/deletion.mjs` 的终态行为**未动**（监工裁定不动），
  其它路径的既成行为与原因码集合**零改动**（未新增/删除原因码取值；`replayed_this_round` 是**新增结果字段**，
  只增不改语义）。
- **不关闭整项 #19**：本页只对应该 PR 的一处 [P1] 返修，`Refs #19`，`Closes/Fixes/Resolves` 均为 0。
