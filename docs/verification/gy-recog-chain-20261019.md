# GY-I09/I16 识别入口链路端到端验收（2026-10-19）

**范围口径**：本片主体按真实 AC 收窄为 **`GY-I09`（实时拍草识别）** 与 **`GY-I16`（收藏与识别历史）**；提交信息带 `Refs #6 #8 #9 #10 #16`，但 `#6`/`#8`/`#10` 的 AC **本链路一条也不覆盖**，逐条列在 §1.1（均判「未取得」）。逐 AC 判定见 §1.1，未取得/不成立项见 §6。

本页记录**一条真实 HTTP 链路**的本机实测：上传识别（合成 `media_id` + 替身提供者）→ 拿结果 → 看可信度与理由 → 加入识别历史 → 从历史读回 → 跨用户隔离 → 删除历史 → 再读为空 → 重放语义。
脚本：[`tests/integration/recognition-chain-e2e.mjs`](../../tests/integration/recognition-chain-e2e.mjs)（本片唯一新增的可执行交付物，已接进 `package.json` 的 `test:integration:http` 链，见 [`package.json`](../../package.json)）。

## 1 结论

- 链路**在 API 层跑通**：两条臂（内存存储 / 真实 PG17 存储）跑**同一段**断言，全部通过，退出码 0。
- 真库臂实测：`SHOW server_version` = `17.11`；应用迁移 `0001` + `0018`（重复应用 no-op）；`GET /api/v1/history` 读到的行与真库 `history` 表行逐字段对得上（另开一条独立 `pg.Client` 直查）；删除后 `SELECT count(*) FROM history` = 0；`history_idempotency` 台账 2 行。
- 边界（必须先读）：**本页证明 API 层链路；微信工具／真机证据未取得。** 真实 OCR 供应商**未取得**（仓内无凭据，`real` 模式 fail-closed）；本页所有输入都是**合成**的，逐字列在 §3。
- 本片**不改**产品代码、契约、迁移、`miniprogram/**`；新增的第二个文件是 `package.json` 里**加一条**链成员（只加不删，见 [`tests/unit/ci-integration-chain-structure.test.mjs`](../../tests/unit/ci-integration-chain-structure.test.mjs) 的「冻结清单只增不减」口径）。

## 1.1 逐 AC 覆盖矩阵（本片判定）

判定口径：**成立** = 本片断言直接证明；**部分成立** = 只证到 API 层的一部分，剩余项见 §6；**不成立** = 基线实现不具备该能力（不是本脚本的缺口）；**未取得** = 需要本机没有的资源（凭据/真机/设备），或不在本链路范围（`#6`/`#8`/`#10`）。
「证据位置」里的 `:NN` 一律指 `tests/integration/recognition-chain-e2e.mjs` 的那一行。

