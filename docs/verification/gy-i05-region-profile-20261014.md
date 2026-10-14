# GY-I05 单作物地区档案及授权定位／手动选择 — 收口证据（20261014）

- 任务：**GY-I05**（issue **#5**，`Refs #5`，**不关闭整项**）。本文只覆盖本轮续跑新增的收口项，历史证据见
  [gy-i05-api-20261011](gy-i05-api-20261011.md)、[gy-i05-catalog-cursor-20261013](gy-i05-catalog-cursor-20261013.md)、
  [gy-i05-profile-closeout-20261011](gy-i05-profile-closeout-20261011.md)、[gy-i05-native-profile-20261011](gy-i05-native-profile-20261011.md)。
- 工作区：`GengYun_W26`，分支 `feat/gy-i05-region-profile`；**未 push**（提交由指挥推送）。
- 基线：`upstream/main = 72c4923`（`72c4923a8ec058399a51609e1cf1e3c70a890b4a`）。
- 本轮代码 HEAD：`567bbda`（`567bbdaca8e698462d17101fcecff2ca57fd44f2`）；证据页自身提交紧随其后。

## 0 结论摘要

| 项 | 结果 |
| --- | --- |
| 服务端请求日志／404 封套剥离查询串，坐标不进日志 | **已取得**（跨线修复 `app.ts`，见 §3；改前 11 处命中 → 改后 0 处） |
| 协议相对 URL（`//host/path?lat=…`）也 fail-closed | **已取得**（本轮补丁 `2e0649a`；HEAD 上前一提交的用例 1 fail → 修后 4/4 pass） |
| 全出口哨兵负例（incoming request／子日志中继／错误日志／unhandled／404／400 details／请求体） | **已取得**（单测改后全 0 且正向对照成立） |
| 手选档案读写、越权（游客／他人／自报身份）、快照不变、错误码一致性 | **已取得**（既有 `tests/unit/profile-api.test.mjs` 全绿；见 §2） |
| 工具链（微信开发者工具）真实模拟器上的定位 9 个分支 | **已取得**（真实页面代码 + 真实 loopback HTTP；§4） |
| 工具原生授权弹窗的"允许/拒绝"点击、真机权限流程与截图 | **未取得**：自动化点不到工具原生弹窗；真机调试需手机扫码（§5） |
| 正式微信身份 | **部分取得**：IDE `islogin=true`、模拟器真实 `wx.login` 返回 32 位 code；**真机**身份/权限未取得 |
| 坐标→地区转换资源 | **未取得**（首版本就不内置；页面如实回退手选，见 §4.3） |

## 1 改动清单与装配

```
git diff --stat upstream/main...HEAD
 services/api/src/app.ts                          |  72 +++++++-
 tests/integration/local-dev-profile-location.cjs | 206 +++++++++++++++++++++++
 tests/unit/miniprogram-profile.test.mjs          |  44 +++++
 tests/unit/profile-api.test.mjs                  |  64 +++++++
 tests/unit/profile-log-redaction.test.mjs        | 150 +++++++++++++++++
 tools/verify-gy-i05-log-redaction.mjs            | 138 +++++++++++++++
 6 files changed, 671 insertions(+), 3 deletions(-)
```

| 提交 | 内容 |
| --- | --- |
| `3f379fd` | `app.ts`：请求日志序列化器只留 method + 无查询串路径；404 封套同样剥离；`logStream` 仅测试注入 |
| `9ca4c2f` | 日志无坐标负例、错误码与前后端交互一致性用例 |
| `2e0649a` | `app.ts`：日志安全路径对**协议相对 URL** 也 fail-closed（本轮补） |
| `de469bb` | `tools/verify-gy-i05-log-redaction.mjs`：可在**改前** app.ts 上复现命中的探针（本轮补） |
| `567bbda` | `tests/integration/local-dev-profile-location.cjs`：工具链定位分支（本轮补） |

