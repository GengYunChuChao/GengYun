# GY-R34 · `#18` 后台「社区帖下架」最小可用入口（2026-10-23）

> 基线：`upstream/main` = `765b6a31d993995e5dacbf6a3227ebcbb97fd8df`（开工时 `git rev-parse upstream/main` 实测，与派单一致，未前进）。
> 分支：`feat/gy-r34-i18-post-takedown-ui`；工作树：`E:\GengYunCommander\wt-r34-i18-post-takedown`。
> `Refs #18` —— **本页不构成 `#18` 完成**（见 §7：关单权在监工，且本页只交付「入口 + 如实语义」，未取得真实下架与 real 端到端）。

## 0 摘要

1. **入口**：把「社区帖下架」做成 `ContentAdminView` 的**第 4 个 inner family**（`FAMILIES` 清单 ＋ 渲染链），
   **`App.vue` 0 行改动**（§2 有证明命令）。依据：`.pg17/ruling-r34-i18-post-takedown-entry-20261023.md` 第 1 条。
2. **形态**：按**帖子 ID 直接下架**。契约里没有任何帖子读面（`/admin/posts` 全契约只有 1 条 path：
   `openapi.json:11123`），因此**不造帖子列表/队列**（造列表＝伪造数据）。
3. **`If-Match` 永不为 `*`**：表单层就拒绝通配（`*` 时**零请求**发出），请求头里只有 `"<正整数>"`（§3、§5）。
4. **real 模式 503 如实显示为失败**：不写成成功、不吞错误，并明确提示「处置可能已生效」＋「不会自动重试」。
   成功回执只说「服务端已受理（HTTP 200 · accepted:true）」，**不写「已下架成功」**。
5. **门禁**：新增 28 例（22 纯函数 ＋ 6 渲染）全绿；`tests/unit/admin-*.test.mjs` **427/427**；
   `node tools/verify-contract-status.mjs` **exit 0**；`npm run lint`（services/api ＋ apps/admin 两处 `tsc --noEmit` ＋ 仓库卫生扫描）**exit 0**；
   `npm run build --workspace @gengyun/admin`（vite build，真实工具链）**exit 0**。
6. **未取得**：浏览器/真机走查、真实下架、real 模式端到端、审计落库、社区侧可见性（§6 逐条列出）。

## 1 入口位置与裁定依据

- **裁定**：`.pg17/ruling-r34-i18-post-takedown-entry-20261023.md`
  - 第 1 条：作为 `ContentAdminView` 第 4 个 inner family，**不改 `App.vue`**；
  - 第 3 条：⛔ 不造帖子列表/队列、⛔ 不改契约、⛔ 不加迁移；
  - 第 4 条：real 下 503 必须原样显示；
  - 第 5 条：纯函数层 ≈20–24 例 ＋ 渲染级 ≈5–8 例（`@vue/compiler-sfc` ＋ `createRenderer`，⛔ 不新增依赖）。
- **挂载链**（逐跳可核）：
  `apps/admin/src/App.vue`（未改）→ `<ContentAdminView v-else-if="active === 'content'" />`
  → `apps/admin/src/views/ContentAdminView.vue` 的 `FAMILIES`（现 4 条）与渲染链
  → 新增 `<PostTakedownView v-else-if="active === 'posts'" … />` → `apps/admin/src/views/PostTakedownView.vue`。
- **4 个 inner family**：资料来源（`/admin/sources`）／科普内容（`/admin/knowledge`）／分类（`/admin/categories`）／
  **帖子下架（紧急处置）（`/admin/posts/{id}/hide`）**。
- **口径代价（已登记，见裁定第 2 条）**：`App.vue:15` 的外层 tab 文案「来源 / 科普 / 分类」**不再穷举**内部 family；
  「资料管理」里装「帖子下架」语义略勉强。本片**按裁定不改文案**。

## 2 `App.vue` **0 改动**的证明

```text
$ git diff --name-only upstream/main...HEAD -- apps/admin/src/App.vue
（无输出）

$ git diff --numstat upstream/main...HEAD -- apps/admin/src/App.vue
（无输出）

$ git diff --numstat upstream/main...HEAD -- apps/admin/src/views/ContentAdminView.vue
8       0       apps/admin/src/views/ContentAdminView.vue
```

