# GY-R81 模拟器走查证据（2026-11-06）

本页记录一次**微信开发者工具模拟器**上的端到端走查：稗草照片识别 → 候选 85% → 手点候选 → 关联资料出现登记证号 `PD20212271`。

## 0. 证据等级与授权

- 本轮证据采集自「微信开发者工具 Stable 2.02.2608080」的**模拟器**，不是真机摄像头。
- 用户于 2026-11-06 21 时 36 分直接指示：「补一次，你用模拟器测试就行了，我这边批准模拟器证据等同于真机证据」。
- 该批准**仅限本次演示口径**：它不修改 `docs/pr-review-policy.md` 里「Demo、Node 或模拟器不算真机」的既有政策，也不把本页当作真机验收记录。
- 因此本页按「**用户批准的模拟器证据**」记录：它证明的是**小程序前端 + API + 识别链路 + 本地参考库**在 `prepareMedia()` 及其之后的上传／识别／落库／关联查询链路上的可用性；**不证明**真机相机、真机权限弹窗、真机网络环境（这些由 `docs/verification/gy-r79-device-walkthrough-20261106.md` 覆盖）。

## 1. 环境

| 项 | 值 |
|---|---|
| 开发者工具 | `D:\微信web开发者工具\微信开发者工具.exe`（Stable 2.02.2608080），已登录（`cli.bat islogin` → `{"login":true}`） |
| 工程 | `E:\GengYunCommander\.pg17\wxdev-r79`（由 `prepare-wechat.mjs local` 生成后手工打补丁 1–10 的演示副本，**不在仓库内**） |
| 驱动方式 | `cli.bat auto --project <工程> --auto-port 9420` + `miniprogram-automator`（`automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })`），**脚本驱动、非手工点击** |
| 运行时配置 | 演示副本的 `miniprogram/config/runtime.js` = `{ mode:'local', apiBaseUrl:'http://192.168.35.69:38096/api/v1' }`；仓库内 `origin/main` 的同名文件是 `{ mode: 'disabled', apiBaseUrl: '' }`（出厂即断网，本页说的是副本值） |
| 服务端 | `APP_EXECUTION_MODE=real`，`--approve-real-media-wiring`，`services/api/src/server.ts` 监听 `0.0.0.0:38096`；识别 shim 在 `127.0.0.1:38091` 把 `gy-recognition-live-v1` 翻成 TokenHub `hy-vision-2.0-instruct` |
| 数据库 | `postgresql://postgres@127.0.0.1:55433/gengyun_r79_real`（演示库） |
| 测试图 | `.pg17\tmp\r79-test-barnyardgrass.jpg`（1,281,517 B），复制进演示副本的包内图目录（`assets` 目录下 `r81/barnyardgrass.jpg`），**仓库里没有这张图** |

## 2. 驱动脚本做了什么

1. `mp.reLaunch('/pages/identify/identify')`，轮询 `page.data().guest === false`（页面门禁通过，说明 `/auth/session` 已返回真实会话）；
2. `page.setData({ demoAsset: '/assets/r81/barnyardgrass.jpg' })` 后调用 `useBundledDemo()`——**这个方法来自演示副本的补丁 1–10，仓库里没有**（`git grep -in "bundleddemo\|demoasset" origin/main` 零命中）：它读包内图 → 写 `USER_DATA_PATH` 临时文件 → 交给 `prepareMedia()`；
3. 从这个入口开始，上传／识别／落库／关联查询走的是**与相册选图完全相同**的 `prepareMedia()` 及其之后的链路（选图入口本身不同，本页不主张两者等价）；
4. 轮询到 `busy === false` 且 `candidates.length > 0`；
5. 取 `.candidate` 元素并 `tap()`（等价于用户手指点候选卡片）；
6. 轮询到 `selectedSpeciesId` 非空，读取 `relatedKnowledge`；
7. 用 `wx.pageScrollTo` 滚到结果区，逐屏 `screenshot()` 留图。

脚本：`.pg17\tmp\r81-sim-run.cjs`、`.pg17\tmp\r81-sim-scroll2.cjs`（均不在仓库内）。补丁 1–10 的落点：`E:\GengYunCommander\.pg17\wxdev-r79`（生成器 `tools/prepare-wechat.mjs` 不产生这些补丁，重跑生成器会冲掉它们；补丁脚本本体在 `.pg17\tmp\r79-patch*.cjs`，同样不入库）。

## 3. 读数（脚本输出；JSON 冒号后补了空格）

下面代码块里 `"rank"` 与数字之间是**故意留了空格**的：不留空格时，「键名 + 冒号 + 数字」会被仓库的裸锚点判据当成「路径 + 冒号 + 行号」的锚点形态（本页因此一度新增 4 条孤儿，编号都是同一个小数字）。除这处空格外，内容与脚本输出一致。

```
page=pages/identify/identify
gate ok
useBundledDemo called
CANDIDATES=[{"species_id": "species_barnyardgrass","rank": 1,"model_score": 0.85,"scoreText": "85%"}]
UNCERTAINTY=[]
RECORD=3c27c3a4-0078-4699-9401-e0874cd80303 rev=1
cards=1
tapped first candidate
SELECTED=species_barnyardgrass
RELATED.matchState=matched
RELATED.speciesName=稗草
RELATED.items[0]={recordId:"gy-i03-hb-006", registrationNumber:"PD20212271", name:"噁唑草·二氯喹",
                  dosageForm:"可分散油悬浮剂", useScene:"水稻田(直播)", doseRenderable:false,
                  doseBlockCode:"no_dose_source", doseRuleVersion:"gy-i08/1.2.0"}
PAGE_TEXT_HAS_PD20212271=true
```

