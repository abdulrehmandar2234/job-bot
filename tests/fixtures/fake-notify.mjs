#!/usr/bin/env node
// Stands in for the macOS notifier in tests (JOB_BOT_NOTIFY). Appends its arguments (title, message, url)
// as one JSON line to FAKE_NOTIFY_LOG.
import { appendFileSync } from 'node:fs';

if (process.env.FAKE_NOTIFY_LOG) appendFileSync(process.env.FAKE_NOTIFY_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
