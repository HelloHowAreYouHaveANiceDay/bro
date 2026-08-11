# local/ — your scripts, not the project's

Drop anything here. Everything in this folder is gitignored except this README and the
`.gitignore` itself, so the folder survives a clone and you get a working scratch space
immediately without touching the repo's history.

This exists because bro's persistent-browser context is useful well beyond fetching invoices —
it is a real, warm, fingerprint-genuine browser, which makes it the practical escape hatch for
sites that block plain HTTP clients. Those one-off scripts are worth keeping and not worth
shipping, so they live here.

## Why not just commit them?

bro is a **public** repo and a workflow runner, not a scraper library. A grab-bag of
session-specific scrapers in the root would be noise for everyone who clones it, and some
encode the shape of sites we happen to be researching. The *reusable* part of a script is
rarely the script — it is the two or three facts it cost you to learn. Put those in a comment
at the top of the file, and, if they generalise, in the tooling notes you actually re-read.

## Using it

Scripts run against the repo's own `node_modules`, so no separate install:

```bash
cd H:/working/bro
node local/my-script.mjs
```

Reuse a **named, warm** browser profile rather than creating a new one each run — the profile
accumulating real history is what gets past bot detection:

```js
import { chromium } from 'playwright';
import path from 'node:path';

const PROFILE = path.join(process.env.LOCALAPPDATA, 'bro', 'profiles', '<name>');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'msedge',
  headless: false,                 // headless gets challenged; a real window clears it
  viewport: null,
  args: ['--disable-blink-features=AutomationControlled'],
});
```

`profiles/` is already gitignored at the repo root, and profiles live outside the repo under
`%LOCALAPPDATA%\bro\profiles\` anyway.

## Conventions worth keeping

- **Take input from env vars, not argv.** Queries and URL lists contain commas, quotes and
  ampersands that a shell will happily mangle; a single env var survives.
- **Write results to JSON, print only a count.** You will want to re-read the output ten
  minutes later without re-running the scrape.
- **Never let a failure return an empty array silently.** Log which target failed and why.
  A null result that looks like a real finding is the most expensive bug in research code.
- **Put the hard-won facts in a header comment** — which selector, which page type, what
  changed and when you confirmed it. That comment is the actual deliverable.
