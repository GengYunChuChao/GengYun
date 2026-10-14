# GY-I19 第 3 步 · 备份恢复重放清单 + 「恢复后不得复活」负例（Refs #19）

> **本记录不关闭整项 issue #19。** 只覆盖本片（第 3 步切片）的交付与自检，并**如实列出未取得项**。
> 所有"通过"都附命令与原始输出；**没有跑过的一个字都不写通过**。
> 本片与同分支的 **P1 期限语义修正**（`docs/verification/gy-i19-deletion-deadline-p1-20261015.md`）
> 同口径：**7 日 / 30 日是期限上限，不是必须保留满**。

## 0 基本信息

| 项 | 值 |
| --- | --- |
| 分支 | `feat/gy-i19-deletion-aging`（复用既有 worktree `E:\GengYunCommander\GengYun_W39`；**未新建 worktree/分支**） |
| 基线 | `upstream/main = ddeb301d7fa308023ccbd19e46c0c26871cf75a3` |
| 本片新增 | `services/api/src/privacy/backup-replay-manifest.ts`（纯新增）、`tests/privacy/backup-replay-manifest.test.mjs`（纯新增） |
| 推送 | 由**指挥**推送；写手**不 push**、不改共享 remote／配置 |
| 契约 | `packages/contracts/**` **零改动**；契约里**没有**备份/恢复/重放的 operation ⇒ **未自造任何路由/字段** |
| 既有文件改动 | **零**（`packages/privacy/**` 与 `services/api/src/privacy/**` 既有文件一个字节未动） |

## 1 先只读核实：既有实现到哪里，本片补什么

核实范围（只读）：`packages/privacy/deletion.mjs`、`packages/privacy/deletion-modules.mjs`、
`packages/privacy/constants.mjs`、`packages/privacy/README.md`、`services/api/src/privacy/user-data-deletion.ts`、
`services/api/src/privacy/deletion-aging.ts`、`docs/architecture/state-contract.md` §删除清单、
`packages/contracts/openapi.json`（路径表）。

| 能力 | 既有？ | 位置 | 本片做什么 |
| --- | --- | --- | --- |
| 逐阶段备份态（`backup_state` ∈ `pending/running/completed/blocked`） | **既有** | `deletion.mjs` handler 行 + `constants.mjs::HANDLER_STATES` | 只读消费 |
| 备份清除端口 | **既有的"端口"**（未接线） | `user-data-deletion.ts::BackupPurgePort` + `createUnwiredBackupPurgePort()`（未接线 ⇒ `backupState: pending`，不谎称完成） | 复用同一 fail-closed 口径 |
| 7 日 / 30 日到期口径 | **既有**（本分支第 1 步） | `deletion-aging.ts::evaluateDeletionAging()` | 直接复用（**不另立时间口径**） |
| 第三方 请求/完成/失败 三态 | **既有** | `deletion.mjs` + 第 2 步投影 | 在清单里按 `third_party` 范围复用 |
| **恢复重放清单**（重放哪些、顺序、幂等键、每条证据要求） | **无** | — | **本片新增**（纯函数投影） |
| **「恢复后不得复活」验证 / 开流量闸门** | **无** | — | **本片新增**（编排 + 逐条回查） |
| `deletion_tombstones` / `backup_inventory` 落库 | **无**（README 标明属 GY-I19） | — | **不在本片**（见 §7） |
| 备份/恢复/重放 HTTP operation | **契约里没有** | — | **未自造**；本片是内部模块 |

**结论**：没有"已有实现"可重复造，也没有另造状态机 —— 本片只做**清单投影 + 重放编排 + 无复活验证**，
与第 1、2 步同一手法（投影/复用 + 回归用例）。

## 2 交付内容

`buildBackupReplayManifest({ snapshot, tombstones, now, subject?, requestId?, ownerOf? })` 产出**恢复重放清单**：

- **哪些必须重放** — `needed = 快照实际含有该对象引用 || tombstone.recorded_at > 快照截至水位`。
  `contains_object_refs` **缺省（未知）⇒ 全部必须重放**（不能证明覆盖就必须重放）。
  > 这是本片的**关键判定**：state-contract 只说"加载比快照新的清单"，但**水位不足以判定覆盖** ——
  > 一份"水位很新、却实际含有已删对象"的备份快照会被纯水位比较判成"无需重放" ⇒ 恢复后**复活**。
- **顺序** — `delete_generation` 升序 → 范围权重（身份/session/profile/公开帖 → 媒体/衍生件 →
  问答/识别/收藏/消息 → 缓存/日志 → 备份 → **第三方待删最后**）→ 落库时刻 → 对象引用（全序，跨机器一致）。
