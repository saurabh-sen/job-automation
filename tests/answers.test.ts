import { describe, expect, it, vi } from 'vitest';
import { Answerer, matchOption, type AnswerStore, type FieldKind, type LlmFn, type Question } from '../src/answers.js';
import { testConfig } from './helpers.js';

/** In-memory AnswerStore that records every write. */
function fakeStore(saved: Record<string, string> = {}) {
  const calls = { save: [] as Array<[string, string, string]>, pending: [] as Array<[string, string, string[], string]> };
  const store: AnswerStore = {
    getAnswer: (q) => saved[q] ?? null,
    saveAnswer: (q, a, s) => void calls.save.push([q, a, s]),
    addPending: (q, k, o, u) => void calls.pending.push([q, k, o, u]),
  };
  return { store, calls };
}

const JOB = { url: 'https://example.com/jobs/1', title: 'Frontend Engineer' };

function answerer(opts: { cfg?: Record<string, unknown>; saved?: Record<string, string>; dryRun?: boolean; llm?: LlmFn } = {}) {
  const { store, calls } = fakeStore(opts.saved);
  const a = new Answerer(testConfig(opts.cfg), store, JOB, { dryRun: opts.dryRun, llm: opts.llm });
  return { a, calls };
}

const ask = (label: string, kind: FieldKind = 'text', options?: string[]) => {
  const q: Question = options ? { label, kind, options } : { label, kind };
  return answerer().a.answer(q);
};

describe('matchOption', () => {
  it('prefers exact, case-insensitive', () => {
    expect(matchOption('yes', ['Yes, I am', 'Yes', 'No'])).toBe('Yes');
    expect(matchOption('B.Tech', ['b.tech', 'M.Tech'])).toBe('b.tech');
  });

  it('prefix matches on a word boundary', () => {
    expect(matchOption('Yes', ['Yes, I am', 'No, I am not'])).toBe('Yes, I am');
    expect(matchOption('No', ['None of the above', 'Not sure'])).toBeNull();
  });

  it('a bare number never picks a longer number', () => {
    expect(matchOption('1', ['15 days', '1 month', '2 months'])).toBe('1 month');
    expect(matchOption('1', ['15 days', '30 days'])).toBeNull();
    expect(matchOption('1', ['1.5 years', '1 year'])).toBe('1 year');
    expect(matchOption('3', ['1 year', '3 years', '30 years'])).toBe('3 years');
  });

  it('contains match for longer answers', () => {
    expect(matchOption('Bachelor', ["Master's degree", "Bachelor's degree"])).toBe("Bachelor's degree");
    expect(matchOption('no', ['I have none'])).toBeNull();
  });

  it('0 maps to Immediate', () => {
    expect(matchOption('0', ['Immediate', '15 days', '1 month'])).toBe('Immediate');
    expect(matchOption('0', ['Immediately available', '1 month'])).toBe('Immediately available');
  });

  it('numeric ranges', () => {
    expect(matchOption('3', ['0-2 years', '3-5 years', '5+ years'])).toBe('3-5 years');
    expect(matchOption('4', ['0 - 2 Years', '3 to 5 Years', 'More than 5'])).toBe('3 to 5 Years');
    expect(matchOption('4', ['1–3 yrs', '3–5 yrs'])).toBe('3–5 yrs');
  });

  it('plus, less than and more than', () => {
    expect(matchOption('7', ['0-2 years', '3-5 years', '5+ years'])).toBe('5+ years');
    expect(matchOption('7', ['Less than 5', 'More than 5'])).toBe('More than 5');
    expect(matchOption('2', ['Less than 3 years', 'More than 3 years'])).toBe('Less than 3 years');
    expect(matchOption('6', ['upto 5', 'above 5'])).toBe('above 5');
  });

  it('returns null when nothing fits', () => {
    expect(matchOption('Maybe', ['Yes', 'No'])).toBeNull();
    expect(matchOption('', ['Yes'])).toBeNull();
    expect(matchOption('9', ['1-3 years', '4-6 years'])).toBeNull();
  });
});

