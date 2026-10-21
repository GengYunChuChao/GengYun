# R28-S44 · `deploy/postgres-cvm` 五脚本 `|| true` 吞失败面逐条裁定（A/B）与 8 处 B 类返修

> 切片：R28-S44；分支 `test/gy-r28-deploy-swallow-audit`；基线 `upstream/main = 32ce461`。
> 交付物：`deploy/postgres-cvm/` 下 5 个脚本的吞失败面改动（只动 `|| true` 相关行，不动安装流程语义）；新增冻结式静态守卫 `tests/unit/deploy-shell-swallow-allowlist.test.mjs`；本页。
> 问题一句话：`install-postgres.sh` / `provision-db.sh` / `verify-cvm-postgres.sh` / `backup-postgres.sh` / `restore-drill.sh` 里 26 处实调用 `|| true` 中，有 8 处把「读失败/查询失败」变成可被当成数据的 `0`、空串或「无条件 PASS」——最严重的是 `verify-cvm-postgres.sh` 的 `no_wildcard_listener` 与 `restore-drill.sh` 的 `restore_toc_entries`：**测不成反而判 PASS**。

**取证范围声明**：本页读数全部来自本机 Windows + Git for Windows bash（`D:\Git\bin\bash.exe`，GNU bash 5.2.37）。五个脚本**本体没有在 CVM / GitHub Actions runner 上执行过**（需要 root、`runuser`、`/usr/lib/postgresql/17`、Unix socket 与 Linux 路径），因此行为级证据用的是：① `bash -n` 语法门；② 把脚本原文的代码块**逐字摘出**放进 harness 的等价构造（§4.5，m3/m4）；③ 冻结式静态守卫（§4）。**未启动任何 PG 集群**：本切片改的都是 shell 判定与报告值，没有一条需要真库才能判定的新行为（`m1`/`m2` 也不需要）。未取得的项逐条列在 §6。

## 0. 结论摘要

| 项 | 改前（`32ce461`） | 改后 |
|---|---|---|
| 实调用 `\|\| true` 站点 | **26**（派单写 24，见 §2.2） | **18**（全部 A 类） |
| A / B / `B-accepted` | 18 / **8** / 0 | 18 / **0** / 0 |
| 能「测不成 ⇒ PASS」的判定点 | 5 处（`verify:208`、`restore:163`、`restore:213`、`restore:280`、`verify:326` 空期望时） | 0 |
| 失败被写进报告值的形态 | `0` / 空串（与真值不可分） | `ss-failed(rc=N)` / `query-failed(rc=N)` / `grep-failed(rc=N)` / 直接 `fail` |
| 守卫 | 无（下次改动可再悄悄加一处） | `tests/unit/deploy-shell-swallow-allowlist.test.mjs`：5 用例、18 条冻结快照 |
| `bash -n` | 5/5 exit 0 | 5/5 exit 0 |

## 1. 范围

### 1.1 做了什么

1. 逐行读出 5 个脚本里所有含 `|| true` 的行（`Select-String` 全量，非只读派单表格），按「是否整行注释」剔除 2 行注释（`provision-db.sh` 头注释、`verify-cvm-postgres.sh` 的返修说明），得到 **26 处实调用点**。
2. 逐处读上下文，判定 A（合法 best-effort：失败只影响展示、或失败方向本身就是安全/更严）或 B（危险：失败会被当成数据或判定结果）。
3. 8 处 B 按「能判 FAIL 就判 FAIL、进报告值的必须显式失败态」最小改动修掉；⛔ 没有任何一处把失败降级成 `0`/空串。
4. 18 处 A 保留 `|| true`，逐处补 `# best-effort: <失败方向>`（同一行尾注释，或紧邻上一行；`install-postgres.sh` 原有 1 处 `|| true` 埋在 `fail "…"` 的多行双引号串内部无法加注释，改为先落变量 `_pwdir_namei` 再加注释）。
5. 新增冻结式静态守卫 + 本页 + 报告 + 日志。

### 1.2 没做什么（边界）

- 未改任何脚本的**安装流程语义**、SQL 文件、迁移、`services/**`、`apps/**`、`packages/**`、`tests/integration/**`、`.github/workflows/**`、`deploy/postgres-cvm/sql/**`。
- 未改判据的键名、阈值、比较方向（`report_eq 'no_wildcard_listener' '0'` 等键名与期望值全部保留）。
- 未起真库、未在 CVM 上跑、未改 CI。
- 未 push、未建 PR（指挥统一收口）。

