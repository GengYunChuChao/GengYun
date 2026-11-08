# 契约 ↔ 运行期请求体 schema 字段级等价守卫（GY-R90，2026-11-09）

> 读数快照：2026-11-09（Asia/Hong_Kong），基线 `9f09fcb3bf36d0ded290fb1187465e0b8550fdf1`（`origin/main`）。
> 本分支只动两个文件：`tests/unit/contract-runtime-schema-parity.test.mjs` 与本页；两个文件都已随
> `#1117`（`8ec79f84`）进过一次 main，本 PR 是对它们**再加一层修复**的增量。
> `packages/contracts/openapi.json`、`services/api/src/**`、`tools/**`、`.github/**` 一个字节都没提交改动 ——
> §五 的落盘变异都在 `services/api/src/routes/profile.ts`、`services/api/src/routes/community.ts` 上做、
> 跑完逐字还原（`git diff --quiet` 复验 exit 0）。
> **承接 `#1117`（已合并，合并前 P1 未落地）**：独立审查在 `#1117` 的初版上打出 P1 —— 文档键过滤被用在
> **所有层级**，于是 `PostInput` 里那个恰好叫 `title` 的 required 属性被整块丢掉。`#1117` 在 `8ec79f84`
> 被 `gengyun-supervisor` 合并，所以**这个假绿现在就活在 main 上**；§五 5.0 是它在 main 上的现场复现
> （运行期把 `title.maxLength` 改成 200，main 版测试仍然 12/12 全绿），不是推理。修复与回归钉子见
> §三 规则 5/6、§五 5.6–5.8、§六 末几行；**初版 §一句话 与 §六 的表述因此收窄**（见下）。

## 一句话

`tests/unit/contract-runtime-schema-parity.test.mjs` 把 4 条路由的**契约请求体 schema** 与**运行期真正注册给
Fastify 的那一份**逐字段比：今天 4/4 等价。比较面覆盖 `properties` 里**每一个**子 schema，包括名字恰好叫
`title`/`description`/`examples` 这类「文档键同名」的属性（§三 规则 5），所以少一个 `required`、多一个字段、
把 `additionalProperties: false` 改成 `true`、把地区码 `pattern` 放宽、把 `title.maxLength` 从 120 放宽到 200
都会红；只改 **schema 自身**的 `description`/`title`/`examples` 不会红。运行期那一份不是抄来的 fixture，是给
真实 Fastify 实例挂 `onRoute` 钩子、调用三个**真实注册函数**时截下来的 `routeOptions.schema.body`
（`tests/unit/contract-runtime-schema-parity.test.mjs:144`）—— 也就是 `buildApp` 之后交给
`createJsonSchema2020ValidatorCompiler()`（`services/api/src/schema-validator.ts:64`）编译的同一份对象。

## 一、盲区：工具自己划的口径，与三处「看着像在比、其实没比」

盲区出处就写在 parity 工具自己的读数表下面，原文（`tools/openapi-route-parity.mjs:236`）：

> **字段级 schema 未纳入**：请求/响应体的字段、类型、必填与枚举差异不在本表判定范围内，以 `packages/contracts/openapi.json` 为准。

这句话的后半段是承诺，前半段是缺口：工具只比「路由 / 方法 / 状态码」，字段面完全在判定范围之外。
`ProfileInput` 是最典型的例子 —— 契约 `packages/contracts/openapi.json:12982` 与运行期
`services/api/src/routes/profile.ts:29` 今天逐字同构（`type:'object'`、`additionalProperties:false`、
`required:['crop_id','region_code','region_catalog_version']`、`region_code.pattern='^33[0-9]{4}$'`、
`region_catalog_version` 长度 1..80，见 `services/api/src/routes/profile.ts:30` 与
`services/api/src/routes/profile.ts:31`），但**没有任何一处把两份结构当成两个对象来比**。

三处「看着像在比」的现有覆盖，各自缺一半：

1. `tests/unit/profile-api.test.mjs:544` 判契约 `ProfileInput.additionalProperties === false`；
   `tests/unit/profile-api.test.mjs:546` 判属性名集合等于三个字段；
   `tests/unit/profile-api.test.mjs:548` 判 `region_code.pattern` 等于 `^33[0-9]{4}$`。
   三条全部**只读契约侧**，运行期那份 schema 不在比较面上。
2. `tests/unit/profile-api.test.mjs:640` 动态载入运行期编译器，
   `tests/unit/profile-api.test.mjs:641` 拿**契约** schema 去编译 —— 这证明「契约能被运行期的校验器编译」，
   但编译的输入是契约，运行期 schema 本身从头到尾没被读过。
3. `tools/openapi-route-parity.mjs` 比路由表（见上），字段面按自己的口径排除在外。

