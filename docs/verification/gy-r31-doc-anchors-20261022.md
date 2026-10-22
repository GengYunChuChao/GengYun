# GY-R31 文档手写行号闸门（2026-10-22）

## 1 缺口

`#456` 的 `--reanchor` 让 `contract-status.json` 里 412 条 `source_anchor` 能在代码漂移后自动重定位，但 `docs/**` 散文里手写的 `路径:起-止` 没有任何机械校验：代码一动，行号就漂，文档继续当「实现就在这几行」的证据。本片补上这条缺口（`tools/verify-doc-anchors.mjs`、`tools/doc-anchors-baseline.json`）并给出本地聚合入口 `npm run verify:anchors`。不改业务代码，不碰 `#456` 在飞的 `tools/contract-status-core.mjs` 与 `tools/verify-contract-status.mjs`。

## 2 扫描范围

- 默认两面：`docs/architecture/**/*.md`（9 份）+ `docs/verification/**/*.md`（209 份），合计 218 份（**本页落盘时**的读数；本页加入后 219 份，计数不变——本页按第 10 节的约定不写 `路径:行号` 形态。合流当前 `main` 后该面已扩到 239 份，见 §12）。
- `--scan <目录或 glob>` 可扩面；`--root <目录>` 指向夹具树（单测用，不写仓库）；`--baseline <路径>` 换基线文件。
- 跳过依赖与产物目录（`node_modules`／`.git`／`dist`／`coverage`／`.pg17`／`.venv` 等）：`.pg17` 下的本地笔记不是仓内证据，引用它的行号会如实判 BROKEN，而不是被「跳过」洗绿。

## 3 抽取口径

- 只认 `路径:起-止` 与 `路径:单行` 两种形态；路径扩展名走白名单（`ts/tsx/js/mjs/sql/md/json/yml/yaml/css/html/py/sh/ps1/toml` 等）。
- 因此 `10.20.0.0:16` 这类 IP:端口、`https://example.com/foo.ts:12` 这类 URL 不会被误抽成仓内引用（前者扩展名不在白名单，后者按 `://` 前缀排除）。
- 路径解析四档：仓库根相对 → 文档所在目录相对 → 唯一后缀匹配（`messages/store-pg.ts` 对 `services/api/src/messages/store-pg.ts`）→ 同名多文件记 ambiguous。ambiguous 只计数不判红：工具不替作者选文件。

## 4 三类判据

| 类别 | 触发条件 | 读数里带什么 |
| BROKEN | 引用里的路径在仓库里找不到（也没有唯一同名文件可解析） | 「路径在仓库里找不到」 |
| OUT_OF_RANGE | 路径找到了，但起止超出该文件行数 | 该文件真实行数（如「该文件 272 行」），让人一眼看出差多少 |
| SUSPECT | 行号在文件内，但区间里没有任何实质内容行（全空行／纯收尾括号） | 「区间内没有任何实质内容行（全空行／全右括号）」 |

- 实质内容的判据与 `tools/verify-contract-status.mjs` 的 `isSubstantiveLine` 同源：trim 后非空，且不是纯收尾（`}`／`});`／`];`／`},` 这类）。一处口径两处用，免得同一个仓库里对「有没有内容」有两种答案。
- 另有两类**只计数不判红**：区间首行为空行 61 条、区间全是注释行 345 条。注释行不算「无内容」是刻意的——证据页引用 workflow 里说明不变量的注释是合法证据形态，把它判 SUSPECT 只会把几百条写对了地方的引用打成噪声，淹掉真正指到空白/收尾括号的假引用。

## 5 为什么不用「内容 sha256 全等」

- 判据错位：sha256 判的是「文件有没有被改过」，不是「文档是不是假证据」。加一行日志、改一个错别字、跑一次格式化都会红，而红的原因与「文档描述是否还成立」无关。
- 行号引用天生是区间：任何插入或删除都会让后续行号漂移，这正是本闸门要报的信号；哈希全等连「这个区间还有没有意义」都不判。
- 消红路径只有一条：把文档里的哈希自动重写成新值。那等于把「内容是否正确」换成机械打卡，与「手工改小 `lines` 凑 ±2 容差」是同一类作弊。
- 结果是门禁被红成常数，最后整片关掉或整片塞进白名单——用噪声换掉真信号。
- 本工具只判结构事实：路径在不在、行号在不在文件内、区间里有没有实质内容。「这段内容是否仍描述同一实现」留给人工与契约台账的 `source_anchor`。

## 6 实测计数（dry-run）

