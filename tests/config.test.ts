import { describe, expect, it } from 'vitest';
import os from 'node:os';
import { ConfigError, isTodo, parseConfig } from '../src/config.js';
import { testConfig } from './helpers.js';

const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  return [];
};

describe('config', () => {
  it('accepts a complete config and fills defaults', () => {
    const cfg = testConfig();
    expect(cfg.filters.maxRequiredExperience).toBe(5);
    expect(cfg.limits.dailyCap).toEqual({ linkedin: 15, naukri: 25, instahyre: 30, wellfound: 15, workatastartup: 10 });
    expect(cfg.sites.naukri.live).toBe(false);
    expect(cfg.sites.instahyre.enabled).toBe(false);
    expect(cfg.ollama.enabled).toBe(false);
    expect(cfg.chrome.cdpUrl).toBe('http://127.0.0.1:9333');
    expect(cfg.chrome.userDataDir.startsWith(os.homedir())).toBe(true);
  });

  it('lists every TODO value by path', () => {
    const problems = problemsOf(() =>
      testConfig({ profile: { ...testConfig().profile, phone: 'TODO', email: 'TODO@gmail.com', skillYears: { React: 'TODO' } } }),
    );
    expect(problems).toContain('profile.phone is still TODO');
    expect(problems).toContain('profile.email is still TODO');
    expect(problems).toContain('profile.skillYears.React is still TODO');
  });

  it('requires Telegram token and chat id when enabled', () => {
    const problems = problemsOf(() => testConfig({ telegram: { enabled: true, botToken: '', chatId: '' } }));
    expect(problems.some((p) => p.startsWith('telegram.botToken'))).toBe(true);
    expect(problems.some((p) => p.startsWith('telegram.chatId'))).toBe(true);
    expect(() => testConfig({ telegram: { enabled: false, botToken: '', chatId: '' } })).not.toThrow();
  });

  it('rejects unknown keys and zero CTC', () => {
    expect(problemsOf(() => testConfig({ filters: { ...testConfig().filters, maxRequiredExperince: 4 } })).length).toBeGreaterThan(0);
    expect(problemsOf(() => testConfig({ profile: { ...testConfig().profile, currentCtcLpa: 0 } })).length).toBeGreaterThan(0);
  });

  it('rejects an invalid customAnswers regex', () => {
    expect(problemsOf(() => testConfig({ customAnswers: [{ match: '(', answer: 'x' }] })).length).toBeGreaterThan(0);
  });

  it('requires a message template only for the sites that send one', () => {
    const on = { naukri: { enabled: true }, wellfound: { enabled: true }, workatastartup: { enabled: true } };
    const problems = problemsOf(() => testConfig({ sites: on }));
    expect(problems.filter((p) => p.startsWith('templates.')).map((p) => p.split(' ')[0])).toEqual(['templates.wellfound', 'templates.workatastartup']);
    expect(() => testConfig({ sites: on, templates: { wellfound: 'Hi {company}', workatastartup: 'Hi {company}' } })).not.toThrow();
    expect(() => testConfig({ sites: { naukri: { enabled: true } } })).not.toThrow();
    expect(problemsOf(() => testConfig({ sites: { wellfound: { enabled: false, live: true } } }))[0]).toMatch(/^templates\.wellfound/);
  });

  it('schedule times default to four a day and must be HH:MM', () => {
    expect(testConfig().schedule.times).toEqual(['08:00', '11:30', '15:00', '20:00']);
    expect(testConfig({ schedule: { times: ['9:15', '21:00'] } }).schedule.times).toEqual(['9:15', '21:00']);
    expect(problemsOf(() => testConfig({ schedule: { times: ['25:00'] } })).length).toBeGreaterThan(0);
    expect(problemsOf(() => testConfig({ schedule: { times: [] } })).length).toBeGreaterThan(0);
  });

  it('leaves chrome.executablePath empty for auto-detect', () => {
    expect(testConfig().chrome.executablePath).toBe('');
  });

  it('isTodo', () => {
    expect(isTodo('TODO')).toBe(true);
    expect(isTodo('todo: fill')).toBe(true);
    expect(isTodo('Toddler')).toBe(false);
    expect(isTodo(3)).toBe(false);
    expect(() => parseConfig(null)).toThrow(ConfigError);
  });
});
