/**
 * 跨轮游标文件（`services/api/src/privacy/online-purge-cursor.ts`）的单元测试。
 *
 * 这一组测的是**命令侧状态**，不是清理语义：游标只回答"下一次从哪一行之后继续翻"。
 * 关键取舍在这里被固定下来，改坏了会静默退回到"每轮撞同一批队首行"的饿死老路：
 *   1. 读盘三态 `absent` / `ok` / `invalid` —— 任何偏差都⛔不猜、⛔不静默当成"从头开始"；
 *   2. 文件里⛔没有 user_id／正文／连接串（它可能被运维顺手粘进工单）；
 *   3. 写入是原子的：进程被杀不会留下半个 JSON，也不会留下临时文件。
 *
 * 时间口径与驱动一致：一律归一成毫秒 ISO（`Date.parse` 截断 + `toISOString()`），
 * 与候选 SQL 里的 `date_trunc('milliseconds', online_due_at)` 同值。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_ONLINE_PURGE_CURSOR_FILE,
  ONLINE_PURGE_CURSOR_ENV,
  ONLINE_PURGE_CURSOR_STATE_VERSION,
  readOnlinePurgeCursor,
  resolveOnlinePurgeCursorPath,
  writeOnlinePurgeCursor,
} from '../../services/api/src/privacy/online-purge-cursor.ts';

const CURSOR = {
  afterDueAt: '2026-10-20T00:00:01.000Z',
  afterRequestId: '00000000-0000-4000-8000-000000000002',
};

/** 每个 test 一个独立临时目录；`finally` 里整个删掉（Windows 上也不留锁着的句柄）。 */
function withTempDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'gy-purge-cursor-'));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('[C1] 路径解析：--cursor-file > 环境变量 > 缺省文件名，相对路径按 cwd 解析', () => {
  const cwd = join(tmpdir(), 'gy-cwd');

  assert.equal(
    resolveOnlinePurgeCursorPath({
      argv: 'state/purge.json',
      env: { [ONLINE_PURGE_CURSOR_ENV]: 'from-env.json' },
      cwd,
    }),
    join(cwd, 'state', 'purge.json'),
    '命令行优先于环境变量',
  );
  assert.equal(
    resolveOnlinePurgeCursorPath({ env: { [ONLINE_PURGE_CURSOR_ENV]: 'from-env.json' }, cwd }),
    join(cwd, 'from-env.json'),
    '环境变量优先于缺省值',
  );
  assert.equal(
    resolveOnlinePurgeCursorPath({ cwd }),
    join(cwd, DEFAULT_ONLINE_PURGE_CURSOR_FILE),
    '都没给时落在 cwd 下的缺省文件名',
  );
  assert.equal(
    resolveOnlinePurgeCursorPath({ argv: '  from-argv.json  ', cwd }),
    join(cwd, 'from-argv.json'),
    '两端空白要裁掉（否则路径里会混进空格）',
  );
  assert.equal(
    resolveOnlinePurgeCursorPath({ env: { [ONLINE_PURGE_CURSOR_ENV]: '   ' }, cwd }),
    join(cwd, DEFAULT_ONLINE_PURGE_CURSOR_FILE),
    '环境变量只有空白等于没给',
  );

  assert.throws(
    () => resolveOnlinePurgeCursorPath({ argv: '', cwd }),
    /不能为空串/,
    '显式空串必须报错，⛔ 不顺从地换成缺省路径（运维会以为写到了自己指定的地方）',
  );
});

test('[C2] 没有游标文件 ⇒ absent（第一次跑，或上一轮已走到队尾并清掉了文件）', () => {
  withTempDir((dir) => {
    const read = readOnlinePurgeCursor(join(dir, 'not-there.json'));
    assert.deepEqual(read, { kind: 'absent', cursor: null, problem: null });
  });
});

test('[C3] 写进去再读回来：时刻与 UUID 都归一，文件里只有三个字段、没有任何主体标识', () => {
  withTempDir((dir) => {
    const path = join(dir, 'nested', 'purge-cursor.json');
    writeOnlinePurgeCursor(
      path,
      {
        // 故意给大写 UUID 与 +08:00 偏移：读回来必须是毫秒 UTC ISO + 小写 id。
        afterDueAt: '2026-10-20T08:00:01+08:00',
        afterRequestId: '00000000-0000-4000-8000-00000000000A',
      },
      '2026-10-21T00:00:00.000Z',
    );

    assert.ok(existsSync(path), '目录不存在时要能自己建出来');

    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed).sort(), ['cursor', 'updatedAt', 'version']);
    assert.equal(parsed.version, ONLINE_PURGE_CURSOR_STATE_VERSION);
    assert.equal(parsed.updatedAt, '2026-10-21T00:00:00.000Z');
    assert.deepEqual(parsed.cursor, {
      afterDueAt: '2026-10-20T00:00:01.000Z',
      afterRequestId: '00000000-0000-4000-8000-00000000000a',
    });
    assert.equal(text.includes('user_id'), false, '⛔ 游标里不许出现主体标识');
    assert.equal(text.includes('postgres://'), false, '⛔ 游标里不许出现连接串');

    assert.deepEqual(readOnlinePurgeCursor(path), { kind: 'ok', cursor: parsed.cursor, problem: null });

    // 原子写：写完不留临时文件（否则下一轮的读盘会看到一堆垃圾）。
    assert.deepEqual(
      readdirSync(join(dir, 'nested')).filter((name) => name.includes('.tmp-')),
      [],
      '不得留下临时文件',
    );
  });
});

