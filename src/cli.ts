#!/usr/bin/env -S npx tsx
import fs from 'node:fs';
import { BroError } from './lib/errors.ts';
import { loadConfig } from './lib/config.ts';
import { listSites, listWorkflows, loadSite, loadWorkflow } from './lib/registry.ts';
import { authMetaPath, authPath, profileDir } from './lib/paths.ts';
import { recordFlow } from './lib/codegen.ts';
import { authCapture } from './lib/auth.ts';
import { scaffoldWorkflow } from './lib/scaffold.ts';
import { runWorkflow } from './lib/runner.ts';
import { startPersistentSession } from './lib/session.ts';
import { awaitInteractiveLogin } from './lib/authGuard.ts';
import { readSessions, setSession, removeSession, getSession, probeCDP } from './lib/sessions.ts';
import { chromium } from 'playwright';

interface Args {
  _: string[];
  json: boolean;
  headed: boolean;
  month?: string;
  kind?: string;
  params: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], json: false, headed: false, params: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    const inlineVal = eq === -1 ? undefined : body.slice(eq + 1);
    if (key === 'json') out.json = true;
    else if (key === 'headed') out.headed = true;
    else if (key === 'month') out.month = inlineVal ?? argv[++i];
    else if (key === 'kind') out.kind = inlineVal ?? argv[++i];
    else out.params[key] = inlineVal ?? argv[++i] ?? '';
  }
  return out;
}