## 2. 判定口径与全量清单

### 2.1 站点与 A/B 口径

- **站点**：行内含 `|| true`，且该行 `trim` 后不以 `#` 开头。整行注释不算站点（注释不会执行）。
- **A（合法 best-effort）**：失败只影响日志/预览/文案；或失败后紧跟的分支本身会 `fail`/`FAIL`/`skip(exit 2)`；或失败方向是「更保守/更严」（例如枚举旧备份失败 ⇒ 不删任何文件）。
- **B（危险）**：失败被当成数据（`0`、空串）进入判定/报告值；或语句本身是 `report PASS` 且吞掉了产出该值的命令的退出码；或失败导致判据**静默消失**（空循环）。
- 修 B 的最小范式：把命令的退出码显式收进变量（`|| _x_rc=$?`），`rc ≠ 0` 时（a）判定点直接 `FAIL`，或（b）报告值写显式的失败态文本（`xxx-failed(rc=N)`），绝不落 `0`/空串。

### 2.2 与派单的差异（自核结果）

| 项 | 派单 | 自核 | 说明 |
|---|---|---|---|
| 实调用点数 | 24 | **26** | 少算 2：`verify-cvm-postgres.sh:326`、`:327`（`qs … \|\| true`）不在派单表内；两处都在「迁移台账」判定里，正是 B 类 |
| `verify-cvm-postgres.sh:208` | 「只打印」 | **B（假绿）** | `grep -c` 在无输入时**输出 `0`**（rc=1 但被吞）⇒ `no_wildcard_listener` 判 PASS |
| `restore-drill.sh:213/214` | 「213 只进文案、214 参与判定」 | **说反了** | 判定用的是 `-z "$errors"`（213）；`error_count`（214）只进 FAIL 文案与说明 |
| 行数 | 545/310/338/183/244 | 675/404/423/258/316 | 派单是旧行数；但派单引用的**行号与当前文件一致**，已逐条核对 |

### 2.3 全量 26 行清单（行号为改前；「处置后」给出改后站点行）

