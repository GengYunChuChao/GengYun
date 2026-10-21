#!/usr/bin/env bash
# ============================================================================
# 耕云 · CVM PostgreSQL 17：逻辑备份（pg_dump -Fc）+ 保留期 + 产出清单
#
# 状态：技术准备物。**未部署、未验收、未在任何真实 CVM/PG 实例上执行过。**
#       本脚本没有产出过任何真实备份；"脚本存在"不等于"已有可恢复备份"。
#
# 备份方式取舍（二选一，本交付选逻辑备份）：
#   * 逻辑 pg_dump -Fc（本脚本）
#       优点：可单库/单表选择性恢复、跨 PG minor 可用、产出可校验（pg_restore --list）、
#             不需要归档目录与 WAL 权限，运维简单。
#       缺点：只到备份时刻的某个一致快照；无 PITR，RPO = 备份周期；大库耗时长；
#             不含角色/口令（本交付刻意不导 globals，理由见 roles-and-migration.md 第 5 节）。
#   * 物理 pg_basebackup（+ WAL 归档，未实现）
#       优点：可 PITR（RPO 接近 0）、恢复整簇一致。
#       缺点：需持续 WAL 归档存储、恢复要求同 PG 主版本同平台、占用空间大、
#             必须在另一台主机/对象存储留副本；本阶段无对象存储与额度授权，故不实现。
#   若后续要求 PITR，需要单独授权归档存储并以新的验收口径重做，不能沿用本页结论。
#
# 定时与保留期建议（本脚本只提供“执行一次”的能力，不自行安装定时任务）：
#   每日 03:17 执行，保留 30 天（与需求里“备份 30 日”窗口取值一致）：
#     17 3 * * * /opt/gengyun/deploy/postgres-cvm/backup-postgres.sh >> /var/log/gengyun-backup.log 2>&1
#   注意：保留 30 天只是“备份文件保留期”。需求中的“注销后备份 30 日内清理个人数据”
#   是逐用户删除语义，本脚本**没有**实现，仍属未交付项（见 roles-and-migration.md 第 5 节）。
#
# 用法：
#   sudo ./backup-postgres.sh                 # 执行一次备份
#   sudo ./backup-postgres.sh --list          # 只列出已有备份与清单
#   sudo ./backup-postgres.sh --dry-retention # 只打印会被清理的旧备份
#
# 环境变量：
#   GENGYUN_BACKUP_DIR   备份目录，默认 /data/gengyun/backup（必须在持久存储上）
#   GENGYUN_BACKUP_KEEP_DAYS  保留天数，默认 30
#   GENGYUN_DB_NAME      业务库名，默认 gengyun
#
# 【退出码语义（自动化请按这个判读；返修 12 已修掉历史上的"假失败"）】
#   0 = **本次备份已产出 dump 且通过可读性校验**（`pg_restore --list` 能列出目录）+ 清单已写；
#   1 = 备份过程失败（pg_dump 报错/产出为空、pg_restore --list 读不了、集群未就绪、缺 pg_dump 等）；
#   2 = 无（本脚本不产生 2）。
#   ⚠️ **exit 0 ≠ "备份已被证明可恢复"**：可恢复性**只能**由 `restore-drill.sh` 在隔离库上真正
#      恢复并逐项比对清单来证明。未做演练时，禁止声称"已备份可恢复"。
#      历史上（返修 12 之前）成功路径会因 EXIT trap 的 `[[ … ]] && cmd` 短路而**误报 exit 1** —— 已修。
# ============================================================================

set -euo pipefail
set +x

readonly SCRIPT_NAME='backup-postgres.sh'
readonly PG_MAJOR='17'
readonly PG_BIN="/usr/lib/postgresql/${PG_MAJOR}/bin"
readonly PGHOST_SOCKET='/var/run/postgresql'
readonly DB_OWNER='gengyun_cvm_owner'
readonly FILE_PREFIX='gengyun-'

