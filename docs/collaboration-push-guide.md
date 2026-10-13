# 协作推送指南（协作者 / 监工 / 指挥）

更新：2026-10-14 ｜ 仓库：`GengYunChuChao/GengYun`（public，组织所有）
关联：`AGENTS.md`（角色与边界）、`docs/pr-review-policy.md`（审查门槛）

---

## 0 所有角色通用

### 0.1 铁律
- **不直推 `main`**（仅用户明确授权的特定操作例外）；**不强推**（禁用 `--force` / `--force-with-lease`）；**不改写已推送历史**。
- **不用 fork 作主路径**：新工作一律在**组织仓库内开分支**（fork 仅作历史保留）。
- **凭据只从文件或环境读取**：不得进入对话、仓库、PR、日志或命令行参数（argv）。
- **作者不能批准自己的 PR**；不得伪造 `APPROVED`。
- 送审前**先与当前 `upstream/main` 合成**并复跑门禁；**没有运行过的检查不得写"通过"**。
- 一个分支一个任务；PR 用 `Refs #N`，**不关闭整项**（除非该 PR 确实完成并验收整项）。

### 0.2 标准流程
```bash
git fetch upstream --prune
git switch -c feat|fix|chore/<topic> upstream/main
# …实现 + 自检（门禁 / 真机证据）…
git add -A && git commit -m "feat(GY-IXX): ……（Refs #N）"
git push -u origin feat|fix|chore/<topic>     # 组织仓库内分支
# 开 PR（见 §3 模板）⇒ CI 自动运行 ⇒ 独立审查 ⇒ 合并 main
```

---

## 1 协作者（真实身份，例如 `cxhhandsome`）

1. **一次性准备**：`git clone https://github.com/GengYunChuChao/GengYun.git`（或对既有工作区 `git remote -v` 确认 `origin` 指向组织仓库；若仍是旧 fork，`git remote set-url origin https://github.com/GengYunChuChao/GengYun.git`）。
2. **每次动手前**：`git fetch origin --prune`（以及 `git fetch upstream --prune`，若配置了 `upstream`）。
3. **开任务分支**：`git switch -c feat/gy-iXX-topic upstream/main`（或 `origin/main`）。
4. **提交并推送**：`git push -u origin feat/gy-iXX-topic`（有 write 权限即可；**不要**推 `main`）。
5. **开 PR**：按 §3 模板；`Refs #N`；等 CI 绿。
6. **审查他人 PR**（有 write 即可）：评论、`REQUEST_CHANGES`、或 **`APPROVE`** —— 协作者的批准**计入**分支保护的必需批准数（与 GitHub App 不同，见 §2.6）。**不能批准自己的 PR**。
7. **合并**：由监工（或用户授权的操作）执行；协作者不自行合并。

---

## 2 监工：组织 GitHub App `gengyun-supervisor[bot]`

**身份事实**（以 `AGENTS.md` 台账为准）：App ID `5303709`、slug `gengyun-supervisor`、所属组织 `GengYunChuChao`、安装 ID `171059638`、仅装目标仓库 `GengYun`。

### 2.1 每轮先核验身份
```bash
# 用安装令牌 GET /app 或 GET /repos/{owner}/{repo}/installation，核对：
#   app_id=5303709 / slug=gengyun-supervisor / account=GengYunChuChao / 仓库为目标仓库
```

### 2.2 获取安装令牌（有效期 1 小时）
1. 用私钥（**不入库**，路径由环境变量给出）签 **RS256 JWT**：`{iat: now-60, exp: now+540, iss: <App ID>}`。
2. 换令牌：
```http
POST https://api.github.com/app/installations/171059638/access_tokens
Authorization: Bearer <JWT>
Accept: application/vnd.github+json
```
3. 得到 `token`（≈1 小时）与 `expires_at` ⇒ **仅在内存/进程环境使用，不落盘、不打印到日志**。

### 2.3 用令牌推送（令牌不进 argv）
```bash
# 方式 A（推荐）：一次性 credential helper（git 自带 shell，Windows 下同样可用）
git -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_APP_TOKEN"; }; f' \
    push origin feat|fix|chore/<topic>

# 方式 B：GIT_ASKPASS 指向只返回 $GH_APP_TOKEN 的脚本（不把令牌写进 URL）
```
> 禁止形如 `https://x-access-token:<token>@github.com/...` 的写法：令牌会进入 argv/历史/日志。

### 2.4 用令牌审查与合并（API）
```http
POST /repos/GengYunChuChao/GengYun/pulls/{n}/reviews
{ "event": "COMMENT" | "REQUEST_CHANGES" | "APPROVE", "body": "……" }

PUT  /repos/GengYunChuChao/GengYun/pulls/{n}/merge
{ "merge_method": "squash" | "merge" | "rebase", "commit_title": "……" }
```
- 合并前按审查规范**重新核对 HEAD**（绑定已验 SHA：范围、依赖、CI／实测、未解决意见、草稿与冲突）。
- 新提交使旧审核失效；不绕过失败、不盲目自动合并。

### 2.5 巡检与失败处理
- **每 4 小时**完整检查全部开放 PR（`GET /repos/{o}/{r}/pulls?state=open`），只取消**同一 PR** 的过时运行，保留当前提交与历史证据；无变化保持安静。
- **认证失败即停**：不做写操作，**不回退个人 PAT**，不把失败当通过。
- 不自动部署、不付费、不改权限／可见性／套餐。

### 2.6 与分支保护的关系（重要）
- 据 GitHub 规则，**GitHub App 的 `APPROVE` 不计入**"必需批准数"⇒ 若开启了「要求 1 个 approve」的保护，App 的批准**不能**顶替用户账号的批准。
- 因此：需要计数批准的场合由**用户账号**（如协作者）出批准；App 负责**核验、COMMENT／REQUEST_CHANGES、合并**；**不得**为凑数伪造 `APPROVED`。

---

## 3 PR 统一模板

```markdown
## 范围
<一句话：本 PR 做什么、不做么>

基线：合成时 `upstream/main = <SHA>`（已 `git merge upstream/main`，无冲突）
关联：`Refs #N`（**不关闭整项**；`Closes/Fixes/Resolves` 均为 0）

## 证据（原始输出）
- 门禁：lint / test:unit / test:contract / test:docs / git diff --check
- 集成：相关 `tests/integration/*.mjs`（不在 CI glob 的需手工直跑留档）
- 真机/真实能力：<执行者、环境、原始输出；未取证者明确标注>

## 未取得 / 未验证（不得写成通过）
- ……

## 披露
- 跨线改动（他人已合并文件/测试）：diff 全文 + 理由 + 可否一行回退
- 与上游合成：merge SHA、是否冲突
```

---

## 4 常见错误速查

| 现象 | 原因 | 处置 |
|---|---|---|
| `403 Resource not accessible by personal access token` | PAT 缺对应 scope／非组织管理员 | 调整 PAT 权限或改用 App 令牌 |
| `remote: Permission to … denied` | 无 write／用错身份 | 核对 `git remote -v` 与凭据来源 |
| `rejected … non-fast-forward` | 本地落后远端 | `git fetch origin --prune` 后 `git merge upstream/main` 再推（**不强推**） |
| `Everything up-to-date` | 目标分支已含该提交 | 正常；核对远端 SHA 后继续开 PR |
| CI 显示 `action_required` | fork PR 的批准门 | **改用仓内分支**（本指南主路径）即可避免 |
| 构建提示找不到 `Dockerfile` | 平台要求 Dockerfile 与"代码目标目录"同级 | 参考 `deploy/cloudrun/README.md`（仓库根已放平台兼容副本） |
