// GY-I07 D4：除草剂首批 20 条记录的「逐条可追溯 / 逐条显式声明缺口」回归。
//
// 验收（#7①）「缺项不通过空白或模型补写填充」在本文件被钉成四组可测断言：
//   A 逐条可追溯 —— records[].provenance 必须与 packages/knowledge/catalog/sources.json 中
//      同 source_id 的 issues[] 条目**逐字一致**（期号/公告页/附表/附表哈希/ICAMA 详情指针）；
//   B 逐条显式缺口 —— review_status ≠ verified 的记录必须逐条给出非空 verification.gaps
//      （码 / 字段 / 原因齐备），且缺项范围与「来源字段清单」「crops.json 覆盖面」**精确对齐**：
//      不漏报（未采集项必须被声明）、不多报（目录已覆盖的作物不得谎称未映射）；
//   C 缺项不填充 —— 记录内不得出现空字符串 / 占位符文案 / 模型生成痕迹字段，未采集字段
//      不得凭空出现（不推断、不换算）；新增的缺口与溯源字段**不得进入任何查询面投影**；
//   D 生成物同步 —— miniprogram/data/records-2026.js 必须与资料契约逐字节一致
//      （改数据必须重跑 tools/knowledge/build_miniprogram_data.mjs，禁止手改生成物）。
//
// 判据出处：packages/reference/query.mjs:110-140（列表与详情共用 queryable 判定）、
// packages/reference/query.mjs:499-515（列表白名单投影）、packages/reference/records.mjs:101-123
// （身份哈希 / 内容哈希均为字段白名单，故新增元数据不改变缓存键）、
// packages/reference/records.mjs:431-435（items 仅携带契约与知识投影）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createReferenceService,
  loadCatalog,
  loadHerbicideRecords,
  toDetail,
} from '../../packages/reference/index.mjs';
import { miniReference } from './_fixtures.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

const RECORDS_REL = 'packages/knowledge/herbicides/records-2026.json';
const SOURCES_REL = 'packages/knowledge/catalog/sources.json';
const CROPS_REL = 'packages/knowledge/catalog/crops.json';
const GENERATED_REL = 'miniprogram/data/records-2026.js';

const TARGET = 20;

function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 读取真实资料文件的**稳定快照**。
 *
 * tests/reference/contract.test.mjs:468-491 会在用例内把「缺 source_kind 的变体」临时写回
 * 真实文件、断言后再复原（写盘已用临时文件 + rename，读者不会看到半截内容），而 `node --test`
 * 并发跑同目录各文件 —— 本文件因此在极短窗口内可能读到那一版变体。这里做**有界重试**：
 * 只有确认「读到的不是 20 条字段齐备的记录」才重试；真实缺项的记录永远不会因重试而被容忍。
 */
function stableRecordsDoc() {
  const path = join(repo, RECORDS_REL);
  let last = 'unknown';
  for (let i = 0; i < 200; i += 1) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      last = err.message;
      syncSleep(5);
      continue;
    }
    const complete =
      Array.isArray(parsed?.records) &&
      parsed.records.length === TARGET &&
      parsed.records.every((r) => r?.source?.source_kind && r?.source?.evidence_kind && r?.registration_number);
    if (complete) return parsed;
    last = `records=${parsed?.records?.length}`;
    syncSleep(5);
  }
  throw new Error(`records-2026.json 长时间未处于字段齐备状态（${last}）——疑似并发改写未复原`);
}

const doc = stableRecordsDoc();
const sources = JSON.parse(readFileSync(join(repo, SOURCES_REL), 'utf8'));
const crops = JSON.parse(readFileSync(join(repo, CROPS_REL), 'utf8'));

function walk(node, visit, path = '$') {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, visit, `${path}[${i}]`));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      visit(`${path}.${k}`, v);
      walk(v, visit, `${path}.${k}`);
    }
  }
}

// ---------------------------------------------------------------------------
// A 逐条可追溯
// ---------------------------------------------------------------------------

