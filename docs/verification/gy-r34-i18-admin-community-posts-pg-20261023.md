# GY-I18（#18）· 后台「社区帖」域真库集成臂（读面 / 下架处置 / 失败隔离）

- 片号：R34-I18 ｜ 分支：`test/gy-r34-i18-admin-community-posts-pg` ｜ 开工基线：`upstream/main` `765b6a31d993995e5dacbf6a3227ebcbb97fd8df`
- **主线已前进 ⇒ 已 `git merge --no-ff upstream/main`（`f3a5f24d7427f5c2e40b9c8278312aa4827157ca`，⛔ 未 rebase/force）**：
  唯一冲突在 `tests/unit/ci-real-pg-wiring.test.mjs` 的 `REQUIRED_STEP_ORDER`（主线把 `admin-flags` 前移到
  `admin-jobs` 之后、`admin-accounts-read` 之前），按**并集**解：保留主线那条「有角色前提」的链序，本脚本作为一个
  独立条目排在 `admin-accounts-read` **之后**、`ocr-jobs` 之前（它只用 owner URL、不建角色、不读 `pg_authid`
  ⇒ 不受 `admin-accounts-read` 留在集群里的运行时角色影响）；workflow 侧同序，自动合并无冲突。
*合流后已重跑全部门禁与真库臂（读数见 §3；真库臂 exit=0 / 23 组 / `[ALL PASS]`）。*
- 新增脚本：`tests/integration/admin-community-posts-pg.mjs`
  （`node tests/integration/admin-community-posts-pg.mjs <ownerUrl>`；也接受 env `ADMIN_COMMUNITY_POSTS_PG_TEST_URL`。
  库名硬钉 `gengyun_admin_community_posts_test`，要求**空库**；缺 URL 时打印 `SKIP` 并以 **77** 退出 ⇒ 未取得，不是通过）
- 接线：`.github/workflows/real-pg-integration.yml`（**贴在后台域那三条之后**：`admin-jobs` → `admin-flags` →
  `admin-accounts-read` → **本 step** → `ocr-jobs`；⛔ 不追加到文件末尾，也⛔ 不插进那条有角色前提的链中间）
- 同步更新：`tests/unit/ci-real-pg-wiring.test.mjs`（`MANAGED_SCRIPTS` / `FROZEN_MANAGED_SCRIPTS` /
  `REQUIRED_STEP_ORDER` 三处，均插在 `admin-flags-pg.mjs` 与 `ocr-jobs-pg.mjs` **之间**）、
  `tests/unit/ci-integration-chain-structure.test.mjs`（`UNWIRED_DECLARATIONS` 一条，与后台域条目相邻）
- 本片**不改**产品代码、**不改**契约（`packages/contracts/**` 零改动）、**不新增**迁移、**不动**授权出厂文件；
  只调用既有代码（`hidePost` → `createHidePostAdapter` → 社区 store 的 `commitPostIfCurrent`；读面走
  `GET /posts` / `GET /posts/{id}` 两条既有面）

## 0. 为什么有这一片

监工 #18 把「后台四域真 PG 联调」列为**未交付**。基线实测：后台域的真库臂只有三条 ——
`admin-accounts-read-pg.mjs`（账号读面）、`admin-flags-pg.mjs`（开关）、`admin-jobs-pg.mjs`（作业台）。
**社区帖域没有自己的真库臂**：它的处置路径是契约 operationId **109** `POST /admin/posts/{id}/hide`
（scope `sources:write`），此前只在社区域脚本 `community-pg.mjs` 第 13 节被**顺带**读到，
而那一段自己写明「⛔ 本段**不**证明库内审计」，且它不是后台域的臂、也不证明读面的分页/过滤/计数与
「越权与不存在同形」。本片把这一域补成一条**可复跑的 CI 读数**。

读面口径说明（如实）：后台契约里社区帖**没有**独立的列表/详情 operationId
（`packages/contracts/operations.json` 里与帖相关的后台操作只有 109 = hide），后台「社区帖」页读的就是
社区这两条面（`listPosts` / `getPost`），因此读面读数按它们取 —— 这也正是「下架后社区可见性联动」的观测点。

