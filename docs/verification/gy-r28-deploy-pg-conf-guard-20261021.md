# R28-S56 · `deploy/postgres-cvm/conf` 四模板静态守卫（冻结快照 + 安全基线 + 占位符↔渲染器双向一致）

> 切片：R28-S56；分支 `test/gy-r28-deploy-conf-guard`；基点 `76b0e86`（`upstream/main`）。
> 交付物：`tests/unit/deploy-pg-conf-guard.test.mjs`（新增，671 行、75 空行，23 条断言）；本页。
> 缺口一句话：`deploy/postgres-cvm/conf/` 下四份**生产配置模板**（`10-gengyun-postgres.conf` 78 行/33 有效行、`pg_hba.gengyun.conf` 39/6、`pg_ident.gengyun.conf` 19/1、`gengyun-postgresql.service` 47/22）在基点 `76b0e86` 上**零断言覆盖**——把 `ssl` 打开、`pg_hba` 改 `trust`、`listen_addresses` 改 `'*'`、`log_statement` 改 `'all'`，全仓测试一件都不会红（§2 实测）。

**取证范围声明**：本片是**静态**守卫。守卫只读文件文本（`readFileSync`）与 `install-postgres.sh` 的 sed 片段文本，**不启动 PostgreSQL、不执行 `install-postgres.sh`、不连 CVM**。解析函数一律**纯函数**（入参是「文件内容字符串」，不是路径），所以负控制可以在内存里改字符串，不必碰磁盘上的模板。⛔ 本页不得读作「模板已在真实 PG 17 上生效」「`postgres -c` 已接受这些值」「CVM 已验收」；未取得项逐条列在 §7.3。

## 0. 结论摘要

| 项 | 读数 |
|---|---|
| 新守卫 | `node --test --test-concurrency=1 tests/unit/deploy-pg-conf-guard.test.mjs` → `tests 23 / pass 23 / fail 0`，exit **0** |
| 覆盖模板 | 4 份（conf 片段、pg_hba、pg_ident、systemd 单元），全部**只读** |
| 冻结快照 | `10-gengyun-postgres.conf` 有效行 **33 行**逐字冻结 |
| 负控制 | **5/5 能红**，且每条都点名「哪个文件哪一行、被什么值破坏」（§6 附断言消息原文） |
| 双向一致性 | `substitute()` 认 5 个 token；service 由另一段 sed 认 2 个；两向都断言（多认/少认都红） |
| 门禁 | 7/7 exit **0**（§8） |
| 本片不改 | 四模板、`install-postgres.sh`、源码、集成测试、workflow **一个字节都没动** |

## 1. 范围

### 1.1 做了什么

1. 新增 [`tests/unit/deploy-pg-conf-guard.test.mjs`](../../tests/unit/deploy-pg-conf-guard.test.mjs)：纯函数解析器 + 六组断言 + 五条负控制（细节见 §4、§6）。
2. 本页：记录缺口实测、冻结快照、模板↔渲染器对应表、负控制的红在哪、诚实标注、门禁读数。

### 1.2 没做什么（边界）

- 没有改 `deploy/postgres-cvm/conf/` 下任何模板（四份**只读**）。
- 没有改 [`deploy/postgres-cvm/install-postgres.sh`](../../deploy/postgres-cvm/install-postgres.sh)（只在守卫里**读**它的 `substitute()` 与单元渲染 sed）。
- 没有改 `services/**`、`apps/**`、`packages/**`、`tests/integration/**`、`.github/**`。
- 没有放宽任何既有断言，也没有删测试。
- 没有引入新依赖（`node:test`、`node:assert/strict`、`node:fs`、`node:path` 均为内置）。
- 没有 push、没有建 PR、没有改 git config。

## 2. 缺口实测（先证明「真的没人盯」）

### 2.1 基点上没有任何测试读这四份模板

```text
git grep -n -e '10-gengyun-postgres' -e 'pg_hba.gengyun' -e 'pg_ident.gengyun' -e 'gengyun-postgresql.service' 76b0e86 -- tests/
76b0e86:tests/integration/backup-purge-pg.mjs:115: * （本仓 `deploy/postgres-cvm/conf/10-gengyun-postgres.conf:36` 显式写这个值、并在注释里说明
```

全仓 `tests/` 在基点上对这四份文件只有**一条注释里的提及**（`backup-purge-pg.mjs:115`，说明某个值为什么是它的值），**零断言**。也就是说：模板的语义完全靠人读，改坏了不会红。

