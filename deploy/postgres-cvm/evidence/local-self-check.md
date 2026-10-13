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
# 【注意】以下这段是本单在**网段变更之前**捕获的原始输出，按"不改写历史证据"的原则**原样保留**
# （当时目标网段还是父账号的 10.20.0.0/16；变更后的复跑输出见本页 §6）
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
| **外部真跑（监工 · 真实 PG 17.11）** | **`20-login-roles.sql` 的前置断言 `pg_has_role('gengyun_api_runtime', …)` 排在建角色之前 ⇒ 全新库上 `ERROR: role … does not exist`（exit=3）**；`90-assert` 连带中止。**本单的静态自检没能发现它**（`bash -n` 不看 SQL，本机也没有 psql） | 见 §4 与 [roles-and-migration.md](../roles-and-migration.md) §6.2：改为"角色不存在也安全"，新增组存在性前置，`90-assert` 加前置自检，`verify`/`restore-drill` 消除同类隐患。**第二轮外部复核已确认修好**（§4.3 A/B/D 三项通过） |
| **外部真跑（第二轮）发现的过度约束** | `90-assert` 把 `schema_migrations` 列为**硬前置**，而 **15 项断言没有一项读它** ⇒ 在"有套接字但无 `migrate.ts`"的等价环境里无法验证断言（守卫正确早停，但也挡住了复核） | 见 §4.3.3：改为**硬前置（真依赖）+ 软前置（台账只告警）**；**15 条断言的 SQL 一字未改**，台账的权威判定点仍在 `provision-db.sh` 门禁与 `verify` 的 `migrations_applied`。**收窄后已由复核者实跑通过**（末行 `ok`） |
| **外部真跑（第二轮）暴露的判读缺口** | `restore-drill.sh` 只看 `pg_restore` 的 exit code，**丢弃完整输出** ⇒ 复核者遇到 `exit=1` 时无法定位（错误文本被管道吞掉） | 见 §4.3.2：改为保留完整输出到日志 + **致命/非致命分类**（`WARNING`/`NOTICE` 非致命；`already exists` 归因目标库非空；`does not exist` 归因前置缺失；其它为真失败），PASS 条件收紧为 `exit=0` 且无 `ERROR:` 行 |

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
| `sql/20-login-roles.sql`、`sql/90-assert-least-privilege.sql` 的 **SQL 语法与语义** | 本单写机没有 psql | 已由**外部真实 PG 17.11** 解析并执行（见 §4）；本单仍只做第 J 节的静态结构检查 |
| `install-postgres.sh` 的安装/initdb/启动 | 需要目标 CVM + 云硬盘 + root + 网络 | **未执行** |
| PG 主版本 17.11 是否真的能装上 | 需要 `apt-cache madison postgresql-17` 在**目标 CVM** 上跑 | **未执行**；脚本会在找不到 17.11 时明确失败 |
| `pg_hba.conf` / `pg_ident.conf` 是否真的生效 | 需要真实集群重载 + `pg_hba_file_rules` 查询 | **未执行** |
| 角色引导是否真能建出 LOGIN 并授予 5 个组 | 需要真实库 + 迁移已应用 | ✅ **外部真实 PG 已验证**（§4.3 的 A 项） |
| 重复执行是否幂等（不改口令） | 第二遍比对 `rolpassword` | ✅ **外部真实 PG 已验证**（§4.3 的 B 项） |
| 缺口令是否被拒绝 | 未设 `GENGYUN_API_RUNTIME_PASSWORD` | ✅ **外部真实 PG 已验证**（§4.3 的 D 项） |
| 最小权限断言是否真能返回 `ok` | 需要真实库 + 全部迁移 + 角色已引导 | ✅ **外部真实 PG 已验证**（§4.3 的 C 项：收窄依赖后 `exit=0`、末行 `ok`、15/15 通过） |
| 越权反例是否真的返回 `42501` | 需要真实库 + 运行时角色 | **未执行**（判据已写好，结论未知） |
| 备份是否可恢复 | 需要真实库 + `pg_dump` + 隔离库恢复 | ⚠️ **未演练**；等价命令已给出（[verify-socket-only-equivalents.md](../verify-socket-only-equivalents.md) 第 2/3 节），待复核 |
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

### 4.3 返修后复核结果（**第二轮**，监工回传）

复核环境说明（**必须随证据一起记**）：本机官方 PostgreSQL **17.11**（与 CI 同版本），
因沙箱禁 TCP ⇒ **只听 AF_UNIX 套接字**，`psql` 可用、**node-postgres 连不上**（故无法跑 `migrate.ts`）；
迁移是用 `psql -f` 逐个应用的。

| 回归 | 复核结果 | 判定 |
| --- | --- | --- |
| **A 全新库首跑** | `20-login-roles.sql` `exit=0`；`rolcanlogin=true`、`rolsuper=false`；**继承 5 组** | ✅ **真实 PG 已验证** |
| 库名守卫 | 在临时库上被"当前数据库不是 gengyun"拦下 | ✅ 按设计生效 |
| **B 重复执行（幂等）** | 第二遍 `exit=0`；`pg_authid.rolpassword` **哈希不变**；成员数仍 **5** | ✅ **真实 PG 已验证** |
| **C 15 项最小权限断言**（收窄依赖后的 `d2b8c3d`） | `exit=0`；首行为软前置告警"未找到 `public.schema_migrations` 台账"（**按设计**）；**末行 `ok`** | ✅ **真实 PG 已验证**（15/15 通过） |
| **D 缺口令反例** | 未设 `GENGYUN_API_RUNTIME_PASSWORD` ⇒ `exit=3 ≠ 0` | ✅ **真实 PG 已验证**（拒绝建无口令 LOGIN） |
| E 前置守卫 | 未单独跑（C 的硬/软前置已在实跑中体现） | 由 C 覆盖 |
| **备份：`pg_dump -Fc`** | `exit=0`；大小 184.1 KB；`sha256` 已记录 | ✅ **真实 PG 已验证** |
| **备份：`pg_restore --list`（TOC）** | TOC 条目 **415** | ✅ **真实 PG 已验证** |
| **恢复第 1 次** | `createdb` → `pg_restore --exit-on-error` **`exit=0`** | ✅ **真实 PG 已验证** |
| **恢复库上的权限继承** | 以 `gengyun_api_runtime` 身份 `select count(*) from users` **返回 0 且无权限错误** | ✅ 证明**组角色继承与授权随 dump 重建成功** |
| **恢复第 2 次** | `pg_restore --exit-on-error` **`exit=1`**，但**错误文本被复核者的管道吞掉、未捕获**；事后 schema 指标 source=restored=`40\|4\|0\|0` | ⚠️ **未解释、待复核（不得记通过）**；最可能原因见 §4.3.1 |

复核者另确认：**返修 1 的真缺陷已确认修好**；库名守卫、5 组前置、口令守卫、`COALESCE` 顺序修复、
口令默认不变**都按设计生效**；并纠正其上一轮一条结论：重复跑 `roles/*.sql` 报"角色已存在"是
**同集群复用**所致（角色 SQL 是裸 `CREATE ROLE`、设计上不 DROP 别人的角色），**不是缺陷**。
台账一致性一项按口径记为 **"不适用（本环境无 `migrate.ts` 写入）"**，不是数据损坏。

#### 4.3.1 对"第 2 次恢复 exit=1"的判读（**假设，未定论**）

**技术事实（可自证）**：本 dump 是**库级** `pg_dump -d`（不是 `pg_dumpall`），**不含任何角色定义**。因此：

