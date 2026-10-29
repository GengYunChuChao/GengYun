# 用途政策导入（`consent_policies`）

运维命令 `tools/import-consent-policy.mjs` 的说明：**把一行仓外的用途政策写进 `public.consent_policies`**。
这是这张表的**唯一写入途径** —— 产品代码、后台路由、迁移种子都没有写过它。

先读[操作三步](#操作三步)与[⛔ 不许做的事](#-不许做的事)；要判断「导入成功是不是等于闸门开了」，读
[与三层闸序的关系](#与三层闸序的关系)与[已登记的依赖](#已登记的依赖recipients-仍是零写入)。

## 这一段闸门现在是什么状态

| 事实 | 依据 |
| --- | --- |
| `public.consent_policies` 存在，但**0 行**、**无生产种子** | 迁移 `services/api/db/migrations/0009_consent_policy.sql` 的头注释「No production policy or recipient seeds.」 |
| 全仓唯一写过这张表的是**测试夹具**（`tests/integration/*-pg.mjs`、`tests/unit/pg-write-idempotency-ttl.test.mjs`） | `git grep -niE "insert into[^\n]*consent_polic\|update[^\n]*consent_policies\|delete from[^\n]*consent_policies"` 的命中全部落在 `tests/` 下 |
| 表空时 `POST /posts`、`POST /me/consents` 直接 403 `CONSENT_REQUIRED`，**审核代码不执行** | `persistConsentGrant`（`services/api/src/privacy/grant-pg.ts`）找不到现行政策行就抛 `CONSENT_REQUIRED` |
| 同一道闸也挂在媒体上传（`media_processing`）、OCR / 识别 / 问答外发（`external_inference`） | 同上；用途闭集见 `CONSENT_PURPOSES`（`services/api/src/privacy/consent-pg.ts`） |

本工具补的就是这条路径。它**只补 `consent_policies` 一侧**，见[已登记的依赖](#已登记的依赖recipients-仍是零写入)。

## 用途

- 让运维能把**仓外**的一份用途政策（含正文）登记成一条可核验的库行：`(purpose, policy_version)` 唯一、
  `content_sha256` 由工具自算、有效期与来源证据齐全；
- 需要时用 `--enable` 把某版本切成该 `purpose` 的**唯一启用行**（部分唯一索引
  `consent_policies_enabled_purpose` 要求同 `purpose` 至多一条）；
- 全程**默认 dry-run**、**幂等**、**单事务**，失败不留半写。

## 操作三步

### 第一步：准备仓外政策清单（JSON，不入仓）

正文**不进仓库**，只有清单文件里的 `body` 字段携带它；工具只把 `sha256` 写进库。字段如下（白名单，
出现别的键一律判 `INVALID_POLICY`）：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `purpose` | 是 | 必须是 `CONSENT_PURPOSES` 闭集成员：`recording` / `media_processing` / `external_inference` / `public_posting` |
| `policy_version` | 是 | 1..80 字符、不含空白、不许是保留哨兵 `unpublished`；必须**严格大于**该 `purpose` 已有的最大版本 |
| `source_kind` | 是 | `verified` 或 `synthetic` |
| `source_ref` | 是 | `verified` ⇒ 无凭据的 `https://` URL；`synthetic` ⇒ `fixture://<路径>` |
| `review_evidence_ref` | 是 | 同上口径 |
| `recipient_bindings` | 否 | JSON 对象，缺省 `{}`；每个值必须齐 `capability` / `config_version` / `policy_version` / `retention_online_days`（≤7）/ `retention_backup_days`（≤30）/ `no_training_evidence_ref` / `deletion_evidence_ref` |
| `body` | 是 | 政策正文；归一化（去 BOM、统一行尾、去尾部空白）后 **≥ 200 码点**，且不得命中占位词（`TODO` / `TBD` / `FIXME` / `lorem` / `ipsum` / `placeholder` / 占位 / 待填 / 待补） |
| `valid_from` | 否 | 带时区的 RFC 3339；缺省由**库里的** `clock_timestamp()` 决定 |
| `valid_until` | 是 | 带时区的 RFC 3339，必须晚于**库里的** `clock_timestamp()`，且晚于 `valid_from` |

⛔ 清单里**不许**出现 `content_sha256`（工具自算）与 `reviewed_by`（复核主体由命令行 `--reviewed-by` 断言，
否则等于让文件给自己签字）。

### 第二步：dry-run 看形状（默认行为，不写库）

```powershell
$env:DATABASE_URL = 'postgresql://<迁移属主或运维角色>:<口令>@<host>:5432/<db>'
node tools/import-consent-policy.mjs policy --file <仓外政策清单.json>
```

输出是稳定的 `key=value` 行，含 `purpose` / `policy_version` / `content_sha256` / `source_kind` / 两个证据引用 /
绑定条数 / `valid_from` / `valid_until` / `reviewed_by` / `enabled_after` / `body_first_line_chars` / `body_chars` /
`action` / `unchanged` / `changed_rows`，可能还有 `warning=` 行。**⛔ 不打印正文**：正文只以「首行长度 + 总长 +
sha256」三项出现。

`action` 的三种取值就是全部可能：`insert`（会插一行）、`enable`（行已在、要把它开起来）、`unchanged`
（同版本同正文且状态已一致 ⇒ 零行改动）。

### 第三步：复核后 `--apply`（要启用就再加 `--enable --reviewed-by`）

```powershell
# 只登记一行草稿（不启用）
node tools/import-consent-policy.mjs policy --file <仓外政策清单.json> --apply

# 登记并把它切成该 purpose 的唯一启用行
node tools/import-consent-policy.mjs policy --file <仓外政策清单.json> --apply --enable --reviewed-by <admin uuid>
```

`--reviewed-by` 指向 `public.admin_accounts.id`，工具会**先在应用层查这一行在不在**（不存在 ⇒ exit 3 并点名），
不把数据库外键抛错当成唯一防线。启用的行必须有 `reviewed_at`，这是 `0009` 的
`CHECK (NOT enabled OR reviewed_at IS NOT NULL)` 决定的。

重复执行同一条命令是安全的：第二次会打印 `unchanged=true`、`changed_rows=0`、`transaction=rollback`，
exit 0 —— 库里**一行都不动**（集成用例比对整行快照与 `xmin` 来证明这一点）。

## 命令行契约

| 子命令 | 状态 | 说明 |
| --- | --- | --- |
| `policy` | 已交付 | 导入一行 `consent_policies` |
| `recipient` | **未交付** | 会以 exit 2 明确拒绝并说明原因，见[已登记的依赖](#已登记的依赖recipients-仍是零写入) |

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--file <path>` | 是 | 仓外政策清单；⛔ 不接受内联正文 |
| `--apply` | 否 | 真正写库；缺省 = dry-run |
| `--enable` | 否 | 导入后把目标版本设为该 `purpose` 唯一启用行 |
| `--reviewed-by <uuid>` | 与 `--enable` 同进同出 | 复核人；只用 `--reviewed-by` 而不 `--enable` ⇒ exit 2 |
| `--help` | 否 | 打印用法 |

## 四类失败码

| 码 | 类别 | 什么时候出现 | 库内状态 |
| --- | --- | --- | --- |
| `0` | 成功 | dry-run 出形状 / `--apply` 落库 / 幂等重放 `unchanged=true` | 成功的写已提交；重放零改动 |
| `2` | `CONFIG` | 缺子命令、未知子命令、`recipient` 未交付、缺 `--file`、清单读不到、JSON 不合法、缺 `DATABASE_URL` | 未连库或未写 |
| `3` | `INVALID_POLICY` | 闭集 purpose 越界、正文空/太短/占位、版本形状或保留值、有效期不合法、清单里带 `content_sha256`/`reviewed_by`、来源或证据形状不符、`verified` 拿夹具措辞冒充、绑定形状不符、绑定指向不存在的 `recipients.id`、复核主体不存在、库内 CHECK 拒绝（`23514`/`23503`/`22P02`） | 事务已回滚 |
| `4` | `POLICY_CONFLICT` | 同 `(purpose, policy_version)` 已存在但正文 sha 不同、版本回退、启用比库里最新版本更旧的版本、唯一约束冲突（`23505`） | 事务已回滚 |
| `5` | `DB_ERROR` | 连不上、缺表（`42P01`）、连接角色无写权限（`42501`）、超时/拿不到锁、未知 SQLSTATE | 事务已回滚 |

报错只给类别、SQLSTATE 与约束名，**⛔ 不回显驱动原文**（可能带主机/用户名/SQL），也**⛔ 不回显连接串**。

## 幂等、单调、单条 enabled 的判据

| 判据 | 规则 | 违反时 |
| --- | --- | --- |
| 幂等 | 同 `(purpose, policy_version)` 且 `content_sha256` 相同、`enabled` 状态已与请求一致 ⇒ `unchanged`，**不执行任何写语句** | 永不为错 |
| 同版本不同正文 | 拒绝，提示改用新的 `policy_version` | exit 4 |
| 版本单调 | 新版本必须**严格大于**该 `purpose` 已有的最大版本（自然序：`v2 < v10`、`2026.10-1 < 2026.10-2`） | exit 4 |
| 单条 enabled | `--enable` 先 `enabled=false` 关掉同 `purpose` 其它行，再开目标行；两者同事务 | 永不为错（复用了部分唯一索引） |
| 不许回退启用 | 目标版本比库里最新版本旧 ⇒ 拒绝启用 | exit 4 |
| 不可变 | 已有行（`reviewed_at` 非空）的正文/版本/sha 一律不改，只改 `enabled` / `updated_at` | 触发器 `23514`，工具不绕过 |

## 与三层闸序的关系

```
① 用途政策闸   consent_policies（enabled + 有效期 + reviewed_at）  ← 本工具写这一层
② 用户授权闸   privacy_epochs / consent_records（每用户每用途的授予与撤回）
③ 外发账本闸   exports / export_writebacks（预留 → 发送 → 回写）
```

本工具**只动第 ① 层**。第 ① 层没开时，第 ② 层的 `POST /me/consents` 与第 ③ 层的所有外发都没有机会执行 ——
`persistConsentGrant` 在第一步就抛 `CONSENT_REQUIRED`。所以「导入了一行政策」意味着「第 ① 层对这个 `purpose`
放行」，**不**意味着任何一次请求已被授权：用户仍要自己授予，撤回仍走既有 epoch 机制。

本工具**不改**第 ② / ③ 层、不改迁移、不改任何授权。

## ⛔ 不许做的事

- ⛔ **不允许运行时角色持有这张表的写权限**，也⛔ **不许改 `services/api/db/roles/*.sql`**：`consent_policies`
  对运行时角色只有 `SELECT`（`consent_granter.sql` 授的），这是刻意的安全不变量，`tests/integration/consent-grant-pg.mjs`
  正在对 `UPDATE` / `INSERT` / `DELETE` 逐条断言 `42501`。
- ⛔ **不许把正文提交进仓库**：正文只活在仓外清单与它 `source_ref` 指向处；测试样品必须显式标注 synthetic。
- ⛔ **不许就地改已有政策行**：换正文只能是新 `policy_version` 新行（`consent_policy_immutable()` 会以 `23514` 挡）。
- ⛔ **不许在清单里传 `content_sha256`**：核验列一旦可以由调用方给，「改了正文 sha 不变」就成了合法输入。
- ⛔ **不许拿 `synthetic` 冒充 `verified`**：工具会按「不存在的域」与「夹具措辞」做启发式拦，但那是启发式，
  不是证明 —— 复核人仍要自己看正文。
- ⛔ **不许用 `--apply` 在生产上跳过 dry-run**：先看形状，再决定写。
- ⛔ **不把「导入了」说成「AI 链路通了」**：见下两节。

## 权限边界：为什么必须是具特权连接

`services/api/db/roles/egress_ledger.sql` 的头注释写着「刻意**不给**：… `recipients`/`consent_policies` 的写入」，
同一份头注释的下一行又写着「Provision a private LOGIN separately. Never run the API as migration owner.」

两句话合起来才完整：**「不给写」约束的是运行时角色**（`gengyun_egress_ledger` / `gengyun_auth_privacy`，
以及被 `GRANT` 给 `gengyun_api_runtime` 的那些组），而「不要拿迁移属主跑 API」说的是**运行时**不许用运维身份。
运维侧那条通道本来就在：`CONSENT_PURPOSES` 的现行政策由**运维导入**，这正是
`services/api/src/privacy/privacy-policy.ts` 文件头写的那句「正文由运维导入的 `consent_policies` 行承载」。

所以本工具的定位是：**走那条已存在的运维/迁移属主通道，不改变运行时角色的最小权限。** 具体承诺：

- 不新增任何 `GRANT` / `REVOKE`；
- 不改 `services/api/db/roles/*.sql`、不改迁移、不建表；
- `DATABASE_URL` 必须指向迁移属主或运维身份；用运行时角色跑会在第一条写语句上 `42501`（exit 5），
  唯一正确的处理是换连接身份，⛔ 不是给它补权限。

本机实测（临时簇 + 真 `0001/0003/0009`）：三张相关表在迁移后**都不播种** —— `consent_policies` 0 行、
`recipients` 0 行、`admin_accounts` **0 行**。⇒ 全新库上要开闸，需要**先有一条后台账号**（`--reviewed-by` 的
外键目标），这不是本工具能替你造的。

## 已登记的依赖：`recipients` 仍是零写入

`public.recipients` 同样**没有生产写入途径**（产品代码/种子/工具都没写过它），而 `external_inference` 这条用途
在授予时必须至少绑一个**已核验**接收方（`persistConsentGrant` 对空接收方、未核验接收方、绑定配置漂移逐条 403）。

⇒ 本片只交付 `policy` 子命令，**`recipient` 子命令未交付**。后果明说：

> **`external_inference` 这条用途目前仍打不开。** 即使把一行 `external_inference` 政策导进库并启用，
> 用户授予时仍会因「对外推理需要已核验接收方」被 403。

工具对「`purpose=external_inference` + 空 `recipient_bindings`」会打印 `warning=` 行（而不是拒绝写入 ——
那属于产品语义，不归本工具裁定）。⛔ 不许把这半个门说成门已开。

## 已知边界：`valid_until` 不进请求期

`valid_until` 只在**授予时**（`persistConsentGrant`）与**读面**（`privacy-policy.ts` 的现行政策查询）被校验；
请求期的授权判断走 epoch，**不再查政策有效期**。因此已授予的用途在政策过期后仍会放行。

**导入工具不能弥补这条。** 它只保证「库里的那一行在导入那一刻形状正确、有效期晚于库钟」；
⛔ 不要拿本工具去宣称「政策有效期已闭环」。

## 证据与复跑

| 想看的 | 命令 |
| --- | --- |
| 纯逻辑 + 真 PG 集成（无 PG 时显式 skip 并打印原因） | `node --test tests/unit/consent-policy-import.test.mjs` |
| 指定本机 PG 二进制（17.x） | `$env:GY_PG_BIN='<...>/pgsql/bin'; node --test tests/unit/consent-policy-import.test.mjs` |
| 指定集群数据根（默认在仓外相邻目录） | `$env:GY_CONSENT_IMPORT_PG_ROOT='<可写目录>'` |

集成用例自带一次性 `initdb` 簇（随机回环端口）、跑真 `0001/0003/0009` 迁移、派生子进程跑真命令，
覆盖 `dry-run → apply → 重放(unchanged) → 失败回滚` 四连，另加版本冲突、绑定指向不存在的接收方、
原地改正文被 `23514` 挡住、以及注入「INSERT 之后的 UPDATE 必红」证明事务整体回滚。
