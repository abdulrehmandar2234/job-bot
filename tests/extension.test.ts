// Pure logic of the Chrome extension (extension/lib/*.js): no browser, no chrome.* and no dashboard needed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeResult, fetchCv, lookupJob, missingFields, OFFLINE, sendJob } from '../extension/lib/api.js';
import { pickOption, planFill, planFrameFills, similarity, splitName } from '../extension/lib/fill.js';
import { findJobPosting, guessFromTitle, jobFromPage, jobFromPosting, postingLocation } from '../extension/lib/jobposting.js';
import { cleanText, decodeEntities, htmlToText } from '../extension/lib/text.js';
import { frameOrigins, isHttpUrl, normalizeUrl, sameTab, sourceFromUrl } from '../extension/lib/url.js';

const posting = (over: Record<string, unknown> = {}) => ({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Senior Backend Engineer',
  hiringOrganization: { '@type': 'Organization', name: 'Acme FZ-LLC' },
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Dubai', addressCountry: 'AE' } },
  description: '<p>Build <b>APIs</b>.</p><ul><li>Node.js</li><li>Postgres</li></ul>',
  datePosted: '2026-10-20T08:00:00Z',
  ...over,
});

describe('text', () => {
  it('decodes named and numeric entities and leaves unknown ones', () => {
    assert.equal(decodeEntities('A &amp; B &lt;3 &#8211; &#x2014; &nbsp;x &bogus;'), 'A & B <3 – —  x &bogus;');
  });

  it('cleans whitespace but keeps paragraphs', () => {
    assert.equal(cleanText('  a \t b \r\n\r\n\r\n\n c    '), 'a b\n\nc');
    assert.equal(cleanText(null), '');
  });

  it('turns description HTML into text with bullets and line breaks', () => {
    assert.equal(
      htmlToText('<p>Build <b>APIs</b>.</p><ul><li>Node.js</li><li>Postgres</li></ul>Line<br>two<script>x()</script>'),
      'Build APIs.\n\n• Node.js\n• Postgres\nLine\ntwo',
    );
  });

  it('handles entity-escaped HTML from JSON-LD', () => {
    assert.equal(htmlToText('&lt;p&gt;Tom &amp;amp; Jerry&lt;/p&gt;&lt;p&gt;Two&lt;/p&gt;'), 'Tom & Jerry\n\nTwo');
  });
});

