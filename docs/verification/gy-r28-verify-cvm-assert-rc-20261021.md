# R28-S37 · verify-cvm-postgres.sh 判红口径对齐（捕 psql 退出码 + 末行双判）

> 切片：R28-S37；分支 `fix/gy-r28-verify-cvm-assert-rc`；基线 `693af5d`（`upstream/main`，含 #346 deploy SQL 链闸门；`git fetch` 后无需 rebase）。
> 交付物：`deploy/postgres-cvm/verify-cvm-postgres.sh` 第 5 节「最小权限断言」段（另含 7 行注释）；`tests/unit/deploy-verify-assert-rc.test.mjs`（静态守卫，新增）；本页。
> 问题一句话：#345（`docs/verification/gy-r28-assert-verdict-hard-fail-20261021.md`）已让 `sql/90-assert-least-privilege.sql` 判红时 `RAISE EXCEPTION`（psql 以 **3** 退出，stderr 的 `ERROR:` / `CONTEXT:` 经 `2>&1` 排在 `FAIL:` 判决文本之后）；但 `verify-cvm-postgres.sh` 仍用 `|| true` 吞退出码、只比末行 ⇒ 判红被误读成两种样子：①末行成了 `CONTEXT:` 行，报告里的「实际值」不可读；②退出码非 0 而末行恰为 `ok` 时报告键 `least_privilege_assert` 判 **PASS**（假绿）。

**取证范围声明**：`verify-cvm-postgres.sh` **本体没有在本机执行过**——它是 Linux/root 专用脚本（`runuser -u postgres`、Unix socket、`postgres` 系统用户、`ss`/`find -printf`、`PGDATA=/var/lib/postgresql/…`），本机是 **Windows**，没有 `runuser`、没有 Unix socket、没有 `postgres` 系统用户。本页的四类证据是：**逻辑级复现**（§5：从脚本原文逐字抽取改前/改后两段代码块，用桩 `runuser` 灌入真实 psql 输出与退出码）、**真实 psql 17.11 的输出形状实测**（§3.1）、**静态守卫单测**（§6）、**门禁读数**（§9）。⛔ 本页不得读作「verify 脚本已在 CVM 上端到端验证」；未取得项逐条列在 §8。

## 0. 结论摘要

| 项 | 改前（`693af5d`，L259-267） | 改后（L266-284） |
|---|---|---|
| psql 退出码 | 被 `\|\| true` 丢弃 | 收进 `assert_rc`（`\|\| assert_rc=$?`） |
| 判定条件 | 仅「末行 `!= ok`」 | 「退出码 `≠ 0`」**或**「末行 `!= ok`」 |
| 判红时报告里的「实际值」 | 末行 = `CONTEXT:  PL/pgSQL function …`（判决文本被挤走） | `psql-exit=3（末行=CONTEXT:  …）` |
| 判红时 stderr | 只有 `$assert_out` 全文（缩进 9 空格） | 全文 + 一行 `最小权限断言的完整输出（psql exit=3）：` 抬头 + 一行判红原因 |
| **退出码 3 且末行 `ok`** | **PASS（假绿）** | **FAIL**（原因①，实测见 §5.3 用例 C） |
| 退出码 3 且末行 `CONTEXT:` | FAIL，但实际值不可读 | FAIL，原因① + 实际值可读 |
| 退出码 0 且末行 `ok` | PASS（无任何诊断输出） | PASS（无任何诊断输出，**行为未变**） |
| 失败时仍打印完整输出 | 是 | 是（`$assert_out` 全文照旧，一行不少） |
| 报告键 | `least_privilege_assert` | **不变**（`report_eq 'least_privilege_assert' 'ok' "$verdict"` 逐字未动） |
| 断言强度 | — | 未削弱：只加判据，未删任何检查、未改阈值、未改 90-assert |

## 1. 范围

### 1.1 做了什么