于是三种漂移都能全绿：契约加字段而运行期不动（请求照样被 400 掉）、运行期加字段而契约不动（契约里没有的字段
被收下）、两边一起改却改成不同形状（客户端按契约发的请求在服务端被拒）。本片补的就是这条缝。

## 二、做法：不改生产代码的公开面，截「注册时的那一份」

三个 `register*Routes` 都是 `services/api/src/app.ts` 里逐条调用的普通导出函数，schema 字面量写在函数体里
（`services/api/src/routes/profile.ts:29`、`services/api/src/routes/community.ts:72`、
`services/api/src/routes/community.ts:100`、`services/api/src/routes/consents.ts:42`），**没有导出面**能直接拿到。
本片没有为此改任何生产代码，走的是 Fastify 自己的注册期钩子：

- `captureRegisteredRoutes()`（`tests/unit/contract-runtime-schema-parity.test.mjs:141`）建一个真实的
  Fastify 实例，`tests/unit/contract-runtime-schema-parity.test.mjs:144` 挂 `onRoute` 钩子，把每个
  `route.schema` 连同方法/路径收进数组；
- 随后调用三个真实注册函数：`tests/unit/contract-runtime-schema-parity.test.mjs:149`（profile）、
  `:150`（community）、`:151`（consents），`pool`/`service` 传 `null`、`guards` 给同形桩
  ⇒ 只注册路由，不连库、不建连接池（注册时 `config` 传 `{}`：这 4 个 body 今天都是字面量、不读 config；
  若将来某个 body 按 config 拼装，这里会安静地比一份「空配置产物」，测试文件头已写明这条前提）；
- `runtimeBodyOf()`（`tests/unit/contract-runtime-schema-parity.test.mjs:158`）按 `method + url` 取回
  `schema.body`，取不到就抛（不返回 `undefined`，否则下面的等价断言会空转成永久绿）。

为什么值得绕这一下、而不是把 schema 抄进测试：抄一份只能证明「抄得对」，证明不了「运行期还是它」；
`onRoute` 截到的就是 `app.put(...)` 第二个参数里那个对象的引用，改了 `profile.ts` 它立刻跟着变。

契约侧走 operation 而不是直接点 `components.schemas`：`contractBodyOf()`
（`tests/unit/contract-runtime-schema-parity.test.mjs:170`）先拿 `servers[0].url`（`packages/contracts/openapi.json:11`
的 `/api/v1`）把运行期路由前缀剥掉，再读该 operation 的 `requestBody.content['application/json'].schema`，
并断言它的 `$ref` 指向本表登记的 schema 名（`tests/unit/contract-runtime-schema-parity.test.mjs:254`）。
这样「`PUT /me/profile` 到底该对哪个 schema」不是测试自己声明的，而是契约自己声明的
（`packages/contracts/openapi.json:759` 指向 `ProfileInput`）；有人把 operation 换成别的 schema，守卫会红。

## 三、规范化规则（`canonicalizeSchema` 与 `resolveLocalRefs`）

规范化函数写在测试文件里（`tests/unit/contract-runtime-schema-parity.test.mjs:105` 与 `:86`），规则八条：

