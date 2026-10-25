# GY-I16（#16）收藏与历史 · 读时权限／失效／去重语义收口 证据

- 任务：GitHub issue #16（收藏与历史）四条验收的**审计 → 补测**：读时权限重查、失效不得复活、
  候选与人工选择分开、失败任务可见且不被记成「已使用事实」。
- 工作区：`E:\GengYunCommander\.pg17\wt-i16-semantics`（分支 `feat/gy-i16-semantics`，工作树原先 detached 在
  `0856e49e31bbc5dff3615b146cf9ce12e88a0b49` 上）；**不 push、不评论、不改 PR**。
- **结论口径**：本文件只报告**本机实测**读数。`stub` 执行模式、合成身份、可见性替身；真实微信工具／真机／
  真实供应商／真实 PG17 全部**未取得**，见 §7。任何一条「成立」都限定在：**契约面 + 服务层 + 合成 HTTP 回环**。

## 1 基线与环境

| 项 | 值 |
| --- | --- |
| 本片基线 `HEAD`（开工时工作树的 detached commit） | `0856e49e31bbc5dff3615b146cf9ce12e88a0b49` |
| 收尾时 `upstream/main` | `8cc9dd8b1ee251c8d7000390d54e0ba07a6ac37f`（基线之后前进 2 个提交） |
| 上游新增是否与本片文件重叠 | 否。`8cc9dd8`/`3bbad5c` 只动 `README.md`、`docs/reference/local-development.md`、`tests/local-debug.test.mjs`、`tools/prepare-wechat.mjs` |
| 基线是否为 `upstream/main` 的祖先 | 是（`git merge-base --is-ancestor` 退出码 0 ⇒ 落后基线，不是分叉） |
| Node / npm | `v24.16.0` / `11.13.0` |
| 依赖安装 | `npm ci --ignore-scripts` ⇒ `added 103 packages, and audited 106 packages, 0 vulnerabilities` |
| 本机 bash | WSL 存根：`bash -n` 空转 `exit 0`，**不**证明任何 shell 语法 ⇒ 依赖 bash 的校验一律记「未取得」 |
| 本机 PostgreSQL | 未找到 `initdb`/`pg_ctl`/`postgres`（`Get-Command` 与常见安装根目录均无）⇒ 真库集成记「未取得」 |

## 2 契约与路由面事实（先钉死「有没有详情读」）

`packages/contracts/operations.json` 里收藏/历史只有 5 条 operationId：

| operationId | 方法/路径 | 备注 |
| --- | --- | --- |
| `listFavorites` | `GET /favorites` | 列表（游标分页） |
| `createFavorite` | `POST /favorites` | 幂等键 8..128 |
| `deleteFavorite` | `DELETE /favorites/{id}` | `If-Match` 必填、`version_required: true` |
| `listHistory` | `GET /history` | 列表（游标分页） |
| `deleteHistory` | `DELETE /history/{id}` | `If-Match` 必填、`version_required: true` |

**没有** `GET /favorites/{id}`，**也没有** `GET /history/{id}`（`services/api/src/routes/favorites.ts`、`routes/history.ts`
同样只有列表 + 删除）。所以验收里的「收藏详情／历史详情」在服务端**不存在独立读路由**，其读时语义只能落在：

- 收藏详情：小程序详情页用**列表响应**回填（`miniprogram/utils/favorites-api.js`），状态来自当次列表读取；
- 历史详情：小程序 `locateHistory()` 用**实时列表读取**定位 + 实时状态，快照只用于定位且**不携带状态**
  （`miniprogram/utils/history-api.js:277-285` 起，`locateHistory`；原记 :274）；识别正文走 `GET /recognitions/{id}`（#9，删除后 404）。

这一点在集成脚本里也是如实登记的（`tests/integration/favorites-history-isolation-http.mjs:322-325`、`:376-378`
断言 `GET /history/{id}` 未注册 ⇒ 404），本片**不伪造**详情路由。

## 3 条款 → 现有断言 → 缺口（先建表，再决定补什么）

