import Link from 'next/link';
import { connection } from 'next/server';
import { botCommand, NPM_BOT } from '@/lib/bot-command';
import { PROFILE_LABEL } from '@/lib/market';
import { readMarketLine, readProfileStatus, type ProfileStatus } from '@/lib/profile';

/** First-run banner: shown until cv/applicant.json exists and has every required profile field. */
export function ProfileBanner({ status, bot = NPM_BOT }: { status: ProfileStatus; bot?: string }) {
  if (status.exists && !status.gaps.length) return null;
  const missing = status.gaps.map((g) => PROFILE_LABEL[g]).join(', ');
  return (
    <div role="status" className="mb-5 rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:bg-sky-950 dark:text-sky-200">
      <p className="font-medium">{status.exists ? 'Your profile is incomplete.' : 'Welcome! Set up your profile first.'}</p>
      <p className="mt-1">
        {status.exists
          ? `Still missing: ${missing}. Letters, AI prompts and filters use it.`
          : 'Your name, contact, where you live and the countries you target go into cover letters, AI prompts and filters.'}{' '}
        <Link href="/settings" className="font-medium underline">
          Open Settings
        </Link>{' '}
        or run <code>{bot} setup</code>.
      </p>
    </div>
  );
}

/** The header subtitle (target markets from config.json) and the first-run banner, read on every request. */
export async function MarketHeader() {
  await connection();
  return <p className="text-sm text-zinc-500">{readMarketLine()}</p>;
}

export async function FirstRunBanner() {
  await connection();
  return <ProfileBanner status={readProfileStatus()} bot={botCommand()} />;
}
