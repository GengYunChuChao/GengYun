/**
 * GY-I27（#29）第六片 · 删除处理器**注册缺口棘轮**（结构断言，不连库、不跑清除）。
 *
 * 为什么需要它：`USER_DATA_DELETION_MODULES` 是「注销时承诺一定清理的域」的闭集，
 * 但闭集本身只是四个字符串；**没有任何断言把闭集与「真实存在哪些用户数据表」对上**。
 * 于是新增一张带 `user_id`/`owner_id` 的表时，谁都不会被提醒「这张表有没有人清」——
 * 这正是 #17 的原始缺口形态（有清理原语却不进闭集，协调器根本不会驱动它）。
 *
 * 本文件把缺口变成**可执行的清单**：
 *   1. 从 `services/api/db/migrations/*.sql` 静态枚举全部「用户数据表」（带 user/owner 主体列
 *      或有指向 `users` 的外键）；
 *   2. 从 `services/api/src/privacy/user-data-deletion.ts` 静态读出闭集（与源码同源，不复制一份常量）；
 *   3. 每张用户数据表必须落在二者之一：**被某个已注册模块覆盖**（`MODULE_TABLE_COVERAGE`），
 *      或**显式声明为未注册**并写明阻塞原因与归属编号（`DECLARED_UNREGISTERED`）。
 *      新增表既没覆盖也没声明 ⇒ 红，且报错直接列出表名。
 *
 * 声明表就是对「哪些域已注册、哪些没注册、为什么」的**机器可校验答案**；原因写不出来
 * （不是「暂缓」而是不知道谁清）就不许登记 —— 这是本断言能挡住的主要退化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const MIGRATIONS_DIR = new URL('../../services/api/db/migrations/', import.meta.url);
const USER_DATA_DELETION_SRC = new URL('../../services/api/src/privacy/user-data-deletion.ts', import.meta.url);

/** 主体列名闭集：出现其一即视为「按用户归属的数据表」。 */
const SUBJECT_COLUMNS = ['user_id', 'owner_id', 'author_user_id', 'subject_user_id', 'grantee_user_id'];

/**
 * 已注册模块 → 该模块处理器**按主体处理**的表（读 `*​/store-pg.ts` 的 SQL 得出）。
 * `conversation_turns`/`conversation_answers` 由 `conversations` 的 `ON DELETE CASCADE` 连带清空
 * （`0013_conversations.sql:64`/`:105`）。幂等台账与正文行同一事务清空（`purgeOwnerData`）。
 *
 * `community` 是**装配处条件追加**的第五域（`user-data-deletion.ts` 的
 * `COMMUNITY_DELETION_MODULE`）：F13 要求**保留**帖子/评论正文（不是删光），所以这里的"覆盖"
 * 指"该模块按主体处理这些表"——安全正文保留、个人信息清除、媒体引用移除、点赞物理删、
 * 举报清自由文本。⛔ 不要把它读成"这些表会被清空"。
 *
 * `recognitions` / `speech` 是 #19 延续片接入的第六/第七域（同样条件追加，`app.ts` 无条件注入）：
 * 与社区域不同，这两域**真的是清空**（按主体物理删），顺序由迁移 0025/0026 的外键钉死：
 * 识别域 `recognition_selections`（子，`0025:163` CASCADE 指向 records）→
 * `recognition_jobs` → `recognition_records` → `recognition_idempotency`（无主体列，按 scope 前缀）；
 * 语音域 `speech_jobs` → `transcriptions` → `speech_idempotency`（无主体列，按 scope 前缀）。
 *
 * `ocr` 是 R34 片 3（#19 / #10）接入的第八域（同样条件追加 + `app.ts` 无条件注入）：
 * `ocr_records` → `ocr_jobs` → `ocr_idempotency`（无主体列，按 scope 前缀）。两表之间**没有**
 * 互相外键（`0024` 里各自只指向 `public.users`），因此"先子后父"按语义排（记录是任务的产物）。
 * ⚠️ 与前两域方向相反的一条事实：识别/语音域刻意零表级 DELETE（走 0034 的 `SECURITY DEFINER`
 * 函数），OCR 三表则是**用户 2026-10-24 批准**的表级 `GRANT DELETE` 例外（`20-login-roles.sql`
 * 的 R34 段 + `90-assert` 的 `allow_table_dml` 三元组），存储层就是真 `DELETE … RETURNING`。
 */
