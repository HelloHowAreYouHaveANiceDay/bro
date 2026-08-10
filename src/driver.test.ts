// Tests for AC3 and AC4 (doctor() checks and e2e site discovery)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { doctor } from './driver.ts';

type Check = { name: string; ok: boolean; optional?: boolean; detail?: string };
type DoctorResult = { ok: boolean; detail: string; checks: Check[] };

describe('doctor config:sites (AC3)', () => {
  let origCwd: string;
  let origBroHome: string | undefined;
  let origBroSitesDir: string | undefined;

  beforeEach(() => {
    origCwd = process.cwd();
    origBroHome = process.env.BRO_HOME;
    origBroSitesDir = process.env.BRO_SITES_DIR;
    delete process.env.BRO_SITES_DIR;
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origBroHome === undefined) delete process.env.BRO_HOME;
    else process.env.BRO_HOME = origBroHome;
    if (origBroSitesDir === undefined) delete process.env.BRO_SITES_DIR;
    else process.env.BRO_SITES_DIR = origBroSitesDir;
  });

  it('AC3a: config:sites is optional and driver ok is true when sites dir is absent', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bro-test-data-'));
    const cwdDir = mkdtempSync(join(tmpdir(), 'bro-test-cwd-'));
    try {
      process.env.BRO_HOME = dataDir; // dataDir has no sites/ and no sites-dir cache
      process.chdir(cwdDir);

      const result = await doctor() as DoctorResult;
      const sitesCheck = result.checks.find((c) => c.name === 'config:sites');

      expect(sitesCheck).toBeDefined();
      expect(sitesCheck?.ok).toBe(false);
      expect(sitesCheck?.optional).toBe(true);
      // Overall driver ok must be true: the absent-sites check is advisory only
      expect(result.ok).toBe(true);
    } finally {
      process.chdir(origCwd); // restore before deleting cwdDir (Windows: can't delete cwd)
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  it('AC3b: config:sites is a hard failure when sites path exists but is not a directory', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bro-test-data-'));
    const cwdDir = mkdtempSync(join(tmpdir(), 'bro-test-cwd-'));
    try {
      // Create 'sites' as a FILE (not a directory); readdirSync on it throws ENOTDIR
      writeFileSync(join(dataDir, 'sites'), '');

      process.env.BRO_HOME = dataDir;
      process.chdir(cwdDir);

      const result = await doctor() as DoctorResult;
      const sitesCheck = result.checks.find((c) => c.name === 'config:sites');

      expect(sitesCheck?.ok).toBe(false);
      expect(sitesCheck?.optional).toBeFalsy(); // hard failure: not optional
      expect(result.ok).toBe(false);
    } finally {
      process.chdir(origCwd); // restore before deleting cwdDir (Windows: can't delete cwd)
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwdDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC4: synthetic e2e -- N configured site dirs + sites-dir cache + non-checkout cwd -> doctor
// finds N sites (filtering _example).
// ---------------------------------------------------------------------------
describe('doctor e2e via sites-dir cache (AC4)', () => {
  let origCwd: string;
  let origBroHome: string | undefined;
  let origBroSitesDir: string | undefined;

  beforeEach(() => {
    origCwd = process.cwd();
    origBroHome = process.env.BRO_HOME;
    origBroSitesDir = process.env.BRO_SITES_DIR;
    delete process.env.BRO_SITES_DIR;
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origBroHome === undefined) delete process.env.BRO_HOME;
    else process.env.BRO_HOME = origBroHome;
    if (origBroSitesDir === undefined) delete process.env.BRO_SITES_DIR;
    else process.env.BRO_SITES_DIR = origBroSitesDir;
  });

  it('reports N configured sites via cache when run from an unrelated cwd', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bro-test-data-'));
    const sitesRoot = mkdtempSync(join(tmpdir(), 'bro-test-sites-'));
    const cwdDir = mkdtempSync(join(tmpdir(), 'bro-test-cwd-'));
    try {
      const siteJson = JSON.stringify({ name: 's', loginUrl: 'https://x', homeUrl: 'https://x', source: 'x' });

      // Three configured sites
      for (const name of ['alpha', 'beta', 'gamma']) {
        mkdirSync(join(sitesRoot, name));
        writeFileSync(join(sitesRoot, name, 'site.json'), siteJson);
      }
      // _example template (must be filtered out by the doctor)
      mkdirSync(join(sitesRoot, '_example'));
      writeFileSync(join(sitesRoot, '_example', 'site.json'), siteJson);

      // Write the discovery cache (simulates having run `bro` from the checkout at least once)
      writeFileSync(join(dataDir, 'sites-dir'), sitesRoot, 'utf8');

      process.env.BRO_HOME = dataDir;
      process.chdir(cwdDir); // unrelated cwd: no checkout, no sites/

      const result = await doctor() as DoctorResult;
      const sitesCheck = result.checks.find((c) => c.name === 'config:sites');

      expect(sitesCheck?.ok).toBe(true);
      expect(sitesCheck?.detail).toBe('3 site(s) configured'); // _example excluded
      expect(sitesCheck?.optional).toBeFalsy();
    } finally {
      process.chdir(origCwd); // restore before deleting cwdDir (Windows: can't delete cwd)
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(sitesRoot, { recursive: true, force: true });
      rmSync(cwdDir, { recursive: true, force: true });
    }
  });
});
