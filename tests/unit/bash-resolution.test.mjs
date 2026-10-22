/**
 * bash 解析器（`tests/unit/bash-resolver.mjs`）的回归：**WSL 存根必须被判不可用**、**`GY_BASH` 必须优先**。
 *
 * 背景：`release-materials-index*.test.mjs` 的 8 条用例本机恒红，红的不是代码，是
 * 「`bash` 落到了 WSL 存根」。只把本机修绿不够——下一个人换个 Windows 环境还会踩同一脚，
 * 所以这里把解析器的两条核心判断钉死：
 *
 *   1. 存根判据看**输出**不看路径：`wsl:`、`localhost 代理`，或 UTF-16 下同时含 `localhost` 与 `WSL`；
 *      即使它退出码 0、即使 stdout 里也有个 `ok`，也不能被当成真 bash（否则校验等于被关掉）；
 *   2. `GY_BASH` 永远排第一：显式指路的优先级高于任何默认猜测，而且命中后不再往下试。
 *
 * 夹具是临时目录里的桩（Windows 写 `.cmd`、POSIX 写带 shebang 的可执行脚本，真的启动、真的读输出），
 * **不调真 WSL**（调它等于把「本机装没装 WSL」这种环境差异重新引入测试）。没有 `GY_BASH`/默认候选的
 * 用例都显式给 `candidates`，不读本机 PATH；也不赌本机装了 Git bash（`D:\Git\bin\bash.exe` 只作为
 * 字符串形态的输入出现在 `bashNameOf`/`bashFirstEnv` 判据里，不参与「文件是否存在」的判断）。
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { after, before, test } from 'node:test';

import {
  bashFirstEnv,
  bashNameOf,
  classifyBashProbe,
  normalizeProbeOutput,
  resolveBash,
  resolveGateBash,
  wslStubEvidence,
} from './bash-resolver.mjs';

let dir = '';

/**
 * 造一个**真的会跑起来**的存根，两种平台各用各的形态：
 *   - Windows：`.cmd`（Node 24 起 `.cmd` 只能经 shell 启动，解析器已按扩展名分流）；
 *   - POSIX：带 shebang 的可执行脚本（无扩展名 ⇒ 解析器走直连，靠 shebang 执行）。
 * 这样同一组用例在 Windows／Linux CI 上验的是同一条判据，而不是「本机装了什么」。
 */
function makeStub(name, { stdout = '', stderr = '', code = 0 } = {}) {
  if (process.platform === 'win32') {
    const file = join(dir, `${name}.cmd`);
    const lines = ['@echo off'];
    if (stdout !== '') lines.push(`echo ${stdout}`);
    if (stderr !== '') lines.push(`echo ${stderr} 1>&2`);
    lines.push(`exit /b ${code}`, '');
    writeFileSync(file, lines.join('\r\n'));
    return file;
  }
  const file = join(dir, name);
  const lines = ['#!/bin/sh'];
  if (stdout !== '') lines.push(`printf '%s\\n' '${stdout}'`);
  if (stderr !== '') lines.push(`printf '%s\\n' '${stderr}' 1>&2`);
  lines.push(`exit ${code}`, '');
  writeFileSync(file, lines.join('\n'));
  chmodSync(file, 0o755);                    // 可执行位：不带它，直连 spawn 会 EACCES
  return file;
}

/** WSL 存根的语义形状（不依赖具体平台写法）。 */
const WSL_STUB = { stderr: 'wsl: localhost proxy settings detected but not mirrored into WSL', code: 1 };

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'gy-bash-resolver-'));
});

