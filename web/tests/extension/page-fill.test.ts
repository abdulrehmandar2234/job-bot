// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyFill, describeFields } from '../../../extension/lib/page-fill.js';
import { planFill } from '../../../extension/lib/fill.js';
import { fillProfile } from '@/lib/extension';

// extension/lib/page-fill.js runs inside the job page. jsdom has no layout, so every element counts as visible.
beforeEach(() => {
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
});

const FORM = `
  <form id="apply" action="/submit">
    <label for="fn">First name *</label><input id="fn" name="first_name">
    <label>Last name <input name="last_name"></label>
    <input name="email" type="email" aria-label="Email" value="already@typed.com">
    <span id="ph">Phone</span><input name="p" aria-labelledby="ph">
    <label for="why">Why do you want to work at Acme?</label><textarea id="why"></textarea>
    <label for="cl">Cover letter</label><textarea id="cl"></textarea>
    <label for="exp">Years of Laravel</label><select id="exp"><option value="">Select</option><option value="7">7</option></select>
    <label for="cv">Resume</label><input id="cv" type="file">
    <input type="checkbox" name="terms" aria-label="I agree">
    <input type="hidden" name="token" value="t">
    <input name="gone" style="display:none">
    <input name="locked" disabled>
    <button type="submit">Submit application</button>
  </form>`;

describe('describeFields', () => {
  it('lists visible enabled fields with their labels, tagging each one', () => {
    document.body.innerHTML = FORM;
    const fields = describeFields();
    expect(fields.map((f: { label: string; aria: string; name: string }) => f.label || f.aria || f.name)).toEqual([
      'First name',
      'Last name',
      'Email',
      'Phone',
      'Why do you want to work at Acme?',
      'Cover letter',
      'Years of Laravel',
      'Resume',
      'I agree',
    ]);
    expect(fields.find((f: { name: string }) => f.name === 'email')).toMatchObject({ type: 'email', empty: false });
    expect(fields.find((f: { label: string }) => f.label === 'Years of Laravel')).toMatchObject({
      tag: 'select',
      empty: true,
      options: [
        { value: '', text: 'Select' },
        { value: '7', text: '7' },
      ],
    });
    expect(document.querySelectorAll('[data-jobbot-field]')).toHaveLength(9); // hidden, display:none and disabled inputs are left out
  });
});

describe('applyFill', () => {
  it('fills the planned empty fields, fires input and change, marks them, and never submits', () => {
    document.body.innerHTML = FORM;
    const submit = vi.fn((e: Event) => e.preventDefault());
    const click = vi.fn();
    document.getElementById('apply')!.addEventListener('submit', submit);
    document.querySelector('button')!.addEventListener('click', click);
    const events: string[] = [];
    document.getElementById('fn')!.addEventListener('input', () => events.push('input'));
    document.getElementById('fn')!.addEventListener('change', () => events.push('change'));

    const plan = planFill(describeFields(), {
      profile: { name: 'Sara Khan', email: 'sara@example.com', phone: '+971 50 000 0000', linkedin: '', location: '' },
      cover_letter: 'Dear Acme,',
      answers: [
        { question: 'Why do you want to work at Acme?', answer: 'Payments.', needs_input: false, note: '' },
        { question: 'Years of Laravel experience', answer: '7', needs_input: false, note: '' },
      ],
      cv: null,
    });
    expect(applyFill(plan.fills, null)).toBe(6);

    const value = (sel: string) => (document.querySelector(sel) as HTMLInputElement).value;
    expect([value('#fn'), value('[name=last_name]'), value('[name=p]'), value('#why'), value('#cl'), value('#exp')]).toEqual([
      'Sara',
      'Khan',
      '+971 50 000 0000',
      'Payments.',
      'Dear Acme,',
      '7',
    ]);
    expect(value('[name=email]')).toBe('already@typed.com'); // a filled field is never overwritten
    expect((document.querySelector('[name=terms]') as HTMLInputElement).checked).toBe(false);
    expect(events).toEqual(['input', 'change']);
    expect((document.getElementById('fn') as HTMLElement).title).toBe('Filled by job-bot: check it before you submit');
    expect(submit).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('attaches the CV to the resume file input', () => {
    document.body.innerHTML = FORM;
    // jsdom has no DataTransfer; a minimal one that builds a FileList-like object is enough here.
    class FakeDataTransfer {
      list: File[] = [];
      items = { add: (f: File) => this.list.push(f) };
      get files() {
        return this.list as unknown as FileList;
      }
    }
    vi.stubGlobal('DataTransfer', FakeDataTransfer);
    const input = document.getElementById('cv') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [] as unknown as FileList, writable: true });
    const fields = describeFields();
    const cv = { name: 'Sara_CV.pdf', type: 'application/pdf', base64: btoa('%PDF-') };
    const plan = planFill(fields, { profile: {}, answers: [], cv });
    expect(plan.fills).toEqual([{ index: 7, kind: 'file', value: 'Sara_CV.pdf', label: 'Resume', source: 'CV' }]);
    expect(applyFill(plan.fills, cv)).toBe(1);
    expect(input.files![0].name).toBe('Sara_CV.pdf');
    expect(input.files![0].type).toBe('application/pdf');
    vi.unstubAllGlobals();
  });
});