**装配说明（跨线）：** `services/api/src/app.ts` 属共享出口（所有路由的请求日志都经它），改动仅三处：
`logger.serializers.req = requestLogFields`（只输出 method + 无查询串站内路径 + host/远端地址）、
`logStream` 可选注入（生产 `server.ts` 不传，日志仍逐字节写 stdout）、404 封套 `message` 剥离查询串。
未新增 `declare module`，未触碰 `packages/**`，未改级别/格式/生产日志目标。`app.ts` 修复**独立成 commit**便于回退。

## 2 门禁与测试（本轮实跑，原始输出）

| 门禁 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 静态检查 | `npm run lint` | 0 | `PASS tsc --noEmit services/api/tsconfig.json` / `apps/admin` / 仓库卫生扫描 |
| 全量单测 | `npm run test:unit` | 0 | `tests 1774 / pass 1773 / fail 0 / skipped 1` |
| 本片单测 | `node --test tests/unit/profile-log-redaction.test.mjs tests/unit/profile-api.test.mjs tests/unit/miniprogram-profile.test.mjs tests/unit/profile-pagination.test.mjs` | 0 | `tests 50 / pass 50 / fail 0` |
| 契约 | `npm run test:contract` | 0 | `tests 6 / pass 6 / fail 0` |
| 原生工程静态 | `npm run test:mini` | 0 | `tests 4 / pass 4 / fail 0`；`PASS: native JSON/routes, five empty tabs, …Not a WeChat compiler or device test` |
| 空白检查 | `git diff --check` | 0 | 无输出 |

**HEAD 红 → 绿（协议相对 URL）**：`2e0649a` 之前，`profile-log-redaction.test.mjs` 在 HEAD 上 1 fail：

```
✖ GY-I05 日志序列化器：解析不出的 URL 一律 fail-closed，只落 method (1.0579ms)
  AssertionError [ERR_ASSERTION]: 不该落 URL 原文：//localhost/api/v1/x?latitude=123.4567
  true !== false
ℹ tests 4 / ℹ pass 3 / ℹ fail 1
```

改后（同一用例）：`ℹ tests 4 / ℹ pass 4 / ℹ fail 0`。

**错误码一致性（前后端同源闭集）**：`tests/unit/profile-api.test.mjs` 与 `miniprogram-profile.test.mjs` 都以
`packages/contracts/states.json` 的 `error_status_map` 与 `openapi.json` 的 `ErrorCode` 枚举为断言对象
（不手写清单）；服务端侧覆盖 `SESSION_REQUIRED / REVISION_REQUIRED / IDEMPOTENCY_KEY_REQUIRED /
REVISION_CONFLICT / IDEMPOTENCY_CONFLICT / INVALID_REQUEST / INVALID_CURSOR / PROVIDER_UNAVAILABLE`，
前端侧遍历整个闭集且每个码都必须落到可见失败分支或登录门，绝不当成保存成功。上表全绿即该项通过。

## 3 日志红线探针：改前 / 改后原始输出（哨兵坐标）

探针 `[tools/verify-gy-i05-log-redaction.mjs](../../tools/verify-gy-i05-log-redaction.mjs)` 只依赖 `buildApp`
（改前/改后都存在），因此能在 `upstream/main` 的 `app.ts` 上跑出真实命中，证明"改后全 0"不是假通过。
哨兵为合成值 `latitude=123.4567 / longitude=89.0123`，非任何真实位置。判定输出走 stderr，stdout 是真实日志流。

运行方式（改后 = 当前工作树；改前 = `git checkout upstream/main -- services/api/src/app.ts` 后同一条命令，跑完还原）：

```
node tools/verify-gy-i05-log-redaction.mjs > before.stdout.log 2> before.stderr.log
```

### 3.1 改前（`upstream/main = 72c4923` 的 `app.ts`）原始 stderr —— 11 处命中

