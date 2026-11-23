#!/usr/bin/env node
/**
 * bim-cli DRIVER entry point for bro (JSON-RPC 2.0 over stdin/stdout).
 *
 * The dispatcher (bim.exe) spawns this once per verb: it pipes ONE JSON-RPC request line to
 * stdin, we dispatch, write ONE JSON-RPC response line to stdout, and exit 0 (even on an error
 * response). stdout carries ONLY the frame; all human/log output goes to stderr. This is the
 * driver-facing wire; the CLI (src/cli.ts) is the human-facing wire and stays as-is.
 *
 * Browser/runner imports are LAZY (dynamic) so describe/doctor/version/site list -- the conformance
 * surface -- work without Playwright loaded.
 */
import fs from 'node:fs';
import path from 'node:path';
import tty from 'node:tty';
import { fileURLToPath } from 'node:url';

import { BroError } from './lib/errors.ts';
import { LEGACY_VERBS, canonicalMethod, pageOptsFromParams, resolveDateStamp } from './lib/verbs.ts';
import { authMetaPath, authPath, playwrightBrowsersDir, profileDir, runtimeDir, sitesDir } from './lib/paths.ts';
import { listSites, listWorkflows, loadSite, loadWorkflow } from './lib/registry.ts';

const VERSION = '0.4.5';

// bro/bim error kind -> JSON-RPC numeric code (pkg/rpc/errors.go table).
const KIND_CODE: Record<string, number> = {
  'bad-args': -32602, usage: -32602, 'invalid-input': -32602, 'unknown-flag': -32602,
  'unknown-method': -32601, 'unknown-verb': -32601,
  'no-such-site': -32001, 'no-such-workflow': -32001, 'not-found': -32001,
  permission: -32002, password: -32002,
  connection: -32003, 'sink-unavailable': -32003,
  timeout: -32004,
  runtime: -32603, internal: -32603, 'no-downloads': -32603, 'bot-blocked': -32603,
  auth_required: -32010, 'auth-expired': -32010,
  scope_required: -32011,
};
const codeFor = (kind: string): number => KIND_CODE[kind] ?? -32099;

// bro kinds -> the bim-cli kind the dispatcher expects (auth intercept keys on `auth_required`).
const NORMALIZE_KIND: Record<string, string> = { 'auth-expired': 'auth_required' };

/** Alias rows for the pre-0.3.0 verb names (bim-cli pins verb names forever: a rename needs a describe alias). */
function legacyAliasRows(verbs: Array<Record<string, any>>): Array<Record<string, unknown>> {
  const target: Record<string, string> = {
    list: 'site list', sessions: 'session list', open: 'page open', page: 'page exec',
    run: 'workflow run', test: 'workflow run', 'run-all': 'workflow run-all', auth: 'auth login',
    session: 'session launch',
  };
  // An alias named like the FIRST WORD of a canonical verb (auth, session, page) must declare no
  // positional args: bim-cli's dispatcher only treats `<verb> <word>` as the two-word verb when the
  // one-word verb has no positional slot to take <word>. With positionals, `bim bro auth login x`
  // ran the `auth` alias with site="login", and `session launch|list`, `page open|exec` broke the
  // same way (smoke test 2026-11-23). These aliases keep their names (pinned forever) and flags only.
  const groups = new Set(verbs.map((v) => String(v.name)).filter((n) => n.includes(' ')).map((n) => n.split(' ')[0]));
  return Object.keys(LEGACY_VERBS).map((old) => {
    const base = verbs.find((v) => v.name === target[old])!;
    const shadows = groups.has(old);
    const extra = old === 'session' && !shadows ? [{ name: 'op', type: 'string', required: true, positional: true, help: 'start|stop (legacy; now session launch|quit)' }] : [];
    const baseArgs = (base.args ?? []) as Array<Record<string, unknown>>;
    return {
      ...base,
      name: old,
      description: `DEPRECATED alias of \`${LEGACY_VERBS[old]}\``,
      is_alias: true,
      dispatches_to: target[old],
      args: shadows ? baseArgs.filter((a) => !a.positional) : [...extra, ...baseArgs],
    };
  });
}

