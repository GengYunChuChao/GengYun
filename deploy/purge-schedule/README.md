# 到期清除的调度层（#19 · 在线 7 日 / 备份 30 日）

本目录是**部署产物**：把两条到期清除命令挂到**宿主机时钟**上。它不含业务代码、不含迁移、
不含凭据。命令本体在 `tools/`，驱动模块在 `services/api/src/privacy/`，本目录只负责「谁来按点叫它」。

```
deploy/purge-schedule/
├── gengyun-purge-online-data.service     # 在线数据 7 日到期清除（owner/运维角色）
├── gengyun-purge-online-data.timer       # 每 10 分钟
├── gengyun-purge-backup-copies.service   # 备份副本 30 日到期清除（运行时角色）
├── gengyun-purge-backup-copies.timer     # 每 15 分钟（:05/:20/:35/:50，与上一条错开）
├── crontab.example                       # 等价 crontab（与上面 4 件二选一）
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

## 安装（systemd timer 路线）

```bash
# 1) 专用系统用户（无登录 shell）
sudo useradd --system --no-create-home --shell /usr/sbin/nologin gengyun-ops
sudo useradd --system --no-create-home --shell /usr/sbin/nologin gengyun-app

# 2) 状态目录会由 StateDirectory= 自动创建（/var/lib/gengyun-purge-*，0700，属主=对应 User=）
#    这里只建日志目录（cron 路线才需要；systemd 路线看 journal）
sudo install -d -m 0750 -o gengyun-ops -g gengyun-ops /var/log/gengyun

# 3) 凭据：每条命令一个环境文件，root:root 0600（systemd 以 root 读入后降权执行）
sudo install -d -m 0750 -o root -g root /etc/gengyun
sudo install -m 0600 -o root -g root /dev/null /etc/gengyun/purge-online-data.env
sudo install -m 0600 -o root -g root /dev/null /etc/gengyun/purge-backup-copies.env
# 然后由持钥人把**两行**写进对应文件（键名只有一个，命令只认环境变量）：
#   purge-online-data.env   ← owner/运维角色的连接串
#   purge-backup-copies.env ← 运行时角色的连接串
# ⛔ 不要写进单元、crontab、README、issue 或任何提交物。

# 4) 装单元并启用（只 enable timer；service 由 timer 拉起）
sudo install -m 0644 gengyun-purge-online-data.service gengyun-purge-online-data.timer \
                    gengyun-purge-backup-copies.service gengyun-purge-backup-copies.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gengyun-purge-online-data.timer gengyun-purge-backup-copies.timer
```

`/opt/gengyun/app` 是本目录假设的**应用根**（`ExecStart=` 与 `--cursor-file=` 都按它写死绝对路径）。
换了部署路径，四处要一起改：两个 `ExecStart=`、一个 `--cursor-file=`、一个 `WorkingDirectory=`，
改完跑一次 `node tools/verify-purge-schedule.mjs`（它按**后缀**比对 npm script 的入口文件，
所以换根不改名不会被判红；`--cursor-file` 的绝对性则是硬判据）。

## 判读

```bash
systemctl list-timers 'gengyun-purge-*'                  # 下一次触发时间 / 上次触发
journalctl -u gengyun-purge-online-data.service -n 50    # 单次运行日志
systemctl status gengyun-purge-online-data.service        # 上次运行的退出状态（failed 要看这里）
```

退出码语义（两条命令一致，也是外部调度的**唯一**判据）：

| 码 | 含义 | 该做什么 |
| --- | --- | --- |
| `0` | 本轮无失败行（含 0 个到期项——重跑第二轮就是 0 行） | 无需动作 |
| `1` | 有失败行/组（某个模块清不掉） | 看日志定位；下一整轮会再试 |
| `2` | 参数/配置/连接类错误（缺环境变量、`42501`、`42P01` …） | 修配置；**不是**「没有到期数据」 |

## crontab 等价形态

`crontab.example` 是同一件事的 cron 写法（`/etc/cron.d/` 形态，带用户列）。逐项对应：
入口文件同一个、凭据走 `. <env 文件>`（等价 `EnvironmentFile=`）、游标给绝对路径、
`flock -n` 等价 oneshot 单实例（防重叠）、`*/10` 与 `5-59/15` 与 `OnCalendar` 同周期。
⛔ 与 systemd timer **二选一**，不要两条一起装。

## 门禁（本目录的判据是机器化的，不是「写了就行」）

```bash
node tools/verify-purge-schedule.mjs          # 退出码 0 通过 / 1 有硬错 / 2 用法错误
node tools/verify-purge-schedule.mjs --json   # 机读
npm run verify:purge-schedule                 # 等价入口
```

判据（每条都会 `FAIL[<id>]` 点名文件）：`surface`（扫到 0 个单元也算红）/ `pair`（service ↔ timer 配对）/
`calendar`（有 `OnCalendar=` 或 `OnUnitActiveSec=`，且**展开日历**算出的最大间隔 ≤ 60 分钟）/
`execstart`（`ExecStart=` 目标**绝对路径**、指向**树上真实存在**的文件、且与 `package.json` 对应 script
**同一个入口文件**）/ `cursor`（在线单元必须带**绝对路径** `--cursor-file`，且不得用 `--no-cursor`）/
`secrets`（单元里不得出现内联连接串或口令键，必须 `EnvironmentFile=`）/ `setinterval`
（`services/api/src/**` 里 `setInterval(` 计数必须为 0 —— 把「无进程内调度器」变成机器可判）/
`npm-script`（`GY-SCHEDULE: npm-script=` 指向的 script 必须存在于 `package.json`）/ `hygiene`
（`User=` 非 root、`StateDirectory=`、`TimeoutStartSec=`）/ `coverage`（两条必需命令都被某个单元覆盖）。

单测：`node --test tests/unit/verify-purge-schedule.test.mjs`（正臂 + 负控制，已随 `npm run test:unit` 进 CI）。

## 本目录**不**证明的事（如实登记）

- ⛔ **不证明外部调度真的在跑**。单元文件在仓里，只说明「装上去之后应该按这个周期跑」；
  `systemctl list-timers` 有读数、`/etc/cron.d/gengyun-purge` 存在、日志在长，才算运行侧取得。
  这三项都是**运维动作**，仓库里没有它们的证据，本片也不声称有。
- ⛔ 不证明目标宿主机上 `/opt/gengyun/app` 的路径与本文一致、`node` 在 `/usr/bin/node`。
- ⛔ 不证明两套角色真的能按上表连上库（那是真库臂 `tests/integration/online-purge-pg.mjs` 与
  `backup-copies-purge-pg.mjs` 的事，它们跑的是**临时集群**，不是生产）。
- ⛔ 调度层到位 ≠ #19 整项达标：本项还含「7 日到期」的受理/回执/审计落地等其它切片。