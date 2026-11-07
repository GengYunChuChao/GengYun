# 注销「受理即不可撤回」裁定记录：收回「可凭回执取消」的产品承诺（2026-11-07）

- 基线：`origin/main = 040867a71f3e9401eceab2b91705b59eb8e19d14`（`git fetch origin --prune` 后实测）；本页的取证行号全部在这条基线上复核，**不是**从派单里照抄的旧读数。
- 工作树 `E:\GengYunCommander\.pg17\wt-r87-i19copy`，分支 `docs/gy-r87-i19-cancel-honest`，`git rev-parse HEAD` = `040867a7`。
- 本页只做两件事：① 把小程序里「受理后还能凭回执取消」的产品承诺收回；② 把「为什么现在不做撤销链」的裁定、证据与遗留登记下来。**没有**改 `services/**`、**没有**新增迁移、**没有**改契约与契约台账（`packages/contracts/openapi.json`、`docs/architecture/contract-status.json`、`docs/architecture/contract-implementation-status.md` 三个文件本片一个字都没动）。
- 同一缺口此前已登记过两处，本页引用而不改写它们：`docs/verification/gy-r82-failmatrix-reconcile-20261106.md:103`（§7 第 5 条：real 模式下「受理后撤销注销」走不通，只实测到 401/403，「没有验证前端是否另有撤回入口」）与 `docs/verification/gy-r82-user-verification-checklist-20261106.md:43`（D-c 条目：同一问题，未开单）。本页补齐的正是那两句留下的空白——**前端确实另有撤回入口**，而且它在文案里明确承诺过「可以凭回执取消」。

## §1 裁定

**`#19` 保持「注销受理即不可撤销」，不造撤销链；做的是把承诺收回，而不是把能力补上。**

理由：

1. 架构口径已经定死「受理即撤会话」——`docs/architecture/state-contract.md:105` 逐字写明：注销请求 202 的返回在**同一事务**将账号改 `deletion_pending`、撤所有用户会话/角色、`auth_epoch` 递增、冻结外发与写入，并且「受理成功后旧会话不再可调用 API」。
2. 法条层面，个体删除权要求的是**删除**，不是**可撤回的同意**：《个人信息保护法》第 47 条列举的是删除义务的触发情形（处理目的已实现或无法实现、停止提供产品或服务、保存期限届满等），撤回同意则是另一条（第 15 条）。所以「注销一经受理不得撤回」不违反个保法 47 条，也**不要求**为注销设冷静期。
   - ⚠️ 本页只写「法条要点」，**不作合规结论**：条号与条文的对应关系**需法务确认**；本页不引用任何未经核对的条文原文，也不因这条理由单独立项。
3. `#19` 自己的三条验收条件里**没有**撤回项；撤销注销若要真做，需要新的状态迁移、新的鉴权形态（回执 bearer 或一次性 token）与新的数据库写路径，属另开需求（见 §5 草案），不塞进这个 issue。

## §2 现状事实链（全部按本页基线复核）

**① 受理注销时，SQL 事务里就把该用户全部会话撤销。**

`services/api/db/migrations/0016_account_deletion_persistence.sql:130-135`，注释与语句原文：

> `-- ② 撤销该用户**全部**活跃会话（不是当前一个）：这是「401 SESSION_EXPIRED」的成因，`
> `--    与 auth_epoch 造成的 403 是两个可分离的机制（判定 §5「两者都真、不得混用」）。`
> `UPDATE public.sessions SET revoked_at = now() WHERE user_id = p_user_id AND revoked_at IS NULL;`

同函数更早的 `services/api/db/migrations/0016_account_deletion_persistence.sql:122-128` 先做 `state = 'deletion_pending'`、`auth_epoch = auth_epoch + 1`、`revision = revision + 1`。

**② 取消路由挂的是用户会话鉴权。**

`services/api/src/routes/account-deletion.ts:358-364`：`app.delete('/me/account/deletion', …)`，注释逐字「鉴权 = 用户会话（**不是**回执 bearer）」，`preHandler: guards.requireUser`。对照读面：`services/api/src/routes/account-deletion.ts:318-356` 的 `GET /account/deletions/:id` **不挂** `requireUser`，用的是专用回执 bearer。

