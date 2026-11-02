import { describe, expect, it } from 'vitest';
import { checkFilters, isRemote, minExperience, normalizeCompany, normalizeTitle } from '../src/filters.js';
import { testConfig } from './helpers.js';

const f = testConfig().filters;
const job = (over: Partial<{ title: string; company: string; location: string; description: string; experience: string }> = {}) => ({
  title: 'Frontend Engineer',
  company: 'Acme',
  location: 'Bengaluru',
  description: '',
  ...over,
});
const check = (over: Parameters<typeof job>[0]) => checkFilters(job(over), f);
const reason = (over: Parameters<typeof job>[0]) => {
  const r = check(over);
  return r.ok ? null : r.reason;
};

describe('minExperience: accepted patterns', () => {
  it.each([
    ['3-6 Yrs', 3],
    ['3 - 6 years', 3],
    ['3 to 6 years', 3],
    ['3–5 yrs', 3],
    ['3—5 years', 3],
    ['5+ years of experience', 5],
    ['5+ yrs', 5],
    ['5 + years', 5],
    ['minimum 4 years', 4],
    ['Minimum of 4 years in React', 4],
    ['min. 4 yrs', 4],
    ['at least 4 years', 4],
    ['4 years of experience', 4],
    ['4+ years’ experience', 4],
    ["4+ years' experience", 4],
    ['3 yrs exp', 3],
    ['4 years of hands-on experience in React', 4],
    ['Experience: 2-5 Years', 2],
    ['Exp 3-5 yrs', 3],
    ['experience of 3 years', 3],
    ['Experience: 4+ years', 4],
    ['Experience required: 3 yrs', 3],
    ['experience: 3+', 3],
    ['2.5+ years of experience', 2.5],
    ['0-2 Yrs', 0],
    ['0-2', 0],
    ['Fresher', 0],
    ['Freshers can apply', 0],
  ])('%s -> %s', (text, want) => {
    expect(minExperience(text)).toBe(want);
  });
});

describe('minExperience: numbers not tied to experience', () => {
  it.each([
    '',
    'Work 5 days a week',
    'CTC up to 15 LPA',
    'Join a team of 10 engineers',
    '100+ employees across 3 offices',
    '6 months probation',
    'We were founded 5 years ago',
    'A 10 years old company',
    'We have been in business for 12 years',
    'Not for freshers',
    'React, TypeScript and Node',
  ])('%s -> null', (text) => {
    expect(minExperience(text)).toBeNull();
  });
});

describe('minExperience: picks the first mention in text order', () => {
  it('earlier mention wins over later ones', () => {
    expect(minExperience('Need 2+ years of experience in React and 6+ years of experience overall')).toBe(2);
    expect(minExperience('6+ years of experience. Freshers need not apply... 2-4 yrs preferred')).toBe(6);
  });
  it('ignores unrelated numbers before the real mention', () => {
    expect(minExperience('Team of 10, 5 days a week. 3-5 years experience required.')).toBe(3);
    expect(minExperience('Founded 8 years ago, we need someone with 4+ years of experience')).toBe(4);
  });
  it('does not treat the end of a range as its own mention', () => {
    expect(minExperience('2 to 6 years of experience')).toBe(2);
    expect(minExperience('Looking for 3 - 7 yrs experience')).toBe(3);
  });
});

describe('minExperience: regressions', () => {
  it('a negated "freshers" is not a 0-year mention and does not hide a later requirement', () => {
    expect(minExperience('Freshers need not apply. 6+ years of experience required')).toBe(6);
    expect(minExperience('Freshers are not eligible; 6+ yrs exp')).toBe(6);
    expect(minExperience('freshers not allowed')).toBeNull();
    expect(minExperience('Not open to freshers. 6+ years of experience')).toBe(6);
    expect(minExperience('We do not hire freshers. 6+ yrs exp')).toBe(6);
    expect(minExperience("We don't hire freshers")).toBeNull();
    expect(minExperience('Non-freshers only')).toBeNull();
    expect(minExperience('Freshers welcome')).toBe(0);
    expect(minExperience('Ideal for freshers and early-career engineers')).toBe(0);
    expect(minExperience('No bar; freshers welcome')).toBe(0);
  });
  it('a whole field that is one number with a unit is an experience value', () => {
    expect(minExperience('5 Yrs')).toBe(5);
    expect(minExperience(' 2 years ')).toBe(2);
    expect(minExperience('5+')).toBe(5);
    expect(minExperience('5')).toBeNull();
    expect(minExperience('5 years ago')).toBeNull();
  });
});