const MODULE_TABLE_COVERAGE = Object.freeze({
  community: [
    'community_posts',
    'community_comments',
    'community_likes',
    'community_reports',
    'community_idempotency',
  ],
  conversations: ['conversations', 'conversation_turns', 'conversation_answers'],
  favorites: ['favorites', 'favorites_idempotency'],
  history: ['history', 'history_idempotency'],
  messages: ['messages', 'idempotency_keys'],
  recognitions: [
    'recognition_selections',
    'recognition_jobs',
    'recognition_records',
    'recognition_idempotency',
  ],
  speech: ['speech_jobs', 'transcriptions', 'speech_idempotency'],
  ocr: ['ocr_records', 'ocr_jobs', 'ocr_idempotency'],
});

/**
 * 「卫星表」：没有主体列、也不指向 `users`，但按主体**分区存放**（`scope` 里带主体 id），
 * 因此仍属用户数据、仍必须被某个模块按主体清空。这里逐张说明它的主体是怎么表达的，
 * 免得「没有 user_id 所以不算用户数据」这种解释蒙混过关。
 */
const SATELLITE_TABLES = Object.freeze({
  favorites_idempotency: 'scope = `<主体>\\n<METHOD>\\n<路径>`（0018:105），由 favorites 模块按 scope 前缀清空',
  history_idempotency: 'scope 同形（0018:120），由 history 模块按 scope 前缀清空',
  idempotency_keys: 'scope 同形（auth/idempotency.ts 口径），由 messages 模块按主体清空',
  community_idempotency: 'scope 同形（community/store.ts 用「主体 id + 换行」前缀匹配），由 community 模块按主体清空',
  recognition_idempotency: 'scope 同形（0025:180 只有 scope/key_hash/payload，无主体列），由 recognitions 模块按 `left(scope, len+1) = 主体||chr(10)` 精确前缀清空',
  speech_idempotency: 'scope 同形（0026:137），由 speech 模块按同一前缀口径清空',
  ocr_idempotency: 'scope 同形（0024:133-144 只有 scope/key_hash/payload，无主体列；scope = `<主体>\\n<METHOD>\\n<路径>`），由 ocr 模块按 `left(scope, len+1) = 主体||chr(10)` 精确前缀清空',
});

/**
 * 未注册处理器、**显式声明**的用户数据表（这就是缺口清单）。每条必须是可核对的事实：
 * 要么说明「由谁以别的方式处理」，要么说明「阻塞在哪个编号上」。
 */
const DECLARED_UNREGISTERED = Object.freeze({
  sessions: '受理事务立即撤销全部会话（0016：UPDATE sessions 落 revoked_at），刻意不删行以保留审计；保留期归 #19',
  single_profiles: '资料域无按主体清理原语，未注册处理器；7/30 日集成归 #19',
  media: '媒体实体与对象存储副本的物理清除归 #19（本片不伪造「已删」）',
  jobs: '任务表随执行器一起清理，当前无按主体原语；归 #19',
  author_links: '社区作者绑定，随社区域清理；阻塞 #19/#22',
  community_media_grants: '社区素材授权，随社区域清理；阻塞 #19',
  consent_records: '授权/撤回**证据**必须保留（撤回不等于删除）；保留期归 #19',
  privacy_epochs: 'epoch 台账是「撤回可被验证」的前提，必须保留；保留期归 #19',
  exports: '外发账本按契约保留（撤销只置 failed/CONSENT_WITHDRAWN，不删行）；保留期归 #19',
  export_writebacks: '回写台账同上，作为「回写 0 行」的证据保留；保留期归 #19',
  user_training_consents: '训练授权证据须保留，且首版不开启用户训练；归 #19',
  user_backup_copies: '备份副本由 `backup-copies-pg.ts` 的清除端口驱动，不属于模块闭集；7/30 日集成归 #19',
});

