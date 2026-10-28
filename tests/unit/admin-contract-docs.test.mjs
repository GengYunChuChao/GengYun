/**
 * GY-R68 A04 回归闸门：`/admin/**` 的 summary／description 改写成果必须**有人守**。
 *
 * 缺口的形状（本片审查实测，HEAD `1f9fe086`）：
 *   把任意 1 条 summary 改回 operationId、或把任意 1 条 description 改回模板句 ⇒
 *   7 条门禁 + 两条 python 校验 + `npm run test:unit` **全绿**。也就是说「49 条 admin 操作
 *   不再用 operationId 冒充摘要」这件事当时只落在文件里，没有任何断言记得它。
 *
 * 本文件只读 `packages/contracts/openapi.json`，零依赖，`node --test` 直接跑。四组断言：
 *
 *   A 覆盖面／反空转：数量与名单是**实测值**，不是「随便扫到几条都算过」——
 *     A1 `/admin/**` operation 数 === 49；A2 `REWRITTEN_ADMIN_OPS` 恰好 21 个且逐个能在 spec
 *     里找到（找不到即红：名单漂移必须先红，而不是静默跳过）；
 *     A3 其余族（非 admin）里 `summary === operationId` 的 operation 数 **≤ 77**——77 是当前的
 *     **欠账上限**，做其他族后只会下降；**下降是好事、不判红**，上升才是退化（有人把 summary
 *     改回 operationId）。⛔ 别把欠账钉成精确期望：钉死会让「改善」也判红，将来做 `me` 族时
 *     变成「做了反而红」的反向枷锁。做其他族后把上限同步下调（或删掉这条）。
 *
 *   B 退化检测（对 21 个改写过的 op 逐个）：summary 不再等于 operationId、summary 含汉字、
 *     description 不等于（也不包含）模板句。B 的失败清单一次性列全——先红时就是「summary 等于
 *     operationId 那一批」。
 *
 *   C 反同义反复（**期望值从 op 自己的字段派生，不抄任何文本**）：
 *     ① description 必须出现该 op 自己 `x-scope` 里的字面量（多 scope 时任一即可）；
 *     ② description 必须出现至少一个**该 op 自己 `responses` 键**里的三位状态码；
 *     ③ 若该 op 的 `parameters` 声明了 `Idempotency-Key` / `If-Match`（`in: header`，含 `$ref`
 *        解析），description 必须出现该 header 名字面量。
 *     C 另外自带反空转：① 不许有 op 缺 `x-scope` 被静默跳过；③ 分支必须真的命中到 op（否则
 *     ③ 恒真）。这三条保证「描述里那段 scope／状态码／头部名是真的从契约抄出来的」，而不是
 *     恰好抄成另一句模板。
 *
 *   D SUFFIX 白名单**只减不增**：`PENDING_SUFFIX_OPS` 里剩下的是「summary 已改、description 仍是
 *     模板句」的显式欠账（原 8 条，R68 后缀清理销掉 7 条，只剩 `listAdminCategories`——它的实现
 *     另有分支在改）。D 双向判：白名单里每条**当前仍含**模板句（否则判红并提示「从白名单
 *     删除」，欠账还清了就必须销账）；白名单外**任何** admin op 的 description 不得含模板句
 *     （堵住「新写一条又抄回模板句」）。另钉住**白名单长度 === 1**：否则「把某条 description
 *     改回模板句 + 在白名单里加一行」是既退化又合法登记的，D 会全绿（审查实测 8/8 绿）。
 *
 * 读取路径：默认 `packages/contracts/openapi.json`（仓内真文件）。环境变量 `GY_OPENAPI_PATH`
 * 只服务于「先红／变异自证」——把待验副本指过去跑同一个文件，默认值与产品代码行为不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），⛔ 不用 `process.cwd()`。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 仓内真文件。这是**默认且唯一**的产品口径；下行的覆盖只给自证用。 */
const DEFAULT_SPEC_PATH = resolve(REPO_ROOT, 'packages', 'contracts', 'openapi.json');

/** 自证专用覆盖：只在显式传入时生效（用于「先红」与变异 M1–M4 指向临时副本）。 */
const SPEC_PATH = process.env.GY_OPENAPI_PATH
  ? resolve(process.env.GY_OPENAPI_PATH)
  : DEFAULT_SPEC_PATH;

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));

/** 21 条已被改写的 admin 操作（本片实测：`git diff de2aa3c6..1f9fe086` 里 description 变化的那批）。 */
const REWRITTEN_ADMIN_OPS = Object.freeze([
  'editSourceDraft',
  'getAdminKnowledge',
  'getAdminRegistration',
  'getAdminRestriction',
  'getAdminSession',
  'getAdminSource',
  'listAdminKnowledge',
  'listAdminRegistration',
  'listAdminRestriction',
  'listAdminSources',
  'listAdminUsers',
  'listAuditEvents',
  'listFlagAuditEvents',
  'listFlags',
  'logoutAdmin',
  'setFlag',
  'suspendUser',
  'withdrawKnowledge',
  'withdrawRegistration',
  'withdrawRestriction',
  'withdrawSource',
]);