```
=== GY-I05 坐标红线探针 ===
哨兵：latitude=123.4567 longitude=89.0123（合成值，非真实位置）
探针 tee 到的 stdout 日志块：29（为 0 时请用 shell 重定向抓 stdout）

--- 日志出口（按 msg 分组：命中行数 / 该 msg 总行数）---
  msg="incoming request"  5/7
    !! 命中：{"level":30,...,"req":{"method":"GET","url":"/api/v1/catalog/regions?latitude=123.4567&longitude=89.0123","host":"localhost:80","remoteAddress":"127.0.0.1"},"msg":"incoming request"}
    !! 命中：{"level":30,...,"req":{"method":"GET","url":"/api/v1/me/profile?lat=123.4567&lng=89.0123",...},"msg":"incoming request"}
    !! 命中：{"level":30,...,"req":{"method":"GET","url":"/api/v1/unknown/endpoint?latitude=123.4567&longitude=89.0123",...},"msg":"incoming request"}
    !! 命中：{"level":30,...,"req":{"method":"GET","url":"/api/v1/catalog/crops?limit=abc&latitude=123.4567",...},"msg":"incoming request"}
    !! 命中：{"level":30,...,"req":{"method":"GET","url":"/api/v1/catalog/crops?latitude=123.4567&longitude=89.0123",...},"msg":"incoming request"}
  msg="probe child logger relay"  5/7
    !! 命中：{...,"req":{"url":"/api/v1/catalog/regions?latitude=123.4567&longitude=89.0123",...},"msg":"probe child logger relay"}
    !! 命中：{...,"req":{"url":"/api/v1/me/profile?lat=123.4567&lng=89.0123",...},"msg":"probe child logger relay"}
    !! 命中：{...,"req":{"url":"/api/v1/unknown/endpoint?latitude=123.4567&longitude=89.0123",...},"msg":"probe child logger relay"}
    !! 命中：{...,"req":{"url":"/api/v1/catalog/crops?limit=abc&latitude=123.4567",...},"msg":"probe child logger relay"}
    !! 命中：{...,"req":{"url":"/api/v1/catalog/crops?latitude=123.4567&longitude=89.0123",...},"msg":"probe child logger relay"}
  msg="probe error logger relay"  0/7
  msg="request completed"  0/7
  msg="unhandled error"  0/1
  日志整体命中：7 类哨兵 / 命中行 10

--- 正向对照（日志确实在工作；改后还要求路径以"无查询串"形态落下）---
  incoming request 行：7；子日志中继：7；错误日志中继：7；unhandled error：1
  日志管线在工作（判定可信）：OK
  路径以无查询串形态落日志（仅改后应为 true）：false

--- 响应封套出口 ---
  catalog-regions-query      status=400 命中=0
  profile-query              status=400 命中=0
  unknown-path-404           status=404 命中=123.4567,89.0123,latitude=,longitude=
  catalog-schema-invalid     status=400 命中=0
  unhandled-error            status=500 命中=0
  profile-body-coordinates   status=400 命中=0
  profile-body-extra-field   status=400 命中=0
  404 封套 message："未实现的路径：GET /api/v1/unknown/endpoint?latitude=123.4567&longitude=89.0123"

--- 请求体出口（哨兵文本是否被回显）---
  被回显的请求体内容：1 处

RESULT: FAIL —— 坐标/查询串原文命中 11 处（日志 10 + 封套 1），日志管线 在工作
```

> 上表的 `...` 是本文为可读性省略的重复字段（`level`/`time`/`pid`/`hostname`/`reqId`），被省略内容不含判据；
> 其余逐字为原始输出。改前的真实落点共三处：Fastify 默认 `serializers.req`（含子日志中继沿用同一序列化器）
> 与 404 封套 `error.message` 回显完整 `request.url`。

### 3.2 改后（HEAD `567bbda`）原始 stderr —— 0 处命中

