#!/usr/bin/env bash
# ============================================================================
# 耕云 · 目标 CVM PostgreSQL 17 就绪后验证清单（可执行）
#
# 状态：技术准备物。**未部署、未验收、未在任何真实 CVM/PG 实例上执行过。**
#       只有资源就绪并真正运行本脚本、保留原始输出后，才有“验证证据”可谈。
#
# 前置：CVM 已创建并加入 VPC gengyun-vpc(10.20.0.0/16)，install-postgres.sh 已执行，
#       迁移已执行，provision-db.sh 已执行。
#
# 用法：
#   sudo ./verify-cvm-postgres.sh
#   sudo ./verify-cvm-postgres.sh --remote-host 10.20.1.9
#       # 额外从同 VPC 的另一台机测 TCP（在本机执行 nc/psql 探针）
#   sudo ./verify-cvm-postgres.sh --runtime-password-env GENGYUN_API_RUNTIME_PASSWORD
#       # 额外做运行时的真实 TCP + scram 登录（口令经环境变量注入，不进 argv）
#
# 退出码：0 = 全部可执行判据通过且无缺项；1 = 有判据失败；2 = 无失败但有缺项（证据不完整）
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
readonly VPC_CIDR='10.20.0.0/16'
readonly VPC_PREFIX='10.20'

DB_NAME="${GENGYUN_DB_NAME:-gengyun}"
PGPORT="${GENGYUN_PGPORT:-5432}"
PGDATA_DIR="${GENGYUN_PGDATA:-/data/gengyun/pgdata}"
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
  runuser -u postgres -- "${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -h "$PGHOST_SOCKET" -U "$DB_OWNER" -d "$DB_NAME" \
    -c "SET ROLE ${RUNTIME_ROLE}; $1" 2>&1 || true
}

tcp_open() { timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# 1. 连通性
# ---------------------------------------------------------------------------
if runuser -u postgres -- "${PG_BIN}/pg_isready" -h "$PGHOST_SOCKET" -q; then sock_ok='yes'; else sock_ok='no'; fi
report_eq 'socket_reachable' 'yes' "$sock_ok"

if tcp_open '127.0.0.1' "$PGPORT"; then lo_ok='yes'; else lo_ok='no'; fi
report_eq 'loopback_tcp_open' 'yes' "$lo_ok"

VPC_IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 \
  | grep -E "^${VPC_PREFIX//./\\.}\." | sort -u | head -1 || true)"
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
report_eq 'server_version' "${PG_MAJOR}.${PG_MINOR}" "$(qs 'SHOW server_version')"
report_eq 'listen_addresses' "127.0.0.1,${VPC_IP:-?}" "$(qs 'SHOW listen_addresses')"
report_eq 'port' "$PGPORT" "$(qs 'SHOW port')"
wild_count="$(ss -ltnH "sport = :${PGPORT}" 2>/dev/null | awk '{print $4}' | grep -cE '^(0\.0\.0\.0|\*|\[::\]):' || true)"
report_eq 'no_wildcard_listener' '0' "$wild_count"

# ---------------------------------------------------------------------------
# 3. pg_hba 与身份映射
# ---------------------------------------------------------------------------
report_eq 'hba_file' "${PGDATA_DIR}/pg_hba.conf" "$(qs 'SHOW hba_file')"
report_eq 'hba_parse_errors' '0' "$(qs 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')"
report_eq 'hba_no_default_route' '0' \
  "$(qs "SELECT count(*) FROM pg_hba_file_rules WHERE netmask = '0.0.0.0' OR address IN ('0.0.0.0','::')")"
report_ge 'hba_vpc_rules' '2' \
  "$(qs "SELECT count(*) FROM pg_hba_file_rules WHERE address = '10.20.0.0' AND netmask = '255.255.0.0'")"
report_eq 'ident_file' "${PGDATA_DIR}/pg_ident.conf" "$(qs 'SHOW ident_file')"
report_eq 'ident_map_rows' '1' "$(qs 'SELECT count(*) FROM pg_ident_file_mappings')"

# ---------------------------------------------------------------------------
# 4. 角色与成员资格（\\du 等价的机器可读版本）
#    全部写成「角色不存在也安全」：子查询 0 行 ⇒ COALESCE 兜底成 'role-missing'，
#    绝不因为角色缺失而抛出 `role "…" does not exist`（返修 1 的同类问题）。
# ---------------------------------------------------------------------------
report_eq 'runtime_role_attrs' 't|t|f|f|f|f|f' \
  "$(qs "SELECT COALESCE((SELECT rolcanlogin || '|' || rolinherit || '|' || rolsuper || '|' || rolcreatedb || '|' || rolcreaterole || '|' || rolreplication || '|' || rolbypassrls FROM pg_roles WHERE rolname='${RUNTIME_ROLE}'), 'role-missing')")"
report_eq 'runtime_password_scram' 't' \
  "$(qs "SELECT COALESCE((SELECT (rolpassword LIKE 'SCRAM-SHA-256\$%')::text FROM pg_authid WHERE rolname='${RUNTIME_ROLE}'), 'role-missing')")"
# pg_has_role(name, …) 在角色缺失时会 ERROR；故先判存在，缺失就返回 'role-missing'。
report_eq 'runtime_group_count' '5' \
  "$(qs "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RUNTIME_ROLE}') THEN (SELECT count(*)::text FROM pg_roles WHERE pg_has_role('${RUNTIME_ROLE}', oid, 'MEMBER') AND rolname <> '${RUNTIME_ROLE}') ELSE 'role-missing' END")"
