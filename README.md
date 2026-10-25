# omp pipeline

A portable setup for omp's general-purpose agent pipeline: the orchestrator is a
dispatcher that delegates every command and artifact to worker control roles and units,
workers implement in git worktrees, an early-blocker advisor reviews live, a sink verifies the whole spec,
an improver supervises the pipeline alongside the run, and the run closes pending a
human-triggered merge into the shared-memory repo.

## Requirements

| Tool | Minimum | Used for |
|---|---|---|
| `bin/omp` | bundled, ~245 MB (Linux x86-64, glibc) | the harness itself |
| Node.js | 18 | every script under `scripts/` |
| git | 2.5 (`2.28+` recommended) | worktrees, run history, memory |
| bash + coreutils | bash 3.2 | `scripts/workspace.sh` (`realpath`, `grep`, …) |
| python3 | 3.7 | optional: `skill://llm-wiki` |
| model backend | reachable from the machine | agent inference |

The bundled binary is Linux x86-64 and dynamically linked against glibc. On any other
platform, put a build for that platform at `bin/omp`; nothing else changes.

## Setup

One step, then verify:

```bash
bash install.sh          # prerequisite checks, install bin/omp, run bootstrap
bash install.sh --check  # report only; writes nothing
```

`install.sh` checks node ≥ 18, git ≥ 2.5, bash, coreutils and the platform, installs the
bundled `bin/omp` to `~/.local/bin` (override with `--prefix <dir>`), then runs
`node scripts/bootstrap.mjs` and its `--check`.

Manual equivalent:

1. Copy this whole folder to the new machine. Keep `bin/omp` (~245 MB) — it is
   git-ignored on purpose, so a `git clone` alone does not carry it; after a clone,
   `mkdir -p bin` and drop a build for that platform at `bin/omp`.
2. Restore modes if the copy dropped them:

   ```bash
   chmod +x bin/omp scripts/workspace.sh
   ```

3. Create the local state (idempotent; safe to re-run):

   ```bash
   node scripts/bootstrap.mjs
   ```

   It initialises the project git repository and its first commit, writes the managed
   `.gitignore` lines, creates the `memory/` repo (`index.md`, `README.md`,
   `decisions.md`, `facts/`, `evidence/`), creates `runs/`, and sets a repo-local git
   identity (`omp-pipeline <pipeline@localhost>`) only when none is configured.

4. Verify:

   ```bash
   node scripts/bootstrap.mjs --check   # must print "bootstrap check: ok"
   ./bin/omp --version
   ```

5. Start omp **from this directory** so it picks up `.omp/` (agents, skills, commands,
   WATCHDOG, policy extension):

   ```bash
   ./bin/omp
   ```

## OBJECTIVE.md

`OBJECTIVE.md` at the project root is human-owned; every pipeline agent is instructed
never to write, replace, rename, or delete it. There is no technical enforcement.
It ships as a blank template with section headings and no content; fill in the project's
objectives in any format you like.

- The `intake` worker copies the file to `runs/<run>/objective.snapshot.md` at run start
  and writes a prose `## Objective alignment` in the spec.
- The sink writes a free-form `## Objective check` quoting the objective text it used;
  the verdict carries an `OBJECTIVES:` summary line.
- If the file is blank or missing, agents fall back to the original request and the
  run's acceptance criteria. Nothing halts and nothing is parsed.
- Mid-run edits do not affect the current run; the next run picks them up.

## First run

```
/pipeline <task>
```

`/pipeline` is asynchronous by default. It starts **two** agents in the background — the
`orchestrator` and its sibling `improver` — records both under `runs/.agents/`, reports their
ids, and returns. The orchestrator never spawns the improver; it wakes it with an `agent://`
message at run milestones. Use:

```
/status                 # progress of running agents
/request <new task>     # add work to a live run
/wait                   # wait for an agent started in this session
/pipeline <task> --wait # old synchronous behavior
```

The run writes `runs/<date>-<slug>/` (`spec.md`, `issues.md`, `dispatch.md`,
`objective.snapshot.md`, `worker/round-N.md`, `control/cN-*.md`, `improvement.md`,
`summary.md`, `delta/*.json`, `verdict.md`, `manifest.json`). The orchestrator writes
`dispatch.md`, `issues.md`, `verdict.md`, its registry and `orchestrator.id`, request
status fields, and the new-run queue. Work happens in `runs/<run>/workspace/`; the live
project tree stays clean outside an in-flight improver pass.

Control roles run on the `worker` agent: `intake` builds the run and the plan,
`plan-check` validates it, `request-check` classifies ad-hoc requests, `integrate`
commits and merges unit worktrees, `ops` handles stalls, recovery and revalidation, and
`close` commits the deliverable and finalizes. The orchestrator runs no commands itself.

## Ad-hoc requests

A request is a durable JSON file, not just a message:

- `runs/<run>/requests/<id>.json` after intake;
- `runs/.requests/<id>.json` before the run directory exists.