```
=== GY-I05 坐标红线探针 ===
哨兵：latitude=123.4567 longitude=89.0123（合成值，非真实位置）
探针 tee 到的 stdout 日志块：29（为 0 时请用 shell 重定向抓 stdout）

--- 日志出口（按 msg 分组：命中行数 / 该 msg 总行数）---
  msg="incoming request"  0/7
  msg="probe child logger relay"  0/7
  msg="probe error logger relay"  0/7
  msg="request completed"  0/7
  msg="unhandled error"  0/1
  日志整体命中：0 类哨兵 / 命中行 0

--- 正向对照（日志确实在工作；改后还要求路径以"无查询串"形态落下）---
  incoming request 行：7；子日志中继：7；错误日志中继：7；unhandled error：1
  日志管线在工作（判定可信）：OK
  路径以无查询串形态落日志（仅改后应为 true）：true

--- 响应封套出口 ---
  catalog-regions-query      status=400 命中=0
  profile-query              status=400 命中=0
  unknown-path-404           status=404 命中=0
  catalog-schema-invalid     status=400 命中=0
  unhandled-error            status=500 命中=0
  profile-body-coordinates   status=400 命中=0
  profile-body-extra-field   status=400 命中=0
  404 封套 message："未实现的路径：GET /api/v1/unknown/endpoint"

--- 请求体出口（哨兵文本是否被回显）---
  被回显的请求体内容：0 处

RESULT: PASS —— 坐标/查询串原文命中 0 处（日志 0 + 封套 0），日志管线 在工作
```

改后日志仍是**真的在工作**（正向对照成立）：`incoming request` 7 行、子日志中继 7 行、错误日志中继 7 行、
`unhandled error` 1 行，且路径以 `"/api/v1/catalog/regions"`、`"/api/v1/unknown/endpoint"` 的无查询串形态落下。
stdout 全文中 `123.4567|89.0123|latitude=|longitude=|lat=|lng=|limit=` 的匹配数为 **0**。
单元侧同一判据见 `tests/unit/profile-log-redaction.test.mjs`（含 `logStream` 仅测试注入、生产入口不引用的源码断言）。

## 4 工具链（微信开发者工具）证据

环境：微信开发者工具 Stable `2.02.2608080`（CLI `D:\微信web开发者工具\cli.bat`），基础库/SDKVersion `3.17.3`，
官方 `miniprogram-automator@0.12.1`（仅作为**本机工具目录**参数传入，未加入业务依赖或锁文件），
隔离工程由 `node tools/prepare-wechat.mjs local --config .local/config.local.json` 生成于 `.local/wechat-local`（gitignored），
本地替身 API 由仓库既有 PGlite fixture 起在 `127.0.0.1:3100`（`.local/serve-profile-fixture.mjs`，gitignored）。

### 4.1 登录与加载（真实）

```
& 'D:\微信web开发者工具\cli.bat' islogin
√ IDE server has started, listening on http://127.0.0.1:41195
{"login":true}
√ islogin

& 'D:\微信web开发者工具\cli.bat' auto --project '.local\wechat-local' --auto-port 9420
√ Using AppID: wx4407a4b908a69a54
√ auto
```

模拟器内（automator `systemInfo` + 真实 `wx.login`）：

```
systemInfo {"platform":"devtools","SDKVersion":"3.17.3","windowWidth":390,"windowHeight":753}
wx.login -> {"ok":true,"codeLength":32,"codeStart":"0c3d"}      // 真实微信身份平台返回，不 mock
login page status -> 登录成功；/pages/home/home loggedIn=true    // 真实 loopback HTTP 换取会话
```

