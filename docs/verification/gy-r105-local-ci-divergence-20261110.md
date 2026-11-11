# 本机与 CI 的六处结果分叉（R105）

> 状态：登记 / 不等同修复。记录本机（Windows 11 + Git 2.55.0）与 Linux CI 在**同一提交**上的六处不可避免的差异；不把其中任何一处说成「本机 bug」或「CI 缺陷」。
>
> 基线：`origin/main = cfa2b792`（2026-11-10），也是 #1195（R103 `.local` 跳过点目录）的合并提交。已确认该提交在 CI 上 `unit-tests` 全绿（exit 0），本机同一提交出现 7063 tests / 7022 pass / 39 fail —— 其中约 37 条纯由行尾造成（归一化 LF 后降至 7066 tests / 7063 pass / 1 fail，唯一失败为恒等测试 `base == HEAD` 伪影）。

## 1. 行尾 CRLF

- **现象**：本机工作区文本文件混入 CR（`\r\n`）导致 39 条单测假红；`git add --renormalize` 归一化为 LF 后降至 1 条（恒等测试 `base == HEAD` 伪影）。
- **CI**：全程 LF，全绿。
- **根因**：本机 `core.autocrlf` 曾为 `true`，部分历史文件以 CRLF 入索引；`.gitattributes` 的 `text eol=lf`（#1200）只能阻止新入，不能回溯旧索引条目。
- **处置**：#1200 的 `tests/unit/gitattributes-text-eol-lf.test.mjs` 守卫已覆盖 `i/crlf` 与 `i/mixed`，并当场发现 `miniprogram/pages/home/home.wxss` 索引侧 `i/mixed`（已 `git add --renormalize` 修正）。

## 2. demo-align

- **现象**：本机 `node tools/demo-align.mjs` 在行尾归一化前把仅行尾差异的文件判为不一致。
- **CI**：一致。
- **根因**：比对函数未归一化行尾。
- **处置**：#1200 的 `tools/demo-align.mjs` 已在比对照前归一化行尾，修复后本机与 CI 一致。

## 3. .local 污染文件名索引

- **现象**：本机 `BARE-ORPHAN-OUTSIDE` 读数 112/117、陈旧 5；Linux CI 117/117/0。
- **CI**：一致（117/117/0）。
- **根因**：`buildFileNameIndex()` 不跳点目录 ⇒ 仓内 `.local/wechat-local` 让裸文件名锚点出现 2 候选 ⇒ `resolveTarget()` 返 `ambiguous` ⇒ 按设计不判红也不进 `outsideRed` ⇒ 5 条静默消失。
- **处置**：#1195 的索引改「点目录跳过、`.github` 例外」（全跳过会让 10 条引用 `.github/workflows/*.yml` 的真锚点变 BROKEN）。
- **验证**：`.local` 移出仓库 ⇒ 117/陈旧 0；放回 ⇒ 112/陈旧 5。只改名 `.local-off` 无效（点目录仍在仓内）。

## 4. .local 污染行尾守卫

- **现象**：`tests/unit/eol-normalization.test.mjs` 把 `.local` 下的生成文件当仓库文本扫出 71 条 CR 违规。
- **CI**：无 `.local` 目录，0 条。
- **处置**：#1208 的 `SCAN_SKIP_DIRS` 加 `.local` 后 0 条，并含反向自证（在 tmpdir 造假 `.local/probe/probe.js` 验证守卫不会静默跳过所有点目录）。

## 5. node_modules junction

- **现象**：本机 `node_modules` 是指向另一 checkout 的 Windows junction；OCR 集成测试读到期望外的平台差异。
- **CI**：无 junction，一致。
- **根因**：Windows junction 不是符号链接也不是普通目录，部分工具按实际路径解析后跨越了仓库边界。
- **处置**：不修（本机配置问题，非代码缺陷；CI 上不存在此路径）。

## 6. failmatrix 时钟冻结

- **现象**：`tests/failmatrix` 的 scriptedClock（`tests/failmatrix/world.mjs` 里的 `export function scriptedClock(startMs = START)`，只暴露 `now()` 与 `ms`）返回固定 epoch，429 `RATE_LIMITED` 后的 60s 窗口恢复不可证。
- **CI**：同（共用同一 stub 世界，`scriptedClock` 无 `advance()`）。
- **处置**：不修（429 后的窗口恢复需要真实时间流逝或 `scriptedClock.advance()`，后者未交付；与可达性断言覆盖范围无关）。

---

**本页不写路径:行号格式锚点**，因为六条分叉不是代码文件的属性，而是本机运行时环境的结果。引用的 issue/PR 编号：`#1195`（R103 .local 跳过点目录）、`#1196`（R104 demo-align 行尾归一）、`#1200`（eol 守卫重写）、`#1208`（行尾扫描跳过 .local）。