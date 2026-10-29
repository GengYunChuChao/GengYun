# G 片全量本地演练（2026-10-28，本机 Windows）

本页是 **GY-R68-G「全量本地演练 + 证据页 + 机器可复算闸门」** 的证据页。它只有一条硬承诺：
**标记块里的每一个「可复算读数」，都能被一条命令从**树**当场重算出来：稳定型读数要求精确相等，生长型读数按上下界判（滞后逐行打印、冒进两种口径都红），任何偏差都 exit 1 并点名第一处差异。**

> 读这一页之前先读 [`docs/verification/how-to-read-ci-runs.md`](how-to-read-ci-runs.md) §4/§5：
> **CI 读数不入库**，本机读数 ≠ `ubuntu-24.04` 读数。本页所有读数都是**本机**读数，绑定一个提交 SHA。

## 1. 怎么复算（唯一入口）

```powershell
node tools/verify-g-drill-readings.mjs --check     # 重算 + 整块逐行比对（规范化后）；不一致 exit 1
node tools/verify-g-drill-readings.mjs --live      # 只重算「可复算类」（11 条静态闸门）并对照 exit / 读数
node tools/collect-g-drill.mjs                     # 重新采集一次性读数 → $env:TEMP\gy-g-drill\<sha>\readings.json
node tools/verify-g-drill-readings.mjs --update    # 用上一步的读数重写标记块内部（块外一个字都不动）
```

- 期望值**不来自**本页、也不来自任何已提交的 JSON：`--check` 每次都重新遍历 `tests/**`、解析 `package.json`、
  扫 `.github/workflows/**` 的 `run:` 文本、读 `tests/unit/ci-real-pg-readings-gates.test.mjs` 的臂表。
- 日志**不入库**：`stdout`/`stderr` 落在 `$env:TEMP\gy-g-drill\<sha>\*.log`，本页只留读数与命令。

## 2. 标记块

下面这一块是**生成物**。块内任何一个字符被手改，`--check` 都会红并打印「第一处差异：文档第 N 行 vs 重算第 M 行」；**唯一的例外是生长型读数的滞后**（见 §3）——它仍是「不一致」，但按 §3 的下界口径放行，并把每一条滞后逐行打印出来（不静默）。

<!-- G-DRILL:BEGIN -->
#### 可复算读数（`--check` 每次从树现场重算）

| 键 | 读数 | 下界 / 关系 |
| --- | --- | --- |
| workflows | 15 | >= 15（`.github/workflows/` 下的 `*.yml` 与 `*.yaml` 文件数） |
| workflowJobs | 25 | >= 25（各 workflow `jobs:` 段两空格缩进键之和） |
| drillCommands | 21 | 必须精确相等（`DRILL_PLAN` 的条数；稳定型：两种口径都不许滞后，反空转下界 ≥ 20） |
| allTestFiles | 496 | >= 490（`tests/**/*.test.mjs` 递归计数） |
| verificationDocs | 298 | >= 297（`docs/verification/*.md`） |
| totalTestFiles | 467 | = 五条 `test:unit` glob 的分文件数之和 |
| unitGlobUnion | 467 | 必须等于 totalTestFiles（五条 glob 不许重叠） |
| packageScripts | 26 | -（`package.json` 的 scripts 条数） |
| verifyTestScripts | 18 | 每条都必须出现在本块里（跑或写明原因） |
| realPgArms | 13 | >= 13（`ci-real-pg-readings-gates.test.mjs` 里的臂条数；只读，不复制基线） |
| drilledArms | 0 | 闸门表（`realPgArms`）里同时出现在演练清单中的条数；本片真跑的 3 条自起集群臂不在那张表里，故为 0（它们逐条写在下面「未跑」表之外的真实读数里） |
| globFiles.unit | 396 | -（`tests/unit/*.test.mjs` 的分文件数） |
| globFiles.privacy | 17 | -（`tests/privacy/*.test.mjs` 的分文件数） |
| globFiles.media | 8 | -（`tests/media/*.test.mjs` 的分文件数） |
| globFiles.reference | 26 | -（`tests/reference/*.test.mjs` 的分文件数） |
| globFiles.moderation | 20 | -（`tests/moderation/*.test.mjs` 的分文件数） |

#### 一次性实测（不可复算：只存当时值 + sha + 主机 + 时刻）

