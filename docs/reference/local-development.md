# 本地开发与故障排查

主路径见[开发指南](../development-guide.md)。本页只补充容易误用的环节。

## 微信隔离诊断

仓库根工程共享配置关闭网络、开启合法域名校验。现有工具生成另一个忽略副本，不修改共享 runtime：

```powershell
if (!(Test-Path config/debug.local.json)) { Copy-Item config/debug.local.json.example config/debug.local.json }
node tools/prepare-wechat.mjs local --config config/debug.local.json
node tools/local-debug-server.mjs --config config/debug.local.json
```

在微信工具导入 .local/wechat-local 根目录；按本机地址填写忽略配置。
诊断服务仅返回合成状态，不提供 /api/v1 业务；手机 localhost 是手机自身。
个人“不校验合法域名”例外仅用于此隔离工程，不能当正式 HTTPS／真机资格证据。
输出已存在时工具拒绝覆盖，先保留检查，再核对绝对路径属于自己后清理该生成目录；不要删除他人的工程。
终端 Ctrl+C 停诊断服务。

```powershell
node tools/prepare-wechat.mjs release
```

release 同样拒绝已有输出，并关闭网络；只是安全准备副本，不能直接用于比赛。
工具／手机与历史兼容记录见[原微信调试记录](../archive/development-2026-10-10/docs/local-wechat-debug.md)。

## 常见问题

| 现象 | 先查什么 |
| --- | --- |
| API 启动提示缺配置 | 是否把变量注入进程；单纯复制 .env 不生效；real 要求完整配置 |
| 后台页面打开但鉴权请求失败 | VITE_API_BASE_URL、同源代理、Cookie 与服务端鉴权；页面 HTTP200 不证明 API 联调 |
| 小程序页面能打开但无业务请求 | runtime 是否 disabled；诊断服务不是业务 API；准备工具未包含新的页面依赖 |
| npm 安装超时 | 当前网络／代理；不要改全局 Git/npm 或关闭 TLS |
| 迁移发现旧校验和不同 | 停止改写旧迁移，核对版本；不用删除台账掩盖 drift |
| 数据库 CLI 拒绝连接 | 两种来源／暂存 CLI 有独立本机库、角色和 URL 约束；不改用管理员绕过 |
| 模拟／种子能展示但无法产用量卡 | 合格来源、制剂、条件、原文缺项；不是靠强行开启按钮修复 |

如果已有本机代理地址为 127.0.0.1:7897，可只对本次安装配置，保持 TLS：

```powershell
npm ci --proxy=http://127.0.0.1:7897 --https-proxy=http://127.0.0.1:7897
```

其余具体故障按对应固定 SHA 验证页排查；不把历史测试数量／截图当当前证据。
