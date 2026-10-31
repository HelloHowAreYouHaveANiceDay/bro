# bro — general browser workflow runner

Record an authenticated browser action a human takes on a logged-in site, generalize it, and run
it later **with no AI in the loop**. First use case: pulling invoices/statements from vendor
portals into an accounting pipeline.

## The model

- **Site** = one authenticated *identity* (`sites/<id>/`), owning one `auth.json` (session state).
  Two logins on the same domain = two sites (`cloudflare-stg`, `cloudflare-personal`).
- **Workflow** = a task script for a site (`sites/<id>/workflows/<name>.ts`), tagged with a `kind`
  (`invoices`, `statements`, …). Many workflows share one site's auth.
- Auth and workflows are **decoupled**: the runner injects an already-authenticated page; a
  workflow never touches credentials.

## Auth model (why there are no passwords here)

`bro auth login <site>` opens a real browser via Playwright `codegen`; **you** log in (and clear MFA) by
hand. Only the resulting `storageState` (`auth.json`) is saved — **no password is ever stored or
typed by the tool.** `auth.json` is gitignored and local-only. When it expires, re-run `bro auth login`.

## Quickstart

```bash
npm install
cp .env.example .env            # set BRO_SINK, paths, browser channel
npx tsx src/cli.ts auth login cloudflare-stg     # human logs in once
npx tsx src/cli.ts workflow run cloudflare-stg invoices --month 2026-06
```

(Optionally `npm link` so `bro …` works directly.)

## Verbs

| Verb | What it does | Human? |
|------|--------------|--------|
| `auth login <site>` | log in; save `auth.json` (launch-mode sites) | **yes** |
| `session launch\|quit <site>` | open/close a long-lived logged-in browser session (banks) | launch = **yes** |
| `session list` | list live sessions | no |
| `page open <url>` | open a URL in the scratch browser | no |
| `page exec <site> <action>` | drive a live session tab | no |
| `record <site> <wf>` | optional: demo a task to seed a workflow | yes |
| `new <site> <wf> --kind <k>` | scaffold a typed workflow skeleton | no |
| `workflow run <site> <wf> --dry-run` | dry-run (no files shipped) + failure artifacts | no |
| `workflow run <site> <wf> [--month] [--headed]` | run + ship files through the sink | no |
| `workflow run-all --kind <k> [--month]` | run every workflow of a kind across sites | no |
| `site list` / `describe` | discovery / machine capability doc | no |

Every non-interactive verb takes `--json` for a stable `{ ok, result | error }` envelope.
The old CLI spellings (`auth`, `session start|stop`, `sessions`, `open`, `page`, `test`, `run`, `run-all`, and `list`) still work as aliases.

## Sinks

- `local` (default) — writes `{YYYY}/{MM}/{source}/` under `BRO_LOCAL_ROOT`.
- `drive-raw` — uploads to Google Drive `raw/{YYYY}/{MM}/{source}/` via `bim google drive` (needs the
  v0.4.0 driver: full `drive` scope + `--parent` + folder-ensure).

## Browser modes (hardened / fingerprinting sites)

Per-site fields in `site.json`:

- `browser: 'persistent'` — drive the **real installed** Chrome/Edge on a per-site profile
  (`launchPersistentContext`), inheriting a genuine device fingerprint (real TLS/JA3, GPU, fonts).
  For sites (banks behind Akamai/DataDome) that blank a fresh automated context. The login lives in
  the profile, not `auth.json`.
- `interactive: true` — the session can't be stored unattended (banks use short-lived in-memory
  cookies). `bro workflow run` opens the browser, waits for you to reach the dashboard, then runs in that
  **same live session**.

**Live sessions** — log in once, keep it open, run many (solves the unstorable bank session):

```bash
bro session launch chase-stg  # opens the real browser; you log in; it stays alive on a CDP port
bro workflow run chase-stg statements  # attaches over CDP, drives it, does NOT close the browser
bro session list              # list live sessions
bro session quit chase-stg     # end it
```

## Open-source note

The engine (`src/`) + `sites/_example/` are public. Your real `sites/*` are **gitignored** — the
list of vendors is itself sensitive. `auth.json`/`.env` are never committed. See `AGENTS.md` for
how an agent drives bro.
