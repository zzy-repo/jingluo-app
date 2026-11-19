# Window memory (prototype)

Ported from the Summaryception prototype. Scope is a single chat window — no
cross-session or global profile, and nothing is shared between windows.

- Runs today as a SillyTavern extension (`manifest.json` + block-scoped JS).
- To run inside this app it still needs: an API layer for the embedding endpoint,
  a user-facing "use cloud embedding" toggle (default off, falls back to local BM25),
  and wiring to per-window storage.
- `node --test tests/recall.test.cjs` covers recall, budget packing and cache reuse.