| # | 文件:行 | 类 | 原文要点 | 失败时会发生什么 | 处置后 |
|---|---|---|---|---|---|
| 1 | `install-postgres.sh:234` | A | `OWNER_PASSWORD="$(read_secret_from_file … \|\| true)"` | 读不到即空；下面 `[[ -z ]]` 分支：集群已存在则 warn 跳过 initdb，否则 `fail` | `:235` |
| 2 | `install-postgres.sh:289` | A | `_pgdata_preview="$(find … \| head -n 5 \|\| true)"` | 只用于「数据目录非空」预览打印 | `:291` |
| 3 | `install-postgres.sh:331` | A | `[[ "$(cat -- "$PGDG_LIST" … \|\| true)" != "$EXPECTED_LIST" ]]` | 读失败视为**内容不符** ⇒ 重写为目标内容（收敛方向） | `:334` |
| 4 | `install-postgres.sh:357` | A | `apt-cache madison … \| head -1 \|\| true` | 探测空 ⇒ 后面按「找不到 17.11 包」硬失败，不会改装别的 minor | `:360` |
| 5 | `install-postgres.sh:425` | A | `pg_lsclusters -h \| awk … \|\| true` | 空 ⇒ 跳过「早期端口占用」检查；端口真被占时 `postgres` bind 失败 ⇒ 30 秒未就绪硬失败，数据零破坏 | `:429` |
| 6 | `install-postgres.sh:449` | A | `bash -c 'systemctl disable --now postgresql.service … \|\| true'` | apt 包可能没装出同名单元；停用失败不中断安装（下一步按 17.11 集群显式启动） | `:453` |
| 7 | `install-postgres.sh:482` | A | `$(namei -l "$_pwdir" … \| sed … \|\| true)`（在 `fail` 的多行双引号串内部） | 只拼进失败文案；拿不到就打印不了目录权限链 | `:485`（改为 `_pwdir_namei` 变量 + `${_pwdir_namei:-（namei 不可用…）}`） |
| 8 | `install-postgres.sh:604` | A | `listen_dump="$(ss -ltnH … \|\| true)"` | 空 ⇒ 下一行 `fail`「未看到端口监听记录」 | `:611` |
| 9 | `install-postgres.sh:637` | A | `_final_ver="$(cat -- …/PG_VERSION \|\| true)"` | 空 ⇒ `[[ == 17 ]]` 不成立 ⇒ `fail` | `:645` |
| 10 | `install-postgres.sh:645` | A | `_final_ping="$(runuser … -tAc 'SELECT 1' \|\| true)"` | 不等于 `1` ⇒ `fail` | `:653` |
| 11 | `provision-db.sh:117` | A | `RUNTIME_PASSWORD="$(read_secret_from_file … \|\| true)"` | 空 ⇒ 下一行 `[[ -n ]] \|\| fail` | `:118` |
| 12 | `verify-cvm-postgres.sh:116` | A | `as_runtime`: `… 2>&1 \|\| true` | 保留 psql 的 stderr 供调用方判定：`report_denied` 只有见 `42501` 才 PASS、`report_num_runtime` 只有末行是非负整数才 PASS ⇒ 失败文本一律 FAIL | `:116` |
| 13 | `verify-cvm-postgres.sh:186` | A | VPC IP 探测 `\| sort -u \| head -1 \|\| true` | 空 ⇒ `skip`（退出码 2），且 `listen_addresses` 的期望值变 `127.0.0.1,?` ⇒ 不可能 PASS | `:186` |
| 14 | `verify-cvm-postgres.sh:208` | **B** | `wild_count="$(ss … \| awk … \| grep -cE '^(0.0.0.0\|*\|\[::\]):' \|\| true)"` | `ss`/`awk` 失败 ⇒ `grep -c` 输出 **`0`** ⇒ `report_eq 'no_wildcard_listener' '0'` **PASS（假绿）** | 已修（§3.1） |
| 15 | `verify-cvm-postgres.sh:308` | A | `… -c 'SELECT current_user' 2>&1 \| tr -d '\r' \| tail -n1 \|\| true` | 与角色名精确比较；失败文本/空 ⇒ 不相等 ⇒ FAIL | `:318` |
| 16 | `verify-cvm-postgres.sh:326` | **B** | `applied_joined="$(qs "SELECT COALESCE(string_agg(…), '') FROM schema_migrations" \|\| true)"` | 失败落空串/错误文本直接成为报告里的「实际值」；期望值在「磁盘侧也读不到」时也是空串 ⇒ **两者相等 ⇒ PASS（假绿）** | 已修（§3.2） |
| 17 | `verify-cvm-postgres.sh:327` | **B** | `checksum_nulls="$(qs 'SELECT count(*) … WHERE checksum IS NULL' \|\| true)"` | 失败落空串 ⇒ 实际值没有失败态，与「0 个 NULL」不可分 | 已修（§3.2） |
| 18 | `verify-cvm-postgres.sh:352` | A | `newest_dump="$(find … \| sort -nr \| …)" \|\| true` | 空 ⇒ `backup_artifact` 记 `skip`（退出码 2），既不当「有备份」也不当 PASS | `:368` |
| 19 | `verify-cvm-postgres.sh:378` | A | `read -r DATA_SRC DATA_MNT <<<"$(df -P … \|\| true)"` | 空 ⇒ `_fail pgdata_separate_filesystem` | `:395` |
| 20 | `backup-postgres.sh:201` | **B** | `TOCOBJ="$(runuser … --list "$DUMP" \| grep -c ';' \|\| true)"` | 失败 ⇒ `0` **写进备份清单** `restore_toc_entries`，与「真的 0 个 TOC 条目」不可分；下游 `restore-drill.sh` 还拿它当判据 | 已修（§3.3） |
| 21 | `backup-postgres.sh:237` | A | `old="$(list_old_backups \|\| true)"` | 枚举失败 ⇒ 视为无旧备份 ⇒ **不删任何文件**（安全方向）；代价是保留期清理静默未执行（已知残留，§6） | `:245` |
| 22 | `restore-drill.sh:163` | **B** | `report PASS 'restore_toc_entries' "$(manifest_get …)" "$(runuser … --list "$DUMP" \| grep -c ';' \|\| true)"` | `--list` 失败 ⇒ 产出 `0` 但**无条件记 PASS**（语句本身就是 PASS） | 已修（§3.4） |
| 23 | `restore-drill.sh:212` | A | `notices="$(grep -cE '…(WARNING\|NOTICE):' … \|\| true)"` | 只进 PASS 文案的「非致命行数」 | `:225` |
| 24 | `restore-drill.sh:213` | **B** | `errors="$(grep -nE '^(pg_restore: error:\|ERROR:)' … \| head -5 \|\| true)"` | 判定是 `[[ "$restore_rc" -eq 0 && -z "$errors" ]]` ⇒ 日志读不到 ⇒ `errors` 空 ⇒ **判「没有 ERROR」⇒ PASS（假绿）** | 已修（§3.5） |
| 25 | `restore-drill.sh:214` | **B** | `error_count="$(grep -cE … \|\| true)"` | 只进 FAIL 文案/说明；失败显示 `0`（把「没读到」写成「0 条」） | 已修（§3.5） |
| 26 | `restore-drill.sh:280` | **B** | `done < <(grep '^rows:' -- "$MANIFEST" \|\| true)` | `grep` 失败 ⇒ **空循环** ⇒ 逐表行数判据一条都不判，整体仍可能 PASS | 已修（§3.6） |

