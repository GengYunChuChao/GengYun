# 契约台账锚点自动重定位（--reanchor）验证记录

- 分支：`feat/gy-r31-reanchor`；工作树 `E:\GengYunCommander\wt-r31-reanchor`；基线 `origin/main`。
- 目标：把「改代码 ⇒ 证据锚点行号漂移 ⇒ `contract-tests` 红」这一类纯机械返修交给工具算，并保证工具在无法唯一定位时拒绝而不是猜。
- 不触碰的字段：`status` / `blocker` / `evidence.path` / `test`；不改任何业务代码语义；不引入新依赖。

## 1. 工具语义

`node tools/verify-contract-status.mjs --reanchor`（可与 `--write-doc` 组合）

| 模式 | 行为 | 退出码 |
| --- | --- | --- |
| `--reanchor` | dry-run：只打印候选（`path`、旧 `lines`、新 `lines`、命中行号、归属块首尾行），一个字节都不写 | 由既有校验结论决定（漂移未修 ⇒ 1） |
| `--reanchor --write-doc` | 只重写候选的 `lines` 字符串值，再走既有中文表格同步 | 0（全部可定位且校验通过时） |

拒绝规则（任一命中即整体 `exit 1` 且**不写盘**，写盘前先算完全部候选）：

- `MISSING`：锚点文本在 `path` 所指文件里出现 0 次；
- `AMBIGUOUS`：出现多次且落在**不同**归属块，列出全部候选行号与各归属块；
- `UNSAFE`：算出的区间恰好等于整个文件（校验器会自己判红），或写盘前的字节保真往返自检不通过。

归属块定义（实现见 `tools/contract-status-core.mjs` 的 `isDeclarationLine` / `enclosingBlock`，注释同处）：

1. 从命中行**向上**找最近的声明行：`function`、`const X =`、`class`、`interface`、`type`、`export` 声明、`app.<verb>(` 路由注册、`async name(` / `name(...) {` 这类对象方法/类方法；
2. 从声明行的第一个 `{` 起按花括号深度配对（跳过字符串/模板串/注释/正则字面量内部的花括号）求结束行，输出 `start-end`；
3. 向上找不到声明行 ⇒ 退化为「命中行单行」并在报告里标 `FALLBACK`。

字节保真：只在**字符偏移**层面替换 `lines` 的字符串值，键顺序、缩进、EOL、中文都不动；写盘前后把新值换回旧值必须逐字节等于原文本，否则按 `UNSAFE` 拒绝（这一条在临时副本与 fixture 里都有独立验证）。

## 2. 仓内基线（工作树，`origin/main`）

```
$ node tools/verify-contract-status.mjs
PASS: 覆盖 113 条契约操作；已装配 109 条；implemented 13 / partial 96 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
…
PASS: 中文表格一致
exit 0

$ node tools/verify-contract-status.mjs --reanchor
REANCHOR: 无可重定位项（带锚点且带行号的引用 240 条，锚点都在 ±2 行容差内）
…
PASS: 中文表格一致
exit 0
$ git status --porcelain        # 只有本片改的 tools/ 两个文件；台账与中文对照表无改动
```

## 3. 非空证明：真实案例在临时副本复原

临时副本 `E:\GengYunCommander\tmp-reanchor-proof`（整棵工作树复制，排除 `node_modules` 与 `.git`）。台账里 `dimension versioning` 的证据本来就是 `services/api/src/profile/service.ts` + `symbol:"cropItems"` + `lines:"86-87"`，在 `put()` 体内、`cropItems` 声明之前插入 4 行（模拟「catch 里按 SQLSTATE 分档」这类新增）后 `cropItems` 漂到第 91、93 行。

