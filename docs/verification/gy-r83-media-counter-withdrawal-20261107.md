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

`tests/unit/media-attachment-counter-withdrawal.test.mjs`（三条用例，零网络；第一条会 import `services/api/src/media/service.ts` 做运行时探针）。

**第一版与第二版锁的是源码文本形状，走不通。** 第二版独立审查（子代理 `08fbc066`）实测证明：那一版把 `#1030` 的**正确**实现（`fde1659e`）判红（它要的字面量 `createSubstituteAttachmentCounter());` 已不存在，实测 5 pass / 1 fail），同时被一句话变异绕过——展开运算符、类型别名、箭头函数体、换目录、`let` 重绑定，M2–M8 全绿。现在的判据是**运行时行为**：

1. **除替身与测试缝外，任何计数器的返回值都不得随 owner 存活记录数变化**：枚举 `service.ts` 导出的每个零参 `create*AttachmentCounter()` 工厂，各造一个，用 `liveCommunityImages` 取 0 与取 7 各问一次 `countFor`；两者不等、且 `kind` 不是 `substitute`／`injected` 即红。它读运行时行为与运行时 `kind`，所以展开、别名、字符串拼接、换目录都绕不过；`#1030` 的 `createPostgresAttachmentCounter` 在 `fde1659e` 里是本地函数（未导出）⇒ 不误伤。查询抛错（需要真实存储）的计数器记为 inconclusive，不据此判红也不据此判绿。
2. **测试注入缝不得出现在生产装配里**：`createInjectedAttachmentCounter` 在 `services/api/src/**` 里只允许定义处出现；`kind: 'injected'` 也只允许出现在 `service.ts`（换目录自造一个「测试缝」同样算违规）。
3. **禁令原文仍在**：`service.ts` 里「不得用同一 owner 名下存活记录数顶替」与「永久锁死」两句不能被悄悄删掉——那是撤回的依据。

**已知边界**：不导出、且只能靠真实存储构造的持久化计数器，运行时探针摸不到；那种实现的行为由既有 `tests/unit/media-attachment-limit.test.mjs`（默认 real 必须 `unwired`、`unwired` 对 `live=3` 必须返 `null`）兜底。本页不声称两条合起来证明了「不可能再写出 owner 累计口径」。

**变异自证**（在 `#1030` 的正确实现 `fde1659e` 的树上做，改完即还原、`git status` 干净；基线不改 ⇒ 3 pass / 0 fail、exit 0）：

| 变异 | 改动 | 读数 |
| --- | --- | --- |
| M2 | `createUnwiredAttachmentCounter().countFor` 改成返回 `liveCommunityImages`（`kind` 仍是 `'unwired'`） | 2 pass / 1 fail，exit 1 |
| M8 | 新导出 `createPostgresLikeAttachmentCounter()`，返回 `{ ...createSubstituteAttachmentCounter(), kind: 'postgres' }` | 2 pass / 1 fail，exit 1 |
| M3 | 新导出工厂：`kind` 走类型别名、`countFor` 写成箭头函数体直接返回 `liveCommunityImages` | 2 pass / 1 fail，exit 1 |
| M7 | 在 `services/api/src/community/` 新建文件，自造 `kind: 'injected'` 且按 owner 计数的计数器 | 2 pass / 1 fail，exit 1 |

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
