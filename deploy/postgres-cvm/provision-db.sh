#!/usr/bin/env bash
# ============================================================================
# 耕云 · CVM PostgreSQL 17：业务库角色引导（迁移之后执行）
#
# 状态：技术准备物。**未部署、未验收、未在任何真实 CVM/PG 实例上执行过。**
#
# 顺序（不可颠倒，理由见 roles-and-migration.md 第 2 节）：
#   install-postgres.sh  →  migrate.ts up  →  provision-db.sh  →  启动 API
#
# 本脚本做的事：
#   1. 校验集群可连、业务库存在、属主是迁移管理员
#   2. 校验全部迁移已应用（比对 schema_migrations 与 services/api/db/migrations/*.sql）
#   3. 用既有 services/api/db/roles/*.sql 创建 NOLOGIN 组（已存在则跳过，不覆盖语义）
#   4. 执行 sql/20-login-roles.sql 创建/收敛应用运行时 LOGIN
#   5. 执行 sql/90-assert-least-privilege.sql，非 ok 即失败
#
# 本脚本不做的事：不改迁移、不改角色 SQL 语义、不建表、不 REVOKE 既有授权、
#   不创建 CVM/云硬盘/安全组、不写死或打印任何口令。
#
# 用法：
#   sudo ./provision-db.sh --plan            # 只校验并打印计划
#   sudo ./provision-db.sh                   # 真正执行（幂等）
#   sudo ./provision-db.sh --with-cli-groups # 额外创建 CLI 组（见下方说明）
#
# 口令来源（二选一，缺一即拒绝运行）：
#   GENGYUN_API_RUNTIME_PASSWORD=<48位小写十六进制>
#   或私密文件 ${GENGYUN_PRIVATE_DIR:-/etc/gengyun/private}/db-credentials.env 中的
#   GENGYUN_API_RUNTIME_PASSWORD=...
# ============================================================================

set -euo pipefail
set +x

readonly SCRIPT_NAME='provision-db.sh'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
readonly SQL_DIR="${SCRIPT_DIR}/sql"
readonly ROLES_DIR="${REPO_ROOT}/services/api/db/roles"
readonly MIGRATIONS_DIR="${REPO_ROOT}/services/api/db/migrations"

readonly PG_MAJOR='17'
readonly PG_BIN="/usr/lib/postgresql/${PG_MAJOR}/bin"
readonly PGHOST_SOCKET='/var/run/postgresql'
readonly DB_OWNER='gengyun_cvm_owner'
readonly RUNTIME_ROLE='gengyun_api_runtime'
readonly PW_REGEX='^[a-f0-9]{48}$'

DB_NAME="${GENGYUN_DB_NAME:-gengyun}"
PRIVATE_DIR="${GENGYUN_PRIVATE_DIR:-/etc/gengyun/private}"
CRED_FILE="${PRIVATE_DIR}/db-credentials.env"
PLAN_ONLY=0
WITH_CLI_GROUPS=0
ROTATE_RUNTIME_PASSWORD=0

log()  { printf '[%s] %s\n' "$SCRIPT_NAME" "$*"; }
warn() { printf '[%s][WARN] %s\n' "$SCRIPT_NAME" "$*" >&2; }
fail() { printf '[%s][ERROR] %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }

# DB_NAME 会被拼进 SQL 字面量，先做形状校验，避免奇怪名字导致 SQL 行为不可预期
[[ "$DB_NAME" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] \
  || fail "GENGYUN_DB_NAME 必须是合法的小写数据库标识符（[a-z_][a-z0-9_]*），当前：${DB_NAME}"

usage() {
  cat <<'EOF'
用法: sudo ./provision-db.sh [--plan] [--with-cli-groups] [--rotate-runtime-password]

  --plan                      只校验前置并打印将要执行的动作，不做任何改动
  --with-cli-groups           额外创建 gengyun_source_operator / gengyun_staging_importer 组
                              （注意：对应 CLI 目前只接受本机回环连接串，
                               见 roles-and-migration.md 第 3 节；CVM 部署通常不需要）
  --rotate-runtime-password   重设 gengyun_api_runtime 的口令（默认**不改口令**，保证重复执行幂等；
                              轮换后 pg_authid.rolpassword 必然变化——PostgreSQL 每次
                              ALTER ROLE … PASSWORD 都会用新的随机 salt，属固有行为）
  --help                      显示本帮助

执行顺序（不可颠倒，脚本内有硬门禁）：
  集群/业务库(install-postgres.sh) ⇒ 迁移(migrate.ts up) ⇒ 本脚本（建组 ⇒ 20-login-roles.sql ⇒ 90-assert）⇒ 启动 API
EOF
}

for arg in "$@"; do
  case "$arg" in
    --plan) PLAN_ONLY=1 ;;
    --with-cli-groups) WITH_CLI_GROUPS=1 ;;
    --rotate-runtime-password) ROTATE_RUNTIME_PASSWORD=1 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "未知参数：${arg}（支持 --plan / --with-cli-groups / --rotate-runtime-password / --help）" ;;
  esac
