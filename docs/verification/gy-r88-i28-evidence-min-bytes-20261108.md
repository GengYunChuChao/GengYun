# #28 真机台账闸门的证据最小字节：1024 → 8192（R88，2026-11-08）

> 读数快照：2026-11-08T05:24+08:00（Asia/Hong_Kong）。基线 `origin/main` = `841bc1c3`（2026-11-08 05:07:09 +0800，`ci(ledger): 把账本真库臂接进 CI（承接 #1058，rebase 到 2aa5d433） (#1070)`）。本页所有读数都在工作树 `E:\GengYunCommander\.pg17\wt-r88-i28bytes`（分支 `test/gy-r88-i28-evidence-min-bytes`，HEAD 落在同一基线）上跑出来，不是从旧页抄的。
>
> 派单：R88 `#28`「台账闸门若只防 0 字节，占位成本太低」——证据最小字节 1024 → 8192。档位 A（只碰 `tests/**` 与 `docs/**`；`.github/**`、`tools/**` 一个字都没改）。

## 一、改了什么（只动数字与措辞，不动结构）

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| `tests/reference/i26-tabbar-skeleton.test.mjs:122`（常量） | `LEDGER_MIN_EVIDENCE_BYTES = 1024` | `LEDGER_MIN_EVIDENCE_BYTES = 8192` |
| `tests/reference/i26-tabbar-skeleton.test.mjs:38`（文件头判据描述） | 「且 ≥1024 字节（只防 0 字节占位，不是画质判据）」 | 「且 ≥8192 字节（只挡几 KB 的占位物，不是画质判据）」 |
| `tests/reference/i26-tabbar-skeleton.test.mjs:121`（常量注释） | 「只防 0 字节/占位文件」 | 「只把『几 KB 的占位物』挡在门外（8 KB 抬高占位成本）……也不是内容去重」 |
| `tests/reference/i26-tabbar-skeleton.test.mjs:431`（红文案） | 「（< 1024，防 0 字节占位）」 | 「（< 8192，防几 KB 的占位物）」 |
| `docs/verification/gy-i26-demo-align-20261014.md:783`（台账判据句） | 「≥1024 字节」「把任意 ≥2048 字节的文本改名成 `.png` 也能过」 | 「≥8192 字节」「把任意 ≥8192 字节的文本改名成 `.png` 也能过」，另补「8 KB 只是把占位成本从 1 KB 抬到 8 KB」 |
| `docs/verification/gy-r88-open-issue-acceptance-index-20261108.md:142`（已知限制） | 只写「只比路径、不比字节」，没有字节数 | 补「证据下限已从 1024 上调到 8192」「8 KB 只抬高占位成本，挡不住『同一张图另存四份』」 |

判据本身一个字没动：仍是「已取得 ⇒ 日期真实且不晚于今天 + 证据落在 `docs/verification/assets/` + 扩展名限 png/jpg/jpeg/webp + 是文件 + 字节数不小于下限 + 复核入口可执行」，比较符仍是 `<`（下限含等号）。三处措辞都保留原有的「只比路径、不比字节」「8.3 短名与长名只能人工复核」，**没有**把已知限制改写成「现在拦得住同一张图另存四份」——8 KB 改不掉「逐行唯一性只认路径」这件事。

## 二、零误伤实测：资产池 171 张，最小 12569 字节

先说实话：`docs/verification/gy-i26-demo-align-20261014.md:775-781` 的五条真机项今天**全部是「未取得」**，台账没有任何一行指向证据文件，所以闸门今天实际检到的字节数是 0 张。零误伤只能按「台账可能指向的池子」测——也就是 `docs/verification/assets/**` 下闸门认的那四类扩展名。

实跑 `git ls-files docs/verification/assets` 得 214 个在册文件，其中闸门认的 png/jpg/jpeg/webp 共 **171 张**（png 147 + jpg 24）；其余 43 个是 31 个 `.json`、4 个 `.log`、3 个 `.cjs`、1 个 `.mjs`、1 个 `.jsonl`、1 个 `.txt`、2 个无扩展名，不进闸门。

| 统计量 | 字节 |
| --- | --- |
| 最小 | 12569（`docs/verification/assets/gy-i08-pr90-native-20261012/before-detail-blank.jpg`） |
| 下四分位 | 59532 |
| 中位 | 88841 |
| 上四分位 | 120365 |
| 90 分位 | 184176 |
| 最大 | 773083（`docs/verification/assets/i07-knowledge-0cbfd97-320/contact-sheet.png`） |
| 合计 | 20319074（≈19.4 MiB） |
| 均值 | 118825 |

| 区间（字节） | 张数 |
| --- | --- |
| 0–1023 | 0 |
| 1024–8191 | 0 |
| 8192–16383 | 1 |
| 16384–32767 | 12 |
| 32768–65535 | 36 |
| 65536–262143 | 109 |
| 262144 以上 | 13 |