describe('profile rules', () => {
  it('names and contact details', async () => {
    expect(await ask('First name')).toBe('Test');
    expect(await ask('Last Name')).toBe('User');
    expect(await ask('Surname')).toBe('User');
    expect(await ask('Full name')).toBe('Test User');
    expect(await ask('Name')).toBe('Test User');
    expect(await ask('Email address')).toBe('test.user@example.com');
    expect(await ask('E-mail')).toBe('test.user@example.com');
    expect(await ask('Country code')).toBe('+91');
    expect(await ask('Phone country code', 'select', ['India (+91)', 'United States (+1)'])).toBe('India (+91)');
  });

  it('phone: digits only for number fields and "without country code"', async () => {
    expect(await ask('Mobile phone number')).toBe('9000000000');
    expect(await ask('Mobile phone number', 'number')).toBe('9000000000');
    expect(await ask('Contact number (without country code)')).toBe('9000000000');
    const { a } = answerer({ cfg: { profile: { ...testConfig().profile, phone: '+91 90000 00000' } } });
    expect(await a.answer({ label: 'Phone (without country code)', kind: 'text' })).toBe('9000000000');
    expect(await a.answer({ label: 'Phone', kind: 'number' })).toBe('9000000000');
    expect(await a.answer({ label: 'Phone', kind: 'text' })).toBe('+91 90000 00000');
  });

  it('links; empty portfolio is unanswered', async () => {
    expect(await ask('LinkedIn profile URL')).toBe('https://www.linkedin.com/in/test-user');
    expect(await ask('GitHub')).toBe('https://github.com/test-user');
    expect(await ask('Portfolio / website')).toBeNull();
  });

  it('"how did you hear" is not a URL question (custom answer wins anyway)', async () => {
    expect(await ask('How did you hear about us? (LinkedIn, website, referral)')).toBe('LinkedIn');
    const { a } = answerer({ cfg: { customAnswers: [] } });
    expect(await a.answer({ label: 'Source: LinkedIn, website or referral?', kind: 'text' })).toBeNull();
  });

  it('city / current location / where are you based', async () => {
    expect(await ask('City')).toBe('Hyderabad');
    expect(await ask('Current location')).toBe('Hyderabad');
    expect(await ask('Where are you currently based?')).toBe('Hyderabad');
    expect(await ask('Location (city)', 'text')).toBe('Hyderabad');
    expect(await ask('Preferred city')).toBeNull();
  });

  it('notice period in days by default, months when asked', async () => {
    expect(await ask('Notice period (in days)', 'number')).toBe('30');
    expect(await ask('What is your notice period?')).toBe('30');
    expect(await ask('Notice period in months')).toBe('1');
    expect(await ask('How soon can you join?', 'select', ['Immediate', '15 days or less', '1 month', '2 months', '3 months']))
      .toBe('1 month');
    expect(await ask('Notice period', 'radio', ['15 days or less', '1 month', 'More than 1 month'])).toBe('1 month');
    expect(await ask('Earliest joining date', 'select', ['0-15 days', '16-30 days', '31-60 days'])).toBe('16-30 days');
  });

  it('notice period 0 maps to Immediate; "serving notice" is a different question', async () => {
    const { a } = answerer({ cfg: { profile: { ...testConfig().profile, noticePeriodDays: 0 } } });
    expect(await a.answer({ label: 'Notice period', kind: 'select', options: ['Immediate', '15 days', '1 month'] })).toBe('Immediate');
    expect(await ask('Are you serving notice period?', 'radio', ['Yes', 'No'])).toBeNull();
  });

  it('CTC: lakhs vs rupees, current vs expected', async () => {
    expect(await ask('Expected CTC (in lakhs)')).toBe('15');
    expect(await ask('Expected CTC (in lakhs)', 'number')).toBe('15');
    expect(await ask('Current CTC in LPA', 'number')).toBe('10');
    expect(await ask('Current CTC (in L)')).toBe('10');
    expect(await ask('Current CTC', 'number')).toBe('1000000');
    expect(await ask('Expected salary', 'number')).toBe('1500000');
    expect(await ask('Current CTC')).toBe('10 LPA');
    expect(await ask('What is your expected compensation?')).toBe('15 LPA');
    expect(await ask('Current annual package (lacs)')).toBe('10');
  });

  it('"preferred place of work" does not hit the CTC rule', async () => {
    expect(await ask('Preferred place of work')).toBeNull();
    expect(await ask('Preferred place of work', 'number')).toBeNull();
  });

  it('yes/no policies', async () => {
    expect(await ask('Are you willing to relocate?', 'radio', ['Yes', 'No'])).toBe('Yes');
    expect(await ask('Are you comfortable working on-site?', 'radio', ['Yes', 'No'])).toBe('Yes');
    expect(await ask('Are you okay to work from office 5 days a week?', 'select', ['Yes', 'No'])).toBe('Yes');
    expect(await ask('This is a hybrid role. Is that OK?', 'radio', ['Yes', 'No'])).toBe('Yes');
    expect(await ask('Will you now or in the future require visa sponsorship?', 'radio', ['Yes', 'No'])).toBe('No');
    expect(await ask('Are you legally authorized to work in India?', 'radio', ['Yes', 'No'])).toBe('Yes');
    expect(await ask('Are you authorized to work in the United States?', 'radio', ['Yes', 'No'])).toBeNull();
    expect(await ask("Have you completed a Bachelor's degree?", 'radio', ['Yes', 'No'])).toBe('Yes');
    expect(await ask("Have you completed a Master's degree?", 'radio', ['Yes', 'No'])).toBe('No');
  });

  it('respects false profile flags', async () => {
    const { a } = answerer({ cfg: { profile: { ...testConfig().profile, willingToRelocate: false, okWithOnsite: false } } });
    expect(await a.answer({ label: 'Willing to relocate?', kind: 'radio', options: ['Yes', 'No'] })).toBe('No');
    expect(await a.answer({ label: 'Can you commute to the office?', kind: 'radio', options: ['Yes', 'No'] })).toBe('No');
  });

  it('education and current job', async () => {
    expect(await ask('Highest qualification')).toBe('B.Tech');
    expect(await ask('Highest degree', 'select', ['High school', "Bachelor's", "Master's"])).toBe("Bachelor's");
    expect(await ask('Graduation year')).toBe('2022');
    expect(await ask('Year of passing', 'number')).toBe('2022');
    expect(await ask('Current company')).toBe('ExampleCorp');
    expect(await ask('Current employer')).toBe('ExampleCorp');
    expect(await ask('Current designation')).toBe('Software Development Engineer 1');
  });

  it('total years of experience, floored', async () => {
    expect(await ask('How many years of experience do you have?', 'number')).toBe('3');
    expect(await ask('Total years of experience')).toBe('3');
    expect(await ask('Total experience (years)', 'select', ['0-2 years', '3-5 years', '5+ years'])).toBe('3-5 years');
  });

  it('years per skill, with aliases; unknown skill is never the total', async () => {
    expect(await ask('How many years of work experience do you have with React.js?', 'number')).toBe('3');
    expect(await ask('Years of experience in ReactJS')).toBe('3');
    expect(await ask('How many years of experience do you have using Node?', 'number')).toBe('1');
    expect(await ask('Years of experience with TS')).toBe('3');
    expect(await ask('Years of experience with AngularJS', 'number')).toBe('1');
    expect(await ask('How many years of experience do you have with Python?', 'number')).toBeNull();
    expect(await ask('Years of experience in Kubernetes')).toBeNull();
    expect(await ask('How many years of React Native experience do you have?', 'number')).toBeNull();
  });

  it('"do you have experience with <skill>" yes/no', async () => {
    expect(await ask('Do you have experience with TypeScript?', 'radio', ['Yes', 'No'])).toBe('Yes');
    expect(await ask('Do you have experience with Angular?', 'radio', ['Yes', 'No'])).toBe('Yes');
    expect(await ask('Do you have experience with Golang?', 'radio', ['Yes', 'No'])).toBeNull();
  });

  it('anything else is unanswered', async () => {
    expect(await ask('Why do you want to join us?', 'textarea')).toBeNull();
    expect(await ask('What is your favourite colour?')).toBeNull();
  });
});