> 披露：隔离工程的 `project.config.json` 需 `setting.urlCheck=false`（个人域名例外），且 `config/runtime.js`
> 的 `apiBaseUrl` 需带 `/api/v1`（客户端在 `utils/auth.js` 等处以 `runtime.apiBaseUrl + '/auth/…'` 拼接）。
> 两处**只改生成的 gitignored 副本**，仓库共享 `project.config.json` / `miniprogram/config/runtime.js` 未被触碰。

### 4.2 手选档案链路（真实编译/渲染 + 真实 loopback HTTP）

`node tests/integration/local-dev-profile-ui.cjs <automator目录> .local/i05-automation-390 9420 390`：
访客门（登录页截图）→ 目录全量游标读取（crops=4、regions=102）→ 手选作物/市/县 → 确认并保存（PUT 携带
`If-Match`/`Idempotency-Key`）→ 重新读取 → 按当前档案跳转参考查询。**GY-I05 相关各段全部 PASS**，
产出截图 12 张（`guest-login`、`profile-before-*`、`profile-edit-*`、`profile-saved-*`、`profile-reentry`、`reference-filter-*`）。

该脚本最后一段是 **GY-I26 字号受控分支**，本次实跑以 `controlled-font: TypeError | Cannot read properties of null
(reading 'style')` 退出（脚本内 `again.$('.page')` 返回 null；属另一条线，本分支未触碰 `miniprogram/**`，
按"如实记录"保留，不计入本片通过项）。

### 4.3 定位分支（本轮新增 `tests/integration/local-dev-profile-location.cjs`）

```
node tests/integration/local-dev-profile-location.cjs <automator目录> .local/i05-location-390 9420
PASS 9 个定位分支（真实页面/真实 loopback HTTP；平台失败响应为受控注入）；手选保存 revision 3->4；真实 wx.getLocation=returned
```

| # | 分支 | 页面可见文案（模拟器实跑） | 编辑态保留 |
| --- | --- | --- | --- |
| 1 | 确认框选"改用手选" | 已选择手选，可继续选择浙江市县。 | ✓ |
| 2 | 拒绝授权 | 未获得定位授权，可继续手选浙江市县。 | ✓ |
| 3 | 用户取消 | 已取消定位，可继续手选浙江市县。 | ✓ |
| 4 | 定位超时 | 定位超时，可继续手选浙江市县。 | ✓ |
| 5 | 平台不支持／未声明隐私接口 | 定位不可用或平台不支持，可继续手选浙江市县。 | ✓ |
| 6 | 允许 + 哨兵坐标 + 无转换资源 | 地区转换资源尚未接入，请手选浙江市县。 | ✓ |
| 7 | 省外（转换资源返回 null） | 当前位置不在首版覆盖的浙江省内，请手选浙江市县。 | ✓ |
| 8 | 有转换资源 ⇒ 只预选 | 已按定位预选 上城区，请确认后保存档案。 | ✓（revision 不变，不自动保存） |
| 9 | 真实平台坐标 + 无转换资源 | 地区转换资源尚未接入，请手选浙江市县。 | ✓ |

同时断言：`editing=true`/`locating=false`；预选分支 `revision` 不变；哨兵 `123.4567/89.0123` **不进入存储、
不进入页面数据**；定位失败若干次后仍能手选并真实保存（`revision 3 -> 4`，`crop_id=crop_rice`、`region_code=330102`）。
真实 `wx.getLocation` 在模拟器上的原始返回：`{ok:true, latitudeType:"number", longitudeType:"number"}`——
**坐标只在内存里交给（当前为 null 的）转换资源**，页面回退手选，服务端请求体中只有
`{crop_id, region_code, region_catalog_version}` 三个键（另一次独立探针运行的 PUT 原文：
`{"crop_id":"crop_rice","region_code":"330102","region_catalog_version":"mca-xzqh-2023"}`，`bodyKeys` 恰为这三项，
哨兵命中 0）。