```
SCAN: 文档 218 份；抽出「路径:行号」引用 3360 条（解析成功 3186 条、同名多文件无法唯一解析 133 条不计红、同文档重复 26 条已去重）
COUNT: BROKEN 30 / OUT_OF_RANGE 8 / SUSPECT 70（合计 108 条；另只计数不判红：区间首行为空行 61 条、区间全是注释行 345 条）
BASELINE: tools/doc-anchors-baseline.json 登记 108 条；本次命中 108 条、基线外新增 0 条、陈旧 0 条
MODE: dry-run（只打印，不判退出码）
```

`node tools/verify-doc-anchors.mjs --strict` 实测 exit 0，末行 `PASS: --strict 下没有基线之外的新增（基线内条目只计数、不判红；陈旧条目见 STALE）`。`--strict` 不打印全量清单（上百条历史遗留会把台账工具的 PASS 行淹掉），失败清单走 stderr。

> 上列 218 份／108 条是**本页落盘时**的读数，不是当前读数：合流 `main` 后文档面扩到 239 份、基线已按现状重生。同一棵树在合流后又漂出 10 条新增与 7 条陈旧条目，逐条校准与两侧读数见 §12。

## 7 基线：落盘时 108 条已知遗留（当前 112 条，见 §12）

`tools/doc-anchors-baseline.json`（受版本控制，`schema_version` 1）逐条含 `path`／`reason`／`owner`／`reference`。`--strict` 只报「基线之外新增」，修好的条目会变「陈旧」并由单测点名要求删除。

| reason | 条数 | owner 分布 | 典型形态 |
| BROKEN | 30 | repo 28、api-server 2 | 引用 `.pg17/` 本地未提交笔记 8 条；`probe-reverse-control.sql` 3 条是负控制里**故意不存在**的探针名；其余是裸文件名对不上（旧名或未提交的脚本） |
| OUT_OF_RANGE | 8 | repo 5、api-server 2、deploy 1 | 2 条是故意写成 99999 的越界探针；其余是 README／迁移脚本／集成脚本的行号真漂移 |
| SUSPECT | 70 | api-server 30、repo 18、docs 9、miniprogram 8、deploy 3、contracts 2 | 行号指到空行或纯收尾括号，例如 `app.ts` 第 1641 行是空行、`contract-status.json` 第 370 行是 `}` |

合计 108 条，按 owner：repo 51、api-server 34、docs 9、miniprogram 8、deploy 4、contracts 2。

> 本表是**本页落盘时**的分布。合流 `main` 后基线先按现状重生到 119 条（BROKEN 35／OUT_OF_RANGE 8／SUSPECT 76），本轮再校准掉全部新增引用、删掉 7 条已失效登记，最终 112 条（BROKEN 35／OUT_OF_RANGE 8／SUSPECT 69）。逐条处置见 §12。

基线的两条反查由单测咬住：每条既有条目**必须仍然命中**（修好一条就要求删一行，防止基线慢慢变成免罚名单）；且当前扫描必须仍覆盖 ≥100 份文档、≥1000 条解析成功（防止有人把扫描面改小来「变绿」）。

## 8 负控制读数

夹具用 `--root` 指向临时目录（`mkdtemp` 建、跑完删），三条负控制各占一份文档：

| 负控制 | 夹具构造 | 实测读数 |
| ① 路径不存在 | 文档写 `src/missing.ts` 的第 1-9 行，仓里没有该文件 | BROKEN 1 条，说明串「路径在仓库里找不到」；同夹具的合法引用不陪绑 |
| ② 起止超范围 | 5 行文件引用第 4-999 行 | OUT_OF_RANGE 1 条，说明串「行号超出文件行数（该文件 5 行）」 |
| ③ 全空行／右括号 | 区间落在两空行加一条收尾括号 | SUSPECT 1 条，说明串「区间内没有任何实质内容行（全空行／全右括号）」 |

夹具汇总行（实测）：`COUNT: BROKEN 1 / OUT_OF_RANGE 1 / SUSPECT 1（合计 3 条；另只计数不判红：区间首行为空行 1 条、区间全是注释行 1 条）`。同夹具在空基线下 `--strict` 实测 exit 1；把三条写进基线后 exit 0。

正向控制（防「永远红」与误伤）：干净文档集 exit 0；同一份合法引用既写全路径也写相对子路径都不陪绑负控制；引用纯注释行只进「区间全是注释行」计数、不入 findings。

`node --test tests/unit/doc-anchors-guard.test.mjs tests/unit/verify-anchors-script.test.mjs` 实测 15 条全过（含 stale 反查与「既有 16 个脚本一个都没少」）。