## 1. 四点读数（本机实测，PG **17.11**，回环 `127.0.0.1:55451`，空库一次跑完，exit=0）

原始输出（`E:\GengYunCommander\.pg17\tmp\i18-posts-pg\run-final.log`，23 组读数 + 末行 `[ALL PASS]`）：

```
[M] PG 17.11 · 空库前提成立（public 下 0 张表）
[M] 迁移子集 0001+0022+0030+0032 逐条 apply 成功、二连跑 0 条（目录共 32 个迁移，版本号无重复）
[M] 依赖列在位：community_posts.{visibility,audit_state,revision,updated_at,anonymized_author_ref} 与 community_moderation_decisions.text_digest
[L] 夹具 8 条真落 community_posts：published×5（作物/地区/作者各不相同）+ hidden×1 + deleted×1 + private+pending×1
[L] GET /api/v1/posts ⇒ 200，5 条公开帖（hidden/deleted/private 一律不出现）；每条字段集合与契约 Post 恰好相等（15 列）
[L] 过滤：crop_id / region_code / 组合四种形态的 id 序列与真库同条件 SELECT 逐位相等（含空集合非 404）
[L] mine=true：三个主体各自与真库同条件 SELECT 逐位相等；A 的集合含自己的 hidden/private、不含 deleted
[L] 分页：limit=2 逐页遍历 ＝ 2/2/1 三页，拼接结果与公开集合逐位相等（无重无漏）；带筛选的游标同样绑定筛选集
[L] 计数对账：库内 total=8 / published=5 / hidden=1 / deleted=1 / private=1；公开列表 5 条 = published，且 5 ≠ 8
[L] 参数闭集：limit=0 与 region_code=999999 都 400（筛选参数不被静默忽略）
[D] GET /api/v1/posts/{id} ⇒ 200，字段集合与契约 Post 恰好相等，execution_mode=real，revision/visibility/audit_state 与库一致
[D] 越权/不存在同形：他人读 hidden / deleted / 随机 uuid 三者都是 404 NOT_FOUND，error 对象逐字相等、meta 除 request_id 外逐字相等
[D] 作者读自己的 hidden/private 都 200 且状态如实（hidden / private+pending）；他人读 private 草稿 404
[D] 面间权限边界：游客读列表 401 SESSION_REQUIRED；后台会话读社区面 401 SESSION_EXPIRED（后台令牌不是用户会话）；用户会话调后台下架 403 SCOPE_DENIED
[H] POST /api/v1/admin/posts/{id}/hide ⇒ 200 {accepted:true} + ETag "2"；真库行 visibility=hidden、revision 1→2、updated_at 前进，正文/审核态/作者一字未动
[H] 审计留痕：恰好 +1 条 post.hide（scope=sources:write / reason_code=post_hidden / result=accepted / target_ref={post,id,revision:1} / actor=该管理员）
[H] 社区可见性联动：他人列表剔除（含带筛选的列表）、他人详情 404 且与不存在同形、作者仍 200 且 visibility=hidden/revision=2、mine 仍含该帖
[H] 如实登记：real 模式下 `GET /admin/audit-events` = 503 PROVIDER_UNAVAILABLE(retryable:false) ⇒ 审计留痕只能由进程内台账读回，**未**落库、无 HTTP 读面
[F] 八条被拒路径（版本不符/缺 If-Match/已删除/未公开/不存在/缺 scope/用户会话/游客）逐条：状态与错误码正确、真库行**逐列**一字不动、post.hide 审计条数不增
[F] 幂等重放（同 idempotency-key 同体）：回放首次 200 + ETag "2"，rev 不再前进、审计不再增加
[F] 已隐藏再下架：200 accepted、ETag 不变、rev 不变、审计不增（changed:false 不重复记处置）
[F] 并发隔离：两笔同 If-Match 的下架 ⇒ 恰好一笔 200 / 一笔 409 REVISION_CONFLICT；rev 只前进一次、审计只多一条（真库 CAS 的原子性）
[F] 收尾自证：全表 8 行终态 = 两次成功下架（P1/P5 → hidden:2）+ 六条原样，无半写状态
[ALL PASS] 后台社区帖域真库臂：读面 / 单条 / 下架处置 / 失败隔离 全部读数通过
```

