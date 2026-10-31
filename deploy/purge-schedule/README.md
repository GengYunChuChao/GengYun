# 到期清除的调度层（#19 · 在线 7 日 / 备份 30 日 / 保留策略日级 / #6 媒体对象）

本目录是**部署产物**：把四条到期清除命令挂到**宿主机时钟**上。它不含业务代码、不含迁移、不含凭据。
命令本体在 `tools/`；驱动模块在 `services/api/src/privacy/`（前三类）与 `services/api/src/media/purge-driver.ts`（媒体对象），本目录只负责「谁来按点叫它」。

```
deploy/purge-schedule/
├── gengyun-purge-online-data.{service,timer}     # 在线数据 7 日到期清除（owner/运维角色）· 每 10 分钟
├── gengyun-purge-backup-copies.{service,timer}   # 备份副本 30 日到期清除（运行时角色）· 每 15 分钟（:05/:20/:35/:50，错开上一条）
├── gengyun-purge-retention.{service,timer}       # 保留策略日历到期清除（属主/运维角色，--yes 真执行）· **日级一次**（每天 03:20）
├── gengyun-purge-media-objects.{service,timer}   # 媒体对象回收（属主/运维角色 + 对象存储端口）· 每 15 分钟（:02/:17/:32/:47，错开备份那条）
└── README.md
```

四条 timer 的时间刻度不一样，这是**有意的**：前两条是「按主体的到期窗口」（在线 7 日 / 备份 30 日），
漏一个刻度的代价是数据多留几分钟；第三条是「按日历的保留天数」（1 天 / 30 天尺度），按分钟刻度跑没有意义，**日级一次**就是它的正确刻面；
第四条（媒体对象）回到**时间点**刻度 —— 一条 `initiated` 记录过期后晚一小时回收，就多一小时「用户以为没上传、字节还在」的窗口。
门禁的上界按**命令**分档，见文末「门禁」。

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

## 四条命令的角色差异（本目录唯一一处「每条不一样」）

| 单元 | 命令 | DB 角色 | 依据 |
| --- | --- | --- | --- |
| `gengyun-purge-online-data` | `tools/purge-expired-online-data.mjs` | **属主/运维角色**（必填） | 候选查询要读 `public.deletion_requests`，运行时角色对该表零表级零列级权限（`90-assert-least-privilege.sql` 第 48 项）⇒ 运行时角色跑必然 `42501`（`online-purge-driver.ts` 文件头「需要的数据库角色」） |
| `gengyun-purge-backup-copies` | `tools/purge-expired-backup-copies.mjs` | **运行时角色即可** | 用到的列全在 `gengyun_api_runtime` 的列级授权里（`20-login-roles.sql` 的 `gy-i19-backup-copies-grant` 段），真库臂 `backup-copies-purge-pg.mjs` 就是用运行时角色实测的 |
| `gengyun-purge-retention` | `tools/purge-retention-expired.mjs` | **属主/运维角色**（必填） | 策略表里 `public.sessions` 的 `DELETE` **刻意没给**运行时角色（`services/api/db/roles/auth_privacy.sql:24-26` 只有列级 `SELECT/INSERT/UPDATE`）⇒ 运行时角色跑必然 `PERMISSION_DENIED`、`sessions` 一行不动、退出码 1（真库臂 `retention-purge-pg.mjs` 的受限角色用例就是这个读数） |
| `gengyun-purge-media-objects` | `tools/purge-expired-media.mjs`（每 15 分钟） | **属主/运维角色**（必填） | 回收要写 `public.media` 的对象引用列、删 `public.media_object_cleanup` 的台账行、撤销过期的访问授权（`service.ts` 的 `cleanupOrphans()` 三段都会写）⇒ 这些写面对运行时角色只开了最小权限，回收的写面不在其中；同时它还要**对象存储端口在位**（缺任一项即退 2，不当 0） |

四条都⛔ **不以 root 运行**：OS 侧与 DB 侧各自按最小权限收敛，两层不互相替代。

## 安装（systemd timer 路线；本仓不支持 cron，理由见「为什么不再提供 cron 等价路线」）

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

### 1) 状态目录（游标落点；手工预建与 `StateDirectory=` 效果一致，且幂等）

