import { beforeEach, describe, expect, it, vi } from 'vitest';

// The options lib/bot.ts gives node:child_process, with the module mocked: argument arrays (never a shell), and
// windowsHide so no console window opens on Windows for a dashboard task.
const cp = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: object, cb: (e: null, r: { stdout: string }) => void) =>
    cb(null, { stdout: 'ok' }),
  ),
}));
vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), ...cp }));

const { BOT_ROOT, runBot, spawnBot } = await import('@/lib/bot');

beforeEach(() => vi.clearAllMocks());

describe('lib/bot.ts child processes', () => {
  it('runBot runs node with an argument array, hidden on Windows', async () => {
    expect(await runBot(['stats'])).toBe('ok');
    expect(cp.execFile).toHaveBeenCalledWith(
      process.execPath,
      ['--no-warnings', '--env-file-if-exists=.env', 'src/cli.ts', 'stats'],
      expect.objectContaining({ cwd: BOT_ROOT, windowsHide: true }),
      expect.any(Function),
    );
    expect(cp.execFile.mock.calls[0][2]).not.toHaveProperty('shell');
  });

  it('spawnBot starts a detached worker without a console window', () => {
    spawnBot(['task:run', '7']);
    expect(cp.spawn).toHaveBeenCalledWith(
      process.execPath,
      ['--no-warnings', '--env-file-if-exists=.env', 'src/cli.ts', 'task:run', '7'],
      expect.objectContaining({ cwd: BOT_ROOT, detached: true, windowsHide: true }),
    );
  });
});