## 9 接线

- `package.json` 新增**唯一**聚合脚本：`"verify:anchors": "node tools/verify-contract-status.mjs && node tools/verify-doc-anchors.mjs --strict"`。既有脚本一个都没改（单测冻结了 16 个既有脚本名）。
- `docs/development-guide.md` 第 6 节命令表加一行，并在表后加两条散文：先跑哪一条、三类判据是什么、`AGENTS.md` 的「契约台账锚点维护」小节管什么（只做指针，不复制其内容——那节属 `#456`，本片不改 `AGENTS.md`）。
- 单测 `tests/unit/verify-anchors-script.test.mjs` 静态读 `package.json` 做字符串断言：脚本存在、串的确实是这两个工具、台账在前、用 `&&` 且不得出现 `;`／`|| true`／`--force` 之类吞失败写法（⛔ 不在单测里 spawn，免得 CI 变慢）。
- 实测 `npm run verify:anchors` exit 0：台账 6 行 `PASS`，本工具 `SCAN`／`COUNT`／`BASELINE` 三行 + `PASS: --strict`。

## 10 本片不覆盖

1. `source_anchor` 之外的散文行号：`contract-status.json` 的 412 条锚点由 `#456` 的 `--reanchor` 管；证据页正文里「上一节第 3 条」「见下文」「第 63 行」这类不带路径的指代，本工具抽不到，也不猜。
2. 跨文件符号引用：`isSubstantiveLine`、`Foo.bar()` 这类符号级引用不做存在性／唯一性校验（函数改名后文档照样绿），需人工或契约台账覆盖。
3. 同名多文件无法唯一解析的 133 条只计数、不判红：工具不替作者选文件。
4. 引用写得不唯一（把 `deploy/postgres-cvm/README.md` 写成裸 `README.md`）会按根上那一份算——不加目录就没人能复原它指哪份文件，修法是把路径写全，不是把工具放宽。
5. 本页自身也遵守第 1 条：不写 `路径:行号` 形态，所以本页加入前后 `COUNT` 都是 108。

## 11 最该人工修的三处

1. [contract-implementation-status.md](../architecture/contract-implementation-status.md) 第 63 行把 `deploy/postgres-cvm/README.md` 的 459 行写成裸 `README.md`，落到根 README（272 行）→ OUT_OF_RANGE。写全路径即可。
2. `docs/verification/gy-r28-speech-persist-20261021.md` 第 17 行引用的 `app.ts` 第 1641 行是空行 → SUSPECT；语音持久化的证据实际落在相邻的注释行。
3. `docs/verification/gy-r28-favorites-history-grants-20261020.md` 第 187 行引用 `experiment-locking.sql` 第 67 行，全仓没有这个文件 → BROKEN（旧名或未提交的 SQL）。

另有一页级问题：`docs/verification/gy-i02-evidence-index-20261015.md` 有 8 条引用指向 `.pg17/` 下的本地笔记，不可提交、别人复现不到，证据索引应改指仓内文件或删掉这些行。

## 12 合流当前 main 后的锚点校准（2026-10-22，第二轮）

§6／§7 是**本页落盘时**（218 份文档）的读数。此前那次「合流 main 后重生基线 110→119」只重写了基线 JSON，本页读数没跟着改，页内数与仓内基线一度不一致；本节把两侧对齐到同一次实测。

校准面：把当时的 `upstream/main`（`489804e4`）合入本分支（无冲突），得到与「main ＋ 本 HEAD」等价的实际合成树；**下列读数全部在该树上跑出**。本分支不改产品代码，故 `app.ts` 等目标文件与 `489804e4` 逐字节相同。

### 12.1 校准前：合成树上只读严格检查失败

```
SCAN: 文档 239 份；抽出「路径:行号」引用 4055 条（解析成功 3825 条、同名多文件无法唯一解析 183 条不计红、同文档重复 29 条已去重）
COUNT: BROKEN 35 / OUT_OF_RANGE 8 / SUSPECT 79（合计 122 条；另只计数不判红：区间首行为空行 69 条、区间全是注释行 471 条）
BASELINE: tools/doc-anchors-baseline.json 登记 119 条；本次命中 112 条、基线外新增 10 条、陈旧 7 条
MODE: --strict（只在新增加非零时 exit 1）
```

exit 1，末行 `FAIL: 文档行号闸门未通过（基线之外新增 10 条）`。

### 12.2 10 条新增：逐条改到真实归属块

先按文档里的**引文/符号**在现行代码里定位，再改行号——不是按「原行号 +delta」平移，也不是改小到凑「有内容」：

