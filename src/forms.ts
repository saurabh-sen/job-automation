import type { Locator, Page } from 'playwright-core';
import type { Answerer, FieldKind, Question } from './answers.js';
import { pause } from './utils.js';

export interface FillResult {
  /** Fields this call filled, selected or ticked. */
  filled: number;
  /** Required questions with no answer (or that could not be filled). Non-empty means: abandon the form. */
  missing: Question[];
}

interface FieldDesc {
  idx: number;
  kind: FieldKind;
  label: string;
  options: string[];
  /** For selects: the <option> index of each entry in `options`. */
  optionIndex: number[];
  value: string;
  required: boolean;
  /** Radios/checkboxes whose input is visually hidden: click the label instead. */
  useLabel: boolean;
}

const ACTION_TIMEOUT = 5000;

/**
 * Finds every visible, enabled form field inside `root`, tags it with data-ja="<idx>" and returns
 * its label, kind, options, current value and whether it's required. Works on any site's form markup.
 */
async function scanFields(root: Locator): Promise<FieldDesc[]> {
  // tsx (esbuild keepNames) wraps the named helpers below in __name(...), which doesn't exist in the page
  await root.page().evaluate('globalThis.__name = globalThis.__name || ((f) => f)');
  // DOM boundary: this callback runs in the page, so it only uses browser APIs.
  return root.evaluate((rootEl: Element) => {
    const doc = rootEl.ownerDocument;
    const CONTROLS = 'input:not([type="hidden"]), select, textarea';

    const collapse = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    /** LinkedIn repeats labels for screen readers: "Q Q" or "QQ" -> "Q". */
    const undouble = (t: string) => {
      const w = t.split(' ');
      if (w.length > 1 && w.length % 2 === 0 && w.slice(0, w.length / 2).join(' ') === w.slice(w.length / 2).join(' ')) {
        return w.slice(0, w.length / 2).join(' ');
      }
      if (t.length > 1 && t.length % 2 === 0 && t.slice(0, t.length / 2) === t.slice(t.length / 2)) return t.slice(0, t.length / 2);
      return t;
    };
    const MARKERS = /\((required|optional)\)|\*/gi;
    const clean = (s: string | null | undefined) => undouble(collapse(undouble(collapse(s)).replace(MARKERS, ' ')));
    const isMarkedRequired = (raw: string) => /\*|\(required\)/i.test(raw);
    const isMarkedOptional = (raw: string) => /\(optional\)/i.test(raw);

    const shown = (el: Element | null | undefined) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && st.visibility !== 'hidden' && st.opacity !== '0';
    };
    const rendered = (el: Element | null | undefined) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return (r.width > 0 || r.height > 0) && getComputedStyle(el).visibility !== 'hidden';
    };
    /** Text of an element, without the text of any controls inside it (e.g. a wrapping label's <option>s). */
    const textOf = (el: Element | null | undefined): string => {
      if (!el) return '';
      if (!el.querySelector(CONTROLS)) return (el as HTMLElement).innerText ?? el.textContent ?? '';
      const copy = el.cloneNode(true) as Element;
      copy.querySelectorAll('input, select, textarea').forEach((c) => c.remove());
      return copy.textContent ?? '';
    };
    const labelEl = (el: Element): HTMLElement | null => {
      if (el.id) {
        const l = doc.querySelector<HTMLElement>(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return l;
      }
      return el.closest('label');
    };
    const controlsIn = (el: Element) => Array.from(el.querySelectorAll(CONTROLS)).filter((c) => (c as HTMLInputElement).type !== 'hidden');

    /** Raw label text (markers kept, so callers can detect "*" / "(required)"). */
    const rawLabel = (el: HTMLElement): string => {
      if (el.id) {
        const l = doc.querySelector<HTMLElement>(`label[for="${CSS.escape(el.id)}"]`);
        if (l && clean(textOf(l))) return textOf(l);
      }
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const t = by.split(/\s+/).map((id) => textOf(doc.getElementById(id))).join(' ');
        if (clean(t)) return t;
      }
      const aria = el.getAttribute('aria-label');
      if (clean(aria)) return aria ?? '';
      const wrap = el.closest('label');
      if (wrap && clean(textOf(wrap))) return textOf(wrap);
      const fs = el.closest('fieldset');
      if (fs && controlsIn(fs).length === 1) {
        const legend = fs.querySelector('legend');
        if (legend && clean(textOf(legend))) return textOf(legend);
      }
      // nearby text: the closest ancestor that holds no other control
      let p = el.parentElement;
      for (let i = 0; i < 4 && p && p !== rootEl.parentElement; i++, p = p.parentElement) {
        if (controlsIn(p).some((c) => c !== el)) break;
        const t = collapse(textOf(p));
        if (t) return t.slice(0, 250);
      }
      return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
    };

    rootEl.querySelectorAll('[data-ja],[data-ja-l]').forEach((e) => {
      e.removeAttribute('data-ja');
      e.removeAttribute('data-ja-opt');
      e.removeAttribute('data-ja-l');
    });

    const out: Array<{
      idx: number; kind: string; label: string; options: string[]; optionIndex: number[];
      value: string; required: boolean; useLabel: boolean;
    }> = [];
    const seenRadio = new Set<string>();
    let idx = 0;

    rootEl.querySelectorAll<HTMLElement>('input, textarea, select').forEach((node) => {
      const el = node as HTMLInputElement;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || (tag === 'input' ? 'text' : tag)).toLowerCase();
      if (['hidden', 'submit', 'button', 'file', 'image', 'reset', 'search'].includes(type)) return;
      if (el.disabled) return;

      if (type === 'radio') {
        const key = el.name || el.id;
        if (seenRadio.has(key)) return;
        seenRadio.add(key);
        const group = el.name
          ? Array.from(rootEl.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`))
          : [el];
        if (group.every((r) => r.disabled)) return;
        // LinkedIn's new layout: an empty <label> and the option text ("Yes") in a sibling element, with the
        // question as every radio's aria-label. So an empty label means: use the radio's own container text.
        const ownText = (r: HTMLInputElement) => {
          let c: HTMLElement | null = r.parentElement;
          while (c && c !== rootEl && !group.some((g) => g !== r && c!.contains(g))) {
            const t = clean(c.innerText);
            if (t) return t;
            c = c.parentElement;
          }
          return '';
        };
        const sharedAria = new Set(group.map((r) => r.getAttribute('aria-label') ?? '')).size === 1 ? clean(el.getAttribute('aria-label')) : '';
        const opts = group.map((r) => {
          const l = labelEl(r);
          const text = clean(textOf(l)) || ownText(r) || (sharedAria ? '' : clean(r.getAttribute('aria-label'))) || clean(r.value);
          return { r, l, text };
        });
        if (!opts.some((o) => rendered(o.r) || rendered(o.l))) return;
        let raw = textOf(el.closest('fieldset')?.querySelector('legend'));
        if (!clean(raw)) {
          const rg = el.closest('[role="radiogroup"]');
          const by = rg?.getAttribute('aria-labelledby');
          raw = by ? by.split(/\s+/).map((id) => textOf(doc.getElementById(id))).join(' ') : rg?.getAttribute('aria-label') ?? '';
        }
        if (!clean(raw) && sharedAria && !opts.some((o) => o.text === sharedAria)) raw = sharedAria;
        if (!clean(raw)) {
          // the smallest container holding the whole group; its first line is usually the question
          let c: HTMLElement | null = el.parentElement;
          while (c && c !== rootEl && !group.every((g) => c!.contains(g))) c = c.parentElement;
          raw = ((c as HTMLElement | null)?.innerText ?? '').split('\n').find((line) => clean(line)) ?? '';
          if (opts.some((o) => o.text === clean(raw))) raw = '';
        }
        const my = idx++;
        opts.forEach((o, j) => {
          o.r.setAttribute('data-ja', String(my));
          o.r.setAttribute('data-ja-opt', String(j));
          o.l?.setAttribute('data-ja-l', `${my}-${j}`);
        });
        out.push({
          idx: my, kind: 'radio', label: clean(raw), options: opts.map((o) => o.text), optionIndex: [],
          value: opts.find((o) => o.r.checked)?.text ?? '', required: !isMarkedOptional(raw),
          useLabel: !opts.some((o) => shown(o.r)),
        });
        return;
      }

      if (type === 'checkbox') {
        const l = labelEl(el);
        if (!rendered(el) && !rendered(l)) return;
        const raw = rawLabel(el);
        const my = idx++;
        el.setAttribute('data-ja', String(my));
        l?.setAttribute('data-ja-l', `${my}-0`);
        out.push({
          idx: my, kind: 'checkbox', label: clean(raw), options: [], optionIndex: [], value: el.checked ? 'yes' : '',
          required: el.required || el.getAttribute('aria-required') === 'true' || isMarkedRequired(raw),
          useLabel: !shown(el) && !!l,
        });
        return;
      }

      if (!rendered(el)) return;
      const raw = rawLabel(el);
      const my = idx++;
      el.setAttribute('data-ja', String(my));

      if (tag === 'select') {
        const s = el as unknown as HTMLSelectElement;
        const options: string[] = [];
        const optionIndex: number[] = [];
        Array.from(s.options).forEach((o, i) => {
          const t = clean(o.text);
          const placeholder = !t || /^(select|choose|please select|pick|--)/i.test(t) || (i === 0 && o.value === '');
          if (!placeholder && !o.disabled) { options.push(t); optionIndex.push(i); }
        });
        const cur = s.selectedIndex >= 0 ? optionIndex.indexOf(s.selectedIndex) : -1;
        // no placeholder and nothing marked selected: the browser is just showing the first option, nobody chose it
        const browserPick = !Array.from(s.options).some((o) => o.defaultSelected) && s.selectedIndex === 0 && optionIndex[0] === 0;
        out.push({
          idx: my, kind: 'select', label: clean(raw), options, optionIndex, value: cur >= 0 && !browserPick ? options[cur] : '',
          // labelled dropdowns count as required unless marked optional; unlabelled ones (e.g. date parts) only when marked
          required: s.required || s.getAttribute('aria-required') === 'true' || (!!clean(raw) && !isMarkedOptional(raw)),
          useLabel: false,
        });
        return;
      }

      out.push({
        idx: my, kind: tag === 'textarea' ? 'textarea' : type === 'number' ? 'number' : 'text', label: clean(raw),
        options: [], optionIndex: [],
        // read-only fields (date pickers etc.) count as pre-filled: never type into them
        value: el.readOnly ? el.value || '<readonly>' : el.value,
        required: el.required || el.getAttribute('aria-required') === 'true' || isMarkedRequired(raw),
        useLabel: false,
      });
    });
    return out;
  }) as Promise<FieldDesc[]>;
}

/** Picks the first autocomplete suggestion if one appears (LinkedIn city fields). */
async function pickSuggestion(page: Page) {
  const opt = page.locator('[role="listbox"] [role="option"]').first();
  try {
    await opt.waitFor({ state: 'visible', timeout: 2000 });
    await opt.click({ timeout: ACTION_TIMEOUT });
  } catch {
    // plain text field, nothing to pick
  }
}

/** Puts one answer into one field. Returns false if the page would not take it. */
async function put(page: Page, root: Locator, f: FieldDesc, ans: string): Promise<boolean> {
  const el = root.locator(`[data-ja="${f.idx}"]`).first();
  try {
    if (f.kind === 'select') {
      const i = f.options.indexOf(ans);
      if (i < 0) return false;
      await el.selectOption({ index: f.optionIndex[i] }, { timeout: ACTION_TIMEOUT });
    } else if (f.kind === 'radio') {
      const j = f.options.indexOf(ans);
      if (j < 0) return false;
      const label = root.locator(`[data-ja-l="${f.idx}-${j}"]`).first();
      const input = root.locator(`[data-ja="${f.idx}"][data-ja-opt="${j}"]`).first();
      if (f.useLabel && (await label.count())) await label.click({ timeout: ACTION_TIMEOUT }).catch(() => {});
      else await input.check({ timeout: ACTION_TIMEOUT }).catch(() => {});
      // Empty, zero-size labels (LinkedIn's new layout) can't be clicked. Never force-click here: a forced click lands on
      // whatever is drawn at that spot (e.g. the Next/Submit button). Send the click event to the input instead.
      if (!(await input.isChecked())) await input.dispatchEvent('click').catch(() => {});
      if (!(await input.isChecked())) return false;
    } else {
      await el.fill(ans, { timeout: ACTION_TIMEOUT });
      // "10 LPA" in a field that only takes numbers: use full rupees (1000000) instead
      if (LPA_ANSWER.test(ans) && (await el.evaluate(NUMERIC_ONLY).catch(() => false))) await el.fill(lpaToRupees(ans), { timeout: ACTION_TIMEOUT });
      if (/\b(city|location)\b/i.test(f.label)) await pickSuggestion(page);
    }
    return true;
  } catch {
    return false;
  }
}

const LPA_ANSWER = /^\s*(\d+(?:\.\d+)?)\s*LPA\s*$/i;
export const lpaToRupees = (ans: string) => String(Math.round(Number(ans.match(LPA_ANSWER)?.[1] ?? 0) * 100000));
/** The field rejects the text it was given, or only takes numbers. DOM boundary: plain arrow (tsx __name). */
const NUMERIC_ONLY = (e: Element) => {
  const i = e as HTMLInputElement;
  return (typeof i.checkValidity === 'function' && !i.checkValidity()) || i.getAttribute('aria-invalid') === 'true' ||
    /numeric|decimal/.test(i.getAttribute('inputmode') ?? '') || i.type === 'number';
};

/**
 * After a form complains, swaps any "10 LPA" answer the page marked invalid for full rupees ("1000000").
 * Returns how many fields were changed.
 */
export async function fixLpaFields(root: Locator): Promise<number> {
  let fixed = 0;
  const inputs = root.locator('input[type="text"], input:not([type]), input[type="number"], textarea');
  for (let i = 0; i < (await inputs.count()); i++) {
    const el = inputs.nth(i);
    const value = await el.inputValue().catch(() => '');
    if (!LPA_ANSWER.test(value)) continue;
    if (!(await el.evaluate((e) => e.getAttribute('aria-invalid') === 'true' || !(e as HTMLInputElement).checkValidity()).catch(() => false))) continue;
    await el.fill(lpaToRupees(value)).catch(() => {});
    fixed++;
  }
  return fixed;
}

async function tick(root: Locator, f: FieldDesc): Promise<boolean> {
  const input = root.locator(`[data-ja="${f.idx}"]`).first();
  const label = root.locator(`[data-ja-l="${f.idx}-0"]`).first();
  try {
    if (f.useLabel) await label.click({ timeout: ACTION_TIMEOUT });
    else await input.check({ timeout: ACTION_TIMEOUT });
    return await input.isChecked();
  } catch {
    return false;
  }
}

/**
 * Fills every empty field in `root` from `answers`. Never clicks buttons and never submits.
 * Pre-filled fields are left as they are, required checkboxes are ticked, optional ones untouched.
 * Required questions without an answer come back in `missing`; the caller abandons the form.
 */
export async function fillFields(page: Page, root: Locator, answers: Answerer): Promise<FillResult> {
  const fields = await scanFields(root);
  const missing: Question[] = [];
  let filled = 0;

  for (const f of fields) {
    const q: Question = { label: f.label, kind: f.kind, ...(f.options.length ? { options: f.options } : {}) };
    if (f.kind === 'checkbox') {
      if (!f.required || f.value) continue;
      // consent/terms boxes are ticked; a claim ("I have 5+ years of X") is a yes/no question like any other
      const consent = /\b(terms|agree|consent|privacy|policy|acknowledge|declare|certify|confirm that|accurate|true and correct)\b/i.test(f.label);
      const yes = consent || (f.label && (await answers.answer({ label: f.label, kind: 'checkbox', options: ['Yes', 'No'] }, true)) === 'Yes');
      if (yes && (await tick(root, f))) filled++;
      else missing.push({ ...q, label: f.label || '(unlabelled checkbox)' });
      await pause();
      continue;
    }
    if (f.value) continue; // pre-filled by the site

    if (!f.label) {
      if (f.required) missing.push({ ...q, label: '(unlabelled field)' });
      continue;
    }
    const ans = await answers.answer(q, f.required);
    if (ans == null) {
      if (f.required) missing.push(q);
      continue;
    }
    if (await put(page, root, f, ans)) filled++;
    else if (f.required) missing.push(q);
    await pause();
  }

  // Custom dropdowns (a div with role=combobox, e.g. LinkedIn's Degree / Field of Study) can't be filled here.
  // A required one that is still empty means the form can't go on, so it counts as unanswered.
  // DOM boundary: plain arrow without named helpers (tsx would wrap named ones in __name).
  const custom = await root.locator('[role="combobox"]:not(input):not(select):not(textarea)').evaluateAll((els) =>
    els.filter((e) => (e as HTMLElement).getBoundingClientRect().width > 0).map((e) => ({
      label: ((e.getAttribute('aria-labelledby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? '').join(' ').trim() ||
        e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
      required: e.getAttribute('aria-required') === 'true',
      value: ((e as HTMLElement).innerText || '').trim(),
    })),
  ).catch(() => [] as Array<{ label: string; required: boolean; value: string }>);
  for (const c of custom) {
    const required = c.required || /\*\s*$/.test(c.label);
    if (required && (!c.value || /^select\b/i.test(c.value))) {
      missing.push({ label: c.label.replace(/\s*\*\s*$/, '') || '(unlabelled dropdown)', kind: 'select' });
    }
  }
  return { filled, missing };
}