### 2.2 行数（两种独立取数，结果一致）

```text
# 物理行 / 有效行（有效行 = trim 后非空、且不以 # 开头）
node -e "…split('\n').filter(l=>{const t=l.trim();return t!==''&&!t.startsWith('#')}).length"
```

| 模板 | 物理行 | 有效行（实测） | 派单表数字 | 差异 |
|---|---|---|---|---|
| `10-gengyun-postgres.conf` | 78 | **33** | 31 | **+2（见 §7.2）** |
| `pg_hba.gengyun.conf` | 39 | 6 | 6 | 0 |
| `pg_ident.gengyun.conf` | 19 | 1 | 1 | 0 |
| `gengyun-postgresql.service` | 47 | 22 | 22 | 0 |

（`service` 的 22 行含 `[Unit]`/`[Service]`/`[Install]` 三个段头；本守卫的字段断言只认 `Key=Value`，段头只进快照类断言。）

### 2.3 四类「本该红」的改动，基点上都不会红

派单点名的四个改法，本片逐一在内存夹具里做成了负控制或正控制旁证：

| 改法 | 基点 | 本片守卫 |
|---|---|---|
| `ssl = off` → 打开 | 不红 | 快照红（文本变了）；⚠️ 语义见 §7.1 |
| `pg_hba` 回环行 `scram-sha-256` → `trust` | 不红 | `（3）` 规则面红，点名行号与规则原文（§6 负控制 1） |
| `listen_addresses` → `'*'` | 不红 | `（2）` listen_addresses 断言红（§6 负控制 2） |
| `log_statement` `'none'` → `'all'` | 不红 | `（2）` 日志隐私面红（快照 + 语义双红） |

## 3. 冻结快照（`10-gengyun-postgres.conf` 的 33 条有效行，逐字）

守卫用 `assert.deepEqual(effectiveLines(confText), CONF_EFFECTIVE_SNAPSHOT)` 比对**原始顺序、行内空格原样**。这样任何增删改（哪怕只是把 `'UTC'` 改成 `'utc'`）都会红，并打印 diff 指向具体行；改模板必须同步改这份快照——这是**显式更新**，不是静默漂移。

```ini
listen_addresses = '127.0.0.1,@VPC_PRIVATE_IP@'
port = @PGPORT@
data_directory = '@PGDATA@'
hba_file = '@PGDATA@/pg_hba.conf'
ident_file = '@PGDATA@/pg_ident.conf'
unix_socket_directories = '/var/run/postgresql'
unix_socket_permissions = 0770
password_encryption = 'scram-sha-256'
ssl = off
max_connections = 100
superuser_reserved_connections = 3
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%a.log'
log_rotation_age = 1d
log_rotation_size = 0
log_truncate_on_rotation = on
log_line_prefix = '%m [%p] %q%u@%d %h '
log_timezone = 'UTC'
log_statement = 'none'
log_min_duration_statement = 1000
log_connections = on
log_disconnections = on
log_checkpoints = on
timezone = 'UTC'
datestyle = 'iso, mdy'
lc_messages = 'C'
lc_monetary = 'C'
lc_numeric = 'C'
lc_time = 'C'
default_text_search_config = 'pg_catalog.english'
wal_level = replica
archive_mode = off
```

## 4. 六组断言的分工

设计原则：**快照管「有没有变」，语义管「变的方向安不安全」**。两者不互相顶替——只看快照，改坏了也要人读 diff 才知道危险；只看语义，`datestyle`、`lc_time` 这类「不危险但重要」的漂移就看不见。

| 组 | 条数 | 判什么 | 红了意味着 |
|---|---|---|---|
| （1）冻结快照 | 1 | 33 条有效行逐字、按序 | 模板被改过（任何字符） |
| （2）安全基线语义 | 5 | 监听面、口令/套接字、日志隐私、时区本地化、连接数上限 | 值被改到不安全区间（与快照是否同步无关） |
| （3）pg_hba 规则面 | 6 | 方法闭集、local 行、回环两条、VPC 两条、**末条 reject**、无公网段 | 有人加了 `trust`/`md5`，或把默认拒绝删了/挪了位置 |
| （4）pg_ident | 1 | 恰好 1 条 `gengyun_ops postgres gengyun_cvm_owner`、无通配符 | 映射被放宽成 `all` 或通配 |
| （5）systemd 单元字段 | 1 | `Type`/`User`/`Group`/`RuntimeDirectory`/`RuntimeDirectoryMode`/`Restart`/`ExecStart`/`WantedBy`/`RequiresMountsFor` 逐字 | 单元跑成别的用户、别的数据目录、或重启策略失效 |
| （6）占位符↔渲染器双向 | 4 | `substitute()` 的 token 集合、三模板有效行 token ⊆ 那 5 个、service 的 2 个 token 与它那段 sed 对齐、反向每个 token 都被用到 | 模板写了渲染器不认的 `@XXX@`（渲染后字面量进生产配置），或渲染器认了没人用的 token（脚本与模板脱节） |