| issue | AC 编号 | 本片判定 | 证据位置 |
| --- | --- | --- | --- |
| `#9` | AC1 实际服务调用有证据 | 未取得 | 无凭据；`real` 模式 `available:false`、上传 503 `PROVIDER_UNAVAILABLE`（fail-closed 不回退替身），本脚本全程 `execution_mode=stub`；见 §6 第 1 行 |
| `#9` | AC2 无可信分数不伪造高置信、候选少于 3 不补造 | 部分成立 | `:283`（**候选数恰为 2**：只断上界 `<=3` 挡不住「补造第 3 条」）、`:285`、`:289`、`:293`、`:297`、`:317`、`:321`、`:330`（无分数保持 `null`、`succeeded` 不得携带不确定原因）；「预设与用户手改不计准确率」未取得（需真实模型评估） |
| `#9` | AC3 任务归属与重试安全 | 部分成立 | `:257`、`:262`、`:439`、`:444`、`:449`（重放同一 job、他人 id 与不存在 id 404 同形）；「不能跳过 GY-I08」未取得（本链路不经药剂面） |
| `#9` | AC4 实现时运行第 6 节评估 | 未取得 | 替身提供者不产生真实识别质量，无评估读数；见 §6 |
| `#16` | AC1 他人不能读取私有历史 | 部分成立 | `:439`、`:444`、`:447`、`:449`、`:501`、`:503`（越权读/删与不存在 id 同形）；「旧收藏不恢复失效推荐资格」需收藏面，未覆盖 |
| `#16` | AC2 候选与人工选择分开、失败任务真实可见 | 部分成立 | `:298`（本片只证「识别结果不自带已选中」）；`:365`（`job_state=uncertain` 原样入历史，失败任务真实可见）；「人工选择独立记录且不回写 `candidates`/`model_score`」**本片未断言**（脚本未调用 `PATCH /recognitions/{id}/selection`），由既有单测 `tests/unit/recognitions-candidates-selection.test.mjs` 覆盖（非本片断言），见 §6 |
| `#16` | AC3 识别不自动转成已使用事实 | 成立（限 API 层） | `:349`、`:350`、`:298`（历史投影键集恰等 7 键、无 `owner_id`、无「已使用」字段） |
| `#16` | AC4 读取时重查对象权限及当前可见性 | 不成立 | `:357`：只披露 `reference_state=unavailable`，**没有在读取时重查对象权限与当前可见性**；缺 `/knowledge` 引用读面（待实现缺口见 §6） |
| `#6` | AC1 伪扩展名/超限/越权 URL/重复/取消 | 未取得 | 本链路不覆盖：只用替身 `media_id` 引用，这些边界由媒体域自身验收 |
| `#6` | AC2 原始位置／私人媒体不出现在公共列表或普通日志 | 未取得 | 本链路不覆盖：无真实媒体内容与普通日志面，该断言无从验证 |
| `#6` | AC3 音频编码与服务商适配真实核实 | 未取得 | 本链路不覆盖：无音频编码与供应商适配 |
| `#6` | AC4 未授权/伪后缀/超大/跨账号/重复提交/过期访问与 2MB 真实性能集 | 未取得 | 本链路不覆盖：无限额、跨账号媒体访问与真实性能集用例 |
| `#8` | AC1 至少 100 组登记／匹配／限制场景 | 未取得 | 本链路不覆盖：不涉及登记/匹配场景 |
| `#8` | AC2 未核对／不适用／禁用不得进入可执行建议或用量卡片 | 未取得 | 本链路不覆盖：无用量卡片与问答消费端 |
| `#8` | AC3 风险文字无绝对安全承诺、有功能关闭开关 | 未取得 | 本链路不覆盖：无风险文字渲染面 |
| `#8` | AC4 100 组登记／制剂／来源冲突用例全过 | 未取得 | 本链路不覆盖：无冲突用例与规则版本比对 |
| `#10` | AC1 模糊字段核对入口、同名不同制剂不静默匹配 | 未取得 | 本链路不覆盖：无 OCR 字段核对入口 |
| `#10` | AC2 校正前原始结果保留、手改不计准确率 | 未取得 | 本链路不覆盖：无 OCR 原始结果保留与校正面 |
| `#10` | AC3 冲突阻断用量卡片、服务失败／超时不伪造成功 | 未取得 | 本链路不覆盖：无登记冲突对用量卡片的阻断面（OCR 域超时语义由 `tests/integration/ocr-http.mjs` 覆盖，不是本片证据） |
| `#10` | AC4 实现时运行第 6 节评估 | 未取得 | 本链路不覆盖：无 OCR 评估读数 |

矩阵合计 **20 行**：**成立** 1 行（`#16 AC3`）、**部分成立** 4 行（`#9 AC2`、`#9 AC3`、`#16 AC1`、`#16 AC2`）、**不成立** 1 行（`#16 AC4`）、**未取得** 14 行（`#9 AC1`、`#9 AC4`，以及 `#6`×4、`#8`×4、`#10`×4）。⇒ 本页**不**声称 `#6`/`#8`/`#10` 的任何 AC 已满足，也**不**声称 `#16 AC4` 已满足，也不把「人工选择独立记录」算作本片证据。

## 2 证明边界