test('A1 逐条可追溯：每条 provenance 与 sources.json 同 source_id 的 issue 条目逐字一致', () => {
  const byId = new Map(sources.sources.map((s) => [s.id, s]));
  assert.equal(doc.records.length, TARGET);
  assert.equal(new Set(doc.records.map((r) => r.registration_number)).size, TARGET);

  for (const r of doc.records) {
    const p = r.provenance;
    assert.ok(p, `${r.record_id}：缺少逐条溯源指针 provenance`);
    const src = byId.get(p.source_id);
    assert.ok(src, `${r.record_id}：source_id ${p.source_id} 未在 ${SOURCES_REL} 登记`);
    const issue = (src.issues ?? []).find((x) => x.issue === p.issue);
    assert.ok(issue, `${r.record_id}：期号 ${p.issue} 未在 ${p.source_id}.issues[] 登记`);

    // 逐字一致（逐字段断言，失败时可定位到具体指针）
    assert.equal(p.page_url, issue.page_url, `${r.record_id}：公告页 URL 与目录不一致`);
    assert.equal(p.attachment_url, issue.attachment_url, `${r.record_id}：附表 URL 与目录不一致`);
    assert.equal(p.attachment_sha256, issue.attachment_sha256, `${r.record_id}：附表哈希与目录不一致`);
    assert.equal(p.index_url, issue.icama_detail_url, `${r.record_id}：ICAMA 详情指针与目录不一致`);
    assert.equal(p.published_at, issue.published_at, `${r.record_id}：发布日期与目录不一致`);
    assert.equal(p.catalog, SOURCES_REL);
    assert.match(p.attachment_sha256, /^[a-f0-9]{64}$/);

    // 记录 source 块与逐条指针同源（同一 issue 的同一指针），不得一处指向另一处
    assert.equal(r.source.source_id, p.source_id);
    assert.equal(r.source.issue, p.issue);
    assert.equal(r.source.published_at, p.published_at);
    assert.equal(r.source.original_url, issue.page_url);
    assert.equal(r.source.attachment_url, issue.attachment_url);
    assert.equal(r.source.attachment_sha256, issue.attachment_sha256);
    assert.equal(r.source.index_url, issue.icama_detail_url);
    assert.equal(r.source.retrieved_at, src.retrieved_at, `${r.record_id}：抓取日期与来源目录不一致`);

    // 本机未取得附表原文与 ICAMA 登记详情 ⇒ 复核未完成，不得声明为已复核
    assert.equal(p.review_status, 'unverified', `${r.record_id}：原文未复核不得标为已复核`);
    assert.equal(p.review_status, r.verification.review_status, `${r.record_id}：溯源与复核状态必须一致`);
    assert.deepEqual(p.original_recheck, { attachment: false, icama_detail: false });
  }
});

test('A2 溯源指针已嵌入缓存键：source_version 必须同时绑定 source_id、期号与附表哈希前缀', () => {
  // packages/reference/records.mjs:141-146 deriveSourceVersion：`<source_id>@<issue>#<hash12>`。
  // 逐条可追溯因此不只是文档性声明：来源版本串本身即可反查到具体期号与附表哈希。
  const items = createReferenceService({ executionMode: 'stub' }).listHerbicides({ limit: 50 }).body.data.items;
  assert.equal(items.length, TARGET);
  for (const li of items) {
    const r = doc.records.find((x) => x.registration_number === li.formulation.registration_number);
    assert.ok(r, `列表项 ${li.id} 的登记证号未命中任何记录`);
    assert.equal(li.source.title, r.source.issue, `${r.record_id}：来源标题必须是已登记期号`);
    assert.equal(
      li.source.version,
      `${r.source.source_id}@${r.source.issue}#${r.source.attachment_sha256.slice(0, 12)}`,
      `${r.record_id}：来源版本未绑定期号与附表哈希`,
    );
    assert.equal(li.source.url, r.source.original_url);
    assert.equal(li.source.publisher, r.source.publisher);
    assert.equal(li.source.validity, 'valid');
    assert.equal(li.source.review_status, 'unverified');
    assert.equal(li.reference_state, 'available');
  }
});

