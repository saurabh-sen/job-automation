import type { Page } from 'playwright-core';
import { ConfigError, DEFAULT_DISCOVERY, loadChromeConfig, loadConfig, SITE_IDS, SITE_NAMES, type SiteId } from '../config.js';
import { connectBrowser } from '../browser.js';
import { checkpointHit, errMsg, sleep } from '../utils.js';

interface Item {
  role: string;
  name: string;
  tag: string;
  type: string;
  required: boolean;
  state: string;
  href: string;
  locator: string;
  matches: number;
  note: string;
}
interface Section { title: string; total: number; items: Item[] }

/*
 * DOM boundary: this walker runs inside the page. It is kept as a plain JS string (not a TS function) because tsx/esbuild
 * wraps named helpers in `__name(...)`, which does not exist in the page and makes page.evaluate throw.
 * It only reads the DOM: no clicks, no typing, no focus changes.
 */
const WALKER = String.raw`(opts) => {
  const limit = opts.limit;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cut = (s) => { const c = clean(s); return c.length > 80 ? c.slice(0, 79) + '…' : c; };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };
  const textOfIds = (ids) => clean(ids.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : ''; }).join(' '));
  const inputType = (el) => (el.getAttribute('type') || 'text').toLowerCase();
  const roleOf = (el) => {
    const explicit = clean(el.getAttribute('role')).split(' ')[0];
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button') return 'button';
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'input') {
      const t = inputType(el);
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      if (['text', 'email', 'tel', 'url'].includes(t)) return el.hasAttribute('list') ? 'combobox' : 'textbox';
      return '';
    }
    if (el.isContentEditable) return 'textbox';
    return '';
  };
  const nameOf = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = textOfIds(lb); if (t) return t; }
    const al = clean(el.getAttribute('aria-label'));
    if (al) return al;
    if (el.labels && el.labels.length) {
      const t = clean(Array.from(el.labels).map((l) => l.innerText || l.textContent).join(' '));
      if (t) return t;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(inputType(el))) return clean(el.value);
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return clean(el.getAttribute('title') || el.getAttribute('placeholder'));
    // Custom editable fields: their innerText is the current value, so never use it as the name.
    const role = clean(el.getAttribute('role')).split(' ')[0];
    if (el.isContentEditable || ['textbox', 'searchbox', 'combobox'].includes(role)) {
      return clean(el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || el.getAttribute('title'));
    }
    if (tag === 'dialog' || el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog' || el.getAttribute('aria-modal') === 'true') {
      const h = el.querySelector('h1, h2, h3, [role=heading]');
      return h ? clean(h.textContent) : '';
    }
    const txt = clean(el.innerText);
    if (txt) return txt;
    const img = el.querySelector('img[alt], [aria-label]');
    if (img) return clean(img.getAttribute('alt') || img.getAttribute('aria-label'));
    return clean(el.getAttribute('title'));
  };
  const autoId = (id) => /^(ember|ext-gen|react-|radix-|headlessui-|mui-|jsx-|u_|:)|\d{3,}|[0-9a-f]{8}-[0-9a-f]{4}|:/i.test(id);
  const DATA_PRIORITY = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-automation-id', 'data-automation', 'data-control-name', 'data-ga-track'];
  const cssStr = (v) => JSON.stringify(v);
  const dataAttr = (el) => {
    for (const k of DATA_PRIORITY) if (el.hasAttribute(k)) { const v = el.getAttribute(k); return v ? '[' + k + '=' + cssStr(v) + ']' : '[' + k + ']'; }
    for (const a of Array.from(el.attributes)) {
      if (!a.name.startsWith('data-') || !a.value || a.value.length > 40 || /\d{3,}|[{}\[\]]/.test(a.value)) continue;
      return '[' + a.name + '=' + cssStr(a.value) + ']';
    }
    return '';
  };
  const classSub = (el) => {
    const classes = Array.from(el.classList);
    for (const c of classes) { const m = /^([A-Za-z][\w-]*?__)[\w-]{3,}$/.exec(c); if (m && /[A-Z0-9]/.test(c.slice(m[1].length))) return m[1]; }
    for (const c of classes) if (c.length > 3 && !/\d{2,}|^(jsx|sc|css|emotion)-/.test(c)) return c;
    return '';
  };
  const cssCount = (sel) => { try { return document.querySelectorAll(sel).length; } catch (e) { return 0; } };
  const describe = (el) => {
    const role = roleOf(el);
    const name = nameOf(el);
    const tag = el.tagName.toLowerCase();
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
    let state = '';
    if (tag === 'input' && ['checkbox', 'radio'].includes(inputType(el))) state = el.checked ? 'checked' : '';
    else if (el.getAttribute('aria-checked') === 'true') state = 'checked';
    else if (isField) {
      const v = tag === 'select' ? (el.selectedIndex > 0 ? el.value : '') : (el.isContentEditable ? el.innerText : el.value);
      state = clean(v) ? '<filled>' : '';
    }
    let href = '';
    if (tag === 'a' && el.href) { try { const u = new URL(el.href, location.href); href = (u.host === location.host ? '' : u.host) + u.pathname; } catch (e) { href = ''; } }
    return {
      role, name: cut(name), tag, type: tag === 'input' ? inputType(el) : '',
      required: !!el.required || el.getAttribute('aria-required') === 'true',
      state, href, el,
      id: el.id && !autoId(el.id) ? el.id : '', data: dataAttr(el), cls: classSub(el),
    };
  };
  const pick = (d, all) => {
    if (d.role && d.name) {
      const short = d.name.length > 60 ? d.name.slice(0, 50) : d.name;
      const same = all.filter((o) => o.role === d.role && o.name === d.name).length;
      return { locator: 'getByRole(' + JSON.stringify(d.role) + ', { name: ' + JSON.stringify(short) + ' })', matches: same };
    }
    if (d.id) { const sel = '#' + CSS.escape(d.id); return { locator: 'locator(' + JSON.stringify(sel) + ')', matches: cssCount(sel) }; }
    if (d.data) return { locator: 'locator(' + JSON.stringify(d.data) + ')', matches: cssCount(d.data) };
    if (d.cls) { const sel = '[class*=' + cssStr(d.cls) + ']'; return { locator: 'locator(' + JSON.stringify(sel) + ')', matches: cssCount(sel) }; }
    return { locator: '(no stable locator)', matches: 0 };
  };
  const labelShown = (el) => !!(el.labels && Array.from(el.labels).some(shown));
  const collect = (title, selector, accept) => {
    const seen = new Set();
    const els = Array.from(document.querySelectorAll(selector)).filter((el) => {
      if (seen.has(el)) return false;
      seen.add(el);
      return accept(el);
    });
    const all = els.map(describe);
    const items = all.slice(0, limit).map((d) => {
      const p = pick(d, all);
      const note = !shown(d.el) ? 'hidden input, visible label' : '';
      return { role: d.role, name: d.name, tag: d.tag, type: d.type, required: d.required, state: d.state, href: d.href, locator: p.locator, matches: p.matches, note };
    });
    return { title, total: all.length, items };
  };
  const BUTTON_SEL = 'button, [role=button], input[type=button], input[type=submit], input[type=reset], input[type=image]';
  return [
    collect('Buttons', BUTTON_SEL, shown),
    collect('Links', 'a[href]:not([role]), [role=link]', shown),
    collect('Inputs', 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]), textarea, select, [contenteditable=""], [contenteditable=true], [role=textbox], [role=combobox], [role=checkbox], [role=radio], [role=switch], [role=listbox]',
      (el) => shown(el) || labelShown(el)),
    collect('Dialogs', '[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]', shown),
  ];
}`;

