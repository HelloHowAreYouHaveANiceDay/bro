import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BroError } from './errors.ts';

/** repo root (one level above src/) */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** sites dir — overridable via BRO_SITES_DIR so an OSS user can keep sites outside the repo */
export function sitesDir(): string {
  const override = process.env.BRO_SITES_DIR;
  return override ? path.resolve(override) : path.join(REPO_ROOT, 'sites');
}

export function siteDir(id: string): string {
  return path.join(sitesDir(), id);
}

export function authPath(id: string): string {
  return path.join(siteDir(id), 'auth.json');
}

export function authMetaPath(id: string): string {
  return path.join(siteDir(id), 'auth.meta.json');
}

/**
 * Persistent browser-profile dir for a site (site.browser === 'persistent'). Kept OUTSIDE the repo
 * (real login cookies live here) under the OS data dir; overridable via BRO_PROFILE_ROOT.
 */
export function profileDir(id: string): string {
  const override = process.env.BRO_PROFILE_ROOT;
  const root = override
    ? path.resolve(override)
    : path.join(
        process.platform === 'win32'
          ? process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local')
          : path.join(process.env.HOME || '.', '.local', 'share'),
        'bro',
        'profiles',
      );
  return path.join(root, id);
}

/**
 * Parse a --month arg (YYYY-MM). Defaults to the PREVIOUS month when absent, since accounting
 * flows run just after a month closes. Returns normalized parts.
 *
 * `now` is injectable for deterministic tests (production passes a real Date).
 */
export function resolveMonth(month: string | undefined, now: Date): { year: string; month: string; ym: string } {
  if (month !== undefined) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m) throw new BroError('bad-args', `--month must be YYYY-MM, got "${month}"`);
    const mm = Number(m[2]);
    if (mm < 1 || mm > 12) throw new BroError('bad-args', `--month has invalid month: "${month}"`);
    return { year: m[1]!, month: m[2]!, ym: `${m[1]}-${m[2]}` };
  }
  // previous month relative to `now` (UTC to avoid TZ drift)
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const year = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return { year, month: mm, ym: `${year}-${mm}` };
}

/** the {YYYY}/{MM}/{source} tree the sink writes under. */
export function accountingRelPath(source: string, year: string, month: string): string {
  return path.join(year, month, source);
}

/** strip anything that isn't safe in a filename, collapse whitespace */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 180);
}
