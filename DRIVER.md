# bro as a bim-cli driver

bro has two front doors over the same workflow engine:

- **CLI** (`src/cli.ts`, `bro <verb> ...`) — the human/agent-facing surface. Unchanged.
- **JSON-RPC driver** (`src/driver.ts`, published as `bim-bro.exe`) — the bim-cli driver-facing
  surface: one JSON-RPC 2.0 request on stdin → one response on stdout per process spawn, so
  `bim bro <verb>` routes through the dispatcher. Passes `bim driver-conformance bro` (17/17).

## Contract (what `src/driver.ts` implements)

- Reads one `{"jsonrpc":"2.0","method":...,"params":{...},"id":1}` line from stdin; writes one
  `{"jsonrpc":"2.0","result":...|error:{code,message,data:{kind,...}},"id":1}` line to stdout;
  exits 0 after any valid response (even an error). stdout carries ONLY the frame — logs go to stderr.
- TTY guard: bare run in a terminal prints a hint and exits 1 (never blocks on stdin).
- Verbs: `describe`, `doctor`, `version`, `list`, `sessions`, `run`, `test`, `run-all`. The
  interactive verbs (`auth`, `session`) are declared in `describe` but return a "use the CLI"
  error in driver mode (they need a human / a long-lived process).
- Error `kind` → JSON-RPC code per the bim-cli table; `auth-expired` is normalized to
  `auth_required` so the dispatcher's oauth intercept fires.

## Build + install

```
npm run build:driver          # -> bim-bro.exe (Node 22+ SEA; ~92 MB)
copy bim-bro.exe %LOCALAPPDATA%\bim-cli\drivers\bim-bro.exe
bim describe --refresh        # register it
bim driver-conformance bro    # verify (expect ok:true, 17/17)
bim bro doctor                # health check via the dispatcher
```

`bim-bro.exe` is a **TRUE STANDALONE Node SEA**: `sea/build.mjs` esbuild-bundles `src/sea-entry.ts`
(which pulls in the whole bro driver + sucrase) into one CJS file and bakes it into the blob. At
runtime it depends on **nothing** from a bro checkout — no `src/`, no tsx, no `node` on PATH. Editing
`src/*.ts` requires a rebuild (`npm run build:driver`), unlike the old launcher which resolved the
checkout live.

- **Workflow `.ts` loading** — in the SEA there is no tsx loader, so `src/lib/tsrequire.ts` registers
  a sucrase-backed `.ts` require hook; a workflow's relative sibling imports (e.g.
  `schwab/workflows/transactions.ts` → `./positions.ts`) resolve recursively. Workflows import only
  TYPES from bro's own src (erased) and get all runtime capability via the injected `ctx`.
- **Data locations** — no checkout means paths default to the OS data dir (`dataRoot()` in
  `src/lib/paths.ts`): `<LOCALAPPDATA>\bro\sites`, `\profiles`, `\runtime`, and a standalone `.env`.
  Override with `BRO_HOME` (whole data root), `BRO_SITES_DIR`, `BRO_PROFILE_ROOT`, `BRO_RUNTIME`.

## The managed dependencies (playwright + browser)

The `.exe` bundles bro's own code but **not** playwright — like `bim-blender`/Blender, the playwright
package AND its Chromium browser are **CLI-managed dependencies** provisioned once into the runtime
dir. `bim bro doctor` detects both and its `fix_cmd`s provision them:

```
npm i --prefix "<runtimeDir>" playwright
"<runtimeDir>\node_modules\.bin\playwright" install chromium
```

`<runtimeDir>` defaults to `<LOCALAPPDATA>\bro\runtime` (override `BRO_RUNTIME`). `src/sea-entry.ts`
pins playwright resolution to that dir via a `Module._resolveFilename` override, so the exe behaves
identically on any machine (playwright present **iff** provisioned there) and never silently binds to
a checkout that happens to sit at the SEA's build-time path. All runtime playwright access goes
through `src/lib/playwright.ts` (`createRequire`, honoring the pin) — never a static
`import ... from 'playwright'` (which esbuild would compile to a SEA builtin-only `require`, failing
with "No such built-in module: playwright").

So "standalone" = **one exe + a runtime dir (playwright) + a browsers cache + a sites data dir**. The
one-time provisioning uses npm; day-to-day running is the exe alone.
