// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProfileBanner } from '@/components/profile-banner';

describe('ProfileBanner', () => {
  it('welcomes a first run and links to the settings and the setup wizard', () => {
    render(<ProfileBanner status={{ exists: false, gaps: ['countryCode'] }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Welcome! Set up your profile first.');
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.getByText('npm run bot -- setup')).toBeInTheDocument();
  });

  it('names what is missing in an incomplete profile', () => {
    render(<ProfileBanner status={{ exists: true, gaps: ['location', 'countryCode', 'languages'] }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Your profile is incomplete.');
    expect(screen.getByRole('status')).toHaveTextContent('Still missing: city and country, country code, languages.');
  });

  it('is gone once the profile is complete', () => {
    const { container } = render(<ProfileBanner status={{ exists: true, gaps: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