describe('Answerer order and safety', () => {
  it('saved answers come first, then customAnswers, then profile', async () => {
    const { a } = answerer({ saved: { City: 'Pune' } });
    expect(await a.answer({ label: 'City', kind: 'text' })).toBe('Pune');
    const custom = answerer({ cfg: { customAnswers: [{ match: '^city$', answer: 'Chennai' }] } });
    expect(await custom.a.answer({ label: 'City', kind: 'text' })).toBe('Chennai');
    expect(await custom.a.answer({ label: 'Current city', kind: 'text' })).toBe('Hyderabad');
  });

  it('saved answers are matched onto the options', async () => {
    const { a } = answerer({ saved: { 'Shift preference': 'night' } });
    expect(await a.answer({ label: 'Shift preference', kind: 'select', options: ['Day shift', 'Night shift'] })).toBe('Night shift');
  });

  it('never returns a TODO value', async () => {
    const saved = answerer({ saved: { 'Favourite framework': 'TODO' } });
    expect(await saved.a.answer({ label: 'Favourite framework', kind: 'text' })).toBeNull();
    // config validation already rejects TODO values; this guards against one slipping through
    const cfg = testConfig();
    cfg.customAnswers = [{ match: 'framework', answer: 'TODO: fill' }];
    const custom = new Answerer(cfg, fakeStore().store, JOB);
    expect(await custom.answer({ label: 'Favourite framework', kind: 'text' })).toBeNull();
    // a TODO saved answer falls through to the profile rule rather than being used
    const city = answerer({ saved: { City: 'todo' } });
    expect(await city.a.answer({ label: 'City', kind: 'text' })).toBe('Hyderabad');
  });

  it('never returns blank values', async () => {
    const { a } = answerer({ saved: { 'Cover note': '   ' } });
    expect(await a.answer({ label: 'Cover note', kind: 'textarea' })).toBeNull();
  });

  it('records unanswered required questions once and queues them for review', async () => {
    const { a, calls } = answerer();
    const q: Question = { label: 'Why us?', kind: 'textarea' };
    expect(await a.answer(q)).toBeNull();
    expect(await a.answer(q)).toBeNull();
    expect(await a.answer({ label: 'Optional note', kind: 'text' }, false)).toBeNull();
    expect(a.unanswered.map((u) => u.label)).toEqual(['Why us?']);
    expect(calls.pending[0]).toEqual(['Why us?', 'textarea', [], JOB.url]);
    expect(calls.pending.every((p) => p[0] !== 'Optional note')).toBe(true);
  });

  it('dry run writes nothing to the store', async () => {
    const llm = vi.fn<LlmFn>(async () => ({ answer: 'Yes', confident: true }));
    const { a, calls } = answerer({ dryRun: true, cfg: { ollama: { enabled: true } }, llm });
    expect(await a.answer({ label: 'Why us?', kind: 'textarea' })).toBe('Yes');
    expect(await a.answer({ label: 'Pick one', kind: 'radio', options: ['A', 'B'] })).toBeNull();
    expect(a.unanswered.map((u) => u.label)).toEqual(['Pick one']);
    expect(calls.save).toEqual([]);
    expect(calls.pending).toEqual([]);
  });

  it('Ollama disabled: llm is never called', async () => {
    const llm = vi.fn<LlmFn>(async () => ({ answer: 'Yes', confident: true }));
    const { a } = answerer({ llm });
    expect(await a.answer({ label: 'Why us?', kind: 'textarea' })).toBeNull();
    expect(llm).not.toHaveBeenCalled();
  });

  it('Ollama enabled: used only when confident, never persisted', async () => {
    const replies: unknown[] = [{ answer: 'Maybe', confident: false }, { answer: 'Remote', confident: true }, null];
    const llm = vi.fn<LlmFn>(async () => replies.shift() ?? null);
    const { a, calls } = answerer({ cfg: { ollama: { enabled: true } }, llm });
    expect(await a.answer({ label: 'Q1', kind: 'text' })).toBeNull();
    expect(await a.answer({ label: 'Q2', kind: 'text' })).toBe('Remote');
    expect(await a.answer({ label: 'Q3', kind: 'text' })).toBeNull();
    expect(calls.save).toEqual([]);
    expect(a.unanswered.map((u) => u.label)).toEqual(['Q1', 'Q3']);
  });

  it('Ollama answers must fit the options and never be TODO', async () => {
    const replies: unknown[] = [{ answer: 'Perhaps', confident: true }, { answer: 'TODO', confident: true }];
    const llm = vi.fn<LlmFn>(async () => replies.shift() ?? null);
    const { a } = answerer({ cfg: { ollama: { enabled: true } }, llm });
    expect(await a.answer({ label: 'Pick', kind: 'radio', options: ['Yes', 'No'] })).toBeNull();
    expect(await a.answer({ label: 'Text', kind: 'text' })).toBeNull();
  });

  it('a throwing llm counts as no answer', async () => {
    const llm = vi.fn<LlmFn>(async () => { throw new Error('down'); });
    const { a } = answerer({ cfg: { ollama: { enabled: true } }, llm });
    expect(await a.answer({ label: 'Why us?', kind: 'textarea' })).toBeNull();
  });
});