DB_NAME="${GENGYUN_DB_NAME:-gengyun}"
BACKUP_DIR="${GENGYUN_BACKUP_DIR:-/data/gengyun/backup}"
KEEP_DAYS="${GENGYUN_BACKUP_KEEP_DAYS:-30}"

ACTION='backup'

# 清单里记录的关键表：恢复后必须逐表行数一致（缺失也记录为 MISSING 并须一致）
KEY_TABLES=(
  'public.users'
  'public.sessions'
  'public.admin_accounts'
  'public.admin_sessions'
  'public.idempotency_keys'
  'public.consent_records'
  'public.privacy_epochs'
  'public.crops'
  'public.regions'
  'public.single_profiles'
  'public.sources'
  'public.source_versions'
  'public.knowledge_versions'
  'catalog_ops.operations'
  'staging_intake.batches'
  'staging_intake.operations'
  'knowledge_staging.workbook_batches'
  'knowledge_staging.workbook_rows'
)

log()  { printf '[%s] %s\n' "$SCRIPT_NAME" "$*"; }
warn() { printf '[%s][WARN] %s\n' "$SCRIPT_NAME" "$*" >&2; }
fail() { printf '[%s][ERROR] %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: sudo ./backup-postgres.sh [--list | --dry-retention]

  （无参数）       立即执行一次逻辑备份（pg_dump -Fc）并清理超过保留期的旧备份
  --list           只列出已有备份及其 sha256 清单，不做任何改动
  --dry-retention  只打印会被保留期清理的旧备份，不删除
  --help           显示本帮助

环境变量：
  GENGYUN_BACKUP_DIR        备份目录，默认 /data/gengyun/backup（应在持久存储上）
  GENGYUN_BACKUP_KEEP_DAYS  保留天数，默认 30
  GENGYUN_DB_NAME           业务库名，默认 gengyun

注意：本脚本不安装定时任务；建议 cron 与保留期见文件头部注释与 runbook.md。
EOF
}

for arg in "$@"; do
  case "$arg" in
    --list) ACTION='list' ;;
    --dry-retention) ACTION='dry-retention' ;;
    --help|-h) usage; exit 0 ;;
    *) fail "未知参数：${arg}（支持 --list / --dry-retention / --help）" ;;
  esac
done