| # | 文档（行） | 原引用想指的代码 | 校准后 | 判据（现行树实测） |
| --- | --- | --- | --- | --- |
| 1 | `gy-r30-public-posting-gate-20261022.md` 第 17 行 | `registerCommunityRoutes(...)`，全仓唯一调用点，已传 `{ consent: consentGate }` | app.ts 第 1842 行 | 全仓仅此一处调用；该注册块随媒体/会话装配整体前移 |
| 2 | 同页第 39 行 | 带 `public_posting` 的**注释**（「登记/注释类命中，不构成校验」） | app.ts 第 1841 行 | 全文件 `public_posting` 现只剩这一处注释 |
| 3 | 同页第 101 行 | 探针「走的那一条真实装配路径」 | app.ts 第 1842 行 | 与第 1 行同一条路径 |
| 4 | 同页第 282 行 | 「现收 `{ consent: consentGate }`」 | app.ts 第 1842 行 | 同上；该处与第 101 行同串，按去重规则只点在前三条上 |
| 5 | `gy-stall-hygiene-20261019.md` 第 107 行 | 社区 store 由 `app.ts` 内部默认创建 | app.ts 第 793 行 | `const communityStore: CommunityStore =`，默认分支在紧随的 794–800 行 |
| 6 | `gy-r28-w2-media-ports-20261021.md` 第 23 行 | `setErrorHandler`（按契约映射成 503） | app.ts 第 1862 行 | 全文件唯一一处 `app.setErrorHandler(` |
| 7 | `gy-r31-media-port-20261022.md` 第 81 行 | `buildApp` 解构里新增的 `ocrMedia` | app.ts 第 662 行 | 该行是 `buildApp` 的解构参数表，逐字含 `ocrMedia` 与 `speechMedia` |
| 8 | `gy-i16-i17-deletion-cascade-20261021.md` 第 97 行 | `MessagesStore` 接口（无 purge/deleteAll 原语） | messages/store.ts 第 119 行 | `export interface MessagesStore {`，方法清单与该行原文逐字相符；第 154 行同串一并改 |
| 9 | `gy-recog-chain-20261019.md` 第 17 行 | 链成员必须严格 `node <路径>`，带 flag 即红 | ci-integration-chain-structure.test.mjs 第 332 行 | 断言失败信息「必须严格是 `node <路径>`（不得带 flag／重定向／子 shell）」就在该行 |
| 10 | 同页第 194 行 | 同上（引用同一判据） | ci-integration-chain-structure.test.mjs 第 332 行 | 同上 |
| 11 | `contract-implementation-status.md` 第 40 行（**生成区**） | `registerJobRoutes(app, config, guards, createJobRegistry([...]))` 与六源分派 | app.ts 第 1770 行 | 六源依次在第 1771／1777／1780／1786／1794／1802 行，整块前移 104 行；见 §12.5 |

顺带校准（非门禁点名，但同一列表里按文档自带引文可机械核对）：`gy-r31-media-port-20261022.md` 第 78 行的 `app.ts` 行号（`BuildAppOptions` 的 `ocrMedia?:` 字段，改到第 353 行）与第 82 行的装配行（改到第 1764 行）。同一列表里第 76 行的 import 行仍在原位，第 85／87 行的两个测试区间经复核仍覆盖所引结构，未动。

### 12.3 7 条陈旧：先校准引用、再删登记

陈旧**不等于**已修好：漂移把这些引用推到了「有内容」的行上，闸门因此不再报，但指的已不是原代码。故本轮先按内容找到真实归属块、改准引用，再删掉已失效的登记：

