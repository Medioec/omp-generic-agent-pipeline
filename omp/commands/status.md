---
description: Report the progress of running pipeline agents
argument-hint: [--run <run> | --agent <agent-id>]
---

Read the live registry and report progress. Do not modify the run.

1. Read the directory `runs/.agents/`. Each `<agent-id>.json` has `agent_id`, `request_id`,
   `role`, `run_dir`, `status`, `started`, `updated`. A live pipeline has two entries for the
   same request id: `role: orchestrator` and `role: improver`.
2. Select the entries matching `--agent` or `--run`, or all entries with status
   `starting`, `running`, `sink-approved`, or `verdict-written`.
3. For each selected entry:
   - read `agent://<agent-id>` for the latest published output and progress;
   - if `run_dir` is known, read `runs/<run>/verdict.md` or `manifest.json` when present
     and report the final outcome;
   - report role, status, run directory, request id, and the last progress line.
   An improver at `idle` between passes is healthy; it is woken by the orchestrator. Do not
   report it as stalled until the run's `issues.md` carries `- [open] improver-stalled`.
4. If an entry says `running` but `agent://<agent-id>` no longer resolves, mark it
   `failed` with `node scripts/requests.mjs update --agent <id> --status failed` and say
   so. For a lost improver, point the user at `/improver --run <run>`; do not relaunch the
   pipeline. Do not delete the registry entry.

Keep the report short. The run directory is the durable result; `agent://` is the live view.