describe('review regressions: never a confident wrong answer', () => {
  const ask = async (label: string, kind: FieldKind = 'text', options?: string[]) => {
    const a = new Answerer(testConfig(), fakeStore().store, { url: 'u', title: 't' }, { dryRun: true });
    return a.answer({ label, kind, options });
  };
  const yn = ['Yes', 'No'];

  it('degree rule skips years, marks, colleges and current study', async () => {
    expect(await ask('Have you completed your Bachelor\'s degree?', 'radio', yn)).toBe('Yes');
    for (const q of ['Are you a 2025 graduate?', 'Have you graduated from a Tier 1 college (IIT/NIT/BITS)?',
      'Is your graduation percentage above 60%?', 'Are you currently pursuing a degree?']) {
      expect(await ask(q, 'radio', yn)).toBeNull();
    }
  });

  it('work authorization and sponsorship only for India or no country', async () => {
    expect(await ask('Are you legally authorized to work?', 'radio', yn)).toBe('Yes');
    expect(await ask('Are you legally authorized to work in India?', 'radio', yn)).toBe('Yes');
    expect(await ask('Are you legally authorized to work in Japan?', 'radio', yn)).toBeNull();
    expect(await ask('Are you legally authorized to work in Mexico?', 'radio', yn)).toBeNull();
    expect(await ask('Will you require visa sponsorship to work in the US?', 'radio', yn)).toBeNull();
    expect(await ask('Will you require sponsorship?', 'radio', yn)).toBe('No');
  });

  it('CTC rule skips yes/no, hikes, monthly and variable pay', async () => {
    expect(await ask('Current CTC', 'number')).toBe('1000000');
    for (const [q, k] of [['Are you okay with the offered salary?', 'text'], ['Are you comfortable with a CTC of 12 LPA?', 'text'],
      ['Expected salary hike (%)', 'number'], ['Expected hike percentage in CTC', 'number'], ['Current monthly salary', 'number'],
      ['Variable component of current CTC', 'number'], ['Is the salary range of 8-10 LPA acceptable?', 'text']] as const) {
      expect(await ask(q, k)).toBeNull();
    }
  });

  it('every named skill must be known', async () => {
    expect(await ask('Do you have experience with Kotlin and React?', 'radio', yn)).toBeNull();
    expect(await ask('Years of experience in Java and JavaScript', 'number')).toBeNull();
    expect(await ask('Years of experience in React and TypeScript', 'number')).toBe('3');
    for (const s of ['Express.js', 'Vue.js', 'Next.js', 'D3.js']) {
      expect(await ask(`How many years of experience do you have with ${s}?`, 'number')).toBeNull();
    }
  });

  it('contact and current-job rules only for field-style labels', async () => {
    expect(await ask('How many years of experience do you have in mobile app development?', 'number')).toBeNull();
    expect(await ask('Have you worked on email marketing platforms?')).toBeNull();
    expect(await ask('Why do you want to leave your current company?', 'textarea')).toBeNull();
    expect(await ask('Mobile number')).toBe('9000000000');
    expect(await ask('Email address')).toBe('test.user@example.com');
  });

  it('contains-matching respects word boundaries', () => {
    expect(matchOption('Yes', ['Yesterday', 'No'])).toBeNull();
    expect(matchOption('Pune', ['Puneet Nagar', 'Delhi'])).toBeNull();
  });
});

