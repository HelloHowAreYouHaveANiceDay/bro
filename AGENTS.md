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

## Public sites (no identity)

Sites that render via JavaScript but require no login use `public: true` in `site.json`. No
`auth.json`, no `bro auth` step -- the browser launches fresh. If `authedWhen` is set it acts as a
readiness predicate (wait until the app settles); a failure raises `not-ready` (retriable), never
`auth-expired`. Navigation aborts (`ERR_ABORTED`) during the initial load are silently swallowed
since redirect-heavy SPAs abort their own pending navigations.

## Sessions (banks / hardened sites)

Some sites (banks) can't have their session stored for unattended runs, and a fresh automated
context gets bot-blocked. For a site with `browser: 'persistent'` + `interactive: true`:

1. A **human** runs `bro session start <site>` once and logs in; the real browser stays open on a
   CDP port. `bro sessions --json` lists live sessions.
2. **You** run `bro run <site> <workflow>` — it attaches to the live session over CDP and drives it
   WITHOUT closing. No `auth.json`, no re-login while the session is alive.
3. If the session expired, `bro run` prompts the human to log in again in the live window
   (`auth-expired`, needsHuman).

4. When attached to a live session over CDP, teardown must only drop the CDP client connection:
   let the process exit / detach, and never call `browser.close()` or `context.close()` on that
   session. `src/lib/session.ts:46` is the canonical safe pattern to preserve.

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

## Token-in-URL SPA navigation

For token-in-url SPA sites, never use a bare goto to an in-app route. Use `ctx.reach(...)` so bro
clicks visible in-app navigation and lets the live token flow forward inside the SPA. GEICO is the
worked example: a bare `page.goto()` to a tokenless or stale-token app URL is treated as a logout.

## Schwab gotchas (Order Status export + sessions)

- **`bro run` alone uses an EPHEMERAL browser and re-prompts login every run.** For iterative
  work (building/debugging a workflow) use `bro session start schwab` once (persistent CDP,
  one login, reused by every subsequent `bro run`). Schwab's trade/order pages ALSO trigger a
  step-up re-auth even in an otherwise-authed session -- that is the "second login", one-time
  per session, completed in the live window.
- **`BRO_SINK=local`** writes CSVs to the local ledger tree and bypasses the Drive sink -- use
  it when the finlib/bim-google Google token is dead (`sink-unavailable: drive mkdir failed`).
- **Order Status grid is shadow-DOM** (`stos-*` web components): `page.evaluate` textContent
  and even Playwright `innerText` on the cells return empty. Do NOT scrape -- use the page's
  **Export button -> CSV** (`sites/schwab/workflows/orders.ts`, the same pattern as positions).
- **Export raises a shadow-DOM caution modal** (`sdps-modal`, "Export Order Status Data"); the
  download fires only after its **OK**. `getByRole('dialog')` does NOT match `sdps-modal`, and
  OK is a light-DOM `sdps-button` (no `role=button`) with a hidden duplicate -- match the
  VISIBLE one: `page.locator('sdps-modal').filter({hasText:/Export Order Status/i})
  .locator('button, sdps-button').filter({hasText:/^OK$/}).filter({visible:true})`.
- **The export->download needs a HEALTHY session.** A long-idle/degraded one ("Your Session
  Will Expire Soon -- error extending your session") silently stops firing downloads while grid
  reads still work; the tell is `waitForEvent('download')` timing out on every account. Restart
  with `bro session start schwab`.
- **Multi-account works, but the account switch is finicky.** There is no "all accounts" view;
  `--accounts=all` / `--only=<acct>` iterate the `sdps-account-selector`. The dropdown is a
  `button[aria-haspopup]` toggle that MUST be clicked to open the panel first -- only then do the
  option anchors (`<a href="javascript:void(0)">`) become visible/clickable. Clicking the
  component or an inner text span does nothing (options stay `visible:false`), and the symptom is
  that EVERY export silently returns the persisted account's rows (identical data tagged under
  each account). Open via the toggle, then click the option anchor; see `selectAccount()`.
- **File month = `ctx.params.ym`, not the CSV's as-of date.** A `positions`/`orders` pull with
  no `--month` stamps the file with the param default, which can be the WRONG month folder
  (a today pull landed as `2026-07`). Downstream pickers that key on the month string then
  ignore the fresh file -- pass `--month <YYYY-MM>` or move the file to the correct folder.
- **Snapshot re-pulls need a collision-free name.** The local sink and Drive raw sink both dedup by
  filename, and finlib's `drive_cli.py upload` is non-clobbering, so a second same-month pull can
  silently reuse the earlier file. For snapshot workflows such as Schwab `positions`/`orders`, run
  with **`--date-stamp`** (or `--date-stamp=YYYY-MM-DD`) so `schwab-positions-2026-08.csv` becomes
  `schwab-positions-2026-08-31.csv` and the fresh pull persists. A reused file now reports
  `status:"reused"` instead of looking like a fresh save. Always check the CSV's `as of ...` header
  line after a pull.
- **Cost-basis tax LOTS (`sites/schwab/workflows/lots.ts`, read-only): the lot table is behind a
  per-symbol drill-down on the Positions grid, not a URL.** Mechanics that work: wait for the symbol
  to render (the grid is slow; symbols are `<th>` row-headers, not `<td>`); each holding is a
  `tr.parent-pos` whose **cost-basis value is a `<button>`/`sdps-button` (aria-label = the $ amount)
  that EXPANDS the lot child-rows** -- click it with a TRUSTED Playwright click by that aria-label
  (`evaluate().click()` on the custom element does not fire the expander, same class of bug as the
  export-modal OK). Then scrape rows carrying an **acquisition date (MM/DD/YYYY)** -- that uniquely
  identifies lot rows (Open Date / Qty / Cost/Share / Mkt Val / Cost Basis / Gain / Holding term).
  The Positions "Cost Basis" URL guesses (`/app/accounts/cost-basis/`) are dead shells; drill from
  `/app/accounts/positions/`.

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

- Verification: `npm run build` and `npm test`.
- ASCII-only output in any script; no secrets in logs.
- Never commit `auth.json`, `auth.meta.json`, or `.env` (gitignored; CI guards it too).
