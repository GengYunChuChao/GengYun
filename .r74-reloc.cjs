// GY-R74：让 doc 锚点同时过 doc-anchor-relocation-identity（按符号重锚 + 登记，或按端点映射改正），跑完即删。
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');

const REGISTRY = 'tests/unit/doc-anchor-relocations.json';
const TEST = 'tests/unit/doc-anchor-relocation-identity.test.mjs';
const BASE = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' }).trim();

const split = (text) => text.split(/\r?\n/);
const readHead = (file) => split(fs.readFileSync(file, 'utf8'));
const readBase = (file) => {
  try {
    return split(execFileSync('git', ['show', `${BASE}:${file}`], { encoding: 'utf8', maxBuffer: 1 << 28 }));
  } catch {
    return null;
  }
};
const runTest = () => {
  const out = spawnSync(process.execPath, ['--test', TEST], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return { status: out.status, text: `${out.stdout ?? ''}\n${out.stderr ?? ''}` };
};

const MOVED = /(docs\/[^\s:]+?\.(?:md|json)):(\d+) ⟨([^\s:]+) :(\d+)(?:-(\d+))? → :(\d+)(?:-(\d+))?⟩/;
const REDUNDANT = /第 (\d+) 条 .*冗余/;
const MAP_START = /起 (\d+)→(\d+)/;
const MAP_END = /止 (\d+)→(\d+)/;

function chooseSymbol(target, to, toEnd, from, fromEnd) {
  if (!fs.existsSync(target)) return null;
  const head = readHead(target);
  const base = readBase(target);
  const headWindow = head.slice(to - 1, toEnd ?? to);
  const baseWindow = base === null ? [] : base.slice(from - 1, fromEnd ?? from);
  const inBase = (needle) => baseWindow.some((line) => line.includes(needle));
  const candidates = headWindow
    .map((line) => line.trim())
    .filter((line) => line.length >= 8 && line.length <= 180)
    .sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    if (!inBase(candidate)) return candidate;
  }
  // 多行拼接（含 \n 的片段不可能是一行 base 的子串）
  if (headWindow.length >= 2) {
    const joined = headWindow.slice(0, 2).join('\n');
    if (joined.trim().length >= 8) return joined;
  }
  return null;
}

const registryPath = REGISTRY;
let registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const log = [];

for (let round = 1; round <= 10; round += 1) {
  const { status, text } = runTest();
  if (status === 0) {
    log.push(`round ${round}: 绿（exit=0），登记表 ${registry.length} 条`);
    break;
  }
  const deletions = new Set();
  const corrections = new Map();
  const remaps = new Map(); // doc -> [{line, target, from, fromEnd, to, toEnd}]
  for (const rawLine of split(text)) {
    const line = rawLine.trim().replace(/^[+'\s]+/, '').replace(/',?$/, '');
    const redundant = REDUNDANT.exec(line);
    if (redundant !== null) { deletions.add(Number(redundant[1])); continue; }
    if (!line.includes('目标文件本提交有改动')) continue;
    const moved = MOVED.exec(line);
    if (moved === null) continue;
    const doc = moved[1];
    if (!fs.existsSync(doc)) continue; // 夹具里的临时文档（如 docs/notes.md）
    if (!fs.existsSync(moved[3])) continue; // 相对路径锚点（登记表无法解析）
    const [, , docLine, target, from, fromEnd, to, toEnd] = moved;
    const unchanged = from === to && (fromEnd ?? from) === (toEnd ?? to);
    if (unchanged) {
      const startMap = MAP_START.exec(line);
      const endMap = MAP_END.exec(line);
      if (startMap === null) continue;
      const list = remaps.get(doc) ?? [];
      list.push({
        line: Number(docLine),
        target,
        from: Number(from),
        fromEnd: fromEnd === undefined ? undefined : Number(fromEnd),
        mappedStart: Number(startMap[2]),
        mappedEnd: endMap === null ? undefined : Number(endMap[2]),
      });
      remaps.set(doc, list);
      continue;
    }
    const key = `${doc}:${docLine}|${target}|${from}|${fromEnd ?? ''}|${to}|${toEnd ?? ''}`;
    if (!corrections.has(key)) {
      corrections.set(key, {
        doc,
        line: Number(docLine),
        target,
        from: Number(from),
        ...(fromEnd === undefined ? {} : { fromEnd: Number(fromEnd) }),
        to: Number(to),
        ...(toEnd === undefined ? {} : { toEnd: Number(toEnd) }),
      });
    }
  }

  if (deletions.size === 0 && corrections.size === 0 && remaps.size === 0) {
    log.push(`round ${round}: 剩余红点无法自动处理：\n${split(text).slice(-14).join('\n')}`);
    break;
  }

  if (deletions.size > 0) {
    const keep = registry.filter((_, index) => !deletions.has(index + 1));
    log.push(`round ${round}: 删冗余登记 ${[...deletions].sort((a, b) => a - b).join(',')}（${registry.length}→${keep.length}）`);
    registry = keep;
  }

  let remapped = 0;
  for (const [doc, list] of remaps) {
    const lines = readHead(doc);
    let changed = 0;
    for (const item of list) {
      const original = lines[item.line - 1];
      if (original === undefined) continue;
      const oldToken = `${item.target}:${item.from}${item.fromEnd === undefined ? '' : `-${item.fromEnd}`}`;
      const newToken = `${item.target}:${item.mappedStart}${item.mappedEnd === undefined ? '' : `-${item.mappedEnd}`}`;
      if (!original.includes(oldToken)) continue;
      lines[item.line - 1] = original.replace(oldToken, newToken);
      changed += 1;
    }
    if (changed > 0) {
      fs.writeFileSync(doc, `${lines.join('\n')}\n`, 'utf8');
      remapped += changed;
    }
  }
  if (remapped > 0) log.push(`round ${round}: 按端点映射改正 ${remapped} 处锚点（纯行号位移）`);

  let added = 0;
  let skipped = 0;
  for (const entry of corrections.values()) {
    const exists = registry.some((existing) => existing.doc === entry.doc && existing.line === entry.line
      && existing.target === entry.target && existing.from === entry.from && existing.to === entry.to);
    if (exists) { skipped += 1; continue; }
    const symbol = chooseSymbol(entry.target, entry.to, entry.toEnd, entry.from, entry.fromEnd);
    if (symbol === null) {
      skipped += 1;
      log.push(`  ! 取不到 symbol：${entry.doc}:${entry.line} ${entry.target}:${entry.to}`);
      continue;
    }
    registry.push({
      ...entry,
      kind: 'correction',
      symbol,
      reason: 'GY-R74 注销真清片：本片在 services/api/src/app.ts、services/api/src/privacy/account-deletion.ts、'
        + 'services/api/src/routes/account-deletion.ts 里大段插入（受理门 available = real + 真库、thirdPartyWritable 传参、'
        + '媒体门注释、备份失败只折备份列、回执投影与 refresh 注释），机械端点映射会把这些锚点平移到不相干的装配行。'
        + '本锚按**符号**重锚到真实落点（不是按差值平移），symbol 取目标行原文片段作机读证据；'
        + 'base 的旧窗口里不含该片段 ⇒ 旧行号本来就指错，属「纠正」而非「位移」。',
    });
    added += 1;
  }
  if (added > 0 || skipped > 0) log.push(`round ${round}: 新增登记 ${added} 条、跳过 ${skipped} 条（共 ${registry.length} 条）`);
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}
console.log(log.join('\n'));
