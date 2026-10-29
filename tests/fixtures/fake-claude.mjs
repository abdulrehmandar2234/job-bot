#!/usr/bin/env node
// Stands in for the `claude` CLI in tests (JOB_BOT_CLAUDE). Replies with FAKE_CLAUDE_OUT as structured_output,
// or fails when FAKE_CLAUDE_FAIL is set. Writes its argv and stdin to FAKE_CLAUDE_LOG for assertions.
import { appendFileSync, readFileSync } from 'node:fs';

const stdin = readFileSync(0, 'utf8');
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\n');
if (process.env.FAKE_CLAUDE_FAIL) {
  process.stdout.write(JSON.stringify({ is_error: true, result: process.env.FAKE_CLAUDE_FAIL }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ is_error: false, structured_output: JSON.parse(process.env.FAKE_CLAUDE_OUT ?? '{}') }));
