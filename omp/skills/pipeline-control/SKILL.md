---
name: pipeline-control
description: Use on a worker control dispatch (intake, plan-check, integrate, ops, close) — run the setup, validation, merge, recovery or finalize step the orchestrator cannot run itself, and write a control report.
---

# Pipeline control roles

The orchestrator dispatches one control role per step. Control roles are not plan units: they own no acceptance criteria, take no worker dispatch number, and never appear in the event table or `## Dispatch metrics`. They exist so every command and every artifact-producing step has a worker owner.

## Common contract

- Read the dispatch payload first. It names `role`, `mode`, the run directory, the report path (`runs/<run>/control/c<N>-<role>.md`), and the paths or units in scope.
- Write the report to that path. End it with `CONTROL STATUS: DONE` or `CONTROL STATUS: FAILED`.
- State every command and its actual output. A command that failed is reported as failed; never retry a variant, never disguise a path, and never claim a check you did not run.
- Write only the run artifacts your role owns: `intake` owns the initial `spec.md`, `issues.md` and `dispatch.md` header; `close` owns the finalize output; every role writes its own `control/**` report. No control role writes `verdict.md`, `memory/**`, `runs/*/requests/**`, `runs/.requests/**`, `runs/.agents/**`, or `runs/.queue/**`; request and registry files are user/orchestrator-owned.
- Never spawn a subagent or ask the user a question.
- `OBJECTIVE.md` at the project root is human-owned. Never write, replace, rename, or delete it. A blank or missing file is not an error; use the original request and acceptance criteria.

## `intake`

Modes: `setup`, `amend`.

1. `node scripts/bootstrap.mjs --check`; on any gap run `node scripts/bootstrap.mjs` and carry its output into `issues.md`.
2. Create `runs/<YYYY-MM-DD>-<kebab-slug>/`, appending `-2`, `-3` if taken.
3. Write `spec.md`:
   - a verbatim "Original request";
   - objective, scope, testable acceptance criteria, out-of-scope notes;
   - `work_type`, `deliverable`, `verification_mode`, `evidence_required`, `environment`;
   - derived quantities: run the measurement and quote its output in the report before a byte, character or line count enters a criterion or `evidence_required` — `printf 'shipped\nreviewed\n' | wc -c` is the check, not a mental sum; a draft value that disagreed with the measurement is a `[open]` row in `issues.md`, never a silent correction;
   - `## Objective alignment`: prose quoting the substantive parts of `OBJECTIVE.md`, what this run advances and what it leaves untouched, or a statement that none was supplied;
   - `## Dispatch plan`: a fenced `json` block with `version`, `maxConcurrency`, and `units`.
4. Plan rules: one owner per acceptance criterion; `acs: ["*"]` only on the unique sink; `deps` only for artifact dependency, resource conflict, merge order or a decision dependency; no write-overlap edges.
5. Read `OBJECTIVE.md`; if present, copy it byte-for-byte to `runs/<run>/objective.snapshot.md`. If missing or blank, record `- [open] objective-missing` or `- [open] objective-blank`.
6. Initialize `issues.md` and the `dispatch.md` header: event table, `## Dispatch metrics`, `## Improver passes`, `## Control dispatches`.
7. Validate with `node scripts/dispatch-plan.mjs validate runs/<run>/spec.md`.
8. For writing runs, `bash scripts/workspace.sh init runs/<run>` and `bash scripts/workspace.sh new-unit runs/<run> <unit>` for every unit.
9. Record `project_commit` (`git rev-parse HEAD`) and `memory_commit` (`git -C memory rev-parse HEAD`) in `spec.md`.
10. `amend`: write plan `version: N+1`, carry approved units forward only where their `acs`, `reads`, and `writes` are unaffected, create worktrees for new units, revalidate.
11. For an ad-hoc request, write `## Addendum <n> — requests <ids>` with the verbatim requests, add new `AC<next>` IDs and units to the plan, record the request ids in the spec, and update `## Objective alignment` if needed. Create `runs/<run>/requests/` with `mkdir -p` if it is missing.

Report the run directory, plan result, commits, worktree paths, objective state, and issues. A validation failure is `CONTROL STATUS: FAILED` with the validator output; do not dispatch anything.

## `plan-check`

Read the original request, `spec.md`, its plan, and `objective.snapshot.md`. Run `node scripts/dispatch-plan.mjs validate runs/<run>/spec.md`.

Check:

- every acceptance criterion is traceable to the request and testable;
- each is owned exactly once, and the sink owns `"*"`;
- no number, word band or page budget was invented that the spec does not state;
- the plan is acyclic and every unit reaches the sink;
- `## Objective alignment` does not contradict the request;
- for an addendum, existing AC text is unchanged on an `additive` batch; a changed AC is a `change` tied to a reopened unit;
- control roles are absent from the plan.

