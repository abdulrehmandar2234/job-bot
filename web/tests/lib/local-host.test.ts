import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { isLocalHost } from '@/lib/local-host';
import { proxy } from '../../proxy';
import pkg from '../../package.json';

describe('isLocalHost', () => {
  it.each(['localhost:3100', '127.0.0.1:3100', '[::1]:3100', 'LOCALHOST', 'localhost'])('accepts %s', (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it.each([null, '', '192.168.1.20:3100', 'evil.example', 'localhost.evil.example:3100', 'evil.example:3100', '127.0.0.1.nip.io'])(
    'refuses %s',
    (host) => {
      expect(isLocalHost(host)).toBe(false);
    },
  );
});

describe('proxy', () => {
  const req = (host: string) => new NextRequest('http://localhost:3100/', { headers: { host } });

  it('passes local requests on and refuses others with 403', async () => {
    expect(proxy(req('localhost:3100')).headers.get('x-middleware-next')).toBe('1');
    const res = proxy(req('192.168.1.20:3100'));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Talaash only answers on localhost');
  });
});

describe('npm scripts', () => {
  it('bind the dashboard to 127.0.0.1 only', () => {
    expect(pkg.scripts.dev).toContain('-H 127.0.0.1');
    expect(pkg.scripts.start).toContain('-H 127.0.0.1');
  });
});