done

# ---------------------------------------------------------------------------
# 1. 前置
# ---------------------------------------------------------------------------
[[ "${EUID}" -eq 0 ]] || fail "需要 root：脚本要降到系统用户 postgres 走 Unix socket。"
[[ -x "${PG_BIN}/psql" ]] || fail "未找到 ${PG_BIN}/psql：请先运行 install-postgres.sh。"
[[ -d "$MIGRATIONS_DIR" ]] || fail "未找到迁移目录 ${MIGRATIONS_DIR}（工作区不完整）。"
[[ -r "${SQL_DIR}/20-login-roles.sql" && -r "${SQL_DIR}/90-assert-least-privilege.sql" ]] \
  || fail "缺少 ${SQL_DIR}/20-login-roles.sql 或 90-assert-least-privilege.sql。"

# 口令：环境变量优先，其次私密文件；两者都不给就拒绝
read_secret_from_file() {
  local key="$1" value mode
  [[ -r "$CRED_FILE" ]] || return 1
  mode="$(stat -c '%a' "$CRED_FILE")"
  case "$mode" in
    *[1-7][1-7]|*[1-7][0-9]) fail "私密文件 ${CRED_FILE} 权限过宽（${mode}）：请 chmod 600。" ;;
  esac
  value="$(sed -n "s/^${key}=//p" -- "$CRED_FILE" | head -1)"
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

RUNTIME_PASSWORD="${GENGYUN_API_RUNTIME_PASSWORD:-}"
if [[ -z "$RUNTIME_PASSWORD" ]]; then
  RUNTIME_PASSWORD="$(read_secret_from_file 'GENGYUN_API_RUNTIME_PASSWORD' || true)"
fi
[[ -n "$RUNTIME_PASSWORD" ]] || fail "缺少应用运行时口令。任选其一：
         (a) export GENGYUN_API_RUNTIME_PASSWORD=<48位小写十六进制>
         (b) ${CRED_FILE}（权限 600）中一行：GENGYUN_API_RUNTIME_PASSWORD=...
         生成示例： openssl rand -hex 24"
[[ "$RUNTIME_PASSWORD" =~ $PW_REGEX ]] \
  || fail "应用运行时口令格式不符：要求 48 位小写十六进制（与 tools/local-dev/start.ps1 一致）。"

# ---------------------------------------------------------------------------
# 2. psql 封装（以系统用户 postgres 走 Unix socket + pg_ident 映射，免口令）
# ---------------------------------------------------------------------------
PSQL_BASE=(-X -q -v ON_ERROR_STOP=1 -h "$PGHOST_SOCKET" -U "$DB_OWNER" -d "$DB_NAME")

qs() { # 单值查询：qs "<sql>"
  runuser -u postgres -- "${PG_BIN}/psql" "${PSQL_BASE[@]}" -tA -c "$1" | tr -d '\r'
}
qfile() { runuser -u postgres -- "${PG_BIN}/psql" "${PSQL_BASE[@]}" -tA -f "$1" | tr -d '\r'; }

if [[ "$PLAN_ONLY" -eq 0 ]]; then
  runuser -u postgres -- "${PG_BIN}/pg_isready" -h "$PGHOST_SOCKET" -q \
    || fail "集群未就绪（socket ${PGHOST_SOCKET}）。请先 systemctl status gengyun-postgresql.service。"
