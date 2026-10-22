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
 * 已注册模块 → 该模块处理器**真正清空**的表（读 `*​/store-pg.ts` 的 `DELETE FROM` 得出）。
 * `conversation_turns`/`conversation_answers` 由 `conversations` 的 `ON DELETE CASCADE` 连带清空
 * （`0013_conversations.sql:64`/`:105`）。幂等台账与正文行同一事务清空（`purgeOwnerData`）。
 */
const MODULE_TABLE_COVERAGE = Object.freeze({
  conversations: ['conversations', 'conversation_turns', 'conversation_answers'],
  favorites: ['favorites', 'favorites_idempotency'],
  history: ['history', 'history_idempotency'],
  messages: ['messages', 'idempotency_keys'],
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
  community_posts: '社区域无清理原语（先审后发与留存策略未定）；阻塞 #19',
  community_comments: '社区域无清理原语；阻塞 #19',
  community_likes: '社区域无清理原语；阻塞 #19',
  community_reports: '社区域无清理原语（举报记录涉他人证据，需专门口径）；阻塞 #19',
  user_backup_copies: '备份副本由 `backup-copies-pg.ts` 的清除端口驱动，不属于模块闭集；7/30 日集成归 #19',
  ocr_jobs: 'OCR 域无按主体清理原语；归 #19',
  ocr_records: 'OCR 域无按主体清理原语；归 #19',
  recognition_jobs: '识别域无按主体清理原语；归 #19',
  recognition_records: '识别域无按主体清理原语；归 #19',
  recognition_selections: '识别域无按主体清理原语；归 #19',
  speech_jobs: '语音域无按主体清理原语；归 #19',
  transcriptions: '语音转写正文无按主体清理原语；归 #19',
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

const TABLES = migrationTables();
const USER_TABLES = userDataTables(TABLES);
const COVERED = new Set(Object.values(MODULE_TABLE_COVERAGE).flat());

test('闭集（USER_DATA_DELETION_MODULES）与覆盖映射逐项对齐，不多不少', () => {
  const closure = declaredClosure();
  assert.deepEqual(closure, ['favorites', 'history', 'messages', 'conversations'], '闭集内容与顺序：扩大闭集须同步本断言');
  assert.deepEqual(Object.keys(MODULE_TABLE_COVERAGE).sort(), [...closure].sort(),
    '每个已注册模块都必须在这里声明「它清了哪些表」，否则覆盖断言会漏掉整个域');
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
