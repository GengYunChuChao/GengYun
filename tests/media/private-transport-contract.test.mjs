import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const spec = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../../packages/contracts/operations.json', import.meta.url), 'utf8'));
test('private binary operations are discoverable and require session plus header token, never URL token', () => {
  for (const [path, method, id] of [
    ['/media/uploads/{id}/content', 'put', 'receivePrivateMediaBytes'],
    ['/media/{id}/content', 'get', 'readOwnerMediaContent'],
  ]) {
    const op = spec.paths[path][method];
    assert.deepEqual(op.security, [{ userSession: [] }]);
    assert.equal(op.parameters.find(p => p.name === 'X-Media-Access-Token').required, true);
    assert.equal(op.parameters.some(p => p.in === 'query'), false);
    assert.ok(manifest.operations.some(x => x.id === id && x.path === path && x.method === method));
    assert.equal(op.responses['200'].headers['Cache-Control'].schema.const, 'no-store');
    assert.ok(op.responses['200'].headers.ETag);
    assert.ok(op.responses['401'] && op.responses['404']);
  }
});
test('upload bytes remain bounded and versioned; completion stays a separate JSON operation', () => {
  const put = spec.paths['/media/uploads/{id}/content'].put;
  assert.equal(put.parameters.find(p => p.name === 'Content-Length').schema.maximum, 10485760);
  assert.ok(put.parameters.some(p => p.$ref === '#/components/parameters/IfMatch'));
  assert.ok(put.parameters.some(p => p.$ref === '#/components/parameters/IdempotencyKey'));
  for (const schema of Object.values(put.requestBody.content)) assert.equal(schema.schema.format, 'binary');
  const complete = spec.paths['/media/uploads/{id}/complete'].post;
  assert.equal(complete.requestBody.content['application/json'].schema.$ref, '#/components/schemas/UploadCompleteInput');
  assert.equal(put.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/MediaEnvelope');
});
