import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, releaseLock } from '../src/lock.js';

const HOUR = 3600_000;
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-lock-'));
  file = path.join(dir, 'nested', 'run.lock');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('lock', () => {
  it('takes a missing lock and writes pid + time', () => {
    const now = 1_700_000_000_000;
    expect(acquireLock(file, 3 * HOUR, now)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ pid: process.pid, at: now });
  });

  it('refuses while a fresh lock exists', () => {
    const now = 1_700_000_000_000;
    expect(acquireLock(file, 3 * HOUR, now)).toBe(true);
    expect(acquireLock(file, 3 * HOUR, now + 2 * HOUR)).toBe(false);
  });

  it('takes over a lock older than staleMs', () => {
    const now = 1_700_000_000_000;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: 999_999, at: now - 3 * HOUR - 1 }));
    expect(acquireLock(file, 3 * HOUR, now)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ pid: process.pid, at: now });
  });

  it('falls back to mtime when the lock has no timestamp', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'garbage');
    const mtime = new Date(1_700_000_000_000);
    fs.utimesSync(file, mtime, mtime);
    expect(acquireLock(file, 3 * HOUR, mtime.getTime() + HOUR)).toBe(false);
    expect(acquireLock(file, 3 * HOUR, mtime.getTime() + 4 * HOUR)).toBe(true);
  });

  it('releases only its own lock', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid + 1, at: Date.now() }));
    releaseLock(file);
    expect(fs.existsSync(file)).toBe(true);

    fs.rmSync(file);
    expect(acquireLock(file)).toBe(true);
    releaseLock(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => releaseLock(file)).not.toThrow();
  });

  it('takes over a fresh lock whose process is gone (e.g. Ctrl-C)', () => {
    const now = 1_700_000_000_000;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: 999_999, at: now - 5 * 60_000 }));
    expect(acquireLock(file, 3 * HOUR, now)).toBe(true);
  });
});
