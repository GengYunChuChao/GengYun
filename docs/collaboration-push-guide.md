# 协作推送指南（协作者 / 监工 / 指挥）

更新：2026-10-14 ｜ 仓库：`GengYunChuChao/GengYun`（public，组织所有）
关联：`AGENTS.md`（角色与边界）、`docs/pr-review-policy.md`（审查门槛）

> 适用范围：本指南给出**当前分工下的主路径**（指挥与其**自有写手**走"仓内分支 + 指挥代推"）。
> **其他协作者保留既有身份、Fork 与分支**，不因此迁移 Fork 或修改共享 remote。

---

## 0 所有角色通用

### 0.1 铁律
- **不直推 `main`**（仅用户明确授权的特定操作例外）；**不强推**（禁用 `--force` / `--force-with-lease`）；**不改写已推送历史**。
- **凭据只从文件或环境读取**：不得进入对话、仓库、PR、日志或命令行参数（argv）。
- **作者不能批准自己的 PR**；不得伪造 `APPROVED`。
- 送审前**先与当前主分支（`origin/main` 或 `upstream/main`）合成**；**按改动影响选择适用检查并复用有效证据**，不机械要求全量重跑；**没有运行过的检查不得写"通过"**。
- 一个分支一个任务；PR 用 `Refs #N`，**不关闭整项**（除非该 PR 确实完成并验收整项）。
- 提交新 commit 会改变 HEAD ⇒ **需按审查规范重新绑定已验 SHA**（不因此重复与改动无关的检查）。

### 0.2 标准流程（主路径：仓内分支）
```bash
git fetch origin --prune
git switch -c feat/gy-i27-privacy-guard origin/main   # 用具体分支名；不要写 "feat|fix|chore/<topic>"（会被 shell 当管道）
# …实现 + 自检（按改动影响选择适用门禁 / 真机证据）…
git add -A && git commit -m "feat(GY-I27): ……（Refs #29）"
git push -u origin feat/gy-i27-privacy-guard
# 开 PR（见 §3 模板）⇒ CI 自动运行 ⇒ 独立审查 ⇒ 合并 main
```

---

## 1 协作者（保留自己的身份与 Fork）

1. **使用你自己的身份与既有远端**：`git remote -v` 确认推送目标是你自己的既有远端（组织仓库或你的 Fork 均可）。**本指南不要求你迁移 Fork 或修改共享 remote。**
2. **每次动手前**：`git fetch <你的远端> --prune`；若要和主仓库对齐，再 `git fetch upstream --prune`（仅在你已配置 `upstream` 时）。
3. **开任务分支**：`git switch -c fix/gy-i08-dose-guard <最新基线>`。
4. **提交并推送**：`git push -u <你的远端> fix/gy-i08-dose-guard`（**不要**推 `main`）。
5. **开 PR**：按 §3 模板；`Refs #N`；等 CI 绿。
6. **审查他人 PR**（有 write 即可）：评论、`REQUEST_CHANGES`、或 **`APPROVE`** —— 用户账号的批准计入"必需批准数"（与 GitHub App 不同，见 §2.6）。**不能批准自己的 PR。**
7. **合并**：由监工（或用户授权的操作）执行；协作者不自行合并。

---

## 2 监工：组织 GitHub App `gengyun-supervisor[bot]`

**身份事实**（以 `AGENTS.md` 台账为准）：App ID `5303709`、slug `gengyun-supervisor`、所属组织 `GengYunChuChao`、安装 ID `171059638`、仅装目标仓库 `GengYun`。

### 2.1 身份核验顺序（**App 级接口用 App JWT；安装令牌用于仓库操作**）
```text
① 用私钥签 RS256 JWT（{iat: now-60, exp: now+540, iss: 5303709}）
② App 级核验（Authorization: Bearer <JWT>）：
     GET /app                → 核 app_id=5303709 / slug=gengyun-supervisor / owner=GengYunChuChao
     GET /app/installations  → 核安装 ID 171059638 / repository_selection / 目标仓库
③ 换【限该仓库的】安装令牌（JWT）：
     POST /app/installations/171059638/access_tokens
④ 仓库级权限自检（用安装令牌）：GET /installation/repositories 或对目标仓库做最小读取
⑤ 通过后才进行仓库操作；认证失败 ⇒ 停止写操作、不回退个人 PAT
```
> 参考：<https://docs.github.com/en/rest/apps/apps#get-the-authenticated-app> —— `GET /app` 等 **App 级**端点需要 **App JWT**；**安装令牌用于仓库操作**（不能用于 `GET /app`）。