**（3）为什么「末条必须是 reject」单独一条**：PG 的 `pg_hba` 是**首条匹配生效**，末尾 `host all all 10.21.0.0/16 reject` 是「网段内其余库/身份一律拒绝」的默认拒绝线。删掉或挪到前面，规则面其余断言（方法闭集、地址闭集）**仍然全绿**——所以它必须是顺序敏感的单条断言（§6 负控制 4 就是删它）。

**（2）里没有一条断言「`ssl = off` 是好是坏」**：见 §7.1。

## 5. 模板 ↔ 渲染器对应表

`install-postgres.sh` 用**两段不同**的 sed 渲染这四份模板，认的 token 也不同。守卫把两段都冻住了，任何一侧改动都会红：

| 模板 | 谁渲染（行号为基点 `76b0e86`） | 认的占位符 | 守卫断言 |
|---|---|---|---|
| `10-gengyun-postgres.conf` | `substitute()`（L512-523），调用点 L537 | `@PGDATA@ @PGPORT@ @VPC_PRIVATE_IP@ @CVM_HOSTNAME@ @DB_NAME@` | 有效行 token ⊆ 5 个（`（6）` 第 2 条） |
| `pg_hba.gengyun.conf` | 同上，调用点 L539 | 同上 5 个 | 有效行 token ⊆ 5 个（实为 `@DB_NAME@`） |
| `pg_ident.gengyun.conf` | 同上，调用点 L541 | 同上 5 个 | 有效行 token ⊆ 5 个（实为 0 个） |
| `gengyun-postgresql.service` | **另一段** sed：L569-570（先替换 `@PGDATA@`、再替换 `@PG_BIN@`） | `@PGDATA@ @PG_BIN@` | 有效行 token **恰好**等于 2 个，且这段 sed 也恰好认这 2 个（`（6）` 第 3 条） |

`substitute()` 原文（L514-520，逐字）：

```bash
  sed \
    -e "s|@PGDATA@|${PGDATA_DIR}|g" \
    -e "s|@PGPORT@|${PGPORT}|g" \
    -e "s|@VPC_PRIVATE_IP@|${VPC_PRIVATE_IP}|g" \
    -e "s|@CVM_HOSTNAME@|${CVM_HOSTNAME}|g" \
    -e "s|@DB_NAME@|${DB_NAME}|g" \
    -- "$src" >"$dst"
```

**为什么必须双向**：只查「模板 token ⊆ 渲染器 token」时，渲染器删掉一个 sed 行**不会红**（模板里用到的那个 token 就静静地不被替换、字面量进生产配置）；只查「渲染器 token ⊆ 模板用到的」时，模板写了个渲染器不认识的 `@XXX@` 也不会红。本守卫两向都断言，且两个方向都各有负控制（§6 负控制 3、5）。

## 6. 五条负控制（内存夹具，不碰磁盘）

每条都先跑**真实文件**作正控制（证明守卫在当前内容上是绿的，不是「永远红」的空测试），再在内存里做一处替换、断言 `assert.throws` 且匹配**具体消息**（不是「随便抛个错就算过」）。

| # | 内存夹具改动 | 红在哪条断言 |
|---|---|---|
| 1 | `pg_hba.gengyun.conf:27` 的 `scram-sha-256` → `trust` | （3）规则面：方法闭集 |
| 2 | `listen_addresses` → `'*'` | （2）listen_addresses 只允许回环 + VPC 私网 |
| 3 | `10-gengyun-postgres.conf` 有效行里的 `@VPC_PRIVATE_IP@` → `@NOT_RENDERED@` | （6）有效行 token ⊆ `substitute()` 的 5 个 |
| 4 | 删掉 `pg_hba.gengyun.conf:38` 的 `reject` 行 | （3）末条默认拒绝（顺序敏感） |
| 5 | 从 `substitute()` 里删掉 `@DB_NAME@` 的 sed 行 | （6）`substitute()` token 集合冻结 |