export function describeDoc(): Record<string, unknown> {
  const doc = describeDocBase();
  return { ...doc, verbs: [...(doc.verbs as any[]), ...legacyAliasRows(doc.verbs as any[])] };
}

function describeDocBase(): Record<string, unknown> {
  return {
    name: 'bro',
    version: VERSION,
    kind: 'static',
    magic: [],
    extensions: [],
    requires: ['network:*'],
    env_optional: ['BRO_SINK', 'BRO_LOCAL_ROOT', 'ASSIST_RAW_DRIVE_FOLDER', 'BRO_SITES_DIR', 'BRO_HOME'],
    protocol_version: '2.0',
    verbs: [
      { name: 'doctor', description: 'health check (node, playwright, sites)', args: [], output: 'json', effect: 'read' },
      { name: 'version', description: 'driver name + version', args: [], output: 'json', effect: 'read' },
      { name: 'site list', description: 'sites x workflows x auth freshness', args: [], output: 'json', effect: 'read' },
      { name: 'session list', description: 'live CDP browser sessions (alive = host pid running AND port answers)', args: [], output: 'json', effect: 'read' },
      {
        name: 'session launch',
        description: 'start a live (headed) browser session as its own process; returns once LIVE. Not logged in? the human logs in in that window, the session stays live',
        human_steps: ['log in + clear MFA in the opened window (only if the site is not already authed)'],
        args: [
          { name: 'site', type: 'string', required: true, positional: true },
          { name: 'detach', type: 'bool', help: 'accepted for compatibility; the driver always detaches (it has no terminal to stay attached to)' },
        ],
        output: 'json',
        effect: 'mutate',
        notes: 'no dry-run: launching starts a browser process; the reply port and pid exist only after it runs',
      },
      {
        name: 'session quit',
        description: 'stop a live browser session (interactive -- use the bro CLI)',
        interactive: true,
        args: [{ name: 'site', type: 'string', required: true, positional: true }],
        output: 'json',
        effect: 'mutate',
        notes: 'no dry-run: the driver refuses this verb; stop a session with the bro CLI (bro session quit <site>)',
      },
      {
        name: 'page open',
        description: 'open a URL in a tab of a LIVE session (default: built-in scratch browser, started detached on demand)',
        args: [
          { name: 'url', type: 'string', required: true, positional: true },
          { name: 'site', type: 'string', help: 'site id (default scratch)' },
        ],
        output: 'json',
        effect: 'mutate',
        notes: 'no dry-run: opening the tab (and starting the scratch browser on demand) is the action; the reply tab id exists only after it runs',
      },
      {
        name: 'page exec',
        description: 'drive a LIVE session tab by site id: tabs|text|eval|goto|click|type|key|shot|capture|upload|close',
        args: [
          { name: 'site', type: 'string', required: true, positional: true },
          { name: 'action', type: 'string', required: true, positional: true, help: 'tabs|text|eval|goto|click|type|key|shot|capture|upload|close' },
          { name: 'arg', type: 'string', positional: true, help: 'js / url / css selector / text / key / out.png / url-substr / upload: input css (or first file with --click)' },
          { name: 'tab', type: 'string', help: 'tab id, id prefix, or URL substring' },
          { name: 'wait', type: 'int', help: 'ms to wait (goto/click/capture)' },
          { name: 'max', type: 'int', help: 'text: max chars (default 20000)' },
          { name: 'reload', type: 'bool', help: 'capture: reload the page to trigger requests' },
          { name: 'full', type: 'bool', help: 'shot: full page' },
          { name: 'out', type: 'path', help: 'capture: write responses to this file' },
          { name: 'files', type: 'string', help: 'upload: file path(s), comma-separated (with arg = input css)' },
          { name: 'click', type: 'string', help: 'upload: css of the button that opens the file chooser' },
          { name: 'yolo', type: 'bool', help: 'click/type/key/goto: fast input, no human-input layer (no human pointer/keyboard timing; goto = bare navigate)' },
          { name: 'typos', type: 'bool', help: 'type: occasional typo+Backspace (not for passwords)' },
          { name: 'raw', type: 'bool', help: 'DEPRECATED alias of --yolo (prints a warning)' },
        ],
        output: 'json',
        effect: 'mutate',
        notes: 'no dry-run: the reply is the live page data (text, eval value, screenshot) and click/type/goto cannot be previewed',
      },
      {
        name: 'workflow run',
        description: 'run a site workflow (download/read/write)',
        args: [
          { name: 'site', type: 'string', required: true, positional: true, help: 'site id' },
          { name: 'workflow', type: 'string', required: true, positional: true, help: 'workflow name' },
          { name: 'month', type: 'string', help: 'target month YYYY-MM (default: previous)' },
          { name: 'date-stamp', type: 'string', help: 'stamp saved filenames with YYYY-MM-DD to avoid snapshot collisions' },
          { name: 'headed', type: 'bool', help: 'run headed (visible browser)' },
          { name: 'dry-run', type: 'bool', help: 'stage the workflow and ship nothing (was `test`)' },
        ],
        // Any other --key value is the workflow's own param (e.g. `--url` for espn api).
        extra_args: true,
        output: 'json',
        supports_dry_run: true,
        effect: 'mutate',
      },
      {
        name: 'workflow run-all',
        description: 'run every workflow of a kind across sites',
        args: [
          { name: 'kind', type: 'string', required: true, help: 'workflow kind (invoices|statements|...)' },
          { name: 'month', type: 'string' },
          { name: 'dry-run', type: 'bool' },
        ],
        output: 'json',
        effect: 'mutate',
        supports_dry_run: true,
      },
      {
        name: 'auth login',
        description: 'open a headed login window for the human and return once it is up (status waiting-for-human); auth is saved when they finish -- poll `site list` (auth.capturedAt)',
        interactive: true,
        human_steps: ['log in + clear MFA in the opened window (or close it once the dashboard shows)'],
        args: [{ name: 'site', type: 'string', required: true, positional: true }],
        output: 'json',
        effect: 'mutate',
        notes: 'no dry-run: opening the window is the action. Returns {site, pid, status: waiting-for-human|already-waiting, log, next}; the window auto-closes after login (15 min cap)',
      },
    ],
  };
}