```bash
# systemd 按单元里的 User=/Group= 自动创建并 chown StateDirectory=；这里手工预建同样的属主/权限，
# 两者结果一致（install -d 对已存在目录幂等，不会清空内容）。
sudo install -d -m 0700 -o gengyun-ops -g gengyun-ops /var/lib/gengyun-purge-online-data
sudo install -d -m 0700 -o gengyun-app -g gengyun-app /var/lib/gengyun-purge-backup-copies
sudo install -d -m 0700 -o gengyun-ops -g gengyun-ops /var/lib/gengyun-purge-retention /var/lib/gengyun-purge-media-objects
```

`/var/lib/gengyun-purge-online-data/` 里放**在线游标**（`ExecStart=` 的 `--cursor-file=` 落点）；
`/var/lib/gengyun-purge-backup-copies/`、`/var/lib/gengyun-purge-retention/` 与 `/var/lib/gengyun-purge-media-objects/`
是各自单元的状态目录（这三条命令当前都不写文件，保留给将来的日志/临时产物一个**非 root 可写**的落点 ——
保留策略那条尤其需要：抄一份 `--json` 报告出去时不该往 `/opt/gengyun/app` 里写）。四处都必须是**该用户可写**：
systemd 会 chown 给 `User=`；手工预建时也必须按上面的 `-o <用户> -g <同名组>` 设属主，否则游标写不进去、每轮退出码 2。
判据 `[cursor]` 会把「`--cursor-file` 归一化后落在 `StateDirectory=` 目录里」钉死。

### 2) 凭据：每条命令一个环境文件（`0600 root:root`）

```bash
# 目录只给 root 写；systemd 由 PID 1（root）读入 EnvironmentFile= 后再降权执行，
# 运行用户**不需要**读这个文件（也就不需要组权限/others 权限）。
sudo install -d -m 0755 -o root -g root /etc/gengyun

# ⚠ 不要用 `install -m 0600 … /dev/null <env>` 建文件：它把 /dev/null 当源，**重复执行会把
# 已写入的连接串截断清空**。这里用 touch（只更新时间戳、不截断）+ chown + chmod 三步，
# 对已存在的文件重跑不会改动内容。
sudo touch /etc/gengyun/purge-online-data.env /etc/gengyun/purge-backup-copies.env /etc/gengyun/purge-retention.env /etc/gengyun/purge-media-objects.env
sudo chown root:root /etc/gengyun/purge-online-data.env /etc/gengyun/purge-backup-copies.env /etc/gengyun/purge-retention.env /etc/gengyun/purge-media-objects.env
sudo chmod 0600 /etc/gengyun/purge-online-data.env /etc/gengyun/purge-backup-copies.env /etc/gengyun/purge-retention.env /etc/gengyun/purge-media-objects.env
```

> 若文件**已存在且已写入连接串**：只复核属主/权限（`ls -l`），⛔ 不要再用任何以 `/dev/null` 为源的 `install` 或 `>` 重定向覆盖它。
> 空文件不会让单元起不来，但命令会以退出码 2（缺 `DATABASE_URL`）落进 journal —— 那是「凭据还没配」，不是「没有到期数据」。
> 然后由持钥人把连接串写进对应文件（键名只有一个，命令只认环境变量）：
>   `purge-online-data.env`   ← owner/运维角色的连接串
>   `purge-backup-copies.env` ← 运行时角色的连接串
>   `purge-retention.env`     ← **属主/运维**角色的连接串（`public.sessions` 的 `DELETE` 只给到这一层）
>   `purge-media-objects.env` ← **属主/运维**角色的连接串 + 对象存储端口（`OBJECT_STORAGE_*` 四个键，缺任一即退 2）
> ⛔ 不要写进单元、README、issue 或任何提交物。

### 3) 日志：走 journald，不需要日志目录

systemd 把单元的 stdout/stderr 收进 journald（`journalctl -u gengyun-purge-*.service`），
**不需要** `/var/log/gengyun-*` 目录，也不需要 `logrotate`（journald 自己按 `SystemMaxUse=` 等策略轮转）。
这是有意的：让「日志落在哪、由谁写、怎么轮转」不再成为部署面的第三个可错点。

### 4) 安装并启用 systemd timer（**唯一受支持路线**）

```bash
sudo install -m 0644 gengyun-purge-online-data.{service,timer} gengyun-purge-backup-copies.{service,timer} \
                    gengyun-purge-retention.{service,timer} gengyun-purge-media-objects.{service,timer} \
                    /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gengyun-purge-online-data.timer gengyun-purge-backup-copies.timer \
                              gengyun-purge-retention.timer gengyun-purge-media-objects.timer
```