function emit(args: Args, ok: boolean, payload: Record<string, unknown>): void {
  if (args.json) {
    process.stdout.write(JSON.stringify(ok ? { ok, result: payload } : { ok, error: payload }, null, 2) + '\n');
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const [verb, a, b] = args._;
  const stampIso = new Date().toISOString().replace(/[:.]/g, '-');
  const now = new Date();
  const cfg = loadConfig();

  switch (verb) {
    case 'auth': {
      if (!a) throw new BroError('bad-args', 'usage: bro auth <site>');
      const site = loadSite(a);
      await authCapture(site, cfg.browserChannel, new Date().toISOString());
      const res = { site: site.id, authFile: authPath(site.id) };
      if (!args.json) process.stderr.write(`Saved auth for ${site.id}.\n`);
      emit(args, true, res);
      return 0;
    }

    case 'record': {
      if (!a || !b) throw new BroError('bad-args', 'usage: bro record <site> <workflow>');
      const site = loadSite(a);
      const file = recordFlow(site, b, cfg.browserChannel);
      if (!args.json) process.stderr.write(`Recorded transcript: ${file}\n`);
      emit(args, true, { site: site.id, workflow: b, recordedFile: file });
      return 0;
    }

    case 'new': {
      if (!a || !b) throw new BroError('bad-args', 'usage: bro new <site> <workflow> --kind <kind>');
      if (!args.kind) throw new BroError('bad-args', 'bro new requires --kind <kind>');
      loadSite(a); // validate site exists
      const file = scaffoldWorkflow(a, b, args.kind);
      if (!args.json) process.stderr.write(`Scaffolded ${file}\n`);
      emit(args, true, { site: a, workflow: b, kind: args.kind, file });
      return 0;
    }

    case 'test':
    case 'run': {
      if (!a || !b) throw new BroError('bad-args', `usage: bro ${verb} <site> <workflow> [--month YYYY-MM]`);
      const manifest = await runWorkflow({
        siteId: a,
        workflowName: b,
        cliParams: args.params,
        month: args.month,
        headed: args.headed,
        dryRun: verb === 'test',
        stampIso,
        now,
        mirror: !args.json,
      });
      if (!args.json) {
        process.stderr.write(`\n${verb} ${a}/${b} (${manifest.month}) -> ${manifest.location}\n`);
        for (const f of manifest.files) {
          process.stderr.write(`  ${f.skipped ? 'skip' : 'save'}  ${f.name} (${f.bytes} bytes)\n`);
        }
        process.stderr.write(`  ${manifest.count} file(s)\n`);
      }
      emit(args, true, manifest as unknown as Record<string, unknown>);
      return 0;
    }

    case 'run-all': {
      if (!args.kind) throw new BroError('bad-args', 'usage: bro run-all --kind <kind> [--month YYYY-MM]');
      const summary: Array<Record<string, unknown>> = [];
      let anyFailed = false;
      for (const siteId of listSites()) {
        if (siteId === '_example') continue;
        for (const wfName of listWorkflows(siteId)) {
          let wfKind: string;
          try {
            wfKind = (await loadWorkflow(siteId, wfName)).kind;
          } catch {
            continue;
          }
          if (wfKind !== args.kind) continue;
          try {
            const m = await runWorkflow({
              siteId,
              workflowName: wfName,
              cliParams: {},
              month: args.month,
              headed: args.headed,
              dryRun: false,
              stampIso,
              now,
              mirror: !args.json,
            });
            summary.push({ site: siteId, workflow: wfName, status: 'ok', count: m.count });
            if (!args.json) process.stderr.write(`-> ${siteId}/${wfName}  OK (${m.count} files)\n`);
          } catch (err) {
            anyFailed = true;
            const e = err instanceof BroError ? err.toEnvelope() : { kind: 'internal', message: String(err) };
            const label = e['kind'] === 'auth-expired' ? 'AUTH EXPIRED (skipped)' : `ERROR (${e['kind']})`;
            summary.push({ site: siteId, workflow: wfName, status: 'skipped', error: e });
            if (!args.json) process.stderr.write(`-> ${siteId}/${wfName}  ${label}\n`);
          }
        }
      }
      emit(args, !anyFailed, anyFailed ? { kind: 'partial', message: 'one or more sites skipped/failed', summary } : { summary });
      return anyFailed ? 1 : 0;
    }

    case 'list': {
      const sites = listSites().map((id) => {
        let mode: string | undefined;
        try {
          mode = loadSite(id).browser;
        } catch {
          /* site config unreadable */
        }
        const present = mode === 'persistent' ? fs.existsSync(profileDir(id)) : fs.existsSync(authPath(id));
        let auth: Record<string, unknown> = { present, ...(mode ? { mode } : {}) };
        try {
          auth = { ...auth, ...JSON.parse(fs.readFileSync(authMetaPath(id), 'utf8')) };
        } catch {
          /* no meta yet */
        }
        return { site: id, workflows: listWorkflows(id), auth };
      });
      if (!args.json) {
        for (const s of sites) {
          const a2 = s.auth as { present?: boolean; capturedAt?: string; refreshedAt?: string };
          const fresh = a2.present ? a2.refreshedAt || a2.capturedAt || 'unknown' : 'NO AUTH';
          process.stderr.write(`${s.site}  [auth: ${fresh}]  workflows: ${s.workflows.join(', ') || '(none)'}\n`);
        }
      }
      emit(args, true, { sites });
      return 0;
    }

    case 'describe': {
      const doc = capabilityDoc();
      emit(args, true, doc);
      if (!args.json) process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
      return 0;
    }

    case 'session': {
      const sub = a;
      const siteId = b;
      if (sub === 'start') {
        if (!siteId) throw new BroError('bad-args', 'usage: bro session start <site>');
        const site = loadSite(siteId);
        const { context, port } = await startPersistentSession(site, { channel: cfg.browserChannel });
        const page = context.pages()[0] ?? (await context.newPage());
        await awaitInteractiveLogin(page, site, () => {});
        setSession({ site: siteId, port, pid: process.pid, startedAt: new Date().toISOString() });
        if (!args.json)
          process.stderr.write(
            `\n[bro] session for ${siteId} is LIVE on CDP port ${port}.\n` +
              `      Run workflows with \`bro run ${siteId} <workflow>\` (they attach, they don't close).\n` +
              `      Leave this process running; end it with \`bro session stop ${siteId}\` or Ctrl-C.\n`,
          );
        emit(args, true, { site: siteId, port, status: 'live' });
        const shutdown = async () => {
          removeSession(siteId);
          await context.close().catch(() => {});
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        context.on('close', () => {
          removeSession(siteId);
          process.exit(0);
        });
        await new Promise<void>(() => {}); // keep the process alive holding the browser open
        return 0;
      }
      if (sub === 'stop') {
        if (!siteId) throw new BroError('bad-args', 'usage: bro session stop <site>');
        const live = getSession(siteId);
        if (!live) {
          if (!args.json) process.stderr.write(`no live session for ${siteId}\n`);
          emit(args, true, { site: siteId, status: 'not-running' });
          return 0;
        }
        if (await probeCDP(live.port)) {
          try {
            const b = await chromium.connectOverCDP(`http://127.0.0.1:${live.port}`);
            await b.close();
          } catch {
            /* fall through to pid kill */
          }
        }
        try {
          process.kill(live.pid);
        } catch {
          /* already gone */
        }
        removeSession(siteId);
        if (!args.json) process.stderr.write(`stopped session for ${siteId}\n`);
        emit(args, true, { site: siteId, status: 'stopped' });
        return 0;
      }
      throw new BroError('bad-args', 'usage: bro session start|stop <site>');
    }

    case 'sessions': {
      const all = readSessions();
      const rows: Array<Record<string, unknown>> = [];
      for (const [id, sctx] of Object.entries(all)) {
        const alive = !!(await probeCDP(sctx.port));
        rows.push({ site: id, port: sctx.port, pid: sctx.pid, startedAt: sctx.startedAt, alive });
        if (!args.json) process.stderr.write(`${id}  port ${sctx.port}  ${alive ? 'LIVE' : 'dead'}\n`);
      }
      emit(args, true, { sessions: rows });
      return 0;
    }

    default:
      throw new BroError('bad-args', `unknown verb "${verb ?? ''}"`, {
        hint: 'verbs: auth session sessions record new test run run-all list describe',
      });
  }
}

function capabilityDoc(): Record<string, unknown> {
  return {
    name: 'bro',
    description: 'general browser workflow runner',
    verbs: [
      { name: 'auth', args: '<site>', interactive: true, needsHuman: true },
      { name: 'session', args: 'start|stop <site>', interactive: true, needsHuman: true },
      { name: 'sessions', args: '', interactive: false },
      { name: 'record', args: '<site> <workflow>', interactive: true, needsHuman: false },
      { name: 'new', args: '<site> <workflow> --kind <kind>', interactive: false },
      { name: 'test', args: '<site> <workflow> [--month]', interactive: false, dryRun: true },
      { name: 'run', args: '<site> <workflow> [--month] [--headed]', interactive: false },
      { name: 'run-all', args: '--kind <kind> [--month]', interactive: false },
      { name: 'list', args: '', interactive: false },
      { name: 'describe', args: '', interactive: false },
    ],
    sinks: ['local', 'drive-raw'],
    sites: listSites().map((id) => {
      let source = '';
      try {
        source = loadSite(id).source;
      } catch {
        /* skip */
      }
      return { id, source, workflows: listWorkflows(id) };
    }),
  };
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const envelope =
      err instanceof BroError
        ? err.toEnvelope()
        : { kind: 'internal', message: err instanceof Error ? err.message : String(err), retriable: false, needsHuman: false };
    // JSON envelope always goes to stdout on failure so agents can parse it regardless of --json
    process.stdout.write(JSON.stringify({ ok: false, error: envelope }) + '\n');
    process.stderr.write(`\nbro: ${envelope['kind']}: ${envelope['message']}${envelope['hint'] ? `\n  hint: ${envelope['hint']}` : ''}\n`);
    process.exit(1);
  });
