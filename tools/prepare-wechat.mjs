import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalConfig, configArgument } from './local-debug-config.mjs';
import { REGION_CENTROID_SOURCE, regionCentroidManifestEntries, assertRegionCentroidPackaging } from './lib/region-centroid-packaging.mjs';

/**
 * 仓库根：由脚本自身的位置推出（`tools/` → `..`），⛔ 不用 `process.cwd()`。
 * 单测正是靠这一点把整棵临时工程（tools/ ＋ miniprogram/ ＋ project.config.json）复制进 tmpdir 再跑，
 * 于是产物天然落在临时目录里——所以 `--out` 不需要、也不提供隐藏的环境变量开关。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_ID_PATTERN = /^wx[0-9a-f]{16}$/;
// 测试号申请入口（微信公众平台 → 开发 → 开发管理 → 开发设置 → 开发者工具 → 测试号）。
// 2026-10-19 实测该 URL 可打开，但正文由微信公众平台前端渲染，需在浏览器登录后查看。
const TEST_ACCOUNT_URL = 'https://mp.weixin.qq.com/wxamp/sandbox?doc=1';
/** 组件必需文件：微信原生自定义组件缺任一都会在编译期报「未找到组件」；`.wxss` 可选。 */
const COMPONENT_REQUIRED_EXTS = ['.js', '.json', '.wxml'];

/** 生成物根目录：本脚本唯一写盘的地方；`--force` 也只允许删这里的直接子目录。 */
const LOCAL_ROOT = join(root, '.local');
/**
 * 客户端拼接基址的业务前缀：`services/api/src/contract.ts` 的全部端点都以 `/api/v1` 开头，
 * 而客户端是拿 `runtime.apiBaseUrl` 直接拼 `/auth/wechat` 这类路径的，基址漏了前缀就必然 404。
 */
const API_BASE_SUFFIX = '/api/v1';
/**
 * 微信开发者工具 CLI 的候选位置：只用于打印「下一步」里的打开命令，不参与任何校验。
 * 第一个是 2026-10 本机实测可用的安装路径；装在别处就换成自己的 `cli.bat`。
 */
const DEVTOOLS_CLI_CANDIDATES = Object.freeze([
  'D:\\微信web开发者工具\\cli.bat',
  'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
]);

/** 用法行：参数非法时的报错带它，新旗标必须在这里可见。 */
const USAGE = 'Usage: node tools/prepare-wechat.mjs local --config <file> [--appid <wx…>] [--no-urlcheck] [--force] [--out <dir>] [--dry-run] | release [--force] [--out <dir>] [--dry-run]';
/** `--help` 正文：本机演示流程的全部前提写在这里，不靠读源码猜。 */
const HELP = [
  USAGE,
  '',
  'local：生成 <根目录>/wechat-local 诊断副本（客户端接本地 API，是否联网由副本 runtime.js 决定）。',
  '  --config <file>   被忽略的本地配置（模板：config/debug.local.json.example）。',
  '                    apiBaseUrl 必须以业务前缀 /api/v1 结尾（如 http://127.0.0.1:3000/api/v1）；',
  '                    漏写不会自动补全，脚本直接失败并给出应写的值。',
  '  --appid <wx…>     只改副本的 appid（换上自己扫码的测试号），共享工程不动。',
  '  --no-urlcheck     只把副本 project.config.json 的 setting.urlCheck 写成 false：',
  '                    开发者工具不再拦「不在以下 request 合法域名列表」，省掉手动勾选。',
  '                    ⚠ 仅供本机演示/测试号使用；正式提交前不要开，也不要写回共享工程。',
  '  --force           目标目录已存在时先删除再生成（只删目标根目录下这一个生成目录）。',
  '  --out <dir>       生成根目录，默认 <repo>/.local；目录名仍固定为 wechat-<mode>。',
  '                    必须在仓库树之外（相对路径按当前工作目录解析）：副本留在仓库里，',
  '                    文档锚点闸门会把重复的 miniprogram 当目标，判成多义/失效（假红）。',
  '  --dry-run         只校验参数与输出位置并打印结论，不建目录、不复制、不删除任何文件。',
  'release：生成 <根目录>/wechat-release 副本（runtime 关闭网络、urlCheck 保持 true），不是可提交的正式包。',
  '',
  '默认行为与旧版一致：不加旗标时输出仍是 <repo>/.local/wechat-<mode>、urlCheck 仍为 true、目标已存在仍拒绝覆盖。',
].join('\n');

