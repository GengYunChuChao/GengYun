# GY-I07 取证索引 v2 · 可达性与页面证据（#7）

- 日期：2026-10-10
- 分支：`feature/gy-i07-evidence-index`（**新建，基点 = 最新 main**）
- base SHA：`7ec4c855a69e5a31fe97452aefa1b3e38f2d3207`（PR #66 已合并后 main）
- 工程导入目录：`E:\GengYunCommander\GengYun_Agent2\miniprogram`（微信开发者工具真机调试实际导入根）
- 工具：微信开发者工具 `Stable 2.02.2608080`；CLI `D:\微信web开发者工具\cli.bat`
- 真机：`realme-RMX3706` / Android 15 / 微信 `8.0.78` / 基础库 `3.17.4 [1655]`
- 本机 Node：`v24.16.0`（与 CI 同版本）

## 0. 本索引的取证边界（务必先读）

1. **本轮证据由用户手动采集**。表格中凡标注「提供者＝用户」的条目，均为**用户在真机/模拟器上手动操作并截图**，写手侧**未**自动取得——**不得转述为「自动取得」**。
2. **原始图片不进入仓库**（项目规则：不提交个人原始媒体）。本索引只写**文字描述 + 文件名 + 提供者 + 时间**，**不嵌原图**。
3. **本索引不含** AppSecret / AI 凭据 / 数据库密码 / 私有地址；`appid` 为已公开标识（上游 14+ 处已跟踪文件公开，`docs/archive/development-2026-10-10/docs/local-wechat-debug.md` §「已确认输入与原工程比较」明文「AppID 是公开标识」；测量基线 `6c22000` 实测 `:7`，原文已移档至此，现行 `docs/local-wechat-debug.md` 仅存指向该档案的简述）。
4. **注册/编译页面 ≠ 页面已走查**：10 页均已注册编译（见 §3），但查询类页面在当前配置下**不可达**（见 §2），**不记为通过**。

---

## 1. 条目表（J1-a ～ J1-i）

| 条目 | 场景 | 操作步骤 | 实际结果 | 提供者 / 时间 |
|---|---|---|---|---|
| **J1-a** | 模拟器首页渲染 | 工具打开工程 → 默认进入首页 | 首页渲染正常；「耕云」标题、游客说明、入口按钮、底部 tabBar 可见；无渲染缺失 | 用户（蛙大师）/ 2026-10-10 |
| **J1-b** | 模拟器点「识草查药」入口 | 首页点「识草查药」 | **重定向到 `/pages/login/login`**（未进入查询页） | 用户（蛙大师）/ 2026-10-10 |
| **J1-c** | 模拟器点「科普种子资料库」入口 | 首页点「科普种子资料库」 | **重定向到 `/pages/login/login`**（未进入查询页） | 用户（蛙大师）/ 2026-10-10 |
| **J1-d** | 模拟器登录页点「微信登录」 | 在登录页点「微信登录」 | **显示提示**「当前未启用联网（共享源码默认关闭）。请在本地或正式环境启用后再登录。」（与 `utils/auth.js:205` 文案**逐字一致**） | 用户（蛙大师）/ 2026-10-10 |
| **J1-e** | 模拟器 Console | 打开 Console 面板（含一次**手动输入**） | 转录见 §1.1（**共 5 条：4 条框架类（#1/#2/#4/#5）＋ 1 条操作者手动输入（#3 `Uncaught ReferenceError: pages is not defined`）**） | 用户（蛙大师）/ 2026-10-10 |
| **J1-f** | 真机首页 | 真机调试中打开小程序首页 | 同 J1-a（首页正常）；设备信息面板：`realme-RMX3706` / Android 15 / 微信 `8.0.78` / 基础库 `3.17.4 [1655]` | 用户（蛙大师）/ 2026-10-10 **16:28** |
| **J1-g** | 真机点入口 → 登录页 | 真机首页点两个入口 | 同 J1-b / J1-c（**均重定向登录页**） | 用户（蛙大师）/ 2026-10-10 **16:28** |
| **J1-h** | 真机登录页 + 「● 已连接」 | 真机登录页；连接状态显示「● 已连接」 | 登录页显示「登录耕云」+ 未启用联网说明 + 底部错误提示（同 J1-d 文案）。**本条仅支持以下三点（不得外推）**：① 调试器「● 已连接」只说明**开发者工具调试连接可用**；② 该次点击被**客户端 `mode='disabled'` 本地门禁**如实拒绝（独立离线复现亦确认 `wx.login`／`wx.request` 调用数为 **0**）；③ **业务网络（DNS／合法域名／TLS／HTTP）、后端服务与真实微信身份交换：未验证**。**不得**据此断言「不是网络故障」「排除网络问题」，**也不得**反推「网络有问题」。 | 用户（蛙大师）/ 2026-10-10 **16:29** |
| **J1-i** | 真机点「以游客身份浏览首页」 | 真机登录页点「以游客身份浏览首页」 | **返回首页**（用户确认：点完之后就是主页） | 用户（蛙大师）/ 2026-10-10 |

