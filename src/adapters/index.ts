import type { SiteId } from '../config.js';
import type { SiteAdapter } from './types.js';
import { instahyre } from './instahyre.js';
import { linkedin } from './linkedin.js';
import { naukri } from './naukri.js';
import { wellfound } from './wellfound.js';
import { workatastartup } from './workatastartup.js';

/** Sites with an adapter so far; run.ts skips the others with "no adapter yet". */
export const ADAPTERS: Partial<Record<SiteId, SiteAdapter>> = { naukri, linkedin, instahyre, wellfound, workatastartup };
