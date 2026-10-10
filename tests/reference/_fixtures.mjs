// GY-I07 测试公共夹具：装载域库服务与小程序侧适配层，供多份测试复用。
//
// 说明：域库 packages/reference 为纯 ESM；小程序侧 utils/reference.js 为 CommonJS
// （微信小程序运行时）。这里用 createRequire 载入小程序适配层，验证两侧口径一致。

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const miniReference = require(
  fileURLToPath(new URL('../../miniprogram/utils/reference.js', import.meta.url)),
);

export async function loadService(executionMode = 'stub') {
  const mod = await import('../../packages/reference/service.mjs');
  return mod.createReferenceService({ executionMode });
}

export async function loadDomain() {
  return import('../../packages/reference/index.mjs');
}
