#!/usr/bin/env node
/**
 * bim-cli DRIVER entry point for bro (JSON-RPC 2.0 over stdin/stdout).
 *
 * The dispatcher (bim.exe) spawns this once per verb: it pipes ONE JSON-RPC request line to
 * stdin, we dispatch, write ONE JSON-RPC response line to stdout, and exit 0 (even on an error
 * response). stdout carries ONLY the frame; all human/log output goes to stderr. This is the
 * driver-facing wire; the CLI (src/cli.ts) is the human-facing wire and stays as-is.
 *
 * Browser/runner imports are LAZY (dynamic) so describe/doctor/version/list -- the conformance
 * surface -- work without Playwright loaded.
 */
import fs from 'node:fs';
import tty from 'node:tty';

import { BroError } from './lib/errors.ts';
import { authMetaPath, authPath, profileDir } from './lib/paths.ts';
import { listSites, listWorkflows, loadSite, loadWorkflow } from './lib/registry.ts';

const VERSION = '0.1.0';

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

function describeDoc(): Record<string, unknown> {
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
      { name: 'doctor', description: 'health check (node, playwright, sites)', args: [], output: 'json' },
      { name: 'version', description: 'driver name + version', args: [], output: 'json' },
      { name: 'list', description: 'sites x workflows x auth freshness', args: [], output: 'json' },
      { name: 'sessions', description: 'live CDP browser sessions', args: [], output: 'json' },
      {
        name: 'run',
        description: 'run a site workflow (download/read/write)',
        args: [
          { name: 'site', type: 'string', required: true, positional: true, help: 'site id' },
          { name: 'workflow', type: 'string', required: true, positional: true, help: 'workflow name' },
          { name: 'month', type: 'string', help: 'target month YYYY-MM (default: previous)' },
          { name: 'headed', type: 'bool', help: 'run headed (visible browser)' },
        ],
        output: 'json',
      },
      {
        name: 'test',
        description: 'dry-run a workflow (stages, ships nothing)',
        args: [
          { name: 'site', type: 'string', required: true, positional: true },
          { name: 'workflow', type: 'string', required: true, positional: true },
          { name: 'month', type: 'string' },
        ],
        output: 'json',
        supports_dry_run: true,
      },
      {
        name: 'run-all',
        description: 'run every workflow of a kind across sites',
        args: [
          { name: 'kind', type: 'string', required: true, help: 'workflow kind (invoices|statements|...)' },
          { name: 'month', type: 'string' },
        ],
        output: 'json',
      },
      {
        name: 'auth',
        description: 'capture site auth (INTERACTIVE -- use the bro CLI, not the driver)',
        interactive: true,
        human_steps: ['open a browser', 'log in + clear MFA'],
        args: [{ name: 'site', type: 'string', required: true, positional: true }],
        output: 'json',
      },
      {
        name: 'session',
        description: 'start/stop a live browser session (INTERACTIVE -- use the bro CLI)',
        interactive: true,
        args: [
          { name: 'op', type: 'string', required: true, positional: true, help: 'start|stop' },
          { name: 'site', type: 'string', required: true, positional: true },
        ],
        output: 'json',
      },
    ],
  };
}