| # | 命令 | exit | 读数 | sha | 主机 | 时刻（ISO 8601） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `npm run test:unit` | 0 | tests 5652 / pass 5649 / fail 0 / skipped 1 / todo 2 / 134521ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 2 | `node --test tests/ui-unified-states.test.mjs` | 0 | tests 10 / pass 10 / fail 0 / skipped 0 / todo 0 / 225ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 3 | `node --test tests/demo-ui-components.test.mjs` | 0 | tests 3 / pass 3 / fail 0 / skipped 0 / todo 0 / 206ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 4 | `npm run lint` | 0 | 耗时 7582ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 5 | `node tools/run-python.mjs tools/validate_development_docs.py` | 0 | 耗时 419ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 6 | `node tools/run-python.mjs tools/validate_contracts.py` | 0 | 耗时 228ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 7 | `node tools/run-python.mjs tools/test_contracts.py` | 0 | 耗时 448ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 8 | `node tools/verify-research-records.mjs` | 0 | 耗时 117ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 9 | `node tools/verify-contract-status.mjs` | 0 | 耗时 1978ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 10 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | 0 | 耗时 3200ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 11 | `node tools/verify-admin-capability-map.mjs --check` | 0 | 耗时 881ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 12 | `node tools/verify-purge-schedule.mjs` | 0 | 耗时 295ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 13 | `node tools/verify-migrations-unique.mjs --annotations` | 0 | 耗时 110ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 14 | `node tools/openapi-route-parity.mjs` | 0 | 耗时 1340ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 15 | `npm run test:contract` | 0 | tests 17 / pass 17 / fail 0 / skipped 0 / todo 0 / 1831ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 16 | `npm run test:evaluation` | 0 | tests 169 / pass 169 / fail 0 / skipped 0 / todo 0 / 2231ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 17 | `npm run test:integration:http` | 0 | 耗时 149848ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 18 | `npm run test:failmatrix -- --json={logDir}\failmatrix.json` | 0 | 耗时 2097ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 19 | `node tests/integration/catalog-pg.mjs` | 0 | 耗时 2873ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 20 | `node tests/integration/retention-purge-pg.mjs` | 0 | 耗时 4018ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |
| 21 | `node tests/integration/admin-audit-logs-pg.mjs` | 0 | 耗时 3662ms | `@ e80a820a855ac9117fab5c35d432298f98264d18` | 本机 春秋蝉鸣少年归 | 2026-10-28T11:05:57.487Z |

#### 未跑（本机跑不了）与不在演练范围（原因）

