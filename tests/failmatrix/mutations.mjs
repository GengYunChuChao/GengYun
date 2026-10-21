/**
 * GY-I22（#22）失败回归矩阵 · 负控制清单。
 *
 * 每条负控制 = **一处真实的一行/一小段改动**（把某个守卫放宽或删掉）+ 一组「必须因此变红」的
 * 用例（`watch`）。执行器 `tools/i22-failmatrix-negative-control.mjs` 会：
 *   1) 记下文件 sha256 → 2) 改 → 3) 跑 watch 用例（**必须全红**）→ 4) 用原始字节恢复
 *   → 5) 复核 sha256 与改前**逐字节一致** → 6) 再跑一次 watch 用例（**必须全绿**）。
 *
 * 为什么 `watch` 这么挑：
 * - 只挑**这一处改动一定会让结论翻转**的用例。同一族里有些用例变红需要同时改两处
 *   （例如收藏/历史/消息的 IDOR 删除：service 层判属主之后，内存 store 的 `remove()` 又按
 *   `owner_id` 复核一次，只删 service 一行仍会被 store 挡成同一个 404）→ 这类用例的负控制
 *   改用**列表隔离**（store 的 `list*` 过滤那一行）与**媒体归属**（`ownedRecord` 那一行）代表。
 * - watch 里不放会互相污染状态的用例（例如「删别人的媒体」真删成功后，后续「申请访问」会退回
 *   404 = 期望值，反而绿）。
 *
 * `find` 必须**在文件里恰好出现一次**（执行器会数），且逐字照抄仓库里的字节（含中文注释）。
 */