/** Masks emails and phone-like digit runs so profile data never lands in the terminal. */
const redact = (s: string) =>
  s.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>').replace(/\+?\d(?:[\s-]?\d){9,}/g, '<number>');

function parseArgs(argv: string[]) {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const site = get('site');
  const limit = Number(get('limit') ?? 40);
  return { site, url: get('url'), limit: Number.isInteger(limit) && limit > 0 ? limit : 40 };
}

function startUrl(site: SiteId, url: string | undefined): string {
  if (url) return url;
  try {
    return loadConfig().sites[site].discoveryUrls[0] ?? DEFAULT_DISCOVERY[site][0];
  } catch {
    return DEFAULT_DISCOVERY[site][0];
  }
}

function printSection(s: Section) {
  console.log(`\n${s.title} (${s.total} visible${s.total > s.items.length ? `, showing ${s.items.length}` : ''})`);
  if (!s.items.length) console.log('  (none)');
  for (const i of s.items) {
    const bits = [
      i.tag === 'input' && i.type ? `type=${i.type}` : i.tag !== 'button' && i.tag !== 'a' ? i.tag : '',
      i.required ? 'required' : '',
      i.state,
      i.href ? `href=${i.href}` : '',
      i.note,
    ].filter(Boolean);
    const extra = bits.length ? `  [${bits.join(', ')}]` : '';
    const count = i.matches > 1 ? `  (${i.matches} matches)` : '';
    console.log(redact(`  ${(i.role || '-').padEnd(10)} ${JSON.stringify(i.name)}${extra}\n      page.${i.locator}${count}`));
  }
}

async function inspect(page: Page, limit: number): Promise<Section[]> {
  // DOM boundary: the walker returns plain JSON shaped like Section[].
  return (await page.evaluate(`(${WALKER})(${JSON.stringify({ limit })})`)) as Section[];
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.site || !(SITE_IDS as readonly string[]).includes(args.site)) {
    console.error(`Usage: npm run inspect -- --site=<${SITE_IDS.join('|')}> [--url=<url>] [--limit=N]`);
    return 1;
  }
  const site = args.site as SiteId;
  const url = startUrl(site, args.url);
  if (!/^https?:\/\//i.test(url)) {
    console.error('--url must start with http:// or https://');
    return 1;
  }

  let chrome;
  try {
    chrome = loadChromeConfig();
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : errMsg(e));
    return 1;
  }
  const browser = await connectBrowser(chrome);
  let page: Page | undefined;
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('The agent Chrome has no open window. Run `npm run chrome` first.');
    page = await context.newPage();
    console.log(`Inspecting ${SITE_NAMES[site]} (read-only): ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => undefined);
    await sleep(3000);

    const landed = new URL(page.url());
    console.log(`Landed on: ${landed.origin}${landed.pathname}`);
    console.log(`Title: ${redact(await page.title())}`);
    if (await checkpointHit(page)) {
      console.log(`Stopped: ${SITE_NAMES[site]} is showing a captcha, verification or login wall. Clear it in the agent Chrome, then try again.`);
      return 1;
    }
    if (/login|signin|sign-in|authwall/i.test(landed.pathname)) {
      console.log(`Note: this looks like a login page. Log in to ${SITE_NAMES[site]} in the agent Chrome if you meant to inspect a logged-in page.`);
    }
    for (const s of await inspect(page, args.limit)) printSection(s);
    return 0;
  } finally {
    await page?.close().catch(() => undefined);
    await browser.close().catch(() => undefined); // disconnects only; the user's Chrome stays open
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (e: unknown) => { console.error(`inspect failed: ${errMsg(e)}`); process.exitCode = 1; },
);