| # | 规则 | 为什么（今天就会假红／假绿的地方） |
| --- | --- | --- |
| 1 | 递归解析**本地** `$ref`（`#/components/schemas/<Name>`）后再比 | 契约用 `$ref` 复用、运行期内联展开：`PostInput.linked_knowledge_ref` 是 `anyOf:[{$ref: KnowledgeTarget},{type:'null'}]`（契约 `packages/contracts/openapi.json:15619` 起），`ConsentInput.purpose` 是 `$ref` 到 `ConsentPurpose`（`packages/contracts/openapi.json:12660`），`ReportInput.target_ref` 是 `$ref` 到 `ReportTarget`（`packages/contracts/openapi.json:15921`）。不解析 ⇒ 4 条里 3 条全是假分叉。 |
| 2 | 丢掉纯文档键：`$schema`、`title`、`description`、`examples`、`example`、`deprecated`、`$comment`、`summary`（`tests/unit/contract-runtime-schema-parity.test.mjs:65`） | 这些键不进 Ajv 的接受/拒绝判定，只影响阅读；把它们算进分叉，守卫会天天红在无害改动上（§五 M3 就是这条的反证）。**只在 schema 对象自身的键上生效** —— 见规则 5。 |
| 3 | `required` 数组**排序后**再比 | 必填项的顺序没有语义；`['a','b']` 与 `['b','a']` 是同一份约束。 |
| 4 | **其它数组保序**（`enum`、`anyOf`、`allOf`…） | 顺序本身承载分支顺序与优先级；排序会把真分叉抹平（`enum` 成员换序在 JSON Schema 上语义相同，但**契约里换序通常意味着有人在手改**，值得人看一眼，所以保守判红）。 |
| 5 | **按容器区分**：`properties`/`patternProperties`/`$defs`/`definitions`/`dependentSchemas`/`dependencies` 的键是**属性名/定义名**，原样保留、只对值递归（`tests/unit/contract-runtime-schema-parity.test.mjs:71`） | 这正是 P1：初版对所有层级套用规则 2，`PostInput.properties.title`（required 属性，`title` 与文档键同名）被整块丢掉 ⇒ 运行期标题上限 120→200 全绿。现在由判据③c（`tests/unit/contract-runtime-schema-parity.test.mjs:348`）与 M5（`tests/unit/contract-runtime-schema-parity.test.mjs:427`）从两个方向钉住。 |
| 6 | `enum`/`const`/`default` 的值是**数据**不是 schema，整块原样保留（`tests/unit/contract-runtime-schema-parity.test.mjs:74`） | 同一类洞的另一半：`enum` 里可以放对象，那些对象的键不是 schema 关键字，进去过滤会把两个不同的枚举值比成相等。 |
| 7 | 其它键逐字比：`pattern`、`minLength`、`maxLength`、`maxItems`、`uniqueItems`、`format`、`additionalProperties`、`minimum`/`maximum`… | 不做任何「等价代换」（比如不把 `minLength:1` 与「未声明」当等价）。少一个 `required`、把 `false` 改成 `true` 必须红。 |
| 8 | 不认识的 `$ref`（外部引用、不存在的 schema）**抛错**；规范化不改入参 | 宁可红，也不要静默跳过一整段没比的树；改入参会把 `required` 排序后的副本留给下一次比较（`tests/unit/contract-runtime-schema-parity.test.mjs:330` 判据③b 与 `:289` 判据③ 末段都钉了这两条）。 |

## 四、覆盖面：4 个 schema，以及为什么是这 4 个

指令要求「至少 3 个」，实际覆盖 4 个（多出 `ReportInput`）。挑选标准是「形状上各自能证伪一类错误」，
不是「随便挑三条」：

| 契约 schema | 契约位置 | 运行期位置 | 路由 | 为什么挑它 |
| --- | --- | --- | --- | --- |
| `ProfileInput` | `packages/contracts/openapi.json:12982` | `services/api/src/routes/profile.ts:29` | `PUT /api/v1/me/profile` | 审查点名的盲区本体：今天逐字同构，但只有「闭集 + 三个属性名 + `pattern`」被间接钉过（§一）。也是唯一被三条变异全部打靶的一条。 |
| `PostInput` | `packages/contracts/openapi.json:15619` | `services/api/src/routes/community.ts:72` | `POST /api/v1/posts` | 最能分辨「有没有解析 `$ref`」的一条：`linked_knowledge_ref` 在契约里是 `anyOf` + `$ref`，在运行期是内联展开的同一份结构。规范化写错，这条会第一个假红。 |
| `ConsentInput` | `packages/contracts/openapi.json:14514` | `services/api/src/routes/consents.ts:42` | `POST /api/v1/me/consents` | 属性级 `$ref`（`purpose` → `ConsentPurpose`，纯 `enum` schema）＋数组约束（`recipient_ids` 的 `maxItems:30`、`uniqueItems:true`，`services/api/src/routes/consents.ts:45`）。枚举成员写死在 `services/api/src/privacy/consent-pg.ts:11` 的 `CONSENT_PURPOSES` 里，契约与运行期是两份独立来源，漂移风险最实在。 |
| `ReportInput` | `packages/contracts/openapi.json:15948` | `services/api/src/routes/community.ts:100` | `POST /api/v1/reports` | 嵌套**闭集对象**（`target_ref` → `ReportTarget`）＋五个枚举的 `reason_code`：字段级分叉最容易在这种「两层对象 + 枚举」的形状上漏（外层闭集看着对，内层少一个枚举成员没人发现）。 |

4/4 今天判为等价（`assert.deepEqual` 读数：`tests` 15 / `pass` 15 / `fail` 0，见 §七 第 1 行）。

**覆盖面是封闭的**：判据①c（`tests/unit/contract-runtime-schema-parity.test.mjs:261`）把「捕获到的每一条带
`schema.body` 的路由」分成两堆 —— 进 `CASES` 的，和登记在 `BODY_ROUTE_EXEMPTIONS`
（`tests/unit/contract-runtime-schema-parity.test.mjs:219`）里并写明理由的。今天捕获 38 条路由、其中 8 条带
body：4 条进 `CASES`，4 条在豁免表（`PATCH /posts/:id`、`POST /posts/:id/comments`、`PATCH /comments/:id`、
`DELETE /me/consents/:purpose` —— 前三条要 `:id`→`{id}` 换算，最后一条运行期 body 固定 `{type:'null'}`、契约无
requestBody）。于是「新增一条带 body 的路由」会在新增那一刻红，而不是静默滑过；豁免表里出现过期条目也会红。

