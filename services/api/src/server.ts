/**
 * API 进程入口。
 * 配置不合法立即失败并打印字段名；不启动半配置服务。
 */
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { MediaRealWiringError, mediaRealPortsAssemblyOptions, resolveMediaRealPorts } from './media/real-ports.ts';

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

  // 媒体域真实端口接线（GY-R28 · W2）：本题**唯一**的接线决定点。
  //
  // - 没有 `--approve-real-media-wiring` ⇒ `resolveMediaRealPorts` 返回 `null` ⇒ **不传**任何媒体
  //   选项 ⇒ `buildApp` 走既有 fail-closed（整域 503 `PROVIDER_UNAVAILABLE`），与 main 逐字节一致；
  // - 有该参数 ⇒ 前置校验（real 模式 / 四键配置齐备 / 访问网关原点可部署）后，**在此铸造**批准能力
  //   并构造 S3 兼容端口。铸造点只此一处（`approveRealMediaWiring` 的唯一调用点在
  //   `media/real-ports.ts` 的 `resolveMediaRealPorts` 内，且由本参数驱动）。
  // - 任何拒绝都是**启动失败**：不接受「半接线」上线。
  let mediaAssembly: ReturnType<typeof mediaRealPortsAssemblyOptions> | null = null;
  try {
    const mediaRealPorts = resolveMediaRealPorts({ config, argv: process.argv.slice(2) });
    if (mediaRealPorts !== null) mediaAssembly = mediaRealPortsAssemblyOptions(mediaRealPorts);
  } catch (error) {
    if (error instanceof MediaRealWiringError) {
      console.error('启动失败：媒体域真实接线被拒绝（拒绝原因闭集见 media/real-ports.ts）。');
      console.error(`  - [${error.refusal} → ${error.errorCode}, retryable=${String(error.retryable)}] ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const app = buildApp({ config, pool, ...(mediaAssembly ?? {}) });

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
    'gengyun api 已启动（认证、后台认证与各业务域路由均已注册；各域真实后端未接线者按域 fail-closed，不以替身数据返回成功）',
  );
}

main().catch((error: unknown) => {
  console.error('API 启动失败：', error);
  process.exitCode = 1;
});