/** Workflow params are strings (as on the bro CLI); bim forwards a bare --flag as true. */
export function workflowParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

export async function doctor(): Promise<Record<string, unknown>> {
  const checks: Array<Record<string, unknown>> = [];
  const nodeOk = (() => {
    const major = Number(process.versions.node.split('.')[0]);
    return major >= 22;
  })();
  checks.push({ name: 'runtime:node', ok: nodeOk, detail: `node ${process.version}`,
    ...(nodeOk ? {} : { hint: 'bro needs Node >= 22', fix: 'install Node 22+' }) });

  // Standalone SEA: the playwright PACKAGE and its browser BINARY are BOTH managed dependencies,
  // provisioned once into the runtime dir (resolved via NODE_PATH in sea-entry.ts) -- like Blender
  // for bim-blender. The exe itself bundles only bro's own code.
  const rt = runtimeDir();
  const provisionCmd = `npm i --prefix "${rt}" playwright`;
  // Runtime never set up = fresh install: setup guidance, not a fault. Once the dir exists, stay required.
  const freshRuntime = !fs.existsSync(rt);
  let pw: typeof import('playwright') | null = null;
  try { pw = (await import('./lib/playwright.ts')).loadPlaywright(); } catch { /* absent */ }
  checks.push({ name: 'dep:playwright', ok: !!pw, detail: pw ? 'installed' : `not found (runtime: ${rt})`, optional: freshRuntime,
    ...(pw ? {} : { hint: 'the playwright package is a managed dependency (installed into the bro runtime dir)',
      fix: 'install it once with the fix_cmd', fix_cmd: provisionCmd }) });

  // Chromium never provisioned (no ms-playwright dir) = setup guidance, whatever resolved `pw`.
  // Once a browsers dir exists, a missing/broken exe is a real fault and stays required.
  const browsersProvisioned = fs.existsSync(playwrightBrowsersDir());
  let browserOk = false;
  let browserDetail = 'not checked (playwright missing)';
  if (pw) {
    try {
      const exe = pw.chromium.executablePath();
      browserOk = fs.existsSync(exe);
      browserDetail = browserOk ? exe : `not installed (${exe})`;
    } catch (e) {
      browserDetail = e instanceof Error ? e.message.slice(0, 80) : 'unavailable';
    }
  }
  checks.push({ name: 'browser:chromium', ok: browserOk, detail: browserDetail, optional: freshRuntime || !browsersProvisioned,
    ...(browserOk ? {} : { hint: 'the Chromium browser binary is a managed dependency',
      fix: 'install it once with the fix_cmd',
      fix_cmd: `${provisionCmd} && "${path.join(rt, 'node_modules', '.bin', 'playwright')}" install chromium` }) });

  // Distinguish three cases: (a) sites dir absent = not-yet-configured (optional/advisory),
  // (b) sites dir present but unreadable = genuine fault (hard failure), (c) healthy.
  let nSites = 0;
  let sitesOk = false;
  let sitesOptional = false;
  let sitesBroken = false;
  const sitesRoot = sitesDir();
  if (!fs.existsSync(sitesRoot)) {
    sitesOptional = true; // not yet configured -- setup guidance, not a fault
  } else {
    try {
      nSites = listSites().filter((s) => s !== '_example').length;
      sitesOk = nSites > 0;
      if (!sitesOk) sitesOptional = true; // dir present but empty: still a setup note
    } catch {
      sitesBroken = true; // dir exists but can't be read: genuine fault
    }
  }
  checks.push({
    name: 'config:sites',
    ok: sitesOk,
    optional: sitesOptional,
    detail: sitesBroken ? 'sites directory exists but cannot be read' : `${nSites} site(s) configured`,
    ...(sitesOk ? {} : {
      hint: sitesBroken ? 'check permissions on the sites directory' : 'no sites yet',
      fix: 'bro auth login <site> to add one',
    }),
  });

  // optional checks are advisory only; they do not affect the overall driver health.
  const ok = checks.filter((c) => !c.optional).every((c) => c.ok);
  return { ok, detail: ok ? 'bro driver ready' : 'one or more checks failed', checks };
}

