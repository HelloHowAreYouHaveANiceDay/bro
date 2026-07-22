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

`bro auth <site>` opens a real browser via Playwright `codegen`; **you** log in (and clear MFA) by
hand. Only the resulting `storageState` (`auth.json`) is saved — **no password is ever stored or
typed by the tool.** `auth.json` is gitignored and local-only. When it expires, re-run `bro auth`.

## Quickstart

```bash
npm install
cp .env.example .env            # set BRO_SINK, paths, browser channel
npx tsx src/cli.ts auth cloudflare-stg          # human logs in once
npx tsx src/cli.ts run cloudflare-stg invoices --month 2026-06
```

(Optionally `npm link` so `bro …` works directly.)

## Verbs

| Verb | What it does | Human? |
|------|--------------|--------|
| `auth <site>` | log in; save `auth.json` | **yes** (the only human step) |
| `record <site> <wf>` | optional: demo a task to seed a workflow | yes |
| `new <site> <wf> --kind <k>` | scaffold a typed workflow skeleton | no |
| `test <site> <wf>` | dry-run (no files shipped) + failure artifacts | no |
| `run <site> <wf> [--month] [--headed]` | run + ship files through the sink | no |
| `run-all --kind <k> [--month]` | run every workflow of a kind across sites | no |
| `list` / `describe` | discovery / machine capability doc | no |

Every non-interactive verb takes `--json` for a stable `{ ok, result | error }` envelope.

## Sinks

- `local` (default) — writes `{YYYY}/{MM}/{source}/` under `BRO_LOCAL_ROOT`.
- `drive-raw` — uploads to Google Drive `raw/{YYYY}/{MM}/{source}/`. **Requires a bim-cli
  enhancement** (`drive` scope + `--parent` + folder-ensure); until deployed, this sink returns a
  typed `sink-unavailable` error and you use `local`.

## Open-source note

The engine (`src/`) + `sites/_example/` are public. Your real `sites/*` are **gitignored** — the
list of vendors is itself sensitive. `auth.json`/`.env` are never committed. See `AGENTS.md` for
how an agent drives bro.