describe('fillProfile', () => {
  const root = mkdtempSync(join(tmpdir(), 'job-bot-fill-profile-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads name and contact from cv/master.json, with applicant.json currentLocation first', () => {
    mkdirSync(join(root, 'cv'));
    writeFileSync(
      join(root, 'cv', 'master.json'),
      JSON.stringify({
        name: 'Sara Khan',
        contact: { email: 'sara@example.com', phone: '+1', linkedin: 'https://linkedin.com/in/s', location: 'Lahore' },
      }),
    );
    expect(fillProfile(root)).toEqual({
      name: 'Sara Khan',
      email: 'sara@example.com',
      phone: '+1',
      linkedin: 'https://linkedin.com/in/s',
      location: 'Lahore',
    });
    writeFileSync(join(root, 'cv', 'applicant.json'), JSON.stringify({ currentLocation: 'Dubai, UAE' }));
    expect(fillProfile(root).location).toBe('Dubai, UAE');
  });

  it('gives empty strings when the files are missing', () => {
    expect(fillProfile(join(root, 'nope'))).toEqual({ name: '', email: '', phone: '', linkedin: '', location: '' });
  });
});

describe('never overwriting', () => {
  const profile = { name: 'Sara Khan', email: 'sara@example.com', phone: '+971', linkedin: '', location: '' };

  it('a second run on the next step of a multi-step form fills that step, not the hidden first one', () => {
    document.body.innerHTML = `
      <div id="step1"><label for="a">First name</label><input id="a"></div>
      <div id="step2" style="display:none"><label for="b">Email</label><input id="b" type="email"></div>`;
    applyFill(planFill(describeFields(), { profile, answers: [] }).fills, null);
    expect((document.getElementById('a') as HTMLInputElement).value).toBe('Sara');

    // Step 1 is now hidden (jsdom has no layout, so hide it for getClientRects too) and step 2 shows.
    (document.getElementById('step1') as HTMLElement).style.display = 'none';
    (document.getElementById('a') as HTMLElement).style.display = 'none';
    (document.getElementById('step2') as HTMLElement).style.display = '';
    const rects = vi.mocked(Element.prototype.getClientRects);
    rects.mockImplementation(function (this: Element) {
      return ((this as HTMLElement).style.display === 'none' ? [] : [{}]) as unknown as DOMRectList;
    });
    const fields = describeFields();
    expect(fields.map((f: { id: string }) => f.id)).toEqual(['b']);
    expect(document.getElementById('a')!.hasAttribute('data-jobbot-field')).toBe(false); // old tag removed
    applyFill(planFill(fields, { profile, answers: [] }).fills, null);
    expect((document.getElementById('b') as HTMLInputElement).value).toBe('sara@example.com');
    expect((document.getElementById('a') as HTMLInputElement).value).toBe('Sara');
  });

  it('skips a field the user filled after the plan was made', () => {
    document.body.innerHTML = '<label for="a">First name</label><input id="a">';
    const plan = planFill(describeFields(), { profile, answers: [] });
    (document.getElementById('a') as HTMLInputElement).value = 'Typed by me';
    expect(applyFill(plan.fills, null)).toBe(0);
    expect((document.getElementById('a') as HTMLInputElement).value).toBe('Typed by me');
  });

  it('a select whose first option is a real choice the user picked is not empty; a "Select…" placeholder is', () => {
    document.body.innerHTML = `
      <label for="s1">Years of Laravel</label><select id="s1"><option value="7">7</option><option value="3">3</option></select>
      <label for="s2">Years of PHP</label><select id="s2"><option value="" disabled selected>Select…</option><option value="7">7</option></select>`;
    const fields = describeFields();
    expect(fields.map((f: { empty: boolean }) => f.empty)).toEqual([false, true]);
  });
});