// ---------------------------------------------------------------------------
// B 逐条显式声明缺口
// ---------------------------------------------------------------------------

test('B1 逐条显式缺口：review_status ≠ verified 的记录必须逐条携带非空 gaps（码/字段/原因齐备）', () => {
  const policy = doc.provenance_policy;
  assert.ok(policy, '缺少 provenance_policy 口径声明块');
  const codes = Object.keys(policy.gap_codes ?? {});
  for (const code of ['source_lacks_field', 'not_collected', 'unverified_transcription', 'crop_unmapped']) {
    assert.ok(codes.includes(code), `缺口码字典缺少 ${code}`);
  }

  let verified = 0;
  let unverified = 0;
  const gapCounts = {};
  for (const r of doc.records) {
    const v = r.verification;
    assert.ok(v, `${r.record_id}：缺少 verification 块`);
    if (v.review_status === 'verified') {
      verified += 1;
      continue;
    }
    unverified += 1;
    assert.ok(
      Array.isArray(v.gaps) && v.gaps.length > 0,
      `${r.record_id}：review_status=${v.review_status} 却未逐条声明缺口（缺项不得静默）`,
    );

    for (const g of v.gaps) {
      assert.ok(codes.includes(g.code), `${r.record_id}：缺口码 ${g.code} 未在 provenance_policy.gap_codes 声明`);
      assert.ok(Array.isArray(g.fields) && g.fields.length > 0, `${r.record_id}：缺口 ${g.code} 未列出字段`);
      for (const f of g.fields) {
        assert.equal(typeof f, 'string', `${r.record_id}：缺口 ${g.code} 的字段名必须为字符串`);
        assert.ok(f.trim().length > 0, `${r.record_id}：缺口 ${g.code} 含空白字段名（空白即填充）`);
      }
      assert.ok(
        typeof g.detail === 'string' && g.detail.trim().length > 0,
        `${r.record_id}：缺口 ${g.code} 未给出原因（AC02：缺项有原因）`,
      );
      gapCounts[g.code] = (gapCounts[g.code] ?? 0) + 1;
    }

    // 不漏报：verification.not_collected 的每一项都必须被缺口显式声明 ——
    // 「来源本身无此列」（source_lacks_field，取自公告附表字段清单）与「本轮未采集」（not_collected，
    // 渠道/时间限制）是两种不同缺口，二者合并覆盖 not_collected 全量，且并集必须**精确相等**
    // （既不得有一项静默、也不得声明 not_collected 之外的字段）。
    const notCollectedDeclared = new Map();
    for (const g of v.gaps) {
      if (g.code === 'not_collected' || g.code === 'source_lacks_field') {
        for (const f of g.fields) {
          assert.ok(
            (v.not_collected ?? []).includes(f),
            `${r.record_id}：缺口 ${g.code} 声明了 not_collected 之外的字段「${f}」`,
          );
          const seen = notCollectedDeclared.get(f) ?? [];
          seen.push(g.code);
          notCollectedDeclared.set(f, seen);
        }
      }
    }
    assert.ok((v.not_collected ?? []).length > 0, `${r.record_id}：partial 记录必须列出未采集项`);
    for (const f of v.not_collected) {
      assert.ok(
        notCollectedDeclared.has(f),
        `${r.record_id}：未采集项「${f}」未在 gaps 中声明（缺项不得静默）`,
      );
      assert.equal(notCollectedDeclared.get(f).length, 1, `${r.record_id}：「${f}」不得同时记两种缺口原因`);
    }
    assert.deepEqual(
      [...notCollectedDeclared.keys()].sort(),
      [...v.not_collected].sort(),
      `${r.record_id}：缺口声明字段与 not_collected 不一致（不漏报、不多报）`,
    );
    // 不多不少：已转录待复核范围必须与 source_checked_scope 完全一致
    const transcribed = v.gaps.find((g) => g.code === 'unverified_transcription');
    assert.ok(transcribed, `${r.record_id}：缺少 unverified_transcription 缺口`);
    assert.deepEqual(transcribed.fields, v.source_checked_scope, `${r.record_id}：待复核字段范围与已核对范围不一致`);
    // 来源本身无此列的字段必须恰好覆盖来源说明所缺的列（不得把「本轮未采集」混算成「来源无此列」）
    const lacks = v.gaps.filter((g) => g.code === 'source_lacks_field');
    assert.equal(lacks.length, 1, `${r.record_id}：来源缺列缺口应恰好一条`);
    assert.ok(lacks[0].fields.length > 0, `${r.record_id}：缺少 source_lacks_field 缺口`);

    // 未复核 ⇒ 不得可用：卡片与用量双重禁止
    assert.equal(v.card_eligible, false, `${r.record_id}：未复核记录不得标为可出卡片`);
    assert.equal(v.usable_as_dose, false, `${r.record_id}：未复核记录不得标为可作用量`);
    assert.equal(r.record_status, 'partial', `${r.record_id}：未采集字段的记录状态应为 partial`);
  }

  assert.equal(verified, 0, '本机未取得登记原文，不得出现 review_status=verified 的记录（不得编造复核人/复核结论）');
  assert.equal(unverified, TARGET);
  assert.equal(gapCounts.unverified_transcription, TARGET, '每条记录都必须声明待复核范围');
});

