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
import { startPersistentSession, runLiveSession, guardSessionHost, pickLoginPage } from './lib/session.ts';
import { awaitInteractiveLogin, DEFAULT_INTERACTIVE_LOGIN_TIMEOUT_MS } from './lib/authGuard.ts';
import { readSessions, setSession, removeSession, getSession, probeCDP } from './lib/sessions.ts';
import { startDetached, liveSession } from './lib/detach.ts';
import {
  resolveLive, listTabs, pickTab, PageCDP, clickSelector, typeText, pressKey, gotoUrl, screenshot,
  captureResponses, openTab, closeTab, pidAlive,
} from './lib/page.ts';
import { chromium } from 'playwright';

interface Args {
  _: string[];
  json: boolean;
  headed: boolean;
  detach: boolean;
  reload: boolean;
  full: boolean;
  month?: string;
  dateStamp?: string;
  kind?: string;
  params: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], json: false, headed: false, detach: false, reload: false, full: false, params: {} };
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
    else if (key === 'detach') out.detach = true;
    else if (key === 'reload') out.reload = true;
    else if (key === 'full') out.full = true;
    else if (key === 'month') out.month = inlineVal ?? argv[++i];
    else if (key === 'date-stamp') out.dateStamp = inlineVal ?? 'today';
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

