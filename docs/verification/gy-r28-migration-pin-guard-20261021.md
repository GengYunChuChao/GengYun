# R28-S92 证据页：真库脚本「本片迁移必须是末位」判据的仓库级静态守卫

- 切片：R28-S92（派单 `.pg17/dispatch/r28-s92-migration-pin-guard.md`）
- 分支：`test/gy-r28-migration-pin-guard`，基点 `upstream/main` = `6d7f2af`
- 新增守卫：`tests/unit/migration-pin-guard.test.mjs`（**离线**：不连数据库、不跑迁移、不读 git 历史、不依赖网络）
- 本片定性：**只加检查，不改脚本**。`tests/integration/**`、`tests/unit/**` 既有文件、`package.json`、`.github/workflows/**`、`deploy/**`、`services/**` 全部一行未改 —— 包括 §5.2 那处「看起来像末位 pin、实际不是」的冗余断言，也**没有**顺手删。

## 0. 一句话结论

把 `tests/integration/*.mjs` 全部 **40** 个文件、**21600** 行、其中 **3515** 行含 `assert` 的行扫了一遍，按三类形态找「本片迁移必须是末位」判据：**8 条命中、0 条未登记**（5 条 D1 注释插值 ＋ 3 条 D3 禁止性注释，逐条理由见 §5）。历史上把 main 弄红过两次的那两段原文（`#341` / `#347` 修前，逐字节从 git 历史抄回）**都仍然会被抓住**：两段各自命中 `last-index + wording`；把这两行种回 40 个真实脚本的副本后，守卫在临时树里 `EXIT=1` 并点名两处，删掉后立刻回到 **12/12 绿**（§6.4）。守卫自身还有两条反向断言：**扫不到文件**与**解析出的断言行数为 0** 都必须抛错（§6.5），否则它会在扫描面消失时假绿。

## 1. 背景：同一个坑踩了两次

| 片 | 位置 | 修法 | 现场 |
| --- | --- | --- | --- |
| `#331` 引入 → `#341` 修（`622448d`） | `tests/integration/ocr-jobs-pg.mjs:256` | 换成「连续无缺号 ＋ `count === max` ＋ `includes(MIGRATION)`」三条结构不变量 | run `39431803337` 的红字：`本片迁移必须是当前末位（现场 0025_recognitions_persistence.sql）` |
| `#333` / `341ad8c` 引入 → `#347` 修（`74ca5e8`） | `tests/integration/recognitions-pg.mjs:280` | 同上 | 0025 先落 main，后合的那条必红 |

两段修前原文（本页与守卫里的常量都以此为准，`git show 622448d^` / `git show 74ca5e8^` 逐字节取出）：

```js
// #341 修前（ocr-jobs-pg.mjs:256）
  assert.equal(names[names.length - 1], MIGRATION, `本片迁移必须是当前末位（现场 ${names[names.length - 1]}）`);
// #347 修前（recognitions-pg.mjs:280）
  assert.equal(names[names.length - 1], MIGRATION, `${MIGRATION} 必须是当前最后一条（本片新增的就是末位）`);
```

为什么这类判据必然把 main 弄红：它把「本片迁移」钉在迁移目录的**末位**上，等于要求「我是最后一个」。两个切片各自都成立，一旦都合进 main 就至少一个不成立；而且它红的时间点是**别人合并之后**，与红的那条 PR 自己改了什么毫无关系。这种形状**静态就能认出来**，不必等 CI 跑一遍真库才暴露。

## 2. 守卫做了什么

### 2.1 扫描面

`tests/integration/*.mjs` 顶层全部文件，用 `readdirSync` **现算**，不写死数量（写死数量等于把「新加一个真库脚本」变成守卫的漏检）。本片实测 **40** 个，非空断言：

- `files.length > 30`（少于这个数说明扫描面或目录结构变了，直接红）；
- `ocr-jobs-pg.mjs` 与 `recognitions-pg.mjs` 必须在扫描面里（两次事故的现场，扫不到就等于守卫在扫别的地方）；
- `lineCount > 0` 且 `assertionLineCount > 0`。

### 2.2 三类命中形态

