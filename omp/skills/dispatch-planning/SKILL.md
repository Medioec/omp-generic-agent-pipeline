---
name: dispatch-planning
description: Use when orchestrating a run — decompose the spec into units, write the dispatch plan and event log, schedule ready units by dependency, run them in git worktrees, finalize the run folder, and close it pending a human-triggered merge. Defines the DAG schema, scheduler loop, git workspace commands, replay checks, and the run/shared memory split.
---

# Dispatch planning

One model for every run. The `intake` control dispatch decomposes the spec and writes the plan; the orchestrator then dispatches whatever the dependency graph makes ready. A chain yields batches of one. Control dispatches do not appear in the plan.

Runs live at `<project>/runs/<run>/` and are untracked. The shared memory is a separate repo at `memory/`; the pipeline never writes it.

## 1. Plan

Write a fenced `json` block in `runs/<run>/spec.md` under `## Dispatch plan`:

```json
{
  "version": 1,
  "maxConcurrency": 8,
  "units": [
    { "id": "R1", "objective": "map write/read sets and risks",
      "deps": [], "acs": [], "reads": [], "writes": [], "resources": [] },
    { "id": "W1", "objective": "implement auth",
      "deps": ["R1"], "acs": ["AC1", "AC2"],
      "reads": ["src/core/"], "writes": ["src/auth/"], "resources": ["port:8101"] },
    { "id": "F1", "objective": "verify the whole spec on the integrated tree",
      "deps": ["W1"], "acs": ["*"], "reads": ["**"], "writes": [], "resources": [] }
  ]
}
```

- `deps` are approval edges: a predecessor must be `approved`, not merely returned.
- Add edges for artifact dependency, resource conflict, merge order or a decision dependency. **Do not** add edges for write overlap: git worktrees isolate writes.
- `reads` drives post-merge revalidation, not serialisation.
- `acs` partitions acceptance criteria; `"*"` is sink-only and means the whole spec.
- `writes` is advisory scope for the merge diff. `resources` are named stateful resources.
- Amendments are a new `version`; approved units carry forward only where their `acs`, `reads`, and `writes` are unaffected.
- An ad-hoc request is an amendment: one `## Addendum` per additive batch, new `AC<next>` ids assigned by `intake`, and a new plan version. Request ids live in the request files and `issues.md`, never as event-table rows or worker dispatch numbers.
- A change request reopens the affected units and voids sink approval; the sink re-runs on the amended integration tree.
- Planning belongs to the `intake` control dispatch. Control roles (`intake`, `plan-check`, `request-check`, `integrate`, `ops`, `close`) are never units in this JSON and own no acceptance criteria.

## 2. Event log

`runs/<run>/dispatch.md` is append-only:

```markdown
| seq | unit | event | dispatch | base | deps-at-dispatch | agent | note |
|-----|------|-------|----------|------|------------------|-------|------|
| 1 | R1 | dispatched | 1 | <sha> | — | ag_01 | config=<sha> |
| 2 | R1 | approved | 1 | | | | checks reproduced; advisor silent |
| 3 | W1 | dispatched | 2 | <sha> | R1=approved | ag_02 | config=<sha> |
```

Events: `dispatched`, `approved`, `revise`, `reopened`, `blocked`, `blocked-verification`, `skipped`. Write `dispatched` before the `task` call; write exactly one outcome after settlement. The free-text note cell carries `config=<short sha>`: the live project HEAD at dispatch time. It is not the worktree `base`; it is how the improver tells which prompt and skill versions a worker actually saw when passes are queued behind later commits.

Below the table, `## Dispatch metrics` carries one bullet per **settled** dispatch: `- <dispatch> <unit> <agent id> dur=<duration> tokens=<n> req=<n> rev=<n>`, with `—` for any field the dispatch result does not report — never an estimate. `rev` is the exception: it is the unit's re-dispatch count read off the event table (0 for a unit dispatched once), which the run always holds, so record it as a number — a run of `rev=—` bullets leaves no revision-rate baseline for any later comparison. It is the only cost record that survives a run (transcripts keep no durations or token counts), and `replay` rejects a settled dispatch with no bullet. An in-flight dispatch may be unmeasured; a settled one may not.