describe('url', () => {
  it('accepts only absolute http(s) urls', () => {
    assert.equal(isHttpUrl('https://a.example/x'), true);
    assert.equal(isHttpUrl('http://a.example'), true);
    for (const u of ['javascript:alert(1)', 'chrome://extensions', 'file:///etc/passwd', '/jobs/1', '', undefined])
      assert.equal(isHttpUrl(u), false, String(u));
  });

  it('normalizes without query, hash and trailing slash', () => {
    assert.equal(normalizeUrl('https://WWW.Bayt.com/en/jobs/123/?utm=x#apply'), 'https://www.bayt.com/en/jobs/123');
    assert.equal(normalizeUrl('https://a.example/'), 'https://a.example');
    assert.equal(normalizeUrl('http://a.example:8080/x'), 'http://a.example:8080/x');
    assert.equal(normalizeUrl('ftp://a.example/x'), null);
  });

  it('keeps the job id parameters, lowercased and sorted, and drops tracking ones', () => {
    assert.equal(normalizeUrl('https://acme.com/careers?gh_jid=1'), 'https://acme.com/careers?gh_jid=1');
    assert.equal(normalizeUrl('https://acme.com/careers/?utm_source=li&gh_jid=1#app'), 'https://acme.com/careers?gh_jid=1');
    assert.notEqual(normalizeUrl('https://acme.com/careers?gh_jid=1'), normalizeUrl('https://acme.com/careers?gh_jid=2'));
    assert.equal(normalizeUrl('https://www.indeed.com/viewjob?jk=abc&from=serp&vjs=3'), 'https://www.indeed.com/viewjob?jk=abc');
    assert.equal(
      normalizeUrl('https://www.linkedin.com/jobs/search/?keywords=php&currentJobId=42&trk=x'),
      'https://www.linkedin.com/jobs/search?currentjobid=42',
    );
    assert.equal(normalizeUrl('https://a.example/j?req_id=9&jobId=3&ref=x'), 'https://a.example/j?jobid=3&req_id=9');
    assert.equal(normalizeUrl('https://a.example/j?id=&utm_medium=x&ref=y'), 'https://a.example/j');
  });

  it('derives the source from known job boards, else "extension"', () => {
    assert.equal(sourceFromUrl('https://www.gulftalent.com/uae/jobs/1'), 'gulftalent');
    assert.equal(sourceFromUrl('https://ae.linkedin.com/jobs/view/1'), 'linkedin');
    assert.equal(sourceFromUrl('https://www.bayt.com/en/uae/jobs/x'), 'bayt');
    assert.equal(sourceFromUrl('https://job-boards.greenhouse.io/careem/jobs/1'), 'greenhouse');
    assert.equal(sourceFromUrl('https://www.naukrigulf.com/x'), 'naukrigulf');
    assert.equal(sourceFromUrl('https://careers.acme.com/jobs/1'), 'extension');
    assert.equal(sourceFromUrl('https://bayt.com.evil.example/x'), 'extension');
    assert.equal(sourceFromUrl('https://notbayt.com/x'), 'extension');
    assert.equal(sourceFromUrl('not a url'), 'extension');
  });
});

describe('findJobPosting', () => {
  it('finds a posting in a plain object, an array, a @graph and a typed list', () => {
    const p = posting();
    assert.equal(findJobPosting([JSON.stringify(p)])?.title, p.title);
    assert.equal(findJobPosting([JSON.stringify([{ '@type': 'Organization' }, p])])?.title, p.title);
    assert.equal(findJobPosting([JSON.stringify({ '@graph': [{ '@type': 'WebPage' }, p] })])?.title, p.title);
    assert.equal(findJobPosting([JSON.stringify({ ...p, '@type': ['Thing', 'JobPosting'] })])?.title, p.title);
    assert.equal(findJobPosting([JSON.stringify({ ...p, '@type': 'http://schema.org/JobPosting' })])?.title, p.title);
  });

  it('skips invalid JSON and other types, and returns null when there is none', () => {
    assert.equal(
      findJobPosting(['{oops', JSON.stringify({ '@type': 'BreadcrumbList' }), JSON.stringify(posting({ title: 'Second' }))])?.title,
      'Second',
    );
    assert.equal(findJobPosting(['{oops', 'null', '42']), null);
    assert.equal(findJobPosting(undefined), null);
  });
});

describe('postingLocation', () => {
  it('spells out country codes so the bot recognizes the country', () => {
    assert.equal(postingLocation(posting()), 'Dubai, United Arab Emirates');
  });

  it('joins several places and accepts plain strings and country objects', () => {
    assert.equal(
      postingLocation({
        jobLocation: [
          { address: { addressLocality: 'Riyadh', addressCountry: { '@type': 'Country', name: 'Saudi Arabia' } } },
          { address: 'Amsterdam, Netherlands' },
          'Jeddah',
          { name: 'HQ' },
        ],
      }),
      'Riyadh, Saudi Arabia; Amsterdam, Netherlands; Jeddah; HQ',
    );
  });

  it('adds Remote with the allowed countries for TELECOMMUTE jobs', () => {
    assert.equal(
      postingLocation({
        jobLocationType: 'TELECOMMUTE',
        applicantLocationRequirements: [{ '@type': 'Country', name: 'PK' }, { name: 'UAE' }],
      }),
      'Remote (Pakistan, UAE)',
    );
    assert.equal(postingLocation({ jobLocationType: ['TELECOMMUTE'] }), 'Remote');
    assert.equal(postingLocation({}), '');
  });
});

