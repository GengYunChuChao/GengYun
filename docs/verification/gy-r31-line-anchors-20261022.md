# R31 · 把「测试里写死 `文件:行号`」这一类机械性红收口

- 日期：2026-10-22
- 分支：`test/gy-r31-line-anchors`，基线 `origin/main` @ `d4d48088532377adb54c278b24ba90be42cb5aaf`
- 范围：`tests/**`（`tools/**` 只读清点）
- 一句话结论：判红位置的写死行号从 **18 处降到 5 处**（13 处改成按源码实时定位、5 处登记进显式 allowlist），
  并新增 `tests/unit/test-line-anchors-guard.test.mjs` 拦住**新增**的写死行号；不删任何断言，判据强度只增不减。

## 0. 本片不做什么

- **不处理 `docs/architecture/contract-status.json` 的锚点** —— 那是另一片的 `verify-contract-status.mjs --reanchor`。
  本片只碰「测试里的断言」，不碰契约台账内容，也不改它生成的东西。
- 不动业务代码（`services/**`、`deploy/**`、`packages/**` 一行未改；唯一的临时改动是第 4 节的「插 3 行」证明，跑完即 `git checkout` 复原）。
- 不删断言、不降级判据：所有改写都是「把期值从写死的数字换成现算的数字」，另外顺手把 2 处 `includes('profile/service.ts:35')`（后缀匹配）
  升级成 `includes(SITE.profileUserLock)`（全路径匹配），比原来更严。

## 1. 清点

扫描器：`tests/unit/line-anchor-scan.mjs`（本片新增，含一个逐字符 lexer，用来区分「代码 / 字符串 / 模板 / 正则 / 注释」）。

判红口径（三层，缺一层就会漏或误报）：

| 位置 | 含义 | 拦不拦 |
| --- | --- | --- |
| `assert-operand` | 落在 `assert.*` 的**判定实参**上（沿调用链从内往外找；落在失败消息实参上就停） | **拦** |
| `registry-ref` | 落在登记表 `ref:` / `refs:` / `site:` / `sites:` 的值上（豁免表、opaque 表等） | **拦** |
| `regex-anchor` | 落在正则字面量里（`services\/api\/src\/routes\/ocr\.ts:2-8`） | **拦** |
| `prose` | 失败消息、`reason:`/`why:`/`label:` 文案、`say()/note()/check()` 日志 | 只清点 |
| 注释 / 幻影 / 歧义 | 注释里的引用；指向不存在的文件或越界行号（`…:99999`、合成夹具 `nc*-fake-*`）；裸文件名多候选（`service.ts:` 有 16 个同名文件） | 只清点 |

为什么只拦前三类：`prose` 与注释不会因为「代码挪了两行」而变红 —— 拦它们要给 40+ 条写豁免，守卫立刻被噪音拖垮
（这条教训来自 `tests/unit/migration-pin-guard.test.mjs` 头部写的「豁免一多守卫就会被顺手加一条拖垮」）。
幻影锚点反而**必须**留着：`…:99999`、`nc1-fake-store-pg.ts:3` 是「登记了不存在的行 ⇒ 必须判红」的负控制。

读数（同一扫描器，改写前 vs 改写后；扫描面 399 → 401 个文件，多出来的两个是本片新增的 allowlist 与守卫文件）：

| 类别 | 改写前 | 改写后 | 处理 |
| --- | --- | --- | --- |
| 判红位置（assert 实参 / `ref:` / 正则锚点） | **18** | **5** | 13 改实时定位，5 进 allowlist |
| 散文（失败消息 / `reason:` 文案 / 日志） | 82 | 79 | 不拦；改写时顺手删掉 3 处过期的失败文案锚点 |
| 注释 | 145 | 152 | 不拦（+7 来自本片新增扫描器自身的注释型引用） |
| 幻影（越界 / 合成夹具） | 8 | 8 | 不拦（负控制本身） |
| 歧义（裸文件名多候选） | 3 | 3 | 不拦，只留清点 |
| **合计命中** | **256** | **247** | |

改写后的 5 处判红位置**全部**在 allowlist 里（见第 2.2 节），所以守卫当前是绿的 —— 但它是「有账可查的绿」，不是「扫了个空」。

## 2. 分类处理

### 2.1 能自动定位的 13 处：改成「按源码实时算行号」

全部在 `tests/unit/sql-column-coverage.test.mjs`。新增的定位块在该文件 `:142-212`：

