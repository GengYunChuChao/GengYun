# 到期清除的调度层（#19 · 在线 7 日 / 备份 30 日）

本目录是**部署产物**：把两条到期清除命令挂到**宿主机时钟**上。它不含业务代码、不含迁移、
不含凭据。命令本体在 `tools/`，驱动模块在 `services/api/src/privacy/`，本目录只负责「谁来按点叫它」。

```
deploy/purge-schedule/
├── gengyun-purge-online-data.service     # 在线数据 7 日到期清除（owner/运维角色）
├── gengyun-purge-online-data.timer       # 每 10 分钟
├── gengyun-purge-backup-copies.service   # 备份副本 30 日到期清除（运行时角色）
├── gengyun-purge-backup-copies.timer     # 每 15 分钟（:05/:20/:35/:50，与上一条错开）
├── crontab.example                       # 等价 crontab（与上面 4 件二选一；安装前置见「安装 4B」）
└── README.md
```

## 为什么放在 `deploy/purge-schedule/`（而不是 `deploy/postgres-cvm/conf/`）

- `deploy/postgres-cvm/conf/` 是**目标 CVM 上的 PostgreSQL 服务端**配置（`10-gengyun-postgres.conf`、
  `pg_hba`、`gengyun-postgresql.service` …），由 `install-postgres.sh` 的 sed 渲染器逐 token 渲染，
  并被 `tests/unit/deploy-pg-conf-guard.test.mjs` 按**占位符契约**钉住。把两条清理单元的
  `EnvironmentFile=` / `User=` 塞进去会同时污染那份契约（新增 token ⇒ 那条守卫红）与「PG 服务端」
  这个语义边界。
- 这两条单元跑在**应用/运维宿主机**上（能连到库即可，不要求在库主机上），角色、用户、状态目录都与
  PG 服务端无关 ⇒ 单独一个目录，谁引用都不会误以为是 PG 服务端的一部分。
- 目录名直接给出判据入口的扫描面：`tools/verify-purge-schedule.mjs` 默认只扫本目录的
  `*.service` / `*.timer`（`--dir` 可改，供负控制用）。

## 两条命令的角色差异（本目录唯一一处「两条不一样」）

| 单元 | 命令 | DB 角色 | 依据 |
| --- | --- | --- | --- |
| `gengyun-purge-online-data` | `tools/purge-expired-online-data.mjs` | **属主/运维角色**（必填） | 候选查询要读 `public.deletion_requests`，运行时角色对该表零表级零列级权限（`90-assert-least-privilege.sql` 第 48 项）⇒ 运行时角色跑必然 `42501`（`online-purge-driver.ts` 文件头「需要的数据库角色」） |
| `gengyun-purge-backup-copies` | `tools/purge-expired-backup-copies.mjs` | **运行时角色即可** | 用到的列全在 `gengyun_api_runtime` 的列级授权里（`20-login-roles.sql` 的 `gy-i19-backup-copies-grant` 段），真库臂 `backup-copies-purge-pg.mjs` 就是用运行时角色实测的 |

两条都⛔ **不以 root 运行**：OS 侧与 DB 侧各自按最小权限收敛，两层不互相替代。

## 安装（两条路线共用的准备 ＋ systemd / cron 二选一）

> 下面的 `useradd` / `install -d` 是 **Linux（Debian/Ubuntu）** 命令。本片在 Windows 上开发，
> 这些命令**没有**在目标宿主上实跑过 —— 这一点也写在文末「本目录不证明的事」。

### 0) 专用系统用户（**必须带 `--user-group`**）

```bash
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin gengyun-ops
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin gengyun-app
```