| # | 基线登记（path／reference） | 引用它的文档（行） | 校准后 | 判据（现行树实测） |
| --- | --- | --- | --- | --- |
| 1 | app.ts／`app.ts` 第 1554 行（裸写法） | `gy-r28-e6-closure-materials-20261021.md` 第 131、284 行 | app.ts 第 1579 行 | `available: config.executionMode !== 'real'`（注销 HTTP 面整域 503） |
| 2 | app.ts／`services/api/src/app.ts` 第 1554 行 | 同页第 66、82、145 行 | app.ts 第 1579 行 | 同上（同一断言的三处复述） |
| 3 | app.ts／`app.ts` 第 425 行（裸写法） | `gy-i19-user-backup-copies-design.md` 第 27 行 | app.ts 第 451 行 | `userDataDeletionInjection?: { backupPurge?: BackupPurgePort; requests?: DeletionRequestStore \| null };` |
| 4 | app.ts／`services/api/src/app.ts` 第 425 行 | `gy-i19-backup-domain-20261018.md` 第 202 行 | app.ts 第 451 行 | 同上——该行原文逐字引用了这条声明 |
| 5 | app.ts／`services/api/src/app.ts` 第 1659 行 | `contract-status.json` 的 5 条 `blocker` 散文（生成到对照表第 80–84 行）＋ `gy-r27-ocr-persist-20261020.md` 第 403 行 | app.ts 第 1764 行 | 装配行把 `ocrPersistencePool` 作为第 4 个实参传给 `registerOcrRoutes`；变量本身定义在第 1763 行（故「计算」那一处指向第 1763 行） |
| 6 | app.ts／`services/api/src/app.ts` 第 873 行 | `gy-i06-private-media-20261014.md` 第 277 行 | app.ts 第 1019 行 | `media: synthesisMedia ?? createSynthesisMediaPort(config.executionMode),`（合成域装配） |
| 7 | app.ts／`services/api/src/app.ts` 第 873 行（同串第二条） | `gy-r31-i29-withdraw-deps-20261014.md` 第 86 行 | app.ts 第 882 行 | `const egressLedger = egressPoolUsable ? createPostgresExportLedger({ pool }) : null;` |

第 6／7 条是同一条基线串被两份文档引用（故旧基线里有两行相同条目），两份文档指的**不是同一段代码**，因此分别校准到不同行——这也是「按内容定位」而不是「按串平移」的直接理由。

### 12.4 校准后读数（同一棵合成树）

```
SCAN: 文档 239 份；抽出「路径:行号」引用 4055 条（解析成功 3825 条、同名多文件无法唯一解析 183 条不计红、同文档重复 26 条已去重）
COUNT: BROKEN 35 / OUT_OF_RANGE 8 / SUSPECT 69（合计 112 条；另只计数不判红：区间首行为空行 65 条、区间全是注释行 464 条）
BASELINE: tools/doc-anchors-baseline.json 登记 112 条；本次命中 112 条、基线外新增 0 条、陈旧 0 条
MODE: --strict（只在新增加非零时 exit 1）
PASS: --strict 下没有基线之外的新增（基线内条目只计数、不判红；陈旧条目见 STALE）
```

exit 0。SUSPECT 79→69 正好是修掉的 10 条新增；BROKEN 35 与 OUT_OF_RANGE 8 一条未动（本片不碰历史遗留，也不把容差改小）；基线 119→112，减掉的 7 条全部是上面逐条校准掉的失效登记。

基线重生走工具自身的合法流程（`--write-baseline`），**先改引用、后重生**，并对产物逐行核对：`git diff` 为 **42 行删除、0 行新增、无重排**，即只删掉那 7 条（每条约 6 行），没有把任何新问题塞进基线。

### 12.5 台账生成区的联动（`contract-status.json`）

`contract-implementation-status.md` 的对照表是**生成区**，手改会被 `--write-doc` 的整体重写覆盖，也会让「生成表与 JSON 字节一致」这条断言失效。故第 11 条的修法分两步：

1. 改 `docs/architecture/contract-status.json` 里两条 `blocker` 散文中的行号（六源块 `app.ts` 行号与 `ocrPersistencePool` 装配行），并把该句的「本基线」标记从旧的 `1794052` 改成 `489804e4`（这些行号就是在新基线上实测的）；
2. 跑 `node tools/verify-contract-status.mjs --write-doc` 重生，末行 `PASS: 中文表格一致`；再跑不带参数的 `node tools/verify-contract-status.mjs`，exit 0。

⛔ 未改任何 `status`／`route_mounted`／`evidence` 语义字段；`--reanchor` 未参与——它只重写 `evidence[].lines` 的数值，管不到散文里的行号。另：`--write-doc` 会把该文件写成 LF，而仓内 blob 是 CRLF（`core.autocrlf=false`），故写回后还原为 CRLF，使 diff 只落在真正改动的 6 行上，而不是整文件 200 行。

### 12.6 未取得与不在本片

1. **结构闸门看不到「指到有内容的错块」**：本轮只校准门禁点名的 17 条（10 新增 + 7 陈旧），加同一列表里能按文档自带引文机械核对的 2 条；其余散文行号未逐条复核（工具第 10 节已声明这条边界）。
2. **未跑 PG 真库臂与全量单测**：本片只改文档、基线与台账散文行号，未触业务代码；定向单测见 PR 上的读数。
3. 本页按第 10 节的约定仍不写 `路径:行号` 形态（本节所有行号都以「文件名 + 第 N 行」叙述），故本节加入前后 `SCAN` 的 239 份／4055 条不变。