describe('isRemote', () => {
  it.each([
    ['Remote', true],
    ['Remote - India', true],
    ['Bengaluru (Remote)', true],
    ['Work from home', true],
    ['WFH', true],
    ['Anywhere in India', true],
    ['Bengaluru', false],
    ['Hybrid - Hyderabad', false],
    ['Remotely located office', false],
    ['', false],
  ])('%s -> %s', (loc, want) => {
    expect(isRemote(loc)).toBe(want);
  });
});

describe('checkFilters: titles', () => {
  it.each([
    'Senior Software Engineer',
    'SDE II',
    'SDE 2',
    'SDE-2',
    'SDE 1',
    'Frontend Engineer, Internal Tools',
    'International Payments - Frontend Developer',
    'Full Stack Developer',
    'Fullstack Engineer',
    'Front-End Developer',
    'ReactJS Developer',
    'Software Developer',
    'UI Engineer',
    'Sapient-style Frontend Engineer',
    'Headless Commerce Frontend Engineer',
    'Frontend Engineer (Qatar)',
    'Node.js Developer',
  ])('%s is ok', (title) => {
    expect(check({ title })).toEqual({ ok: true });
  });

  it.each([
    ['SDE III', 'sde iii'],
    ['SDE 3', 'sde 3'],
    ['SDE-3', 'sde 3'],
    ['SDE3', 'sde 3'],
    ['SDE-III', 'sde iii'],
    ['Lead Frontend Engineer', 'lead'],
    ['Engineering Manager', 'manager'],
    ['Principal Software Engineer', 'principal'],
    ['Frontend Architect', 'architect'],
    ['Staff Engineer, Frontend', 'staff engineer'],
    ['Software Engineer Intern', 'intern'],
    ['Frontend Developer - Intern', 'intern'],
    ['QA Engineer', 'qa'],
    ['Android Developer', 'android'],
    ['iOS Software Engineer', 'ios'],
    ['SAP UI5 Developer', 'sap'],
    ['DevOps Software Engineer', 'devops'],
    ['Head of Frontend', 'head'],
    ['Software Engineer Trainee', 'trainee'],
  ])('%s is skipped (%s)', (title, kw) => {
    expect(reason({ title })).toBe(`title has "${kw}"`);
  });

  it('exclude keywords are whole words: intern vs Internal/International, sap vs Sapient', () => {
    const only = (kw: string) => ({ ...f, excludeTitleKeywords: [kw] });
    expect(checkFilters(job({ title: 'Frontend Engineer, Internal Tools' }), only('intern')).ok).toBe(true);
    expect(checkFilters(job({ title: 'Frontend Engineer Intern' }), only('intern')).ok).toBe(false);
    expect(checkFilters(job({ title: 'Software Engineer @ Sapient' }), only('sap')).ok).toBe(true);
    expect(checkFilters(job({ title: 'Software Engineer (SAP)' }), only('sap')).ok).toBe(false);
    expect(checkFilters(job({ title: 'Leading Frontend Platform Engineer' }), only('lead')).ok).toBe(true);
    expect(checkFilters(job({ title: 'Team Lead - Frontend' }), only('lead')).ok).toBe(false);
  });

  it('exclude keywords with regex characters are escaped', () => {
    const fx = { ...f, excludeTitleKeywords: ['c++', '.net'] };
    expect(checkFilters(job({ title: 'C++ Software Engineer' }), fx)).toEqual({ ok: false, reason: 'title has "c++"' });
    expect(checkFilters(job({ title: 'cxx Software Engineer' }), fx).ok).toBe(true);
    expect(checkFilters(job({ title: 'Software Engineer .NET' }), fx).ok).toBe(false);
    expect(checkFilters(job({ title: 'Software Engineer xnet' }), fx).ok).toBe(true);
  });

  it('a title with no include keyword is not a target role', () => {
    expect(reason({ title: 'Backend Engineer' })).toBe('not a target role');
    expect(reason({ title: 'Data Scientist' })).toBe('not a target role');
  });

  it('an empty title is reported, not matched', () => {
    expect(reason({ title: '' })).toBe('could not read the job title');
    expect(reason({ title: '   ' })).toBe('could not read the job title');
  });
});