> 剔除的 2 行整行注释：`provision-db.sh:366`（改后 `:367`，说明旧 `|| true` 会吞退出码的历史注释）、`verify-cvm-postgres.sh:262`（改后 `:272`，R28-S33 的返修说明）。

## 3. 8 处 B 类：改前 → 改后

### 3.1 `verify-cvm-postgres.sh:208`——`ss` 测不成反而判「没有通配监听」

改前（`32ce461`）：

```bash
wild_count="$(ss -ltnH "sport = :${PGPORT}" 2>/dev/null | awk '{print $4}' | grep -cE '^(0\.0\.0\.0|\*|\[::\]):' || true)"
report_eq 'no_wildcard_listener' '0' "$wild_count"
```

`ss` 不存在/权限不足/管道任一段失败时，`grep -c` 收到空输入仍**打印 `0`**，`report_eq '0' '0'` 判 PASS——「没测成」被记成「没有通配监听」。

改后（`verify-cvm-postgres.sh:211-219`）：

```bash
wild_count=''
_listen_rc=0
_listen_raw="$(ss -ltnH "sport = :${PGPORT}" 2>/dev/null)" || _listen_rc=$?
if [[ "$_listen_rc" -eq 0 ]]; then
  wild_count="$(printf '%s\n' "$_listen_raw" | awk '$4 ~ /^(0\.0\.0\.0|\*|\[::\]):/ {n++} END {print n+0}')"
else
  wild_count="ss-failed(rc=${_listen_rc})"
fi
report_eq 'no_wildcard_listener' '0' "$wild_count"
```

退出码与计数分离；`awk` 计数在「0 条匹配」时没有 `grep -c` 的 rc=1 歧义。失败时实际值是 `ss-failed(rc=N)`，`report_eq` 判 FAIL。键名与期望值不变。

### 3.2 `verify-cvm-postgres.sh:326/327`——迁移台账查询失败落成空串

改前：

```bash
applied_joined="$(qs "SELECT COALESCE(string_agg(version, ',' ORDER BY version), '') FROM schema_migrations" || true)"
checksum_nulls="$(qs 'SELECT count(*) FROM schema_migrations WHERE checksum IS NULL' || true)"
```

改后（`:338-343`）：

```bash
_applied_rc=0
applied_joined="$(qs "SELECT COALESCE(string_agg(version, ',' ORDER BY version), '') FROM schema_migrations")" || _applied_rc=$?
[[ "$_applied_rc" -eq 0 ]] || applied_joined="query-failed(rc=${_applied_rc})"
_nulls_rc=0
checksum_nulls="$(qs 'SELECT count(*) FROM schema_migrations WHERE checksum IS NULL')" || _nulls_rc=$?
[[ "$_nulls_rc" -eq 0 ]] || checksum_nulls="query-failed(rc=${_nulls_rc})"
```

`report_eq 'migrations_applied' "$disk_joined" "$applied_joined"` 保留：期望值（磁盘侧迁移文件列表）为空、查询又失败时，改前两者都是空串 ⇒ 假绿；改后实际值是 `query-failed(rc=N)` ⇒ FAIL，且报告里直接看得出是查询失败而不是「0 个已应用迁移」。