**没纳入的一条及原因**：`CommentInput`（`POST /posts/{id}/comments`）—— 运行期路径写作
`/api/v1/posts/:id/comments`（`services/api/src/routes/community.ts:92` 的 `commentBody` 是它的 body），
契约里是 `{id}`，需要一次 `:id` → `{id}` 的路径参数换算；本片不为一条用例引入路径模板引擎，
把它列进 §九 的清单（第 2 条）。

## 五、变异读数（7 条：5 条内存、2 条落盘，另加 main 现场复现与回退自证）

全部走**同一个** `assertFieldParity()`（`tests/unit/contract-runtime-schema-parity.test.mjs:230`，断言落在
`:236` 的 `assert.deepEqual`）—— 若变异只打一个旁路函数，就不能证明真守卫会红。

### 5.0 先复现 main 上的假绿（这不是推理，是读数）

`#1117` 已合并进 main，所以「`PostInput.title` 被当文档键丢掉」这件事**今天是 main 的状态**。复现方式：

1. `git show origin/main:tests/unit/contract-runtime-schema-parity.test.mjs` 取回 main 版；
2. 落盘把 `services/api/src/routes/community.ts:77` 的
   `title: { type: 'string', minLength: 1, maxLength: 120 }` 改成 `maxLength: 200`（运行期放宽）；
3. 跑 `node --test tests/unit/contract-runtime-schema-parity.test.mjs` ⇒ **`ℹ tests 12 / pass 12 / fail 0`**；
4. 同一次落盘变异、换上本页这版测试 ⇒ `ℹ tests 15 / pass 13 / fail 2`，红的正是判据② PostInput
   （`AssertionError: 契约 PostInput 与运行期 body schema 分叉：`）与判据④-M5；
5. `git checkout -- services/api/src/routes/community.ts` 还原，`git diff --quiet` exit 0。

即：main 上这条守卫对「运行期把标题上限放宽一倍」是**全绿**的，而它本该是这条守卫最典型的战果。
本 PR 的三条 `title` 变异（5.5／5.6／5.7）就是在这个现场上把洞补死的。

### 5.1 M1：契约侧给 `ProfileInput` 加一个 `latitude` 字段（内存变异，不动契约文件）

`structuredClone(CONTRACT)` 后给 `components.schemas.ProfileInput.properties.latitude` 加
`{type:'number', minimum:-90, maximum:90}`，把这份 doc 作为 `contractDoc` 传进同一个
`assertFieldParity()`（`tests/unit/contract-runtime-schema-parity.test.mjs:388`）。

读数：`✖` 不出现 —— 该用例内部 `assert.throws(... /分叉/)` 成立，整文件 `tests 17 / pass 17 / fail 0`。
「红」的形态是被 `assert.throws` 接住的那条 `AssertionError: 契约 ProfileInput 与运行期 body schema 分叉：`
（契约侧多出 `latitude`，运行期侧没有）。**这一条没有落盘改 `packages/contracts/openapi.json`**：
契约文件是本片明令的禁改项，内存里克隆一份走完全相同的代码路径（`contractBodyOf` →
`resolveLocalRefs` → `canonicalizeSchema` → `deepEqual`），唯一省掉的是 `readFileSync` ——
而它被另外 13 条绿用例覆盖着。

### 5.2 M2：运行期侧 `additionalProperties: false` → `true`（落盘）

改 `services/api/src/routes/profile.ts:30`（`git diff` 只有这一行），跑
`node --test tests/unit/contract-runtime-schema-parity.test.mjs` ⇒ `ℹ tests 15 / pass 12 / fail 3`：

```
✖ 判据②：ProfileInput（PUT /api/v1/me/profile）与契约逐字段等价 …
  AssertionError [ERR_ASSERTION]: 契约 ProfileInput 与运行期 body schema 分叉：
✖ 判据④-M2：运行期侧把 additionalProperties:false 改成 true ⇒ 必须红
  AssertionError [ERR_ASSERTION]: 运行期原本就是闭集，变异前提不成立
✖ 判据④-M3：只在运行期加 description/title/examples ⇒ 不许红（证明没有过度敏感）
```