七个桶加起来是 171 张，与在册数一致。**最小一张 12569 ≥ 8192**，余量 4377 字节；也就是说把下限从 1024 提到 8192，池子里没有一张图会被判红——这就是「零误伤」的实测依据，不是估计。

再看实际被文档引用的那些：全仓（`*.md`／`*.mjs`／`*.js`／`*.json`／`*.yml`／`*.html`）里出现过 125 条不同的 `docs/verification/assets/...png|jpg|jpeg|webp` 路径，其中 124 条在册且最小 20007 字节（`docs/verification/assets/gui-adaptive-250c4d4/15-compile-success.png`），1 条 `docs/verification/assets/_probe-0byte.png` 是文档里拿来讲「路径不可核」的反例，仓里本来就没有这个文件（它若真被台账指向，闸门先报「不可核」，走不到字节判据）。

次小的四张（都在 8192 之上，全部不受影响）：18197 `docs/verification/assets/gy-i26-identify-voice-20261028/00-guest-login-gate.png`、18224 `docs/verification/assets/gy-i26-five-tabs-20261103/01-guest-gate-community.png`、20007 `docs/verification/assets/gui-adaptive-250c4d4/15-compile-success.png`、20540 `docs/verification/assets/home-info-row-20261027/login-gate.jpg`。

## 三、负控制：3 KB 的 png 必须红，真图必须绿

负控制的资产都不入册（跑完就删，`git status` 里没有它们），做法是把 `docs/verification/gy-i26-demo-align-20261014.md:777` 那一行临时改成「已取得 + 2026-11-08 + 证据路径」，跑完 `git checkout --` 复原。

1. **3 KB 占位图 ⇒ 红（改后）**：用一张 3072 字节的 PNG（1×1 真 PNG 尾部补零，闸门只量字节、不看像素），整跑 `node --test tests/reference/i26-tabbar-skeleton.test.mjs` 得 **7 过 1 红**，红的就是「真机台账：状态只许闭集取值；未取得必带可核欠账，已取得必带真实日期与 assets/ 下的非空截图」。断言在 `tests/reference/i26-tabbar-skeleton.test.mjs:429-432`，错误文案原文：

   ```
   「真机逐页走查（Android／iOS）」的证据文件只有 3072 字节（< 8192，防几 KB 的占位物）：docs/verification/assets/gy-r88-i28-neg-20261108/neg-3kb.png
   ```

2. **同一张 3 KB 图 ⇒ 绿（改前）**：把常量临时改回 1024、证据不动，同一条用例 **8 过 0 红**。这条前后对照说明红灯是阈值上调带来的，不是我这行台账改坏了别的判据。
3. **边界三连**：8191 字节 ⇒ 红（`…只有 8191 字节（< 8192，防几 KB 的占位物）…`）、8192 字节 ⇒ 绿、8193 字节 ⇒ 绿。判据是 `bytes < LEDGER_MIN_EVIDENCE_BYTES`，下限含等号。
4. **真图 ⇒ 绿**：把同一行指向池子里最小的真图 `docs/verification/assets/gy-i08-pr90-native-20261012/before-detail-blank.jpg`（12569 字节），**8 过 0 红**；再指向 8193 字节那张也绿。
5. **原有合成负控制不受影响**：`tests/reference/i26-tabbar-skeleton.test.mjs:728` 的注入用 `fakeBytes`（0 字节那条恒 0、其余 612672），612672 ≥ 8192 ⇒ 合法行仍零违规、0 字节仍红，`真机台账闸门负控制` 那条用例改动前后都是绿的。

## 四、为什么是 8 KB，而不是哈希去重

测试里已经把这层边界写死了：`tests/reference/i26-tabbar-skeleton.test.mjs:950-951` 自陈「只比路径、不比字节——同一张图另存四份字节相同的拷贝仍能点亮四行，这条拦不住，也不该假装拦住（内容去重要么存哈希、要么人眼看，都不属于本闸门的职责）」。所以这次只在同一个判据面上抬下限：

- 8 KB 挡的是**免费动作**：`touch` 出 0 字节、`echo` 出几十字节、拿 1×1 像素点点名。这类占位过去 1024 就能过，现在要凑够 8 KB，虽然不是硬门槛（一张 8 KB 的空白 PNG 也就一行代码），但把「顺手占位」变成了「刻意造一张像截图的文件」。
- 哈希去重不是加个判断就行：它要改台账的列契约（多一列哈希或旁挂清单）、要处理「同一画面真机重拍字节必然不同」的假阴性、还得有人先认下「这张图和那张图是同一画面」——那是内容判据，不是形状判据。本闸门的职责边界就是形状：路径归一化、扩展名、目录、存在性、体积。
- 8 KB 也不解决 8.3 短名与长名是不同字符串键的问题（关闭 8dot3name 的卷上连短名都造不出来），那一条继续靠人工复核，`docs/verification/gy-r88-open-issue-acceptance-index-20261108.md:142` 已如实写着。