function compareReferences(left, right) {
  const a = left.from + '|' + left.name;
  const b = right.from + '|' + right.name;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function displayPath(root, path) {
  return relative(root, path).replaceAll('\\', '/');
}

/**
 * 扫描 `miniprogram/**\/*.json` 的 `usingComponents`，返回每一条组件引用。
 *
 * 组件集合**从引用派生**，不再维护第二份硬编码清单：2026-10 实测的缺陷正是清单漏了
 * `components/fav-entry`，生成的 local 工程在开发者工具里项目级报
 * 「在 … 路径下未找到组件」——错误指向组件缺失，几乎不会让人联想到是打包脚本漏拷。
 * 派生后新增组件/新页面引用组件都自动纳入，同类缺口不会再出现。
 *
 * `base` 是**不带扩展名**的组件基址：`/` 开头相对小程序根，其余相对声明它的 JSON 所在目录（与微信同义）。
 */
function collectComponentReferences(miniprogramRoot) {
  const references = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      const json = JSON.parse(readFileSync(path, 'utf8'));
      for (const [name, reference] of Object.entries(json.usingComponents ?? {})) {
        if (typeof reference !== 'string' || reference.length === 0) {
          throw new Error('usingComponents 引用非法：' + displayPath(miniprogramRoot, path) + ' -> ' + name + '；未生成任何目录。');
        }
        const base = reference.startsWith('/') ? resolve(miniprogramRoot, reference.slice(1)) : resolve(dirname(path), reference);
        const inside = relative(miniprogramRoot, base);
        if (isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) {
          throw new Error('usingComponents 引用越出 miniprogram 根：' + displayPath(miniprogramRoot, path) + ' -> ' + name + '（' + reference + '）；未生成任何目录。');
        }
        references.push({ from: displayPath(miniprogramRoot, path), name, reference, base });
      }
    }
  };
  visit(miniprogramRoot);
  return references.sort(compareReferences);
}

/**
 * 引用 → 组件目录清单，并在**创建任何目录之前**校验组件必需文件齐全。
 * 返回 `{ source, path }`：source 是源码组件目录，path 是副本内相对小程序根的目录。
 */
function componentDirectories(miniprogramRoot) {
  const directories = new Map();
  for (const reference of collectComponentReferences(miniprogramRoot)) {
    const missing = COMPONENT_REQUIRED_EXTS.filter(ext => !existsSync(reference.base + ext));
    if (missing.length !== 0) {
      throw new Error('usingComponents 引用的组件不完整：' + reference.from + ' -> ' + reference.name + '（' + reference.reference + '）缺 ' + missing.join(' ') + '；未生成任何目录。');
    }
    const source = dirname(reference.base);
    if (!directories.has(source)) directories.set(source, displayPath(miniprogramRoot, source));
  }
  return [...directories].map(([source, path]) => ({ source, path }));
}

/**
 * 复制后自检：副本里每一条 `usingComponents` 都必须解析到组件文件，否则拒绝交付。
 * 这是「清单/派生漏项」的结构性防线——失败信息点名页面与组件，而不是把
 * `compilePageJSON` 的「未找到组件」留给微信开发者工具。
 */
function assertComponentsCopied(components, copyRoot) {
  const unresolved = collectComponentReferences(copyRoot).filter(reference =>
    COMPONENT_REQUIRED_EXTS.some(ext => !existsSync(reference.base + ext)));
  const absent = components.filter(component => !existsSync(join(copyRoot, component.path)));
  if (unresolved.length === 0 && absent.length === 0) return;
  const lines = [
    ...unresolved.map(reference => '  ' + reference.from + ' -> ' + reference.name + '（' + reference.reference + '）'),
    ...absent.map(component => '  ' + component.path + '（组件目录未复制）'),
  ];
  throw new Error('生成副本仍缺 usingComponents 引用的组件：\n' + lines.join('\n') + '\n请先删除 ' + dirname(copyRoot) + ' 再修本脚本。');
}

/**
 * 从 local 的参数里摘出可选的 `--appid <wx…>`，其余参数原样交给 --config 校验。
 * 只改**被忽略的生成副本**里的 appid：协作者账号不是共享工程的小程序项目成员时，
 * 共享工程的官方 AppID 在微信开发者工具里会直接拦住登录调试；换成自己扫码的测试号 AppID
 * 即可零成员资格走通 wx.login → code2session。共享工程本身绝不改写。
 * 所有校验都在 mkdir 之前完成，非法值不会留下任何半成品目录。
 */
function takeAppId(args) {
  const rest = [];
  let appId = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--appid') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--appid 缺少取值：应写成 `--appid wx…`（wx + 16 位小写十六进制）；未生成任何目录。');
      if (!APP_ID_PATTERN.test(value)) throw new Error('--appid 格式非法：' + JSON.stringify(value) + ' 不匹配 ^wx[0-9a-f]{16}$；未生成任何目录，共享工程与 release 副本不受影响。');
      if (appId !== null) throw new Error('--appid 只能出现一次；未生成任何目录。');
      appId = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--appid=')) throw new Error('--appid 只支持空格分隔写法 `--appid wx…`，不支持等号形式；未生成任何目录。');
    rest.push(arg);
  }
  return { appId, rest };
}