1. `deploy/postgres-cvm/verify-cvm-postgres.sh` 第 5 节：删掉 psql 调用上的 `|| true`，把退出码收进 `assert_rc`；失败条件改为「`assert_rc -ne 0` **或** 末行 `!= 'ok'`」；失败时先打一行带 `psql exit=` 的抬头、再打 `$assert_out` 全文、最后打判红原因（`①` 退出码 / `②` 末行）；退出码非 0 时把报告里的「实际值」改写成 `psql-exit=N（末行=…）`，避免末行恰为 `ok` 时 `report_eq` 放行。另加 7 行注释说明为什么双判。
2. `tests/unit/deploy-verify-assert-rc.test.mjs`：静态守卫（只读脚本文本，不执行脚本），三条断言。**负控制**见 §6。
3. 本页 + 逻辑级复现 harness（`.pg17\tmp\r28-s37\`，**不提交**）。

### 1.2 没做什么（边界）

- 没有改 `deploy/postgres-cvm/provision-db.sh`（#345 已把它改成同一形状，:370-382，本片只做对齐）。
- 没有改 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql`（判红机制、78 条断言、判决行文案、`RAISE EXCEPTION` 全部未动）。
- 没有改 `.github/**`、`services/**`、`apps/**`、`packages/**`、`deploy/postgres-cvm/` 下其它文件。
- 没有改报告键名、没有减少报告项、没有把判红降级为 `skip`、没有引入新的「可配置跳过」。
- 没有改本页之外的历史证据页（S33 页 §1.2 明确记过「没有改 `verify-cvm-postgres.sh`」，本片把它闭环，**历史页不改**）。
- 没有 push、没有建 PR、没有发评论。

## 2. 环境与取证方式

| 项 | 值 |
|---|---|
| 平台 | Windows；PowerShell 5.1.26100.8875；bash 用 `D:\Git\bin\bash.exe`（Git for Windows 的 MSYS bash） |
| psql / postgres | `E:\GengYunCommander\.pg17\pgsql\bin`；`psql (PostgreSQL) 17.11`、`postgres (PostgreSQL) 17.11` |
| 一次性集群 | `initdb -D E:\GengYunCommander\.pg17\tmp\r28-s37\pgdata -U postgres -E UTF8 --locale=C --auth=trust`（exit 0）；`pg_ctl … -o "-p 55661 -c listen_addresses=127.0.0.1" start -w`；日志首行 `starting PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit` |
| 集群用途 | **只**用来取「psql 在判红/全绿时的真实输出形状与退出码」，不是 CVM 部署、不是 `verify-cvm-postgres.sh` 的执行环境 |
| 探针 | `.pg17\tmp\r28-s37\pg-raise.sql`（先 `SELECT` 一行 `FAIL: …`，再 `DO $$ … RAISE EXCEPTION '90-assert-least-privilege FAIL: % 条断言未通过：%' $$`——形状照 90-assert 的末尾裁决块）；`pg-ok.sql`（`SELECT 'ok'`）；`pg-big-raise.sql`（200 行 `detail_line_…` 后再 RAISE，模拟 90-assert 的大体量 stdout） |
| 逻辑级复现 | `.pg17\tmp\r28-s37\repro.sh`（bash；桩 `runuser()`、桩 `report_eq()`），输出存 `repro-output.txt`（144 行，全文见 §5.3） |
| 已知差异 | Windows 的 `psql.exe` 把行尾写成 **CRLF**（实测 `ok.out` = `6f 6b 0d 0a`）；脚本里的 `tr -d '\r'` 正好消掉它，所以本页复现里 CRLF 不构成噪声。真实 CVM 是 LF。 |

## 3. 缺陷机制

### 3.1 #345 之后判红的真实输出形状（本机 psql 17.11 实测）

`90-assert-least-privilege.sql` 自 #345 起，判决行（`ok` / `FAIL: …`）**之后**还有一段 `DO $$ … RAISE EXCEPTION '90-assert-least-privilege FAIL: % 条断言未通过：%' … $$`。于是判红时 psql 以 **3** 退出，且 `ERROR:` / `CONTEXT:` 一定排在判决行之后：

| 调用 | 落盘文件 | 内容 | 退出码 |
|---|---|---|---|
| `psql … -f pg-raise.sql`（stdout 单落） | `raise.out` | 1 行 `FAIL: knowledge_runtime_scope (模拟：运行时多读了一张知识域之外的表)` | 3 |
| 同上（stderr 单落） | `raise.err` | 2 行：`psql:pg-raise.sql:14: ERROR:  90-assert-least-privilege FAIL: 1 条断言未通过：knowledge_runtime_scope`、`CONTEXT:  PL/pgSQL function inline_code_block line 3 at RAISE` | — |
| 脚本同形：`… 2>&1 \| tr -d '\r'` | `raise.piped` | **3 行，顺序 FAIL → ERROR → CONTEXT（末行 = `CONTEXT:`）** | 3 |
| 同上，但 stdout 先吐 200 行再 RAISE | `big.piped` | 202 行；`ERROR` 在 201 行、`CONTEXT` 在 202 行（**大体量 stdout 也不改末行归属**） | 3 |
| `psql … -f pg-ok.sql` | `ok.out` | 字节 `6f 6b 0d 0a`（`ok` + CRLF） | 0 |

