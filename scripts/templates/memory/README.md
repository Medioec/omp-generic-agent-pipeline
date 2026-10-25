# Shared memory

Shared knowledge for pipeline runs. The pipeline itself never writes this repository: a run
records proposed claims in `runs/<run>/delta/`, and a human-triggered merge (`skill://merge-runs`)
is the only writer. `scripts/bootstrap.mjs` creates this skeleton on first run.

- `index.md` — topic catalog and the runs table (merge-owned)
- `facts/<topic>.md` — dated claim sections
- `decisions.md` — append-only decision log
- `evidence/<run>/...` — copies of the evidence merged claims cite

This is a separate git repository nested at `memory/` and ignored by the project repository.
Every link inside it is relative and must resolve inside it; `node scripts/merge-runs.mjs verify memory`
enforces that, and `evidence/` is treated as opaque content.
