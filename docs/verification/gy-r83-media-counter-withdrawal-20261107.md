# 撤回记录：real 模式「社区图片每帖 ≤3 张」的 owner 累计近似（2026-11-07）

## 这份页记录什么

`#1029` 曾在 `main` 上短暂存在（`5f5e8ca7`），随后按仓库自身禁令撤回（`#1031`，squash `8130afd1`）。撤回把实现、测试与证据页一并删掉，`main` 上因此不留任何「为什么撤回」的记录——这份页补上那一层，并把撤回的理由做成机器可读的结构锁（`tests/unit/media-attachment-counter-withdrawal.test.mjs`）。

它**不**重述被删的那份证据页读数（那些读数随实现一起作废），也不改任何 AC。

## 事实

| 时间（HKT） | 事件 | 标识 |
| --- | --- | --- |
| 2026-11-07 01:2x | `#1029` 的实现在我关闭该 PR 的同一秒被监工合入 | merge `5f5e8ca7` |
| 2026-11-07 01:2x | 我读 `services/api/src/media/service.ts:835-838` 后判定实现与仓库禁令冲突，撤回 PR `#1029` | PR `#1029` closed_at `2026-11-06T17:25:16Z` |
| 2026-11-07 01:3x | 撤回 PR `#1031`（`git revert 5f5e8ca7`，4 文件 +4/−348） | head `d84f7321` → merge `8130afd1` |
| 2026-11-07 02:0x | 正确方向立项：post-scoped 附件挂载 | issue `#1030` |
| 2026-11-07 02:5x | `#1030` 的实现在 `#1037` 里接受审查 | PR `#1037` |

## 为什么撤回（仓库自己的判据）

`services/api/src/media/service.ts:835-838` 原文：

> ⛔ **不得**用同一 owner 名下存活记录数顶替 `unwired`：那是**生命周期累计**口径，而清理器……今天都没有生产调用者 ⇒ 累计数会让用户传满 3 张后**永久锁死**（只能手删），并且「先数后写」之间存在 TOCTOU……

`#1029` 的计数口径是 `state NOT IN ('deleted','rejected')`（含 `ready`），正是这条禁令描述的形状。独立审查（`dcd552dd`）另用变异证明：删掉那条 `state` 过滤后，当时的用例**仍全绿**——即用例本身也守不住这个口径。

## 撤回之后，`main` 上钉住了什么

`tests/unit/media-attachment-counter-withdrawal.test.mjs`（4 条，零网络、只读源码）：

1. 默认附计数器表达式**不得引用**持久化端口（`persistence`），且 real 分支必须落到 `createUnwiredAttachmentCounter()`（fail-closed）；
2. `services/api/src/media/attachment-counter-pg.ts` **不得存在**——`#1029` 正是把它搬进新文件、绕过只扫 `service.ts` 的结构闸门；
3. `CommunityAttachmentCounter.kind` 的联合类型不得出现 `'postgres'`／`'persistence'`／`'storage'`／`'pg'`；
4. 禁令原文（「不得用同一 owner 名下存活记录数顶替」「永久锁死」）仍在 `service.ts` 里——撤回的依据不能被悄悄删掉。

## 这条记录不证明什么

- **不证明「每帖 ≤3 张」在 real 下可用**：现状仍是显式未接线（`503 post_image_limit_unwired`，`retryable:false`），正确实现在 `#1030`／`#1037`。
- **不证明撤回没有副作用**：`#1031` 把 `services/api/src/media/service.ts` 恢复到 4 行原样、删掉三个文件；`tests/unit/media-*.test.mjs` 163 pass 是撤回后的读数，与撤回前不可比。
- **不覆盖 `#1031` 审查的四条 P2**：PR 正文的 CI 读数口径（当时写「未跑 CI」，实际 24/24）、real+PG 的 503 缺自动化断言、结构闸门只扫 `service.ts`、符号覆盖 `UNDECLARED 265 → 237`。前两条已由本页与结构锁部分吸收；后两条仍开放。
- **不含任何真库/真机读数**：本页所有事实都来自 git 与源码文本。

## 复核方式

```bash
git log --oneline -1 5f5e8ca7        # 被撤回的实现
git show 8130afd1 --stat             # 撤回提交
git show 8130afd1:services/api/src/media/service.ts | sed -n '160,175p;620,630p;830,860p'
node --test tests/unit/media-attachment-counter-withdrawal.test.mjs
```
