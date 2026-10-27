# GY-R64：后台审计读面闭集补 `post.hide`，并给 `entity=post` 加动作护栏

- **片**：`#18` S2 之后「后台审计读面闭集」这一片（承接 `#652` 把闭集扩到七值、`#656` 让下架审计真落库）
- **基线**：`a92e0180`（`9b909fb0`（#656）+ `merge --no-ff e112ff67`（#652）的本地合流，仅作本片开发基线；交付前 rebase 到 main）
- **分支**：`feat/gy-r64-audit-closed-set-post`
- **日期**：2026-10-27
- **一句话结论**：`0047` 已经在同一个下架事务里写 `action='post.hide'` / `scope='sources:write'`，但审计读面（`GET /admin/audit-logs`）的 action 闭集只有七值、entity 闭集只有四个 —— **写进去了却查不出来**。本片把 `post.hide` 补成第 8 个 action、`post` 补成第 5 个 entity，并给 `entity=post` 加一层**动作护栏**：`entity=post` 恒等于 `action='post.hide'`，护栏外的合法 action 一律 **400 fail-closed**（⛔ 不返回「恒空页」）。

---

## 1 口径：读面闭集不是「白名单装饰」，是「能不能如实回答」

`public.admin_audit_events` 里此刻就有真行。`GET /admin/audit-logs` 的 `?action=` / `?entity=` 都是**闭集校验**（`services/api/src/admin/audit/service.ts` 的 `parseActionParam` / `parseEntityParam`），闭集外的取值直接 400 —— 也就是说，闭集漏登记一个值，等于让一个**已经落库的事实**在 HTTP 读面上不可表达。

所以本片不是「顺手多开放一个筛选值」，而是：`0047` 那一行写进了表，读面必须能**看见**它、也必须能**按它筛**。闭集与写入点必须同源，否则「审计里没有」这句话就成了假话。

---

## 2 三条取舍

### 2.1 为什么 `entity=post` 需要**动作护栏**，而不是只加一个 scope 映射

`AUDIT_ENTITY_SCOPES` 的其余四个键都是「一个 entity ⇔ 一个专属 scope」：`account`→`accounts:suspend`、`flag`→`flags:write`、`job`→`jobs:cancel`、`admin_scope`→`scopes:write`。照抄这个形状给 `post` 配 `sources:write` 是**错**的，理由是实测出来的，不是推测：

- `0041`（`admin_scope.grant` / `admin_scope.revoke`）与 `0046`（`admin_scope.deny`）都把**被授予的 scope 本身**直接写进 `scope` 列（实读三处 `INSERT INTO public.admin_audit_events`：写的是 `p_scope`，`target_ref` 为 `NULL`，`target_hint='admin_account:<id>'`）。
- 于是管理员「授予某人 `sources:write`」时，落库行的 `scope` 就是 `'sources:write'` —— 与下架行的 `scope` **逐字相同**。
- 若 `entity=post` 只映射成 `scopes:['sources:write']`，那个结果集里就会混进**权限变更行**，而界面上这一页标着「帖子相关」。这比空页更难发现：读者会以为「平台确实对这些帖子做过处置」。

护栏把 `entity=post` 收窄成 `action='post.hide'`。`services/api/src/admin/audit/catalog.ts:198-212` 是护栏表与读取函数（`actionsOfAuditEntity` 在**缺席时返回 `null`** = 「该实体没有护栏」，不是「零个 action」）；`:45-75` 的文件头整节记录上面这段论证。

### 2.2 为什么护栏外的 action 是 **400**，而不是静默取交集

`entity=post&action=set_flag` 有两种「不报错」的写法，两种都是假话：

| 写法 | 实际返回 | 为什么是假话 |
| --- | --- | --- |
| 按护栏算（`actions=['post.hide']` ∩ `set_flag` = 空） | 一页空结果 | 空页被读成「平台从未发生过这类操作」，而真相是**这个组合不可查询** |
| 不按护栏算（`scopes=['sources:write']` + `actions=['set_flag']`） | 一页 flag 域行 | 标着 post 的读面吐出别的域的事实 = 错误命名 |