- **不可能**出现"角色已存在"这类错误 ⇒ 复核者提出的"角色/ACL 已存在属非致命"这一假设**不成立**；
- 与角色相关的错误只可能是 `role "…" does not exist` ⇒ 那属**致命**（目标集群未做角色引导）；
- `already exists` 只可能来自**恢复进了一个非空库**（对象还在，例如第 1 次演练的残留）。

**最可能的原因**：第 2 次恢复**没有先 `dropdb`/`createdb`**（第 1 次是新建库，第 2 次直接在原库上再恢复）
⇒ `pg_restore` 在第一个重复对象处报 `already exists`，因 `--exit-on-error` 立即退出（`exit=1`）；
而"事后指标完全一致"恰恰因为**那些对象本来就是第 1 次恢复留下的**。

**一条命令即可定论**（不要吞 stderr）：

```bash
dropdb --if-exists gengyun_restore_drill
createdb -O gengyun_cvm_owner gengyun_restore_drill
pg_restore -U gengyun_cvm_owner -d gengyun_restore_drill --exit-on-error "$DUMP" >/tmp/restore2.log 2>&1
echo "restore_exit=$?"
grep -nE '^(pg_restore: error:|ERROR:)' /tmp/restore2.log | head -5   # 期望：无输出
```

- 若这次 `exit=0` 且无 error 行 ⇒ 上述假设成立：第 2 次属**操作顺序问题（未清库）**，
  **不是 dump 或脚本缺陷**；演练以本次为准记为通过。
- 若仍非 0 ⇒ 请把前 5 条 error 行回传 ⇒ 属**真失败**，按文本定位。

#### 4.3.2 `restore-drill.sh` 的判读口径加固（本版新增）

| 输出 | 是否致命 | 处理 |
| --- | --- | --- |
| `WARNING:` / `NOTICE:` / `pg_restore: warning\|notice:` | **非致命** | 只计数并写日志，不影响判定（它们本就不会让 `--exit-on-error` 变非 0） |
| `already exists` | **致命，但归因于目标库** | 明确提示"目标库不是空的；脚本会先 DROP 再建，手工复现必须先 dropdb/createdb。**不是 dump 的问题**" |
| `does not exist` | **致命，但归因于前置** | 明确提示"未完成角色引导，先跑 `provision-db.sh`；本 dump 不含角色定义" |
| 其它 `ERROR:` | **致命** | 打印前 5 条 error 行与日志路径，要求人工定位 |

同时：`pg_restore` 的**完整输出写入日志文件**（路径打印在判据行里，不再被丢弃）；
PASS 条件收紧为 **`exit=0` 且输出无 `ERROR:` 行**。

#### 4.3.3 针对 C 的收窄（按依赖关系，不改任何断言语义）

**事实**：`90-assert-least-privilege.sql` 的 **15 项断言没有任何一项读取 `schema_migrations`**；
它们真正依赖的是 7 个业务关系 + 运行时角色 + 5 个既有 NOLOGIN 组。把台账列为**硬前置**属过度约束。

**处理**：前置分两级——**硬前置**（上述关系与角色；缺失即失败并给三步指引）+
**软前置**（`schema_migrations` 台账；缺失**只告警不失败**）。这样在"有套接字但没有 `migrate.ts`"
的等价环境里也能验证那 15 项断言；**台账的权威判定点仍在目标 CVM 侧**
（`provision-db.sh` 的迁移门禁 + `verify-cvm-postgres.sh` 的 `migrations_applied` 判 FAIL）。
本交付**不提供**"手工伪造台账"的做法——那会把不属于 `migrate.ts` 的写入带进库。

> **本项已由外部真跑验证通过**：收窄后在 `d2b8c3d` 上 `exit=0`、首行为软前置告警、**末行 `ok`**（§4.3 的 C 项）。
>
> **仍未验证（不得记通过）**：**恢复第 2 次的 `exit=1` 原因**（§4.3.1，待复核者用清库重跑定论）；
> 以及目标 CVM 侧的一切（安装 / `pg_hba` / 安全组 / 持久性 / 公网 5432）。

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

## 6 网段变更执行记录：`10.20.0.0/16` → `10.21.0.0/16`（**用户授权、因选定方案 A**）

**授权来源**：用户选定**方案 A**（在子账号 S 内建网），并**明确授权**做这处"四处同改"的 CIDR 变更
（见 PR #114 正文与 [README.md](../README.md) §0.4／§0.5）。**依据**：原目标网段属父账号 P，
方案 A 的设备将位于子账号 S 内新建的 VPC ⇒ 目标网段必须换成**不与 `10.20.0.0/16` 重叠**的 `10.21.0.0/16`。

### 6.1 改动清单（精确到行，改后行号）

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `install-postgres.sh` | **第 10–11 行**头部说明改为方案 A + 保留父账号 VPC 为历史；**第 51 行** `VPC_CIDR='10.21.0.0/16'`；**第 52/53 行** `VPC_NAME`/`VPC_ID` 改为方案 A 表述；**第 152–155 行**失败提示改为"加入方案 A 目标 VPC 的对应子网"；**第 159 行**"安全组"改"入站规则/安全组/防火墙"；**第 514 行**收尾提示改为「标准 CVM 看安全组／Lighthouse 看实例防火墙」。**第 134–140／149／158 行**是网段匹配逻辑（**按 `^10\.21\.` 即 VPC /16 前缀**，见 §6.3）——**未改** |
| 2 | `conf/pg_hba.gengyun.conf` | **第 8–10 行**注释补 Lighthouse 防火墙等同安全组、**只控入流量**；**第 14–16 行**三者一致表改为目标网段 `10.21.0.0/16` + 入站规则；**第 32／34／38 行**三条规则 `10.20.0.0/16` → `10.21.0.0/16`；两条区段注释改"目标网段" |
| 3 | `conf/10-gengyun-postgres.conf` | **第 12 行** `@VPC_PRIVATE_IP@` 说明改为目标 VPC(`10.21.0.0/16`)；**第 16／18 行**网络姿态注释改为「入站规则（安全组／防火墙）」 |
| 4 | `verify-cvm-postgres.sh` | **第 8–10 行**前置注释改为方案 A（保留历史）；**第 14 行**示例 `--remote-host 10.21.1.9`；**第 40 行** `VPC_CIDR='10.21.0.0/16'`；**第 41 行** `VPC_PREFIX='10.21'`；**第 148 行**断言 `address = '10.21.0.0'`；**第 276/277 行**两项 `manual` 改为「入站规则（安全组／Lighthouse 防火墙）」与「方案 A 的 VPC」（标签同步改为 `ingress_5432_source`／`cvm_in_target_vpc`，全库无其他引用） |
| 5 | 文档 | `README.md`（§0.4 选中方案 A、§0.5 重写为"已完成的变更记录+将来再改步骤"、§2.1／§2.2 目标网段、**新增 §2.5 Lighthouse 差异**、§4 P0b/P1/P4/P5、§6 新增第 9 条、§7 第 0 步）、`runbook.md`（§0 目标形态+`--plan` 预期输出+检查表、§1 角色表、§3 输出示例与入站规则、§6 U0e/U1/U3、§7 新增一行）、`verify-checklist.md`（§0、§3、§4、§9、§10） |
| 6 | 保留（**未改**） | 父账号 P 的 `10.20.0.0/16` 作为**历史记录**保留在 `README.md` §0.1／§0.2／§0.4、`runbook.md` §0、`verify-checklist.md` §0、`install-postgres.sh` 第 10/11/51 行注释、`verify-cvm-postgres.sh` 第 10 行注释；本页 §2.D 的**历史原始输出**也原样保留 |

