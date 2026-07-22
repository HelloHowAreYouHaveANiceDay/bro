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
  /** accounting source-folder segment, e.g. "cloudflare" */
  source: string;
  /**
   * How to tell we're still logged in after loading auth.json + navigating to homeUrl.
   * - urlNot: fail if the final URL matches this (e.g. the login URL) — the default heuristic
   * - selector: pass only if this selector is present (a control shown only when authed)
   * At least one is recommended; if neither is set, authGuard falls back to "did we land on loginUrl".
   */
  authedWhen?: { urlNot?: string; selector?: string };
  /** some vendors block headless — force a headed browser for this site */
  headed?: boolean;
}

/** One file a workflow produced (or would have — see `skipped`). Feeds the run manifest. */
export interface DownloadedFile {
  name: string;
  dest: string;
  invoiceId?: string;
  bytes: number;
  skipped: boolean;
}

/** Injected into a workflow's run(). The page is ALREADY authenticated. */
export interface WorkflowContext {
  page: Page;
  context: BrowserContext;
  site: SiteConfig;
  params: Record<string, string>;
  /** Stage a Playwright download to the sink under a deterministic name. Returns the entry. */
  save(download: Download, name: string, invoiceId?: string): Promise<DownloadedFile>;
  /** Stage a PDF fetched by URL (for portals that render inline, no download event — G2). */
  saveUrl(url: string, name: string, invoiceId?: string): Promise<DownloadedFile>;
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
  /** runner fails if fewer than this many files are produced (G7 fail-loud). Default 1. */
  minExpected?: number;
  run(ctx: WorkflowContext): Promise<DownloadedFile[]>;
}
