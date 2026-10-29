// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveApplicant, saveConfig, saveJson, type SaveState } from '@/app/settings/actions';
import { ApplicantForm, ConfigForm, JsonEditor, SaveStatus } from '@/components/settings';
import { Settings } from '@/components/settings-page';
import type { SettingsFile } from '@/lib/settings';

vi.mock('@/app/settings/actions', () => ({ saveConfig: vi.fn(), saveApplicant: vi.fn(), saveJson: vi.fn() }));
vi.mock('next/server', () => ({ connection: vi.fn(async () => {}) }));

const CONFIG = {
  minScore: 45, maxAgeDays: 14, autoCvVersions: false, roleInclude: 'laravel|php', roleExclude: 'senior',
  ai: { enabled: true, scoreModel: 'haiku', letterModel: 'sonnet', maxScorePerRun: 80 },
  linkedin: { enabled: false, keywords: ['php', 'react'], locations: ['Dubai'], remoteFrom: 'Pakistan', pagesPerSearch: 2 },
  remote: { enabled: true, boards: ['himalayas', 'remotive'], himalayasQueries: ['php'], allow: 'worldwide', deny: 'us', flag: 'emea' },
  countries: { AE: { name: 'UAE', visa: 'employer', match: 'dubai|uae' } },
  companies: [{ name: 'Careem', ats: 'greenhouse', token: 'careem' }, { name: 'Odd', ats: 'taleo', token: 'odd' }],
};
const APPLICANT = {
  _help: 'h', currentLocation: 'Lahore', nationality: null, expectedSalary: { AE: '20k', SA: null }, other: { github: 'gh/me' },
};
const file = (data: object | null, extra: Partial<SettingsFile> = {}): SettingsFile =>
  ({ file: '/x/file.json', text: JSON.stringify(data), data: data as SettingsFile['data'], error: null, example: false, ...extra });

const saved = (message: string): SaveState => ({ ok: true, message, errors: [] });
const rejected = (errors: { path: string; message: string }[]): SaveState =>
  ({ ok: false, message: `Not saved: ${errors.length} problems.`, errors });
const lastForm = (fn: unknown) => (vi.mocked(fn as typeof saveConfig).mock.calls.at(-1)![1]);

beforeEach(() => { vi.clearAllMocks(); });