`/opt/gengyun/app` 是本目录假设的**应用根**（`ExecStart=` 与 `--cursor-file=` 都按它写死绝对路径）。
换了部署路径，六处要一起改：四个 `ExecStart=`、一个 `--cursor-file=`、一个 `WorkingDirectory=`，
改完跑一次 `node tools/verify-purge-schedule.mjs`（它按**后缀**比对 npm script 的入口文件，
所以换根不改名不会被判红；`--cursor-file` 的绝对性则是硬判据）。

> **保留策略那条的 `--yes` 是硬要求**：`tools/purge-retention-expired.mjs` 默认 **dry-run**，
> 只打印「这一轮该删多少」。单元里写的是 `--yes --json`：`--yes` 让它**真删**，`--json` 让末行是
> 机读原件（含 `cutoff` 与逐表行数，便于按天留存）。⛔ 别在单元里只写 `--json` —— 那会每天绿、
> 每天 0 行，而数据一行都没清（门禁 `[execstart]` 只比对入口文件，不替你检查参数语义，
> 所以这条写在文档里，评审时按它逐字核对 `ExecStart=`）。

## 判读

```bash
systemctl list-timers 'gengyun-purge-*'                  # 下一次触发时间 / 上次触发（四条一起看）
journalctl -u gengyun-purge-online-data.service -n 50    # 单次运行日志
journalctl -u gengyun-purge-retention.service -n 50      # 保留策略：末行是 --json 原件或 FAIL 行
systemctl status gengyun-purge-online-data.service        # 上次运行的退出状态（failed 要看这里）
```

保留策略那条的**失败可见性**与另两条同构：单元不写 `SuccessExitStatus=`、不加吞红开关 ⇒
`systemctl status` 的 `failed` 就是执行器退出码 1/2 的直接投影；`Persistent=true` 只会「补跑漏掉的那一次」，
不会把失败变成成功。日级刻度下「上一次跑是 25 小时前」不比「刚才 failed」更值得关注：**先看 failed**。

退出码语义（四条命令一致，也是外部调度的**唯一**判据）：

| 码 | 含义 | 该做什么 |
| --- | --- | --- |
| `0` | 本轮无失败行（含 0 个到期项——重跑第二轮就是 0 行） | 无需动作 |
| `1` | 有失败行/组（某个模块清不掉） | 看日志定位；下一整轮会再试 |
| `2` | 参数/配置/连接类错误（缺环境变量、`42501`、`42P01` …） | 修配置；**不是**「没有到期数据」 |

## 为什么不再提供 cron 等价路线

R32 曾经给过一份 `deploy/purge-schedule/crontab.example`（`/etc/cron.d/` 写法，带用户列），
**现已删除**，本仓**不再提供**任何 cron 路线文件。原因不是「cron 不好用」，而是这份文件
**在真实宿主上跑不起来，而本机又验不了** —— 连续两轮对抗性审查各查出一族缺陷：

1. **第 1 轮：权限面装不上，`node` 一步都跑不到。** 锁文件写在 `/run`（`root:root 0755`），
   非 root 的运行用户连 `O_CREAT` 都过不了；日志重定向写 `gengyun-ops` 的目录，备份行以
   `gengyun-app` 写就是 `EACCES`。这一族后来按「锁放各自状态目录 / 日志按用户分目录 /
   `/etc/gengyun` 可穿过 / 环境文件 `0640 root:<同名组>`」修过，但它只覆盖了权限面。
2. **第 2 轮：变量根本没进子进程。** 两条命令都是 `sh -c '. /etc/gengyun/purge-*.env; … node …'`，
   却**没有 `set -a`**。按 systemd `EnvironmentFile=` 格式写成的 `DATABASE_URL=…` 被 `.` 读入后
   只是**该 shell 的普通变量**，不会导出给子进程 ⇒ `node` 里 `process.env.DATABASE_URL` 为空 ⇒
   `usageError` ⇒ **退出码 2**（`tools/purge-expired-online-data.mjs`、
   `tools/purge-expired-backup-copies.mjs` 同族）⇒ 仍然是一条都不清。而正确的
   `set -a; . <env>; set +a` 只出现在本仓别处的 `fail` 提示文本里（`deploy/postgres-cvm/provision-db.sh`），
   从未成为这份文件的一部分。
3. **这整类缺陷在本机无法验证。** 没有 Linux 宿主可跑 `useradd` / `install` / `cron` / `flock`；
   `bash -n` 在本机沙箱被禁（MSYS 报 `0xC0000022`），只能靠 POSIX 语义静态推演。一个
   **测不了**、且**两次证明会坏**的可选替代路线，继续写进文档就是埋雷。

