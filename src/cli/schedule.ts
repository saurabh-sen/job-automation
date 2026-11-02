import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, DEFAULT_SCHEDULE_TIMES, loadScheduleConfig } from '../config.js';
import { osSupport } from '../platform.js';
import { errMsg } from '../utils.js';

export const LABEL = 'com.jobagent.apply';
export const DEFAULT_TIMES = DEFAULT_SCHEDULE_TIMES;
/** Linux systemd user units: job-agent.service (one run) started by job-agent.timer. */
export const UNIT = 'job-agent';
const WIN_TASK_PREFIX = 'JobAgent ';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "08:30" -> { hour: 8, minute: 30 }. Throws on anything else. */
export function parseTime(t: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  const hour = Number(m?.[1]);
  const minute = Number(m?.[2]);
  if (!m || hour > 23 || minute > 59) throw new Error(`Invalid time "${t}" (use HH:MM, 24-hour)`);
  return { hour, minute };
}

/** launchd job: runs `node tsx src/cli/apply.ts` from the repo at each time. launchd also runs a missed slot on wake. */
export function buildPlist(opts: { label: string; node: string; tsxCli: string; repo: string; times: string[]; logFile: string; path: string }): string {
  const str = (s: string) => `<string>${xml(s)}</string>`;
  const slots = opts.times.map(parseTime).map(({ hour, minute }) =>
    `    <dict>\n      <key>Hour</key>\n      <integer>${hour}</integer>\n      <key>Minute</key>\n      <integer>${minute}</integer>\n    </dict>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(opts.label)}
  <key>ProgramArguments</key>
  <array>
    ${str(opts.node)}
    ${str(opts.tsxCli)}
    ${str('src/cli/apply.ts')}
  </array>
  <key>WorkingDirectory</key>
  ${str(opts.repo)}
  <key>StartCalendarInterval</key>
  <array>
${slots.join('\n')}
  </array>
  <key>StandardOutPath</key>
  ${str(opts.logFile)}
  <key>StandardErrorPath</key>
  ${str(opts.logFile)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${str(opts.path)}
  </dict>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

const hhmm = (t: string) => {
  const { hour, minute } = parseTime(t);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

/** Windows: a small .cmd that the scheduled tasks run (schtasks /TR is too short for the full command line). */
export function buildWindowsWrapper(opts: { node: string; tsxCli: string; repo: string }): string {
  return [
    '@echo off',
    `cd /d "${opts.repo}"`,
    'if not exist logs mkdir logs',
    `"${opts.node}" "${opts.tsxCli}" src\\cli\\apply.ts >> logs\\scheduled.log 2>&1`,
    '',
  ].join('\r\n');
}

/** Windows Task Scheduler: one daily task per time, each running the wrapper. Arguments for `schtasks`. */
export function schtasksCreateArgs(times: string[], wrapper: string): string[][] {
  return times.map((t) => {
    const at = hhmm(t);
    return ['/Create', '/F', '/SC', 'DAILY', '/ST', at, '/TN', `${WIN_TASK_PREFIX}${at.replace(':', '')}`, '/TR', `"${wrapper}"`];
  });
}

/** Task names in `schtasks /Query /FO CSV /NH` output that belong to this agent (any times, so old ones get removed too). */
export function parseWindowsTasks(csv: string): string[] {
  return [...new Set(csv.split(/\r?\n/)
    .map((line) => /^"\\?([^"]+)"/.exec(line)?.[1] ?? '')
    .filter((n) => n.startsWith(WIN_TASK_PREFIX)))];
}

const sdQuote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** Desktop session variables a user unit doesn't inherit; Chrome needs them to open a window. */
export const DISPLAY_VARS = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];

/** Linux: the oneshot service that does one run. `env` carries PATH and the desktop session variables. */
export function buildSystemdService(opts: { node: string; tsxCli: string; repo: string; logFile: string; env: Record<string, string> }): string {
  return `[Unit]
Description=job-agent scheduled run

[Service]
Type=oneshot
WorkingDirectory=${opts.repo}
ExecStart=${[opts.node, opts.tsxCli, 'src/cli/apply.ts'].map(sdQuote).join(' ')}
${Object.entries(opts.env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`).join('\n')}
StandardOutput=append:${opts.logFile}
StandardError=append:${opts.logFile}
`;
}

/** Linux: the timer. Persistent=true runs a slot that was missed while the machine was off or asleep. */
export function buildSystemdTimer(times: string[]): string {
  return `[Unit]
Description=job-agent daily runs

[Timer]
${times.map((t) => `OnCalendar=*-*-* ${hhmm(t)}:00`).join('\n')}
Persistent=true

[Install]
WantedBy=timers.target
`;
}

type Ctx = { repo: string; node: string; tsxCli: string; times: string[] };
type Status = { installed: boolean; detail: string };
type Platform = { install(c: Ctx): number; uninstall(c: Ctx): number; status(c: Ctx): Status };

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryRun = (cmd: string, args: string[]) => {
  try {
    return run(cmd, args);
  } catch {
    return null;
  }
};

const mac: Platform = (() => {
  const uid = () => process.getuid?.() ?? 0;
  const target = () => `gui/${uid()}/${LABEL}`;
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const bootout = () => tryRun('launchctl', ['bootout', target()]);
  return {
    install({ repo, node, tsxCli, times }) {
      const logFile = path.join(repo, 'logs', 'launchd.log');
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(plistPath, buildPlist({ label: LABEL, node, tsxCli, repo, times, logFile, path: process.env.PATH ?? '/usr/bin:/bin' }));
      bootout();
      try {
        run('launchctl', ['bootstrap', `gui/${uid()}`, plistPath]);
      } catch (e) {
        console.error(`launchctl bootstrap failed: ${errMsg(e)}`);
        return 1;
      }
      console.log(`Scheduled runs at ${times.join(', ')} every day (${plistPath}).`);
      console.log('Output goes to logs/launchd.log and logs/run-<date>.log. The Mac must be on; if it is asleep, the missed run starts on wake.');
      return 0;
    },
    uninstall() {
      bootout();
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
      return 0;
    },
    status({ times, repo }) {
      if (!fs.existsSync(plistPath)) return { installed: false, detail: 'Not installed.' };
      const dir = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(fs.readFileSync(plistPath, 'utf8'))?.[1];
      if (dir !== xml(repo)) return { installed: false, detail: `The installed job runs another copy of job-agent (${dir ?? '?'}).` };
      const out = tryRun('launchctl', ['print', target()]);
      if (!out) return { installed: false, detail: `${plistPath} exists but the job is not loaded.` };
      const field = (k: string) => new RegExp(`^\\s*${k} = (.+)$`, 'm').exec(out)?.[1]?.trim();
      return {
        installed: true,
        detail: `Installed: runs at ${times.join(', ')}. State: ${field('state') ?? '?'} · runs so far: ${field('runs') ?? '?'} · last exit code: ${field('last exit code') ?? '?'}`,
      };
    },
  };
})();

const windows: Platform = (() => {
  const installed = () => parseWindowsTasks(tryRun('schtasks', ['/Query', '/FO', 'CSV', '/NH']) ?? '');
  const removeAll = () => {
    for (const n of installed()) tryRun('schtasks', ['/Delete', '/F', '/TN', n]);
  };
  return {
    install({ repo, node, tsxCli, times }) {
      const wrapper = path.join(repo, 'data', 'scheduled-run.cmd');
      fs.mkdirSync(path.dirname(wrapper), { recursive: true });
      fs.mkdirSync(path.join(repo, 'logs'), { recursive: true });
      fs.writeFileSync(wrapper, buildWindowsWrapper({ node, tsxCli, repo }));
      removeAll();
      for (const args of schtasksCreateArgs(times, wrapper)) {
        try {
          run('schtasks', args);
        } catch (e) {
          console.error(`schtasks failed: ${errMsg(e)}`);
          return 1;
        }
      }
      console.log(`Scheduled runs at ${times.join(', ')} every day (Task Scheduler, tasks "${WIN_TASK_PREFIX}HHMM").`);
      console.log('Output goes to logs\\scheduled.log and logs\\run-<date>.log. Runs happen only while you are signed in and the PC is awake.');
      return 0;
    },
    uninstall() {
      removeAll();
      return 0;
    },
    status({ repo }) {
      if (!fs.existsSync(path.join(repo, 'data', 'scheduled-run.cmd'))) return { installed: false, detail: 'Not installed for this copy of job-agent.' };
      const names = installed();
      return names.length ? { installed: true, detail: `Installed: ${names.join(', ')}.` } : { installed: false, detail: 'Not installed.' };
    },
  };
})();

const linux: Platform = (() => {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
  const service = path.join(dir, `${UNIT}.service`);
  const timer = path.join(dir, `${UNIT}.timer`);
  const ctl = (...args: string[]) => run('systemctl', ['--user', ...args]);
  return {
    install({ repo, node, tsxCli, times }) {
      if (tryRun('systemctl', ['--user', '--version']) == null) {
        console.error('systemd (systemctl --user) is not available, so the schedule cannot be installed automatically.');
        console.error(`Add a cron entry per time instead, e.g.: 0 8 * * * cd "${repo}" && "${node}" "${tsxCli}" src/cli/apply.ts >> logs/scheduled.log 2>&1`);
        return 1;
      }
      const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
      for (const k of DISPLAY_VARS) if (process.env[k]) env[k] = process.env[k]!;
      const logFile = path.join(repo, 'logs', 'scheduled.log');
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(service, buildSystemdService({ node, tsxCli, repo, logFile, env }));
      fs.writeFileSync(timer, buildSystemdTimer(times));
      try {
        ctl('daemon-reload');
        ctl('enable', '--now', `${UNIT}.timer`);
      } catch (e) {
        console.error(`systemctl failed: ${errMsg(e)}`);
        return 1;
      }
      console.log(`Scheduled runs at ${times.join(', ')} every day (${timer}).`);
      console.log('Output goes to logs/scheduled.log and logs/run-<date>.log. You must be logged in to your desktop for Chrome to open.');
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
        console.log('Warning: no DISPLAY or WAYLAND_DISPLAY in this shell, so Chrome may fail to start. Run this from a terminal inside your desktop session.');
      }
      return 0;
    },
    uninstall() {
      tryRun('systemctl', ['--user', 'disable', '--now', `${UNIT}.timer`]);
      for (const f of [timer, service]) if (fs.existsSync(f)) fs.unlinkSync(f);
      tryRun('systemctl', ['--user', 'daemon-reload']);
      return 0;
    },
    status({ times, repo }) {
      if (!fs.existsSync(timer) || !fs.existsSync(service)) return { installed: false, detail: 'Not installed.' };
      if (!fs.readFileSync(service, 'utf8').includes(`WorkingDirectory=${repo}\n`)) return { installed: false, detail: 'The installed timer runs another copy of job-agent.' };
      const active = tryRun('systemctl', ['--user', 'is-active', `${UNIT}.timer`])?.trim() ?? 'inactive';
      if (active !== 'active') return { installed: false, detail: `${timer} exists but the timer is ${active}.` };
      const next = tryRun('systemctl', ['--user', 'show', `${UNIT}.timer`, '--property=NextElapseUSecRealtime', '--value'])?.trim();
      return { installed: true, detail: `Installed: runs at ${times.join(', ')}.${next ? ` Next run: ${next}.` : ''}` };
    },
  };
})();

function platform(): Platform | null {
  return process.platform === 'darwin' ? mac : process.platform === 'win32' ? windows : process.platform === 'linux' ? linux : null;
}

function context(): Ctx {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return { repo, node: process.execPath, tsxCli: path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'), times: loadScheduleConfig().times };
}

/** For `npm run setup:check`. */
export function scheduleStatus(): Status {
  const p = platform();
  if (!p) return { installed: false, detail: `Scheduling is not supported on ${process.platform}.` };
  try {
    return p.status(context());
  } catch (e) {
    return { installed: false, detail: errMsg(e) };
  }
}

function main(cmd: string | undefined): number {
  if (cmd !== 'install' && cmd !== 'uninstall' && cmd !== 'status') {
    console.error('Usage: npm run schedule:install | schedule:uninstall | schedule:status');
    return 1;
  }
  const p = platform();
  if (!p) {
    console.error(`Scheduling is not supported on ${process.platform}.`);
    return 1;
  }
  let ctx: Ctx;
  try {
    ctx = context();
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : errMsg(e));
    return 1;
  }
  if (cmd === 'install') {
    if (!fs.existsSync(ctx.tsxCli)) {
      console.error('tsx is not installed in this repo. Run `npm install` first.');
      return 1;
    }
    if (osSupport().level === 'beta') console.log(`Note: ${osSupport().name} scheduling is new and not yet tested on a real machine. Check logs after the first run.`);
    const code = p.install(ctx);
    if (code === 0) console.log('If you change or upgrade Node, or change schedule.times, run `npm run schedule:install` again.');
    return code;
  }
  if (cmd === 'uninstall') {
    const code = p.uninstall(ctx);
    console.log('Schedule removed.');
    return code;
  }
  const st = p.status(ctx);
  console.log(st.installed ? st.detail : `${st.detail} Run \`npm run schedule:install\`.`);
  return 0;
}

const isMain = (() => {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = main(process.argv[2]);
