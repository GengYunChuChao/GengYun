/**
 * GY-I18 阶段 2 · 钉子：**`families.ts` 的 `path` 与 `routes/admin.ts` 的字面注册路径必须一致**。
 *
 * 为什么需要这条钉子（预审 P2）：
 * 本片为了满足项目静态路由清单工具（`tools/contract-status-core.mjs` 只原生支持
 * `${API_PREFIX}` / `${kind}` 模板）把 24 条家族路由**内联成字面路径**之后，路径有了
 * **两处来源**：① `services/api/src/admin/families.ts` 的 `descriptor.path`
 * （**服务层仍用它构造幂等键域**，见 `admin/service.ts` 的 `runIdempotentWrite`）；
 * ② `routes/admin.ts` 里写死的字面模板。
 * 若将来只改 ① 而不改 ②，会**静默把幂等键域换掉、而路由一字不动** —— 表现为
 * "同键同体的重放不再收敛到同一结果"，且**没有任何现有用例会红**。这条钉子把两者钉死。
 *
 * 与 #10/#106 的钉子同一口径：层级/来源之间不许悄悄换位。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { API_PREFIX } from '../../services/api/src/contract.ts';
import { FAMILIES } from '../../services/api/src/admin/families.ts';

const ROUTE_SOURCE = readFileSync(new URL('../../services/api/src/routes/admin.ts', import.meta.url), 'utf8');

/** 六个操作相对家族前缀的路径后缀与 HTTP 方法（与契约一致）。 */
const SIX = [
  { op: 'list', method: 'GET', suffix: '' },
  { op: 'create', method: 'POST', suffix: '' },
  { op: 'get', method: 'GET', suffix: '/:id' },
  { op: 'edit', method: 'PATCH', suffix: '/:id' },
  { op: 'publish', method: 'POST', suffix: '/:id/publish' },
  { op: 'withdraw', method: 'POST', suffix: '/:id/withdraw' },
];

test('钉子：FAMILIES 的 path 必须与 routes/admin.ts 的字面注册路径一致（防只改 families.ts:path ⇒ 静默换掉幂等键域而不改路由）', () => {
  // (a) 结构：注册点总数恰好 44（34 条 + R29-S5 的 GET /admin/flag-audit-events + R34 的 GET /admin/audit-logs
  //     + R37 `#18` S2 读面的 GET /admin/administrators 与 GET /admin/administrators/:id/scopes
  //     + R59 后台帖子读面的 GET /admin/posts 与 GET /admin/posts/:id
  //     + S3 人工审核的 POST /admin/posts/:id/approve 与 POST /admin/posts/:id/reject
  //     + `#18` S2 PR-3 的 POST /admin/administrators/:id/scopes 与 DELETE /admin/administrators/:id/scopes/:scope），
  //     且字面模板覆盖四个家族前缀的六种形态。
  //     六个新增的只读/写面都**不属**四家族（不是 list/create/get/edit/publish/withdraw 之一），
  //     故它们只增加注册点总数，不进下面的六形态字面模板核对。
  const registrations = ROUTE_SOURCE.match(/^\s*app\.(get|post|put|patch|delete)\(/gm) ?? [];
  assert.equal(registrations.length, 44, 'routes/admin.ts 的注册点必须恰好 44 处（#621 帖子读面 2 处 + S3 通过/驳回 2 处 + #18 S2 PR-3 授予/撤销 2 处）');

  for (const descriptor of FAMILIES) {
    for (const { suffix } of SIX) {
      const literal = '`${API_PREFIX}' + descriptor.path + suffix + '`';
      assert.ok(
        ROUTE_SOURCE.includes(literal),
        `routes/admin.ts 里必须**字面**出现 ${literal}（来自 families.ts 的 path=${descriptor.path}）；` +
          '若这里失败，说明 families.ts 的 path 与其字面注册已漂移 —— 幂等键域会被静默换掉',
      );
    }
  }
});

test('钉子：四个家族的 path 互不相同、且都以 /admin/ 开头（防复制粘贴导致两家族串用同一路径）', () => {
  const paths = FAMILIES.map((descriptor) => descriptor.path);
  assert.equal(new Set(paths).size, paths.length, `家族 path 必须互不相同：${paths.join(', ')}`);
  for (const path of paths) assert.ok(path.startsWith('/admin/'), `家族 path 必须以 /admin/ 开头：${path}`);
});

test('钉子：descriptor.path 与契约注册的路由一致（运行时 hasRoute 逐一核对，六种形态 × 四家族）', async () => {
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
  });
  try {
    for (const descriptor of FAMILIES) {
      for (const { method, suffix } of SIX) {
        const url = `${API_PREFIX}${descriptor.path}${suffix}`;
        assert.equal(
          app.hasRoute({ method, url }),
          true,
          `families.ts 的 path=${descriptor.path} 必须在 ${method} ${url} 上真实注册`,
        );
      }
    }
  } finally {
    await app.close();
  }
});
