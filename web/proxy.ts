import { type NextRequest, NextResponse } from 'next/server';
import { isLocalHost } from '@/lib/local-host';

/** Refuses every request whose Host is not this machine (see lib/local-host.ts). */
export function proxy(req: NextRequest) {
  if (!isLocalHost(req.headers.get('host'))) return new NextResponse('job-bot only answers on localhost', { status: 403 });
  return NextResponse.next();
}
