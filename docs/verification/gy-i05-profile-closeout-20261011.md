# GY-I05（#5）收尾：档案快照、越权守卫与定位即时性（2026-10-11）

Refs **#5**（**不关闭 #5**、不自评验收通过）。任务映射：**F02**；验收 **AC01／AC15／AC21**。
基线 `upstream/main = 2d562d5b6fb79896ef8935716b90939538f274c2`（2026-10-11T10:42:51Z）。
复用已合组件：[PR #74](https://github.com/GengYunChuChao/GengYun/pull/74) 档案与目录 API、[PR #76](https://github.com/GengYunChuChao/GengYun/pull/76) 本地受限 LOGIN 接线、[PR #77](https://github.com/GengYunChuChao/GengYun/pull/77) 原生手选档案闭环；本轮**不重做**这些组件。

## 0. 先说不成立的部分（结论摘要）

- **AC1「Android／iOS 授权和拒绝路径可用」：真机未取得。** 本机只能证明分支判定与回退（合成 `wx`），**不能**证明微信授权弹窗、系统权限拒绝、真机定位行为。
- **AC21「授权取地区」的成功路径：仍未实现。** 坐标→浙江行政区的转换资源（腾讯位置服务逆地理编码或行政区边界数据）在本仓库与本机都不存在，本轮**不内置任何坐标数据、不伪造省界**；因此打包产物中 `regionConverter` 保持 `null`，定位成功后会如实返回 `unavailable` 并回退手选。
- 本轮补的定位部分只包括：**用户主动触发**、用途说明、**授权／拒绝／取消／超时／平台不支持／转换不可用**六条出口，以及**每一条都保留手选**。
- 其余本机可证部分（档案快照不被回写、两侧越权守卫、服务端不接收原始坐标、地区只筛静态科普）见 §2 逐条对照。

## 1. #5 验收逐条对照

| # | 验收条（#5 原文） | main 现状 | 证据（路径:行／测试名） | 本轮动作 | 本轮结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | Android／iOS 授权和拒绝路径可用，手选不依赖定位 | 手选已实现且有回归；**定位入口在 main 上完全不存在**（全仓库无 `wx.getLocation`／`authorize` 调用，页面原文写着"定位辅助尚未接入"） | 手选：[miniprogram-profile.test.mjs:36](../../tests/unit/miniprogram-profile.test.mjs#L36)；main 无定位实现：`git grep getLocation -- miniprogram` 仅命中该测试的断言 | 新增用户主动触发的定位入口与授权／拒绝／取消／超时／平台不支持分支；`app.json` 声明 `requiredPrivateInfos` 与用途文案 | 手选（本机）有证据；**授权与拒绝路径真机仍缺**，本机只证分支判定 |
| 2 | 修改档案不改写已保存识别、来源或后续实际记录快照 | `PUT /me/profile` 只写 `single_profiles` 与 `idempotency_keys`，无历史记录写入 | [service.ts:93-101](../../services/api/src/profile/service.ts#L93)；原有 `post_versions` 快照回归：[profile-api.test.mjs:179-190](../../tests/unit/profile-api.test.mjs#L179) | 新增"除档案两表外**所有表逐字节不变**"回归，含正向对照（档案本身确实被改写）与"无坐标列"断言 | **有证据**（本轮加强为逐字节口径） |
| 3 | 游客不可修改他人或登录用户档案 | 服务端：无会话四端点 401、多余身份字段 400、非 `user` 角色在事务首行拒绝；客户端：切账号／注销／离页不发旧草稿（已有）。**客户端"游客点击保存／定位"缺独立回归** | 服务端：[profile-api.test.mjs:118-120](../../tests/unit/profile-api.test.mjs#L118)、[:137-147](../../tests/unit/profile-api.test.mjs#L137)、[service.ts:32](../../services/api/src/profile/service.ts#L32)；客户端：[miniprogram-profile.test.mjs:28-33](../../tests/unit/miniprogram-profile.test.mjs#L28) | 补客户端"无会话零写入、零定位调用"回归；补服务端"非 `user` 角色 `SCOPE_DENIED`＋他人会话 id 不可借用＋被拒请求零落库"反例 | **两侧均有证据** |
| 4 | 首版地区只筛选静态科普，不产生真实地区预警 | 地区只作为静态资料筛选条件；仓库无任何预警实现 | [query.test.mjs:44-46](../../tests/reference/query.test.mjs#L44)、[miniprogram-parity.test.mjs:59-64](../../tests/reference/miniprogram-parity.test.mjs#L59)、[acceptance-map.md:21](../../docs/architecture/acceptance-map.md#L21)；`git grep 预警 -- miniprogram services packages tests` 在 main 上无命中 | **未改代码**，只补可复核证据（见 §4.1 命令与输出） | 复用已合证据＋本轮复核，**无真实缺口** |
| 5 | 定位仅即时选择地区，服务端不接收原始坐标；拒绝／取消／超时／省外与手选能继续，不引入轨迹／导航或真实预警 | 服务端：坐标字段被 `additionalProperties:false` 拒绝、无坐标列、响应无坐标键；客户端：**拒绝／取消／超时／省外四类分支在 main 上不存在**（无定位入口） | 服务端：[routes/profile.ts:24](../../services/api/src/routes/profile.ts#L24)、[:29-34](../../services/api/src/routes/profile.ts#L29)、[profile-api.test.mjs:137-140](../../tests/unit/profile-api.test.mjs#L137)；客户端：本轮新增（见 §3） | 补五类失败分支＋手选继续的页面级回归；坐标只进内存不进状态／存储／请求／返回值；无轨迹 API 反证 | 服务端**有证据**；客户端五类失败分支本轮变**有证据**；**授权取地区成功路径仍缺** |

## 2. 本轮改动（只补真实缺口）

### 2.1 代码

- **新增** [miniprogram/utils/location-region.js](../../miniprogram/utils/location-region.js)：定位结果的**判定与文案**。第 30 行 `locate(wxApi, convert)` 只 `resolve` `{status}` 或 `{status:'ok',region_code}`，**坐标不出现在任何返回值里**；`convert` 由调用方注入，模块**不内置坐标→行政区数据**（第 11-13 行注释写明契约）。无 `startLocationUpdate`／`onLocationChange` 等跟踪接口。
- [miniprogram/pages/profile/profile.js:79-108](../../miniprogram/pages/profile/profile.js#L79)：新增 `regionConverter`（打包产物中为 `null`）、`onLocate`（先弹用途说明，再请求定位）、`applyLocatedRegion`（只在已加载目录内预选，**不自动保存**）。所有失败分支只写提示，`editing` 保持为真，手选入口不动。
- [miniprogram/pages/profile/profile.wxml:33-35](../../miniprogram/pages/profile/profile.wxml#L33)：编辑态新增"使用定位选地区（可改手选）"按钮；说明文案改为如实描述定位用途、不保存坐标、失败可手选。
- [miniprogram/app.json:23-30](../../miniprogram/app.json#L23)：新增 `permission.scope.userLocation.desc` 与 `requiredPrivateInfos: ["getLocation"]`，使该调用在平台上合法声明；**未改** `miniprogram/config/runtime.js`（仍逐字节为 `mode: 'disabled', apiBaseUrl: ''`）。
- [tools/prepare-wechat.mjs](../../tools/prepare-wechat.mjs)：把新模块加入标准打包允许清单（否则页面 `require` 会在打包产物里 `MODULE_NOT_FOUND`）——清单项 `'utils/location-region.js'` 本身：引入提交 `e22dbeb` 实测 `:35`（原记 `:34` 在引入提交 `e22dbeb` 上是该项上方的注释行），测量基线 `6c22000` 实测 `:40`。

### 2.2 接口影响

- **未新增、未修改任何 HTTP 路由、请求字段或响应字段。** 服务端源码（`services/api/src/**`）本轮**零改动**。
- 唯一"外部契约"变化是微信平台侧声明（`app.json` 的 `permission`／`requiredPrivateInfos`），不是本项目接口契约。
- 小程序端新增一个本地模块 `utils/location-region.js`，已进入打包清单与清单同步回归。

### 2.3 既有测试文件的改动（**只做加法**）

| 文件 | 加了什么 | 是否削弱既有断言 |
| --- | --- | --- |
| [tests/local-debug.test.mjs](../../tests/local-debug.test.mjs#L100) | 依赖清单里加一行 `'utils/location-region.js'` | **否**。清单是"打包必须包含"的正向断言，加一行只会让检查更严 |
| [tests/unit/miniprogram-profile.test.mjs](../../tests/unit/miniprogram-profile.test.mjs#L5) | 顶部加 `import { createRequire } from 'node:module'`；第 38 行起追加 8 个用例 | **否**。既有 13 个用例与断言一字未改（含 `'getLocation' in f.wx === false` 那条手选反证） |
| [tests/unit/profile-api.test.mjs](../../tests/unit/profile-api.test.mjs#L210) | 第 212 行、251 行各追加 1 个顶层用例 | **否**。原 8 个子测试与断言一字未改 |
| [tools/prepare-wechat.mjs](../../tools/prepare-wechat.mjs#L34) | 允许清单加一行新模块 | **否**。白名单是拒绝未知路由／文件的硬校验，未放宽任何条件 |

未删除、未注释、未跳过任何既有用例；未放宽容差；未改任何 `it.skip`／`todo`。

## 3. fail-closed：每类"应当拒绝"各有独立反例

新增 [profile-api.test.mjs:212](../../tests/unit/profile-api.test.mjs#L212) 汇总 15 条独立反例，逐条断言 `statusCode ∈ {400,401,409,428}`、契约错误码为字符串、**且响应里没有 `data`**；随后断言 `single_profiles` 与基线**逐行相同**（被拒请求一条都没落库），并断言另一个主体不会因他人请求产生档案行：

| 类别 | 独立反例 | 预期 |
| --- | --- | --- |
| 无会话 | 游客 GET 档案／作物目录／地区目录，游客 PUT | 401 |
| 他人档案 | `?user_id=<另一 uuid>` 查询串 | 400 |
| 自报身份 | body 带 `user_id`／`owner_id`／`role`／`profile_id` | 400 |
| 坐标 | body 带 `latitude`＋`longitude`；三个端点查询串带 `latitude`／`longitude` | 400 |
| 多余字段 | body 带 `note` | 400 |
| 缺项／字典外 | 缺 `crop_id`、缺 `region_code`、字典外作物、`330999`、省外 `440100`、伪造目录版本 | 400 |
| revision 冲突 | `If-Match: "9"` 对当前 revision 2 | 409 |
| 越权角色 | 服务层以 `admin`／`guest`／`service`／空字符串角色调用 GET 与 PUT；他人会话 id | `SCOPE_DENIED`／`SESSION_EXPIRED` |

- **判定被下游真正消费**：`assert.deepEqual(await stored(), baseline)` —— 拒绝只发生在事务内且 `ROLLBACK`，没有"记一条原因却仍然返回 200 并写入"的路径。
- 断言先 `typeof` 再判值：`assert.equal(typeof (body.error && body.error.code), 'string')`，不会把 `undefined` 放过。
- **"矩阵条数不等于 fail-closed"**：上表每一行都能被单独指出（每类一条独立请求、独立 key、独立行）。

## 4. 实测（本机／隔离／真机分列，不合并）

### 4.1 本机实际命令与结果

```powershell
cd E:\GengYunCommander\GengYun_W2
npm ci --no-audit --no-fund      # added 103 packages in 4s，exit 0
npm run lint                     # PASS tsc services/api；PASS tsc apps/admin；PASS 仓库卫生扫描；lint 通过
npm run test:unit                # tests 694 / pass 693 / fail 0 / skipped 1 / duration 15259.9682ms
npm run test:contract            # tests 6 / pass 6 / fail 0
npm run test:docs                # PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
npm run test:mini                # check-wechat-project PASS；tests 4 / pass 4 / fail 0
node --test tests/unit/miniprogram-profile.test.mjs   # tests 21 / pass 21 / fail 0
node --test tests/unit/profile-api.test.mjs           # tests 11 / pass 11 / fail 0（含上述 2 个新用例）
```

唯一 `skipped 1` 是 main 上原有的跳过项，本轮未新增跳过。

AC4 的**反证命令与真实输出**（地区只筛静态科普、不产生预警）：

```powershell
git grep -n "预警" -- miniprogram services packages tests
# tests/unit/miniprogram-profile.test.mjs:110: assert.equal(JSON.stringify(locationRegion.MESSAGES).includes('预警'),false);
# 即 main 的应用代码里没有任何预警实现，唯一命中是本轮新增的"不得出现预警"反向断言。
git grep -n -E "latitude|longitude" -- services/api/db packages/knowledge/catalog
# （无输出）行政区划目录与迁移里都没有坐标字段/坐标数据。
```

### 4.2 隔离运行／合成身份

- [tests/integration/profile-ui-http.test.mjs](../../tests/integration/profile-ui-http.test.mjs)（**真实前端模块 + 真实 loopback HTTP**，PGlite 串行受限 `SET ROLE`）：`pass 1 / fail 0`，输出 `PASS PGlite, serialized limited SET ROLE; synthetic identity/catalog fixture; real loopback HTTP and actual frontend modules; no suppliers`。
- [tests/ui-adaptive.test.mjs](../../tests/ui-adaptive.test.mjs)（受影响页面检查：对每个 Tab 页 `<button>` 的样式与 `--font-scale` 注入断言）：`tests 25 / pass 25 / fail 0`。**该文件不在 `npm run test:unit` 的 glob 内**，本轮因为它直接扫描 `miniprogram/pages/profile/profile.wxml` 的按钮而单独执行，已通过。
- 档案 HTTP／SQL 全部使用**合成身份与合成目录夹具**（`login('profile-a')`／`login('profile-b')`、4 作物／102 浙江节点），没有真实用户、没有供应商调用。
- 页面级（改动页的实际产物加载）：

```powershell
node tools/check-wechat-project.mjs            # PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax
node tools/prepare-wechat.mjs release          # RELEASE import root: ...\.local\wechat-release
node .local/profile-product-check.cjs ...\.local\wechat-release
# PASS release product: 12 pages load; profile page exposes onLocate/applyLocatedRegion with NO
# conversion resource wired; utils/location-region.js packaged; runtime stays disabled;
# app.json declares getLocation for the user-triggered entry only.
```

即：标准发布产物里 12 个页面全部可 `require`，`utils/location-region.js` 确实被打包，`runtime.js` 仍是 `disabled`，且**打包产物中没有任何坐标→地区转换资源被接上**。

### 4.3 过程中的真实失败（如实记录）

第一次跑新用例时**失败**，原始报错：

```text
✖ GY-I05 closeout: non-user session role is denied before any SQL, and 更新档案不改写任何已保存记录表（逐字节）
  TypeError: Cannot read properties of undefined (reading 'revision')
      at TestContext.<anonymous> (file:///E:/GengYunCommander/GengYun_W2/tests/unit/profile-api.test.mjs:284:24)
```

原因：夹具会登录两个主体，而我用 `(SELECT id FROM users ORDER BY id LIMIT 1)` 取用户，取到了没有档案行的那个主体。改为按当前会话的 `user_id` 取值后该用例通过（`pass 11 / fail 0`）。**没有**为了让结果变绿而放松任何断言。

另有一次自测中被自己发现并改掉的笔误（多写了一个逗号导致语法错误），在**运行前**由复核修正，未作为"通过"记录。

### 4.4 真机

**未取得。** 本轮没有任何 Android／iOS 真机执行。缺的条件：

1. 用户侧 **Android（或 iOS）真机 + 微信客户端**，且用**局域网可达的后端地址**替换 `runtime.js` 里的 loopback 地址；
2. 该项目当前使用**已公开的共享 AppID**，其微信后台**隐私保护指引与地理位置接口权限不由本仓库配置**，因此真机上的授权弹窗／拒绝路径无法在本机取得；
3. 真机项必须由操作者在真机上按下按钮、看到授权弹窗、选择拒绝/允许，并截取系统权限对话框与页面回退画面。

**模拟器结果一律不写作真机结果**；本文件也**没有**任何"真机已验证"的表述。

## 5. 未取得项与阻塞

| 项 | 状态 | 缺什么 |
| --- | --- | --- |
| AC1 真机授权弹窗与拒绝路径 | **未取得** | 用户侧 Android／iOS 真机、正式 AppID 的隐私协议与接口权限、局域网后端地址 |
| AC21「授权取地区」成功路径 | **未实现（阻塞）** | 坐标→浙江行政区转换资源（腾讯位置服务逆地理编码 key，或可核验来源的行政区边界数据）。本轮**拒绝**自制省界／坐标表来"看起来实现" |
| 省外判定的真实地理正确性 | 仅分支级证据 | 同上；本轮的 `out_of_coverage` 只用合成转换器驱动，不代表真实边界判定准确 |
| 真机上的定位精确定位与失败码分布 | 未取得 | 同上 |
| 微信工具渲染截图 | 未取得 | 本轮未启动微信开发者工具做视觉验证，只做了产物加载与 JS 语法校验，**不是**渲染验收 |

这些阻塞**不**由本 PR 声明关闭；`#5` 保持 open。

## 6. 自我核对

- [x] 口径 `Refs #5`，全文与提交信息**未出现** `Closes #5`
- [x] 未合并任何 PR、未自评验收通过、未代监工宣布验收
- [x] 未改 `miniprogram/config/runtime.js`（打包校验仍逐字节要求 `mode: 'disabled', apiBaseUrl: ''`）
- [x] 未删除／注释／跳过任何既有测试；既有测试文件只做加法（见 §2.3）
- [x] 无令牌、无 `.env`、无 AppSecret、无真实 openid、无真实会话令牌、无真实坐标（新增测试用的是明显越界的合成哨兵值 `123.4567／89.0123`）
- [x] 未伪造证据：真机与授权取地区成功路径均明确写作未取得／未实现
- [x] 未引入轨迹、导航、真实地区预警、多田块采集
- [x] 未提交构建输出（`.local/` 与 `node_modules/` 均被 `.gitignore` 覆盖，`git status` 已逐条确认）

作者只提交 Fork 分支并请求监工固定 HEAD 复审；不自行批准、不合并、不关闭 #5。
