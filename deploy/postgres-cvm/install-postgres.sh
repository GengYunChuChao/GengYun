#!/usr/bin/env bash
# ============================================================================
# 耕云 · 目标 CVM 上的 PostgreSQL 17 安装与初始化脚本
#
# 状态：技术准备物。**未部署、未验收、未在任何真实 CVM/PG 实例上执行过。**
#       本脚本通过本机 bash 语法检查，但没有可用 PostgreSQL 可供运行验证，
#       因此“脚本存在”不等于“已安装”。证据见 evidence/local-self-check.md。
#
# 目标形态（不可自行变更）：
#   腾讯云 · ap-shanghai · 【方案 A（用户已选定）】在子账号 S 内新建的 VPC（10.21.0.0/16）下的 CVM
#   （历史：原目标曾是父账号 P 的 gengyun-vpc(vpc-h33f1h5a, 10.20.0.0/16)；该 VPC 现**不用于本路线**，保留不动）
#   PostgreSQL 17.11（与 .github/workflows/*postgres*.yml 的 postgres:17.11 /
#   postgres:17 主版本一致；本脚本只装 17.11，不升级也不降级主版本）
#   数据目录落在独立持久云硬盘，重启后仍在
#   PostgreSQL 仅内网可达：listen_addresses 只含回环 + VPC 私网 IP，公网 5432 不开放
#
# 本脚本不做的事：
#   * 不创建/购买/挂载任何云资源（CVM、云硬盘、安全组、VPC 互联都在控制台完成）
#   * 不写死、不打印、不落盘任何密钥；口令只从环境或私密文件读取
#   * 不创建业务角色（在迁移之后由 provision-db.sh 完成）
#   * 不安装发行版自带集群以外的任何 PG 主版本，不自动升级 minor
#
# 用法：
#   sudo ./install-postgres.sh --plan     # 只做检测并打印计划，零改动
#   sudo ./install-postgres.sh            # 真正执行（幂等，可重复运行）
#
# 可覆盖的环境变量（都有安全默认值）：
#   GENGYUN_PGDATA                  数据目录，默认 /data/gengyun/pgdata
#   GENGYUN_PGPORT                  端口，默认 5432
#   GENGYUN_DB_NAME                 业务库名，默认 gengyun
#   GENGYUN_PRIVATE_DIR             私密目录，默认 /etc/gengyun/private
#   GENGYUN_VPC_PRIVATE_IP          私网 IPv4 覆盖值（仍须落在 VPC 网段内）
#   GENGYUN_ALLOW_ROOTFS=1          允许数据目录落在根分区（默认拒绝）
#   GENGYUN_DROP_DEFAULT_CLUSTER=1  删除发行版自动创建的空 17/main 集群（默认拒绝）
#   GENGYUN_DB_OWNER_PASSWORD       迁移管理员口令（48 位小写十六进制）
# ============================================================================

set -euo pipefail
set +x   # 显式关闭命令回显，避免私密值进入终端或日志

readonly SCRIPT_NAME='install-postgres.sh'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
readonly CONF_DIR="${SCRIPT_DIR}/conf"

# --- 固定目标形态 -----------------------------------------------------------
readonly PG_MAJOR='17'
readonly PG_MINOR='11'
readonly PG_BIN="/usr/lib/postgresql/${PG_MAJOR}/bin"
readonly VPC_CIDR='10.21.0.0/16'   # 方案 A：子账号 S 内新建的 VPC；与父账号 gengyun-vpc 的 10.20.0.0/16 不重叠
readonly VPC_NAME='方案 A 目标 VPC（子账号 S 内新建，名称待用户确定）'
readonly VPC_ID='待用户在子账号 S 内创建后填写'
readonly REGION='ap-shanghai'
readonly DB_OWNER='gengyun_cvm_owner'
readonly RUNTIME_ROLE='gengyun_api_runtime'
readonly UNIT_NAME='gengyun-postgresql.service'
readonly UNIT_PATH="/etc/systemd/system/${UNIT_NAME}"
readonly PGDG_KEY='/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc'
readonly PGDG_LIST='/etc/apt/sources.list.d/pgdg.list'
readonly PW_REGEX='^[a-f0-9]{48}$'

