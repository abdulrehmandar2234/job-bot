import { configFile, ensureConfigFile, loadSettings, type Config } from './settings.ts';

// The schema, its types and the paths live in settings.ts. Logic that needs settings takes them as a parameter
// (`cfg`, see src/profile.ts and src/match.ts), so it can be imported without reading config.json — the dashboard
// does. `config` is the CLI's copy: config.json is read and validated on first use, not on import, so importing a
// module never fails because of the file. src/cli.ts still checks it before every command that needs it (NO_CONFIG).
export { ATS, ROOT, path, type Company, type Config, type Country } from './settings.ts';

let loaded: Config | null = null;

/** config.json, read and validated once (a fresh clone first gets a copy of config.default.json). */
export function loadConfig(): Config {
  if (!loaded) {
    ensureConfigFile();
    loaded = loadSettings('config', configFile());
  }
  return loaded;
}

/** The CLI's settings: config.json on first access. Writes go to the loaded object (tests change values in place). */
export const config: Config = new Proxy({} as Config, {
  get: (_t, p) => Reflect.get(loadConfig(), p),
  set: (_t, p, v) => Reflect.set(loadConfig(), p, v),
  has: (_t, p) => Reflect.has(loadConfig(), p),
  deleteProperty: (_t, p) => Reflect.deleteProperty(loadConfig(), p),
  ownKeys: () => Reflect.ownKeys(loadConfig()),
  getOwnPropertyDescriptor: (_t, p) => {
    const d = Reflect.getOwnPropertyDescriptor(loadConfig(), p);
    return d && { ...d, configurable: true };
  },
});