describe('country code and country', () => {
  const ask = async (label: string, kind: FieldKind, options?: string[], countryCode = '91') => {
    const cfg = testConfig({ profile: { ...testConfig().profile, countryCode } });
    return new Answerer(cfg, fakeStore().store, { url: 'u', title: 't' }, { dryRun: true }).answer({ label, kind, options });
  };
  const opts = ['Andorra (+376)', 'United States (+1)', 'India (+91)', 'Indonesia (+62)'];
  it('maps a bare or + country code onto LinkedIn options', async () => {
    expect(await ask('Phone country code', 'select', opts, '91')).toBe('India (+91)');
    expect(await ask('Phone country code', 'select', opts, '+91')).toBe('India (+91)');
    expect(await ask('Country code', 'text', undefined, '91')).toBe('+91');
  });
  it('country is India only for +91', async () => {
    expect(await ask('Country', 'select', ['India', 'United States'])).toBe('India');
    expect(await ask('Country', 'select', ['India', 'United States'], '+1')).toBeNull();
  });
});

describe('education dropdowns', () => {
  const degrees = ['Bachelor of Arts (B.A.)', 'Bachelor of Technology (B.Tech.)', 'Bachelor of Engineering (B.E.)', 'Master of Technology (M.Tech.)'];
  const ask = async (label: string, options: string[], fieldOfStudy: string | string[] = '') => {
    const cfg = testConfig({ profile: { ...testConfig().profile, fieldOfStudy } });
    return new Answerer(cfg, fakeStore().store, { url: 'u', title: 't' }, { dryRun: true }).answer({ label, kind: 'select', options });
  };
  it('degree dropdown gets the highest degree', async () => {
    expect(await ask('Education Degree', degrees)).toBe('Bachelor of Technology (B.Tech.)');
    expect(await ask('Have you completed your degree?', ['Yes', 'No'])).toBe('Yes');
  });
  it('field of study only when configured', async () => {
    expect(await ask('Education Field of Study', ['Computer Engineering', 'Computer Science', 'Finance'])).toBeNull();
    expect(await ask('Education Field of Study', ['Computer Engineering', 'Computer Science', 'Finance'], 'Computer Science')).toBe('Computer Science');
  });
});