### 3.3 `backup-postgres.sh:201`——读不出 TOC 却写 `restore_toc_entries=0` 进清单

改前：

```bash
if ! runuser -u postgres -- "${PG_BIN}/pg_restore" --list "$DUMP" >/dev/null 2>&1; then
  fail "…备份文件不可用…"
fi
TOCOBJ="$(runuser -u postgres -- "${PG_BIN}/pg_restore" --list "$DUMP" | grep -c ';' || true)"
```

改后（`:197-206`）：

```bash
_toc_rc=0
_toc_list="$(runuser -u postgres -- "${PG_BIN}/pg_restore" --list "$DUMP" 2>/dev/null)" || _toc_rc=$?
if [[ "$_toc_rc" -ne 0 ]]; then
  fail "pg_restore --list 无法读取 ${DUMP}（rc=${_toc_rc}）：备份文件不可用，请勿据此声称已备份。"
fi
TOCOBJ="$(printf '%s\n' "$_toc_list" | awk '/;/{n++} END{print n+0}')"
```

两次 `--list` 合并为**一次**：退出码与计数同源，不再有「第一次成功、第二次失败 ⇒ 清单里 0 条」的假数据窗口；`awk` 计数避开 `grep -c` 的 rc=1 歧义。

### 3.4 `restore-drill.sh:163`——`report PASS` 的参数里直接吞掉 `--list` 失败

改前：

```bash
report PASS 'restore_toc_entries' "$(manifest_get 'restore_toc_entries')" "$(runuser -u postgres -- "${PG_BIN}/pg_restore" --list "$DUMP" | grep -c ';' || true)"
```

`report PASS` 是硬编码的：无论 `--list` 成功与否都记 PASS，实际值还可能是 `0`。

改后（`:163-172`）：

```bash
_toc_rc=0
_toc_count="$(runuser -u postgres -- "${PG_BIN}/pg_restore" --list "$DUMP" | grep -c ';')" || _toc_rc=$?
if [[ "$_toc_rc" -eq 0 ]]; then
  report PASS 'restore_toc_entries' "$(manifest_get 'restore_toc_entries')" "$_toc_count"
else
  report FAIL 'restore_toc_entries' "$(manifest_get 'restore_toc_entries')" \
    "pg_restore --list 失败或列不出条目（rc=${_toc_rc}，dump ${DUMP}）"
fi
```

### 3.5 `restore-drill.sh:212-214`——「读不到恢复日志」被读成「没有 ERROR 行」

改前：

```bash
notices="$(grep -cE '^(pg_restore: )?(WARNING|NOTICE):' "$RESTORE_LOG" 2>/dev/null || true)"
errors="$(grep -nE '^(pg_restore: error:|ERROR:)' "$RESTORE_LOG" 2>/dev/null | head -5 || true)"
error_count="$(grep -cE '^(pg_restore: error:|ERROR:)' "$RESTORE_LOG" 2>/dev/null || true)"
…
if [[ "$restore_rc" -eq 0 && -z "$errors" ]]; then report PASS …
```

改后（`:221-256`，节选判定段）：

```bash
# best-effort: notices 只用于 PASS 文案里的「非致命 WARNING/NOTICE 行数」；grep 失败即空，显示为 0 行，不改判定。
notices="$(grep -cE '^(pg_restore: )?(WARNING|NOTICE):' "$RESTORE_LOG" 2>/dev/null || true)"
# 用 `awk 'NR<=5'` 取代 `head -5`：head 提前退出会让 grep 收到 SIGPIPE(141)，pipefail 下会被误判成读取失败。
_grep_errors_rc=0
errors="$(grep -nE '^(pg_restore: error:|ERROR:)' "$RESTORE_LOG" 2>/dev/null | awk 'NR<=5')" || _grep_errors_rc=$?
_grep_count_rc=0
error_count="$(grep -cE '^(pg_restore: error:|ERROR:)' "$RESTORE_LOG" 2>/dev/null)" || _grep_count_rc=$?
[[ "$_grep_count_rc" -le 1 ]] || error_count="grep-failed(rc=${_grep_count_rc})"

if [[ "$restore_rc" -eq 0 && "$_grep_errors_rc" -le 1 && -z "$errors" ]]; then
  … report PASS …
else
  … report FAIL …
  if [[ "$_grep_errors_rc" -gt 1 ]]; then
    printf '[%s] 无法读取恢复日志（grep rc=%s）⇒ 不能断言「没有 ERROR 行」，按失败处理：%s\n' …
```

