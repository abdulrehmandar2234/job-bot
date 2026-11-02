// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MissingSkills } from '@/components/missing-skills';
import type { TextFormState } from '@/lib/written-text';

// "I have this" for the job keywords that are not on the master CV, with a note for the AI.

describe('MissingSkills', () => {
  it('sends the ticked skills and the note, then says what it started', async () => {
    const add = vi.fn(async (_prev: TextFormState, _fd: FormData) => ({ ok: true, message: 'Adding the skills…' }));
    render(<MissingSkills id="job-1" missing={['Docker', 'Kafka', 'Go']} add={add} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Docker' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Go' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Anything the AI should know/ }), { target: { value: 'used Docker in CI' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to my CV and improve it for this job' }));

    await waitFor(() => expect(add).toHaveBeenCalledOnce());
    const fd = add.mock.calls[0][1];
    expect(fd.get('id')).toBe('job-1');
    expect(fd.getAll('skill')).toEqual(['Docker', 'Go']);
    expect(fd.get('feedback')).toBe('used Docker in CI');
    expect(await screen.findByRole('status')).toHaveTextContent('Adding the skills…');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('keeps the note and shows the problem when the action refuses', async () => {
    const add = vi.fn(async () => ({ ok: false, message: 'Tick the skills you have first.' }));
    render(<MissingSkills id="job-1" missing={['Docker']} add={add} />);
    const note = screen.getByRole('textbox', { name: /Anything the AI should know/ });
    fireEvent.change(note, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to my CV and improve it for this job' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tick the skills you have first.');
    expect(note).toHaveValue('hello');
  });

  it('starts with nothing ticked and says ticked skills go on the master CV', () => {
    render(<MissingSkills id="job-1" missing={['Docker', 'Kafka']} add={vi.fn()} />);
    expect(screen.getAllByRole('checkbox').every((c) => !(c as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText(/Ticked skills go on your master CV \(a copy of it is kept first\)/)).toBeInTheDocument();
  });
});