| # | 验收条款 | 代码锚（实现） | 现有断言（文件:行） | 结论 |
| --- | --- | --- | --- | --- |
| 1 | 收藏**列表**每次读取按当前可见性重判 | `services/api/src/favorites/service.ts:306` `listFavorites` 逐行 `project()`；`project` 在 `:233` 每次调用 `deriveVisibility`（`services/api/src/targetref/visibility.ts:170`），不缓存 | `tests/unit/favorites-history-visibility.test.mjs:90`（逐次重派生、隐藏后同 id/revision 立即 unavailable、恢复可见）；`favorites-visibility-wiring.test.mjs:173`（真 DB 读视图下架/改版/恢复逐次重派生）；`:228`（`/knowledge` 当前可读 ⇒ available） | **成立** |
| 2 | 收藏**详情**不外泄旧状态 | 无 `GET /favorites/{id}` 路由；详情回填取列表 | `tests/unit/miniprogram-favorites-history.test.mjs:394`/`:445`（回填取服务端最新行）；`:545`（不接可见性端口时页面**不**做可用断言）；集成 `:322-325` 如实登记无详情路由 | **成立（以「无详情读路由 + 列表逐次派生」成立，不是靠缓存）** |
| 3 | 历史**列表**每次读取按当前可见性 + 当前任务状态重判 | `services/api/src/history/service.ts:227` `project()` = `deriveJobState`（`services/api/src/history/job.ts:102-110`：实时优先、核不到退回入库值）+ `deriveVisibility` | `favorites-history-visibility.test.mjs:196`（实时重查、绝不升级 succeeded、端口抛错退回入库值）；`:229`（失效后行仍在、归属隔离）；`history-http.test.mjs:328`（他人任务核不到只退回入库值） | **成立** |
| 4 | 历史**详情**不用旧链接里的旧状态 | 小程序 `locateHistory()` 实时优先；快照兜底**不带状态** | `miniprogram-favorites-history.test.mjs:229`（实时 succeeded 覆盖快照 failed；快照 jobState/referenceState 均为 `null`）；`:189`（旧链接夹带的状态字段一律忽略） | **正方向成立；负方向（实时 unavailable 压过旧 available）此前无断言** → 见 §4-A5 |
| 5 | 下架/隐藏/删除/注销后旧收藏不得复活、不恢复推荐资格 | `favorites/service.ts:91` `favoriteEligibleForRecommendation` 只看**本次派生**的 `reference_state` | `favorites-history-visibility.test.mjs:119`（旧收藏不恢复推荐资格、旧链接不复活）；`:148`（注销后全部不可用）；集成 case3（重复读 3 次仍 unavailable、按账号分别派生） | **成立** |
| 6 | 取消收藏去重：重复取消不报错、不产生重复记录 | `favorites/service.ts:426` `deleteFavorite`；幂等 scope/digest 见 `:430-447`；重放回调 `:459-464`；store 原子 CAS（`store-pg.ts` 事务内 `SELECT … FOR UPDATE` + `DELETE … RETURNING id`） | `favorites-http.test.mjs:109`（同目标换新键仍同一行；取消 200 `{accepted:true}`；取消后重收藏得新 id）；`:174`（越权同形 404、缺 If-Match 428、版本不符 409、**换新键**重放 404）；`:357-361`（删后真表 `count(*)=0`）；`favorites-history-store-pg.test.mjs:121-128`（CAS 四态） | **「不产生重复记录／异键 404」成立；「同键重放 ⇒ 200 不报错」此前无断言** → §4-A1/A2 |
| 7 | 幂等重放不得回放旧可见性结论 | `favorites/service.ts:188-192`（同键异体 409、同键同体走 `replay`）；`:408-413`（create 重放重新读取 + 重新鉴权 + `project` 重派生）；`:459-464`（delete 重放归属重查） | 无（只有 `:408` 注释声明） | **无断言** → §4-A3 |
| 8 | 游标翻页不携带上一页的旧结论 | `favorites/service.ts:306` 每页逐行 `project()`；游标 watermark 只绑定 `(id, created_at)`，不含可行性结论 | `favorites-http.test.mjs:275`（跨页不重、篡改/跨主体 400、翻页中删行 ⇒ 400 INVALID_CURSOR） | **无断言**（可见性变化后第 2 页） → §4-A4 |
| 9 | 模型候选与用户最终选择可区分存储与展示 | `services/api/src/recognitions/service.ts:598`（只写 `selected_species_id`）；`:634-645`（**不回写** candidates/model_score/model_version；人工选择永不进模型成绩） | `recognitions-candidates-selection.test.mjs:391`（独立记录、append-only、不计模型成绩、归属私有）；`:499`（选择后资料关联 + 用量被 GY-I08 守卫阻断）；`favorites-history-visibility.test.mjs:50`（历史投影恰 7 字段，无候选/选择字段）；`history-http.test.mjs:258`；`miniprogram-favorites-history.test.mjs:261`（详情视图两字段分离、失败不当成功、分数不是准确率） | **成立** |
| 10 | 识别失败的历史条目必须真实可见（不被吞掉） | 终态接线：`services/api/src/app.ts:963` `appendHistory({ ...input, event_key: kind + ':' + job_id })`；`history/service.ts:426` `appendHistory` 原样写 `job_state`（含 failed/timed_out/cancelled/uncertain） | `history-http.test.mjs:339`（五类非成功终态逐类可见）；`:566`/`:606`（终态自动写入：成功/失败/超时各恰 1 条，`job_state` 与任务一致）；`:663`（OCR 同构）；`:894`（event_key 确定性）；`favorites-history-visibility.test.mjs:170`（五类终态原样可见） | **成立** |
| 11 | 失败任务不得被自动记成「已使用事实」 | `favorites/service.ts:21-23`（投影恰 6 字段，不持任何用量/历史端口）；`history/service.ts:23-26` + `:426` 入参校验（未知字段即 400）；历史投影恰 7 字段 | `favorites-history-visibility.test.mjs:50`；`favorites-http.test.mjs:125-128`（断言无 `used/usage/used_at/last_used_at/count`）；`history-http.test.mjs:493`（含使用类字段的未知键一律 400）；`miniprogram-favorites-history.test.mjs:147-150`（原记 :141；多出契约外字段 ⇒ INVALID_RESPONSE）、页面无「标记已使用」入口 `:551` | **成立（结构性 + 断言）** |
| 12 | 取消收藏语义的边界：同键异体 | `favorites/service.ts:188-190` 先比 `request_hash` ⇒ 409，绝不回放另一份请求的结果 | create 面有（`favorites-http.test.mjs:148-156`）；**delete 面无** | **无断言** → §4-A2 |

