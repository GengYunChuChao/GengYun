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
    'gengyun api 骨架已启动（业务路由未实现）',
  );
}

main().catch((error: unknown) => {
  console.error('API 启动失败：', error);
  process.exitCode = 1;
});