- **幂等键** — `replay_key = sha256("gengyun/backup-replay/v1\0" + object_ref + "\0" + delete_generation)`：
  只由**对象身份 + 删除代次**决定，**跨快照、跨重放稳定** ⇒ 重复重放可被目标端识别为同一键（PK 冲突 ⇒ `duplicate`，不产生第二份事实）。
- **每条的证据要求** — `evidence_required`：身份 = `['replay_receipt','identity_mapping_destroyed']`；
  公开帖评 = `['replay_receipt','author_deidentified']`；第三方 = `['third_party_confirmation','evidence_ref']`；其余 = `['replay_receipt']`。
- **清单完整性** — `manifest_digest = sha256(v1 / snapshot_id / watermark / 每条 seq|replay_key|needed)`；
  重放前**重新计算并比对**，不符 ⇒ `REPLAY_MANIFEST_TAMPERED` 且**零调用**（"漏重放"最常见的根因是**清单被裁剪**）。
- **清单纯数据** — 只含 opaque 引用、哈希键、范围、期限、状态；**不含**主体/请求 id（有专门断言）。
- 清单本身 `restore_safe` **恒为 `false`** —— 清单只是计划：没重放、没验证无复活，不足以声称安全。

`executeBackupReplay({ manifest, target })` 执行重放并**验证无复活**（state-contract §111：
「加载清单→删除/重播→验证无复活→开流量，**失败保持隔离**」）：

- 端口 `available !== true` ⇒ `REPLAY_TARGET_UNAVAILABLE`（**零调用**）；第三方端口未接线 ⇒ `REPLAY_THIRD_PARTY_UNWIRED`（**零真实第三方调用**）；
- 第三方 `confirmed !== true` ⇒ `REPLAY_THIRD_PARTY_NOT_CONFIRMED`（`requested` 绝不等于 `confirmed`）；
- 报称完成但**证据空白** ⇒ `REPLAY_NO_EVIDENCE`；
- 重放后**逐条回查可见性**（含被覆盖条目 —— 水位可能说谎，事实以可见性为准）；任一仍可见 ⇒ `REPLAY_REVIVED`、`isolation_required: true`；
- 回查本身不可用 ⇒ `REPLAY_VERIFY_UNAVAILABLE`（**不得**因为"重放函数返回成功"就放行）；
- `restore_safe === true` 需：**无复活** + 每条删除事实**由证据确定完成** + 清单非空（空清单不得真空真）。

## 3 四类关键负例（逐条都会真红，见 §5 变异自证）

| # | 负例 | 断言要点 |
| --- | --- | --- |
| ① | **含已删对象的快照恢复后不得复活** | 同一 tombstone、同一水位：`contains_object_refs: []` ⇒ `needed:false`（水位比较的误判）；`contains_object_refs: ['opaque:obj-secret']` ⇒ `needed:true`。重放后 `isVisible()===false`、`verified_no_revival:true`、`restore_safe:true` |
| ② | **漏重放 ⇒ 可判别 pending/failed（带原因码），绝不表现成功** | (a) 清单未执行 ⇒ `restore_safe:false` / `REPLAY_NOT_EXECUTED`；(b) 目标失败 ⇒ `failed` + `STORE_REJECTED`（白名单原样透出）+ `visible_after:true` + `REPLAY_REVIVED` + `isolation_required:true`；(c) 目标 pending ⇒ `pending` + `STORE_UNREACHABLE`；(d) 端口未接线 ⇒ `REPLAY_TARGET_UNAVAILABLE`；(e) 底层事实与清单不符（"被覆盖"其实还在）⇒ `failed` + `REPLAY_REVIVED`；(f) 回查不可用 ⇒ `verified_no_revival:false`；(g) 缺证据 ⇒ `REPLAY_NO_EVIDENCE` |
| ③ | **主键冲突 / 重复重放 ⇒ 幂等** | 同清单跑两次：第一次 `applied`（`ledger` 1 份事实），第二次 `duplicate` + **同一 evidence_ref** + `ledger` 仍 1 份 + `restore_safe:true`/`reason_code:null`（**明确成功，不给含糊结论**）；同一对象同代次重复行 ⇒ 同一 `replay_key`、只落一份事实；代次递增 ⇒ 新键（是新事实） |
| ④ | **期限是上限、不是完成条件** | (a) 期限内 + 无证据 ⇒ `REPLAY_UNDUE_NO_EVIDENCE`；(b) 逾期 + 无证据 ⇒ `REPLAY_OVERDUE_NOT_EXECUTED`；(c) **期限内提前完成（有证据）⇒ `restore_safe:true`**；(d) 逾期 + 有证据 ⇒ `true`；(e) 第 30 日闭区间只影响"事实"与原因码分支；(f) 第 7 日的在线/备份两阶段 due 事实不同但**都已提前完成** ⇒ `restore_safe:true` |