test('B2 缺口不多报：crop_unmapped 必须与 crops.json 覆盖面精确对齐（不漏报、不臆增映射）', () => {
  const known = [];
  for (const c of crops.crops) for (const name of [c.name, ...(c.aliases ?? [])]) known.push(name);
  const cropIds = new Set(crops.crops.map((c) => c.id));
  assert.equal(crops.crops.length, 4);

  for (const r of doc.records) {
    // crop_ids 只能取目录内编号
    for (const id of r.crop_ids ?? []) assert.ok(cropIds.has(id), `${r.record_id}：crop_id ${id} 不在 crops.json`);

    // 场所逐段判定：命中目录（全等或包含目录别名）即视为已覆盖
    const segs = String(r.use_scene).split('、').map((s) => s.trim()).filter(Boolean);
    const unmappedSegs = segs.filter((s) => !known.some((k) => s === k || s.includes(k)));
    const declared = (r.verification.gaps ?? []).find((g) => g.code === 'crop_unmapped');
    const declaredFields = declared ? [...declared.fields].sort() : [];
    assert.deepEqual(
      declaredFields,
      [...unmappedSegs].sort(),
      `${r.record_id}：crop_unmapped 与 crops.json 覆盖面不一致（场所=${r.use_scene}）`,
    );
    // 声明的未映射场所必须真的出现在该记录的场所字段中（不得凭空列名）
    for (const f of declaredFields) {
      assert.ok(String(r.use_scene).includes(f), `${r.record_id}：声明的未映射场所「${f}」未出现在 use_scene`);
    }
    // 已映射场所 ⇒ 对应 crop_id 必须已在 crop_ids 中；crop_ids 也不得含无场所依据的作物
    const mapped = new Set();
    for (const s of segs) {
      for (const c of crops.crops) {
        if ([c.name, ...(c.aliases ?? [])].some((k) => s === k || s.includes(k))) mapped.add(c.id);
      }
    }
    assert.deepEqual([...mapped].sort(), [...r.crop_ids].sort(), `${r.record_id}：场所与 crop_ids 映射不一致`);
  }
});