```js
function siteLine(file, needle) {
  const text = readFileSync(resolve(root, file), 'utf8');
  const first = text.indexOf(needle);
  assert.notEqual(first, -1, `R31 语句站点定位失败：${file} 里已找不到锚点「${needle}」…`);
  assert.equal(text.indexOf(needle, first + 1), -1, `R31 语句站点定位不唯一：${file} 里「${needle}」出现了多次…`);
  return lineOf(text, first);
}
const SITE = { profileUserLock: siteRef('services/api/src/profile/service.ts', NEEDLE.profileUserLock), /* … 共 9 个 */ };
```

判据强度**没降**：`siteLine` 要求锚点在文件里**恰好出现一次** —— 语句被删、被改名、被复制成两份都会当场判红并点名；
只有「同一语句上下挪了几行」不再红，而那一类红本来就毫无信息量。

| # | 改写前（HEAD 行号） | 锚的源文件 | 改写后（现行号） |
| --- | --- | --- | --- |
| 1 | `sql-column-coverage.test.mjs:152` `ROW_LOCK_EXEMPT[0].ref = 'services/api/src/privacy/ledger-pg.ts:244'` | `services/api/src/privacy/ledger-pg.ts` | `:225` `ref: SITE.ledgerExportsLock` |
| 2 | `:161` `LEDGER_OPAQUE_ALLOWLIST[0].ref = '…ledger-pg.ts:399'` | 同上 | `:234` `ref: SITE.ledgerExpectsTextKey` |
| 3 | `:165` `…'…ledger-pg.ts:549'` | 同上 | `:238` `ref: SITE.ledgerByKey` |
| 4 | `:169` `…'…ledger-pg.ts:550'` | 同上 | `:242` `ref: SITE.ledgerScoped` |
| 5 | `:246` `OPAQUE_ALLOWLIST[0].ref = 'services/api/src/conversations/store-pg.ts:248'` | `services/api/src/conversations/store-pg.ts` | `:319` `ref: SITE.conversationsWhere` |
| 6 | `:251` `…'…store-pg.ts:326'` | 同上 | `:324` `ref: SITE.turnsWhere` |
| 7 | `:2028` `assert.ok(raw.rowLocks.problems[0].startsWith('services/api/src/privacy/ledger-pg.ts:244 → public.exports'), …)` | `ledger-pg.ts` | `:2101` `startsWith(\`${SITE.ledgerExportsLock} → public.exports\`)` |
| 8 | `:2111` `assert.ok(hit[0].includes('profile/service.ts:35'), …)` | `services/api/src/profile/service.ts` | `:2184` `includes(SITE.profileUserLock)`（后缀 → 全路径，加严） |
| 9 | **`:2137` `assert.ok(hit[0].includes('profile/service.ts:61'), \`红字必须点名 profile/service.ts:61…\`)`** | 同上 | `:2210` `includes(SITE.profileRegions)` |
| 10 | `:2211` 失败消息里「（profile/service.ts:35、privacy/consent-pg.ts:75）」 | 两处 | `:2284` 改用 `${SITE.profileUserLock}`、`${SITE.consentUserLock}` |
| 11 | `:2214` `assert.deepEqual(…, ['services/api/src/privacy/consent-pg.ts:75','services/api/src/profile/service.ts:35'], …)` | 两处 | `:2287` `[SITE.consentUserLock, SITE.profileUserLock].sort()` |
| 12 | `:2229` NC9 负控制 `ref: 'services/api/src/profile/service.ts:35'` | `profile/service.ts` | `:2302` `ref: SITE.profileUserLock` |
| 13 | `:2230` NC9 负控制 `ref: 'services/api/src/privacy/consent-pg.ts:75'` | `services/api/src/privacy/consent-pg.ts` | `:2303` `ref: SITE.consentUserLock` |

第 9 条就是今天 CI 红的元凶（`put()` 上加两行 ⇒ 61 变 65 ⇒ 「测试过期」假红）。另外 NC5 的变异替换原来是另写一份字面量，
现在与定位共用同一个 `NEEDLE.profileUserLock`：业务 SQL 一改，定位和变异一起报红，不会出现「定位还在、变异悄悄没生效」。

**改写前（旧写法）**
```js
assert.ok(hit[0].includes('profile/service.ts:61'), `红字必须点名 profile/service.ts:61：${hit[0]}`);
```
**改写后**
```js
assert.ok(hit[0].includes(SITE.profileRegions), `红字必须点名语句站点 ${SITE.profileRegions}：${hit[0]}`);
```

### 2.2 不能自动定位但确有意义的 5 处：登记进 allowlist

`tests/unit/line-anchor-allowlist.mjs`，每条 `path` + `anchor` + `reason` + `owner`，**逐条写清为什么算不出来**：

