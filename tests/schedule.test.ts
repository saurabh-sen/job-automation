import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPlist, buildSystemdService, buildSystemdTimer, buildWindowsWrapper, DEFAULT_TIMES, parseTime, parseWindowsTasks, schtasksCreateArgs,
} from '../src/cli/schedule.js';

const opts = {
  label: 'com.jobagent.apply',
  node: '/usr/local/bin/node',
  tsxCli: '/Users/me/R&D <x>/job-agent/node_modules/tsx/dist/cli.mjs',
  repo: '/Users/me/R&D <x>/job-agent',
  times: DEFAULT_TIMES,
  logFile: '/Users/me/R&D <x>/job-agent/logs/launchd.log',
  path: '/usr/local/bin:/usr/bin:/bin',
};

describe('parseTime', () => {
  it('parses HH:MM', () => {
    expect(parseTime('08:00')).toEqual({ hour: 8, minute: 0 });
    expect(parseTime('20:30')).toEqual({ hour: 20, minute: 30 });
  });
  it('rejects bad times', () => {
    for (const t of ['24:00', '8', '08:60', 'noon', '']) expect(() => parseTime(t)).toThrow();
  });
});

describe('buildPlist', () => {
  const plist = buildPlist(opts);

  it('has one Hour/Minute pair per time, as integers', () => {
    const pairs = [...plist.matchAll(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g)]
      .map((m) => `${m[1]}:${m[2]}`);
    expect(pairs).toEqual(['8:0', '11:30', '15:0', '20:0']);
  });

  it('runs node + tsx + src/cli/apply.ts in order from the repo', () => {
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? '';
    const strings = [...args.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
    expect(strings).toEqual([
      '/usr/local/bin/node',
      '/Users/me/R&amp;D &lt;x&gt;/job-agent/node_modules/tsx/dist/cli.mjs',
      'src/cli/apply.ts',
    ]);
    expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/Users/me/R&amp;D &lt;x&gt;/job-agent</string>');
    expect(plist).toContain('<key>Label</key>\n  <string>com.jobagent.apply</string>');
  });

  it('escapes XML special characters', () => {
    expect(plist).not.toMatch(/R&D|<x>/);
  });

  it('logs stdout and stderr to the log file and sets PATH', () => {
    expect(plist).toMatch(/<key>StandardOutPath<\/key>\s*<string>[^<]*logs\/launchd\.log<\/string>/);
    expect(plist).toMatch(/<key>StandardErrorPath<\/key>\s*<string>[^<]*logs\/launchd\.log<\/string>/);
    expect(plist).toMatch(/<key>PATH<\/key>\s*<string>\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>/);
  });

  it('throws on a malformed time', () => {
    expect(() => buildPlist({ ...opts, times: ['8am'] })).toThrow();
  });

  it.runIf(fs.existsSync('/usr/bin/plutil'))('passes plutil -lint', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jobagent-plist-')), 'test.plist');
    fs.writeFileSync(file, plist);
    expect(() => execFileSync('/usr/bin/plutil', ['-lint', file], { stdio: 'pipe' })).not.toThrow();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe('Windows Task Scheduler', () => {
  const wrapper = 'C:\\Users\\me\\job agent\\data\\scheduled-run.cmd';

  it('creates one daily task per time that runs the wrapper', () => {
    const cmds = schtasksCreateArgs(DEFAULT_TIMES, wrapper);
    expect(cmds).toHaveLength(4);
    expect(cmds[1]).toEqual(['/Create', '/F', '/SC', 'DAILY', '/ST', '11:30', '/TN', 'JobAgent 1130', '/TR', `"${wrapper}"`]);
    expect(schtasksCreateArgs(['8:05'], wrapper)[0]).toContain('08:05');
  });

  it('wrapper runs apply from the repo and appends to the log', () => {
    const cmd = buildWindowsWrapper({ node: 'C:\\node\\node.exe', tsxCli: 'C:\\ja\\node_modules\\tsx\\dist\\cli.mjs', repo: 'C:\\my ja' });
    expect(cmd.split('\r\n')).toEqual([
      '@echo off',
      'cd /d "C:\\my ja"',
      'if not exist logs mkdir logs',
      '"C:\\node\\node.exe" "C:\\ja\\node_modules\\tsx\\dist\\cli.mjs" src\\cli\\apply.ts >> logs\\scheduled.log 2>&1',
      '',
    ]);
  });

  it('finds only this agent\'s tasks in schtasks CSV output', () => {
    const csv = '"\\JobAgent 0800","11/3/2026 8:00:00 AM","Ready"\r\n"\\JobAgent 0800","N/A","Ready"\r\n"\\JobAgent 1130","N/A","Ready"\r\n"\\OneDrive Update","N/A","Ready"\r\n';
    expect(parseWindowsTasks(csv)).toEqual(['JobAgent 0800', 'JobAgent 1130']);
    expect(parseWindowsTasks('')).toEqual([]);
  });
});

describe('Linux systemd units', () => {
  it('timer has one OnCalendar per time and catches up missed runs', () => {
    const t = buildSystemdTimer(DEFAULT_TIMES);
    expect([...t.matchAll(/^OnCalendar=(.+)$/gm)].map((m) => m[1])).toEqual(['*-*-* 08:00:00', '*-*-* 11:30:00', '*-*-* 15:00:00', '*-*-* 20:00:00']);
    expect(t).toContain('Persistent=true');
    expect(t).toContain('WantedBy=timers.target');
  });

  it('service runs apply from the repo with the desktop session variables', () => {
    const s = buildSystemdService({
      node: '/usr/bin/node', tsxCli: '/home/me/job agent/node_modules/tsx/dist/cli.mjs', repo: '/home/me/job agent',
      logFile: '/home/me/job agent/logs/scheduled.log', env: { PATH: '/usr/bin:/bin', DISPLAY: ':0' },
    });
    expect(s).toContain('Type=oneshot');
    expect(s).toContain('WorkingDirectory=/home/me/job agent');
    expect(s).toContain('ExecStart="/usr/bin/node" "/home/me/job agent/node_modules/tsx/dist/cli.mjs" "src/cli/apply.ts"');
    expect(s).toContain('Environment="DISPLAY=:0"');
    expect(s).toContain('StandardOutput=append:/home/me/job agent/logs/scheduled.log');
  });

  it('throws on a malformed time', () => {
    expect(() => buildSystemdTimer(['noon'])).toThrow();
  });
});