## 4 补测（本片唯一的代码改动：只加断言，不改产品代码）

新增 `tests/unit/favorites-replay-and-paging-visibility.test.mjs`（4 个测试）+ 在
`tests/unit/miniprogram-favorites-history.test.mjs` 末尾追加 1 个测试。**5 个测试全部一次通过**
（见 §6.2）⇒ 这 5 处是**断言缺口**，不是行为缺陷；因此本片**没有**产品修复。

| 编号 | 补的是什么 | 断言要点 |
| --- | --- | --- |
| A1 | 取消收藏**同键重放** | 同键同体连续重放 3 次都回 `200 {accepted:true}`（「重复取消不报错」，既不是 404 也不是 409）；幂等键换新再删同 id ⇒ 404 与「从未存在」同形；列表连续两次为空（**不留墓碑、不产生第二行**）；取消后重收藏得**新 id** |
| A2 | 取消收藏**同键异体** | 同键 + `If-Match` 变 ⇒ `409 IDEMPOTENCY_CONFLICT`；随后原键 + 原 `If-Match` 仍回 `200 accepted`（**台账未被冲突污染**） |
| A3 | **幂等重放重新派生可见性** | 目标可见时创建 ⇒ `available`；隐藏后同键同体重放 ⇒ 仍同一行（同 id/created_at）但 `reference_state:"unavailable"` 且有非空 `unavailable_reason`；恢复后重放 ⇒ 如实回到 `available`；并断言可见性端口调用次数**逐次增加**（不得命中缓存） |
| A4 | **游标第二页逐次重派生** | 三行翻两页（先确认两页合起来恰 3 行不重不漏）；三个目标全部隐藏后，第 1、2 页每行都是 `unavailable`（可见性变化**不**让游标失效：仍 200、不 400）；只恢复一个目标 ⇒ 仅该行回到 `available` |
| A5 | 小程序历史详情**负方向** | 快照里是旧 `available`、实时读取是 `unavailable` ⇒ 详情必须是 `unavailable`（不得用旧快照顶替、不给「打开资料」入口），任务状态仍如实展示；反向对照再断言实时 `available` 时确实给 `available`（不是把页面做成恒不可用） |