| 条目 | 判定 |
| --- | --- |
| `npm run test:reference` | 不在演练范围：它的 glob（`tests/reference/*.test.mjs`）已被清单 #1 `npm run test:unit` 的第 4 条 glob 覆盖，单跑一遍不增读数 |
| `npm run test:docs` | 不在演练范围：它的两条子命令已逐条在清单里（`validate_development_docs.py` / `verify-research-records.mjs`） |
| `npm run verify:anchors` | 不在演练范围：它的两条子命令已逐条在清单里（`verify-contract-status.mjs` / `verify-doc-anchors.mjs --strict --symbol=strict --scan docs`） |
| `npm run verify:parity` | 不在演练范围：它全部内容就是清单里的 `node tools/openapi-route-parity.mjs` |
| `npm run verify:capability-map` | 不在演练范围：它全部内容就是清单里的 `node tools/verify-admin-capability-map.mjs --check` |
| `npm run verify:purge-schedule` | 不在演练范围：它全部内容就是清单里的 `node tools/verify-purge-schedule.mjs` |
| `npm run verify:real-capability` | 不在演练范围：它是自检命令（默认恒 exit 0、不判红），且 `--strict` 要有真实凭据才有意义（无凭据时所有能力组判 n-a ⇒ 判定恒 PASS）；演练清单收的是会判红的门禁 |
| `node tools/run-python.mjs tools/validate_openapi_standard.py` | 未跑：需网络下载官方 OAS 3.1 规范文件（`--schema` 必填，脚本明示自己不做下载/安装），且本机未安装 jsonschema；它也只出现在 `development-docs.yml` 的 `paths:` 里，任何 workflow 都没有它的 `run:` 步骤 ⇒ **CI 里没有等价的 OAS 3.1 元模式校验**（CI 跑的 `validate_contracts.py` 只做「自仓 openapi 的版本号串 == 3.1.1」这一条自检，不等于元模式校验；这是既有缺口，本片不改） |
| `npm run test:mini` | 未跑：微信开发者工具 SDK 未安装（本机没有该 CLI，`check-wechat-project.mjs` 之后那条 `node --test` 无从跑起） |
| `npm run test:integration:recognition-chain-pg` | 未跑：网络与凭据都不在本机：该臂打真实供应商链路，CI 外一律禁用真实外部调用 |
| `npm run test:integration:conversations-pg` | 未跑：docker services 容器形态的 PG：库名与连接串由 workflow 的 `psql -c CREATE DATABASE` 注入，本机只有自起集群 |
| `npm run test:integration:media-persistence-pg` | 未跑：同上（容器形态 PG），且需要 `--experimental-strip-types` 的独立运行时，本片未验证该组合 |
| `npm run test:integration:backup-copies-purge-pg` | 未跑：同上（容器形态 PG，库名 `gengyun_*_test` 由 workflow 建） |
| `npm run test:integration:online-purge-pg` | 未跑：同上（容器形态 PG，库名由 workflow 建） |
| `node tests/integration/qa-citations-pg.mjs` | 未跑：本片按 §4 只真跑三条自起集群臂；该臂在 CI 里挂 `services: postgres` 容器（库名与连接串由 workflow 注入），本机未起该容器 |
| `node tests/integration/admin-jobs-pg.mjs` | 未跑：本片按 §4 只真跑三条自起集群臂；该臂在 CI 里挂 `services: postgres` 容器（库名与连接串由 workflow 注入），本机未起该容器 |
| `node tests/integration/admin-community-posts-pg.mjs` | 未跑：本片按 §4 只真跑三条自起集群臂；该臂在 CI 里挂 `services: postgres` 容器（库名与连接串由 workflow 注入），本机未起该容器 |
| `node tests/integration/admin-post-hide-audit-pg.mjs` | 未跑：本片按 §4 只真跑三条自起集群臂；该臂在 CI 里挂 `services: postgres` 容器（库名与连接串由 workflow 注入），本机未起该容器 |
| `node tests/integration/ocr-corrections-pg.mjs` | 未跑：本片按 §4 只真跑三条自起集群臂；该臂在 CI 里挂 `services: postgres` 容器（库名与连接串由 workflow 注入），本机未起该容器 |
| `node tests/integration/admin-posts-read-pg.mjs` | 未跑：本片按 §4 只真跑三条自起集群臂；该臂在 CI 里挂 `services: postgres` 容器（库名与连接串由 workflow 注入），本机未起该容器 |
| `node tests/integration/admin-scopes-read-pg.mjs` | 未跑：本片按 §4 只真跑三条自起集群臂；该臂在 CI 里挂 `services: postgres` 容器（库名与连接串由 workflow 注入），本机未起该容器 |
| `node tests/integration/admin-content-pg.mjs` | 未跑：本片按 §4 只真跑三条自起集群臂；该臂在 CI 里挂 `services: postgres` 容器（库名与连接串由 workflow 注入），本机未起该容器 |
| `node tests/integration/admin-scopes-authority-pg.mjs` | 未跑：本片按 §4 只真跑三条自起集群臂；该臂在 CI 里挂 `services: postgres` 容器（库名与连接串由 workflow 注入），本机未起该容器 |
| `node tests/integration/moderation-full-chain-pg.mjs` | 未跑：本片按 §4 只真跑三条自起集群臂；该臂在 CI 里挂 `services: postgres` 容器（库名与连接串由 workflow 注入），本机未起该容器 |
| `node tests/integration/recognitions-speech-purge-pg.mjs` | 未跑：本片按 §4 只真跑三条自起集群臂；该臂在 CI 里挂 `services: postgres` 容器（库名与连接串由 workflow 注入），本机未起该容器 |
| `node tests/integration/retention-clock-drill-pg.mjs` | 未跑：本片按 §4 只真跑三条自起集群臂；该臂在 CI 里挂 `services: postgres` 容器（库名与连接串由 workflow 注入），本机未起该容器 |
| `node tests/integration/media-row-purge-pg.mjs` | 未跑：本片按 §4 只真跑三条自起集群臂；该臂在 CI 里挂 `services: postgres` 容器（库名与连接串由 workflow 注入），本机未起该容器 |
<!-- G-DRILL:END -->

## 3. 两类读数，不要混