| 类别 | 抓什么 | 正则 | 为什么这么切 |
| --- | --- | --- | --- |
| D1 `last-index` | 用索引取末位：`names[names.length - 1]`、`files[files.length - 1]`、`x[x.length - 1]` | `\[[^\[\]\n]*\.length\s*-\s*1\s*\]` | **故意不加迁移词过滤**：`applied[applied.length - 1]` 这类判据的同一行里往往一个「迁移」字都没有，加了关键词就会漏。宁可让下一个 `rows[rows.length - 1]` 也来登记一次豁免 |
| D2 `last-value` | 用值取末位：`.at(-1)` / `.slice(-1)` / `.pop()` | 三条独立正则 | 只在**断言语句**里、且该语句含迁移词才报，理由见 §2.4 |
| D3 `wording` | 文案判据：`必须是当前末位` / `必须是当前最后一条` / `必须是最后一条迁移` | 三个短语各自一条 | 不加过滤：这句话要么是 pin 的失败消息，要么是「为什么不再这样断言」的禁止性注释，后者必须登记豁免（现存 3 条） |

D1 的空格写法（`names[names.length-1]`、`files[files.length -1]`）有独立用例逐条验证，避免「新写的人少打个空格就溜过去」。

### 2.3 豁免机制：逐条写理由，且**双向**断言

`ALLOW` 的每条是 `{ file, category, pattern, why }`：`pattern` 对**命中行 trim 后**的文本求匹配，必须窄到不会覆盖同文件另一处代码；`why` 写清「为什么它**不是**迁移末位判据」。

两个方向都判红：

1. 有命中没登记 ⇒ 未登记清单非空 ⇒ 红（点名 `文件:行 [类别] 命中原文`）；
2. 登记的条目**没命中任何一处** ⇒ 陈旧豁免 ⇒ 红。

第 2 条是防「白名单腐烂」：改掉或删掉被豁免的注释/表达式之后忘了删条目，条目就会变成一张永久通行证，以后同文件真的写回末位 pin 时它可能正好接住。

### 2.4 D2 的上下文判定：只认「断言语句」，不认 ±N 行窗口

D2 必须加过滤 —— `routes.at(-1)` / `f.requests.at(-1)` 在本仓有 9 处正当代码（路由与调用记录的末项），不加过滤就得登记 9 条噪音豁免，豁免一多守卫就会被「顺手加一条」拖垮。

第一版实现用的是「命中行 ±2 行里同时出现 `assert` 与迁移词」，**实测误报一条**：`tests/integration/knowledge-native-consumer.mjs:71` 是

```js
list.onHide();list=page('knowledge');list.onShow();assert.equal(list.data.gatePassed,false);assert.match(routes.at(-1),/pages\/login\/login/);
```

它自己跟迁移毫无关系，但**下一行**是同一个文件里给 `report.sourceHashes` 列的清单，含 `services/api/db/migrations/0010_knowledge_read_views.sql` 这个路径 —— 路径里的 `migrations` 命中了迁移词，于是窗口法把这条路由断言判成了迁移末位。这类误报最坏的结果不是红，而是**逼着作者把守卫改宽**。

改成按断言语句取边界：

- 从命中行往回最多 2 行，找最近的含 `assert` 的行当语句起点；
- 起点就是命中行、且该行以 `);` 收尾 ⇒ 单行断言，语句 = 该行；
- 起点在上一行 ⇒ 先检查起点与命中之间有没有已以 `);` 收尾的行（有就说明那是上一条已结束的断言 ⇒ 命中不属于任何断言语句，返回空）；
- 否则从命中行往后最多 2 行，一直到以 `);` 收尾的那一行（多行排版的断言由此被完整覆盖）。

改完 12/12 全绿，上面那条误报消失，而 `assert.equal(names.at(-1), MIGRATION, …)` 依然被抓住。

### 2.5 正确形态为什么能自动放行

`#341` / `#347` 落地后的写法是与位置无关的三条结构不变量：

1. 版本序列 `1..max` 连续无缺号；
2. `MIGRATION_COUNT === LAST_VERSION_NUMBER`；
3. 清单必须含 `MIGRATION`。

守卫用 `invariantProblems()` 把这三条钉住并验证「新增 0026 后依然成立」：新增迁移只是把 `max` 与 `count` 同步变大，三条都不动；而「发现器静默漏项」「编号错位」「有重复」仍然各自变红。f5 就是这段正控制的源码，检测器对它 0 命中。

## 3. 覆盖读数（全部钉在断言或输出里，改一个数就要能解释）

| 项 | 实测 |
| --- | --- |
| 扫描文件 | 40 个（`readdirSync` 现算） |
| 扫描行数 | 21600 行 |
| 含 `assert` 的行 | 3515 行 |
| 命中总数 | 8 条 ＝ `last-index` 5 ＋ `last-value` 0 ＋ `wording` 3 |
| 豁免条目 | 8 条（逐条命中，无未用条目） |
| 未登记命中 | 0 |
| 陈旧豁免 | 0 |
| 测试条数 | 12 条，12 通过 0 失败 |