**③ 于是受理后调 `DELETE /me/account/deletion` 必然 401；换新会话则 403。**

- `services/api/src/auth/middleware.ts:75-80`：会话已撤销 ⇒ `throw new ApiError('SESSION_EXPIRED', '用户会话已过期或已失效')`。
- `services/api/src/auth/middleware.ts:88-94`：`user.state !== 'active'` ⇒ `ACCOUNT_INACTIVE`（账号不可用）；`session.authEpoch !== user.authEpoch` ⇒ `ACCOUNT_INACTIVE`（会话已因账号变更失效）。注销受理同时把这两件事都做了。

**④ 更硬的一层：就算鉴权改通，取消也不落库。**

- `services/api/src/privacy/deletion-requests-pg.ts:109` 的注释自陈「注销请求的持久化端口（只暴露「受理」这一个动作）」；接口 `DeletionRequestStore` 唯一方法是 `createRequest`（`services/api/src/privacy/deletion-requests-pg.ts:116`）。
- 该文件里 `cancel` / `cancelled` / `withdraw` 三个词 `git grep -in` **零命中**（exit 1）。
- 台账 `docs/architecture/contract-implementation-status.md:70` 把 `cancelDeletion` 记为 `partial`，blocker 逐字：「取消只推进**进程内**协调器状态（deletion.mjs/deletion-modules.mjs），数据库侧 `deletion_requests.state` 的 `cancelled` 写路径未接线（本片只做 0039 枚举值 + 契约/应用层闭集，持久化取消属后续片）」。

**⑤ 连管理员也撤销不了。**

`services/api/db/migrations/0017_account_suspend_authority.sql:272-273`：`restore_account` 对 `deletion_pending` / `deleted` 直接 `RAISE EXCEPTION USING ERRCODE = 'G0004', MESSAGE = 'OBJECT_UNAVAILABLE'`。也就是说没有任何后台操作能把 `deletion_pending` 拉回来。

**⑥ 而前端文案两处明确承诺可取消（旧行 374／387，改后为 376／389，逐条见 §3）。**

- `miniprogram/pages/deletion/deletion.js` 第一层确认（旧行 374）：「…在服务端完成之前，**你可以用回执取消**。」
- 同文件第二层确认（旧行 387）：「…凭本机保存的回执凭据可以查询进度，**也可以在生效前取消**。」
- 页面副标题 `miniprogram/pages/deletion/deletion.wxml:8`（改前）：「…用回执查看进度，**并在服务端完成前取消**。」
- 取消入口自己的第一次确认（旧行 459，改后 `miniprogram/pages/deletion/deletion.js:461`）：「**取消后账号恢复为未申请注销**，数据不会被删除；这条回执随即作废。确认取消这次申请？」——受理后这条路会 401，所以这句话在 real 下同样是空头承诺（见 §3 最后一行）。
- `miniprogram/utils/deletion-api.js:11` 的接口表写 `cancelDeletion | DELETE /me/account/deletion | 登录会话 [user]` —— 这一行是**事实描述**（接口确实挂会话鉴权），保留不改。

## §3 已收回的文案（旧文 → 新文）

