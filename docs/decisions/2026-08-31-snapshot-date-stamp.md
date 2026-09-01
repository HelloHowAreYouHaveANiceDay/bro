## Context

The `drive-raw` sink deduplicates by filename through finlib's `drive_cli.py`, which exposes
`list`, `mkdir`, and a non-clobbering `upload` only. Snapshot workflows such as Schwab positions
and orders can produce multiple legitimate same-month pulls, so month-only names like
`schwab-positions-2026-08.csv` let a later pull silently reuse a stale earlier file.

## Decision

Snapshot freshness is handled by stamping the saved filename with `YYYY-MM-DD` at run time via
`bro run|test --date-stamp[=YYYY-MM-DD]`. The core save path applies the stamp before either sink
sees the file, preserving invoice-style first-wins dedup by default while giving snapshot pulls a
collision-free name in both local and Drive storage.

Run manifests and CLI output also carry an explicit `status` value of `saved` or `reused` so a
dedup hit is distinguishable from a fresh write.

## Consequences

- Snapshot callers must opt in with `--date-stamp` when same-month reruns are expected.
- Invoice workflows keep their existing deterministic names and dedup behavior.
- A true same-name overwrite in Drive still requires finlib support outside this repo.
