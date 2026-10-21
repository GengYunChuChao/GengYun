#!/usr/bin/env bash
# ============================================================================
# 耕云 · PostgreSQL 17 恢复演练（隔离库）
#
# 状态：技术准备物。**未部署、未验收、未在任何真实 CVM/PG 实例上执行过。**
#       本脚本从未真正恢复过任何备份；"脚本存在"不等于"已演练通过"。
#
# 用途：把 backup-postgres.sh 产出的 dump 恢复到一个**隔离库**，并用清单逐项判定，
#       回答“这份备份真的能恢复、且内容一致吗”。
#
# 必需：一台已运行的 PostgreSQL 17（CVM 上的目标集群，或本机同版本 PG17 均可，
#       不需要真实 CVM）。目标集群必须已存在 dump 里引用的角色
#       （gengyun_cvm_owner 与各 NOLOGIN 组），否则 GRANT 会失败。
#
# 判定口径（全部 PASS 才算恢复成功）：
#   1. dump 文件 sha256 与清单一致（备份没有被截断/改写）
#   2. pg_restore --exit-on-error 退出码为 0，**且输出中没有任何 `ERROR:` 行**
#      （判定不只依赖 exit code：见下方"致命 / 非致命"口径）
#   3. 迁移版本集合与清单一致（schema_migrations）
#   4. 基本表数量、视图数量与清单一致
#   5. 清单列出的关键表逐表行数一致（清单记录 MISSING 的也必须仍然缺失）
#
# 致命 / 非致命 的判读口径（**这一节是为了避免"只看 exit code"造成的误判**）：
#
#   | 输出 | 是否致命 | 说明 |
#   | --- | --- | --- |
#   | `WARNING:` / `NOTICE:` / `pg_restore: warning|notice:` | **非致命** | 不会让 `--exit-on-error` 变非 0；只计数并保留日志 |
#   | `already exists` 类错误 | **致命（但指向目标库）** | 说明**目标库不是空的**（对象已存在）。脚本本来就会先 DROP 再 CREATE；手工复现时必须先 `dropdb`/`createdb`。**不是 dump 的问题** |
#   | `role "…" does not exist` / 其它 `does not exist` | **致命（但指向前置）** | 目标集群**尚未完成角色引导**。**本 dump 是库级 `pg_dump -d`，不含任何角色定义**，所以必须先 `provision-db.sh` 建角色 |
#   | 其它 `pg_restore: error:` / `ERROR:` | **致命** | 真实失败，必须人工定位；本脚本会打印前 5 条 error 行与日志路径 |
#
#   ⚠️ 由此可推出一条重要事实：**库级 dump 不可能产生"角色已存在"错误**
#   （角色不由 dump 创建）；与角色相关的错误只可能是"角色不存在"。
#   所以"exit=1 但看起来数据没问题"最常见的原因就是**恢复进了非空库**，
#   而不是 dump 损坏或非致命噪声——判定时必须把 error 文本取出来看。
#
# 本次演练能证明什么、不能证明什么：
#   能证明：该 dump 可在同主版本 PG 上完整重建 schema+数据+授权，且行数/迁移版本一致。
#   不能证明：跨主版本、异地/全新集群的灾难恢复（需先重建角色），
#             PITR（无 WAL 归档），逐用户删除清单重放（未实现），
#             备份期间的一致性时长/RPO/RTO 指标。
#
# 用法：
#   ./restore-drill.sh --dump <文件.dump> [--target-db gengyun_restore_drill]
#                      [--recreate] [--keep] [--no-manifest]
#   --recreate     目标库已存在且有表时，先 DROP 再建（库名必须含 drill/restore）
#   --keep         演练后保留目标库（默认删除）
#   --no-manifest  无清单时只做“恢复是否报错”的结构性检查（退出码 2 = 证据不完整）
#
# 退出码：0 = 全部判据通过；1 = 有判据失败；2 = 判据不完整（例如缺清单）
# ============================================================================

set -euo pipefail
set +x

readonly SCRIPT_NAME='restore-drill.sh'
readonly PG_MAJOR='17'
readonly PG_BIN="/usr/lib/postgresql/${PG_MAJOR}/bin"
readonly PGHOST_SOCKET='/var/run/postgresql'
readonly DB_OWNER='gengyun_cvm_owner'
readonly ALLOWED_DROP_REGEX='(drill|restore)'

DB_NAME="${GENGYUN_DB_NAME:-gengyun}"

