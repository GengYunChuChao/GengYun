// Two fixed read-only model-list queries; no inference or quota/permission changes.
import { pathToFileURL } from 'node:url';
import { loadPrivateEnvironment } from './ai-config.mjs';
const ENDPOINT = 'https://tokenhub.tencentmaas.com/v1/models';
async function listModels(key, fetchImpl) {
  try {
    const response = await fetchImpl(ENDPOINT, { method: 'GET', headers: { Authorization: 'Bearer ' + key }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (!response.ok) return { httpStatus: response.status, state: [401, 403].includes(response.status) ? 'ACCESS_REJECTED' : 'HTTP_ERROR' };
    const data = await response.json();
    if (!Array.isArray(data?.data) || !data.data.every(item => typeof item?.id === 'string')) return { httpStatus: response.status, state: 'SCHEMA_ERROR' };
    return { httpStatus: response.status, state: 'MODEL_LIST_AUTHENTICATED', modelCount: data.data.length, selectedVisionModelListed: data.data.some(item => item.id === 'hy-vision-2.0-instruct') };
  } catch (_) { return { state: 'NETWORK_OR_RESPONSE_ERROR' }; }
}
export async function verifyTokenHub({ key, fetchImpl = globalThis.fetch } = {}) {
  const report = { scope: 'read_only_model_list', inferenceRequests: 0, capabilityVerified: false, quotaVerified: false, taskVerified: false };
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(key)) return { ...report, authentication: { state: 'MISSING_OR_INVALID_KEY' } };
  report.authentication = await listModels(key, fetchImpl);
  report.controlledBadKey = await listModels('synthetic-invalid-api-key', fetchImpl);
  return report;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--credentials') throw new Error('usage');
  const env = loadPrivateEnvironment(args[1]);
  const report = await verifyTokenHub({ key: env.TOKENHUB_API_KEY });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.authentication.state === 'MODEL_LIST_AUTHENTICATED' && report.controlledBadKey?.state === 'ACCESS_REJECTED' ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('TokenHub check failed; private input and exception suppressed.'); process.exitCode = 1; });