五条负控制**实际抛出的断言消息**（探针按字节打印，非手抄）：

```text
### 负控制 1：pg_hba 回环行 scram-sha-256 -> trust
deploy/postgres-cvm/conf/pg_hba.gengyun.conf:27 出现被禁的认证方法 trust（禁 trust/md5/password/ident/gss）：host        all         all                     127.0.0.1/32        trust

### 负控制 2：listen_addresses -> '*'
deploy/postgres-cvm/conf/10-gengyun-postgres.conf:24 listen_addresses 含 '*' ⇒ 进程会监听公网地址（值='*'）

### 负控制 3：模板有效行 token -> @NOT_RENDERED@
deploy/postgres-cvm/conf/10-gengyun-postgres.conf 的有效行出现 substitute() 不认识的占位符 ["@NOT_RENDERED@"]：渲染后这些 @XXX@ 会以字面量留在生产配置里

### 负控制 4：删掉 pg_hba 的 reject 行
deploy/postgres-cvm/conf/pg_hba.gengyun.conf:34 最后一条规则必须是 `host all all 10.21.0.0/16 reject`（默认拒绝、顺序敏感），实际 `host @DB_NAME@ gengyun_api_runtime 10.21.0.0/16 scram-sha-256`

### 负控制 5：substitute() 删掉 @DB_NAME@ 的 sed 行
deploy/postgres-cvm/install-postgres.sh 的 substitute() token 集合与冻结的 5 个不一致：新增 []、删除 ["@DB_NAME@"]；增删 token 必须显式更新 tests/unit/deploy-pg-conf-guard.test.mjs 与本文件头注释
```

两条夹具构造的坑（记下来，避免后来人重踩）：

1. 负控制 3 必须用 `replaceAll` 而不是 `replace`：`@VPC_PRIVATE_IP@` 在 `10-gengyun-postgres.conf` 的**注释块里也出现一次**（第 12 行），只换首个会换到注释上（注释不在「有效行」口径内），于是断言不红——测试会用 `assert.notEqual(mutated, confText)` 兜住这种「夹具没造对」。
2. 负控制 4 删行后，末条变成 `:34` 的 `gengyun_api_runtime` 行；断言消息里报的是「实际 `…`」，所以能看出「不是 reject」。删行用的是 `/^host\s+all\s+all\s+10\.21\.0\.0\/16\s+reject[^\n]*\n/m`，不会误删 `10.21.0.0/16` 的两条授权行。

## 7. 诚实标注（这节比结论重要）

### 7.1 `ssl = off` 与 `archive_mode = off` 是冻结现状，本片不做裁定

- `10-gengyun-postgres.conf:44` 是 `ssl = off`；`:77` 是 `archive_mode = off`。
- 本片对这两个值的态度：**冻结，不评判**。它们进 §3 的逐字快照（所以被改会红），但 §4 的 `（2）` 安全基线语义里**没有**任何断言说「`ssl = off` 正确」或「`archive_mode` 必须是 `off`」。
- 为什么不裁定：这两个值的安全取舍取决于部署拓扑（是否只走 VPC 私网 / 是否有腾讯云 CLB 终结 TLS / 备份与 PITR 方案是否依赖 WAL 归档），**单看模板定不了对错**；本片是「加守卫」，不是「改基线」，擅自把它们判成缺陷或判成合规都会越权。
- 如果后续切片要改这两个值，正确动作是：改模板 + 同步更新 §3 快照（快照红会强制你这么做）+ 在那一片的派单里给出裁定依据。

### 7.2 三处口径取舍（都会影响「红/绿」，必须写明）

