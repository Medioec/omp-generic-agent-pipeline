---
description: Wait for a background pipeline started in this session
argument-hint: [--agent <agent-id> | --run <run>]
---

Wait on the background **orchestrator** started by an async `/pipeline` in this session.

1. Read `runs/.agents/` and select the entry matching `--agent` or `--run`, or the single
   `starting`/`running` entry, **filtering on `role: orchestrator`**. An `improver` entry is a
   sibling supervisor: it idles between passes and its yield does not finish the run. Never
   wait on it.
2. Call `wait`. The harness waits on background jobs started in this session, a message,
   or a steering interrupt.
3. Read `agent://<agent-id>` and report the final result, run directory, verdict, and open
   issues. Update the registry status with
   `node scripts/requests.mjs update --agent <agent-id> --status closed` when the output
   shows the run finished.
4. If no background job is available in this session (for example after a restart), use
   `/status` and read the run folder instead. Do not start a second pipeline.