DUMP=''
TARGET_DB='gengyun_restore_drill'
RECREATE=0
KEEP=0
ALLOW_NO_MANIFEST=0

log()  { printf '[%s] %s\n' "$SCRIPT_NAME" "$*"; }
warn() { printf '[%s][WARN] %s\n' "$SCRIPT_NAME" "$*" >&2; }
fail() { printf '[%s][ERROR] %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: ./restore-drill.sh --dump <文件.dump> [--target-db 名称] [--recreate] [--keep] [--no-manifest]

  --dump <文件>        必需。backup-postgres.sh 产出的 pg_dump -Fc 文件
  --target-db <名称>   演练目标库，默认 gengyun_restore_drill（必须含 drill/restore）
  --recreate           目标库已存在且有表时，先 DROP 再建
  --keep               演练后保留目标库（默认删除）
  --no-manifest        无清单时只做结构性检查；结果按“证据不完整”处理
  --help               显示本帮助

判定：同目录下 <dump>.manifest.txt 提供行数/迁移版本判据。全部 PASS 才算恢复成功。

退出码：0 = 全部判据通过；1 = 有判据失败；2 = 判据不完整（例如缺清单）
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dump) [[ $# -ge 2 ]] || fail "--dump 需要一个文件名"; DUMP="$2"; shift 2 ;;
    --target-db) [[ $# -ge 2 ]] || fail "--target-db 需要一个库名"; TARGET_DB="$2"; shift 2 ;;
    --recreate) RECREATE=1; shift ;;
    --keep) KEEP=1; shift ;;
    --no-manifest) ALLOW_NO_MANIFEST=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "未知参数：$1" ;;
  esac
done

# ---------------------------------------------------------------------------
# 0. 前置与安全护栏
# ---------------------------------------------------------------------------
[[ "${EUID}" -eq 0 ]] || fail "需要 root：脚本要降到系统用户 postgres 走 Unix socket。"
[[ -n "$DUMP" ]] || { usage; fail "必须用 --dump 指定备份文件。"; }
[[ -f "$DUMP" ]] || fail "备份文件不存在：${DUMP}"
[[ -x "${PG_BIN}/pg_restore" ]] || fail "未找到 ${PG_BIN}/pg_restore：请先运行 install-postgres.sh。"

case "$TARGET_DB" in
  "$DB_NAME"|postgres|template0|template1)
    fail "拒绝把演练目标指向 ${TARGET_DB}（业务库/系统库）。" ;;
esac
if [[ ! "$TARGET_DB" =~ $ALLOWED_DROP_REGEX ]]; then
  fail "演练目标库名 ${TARGET_DB} 不含 drill/restore：为避免误删，拒绝在 --recreate 时操作它。"
fi

MANIFEST="${DUMP}.manifest.txt"
if [[ ! -r "$MANIFEST" ]]; then
  [[ "$ALLOW_NO_MANIFEST" -eq 1 ]] || fail "缺少清单 ${MANIFEST}：没有行数/迁移版本判据就无法判定恢复成功。
       若只想做“能否恢复”的初筛，请显式加 --no-manifest（结果按证据不完整处理，退出码 2）。"
fi

runuser -u postgres -- "${PG_BIN}/pg_isready" -h "$PGHOST_SOCKET" -q \
  || fail "集群未就绪（socket ${PGHOST_SOCKET}）。"

qs() { # qs <db> <sql>
  runuser -u postgres -- "${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 \
    -h "$PGHOST_SOCKET" -U "$DB_OWNER" -d "$1" -tA -c "$2" | tr -d '\r'
}

# 【返修 11】用 awk 取首行而不是 `| head -1`：在 `set -o pipefail` 下，
#   `head` 提前退出会让上游收到 SIGPIPE(141) ⇒ 整条管道非零 ⇒ set -e 静默中止。
manifest_get() { sed -n "s/^$1=//p" -- "$MANIFEST" | awk 'NR==1{print;exit}'; }

