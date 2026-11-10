/**
 * `db/seeds/demo_catalog_verified.sql` 的静态守卫。
 *
 * ⛔ 只读文本，**不**连库、**不**跑 psql：这份种子是否真的幂等、是否真的进了首页，
 * 由 `docs/verification/gy-r90-demo-seed-20261109.md` 的实跑记录证明；
 * 这里守的是「文件本身别退化成危险/误导的样子」。
 *
 * 它挡的四类事故：
 *   1. 种子悄悄写生产/审核之外的表（越界改数据）；
 *   2. 种子里出现 DELETE/DROP/TRUNCATE（本该只在注释掉的回滚块里）；
 *   3. 映射到 `seed_reference.sql` 里不存在的物种 ⇒ INSERT ... SELECT 静默插 0 行；
 *   4. 丢掉「非生产数据」标记，读的人误以为是真审核过的资料。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEED_URL = new URL('../../db/seeds/demo_catalog_verified.sql', import.meta.url);
const REFERENCE_URL = new URL('../../db/seeds/seed_reference.sql', import.meta.url);

const seed = readFileSync(fileURLToPath(SEED_URL), 'utf8');
const reference = readFileSync(fileURLToPath(REFERENCE_URL), 'utf8');

/** 去掉整行注释（`--` 开头）与行尾 `--` 注释，只留可执行 SQL。 */
function executableLines(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s*--.*$/u, ''))
    .filter((line) => line.trim() !== '');
}

test('演示种子：只写这 5 张表，且只 UPDATE sources', () => {
  const inserts = new Set(
    [...seed.matchAll(/INSERT\s+INTO\s+public\.([a-z_]+)/giu)].map((match) => match[1].toLowerCase()),
  );
  assert.deepEqual([...inserts].sort(), [
    'admin_accounts',
    'knowledge_dataset_config',
    'knowledge_versions',
    'source_versions',
    'sources',
  ]);

  const updates = new Set([...seed.matchAll(/UPDATE\s+public\.([a-z_]+)/giu)].map((match) => match[1].toLowerCase()));
  assert.deepEqual([...updates], ['sources']);
});

test('演示种子：可执行部分不含 DELETE/DROP/TRUNCATE（回滚块只准留在注释里）', () => {
  for (const line of executableLines(seed)) {
    assert.ok(
      !/^\s*(DELETE|DROP|TRUNCATE)\b/iu.test(line),
      `发现未注释的破坏性语句：${line.trim()}`,
    );
  }
  // 反面自检：回滚块确实还在（说明我们没把注释一起删掉）
  assert.match(seed, /^-- DELETE FROM public\.knowledge_versions$/mu);
});

test('演示种子：幂等写法（每条写入都有 ON CONFLICT）', () => {
  // 只看可执行 SQL：文件末尾回滚块（整块注释）里也有 INSERT/ON CONFLICT，不能算进来
  const code = executableLines(seed).join('\n');
  const insertCount = (code.match(/INSERT\s+INTO\s+public\./giu) ?? []).length;
  const conflictCount = (code.match(/ON\s+CONFLICT/giu) ?? []).length;
  assert.equal(insertCount, 7, '预期 7 条 INSERT（含 knowledge_dataset_config 两行配置与 §6 的语音播报短卡）');
  assert.equal(conflictCount, 7, '每条 INSERT 都必须带 ON CONFLICT，否则复跑会撞唯一键');
  assert.match(code, /ON CONFLICT \(source_id, version\) DO UPDATE/u);
  assert.match(code, /ON CONFLICT \(knowledge_id, revision\) DO UPDATE/u);
});

test('演示种子：映射到的每个 species_id 都真的在 seed_reference.sql 里', () => {
  const mapped = [...seed.matchAll(/'(species_[a-z_]+)'/gu)].map((match) => match[1]);
  assert.equal(mapped.length, 8, `预期 8 个物种映射，实际 ${mapped.length}`);
  assert.equal(new Set(mapped).size, 8, '映射里有重复的 species_id');
  for (const id of mapped) {
    assert.ok(
      reference.includes(`'${id}'`),
      `${id} 不在 db/seeds/seed_reference.sql 里 ⇒ INSERT ... SELECT 会静默插 0 行，首页还是空的`,
    );
  }
});

test('演示种子：视图要求的字段一个不少（verified 来源 + published 物种 + valid 有效期）', () => {
  assert.match(seed, /'verified_seed'/u);
  assert.match(seed, /'verified'/u);
  assert.match(seed, /'valid'/u);
  assert.match(seed, /'published'/u);
  assert.match(seed, /'species'/u);
  // current_version_id 与 source_versions 的 id 必须是同一串，否则 current_verified_sources JOIN 不上
  const sourceVersionId = /'(d0000000-0000-4000-8000-00000000b002)'::uuid/u.exec(seed)?.[1];
  assert.ok(sourceVersionId);
  const occurrences = seed.split(sourceVersionId).length - 1;
  assert.ok(occurrences >= 3, `source_versions.id 应在三处出现（insert / current_version_id / knowledge_versions），实际 ${occurrences}`);
});

test('演示种子：保留「非生产数据」标记与 0 行自检', () => {
  assert.match(seed, /非生产数据/u);
  assert.match(seed, /不代表任何第三方审核/u);
  assert.match(seed, /RAISE EXCEPTION/u, '缺了 0 行自检，species 缺失时会静默成功');
  assert.match(seed, /catalog_read\.home_species/u, '自检必须真的查首页视图，而不是查自己插的行');
});

test('演示种子：来源地址是不可解析的保留域名（不放真实公告链接冒充出处）', () => {
  const urls = [...seed.matchAll(/https?:\/\/[^\s']+/gu)].map((match) => match[0]);
  assert.ok(urls.length >= 1);
  for (const url of urls) {
    assert.match(url, /^https?:\/\/[^\s/]*\.invalid(\/|$)/u, `来源地址必须落在 .invalid 保留域名下：${url}`);
  }
});