两个单元里有 `Group=gengyun-ops` / `Group=gengyun-app` ⇒ 宿主上必须有**同名组**可指。`--user-group`
会建同名主组（Debian/Ubuntu 的 `USERGROUPS_ENAB` 常见为 yes，但不保证）；若宿主已用别的组名，
就**删掉单元里的 `Group=`**，让 systemd 复用该用户的主组 —— ⛔ 不要留一个不存在的组名（单元会直接
起不来）。装完用 `id gengyun-ops` / `id gengyun-app` 复核主组名。⚠️ 本机是 Windows，**无法验证宿主的
组行为**；`useradd` 是否建同名组以目标宿主的 `login.defs` / `useradd` 默认为准。

### 1) 状态目录（两条路线都要；cron 路线**必须**手工建）

```bash
# systemd 路线：StateDirectory= 会自动创建并 chown；cron 路线不会 ⇒ 统一在这里建，两条路线都成立。
sudo install -d -m 0700 -o gengyun-ops -g gengyun-ops /var/lib/gengyun-purge-online-data
sudo install -d -m 0700 -o gengyun-app -g gengyun-app /var/lib/gengyun-purge-backup-copies
```

`/var/lib/gengyun-purge-online-data/` 里放**在线游标**与 **cron 的锁文件**；
`/var/lib/gengyun-purge-backup-copies/` 里放 **cron 的锁文件**。两处都必须是**该用户可写**——
cron 的 `flock` 由该用户自己创建/打开锁文件，放到 `/run`（root:root 0755）会直接 `Permission denied`，
`node` 一步都跑不到（锁文件不需要预建，首次运行时由该用户创建）。

### 2) 凭据：每条命令一个环境文件

```bash
# 目录必须**可被运行用户穿过**（traverse）：0755 root:root。只暴露文件名，内容由文件权限挡着；
# 若建成 0750 root:root，cron 路线即使把文件设成 0640 也打不开（目录缺 others 的 x 位）。
sudo install -d -m 0755 -o root -g root /etc/gengyun

# systemd 路线（PID 1 以 root 读入后再降权执行）⇒ root:root 0600 即可：
sudo install -m 0600 -o root -g root /dev/null /etc/gengyun/purge-online-data.env
sudo install -m 0600 -o root -g root /dev/null /etc/gengyun/purge-backup-copies.env

# cron 路线（由**该用户自己的 shell** `. <env 文件>` 读入）⇒ 必须让该用户可读：
sudo install -m 0640 -o root -g gengyun-ops /dev/null /etc/gengyun/purge-online-data.env
sudo install -m 0640 -o root -g gengyun-app /dev/null /etc/gengyun/purge-backup-copies.env
```

> 两条路线**只选一条**，环境文件权限按所选路线设：systemd 的 `EnvironmentFile=` 由 PID 1 读（0600 够）；
> cron 的 `. <文件>` 是**普通用户进程**在跑（0600 会 EACCES，必须 0640）。
> 然后由持钥人把连接串写进对应文件（键名只有一个，命令只认环境变量）：
>   `purge-online-data.env`   ← owner/运维角色的连接串
>   `purge-backup-copies.env` ← 运行时角色的连接串
> ⛔ 不要写进单元、crontab、README、issue 或任何提交物。

### 3) 日志目录（**只有 cron 路线需要**）

```bash
sudo install -d -m 0750 -o gengyun-ops -g gengyun-ops /var/log/gengyun-ops
sudo install -d -m 0750 -o gengyun-app -g gengyun-app /var/log/gengyun-app
```

cron 的 `>> …` 重定向由**该用户**执行 ⇒ 日志**按用户分目录**、各自 owner 可写（否则第二条备份命令以
`gengyun-app` 写 `gengyun-ops` 的目录就是 EACCES）。systemd 路线看 journal，不需要这两个目录。
⚠️ 日志不会自动轮转，长期跑请给这两个目录配 `logrotate`。

### 4A) systemd 路线（推荐）

```bash
sudo install -m 0644 gengyun-purge-online-data.service gengyun-purge-online-data.timer \
                    gengyun-purge-backup-copies.service gengyun-purge-backup-copies.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gengyun-purge-online-data.timer gengyun-purge-backup-copies.timer
```

### 4B) cron 路线（备选；与 4A **二选一**）