`ContentAdminView.vue` 的 **+8 / -0** 逐项对应：import 1 行 ＋ `FAMILIES` 1 条 ＋ 渲染分支 6 行（裁定估计 5–8 行，
实测 8 行，在区间内；该分支把两个单行短绑定 `:scopes` / `@signed-out` 并在一行，以守住上限）。
**未改动任何其它视图**（`git diff --name-only` 全量清单见 §8）。

## 3 后端契约对齐点（自己读代码确认，不照抄侦察报告）

| 维度 | 后端/契约事实（文件:行 实测） | 前端落点 |
| --- | --- | --- |
| 路径 | `POST /admin/posts/{id}/hide`；`packages/contracts/openapi.json:11123`（path）、`:10834`（`operationId: hidePost`） | `post-takedown-api.mjs` 的 `POSTS_PATH`/`HIDE_ACTION` → `buildHidePostRequest` |
| scope | `openapi.json:11035` `x-scope: sources:write`；`services/api/src/admin/ops/service.ts` `hidePost: 'sources:write'` | 常量 `SOURCES_WRITE_SCOPE`；缺 scope 只提示 ＋ 禁用按钮（不放行） |
| 版本必需 | `openapi.json:11198` `x-version-required: true`；参数 `IfMatch`（pattern `^"[1-9][0-9]*"$`，`required: true`） | `buildIfMatch` / `checkIfMatchHeader` |
| **`*` 被拒** | `services/api/src/admin/identity.ts` 的 `parseIfMatchHeader`：缺 → **428 `REVISION_REQUIRED`**；形状不符 → **400 `INVALID_REQUEST`**，原文「If-Match 必须是形如 "12" 的强 ETag，且不允许 *」 | `validateRevision('*')` → `code: 'wildcard'`，**不发请求**；`buildHidePostRequest` 二次校验 |
| 幂等键 | 参数 `IdempotencyKey`（8..128，required）；`services/api/src/admin/identity.ts` 的 `requireIdempotencyKeyValue`：缺 → 400 `IDEMPOTENCY_KEY_REQUIRED`，越界 → 400 `INVALID_REQUEST` | `newIdempotencyKey()`（前缀 `admin-post-takedown-`）＋ `planIdempotencyKey`（同指纹复用、换内容换键） |
| 请求体 | `ReasonInput`（`reason` 1..500，`additionalProperties: false`，`requestBody.required: true`） | `buildReason`；请求体**只有** `{reason}` |
| 200 形状 | `AckEnvelope`：`{data: {accepted: boolean}, meta: {request_id, contract_version, execution_mode}}` ＋ `ETag` 头 | `validateAck`；`accepted !== true` ⇒ `invalid_response`（不判成功） |
| 404 | `NOT_FOUND`（`hideAdapter.hide` 的 `NOT_FOUND` 分支 → `service.ts` `hidePost` 抛 404） | `classifyHideFailure`：**有无错误信封同形**，同一 `kind`/同一文案；与「已删除」明确区分 |
| 409 | `REVISION_CONFLICT` / `OBJECT_UNAVAILABLE`（`DELETED`＝已删除不可复活、`NOT_PUBLIC`＝非已发布）/ `IDEMPOTENCY_CONFLICT` / `REQUEST_IN_PROGRESS`；`services/api/src/contract.ts:19` | 按 `code` 四分；**无 code 的 409 不猜**（`conflict_unknown`） |
| **412** | **不是本后端的状态**：`contract.ts` 的 `ERROR_STATUS_MAP` 里 `REVISION_CONFLICT` 是 **409**，全契约无 412 | 只做防御性映射 `precondition_failed`，原样失败、**不折叠成 409** |
| 503（real 未接线） | `services/api/src/admin/ops/accounts-only.ts`：`hidePostWired` 默认 `false` ⇒ `hidePost: reject`；服务层 503 `PROVIDER_UNAVAILABLE`（`retryable: false`） | `classifyHideFailure` → `unavailable` ＋ `maybeEffective: true`；文案含服务端原文与 `execution_mode` |
| 503（已生效但审核域失败） | `services/api/src/app.ts` 的 `withModerationTakedownLink`：CAS 成功后 `link.withdraw` 失败 ⇒ 503 原文「后台下架已生效，但审核域缓存失效未完成…」（`retryable: false`） | 同一 `unavailable` 分支，文案提示「**处置可能已生效**，勿盲目重发，先查审计 `post.hide`」 |
| `retryable` 口径 | 服务端信封自带 `error.retryable`；`services/api/src/errors.ts` 注释即唯一口径 | **取服务端声明**，本地只在信封缺失时用闭集（429／处理中／网络错误） |