## 4. 五条内存夹具的读数

`detectHits(source)` 与真实文件走**同一套**判据；夹具只喂字符串，不落盘、不连库。

| 夹具 | 内容 | 期望 | 实测读数 |
| --- | --- | --- | --- |
| f1 | `#341` 改前原文（逐字节） | 红 | 2 条：`1:last-index`、`1:wording` |
| f2 | `#347` 改前原文（逐字节） | 红 | 2 条：`1:last-index`、`1:wording` |
| f3 | `.at(-1)` 版本（三行上下文，命中在第 3 行） | 红 | 2 条：`3:last-value`、`3:wording` |
| f4 | `.slice(-1)` 与 `.pop()` 各一行 | 红 | 4 条：`1:last-value`、`1:wording`、`2:last-value`、`2:wording` |
| f5 | 正控制：三条结构不变量（正确形态） | 绿 | 0 条 |

f1/f2 的断言不止看「有没有红」，还要求红字**原样回显**修前原文那一行 —— 否则下一任作者只看到「有一条命中」却不知道命中了什么。f5 另外用 `invariantProblems()` 验证了 0001..0026 判绿、缺号判红、重复判红。

## 5. 豁免清单：8 条，逐条理由

### 5.1 D1 五条（都不是末位判据）

| # | 位置 | 形态 | 为什么不是判据 |
| --- | --- | --- | --- |
| 1 | `tests/integration/account-suspend-pg.mjs:119` | `note()` 字符串插值 `${versions[versions.length - 1]}` | 只是把目录「最大号」打印进日志，紧接其后写的就是「与本脚本无关」；本脚本 setup 只应用 `name < MIGRATION` 的版本，与目录最大号解耦，不参与任何断言 |
| 2 | `tests/integration/account-suspend-pg.mjs:148` | `assert.equal(applied[applied.length - 1], '0017', …)` | 断的是**本脚本 setup 的固定窗口**末项，不是迁移目录末位，见 §5.2 |
| 3 | `tests/integration/admin-accounts-read-pg.mjs:92` | `note()` 插值（注明「现算」） | 打印迁移目录最大号让真库日志能看出当时到哪一号；不与 `MIGRATION` 比较 |
| 4 | `tests/integration/admin-flags-pg.mjs:130` | `note()` 消息模板参数 | 把目录最大号写进「与 `discoverMigrations()` 逐项一致」的日志行；是字符串内容，不是断言左值 |
| 5 | `tests/integration/messages-pg.mjs:109` | `note()` 插值 `末项 ${versions[versions.length - 1]}` | 同一行 note 的正题是「版本号无重复且严格递增」，打印末项供人读；不含「本片迁移必须是末位」判据 |

### 5.2 关于「现存第三个末位 pin」：**不存在**（附判定证据）

`tests/integration/account-suspend-pg.mjs:148` 是全仓唯一一处「在断言里取末位元素」的代码，初看像第三处 pin，逐行核对后判定**不是**：

```js
// 132-142：applied 只收 MIGRATION 之前的版本，然后手动 push MIGRATION 本身
const applied = [];
for (const name of discovered) {
  if (!(name < MIGRATION)) continue;          // ← 未来迁移（0018+ / 0026+）在这里被过滤掉
  await owner.query(readSql(`migrations/${name}`));
  applied.push(name.slice(0, 4));
}
await owner.query(readSql(`migrations/${MIGRATION}`));
applied.push(MIGRATION.slice(0, 4));
// 143-148
assert.deepEqual(applied, Array.from({ length: 17 }, (_, index) => String(index + 1).padStart(4, '0')), …);
assert.equal(applied[applied.length - 1], '0017', …);
```

`applied` 的构成与迁移目录的最大号无关：目录里再加 0026／0027，它仍然是 `0001..0017`，所以第 148 行**恒真**，不会随新迁移变红 —— 它不具备末位 pin 的致命性质，且上一行 `deepEqual` 已把 `0001–0017` 逐项钉住，这条只是冗余。

因此本片**没有**需要「登记＋豁免＋标注待后续切片处理」的第三处 pin。但按派单口径仍把它登记进 `ALLOW`（不登记就会被 D1 抓红），理由栏写明「属冗余断言（可后续切片删掉），不是末位判据」，并在 §8 记为遗留项：**这条冗余断言要不要删，留给后续切片决定；本片不许改既有文件，所以只登记不改**。

### 5.3 D3 三条（禁止性注释）