### 6.3 同批补充：目标 VPC 下有**两个子网**（对四处 CIDR 变更**无影响**）

**用户补充（2026-10-13）**：子账号 S 内 VPC `10.21.0.0/16` 下建**两个子网** ——
`10.21.0.0/24 @ ap-shanghai-1` 与 `10.21.1.0/24 @ ap-shanghai-2`（名称用户所定，ID 待回传）。

**关键判据（写入 [README.md](../README.md) §2.6）**：四处 CIDR 用的是 **VPC 网段 `10.21.0.0/16`**，
**天然覆盖两个子网** ⇒ **5432 来源规则仍写 `10.21.0.0/16`**，
**不需要**因"多了一个子网"而扩大或改写这四处；**也不新建第二套配置/第二份 `pg_hba`**。

**点 3 的核实（`--plan` 是否按 /24 匹配？）—— 已核：按 VPC /16 前缀匹配，与选哪个子网无关**：

```console
$ grep -n "VPC_PREFIX=\|only-/16\|grep -E \"\^\${VPC_PREFIX\|VPC_PRIVATE_IP\" =~" deploy/postgres-cvm/install-postgres.sh
134:readonly VPC_PREFIX="$(
136:  [[ "${VPC_CIDR##*/}" == '16' ]] || { printf 'only-/16' ; exit 0; }
140:  [[ "$VPC_PREFIX" == 'only-/16' ]] && fail "本脚本的网段判定只实现 ${VPC_CIDR} 这种 /16 形式，当前值无法判定。"
149:      | grep -E "^${VPC_PREFIX//./\\.}\." | sort -u
158:[[ "$VPC_PRIVATE_IP" =~ ^${VPC_PREFIX//./\\.}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] \
```

判读：`VPC_PREFIX` 由 `VPC_CIDR` 取**前两段**（`10.21`），网卡筛选与地址校验都用 **`^10\.21\.`**
⇒ **`10.21.0.x`（子网 A）与 `10.21.1.x`（子网 B）都能通过**；脚本**没有**任何 `/24` 匹配逻辑。
`verify-cvm-postgres.sh` 同理（第 41 行 `VPC_PREFIX='10.21'`）。**因此无需改脚本逻辑**（也按要求未改）。

另注：该实现**只支持 /16**；若把 `VPC_CIDR` 改成 `/24`，脚本会在**第 140 行明确失败**（刻意保护）。

**两条落地约束（写入 README §2.6 与 runbook §0/§1）**：
① 一台服务器只在一个可用区的一个子网内；
② 云托管「服务设置 → 私有网络」只能选**一个**子网，选哪个都通（同 VPC 内跨子网可路由），建议选 DB 服务器所在子网。

**未做**（按指令）：没有把 `VPC_CIDR` 环境变量化、没有其他重构。

### 6.2 改后复跑（本机真实输出，root）

```console
### bash -n ×5
  backup-postgres.sh         : OK
  install-postgres.sh        : OK
  provision-db.sh            : OK
  restore-drill.sh           : OK
  verify-cvm-postgres.sh     : OK

### 脚本内常量
deploy/postgres-cvm/install-postgres.sh:51:readonly VPC_CIDR='10.21.0.0/16'   # 方案 A：子账号 S 内新建的 VPC；与父账号 gengyun-vpc 的 10.20.0.0/16 不重叠
deploy/postgres-cvm/verify-cvm-postgres.sh:40:readonly VPC_CIDR='10.21.0.0/16'
deploy/postgres-cvm/verify-cvm-postgres.sh:41:readonly VPC_PREFIX='10.21'

### pg_hba 三行
32:host        @DB_NAME@   gengyun_cvm_owner       10.21.0.0/16        scram-sha-256
34:host        @DB_NAME@   gengyun_api_runtime     10.21.0.0/16        scram-sha-256
38:host        all         all                     10.21.0.0/16        reject

### install-postgres.sh --plan（root；本机网卡不在 10.21.0.0/16 ⇒ 预期明确失败，**不是通过**）
[install-postgres.sh][WARN] 发行版 ubuntu 26.04 不在 PGDG apt 已验证列表 (ubuntu 22.04/24.04, debian 12) 内，继续但请人工确认仓库可用。
[install-postgres.sh][ERROR] 在 VPC 网段 10.21.0.0/16 内找到 0 个私网 IPv4（期望正好 1 个）：
         候选：（无）
         请确认该 CVM 已加入 方案 A 目标 VPC（子账号 S 内新建，名称待用户确定） 的对应子网（VPC ID：待用户在子账号 S 内创建后填写），
         或显式设置 GENGYUN_VPC_PRIVATE_IP=<该 CVM 的私网 IPv4>。
plan_exit=1
```

**如何判读 `--plan`（**不得误判为通过**）**：

| 场景 | 输出特征 | 结论 |
| --- | --- | --- |
| 服务器在 `10.21.0.0/16` 内 | 无 `[ERROR]`；`[PLAN]` 里出现 `listen_addresses=127.0.0.1,10.21.x.y` | **计划可用**，可以执行真安装 |
| 服务器不在该网段（**本例**：本机 WSL 网卡是 `172.x`） | `[ERROR] 在 VPC 网段 10.21.0.0/16 内找到 0 个私网 IPv4`，退出码 **1** | **失败、不是通过**——脚本在拒绝"把 PG 装到目标网段之外"；处置见 [runbook.md](../runbook.md) §0 |

> 本机（WSL）**不可能**通过这条前置（它的网卡不在 `10.21.0.0/16`），所以本页记录的是**预期失败**；
> 这也正是"**脚本完成 ≠ 通过**"的实例：**唯一的通过证据必须来自目标 CVM 上的真实复跑**。

## 7 返修 8：目标 CVM 真跑缺陷 —— 装包前引用 `postgres` 组 + 「假成功」排查

### 7.1 监工在目标 CVM 上的原始输出（**返修前**）

环境：Ubuntu 22.04.5 jammy / 2C2G / 内网 `10.21.1.8` / `/dev/vdb` 挂 `/data`；`--plan` 全绿。

```text
[install-postgres.sh] 数据目录：/data/gengyun/pgdata
[install-postgres.sh] 所在文件系统：/dev/vdb 挂载点 /data
[install-postgres.sh] 准备私密目录 /etc/gengyun/private（0750 root:postgres）
install: invalid group 'postgres'
INSTALL_EXIT=0
```

### 7.2 本地复现（**返修前**版本 + 相同前置）

本机 WSL（ubuntu 26.04）**同样没有** `postgres` 系统组，因此可直接复现该失败（对包管理/系统工具做 stub，
不改动系统；`GENGYUN_VPC_PRIVATE_IP=10.21.1.8` 覆盖网段判定）：

```console
### 本机是否存在 postgres 系统组？（监工的 CVM 上装包前不存在）
  不存在（与监工 CVM 装包前一致）
### 本机是否存在 postgres 系统用户？
  不存在
[install-postgres.sh] 准备私密目录 /etc/gengyun/private（0750 root:postgres）
install: invalid group: 'postgres'
EXIT=1
>>> 退出码非 0（未复现假成功）
### 清理（只删本脚本自己造的临时物）
  /etc/gengyun 未创建
```

**结论（如实、不含糊）**：