## 4 门禁读数（写包后实测）

```text
$ node --test tests/unit/admin-ui-post-takedown.test.mjs tests/unit/admin-ui-post-takedown-render.test.mjs
ℹ tests 28
ℹ pass 28
ℹ fail 0

$ node --test tests/unit/admin-*.test.mjs          # 既有 admin 面全量（含本片 28 例）
ℹ tests 427
ℹ pass 427
ℹ fail 0
ℹ skipped 0

$ node tools/verify-contract-status.mjs
PASS: 覆盖 113 条契约操作；已装配 109 条；implemented 17 / partial 92 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
PASS: 语义可核 105 条区间 + 0 条片段；不可核 99 条区间 + 160 条片段（不可核不计入通过）
PASS: 证据锚点 414 条引用自带锚点（区间内 240 条 + 仅整文件 174 条）；无锚点不可核 0 条 …
PASS: 中文表格一致
exit=0

$ npm run lint
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
exit=0

$ npm run build --workspace @gengyun/admin        # vite build：真实工具链编译 SFC，证明 import 也能解析
vite v7.3.6 building client environment for production...
✓ 50 modules transformed.
dist/assets/index-B1Yy5NYL.js   285.42 kB │ gzip: 87.34 kB
✓ built in 1.04s
exit=0
# 构建后 `git status --porcelain -uall` 仍为 0 行（`dist/` 已被 .gitignore:22 忽略）

$ node tools/verify-doc-anchors.mjs --strict     # 新证据页的「路径:行号」引用不得新增可疑锚点
SCAN: 文档 257 份；抽出「路径:行号」引用 4758 条
BASELINE: 登记 105 条；本次命中 105 条、基线外新增 0 条、陈旧 0 条
PASS: --strict 下没有基线之外的新增
exit=0
```

- 跑法：`node --test <定向文件>`（**未用** `--test-isolation=none`）。
- `apps/admin` 有 `tsconfig.json`，其 `typecheck` 脚本即 `tsc -p tsconfig.json --noEmit`；上面 `npm run lint` 已覆盖该步（并连带 services/api）。
- 额外跑了 `npm run test:docs`（`validate_development_docs.py` ＋ `verify-research-records.mjs`）：exit 0，新证据页不破坏文档校验。

## 5 负控制（证明用例真的钉住了行为，不是空跑）

两次「故意改坏 → 跑 → 恢复」，均以文件 SHA256 校验恢复一致（`Copy-Item` 备份，UTF-8 无 BOM 读写）：

| 探针 | 改动 | 期望红 | 实测 |
| --- | --- | --- | --- |
| P1 | 删掉成功分支的 `form.value = emptyTakedownForm()` | 只有「成功后清空」1 例红 | **1 红 / 5 绿**，红的正是该例 |
| P2 | 把失败回执 `describeTakedownFailure(result)` 换成 `describeTakedownSuccess(...)` | 只有「503 失败文案」1 例红 | **1 红 / 5 绿**，红的正是该例 |

> P1/P2 各自只打红一条 ⇒ 渲染级用例是真断言，且互不遮蔽。恢复后 `Get-FileHash` 与改前逐字一致，随后 28/28 复绿。
> （第一次探针因 PowerShell 5.1 `Get-Content -Raw` 按 GBK 解码中文而整片变红 —— 与改动无关；改为 `[System.IO.File]::ReadAllText(..., UTF8)` 后重跑得到上表结果。）

## 6 未取得项（如实）

