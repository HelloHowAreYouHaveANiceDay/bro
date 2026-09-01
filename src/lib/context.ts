import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Download, Locator, Page } from 'playwright';
import { loadPlaywright } from './playwright.ts';

// Load playwright via createRequire (pinned to the runtime dir in the standalone SEA) rather than a
// static `import ... from 'playwright'`, which esbuild would compile to a bundle-level require that
// runs in the SEA's builtin-only require context ("No such built-in module: playwright").
const { chromium } = loadPlaywright();
import type { DownloadedFile, ReachTarget, SaveOptions, SiteConfig, WorkflowContext } from './types.ts';
import type { Sink } from './sink.ts';
import type { RunLog } from './log.ts';
import { humanPause } from './human.ts';
import { sanitizeFilename } from './paths.ts';

type ReachRole = Parameters<Page['getByRole']>[0];

const DEFAULT_REACH_ROLES: ReachRole[] = ['link', 'button', 'menuitem', 'tab'];

/** A bare string arg to save()/saveUrl() is shorthand for { invoiceId }. */
function normalizeSaveOpts(opts?: string | SaveOptions): SaveOptions {
  return typeof opts === 'string' ? { invoiceId: opts } : (opts ?? {});
}

function reachLocators(page: Page, target: ReachTarget): Locator[] {
  if (target.role) {
    return [target.text === undefined ? page.getByRole(target.role as ReachRole) : page.getByRole(target.role as ReachRole, { name: target.text })];
  }
  if (target.text === undefined) return [];
  return DEFAULT_REACH_ROLES.map((role) => page.getByRole(role, { name: target.text }));
}

async function firstVisible(locator: Locator): Promise<Locator | null> {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function findReachAffordance(page: Page, target: ReachTarget): Promise<Locator | null> {
  for (const locator of reachLocators(page, target)) {
    const candidate = await firstVisible(locator);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Build the WorkflowContext injected into run(). `sinkFor(source, year, month)` returns the sink for
 * one (source, year, month), or null in dry-run (`bro test`) — files are staged and measured but
 * never shipped (read-only guardrail for authoring in a live account). A workflow can file each
 * download under a different source (multi-account logins) and/or a different month (a backfill
 * spanning months) by passing { source, ym } to save(); absent, it uses `defaultSource` (= site.source)
 * and the run's `defaultYear`/`defaultMonth`.
 */
export function buildContext(args: {
  page: Page;
  context: BrowserContext;
  site: SiteConfig;
  params: Record<string, string>;
  sinkFor: (source: string, year: string, month: string) => Sink | null;
  defaultSource: string;
  defaultYear: string;
  defaultMonth: string;
  log: RunLog;
  tmpDir: string;
  browserChannel: string;
}): WorkflowContext {
  const { page, context, site, params, sinkFor, defaultSource, defaultYear, defaultMonth, log, tmpDir, browserChannel } = args;
  fs.mkdirSync(tmpDir, { recursive: true });

  function ensureName(name: string): string {
    const clean = sanitizeFilename(name);
    return /\.[A-Za-z0-9]{2,5}$/.test(clean) ? clean : `${clean}.pdf`;
  }

  async function ship(tempPath: string, name: string, o: SaveOptions): Promise<DownloadedFile> {
    const { invoiceId, source } = o;
    const src = source ?? defaultSource;
    // a per-file ym (YYYY-MM) routes the file to its own month folder; else the run's month
    const m = o.ym && /^(\d{4})-(\d{2})$/.exec(o.ym);
    const year = m ? m[1]! : defaultYear;
    const month = m ? m[2]! : defaultMonth;
    const bytes = fs.statSync(tempPath).size;
    const sink = sinkFor(src, year, month);
    if (!sink) {
      log.line('staged', { name, bytes, invoiceId, source: src, ym: `${year}-${month}`, dryRun: true });
      return { name, dest: '(dry-run)', bytes, skipped: false, ...(invoiceId ? { invoiceId } : {}) };
    }
    const res = await sink.put(tempPath, name);
    log.line(res.skipped ? 'skipped' : 'saved', { name, dest: res.dest, bytes: res.bytes, invoiceId, source: src, ym: `${year}-${month}` });
    return { name, dest: res.dest, bytes: res.bytes, skipped: res.skipped, ...(invoiceId ? { invoiceId } : {}) };
  }

  return {
    page,
    context,
    site,
    params,
    log: (msg, extra) => log.line('workflow', { msg, ...(extra ?? {}) }),

    async reach(target: ReachTarget): Promise<void> {
      const affordance = await findReachAffordance(page, target);
      if (affordance) {
        await humanPause();
        await affordance.click();
        await humanPause();
        return;
      }
      if (!target.url) throw new Error('reach: no visible navigation control matched target and no fallback url was provided');
      await humanPause();
      await page.goto(target.url, { waitUntil: 'domcontentloaded' });
    },

    async save(download: Download, name: string, opts?: string | SaveOptions): Promise<DownloadedFile> {
      const finalName = ensureName(name);
      const tempPath = path.join(tmpDir, finalName);
      await download.saveAs(tempPath);
      return ship(tempPath, finalName, normalizeSaveOpts(opts));
    },

    async saveUrl(url: string, name: string, opts?: string | SaveOptions): Promise<DownloadedFile> {
      const finalName = ensureName(name);
      // Fetch THROUGH THE LIVE PAGE (real browser network stack: cookies, Referer, Sec-Fetch-*,
      // genuine TLS/JA3), not context.request.get() -- confirmed (2026-07-28, Inspira HSA) that
      // some WAF-guarded portals 403 the Node-side APIRequestContext even with matching cookies
      // + a Referer header, while an in-page fetch() on the exact same URL succeeds. Chunked
      // base64 round-trip avoids a call-stack blowout on large PDFs (no String.fromCharCode(...spread)).
      const base64 = await page.evaluate(async (u: string) => {
        const resp = await fetch(u, { credentials: 'include' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < buf.length; i += chunkSize) {
          binary += String.fromCharCode(...buf.subarray(i, i + chunkSize));
        }
        return btoa(binary);
      }, url).catch((e: unknown) => {
        throw new Error(`saveUrl: in-page fetch ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
      });
      const tempPath = path.join(tmpDir, finalName);
      fs.writeFileSync(tempPath, Buffer.from(base64, 'base64'));
      return ship(tempPath, finalName, normalizeSaveOpts(opts));
    },

    async printPage(replay, name, opts) {
      const finalName = ensureName(name);
      const tempPath = path.join(tmpDir, finalName);
      // Playwright's page.pdf() only works in headless mode -- real/persistent (headed)
      // browsers reject it (Page.printToPDF is unavailable), and many statement portals
      // route "download this statement" through a native print dialog rather than a
      // download event, so there's often no other way to capture an archival PDF. Fix:
      // clone the live session's cookies into a throwaway HEADLESS context (page.pdf()
      // works there), have `replay` re-drive whatever navigation the target page needs
      // (some portals validate a server-side session/referrer flow, not just cookies --
      // a raw goto to the final URL can land on an error page), then print and discard
      // the clone. Never touches the live page/context.
      const storageState = await context.storageState();
      const clone = await chromium.launch({ channel: browserChannel, headless: true });
      try {
        const cloneContext = await clone.newContext({ storageState });
        const clonePage = await cloneContext.newPage();
        await replay(clonePage);
        await clonePage.pdf({ path: tempPath, printBackground: true });
      } finally {
        await clone.close();
      }
      return ship(tempPath, finalName, normalizeSaveOpts(opts));
    },
  };
}
