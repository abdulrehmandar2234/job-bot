#!/usr/bin/env node
// Stands in for the `claude` CLI in tests (JOB_BOT_CLAUDE). Replies with FAKE_CLAUDE_OUT as structured_output,
// or fails when FAKE_CLAUDE_FAIL is set. Writes its pid, argv and stdin to FAKE_CLAUDE_LOG for assertions.
// FAKE_CLAUDE_HANG: ignore SIGTERM and never answer, like a wedged CLI (tests of the SIGKILL escalation).
import { appendFileSync, readFileSync } from 'node:fs';

const stdin = readFileSync(0, 'utf8');
if (process.env.FAKE_CLAUDE_LOG)
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), stdin }) + '\n');
if (process.env.FAKE_CLAUDE_HANG) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 60_000);
} else if (process.env.FAKE_CLAUDE_FAIL) {
  process.stdout.write(JSON.stringify({ is_error: true, result: process.env.FAKE_CLAUDE_FAIL }));
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({ is_error: false, structured_output: JSON.parse(process.env.FAKE_CLAUDE_OUT ?? '{}') }));
}
