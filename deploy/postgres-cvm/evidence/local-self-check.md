# 本地自检原始输出（2026-10-13）

> 本页记录**真正执行过什么、得到什么输出、以及为什么有些事做不了**。
> 结论先说：**没有任何 PostgreSQL 被安装、没有被连接、SQL 文件没有被任何 psql 解析过、
> 没有产生任何备份、没有做过任何恢复演练。** 本单交付的是"可直接执行的技术准备物"，
> **不是已部署、不是已验收**。

关联：`Refs #27`（GY-I25）。基线 `upstream/main` = `b1f6ab0e4dc304d2dd621d6a20852b31ccbfab3e`。
（更正记录：任务最初提到的编号 `#25` 经用户线上核实并非 GY-I25；**GY-I25 = issue #27**，
本交付统一用 `Refs #27`。此前若在别处写过 `#25`，以本页为准。）

## 1 执行环境事实（为什么无法做运行验证）

```text
$ bash --version | head -1
GNU bash, version 5.3.9(1)-release (x86_64-pc-linux-gnu)

$ uname -srm
Linux 6.18.33.2-microsoft-standard-WSL2 x86_64

$ for c in psql pg_dump pg_ctl initdb postgres docker shellcheck; do printf '%-12s : ' "$c"; command -v "$c" || echo MISSING; done
psql         : MISSING
pg_dump      : MISSING
pg_ctl       : MISSING
initdb       : MISSING
postgres     : MISSING
docker       : MISSING
shellcheck   : MISSING

$ ls -d /usr/lib/postgresql
ls: cannot access '/usr/lib/postgresql': No such file or directory

# Windows 侧同样没有（Get-Command / Get-Service / 端口探测）
psql MISSING, pg_dump MISSING, pg_ctl MISSING, initdb MISSING, docker MISSING
Get-Service *postgres*  -> 无
127.0.0.1:5432 是否监听 -> False
```

**结论**：本机（Windows + WSL Ubuntu）**没有任何 PostgreSQL 服务端/客户端，也没有 Docker**。
因此凡是要连库、解析 SQL、跑 `initdb`/`pg_dump`/`pg_restore` 的验证**一律无法执行**，
本页只提供"确实可做的静态/失败路径检查"。

### 1.1 云侧事实的来源与证据边界（本单写手**零云调用**）

本交付引用的云侧事实（VPC 存在与唯一、子网 `ap-shanghai-1` 可用 IP 253、
`DescribeInstances @ap-shanghai` = 0 台 CVM、`DescribeSecurityGroups` = 0 个、
`tcb DescribeEnvs`（上海/广州）= 0 个环境）**不是本单写手取得的**：

- 它们由**另一位写手**用 `E:\GengYunPrivate` 的私密凭据做**只读**调用得到，经指挥转述；
- **本单写手没有接触 `E:\GengYunPrivate`、没有使用任何凭据、没有发起任何腾讯云 API 调用**；
- 本仓库、本目录、提交信息与 PR 正文中**不含任何凭据值、不含任何原始返回报文**；
- 这属于**二手证据**（转述而非我复现），因此在本页按"**未由本单复现**"处理；
  其中"云托管环境绑定账号与本凭据账号是否一致"官方口径不明确，结论是**推断**，
  必须由用户到控制台比对绑定账号后才能定论（见 [README.md](../README.md) 第 0 节）。

## 2 已做且通过的自检（可复现）

下列命令均可直接重跑；本页保留原始输出。

### A) `bash -n` 语法检查（5 个脚本全部通过）

```console
$ cd deploy/postgres-cvm && for f in *.sh; do printf '=== bash -n %s: ' "$f"; bash -n "$f" && echo OK || echo FAIL; done
=== bash -n backup-postgres.sh: OK
=== bash -n install-postgres.sh: OK
=== bash -n provision-db.sh: OK
=== bash -n restore-drill.sh: OK
=== bash -n verify-cvm-postgres.sh: OK
```

（`bash -n` 只证明"能被 bash 解析成合法脚本"，**不证明逻辑正确、不证明能与 PostgreSQL 配合**。）

### B) 每个脚本都必须有 `set -euo pipefail`