所以护栏外一律 `INVALID_REQUEST` + `{ field: 'action', code: 'enum' }`（沿用该路由既有的非法参数形态，**没有新造错误码**）。落点 `services/api/src/admin/audit/service.ts:215-228`：护栏判定在 `parseEntityParam` 之后、`watermark` 之前，因此**不会产生任何端口调用**（单测钉住 `port.calls.length === 3` 对应三次护栏外请求，见 §4）。

### 2.3 为什么护栏在**服务层**，而不是塞进 `0033` 的 SQL

`0033` 的 `public.list_admin_audit_logs(...)` 是**通用**读函数，`p_scopes` × `p_actions` 的「交集」语义对 `account`/`flag`/`job`/`admin_scope` 四个实体都成立（一个实体一个专属 scope）。`post` 的问题不是「查不出来」，而是「这个 entity 名字不该覆盖整个 scope」。把 `post` 的特例写进迁移函数会：

- 让一个通用函数里出现一个实体的**命名策略**（策略会变，SQL 函数不该跟着变）；
- 且本片边界里**不允许改 `services/api/db/migrations/**`**，护栏放在 `catalog.ts` + `service.ts` 是唯一合法落点。

代价：护栏是**应用层**约定，裸 SQL 直查 `list_admin_audit_logs(p_scopes=>ARRAY['sources:write'])` 仍会拿到权限行。这是有意的 —— 那个函数是「按 scope 筛」，它没承诺「按 entity 筛」；entity 语义只在 HTTP 层存在。

---

## 3 改动清单

| 文件 | 改了什么 |
| --- | --- |
| `services/api/src/admin/audit/catalog.ts` | 第 8 个 action 常量 `AUDIT_ACTION_POST_HIDE`（`:120`）并追加进 `AUDIT_ACTIONS` 末位（`:123-132`）；`AUDIT_ENTITY_SCOPES` 追加第 5 键 `post: 'sources:write'`（`:172`）；新增 `AUDIT_ENTITY_ACTION_GUARDS`（`:198-202`）与 `actionsOfAuditEntity`（`:210-212`）；文件头补「为什么 `post` 需要动作护栏」（`:45-75`）；修掉指向不存在文件 `tests/unit/admin-audit-logs-contract.test.mjs` 的假引用，改为 `tests/unit/admin-audit-logs.test.mjs` 与 `tests/unit/ai-ops-ledger-pins.test.mjs` |
| `services/api/src/admin/audit/service.ts` | import `actionsOfAuditEntity`；`:215-228` 护栏块（护栏外 400、`actions` 由护栏或 `?action=` 得出）；`:255-256` 端口入参改传 `actions` + 原 scope 映射 |
| `packages/contracts/openapi.json` | 只动 `listAuditLogs`：`action` 枚举追加 `"post.hide"`（`:11016`）、`entity` 枚举追加 `"post"`（`:11030`）、`description`（`:10971`）补一句「`entity=post` 只返回 `post.hide`…与护栏外的 `action` 组合时是 400 而不是空页」 |
| `tests/unit/admin-audit-logs.test.mjs` | 闭集/scope 断言跟到 5 值；「`entity:'post'` ⇒ 400」翻成 `entity:'comment'`（保住「闭集外 400」这条钉）；新增「4c. 动作护栏」用例（七组断言，含零端口调用与 `operations.json` 的 `listAuditLogs.scope === 'audit:read'`） |
| `tests/unit/ai-ops-ledger-pins.test.mjs` | 钉子④的 `order` / `runtime` 两个字面清单各追加第 8 项；注释把「变异 M3」里原本拿 `post.hide` 当假想新值的写法改掉（它现在是真的了） |
| `tests/unit/admin-audit-action-jobs-cancel.test.mjs` | `(d)` 的 entity-scope 排序断言跟到 5 值；「前 4 项及顺序不变」的措辞与注释同步 |
| `tests/unit/community-audit-channel-pins.test.mjs` | 钉④翻转：由「post 域动作必须为空」改成「恰好 `['post.hide']`」，并新增反向核「库内含 `'post.hide'` 的 `INSERT INTO public.admin_audit_events` 恰在 `0047` 一处」；`FLIP_GUIDE` 与文件头「翻钉进度」同步（钉⑥仍未翻，它测的是内存端口） |
| `tests/integration/admin-community-posts-pg.mjs` | 迁移子集补 `0027`+`0033`（9 段）；新增 `[A]` 段真库读数（权限行夹具 + 六组断言）；文件头与结尾读数清单同步 |
| `tests/unit/migration-subset-coverage-pins.test.mjs` | `EXPECTED_DEMANDS` 追加 `0027` 的 `after_value`/`before_value` 两条（22→24 / 28→30）；说明 `0027` 是硬依赖（`0033` 是 `LANGUAGE sql`，函数体在 `CREATE` 时校验列存在） |
| `docs/verification/r59-community-notify-dedupe-20261026.md`、`docs/verification/r59-community-premoderation-20261026.md` | 契约锚点由 `11299` 改到 `11301`（`packages/contracts/openapi.json` 里 `"/admin/posts": {` 那一行）：本片给 openapi 净增 2 行，该行整体下移；不改数字就会指到右括号行 |
| `docs/architecture/ai-ops-spec-status.md` | 复核后在同一提交内同步「现状页」三行：E31 由七条写路径改八条、表注释七行/`AUDIT_ACTIONS` 七值改八行/八值、写点表锚点跟到新表尾并补第 8 行 `record_admin_post_hide_audit`；E40 由「恰七值」改「恰八值」（`post.hide` 在末位即第 8 位）、闭集锚点跟到数组新位置、契约 action/entity 枚举数与区间按实测重指、用例行号按实测重指；N02 由「七行已由 #609 补上」改「#609 补到七行、本版再补第八行」。`:29` 的 #609 历史叙述（「恰四值」）按要求不动 |
| `apps/admin/src/lib/admin-audit-logs.mjs`、`tests/unit/admin-ui-audit-logs.test.mjs` | 前端镜像同步到 **8 动作 / 5 实体**：动作表尾追加 `post.hide`、实体表尾追加 `post`、两条中文标签（下架社区内容／社区内容）、`AUDIT_LOG_ENTITY_SCOPES` 补 `post: 'sources:write'` 并注明该串不专属、前端不复制护栏；单测的**计数钉**按等价扩张改（7→8、4→5），原「闭集外」例子 `post.hide` 换成 `post.approve`（前者已合法） |

