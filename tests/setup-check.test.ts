import { describe, expect, it } from 'vitest';
import { formatChecks, nodeMajor } from '../src/cli/setup-check.js';

describe('setup:check output', () => {
  it('shows the fix only for problems and counts what is left', () => {
    const out = formatChecks([
      { id: 'node', status: 'ok', message: 'Node v22.1.0', fix: 'never shown' },
      { id: 'config', status: 'fail', message: 'config.yaml not found', fix: 'Copy config.example.yaml' },
      { id: 'live', status: 'info', message: 'Live: none' },
    ]);
    expect(out).toContain('✅ Node v22.1.0');
    expect(out).not.toContain('never shown');
    expect(out).toContain('❌ config.yaml not found\n     → Copy config.example.yaml');
    expect(out).toContain('1 step(s) left');
  });

  it('says complete when nothing failed', () => {
    expect(formatChecks([{ id: 'os', status: 'warn', message: 'Linux beta', fix: 'watch logs' }])).toMatch(/Setup complete\.$/);
  });

  it('reads the Node major version', () => {
    expect(nodeMajor('v20.11.1')).toBe(20);
    expect(nodeMajor('18.0.0')).toBe(18);
    expect(nodeMajor('x')).toBe(0);
  });
});