```console
$ for f in deploy/postgres-cvm/*.sh; do printf '  %-26s : ' "$(basename "$f")"; grep -c '^set -euo pipefail$' "$f"; done
  backup-postgres.sh         : 1
  install-postgres.sh        : 1
  provision-db.sh            : 1
  restore-drill.sh           : 1
  verify-cvm-postgres.sh     : 1
```

### C) 行尾必须是 LF（跨平台脚本不能带 CRLF）

```console
$ for f in deploy/postgres-cvm/**/*.{sh,sql,conf} deploy/postgres-cvm/*.sh; do ... 统计 CRLF 字节数 ... done
backup-postgres.sh                CRLF=0
install-postgres.sh               CRLF=0
provision-db.sh                   CRLF=0
restore-drill.sh                  CRLF=0
verify-cvm-postgres.sh            CRLF=0
conf/10-gengyun-postgres.conf     CRLF=0
conf/gengyun-postgresql.service   CRLF=0
conf/pg_hba.gengyun.conf          CRLF=0
conf/pg_ident.gengyun.conf        CRLF=0
sql/20-login-roles.sql            CRLF=0
sql/90-assert-least-privilege.sql CRLF=0
```

### D) `--help` 路径真的能跑通（exit 0）

```console
$ for f in install-postgres.sh provision-db.sh backup-postgres.sh restore-drill.sh verify-cvm-postgres.sh; do
    bash deploy/postgres-cvm/$f --help >/dev/null 2>&1; echo "$f exit=$?"; done
install-postgres.sh        exit=0
provision-db.sh            exit=0
backup-postgres.sh         exit=0
restore-drill.sh           exit=0
verify-cvm-postgres.sh     exit=0
```

并且修复后确认 `--help` 输出里**不再混入代码行**：

```console
$ # 检查 help 输出中是否出现 set/readonly/usage()/while/for/if/case 等代码行
--- install-postgres.sh   OK: 无代码行
--- provision-db.sh       OK: 无代码行
--- backup-postgres.sh    OK: 无代码行
--- restore-drill.sh      OK: 无代码行
--- verify-cvm-postgres.sh OK: 无代码行
```

### E) 失败路径真的会失败（不是装饰）

```console
# 非 root：install/provision/restore 都应先拒绝
$ bash deploy/postgres-cvm/install-postgres.sh --plan
[install-postgres.sh][ERROR] 需要 root：请用 sudo 运行（安装包与写 /etc 需要 root）。
exit=1
$ bash deploy/postgres-cvm/provision-db.sh --plan
[provision-db.sh][ERROR] 需要 root：脚本要降到系统用户 postgres 走 Unix socket。
exit=1
$ bash deploy/postgres-cvm/restore-drill.sh
[restore-drill.sh][ERROR] 需要 root：脚本要降到系统用户 postgres 走 Unix socket。
exit=1

# root 下的 --plan：会走到真正的检测逻辑并明确失败
$ wsl -u root -- bash deploy/postgres-cvm/install-postgres.sh --plan
[install-postgres.sh][WARN] 发行版 ubuntu 26.04 不在 PGDG apt 已验证列表 (ubuntu 22.04/24.04, debian 12) 内，继续但请人工确认仓库可用。
[install-postgres.sh][ERROR] 在 VPC 网段 10.20.0.0/16 内找到 0 个私网 IPv4（期望正好 1 个）：
         候选：（无）
         请确认该 CVM 已加入 gengyun-vpc(vpc-h33f1h5a)，或显式设置 GENGYUN_VPC_PRIVATE_IP。
exit=1

$ wsl -u root -- bash deploy/postgres-cvm/provision-db.sh --plan
[provision-db.sh][ERROR] 未找到 /usr/lib/postgresql/17/bin/psql：请先运行 install-postgres.sh。
exit=1

$ wsl -u root -- bash deploy/postgres-cvm/verify-cvm-postgres.sh
[verify-cvm-postgres.sh][ERROR] 未找到 /usr/lib/postgresql/17/bin/psql：请先执行 install-postgres.sh。
exit=1

# 本机没有备份目录（模拟"还没备份"的真实状态）
$ bash deploy/postgres-cvm/backup-postgres.sh --list
[backup-postgres.sh][ERROR] 备份目录不存在：/data/gengyun/backup
exit=1

# 未知参数必须被拒绝
$ for f in install-postgres.sh provision-db.sh backup-postgres.sh restore-drill.sh verify-cvm-postgres.sh; do
    bash deploy/postgres-cvm/$f --definitely-not-a-flag; done
[install-postgres.sh][ERROR] 未知参数：--definitely-not-a-flag（支持 --plan / --help）
[provision-db.sh][ERROR] 未知参数：--definitely-not-a-flag（支持 --plan / --with-cli-groups / --help）
[backup-postgres.sh][ERROR] 未知参数：--definitely-not-a-flag（支持 --list / --dry-retention / --help）
[restore-drill.sh][ERROR] 未知参数：--definitely-not-a-flag
[verify-cvm-postgres.sh][ERROR] 未知参数：--definitely-not-a-flag
```