function siteList(): Record<string, unknown> {
  const sites = listSites().map((id: string) => {
    let mode: string | undefined;
    try { mode = loadSite(id).browser; } catch { /* unreadable */ }
    const present = mode === 'persistent' ? fs.existsSync(profileDir(id)) : fs.existsSync(authPath(id));
    let auth: Record<string, unknown> = { present, ...(mode ? { mode } : {}) };
    try { auth = { ...auth, ...JSON.parse(fs.readFileSync(authMetaPath(id), 'utf8')) }; } catch { /* no meta */ }
    return { site: id, workflows: listWorkflows(id), auth };
  });
  return { sites };
}

export async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  ({ method, params } = canonicalMethod(method, params));
  switch (method) {
    case 'describe':
      return describeDoc();
    case 'version':
      return { name: 'bro', version: VERSION };
    case 'doctor':
      return doctor();
    case 'site.list':
      return siteList();
    case 'session.list': {
      const { readSessions, probeCDP } = await import('./lib/sessions.ts');
      const { pidAlive } = await import('./lib/page.ts');
      const all = readSessions();
      const rows: Array<Record<string, unknown>> = [];
      for (const [id, s] of Object.entries(all)) {
        const hostAlive = pidAlive(s.pid);
        rows.push({ site: id, port: s.port, pid: s.pid, startedAt: s.startedAt, alive: hostAlive && !!(await probeCDP(s.port)), hostAlive });
      }
      return { sessions: rows };
    }
    case 'page.open': {
      const { openUrl } = await import('./lib/pageActions.ts');
      return openUrl(String(params.url ?? ''), params.site ? String(params.site) : 'scratch');
    }
    case 'page.exec': {
      const { pageAction } = await import('./lib/pageActions.ts');
      return pageAction(String(params.site ?? ''), String(params.action ?? ''), params.arg === undefined ? undefined : String(params.arg), pageOptsFromParams(params));
    }
    case 'workflow.run': {
      const site = String(params.site ?? '');
      const workflow = String(params.workflow ?? '');
      if (!site || !workflow) throw new BroError('bad-args', `${method.replaceAll('.', ' ')} requires site + workflow`);
      const { runWorkflow } = await import('./lib/runner.ts');
      const now = new Date();
      const cliParams = workflowParams(params);
      delete cliParams['dry-run'];
      delete cliParams.dry_run;
      delete cliParams.dryRun;
      const manifest = await runWorkflow({
        siteId: site,
        workflowName: workflow,
        cliParams,
        month: params.month ? String(params.month) : undefined,
        dateStamp: resolveDateStamp(params, now),
        headed: params.headed === true || params.headed === 'true',
        dryRun: [params['dry-run'], params.dry_run, params.dryRun].some((v) => v === true || v === 'true'),
        stampIso: now.toISOString().replace(/[:.]/g, '-'),
        now,
        mirror: false,
      });
      return params['dry-run'] === true || params['dry-run'] === 'true' || params.dry_run === true || params.dry_run === 'true' || params.dryRun === true || params.dryRun === 'true'
        ? { ...manifest, dry_run: true }
        : manifest;
    }
    case 'workflow.run-all': {
      const kind = String(params.kind ?? '');
      if (!kind) throw new BroError('bad-args', 'workflow run-all requires kind');
      const { runWorkflow } = await import('./lib/runner.ts');
      const now = new Date();
      const dryRunFlag = params['dry-run'] ?? params.dry_run ?? params.dryRun;
      const dryRun = dryRunFlag === true || dryRunFlag === 'true';
      const summary: Array<Record<string, unknown>> = [];
      for (const siteId of listSites()) {
        if (siteId === '_example') continue;
        for (const wfName of listWorkflows(siteId)) {
          let wfKind: string;
          try { wfKind = (await loadWorkflow(siteId, wfName)).kind; } catch { continue; }
          if (wfKind !== kind) continue;
          try {
            const m = await runWorkflow({
              siteId, workflowName: wfName, cliParams: {},
              month: params.month ? String(params.month) : undefined,
              headed: false, dryRun, stampIso: now.toISOString().replace(/[:.]/g, '-'), now, mirror: false,
            });
            summary.push({ site: siteId, workflow: wfName, status: 'ok', count: m.count });
          } catch (err) {
            const e = err instanceof BroError ? err.toEnvelope() : { kind: 'internal', message: String(err) };
            summary.push({ site: siteId, workflow: wfName, status: 'skipped', error: e });
          }
        }
      }
      return dryRun ? { summary, dry_run: true } : { summary };
    }
    case 'session.launch': {
      // Always detached: the driver is a one-shot process with no terminal, so an attached host would
      // die with it. Refusing without --detach left agents with no way to open a session (feedback 2026-11-23).
      const site = String(params.site ?? '');
      if (!site) throw new BroError('bad-args', 'session launch requires site');
      loadSite(site);
      const { startDetached } = await import('./lib/detach.ts');
      return startDetached(site);
    }
    case 'session.quit':
      throw new BroError('bad-args', 'session quit: use the bro CLI (`bro session quit <site>`)', { hint: 'bro session quit <site>' });
    case 'auth.login': {
      const site = String(params.site ?? '');
      if (!site) throw new BroError('bad-args', 'auth login requires site');
      loadSite(site);
      const { startDetachedLogin } = await import('./lib/detach.ts');
      return startDetachedLogin(site);
    }
    case 'record':
      throw new BroError('bad-args', `\`${method}\` is interactive -- run it via the bro CLI, not the driver`, {
        needsHuman: true,
        hint: `bro ${method.replaceAll('.', ' ')} ...`,
      });
    default:
      throw Object.assign(new Error(`unknown method: ${method}`), { rpcKind: 'unknown-method', rpcHint: 'see `describe`' });
  }
}

