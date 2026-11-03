// GY-R74：一次性修 doc 锚点收尾（删非法登记、改 JSON 行号、改两处文档锚点、补两条 correction），跑完即删。
const fs = require('node:fs');

const REASON = 'GY-R74 注销真清片：本片在 services/api/src/app.ts、services/api/src/privacy/account-deletion.ts、'
  + 'services/api/src/routes/account-deletion.ts 里大段插入（受理门 available = real + 真库、thirdPartyWritable 传参、'
  + '媒体门注释、备份失败只折备份列、回执投影与 refresh 注释），机械端点映射会把这些锚点平移到不相干的装配行/注释行。'
  + '本锚按**符号**重锚到真实落点（不是按差值平移），symbol 取目标行原文片段作机读证据；'
  + 'base 的旧窗口里不含该片段 ⇒ 旧行号本来就指错，属「纠正」而非「位移」。';

const REG = 'tests/unit/doc-anchor-relocations.json';
let registry = JSON.parse(fs.readFileSync(REG, 'utf8'));
const before = registry.length;
registry = registry.filter((entry) => entry.from !== entry.to);
console.log(`删非法登记（from === to）：${before} → ${registry.length}`);

const patch = (file, pairs) => {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const [from, to] of pairs) {
    const hits = lines.reduce((acc, line, index) => (line.includes(from) ? [...acc, index] : acc), []);
    if (hits.length !== 1) throw new Error(`${file}: 「${from}」命中 ${hits.length} 次（要求 1 次）`);
    lines[hits[0]] = lines[hits[0]].split(from).join(to);
    console.log(`  ${file}:${hits[0] + 1} 「${from}」→「${to}」`);
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
};

patch('docs/architecture/contract-status.json', [
  ['"lines": "218-282"', '"lines": "252-316"'],
  ['"lines": "299-352"', '"lines": "302-355"'],
  ['"lines": "284-322"', '"lines": "318-356"'],
  ['"lines": "120-165"', '"lines": "123-168"'],
  ['"lines": "354-388"', '"lines": "357-391"'],
  ['"lines": "324-361"', '"lines": "358-395"'],
]);

patch('docs/architecture/data-dictionary.md', [
  ['app.ts 同处 `:2015-2016`', '同处 `services/api/src/app.ts:2025-2026`'],
]);

patch('docs/verification/gy-r29-i19-closure-20261022.md', [
  ['`routes/account-deletion.ts:330`', '`services/api/src/routes/account-deletion.ts:330`'],
]);

const append = [
  {
    doc: 'docs/architecture/data-dictionary.md',
    line: 91,
    target: 'services/api/src/app.ts',
    from: 2015,
    fromEnd: 2016,
    to: 2025,
    toEnd: 2026,
    kind: 'correction',
    symbol: '属 P2-c，不在本片。',
    reason: REASON,
  },
  {
    doc: 'docs/verification/gy-r29-i19-closure-20261022.md',
    line: 160,
    target: 'services/api/src/routes/account-deletion.ts',
    from: 197,
    to: 330,
    kind: 'correction',
    symbol: '一律按「凭据不可用」如实拒绝，不泄露该 id 是否存在（防探测）。',
    reason: REASON,
  },
];
for (const entry of append) {
  const exists = registry.some((existing) => existing.doc === entry.doc && existing.line === entry.line
    && existing.target === entry.target && existing.from === entry.from && existing.to === entry.to);
  if (!exists) registry.push(entry);
}
console.log(`登记表：${registry.length} 条（含 correction ${registry.filter((e) => e.kind === 'correction').length} 条）`);
fs.writeFileSync(REG, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
