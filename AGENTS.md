# AGENTS.md — how an agent drives bro

bro is built to be operated by agents. After a human does the **one** human step (`bro auth`),
an agent can author, test, and run workflows autonomously.

## Contract

- **Discover, don't guess:** `bro describe --json` (verbs + sites + workflows + kinds) and
  `bro list --json` (auth freshness). Never hardcode site/workflow names.
- **Structured I/O:** every non-interactive verb accepts `--json` and returns `{ ok, result }` or
  `{ ok, error }`. On any failure the error envelope is printed to **stdout** as JSON even without
  `--json`. Exit code is 0 on success, 1 on error.
- **Branch on the error, don't parse prose.** Errors have `{ kind, retriable, needsHuman, hint }`:
  - `auth-expired` → `needsHuman: true` — you cannot fix this; tell the human to run the hinted
    `bro auth <site>`.
  - `bot-blocked` → `retriable: true` — retry with `--headed`.
  - `no-downloads` → the selectors likely broke; read the run log + `failure.png` under
    `.bro/runs/<id>/` and repair the workflow.
  - `no-such-site` / `no-such-workflow` → `detail.available` lists valid values.

## Sessions (banks / hardened sites)

Some sites (banks) can't have their session stored for unattended runs, and a fresh automated
context gets bot-blocked. For a site with `browser: 'persistent'` + `interactive: true`:

1. A **human** runs `bro session start <site>` once and logs in; the real browser stays open on a
   CDP port. `bro sessions --json` lists live sessions.
2. **You** run `bro run <site> <workflow>` — it attaches to the live session over CDP and drives it
   WITHOUT closing. No `auth.json`, no re-login while the session is alive.
3. If the session expired, `bro run` prompts the human to log in again in the live window
   (`auth-expired`, needsHuman).

Do NOT `bro auth` persistent/interactive sites — auth happens at `session start` / run time in the
real profile.

## Authoring a new workflow (autonomous)

1. Ensure the site exists and is authed (`bro list --json`). If not authed, ask a human to
   `bro auth <site>` — you cannot log in.
2. `bro new <site> <workflow> --kind <kind>` — scaffolds a typed skeleton.
3. Explore the **already-authenticated** live session to find the invoice table / download
   controls (use playwright-cli `snapshot`, loading the site's `auth.json`).
4. Fill in the workflow: navigate → enumerate rows for `ctx.params.ym` → `ctx.save(download, name,
   id)` (real download event) or `ctx.saveUrl(url, name, id)` (inline-rendered PDF).
   - Deterministic names: `${ctx.site.source}-${invoiceId-or-date}.pdf` (enables dedup).
5. `bro test <site> <workflow>` — dry-run (nothing shipped); iterate until it reports files.
6. Ship for real with `bro run <site> <workflow> --month <YYYY-MM>`.

## `read` workflows — scrape live data instead of downloading a file

Set `mode: 'read'` on the workflow and return `Row[]` (`Record<string, unknown>[]`) instead of
`DownloadedFile[]`. The runner ships nothing to the sink; `bro run <site> <workflow> --json` emits
`{ ok, result: { rows: [...] } }`, and `minExpected` gates the min **row** count. Use this for the
live data an OAuth/API used to serve (quotes, watchlist, balances, orders) — e.g. `sites/schwab/
workflows/watchlist.ts` + `quotes.ts`. Same **read-only** rule as below: navigate + DOM-read ONLY.
Gotcha: keep the `page.evaluate` body free of NAMED inner functions — tsx/esbuild rewrites them with
a `__name` helper that is undefined in the browser context (`ReferenceError: __name is not defined`);
inline callback arrows are fine.

## Hard rule — read-only in live financial accounts

Authoring and `test` drive the **real** logged-in account. Use navigation, snapshot/read, and
document-download controls **only**. **Never** click pay, cancel, delete, change-plan, or
update-billing controls. Workflows are document-retrieval shaped (navigate → list → download);
there is never a reason to touch a mutating control.

**Narrow, explicit exception — watchlist edits.** A watchlist carries no money and no orders, so a
wrong edit is trivially reversible. `sites/schwab/workflows/watchlist-edit.ts` is the ONE sanctioned
mutating workflow (create/delete a watchlist, add/remove symbols). It is gated: every op refuses to
run without `--confirm yes`. This exception covers **watchlists only** — the ban on trade / order /
transfer / billing controls stands absolute, and no other mutating workflow may be authored without
the same explicit, per-domain sign-off.

## Conventions

- ASCII-only output in any script; no secrets in logs.
- Never commit `auth.json`, `auth.meta.json`, or `.env` (gitignored; CI guards it too).