前置：上面的 §0 用户、§1 状态目录、§2 的 **cron 版**环境文件（`0640 root:gengyun-*`）、§3 日志目录，
四样都建好之后再装 crontab：

```bash
sudo install -m 0644 -o root -g root crontab.example /etc/cron.d/gengyun-purge
# 若之前装过 timer（二选一，不能同时开）：
sudo systemctl disable --now gengyun-purge-online-data.timer gengyun-purge-backup-copies.timer
```

`/etc/cron.d/gengyun-purge` 由 **root** 安装；文件里**第 6 列是用户**，两条命令各自以对应单元的同一个
`User=` 运行（在线=`gengyun-ops`，备份=`gengyun-app`），⛔ 不是 root。逐项对应与前置条件的完整清单在
`crontab.example` 的头注释里；判读见下。

`/opt/gengyun/app` 是本目录假设的**应用根**（`ExecStart=` 与 `--cursor-file=` 都按它写死绝对路径）。
换了部署路径，四处要一起改：两个 `ExecStart=`、一个 `--cursor-file=`、一个 `WorkingDirectory=`，
改完跑一次 `node tools/verify-purge-schedule.mjs`（它按**后缀**比对 npm script 的入口文件，
所以换根不改名不会被判红；`--cursor-file` 的绝对性则是硬判据）。

## 判读

### systemd 路线

```bash
systemctl list-timers 'gengyun-purge-*'                  # 下一次触发时间 / 上次触发
journalctl -u gengyun-purge-online-data.service -n 50    # 单次运行日志
systemctl status gengyun-purge-online-data.service        # 上次运行的退出状态（failed 要看这里）
```

### cron 路线

```bash
tail -n 5 /var/log/gengyun-ops/purge-online-data.log
grep -c 'EXITCODE=1' /var/log/gengyun-ops/purge-online-data.log   # >0 ⇒ 有人要来看
```

cron 没有 systemd 的 failed 单元状态：命令自己把 `EXITCODE=<n>` 写进日志；`flock` 拿不到锁的那一轮
**不会**打印 `EXITCODE`（它根本没跑，不是失败）。

退出码语义（两条命令一致，也是外部调度的**唯一**判据）：

| 码 | 含义 | 该做什么 |
| --- | --- | --- |
| `0` | 本轮无失败行（含 0 个到期项——重跑第二轮就是 0 行） | 无需动作 |
| `1` | 有失败行/组（某个模块清不掉） | 看日志定位；下一整轮会再试 |
| `2` | 参数/配置/连接类错误（缺环境变量、`42501`、`42P01` …） | 修配置；**不是**「没有到期数据」 |

## crontab 等价形态（与 systemd timer 二选一）

`crontab.example` 是同一件事的 `/etc/cron.d/` 写法（带用户列）。逐项对应：入口文件同一个、
凭据走 `. <env 文件>`（等价 `EnvironmentFile=`，但**权限要求不同**：cron 需要 `root:<同名组> 0640`）、
游标给绝对路径、`flock -n` 等价 oneshot 单实例（锁文件放在**该用户自己的状态目录**，⛔ 不是 `/run`）、
`*/10` 与 `5-59/15` 与 `OnCalendar` 同周期。前置目录（状态/日志）与属主、权限见「安装 4B」与
`crontab.example` 头注释。⛔ 与 systemd timer **二选一**，不要两条一起装。

## 门禁（本目录的判据是机器化的，不是「写了就行」）

```bash
node tools/verify-purge-schedule.mjs          # 退出码 0 通过 / 1 有硬错 / 2 用法错误
node tools/verify-purge-schedule.mjs --json   # 机读
npm run verify:purge-schedule                 # 等价入口
```

