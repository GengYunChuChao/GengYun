# GY-R99 / #1145 模拟器自动化走查证据（2026-11-09）

本页只登记一次「机器可复核的走查读数」：微信开发者工具模拟器 + stub 演示栈 + LOCAL 副本 + `miniprogram-automator`。本页不替代真机验收，也不把页面可进入当成业务正确。

## 1. 环境与方法

| 项 | 实测值 |
|---|---|
| 开发者工具 | `2.02.2609231` |
| 自动化 | `miniprogram-automator` 0.13.0 |
| 自动化端点 | `ws://127.0.0.1:9420` |
| 启动方式 | `cli auto --project "<LOCAL import root>" --auto-port 9420` |
| LOCAL 产物 | `.local/wechat-local`（已被 `.gitignore` 忽略；共享工程零改动） |
| 服务端 | API `http://127.0.0.1:3000`（stub）；PG `127.0.0.1:55510` |
| 健康检查 | `GET /health` 返回 200，`meta.execution_mode=stub` |

本轮没有新增任何「合成登录通道」；stub 模式自带合成身份。此前走不通的两处已定位为「API 没起」和「工程根没指向 LOCAL 副本」，不是缺登录通道。

LOCAL 副本生成命令：

```powershell
node tools/prepare-wechat.mjs local --config config/debug.local.json --no-urlcheck --force
```

生成后的 `apiBaseUrl` 为 `http://127.0.0.1:3000/api/v1`。服务端启动命令：

```powershell
node tools/demo-stack.mjs up --mode stub --demo --pg-bin D:\Apps\PostgreSQL-17.11\pgsql\bin
```

自动化必须用 `cli auto` 起实例。用 `cli open` 起的实例能连上，但所有命令超时，实测报 `timeout waiting for automator response`；因此本页读数只对应 `cli auto --auto-port 9420` 这一条路径。

登录流程：在模拟器登录页点主按钮（`miniprogram/pages/login/login.wxml:5`），客户端调用 `POST /api/v1/auth/wechat`。stub 模式下服务端走 `services/api/src/auth/wechat.ts:69` 的 `executionMode !== 'real'` 分支；`exchange()`（`services/api/src/auth/wechat.ts:72`）不访问微信，直接派生 `stub:<code>` 主体。对同一端点做 HTTP 直测也返回 200，响应含 `data.access_token` 与 `meta.execution_mode=stub`。登录成功后应用自动落到 `pages/consent/consent`（授权门，符合设计）。

## 2. 逐页读数（登录态）

登录态下逐页 `reLaunch`，以 `currentPage` 与目标页一致作为「进入」判据；`data()` 键数量已排除 `__webviewId__`。

| 页面 | 是否进入 | `data()` 键数量 | 截图是否取得 |
|---|---:|---:|---:|
| `pages/home/home` | 是 | 13 | 是 |
| `pages/community/community` | 是 | 19 | 是 |
| `pages/identify/identify` | 是 | 34 | 是 |
| `pages/messages/messages` | 是 | 22 | 是 |
| `pages/profile/profile` | 是 | 27 | 是 |
| `pages/history/history` | 是 | 12 | 是 |
| `pages/qa/qa` | 是 | 30 | 是 |
| `pages/knowledge/knowledge` | 是 | 23 | 是 |
| `pages/favorites/favorites` | 是 | 17 | 是 |
| `pages/consent/consent` | 是 | 24 | 是 |
| `pages/deletion/deletion` | 是 | 18 | 是 |

11 页全部进入成功；11 张截图全部取得。上表数字是本次脚本输出，不是页面声明值。

## 3. 未登录对照读数

未登录状态下同样逐页 `reLaunch`，用于说明「为什么必须登录」。

