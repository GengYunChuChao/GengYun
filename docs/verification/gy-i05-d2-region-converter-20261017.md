# GY-I05 D2 定位→地区转换资源装配（region-converter） — 收口证据（20261017）

- 任务：**GY-I05**（issue **#5**，`Refs #5`，**不关闭整项**）。本页只覆盖 D2 切片（把 `regionConverter: null` 硬编码改为可注入模块）；同任务历史证据见 [gy-i05-region-profile-20261014](gy-i05-region-profile-20261014.md)。
- 工作区：`GengYun_W05d2`，分支 `feat/gy-i05-region-converter`；**未 push**（提交由指挥推送）。
- 基线：`upstream/main = 1480aab`（`1480aab3383b16daf7a5b5088c3e21cc12c422d3`）。
- 本轮代码 HEAD：`eab77ee`（`eab77ee535a2602ff9d8eac95d5f6fd20fb61be1`）；证据页自身提交紧随其后。`git merge-base HEAD upstream/main` 等于上述基线（无分叉）。

## 0 结论摘要

| 项 | 结果 |
| --- | --- |
| `regionConverter: null` 硬编码 | **已取得**（改前 `profile.js` 1 处命中 → 改后 0 处，改由 `regionConverterResource.build()` 注入） |
| 坐标→地区转换资源（U3） | **未取得**（截至 2026-10-17 仓库与本机均无可追溯来源含许可的浙江县区质心/边界几何数据；生产默认如实回落手选，见 §4） |
| 资源缺失 fail-closed | **已取得**（`build()` ⇒ `null` ⇒ 页面文案逐字 `地区转换资源尚未接入，请手选浙江市县。`，单测与真回环双钉） |
| 原始坐标只在内存 | **已取得**（哨兵坐标不出现于 storage／请求体／路由；保存 body 键集恰为 `crop_id`／`region_code`／`region_catalog_version`） |
| 六档文案闭集 | **已取得**（`miniprogram/utils/location-region.js` 本片零 diff，未放宽） |
| #5① Android／iOS 真机授权与拒绝路径 | **未取得**（属 D3，需人工真机；本片不涉及，不得据本页声称补上） |

## 1 改动清单与装配

```text
$ git diff --stat upstream/main...HEAD
 miniprogram/pages/profile/profile.js             |  11 +-
 miniprogram/utils/region-converter.js            | 142 ++++++++++++++++++++
 tests/integration/local-dev-profile-location.cjs |  39 ++++++
 tests/integration/profile-ui-http.test.mjs       |  42 ++++++
 tests/local-debug.test.mjs                       |   2 +
 tests/unit/miniprogram-location-region.test.mjs  | 164 +++++++++++++++++++++++
 tests/unit/miniprogram-login-return-to.test.mjs  |   3 +
 tests/unit/miniprogram-profile.test.mjs          |  80 ++++++++++-
 tools/prepare-wechat.mjs                         |   4 +
 9 files changed, 481 insertions(+), 6 deletions(-)
```

| 提交 | 内容 |
| --- | --- |
| `f7fe9c8` | `feat(GY-I05): 定位→地区转换资源装配为可注入模块，资源缺席即 fail-closed (Refs #5)`：新增 `miniprogram/utils/region-converter.js`，`profile.js` 去掉 `regionConverter: null` |
| `d1de080` | `test(GY-I05): 定位→地区转换的单元与回环证据（资源逐条校验 + 真页面装配） (Refs #5)` |
| `eab77ee` | `test(GY-I05): 把 region-converter 登记进小程序打包允许清单并留资源占位注释 (Refs #5)`：`tools/prepare-wechat.mjs` 与 `tests/local-debug.test.mjs` 同一清单 |

装配：页面定义期调用 `regionConverterResource.build()`；`build()` 内部 `loadModule('../data/region-centroids.js')` 失败（当前必然失败：该文件不存在）即返回 `null`，`location-region.locate` 见 `convert` 非函数 ⇒ `unavailable`。资源就位后**无需改页面或本模块**即自动接线；但须先过 `inspect()` 逐条校验，不合规仍 fail-closed。

## 2 门禁与测试（本轮实跑，原始输出）