Improver passes are not worker dispatches. Record them only under `## Improver passes` as bullets; adding them to the event table or to `## Dispatch metrics` makes `replay` read them as worker dispatches. The section is append-only and carries the supervision lifecycle:

```text
- s1 woke trigger=intake scope=plan budget=small
- s1 settled commit=<sha|none> status=settled
- s2 woke trigger=burst scope=scheduling+cost budget=normal
- s2 settled commit=none status=partial deep=1
```

`<N>` is a supervision pass counter, not a worker dispatch number. The improver is a sibling woken by `agent://` message, not a subprocess you dispatch, so there is no `assigned`/`deferred` list. A metric bullet may appear after this section; `metricsEntries` skips the heading and keeps reading until the next unrelated `##` heading, so append order does not break `replay`.

Control dispatches are also not worker dispatches. Record them only under `## Control dispatches` as a table whose first column is `c<N>`; never put them in the event table or in `## Dispatch metrics`:

```markdown
| c | role | mode | target | agent | status | report |
|---|------|------|--------|-------|--------|--------|
| c1 | intake | setup | run | ag_01 | settled | control/c1-intake.md |
| c2 | plan-check | check | run | ag_02 | settled | control/c2-plan-check.md |
| c3 | integrate | merge | units | ag_03 | settled | control/c3-integrate.md |
```

`replay` ignores non-numeric first cells, so this section is invisible to the worker state machine. Control roles write their reports under `runs/<run>/control/`; the orchestrator owns `dispatch.md`.

The `dispatch` value is the **run-global ordinal of the `dispatched` rows**: 1, 2, 3, … with no gaps and no reuse. It is not a per-unit counter and not the `seq` of the row. Every `dispatched` row takes the next number — a new unit, a revision of a unit already run, and a reopen all take it. Outcome rows repeat the number of the dispatch they settle.

```
dispatch 1 = seq 1, R1 dispatched     # the run's first dispatch
dispatch 1 = seq 2, R1 approved       # outcome repeats its dispatch number
dispatch 2 = seq 3, W1 dispatched     # W1's first dispatch, but the run's second
dispatch 3 = seq 4, W1 dispatched     # a revision of W1 still takes the next run-global number
```

The rule is structural, not cosmetic: the number names `worker/round-N.md`, so a per-unit count makes `replay` look for a round file that was never written. Get it right at the first `dispatched` row; renumbering afterwards means renaming round files and annotating them, which leaves an audit trail that reads as if the evidence changed. `node scripts/dispatch-plan.mjs replay` rejects any other numbering.

An approval freezes the unit's artifacts. A later edit takes a `reopened` row plus its own `dispatched` row, the next run-global number, its own round file, and a re-check of every approved unit that consumed the old artifact. That holds for both transports: a fresh `task` and a correction delivered with `write agent://<id>` into a parked session are the same event on the record. Two post-approval corrections to one unit (a round-file fix and a corrected model-role row) once arrived over IRC, wrote no dispatch row, and left `dispatch.md` reporting that unit approved in a form it no longer had — while the same run's writer reopen (deliverable edited after sink approval) was logged and re-verified properly.

## 3. Scheduling loop

```
load plan; status = derived from dispatch.md
while unfinished:
    ready = units whose deps are all approved and status is pending/revise
    batch = []
    for u in ready in plan order:
        if |batch| + |in_flight| >= maxConcurrency: break
        if resources(u) intersects resources(batch ∪ in_flight): continue
        batch.append(u)
    if batch empty and in_flight empty and no control dispatch in flight:
        deadlock → record and halt
    append `dispatched` rows; send one `task` batch
    wait for an event: a worker settlement, a control settlement, an improver report, or a request wake
    worker settlement → read the round file and advisor notes, append outcome and metrics, wake the
                        improver if a trigger fired; approved units wait for integrate
    control settlement → read its `control/c<N>-*.md` report and act on it
    improver report → record the settled pass, revalidate the tooling if it committed, continue
    recompute
```