| 位置 | 锚 | owner | 为什么不能自动定位（摘要） |
| --- | --- | --- | --- |
| `tests/unit/contract-status-tool.test.mjs:321` | `services/api/src/routes/ocr.ts:2-8` | `R31` | 这数字是测试**喂进去的错误输入**（mutate 故意把 `evidence[0].lines` 写成 `2-8`），断言的是工具能认出「覆盖的是 post /ocr 块」；数字必须落在测试自造的 25 行 `OCR_ROUTE_SOURCE` 上，真 `ocr.ts` 有 353 行 |
| `:332` | `…ocr.ts:10-16` | `R31` | 同上：区间互换时被断言的错位坐标，取的是夹具第 10-16 行 |
| `:339` | `…ocr.ts:1-25` | `R31` | `1-25` 是「区间恰好等于整个夹具文件」的**边界值**（规则：区间==整文件⇒无法定位），不是任何语句的位置 |
| `:355` | `…ocr.ts:11-13` | `R31` | 要的是「落在别人注册块内、又不覆盖本操作」的**部分重叠**形状，必须手挑 3 行，夹具里没有等价符号 |
| `:363` | `…ocr.ts:2-16` | `R31` | 跨两个注册块的边界（`covered.length >= 2` 分支），起止都是手挑边界 |

同一族里 `tests/unit/contract-status-anchors.test.mjs:149/181` 的 `services/api/src/jobs/store.ts:5-5 / 6-8` **没有**进 allowlist：
仓里根本没有这个文件（夹具在临时树里自造），源码怎么改都不会让它红，扫描器把它判成「幻影」而幻影不拦。

### 2.3 已无意义的：0 处

清点里没有「纯装饰、已经对了什么也证明不了」的判据锚点需要订正 —— 13 处都是「判据有效但期值写死」，改法就是本节 2.1。
失败文案里那 3 处过期锚点（`profile/service.ts:61`、`profile/service.ts:35`、`consent-pg.ts:75`）随改写一起消失，
它们本来也不会判红，删掉只是不想让红字继续指向过期的行号。

## 3. 守卫

`tests/unit/test-line-anchors-guard.test.mjs`（7 条用例），复用同一个扫描器，不另立一套判据。

| 用例 | 作用 |
| --- | --- |
| `扫描面非空` | 扫到的文件数 `< 200` 或一条判红点都没有 ⇒ 红（防止 glob 写错⇒「很干净」的假绿） |
| `没有未登记的写死源文件:行号` | 判红点减去 allowlist ⇒ 必须为空；否则逐条点名 `测试文件:行 → 源文件:行（位置/调用/原文）` |
| `allowlist 形状` | 每条必须有 `path`/`anchor`/`reason`/`owner`，`owner` 必须是 `GY-Ixx` 或 `R31`，`reason` 不能是一句空话，不许重复登记 |
| `allowlist 不腐烂` | 每条必须**仍然**命中一处判红点，否则报 stale（白名单不许腐烂成免疫区，同 `migration-pin-guard` 的范式） |
| `判据只在断言侧` | 同一个锚点放在注释/失败文案里不拦、放在 `assert.ok(...)` 判定实参里才拦（把口径钉死成用例） |
| `非空证明 ①` | 临时仓库里插一条假硬编码 ⇒ 判红并点名；删掉 ⇒ 回绿 |
| `非空证明 ②` | 把 allowlist 已登记的锚点原封不动写进**另一个**测试文件 ⇒ 仍然红（allowlist 不是通配符） |

## 4. 证明

### 4.1 守卫的非空证明（真实仓库，不是自欺的临时目录）

往 `tests/unit/zz-probe-hardcoded-anchor.test.mjs` 插一条真的写死行号：

```js
assert.ok(hit[0].includes('services/api/src/profile/service.ts:35'), '红字必须点名语句站点');
```

`node --test tests/unit/test-line-anchors-guard.test.mjs` ⇒ **exit 1**，原文：

```
✖ line-anchors/没有未登记的写死源文件:行号：新增即红并点名
AssertionError [ERR_ASSERTION]: 断言里不许写死 `源文件:行号`（代码一改行就会假红）。请改成按源码实时定位（例如 sql-column-coverage.test.mjs 的 siteLine(siteRef)），确有必要才登记进 line-anchor-allowlist.mjs 并写清理由：
tests/unit/zz-probe-hardcoded-anchor.test.mjs:4 → services/api/src/profile/service.ts:35（assert-operand / assert.ok，原文 "services/api/src/profile/service.ts:35"）
```

删掉探针文件后再跑 ⇒ **exit 0**：`ℹ tests 7 / pass 7 / fail 0`。

### 4.2 关键证明：往源文件里插 3 行，改写版仍然绿

在 `services/api/src/profile/service.ts` 的 `directory()` 函数体里插 3 行注释（`regions` 语句 61 → **64**）：

