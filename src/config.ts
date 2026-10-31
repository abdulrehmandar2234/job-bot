import { CONFIG_FILE, ensureConfigFile, loadSettings, type Config } from './settings.ts';

// The schema, its types and the paths live in settings.ts; this module loads and validates config.json on import.
export { ATS, ROOT, path, type Company, type Config, type Country } from './settings.ts';

ensureConfigFile(CONFIG_FILE); // a fresh clone has only config.default.json
export const config: Config = loadSettings('config', CONFIG_FILE);
