# GY-I05：原生手选档案组件（2026-10-11）

Refs #5，F02；本轮覆盖 AC01／AC21／AC15 的手选、隐私及档案消费范围，不关闭整项。
独立分支 `feat/gy-i05-native-profile` 从实时 main `7ac2c8facc5f876f166ba2548b6c2023c4d434a0` 创建。
执行前 Git fetch 与 GitHub API 交叉核对 main；PR69／74／75 已合，分别绑定审查
5481423002／5481410344／5481416022，不再使用旧“等待CI”的状态。
开放 PR 中未发现该手选前端已有实现；现有“我的”仅显示静态未设置。

## 行为与边界

在既有“我的”Tab 读取当前档案及完整目录。待读取、服务不可用、真正未设置分别显示；
作物／浙江市／县区全部取自已合 API，不从本地常量编造可保存目录。
按 next_cursor 连续翻页，重复游标、重复编号或非法响应关闭加载，不把半个目录标完成。
支持仅选市或选县区；换市清空旧县区。用户确认后只发送 crop_id、region_code、region_catalog_version。
没有 user_id／owner／role／坐标；无需定位授权即可手选。定位辅助明确尚未接入，不声称授权／拒绝／超时路径已验。

每次保存冻结 body、Idempotency-Key、强 If-Match；重复点击不产生第二请求。
网络不确定时锁定这次草稿，由用户重试相同 key/body/version 或重新读取，不自动重复发送。
REVISION_CONFLICT／IDEMPOTENCY_CONFLICT 关闭保存，必须重新读取、重新选择确认；不无条件覆盖。
PUT 成功后 GET 当前档案，读失败不称“已重读”。不改识别／任务／source_version 快照。

已审 page-gate 负责身份核实。新增 auth.sessionEpoch 是只读内部世代，不改服务端契约；
读取草稿绑定 token 与登录／退出意图世代，切账号（包括清除后同令牌）／退出／过期或离页先清全部档案状态。
迟到读写回调不能展示旧主体、不能把旧草稿保存到新主体。已发出的 PUT 可能仍在服务端完成；
离页不冒称能撤回服务端写入，再进入以重新读取为准。草稿不写本地存储或 App 全局。

“按当前档案查科普资料”只传已有作物／地区条件，导航只允许固定 reference 路由与两项格式。
资料页保留登录门禁、当前目录验证和来源限制。当前测试返回 insufficient／条件不足，
没有生成用药建议，研究候选和种子整理稿未改成批准资料。

## 工程范围

使用原“我的”页面，无新增页面或 app.json 路由；五 Tab 顺序／居中识别／字号／安全区保留。
新消费依赖是 `miniprogram/utils/profile-api.js`，已进入 tools/prepare-wechat 的标准白名单，
local/release 真正产物加载所有页面通过。现有 tools/local-dev/prepare.mjs 递归复制 JS 等文件，
无固定路由清单，能自动消费该新路径，本 PR 不改 local-dev 工具或服务端 SQL／角色。
并行写手负责 local-dev 的 profile_runtime 组合接线；本轮测试不借用原有 API 登录角色或旧库。

## 当前源码与微信画面

小程序源码 `f0ea601c8e1d152f9228ade808e8cddef1230226`，后续提交仅验证脚本／证据，不修改应用。
[源码与资产哈希](assets/i05-profile-f0ea601-320/sources.json)核对真正导入独立工程；
标准包不消费的子目录工程配置／旧 session 工具单列，不谎称它们已打包。
唯一运行源码差异是忽略的 runtime 指向 loopback3102；共享 disabled 与 urlCheck=true 保留，
域名例外仅在独立 `GengYun-I05-Handselect` 工程。

[原始观测](assets/i05-profile-f0ea601-320/observations.json)：基础库3.17.3，实际窗口320×504。
实际微信工具 wx.login → 合成身份 API → 受限 LOGIN／原生 PG17.11；无 auth 覆盖或直接 fontScale 注入。
目录装载为 **synthetic 测试库夹具**（编号名称源于已合目录），并非生产目录或真实用户。
SDK 触发 picker change 与 showModal 确认夹具，确认后的请求与重新读取是实际 HTTP；
这不等于真人操作系统选择弹窗或 Android 真机验收。
标准实测 fontSizeSetting=16、factor=0.9，按下限归1；正文18px、主要档案按钮高约45.2px。
它不是 PR69 的1.11环境。受控 getAppBaseInfo=26／1.625 另列：App→页面1.3，正文与选择项23.4px，
已 finally 恢复为实际1。受控截图不是实际微信最大字体设置。