另覆盖 fail-closed：坏行**不静默跳过**（非对象 / 空 `object_ref` / 非法代次 / scope 不在闭集 /
state 不在 `HANDLER_STATES` / phase 非法 / 时间线倒置 ⇒ 整份清单 `blocked` + `REPLAY_INPUT_INVALID`）、
越权（`REPLAY_SUBJECT_MISMATCH`）、归属未核实（`REPLAY_OWNERSHIP_UNVERIFIED`）、空清单非真空真（`REPLAY_NONE`）、
清单被裁剪/篡改（`REPLAY_MANIFEST_TAMPERED`，**目标端零调用**）、第三方未接线/未确认。

## 4 门禁（命令 + 退出码 + 关键输出）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `npm run lint` | `0` | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描` |
| `node --test tests/privacy/backup-replay-manifest.test.mjs` | `0` | `ℹ tests 8 / ℹ pass 8 / ℹ fail 0` |
| `node --test tests/privacy/{backup-replay-manifest,deletion-aging,third-party-deletion-projection}.test.mjs` | `0` | `ℹ tests 22 / ℹ pass 22 / ℹ fail 0` |
| `npm run test:unit` | `0` | `ℹ tests 1984 / ℹ pass 1983 / ℹ fail 0 / ℹ skipped 1` |
| `git diff --check` / `git diff --cached --check` | `0` | 无输出（仅有 `core.autocrlf=true` 的 LF→CRLF 提示，非错误） |

## 5 变异自证（**真做了**，逐条：改坏实现 → 确认红 → 改回）

**方法**：用编辑工具**临时**把实现改坏（改动处带 `[MUTATION-…]` 注释标记），跑
`node --test tests/privacy/backup-replay-manifest.test.mjs`，确认失败是
`AssertionError`（**不是** `SyntaxError`/`TypeError` 那种"假红"），再逐字改回；全部改回后
`Select-String MUTATION` 为空、单测复绿。

| 变异 | 改坏什么 | 结果 | 命中的红 |
| --- | --- | --- | --- |
| **M1** | `needed` 去掉「快照实际含有」这一支，只比水位 | **红** | 清单形状 + 负例①②③④ + 裁剪/篡改 + 第三方（7 个用例；`AssertionError: 快照实际含有这三个对象 ⇒ 全部必须重放`） |
| **M2'** | `restoreSafe` 去掉 `visibleAfter === false`（复活不再阻塞） | **红** | 负例②（`AssertionError: 目标失败：单条安全必须已回查确认不可见`） |
| **M3** | 报称完成但**证据空白**也判成功 | **红** | 负例②(g)（`AssertionError`，期望 `REPLAY_NO_EVIDENCE`） |
| **M4** | 重放前**不比对** `manifest_digest` | **红** | 裁剪/篡改 fail-closed（`AssertionError`） |
| **M6** | `duplicate` 判为失败 | **红** | 负例③ + 负例①（`AssertionError`） |
| **M7** | `pending` 判为成功 | **红** | 负例②(c)（`AssertionError`，期望 `pending`） |
| **M8** | 第三方 `confirmed !== true` 也判成功 | **红** | 第三方待删重播（`AssertionError`） |
| **M9** | 坏行**静默 `continue`** 跳过 | **红** | 坏行 fail-closed + 裁剪/篡改（两个用例；`AssertionError: tombstone 不是对象`） |
| **M10** | 主体不匹配不拒绝（越权放行） | **红** | 坏行/越权 fail-closed（`AssertionError`） |
| **N1** | 完成判定不看证据（`settledEntry = true`） | **红** | 负例④（`AssertionError`） |
| **N2** | 把期限重新当完成门槛（`restoreSafe` 再与 `window_due` 相与） | **红** | 负例④（`AssertionError: 期限内提前完成 + 证据 ⇒ 如实安全`） |

**有效性说明（如实）**：

- **M1–M10、N1、N2 各自单独施加**，除被施加处外**逐字改回**；末次 `Select-String MUTATION` 无命中、单测 `8/8` 复绿。
- **一次"无效尝试"（假红）确实发生过**：给负例②新增"缺证据"用例时，测试文件里出现了与既有变量同名的
  `const liar` ⇒ `SyntaxError: Identifier 'liar' has already been declared`。这是**工具改写导致的语法错误**，
  **不作为任何证据**；改名（`noEvidenceTarget`）后重新跑，才是有效的**红/绿**。
