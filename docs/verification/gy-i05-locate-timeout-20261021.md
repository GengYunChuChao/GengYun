# GY-I05 定位挂起兜底超时与手选清单同源 — 证据（20261021）

- 任务：**GY-I05**（issue **#5**，`Refs #5`，**不关闭整项**）。本页覆盖两片：① 定位请求挂起时的显式超时状态；② 手选地区／作物清单的可追溯性校验。同任务历史证据见 [gy-i05-region-profile-20261014](gy-i05-region-profile-20261014.md)、[gy-i05-d2-region-converter-20261017](gy-i05-d2-region-converter-20261017.md)。
- 工作区：`E:\GengYunCommander\wt-c3-region`，分支 `feat/gy-r28-c3-region-profile`；**未 push**（提交由指挥推送）。
- 基线：`43fa6d5`（`43fa6d5` 为本分支基点，`git merge-base HEAD 43fa6d5` 等于该点）。
- 本轮代码 HEAD：`6dda61e`（`6dda61ec3cccc5384f825aeb3eca3c0422a9b7bf`）；证据页自身提交紧随其后。
- 契约零改动：`packages/contracts/**`、`openapi.json`、`contract-status.json`、`.github/**` 本轮 **零 diff**；未新增 `ErrorCode`，未加迁移。

## 0 结论摘要

| 项 | 结果 |
| --- | --- |
| AC21「超时」是否可达（改前） | **不可达**：`wx.getLocation` 被系统弹窗挂起或回调被吞时既不 `success` 也不 `fail`，Promise 永不结算 ⇒ 页面停在「正在获取位置…」，定位入口长期不可再点 |
| AC21「超时」是否可达（改后） | **已取得**：15s 墙钟兜底结算 `{status:'timeout'}`，走既有文案 `定位超时，可继续手选浙江市县。`，手选与保存不受影响 |
| 迟到回调不改写已结算状态 | **已取得**：先到先结算；超时后平台迟到的 `success` 不会改判成功、`fail` 不会改判取消 |
| 兜底是否引入新契约面 | **否**：端点、错误码、存储、上报全部不变；坐标仍只在内存 |
| 手选清单可追溯性校验 | **已取得**：小程序侧副本按 `packages/knowledge` 独立重算逐字比对，变异反例（塞入未登记县区／漏字段／改版本／换顺序／去生成声明／改地名）全部判红 |
| #5① Android／iOS 真机授权与拒绝路径 | **未取得**（需人工真机，见 §4） |

## 1 改动清单

```text
$ git diff --stat 43fa6d5..HEAD
 miniprogram/utils/location-region.js              |  51 ++++++++-
 tests/unit/miniprogram-location-region.test.mjs   | 129 ++++++++++++++++++++++
 tests/unit/miniprogram-profile.test.mjs           |  54 ++++++++-
 tests/unit/profile-region-catalog-source.test.mjs |  92 +++++++++++++++
 4 files changed, 321 insertions(+), 5 deletions(-)
```

| 提交 | 内容 |
| --- | --- |
| `febb1fd` | `fix(GY-I05): 定位请求挂起时兜底为显式超时状态，超时后回落手选 (Refs #5)` |
| `6dda61e` | `test(GY-I05): 钉住手选清单同源——地区/作物副本独立重算逐字比对 + 变异反例 + 生成工具 --check (Refs #5)` |

实现要点（`miniprogram/utils/location-region.js`）：

- 新增 `LOCATE_TIMEOUT_MS = 15000` 与 `defaultTimer()`；`locate(wxApi, convert, settings)` 增加可选 `settings`（`timeoutMs`、`timer`），缺省值即 15s、缺省计时器即全局 `setTimeout`；`timer: undefined` 走缺省，`timer: null` 表示不设兜底（保留改前行为，供既有用例与显式装配）。
- 兜底先于 `getLocation` 安装：平台同步回调也由 `settled` 挡住，随后 `finish()` 清计时器，不留悬挂计时器（`handle.unref?.()` 在 Node 侧兼容）。
- 只多「超时」这一档**来源**，不改状态闭集（`denied`／`cancelled`／`timeout`／`outside`／`failed`／`ok` 与 `MESSAGES` 文案均未增删改）；`LOCATE_TIMEOUT_MS` 仅为新增导出常量。