### 2.2 安装令牌有效期与保管
有效期约 **1 小时**；**仅在内存/进程环境使用**，不落盘、不打印到日志、不入库。

### 2.3 用令牌推送（令牌不进 argv）
```bash
# 方式 A（推荐）：一次性 credential helper（git 自带 shell；Windows 下同样可用）
git -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_APP_TOKEN"; }; f' \
    push origin feat/gy-i27-privacy-guard

# 方式 B：GIT_ASKPASS 指向只返回 $GH_APP_TOKEN 的脚本（不把令牌写进 URL）
```
> **禁止** `https://x-access-token:<token>@github.com/...`：令牌会进入 argv、历史与日志。

### 2.4 审查与合并（**合并必须携带已验 sha**）
```http
POST /repos/GengYunChuChao/GengYun/pulls/{n}/reviews
{ "event": "COMMENT" | "REQUEST_CHANGES" | "APPROVE", "body": "……" }

PUT  /repos/GengYunChuChao/GengYun/pulls/{n}/merge
{ "sha": "<已核验的 HEAD sha>", "merge_method": "squash", "commit_title": "……" }
```
- **默认 `squash`**；**必须携带已核验的 `sha`** —— 只"先读 HEAD 再合并"无法防止**核验后 HEAD 变化**；携带 sha 时若 HEAD 已变，GitHub 以 **409** 拒绝，需重新核验后再合并。
- **不把 `rebase` / `merge` 当作默认流程的等价替代**；如需变更合并方式，应单独说明并由用户/需求方确认。
- 合并前按审查规范**重新核对 HEAD**（范围、依赖、CI／实测、未解决意见、草稿与冲突）；**不绕过失败、不盲目自动合并**。
- 参考：<https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request>

### 2.5 巡检与失败处理
- **每 4 小时**完整检查全部开放 PR（`GET /repos/{o}/{r}/pulls?state=open`），**仅取消同一 PR 的过时运行**，保留当前提交与历史证据；无变化保持安静。
- **认证失败即停**：不做写操作、**不回退个人 PAT**、不把失败当通过。
- 不自动部署、不付费、不改权限／可见性／套餐。

### 2.6 "App 批准是否计入分支保护"——**【待核】**
- GitHub App 的 `APPROVED` **是否计入某条具体分支保护规则的"必需批准数"**，本指南**不作通用断言**；**以实际规则与开启保护后的实测为准**（需要时先在测试分支验证）。
- 在取得证据前：需要"计数批准"的场合由**用户账号**提供（例如协作者）；App 负责**核验、COMMENT／REQUEST_CHANGES、按 §2.4 合并**。
- **不得**把 App 冒充为第二名真人，**不得**为凑数伪造 `APPROVED`。

---

## 3 PR 统一模板

```markdown
## 范围
<一句话：本 PR 做什么、不做什么>

基线：合成时 `main = <SHA>`（已合并当前主分支，无冲突）
关联：`Refs #N`（**不关闭整项**；`Closes/Fixes/Resolves` 均为 0）

## 证据（原始输出）
- 门禁（按改动影响选择适用项）：lint / test:unit / test:contract / test:docs / git diff --check
- 集成：相关 `tests/integration/*.mjs`（不在 CI glob 的需手工直跑留档）
- 真机/真实能力：<执行者、环境、原始输出；未取证者明确标注>

## 未取得 / 未验证（不得写成通过）
- ……

## 披露
- 跨线改动（他人已合并文件/测试）：diff 全文 + 理由 + 可否一行回退
- 与主分支合成：merge SHA、是否冲突
```

---

## 4 常见错误速查

| 现象 | 原因 | 处置 |
|---|---|---|
| `403 Resource not accessible by personal access token` | PAT 缺对应 scope／非组织管理员 | 调整 PAT 权限或改用 App 安装令牌 |
| `remote: Permission to … denied` | 无 write／用错身份 | 核对 `git remote -v` 与凭据来源 |
| `409 Conflict`（合并接口） | 请求体携带的已验 `sha` 与当前 HEAD 不一致 | 重新核验 HEAD，重新审查后再合并 |
| `rejected … non-fast-forward` | 本地落后远端 | `git fetch` 后合并主分支再推（**不强推**） |
| `Everything up-to-date` | 目标分支已含该提交 | 正常；核对远端 SHA 后继续开 PR |
| CI 显示 `action_required` | fork PR 的批准门 | 主路径用仓内分支即可避免（其他协作者按其既定流程处理） |
| 构建提示找不到 `Dockerfile` | 平台要求 Dockerfile 与"代码目标目录"同级 | 参考 `deploy/cloudrun/README.md`（仓库根已放平台兼容副本） |