- **M5/M5b 已作废**：它们针对的是旧"未到期不得声称恢复安全"门槛。**同步 P1 口径后**该门槛已改为
  「完成看证据」，M5 型变异（只去掉 `window_due` 相与）**不再有可观察差异**（因为原因码路径已独立拦住）；
  现由 **N1 / N2** 承担该规则的变异证据。这一点**如实记录**，不把作废记录算作本轮证据。
- **M3/M4/M6–M10 是在同步 P1 口径之前、针对这些代码区域施加的**；这些区域此后**未被改动**
  （逐字未变），因此其"真红"结论仍然成立 —— 但**不是**在同一份最终二进制上重跑的结果，故如实标注。
  **M1 / M2' / N1 / N2** 是在**同步 P1 口径之后**针对最终代码重跑的。

## 6 PR 正文可粘贴段落

```
### GY-I19 第 3 步（Refs #19，不关闭整项）

- 交付 `services/api/src/privacy/backup-replay-manifest.ts`（纯新增内部模块）：恢复重放清单
  （需要重放哪些删除 / 顺序 / 稳定幂等键 / 每条证据要求 / 清单完整性摘要）+ 重放编排 +
  **「恢复后不得复活」验证**。单测 `tests/privacy/backup-replay-manifest.test.mjs`（8 用例）。
- **复用而非另起**：只读消费 `packages/privacy/deletion.mjs` 的三态/白名单、`constants.mjs` 的
  `HANDLER_STATES`/`THIRD_PARTY_STATES`、`user-data-deletion.ts` 的 `BackupPurgePort` fail-closed 口径、
  `deletion-aging.ts` 的 7/30 日期限口径。**既有文件零改动**，`packages/contracts/**` 零改动、
  未自造路由/字段（契约里没有备份/恢复/重放 operation）。
- **关键负例**：① 恢复含已删对象的快照 → 清单重放后对象仍不可见（并暴露"只比水位会误判覆盖"）；
  ② 漏重放/端口未接/清单被裁剪 ⇒ 可判别的 `pending`/`failed`（带原因码）+ 保持隔离，**绝不**表现为已恢复成功；
  ③ PK 冲突/重复重放 ⇒ 幂等（一份事实、稳定键、明确成功，无含糊结论）；
  ④ 期限是**上限**不是完成条件：无证据（期限内/已逾期）不得声称恢复安全，**期限内提前完成且有证据必须如实判安全**。
- **自证**：11 个变异（M1–M10、N1/N2）逐条改坏确认 `AssertionError` 真红后改回；如实记录了 1 次
  "工具改写导致语法错误"的无效尝试与 2 个因口径同步而作废的旧变异。
- 同 PR 含 **P1 期限语义修正**（`docs/verification/gy-i19-deletion-deadline-p1-20261015.md`）：期限=上限，
  期限内提前完成如实确认；第三方投影同步；`packages/privacy/deletion.mjs` 终态行为**未动**。
- 实现者=写手；推送者=指挥。**未取得**：真实备份系统/对象存储/第三方（本片零外部调用，测试用内存**替身**）、
  `deletion_tombstones`/`backup_inventory` 落库、真实恢复演练、真机与部署。
```

## 7 未取得项（如实）

- **真实第三方**：本片**零真实第三方调用**（第三方重播端口未接线 ⇒ `REPLAY_THIRD_PARTY_UNWIRED`，且测试断言**零调用**）。
- **真实备份系统 / 对象存储 / 恢复演练**：测试里的"备份快照"与"恢复目标存储"都是**内存替身**
  （`fakeTarget`，含 `live` 集合、`replay_key → evidence` 幂等账本），**不代表**真实备份系统已演练；
  真实 lineage/水位落库、对象存储 purge、跨集群恢复**均未涉及**。
- **`deletion_tombstones` / `backup_inventory` 的 durable 落库**：属 GY-I19 后续（`packages/privacy/README.md`
  已标明不在既有迁移范围）；本片只消费"清单行"这一形状。
- **HTTP 面**：契约里没有备份/恢复/重放 operation ⇒ **未自造路由**；`requestAccountDeletion` 等仍为 `planned`。
- **共享协议终态守卫**：`packages/privacy/deletion.mjs` 的「`failed` 可被 `confirmed` 覆盖、无终态守卫」
  是**已登记的只读观察**，监工已裁定**不把"重试成功必须永不允许"加成未经裁定的门槛** ⇒ 本片**不动**该行为。
- **真机 / 部署 / 真实数据库**：未涉及。