**边界（不得外推）**：第 2–8 分支的平台响应是**受控注入**（在真实运行时里替换 `wx.getLocation`／页面
`regionConverter`），用于核对页面判定与文案；**不是**工具原生授权弹窗的真实允许/拒绝结果。
原始机读输出见 [location-observations.json](assets/gy-i05-toolchain-567bbda-390/location-observations.json)，
截图 4 张见同目录（`guest-login.png`、`profile-edit-selections.png`、`profile-saved-top.png`、`reference-filter-top.png`，
均为模拟器原生渲染、由上述脚本产出；本文作者所用模型不可读图，未做人工目视复核）。

## 5 真机：未取得，需 GUI／手机操作（最小步骤清单）

- **自动化侧**：官方 SDK 提供 `miniProgram.remote(auto?)` → `Tool.enableRemoteDebug`，实现为
  "返回二维码并 `await` `Tool.onRemoteDebugConnected`"（见 `miniprogram-automator/out/MiniProgram.js`）。
  即：真机调试必须**用手机扫码并与工具建立连接**，无人值守下会一直等待；本轮**未执行**（未假装跑过）。
- **网络侧**：隔离工程指向 `http://127.0.0.1:3100/api/v1`（loopback）。真机上 `127.0.0.1` 指向手机自身，
  真机无法访问本机替身 API；真机联调需要受控 HTTPS／局域网地址与域名白名单（本片不做域名/网关/CDN）。
- **需要用户点击的最小步骤清单**（用户已确认 IDE 已登录且真机已连接）：
  1. IDE 中打开隔离工程 `.local\wechat-local`（或由我 `cli auto` 打开），点 **真机调试**；
  2. 手机扫码并确认连接（此后我无法代点；请告知"已连接"）；
  3. 在手机上首次点"使用定位选地区（可改手选）"→ 弹窗选 **允许并定位** → 系统定位授权选 **允许**；
  4. 再次进入，弹窗选允许后在系统授权弹窗点 **拒绝**（或先在手机"设置→小程序→授权管理"清掉位置授权）；
  5. 另一轮：允许后在系统弹窗点 **取消**；再一轮：把手机定位关闭/断网制造 **超时**；
  6. 每轮截图（含"我的"页定位后文案与档案保存后的回显），并把手机型号/系统版本/微信版本、基础库版本一并发我。
- 上述 3–6 属于**真机权限流程**，本轮未取得，故本片不写"真机通过"。

## 6 未取得 / 未验证（如实标注）

| 项 | 状态 |
| --- | --- |
| 工具原生授权弹窗的真实允许/拒绝点击 | **未取得**（自动化点不到工具原生弹窗，需 GUI 操作） |
| Android 真机权限流程与截图 | **未取得**（见 §5 步骤清单） |
| 正式微信身份下的真机 `wx.login`／会话 | **未取得**（模拟器上已取得真实 code，见 §4.1） |
| 坐标→地区转换资源（真实逆地理编码） | **未取得**（首版本就不内置，页面如实回退手选） |
| 真实地区预警 | 首版不产生（设计如此） |
| 真机联通受控 HTTPS／域名白名单 | **未取得**（本片不做域名/网关/CDN） |
| 原生工程静态检查是否等同编译 | 否（`test:mini` 自述 *Not a WeChat compiler or device test*；真实编译/渲染由 §4 的工具链行为代替） |

**发现的工具链装配缺口（非阻塞，交指挥判断）**：`tools/prepare-wechat.mjs local` 经 `readLocalConfig`
只接受 origin 形态 `apiBaseUrl`（拒绝带路径），而客户端一律 `runtime.apiBaseUrl + '/auth/…'` 拼接（例如
`miniprogram/utils/auth.js`）。因此**按现状生成的本地替身工程登录会 404 `NOT_FOUND`**（本轮实测：登录页
`status=登录失败：NOT_FOUND`）；须在 gitignored 副本里手工把 `apiBaseUrl` 改成含 `/api/v1` 才能联调。
本轮**未修改**该工具或客户端（属跨线，且不在本片范围），仅如实记录。