⇒ 结论：**systemd timer 路线是唯一受支持路线**。它由门禁 `node tools/verify-purge-schedule.mjs`
（10 项判据）与单测 `tests/unit/verify-purge-schedule.test.mjs` 覆盖，`.service` / `.timer` 就是本目录
**全部**的调度产物。**若运维必须用 cron，属自行承担**：本仓不提供等价件、不为它做正确性承诺，
也不再把「systemd 怎么做、cron 就怎么做」写成对应关系。上面第 1、2 条是**已发生过的真实失败**，
不是假设；两轮的审查结论都在 `.pg17/adv-verdict-*.md` 里留档。

## 门禁（本目录的判据是机器化的，不是「写了就行」）

```bash
node tools/verify-purge-schedule.mjs          # 退出码 0 通过 / 1 有硬错 / 2 用法错误
node tools/verify-purge-schedule.mjs --json   # 机读
npm run verify:purge-schedule                 # 等价入口
```

判据（每条都会 `FAIL[<id>]` 点名文件）：`surface`（扫到 0 个单元也算红）/ `pair`（service ↔ timer 配对）/
`calendar`（有 `OnCalendar=` 或 `OnUnitActiveSec=`，且**展开日历**算出的最大间隔 ≤ **它驱动的那条命令的上界**）/
`execstart`（`ExecStart=` 目标**绝对路径**、指向**树上真实存在**的文件、且与 `package.json` 对应 script
**同一个入口文件**）/ `cursor`（在线单元必须带**绝对路径** `--cursor-file`，且不得用 `--no-cursor`；
与 `StateDirectory=` 比对前先做 POSIX 归一化，`..` 穿越会被判红）/ `secrets`（单元里不得出现内联连接串
或口令键——含 `*PASS*`/`*PWD*`/`*SECRET*`/`*TOKEN*`/`*APIKEY*`/`*DSN*`/`*URL*` 这类键名与
`Environment=DB_PASS=…` 形态；必须 `EnvironmentFile=`）/ `setinterval`
（`services/api/src/**` 里 `setInterval(` 调用计数必须为 0，含 `globalThis.setInterval(`、`setInterval (`、
`['setInterval'](` —— 把「无进程内调度器」变成机器可判）/
`npm-script`（`GY-SCHEDULE: npm-script=` 指向的 script 必须存在于 `package.json`）/ `hygiene`
（`User=` 非 root、`StateDirectory=`、`TimeoutStartSec=`）/ `coverage`（**四条**必需命令都被某个单元覆盖）。

`calendar` 的**分档上界**（`INTERVAL_BUDGET_MINUTES`）写在这里，免得「日级例外」被误读成「随便多稀都行」：

| timer 驱动的入口 | 上界 | 为什么 |
| --- | --- | --- |
| `tools/purge-expired-online-data.mjs` | ≤ **60** 分钟 | 在线 7 日窗口；每天一次 = 最多晚一天清 |
| `tools/purge-expired-backup-copies.mjs` | ≤ **60** 分钟 | 备份 30 日窗口；同上 |
| `tools/purge-retention-expired.mjs` | ≤ **1440** 分钟 | 保留策略是 1 天/30 天尺度的日历保留，日级一次**正好等于**这个上界（多一分钟就红） |
| `tools/purge-expired-media.mjs` | ≤ **60** 分钟 | 媒体行的 `expires_at` 是**时间点**；过期后晚一小时回收就多一小时「字节还在」的窗口（按分钟档，不是日级） |
| 未登记 / `Unit=` 解析不到入口 | ≤ **60** 分钟 | 回落最严一档：新增命令忘了登记，红面比绿面安全 |

⇒ 上界由**入口文件**决定，而 `[execstart]` 已把「单元入口 == package.json script 入口」钉死，
所以想拿日级预算只能真的去驱动那条日级命令：把 `Unit=` 换成分钟级命令、或把入口换成别的脚本，
都会立刻回到 60 分钟并被 `FAIL[calendar]` 点名。

单测：`node --test tests/unit/verify-purge-schedule.test.mjs`（正臂 + **13** 个负控制用例 / **17** 条控制臂，
外加「cron 路线已删除」的仓库回归判据，已随 `npm run test:unit` 进 CI）。与日级那条直接相关的两条负控制：
① 把保留策略 timer 的 `Unit=` 换成分钟级 service ⇒ `最大间隔 1440 分钟 > 60 分钟`；
② 从夹具 `package.json` 删掉 `purge:retention` ⇒ `FAIL[npm-script]`。