| # | 位置 | 为什么不是判据 |
| --- | --- | --- |
| 6 | `tests/integration/ocr-jobs-pg.mjs:256` | `#341` 的修复说明：写的是「这里**不再**断言本片迁移必须是当前末位」，并说明后续切片（0025 起的识别域、语音转写…）必然追加更大版本号。注释不可能成为判据 |
| 7 | `tests/integration/ocr-jobs-pg.mjs:259` | 同一条注释的第 4 行：引用 CI run `39431803337` 与当年失败消息原文，属事故留痕 |
| 8 | `tests/integration/recognitions-pg.mjs:280` | `#347` 的修复说明：说明「0001..0025 是本片现状，后续切片必然追加更大版本号」，正是该判据被解除的理由 |

## 6. 负控制

### 6.1 f1 / f2：两段历史原文 ⇒ 必红

`[history] #341（ocr-jobs-pg.mjs:256，622448d 之前） ⇒ last-index, wording`；`[history] #347（recognitions-pg.mjs:280，74ca5e8 之前） ⇒ last-index, wording`。两条都同时命中 D1 与 D3，且命中行文本与原文逐字节相等。

### 6.2 f3 / f4：`last-value` 三种写法 ⇒ 必红

`[f3] 2 条：3:last-value, 3:wording`、`[f4] 4 条：1:last-value, 1:wording, 2:last-value, 2:wording`。只命中 `last-value` 不命中 `last-index`，说明 D2 不是靠 D1 蹭出来的。

### 6.3 f5：正控制 ⇒ 必绿

`[f5] 0 条命中（期望 0）`。同一段源码里的 `assert.deepEqual(missing, [])`、`assert.equal(discovered.length, max)`、`assert.ok(names.includes(MIGRATION))` 一条都不误伤 —— 检测器抓的是「取末位」这个动作，不是「提到了迁移」。

### 6.4 真·变异：把改前原文种回 40 个真实脚本的副本

夹具是内存里的字符串，为了证明守卫在**真实文件形状**上也咬得住，另做了一次仓外演练（脚本在 `E:\GengYunCommander\.pg17\tmp\mutation-drill.mjs`，不进仓）：

- 把 `tests/integration/` 40 个文件与守卫本身复制到临时树，只往 `ocr-jobs-pg.mjs`、`recognitions-pg.mjs` 末尾各追加一行改前原文（其余 38 个文件原样）；
- 在临时树里跑 `node --test --test-concurrency=1`，守卫按 `import.meta.url` 推出的根目录正好是临时树，等价于「本仓被改脏」：

```
[scan] 文件 40 个（实测，不写死数量），行 21604 行，断言行 3517 行
[scan] 文件 40 个；命中 12 条；豁免 8 条；未登记 4 条；失效豁免 0 条
  [NEW  ] tests/integration/ocr-jobs-pg.mjs:848 [last-index] assert.equal(names[names.length - 1], MIGRATION, `本片迁移必须是当前末位（现场 ${names[names.length - 1]}）`);
  [NEW  ] tests/integration/ocr-jobs-pg.mjs:848 [wording] assert.equal(names[names.length - 1], MIGRATION, `本片迁移必须是当前末位（现场 ${names[names.length - 1]}）`);
  [NEW  ] tests/integration/recognitions-pg.mjs:1010 [last-index] assert.equal(names[names.length - 1], MIGRATION, `${MIGRATION} 必须是当前最后一条（本片新增的就是末位）`);
  [NEW  ] tests/integration/recognitions-pg.mjs:1010 [wording] assert.equal(names[names.length - 1], MIGRATION, `${MIGRATION} 必须是当前最后一条（本片新增的就是末位）`);
ℹ tests 12 / ℹ pass 11 / ℹ fail 1
```

`EXIT=1`，且 `未登记 4 条` 恰好是两处 × 两类 —— 没多抓一处、也没少抓一处。同一批文件**不种**这两行再跑一次：`EXIT=0`、`ℹ tests 12 / ℹ pass 12 / ℹ fail 0`。行号 `848` / `1010` 是「追加到文件末尾」的产物，与历史行号 256 / 280 不同，属预期。

⚠ 上块两处行号是**临时树副本**的末位行号，本仓同名文件里没有对应行可指：`ocr-jobs-pg.mjs` 的「末位」断言已按 #341 删除（现文件第 275-278 行注释写明不再断言），`recognitions-pg.mjs` 的同类断言也随后清理。因此这两处引文在 `tools/doc-anchors-baseline.json` 里按「引文不是仓内锚点」登记，不当作仓内行号锚点使用，也不据此推断任何实现位置。