| 项 | 本页是否证明 | 说明 |
| --- | --- | --- |
| 识别任务受理 → 终态 → 结果投影 | 是 | loopback 真实 `fetch` 打真实 Fastify 装配，不是直接调 service |
| 可信度依据（类别 + 置信度）与「不确定」显式区分 | 是 | `succeeded` 与 `uncertain` 两种终态在同一脚本内都观测到，不写死阈值 |
| 识别历史写入、读回、时间序、跨用户隔离、删除、重放 | 是 | 内存臂 + 真库臂各一遍 |
| 真库持久化（身份 + 历史） | 是（真库臂） | `users` / `history` / `history_idempotency` 三张表由独立连接直查 |
| 识别记录本身的持久化 | **否** | 仓内**不存在** PG 识别存储，识别记录只活在进程内（重启即失），这是产品现状，不是本脚本的取舍 |
| 真实 OCR 供应商调用（`#9 AC1`） | **否** | 无凭据；`createRealRecognitionProvider` 缺配置即 `available:false`，上传 503 `PROVIDER_UNAVAILABLE`，**永不**回退替身 |
| 真实图片上传 / EXIF 清除（`#6 AC1/AC2/AC4`） | **否** | 只用替身媒体端口的 `media_id` **引用**，不解码、不落对象存储 |
| 药剂适用过滤与用量边界（`#8` 全部 AC） | **否** | 本链路不涉及药剂/用量面 |
| 标签 OCR、用户校正、登记精确核对（`#10` 全部 AC） | **否** | 本链路只走识别域；OCR 域是另一条链（`tests/integration/ocr-http.mjs` 已覆盖其 API 层） |
| 微信登录 / 微信开发者工具 / 真机 | **否** | 用合成身份码走 `POST /api/v1/auth/wechat`，无微信侧调用 |
| 级联删除真实执行 | **否** | 删除响应 `X-GY-Cascade: unwired` —— 级联端口未接线，只如实披露，不谎称已完成 |
| 删除时的幂等台账 | 是（真库臂） | 同键重放返回 200 且不复活数据，台账行由直查确认 |

## 3 合成输入逐字清单

| 输入 | 逐字值 | 用途 |
| --- | --- | --- |
| `media_id`（成功桶） | `11111111-1111-4111-8111-111111111111` | 替身提供者按 `sha256(media_id)[0] % 4` 分桶，该值落「2 条候选且都有分数」桶 ⇒ `succeeded` |
| `media_id`（不确定桶） | `77777777-7777-4777-8777-777777777777` | 落「有候选但无分数」桶 ⇒ `uncertain` + 如实原因 |
| `media_revision` | `1` | 两次上传都用 1；`media_id` 只是替身索引，不代表真有该媒体 |
| 微信登录 `code` | `synthetic-recog-chain-a` / `synthetic-recog-chain-b` | 两个合成主体 A / B，B 只用于越权对照 |
| 幂等键 | `gy-recog-chain-<label>-<0001 起单调序号>` | 全局单调：**同 label 两次调用取到不同键**；只有显式复用同一个键才是「重放」 |
| 断言里的不存在 id | `00000000-0000-4000-8f00-0000000000ff` | 「不存在」与「已删除」的 404 同形对照 |
| 时间 | 脚本不注入时钟（用服务端真实时间） | 历史排序断言只验「倒序 + 三次读取顺序一致」，不断言具体时刻 |

## 4 运行方式与实测读数

内存臂（CI 默认跑这条，无需任何外部依赖）：

```text
node tests/integration/recognition-chain-e2e.mjs
```

真库臂（本机隔离 PG17，专用库 `gengyun_recognition_chain_test`，只连 loopback）：

```text
RECOGNITION_CHAIN_PG_TEST_URL=postgres://postgres@127.0.0.1:55471/gengyun_recognition_chain_test \
node tests/integration/recognition-chain-e2e.mjs
```

起库方式（本机 `.pg17\pgsql\bin`，数据目录在仓库外，端口隔离；收工已 `pg_ctl stop`）：

```text
initdb -D <tmp>\data -U postgres -A trust -E UTF8 --locale=C
pg_ctl -D <tmp>\data -l <tmp>\server.log -o "-p 55471 -c listen_addresses=127.0.0.1" -w start
psql -h 127.0.0.1 -p 55471 -U postgres -d postgres -c "CREATE DATABASE gengyun_recognition_chain_test"
```

