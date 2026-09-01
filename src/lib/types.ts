import type { Page, BrowserContext, Download } from 'playwright';

/** A site is one authenticated *identity* (not one domain). Lives at sites/<id>/site.json. */
export interface SiteConfig {
  /** dir name under sites/, e.g. "cloudflare-stg" — the selector + auth key */
  id: string;
  /** human label */
  name: string;
  /** where `bro auth` sends the human to log in */
  loginUrl: string;
  /** authenticated landing page; authGuard + workflows start here */
  homeUrl: string;
  /** accounting source-folder segment, e.g. "cloudflare". For a multi-account login this is the
   * DEFAULT source; individual downloads may override it per account (see `accounts` + save's source). */
  source: string;
  /**
   * Multi-account login: map masked-account last4 -> accounting source-folder segment. A workflow that
   * enumerates accounts under ONE login (e.g. all Chase cards on one dashboard) resolves each file's
   * source from this map (falling back to a per-account default like `chase-<last4>`), so each account
   * lands in its own raw/{year}/{month}/{source}/ folder from a single run. Empty/absent => single-source.
   * e.g. { "4786": "chase-stg", "3059": "chase-stg-checking" }
   */
  accounts?: Record<string, string>;
  /**
   * How to tell we're still logged in after loading auth.json + navigating to homeUrl.
   * - urlNot: fail if the final URL matches this (e.g. the login URL) — the default heuristic
   * - selector: pass only if this selector is present (a control shown only when authed)
   * At least one is recommended; if neither is set, authGuard falls back to "did we land on loginUrl".
   */
  authedWhen?: { urlNot?: string; selector?: string };
  /** some vendors block headless — force a headed browser for this site */
  headed?: boolean;
  /**
   * Browser strategy:
   * - 'launch' (default): a fresh Chromium context loaded from auth.json storageState -- fast.
   * - 'persistent': launch the REAL installed browser (Chrome/Edge) with a persistent per-site
   *   profile via launchPersistentContext. Inherits a genuine device fingerprint (real TLS/JA3,
   *   GPU, fonts) + the profile's own login cookies, so hardened fingerprinting sites (banks behind
   *   Akamai/DataDome) that flag a fresh automated context are more likely to render. No auth.json;
   *   the human logs into the persistent profile once via `bro auth`.
   */
  browser?: 'launch' | 'persistent';
  /**
   * Interactive run: this site's session cannot be stored for unattended reruns (e.g. banks -- the
   * auth session is a short-lived, in-memory cookie). When true, `bro run`/`test` open the browser,
   * wait for the human to log in (reach the dashboard), then run the workflow in the SAME live
   * session. Pair with browser: 'persistent' so the real device fingerprint + trusted-device
   * recognition carry across logins.
   */
  interactive?: boolean;
  /**
   * Public site: no stored credentials, no login required. The browser launches fresh with no
   * storageState -- no auth.json, no `bro auth` step. If `authedWhen` is set it is treated as a
   * readiness predicate (wait until the app finishes loading); a failure throws not-ready, never
   * auth-expired. Use for sites that render via JavaScript but require no identity (e.g. public
   * government portals).
   */
  public?: boolean;
}

/** One structured row a `read` workflow scraped from the authenticated DOM (JSON, not a file). */
export type Row = Record<string, unknown>;

/** One file a workflow produced (or would have — see `skipped`). Feeds the run manifest. */
export interface DownloadedFile {
  name: string;
  dest: string;
  invoiceId?: string;
  bytes: number;
  skipped: boolean;
}

/** Options for save()/saveUrl(). A bare string is backward-compat shorthand for { invoiceId }. */
export interface SaveOptions {
  /** tag echoed into the manifest entry (statement month, invoice number, ...) */
  invoiceId?: string;
  /** file this download under a DIFFERENT accounting source than site.source (multi-account logins) */
  source?: string;
  /** file under THIS YYYY-MM's folder instead of the run's --month (a backfill spanning many months
   * files each statement into its own raw/{year}/{month}/ from one run). Ignored if not YYYY-MM. */
  ym?: string;
}

export interface ReachTarget {
  text?: RegExp | string;
  role?: string;
  url?: string;
}

/** Injected into a workflow's run(). The page is ALREADY authenticated. */
export interface WorkflowContext {
  page: Page;
  context: BrowserContext;
  site: SiteConfig;
  params: Record<string, string>;
  /** Reach an in-app destination by preferring a real click over a bare goto when possible. */
  reach(target: ReachTarget): Promise<void>;
  /** Stage a Playwright download to the sink under a deterministic name. Returns the entry.
   * `opts` may be a bare invoiceId string, or { invoiceId, source } to file under a per-account source. */
  save(download: Download, name: string, opts?: string | SaveOptions): Promise<DownloadedFile>;
  /** Stage a PDF fetched by URL (for portals that render inline, no download event — G2). */
  saveUrl(url: string, name: string, opts?: string | SaveOptions): Promise<DownloadedFile>;
  /**
   * Print a page to PDF via a throwaway HEADLESS clone of the live session (cookies only,
   * navigation replayed by `replay`). Use when a portal's "download statement" control opens
   * a native print dialog instead of a real download (page.pdf() only works headless — the
   * live/persistent browser rejects it). `replay` drives the CLONE's page to the target
   * content -- repeat whatever goto/select/click steps the live workflow used, since some
   * portals need the server-side session/referrer flow re-established, not just cookies.
   */
  printPage(replay: (page: Page) => Promise<void>, name: string, opts?: string | SaveOptions): Promise<DownloadedFile>;
  /** structured progress line -> JSONL run log */
  log(msg: string, extra?: Record<string, unknown>): void;
}

export interface WorkflowParam {
  name: string;
  required?: boolean;
  default?: string;
}

export interface Workflow {
  kind: string;
  describe: string;
  params?: WorkflowParam[];
  /**
   * Output shape:
   * - 'download' (default): run() navigates -> Export -> save, returning DownloadedFile[].
   * - 'read': run() SCRAPES the authenticated DOM and returns Row[] (JSON) -- nothing shipped to
   *   the sink. Still strictly read-only (navigate + read controls ONLY; never a mutating click).
   *   For live data the OAuth/API path used to serve (quotes, watchlist, orders, balances).
   */
  mode?: 'download' | 'read';
  /** runner fails if fewer than this many files (download) or rows (read) are produced (G7 fail-loud). Default 1. */
  minExpected?: number;
  run(ctx: WorkflowContext): Promise<DownloadedFile[] | Row[]>;
}
