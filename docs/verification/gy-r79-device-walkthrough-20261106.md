# R79 真机走查证据（2026-11-06）

本页记录 **2026-11-06 13:21（+08:00）** 一次**真实手机**上的端到端走查：手机 → 私网 HTTP → real 模式 API → 对象存储 → 视觉模型 → 结果页 → 手选候选。**Refs #1003、Refs #1004、Refs #1006**。

本页只记录这一次会话的实际读数，不构成准确率、容量或正式发布验收。

## 1 结论

在**没有**已备案域名、**没有** HTTPS、**没有**体验版的前提下，**真机调试通道**可以让真实设备跑通「登录 → 首页 → 上传 → 识别 → 手选候选」全链路。

- 小程序 → API 的一跳走 **`http://192.168.35.69:38096/api/v1`**，全程 **Private LAN 明文**，未被域名校验拦截。
- 服务端出网的两跳（微信 `jscode2session`、视觉模型 API）不受小程序域名白名单约束，二者在本次会话中各自正常。
- 识别链路 `POST /media/uploads` → `POST /media/uploads/{id}/complete` → `POST /recognitions` → `GET /jobs/{id}` → `PATCH /recognitions/{id}/selection` 全部由**手机发起**且成功。

## 2 环境（本次实际配置）

| 项 | 值 |
| --- | --- |
| 手机 IP | `192.168.35.117` |
| 电脑 IP / 网络 | `192.168.35.69`，手机热点，网络类别 `Public` |
| API 监听 | `0.0.0.0:38096` |
| 识别协议适配（本地） | `127.0.0.1:38091`，把冻结协议 `gy-recognition-live-v1` 翻译成供应商 OpenAI 兼容接口 |
| 数据库 | 本机 PostgreSQL 17.11，`127.0.0.1:55433`，库 `gengyun_r79_real` |
| 执行模式 | `APP_EXECUTION_MODE=real`（媒体域带 `--approve-real-media-wiring`） |
| 微信开发者工具 | Stable 2.02.2608080，AppID `wx4407a4b908a69a54` |
| 小程序工程副本 | 仓库外副本，`urlCheck: false`，`runtime.mode = "local"` |
| 入站放行 | 防火墙规则 `GengYun R79 API 38096 (Any)`，`Enabled=True`、`Action=Allow`、`Profile=Any` |

第一次扫码时手机报「网络请求失败」：当时电脑刚从另一个网络切回热点，小程序副本里保存的仍是上一个网络的地址。把副本配置改写成当前私网地址并重新编译后即正常。**换网络必须重新写一次地址并重新编译**，这不是代码缺陷。

## 3 手机实际发出的请求（服务端访问日志，按端点归并）

日志按 `remoteAddress = 192.168.35.117` 过滤，同一会话内共 45 条请求记录：

| 端点 | 次数 |
| --- | --- |
| `GET /api/v1/auth/session` | 9 |
| `GET /api/v1/jobs/{id}` | 11 |
| `GET /api/v1/public/home` | 5 |
| `POST /api/v1/media/uploads` | 4 |
| `POST /api/v1/media/uploads/{id}/complete` | 4 |
| `POST /api/v1/recognitions` | 2 |
| `GET /api/v1/recognitions/{id}` | 2 |
| `GET /api/v1/messages/unread-count` | 2 |
| `GET /api/v1/favorites` | 1 |
| `GET /api/v1/history` | 1 |
| `PATCH /api/v1/recognitions/{id}/selection` | 1 |

`auth/session` 出现 9 次是页面门禁：每次进入需要登录态的页面都会先核一次会话。

## 4 识别结果（数据库读数）

| 时间（+08:00） | 任务 | 终态 | 候选 / 说明 |
| --- | --- | --- | --- |
| 13:21:02 | `524f27d8-566b-4ad1-a8f6-d00f8beb59b5` | `succeeded` | `species_lambsquarters`，`model_score` 0.85 |
| 13:21:46 | `f6d57f38-e526-4255-8f58-5f70c52274fe` | `uncertain` | 候选为空，`uncertainty_reasons = ["模型未返回任何候选"]` |

对应结果行：

- `2d66d8d8-0835-47b4-a6e7-c748a74cf30f`：`media_revision = 2`、`model_version = gy-recognition-live-v1`、`candidates = [{"rank": 1, "species_id": "species_lambsquarters", "model_score": 0.85}]`、**`selected_species_id = species_lambsquarters`**（说明候选是**用户手点**选中的，不是自动选中）。
- `0b1e5db5-a342-4179-963e-917d8eb3975a`：候选为空，`uncertainty_reasons = ["模型未返回任何候选"]`。

同一次会话里还有一次 `PATCH /recognitions/{id}/selection`，与上面 `selected_species_id` 的写入一致。

## 5 能证明什么 / 不能证明什么

**能证明**

1. 真实设备在**私网明文 HTTP** 下可以完成页面门禁、登录态、只读动线与识别写链路。
2. 上传 → 对象存储 → 去元数据 → 识别 → 轮询 → 手选候选，这条链在**真机**上端到端成立。
3. 候选**不会自动选中**：结果页的关联信息要用户点候选卡片才展开，服务端记录也随之写入 `selected_species_id`。
4. 服务端出网（微信 code 交换、视觉模型调用）与「小程序域名白名单」是两件事，前者不受后者约束。

**不能证明**

1. **不构成准确率证据**：本次只有 2 张图，其中 1 张返回空候选。基线「没有已审识别供应商、零准确率证据」的判断不因本页改变。
2. 不证明体验版/正式发布可用：那两条通道要求**已备案域名 + HTTPS**，本页走的是真机调试。
3. 不证明发布类链路：发帖、评论、语音上传在 real 模式下按设计 fail-closed，未在本次会话中成为可用功能。
4. 不证明关联资料覆盖：本机离线参考库对「藜」没有命中条目，历史实测中只有「稗草」能带出 1 条登记制剂。

## 6 与既有缺口的关系

- 识别要接真实视觉模型，需要一层把冻结协议翻译成供应商接口的服务端接收面；本轮演示用的这层是**仓库外的本地适配器**，仓库内仍缺，见 issue `#1003`。
- 授权面要求显式选择已核验接收方：客户端已改为让用户选（已合入），服务端在有接收方绑定时也要求非空（已合入），见 issue `#1004` 与 `#1006`。
- 演示环境由运营方预置了已核验接收方绑定；产品形态应是用户自己在已核验受托方之间选择。演示口径里必须如实说明这一点。

## 7 复现步骤

1. 本机起 PostgreSQL 17.11 与演示库，起 real 模式 API（监听 `0.0.0.0`），起识别协议适配器。
2. 把小程序工程副本的 `runtime.mode` 设为 `local`、地址设为**当前**电脑私网地址 + `/api/v1`，关闭域名校验。
3. 放行入站端口（本次为 TCP 38096，规则覆盖全部网络类别）。
4. 开发者工具打开工程副本 → 编译 → 真机调试 → 手机扫码。
5. 手机登录 → 首页 → 同意两个用途（并选择接收方）→ 相册选图 → 等识别 → **手点候选卡片** 看关联信息。
6. 复核：服务端访问日志应有 `remoteAddress` 为手机私网地址的记录；`jobs` 应有 `kind='recognition'` 的成功行；`recognition_records` 应有候选与 `selected_species_id`。