Report PASS or FAIL with numbered defects. Do not edit the run.

## `request-check`

Mode: `triage`.

Read the request files named in the dispatch, `spec.md`, `dispatch.md`, the unit states, and the sink state. Classify each request or batch:

- `additive`: new ACs/units only; no existing AC, approved artifact, or unit read/write set changes.
- `change`: an existing AC, approved artifact, or read set changes; affected units reopen and the sink re-runs.
- `new-run`: unrelated, alters the original request, too large, or arrives after the amendment cutoff.
- `mixed`: the batch contains more than one kind. Return `per_request` so the orchestrator can process changes first and batch the additive remainder.

Return impacted ACs/units/reads/writes, whether sink approval is void, and a proposed amendment outline. End with a JSON block (`requests`, `classification`, `per_request`, `impact`, `sink_void`, `proposed`, `rejections`) and `CONTROL STATUS: DONE|FAILED`. Propose AC ids; do not allocate them and do not edit the run.

## `integrate`

Modes: `merge`, `resolve`, `sync-main`. Composition only; do not judge the deliverable.

### `merge`

1. `bash scripts/workspace.sh check-live runs/<run>`.
2. `node scripts/dispatch-plan.mjs replay runs/<run>`.
3. For each approved unit with a worktree: `bash scripts/workspace.sh diff-unit runs/<run> <unit>`, then `bash scripts/workspace.sh merge-units runs/<run> <unit>`.
4. `bash scripts/workspace.sh integration runs/<run>`.
5. Report merged units, patch paths, the integration sha, conflicts, and the approved units whose `reads` intersect the merged changed paths.

`diff-unit` commits the worker's worktree and writes `patches/<unit>.patch`; without it there is nothing to merge. `merge-units` aborts on conflict without marking the unit accepted. Never force.

### `resolve`

`bash scripts/workspace.sh resolve-unit runs/<run> <unit>`. Report whether the patch re-based cleanly or needs resolution, then re-run `diff-unit` and `merge-units`.

### `sync-main`

`bash scripts/workspace.sh sync-main runs/<run>`. Report the conflict paths; do not resolve a semantic conflict yourself unless the dispatch names the owning unit and asks for it.

## `ops`

Modes: `diagnose`, `recover`, `revalidate`, `restore`.

- `diagnose`: read the stall report, spec and relevant memory entries. Return a strategy proposal: narrow, re-scope, split, change approach, or accept the blocker. Do not edit the deliverable.
- `recover`: reconstruct from disk with `git status --porcelain`, `git log --grep "pipeline: <slug> s<N>"`, `improvement.md` sections and trailer, `## Improver passes` bullets, and `dispatch.md` rows. Report derived unit states, the improver's outstanding wake and last settled pass, outstanding work, and whether the tree is dirty. Never assume a partial state.
- `revalidate` (given the improver pass number): `node scripts/validate-omp-pipeline.mjs`; when the run has a workspace, also `bash scripts/workspace.sh check-live runs/<run>` and `bash scripts/workspace.sh status runs/<run>`. If the pass changed non-frozen `scripts/**`, run the full suite. Run `node scripts/dispatch-plan.mjs replay runs/<run>` only on a **settled** log: replay rejects a log whose last state is `in_flight` (`scripts/dispatch-plan.mjs:470`), and an improver pass triggered at `intake` necessarily lands with the first unit dispatched — that FAIL describes the run's schedule, not the pass. With a unit in flight, record `replay: deferred (<unit> in flight)` as an outstanding item, never as a control failure; `integrate` step 2 and `close` step 1 run the same replay on the settled log, so nothing is waived. On a failure that is the pass's own, `git revert --no-edit <sha>` or restore the touched paths and report it; never revert for a failure that predates the pass or that the schedule explains.
- `restore`: restore the live tree to the recorded state. Never touch a deliverable.

## `close`

1. `node scripts/dispatch-plan.mjs replay runs/<run>`.
2. Writing runs (`runs/<run>/workspace/base.sha` exists): `bash scripts/workspace.sh check-live runs/<run>` and `bash scripts/workspace.sh commit runs/<run>`. On conflict, stop and report; the orchestrator runs `integrate mode: sync-main`, has the owning unit resolve, then re-dispatches close.
3. `node scripts/finalize-run.mjs runs/<run>`.

Report the deliverable sha, manifest status (`pending-merge` or `closed`), and any failure. Do not edit `verdict.md`, `summary.md`, or the deliverable; `finalize-run.mjs` stamps the summary.