else
  command -v runuser >/dev/null 2>&1 || fail "缺少 runuser。"
fi

if [[ "$PLAN_ONLY" -eq 0 ]]; then
  [[ "$(qs "SELECT current_database()")" == "$DB_NAME" ]] \
    || fail "无法以 ${DB_OWNER} 连接业务库 ${DB_NAME}；请确认 install-postgres.sh 已执行、pg_hba/pg_ident 已安装。"
  db_owner_actual="$(qs "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()")"
  [[ "$db_owner_actual" == "$DB_OWNER" ]] \
    || fail "业务库 ${DB_NAME} 的属主是 ${db_owner_actual}，期望 ${DB_OWNER}；拒绝在非本交付的库上引导角色。"
else
  log "[PLAN] 校验：以 ${DB_OWNER} 连接 ${DB_NAME}，确认库属主为 ${DB_OWNER}"
fi

# ---------------------------------------------------------------------------
# 3. 迁移必须先完成：schema_migrations 与磁盘迁移文件逐一对应
# ---------------------------------------------------------------------------
if [[ "$PLAN_ONLY" -eq 1 ]]; then
  log "[PLAN] 校验迁移：比对 ${MIGRATIONS_DIR}/*.sql 与 schema_migrations.version"
else
  has_ledger="$(qs "SELECT to_regclass('public.schema_migrations') IS NOT NULL")"
  [[ "$has_ledger" == 't' ]] || fail "业务库 ${DB_NAME} 尚无 schema_migrations 表：迁移未执行。
       请先执行（一次性运维，DATABASE_URL 只从私密环境注入）：
         export DATABASE_URL='postgres://${DB_OWNER}:<私密口令>@127.0.0.1:${GENGYUN_PGPORT:-5432}/${DB_NAME}'
         node services/api/src/db/migrate.ts up
       顺序不能颠倒：角色文件是在迁移建出的表/视图上授权的。"
fi

mapfile -t file_versions < <(
  (cd -- "$MIGRATIONS_DIR" && ls -1 -- *.sql 2>/dev/null) \
    | sed -nE 's/^([0-9]{4,})_[a-z0-9_]+\.sql$/\1/p' | sort -u
)
[[ "${#file_versions[@]}" -gt 0 ]] || fail "在 ${MIGRATIONS_DIR} 未发现任何 NNNN_name.sql 迁移。"

applied_versions_raw=''
if [[ "$PLAN_ONLY" -eq 0 ]]; then
  applied_versions_raw="$(qs "SELECT version FROM schema_migrations ORDER BY version")"
fi
mapfile -t applied_versions < <(printf '%s\n' "$applied_versions_raw" | sed '/^[[:space:]]*$/d' | sort -u)

if [[ "$PLAN_ONLY" -eq 0 ]]; then
  # 已应用版本列表（用于逐个比对；空数组在 bash 5 下安全）
  applied_list=''
  if [[ "${#applied_versions[@]}" -gt 0 ]]; then
    applied_list="$(printf '%s\n' "${applied_versions[@]}")"
  fi

  missing=''
  for v in "${file_versions[@]}"; do
    if ! grep -qxF -- "$v" <<<"${applied_list:-}"; then
      missing="${missing} ${v}"
    fi
  done
  [[ -z "$missing" ]] || fail "以下迁移在磁盘上存在但未应用：${missing}
       请先执行： node services/api/src/db/migrate.ts up
       （顺序不能颠倒：角色文件授权依赖迁移建出的表与视图。）"

  extra=''
  if [[ -n "$applied_list" ]]; then
    for a in "${applied_versions[@]}"; do
      if ! grep -qxF -- "$a" < <(printf '%s\n' "${file_versions[@]}"); then
        extra="${extra} ${a}"
      fi
    done
  fi
  [[ -z "$extra" ]] || warn "台账里有磁盘上不存在的迁移版本：${extra}（不阻塞，但请核对 HEAD 是否与部署一致）。"
  log "迁移校验通过：${#file_versions[@]} 个版本已全部应用（${file_versions[*]}）。"
