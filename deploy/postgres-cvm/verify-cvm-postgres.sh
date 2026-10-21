#!/usr/bin/env bash
# ============================================================================
# 耕云 · 目标 CVM PostgreSQL 17 就绪后验证清单（可执行）
#
# 状态：技术准备物。**未部署、未验收、未在任何真实 CVM/PG 实例上执行过。**
#       只有资源就绪并真正运行本脚本、保留原始输出后，才有“验证证据”可谈。
#
# 前置：CVM 已创建并加入【方案 A】子账号 S 内新建的 VPC（10.21.0.0/16，即目标网段），
#       install-postgres.sh 已执行，迁移已执行，provision-db.sh 已执行。
#       （历史：原目标曾是父账号 P 的 gengyun-vpc / vpc-h33f1h5a / 10.20.0.0/16，现不用于本路线。）
#
# 用法：
#   sudo ./verify-cvm-postgres.sh
#   sudo ./verify-cvm-postgres.sh --remote-host 10.21.1.9
#       # 额外从同 VPC 的另一台机测 TCP（在本机执行 nc/psql 探针）
#   sudo ./verify-cvm-postgres.sh --runtime-password-env GENGYUN_API_RUNTIME_PASSWORD
#       # 额外做运行时的真实 TCP + scram 登录（口令经环境变量注入，不进 argv）
#
# 退出码：0 = 全部可执行判据通过且无缺项；1 = 有判据失败；2 = 无失败但有缺项（证据不完整）
#
# 【返修 11】**SKIP 的判读（明确写清）**：
#   * `SKIP` 表示"**该项本次没有执行条件**"，不是通过、也不是失败。典型来源：
#     - 未给 `--remote-host` ⇒ 同 VPC 另一台机器的 TCP 探针无法执行（本机无法代替"另一台机器"）；
#     - 未给 `--runtime-password-env` ⇒ 运行时的**真实 TCP + scram 登录**无法执行
#       （`SET ROLE` 只能证明授权语义，不能证明口令与 `pg_hba` 的 host 行端到端可用）。
#   * 因此**退出码 2 = 无失败但证据不完整**：可以说明"已跑的判据都过"，但**不足以**下"验收通过"的结论；
#     补齐缺项（提供 `--remote-host` / 口令环境变量）后重跑并保留输出，才算完整证据。
#   * 反之，**只有退出码 0** 才表示"本次全部可执行判据通过且无缺项"。
#
# 判读方式：每行 PASS/FAIL 都写了“期望=… 实际=…”，逐行对照 verify-checklist.md。
# ============================================================================

set -euo pipefail
set +x

readonly SCRIPT_NAME='verify-cvm-postgres.sh'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
readonly SQL_DIR="${SCRIPT_DIR}/sql"
readonly MIGRATIONS_DIR="${REPO_ROOT}/services/api/db/migrations"

readonly PG_MAJOR='17'
readonly PG_MINOR='11'
readonly PG_BIN="/usr/lib/postgresql/${PG_MAJOR}/bin"
readonly PGHOST_SOCKET='/var/run/postgresql'
readonly DB_OWNER='gengyun_cvm_owner'
readonly RUNTIME_ROLE='gengyun_api_runtime'
readonly VPC_CIDR='10.21.0.0/16'
readonly VPC_PREFIX='10.21'

DB_NAME="${GENGYUN_DB_NAME:-gengyun}"
PGPORT="${GENGYUN_PGPORT:-5432}"
PGDATA_DIR="${GENGYUN_PGDATA:-/data/gengyun/pgdata}"
# 【返修 9 · 缺陷 3】私密路径的逐级可穿越性也要作为装后不变量来核（防被后续 chmod 改坏）
PRIVATE_DIR="${GENGYUN_PRIVATE_DIR:-/etc/gengyun/private}"
PRIVATE_PARENT="$(dirname -- "$PRIVATE_DIR")"
BACKUP_DIR="${GENGYUN_BACKUP_DIR:-/data/gengyun/backup}"
REMOTE_HOST=''
RUNTIME_PW_ENV=''