/**
 * 摘出本机演示用的两个开关旗标：`--no-urlcheck`（只放松副本的域名校验）与 `--force`（重建副本）。
 * 两者都只影响**被忽略的生成副本**：源 `project.config.json` 与共享 `runtime.js` 全程只读。
 * 取值的写法（`--no-urlcheck=true`）直接拒绝，避免有人以为能用它把 urlCheck 设回 true。
 */
function takeDemoFlags(args) {
  const rest = [];
  let noUrlCheck = false;
  let force = false;
  for (const arg of args) {
    if (arg === '--no-urlcheck') { noUrlCheck = true; continue; }
    if (arg === '--force') { force = true; continue; }
    if (arg.startsWith('--no-urlcheck=') || arg.startsWith('--force=')) {
      throw new Error('--no-urlcheck 与 --force 是开关，不接受取值（写成 `--no-urlcheck`／`--force` 即可）；未生成任何目录。');
    }
    rest.push(arg);
  }
  return { noUrlCheck, force, rest };
}

/**
 * 摘出 `--out <dir>`（生成根目录）与 `--dry-run`（只校验不落盘）。
 * `--out` 只换根目录，目录名仍固定 `wechat-<mode>`：演示脚本与文档按这个名字找副本，改名等于换契约。
 * 取值写法（`--out=dir`）直接拒绝，与 `--appid` 保持同一口径：一种旗标只认一种写法。
 */
function takeOutRoot(args) {
  const rest = [];
  let outRoot = null;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--out') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--out 缺少取值：应写成 `--out <目录>`（相对路径按当前工作目录解析）；未生成任何目录。');
      if (outRoot !== null) throw new Error('--out 只能出现一次；未生成任何目录。');
      outRoot = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--out=')) throw new Error('--out 只支持空格分隔写法 `--out <目录>`，不支持等号形式；未生成任何目录。');
    if (arg.startsWith('--dry-run=')) throw new Error('--dry-run 是开关，不接受取值（写成 `--dry-run` 即可）；未生成任何目录。');
    rest.push(arg);
  }
  return { outRoot, dryRun, rest };
}

/** `child` 是否落在 `parent` 之内（含相等）：两边都先 resolve，避免大小写／尾斜杠差异。 */
function isInside(parent, child) {
  const inside = relative(resolve(parent), resolve(child));
  return inside === '' || (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside));
}

/** `--out` 落在仓库树内：退出码 2（参数错误），与「解析失败／缺键」的语义区分开。 */
class OutOfRepoError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

/** `--dry-run` 的提前收尾：不是失败，只是「校验完就停」；抛出来是为了不改 200 行复制逻辑的缩进。 */
class DryRunStop extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 0;
  }
}