| 类别 | 例子 | `--check` 怎么对待 |
| --- | --- | --- |
| **可复算类** | 文件数、glob 分文件数、脚本清单、workflow / job / 页面数、闸门 exit code、迁移号唯一性 | **每次从树现场重算**，与页面**逐行比对（CRLF→LF、去行尾空白、去尾部空行之后）**；内部再分「稳定型／生长型」两档，见下 |
| **一次性实测类** | 单测通过数 / 耗时、真库臂读数 | 只校**形状与算术**（`sha` 40 位、`host`、ISO 时刻、`tests == pass+fail+skipped+todo`），**不假装能复算** |

**可复算类再分两档**（分档表在 `tools/lib/g-drill-readings.mjs` 的 `STABLE_READINGS` / `GROWTH_READINGS`）：**稳定型**只剩 `drillCommands`（`DRILL_PLAN` 的条数，由本片的计划表决定，main 的提交不会动它）——**两种口径下都必须精确相等**；**生长型**是 main 也会推的计数（`workflows` / `workflowJobs` / `verificationDocs` / 测试文件数 / 五条 glob 的分文件数 / 脚本数 / 真库臂数）——按**下界**判（`文档值 <= 重算值`），滞后**逐行打印**「滞后 N」，`文档值 > 重算值`（注水）两种口径都红。
`--strict-growth` 要求**全部**读数（含生长型）与树逐字相等；它是「作者在自己树上自证页 == 树」的口径，不是 CI 口径（CI 检出的是「本分支 ∪ 最新 main」的合流树，生长型读数在合流树上**必然**滞后）。块里第二张表是一次性读数，绑定 `@ <sha>` + 主机 + 时刻，换机器、换提交都不会一样，这是设计，不是缺陷。

## 4. 八条判据（各自都能单独红）

1. **标记块唯一**：`G-DRILL:BEGIN` / `G-DRILL:END` 各恰 1 处，缺 / 多都红（报行号）。
2. **整块逐行比对（规范化之后）**：先 CRLF→LF、去行尾空白、去尾部空行，再逐行逐字符比——**行尾空格与换行风格
   不算手改**（否则 Windows 检出差异会天天假红），其余任何手改都红，打印第一处差异行号与两侧原文。**唯一例外是生长型读数的滞后**（文档值 < 重算值）：按 §3 的下界口径放行并逐行打印滞后数；冒进（文档值 > 重算值）与稳定型读数的任何偏差仍红。
3. **出处双向**：块里每条命令都要能在 `package.json` 的 `scripts` 值、`.github/workflows/**` 的 `run:` 文本、
   或 `tests/failmatrix/run.mjs` 里找到出处；反向，`package.json` 里每个 `verify:*` / `test:*` 都必须出现在块里，
   或显式标注「未跑：原因」/「不在演练范围：原因」——漏登记的脚本可以悄悄退出扫描面，那正是这套闸门要防的。
4. **反空转下界**（一律 `>=`，因为在飞的 PR 会让页数上涨；它与 §3 的分档是两件事——下界拦「树本身塌了」，分档拦「页面与树不一致」）：workflow ≥ 15、job ≥ 25、演练命令 ≥ 20、
   `tests/**/*.test.mjs` ≥ 490、`docs/verification/*.md` ≥ 297、真库臂（`realPgArms`）≥ 13。任一条破了即红。
   最后一条是补的缺口：臂清单要是被解析成 0 条，原先「每条臂都露过面」会**空转成绿**，现在 0 < 13 直接红。
5. **算术自洽**：每条 TAP 行 `tests == pass + fail + skipped + todo`；`test:unit` 五条 glob 的分文件数之和
   必须等于总数（重叠或漏算都会让「合计」变成一句空话）。
6. **一次性读数三件套**：每行必须有 40 位 `sha`、非空 `host`、ISO 8601 时刻；`sha` 能解析时必须**是 HEAD 的祖先**。
7. **不许写「CI 已绿」**：块内出现 `success` / `通过` 时，同一行必须带 `@ <sha>` 与「本机」字样，否则红。
8. **真空项显式化**：每个「本机跑不了」的条目必须写 `未跑：<原因>`，原因非空且落在
   `docker|网络|SDK|未安装|WSL|容器|端口|凭据|供应商|strip-types` 上；空原因等于没说。

单测 `tests/unit/g-drill-readings.test.mjs` 会在**夹具树 + 夹具文档**上把 M1–M4 四条变异跑一遍，另有一条**逐键注水**用例（全部读数键各 +1，两种口径都必须红并点名）：
M1 改数、M2 注水、M3 删行这三条只改**夹具文档**（生产代码一个字没动）⇒ `checkDocument` 必须红并点名；
M4「同义反复」是**测试文件里另写的一个假实现**（`tautologicalReadingsProblems`，把「文档值 := 重算值」这种写法的
后果显式造出来），用来证明「基线绿」那条断言不是空转。⚠ 它**没有**替换生产代码里的比较函数——
所以本片**没有**用变异测试证明过「生产代码的比较函数会红」，能证明的只是「夹具文档与夹具树不一致时必须红」。

