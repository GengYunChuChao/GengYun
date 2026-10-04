#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditAIConfiguration, loadPrivateEnvironment } from './ai-config.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--credentials') {
  console.error('Usage: node tools/prepare-ai-verification.mjs --credentials <explicit private file>; zero network, no execution option.');
  process.exitCode = 1;
} else {
  try {
    const config = JSON.parse(readFileSync(resolve(root, 'docs/verification/config.local.json'), 'utf8'));
    const env = loadPrivateEnvironment(args[1], process.env);
    const report = auditAIConfiguration(config, env);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.budgetLocked && Object.values(report.endpoints).every(x => x.parameterConfigurationComplete && x.credentialPresent) ? 0 : 1;
  } catch (_) { console.error('AI preparation input unavailable or invalid; file contents and exception suppressed.'); process.exitCode = 1; }
}