/**
 * Recovery pointer for agents. auth_required -> `bim bro auth login <site>` (which the driver now
 * serves); before, the remediation repeated the FAILED verb as `bro <verb>`, a CLI bim installs don't ship.
 */
export function remediationFor(
  kind: string, method: string, params: Record<string, unknown>, env: { needsHuman?: boolean; detail?: unknown },
): { remediation?: { verb: string; interactive: boolean }; hint?: string } {
  if (kind === 'auth_required') {
    const detailSite = (env.detail as { site?: unknown } | undefined)?.site;
    const site = String(detailSite ?? params.site ?? '<site>');
    return {
      remediation: { verb: `bim bro auth login ${site}`, interactive: true },
      hint: `run \`bim bro auth login ${site}\` to open a login window for the human, then retry once \`bim bro site list\` shows fresh auth`,
    };
  }
  if (env.needsHuman) return { remediation: { verb: `bim bro ${method.replaceAll('.', ' ')}`, interactive: true } };
  return {};
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function writeFrame(frame: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(frame) + '\n');
}

async function main(): Promise<void> {
  // A detached child (session host / login window) spawned from checkout mode re-enters here.
  const { runDetachedChild } = await import('./lib/detach.ts');
  const child = runDetachedChild(process.argv, process.env);
  if (child) return child;
  // TTY guard: never block on stdin when run bare in a terminal (DIM-621).
  if (tty.isatty(0)) {
    process.stderr.write(
      'bim-bro driver: reads one JSON-RPC 2.0 request on stdin.\n' +
        '  echo {"jsonrpc":"2.0","method":"describe","id":1} | bim-bro\n' +
        '  (for humans, use the bro CLI: `bro <verb> ...`)\n',
    );
    process.exit(1);
  }

  const raw = await readStdin();
  const line = raw.replace(/^﻿/, '').split('\n')[0] ?? '';
  let req: { jsonrpc?: string; method?: string; params?: Record<string, unknown>; id?: unknown };
  try {
    req = JSON.parse(line);
  } catch {
    writeFrame({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error', data: { kind: 'invalid-input' } }, id: 0 });
    process.exit(1);
  }
  const id = req.id ?? 1;
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    writeFrame({ jsonrpc: '2.0', error: { code: -32600, message: 'invalid request', data: { kind: 'invalid-input' } }, id });
    process.exit(1);
  }

  try {
    const result = await dispatch(req.method, req.params ?? {});
    writeFrame({ jsonrpc: '2.0', result, id });
    process.exit(0);
  } catch (err) {
    const rpcKind = (err as { rpcKind?: string }).rpcKind;
    const env = err instanceof BroError
      ? err.toEnvelope()
      : { kind: rpcKind ?? 'runtime', message: err instanceof Error ? err.message : String(err), hint: (err as { rpcHint?: string }).rpcHint };
    const kind = NORMALIZE_KIND[String(env.kind)] ?? String(env.kind);
    const data: Record<string, unknown> = { kind, retriable: env.retriable ?? false };
    if (env.hint) data.hint = env.hint;
    Object.assign(data, remediationFor(kind, req.method, req.params ?? {}, env));
    writeFrame({ jsonrpc: '2.0', error: { code: codeFor(kind), message: env.message, data }, id });
    process.exit(0); // exit 0 after writing any valid response frame
  }
}

// Run main() only when this module is the direct entry point, not when imported by tests or other
// modules. In the SEA (CJS bundle): import.meta.url is undefined at runtime so fileURLToPath throws
// -> caught -> returns true. In tsx/vitest (ESM): match argv[1] against this file's path.
function isDirectEntry(): boolean {
  try {
    const thisPath = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1] ?? '';
    return argv1 === thisPath || argv1.replace(/\.(m?js)$/, '') === thisPath.replace(/\.ts$/, '');
  } catch {
    return true; // CJS/SEA: import.meta.url unavailable -> this IS the entry
  }
}

if (isDirectEntry()) {
  main().catch((err) => {
    writeFrame({ jsonrpc: '2.0', error: { code: -32603, message: String(err), data: { kind: 'runtime' } }, id: 0 });
    process.exit(1);
  });
}