1. **`pg_hba` 的「无公网段」只在有效规则行上判，不在全文判**。该文件第 7 行的**注释**本身写着「不要写 `0.0.0.0/0` 和 `::/0`」——若按「全文不得出现」判，注释会把自己判红。所以口径是「有效规则行的第 4 段地址不得是 `0.0.0.0/0` 或 `::/0`」。`（3）` 第 1 条另有**地址闭集**（只允许 `127.0.0.1/32`、`::1/128`、`10.21.0.0/16`），比「不含某两个串」更严。
2. **反向覆盖（渲染器的每个 token 都被模板用到）的 `@CVM_HOSTNAME@` 按「全文」判**。实测它今天只在 `10-gengyun-postgres.conf` 的注释块里出现（第 21 行附近），有效行里不用它。若反向覆盖也按「有效行」判，这条会永远红（渲染器认它但没人用）。守卫做法：`TOKEN_PRESENCE_SCOPE` 把 `@CVM_HOSTNAME@` 显式标成 `full`，其余 4 个标 `effective`，并有断言保证「作用域表的键集合 == 那 5 个 token」——作用域表本身被删/漏键也会红。这条是**口径妥协**，不是「模板真的在用 `@CVM_HOSTNAME@`」。
3. **有效行 33 vs 派单表 31**：派单表写 `78 行 / 31 有效行`，实测两种独立取数（node 的 `split('\n').filter`、PowerShell 的 `-split "`n" | Where-Object`）都是 **33**，且 33 个 key 无重复、无「不含 `=` 的行」。差异 2 行的来源无法从当前工作树复原（派单可能是手数或按另一种口径数的）。本片的处理：**冻结实测的 33**，并在 `（1）` 的测试名里写明「33 行」；没有为了凑派单数字去改模板（⛔ 模板只读）。

### 7.3 没取得的东西

1. **没有用真实 PG 17 校验这些值**：没有 `postgres -c listen_addresses=…`、没有 `pg_ctl start`、没有 `pg_hba_file_rules`。所以「这些值 PG 会不会接受/会不会按预期生效」不在本页证据范围内。
2. **没有执行 `install-postgres.sh`**（Linux/root 专用：`runuser`、Unix socket、`postgres` 系统用户、持久盘挂载）。§5 的 sed 对应关系是**读文本**得出的，没有跑过真实渲染。
3. **不覆盖 sed 在真实 shell 里的转义**：`substitute()` 里 `s|@XXX@|${VAR}|g` 的 `|` 作分隔符意味着「值里含 `|` 会破坏替换」，本守卫只看 token 集合，**不测**这一点。
4. **不覆盖 `pg_hba` 的语义正确性**（比如「`10.21.0.0/16` 是否等于 CVM 真实网段」）——那要连 CVM 查网卡，属运行期验收。
5. **systemd 单元没有 `systemd-analyze verify`**：本机是 Windows，没有 systemd。字段断言只保证「关键字段逐字在那」，不保证「systemd 接受这份单元」。
6. **没有端到端验证**：本页读数停在「静态文本 + 纯函数单测 + 负控制」，**不等于** CVM 部署验收通过。

## 8. 门禁读数

| 命令 | exit | 读数（原始末行） |
|---|---|---|
| `node --test --test-concurrency=1 tests/unit/deploy-pg-conf-guard.test.mjs` | **0** | `ℹ tests 23` / `ℹ pass 23` / `ℹ fail 0` |
| `npm run lint` | **0** | `lint 通过（静态检查；不代表运行期或真实服务已通过）。` |
| `npm run test:docs` | **0** | `PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住` |
| `node tools/verify-release-materials.mjs` | **0** | `15/15 项通过（离线文档核验；不代表部署、云端或运行期已验收）` |
| `node tools/verify-contract-status.mjs` | **0** | `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` |
| `git diff --check` | **0** | （无输出） |
| `git status --porcelain` | — | 提交前只有本片的两个新文件（`?? tests/unit/deploy-pg-conf-guard.test.mjs`、`?? docs/verification/gy-r28-deploy-pg-conf-guard-20261021.md`） |

## 9. 复跑方式

```bash
# 守卫（必须 --test-concurrency=1：守卫读固定路径，且负控制改的是内存副本）
node --test --test-concurrency=1 tests/unit/deploy-pg-conf-guard.test.mjs

# 缺口复核：基点上 tests/ 对四模板只有一条注释提及
git grep -n -e '10-gengyun-postgres' -e 'pg_hba.gengyun' -e 'pg_ident.gengyun' -e 'gengyun-postgresql.service' 76b0e86 -- tests/

# 有效行计数（两种独立取数）
node -e "const t=require('fs').readFileSync('deploy/postgres-cvm/conf/10-gengyun-postgres.conf','utf8');console.log(t.split('\n').filter(l=>{const s=l.trim();return s!==''&&!s.startsWith('#')}).length)"

# 门禁
npm run lint && npm run test:docs \
  && node tools/verify-release-materials.mjs && node tools/verify-contract-status.mjs
```