## 5. 这些闸门不证明什么

> 这一节是从对抗性审查报告里**整段照抄**的（只去掉了引用前缀），一个字没改。放在「已知限制」之前，
> 是因为它比下面任何一条限制都更要紧：**它说的不是「本片还没做完」，而是「这类闸门到此为止」**。
> 第 9、10 条按第二轮复审的原文补入（其中「实测」的示例按修完之后的实际情形写了）；**下文第一人称的「我实测」指审查者**，
> 不是本页作者。

本页的八条判据只保证四件事：块唯一且完整、可复算读数等于**当前树**重算值、每条命令在仓里追得到出处、一次性读数的形状与算术自洽。它**不**证明下面这些，请连同正面结论一起读：

1. **第二张表（21 条一次性读数）的数字没有被任何自动检查复算过。** `--check` 对这 21 行只能核形状（40 位 sha、非空 host、ISO 时刻、`tests == pass+fail+skipped+todo`）、命令顺序与 Markdown 形状；日志不入库，`--check` 也不读任何读数文件。所以任何人都能把某一行改成任意自洽的数字并保持绿灯——我实测把 `npm run test:unit` 改成 `tests 1 / pass 1 / … / 1ms`，`--check` 仍然 exit 0；把 sha 换成仓里不存在的 `deadbeef…` 也一样绿（判据 6 只在 sha **可解析**时判祖先）。这一列的可信度来自「采集者对自己机器的输出诚实」，不来自工具。
2. **「21 条全绿」= 采集者报告本机这 21 条命令 exit 0**，不是 CI 结论，也不是「在别的机器/提交上可复现」。换一台机器、换一个提交，这些数字都会变，这是设计，不是缺陷。
3. **真库臂只真跑了 3 条**（`catalog-pg` / `retention-purge-pg` / `admin-audit-logs-pg`，都是本机自起集群）。`READING_GATE_BASELINES` 里另外 13 条 `services: postgres` 容器形态的臂**一条都没跑**，逐条只写「未跑：原因」，块里 `drilledArms = 0`。所以别把这页读成「真库全量演练」。
4. **那 13 条臂的读数量不在本页**：它们冻结在 `tests/unit/ci-real-pg-readings-gates.test.mjs` 的 `READING_GATE_BASELINES`；本页只保证「表里每条臂都露过面（跑过，或写明未跑原因）」，不复制、也不校验它们的条数。
5. **判据 7 只挡文字**：它挡的是「把 CI 说成已绿」这类没有 sha 的表述，不挡「用本机读数冒充 CI」。真正的 CI 结论仍以 PR 上的 checks 为准。
6. **「整块逐字节」是规范化之后的逐行逐字符**（CRLF→LF、去行尾空白、去尾部空行之后）。行尾空格、换行风格不算改动——我实测加行尾空格与整份 CRLF 都仍是绿的；这样做是为了不让 Windows 检出差异变成「手改」。
7. **`--live` 只复跑 11 条静态闸门**（`DRILL_PLAN` 里 `group === 'static'` 那 11 条），不覆盖 unit 3 条、suite 4 条、pg 3 条。`--live` 绿 ≠ 那 10 条现在是绿的。复跑全量只能人工重跑 `node tools/collect-g-drill.mjs`。
8. **`validate_openapi_standard.py` 在任何 workflow 里都没有 `run:` 步骤**：这是一条既有 CI 缺口（普通 CI 跑的是 `validate_contracts.py`，它只断言自仓 openapi 的版本号是 `3.1.1`，不等于 OAS 3.1 元模式校验）。本片不改它，只把「为什么本机也跑不了」写清楚。
9. **`sha` 列只证明「是某个祖先提交」，不证明「读数就是这个提交上采的」。** `--check` 的祖先检查对任何**能解析的**祖先都放行（实测：把某行 sha 换成另一个祖先仍 exit 0，换成非祖先才红）。本片两次采集正好各占一边：本页修完之前的 21 条采自 `1f056b8b` 的**检出 + 本片 5 个未提交新文件**——`1f056b8b` 里其实没有 `tests/unit/g-drill-readings.test.mjs`（`git cat-file -e 1f056b8b:tests/unit/g-drill-readings.test.mjs` 会失败），纯基线树是 `5557 − 28 = 5529` 项；修完之后的 21 条是在**代码提交的干净检出**上重采的（采集前 `git status --porcelain` 为空）。两次在页面上长得一模一样。要真正绑定只能重跑 `node tools/collect-g-drill.mjs`（§7）；`--check` 抓不到这件事。
10. **`--live` 的退出码不等于「11 条都验过了」。** 工具链缺失（如没有 `node_modules`，`npm run lint` 报「未找到本地 TypeScript」）时那一条按 **SKIP** 计、末行点名「这不是通过，只是没跑」，进程退出码是 **2**——0 只留给「11 条全跑过且都与块里一致」，1 是判据红。把 `--live` 串进脚本要认这三档，别写 `if (exit !== 1) → 绿`。