/** 仍欠账的 admin 操作：summary 已改，description 还是模板句。⛔ 只减不增。 */
const PENDING_SUFFIX_OPS = Object.freeze([
  'listAdminCategories',
]);

/** 改造前的统一占位句（本片要消灭的那一句）。逐字比对，不做归一化。 */
const TEMPLATE_DESCRIPTION = '遵循状态协议：服务端归属/当前版本/授权检查；未满足条件返回明确错误。';

/** `/admin/**` operation 实测数（A1）。 */
const ADMIN_OP_COUNT = 49;

/**
 * 其余族里 `summary === operationId` 的 operation **上限**（A3）。
 * 77 是当前的欠账上限，做其他族后只会下降；若上升说明有人把 summary 改回 operationId，属退化。
 * ⛔ 只在「A04 其余族还没做」时成立：做其他族时把上限同步下调（或删掉这条）。
 */
const NON_ADMIN_SUMMARY_EQUALS_ID_COUNT = 77;

/** 方法白名单：openapi 里只可能出现这几种 operation 键。 */
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

/** `p` 是否属于后台族（`/admin` 与 `/admin/...`）。 */
function isAdminPath(p) {
  return p === '/admin' || p.startsWith('/admin/');
}

/** 扫全 spec，返回 `{ admin, others }` 两组 `{ path, method, op }`。 */
function collectOperations(document) {
  const admin = [];
  const others = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op || typeof op !== 'object' || !op.operationId) continue;
      (isAdminPath(path) ? admin : others).push({ path, method, op });
    }
  }
  return { admin, others };
}

const { admin: adminOps, others: otherOps } = collectOperations(spec);
const adminById = new Map(adminOps.map((entry) => [entry.op.operationId, entry]));

/** 含汉字即算中文摘要（用 Unicode script 属性，⛔ 不用手写码点区间）。 */
const HAN = /\p{Script=Han}/u;

/** 解析 `$ref`（只覆盖本 spec 用到的 `#/components/parameters/*` 与就地参数）。 */
function derefParameter(parameter) {
  if (!parameter || typeof parameter !== 'object' || !parameter.$ref) return parameter;
  const name = parameter.$ref.split('/').pop();
  return spec.components?.parameters?.[name] ?? null;
}

/** 某 op 的 `x-scope` 字面量列表（字符串拆 `/`，数组摊平；缺声明返回 `[]`）。 */
function scopesOf(op) {
  const raw = op['x-scope'];
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw) ? raw : String(raw).split('/');
  return values.map((value) => String(value).trim()).filter(Boolean);
}

/** 某 op 声明在 `parameters` 里的 header 名（含 `$ref` 解析；解析不到记 `null`）。 */
function headerNamesOf(op) {
  const parameters = Array.isArray(op.parameters) ? op.parameters : [];
  return parameters
    .map(derefParameter)
    .filter(Boolean)
    .filter((parameter) => parameter.in === 'header')
    .map((parameter) => parameter.name);
}

test('A1 `/admin/**` operation 数 === 49（扫描面反空转）', () => {
  assert.notEqual(SPEC_PATH, '', '读取路径为空');
  assert.ok(
    Object.keys(spec.paths ?? {}).length > 0,
    `扫描面为空：\`${SPEC_PATH}\` 里一条 path 都没有——这种「扫到什么算什么」的绿灯等于没守`
    + '（检查 `GY_OPENAPI_PATH` 是否指错了文件）',
  );
  assert.equal(
    adminOps.length,
    ADMIN_OP_COUNT,
    `\`/admin/**\` operation 数变了：实测 ${adminOps.length}，本闸门记的是 ${ADMIN_OP_COUNT}。\n`
    + `当前 admin operationId：${adminOps.map((entry) => entry.op.operationId).sort().join(', ')}\n`
    + '新增/删除后台操作必须同步改这条常量与 A2 名单（否则「覆盖面」这条会悄悄缩水）。',
  );
});