/** 开发者工具 CLI：本机能找到就用真实路径，找不到退回文档里写的默认安装位置（不影响任何校验）。 */
function devtoolsCli() {
  for (const candidate of DEVTOOLS_CLI_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return DEVTOOLS_CLI_CANDIDATES[0];
}

/**
 * 生成根目录：默认 `<repo>/.local`；给了 `--out` 就用它，**但必须在仓库树之外**。
 *
 * 为什么是硬拒绝而不是提醒：`--scan docs` 会把仓库里每个 `*.js` 都当锚点候选，
 * 副本里上百个与仓库同名的 `miniprogram/**` 文件会把「只此一处」的锚点判成多义／失效
 * （本机实测：副本留在 `.local/` 时 `verify-doc-anchors --strict` 从 PASS 变 exit 1）。
 * 手工 `Move-Item` 能绕开，但那是每次都要记得的手工步骤——本函数把它变成一次参数错误。
 */
function resolveImportRoot({ outRoot, mode }) {
  const expectedName = 'wechat-' + mode;
  if (outRoot === null) return join(LOCAL_ROOT, expectedName);
  const base = resolve(process.cwd(), outRoot);
  if (isInside(root, base)) {
    throw new OutOfRepoError('--out 不能落在仓库树内：' + base + '\n'
      + '  副本留在仓库树内会让文档锚点闸门把重复的 miniprogram 当目标（假红）：副本里的 *.js 与仓库同名文件并存，\n'
      + '  `node tools/verify-doc-anchors.mjs --strict --scan docs` 会把单义锚点判成多义／失效。\n'
      + '  换成仓库外的位置再跑（例如 ' + join(dirname(root), 'demo-project') + '）；未生成任何目录。');
  }
  return join(base, expectedName);
}

/** 目标已存在时的统一提示：`--dry-run` 与真跑共用一条文案，避免两处口径漂移（测试也按这条断言）。 */
function existingOutputMessage(out) {
  return 'Output already exists: ' + out + '. Keep it for inspection, pass --force to regenerate it (only that generated directory is removed), or remove it yourself before preparing again.';
}

/**
 * `--force` 删除前的最后一道闸：目标必须是 `container`（默认 `<repo>/.local`，给 `--out` 时是该根）
 * 的**直接子目录**且就是本次要生成的目录名。
 * 路径由 join(根, 'wechat-' + mode) 拼出来，这条断言在正常路径上恒真——
 * 它守的是「将来有人改了 out 的拼法，别让一次 --force 把根目录之外的东西删掉」。
 */
function assertRemovableOutput(out, expectedName, container = LOCAL_ROOT) {
  const inside = relative(container, out);
  const contained = inside !== '' && inside !== '..' && !inside.startsWith('..' + sep)
    && !isAbsolute(inside) && resolve(container, inside) === resolve(out);
  if (!contained || inside !== expectedName) {
    throw new Error('拒绝删除：目标目录不是 ' + container + ' 的直接子目录（' + out + '）；未删除任何文件。');
  }
}

/** 整树复制时跳过的目录／文件：生成物、依赖、以及本机私有配置都不该进副本。 */
const COPY_EXCLUDED_DIRS = new Set(['.local', 'node_modules']);
const COPY_EXCLUDED_FILE = /\.local\.json$/u;

/**
 * 把 `miniprogram/` **整棵树**复制进副本，返回已复制的相对路径集合。
 *
 * ⛔ 这里不读 `files` 清单：逐项清单每加一个新的 `utils/*.js` 就漏一次（2026-11 实测漏了
 * `utils/time-format.js` 与 `utils/session.js`，科普/社区/消息/收藏/识别历史五条动线在副本里
 * 全部 `MODULE_NOT_FOUND`，又被 `knowledge-api.js` 吞成「资料服务暂不可用」）。清单现在只做
 * 「这些必须在产物里」的断言，完整性由整树复制保证。
 */
function copyMiniprogramTree(sourceRoot, targetRoot) {
  const copied = new Set();
  const walk = (relativeDir) => {
    for (const entry of readdirSync(join(sourceRoot, relativeDir), { withFileTypes: true })) {
      const relativePath = relativeDir === '' ? entry.name : join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (COPY_EXCLUDED_DIRS.has(entry.name)) continue;
        walk(relativePath);
        continue;
      }
      // 符号链接等内容一律不跟随：副本要能一口咬定「产物里每个文件都来自仓库里同名文件」。
      if (!entry.isFile() || COPY_EXCLUDED_FILE.test(entry.name)) continue;
      const target = join(targetRoot, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(sourceRoot, relativePath), target);
      copied.add(relativePath.split(sep).join('/'));
    }
  };
  walk('');
  return copied;
}

/**
 * 生成结束后打印「下一步」：演示流程只有三步（起栈 → 打开开发者工具 → 勾选项）。
 * 放在输出末尾是为了省掉「生成完还要回去翻文档改配置」——这正是 `--no-urlcheck` 要消掉的来回。
 */
function printNextSteps({ out, apiBaseUrl, noUrlCheck }) {
  console.log('');
  console.log('下一步（本机演示）：');
  console.log('  1) 起本地栈：npm run dev:api（API 监听端口必须与副本基址一致：' + apiBaseUrl + '）');
  console.log('  2) 打开开发者工具（--project 必须是绝对路径：相对路径会报 code 10 项目路径不存在，而退出码仍是 0）：');
  console.log('     & "' + devtoolsCli() + '" open --project "' + out + '"');
  console.log('  3) 勾选项：' + (noUrlCheck
    ? '副本已写入 setting.urlCheck=false，「详情 → 本地设置 → 不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」应当已是勾选状态，不用再手动勾。'
    : '若仍报「不在以下 request 合法域名列表」，在「详情 → 本地设置」勾「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」，或重新生成时加 --no-urlcheck 免手改。'));
  console.log(isInside(root, out)
    ? '  副本在 ' + displayPath(root, LOCAL_ROOT) + '/ 下，已被 .gitignore 忽略；共享工程与 release 副本一个字节都没改。'
    : '  副本在 ' + out + '（`--out` 指定的仓库外目录：不在 git 里，也不会被文档锚点闸门扫到）；共享工程与 release 副本一个字节都没改。');
}