## 五、七道闸门读数（尾行照抄）

1. `node --test tests/reference/i26-tabbar-skeleton.test.mjs` ⇒ `ℹ tests 8`、`ℹ pass 8`、`ℹ fail 0`、`ℹ skipped 0`（8 组用例全绿，含真机台账两条与合成负控制一条）。
2. `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` ⇒ 尾行 `PASS: --strict 下没有基线之外的新增`。其中 `BARE-ORPHAN:` 行：册上登记 3478 条、本次命中 3478 条、基线外新增 0 条、陈旧 0 条；`SYMBOL-COVERAGE-VERIFICATION-GATE:` 行：基线 UNDECLARED 265、本次 253，配对 1051 → 1147，不在区间都是 44（只降不升）。
3. `node tools/verify-contract-status.mjs` ⇒ 尾行 `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。`（连续 6 条 PASS，无 RED、无 MISSING／AMBIGUOUS／UNSAFE）。
4. `npm run test:docs` ⇒ 三件都过：`PASS docs/research 结构校验`（5 通过 / 0 失败 / 4 legacy 钉住）、`PASS` 开发文档校验、`PASS: 识别 5 页 / 跳过 344 页（扫描面 349 页：docs/verification）——读数七条判据全部自洽`。本页没有族读数表，被当作「跳过」的 344 页之一，不参与读数判据。
5. `node --test "tests/unit/*.test.mjs"`（`GY_BASH='D:\Git\bin\bash.exe'`）⇒ `ℹ tests 5668`、`ℹ pass 5665`、`ℹ fail 0`、`ℹ skipped 3`、`ℹ duration_ms 552293`。
6. `npm run lint` ⇒ `PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、`PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）`、尾行 `lint 通过（静态检查；不代表运行期或真实服务已通过）。`
7. `git merge-tree --write-tree --name-only origin/main HEAD` ⇒ 只打印一个树对象名，第二段没有冲突文件清单，`exit 0`：与当时的 `origin/main`（`b617894c`，`docs(i29)` #1072）无冲突，本分支不需要先 rebase 也能合。

附带说明：`tests/unit` 全套第一次跑（提交之前、`HEAD` 与 `origin/main` 还是同一个提交）时有 1 条红——`tests/unit/doc-anchor-relocation-identity.test.mjs` 自陈「base 与 HEAD 同一提交 …… 本用例没有判定面，不允许静默通过」。这是「还没提交」造成的假红（用例要求 base 与 HEAD 不同），提交后单独复跑该文件 37 条：36 过、1 跳过、0 红。记录在案，免得下次把这行红当成位移。

## 六、锚点位移：0 行

- `tests/reference/i26-tabbar-skeleton.test.mjs` 改动全是同行替换（`git diff --numstat` 是 4 加 4 删），文件仍 955 行；被别的证据页引用的那几处（判据常量、字节判定与红文案、路径归一化句、文末已知限制）都留在原行原地，一个都没挪。
- `docs/verification/gy-i26-demo-align-20261014.md` 只改 §12 表尾那句判据与已知限制，改在同一行内，文件仍 783 行。
- `docs/verification/gy-r88-open-issue-acceptance-index-20261108.md` 改的都是同一行内文字，另在第八节末尾追加一条「更正旧页」，文件 169 → 170 行；追加在页尾，不移动任何既有锚点。

## 七、本页不声称什么

1. **不声称台账里已经有真机证据**：`docs/verification/gy-i26-demo-align-20261014.md:775-781` 五条仍是「未取得」，本次只动阈值与措辞，没有新增一张截图、没有一条「已取得」。
2. **不声称 8 KB 能防住重复证据**：同一张图另存几份字节相同的拷贝仍能点亮多行（`tests/reference/i26-tabbar-skeleton.test.mjs:950-951`），8 KB 只是把占位成本从 1 KB 抬到 8 KB。
3. **不声称字节数等于证据质量**：171 张的分布只说明体积，说明不了截图是不是真机、是不是同一画面、有没有被裁剪。
4. **不声称覆盖了 8.3 短名一类绕过**：闸门只比归一化后的路径，短名与长名是不同字符串键，仍靠人工复核。
5. **不声称跑过真机**：五 Tab 真机逐页走查仍缺设备与稳定的 automator 端口（`docs/verification/gy-i26-demo-align-20261014.md:772-773`），本页没有一台真机的读数。
6. **不声称闸门能替代人眼**：它能拦「没证据却写已取得」「拿几 KB 占位图充数」，拦不了「拍了一张，但不是这一项」。