真库臂原始输出摘录（2026-10-19 在本机的一次实际运行，退出码 0；uuid 与毫秒数每次运行都不同，断言语义不变）：

```text
[GY-RECOG-E2E] real PostgreSQL patch: 17.11
[GY-RECOG-E2E] 迁移应用：0001_initial_schema.sql + 0018_favorites_history.sql（重复应用 no-op）
[GY-RECOG-E2E] arm=pg step=i06-upload status=202 job=35692229-3b8c-4568-9ee8-cda26127343c recognition=b952b796-9b22-4e7e-9fe3-54bdcf5e012b state=queued cache=no-store
[GY-RECOG-E2E] arm=pg step=i08-result job=35692229-3b8c-4568-9ee8-cda26127343c state=succeeded elapsed=2ms model_version=stub-v1 candidates=[{"species_id":"synthetic_weed_a","rank":1,"model_score":0.64},{"species_id":"synthetic_weed_b","rank":2,"model_score":0.28}] reasons=[]
[GY-RECOG-E2E] arm=pg step=i08-uncertain job=c4e30ee8-0ffb-46ac-ad5a-637ea31cc0ab state=uncertain candidates=[{"species_id":"synthetic_weed_a","rank":1,"model_score":null},{"species_id":"synthetic_weed_b","rank":2,"model_score":null}] reasons=["替身未给出可信分数，需重拍或人工核对"]
[GY-RECOG-E2E] arm=pg step=i09-history history=f6668f10-edbf-4f96-9954-1f50b2c40332 rev=1 created_at=2026-10-19T05:14:11.119Z target={"type":"recognition","id":"b952b796-9b22-4e7e-9fe3-54bdcf5e012b","revision":1} job_state=succeeded reference_state=unavailable appeared_after_job=5ms
[GY-RECOG-E2E] arm=pg step=pg-rows 直查 history：job_id=35692229-3b8c-4568-9ee8-cda26127343c owner=99f3d471-d917-4428-a7b3-8cd49c1cd6e3 event_key=recognition:35692229-3b8c-4568-9ee8-cda26127343c job_state=succeeded target=recognition:b952b796-9b22-4e7e-9fe3-54bdcf5e012b@1；users=2 行；他人历史=0；(owner,event_key) 唯一=1 行
[GY-RECOG-E2E] arm=pg step=i10-delete-again 同键重放=200 accepted=true cascade=unwired；换键再删=404 NOT_FOUND（与不存在同形=true）
[GY-RECOG-E2E] arm=pg step=pg-after-delete 直查 history 总行数=0（物理删除）；users 仍=2 行；history_idempotency=2 行（同键重放由真库台账裁决）
[GY-RECOG-E2E] 合计 36 条证据行；耗时 1152ms
PASS recognition-chain-e2e (内存臂：loopback 真 HTTP；真库臂见上方 arm=pg 行)
```

同一脚本不带 `RECOGNITION_CHAIN_PG_TEST_URL` 时：内存臂 17 条证据行、真库臂打印 `SKIP real PG17: … 未设置 —— 本次运行**没有**验证真库持久化（不是通过，也不是失败）` 并以 0 退出（**不静默绿**）。

## 5 链路逐步骤（请求 → 期望 → 实测）

路径列 `tests/integration/recognition-chain-e2e.mjs:NN` 均指断言所在的**那一行**；`实测` 列取自真库臂的**同一次**运行（uuid 与耗时逐次不同，断言与字段语义不变），内存臂给出同样的断言结论。