else
  log "[PLAN] 期望已应用迁移版本：${file_versions[*]}"
fi

# ---------------------------------------------------------------------------
# 4. 既有 NOLOGIN 组（优先复用 services/api/db/roles/*.sql，不新造一套）
# ---------------------------------------------------------------------------
# 顺序与依赖：
#   auth_privacy      —— 身份/会话/隐私/幂等键（0001/0003/0008/0009 的表）
#   catalog_readers   —— preview_reader + evidence_reader（0005 的视图）
#   consent_granter   —— 用途授权/撤回（0009 的表）
#   profile_runtime   —— 作物/地区/单作物档案（0001 的表）
#   knowledge_runtime —— 0010 的 security_barrier 投影
# 运行时只继承前 4 个中的 preview_reader（不是 evidence_reader），见 roles-and-migration.md。
GROUPS=(
  'gengyun_auth_privacy:auth_privacy.sql'
  'gengyun_preview_reader:catalog_readers.sql'
  'gengyun_consent_granter:consent_granter.sql'
  'gengyun_profile_runtime:profile_runtime.sql'
  'gengyun_knowledge_runtime:knowledge_runtime.sql'
)
if [[ "$WITH_CLI_GROUPS" -eq 1 ]]; then
  GROUPS+=(
    'gengyun_source_operator:source_operator.sql'
    'gengyun_staging_importer:staging_importer.sql'
  )
fi

for entry in "${GROUPS[@]}"; do
  role="${entry%%:*}"
  file="${entry##*:}"
  [[ -r "${ROLES_DIR}/${file}" ]] || fail "缺少既有角色文件 ${ROLES_DIR}/${file}（工作区不完整）。"

  if [[ "$PLAN_ONLY" -eq 1 ]]; then
    log "[PLAN] 若 ${role} 不存在则执行 services/api/db/roles/${file}"
    continue
  fi

  exists="$(qs "SELECT 1 FROM pg_roles WHERE rolname = '${role}'")"
  if [[ "$exists" == '1' ]]; then
    log "跳过 ${role}：已存在（不覆盖既有授权语义）。"
    continue
  fi
  # 既有角色文件自身带 BEGIN;/COMMIT;，此处不再套 --single-transaction。
  log "创建组 ${role}（执行 services/api/db/roles/${file}）"
  runuser -u postgres -- "${PG_BIN}/psql" "${PSQL_BASE[@]}" -f "${ROLES_DIR}/${file}"
  after="$(qs "SELECT 1 FROM pg_roles WHERE rolname = '${role}'")"
  [[ "$after" == '1' ]] || fail "执行 ${file} 后仍找不到角色 ${role}，请检查该文件是否被改动。"
done

# catalog_readers.sql 同时建出 evidence_reader；此处只确认它存在，不授予运行时。
if [[ "$PLAN_ONLY" -eq 0 ]]; then
  evidence_exists="$(qs "SELECT 1 FROM pg_roles WHERE rolname = 'gengyun_evidence_reader'")"
  [[ "$evidence_exists" == '1' ]] && log "gengyun_evidence_reader 已存在但刻意不授予 ${RUNTIME_ROLE}（内部证据读取路由尚未接线）。"
fi

# ---------------------------------------------------------------------------
# 5. 运行时 LOGIN：创建/收敛 + 授予组成员 + 最小权限断言
# ---------------------------------------------------------------------------
if [[ "$PLAN_ONLY" -eq 1 ]]; then
  log "[PLAN] 执行 sql/20-login-roles.sql（创建（仅缺失时）/收敛 ${RUNTIME_ROLE}，授予 5 个 NOLOGIN 组）"
  log "[PLAN] 口令：$([[ "$ROTATE_RUNTIME_PASSWORD" -eq 1 ]] && echo '将按 --rotate-runtime-password 轮换' || echo '默认不改动（重复执行幂等）')"
  log "[PLAN] 执行 sql/90-assert-least-privilege.sql（必须输出 ok）"