| 画面 | 当前证据 |
| --- | --- |
| 游客门禁 | [登录页](assets/i05-profile-f0ea601-320/guest-login.png) |
| 服务端未设置 | [顶部](assets/i05-profile-f0ea601-320/profile-before-top.png)、[末屏](assets/i05-profile-f0ea601-320/profile-before-bottom.png) |
| 市县选择／确认按钮 | [选择](assets/i05-profile-f0ea601-320/profile-edit-selections.png)、[保存](assets/i05-profile-f0ea601-320/profile-edit-save.png) |
| 保存并重读 | [顶部](assets/i05-profile-f0ea601-320/profile-saved-top.png)、[末屏](assets/i05-profile-f0ea601-320/profile-saved-bottom.png)、[重新进入](assets/i05-profile-f0ea601-320/profile-reentry.png) |
| 资料条件与不足 | [顶部](assets/i05-profile-f0ea601-320/reference-filter-top.png)、[末屏](assets/i05-profile-f0ea601-320/reference-filter-bottom.png) |
| 受控大字号表单 | [选择](assets/i05-profile-f0ea601-320/controlled-profile-selections.png)、[保存](assets/i05-profile-f0ea601-320/controlled-profile-save.png)、[末屏](assets/i05-profile-f0ea601-320/controlled-profile-bottom.png) |

共16张原始PNG，含未列出的编辑顶部／末屏和受控顶部；逐项检查选择项、主要按钮和末屏留白。
第一批390px自动化未等待新县区列表，断言失败，未作为通过；后续等待实际页面刷新才捕获完整320px。

## 适用检查

- 受影响契约、UI、登录、page-gate、标准包、档案实际页与 HTTP：121/121，通过。
- 新实际页用例12项：游标、保存重读、同键冻结重试、冲突重读、切账号／同token世代、离页／注销、401、非法目录、手选无定位及导航限制。
- 最终夹具修改后，档案页12项＋PGlite实际HTTP1项共13/13再次通过，语法／文档复核通过。
- 原生 PG17.11 新隔离库的同一实际前端 HTTP 用例通过；API Pool 为单独受限 LOGIN，max4，五种高权标志均false。建库／迁移／装夹具由测试操作员连接完成，业务 API 不用它。
- PGlite 用例也通过，明确为串行SET ROLE替身，不代替原生 LOGIN。第二次用同集群新库尝试因全局 group role 已存在失败，未记通过；最终使用第二个新隔离集群通过，fixture 增加新集群前置校验，不改已审角色 SQL。
- 原登录 HTTP11组通过；lint／TypeScript／仓库卫生、工程路由／JS语法、文档链接／27项映射、diff 检查通过。API/admin源未变，复用已合构建结果。
- 当前微信源码实际320px编译运行及受控字号PASS；GitHub CI以发布HEAD为准，不批准Fork工作流。

```powershell
node --test tests/unit/miniprogram-profile.test.mjs tests/integration/profile-ui-http.test.mjs
# 默认 PGlite；原生模式仅允许新空 loopback gy_i05_ui_test_* 库与全新测试集群，
# GY_PROFILE_UI_TEST_OWNER_URL 由测试操作员在进程环境安全注入，不写入源码或证据。
node tests/integration/local-dev-profile-ui.cjs "<official SDK directory>" "<output>" 9423 320
```

微信命令前提：本地实际 API／受限 PostgreSQL、对应标准导入工程和自动化端口。
本轮只读已有程序位置 `C:/Users/MR/.codex/worktrees/94b2/COC/.local/pg17-window/runtime/pgsql/bin`，
建立自己的新测试库，不复用旧库／凭据。没有供应商请求、付费调用或服务器部署。

Android 真机、真实微信服务器身份、生产目录与正式网络尚未验；定位转换资源及权限失败路径待后续。
iOS本阶段暂缓，不标通过；#5／#23／#28继续开放。请求监工固定发布HEAD独立验手选组件与权限范围。