| 步骤 | 请求 | 期望 | 实测 | 断言位置 | 对应 AC |
| --- | --- | --- | --- | --- | --- |
| 1 身份 A/B | `POST /api/v1/auth/wechat` + `Idempotency-Key`，body `{"code":"synthetic-recog-chain-a"}` | 200 且 `data.token_type=Bearer`；会话投影**不含** `user_id/userId/subject` | 200；两个合成主体各自登录成功 | `tests/integration/recognition-chain-e2e.mjs:120`（禁字段）、`:248`（登录调用） | `#9 AC3` 前置（主体可区分） |
| 2 上传受理 | `POST /api/v1/recognitions`，`{"media_id":"11111111-1111-4111-8111-111111111111","media_revision":1}` + `Idempotency-Key` | 202；`data.state=queued`；`data.id`（jobId）与 `data.target_ref.id`（识别记录 id）都是 uuid 且互不相等；`meta.execution_mode=stub`；`Cache-Control: no-store` | `status=202 job=35692229-… recognition=b952b796-… state=queued cache=no-store` | `:254`（受理）、`:257`（两个 id 不相等） | `#9 AC3`；`#16 AC3`（识别不是「已使用」） |
| 3 同键重放（创建） | 同一条请求原样再发一次 | 回放**同一个** job 与同一个识别记录；不产生第二个任务 | 同一 job；回放的是该任务**当前**投影（`state=succeeded`），不是受理瞬间快照 | `:262` | `#9 AC3` |
| 4 拿结果 | `GET /api/v1/jobs/{jobId}`（≤3s 有界轮询） | 终态 `succeeded`；`error_code=null`；`target_ref` 指向识别记录；`result.kind=recognition` | `state=succeeded elapsed=2ms model_version=stub-v1`；候选 2 条：`synthetic_weed_a` 0.64 / `synthetic_weed_b` 0.28；`reasons=[]` | `:272`（终态）、`:274`（target_ref） | `#9 AC2` |
| 5 可信度依据 | 同上结果体 | 候选**恰 2 条**（该媒体只有 2 条 ⇒ 补造第 3 条即红）；`rank` 1..n 连续；`species_id` 非空；至少一条**数值** `model_score`；`uncertainty_reasons=[]`；候选不得自造 `category` 字段；结果不自带「已选中」 | 2 条候选均带数值分数（类别 + 置信度两样依据齐备）；未补造第 3 条；`selected_species_id=null` | `:283`（候选数恰 2）、`:285`（逐候选）、`:290`（禁自造 category）、`:293`（至少一条数值分数）、`:298`（无「已选中」） | `#9 AC2`；`#16 AC2`（候选与人工选择分开，仅前半句） |
| 6 结果面读回 | `GET /api/v1/recognitions/{id}` | 200 + `ETag: "1"` + `no-store`，且与 `job.result.value` **逐字段相等** | 200 `etag="1"`；与任务面投影完全一致（两套字段没漂移） | `:307`、`:309`、`:310` | `#9 AC2`（结果面与任务面同一份投影）；**不**断言 `#16 AC4` 的读时重查 |
| 7 不确定分支 | `POST /recognitions` `media_id=77777777-…` → 轮询任务 | 终态 `uncertain`（**与 succeeded 可区分**）；至少一条非空原因；无分候选保持 `model_score=null`（不补造） | `state=uncertain`；`candidates` 2 条分数均为 `null`；`reasons=["替身未给出可信分数，需重拍或人工核对"]` | `:317`、`:319`、`:321`、`:330` | `#9 AC2`（无可信分数不伪造高置信） |
| 8 落历史 | `GET /api/v1/history`（有界轮询，见 `:171` 的 `waitHistoryFor`） | 恰一条命中该识别；键集**恰等**契约 7 键；无 `owner_id`；`job_state=succeeded`；`revision=1`；`created_at` 可解析；`reference_state=unavailable` | `history=f6668f10-… rev=1 appeared_after_job=5ms`，键集与契约一致 | `:349`（键集）、`:350`（无 owner_id）、`:357`（reference_state） | `#16 AC3`（无「已使用」字段） |
| 9 非成功终态入历史 | 同上（不确定任务） | `job_state=uncertain` **原样保留**，不改写成 succeeded | `history=f75b4338-… job_state=uncertain` | `:365` | `#16 AC2`（失败/不确定任务真实可见） |
| 10 重放不长行 | 同键再发上传 | 该识别的历史仍**恰 1 条**；提供者累计调用仍为 2（两次上传各一次） | 1 条；`calls=2` | `:378` | `#9 AC3` |
| 11 时间序稳定 | `GET /api/v1/history` ×3 | 三次返回的 id 顺序完全一致；`created_at` 非递增；`next_cursor=null` | 三次一致；倒序成立 | `:387` | —（契约：列表排序/分页稳定，不隶属任一 AC） |
| 12 跨用户不可见（读） | B：`GET /api/v1/history`；`GET /api/v1/recognitions/{A 的识别 id}` | B 列表 `{items:[],next_cursor:null}`；读 A 的识别 404，且错误体与「不存在 id」**逐字段同形** | B 列表空；404 同形=true | `:439`、`:444` | `#16 AC1` |
| 13 跨用户不可见（删/详情） | B：`DELETE /api/v1/history/{A 的历史 id}`；`GET /api/v1/history/{id}` | 删除 404 `NOT_FOUND`；`GET /history/{id}` 404（契约未注册该路径，不得悄悄长出） | 均 404；A 的历史仍 2 条未被动 | `:447`（未注册读详情）、`:449`（越权删除） | `#16 AC1` |
| 14 删除历史 | `DELETE /api/v1/history/{id}` + `Idempotency-Key` + `If-Match: "1"` | 200 `{accepted:true}`；`meta.execution_mode=stub`；`X-GY-Cascade` 落闭集；只删被点的那一条 | 200 accepted=true `cascade=unwired`；剩余 1 条 | `:464`、`:467` | `#16 AC1`（本人可删；他人不可删的补集见步骤 13） |
| 15 再读为空 | 删第二条 → `GET /api/v1/history` | `{items:[],next_cursor:null}`，且无 `ETag` | 一致 | `:485`、`:487` | `#16 AC1` |
| 16 同键重放删除 | 用**同一个**幂等键再删同一条 | 200 回放首次结果与同一份级联披露；**不复活**数据 | 200 accepted=true cascade=unwired；列表仍空 | `:494`、`:496` | `#16 AC1` |
| 17 换键重复删除 | 用**新键**再删同一条 | 404 `NOT_FOUND`，与「从不存在 id」的 404 逐字段同形 | 404 同形=true；对**从不存在**的 id 删除同样 404（不泄露存在性） | `:501`、`:503`、`:505` | `#16 AC1` |
| 18 真库直查（删前） | 独立 `pg.Client`：`SELECT … FROM history WHERE job_id=$1` | 恰 1 行；`event_key=recognition:<jobId>`；`owner_id` 指向真库 `users` 行；他人 0 行；`(owner,event_key)` 唯一 | 1 行；`users=2` 行；他人历史=0；唯一性=1 行 | `:407`、`:429` | `#16 AC3` |
| 19 真库直查（删后） | 同上连接：`count(*) FROM history` / `users` / `history_idempotency` | `history` 0 行（物理删除）；`users` 仍 2 行；台账 ≥ 2 行 | 0 / 2 / 2 | `:516` | `#16 AC1` |

