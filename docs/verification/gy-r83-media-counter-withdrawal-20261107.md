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

`tests/unit/media-attachment-counter-withdrawal.test.mjs`（四条用例，零网络；第 1 条 import `services/api/src/media/service.ts` 与 `object-store.ts` 做一次真实装配，第 2 条 import 同一模块做运行时探针）。

**第一版与第二版锁的是源码文本形状，走不通。** 第二版独立审查（子代理 `08fbc066`）实测证明：那一版把 `#1030` 的**正确**实现（`fde1659e`）判红（它要的字面量 `createSubstituteAttachmentCounter());` 已不存在，实测 5 pass / 1 fail），同时被一句话变异绕过——展开运算符、类型别名、箭头函数体、换目录、`let` 重绑定，M2–M8 全绿。

**第三版只锁运行时行为，仍漏掉 `#1029` 的接线口。** 第三轮独立审查（P1）指出：`#1029` 的计数器在**独立模块** `services/api/src/media/attachment-counter-pg.ts`、**不从** `services/api/src/media/service.ts` 导出、且是**单参**工厂（被工厂枚举的 `factory.length > 0` 跳过），只在 `options.persistence?.kind === 'postgres'` 时接线——把那个实现原样放回来，运行时探针一条都不会响。现在一共四条判据：

