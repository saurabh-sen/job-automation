import { ConfigError, loadChromeConfig } from '../config.js';
import { cdpUp, launchChrome, profileOpenWithoutDebugging } from '../browser.js';
import { errMsg, sleep } from '../utils.js';

const HOME_PAGES = [
  'https://www.linkedin.com/',
  'https://www.naukri.com/',
  'https://www.instahyre.com/',
  'https://wellfound.com/',
  'https://www.workatastartup.com/',
];

const NEXT_STEPS = [
  'Next:',
  '  1. Log in to each site in that window (LinkedIn, Naukri, Instahyre, Wellfound, Work at a Startup). Sessions stay saved in this profile.',
  '  2. Keep using this window only for job sites, and leave it open (or let runs reopen it).',
  '  3. Try a run: npm run apply -- --dry-run',
];

async function main(): Promise<number> {
  let chrome;
  try {
    chrome = loadChromeConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      return 1;
    }
    console.error(`Could not read config.yaml: ${errMsg(e)}`);
    return 1;
  }

  if (await cdpUp(chrome.cdpUrl)) {
    // scheduled runs keep it windowless in the background; open the sites in a window you can use
    for (const url of HOME_PAGES) {
      await fetch(new URL(`/json/new?${url}`, chrome.cdpUrl), { method: 'PUT' }).catch(() => {});
    }
    console.log('The agent Chrome is already running; opened the job sites in it.');
    console.log(NEXT_STEPS.join('\n'));
    return 0;
  }
  if (profileOpenWithoutDebugging(chrome.userDataDir)) {
    console.error('The agent Chrome profile is open without remote debugging. Quit that Chrome window, then run `npm run chrome` again.');
    return 1;
  }

  try {
    launchChrome(chrome, HOME_PAGES);
  } catch (e) {
    console.error(errMsg(e));
    return 1;
  }
  for (let i = 0; i < 15 && !(await cdpUp(chrome.cdpUrl)); i++) await sleep(1000);
  if (!(await cdpUp(chrome.cdpUrl))) {
    console.error('Chrome started but remote debugging did not come up. Quit every window of the agent Chrome and run `npm run chrome` again.');
    return 1;
  }
  console.log(`Opened Chrome on the agent profile (${chrome.userDataDir}).`);
  console.log(NEXT_STEPS.join('\n'));
  return 0;
}

process.exitCode = await main();
