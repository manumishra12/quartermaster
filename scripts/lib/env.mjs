/**
 * Loads .env, because the README tells you to create one.
 *
 * Node can do this with --env-file, but that flag is rejected inside NODE_OPTIONS and does not
 * survive being run through tsx, so the scripts here would each need their own invocation. Forty
 * lines is cheaper than a dependency, and cheaper than a README that lies.
 *
 * A variable already set in the real environment always wins. Overriding an explicit
 * `TRUEFORGE_MODEL=... npm run x` with a stale value from a file would be an unpleasant surprise.
 */
import { existsSync, readFileSync } from 'node:fs';

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    // Strip one matching pair of quotes, and only a matching pair.
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    } else {
      // An unquoted trailing comment is a comment, not part of the value.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Populate process.env from a .env file, without clobbering what is already set. */
export function loadEnv(path = '.env') {
  if (!existsSync(path)) return {};
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  const applied = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied[key] = value;
    }
  }
  return applied;
}
