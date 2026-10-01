# 贡献指南

欢迎参与「农识宝」小程序的开发。完整规范见 [`docs/协作规范.md`](docs/协作规范.md)，这里只列最常用的要点。

> 项目当前处于**前期准备阶段**，功能尚未开发。开始写代码前请先确认 [`docs/需求规划.md`](docs/需求规划.md) 中的待确认项是否已定稿，避免返工。

## 提交前自查

- [ ] 微信开发者工具中编译通过，无报错与警告
- [ ] 未把 `project.private.config.json`、密钥、日志加入暂存区
- [ ] 提交信息符合 `<type>(<scope>): <subject>` 格式
- [ ] 新增页面已在 `miniprogram/app.json` 的 `pages` 中注册
- [ ] 涉及拍照 / 相册等权限时，确认是否需要同步更新隐私保护指引
- [ ] 知识类文案（病害建议、农药用量）需标注来源，不可硬编码未经确认的内容

## 目录归属

| 要新增的内容 | 放置位置 |
| --- | --- |
| 页面 | `miniprogram/pages/<name>/`（同时在 `app.json` 注册） |
| 可复用组件 | `miniprogram/components/<name>/` |
| 后端接口调用 | `miniprogram/api/` |
| 通用工具 | `miniprogram/utils/` |
| 环境开关与常量 | `miniprogram/config/index.js` |
| 图片等静态资源 | `miniprogram/images/` |
| 文档 | `docs/` |

> `components` / `api` / `utils` / `config` / `images` 为规划目录，随功能开发逐步建立。

## 提交信息示例

```
feat(index): 首页双入口改版
fix(capture): 修复相册选图后预览失败
docs(readme): 补充 AppID 配置说明
chore(deps): 调整忽略规则
```

## 分支与 PR

- 不要直接向 `main` 提交，请从 `main` 开出 `feature/*` 或 `fix/*` 分支
- PR 描述请写明：改了什么、为什么改、如何验证
- 至少 1 人评审通过后合并，推荐 Squash merge

## 有问题怎么办

先查 [`docs/需求规划.md`](docs/需求规划.md) 的「待确认清单」是否为已知开放项；仍不明确的，在 PR 或群里提出，避免各自实现导致返工。
