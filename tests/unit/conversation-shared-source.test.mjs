// 回归：`/knowledge` 读面的 `source.id` 是 **sources 行 id**，与知识条目 id 本就不是同一个值
// （迁移 0010 的 `catalog_read.current_knowledge` 投影 `s.id AS source_id`；同一份来源可以挂多条知识条目，
// 演示资料种子 `db/seeds/demo_catalog_verified.sql` 就是 8 条知识共用 1 条 source）。
//
// 旧口径（`retrievalItemOf` 要求 `source.id === 条目 id`、守卫只按 `citation.id === 条目 id` 定位）在真实读面
// 上必然失败：问答作业折 `PROVIDER_UNAVAILABLE`，页面版本串恒为「版本未知」。本文件把新口径钉住：
// 引用按**来源对象逐字段相等**核对，同一来源被列多次按来源去重（不算重复引用、不整条阻断）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrievalItem, retrievalSet, syntheticSource } from './conversation-fixtures.mjs';
import { retrievalItemOf } from '../../services/api/src/conversations/retrieval.ts';
import { createAnswerGuard, createUnwiredDoseAuthority } from '../../services/api/src/conversations/guard.ts';
import { createDeterministicAnswerComposer } from '../../services/api/src/conversations/service.ts';

const SHARED_SOURCE = syntheticSource({ id: 'd0000000-0000-4000-8000-00000000b001' });
const ITEM_A = retrievalItem({
  id: 'd0000000-0000-4000-8000-00000000c001',
  title: '狗尾草',
  body: '狗尾草（学名 Setaria viridis）；别名：狗尾草、谷莠子。',
  source: SHARED_SOURCE,
});
const ITEM_B = retrievalItem({
  id: 'd0000000-0000-4000-8000-00000000c002',
  title: '稗',
  body: '稗（学名 Echinochloa crus-galli）；别名：稗草、稗子、野稗。',
  source: SHARED_SOURCE,
});

test('读面：source.id 与条目 id 不同不再判读面故障（来源身份是 sources 行 id）', () => {
  const item = retrievalItemOf({
    id: ITEM_A.id,
    revision: 1,
    title: ITEM_A.title,
    body: ITEM_A.body,
    source: SHARED_SOURCE,
  });
  assert.equal(item.id, ITEM_A.id);
  assert.equal(item.source.id, SHARED_SOURCE.id);
  assert.notEqual(item.source.id, item.id);
});

test('读面：来源 id 仍是 uuid 形状校验（不是随便放过）', () => {
  assert.throws(
    () => retrievalItemOf({ id: ITEM_A.id, revision: 1, source: { ...SHARED_SOURCE, id: '不是-uuid' } }),
    (error) => error && error.code === 'PROVIDER_UNAVAILABLE' && /不是 uuid/.test(error.message),
  );
});

test('回答器：同一份来源挂多条条目时，引用按来源去重（不产生重复引用）', () => {
  const composer = createDeterministicAnswerComposer();
  const candidate = composer.compose({
    question: '狗尾草和稗怎么区分？',
    set: retrievalSet('user-1', [ITEM_A, ITEM_B]),
    history: [],
  });
  assert.equal(candidate.citations.length, 1, '两条条目共用一份来源 ⇒ 候选引用只有一条');
  assert.equal(candidate.citations[0].id, SHARED_SOURCE.id);
});

test('守卫：共用来源的引用被接受（answered），不因 id 与条目 id 不同而阻断', () => {
  const guard = createAnswerGuard({ dose: createUnwiredDoseAuthority() });
  const composer = createDeterministicAnswerComposer();
  const set = retrievalSet('user-1', [ITEM_A, ITEM_B]);
  const candidate = composer.compose({ question: '狗尾草和稗怎么区分？', set, history: [] });
  const verdict = guard.check({ candidate, set, question: '狗尾草和稗怎么区分？', conditions: null });
  assert.equal(verdict.status, 'answered');
  assert.equal(verdict.check_state, 'passed');
  assert.equal(verdict.accepted_citations, 1);
  assert.deepEqual(verdict.rejected_citations, []);
  assert.equal(verdict.citations[0].id, SHARED_SOURCE.id);
});

test('守卫：集合外引用仍然拒绝（收紧口径没有放宽越界）', () => {
  const guard = createAnswerGuard({ dose: createUnwiredDoseAuthority() });
  const set = retrievalSet('user-1', [ITEM_A, ITEM_B]);
  const outsider = syntheticSource({ id: '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e', title: '集合外来源' });
  const verdict = guard.check({
    candidate: { text: '候选正文', citations: [outsider], dose_cards: [] },
    set,
    question: '狗尾草和稗怎么区分？',
    conditions: null,
  });
  assert.equal(verdict.status, 'blocked');
  assert.deepEqual(verdict.rejected_citations, [`not_in_retrieval_set:${outsider.id}`]);
});
