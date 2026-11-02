import fs from 'node:fs';
import path from 'node:path';

/** False when the lock names a pid that no longer exists (e.g. a run killed with Ctrl-C). */
function holderAlive(file: string): boolean {
  try {
    const { pid } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown };
    if (typeof pid !== 'number') return true;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** When the lock was taken: its written timestamp, else the file's mtime. */
function lockTime(file: string): number {
  try {
    const at = (JSON.parse(fs.readFileSync(file, 'utf8')) as { at?: unknown }).at;
    if (typeof at === 'number' && Number.isFinite(at)) return at;
  } catch {
    // unreadable or not JSON: fall back to mtime
  }
  return fs.statSync(file).mtimeMs;
}

/** Single-run lock. False while a fresh lock exists; a lock older than `staleMs` is taken over. */
export function acquireLock(file = 'data/run.lock', staleMs = 3 * 3600_000, now = Date.now()): boolean {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, at: now });
  try {
    fs.writeFileSync(file, body, { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  let taken: number;
  try {
    taken = lockTime(file);
  } catch {
    taken = 0; // vanished between the write and the read: treat as stale
  }
  if (now - taken < staleMs && holderAlive(file)) return false;
  fs.writeFileSync(file, body);
  return true;
}

/** Removes the lock only if this process holds it. */
export function releaseLock(file = 'data/run.lock'): void {
  try {
    const { pid } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown };
    if (pid === process.pid) fs.unlinkSync(file);
  } catch {
    // missing or unreadable: nothing of ours to release
  }
}