- **顺序缺陷属实**：装包前引用 `postgres` 组 ⇒ 目标 CVM 上一执行就中止。**已修**（§7.3a）。
- **但在我这次复现里，脚本的退出码是 `1`（非 0）** —— 我**没能**在本地复现 `INSTALL_EXIT=0`。
  （两边报错文本略有差异：本机 coreutils 较新，打印 `invalid group: 'postgres'`；jammy 为 `invalid group 'postgres'`，
  但两者都是 `install` 失败，退出码都是非 0。）
- **因此"假成功"最可能来自调用方式，而不是脚本的退出码**，典型是**管道**：
  `sudo ./install-postgres.sh 2>&1 | tee log; echo $?` ⇒ `$?` 是 **`tee`** 的（0），不是脚本的；
  `| tail` / `| head` 同理；`cmd || true`、外层 `set +e` 也会造成同样效果。
- **无论真相是哪一种，本版都把"exit 0"变成经过校验的承诺**（§7.3d）：即使有某条命令失败而未被拦住，
  只要目标未达成，脚本就**不可能**返回 0；同时把取码方式写成文档（§7.3f），避免自动化被骗。

### 7.3 修复（只改 `deploy/postgres-cvm/**`）

| # | 修复 | 位置 |
| --- | --- | --- |
| a | **顺序**：私密目录改为**装包前以 `root:root` 0750** 创建；装包后再 `chgrp postgres` | `install-postgres.sh`（原私密目录步骤 + 新增 5b） |
| b | **新增 5b 运行身份前置**：断言 `postgres` 用户/组**由包创建**；不存在则**明确失败并给出排查命令**；**本脚本绝不自己 `groupadd`/`useradd`**（避免与发行版包行为冲突）。通过后 `chown root:postgres` 私密目录（`postgres` 需能"穿过"它去读 initdb 临时口令文件） | `install-postgres.sh` 新增 5b |
| c | **修掉一处管道接缝**：原 `runuser … psql … \| awk` ⇒ 改为**先捕获、失败即 `fail`**（管道末位是 `awk`，会吞掉 psql 失败） | `install-postgres.sh` 第 11 节 |
| d | **新增 11.5 收尾硬校验**：`PG_VERSION==17`、单元 `active`、`pg_isready` 通、业务库 `SELECT 1` 返回 1；**任一不满足即 `fail`** ⇒ **`exit 0` 表示目标已达成，而不只是"跑到最后一行"** | `install-postgres.sh` 新增 11.5 |
| e | 文档：私密文件与目录改为 **`0600`/`0750` `root:root`**，并写明"装包前不要引用 postgres 组"；README P8 与 §7 第 0.5 步同步 | `runbook.md` §0/§2/§3、`README.md` P8/§7 |
| f | 文档：**如何正确取退出码**（`tee`/`tail` 陷阱；`set -o pipefail` 或 `${PIPESTATUS[0]}`） | `runbook.md` §3 步骤 1 |

### 7.4 回归（**真跑原始输出**，本机 root；工具桩化以绝不改动系统）

```
=== T0：装包前不再引用 postgres 组（顺序缺陷回归）===
[install-postgres.sh] 准备私密目录 /tmp/w19-t0/private（0750 root:root；装包后再 chgrp postgres）
[install-postgres.sh] 下载 PGDG 签名公钥（…）
[STUB] curl --fail --silent --show-error --location --output …
T0_EXIT=7
PASS T0：**没有** invalid group（顺序缺陷已修）
PASS T0：私密目录按 root:root 创建
PASS T0：目录已建：750 root:root
PASS T0：后续步骤失败后**非零退出**（rc=7）

=== T1：私密目录创建失败 ⇒ 必须非零退出 ===
[install-postgres.sh] 准备私密目录 /tmp/w19-t1/private（0750 root:root；装包后再 chgrp postgres）
install: cannot create directory '/tmp/w19-t1/private': Not a directory
T1_EXIT=1
PASS T1 失败即非零退出

=== T2：PGDG 公钥下载失败（curl exit 7）⇒ 必须非零退出 ===
T2_EXIT=7
PASS T2 失败即非零退出

=== T3：act() 包装器的失败传播（微测：证明所有 act 包住的步骤都会硬失败）===
T3a 真实 install 失败 -> rc=1     PASS T3a install 经 act 传播失败
T3b 真实 chown   失败 -> rc=1     PASS T3b chown 经 act 传播失败
T3c 任意失败命令经 act -> rc=1   PASS T3c 任意失败命令经 act 传播
=== 回归结论：全部 PASS ===
```

**用例名与覆盖**：`T0` 顺序缺陷回归（**该步骤不再引用 postgres 组**，且后续失败非零退出）；
`T1` 私密目录失败 ⇒ 非零；`T2` 包下载失败 ⇒ 非零；`T3` `act()` 传播（install/chown/任意命令）。
均在本机以 root 真实执行，输出如上（工具桩化，未改动系统；测试造的临时物已清理）。

### 7.5 失败路径审计（`install`/`chown`/`systemctl`/`createdb` 等）

| 位置/命令 | 失败是否会让脚本非零退出 | 依据 |
| --- | --- | --- |
| 全部经 `act "…" <cmd>` 的步骤（`install -d`、`chown`、`apt-get update/install`、`systemctl restart/enable`、`createdb` 前的 `install` 等） | **是** | `act` 末尾直接 `"$@"`，状态原样返回；**T3 微测实证** |
| 裸命令（`runuser … initdb`、`runuser … createdb`、`substitute()` 里的 `chown`/`chmod`、`printf >> postgresql.conf` 等） | **是** | 位于 `set -euo pipefail` 之下的普通命令；无 `\|\| true` 包裹 |
| 业务库存在性判断 `if runuser … psql … \| grep -q 1` | 是（走 else 分支执行 `createdb`，失败即退出） | `if` 条件豁免 errexit，但**分支内的 `createdb` 不免** |
| `dpkg -s`（`if ! …`） | **否（刻意）** | 仅用于判断"是否需要装包"，是查询语义 |
| `pg_lsclusters`/`find \| wc -l`/`cat \|\| true`/`mapfile` 里的 `grep`（均在 `$()` 或 `if` 条件内） | **否（刻意）** | 都是**探测**；其结果随后被显式判定并 `fail`（如"0 个私网 IPv4"） |
| `act "停用发行版集群启动单元…" bash -c 'systemctl disable … \|\| true'` | **否（唯一刻意的系统性豁免）** | 目标是**发行版的** `postgresql.service`（可能不存在）；**我们自己的单元**用 `act systemctl restart`，失败会传播 |
| 第 11 节 `runuser … psql … \| awk`（**返修前**） | **否（缺陷）** | 末位是 `awk` ⇒ 已按 (§7.3c) 修为"先捕获、失败即 fail" |
| 收尾硬校验（11.5） | 是 | 四条断言各自 `\|\| fail` |

### 7.6 本地**未**验证的部分（不写通过）

- **5b 的 `postgres` 存在性断言**与**11.5 的收尾硬校验**需要真实安装到那一步 ⇒ **本地未执行**；
  它们的代码路径请在**目标 CVM** 上由监工复核（§7.4 的 T0/T1/T2 只覆盖到"包下载/安装之前"）。
- `systemctl` / `createdb` / `runuser` 的**真实端到端**失败传播：本地未端到端执行，
  仅有 **T3 微测**（证明 `act` 会传播）+ §7.5 的代码审计作为依据。
- **监工已做的临时变通**（在服务器上 `groupadd -r postgres` + `useradd`）是**绕过、不是修复**，
  且**未入仓**；建议记为"变通运行"。在**修复版**上重跑时，5b 的断言会**直接通过**（身份已存在）——**这属预期**；
  修复版对"**全新机器**"才有意义（那种情况下装包前不再引用 `postgres`，装包后断言其存在）。