`install-postgres.sh --plan` 的输出还顺带证明了**发行版白名单的告警分支真的会触发**
（本机是 ubuntu 26.04，落在 22.04/24.04/12 白名单外），以及**VPC 网段判定不是摆设**
（本机私网是 `172.x`，脚本拒绝继续）。

### F) PLAN / `--help` 没有产生任何文件改动

```console
$ ls -la /etc/gengyun 2>/dev/null || echo "  /etc/gengyun 不存在"
  /etc/gengyun 不存在（符合预期：PLAN 未写任何东西）
$ ls -la /data/gengyun 2>/dev/null || echo "  /data/gengyun 不存在"
  /data/gengyun 不存在（符合预期）
$ ls -d /etc/systemd/system/gengyun-postgresql.service 2>/dev/null || echo "  unit 未安装"
  unit 未安装（符合预期）
```

### G) 密钥/禁用 TLS 模式静态扫描（对齐仓库 `npm run lint` 的禁止项）

```console
$ # 在 deploy/postgres-cvm 下逐个正则扫描
clean: strict-ssl\s*=\s*false
clean: NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0
clean: rejectUnauthorized\s*:\s*false
clean: BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY
clean: sk-[A-Za-z0-9]{20,}
clean: AKIA[0-9A-Z]{16}

$ # 疑似 48 位十六进制口令字面量
（0 命中）
$ # 是否存在 .env 文件
（0 命中）
```

### H) 角色名与既有 `services/api/db/roles/*.sql` 的一致性（交叉核对）

只统计**真正用于角色 DDL/DCL** 的标识（`CREATE ROLE` / `GRANT … TO` / `pg_has_role(...)`）：

```console
  NEW(本交付声明新增)   gengyun_api_runtime
  OK(既有角色文件创建)  gengyun_auth_privacy
  OK(既有角色文件创建)  gengyun_consent_granter
  OK(既有角色文件创建)  gengyun_knowledge_runtime
  OK(既有角色文件创建)  gengyun_preview_reader
  OK(既有角色文件创建)  gengyun_profile_runtime
DANGLING 计数 = 0
```

即：**没有自造角色**。既有 `roles/*.sql` 共创建 10 个组
（`gengyun_auth_privacy`、`gengyun_preview_reader`、`gengyun_evidence_reader`、`gengyun_consent_granter`、
`gengyun_profile_runtime`、`gengyun_knowledge_runtime`、`gengyun_source_executor`、`gengyun_source_operator`、
`gengyun_staging_executor`、`gengyun_staging_importer`）；本交付在 SQL 里只新增
`gengyun_api_runtime` 这**一个** LOGIN（`gengyun_cvm_owner` 由 `initdb -U` 创建，不由 SQL 创建）。

`provision-db.sh` 的组列表与文件名逐一对应（前 5 个默认执行，后 2 个仅 `--with-cli-groups`）：

```console
  'gengyun_auth_privacy:auth_privacy.sql'
  'gengyun_preview_reader:catalog_readers.sql'
  'gengyun_consent_granter:consent_granter.sql'
  'gengyun_profile_runtime:profile_runtime.sql'
  'gengyun_knowledge_runtime:knowledge_runtime.sql'
  'gengyun_source_operator:source_operator.sql'
  'gengyun_staging_importer:staging_importer.sql'
```