DB_NAME="${GENGYUN_DB_NAME:-gengyun}"
PGDATA_DIR="${GENGYUN_PGDATA:-/data/gengyun/pgdata}"
PGPORT="${GENGYUN_PGPORT:-5432}"
PRIVATE_DIR="${GENGYUN_PRIVATE_DIR:-/etc/gengyun/private}"
CRED_FILE="${PRIVATE_DIR}/db-credentials.env"
PLAN_ONLY=0

log()  { printf '[%s] %s\n' "$SCRIPT_NAME" "$*"; }
warn() { printf '[%s][WARN] %s\n' "$SCRIPT_NAME" "$*" >&2; }
fail() { printf '[%s][ERROR] %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }

# 输入形状校验：DB_NAME 会被写进 pg_hba.conf 模板替换，必须是安全的标识符
[[ "$PGPORT" =~ ^[0-9]{1,5}$ ]] || fail "GENGYUN_PGPORT 必须是端口号，当前：${PGPORT}"
[[ "$DB_NAME" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] \
  || fail "GENGYUN_DB_NAME 必须是合法的小写数据库标识符（[a-z_][a-z0-9_]*），当前：${DB_NAME}"
[[ "$PGDATA_DIR" == /* ]] || fail "GENGYUN_PGDATA 必须是绝对路径，当前：${PGDATA_DIR}"

# act "<说明>" <命令...>：PLAN 模式只打印，不执行任何改动。
act() {
  local desc="$1"; shift
  if [[ "$PLAN_ONLY" -eq 1 ]]; then
    log "[PLAN] ${desc}"
    return 0
  fi
  log "${desc}"
  "$@"
}

usage() {
  cat <<'EOF'
用法: sudo ./install-postgres.sh [--plan]

  --plan   只检测前置并打印将要执行的动作，不做任何改动
  --help   显示本帮助
EOF
}

for arg in "$@"; do
  case "$arg" in
    --plan) PLAN_ONLY=1 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "未知参数：${arg}（支持 --plan / --help）" ;;
  esac
done

# ---------------------------------------------------------------------------
# 1. 前置：身份、发行版、工具
# ---------------------------------------------------------------------------
[[ "${EUID}" -eq 0 ]] || fail "需要 root：请用 sudo 运行（安装包与写 /etc 需要 root）。"

[[ -r /etc/os-release ]] || fail "无法读取 /etc/os-release，无法确认发行版。"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) : ;;
  *) fail "目标 CVM 发行版为 '${ID:-unknown}'，本脚本只实现 apt 系（与 CI 的 ubuntu-latest 同族）。
         腾讯云镜像若为 TencentOS/OpenCloudOS/Anolis/CentOS，需要 yum/dnf 变体，本交付未提供。
         这是必须先由用户确认的前置项（README.md 第 4 节 P1），不要用 apt 强行执行。" ;;
esac
case "${ID}:${VERSION_ID:-}" in
  ubuntu:22.04|ubuntu:24.04|debian:12) : ;;
  *) warn "发行版 ${ID} ${VERSION_ID:-?} 不在 PGDG apt 已验证列表 (ubuntu 22.04/24.04, debian 12) 内，继续但请人工确认仓库可用。" ;;
esac

for cmd in curl awk sed grep ss df systemctl ip runuser; do
  command -v "$cmd" >/dev/null 2>&1 || fail "缺少必需命令：${cmd}（请先在 CVM 上安装 util-linux/iproute2 等基础包）。"
done

# ---------------------------------------------------------------------------
# 2. VPC 私网地址：必须正好一个，且落在 VPC 网段内
# ---------------------------------------------------------------------------
readonly VPC_PREFIX="$(
  net="${VPC_CIDR%%/*}"
  [[ "${VPC_CIDR##*/}" == '16' ]] || { printf 'only-/16' ; exit 0; }
  IFS=. read -r o1 o2 _ _ <<<"$net"
  printf '%s.%s' "$o1" "$o2"
)"
[[ "$VPC_PREFIX" == 'only-/16' ]] && fail "本脚本的网段判定只实现 ${VPC_CIDR} 这种 /16 形式，当前值无法判定。"

if [[ -n "${GENGYUN_VPC_PRIVATE_IP:-}" ]]; then
  VPC_PRIVATE_IP="${GENGYUN_VPC_PRIVATE_IP}"
  log "使用 GENGYUN_VPC_PRIVATE_IP 覆盖值：${VPC_PRIVATE_IP}"
else
  mapfile -t _ip_candidates < <(
    ip -4 -o addr show scope global 2>/dev/null \
      | awk '{print $4}' | cut -d/ -f1 \
      | grep -E "^${VPC_PREFIX//./\\.}\." | sort -u
  )
  [[ "${#_ip_candidates[@]}" -eq 1 ]] || fail \
    "在 VPC 网段 ${VPC_CIDR} 内找到 ${#_ip_candidates[@]} 个私网 IPv4（期望正好 1 个）：
         候选：${_ip_candidates[*]:-（无）}
         请确认该 CVM 已加入 ${VPC_NAME} 的对应子网（VPC ID：${VPC_ID}），
         或显式设置 GENGYUN_VPC_PRIVATE_IP=<该 CVM 的私网 IPv4>。"
  VPC_PRIVATE_IP="${_ip_candidates[0]}"
fi
[[ "$VPC_PRIVATE_IP" =~ ^${VPC_PREFIX//./\\.}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] \
  || fail "私网 IPv4 ${VPC_PRIVATE_IP} 不在 VPC 网段 ${VPC_CIDR} 内，拒绝继续（会导致 listen_addresses 与入站规则/安全组/防火墙不一致）。"
readonly VPC_PRIVATE_IP

CVM_HOSTNAME="$(hostname -s 2>/dev/null || echo 'unknown')"
readonly CVM_HOSTNAME

# ---------------------------------------------------------------------------
# 3. 持久存储：数据目录必须落在独立云硬盘/数据盘上
# ---------------------------------------------------------------------------
nearest_existing() {
  local p="$1"
  while [[ ! -d "$p" ]]; do
    local parent
    parent="$(dirname -- "$p")"
    [[ "$parent" == "$p" ]] && break
    p="$parent"
  done
  printf '%s' "$p"
}
PGDATA_PARENT="$(nearest_existing "$(dirname -- "$PGDATA_DIR")")"
readonly PGDATA_PARENT

read -r DATA_SRC DATA_MNT <<<"$(df -P -- "$PGDATA_PARENT" | tail -1 | awk '{print $1, $6}')"
readonly DATA_SRC DATA_MNT

log "数据目录：${PGDATA_DIR}"
log "所在文件系统：${DATA_SRC} 挂载点 ${DATA_MNT}"
if [[ "$DATA_MNT" == '/' ]]; then
  if [[ "${GENGYUN_ALLOW_ROOTFS:-0}" != '1' ]]; then
    fail "数据目录落在根分区（${DATA_MNT}）上，不满足“持久存储”要求。
         请先在控制台创建并挂载云硬盘（例如挂到 /data），或明确接受风险设置
         GENGYUN_ALLOW_ROOTFS=1（该情况下重启后数据仍在，但根分区扩容/重建会丢库）。"
  fi
  warn "已允许数据目录落在根分区（GENGYUN_ALLOW_ROOTFS=1）；这不满足持久存储验收条件。"
fi
case "$PGDATA_DIR" in
  /|/var|/usr|/etc|/tmp) fail "数据目录 ${PGDATA_DIR} 不能是 ${PGDATA_DIR}（会覆盖系统目录）。" ;;
esac

# ---------------------------------------------------------------------------
# 4. 迁移管理员口令：只从环境或私密文件读取，绝不写死、绝不打印
# ---------------------------------------------------------------------------
read_secret_from_file() {
  local key="$1" value
  [[ -r "$CRED_FILE" ]] || return 1
  local mode
  mode="$(stat -c '%a' "$CRED_FILE")"
  case "$mode" in
    *[1-7][1-7]|*[1-7][0-9]) fail "私密文件 ${CRED_FILE} 权限过宽（${mode}）：请 chmod 600。" ;;
  esac
  value="$(sed -n "s/^${key}=//p" -- "$CRED_FILE" | head -1)"
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

OWNER_PASSWORD="${GENGYUN_DB_OWNER_PASSWORD:-}"
if [[ -z "$OWNER_PASSWORD" ]]; then
  if [[ -r "$CRED_FILE" ]]; then
    OWNER_PASSWORD="$(read_secret_from_file 'GENGYUN_DB_OWNER_PASSWORD' || true)"
  fi
fi
if [[ -z "$OWNER_PASSWORD" ]]; then
  if [[ -f "${PGDATA_DIR}/PG_VERSION" ]]; then
    warn "集群已存在，且未提供 ${DB_OWNER} 口令：跳过 initdb，继续安装配置。"
  else
    fail "缺少迁移管理员口令。请任选其一：
         (a) 环境变量：export GENGYUN_DB_OWNER_PASSWORD=<48位小写十六进制>
         (b) 私密文件 ${CRED_FILE}（权限 600，root:postgres），内容一行：
             GENGYUN_DB_OWNER_PASSWORD=<48位小写十六进制>
         生成示例： openssl rand -hex 24
         口令不会写入仓库、不会打印、不会出现在 argv。"
  fi
elif [[ ! "$OWNER_PASSWORD" =~ $PW_REGEX ]]; then
  # 与 tools/local-dev/start.ps1 生成口径一致：24 随机字节 => 48 位小写十六进制
  fail "迁移管理员口令格式不符：要求 48 位小写十六进制（openssl rand -hex 24）。"
fi

if [[ "$PLAN_ONLY" -eq 0 && -n "${OWNER_PASSWORD:-}" ]]; then
  act "准备私密目录 ${PRIVATE_DIR}（0750 root:postgres）" \
    install -d -o root -g postgres -m 0750 -- "$PRIVATE_DIR"
fi

# ---------------------------------------------------------------------------
# 5. 安装 PostgreSQL 17.11（PGDG apt 仓库；不升级/降级主版本）
# ---------------------------------------------------------------------------
need_pkg_update=0
if [[ ! -f "$PGDG_KEY" ]]; then
  act "下载 PGDG 签名公钥到 ${PGDG_KEY}" \
    install -d -m 0755 -- "$(dirname -- "$PGDG_KEY")"
  act "下载 PGDG 签名公钥（https://www.postgresql.org/media/keys/ACCC4CF8.asc）" \
    curl --fail --silent --show-error --location \
      --output "$PGDG_KEY" https://www.postgresql.org/media/keys/ACCC4CF8.asc
  if [[ "$PLAN_ONLY" -eq 0 ]]; then
    [[ -s "$PGDG_KEY" ]] || fail "PGDG 公钥下载为空文件：${PGDG_KEY}。请检查网络后重跑。"
  fi
  need_pkg_update=1
fi

EXPECTED_LIST="deb [signed-by=${PGDG_KEY}] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME:-$(. /etc/os-release; echo "$VERSION_CODENAME")}-pgdg main"
readonly EXPECTED_LIST
if [[ ! -f "$PGDG_LIST" ]] || [[ "$(cat -- "$PGDG_LIST" 2>/dev/null || true)" != "$EXPECTED_LIST" ]]; then
  act "写入 ${PGDG_LIST}（apt.postgresql.org ${VERSION_CODENAME:-?}-pgdg）" \
    bash -c "printf '%s\n' \"\$1\" > \"\$2\"" _ "$EXPECTED_LIST" "$PGDG_LIST"
  need_pkg_update=1
fi

if ! dpkg -s "postgresql-${PG_MAJOR}" >/dev/null 2>&1; then
  need_pkg_update=1
fi

if [[ "$PLAN_ONLY" -eq 0 ]]; then
  export DEBIAN_FRONTEND=noninteractive
  [[ "$need_pkg_update" -eq 1 ]] && act "更新 apt 索引" apt-get update -qq
  act "安装基础依赖" apt-get install -y --no-install-recommends ca-certificates curl gnupg lsb-release
  act "刷新 apt 索引（PGDG 生效后）" apt-get update -qq
fi

# 解析 17.<PG_MINOR> 的确切包版本；找不到就明确失败，不装别的 minor。
PKG_VERSION=''
if command -v apt-cache >/dev/null 2>&1; then
  PKG_VERSION="$(apt-cache madison "postgresql-${PG_MAJOR}" 2>/dev/null \
    | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/,"",$2); print $2}' \
    | grep -E "^${PG_MAJOR}\.${PG_MINOR}([.-]|$)" | head -1 || true)"
fi
if [[ -z "$PKG_VERSION" ]]; then
  if [[ "$PLAN_ONLY" -eq 1 ]]; then
    warn "[PLAN] 当前 apt 索引中未解析到 ${PG_MAJOR}.${PG_MINOR}，实际执行时会先 apt-get update 再解析。"
  else
    fail "在 apt 仓库中找不到 postgresql-${PG_MAJOR}=${PG_MAJOR}.${PG_MINOR}。可用候选：
$(apt-cache madison "postgresql-${PG_MAJOR}" 2>/dev/null || echo '（apt 索引为空，先 apt-get update）')
         本脚本不擅自改用其它 minor；若必须改，请先与需求方确认 CI 版本口径。"
  fi
else
  log "将安装：postgresql-${PG_MAJOR}=${PKG_VERSION}（匹配 CI 的 ${PG_MAJOR}.${PG_MINOR}）"
  act "安装 PostgreSQL ${PG_MAJOR}.${PG_MINOR} 服务端与客户端（固定版本）" \
    apt-get install -y --no-install-recommends \
      "postgresql-${PG_MAJOR}=${PKG_VERSION}" "postgresql-client-${PG_MAJOR}=${PKG_VERSION}"
fi

if [[ "$PLAN_ONLY" -eq 0 ]]; then
  [[ -x "${PG_BIN}/psql" ]] || fail "未找到 ${PG_BIN}/psql，安装未成功。"
  install_major="$(sed -nE 's/^psql \(PostgreSQL\) ([0-9]+)\..*/\1/p' < <("${PG_BIN}/psql" --version))"
  install_full="$("${PG_BIN}/psql" --version | sed -nE 's/^psql \(PostgreSQL\) ([0-9]+\.[0-9]+).*/\1/p')"
  [[ "$install_major" == "$PG_MAJOR" ]] || fail "已安装 psql 主版本为 ${install_major}，要求 ${PG_MAJOR}（与 CI 一致）。"
  [[ "$install_full" == "${PG_MAJOR}.${PG_MINOR}" ]] \
    || fail "已安装 psql 为 ${install_full}，要求 ${PG_MAJOR}.${PG_MINOR}（与 CI 固定标签一致）。"
  log "已安装版本校验通过：PostgreSQL ${install_full}"
fi

# ---------------------------------------------------------------------------
# 6. 发行版自带集群与端口冲突：默认不破坏，冲突时明确失败
# ---------------------------------------------------------------------------
if command -v pg_lsclusters >/dev/null 2>&1; then
  _default_cluster_line="$(pg_lsclusters -h 2>/dev/null | awk -v v="$PG_MAJOR" '$1==v && $2=="main"{print}' || true)"
  if [[ -n "$_default_cluster_line" ]]; then
    _default_data="$(printf '%s\n' "$_default_cluster_line" | awk '{print $6}')"
    if [[ "${GENGYUN_DROP_DEFAULT_CLUSTER:-0}" == '1' ]]; then
      # 只允许删除“空集群”：PG15+ 空集群 base/ 下只有 1(template1) 4(template0) 5(postgres)。
      _base_count="$(find "${_default_data}/base" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l || echo 0)"
      if [[ "${_base_count:-0}" -gt 3 ]]; then
        fail "发行版集群 ${_default_data} 里已有 ${_base_count} 个数据库目录，不是空集群，拒绝删除。
             请人工确认后处置，或改端口：GENGYUN_PGPORT=5433 重跑。"
      fi
      act "停止并删除发行版自动创建的空集群 ${PG_MAJOR}/main（GENGYUN_DROP_DEFAULT_CLUSTER=1）" \
        pg_dropcluster --stop "$PG_MAJOR" main
    else
      if [[ "$(printf '%s\n' "$_default_cluster_line" | awk '{print $3}')" == "$PGPORT" ]]; then
        fail "发行版集群 ${PG_MAJOR}/main 已占用端口 ${PGPORT}，且本脚本默认不删除他人集群。
             二选一：
             (a) 确认该集群是本机全新自动创建且未使用，然后 GENGYUN_DROP_DEFAULT_CLUSTER=1 重跑；
             (b) 改端口：GENGYUN_PGPORT=5433 重跑（并同步安全组与 DATABASE_URL）。"
      fi
      warn "存在发行版集群 ${PG_MAJOR}/main（端口 $(printf '%s\n' "$_default_cluster_line" | awk '{print $3}')），不在 ${PGPORT}，保留不动。"
    fi
  fi
  # 该单元可能不存在（极简镜像/容器）：停用失败不应中断安装，故显式容忍。
  act "停用发行版集群启动单元 postgresql.service（若存在）" \
    bash -c 'systemctl disable --now postgresql.service >/dev/null 2>&1 || true'
fi

# ---------------------------------------------------------------------------
# 7. initdb（仅首次）：数据目录在持久盘，scrAM 口令由私密通道注入
# ---------------------------------------------------------------------------
if [[ -f "${PGDATA_DIR}/PG_VERSION" ]]; then
  log "已存在集群（${PGDATA_DIR}/PG_VERSION = $(cat -- "${PGDATA_DIR}/PG_VERSION")），跳过 initdb。"
else
  act "创建数据目录 ${PGDATA_DIR}（0700 postgres:postgres）" \
    install -d -o postgres -g postgres -m 0700 -- "$PGDATA_DIR"
  if [[ "$PLAN_ONLY" -eq 1 ]]; then
    log "[PLAN] runuser -u postgres -- ${PG_BIN}/initdb -D ${PGDATA_DIR} -U ${DB_OWNER} --auth-local=peer --auth-host=scram-sha-256 --pwfile=<私密临时文件> --encoding=UTF8 --locale=C --data-checksums"
  else
    umask 077
    privatedir_for_pw="${PRIVATE_DIR}"
    if [[ ! -d "$privatedir_for_pw" ]]; then
      install -d -o root -g postgres -m 0750 -- "$privatedir_for_pw"
    fi
    pwfile="$(mktemp -p "$privatedir_for_pw" .initdb-pw.XXXXXX)"
    trap 'rm -f -- "${pwfile:-}"' EXIT
    printf '%s\n' "$OWNER_PASSWORD" >"$pwfile"
    chown postgres:postgres -- "$pwfile"
    chmod 0600 -- "$pwfile"
    log "initdb 初始化集群（日志见下一行输出；口令经临时私密文件传递，随后立即删除）"
    runuser -u postgres -- "${PG_BIN}/initdb" \
      -D "$PGDATA_DIR" \
      -U "$DB_OWNER" \
      --auth-local=peer \
      --auth-host=scram-sha-256 \
      --pwfile="$pwfile" \
      --encoding=UTF8 \
      --locale=C \
      --data-checksums
    rm -f -- "$pwfile"
    trap - EXIT
    [[ -f "${PGDATA_DIR}/PG_VERSION" ]] || fail "initdb 未生成 PG_VERSION，初始化失败。"
    log "initdb 完成：PG_VERSION = $(cat -- "${PGDATA_DIR}/PG_VERSION")"
  fi
fi

# ---------------------------------------------------------------------------
# 8. 安装配置：conf.d 片段、pg_hba、pg_ident、include_dir
# ---------------------------------------------------------------------------
substitute() {
  local src="$1" dst="$2"
  sed \
    -e "s|@PGDATA@|${PGDATA_DIR}|g" \
    -e "s|@PGPORT@|${PGPORT}|g" \
    -e "s|@VPC_PRIVATE_IP@|${VPC_PRIVATE_IP}|g" \
    -e "s|@CVM_HOSTNAME@|${CVM_HOSTNAME}|g" \
    -e "s|@DB_NAME@|${DB_NAME}|g" \
    -- "$src" >"$dst"
  chown postgres:postgres -- "$dst"
  chmod 0640 -- "$dst"
}

for f in 10-gengyun-postgres.conf pg_hba.gengyun.conf pg_ident.gengyun.conf; do
  [[ -r "${CONF_DIR}/${f}" ]] || fail "缺少配置模板 ${CONF_DIR}/${f}（工作区不完整）。"
done

if [[ "$PLAN_ONLY" -eq 1 ]]; then
  log "[PLAN] 安装 ${PGDATA_DIR}/conf.d/10-gengyun.conf（listen_addresses=127.0.0.1,${VPC_PRIVATE_IP} port=${PGPORT}）"
  log "[PLAN] 安装 ${PGDATA_DIR}/pg_hba.conf（仅回环 + ${VPC_CIDR}，无 0.0.0.0/0）"
  log "[PLAN] 安装 ${PGDATA_DIR}/pg_ident.conf（postgres -> ${DB_OWNER}）"
  log "[PLAN] 在 ${PGDATA_DIR}/postgresql.conf 追加 include_dir = 'conf.d'（幂等）"
else
  act "创建 ${PGDATA_DIR}/conf.d" install -d -o postgres -g postgres -m 0700 -- "${PGDATA_DIR}/conf.d"
  log "安装 ${PGDATA_DIR}/conf.d/10-gengyun-postgres.conf"
  substitute "${CONF_DIR}/10-gengyun-postgres.conf" "${PGDATA_DIR}/conf.d/10-gengyun.conf"
  log "安装 ${PGDATA_DIR}/pg_hba.conf"
  substitute "${CONF_DIR}/pg_hba.gengyun.conf" "${PGDATA_DIR}/pg_hba.conf"
  log "安装 ${PGDATA_DIR}/pg_ident.conf"
  substitute "${CONF_DIR}/pg_ident.gengyun.conf" "${PGDATA_DIR}/pg_ident.conf"

  if grep -qE '^[[:space:]]*include_dir[[:space:]]*=' -- "${PGDATA_DIR}/postgresql.conf"; then
    current_include="$(grep -E '^[[:space:]]*include_dir[[:space:]]*=' -- "${PGDATA_DIR}/postgresql.conf" | tail -1)"
    case "$current_include" in
      *"'conf.d'"*|*'"conf.d"'*) log "include_dir 已存在且指向 conf.d，跳过。" ;;
      *) fail "${PGDATA_DIR}/postgresql.conf 已有其它 include_dir 设置：${current_include}
             拒绝覆盖既有配置，请人工确认后再运行。" ;;
    esac
  else
    log "追加 include_dir = 'conf.d' 到 ${PGDATA_DIR}/postgresql.conf（一次性，幂等）"
    {
      printf '\n# --- 耕云 deploy/postgres-cvm 管理，请勿手工修改 ---\n'
      printf "include_dir = 'conf.d'\n"
    } >>"${PGDATA_DIR}/postgresql.conf"
    chown postgres:postgres -- "${PGDATA_DIR}/postgresql.conf"
  fi
fi

# ---------------------------------------------------------------------------
# 9. systemd 单元
# ---------------------------------------------------------------------------
if [[ "$PLAN_ONLY" -eq 1 ]]; then
  log "[PLAN] 安装 ${UNIT_PATH}（User=postgres, ExecStart=${PG_BIN}/postgres -D ${PGDATA_DIR}）"
  log "[PLAN] systemctl daemon-reload && systemctl enable ${UNIT_NAME}"
else
  unit_tmp="$(mktemp)"
  trap 'rm -f -- "${unit_tmp:-}"' EXIT
  sed -e "s|@PGDATA@|${PGDATA_DIR}|g" -e "s|@PG_BIN@|${PG_BIN}|g" \
    -- "${CONF_DIR}/gengyun-postgresql.service" >"$unit_tmp"
  log "安装 ${UNIT_PATH}"
  install -o root -g root -m 0644 -- "$unit_tmp" "$UNIT_PATH"
  rm -f -- "$unit_tmp"
  trap - EXIT
  act "重载 systemd 并启用 ${UNIT_NAME}" bash -c "systemctl daemon-reload && systemctl enable '${UNIT_NAME}'"
fi

# ---------------------------------------------------------------------------
# 10. 启动、建库
# ---------------------------------------------------------------------------
if [[ "$PLAN_ONLY" -eq 1 ]]; then
  log "[PLAN] systemctl restart ${UNIT_NAME} 并等待 pg_isready"
  log "[PLAN] createdb -O ${DB_OWNER} ${DB_NAME}（若不存在）"
else
  act "启动 ${UNIT_NAME}" systemctl restart "$UNIT_NAME"

  ready=0
  for _ in $(seq 1 30); do
    if runuser -u postgres -- "${PG_BIN}/pg_isready" -h /var/run/postgresql -q; then ready=1; break; fi
    sleep 1
  done
  [[ "$ready" -eq 1 ]] || fail "${UNIT_NAME} 启动后 30 秒内未就绪。请查看：
         journalctl -u ${UNIT_NAME} -n 100
         ${PGDATA_DIR}/log/"

  if runuser -u postgres -- "${PG_BIN}/psql" -h /var/run/postgresql -U "$DB_OWNER" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
    log "业务库 ${DB_NAME} 已存在，跳过创建。"
  else
    log "创建业务库 ${DB_NAME}（owner=${DB_OWNER}）"
    runuser -u postgres -- "${PG_BIN}/createdb" -h /var/run/postgresql -U "$DB_OWNER" \
      -O "$DB_OWNER" -E UTF8 "$DB_NAME"
  fi
fi

# ---------------------------------------------------------------------------
# 11. 网络姿态自检：监听地址不得出现 0.0.0.0 / :: / *
# ---------------------------------------------------------------------------
if [[ "$PLAN_ONLY" -eq 0 ]]; then
  listen_dump="$(ss -ltnH "sport = :${PGPORT}" 2>/dev/null || true)"
  if [[ -z "$listen_dump" ]]; then
    fail "未看到端口 ${PGPORT} 的监听记录（ss 输出为空），服务可能未真正启动。"
  fi
  log "端口 ${PGPORT} 监听表："
  printf '%s\n' "$listen_dump" | awk '{print "         " $4}'
  if printf '%s\n' "$listen_dump" | awk '{print $4}' | grep -qE '^(0\.0\.0\.0|\*|\[::\]):'; then
    fail "检测到端口 ${PGPORT} 监听在通配地址上，违反“仅内网可达”。
         请检查 ${PGDATA_DIR}/conf.d/10-gengyun.conf 的 listen_addresses。"
  fi
  if ! printf '%s\n' "$listen_dump" | awk '{print $4}' | grep -q "^${VPC_PRIVATE_IP}:"; then
    fail "未检测到 ${VPC_PRIVATE_IP}:${PGPORT} 监听；同 VPC 内的消费者将无法连接。"
  fi
  printf '[%s] 网络姿态自检通过：仅回环与 VPC 私网 IPv4 在监听 %s。\n' "$SCRIPT_NAME" "$PGPORT"
  runuser -u postgres -- "${PG_BIN}/psql" -h /var/run/postgresql -U "$DB_OWNER" -d "$DB_NAME" -tAc \
    "SELECT 'server_version=' || current_setting('server_version') ||
            ' listen_addresses=' || current_setting('listen_addresses') ||
            ' port=' || current_setting('port')" \
    | awk '{print "         " $0}'
fi

# ---------------------------------------------------------------------------
# 12. 结束语
# ---------------------------------------------------------------------------
cat <<EOF

[${SCRIPT_NAME}] 完成（PLAN_ONLY=${PLAN_ONLY}）。
  版本      : PostgreSQL ${PG_MAJOR}.${PG_MINOR}（与 CI postgres:17.11 同主版本）
  数据目录  : ${PGDATA_DIR}（文件系统 ${DATA_SRC} 挂载点 ${DATA_MNT}）
  业务库    : ${DB_NAME}（owner=${DB_OWNER}）
  监听      : 127.0.0.1,${VPC_PRIVATE_IP}:${PGPORT}
  私密目录  : ${PRIVATE_DIR}（仅 root/postgres 可读）

尚未完成（本脚本不做，顺序不可颠倒）：
  1) 迁移：以 ${DB_OWNER} 执行 services/api/src/db/migrate.ts up（见 roles-and-migration.md）
  2) 角色引导：迁移完成后再跑 ./provision-db.sh
  3) 入站规则核对：**标准 CVM 看安全组／轻量应用服务器(Lighthouse) 看实例防火墙**——
     确认 5432 只对 ${VPC_CIDR} 放行（脚本无云凭据，无法核对）
  4) 持久性验证与验收：见 verify-checklist.md（含重启后核对）

持久存储自证（重启后执行，两次输出必须一致）：
  sudo systemctl restart ${UNIT_NAME}
  df -P -- ${PGDATA_DIR} | tail -1
  sudo -u postgres ${PG_BIN}/psql -h /var/run/postgresql -U ${DB_OWNER} -d ${DB_NAME} -tAc "SELECT pg_postmaster_start_time()"
EOF