`/request` writes the file and sends the orchestrator a one-line wake. The one-command form
generates the id, writes `runs/.requests/<id>.request.md`, submits the request, and prints
the wake line with the durable record path:

```bash
node scripts/requests.mjs add --run runs/<run> --text "<request>" --kind additive
```

The orchestrator drains the inbox on every event, so a lost wake is harmless. Only a user or
command may submit; workers and the improver are denied by policy. The orchestrator may run
only `requests.mjs claim|ack|list` and `dispatch-plan.mjs validate` itself; everything else
is a worker dispatch.

The wake carries the request id and the durable record path, so the recipient must really be
the orchestrator: dispatch it with `agent: "orchestrator"` and register it with
`--role orchestrator`. The registry stores the role and `submit` refuses any other agent; a
generic `task` subagent never loads the request protocol and ignores the wake line.

Cutoffs:

- additive and change requests are accepted while the sink is not yet approved;
- additive batches are combined into one addendum and one plan version;
- a change stops affected in-flight units, reopens approved work, and voids the sink;
- after the sink approves but before the verdict, requests are queued as a new run;
- after the verdict, the run is closed to requests.

There is no hard cancel. `STOP request=<id>` asks a worker to finish its current atomic
step and report; the human can use the Agent Hub for an immediate stop. If `/request`
cannot resolve a live agent id, message the orchestrator through the Agent Hub; the
durable request file remains the source of truth.

The new-run queue is `runs/.queue/`. Parallel pipelines remain unsupported in one project
directory; start queued work after the current run closes.

The pipeline is non-interactive: anything it needs from you is recorded as `[open]` in
the run's `issues.md`.

The improver is a sibling supervisor, not a subagent of the orchestrator and not part of
the plan. `/pipeline` starts it; the orchestrator wakes it with an `agent://` message on a
small set of triggers — intake settled, a control failure, a revision burst or stall, an
amendment, and sink approval (a deep pass). It audits the pipeline as a whole: plan quality,
scheduling and batching, the orchestrator's own dispatch discipline, the control roles, the
request channel, cost, and defects that recur across runs. Worker/advisor dynamics are one
lens among those, not the frame.

One pass runs at a time and never delays a worker. Each pass appends one
`## Supervision s<N>` section to the run's `improvement.md`, writes a pass trailer, commits
validated pipeline changes as `pipeline: <slug> s<N>`, and replies
`settled s<N> commit=<sha|none> status=<settled|partial> deep=<0|1>`. Anything that needs a
human decision — policy, blast radius, identity, objective — becomes a proposal in the
committed `.omp/pipeline-backlog.md`, which survives the run. Mid-run passes may change
prompts, skills, WATCHDOG, config and non-critical tooling; the validator, tests, policy gate
and workspace/scheduler scripts stay frozen. There is no end-of-run or post-finalize pass.

If the improver is lost, `runs/.agents/` shows the entry and `/improver --run <run>`
reattaches a fresh one; the orchestrator records `- [open] improver-stalled` or
`improver-absent` and continues without it. The verdict never depends on an improver pass.

## Shared memory

`memory/` is a separate git repository holding facts, decisions and merged evidence. The
pipeline never writes it. After a run reaches `pending-merge`:

```
/merge
```

That is human-triggered and follows `skill://merge-runs`: validate, plan, edit on a
branch, copy evidence, verify, commit, then let you merge.

## Checks

```bash
node scripts/bootstrap.mjs --check
node scripts/validate-omp-pipeline.mjs
node --test scripts/test-pipeline-policy.mjs
node --test scripts/test-dispatch-plan.mjs
node --test scripts/test-requests.mjs
node --test scripts/test-merge-runs.mjs
node --test scripts/test-bootstrap.mjs
node --test scripts/test-workspace.mjs
```

## Offline use

Everything in this folder is offline: the scripts use Node built-ins only, git works
without remotes, and there is no package install step. The single network dependency is
model inference — point omp at a local endpoint (or an on-LAN model) and the pipeline
runs with no internet. Research runs additionally need their sources reachable.

## Troubleshooting

- `node: command not found` — install Node.js ≥ 18; no npm step is needed.
- `not a git repository` / `project is inside another repository` — run bootstrap from
  this folder and make sure it is not nested inside another git repo.
- `project tree is dirty` — commit or stash; `workspace.sh init` requires a clean tree.
- `deliverable merge conflict` — a mid-run improver commit touched a file the deliverable also changed; run `bash scripts/workspace.sh sync-main runs/<run>`, resolve in the integration worktree, then retry `commit`.
- `improver-stalled` / `improver-absent` in `issues.md` — the supervisor is gone; the run continues. Read `runs/.agents/` and run `/improver --run <run>` to reattach one.
- `bin/omp: cannot execute` — wrong architecture or missing glibc; replace the binary
  with one built for this machine.
- Start over: delete `.git`, `memory/` and `runs/`, then run step 3 again.
