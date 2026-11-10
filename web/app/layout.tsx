import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { ThemeToggle } from '@/components/theme-toggle';
import { THEME_SCRIPT } from '@/lib/theme';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Job Bot',
  description: 'Finds, scores and prepares jobs for the countries in your settings',
};

// suppressHydrationWarning: browser extensions add attributes to <html> and <body> before React loads (ColorZilla's
// cz-shortcut-listen, Grammarly's data-gr-*), which Next.js otherwise reports as a hydration error on every page, and
// the theme script sets <html data-theme> before React loads too. It covers only these two elements' own attributes,
// not the page inside them.
export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed script from lib/theme.ts, no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {children}
        <ThemeToggle />
      </body>
    </html>
  );
}
