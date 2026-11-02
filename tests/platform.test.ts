import { describe, expect, it } from 'vitest';
import { chromeCandidates, findChrome, osSupport } from '../src/platform.js';

describe('chromeCandidates', () => {
  it('macOS: the app bundle, system then user Applications', () => {
    expect(chromeCandidates('darwin', { HOME: '/Users/me' })).toEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]);
  });

  it('Windows: Program Files, Program Files (x86), then the per-user install', () => {
    const env = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
    expect(chromeCandidates('win32', env)).toEqual([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    ]);
  });

  it('Linux: google-chrome on PATH, then the default install dir', () => {
    const c = chromeCandidates('linux', { PATH: '/usr/local/bin:/usr/bin' });
    expect(c.slice(0, 2)).toEqual(['/usr/local/bin/google-chrome', '/usr/local/bin/google-chrome-stable']);
    expect(c).toContain('/usr/bin/google-chrome');
    expect(c.at(-1)).toBe('/opt/google/chrome/chrome');
  });
});

describe('findChrome', () => {
  it('uses the configured path when it exists', () => {
    expect(findChrome('/x/chrome', 'linux', {}, (p) => p === '/x/chrome')).toBe('/x/chrome');
  });

  it('does not fall back when the configured path is wrong', () => {
    expect(() => findChrome('/x/chrome', 'linux', { PATH: '/usr/bin' }, (p) => p === '/usr/bin/google-chrome')).toThrow(/chrome.executablePath/);
  });

  it('auto-detects the first installed candidate', () => {
    expect(findChrome('', 'linux', { PATH: '/usr/bin' }, (p) => p === '/usr/bin/google-chrome-stable')).toBe('/usr/bin/google-chrome-stable');
  });

  it('lists every path tried when Chrome is missing', () => {
    expect(() => findChrome('', 'darwin', { HOME: '/Users/me' }, () => false)).toThrow(/Looked in:[\s\S]*\/Users\/me\/Applications/);
  });
});

describe('osSupport', () => {
  it('macOS supported, Windows and Linux beta', () => {
    expect(osSupport('darwin').level).toBe('supported');
    expect(osSupport('win32').level).toBe('beta');
    expect(osSupport('linux').level).toBe('beta');
    expect(osSupport('freebsd').level).toBe('unsupported');
  });
});