/** 静态枚举迁移文件里 `CREATE TABLE` 的表与列体（不执行 SQL）。 */
function migrationTables() {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  assert.ok(files.length > 0, '必须能在迁移目录里找到迁移文件');
  const tables = new Map();
  for (const file of files) {
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
    const pattern = /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?([a-z_0-9]+)\s*\(/gi;
    let match;
    while ((match = pattern.exec(sql)) !== null) {
      // 手工配平括号取出列体：SQL 的列体里允许出现嵌套括号（如 numeric(10,2)）。
      const start = match.index + match[0].length;
      let depth = 1;
      let index = start;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '(') depth += 1;
        else if (sql[index] === ')') depth -= 1;
        index += 1;
      }
      tables.set(match[1].toLowerCase(), { file, body: sql.slice(start, index - 1) });
    }
  }
  return tables;
}

/** 带主体列、或有指向 `users` 外键的表。 */
function userDataTables(tables) {
  const result = [];
  for (const [table, { body }] of tables) {
    const columns = [...body.matchAll(/^\s*([a-z_0-9]+)\s+/gmi)].map((m) => m[1].toLowerCase());
    const subjectColumn = columns.find((name) => SUBJECT_COLUMNS.includes(name));
    const referencesUsers = /references\s+(?:public\.)?users\b/i.test(body);
    if (subjectColumn || referencesUsers) result.push({ table, subjectColumn: subjectColumn ?? null, referencesUsers });
  }
  return result;
}