test('A2 REWRITTEN_ADMIN_OPS 恰好 21 个，且逐个在 spec 里找得到', () => {
  assert.equal(
    REWRITTEN_ADMIN_OPS.length,
    21,
    `改写名单长度应为 21，实测 ${REWRITTEN_ADMIN_OPS.length}`,
  );
  assert.equal(
    new Set(REWRITTEN_ADMIN_OPS).size,
    REWRITTEN_ADMIN_OPS.length,
    '改写名单里有重复 operationId',
  );
  const missing = REWRITTEN_ADMIN_OPS.filter((id) => !adminById.has(id));
  assert.deepEqual(
    missing,
    [],
    `以下 operationId 在 \`/admin/**\` 里找不到（改名/删除/拼错）：${missing.join(', ')}\n`
    + '⛔ 名单找不到就跳过＝这条 op 从此没人守，所以这里必须先红。',
  );
  const overlap = REWRITTEN_ADMIN_OPS.filter((id) => PENDING_SUFFIX_OPS.includes(id));
  assert.deepEqual(
    overlap,
    [],
    `以下 operationId 同时出现在「已改写」与「仍欠账」两份名单里（互斥被破坏）：${overlap.join(', ')}`,
  );
});

test('A3 非 admin 族里 `summary === operationId` 的 operation 数 ≤ 77（欠账上限，只降不升）', () => {
  // 77 是当前的欠账上限，做其他族后只会下降；若上升说明有人把 summary 改回 operationId，属退化。
  const suffix = otherOps.filter((entry) => entry.op.summary === entry.op.operationId);
  assert.ok(
    suffix.length <= NON_ADMIN_SUMMARY_EQUALS_ID_COUNT,
    `非 admin 族里 \`summary === operationId\` 的 operation 实测 ${suffix.length} 条，`
    + `上限 ${NON_ADMIN_SUMMARY_EQUALS_ID_COUNT} 条 —— 下降是好事（其余族改写生效），`
    + '上升是退化（有人把 summary 写回了 operationId）。\n'
    + `命中示例：${suffix.slice(0, 8).map((entry) => entry.op.operationId).join(', ')}\n`
    + '⛔ 上限不是精确期望：别把 77 当成「必须正好 77」——真改好了却判红，等于罚人做正确的事。\n'
    + '若是「其余族已经改写」造成的下降 ⇒ 把上限改小或删掉这条（它是临时口径，不是永恒目标）；'
    + '若是「admin 判定把别人算进来了」⇒ 查 `isAdminPath()`。',
  );
});

