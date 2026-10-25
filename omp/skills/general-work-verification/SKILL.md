---
name: general-work-verification
description: Use when verifying research, automation, operations, data, writing, or mixed deliverables. Defines the evidence and checks appropriate to each work type, and when not to demand code-centric verification.
---

# Verification by work type

The pipeline is general-purpose. Code is one work type, not the default. Choose checks from the declared `work_type` and `verification_mode`, not from habit.

| Work type | Evidence | Required checks |
|---|---|---|
| research | saved sources, search dumps, source snapshots, citation map | per-claim citations, completeness sweep, link resolution, honest empty-category reporting |
| automation | dry-run output, command logs, before/after state, failure output | rerun, idempotency, failure handling, rollback, observability |
| operations | pre/post state, service logs, config snapshots, runbook | preconditions, blast radius, rollback, observability, access/safety |
| data | schema, row counts, checksums, sample rows, query output | null/duplicate checks, sampling, reproducibility, boundary cases |
| writing | source notes, fact-check artifacts, outline, audience note | factual consistency, unsupported claims, structure, audience |
| software | diff, build/test/lint output, runtime evidence | correctness, boundary cases, regressions, security basics |
| mixed | evidence for each portion | apply each relevant standard; do not let one modality hide another |

## Rules

- Do not demand tests for a research report or a diff for an automation/operations change.
- Do not accept a code-only check as completeness for a mixed deliverable.
- A claim with no saved artifact is provisional at best.
- Reproduce the worker's checks; do not accept a summary of what the worker says happened.
- If a required check cannot be run, record the blocked verification and state the assumption made.
- For incremental rounds, verify only the delivered increment; deferred criteria are non-blocking notes.
- For research, also read `skill://research-evidence`.
- For software, use the project's own build/test/lint commands; do not invent a test suite.
- For automation and operations, prefer a dry run and a rollback path over a broad live change.
- For data, report exact counts, checksums, and sample sizes; do not summarize without the artifact.

## Round-file accounting

The round file is the unit's record of what it verified, and the orchestrator, the sink and the improver all read it as claims to be checked. Two counts must close before you yield:

- **One disposition row per advisor note.** Count the `[advisor]` notes in your session and the rows in `## Advisor feedback`; they must be equal. Five inventory and writer units once recorded 42 rows for 51 notes (one unit 5 rows for 10 blockers), so a reader cannot tell an absorbed note from a lost one. With no note delivered yet, state `0` and give the section **no table body at all**: a `| — | none received | — |` placeholder is itself a row, so rows ≠ notes — two units in one run, an implement and a sink, each shipped exactly that placeholder and each paid a repair turn for it. Notes arrive at or after a yield, so write the count true at the moment you write, then add one row per later note; a re-flag of a row you already fixed gets a disposition row quoting the fix, not a rewrite of the evidence.
- **Every "criterion satisfied" names the check that measured it.** A completion claim with no command and no count is a narration, not a verification. A writer once asserted AC1 satisfied with 136 of 186 matrix rows empty, and nothing in its 200-call transcript could have produced the claim (`skill://research-evidence` §3 step 14 turns a per-row criterion into the checker that would have failed).
- **A number in the round file is a pasted output line, not a retyped value.** Quote the output of a command that ran after your last edit; a count computed earlier or restated from memory is stale the moment a file changes. Three units were once flagged for exactly this — a round file saying `774 lines` for a 780-line file, one saying `47 saved artifacts` and `checks=49` where the re-runs printed 87 files and 52 checks, and recorded pack sizes of 725 lines/117 fingerprints against 735/118 — and each repair cost an edit round on the round file alone.
- **A disposition written as a universal needs a count from the rest of the session.** "No further guard blocks occurred" was followed by two more; "no `/`-leading shell args" by two more. Either state the count you observed over the remaining turns, or narrow the sentence to the thing you actually verified.

## Deliverable review checklist

1. Does the deliverable match the declared `work_type` and `deliverable`?
2. Does every acceptance criterion have evidence appropriate to that type?
3. Are the evidence artifacts saved and cited?
4. Did the worker run the checks it claims, and can you reproduce them?
5. Are failure, rollback, and boundary cases covered where the work type requires them?
6. Is anything code-centric being forced onto a non-code deliverable?
7. Are deferred increment criteria explicitly recorded rather than silently dropped?