## 8 返修 9：真机缺陷 3（逐级目录穿越）与缺陷 4（半初始化目录不自愈）+ 可选 PGDG 镜像

**背景（监工真机回报）**：`7bdd431` + 两处最小变通后安装跑通，且 **11.5 收尾硬校验按设计生效**：

```text
[install-postgres.sh] 收尾校验通过：PG_VERSION=17、gengyun-postgresql.service active、pg_isready 通、业务库 gengyun 可查询。
版本 PostgreSQL 17.11 ｜ 数据目录 /data/gengyun/pgdata（/dev/vdb→/data）｜ 业务库 gengyun ｜ 监听 127.0.0.1,10.21.1.8:5432
INSTALL_EXIT=0
```

（发行版集群 5432 守卫也按设计生效：按选项 (a) `GENGYUN_DROP_DEFAULT_CLUSTER=1` 时脚本**明确提示**需确认，
监工核实该集群只有 `postgres/template0/template1`、从未使用 ✓。）

### 8.1 缺陷 3：`/etc/gengyun` 为 `0700 root:root` ⇒ `postgres` 无法穿越 ⇒ initdb 读不到临时口令文件

真机原始输出：

```text
[install-postgres.sh] 创建数据目录 /data/gengyun/pgdata（0700 postgres:postgres）
[install-postgres.sh] initdb 初始化集群（口令经临时私密文件传递，随后立即删除）
initdb: error: could not open file "/etc/gengyun/private/.initdb-pw.J1ECyF" for reading: Permission denied
INSTALL_EXIT=1

$ namei -l /etc/gengyun/private
drwxr-xr-x root root /
drwxr-xr-x root root etc
drwx------ root root gengyun        ← **0700 root:root**，postgres 连目录都进不去
```

**根因（本单本地复现并钉死）**：旧版只在**叶子**目录上控制属组，且当私密目录不存在时会
在 `umask 077` 下用 `install -d` **隐式创建父目录**。本机实测（`probe-install-d.sh`）：

```console
### umask 077 下创建 /tmp/probe-p/leaf，父目录 /tmp/probe-p 的模式是什么？
  700 root:root /tmp/probe-p        ← 隐式创建的父目录 = 0700（正是缺陷根因）
  750 root:root /tmp/probe-p/leaf
### install -d -m 0750 对**已存在**的 0700 目录，会不会把模式改过来？
  before : 700 root:root
  after  : 750 root:root            ← 会修（这条让"历史遗留 0700 父目录"也能自愈）
### 逐级穿越语义（本机无 postgres 用户 ⇒ 用非 root 用户 mr 作等价代理）
  0700 -> 不可穿越（符合预期）
  0750 + 属组=运行身份 -> 可穿越（符合预期，即修复目标）
```

**修复**：

| # | 修复 | 位置 |
| --- | --- | --- |
| 1 | **显式建两级**私密路径（`$(dirname $PRIVATE_DIR)` 与 `$PRIVATE_DIR`）为 `0750 root:root`，并**断言权限=750**；不再依赖 umask 与历史模式 | `install-postgres.sh` 第 4 节 |
| 2 | 装包后**逐级** `chgrp postgres` + **逐级** `runuser -u postgres -- test -x` 断言，失败时打印 `namei -l` 提示 | 第 5b 节 |
| 3 | initdb 段**删掉** `umask` 下的 `install -d` 隐式创建（改为"目录必须已存在，否则明确失败"），并在 initdb 前**断言临时口令文件对 postgres 可读**（失败时打印逐级权限 + 文件/目录模式） | 第 7 节 |

**理由（回应"任选，但请给出理由"）**：选择**让目录可穿越**（`0750` + 属组 `postgres`），而不是把口令文件挪到别处——
因为 ① 私密目录本来就是存放该临时口令的**正确位置**（`0600 postgres`，其它人不可读）；
② `0750 root:postgres` 只给 `postgres` **穿越（x）** 权限，**不给读**：凭据文件仍是 `0600 root:root`，
`postgres` 打不开它；③ 这与发行版包对 `/etc/postgresql/*` 的做法同源（属组 = 运行身份）。

### 8.2 缺陷 4：initdb 失败留下的"非空且无 `PG_VERSION`"目录 ⇒ 重跑不自愈

旧版只判断 `PG_VERSION` 是否存在，否则直接 initdb ⇒ 对非空目录 initdb 会再报 `directory is not empty`。

**修复**：把该判断**前移到装包之前**（新增第 4c 节），默认**明确失败**并打印内容预览 + 两种处置；
只有显式 `GENGYUN_RESET_PGDATA=1` 才清空，且清空前**打印预览**、并**拒绝**在"挂载点自身"或系统目录上执行
（`df` 判定 + 路径白名单），**绝不默认删用户数据**。

### 8.3 缺陷 9 回归（**真跑原始输出**，本机 root；工具桩化、未改动系统）

```
=== 0) 逐级穿越语义（用非 root 用户 mr 代理 postgres）===
  drwx------ root root w19-t4            ← namei -l 的逐级输出
  mr **不可**穿越（符合预期 ⇒ 正是 postgres 遇到的 Permission denied）
  0750 + 属组=运行身份 ⇒ **可**穿越（符合预期，即修复目标）
=== 1) 缺陷 3 回归：预置 0700 的私密目录 ⇒ 脚本必须收敛为 0750 且不在此处失败 ===
  预置：700 root:root → 之后：750 root:root / 父级 750 root:root
  [install-postgres.sh] 私密路径权限已收敛为 0750（…、…）；装包后将 chgrp postgres 并断言可穿越。
  退出码=7（在包下载处失败；**不在权限处**失败）
  PASS 1a 脚本收敛并断言 0750    PASS 1b 已存在目录被修为 750    PASS 1c 不应报权限断言失败
=== 2) 缺陷 4 回归：非空且无 PG_VERSION ⇒ 必须明确失败（不得再 initdb）===
  [install-postgres.sh][ERROR] 数据目录 /tmp/w19-t6/pgdata **非空但没有 PG_VERSION**（1 项）⇒ …
  退出码=1
  PASS 2a 明确失败并说明原因   PASS 2b 给出显式处置开关   PASS 2c 打印内容预览
  PASS 2d 不得真正执行 initdb  PASS 2e 默认不删除用户数据
=== 3) 缺陷 4 修复路径：GENGYUN_RESET_PGDATA=1 ⇒ 先预览再清空，然后继续 ===
  …将清空半初始化的数据目录 …；内容预览（前 5 项）： …/partial-file
  已清空 …（接下来由第 7 节重新创建并 initdb）。   退出码=7
  PASS 3a 执行了清空   PASS 3b 残留已被清掉
=== 4) 镜像变量贯通（等价表达式；本机不写 /etc/apt 以免改动 apt 配置）===
  默认 -> https://apt.postgresql.org/pub/repos/apt
  GENGYUN_PGDG_MIRROR=…tencent… -> https://mirrors.cloud.tencent.com/postgresql/repos/apt
  仅设别名 PGDG_MIRROR -> https://mirrors.aliyun.com/postgresql/repos/apt
  PASS 4a 默认官方源   PASS 4b 别名生效   PASS 4c 镜像确实进了 sources.list 行
=== 返修 9 回归结论：全部 PASS（PASS 行数=13，FAIL 行数=0，脚本退出码 0）===
```

### 8.4 可选 PGDG 镜像（**监工真机实测数据，本单复述**）

