# 写手独立身份、私有 Fork 与 PR 协作

日期：2026-10-09。用户本轮直接要求此流程，优先于历史共享 worktree／凭据约定。业务需求、已领取任务、验收门槛与历史审查不变。

## 1 当前状态：规则已确定，平台迁移待完成

目标是免费组织 `GenYunChuCao` 的私有主仓库，写手个人账户的私有 Fork，以及独立克隆目录。
2026-10-09只读 API 核对时，仓库仍为 `Sek1ro-oka/GengYun`、private=true；当前命令认证是所有者
`Sek1ro-oka`，有效 admin/push=true；`cxhhandsome` 是 Write 协作者，暂无可见组织，部署密钥为空。
用户补充：多个本地写手目前通过所有者账户提交，所述真人协作者不是写手账号，不因本次迁移改其权限。
API中协作者 login 为 `cxhhandsome`；用户所述名称 `xianhandsome` 不在本次流程中擅自映射为机器身份。
独立写手机器账号尚待用户确认，浏览器自动化因 helper 启动故障未能创建组织。**不能将本规范发布视为已完成组织创建、仓库转移、Read 权限或身份隔离。**

GitHub 允许获准的私有仓库 Fork 到个人账户；不能将私有 Fork 放进 GitHub Free 组织。
新组织默认禁止私有 Fork，须同时开启组织与仓库的 Fork 策略。[官方 Fork 说明](https://docs.github.com/en/pull-requests/reference/forks)／[组织策略](https://docs.github.com/en/organizations/managing-organization-settings/managing-the-forking-policy-for-your-organization)。

## 2 所有者完成的平台设置与验收

1. 创建免费组织 `GenYunChuCao`，由用户保留 owner 身份；不要购买套餐、公开仓库或让写手成为组织 owner。
2. 确认组织中没有同名仓库／同网络 Fork、所有者可创建仓库，再将原仓库转入组织并保持 private。
   保留 Git 历史、issue、PR、作者、批复与配置；转移后重新核对编号、分支／标签、开放 PR、CI、规则与集成。
3. 设置组织基础权限为 None，通过明确仓库邀请给写手 Read；确实需要管理他人 issue 时才给 Triage。
   检查有效权限及 team 继承，不授予 Write／Maintain／Admin、owner 或可写部署密钥。
   原协作者在转移后仍保留，不能假定转移自动降权；确认写手身份后核对其有效权限。
4. 在组织 Member privileges 开启私有 Fork，再在仓库 Settings 开启 Allow forking，允许写手 Fork 到个人账户。
5. 写手接受邀请、用自己的账号创建私有 Fork；验证上游 private=true、写手 pull=true/push=false、Fork private=true
   且 source／parent 指向新上游。不要通过向上游推垃圾分支来测试拒绝。
6. 核对 CI 对私有 Fork PR 的运行审批／权限；上游生产密钥不提供给未审 Fork 代码，不用
   pull_request_target 执行未审代码。普通 CI 通过仍不等于独立验收。

[仓库角色](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)
说明 Read／Triage 可提交 Fork PR，但不能推上游或合并。
免费私有仓库的分支保护／必需审查功能不保证可用，不能把 CODEOWNERS 或流程当作平台强制；
限制写手账户的有效 push 权限是本次隔离目标，所有者／监工仍按独立审查流程操作。

[转移说明](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository)
指出原协作者保留，旧地址会重定向；不要在旧路径重建同名仓库／Fork而破坏重定向。
迁移完成后再更新仓库入口及监工实际目标，历史链接、审查和已验 SHA 保留。

## 3 独立身份与克隆迁移

所有本地写手停止使用用户的账号、令牌、共享管理员认证或可写部署密钥。
多位本地代理需要各自独立 clone 和分支；可以经用户明确选择使用一个与所有者分开的机器账号，
但那只形成“所有者与写手”的平台隔离，不形成写手之间的独立身份／审查隔离。
本次用户已确认尚无机器账号，需注册与所有者分开的专用机器账号并本人完成登录。
本地各写手用独立目录、功能分支和PR记录区分任务，不能声称共享机器账号形成了逐写手平台身份隔离；
账号数量和使用遵循GitHub账户条款，监工不与写手共用认证。改 Git author 姓名不是认证迁移。
已知“写手”聊天已确认停止所有者认证写操作、没有在途写入；其旧工作区干净，分支
`codex/db-handoff-closeout`、HEAD `1406f2fae12c30cc6e06730304a2399a604c4b52`，仍共享 `E:/COC/.git`。
其他写手的确认与成果盘点另记，不能由这一回执推断全部写手已迁移。
旧 worktree 暂保留作为成果来源：核对根目录、分支、HEAD、已提交／已跟踪未提交／未跟踪成果，
私密备份放自己忽略目录；不要把密钥、原始媒体、Excel 或抽取 raw 加入 Git 或对外备份。
不修改共享 Git common-dir 的 remote／credential 配置，不切换全局认证，不覆盖或删除旧成果。

待个人 Fork 和独立认证可用，再创建拥有自己 `.git` 的独立 clone，不能使用仍共享 common-dir 的 worktree。
使用 clone 级 SSH 身份或安全凭据设置；writer 启动环境不得加载 owner 的令牌／凭据。
同一操作系统账户仍可能访问其保存的凭据，独立 clone 本身不产生操作系统权限隔离；
若要求强制不可访问 owner 凭据，应由用户提供独立操作系统账号／受限执行环境，不能声称仅修改 remote 已实现。
密钥和令牌通过本地私密配置／独立交互登录交接，不发聊天、不嵌 URL、不记日志。

以下 URL 是平台迁移与账号确认后的模板，不能在旧共享 worktree 直接执行：

```powershell
git clone https://github.com/WRITER_ACCOUNT/GengYun.git GengYun-writer
cd GengYun-writer
git remote add upstream https://github.com/GenYunChuCao/GengYun.git
git fetch upstream
git switch -c feature/任务名称 upstream/main
```

`origin` 只写自己的 Fork；`upstream` 只读组织主库。迁移分支用可核对的旧提交导入，未提交成果先检查再恢复，
核对 HEAD／patch 差异一致。未跟踪文件逐项确认，不复制 ignored 凭据／依赖输出到 Git。
已有 PR 作者不因新认证改变；跨 Fork 延续必要时先记录旧 PR→新 PR 映射并保留全部讨论，
不能由写手删除负面批复、悄关旧 PR 或宣称身份迁移完成了业务 issue。

## 4 开发、修订与合并

完整流程：**指挥安排 → 写手开发并提交 PR → 监工审查 → 写手按批复修订 → 监工复验并合并**。

每轮先同步上游并读 issue 批复、PR 总评／行内意见／回复／未解决线程与当前 HEAD，接续已领取任务。
写手仅推个人 Fork 的功能分支，向组织主库 main 发起 PR；不写上游、不合并、不替监工批准。
正文记录真实 issue、完成范围、完整 SHA、检查命令／结果、未验证和未完成验收；部分完成使用 Refs，
全部条件满足才 Closes。不得提交凭据／私人原始资料，把 CI 成功写成验收通过。

修复逐项回应，新增提交重新审查；提交后在 PR 内申请审查（Read 可评论请求，Triage 可使用平台请求审查）。
跨聊天通知仍须用户另行授权，身份迁移不自动恢复过期开发时段或授权新的业务派发。
监工独立核验当前 SHA、适当 CI、冲突和未解决意见，通过后按用户授权合并；不伪造独立身份或批准。

## 5 迁移交付清单

| 验收 | 状态与证据要求 |
| --- | --- |
| 免费组织创建、用户 owner | 待实际页面／API确认 |
| 私有主库转移与原成果保留 | 待新 full_name/private、分支／PR／issue核对 |
| 写手独立账号与有效 Read／Triage | 待账号本人登录、接受邀请及有效 push=false |
| 私有 Fork 与正确 source | 待个人 Fork API确认 |
| 独立 clone／自己的 origin／只读 upstream | 待实际 root/common-dir／远端和身份核对 |
| 旧提交／未提交成果与审查记录 | 保留，待迁移差异与旧新 PR 映射核对 |
| 新身份 Fork PR／监工独立合并 | 待新实际 PR／审查证据；不重复生产或付费调用来验身份 |

完成后由治理 PR 补记真实结果，不能预填“已隔离”或“已验收”。
