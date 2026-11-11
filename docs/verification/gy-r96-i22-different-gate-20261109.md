# GY-R96：把「different 静默变绿」的缺口用 CI 闸门堵上（#22）

- 基线：`origin/main` 的 `a095e88b`（`a095e88b537bffffa5c9f9d2174c72922eeef3a9`，提交 `feat(privacy): add media egress lifecycle logs (#1156)`）。本片以该提交为基线；页内读数取自该提交在 CI 上的 artifact。
- 本页所有「路径:行号」都写全路径，行号按 `git`／`node` 的换行（`\n`）计数。⚠️ 本机 PowerShell 5.1 的 `Get-Content` 用 ANSI 解码 UTF-8，中文行尾的换行会被吞掉，数出来的行号偏小（同一个文件会把第 1374 行数成第 1362 行），核对行号不要用它。

## 1 事实：真库臂今天 different = 0

读数来自 CI artifact 里的 `real.json`，**不是本机复跑**。CI run `42600701868`（main `a095e88b`）的 artifact `failmatrix-real-a095e88b537bffffa5c9f9d2174c72922eeef3a9`：

```text
postgres: 17.11 (Ubuntu 17.11-1.pgdg24.04+2)
totals: total 180, same 180, sameWithCheck 25, sameWithShape 30,
        different 0, differentFromCheck 0, differentFromShape 0, not_runnable 0
```

⇒ 180 条权限面用例全部取得逐条读数，`different` 为 0。这个 0 是本页的**前提**，不是本页的结论：本页要堵的是「这个 0 以后变成 1、2、3 时，流水线仍然绿」。

## 2 缺口：闸门没开

- `.github/workflows/real-pg-integration.yml:1374` 原来只带 `--require-no-not-runnable`，没有 `--require-no-different`。
- 判据本身早在 R89 就落地了：`tests/failmatrix/run-real.mjs:1047` 的解析分支接受这个开关，`tests/failmatrix/run-real.mjs:1622` 把原来无条件的 `return 0` 换成 `return shouldFailOnDifferent(opts, tally, rows);`，判据与 FAIL 文案在 `tests/failmatrix/require-no-different.mjs:77`。
- 缺的只是 CI 那一处调用：`tests/failmatrix/run-real.mjs:1616` 的 `return 1` 只看 `not_runnable`，所以 `different > 0` 时整臂仍然 exit 0。R89 的证据页自己也写明了这一点（`docs/verification/gy-r89-failmatrix-require-no-different-20261108.md:108`：「脚本现在**有能力**判红，但 … 调这条臂时**没有加**」）。
- 这和当初 13 条 `not_runnable` 却 CI 绿是同一个失效模式：**判据在仓里、闸门在 CI 外**，读数照写，流水线照绿。

## 3 本片改了什么

| 文件与行号 | 改动 |
| --- | --- |
| `.github/workflows/real-pg-integration.yml:1374` | 同一条命令行在 `--require-no-not-runnable` 之后加 `--require-no-different`；其余字符一个没动，该文件行数不变，第 1374 行仍是这条调用。 |
| `tests/unit/failmatrix-require-no-different.test.mjs:281` | 文件末尾追加一条 `test(...)`（+26 行，不新增依赖，沿用该文件已有的 `readFileSync`／`join`／`ROOT`）：`tests/unit/failmatrix-require-no-different.test.mjs:286` 的单行正则要求同一行里按序出现 `node tests/failmatrix/run-real.mjs`、`--require-no-not-runnable`、`--require-no-different`；`tests/unit/failmatrix-require-no-different.test.mjs:296` 起是反向自证——把开关字样从文本里删掉后，同一条正则必须不匹配。 |
| `tests/failmatrix/run-real.mjs:32` | 用法注释里的「CI 尚未接它」改成「CI 的真 PG 臂已接它」（同行改字，行号零位移）。 |
| `.github/workflows/real-pg-integration.yml:1366` | 退出码语义注释里的「0 = 逐条读数取得（**有差异也算 0**）」改成「0 = 逐条读数取得且 `different = 0`（本 step 带 `--require-no-different`，`different > 0` ⇒ 1）」（同行改字，行号零位移）。 |
| `docs/verification/gy-r96-i22-different-gate-20261109.md` | 本页。 |

两处与新行为矛盾的注释一并订正（都只改同行文字，行号零位移，因此不牵动任何文档锚点）：

- `.github/workflows/real-pg-integration.yml:1366` 原写「0 = 逐条读数取得（**有差异也算 0**）」，接上开关后这句对这一步不再成立，已改为「0 = 逐条读数取得且 `different = 0`（本 step 带 `--require-no-different`，`different > 0` ⇒ 1）」。
- `tests/failmatrix/run-real.mjs:32` 原写「CI 尚未接它」，已改为「CI 的真 PG 臂已接它」。

## 4 能证明什么 / 不能证明什么

**能证明**

- `different > 0` 时，`.github/workflows/real-pg-integration.yml:1374` 这一步会红：脚本判据（`tests/failmatrix/require-no-different.mjs:77`）已在，开关现在接在同一行上，非 0 退出码由 `.github/workflows/real-pg-integration.yml:1381` 的既有分支 `exit "$rc"` 升级成 CI 红。
- 有人把开关从那一行删掉时，`tests/unit/failmatrix-require-no-different.test.mjs:281` 会红：本片实测把 workflow 里的 `--require-no-different` 删掉后该用例 exit 1，报错原文点名「只带 not_runnable 时『different 悄悄变多』会静默变绿」；把开关加回去后该用例恢复绿。
- `not_runnable > 0` 仍由原开关判红：`tests/failmatrix/run-real.mjs:1616` 那 5 行（1487–1491）一字未动，两个开关正交。

**不能证明**

- 不证明 180 条用例的语义正确性：`different = 0` 只说明那一天、那一档 PG 上逐条读数与期望一致。
- 不覆盖 PG 16/18，也不含生产环境读数：workflow 装的是 17（`.github/workflows/real-pg-integration.yml:1356` 的 `postgresql-17`），本页的 `17.11` 只是那一次 CI 的读数。
- 不证明 `different > 0` 一定是实现错：也可能是期望写错；开关只把「计数非 0」判红，归因仍靠逐条读数。
- 不主张关闭 #22：本片只补闸门，不替 #22 的其余判据作结论。
- 本页不是本机复跑：`real.json` 来自 CI artifact，本页不拿本机读数替代 CI。
