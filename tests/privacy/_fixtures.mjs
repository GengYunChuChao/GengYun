/**
 * GY-I27 测试夹具（非测试文件，不参与 node --test 发现）。
 * 提供合成账号提供者与接收方存储，供单元测试注入。
 */

/**
 * 合成账号提供者：{ userId: { state, authEpoch } }。
 * 不依赖微信真实登录，可模拟注销（state 变化 / auth_epoch 递增）。
 */
export function createAccountProvider(initial = {}) {
  const accounts = new Map(Object.entries(initial));
  function set(userId, patch) {
    const cur = accounts.get(userId) ?? { state: 'active', authEpoch: 1 };
    accounts.set(userId, { ...cur, ...patch });
  }
  return {
    set,
    async stateOf(userId) {
      return accounts.get(userId)?.state ?? 'active';
    },
    async authEpochOf(userId) {
      return accounts.get(userId)?.authEpoch ?? 1;
    },
  };
}

/**
 * 合成接收方存储。
 */
export function createRecipientStore(initial = {}) {
  const recipients = new Map(Object.entries(initial));
  return {
    set(id, patch) {
      const cur = recipients.get(id) ?? {
        id,
        display_name: id,
        capability: 'llm',
        policy_version: '1.0.0',
        retention_online_days: 7,
        retention_backup_days: 30,
        no_training_verified: true,
        deletion_verified: true,
        enabled: true,
        config_version: '1.0.0',
      };
      recipients.set(id, { ...cur, ...patch });
    },
    async get(id) {
      return recipients.has(id) ? { ...recipients.get(id) } : null;
    },
  };
}

/** 一个已验证、禁止擅自训练、可删除、已启用的接收方。 */
export const VERIFIED_RECIPIENT = {
  id: 'provider-llm',
  display_name: 'LLM Provider',
  capability: 'llm',
  policy_version: '1.0.0',
  retention_online_days: 7,
  retention_backup_days: 30,
  no_training_verified: true,
  deletion_verified: true,
  enabled: true,
  config_version: '1.0.0',
};
