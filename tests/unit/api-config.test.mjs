import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig, REQUIRED_WHEN_REAL } from '../../services/api/src/config.ts';

test('缺少 APP_EXECUTION_MODE 时明确失败并给出字段名', () => {
  assert.throws(
    () => loadConfig({}),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.deepEqual(
        error.issues.map((i) => i.field),
        ['APP_EXECUTION_MODE'],
      );
      assert.match(error.message, /APP_EXECUTION_MODE/);
      return true;
    },
  );
});

test('APP_EXECUTION_MODE 非法时报告 INVALID_VALUE', () => {
  assert.throws(
    () => loadConfig({ APP_EXECUTION_MODE: 'production' }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.issues[0].field, 'APP_EXECUTION_MODE');
      assert.equal(error.issues[0].code, 'INVALID_VALUE');
      return true;
    },
  );
});

test('stub 模式只需 APP_EXECUTION_MODE，其余走安全默认值', () => {
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub' });
  assert.equal(config.executionMode, 'stub');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.equal(config.logLevel, 'info');
  assert.equal(config.databaseUrl, null);
  assert.equal(config.requiresRealCredentials, false);
});

test('real 模式缺配置时一次性列出全部字段，且不静默启动', () => {
  assert.throws(
    () => loadConfig({ APP_EXECUTION_MODE: 'real' }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      const fields = error.issues.map((i) => i.field).sort();
      assert.deepEqual(fields, [...REQUIRED_WHEN_REAL].sort());
      return true;
    },
  );
});

test('real 模式配置齐备时通过', () => {
  const env = {
    APP_EXECUTION_MODE: 'real',
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/gengyun',
    SESSION_SIGNING_KEY: 'x'.repeat(32),
    DELETION_LEDGER_KEY: 'y'.repeat(32),
    WECHAT_APP_ID: 'wx0000000000000000',
    WECHAT_APP_SECRET: 'secret',
    OBJECT_STORAGE_ENDPOINT: 'https://oss.example.invalid',
    OBJECT_STORAGE_BUCKET: 'gengyun',
    OBJECT_STORAGE_ACCESS_KEY: 'ak',
    OBJECT_STORAGE_SECRET_KEY: 'sk',
  };
  const config = loadConfig(env);
  assert.equal(config.executionMode, 'real');
  assert.equal(config.requiresRealCredentials, true);
  assert.equal(config.databaseUrl, env.DATABASE_URL);
});

test('非 postgres 连接串与非法端口被拒绝', () => {
  assert.throws(
    () => loadConfig({ APP_EXECUTION_MODE: 'stub', DATABASE_URL: 'mysql://u:p@h/db' }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.issues[0].field, 'DATABASE_URL');
      assert.equal(error.issues[0].code, 'INVALID_VALUE');
      return true;
    },
  );
  assert.throws(
    () => loadConfig({ APP_EXECUTION_MODE: 'stub', API_PORT: '70000' }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.issues[0].field, 'API_PORT');
      return true;
    },
  );
});

test('替身模式不暴露微信凭据（未配置即为 null，不用默认值顶替）', () => {
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub' });
  assert.equal(config.wechatAppId, null);
  assert.equal(config.wechatAppSecret, null);
  assert.equal(config.sessionSigningKey, null);
  assert.equal(config.adminBootstrap, null);
});

test('初始管理员配置：要么都不设、要么同时设；口令至少 12 字符', () => {
  const base = { APP_EXECUTION_MODE: 'stub' };
  assert.equal(loadConfig(base).adminBootstrap, null);

  assert.throws(
    () => loadConfig({ ...base, ADMIN_BOOTSTRAP_PASSWORD: 'x'.repeat(12) }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.issues[0].field, 'ADMIN_BOOTSTRAP_LOGIN_NAME');
      assert.equal(error.issues[0].code, 'MISSING');
      return true;
    },
  );
  assert.throws(
    () => loadConfig({ ...base, ADMIN_BOOTSTRAP_LOGIN_NAME: 'root' }),
    (error) => {
      assert.equal(error.issues[0].field, 'ADMIN_BOOTSTRAP_PASSWORD');
      assert.equal(error.issues[0].code, 'MISSING');
      return true;
    },
  );
  assert.throws(
    () => loadConfig({ ...base, ADMIN_BOOTSTRAP_LOGIN_NAME: 'root', ADMIN_BOOTSTRAP_PASSWORD: 'short' }),
    (error) => {
      assert.equal(error.issues[0].field, 'ADMIN_BOOTSTRAP_PASSWORD');
      assert.equal(error.issues[0].code, 'INVALID_VALUE');
      return true;
    },
  );

  const ok = loadConfig({ ...base, ADMIN_BOOTSTRAP_LOGIN_NAME: 'root', ADMIN_BOOTSTRAP_PASSWORD: 'bootstrap-pass-123' });
  assert.deepEqual(ok.adminBootstrap, { loginName: 'root', password: 'bootstrap-pass-123' });
});