log()  { printf '[%s] %s\n' "$SCRIPT_NAME" "$*"; }
fail() { printf '[%s][ERROR] %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: sudo ./verify-cvm-postgres.sh [--remote-host <同VPC地址>] [--runtime-password-env <变量名>]

  --remote-host <地址>            额外从该地址测 5432 的 TCP 连通性（同 VPC 探针机）
  --runtime-password-env <变量名> 用该环境变量里的口令做运行时真实 TCP+scram 登录测试
  --help                          显示本帮助

输出分两段：机器可核对的「验证判据」，以及脚本无权核对的「仅用户可核对/提供」。

退出码：0 = 全部可执行判据通过且无缺项；1 = 有判据失败；2 = 无失败但有缺项（证据不完整）
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote-host) [[ $# -ge 2 ]] || fail "--remote-host 需要一个地址"; REMOTE_HOST="$2"; shift 2 ;;
    --runtime-password-env) [[ $# -ge 2 ]] || fail "--runtime-password-env 需要变量名"; RUNTIME_PW_ENV="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "未知参数：$1" ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || fail "需要 root：脚本要降到系统用户 postgres 走 Unix socket。"
[[ -x "${PG_BIN}/psql" ]] || fail "未找到 ${PG_BIN}/psql：请先执行 install-postgres.sh。"

PASS_COUNT=0; FAIL_COUNT=0; INCOMPLETE=0
REPORT=(); MANUAL=()

_pass() { PASS_COUNT=$((PASS_COUNT+1)); REPORT+=("$(printf '%-4s %-40s 期望=%s 实际=%s' PASS "$1" "$2" "$3")"); }
_fail() { FAIL_COUNT=$((FAIL_COUNT+1)); REPORT+=("$(printf '%-4s %-40s 期望=%s 实际=%s' FAIL "$1" "$2" "$3")"); }
report_eq() { if [[ "$2" == "$3" ]]; then _pass "$1" "$2" "$3"; else _fail "$1" "$2" "$3"; fi; }
report_num() { if [[ "$2" =~ ^[0-9]+$ ]]; then _pass "$1" '非负整数' "$2"; else _fail "$1" '非负整数' "${2:-（空）}"; fi; }
report_ge() { if [[ "$3" =~ ^[0-9]+$ ]] && [[ "$3" -ge "$2" ]]; then _pass "$1" ">=${2}" "$3"; else _fail "$1" ">=${2}" "${3:-（空）}"; fi; }
# 【S7】新鲜度是**上界**判据（verify-checklist.md:181 期望 `<=1` 天）：原先用 report_ge '0' 判 age_days>=0，对任何真实 dump 恒真 ⇒ 旧备份也 PASS（该红不红）。
report_le() { if [[ "$3" =~ ^[0-9]+$ ]] && [[ "$3" -le "$2" ]]; then _pass "$1" "<=${2}" "$3"; else _fail "$1" "<=${2}" "${3:-（空）}"; fi; }
report_denied() { # 期望 SQLSTATE
  if grep -q '42501' <<<"$2"; then _pass "$1" '42501' '42501'; else _fail "$1" '42501' "$(tr '\n' ' ' <<<"$2" | cut -c1-120)"; fi
}
skip()   { INCOMPLETE=$((INCOMPLETE+1)); REPORT+=("$(printf '%-4s %-40s %s' SKIP "$1" "$2")"); }
manual() { MANUAL+=("$(printf '%-34s %s' "$1" "$2")"); }

qs() { # qs <sql> [db]
  runuser -u postgres -- "${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 \
    -h "$PGHOST_SOCKET" -U "$DB_OWNER" -d "${2:-$DB_NAME}" -tA -c "$1" 2>&1 | tr -d '\r'
}

as_runtime() { # 以运行时身份执行 SQL（SET ROLE，不需要口令）；输出含 psql 的 stderr
  # 【返修 11 · 缺陷 7】必须带 -tA：否则输出是**对齐表格**（表头 + ` count ` + 分隔线 + `(1 row)`），
  #   调用方 `tail -n1` 拿到的不是数字（或是一个带前导空格的 `0`，读数时看着像"空"）
  #   ⇒ report_num 必然 FAIL。真机实测这两条就是这样 FAIL 的（evidence §10.1）。
  runuser -u postgres -- "${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -h "$PGHOST_SOCKET" -U "$DB_OWNER" -d "$DB_NAME" -tA \
    -c "SET ROLE ${RUNTIME_ROLE}; $1" 2>&1 || true  # best-effort: 保留 psql 的 stderr 供调用方判定——report_denied 只有见 42501 才 PASS、report_num_runtime 只有末行非负整数才 PASS，失败文本一律 FAIL。
}

# 【返修 11 · 缺陷 7】布尔值 → 't'/'f'。psql 的 -tA 对**布尔列**输出 t/f，
# 但 `bool::text` 输出 true/false；构造拼接字符串时一旦 `||` 就会走 ::text 语义 ⇒
# 期望 't|f' 却实际 'true|false'，**必然 FAIL**。这里显式用 CASE 统一成 t/f。
_tf() { printf "CASE WHEN %s THEN 't' ELSE 'f' END" "$1"; }

# 【返修 11 · 缺陷 7】带完整输出的数值判据：失败时把 as_runtime 的**原始输出**打到 stderr，
# 便于一眼看出是权限错、语法错、还是取数路径问题（不再只显示一个空/怪值）。
report_num_runtime() { # <label> <sql>
  local label="$1" sql="$2" raw last
  raw="$(as_runtime "$sql")"
  last="$(printf '%s\n' "$raw" | sed '/^[[:space:]]*$/d' | tail -n1)"
  if [[ "$last" =~ ^[0-9]+$ ]]; then
    _pass "$label" '非负整数' "$last"
  else
    _fail "$label" '非负整数' "${last:-（空）}"
    printf '[%s] %s 的原始输出（供定位）：\n' "$SCRIPT_NAME" "$label" >&2
    printf '%s\n' "$raw" | sed 's/^/         /' >&2
  fi
}

tcp_open() { timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# 【返修 10 · 缺陷 6】把要执行的 SQL 暂存到 postgres 可读处再喂给 psql。
#   仓库常在 /home/<user>（默认 0750）⇒ postgres 穿越不了 ⇒ `psql: error: …Permission denied`
#   （真机实测，evidence §9.2）。这里**不要求放宽仓库权限**，复制到 0700 postgres 的临时目录，
#   执行后由 EXIT trap 删除。
# ---------------------------------------------------------------------------
SQL_STAGE_DIR=''
stage_sql_file() { # <源文件> ⇒ 打印暂存路径；失败返回非 0
  local src="$1" dst
  if [[ ! -r "$src" ]]; then
    printf '[%s][ERROR] SQL 文件不可读（以 root 视角）：%s\n' "$SCRIPT_NAME" "$src" >&2
    return 1
  fi
  if [[ -z "$SQL_STAGE_DIR" || ! -d "$SQL_STAGE_DIR" ]]; then
    SQL_STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gengyun-sql.XXXXXX")" || return 1
    chown postgres:postgres -- "$SQL_STAGE_DIR" \
      || { printf '[%s][ERROR] chown %s 失败（postgres 用户/组是否存在？）\n' "$SCRIPT_NAME" "$SQL_STAGE_DIR" >&2; return 1; }
    chmod 0700 -- "$SQL_STAGE_DIR" \
      || { printf '[%s][ERROR] chmod %s 失败\n' "$SCRIPT_NAME" "$SQL_STAGE_DIR" >&2; return 1; }
  fi
  dst="${SQL_STAGE_DIR}/$(basename -- "$src")"
  cp -f -- "$src" "$dst" \
    || { printf '[%s][ERROR] 复制 %s → %s 失败\n' "$SCRIPT_NAME" "$src" "$dst" >&2; return 1; }
  chown postgres:postgres -- "$dst" \
    || { printf '[%s][ERROR] chown %s 失败（postgres 用户/组是否存在？）\n' "$SCRIPT_NAME" "$dst" >&2; return 1; }
  chmod 0600 -- "$dst" \
    || { printf '[%s][ERROR] chmod %s 失败\n' "$SCRIPT_NAME" "$dst" >&2; return 1; }
  printf '%s' "$dst"
}
cleanup_sql_stage() {
  [[ -n "${SQL_STAGE_DIR:-}" && -d "${SQL_STAGE_DIR:-}" ]] && rm -rf -- "$SQL_STAGE_DIR"
  return 0
}
trap 'cleanup_sql_stage' EXIT

# ---------------------------------------------------------------------------
# 1. 连通性
# ---------------------------------------------------------------------------
if runuser -u postgres -- "${PG_BIN}/pg_isready" -h "$PGHOST_SOCKET" -q; then sock_ok='yes'; else sock_ok='no'; fi
report_eq 'socket_reachable' 'yes' "$sock_ok"

if tcp_open '127.0.0.1' "$PGPORT"; then lo_ok='yes'; else lo_ok='no'; fi
report_eq 'loopback_tcp_open' 'yes' "$lo_ok"

VPC_IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 \
  | grep -E "^${VPC_PREFIX//./\\.}\." | sort -u | head -1 || true)"  # best-effort: 探测失败即空 ⇒ 下面 skip（exit 2），且 listen_addresses 的期望值变 127.0.0.1,? ⇒ 不可能 PASS。
if [[ -n "$VPC_IP" ]]; then
  if tcp_open "$VPC_IP" "$PGPORT"; then vpc_ok='yes'; else vpc_ok='no'; fi
  report_eq "vpc_tcp_open(${VPC_IP})" 'yes' "$vpc_ok"
else
  skip 'vpc_tcp_open' '本机未找到 VPC 网段内的私网 IPv4（CVM 可能未加入该 VPC）'
fi

if [[ -n "$REMOTE_HOST" ]]; then
  if tcp_open "$REMOTE_HOST" "$PGPORT"; then rh='yes'; else rh='no'; fi
  report_eq "remote_vpc_tcp_open(${REMOTE_HOST})" 'yes' "$rh"
else
  skip 'remote_vpc_tcp_open' '未给 --remote-host；同 VPC 另一台机的连通性未测'
fi

# ---------------------------------------------------------------------------
# 2. 版本与监听（与 CI 主版本一致 + 不监听通配地址）
# ---------------------------------------------------------------------------
report_eq 'server_version' "${PG_MAJOR}.${PG_MINOR}" \
  "$(qs "SELECT substring(current_setting('server_version') from '^[0-9]+\.[0-9]+')")"
report_eq 'listen_addresses' "127.0.0.1,${VPC_IP:-?}" "$(qs 'SHOW listen_addresses')"
report_eq 'port' "$PGPORT" "$(qs 'SHOW port')"
# R28-S44（B 类返修）：原来 `ss … | grep -cE … || true` 在 ss/grep 失败时照样输出 "0"
#   ⇒ no_wildcard_listener 会把「没测成」判成 PASS（假绿）。改为先取 ss 退出码：
#   失败显式写成 ss-failed(rc=N)，report_eq 因此判 FAIL —— 绝不把失败降级成 0。
wild_count=''
_listen_rc=0
_listen_raw="$(ss -ltnH "sport = :${PGPORT}" 2>/dev/null)" || _listen_rc=$?
if [[ "$_listen_rc" -eq 0 ]]; then
  wild_count="$(printf '%s\n' "$_listen_raw" | awk '$4 ~ /^(0\.0\.0\.0|\*|\[::\]):/ {n++} END {print n+0}')"
else
  wild_count="ss-failed(rc=${_listen_rc})"
fi
report_eq 'no_wildcard_listener' '0' "$wild_count"

# ---------------------------------------------------------------------------
# 3. pg_hba 与身份映射
# ---------------------------------------------------------------------------
report_eq 'hba_file' "${PGDATA_DIR}/pg_hba.conf" "$(qs 'SHOW hba_file')"
report_eq 'hba_parse_errors' '0' "$(qs 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')"
report_eq 'hba_no_default_route' '0' \
  "$(qs "SELECT count(*) FROM pg_hba_file_rules WHERE netmask = '0.0.0.0' OR address IN ('0.0.0.0','::')")"
report_ge 'hba_vpc_rules' '2' \
  "$(qs "SELECT count(*) FROM pg_hba_file_rules WHERE address = '10.21.0.0' AND netmask = '255.255.0.0'")"
report_eq 'ident_file' "${PGDATA_DIR}/pg_ident.conf" "$(qs 'SHOW ident_file')"
report_eq 'ident_map_rows' '1' "$(qs 'SELECT count(*) FROM pg_ident_file_mappings')"

# ---------------------------------------------------------------------------
# 3b. 私密路径「逐级可穿越」是不变量（返修 9 · 缺陷 3）
#     postgres 要能穿过**每一级**父目录去读 initdb 的临时口令文件；否则下次重装/重建集群
#     会以 initdb Permission denied 失败。这里作为装后判据，防止被后续 chmod 改坏。
# ---------------------------------------------------------------------------
for _pd in "$PRIVATE_PARENT" "$PRIVATE_DIR"; do
  if [[ -d "$_pd" ]]; then
    if runuser -u postgres -- test -x "$_pd"; then _pt='yes'; else _pt='no'; fi
    report_eq "postgres_can_traverse(${_pd})" 'yes' "$_pt"
  else
    report_eq "postgres_can_traverse(${_pd})" 'yes' 'missing'
  fi
done

# ---------------------------------------------------------------------------
# 4. 角色与成员资格（\\du 等价的机器可读版本）
#    全部写成「角色不存在也安全」：子查询 0 行 ⇒ COALESCE 兜底成 'role-missing'，
#    绝不因为角色缺失而抛出 `role "…" does not exist`（返修 1 的同类问题）。
# ---------------------------------------------------------------------------
report_eq 'runtime_role_attrs' 't|t|f|f|f|f|f' \
  "$(qs "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RUNTIME_ROLE}') THEN (SELECT $(_tf rolcanlogin) || '|' || $(_tf rolinherit) || '|' || $(_tf rolsuper) || '|' || $(_tf rolcreatedb) || '|' || $(_tf rolcreaterole) || '|' || $(_tf rolreplication) || '|' || $(_tf rolbypassrls) FROM pg_roles WHERE rolname='${RUNTIME_ROLE}') ELSE 'role-missing' END")"
report_eq 'runtime_password_scram' 't' \
  "$(qs "SELECT COALESCE((SELECT $(_tf "rolpassword LIKE 'SCRAM-SHA-256\$%'") FROM pg_authid WHERE rolname='${RUNTIME_ROLE}'), 'role-missing')")"
# pg_has_role(name, …) 在角色缺失时会 ERROR；故先判存在，缺失就返回 'role-missing'。
report_eq 'runtime_group_count' '5' \
  "$(qs "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RUNTIME_ROLE}') THEN (SELECT count(*)::text FROM pg_roles WHERE pg_has_role('${RUNTIME_ROLE}', oid, 'MEMBER') AND rolname <> '${RUNTIME_ROLE}') ELSE 'role-missing' END")"
report_eq 'runtime_not_owner_member' 'f' \
  "$(qs "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RUNTIME_ROLE}') THEN $(_tf "pg_has_role('${RUNTIME_ROLE}', '${DB_OWNER}', 'MEMBER')") ELSE 'role-missing' END")"
