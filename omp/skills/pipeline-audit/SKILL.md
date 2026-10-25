---
name: pipeline-audit
description: Use on an improver supervision pass — the audit lenses, evidence method, cost formulas, cross-run mining, and backlog format for judging the pipeline as a whole (plan, scheduler, orchestrator, control roles, requests, cost, recurrence) rather than a single worker dispatch.
---

# Pipeline audit

One pass, one scope, one commit. The wake names the scope and budget; this skill says what to
look at, how to prove it, and how to record it. Read `skill://run-forensics` for transcript and
cost extraction.

## Budgets

| budget | Lenses | Reads |
|---|---|---|
| `small` | the named scope only | `dispatch.md`, `issues.md`, the relevant control reports or round files |
| `normal` | the named scope over the whole run | all of the above plus `spec.md`, all round files in scope, `improvement.md`, metrics |
| `deep` | all lenses, all passes, cross-run | plus prior `runs/*` evidence, the backlog, targeted `history://` transcripts |

A pass that finishes early is not a defect. A pass that claims a lens it did not read is.

## Lenses

### Plan (intake, plan-check, amendments)

- An acceptance criterion no unit owns, or one a worker cannot test.
- A criterion invented from the dispatch or a length band the spec never stated — the failure
  that buys rewrite passes.
- A paraphrase of the original request that drops a quantifier ("each row", "all N").
- Unit granularity: a unit whose criteria are the whole spec, or a unit too small to settle.
- Missing dependency edges (artifact, resource, merge order); write-overlap edges that should not
  exist.
- Plan-check PASS on a spec with an untraceable AC, or a FAIL that names a defect the spec does
  not have.
- Amendment scope: an `additive` batch that changes an approved artifact, or a `change` that
  reopens more than it must.

### Scheduling (dispatch model, readiness, batching)

- Independent units serialized: two `dispatched` rows that could have shared one `tasks[]` batch.
- A chain wider than its dependency graph.
- `resources` collisions at merge, or units that shared a resource but were batched together.
- Deadlock halts, readiness recomputed after a control settlement, a ready unit held by a
  triage, or by an improver wake (the second is a pipeline bug, not a scheduling choice).
- Revision storms: the same unit dispatched 3+ times without a changed signal.

### Orchestrator (your dispatcher)

- A dispatch payload missing the verbatim AC text, the objective snapshot, or the revision
  checklist.
- Approving on an increment round, approving a completion whose claims carry no command and no
  observed result, or reproducing a check instead of reading the round file and the advisor's
  blockers.
- `STOP` not sent to affected in-flight work on a change request; a stale settlement approved.
- Record defects: a settled dispatch with no `## Dispatch metrics` bullet, a `config=` value that
  is not the last committed HEAD, a control dispatch in the event table.
- Wake discipline: two outstanding improver wakes, a wake for an ordinary approval, or a `wait`
  on the improver while a unit is ready.

### Controls (intake, plan-check, request-check, integrate, ops, close)

- `CONTROL STATUS: FAILED` and the recovery that followed: was the same defect repaired twice?
- A command reported as run with no output quoted, or output that cannot come from that command.
- `ops revalidate` after an improver pass that did not actually restore the tooling.
- `close` finalizing with an unapproved unit, or after a lost improver pass.
- Request triage that misclassified, or a `new-run` queue entry with no origin.

### Requests

- Classification versus the actual scope change.
- Amendment cast as a new run, or a change folded into an additive batch.
- Cutoff violations around sink approval and the verdict.
- A request acknowledged `done` before its units were approved and the sink re-verified.

### Cost

Use `## Dispatch metrics` (`dur`, `tokens`, `req`, `rev`) and the controls' reports. Never
estimate a field the run did not record; write `—`.

- **Per unit**: dispatches, total requests, total tokens, elapsed, revisions.
- **Share of run**: one unit's tokens over the run total, and what it bought.
- **Redundancy**: repeated reads, re-derived facts, validators re-run with nothing changed,
  whole-corpus reads where a range or digest would do. Count occurrences from the rendered calls
  (`skill://run-forensics` §"Cost accounting").
- **Baseline → saving**: every efficiency proposal states the measured baseline (dispatch, unit,
  number) and the expected saving in the same unit. A saving that removes a check is rejected.

### Recurrence

A signal that appears twice in this run, or in a prior run's log, or in a backlog proposal, is
the strongest evidence available. Before writing a proposal, search `runs/*/improvement.md`,
`runs/*/issues.md` and `.omp/pipeline-backlog.md` for the same category. If it recurred, say so
with the earlier run id and pass; if a proposal already covers it, extend that proposal instead
of adding a duplicate.

## Recording

`runs/<run>/improvement.md`:

```markdown
## Supervision s3 — burst

- scope: scheduling + cost; budget: normal
- evidence: dispatch.md rows 12-19, metrics bullets 12-19, worker/round-14.md, c4-integrate.md
- signal: W2 and W3 were dispatched in separate batches although both were ready and share no resource (dispatch 14, 16; metrics dur 4m10s + 3m55s).
- change: none — proposal p-004 covers the batching rule in `dispatch-planning` §3.
- cost: W3 31k tokens over 2 dispatches, one revise on a criterion AC4 already covered by W2.
- validation: not-run (no change)
- pre_commit: <sha>; pipeline_commit: none
```

Trailer, after the sections:

```html
<!-- improver-pass: s3 trigger=burst scope=scheduling+cost examined=plan,scheduling commit=<sha|none> status=settled -->
```

`.omp/pipeline-backlog.md` entry:

```markdown
- [open] p-004 Batch-ready units that share no resource — evidence: runs/<run>#s3 dispatch 14 vs 16; gain: one batch instead of two, ~8 min; risk: scheduler skill edit only.
```

## Boundaries

- Never re-judge an approved unit or move an in-flight criterion.
- Frozen for the run: `scripts/workspace.sh`, `scripts/dispatch-plan.mjs`,
  `scripts/finalize-run.mjs`, `scripts/validate-omp-pipeline.mjs`, `scripts/test-*.mjs`,
  `scripts/requests.mjs`, `.omp/extensions/pipeline-policy/**`.
- Policy, blast-radius, identity and objective changes are proposals, never applied.
