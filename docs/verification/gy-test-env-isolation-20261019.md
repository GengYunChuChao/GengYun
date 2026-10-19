# 单测环境变量跨文件泄漏：修复与复核（GY-TEST-HYGIENE，Refs #22）

本片只做一件测试卫生修复：把「模块级写 `process.env`」改成「用例内打开 + 用例结束复原」，
让 `APP_KNOWLEDGE_UNVERIFIED_SEED` 不再从 `tests/unit/favorites-*` 泄漏给同进程的
`tests/unit/knowledge-*`。**不改产品代码、不改断言期望、不加 `skip`／`todo`、不删任何用例。**

## 1 结论

- 两个测试文件里的模块级环境变量赋值已改为用例内设置 + 复原（`t.after`／`finally`），并各自
  加了一条「跑完后必须与模块加载时逐字相同」的自证断言：泄漏不再靠人盯，而是会直接变红。
- 验收跑法 C（`--test-isolation=none`）的 knowledge 域假红 **8 条全部消失**（基线 9 fail →
  1 fail）；权威跑法 B（默认隔离）与基线同绿同数。
- **残余 1 红与本片无关**：`tests/unit/miniprogram-transcript-confirm.test.mjs:422` 在进程内
  跑法下有一条墙钟竞态的用例（详见 §5），基线即红、与本片改动零耦合，本片不越范围去改它。

## 2 根因链

1. `tests/unit/favorites-visibility-wiring.test.mjs`（旧第 34 行）在**模块顶层**执行
   `process.env['APP_KNOWLEDGE_UNVERIFIED_SEED'] = '1'`。该文件在 `import` 阶段就写进程环境。
2. `services/api/src/routes/knowledge.ts:163` 在 `registerKnowledgeRoutes()` 内读它：
   `const unverifiedSeedEnabled = /^(1|true)$/i.test(process.env['APP_KNOWLEDGE_UNVERIFIED_SEED'] ?? '');`
   注册发生在 `buildApp()` 期间 ⇒ **一个进程只读一次**，读到什么就决定这个进程的 `/knowledge`
   是否并入 159 条未发布/未核对投影（`/163/:167/:170-172`）。
3. `node --test --test-isolation=none` 让 142 个用例文件共享同一个进程与同一个 `process.env`；
   文件按路径升序执行 ⇒ `tests/unit/favorites-…` 排在 `tests/unit/knowledge-…` 之前，写进去的
   `'1'` 一直留在进程里，后面每个 knowledge 用例 `buildApp()` 时都读到"开"。
4. 直接物证（基线 C 日志）：`tests/unit/knowledge-herbicides-http.test.mjs:286` 的
   `assert.deepEqual(res.json().data, { items: [], next_cursor: null })` 实际拿到 **50 条** seed 行
   + `next_cursor`，且每行 `source.source_kind: 'verified_seed'`、`review_status: 'unverified'`
   —— 正是"默认关闭、却把未发布内容放行"的形状。
5. 为什么默认隔离看不见：每个用例文件独立子进程，`process.env` 不共享 ⇒ 只有 no-isolation 才暴露。

## 3 改动清单

| 文件 | 行 | 改动 |
| --- | --- | --- |
| `tests/unit/favorites-visibility-wiring.test.mjs` | 23 | `import { test }` → `import { after, test }` |
| 同上 | 32-55 | 删掉模块级赋值，改为常量 + 加载时快照 + `armUnverifiedSeed(t)` 辅助函数 |
| 同上 | 176 / 196 / 252 | 三个用例体首行插入 `armUnverifiedSeed(t);`（在 `fixture()` 之前打开开关） |
| 同上 | 342-350 | 文件末尾新增 `after(...)` 自证：跑完后开关必须与模块加载时逐字相同 |
| `tests/integration/profile-ui-http.test.mjs` | 2-7 | 删掉模块级赋值，改为常量 + 加载时快照 |
| 同上 | 10 | 用例体内先存原值再打开开关（在夹具 `createProfileFixture()` 之前） |
| 同上 | 75 | `finally` 里复原（原本不存在就 `delete`，否则写回原值） |
| 同上 | 79-83 | 新增一条自证用例：跑完后开关与模块加载时逐字相同 |