---

## 4 门禁读数（全部 exit 0）

| 门禁 | 读数 |
| --- | --- |
| `node tools/verify-migrations-unique.mjs` | `PASS：5 项判据全部满足`，exit 0（46 条正向迁移 / 45 条配对 / 缺号 0037 有依据） |
| `node tools/verify-contract-status.mjs` | `PASS: 覆盖 124 条契约操作；已装配 124 条`，exit 0（`--reanchor` dry-run：`无可重定位项`，302 条带行号锚点全在 ±2 容差内） |
| `node tools/verify-doc-anchors.mjs --strict` | `基线外新增 0 条`，exit 0（修 R59 两处锚点前为 exit 1、新增 2 条 SUSPECT） |
| `node tools/openapi-route-parity.mjs` | `mounted 125 / contract 124 / implemented 124 / extra 0 / missing 0 / ledgerDrift 0`，exit 0 |
| `python tools/validate_contracts.py` | `PASS: 124 operations; contract consistency; 29 fixtures; 30 media traces`，exit 0 |
| `python tools/validate_development_docs.py` | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping`，exit 0 |
| `node --test tests/unit/admin-audit-logs.test.mjs` | `10 tests / 10 pass / 0 fail` |
| `node --test tests/unit/admin-audit-action-jobs-cancel.test.mjs` | 见 §5 合并读数 |
| `node --test tests/unit/ai-ops-ledger-pins.test.mjs` | 同上（三文件合计 `17 pass / 0 fail`） |
| `node --test tests/unit/community-audit-channel-pins.test.mjs` | 同上 |
| `node --test tests/unit/migration-subset-coverage-pins.test.mjs` | `10 tests / 10 pass / 0 fail` |
| `node --test tests/unit/migration-last-pin-consistency.test.mjs`、`migration-reservations.test.mjs`、`ci-integration-chain-structure.test.mjs`、`admin-ui-audit-logs.test.mjs` | 四文件合计 `40 tests / 40 pass / 0 fail` |
| `npm run test:unit`（`GY_BASH=C:\msys64\usr\bin\bash.exe`） | `5157 tests / 5154 pass / 0 fail / 1 skipped / 2 todo`，exit 0（日志里的 `AssertionError` 文本来自 `tests/unit/i11-audio-mp3-wav-guard.test.mjs:206` 那条 **todo**，不是 fail） |

---

## 5 真库臂读数（PG 17.11 / 端口 55440 / `tests/integration/admin-community-posts-pg.mjs`）

`MIGRATIONS = 0001+0017+0022+0027+0030+0032+0033+0045+0047`（9 段，按目录序）。`[M]` 段读数：`迁移子集 … 逐条 apply 成功、二连跑 0 条（目录共 46 个迁移，版本号无重复）`。

`[A]` 段先插一条**权限行夹具**（`action='admin_scope.grant'`、`scope='sources:write'`、`target_ref=NULL`、`target_hint='admin_account:<id>'`、`created_at=now()+1s`）—— 形状照 `0041`/`0046` 那几处 `INSERT` 直传 `p_scope` 的写法。⛔ 这不是造假读数：本子集不引 `0041`/`0046`，而这条行正是「护栏要挡的那类行」的最小复现。

| 断言 | 读数 |
| --- | --- |
| 全量 `GET /admin/audit-logs` | 200、`Cache-Control: no-store`、条目恰为契约 12 键、2 条（1 条 `post.hide` + 1 条 scope 同为 `sources:write` 的权限行）、`created_at DESC` 首位是刚插的权限行 |
| ① `?entity=post` | 200，`[...new Set(actions)] === ['post.hide']`，**不含** `permissionAuditId`，`target_ref={type:'post',id:P5,revision:1}` |
| ② `?entity=post&action=post.hide` | 与 ① 同一页（id 序列逐位相等） |
| ③ `?entity=post&action=set_flag` / `&action=admin_scope.grant` | 两条都 **400 `INVALID_REQUEST`** + `details` 含 `{field:'action',code:'enum'}`（`admin_scope.grant` 特意入选：裸 SQL 下它与 `scopes=['sources:write']` 有交集，正是护栏要挡的错误命名） |
| ④ `?action=post.hide` | 200，id 集合等于全量里的 post.hide 行（单用 action 不受护栏影响） |
| ⑤ 闭集外 `?entity=comment` / `?action=post.approve` | 仍 400（本片只补两个值，没放宽） |
| ⑥ 只有 `flags:write` 的管理员会话 | 403 `SCOPE_DENIED`（授权面未动） |

`[H]` 段（下架写面）读数不变：`恰好 +1 条 post.hide（scope=sources:write / reason_code=post_hidden / result=accepted / target_ref={post,id,revision:1} / actor=该管理员）`。

结尾：`[ALL PASS] 后台社区帖域真库臂 … 全部读数通过`，`读数 41 组（[M]/[L]/[D]/[H]/[A]/[F]/[R]/[U]）`，exit 0。

---

## 6 负控制：把护栏临时摘掉 ⇒ 臂必须红

改 `services/api/src/admin/audit/catalog.ts` 的护栏表为 `Object.freeze({})`（即「没有护栏」），重建空库后复跑同一条臂：

```
AssertionError [ERR_ASSERTION]: entity=post 只返回 post.hide（动作护栏）；出现别的 action ⇒ 护栏失效
+ actual - expected
  [
+   'admin_scope.grant',
    'post.hide'
  ]
    at main (…/tests/integration/admin-community-posts-pg.mjs:706:12)