1. **未做浏览器/真机走查**：无 headless 浏览器（仓内前端测试没有 vitest／jsdom），渲染级用例只在内存宿主里跑真实 SFC。
2. **未做真实下架**：未连真库、未起服务、未调用任何真实 `POST /admin/posts/{id}/hide`。
3. **未做 real 模式端到端**：real 下 `hidePostWired=false` ⇒ 服务端仍 503；本片**没有**放宽该门（`accounts-only.ts` 未改）。
4. **未验证审计落库与审核域联动**：`post.hide` 审计、`withdrawn` 永久标记的实际写入未观测；页面只提示「审计由服务端留痕」。
5. **未验证社区侧可见性**（契约无帖子读面，本页无法自证下架效果）。
6. **未改**契约／迁移／台账：无新增 operationId、无表/列变更 ⇒ 无迁移号命名空间冲突面。
7. **未验证** 412 路径的真实存在性（后端不产生 412，属防御性分支）。

## 7 声明：**不构成 `#18` 完成**

本片只交付「**最小可用入口 ＋ 如实服务端语义**」：入口可达、参数真校验、失败真上屏。
它**不**证明 `#18` 的「下架」在真实环境可用（real 仍 503），也**不**覆盖浏览器验收与真实处置。
关单权在监工；提交信息只用 `Refs #18`，**不含任何可解析关单关键字**。

## 8 变更清单（写包实测）

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `apps/admin/src/lib/post-takedown-api.mjs` | 新增 | 请求构造 / revision 与 `If-Match` 校验 / 响应与错误映射 / 幂等键规划（纯函数 ＋ 可注入 fetch） |
| `apps/admin/src/lib/post-takedown-form.mjs` | 新增 | 表单校验与可提交判定（纯函数） |
| `apps/admin/src/views/PostTakedownView.vue` | 新增 | 视图（按 ID 直接下架，无列表） |
| `apps/admin/src/views/ContentAdminView.vue` | 改 **+8/-0** | 仅 family 清单项 ＋ 渲染分支 |
| `tests/unit/admin-ui-post-takedown.test.mjs` | 新增 | 纯函数层 22 例 |
| `tests/unit/admin-ui-post-takedown-render.test.mjs` | 新增 | 渲染级 6 例 |
| `docs/verification/gy-r34-i18-post-takedown-ui-20261023.md` | 新增 | 本页 |
| `apps/admin/src/App.vue` | **未改（0 行）** | 见 §2 |

不新增依赖（渲染级沿用 `@vue/compiler-sfc` ＋ `vue` 的 `createRenderer`，先例 `tests/unit/admin-jobs-signin-form.test.mjs`）；本工作树独立 `npm ci --prefer-offline --no-audit --no-fund --ignore-scripts`（`git diff -- package-lock.json` 为空，lockfile 未变）。

**联接如实披露（红线项自证）**：`npm ci` 自身在 `node_modules/@gengyun/{admin,api}` 建了两条 workspace 联接。实测两条重解析点都指向**本工作树内**：

```text
$ Get-ChildItem -Path . -Recurse -Force -Directory | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
node_modules\@gengyun\admin -> E:\GengYunCommander\wt-r34-i18-post-takedown\apps\admin
node_modules\@gengyun\api   -> E:\GengYunCommander\wt-r34-i18-post-takedown\services\api
```

⇒ **没有任何指向其它 worktree 的 `node_modules` 联接**（`AGENT.md` 的红线项）；两条都是 npm 自建的自指联接，均在 `node_modules/`（已被 `.gitignore` 忽略）。将来若删本工作树，须先 `cmd /c rmdir` 摘掉这两条再 `git worktree remove`（同 `AGENT.md` 的 junction 纪律）。

## 9 清理清单与零残留

- 临时物**仅两处、均已删除**（`Test-Path` 复查为 `False`）：两次变异探针的备份 `%TEMP%\ptv-backup.vue`（仓外），
  与一次性提交信息文件 `E:\GengYunCommander\.pg17\tmp\r34-i18-commit-msg.txt`。未在仓库内留任何探针/中间产物。
- 未删除、未改动任何他人 worktree 或仓库既有文件；`git status --porcelain -uall` = **0 行**（收尾回报里给读数）。
- 未访问 `E:\GengYunPrivate\`；未读取或打印任何凭据（测试用令牌字面量为 `synthetic-*`）。