## 5 逐条验收读数

| 验收 | 读数 | 依据 |
| --- | --- | --- |
| ① 读时权限重查（下架/隐藏/删除/注销/权限变化） | **成立** | 服务层每次读取都走 `deriveVisibility`（无缓存）；列表逐行派生、幂等重放重新派生（§4-A3）、翻页逐页派生（§4-A4）；既有断言 §3 第 1/3/5 行；集成 case3（下架后重复读 3 次仍 unavailable、版本前进后旧收藏仍不可用、按账号分别派生、`Cache-Control: no-store`） |
| ② 失效不得复活 + 取消去重 | **成立** | 旧收藏不恢复推荐资格（`:91` + `:119`）；取消为物理删除、无墓碑（真表 `count(*)=0`）；同键重放 200（§4-A1）、同键异体 409（§4-A2）、异键 404（既有）；取消后重收藏得新 id（既有 + A1） |
| ③ 候选与人工选择分开 | **成立** | 选择只写 `selected_species_id`（`recognitions/service.ts:634-645`），历史投影恰 7 字段不含候选/选择；详情视图两字段分离；人工选择永不计模型成绩（`recognitions-candidates-selection.test.mjs:391`） |
| ④ 失败任务可见 + 不记成已使用 | **成立** | failed/timed_out/uncertain 终态自动写入并逐类可见（`:339`/`:606`），读时实时重查绝不升级为 succeeded（`job.ts:102-110` + `:196`）；「已使用」类字段在投影与创建口双向封闭（`:50`、`:125-128`、`:493`）；小程序无「标记已使用」入口（`:551`）。**边界（已裁定）**：用户主动**取消**的任务不产历史行（`history-http.test.mjs:855-892`，有断言 + 「端口确实 wired」的反例），口径「取消不算一次识别结果」成立、不属「失败任务」，**保持现状**，见 §8.1-① |

## 6 门禁读数（全部本机实测）

### 6.1 安装与基线

```
npm ci --ignore-scripts
added 103 packages, and audited 106 packages, 0 vulnerabilities
```

### 6.2 受影响单测（9 个文件，含本片新增）

```
node --test --test-isolation=none tests/unit/favorites-history-visibility.test.mjs \
  tests/unit/favorites-http.test.mjs tests/unit/history-http.test.mjs \
  tests/unit/recognitions-candidates-selection.test.mjs \
  tests/unit/miniprogram-favorites-history.test.mjs \
  tests/unit/favorites-replay-and-paging-visibility.test.mjs \
  tests/unit/favorites-history-store-pg.test.mjs \
  tests/unit/favorites-visibility-wiring.test.mjs \
  tests/unit/favorites-history-deletion-registration.test.mjs
ℹ tests 101  ℹ pass 101  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0   (exit 0)
```

### 6.3 全量单测与「8 条失败与本片无关」的证据

```
# 本片改动树上（feat/gy-i16-semantics）
node --test --test-isolation=none "tests/unit/*.test.mjs"
ℹ tests 1622  ℹ pass 1613  ℹ fail 8  ℹ skipped 1  ℹ todo 0   (exit 1)

# 同一命令、**干净基线** 0856e49（把本片两处改动 git stash 后复跑，跑完 pop 且 blob 逐字节还原）
ℹ tests 1617  ℹ pass 1608  ℹ fail 8  ℹ skipped 1  ℹ todo 0   (exit 1)
```

8 条失败**逐项同名**（两棵树完全一致，只差本片新增的 5 个测试从 1617 变 1622）：