report_eq 'nologin_groups_present' '5' \
  "$(qs "SELECT count(*) FROM pg_roles WHERE rolname IN ('gengyun_auth_privacy','gengyun_preview_reader','gengyun_consent_granter','gengyun_profile_runtime','gengyun_knowledge_runtime') AND NOT rolcanlogin")"

# ---------------------------------------------------------------------------
# 5. 最小权限断言（复用同一份 SQL，保证与 provision-db.sh 口径一致）
# ---------------------------------------------------------------------------
staged_assert_sql="$(stage_sql_file "${SQL_DIR}/90-assert-least-privilege.sql")" \
  || fail "无法暂存 ${SQL_DIR}/90-assert-least-privilege.sql（见上一行错误）。"
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

# 正面：运行时能读它该读的投影（用 report_num_runtime：失败时会打印原始输出）
report_num_runtime 'runtime_can_read_home_species' 'SELECT count(*) FROM catalog_read.home_species'
report_num_runtime 'runtime_can_read_current_knowledge' 'SELECT count(*) FROM catalog_read.current_knowledge'

# 反面：越权必须失败，且 SQLSTATE 为 42501
report_denied 'runtime_denied_select_star_users' "$(as_runtime 'SELECT * FROM public.users')"
report_denied 'runtime_denied_insert_users' "$(as_runtime 'INSERT INTO public.users (id) VALUES (gen_random_uuid())')"
report_denied 'runtime_denied_create_table' "$(as_runtime 'CREATE TABLE public.verify_should_fail (x int)')"
report_denied 'runtime_denied_update_users_state' "$(as_runtime "UPDATE public.users SET state='active'")"

