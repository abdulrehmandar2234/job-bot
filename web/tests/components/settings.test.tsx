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
import { SETTINGS_GROUPS } from '@/lib/settings-sections';
import type { SettingsFile } from '@/lib/settings';

vi.mock('@/app/settings/actions', () => ({ saveConfig: vi.fn(), saveApplicant: vi.fn(), saveJson: vi.fn() }));
vi.mock('next/server', () => ({ connection: vi.fn(async () => {}) }));

const CONFIG = {
  minScore: 45,
  maxAgeDays: 14,
  autoCvVersions: false,
  roleInclude: 'laravel|php',
  roleExclude: 'senior',
  ai: { enabled: true, scoreModel: 'haiku', letterModel: 'sonnet', maxScorePerRun: 80 },
  linkedin: { enabled: false, keywords: ['php', 'react'], locations: ['Dubai'], remoteFrom: 'Pakistan', pagesPerSearch: 2 },
  remote: { enabled: true, boards: ['himalayas', 'remotive'], himalayasQueries: ['php'], allow: 'worldwide', deny: 'us', flag: 'emea' },
  countries: { AE: { name: 'UAE', visa: 'employer', match: 'dubai|uae' } },
  companies: [
    { name: 'Careem', ats: 'greenhouse', token: 'careem' },
    { name: 'Odd', ats: 'taleo', token: 'odd' },
  ],
};
const APPLICANT = {
  _help: 'h',
  currentLocation: 'Lahore',
  nationality: null,
  expectedSalary: { AE: '20k', SA: null },
  other: { github: 'gh/me' },
};
const file = (data: object | null, extra: Partial<SettingsFile> = {}): SettingsFile => ({
  file: '/x/file.json',
  text: JSON.stringify(data),
  data: data as SettingsFile['data'],
  error: null,
  example: false,
  ...extra,
});

const saved = (message: string): SaveState => ({ ok: true, message, errors: [] });
const rejected = (errors: { path: string; message: string }[]): SaveState => ({
  ok: false,
  message: `Not saved: ${errors.length} problems.`,
  errors,
});
const lastForm = (fn: unknown) => vi.mocked(fn as typeof saveConfig).mock.calls.at(-1)![1];