1. `knowledge real projection and limited runtime over loopback HTTP (synthetic only)`
2. `/knowledge 默认不并入浙江首批：开关关闭时列表仍为空（不把未发布内容默认放行）`
3. `real empty, guest denial, invalid filter, unconfigured pool is not static fallback`
4. `list and detail frozen entity equality, real ETag and no-store; structured and keyword filters`
5. `knowledge pagination fixed chain deadline, epoch/version/domain/expiry guards over product HTTP`
6. `cursor subject, filter, signature, next page and visibility watermark binding`
7. `unverified, expired, withdrawn, future, missing source and body fields never leak`
8. `current source changes remove stale old-version knowledge; newer hidden revision blocks fallback`

补充定性：这 8 条全部落在 `tests/unit/knowledge-api.test.mjs` / `knowledge-herbicides-http.test.mjs`，与本片
改动（收藏/历史测试）**零文件重叠**；单独跑这两个文件在干净基线上是 `tests 20 / pass 19 / fail 0 / skipped 1`
⇒ 它们是**全量同进程（`--test-isolation=none`）下的既有跨文件干扰**，不是回归，也不是本片引入。
跳过 1 条为 `native separate-connection withdrawal and account state changes at guarded read boundary`
（knowledge 域 `SKIP` 标记，基线同样存在）。

### 6.4 收藏/历史集成（逐个直跑，不用 `npm run`）

```
node tests/integration/favorites-history-isolation-http.mjs
PASS favorites-history-isolation-http; synthetic identities + controllable visibility substitute;
real loopback HTTP; no PG, no supplier, no WeChat devtools                (exit 0)

node tests/integration/favorites-history-isolation-http.reverse-control.mjs
[GY-I16-REVERSE] exit 退出码=1（期望非 0）
[GY-I16-REVERSE] proven 原文件未改动：blob 3bc97bd7…（前=后）；逐字节一致；git status 未变化
PASS favorites-history-isolation-http.reverse-control                           (exit 0)
```

隔离脚本 case 读数（节选原文）：`case1` 越权 404 同形 + 两域均无 `{id}` 详情读路由；`case2` 删除后 404、
`X-GY-Cascade=unwired`；`case3` 下架后重复读 3 次仍 `unavailable`、版本前进后旧收藏仍不可用、按账号分别派生、
`Cache-Control=no-store`；`case4` `favoriteEligibleForRecommendation(行)=false`。

`node tests/integration/favorites-history-pg.mjs` ⇒ 打印
`SKIP real PG17: FAVORITES_HISTORY_PG_TEST_URL 未设置`（本机无 PG 二进制，见 §7）——**未取得**真库证据；
PG 侧语义在本机由 `favorites-history-store-pg.test.mjs`（9 个测试，PGlite 引擎）覆盖，PGlite ≠ 真实 PG17 服务器。

### 6.5 契约与文档门禁

```
node tools/verify-contract-status.mjs
PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；
      形状错误 0 项；语义错误 0 项
PASS: 语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段（不可核不计入通过）
PASS: 中文表格一致
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。          (exit 0)

node tools/verify-contract-status.mjs --runtime
（同上 4 行 +）PASS: 无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致（不监听 / 不请求服务）。  (exit 0)
```

注：派单里写的 `--check` **不是**本工具支持的旗标（`tools/verify-contract-status.mjs:16-18` 只认
`--runtime` / `--write-doc`，传 `--check` 直接打印用法并 `exit 1`）。派单方已确认这是**派单笔误**，后续口径为
**无旗标（静态）+ `--runtime` 两档**；`--write-doc`（同步生成区）只在需要时由派单方批准后使用。本片按此口径实跑，读数见上。

```
python -B tools/validate_development_docs.py     ⇒ PASS（见 §6.6 收尾复跑）
git diff upstream/main --check                    ⇒ 空
git diff 0856e49e31bbc5dff3615b146cf9ce12e88a0b49 --check ⇒ 空
```

### 6.6 收尾复跑（本文件写入之后）

```
python -B tools/validate_development_docs.py
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables   (exit 0)

git diff 0856e49e31bbc5dff3615b146cf9ce12e88a0b49 --check   ⇒ 空
git diff upstream/main --check                              ⇒ 空
git status --porcelain                                      ⇒ 提交后为空（读数见交接文件）
```

交接文件：`E:\GengYunCommander\.pg17\handoff\i16-semantics-d5c3aa5.md`。

### 6.7 合流 upstream/main 后复跑