### 3.1 `tests/unit/favorites-visibility-wiring.test.mjs`

改前（旧第 32-34 行）：

```js
// 本地联调（`tools/local-dev/api.mjs`）与 Demo 用同一开关：浙江首批真实资料并入 `/knowledge`。
// 必须在 `buildApp` **之前**设置——`routes/knowledge.ts` 在注册路由时读取该开关。
process.env['APP_KNOWLEDGE_UNVERIFIED_SEED'] = '1';
```

改后（第 32-55 行）：

```js
// 本地联调（`tools/local-dev/api.mjs`）与 Demo 用同一开关：浙江首批真实资料并入 `/knowledge`。
// 必须在 `buildApp` **之前**设置——`routes/knowledge.ts` 在注册路由时读取该开关。
// 但**不得**写成模块级赋值：`node --test --test-isolation=none` 让同进程的所有用例文件共享
// 同一个 `process.env`，模块级写 `'1'` 会一路带到后面跑的文件（本文件 `f…` 排在 `knowledge-*`
// 之前），使本该读到空列表的 `/knowledge` 用例读进 159 条未发布投影。故改成「用例内打开 +
// 结束复原」，并把复原本身变成断言（泄漏即变红，而不是靠人盯）。
// 见 `docs/verification/gy-test-env-isolation-20261019.md`。
const UNVERIFIED_SEED = 'APP_KNOWLEDGE_UNVERIFIED_SEED';
// 模块加载瞬间的原值：整个文件跑完必须回到它（文件末尾的 `after` 自证）。
const UNVERIFIED_SEED_AT_LOAD = process.env[UNVERIFIED_SEED];

/**
 * 在用例内打开浙江首批投影开关，并把复原动作挂到该用例的 `t.after`：
 * 记下进来时的原值，用例结束后写回（原本不存在就 `delete`），随后断言确实已复原。
 */
function armUnverifiedSeed(t) {
  const previous = process.env[UNVERIFIED_SEED];
  process.env[UNVERIFIED_SEED] = '1';
  t.after(() => {
    if (previous === undefined) delete process.env[UNVERIFIED_SEED];
    else process.env[UNVERIFIED_SEED] = previous;
    assert.equal(process.env[UNVERIFIED_SEED], previous, `用例结束后必须复原 ${UNVERIFIED_SEED}（不得跨文件泄漏）`);
  });
}
```

三个用例的插入点（每个都在 `const f = await fixture();` 之前，保证 `buildApp` 时开关已开）：

```js
test('收藏可见性接线③：未登录仍 401 SESSION_REQUIRED（登录门口径不变）', async (t) => {
  armUnverifiedSeed(t);
  const f = await fixture();
```

```js
test('收藏可见性接线①：数据库读视图里当前可读的资料 ⇒ 收藏行「可用」；下架/改版/恢复逐次重派生', async (t) => {
  armUnverifiedSeed(t);
  const f = await fixture();
```

```js
test('收藏可见性接线②：`/knowledge` 列表里能读到的资料（浙江首批投影）收藏后必须「可用」且详情可打开', async (t) => {
  armUnverifiedSeed(t);
  const f = await fixture();
```

文件末尾新增（第 342-350 行）：

```js
// 文件级自证（默认隔离下恒真；`--test-isolation=none` 下才是真检查）：本文件跑完后，
// 开关必须与模块加载时逐字相同——即本文件没有向后跑的文件泄漏任何环境变量。
after(() => {
  assert.equal(
    process.env[UNVERIFIED_SEED],
    UNVERIFIED_SEED_AT_LOAD,
    `${UNVERIFIED_SEED} 在本文件跑完后仍未复原（跨文件环境变量泄漏）`,
  );
});
```

### 3.2 `tests/integration/profile-ui-http.test.mjs`