| 步骤 | 命令 | 读数 |
| --- | --- | --- |
| 制造漂移 | 插 4 行 | `cropItems` 命中 91、93 |
| ① 复现红 | `node tools/verify-contract-status.mjs` | exit 1：`ERROR: 语义错误 · dimension versioning: services/api/src/profile/service.ts:86-87 的锚点「cropItems」不在引用行范围内（容差 ±2 行；实际出现在第 91、93 行）` |
| ② dry-run | `node tools/verify-contract-status.mjs --reanchor` | `REANCHOR: dimension versioning services/api/src/profile/service.ts 旧 lines 86-87 → 新 lines 71-107（锚点「cropItems」命中第 91、93 行；归属块 71-107）`；`REANCHOR: 只报不改（dry-run）；1 条候选，加 --write-doc 才会写盘。`；exit 1；台账仍是 `"lines": "86-87"` |
| ③ 落盘 | `node tools/verify-contract-status.mjs --reanchor --write-doc` | `REANCHOR: 已重写 1 条 lines 值（只动这些字符串值，其余字节与改写前一致）。`；全项 `PASS`；`SYNC: 中文表格此前不是「中文表格一致」状态，已按 JSON 重写`；exit 0 |
| ④ 只动 lines 值 | `git diff --no-index`（工作树 vs 副本） | JSON：`1 file changed, 1 insertion(+), 1 deletion(-)`，diff 只有 `-      "lines": "86-87"` / `+      "lines": "71-107"`；对照 md 同样 1 行，证据格 `service.ts:86-87` → `service.ts:71-107` |
| ⑤ 幂等 | 再跑 `node tools/verify-contract-status.mjs --reanchor` | `REANCHOR: 无可重定位项（带锚点且带行号的引用 240 条，锚点都在 ±2 行容差内）`；`PASS: 中文表格一致`（没有 `SYNC` 行 ⇒ 未再写盘）；exit 0 |

等价性：算出的 `71-107` 就是 `async put(...)` 方法体的首尾行（插入 4 行后整体下移，原 71-103 → 71-107），与人工修法「锚到 `async put(...)` 声明 + 覆盖整个方法体」同一语义，只是不必手算行号。

## 4. fixture 读数

`node --test tests/unit/contract-status-reanchor.test.mjs` —— 5 个用例，5 通过 0 失败：

| 用例 | 断言要点 |
| --- | --- |
| ① 插 5 行后 dry-run | exit 1；打印 `旧 lines 8-9 → 新 lines 5-17`（命中第 13、15、16 行）；台账 sha256 不变 |
| ② `--reanchor --write-doc` | exit 0；`lines` 变 `5-17`；`after === before.replace('"lines": "8-9"', '"lines": "5-17"')`，掩码后 sha256 相等；对照表同步；再跑一次无候选、字节不变 |
| ③ AMBIGUOUS | 同一符号落在 `first`（2-5）与 `second`（11-14）两块 ⇒ `候选行号第 3、4、12、13 行`，exit 1，台账 sha256 不变 |
| ④ MISSING | 符号出现 0 次 ⇒ `（MISSING）`，exit 1，台账 sha256 不变 |
| ⑤ 仓内基线 | `--reanchor` 报「无可重定位项」、`PASS: 中文表格一致`、`stderr` 为空、台账字节不变 |

`npm run test:contract` → 6 通过 0 失败，exit 0。
同时跑了受影响的既有用例（`ci-contract-status-gate`、`contract-status-tool`、`contract-status-anchors`、`admin-route-family-consistency`、`contract-planned-exemptions`）→ 43 通过 0 失败，exit 0。
`npm run test:docs` → 通过（新增本页未破坏文档结构校验与链接校验），exit 0。

## 5. 边界（不做的事）

- 不改 `symbol` / `anchor` / `test` 的取值，不自动把 `symbol` 换成别的声明；只动 `lines`。
- 锚点漂移但**无锚点**（纯行号引用）的条目不在本工具范围内：没有可定位的锚点文本就不猜。
- 锚点在文件里出现多次且分属不同块时不猜、不取第一个，直接 `AMBIGUOUS` 让人判断。
- 不做格式化、不重排 JSON、不碰中文对照表的其它行；未开 `--write-doc` 时连表格都不重写。
- 不联网、不引入依赖、不读环境变量；Windows 外的行为不在本次验收范围。
