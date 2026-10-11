/** Private local files, not COS or an authorization gateway.
 * Caller supplies a dedicated OS-protected directory (including Windows ACLs).
 * This synchronous adapter matches the reference store interface; HTTP/PG integration is separate.
 */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, readSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { newObjectRef } from './store.mjs';
import { MEDIA_MAX_BYTES } from './constants.mjs';
import { MediaError } from './errors.mjs';

const REF = /^obj_[A-Za-z0-9_-]{24}$/;
const unavailable = () => new MediaError('OBJECT_UNAVAILABLE', '本地私有对象不可用');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
function absent(error) { return error?.code === 'ENOENT'; }

/** Reject symbolic links/junctions in any existing ancestor, not just the final object. */
function assertAncestors(path) {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unavailable();
    } catch (error) {
      if (!absent(error)) throw error;
      break;
    }
  }
}

export function createPrivateLocalObjectStore({ rootDir, maxBytes = MEDIA_MAX_BYTES } = {}) {
  if (typeof rootDir !== 'string' || !isAbsolute(rootDir) || rootDir.includes('\0') || /^[\\/]{2}/.test(rootDir)
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MEDIA_MAX_BYTES) {
    throw new MediaError('INVALID_REQUEST', '需要专用绝对路径与有效对象限额');
  }
  const root = resolve(rootDir);
  // Never let a drive/filesystem root become a bucket.
  if (root === parse(root).root) throw new MediaError('INVALID_REQUEST', '需要专用私有目录');
  try { assertAncestors(root); mkdirSync(root, { recursive: true, mode: 0o700 }); }
  catch { throw unavailable(); }
  const rootStat = lstatSync(root);
  if (process.platform !== 'win32' && (rootStat.mode & 0o077) !== 0) throw unavailable();
  const canonical = realpathSync(root);
  function guard() {
    try {
      assertAncestors(root);
      if (realpathSync(root) !== canonical || !sameFile(rootStat, lstatSync(root))) throw unavailable();
    } catch { throw unavailable(); }
  }
  function pathFor(ref) {
    if (typeof ref !== 'string' || !REF.test(ref)) throw new MediaError('INVALID_REQUEST', '对象引用格式无效');
    guard();
    return join(root, ref);
  }
  function inspect(path) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
          || stat.size < 1 || stat.size > maxBytes) throw unavailable();
      return stat;
    } catch (error) {
      if (absent(error)) return null;
      throw unavailable();
    }
  }
  function refs() {
    guard();
    const entries = readdirSync(root);
    // A non-dedicated directory, stray directory, link or hardlink fails closed.
    for (const ref of entries) {
      if (!REF.test(ref) || !inspect(join(root, ref))) throw unavailable();
    }
    return entries;
  }
  refs();
  return {
    put(bytes, contentType) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) throw new MediaError('INVALID_REQUEST', '需要非空实际字节');
      if (bytes.byteLength > maxBytes) throw new MediaError('MEDIA_TOO_LARGE', '对象超过字节限额');
      if (typeof contentType !== 'string' || contentType.length < 1 || contentType.length > 120) throw new MediaError('INVALID_REQUEST', '媒体类型无效');
      // MIME/magic/hash/duration validation belongs to the already reviewed media service.
      const ref = newObjectRef();
      const path = pathFor(ref);
      let fd;
      let created = false;
      let identity;
      try {
        fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        created = true;
        identity = fstatSync(fd);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const count = writeSync(fd, bytes, offset, bytes.byteLength - offset);
          if (count === 0) throw unavailable();
          offset += count;
        }
        fsyncSync(fd);
        guard();
        if (!sameFile(identity, inspect(path)) || fstatSync(fd).size !== bytes.byteLength) throw unavailable();
        return ref;
      } catch {
        // Only remove the file this operation actually created, never a replaced path.
        if (fd !== undefined) { closeSync(fd); fd = undefined; }
        if (created) {
          try { guard(); if (identity && sameFile(identity, lstatSync(path))) unlinkSync(path); } catch { /* Recovery belongs to the later durable ledger. */ }
        }
        throw unavailable();
      } finally { if (fd !== undefined) closeSync(fd); }
    },
    get(ref) {
      const path = pathFor(ref);
      const before = inspect(path);
      if (!before) return null;
      let fd;
      try {
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(fd);
        if (!sameFile(before, opened) || !opened.isFile() || opened.nlink !== 1 || opened.size !== before.size) throw unavailable();
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (count === 0) throw unavailable();
          offset += count;
        }
        const after = fstatSync(fd);
        guard();
        const current = inspect(path);
        if (!current || !sameFile(opened, current) || after.size !== opened.size
            || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw unavailable();
        return Uint8Array.from(bytes);
      } catch { throw unavailable(); }
      finally { if (fd !== undefined) closeSync(fd); }
    },
    has(ref) { return inspect(pathFor(ref)) !== null; },
    delete(ref) {
      const path = pathFor(ref);
      if (!inspect(path)) return false;
      try { guard(); unlinkSync(path); return true; }
      catch { throw unavailable(); }
    },
    get size() { return refs().length; },
  };
}
