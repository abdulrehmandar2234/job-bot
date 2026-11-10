// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { collectPage } from '../../../extension/lib/collect.js';
import { jobFromPage } from '../../../extension/lib/jobposting.js';

// extension/lib/collect.js runs inside the job page on the user's click and only reads it. A page without
// JobPosting data (Greenhouse's job-boards pages) still names its location in a short element.

beforeEach(() => {
  document.title = 'Job Application for Assistant Manager - Internal Audit at Groww';
});

describe('collectPage: location for pages without JobPosting data', () => {
  it("reads a short one-line location element, like Greenhouse's job__location", () => {
    document.body.innerHTML = `
      <main>
        <h1>Assistant Manager - Internal Audit</h1>
        <div class="job__location"><svg></svg>Bengaluru-VTP, India</div>
        <p>About the role</p>
      </main>`;
    const page = collectPage();
    expect(page.locationText).toBe('Bengaluru-VTP, India');
    const { method, job } = jobFromPage(page);
    expect(method).toBe('page');
    expect(job).toMatchObject({ title: 'Assistant Manager - Internal Audit', company: 'Groww', location: 'Bengaluru-VTP, India' });
  });

  it("skips the form's location field, empty or long blocks, and leaves it empty when nothing fits", () => {
    document.body.innerHTML = `
      <main>
        <div class="locations-list">Bengaluru
Mumbai
Pune</div>
        <section id="location-help">${'x'.repeat(150)}</section>
        <span class="location"></span>
        <form><label class="location-label">Where do you live?</label><input id="location" class="location" value="typed"></form>
      </main>`;
    expect(collectPage().locationText).toBe('');
  });
});
