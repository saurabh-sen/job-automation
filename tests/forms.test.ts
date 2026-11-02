import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Answerer, type AnswerStore } from '../src/answers.js';
import { fillFields, fixLpaFields } from '../src/forms.js';
import { setActionDelay } from '../src/utils.js';
import { testConfig } from './helpers.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const store: AnswerStore = { getAnswer: () => null, saveAnswer: () => {}, addPending: () => {} };
const JOB = { url: 'https://example.com/jobs/1', title: 'Frontend Engineer' };

let browser: Browser;
let page: Page;
let requests = 0;

beforeAll(async () => {
  setActionDelay([0, 0]);
  // Runs the installed Chrome. If it can't launch, this throws and the whole suite fails (never skipped).
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

afterAll(async () => {
  await browser?.close();
  setActionDelay([500, 2000]);
});

beforeEach(async () => {
  page = await browser.newPage();
  requests = 0;
});

afterEach(async () => {
  await page.close();
});

/** Loads a fixture and records any submit, button click or network request it would make. */
async function load(name: string) {
  await page.setContent(fixture(name));
  page.on('request', () => void requests++);
  // DOM boundary: counters live on window so the test can read them back.
  await page.evaluate(() => {
    const w = window as unknown as { __submits: number; __buttonClicks: number };
    w.__submits = 0;
    w.__buttonClicks = 0;
    // without this, browser validation would swallow a submit attempt on a half-filled form
    document.querySelectorAll('form').forEach((f) => { f.noValidate = true; });
    document.addEventListener('submit', (e) => { e.preventDefault(); w.__submits++; }, true);
    document.addEventListener('click', (e) => {
      if ((e.target as Element | null)?.closest('button, [type="submit"], [role="button"]')) w.__buttonClicks++;
    }, true);
  });
}

async function expectNothingSubmitted() {
  const counts = await page.evaluate(() => {
    const w = window as unknown as { __submits: number; __buttonClicks: number };
    return { submits: w.__submits, buttonClicks: w.__buttonClicks };
  });
  expect(counts).toEqual({ submits: 0, buttonClicks: 0 });
  expect(requests).toBe(0);
}

const answerer = () => new Answerer(testConfig(), store, JOB, { dryRun: true });
const value = (sel: string) => page.locator(sel).inputValue();
const selected = (sel: string) => page.locator(sel).evaluate((s: HTMLSelectElement) => s.options[s.selectedIndex]?.text ?? '');
const checked = (sel: string) => page.locator(sel).isChecked();

describe('fillFields', () => {
  it('LinkedIn-like Easy Apply step', async () => {
    await load('linkedin-easy-apply.html');
    const answers = answerer();
    const res = await fillFields(page, page.locator('[role="dialog"]'), answers);

    expect(await value('#first-name')).toBe('Prefilled'); // pre-filled: untouched
    expect(await value('#last-name')).toBe('User'); // "Last nameLast name" screen-reader label
    expect(await selected('#email-select')).toBe('test.user@example.com');
    expect(await selected('#cc-select')).toBe('India (+91)'); // pre-selected: untouched
    expect(await value('#phone')).toBe('9000000000');
    expect(await value('#city')).toBe('Hyderabad, Telangana, India'); // first typeahead suggestion picked
    expect(await value('#react-years')).toBe('3');
    expect(await checked('#hybrid-yes')).toBe(true); // hidden radio, clicked via its label
    expect(await checked('#hybrid-no')).toBe(false);
    expect(await selected('#ts-exp')).toBe('Yes');
    expect(await value('#why')).toBe('');
    expect(await checked('#follow-company-checkbox')).toBe(true); // optional checkbox: untouched
    expect(await checked('#remember')).toBe(false);

    expect(res.missing).toEqual([{ label: 'Why do you want to work at Example Co?', kind: 'textarea' }]);
    expect(res.filled).toBe(7);
    expect(answers.unanswered.map((q) => q.label)).toEqual(['Why do you want to work at Example Co?']);
    await expectNothingSubmitted();
  });

  it('Naukri-like / generic form', async () => {
    await load('generic-form.html');
    const res = await fillFields(page, page.locator('form'), answerer());

    expect(await value('[name="fullname"]')).toBe('Test User'); // wrapping label with "*"
    expect(await value('[name="em"]')).toBe('test.user@example.com'); // aria-label
    expect(await value('[name="loc"]')).toBe('Bengaluru'); // pre-filled: untouched
    expect(await value('[name="ctc"]')).toBe('10'); // nearby text "(in lakhs) *"
    expect(await checked('[name="np"][value="30"]')).toBe(true); // "1 Month"
    expect(await selected('#qual')).toBe('B.Tech/B.E.');
    expect(await selected('#relocate')).toBe('Yes'); // optional but answerable
    expect(await value('#q9')).toBe('');
    expect(await value('#q10')).toBe(''); // optional and unknown: left empty, not missing
    expect(await value('[name="ref"]')).toBe(''); // disabled: ignored
    expect(await checked('[name="terms"]')).toBe(true); // required checkbox ticked
    expect(await checked('[name="news"]')).toBe(false); // optional checkbox untouched

    expect(res.missing.map((q) => q.label)).toEqual(['Describe your biggest achievement']);
    await expectNothingSubmitted();
  });

  it('tricky labels', async () => {
    await load('tricky-labels.html');
    const res = await fillFields(page, page.locator('#tricky'), answerer());

    expect(await value('#place')).toBe(''); // "place" must not trigger the CTC rule
    expect(await value('#exp-ctc')).toBe('15');
    expect(await value('#cur-ctc')).toBe('1000000');
    expect(await selected('#notice')).toBe('1 month');
    expect(await value('#py')).toBe(''); // no Python years in the profile: never the total
    expect(await value('#mail')).toBe('test.user@example.com'); // placeholder only
    expect(await value('#li')).toBe('https://www.linkedin.com/in/test-user'); // aria-labelledby
    expect(await value('#gh')).toBe('https://github.com/test-user'); // shared container: "Email" text must not leak
    expect(await value('#other')).toBe('');
    expect(await checked('[name="auth"][value="y"]')).toBe(true); // role=radiogroup aria-labelledby
    expect(await selected('#sponsor')).toBe('No');
    expect(await selected('#sponsor2')).toBe('No'); // browser-default "Yes" is not a pre-filled answer
    expect(await selected('#night')).toBe('Yes'); // unanswerable: left as is, reported missing
    expect(await value('#hear')).toBe('LinkedIn'); // customAnswers
    expect(await checked('#confirm')).toBe(true); // display:none checkbox ticked via its label
    expect(await value('#dob')).toBe(''); // read-only: untouched

    expect(res.missing).toEqual([
      { label: 'Preferred place of work', kind: 'text' },
      { label: 'How many years of experience do you have with Python?', kind: 'number' },
      { label: 'Are you okay with night shifts?', kind: 'select', options: ['Yes', 'No'] },
    ]);
    await expectNothingSubmitted();
  });

  it('the submit listener does catch a submission (control)', async () => {
    await load('generic-form.html');
    await page.getByRole('button', { name: 'Apply' }).click();
    const counts = await page.evaluate(() => {
      const w = window as unknown as { __submits: number; __buttonClicks: number };
      return { submits: w.__submits, buttonClicks: w.__buttonClicks };
    });
    expect(counts).toEqual({ submits: 1, buttonClicks: 1 });
  });

  it('a second scan of the same form fills nothing new', async () => {
    await load('generic-form.html');
    await fillFields(page, page.locator('form'), answerer());
    const again = await fillFields(page, page.locator('form'), answerer());
    expect(again.filled).toBe(0);
    expect(again.missing.map((q) => q.label)).toEqual(['Describe your biggest achievement']);
    await expectNothingSubmitted();
  });

  it('ticks consent boxes, but treats claim checkboxes as questions', async () => {
    await load('generic-form.html');
    await page.setContent(`<form>
      <label><input type="checkbox" id="terms" required> I agree to the terms and conditions *</label>
      <label><input type="checkbox" id="kotlin" required> I have 5+ years of Kotlin experience *</label>
    </form>`);
    const r = await fillFields(page, page.locator('form'), new Answerer(testConfig(), store, JOB, { dryRun: true }));
    expect(await page.locator('#terms').isChecked()).toBe(true);
    expect(await page.locator('#kotlin').isChecked()).toBe(false);
    expect(r.missing.map((m) => m.label)).toEqual([expect.stringMatching(/kotlin/i)]);
  });
});

describe('custom dropdowns', () => {
  it('an empty required div[role=combobox] is reported as unanswered', async () => {
    await page.setContent(`<form>
      <span id="deg">Education Degree*</span><div role="combobox" aria-labelledby="deg" tabindex="0"></div>
      <span id="opt">Minor</span><div role="combobox" aria-labelledby="opt" tabindex="0"></div>
      <span id="set">Field of Study*</span><div role="combobox" aria-labelledby="set" tabindex="0">Computer Science</div>
    </form>`);
    const r = await fillFields(page, page.locator('form'), new Answerer(testConfig(), store, JOB, { dryRun: true }));
    expect(r.missing.map((m) => m.label)).toEqual(['Education Degree']);
  });
});

describe('LinkedIn new-layout radios', () => {
  it('question from the shared aria-label, options from the text next to empty labels', async () => {
    await page.setContent(`<form><fieldset role="radiogroup"><div>
      <div><div><input id="a" aria-label="Can you join within 15-20 days?" type="radio" name="g"><label for="a"></label></div><div><p>Yes</p></div></div>
      <div><div><input id="b" aria-label="Can you join within 15-20 days?" type="radio" name="g"><label for="b"></label></div><div><p>No</p></div></div>
    </div></fieldset></form>`);
    const seen: Array<{ label: string; options?: string[] }> = [];
    const answers = new Answerer(testConfig(), store, JOB, { dryRun: true });
    const orig = answers.answer.bind(answers);
    answers.answer = async (q, r) => { seen.push({ label: q.label, options: q.options }); return orig(q, r); };
    await fillFields(page, page.locator('form'), answers);
    expect(seen[0]).toEqual({ label: 'Can you join within 15-20 days?', options: ['Yes', 'No'] });
  });
});

describe('CTC: LPA falls back to rupees', () => {
  it('a numbers-only field gets 1000000 instead of "10 LPA"', async () => {
    await page.setContent(`<form><label for="c">Current CTC*</label><input id="c" type="text" inputmode="numeric" pattern="[0-9]+" required></form>`);
    await fillFields(page, page.locator('form'), new Answerer(testConfig(), store, JOB, { dryRun: true }));
    expect(await page.locator('#c').inputValue()).toBe('1000000');
  });
  it('fixLpaFields swaps an invalid "15 LPA" after a rejection', async () => {
    await page.setContent(`<form><input id="e" type="text" value="15 LPA" aria-invalid="true"><input id="ok" type="text" value="15 LPA"></form>`);
    expect(await fixLpaFields(page.locator('form'))).toBe(1);
    expect(await page.locator('#e').inputValue()).toBe('1500000');
    expect(await page.locator('#ok').inputValue()).toBe('15 LPA');
  });
});