| 页面 | 是否进入 | `data()` 键数量 | 说明 |
|---|---:|---:|---|
| `pages/home/home` | 是 | 3 | 游客首页可进 |
| `pages/deletion/deletion` | 是 | 18 | 注销说明页可进 |
| `pages/login/login` | 是 | 7 | 登录页本身 |
| `pages/community/community` | 否 | — | reLaunch 超时 |
| `pages/identify/identify` | 否 | — | reLaunch 超时 |
| `pages/messages/messages` | 否 | — | reLaunch 超时 |
| `pages/profile/profile` | 否 | — | reLaunch 超时 |
| `pages/history/history` | 否 | — | reLaunch 超时 |
| `pages/qa/qa` | 否 | — | reLaunch 超时 |
| `pages/knowledge/knowledge` | 否 | — | reLaunch 未超时，但 `currentPage` 落在 `pages/login/login` |
| `pages/favorites/favorites` | 否 | — | reLaunch 超时 |
| `pages/consent/consent` | 否 | — | reLaunch 超时 |

其余 9 页均未进入。community、identify、messages、profile、history、qa、favorites、consent 这 8 页在 reLaunch 处超时；knowledge 的 reLaunch 未超时，但 `currentPage` 落在 `pages/login/login`，自动化等目标页仍以超时结束。结论：未登录时这些页面被应用重定向到登录页，自动化等不到目标页就超时。

## 4. 目视核对（截图）

- home：标题、主操作、tabBar 均完整渲染。
- community：页面完整渲染，并显示合成标注「替身服务数据，仅供联调，不代表真实社区内容或审核结论」。
- consent：模拟器里内容挤在左半幅，右侧留白；同时显示提示「用途政策尚未读取成功…」。这是 stub 栈下政策读面未绑定接收方的既有契约行为。窄栏是否在真机同样出现：**未核实**。

## 5. 能证明 / 不能证明

**能证明**

1. 在 stub 演示栈 + LOCAL 副本 + 自动化端口下，11 个页面都能被脚本进入，并读到真实 `data()`；11 张截图可取得。
2. 未登录时 9 个页面被重定向到登录页；这是可重复的对照读数。

**不能证明**

1. 不证明真机可用：模拟器与真机的渲染、权限流程不同。
2. 不证明真实 AppID 或真实微信登录：全程是 stub 合成身份，没有接触真实 `code`。
3. 不证明九条主流动线的业务正确性：这里只证明页面可进入、可读数据、可截图。
4. 不证明真实识别、真实对象存储、真实第三方外发。
5. 截图未入库，只在本机 `D:\gy-wt\wxauto\shots\`；本页不引用任何图片文件路径，也不嵌入图片。

## 6. 复现步骤

1. 生成 LOCAL 副本：

```powershell
node tools/prepare-wechat.mjs local --config config/debug.local.json --no-urlcheck --force
```

产物是 `.local/wechat-local`，`apiBaseUrl` 为 `http://127.0.0.1:3000/api/v1`。

2. 启动 stub 演示栈：

```powershell
node tools/demo-stack.mjs up --mode stub --demo --pg-bin D:\Apps\PostgreSQL-17.11\pgsql\bin
```

确认 `GET /health` 返回 200 且 `meta.execution_mode=stub`；PG 在 `127.0.0.1:55510`。也可运行 `curl.exe -sS http://127.0.0.1:3000/health` 查看。

3. 用 `cli auto` 起自动化实例：

```powershell
cli auto --project "<LOCAL import root>" --auto-port 9420
```

把 `<LOCAL import root>` 换成 `.local/wechat-local` 的绝对路径。不要用 `cli open`。

4. 等 `pageStack` 有值后再执行登录与逐页 `reLaunch`。`cli auto` 之后 `pageStack` 需要等 100–120 秒才有值；过早读取会得到空值。登录后先等应用落到 `pages/consent/consent`，再开始逐页 `reLaunch`。

5. 机器进入 Windows 锁屏后，模拟器停止渲染，自动化会全部超时；先解锁再重跑。

## 7. 边界与后续

- 本页只登记「机器可复核的走查读数」，不重复 `docs/demo/演示脚本.md` 的人肉九段脚本。
- 若要真机对照，需要真实微信登录（真机 `code`），属外部依赖。
- 本页不关闭 #1145，也不把模拟器读数升级为真机或业务验收。