describe('jobFromPosting', () => {
  it('maps a JobPosting to the fields /api/import takes', () => {
    assert.deepEqual(jobFromPosting(posting(), 'https://www.gulftalent.com/uae/jobs/senior-backend-1?ref=x'), {
      source: 'gulftalent',
      company: 'Acme FZ-LLC',
      title: 'Senior Backend Engineer',
      location: 'Dubai, United Arab Emirates',
      url: 'https://www.gulftalent.com/uae/jobs/senior-backend-1?ref=x',
      description: 'Build APIs.\n\n• Node.js\n• Postgres',
      posted_at: '2026-10-20',
    });
  });

  it('prefers the posting url, decodes entities and copes with missing fields', () => {
    const j = jobFromPosting(
      posting({
        url: 'https://careers.acme.com/jobs/9',
        title: 'R&amp;D Engineer',
        hiringOrganization: 'Acme',
        description: undefined,
        datePosted: 'last week',
      }),
      'https://www.linkedin.com/jobs/view/1',
    );
    assert.equal(j.url, 'https://careers.acme.com/jobs/9');
    assert.equal(j.source, 'extension');
    assert.equal(j.title, 'R&D Engineer');
    assert.equal(j.company, 'Acme');
    assert.equal(j.description, '');
    assert.equal(j.posted_at, null);
    assert.equal(jobFromPosting(posting({ url: 'javascript:x' }), 'https://a.example/1').url, 'https://a.example/1');
  });
});

describe('guessFromTitle', () => {
  it('splits "title at company" and drops the site name', () => {
    assert.deepEqual(guessFromTitle('Backend Engineer at Acme | LinkedIn', 'LinkedIn'), { title: 'Backend Engineer', company: 'Acme' });
  });

  it('takes the first two parts otherwise', () => {
    assert.deepEqual(guessFromTitle('Laravel Developer - Beta Corp - Careers'), { title: 'Laravel Developer', company: 'Beta Corp' });
    assert.deepEqual(guessFromTitle('Full-Stack Developer'), { title: 'Full-Stack Developer', company: '' });
    assert.deepEqual(guessFromTitle(''), { title: '', company: '' });
  });
});

describe('jobFromPage', () => {
  const page = {
    url: 'https://careers.acme.com/jobs/1',
    title: 'PHP Developer - Acme',
    siteName: '',
    jsonLd: [] as string[],
    selection: '',
    mainText: ' Main  text ',
  };

  it('uses JSON-LD when the page has a JobPosting', () => {
    const r = jobFromPage({ ...page, jsonLd: [JSON.stringify(posting())] });
    assert.equal(r.method, 'jsonld');
    assert.equal(r.job.title, 'Senior Backend Engineer');
  });

  it('falls back to the page title and the selected text', () => {
    assert.deepEqual(jobFromPage({ ...page, selection: '  We need\n\n\n\na PHP dev ' }), {
      method: 'page',
      job: {
        source: 'extension',
        company: 'Acme',
        title: 'PHP Developer',
        location: '',
        url: page.url,
        description: 'We need\n\na PHP dev',
        posted_at: null,
      },
    });
  });

  it('uses the main text without a selection, also when the JSON-LD posting has no title', () => {
    const r = jobFromPage({ ...page, jsonLd: [JSON.stringify(posting({ title: '' }))] });
    assert.equal(r.method, 'page');
    assert.equal(r.job.description, 'Main text');
    assert.equal(jobFromPage({ ...page, mainText: 'x'.repeat(30000) }).job.description.length, 20000);
  });
});