function localDateStamp(now: Date): string {
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
      if (!a || !b) throw new BroError('bad-args', `usage: bro ${verb} <site> <workflow> [--month YYYY-MM] [--date-stamp[=YYYY-MM-DD]]`);
      const manifest = await runWorkflow({
        siteId: a,
        workflowName: b,
        cliParams: args.params,
        month: args.month,
        dateStamp: args.dateStamp === 'today' ? localDateStamp(now) : args.dateStamp,
        headed: args.headed,
        dryRun: verb === 'test',
        stampIso,
        now,
        mirror: !args.json,
      });
      if (!args.json) {
        process.stderr.write(`\n${verb} ${a}/${b} (${manifest.month}) -> ${manifest.location}\n`);
        for (const f of manifest.files) {
          process.stderr.write(`  ${f.status}  ${f.name} (${f.bytes} bytes)\n`);
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
      const sites = listSites({ builtins: true }).map((id) => {
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
        if (!siteId) throw new BroError('bad-args', 'usage: bro session start <site> [--detach]');
        const site = loadSite(siteId);
        if (args.detach) {
          const r = await startDetached(siteId);
          if (!args.json)
            process.stderr.write(
              `[bro] session for ${siteId} is LIVE on CDP port ${r.port} (${r.status}, detached pid ${r.pid}).\n` +
                `      It survives this shell; end it with \`bro session stop ${siteId}\`. Log: ${r.log}\n`,
            );
          emit(args, true, { ...r });
          return 0;
        }
        const existing = await liveSession(siteId);
        if (existing) {
          if (!args.json) process.stderr.write(`[bro] session for ${siteId} is already LIVE on CDP port ${existing.port}.\n`);
          emit(args, true, { site: siteId, port: existing.port, pid: existing.pid, status: 'already-running' });
          return 0;
        }
        guardSessionHost(process, (m) => process.stderr.write(m), (err) => {
          process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
          process.exit(1);
        });
        const { context, port } = await startPersistentSession(site, { channel: cfg.browserChannel });
        // Reuse a restored tab already on the site instead of opening a duplicate of it.
        const page = pickLoginPage(context.pages(), site) ?? (await context.newPage());
        await runLiveSession({
          site,
          port,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          detectionTimeoutMs: DEFAULT_INTERACTIVE_LOGIN_TIMEOUT_MS,
          setSession,
          removeSession,
          emitLive: () => {
            if (!args.json)
              process.stderr.write(
                `\n[bro] session for ${siteId} is LIVE on CDP port ${port}.\n` +
                  `      Run workflows with \`bro run ${siteId} <workflow>\` (they attach, they don't close).\n` +
                  `      Leave this process running; end it with \`bro session stop ${siteId}\` or Ctrl-C.\n`,
              );
            emit(args, true, { site: siteId, port, status: 'live' });
          },
          detectLogin: () =>
            site.public
              ? Promise.resolve(true) // no login to detect; don't navigate the human's tabs
              : awaitInteractiveLogin(page, site, () => {}, {
                  timeoutMs: DEFAULT_INTERACTIVE_LOGIN_TIMEOUT_MS,
                  fatal: false,
                }),
          keepAlive: () => new Promise<void>(() => {}),
          closeContext: () => context.close(),
          onSignal: (signal, handler) => {
            process.on(signal, handler);
          },
          onContextClose: (handler) => {
            context.on('close', handler);
          },
          writeStderr: (msg) => {
            process.stderr.write(msg);
          },
          exit: (code) => {
            process.exit(code);
          },
        });
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

    case 'open': {
      // bro open <url> [--site <id>] -- a tab in a LIVE session (default: the built-in `scratch` site,
      // started detached on demand). Public browsing belongs in scratch, not a vendor's logged-in profile.
      const url = a;
      if (!url) throw new BroError('bad-args', 'usage: bro open <url> [--site <id>]');
      const siteId = args.params['site'] || 'scratch';
      loadSite(siteId);
      let live = await liveSession(siteId);
      let started = false;
      if (!live) {
        if (siteId !== 'scratch')
          throw new BroError('no-session', `no LIVE session for "${siteId}"`, { retriable: true, hint: `bro session start ${siteId} --detach` });
        await startDetached(siteId);
        live = await liveSession(siteId);
        started = true;
        if (!live) throw new BroError('internal', 'scratch session did not come up');
      }
      const tab = await openTab(live.port, url);
      const payload = { site: siteId, port: live.port, tab: tab.id, url, startedSession: started };
      if (!args.json) process.stderr.write(`[bro] opened ${url} in ${siteId} (tab ${tab.id}). Next: bro page ${siteId} text --tab ${tab.id}\n`);
      emit(args, true, payload);
      return 0;
    }

    case 'page': {
      // bro page <site> <action> [arg] [--tab <id|url-substr>] -- drive a LIVE session's tab by SITE id.
      const siteId = a;
      const action = b;
      const arg = args._[3];
      const usage =
        'usage: bro page <site> tabs | text [--max N] | eval <js> | goto <url> [--wait ms] | click <css> | type <text> | key <Key> | shot <out.png> [--full] | capture <url-substr> [--reload] [--wait ms] [--out file] | close  [--tab <id|url-substr>]';
      if (!siteId || !action) throw new BroError('bad-args', usage);
      const site = loadSite(siteId);
      const live = await resolveLive(siteId);
      const tabs = await listTabs(live.port);
      if (action === 'tabs') {
        const rows = tabs.map((t) => ({ id: t.id, url: t.url, title: t.title }));
        if (!args.json) for (const t of rows) process.stdout.write(`${t.id}  ${t.url}\n`);
        emit(args, true, { site: siteId, port: live.port, tabs: rows });
        return 0;
      }
      const tab = pickTab(tabs, args.params['tab'], [site.homeUrl, site.loginUrl]);
      if (action === 'close') {
        await closeTab(live.port, tab.id);
        emit(args, true, { site: siteId, tab: tab.id, status: 'closed' });
        return 0;
      }
      const cdp = await PageCDP.connect(tab);
      try {
        const wait = Number(args.params['wait'] || 0);
        let result: Record<string, unknown>;
        switch (action) {
          case 'text': {
            const max = Number(args.params['max'] || 20000);
            const text = String((await cdp.evaluate('document.body ? document.body.innerText : ""')) ?? '');
            result = { url: await cdp.evaluate('location.href'), length: text.length, text: text.slice(0, max) };
            if (!args.json) process.stdout.write(text.slice(0, max) + '\n');
            break;
          }
          case 'eval': {
            if (!arg) throw new BroError('bad-args', 'usage: bro page <site> eval <js expression>');
            const value = await cdp.evaluate(arg);
            result = { value };
            if (!args.json) process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
            break;
          }
          case 'goto': {
            if (!arg) throw new BroError('bad-args', 'usage: bro page <site> goto <url>');
            result = { url: await gotoUrl(cdp, arg, wait || 15000) };
            break;
          }
          case 'click': {
            if (!arg) throw new BroError('bad-args', 'usage: bro page <site> click <css selector>');
            await clickSelector(cdp, arg);
            if (wait) await new Promise((r) => setTimeout(r, wait));
            result = { clicked: arg, url: await cdp.evaluate('location.href') };
            break;
          }
          case 'type': {
            if (arg === undefined) throw new BroError('bad-args', 'usage: bro page <site> type <text>  (types into the focused element; click it first)');
            await typeText(cdp, arg);
            result = { typed: arg.length };
            break;
          }
          case 'key': {
            if (!arg) throw new BroError('bad-args', 'usage: bro page <site> key <Enter|Tab|Escape|...>');
            await pressKey(cdp, arg);
            result = { key: arg };
            break;
          }
          case 'shot': {
            if (!arg) throw new BroError('bad-args', 'usage: bro page <site> shot <out.png> [--full]');
            result = await screenshot(cdp, arg, args.full);
            break;
          }
          case 'capture': {
            if (!arg) throw new BroError('bad-args', 'usage: bro page <site> capture <url-substr> [--reload] [--wait ms] [--out file]');
            const rows = await captureResponses(cdp, arg, { reload: args.reload, waitMs: wait || 15000 });
            const out = args.params['out'];
            if (out) fs.writeFileSync(out, JSON.stringify(rows));
            result = { match: arg, count: rows.length, ...(out ? { out } : { responses: rows }) };
            break;
          }
          default:
            throw new BroError('bad-args', `unknown page action "${action}"`, { hint: usage });
        }
        emit(args, true, { site: siteId, tab: tab.id, ...result });
        if (!args.json && !['text', 'eval'].includes(action)) process.stdout.write(JSON.stringify(result) + '\n');
        return 0;
      } finally {
        cdp.close();
      }
    }

    case 'sessions': {
      const all = readSessions();
      const rows: Array<Record<string, unknown>> = [];
      for (const [id, sctx] of Object.entries(all)) {
        // LIVE = host pid running AND the port answers CDP. A dead pid on a live port means another
        // site's browser now owns that port: the row is stale, not this site's session.
        const hostAlive = pidAlive(sctx.pid);
        const alive = hostAlive && !!(await probeCDP(sctx.port));
        rows.push({ site: id, port: sctx.port, pid: sctx.pid, startedAt: sctx.startedAt, alive, hostAlive });
        if (!args.json) process.stderr.write(`${id}  port ${sctx.port}  ${alive ? 'LIVE' : hostAlive ? 'dead (port closed)' : 'stale (host gone)'}\n`);
      }
      emit(args, true, { sessions: rows });
      return 0;
    }

    default:
      throw new BroError('bad-args', `unknown verb "${verb ?? ''}"`, {
        hint: 'verbs: auth session sessions open page record new test run run-all list describe',
      });
  }
}

function capabilityDoc(): Record<string, unknown> {
  return {
    name: 'bro',
    description: 'general browser workflow runner',
    verbs: [
      { name: 'auth', args: '<site>', interactive: true, needsHuman: true },
      { name: 'session', args: 'start|stop <site> [--detach]', interactive: true, needsHuman: true },
      { name: 'sessions', args: '', interactive: false },
      { name: 'open', args: '<url> [--site <id>]  (default site: built-in scratch, started detached on demand)', interactive: false },
      {
        name: 'page',
        args: '<site> tabs|text|eval <js>|goto <url>|click <css>|type <text>|key <Key>|shot <png>|capture <url-substr>|close [--tab <id|url-substr>] [--wait ms] [--reload] [--out file] [--full] [--max N]',
        interactive: false,
      },
      { name: 'record', args: '<site> <workflow>', interactive: true, needsHuman: false },
      { name: 'new', args: '<site> <workflow> --kind <kind>', interactive: false },
      { name: 'test', args: '<site> <workflow> [--month] [--date-stamp[=YYYY-MM-DD]]', interactive: false, dryRun: true },
      { name: 'run', args: '<site> <workflow> [--month] [--date-stamp[=YYYY-MM-DD]] [--headed]', interactive: false },
      { name: 'run-all', args: '--kind <kind> [--month]', interactive: false },
      { name: 'list', args: '', interactive: false },
      { name: 'describe', args: '', interactive: false },
    ],
    sinks: ['local', 'drive-raw'],
    sites: listSites({ builtins: true }).map((id) => {
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