三红各有信息量：判据② 是真守卫本身红（`additionalProperties` 由 `false` 变 `true`，坐标类额外字段在运行期
变成合法，而契约仍闭集）；判据④-M2 红在它自己的**前提断言**上 —— 说明这条变异用例不是「无论盘上是什么都
绿」的摆设；判据④-M3 连带红，因为 M3 拿**同一份真实运行期 schema** 当基线，基线已经分叉时它当然也红
（M3 的绿以基线绿为前提，这条耦合如实记在这里，不掩盖）。

### 5.3 M3：只在运行期加 `description`（落盘）—— 不许红

改 `services/api/src/routes/profile.ts:30`，在 `additionalProperties: false` 与 `required` 之间插入
`description: 'mutation: doc-only key'`，跑同一条命令 ⇒ `ℹ tests 17 / pass 17 / fail 0`。

这一条是**反向对照**：守卫若把文档键也当分叉，§三 规则 2 就是过度敏感，任何一次注释性补充都会让 CI 变红，
守卫会在两周内被绕过。同时该用例内部还有一条反向断言
（`tests/unit/contract-runtime-schema-parity.test.mjs:406` 起的用例末段）：在同一份「已加文档键」的变异体上
再把 `required` 砍成 `['crop_id']`，必须立刻红 —— 证明 M3 的绿不是「比较器瞎了」。

### 5.4 M4：契约侧把地区码 `pattern` 放宽成 `^[0-9]{6}$`（内存变异）

同一份克隆契约上改 `ProfileInput.properties.region_code.pattern`
（`tests/unit/contract-runtime-schema-parity.test.mjs:420`）。读数：`assert.throws(... /分叉/)` 成立，
整文件 17/17 绿。它证的是「字段级」不只是字段名：类型、必填、闭集、枚举、长度、模式都在比较面上，
否则「契约放开省外地区码」这种**实打实的业务放宽**会静默通过。

### 5.5 M5：运行期把 `PostInput.title.maxLength` 从 120 放宽到 200（内存变异）—— P1 现场

这条打的是 P1 那个洞：`title` 既是 `PostInput` 的一个 required 属性名，又是文档键名。取运行期 body 的
副本、把 `properties.title.maxLength` 改成 200 再喂回同一个 `assertFieldParity()`
（`tests/unit/contract-runtime-schema-parity.test.mjs:427`），并要求它抛 `/分叉/`；同一用例里还有一条反向
断言 —— 只给 `title` 加 `description` 不许红（修复没有把 `title` 变成「一律敏感」）。读数：整文件 17/17 绿。

### 5.6 M6：契约侧把 `PostInput.title.maxLength` 从 120 放宽到 200（内存变异）

P1 的另一半：上一节变异的是运行期，这一节变异契约。`structuredClone(CONTRACT)` 后改
`components.schemas.PostInput.properties.title.maxLength = 200`，喂进同一个 `assertFieldParity()`
（`tests/unit/contract-runtime-schema-parity.test.mjs:442`），断言它抛 `/分叉/`，并先断言运行期那一侧确实还是
`120`（否则这个变异可能根本没打在被比较的那一份上）。读数：整文件 `tests 17 / pass 17 / fail 0`。

### 5.7 M7：运行期把 `PostInput.title` 的类型从 `string` 改成 `number`（内存变异）

第三种形状：不是长度、是类型。取运行期 body 副本、把 `properties.title` 整个换成 `{type:'number'}`
（`tests/unit/contract-runtime-schema-parity.test.mjs:452`），断言 `/分叉/`；前提断言先确认原类型是 `string`。
读数：整文件 `tests 17 / pass 17 / fail 0`。

M5、M6、M7 三条合起来才把 P1 说清楚：无论放宽发生在契约侧还是运行期侧、无论改的是长度还是类型，只要改的是
那个**名字叫 `title` 的属性**，守卫都必须红。修复前这三条在 main 上全是绿（§五 5.0 有现场读数）。

### 5.8 回退修复 ⇒ 判据③c 与 M5 必须红（P1 的负控制）

把 `canonicalizeSchema()` 里的容器分支与数据位分支临时短路（等价于回到初版「过滤用在所有层级」），
再跑同一个文件：

```
ℹ tests 17 / pass 13 / fail 4
✖ 判据③c：`properties`/`patternProperties`/`$defs`/`dependentSchemas` 的键名原样保留…
  AssertionError [ERR_ASSERTION]: 属性名 title 的 maxLength 变化必须判为分叉（P1 假绿：容器键被当文档键丢了）
✖ 判据④-M5：运行期把 PostInput 的 title.maxLength 从 120 放宽到 200 ⇒ 必须红（P1 现场，属性名撞文档键）
  expected: /分叉/,
✖ 判据④-M6：契约侧把 PostInput 的 title.maxLength 从 120 放宽到 200 ⇒ 必须红（P1 的另一半）
✖ 判据④-M7：运行期把 PostInput 的 title 类型从 string 改成 number ⇒ 必须红（属性名撞文档键的第二种形状）
```