### 1.1 J1-e 模拟器 Console 转录（逐条，含成因标注）

```
⚠ webviewId 286526601 is not found                     WASubContext.js:1
✕ SystemError (appServiceSDKScriptError)               WAServiceMainContext.js:1
  "[Page 路由 错误] routeDone with a webviewId 286526601 is not found"
> pages/reference/reference                             ← 操作者手动输入（控制台求值）
✕ Uncaught ReferenceError: pages is not defined        VM59:1
    at <anonymous>:1:1
✕ routeDone with a webviewId -1633183530 is not found  WASubContext.js:1
✕ SystemError (appServiceSDKScriptError)               WAServiceMainContext.js:1
  "[Page 路由 错误] routeDone with a webviewId -1633183530 is not found"
```

**逐条性质判定**：

| # | 条目 | 来源 | 性质 |
|---|---|---|---|
| 1 | `webviewId 286526601 is not found` | `WASubContext.js:1` | 微信基础库运行时内部（**既往另有 8 条报错记录，属不同批次／不同观测，不得与本批 5 条合并计数**；本批**未展开完整栈**） |
| 2 | `SystemError (appServiceSDKScriptError)` | `WAServiceMainContext.js:1` | 同上，为第 1 条的上报封套 |
| 3 | `Uncaught ReferenceError: pages is not defined` | **`VM59:1`** | **操作者手动输入 `pages/reference/reference` 导致** —— appservice 全局**无** `pages` 标识符，控制台求值即抛 `ReferenceError`。**来源为控制台动态求值（`VM59:1`）**，**不属于**框架报错，**与项目代码无关**。 |
| 4 | `routeDone with a webviewId -1633183530 is not found` | `WASubContext.js:1` | 同第 1 条 |
| 5 | `SystemError (appServiceSDKScriptError)` | `WAServiceMainContext.js:1` | 同第 2 条 |

> **口径**：① 本次转录**共 5 条**＝**框架类 4 条（#1/#2/#4/#5）**＋**操作者手动输入 1 条（#3 `Uncaught ReferenceError: pages is not defined`，`VM59:1` 控制台动态求值）**，**没有第 6 条**，**不写作「5+1」**；② **如实保留**该条 `ReferenceError`，**不删除、不略过**，并明确其**成因＝操作者手动输入**，**非项目代码触发**；③ **不因 Console 有红条就写成「无报错」**；④ 框架类 **4 条**（#1/#2/#4/#5）**未展开完整调用栈**，故**不推断触发原因**；⑤ 本批 5 条与**既往 8 条**报错记录是**不同批次／不同观测**，**不得混为一谈、不得合并计数**。

---

## 2. 不可达页面记录（J2）

### 2.1 结论

| 页面 | 路由 | 当前配置下可达性 | 记录 |
|---|---|---|---|
| 除草剂查询列表 | `pages/reference/reference` | **不可达** | 受门禁重定向 |
| 除草剂详情 | `pages/referencedetail/referencedetail` | **不可达** | 同上 |
| 资料种子/来源区 | `pages/referenceseed/referenceseed` | **不可达** | 同上 |

