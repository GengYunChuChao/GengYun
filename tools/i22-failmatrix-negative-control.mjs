#!/usr/bin/env node
/**
 * GY-I22（#22）失败回归矩阵 · 负控制执行器。
 *
 * 对 `tests/failmatrix/mutations.mjs` 里的每条改动，跑一遍完整闭环并**如实打印读数**：
 *
 *   ① sha256(文件) 记前值；
 *   ② 校验 `find` 在文件里**恰好出现一次**（0 次 = 改错了行，2 次以上 = 会误伤，直接失败）；
 *   ③ 真写替换 → 记 sha256（必须与①不同）；
 *   ④ 跑 `run.mjs --only <watch>`：**每条 watch 用例都必须 FAIL**（这就是「真红」）；
 *      —— 只有 `watch` 的条目走这条；靶子是**既有单元测试**的条目（`unitWatch`）走 ④'：
 *      对每个 `{ file, pattern }` 跑 `node --test --test-name-pattern=<pattern> <file>`，
 *      要求**恰好那一条**目标测试 FAIL（`# fail 1` / `# pass 0`）；
 *   ⑤ 用**原始字节**恢复文件 → 复核 sha256 与①**逐字节一致**；
 *   ⑥ 再跑一次同一组靶子：**每条都必须 PASS**（恢复后转绿，证明红是那一行造成的）。
 *      对 `unitWatch` 更进一步：恢复后必须**恰好 1 条**目标测试通过（防止 pattern 变宽后
 *      顺手盖住别的测试，那不是「那一条转红」）。
 *
 * 任何一步不满足 → 本条负控制记 FAIL；只要有一条负控制 FAIL，进程退出码 = 1。
 *
 * 用法：
 *   node tools/i22-failmatrix-negative-control.mjs                 # 全跑 26 条（其中 3 条靶子是既有单元测试）
 *   node tools/i22-failmatrix-negative-control.mjs --only=NC-01    # 只跑指定条目
 *   node tools/i22-failmatrix-negative-control.mjs --json=out.json # 另存机读结果
 *
 * 注意：本工具会**临时修改** `services/api/src/**` 的工作区文件。异常退出由 `finally` 恢复；
 * 若进程被强杀，用 `git checkout -- <file>` 还原（每条的 `file` 在输出里）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTATIONS } from '../tests/failmatrix/mutations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'tests', 'failmatrix', 'run.mjs');

function parseArgs(argv) {
  const out = { only: null, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--only=')) out.only = arg.slice('--only='.length);
    else if (arg === '--only') out.only = argv[++i] ?? '';
    else if (arg.startsWith('--json=')) out.json = arg.slice('--json='.length);
    else if (arg === '--json') out.json = argv[++i] ?? '';
    else throw new Error(`未知参数：${arg}（只支持 --only= / --json=）`);
  }
  return out;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** 跑一组用例，返回 `{ verdicts, rows, stdout }`。 */
function runCases(ids, jsonPath) {
  const result = spawnSync(process.execPath, [RUNNER, `--only=${ids.join(',')}`, `--json=${jsonPath}`], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, I22_VERBOSE: '0' },
  });
  if (result.error !== undefined && result.error !== null) throw result.error;
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch {
    payload = null;
  }
  if (payload === null) {
    throw new Error(`子进程没有产出机读结果（exit ${result.status}）：\n${result.stdout}\n${result.stderr}`);
  }
  return { payload, stdout: result.stdout, status: result.status };
}

function listProblems(payload) {
  return payload.rows
    .filter((row) => row.verdict === 'FAIL')
    .map((row) => `${row.id} ${row.method} ${row.path} → 实际 ${JSON.stringify(row.actual)}：${(row.problems ?? []).join('；')}`);
}

/** `pattern` 是测试名的**字面子串**：转义成正则再交给 `--test-name-pattern`。 */
function literalNamePattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 TAP 汇总里数出 `# tests/# pass/# fail/# skipped`。 */
function parseTapCounts(tap) {
  const read = (key) => {
    const hit = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(tap);
    return hit === null ? null : Number(hit[1]);
  };
  return { tests: read('tests'), pass: read('pass'), fail: read('fail'), skipped: read('skipped') };
}

/** TAP 里 `not ok N - <测试名>` + 紧随其后的断言原文，作为「真红」证据。 */
function tapRedLines(tap) {
  const lines = tap.split(/\r?\n/);
  const out = [];
  for (const [index, line] of lines.entries()) {
    if (!/^not ok \d+ - /.test(line)) continue;
    out.push(line.trim());
    for (const next of lines.slice(index + 1, index + 25)) {
      const text = next.trim();
      if (/^(ok|not ok|1\.\.)\b/.test(text) || text === '...') break;
      if (/^(error|message|code|expected|actual):/.test(text) || /AssertionError/.test(text)) out.push(`    ${text}`);
    }
    if (out.length > 12) break;
  }
  return out.slice(0, 12);
}