### I) 断言 SQL 引用的表/视图都在迁移里存在

```console
$ # 交叉核对 90-assert-least-privilege.sql 里出现的每个关系名
  OK  catalog_read.current_knowledge
  OK  catalog_read.home_species
  OK  public.admin_accounts
  OK  public.admin_scopes
  OK  public.idempotency_keys
  OK  public.sessions
  OK  public.users
```

### J) SQL 静态结构检查

```console
  20-login-roles.sql: 单引号=36(偶数=True) if=5 endif=5(匹配=True) 双dollar=0 gset=4 gexec=2
  90-assert-least-privilege.sql: 单引号=306(偶数=True) if=0 endif=0(匹配=True) 双dollar=0 gset=0 gexec=0
```

`双dollar=0` 是刻意设计：psql **不会**在 dollar-quoted 字符串里做变量替换，
所以本交付完全避开 `DO $$ … $$`，改用 `\gexec` + `format(%I/%L)`，
避免"变量没被替换却看起来像成功"的经典坑。

`90-assert-least-privilege.sql` 的 15 条断言标签互不重复：

```console
  断言条数=15 去重后=15
   runtime_login_props / runtime_password_scram / required_memberships /
   chain_least_privilege / not_owner_member / no_predefined_read_all /
   table_dml_allowlist / idempotency_keys_scope / protected_columns /
   no_schema_create / public_no_schema_create / public_no_database_create /
   preview_reader_scope / knowledge_runtime_scope / runtime_can_connect
```

### K) 本地自检**发现并已修正**的问题（记录在此，表示自检确实有效）

| 发现方式 | 问题 | 处理 |
| --- | --- | --- |
| 真跑 `--help` | `backup-postgres.sh` / `restore-drill.sh` / `verify-cvm-postgres.sh` 曾用 `sed -n '2,NNp'` 打印自身文件头当帮助，会把 `set -euo pipefail`、`readonly …` 等**代码行**一起打出来 | 改为显式 `usage()` heredoc；已复跑确认"无代码行" |
| 改写时自查 | `verify-cvm-postgres.sh` 曾有 3 处判据逻辑错误：以 `'number'` 当期望值去比实际行数必然 FAIL；`if/else` 两支打印同一结论；一处含损坏的引号转义 | 重写为 `report_eq`/`report_num`/`report_ge`/`report_denied` 四个语义明确的判定器 |
| 改写时自查 | `provision-db.sh` 里用 `[[ ]] && { …; break; }` 做数组包含判断，在 `set -e` 下有边界风险 | 换成 `grep -qxF` 的 `if` 写法，并对空数组做了守卫 |
| 改写时自查 | 以 `out="$(cmd)"` 捕获可能失败的 psql 输出，在 `set -e` 下会**直接中断脚本**而不是报 FAIL | 统一加 `\|\| true` 并把错误输出纳入判据，避免"看起来通过" |
| 改写时自查 | `runtime_tcp_login` 之外还曾想用 `pg_dump -s` 作为越权反例，但低权限角色能否跑 `pg_dump -s` 我无法在本机证实 | **删除该判据**，不保留"我不知道结论"的检查 |

### L) 本目录 Markdown 复用仓库文档校验器的同类规则

`npm run test:docs` 只校验 `README.md`、`AGENTS.md`、`.github/PULL_REQUEST_TEMPLATE.md` 与
`docs/**/*.md`，**不覆盖 `deploy/**`**。因此用同一套规则（无 U+FFFD、连续表格行**列数一致**、
相对链接目标必须存在）对本目录 5 个 Markdown 文件做了等价检查：

```console
$ python3 check_deploy_md.py <repo-root>
检查 5 个 Markdown 文件：['local-self-check.md', 'README.md', 'roles-and-migration.md', 'runbook.md', 'verify-checklist.md']
PASS: 5 个 deploy Markdown 文件：字符干净、表格列数一致、相对链接均存在
```