# ---------------------------------------------------------------------------
# 6. 运行时的真实 TCP + scram 登录（需要私密口令，缺则记缺项）
# ---------------------------------------------------------------------------
if [[ -n "$RUNTIME_PW_ENV" ]]; then
  pw="${!RUNTIME_PW_ENV:-}"
  if [[ -z "$pw" ]]; then
    skip 'runtime_tcp_login' "环境变量 ${RUNTIME_PW_ENV} 为空（口令应经私密通道注入，不进 argv/仓库）"
  elif [[ -z "$VPC_IP" ]]; then
    skip 'runtime_tcp_login' '没有 VPC IP 可测'
  else
    login_out="$(PGPASSWORD="$pw" timeout 8 "${PG_BIN}/psql" -X -q -tA \
      -h "$VPC_IP" -p "$PGPORT" -U "$RUNTIME_ROLE" -d "$DB_NAME" \
      -c 'SELECT current_user' 2>&1 | tr -d '\r' | tail -n1 || true)"  # best-effort: 登录失败即错误文本/空 ⇒ 与角色名精确比较不等 ⇒ FAIL。
    report_eq 'runtime_tcp_login' "$RUNTIME_ROLE" "$login_out"
  fi
else
  skip 'runtime_tcp_login' '未给 --runtime-password-env；运行时真实登录未测'