| 源 | 结果 |
| --- | --- |
| `apt.postgresql.org`（官方，默认） | 可用但约 **6.7 KB/s** ⇒ 装一个包 ~40 分钟 |
| `mirrors.cloud.tencent.com/postgresql/repos/apt` | **HTTP 200，约 930 KB/s** |
| `mirrors.aliyun.com/postgresql/repos/apt` | **HTTP 200，约 930 KB/s** |
| 清华 / 中科大对应路径 | **404**（勿用） |

**实现**：新增 `GENGYUN_PGDG_MIRROR`（别名 `PGDG_MIRROR`）与 `GENGYUN_PGDG_KEY_URL`；
**默认仍是官方源**，切换时脚本**明确打印**实际源；`sources.list` 与会话要求不一致时重写（幂等）；
**换源不改版本口径**（仍是 CI 的 `17.11`）。

### 8.5 本地**未**验证（不写通过）

- 第 5b 的**逐级 `runuser -u postgres -- test -x` 断言**与第 7 节的**口令文件 `test -r` 断言**：
  本机**无 `postgres` 用户**、且需真实安装到该步 ⇒ 本地**未执行**；§8.3 的第 0/1 项用**非 root 用户 mr**
  验证的是**同等穿越语义**（0700 不可穿越 / 0750+属组可穿越），不是脚本内那两行本身。
- 镜像：本机**未真正写 `/etc/apt`**（避免改动 apt 配置），只验证了变量解析与它在 `sources.list` 行中的位置。
- 其余端到端（apt 安装、initdb、systemctl、createdb）仍需在**目标 CVM** 上执行。

## 9 返修 10：真机缺陷 5（`GROUPS` 是 bash 保留数组）+ 缺陷 6（仓库文件对 postgres 不可读）

**背景**：监工在真机上把**整条数据库链**跑通（迁移 10 条、5 组、`20-login-roles.sql`、90- 断言 `ok`、
运行时身份可读 `users` 且越权建表被拒 `permission denied for schema public`），确认迁移门禁、
5 组集合、`evidence_reader` 不授予、口令不轮换语义、90- 断言、越权拒绝**全部按预期**。

### 9.1 缺陷 5：清单变量名 `GROUPS` 与 bash 保留数组冲突

真机原始输出：

```text
[provision-db.sh] 迁移校验通过：10 个版本已全部应用（0001 … 0010）。
[provision-db.sh][ERROR] 缺少既有角色文件 /home/ubuntu/services/api/db/roles/0（工作区不完整）。
provision_exit=1
```

**根因（监工定位，本单以 root 复现确认）**：`GROUPS` 是 **bash 自己维护的特殊数组**（"当前用户所属组"），
**对它的赋值会被 shell 忽略**。用文档要求的 `sudo`（root）执行时它就是 `(0)`（root 的 gid）
⇒ 循环拿到 `entry='0'`、`file='0'` ⇒ 正是 `roles/0`。

本机实测（`audit-reserved-vars2.sh`，EUID=0）：

```console
  GROUPS=(aaa bbb ccc)      -> 展开为: [0]            元素数=1     ← 赋值被忽略
  ROLE_GROUP_FILES=(aaa…)   -> 展开为: [aaa bbb ccc]  元素数=3     ← 改名后正常
```

**修复**：`GROUPS` → **`ROLE_GROUP_FILES`**（定义、`+=`、循环三处同步改），并把根因写进代码注释。

**保留名自查（回复"顺带自查"）**：对 5 个脚本做了两轮扫描（行首 `NAME=`/`NAME+=(`，以及
`local|declare|readonly|typeset|export NAME=`），对照 bash 特殊/只读变量清单
（`BASH*`、`EUID`、`UID`、`FUNCNAME`、`GROUPS`、`IFS`、`LINENO`、`OPTARG/OPTIND`、`PATH`、`PIPESTATUS`、
`RANDOM`、`SECONDS`、`REPLY`、`SECONDS`、`TMPDIR`、`UID`、`PS*`、`HIST*` 等）：

| 结果 | 说明 |
| --- | --- |
| **除 `GROUPS` 外 0 命中** | 5 个脚本**没有**对任何 bash 特殊/只读变量赋值（含 `local` 等形式） |
| 1 处"疑似"命中：`install-postgres.sh` 的 `IFS=. read -r o1 o2 _ _ <<<"$net"` | 这是**作用域限定的命令前缀**（只对该条命令生效，不污染全局 `IFS`），**有意且合法** |
| 只读引用（不改） | `${EUID}`（root 判定）、`${TMPDIR:-/tmp}`（带默认值）、`${PG_*}` 等 |

### 9.2 缺陷 6：脚本假定"仓库文件对 `postgres` 可读"

真机原始输出（把 `GROUPS` 改名变通之后）：

```text
[provision-db.sh] 创建组 gengyun_auth_privacy（执行 services/api/db/roles/auth_privacy.sql）
psql: error: /home/ubuntu/services/api/db/roles/auth_privacy.sql: Permission denied
```

**根因**：脚本用 `runuser -u postgres -- psql -f <仓库内文件>`，而云主机上仓库常在 `/home/<user>`
（默认 `0750 <user>:<user>`）⇒ `postgres` 连目录都穿越不了。

**修复（选了"规避"，而不是要求放宽权限）**：新增 `stage_sql_file()`，把要执行的 SQL
**复制到 postgres 可读的临时目录**（`mktemp -d` + `0700 postgres`，文件 `0600 postgres`），
执行后由 `EXIT trap` 删除。**不要求 `chmod 777`、也不要求改家目录权限。**
覆盖了三处喂文件的调用点：

| 位置 | 原写法 | 现写法 |
| --- | --- | --- |
| `provision-db.sh`（角色循环，7 个文件） | `-f "${ROLES_DIR}/${file}"` | 先 `stage_sql_file` 再 `-f "$staged_role_sql"` |
| `provision-db.sh`（`20-login-roles.sql`） | `-f "${SQL_DIR}/20-login-roles.sql"` | 先暂存再 `-f "$staged_login_sql"` |
| `provision-db.sh` / `verify-cvm-postgres.sh`（`90-assert-…sql`） | `qfile`/`-f "${SQL_DIR}/90-…"` | `qfile` 内部暂存；verify 里先暂存再 `-f "$staged_assert_sql"` |

**顺带加固**（本轮真跑暴露）：`stage_sql_file` 里 `mktemp/chown/chmod/cp` 任一失败**都返回非 0**
并打印明确错误（原先末尾是 `printf`，前面的失败会被"最后一条命令成功"掩盖）。同时把
`provision-db.sh` 里 `[[ … == '1' ]] && log …` 改为显式 `if/else`（条件不成立时该语句返回 1，
在 `set -e` 下会**静默中止**整个脚本，且没有任何报错信息）。

### 9.3 回归（**root 身份真跑**，原始输出见下；工具桩化、未改动系统）