describe('api', () => {
  type Call = { url: string; init?: RequestInit };
  const fake =
    (status: number, body: unknown, calls: Call[] = []) =>
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    };
  const offline = async () => {
    throw new TypeError('Failed to fetch');
  };
  const job = {
    source: 'extension',
    company: 'Acme',
    title: 'Dev',
    location: '',
    url: 'https://a.example/1',
    description: '',
    posted_at: null,
  };

  it('posts one job as a list and returns its result', async () => {
    const calls: Call[] = [];
    const result = { url: job.url, outcome: 'added', id: 'extension:abc', score: 70 };
    assert.deepEqual(await sendJob(job, fake(200, { received: 1, results: [result] }, calls)), { ok: true, result });
    assert.equal(calls[0].url, 'http://localhost:3100/api/import');
    assert.equal(calls[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), [job]);
  });

  it('explains a refused job, an error status and a stopped dashboard', async () => {
    assert.match(((await sendJob(job, fake(200, { added: 0, results: [] }))) as { error: string }).error, /did not accept/);
    assert.deepEqual(await sendJob(job, fake(403, 'Forbidden origin')), { ok: false, status: 403, error: 'The dashboard answered 403.' });
    assert.deepEqual(await sendJob(job, offline), { ok: false, error: OFFLINE });
  });

  it('looks up a tab url', async () => {
    const calls: Call[] = [];
    assert.deepEqual(await lookupJob('https://a.example/1?x=1&y=2', fake(200, { job: { id: 'a' } }, calls)), {
      ok: true,
      job: { id: 'a' },
    });
    assert.equal(calls[0].url, 'http://localhost:3100/api/jobs/lookup?url=https%3A%2F%2Fa.example%2F1%3Fx%3D1%26y%3D2');
    assert.deepEqual(await lookupJob('https://a.example/2', fake(200, { job: null })), { ok: true, job: null });
    assert.deepEqual(await lookupJob('https://a.example/2', fake(400, { error: 'url must be an http(s) URL' })), {
      ok: false,
      status: 400,
      error: 'url must be an http(s) URL',
    });
    assert.deepEqual(await lookupJob('https://a.example/2', offline), { ok: false, error: OFFLINE });
  });

  it('describes each import outcome', () => {
    assert.equal(describeResult({ outcome: 'added', score: 72, ai_score: null }), 'Added with score 72.');
    assert.equal(
      describeResult({ outcome: 'filtered', filter_reason: 'title is not an engineering role' }),
      'Added, but filtered out: title is not an engineering role.',
    );
    assert.equal(
      describeResult({ outcome: 'known', status: 'applied', score: 60, ai_score: 81 }),
      'Already in job-bot (applied, AI score 81, keyword score 60).',
    );
    assert.match(describeResult({ outcome: 'error' }), /could not save/);
  });

  it('lists missing required fields', () => {
    assert.deepEqual(missingFields(job), []);
    assert.deepEqual(missingFields({ ...job, title: '  ', company: undefined }), ['title', 'company']);
  });
});

// ---- auto-fill planning (lib/fill.js): which empty field gets which value; nothing is ever submitted ----