原始字节（`od -c` 的末几个字节）：`raise.merged` 收尾是 `… o c k   l i n e   3   a t   R A I S E \r \n`，`ok.out` 是 `o k \r \n`。

**结论**：判红时末行**恒为 `CONTEXT:` 行**（RAISE 的 stderr 总在判决行之后写），全绿时末行是 `ok`。这正是改前代码「只比末行」失效的物理原因。

### 3.2 改前代码（`693af5d:259-267`）的两个盲区

```bash
assert_out="$(runuser -u postgres -- "${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 \
  -h "$PGHOST_SOCKET" -U "$DB_OWNER" -d "$DB_NAME" -tA \
  -f "$staged_assert_sql" 2>&1 | tr -d '\r' || true)"
verdict="$(printf '%s\n' "$assert_out" | sed '/^[[:space:]]*$/d' | tail -n1)"
if [[ "$verdict" != 'ok' ]]; then
  # 保留完整输出：缺前置时 90-assert 会打印三步补救指引，不能只留最后一行。
  printf '%s\n' "$assert_out" | sed 's/^/         /' >&2
fi
report_eq 'least_privilege_assert' 'ok' "$verdict"
```

- **盲区①（可读性）**：`verdict` 取的是末行 ⇒ 判红时 `verdict` = `CONTEXT:  PL/pgSQL function inline_code_block line 3 at RAISE`。报告里的「实际值」就变成这一行，真正的判决文本（`FAIL: <label> (<detail>)`，也就是人要知道的原因）只剩上面那段 9 空格缩进的诊断。S33 之前不是问题（那时末行就是 `FAIL:` 行）；#345 之后才变成问题。
- **盲区②（判绿）**：`|| true` 让 psql 的退出码**根本没有进入代码**。只要合并流末行是 `ok`，`verdict == 'ok'` ⇒ `report_eq 'least_privilege_assert' 'ok' 'ok'` ⇒ **PASS**，即便 psql 以 3 退出。§5.3 用例 C 就是这个输入的实测。
- **共同根因**：退出码没进判据。同一缺陷 #345 已在 `provision-db.sh` 修过（`:370-382`），但当时明确没动本脚本（S33 页 §1.2 原话：「没有改 `deploy/postgres-cvm/verify-cvm-postgres.sh`」），本片把它闭环。

## 4. 改法

### 4.1 改前（`693af5d:259-267`，完整段）

见 §3.2 的代码块（同一份原文）。

### 4.2 改后（工作树 L259-284）

```bash
# R28-S37：psql 退出码与末行**双判**（形状照 provision-db.sh 的第 5 步）。
# 90-assert 判红时会在文件末尾 RAISE EXCEPTION（psql 以 3 退出），其 stderr 的
# `ERROR:` / `CONTEXT:` 行经 `2>&1` 会排在 `FAIL:` 判决文本之后 ⇒ 末行不再是判决文本。
# 「只看末行 + `|| true` 吞退出码」于是有两个盲区：① 末行成了 CONTEXT 行，报告里的
# 「实际值」不可读；② 末行恰好是 `ok` 而 psql 非零退出（DO 块因与断言无关的原因失败、
# 或 stdout 缓冲让判决行最后才刷出）时，非零退出被彻底吞掉 ⇒ 判成 PASS。
# 退出码是主判据，末行文本只作可读兜底（人工 `psql -f`、或将来改回纯文本判决时仍能拦住）。
assert_rc=0
assert_out="$(runuser -u postgres -- "${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 \
  -h "$PGHOST_SOCKET" -U "$DB_OWNER" -d "$DB_NAME" -tA \
  -f "$staged_assert_sql" 2>&1 | tr -d '\r')" || assert_rc=$?
verdict="$(printf '%s\n' "$assert_out" | sed '/^[[:space:]]*$/d' | tail -n1)"
if [[ "$assert_rc" -ne 0 || "$verdict" != 'ok' ]]; then
  # 保留完整输出：缺前置时 90-assert 会打印三步补救指引，不能只留最后一行。
  printf '[%s] 最小权限断言的完整输出（psql exit=%s）：\n' "$SCRIPT_NAME" "$assert_rc" >&2
  printf '%s\n' "$assert_out" | sed 's/^/         /' >&2
  if [[ "$assert_rc" -ne 0 ]]; then
    printf '[%s] 判红原因①：psql 退出码 %s ≠ 0（90-assert 判决非 ok 时 RAISE EXCEPTION；stderr 的 ERROR:/CONTEXT: 排在 FAIL 文本之后）。\n' \
      "$SCRIPT_NAME" "$assert_rc" >&2
  else
    printf '[%s] 判红原因②：末行不是 ok（实际：%s）。\n' "$SCRIPT_NAME" "${verdict:-（空）}" >&2
  fi
  # 退出码非 0 时改写报告里的「实际值」：否则末行恰好是 ok 会让 report_eq 判成 PASS。
  [[ "$assert_rc" -eq 0 ]] || verdict="psql-exit=${assert_rc}（末行=${verdict:-空}）"
fi
report_eq 'least_privilege_assert' 'ok' "$verdict"
```