test('B3 来源字段清单自证：来源本身无此列的字段集合必须与 sources.json 的附表字段说明一致', () => {
  const src = sources.sources.find((s) => s.id === 'src_moa_pd_2026');
  assert.ok(src, 'src_moa_pd_2026 必须已登记');
  assert.match(src.note, /无用药量、施用方法、登记有效期起止字段/, '来源说明须声明附表不含这些列');
  const lacking = new Set();
  for (const r of doc.records) {
    for (const g of r.verification.gaps ?? []) {
      if (g.code === 'source_lacks_field') for (const f of g.fields) lacking.add(f);
    }
  }
  assert.deepEqual(
    [...lacking].sort(),
    ['用药量（制剂量/亩）', '登记有效期起止日期', '注意事项', '施用方法'].sort(),
    '来源本身无此列的字段集合必须与来源说明一致',
  );
});

// ---------------------------------------------------------------------------
// C 缺项不填充
// ---------------------------------------------------------------------------

test('C1 缺项不填充：记录内不得出现空字符串、占位符文案、模型生成痕迹或凭空出现的未采集字段', () => {
  // 说明：只扫 records（不含 provenance_policy —— 该块**专门用于列举**被禁止的填充手法，
  // 其 forbidden_fill 文案必然包含这些词，属口径声明而非数据填充）。
  const blanks = [];
  walk(doc.records, (path, v) => {
    if (typeof v === 'string' && v.trim() === '') blanks.push(path);
  });
  assert.deepEqual(blanks, [], '记录内不得出现空字符串/纯空白值（缺项必须显式声明，不得留空）');

  const FORBIDDEN = ['待补', '暂无', '待定', '待填', 'TODO', 'TBD', 'N/A', 'n/a', 'placeholder', '占位', '模型补写', '推测值', '模型生成'];
  const hits = [];
  walk(doc.records, (path, v) => {
    if (typeof v !== 'string') return;
    for (const token of FORBIDDEN) if (v.includes(token)) hits.push(`${path} 含「${token}」`);
  });
  assert.deepEqual(hits, [], '记录内不得出现占位符或模型补写痕迹文案');

  const MODEL_KEYS = /(^|_)(ai|llm|gpt|model|generated|generation|inferred|guess|hallucinat|fabricat)(_|$)/i;
  const modelPaths = [];
  walk(doc.records, (path, v) => {
    const key = path.slice(path.lastIndexOf('.') + 1);
    if (MODEL_KEYS.test(key)) modelPaths.push(`${path} = ${JSON.stringify(v).slice(0, 40)}`);
  });
  assert.deepEqual(modelPaths, [], '记录内不得出现模型生成/推测痕迹字段');

  // 未采集字段与用量卡：必须**整键缺席**，而不是以空串/零值占位
  const absent = [
    'dose_text',
    'dose_cards',
    'application_method',
    'method_text',
    'precautions_text',
    'unit_text',
    'registration_valid_from',
    'registration_valid_to',
    'restriction_rules',
    'restriction_status',
  ];
  for (const r of doc.records) {
    for (const key of absent) {
      assert.ok(!(key in r), `${r.record_id}：未采集字段 ${key} 不得出现在记录里（不推断、不换算、不占位）`);
      assert.ok(!(key in r.verification), `${r.record_id}：verification 不得夹带 ${key}`);
    }
  }
});