else
  log "执行 sql/20-login-roles.sql（口令经环境变量传给 psql 的 \\getenv，不落 argv/不打印）"

  # 前置：确认 runuser 会保留环境变量（不同发行版/是否走 PAM 可能不同）。
  # 这一步只探测「变量名」，探测值不是口令 ⇒ 不涉及秘密。
  # 若此处失败，说明无法把口令安全地传进 psql；下面给出不经 argv 的替代做法。
  if ! GENGYUN_ENV_PROBE=1 runuser -u postgres -- sh -c '[ "$GENGYUN_ENV_PROBE" = 1 ]'; then
    fail "runuser 未保留环境变量，无法把口令安全传给 psql（本脚本拒绝把口令放 argv）。
         替代做法（任选其一，口令仍只经环境/私密文件）：
           1) sudo --preserve-env=GENGYUN_API_RUNTIME_PASSWORD -u postgres -- \\
                ${PG_BIN}/psql ${PSQL_BASE[*]} -f ${SQL_DIR}/20-login-roles.sql
           2) set -a; . ${CRED_FILE}; set +a
              runuser -u postgres -- ${PG_BIN}/psql ${PSQL_BASE[*]} -f ${SQL_DIR}/20-login-roles.sql
         或把本机 shell 换成保留环境的实现后重跑。"
  fi

  # 环境变量前缀作用于 runuser 本身；上面的前置已确认 runuser 会保留它们。
  # 若 GENGYUN_API_RUNTIME_PASSWORD 仍没传到 psql，20-login-roles.sql 的 \getenv 守卫会明确失败，
  # 不会建出无口令身份。GENGYUN_ROTATE_RUNTIME_PASSWORD 只在显式要求轮换时才置 1。
  GENGYUN_API_RUNTIME_PASSWORD="$RUNTIME_PASSWORD" \
  GENGYUN_ROTATE_RUNTIME_PASSWORD="$([[ "$ROTATE_RUNTIME_PASSWORD" -eq 1 ]] && echo 1 || echo 0)" \
    runuser -u postgres -- "${PG_BIN}/psql" "${PSQL_BASE[@]}" -f "${SQL_DIR}/20-login-roles.sql"

  log "执行最小权限断言 sql/90-assert-least-privilege.sql"
  # 保留**完整**输出：90-assert 在缺前置时会打印三步补救指引，不能只留最后一行。
  assert_out="$(qfile "${SQL_DIR}/90-assert-least-privilege.sql" || true)"
  verdict="$(printf '%s\n' "$assert_out" | sed '/^[[:space:]]*$/d' | tail -n1)"
  if [[ "$verdict" != 'ok' ]]; then
    printf '[%s] 最小权限断言的完整输出：\n' "$SCRIPT_NAME" >&2
    printf '%s\n' "$assert_out" | sed 's/^/         /' >&2
    fail "最小权限断言未通过（最后一行：${verdict}）
         若输出里是「前置未满足」，请按其中的三步指引先补迁移/角色引导后重跑；
         若输出里是 FAIL 明细，本脚本只报告不自动回收权限，请对照
         services/api/db/roles/*.sql 人工排查。"
  fi
  log "最小权限断言通过：${verdict}"
fi

# ---------------------------------------------------------------------------
# 6. 结束语
# ---------------------------------------------------------------------------
cat <<EOF

[${SCRIPT_NAME}] 完成（PLAN_ONLY=${PLAN_ONLY}, WITH_CLI_GROUPS=${WITH_CLI_GROUPS}）。
  业务库        : ${DB_NAME}
  迁移管理员    : ${DB_OWNER}（超级用户，仅运维使用；API 不得使用）
  应用运行时    : ${RUNTIME_ROLE}（LOGIN INHERIT，无特权位，仅 5 个既有 NOLOGIN 组）
  未授予        : gengyun_evidence_reader / gengyun_source_operator / gengyun_staging_importer

下一步（都由用户在获准后执行）：
  1) 把 ${RUNTIME_ROLE} 的连接串经私密通道交给 API 部署（DATABASE_URL），
     绝不要贴进聊天、仓库、PR 或文档
  2) 启动 API 并做业务冒烟
  3) 运行 ./verify-cvm-postgres.sh 记录验收前证据

注意：本脚本成功 ≠ 数据库已部署或已验收，只表示“在某个已就绪集群上完成角色引导”。
EOF
