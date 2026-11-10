// Error classes shared by modules that must stay free of imports (the dashboard may load this file too).

/**
 * A problem the user can fix (a bad setting, a missing file or program, an AI setup problem): its message is the
 * whole story, so src/cli.ts prints just the message and exits 1 instead of a stack trace. ConfigError, AiError
 * (src/ai-providers.ts) and InvalidSettingsError (src/settings.ts) extend it.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/**
 * A problem with the user's settings or files that every posting would hit alike: an unknown stack id in
 * config.json, a missing or unreadable cv/master.json. Fetch stops on it once instead of counting it per posting
 * (src/commands/fetch.ts). Matched by class here and by `name` where importing this module is not wanted.
 */
export class ConfigError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