# ---------------------------------------------------------------------------
# 1. dump 自身完整性（与清单比对 sha256）
# ---------------------------------------------------------------------------
PASS_COUNT=0
FAIL_COUNT=0
INCOMPLETE=0
REPORT=()
report() { # report <PASS|FAIL> <判据> <期望> <实际>
  local status="$1" label="$2" expected="$3" actual="$4"
  if [[ "$status" == 'PASS' ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
  REPORT+=("$(printf '%-4s %-34s 期望=%s 实际=%s' "$status" "$label" "$expected" "$actual")")
}

if [[ -r "$MANIFEST" ]]; then
  expected_sha="$(manifest_get 'dump_sha256')"
  actual_sha="$(sha256sum -- "$DUMP" | awk '{print $1}')"
  if [[ -n "$expected_sha" && "$expected_sha" == "$actual_sha" ]]; then
    report PASS 'dump_sha256' "${expected_sha:0:16}…" "${actual_sha:0:16}…"
  else
    report FAIL 'dump_sha256' "${expected_sha:-（清单缺失）}" "${actual_sha:0:16}…"
  fi
  # R28-S44（B 类返修）：原来把这个 `|| true` 直接写在 report PASS 的参数里 —— pg_restore --list
  #   失败会产出 "0" 却**仍然记 PASS**（假绿）。改为先取退出码：读不出目录就判 FAIL，不吞。
  _toc_rc=0
  _toc_count="$(runuser -u postgres -- "${PG_BIN}/pg_restore" --list "$DUMP" | grep -c ';')" || _toc_rc=$?
  if [[ "$_toc_rc" -eq 0 ]]; then
    report PASS 'restore_toc_entries' "$(manifest_get 'restore_toc_entries')" "$_toc_count"
  else
    report FAIL 'restore_toc_entries' "$(manifest_get 'restore_toc_entries')" \
      "pg_restore --list 失败或列不出条目（rc=${_toc_rc}，dump ${DUMP}）"
  fi
else
  warn "无清单：跳过 sha256/行数/迁移版本判据，本次演练按“证据不完整”处理。"
  INCOMPLETE=1
fi

# ---------------------------------------------------------------------------
# 2. 目标库：按需重建（只在演练命名空间内，绝不碰业务库）
# ---------------------------------------------------------------------------
target_exists="$(qs postgres "SELECT 1 FROM pg_database WHERE datname = '${TARGET_DB}'")"
if [[ "$target_exists" == '1' ]]; then
  target_tables="$(qs "$TARGET_DB" "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'")"
  if [[ "${target_tables:-0}" -gt 0 ]]; then
    [[ "$RECREATE" -eq 1 ]] || fail "目标库 ${TARGET_DB} 已存在且有 ${target_tables} 张基本表。
           确认它是上一次演练残留后，加 --recreate 重跑（脚本只会 DROP 名字含 drill/restore 的库）。"
    log "DROP DATABASE ${TARGET_DB}（--recreate；仅演练命名空间）"
    qs postgres "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TARGET_DB}' AND pid <> pg_backend_pid()" >/dev/null
    runuser -u postgres -- "${PG_BIN}/dropdb" -h "$PGHOST_SOCKET" -U "$DB_OWNER" --if-exists "$TARGET_DB"
    target_exists=''
  else
    log "目标库 ${TARGET_DB} 已存在且为空，直接复用。"
  fi
fi
if [[ "$target_exists" != '1' ]]; then
  log "创建隔离目标库 ${TARGET_DB}（owner=${DB_OWNER}）"
  runuser -u postgres -- "${PG_BIN}/createdb" -h "$PGHOST_SOCKET" -U "$DB_OWNER" \
    -O "$DB_OWNER" -E UTF8 "$TARGET_DB"
fi

# ---------------------------------------------------------------------------
# 3. 真正恢复（**保留完整输出**并按"致命 / 非致命"分类，不只依赖 exit code）
#
# 判读口径（同时写在文件头与 verify-checklist.md）：
#   * 非致命：`WARNING:` / `NOTICE:` / `pg_restore: warning|notice:` 行。它们**不会**让
#     `--exit-on-error` 变非 0，也不影响判据；只计入"非致命行数"供人查阅。
#   * 致命：`pg_restore: error:` / `ERROR:` 行，或 exit≠0 ⇒ 一律 FAIL（判据不放宽）。
#   * 重要事实：本 dump 是**库级** `pg_dump -d`（不是 `pg_dumpall`），**不含任何角色定义**。
#     因此**不可能**出现"角色已存在"这类错误；与角色相关的错误只可能是
#     `role "…" does not exist`（⇒ 目标集群尚未做角色引导）。
#     而 `already exists` 只可能来自**恢复进了一个非空库**（对象已存在），
#     那是"目标库没清干净"，**不是 dump 的问题**——脚本本应先 DROP 再 CREATE（`--recreate`）。
# ---------------------------------------------------------------------------
RESTORE_LOG="${TMPDIR:-/tmp}/gengyun-restore-drill-$(date -u '+%Y%m%dT%H%M%SZ').log"
log "恢复中：${DUMP} → ${TARGET_DB}（完整输出写入 ${RESTORE_LOG}）"
restore_rc=0
runuser -u postgres -- "${PG_BIN}/pg_restore" \
  -h "$PGHOST_SOCKET" -U "$DB_OWNER" -d "$TARGET_DB" \
  --exit-on-error --no-password "$DUMP" >"$RESTORE_LOG" 2>&1 || restore_rc=$?

# R28-S44（B 类返修）：grep 失败不能被读成「0 条 ERROR」。
#   notices 只进 PASS 文案（展示），保留吞失败；errors / error_count 参与判定与失败说明，
#   读取失败必须让判定走向 FAIL。注意 `grep -c` 在「0 匹配」时退出码是 1（属正常），所以只有 rc>1 才算读取失败。
# best-effort: notices 只用于 PASS 文案里的「非致命 WARNING/NOTICE 行数」；grep 失败即空，显示为 0 行，不改判定。
notices="$(grep -cE '^(pg_restore: )?(WARNING|NOTICE):' "$RESTORE_LOG" 2>/dev/null || true)"
# 用 `awk 'NR<=5'` 取代 `head -5`：head 提前退出会让 grep 收到 SIGPIPE(141)，pipefail 下会被误判成读取失败。
_grep_errors_rc=0
errors="$(grep -nE '^(pg_restore: error:|ERROR:)' "$RESTORE_LOG" 2>/dev/null | awk 'NR<=5')" || _grep_errors_rc=$?
_grep_count_rc=0
error_count="$(grep -cE '^(pg_restore: error:|ERROR:)' "$RESTORE_LOG" 2>/dev/null)" || _grep_count_rc=$?
[[ "$_grep_count_rc" -le 1 ]] || error_count="grep-failed(rc=${_grep_count_rc})"

if [[ "$restore_rc" -eq 0 && "$_grep_errors_rc" -le 1 && -z "$errors" ]]; then
  report PASS 'pg_restore --exit-on-error' '0' \
    "0（非致命 WARNING/NOTICE ${notices:-0} 行；完整输出 ${RESTORE_LOG}）"
else
  report FAIL 'pg_restore --exit-on-error' '0' \
    "exit=${restore_rc}，致命 error 行=${error_count:-（未知）}（完整输出 ${RESTORE_LOG}）"
  if [[ "$_grep_errors_rc" -gt 1 ]]; then
    printf '[%s] 无法读取恢复日志（grep rc=%s）⇒ 不能断言「没有 ERROR 行」，按失败处理：%s\n' \
      "$SCRIPT_NAME" "$_grep_errors_rc" "$RESTORE_LOG" >&2
  else
    printf '[%s] pg_restore 失败，前几条致命错误：\n' "$SCRIPT_NAME" >&2
    printf '%s\n' "${errors:-（未匹配到 ERROR: 行，请直接查看日志）}" | sed 's/^/         /' >&2
    case "$errors" in
      *already\ exists*)
        printf '[%s] 判读：目标库不是空的（对象已存在）。脚本会先 DROP 再建（--recreate）；\n' "$SCRIPT_NAME" >&2
        printf '         手工复现时请务必在恢复前 dropdb/createdb。**这不是 dump 的问题。**\n' >&2 ;;
      *does\ not\ exist*)
        printf '[%s] 判读：缺角色或缺对象（如 role "…" does not exist）⇒ 目标集群尚未完成角色引导。\n' "$SCRIPT_NAME" >&2
        printf '         本 dump 不含角色定义，必须先跑 provision-db.sh 建角色。\n' >&2 ;;
      *)
        printf '[%s] 判读：既非"对象已存在"也非"对象不存在"，属真实失败，请人工看日志定位。\n' "$SCRIPT_NAME" >&2 ;;
    esac
  fi
