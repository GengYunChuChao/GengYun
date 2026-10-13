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

本交付引用的云端事实分三层，**都不是本单写手取得的**：

| 层级 | 来源 | 内容 | 本单动作 |
| --- | --- | --- | --- |
| **一手 · 用户提供** | **用户本人**（控制台／账户信息），经指挥转述 | 微信云托管环境 `prod-d1g6qe87c4f2d7061` 绑定的是**子账号 S**，且 S 是**父账号 P 的子账号**；`gengyun-vpc` 在**父账号 P** 名下。⇒ **S ≠ P** | **未复现**；只记录结论与结构关系，**不记录账号 ID／凭据指纹等标识值**（保留在私密留档，按凭据同级处理） |
| **二手 · 另一位写手只读调用** | 另一位写手用 `E:\GengYunPrivate` 私密凭据做**只读**调用（未创建任何资源），经指挥转述 | VPC `gengyun-vpc` 在**父账号 P** 上海可见且唯一、子网 `ap-shanghai-1` 可用 IP 253、`DescribeInstances @ap-shanghai` = 0 台、`DescribeSecurityGroups` = 0 个、`tcb DescribeEnvs`（上海/广州）= 0 个环境 | **未复现**；注意**这两份凭据都属父账号 P** ⇒ **对子账号 S 无视角** |
| **官方文档（本会话可达的两页）** | [CloudBase 云托管 · 服务设置](https://docs.cloudbase.net/run/deploy/service-setting)、[CloudBase 云托管 · 使用限制](https://docs.cloudbase.net/run/limitation) | 前者的"网络相关设置"只描述**公网／内网域名开关**（内网限同环境内服务互访），**未记载** VPC／私有网络绑定；后者写明"**不同环境的资源之间只能使用公网调用**"；两页均标注**支持地域：上海** | 本会话**检索通道不可用**（`web_search` 无凭据），只能逐页核对 ⇒ **不是穷尽检索**，**不得**当作"官方已确认" |

边界说明：

- **本单写手没有接触 `E:\GengYunPrivate`、没有使用任何凭据、没有发起任何腾讯云 API 调用**；
- 本仓库、本目录、提交信息与 PR 正文中**不含任何凭据值、不含任何原始返回报文、不含账号 ID 与凭据指纹**；
- 三层证据都**未由本单复现**（一手来自用户、二手来自另一位写手、第三层是公开文档）；
- **"云托管选私有网络时候选只来自环境所属账号"这一机制：本单未能取得官方依据**
  （可达页面未记载 VPC 绑定），目前依据是**用户／指挥的陈述** ⇒ 已在
  [README.md](../README.md) §0.3 显式标注"**未找到依据**"；处理口径是**按风险适用保守暂停**，
  同时**不把未经核实的行为当作已知事实**；
- **账号边界（S ≠ P）推翻了此前基于"同一账号"的"风险不适用"结论**；更正后的条件式分析与
  "换绑须销毁全部环境且不可恢复"的警告见 [README.md](../README.md) §0.3／§0.4；
- **账号边界本身不是动手授权**：授权门禁（含"不要在父账号 P 里为子账号 S 的环境新建 VPC"）
  与资源就绪门禁见 [README.md](../README.md) §0.6／§0.7。

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
| `deploy/**` Markdown 等价校验（见 L 节） | 2 处未转义竖线（`\|\|`）导致表格列数从 3 变 5；后又出现 1 处同类问题（`for … do bash -n "$f" \|\| echo` 写在表格单元格里） | 均转义为 `\|\|` 并复跑通过——**说明这个检查有牙齿** |
| 改写文档后复检行尾 | 用 Python `pathlib.write_text` 拼接段落时，Windows 上把 `\n` 转成了 `\r\n`，导致 `README.md`（421 处）与 `runbook.md`（368 处）变成 CRLF，与仓库其余 LF 文件不一致 | 用 `WriteAllText` + `-replace "\r\n","\n"` 转回 LF；复检本目录 16 个文件 **CRLF=0**、`git ls-files --eol` 全部 `i/lf w/lf` |
| **外部真跑（监工 · 真实 PG 17.11）** | **`20-login-roles.sql` 的前置断言 `pg_has_role('gengyun_api_runtime', …)` 排在建角色之前 ⇒ 全新库上 `ERROR: role … does not exist`（exit=3）**；`90-assert` 连带中止。**本单的静态自检没能发现它**（`bash -n` 不看 SQL，本机也没有 psql） | 见 §4 与 [roles-and-migration.md](../roles-and-migration.md) §6.2：改为"角色不存在也安全"，新增组存在性前置，`90-assert` 加前置自检，`verify`/`restore-drill` 消除同类隐患；返修后的首跑/幂等回归**待监工回传** |

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

## 4 外部真实 PostgreSQL 17.11 证据（**监工执行，非本单写手复现**）

本节与上面 1–3 节**性质不同**：上面是本单写手在本机能做的静态/失败路径自检；
本节是**监工**在**本机真实 PostgreSQL 17.11**（官方 Windows 便携版，与 CI 的 `postgres:17.11` 同版本）
上真跑本目录 SQL 的结果，经指挥转述。**本单写手未复现这些运行**（本机无 PostgreSQL）。

### 4.1 返修前的真跑结果（监工回传）

| 监工执行的内容 | 结果 |
| --- | --- |
| 仓库 `services/api/db/migrations/*.sql`（10 个，按序 `psql -f`） | ✅ **10/10 全部成功**（含 `0007` 自建 `pgcrypto`） |
| 仓库 `services/api/db/roles/*.sql`（7 个） | ✅ **7/7 全部成功** |
| `deploy/postgres-cvm/sql/20-login-roles.sql`（**返修前**版本） | ❌ `exit=3`：`ERROR: role "gengyun_api_runtime" does not exist`（旧版第 74 行） |
| `deploy/postgres-cvm/sql/90-assert-least-privilege.sql`（**返修前**版本） | ❌ 连带失败：同一 ERROR（只跑了 3 行就中止） |

### 4.2 该真跑发现并已修复的缺陷（返修 1）

- **缺陷**：`20-login-roles.sql` 的**前置断言**（`pg_has_role('gengyun_api_runtime', …)`）排在
  **建角色之前**，而 `pg_has_role(name, …)` 在角色不存在时会直接 `ERROR`
  ⇒ **全新库上必然失败**（真实部署场景）；本机若曾手工建过该角色就会掩盖它。
- **修复**：见 [roles-and-migration.md](../roles-and-migration.md) §6.2 的 7 条
  （核心是把该断言改成"角色不存在也安全"，并把"5 个组存在性"提前为止损前置；
  另在 `90-assert` 加前置自检，在 `verify`/`restore-drill` 里消除同类隐患）。
- **同类隐患的排查范围**：本单写手随后把"引用可能不存在的对象"这一模式在
  `20-login-roles.sql` / `90-assert-least-privilege.sql` / `verify-cvm-postgres.sh` /
  `restore-drill.sh` / `provision-db.sh` 里逐处清查并加固（见 §4.4）。

### 4.3 返修后**待补**的证据（在其回传前不得记通过）

| 回归 | 判据 | 状态 |
| --- | --- | --- |
| **全新库首跑** | `20-login-roles.sql` 在空库+已迁移+已建组的库上 `exit=0`，角色出现在 `\du` | **待监工回传** |
| **重复执行（幂等）** | 第二遍 `exit=0`，且 `pg_authid.rolpassword` **不变**、`pg_auth_members` 无重复行 | **待监工回传** |
| 15 项最小权限断言 | 输出 `ok` | **待监工回传** |
| 备份 / 恢复演练 | `restore-drill.sh` 退出码 0、`FAIL=0` | **待监工回传** |
| 缺口令 / 口令格式不符 | 明确失败（不建无口令 LOGIN） | **待监工回传** |

> 监工回传原始输出后，本表会按实际结果更新；**在此之前这五条一律不得当作已通过。**

### 4.4 本次返修涉及的"引用可能不存在的对象"清查结果

| 位置 | 是否引用了可能不存在的对象 | 处理 |
| --- | --- | --- |
| `sql/20-login-roles.sql` | 是（`pg_has_role(name,…)` 早于建角色；`GRANT` 依赖 5 个组） | 已改为存在性安全 + 新增组存在性前置 |
| `sql/90-assert-least-privilege.sql` | 是（多条 `has_table_privilege`/`has_column_privilege` 需关系存在；`'catalog_read.current_knowledge'::regclass` 会硬报错） | 已加前置自检（`to_regclass` + `pg_roles`）；缺前置时立即给补救指引 |
| `verify-cvm-postgres.sh` | 是（4 处角色判据：`rolpassword`、`pg_has_role`×2、`rolattrs`） | 已改为存在性安全，缺失时输出 `实际=role-missing` |
| `restore-drill.sh` | 是（`schema_migrations` 直接 `FROM`） | 已先用 `to_regclass` 判存在，缺失时 `实际=schema_migrations-missing` |
| `provision-db.sh` | 否（建角色前先查 `pg_roles`；迁移门禁用 `to_regclass`） | — 另新增 runuser 环境变量透传前置探测 |
| `backup-postgres.sh` | 否（每张关键表都用 `to_regclass` 守卫） | — |
| `install-postgres.sh` | 否（只用 `pg_database`/`pg_roles` 与 `createdb`） | — |

## 5 复现方式

```bash
# 在本仓库任一 checkout 的 deploy/postgres-cvm 下
for f in *.sh; do bash -n "$f" || echo "FAIL $f"; done          # A
grep -c '^set -euo pipefail$' *.sh                              # B
for f in *.sh; do bash "$f" --help >/dev/null; echo "$f exit=$?"; done   # D
bash install-postgres.sh --plan                                 # E（非 root 会先被拒绝）
```

第 A–F 项不依赖 PostgreSQL，任何 POSIX 环境都能复现；
一旦有了 PG17，这些命令的"未验证"部分才有条件补上（§4 的真跑即由监工在真实 PG 17.11 上完成）。