test('C2 不外泄：新增缺口与溯源字段不得进入查询面投影（列表契约 / 详情契约 / 知识投影 / 小程序）', () => {
  const NEW_FIELDS = [
    'gaps',
    'provenance',
    'provenance_policy',
    'original_recheck',
    'source_lacks_field',
    'unverified_transcription',
    'crop_unmapped',
    'gap_codes',
    'forbidden_fill',
  ];
  const svc = createReferenceService({ executionMode: 'stub' });
  const list = svc.listHerbicides({ limit: 50 });
  assert.equal(list.body.data.items.length, TARGET);
  // 列表项为契约白名单投影（packages/reference/query.mjs:499-515）
  assert.deepEqual(
    Object.keys(list.body.data.items[0]).sort(),
    ['formulation', 'id', 'reference_state', 'revision', 'risk_text', 'source'].sort(),
  );
  for (const f of NEW_FIELDS) assert.ok(!JSON.stringify(list.body).includes(f), `列表面不得外泄缺口字段 ${f}`);

  for (const li of list.body.data.items) {
    const det = svc.getHerbicide(li.id);
    const text = JSON.stringify(det.body);
    for (const f of NEW_FIELDS) assert.ok(!text.includes(f), `详情面不得外泄缺口字段 ${f}`);
    assert.equal(det.body.data.source.review_status, 'unverified', '未复核记录不得在详情面表现为已复核');
    assert.ok(det.body.data.risk_text.includes('不可作为用药量依据'), '风险文案须明示不可作用药依据');
  }

  // 知识投影（含 conditions / dose_cards）：服务端不补写缺项
  const catalog = loadCatalog();
  const loaded = loadHerbicideRecords();
  assert.equal(loaded.items.length, TARGET);
  assert.equal(loaded.skipped.length, 0, '真实 20 条来源齐备，不应有被 fail-closed 排除的记录');
  for (const it of loaded.items) {
    const d = toDetail(it, catalog);
    assert.equal(d.queryable, true, `${it.record_id}：来源有效且已具名的记录应可查询`);
    assert.equal(d.knowledge.conditions, null, `${it.record_id}：未采集适用地区 ⇒ conditions 必须为 null（不补写）`);
    assert.deepEqual(d.knowledge.dose_cards, [], `${it.record_id}：未复核 ⇒ 不得有用量卡`);
    assert.equal(d.knowledge.source.review_status, 'unverified');
    const text = JSON.stringify(d);
    for (const f of NEW_FIELDS) assert.ok(!text.includes(f), `${it.record_id}：知识投影不得外泄 ${f}`);
  }

  // 小程序侧：生成物镜像资料契约（携带缺口声明），但适配层 detail() 白名单不得外泄
  assert.equal(miniReference.records.length, TARGET);
  for (const r of miniReference.records) {
    const d = miniReference.detail(r.record_id);
    assert.ok(d, `${r.record_id}：小程序 detail 应可返回`);
    const text = JSON.stringify(d);
    for (const f of NEW_FIELDS) assert.ok(!text.includes(f), `${r.record_id}：小程序 detail 不得外泄 ${f}`);
    assert.ok(Array.isArray(d.not_collected) && d.not_collected.length > 0, '未采集项须在小程序详情如实列出');
    assert.equal(d.queryable, true);
  }
});

// ---------------------------------------------------------------------------
// D 生成物同步
// ---------------------------------------------------------------------------

test('D1 生成物同步：miniprogram/data/records-2026.js 与资料契约逐字节一致（禁止手改生成物）', () => {
  const generated = readFileSync(join(repo, GENERATED_REL), 'utf8').replace(/\r\n/g, '\n');
  const expected =
    '// AUTO-GENERATED by tools/knowledge/build_miniprogram_data.mjs — do not edit by hand.\n' +
    `// Source: ${RECORDS_REL} (packages/knowledge contract; single source of truth).\n` +
    `module.exports = ${JSON.stringify(doc, null, 2)};\n`;
  assert.equal(generated, expected, '生成物与资料契约不同步：请运行 node tools/knowledge/build_miniprogram_data.mjs');

  const mod = require(join(repo, GENERATED_REL));
  assert.deepEqual(mod.records, doc.records);
  assert.deepEqual(mod.provenance_policy, doc.provenance_policy);
});

test('D2 生成物同步：build_miniprogram_data.mjs --check 对真实仓库通过且不改写文件', () => {
  const outPath = join(repo, GENERATED_REL);
  const before = readFileSync(outPath).toString('hex');
  const result = spawnSync(process.execPath, [join(repo, 'tools/knowledge/build_miniprogram_data.mjs'), '--check'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `--check 失败（exit ${result.status}）：${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /OK：miniprogram\/data 与 packages\/knowledge 契约一致/);
  assert.equal(readFileSync(outPath).toString('hex'), before, '--check 不得改写生成物');
});