```
--- regions 语句现在的行号 ---
64
--- 插入 3 行后：改写版 sql-column-coverage ---
sql-column-coverage exit=0
[sql-column-coverage] NC6 红字（真实授权少一列）：services/api/src/profile/service.ts:64 → public.regions.name 缺 SELECT（SELECT 列清单）；授权面现状：只授了 [code, parent_code, catalog_version, supported]
ℹ tests 16 / pass 16 / fail 0
--- 插入 3 行后：守卫 ---
guard exit=0
ℹ tests 7 / pass 7 / fail 0
```

**同一份源码、同一时刻**，把旧写法（`git show HEAD:…` 取回、写死 `profile/service.ts:61`）跑一遍对照：

```
old exit=1
ℹ tests 16 / pass 15 / fail 1
AssertionError [ERR_ASSERTION]: 红字必须点名 profile/service.ts:61：services/api/src/profile/service.ts:64 → public.regions.name 缺 SELECT（SELECT 列清单）；…
```

⇒ 旧写法在「代码挪 3 行」时必红（正是今天两次 CI 红的形状），改写版不红，而且红字仍然**点名了真实站点**（现在是 `:64`）。

复原（`git checkout -- services/api/src/profile/service.ts`）后 `regions` 语句回到第 61 行，两条测试仍绿：
`sql-column-coverage` exit 0（16/16）、守卫 exit 0（7/7）。

## 5. 读数

| 命令（`D:\Git\bin` 已前置到 PATH） | exit | 读数 |
| --- | --- | --- |
| `node --test tests/unit/sql-column-coverage.test.mjs`（改写后） | 0 | 16 tests / 16 pass / 0 fail |
| `node --test tests/unit/test-line-anchors-guard.test.mjs` | 0 | 7 / 7 / 0 |
| `node --test tests/unit/contract-status-tool.test.mjs`（allowlist 所在文件，未改） | 0 | 18 / 18 / 0 |
| 探针红：插入假硬编码后跑守卫 | 1 | 1 fail，点名 `zz-probe-hardcoded-anchor.test.mjs:4 → services/api/src/profile/service.ts:35` |
| 探针绿：删掉探针后跑守卫 | 0 | 7 / 7 / 0 |
| 插 3 行后：改写版 `sql-column-coverage` | 0 | 16 / 16 / 0，红字为 `:64` |
| 插 3 行后：旧写法（HEAD 版）对照 | 1 | 15 pass / 1 fail（`红字必须点名 profile/service.ts:61`） |
| 复原后：`sql-column-coverage` / 守卫 | 0 / 0 | 16/16、7/7 |
| `npm run test:unit`（全量） | **0** | **3627 tests / 3626 pass / 0 fail / 1 skipped**（88.7s） |

## 6. 下一批建议（本片刻意没做）

1. **`docs/architecture/contract-status.json` 的证据锚点** —— 归另一片的 `verify-contract-status.mjs --reanchor`，本片不碰。
2. **散文里的行号**（`reason:` 里 33+ 条 `privacy/ledger-pg.ts:642/655`、`error-retryable-static-guard.test.mjs:50` 的 `errors.ts:28-40`）：
   不判红，但确实会过期。建议下一步给「`reason:` 里引用源码行号」定一个和本片同形的实时定位约定（`SQL: …:line` → 现算）。
3. **歧义锚点 3 处**（`community-filter-pg.mjs:523`、`tts-content-wiring.mjs:207`、`messages-store-pg-contract.test.mjs:220` 的裸 `service.ts:`/`store.ts:`）：
   现在只清点不判红；下一步应改成全路径（顺带消灭 16 个同名候选带来的歧义）。
4. **`.md` / `.json` 里的行号引用**（文档引用源码行、契约 JSON 的 `evidence[].lines`）：本片范围外（JSON 由生成器整段重排，文档行号是引用出处而非语句站点）；
   若要收口，需要一个独立的「文档锚点」守卫，别和本片的断言口径混在一张表里。
5. **`migration-pin-guard.test.mjs:382/387` 的历史提交行号**（`ocr-jobs-pg.mjs:256，622448d 之前`）：那是「当时那次提交的坐标」，
   刻意不能现算；如果要动，建议改成「提交号 + 符号名」而不是行号。

## 7. 红线自查

- 未合并、未 approve、未推 `main`、未强推；只在 `test/gy-r31-line-anchors` 上提交。
- 未改业务代码（`services/**` 只在 4.2 证明期间临时插 3 行，已 `git checkout` 复原，`git status` 无残留）。
- 未改 `docs/architecture/contract-status.json`；未删任何断言（只换期值的来源、并把 2 处后缀匹配加严成全路径匹配）。
- 未提交 `node_modules`、日志、临时脚本（`tmp-line-anchor-inventory.mjs` 已删）。
