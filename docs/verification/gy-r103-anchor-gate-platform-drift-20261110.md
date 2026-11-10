# R103：锚点闸门在 Windows 与 Linux 上的口径分叉（只读取证）

- 日期：2026-11-10
- 基线：`origin/main` = `00e221c1`
- 触发：在 Windows 本机反复执行 CI 同一条命令，稳定 `exit 1`；同一提交在 Linux CI 上 `success`。
- 本页只登记读数与已排除的假设，**不主张闸门放宽**，也不改动任何判据。

## 1. 现象

同一条命令、同一提交：

```
node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs
```

| 环境 | 退出码 | `BARE-ORPHAN-OUTSIDE` |
| --- | --- | --- |
| Windows 本机（Node 24.19.0） | **1** | 产出 112 条；册登记 117 条；命中 112、基线外新增 0、**陈旧 5** |
| Linux CI（Node 24.16.0，`contract-tests`） | **0** | 产出 117 条；册登记 117 条；命中 117、基线外新增 0、**陈旧 0** |

其余读数两边逐字一致：`BARE` 5190／继承 1721／无主 3469；`BARE-ORPHAN` 3469 命中 3469、陈旧 0；结构基线登记 48 条、命中 48；`SYMBOL-STRICT-BASELINE` 25 条；`COUNT: BROKEN 0 / OUT_OF_RANGE 1 / SUSPECT 37（Windows）vs 39（Linux）/ NOT_SYMBOL_LINE 8`。

## 2. 变陈旧的那 5 条

册（`tools/doc-anchors-orphan-baseline.json` 的 `outsideRed` 数组）里这 5 条在 Windows 上不再命中：

- `docs/verification/gy-i02-stale-claims-20261016.md` → `utils/messages-api.js` 第 202 行
- `docs/verification/gy-i02-stale-claims-20261016.md` → `utils/messages-api.js` 第 230 行
- `docs/verification/gy-i07-evidence-index-20261010.md` → `utils/auth.js` 第 205 行
- `docs/verification/gy-i11-voice-input-20261021.md` → `voice.js` 第 757 行
- `docs/verification/gy-r31-i26-recon-20261022.md` → `profile.js` 第 75 行

共同点：五条都是**不带 `miniprogram/` 前缀**的继承引用；而同一册里另有它们带前缀的孪生条目（`miniprogram/utils/messages-api.js` 等），那些在 Windows 上照常命中。

## 3. 已排除的假设（都实测过）

| 假设 | 实测 | 结论 |
| --- | --- | --- |
| 工作树有未提交改动／换行符 CRLF 差异 | `git status --porcelain` 为空；四份页面按字节统计 `CRLF=0`、bareLF 211/173/175/177 | 排除 |
| 仓库内的 `.local/wechat-local` 生成副本干扰文件名索引 | 把 `.local` 改名移走后重跑，仍是 112 条 / 陈旧 5 | 排除 |
| 是我此前某片改动引入 | 在 `origin/main` 干净树上直接复现 | 排除 |
| Node 小版本差异 | 未能在本机复现 Linux 侧（无 Docker；WSL Ubuntu 未装 Node） | **未排除**，但不足以解释「少 5 条」这种定向差异 |

## 4. 关键实验：不是拼写问题，是集合本身不同

把这 5 条与它们的带前缀孪生视为同一个锚点（键里的路径统一剥掉 `miniprogram/` 前缀）后在本机重算：

- 产出 112 条，册上（规范化后）100 条 ⇒ **命中 100、基线外新增 12、陈旧 17**。

如果两平台只是「同一批锚点的两种拼写」，规范化后应当 112 对 112、零新增零陈旧。实际出现 12 新增 / 17 陈旧，说明**两平台产出的锚点集合本身不同**：Windows 上有 12 条锚点以本机形态产出而册上没有，册上有 17 条锚点本机根本不产出。

由此可推出一条硬结论：**在 Windows 上跑 `--write-orphan-baseline` 会把 Linux 侧仍需的条目删掉，CI 随即报「基线外新增 5 条」。** 该写模式必须在 Linux（CI 同环境）上执行。

## 5. 能证明 / 不能证明

**能证明**

- 分叉确实存在且稳定：同命令、同提交、Windows `exit 1`、Linux `exit 0`。
- 分叉面被夹在 `BARE-ORPHAN-OUTSIDE` 这一个读数上；其余五组读数逐字一致。
- 本机重算孤儿册会破坏 CI（规范化实验已量化：12 新增 / 17 陈旧）。

**不能证明**

- 不能证明根因在工具代码的哪一处（`resolveTarget` 的文件名索引？裸锚点归属时的路径渲染？），因为没有 Linux 侧的可交互复现手段。
- 不能证明 Linux 侧那 117 条与 Windows 那 112 条的具体差集内容（只能从册的 5 条陈旧键反推）。
- 不声称 Windows 本机的红代表仓库有问题：CI 是权威，`contract-tests` 在该提交上 `success`。

## 6. 建议（都不属本页范围，留待评审决定）

1. 在工具头注里写明「孤儿册只在 Linux 上重算」——本页已在 `tools/verify-doc-anchors.mjs` 的用法注释里补了这段告警（含本页路径）。
2. 若要根治，需要一条 Linux 侧的可交互复现（容器或 WSL 装 Node），把 `collectFindings` 在两平台上的 `outsideRedAnchors` 全量 diff 出来，再决定是修归属逻辑还是让键规范化。
3. 在此之前，Windows 贡献者本地看到这 5 条陈旧属已知环境差异，以 CI 为准，不要删条目换绿。