`grep -c` 在「0 匹配」时 rc=1 属正常，故判据用 `-le 1`；rc>1（读失败）⇒ 判定进 FAIL 分支并打印明确原因。`notices` 保留吞失败（A 类）——它只进 PASS 文案。

### 3.6 `restore-drill.sh:280`——`grep` 失败 ⇒ 空循环 ⇒ 逐表行数判据静默消失

改前：

```bash
while IFS= read -r line; do … done < <(grep '^rows:' -- "$MANIFEST" || true)
```

改后（`:289-312`）：

```bash
_rows_rc=0
_rows_lines="$(grep '^rows:' -- "$MANIFEST")" || _rows_rc=$?
if [[ "$_rows_rc" -ne 0 ]]; then
  report FAIL 'manifest_rows_readable' '至少一行 rows:<表>=<行数>' \
    "grep '^rows:' 失败或未匹配（rc=${_rows_rc}，清单 ${MANIFEST}）"
fi
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  …
done <<<"$_rows_lines"
```

进程替换改成 here-string（顺带避免 subshell 里的 `report` 计数丢失），并新增一条 FAIL 判据：读不到 `rows:` 行本身就是失败，不再让整段判据静默消失。

## 4. 冻结式静态守卫与负控制

### 4.1 守卫做什么

新增 `tests/unit/deploy-shell-swallow-allowlist.test.mjs`（`node:test` + `node:assert/strict`，零新依赖）：

1. 扫 5 个脚本里每一处「含 `|| true` 且 trim 后不以 `#` 开头」的站点，与内置快照（18 条 `{file, lineText, category:'A', reason}`）逐条比对：**未登记 ⇒ 红**（逐条点名 `file:line` + 原文）；**登记项消失 ⇒ 红**；同文件内 `lineText` 重复 ⇒ 红（快照靠文本定位，重复会失去定位能力）。
2. **A 类必须在同一行或紧邻上一行有 `# best-effort`**，否则红；`B`/`B-accepted` 必须在 `reason` 里写清理由（`B-accepted` 的理由还要含「危险／吞／判定／报告值」之一）。
3. 快照规模断言：`SNAPSHOT.length === 18` 且分类计数为 `{A:18, 'B-accepted':0}`——修完不该再有 B；若将来确需保留，登记 `B-accepted` 并写理由，规模断言也会同步变红提醒改数。

文件头写明守卫的定位：**锁的不是「允许吞失败」，而是「每一处都被人工裁定过」**。

### 4.2 读数

`node --test --test-concurrency=1 tests/unit/deploy-shell-swallow-allowlist.test.mjs` ⇒ `tests 5 / pass 5 / fail 0`，exit 0。

### 4.3 负控制

| 编号 | 注入 | 期望 | 实测 | 复原 |
|---|---|---|---|---|
| m1 | 在 `backup-postgres.sh` 末尾加一行 `echo x \|\| true` | 守卫红并点名该行 | **exit 1**：`发现未登记的 \|\| true（1 处）`，点名 `deploy/postgres-cvm/backup-postgres.sh:268  echo x \|\| true` | 删该行，sha256 复原为 `b5c6637e…62080` |
| m2 | 删掉 `install-postgres.sh:290` 的 `# best-effort:` 注释（`_pgdata_preview` 站点） | 守卫红并点名该站点 | **exit 1**：`这些 A 类吞失败缺少 # best-effort: <失败方向> 注释（同一行或紧邻上一行）`，点名 `deploy/postgres-cvm/install-postgres.sh:290  _pgdata_preview=…` | 插回，sha256 复原为 `09b7a493…65018` |
| m3 | `RESTORE_LOG` 指向不存在路径 + `restore_rc=0`，跑「恢复输出判读」代码块 | 改前假绿 PASS / 改后 FAIL | 改前 `REPORT PASS pg_restore --exit-on-error expected=<0> actual=<0（非致命 WARNING/NOTICE 0 行…）>`；改后 `REPORT FAIL … actual=<exit=0，致命 error 行=grep-failed(rc=2)…>` + stderr `无法读取恢复日志（grep rc=2）⇒ 不能断言「没有 ERROR 行」，按失败处理` | 仅跑 harness，未改仓库文件 |
| m4 | `qs` 静默失败（rc=1、无输出）+ `disk_joined=''`，跑「迁移台账取值」代码块 | 改前空串假绿 / 改后显式失败态 | 改前 `REPORT PASS migrations_applied expected=<> actual=<>`；改后 `REPORT FAIL migrations_applied expected=<> actual=<query-failed(rc=1)>`（`checksum_nulls` 同步为 `query-failed(rc=1)`） | 同上 |