该检查**确实抓到过问题**：本页第 2.K 节表格里 `|| true` 的未转义竖线导致列数从 3 变成 5
（与仓库校验器同样的判定），已改为 `\|\|` 后复跑通过。这条说明"自检不是走过场"。

### M) 行尾与暂存区（确保交给 Linux 的脚本是 LF）

```console
$ git ls-files --eol deploy/postgres-cvm | head -6
i/lf    w/lf    attr/    deploy/postgres-cvm/README.md
i/lf    w/lf    attr/    deploy/postgres-cvm/backup-postgres.sh
i/lf    w/lf    attr/    deploy/postgres-cvm/conf/10-gengyun-postgres.conf
i/lf    w/lf    attr/    deploy/postgres-cvm/conf/gengyun-postgresql.service
i/lf    w/lf    attr/    deploy/postgres-cvm/conf/pg_hba.gengyun.conf
i/lf    w/lf    attr/    deploy/postgres-cvm/conf/pg_ident.gengyun.conf

$ git diff --cached --check
（无输出，退出码 0）
```

`i/lf`（索引 LF）说明提交进仓库的内容是 LF，Linux 上 `bash` 可直接执行。
但本仓库 Windows 检出为 `core.autocrlf=true`：**在 Windows 上重新 checkout 会把工作区变成 CRLF**，
所以传到 CVM 后必须先按 [README.md](../README.md) 第 1 节的提示验一次行尾。
本交付没有添加 `.gitattributes`（那属于 `deploy/postgres-cvm/**` 之外的改动，不在本单授权内）。

## 3 明确**未**验证的部分（不得当作已通过）

| 项 | 为什么做不了 | 状态 |
| --- | --- | --- |
| `sql/20-login-roles.sql`、`sql/90-assert-least-privilege.sql` 的 **SQL 语法与语义** | 本机没有任何 psql 可解析它们 | **从未被 PostgreSQL 解析过**；只有第 J 节的静态结构检查 |
| `install-postgres.sh` 的安装/initdb/启动 | 需要目标 CVM + 云硬盘 + root + 网络 | **未执行** |
| PG 主版本 17.11 是否真的能装上 | 需要 `apt-cache madison postgresql-17` 在**目标 CVM** 上跑 | **未执行**；脚本会在找不到 17.11 时明确失败 |
| `pg_hba.conf` / `pg_ident.conf` 是否真的生效 | 需要真实集群重载 + `pg_hba_file_rules` 查询 | **未执行** |
| 角色引导是否真能建出 LOGIN 并授予 5 个组 | 需要真实库 + 迁移已应用 | **未执行** |
| 最小权限断言是否真能返回 `ok` | 同上 | **未执行** |
| 越权反例是否真的返回 `42501` | 同上 | **未执行**（判据已写好，结论未知） |
| 备份是否可恢复 | 需要真实库 + `pg_dump` + 隔离库恢复 | **未产生任何备份、未演练** |
| 网络姿态（公网 5432 关不关） | 安全组在腾讯云账号侧，脚本无凭据 | **未核对**；只能由用户在控制台确认 + 公网反面探针 |
| 与 CloudBase/云托管侧的真实联调 | 需要真实已部署环境 | **未执行** |
| 持久性（重启后仍在） | 需要真实 CVM 重启 | **未执行** |

**因此：本目录的脚本"能跑"只是设计目标，不是实测结果。任何"已部署/已验收/备份可用"
的说法都必须等到资源就绪后按 [verify-checklist.md](../verify-checklist.md) 真跑并留下原始输出。**

## 4 复现方式

```bash
# 在本仓库任一 checkout 的 deploy/postgres-cvm 下
for f in *.sh; do bash -n "$f" || echo "FAIL $f"; done          # A
grep -c '^set -euo pipefail$' *.sh                              # B
for f in *.sh; do bash "$f" --help >/dev/null; echo "$f exit=$?"; done   # D
bash install-postgres.sh --plan                                 # E（非 root 会先被拒绝）
```

第 A–F 项不依赖 PostgreSQL，任何 POSIX 环境都能复现；
一旦有了 PG17，这些命令的"未验证"部分才有条件补上。