## 6 未取得／未覆盖项（不硬凑，逐条列明）

| 项 | 状态 | 原因与已取得的最接近证据 |
| --- | --- | --- |
| `#16 AC2` 后半句「人工选择独立记录」 | 未取得（本片不覆盖） | 脚本**未调用** `PATCH /recognitions/{id}/selection`，故证不了「人工选择独立记录、且不回写 `candidates`/`model_score`/`model_version`」。该写入面由既有单测 `tests/unit/recognitions-candidates-selection.test.mjs` 覆盖（**非本片证据**，本片未复核其全部断言）。已取得的最接近证据：`:298` 只证「识别结果不自带已选中」 |
| `#16 AC4` 读取时重查对象权限及当前可见性 | **不成立（待实现缺口）** | 基线只把 `reference_state=unavailable` 写进历史投影，**没有**在读取时重查目标权限与当前可见性 ⇒ 这不是核验结论，而是「读面不存在」的如实披露。实现它需要两个组件：① **引用读面** —— 按 `target_ref`（`recognition`/`ocr` 等）回读目标当前状态；现有 `historyVisibility` 只对 `species` / `herbicide` / `scheme` 三种核 `/knowledge`，识别/OCR 目标恒 `unavailable`。② **读时状态复算** —— 列表与删除路径每次读取都重算 `reference_state`（含权限、当前可见性、对象是否已删），而不是写入时定型或读缓存。已取得的最接近证据：`:357` 断言的就是这个 `unavailable` 披露值本身 |
| 真实 OCR/识别供应商调用（`#9 AC1`） | 未取得 | 仓内无 provider 凭据；`real` 模式构造的提供者 `available:false`、上传 503 `PROVIDER_UNAVAILABLE`，**fail-closed 不回退替身**。已取得：替身链路上的 `meta.execution_mode=stub` 处处如实标注 |
| 「同分候选 ⇒ uncertain」区分 | 未取得（登记，不写死期望） | 依赖**未合** PR #299：本基线 `services/api/src/recognitions/state.ts` 没有同分判定规则，且替身脚本不产出同分候选 ⇒ **没有任何 HTTP 输入**能造出同分；脚本内 `step=skip-tie` 显式打印 SKIP，不把「想当然的期望」写成断言 |
| 「无效登记 ⇒ conflict」 | 未取得 | 同属未合 PR #299 的下游语义，本链路不涉及登记面（`#10`），未断言 |
| 真实媒体上传 / EXIF 清除（`#6`） | 未覆盖 | 链路只用替身端口的 `media_id` 引用；`#6` 的 AC 需真实上传通道与对象存储，不在本片范围 |
| 药剂适用过滤与用量边界（`#8`） | 未覆盖 | 识别链路不读药剂面；该 AC 的验收对象是 `/knowledge` 与用量卡片 |
| 标签 OCR 与校正（`#10`） | 未覆盖 | 本链路只走识别域；OCR 域的 API 层由 `tests/integration/ocr-http.mjs` 覆盖 |
| 识别记录持久化 | 未覆盖（产品现状） | 仓内**不存在** PG 识别存储（`services/api/src/recognitions/` 只有内存 store）⇒ 进程重启后识别记录与「按 id 读回结果」都会消失；历史行仍在（真库臂已证），但其 `target_ref` 指向的记录已不可读，届时读取面的语义需要在含 PG 识别存储的分支上重新验收 |
| 级联删除真实执行 | 未取得 | `X-GY-Cascade: unwired`（`historyCascadePort` 未接线）⇒ 删除历史不会真的去删收藏/任务；本脚本只断言该披露值在闭集内并原样回放 |
| 微信开发者工具 / 真机 / 小程序端证据 | 未取得 | **本页证明 API 层链路；微信工具／真机证据未取得**（本机无微信侧调用，`miniprogram/**` 不在本片授权范围） |
| 真库臂进 CI | 未取得 | 需要 `RECOGNITION_CHAIN_PG_TEST_URL` + fresh 专用库（同 `favorites-history-pg.mjs` 口径，仓库 CI 不 initdb）；CI 只自动跑内存臂 |
| 依赖 shell 的校验 | 未取得 | 本机 `bash` 是 WSL 存根（不可用），本片所有门禁均以 `node`/`python`/`git` 直跑，不含任何 shell 脚本校验 |
| 真实性能/准确率（`#9 AC4`） | 未取得 | 替身提供者不产生真实识别质量；本页**不**冒充准确率或性能验收 |

