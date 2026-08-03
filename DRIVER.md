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
npm run build:driver          # -> bim-bro.exe (Node 22+ SEA; ~90 MB: node runtime + launcher)
copy bim-bro.exe %LOCALAPPDATA%\bim-cli\drivers\bim-bro.exe
bim describe --refresh        # register it
bim driver-conformance bro    # verify (expect ok:true)
bim bro doctor                # health check via the dispatcher
```

`bim-bro.exe` is a **self-contained SEA launcher** that runs `src/driver.ts` via Node in this
checkout (resolved via `BRO_HOME`, baked at build time). So editing `src/driver.ts` takes effect
without rebuilding the `.exe`; rebuild only when changing the launcher itself.

## The managed browser dependency

The `.exe` bundles the Node runtime + launcher, but **not** the browser binaries — like
`bim-blender` and Blender, Playwright's Chromium is a **CLI-managed dependency**: `bim bro doctor`
detects it (`browser:chromium` check) and its `fix_cmd` provisions it:

```
npx playwright install chromium
```

bro's node_modules (the `playwright` package) live in this checkout; the browser binaries live in
the Playwright cache. `doctor` reports both.