beforeEach(() => {
  vi.clearAllMocks();
});

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
    expect(screen.getByLabelText('Claude CLI score model')).toHaveValue('haiku');
    expect(screen.getAllByTestId('company-row')).toHaveLength(2);
    expect(screen.getByLabelText('Company 1 ATS')).toHaveValue('greenhouse');
    expect(
      within(screen.getByLabelText('Company 1 ATS'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['greenhouse', 'lever', 'ashby', 'recruitee', 'workable', 'smartrecruiters', 'workday']);
    // An ats the dashboard does not know yet stays selected rather than being changed.
    expect(screen.getByLabelText('Company 2 ATS')).toHaveValue('taleo');
  });

  it('shows the CV template select (classic when not set) with preview links', () => {
    const { unmount } = render(<ConfigForm config={file(CONFIG)} />);
    const select = screen.getByLabelText(/^CV template/);
    expect(select).toHaveValue('');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => [o.getAttribute('value'), o.textContent?.split(' · ')[0]]),
    ).toEqual([
      ['', 'Classic'],
      ['modern', 'Modern'],
      ['compact', 'Compact'],
    ]);
    expect(screen.getByRole('link', { name: 'Modern' })).toHaveAttribute('href', '/api/cv/preview/modern');
    unmount();
    render(<ConfigForm config={file({ ...CONFIG, cvTemplate: 'compact' })} />);
    expect(screen.getByLabelText(/^CV template/)).toHaveValue('compact');
  });

  it('shows strong-match alerts as on unless the file turns them off', () => {
    const { unmount } = render(<ConfigForm config={file(CONFIG)} />);
    expect(screen.getByLabelText(/Alert me at once for strong matches/)).toBeChecked(); // missing = on
    unmount();
    render(<ConfigForm config={file({ ...CONFIG, ai: { ...CONFIG.ai, alertStrong: false } })} />);
    expect(screen.getByLabelText(/Alert me at once for strong matches/)).not.toBeChecked();
  });

  const NO_KEY = { keyEnv: null, provider: null };

  it('shows the AI provider select (Claude CLI by default) with no key field, and the API fields only for "API key"', async () => {
    const user = userEvent.setup();
    render(<ConfigForm config={file(CONFIG)} keys={NO_KEY} />);
    const select = screen.getByLabelText(/^AI provider/);
    expect(select).toHaveValue('claude-cli');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Claude CLI', 'API key']);
    expect(screen.getByText(/no API key, usage comes from your Claude plan/)).toBeInTheDocument();
    expect(screen.queryByTestId('ai-key-status')).toBeNull(); // the Claude CLI needs no key
    expect(screen.queryByLabelText(/^API provider/)).toBeNull();
    expect(screen.getByText(/put AI_API_KEY=\.\.\. in \.env in the job-bot folder/)).toBeInTheDocument();

    await user.selectOptions(select, 'api');
    const preset = screen.getByLabelText(/^API provider/);
    expect(preset).toHaveValue('');
    expect(
      within(preset)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Auto-detect from key',
      'OpenAI',
      'DeepSeek',
      'Anthropic',
      'Gemini',
      'Groq',
      'OpenRouter',
      'Mistral',
      'Together AI',
      'Ollama',
      'Custom',
    ]);
    expect(screen.getByTestId('ai-key-status')).toHaveTextContent('AI_API_KEY is not set');
    expect(screen.getByLabelText(/^Base URL/)).toHaveValue('');
    expect(screen.getByText(/paid per token/)).toBeInTheDocument();
    expect(screen.getByText(/DeepSeek keys also start with sk-/)).toBeInTheDocument();
    expect(document.querySelector('input[name*="key" i]')).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('says whose key AI_API_KEY looks like, and shows the defaults of the detected or chosen preset', async () => {
    const user = userEvent.setup();
    const ai = { ...CONFIG.ai, provider: 'api', api: { scoreModel: 'claude-x' } };
    render(<ConfigForm config={file({ ...CONFIG, ai })} keys={{ keyEnv: 'AI_API_KEY', provider: 'anthropic' }} />);
    expect(screen.getByLabelText(/^AI provider/)).toHaveValue('api');
    expect(screen.getByTestId('ai-key-status')).toHaveTextContent('AI_API_KEY is set (looks like an Anthropic key).');
    expect(screen.getByLabelText(/^API score model/)).toHaveValue('claude-x');
    expect(screen.getByText('empty = https://api.anthropic.com/v1')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^API provider/), 'groq');
    expect(screen.getByText('empty = llama-3.3-70b-versatile')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^API provider/), 'ollama');
    expect(screen.getByTestId('ai-key-status')).toHaveTextContent('Ollama needs no key');
  });

  it('a key whose provider cannot be told asks to choose one', () => {
    const ai = { ...CONFIG.ai, provider: 'api' };
    render(<ConfigForm config={file({ ...CONFIG, ai })} keys={{ keyEnv: 'AI_API_KEY', provider: null }} />);
    expect(screen.getByTestId('ai-key-status')).toHaveTextContent('its provider cannot be told from the key: choose its provider below');
  });

  it('shows an older "deepseek" config as "API key" with that preset and its models', () => {
    const ai = { ...CONFIG.ai, provider: 'deepseek', deepseek: { letterModel: 'deepseek-reasoner' } };
    render(<ConfigForm config={file({ ...CONFIG, ai })} keys={{ keyEnv: 'DEEPSEEK_API_KEY', provider: 'deepseek' }} />);
    expect(screen.getByLabelText(/^AI provider/)).toHaveValue('api');
    expect(screen.getByLabelText(/^API provider/)).toHaveValue('deepseek');
    expect(screen.getByLabelText(/^API letter model/)).toHaveValue('deepseek-reasoner');
    expect(screen.getByTestId('ai-key-status')).toHaveTextContent('DEEPSEEK_API_KEY is set (looks like a DeepSeek key).');
  });

  it('submits the chosen provider, preset and model fields', async () => {
    vi.mocked(saveConfig).mockResolvedValue(saved('Saved.'));
    const user = userEvent.setup();
    render(<ConfigForm config={file(CONFIG)} />);
    await user.selectOptions(screen.getByLabelText(/^AI provider/), 'api');
    await user.selectOptions(screen.getByLabelText(/^API provider/), 'deepseek');
    await user.type(screen.getByLabelText(/^API letter model/), 'deepseek-reasoner');
    await user.click(screen.getByRole('button', { name: 'Save search settings' }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalled());
    const fd = lastForm(saveConfig);
    expect(fd.get('ai.provider')).toBe('api');
    expect(fd.get('ai.api.preset')).toBe('deepseek');
    expect(fd.get('ai.api.letterModel')).toBe('deepseek-reasoner');
    expect(fd.get('ai.api.baseUrl')).toBe('');
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
    expect([fd.get('companies[1].name'), fd.get('companies[1].ats'), fd.get('companies[1].token'), fd.get('companies[1].orig')]).toEqual([
      'Tamara',
      'lever',
      'tamara',
      '-1',
    ]);
    expect(fd.has('companies[2].name')).toBe(false);
  });

  it('shows errors next to their fields and in a summary, keeping the edits', async () => {
    vi.mocked(saveConfig).mockResolvedValue(
      rejected([
        { path: 'companies[1].token', message: 'Too small' },
        { path: 'linkedin.keywords[1]', message: 'Empty keyword' },
      ]),
    );
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

  it('edits the visa need and label of each country and the remote-from country', async () => {
    vi.mocked(saveConfig).mockResolvedValue(saved('Saved.'));
    const user = userEvent.setup();
    const config = {
      ...CONFIG,
      countries: { ...CONFIG.countries, NL: { name: 'Netherlands', visa: 'ind-register', match: 'nl', needsVisa: false, label: 'NL' } },
      remote: { ...CONFIG.remote, from: 'Portugal', fromCode: 'PT' },
    };
    render(<ConfigForm config={file(config)} />);
    expect(screen.getByLabelText('I need a work visa for UAE')).toBeChecked(); // missing = needed
    expect(screen.getByLabelText('I need a work visa for Netherlands')).not.toBeChecked();
    expect(screen.getByLabelText(/^NL label/)).toHaveValue('NL');
    expect(screen.getByLabelText(/^Remote work from \(country\)/)).toHaveValue('Portugal');
    expect(screen.getByLabelText(/^Its country code/)).toHaveValue('PT');
    await user.click(screen.getByLabelText('I need a work visa for UAE'));
    await user.clear(screen.getByLabelText(/^Remote work from \(country\)/));
    await user.type(screen.getByLabelText(/^Remote work from \(country\)/), 'Spain');
    await user.click(screen.getByRole('button', { name: 'Save search settings' }));
    await screen.findByRole('status');
    const fd = lastForm(saveConfig);
    expect(fd.has('countries.AE.needsVisa')).toBe(false); // unchecked
    expect(fd.get('countries.AE.match')).toBe('dubai|uae');
    expect(fd.get('remote.from')).toBe('Spain');
  });

  it('points to the JSON editor when config.json cannot be parsed', () => {
    render(<ConfigForm config={file(null, { text: '{', error: 'invalid JSON: x' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'config.json cannot be read (invalid JSON: x). Fix it under "Advanced: edit JSON".',
    );
  });
});

describe('ApplicantForm', () => {
  it('shows the facts, with unknown ones empty', () => {
    render(<ApplicantForm applicant={file(APPLICANT)} salaryKeys={['AE', 'SA', 'remote']} />);
    expect(screen.getByLabelText('Current location')).toHaveValue('Lahore');
    expect(screen.getByLabelText('Nationality')).toHaveValue('');
    expect(screen.getByLabelText('AE')).toHaveValue('20k');
    expect(screen.getByLabelText('Remote')).toHaveValue('');
    expect(screen.getByLabelText('Other fact 1 name')).toHaveValue('github');
    expect(screen.getByLabelText('Other fact 1 value')).toHaveValue('gh/me');
    expect(screen.getByText(/the AI then writes \[FILL: …\]/)).toBeInTheDocument();
    expect(screen.queryByText(/does not exist yet/)).not.toBeInTheDocument();
  });

  it('says when the example file is shown, with the example person only as placeholders', () => {
    render(<ApplicantForm applicant={file({ ...APPLICANT, fullName: 'Jane Doe' }, { example: true })} />);
    expect(screen.getByText(/cv\/applicant.json does not exist yet/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Full name/)).toHaveValue('');
    expect(screen.getByLabelText(/^Full name/)).toHaveAttribute('placeholder', 'Jane Doe');
    expect(screen.getByLabelText('Current location')).toHaveValue('');
  });

  it('shows and submits the profile and the template-letter sentences', async () => {
    vi.mocked(saveApplicant).mockResolvedValue(saved('Saved.'));
    const user = userEvent.setup();
    const app = {
      ...APPLICANT,
      fullName: 'Jane Doe',
      countryCode: 'PT',
      utcOffset: 'GMT+0',
      coverLetter: { intro: 'I am Jane.', pitch: { default: 'I build.' } },
    };
    render(<ApplicantForm applicant={file(app)} salaryKeys={['NL', 'remote']} />);
    expect(screen.getByLabelText(/^Full name/)).toHaveValue('Jane Doe');
    expect(screen.getByLabelText(/^Country code/)).toHaveValue('PT');
    expect(screen.getByLabelText(/^UTC offset/)).toHaveValue('GMT+0');
    expect(screen.getByLabelText(/^Introduction/)).toHaveValue('I am Jane.');
    expect(screen.getByLabelText(/^Pitch/)).toHaveValue('I build.');
    expect(screen.getByLabelText('NL')).toHaveValue('');
    expect(screen.queryByLabelText('AE')).not.toBeInTheDocument(); // salary keys follow the target countries
    await user.type(screen.getByLabelText(/^Email/), 'jane@example.org');
    await user.type(screen.getByLabelText(/^Remote experience/), 'have worked remotely');
    await user.click(screen.getByRole('button', { name: 'Save applicant facts' }));
    await screen.findByRole('status');
    const fd = lastForm(saveApplicant);
    expect(fd.get('email')).toBe('jane@example.org');
    expect(fd.get('coverLetter.remote')).toBe('have worked remotely');
    expect(fd.get('expectedSalary.NL')).toBe('');
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads both files and renders both forms with their JSON editors', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(CONFIG));
    vi.stubEnv('JOB_BOT_CONFIG', join(dir, 'config.json'));
    vi.stubEnv('JOB_BOT_APPLICANT', join(dir, 'missing.json'));
    render(await Settings());
    expect(screen.getByRole('form', { name: 'Search settings' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Applicant facts' })).toBeInTheDocument();
    expect(screen.getAllByText('Advanced: edit JSON', { selector: 'summary' })).toHaveLength(2);
    expect(screen.getByLabelText('Minimum score')).toHaveValue(45);
    expect(screen.getByText(/does not exist yet/)).toBeInTheDocument(); // example applicant file
    await waitFor(() => expect(screen.getByLabelText('config JSON')).toHaveValue(JSON.stringify(CONFIG)));
  });

  it("passes the key status from the bot's env file to the form, by name and detected provider only", async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...CONFIG, ai: { ...CONFIG.ai, provider: 'api' } }));
    writeFileSync(join(dir, 'env'), 'AI_API_KEY=gsk_very-secret\n');
    vi.stubEnv('JOB_BOT_CONFIG', join(dir, 'config.json'));
    vi.stubEnv('JOB_BOT_APPLICANT', join(dir, 'missing.json'));
    vi.stubEnv('JOB_BOT_ENV_FILE', join(dir, 'env'));
    for (const k of ['AI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY']) vi.stubEnv(k, '');
    const { container } = render(await Settings());
    expect(screen.getByTestId('ai-key-status')).toHaveTextContent('AI_API_KEY is set (looks like a Groq key).');
    expect(container.innerHTML).not.toContain('very-secret');
    expect(container.innerHTML).not.toContain('gsk_');
  });

  it('links the section nav to every section, and every section is still rendered with its title', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(CONFIG));
    vi.stubEnv('JOB_BOT_CONFIG', join(dir, 'config.json'));
    vi.stubEnv('JOB_BOT_APPLICANT', join(dir, 'missing.json'));
    render(await Settings());
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    const ids = SETTINGS_GROUPS.flatMap((g) => [g.id, ...g.sections.map((x) => x.id)]);
    expect(hrefs).toEqual(ids.map((id) => `#${id}`));
    for (const g of SETTINGS_GROUPS) {
      const group = document.getElementById(g.id)!;
      expect(group).toBeInTheDocument();
      expect(within(group).getByRole('heading', { level: 2, name: g.title })).toBeInTheDocument();
      for (const x of g.sections) {
        // Each section is inside its group, and shows its title: a fieldset legend, or the JSON editor's summary.
        const el = document.getElementById(x.id)!;
        expect(group).toContainElement(el);
        expect(el.querySelector('legend, summary')).toHaveTextContent(x.title);
      }
    }
    expect([...document.querySelectorAll('fieldset')].map((f) => f.id)).toEqual(
      SETTINGS_GROUPS.flatMap((g) => g.sections.map((x) => x.id)).filter((id) => !id.endsWith('-json')),
    );
  });

  it("keeps each form's save button and status in a sticky bar at the end of the form", async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(CONFIG));
    vi.stubEnv('JOB_BOT_CONFIG', join(dir, 'config.json'));
    vi.stubEnv('JOB_BOT_APPLICANT', join(dir, 'missing.json'));
    render(await Settings());
    for (const [form, button] of [
      ['Search settings', 'Save search settings'],
      ['Applicant facts', 'Save applicant facts'],
    ]) {
      const bar = within(screen.getByRole('form', { name: form })).getByRole('button', { name: button }).parentElement!;
      expect(bar).toHaveAttribute('data-testid', 'save-bar');
      expect(bar).toHaveClass('sticky', 'bottom-0');
      expect(bar.parentElement!.lastElementChild).toBe(bar);
    }
    // The JSON editors keep their plain save row inside the folded card.
    for (const b of screen.getAllByRole('button', { name: 'Save JSON', hidden: true })) expect(b.parentElement).not.toHaveClass('sticky');
  });
});