/**
 * 跑一组「既有单元测试」靶子（`unitWatch`）。每条都单进程串行跑，避免并发抢库/抢端口。
 * 返回 `[{ file, pattern, status, counts, redLines }]`。
 */
function runUnitTargets(targets) {
  const rows = [];
  for (const target of targets) {
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', `--test-name-pattern=${literalNamePattern(target.pattern)}`, target.file],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, I22_VERBOSE: '0' } },
    );
    if (result.error !== undefined && result.error !== null) throw result.error;
    const tap = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    rows.push({ file: target.file, pattern: target.pattern, status: result.status, counts: parseTapCounts(tap), redLines: tapRedLines(tap) });
  }
  return rows;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const filter = opts.only === null ? null : opts.only.split(',').map((part) => part.trim()).filter(Boolean);
  const selected = filter === null ? MUTATIONS : MUTATIONS.filter((m) => filter.includes(m.id));

  if (selected.length === 0) throw new Error(`--only=${opts.only} 没有匹配到负控制条目`);

  const scratch = mkdtempSync(path.join(tmpdir(), 'i22-nc-'));
  const report = [];
  let failures = 0;

  console.log(`GY-I22 负控制 · ${selected.length}/${MUTATIONS.length} 条 · 每条 = 改一处 → watch 全红 → 原字节恢复 → sha256 一致 → 复跑全绿\n`);

  try {
    for (const [index, mutation] of selected.entries()) {
      // 一条负控制 = 一处「一处一行」的守卫改动；个别守卫有**两层**（路由层 + 服务层），
      // 用 `edits` 列出两个文件各一行，仍然只改守卫本身、不改行为语义。
      const editList = mutation.edits ?? [{ file: mutation.file, find: mutation.find, replace: mutation.replace }];
      const problems = [];
      const entry = {
        id: mutation.id,
        title: mutation.title,
        files: editList.map((edit) => edit.file),
        watch: mutation.watch,
        verdict: 'PASS',
        problems,
        evidence: {},
      };

      const originals = editList.map((edit) => {
        const filePath = path.join(ROOT, edit.file);
        const bytes = readFileSync(filePath);
        return { ...edit, filePath, bytes, text: bytes.toString('utf8'), sha: sha256(bytes) };
      });
      entry.evidence.sha256_before = Object.fromEntries(originals.map((o) => [o.file, o.sha]));

      let invalid = false;
      for (const o of originals) {
        const occurrences = o.text.split(o.find).length - 1;
        entry.evidence[`find_occurrences:${o.file}`] = occurrences;
        if (occurrences !== 1) {
          problems.push(`find 在 ${o.file} 出现 ${occurrences} 次（必须恰好 1 次）`);
          invalid = true;
        }
      }
      if (invalid) {
        failures += 1;
        entry.verdict = 'FAIL';
        report.push(entry);
        console.log(`[${index + 1}/${selected.length}] ${mutation.id} ${mutation.title}\n  FAIL ${problems[0]}\n`);
        continue;
      }

      const unitTargets = mutation.unitWatch ?? [];
      let redPayload = null;
      let redUnits = [];
      try {
        for (const o of originals) {
          const mutatedText = o.text.replace(o.find, o.replace);
          if (mutatedText === o.text) throw new Error(`替换后内容没有变化（${o.file} 的 find/replace 写错？）`);
          writeFileSync(o.filePath, mutatedText, 'utf8');
          const mutatedSha = sha256(readFileSync(o.filePath));
          entry.evidence[`sha256_mutated:${o.file}`] = mutatedSha;
          if (mutatedSha === o.sha) throw new Error(`改动后 sha256 与改前相同（${o.file} 改动没落盘）`);
        }

        if (mutation.watch.length > 0) {
          const red = runCases(mutation.watch, path.join(scratch, `${mutation.id}-red.json`));
          redPayload = red.payload;
          const redPass = redPayload.rows.filter((row) => row.verdict === 'PASS').map((row) => row.id);
          redPayload.rows.forEach((row) => {
            entry.evidence[`red_${row.id}`] = {
              expected: row.expected,
              actual: row.actual,
              verdict: row.verdict,
              problems: row.problems,
            };
          });
          if (redPass.length > 0) problems.push(`watch 里仍有 PASS（改动没打中要害）：${redPass.join(',')}`);
        }
        if (unitTargets.length > 0) {
          redUnits = runUnitTargets(unitTargets);
          for (const row of redUnits) {
            entry.evidence[`red_unit:${row.file}#${row.pattern}`] = { exit: row.status, counts: row.counts, red: row.redLines };
            const { fail, pass } = row.counts;
            // 真红 = 目标测试**恰好那一条**变红：fail≥1 且没有任何 PASS 混在里面。
            if (fail === null || fail < 1 || pass !== 0) {
              problems.push(`目标单元测试没有真红（fail=${fail} pass=${pass}）：${row.file}「${row.pattern}」`);
            }
          }
        }
      } finally {
        // 恢复一律用**原始字节**：不经过字符串重编码，保证逐字节一致。
        for (const o of originals) writeFileSync(o.filePath, o.bytes);
      }

      entry.evidence.sha256_after = Object.fromEntries(originals.map((o) => [o.file, sha256(readFileSync(o.filePath))]));
      for (const o of originals) {
        if (entry.evidence.sha256_after[o.file] !== o.sha) {
          problems.push(`恢复后 sha256 与改前不一致：${o.file} ${o.sha} → ${entry.evidence.sha256_after[o.file]}`);
        }
      }

      let greenPayload = null;
      if (mutation.watch.length > 0) {
        const green = runCases(mutation.watch, path.join(scratch, `${mutation.id}-green.json`));
        greenPayload = green.payload;
        const greenFail = greenPayload.rows.filter((row) => row.verdict !== 'PASS').map((row) => row.id);
        if (greenFail.length > 0) problems.push(`恢复后复跑仍有 FAIL：${greenFail.join(',')}`);
      }
      let greenUnits = [];
      if (unitTargets.length > 0) {
        greenUnits = runUnitTargets(unitTargets);
        for (const row of greenUnits) {
          entry.evidence[`green_unit:${row.file}#${row.pattern}`] = { exit: row.status, counts: row.counts };
          const { fail, pass } = row.counts;
          // 恢复后必须**恰好 1 条**目标测试转绿：pattern 变宽顺手盖住别的测试不算「那一条转绿」。
          if (fail !== 0 || pass !== 1) {
            problems.push(`恢复后目标单元测试没有恰好 1 条转绿（fail=${fail} pass=${pass}）：${row.file}「${row.pattern}」`);
          }
        }
      }

      entry.verdict = problems.length === 0 ? 'PASS' : 'FAIL';
      entry.evidence.red_problems = redPayload === null ? [] : listProblems(redPayload);
      if (entry.verdict === 'FAIL') failures += 1;
      report.push(entry);

      console.log(`[${index + 1}/${selected.length}] ${mutation.id} ${mutation.title}`);
      console.log(`  文件 ${entry.files.join('、')}`);
      for (const o of originals) {
        console.log(`  sha256 改前 ${o.sha}  （${o.file}）`);
      }
      for (const o of originals) {
        const mutated = entry.evidence[`sha256_mutated:${o.file}`];
        console.log(`  sha256 改后 ${mutated ?? '-'}（与改前不同：${mutated !== undefined && mutated !== o.sha}）`);
      }
      if (mutation.watch.length > 0) {
        console.log(`  watch ${mutation.watch.join(',')} → 变红：${(redPayload?.rows ?? []).filter((row) => row.verdict === 'FAIL').map((row) => `${row.id}(${row.actual?.status ?? row.actual?.[0]?.status})`).join(' ')}`);
        for (const line of entry.evidence.red_problems) console.log(`      真红原文：${line}`);
      }
      for (const row of redUnits) {
        console.log(`  单元靶子 ${row.file}「${row.pattern}」→ 必须真红：fail=${row.counts.fail} pass=${row.counts.pass} exit=${row.status}`);
        for (const line of row.redLines) console.log(`      真红原文：${line}`);
      }
      for (const o of originals) {
        console.log(`  sha256 恢复 ${entry.evidence.sha256_after[o.file]}（与改前一致：${entry.evidence.sha256_after[o.file] === o.sha}）`);
      }
      if (greenPayload !== null) {
        console.log(`  复跑 → ${(greenPayload.rows ?? []).map((row) => `${row.id}=${row.verdict}`).join(' ')}`);
      }
      for (const row of greenUnits) {
        console.log(`  单元靶子复跑 → fail=${row.counts.fail} pass=${row.counts.pass}（期望 fail=0 pass=1）`);
      }
      console.log(`  判定 ${entry.verdict}${problems.length > 0 ? `：${problems.join('；')}` : ''}\n`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const pass = report.length - report.filter((entry) => entry.verdict === 'FAIL').length;
  console.log(`———————————————— 负控制汇总 ————————————————`);
  for (const entry of report) console.log(`${entry.verdict} ${entry.id} ${entry.title}`);
  console.log(`负控制合计 ${report.length} 条：PASS ${pass} / FAIL ${report.length - pass}`);

  if (opts.json !== null) {
    mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    writeFileSync(opts.json, `${JSON.stringify({ generated_at: new Date().toISOString(), node: process.version, total: report.length, pass, fail: report.length - pass, entries: report }, null, 2)}\n`, 'utf8');
    console.log(`机读结果：${opts.json}`);
  }

  return failures === 0 ? 0 : 1;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`负控制执行器自身失败：${error?.stack ?? error}`);
  process.exit(2);
}