export const MUTATIONS = [
  {
    id: 'NC-01',
    title: '放宽「无凭据」守卫：SESSION_REQUIRED → SESSION_EXPIRED',
    file: 'services/api/src/auth/middleware.ts',
    find: "    throw new ApiError('SESSION_REQUIRED', `需要${what}会话`);",
    replace: "    throw new ApiError('SESSION_EXPIRED', `需要${what}会话`); // 负控制：把「没凭据」放宽成「会话过期」",
    watch: ['C1-01', 'C1-02', 'C1-09', 'C1-16', 'C1-27', 'C1-35', 'C4-07', 'C4-08'],
  },
  {
    id: 'NC-02',
    title: '放宽「会话已撤销」：注销过的会话照样算活着',
    file: 'services/api/src/auth/middleware.ts',
    find: '  if (session.revokedAt !== null) return null;',
    replace: '  if (session.revokedAt !== null) return session; // 负控制：注销不再作废会话',
    watch: ['C4-03', 'C4-04'],
  },
  {
    id: 'NC-03',
    title: '放宽「会话已过期」：过期会话照样算活着',
    file: 'services/api/src/auth/middleware.ts',
    find: '  if (session.expiresAt.getTime() <= context.now().getTime()) return null;',
    replace: '  if (session.expiresAt.getTime() <= context.now().getTime()) return session; // 负控制：过期不再失效',
    watch: ['C4-05'],
  },
  {
    id: 'NC-04',
    title: '删掉「账号 epoch 变更」校验：旧会话不被踢',
    file: 'services/api/src/auth/middleware.ts',
    find: "    throw new ApiError('ACCOUNT_INACTIVE', '会话已因账号变更失效');",
    replace: '    // 负控制：账号 epoch 变更不再失效旧会话（throw 被移除）',
    watch: ['C4-06'],
  },
  {
    id: 'NC-05',
    title: '删掉「后台接口不接受用户会话」：普通用户会话可以进后台',
    file: 'services/api/src/auth/middleware.ts',
    find: "      throw new ApiError('SCOPE_DENIED', '后台接口不接受用户会话');",
    replace: '      // 负控制：后台接口不再拒绝用户会话（throw 被移除）',
    watch: ['C3-01', 'C3-02', 'C3-07'],
  },
  {
    id: 'NC-06',
    title: '删掉路由层 scope 校验：任何后台会话都能进「只看 middleware 那一层」的后台路由',
    file: 'services/api/src/auth/middleware.ts',
    find: "  if (!scopes.includes(scope)) {\n    throw new ApiError('SCOPE_DENIED', `缺少所需权限：${scope}`);\n  }",
    replace: '  // 负控制：路由层 scope 校验被移除（任何后台会话都算有权限）',
    // 只有**服务层不再自校验**的后台路由会因此放行（实测：后台登出）。
    // 其余后台路由由 `admin/identity.ts` 的 requireAdminScope 再判一次 → 见 NC-06b。
    watch: ['C3-12'],
  },
  {
    id: 'NC-06b',
    title: '删掉后台 scope 的双层校验（路由层 + 服务层各一行）：缺权限会话可以读后台',
    // 实测发现：后台 scope 是**两层**校验 —— `routes/admin.ts` 注册的 `guards.requireScope(...)`
    // （middleware.ts）与 `admin/identity.ts:49 requireAdminScope`（服务层 `adminActor` 再判一次）。
    // 单独去掉任一层，缺权限会话仍被另一层挡成 403（NC-06 / 前一轮 NC-06b 都因此判 FAIL），
    // 所以这条负控制必须两层同时放宽——每层仍然是「删掉一行 throw」。
    edits: [
      {
        file: 'services/api/src/auth/middleware.ts',
        find: "  if (!scopes.includes(scope)) {\n    throw new ApiError('SCOPE_DENIED', `缺少所需权限：${scope}`);\n  }",
        replace: '  // 负控制：路由层 scope 校验被移除（任何后台会话都算有权限）',
      },
      {
        file: 'services/api/src/admin/identity.ts',
        find: "  if (!scopes.includes(scope)) {\n    throw new ApiError('SCOPE_DENIED', `缺少所需权限：${scope}`);\n  }",
        replace:
          "  if (scopes.includes(`${scope}:i22-negative-control`)) {\n    throw new ApiError('SCOPE_DENIED', `缺少所需权限：${scope}`);\n  } // 负控制：服务层 scope 校验实质被关掉",
      },
    ],
    watch: ['C3-09', 'C3-10', 'C3-11', 'C3-13'],
  },
  {
    id: 'NC-07',
    title: '删掉注销/注销申请路由的幂等键校验：缺键不再 400',
    file: 'services/api/src/routes/support.ts',
    find:
      "  const rawKey = request.headers['idempotency-key'];\n  const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;\n  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 128) {\n    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', '缺少或非法的 Idempotency-Key 头（8..128 字符）');\n  }",
    replace:
      "  const rawKey = request.headers['idempotency-key'];\n  // 负控制：缺/非法键不再拒绝，改用固定合成键继续（等价于「没有幂等门」）。\n  const key = typeof rawKey === 'string' && rawKey.length > 0 ? rawKey : 'i22-negative-control-key';",
    // 收藏面另有一道自己的键校验（favorites/validate.ts 的 requireIdempotencyKey）→ 见 NC-07b。
    watch: ['C4-01', 'C4-11'],
  },
  {
    id: 'NC-07b',
    title: '删掉收藏面的幂等键校验（favorites/validate.ts）：缺键写收藏不再 400',
    file: 'services/api/src/favorites/validate.ts',
    find:
      "  if (typeof value !== 'string' || value.length < IDEMPOTENCY_KEY_MIN || value.length > IDEMPOTENCY_KEY_MAX) {\n    throw new ApiError(\n      'IDEMPOTENCY_KEY_REQUIRED',\n      `需要 ${IDEMPOTENCY_KEY_MIN}..${IDEMPOTENCY_KEY_MAX} 字符的 Idempotency-Key`,\n    );\n  }",
    replace:
      "  if (typeof value !== 'string') {\n    return 'i22-negative-control-key'; // 负控制：缺键不再拒绝，改用固定合成键\n  }",
    watch: ['C6-04'],
  },
  {
    id: 'NC-08',
    title: '放宽注销回执绑定：回执可以用在别人的注销单 id 上',
    file: 'services/api/src/routes/account-deletion.ts',
    find:
      "      if (boundId === null || boundId !== id) throw new ApiError('SESSION_EXPIRED', '注销回执凭据已失效');",
    replace:
      "      if (boundId === null) throw new ApiError('SESSION_EXPIRED', '注销回执凭据已失效'); // 负控制：回执不再绑定注销单 id",
    watch: ['C4-14'],
  },
  {
    id: 'NC-09',
    title: '删掉媒体归属校验：能读/删别人的媒体元数据',
    file: 'services/api/src/media/service.ts',
    find: '    if (record === undefined || record.ownerId !== actor.ownerId) {',
    replace: '    if (record === undefined) { // 负控制：跨主体媒体也放行',
    watch: ['C2-01', 'C2-02'],
  },
  {
    id: 'NC-10',
    title: '删掉收藏列表的属主过滤：A 的列表会列出 B 的收藏',
    file: 'services/api/src/favorites/store.ts',
    find: '        .filter((record) => record.owner_id === ownerId)\n        .map((record) => freezeDeep(cloneDeep(record)));',
    replace: '        .map((record) => freezeDeep(cloneDeep(record))); // 负控制：列表不再按属主过滤',
    watch: ['C2-22'],
  },
  {
    id: 'NC-11',
    title: '删掉历史列表的属主过滤：A 的列表会列出 B 的历史',
    file: 'services/api/src/history/store.ts',
    find: '        .filter((record) => record.owner_id === ownerId)\n        .map((record) => freezeDeep(cloneDeep(record)));',
    replace: '        .map((record) => freezeDeep(cloneDeep(record))); // 负控制：列表不再按属主过滤',
    watch: ['C2-23'],
  },
  {
    id: 'NC-12',
    title: '删掉消息列表的属主过滤：A 的列表会列出 B 的消息',
    file: 'services/api/src/messages/store.ts',
    find: '      return [...messages.values()].filter((record) => record.owner_id === ownerId).map(cloneDeep);',
    replace: '      return [...messages.values()].map(cloneDeep); // 负控制：列表不再按属主过滤',
    watch: ['C2-24'],
  },
];
