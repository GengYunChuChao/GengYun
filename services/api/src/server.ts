/**
 * API 进程入口。
 * 配置不合法立即失败并打印字段名；不启动半配置服务。
 */
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('启动失败：配置校验未通过。');
      for (const issue of error.issues) {
        console.error(`  - ${issue.field} [${issue.code}] ${issue.reason}`);
      }
      console.error('参考 .env.example；真实密钥只放在服务端安全配置，不提交仓库。');
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const pool = createPool(config.databaseUrl);
  const app = buildApp({ config, pool });

  // 管理员初始化：仅在后台账号表为空且配置了 bootstrap 凭据时创建；失败不静默。
  try {
    const bootstrap = await app.authService.ensureBootstrapAdmin();
    if (bootstrap.created) {
      app.log.info({ login_name: bootstrap.loginName }, '已创建初始管理员（口令只以 scrypt 摘要入库）');
    } else if (bootstrap.reason === 'already_initialized') {
      app.log.info('后台已完成初始化，跳过初始管理员创建');
    }
  } catch (error) {
    app.log.error({ err: error }, '初始管理员创建失败（服务继续启动；请检查数据库与迁移 0008）');
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
    } finally {
      if (pool !== null) await pool.end();
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { execution_mode: config.executionMode, database_configured: config.databaseUrl !== null },
    'gengyun api 已启动（已装配认证与后台认证路由；其余业务路由未实现）',
  );
}

main().catch((error: unknown) => {
  console.error('API 启动失败：', error);
  process.exitCode = 1;
});