```
=== R1：以 root 真跑 provision-db.sh（假 psql）到角色循环 ===
（预检：本机 0 用户；GROUPS 当前值=[0] —— 证明 root 下它被 shell 维护，无法用于清单）
[provision-db.sh] 迁移校验通过：10 个版本已全部应用（0001 … 0010）。
[provision-db.sh] 创建组 gengyun_auth_privacy（执行 services/api/db/roles/auth_privacy.sql）
[provision-db.sh] 创建组 gengyun_preview_reader（执行 …catalog_readers.sql）
[provision-db.sh] 创建组 gengyun_consent_granter（执行 …consent_granter.sql）
[provision-db.sh] 创建组 gengyun_profile_runtime（执行 …profile_runtime.sql）
[provision-db.sh] 创建组 gengyun_knowledge_runtime（执行 …knowledge_runtime.sql）
[provision-db.sh] 执行 sql/20-login-roles.sql（…）
[provision-db.sh] 最小权限断言通过：ok
[provision-db.sh] 完成（PLAN_ONLY=0, WITH_CLI_GROUPS=0）。
provision_exit=0   迭代到的预期角色数=5
PASS R1a 迭代的是 5 个预期条目   PASS R1b 不得出现 roles/0   PASS R1c 走到断言步骤

=== R2：角色目录不存在/为空 ⇒ 目录级清晰报错（不再 …/roles/0）===
[provision-db.sh][ERROR] 既有角色目录不存在：/tmp/w19-fake-repo/services/api/db/roles
         本脚本按路径**复用**仓库里的 7 个角色 SQL（不复制、不重写）。请确认：…
[provision-db.sh][ERROR] 既有角色目录为空（无 *.sql）：…（工作区不完整）。
PASS R2a 报"角色目录不存在"   PASS R2b 不得出现 roles/0   PASS R2c 空目录报"目录为空"

=== R3：缺陷 6 规避 —— 仓库位于 postgres **不可穿越**的目录时仍能执行 ===
/tmp/w19-nohome 权限=700 root:root（模拟 /home/<user> 0750/0700）
[provision-db.sh] 创建组 gengyun_auth_privacy（…）… 5 条
迭代到=5；exit=0
PASS R3a 无 Permission denied   PASS R3b 仍迭代 5 个预期条目

=== 返修 10 回归结论：全部 PASS ===
```

**用例名与覆盖**：`R1` root 下真跑到角色循环并把整条流程走完（`provision_exit=0`），
断言迭代的是 **5 个预期条目**（`创建组 <role>` ×5）且**不出现 `roles/0`**；
`R2` 角色目录**不存在**与**为空**两种情形各自给出目录级清晰报错；
`R3` 仓库放在 `0700`（`postgres` 不可穿越）的目录下仍能执行全部 SQL、**无 `Permission denied`**。

### 9.4 本地**未**验证 / 测试脚手架的边界（不写通过）

- 本机**没有 `postgres` 用户**，故回测用 `runuser`/`chown` **垫片**替代（真机上这两条命令是真实的、
  且 `stage_sql_file` 现在会把它们的失败**当作致命错误**报出）。
- 假 `psql`/`pg_isready` 只回答 `provision-db.sh` 需要的那几条查询，**不验证 SQL 语义**；
  SQL 语义的权威证据仍来自监工真机（§9 背景）与 §4 的真实 PG 证据。
- 回测创建的 `/usr/lib/postgresql/17/bin` 与临时目录**已删除**（仅当原本不存在时才删）。

## 10 返修 11：`verify-cvm-postgres.sh` 的 6 条判据缺陷 + 2 处静默中止隐患

**背景（监工真机）**：`verify-cvm-postgres.sh --runtime-password-env …` 报 `PASS=31 FAIL=6 SKIP=1`；
6 条 FAIL 全是**判据写法**问题，**配置本身是对的**（监工已逐条取证：`psql` 实测 `t|t`／`true|true`；
运行时直读两个投影均 `exit=0` 且 `has_table_privilege=true`；组角色分工正确）。

### 10.1 6 条判据的病因与修法（**不放宽任何安全语义**）

| 判据 | 真机 FAIL | 病因 | 修法 |
| --- | --- | --- | --- |
| `server_version` | 期望 `17.11` 实际 `17.11 (Ubuntu 17.11-1.pgdg22.04+2)` | 拿 `SHOW server_version` 的**整串**做等值比较 | 改查 `substring(current_setting('server_version') from '^[0-9]+\.[0-9]+')` ⇒ 只比主.次 |
| `runtime_role_attrs` | 期望 `t\|t\|f…` 实际 `true\|true\|false…` | 用 `\|\|` 拼接布尔列 ⇒ 走 `bool::text` 语义得到 `true/false` | 新增 `_tf()`（`CASE WHEN … THEN 't' ELSE 'f' END`）逐列转换 ⇒ 与期望字面量**一致** |
| `runtime_password_scram` | 期望 `t` 实际 `true` | 同上（`(… LIKE …)::text`） | 用 `_tf` |
| `runtime_not_owner_member` | 期望 `f` 实际 `false` | 同上（`pg_has_role(…)::text`） | 用 `_tf` |
| `runtime_can_read_home_species` | 期望非负整数 实际（空/空白） | **`as_runtime()` 漏了 `-tA`** ⇒ 拿到的是**对齐表格**（表头/分隔线/`(1 row)`）而不是裸数字 | `as_runtime` 补 `-tA`；新增 `report_num_runtime()`：失败时**把原始输出打到 stderr** |
| `runtime_can_read_current_knowledge` | 同上 | 同上 | 同上 |

> **"为何为空"的定位（回复监工第 3 点）**：直接病因是 `as_runtime` **缺少 `-tA`**，
> 输出是对齐表格而非裸数字；调用方再 `tail -n1` 就得到表尾（或一个带前导空格的值，读数时像"空"）。
> 现已 `-tA` + 显式取最后一行数字，且**失败时打印原始输出** ⇒ 下次一眼可见。

### 10.2 顺带发现并修掉的 2 处**静默中止**（同类隐患，会让"汇总"整段消失）

1. `read -r DATA_SRC DATA_MNT <<<"$(df -P …)"`：数据目录父级不存在时 `df` 失败 ⇒ 输入为空 ⇒
   `read` 返回 1 ⇒ 在 `set -e` 下**整个脚本中止**（stdout 连汇总都没有）。已改为显式判目录 +
   `|| true`，并把"父级不存在"作为**一条失败判据**报出（不再假 PASS、也不再中止）。
2. `find … | sort -nr | head -1 | awk …`（第 9 节备份探测）：`set -o pipefail` 下 `head` 提前退出
   会让上游收到 **SIGPIPE(141)**（或 `find` 因目录不存在而失败）⇒ 管道非零 ⇒ `set -e` 中止。
   已改为先判目录 + `awk 'NR==1{print $2}'`（不提前关闭管道）+ `|| true`；
   同类 `sed … | head -1` 也在 `restore-drill.sh: manifest_get()` 与 verify 的清单读取处改为 `awk`。

### 10.3 回归（**用监工真机实测原值回放**，跑的是**真实的** `verify-cvm-postgres.sh`）

```console
### 跑真实 verify-cvm-postgres.sh（假 psql；无 --remote-host ⇒ 预期 1 个 SKIP）
PASS server_version                        期望=17.11 实际=17.11
PASS runtime_role_attrs                    期望=t|t|f|f|f|f|f 实际=t|t|f|f|f|f|f
PASS runtime_password_scram                期望=t 实际=t
PASS runtime_not_owner_member              期望=f 实际=f
PASS runtime_can_read_home_species         期望=非负整数 实际=0
PASS runtime_can_read_current_knowledge    期望=非负整数 实际=0
=== 返修 11 回归结论：6 条判据全部 PASS ===
```

**边界（不夸大）**：该回归用**桩** `psql` 回放监工给的**真机数值**，证明的是
"**判据写法与取值路径已正确**"（6/6 转 PASS），**不等于**"真实 PG 上整体 0 FAIL"——
后者须由监工在**含本修复的 SHA** 上真跑作为权威证据。桩环境下其余判据因取不到值而 FAIL
（本回归**只断言这 6 条**）。