三处要点：

1. **`|| true` 删掉，换成 `|| assert_rc=$?`**：`set -euo pipefail` 下必须这样写才不会因非零退出中止脚本（`assert_rc=0` 先初始化，`set -u` 才安全）。注意 `assert_rc` 捕的是**整条管道**的退出状态（`pipefail` 生效时即 psql 的状态；`tr` 正常时不影响）。
2. **`if [[ "$assert_rc" -ne 0 || "$verdict" != 'ok' ]]`**：退出码为主判据，末行文本作可读兜底。
3. **`[[ "$assert_rc" -eq 0 ]] || verdict="psql-exit=…"`**：这是「不让假绿发生」的关键一行。只加 `||` 到 `if` 还不够——`report_eq` 比较的是 `verdict` 字面值，退出码 3 + 末行 `ok` 时 `verdict` 仍是 `ok`，报告行照样 PASS。

### 4.3 与 `provision-db.sh:370-382` 的形状对齐

| 形状要素 | `provision-db.sh`（#345 已改） | `verify-cvm-postgres.sh`（本片，改后） |
|---|---|---|
| 初始化 | `assert_rc=0` | 同 |
| 捕退出码 | `assert_out="$(…)" \|\| assert_rc=$?` | 同 |
| 末行 | `verdict="$(… \| tail -n1)"` | 同 |
| 判据 | `[[ "$assert_rc" -ne 0 \|\| "$verdict" != 'ok' ]]` | 同 |
| 失败打印 | `最小权限断言的完整输出（psql exit=%s）` + 全文 | 同 |
| 失败动作 | `fail "…（psql exit=…，最后一行：…）"` ⇒ 立即 `exit 1` | `report_eq` 记 FAIL ⇒ 脚本末尾 `FAIL_COUNT>0` ⇒ `exit 1` |
| 报告键 | 无（provision 没有报告表） | `least_privilege_assert`（**不变**） |

两条差异是**有意保留**的：verify 是「跑完所有项再汇总」的校验器（`report_eq` 只累加 `FAIL_COUNT`、不 exit），所以这里用 `report_eq` 承接判红、不提前中止；改写 `verdict` 是为了让汇总行可读、且不被 `'ok' == 'ok'` 放行。

## 5. 逻辑级复现（不提交的临时 harness）

### 5.1 方法

- 真实脚本**不能**在本机跑（无 `runuser` / 无 Unix socket / 无 `postgres` 系统用户），所以把**脚本原文的代码块**取出来跑：
  - 旧块：`git show 693af5d:deploy/postgres-cvm/verify-cvm-postgres.sh | sed -n '259,267p'`；
  - 新块：工作树同文件 `sed -n '266,284p'`。
- 桩 `runuser()`：打印 `cat <输入文件>`，然后 `return <退出码>`（模拟 `runuser … psql … 2>&1 | tr -d '\r'` 的合并流与退出码；`pipefail` 在真脚本与 harness 里都开）。
- 桩 `report_eq()`：与真脚本同名同签名、打印 `PASS|FAIL <key> 期望=<..> 实际=<..>` 并累加 `FAIL_COUNT`；判定行只看这两个计数（**不靠人眼读文本**）。
- 其它：`SCRIPT_NAME='verify-cvm-postgres.sh'`、`set -euo pipefail`、`PG_BIN`/`PGHOST_SOCKET` 等占位变量，保证块能原样 `eval`。
- harness 与输入都在 `.pg17\tmp\r28-s37\`，**不提交**（`git status --porcelain` 里没有它们）。

### 5.2 三条输入

| 用例 | 输入文件 | 来源 | 退出码 | 说明 |
|---|---|---|---|---|
| A | `raise.merged` | **真实** psql 17.11 的 `2>&1` 合并流（3 行，末行 `CONTEXT:`） | 3 | 派单要求的输入① |
| B | `ok.out` | **真实** psql 17.11 全绿输出（`ok`，CRLF） | 0 | 派单要求的输入②（正控制） |
| C | `files/case-c.rc3-last-ok.txt`（`ok`） | **合成** | 3 | 补充：退出码 3 而末行恰为 `ok`，见 §5.5 |

### 5.3 原始输出（`repro-output.txt` 全文，144 行）

```
######## 抽取到的旧代码块（693af5d:259-267）########
assert_out="$(runuser -u postgres -- "${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 \
  -h "$PGHOST_SOCKET" -U "$DB_OWNER" -d "$DB_NAME" -tA \
  -f "$staged_assert_sql" 2>&1 | tr -d '\r' || true)"