try {
  const [mode, ...argv] = process.argv.slice(2);
  // `--help`／`-h` 只打印用法：不做任何校验、不产生任何目录，退出码 0（故此处显式结束进程）。
  if (mode === '--help' || mode === '-h' || mode === 'help') {
    console.log(HELP);
    process.exit(0);
  }
  if (!['local', 'release'].includes(mode)) throw new Error(USAGE);
  // release 副本固定沿用共享工程的官方 AppID：覆盖只服务于本地调试，越界即拒。
  if (mode === 'release' && argv.some(arg => arg.startsWith('--appid'))) throw new Error('release 不接受 --appid：release 副本固定使用共享工程官方 AppID。协作者本地调试请用 `local --config <file> --appid wx…`。');
  const { noUrlCheck, force, rest: flagArgs } = takeDemoFlags(argv);
  // release 副本必须是「共享工程原样 + 断网」：放松域名校验只服务本机演示，出现在 release 里就是配置错。
  if (mode === 'release' && noUrlCheck) throw new Error('release 不接受 --no-urlcheck：release 副本必须保持 setting.urlCheck=true（域名校验开启）。本机演示请用 `local --config <file> --no-urlcheck`。');
  // 输出位置也先摘掉：`--config` 的校验器只认「恰好两个参数」，旗标留在 args 里会把它变成用法错误。
  const { outRoot, dryRun, rest: demoArgs } = takeOutRoot(flagArgs);
  const { appId: appIdOverride, rest: args } = mode === 'local' ? takeAppId(demoArgs) : { appId: null, rest: demoArgs };
  // 输出位置在碰源工程之前就定下来：`--out` 落在仓库内属于参数错误，跟源工程是否可用无关。
  const out = resolveImportRoot({ outRoot, mode });
  const expectedName = 'wechat-' + mode;
  // `--dry-run`：只回答「会生成到哪、目标是否已存在」，不读源工程、不建目录、不复制、不删除。
  if (dryRun) {
    const lines = ['dry-run：校验通过，没有创建、复制或删除任何文件。', mode.toUpperCase() + ' import root: ' + out];
    if (existsSync(out)) {
      if (!force) throw new Error(existingOutputMessage(out));
      assertRemovableOutput(out, expectedName, dirname(out));
      lines.push('  目标已存在（加 --force 会先删掉这一个目录再重建）：' + out);
    }
    throw new DryRunStop(lines.join('\n'));
  }
  const runtime = mode === 'local' ? readLocalConfig(configArgument(args)) : { mode: 'disabled', apiBaseUrl: '' };
  if (mode === 'release' && args.length) throw new Error('Release does not accept a local configuration.');
  // 基址必须自带业务前缀：客户端拿它直接拼 `/auth/wechat`，漏写不会报错，只会在运行时 404。
  if (mode === 'local' && !runtime.apiBaseUrl.endsWith(API_BASE_SUFFIX)) {
    throw new Error('apiBaseUrl 必须以业务前缀 ' + API_BASE_SUFFIX + ' 结尾：当前配置是 ' + JSON.stringify(runtime.apiBaseUrl) + '，应写成 ' + new URL(runtime.apiBaseUrl).origin + API_BASE_SUFFIX + '（端口换成你的本地 API 端口）。客户端按 runtime.apiBaseUrl 直接拼接 /auth/wechat 等路径，漏写前缀会打到 /auth/wechat 得 404；未生成任何目录。');
  }
  const config = JSON.parse(readFileSync(join(root, 'project.config.json'), 'utf8'));
  if (config.compileType !== 'miniprogram' || config.miniprogramRoot !== 'miniprogram/' || config.setting.urlCheck !== true) throw new Error('Shared project must use native miniprogram and domain validation.');
  const sharedAppId = config.appid;
  const sharedRuntime = readFileSync(join(root, 'miniprogram/config/runtime.js'), 'utf8').replace(/\r\n/g, '\n');
  if (sharedRuntime !== "// Shared source always has networking disabled. Local preparation writes only an ignored copy.\nmodule.exports = { mode: 'disabled', apiBaseUrl: '' }\n") throw new Error('Shared runtime changed. Refuse to package a possible local/stub configuration.');
  // 组件目录从 usingComponents 派生（在任何目录被创建之前完成校验）：新增组件无需再改本脚本。
  const components = componentDirectories(join(root, 'miniprogram'));
  // 默认仍拒绝复用：personal overrides 与陈旧生成物不能悄悄留下。`--force` 才重建，且只删这一个生成目录。
  if (existsSync(out)) {
    if (!force) throw new Error(existingOutputMessage(out));
    assertRemovableOutput(out, expectedName, dirname(out));
    rmSync(out, { recursive: true, force: true });
    console.log('已删除旧副本（--force）：' + (isInside(root, out) ? displayPath(root, out) : out));
  }
  mkdirSync(out, { recursive: true });
  const app = JSON.parse(readFileSync(join(root, 'miniprogram/app.json'), 'utf8'));
  const files = [
    'app.js',
    'app.json',
    'app.wxss',
    'sitemap.json',
    'custom-tab-bar/index.js',
    'custom-tab-bar/index.json',
    'custom-tab-bar/index.wxml',
    'custom-tab-bar/index.wxss',
    // 设计令牌／图标／组件样式层（GY-I26）：app.wxss 通过 @import 引用，
    // 漏加会让隔离工程编译后整站样式丢失。
    'styles/tokens.wxss',
    'styles/icons.wxss',
    'styles/components.wxss',
    'config/runtime.js',
    'utils/debug.js',
    'utils/auth.js',
    'utils/profile-api.js',
    // 定位即时选地区（GY-I05／F02）：仅授权与失败分支，不内置坐标→地区转换资源。
    'utils/location-region.js',
    // 地区转换资源装配（GY-I05 D2）：profile 页 require 它；漏加会导致标准包 MODULE_NOT_FOUND。
    // 地区质心数据（GY-I05 U3／Refs #5）：本仓**不随分发**，所以清单条目由源码树是否存在决定
    // （`regionCentroidManifestEntries`）。存在却没进清单时会静默失效——下方断言把这一条变成硬错误。
    ...regionCentroidManifestEntries({ resourceExists: existsSync(join(root, REGION_CENTROID_SOURCE)) }),
    'utils/region-converter.js',
    'utils/knowledge-api.js',
    'utils/public-home-api.js',
    // 识别域适配层（GY-I09）：识别页依赖它；漏加会导致标准包 MODULE_NOT_FOUND。
    'utils/identify-api.js',
    // 收藏与识别历史适配层（GY-I16）：新页面依赖它们；漏加同样会导致 MODULE_NOT_FOUND。
    'utils/favorites-api.js',
    'utils/history-api.js',
    // 社区域适配层（GY-I15）：社区列表/投稿/详情页依赖它；漏加会导致标准包 MODULE_NOT_FOUND。
    'utils/community-api.js',
    // 消息域适配层（GY-I17）：消息页与底部 Tab 未读角标依赖它；漏加会导致标准包 MODULE_NOT_FOUND。
    'utils/messages-api.js',
    // 播报域适配层（GY-I13）：播报页依赖它们；漏加会导致标准包 MODULE_NOT_FOUND。
    //   audio-playback：播放生命周期控制器（端口注入，纯逻辑）
    //   inner-audio-port：wx.createInnerAudioContext 的唯一出现处
    //   substitute-player：明确标注的替身播放端口（仅本地替身工程走查，不计「已听取」）
    //   speech-text：安全检查闸门与播报计划复核（数字/单位/制剂条件/否定词）
    //   voice-api：POST /speech/synthesis 与 GET /jobs/{id} 的消费层
    //   recorder-port：wx.getRecorderManager 的唯一出现处（GY-I11 语音问答真实录音）
    //   speech-transcript：GY-I11 转写四端点 + 确认/发送消费层（可编辑、确认后发送、取消/失败/迟到不外发）
    'utils/speech-text.js',
    // 自动播报策略（GY-I13）：可关闭的自动播报开关 + 「同一页同一版本只自动播报一次」+ 读不到偏好时不自动，
    // 漏加会导致标准包 MODULE_NOT_FOUND。
    'utils/speech-autoplay.js',
    'utils/audio-playback.js',
    'utils/inner-audio-port.js',
    'utils/substitute-player.js',
    'utils/voice-api.js',
    'utils/recorder-port.js',
    'utils/speech-transcript.js',
    // 文字问答域适配层（GY-I12）：文字提问页依赖它；漏加会导致标准包 MODULE_NOT_FOUND。
    //   qa-api：POST /conversations、POST /conversations/{id}/turns（TextTurnInput）、
    //           GET /jobs/{id}、GET /conversations/{id}/turns 的消费层 + 回答可展示性闸门。
    'utils/qa-api.js',
    // 授权清单读取层（GY-R34 / #29 P1，只读 GET /me/consents）：consent 页依赖它；
    // 漏加会导致标准包 MODULE_NOT_FOUND。（授予/撤回属 P2，届时才需要新的写层，本清单不预置。）
    'utils/consent-api.js',
    // 注销账号适配层（GY-R73 / #19 客户端入口）：deletion 页依赖它。
    //   POST /me/account/deletion（202，Idempotency-Key）、GET /account/deletions/{id}
    //   （回执 bearer，不是登录会话）、DELETE /me/account/deletion（200，Idempotency-Key）。
    // 漏加会让注销页在标准包里 MODULE_NOT_FOUND —— 入口点了就崩，比没有入口更糟。
    'utils/deletion-api.js',
    'assets/knowledge/leaf.png',
    'assets/knowledge/search.png',
    'assets/knowledge/back.png',
    'utils/font-scale.js',
    'utils/system-font.js',
    // 统一状态层（B7 / #28）：components/state-view 与各页状态判定共用；
    // 漏加会让 state-view 在本工程里 MODULE_NOT_FOUND，所有页面的状态块一起失效。
    'utils/states.js',
    // 下面这条逐项清单保留给既有静态断言（tests/unit/miniprogram-voice-playback.test.mjs 等按文本核对它）；
    // 它**不再是完整性的依据**：上方 componentDirectories(...) 已按 usingComponents 派生组件目录并整目录复制，
    // 清单没列到的新组件（如本次缺陷里的 fav-entry）同样会进副本，复制后 assertComponentsCopied(...) 兜底。
    'components/state-view/state-view.js',
    'components/state-view/state-view.json',
    'components/state-view/state-view.wxml',
    'components/state-view/state-view.wxss',
    ...['gy-ui-button', 'gy-ui-card', 'gy-ui-chip', 'gy-ui-search'].flatMap(name =>
      ['.js', '.json', '.wxml', '.wxss'].map(ext => `components/${name}/${name}${ext}`)),
    // GY-I13 统一语音球（播报页依赖；漏加会导致自定义组件解析失败）。
    ...['gy-voice-ball'].flatMap(name =>
      ['.js', '.json', '.wxml', '.wxss'].map(ext => `components/${name}/${name}${ext}`)),
    'utils/navigation.js',
    'utils/page-gate.js',
    // 参考查询域适配层与数据（GY-I07）：随页面一同打包。
    'utils/reference.js',
    'data/crops.js',
    'data/species.js',
    'data/regions.js',
    'data/sources.js',
    'data/records-2026.js',
    'data/seed-herbicides.js',
    'data/seed-weeds.js',
    'data/seed-weed-master.js',
    'data/seed-province-index.js',
    'data/seed-control-timing.js',
    // GY-R92 时间文案（9 个页面与 history-api 都 require 它）：漏加会让副本里 12 处 require 悬空；
    // 页面侧被 try/catch 吞掉、只表现为时间不显示。追加在末尾是有意的：本文件的既有行号被
    // docs/ui-state-inventory.md:352 等锚点引用，插在中间会牵动那些锚点。
    'utils/time-format.js',
  ];
  // 打包清单不是「写下来就算」：先把「源码树有没有地区质心数据」与「清单有没有登记它」对齐，
  // 不一致就当场失败（存在却漏登记 ⇒ 标准包静默 unavailable；登记了却不存在 ⇒ 复制阶段 ENOENT）。
  const regionCentroid = assertRegionCentroidPackaging({
    resourceExists: existsSync(join(root, REGION_CENTROID_SOURCE)),
    manifest: files,
  });
  console.log(regionCentroid.packaged
    ? '地区质心数据：已纳入打包允许清单（' + REGION_CENTROID_SOURCE + '），定位→地区转换会走真实资源。'
    : '地区质心数据：' + REGION_CENTROID_SOURCE + ' 不存在，按设计不打包——本仓不随分发该数据，定位选地区在本仓恒为 unavailable（见 docs/ui-state-inventory.md §8）。');
  const pages = [
    'pages/home/home',
    'pages/identify/identify',
    'pages/knowledge/knowledge',
    'pages/knowledgedetail/knowledgedetail',
    'pages/reference/reference',
    'pages/referencedetail/referencedetail',
    'pages/referenceseed/referenceseed',
    'pages/referenceseeddetail/referenceseeddetail',
    'pages/community/community',
    // GY-I15 社区投稿与详情页（必须与 miniprogram/app.json 的 pages 逐项同序）。
    'pages/communitycreate/communitycreate',
    'pages/communitydetail/communitydetail',
    'pages/messages/messages',
    'pages/profile/profile',
    'pages/login/login',
    // 样式走查页（GY-I26 demo 对齐）：只在本地替身工程可见（runtime.mode === 'local'）
    'pages/specimen/specimen',
    // 收藏与识别历史（GY-I16）：页面清单须与 app.json 的 pages 逐项一致（下方断言）。
    'pages/favorites/favorites',
    'pages/history/history',
    'pages/historydetail/historydetail',
    // 播报页（GY-I13）：页面清单须与 app.json 的 pages 逐项一致（下方断言）。
    'pages/voice/voice',
    // 文字提问页（GY-I12）：页面清单须与 app.json 的 pages 逐项一致（下方断言）。
    'pages/qa/qa',
    // 授权清单页（GY-R34 / #29 P1，只读）：页面清单须与 app.json 的 pages 逐项一致（下方断言）。
    'pages/consent/consent',
    // 注销账号页（GY-R73 / #19 客户端入口）：页面清单须与 app.json 的 pages 逐项一致（下方断言）。
    'pages/deletion/deletion',
  ];
  if (JSON.stringify(app.pages) !== JSON.stringify(pages)) throw new Error('Unexpected page routes; review packaging allowlist.');
  for (const page of pages) {
    for (const suffix of ['.js', '.json', '.wxml']) files.push(page + suffix);
    // 页面样式按需打包（仅参考域页面提供 .wxss，其余页面无样式文件）。
    const pageWxss = join(root, 'miniprogram', page + '.wxss');
    if (existsSync(pageWxss)) files.push(page + '.wxss');
  }
  // 整树复制：清单只说「这些必须在产物里」，不再充当复制计划（清单漏一项＝副本静默缺文件）。
  const copied = copyMiniprogramTree(join(root, 'miniprogram'), join(out, 'miniprogram'));
  const missing = files.filter(file => !copied.has(file));
  if (missing.length) throw new Error('打包清单里的文件没有进副本：' + missing.join('、') + '。请检查 miniprogram/ 是否缺文件；已生成的部分在 ' + out + '。');
  assertComponentsCopied(components, join(out, 'miniprogram'));
  // 只有**生成副本**的 appid 允许覆盖；共享工程两份 project.config.json 全程只读
  // （tests/local-debug.test.mjs 按字节比对原文，覆盖值不可能回流到仓库）。
  if (appIdOverride !== null) config.appid = appIdOverride;
  // 同理，域名校验只在**副本的这份 config 对象**里放松：源 project.config.json 一字未改
  // （上方硬闸门仍要求源 urlCheck === true，改坏源文件会让本脚本直接拒绝生成）。
  // 仅供本机演示/测试号：发布路径（release 副本、CI、提审）必须保持校验开启。
  if (noUrlCheck) config.setting.urlCheck = false;
  writeFileSync(join(out, 'project.config.json'), JSON.stringify(config, null, 2) + '\n');
  // 生成物里的 apiBaseUrl 就是**客户端拼接基址**（客户端以 `runtime.apiBaseUrl + '/auth/…'` 等自行拼接）：
  // 指向真实本地 API 时须含业务前缀（如 http://127.0.0.1:3100/api/v1），诊断替身用 origin 形态即可。
  writeFileSync(join(out, 'miniprogram/config/runtime.js'), 'module.exports = ' + JSON.stringify({ mode: runtime.mode, apiBaseUrl: runtime.apiBaseUrl, devTools: false }) + '\n');
  // 复制清单漏项不能等到开发者工具里才以 MODULE_NOT_FOUND 暴露：成功提示之前先扫一遍相对 require。
  const { assertRequireClosure } = await import('./lib/require-closure.mjs');
  const closure = assertRequireClosure({ copyRoot: out, entries: files });
  console.log('相对 require 闭合：' + closure.scannedFiles + ' 个文件，' + closure.requires + ' 条相对 require，悬空 0 条。');
  console.log(mode.toUpperCase() + ' import root: ' + out);
  console.log(mode === 'local'
    ? 'Local client base (runtime.apiBaseUrl): ' + runtime.apiBaseUrl + ' ; diagnostic stub only; enable the personal domain exception only in this isolated project if needed.'
    : 'Networking disabled, urlCheck=true. This is not a working competition release.');
  // 以下三行是协作者真实登录的判据：AppID 用哪个号、服务端必须配同一个号、测试号入口在哪。
  const appIdInCopy = appIdOverride === null ? sharedAppId : appIdOverride;
  console.log('生成副本 AppID：' + appIdInCopy + (appIdOverride === null
    ? '（来源：共享工程 project.config.json 默认值）'
    : '（来源：--appid 覆盖值；共享工程仍为 ' + sharedAppId + '，未被改写）'));
  console.log('服务端必须同号：WECHAT_APP_ID 必须等于上面这个 AppID，WECHAT_APP_SECRET 必须是同一个号后台生成的密钥；两者不配对时 code2session 必然返回 appid/secret 不匹配类错误，登录一定失败。');
  console.log('测试号申请入口（没有「小程序项目成员」资格也能扫码登录）：' + TEST_ACCOUNT_URL + ' ；该页需在浏览器登录微信公众平台后由前端渲染。');
  if (appIdOverride !== null) console.log('注意：测试号 openid 与正式号不同，服务端身份摘要把 appId 与 openid 一起做 HMAC，故测试号账号/数据与正式环境不互通，不能作为正式验收证据。');
  if (mode === 'local') printNextSteps({ out, apiBaseUrl: runtime.apiBaseUrl, noUrlCheck });
} catch (error) {
  // `--dry-run` 走这里是为了不改 200 行复制逻辑的缩进：它不是失败，正常收尾、退出码 0。
  if (error instanceof DryRunStop) {
    console.log(error.message);
  } else {
    console.error(error.message);
    // `--out` 落在仓库内 → 2（参数错误）；其余失败仍是 1，旧调用方看不出差别。
    process.exitCode = error.exitCode ?? 1;
  }
}