fi

# ---------------------------------------------------------------------------
# 7. 迁移版本（与磁盘文件逐一对应）
# ---------------------------------------------------------------------------
mapfile -t file_versions < <(
  (cd -- "$MIGRATIONS_DIR" && ls -1 -- *.sql 2>/dev/null) \
    | sed -nE 's/^([0-9]{4,})_[a-z0-9_]+\.sql$/\1/p' | sort -u
)
disk_joined="$(printf '%s\n' "${file_versions[@]}" | paste -sd, -)"
# 存在性安全：目标 CVM 上台账是本项判据的权威载体；台账缺失时给出可读的“实际值”，
# 而不是把 psql 的 relation does not exist 原文当成判据结果。
if [[ "$(qs "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" == 't' ]]; then
  # R28-S44（B 类返修）：查询失败不能落成空串 —— 空串与「0 个已应用迁移 / 0 个 checksum IS NULL」
  #   在报告里不可分。失败显式写 query-failed(rc=N)：report_eq 判 FAIL，实际值也直接说明是查询失败而非空集。
  _applied_rc=0
  applied_joined="$(qs "SELECT COALESCE(string_agg(version, ',' ORDER BY version), '') FROM schema_migrations")" || _applied_rc=$?
  [[ "$_applied_rc" -eq 0 ]] || applied_joined="query-failed(rc=${_applied_rc})"
  _nulls_rc=0
  checksum_nulls="$(qs 'SELECT count(*) FROM schema_migrations WHERE checksum IS NULL')" || _nulls_rc=$?
  [[ "$_nulls_rc" -eq 0 ]] || checksum_nulls="query-failed(rc=${_nulls_rc})"
else
  applied_joined='schema_migrations-missing'
  checksum_nulls='schema_migrations-missing'
fi
report_eq 'migrations_applied' "$disk_joined" "$applied_joined"
report_eq 'migrations_checksum_not_null' '0' "$checksum_nulls"

# ---------------------------------------------------------------------------
# 8. 只读取数（证明业务读路径真的通）
# ---------------------------------------------------------------------------
report_num 'readonly_read(public.crops)' "$(qs 'SELECT count(*) FROM public.crops' | tail -n1)"
report_num 'readonly_read(public.regions)' "$(qs 'SELECT count(*) FROM public.regions' | tail -n1)"
report_num 'readonly_read(catalog_read.home_species)' "$(qs 'SELECT count(*) FROM catalog_read.home_species' | tail -n1)"

# ---------------------------------------------------------------------------
# 9. 备份产出存在性与清单一致性
# ---------------------------------------------------------------------------
# 【返修 11】原来 `find … | sort -nr | head -1 | awk`：在 `set -o pipefail` 下，
#   `head -1` 提前退出会让 `find` 收到 SIGPIPE(141)（备份很多时）或 `find` 自身因目录不存在而失败
#   ⇒ **整条管道非零 ⇒ set -e 让脚本静默中止**（stdout 里连汇总都没有）。
#   改为：先判目录存在、用 `awk 'NR==1'` 取代 `head -1`（不提前关闭管道）、并显式容错。
newest_dump=''
if [[ -d "$BACKUP_DIR" ]]; then
  newest_dump="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'gengyun-*.dump' -printf '%T@ %p\n' 2>/dev/null \
    | sort -nr | awk 'NR==1{print $2}')" || true  # best-effort: 枚举失败即空 ⇒ backup_artifact 记 skip（退出码 2），不当「有备份」也不当 PASS。
fi
if [[ -n "$newest_dump" ]]; then
  report_eq 'backup_artifact' 'exists' 'exists'
  if [[ -r "${newest_dump}.manifest.txt" ]]; then
    exp="$(sed -n 's/^dump_sha256=//p' -- "${newest_dump}.manifest.txt" | awk 'NR==1{print;exit}')"
    act="$(sha256sum -- "$newest_dump" | awk '{print $1}')"
    report_eq 'backup_sha256_matches_manifest' "$exp" "$act"
    age_days="$(( ( $(date +%s) - $(stat -c %Y -- "$newest_dump") ) / 86400 ))"
    report_le 'backup_freshness_days_ok' '1' "$age_days"
  else
    skip 'backup_manifest' '最新备份没有清单，无法核对行数/迁移版本'
  fi
else
  skip 'backup_artifact' "备份目录 ${BACKUP_DIR} 内没有 gengyun-*.dump：备份未执行"
fi

# ---------------------------------------------------------------------------
# 10. 持久存储
# ---------------------------------------------------------------------------
# 【返修 11】原来直接 `read -r … <<<"$(df …)"`：当数据目录父级**不存在**时 `df` 失败 ⇒ 输入为空
#   ⇒ `read` 返回 1 ⇒ 在 `set -e` 下**整个脚本静默中止**（stdout 里连汇总都没有）。
#   这里显式判断，并把"父级不存在"当作一条**失败判据**报出来（而不是假 PASS、也不再中止）。
DATA_SRC=''; DATA_MNT=''
_pgdata_parent="$(dirname -- "$PGDATA_DIR")"
if [[ -d "$_pgdata_parent" ]]; then
  # best-effort: df 失败即空 ⇒ 下面 _fail pgdata_separate_filesystem（把「父级不存在/df 不可用」判失败，不当通过）。
  read -r DATA_SRC DATA_MNT <<<"$(df -P -- "$_pgdata_parent" 2>/dev/null | tail -1 | awk '{print $1, $6}')" || true
fi
if [[ -f "${PGDATA_DIR}/PG_VERSION" ]]; then pv='yes'; else pv='no'; fi
report_eq 'pgdata_present' 'yes' "$pv"
report_eq 'pgdata_version' "$PG_MAJOR" "$(cat -- "${PGDATA_DIR}/PG_VERSION" 2>/dev/null || echo missing)"
if [[ -z "${DATA_MNT:-}" ]]; then
  _fail 'pgdata_separate_filesystem' '独立云硬盘挂载点（非 /）' "数据目录父级不存在或 df 不可用（${_pgdata_parent}）"
elif [[ "$DATA_MNT" == '/' ]]; then
  _fail 'pgdata_separate_filesystem' '独立云硬盘挂载点（非 /）' '/ （根分区，不满足持久存储要求）'
else
  _pass 'pgdata_separate_filesystem' '独立云硬盘挂载点（非 /）' "${DATA_SRC:-?} @ ${DATA_MNT}"
fi

# ---------------------------------------------------------------------------
# 11. 仅用户可在控制台核对 / 必须由用户提供的项
# ---------------------------------------------------------------------------
manual 'ingress_5432_source' "控制台确认**入站规则**（标准 CVM=安全组；轻量应用服务器 Lighthouse=实例防火墙）5432 来源仅为 ${VPC_CIDR}，无 0.0.0.0/0（脚本无云凭据，无法核对；官方：Lighthouse 防火墙只控入流量、来源默认为 0.0.0.0/0）"
manual 'cvm_in_target_vpc' '控制台确认该 CVM 所属 VPC 为【方案 A】子账号 S 内新建的 VPC（10.21.0.0/16），地域 ap-shanghai'
manual 'cloud_disk_attached' "控制台确认 ${PGDATA_DIR} 所在云硬盘是独立云硬盘并有快照/续费策略"
manual 'runtime_password_handoff' '运行时的 DATABASE_URL 口令只经私密通道交接，不进聊天/仓库/PR/文档'
manual 'restore_drill_output' 'restore-drill.sh 的原始输出（未执行则不得声称恢复可用）'
manual 'api_side_smoke' 'API 启动后的业务冒烟（健康检查 + 至少一条真实业务读）'

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
printf '\n===== 验证判据（%s）=====\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
for l in "${REPORT[@]}"; do printf '%s\n' "$l"; done
printf 'PASS=%s FAIL=%s SKIP=%s\n' "$PASS_COUNT" "$FAIL_COUNT" "$INCOMPLETE"

printf '\n===== 仅用户可核对/提供 =====\n'
for l in "${MANUAL[@]}"; do printf '%s\n' "$l"; done

printf '\n'
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  printf '[%s] 结论：存在失败判据，资源尚未就绪或配置不符；不得记作已部署/已验收。\n' "$SCRIPT_NAME"
  exit 1
fi
if [[ "$INCOMPLETE" -gt 0 ]]; then
  printf '[%s] 结论：本地判据全通过，但有 %s 项未执行（缺少私密口令/备份/远端探针）⇒ 证据不完整。\n' "$SCRIPT_NAME" "$INCOMPLETE"
  printf '         补齐后用同一脚本重跑，并保存完整原始输出。\n'
  exit 2
fi
printf '[%s] 结论：本机与运行时可执行判据全部通过（PASS=%s）。\n' "$SCRIPT_NAME" "$PASS_COUNT"
printf '         仍需用户完成上方“仅用户可核对/提供”各项，并由验收方独立复核；\n'
printf '         本脚本成功不等于数据库已验收或整项完成。\n'
