// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteContact, saveContact } from '@/app/jobs/[id]/contact-actions';
import { ContactForm } from '@/components/contact-form';
import { Contacts, ReferralBadge, ReferralReminder } from '@/components/contacts';
import type { CompanyContact } from '@/lib/contacts';

vi.mock('@/app/jobs/[id]/contact-actions', () => ({ saveContact: vi.fn(), deleteContact: vi.fn() }));

const contact = (o: Partial<CompanyContact> = {}): CompanyContact => ({
  id: 1,
  job_id: 'j1',
  name: 'Jane Doe',
  role: 'recruiter',
  email: 'jane@acme.com',
  linkedin_url: 'https://www.linkedin.com/in/jane',
  phone: '+971 50 1',
  notes: 'Met at GITEX',
  referral_status: 'none',
  created_at: new Date(),
  company: 'Acme',
  job_title: 'Backend Engineer',
  ...o,
});
const job = { id: 'j1', company: 'Acme Inc.', status: 'new' as const };
const lastForm = () => vi.mocked(saveContact).mock.calls.at(-1)![1] as FormData;

beforeEach(() => vi.clearAllMocks());

describe('Contacts', () => {
  it("lists this job's contacts with delete and edit, and an add form", () => {
    render(<Contacts job={job} contacts={[contact(), contact({ id: 2, name: 'Other Co person', company: 'Other', job_id: 'j3' })]} />);
    const item = screen.getByText('Jane Doe').closest('li')!;
    expect(item).toHaveTextContent('recruiter');
    expect(within(item).getByRole('link', { name: 'jane@acme.com' })).toHaveAttribute('href', 'mailto:jane@acme.com');
    expect(within(item).getByRole('link', { name: 'LinkedIn ↗' })).toHaveAttribute('href', 'https://www.linkedin.com/in/jane');
    const del = within(item).getByRole('button', { name: 'Delete' }).closest('form')!;
    expect((del.querySelector('input[name="contact_id"]') as HTMLInputElement).value).toBe('1');
    expect(within(item).getByRole('button', { name: 'Save contact' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add contact' })).toBeInTheDocument();
    expect(screen.queryByText('Other Co person')).not.toBeInTheDocument();
    expect(screen.queryByText(/You know someone at/)).not.toBeInTheDocument();
    expect(deleteContact).not.toHaveBeenCalled();
  });

  it('shows "You know someone at <company>" for contacts added on other jobs of the same company', () => {
    render(
      <Contacts job={job} contacts={[contact({ id: 5, job_id: 'j2', name: 'Sam', job_title: 'Frontend Engineer', company: 'ACME' })]} />,
    );
    const box = screen.getByText('You know someone at Acme Inc.').parentElement!;
    expect(box).toHaveTextContent('Sam');
    expect(within(box).getByRole('link', { name: 'added on Frontend Engineer' })).toHaveAttribute('href', '/jobs/j2');
    expect(within(box).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('referral reminder', () => {
  it('asks to request a referral before applying, naming the job the contact came from', () => {
    render(<ReferralReminder job={job} contacts={[contact({ job_id: 'j2', name: 'Sam', job_title: 'Frontend Engineer' })]} />);
    expect(screen.getByText(/Ask/)).toHaveTextContent('Ask Sam for a referral before applying (you added them on Frontend Engineer).');
  });

  it('shows nothing once the referral was asked for, or after applying', () => {
    const { container } = render(
      <>
        <ReferralReminder job={job} contacts={[contact({ referral_status: 'asked' })]} />
        <ReferralReminder job={{ ...job, status: 'applied' }} contacts={[contact()]} />
        <ReferralBadge job={{ ...job, status: 'applied' }} contacts={[contact()]} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('the list badge names the contact', () => {
    render(<ReferralBadge job={job} contacts={[contact({ referral_status: 'to ask' })]} />);
    expect(screen.getByText('🤝 Ask Jane Doe for a referral')).toHaveAttribute('title', 'Ask Jane Doe for a referral before applying');
  });
});

describe('ContactForm', () => {
  it('submits the job id and fields, and shows "Saved."', async () => {
    vi.mocked(saveContact).mockResolvedValue({ ok: true, errors: [] });
    const user = userEvent.setup();
    render(<ContactForm jobId="j1" />);
    expect(screen.getByLabelText('Role')).toHaveValue('recruiter');
    await user.type(screen.getByLabelText('Name'), 'Jane');
    await user.type(screen.getByLabelText('Email'), 'jane@acme.com');
    await user.selectOptions(screen.getByLabelText('Referral'), 'to ask');
    await user.click(screen.getByRole('button', { name: 'Add contact' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    const fd = lastForm();
    expect([fd.get('id'), fd.get('name'), fd.get('email'), fd.get('referral_status'), fd.get('contact_id')]).toEqual([
      'j1',
      'Jane',
      'jane@acme.com',
      'to ask',
      null,
    ]);
  });

  it("edits an existing contact and lists the server's validation errors", async () => {
    vi.mocked(saveContact).mockResolvedValue({ ok: false, errors: ['email is not a valid address'] });
    const user = userEvent.setup();
    render(<ContactForm jobId="j1" contact={contact()} />);
    expect(screen.getByLabelText('Name')).toHaveValue('Jane Doe');
    expect(screen.getByLabelText('LinkedIn URL')).toHaveAttribute('pattern', 'https://.*');
    await user.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('email is not a valid address');
    expect(lastForm().get('contact_id')).toBe('1');
  });
});
