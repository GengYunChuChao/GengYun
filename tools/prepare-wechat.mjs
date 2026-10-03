import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalConfig, configArgument } from './local-debug-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const [mode, ...args] = process.argv.slice(2);
  if (!['local', 'release'].includes(mode)) throw new Error('Usage: node tools/prepare-wechat.mjs local --config <file> | release');
  const runtime = mode === 'local' ? readLocalConfig(configArgument(args)) : { mode: 'disabled', apiBaseUrl: '' };
  if (mode === 'release' && args.length) throw new Error('Release does not accept a local configuration.');
  const config = JSON.parse(readFileSync(join(root, 'project.config.json'), 'utf8'));
  if (config.compileType !== 'miniprogram' || config.miniprogramRoot !== 'miniprogram/' || config.setting.urlCheck !== true) throw new Error('Shared project must use native miniprogram and domain validation.');
  const sharedRuntime = readFileSync(join(root, 'miniprogram/config/runtime.js'), 'utf8').replace(/\r\n/g, '\n');
  if (sharedRuntime !== "// Shared source always has networking disabled. Local preparation writes only an ignored copy.\nmodule.exports = { mode: 'disabled', apiBaseUrl: '' }\n") throw new Error('Shared runtime changed. Refuse to package a possible local/stub configuration.');
  const out = join(root, '.local', 'wechat-' + mode);
  // Refuse reuse so personal overrides or stale generated files cannot survive preparation.
  if (existsSync(out)) throw new Error('Output already exists: ' + out + '. Keep it for inspection or remove that exact generated directory before preparing again.');
  mkdirSync(out, { recursive: true });
  const app = JSON.parse(readFileSync(join(root, 'miniprogram/app.json'), 'utf8'));
  const files = ['app.js', 'app.json', 'app.wxss', 'sitemap.json', 'config/runtime.js', 'utils/debug.js'];
  const pages = ['pages/home/home', 'pages/identify/identify', 'pages/community/community', 'pages/messages/messages', 'pages/profile/profile'];
  if (JSON.stringify(app.pages) !== JSON.stringify(pages)) throw new Error('Unexpected page routes; review packaging allowlist.');
  for (const page of pages) for (const suffix of ['.js', '.json', '.wxml']) files.push(page + suffix);
  for (const file of files) {
    const target = join(out, 'miniprogram', file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, 'miniprogram', file), target);
  }
  writeFileSync(join(out, 'project.config.json'), JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(out, 'miniprogram/config/runtime.js'), 'module.exports = ' + JSON.stringify({ mode: runtime.mode, apiBaseUrl: runtime.apiBaseUrl }) + '\n');
  console.log(mode.toUpperCase() + ' import root: ' + out);
  console.log(mode === 'local' ? 'Diagnostic stub only; enable personal domain exception only in this isolated project if needed.' : 'Networking disabled, urlCheck=true. This is not a working competition release.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
