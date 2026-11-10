# R103：锚点闸门「本机少 5 条」的根因（仓库内 `.local` 副本让裸文件名变歧义）

- 日期：2026-11-10
- 基线：`origin/main` = `00e221c1`（发现根因时的树；修复片见 §7）
- 触发：在 Windows 本机反复执行 CI 同一条命令，稳定 `exit 1`；同一提交在 Linux CI 上 `success`。
- 结论先行：**不是操作系统差异**，是仓库里那份未纳入版本控制的小程序副本（`prepare-wechat` 生成的 `.local/wechat-local`）被文件名索引一并收进去，让裸文件名引用变 `ambiguous`、锚点静默不判定。
- 本页只登记读数与实验，**不主张闸门放宽**，也不改动任何判据。

## 1. 现象

同一条命令、同一提交：

```
node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs
```

| 环境 | 退出码 | `BARE-ORPHAN-OUTSIDE` |
| --- | --- | --- |
| Windows 本机（Node 24.19.0，仓库内有 `.local` 副本） | **1** | 产出 112 条；册登记 117 条；命中 112、基线外新增 0、**陈旧 5** |
| Linux CI（Node 24.16.0，`contract-tests`） | **0** | 产出 117 条；册登记 117 条；命中 117、基线外新增 0、**陈旧 0** |

其余读数两边逐字一致：`BARE` 5190／继承 1721／无主 3469；`BARE-ORPHAN` 3469 命中 3469、陈旧 0；结构基线登记 48 条、命中 48；`SYMBOL-STRICT-BASELINE` 25 条；`COUNT: BROKEN 0 / OUT_OF_RANGE 1 / SUSPECT 37（本机）vs 39（CI）/ NOT_SYMBOL_LINE 8`。

## 2. 变陈旧的那 5 条

册（孤儿册的 `outsideRed` 数组）里这 5 条在本机不再命中：

- `docs/verification/gy-i02-stale-claims-20261016.md` → `utils/messages-api.js` 第 202 行
- `docs/verification/gy-i02-stale-claims-20261016.md` → `utils/messages-api.js` 第 230 行
- `docs/verification/gy-i07-evidence-index-20261010.md` → `utils/auth.js` 第 205 行
- `docs/verification/gy-i11-voice-input-20261021.md` → `voice.js` 第 757 行
- `docs/verification/gy-r31-i26-recon-20261022.md` → `profile.js` 第 75 行

共同点：五条都是**裸文件名或不带 `miniprogram/` 前缀**的引用；同一册里另有它们带前缀的孪生条目（`miniprogram/utils/messages-api.js` 等），那些照常命中。

## 3. 排除假设的过程（含一次我自己搞错的排除）

| 假设 | 实测 | 结论 |
| --- | --- | --- |
| 工作树有未提交改动／换行符 CRLF 差异 | 工作树干净；四份页面按字节统计 `CRLF=0`、bareLF 211/173/175/177 | 排除 |
| 是我此前某片改动引入 | 在 `origin/main` 干净树上直接复现 | 排除 |
| 仓库内 `.local/wechat-local` 副本干扰文件名索引 | 第一次只把 `.local` **改名**成 `.local-off` 就重跑，仍是 112 条 ⇒ 当时判为「排除」 | **排除错了**：改名不改变「点目录仍在仓库内」，见 §4 |
| Node 小版本差异（本机 24.19.0 vs CI 24.16.0） | 未能在本机跑 Linux 侧（无 Docker；WSL 里没有 Linux 版 Node） | 未能验证；§4 定位后已不必用它解释 |

## 4. 定位：把副本**移出仓库**才复原

用工具自带的 `--emit-orphan-baseline` 把本机实际产出的册子打出来，再对照提交进仓库的那份：

| 条件 | `outsideRed` 产出 | 与册（117 条）对照 |
| --- | --- | --- |
| `.local` 在仓库内 | **112** 条 | 命中 112、陈旧 5 |
| `.local` 改名成 `.local-off`（仍在仓库内） | **112** 条 | 命中 112、陈旧 5 |
| `.local` **移出仓库**（移到仓库同级目录） | **117** 条 | 命中 117、**陈旧 0** |

机制（读代码 + 直接调函数探针，均在本机完成）：

1. 工具建「同名文件索引」时从仓库根递归，只跳过一份固定目录名单（`node_modules`、`.git`、`dist` 等），**没有跳过点目录**；`walkMarkdown` 那边本来就只收非点目录，两处口径不一致。
2. 于是 `.local/wechat-local/miniprogram/...` 与 `miniprogram/...` 里的同名文件同时进索引。
3. 解析裸文件名时按「同名候选恰好 1 个」才认，候选变 2 个 ⇒ 返回 `ambiguous`；而 `ambiguous` 按设计**不判红、也不进 `outsideRed`**（「不瞎猜」）。
4. 结果：这 5 条锚点既没被判通过、也没被判红，直接消失 ⇒ 册上对应条目变「陈旧」⇒ 本机 `exit 1`。

探针读数（本机，`.local` 存在时）：

```
resolveTarget({ target: 'voice.js' })
→ { status: 'ambiguous', candidates: ['.local/wechat-local/miniprogram/pages/voice/voice.js',
                                      'miniprogram/pages/voice/voice.js'] }
```

把副本移出仓库后，同一调用变成唯一解析到 `miniprogram/pages/voice/voice.js`。

## 5. 能证明 / 不能证明

**能证明**

- 本机 `exit 1` 与仓库内 `.local` 副本一一对应：移出即 117／陈旧 0，放回即 112／陈旧 5，可反复复现。
- 差异面只在 `BARE-ORPHAN-OUTSIDE` 一个读数上；其余五组读数与 CI 逐字一致。
- 工具的口径不一致是真的：文档扫描跳过点目录，文件名索引不跳过。

**不能证明**

- 不证明 CI 侧有任何问题：CI 没有这份副本，117／陈旧 0 是对的，以 CI 为权威。
- 不证明其它点目录（`.venv`、`.cache` 之类已在跳过名单里，但未来新增的）不会造成同类干扰；本页只核了 `.local`。
- 不主张把 `ambiguous` 改判红：那是「引用写得不够唯一」的既有设计，改它会波及大量历史页。

## 6. 建议

1. **修工具**：文件名索引与文档扫描同口径——跳过点目录。这样本机有没有 `.local` 副本都不影响读数（修复片见 §7）。
2. 在工具用法注释里写明：重算孤儿册前先清掉仓库内的本地副本，别在脏树上重算。
3. 在那之前，Windows 贡献者本地看到这 5 条陈旧属已知环境差异，以 CI 为准，**不要删条目换绿**。

## 7. 修复（R103b）

`buildFileNameIndex` 的递归条件从「只跳过固定目录名单」改为「固定目录名单 + 以 `.` 开头的目录一律跳过」，与该文件里 `walkMarkdown` 的既有约定对齐；同时补一条单测锁定这条规则（含负控制：两个**非点目录**的同名文件仍判 `ambiguous`，防止把歧义规则整体放宽）。

修复后本机（`.local` 仍在仓库内）跑 §1 那条命令应为 `exit 0`、`outsideRed` 117 条、陈旧 0。