describe('checkFilters: companies', () => {
  it('skips excluded companies by case-insensitive substring', () => {
    expect(reason({ company: 'AcmeSoft Software Pvt Ltd' })).toBe('excluded company (acmesoft)');
    expect(reason({ company: 'acmesoft' })).toBe('excluded company (acmesoft)');
  });
  it('allows other companies and missing company names', () => {
    expect(check({ company: 'Acme Labs' }).ok).toBe(true);
    expect(check({ company: '' }).ok).toBe(true);
  });
  it('company check runs before the title check', () => {
    expect(reason({ company: 'AcmeSoft', title: 'Engineering Manager' })).toBe('excluded company (acmesoft)');
  });
});

describe('checkFilters: experience', () => {
  it('skips only when the minimum is above maxRequiredExperience', () => {
    expect(check({ experience: '4+ years' }).ok).toBe(true);
    expect(check({ experience: '5+ years' }).ok).toBe(true);
    expect(check({ experience: '3-6 Yrs' }).ok).toBe(true);
    expect(check({ experience: '5-8 Yrs' }).ok).toBe(true);
    expect(reason({ experience: '6+ years' })).toBe('needs 6+ yrs');
    expect(reason({ experience: '7-10 Yrs' })).toBe('needs 7+ yrs');
  });
  it('falls back to the description when the experience field is empty or unparseable', () => {
    expect(reason({ description: 'We need 8+ years of experience with React.' })).toBe('needs 8+ yrs');
    expect(reason({ experience: 'Not disclosed', description: 'Minimum 6 years' })).toBe('needs 6+ yrs');
  });
  it('the experience field wins over the description', () => {
    expect(check({ experience: '2-4 Yrs', description: '8+ years of experience preferred' }).ok).toBe(true);
  });
  it('unknown experience never skips', () => {
    expect(check({ experience: '', description: 'Founded 20 years ago. 100+ employees.' }).ok).toBe(true);
  });
  it('respects a custom maxRequiredExperience', () => {
    expect(checkFilters(job({ experience: '4+ years' }), { ...f, maxRequiredExperience: 3 })).toEqual({
      ok: false,
      reason: 'needs 4+ yrs',
    });
  });
});

describe('checkFilters: location', () => {
  it('allows listed cities by substring, case-insensitive', () => {
    expect(check({ location: 'Bengaluru, Karnataka, India' }).ok).toBe(true);
    expect(check({ location: 'Hyderabad/Secunderabad' }).ok).toBe(true);
    expect(check({ location: 'PUNE' }).ok).toBe(true);
  });
  it('allows remote jobs anywhere and never skips an empty location', () => {
    expect(check({ location: 'Remote - US' }).ok).toBe(true);
    expect(check({ location: 'Work from home' }).ok).toBe(true);
    expect(check({ location: '' }).ok).toBe(true);
  });
  it('skips other cities with the first line of the location, max 60 chars', () => {
    expect(reason({ location: 'Mumbai' })).toBe('location: Mumbai');
    expect(reason({ location: 'Gurugram\nHaryana, India' })).toBe('location: Gurugram');
    expect(reason({ location: 'N'.repeat(80) })).toBe(`location: ${'N'.repeat(60)}`);
  });
  it('an empty locations list allows anywhere', () => {
    expect(checkFilters(job({ location: 'Mumbai' }), { ...f, locations: [] }).ok).toBe(true);
  });
});