after(() => {
  if (dir === '') return;
  assert.ok(dir.startsWith(resolve(tmpdir()) + sep), `夹具目录必须直属于系统临时目录：${dir}`);
  assert.ok(basename(dir).startsWith('gy-bash-resolver-'), `夹具目录名前缀必须可识别：${dir}`);
  assert.equal(dirname(dir), resolve(tmpdir()), '夹具目录必须直属于系统临时目录');
  rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------- 纯判据
test('判据·UTF-16 的 WSL 存根输出被判不可用（本机实测形状：stderr 是 UTF-16LE）', () => {
  // 本机 `C:\Windows\System32\bash.exe` 实测：stderr 字节为 `77 00 73 00 6c 00 3a 00 …`（UTF-16LE），
  // 按 utf8 读会夹 NUL。把该形状原样喂进纯函数，钉住「存根认得出」。
  const stub = Buffer.from('wsl: 检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL 无法连接 localhost。', 'utf16le');
  const verdict = classifyBashProbe({ status: 1, stdout: Buffer.alloc(0), stderr: stub });
  assert.equal(verdict.usable, false, 'WSL 存根必须判为不可用');
  assert.match(verdict.reason, /WSL 存根/, `失败原因必须点名 WSL 存根：${verdict.reason}`);
  assert.match(normalizeProbeOutput({ stderr: stub }), /wsl:/i, '去 NUL 后必须仍能读到 wsl: 标记');
});

test('判据·退出码 0 且输出带 ok 也不能放过 WSL 存根（否则等于把校验关掉）', () => {
  // 反例的证明力：只看「退出码 0 / 输出含 ok」的解析器会把这种候选当真 bash，门禁随后照样红。
  const fooled = classifyBashProbe({ status: 0, stdout: 'ok\n', stderr: Buffer.from('wsl: 检测到 localhost 代理配置', 'utf16le') });
  assert.equal(fooled.usable, false, '有 wsl: 证据时必须判不可用，哪怕退出码 0、stdout 里有 ok');
  assert.match(fooled.reason, /WSL 存根/);

  const proxyOnly = classifyBashProbe({ status: 0, stdout: 'ok', stderr: 'localhost 代理配置未镜像' });
  assert.equal(proxyOnly.usable, false, '「localhost 代理」开头的输出同属存根判据');
  assert.match(proxyOnly.reason, /localhost 代理/);
});

test('判据·真 bash 的三条形态：ok → 可用；无 ok → 不可用；非 0 → 不可用；ENOENT → 不可用不抛错', () => {
  assert.deepEqual(classifyBashProbe({ status: 0, stdout: 'ok\n', stderr: '' }), { usable: true, reason: 'ok' });
  assert.equal(classifyBashProbe({ status: 0, stdout: 'hello', stderr: '' }).usable, false, '输出不含 ok 不算可用');
  assert.match(classifyBashProbe({ status: 2, stdout: '', stderr: 'boom' }).reason, /退出码 2/);
  const missing = classifyBashProbe({ status: null, errorCode: 'ENOENT' });
  assert.equal(missing.usable, false, '路径不存在必须判不可用（不是抛错）');
  assert.match(missing.reason, /ENOENT/);
});

test('判据·wslStubEvidence 只在有证据时返回，普通路径/正常输出不误判', () => {
  assert.equal(wslStubEvidence('D:\\Git\\bin\\bash.exe'), null, '路径本身不是证据（判据看输出）');
  assert.equal(wslStubEvidence('ok'), null);
  assert.equal(wslStubEvidence('WSL 已安装'), null, '只出现 WSL 一个词不是证据');
  assert.equal(wslStubEvidence('localhost + WSL'), 'localhost + WSL', 'UTF-16 乱码后只剩这两个 ASCII 词时仍要认得出');
});

// --------------------------------------------------------------------------- 真启动 .cmd 桩
test('解析·WSL 存根桩被判不可用，且提示里带 GY_BASH 用法（不静默回落成 pass）', (t) => {
  const stub = makeStub('wsl-stub', WSL_STUB);
  const result = resolveBash({ env: {}, candidates: [stub] });
  t.diagnostic(`attempts: ${JSON.stringify(result.attempts)}`);
  assert.equal(result.available, false, 'WSL 存根必须是不可用');
  assert.equal(result.path, null, '不可用时不得交出路径');
  assert.equal(result.attempts.length, 1, '候选只有一个时只能试一次');
  assert.match(result.attempts[0].reason, /WSL 存根/, `失败原因必须点名 WSL 存根：${result.attempts[0].reason}`);
  assert.match(result.hint, /GY_BASH/, '提示必须写出 GY_BASH 用法');
  assert.match(result.hint, /skip/, '提示必须说明相关用例按环境缺失 skip（不是通过）');
  assert.match(result.hint, /已尝试：/, '提示必须列出试过哪些候选');
});

test('解析·GY_BASH 优先：指对了就直接用，不再试后面的候选', (t) => {
  const good = makeStub('real-bash', { stdout: 'ok' });
  const stub = makeStub('wsl-stub', WSL_STUB);
  // 故意把存根放在 candidates 里、且排在前面：解析器仍必须先用 GY_BASH。
  const result = resolveBash({ env: { GY_BASH: good }, candidates: [stub] });
  t.diagnostic(`attempts: ${JSON.stringify(result.attempts)}`);
  assert.equal(result.available, true, `GY_BASH 可用时必须命中：${JSON.stringify(result.attempts)}`);
  assert.equal(result.path, good, '必须命中 GY_BASH 指的那个 bash');
  assert.equal(result.attempts.length, 1, '命中 GY_BASH 后不得再试其它候选');
});

test('解析·GY_BASH 指错时退到下一候选（配错不该让本机恒红），但保留失败原因', (t) => {
  const good = makeStub('real-bash', { stdout: 'ok' });
  const stub = makeStub('wsl-stub', WSL_STUB);
  const result = resolveBash({ env: { GY_BASH: stub }, candidates: [good] });
  t.diagnostic(`attempts: ${JSON.stringify(result.attempts)}`);
  assert.equal(result.available, true, 'GY_BASH 不可用时应继续按顺序试');
  assert.equal(result.path, good, '必须退到可用的那个候选');
  assert.equal(result.attempts.length, 2, '两次尝试都要留痕');
  assert.match(result.attempts[0].reason, /WSL 存根/, '第一条尝试必须写明 GY_BASH 指向的是存根');
});

test('解析·全都不可用 ⇒ available=false、hint 含已尝试清单（调用方据此 skip）', () => {
  const stub = makeStub('wsl-stub', WSL_STUB);
  const result = resolveGateBash({ env: { GY_BASH: stub }, candidates: [] });
  assert.equal(result.available, false);
  assert.equal(result.bashPath, null);
  assert.equal(result.env, null, '不可用时不得交出子进程环境（否则调用方会拿着默认 PATH 跑出恒红）');
  assert.match(result.hint, /GY_BASH/);
  assert.ok(result.hint.includes(stub), `已尝试清单必须点名那个候选：${result.hint}`);
});

// --------------------------------------------------------------------------- 子进程环境
test('环境·把 bash 的目录前置进子进程 PATH，且不留重复的 Path 键（用临时目录里的真桩，不赌本机装没装 Git bash）', () => {
  // 夹具自造：目录 + 名为 bash(.exe) 的可执行文件。CI 是 Linux，本机是 Windows，两边都得能构造出来。
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const exe = join(binDir, process.platform === 'win32' ? 'bash.exe' : 'bash');
  writeFileSync(exe, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n');
  chmodSync(exe, 0o755);
  const basePath = [join(dir, 'one'), join(dir, 'two')].join(delimiter);

  const wrapped = bashFirstEnv(exe, { Path: basePath, GY_BASH: exe });
  assert.equal(wrapped.ok, true, `名字是 bash(.exe) 且是绝对路径，必须可注入：${wrapped.reason ?? ''}`);
  const pathKeys = Object.keys(wrapped.env).filter((key) => /^path$/i.test(key));
  assert.deepEqual(pathKeys, ['PATH'], 'PATH 键必须唯一且统一写成 PATH（Windows 上原键名可能是 Path）');
  assert.ok(wrapped.env.PATH.startsWith(binDir + delimiter), `bash 的目录必须排在 PATH 最前：${wrapped.env.PATH}`);
  assert.ok(wrapped.env.PATH.endsWith(basePath), `原 PATH 必须完整保留在后面：${wrapped.env.PATH}`);
  assert.equal(wrapped.env.GY_BASH, exe, '其余环境变量必须原样带过去');
});

test('环境·Windows 风格绝对路径在 Linux CI 上也要按反斜杠切（红过的形态：POSIX basename 会把整串当文件名）', () => {
  assert.equal(bashNameOf('D:\\Git\\bin\\bash.exe'), 'bash.exe', 'POSIX 上 basename 不认反斜杠，必须两种分隔符都切');
  assert.equal(bashNameOf('/usr/bin/bash'), 'bash', 'POSIX 路径照常');
  assert.equal(bashNameOf('bash'), 'bash', 'PATH 兜底的名字不含分隔符');

  const wrapped = bashFirstEnv('D:\\Git\\bin\\bash.exe', { PATH: 'C:\\Windows' });
  assert.equal(wrapped.ok, true, `名字是 bash.exe，必须可注入（Linux 上判死过）：${wrapped.reason ?? ''}`);
  assert.ok(wrapped.env.PATH.startsWith('D:\\Git\\bin'), `PATH 首位必须是该 bash 的目录：${wrapped.env.PATH}`);
  assert.ok(wrapped.env.PATH.includes('C:\\Windows'), '原 PATH 必须保留');
});

test('环境·名字不是 bash(.exe) 的候选不注入（门禁按名字找 bash，宁可不跑也别赌）', () => {
  const wrapped = bashFirstEnv('C:\\tools\\my-bash.exe', { PATH: 'C:\\Windows' });
  assert.equal(wrapped.ok, false, '名字对不上必须报不可注入');
  assert.match(wrapped.reason, /GY_BASH/, '提示必须告诉人该改 GY_BASH');
  assert.equal(bashFirstEnv('bash', { PATH: 'C:\\Windows' }).ok, true, '经 PATH 兜底命中的 `bash` 不需要注入');
});