## 7 复现命令

```bash
# 日志红线（改前/改后）
node tools/verify-gy-i05-log-redaction.mjs                    # 当前树：应 PASS
git checkout upstream/main -- services/api/src/app.ts && node tools/verify-gy-i05-log-redaction.mjs   # 改前：应 FAIL 并给出命中行
git checkout HEAD -- services/api/src/app.ts

# 单元与门禁
npm run lint && npm run test:unit && npm run test:contract && npm run test:mini && git diff --check

# 工具链（需本机 IDE 已登录、隔离工程与本机替身 API 已就绪）
node tools/prepare-wechat.mjs local --config .local/config.local.json
node .local/serve-profile-fixture.mjs                     # 127.0.0.1:3100，PGlite 替身
"D:\微信web开发者工具\cli.bat" auto --project ./.local/wechat-local --auto-port 9420
node tests/integration/local-dev-profile-ui.cjs <automator目录> .local/i05-automation-390 9420 390
node tests/integration/local-dev-profile-location.cjs <automator目录> .local/i05-location-390 9420
```

## 8 PR 正文可粘贴段落

> **范围**：GY-I05（`Refs #5`，不关闭整项）续跑收口。手选档案读写／越权（游客、他人、自报身份）／快照不变／
> 错误码与前后端一致性由 `tests/unit/profile-api.test.mjs`、`tests/unit/miniprogram-profile.test.mjs` 覆盖（全绿）；
> 授权定位只即时选地区、服务端不接收原始坐标（不落库、不进日志、不回封套），坐标→地区转换资源首版不内置。
>
> **跨线：`services/api/src/app.ts` 日志序列化器**（独立 commit `3f379fd` + 本轮 `2e0649a`，便于单独回退）。
> 原因：请求日志发生在路由与 schema 校验**之前**，路由层拒绝救不回已写下的日志。改动仅三处：`serializers.req`
> 只留 method + 无查询串的站内路径（`//host/...`、`http://...`、含 `://`、路径含高精度小数一律 fail-closed 不落原文）、
> `logStream` 仅测试注入（生产 `server.ts` 不传，日志仍写 stdout，级别/格式/目标不变）、404 封套 `message` 剥离查询串。
> 未新增 `declare module`，未碰 `packages/**`。
>
> **证据**：合成哨兵坐标全出口负例 —— 改前 11 处命中（incoming request／子日志中继／404 封套），改后 0 处且正向对照
> 成立（日志仍在工作、路径仍在）。探针 `tools/verify-gy-i05-log-redaction.mjs` 可在改前 `app.ts` 上复现命中，
> 故"全 0"不是假通过。门禁：`lint` 0、`npm run test:unit` `1774/1773 pass 0 fail 1 skip`、契约 6/6、`test:mini` 4/4、
> `git diff --check` 干净。
>
> **工具链（微信开发者工具 2.02.2608080 / SDK 3.17.3 / automator 0.12.1）**：IDE `islogin=true`、模拟器真实 `wx.login`
> 返回 32 位 code、真实 loopback HTTP 完成手选档案保存与重读；定位 9 个分支（确认框改用手选／拒绝／取消／超时／
> 平台不支持／允许但无转换资源／省外／预选／真实平台坐标）文案与编辑态保留均实跑通过，哨兵坐标不进存储与页面数据，
> 定位失败后仍能手选保存（revision 递增）。
>
> **未取得（不冒称）**：工具原生授权弹窗的允许/拒绝点击（需 GUI）、Android 真机权限流程与截图（需手机扫码，
> `Tool.enableRemoteDebug` 会等待 `Tool.onRemoteDebugConnected`）、真机联通所需受控 HTTPS/域名白名单、
> 真实坐标→地区转换资源。截图与机读观测见 `docs/verification/assets/gy-i05-toolchain-567bbda-390/`。