## 11 返修 12：`backup-postgres.sh` 的"假失败"（成功产出 dump 却 `exit 1`）

### 11.1 裁定：**是缺陷，不是刻意**（已修）

真机现象（监工）：`backup-postgres.sh` 成功产出 dump（随后 `restore-drill.sh` 用它跑出【通过】），
但脚本**退出码为 1**。根因：

```bash
cleanup_partial() { [[ -f "$TMP_DUMP" ]] && rm -f -- "$TMP_DUMP"; }
trap cleanup_partial EXIT
```

**成功路径**上 `$TMP_DUMP` 已被 `mv` 成正式 dump ⇒ `[[ -f … ]]` 为**假** ⇒ `&&` 短路 ⇒ 函数返回 **1**
⇒ **EXIT trap 的退出码覆盖了脚本退出码** ⇒ 备份成功却 `exit 1`。
（与返修 8 的"假成功"互为镜像：那是失败报 0，这是**成功报 1**。）

**修法**：`if [[ -f "$TMP_DUMP" ]]; then rm -f -- "$TMP_DUMP"; fi; return 0`。
**并把退出码语义写进脚本头部与 runbook**：`backup` 的 `0` = 备份动作成功且通过可读性校验，
**不等于**"可恢复"——可恢复性只能由 `restore-drill.sh` 证明。

### 11.2 回归（**改前/改后对照**，真实脚本 + 桩；本机 root）

```console
=== 1) 改前对照（同目录临时副本把 trap 还原成旧写法）===
    [backup-postgres.sh] 备份完成并通过可读性校验：
    旧写法 exit=1                      ← 复现监工看到的现象（dump 已产出却 exit 1）
=== 2) 修复版（真实脚本）===
    [backup-postgres.sh] 备份完成并通过可读性校验：
    [backup-postgres.sh]   文件      : /tmp/w19-bk-new/gengyun-gengyun-….dump
    修复版 exit=0
PASS 改前复现：dump 已产出但 exit=1（正是监工看到的现象）
PASS 修复版：备份成功后 exit=0
PASS dump 已产出   PASS 清单已产出   PASS 打印了成功日志
=== 返修 12 回归结论：全部 PASS ===
```

**边界**：`pg_dump/pg_restore/psql` 为桩（`pg_dump` 只写几个字节）；本回归证明的是
"**退出码语义正确**"（改前 1、改后 0），**不**证明真实 dump 内容（那由监工真机的 `restore-drill`【通过】证明）。

## 12 监工**权威证据**：无变通的完整链（**已绑定 SHA `939670c`**）

监工先把服务器**恢复到"未加变通"的状态**（删 `/etc/gengyun`、删 `/data/gengyun/pgdata`、
`/home/ubuntu` 收回 `0750`），再上传脚本包直接跑，**不再使用**任何变通
（`chgrp/chmod` 私密目录、清残留、`GROUPS` 改名、放开家目录权限）。

### 12.1 脚本指纹绑定（**本单已逐项核对：三个指纹与仓库内容完全一致**）

监工给出的指纹，与本单在 HEAD `939670c` 工作区（= 提交内容，LF）计算的 `sha256sum` **一致**：

| 脚本 | sha256（监工服务器 = 本单 `939670c`） | 核对 |
| --- | --- | --- |
| `backup-postgres.sh` | `baf1dcdb2e0c0fba6b9ecf3440cb08a5e70325af22853bae27157494e662755a` | ✅ **MATCH** |
| `restore-drill.sh` | `3960d6e252184bdf380d97f1da8ad53cfd03506d0f97997669a28a9a5e4c2121` | ✅ **MATCH** |
| `verify-cvm-postgres.sh` | `8bfcdb5ce323c6a8de9cd025c84968b6403408b4492cf44c16cfc278efdea810` | ✅ **MATCH** |

> ⇒ 服务器上被验证的**就是**仓库 `939670c` 的这三个文件（逐字节相同），
> 因此下面的结论**可以绑定到该 SHA**，不存在"验的不是同一份代码"的问题。

### 12.2 在 `939670c` 上复跑的三条（**原始输出**）

| 环节 | 真机原始结果 | 判定 |
| --- | --- | --- |
| `backup-postgres.sh` | `backup_exit=0`；`dump=/data/gengyun/backup/gengyun-gengyun-20261013T125657Z.dump`；`manifest: -rw------- 1 root root 947B …T125657Z.dump.manifest.txt` | ✅ **返修 12 在真机生效**（此前 `exit=1`）；备份动作成功，**不等于**"可恢复" |
| `restore-drill.sh --dump <上一步 dump> --recreate` | `restore_exit=0`；`PASS=24 FAIL=0`；`[restore-drill.sh] 结论：恢复演练【通过】。` | ✅ **唯一可作为"备份可恢复"的证据** |
| `verify-cvm-postgres.sh --runtime-password-env GENGYUN_API_RUNTIME_PASSWORD` | `verify_exit=2`；`PASS=39 FAIL=0 SKIP=1`；`SKIP remote_vpc_tcp_open 未给 --remote-host；同 VPC 另一台机的连通性未测` | ✅ **返修 11 在真机生效**（FAIL `6 → 0`、PASS `31 → 39`）；`exit=2` = **无失败但有缺项 ⇒ 证据不完整**，不得当通过 |

### 12.3 无变通完整链的其余环节（install / migrate / provision）

这三个环节是在 `5e75c86` 上跑的；**`install-postgres.sh` 与 `provision-db.sh` 在
`5e75c86 → 939670c` 之间未被改动**（`git diff` 为空）⇒ 其结论对**两个 SHA 等值成立**。

| 环节 | 真机原始结果 |
| --- | --- |
| `install-postgres.sh` | `INSTALL_EXIT=0`；仅 `10.21.1.8:5432` + `127.0.0.1:5432` 监听；**收尾校验通过**；**私密目录 `/etc/gengyun` = `drwxr-x--- root:postgres`，postgres 两级 `test -x` 通过**（⇒ 缺陷 3 已修） |
| `migrate.ts up` | `up_exit=0`，已应用 `0001…0010` |
| `provision-db.sh` | **家目录保持 `0750`**：无 `Permission denied`、**无 `roles/0`**；创建 5 组 → `20-login-roles` 就位并授予 5 组 → 90- 断言 `ok` → `provision_exit=0`（⇒ 缺陷 5/6 **双双生效**） |
| 复核 | `migrations=10`、`tables=41`、`gengyun_api_runtime` `login=true super=false`、`groups=5` |

### 12.4 唯一剩余缺项（**尚未证明**，不得写成通过）

| 缺项 | 含义 | 谁来补 |
| --- | --- | --- |
| `remote_vpc_tcp_open`（`verify` 的 `SKIP`） | **云托管实例 → `10.21.1.8:5432` 的真实连通**未测（需要同 VPC 另一台机器/云托管探针） | 用户 webshell 探活，或 API 部署后用业务冒烟证明 |

> 因此本交付当前的口径是：**PG 侧内网姿态与最小权限已在真机验证；"云托管能否连到库"仍属未证明**。
> **未部署、未验收（整项）**的结论保持不变。

**仍属"变通运行"（不得混入权威证据）**：此前几轮的 `chgrp/chmod /etc/gengyun`（缺陷 3）、
清半初始化数据目录（缺陷 4）、`sed` 改名 `GROUPS→ROLE_FILES`（缺陷 5）、
`chmod 755 /home/ubuntu` + `a+rX`（缺陷 6）——**均已被返修 9/10 从脚本层面消除**。