test('B 21 条改写过的 admin op：summary 不再是 operationId、含汉字、description 不再是模板句', () => {
  const problems = [];
  for (const id of REWRITTEN_ADMIN_OPS) {
    const entry = adminById.get(id);
    if (!entry) continue; // A2 已单独判红
    const { path, method, op } = entry;
    if (op.summary === op.operationId) {
      problems.push(`summary 等于 operationId（${method.toUpperCase()} ${path}）：${JSON.stringify(op.summary)}`);
    }
    if (!HAN.test(String(op.summary ?? ''))) {
      problems.push(`summary 不含汉字（${method.toUpperCase()} ${path}）：${JSON.stringify(op.summary)}`);
    }
    if (String(op.description ?? '').trim() === TEMPLATE_DESCRIPTION) {
      problems.push(`description 退化成模板句（${method.toUpperCase()} ${path}）：${id}`);
    }
    if (String(op.description ?? '').includes(TEMPLATE_DESCRIPTION)) {
      problems.push(`description 仍把模板句整句留在里面（${method.toUpperCase()} ${path}）：${id}`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    `以下 ${problems.length} 处退化（summary 那几条就是把 summary 改回 operationId 的样子）：\n  - `
    + `${problems.join('\n  - ')}\n`
    + '这一片的价值全在「摘要/描述说人话、说可核对的事实」；退回去必须红，而不是靠人肉记性。',
  );
});

test('C① description 必须含该 op 自己 x-scope 里的字面量（期望值从 op 派生）', () => {
  const problems = [];
  let asserted = 0;
  for (const id of REWRITTEN_ADMIN_OPS) {
    const entry = adminById.get(id);
    if (!entry) continue;
    const { path, method, op } = entry;
    const scopes = scopesOf(op);
    if (scopes.length === 0) {
      problems.push(`op 没有 \`x-scope\`，本条无法派生期望值（${method.toUpperCase()} ${path}）：${id}`);
      continue;
    }
    const description = String(op.description ?? '');
    const hit = scopes.filter((scope) => description.includes(scope));
    if (hit.length === 0) {
      problems.push(
        `description 里一个 scope 字面量都没有（${method.toUpperCase()} ${path}）：${id}`
        + ` 声明 ${JSON.stringify(op['x-scope'])}`,
      );
      continue;
    }
    asserted += 1;
  }
  assert.ok(asserted > 0, 'C① 一条 op 都没断言到 ⇒ 恒真');
  assert.deepEqual(problems, [], `以下 ${problems.length} 处 scope 与描述对不上：\n  - ${problems.join('\n  - ')}`);
});

test('C② description 必须含至少一个该 op 自己 responses 里的三位状态码（期望值从 op 派生）', () => {
  const problems = [];
  let asserted = 0;
  for (const id of REWRITTEN_ADMIN_OPS) {
    const entry = adminById.get(id);
    if (!entry) continue;
    const { path, method, op } = entry;
    const declared = Object.keys(op.responses ?? {}).filter((code) => /^[0-9]{3}$/.test(code));
    if (declared.length === 0) {
      problems.push(`op 没有三位状态码声明，本条无法派生期望值（${method.toUpperCase()} ${path}）：${id}`);
      continue;
    }
    const description = String(op.description ?? '');
    const hit = declared.filter((code) => description.includes(code));
    if (hit.length === 0) {
      problems.push(
        `description 里没有任何一个本 op 声明的状态码（${method.toUpperCase()} ${path}）：${id}`
        + ` 声明 ${declared.join(',')}`,
      );
      continue;
    }
    asserted += 1;
  }
  assert.ok(asserted > 0, 'C② 一条 op 都没断言到 ⇒ 恒真');
  assert.deepEqual(problems, [], `以下 ${problems.length} 处状态码与描述对不上：\n  - ${problems.join('\n  - ')}`);
});

test('C③ 声明了 Idempotency-Key／If-Match 的 op，description 必须写出该 header 名', () => {
  const watched = ['Idempotency-Key', 'If-Match'];
  const problems = [];
  let asserted = 0;
  for (const id of REWRITTEN_ADMIN_OPS) {
    const entry = adminById.get(id);
    if (!entry) continue;
    const { path, method, op } = entry;
    const headers = headerNamesOf(op).filter((name) => watched.includes(name));
    if (headers.length === 0) continue;
    asserted += 1;
    const description = String(op.description ?? '');
    const missing = headers.filter((name) => !description.includes(name));
    if (missing.length > 0) {
      problems.push(
        `description 没写出已声明的 header（${method.toUpperCase()} ${path}）：${id}`
        + ` 缺 ${missing.join(',')}`,
      );
    }
  }
  // 反空转：这 21 条里确实有一批声明了幂等/版本头，否则本组断言等于没跑。
  assert.ok(
    asserted > 0,
    'C③ 分支在 21 条改写过的 op 里一次都没命中（没有任何 op 声明 Idempotency-Key／If-Match）'
    + ' ⇒ 这条断言恒真。要么参数改成了别的形制，要么 `$ref` 解析坏了。',
  );
  assert.deepEqual(problems, [], `以下 ${problems.length} 处 header 与描述对不上：\n  - ${problems.join('\n  - ')}`);
});

test('D SUFFIX 白名单只减不增（双向）', () => {
  assert.equal(new Set(PENDING_SUFFIX_OPS).size, PENDING_SUFFIX_OPS.length, '欠账名单里有重复 id');
  // 钉子：白名单长度本身也不许涨。没有这条时，「把某 op 的 description 改回模板句 + 在
  // PENDING_SUFFIX_OPS 里加一行」这种「既退化了又合法登记」能让 D 全绿（审查实测 8/8 绿）。
  assert.equal(
    PENDING_SUFFIX_OPS.length,
    1,
    `SUFFIX 白名单长度应为 1，实测 ${PENDING_SUFFIX_OPS.length}：白名单只许减不许增；`
    + '清理某条后就把它删掉，并把这里的期望值同步下调。',
  );
  const problems = [];
  for (const id of PENDING_SUFFIX_OPS) {
    const entry = adminById.get(id);
    if (!entry) {
      problems.push(`欠账名单里的 ${id} 已不是 admin operation（改名/删除）⇒ 从 PENDING_SUFFIX_OPS 删除`);
      continue;
    }
    const description = String(entry.op.description ?? '');
    if (!description.includes(TEMPLATE_DESCRIPTION)) {
      problems.push(
        `\`${id}\` 的 description 已不再含模板句 ⇒ 欠账已还清，请把 ${id} 从 PENDING_SUFFIX_OPS 删除`
        + '（白名单只减不增：留着它会让后来人以为这里还有欠账）',
      );
    }
  }
  // 反向：白名单外任何 admin op 都不得含模板句（堵住「新抄回一句模板」）。
  const leaked = adminOps
    .filter((entry) => String(entry.op.description ?? '').includes(TEMPLATE_DESCRIPTION))
    .map((entry) => entry.op.operationId)
    .filter((id) => !PENDING_SUFFIX_OPS.includes(id));
  for (const id of leaked) {
    problems.push(
      `\`${id}\` 的 description 含模板句，但不在 PENDING_SUFFIX_OPS 里 ⇒ `
      + '要么把它改写成可核对的事实，要么显式登记欠账（⛔ 不许静默新增）',
    );
  }
  assert.deepEqual(
    problems,
    [],
    `SUFFIX 白名单与事实不符（${problems.length} 处）：\n  - ${problems.join('\n  - ')}`,
  );
});