## 7 六项门禁读数

| 门禁 | 命令 | 实测 | 结论 |
| --- | --- | --- | --- |
| ① 工作树 | `git status --porcelain` | **提交后复跑：0 行**（干净）；本轮返修改动提交前曾是 ` M docs/verification/gy-recog-chain-20261019.md` + ` M tests/integration/recognition-chain-e2e.mjs` 两行 | 只有本片 3 个文件被改/增，无越界改动 |
| ② 单测全量 | `node --test "tests/unit/*.test.mjs"` | 本树（断言补充后复跑）：`tests 1617 / pass 1616 / fail 0 / skipped 1 / todo 0`，退出码 0（52.98s）；同 SHA 干净基线树（`upstream/main` = `8cc9dd8b1ee251c8d7000390d54e0ba07a6ac37f`，独立 worktree）：`tests 1617 / pass 1616 / fail 0 / skipped 1` | 与干净基线**同数**，未放宽、未删测试 |
| ③ 链路端到端 | `node tests/integration/recognition-chain-e2e.mjs` | **断言补充后复跑（两臂都重跑）**：内存臂 `arm=memory PASS`、`合计 17 条证据行；耗时 241ms`；真库臂 `arm=pg PASS`、`real PostgreSQL patch: 17.11`、迁移 `0001`+`0018`（重复应用 no-op）、`合计 36 条证据行；耗时 754ms`（`RECOGNITION_CHAIN_PG_RESET=1` 重建 `public`）；不带 env 时真库臂显式 SKIP。三种跑法退出码均 0。新增断言 `:283`（候选数恰 2）在两臂都过 | 本页 §5 的 19 组断言（含新增的候选数断言）全部实测通过 |
| ④ 契约状态 | `node tools/verify-contract-status.mjs` / `--runtime` | 均 `PASS：覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；形状错误 0 项；语义错误 0 项`；`--runtime` 额外 `PASS 无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致` | 未改契约，读数与基线一致 |
| ⑤ 文档校验 | `python -B tools/validate_development_docs.py` | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` | 含新增本页的链接与表格校验 |
| ⑥ 空白/补丁卫生 | `git diff upstream/main --check` | 无输出，退出码 0 | 无行尾空白/空白错误 |

## 8 产品事实与未改动项

- 识别 → 历史是**两段异步**：`recognitions/service.ts` 的 `commitTerminal` 先 CAS 提交终态，**之后**才 `await recordTerminalHistory(...)`，且端口异常被吞只记告警 ⇒ `GET /jobs/{id}` 见到终态时历史行**可能**尚未落库。本脚本因此在历史面做**有界轮询**并记录实测延迟（内存臂 4–6ms、真库臂 5–6ms），没有用 `sleep` 猜，也没有把「一次读不到」当产品缺陷。
- `GET /api/v1/history` 恒 `Cache-Control: no-store` 且**无 ETag**；历史投影键集恰为 `created_at/id/job_state/kind/reference_state/revision/target_ref`，不含 `owner_id`。
- `reference_state=unavailable` 是**如实披露**：stub 装配下没有 `/knowledge` 读面，服务端不去假装核验过目标可见性。⚠ 但如实披露 ≠ 实现「读取时重查对象权限及当前可见性」⇒ `#16 AC4` 判**不成立**（见 §1.1、§6）。
- 删除历史：`If-Match` 必填；**同键重放返回 200 回放**（真库臂由 `history_idempotency` 台账裁决），**换新键再删已删除 id 返回 404**，且与他人 id / 不存在 id 的 404 **同形** —— 这两种「重复删除」语义不同，本脚本分开断言，避免把幂等回放误记成 404。
- 本片未改：契约、`docs/architecture/contract-status.json`、迁移、`miniprogram/**`、`services/api/**`、既有测试。唯一改动是 `package.json` 的 `test:integration:http` 链**追加一条**成员（结构门禁要求新脚本必须接线或进白名单；选择接线，让 CI 至少跑内存臂）。

## 9 与 issue 的关系

`refs #6 #8 #9 #10 #16`，**不关闭任何一项**；主体按真实 AC 收窄为 `#9`/`#16`（逐 AC 判定见 §1.1），`#6`/`#8`/`#10` 只作关联引用：

- `#9`（拍草识别）：本页只证 API 层链路的**接口形状与不确定语义**（AC2/AC3 的一部分）；AC1（真实服务调用证据）与 AC4（准确率/性能评估）**未取得**。
- `#16`（收藏与识别历史）：本页证历史行的写入/读回/时间序/跨用户隔离/删除/重放（AC1/AC2/AC3 的 API 层部分）；**AC4 判不成立**——只披露 `reference_state=unavailable`，没有在读取时重查对象权限与当前可见性，实现它需要「引用读面 + 读时状态复算」两个组件（见 §1.1、§6 待实现缺口）。
- `#6`/`#8`/`#10`：本链路只经过它们的**相邻接口**（媒体引用、识别入口、历史面），其 AC 需各自专门的验收，本页**不覆盖**，见 §6。