> 上面第 6 条里的「整块逐字节」是审查报告的原文措辞；本页与代码现在统一写作「整块逐行比对（规范化之后）」，
> 两者说的是同一件事（**规范化之后**逐行逐字符比，行尾空格与换行风格不算手改）。

## 6. 已知限制

- **只在本机 Windows 上跑过**。`ubuntu-24.04` 上 `node` / `python` / `psql` 的版本与路径都不同，
  TAP 行数也可能不同（`node --test` 的汇总口径与平台无关，但**耗时**必然不同）。本页不主张任何 CI 结论。
- **`services:` 容器形态不可复现**：CI 用 service 容器起的 Postgres（`postgres:17` 镜像 + `POSTGRES_*` 环境变量），
  本机用的是 `E:\GengYunCommander\.pg17\pgsql\bin` 的自起集群，端口、初始化脚本、`pg_hba` 都不同。
- **本机观测到一次异常长跑**：`npm run test:unit` 有一次经收集器重定向后 20 分钟无输出、node 进程持续吃满一个核
  （CPU 累计 1198s），同一条 glob 集合直接跑 `node --test` 是 121395ms / 5557 项。根因未定位（未复现），
  本页不把它记成绿，也不拿它当结论；出现这种情况时先 `Stop-Process` 掉那条 node，再用直接 `node --test` 复核。
  **`npm run test:unit` 20 分钟不结束 vs `node --test` 121–152 s 的差异本片未定位，单独立项**（本片只把超时收窄：
  `collect-g-drill.mjs` 对 `node --test` 这类命令单条上限 15 分钟，挂死不再白等 30 分钟）。
- **真库臂只真跑了三条**（自起集群那条路能通即为证据）；其余臂逐条写「未跑：原因」，**不假装跑过**。
- 那 13 条臂的**读数量**（`READING_GATE_BASELINES`）**不在本页复制**：它们冻结在
  `tests/unit/ci-real-pg-readings-gates.test.mjs` 里，本页只要求「表里每条臂都出现在演练清单里」。
- `docs/verification/README.md` **已严重过期**（它列的页与现存的页对不上）；本片范围不含重写，故只在此记一句。
- 一次性读数的**具体数字无法复算**（日志不入库）：读者能验证的是「形状合法 + 算术自洽 + 绑定本线提交」，
  以及「当时那条命令的 exit code」。这是本机制的诚实边界。
- 演练计划里的 `{logDir}` 是占位符，由 `tools/collect-g-drill.mjs` 换成 `$env:TEMP\gy-g-drill\<sha>`；
  块里保留占位符原文，是为了让页面里的命令**跨机器稳定**（否则每跑一次 sha 变、命令就变）。
