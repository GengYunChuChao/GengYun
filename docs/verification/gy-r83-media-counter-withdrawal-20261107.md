# 撤回记录：real 模式「社区图片每帖 ≤3 张」的 owner 累计近似（2026-11-07）

## 这份页记录什么

`#1029` 曾在 `main` 上短暂存在（`5f5e8ca7`，合入时刻 `2026-11-06T17:25:16Z`），随后按仓库自身禁令撤回（`#1031`，squash `8130afd1`，`17:50:22Z`）。撤回把实现、测试与那份证据页一起删掉，`main` 上因此不再有「为什么撤回」的记录——这份页补上那一层，并把撤回的理由做成机器可读的结构锁（`tests/unit/media-attachment-counter-withdrawal.test.mjs`）。

它**不**重述被删的那份证据页读数（那些读数随实现一起作废），也不改任何 AC。

## 事实

| 时间（HKT） | 事件 | 标识 |
| --- | --- | --- |
| 2026-11-07 01:25:16 | `#1029` 的实现在我关闭该 PR 的同一秒被监工合入 | merge `5f5e8ca7` |
| 2026-11-07 01:2x | 我读 `services/api/src/media/service.ts:835-838` 后判定实现与仓库禁令冲突，撤回 PR `#1029` | PR `#1029` closed_at `2026-11-06T17:25:16Z` |
| 2026-11-07 01:27 | 正确方向立项：post-scoped 附件挂载 | issue `#1030`（created_at `17:27:47Z`） |
| 2026-11-07 01:50:22 | 撤回 PR `#1031`（`git revert 5f5e8ca7`，4 文件 +4/−348）被合并 | head `d84f7321` → merge `8130afd1` |
| 2026-11-07 02:5x | `#1030` 的实现在 `#1037` 里接受审查（审查判「需要修改」，已整改） | PR `#1037` |

## 为什么撤回（仓库自己的判据）

`services/api/src/media/service.ts:835-838` 原文：

> ⛔ **不得**用同一 owner 名下存活记录数顶替 `unwired`：那是**生命周期累计**口径，而清理器……今天都没有生产调用者 ⇒ 累计数会让用户传满 3 张后**永久锁死**（只能手删），并且「先数后写」之间存在 TOCTOU……

`#1029` 的计数口径是 `state NOT IN ('deleted','rejected')`（含 `ready`），正是这条禁令描述的形状。当时的独立审查回合（子代理 `dcd552dd`，非 git 对象）另用变异证明：删掉那条 `state` 过滤后，当时那套用例**仍全绿**——即用例本身也守不住这个口径。

## 撤回之后，`main` 上钉住了什么

`tests/unit/media-attachment-counter-withdrawal.test.mjs`（零网络、只读源码）。它锁的是**口径**而不是名字，所以既不挡 `#1030` 的正确实现（`fde1659e` 加了 `kind: 'postgres'` 且走待用池），也能咬住 `#1029` 的形状：

1. **owner 存活记录数只允许出现在 `substitute` / `injected` 计数器里**：扫 `services/api/src/media/**/*.ts`（先剥注释），对每个 `countFor` **实现**取 ±600 字符窗口，窗口里出现 `liveCommunityImages` 就必须同时出现 `kind: 'substitute'` 或 `kind: 'injected'`。生效点：`createSubstituteAttachmentCounter`（替身，允许）、`createPostgresAttachmentCounter`（持久化，不允许）。
2. **持久化计数器必须走待用池**：`kind` 联合里只要有 `'postgres'`／`'persistence'`／`'storage'`／`'pg'` 之一，`service.ts` 就必须引用 `countPendingCommunityImages`；联合里一个都没有时（当前 `main` 的未接线状态），退化为要求 real 默认仍落 `createUnwiredAttachmentCounter()`（fail-closed）。
3. **`kind` 联合只有一处声明**：黑名单不能被第二份 `readonly kind:` 声明绕过。
4. **测试注入缝不得成为生产默认**：默认计数器表达式里不得出现 `createInjectedAttachmentCounter`（否则把 `'injected'` 当生产口径用，第 1 条就成了摆设）。
5. **承载「按 owner 存活记录计数」的新模块不得出现**：`services/api/src/media/attachment-counter-*.ts` 若存在且引用 `liveCommunityImages` 即红——`#1029` 正是把实现搬进新文件、绕过只扫 `service.ts` 的结构闸门。
6. **禁令原文仍在**（「不得用同一 owner 名下存活记录数顶替」「永久锁死」）——撤回的依据不能被悄悄删掉。

三条变异自证（在 `#1030` 的正确实现 `fde1659e` 的树上做，改完即还原、`git status` 干净）：把持久化计数器的 `countFor` 换成 `countFor({ liveCommunityImages }) { return liveCommunityImages; }`（`kind` 仍是 `'postgres'`）⇒ **exit 1**，红在第 1 条，报错原文「有 countFor 在消费「同一 owner 名下存活记录数」，但所在计数器不是 substitute / injected」。

## 这条记录不证明什么

- **不证明「每帖 ≤3 张」在 real 下可用**：现状仍是显式未接线（`503 post_image_limit_unwired`，`retryable:false`），正确实现在 `#1030`／`#1037`。
- **不证明撤回没有副作用**：`#1031` 把 `services/api/src/media/service.ts` 恢复到 4 行原样、删掉三个文件；`tests/unit/media-*.test.mjs` 163 pass 是撤回后的读数，与撤回前不可比。
- **不覆盖 `#1031` 审查里仍开放的两条 P2**：real+PG 的 503 缺自动化断言、符号覆盖 `UNDECLARED 265 → 238`（读数随时间漂，此处只记审查当时的观察）。其中「撤回在 docs 侧无留档」已由本页吸收；PR 正文的 CI 读数口径（当时写「未跑 CI」，PR 页面上实为 24/24）属历史原文，本页不改写它。
- **不含任何真库/真机读数**：本页所有事实都来自 git 与源码文本。

## 复核方式

```bash
git log --oneline -1 5f5e8ca7        # 被撤回的实现
git show 8130afd1 --stat             # 撤回提交
git show 8130afd1:services/api/src/media/service.ts | sed -n '160,175p;620,630p;830,860p'
node --test tests/unit/media-attachment-counter-withdrawal.test.mjs
git show fde1659e:services/api/src/media/service.ts | grep -n 'countPendingCommunityImages' | head
```