## 2 门禁与测试（本轮实跑，原始读数）

| 门禁 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 静态与卫生 | `npm run lint` | 0 | `PASS tsc services/api`／`PASS tsc apps/admin`／`PASS 仓库卫生扫描` |
| 契约状态 | `node tools/verify-contract-status.mjs` | 0 | 覆盖 112 条；已装配 108；implemented 13 / partial 95 / planned 4；形状错误 0、语义错误 0 |
| 相邻单测 | `node --test tests/unit/miniprogram-location-region.test.mjs tests/unit/miniprogram-profile.test.mjs tests/unit/profile-api.test.mjs tests/unit/profile-pagination.test.mjs tests/unit/profile-log-redaction.test.mjs tests/unit/local-profile-bootstrap.test.mjs` | 0 | tests 80 / pass 80 / fail 0 |
| 新增单测 | `node --test tests/unit/profile-region-catalog-source.test.mjs` | 0 | tests 4 / pass 4 / fail 0 |
| 全量单测 | `npm run test:unit` | 0 | tests 3199 / pass 3198 / fail 0 / skipped 1 |
| 回环 HTTP（真页面） | `node tests/integration/profile-ui-http.test.mjs` | 0 | tests 2 / pass 2 / fail 0；含 `PASS GY-I05 D2 loopback: fail-closed unavailable without resource; injected converter preselects a real catalog county; raw coordinates stay in memory` |
| 小程序打包 | `npm run test:mini` | 0 | tests 6 / pass 6 / fail 0 |
| 文档 | `npm run test:docs` | 0 | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |

补充：全量单测首跑曾在 `tests/unit/release-materials-index.test.mjs:145` 红一次（报错里 `pid: 0`、`output: null`，即子进程未产出），该文件单独跑 5/5 绿、紧接着重跑全量 3199 条 0 红 ⇒ 判为并行负载下的偶发，与本轮改动（`miniprogram/utils` + 两个单测文件）无交集；不是本片引入，也不代表已修复该偶发。

### 2.1 超时兜底的单元证据（`tests/unit/miniprogram-location-region.test.mjs`）

- 平台永不回调：注入假计时器与 `getLocation` 不回调，到点后结果为 `timeout`，`MESSAGES.timeout` 可达，`getLocation` 恰调用一次。
- 迟到回调不改写：超时后补发 `success`／`fail`，结果仍是 `timeout`。
- 先到先结算：平台成功／失败立即清掉兜底计时器，其后到点不产生第二次结算。
- 时长与计时器可注入：非法 `timeoutMs` 退回模块常量；`timer: null` 回到改前行为。
- 既有分支不受影响：`wxApi` 缺失仍立刻 `failed`，且不残留计时器。

### 2.2 真页面证据（`tests/unit/miniprogram-profile.test.mjs`）

- `location hung platform recovers to an explicit timeout state and manual selection still saves`：挂死的平台对象下页面进入显式超时状态，手选后仍可保存（PUT 计数与 body 闭集按既有断言）。
- `location hung platform then late permission grant never rewrites the settled timeout state`：超时后迟到的授权回调不改写已结算状态。

### 2.3 清单同源证据（`tests/unit/profile-region-catalog-source.test.mjs`）

- 独立实现重算 `packages/knowledge/catalog/regions-zhejiang.json` 的投影（仅 `code`／`name`／`parent_code`，附 `schema`／`catalog_version`／`region_count`），与 `miniprogram/data/regions.js` **逐字比对**；再核版本 `mca-xzqh-2023`、条数与来源声明一致、代码唯一且形如 `^33[0-9]{4}$`、`parent_code` 均可解析、根节点恰 1 个。
- 变异反例：塞入未登记县区、漏 `name`、改 `catalog_version`、整体换序、去掉生成声明、改地名，六种漂移全部判为不同步（正控制同时成立）。
- 作物侧：`miniprogram/data/crops.js` 与 `packages/knowledge/catalog/crops.json` 全等且为 4 类（`crop_rice`／`crop_corn`／`crop_soybean`／`crop_rapeseed`）；`services/api/src/profile/service.ts` 判定闭集时读同一两份 JSON，且无手抄地区代码常量。
- 工具自检：`node tools/knowledge/build_miniprogram_data.mjs --check` 退出 0，输出 `OK：miniprogram/data 与 packages/knowledge 契约一致`。

