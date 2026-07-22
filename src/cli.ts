#!/usr/bin/env -S npx tsx
import fs from 'node:fs';
import { BroError } from './lib/errors.ts';
import { loadConfig } from './lib/config.ts';
import { listSites, listWorkflows, loadSite, loadWorkflow } from './lib/registry.ts';
import { authMetaPath, authPath } from './lib/paths.ts';
import { authFlow, recordFlow } from './lib/codegen.ts';
import { scaffoldWorkflow } from './lib/scaffold.ts';
import { runWorkflow } from './lib/runner.ts';

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
      if (!args.json) process.stderr.write(`Opening login for ${site.name}. Log in (+ MFA), then close the window.\n`);
      authFlow(site, cfg.browserChannel, new Date().toISOString());
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
        let auth: Record<string, unknown> = { present: fs.existsSync(authPath(id)) };
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

    default:
      throw new BroError('bad-args', `unknown verb "${verb ?? ''}"`, {
        hint: 'verbs: auth record new test run run-all list describe',
      });
  }
}

function capabilityDoc(): Record<string, unknown> {
  return {
    name: 'bro',
    description: 'general browser workflow runner',
    verbs: [
      { name: 'auth', args: '<site>', interactive: true, needsHuman: true },
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