A `STALLED` marker becomes `blocked`; dependents wait. Increment rounds keep the same unit in flight; dependents wait for the completion round. Approval is a claim-level decision: the orchestrator reads the round file and the advisor's blockers, ties each completion claim to a named command and an observed result, and never reproduces a check.

When every non-sink unit is approved, dispatch `integrate` before the sink. A control dispatch is not a plan unit and never makes a dependent ready.

The improver runs as a sibling supervisor launched by `/pipeline`, not as a dispatch. Wake it with `write agent://<improver-id>` on these triggers only: intake and plan-check settled (`intake`), any control failure (`control-failed`), every third settled dispatch or any second revise/stall (`burst`), an amendment's plan-check (`request-amend`), and sink approval (`sink-approved`, deep). One wake outstanding at a time; never wait on it while a unit is ready or a worker is in flight. It replies `settled s<N> commit=<sha|none> status=<settled|partial> deep=<0|1>` and yields `IMPROVER STATUS: IDLE`. See `orchestrator` §"Improver supervision (sibling)" for the payload, constraints, stall handling and drain.

### Dispatch payload

Quote the acceptance criteria from `spec.md`'s `## Acceptance criteria` section **verbatim**; never restate them from the "Original request" prose and never from memory. The two can differ, and the difference is the whole test: the original request once said "short notes" while AC1 said "a short note for each row", the writer's dispatch carried "presence/absence + notes", the matrix shipped with 136 of 186 notes empty, the orchestrator approved on the writer's own summary, and only the sink failed AC1 — a writer reopen plus a second sink pass.

A quantifier ("each row", "every command", "all N") is the part of a criterion a verifier can count. A paraphrase that drops one leaves prose the worker cannot fail and the orchestrator cannot check. When a later dispatch states the criterion more sharply ("Zero matrix rows with an empty Note", dispatch 8), the sharper form belonged in the first dispatch.

Carry only criteria the spec can settle. A number the intake worker invents — a word count, a length band, a page budget — is not an acceptance criterion: no unit owns it, the orchestrator must ignore it, and an early blocker that enforces it buys rewrite passes. A payload once asked for "roughly 9,000–12,000 words" and 250–400 words per section while the spec's own mandated structure (sixteen sections, three generated tables, a 313-row appendix) made both unsatisfiable: the writer rewrote three part files four times to hit the band and shipped 14,981 words against the aim. If a length or budget really binds, write it into the spec as an AC with its measurement rule, and derive it from the mandated elements first.

## 4. Git workspaces

```
runs/<run>/workspace/
  base.sha              # project commit the run started from
  main.branch
  units/<id>/           # git worktree, branch run/<slug>/<id>
  integration/          # worktree, branch run/<slug>/integration
  patches/<id>.patch    # merge artifact
  deliverable.sha
```

Command ownership is role-based. The orchestrator runs none of these:

| Role | Commands |
|---|---|
| `intake` | `init`, `new-unit` (every unit), `bootstrap.mjs --check` |
| `integrate` | `check-live`, `diff-unit`, `merge-units`, `integration`, `resolve-unit`, `sync-main`, `replay` |
| `ops` | `check-live`, `replay`, `validate-omp-pipeline`, `status`, `git restore`/`git revert` for a named failure |
| `close` | `check-live`, `replay`, `commit`, `finalize-run.mjs` |

Helper commands (from the project root):

```
bash scripts/workspace.sh init         runs/<run>
bash scripts/workspace.sh new-unit     runs/<run> W1
bash scripts/workspace.sh diff-unit    runs/<run> W1
bash scripts/workspace.sh resolve-unit runs/<run> W1
bash scripts/workspace.sh merge-units  runs/<run> W1 W2
bash scripts/workspace.sh integration  runs/<run>
bash scripts/workspace.sh check-live   runs/<run> [--ignore <path>]...
bash scripts/workspace.sh sync-main    runs/<run>
bash scripts/workspace.sh commit       runs/<run>
bash scripts/workspace.sh cleanup      runs/<run>
```