report_eq 'runtime_not_owner_member' 'f' \
  "$(qs "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RUNTIME_ROLE}') THEN pg_has_role('${RUNTIME_ROLE}', '${DB_OWNER}', 'MEMBER')::text ELSE 'role-missing' END")"
report_eq 'nologin_groups_present' '5' \
  "$(qs "SELECT count(*) FROM pg_roles WHERE rolname IN ('gengyun_auth_privacy','gengyun_preview_reader','gengyun_consent_granter','gengyun_profile_runtime','gengyun_knowledge_runtime') AND NOT rolcanlogin")"

# ---------------------------------------------------------------------------
# 5. 最小权限断言（复用同一份 SQL，保证与 provision-db.sh 口径一致）
# ---------------------------------------------------------------------------
assert_out="$(runuser -u postgres -- "${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 \
  -h "$PGHOST_SOCKET" -U "$DB_OWNER" -d "$DB_NAME" -tA \
  -f "${SQL_DIR}/90-assert-least-privilege.sql" 2>&1 | tr -d '\r' || true)"
verdict="$(printf '%s\n' "$assert_out" | sed '/^[[:space:]]*$/d' | tail -n1)"
if [[ "$verdict" != 'ok' ]]; then
  # 保留完整输出：缺前置时 90-assert 会打印三步补救指引，不能只留最后一行。
  printf '%s\n' "$assert_out" | sed 's/^/         /' >&2
fi
report_eq 'least_privilege_assert' 'ok' "$verdict"

# 正面：运行时能读它该读的投影
out="$(as_runtime 'SELECT count(*) FROM catalog_read.home_species' | tail -n1)"
report_num 'runtime_can_read_home_species' "$out"
out="$(as_runtime 'SELECT count(*) FROM catalog_read.current_knowledge' | tail -n1)"
report_num 'runtime_can_read_current_knowledge' "$out"

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
      -c 'SELECT current_user' 2>&1 | tr -d '\r' | tail -n1 || true)"
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
applied_joined="$(qs "SELECT COALESCE(string_agg(version, ',' ORDER BY version), '') FROM schema_migrations" || true)"
report_eq 'migrations_applied' "$disk_joined" "$applied_joined"
report_eq 'migrations_checksum_not_null' '0' "$(qs 'SELECT count(*) FROM schema_migrations WHERE checksum IS NULL')"

# ---------------------------------------------------------------------------
# 8. 只读取数（证明业务读路径真的通）
# ---------------------------------------------------------------------------
report_num 'readonly_read(public.crops)' "$(qs 'SELECT count(*) FROM public.crops' | tail -n1)"
report_num 'readonly_read(public.regions)' "$(qs 'SELECT count(*) FROM public.regions' | tail -n1)"
report_num 'readonly_read(catalog_read.home_species)' "$(qs 'SELECT count(*) FROM catalog_read.home_species' | tail -n1)"

# ---------------------------------------------------------------------------
# 9. 备份产出存在性与清单一致性
# ---------------------------------------------------------------------------
newest_dump="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'gengyun-*.dump' -printf '%T@ %p\n' 2>/dev/null \
  | sort -nr | head -1 | awk '{print $2}')"
if [[ -n "$newest_dump" ]]; then
  report_eq 'backup_artifact' 'exists' 'exists'
  if [[ -r "${newest_dump}.manifest.txt" ]]; then
    exp="$(sed -n 's/^dump_sha256=//p' -- "${newest_dump}.manifest.txt" | head -1)"
    act="$(sha256sum -- "$newest_dump" | awk '{print $1}')"
    report_eq 'backup_sha256_matches_manifest' "$exp" "$act"
    age_days="$(( ( $(date +%s) - $(stat -c %Y -- "$newest_dump") ) / 86400 ))"
    report_ge 'backup_freshness_days_ok' '0' "$age_days"
  else
    skip 'backup_manifest' '最新备份没有清单，无法核对行数/迁移版本'
  fi
else
  skip 'backup_artifact' "备份目录 ${BACKUP_DIR} 内没有 gengyun-*.dump：备份未执行"
fi

# ---------------------------------------------------------------------------
# 10. 持久存储
# ---------------------------------------------------------------------------
read -r DATA_SRC DATA_MNT <<<"$(df -P -- "$(dirname -- "$PGDATA_DIR")" 2>/dev/null | tail -1 | awk '{print $1, $6}')"
if [[ -f "${PGDATA_DIR}/PG_VERSION" ]]; then pv='yes'; else pv='no'; fi
report_eq 'pgdata_present' 'yes' "$pv"
report_eq 'pgdata_version' "$PG_MAJOR" "$(cat -- "${PGDATA_DIR}/PG_VERSION" 2>/dev/null || echo missing)"
if [[ "${DATA_MNT:-/}" == '/' ]]; then
  _fail 'pgdata_separate_filesystem' '独立云硬盘挂载点（非 /）' '/ （根分区，不满足持久存储要求）'
else
  _pass 'pgdata_separate_filesystem' '独立云硬盘挂载点（非 /）' "${DATA_SRC:-?} @ ${DATA_MNT}"
fi

# ---------------------------------------------------------------------------
# 11. 仅用户可在控制台核对 / 必须由用户提供的项
# ---------------------------------------------------------------------------
manual 'security_group_5432_source' "控制台确认 CVM 安全组入站 5432 来源仅为 ${VPC_CIDR}，无 0.0.0.0/0（脚本无云凭据，无法核对）"
manual 'cvm_in_vpc_gengyun-vpc' '控制台确认该 CVM 所属 VPC 为 gengyun-vpc(vpc-h33f1h5a)，地域 ap-shanghai'
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