describe('auto-fill plan', () => {
  const field = (index: number, over: Record<string, unknown> = {}) => ({
    index,
    tag: 'input',
    type: 'text',
    label: '',
    aria: '',
    placeholder: '',
    name: '',
    id: '',
    autocomplete: '',
    empty: true,
    options: [],
    ...over,
  });
  const data = {
    profile: {
      name: 'Sara Ann Khan',
      email: 'sara@example.com',
      phone: '+971 50 000 0000',
      linkedin: 'https://linkedin.com/in/sara',
      location: 'Dubai, UAE',
    },
    cover_letter: 'Dear Acme Hiring Team, ...',
    answers: [
      { question: 'Why do you want to work at Acme?', answer: 'Because of the payments platform.', needs_input: false, note: '' },
      { question: 'What is your notice period?', answer: '[FILL: notice period]', needs_input: true, note: '' },
      { question: 'Years of experience with Laravel', answer: '7', needs_input: false, note: '' },
    ],
    cv: { name: 'Sara_Khan_CV.pdf', type: 'application/pdf', base64: 'JVBERi0=' },
  };

  it('splits a full name into first and last', () => {
    assert.deepEqual(splitName('Sara Ann Khan'), { first: 'Sara Ann', last: 'Khan' });
    assert.deepEqual(splitName('  Cher '), { first: 'Cher', last: '' });
    assert.deepEqual(splitName(undefined), { first: '', last: '' });
  });

  it('fills profile fields by label, name attribute or autocomplete, last name before name', () => {
    const { fills } = planFill(
      [
        field(0, { label: 'First Name' }),
        field(1, { name: 'job_application[last_name]' }),
        field(2, { label: 'Name' }),
        field(3, { type: 'email', label: 'Email address' }),
        field(4, { type: 'tel', autocomplete: 'tel' }),
        field(5, { label: 'LinkedIn Profile' }),
        field(6, { placeholder: 'Current location' }),
        field(7, { autocomplete: 'given-name', label: 'Something odd' }),
      ],
      data,
    );
    assert.deepEqual(
      fills.map((f) => [f.index, f.value, f.source]),
      [
        [0, 'Sara Ann', 'profile'],
        [1, 'Khan', 'profile'],
        [2, 'Sara Ann Khan', 'profile'],
        [3, 'sara@example.com', 'profile'],
        [4, '+971 50 000 0000', 'profile'],
        [5, 'https://linkedin.com/in/sara', 'profile'],
        [6, 'Dubai, UAE', 'profile'],
        [7, 'Sara Ann', 'profile'],
      ],
    );
  });

  it('puts the cover letter only in a textarea, drafted answers by question, and the CV in a resume file input', () => {
    const { fills, skipped } = planFill(
      [
        field(0, { tag: 'textarea', type: 'textarea', label: 'Cover Letter' }),
        field(1, { label: 'Cover letter (link)' }),
        field(2, { tag: 'textarea', type: 'textarea', label: 'Why do you want to work at Acme?' }),
        field(3, { label: 'Notice period' }),
        field(4, { type: 'file', label: 'Resume/CV' }),
        field(5, { type: 'file', label: 'Portfolio' }),
      ],
      data,
    );
    assert.deepEqual(
      fills.map((f) => [f.index, f.kind, f.source]),
      [
        [0, 'text', 'cover letter'],
        [2, 'text', 'answer'],
        [4, 'file', 'CV'],
      ],
    );
    // The notice-period answer needs the user's input, so it is left for them.
    assert.deepEqual(skipped, ['Cover letter (link)', 'Notice period']);
  });

  it('never touches filled fields, checkboxes, radios, passwords or hidden inputs', () => {
    const { fills } = planFill(
      [
        field(0, { label: 'Email', empty: false }),
        field(1, { type: 'checkbox', label: 'Email me updates' }),
        field(2, { type: 'radio', label: 'Email' }),
        field(3, { type: 'password', label: 'Email password' }),
        field(4, { type: 'hidden', name: 'email' }),
        field(5, { type: 'submit', label: 'Submit' }),
      ],
      data,
    );
    assert.deepEqual(fills, []);
  });

  it('picks a select option that matches, and skips the select otherwise', () => {
    const options = [
      { value: '', text: 'Select…' },
      { value: '1', text: '0-2 years' },
      { value: '7', text: '7' },
    ];
    const { fills, skipped } = planFill(
      [
        field(0, { tag: 'select', type: 'select', label: 'Years of experience with Laravel', options }),
        field(1, { tag: 'select', type: 'select', label: 'Location', options }),
      ],
      data,
    );
    assert.deepEqual(fills, [{ index: 0, kind: 'select', value: '7', label: 'Years of experience with Laravel', source: 'answer' }]);
    assert.deepEqual(skipped, ['Location']);
    assert.equal(pickOption([{ value: 'ae', text: 'United Arab Emirates' }], 'united arab emirates'), 'ae');
    assert.equal(pickOption([{ value: 'x', text: 'Yes' }], ''), null);
  });

  it('uses each drafted answer once, and needs a close question match', () => {
    assert.ok(similarity('Why do you want to work at Acme?', 'Why do you want to work at Acme') === 1);
    assert.ok(similarity('Phone', 'Why do you want to work at Acme?') === 0);
    const { fills } = planFill(
      [
        field(0, { tag: 'textarea', type: 'textarea', label: 'Why do you want to work at Acme?' }),
        field(1, { tag: 'textarea', type: 'textarea', label: 'Why Acme? Why do you want to work here' }),
        field(2, { label: 'Tell us about a project' }),
      ],
      data,
    );
    assert.deepEqual(
      fills.map((f) => f.index),
      [0],
    );
  });

  it("never puts the candidate's own details into questions or fields about someone else", () => {
    const { fills, skipped } = planFill(
      [
        field(0, { tag: 'textarea', type: 'textarea', label: 'Do you have experience building mobile apps?' }),
        field(1, { label: 'How did you hear about us? (e.g. LinkedIn, referral)' }),
        field(2, { label: 'Preferred work location' }),
        field(3, { label: 'Referrer full name' }),
        field(4, { label: 'Emergency contact phone' }),
        field(5, { label: 'Company name', id: 'name' }),
        field(6, { label: 'Name of your current employer' }),
      ],
      data,
    );
    assert.deepEqual(fills, []);
    assert.equal(skipped.length, 7);
  });

  it('uses the name/id attributes only when a field has no visible label', () => {
    const { fills } = planFill([field(0, { name: 'phone' }), field(1, { id: 'email', placeholder: 'Your email' })], data);
    assert.deepEqual(
      fills.map((f) => [f.index, f.value]),
      [
        [0, '+971 50 000 0000'],
        [1, 'sara@example.com'],
      ],
    );
  });

  it('does not match answers on common words only', () => {
    assert.equal(similarity('Are you a citizen?', 'Are you willing to relocate to Riyadh?'), 0);
    assert.ok(similarity('Years of Laravel', 'Years of Laravel experience') >= 0.6);
    const { fills } = planFill([field(0, { label: 'Are you a citizen of the UAE?' })], {
      ...data,
      answers: [{ question: 'Are you willing to relocate to Riyadh?', answer: 'Yes, within a month.', needs_input: false, note: '' }],
    });
    assert.deepEqual(fills, []);
  });

  it('a select option must be the answer\'s first whole words, so "Notice period…" never picks "No"', () => {
    const yesNo = [
      { value: 'y', text: 'Yes' },
      { value: 'n', text: 'No' },
    ];
    assert.equal(pickOption(yesNo, 'Notice period is one month'), null);
    assert.equal(pickOption(yesNo, 'Now'), null);
    assert.equal(pickOption(yesNo, 'Yes, I can relocate within a month'), 'y');
    assert.equal(pickOption(yesNo, 'No'), 'n');
  });

  it('a loose option match needs whole words and 3+ characters: "No" never picks "Norway"', () => {
    const countries = [
      { value: '1', text: 'Netherlands' },
      { value: '2', text: 'Norway' },
    ];
    assert.equal(pickOption(countries, 'No'), null); // too short for the contains rule
    assert.equal(pickOption(countries, 'Norway'), '2'); // exact still wins
    assert.equal(pickOption([{ value: 'ae', text: 'United Arab Emirates (UAE)' }], 'United Arab Emirates'), 'ae'); // whole words
    assert.equal(pickOption([{ value: '1', text: 'Southampton' }], 'ham'), null); // never inside a word
    assert.equal(
      pickOption(
        [
          { value: 'y', text: 'Yes' },
          { value: 'n', text: 'No' },
        ],
        'no',
      ),
      'n', // a short answer still matches an option exactly
    );
  });

  it('plans all frames in one pass, so a drafted answer fills one field across frames', () => {
    const why = { tag: 'textarea', type: 'textarea', label: 'Why do you want to work at Acme?' };
    const plans = planFrameFills([[field(0, why)], null, [field(0, why), field(1, { label: 'First name' })]], data);
    assert.equal(plans.length, 3);
    assert.deepEqual(
      plans[0].fills.map((f) => [f.index, f.source]),
      [[0, 'answer']],
    );
    assert.deepEqual(plans[1], { fills: [], skipped: [] });
    // The answer is already used in frame 0; profile values are not single-use and still fill.
    assert.deepEqual(
      plans[2].fills.map((f) => [f.index, f.source]),
      [[1, 'profile']],
    );
    assert.deepEqual(plans[2].skipped, ['Why do you want to work at Acme?']);
  });

  it('on equal scores the first drafted answer wins', () => {
    const answers = [
      { question: 'Laravel experience', answer: 'first', needs_input: false, note: '' },
      { question: 'Laravel experience', answer: 'second', needs_input: false, note: '' },
    ];
    const { fills } = planFill([field(0, { label: 'Laravel experience' })], { ...data, answers });
    assert.equal(fills[0].value, 'first');
  });

  it('fills nothing from a missing profile value or without a CV', () => {
    const { fills } = planFill([field(0, { label: 'Phone' }), field(1, { type: 'file', label: 'Resume' })], {
      profile: { name: 'Sara Khan', phone: '' },
      answers: [],
      cv: null,
    });
    assert.deepEqual(fills, []);
  });
});