1. **装配断言（P1 的补口）**：`createAppMediaService({ executionMode: 'real', objectStore: { ...createUnwiredObjectStore('r83 lock probe'), kind: 's3_compatible' }, realMediaApproval: approveRealMediaWiring({ reason: 'r83 structural lock' }), persistence: { kind: 'postgres' } })` —— real + 有 PG 持久化、但没有任何权威计数能力时，默认计数器必须是 `unwired`，且 `countFor({ ownerId: 'o', liveCommunityImages: 3 })` 必须是 `null`。语义是「默认计数器不允许随 owner 存活数变化」，与 `services/api/src/media/service.ts:835-838` 的禁令同一件事。**附加前提** `assert.equal(app.failClosedReason, null)`：fail-closed 分支内部同样用 `createUnwiredAttachmentCounter()`，不钉这个前提，「构造失败后退化到 unwired」也能凑出假绿。
2. **运行时行为**：枚举 `services/api/src/media/service.ts` 导出的每个零参 `create*AttachmentCounter()` 工厂，各造一个，用 `liveCommunityImages` 取 0 与取 7 各问一次 `countFor`；两者不等、且 `kind` 不是 `substitute`／`injected` 即红。它读运行时行为与运行时 `kind`，所以展开、别名、字符串拼接、换目录都绕不过；`#1030` 的 `createPostgresAttachmentCounter` 在 `fde1659e` 里是本地函数（未导出）⇒ 不误伤。**两次调用各自 `try`、各自 2 秒超时**（P2-1／P2-4）：任一次超时记 suspicious、**恰好一次抛错也记 suspicious**（「一半能查一半不能查」本身就可疑），只有两次都抛错（需要真实存储/网络的持久化计数器）才记 inconclusive。
3. **注入缝扫描**：`createInjectedAttachmentCounter` 在 `services/api/src/**` 里只允许定义处出现；`kind` 值的字面量按**单/双/反引号**宽匹配（``/kind\s*:\s*["'`]injected["'`]/``，P2-2），且除 `services/api/src/media/service.ts` 外**任何文件同时出现 `injected` 与 `countFor` 即违规**——换个文件用模板串/常量拼出同义写法也算复刻测试缝。
4. **禁令原文仍在**：`services/api/src/media/service.ts` 里「不得用同一 owner 名下存活记录数顶替」与「永久锁死」两句不能被悄悄删掉——那是撤回的依据。

**已知边界**：不导出、且只能靠真实存储构造的持久化计数器，运行时探针与注入缝扫描都摸不到；这类实现在本文件里**只由第 1 条装配断言兜底**（它不看实现形状，只看 `createAppMediaService` 在「real + PG 持久化」下最终选中的是哪个计数器）。

**旧用例兜不住这件事，本页不再那样声称**：审查者实测把 `#1029` 原样复活后，`tests/unit/media-attachment-limit.test.mjs` 仍 **6/6 全绿**。原因是四层叠加——计数器定义在独立模块（不在 `services/api/src/media/service.ts` 的导出面）、未从该模块导出（工厂枚举看不到）、单参工厂（被 `factory.length > 0` 跳过）、real 装配路径不注入 `persistence`（那条用例的 `realApp()` 不传，`persistence?.kind === 'postgres'` 永不成立）。旧用例测的是「real 且无 persistence 时默认 unwired」，与 `#1029` 的接线条件是互斥的两条路径。

**误伤面与命中面自证**（两棵临时 detached worktree，跑完即 `git worktree remove --force`；两棵树都挂了同一份 `node_modules` junction，本机 node v24.16.0）：

| 树 | 内容 | 读数 |
| --- | --- | --- |
| A | `fde1659e`（`#1030` 的正确实现） | 4 pass / 0 fail，**exit 0**（不误伤正确实现） |
| B | `736c0b47` + 把 `#1029` 原样复活：`git checkout 5f5e8ca7 -- services/api/src/media/attachment-counter-pg.ts`，再把 `services/api/src/media/service.ts` 的 import／union／wiring 三处改写回 `5f5e8ca7` 的原文 | 3 pass / 1 fail，**exit 1**；红在第 1 条装配断言：`actual 'postgres'` ≠ `expected 'unwired'`，报错文本 `real + PG 持久化时默认计数器不是 unwired：这正是 #1029 的接线口`，不是语法/导入错 |

**变异自证**（在 B 上 `git reset --hard 736c0b47` + 本文件后逐条施加，改完即还原；基线 4 pass / 0 fail、exit 0）：

| 变异 | 改动 | 读数 |
| --- | --- | --- |
| M2 | `createUnwiredAttachmentCounter().countFor` 改成返回 `liveCommunityImages`（`kind` 仍是 `'unwired'`） | 2 pass / 2 fail，exit 1（装配断言与运行时探针同时响） |
| M8 | 新导出 `createPostgresLikeAttachmentCounter()`，返回 `{ ...createSubstituteAttachmentCounter(), kind: 'postgres' }` | 3 pass / 1 fail，exit 1 |
| M3 | 新导出工厂：`kind` 走类型别名、`countFor` 写成箭头函数体直接返回 `liveCommunityImages` | 3 pass / 1 fail，exit 1 |
| M7 | 在 `services/api/src/community/` 新建文件，自造 `kind: "injected"`（**双引号**）且按 owner 计数的计数器 | 3 pass / 1 fail，exit 1（引号宽匹配与「injected + countFor 同文件」两条同时命中） |

## 这条记录不证明什么

- **不证明「每帖 ≤3 张」在 real 下可用**：现状仍是显式未接线（`503 post_image_limit_unwired`，`retryable:false`），正确实现在 `#1030`／`#1037`。
- **不证明撤回没有副作用**：`#1031` 把 `services/api/src/media/service.ts` 恢复到 4 行原样、删掉三个文件；`tests/unit/media-*.test.mjs` 163 pass 是撤回后的读数，与撤回前不可比。
- **不覆盖 `#1031` 审查里仍开放的两条 P2**：real+PG 的 503 缺自动化断言、符号覆盖 `UNDECLARED 265 → 238`（读数随时间漂，此处只记审查当时的观察）。其中「撤回在 docs 侧无留档」已由本页吸收；PR 正文的 CI 读数口径（当时写「未跑 CI」，PR 页面上实为 24/24）属历史原文，本页不改写它。
- **不含任何真库/真机读数**：本页所有事实都来自 git、源码文本与 GitHub API 元数据；其中 `closed_at`／`created_at` 等 API 字段未离线复核。

## 复核方式

```bash
git log --oneline -1 5f5e8ca7        # 被撤回的实现
git show 8130afd1 --stat             # 撤回提交
git show 8130afd1:services/api/src/media/service.ts | sed -n '160,175p;620,630p;830,860p'
node --test tests/unit/media-attachment-counter-withdrawal.test.mjs
git show fde1659e:services/api/src/media/service.ts | grep -n 'countPendingCommunityImages' | head
```

## 本轮复核读数（2026-11-07，分支 `test/gy-r83-withdraw-assembly`，基于 `736c0b47`）

| 闸门 | 命令 | 读数 |
| --- | --- | --- |
| 结构锁 | `node --test tests/unit/media-attachment-counter-withdrawal.test.mjs` | 4 pass / 0 fail，exit 0 |
| 误伤面 A | 同一命令在 `fde1659e`（`#1030` 正确实现）的临时树上 | 4 pass / 0 fail，exit 0 |
| 命中面 B | 同一命令在「`736c0b47` + 复活 `#1029`」的临时树上 | 3 pass / 1 fail，exit 1（红在装配断言） |
| 文档锚点 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | PASS，exit 0（UNDECLARED 242、配成对 1083；基线内无新增） |
| 契约台账 | `node tools/verify-contract-status.mjs` | PASS，exit 0（130 条操作、形状错误 0、语义错误 0） |
| media 单测 | `node --test tests/unit/media-*.test.mjs`（20 个文件） | 167 pass / 0 fail，exit 0 |

