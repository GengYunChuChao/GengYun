/**
 * 合成域 · 真实产物存储接线的**生产入口派生**（GY-R68 · 装配漏项修补）。
 *
 * 上游断点（本轮复核的代码事实，不是推测）：合成产物端口 `synthesisMediaWiring` **只认显式注入**
 * （`tts/media.ts` 的 `SynthesisMediaPortOptions`：批准能力 + `s3_compatible` 端口，两项都没有默认值、
 * 也不从 env 折算）；`app.ts` 按边界要求**只转发、绝不铸造**（`tts/media.ts` 的 JSDoc：装配层自行铸造
 * 等于自我批准）。而生产入口 `server.ts` 从不传它 ⇒ 即使运维带上 `--approve-real-media-wiring`
 * （媒体域已按该参数铸造批准能力、并构造出 S3 兼容端口），合成产物端口在 `real` 下仍**恒为 `unwired`**：
 * 有凭据时 `POST /speech/synthesis` 受理前一律 409 `OBJECT_UNAVAILABLE`（`tts/service.ts` 的 ④ 道门），
 * 无凭据时更早触发 503 `PROVIDER_UNAVAILABLE`（③ 道门）——两条都是 `retryable: false`，且都不产生
 * 「替身成功封套」。结论：合成音频永远写不进真实桶，`--approve-real-media-wiring` 对 TTS 完全无效。
 *
 * 本文件只做一件事，且**只做这一件**：把生产入口**已经铸造好的**真实端口（`MediaRealPorts`）折算成
 * `buildApp` 的 `synthesisMediaWiring` 装配选项——同一个 S3 兼容端口 ＋ 此刻显式铸造一次的合成产物
 * 批准能力。它不改判定、不改错误码、不改任何既有失败语义。
 *
 * ⛔ 三条不得越过的边界（与 `media/real-ports.ts` 同口径）：
 *   - **不读 ambient env、不读 `config`、不读 argv**：输入只有**已解析的真实端口**。本文件不参与
 *     「这次启动该不该接真实存储」的判定——该判定唯一发生在
 *     `media/real-ports.ts#resolveMediaRealPorts`，由启动参数 `--approve-real-media-wiring` 驱动；
 *   - **不伪造批准能力**：`approveRealSynthesisMediaWiring` 在本文件只被调用一次，且只有调用方
 *     **真的**拿到了真实端口时才会被执行到（没有启动参数 ⇒ 端口为 `null` ⇒ 本文件不被调用）；
 *   - **未接线时零效果**：不调用本文件 ⇒ 装配层不传 `synthesisMediaWiring` ⇒ `real` 下仍是
 *     `unwired`（与接线前逐字节同行为），`stub`/`preset_demo` 的替身影本文件完全不参与。
 */
import { MEDIA_REAL_WIRING_FLAG, type MediaRealPorts } from '../media/real-ports.ts';
import { approveRealSynthesisMediaWiring, type SynthesisMediaPortOptions } from './media.ts';

/**
 * 铸造理由（只进审计回显，不参与任何判定）：写清这次接线由**哪个启动参数**驱动，便于与
 * 媒体域的批准理由（同样引自该参数）对照审查。
 */
export const SYNTHESIS_MEDIA_REAL_WIRING_REASON =
  `${MEDIA_REAL_WIRING_FLAG}（生产入口显式运维动作）· 合成产物（TTS 音频）写入真实对象存储`;

/**
 * 把真实端口折算成 `buildApp` 的装配选项（只产出 `synthesisMediaWiring` 这一个键）。
 *
 * 调用方（生产入口）必须**只在** `resolveMediaRealPorts` 返回非 `null` 时调用它——那时四条前置校验
 * （real 模式 / `OBJECT_STORAGE_*` 四键齐备 / 访问网关原点可部署）都已通过，端口也已是
 * `s3_compatible`（`createMediaRealPorts` 已拒过替身/未接线端口）。
 */
export function synthesisMediaWiringAssemblyOptions(
  ports: MediaRealPorts,
): { synthesisMediaWiring: SynthesisMediaPortOptions } {
  return {
    synthesisMediaWiring: {
      objectStore: ports.objectStore,
      realSynthesisMediaApproval: approveRealSynthesisMediaWiring({ reason: SYNTHESIS_MEDIA_REAL_WIRING_REASON }),
    },
  };
}