### 6.5 守卫自身的反向断言

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 扫描面里一个 `.mjs` 都没有 | 抛错，不许静默变绿 | `扫描面为空：… 下没有任何 .mjs —— 拒绝在「什么都没扫到」的情况下变绿` |
| 扫到文件但一行 `assert` 都没有 | 抛错 | `解析出的断言行数为 0：… —— 扫描面里已经没有真库脚本了，守卫会假绿` |

第二条针对的是更阴的失效方式：目录还在、文件还在，但内容被替换成了空壳/占位文件，此时若只看「文件数」守卫会全绿。

## 7. 门禁

全部在本工作树 `E:\GengYunCommander\wt-r28-s92` 内逐条执行，退出码逐条记录。

| # | 门禁命令 | exit | 末行 |
| --- | --- | --- | --- |
| 1 | `npm run lint` | 0 | `lint 通过（静态检查；不代表运行期或真实服务已通过）。` |
| 2 | `node tools/verify-release-materials.mjs` | 0 | `15/15 项通过（离线文档核验；不代表部署、云端或运行期已验收）` |
| 3 | `npm run test:docs` | 0 | `PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住` |
| 4 | `node --test --test-concurrency=1 "tests/unit/migration-pin-guard.test.mjs"` | 0 | `ℹ duration_ms 151.5482`（计数行 `ℹ tests 12` / `ℹ pass 12` / `ℹ fail 0`） |
| 5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | `ℹ duration_ms 126.2851`（计数行 `ℹ tests 6` / `ℹ pass 6` / `ℹ fail 0`） |
| 6 | `git diff --check` | 0 | 无输出 |

门禁 4／5 用的是 `node --test`，它输出的**字面最后一行**是 `ℹ duration_ms …`；`ℹ fail 0` 在它上面第四行，上表两行都记，免得「末行」被理解成 `fail 0`。

## 8. 未取得（明确的能力边界）

1. **只认三类形态**：`names[names.length - 1]` / `.at(-1)` / `.slice(-1)` / `.pop()` 与三句文案。换个写法表达同一个意思就抓不到，例如 `names[names.length - 1]` 写成 `names.slice(-1)[0]` 会被 D2 抓到（已覆盖），但写成 `names[names.length + -1]`、`names.reverse()[0]`、`names.pop()` 之外的自制 `lastOf(names)` 助手函数则不在判据里 —— 守卫是**形状匹配**，不是数据流分析。
2. **`.pop()` 与迁移词同句才报**：D2 需要断言语句里出现迁移词。`assert.equal(names.pop(), MIGRATION, …)` 会被抓（f4 已验证），但若有人把迁移清单先 `pop()` 存进变量、再在另一条断言里比较，跨语句的关联本守卫不追。
3. **不判断语义等价**：「必须含 `MIGRATION`」与「必须是末位」在单迁移目录下等价，但前者对新迁移自动放行、后者不放行 —— 本守卫只保证「不出现末位形状」，不保证作者改用结构不变量之后**逻辑还对**。行为断言仍在各真库脚本里（需要 `npm run test:integration` 与真实 PG，本片不跑）。
4. **不做 git 历史扫描**：守卫只读工作树当前内容，历史里的 pin 之所以能被证明抓到，是靠 §6.1 的两段原文常量与 §6.4 的临时树演练，而不是「守卫会去遍历历史」（那会让每次运行都依赖完整克隆与网络/浅克隆状态）。
5. **豁免清单是人工维护的**：`why` 的正确性无法自动校验，只有「条目必须命中」这一条机器兜底。新增豁免仍需人读一遍理由。
6. **`account-suspend-pg.mjs:148` 的冗余断言未删**：本片不允许改既有文件，登记为豁免＋遗留项；若后续切片要清理，删那一行即可（删后 `ALLOW` 对应条目会变成陈旧豁免并判红，正好提醒同步删条目 —— 这是设计意图，不是缺陷）。

## 9. 复现

```
cd E:\GengYunCommander\wt-r28-s92
node --test --test-concurrency=1 "tests/unit/migration-pin-guard.test.mjs"
```

测试输出会逐行打印 §3 的读数（文件数／行数／断言行数／命中与豁免计数）、§5 全部 8 条豁免的 `文件:行 [类别] 命中原文`、§4 五条夹具的逐条读数，以及 §6.1 两段历史原文的命中类别。临时树演练（§6.4）不在仓内，需要时重跑 `.pg17/tmp/mutation-drill.mjs`（不提交）。