## 授权来源：为什么不写 `docs/verification/**` 证据页（只允许动那张机器判据索引页）

`tests/unit/ci-real-pg-wiring.test.mjs` 的 `SELF_CLUSTERED_SCRIPTS` 注释要求「新增一条时**同时更新证据页**」，
而本片只更新了发布材料索引页（`docs/verification/gy-i24-release-materials-index-20261017.md` 的 `deploy/**`
在册覆盖 —— 那是机器判据），**没有**新增/改动任何证据页。指挥裁定（2026-10-22，R32 返修）：**这不算违约**。
理由：机器判据只认那张索引页（`deploy/**` 在册覆盖）；「证据页」是该能力**首次取得真库读数**时才写的产物，
而本片尚无真库读数（`tests/integration/online-purge-pg.mjs` 本地 exit 77、CI 首次读数未取得），
故证据页归**后续取得 CI 首次读数的片**。本裁定同时写进提交信息，作为授权来源。

**R32 第 2 轮返修的范围更正（指挥裁定，2026-10-22）**：删除 `crontab.example` 后，上面那张索引页必须
同步它的在册行与 deploy 计数（否则 `verify-release-materials` 的「路径全部存在」「覆盖全部在册文件」两条
必然红）。指挥把「不改 `docs/verification/**`」收窄为「**不得新增/改动证据页**」：该页是机器判据索引页、
不是证据页，且 `contract-status.json` 与 `#464` 对它**零命中**、被引用的手写行号全部在该页改动点之前
⇒ 允许**仅此一页**做最小必要改动（删 1 行在册记录 + 3 处计数/措辞），文件集合不扩大。本裁定同时写进
提交信息。

## 本目录**不**证明的事（如实登记）

- ⛔ **不证明外部调度真的在跑**。单元文件在仓里，只说明「装上去之后应该按这个周期跑」；
  `systemctl list-timers` 有读数、`journalctl` 里有单次运行日志，才算运行侧取得。
  这两项都是**运维动作**，仓库里没有它们的证据，本片也不声称有。
- ⛔ 不证明目标宿主机上 `/opt/gengyun/app` 的路径与本文一致、`node` 在 `/usr/bin/node`；也不证明该目录
  对两个运行用户**可读/可穿过**（四条命令都以非 root 运行，`tools/**` 与 `services/api/src/**` 要能被它们
  读到 —— 属主与权限属部署面，本目录不代管）。
- ⛔ 不证明 README 里的 `useradd` / `install -d` 在目标宿主上真的执行过（本片在 Windows 上开发，只做了
  静态核对）。`Group=` 依赖 `useradd --user-group` 建同名组；`StateDirectory=` 的属主由 systemd 按
  `User=`/`Group=` 设置，环境文件必须是 `0600 root:root` —— 装完请用 `id`、`ls -ld /var/lib/gengyun-purge-*`、
  `sudo ls -l /etc/gengyun/purge-*.env` 复核（⛔ 运行用户读不到 `0600` 的环境文件是**设计如此**，
  不要为了「能 cat」把它放宽）。
- ⛔ 不证明两套角色真的能按上表连上库（那是真库臂 `tests/integration/online-purge-pg.mjs`、
  `backup-copies-purge-pg.mjs` 与 `retention-purge-pg.mjs` 的事，它们跑的是**临时集群**，不是生产；
  保留策略那条的「受限角色 ⇒ `PERMISSION_DENIED` + `sessions` 一行未动 + 退出码 1」也是在那条臂里测的）。
- ⛔ 不证明保留策略的**日级刻度**在生产上够用：`1 天 / 30 天` 的日历保留按天清是本片的设计判断，
  真库臂只证明「按 cutoff 幂等删除」这件事本身；若将来有天级以下的保留需求，`calendar` 上界要重新定档。
- ⛔ 调度层到位 ≠ #19 整项达标：本项还含「7 日到期」的受理/回执/审计落地等其它切片。
- ⛔ 不证明「桶里到底还剩几个对象」。真实 S3 适配器**不提供**对象枚举（需 list 权限，本片未接线），
  故 `purge:media-objects` 的「清扫后对象计数」在真实适配器下是**未知**（服务层读成 `null`，
  ⛔ 不是 0、也⛔ 不是失败）；这条**诊断**能力缺失不影响「确认删除 / 未确认保留」两本账。