verdict="$(printf '%s\n' "$assert_out" | sed '/^[[:space:]]*$/d' | tail -n1)"
if [[ "$verdict" != 'ok' ]]; then
  # 保留完整输出：缺前置时 90-assert 会打印三步补救指引，不能只留最后一行。
  printf '%s\n' "$assert_out" | sed 's/^/         /' >&2
fi
report_eq 'least_privilege_assert' 'ok' "$verdict"

######## 抽取到的新代码块（工作树 266-284 行）########
assert_rc=0
assert_out="$(runuser -u postgres -- "${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 \
  -h "$PGHOST_SOCKET" -U "$DB_OWNER" -d "$DB_NAME" -tA \
  -f "$staged_assert_sql" 2>&1 | tr -d '\r')" || assert_rc=$?
verdict="$(printf '%s\n' "$assert_out" | sed '/^[[:space:]]*$/d' | tail -n1)"
if [[ "$assert_rc" -ne 0 || "$verdict" != 'ok' ]]; then
  # 保留完整输出：缺前置时 90-assert 会打印三步补救指引，不能只留最后一行。
  printf '[%s] 最小权限断言的完整输出（psql exit=%s）：\n' "$SCRIPT_NAME" "$assert_rc" >&2
  printf '%s\n' "$assert_out" | sed 's/^/         /' >&2
  if [[ "$assert_rc" -ne 0 ]]; then
    printf '[%s] 判红原因①：psql 退出码 %s ≠ 0（90-assert 判决非 ok 时 RAISE EXCEPTION；stderr 的 ERROR:/CONTEXT: 排在 FAIL 文本之后）。\n' \
      "$SCRIPT_NAME" "$assert_rc" >&2
  else
    printf '[%s] 判红原因②：末行不是 ok（实际：%s）。\n' "$SCRIPT_NAME" "${verdict:-（空）}" >&2
  fi
  # 退出码非 0 时改写报告里的「实际值」：否则末行恰好是 ok 会让 report_eq 判成 PASS。
  [[ "$assert_rc" -eq 0 ]] || verdict="psql-exit=${assert_rc}（末行=${verdict:-空}）"
fi
report_eq 'least_privilege_assert' 'ok' "$verdict"

######## 输入①（A）：真实 psql 17.11 判红的合并输出（逐字节取自 raise.merged）########
######## 输入②（B）：真实 psql 17.11 全绿输出（ok.out）                 ########
######## 输入③（C）：合成「退出码 3 而末行 ok」                        ########

================================================================================
【old × A】真实 psql 判红：exit=3，末行 CONTEXT: 行
--- 输入（psql 合并流，退出码=3）---
    FAIL: knowledge_runtime_scope (模拟：运行时多读了一张知识域之外的表)
    psql:pg-raise.sql:14: ERROR:  90-assert-least-privilege FAIL: 1 条断言未通过：knowledge_runtime_scope
    CONTEXT:  PL/pgSQL function inline_code_block line 3 at RAISE
--- 片段自己的 stderr（判红诊断 / 完整输出）---
             FAIL: knowledge_runtime_scope (模拟：运行时多读了一张知识域之外的表)
             psql:pg-raise.sql:14: ERROR:  90-assert-least-privilege FAIL: 1 条断言未通过：knowledge_runtime_scope
             CONTEXT:  PL/pgSQL function inline_code_block line 3 at RAISE
--- 片段自己的 stdout（报告区）---
    --- 报告区（脚本真实 report_eq 产出）---
    FAIL least_privilege_assert                   期望=ok 实际=CONTEXT:  PL/pgSQL function inline_code_block line 3 at RAISE
    PASS=0 FAIL=1
--- 判定 ---
    ⇒ 判红（report_eq 记为 FAIL）
    子 shell 退出码=0（片段自身不 exit；真实脚本靠末尾 FAIL_COUNT>0 ⇒ exit 1）

================================================================================
【new × A】真实 psql 判红：exit=3，末行 CONTEXT: 行
--- 输入（psql 合并流，退出码=3）---
    FAIL: knowledge_runtime_scope (模拟：运行时多读了一张知识域之外的表)
    psql:pg-raise.sql:14: ERROR:  90-assert-least-privilege FAIL: 1 条断言未通过：knowledge_runtime_scope
    CONTEXT:  PL/pgSQL function inline_code_block line 3 at RAISE