合流方式：`git merge --no-ff 8cc9dd8b1ee251c8d7000390d54e0ba07a6ac37f`（在 `feat/gy-i16-semantics` 上），
**无冲突**，自动合入 4 个文件（`README.md`、`docs/reference/local-development.md`、`tests/local-debug.test.mjs`、
`tools/prepare-wechat.mjs`；均与本片零重叠，`package.json`/`package-lock.json` 未变 ⇒ `npm ci` 无需重跑，
`node_modules` 沿用已装的 103 包）。

```
受影响 9 文件单测   tests 101 / pass 101 / fail 0 / cancelled 0 / skipped 0 / todo 0   (exit 0, 24.9s)
node tests/integration/favorites-history-isolation-http.mjs               ⇒ PASS (exit 0)
node tests/integration/favorites-history-isolation-http.reverse-control.mjs ⇒ PASS (exit 0；被改文件期望红 exit 1，原文件 blob 3bc97bd7… 前后一致、git status 未变)
node tools/verify-contract-status.mjs            ⇒ PASS（4 行，同 §6.5，exit 0）
node tools/verify-contract-status.mjs --runtime  ⇒ PASS（同上 + 5 行 runtime 装配一致，exit 0）
python -B tools/validate_development_docs.py     ⇒ PASS: 27 initial tasks; …; Markdown links and tables (exit 0)
git diff upstream/main --check                   ⇒ 空
git status --porcelain                           ⇒ 空（CLEAN）
```

## 7 未取得项（不得当成通过）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 真实 PG17 服务器的收藏/历史持久化 | **未取得** | 本机找不到 `initdb`/`pg_ctl`/`postgres`；`favorites-history-pg.mjs` 自跳过（不是通过）。本机只有 PGlite 引擎级覆盖 |
| 真实微信开发者工具 / 真机 / 预览 | **未取得** | 无微信工具链；小程序侧只有 vm 合成 `wx` + 合成响应 |
| 真实识别/OCR 供应商、真实登录 | **未取得** | 全程 `stub` + 合成身份；`real` 分支只验证「无凭据 fail-closed」 |
| bash 语法/脚本校验 | **未取得** | 本机 `bash` 是 WSL 存根（`bash -n` 空转 exit 0 不构成证据） |
| 收藏/历史「详情读」路由级证据 | **不适用** | 契约无 `GET /favorites/{id}`、无 `GET /history/{id}`；详情由列表 + 识别详情合成，已如实登记 |

## 8 已裁定事项与遗留

### 8.1 已裁定（派单方裁定，本片照此执行）

1. **用户主动取消的任务不产历史行 —— 保持现状，属显式判定而非缺口。**
   口径：「取消不算一次识别结果」，故不属于「失败任务」范畴。证据：`tests/unit/history-http.test.mjs:855-892`
   （F5：cancelled 终态不产历史行，且含「历史端口确实是 wired `:891`」的反例，证明不是端口未接线导致的空结果）。
   判定：**不修改** `services/api/src/recognitions/service.ts` 的终态投递条件；「失败任务可见」的覆盖范围是
   failed / timed_out / uncertain / queued（`history-http.test.mjs:339`、`favorites-history-visibility.test.mjs:170`），
   这三类非成功终态均已实测可见（§5-④）。
2. **门禁旗标 `--check` 是派单笔误。** 后续统一按「静态无参 + `--runtime`」两档执行；
   `--write-doc` 仅在需要同步生成区时使用，且必须由派单方批准（见 §6.5 注）。
3. **合并前必须合流**：本片已在 `feat/gy-i16-semantics` 上 `git merge --no-ff 8cc9dd8b1ee251c8d7000390d54e0ba07a6ac37f`，
   无冲突，冲突策略未启用（若出现则「保留本片新增断言 + 上游改动照抄」）；合流后全部门禁已复跑，读数见 §6.7。

### 8.2 遗留（不阻塞、不另开片、不修）

1. **`--test-isolation=none` 全量单测恒有 8 条 knowledge 失败**（§6.3，干净基线同样、逐项同名）
   —— 判定为**既有跨文件干扰，与本片无关**；按裁定不另开片、不修，也不作为本片门禁失败依据。