The project must already be its own git repo with a clean commit: `init` refuses a dirty tree, and `node scripts/bootstrap.mjs --check` proves the prerequisite.

- `new-unit` branches from `base.sha`. `merge-units` merges approved branches into `run/<slug>/integration`.
- `diff-unit` commits the unit worktree and writes its patch; `integrate` runs it for every approved worktree unit before `merge-units`. A unit whose work was never committed has nothing to merge.
- A conflict stops the merge before that unit is accepted. The `integrate` role runs `resolve-unit`, the owning unit resolves in its re-based worktree, then `integrate` runs `diff-unit` and `merge-units` again.
- `implement` and `sink` run commands with the worktree as cwd. The project tree must stay clean (`check-live`); a dirty tree is a failed dispatch. While an improver pass is in flight, the check uses `check-live runs/<run> --ignore .omp --ignore scripts`: those are its declared edit paths. Any other dirty path still fails. Run the full check when no pass is in flight, after every pass settles, and at drain.
- `commit` merges integration into the project's main branch and writes `deliverable.sha`. Mid-run improver commits advance main, so the final merge can conflict. On conflict, run `sync-main`: it merges `main` into the integration worktree and leaves a real conflict for resolution there; then run `commit` again. `sync-main` refuses a dirty integration worktree.
- Advisors review the unit worktree and diff, or `integration/` for the sink — never the live project tree.

## 5. Finalize

After the sink is approved:

1. **Drain the improver.** Ensure the `sink-approved` pass has run and settled. If a wake is outstanding, wait for its report; never kill it. If it does not report by the next event, record `- [open] improver-stalled s<N>`, dispatch `ops mode: recover`, and continue; the verdict is not gated on an improver pass. Do not run a post-finalize pass.
2. **Write the verdict.** The orchestrator alone writes `runs/<run>/verdict.md`, including the `OBJECTIVES:` line.
3. **Dispatch `close`.** It runs `bash scripts/workspace.sh check-live runs/<run>`, `node scripts/dispatch-plan.mjs replay runs/<run>`, `bash scripts/workspace.sh commit runs/<run>` (writing runs only), and `node scripts/finalize-run.mjs runs/<run>`.
   - If `commit` conflicts with mid-run pipeline commits, the orchestrator dispatches `integrate mode: sync-main`; the conflict is resolved in the integration worktree, then `close` retries.
   - `finalize-run.mjs` requires `verdict.md` with `OUTCOME: APPROVED`; it stamps `summary.md` (first line `OUTCOME: PENDING`) to APPROVED, validates `delta/*.json` and evidence pointers, and writes `manifest.json` with `project_commit`, `deliverable_commit`, `memory_commit`, `status: pending-merge` (or `closed` with `memory_impact: none`).
4. Each improver pass commits as `pipeline: <slug> s<N>`. The sink-approved pass is the run's final improvement record; there is no post-finalize pass. It never writes `memory/**`. Once `manifest.json` exists the run is closed: never wake the improver again.

The shared memory is written only by a human-triggered merge skill.

## 6. Checks

```
node scripts/dispatch-plan.mjs validate runs/<run>/spec.md
node scripts/dispatch-plan.mjs replay   runs/<run>
bash scripts/workspace.sh check-live    runs/<run>
# while a pass is in flight, scope the live check:
bash scripts/workspace.sh check-live    runs/<run> --ignore .omp --ignore scripts
git -C memory status --porcelain            # must be empty
```