```

红在**正确的判据**上：`?entity=post` 把同 scope 的权限行 `admin_scope.grant` 一起吐了出来 —— 正是 §2.1 说的「错误命名」。红之前 `[M]`/`[L]`/`[D]`/`[H]` 与 `[A]` 的全量那条都仍然绿（它们不依赖护栏），说明这条臂不是「整体崩」，而是**精确打在护栏上**。

还原自证：还原后 `catalog.ts` 的 SHA256 回到 `4CE0CDA24D9A198DEEF54A3CAD41A99EC0F125B36E404608F88E9C2DD43B6BD1`（与摘护栏前逐字节相同），重建空库复跑 ⇒ 重新 `[ALL PASS]`、exit 0。

---

## 7 偏差与理由（派单/基线实测不一致处）

1. **「第 5 值」→ 实为第 8 值**：派单 §3.1 按旧基线（`e112ff67` 之前）写「`post.hide` 是第 5 值」，但 `a92e0180` 已含 `#652` 的 `admin_scope.grant/revoke/deny` 三值 ⇒ `post.hide` 是**第 8 个 action**；`post` 确为**第 5 个 entity 键**。已按实测落地。
2. **真库臂落点**：派单写「落进已接线的 `admin-community-posts-pg.mjs`（`admin-audit-logs-pg.mjs` 未接线）」—— 实测一致。但该脚本原本只需要 `0047`；本片发现还必须补 **`0027`**（`admin_audit_events.before_value/after_value`），因为 `0033` 的 `list_admin_audit_logs` 是 `LANGUAGE sql`，函数体在 `CREATE` 时校验列存在，缺列 ⇒ 0033 当场建不起来。已补进子集并同步 `migration-subset-coverage-pins.test.mjs`（22→24 / 28→30）。
3. **`docs/architecture/ai-ops-spec-status.md` 的读数**：本片最初按「该页不在派单 §2 的允许清单里」不改，只登记为陈旧。复核推翻了这个判断：该页在 `docs/pr-review-policy.md` §10.1 的**正面清单**内（非受保护文档），且它自己写着「`AUDIT_ACTIONS` 闭集扩容（E40）」会令本页读数失效 ⇒ 复核要求**在本片内同步**。已改三处假陈述：E31（七条→八条、七行/七值→八行/八值、写点表锚点跟到 `9-18`、补第 8 行 `record_admin_post_hide_audit` 并注明其 `scope='sources:write'`）、E40（恰七值→恰八值、`post.hide` 末位、闭集锚点 `123-132`、契约枚举八项 `11008-11016`、`entity` 五项 `11025-11030`、用例行号 `169`/`223`/`133-134`/`379`/`268`）、N02（改成「#609 补到七行、本版再补第八行」）。`:29` 的 #609 历史叙述按要求**不动**。
4. **R59 两处文档锚点**随 openapi 净增 2 行下移（`11299` → `11301`，同一份 `packages/contracts/openapi.json` 内 `"/admin/posts": {` 所在行），已按实际位置重指（不是「凑容差」：原数字现在落在右括号行）。
5. **`apps/admin/src/lib/admin-audit-logs.mjs` 的镜像**：本片最初按 `apps/**` 禁改处理、镜像留在 7 值 / 4 值并登记为「本片没做」。复核指出这是**可用的功能缺口**（后台筛选下拉选不到 `post` / `post.hide`）且不在禁改面内，要求本片内同步 ⇒ 已补第 8 值 `post.hide`、第 5 个 entity `post`、两条中文标签与 `AUDIT_LOG_ENTITY_SCOPES.post='sources:write'`（并注明该串不专属、前端不复制动作护栏）。`tests/unit/admin-ui-audit-logs.test.mjs` 的两条**计数钉**按等价扩张改（7→8、4→5，⛔ 没有放宽成「包含」），它对「闭集外 400」的正控原拿 `post.hide` 当非法值，现已换成 `post.approve`。副作用：`AuditLogsView.vue` 的筛选项自动跟着变多（它 `v-for` 遍历这两个数组，没有硬编码）。

---

## 8 本片没做（明确的边界）

- **拒绝侧留痕**：`record_admin_post_hide_audit` 只在成功路径写 `result='accepted'`；下架被拒（版本冲突 / 缺 scope / 已删除）不留审计行。
- **`post.approve` / `post.reject` 落库**：人工通过/驳回仍是进程内追加台账（`GET /admin/audit-events` 在实模式下仍 503），本片只补 `post.hide` 一个动作。
- **前端只同步了闭集镜像**：`apps/admin/src/lib/admin-audit-logs.mjs` 补到 8 动作 / 5 实体（§7 第 5 条），但**不**把后端 `entity=post` 的动作护栏复制进前端，也不改页面布局/交互 —— 越界组合仍只由后端 400 拦下。
- **`entity` 多值集改造**：`?entity=` 仍是单值枚举，不做 `CSV`/异或语义。
- **`0033` 不动**：护栏没有进 SQL（§2.3）。