[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || fail "GENGYUN_BACKUP_KEEP_DAYS 必须是整数，当前：${KEEP_DAYS}"

# ---------------------------------------------------------------------------
# 只列出已有备份
# ---------------------------------------------------------------------------
if [[ "$ACTION" == 'list' ]]; then
  [[ -d "$BACKUP_DIR" ]] || fail "备份目录不存在：${BACKUP_DIR}"
  log "备份目录 ${BACKUP_DIR}（保留 ${KEEP_DAYS} 天）"
  # 只匹配本脚本自己的命名，不触碰目录内其它文件
  found=0
  while IFS= read -r -d '' f; do
    found=1
    printf '  %s  %10s bytes  %s\n' "$(basename -- "$f")" "$(stat -c '%s' -- "$f")" \
      "$(stat -c '%y' -- "$f")"
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${FILE_PREFIX}*.dump" -print0 | sort -z)
  [[ "$found" -eq 1 ]] || warn "目录内没有任何 ${FILE_PREFIX}*.dump（说明还没有成功备份）。"
  exit 0
fi

[[ "${EUID}" -eq 0 ]] || fail "需要 root：脚本要降到系统用户 postgres 走 Unix socket。"
[[ -x "${PG_BIN}/pg_dump" ]] || fail "未找到 ${PG_BIN}/pg_dump：请先运行 install-postgres.sh。"
command -v sha256sum >/dev/null 2>&1 || fail "缺少 sha256sum（coreutils）。"

qs() { runuser -u postgres -- "${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 \
         -h "$PGHOST_SOCKET" -U "$DB_OWNER" -d "$DB_NAME" -tA -c "$1" | tr -d '\r'; }

# ---------------------------------------------------------------------------
# 旧备份清理（先算，后删；只删本脚本命名规则的 dump 及其清单）
# ---------------------------------------------------------------------------
list_old_backups() {
  [[ -d "$BACKUP_DIR" ]] || return 0
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "${FILE_PREFIX}*.dump" -mtime "+${KEEP_DAYS}" -print
}

if [[ "$ACTION" == 'dry-retention' ]]; then
  log "[DRY-RUN] 保留 ${KEEP_DAYS} 天，将被清理的文件（不会真的删除）："
  list_old_backups | sed 's/^/  /'
  exit 0
fi

# ---------------------------------------------------------------------------
# 正式备份
# ---------------------------------------------------------------------------
runuser -u postgres -- "${PG_BIN}/pg_isready" -h "$PGHOST_SOCKET" -q \
  || fail "集群未就绪（socket ${PGHOST_SOCKET}）。"

# 备份目录必须在持久存储上：与 install-postgres.sh 同一判定口径
BACKUP_PARENT="$(dirname -- "$BACKUP_DIR")"
while [[ ! -d "$BACKUP_PARENT" && "$BACKUP_PARENT" != '/' ]]; do BACKUP_PARENT="$(dirname -- "$BACKUP_PARENT")"; done
read -r BS_SRC BS_MNT <<<"$(df -P -- "$BACKUP_PARENT" | tail -1 | awk '{print $1, $6}')"
if [[ "$BS_MNT" == '/' ]]; then
  warn "备份目录将落在根分区（${BS_MNT}）；云硬盘应承载备份，请确认这不是误配。"
fi
install -d -o postgres -g postgres -m 0700 -- "$BACKUP_DIR"

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
DUMP="${BACKUP_DIR}/${FILE_PREFIX}${DB_NAME}-${STAMP}.dump"
MANIFEST="${DUMP}.manifest.txt"
TMP_DUMP="${DUMP}.partial"

# 【返修 12 · 缺陷 8】EXIT trap 的末命令**不能是 `[[ … ]] && cmd`**：
#   `[[ -f "$TMP_DUMP" ]]` 在**成功路径**上为假（partial 已被 mv 成正式 dump）⇒ `&&` 短路
#   ⇒ 函数返回 1 ⇒ **bash 用 EXIT trap 的退出码覆盖脚本退出码** ⇒
#   "备份已成功产出 dump 且通过可读性校验，脚本却 exit=1"（真机实测，evidence §11.1）。
#   这正是早前"假成功"的镜像问题：**假失败**。改为 if + 显式 return 0。
cleanup_partial() { if [[ -f "$TMP_DUMP" ]]; then rm -f -- "$TMP_DUMP"; fi; return 0; }
trap cleanup_partial EXIT

log "开始备份：$(qs 'SELECT current_database()') → ${DUMP}"
log "服务端版本：$(qs 'SHOW server_version')，pg_dump：$("${PG_BIN}/pg_dump" --version)"

# -Fc 自定义格式；--lock-wait-timeout 避免被长事务卡死；不用 --no-owner/--no-acl，
# 以便恢复时保留属主与授权（恢复目标必须先有同名角色，见 restore-drill.sh）。
umask 077
runuser -u postgres -- "${PG_BIN}/pg_dump" \
  -h "$PGHOST_SOCKET" -U "$DB_OWNER" -d "$DB_NAME" \
  -Fc -Z 6 --lock-wait-timeout=60s \
  -f "$TMP_DUMP"

[[ -s "$TMP_DUMP" ]] || fail "pg_dump 产出为空文件，视为失败：${TMP_DUMP}"
mv -f -- "$TMP_DUMP" "$DUMP"
chmod 0600 -- "$DUMP"

# 产出可读性校验 + TOC 条目计数：**一次** --list，退出码与计数都取自同一次调用。
# R28-S44（B 类返修）：原来第二次 `--list | grep -c ';' || true` 失败会产出 "0"，把「读不出 TOC」
#   写成 restore_toc_entries=0 落进清单（假数据）；现在读取失败直接 fail，不落任何假计数。
_toc_rc=0
_toc_list="$(runuser -u postgres -- "${PG_BIN}/pg_restore" --list "$DUMP" 2>/dev/null)" || _toc_rc=$?
if [[ "$_toc_rc" -ne 0 ]]; then
  fail "pg_restore --list 无法读取 ${DUMP}（rc=${_toc_rc}）：备份文件不可用，请勿据此声称已备份。"
fi
# 用 awk 计数：`grep -c ';'` 在 0 匹配时 rc=1，会与「读失败」混在一起。
TOCOBJ="$(printf '%s\n' "$_toc_list" | awk '/;/{n++} END{print n+0}')"

# 清单：恢复判定的唯一依据
{
  printf 'format=pg_dump-custom-v1\n'
  printf 'backup_utc=%s\n' "$STAMP"
  printf 'database=%s\n' "$DB_NAME"
  printf 'server_version=%s\n' "$(qs 'SHOW server_version')"
  printf 'pg_dump_version=%s\n' "$("${PG_BIN}/pg_dump" --version | awk '{print $NF}')"
  printf 'data_filesystem=%s\n' "${BS_SRC}"
  printf 'data_mountpoint=%s\n' "${BS_MNT}"
  printf 'restore_toc_entries=%s\n' "$TOCOBJ"
  printf 'dump_bytes=%s\n' "$(stat -c '%s' -- "$DUMP")"
  printf 'dump_sha256=%s\n' "$(sha256sum -- "$DUMP" | awk '{print $1}')"
  printf 'migration_versions=%s\n' "$(qs "SELECT COALESCE(string_agg(version, ',' ORDER BY version), '') FROM schema_migrations")"
  printf 'base_table_count=%s\n' "$(qs "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE'")"
  printf 'view_count=%s\n' "$(qs "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'VIEW'")"
  for t in "${KEY_TABLES[@]}"; do
    if [[ "$(qs "SELECT to_regclass('${t}') IS NOT NULL")" == 't' ]]; then
      printf 'rows:%s=%s\n' "$t" "$(qs "SELECT count(*) FROM ${t}")"
    else
      printf 'rows:%s=MISSING\n' "$t"
    fi
  done
} >"$MANIFEST"
chmod 0600 -- "$MANIFEST"

log "备份完成并通过可读性校验："
log "  文件      : ${DUMP}"
log "  大小      : $(stat -c '%s' -- "$DUMP") bytes"
log "  sha256    : $(grep '^dump_sha256=' -- "$MANIFEST" | cut -d= -f2)"
log "  TOC 条目  : ${TOCOBJ}"
log "  清单      : ${MANIFEST}"
log "  迁移版本  : $(grep '^migration_versions=' -- "$MANIFEST" | cut -d= -f2)"

# 保留期清理
# 失败方向：枚举失败即空 ⇒ 本轮不删任何文件（安全）；代价是日志会说「没有需要清理的」，
#   保留期静默未执行需人工核对（见证据页 §6 已知残留）。
# best-effort: list_old_backups 的失败只影响「删旧备份」这个附加动作，不参与任何 PASS/FAIL 判定。
old="$(list_old_backups || true)"
if [[ -n "$old" ]]; then
  log "清理超过 ${KEEP_DAYS} 天的旧备份："
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    log "  删除 $(basename -- "$f")"
    rm -f -- "$f" "${f}.manifest.txt"
  done <<<"$old"
else
  log "没有超过 ${KEEP_DAYS} 天的旧备份需要清理。"
fi

cat <<EOF

[${SCRIPT_NAME}] 说明：
  * 这只是“执行了一次备份”。是否满足恢复要求，必须由 restore-drill.sh 在隔离库上
    真正恢复并用清单逐项比对后才算有证据；未做演练时不得声称已备份可恢复。
  * 本备份不含角色与口令（刻意不导 globals）：灾难恢复到全新集群时，
    角色与最小权限需要先由 provision-db.sh 重建，API 的 DATABASE_URL 口令
    需从私密通道重新注入。
  * 需求中的“注销后 30 日内清理备份内个人数据”是逐用户删除语义，本脚本未实现。
EOF