describe('fetchCv', () => {
  it('returns the PDF as base64 with its file name, or null when it cannot be read', async () => {
    const pdf = new TextEncoder().encode('%PDF-');
    const ok = await fetchCv('http://localhost:3100/api/cv/default?download', 'Sara_CV.pdf', async () => new Response(pdf));
    assert.deepEqual(ok, { name: 'Sara_CV.pdf', type: 'application/pdf', base64: 'JVBERi0=' });
    assert.equal(await fetchCv('x', 'a.pdf', async () => new Response('no', { status: 404 })), null);
    assert.equal(
      await fetchCv('x', 'a.pdf', async () => {
        throw new TypeError('offline');
      }),
      null,
    );
  });
});

describe('sameTab', () => {
  it('fills only the tab the job was shown for, on the same page', () => {
    const shown = { id: 7, url: 'https://boards.greenhouse.io/acme/jobs/1?gh_src=x' };
    assert.equal(sameTab(shown, { id: 7, url: 'https://boards.greenhouse.io/acme/jobs/1#app' }), true);
    assert.equal(sameTab(shown, { id: 8, url: shown.url }), false); // another tab
    assert.equal(sameTab(shown, { id: 7, url: 'https://boards.greenhouse.io/acme/jobs/2' }), false); // navigated away
    const embed = { id: 7, url: 'https://acme.com/careers?gh_jid=1' };
    assert.equal(sameTab(embed, { id: 7, url: 'https://acme.com/careers?gh_jid=1&utm_source=li' }), true);
    assert.equal(sameTab(embed, { id: 7, url: 'https://acme.com/careers?gh_jid=2' }), false); // another job, same path
    assert.equal(sameTab(null, { id: 7, url: shown.url }), false);
    assert.equal(sameTab(shown, undefined), false);
  });
});

describe('frameOrigins', () => {
  it('lists the other sites a page embeds, once each, as permission patterns', () => {
    assert.deepEqual(
      frameOrigins('https://careers.acme.com/jobs/1', [
        'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1',
        'https://job-boards.greenhouse.io/embed/other',
        'https://careers.acme.com/widget',
        'about:blank',
        'javascript:void(0)',
        'https://www.youtube.com/embed/x',
      ]),
      ['https://job-boards.greenhouse.io/*', 'https://www.youtube.com/*'],
    );
    assert.deepEqual(frameOrigins('https://careers.acme.com/jobs/1', []), []);
    assert.deepEqual(frameOrigins('chrome://extensions', ['https://x.example/']), []);
  });
});