四条红各自定位一件事：③c 红在**比较器**上（与真实路由无关），M5／M6／M7 红在**真守卫**上（同一条
`assertFieldParity`），且分别覆盖「运行期改长度／契约改长度／运行期改类型」三种形状。初版正是这几处都绿，
才让 120→200 的放宽全绿通过 —— 复查方式就写在这里，不是一句承诺。

### 5.9 还原

```
git checkout -- services/api/src/routes/profile.ts
git diff --quiet -- services/api/src/routes/profile.ts ⇒ exit 0（逐字还原）
git status --porcelain ⇒ 只有两个文件的改动
node --test tests/unit/contract-runtime-schema-parity.test.mjs ⇒ ℹ tests 17 / pass 17 / fail 0
```

## 六、判据③：规范化自身也要有分辨率

守卫的价值等于「该红的红、该绿的绿」，所以规范化不是实现细节，得自己带单测
（`tests/unit/contract-runtime-schema-parity.test.mjs:292`、`:330`，P1 的回归钉子 `:345`）：

| 输入变异 | 期望 | 为什么 |
| --- | --- | --- |
| 只加 `$schema`/`title`/`description`/`examples` | 等价 | 纯文档键，不进 Ajv 判定（只在 schema 对象自身上） |
| 少一个 `required` | 分叉 | 必填面变化是真实的接受/拒绝差异 |
| `required` 换序 | 等价 | 必填顺序无语义 |
| `enum` 换序 | 分叉 | 除 `required` 外数组保序（§三 规则 4） |
| `additionalProperties: false → true` | 分叉 | 闭集开关是行为差异 |
| `$ref` ↔ 内联同构 | 等价 | 契约用 `$ref` 复用、运行期内联，必须解析后比 |
| 未知 `$ref`（外部 URL、不存在的 schema） | 抛错 | 不许静默跳过没比的子树 |
| 规范化后入参 `required` 顺序不变 | 断言 | 不能把排序后的副本留给下一次比较 |
| **属性名撞上文档键**：`properties.title.maxLength` 120 → 200 | 分叉 | P1：容器键是属性名、不是关键字，规则 5 |
| `properties.title` 是否存在 | 断言 | 直接钉住「没被丢」，而不是只依赖上一条的间接红 |
| `properties.description`/`examples`/`$comment`/`summary`/`deprecated` 同名属性 | 断言 | 五个文档键逐一确认不被误伤 |
| `patternProperties`/`$defs`/`dependentSchemas` 里叫 `title` 的键 | 断言 | 其它容器同样不许丢键 |
| schema **自身**的 `title`/`description` | 等价 | 规则 2 仍然生效（否则 M3 会假红） |
| `enum` 里对象的键（数据位） | 分叉 | 规则 6：数据位不参与文档键过滤 |

## 七、闸门读数（全部在本工作树 HEAD 上跑）

工作树 `E:\GengYunCommander\.pg17\wt-contractparity`（分支 `test/gy-r1117-keyed-map-fix`，
基线 `9f09fcb3bf36d0ded290fb1187465e0b8550fdf1`）。第 1c 行是全量单测，按父代理指令**独占**跑了一次。