对派单四点逐条对应：

| 派单要求 | 读数 | 结论 |
| --- | --- | --- |
| ① 列表读面：真库夹具下的分页、过滤、计数与契约形状一致 | `[L]` 7 组 | **取得**：分页 2/2/1 无重无漏、4 种过滤形态与真库同条件 `SELECT` 逐位相等、计数与 `count(*)` 对账（5 = published，且 5 ≠ 8 ⇒ 不是截断）、每条 item 字段集合 = 契约 `Post`（15 列，`additionalProperties:false`） |
| ② 单条读面：字段与权限（越权/不存在同形） | `[D]` 4 组 | **取得**：字段集合与契约恰好相等；他人读 hidden / deleted / 随机 uuid 三者 `error` 对象**逐字相等**、`meta` 除 `request_id` 外逐字相等；作者读自己的 hidden/private 仍 200；游客 401、用户会话调后台 403 |
| ③ 下架处置：真库行状态 / `revision` / 审计留痕 / 社区可见性联动 | `[H]` 4 组 | **取得**（审计一项有边界，见 §2）：行 `visibility=hidden`、`revision` 1→2、`updated_at` 前进、正文/审核态/作者未被动；台账**恰好 +1** 条 `post.hide`（`target_ref` 带**下架前** revision=1）；他人列表剔除、他人详情 404、作者仍读到 hidden、`mine` 仍含该帖（是「隐藏」不是「删除」） |
| ④ 失败隔离：处置失败不得留下半写状态 | `[F]` 4 组 | **取得**：八条被拒路径逐条「真库行**逐列**快照相等 + `post.hide` 审计条数不增」；幂等重放与 `changed:false` 都不推进 `revision`、不记审计；**并发两笔同 If-Match ⇒ 恰好一笔 200 / 一笔 409，`revision` 只前进一次、审计只多一条**（真库 CAS 的原子性，只有 PG 能证明）；末行全表 8 行终态自证无中间态 |

## 2. 未取得（如实登记，⛔ 不得读成通过）

- **库内审计：未取得**。`hidePost` 的留痕走 `admin/ops/service.ts::appendAudit`，落的是**进程内**
  只可追加台账（`adminOpsService.store.persistent === false`，重启即丢）；`real` 模式下内容域 fail-closed，
  `GET /admin/audit-events` 实测 **503 `PROVIDER_UNAVAILABLE`（retryable:false）** ⇒ 本片读到的
  `post.hide` 条目来自**同一份台账的读 API**（与将来那条 HTTP 读面同源），⛔ 不构成「审计已落库」。
  这是既有实现的口径（`app.ts` 的 real 分支注释已如实写明「库内审计未取得」），本片**不改产品行为**。
- **真实审核供应商：未取得**。可见性判据（`effectiveState()`）在 `[L]/[D]/[H]` 三段里用的是仓内**合成**
  `gate` 夹具（`tests/unit/community-fixtures.mjs`，不联网、无凭据 ⇒ 与社区域既有臂同一口径），
  ⛔ 不代表真实 `tms`/`ims` 已接通。
- **下架后台 UI：未取得**（`apps/admin/**` 里没有社区帖/下架页面；本片只证服务端路由到真库的链路）。
- **来源（sources）域的 real 写面：未取得**（real 模式下内容域整体 fail-closed，不在本片范围）。
- **运行时角色的库级最小权限面：未取得**（本臂全程库 owner 身份；账号读/开关/作业三条既有臂已各自证明
  各自的最小权限面，本片不重复、也不据此推断社区帖域的授权面已验收）。
- **真实媒体、真实网格/多副本、超规模数据**：未取得（夹具 8 条；本片不构成容量或并发压测结论）。

## 3. 门禁读数（本机，worktree 内实测；**合流 `f3a5f24d` 之后重跑**）

