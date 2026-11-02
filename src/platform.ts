import fs from 'node:fs';
import path from 'node:path';

/** How well each OS is supported: macOS is used daily; Windows and Linux are written and unit-tested but not run for real yet. */
export function osSupport(platform: NodeJS.Platform = process.platform): { name: string; level: 'supported' | 'beta' | 'unsupported' } {
  if (platform === 'darwin') return { name: 'macOS', level: 'supported' };
  if (platform === 'win32') return { name: 'Windows', level: 'beta' };
  if (platform === 'linux') return { name: 'Linux', level: 'beta' };
  return { name: platform, level: 'unsupported' };
}

/** Where Google Chrome is normally installed, most likely first. */
export function chromeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') {
    const app = 'Google Chrome.app/Contents/MacOS/Google Chrome';
    return [`/Applications/${app}`, ...(env.HOME ? [path.posix.join(env.HOME, 'Applications', app)] : [])];
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    return roots.map((r) => path.win32.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  const dirs = (env.PATH ?? '/usr/bin:/bin').split(':').filter(Boolean);
  const names = ['google-chrome', 'google-chrome-stable'];
  return [...new Set([...dirs.flatMap((d) => names.map((n) => path.posix.join(d, n))), '/opt/google/chrome/chrome'])];
}

/** The configured Chrome, or the first installed one. Throws listing every path tried. */
export function findChrome(configured = '', platform = process.platform, env = process.env, exists = fs.existsSync): string {
  if (configured) {
    if (exists(configured)) return configured;
    throw new Error(`Chrome not found at chrome.executablePath (${configured}). Fix it in config.yaml, or remove it to auto-detect.`);
  }
  const tried = chromeCandidates(platform, env);
  const hit = tried.find((p) => exists(p));
  if (hit) return hit;
  throw new Error(`Google Chrome not found. Install it, or set chrome.executablePath in config.yaml. Looked in:\n  ${tried.join('\n  ')}`);
}