fi

# ---------------------------------------------------------------------------
# 4. 内容判定（有清单时）
# ---------------------------------------------------------------------------
if [[ -r "$MANIFEST" && "$restore_rc" -eq 0 ]]; then
  expected_migrations="$(manifest_get 'migration_versions')"
  # 存在性安全的写法：表不存在时直接查询会解析失败，故先用 to_regclass 判存在。
  if [[ "$(qs "$TARGET_DB" "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" == 't' ]]; then
    actual_migrations="$(qs "$TARGET_DB" "SELECT COALESCE(string_agg(version, ',' ORDER BY version), '') FROM schema_migrations")"
  else
    actual_migrations='schema_migrations-missing'
  fi
  if [[ "$expected_migrations" == "$actual_migrations" ]]; then
    report PASS 'migration_versions' "$expected_migrations" "$actual_migrations"
  else
    report FAIL 'migration_versions' "$expected_migrations" "$actual_migrations"
  fi

  for pair in 'base_table_count' 'view_count'; do
    expected="$(manifest_get "$pair")"
    if [[ "$pair" == 'base_table_count' ]]; then
      actual="$(qs "$TARGET_DB" "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'")"
    else
      actual="$(qs "$TARGET_DB" "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='VIEW'")"
    fi
    if [[ "$expected" == "$actual" ]]; then
      report PASS "$pair" "$expected" "$actual"
    else
      report FAIL "$pair" "$expected" "$actual"
    fi
  done

  # R28-S44（B 类返修）：原来 `done < <(grep '^rows:' … || true)` 在 grep 失败时得到**空循环**
  #   ⇒ 逐表行数判据一条都不判，整体仍可能 PASS（假绿）。改为先取退出码显式记账：
  #   rc≠0（读失败，或清单里根本没有 rows: 行）⇒ 直接追加一条 FAIL，绝不让判据静默消失。
  _rows_rc=0
  _rows_lines="$(grep '^rows:' -- "$MANIFEST")" || _rows_rc=$?
  if [[ "$_rows_rc" -ne 0 ]]; then
    report FAIL 'manifest_rows_readable' '至少一行 rows:<表>=<行数>' \
      "grep '^rows:' 失败或未匹配（rc=${_rows_rc}，清单 ${MANIFEST}）"
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    tbl="${line#rows:}"; tbl="${tbl%%=*}"
    expected="${line##*=}"
    if [[ "$(qs "$TARGET_DB" "SELECT to_regclass('${tbl}') IS NOT NULL")" == 't' ]]; then
      actual="$(qs "$TARGET_DB" "SELECT count(*) FROM ${tbl}")"
    else
      actual='MISSING'
    fi
    if [[ "$expected" == "$actual" ]]; then
      report PASS "rows:${tbl}" "$expected" "$actual"
    else
      report FAIL "rows:${tbl}" "$expected" "$actual"
    fi
  done <<<"$_rows_lines"
fi

# ---------------------------------------------------------------------------
# 5. 清理与结论
# ---------------------------------------------------------------------------
if [[ "$KEEP" -eq 1 ]]; then
  log "按 --keep 保留目标库 ${TARGET_DB}（人工核对后可 dropdb）。"
else
  log "删除演练目标库 ${TARGET_DB}"
  qs postgres "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TARGET_DB}' AND pid <> pg_backend_pid()" >/dev/null
  runuser -u postgres -- "${PG_BIN}/dropdb" -h "$PGHOST_SOCKET" -U "$DB_OWNER" --if-exists "$TARGET_DB"
fi

printf '\n===== 恢复演练判定 =====\n'
for l in "${REPORT[@]}"; do printf '%s\n' "$l"; done
printf 'PASS=%s FAIL=%s\n' "$PASS_COUNT" "$FAIL_COUNT"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  printf '%s\n' ''
  printf '[%s] 结论：恢复演练【未通过】。该备份不足以声称可恢复，禁止据此宣称已有可用备份。\n' "$SCRIPT_NAME"
  exit 1
fi
if [[ "$INCOMPLETE" -eq 1 ]]; then
  printf '%s\n' ''
  printf '[%s] 结论：恢复本身成功，但缺少清单，行数/迁移版本判据未执行 ⇒ 证据不完整，不算演练通过。\n' "$SCRIPT_NAME"
  exit 2
fi
cat <<EOF

[${SCRIPT_NAME}] 结论：恢复演练【通过】。
  本次证明了：${DUMP##*/} 可在同主版本 PG17 上完整重建 schema+数据+授权，
              迁移版本、基本表/视图数量与清单列出的关键表行数逐项一致。
  本次未证明：异地或全新集群灾备（需先重建角色）、PITR（无 WAL 归档）、
              逐用户删除清单重放、RPO/RTO 指标。
  仍不得据此宣布“数据库已验收”或“整项完成”。
EOF
