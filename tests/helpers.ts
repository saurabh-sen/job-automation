import { parseConfig, type Config } from '../src/config.js';

/** A valid config with fake values. Never copy real config.yaml values into tests. */
export function testConfig(overrides: Record<string, unknown> = {}): Config {
  const raw: Record<string, unknown> = {
    telegram: { enabled: true, botToken: '123456:FAKE-token', chatId: '42' },
    profile: {
      firstName: 'Test',
      lastName: 'User',
      email: 'test.user@example.com',
      countryCode: '+91',
      phone: '9000000000',
      city: 'Hyderabad',
      currentCompany: 'ExampleCorp',
      currentTitle: 'Software Development Engineer 1',
      totalExperienceYears: 3.2,
      skillYears: { React: 3, JavaScript: 3, TypeScript: 3, Angular: 1, 'Node.js': 1 },
      noticePeriodDays: 30,
      currentCtcLpa: 10,
      expectedCtcLpa: 15,
      willingToRelocate: true,
      okWithOnsite: true,
      linkedinUrl: 'https://www.linkedin.com/in/test-user',
      githubUrl: 'https://github.com/test-user',
      portfolioUrl: '',
      highestDegree: 'B.Tech',
      graduationYear: 2022,
    },
    customAnswers: [{ match: 'how did you hear', answer: 'LinkedIn' }],
    filters: {
      includeTitleKeywords: ['frontend', 'front end', 'front-end', 'react', 'angular', 'javascript', 'ui developer',
        'ui engineer', 'full stack', 'fullstack', 'full-stack', 'software engineer', 'software developer', 'sde',
        'web developer', 'node'],
      excludeTitleKeywords: ['senior staff', 'staff engineer', 'principal', 'lead', 'manager', 'architect', 'director',
        'head', 'intern', 'trainee', 'android', 'ios', 'qa', 'devops', 'salesforce', 'sap',
        'sde 3', 'sde-3', 'sde iii', 'sde-iii', 'sde3'],
      excludeCompanies: ['acmesoft'],
      locations: ['hyderabad', 'bengaluru', 'bangalore', 'pune', 'chennai', 'remote'],
      maxRequiredExperience: 5,
    },
    sites: { naukri: { enabled: true }, linkedin: { enabled: true } },
  };
  for (const [k, v] of Object.entries(overrides)) {
    raw[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(raw[k] as object), ...v } : v;
  }
  return parseConfig(raw);
}