Validation rejects cycles, duplicate ids, double-owned ACs, a wildcard on a non-sink, and unreachable sinks. It does **not** catch an AC the spec enumerates that no unit owns: that half of the AC-coverage check is skipped whenever any unit declares `"*"` (the `if (!wildcard && specAcs.length)` branch of `validatePlan` in `scripts/dispatch-plan.mjs`), and the standard sink always declares `"*"` (§1), so the skip is the normal case. A green `validate` proves nothing about AC coverage: `plan-check` must compare the spec's AC ids against the plan's `acs` arrays by hand and record that comparison, and nobody may cite validator PASS as coverage evidence. Replay rejects a dispatch before deps were approved, concurrent units sharing a resource, a terminal event without a dispatch, approval on an increment, and invalid reopen. Replay runs at `integrate` (before the sink) and at `close`; there is no per-settlement audit.

## 7. Prior-run lookup

If the memory repo lacks or lags, search `runs/*/summary.md`, `runs/*/delta/facts.json`, `runs/*/report.md`, `runs/*/scratch/`; cite run and artifact in the round file and in any dependent claim. Treat an unmerged prior-run claim as evidence at its stated grade, not as verified memory truth. Never edit the memory repo; record contradictions in `delta/corrections.json`.

## 8. Failure and resume

- Worktrees and branches are the durable state; `dispatch.md` is the scheduling record.
- `in_flight` with a complete round file → evaluate it; otherwise re-dispatch (attempt+1).
- A blocked unit never unblocks automatically; re-plan as a new version or halt with the blocker in `issues.md`.
- `git worktree remove --force` only after the branch is merged or superseded; branches remain for inspection.

### Premature termination

After every worker settlement and every improver report, validate the settlement: no infrastructure error; the closing marker (`WORKER STATUS: DONE|STALLED round=<N>`, `IMPROVER STATUS: IDLE`); the expected artifact (round file with `## Completion` or `## Stall Report`; `improvement.md` with one `## Supervision s<N>` section plus a pass trailer; `verdict.md` when the run closes); no unresolved advisor blocker.

A pass without a reply line or trailer is a force-stop, not a worker failure. Dispatch `ops mode: recover` before re-waking; it reports `git status --porcelain`, the last `pipeline: <slug> s<N>` commit, the sections and the trailer. A dirty tree means uncommitted work; a clean tree with a pass commit means the work is applied even without the trailer.

On failure, resume the session first — `write agent://<id>` with a self-sufficient continuation: for a worker, role, run, unit, dispatch, workspace and round-file paths; for an improver pass, role, run directory, the pass number and scope, `improvement.md`, the trailer, the frozen live-run paths, and the orchestrator id to reply to. Then `wait`. Fall back to a fresh instance only when no id exists, the continuation errors, or the resumed session terminates again, and give it disk-based instructions. Log `- [open] infra-failure <role> (<reason>)` and flip it to resolved on completion. Only the human reattaches a dead improver (`/improver --run <run>`); worker dispatches keep no attempt limit.

### Interrupted run

Trigger: the user asks to resume `<slug>`, or a run folder has `manifest.json` missing and no verdict. Dispatch `ops mode: recover` and adopt its report:

1. `ops` reads `spec.md`, `dispatch.md`, `issues.md` and returns the derived unit states.
2. `in_flight` with a complete round file → evaluate it; otherwise re-dispatch (attempt+1), honouring deps.
3. Dispatch every ready unit.
4. All non-sink units approved but no integration → dispatch `integrate`, then the sink.
5. If `manifest.json` exists, the run is closed: never wake the improver; report the final pass list. Otherwise, `ops` reconstructs the supervision state from `## Improver passes` and the sections in `improvement.md`: a `woke` bullet with no `settled` bullet is an outstanding wake; a pass with a commit but no trailer is accepted as applied. Then tell the human to run `/improver --run <run>` when `agent://` no longer resolves the improver, and resume waking it at the next trigger when it does.
6. Sink approved and no `verdict.md` → drain, write the verdict, then dispatch `close`; `verdict.md` present and no `manifest.json` → drain, then dispatch `close`.
7. Everything present → report pending-merge.
