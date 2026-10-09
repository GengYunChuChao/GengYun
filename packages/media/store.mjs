/**
 * GY-I06 媒体模块 · 私有对象存储（内存参考实现，可插拔真实对象存储）。
 *
 * 硬红线：私有对象的**桶路径/供应商引用不外露**。对外只暴露不透明 `object_ref`，
 * 且 `object_ref` 只出现在服务端记录与短效句柄 payload 中，绝不进入公开投影或普通日志。
 */
import { randomBytes } from 'node:crypto';

/** 生成不透明对象引用（非路径、非供应商 URL）。 */
export function newObjectRef() {
  return `obj_${randomBytes(18).toString('base64url')}`;
}

/**
 * 内存私有对象存储。真实部署应以对象存储适配器实现同一接口
 * （put/get/delete/has），并把 bucket 路径与签名细节封在适配器内。
 */
export function createPrivateObjectStore() {
  const objects = new Map(); // ref -> { bytes: Uint8Array, contentType: string }
  return {
    put(bytes, contentType) {
      const ref = newObjectRef();
      objects.set(ref, { bytes: Uint8Array.from(bytes), contentType });
      return ref;
    },
    get(ref) {
      const entry = objects.get(ref);
      return entry ? Uint8Array.from(entry.bytes) : null;
    },
    has(ref) {
      return objects.has(ref);
    },
    delete(ref) {
      return objects.delete(ref);
    },
    get size() {
      return objects.size;
    },
  };
}