--- 片段自己的 stderr（判红诊断 / 完整输出）---
    [verify-cvm-postgres.sh] 最小权限断言的完整输出（psql exit=3）：
             FAIL: knowledge_runtime_scope (模拟：运行时多读了一张知识域之外的表)
             psql:pg-raise.sql:14: ERROR:  90-assert-least-privilege FAIL: 1 条断言未通过：knowledge_runtime_scope
             CONTEXT:  PL/pgSQL function inline_code_block line 3 at RAISE
    [verify-cvm-postgres.sh] 判红原因①：psql 退出码 3 ≠ 0（90-assert 判决非 ok 时 RAISE EXCEPTION；stderr 的 ERROR:/CONTEXT: 排在 FAIL 文本之后）。
--- 片段自己的 stdout（报告区）---
    --- 报告区（脚本真实 report_eq 产出）---
    FAIL least_privilege_assert                   期望=ok 实际=psql-exit=3（末行=CONTEXT:  PL/pgSQL function inline_code_block line 3 at RAISE）
    PASS=0 FAIL=1
--- 判定 ---
    ⇒ 判红（report_eq 记为 FAIL）
    子 shell 退出码=0（片段自身不 exit；真实脚本靠末尾 FAIL_COUNT>0 ⇒ exit 1）

================================================================================
【old × B】真实 psql 全绿：exit=0，末行 ok
--- 输入（psql 合并流，退出码=0）---
    ok
--- 片段自己的 stderr（判红诊断 / 完整输出）---
    （空：没有打印任何诊断）
--- 片段自己的 stdout（报告区）---
    --- 报告区（脚本真实 report_eq 产出）---
    PASS least_privilege_assert                   期望=ok 实际=ok
    PASS=1 FAIL=0
--- 判定 ---
    ⇒ 判绿（report_eq 记为 PASS）
    子 shell 退出码=0（片段自身不 exit；真实脚本靠末尾 FAIL_COUNT>0 ⇒ exit 1）

================================================================================
【new × B】真实 psql 全绿：exit=0，末行 ok
--- 输入（psql 合并流，退出码=0）---
    ok
--- 片段自己的 stderr（判红诊断 / 完整输出）---
    （空：没有打印任何诊断）
--- 片段自己的 stdout（报告区）---
    --- 报告区（脚本真实 report_eq 产出）---
    PASS least_privilege_assert                   期望=ok 实际=ok
    PASS=1 FAIL=0
--- 判定 ---
    ⇒ 判绿（report_eq 记为 PASS）
    子 shell 退出码=0（片段自身不 exit；真实脚本靠末尾 FAIL_COUNT>0 ⇒ exit 1）

================================================================================
【old × C】合成：exit=3，合并流只有判决行 ok（判决之后 psql 才非零退出、未再写 stderr）
--- 输入（psql 合并流，退出码=3）---
    ok
--- 片段自己的 stderr（判红诊断 / 完整输出）---
    （空：没有打印任何诊断）
--- 片段自己的 stdout（报告区）---
    --- 报告区（脚本真实 report_eq 产出）---
    PASS least_privilege_assert                   期望=ok 实际=ok
    PASS=1 FAIL=0
--- 判定 ---
    ⇒ 判绿（report_eq 记为 PASS）
    子 shell 退出码=0（片段自身不 exit；真实脚本靠末尾 FAIL_COUNT>0 ⇒ exit 1）

================================================================================
【new × C】合成：exit=3，合并流只有判决行 ok（判决之后 psql 才非零退出、未再写 stderr）
--- 输入（psql 合并流，退出码=3）---
    ok
--- 片段自己的 stderr（判红诊断 / 完整输出）---
    [verify-cvm-postgres.sh] 最小权限断言的完整输出（psql exit=3）：
             ok
    [verify-cvm-postgres.sh] 判红原因①：psql 退出码 3 ≠ 0（90-assert 判决非 ok 时 RAISE EXCEPTION；stderr 的 ERROR:/CONTEXT: 排在 FAIL 文本之后）。
--- 片段自己的 stdout（报告区）---
    --- 报告区（脚本真实 report_eq 产出）---
    FAIL least_privilege_assert                   期望=ok 实际=psql-exit=3（末行=ok）
    PASS=0 FAIL=1
--- 判定 ---
    ⇒ 判红（report_eq 记为 FAIL）
    子 shell 退出码=0（片段自身不 exit；真实脚本靠末尾 FAIL_COUNT>0 ⇒ exit 1）