| # | 闸门命令 | 读数（逐字） | 结论 |
| --- | --- | --- | --- |
| 1 | `node --test tests/unit/contract-runtime-schema-parity.test.mjs` | `ℹ tests 17 / pass 17 / fail 0`（0.82–0.87 s；同一份代码两次跑的抖动） | 绿（含 7 条变异判据：M1／M2／M4／M5／M6／M7 断言必须抛错，M3 断言不许抛错，③c 钉住 P1 的容器键） |
| 1b | `node --test tests/unit/contract-runtime-schema-parity.test.mjs tests/unit/profile-api.test.mjs` | `ℹ tests 35 / pass 35 / fail 0`（12.8 s） | 绿（新增文件 + 相邻的 `profile-api.test.mjs`） |
| 1c | `npm run test:unit`（全量，独占跑） | `ℹ tests 6835 / pass 6832 / fail 1 / skipped 2`（224 s）；唯一红是 `tests/unit/doc-anchor-relocation-identity.test.mjs` 的自检：`AssertionError: base 与 HEAD 同一提交…没有判定面却也不是 CI 浅克隆` —— 那是**提交前**（HEAD 仍指向 `origin/main`）的必然形态；提交后同一文件复跑见第 3 行 | 绿（除提交前那条自检；全量只跑这一次，未反复占用机器） |
| 2 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | `EXIT=0`；`PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）`；`BASELINE: 登记 48 条；本次命中 48 条、基线外新增 0 条、陈旧 0 条`；`BARE-ORPHAN: 登记 3469 条；本次命中 3469 条、基线外新增 0 条、本次扫描面内陈旧 0 条`；`ANCHOR-COUNT: 进判据锚点 8837 条 / 296 份文档；本次计数下降的文档 0 份、上升 107 份` | 绿（本页 50 个不同的 `path:line`、共 73 处引用，全部写成完整路径 ⇒ 裸锚点册 3469 → 3469、0 条新增；`上升 107 份` 是其它页的既有欠账，本闸门只判下降） |
| 3 | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | `ℹ tests 37 / pass 37 / fail 0 / skipped 0`（提交后跑；本提交改的是**既有页**，不是纯新增 hunk，所以这次没有 SKIP，而是真判了一遍位移面） | 绿（本页锚点行号未变，判为恒等；该文件自带的 A1 夹具钉的正是「纯新增必须显式 SKIP、有位移面就必须落在端点映射上」两种形态） |
| 4 | `node tools/verify-contract-status.mjs` | `EXIT=0`；`PASS: 语义可核 124 条区间 + 4 条片段；不可核 165 条区间 + 225 条片段（不可核不计入通过）`；`PASS: 证据锚点 593 条引用自带锚点（区间内 324 条 + 仅整文件 269 条）；无锚点不可核 0 条（纯行号 0 + 无行号源文件 0 + 无用例名 0），只计数不判红`；`PASS: 中文表格一致`；`PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` | 绿（未改 `services/api/src/**`，台账锚点无需重定位） |
| 5 | `npm run test:docs` | `EXIT=0`；`PASS: 识别 5 页 / 跳过 358 页（扫描面 363 页：docs/verification）——读数七条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字 ⑦同页副本一致）` | 绿（本页没有「读数族」，按跳过处理；358 页 = 加本页之后的扫描面） |
| 6 | `node tools/verify-g-drill-readings.mjs --check` | `EXIT=0`；`✓ 八条判据全过：workflows 15 / jobs 29 / 演练 21 条 / 测试文件 608（glob 合计 578）；生长型读数按**下界**判（--tolerant-growth），其中 8 条滞后已逐行打印` | 绿（`测试文件 608`、`glob 合计 578` 是生长型下界读数：本片没有新增测试文件，只把已有文件的用例数从 12 抬到 17，所以这两个数不动） |
| 7 | `git merge-tree --write-tree --name-only origin/main HEAD` | `EXIT=0`；除树号外无输出 | 绿（与 `origin/main`（`9f09fcb3`）无冲突、无同名改动。树号本页不登记：这一段写进本页就会改变本页字节，把树号钉死在页里等于登记一个立刻自指的哈希） |

## 八、不声称

1. **不声称覆盖全部契约**。字段级只覆盖登记在 `CASES`
   （`tests/unit/contract-runtime-schema-parity.test.mjs:187`）里的 4 条路由的**请求体**；
   `packages/contracts/openapi.json` 里其余上百个 schema、以及全部 `parameters`/`headers` 都不在面上。
   **路由层面是封闭的**：判据①c（`tests/unit/contract-runtime-schema-parity.test.mjs:261`）保证「新出现的带
   body 路由」要么进 `CASES`、要么进豁免表，不会静默滑过；但**字段层面不是封闭的** —— 契约里新增一个没人
   引用的 `components.schemas`、或给已有 schema 加一个运行期根本不读的字段，本守卫看不见。
2. **不声称响应体已纳入**。比的是 `requestBody.content['application/json'].schema`；`responses.*.content`
   一个字段都没读。`ProfileInput` 的兄弟 `Profile`（响应）今天同样没有运行期等价守卫。
3. **不声称能防语义级分叉**。它判的是「两份 JSON Schema 结构等价」，不是「两份 schema 表达同一套业务规则」。
   两边一起把 `region_code.pattern` 从 `^33[0-9]{4}$` 放宽成 `^[0-9]{6}$`，结构仍然等价 ⇒ 绿；
   这类「两边同步改错」只能靠业务断言（如 `tests/unit/profile-api.test.mjs:548` 那种）拦。
4. **不声称等价于行为等价**。两份 schema 相同 ⇒ Ajv 判定相同；但 `BASE_AJV_OPTIONS`（`allErrors:false`）、
   `addFormats` 的格式集合（`services/api/src/schema-validator.ts:67`）变化不在本守卫面上，同一份 schema
   在不同编译选项下可以有不同的接受集合。
5. **不声称 M3 的绿与基线无关**。§五 5.2 已记：M3 复用真实运行期 schema 当基线，基线分叉时它连带红；
   它证明的是「文档键不进比较」，不是「任何情况下都绿」。
