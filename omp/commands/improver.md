---
description: Attach a missing improver supervisor to a live pipeline run
argument-hint: [--run <run>]
---

Use this only when a run is live and its `improver` is gone — killed in the Agent Hub, absent
because the launch failed, or retired after a restart. `/pipeline` normally starts the
improver; never start a second one while the existing one is alive. Check first:

1. Read `runs/.agents/`. Entries carry `role` (`orchestrator` or `improver`), `run_dir` and
   `status`. Find the live run's `role: improver` entry.
2. If it still resolves (`read agent://<improver-id>` returns a status or progress), report
   that it is alive and stop. Do not send it a launch-shaped instruction.
3. Otherwise read `runs/<run>/orchestrator.id` and `runs/<run>/request_id` from the
   orchestrator's registry entry.
4. Dispatch one `improver` subagent with `agent: "improver"` and a self-sufficient task:
   `request_id=<id>`, `orchestrator_agent=<orchestrator-id>`, `run_dir=runs/<run>`, the
   instruction to read `.omp/agents/improver.md` and `skill://pipeline-audit`, the current
   `runs/<run>/improvement.md` pass counter, and the note that it resumes a live run.
5. Register it with `node scripts/requests.mjs register --agent <improver-id> --request-id
   <id> --run runs/<run> --role improver`, then message the orchestrator:
   `write agent://<orchestrator-id>` with `improver_agent=<improver-id> run_dir=runs/<run>`.
   The orchestrator records `- [open] improver-absent resolved` and resumes waking it.

Never let two improvers share one run: they share the project tree and `improvement.md`.