describe('normalizeTitle', () => {
  it.each([
    ['Sr. Front-End Dev (React) - Remote', 'senior frontend developer'],
    ['Senior Frontend Engineer', 'senior frontend engineer'],
    ['Front End Developer', 'frontend developer'],
    ['Full-Stack Engineer | Payments', 'fullstack engineer'],
    ['Full Stack Developer, Bengaluru', 'fullstack developer'],
    ['Back End Engineer', 'backend engineer'],
    ['Jr Software Engineer', 'junior software engineer'],
    ['  SDE   II  ', 'sde ii'],
    ['Software Engineer - II', 'software engineer'],
    ['Node.js Developer', 'node js developer'],
  ])('%s -> %s', (t, want) => {
    expect(normalizeTitle(t)).toBe(want);
  });
  it('treats variants of the same role as equal', () => {
    expect(normalizeTitle('Sr Frontend Dev')).toBe(normalizeTitle('Senior Front-end Developer'));
  });
  it('does not expand dev inside longer words', () => {
    expect(normalizeTitle('DevOps Engineer')).toBe('devops engineer');
  });
});

describe('normalizeCompany', () => {
  it.each([
    ['Acme Pvt. Ltd.', 'acme'],
    ['Acme Private Limited', 'acme'],
    ['ACME, Inc.', 'acme'],
    ['Acme LLC', 'acme'],
    ['Acme Corp', 'acme'],
    ['Acme Corporation', 'acme'],
    ['Acme Co.', 'acme'],
    ['Acme India Pvt Ltd', 'acme'],
    ['Acme Technologies Pvt Ltd', 'acme technologies'],
    ['  Acme   Labs  ', 'acme labs'],
    ['Co', 'co'],
    ['', ''],
  ])('%s -> %s', (c, want) => {
    expect(normalizeCompany(c)).toBe(want);
  });
  it('treats the same employer across sites as equal', () => {
    expect(normalizeCompany('Razorpay Software Pvt Ltd')).toBe(normalizeCompany('razorpay software'));
  });
});

describe('minExperience: review regressions', () => {
  it.each([
    ['between 3 and 5 years of experience', 3],
    ['between 4 and 6 years of experience', 4],
    ['3 years to 5 years of experience', 3],
    ['2 yrs - 4 yrs experience', 2],
    ['6 months to 2 years of experience', 0.5],
    ['3 or more years of experience', 3],
    ['3 yrs+ experience', 3],
  ])('%s -> %s', (text, want) => {
    expect(minExperience(text)).toBe(want);
  });
});

describe('instahyre titles (2026-11-02)', () => {
  const f = { ...testConfig().filters, excludeTitleKeywords: [...testConfig().filters.excludeTitleKeywords, 'sdet', 'backend developer', 'backend engineer'] };
  const job = (title: string) => ({ title, company: 'X', location: 'Bangalore', description: '' });
  it('skips SDET and backend-titled SDE roles, keeps full stack', () => {
    expect(checkFilters(job('SDET 1'), f).ok).toBe(false);
    expect(checkFilters(job('Backend Developer (SDE1)'), f).ok).toBe(false);
    expect(checkFilters(job('Fullstack Engineer'), f).ok).toBe(true);
    expect(checkFilters(job('SDE 1 - Frontend'), f).ok).toBe(true);
  });
});

describe('US work authorization (SPEC 7.5)', () => {
  const f = testConfig().filters;
  const job = (location: string, description: string) => ({ title: 'Software Engineer', company: 'X', location, description });
  it('skips US-only roles unless the location is open to India', () => {
    expect(checkFilters(job('Remote (US)', 'Must be authorized to work in the United States.'), f)).toEqual({ ok: false, reason: 'needs US work authorization' });
    expect(checkFilters(job('Remote', 'Visa sponsorship: Not Available\nBuild things'), f).ok).toBe(false);
    expect(checkFilters(job('Hyderabad', 'Visa sponsorship: Not Available'), f).ok).toBe(true);
    expect(checkFilters(job('Remote - Worldwide', 'We do not sponsor visas.'), f).ok).toBe(true);
    expect(checkFilters(job('Remote', 'Build React apps for US customers.'), f).ok).toBe(true);
  });
});
