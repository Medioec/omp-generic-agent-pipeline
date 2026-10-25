---
description: Start the general-purpose agent pipeline for a task
argument-hint: <task> [--wait]
---

**Bootstrap first.** Run `node scripts/bootstrap.mjs` once per project. It is idempotent — it
creates the project git history, the `memory/` repo (index, decisions, facts, evidence), and the
ignored `runs/` directory only when missing, and changes nothing that already exists.
`node scripts/bootstrap.mjs --check` reports gaps without writing.

`OBJECTIVE.md` at the project root is human-owned and optional: a blank or missing file
makes the run fall back to the original request. Do not edit it.

The pipeline is **asynchronous by default** so the same session can accept `/request`
while it runs. Do not implement the task yourself.

You start **two** top-level agents, in this order, and neither is a child of the other:

- `orchestrator` — plans, schedules, adjudicates, closes the run;
- `improver` — a sibling supervisor that audits the pipeline as a whole and is woken by the
  orchestrator through `agent://` messages. It is never spawned or `task`-dispatched by the
  orchestrator, and it is not part of the plan.

1. Strip `--wait` from the arguments. Generate a request id:
   `node scripts/requests.mjs id`.
2. Dispatch the `orchestrator` subagent **once** with the `task` tool. Select it explicitly:
   the `tasks[]` item MUST carry `agent: "orchestrator"`. Omitting `agent` spawns the generic
   `task` agent, which has no request channel and will ignore `[request]` doorbells. Put the
   id first so the orchestrator can register itself:

   ```json
   context: "Async pipeline launch for request <request-id>.",
   tasks: [{
     "agent": "orchestrator",
     "task": "request_id=<request-id>\n\n<task without --wait>",
     "solutionSpace": "Open-ended multi-step work; the orchestrator resolves work type and scope."
   }]
   ```

   The result reports the orchestrator's agent id.
3. Record the live agent with its role:
   `node scripts/requests.mjs register --agent <agent-id> --request-id <request-id> --role orchestrator`.
   The helper records `starting` for a new entry and preserves a status the orchestrator
   has already set. `submit` refuses an agent whose recorded role is not `orchestrator`
   (including an entry with no role).
4. Dispatch the `improver` subagent **once**, in its own call, with `agent: "improver"`. It
   starts alongside the orchestrator and must be addressable by it, so name the orchestrator.
   Give it the request id, not the task: the request is the worker's deliverable, not the
   improver's assignment, and a task line in its prompt invites it to perform the run's work.

   ```json
   context: "Async pipeline launch for request <request-id>.",
   tasks: [{
     "agent": "improver",
     "task": "request_id=<request-id>\norchestrator_agent=<orchestrator-id>\nrun_dir=(unknown)\n\nYou are the sibling supervisor for this request. The request itself belongs to the run's workers; do not perform it. Read .omp/agents/improver.md, confirm you are online, and yield IMPROVER STATUS: IDLE until the orchestrator wakes you with the run directory.",
     "solutionSpace": "Whole-pipeline supervision of a live run; the improver chooses which pipeline defects to fix from run evidence."
   }]
   ```

   Then register it with the same request id and `--role improver`:
   `node scripts/requests.mjs register --agent <improver-id> --request-id <request-id> --role improver`.

   The improver reads `.omp/agents/improver.md`, confirms it is online, and yields
   `IMPROVER STATUS: IDLE` until the orchestrator wakes it with the run directory. It is not
   waited on, and its yield is not the run finishing. If this spawn fails, continue: report
   the failure, and the orchestrator records `- [open] improver-absent` in `issues.md`.
5. Confirm the launch. A genuine orchestrator sets `run_dir` and `status: running` in
   `runs/.agents/<agent-id>.json` after intake and writes `runs/<run>/orchestrator.id`. It
   also sets `run_dir` on the improver's registry entry and wakes it once intake settles.
   Re-check at the first `/status` or `/request`; an orchestrator entry still `starting` with
   no `run_dir` means the wrong agent was spawned — mark it `failed`, relaunch with the
   explicit selector, and resubmit any pending requests.
6. If `--wait` was supplied, `wait` for the **orchestrator** agent and then
   `read agent://<orchestrator-id>`; report the final result, run directory and open issues.
   Do not wait on the improver.
7. Otherwise report both agent ids, the request id and "starting" status, and return. Tell the
   user they can submit `/request <new task>` while it runs and use `/status` to inspect
   progress. Do not wait.

If the orchestrator dispatch returns no agent id (for example because an older orchestrator is
still declared blocking), report that the async launch is unavailable and use `--wait`.

The pipeline handles research, analysis, automation, operations, data processing,
writing, documentation, and software changes. Code is one deliverable type, not
the default. Do not assume a repository, tests, or a diff.