================================================================================
汇总（判据只看 report_eq 的 PASS/FAIL）
================================================================================
用例 版本 判定   psql退出码 说明
A      old    FAIL     3            红，但报告「实际值」变成了 CONTEXT: 行（判决文本被挤走）
A      new    FAIL     3            红，原因①：psql 退出码 3 ≠ 0
B      old    PASS     0            绿（正控制）
B      new    PASS     0            绿（正控制，未改变全绿路径）
C      old    PASS     3            ★ 假绿：退出码 3 被 `|| true` 吞掉，末行恰是 ok ⇒ PASS
C      new    FAIL     3            红，原因①：退出码是主判据

（本脚本自身：/e/GengYunCommander/.pg17/tmp/r28-s37/repro.sh）
```

### 5.4 汇总（判定只看 `report_eq` 的 PASS/FAIL）

| 用例 | 改前（`693af5d`） | 改后（工作树） | 读法 |
|---|---|---|---|
| **A** 真实判红：rc=3，末行 `CONTEXT:` | **FAIL** —— 实际值=`CONTEXT:  PL/pgSQL function …`（判决文本被挤走，只能从缩进诊断里找） | **FAIL** —— 原因①，实际值=`psql-exit=3（末行=CONTEXT:  …）` | 两版都红；改后**退出码与原因可见**，不再误读 |
| **B** 真实全绿：rc=0，末行 `ok` | PASS —— 无任何诊断输出 | PASS —— 无任何诊断输出 | **全绿路径行为未变**（正控制） |
| **C** 合成：rc=3，末行 `ok` | **PASS ★假绿** —— 退出码被 `\|\| true` 吞掉，末行恰是 `ok` | **FAIL** —— 原因① | 本片缺陷的直接证据 |

### 5.5 诚实标注（这节比结论重要）

1. **用例 A 在改前也是判红**（`CONTEXT:` ≠ `ok`），它不是假绿。派单说的输入①（退出码 3 且末行 `CONTEXT:` 行）在改前暴露的是**盲区①**：判红原因被 `CONTEXT:` 行顶掉，报告「实际值」不可读 ⇒ 容易被人读成 psql 语法错/环境错，而不是「越权断言失败」。
2. **真正的假绿需要「退出码非 0 且末行 `ok`」**——派单要求的两个输入都覆盖不到这个排列。所以我加了一个**合成**用例 C（派单没禁止补充；没有它就证明不了 §0 里「假绿」那一行）。C 的现实对应是：判决行已打印后 psql 因**非断言原因**失败（例如后续 `DO` 块或 cleanup 语句报错），或将来判决改回纯文本而 psql 因缺前置失败。
3. 旧块/新块都是从**文件原文**抽的（`git show` / `sed -n`），不是手抄；harness 与真脚本用同一份。但桩 `runuser()` 是伪的：它不校验 `-u postgres`、不校验 socket 路径、不校验 `$DB_OWNER`。**逻辑级，不是端到端。**

## 6. 静态守卫单测（`tests/unit/deploy-verify-assert-rc.test.mjs`）

- **正控制**（工作树）：`node --test --test-concurrency=1 tests/unit/deploy-verify-assert-rc.test.mjs` → `tests 3 / pass 3 / fail 0`，exit **0**（三条 `✔` 原文见 §9 附注）。
- **负控制**（把脚本临时换回 `693af5d` 原文、跑完立刻还原）：`tests 3 / pass 1 / fail 2`，exit **1**。失败的两条正是「段内不得有 `|| true`」与「必须双判 + 退出码非 0 时改写 `verdict`」；通过的那条是「报告键与完整输出**不得删除**」——旧文件本来就满足它（它是**删除守卫**、不是**变更守卫**），所以在旧文件上通过是预期行为。负控制证明守卫**能红**，不是永远绿的空测试。
- 三条断言（都只读脚本文本、不执行脚本）：
  1. 段内有 `|| assert_rc=$?`，且段内没有 `|| true`；
  2. 段内有 `[[ "$assert_rc" -ne 0 || "$verdict" != 'ok' ]]`，且退出码非 0 时 `verdict` 被改写；
  3. 全文件里 `report_eq 'least_privilege_assert' 'ok' "$verdict"` 恰好出现一次；`printf '%s\n' "$assert_out" | sed 's/^/         /' >&2` 仍在（失败仍打印完整输出）。

## 7. 顺带核过、但本片不动的 `|| true`

| 行 | 用途 | 判定 |
|---|---|---|
| 116 | `as_runtime()` 把 `SET ROLE` 查询的错误与结果一起回传，供 `report_denied` 比文本 | 判据是 SQLSTATE/错误文本，不是退出码；不在 #345 影响的判红路径上 |
| 186 | `ip -o -4 addr` 取 VPC IP（无匹配时非零退出） | 探测取数，取不到走 `skip`/占位，不进判据 |
| 208 | `ss -ltnH … \| grep -c` 数通配监听 | `grep -c` **计数为 0 时本身就以 1 退出**，`\|\| true` 只为防 `set -e` 中止；stdout 仍是 `0`，`report_eq 'no_wildcard_listener' '0'` 判据正确 |
| 308 | `runtime_tcp_login` 取 `current_user` 的末行 | 期望值是角色名，错误文本不可能与之相等 ⇒ 无假绿路径 |
| 326 / 327 | `schema_migrations` 台账取值 | 前置已用 `to_regclass` 判存在；取值失败退化为错误文本，与期望值必然不等 |
| 352 | `find … \| sort -nr \| awk 'NR==1'` 取最新备份 | 上方「返修 11」注释解释了为何必须容错；结果为空时走 `skip` |
| 378 | `df -P` 取备份盘设备/挂载点 | 纯信息项，判定用显式 `report_eq` 比较设备名 |

未逐条做行为级复现。本片按派单只改 §5 这一处语义（最小 diff），其余留给后续切片。

## 8. 没做到

1. **没有端到端跑过 `verify-cvm-postgres.sh`**：本机 Windows 无 `runuser`、无 Unix socket、无 `postgres` 系统用户、无 `PGDATA=/var/lib/postgresql/…`。脚本本体除 `bash -n` 外**没有执行过**。
2. **没有在真实 CVM / GitHub Actions runner 上验过**判红联动（CI step 退出码、`set -e` 包裹、workflow 里的调用）。
3. **没有跑真实的 `90-assert-least-privilege.sql`**：那要完整 provision（25 个迁移 + 五个组 + 登录角色 + 78 条断言的前置对象），超出本片范围。本片只用**形状相同**的探针 SQL（§3.1）。
4. **用例 C 是合成的**（§5.5），它的现实对应场景未在真机复现。
5. §7 的 8 处 `|| true` 没有逐条行为验证。
6. 本页读数停在「逻辑级复现 + 静态核对 + `bash -n`」，**不等于** CVM 验收通过；判定口径见 §0。
7. 没有 push、没有建 PR、没有发评论（按派单）。

## 9. 门禁读数

| 命令 | exit code | 读数（原始末行） |
|---|---|---|
| `npm run lint` | **0** | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）` / `lint 通过（静态检查；不代表运行期或真实服务已通过）。` |
| `npm run test:contract` | **0** | `ℹ tests 6` / `ℹ pass 6` / `ℹ fail 0` |
| `npm run test:docs` | **0** | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住` 与 `PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住` |
| `node tools/verify-release-materials.mjs` | **0** | `15/15 项通过（离线文档核验；不代表部署、云端或运行期已验收）` |
| `node tools/verify-contract-status.mjs` | **0** | 末行 `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` |
| `D:\Git\bin\bash.exe -n deploy/postgres-cvm/verify-cvm-postgres.sh` | **0** | （无输出） |
| `node --test --test-concurrency=1 tests/unit/deploy-verify-assert-rc.test.mjs` | **0** | `ℹ tests 3` / `ℹ pass 3` / `ℹ fail 0` |

附：单测原始三行

```
✔ verify-cvm-postgres.sh 的 90-assert 段捕 psql 退出码，且不再用 `|| true` 吞掉它 (0.9587ms)
✔ verify-cvm-postgres.sh 的 90-assert 段是「退出码 != 0 或末行 != ok」双判 (0.2525ms)
✔ verify-cvm-postgres.sh 的报告键 least_privilege_assert 与「失败仍打印完整输出」都保留 (0.1507ms)
```

## 10. 复跑方式

```bash
# 静态守卫（必须 --test-concurrency=1）
node --test --test-concurrency=1 tests/unit/deploy-verify-assert-rc.test.mjs
# 语法
D:/Git/bin/bash.exe -n deploy/postgres-cvm/verify-cvm-postgres.sh
# 门禁
npm run lint && npm run test:contract && npm run test:docs \
  && node tools/verify-release-materials.mjs && node tools/verify-contract-status.mjs
# 逻辑级复现（临时文件，不提交）
bash /e/GengYunCommander/.pg17/tmp/r28-s37/repro.sh \
  > /e/GengYunCommander/.pg17/tmp/r28-s37/repro-output.txt 2>&1
```