m3/m4 用的是**逐字摘录同一代码块**的等价构造（`E:\GengYunCommander\.pg17\handoff\r28-s44-logs\negctl-m3-restore-errors.sh`、`negctl-m4-migrations-value.sh`，`bash -n` 各 exit 0）：真脚本需要 root/`runuser`/Unix socket，本机无法执行；等价构造只替换了「日志路径」「`qs` 桩」两个外部输入，判读代码本身逐字照抄。m1/m2 复原后守卫复跑 `tests 5 / pass 5 / fail 0`，`git status` 无残留。

## 5. 门禁读数

| # | 命令 | 读数 | exit |
|---|---|---|---|
| 1 | `npm run lint` | PASS tsc `services/api` + `apps/admin` + 仓库卫生扫描 | 0 |
| 2 | `node tools/verify-release-materials.mjs` | `15/15 项通过` | 0 |
| 3 | `npm run test:docs` | 开发文档校验 + 研究记录校验均通过（含本页） | 0 |
| 4 | `node tools/verify-contract-status.mjs` | 覆盖 112 条、已装配 108、implemented 13 / partial 95 / planned 4、形状错误 0、语义错误 0 | 0 |
| 5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | `tests 6 / pass 6 / fail 0` | 0 |
| 6 | 单元守卫组合（见 §6「未取得」） | `tests 8 / pass 8 / fail 0` | 0 |
| 7 | `D:\Git\bin\bash.exe -n <5 个脚本>` | 5/5 无语法错误 | 0 |
| 8 | `git diff --check`（工作树 + `32ce461..HEAD` + `upstream/main..HEAD`） | 无空白错误（三口径均 exit 0） | 0 |

日志：`E:\GengYunCommander\.pg17\handoff\r28-s44-logs\03-gate-*.log`、`06-negctl-*.log`。

**基线 ref 漂移（如实记录）**：本切片开工时 `upstream/main` = `32ce461`；收尾时该 ref 已前进到 `c0217a4`（多出 5 个他人提交：`c010745`、`b8e8526`、`4e93d7b`、`e01dd67` 等）。HEAD 的父提交与 `merge-base(HEAD, upstream/main)` 都仍是 `32ce461`，本切片的提交只改了 7 个文件（§5 表上方 `git show --stat` 可核）。因此 `git diff --check upstream/main..HEAD` 会把那 5 个提交的**反向 diff**也算进范围——判本片自身有无空白错误，以 `git diff --check 32ce461..HEAD` 为准（exit 0）。

## 6. 未取得与已知残留

1. **五个脚本本体未在 Linux/CVM 执行**：需要 root、`runuser`、`/usr/lib/postgresql/17`、Unix socket；本机只有 Git bash。因此没有「改后脚本在真机上跑通」的读数，只有 `bash -n`（语法）+ 等价构造（判读逻辑）+ 静态守卫（站点冻结）。
2. **门禁 6 的第三份测试不存在**：派单写 `tests/unit/deploy-sql-gate-recovery.test.mjs`，本基线 `upstream/main = 32ce461` 只有 `tests/unit/deploy-verify-assert-rc.test.mjs`（无该文件）。已跑「存在的两份」共 8 用例并全绿；缺的那份作为未取得上报，未凭空创建。
3. **派单 24 处 vs 实际 26 处**：见 §2.2；本页按 26 处全量裁定。
4. **`backup-postgres.sh:245` 的已知残留**：保留期清理枚举失败时静默不删（安全方向），但「这次没清理」不会进任何 PASS/FAIL 或报告值；已在注释里写明。若要进一步收紧，可把它变成一条 warn 级说明行。
5. **未起 PG 集群**：本切片无需真库；`pg_ctl` 未启动、无需停止（报告里如实写「未启动」）。
6. **未 push / 未建 PR**：按派单要求，本地 commit 后由指挥收口。