## 3 #5 验收点现状与依据

| # | 验收点（issue #5 原文） | 现状 | 依据 |
| --- | --- | --- | --- |
| ① | Android／iOS 授权和拒绝路径可用，手选不依赖定位 | **未取得**（真机）；代码与回环层面六档状态齐备、拒绝／取消／超时／省外均回落手选 | `miniprogram/utils/location-region.js` `MESSAGES` 六档；`tests/integration/profile-ui-http.test.mjs`（真页面 + 注入 `wx.getLocation`）；本页 §2.2 |
| ② | 修改档案不改写已保存识别、来源或后续实际记录快照 | 已取得 | `tests/unit/profile-api.test.mjs:302`（非 user 角色先拒、档案编辑后记录表 byte-identical）；`services/api/src/profile/service.ts:92-96`（只写 `public.single_profiles`） |
| ③ | 游客不可修改他人或登录用户档案 | 已取得 | `services/api/src/routes/profile.ts:25`、`:29`（`guards.requireUser`）；`services/api/src/profile/service.ts:31`（角色）、`:35-43`（账号/会话/`auth_epoch` 校验）、`:67`／`:84`／`:92`（一律以 `identity.userId` 读写）；`tests/unit/profile-api.test.mjs:263` |
| ④ | 首版地区只筛选静态科普，不产生真实地区预警 | 已取得（引用层面） | `tests/unit/miniprogram-profile.test.mjs:134`（`MESSAGES` 序列化后不含「预警」）；无预警路由/任务（契约台账 4 条 #5 操作内无预警面） |
| ⑤ | 定位仅即时选择地区，服务端不接收原始坐标；拒绝、取消、超时、省外与手选能继续 | 已取得（超时一档为本轮补齐） | `services/api/src/routes/profile.ts:24-33`（querystring／body `additionalProperties: false`，闭集为 `crop_id`／`region_code`／`region_catalog_version`）；`tests/unit/profile-api.test.mjs:281-282`（body/query 带坐标被拒）、`:338`（库内无坐标列）、`:379`；`tests/integration/profile-ui-http.test.mjs`（哨兵坐标不进 storage／请求体／路由） |

契约台账口径（`docs/architecture/contract-status.json`，`node tools/verify-contract-status.mjs` 实跑）：`getProfile`／`putProfile`／`listCrops`／`listRegions` 四条均为 `implemented`；全仓 implemented 13 / partial 95 / planned 4（partial／planned 属其他任务，本轮未动）。#5 的缺口不在契约操作层，而在真机证据与（历史登记的）U3 坐标→地区资源。

## 4 未取得项与待裁决

- **#5① 真机授权与拒绝路径**：需 Android／iOS 真机权限流程证据，本机与自动化链均不能替代。仍按 issue 要求记为未取得。
- **U3 坐标→地区转换资源**：延续 [gy-i05-d2-region-converter-20261017](gy-i05-d2-region-converter-20261017.md) 的结论——仓库内只有行政区划**字典**、无质心／边界几何，`regionConverter.build()` 返回 `null`，生产如实回落手选。本轮不内置任何坐标，不伪造资源。
- **超时时长取值 15000ms**：属实现选择而非契约条款；若后续需要按机型／网络分档，应先有真机数据再改，届时只需传 `settings.timeoutMs`，页面与状态闭集不动。
- **待裁决（需指挥／监工决定，本轮未做）**：页面是否需要把「超时」与「平台无回调的挂死」在 UI 上区分为两条文案。当前刻意共用既有 `timeout` 文案，以不扩充文案闭集；若要求区分，需先确认文案归属（前端文案 vs 契约），再动手。
- 风险：兜底只能覆盖「平台不回调」，不能覆盖「平台回调了错误坐标」——后者仍依赖 U3 资源与来源审查。

## 5 隐私与坐标边界（本轮自证）

- 兜底路径只结算状态，不读、不传、不存坐标；`locate` 返回值仍只含 `status` 与可选 `region_code`。
- 无新增日志：本轮未加任何 `console.*`／埋点；`tests/unit/profile-log-redaction.test.mjs` 随相邻单测跑绿。
- 无同意不上报：未新增任何网络调用，端点与请求体闭集不变。