describe('ConfigForm', () => {
  it('shows the current values with fitting inputs', () => {
    render(<ConfigForm config={file(CONFIG)} />);
    expect(screen.getByLabelText('Minimum score')).toHaveAttribute('type', 'number');
    expect(screen.getByLabelText('Minimum score')).toHaveValue(45);
    expect(screen.getByLabelText(/^Keywords/)).toHaveValue('php\nreact');
    expect(screen.getByLabelText(/^Role include/)).toHaveValue('laravel|php');
    expect(screen.getByLabelText('Search LinkedIn')).not.toBeChecked();
    expect(screen.getByLabelText('Search remote boards')).toBeChecked();
    expect(screen.getByLabelText(/^UAE \(AE, visa: employer\)/)).toHaveValue('dubai|uae');
    expect(screen.getByLabelText('Score model')).toHaveValue('haiku');
    expect(screen.getAllByTestId('company-row')).toHaveLength(2);
    expect(screen.getByLabelText('Company 1 ATS')).toHaveValue('greenhouse');
    expect(within(screen.getByLabelText('Company 1 ATS')).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['greenhouse', 'lever', 'ashby', 'recruitee', 'workable', 'smartrecruiters', 'workday']);
    // An ats the dashboard does not know yet stays selected rather than being changed.
    expect(screen.getByLabelText('Company 2 ATS')).toHaveValue('taleo');
  });

  it('shows strong-match alerts as on unless the file turns them off', () => {
    const { unmount } = render(<ConfigForm config={file(CONFIG)} />);
    expect(screen.getByLabelText(/Alert me at once for strong matches/)).toBeChecked(); // missing = on
    unmount();
    render(<ConfigForm config={file({ ...CONFIG, ai: { ...CONFIG.ai, alertStrong: false } })} />);
    expect(screen.getByLabelText(/Alert me at once for strong matches/)).not.toBeChecked();
  });

  it('shows the Adzuna section, empty without one, and the boards note', () => {
    const { unmount } = render(<ConfigForm config={file(CONFIG)} />);
    expect(screen.getByLabelText(/^Adzuna countries/)).toHaveValue('');
    expect(screen.getByLabelText(/^Adzuna keywords/)).toHaveValue('');
    expect(screen.getByLabelText(/^Adzuna pages per search/)).toHaveValue(null);
    expect(screen.getByText(/arbeitnow, adzuna/)).toBeInTheDocument();
    expect(screen.getByText(/ADZUNA_APP_ID and ADZUNA_APP_KEY in \.env/)).toBeInTheDocument();
    unmount();
    render(<ConfigForm config={file({ ...CONFIG, adzuna: { countries: ['nl', 'de'], keywords: ['php'], pagesPerSearch: 2 } })} />);
    expect(screen.getByLabelText(/^Adzuna countries/)).toHaveValue('nl\nde');
    expect(screen.getByLabelText(/^Adzuna keywords/)).toHaveValue('php');
    expect(screen.getByLabelText(/^Adzuna pages per search/)).toHaveValue(2);
  });

  it('submits the fields and shows "Saved" with the re-score count', async () => {
    vi.mocked(saveConfig).mockResolvedValue(saved('Saved. Re-scored 3 jobs.'));
    const user = userEvent.setup();
    render(<ConfigForm config={file(CONFIG)} />);
    await user.clear(screen.getByLabelText('Minimum score'));
    await user.type(screen.getByLabelText('Minimum score'), '50');
    await user.click(screen.getByLabelText('Search LinkedIn'));
    await user.click(screen.getByRole('button', { name: 'Save search settings' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Saved. Re-scored 3 jobs.');
    const fd = lastForm(saveConfig);
    expect(fd.get('minScore')).toBe('50');
    expect(fd.get('linkedin.enabled')).toBe('on');
    expect(fd.get('remote.boards')).toBe('himalayas\nremotive');
    expect(fd.get('companies[1].orig')).toBe('1');
    expect(fd.get('ai.alertStrong')).toBe('on');
    expect(fd.get('adzuna.countries')).toBe('');
  });

  it('adds and removes company rows, renumbering the fields', async () => {
    vi.mocked(saveConfig).mockResolvedValue(saved('Saved.'));
    const user = userEvent.setup();
    render(<ConfigForm config={file(CONFIG)} />);
    await user.click(screen.getByRole('button', { name: 'Remove company 1' }));
    await user.click(screen.getByRole('button', { name: '+ Add company' }));
    await user.type(screen.getByLabelText('Company 2 name'), 'Tamara');
    await user.type(screen.getByLabelText('Company 2 token'), 'tamara');
    await user.selectOptions(screen.getByLabelText('Company 2 ATS'), 'lever');
    await user.click(screen.getByRole('button', { name: 'Save search settings' }));

    await screen.findByRole('status');
    const fd = lastForm(saveConfig);
    expect([fd.get('companies[0].name'), fd.get('companies[0].orig')]).toEqual(['Odd', '1']);
    expect([fd.get('companies[1].name'), fd.get('companies[1].ats'), fd.get('companies[1].token'), fd.get('companies[1].orig')])
      .toEqual(['Tamara', 'lever', 'tamara', '-1']);
    expect(fd.has('companies[2].name')).toBe(false);
  });

  it('shows errors next to their fields and in a summary, keeping the edits', async () => {
    vi.mocked(saveConfig).mockResolvedValue(rejected([
      { path: 'companies[1].token', message: 'Too small' }, { path: 'linkedin.keywords[1]', message: 'Empty keyword' },
    ]));
    const user = userEvent.setup();
    render(<ConfigForm config={file(CONFIG)} />);
    await user.clear(screen.getByLabelText('Company 2 token'));
    await user.click(screen.getByRole('button', { name: 'Save search settings' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Not saved: 2 problems.');
    expect(alert).toHaveTextContent('companies[1].token: Too small');
    expect(screen.getByLabelText('Company 2 token').parentElement).toHaveTextContent('Too small');
    expect(screen.getByLabelText(/^Keywords/).closest('label')).toHaveTextContent('Empty keyword');
    expect(screen.getByLabelText(/^Keywords/).closest('label')).toHaveAttribute('data-invalid', 'true');
    expect(screen.getByLabelText('Minimum score').closest('label')).not.toHaveAttribute('data-invalid');
    expect(screen.getByLabelText('Company 2 token')).toHaveValue(''); // not reset to the old value
  });

  it('points to the JSON editor when config.json cannot be parsed', () => {
    render(<ConfigForm config={file(null, { text: '{', error: 'invalid JSON: x' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('config.json cannot be read (invalid JSON: x). Fix it under "Advanced: edit JSON".');
  });
});

describe('ApplicantForm', () => {
  it('shows the facts, with unknown ones empty', () => {
    render(<ApplicantForm applicant={file(APPLICANT)} />);
    expect(screen.getByLabelText('Current location')).toHaveValue('Lahore');
    expect(screen.getByLabelText('Nationality')).toHaveValue('');
    expect(screen.getByLabelText('AE')).toHaveValue('20k');
    expect(screen.getByLabelText('Remote')).toHaveValue('');
    expect(screen.getByLabelText('Other fact 1 name')).toHaveValue('github');
    expect(screen.getByLabelText('Other fact 1 value')).toHaveValue('gh/me');
    expect(screen.getByText(/the AI then writes \[FILL: …\]/)).toBeInTheDocument();
    expect(screen.queryByText(/does not exist yet/)).not.toBeInTheDocument();
  });

  it('says when the example file is shown', () => {
    render(<ApplicantForm applicant={file(APPLICANT, { example: true })} />);
    expect(screen.getByText(/cv\/applicant.json does not exist yet/)).toBeInTheDocument();
  });

  it('submits other facts as rows and shows errors for them', async () => {
    vi.mocked(saveApplicant).mockResolvedValue(rejected([{ path: 'other.github', message: 'Bad value' }]));
    const user = userEvent.setup();
    render(<ApplicantForm applicant={file(APPLICANT)} />);
    await user.click(screen.getByRole('button', { name: '+ Add fact' }));
    await user.type(screen.getByLabelText('Other fact 2 name'), 'portfolio');
    await user.type(screen.getByLabelText('Nationality'), 'Pakistani');
    await user.click(screen.getByRole('button', { name: 'Save applicant facts' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('other.github: Bad value');
    expect(screen.getByLabelText('Other fact 1 value').parentElement).toHaveTextContent('Bad value');
    const fd = lastForm(saveApplicant);
    expect(fd.get('nationality')).toBe('Pakistani');
    expect([fd.get('other[1].key'), fd.get('other[1].value')]).toEqual(['portfolio', '']);
  });
});

describe('JsonEditor', () => {
  it('submits the raw JSON with its kind', async () => {
    vi.mocked(saveJson).mockResolvedValue(saved('Saved.'));
    const user = userEvent.setup();
    render(<JsonEditor kind="applicant" file={file(APPLICANT)} />);
    await user.click(screen.getByText('Advanced: edit JSON'));
    const box = screen.getByLabelText('applicant JSON');
    expect(box).toHaveValue(JSON.stringify(APPLICANT));
    await user.clear(box);
    await user.type(box, '{{}');
    await user.click(screen.getByRole('button', { name: 'Save JSON' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    const fd = lastForm(saveJson);
    expect([fd.get('kind'), fd.get('json')]).toEqual(['applicant', '{}']);
  });
});

describe('SaveStatus', () => {
  it('shows nothing before the first save, and a pending note while saving', () => {
    const { container, rerender } = render(<SaveStatus state={null} pending={false} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<SaveStatus state={null} pending />);
    expect(screen.getByText('Saving…')).toBeInTheDocument();
  });
});

describe('Settings page content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-bot-web-settings-page-'));
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads both files and renders both forms with their JSON editors', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(CONFIG));
    vi.stubEnv('JOB_BOT_CONFIG', join(dir, 'config.json'));
    vi.stubEnv('JOB_BOT_APPLICANT', join(dir, 'missing.json'));
    render(await Settings());
    expect(screen.getByRole('form', { name: 'Search settings' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Applicant facts' })).toBeInTheDocument();
    expect(screen.getAllByText('Advanced: edit JSON')).toHaveLength(2);
    expect(screen.getByLabelText('Minimum score')).toHaveValue(45);
    expect(screen.getByText(/does not exist yet/)).toBeInTheDocument(); // example applicant file
    await waitFor(() => expect(screen.getByLabelText('config JSON')).toHaveValue(JSON.stringify(CONFIG)));
  });
});