| 位置（提交后行号） | 旧文 | 新文 |
| --- | --- | --- |
| `miniprogram/pages/deletion/deletion.js:376` | 「…客户端不自己算天数；**在服务端完成之前，你可以用回执取消**。」 | 「…客户端不自己算天数。**注意：服务端受理这个申请时会立即撤销这个账号的所有登录会话；该申请一旦受理就不能在客户端撤回**。」 |
| `miniprogram/pages/deletion/deletion.js:389` | 「…可以查询进度，**也可以在生效前取消**。」 | 「…可以查询进度。**受理后服务端会立即撤销这个账号的所有登录会话，该申请不能在客户端撤回**。」 |
| `miniprogram/pages/deletion/deletion.js:347` | 「需要先登录：**注销与取消**都绑定当前登录账号。」 | 「需要先登录：注销绑定当前登录账号。」 |
| `miniprogram/pages/deletion/deletion.wxml:8` | 「…用回执查看进度，**并在服务端完成前取消**。」 | 「…用回执查看进度；**申请一经服务端受理就不可撤回**。」 |
| `miniprogram/pages/deletion/deletion.wxml:22` | 「…**申请与取消**都发不出去…」 | 「…**申请与查回执**都发不出去…」 |
| `miniprogram/pages/deletion/deletion.wxml:30` | 「**申请与取消注销**都绑定当前登录账号。」 | 「**申请注销**绑定当前登录账号。」 |
| `miniprogram/pages/deletion/deletion.wxml:180`（新增一行） | —（无） | 「不可撤回：申请一经服务端受理，这个账号的全部登录会话就会在同一事务里被撤销；此后没有自助撤回通道（下面的「取消注销申请」走的是用户会话鉴权，会话撤销后它不会成功）。」 |
| `miniprogram/pages/profile/profile.wxml:242` | 「…**申请与取消都要二次确认**；冷静期与生效时间…」 | 「…**申请要二次确认；一经服务端受理就会立即撤销这个账号的全部登录会话，申请不可撤回**。冷静期与生效时间…」 |
| `miniprogram/pages/deletion/deletion.js:6-8`（文件头注释） | 「→ **生效前取消**（DELETE /me/account/deletion，二次确认）。」 | 「→ 取消（…二次确认；**real 模式下受理事务已撤销该用户全部会话 ⇒ 这条路径 401/403 不可达**，用户文案因此不承诺可撤回…）。」 |
| `miniprogram/pages/deletion/deletion.js:461`（取消入口第一次确认） | 「取消后账号恢复为未申请注销，数据不会被删除；这条回执随即作废。确认取消这次申请？」 | 「…这条回执随即作废。**注意：真实服务端在受理注销时已撤销这个账号的全部登录会话，此时这次取消会被判会话失效而失败。**确认取消这次申请？」 |

测试兼容性：`tests/unit/miniprogram-account-deletion.test.mjs:206-208` 钉住的是「第一次确认必须含 `不可恢复`」「必须含 `以服务端返回的 deletion 字段为准`」「第二次确认含 `确认向服务端提交注销申请`」三条正则 —— 新文案把这三处全部保留，只换尾句。取消面那些用例（同文件 306、423-444、494-515 行）只断言「两次确认」「`confirmText` 恰 4 字」「不发请求」，没有任何一条逐字钉住弹窗正文，所以改 `miniprogram/pages/deletion/deletion.js:461` 的正文也不破测试：**全程没有改任何测试**。同一文件（`tests/unit/miniprogram-account-deletion.test.mjs`）546-563 行的九态闭集只看 `status="…"` 属性，`miniprogram/pages/deletion/deletion.wxml` 的九个状态属性一个字都没动。

## §4 遗留：`cancelDeletion` 在 real 下不可达（改判属监工）

- **契约操作名存实亡**：`packages/contracts/openapi.json` 里有 `cancelDeletion`（`DELETE /me/account/deletion`），台账记 `partial`（`docs/architecture/contract-implementation-status.md:70`），但在 `real` + 真库的装配下它**结构性不可达**（§2 ①–④ 的链条：受理即撤全部会话 ⇒ 取消必 401；换会话必 403）。
- **DB 侧没有 `cancelled` 写路径**：`deletion_requests.state` 的 cancelled 只存在于枚举（迁移 0039 只做 `ALTER TYPE … ADD VALUE`）与进程内协调器；`services/api/src/privacy/deletion-requests-pg.ts` 的端口仍只有 `createRequest`。
- **状态机也没有这一格**：`docs/architecture/state-contract.md:107` 写的是 `requested → processing → completed`、失败 `blocked`，全篇没有 `cancelled`。
- **本页不决定**：这个契约操作是**从契约里删掉**、**降级成 admin-only**、还是**保留并在文档里标注「real 下不可达」**——三选一属监工改判权限，需要同步动的三个文件（`packages/contracts/openapi.json`、`docs/architecture/contract-status.json`、`docs/architecture/contract-implementation-status.md`）本片按派单要求一个字都没碰。本页只把事实摆出来。
- **客户端仍保留入口**：`miniprogram/pages/deletion/deletion.wxml:164` 的「取消注销申请」按钮与 `miniprogram/pages/deletion/deletion.js:444-494` 的取消入口（两次确认）都还在（stub 路径下它真的能走通，`tests/unit/miniprogram-account-deletion.test.mjs:316` 等用例依赖它）。是否移除按钮、或按 `meta.execution_mode` 做模式门控，同属改判，本片只在文案里写明它「不会成功」，不动按钮与流程。

