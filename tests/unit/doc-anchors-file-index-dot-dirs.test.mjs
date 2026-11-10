/**
 * 同名文件索引**不收点目录**：`tools/verify-doc-anchors.mjs` 的 `buildFileNameIndex()` 从仓库根递归建
 * 「同名文件 → 相对路径」索引，只跳过 `SKIP_DIRECTORIES`（`node_modules`/`.git`/`dist` 等）是不够的。
 *
 * 事故形状（R103b）：本机跑 `node tools/prepare-wechat.mjs local …` 会在仓内生成
 * `.local/wechat-local/`（小程序副本，整个 `miniprogram/` 再拷一份）。副本被一起收进索引后，证据页里
 * 那些**裸文件名／无前缀引用**（`voice.js`、`utils/auth.js`、`profile.js`、`utils/messages-api.js`）
 * 各多出一个同名候选 ⇒ `resolveTarget()` 返回 `ambiguous` ⇒ 这些锚点**根本不进判定**（既不红也不算
 * resolved）⇒ 作用域外「本会红」读数从 117 掉到 112，孤儿册里那 5 条被判「陈旧」。CI 没有 `.local`，
 * 所以 CI 一直是 117／0：这是本机工件干扰，不是平台差异。
 *
 * 判据边界（**不是**放宽「同名即 ambiguous」）：
 *   1) 点目录不可能是被引用的源码，收进索引只会把唯一解析变成歧义 ⇒ 索引跳过点目录（`.github` 除外，
 *      与 `walkMarkdown`／`isCollectibleDocKey` 的既有口径一致：`.github/workflows/*.yml` 是真实证据目标）；
 *   2) 真·同名（两个**非点目录**里的同名文件）仍然 `ambiguous` —— 负控制用例钉住这条没有一起放水。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFileNameIndex, resolveTarget } from '../../tools/verify-doc-anchors.mjs';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'verify-doc-anchors.mjs');

/** 临时树：`mkdtempSync` 现建唯一目录，`t.after` 只删自己建的那一份（对齐既有夹具写法）。 */
function fixtureTree(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'doc-anchors-dot-dirs-'));
  t.after(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响判定结论
    }
  });
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return root;
}

/** 真源码 + `prepare-wechat` 生成的 `.local` 副本 + 一份 `.github` 工作流（点目录里的真实证据目标）。 */
const SOURCE_TREE = {
  'miniprogram/utils/auth.js': 'export const requireAuth = () => true;\n',
  'miniprogram/pages/voice/voice.js': 'Page({ data: {} });\n',
  '.github/workflows/real-pg-integration.yml': 'name: real-pg-integration\n',
  '.local/wechat-local/miniprogram/utils/auth.js': 'export const requireAuth = () => true;\n',
  '.local/wechat-local/miniprogram/pages/voice/voice.js': 'Page({ data: {} });\n',
};

test('点目录不进索引：`.local/wechat-local` 副本不出现在任何索引值里', (t) => {
  const root = fixtureTree(t, SOURCE_TREE);
  const index = buildFileNameIndex(root);
  const values = [...index.values()].flat();

  const leaked = values.filter((value) => value.startsWith('.local/') || value.includes('/.local/'));
  assert.deepEqual(leaked, [], `同名索引里混进了 .local 副本：${JSON.stringify(leaked)}`);
  assert.ok(
    values.includes('miniprogram/utils/auth.js'),
    `真源码必须仍在索引里（否则下面的唯一解析无从谈起）：${JSON.stringify(values)}`,
  );
  // `.github` 是 `walkMarkdown`／`isCollectibleDocKey` 明确保留的点目录：`real-pg-integration.yml:271`
  // 这类短名引用要靠它唯一解析，一并跳过会把 10 条真证据打成 BROKEN（实测读数）。
  assert.ok(
    values.includes('.github/workflows/real-pg-integration.yml'),
    '`.github` 不能被「跳过点目录」一起扫掉：工作流短名引用靠它解析',
  );
});

test('裸文件名仍能唯一解析：副本在仓内时 `utils/auth.js`／`voice.js` 仍 resolved', (t) => {
  const root = fixtureTree(t, SOURCE_TREE);
  const fileIndex = buildFileNameIndex(root);

  const auth = resolveTarget({ root, docPath: 'docs/verification/x.md', target: 'utils/auth.js', fileIndex });
  assert.equal(auth.status, 'resolved', `裸路径引用被副本拖成 ${auth.status}：${JSON.stringify(auth)}`);
  assert.equal(auth.relative, 'miniprogram/utils/auth.js');

  const voice = resolveTarget({ root, docPath: 'docs/verification/x.md', target: 'voice.js', fileIndex });
  assert.equal(voice.status, 'resolved', `裸文件名引用被副本拖成 ${voice.status}：${JSON.stringify(voice)}`);
  assert.equal(voice.relative, 'miniprogram/pages/voice/voice.js');
});

test('负控制：两个非点目录里的真同名文件仍然 ambiguous（歧义规则没被整体放宽）', (t) => {
  const root = fixtureTree(t, {
    ...SOURCE_TREE,
    'miniprogram/a/dup.js': 'export const dup = 1;\n',
    'miniprogram/b/dup.js': 'export const dup = 2;\n',
  });
  const fileIndex = buildFileNameIndex(root);

  const dup = resolveTarget({ root, docPath: 'docs/verification/x.md', target: 'dup.js', fileIndex });
  assert.equal(dup.status, 'ambiguous', `真同名文件必须仍是 ambiguous：${JSON.stringify(dup)}`);
  assert.equal(dup.candidates.length, 2, `候选应恰好 2 条：${JSON.stringify(dup.candidates)}`);
  assert.deepEqual(
    [...dup.candidates].sort(),
    ['miniprogram/a/dup.js', 'miniprogram/b/dup.js'],
  );
});

test('回归锚：`buildFileNameIndex` 里点目录过滤仍在（防止后人把这一行改回去）', () => {
  const source = readFileSync(TOOL, 'utf8');
  const start = source.indexOf('export function buildFileNameIndex');
  assert.notEqual(start, -1, '工具里找不到 buildFileNameIndex：本用例的锚点已失效，请同步改测试');
  const end = source.indexOf('\n}', start);
  const body = source.slice(start, end === -1 ? undefined : end);

  assert.match(body, /SKIP_DIRECTORIES\.has\(entry\.name\)/, '`SKIP_DIRECTORIES` 过滤不能丢');
  assert.match(body, /entry\.name\.startsWith\('\.'\)/, '点目录过滤不能丢（`.local` 副本会让裸文件名引用变 ambiguous）');
});
