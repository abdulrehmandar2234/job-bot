'use client';

import type { ChangeEvent, ComponentProps } from 'react';

/**
 * Submits the control's form as soon as its value changes, so a choice applies without pressing the form's submit
 * button. requestSubmit() (not submit()) runs the browser's normal submission, so a GET form navigates with every
 * field. Without JS these are plain controls and the form's own submit button still sends them.
 */
const submitForm = (e: ChangeEvent<HTMLSelectElement | HTMLInputElement>) => e.currentTarget.form?.requestSubmit();

export function AutoSelect({ onChange, ...props }: ComponentProps<'select'>) {
  return (
    <select
      {...props}
      onChange={(e) => {
        onChange?.(e);
        submitForm(e);
      }}
    />
  );
}

export function AutoCheckbox({ onChange, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <input
      {...props}
      type="checkbox"
      onChange={(e) => {
        onChange?.(e);
        submitForm(e);
      }}
    />
  );
}
