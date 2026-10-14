# 原生小程序 Demo UI 组件

本页接续 #28 / PR #136 的 Demo 色板、28 个本地图标、公共 WXSS、五 Tab 和 `pages/specimen/specimen` 样张。视觉参考是 [demo.html](demo.html) 的**手机预览**；桌面侧栏、宽屏多列和按钮 40px 高度不移植到手机。组件只有呈现和事件，不读取 API、身份或资料。`state-view` 沿用现有组件，`ready` 状态由调用页展示正常内容。

## 对应关系

| Demo 手机形态 | 小程序资产 | 接口 |
| --- | --- | --- |
| `.btn` / `.btn.primary` / `.btn.lime` / `.btn.ghost` / `.btn.danger` | `components/gy-ui-button` | `label`、`variant=secondary\|primary\|lime\|ghost\|danger`、`block`、`disabled`、`loading`；可用时 `bindtap` |
| `.panel` / `.article-card` 的白色面板 | `components/gy-ui-card` | `title` 可选；默认 `slot` 放任意内容 |
| `.chip` / `.chip.active` | `components/gy-ui-chip` | `label`、`value`、`selected`、`disabled`；`bindselect` 的 `detail={value,selected}` 是建议的新状态，调用页自行更新 |
| `.search-box` | `components/gy-ui-search` | `value`、`placeholder`、`disabled`；`bindinput`、`bindconfirm`、`bindclear` 的 `detail.value`；调用页必须回写 `value`，组件不持有查询逻辑 |
| `.empty` 及加载／失败 | 既有 `components/state-view` | `status=empty\|loading\|error`、`title`、`desc`、`actionText`、`busy`；`bindaction` 由调用页决定是否重试 |
| 手机底部导航 | 既有 `custom-tab-bar` | 继续使用已有五 Tab、居中识别、路由和登录守卫；组件库不重写导航 |

主色 `#176b50`、文字 `#17352b`、辅助 `#7b8983`、纸色 `#f5f7f4`、线条 `#e5ebe5`、浅绿 `#c6f17b` 均取自 Demo，已在 `styles/tokens.wxss` 定义。组件用独立 `gyui-` 类和 `styleIsolation: 'isolated'`；内部使用这些 CSS 变量及同值兜底色。`gy-ui-search` 局部引入既有 `styles/icons.wxss` 的 `gy-icon--search`，无新图片、CDN 或表情图标。宿主页通过 `app.wxss` 获得 `page` 令牌；在 `.page` 上放 `--font-scale` 时，普通 DOM 与组件内 `calc()` 共同继承字号变量。组件属性和事件也能在未加载公共类的页面工作，但建议统一导入 `app.wxss` 的宿主规则。

在页面 JSON 注册：

```json
{"usingComponents":{"gy-ui-button":"/components/gy-ui-button/gy-ui-button","gy-ui-card":"/components/gy-ui-card/gy-ui-card","gy-ui-chip":"/components/gy-ui-chip/gy-ui-chip","gy-ui-search":"/components/gy-ui-search/gy-ui-search","state-view":"/components/state-view/state-view"}}
```

组合示例（调用页的数据为 `query`、`filter`、`status`，这里只示意呈现，不代表查询已接通）：

```xml
<gy-ui-card title="资料查询">
  <gy-ui-search value="{{query}}" placeholder="搜索资料" bindinput="onQueryInput" bindconfirm="onQueryConfirm" bindclear="onQueryClear" />
  <gy-ui-chip label="全部" value="all" selected="{{filter === 'all'}}" bindselect="onFilterSelect" />
  <gy-ui-button label="查询" variant="primary" block="{{true}}" disabled="{{status === 'loading'}}" bindtap="onSearch" />
</gy-ui-card>
<state-view wx:if="{{status === 'empty' || status === 'loading' || status === 'error'}}" status="{{status}}" actionText="{{status === 'error' ? '重试' : ''}}" bindaction="onRetry" />
```

`onQueryInput` 回写 `event.detail.value` 到 `query`，`onQueryClear` 回写空串，`onFilterSelect` 回写 `event.detail.value` 到 `filter`。`confirm` 来自键盘搜索键。`gy-ui-button` 的禁用／加载状态由原生 `button` 阻断，组件事件处理器也守卫；`gy-ui-chip` 禁用时不发选择事件。调用页负责真实查询、权限、失败和状态转换，不在组件里虚构结果。

## 本地原生预览

现有 `pages/specimen/specimen` 最后一节前已接入以上四组件，含受控输入、筛选、正常／加载／空／失败／重试样张。它沿用既有 local-only 门禁：共享 runtime 为 `disabled` 时只显示失败说明，隔离 `tools/prepare-wechat.mjs local` 工程才显示样张。原有首页入口与打包清单保持这项限制；这里没有新页面或业务路由。

在仓库根目录准备隔离工程并用微信开发者工具打开：

```powershell
if (!(Test-Path config/debug.local.json)) { Copy-Item config/debug.local.json.example config/debug.local.json }
node tools/prepare-wechat.mjs local --config config/debug.local.json
& "D:\微信web开发者工具\cli.bat" open --project .\.local\wechat-local
```

首次在隔离工程打开 `pages/specimen/specimen`，用 320px 和 375px 视口检查搜索输入、chip、按钮、四状态及最底部标记。Demo 手机正文常为 11–14px，小程序已有公共层把正文抬到 16／18px，并以 44px 触控下限、`--font-scale` 和底部安全区优先；本次组件沿用这些取舍，chip/清除文字仍按公共层 14px，按钮和输入 16px，不重置全局字号。模拟器截图只证明模拟器，Android 真机需另验。

## 本轮验证（2026-10-14）

- Node 24.16.0：`node --test tests/demo-ui-components.test.mjs tests/local-debug.test.mjs`，7/7 通过。覆盖禁用／加载按钮不发事件、chip 受控选择、search 输入／确认／清除及禁用守卫、样张宿主回写；local/release 隔离产品逐文件核对四组件的 JS／JSON／WXML／WXSS 与源码一致。
- `node tools/check-wechat-project.mjs` 通过原生 JSON／路由／共享域名校验和 JS 语法检查；这不是微信编译或渲染结果。`git diff --check` 通过。
- 微信 CLI `auto --project <本工作树绝对路径>/.local/wechat-local --auto-port 9420` 成功，IDE 服务启动、正确工程打开并启用自动化。首次沙盒因工具自身 `.cli` 写入 EPERM 失败，限定本工程的权限重试成功。CLI 成功不证明样张组件已完成编译或正确渲染；未取得可核验的编译诊断、样张模拟器截图或 SDK 运行结果。
- 既有 `tests/ui-demo-align.test.mjs` 在 Windows 工作树出现图标全文比较失败：`icons.wxss` 有 55 个 CRLF，而 HEAD 的 Git blob 为 LF；只读归一化后工作树、HEAD blob 和生成全文完全相同。色板与 104 条映射通过。保持图标和核对工具原样，记录这一基线换行误报，不把原始失败宣称为通过。
- 待验：组件在微信中的实际编译／渲染、320px／375px、放大字体、末屏安全区与 Android 真机操作。本片仅交付可注册组件及本地样张，不代表 #28 全部前端验收完成。