async function doctor(): Promise<Record<string, unknown>> {
  const checks: Array<Record<string, unknown>> = [];
  const nodeOk = (() => {
    const major = Number(process.versions.node.split('.')[0]);
    return major >= 22;
  })();
  checks.push({ name: 'runtime:node', ok: nodeOk, detail: `node ${process.version}`,
    ...(nodeOk ? {} : { hint: 'bro needs Node >= 22', fix: 'install Node 22+' }) });

  // Playwright package (bundled with the driver's deps) vs the browser BINARY (a
  // CLI-managed dependency, like blender for bim-blender -- provisioned on demand).
  let pw: typeof import('playwright') | null = null;
  try { pw = await import('playwright'); } catch { /* absent */ }
  checks.push({ name: 'dep:playwright', ok: !!pw, detail: pw ? 'installed' : 'not found', optional: false,
    ...(pw ? {} : { hint: 'the playwright npm package is missing', fix: 'npm install' }) });

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
  checks.push({ name: 'browser:chromium', ok: browserOk, detail: browserDetail, optional: false,
    ...(browserOk ? {} : { hint: 'the Chromium browser binary is a managed dependency',
      fix: 'install it once with the fix_cmd', fix_cmd: 'npx playwright install chromium' }) });

  let nSites = 0;
  try { nSites = listSites().filter((s) => s !== '_example').length; } catch { /* none */ }
  checks.push({ name: 'config:sites', ok: nSites > 0, detail: `${nSites} site(s) configured`,
    ...(nSites > 0 ? {} : { hint: 'no sites yet', fix: 'bro auth <site> to add one' }) });

  const ok = checks.every((c) => c.ok);
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

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'describe':
      return describeDoc();
    case 'version':
      return { name: 'bro', version: VERSION };
    case 'doctor':
      return doctor();
    case 'list':
      return siteList();
    case 'sessions': {
      const { readSessions, probeCDP } = await import('./lib/sessions.ts');
      const all = readSessions();
      const rows: Array<Record<string, unknown>> = [];
      for (const [id, s] of Object.entries(all)) {
        rows.push({ site: id, port: s.port, pid: s.pid, startedAt: s.startedAt, alive: !!(await probeCDP(s.port)) });
      }
      return { sessions: rows };
    }
    case 'run':
    case 'test': {
      const site = String(params.site ?? '');
      const workflow = String(params.workflow ?? '');
      if (!site || !workflow) throw new BroError('bad-args', `${method} requires site + workflow`);
      const { runWorkflow } = await import('./lib/runner.ts');
      const now = new Date();
      const manifest = await runWorkflow({
        siteId: site,
        workflowName: workflow,
        cliParams: params as Record<string, string>,
        month: params.month ? String(params.month) : undefined,
        headed: params.headed === true || params.headed === 'true',
        dryRun: method === 'test',
        stampIso: now.toISOString().replace(/[:.]/g, '-'),
        now,
        mirror: false,
      });
      return manifest;
    }
    case 'run-all': {
      const kind = String(params.kind ?? '');
      if (!kind) throw new BroError('bad-args', 'run-all requires kind');
      const { runWorkflow } = await import('./lib/runner.ts');
      const now = new Date();
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
              headed: false, dryRun: false, stampIso: now.toISOString().replace(/[:.]/g, '-'), now, mirror: false,
            });
            summary.push({ site: siteId, workflow: wfName, status: 'ok', count: m.count });
          } catch (err) {
            const e = err instanceof BroError ? err.toEnvelope() : { kind: 'internal', message: String(err) };
            summary.push({ site: siteId, workflow: wfName, status: 'skipped', error: e });
          }
        }
      }
      return { summary };
    }
    case 'auth':
    case 'session':
    case 'record':
      throw new BroError('bad-args', `\`${method}\` is interactive -- run it via the bro CLI, not the driver`, {
        needsHuman: true,
        hint: `bro ${method} ...`,
      });
    default:
      throw Object.assign(new Error(`unknown method: ${method}`), { rpcKind: 'unknown-method', rpcHint: 'see `describe`' });
  }
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
    if (env.needsHuman) data.remediation = { verb: `bro ${req.method}`, interactive: true };
    writeFrame({ jsonrpc: '2.0', error: { code: codeFor(kind), message: env.message, data }, id });
    process.exit(0); // exit 0 after writing any valid response frame
  }
}

main().catch((err) => {
  writeFrame({ jsonrpc: '2.0', error: { code: -32603, message: String(err), data: { kind: 'runtime' } }, id: 0 });
  process.exit(1);
});
