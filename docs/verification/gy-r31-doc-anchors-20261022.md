# GY-R31 文档手写行号闸门（2026-10-22）

## 1 缺口

`#456` 的 `--reanchor` 让 `contract-status.json` 里 412 条 `source_anchor` 能在代码漂移后自动重定位，但 `docs/**` 散文里手写的 `路径:起-止` 没有任何机械校验：代码一动，行号就漂，文档继续当「实现就在这几行」的证据。本片补上这条缺口（`tools/verify-doc-anchors.mjs`、`tools/doc-anchors-baseline.json`）并给出本地聚合入口 `npm run verify:anchors`。不改业务代码，不碰 `#456` 在飞的 `tools/contract-status-core.mjs` 与 `tools/verify-contract-status.mjs`。

## 2 扫描范围

- 默认两面：`docs/architecture/**/*.md`（9 份）+ `docs/verification/**/*.md`（209 份），合计 218 份（本页落盘前的读数；本页加入后 219 份，计数不变——本页按第 10 节的约定不写 `路径:行号` 形态）。
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

## 7 基线：108 条已知遗留

`tools/doc-anchors-baseline.json`（受版本控制，`schema_version` 1）逐条含 `path`／`reason`／`owner`／`reference`。`--strict` 只报「基线之外新增」，修好的条目会变「陈旧」并由单测点名要求删除。

| reason | 条数 | owner 分布 | 典型形态 |
| BROKEN | 30 | repo 28、api-server 2 | 引用 `.pg17/` 本地未提交笔记 8 条；`probe-reverse-control.sql` 3 条是负控制里**故意不存在**的探针名；其余是裸文件名对不上（旧名或未提交的脚本） |
| OUT_OF_RANGE | 8 | repo 5、api-server 2、deploy 1 | 2 条是故意写成 99999 的越界探针；其余是 README／迁移脚本／集成脚本的行号真漂移 |
| SUSPECT | 70 | api-server 30、repo 18、docs 9、miniprogram 8、deploy 3、contracts 2 | 行号指到空行或纯收尾括号，例如 `app.ts` 第 1641 行是空行、`contract-status.json` 第 370 行是 `}` |

合计 108 条，按 owner：repo 51、api-server 34、docs 9、miniprogram 8、deploy 4、contracts 2。

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