- 演练计划里的 `{pgRoot}` 同理，由执行器换成 `GY_DRILL_PG_ROOT`，缺省是 `GY_PG_BIN` 旁边的
  `drill-pgroot`（在本机是 `E:\GengYunCommander\.pg17\drill-pgroot`，**仓外、不入库**）。
  为什么不直接用 `%TEMP%`：本机实测 `initdb` 在 `$env:TEMP\...` 下建数据目录会
  `initdb: error: could not create directory ... Permission denied`（同一套 PG 17.11 二进制在 `.pg17\` 下正常），
  这是**本机文件权限差异**，不是产品缺陷；换机器若 `%TEMP%` 可写可以不设。
- 标记块里的 `sha` 是**采集时那棵树的检出提交**。**本块于 2026-10-28 在 `e80a820a855ac9117fab5c35d432298f98264d18`（`upstream/main`）上重采**：
  这 21 条全部 `@ e80a820a…`，读数来自 `node tools/collect-g-drill.mjs` 的一次完整重跑（21 条命令逐条真跑，
  日志 `%TEMP%\gy-g-drill\e80a820a855ac9117fab5c35d432298f98264d18\`；`readings.json` 的 `sha` 字段就是它），
  再用 `--update` 把读数渲染进块——块内没有一处手改。
  **为什么是这个 sha，而不是原采的 `4d8e476fde96849fba8cb28b8e63becb63bbf2b7`**：那是 `feat/gy-r68-g-drill` 上的代码提交，
  PR #728 以 **squash** 合入成 `e80a820a` ⇒ `4d8e476f` 不再是 main 的祖先，合入后 main 上判据 6 直接红
  （「`sha` 不是 HEAD 的祖先 ⇒ 读数必须绑定本线提交」）。修法是**在 main 上重采**（确实重跑 21 条命令再 `--update`），
  **不是**放宽判据 6，也**不是**把旧读数换个 sha 顶上；原采读数与它绑定的提交照原样留在历史上（就是本行原来的内容）。
  选 `e80a820a` 而不是本分支的新提交，是因为 PR 合入后分支提交同样会失去祖先关系，只有 main 上的提交
  能长期保持「是 HEAD 的祖先」。
  采集时 HEAD 就是 `e80a820a`，工作区唯一的未提交路径是**本页自己**（`readings.json` 记 `dirty: true` / `dirtyPaths: 1`）：
  这是自指——`npm run test:unit` 里的 `tests/unit/g-drill-readings.test.mjs` 读的正是本页的标记块，块里 sha 不先换成
  `e80a820a`，那两条真仓自检就必然红。除本页外的树与 `e80a820a` 逐字相同
  （`git diff e80a820a -- . ':(exclude)docs/verification/gy-r69-drill-full-20261028.md'` 为空）。
  更早那版页里的 21 条是 `1f056b8bf033fdffb33e28e40c038e5e4d7cb372`（采自基线检出 + 本片 5 个未提交新文件），见 §5 第 9 条。
  `--check` 只核「sha 是 HEAD 的祖先」；**sha 解析不到时放行**（`git merge-base --is-ancestor` 返回 0/1 之外的错误码＝「无法判断」）——
  这条放行口子本身就是判据 6 的边界。
- 本页数字是**真跑出来的**：`node tools/collect-g-drill.mjs` 在代码提交上跑完 21 条（含自起 PG 集群的三条真库臂），
  再 `--update` 把读数渲染进块，没有一处手改；`tests` 因此从 5557 变成 5563（新增的 6 条单测：`realPgArms` 下界 /
  臂清单清空 ⇒ 判据 4 红 / `--live` 文案条数 / 工具链缺失归因 / `--live` 退出码 / `readDirty`）。
  采集器现在会记 `dirty` 字段并在工作区不干净时喊话（`--update` 也会提醒）——本片首采是干净的（`dirty: false`）；
  上面那条重采是 `dirty: true` / `dirtyPaths: 1`，那一条未提交路径就是**本页自己**（理由见上一条，不是「代码没提交」）。
- `--live` 在这棵树上跑过，**11 条静态闸门逐条 exit 0**（`npm run lint` 16225ms、`verify-doc-anchors --strict`
  2882ms、`openapi-route-parity` 1648ms 等，都是同一次采集里的现场读数），与块里记的 exit 一致 ⇒ `--live` exit **0**。
  但这**只**证明「这 11 条现在的 exit 与页面写的一样」，不刷新任何一次性读数（unit / suite / pg 三类一条都没碰，见 §5 第 7 条）。
  在**没有** `node_modules` 的机器上 `lint` 会以「未找到本地 TypeScript」失败、`openapi-route-parity` 会以
  `Cannot find package 'fastify'` 失败 ⇒ 这两条按 SKIP 计、`--live` 以 **2** 退出（§5 第 10 条）。
- 为什么本片是**两个提交**而不是一个：`tests/unit/doc-anchor-relocation-identity.test.mjs:1271`
  有一条守卫——`git merge-base HEAD origin/main` 与 HEAD 同提交时**直接判红**（「没有判定面却也不是 CI 浅克隆，
  不允许静默通过」）。所以在基线提交 `1f056b8bf033` 上跑全量单测**必然带 1 条结构性红**（`tests 5557 / pass 5553 /
  fail 1`），实测过两次；只有在「本片自己的提交」上重跑，单测才可能真的全绿。
  **拆两个提交不是唯一可行解**：审查实测把第一个提交那版页面（`git show <第一个提交>:docs/verification/…`）单独拿出来跑
  `--check` 也是 exit 0，所以「一个提交 + 一份页」同样自洽。拆开的理由是让**每个提交自己的证据页都自洽**
  （第一个提交的页记基线读数，第二个提交的页记本片提交上的读数），不是「不这么拆就过不了」。
- `catalog-pg` 那一条需要**外部已起的集群**（本机 `127.0.0.1:55432`，库 `gengyun_catalog_test`，角色 `gy_drill`）：
  它自己**不** `initdb`，只认 `DATABASE_TEST_URL`。另两条（`retention-purge-pg`、`admin-audit-logs-pg`）
  自己 `initdb` 起临时集群，只认 `GY_PG_BIN` + `GY_R34_PG_ROOT`。这三条是「`GY_PG_BIN` 这条本机路径通」的证据，
  不代表 CI 的 `services: postgres` 形态。
- `workflowJobs` 的下界 **25 是零余量**（本树实测正好 25）：它不是「留一点波动的护栏」，而是**故意卡死**——
  防的是「把 job 删掉让闸门变空」。往上加 job 不红（它现在是生长型，只让页面上的 25 滞后，见 §3），把 job 数压到 25 以下才立刻红；
  红了先数 job，别急着调下限（`DEFAULT_FLOORS` 上方的注释也写了：下界只许上调）。`realPgArms` 的 13 同理。
- 判据 8 的白名单是**整段原因的子串匹配**（`docker|网络|SDK|未安装|WSL|容器|端口|凭据|供应商|strip-types` 命中任一即过），
  所以「懒得跑，反正有网络」这类托词夹带一个白名单词也能通过。它挡的是「原因空着」与「明说懒得跑」，
  不挡措辞夹带——这条是已知弱点，靠人读，不靠工具。

## 7. 重新采集的完整顺序

```powershell
git status --porcelain                          # 必须为空：脏工作区采出来的 sha 只代表检出提交（§5 第 9 条）
$env:GY_BASH   = 'D:\Git\bin\bash.exe'
$env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'
$env:PATH      = 'E:\GengYunCommander\.pg17\pgsql\bin;C:\msys64\usr\bin;' + $env:PATH   # psql + awk
npm ci --no-audit --no-fund
node tools/collect-g-drill.mjs                   # 逐条真跑，日志落 $env:TEMP；工作区脏会打印 ⚠
node tools/verify-g-drill-readings.mjs --update  # 只重写标记块内部（读数 dirty 时也会提醒）
node tools/verify-g-drill-readings.mjs --check   # 必须 exit 0
```

`catalog-pg` 还要一个已起的集群（本机这次是这样起的，`initdb` + `pg_ctl` 均在 `GY_PG_BIN` 下）：

```powershell
$pg = 'E:\GengYunCommander\.pg17\pgsql\bin'
& "$pg\initdb.exe" -D 'E:\GengYunCommander\.pg17\drill-catalog' -U gy_drill --auth=trust -E UTF8 --locale=C
& "$pg\pg_ctl.exe" -D 'E:\GengYunCommander\.pg17\drill-catalog' -o '-p 55432' -l 'E:\GengYunCommander\.pg17\drill-catalog.log' start
& "$pg\createdb.exe" -p 55432 -U gy_drill gengyun_catalog_test
$env:DATABASE_TEST_URL = 'postgres://gy_drill:gy_drill@127.0.0.1:55432/gengyun_catalog_test'
```

`collect-g-drill.mjs` 会把这个 `DATABASE_TEST_URL` 只钉在 `catalog-pg` 这一条上（别的命令不受影响）。

`catalog-pg` **要求空库**（它不会自己清表）：同一套集群重跑前必须重建库，否则会以
`catalog 同步要求空库` 之类的断言失败（本机实测：第二次直接重跑 exit 1）：

```powershell
& "$pg\dropdb.exe"   -p 55432 -U gy_drill --if-exists gengyun_catalog_test
& "$pg\createdb.exe" -p 55432 -U gy_drill gengyun_catalog_test
```

`{pgRoot}` 是本机与 `%TEMP%` 权限差异的绕行（见 §6），默认值在 `GY_PG_BIN` 同级目录；设 `GY_R34_PG_ROOT`
可改到任意可写目录。