同一批 env 的第二个模块级写入点（集成目录，本片按"逐文件登记"一并修）：改前第 4 行
`process.env.APP_KNOWLEDGE_UNVERIFIED_SEED='1';` 已删除，改为：

```js
const UNVERIFIED_SEED='APP_KNOWLEDGE_UNVERIFIED_SEED',UNVERIFIED_SEED_AT_LOAD=process.env[UNVERIFIED_SEED];
```

用例体首行（第 10 行，在 `createProfileFixture()` 之前）：

```js
 const previousSeed=process.env[UNVERIFIED_SEED];process.env[UNVERIFIED_SEED]='1';
```

`finally`（第 75 行）追加复原：

```js
 }finally{await Promise.allSettled([...pending]);await f.close();if(previousSeed===undefined)delete process.env[UNVERIFIED_SEED];else process.env[UNVERIFIED_SEED]=previousSeed}
```

文件末尾新增自证用例（第 79-83 行）：

```js
test('环境变量复原：本文件跑完后 '+UNVERIFIED_SEED+' 与模块加载时逐字相同（不跨文件泄漏）',()=>{
 assert.equal(process.env[UNVERIFIED_SEED],UNVERIFIED_SEED_AT_LOAD,UNVERIFIED_SEED+' 在本文件跑完后仍未复原（跨文件环境变量泄漏）');
});
```

## 4 四组读数

