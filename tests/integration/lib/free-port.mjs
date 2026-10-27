// 共用挑端口工具：让**内核**分配一个「当前空闲」的端口，而不是在固定基址上 `randomInt`。
//
// 为什么必须换掉「常量基址 + randomInt」：Linux 的默认 ephemeral 区间是 **32768–60999**
// （`/proc/sys/net/ipv4/ip_local_port_range`），任何一条出站连接的源端口都可能临时占住它；
// 于是 `55500 + randomInt(0, 500)`／`55600 + randomInt(0, 300)` 这类挑法会在 CI 上偶发
// `pg_ctl start` 失败：
//   could not bind IPv4 address "127.0.0.1": Address already in use
//   HINT:  Is another postmaster already running on port 55916?
//   FATAL:  could not create any TCP/IP sockets
// （GY-R68 事故现场：`real-pg-17.11` job 的「备份副本域」step 首跑即红。）换一个 `attempt`
// 重跑就好了——那是运气，不是修好。真正的判据是「这个端口此刻有没有人占」，只有内核知道。
//
// 做法：`listen(0)` 让内核从**它自己**的临时区间里挑一个此刻空闲的端口，读回
// `server.address().port` 再 `close()`。这样拿到的端口不在「我们自己猜的固定区间」里，
// 也就不存在与出站连接抢端口的系统性问题。
//
// ⚠ **本工具不消除 TOCTOU**：`close()` 到调用方真正 `pg_ctl start` 之间有一段窗口，别人可以在这几
// 毫秒里抢走同一个端口。重试（`FREE_PORT_MAX_ATTEMPTS`）**只覆盖「探测本身失败」**——`listen` 报错、
// 内核回了个非法端口值；`port: 0` 的探测几乎不会失败，所以它实质是防御性的，不是窗口的解。
// 窗口输了的后果是 `pg_ctl` 报 `could not bind IPv4 address "127.0.0.1"`，处理方式**由调用方决定**：
//   · 有换端口兜底的只有 3 个臂 —— `admin-audit-logs-pg.mjs`（`start.status !== 0` 换候选）、
//     `admin-scopes-authority-pg.mjs`（读 server.log 的 `could not bind`）、`retention-purge-pg.mjs`
//     （读 `could not bind` 后 `takenPorts.add(port)` 换端口，不重跑 initdb）；
//   · 其余 11 个臂是**单次尝试、fail-loud**：拿不到端口就整臂红，语义是「红给你看」，不是「换一个再来」。
// 这是既存行为（改造前同样如此），本片没有新增也没有声称已兜住。
//
// 8 次全失败说明内核连着 8 次都没能给出一个可绑的回环端口（端口资源真枯竭/权限异常），如实抛错，
// ⛔ 不静默返回一个没验证过的端口。
//
// 环境变量覆盖的能力**保持在调用方**：真库臂原有的 `GY_PG_PORT` / `GY_I19_PG_PORT` 这类键
// 仍然是「env 优先，没有才向内核要」，因为那些键还各自带着自己的取值校验与错误文案
// （例如「已被占用（拒绝换口）」）。本工具只负责「没有 env 时，端口从哪来」。
//
// 纯 Node 内置模块、零第三方依赖。
import { createServer } from 'node:net';

/**
 * 上限重试次数：**只覆盖「探测本身失败」**（`listen` 报错、内核回非法端口），
 * 对「探测 → 调用方真正绑定」之间的竞争窗口**零覆盖**（那个窗口只能由调用方的换端口重试或 fail-loud 处理）。
 */
export const FREE_PORT_MAX_ATTEMPTS = 8;

/**
 * 探测一次：内核分配端口 → 读回 → 关闭。
 *
 * 只探 `127.0.0.1`：本仓所有真库臂都只监听回环（`-c listen_addresses=127.0.0.1`），
 * 探 0.0.0.0 会连带要求别处的绑定也让路，与集群实际用法不符。
 */
function probeOnce(host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    // `exclusive: true`：⛔ 不要 `SO_REUSEADDR` 的「绑定别人已监听的地址」语义——
    // Windows 上它会让「listen 成功」不能证明端口空闲（本仓 admin-audit-logs 臂踩过 WSAEACCES）。
    server.once('error', reject);
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
          reject(new Error(`内核返回的端口不可用：${JSON.stringify(address)}`));
          return;
        }
        resolve(port);
      });
    });
  });
}

/**
 * 让内核分配一个当前空闲的回环端口。
 *
 * @param {{ host?: string, attempts?: number }} [options]
 * @returns {Promise<number>} 1..65535 的整数端口号（`close()` 之后返回）
 * @throws 连续 `attempts` 次探测都失败时抛错（含最后一次的原始错误原因）
 */
export async function pickFreePort({ host = '127.0.0.1', attempts = FREE_PORT_MAX_ATTEMPTS } = {}) {
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new Error(`pickFreePort 的 attempts 必须是正整数（收到 ${String(attempts)}）`);
  }
  let lastError = null;
  for (let index = 1; index <= attempts; index += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await probeOnce(host);
    } catch (error) {
      lastError = error;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`连续 ${attempts} 次都没能从内核拿到空闲端口（最后一次：${reason}）`);
}
