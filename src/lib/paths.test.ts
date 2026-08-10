import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveMonth, sanitizeFilename, accountingRelPath } from './paths.ts';
import { listSites } from './registry.ts';

describe('resolveMonth', () => {
  it('parses an explicit YYYY-MM', () => {
    expect(resolveMonth('2026-06', new Date('2026-07-21T00:00:00Z'))).toEqual({
      year: '2026',
      month: '06',
      ym: '2026-06',
    });
  });

  it('defaults to the previous month', () => {
    expect(resolveMonth(undefined, new Date('2026-07-21T00:00:00Z')).ym).toBe('2026-06');
  });

  it('rolls the year back across January', () => {
    expect(resolveMonth(undefined, new Date('2026-01-05T00:00:00Z')).ym).toBe('2025-12');
  });

  it('rejects malformed month', () => {
    expect(() => resolveMonth('2026/06', new Date())).toThrow();
    expect(() => resolveMonth('2026-13', new Date())).toThrow();
  });
});

describe('sanitizeFilename', () => {
  it('strips unsafe chars and collapses whitespace', () => {
    expect(sanitizeFilename('inv 01/02:03*?.pdf')).toBe('inv-01-02-03-.pdf');
  });
  it('keeps a clean name intact', () => {
    expect(sanitizeFilename('cloudflare-INV123.pdf')).toBe('cloudflare-INV123.pdf');
  });
});

describe('accountingRelPath', () => {
  it('builds {year}/{month}/{source}', () => {
    expect(accountingRelPath('cloudflare', '2026', '06').replace(/\\/g, '/')).toBe('2026/06/cloudflare');
  });
});

// ---------------------------------------------------------------------------
// sitesDir discovery cache (AC1 / AC2)
//
// AC1: fails against unfixed origin/main -- on unfixed code, sitesDir() ignores the sites-dir
//      cache file and returns <dataRoot>/sites (absent), so listSites() returns [].
// AC2: on fixed code, sitesDir() reads the cache file and listSites() returns the configured sites.
// ---------------------------------------------------------------------------
describe('sitesDir discovery cache', () => {
  let origCwd: string;
  let origBroHome: string | undefined;
  let origBroSitesDir: string | undefined;
  let dataDir: string;
  let sitesRoot: string;
  let cwdDir: string;

  beforeEach(() => {
    origCwd = process.cwd();
    origBroHome = process.env.BRO_HOME;
    origBroSitesDir = process.env.BRO_SITES_DIR;
    delete process.env.BRO_SITES_DIR;

    dataDir = mkdtempSync(join(tmpdir(), 'bro-test-data-'));
    sitesRoot = mkdtempSync(join(tmpdir(), 'bro-test-sites-'));
    cwdDir = mkdtempSync(join(tmpdir(), 'bro-test-cwd-'));

    // One configured site + the _example template
    const siteJson = JSON.stringify({ name: 'test', loginUrl: 'https://x', homeUrl: 'https://x', source: 'x' });
    mkdirSync(join(sitesRoot, 'testsite'));
    writeFileSync(join(sitesRoot, 'testsite', 'site.json'), siteJson);
    mkdirSync(join(sitesRoot, '_example'));
    writeFileSync(join(sitesRoot, '_example', 'site.json'), siteJson);
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origBroHome === undefined) delete process.env.BRO_HOME;
    else process.env.BRO_HOME = origBroHome;
    if (origBroSitesDir === undefined) delete process.env.BRO_SITES_DIR;
    else process.env.BRO_SITES_DIR = origBroSitesDir;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(sitesRoot, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
  });

  it(
    'AC1/AC2: listSites returns configured sites from non-checkout cwd via cache file ' +
    '(fails against unfixed origin/main)',
    () => {
      // Write the sites-dir cache -- the mechanism added by this fix.
      // On unfixed code, sitesDir() ignores this file: listSites() returns [] and the test fails.
      // On fixed code, sitesDir() reads this file: listSites() returns the sites and the test passes.
      writeFileSync(join(dataDir, 'sites-dir'), sitesRoot, 'utf8');

      process.env.BRO_HOME = dataDir;
      process.chdir(cwdDir); // unrelated cwd: no sites/ subdir

      const sites = listSites();
      expect(sites).toContain('testsite');
      expect(sites).toContain('_example');
      // Doctor filters _example; assert only real sites remain when filtered
      expect(sites.filter((s) => s !== '_example')).toHaveLength(1);
    },
  );

  it('auto-writes sites-dir cache when discovering sites from cwd, then finds them from a different cwd', () => {
    // Simulate running from the checkout: cwd contains sites/
    const checkoutDir = mkdtempSync(join(tmpdir(), 'bro-test-checkout-'));
    const checkoutData = mkdtempSync(join(tmpdir(), 'bro-test-checkout-data-'));
    try {
      const siteJson = JSON.stringify({ name: 'cs', loginUrl: 'https://x', homeUrl: 'https://x', source: 'x' });
      mkdirSync(join(checkoutDir, 'sites', 'checkoutsite'), { recursive: true });
      writeFileSync(join(checkoutDir, 'sites', 'checkoutsite', 'site.json'), siteJson);

      process.env.BRO_HOME = checkoutData;
      process.chdir(checkoutDir); // cwd has sites/

      // First call: sitesDir() discovers cwd/sites and writes the cache
      listSites();

      // Cache must now exist and contain the checkout sites path
      const cached = readFileSync(join(checkoutData, 'sites-dir'), 'utf8').trim();
      expect(cached.replace(/\\/g, '/')).toBe(join(checkoutDir, 'sites').replace(/\\/g, '/'));

      // Now move to an unrelated cwd (simulates running the SEA from anywhere)
      process.chdir(cwdDir);

      // Sites are still discoverable via the cache
      expect(listSites()).toContain('checkoutsite');
    } finally {
      rmSync(checkoutDir, { recursive: true, force: true });
      rmSync(checkoutData, { recursive: true, force: true });
    }
  });
});