- **不记为失败，也不记为通过** —— 记为「**受 GY-I04(#4) 依赖阻塞，未走查**」，指向 **#4（GY-I04）整项 open**。
- 与 J1-b/c（模拟器）与 J1-g（真机）的实测一致：**点入口即被重定向至登录页**。

### 2.2 根因（源码依据，非推断）

`miniprogram/config/runtime.js`（全文 2 行）：
```js
// Shared source always has networking disabled. Local preparation writes only an ignored copy.
module.exports = { mode: 'disabled', apiBaseUrl: '' }
```

`miniprogram/utils/auth.js:336-341`（`requireLogin`）：
```js
function requireLogin(callback) {
  const done = typeof callback === 'function' ? callback : function () {}
  if (getSession() === null || !networkEnabled()) {
    wx.reLaunch({ url: '/pages/login/login' })
    done(false)
    return
  }
  ...
}
```

`miniprogram/utils/auth.js:36-38`（`networkEnabled`）：
```js
function networkEnabled() {
  return runtime.mode === 'local' && typeof runtime.apiBaseUrl === 'string' && runtime.apiBaseUrl !== ''
}
```

**推导链**：`mode='disabled'` → `networkEnabled()` 恒 `false` → `requireLogin()` 首判即 `!networkEnabled()` 为真 → 无条件 `wx.reLaunch('/pages/login/login')` + `done(false)` → **三个查询页在模拟器与真机中均不可达**。

**性质说明（重要）**：**这不是缺陷**，是第 1 轮 F4「登录门禁前置」的**正确实现**。`utils/auth.js` 头注（L3-4）已声明「共享源码的 runtime.mode 为 'disabled'，网络未启用时 login() 明确失败，**不伪造登录成功、不写入假令牌**」。共享源码**恒禁用网络**是既定设计；启用网络须由 `tools/prepare-wechat.mjs` 生成 `mode:'local'` 的**忽略副本**（不入仓）。

---

## 3. 门禁反证（J3，单元级，已执行）

以**内存替身**（注入 `globalThis.wx`）调用**真实** `miniprogram/utils/auth.js` 的 `requireLogin()` / `login()`，覆盖 4 个 runtime 组合与 1 个登录文案断言。

- 脚本：`.workbuddy/evidence-gyi07/j3-gate-counterproof.mjs`（本地，**不入仓**）
- 命令：`node .workbuddy/evidence-gyi07/j3-gate-counterproof.mjs`（Node `v24.16.0`）
- 原始输出：`.workbuddy/evidence-gyi07/j3-output.txt`

```
== J3 门禁反证：requireLogin() 可达性 ==
runtime.js 实际内容：module.exports = { mode: 'disabled', apiBaseUrl: '' }

OK   S1 mode='disabled', apiBaseUrl='' → 必然 reLaunch 登录页  —— reLaunch=1(url=/pages/login/login) cb=false request=0
OK   S2 mode='local', apiBaseUrl='' → 仍拒绝（networkEnabled=false）  —— reLaunch=1(url=/pages/login/login) cb=false request=0
OK   S3 mode='disabled', apiBaseUrl='http://x' → 仍拒绝（mode 不符）  —— reLaunch=1(url=/pages/login/login) cb=false request=0
OK   S4 mode='local', apiBaseUrl='http://127.0.0.1:1' + 无缓存会话 → 仍 reLaunch（无会话）  —— reLaunch=1(url=/pages/login/login) cb=false request=0
OK   login() 在 mode='disabled' 下回调联网未启用提示  —— msg="当前未启用联网（共享源码默认关闭）。请在本地或正式环境启用后再登录。" wx.login 调用=0

== 结果：pass=5 fail=0 ==
```

**断言要点**：
- **S1**（真实共享源码配置）→ **必然** `reLaunch('/pages/login/login')`、回调 `false`、**零网络请求**（`request=0`）；
- **S2/S3/S4** 三个退化/变体组合**均仍拒绝**，无「静默放行」路径；
- **`login()` 文案与真机登录页（J1-d / J1-h）逐字一致** → 用户实测的登录页提示**确由该分支代码产生**。

> **层级声明**：J3 为**离线单元级**证据，验证的是**门禁逻辑本身**；**不等同**真机/模拟器的可达性实测。二者互相印证（§2.2 源码 + 本节单元反证 + J1-b/c/g/h 实测）。

---

## 4. 已注册/已编译页面清单（不等于已走查）

以下 10 页均由工具**注册并编译**（见既往工具编译日志，条目 A3）：

```
pages/home/home  pages/identify/identify  pages/reference/reference
pages/referencedetail/referencedetail     pages/referenceseed/referenceseed
pages/referenceseeddetail/referenceseeddetail  pages/community/community
pages/messages/messages  pages/profile/profile  pages/login/login
```

**严格区分**：
- **已注册/已编译**：✅ 10/10
- **已实际导航/渲染/交互**：仅 **首页**（J1-a/J1-f，用户实测）、**登录页**（J1-d/J1-h，用户实测）；**其余查询类页面不可达**（§2）；`identify`/`community`/`messages`/`profile` 等**本轮未单独走查**。

---

## 5. 仍未覆盖的缺口（如实列出）

1. **GY-I04(#4) 真实登录态** —— **依赖阻塞**（#4 整项 open）；本索引 §2 的「不可达」结论即由此产生。
2. **三个查询页（列表/详情/来源区）的实际渲染截图** —— **未取得**，且**当前配置下不可达**；须待 #4 打通登录态后另派单。
3. **既往批次 8 条报错中其余 6 条的完整调用栈与触发原因** —— **未展开、待证**（既往仅展开 2 条；该 8 条与本次转录 5 条**不是同一批次**，不得合并计数）。
4. **真实 HTTP 接口往返（经 `services/api`）** —— **未提供**；服务层直调仅记作**离线组件级**证据，**不记作真实 HTTP**。
5. **`identify`/`community`/`messages`/`profile` 页面的实际走查** —— 本轮**未做**。

---

## 6. 取证口径声明

- 本索引为 **`Refs #7`** 口径的**部分交付**；**不写 `Closes #7`**。
- **未改动** `miniprogram/config/runtime.js`（`mode='disabled'` **保持不变**）；本轮**零功能代码改动**，仅新增本索引文档。
- **不推上游 main、不合并、不代审、不关闭 #7**；CI 与本地证据分列。
- 边界不变：`data_origin=seed_unverified`、`authority=none`、强制「待核实·非权威」；不显示真实用量、不授专家认证标签、缺项不补写。
- **未声称**「真机证据已补齐」或「#7 完成」。
- **本版修订（2026-10-11，PR #67 追加提交）**：修订提交 `db2a54305ce1f7437eb2b1abd6fe44980a525bc1`（基于 `c50bb7d869cfe7bf7f0cea33bf7e652233e95c5a`），改动限于本文档 `:28 / :31 / :52 / :58 / :160 / :173` 六处；**本版仅修正下述两项口径（P2 收窄 J1-h 证明范围 ／ P3 统一 Console 计数与批次区分），未新增、未删除任何证据条目**。两项口径修正 —— ① **收窄 J1-h 的证明范围**：「● 已连接」只说明调试连接可用，该次点击只说明客户端 `mode='disabled'` 本地门禁拒绝，**业务网络（DNS／合法域名／TLS／HTTP）、后端服务与真实微信身份交换未验证**；② **统一 Console 计数**：本次转录**共 5 条＝框架类 4 条（#1/#2/#4/#5）＋操作者手动输入 1 条（#3）**，**无第 6 条**。本次修订**未新增、未删除任何证据**；那条 `ReferenceError` 与既往 8 条报错记录均**如实保留**（二者为不同批次／不同观测）。