| 门禁 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 静态与卫生 | `npm run lint` | 0 | PASS tsc services/api；PASS tsc apps/admin；PASS 仓库卫生扫描 |
| 契约状态 | `node tools/verify-contract-status.mjs` | 0 | 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条 |
| 文档 | `npm run test:docs` | 0 | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| 单元 | `npm run test:unit` | 0 | tests 2361 / pass 2360 / fail 0 / skipped 1 |
| 小程序打包 | `npm run test:mini`（非派单门禁；因改打包允许清单而跑） | 0 | tests 5 / pass 5 / fail 0 |
| 回环 HTTP | `npm run test:integration:http` | 1 | 前 10 步全 PASS；末步 `tts-http` 的 S01 红（`tests/integration/tts-http.mjs:808`；主干自身红、修复片 PR #236，本片 `services/api/src/app.ts` 零 diff） |

本片在回环链内的读数：`PASS GY-I05 D2 loopback: fail-closed unavailable without resource; injected converter preselects a real catalog county; raw coordinates stay in memory`（`tests 1 / pass 1 / fail 0`）。

### 2.1 单元证据

- `tests/unit/miniprogram-location-region.test.mjs`：资源不合规 18 条逐条不接线；合规合成资源（坐标 `27.9+i*0.05`／`119.9+i*0.05`，注释明示非真实质心）接线后返回的 `region_code` 同时经 `miniprogram/data/regions.js` 与 `packages/knowledge/catalog/regions-zhejiang.json` 校验（不硬编码期望值）；越距 ⇒ `null`；7 种非法入参 ⇒ 不接线且不抛。
- `tests/unit/miniprogram-profile.test.mjs`：静态核对页面无 `regionConverter: null`；资源缺席时 `page.regionConverter === build() === null`；合成资源下真页面装配可预选 `330102`，未确认时 PUT 计数 0，确认后 PUT 1 且 body 键集恰为契约三键。

### 2.2 真页面回环证据（`tests/integration/profile-ui-http.test.mjs`）

- 资源缺席支：哨兵坐标 `27.1234/119.5678`（合成长坐标，非任何真实质心）经注入的 `wx.getLocation` 进入；message 逐字等于 `MESSAGES.unavailable`；`getLocation` 恰调用一次且 `type='wgs84'`；不预选；哨兵值不出现在任何 storage 值、任何请求体与任何路由记录中。
- 正控制支：注入 `() => '330102'` 后按定位预选真目录县区，`onSave` 的 body 键集恰为 `['crop_id','region_catalog_version','region_code']` 且 `region_code` 在目录内（双源交叉校验）。

`tests/integration/local-dev-profile-location.cjs` 亦已扩等价断言（静态无 `null` + 真页面 `build()` 装配），但该脚本需微信开发者工具 automator，**本机三处候选路径均不存在 ⇒ 本轮未真跑**，故以链内 `profile-ui-http.test.mjs` 作为实际回环证据。

## 3 未取得项与风险

- U3（浙江县区几何资源）未取得，见 §4；生产默认仍是如实回落手选。
- #5① 真机授权/拒绝路径未取得（D3，人工真机）。
- `tests/integration/local-dev-profile-location.cjs` 的扩写未真跑（本机无 automator）。
- 风险：`inspect()` 只做**结构级**校验，无法证明未来放入的资源数据本身正确；该风险必须在资源就位时由来源审查与数据校验补上。

## 4 资源来源结论（U3）

- 仓库现有的唯一行政区资源是**字典**而非几何：`packages/knowledge/catalog/regions-zhejiang.json`（来源＝民政部《2023年中华人民共和国县以上行政区划代码》，`mca-xzqh-2023`，102 条／90 县区）与其小程序只读副本 `miniprogram/data/regions.js`，两者均无质心或边界坐标。
- `miniprogram/data/region-centroids.js` 不存在；仓库与本机均未找到可追溯来源（含许可）的浙江县区几何数据 ⇒ **如实不内置任何坐标**，`build()` 返回 `null`。
- 因此本页延续 `gy-i05-region-profile-20261014.md` 的结论：坐标→地区转换资源 **未取得**；本片交付的是「资源存在即接线、缺省即 fail-closed」的装配与显式 U3 登记，不是转换能力本身。