工作树 `E:\GengYunCommander\.pg17\wt-test-hygiene`，基线 `upstream/main` = `d131e473409d1d41236468ec49208a73f57bd7e4`，
Node `v24.16.0`。日志落在 `E:\GengYunCommander\.pg17\tmp\test-hygiene-env\`（`base-*.txt` = 基线，
`after-*.txt` = 本次）。基线那三组跑在**未改动任何文件**的树上。

| 组 | 跑法 | 基线 d131e47 | 本次改动后 |
| --- | --- | --- | --- |
| A | `node --test "tests/unit/favorites-visibility-wiring.test.mjs"`（默认隔离） | exit 0；tests 3 / pass 3 / fail 0 / skipped 0 | exit 0；tests 3 / pass 3 / fail 0 / skipped 0 |
| B | `node --test "tests/unit/*.test.mjs"`（**权威跑法**） | exit 0；tests 1698 / pass 1697 / fail 0 / skipped 1 / duration_ms 55606.4892 | exit 0；tests 1698 / pass 1697 / fail 0 / skipped 1 / duration_ms 97963.894 |
| C | `node --test --test-isolation=none "tests/unit/*.test.mjs"`（**仅验收手段**） | exit 1；tests 1698 / pass 1688 / fail 9 / skipped 1 / duration_ms 140417.4734 | exit 1；tests 1698 / pass 1696 / fail 1 / skipped 1 / duration_ms 169030.8844 |
| D | `python -B tools/validate_development_docs.py`、`git diff upstream/main --check`、`git status --porcelain` | PASS / 空 / 空 | PASS / 空 / 提交后 0 行 |

补充读数：`node --test "tests/integration/profile-ui-http.test.mjs"` ⇒ exit 0，
`tests 2 / pass 2 / fail 0 / cancelled 0 / skipped 0 / duration_ms 4409.5456`（第 2 条即新增的
环境变量复原自证；开关在用例内打开后，"档案驱动科普查询"仍取到浙江首批资料，用例内的
`/knowledge` 断言全部照常通过 ⇒ 还原的是 env 卫生，不是行为）。

### 4.1 C 的失败集合逐条对照

| 用例 | 基线 C | 本次改动后 C |
| --- | --- | --- |
| `knowledge real projection and limited runtime over loopback HTTP (synthetic only)`（外层） | ✖ | ✔ |
| `real empty, guest denial, invalid filter, unconfigured pool is not static fallback` | ✖ | ✔ |
| `list and detail frozen entity equality, real ETag and no-store; structured and keyword filters` | ✖ | ✔ |
| `knowledge pagination fixed chain deadline, epoch/version/domain/expiry guards over product HTTP` | ✖ | ✔ |
| `cursor subject, filter, signature, next page and visibility watermark binding` | ✖ | ✔ |
| `unverified, expired, withdrawn, future, missing source and body fields never leak` | ✖ | ✔ |
| `current source changes remove stale old-version knowledge; newer hidden revision blocks fallback` | ✖ | ✔ |
| `/knowledge 默认不并入浙江首批：开关关闭时列表仍为空（不把未发布内容默认放行）` | ✖ | ✔ |
| `页面·记录就绪前与空草稿 ⇒ 零 PATCH、零轮次请求（未明确确认不外发）` | ✖ | ✖（与本片无关，见 §5） |

前 8 行即派单所说的"8 条 knowledge 红"，全部消失；它们在基线 C 里 `pass 1688 / fail 9`，
现在 `pass 1696 / fail 1`。A 组三条用例的 `t.diagnostic` 读数仍打印"浙江首批投影……收藏行
available"（species / herbicide / scheme 三类各一条）⇒ 开关在用例内确实是开的。

## 5 未取得项：C 组的残余 1 红（另一类缺陷，已定性，不在本片范围）

- 用例：`tests/unit/miniprogram-transcript-confirm.test.mjs:422`
  「页面·记录就绪前与空草稿 ⇒ 零 PATCH、零轮次请求（未明确确认不外发）」，
  报 `TypeError: releaseGet is not a function`（抛在该文件第 437 行）。
- **与本片零耦合的证明**：基线树（未改动任何文件）上单跑
  `node --test --test-isolation=none "tests/unit/miniprogram-transcript-confirm.test.mjs"`
  连跑 3 次，3 次都是 `tests 25 / pass 24 / fail 1`（8.5742ms / 8.3204ms / 7.658ms）；而默认隔离
  下同一条读数是 `✔ … (195.2234ms)`。也就是说：红不红取决于**同一进程里跑还是子进程里跑**，
  与本文件写不写 env 无关。
- 根因（墙钟竞态）：该文件第 301 行把 `transcript.POLL_INTERVAL_MS` 压到 `5`（毫秒），页面
  `onRequestTranscript()` 受理后由 `setTimeout(…, 5)` 落第一拍记录 GET；用例第 431-434 行只
  `await flushMicrotasks(2)`（＝两次 `setImmediate` 轮次）就假定这拍 GET 已经在路上，第 437 行
  直接调用 `releaseGet(...)`。进程隔离下这一小段实际耗掉约 195ms（>5ms，定时器已落）⇒ 通过；
  进程内热跑只要约 8ms（<5ms，定时器未落）⇒ `releaseGet` 仍是 `null` ⇒ TypeError。
- 反证（把假设变成结论）：同一条 no-isolation 命令加一个**不进仓库**的临时垫片
  （`E:\GengYunCommander\.pg17\tmp\test-hygiene-env\slow-immediate.mjs`，把每个 `setImmediate`
  回调再推迟 8ms），结果立刻变成 `tests 25 / pass 25 / fail 0`、exit 0 ⇒ 唯一变量是等待时长。
- 为什么本片不改它：它是"用例同步方式"缺陷（该文件另有第 803、918 行两处同形点），修法要改
  等待逻辑（改成显式等 `releaseGet !== null`，或先 `assert.ok(...)` 再调用），与"消除 env
  跨文件泄漏"是两件事；按派单的"范围极小、不改断言期望"要求，留待独立一片处理（建议同一批
  测试卫生任务里跟进，改动同样只落在测试文件）。

## 6 跑法纪律

- **默认隔离 `node --test "tests/unit/*.test.mjs"` 仍是权威跑法**，本片全部改动在该跑法下与基线
  同名同数（fail 0 / skipped 1）。
- `--test-isolation=none` 只是**本次验收手段**：用来把"跨文件共享 `process.env`"这类缺陷逼出来，
  不作为常规跑法、也不建议加进 CI 门槛（§5 的残余红说明这种跑法的红并不都是环境泄漏，需要
  逐条归因）。
- 本片未 push、未开 PR、未评论；只改两个测试文件，未触碰产品代码、契约、迁移与
  `contract-status.json`。