| 门禁 | 结果 |
| --- | --- |
| `node --test tests/unit/ci-real-pg-wiring.test.mjs` | exit **0**：`tests 18 / pass 18 / fail 0` |
| `node --test tests/unit/ci-integration-chain-structure.test.mjs` | exit **0**：`tests 7 / pass 7 / fail 0` |
| `node --test tests/unit/integration-script-coverage.test.mjs` | exit **0**：`tests 6 / pass 6 / fail 0` |
| `node tools/verify-contract-status.mjs` | exit **0**：`覆盖 113 条契约操作；已装配 109 条；implemented 17 / partial 92 / planned 4；形状错误 0；语义错误 0` + `PASS: 中文表格一致` |
| `npx tsc -p services/api/tsconfig.json --noEmit` | exit **0**（无输出） |
| 真库臂 `node tests/integration/admin-community-posts-pg.mjs <ownerUrl>` | exit **0**：`[ALL PASS]`，读数 23 组 |

> 附注（**基线既有红，与本片无关**）：`tests/unit/release-materials-index.test.mjs`（3 pass / 2 fail）与
> `tests/unit/release-materials-index-strict.test.mjs`（0 pass / 6 fail）在本机**基线上逐字同样红**
> —— 已在 `upstream/main` `765b6a31` 的**独立 detached worktree** 里复跑确认，失败项是
> `FAIL 被索引文件全部非空 — 空文件：deploy/purge-schedule/`（索引把目录当文件读）与本片改动无关；
> 本片未触碰 `deploy/**` 与那两份索引文档。

> **后注（2026-10-23，#524 之后）**：上条红不是环境噪声，而是 `tools/verify-release-materials.mjs` 的**目录判空假红**——`statSync(...).size === 0` 在 Windows 上把索引里以目录形式出现的 `deploy/purge-schedule/` 判成空文件（Linux CI 的目录 `st_size=4096`，看不到这条）；`#524`（HEAD `0fb8560a`，合入 main 的 `fa7d1256`）已把判据改成「先判目录、再判 `size`」，该门禁现读 `16/16 项通过`。当时判「与本片无关」是对的（本片确实未碰 `deploy/**` 与那两份索引文档），只是根因归类应写「工具假红」而非「与本片无关」。原读数保留为历史。

## 4. 取证环境与可复现方式

```
# 一次性隔离集群（本机，PG 17.11，只用回环；端口落在派单允许的 55432–55467 内）
<PG_BIN>\initdb.exe -D <tmp>\data -U postgres --auth=trust --encoding=UTF8 --locale=C
<PG_BIN>\postgres.exe -D <tmp>\data -p 55451 -h 127.0.0.1          # 收尾：<PG_BIN>\pg_ctl.exe -D <tmp>\data stop -m fast
<PG_BIN>\psql.exe -h 127.0.0.1 -p 55451 -U postgres -d postgres -c 'CREATE DATABASE gengyun_admin_community_posts_test'
node tests/integration/admin-community-posts-pg.mjs postgres://postgres@127.0.0.1:55451/gengyun_admin_community_posts_test
```

`<PG_BIN>` 全部来自 `E:\GengYunCommander\.pg17\pgsql\bin`（`initdb (PostgreSQL) 17.11`）。数据目录落在仓外
`.pg17\tmp\i18-posts-pg\`，未污染工作树；跑完按上图 `pg_ctl stop -m fast` 关闭。CI 侧由
`real-pg-integration.yml` 的 `postgres:17.11` service 提供（口令为明显的合成值 `synthetic-ci-owner-only`）。

## 5. 本片**不构成** #18 完成

`#18` 的开放项至少还包括：**下架的后台 UI**、**来源域的 real 写面**、**库内审计**（本条见 §2），
以及监工对后台四域「真 PG 联调」的整体复核。本片只补齐「后台社区帖域有一条 CI 会跑的真库臂」这一点，
`Refs #18`，⛔ 不关闭、⛔ 不 claim 该 issue 已完成。

## 6. 一处如实记录的观察（非阻塞，不改产品行为）

`routes/community.ts` 的头部注释写「后台会话 403 `SCOPE_DENIED`」，而本机实测后台令牌读
`GET /api/v1/posts` 得 **401 `SESSION_EXPIRED`**（`authenticateUser()` 只认 `audience:'user'` 的会话，
找不到即报会话过期）。两者都是**拒绝**、都不泄露目标存在性，故不构成安全问题；本片只如实读数，
⛔ 不顺手改注释、不改产品代码（按派单「只调用既有代码，不改产品行为」）。