test('[C4] 走到队尾 ⇒ 删文件（"从头开始"用文件不存在表达，不在文件里留 null）', () => {
  withTempDir((dir) => {
    const path = join(dir, 'purge-cursor.json');
    writeOnlinePurgeCursor(path, CURSOR, '2026-10-21T00:00:00.000Z');
    assert.ok(existsSync(path));

    writeOnlinePurgeCursor(path, null, '2026-10-21T01:00:00.000Z');
    assert.equal(existsSync(path), false, '已到队尾必须删掉文件');
    assert.deepEqual(readOnlinePurgeCursor(path), { kind: 'absent', cursor: null, problem: null });

    // 重复删除不抛（force），也不会把目录删掉。
    writeOnlinePurgeCursor(path, null, '2026-10-21T02:00:00.000Z');
    assert.equal(existsSync(dir), true);
  });
});

test('[C5] 文件写坏了 ⇒ invalid + 固定分类原因（⛔ 不静默当成"从头开始"）', () => {
  withTempDir((dir) => {
    const cases = [
      ['broken.json', '{ not json', /不是合法 JSON/],
      ['array.json', '[]', /不是 JSON 对象/],
      ['scalar.json', '"2026-10-20T00:00:00.000Z"', /不是 JSON 对象/],
      ['version.json', JSON.stringify({ version: 2, cursor: CURSOR, updatedAt: 'x' }), /版本不认识/],
      ['no-version.json', JSON.stringify({ cursor: CURSOR }), /版本不认识/],
      [
        'bad-cursor.json',
        JSON.stringify({ version: ONLINE_PURGE_CURSOR_STATE_VERSION, cursor: { afterDueAt: 'yesterday', afterRequestId: CURSOR.afterRequestId }, updatedAt: 'x' }),
        /游标内容不可用/,
      ],
      [
        'not-uuid.json',
        JSON.stringify({ version: ONLINE_PURGE_CURSOR_STATE_VERSION, cursor: { ...CURSOR, afterRequestId: 'r-1' }, updatedAt: 'x' }),
        /游标内容不可用/,
      ],
    ];

    for (const [name, body, pattern] of cases) {
      const path = join(dir, name);
      writeFileSync(path, body, 'utf8');
      const read = readOnlinePurgeCursor(path);
      assert.equal(read.kind, 'invalid', `${name} 必须判成 invalid`);
      assert.equal(read.cursor, null, `${name} 不得凭坏内容猜出一个游标`);
      assert.match(read.problem, pattern, `${name} 的原因要能一眼看出类型`);
    }
  });
});

test('[C6] 读不出来（EISDIR 这种非 ENOENT 的读错）⇒ invalid，且只报错误码不报文件内容', () => {
  withTempDir((dir) => {
    const asDir = join(dir, 'cursor.json');
    mkdirSync(asDir);
    const read = readOnlinePurgeCursor(asDir);
    assert.equal(read.kind, 'invalid');
    assert.match(read.problem, /读不出来（错误码 /);
    assert.equal(read.problem.includes('afterRequestId'), false);
  });
});

test('[C7] 文件里明确写着 cursor:null ⇒ ok + null（和"文件不存在"区分开）', () => {
  withTempDir((dir) => {
    const path = join(dir, 'null-cursor.json');
    writeFileSync(
      path,
      JSON.stringify({ version: ONLINE_PURGE_CURSOR_STATE_VERSION, cursor: null, updatedAt: 'x' }),
      'utf8',
    );
    assert.deepEqual(readOnlinePurgeCursor(path), { kind: 'ok', cursor: null, problem: null });
  });
});

test('[C8] 写入前也要归一：坏时刻直接抛，⛔ 不落一个下一轮读不回来的文件', () => {
  withTempDir((dir) => {
    const path = join(dir, 'purge-cursor.json');
    assert.throws(
      () => writeOnlinePurgeCursor(path, { ...CURSOR, afterDueAt: '2026-10-20 00:00:01' }, '2026-10-21T00:00:00.000Z'),
      /带时区的 ISO-8601/,
    );
    assert.equal(existsSync(path), false, '抛错时不得留下半成品文件');

    assert.throws(() => writeOnlinePurgeCursor(path, CURSOR, Number.NaN), /updatedAt 必须是可解析的时刻/);
    assert.equal(existsSync(path), false);
  });
});