6. **不声称覆盖路径参数路由**。`:id` → `{id}` 的换算没做（§四 末段），`CommentInput` 因此没纳入。
7. **不声称「以空配置注册」等价于生产**。`captureRegisteredRoutes()` 用 `config = {}` 注册
   （`tests/unit/contract-runtime-schema-parity.test.mjs:149` 一带），今天 4 个 body 都是字面量、不依赖
   `config`，所以截到的就是生产那一份；若将来某个 body 由 `config` 拼出来，这里会静默比一份**空配置的产物**，
   那时必须改成从真实 `loadConfig()` 取配置（本页不承诺今天就改）。
8. **不声称取代 parity 工具或 `profile-api.test.mjs`**。三者判据不同（§十），谁红了都能定位到不同的事。

## 九、后续把新 schema 纳入的清单（清单，不是承诺）

对每一条想守的「路由 × 请求体」：

1. 在该路由的 `register*Routes` 里找到 `schema.body` 的**字面量位置**（例如
   `services/api/src/routes/community.ts:72`），确认它是手写的、不是从契约生成出来的；
2. 确认这条路由由 `registerProfileRoutes` / `registerCommunityRoutes` / `registerConsentRoutes` 之一注册
   （`captureRegisteredRoutes()`，`tests/unit/contract-runtime-schema-parity.test.mjs:141`，只调这三个）；
   若是别的模块（如 `account-deletion.ts`、`auth.ts`），先确认它的注册函数在 `guards`/`service` 为桩时
   不抛，再把它加进 `captureRegisteredRoutes()`；
3. 在契约里定位对应 operation，读它的 `requestBody.content['application/json'].schema.$ref`
   （如 `packages/contracts/openapi.json:759`），确认指向一个 `components.schemas` 里的命名 schema；
4. 往 `CASES`（`tests/unit/contract-runtime-schema-parity.test.mjs:187`）加一条
   `{schema, method, route, why}`，`route` 写**运行期**形态（含 `/api/v1` 前缀与 `:id`）；
5. 若是路径带参数的路由，先给 `contractBodyOf()` 加 `:id` → `{id}` 换算，再跑一次确认不是空转；
6. 跑 `node --test tests/unit/contract-runtime-schema-parity.test.mjs`：
   真分叉（契约/运行期本来就不同）会在这一步红 —— **先判断是改契约还是改运行期**，
   不要靠往规范化里加豁免把它弄绿；
7. 若新 schema 用到了本文件不认识的 `$ref` 形态（外部引用、`$defs`、`allOf` 组合），
   先扩 `resolveLocalRefs()`（`tests/unit/contract-runtime-schema-parity.test.mjs:86`）并补一条
   §六 那样的分辨率用例，再信任绿读数；
8. 把新增的这条写进本页 §四 的表格（否则下次没人知道覆盖面到哪）；
9. 若某条 schema 本来就是**从契约生成**的（不是手写），不要加进 `CASES` —— 它不可能分叉，
   加进去只会增加噪音，应在 §四 注明「生成物，不设守卫」。

## 十、与既有守卫的关系（为什么不是重复造轮子）

| 守卫 | 扫描面 | 判什么 | 判不了什么 |
| --- | --- | --- | --- |
| `tools/openapi-route-parity.mjs` | 契约 vs 运行期路由表 | 路由 / 方法 / 状态码是否对齐（`tools/openapi-route-parity.mjs:236` 自述字段面不在范围内） | 字段、类型、必填、枚举、`pattern` |
| `tests/unit/profile-api.test.mjs` | 契约 `ProfileInput`/`Profile` 与 HTTP 行为 | 契约闭集 + 三字段名 + 地区码 `pattern`（`tests/unit/profile-api.test.mjs:544`、`tests/unit/profile-api.test.mjs:548`）；契约 schema 能被运行期编译器编译（`tests/unit/profile-api.test.mjs:640`、`tests/unit/profile-api.test.mjs:641`） | 运行期 schema 与契约是否**同构**（它两端各看一半，从不比较） |
| `tests/unit/contract-runtime-schema-parity.test.mjs`（本片） | 4 条路由的**契约请求体** vs **运行期注册的 `schema.body`**；另按判据①c 覆盖**全部带 body 路由的登记面**（今天 38 条捕获、8 条带 body） | 两份结构逐字段等价（含 `$ref` 解析后的等价）；新出现的带 body 路由必须登记或写豁免，否则红 | 响应体、路径参数路由、语义级分叉、Ajv 编译选项、`config` 依赖（§八） |

三者互补且不重叠：parity 工具管「这条路由存不存在」，`profile-api.test.mjs` 管「这份契约说得对不对」，
本片管「契约说的和运行期做的是不是同一件事」。
