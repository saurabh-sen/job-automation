import { describe, expect, it } from 'vitest';
import { fillTemplate, TEMPLATE_LIMITS } from '../src/templates.js';

const vars = { firstName: 'Test', company: 'Acme', role: 'Frontend Engineer' };

describe('fillTemplate', () => {
  it('replaces the variables', () => {
    expect(fillTemplate('Hi {company} team, I am {firstName}. The {role} role looks great.', vars, 500))
      .toBe('Hi Acme team, I am Test. The Frontend Engineer role looks great.');
  });

  it('replaces repeated variables', () => {
    expect(fillTemplate('{company}, {company}!', vars, 500)).toBe('Acme, Acme!');
  });

  it('falls back for an empty company or role', () => {
    expect(fillTemplate('The {role} role at {company}.', { firstName: 'Test', company: '', role: '  ' }, 500))
      .toBe('The open role at your company.');
  });

  it('throws on an unknown placeholder', () => {
    expect(() => fillTemplate('Hi {name}', vars, 500)).toThrow(/\{name\}/);
    expect(() => fillTemplate('Hi {}', vars, 500)).toThrow();
    expect(() => fillTemplate('The { role } role', vars, 500)).toThrow(/\{ role \}/);
    expect(() => fillTemplate('Hi {first name}', vars, 500)).toThrow();
  });

  it('allows braces in the filled values', () => {
    expect(fillTemplate('Hi {company} team', { ...vars, company: 'Acme {Labs}' }, 500)).toBe('Hi Acme {Labs} team');
  });

  it('joins YAML hard wraps and keeps paragraph breaks', () => {
    const tpl = 'Hi, I am {firstName}, a software engineer\nbuilding web apps.\n\n  Thanks,\n{firstName}\n';
    expect(fillTemplate(tpl, vars, 500)).toBe('Hi, I am Test, a software engineer building web apps.\n\nThanks, Test');
  });

  it('collapses repeated spaces and trims', () => {
    expect(fillTemplate('   Hello   {company}  \n\n\n\n  Bye  ', vars, 500)).toBe('Hello Acme\n\nBye');
  });

  it('leaves a message within the limit untouched', () => {
    const s = 'One. Two. Three.';
    expect(fillTemplate(s, vars, s.length)).toBe(s);
  });

  it('cuts at the last sentence end within the limit', () => {
    const tpl = 'First sentence here. Second one is here! Third one is much longer and goes over the limit.';
    expect(fillTemplate(tpl, vars, 45)).toBe('First sentence here. Second one is here!');
    expect(fillTemplate('Is this ok? Yes it is fine really.', vars, 20)).toBe('Is this ok?');
  });

  it('does not treat a dot inside a word as a sentence end', () => {
    expect(fillTemplate('I build with Node.js and React every day', vars, 20)).toBe('I build with Node.js');
  });

  it('cuts at the last space when there is no sentence end, never mid-word', () => {
    const out = fillTemplate('alpha beta gamma delta epsilon', vars, 14);
    expect(out).toBe('alpha beta');
    expect(out).not.toMatch(/\.\.\.|…/);
  });

  it('keeps a word that ends exactly at the limit', () => {
    expect(fillTemplate('alpha beta gamma', vars, 10)).toBe('alpha beta');
  });

  it('never exceeds the limit', () => {
    const tpl = 'Hi {company} team, I am {firstName}. '.repeat(50);
    for (const max of [10, 37, 100, 333]) expect(fillTemplate(tpl, vars, max).length).toBeLessThanOrEqual(max);
  });

  it('has a limit for each template site', () => {
    expect(TEMPLATE_LIMITS.wellfound).toBeGreaterThan(0);
    expect(TEMPLATE_LIMITS.workatastartup).toBeGreaterThan(0);
  });
});