判据（每条都会 `FAIL[<id>]` 点名文件）：`surface`（扫到 0 个单元也算红）/ `pair`（service ↔ timer 配对）/
`calendar`（有 `OnCalendar=` 或 `OnUnitActiveSec=`，且**展开日历**算出的最大间隔 ≤ 60 分钟）/
`execstart`（`ExecStart=` 目标**绝对路径**、指向**树上真实存在**的文件、且与 `package.json` 对应 script
**同一个入口文件**）/ `cursor`（在线单元必须带**绝对路径** `--cursor-file`，且不得用 `--no-cursor`；
与 `StateDirectory=` 比对前先做 POSIX 归一化，`..` 穿越会被判红）/ `secrets`（单元里不得出现内联连接串
或口令键——含 `*PASS*`/`*PWD*`/`*SECRET*`/`*TOKEN*`/`*APIKEY*`/`*DSN*`/`*URL*` 这类键名与
`Environment=DB_PASS=…` 形态；必须 `EnvironmentFile=`）/ `setinterval`
（`services/api/src/**` 里 `setInterval(` 调用计数必须为 0，含 `globalThis.setInterval(`、`setInterval (`、
`['setInterval'](` —— 把「无进程内调度器」变成机器可判）/
`npm-script`（`GY-SCHEDULE: npm-script=` 指向的 script 必须存在于 `package.json`）/ `hygiene`
（`User=` 非 root、`StateDirectory=`、`TimeoutStartSec=`）/ `coverage`（两条必需命令都被某个单元覆盖）。

单测：`node --test tests/unit/verify-purge-schedule.test.mjs`（正臂 + 10 个负控制用例 / 14 条控制臂，
已随 `npm run test:unit` 进 CI）。

## 授权来源：本片为什么不写 `docs/verification/**` 证据页

`tests/unit/ci-real-pg-wiring.test.mjs` 的 `SELF_CLUSTERED_SCRIPTS` 注释要求「新增一条时**同时更新证据页**」，
而本片只更新了发布材料索引页（`docs/verification/gy-i24-release-materials-index-20261017.md` 的 `deploy/**`
在册覆盖 —— 那是机器判据），**没有**新增/改动任何证据页。指挥裁定（2026-10-22，R32 返修）：**这不算违约**。
理由：机器判据只认那张索引页（`deploy/**` 在册覆盖）；「证据页」是该能力**首次取得真库读数**时才写的产物，
而本片尚无真库读数（`tests/integration/online-purge-pg.mjs` 本地 exit 77、CI 首次读数未取得），
故证据页归**后续取得 CI 首次读数的片**。本裁定同时写进提交信息，作为授权来源。

## 本目录**不**证明的事（如实登记）

- ⛔ **不证明外部调度真的在跑**。单元文件在仓里，只说明「装上去之后应该按这个周期跑」；
  `systemctl list-timers` 有读数、`/etc/cron.d/gengyun-purge` 存在、日志在长，才算运行侧取得。
  这三项都是**运维动作**，仓库里没有它们的证据，本片也不声称有。
- ⛔ 不证明目标宿主机上 `/opt/gengyun/app` 的路径与本文一致、`node` 在 `/usr/bin/node`；也不证明该目录
  对两个运行用户**可读/可穿过**（两条命令都以非 root 运行，`tools/**` 与 `services/api/src/**` 要能被它们
  读到 —— 属主与权限属部署面，本目录不代管）。
- ⛔ 不证明 README 里的 `useradd` / `install -d` 在目标宿主上真的执行过（本片在 Windows 上开发，只做了
  静态核对）。`Group=` 依赖 `useradd --user-group` 建同名组；cron 路线还依赖状态目录/日志目录的属主与
  权限、以及环境文件的 `0640 root:<同名组>` —— 装完请用 `id`、`ls -ld`、`sudo -u <user> cat <env>` 复核。
- ⛔ 不证明两套角色真的能按上表连上库（那是真库臂 `tests/integration/online-purge-pg.mjs` 与
  `backup-copies-purge-pg.mjs` 的事，它们跑的是**临时集群**，不是生产）。
- ⛔ 调度层到位 ≠ #19 整项达标：本项还含「7 日到期」的受理/回执/审计落地等其它切片。