## §5 另开需求单草案（只写在本页，不建 GitHub issue）

**标题**：注销受理后的可撤回窗口（撤销注销的持久化写路径 + 自助入口）

**依赖**：`#19`（本页的裁定先落地，撤销能力才谈得上「窗口」）。**建议类型**：feature，非 `#19` 的验收项。

**验收（6 条）**：

1. real + 真库：用**指定凭据**（回执 bearer 或一次性 token，二选一在需求里定死）撤回 ⇒ `200`，返回体 `state = cancelled` 且带 ETag／revision；**负控制**：改用旧用户会话发同一请求仍 `401`（证明撤回通道不是把受理时的撤会话撤销掉了）。
2. 重启服务后再次读取：取消已**落库**（`deletion_requests.state = cancelled` 从数据库读回，不是进程内状态）；对已取消的请求再次撤回 ⇒ `409`。
3. 取消后 `public.users.state = 'active'` 且 **`auth_epoch` 不递减**（不回退、不复活旧会话、不把 `sessions.revoked_at` 清空）；旧会话重放仍按失效处理。
4. 窗口外撤回（超过需求定义的窗口，或请求已进入 `processing/completed`）⇒ `409`，且**不产生半成品**：不新增 outbox 行、不推进 revision、不留部分写入。
5. 竞态两条：① 撤回与受理事务并发 ⇒ 只有一侧生效，另一侧得到确定的终态错误，不出现「账号已 active 但删除请求仍在跑」；② 撤回与在途派发（module_handler / 第三方）并发 ⇒ 迟到回调不复活删除、也不把已取消的请求推回 `processing`。
6. 门禁与台账同步：`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 增加**函数级**断言（新函数只被允许的角色可执行）；`docs/architecture/state-contract.md:107` 的状态机补上 `cancelled` 与它的出边；`docs/architecture/contract-implementation-status.md:70` 的 blocker 逐字更新（把「未接线」改成已接线的实测口径或明确降级理由）。

## §6 锚点与闸门

- **锚点位移**：改 `miniprogram/pages/deletion/deletion.js` 前先查 `git grep -n 'deletion.js:' -- docs miniprogram tests tools` ⇒ **零命中**（没有任何文档按行号引用这个文件），因此本次改动**不产生**文档锚点位移，也不需要动 `tests/unit/doc-anchor-relocations.json` 或 `tools/doc-anchors-*.json`。
- 闸门读数见提交前实跑，逐条退出码记在交付报告里（本页不复制读数行，避免两处不同步）。

## §7 本页不声称什么

- **不声称撤销能力已实现**：`DELETE /me/account/deletion` 在 real + 真库下依旧不可达，DB 侧没有 `cancelled` 写路径；本页只收回**文案承诺**，没有补能力。
- **不声称有客服/人工通道**：仓库里没有任何客服入口（`git grep -in 'kefu'` 零命中；`客服` 只出现在「便于客服对账」这类旁白里），所以新文案**没有**写「请联系客服」——没有的入口不写进产品话术。
- **不声称契约已定稿**：`cancelDeletion` 是删、是降级、还是留着标注，属监工改判（§4），本页不预设结论。
- **不声称法条解读已合规确认**：§1 的法条要点只用于解释「为什么不必须设冷静期」，条文与条号的对应**需法务确认**。
- **不声称 `#19` 因此可关**：本页只处理「承诺 vs 现实」这一条不一致，`#19` 的其余验收项按各自证据单算。
