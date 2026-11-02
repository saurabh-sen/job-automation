import { describe, expect, it } from 'vitest';
import { parseWaasTitle, waasJobIds } from '../src/adapters/workatastartup.js';
import { parseWellfoundTitle, wellfoundJobs } from '../src/adapters/wellfound.js';
import { companyFromHeading, descriptionFrom as ihDescription, experienceIn } from '../src/adapters/instahyre.js';
import { cleanExperience, naukriJobId, parseNaukriStats, stripRating } from '../src/adapters/naukri.js';
import { ALREADY_APPLIED_TEXT } from '../src/adapters/linkedin.js';
import { descriptionFrom, externalApplyUrl, jobIdsIn, parsePageTitle, parseTopCard } from '../src/adapters/linkedin.js';

describe('naukri helpers', () => {
  it('reads the job id from a listing URL', () => {
    expect(naukriJobId('https://www.naukri.com/job-listings-react-developer-acme-hyderabad-3-to-6-years-311025012345?src=x#y')).toBe('311025012345');
    expect(naukriJobId('https://www.naukri.com/job-listings-react-dev-acme-311025012345/')).toBe('311025012345');
    expect(naukriJobId('https://www.naukri.com/react-jobs')).toBeNull();
  });
  it('strips the rating from the company name', () => {
    expect(stripRating('Acme Corp\n3.9\n120 Reviews')).toBe('Acme Corp');
    expect(stripRating('Acme Corp 3.9 (120 Reviews)')).toBe('Acme Corp');
    expect(stripRating('Acme 360 Labs')).toBe('Acme 360 Labs');
  });
  it('parses posted date and applicants', () => {
    expect(parseNaukriStats(['Posted: 3 days ago', 'Openings: 2', 'Applicants: 100+'])).toEqual({ postedAt: '3 days ago', applicants: '100+' });
  });
});

describe('linkedin already-applied text', () => {
  it.each(['Applied 3 days ago', 'Applied an hour ago', 'Applied a few minutes ago', 'Application submitted'])('matches %s', (t) => {
    expect(ALREADY_APPLIED_TEXT.test(t)).toBe(true);
  });
  it.each(['Applied', 'Apply', 'Easy Apply'])('does not match %s', (t) => {
    expect(ALREADY_APPLIED_TEXT.test(t)).toBe(false);
  });
});

describe('naukri live-page formats (2026-11-02)', () => {
  it('experience box also holds the salary', () => {
    expect(cleanExperience('5 - 8 years Not Disclosed')).toBe('5 - 8 years');
    expect(cleanExperience('2-5 Yrs 15-30 Lacs PA')).toBe('2-5 Yrs');
    expect(cleanExperience('')).toBeUndefined();
  });
  it('company with rating and reviews', () => {
    expect(stripRating('Datamatics 3.42.7K Reviews')).toBe('Datamatics');
  });
  it('header stats', () => {
    expect(parseNaukriStats(['Posted: 1 day ago', 'Openings: 1', 'Applicants: 100+'])).toEqual({ postedAt: '1 day ago', applicants: '100+' });
  });
});

describe('linkedin live-page formats (2026-11-02)', () => {
  it('page title -> title and company', () => {
    expect(parsePageTitle('Sr Associate Software Engineer | Amgen | LinkedIn')).toEqual({ title: 'Sr Associate Software Engineer', company: 'Amgen' });
    expect(parsePageTitle('(6) React JS Developer | Scoutit | LinkedIn')).toEqual({ title: 'React JS Developer', company: 'Scoutit' });
    expect(parsePageTitle('Java Developer | Bangalore | Remote | MBS | LinkedIn')).toEqual({ title: 'Java Developer | Bangalore | Remote', company: 'MBS' });
  });
  it('company apply link -> company URL', () => {
    const href = 'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fcareers%2Eamgen%2Ecom%2Fjob%2F-%2F-%2F87%2F102025939664%3Fsrc%3DLinkedin&urlhash=ASRG';
    expect(externalApplyUrl(href)).toBe('https://careers.amgen.com/job/-/-/87/102025939664?src=Linkedin');
    expect(externalApplyUrl('https://jobs.lever.co/acme/1')).toBe('https://jobs.lever.co/acme/1');
    expect(externalApplyUrl('https://www.linkedin.com/jobs/view/1/')).toBeUndefined();
    expect(externalApplyUrl(null)).toBeUndefined();
  });
  it('job ids from search cards, recommended cards and links, deduped in order', () => {
    const html = '<div componentkey="job-card-component-ref-4485192933"></div><li data-occludable-job-id="4480962918"></li>' +
      '<a href="/jobs/view/4485192933/">x</a><a href="/jobs/view/4448364309/?x=1">y</a>';
    expect(jobIdsIn(html)).toEqual(['4485192933', '4480962918', '4448364309']);
  });
  it('top line with posted time and applicants', () => {
    expect(parseTopCard('Pune City, Maharashtra, India · 17 hours ago · Over 100 applicants', 'Scoutit'))
      .toEqual({ location: 'Pune City, Maharashtra, India', postedAt: '17 hours ago', applicants: 'Over 100 applicants' });
  });
});

describe('linkedin description', () => {
  it('takes the text under "About the job" up to the next section', () => {
    const text = 'Amgen\nSr Associate Software Engineer\nAbout the job\nBuild UIs in React.\n5 - 9 years of experience\nSet alert for similar jobs\nOff';
    expect(descriptionFrom(text)).toBe('Build UIs in React.\n5 - 9 years of experience');
    expect(descriptionFrom('no heading here')).toBe('');
  });
});

describe('instahyre live-page formats (2026-11-02)', () => {
  it('experience, company and description', () => {
    expect(experienceIn('Bangalore 2-6 Years')).toBe('2-6 Years');
    expect(experienceIn('Bangalore, Hyderabad')).toBeUndefined();
    expect(companyFromHeading('at BlueStone.com')).toBe('BlueStone.com');
    expect(ihDescription('Fullstack Engineer\nJob Description\nFunction: Backend\nBuild APIs\nAbout BlueStone.com\nJewellery')).toBe('Function: Backend\nBuild APIs');
  });
});

describe('wellfound live-page formats (2026-11-02)', () => {
  it('page title -> role, company, location', () => {
    expect(parseWellfoundTitle('AI Software Engineer (Backend, Agentic, and Voice AI) at Steps AI • Hyderabad | Wellfound'))
      .toEqual({ title: 'AI Software Engineer (Backend, Agentic, and Voice AI)', company: 'Steps AI', location: 'Hyderabad' });
    expect(parseWellfoundTitle('Page not found - 404 | Wellfound').title).toBe('');
  });
  it('job links need the slug', () => {
    const html = '<a href="/jobs/4797131-software-development-engineer-frontend">a</a><a href="/jobs/4797131-software-development-engineer-frontend?x=1">b</a><a href="/jobs/applications">c</a>';
    expect(wellfoundJobs(html)).toEqual([{ id: '4797131', path: '/jobs/4797131-software-development-engineer-frontend' }]);
  });
});

describe('work at a startup live-page formats (2026-11-02)', () => {
  it('page title and job ids', () => {
    expect(parseWaasTitle("Senior Software Engineer at FleetWorks | Y Combinator's Work at a Startup")).toEqual({ title: 'Senior Software Engineer', company: 'FleetWorks' });
    expect(waasJobIds('<a href="/jobs/85433">a</a><a href="https://www.workatastartup.com/jobs/119675?x">b</a><a href="/jobs/85433">c</a>')).toEqual(['85433', '119675']);
  });
});