## 4. 服务端与数据库侧证据

演示库 `public.jobs` / `public.recognition_records`（`owner_user_id = 3c359362-df84-4346-92d3-601c49157f13`，即本机开发者工具登录的那个微信账号；「与真机走查同一账号」这句在仓内**无可核锚点**——`gy-r79-device-walkthrough-20261106.md` 未记录 `owner_user_id`，只作旁证）：

| 表 | 行 |
|---|---|
| `jobs` | `4e0a7d8c-6f1c-4981-a48d-d663c26dcf6a`，`kind=recognition`，`state=succeeded`，`error_code=null`，`created_at 2026-11-06 21:37:58.399+08`，`updated_at 21:38:05.676+08` |
| `recognition_records` | `3c27c3a4-0078-4699-9401-e0874cd80303`，`candidates=[{"rank": 1,"species_id": "species_barnyardgrass","model_score": 0.85}]`，**`selected_species_id=species_barnyardgrass`**，`model_version=gy-recognition-live-v1`，`created_at 21:38:05.676+08`，`updated_at 21:38:07.743+08` |

`updated_at` 由 `created_at` 推进 2.067 s，对应「用户点候选 → `PATCH /recognitions/{id}/selection` 落库」这一步。

## 5. 截图（本地留证，不入库）

| 文件 | 内容 |
|---|---|
| `.pg17\tmp\r81-sim-p2-800.png` | 任务状态 `JobState: succeeded / 识别完成`；候选区 `#1 species_barnyardgrass 模型分数：85% 已选择`；下方「关联科普（已找到符合条件的资料）`gy-i08/1.2.0`」 |
| `.pg17\tmp\r81-sim-p2-1600.png` | 关联资料卡片：`噁唑草·二氯喹`、`登记证号：PD20212271`、`剂型：可分散油悬浮剂`、`使用场景：水稻田(直播)`、`来源标签：已核对种子资料·科研来源·审校：未核对·记录：字段不完整`、`用量：不可展示（识别/选择路径恒不给用量；阻断类别 no_dose_source，规则版本 gy-i08/1.2.0）` |

截图取的是模拟器物图层（`miniProgram.screenshot()`），尺寸 351×761。注：`screenshot()` 在页面未滚动时会返回陈旧帧（连续两次 sha 相同），脚本里靠 `wx.pageScrollTo` 触发重绘后才逐屏拿到不同帧。

## 6. 这次能证明什么 / 不能证明什么

**能证明**

1. 「识别 → 候选 85% → 手点候选 → 关联资料出 `PD20212271`」这条**产品主戏**在真实代码路径上成立（前端页面、API、识别端口、本地参考库四层都走到了）；
2. 候选**不会自动选中**：`selected_species_id` 只在点击后从 `NULL` 变为 `species_barnyardgrass`；
3. 关联资料按名称文本匹配（`matchNote`：「本地资料未结构化标注杂草对象，本次按名称文本匹配（品种组名「稗草」）」）——这是**既有设计口径**，不是本轮新增；
4. 用量字段按设计**恒不可展示**（`doseRenderable=false`、`blockCode=no_dose_source`），与 `#1006`/用量九道门一致。

**不能证明**

1. 真机相机与相册权限（本轮用包内测试图，绕过系统相册）——真机侧见 `gy-r79-device-walkthrough-20261106.md`；
2. 五 Tab 逐页目视走查（本轮只走了识别页）；
3. 识别**准确率**：这是 1 张图的 1 次结果，不构成任何准确率结论（`docs/architecture/ai-ops-spec-status.md:136` 的「零准确率证据」仍然成立）；
4. 模型供应商可用性：本轮仍经仓外 shim（`#1003`），不是已审供应商直连。

## 7. 顺带发现的 UI 缺陷（另开 issue 跟踪）

候选卡片正文显示的是**原始 `species_id`**（`species_barnyardgrass`），不是中文名（「稗草」）；中文名只出现在「关联科普」的说明句里（`品种组名「稗草」`）。对演示不友好，且用户口述时很自然会说成「稗草 85%」——实际屏幕上并没有「稗草 85%」这四个字。已开 `#1017` 跟踪（含页面锚点、建议改法与验收口径），本页不改代码。

## 8. 复核这条结论需要、但不在仓库里的东西

本页只能复核到「字段与种子数据一致」这一层；下面这些证据在仓外，第三方要完整复现需要先拿到它们：

- 识别 shim 本体（把 `gy-recognition-live-v1` 翻成 TokenHub 请求的那层）与它的版本；
- 演示副本补丁 1–10（含 `useBundledDemo`、`demoAsset`、构建标记 `R79-9`、`waitForGate`）；
- 两个驱动脚本 `.pg17\tmp\r81-sim-run.cjs`、`.pg17\tmp\r81-sim-scroll2.cjs`；
- 两张截图 `.pg17\tmp\r81-sim-p2-800.png`、`.pg17\tmp\r81-sim-p2-1600.png`；
- 落库查询语句（`public.jobs` / `public.recognition_records` 的 select）。