describe('field of study preferences', () => {
  it('takes the first accepted name the dropdown offers', async () => {
    const cfg = testConfig({ profile: { ...testConfig().profile, fieldOfStudy: ['Computer Science', 'Computer and Information Science', 'Computer Engineering'] } });
    const a = new Answerer(cfg, fakeStore().store, { url: 'u', title: 't' }, { dryRun: true });
    expect(await a.answer({ label: 'Education Field of Study', kind: 'select', options: ['Computer Engineering', 'Computer and Information Science', 'Finance'] }))
      .toBe('Computer and Information Science');
  });
});

describe('job-location eligibility and declarations', () => {
  const ask = async (label: string, options: string[], location: string) =>
    new Answerer(testConfig(), fakeStore().store, { url: 'u', title: 't', location }, { dryRun: true }).answer({ label, kind: 'select', options });
  const q = 'Declaration Are you legally eligible to work in the country where this position is located?';
  it('Yes only when the job is in India', async () => {
    expect(await ask(q, ['Yes', 'No'], 'Greater Bengaluru Area (On-site)')).toBe('Yes');
    expect(await ask(q, ['Yes', 'No'], 'San Francisco, CA')).toBeNull();
    expect(await ask(q, ['Yes', 'No'], '')).toBeNull();
  });
  it('agrees to a truthfulness declaration only via an agreeing option', async () => {
    const d = 'I undertake that the information provided by me is true and accurate.';
    expect(await ask(d, ['Yes', 'No'], 'Bengaluru')).toBe('Yes');
    expect(await ask(d, ['I agree'], 'Bengaluru')).toBe('I agree');
    expect(await ask(d, ['Option A', 'Option B'], 'Bengaluru')).toBeNull();
  });
});

describe('previous employers', () => {
  const ask = async (label: string) => {
    const cfg = testConfig({ profile: { ...testConfig().profile, currentCompany: 'ExampleCorp', previousEmployers: ['Globex Systems Limited'] } });
    return new Answerer(cfg, fakeStore().store, { url: 'u', title: 't' }, { dryRun: true }).answer({ label, kind: 'radio', options: ['Yes', 'No'] });
  };
  it('Yes only for a listed or current employer; similar names are not the same company', async () => {
    expect(await ask('Were you previously employed with Globexstar?')).toBe('No');
    expect(await ask('Were you previously employed at PhonePe? (as a Full-Time / contract / Intern)')).toBe('No');
    expect(await ask('Have you previously worked with Globex Systems?')).toBe('Yes');
    expect(await ask('Have you ever worked at ExampleCorp before?')).toBe('Yes');
  });
});

describe('join date, current location and category questions', () => {
  const ask = async (label: string, options: string[], noticePeriodDays = 30) => {
    const cfg = testConfig({ profile: { ...testConfig().profile, noticePeriodDays } });
    return new Answerer(cfg, fakeStore().store, { url: 'u', title: 't' }, { dryRun: true }).answer({ label, kind: 'radio', options });
  };
  it('join within N days follows the notice period', async () => {
    expect(await ask('Can you join within 15-20 days?', ['Yes', 'No'], 15)).toBe('Yes');
    expect(await ask('Can you join within 15-20 days?', ['Yes', 'No'], 30)).toBe('No');
    expect(await ask('Can you join within 1 month?', ['Yes', 'No'], 30)).toBe('Yes');
  });
  it('current location yes/no, and fresher vs experienced', async () => {
    expect(await ask('Current Location?- Hyderabad', ['Yes', 'No'])).toBe('Yes');
    expect(await ask('Current Location?- Pune', ['Yes', 'No'])).toBe('No');
    expect(await ask('Please select your current professional category', ['Fresher', 'Experienced'])).toBe('Experienced');
  });
});