/** 从源码读出闭集（与 `USER_DATA_DELETION_MODULES` 同源；不在这里复制一份常量）。 */
function declaredClosure() {
  const source = readFileSync(USER_DATA_DELETION_SRC, 'utf8');
  const constants = new Map();
  for (const match of source.matchAll(/export const ([A-Z_]+_DELETION_MODULE)\s*=\s*'([a-z_]+)'/g)) {
    constants.set(match[1], match[2]);
  }
  const listMatch = source.match(/export const USER_DATA_DELETION_MODULES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  assert.ok(listMatch, '必须能从 user-data-deletion.ts 读到 USER_DATA_DELETION_MODULES 字面量');
  const names = [...listMatch[1].matchAll(/([A-Z_]+_DELETION_MODULE)/g)].map((m) => {
    assert.ok(constants.has(m[1]), `闭集里的常量 ${m[1]} 必须能找到其字符串声明`);
    return constants.get(m[1]);
  });
  return names;
}

/**
 * 装配处**条件追加**的模块：从源码读出，不在这里复制常量。
 *
 * `createUserDataDeletion` 在注入对应 store 时把这些模块追加进生效闭集。`app.ts` **无条件**注入
 * 社区/识别/语音/OCR 四个 store ⇒ 真实注销路径的生效闭集 = 4 + 4 = **8 项**；
 * 既有替身不注入 ⇒ 常量闭集仍是 4 项。
 *
 * 三处必须一致（"改了追加点却忘了改清单"会让覆盖断言静默漏掉整个域）：
 *   1. 声明处：`CONDITIONAL_DELETION_MODULES`（导出常量，人读的顺序表）；
 *   2. 真实追加点：`conditionalStores` 里的 `[<模块常量>, input.<store>]` 二元组；
 *   3. 追加动作本身：`if (conditionalStore !== undefined) requiredModules.push(conditionalModule)`。
 */
function declaredConditionalModules() {
  const source = readFileSync(USER_DATA_DELETION_SRC, 'utf8');
  const constants = new Map();
  for (const match of source.matchAll(/export const ([A-Z_]+_DELETION_MODULE)\s*=\s*'([a-z_]+)'/g)) {
    constants.set(match[1], match[2]);
  }
  const declared = source.match(/export const CONDITIONAL_DELETION_MODULES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  assert.ok(declared, '必须能从源码读到 CONDITIONAL_DELETION_MODULES 字面量（装配处条件追加的模块清单）');
  const declaredNames = [...declared[1].matchAll(/([A-Z_]+_DELETION_MODULE)/g)].map((m) => m[1]);
  assert.ok(declaredNames.length > 0, 'CONDITIONAL_DELETION_MODULES 不得为空');
  // 真实追加点只看 `conditionalStores` 这一块（源码里另有一份「四域 → store」的备份快照来源表，
  // 未限定范围会把那份也匹配进来，让断言的读数变成噪声）。
  const block = source.match(/const conditionalStores[\s\S]*?\n  \];/);
  assert.ok(block, '必须能找到 `conditionalStores` 声明块');
  const appendPairs = [...block[0].matchAll(/\[\s*([A-Z_]+_DELETION_MODULE),\s*input\.(\w+)\s*\]/g)]
    .map((match) => ({ constant: match[1], store: match[2] }));
  assert.ok(appendPairs.length > 0, '必须能找到 `conditionalStores` 里的 `[模块常量, input.xxx]` 追加点');
  assert.deepEqual(appendPairs.map((pair) => pair.constant), declaredNames,
    '真实追加点与 CONDITIONAL_DELETION_MODULES 的内容/顺序必须逐项一致（改一处漏一处 ⇒ 闭集与清单分叉）');
  assert.match(source, /if \(conditionalStore !== undefined\)\s*requiredModules\.push\(conditionalModule\)/,
    '条件追加必须真的作用在 requiredModules 上（⛔ 不是只在注释里声明）');
  return declaredNames.map((name) => {
    assert.ok(constants.has(name), `条件追加清单里的常量 ${name} 必须能找到其字符串声明`);
    return constants.get(name);
  });
}

const TABLES = migrationTables();
const USER_TABLES = userDataTables(TABLES);
const COVERED = new Set(Object.values(MODULE_TABLE_COVERAGE).flat());

test('闭集（USER_DATA_DELETION_MODULES）与覆盖映射逐项对齐，不多不少', () => {
  const closure = declaredClosure();
  assert.deepEqual(closure, ['favorites', 'history', 'messages', 'conversations'], '闭集内容与顺序：扩大闭集须同步本断言');
  const conditional = declaredConditionalModules();
  assert.deepEqual(conditional, ['community', 'recognitions', 'speech', 'ocr'],
    '装配处条件追加的模块与顺序：改造装配方式须同步本断言');
  const effective = [...closure, ...conditional];
  assert.equal(effective.length, 8, '生产生效闭集 = 四域 + community + recognitions + speech + ocr = 8 项');
  assert.deepEqual(Object.keys(MODULE_TABLE_COVERAGE).sort(), [...effective].sort(),
    '每个已注册模块都必须在这里声明「它按主体处理哪些表」，否则覆盖断言会漏掉整个域');
});

test('在线清除证据名单含识别/语音/OCR 三域、不含社区域，且落库门真的用它', () => {
  const source = readFileSync(USER_DATA_DELETION_SRC, 'utf8');
  const list = source.match(/export const ONLINE_EVIDENCE_MODULES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  assert.ok(list, '必须能读到 ONLINE_EVIDENCE_MODULES 字面量');
  const entries = [...list[1].matchAll(/\.\.\.USER_DATA_DELETION_MODULES|([A-Z_]+_DELETION_MODULE)/g)]
    .map((match) => match[1] ?? '...USER_DATA_DELETION_MODULES');
  assert.ok(entries.includes('...USER_DATA_DELETION_MODULES'), '四域必须整体展开在内（⛔ 不手抄四遍，抄了就会漂）');
  assert.ok(entries.includes('RECOGNITIONS_DELETION_MODULE'), '识别域按行清空 ⇒ 必须有在线清除证据');
  assert.ok(entries.includes('SPEECH_DELETION_MODULE'), '语音域按行清空 ⇒ 必须有在线清除证据');
  assert.ok(entries.includes('OCR_DELETION_MODULE'), 'OCR 域按行清空（表级 DELETE + RETURNING）⇒ 必须有在线清除证据');
  assert.ok(!entries.includes('COMMUNITY_DELETION_MODULE'),
    '社区域是「保留 + 脱敏」，没有"清空行数"这个事实 ⇒ ⛔ 不得进在线清除证据名单');
  // 落库门若继续用常量四域，新增两域即使清了也永远留不下凭据（清而无证 = 又一次静默缺口）。
  assert.match(source, /\(ONLINE_EVIDENCE_MODULES as readonly string\[\]\)\.includes\(module\)/,
    '证据落库门必须用 ONLINE_EVIDENCE_MODULES，而不是常量四域');
});

test('每张用户数据表都必须：被已注册模块覆盖，或显式声明未注册（棘轮）', () => {
  const uncovered = USER_TABLES
    .filter(({ table }) => !COVERED.has(table) && !Object.hasOwn(DECLARED_UNREGISTERED, table))
    .map(({ table }) => table);
  assert.deepEqual(uncovered, [],
    `新增/遗漏的用户数据表必须先说清楚谁清：被模块覆盖就加进 MODULE_TABLE_COVERAGE，` +
    `否则在 DECLARED_UNREGISTERED 写明阻塞原因。当前漏登：${uncovered.join(', ')}`);
});

test('声明不得含糊：每条都有原因且指明归属编号', () => {
  for (const [table, reason] of Object.entries(DECLARED_UNREGISTERED)) {
    assert.equal(typeof reason, 'string');
    assert.ok(reason.length >= 12, `声明 ${table} 的原因太短，不能当依据：${reason}`);
    assert.match(reason, /#\d{2}/, `声明 ${table} 必须写明归属编号（如 #19），否则没人对它负责：${reason}`);
  }
});

test('声明与覆盖都不得过期：引用的表必须真实存在，且同一张表不得既覆盖又声明', () => {
  const allTables = new Set(TABLES.keys());
  const staleCovered = [...COVERED].filter((table) => !allTables.has(table));
  assert.deepEqual(staleCovered, [], `覆盖映射引用了不存在的表：${staleCovered.join(', ')}`);
  const staleDeclared = Object.keys(DECLARED_UNREGISTERED).filter((table) => !allTables.has(table));
  assert.deepEqual(staleDeclared, [], `声明表引用了不存在的表（表已删/改名就该同步删除声明）：${staleDeclared.join(', ')}`);
  const conflicting = Object.keys(DECLARED_UNREGISTERED).filter((table) => COVERED.has(table));
  assert.deepEqual(conflicting, [], `同一张表不能既被模块覆盖又声明未覆盖：${conflicting.join(', ')}`);
});

test('覆盖映射里的表必须确实承载用户数据：有主体列、指向 users 的外键，或是已声明的卫星表', () => {
  const userTableNames = new Set(USER_TABLES.map(({ table }) => table));
  const notUserTables = [...COVERED].filter((table) => !userTableNames.has(table) && !Object.hasOwn(SATELLITE_TABLES, table));
  assert.deepEqual(notUserTables, [],
    `覆盖映射里的表既没有主体列/外键，也不是已声明的卫星表（按主体清空对它无意义）：${notUserTables.join(', ')}`);
  const staleSatellites = Object.keys(SATELLITE_TABLES).filter((table) => !TABLES.has(table));
  assert.deepEqual(staleSatellites, [], `卫星表声明引用了不存在的表：${staleSatellites.join(', ')}`);
});
